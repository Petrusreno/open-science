// A real shell in a pane.
//
// The contract is borrowed from Orca: a terminal is a PTY the UI owns by id —
// open it, write to it, resize it, close it, and read its bytes as they arrive.
// So is where the PTY lives: in the terminal host (`osd termd`, osd-core
// termd.rs), a background process that outlives the app. An update, a crash or
// a quit leaves every shell, and the Claude Code / Codex in it, running; the
// next app finds them by pane id, replays their recent output and carries on.
//
// This module is the host's client. It keeps, per terminal it has attached,
// the output stream the window and web clients read.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use osd_core::termd::{self, Client, Output, Spawn};
use portable_pty::CommandBuilder;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// A terminal this app has attached.
struct Attached {
    output: Arc<Mutex<Output>>,
    pid: Option<u32>,
    /// (rows, cols), as last set from here.
    size: (u16, u16),
}

#[derive(Default)]
struct Inner {
    host: Option<Client>,
    terminals: HashMap<String, Attached>,
}

/// One lock for the host connection and the attached terminals: an open is a
/// check, a host call and an insert, and two opens for one id (a remount) must
/// not both get past the check.
#[derive(Default)]
pub struct TerminalState(Mutex<Inner>);

impl Inner {
    /// A request to the host, starting the host if none runs. A connection the
    /// host dropped (it restarted) is dialled again, once.
    fn call<T>(&mut self, app: &AppHandle, f: impl Fn(&mut Client) -> Result<T, String>) -> Result<T, String> {
        for _ in 0..2 {
            let host = match &mut self.host {
                Some(host) => host,
                None => self.host.insert(termd::ensure(&data_dir(app)?, &bundled_osd()?)?),
            };
            let result = f(host);
            if !host.is_broken() {
                return result;
            }
            self.host = None;
        }
        Err("the terminal host is not answering".into())
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The bundled `osd`, which runs the host. Tauri bundles it next to the app
/// binary under its plain name (in development: `scripts/dev/build-osd-sidecar.sh`).
fn bundled_osd() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) { "osd.exe" } else { "osd" };
    let path = exe.parent().ok_or("no app folder")?.join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("terminal host missing: {} (dev: scripts/dev/build-osd-sidecar.sh)", path.display()))
    }
}

/// Each attached shell's process id, keyed by the pane that owns it: the status
/// bar says WHICH terminal is using the memory.
pub fn pids(state: &TerminalState) -> HashMap<String, u32> {
    let Ok(inner) = state.0.lock() else { return HashMap::new() };
    inner.terminals.iter().filter_map(|(id, t)| Some((id.clone(), t.pid?))).collect()
}

/// The terminal host's process id, once this app has reached it: what the
/// terminals' programs (a dev server, say) run under.
pub fn host_pid(state: &TerminalState) -> Option<u32> {
    state.0.lock().ok()?.host.as_ref().map(|h| h.welcome.pid)
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

/// Start a shell, or attach the one already running under this pane's id.
///
/// `id` is the caller's own handle for it — the pane's leaf id — so a reopen
/// after a reload or a relaunch finds the same shell without asking for a name.
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
/// (a remount, a web client sharing these Screens, or a shell that outlived
/// the last app). Only a new shell may be sent the pane's startup command.
fn open(app: &AppHandle, id: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<bool, String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if inner.terminals.contains_key(&id) {
        return Ok(false);
    }

    let spawn = Spawn::from_command(&shell_command(app, &id, cwd), cols, rows);
    let (created, pid) = inner.call(app, |host| host.open(&id, &spawn))?;
    let stream = inner.host.as_ref().ok_or("terminal host gone")?.attach(&id)?;

    let output = Arc::new(Mutex::new(Output::default()));
    let reader_output = output.clone();
    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        for chunk in stream {
            if let Ok(mut out) = reader_output.lock() {
                out.push(&chunk);
            }
        }
        // The shell exited (or the host went away with it): readers' channels
        // close, and the id is free for a new shell — if it still names this one.
        if let Ok(mut out) = reader_output.lock() {
            out.end();
        }
        if let Some(state) = reader_app.try_state::<TerminalState>() {
            if let Ok(mut inner) = state.0.lock() {
                if inner.terminals.get(&reader_id).is_some_and(|t| Arc::ptr_eq(&t.output, &reader_output)) {
                    inner.terminals.remove(&reader_id);
                }
            }
        }
    });

    inner.terminals.insert(id, Attached { output, pid, size: (rows.max(1), cols.max(1)) });
    Ok(created)
}

/// The command a pane's shell starts with. Built here, not in the host: the
/// host was started by whichever app came first, possibly an older one.
fn shell_command(app: &AppHandle, id: &str, cwd: Option<String>) -> CommandBuilder {
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
    // The shell restores what the user exported by hand before it last ended
    // (see terminal_env.rs).
    crate::terminal_env::prepare(app, &shell, id, &mut command);
    command
}

/// A terminal's output, for the window: recent output first (all of it that a
/// reattached pane missed), then live, then `exit`.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "lowercase")]
pub enum TerminalEvent {
    Data(String),
    Exit,
}

