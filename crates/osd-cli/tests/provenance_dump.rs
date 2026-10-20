use std::path::PathBuf;
use std::process::Command;

fn workspace() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "osd-provenance-cli-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn dump_reads_committed_migrated_provenance_and_fails_closed() {
    let root = workspace();
    osd_core::ledger::migrate_v1(&root).unwrap();
    osd_core::provenance::append_record(
        &root,
        "figure.svg",
        "write",
        None,
        None,
        Some("synthetic".into()),
        None,
        None,
        None,
        None,
        Some("call-1".into()),
    )
    .unwrap();

    let run = || {
        Command::new(env!("CARGO_BIN_EXE_osd"))
            .args(["provenance", "dump", "--workspace"])
            .arg(&root)
            .arg("--json")
            .output()
            .unwrap()
    };
    let output = run();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let records: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(records.as_array().unwrap().len(), 1);
    assert_eq!(records[0]["path"], "figure.svg");
    assert_eq!(records[0]["content"], "synthetic");

    std::fs::write(root.join(".openscience/provenance.jsonl"), b"changed\n").unwrap();
    let output = run();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("legacy source changed"));
    std::fs::remove_dir_all(root).unwrap();
}
