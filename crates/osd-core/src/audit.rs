// Who did what through the gateway.
//
// Web accounts are colleagues on one workbench: they see and can change
// everything, by design. What keeps that workable is being able to look back:
// which account (or which agent, on whose behalf) sent this message, deleted
// that conversation, typed into that terminal. One JSON object per line in
// `<runtime>/audit/YYYY-MM.jsonl` (UTC months), append-only, owner-only.
//
// Only changes are recorded — reads would bury them in polling. Never a
// password, a token or the content of an uploaded file; a message keeps its
// first 500 characters, terminal input its first 2 KB.
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::env::Env;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    /// UTC, `2026-10-24T16:13:47Z`.
    pub time: String,
    /// `admin` (the token) or `account:<name>`.
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    /// The conversation whose agent made the call (`X-OSD-Origin-Session`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// `session.prompt`, `terminal.input`, `login.failed`, …
    pub action: String,
    /// What it was done to: a session id, a terminal id, a file name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// The words of a message, the keys typed, a new title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub status: u16,
}

#[derive(Debug, Default, Deserialize)]
pub struct Filter {
    pub actor: Option<String>,
    pub target: Option<String>,
    pub action: Option<String>,
    /// UTC, inclusive; compared as text, so `2026-10-01` works.
    pub since: Option<String>,
    pub until: Option<String>,
    pub limit: Option<usize>,
}

/// One writer at a time, so two requests finishing together cannot interleave
/// inside a line.
static WRITE: Mutex<()> = Mutex::new(());

fn dir(env: &Env) -> Result<PathBuf, String> {
    Ok(crate::runtime::runtime_root(env)?.join("audit"))
}

/// Year, month, day of a day count since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`; the inverse of `usage::days_from_civil`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

/// `secs` since the epoch as `2026-10-24T16:13:47Z`.
pub fn utc(secs: u64) -> String {
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

pub fn now() -> String {
    utc(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

/// The first `max` characters, and how long it was when that is not all of it.
pub fn clip(text: &str, max: usize) -> String {
    let n = text.chars().count();
    if n <= max {
        return text.to_string();
    }
    format!("{}… ({n} characters)", text.chars().take(max).collect::<String>())
}

/// Keystrokes as the line they type: escape sequences (arrows, function keys)
/// dropped, Backspace applied, Enter shown as ⏎. Raw terminal input is one
/// request per key; this is what makes a typed command readable as one entry.
pub fn typed(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                // CSI (`ESC [ … final`) or SS3 (`ESC O x`); a bare ESC is dropped.
                match chars.next() {
                    Some('[') => {
                        for c in chars.by_ref() {
                            if ('@'..='~').contains(&c) {
                                break;
                            }
                        }
                    }
                    Some('O') => {
                        chars.next();
                    }
                    _ => {}
                }
            }
            '\u{7f}' | '\u{8}' => {
                out.pop();
            }
            '\r' | '\n' => {
                if chars.peek() == Some(&'\n') && c == '\r' {
                    chars.next();
                }
                out.push('⏎');
            }
            c if c.is_control() && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// Append one entry. Never fails the request it records: an audit that cannot
/// be written is reported on stderr.
pub fn record(env: &Env, entry: &Entry) {
    let write = || -> Result<(), String> {
        let dir = dir(env)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("{}.jsonl", &entry.time[..7]));
        let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        line.push('\n');
        let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&file).map_err(|e| e.to_string())?;
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())
    };
    if let Err(e) = write() {
        eprintln!("audit: could not record {}: {e}", entry.action);
    }
}

/// Matching entries, newest first, at most `limit` (default 200).
pub fn query(env: &Env, filter: &Filter) -> Result<Vec<Entry>, String> {
    let limit = filter.limit.unwrap_or(200).clamp(1, 10_000);
    let mut months: Vec<PathBuf> = match std::fs::read_dir(dir(env)?) {
        Ok(rd) => rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect(),
        Err(_) => return Ok(Vec::new()),
    };
    months.sort();
    let keep = |e: &Entry| {
        filter.actor.as_ref().is_none_or(|a| &e.actor == a || e.actor == format!("account:{a}"))
            && filter.target.as_ref().is_none_or(|t| e.target.as_ref() == Some(t) || e.via.as_ref() == Some(t))
            && filter.action.as_ref().is_none_or(|a| e.action.starts_with(a.as_str()))
            && filter.since.as_ref().is_none_or(|s| e.time.as_str() >= s.as_str())
            && filter.until.as_ref().is_none_or(|u| e.time.as_str() <= u.as_str() || e.time.starts_with(u.as_str()))
    };
    let mut out = Vec::new();
    for file in months.iter().rev() {
        // A month that ends before `since` holds nothing newer.
        let month = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if filter.since.as_ref().is_some_and(|s| month < &s[..s.len().min(7)]) {
            break;
        }
        let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
        for e in text.lines().rev().filter_map(|l| serde_json::from_str::<Entry>(l).ok()).filter(keep) {
            out.push(e);
            if out.len() == limit {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

/// This month's file, for tests that read what was written.
#[cfg(test)]
pub fn utc_month_file_for_tests(env: &Env) -> PathBuf {
    dir(env).unwrap().join(format!("{}.jsonl", &now()[..7]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_times_and_clipping() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(1_792_800_000), "2026-10-24T00:00:00Z");
        assert_eq!(utc(951_782_400 + 3_661), "2000-02-29T01:01:01Z");
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("一二三四五", 2), "一二… (5 characters)");
        assert_eq!(typed("lx\u{7f}s -l\u{1b}[D\u{1b}[C\r"), "ls -l⏎");
        assert_eq!(typed("a\r\nb\u{3}"), "a⏎b");
    }

    #[test]
    fn entries_are_appended_by_month_and_found_newest_first() {
        let root = std::env::temp_dir().join(format!("osd-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        let env = Env::new(root.clone(), root.join("res"), None, "0.0.0".into());
        let e = |time: &str, actor: &str, action: &str, target: &str| Entry {
            time: time.into(),
            actor: actor.into(),
            ip: None,
            via: None,
            action: action.into(),
            target: Some(target.into()),
            detail: None,
            status: 200,
        };
        record(&env, &e("2026-09-30T23:00:00Z", "admin", "session.delete", "ses_1"));
        record(&env, &e("2026-10-01T08:00:00Z", "account:erin", "session.prompt", "ses_2"));
        record(&env, &e("2026-10-02T08:00:00Z", "account:erin", "terminal.input", "p3"));
        assert!(root.join("runtime/audit/2026-09.jsonl").is_file());

        let all = query(&env, &Filter::default()).unwrap();
        assert_eq!(all.iter().map(|e| e.target.clone().unwrap()).collect::<Vec<_>>(), ["p3", "ses_2", "ses_1"]);
        let erin = query(&env, &Filter { actor: Some("erin".into()), ..Default::default() }).unwrap();
        assert_eq!(erin.len(), 2);
        let prompts = query(&env, &Filter { action: Some("session".into()), since: Some("2026-10-01".into()), ..Default::default() }).unwrap();
        assert_eq!(prompts.len(), 1);
        let one = query(&env, &Filter { limit: Some(1), ..Default::default() }).unwrap();
        assert_eq!(one[0].target.as_deref(), Some("p3"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(root.join("runtime/audit/2026-10.jsonl")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
