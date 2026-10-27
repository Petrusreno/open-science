// What the user exported by hand in a terminal, kept across a relaunch.
//
// Shells live in the terminal host and outlive the app (see osd-core termd.rs),
// but not a reboot or a host that exits. Then whatever `export` was typed into
// one — a proxy, an API key, an activated environment — would be lost, and the
// restored pane (and the Claude Code / Codex it resumes) would come back
// without it. So the shell writes down what it has: a small hook in zsh and bash records, at every prompt, the
// exported variables that differ from what the startup files produced, as a
// script the next shell of the same pane sources after those startup files.
//
// The hook is loaded without touching the user's dotfiles: zsh through a
// ZDOTDIR wrapper that runs their files first, bash through `--rcfile`. Other
// shells (fish, PowerShell, cmd) open as before, unrecorded.
//
// The record may hold secrets, so: one file per pane, in an owner-only folder,
// only the variables the user changed, deleted when the pane is closed.
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;
use tauri::{AppHandle, Manager};

const ZSHENV: &str = include_str!("../shell-integration/zsh/.zshenv");
const ZSHRC: &str = include_str!("../shell-integration/zsh/.zshrc");
const BASH_RCFILE: &str = include_str!("../shell-integration/bash-rcfile");

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

/// The folder holding every pane's record.
fn records_dir(data: &Path) -> PathBuf {
    data.join("terminal-env")
}

/// A pane's record. None for an id that is not a plain id: it names a file.
fn record_path(data: &Path, id: &str) -> Option<PathBuf> {
    let plain = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    plain.then(|| records_dir(data).join(format!("{id}.sh")))
}

#[derive(Debug, PartialEq)]
enum Shell {
    Zsh,
    Bash,
    Other,
}

fn shell_kind(shell: &str) -> Shell {
    match Path::new(shell).file_name().and_then(|n| n.to_str()) {
        Some("zsh") => Shell::Zsh,
        Some("bash") => Shell::Bash,
        _ => Shell::Other,
    }
}

/// Write `contents` to `path` unless it already holds exactly that. Never
/// rewritten in place: another pane's shell may be reading it this moment.
fn install(path: &Path, contents: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|c| c == contents) {
        return Ok(());
    }
    osd_core::runtime::write_atomic(path, contents)
}

#[cfg(unix)]
fn owner_only(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn owner_only(_dir: &Path) -> Result<(), String> {
    Ok(())
}

/// Set `command` up to record and restore the pane's exports. Any failure
/// leaves the command as it was: a terminal without the hook still has to open.
pub fn prepare(app: &AppHandle, shell: &str, id: &str, command: &mut CommandBuilder) {
    let Some(data) = data_dir(app) else { return };
    let _ = prepare_in(&data, shell, id, command);
}

fn prepare_in(data: &Path, shell: &str, id: &str, command: &mut CommandBuilder) -> Result<(), String> {
    let kind = shell_kind(shell);
    if kind == Shell::Other {
        return Ok(());
    }
    let record = record_path(data, id).ok_or("not a plain pane id")?;
    let records = records_dir(data);
    std::fs::create_dir_all(&records).map_err(|e| e.to_string())?;
    owner_only(&records)?;

    let integration = data.join("shell-integration");
    match kind {
        Shell::Zsh => {
            let dir = integration.join("zsh");
            install(&dir.join(".zshenv"), ZSHENV)?;
            install(&dir.join(".zshrc"), ZSHRC)?;
            // The wrapper hands the user's own ZDOTDIR back; unset stays unset.
            if let Some(user) = std::env::var_os("ZDOTDIR") {
                command.env("OSD_USER_ZDOTDIR", user);
            }
            command.env("ZDOTDIR", &dir);
        }
        Shell::Bash => {
            let rcfile = integration.join("bash-rcfile");
            install(&rcfile, BASH_RCFILE)?;
            command.arg("--rcfile");
            command.arg(&rcfile);
        }
        Shell::Other => unreachable!(),
    }
    command.env("OSD_TERM_ENV_FILE", &record);
    Ok(())
}

/// The pane is closed for good: its record goes with it.
pub fn forget(app: &AppHandle, id: &str) {
    if let Some(path) = data_dir(app).and_then(|d| record_path(&d, id)) {
        let _ = std::fs::remove_file(path);
    }
}

/// Delete the records of panes that no longer exist — closed while their
/// terminal was never opened, or while the app was going down. Leaf ids are
/// reused once the highest one is gone, so a leftover would otherwise be
/// sourced into an unrelated new pane.
#[tauri::command(async)]
pub fn terminal_env_prune(app: AppHandle, open: Vec<String>) {
    if let Some(data) = data_dir(&app) {
        prune_in(&data, &open);
    }
    // The same list ends the shells of those panes, still running in the host.
    crate::terminal::prune(&app, &open);
}

fn prune_in(data: &Path, open: &[String]) {
    let Ok(entries) = std::fs::read_dir(records_dir(data)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let pane = name.strip_suffix(".sh").or_else(|| name.strip_suffix(".sh.tmp"));
        if !pane.is_some_and(|p| open.iter().any(|o| o == p)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pane_id_names_a_file_only_when_it_is_a_plain_id() {
        let data = Path::new("/data");
        assert_eq!(record_path(data, "p12"), Some(PathBuf::from("/data/terminal-env/p12.sh")));
        assert_eq!(record_path(data, "../p1"), None);
        assert_eq!(record_path(data, "a/b"), None);
        assert_eq!(record_path(data, ""), None);
    }

    #[test]
    fn only_zsh_and_bash_get_the_hook() {
        assert_eq!(shell_kind("/bin/zsh"), Shell::Zsh);
        assert_eq!(shell_kind("/opt/homebrew/bin/bash"), Shell::Bash);
        assert_eq!(shell_kind("/opt/homebrew/bin/fish"), Shell::Other);
        assert_eq!(shell_kind("powershell.exe"), Shell::Other);
    }

    #[test]
    fn pruning_keeps_the_records_of_open_panes_only() {
        let data = std::env::temp_dir().join(format!("osd-term-env-{}", std::process::id()));
        let records = records_dir(&data);
        std::fs::create_dir_all(&records).unwrap();
        for f in ["p1.sh", "p2.sh", "p2.sh.tmp", "p3.sh.tmp", "stray"] {
            std::fs::write(records.join(f), "").unwrap();
        }
        prune_in(&data, &["p2".to_string()]);
        let mut left: Vec<_> = std::fs::read_dir(&records)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["p2.sh", "p2.sh.tmp"]);
        let _ = std::fs::remove_dir_all(&data);
    }
}