#[tauri::command]
pub fn terminal_subscribe(app: AppHandle, id: String, on_event: Channel<TerminalEvent>) {
    let rx = subscribe(&app, &id);
    std::thread::spawn(move || {
        if let Some(rx) = rx {
            for chunk in rx {
                if on_event.send(TerminalEvent::Data(chunk)).is_err() {
                    return; // The window is gone.
                }
            }
        }
        let _ = on_event.send(TerminalEvent::Exit);
    });
}

fn subscribe(app: &AppHandle, id: &str) -> Option<Receiver<String>> {
    let state = app.state::<TerminalState>();
    let inner = state.0.lock().ok()?;
    let mut output = inner.terminals.get(id)?.output.lock().ok()?;
    Some(output.subscribe())
}

/// What every live terminal is doing: its shell's folder and the coding agent
/// running in it (see `terminal_probe.rs`). Polled by the layout every few
/// seconds so a relaunch can reopen each terminal where it was.
///
/// The host is asked under the lock and the probing happens outside it:
/// probing reads files (and on macOS may run `lsof` once per Codex process),
/// and keystrokes must not wait behind that.
#[tauri::command(async)]
pub fn terminal_probe(app: AppHandle) -> HashMap<String, crate::terminal_probe::TerminalProbe> {
    let state = app.state::<TerminalState>();
    let listed = match state.0.lock() {
        // Nothing attached, nothing to ask (and no host to start for it).
        Ok(mut inner) if !inner.terminals.is_empty() => inner.call(&app, |host| host.list()),
        _ => return HashMap::new(),
    };
    listed
        .unwrap_or_default()
        .into_iter()
        .map(|t| (t.id, crate::terminal_probe::probe(t.pid, t.foreground)))
        .collect()
}

/// Keystrokes, paste, anything the pane types.
#[tauri::command]
pub fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    write(&app, &id, &data)
}

fn write(app: &AppHandle, id: &str, data: &str) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if !inner.terminals.contains_key(id) {
        return Err("no such terminal".into());
    }
    inner.call(app, |host| host.write(id, data))
}

/// The pane changed size. Without this the shell keeps wrapping to the old
/// width and every full-screen program draws into the wrong box.
#[tauri::command]
pub fn terminal_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    resize(&app, &id, cols, rows)
}

fn resize(app: &AppHandle, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    let Some(terminal) = inner.terminals.get_mut(id) else {
        return Ok(()); // A resize for a shell that already exited is not an error.
    };
    terminal.size = (rows.max(1), cols.max(1));
    inner.call(app, |host| host.resize(id, cols, rows))
}

/// Kill the shell and forget it. Called when the pane closes.
#[tauri::command]
pub fn terminal_close(app: AppHandle, id: String) -> Result<(), String> {
    close(&app, &id)
}

fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    inner.terminals.remove(id);
    let result = inner.call(app, |host| host.close(id));
    crate::terminal_env::forget(app, id);
    result
}

/// End the shells whose panes are gone: the window's own (web clients' ids
/// start with `w`, see terminalTransport.ts) that no restored pane names.
/// Called once at startup with the restored layout. A pane closed while the
/// host kept running otherwise leaves its shell, and whatever agent is in it,
/// running where no pane shows it — and leaf ids are reused, so the next new
/// pane of that id would attach to it.
pub fn prune(app: &AppHandle, open: &[String]) {
    let state = app.state::<TerminalState>();
    let Ok(mut inner) = state.0.lock() else { return };
    // Only a host that already runs: there is nothing to prune in a new one.
    if inner.host.is_none() {
        let Ok(dir) = data_dir(app) else { return };
        let Ok(client) = Client::connect(&dir) else { return };
        inner.host = Some(client);
    }
    let open: HashSet<&str> = open.iter().map(String::as_str).collect();
    let Ok(running) = inner.call(app, |host| host.list()) else { return };
    for t in running {
        if !t.id.starts_with('w') && !open.contains(t.id.as_str()) && !inner.terminals.contains_key(&t.id) {
            let _ = inner.call(app, |host| host.close(&t.id));
        }
    }
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
        subscribe(&self.0, id)
    }
    fn size(&self, id: &str) -> Option<(u16, u16)> {
        let state = self.0.state::<TerminalState>();
        let inner = state.0.lock().ok()?;
        Some(inner.terminals.get(id)?.size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_a_real_shell_when_the_environment_names_none() {
        // Never empty: an empty command would fail to spawn with no explanation.
        assert!(!default_shell().is_empty());
    }

    #[test]
    fn the_window_hears_data_then_exit() {
        let data = serde_json::to_value(TerminalEvent::Data("$ ".into())).unwrap();
        assert_eq!(data, serde_json::json!({ "kind": "data", "data": "$ " }));
        let exit = serde_json::to_value(TerminalEvent::Exit).unwrap();
        assert_eq!(exit, serde_json::json!({ "kind": "exit" }));
    }
}
