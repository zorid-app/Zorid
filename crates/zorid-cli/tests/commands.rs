#![cfg(any(target_os = "macos", target_os = "linux"))]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

fn command(root: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_zorid"));
    cmd.arg("--vault").arg(root).args(args);
    // The CLI must work with no running desktop, IPC or network service.
    cmd.env_remove("DISPLAY").env_remove("ZORID_IPC_ENDPOINT");
    cmd
}
fn invoke(root: &Path, args: &[&str], bytes: Option<&[u8]>) -> Output {
    let mut cmd = command(root, args);
    cmd.stdin(if bytes.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    if let Some(bytes) = bytes {
        child.stdin.take().unwrap().write_all(bytes).unwrap();
    }
    child.wait_with_output().unwrap()
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["ok"], true);
    json["result"].clone()
}
fn failure(output: Output, code: &str, exit: i32) -> Value {
    assert_eq!(output.status.code(), Some(exit));
    assert!(output.stdout.is_empty());
    let json: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["code"], code);
    json
}
fn init(root: &Path) {
    success(invoke(root, &["init"], None));
}
fn create(root: &Path, bytes: &[u8]) -> Value {
    success(invoke(
        root,
        &[
            "create",
            ".unknown.bin",
            "--id",
            "file1",
            "--operation-id",
            "create1",
            "--input",
            "-",
        ],
        Some(bytes),
    ))
}
fn revision(result: &Value) -> &str {
    result["commit"]["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["after"]["id"] == "file1")
        .unwrap()["after"]["revision"]
        .as_str()
        .unwrap()
}

#[test]
fn independent_invocations_preserve_binary_and_exact_retry() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let bytes = [0, 255, 128, 13, 10, 0, 1];
    let created = create(dir.path(), &bytes);
    assert_eq!(created["durable_local_commit"], true);
    assert_eq!(created["synced"], false);
    assert_eq!(created["projection"]["state"], "projected");
    assert_eq!(fs::read(dir.path().join(".unknown.bin")).unwrap(), bytes);
    assert_eq!(create(dir.path(), &bytes)["commit"], created["commit"]);
    let read = success(invoke(dir.path(), &["read", "--id", "file1"], None));
    assert_eq!(
        STANDARD.decode(read["bytes"].as_str().unwrap()).unwrap(),
        bytes
    );
    let raw = invoke(dir.path(), &["read", "--id", "file1", "--raw"], None);
    assert!(raw.status.success());
    assert_eq!(raw.stdout, bytes);
    assert!(raw.stderr.is_empty());
    let status = success(invoke(dir.path(), &["status"], None));
    assert_eq!(status["pending_outbox"], "1");
    assert_eq!(status["pending_projection"], "0");
}

#[test]
fn file_input_write_requires_revision_and_rejects_changed_retry() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let created = create(dir.path(), b"initial");
    let input = tempfile::NamedTempFile::new().unwrap();
    fs::write(input.path(), [255, 0, 10]).unwrap();
    let args = [
        "write",
        "--id",
        "file1",
        "--expected-revision",
        revision(&created),
        "--operation-id",
        "write1",
        "--input",
        input.path().to_str().unwrap(),
    ];
    let written = success(invoke(dir.path(), &args, None));
    assert_eq!(
        success(invoke(dir.path(), &args, None))["commit"],
        written["commit"]
    );
    fs::write(input.path(), b"changed-request").unwrap();
    failure(invoke(dir.path(), &args, None), "idempotency_conflict", 3);
    let stale = [
        "write",
        "--id",
        "file1",
        "--expected-revision",
        revision(&created),
        "--operation-id",
        "write2",
        "--input",
        input.path().to_str().unwrap(),
    ];
    failure(invoke(dir.path(), &stale, None), "revision_conflict", 3);
    assert_eq!(
        fs::read(dir.path().join(".unknown.bin")).unwrap(),
        [255, 0, 10]
    );
    failure(
        invoke(
            dir.path(),
            &[
                "write",
                "--id",
                "file1",
                "--operation-id",
                "missing-rev",
                "--input",
                "-",
            ],
            None,
        ),
        "usage",
        2,
    );
}

#[test]
fn read_commands_never_initialize_and_usage_does_not_echo_values() {
    let dir = tempfile::tempdir().unwrap();
    for cmd in ["list", "status", "recover"] {
        failure(invoke(dir.path(), &[cmd], None), "vault_not_initialized", 4);
        assert!(!dir.path().join(".zorid").exists());
    }
    let output = invoke(dir.path(), &["--token=secret-should-not-be-logged"], None);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-should-not-be-logged"));
    failure(output, "usage", 2);
    for cmd in ["move", "delete", "search", "sync"] {
        failure(invoke(dir.path(), &[cmd], None), "unsupported", 5);
        assert!(!dir.path().join(".zorid").exists());
    }
}

