// What a terminal is doing, in words another agent can read.
//
// A terminal running Claude Code or Codex is read from the agent's OWN
// transcript, not its screen: a TUI redraws the same rows over and over, and
// its scrollback is a smear of cursor moves. Both agents write one JSON object
// per line under the user's home, keyed by their session id — which the
// desktop already probes for every terminal (`terminal_probe.rs`) and keeps on
// the pane. A plain shell has no transcript; its recent output is read instead,
// with the escape sequences taken out.
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, PartialEq)]
pub struct Entry {
    /// "user", "assistant" or "tool" (a command the agent ran, a file it changed).
    pub role: &'static str,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct Transcript {
    /// "claude" or "codex".
    pub agent: String,
    /// Still working on a turn: the last thing it did was not finishing one.
    pub busy: bool,
    pub entries: Vec<Entry>,
}

/// A session id is read from a pane the client controls; only the characters
/// an id has may reach a file name.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Claude Code keeps `~/.claude/projects/<cwd, escaped>/<id>.jsonl`. The
/// escaping is not worth reproducing (non-ASCII folders come out as runs of
/// dashes), and the id is unique: look one level down for the file.
fn claude_file(home: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    std::fs::read_dir(home.join(".claude").join("projects"))
        .ok()?
        .flatten()
        .map(|d| d.path().join(&name))
        .find(|p| p.is_file())
}

/// Codex keeps `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>[…].jsonl`.
fn codex_file(home: &Path, id: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, id: &str, depth: u8) -> Option<PathBuf> {
        let mut entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).collect();
        // Newest first: a session being read is almost always a recent one.
        entries.sort_by(|a, b| b.cmp(a));
        for p in entries {
            if depth > 0 && p.is_dir() {
                if let Some(hit) = walk(&p, id, depth - 1) {
                    return Some(hit);
                }
            } else if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("rollout-") && name.ends_with(".jsonl") && name.contains(id) {
                    return Some(p);
                }
            }
        }
        None
    }
    walk(&home.join(".codex").join("sessions"), id, 3)
}

fn lines(path: &Path) -> impl Iterator<Item = Value> {
    let file = std::fs::File::open(path).ok();
    file.into_iter()
        .flat_map(|f| BufReader::new(f).lines())
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(&l).ok())
}

