// What a terminal is doing right now: which folder its shell is in, and which
// coding agent — Claude Code, Codex or pi — is running in it, with the session
// id that agent is writing to.
//
// The layout records both on the terminal's pane so a relaunch reopens the
// shell where it was and resumes the agent (`claude --resume <id>` /
// `codex resume <id>`), the way Orca restores an agent pane.
//
// How each is found:
// - cwd: the SHELL's own working directory — `/proc/<pid>/cwd` on Linux,
//   `proc_pidinfo(PROC_PIDVNODEPATHINFO)` on macOS (no subprocess; Orca shells
//   out to lsof for this).
// - agent: the terminal's foreground process group (tcgetpgrp on the pty) and
//   its direct children, since `claude`/`codex` may be started through a thin
//   wrapper.
//   - Claude Code writes `~/.claude/sessions/<pid>.json` for every running
//     process — `{ "pid", "sessionId", "cwd", … }` — so the pid IS the key.
//   - Codex keeps its session's rollout file open while it runs
//     (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line is
//     `session_meta` with the id), so the file it holds names the session.
//     The newest one wins: the desktop Codex app holds several at once.
//   - pi runs under node (its process name is `node`), so it is known by its
//     arguments. It neither records its pid nor keeps its session open (each
//     entry is an append), so its session is the newest file in its folder's
//     session directory written since the process started
//     (`<agent dir>/sessions/--<cwd with / as ->--/<time>_<id>.jsonl`, first
//     line `{"type":"session","id":…}`). None before its first message: pi
//     writes nothing until then, and there is nothing to resume.
//
// Windows has neither a foreground process group nor a cheap cwd query, so
// nothing is reported there and terminals restore as before.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbe {
    /// "claude" | "codex" | "pi"
    pub kind: &'static str,
    pub session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProbe {
    pub cwd: Option<String>,
    pub agent: Option<AgentProbe>,
}

/// `sessionId` from a `~/.claude/sessions/<pid>.json` record.
fn parse_claude_session(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let id = value.get("sessionId")?.as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

/// The session id from a Codex rollout's first line (`session_meta`).
fn parse_codex_rollout_head(first_line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(first_line).ok()?;
    if value.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = value.get("payload")?;
    let id = payload
        .get("id")
        .or_else(|| payload.get("session_id"))?
        .as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

fn is_codex_rollout(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.starts_with("rollout-")
        && name.ends_with(".jsonl")
        && path.components().any(|c| c.as_os_str() == "sessions")
}

/// Of the rollout files a Codex process holds, the one it wrote last.
fn newest_rollout(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths
        .into_iter()
        .filter(|p| is_codex_rollout(p))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, p)| p)
}

fn read_first_line(path: &Path) -> Option<String> {
    use std::io::{BufRead, Read};
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    // The meta line carries the model's base instructions and runs to tens of
    // kilobytes; cap the read so a malformed file cannot make this unbounded.
    std::io::BufReader::new(file.take(1 << 20))
        .read_line(&mut line)
        .ok()?;
    Some(line)
}

fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    home_dir().map(|h| h.join(".claude"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn claude_session_of(pid: u32) -> Option<String> {
    let record = claude_config_dir()?
        .join("sessions")
        .join(format!("{pid}.json"));
    parse_claude_session(&std::fs::read_to_string(record).ok()?)
}

/// Codex session ids by pid. A process's session never changes while it runs,
/// and on macOS finding it costs an `lsof`, so it is looked up once per pid.
fn codex_cache() -> &'static std::sync::Mutex<HashMap<u32, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<u32, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn codex_session_of(pid: u32) -> Option<String> {
    if let Some(id) = codex_cache().lock().ok()?.get(&pid) {
        return Some(id.clone());
    }
    let rollout = newest_rollout(platform::open_files(pid))?;
    let id = parse_codex_rollout_head(&read_first_line(&rollout)?)?;
    if let Ok(mut cache) = codex_cache().lock() {
        // Bounded: pids churn over a long session.
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(pid, id.clone());
    }
    Some(id)
}

/// Whether a process name is Codex's. Measured: the Homebrew cask runs a
/// binary named `codex-aarch64-apple-darwin` behind its `codex` symlink, and
/// macOS reports the resolved name; npm's package and the desktop app run one
/// named `codex`; Linux truncates names to 15 bytes (`codex-x86_64-un`).
fn is_codex_name(name: &str) -> bool {
    name == "codex" || name.starts_with("codex-")
}

/// The session id from a pi session file's first line.
fn parse_pi_session_head(first_line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(first_line).ok()?;
    if value.get("type")?.as_str()? != "session" {
        return None;
    }
    let id = value.get("id")?.as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

/// Whether a process's arguments are pi's interactive CLI: `node …/bin/pi` on
/// macOS, or `pi` itself where the process title rewrites argv (Linux). The
/// RPC mode (`--mode rpc`) is pi run by another program, never a terminal's.
fn is_pi_args(args: &[String]) -> bool {
    let named_pi = args.iter().take(2).any(|a| {
        Path::new(a).file_name().is_some_and(|n| n == "pi") || a.contains("pi-coding-agent/dist/cli.js")
    });
    named_pi && !args.iter().any(|a| a == "--mode")
}

/// pi's session folder for a working directory, as pi names it.
fn pi_session_dir(agent_dir: &Path, cwd: &str) -> PathBuf {
    let trimmed = cwd.strip_prefix('/').or_else(|| cwd.strip_prefix('\\')).unwrap_or(cwd);
    let safe: String = trimmed.chars().map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c }).collect();
    agent_dir.join("sessions").join(format!("--{safe}--"))
}

fn pi_agent_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        return Some(PathBuf::from(dir));
    }
    home_dir().map(|h| h.join(".pi").join("agent"))
}

/// The session file in `dir` written last at or after `since`, if any.
fn newest_pi_session(dir: &Path, since: std::time::SystemTime) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .filter(|(modified, _)| *modified >= since)
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, p)| p)
}

fn pi_session_of(pid: u32) -> Option<String> {
    if !is_pi_args(&platform::process_args(pid)) {
        return None;
    }
    let dir = pi_session_dir(&pi_agent_dir()?, &platform::process_cwd(pid)?);
    let started = platform::process_start(pid)?;
    parse_pi_session_head(&read_first_line(&newest_pi_session(&dir, started)?)?)
}

fn agent_of(pid: u32) -> Option<AgentProbe> {
    if let Some(session_id) = claude_session_of(pid) {
        return Some(AgentProbe {
            kind: "claude",
            session_id,
        });
    }
    if platform::process_name(pid).is_some_and(|name| is_codex_name(&name)) {
        return codex_session_of(pid).map(|session_id| AgentProbe {
            kind: "codex",
            session_id,
        });
    }
    if let Some(session_id) = pi_session_of(pid) {
        return Some(AgentProbe { kind: "pi", session_id });
    }
    None
}

