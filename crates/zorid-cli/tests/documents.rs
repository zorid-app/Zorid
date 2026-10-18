#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Standalone commands use persisted Rust generations without a desktop or daemon.
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output, Stdio},
};

fn invoke(root: &Path, args: &[&str]) -> Output {
    let local_data = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_zorid"))
        .env("ZORID_LOCAL_DATA_DIR", local_data.path())
        .arg("--vault")
        .arg(root)
        .args(args)
        .env_remove("DISPLAY")
        .env_remove("ZORID_IPC_ENDPOINT")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["ok"], true);
    value["result"].clone()
}
fn failure(output: Output, code: &str, exit: i32) {
    assert_eq!(
        output.status.code(),
        Some(exit),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], code);
}
fn create(root: &Path, id: &str, path: &str, source: &[u8]) {
    let input = tempfile::NamedTempFile::new().unwrap();
    fs::write(input.path(), source).unwrap();
    success(invoke(
        root,
        &[
            "create",
            path,
            "--id",
            id,
            "--operation-id",
            &format!("create-{id}"),
            "--input",
            input.path().to_str().unwrap(),
        ],
    ));
}
fn entry(root: &Path, id: &str) -> Value {
    success(invoke(root, &["read", "--id", id]))["entry"].clone()
}
fn write(root: &Path, id: &str, operation: &str, source: &[u8]) {
    let state = entry(root, id);
    let input = tempfile::NamedTempFile::new().unwrap();
    fs::write(input.path(), source).unwrap();
    success(invoke(
        root,
        &[
            "write",
            "--id",
            id,
            "--expected-revision",
            state["revision"].as_str().unwrap(),
            "--operation-id",
            operation,
            "--input",
            input.path().to_str().unwrap(),
        ],
    ));
}
fn setup() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    success(invoke(dir.path(), &["init"]));
    dir
}
fn build(root: &Path) -> Value {
    let result = success(invoke(root, &["document-index", "build"]));
    assert_eq!(result["buildComplete"], true);
    assert_eq!(result["published"], true);
    result
}
fn paths(result: &Value) -> Vec<String> {
    result["value"]["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["entry"]["path"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn standalone_index_queries_track_changes_moves_deletes_and_rebuilds() {
    let dir = setup();
    let root = dir.path();
    let status = success(invoke(root, &["document-index", "status"]));
    assert_eq!(status["status"]["state"], "uninitialized");
    failure(
        invoke(root, &["indexed-search", "needle"]),
        "index_not_ready",
        4,
    );
    create(root, "z", "Z.md", b"---\nrank: 2\n---\nneedle [[Target]]\n");
    create(root, "a", "A.md", b"---\nrank: 1\n---\nneedle [[Target]]\n");
    create(root, "target", "Target.md", b"# Target\n");
    create(root, "base", "Notes.base", b"filters: file.ext == \"md\"\nviews:\n  - type: table\n    name: All\n    order: [file.path]\n  - type: table\n    name: Target only\n    filters: file.basename == \"Target\"\n    order: [file.path]\n");
    build(root);
    let source_status = success(invoke(root, &["status"]));
    // Query must use committed projection, even when physical bytes differ.
    fs::write(root.join("A.md"), b"external uncommitted text").unwrap();
    let found = success(invoke(root, &["indexed-search", "needle", "--limit", "10"]));
    assert_eq!(paths(&found), ["A.md", "Z.md"]);
    assert_eq!(found["complete"], true);
    assert_eq!(found["consistency"], "indexed_committed_snapshot");
    assert_eq!(
        found["snapshot"]["localStoreId"],
        found["source"]["localStoreId"]
    );
    assert_eq!(success(invoke(root, &["status"])), source_status);
    assert_eq!(
        fs::read(root.join("A.md")).unwrap(),
        b"external uncommitted text"
    );
    // Restore the disposable physical occupant before explicit file commands.
    fs::write(root.join("A.md"), b"---\nrank: 1\n---\nneedle [[Target]]\n").unwrap();
    let links = success(invoke(root, &["backlinks", "--id", "target"]));
    let sources: Vec<_> = links["value"]["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|edge| edge["source"]["path"].as_str().unwrap())
        .collect();
    assert_eq!(sources, ["A.md", "Z.md"]);
    assert_eq!(links["snapshot"], found["snapshot"]);
    let base = success(invoke(
        root,
        &[
            "base-query",
            "--id",
            "base",
            "--view",
            "Target only",
            "--clock-ms",
            "0",
        ],
    ));
    assert_eq!(base["value"]["definition"]["id"], "base");
    assert_eq!(base["value"]["result"]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(base["value"]["result"]["rows"][0]["path"], "Target.md");
    assert_eq!(base["snapshot"], found["snapshot"]);
    let old_snapshot = serde_json::to_string(&found["snapshot"]).unwrap();
    write(root, "z", "edit-z", b"changed text without the literal\n");
    let stale = success(invoke(root, &["indexed-search", "needle"]));
    assert_eq!(paths(&stale), ["A.md", "Z.md"]);
    assert_ne!(
        stale["source"]["watermark"],
        stale["observedIndex"]["observedSourceHead"]
    );
    build(root);
    failure(
        invoke(
            root,
            &[
                "indexed-search",
                "needle",
                "--expected-snapshot",
                &old_snapshot,
            ],
        ),
        "snapshot_expired",
        3,
    );
    let state = entry(root, "a");
    success(invoke(
        root,
        &[
            "move",
            "Moved.md",
            "--id",
            "a",
            "--expected-revision",
            state["revision"].as_str().unwrap(),
            "--operation-id",
            "move-a",
        ],
    ));
    build(root);
    assert_eq!(
        paths(&success(invoke(root, &["indexed-search", "needle"]))),
        ["Moved.md"]
    );
    let before_rebuild = success(invoke(root, &["indexed-search", "needle"]));
    let rebuilt = success(invoke(root, &["document-index", "rebuild"]));
    assert_eq!(rebuilt["complete"], true);
    let after_rebuild = success(invoke(root, &["indexed-search", "needle"]));
    assert_eq!(
        after_rebuild["value"]["hits"],
        before_rebuild["value"]["hits"]
    );
    assert_ne!(after_rebuild["snapshot"], before_rebuild["snapshot"]);
    let state = entry(root, "a");
    success(invoke(
        root,
        &[
            "delete",
            "--id",
            "a",
            "--expected-revision",
            state["revision"].as_str().unwrap(),
            "--operation-id",
            "delete-a",
        ],
    ));
    build(root);
    assert!(paths(&success(invoke(root, &["indexed-search", "needle"]))).is_empty());
    create(root, "new-a", "Moved.md", b"needle recreated\n");
    build(root);
    let recreated = success(invoke(root, &["indexed-search", "needle"]));
    assert_eq!(recreated["value"]["hits"][0]["entry"]["id"], "new-a");
}

#[test]
fn bounded_pages_and_build_resume_report_incomplete_work_explicitly() {
    let dir = setup();
    for n in 0..33 {
        create(
            dir.path(),
            &format!("file-{n}"),
            &format!("{n:02}.txt"),
            b"needle\n",
        );
    }
    let first = success(invoke(
        dir.path(),
        &["document-index", "build", "--max-pumps", "1"],
    ));
    assert_eq!(first["complete"], false);
    assert_eq!(first["published"], false);
    let done = build(dir.path());
    assert_eq!(done["resumed"], true);
    let limited = success(invoke(
        dir.path(),
        &[
            "indexed-search",
            "needle",
            "--limit",
            "100",
            "--max-pages",
            "1",
        ],
    ));
    assert_eq!(limited["value"]["hits"].as_array().unwrap().len(), 32);
    assert_eq!(limited["scanComplete"], false);
    assert_eq!(limited["truncated"], true);
    assert_eq!(limited["complete"], false);
    let full = success(invoke(
        dir.path(),
        &[
            "indexed-search",
            "needle",
            "--limit",
            "100",
            "--max-pages",
            "2",
        ],
    ));
    assert_eq!(full["value"]["hits"].as_array().unwrap().len(), 33);
    assert_eq!(full["complete"], true);
    let hit_limit = success(invoke(
        dir.path(),
        &["indexed-search", "needle", "--limit", "1"],
    ));
    assert_eq!(hit_limit["value"]["hits"].as_array().unwrap().len(), 1);
    assert_eq!(hit_limit["complete"], false);
    assert_eq!(hit_limit["truncated"], true);
}

#[test]
fn exclusions_and_invalid_base_are_explicit_without_source_writes() {
    let dir = setup();
    create(dir.path(), "bad", "Invalid.txt", &[255]);
    create(dir.path(), "base", "Invalid.base", b"views: [\n");
    build(dir.path());
    let before = success(invoke(dir.path(), &["status"]));
    let result = success(invoke(dir.path(), &["indexed-search", "anything"]));
    assert_eq!(result["scanComplete"], true);
    assert_eq!(result["coverageComplete"], false);
    assert_eq!(result["complete"], false);
    assert_eq!(result["truncated"], false);
    failure(
        invoke(
            dir.path(),
            &["base-query", "--id", "base", "--clock-ms", "0"],
        ),
        "base_compile",
        2,
    );
    failure(
        invoke(dir.path(), &["backlinks", "--id", "missing"]),
        "not_found",
        4,
    );
    assert_eq!(success(invoke(dir.path(), &["status"])), before);
    assert_eq!(
        fs::read(dir.path().join("Invalid.base")).unwrap(),
        b"views: [\n"
    );
    assert_eq!(fs::read(dir.path().join("Invalid.txt")).unwrap(), [255]);
}