/// One tool call as a line: the name and the start of its input.
fn tool_line(name: &str, input: &Value) -> String {
    let arg = match input {
        Value::Object(m) => ["command", "file_path", "path", "pattern", "query", "url", "description"]
            .iter()
            .find_map(|k| m.get(*k).and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_default(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    };
    let arg: String = arg.chars().take(160).collect();
    if arg.is_empty() { name.to_string() } else { format!("{name}: {arg}") }
}

fn claude(path: &Path) -> (Vec<Entry>, bool) {
    let mut out = Vec::new();
    let mut busy = false;
    for v in lines(path) {
        let msg = &v["message"];
        match v["type"].as_str() {
            Some("user") if v["isMeta"].as_bool() != Some(true) => {
                let text = match &msg["content"] {
                    Value::String(s) => s.clone(),
                    Value::Array(parts) => parts
                        .iter()
                        .filter(|p| p["type"] == "text")
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                // Tool results come back as "user" lines with no text of their own;
                // command echoes (`<local-command-…>`, `<command-name>`) are not things anyone said.
                if !text.trim().is_empty() && !text.trim_start().starts_with('<') {
                    out.push(Entry { role: "user", text });
                    busy = true;
                }
            }
            // Sent while a turn was running: Claude Code queues it and hands it
            // over mid-turn, recording it as an attachment, not a user line.
            Some("attachment") if v["attachment"]["type"] == "queued_command" => {
                if let Some(t) = v["attachment"]["prompt"].as_str().filter(|t| !t.trim().is_empty()) {
                    out.push(Entry { role: "user", text: t.to_string() });
                    busy = true;
                }
            }
            Some("assistant") => {
                for p in msg["content"].as_array().into_iter().flatten() {
                    match p["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = p["text"].as_str().filter(|t| !t.trim().is_empty()) {
                                out.push(Entry { role: "assistant", text: t.to_string() });
                            }
                        }
                        Some("tool_use") => out.push(Entry {
                            role: "tool",
                            text: tool_line(p["name"].as_str().unwrap_or("tool"), &p["input"]),
                        }),
                        _ => {}
                    }
                }
                busy = msg["stop_reason"].as_str() != Some("end_turn");
            }
            _ => {}
        }
    }
    (out, busy)
}

fn codex(path: &Path) -> (Vec<Entry>, bool) {
    let mut out = Vec::new();
    let mut busy = false;
    let texts = |content: &Value| -> String {
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    for v in lines(path) {
        let p = &v["payload"];
        match (v["type"].as_str(), p["type"].as_str()) {
            (Some("event_msg"), Some("task_started")) => busy = true,
            (Some("event_msg"), Some("task_complete")) => busy = false,
            (Some("event_msg"), Some("item_completed")) => {
                let item = &p["item"];
                match item["type"].as_str() {
                    Some("UserMessage") => {
                        let text = texts(&item["content"]);
                        if !text.trim().is_empty() {
                            out.push(Entry { role: "user", text });
                        }
                    }
                    Some("AgentMessage") => {
                        let text = texts(&item["content"]);
                        if !text.trim().is_empty() {
                            out.push(Entry { role: "assistant", text });
                        }
                    }
                    Some("CommandExecution") => {
                        let cmd = match &item["command"] {
                            Value::Array(a) => a.last().and_then(Value::as_str).unwrap_or("").to_string(),
                            other => other.as_str().unwrap_or("").to_string(),
                        };
                        out.push(Entry { role: "tool", text: tool_line("exec", &Value::String(cmd)) });
                    }
                    Some("FileChange") => {
                        let files: Vec<String> =
                            item["changes"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
                        out.push(Entry { role: "tool", text: format!("edit: {}", files.join(", ")) });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    (out, busy)
}

/// The last `turns` turns (each starting at a user message) of an agent's
/// transcript, or None when there is no such session on this machine.
pub fn transcript(home: &Path, agent: &str, session_id: &str, turns: usize) -> Option<Transcript> {
    if !valid_session_id(session_id) {
        return None;
    }
    let (entries, busy) = match agent {
        "claude" => claude(&claude_file(home, session_id)?),
        "codex" => codex(&codex_file(home, session_id)?),
        _ => return None,
    };
    let starts: Vec<usize> = entries.iter().enumerate().filter(|(_, e)| e.role == "user").map(|(i, _)| i).collect();
    let from = if starts.len() > turns { starts[starts.len() - turns] } else { 0 };
    let entries = entries.into_iter().skip(from).collect();
    Some(Transcript { agent: agent.to_string(), busy, entries })
}

/// A shell's output as text: escape sequences removed, carriage-return
/// overwrites applied, the last `n` non-empty lines.
pub fn screen_text(raw: &str, n: usize) -> String {
    let mut clean = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI: parameters then one final byte in @–~.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ST (ESC \).
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' if chars.peek() != Some(&'\n') => {
                // Redrawing the line from its start: keep only what follows.
                if let Some(nl) = clean.rfind('\n') {
                    clean.truncate(nl + 1);
                } else {
                    clean.clear();
                }
            }
            '\r' => {}
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => clean.push(c),
        }
    }
    let kept: Vec<&str> = clean.lines().map(str::trim_end).filter(|l| !l.is_empty()).collect();
    kept[kept.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home_with(rel: &str, body: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("osd-tread-{}", rand_suffix()));
        let file = home.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, body).unwrap();
        home
    }

    fn rand_suffix() -> String {
        format!("{:?}{}", std::thread::current().id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
            .replace(|c: char| !c.is_ascii_alphanumeric(), "")
    }

    #[test]
    fn claude_transcript_reads_the_conversation_and_whether_a_turn_is_open() {
        let body = [
            r#"{"type":"user","message":{"content":"<local-command-caveat>x</local-command-caveat>"}}"#,
            r#"{"type":"user","message":{"content":"fix the build"}}"#,
            r#"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","input":{"command":"cargo build"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"thinking","thinking":""},{"type":"text","text":"Fixed."}]}}"#,
            "not json",
            r#"{"type":"user","message":{"content":"now the tests"}}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"and the docs"}"#,
            r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"and the docs"}}"#,
        ]
        .join("\n");
        let home = home_with(".claude/projects/-Users-x-repo/abc-123.jsonl", &body);
        let t = transcript(&home, "claude", "abc-123", 5).unwrap();
        assert_eq!(
            t.entries,
            vec![
                Entry { role: "user", text: "fix the build".into() },
                Entry { role: "tool", text: "Bash: cargo build".into() },
                Entry { role: "assistant", text: "Fixed.".into() },
                Entry { role: "user", text: "now the tests".into() },
                Entry { role: "user", text: "and the docs".into() },
            ]
        );
        assert!(t.busy, "a message is waiting for an answer");
        assert_eq!(transcript(&home, "claude", "abc-123", 1).unwrap().entries.len(), 1, "last turn only");
        assert_eq!(transcript(&home, "claude", "abc-123", 2).unwrap().entries.len(), 2);
        assert!(transcript(&home, "claude", "../abc-123", 5).is_none());
        assert!(transcript(&home, "claude", "nope", 5).is_none());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn codex_transcript_reads_items_and_task_boundaries() {
        let body = [
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"why did it fail?"}]}}}"#,
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":["/bin/zsh","-lc","tail log"]}}}"#,
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"JSON parse."}]}}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]
        .join("\n");
        let home = home_with(".codex/sessions/2026/10/04/rollout-2026-10-04T10-27-13-0199aa.jsonl", &body);
        let t = transcript(&home, "codex", "0199aa", 5).unwrap();
        assert_eq!(t.entries.len(), 3);
        assert_eq!(t.entries[1], Entry { role: "tool", text: "exec: tail log".into() });
        assert!(!t.busy);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn screen_text_drops_escapes_and_overwritten_lines() {
        let raw = "\u{1b}]0;title\u{7}$ make\r\n\u{1b}[32mok\u{1b}[0m\r\nprogress 10%\rprogress 100%\r\n\r\n$ ";
        assert_eq!(screen_text(raw, 10), "$ make\nok\nprogress 100%\n$");
        assert_eq!(screen_text(raw, 1), "$");
    }
}
