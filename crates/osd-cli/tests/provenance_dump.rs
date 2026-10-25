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
fn migrate_requires_apply_and_legacy_source() {
    let root = workspace();
    let invoke = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_osd"))
            .args(["ledger", "migrate", "--workspace"])
            .arg(&root)
            .args(extra)
            .output()
            .unwrap()
    };
    assert!(!invoke(&[]).status.success());
    assert!(!invoke(&["--apply"]).status.success());
    assert!(!root.join(".openscience/ledger-v1.sqlite").exists());
    std::fs::create_dir_all(root.join(".openscience")).unwrap();
    std::fs::write(root.join(".openscience/runs.jsonl"), b"").unwrap();
    let result = invoke(&["--apply", "--json"]);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert!(root.join(".openscience/ledger-v1.sqlite").is_file());
    assert!(!invoke(&["--apply", "--unexpected", "x"]).status.success());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn dump_reads_committed_migrated_provenance_and_fails_closed() {
    let root = workspace();
    osd_core::ledger_v1::migrate_v1(&root).unwrap();
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
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
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

#[test]
fn export_writes_a_complete_offline_snapshot_without_changing_workspace() {
    let root = workspace();
    osd_core::ledger_v1::migrate_v1(&root).unwrap();
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
        Some("call-2".into()),
    )
    .unwrap();
    let output_dir = root.with_extension("export");
    let run = |destination: &std::path::Path| {
        Command::new(env!("CARGO_BIN_EXE_osd"))
            .args(["ledger", "export", "--workspace"])
            .arg(&root)
            .arg("--output")
            .arg(destination)
            .arg("--json")
            .output()
            .unwrap()
    };
    let result = run(&output_dir);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let summary: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(summary["format"], "ledger-v1");
    assert_eq!(summary["runs"], 0);
    assert_eq!(summary["provenance"], 1);
    assert!(output_dir.join("runs.jsonl").is_file());
    assert_eq!(
        std::fs::read_to_string(output_dir.join("provenance.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(output_dir.join("complete.json")).unwrap()
        )
        .unwrap(),
        summary
    );
    assert!(!run(&output_dir).status.success());
    assert!(root.join(".openscience/ledger-v1.sqlite").is_file());
    std::fs::write(root.join(".openscience/provenance.jsonl"), b"changed\n").unwrap();
    let rejected = root.with_extension("rejected-export");
    assert!(!run(&rejected).status.success());
    assert!(!rejected.exists());
    std::fs::remove_dir_all(output_dir).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