#[test]
fn reads_reject_missing_or_zero_byte_database_without_initializing() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let private = dir.path().join(".zorid");
    fs::create_dir(&private).unwrap();
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
    for args in [&["list"][..], &["status"], &["read", "--id", "missing"]] {
        failure(invoke(dir.path(), args, None), "vault_not_initialized", 4);
        assert!(!private.join("vault.sqlite").exists());
    }
    fs::write(private.join("vault.sqlite"), []).unwrap();
    for args in [&["list"][..], &["status"], &["read", "--id", "missing"]] {
        failure(invoke(dir.path(), args, None), "corrupt_storage", 1);
        assert_eq!(fs::metadata(private.join("vault.sqlite")).unwrap().len(), 0);
        assert!(!private.join("vault.sqlite-wal").exists());
        assert!(!private.join("vault.sqlite-shm").exists());
    }
}

#[test]
fn missing_write_target_is_not_found_without_commit() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    failure(
        invoke(
            dir.path(),
            &[
                "write",
                "--id",
                "missing",
                "--expected-revision",
                "old",
                "--operation-id",
                "write-missing",
                "--input",
                "-",
            ],
            Some(b"new"),
        ),
        "not_found",
        4,
    );
    assert_eq!(
        success(invoke(dir.path(), &["status"], None))["pending_outbox"],
        "0"
    );
}

#[test]
fn external_nested_files_reconcile_and_no_clobber_existing_content() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    fs::create_dir(dir.path().join("nested")).unwrap();
    fs::write(dir.path().join("nested/任意.bin"), [0, 255, 99]).unwrap();
    let report = success(invoke(dir.path(), &["reconcile", "nested/任意.bin"], None));
    assert_eq!(report["complete"], true);
    let list = success(invoke(dir.path(), &["list"], None));
    let entries = list["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let file = entries
        .iter()
        .find(|e| e["path"] == "nested/任意.bin")
        .unwrap();
    let read = success(invoke(
        dir.path(),
        &["read", "--id", file["id"].as_str().unwrap()],
        None,
    ));
    assert_eq!(
        STANDARD.decode(read["bytes"].as_str().unwrap()).unwrap(),
        [0, 255, 99]
    );
    fs::write(dir.path().join(".unknown.bin"), b"external secret").unwrap();
    let rejected = invoke(
        dir.path(),
        &[
            "create",
            ".unknown.bin",
            "--id",
            "file1",
            "--operation-id",
            "create1",
            "--input",
            "-",
        ],
        Some(b"clobber"),
    );
    assert!(!rejected.status.success());
    assert_eq!(
        fs::read(dir.path().join(".unknown.bin")).unwrap(),
        b"external secret"
    );
    let status = invoke(dir.path(), &["status"], None);
    assert!(!String::from_utf8_lossy(&status.stdout).contains("external secret"));
    success(status);
}

#[test]
fn oversize_input_is_rejected_without_truncating_or_committing() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let input = tempfile::NamedTempFile::new().unwrap();
    input.as_file().set_len(16 * 1024 * 1024 + 1).unwrap();
    failure(
        invoke(
            dir.path(),
            &[
                "create",
                "large.bin",
                "--id",
                "large",
                "--operation-id",
                "large1",
                "--input",
                input.path().to_str().unwrap(),
            ],
            None,
        ),
        "input_too_large",
        2,
    );
    assert!(!dir.path().join("large.bin").exists());
    assert_eq!(
        success(invoke(dir.path(), &["list"], None))["entries"],
        serde_json::json!([])
    );
    assert_eq!(
        success(invoke(dir.path(), &["status"], None))["pending_outbox"],
        "0"
    );
}

#[test]
fn committed_but_projection_pending_is_success_with_receipt() {
    // A core-only commit models a previous process losing its response before
    // physical projection; the next CLI retry must return that original receipt.
    use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let request = MutationRequest {
        operation_id: OperationId::new("create1").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("file1").unwrap(),
            path: VaultPath::new(".unknown.bin").unwrap(),
            kind: EntryKind::File,
            content: Some(b"committed".to_vec()),
        },
    };
    let receipt = zorid_store::Store::open(dir.path().join(".zorid/vault.sqlite"))
        .unwrap()
        .apply(&request)
        .unwrap();
    fs::write(dir.path().join(".unknown.bin"), b"external divergence").unwrap();
    let result = create(dir.path(), b"committed");
    assert_eq!(result["commit"], serde_json::to_value(receipt).unwrap());
    assert_eq!(result["durable_local_commit"], true);
    assert_eq!(result["projection"]["state"], "pending");
    assert_eq!(result["projection"]["code"], "projection_pending");
    assert!(result["projection"].get("reason").is_none());
    assert_eq!(
        fs::read(dir.path().join(".unknown.bin")).unwrap(),
        b"external divergence"
    );
}

