//! Explicit, versioned transactional ledger. See docs/TECHNICAL_DESIGN.md.
use crate::{provenance::ProvenanceRecord, runs::RunRecord};
use rusqlite::{params, Connection, OpenFlags};
use serde::{de::DeserializeOwned, Serialize};
use std::io::{Read, Write};
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
fn parse<T: DeserializeOwned>(name: &str, bytes: Option<&[u8]>) -> Result<Vec<T>, String> {
    let bytes = bytes.unwrap_or_default();
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(err(format!("{name}: unterminated line {}; repair required", bytes.iter().filter(|&&b| b == b'\n').count() + 1)));
    }
    let text = std::str::from_utf8(bytes).map_err(|e| err(format!("{name}: invalid UTF-8: {e}")))?;
    text.lines()
        .enumerate()
        .map(|(index, line)| serde_json::from_str(line).map_err(|e| err(format!("{name}: line {}: {e}", index + 1))) )
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
        if !source_matches(&conn, root, name)? {
            return Err(err(
                "legacy source changed after activation; operator review required",
            ));
        }
    }
    Ok(conn)
}

fn source_matches(conn: &Connection, root: &Path, name: &str) -> Result<bool, String> {
    let stored_len: Option<i64> = conn
        .query_row(
            "SELECT length(bytes) FROM sources WHERE name=?1",
            [name],
            |r| r.get(0),
        )
        .map_err(err)?;
    let path = root.join(".openscience").join(name);
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(stored_len.is_none()),
        Err(e) => return Err(err(e)),
    };
    let Some(len) = stored_len else {
        return Ok(false);
    };
    if len < 0 || file.metadata().map_err(err)?.len() != len as u64 {
        return Ok(false);
    }
    let mut offset = 0_i64;
    let mut buffer = [0_u8; 64 * 1024];
    while offset < len {
        let size = ((len - offset) as usize).min(buffer.len());
        file.read_exact(&mut buffer[..size]).map_err(err)?;
        let stored: Vec<u8> = conn
            .query_row(
                "SELECT substr(bytes, ?2, ?3) FROM sources WHERE name=?1",
                params![name, offset + 1, size as i64],
                |r| r.get(0),
            )
            .map_err(err)?;
        if stored != buffer[..size] {
            return Ok(false);
        }
        offset += size as i64;
    }
    Ok(file.read(&mut buffer[..1]).map_err(err)? == 0)
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
    let _guard = crate::ledger::lock_ledger(root)?;
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
    let runs: Vec<RunRecord> = parse(SOURCES[0], originals[0].as_deref())?;
    let provenance: Vec<ProvenanceRecord> = parse(SOURCES[1], originals[1].as_deref())?;
    let mut ids = std::collections::HashSet::new();
    let output_links: std::collections::HashSet<(&str, &str)> = provenance
        .iter()
        .filter_map(|p| {
            (p.tool == "run")
                .then(|| p.run_id.as_deref().map(|id| (id, p.path.as_str())))
                .flatten()
        })
        .collect();
    let run_outputs: std::collections::HashSet<(&str, &str)> = runs
        .iter()
        .filter(|run| run.status == "ok")
        .flat_map(|run| {
            run.outputs
                .iter()
                .map(move |output| (run.run_id.as_str(), output.path.as_str()))
        })
        .collect();
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
                if !output_links.contains(&(run.run_id.as_str(), output.path.as_str())) {
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
            && !p
                .run_id
                .as_deref()
                .is_some_and(|id| run_outputs.contains(&(id, p.path.as_str())))
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

/// Export a consistent local snapshot for an offline rollback. The destination
/// must be a new directory outside the workspace; a completion marker is
/// written only after both JSONL files have been flushed and synced. This does
/// not change the active ledger or remove its database.
pub fn export_v1(root: &Path, destination: &Path) -> Result<ExportSummary, String> {
    let root = root.canonicalize().map_err(err)?;
    let parent = destination
        .parent()
        .ok_or_else(|| err("export destination needs a parent directory"))?
        .canonicalize()
        .map_err(err)?;
    if parent.starts_with(&root) {
        return Err(err("export destination must be outside the workspace"));
    }
    let _guard = crate::ledger::lock_ledger(&root)?;
    let mut conn = connect(&root)?;
    let tx = conn.transaction().map_err(err)?;
    let mut summary = ExportSummary {
        format: "ledger-v1",
        runs: 0,
        provenance: 0,
    };
    std::fs::create_dir(destination).map_err(err)?;
    for (name, table) in SOURCES.into_iter().zip(["runs", "provenance"]) {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination.join(name))
            .map_err(err)?;
        let mut imported = 0_i64;
        match std::fs::File::open(root.join(".openscience").join(name)) {
            Ok(mut original) => {
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let size = original.read(&mut buffer).map_err(err)?;
                    if size == 0 {
                        break;
                    }
                    imported += buffer[..size].iter().filter(|&&byte| byte == b'\n').count() as i64;
                    file.write_all(&buffer[..size]).map_err(err)?;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
        let total: i64 = tx
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(err)?;
        if total < imported {
            return Err(err("ledger has fewer rows than its imported source"));
        }
        let mut stmt = tx
            .prepare(&format!(
                "SELECT json FROM {table} ORDER BY rowid LIMIT -1 OFFSET ?1"
            ))
            .map_err(err)?;
        let appended = stmt
            .query_map([imported], |r| r.get::<_, String>(0))
            .map_err(err)?;
        for row in appended {
            let row = row.map_err(err)?;
            if table == "runs" {
                serde_json::from_str::<RunRecord>(&row).map_err(err)?;
            } else {
                serde_json::from_str::<ProvenanceRecord>(&row).map_err(err)?;
            }
            file.write_all(row.as_bytes()).map_err(err)?;
            file.write_all(b"\n").map_err(err)?;
        }
        file.sync_all().map_err(err)?;
        if table == "runs" {
            summary.runs = total as u64;
        } else {
            summary.provenance = total as u64;
        }
    }
    for name in SOURCES {
        if !source_matches(&tx, &root, name)? {
            return Err(err(
                "legacy source changed during export; discard incomplete export",
            ));
        }
    }
    tx.commit().map_err(err)?;
    sync_export_dir(destination)?;
    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination.join("complete.json"))
        .map_err(err)?;
    marker
        .write_all(serde_json::to_string(&summary).map_err(err)?.as_bytes())
        .map_err(err)?;
    marker.sync_all().map_err(err)?;
    sync_export_dir(destination)?;
    sync_export_dir(&parent)?;
    Ok(summary)
}

#[cfg(unix)]
fn sync_export_dir(path: &Path) -> Result<(), String> {
    std::fs::File::open(path)
        .map_err(err)?
        .sync_all()
        .map_err(err)
}

#[cfg(not(unix))]
fn sync_export_dir(_path: &Path) -> Result<(), String> {
    // The exported files are synced, but directory entry durability on Windows
    // needs a platform-specific handle and remains outside this contract.
    Ok(())
}

#[derive(Serialize)]
pub struct ExportSummary {
    pub format: &'static str,
    pub runs: u64,
    pub provenance: u64,
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
    let existing: Vec<ProvenanceRecord> = rows(&tx, "provenance")?;
    let mut latest_version = std::collections::HashMap::<String, u32>::new();
    let mut linked = std::collections::HashSet::<(String, String)>::new();
    for record in &existing {
        latest_version
            .entry(record.path.clone())
            .and_modify(|version| *version = (*version).max(record.version))
            .or_insert(record.version);
        if let Some(run_id) = &record.run_id {
            linked.insert((record.path.clone(), run_id.clone()));
        }
    }
    if !rows::<RunRecord>(&tx, "runs")?
        .iter()
        .any(|r| r.run_id == run.run_id)
    {
        insert(&tx, "runs", run)?;
    }
    if run.status == "ok" {
        for output in &run.outputs {
            let path = crate::provenance::normalize_rel(root, &output.path)?;
            if linked.contains(&(path.clone(), run.run_id.clone())) {
                continue;
            }
            let version = latest_version
                .get(&path)
                .copied()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| err("version overflow"))?;
            let p = ProvenanceRecord {
                path: path.clone(),
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
            latest_version.insert(path.clone(), version);
            linked.insert((path, run.run_id.clone()));
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
    fn imports_many_linked_runs_without_changing_source_bytes() {
        let root = root("many-links");
        let dir = root.join(".openscience");
        std::fs::create_dir_all(&dir).unwrap();
        let count = std::env::var("OSD_LEDGER_IMPORT_ROWS")
            .map(|value| value.parse::<usize>().expect("positive row count"))
            .unwrap_or(1_000);
        let mut run_lines = String::new();
        let mut provenance_lines = String::new();
        for i in 0..count {
            let mut run = sample();
            run.run_id = format!("run-{i}");
            run.outputs = vec![crate::runs::RunArtifact {
                path: format!("output-{i}.csv"),
                hash: None,
                size: 1,
            }];
            run_lines.push_str(&serde_json::to_string(&run).unwrap());
            run_lines.push('\n');
            let link = ProvenanceRecord {
                path: run.outputs[0].path.clone(),
                version: 1,
                ts: run.ts,
                tool: "run".into(),
                session_id: None,
                model: None,
                content: None,
                diff: None,
                log: None,
                env: None,
                run_id: Some(run.run_id),
                call_id: None,
            };
            provenance_lines.push_str(&serde_json::to_string(&link).unwrap());
            provenance_lines.push('\n');
        }
        std::fs::write(dir.join("runs.jsonl"), &run_lines).unwrap();
        std::fs::write(dir.join("provenance.jsonl"), &provenance_lines).unwrap();
        let start = std::time::Instant::now();
        migrate_v1(&root).unwrap();
        if std::env::var_os("OSD_LEDGER_IMPORT_ROWS").is_some() {
            eprintln!("imported {count} linked runs in {:?}", start.elapsed());
        }
        let mut new_run = sample();
        new_run.run_id = "after-import".into();
        let _guard = crate::ledger::lock_ledger(&root).unwrap();
        let append_start = std::time::Instant::now();
        commit_run(&root, &new_run).unwrap();
        if std::env::var_os("OSD_LEDGER_IMPORT_ROWS").is_some() {
            eprintln!(
                "committed one run after {count} rows in {:?}",
                append_start.elapsed()
            );
        }
        assert_eq!(runs(&root).unwrap().len(), count + 1);
        assert_eq!(provenance(&root).unwrap().len(), count + 2);
        assert_eq!(
            std::fs::read(dir.join("runs.jsonl")).unwrap(),
            run_lines.as_bytes()
        );
        assert_eq!(
            std::fs::read(dir.join("provenance.jsonl")).unwrap(),
            provenance_lines.as_bytes()
        );
        drop(_guard);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn export_keeps_original_lines_and_includes_committed_rows() {
        let root = root("export");
        record(&root, 1000);
        crate::provenance::append_record(
            &root,
            "original.txt",
            "write",
            None,
            None,
            Some("before".into()),
            None,
            None,
            None,
            None,
            Some("original-call".into()),
        )
        .unwrap();
        let originals = SOURCES.map(|name| source(&root, name).unwrap().unwrap());
        migrate_v1(&root).unwrap();
        record(&root, 2000);
        crate::provenance::append_record(
            &root,
            "later.txt",
            "write",
            None,
            None,
            Some("after".into()),
            None,
            None,
            None,
            None,
            Some("later-call".into()),
        )
        .unwrap();
        let destination = root.with_extension("snapshot");
        let summary = export_v1(&root, &destination).unwrap();
        assert_eq!((summary.runs, summary.provenance), (2, 2));
        for (name, original) in SOURCES.into_iter().zip(originals) {
            let exported = std::fs::read(destination.join(name)).unwrap();
            assert!(exported.starts_with(&original));
            assert_eq!(exported.iter().filter(|&&b| b == b'\n').count(), 2);
            if name == "runs.jsonl" {
                assert_eq!(parse::<RunRecord>("runs.jsonl", Some(&exported)).unwrap().len(), 2);
            } else {
                assert_eq!(parse::<ProvenanceRecord>("provenance.jsonl", Some(&exported)).unwrap().len(), 2);
            }
            assert_eq!(source(&root, name).unwrap().unwrap(), original);
        }
        assert!(destination.join("complete.json").is_file());
        let rollback_copy = root.with_extension("rollback-copy");
        std::fs::create_dir_all(rollback_copy.join(".openscience")).unwrap();
        for name in SOURCES {
            std::fs::copy(
                destination.join(name),
                rollback_copy.join(".openscience").join(name),
            )
            .unwrap();
        }
        assert_eq!(
            crate::runs::read_runs_checked(&rollback_copy)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            crate::provenance::versions_for(&rollback_copy, "later.txt")
                .unwrap()
                .len(),
            1
        );
        std::fs::remove_dir_all(rollback_copy).unwrap();
        std::fs::remove_dir_all(destination).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_export_never_writes_completion_marker() {
        let root = root("export-incomplete");
        migrate_v1(&root).unwrap();
        let conn = Connection::open(db_path(&root)).unwrap();
        conn.execute_batch("DROP TABLE provenance").unwrap();
        drop(conn);
        let destination = root.with_extension("incomplete");
        assert!(export_v1(&root, &destination).is_err());
        assert!(destination.is_dir());
        assert!(!destination.join("complete.json").exists());
        std::fs::remove_dir_all(destination).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_committed_row_cannot_complete_export() {
        let root = root("export-malformed");
        migrate_v1(&root).unwrap();
        let conn = Connection::open(db_path(&root)).unwrap();
        conn.execute("INSERT INTO runs(json) VALUES('not-json')", [])
            .unwrap();
        drop(conn);
        let destination = root.with_extension("malformed-snapshot");
        assert!(export_v1(&root, &destination).is_err());
        assert!(!destination.join("complete.json").exists());
        std::fs::remove_dir_all(destination).unwrap();
        std::fs::remove_dir_all(root).unwrap();
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
        drop(conn);
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
    fn sqlite_insert_failure_rolls_back_public_run_and_links() {
        let root = root("sql-failure");
        migrate_v1(&root).unwrap();
        std::fs::write(root.join("one.csv"), b"one").unwrap();
        std::fs::write(root.join("two.csv"), b"two").unwrap();
        let conn = Connection::open(db_path(&root)).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_second_link BEFORE INSERT ON provenance
             WHEN NEW.json LIKE '%two.csv%'
             BEGIN SELECT RAISE(FAIL, 'injected second link failure'); END;",
        )
        .unwrap();
        drop(conn);
        let end = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 1_000;
        let record = || {
            crate::runs::record_run_inner(
                &root,
                "echo outputs",
                None,
                Some(1),
                Some(end),
                "ok",
                None,
                None,
                None,
                None,
            )
        };
        let error = match record() {
            Ok(_) => panic!("injected insert failure must reject the whole run"),
            Err(error) => error,
        };
        assert!(error.contains("injected second link failure"));
        assert!(runs(&root).unwrap().is_empty());
        assert!(provenance(&root).unwrap().is_empty());
        let conn = Connection::open(db_path(&root)).unwrap();
        conn.execute_batch("DROP TRIGGER reject_second_link")
            .unwrap();
        drop(conn);
        let saved = record().unwrap();
        assert_eq!(saved.outputs.len(), 2);
        assert_eq!(runs(&root).unwrap().len(), 1);
        assert_eq!(provenance(&root).unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preexisting_index_transitions_to_committed_runs_and_remote_log() {
        let root = root("index-transition");
        record(&root, 1_000);
        let conn = crate::runs_index::open_index(&root).unwrap();
        crate::runs_index::sync_index(&conn, &root).unwrap();
        assert_eq!(
            crate::runs_index::query_runs(&conn, &Default::default())
                .unwrap()
                .total,
            1
        );
        migrate_v1(&root).unwrap();
        record(&root, 2_000);
        let remote = serde_json::json!({
            "runId": "remote-test", "ts": 3, "command": "remote",
            "status": "ok", "outputs": []
        });
        std::fs::write(
            root.join(".openscience/remote-runs.jsonl"),
            format!("{remote}\n"),
        )
        .unwrap();
        for _ in 0..2 {
            crate::runs_index::sync_index(&conn, &root).unwrap();
            assert_eq!(
                crate::runs_index::query_runs(&conn, &Default::default())
                    .unwrap()
                    .total,
                3
            );
        }
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrated_writers_in_separate_processes_keep_one_run_and_contiguous_versions() {
        use std::time::{Duration, Instant};

        let root = root("process-writers");
        std::fs::write(root.join("output.csv"), b"value\n1\n").unwrap();
        migrate_v1(&root).unwrap();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let guard = crate::ledger::lock_ledger(&root).unwrap();
        let mut children: Vec<_> = (0..2)
            .map(|i| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .arg("--exact")
                    .arg("runs::tests::child_records_same_run_under_workspace_lock")
                    .env("OSD_RUN_LEDGER_TEST_ROOT", &root)
                    .env("OSD_RUN_LEDGER_TEST_CHILD", i.to_string())
                    .env("OSD_RUN_LEDGER_TEST_NOW", now_ms.to_string())
                    .spawn()
                    .unwrap()
            })
            .collect();
        children.push(
            std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("provenance::tests::child_append_waits_for_workspace_lock")
                .env("OSD_LEDGER_TEST_ROOT", &root)
                .env("OSD_LEDGER_TEST_PATH", "output.csv")
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !(root.join(".openscience/child-0-ready").exists()
            && root.join(".openscience/child-1-ready").exists()
            && root.join(".openscience/child-ready").exists())
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(guard);
        for child in &mut children {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("migrated writer did not finish");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let runs = runs(&root).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].outputs.len(), 1);
        assert_eq!(runs[0].outputs[0].path, "output.csv");
        let mut versions = crate::provenance::versions_for(&root, "output.csv").unwrap();
        versions.sort_by_key(|record| record.version);
        assert_eq!(versions.len(), 2);
        assert_eq!((versions[0].version, versions[1].version), (1, 2));
        assert!(versions.iter().any(|record| record.tool == "write"));
        assert!(versions.iter().any(|record| record.tool == "run"));
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
    fn truncated_source_names_file_and_line_without_activation() {
        let root = root("truncated-source");
        let dir = root.join(".openscience");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("runs.jsonl");
        let bytes = b"{\"runId\":\"first\"}\n{\"runId\":\"torn\"";
        std::fs::write(&file, bytes).unwrap();
        let error = migrate_v1(&root).unwrap_err();
        assert!(error.contains("runs.jsonl: unterminated line 2"), "{error}");
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
        assert!(!enabled(&root));
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
                .args(["--exact", "ledger_v1::tests::crash_child", "--nocapture"])
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
