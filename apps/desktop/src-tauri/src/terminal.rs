// A real shell in a pane.
//
// The contract, not the implementation, is borrowed from Orca: a terminal is a
// PTY the UI owns by id — open it, write to it, resize it, close it, and read
// its bytes as they arrive. Orca's own terminal layer is forty-odd modules
// because it also spans WSL, SSH and worktree hibernation; none of that exists
// here, so this is the small honest core of the same idea.
//
// Output is pushed as events rather than polled: a shell writes when it writes,
// and a poll loop would either lag the caret or burn a timer doing nothing.
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter, Manager};

/// One live shell.
pub(crate) struct Terminal {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    output: Arc<Mutex<Output>>,
}

/// Where a shell's output goes besides the window: web clients reading it
/// through the gateway. The window needs neither part — its xterm keeps its
/// own scrollback — but a web page that reloads reattaches to a shell whose
/// screen it no longer has, and the recent output is what redraws it.
#[derive(Default)]
struct Output {
    recent: VecDeque<String>,
    recent_len: usize,
    readers: Vec<Sender<String>>,
}

/// How much output a reattaching web client is replayed. About a few screens
/// of a busy TUI; whole chunks are dropped from the front, never half of one.
const RECENT_BYTES: usize = 256 * 1024;

impl Output {
    fn push(&mut self, chunk: &str) {
        self.readers.retain(|tx| tx.send(chunk.to_string()).is_ok());
        self.recent_len += chunk.len();
        self.recent.push_back(chunk.to_string());
        while self.recent_len > RECENT_BYTES && self.recent.len() > 1 {
            if let Some(old) = self.recent.pop_front() {
                self.recent_len -= old.len();
            }
        }
    }

    fn subscribe(&mut self) -> Receiver<String> {
        let (tx, rx) = channel();
        for chunk in &self.recent {
            let _ = tx.send(chunk.clone());
        }
        self.readers.push(tx);
        rx
    }
}

#[derive(Default)]
pub struct TerminalState(pub Mutex<HashMap<String, Terminal>>);

/// Each live shell's process id, keyed by the pane that owns it.
///
/// The status bar needs this to say WHICH terminal is using the memory — a
/// single total tells you the workbench is heavy but not which pane to look at.
pub fn pids(state: &TerminalState) -> std::collections::HashMap<String, u32> {
    let Ok(map) = state.0.lock() else {
        return std::collections::HashMap::new();
    };
    map.iter()
        .filter_map(|(id, term)| Some((id.clone(), term.child.process_id()?)))
        .collect()
}

/// Event carrying a chunk of a terminal's output. One event name per terminal
/// so a pane listens only to its own shell.
fn output_event(id: &str) -> String {
    format!("terminal://{id}/data")
}

fn exit_event(id: &str) -> String {
    format!("terminal://{id}/exit")
}

/// The shell to run. `$SHELL` is the user's actual choice; the fallbacks only
/// matter on a machine that does not set it.
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Start a shell and stream its output to the window.
///
/// `id` is the caller's own handle for it — the pane's leaf id — so a reopen
/// after a reload can reuse the same name without asking us for one.
#[tauri::command(async)]
pub fn terminal_open(
    app: AppHandle,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    open(&app, id, cwd, cols, rows)
}

