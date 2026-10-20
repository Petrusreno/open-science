//! Explicit, versioned transactional ledger. See docs/TECHNICAL_DESIGN.md.
use crate::{provenance::ProvenanceRecord, runs::RunRecord};
use rusqlite::{params, Connection, OpenFlags};
use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};

const SOURCES: [&str; 2] = ["runs.jsonl", "provenance.jsonl"];
fn db_path(root: &Path) -> PathBuf {
    root.join(".openscience/ledger-v1.sqlite")
}
pub(crate) fn enabled(root: &Path) -> bool {
    // An unreadable location is uncertain, not permission to fall back to JSONL.
    !matches!(db_path(root).symlink_metadata(), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}
fn err(e: impl std::fmt::Display) -> String {
    format!("transactional ledger: {e}")
}
fn source(root: &Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(root.join(".openscience").join(name)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn parse<T: DeserializeOwned>(bytes: Option<&[u8]>) -> Result<Vec<T>, String> {
    let bytes = bytes.unwrap_or_default();
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(err("unterminated source; repair required"));
    }
    let text = std::str::from_utf8(bytes).map_err(err)?;
    text.lines()
        .map(|line| serde_json::from_str(line).map_err(err))
        .collect()
}
fn connect(root: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(db_path(root), OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(err)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(err)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(err)?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)?;
    if version != 1 {
        return Err(err(
            "migration incomplete or unknown version; explicit recovery required",
        ));
    }
    for name in SOURCES {
        let original: Option<Vec<u8>> = conn
            .query_row("SELECT bytes FROM sources WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .map_err(err)?;
        if source(root, name)? != original {
            return Err(err(
                "legacy source changed after activation; operator review required",
            ));
        }
    }
    Ok(conn)
}
fn rows<T: DeserializeOwned>(conn: &Connection, table: &str) -> Result<Vec<T>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT json FROM {table} ORDER BY rowid"))
        .map_err(err)?;
    let strings = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    strings
        .map(|s| serde_json::from_str(&s.map_err(err)?).map_err(err))
        .collect()
}
fn insert<T: Serialize>(conn: &Connection, table: &str, value: &T) -> Result<(), String> {
    conn.execute(
        &format!("INSERT INTO {table}(json) VALUES(?1)"),
        [serde_json::to_string(value).map_err(err)?],
    )
    .map_err(err)?;
    Ok(())
}

/// Opt in ONLY after staging consumers that require live JSONL updates. Original
/// JSONL bytes remain untouched, but freeze after activation. No implicit opt-in.
/// An interrupted SQLite transaction rolls back; repeat this API to retry import.
pub fn migrate_v1(root: &Path) -> Result<(), String> {
    let _guard = crate::provenance::lock_ledger(root)?;
    if enabled(root) {
        let conn = Connection::open_with_flags(db_path(root), OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(err)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        if version == 1 {
            return connect(root).map(|_| ());
        }
        // Only an empty, rolled-back database is a resumable migration.
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        if version != 0 || tables != 0 {
            return Err(err("uncertain migration state; operator review required"));
        }
    }
    let originals = SOURCES
        .map(|name| source(root, name))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let runs: Vec<RunRecord> = parse(originals[0].as_deref())?;
    let provenance: Vec<ProvenanceRecord> = parse(originals[1].as_deref())?;
    let mut ids = std::collections::HashSet::new();
    for run in &runs {
        if run.run_id.is_empty() || !matches!(run.status.as_str(), "ok" | "failed") {
            return Err(err("invalid source run identity or status"));
        }
        for artifact in run.code.iter().chain(&run.outputs) {
            if crate::provenance::normalize_rel(root, &artifact.path)? != artifact.path {
                return Err(err("noncanonical source artifact path"));
            }
        }
        if !ids.insert(&run.run_id) {
            return Err(err("duplicate source run id"));
        }
        if run.status == "ok" {
            for output in &run.outputs {
                if !provenance.iter().any(|p| {
                    p.tool == "run"
                        && p.path == output.path
                        && p.run_id.as_deref() == Some(&run.run_id)
                }) {
                    return Err(err(
                        "source run has incomplete output provenance; repair before migration",
                    ));
                }
            }
        }
    }
    let mut versions = std::collections::HashSet::new();
    for p in &provenance {
        if crate::provenance::normalize_rel(root, &p.path)? != p.path {
            return Err(err("noncanonical source provenance path"));
        }
        if p.tool == "run"
            && !runs.iter().any(|run| {
                p.run_id.as_deref() == Some(&run.run_id)
                    && run.status == "ok"
                    && run.outputs.iter().any(|output| output.path == p.path)
            })
        {
            return Err(err("orphan or inconsistent source run link"));
        }
        if p.version == 0 || !versions.insert((&p.path, p.version)) {
            return Err(err("invalid or duplicate source provenance version"));
        }
    }
    let mut conn = Connection::open(db_path(root)).map_err(err)?;
    conn.pragma_update(None, "journal_mode", "DELETE")
        .map_err(err)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute_batch("CREATE TABLE sources(name TEXT PRIMARY KEY, bytes BLOB); CREATE TABLE runs(json TEXT NOT NULL); CREATE TABLE provenance(json TEXT NOT NULL);").map_err(err)?;
    for (name, bytes) in SOURCES.iter().zip(originals) {
        tx.execute("INSERT INTO sources VALUES(?1,?2)", params![name, bytes])
            .map_err(err)?;
    }
    for run in &runs {
        insert(&tx, "runs", run)?;
    }
    for p in &provenance {
        insert(&tx, "provenance", p)?;
    }
    tx.pragma_update(None, "user_version", 1).map_err(err)?;
    tx.commit().map_err(err)
}

pub(crate) fn runs(root: &Path) -> Result<Vec<RunRecord>, String> {
    rows(&connect(root)?, "runs")
}
pub(crate) fn provenance(root: &Path) -> Result<Vec<ProvenanceRecord>, String> {
    rows(&connect(root)?, "provenance")
}
pub(crate) fn append(root: &Path, p: &ProvenanceRecord) -> Result<(), String> {
    insert(&connect(root)?, "provenance", p)
}

/// Caller holds the workspace ledger lock. The run and all its links become
/// visible at the single SQLite commit; rollback leaves neither new record.
pub(crate) fn commit_run(root: &Path, run: &RunRecord) -> Result<(), String> {
    let mut conn = connect(root)?;
    let tx = conn.transaction().map_err(err)?;
    let mut existing: Vec<ProvenanceRecord> = rows(&tx, "provenance")?;
    if !rows::<RunRecord>(&tx, "runs")?
        .iter()
        .any(|r| r.run_id == run.run_id)
    {
        insert(&tx, "runs", run)?;
    }
    if run.status == "ok" {
        for output in &run.outputs {
            let path = crate::provenance::normalize_rel(root, &output.path)?;
            if existing
                .iter()
                .any(|p| p.path == path && p.run_id.as_deref() == Some(&run.run_id))
            {
                continue;
            }
            let version = existing
                .iter()
                .filter(|p| p.path == path)
                .map(|p| p.version)
                .max()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| err("version overflow"))?;
            let p = ProvenanceRecord {
                path,
                version,
                ts: run.ts,
                tool: "run".into(),
                session_id: run.session_id.clone(),
                model: run.model.clone(),
                content: None,
                diff: None,
                log: Some(run.command.clone()),
                env: run.env.clone(),
                run_id: Some(run.run_id.clone()),
                call_id: None,
            };
            insert(&tx, "provenance", &p)?;
            existing.push(p);
        }
    }
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "osd-tx-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn record(root: &Path, start: u64) -> RunRecord {
        crate::runs::record_run_inner(
            root,
            "echo test",
            None,
            Some(start),
            None,
            "ok",
            None,
            None,
            None,
            None,
        )
        .unwrap()
    }
    fn sample() -> RunRecord {
        serde_json::from_str(r#"{"runId":"test","ts":42,"command":"test","status":"ok","outputs":[{"path":"one.csv","size":1},{"path":"two.csv","size":1}]}"#).unwrap()
    }
    #[test]
    fn imports_legacy_bytes_and_stages_jsonl_compatibility() {
        let root = root("import");
        record(&root, 1000);
        crate::provenance::append_record(
            &root,
            "authored.py",
            "write",
            None,
            None,
            Some("x".into()),
            None,
            None,
            None,
            None,
            Some("call".into()),
        )
        .unwrap();
        let before = SOURCES.map(|name| source(&root, name).unwrap());
        migrate_v1(&root).unwrap();
        migrate_v1(&root).unwrap();
        assert_eq!(runs(&root).unwrap().len(), 1);
        assert_eq!(
            crate::provenance::versions_for(&root, "authored.py")
                .unwrap()
                .len(),
            1
        );
        record(&root, 2000);
        for _ in 0..2 {
            crate::provenance::append_record(
                &root,
                "authored.py",
                "write",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("second".into()),
            )
            .unwrap();
        }
        assert_eq!(
            crate::provenance::versions_for(&root, "authored.py")
                .unwrap()
                .len(),
            2
        );
        assert_eq!(crate::runs::read_runs_checked(&root).unwrap().len(), 2);
        assert_eq!(SOURCES.map(|name| source(&root, name).unwrap()), before);
        let conn = crate::runs_index::open_index(&root).unwrap();
        crate::runs_index::sync_index(&conn, &root).unwrap();
        assert_eq!(
            crate::runs_index::query_runs(&conn, &Default::default())
                .unwrap()
                .total,
            2
        );
        std::fs::write(root.join(".openscience/runs.jsonl"), b"changed\n").unwrap();
        assert!(crate::runs::read_runs_checked(&root).is_err());
        assert!(crate::provenance::versions_for(&root, "authored.py").is_err());
        assert!(crate::runs_index::sync_index(&conn, &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn run_links_commit_together_retry_and_rollback() {
        let root = root("atomic");
        migrate_v1(&root).unwrap();
        let mut run = sample();
        run.outputs[1].path = "../escape".into();
        assert!(commit_run(&root, &run).is_err());
        assert!(runs(&root).unwrap().is_empty());
        assert!(provenance(&root).unwrap().is_empty());
        assert!(crate::provenance::append_record(
            &root,
            "one.csv",
            "run",
            None,
            None,
            None,
            None,
            None,
            None,
            Some("test".into()),
            None
        )
        .is_err());
        assert!(crate::provenance::link_run_outputs(
            &root,
            &["one.csv".into()],
            None,
            None,
            None,
            None,
            "test".into()
        )
        .is_err());
        run.outputs[1].path = "two.csv".into();
        commit_run(&root, &run).unwrap();
        commit_run(&root, &run).unwrap();
        assert_eq!(runs(&root).unwrap().len(), 1);
        for path in ["one.csv", "two.csv"] {
            assert_eq!(
                crate::provenance::versions_for(&root, path).unwrap().len(),
                1
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn record_api_retries_original_snapshot_and_imports_links() {
        let root = root("record-api");
        std::fs::write(root.join("one.csv"), b"one").unwrap();
        let end = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 1000;
        let run = crate::runs::record_run_inner(
            &root,
            "echo output",
            None,
            Some(1),
            Some(end),
            "ok",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(run.outputs.len(), 1);
        migrate_v1(&root).unwrap();
        std::fs::write(root.join("two.csv"), b"later").unwrap();
        let retry = crate::runs::record_run_inner(
            &root,
            "echo output",
            None,
            Some(1),
            Some(end + 1000),
            "ok",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(retry.outputs, run.outputs);
        assert_eq!(runs(&root).unwrap().len(), 1);
        assert_eq!(provenance(&root).unwrap().len(), 1);
        let new = crate::runs::record_run_inner(
            &root,
            "echo new",
            None,
            Some(2),
            Some(end + 1000),
            "ok",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(new.outputs.len(), 2);
        assert_eq!(runs(&root).unwrap().len(), 2);
        assert_eq!(provenance(&root).unwrap().len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn source_corruption_and_uncertain_state_fail_closed() {
        let root = root("corrupt");
        std::fs::create_dir_all(root.join(".openscience")).unwrap();
        for bytes in [b"not json\n".as_slice(), b"{}", b"\xff\n", b"\n"] {
            std::fs::write(root.join(".openscience/runs.jsonl"), bytes).unwrap();
            assert!(migrate_v1(&root).is_err());
            assert!(!enabled(&root));
        }
        std::fs::remove_file(root.join(".openscience/runs.jsonl")).unwrap();
        let conn = Connection::open(db_path(&root)).unwrap();
        conn.execute_batch("CREATE TABLE unexpected(x)").unwrap();
        drop(conn);
        assert!(migrate_v1(&root).is_err());
        assert!(runs(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_incomplete_legacy_run_links() {
        let root = root("incomplete");
        std::fs::create_dir_all(root.join(".openscience")).unwrap();
        std::fs::write(
            root.join(".openscience/runs.jsonl"),
            format!("{}\n", serde_json::to_string(&sample()).unwrap()),
        )
        .unwrap();
        assert!(migrate_v1(&root).is_err());
        assert!(!enabled(&root));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_child() {
        let Ok(path) = std::env::var("OSD_TX_CRASH_ROOT") else {
            return;
        };
        let root = Path::new(&path);
        let conn = Connection::open(db_path(root)).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        if std::env::var("OSD_TX_CRASH_MODE").unwrap() == "migration" {
            conn.execute_batch(
                "CREATE TABLE sources(name TEXT PRIMARY KEY, bytes BLOB); PRAGMA user_version=1;",
            )
            .unwrap();
        } else {
            insert(&conn, "runs", &sample()).unwrap();
        }
        std::fs::write(root.join("ready"), b"ready").unwrap();
        while !root.join("exit").exists() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        std::process::exit(73); // no rollback/drop: recover the journal on reopen
    }
    #[test]
    fn process_crash_recovers_migration_and_uncommitted_run() {
        for mode in ["migration", "run"] {
            let root = root(mode);
            std::fs::create_dir_all(root.join(".openscience")).unwrap();
            if mode == "run" {
                migrate_v1(&root).unwrap();
            }
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "ledger::tests::crash_child", "--nocapture"])
                .env("OSD_TX_CRASH_ROOT", &root)
                .env("OSD_TX_CRASH_MODE", mode)
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !root.join("ready").exists() {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    panic!("child timeout");
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            if mode == "run" {
                assert!(runs(&root).unwrap().is_empty());
                assert!(provenance(&root).unwrap().is_empty());
            } else {
                assert!(runs(&root).is_err());
            }
            std::fs::write(root.join("exit"), b"exit").unwrap();
            assert_eq!(child.wait().unwrap().code(), Some(73));
            if mode == "migration" {
                assert!(runs(&root).is_err());
                migrate_v1(&root).unwrap();
            }
            assert!(runs(&root).unwrap().is_empty());
            assert!(provenance(&root).unwrap().is_empty());
            commit_run(&root, &sample()).unwrap();
            assert_eq!(provenance(&root).unwrap().len(), 2);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
