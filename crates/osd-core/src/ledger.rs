// The workspace ledgers — <workspace>/.openscience/{runs,provenance}.jsonl —
// are shared by the desktop, the gateway and `osd server`, which can be
// separate processes. One advisory file lock serializes every read-decide-
// append sequence across them (run deduplication, version numbering).
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Held while reading and appending the ledgers; dropping it unlocks.
pub(crate) struct LedgerGuard {
    _file: File,
}

pub(crate) fn lock_ledger(root: &Path) -> Result<LedgerGuard, String> {
    let dir = root.join(".openscience");
    std::fs::create_dir_all(&dir).map_err(|e| format!("ledger dir failed: {e}"))?;
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("ledger.lock"))
        .map_err(|e| format!("ledger lock open failed: {e}"))?;
    file.lock().map_err(|e| format!("ledger lock failed: {e}"))?;
    Ok(LedgerGuard { _file: file })
}

/// Append newline-terminated JSONL `bytes`. A tail left unterminated by a crash
/// is closed with a newline first, so the new record starts its own line and
/// the readers (which skip unparsable lines) lose at most the torn record.
pub(crate) fn append_jsonl(_guard: &LedgerGuard, file: &Path, bytes: &[u8], kind: &str) -> Result<(), String> {
    let mut f = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(file)
        .map_err(|e| format!("{kind} open failed: {e}"))?;
    let mut buf = Vec::with_capacity(bytes.len() + 1);
    if !ends_with_newline(&mut f).map_err(|e| format!("{kind} read failed: {e}"))? {
        buf.push(b'\n');
    }
    buf.extend_from_slice(bytes);
    f.write_all(&buf).map_err(|e| format!("{kind} write failed: {e}"))
}

/// True for an empty file too: there is no tail to close.
fn ends_with_newline(f: &mut File) -> std::io::Result<bool> {
    if f.metadata()?.len() == 0 {
        return Ok(true);
    }
    f.seek(SeekFrom::End(-1))?;
    let mut last = [0];
    f.read_exact(&mut last)?;
    Ok(last[0] == b'\n')
}

/// Cross-process tests run a child copy of the test binary; these wait on it.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    const TIMEOUT: Duration = Duration::from_secs(30);

    /// Run one `#[test]` of this binary in a separate process with `env` set.
    pub(crate) fn spawn_test(name: &str, env: &[(&str, &str)]) -> Child {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", name, "--quiet"]).envs(env.iter().copied());
        cmd.spawn().unwrap()
    }

    pub(crate) fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + TIMEOUT;
        while !path.exists() {
            assert!(Instant::now() < deadline, "{} never appeared", path.display());
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(crate) fn assert_exits_ok(child: &mut Child) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "child failed: {status}");
                return;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                panic!("child did not finish");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{append_jsonl, lock_ledger};

    #[test]
    fn append_closes_a_torn_tail_before_writing() {
        let root = std::env::temp_dir().join(format!("ai4s-ledger-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let guard = lock_ledger(&root).unwrap();
        let file = root.join(".openscience/x.jsonl");

        append_jsonl(&guard, &file, b"{\"a\":1}\n", "x").unwrap();
        append_jsonl(&guard, &file, b"{\"a\":2}\n", "x").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"{\"a\":1}\n{\"a\":2}\n");

        std::fs::write(&file, b"{\"a\":1}\n{\"a\":").unwrap();
        append_jsonl(&guard, &file, b"{\"a\":3}\n", "x").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"{\"a\":1}\n{\"a\":\n{\"a\":3}\n");
        drop(guard);
        let _ = std::fs::remove_dir_all(root);
    }
}