/// True when a new shell was started; false when `id` was already running
/// (a remount, or a shell a web client sharing these Screens opened first).
/// Only a new shell may be sent the pane's startup command.
fn open(app: &AppHandle, id: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<bool, String> {
    let state = app.state::<TerminalState>();
    // Reopening a live terminal is a no-op, not a second shell: a pane that
    // remounts (a Screen switch, a React strict-mode double effect) must not
    // silently leave an orphan process behind.
    //
    // ONE lock for the whole open, not one to check and another to insert.
    // Tauri runs these on a thread pool, so two opens for the same id — exactly
    // what a remount produces — both passed the check inside the old gap, both
    // spawned a shell, and the second insert dropped the first `Terminal`
    // without killing its child. Dropping a `portable_pty` child does not kill
    // it, so that PTY outlived the pane with nothing left holding its id: the
    // orphan this check exists to prevent.
    //
    // The reader thread below takes the same lock to forget an exited shell. It
    // blocks until this returns rather than deadlocking, and that ordering is
    // wanted: a shell that exits instantly must not be removed before it is
    // inserted.
    let mut terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if terminals.contains_key(&id) {
        return Ok(false);
    }

    let pty = NativePtySystem::default();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = default_shell();
    let mut command = CommandBuilder::new(&shell);
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        command.cwd(dir);
    }
    // Tell the shell what it is talking to, or curses programs assume the
    // dumbest possible terminal and render as if formatting did not exist.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // Launched from Finder the app has no LANG, so the shell would start in the
    // C locale: zsh then echoes typed CJK as escapes and counts its bytes as
    // columns. The user's rc files still run after and can override.
    if std::env::var_os("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
    // The app's proxy setting, same as the sidecar gets. Launched from Finder
    // the app inherits no shell env, so without this a Claude Code / Codex
    // started (or auto-resumed) here cannot reach its API behind a proxy and
    // hangs silently. The user's rc files still run after and can override.
    for (k, v) in crate::runtime::sidecar_proxy_env(app) {
        command.env(k, v);
    }
    // The shell restores what the user exported by hand before the app last
    // closed, after its startup files (see terminal_env.rs).
    crate::terminal_env::prepare(app, &shell, &id, &mut command);

    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    // The slave handle must be dropped or the master never sees EOF when the
    // shell exits, and the reader below blocks for the life of the app.
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let output = Arc::new(Mutex::new(Output::default()));
    let reader_output = output.clone();
    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        // Bytes of a character the last read cut in half. Decoding each read on
        // its own turned every split `─` into three `�`, three cells where the
        // program had counted one; a TUI that redraws with relative cursor moves
        // (Claude Code, Codex) then drew its rules over its own text.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    let chunk = take_utf8(&mut pending);
                    if chunk.is_empty() {
                        continue;
                    }
                    if let Ok(mut out) = reader_output.lock() {
                        out.push(&chunk);
                    }
                    if reader_app.emit(&output_event(&reader_id), chunk).is_err() {
                        break; // The window is gone; so is the reason to read.
                    }
                }
            }
        }
        let _ = reader_app.emit(&exit_event(&reader_id), ());
        // Dropping the senders is what tells a web reader the shell is gone.
        if let Ok(mut out) = reader_output.lock() {
            out.readers.clear();
        }
        if let Some(state) = reader_app.try_state::<TerminalState>() {
            if let Ok(mut terminals) = state.0.lock() {
                terminals.remove(&reader_id);
            }
        }
    });

    terminals.insert(
        id,
        Terminal {
            writer,
            master: pair.master,
            child,
            output,
        },
    );
    Ok(true)
}

/// What every live terminal is doing: its shell's folder and the coding agent
/// running in it (see `terminal_probe.rs`). Polled by the layout every few
/// seconds so a relaunch can reopen each terminal where it was.
///
/// The pids are read under the lock and probed outside it: probing reads files
/// (and on macOS may run `lsof` once per Codex process), and keystrokes must not
/// wait behind that.
#[tauri::command(async)]
pub fn terminal_probe(app: AppHandle) -> HashMap<String, crate::terminal_probe::TerminalProbe> {
    let state = app.state::<TerminalState>();
    let targets: Vec<(String, Option<u32>, Option<u32>)> = match state.0.lock() {
        Ok(map) => map
            .iter()
            .map(|(id, term)| (id.clone(), term.child.process_id(), foreground_of(term)))
            .collect(),
        Err(_) => return HashMap::new(),
    };
    targets
        .into_iter()
        .map(|(id, shell, fg)| (id, crate::terminal_probe::probe(shell, fg)))
        .collect()
}

#[cfg(unix)]
fn foreground_of(term: &Terminal) -> Option<u32> {
    term.master
        .process_group_leader()
        .filter(|p| *p > 0)
        .map(|p| p as u32)
}

#[cfg(not(unix))]
fn foreground_of(_term: &Terminal) -> Option<u32> {
    None
}

/// Keystrokes, paste, anything the pane types.
#[tauri::command]
pub fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    write(&app, &id, &data)
}

fn write(app: &AppHandle, id: &str, data: &str) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    let terminal = terminals.get_mut(id).ok_or("no such terminal")?;
    terminal
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    terminal.writer.flush().map_err(|e| e.to_string())
}

/// The pane changed size. Without this the shell keeps wrapping to the old
/// width and every full-screen program draws into the wrong box.
#[tauri::command]
pub fn terminal_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    resize(&app, &id, cols, rows)
}

fn resize(app: &AppHandle, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    let Some(terminal) = terminals.get(id) else {
        return Ok(()); // A resize for a shell that already exited is not an error.
    };
    terminal
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Kill the shell and forget it. Called when the pane closes.
#[tauri::command]
pub fn terminal_close(app: AppHandle, id: String) -> Result<(), String> {
    close(&app, &id)
}

fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if let Some(mut terminal) = terminals.remove(id) {
        let _ = terminal.child.kill();
        let _ = terminal.child.wait();
    }
    crate::terminal_env::forget(app, id);
    Ok(())
}

/// The desktop's shells, offered to the remote-access gateway. Which of them a
/// web client may touch, and whether it may at all, is the gateway's call.
pub struct GatewayTerminals(pub AppHandle);