#[test]
fn recovery_reports_late_displaced_writes_as_incomplete_across_invocations() {
    use std::io::{Seek, SeekFrom};
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let created = create(dir.path(), b"initial");
    let mut external = fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join(".unknown.bin"))
        .unwrap();
    let written = success(invoke(
        dir.path(),
        &[
            "write",
            "--id",
            "file1",
            "--expected-revision",
            revision(&created),
            "--operation-id",
            "write1",
            "--input",
            "-",
        ],
        Some(b"new committed bytes"),
    ));
    assert_eq!(written["projection"]["state"], "projected");
    external.seek(SeekFrom::Start(0)).unwrap();
    external.set_len(0).unwrap();
    external.write_all(b"late private external text").unwrap();
    external.sync_all().unwrap();
    for _ in 0..2 {
        let output = invoke(dir.path(), &["recover"], None);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("late private external text"));
        let recovered = success(output);
        assert_eq!(recovered["complete"], false);
        assert!(recovered["report"]["blocked"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == ".unknown.bin"));
        assert_eq!(
            fs::read(dir.path().join(".unknown.bin")).unwrap(),
            b"new committed bytes"
        );
    }
}

#[test]
fn mkdir_then_nested_binary_create_and_exact_folder_retry() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let mkdir = [
        "mkdir",
        "folder",
        "--id",
        "folder1",
        "--operation-id",
        "mkdir1",
    ];
    let created = success(invoke(dir.path(), &mkdir, None));
    assert_eq!(created["projection"]["state"], "projected");
    assert!(dir.path().join("folder").is_dir());
    let file = success(invoke(
        dir.path(),
        &[
            "create",
            "folder/unknown.bin",
            "--id",
            "child1",
            "--operation-id",
            "child-create1",
            "--input",
            "-",
        ],
        Some(&[0, 255, 99]),
    ));
    assert_eq!(file["projection"]["state"], "projected");
    assert_eq!(
        fs::read(dir.path().join("folder/unknown.bin")).unwrap(),
        [0, 255, 99]
    );
    // Child creation changes the parent revision; original mkdir retry still
    // returns its original durable receipt without changing the child.
    assert_eq!(
        success(invoke(dir.path(), &mkdir, None))["commit"],
        created["commit"]
    );
    assert_eq!(
        fs::read(dir.path().join("folder/unknown.bin")).unwrap(),
        [0, 255, 99]
    );
}

#[test]
fn rescan_imports_unknown_nested_files_and_preserves_missing_history() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    fs::create_dir(dir.path().join("nested")).unwrap();
    fs::write(dir.path().join("nested/blob.xyz"), [0, 255, 10]).unwrap();
    fs::write(dir.path().join("root.bin"), [128, 0]).unwrap();
    let scan = success(invoke(dir.path(), &["rescan"], None));
    assert_eq!(scan["complete"], true);
    assert_eq!(scan["missing_are_deletions"], false);
    assert_eq!(scan["limits"]["max_total_bytes"], "67108864");
    let entries = success(invoke(dir.path(), &["list"], None));
    let file = entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "nested/blob.xyz")
        .unwrap();
    let id = file["id"].as_str().unwrap();
    let read = invoke(dir.path(), &["read", "--id", id, "--raw"], None);
    assert!(read.status.success());
    assert_eq!(read.stdout, [0, 255, 10]);
    fs::remove_file(dir.path().join("nested/blob.xyz")).unwrap();
    let scan = success(invoke(dir.path(), &["rescan"], None));
    assert!(scan["missing"]
        .as_array()
        .unwrap()
        .contains(&Value::String("nested/blob.xyz".into())));
    let retained = invoke(dir.path(), &["read", "--id", id, "--raw"], None);
    assert!(retained.status.success());
    assert_eq!(retained.stdout, [0, 255, 10]);
}

#[test]
fn bounded_rescan_reports_incomplete_then_can_retry_full_coverage() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    fs::write(dir.path().join("one.bin"), [1]).unwrap();
    fs::write(dir.path().join("two.bin"), [2]).unwrap();
    let bounded = success(invoke(dir.path(), &["rescan", "--max-entries", "1"], None));
    assert_eq!(bounded["complete"], false);
    assert!(
        bounded["run"]["issue"] == "scan_incomplete"
            || !bounded["issues"].as_array().unwrap().is_empty()
    );
    let complete = success(invoke(dir.path(), &["rescan"], None));
    assert_eq!(complete["complete"], true);
    assert_eq!(
        success(invoke(dir.path(), &["list"], None))["entries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
