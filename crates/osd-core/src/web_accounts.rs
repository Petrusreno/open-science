// Accounts for the web client, and the layouts that follow them.
//
// The gateway token is one secret for the whole machine, and a browser keeps
// it per address: the same browser at 127.0.0.1 and at the LAN IP — or at the
// LAN IP after the router hands out a new one — is two strangers, each with its
// own token and its own Screens. An account is a name and a password the
// desktop user hands out; signing in anywhere gets a session, and the account's
// layout is kept HERE, on the desktop, so it is the same wherever it signs in.
//
// The token still works (CLI, ACP, a link with #token): accounts are a second
// way in with the same rights, not a replacement.
//
// One file under the runtime root holds the accounts (argon2 hashes) and the
// live sessions (sha-256 of each session token — the token itself is never
// stored). The desktop app and `osd server` share the runtime root, so the file
// is re-read whenever it changes on disk rather than trusted from memory.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::env::Env;
use crate::runtime::{random_hex, runtime_root, tighten_private};

/// How long a sign-in lasts. Long, because the person is the desktop's own
/// user on their own devices; a password change or a deleted account ends it
/// at once.
pub const SESSION_DAYS: u64 = 30;
pub const MIN_PASSWORD: usize = 8;
const MAX_PASSWORD: usize = 256;
const MAX_NAME: usize = 32;
/// A layout is a few KB; this only stops a client filling the disk.
pub const MAX_LAYOUT: usize = 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
struct Account {
    name: String,
    /// argon2id PHC string (salt included).
    hash: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Session {
    /// sha-256 hex of the session token.
    hash: String,
    user: String,
    /// Unix seconds.
    expires: u64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Store {
    users: Vec<Account>,
    sessions: Vec<Session>,
}

fn store_file(env: &Env) -> Result<PathBuf, String> {
    Ok(runtime_root(env)?.join("web-accounts.json"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The parsed file, re-read only when its modification time moves. Every
/// gateway request with a session looks here, so it must not parse JSON each
/// time; and another process may have written it, so it must not trust memory.
static CACHE: Mutex<Option<(PathBuf, Option<SystemTime>, Store)>> = Mutex::new(None);

fn load(env: &Env) -> Result<Store, String> {
    let file = store_file(env)?;
    let mtime = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
    let mut cache = CACHE.lock().unwrap();
    if let Some((path, at, store)) = cache.as_ref() {
        if *path == file && *at == mtime {
            return Ok(store.clone());
        }
    }
    let store = match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("web-accounts.json: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Store::default(),
        Err(e) => return Err(e.to_string()),
    };
    *cache = Some((file, mtime, store.clone()));
    Ok(store)
}

fn save(env: &Env, mut store: Store) -> Result<(), String> {
    let t = now();
    store.sessions.retain(|s| s.expires > t);
    let file = store_file(env)?;
    write_private(&file, serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?.as_bytes())?;
    *CACHE.lock().unwrap() = None;
    Ok(())
}

/// Write via a temp file and rename, owner-only: half a file would lock
/// everyone out, and the hashes are nobody else's business.
fn write_private(file: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension(format!("tmp-{}", random_hex(4)));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    tighten_private(&tmp);
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

/// A name someone types on a phone: letters (any script), digits, `-_.`.
pub fn valid_name(name: &str) -> bool {
    let n = name.chars().count();
    (1..=MAX_NAME).contains(&n) && name.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c))
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn hash_password(password: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    let salt = SaltString::encode_b64(&salt).map_err(|e| e.to_string())?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn verify(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// Account names, in the order they were created.
pub fn list(env: &Env) -> Result<Vec<String>, String> {
    Ok(load(env)?.users.into_iter().map(|u| u.name).collect())
}

/// Create an account, or give an existing one a new password. A new password
/// signs the account out everywhere: that is usually why it is being changed.
pub fn set_password(env: &Env, name: &str, password: &str) -> Result<(), String> {
    let name = name.trim();
    if !valid_name(name) {
        return Err(format!("a name is 1–{MAX_NAME} letters, digits, - _ or ."));
    }
    let len = password.chars().count();
    if len < MIN_PASSWORD {
        return Err(format!("a password needs at least {MIN_PASSWORD} characters"));
    }
    if len > MAX_PASSWORD {
        return Err("that password is too long".into());
    }
    let hash = hash_password(password)?;
    let mut store = load(env)?;
    match store.users.iter_mut().find(|u| same_name(&u.name, name)) {
        Some(user) => {
            user.hash = hash;
            let canonical = user.name.clone();
            store.sessions.retain(|s| s.user != canonical);
        }
        None => store.users.push(Account { name: name.to_string(), hash }),
    }
    save(env, store)
}

/// Remove an account, its sessions and its layout.
pub fn delete(env: &Env, name: &str) -> Result<(), String> {
    let mut store = load(env)?;
    let Some(i) = store.users.iter().position(|u| same_name(&u.name, name)) else {
        return Ok(());
    };
    let user = store.users.remove(i).name;
    store.sessions.retain(|s| s.user != user);
    save(env, store)?;
    if let Ok(file) = layout_file(env, &user) {
        let _ = std::fs::remove_file(file);
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub enum LoginError {
    /// Wrong name or wrong password — deliberately not told apart.
    Invalid,
    /// Too many wrong tries; wait this long.
    Locked(Duration),
    Other(String),
}

/// Failed sign-ins per lower-cased name: (consecutive failures, locked until).
/// In memory: a restart forgives, which costs an attacker a restart of the
/// desktop app they do not control.
static FAILURES: Mutex<Option<HashMap<String, (u32, Instant)>>> = Mutex::new(None);
const FREE_TRIES: u32 = 5;

fn lockout(failures: u32) -> Duration {
    // 1 min after the 5th wrong try, doubling, at most 15 min.
    let steps = failures.saturating_sub(FREE_TRIES).min(4);
    Duration::from_secs((60u64 << steps).min(15 * 60))
}

/// Check a name and password; on success, a new session token (shown once,
/// never stored) and its expiry in Unix seconds.
pub fn login(env: &Env, name: &str, password: &str) -> Result<(String, u64, String), LoginError> {
    let key = name.trim().to_lowercase();
    {
        let mut guard = FAILURES.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some((_, until)) = map.get(&key) {
            let left = until.saturating_duration_since(Instant::now());
            if !left.is_zero() {
                return Err(LoginError::Locked(left));
            }
        }
    }
    let store = load(env).map_err(LoginError::Other)?;
    let account = store.users.iter().find(|u| same_name(&u.name, name.trim()));
    // Verify against something even for an unknown name, so the time taken
    // does not say which names exist.
    let ok = match account {
        Some(a) => verify(password, &a.hash),
        None => {
            let _ = verify(password, dummy_hash());
            false
        }
    };
    let mut guard = FAILURES.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    if !ok {
        let entry = map.entry(key).or_insert((0, Instant::now()));
        entry.0 += 1;
        if entry.0 >= FREE_TRIES {
            entry.1 = Instant::now() + lockout(entry.0);
        }
        return Err(LoginError::Invalid);
    }
    map.remove(&key);
    drop(guard);
    let user = account.expect("verified").name.clone();
    let token = random_hex(32);
    let expires = now() + SESSION_DAYS * 24 * 3600;
    let mut store = store;
    store.sessions.push(Session { hash: sha256_hex(&token), user: user.clone(), expires });
    save(env, store).map_err(LoginError::Other)?;
    Ok((token, expires, user))
}

/// An argon2 hash of a random password nobody knows, for the unknown-name path.
fn dummy_hash() -> &'static str {
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HASH.get_or_init(|| hash_password(&random_hex(16)).unwrap_or_default())
}

/// The account a session token belongs to, if it is live.
pub fn session_user(env: &Env, token: &str) -> Option<String> {
    if token.len() != 64 {
        return None; // not one of ours; skip the file entirely
    }
    let hash = sha256_hex(token);
    let t = now();
    load(env)
        .ok()?
        .sessions
        .into_iter()
        .find(|s| s.hash == hash && s.expires > t)
        .map(|s| s.user)
}

pub fn logout(env: &Env, token: &str) -> Result<(), String> {
    let hash = sha256_hex(token);
    let mut store = load(env)?;
    store.sessions.retain(|s| s.hash != hash);
    save(env, store)
}

// ---- layouts ------------------------------------------------------------------

fn layout_file(env: &Env, user: &str) -> Result<PathBuf, String> {
    // Hashed: a name may hold any letter, a file name may not.
    Ok(runtime_root(env)?.join("web-layouts").join(format!("{}.json", &sha256_hex(&user.to_lowercase())[..32])))
}

fn desktop_layout_file(env: &Env) -> Result<PathBuf, String> {
    Ok(runtime_root(env)?.join("desktop-layout.json"))
}

fn check_layout(json: &str) -> Result<(), String> {
    if json.len() > MAX_LAYOUT {
        return Err("layout too large".into());
    }
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .filter(|v| v.is_object())
        .map(|_| ())
        .ok_or_else(|| "layout is not a JSON object".into())
}

/// An account's Screens, as its client last saved them.
pub fn read_layout(env: &Env, user: &str) -> Option<String> {
    std::fs::read_to_string(layout_file(env, user).ok()?).ok()
}

pub fn write_layout(env: &Env, user: &str, json: &str) -> Result<(), String> {
    check_layout(json)?;
    write_private(&layout_file(env, user)?, json.as_bytes())
}

/// The revision of the desktop layout: every write raises it, so a client that
/// mirrors the layout asks "anything newer than N?" instead of re-reading it.
/// Seeded from the clock, so a restarted app never reissues a number a client
/// still holds from before.
/// Keyed by the layout file: one per runtime, and so one per gateway even when
/// a process runs several (the tests do).
static DESKTOP_REV: Mutex<Option<std::collections::HashMap<PathBuf, u64>>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The desktop window's Screens — shared with every web client signed in with
/// the token, which mirrors them — and their revision.
pub fn read_desktop_layout(env: &Env) -> Option<(u64, String)> {
    let file = desktop_layout_file(env).ok()?;
    let json = std::fs::read_to_string(&file).ok()?;
    let mut revs = DESKTOP_REV.lock().unwrap();
    let rev = revs.get_or_insert_with(Default::default).entry(file).or_insert_with(now_ms);
    Some((*rev, json))
}

/// Store a new desktop layout (from the window, or from a token client) and
/// return its revision.
pub fn write_desktop_layout(env: &Env, json: &str) -> Result<u64, String> {
    check_layout(json)?;
    let file = desktop_layout_file(env)?;
    let mut revs = DESKTOP_REV.lock().unwrap();
    write_private(&file, json.as_bytes())?;
    let rev = revs.get_or_insert_with(Default::default).entry(file).or_insert(0);
    *rev = (*rev + 1).max(now_ms());
    Ok(*rev)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str) -> (Env, PathBuf) {
        let dir = std::env::temp_dir().join(format!("webacct-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Env::new(dir.clone(), dir.join("res"), None, "0.0.0".into()), dir)
    }

    #[test]
    fn the_dummy_hash_parses() {
        assert!(PasswordHash::new(dummy_hash()).is_ok());
    }

    #[test]
    fn sign_in_gets_a_session_and_a_new_password_ends_it() {
        let (env, dir) = env("session");
        assert!(set_password(&env, "alice", "short").is_err());
        assert!(set_password(&env, "a b", "long enough").is_err());
        set_password(&env, "Alice", "correct horse").unwrap();
        assert_eq!(list(&env).unwrap(), ["Alice"]);

        assert_eq!(login(&env, "alice", "wrong pass").unwrap_err(), LoginError::Invalid);
        assert_eq!(login(&env, "nobody", "whatever1").unwrap_err(), LoginError::Invalid);
        let (token, expires, user) = login(&env, "alice", "correct horse").unwrap();
        assert_eq!(user, "Alice", "the account's own spelling");
        assert!(expires > now());
        assert_eq!(session_user(&env, &token).as_deref(), Some("Alice"));
        let stored = std::fs::read_to_string(store_file(&env).unwrap()).unwrap();
        assert!(!stored.contains(&token), "the token itself is never written");
        assert!(!stored.contains("correct horse"));

        set_password(&env, "ALICE", "battery staple").unwrap();
        assert_eq!(list(&env).unwrap(), ["Alice"], "the same account, not a second one");
        assert_eq!(session_user(&env, &token), None, "a new password signs out everywhere");

        let (token, _, _) = login(&env, "alice", "battery staple").unwrap();
        logout(&env, &token).unwrap();
        assert_eq!(session_user(&env, &token), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn repeated_wrong_passwords_lock_the_name() {
        let (env, dir) = env("lock");
        set_password(&env, "bob", "the right one").unwrap();
        for _ in 0..FREE_TRIES {
            assert_eq!(login(&env, "bob", "nope nope").unwrap_err(), LoginError::Invalid);
        }
        assert!(matches!(login(&env, "bob", "the right one"), Err(LoginError::Locked(_))));
        assert_eq!(lockout(FREE_TRIES), Duration::from_secs(60));
        assert_eq!(lockout(FREE_TRIES + 10), Duration::from_secs(15 * 60), "capped");
        FAILURES.lock().unwrap().as_mut().unwrap().remove("bob");
        assert!(login(&env, "bob", "the right one").is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_deleted_account_takes_its_sessions_and_layout() {
        let (env, dir) = env("delete");
        set_password(&env, "carol", "a password").unwrap();
        let (token, _, _) = login(&env, "carol", "a password").unwrap();
        write_layout(&env, "carol", r#"{"groups":[]}"#).unwrap();
        assert!(write_layout(&env, "carol", "[1]").is_err(), "an object or nothing");
        assert_eq!(read_layout(&env, "Carol").as_deref(), Some(r#"{"groups":[]}"#));
        delete(&env, "carol").unwrap();
        assert!(list(&env).unwrap().is_empty());
        assert_eq!(session_user(&env, &token), None);
        assert_eq!(read_layout(&env, "carol"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