impl osd_core::gateway::Terminals for GatewayTerminals {
    fn open(&self, id: &str, cwd: Option<String>, cols: u16, rows: u16) -> Result<bool, String> {
        open(&self.0, id.to_string(), cwd, cols, rows)
    }
    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        write(&self.0, id, data)
    }
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        resize(&self.0, id, cols, rows)
    }
    fn close(&self, id: &str) -> Result<(), String> {
        close(&self.0, id)
    }
    fn subscribe(&self, id: &str) -> Option<Receiver<String>> {
        let state = self.0.state::<TerminalState>();
        let terminals = state.0.lock().ok()?;
        let mut output = terminals.get(id)?.output.lock().ok()?;
        Some(output.subscribe())
    }
}

/// Kill every shell — the app is quitting, and a PTY child outlives its parent
/// unless someone says otherwise.
pub fn close_all(state: &TerminalState) {
    if let Ok(mut terminals) = state.0.lock() {
        for (_, mut terminal) in terminals.drain() {
            let _ = terminal.child.kill();
        }
    }
}

/// Decode everything in `pending` except a trailing, still-incomplete UTF-8
/// sequence, which stays behind for the next read to finish. Bytes that are
/// invalid in themselves are still replaced (lossy), so a program printing
/// binary cannot stall the terminal.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let split = pending.len() - incomplete_tail(pending);
    let text = String::from_utf8_lossy(&pending[..split]).into_owned();
    pending.drain(..split);
    text
}

/// Length of a UTF-8 sequence cut off at the end of `bytes`: its lead byte
/// promises more continuation bytes than follow it. 0 when the end is whole.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(4) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            continue; // a continuation byte; the lead is further back
        }
        let need = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

/// Shared so the frontend and this module cannot drift on the event names.
#[tauri::command]
pub fn terminal_event_names(id: String) -> (String, String) {
    (output_event(&id), exit_event(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reattaching_reader_gets_recent_output_then_live_output() {
        let mut out = Output::default();
        out.push("$ ls\r\n");
        let early = out.subscribe();
        out.push("a.txt\r\n");
        let late = out.subscribe();
        assert_eq!(early.try_iter().collect::<Vec<_>>(), ["$ ls\r\n", "a.txt\r\n"]);
        assert_eq!(late.try_iter().collect::<Vec<_>>(), ["$ ls\r\n", "a.txt\r\n"]);
        // A reader that went away is dropped, not written to forever.
        drop(early);
        out.push("$ ");
        assert_eq!(out.readers.len(), 1);
        assert_eq!(late.try_iter().collect::<Vec<_>>(), ["$ "]);
    }

    #[test]
    fn recent_output_is_capped_in_whole_chunks() {
        let mut out = Output::default();
        let chunk = "x".repeat(100 * 1024);
        for _ in 0..5 {
            out.push(&chunk);
        }
        assert!(out.recent_len <= RECENT_BYTES);
        assert!(out.recent.iter().all(|c| c.len() == chunk.len()));
    }

    #[test]
    fn a_terminal_owns_its_own_event_names() {
        // Two panes must never receive each other's bytes.
        assert_eq!(output_event("p1"), "terminal://p1/data");
        assert_eq!(exit_event("p1"), "terminal://p1/exit");
        assert_ne!(output_event("p1"), output_event("p2"));
    }

    #[test]
    fn a_character_split_across_reads_arrives_whole() {
        // `─` is E2 94 80. Cut after its first byte, it must not become `�`.
        let rule = "a─b".as_bytes();
        let mut pending = rule[..2].to_vec();
        assert_eq!(take_utf8(&mut pending), "a");
        assert_eq!(pending, vec![0xE2]);
        pending.extend_from_slice(&rule[2..]);
        assert_eq!(take_utf8(&mut pending), "─b");
        assert!(pending.is_empty());
    }

    #[test]
    fn every_split_point_of_wide_text_decodes_losslessly() {
        let text = "设计 ⏺ 🧪 ─│ ok";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut pending = bytes[..cut].to_vec();
            let mut out = take_utf8(&mut pending);
            pending.extend_from_slice(&bytes[cut..]);
            out += &take_utf8(&mut pending);
            assert_eq!(out, text, "cut at {cut}");
        }
    }

    #[test]
    fn invalid_bytes_do_not_stall_the_terminal() {
        // A stray continuation byte is garbage, not the start of something.
        let mut pending = vec![b'a', 0x80, b'b'];
        assert_eq!(take_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn falls_back_to_a_real_shell_when_the_environment_names_none() {
        // Never empty: an empty command would fail to spawn with no explanation.
        assert!(!default_shell().is_empty());
    }
}