/// Probe one terminal: `shell` is the pid the pty spawned, `foreground` the
/// pty's foreground process group leader (None where there is no such thing).
pub fn probe(shell: Option<u32>, foreground: Option<u32>) -> TerminalProbe {
    let cwd = shell.and_then(platform::process_cwd);
    let agent = foreground.filter(|fg| Some(*fg) != shell).and_then(|fg| {
        std::iter::once(fg)
            .chain(platform::children(fg))
            .find_map(agent_of)
    });
    TerminalProbe { cwd, agent }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::PathBuf;

    pub fn process_cwd(pid: u32) -> Option<String> {
        Some(
            std::fs::read_link(format!("/proc/{pid}/cwd"))
                .ok()?
                .to_string_lossy()
                .into_owned(),
        )
    }

    pub fn process_name(pid: u32) -> Option<String> {
        Some(
            std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .ok()?
                .trim()
                .to_string(),
        )
    }

    pub fn children(pid: u32) -> Vec<u32> {
        std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
            .map(|s| {
                s.split_whitespace()
                    .filter_map(|p| p.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn process_args(pid: u32) -> Vec<String> {
        std::fs::read(format!("/proc/{pid}/cmdline"))
            .map(|raw| {
                raw.split(|b| *b == 0)
                    .filter(|a| !a.is_empty())
                    .map(|a| String::from_utf8_lossy(a).into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// When the process started: its `/proc` entry is made then.
    pub fn process_start(pid: u32) -> Option<std::time::SystemTime> {
        std::fs::metadata(format!("/proc/{pid}")).ok()?.modified().ok()
    }

    pub fn open_files(pid: u32) -> Vec<PathBuf> {
        std::fs::read_dir(format!("/proc/{pid}/fd"))
            .map(|dir| {
                dir.flatten()
                    .filter_map(|e| std::fs::read_link(e.path()).ok())
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CStr;
    use std::path::PathBuf;

    pub fn process_cwd(pid: u32) -> Option<String> {
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
        // SAFETY: `info` is a correctly sized, writable proc_vnodepathinfo.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDVNODEPATHINFO,
                0,
                (&mut info as *mut libc::proc_vnodepathinfo).cast(),
                size,
            )
        };
        if written != size {
            return None;
        }
        // SAFETY: the kernel NUL-terminates vip_path within its fixed buffer.
        let path = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
        let path = path.to_string_lossy().into_owned();
        (!path.is_empty()).then_some(path)
    }

    pub fn process_name(pid: u32) -> Option<String> {
        let mut buf = [0u8; 256];
        // SAFETY: `buf` is writable for its full length.
        let n = unsafe {
            libc::proc_name(
                pid as libc::c_int,
                buf.as_mut_ptr().cast(),
                buf.len() as u32,
            )
        };
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
    }

    pub fn children(pid: u32) -> Vec<u32> {
        let mut pids = [0 as libc::pid_t; 64];
        let bytes = std::mem::size_of_val(&pids) as libc::c_int;
        // SAFETY: `pids` is writable for `bytes` bytes.
        let n = unsafe {
            libc::proc_listchildpids(pid as libc::pid_t, pids.as_mut_ptr().cast(), bytes)
        };
        if n <= 0 {
            return Vec::new();
        }
        // Documented loosely: treat it as a count, or as bytes if it is larger
        // than the buffer could hold as a count.
        let n = n as usize;
        let count = if n > pids.len() {
            n / std::mem::size_of::<libc::pid_t>()
        } else {
            n
        };
        let count = count.min(pids.len());
        pids[..count]
            .iter()
            .filter(|p| **p > 0)
            .map(|p| *p as u32)
            .collect()
    }

    /// argv, from `KERN_PROCARGS2`: argc, the executable path, padding, then
    /// the arguments, each NUL-terminated.
    pub fn process_args(pid: u32) -> Vec<String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        let mut size: libc::size_t = 0;
        // SAFETY: a null buffer asks only for the size.
        let sized = unsafe {
            libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0)
        };
        if sized != 0 || size < 4 {
            return Vec::new();
        }
        let mut buf = vec![0u8; size];
        // SAFETY: `buf` is writable for `size` bytes, which sysctl updates.
        let read = unsafe {
            libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0)
        };
        if read != 0 || size < 4 {
            return Vec::new();
        }
        parse_procargs(&buf[..size])
    }

    pub(super) fn parse_procargs(buf: &[u8]) -> Vec<String> {
        let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]).max(0) as usize;
        let rest = &buf[4..];
        // Skip the executable path and the NULs after it.
        let Some(end) = rest.iter().position(|b| *b == 0) else {
            return Vec::new();
        };
        let start = rest[end..].iter().position(|b| *b != 0).map(|i| end + i).unwrap_or(rest.len());
        rest[start..]
            .split(|b| *b == 0)
            .take(argc)
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect()
    }

    pub fn process_start(pid: u32) -> Option<std::time::SystemTime> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: `info` is a correctly sized, writable proc_bsdinfo.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if written != size {
            return None;
        }
        Some(
            std::time::UNIX_EPOCH
                + std::time::Duration::from_secs(info.pbi_start_tvsec)
                + std::time::Duration::from_micros(info.pbi_start_tvusec),
        )
    }

    /// Files `pid` holds open. `lsof`, as Orca uses: the kernel call for an fd's
    /// path needs a struct libc does not bind. Called once per Codex process
    /// (the result is cached upstream).
    pub fn open_files(pid: u32) -> Vec<PathBuf> {
        let Ok(out) = crate::runtime::quiet_command("lsof")
            .args(["-a", "-p", &pid.to_string(), "-Fn"])
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.strip_prefix('n'))
            .map(PathBuf::from)
            .collect()
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use std::path::PathBuf;

    pub fn process_cwd(_pid: u32) -> Option<String> {
        None
    }

    pub fn process_name(_pid: u32) -> Option<String> {
        None
    }

    pub fn children(_pid: u32) -> Vec<u32> {
        Vec::new()
    }

    pub fn process_args(_pid: u32) -> Vec<String> {
        Vec::new()
    }

    pub fn process_start(_pid: u32) -> Option<std::time::SystemTime> {
        None
    }

    pub fn open_files(_pid: u32) -> Vec<PathBuf> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_session_from_a_pi_session_file() {
        let head = r#"{"type":"session","version":3,"id":"01a01595-5d28-7ba3-98c7-323282fa41ad","timestamp":"2026-08-18T15:55:05.384Z","cwd":"/Users/asq"}"#;
        assert_eq!(
            parse_pi_session_head(head).as_deref(),
            Some("01a01595-5d28-7ba3-98c7-323282fa41ad")
        );
        assert_eq!(parse_pi_session_head(r#"{"type":"model_change","id":"e19e10f2"}"#), None);
    }

    #[test]
    fn knows_pi_by_its_arguments_and_skips_its_rpc_mode() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_pi_args(&args(&["node", "/Users/me/.nvm/versions/node/v24/bin/pi"])));
        assert!(is_pi_args(&args(&["pi", "--session", "01a0"])));
        assert!(is_pi_args(&args(&["node", "/x/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"])));
        assert!(!is_pi_args(&args(&["node", "/x/bin/pi", "--mode", "rpc"])));
        assert!(!is_pi_args(&args(&["node", "/x/bin/pip"])));
        assert!(!is_pi_args(&args(&["node", "server.js", "pi"])));
    }

    #[test]
    fn names_the_session_folder_the_way_pi_does() {
        // Measured: pi files sessions for /Users/asq under `--Users-asq--`.
        assert_eq!(
            pi_session_dir(Path::new("/h/.pi/agent"), "/Users/asq"),
            PathBuf::from("/h/.pi/agent/sessions/--Users-asq--")
        );
        assert_eq!(
            pi_session_dir(Path::new("/a"), "/private/tmp/-x/y"),
            PathBuf::from("/a/sessions/--private-tmp--x-y--")
        );
    }

    #[test]
    fn takes_the_newest_pi_session_written_since_the_process_started() {
        let dir = std::env::temp_dir().join(format!("osd-pi-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("2026-01-01T00-00-00-000Z_old.jsonl");
        std::fs::write(&old, "{}\n").unwrap();
        let started = std::time::SystemTime::now() + std::time::Duration::from_millis(5);
        std::thread::sleep(std::time::Duration::from_millis(20));
        // Before the process wrote anything, the older session must not answer.
        assert_eq!(newest_pi_session(&dir, started), None);
        let new = dir.join("2026-01-02T00-00-00-000Z_new.jsonl");
        std::fs::write(&new, "{}\n").unwrap();
        assert_eq!(newest_pi_session(&dir, started), Some(new));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn reads_this_process_arguments() {
        let args = platform::process_args(std::process::id());
        // The test binary itself is argv[0].
        let exe = std::env::current_exe().unwrap();
        let name = exe.file_name().unwrap().to_string_lossy();
        assert!(args.first().is_some_and(|a| a.ends_with(name.as_ref())), "{args:?}");
        assert!(platform::process_start(std::process::id()).is_some());
    }

    /// Against a live process: `PI_PID=<pid> cargo test … -- --ignored live_pi`.
    #[test]
    #[ignore]
    fn live_pi() {
        let pid: u32 = std::env::var("PI_PID").unwrap().parse().unwrap();
        eprintln!("args {:?}", platform::process_args(pid));
        eprintln!("probe {:?}", agent_of(pid));
    }

    #[test]
    fn reads_the_session_from_a_claude_process_record() {
        // The shape Claude Code 2.1 writes to ~/.claude/sessions/<pid>.json.
        let record = r#"{"pid":26378,"sessionId":"538c3949-2f92-4cea-8377-c6fb425b2fd7","cwd":"/w/p","kind":"interactive"}"#;
        assert_eq!(
            parse_claude_session(record).as_deref(),
            Some("538c3949-2f92-4cea-8377-c6fb425b2fd7")
        );
        assert_eq!(parse_claude_session(r#"{"pid":1}"#), None);
        assert_eq!(parse_claude_session(r#"{"sessionId":""}"#), None);
        assert_eq!(parse_claude_session("not json"), None);
    }

    #[test]
    fn reads_the_session_from_a_codex_rollout_head() {
        let head = r#"{"timestamp":"2026-09-25T15:47:47.739Z","type":"session_meta","payload":{"session_id":"01a0cd91-adc8-7fe2-a36f-17e2059d36e3","id":"01a0cd91-adc8-7fe2-a36f-17e2059d36e3","cwd":"/w/p"}}"#;
        assert_eq!(
            parse_codex_rollout_head(head).as_deref(),
            Some("01a0cd91-adc8-7fe2-a36f-17e2059d36e3")
        );
        // Only the meta line names the session.
        assert_eq!(
            parse_codex_rollout_head(r#"{"type":"response_item","payload":{"id":"x"}}"#),
            None
        );
        assert_eq!(parse_codex_rollout_head(""), None);
    }

    #[test]
    fn of_the_files_codex_holds_the_newest_rollout_names_the_session() {
        let dir = std::env::temp_dir().join(format!("osd-probe-{}", std::process::id()));
        let day = dir.join("sessions/2026/09/25");
        std::fs::create_dir_all(&day).unwrap();
        let older = day.join("rollout-2026-09-25T01-00-00-aaa.jsonl");
        let newer = day.join("rollout-2026-09-25T02-00-00-bbb.jsonl");
        let log = day.join("codex-tui.log");
        std::fs::write(&older, "x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&newer, "x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&log, "x").unwrap(); // newest, but not a rollout
        assert_eq!(
            newest_rollout([older.clone(), log, newer.clone()]),
            Some(newer)
        );
        assert_eq!(
            newest_rollout([dir.join("elsewhere/rollout-x.jsonl")]),
            None
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Identify the agent in a REAL running process: `OSD_PROBE_PID=<pid>
    /// cargo test -p ai4s-workbench live_agent -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_agent_of_a_running_process() {
        let pid: u32 = std::env::var("OSD_PROBE_PID")
            .expect("OSD_PROBE_PID")
            .parse()
            .unwrap();
        eprintln!(
            "name={:?} cwd={:?} children={:?} agent={:?}",
            platform::process_name(pid),
            platform::process_cwd(pid),
            platform::children(pid),
            agent_of(pid)
        );
        assert!(agent_of(pid).is_some());
    }

    #[test]
    fn knows_codex_by_every_name_it_runs_under() {
        assert!(is_codex_name("codex"));
        assert!(is_codex_name("codex-aarch64-apple-darwin"));
        assert!(is_codex_name("codex-x86_64-un")); // Linux, truncated
        assert!(!is_codex_name("codexify"));
        assert!(!is_codex_name("node"));
    }

    #[test]
    fn a_shell_at_its_prompt_has_no_agent() {
        // Foreground == the shell itself: nothing is running in it.
        let me = std::process::id();
        let probe = probe(Some(me), Some(me));
        assert_eq!(probe.agent, None);
    }

    /// End to end on a REAL pty: an interactive shell, `cd`, then a Claude and
    /// a Codex stand-in in the foreground, then back to the prompt. The
    /// stand-ins are real processes found the real way — by the pty's
    /// foreground process group — with a Claude process record (in a private
    /// CLAUDE_CONFIG_DIR) and a Codex binary holding a rollout file open.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_real_pty_reports_its_folder_and_the_agent_in_front() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};

        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("osd-pty-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("sub");
        let claude_dir = root.join("claude");
        let rollouts = root.join("codex/sessions/2026/01/01");
        for d in [&sub, &claude_dir.join("sessions"), &rollouts] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);
        let rollout = rollouts.join("rollout-2026-01-01T00-00-00-e2e.jsonl");
        std::fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-e2e-id\",\"cwd\":\"/x\"}}\n",
        )
        .unwrap();
        // A Codex stand-in: this test binary, copied under a Codex name, re-run
        // as `hold_a_file_open` so it holds the rollout open the way Codex does.
        // A copy, because macOS reports the RESOLVED binary name (a symlink
        // would read as the original) and kills a copied system binary.
        let codex = root.join("bin/codex-e2e");
        std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
        std::fs::copy(std::env::current_exe().unwrap(), &codex).unwrap();

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-i"); // interactive: job control, so a program gets the foreground
        cmd.cwd(&root);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut writer = pair.master.take_writer().unwrap();
        let shell = child.process_id();
        let look = || probe(shell, pair.master.process_group_leader().map(|p| p as u32));
        let until = |what: &str, ok: &dyn Fn(&TerminalProbe) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let p = look();
                if ok(&p) {
                    return p;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {what}; last probe: {p:?}"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        };
        let at = |dir: &Path| {
            let dir = dir.to_string_lossy().into_owned();
            move |p: &TerminalProbe| p.cwd.as_deref() == Some(dir.as_str())
        };

        // 1. At the prompt: its folder, nothing running.
        let p = until("the shell's folder", &at(&root));
        assert_eq!(p.agent, None);

        // 2. The folder follows the shell.
        writer.write_all(b"cd sub\n").unwrap();
        until("cd", &at(&sub));

        // 3. Claude in front: its pid's process record names the session.
        writer.write_all(b"sleep 60\n").unwrap();
        let fg = {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let fg = pair.master.process_group_leader().map(|p| p as u32);
                if let Some(fg) = fg.filter(|fg| Some(*fg) != shell) {
                    break fg;
                }
                assert!(Instant::now() < deadline, "sleep never took the foreground");
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        std::fs::write(
            claude_dir.join("sessions").join(format!("{fg}.json")),
            format!("{{\"pid\":{fg},\"sessionId\":\"claude-e2e-id\"}}"),
        )
        .unwrap();
        let p = until("claude", &|p| p.agent.is_some());
        assert_eq!(
            p.agent,
            Some(AgentProbe {
                kind: "claude",
                session_id: "claude-e2e-id".into()
            })
        );
        assert_eq!(
            p.cwd.as_deref(),
            Some(sub.to_string_lossy().as_ref()),
            "the SHELL's folder, not the agent's"
        );

        // 4. Back at the prompt: no agent.
        writer.write_all(b"\x03").unwrap();
        until("the prompt again", &|p| p.agent.is_none());

        // 5. Codex in front: the rollout it holds names the session.
        writer
            .write_all(
                format!(
                    "OSD_HOLD_FILE='{}' '{}' --exact terminal_probe::tests::hold_a_file_open --ignored\n",
                    rollout.display(),
                    codex.display()
                )
                .as_bytes(),
            )
            .unwrap();
        let p = until("codex", &|p| p.agent.is_some());
        assert_eq!(
            p.agent,
            Some(AgentProbe {
                kind: "codex",
                session_id: "codex-e2e-id".into()
            })
        );

        writer.write_all(b"\x03").unwrap();
        until("the prompt after codex", &|p| p.agent.is_none());
        let _ = child.kill();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Not a test: the Codex stand-in above runs this to hold a file open.
    #[test]
    #[ignore]
    fn hold_a_file_open() {
        if let Some(path) = std::env::var_os("OSD_HOLD_FILE") {
            let _held = std::fs::File::open(path).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn reads_a_live_process_cwd() {
        let got = platform::process_cwd(std::process::id()).expect("own cwd");
        let want = std::env::current_dir().unwrap();
        assert_eq!(
            std::fs::canonicalize(got).unwrap(),
            std::fs::canonicalize(want).unwrap()
        );
    }
}
