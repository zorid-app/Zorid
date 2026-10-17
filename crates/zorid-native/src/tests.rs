use super::*;
use std::{
    fs as stdfs,
    path::Path,
    process::{Command, Stdio},
};
use zorid_core::{EntryKind, Mutation, OperationId, Revision};
use zorid_store::Store;
fn id() -> EntryId {
    EntryId::new("file").unwrap()
}
fn path() -> VaultPath {
    VaultPath::new("note.unknown").unwrap()
}
fn create() -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("create").unwrap(),
        mutation: Mutation::Create {
            id: id(),
            path: path(),
            kind: EntryKind::File,
            content: Some(b"base".to_vec()),
        },
    }
}
fn write(op: &str, revision: Revision, bytes: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(op).unwrap(),
        mutation: Mutation::Write {
            id: id(),
            expected: revision,
            content: bytes.to_vec(),
        },
    }
}
fn revision(v: &NativeVault) -> Revision {
    v.read(&id()).unwrap().unwrap().state.revision
}
fn disk(root: &Path) -> Vec<u8> {
    stdfs::read(root.join(path().as_str())).unwrap()
}
fn child(root: &Path, mode: &str) -> Command {
    let mut c = Command::new(std::env::current_exe().unwrap());
    c.args(["--exact", "tests::process_worker", "--nocapture"])
        .env("ZORID_NATIVE_TEST_ROOT", root)
        .env("ZORID_NATIVE_TEST_MODE", mode)
        .stdout(Stdio::null());
    c
}
#[test]
fn process_worker() {
    let Some(root) = std::env::var_os("ZORID_NATIVE_TEST_ROOT") else {
        return;
    };
    let mode = std::env::var("ZORID_NATIVE_TEST_MODE").unwrap();
    if mode == "lock" {
        match NativeVault::open_with_options(
            root,
            Options {
                lock_timeout: Duration::from_millis(80),
                ..Default::default()
            },
        ) {
            Err(Error::LockTimeout) => std::process::exit(23),
            _ => std::process::exit(24),
        }
    }
    let mut vault = NativeVault::open(&root).unwrap();
    if mode == "crash" {
        vault.fault = Some(|point| {
            if std::env::var("ZORID_NATIVE_TEST_PHASE").unwrap() == point {
                std::process::exit(77)
            }
        });
        let rev = revision(&vault);
        vault.apply(&write("crash-write", rev, b"desired")).unwrap();
        panic!("fault was not reached");
    }
    if mode == "race" {
        let rev = Revision::new(std::env::var("ZORID_NATIVE_TEST_REV").unwrap()).unwrap();
        let operation = std::env::var("ZORID_NATIVE_TEST_OP").unwrap();
        match vault.apply(&write(&operation, rev, operation.as_bytes())) {
            Ok(out) if matches!(out.projection, ProjectionStatus::Projected) => {
                std::process::exit(0)
            }
            Err(Error::Store(zorid_store::StoreError::Contract(
                zorid_core::ContractError::RevisionConflict { .. },
            ))) => std::process::exit(10),
            other => panic!("unexpected result: {other:?}"),
        }
    }
}
#[test]
fn binary_hidden_file_and_exact_retry_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    let mut req = create();
    if let Mutation::Create { path, content, .. } = &mut req.mutation {
        *path = VaultPath::new(".hidden.unknown").unwrap();
        *content = Some(vec![0, 255, 128, 10]);
    }
    let out = v.apply(&req).unwrap();
    assert!(matches!(out.projection, ProjectionStatus::Projected));
    assert_eq!(
        stdfs::read(root.join(".hidden.unknown")).unwrap(),
        vec![0, 255, 128, 10]
    );
    drop(v);
    let mut v = NativeVault::open(root).unwrap();
    assert_eq!(v.apply(&req).unwrap().commit, out.commit);
    assert_eq!(v.status().unwrap().pending_projection, "0");
    assert_eq!(v.status().unwrap().pending_outbox, "1");
}
#[test]
fn external_edit_import_and_nested_unknown_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    stdfs::write(root.join(path().as_str()), b"external").unwrap();
    let report = v.reconcile(&[path()]).unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert_eq!(report.imported.len(), 1);
    assert_eq!(
        v.read(&id()).unwrap().unwrap().content.unwrap(),
        b"external"
    );
    stdfs::create_dir(root.join("nested")).unwrap();
    stdfs::write(root.join("nested/任意.bin"), [0, 255]).unwrap();
    let report = v
        .reconcile(&[VaultPath::new("nested/任意.bin").unwrap()])
        .unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert_eq!(v.list().unwrap().len(), 3);
    assert_eq!(v.status().unwrap().pending_projection, "0");
}
#[test]
fn database_newer_than_disk_does_not_import_stale_projection() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    Store::open(root.join(".zorid/vault.sqlite"))
        .unwrap()
        .apply(&write("db-new", revision(&v), b"newer"))
        .unwrap();
    let report = v.reconcile(&[path()]).unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert!(report.imported.is_empty());
    assert_eq!(disk(root), b"newer");
}
#[test]
fn divergent_external_and_db_versions_are_both_retained() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    Store::open(root.join(".zorid/vault.sqlite"))
        .unwrap()
        .apply(&write("db-new", revision(&v), b"database"))
        .unwrap();
    stdfs::write(root.join(path().as_str()), b"external").unwrap();
    let report = v.reconcile(&[path()]).unwrap();
    assert!(!report.blocked.is_empty());
    assert_eq!(disk(root), b"external");
    assert_eq!(
        v.read(&id()).unwrap().unwrap().content.unwrap(),
        b"database"
    );
    assert!(Store::open(root.join(".zorid/vault.sqlite"))
        .unwrap()
        .external_observations()
        .unwrap()
        .iter()
        .any(|o| o.content == b"external" && o.resolution.is_none()));
}
#[test]
fn process_death_at_each_publication_boundary_recovers() {
    for phase in [
        "committed",
        "prepared",
        "stage_written",
        "staged",
        "displaced_before_record",
        "displaced",
        "published_before_record",
        "before_baseline",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut v = NativeVault::open(root).unwrap();
        v.apply(&create()).unwrap();
        drop(v);
        assert_eq!(
            child(root, "crash")
                .env("ZORID_NATIVE_TEST_PHASE", phase)
                .status()
                .unwrap()
                .code(),
            Some(77),
            "{phase}"
        );
        let mut v = NativeVault::open(root).unwrap();
        let report = v.recover().unwrap();
        assert!(report.blocked.is_empty(), "{phase}: {report:?}");
        assert_eq!(disk(root), b"desired", "{phase}");
        assert_eq!(v.status().unwrap().pending_projection, "0");
        assert_eq!(v.status().unwrap().pending_outbox, "2");
    }
}
#[test]
fn older_displaced_attempt_cannot_publish_over_newer_desired_revision() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    drop(v);
    assert_eq!(
        child(root, "crash")
            .env("ZORID_NATIVE_TEST_PHASE", "displaced")
            .status()
            .unwrap()
            .code(),
        Some(77)
    );
    let mut db = Store::open(root.join(".zorid/vault.sqlite")).unwrap();
    let rev = db.read(&id()).unwrap().unwrap().state.revision;
    db.apply(&write("newest", rev, b"newest")).unwrap();
    drop(db);
    let mut v = NativeVault::open(root).unwrap();
    let report = v.recover().unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert_eq!(disk(root), b"newest");
    assert_eq!(v.status().unwrap().pending_projection, "0");
}
#[test]
fn external_create_in_publication_gap_is_never_clobbered() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    drop(v);
    assert_eq!(
        child(root, "crash")
            .env("ZORID_NATIVE_TEST_PHASE", "displaced")
            .status()
            .unwrap()
            .code(),
        Some(77)
    );
    stdfs::write(root.join(path().as_str()), b"external-gap").unwrap();
    let mut v = NativeVault::open(root).unwrap();
    let report = v.recover().unwrap();
    assert!(!report.blocked.is_empty());
    assert_eq!(disk(root), b"external-gap");
    let status = v.status().unwrap();
    assert!(Store::open(root.join(".zorid/vault.sqlite"))
        .unwrap()
        .external_observations()
        .unwrap()
        .iter()
        .any(|o| o.content == b"external-gap"));
    let attempt = &status.attempts[0];
    let base = root.join(".zorid");
    assert_eq!(
        stdfs::read(base.join(format!("{}.previous", attempt.attempt_id.as_str()))).unwrap(),
        b"base"
    );
    assert_eq!(
        stdfs::read(base.join(format!("{}.stage", attempt.attempt_id.as_str()))).unwrap(),
        b"desired"
    );
}
#[test]
fn process_lock_is_bounded_and_competing_revisions_have_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    let lock = stdfs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join(".zorid/vault.lock"))
        .unwrap();
    lock.lock().unwrap();
    assert_eq!(child(root, "lock").status().unwrap().code(), Some(23));
    drop(lock);
    let rev = revision(&v);
    let mut a = child(root, "race")
        .env("ZORID_NATIVE_TEST_REV", rev.as_str())
        .env("ZORID_NATIVE_TEST_OP", "desktop")
        .spawn()
        .unwrap();
    let mut b = child(root, "race")
        .env("ZORID_NATIVE_TEST_REV", rev.as_str())
        .env("ZORID_NATIVE_TEST_OP", "cli")
        .spawn()
        .unwrap();
    let mut results = [
        a.wait().unwrap().code().unwrap(),
        b.wait().unwrap().code().unwrap(),
    ];
    results.sort();
    assert_eq!(results, [0, 10]);
    assert_eq!(v.status().unwrap().pending_projection, "0");
    assert_eq!(v.status().unwrap().pending_outbox, "2");
}
#[test]
fn symlinks_hardlinks_and_private_aliases_fail_closed() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    stdfs::write(outside.path().join("precious"), b"outside").unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    symlink(outside.path().join("precious"), root.join(path().as_str())).unwrap();
    assert!(v.apply(&create()).is_err());
    assert_eq!(
        stdfs::read(outside.path().join("precious")).unwrap(),
        b"outside"
    );
    stdfs::remove_file(root.join(path().as_str())).unwrap();
    stdfs::hard_link(outside.path().join("precious"), root.join(path().as_str())).unwrap();
    assert!(v.reconcile(&[path()]).unwrap().blocked.len() > 0);
    stdfs::remove_file(root.join(path().as_str())).unwrap();
    symlink(outside.path(), root.join("link")).unwrap();
    assert!(!v
        .reconcile(&[VaultPath::new("link/precious").unwrap()])
        .unwrap()
        .blocked
        .is_empty());
    drop(v);
    stdfs::rename(
        root.join(".zorid/vault.sqlite"),
        root.join(".zorid/saved.sqlite"),
    )
    .unwrap();
    symlink(
        root.join(".zorid/saved.sqlite"),
        root.join(".zorid/vault.sqlite"),
    )
    .unwrap();
    assert!(NativeVault::open(root).is_err());
}
#[test]
fn external_deletion_is_not_silently_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    stdfs::remove_file(root.join(path().as_str())).unwrap();
    assert!(!v.reconcile(&[path()]).unwrap().blocked.is_empty());
    assert!(!root.join(path().as_str()).exists());
    assert!(v.read(&id()).unwrap().is_some());
}

#[test]
fn partial_stage_process_death_is_quarantined_and_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    drop(v);
    assert_eq!(
        child(root, "crash")
            .env("ZORID_NATIVE_TEST_PHASE", "unused")
            .env("ZORID_NATIVE_TEST_PARTIAL_STAGE", "1")
            .status()
            .unwrap()
            .code(),
        Some(78)
    );
    let mut v = NativeVault::open(root).unwrap();
    let report = v.recover().unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert_eq!(disk(root), b"desired");
    assert!(stdfs::read_dir(root.join(".zorid")).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".partial-")));
}
#[test]
fn late_external_write_to_completed_displacement_is_captured() {
    use std::io::{Seek, SeekFrom, Write};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    let mut external = stdfs::OpenOptions::new()
        .write(true)
        .open(root.join(path().as_str()))
        .unwrap();
    assert!(matches!(
        v.apply(&write("new", revision(&v), b"new bytes"))
            .unwrap()
            .projection,
        ProjectionStatus::Projected
    ));
    external.seek(SeekFrom::Start(0)).unwrap();
    external.set_len(0).unwrap();
    external.write_all(b"late external write").unwrap();
    external.sync_all().unwrap();
    let report = v.recover().unwrap();
    assert!(report.blocked.iter().any(|(p, _)| *p == path()));
    assert_eq!(disk(root), b"new bytes");
    let observations = Store::open(root.join(".zorid/vault.sqlite"))
        .unwrap()
        .external_observations()
        .unwrap();
    assert!(observations
        .iter()
        .any(|o| o.content == b"late external write" && o.resolution.is_none()));
    assert!(v
        .status()
        .unwrap()
        .observations
        .iter()
        .any(|o| o.byte_length == "19" && !o.resolved));
    drop(v);
    let mut reopened = NativeVault::open_existing(root).unwrap();
    let report = reopened.recover().unwrap();
    assert!(report.blocked.iter().any(|(p, _)| *p == path()));
    assert_eq!(disk(root), b"new bytes");
}
#[test]
fn observed_parent_relocation_stops_publication() {
    // The hook executes on this test thread; no process-wide environment mutation.
    thread_local! {static RELOCATION: std::cell::RefCell<Option<(std::path::PathBuf,std::path::PathBuf)>> = const {std::cell::RefCell::new(None)};}
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = dir.path();
    stdfs::create_dir(root.join("nested")).unwrap();
    stdfs::write(root.join("nested/note"), b"base").unwrap();
    let mut v = NativeVault::open(root).unwrap();
    let nested = VaultPath::new("nested/note").unwrap();
    v.reconcile(&[nested.clone()]).unwrap();
    let state = v
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.path == nested)
        .unwrap();
    RELOCATION.with(|cell| {
        *cell.borrow_mut() = Some((root.join("nested"), outside.path().join("moved")))
    });
    v.fault = Some(|phase| {
        if phase == "staged" {
            RELOCATION.with(|cell| {
                let (from, to) = cell.borrow_mut().take().unwrap();
                stdfs::rename(from, to).unwrap();
            });
        }
    });
    let out = v
        .apply(&MutationRequest {
            operation_id: OperationId::new("nested-write").unwrap(),
            mutation: Mutation::Write {
                id: state.id,
                expected: state.revision,
                content: b"desired".to_vec(),
            },
        })
        .unwrap();
    assert!(matches!(out.projection, ProjectionStatus::Pending(_)));
    assert_eq!(
        stdfs::read(outside.path().join("moved/note")).unwrap(),
        b"base"
    );
    assert_eq!(v.status().unwrap().pending_projection, "1");
}
#[test]
fn existing_open_never_initializes_missing_or_empty_database() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert!(NativeVault::open_existing(root).is_err());
    assert!(!root.join(".zorid").exists());
    stdfs::create_dir(root.join(".zorid")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    stdfs::set_permissions(root.join(".zorid"), stdfs::Permissions::from_mode(0o700)).unwrap();
    assert!(NativeVault::open_existing(root).is_err());
    assert!(!root.join(".zorid/vault.sqlite").exists());
    stdfs::write(root.join(".zorid/vault.sqlite"), []).unwrap();
    assert!(NativeVault::open_existing(root).is_err());
    assert_eq!(
        stdfs::metadata(root.join(".zorid/vault.sqlite"))
            .unwrap()
            .len(),
        0
    );
}
#[test]
fn corrupt_attempt_identity_cannot_touch_user_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    drop(v);
    assert_eq!(
        child(root, "crash")
            .env("ZORID_NATIVE_TEST_PHASE", "prepared")
            .status()
            .unwrap()
            .code(),
        Some(77)
    );
    let db = rusqlite::Connection::open(root.join(".zorid/vault.sqlite")).unwrap();
    db.execute("UPDATE projection_attempts SET record=json_set(record,'$.target.state.id','another') WHERE completed=0",[]).unwrap();
    let before: i64 = db
        .query_row("SELECT count(*) FROM projection_attempts", [], |r| r.get(0))
        .unwrap();
    let mut v = NativeVault::open(root).unwrap();
    assert!(v.recover().is_err());
    assert_eq!(disk(root), b"base");
    let after: i64 = db
        .query_row("SELECT count(*) FROM projection_attempts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
    assert!(!stdfs::read_dir(root.join(".zorid")).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".stage")));
}

#[test]
fn create_imports_existing_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    stdfs::create_dir(root.join("nested")).unwrap();
    let mut v = NativeVault::open(root).unwrap();
    let mut request = create();
    if let Mutation::Create { path, .. } = &mut request.mutation {
        *path = VaultPath::new("nested/new.unknown").unwrap();
    }
    let out = v.apply(&request).unwrap();
    assert!(matches!(out.projection, ProjectionStatus::Projected));
    assert_eq!(
        stdfs::read(root.join("nested/new.unknown")).unwrap(),
        b"base"
    );
    assert_eq!(v.list().unwrap().len(), 2);
    assert_eq!(v.status().unwrap().pending_projection, "0");
}

#[test]
fn lost_ack_retries_return_original_commit_before_filesystem_preconditions() {
    for external in ["deleted", "edited", "database-newer"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut v = NativeVault::open(root).unwrap();
        let request = create();
        let original = v.apply(&request).unwrap().commit;
        match external {
            "deleted" => stdfs::remove_file(root.join(path().as_str())).unwrap(),
            "edited" => stdfs::write(root.join(path().as_str()), b"external").unwrap(),
            _ => {
                Store::open(root.join(".zorid/vault.sqlite"))
                    .unwrap()
                    .apply(&write("later", revision(&v), b"later"))
                    .unwrap();
            }
        }
        let retry = v.apply(&request).unwrap();
        assert_eq!(retry.commit, original);
        if external != "database-newer" {
            assert!(matches!(retry.projection, ProjectionStatus::Pending(_)));
            assert_eq!(v.status().unwrap().pending_outbox, "1");
        }
        assert!(
            v.status().unwrap().observations.is_empty(),
            "replay must not author external imports"
        );
        if external == "edited" {
            assert_eq!(disk(root), b"external");
        }
    }
}
#[test]
fn reused_operation_id_rejects_before_any_external_import() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    let mut request = create();
    v.apply(&request).unwrap();
    stdfs::write(root.join(path().as_str()), b"external").unwrap();
    if let Mutation::Create { content, .. } = &mut request.mutation {
        *content = Some(b"different command".to_vec());
    }
    assert!(matches!(
        v.apply(&request),
        Err(Error::Store(zorid_store::StoreError::Contract(
            zorid_core::ContractError::IdempotencyConflict { .. }
        )))
    ));
    assert!(v.status().unwrap().observations.is_empty());
    assert_eq!(v.status().unwrap().pending_outbox, "1");
    assert_eq!(disk(root), b"external");
    assert_eq!(v.read(&id()).unwrap().unwrap().content.unwrap(), b"base");
}

fn folder_request() -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("mkdir").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("folder").unwrap(),
            path: VaultPath::new("folder").unwrap(),
            kind: EntryKind::Folder,
            content: None,
        },
    }
}
fn scan_child(root: &Path, mode: &str) -> Command {
    let mut c = Command::new(std::env::current_exe().unwrap());
    c.args(["--exact", "tests::directory_scan_worker", "--nocapture"])
        .env("ZORID_SCAN_TEST_ROOT", root)
        .env("ZORID_SCAN_TEST_MODE", mode)
        .stdout(Stdio::null());
    c
}
#[test]
fn directory_scan_worker() {
    let Some(root) = std::env::var_os("ZORID_SCAN_TEST_ROOT") else {
        return;
    };
    let mode = std::env::var("ZORID_SCAN_TEST_MODE").unwrap();
    let mut vault = NativeVault::open_existing(&root).unwrap();
    if mode == "folder_crash" {
        vault.fault = Some(|point| {
            if point == std::env::var("ZORID_SCAN_TEST_PHASE").unwrap() {
                std::process::exit(79)
            }
        });
        vault.apply(&folder_request()).unwrap();
        panic!("folder crash hook not reached");
    }
    if mode == "scan_finalize_crash" {
        vault.fault = Some(|point| {
            if point == "scan_before_finish" {
                std::process::exit(81)
            }
        });
        vault.rescan().unwrap();
        panic!("scan finalize hook not reached");
    }
    if mode == "scan_crash" {
        vault.fault = Some(|point| {
            if point == "scan_observation_committed" {
                std::process::exit(80)
            }
        });
        vault.rescan().unwrap();
        panic!("scan crash hook not reached");
    }
    if mode == "scan" {
        let r = vault.rescan().unwrap();
        assert!(r.run.complete, "{r:?}");
        std::process::exit(0);
    }
    if mode == "mkdir" {
        vault.apply(&folder_request()).unwrap();
        std::process::exit(0);
    }
}
#[test]
fn physical_folder_create_and_replay_after_child_revision_change() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    let first = v.apply(&folder_request()).unwrap();
    assert!(matches!(first.projection, ProjectionStatus::Projected));
    assert!(root.join("folder").is_dir());
    let mut file = create();
    if let Mutation::Create { path, .. } = &mut file.mutation {
        *path = VaultPath::new("folder/note.unknown").unwrap();
    }
    v.apply(&file).unwrap();
    let retry = v.apply(&folder_request()).unwrap();
    assert_eq!(retry.commit, first.commit);
    assert!(matches!(retry.projection, ProjectionStatus::Projected));
    assert_eq!(v.status().unwrap().pending_projection, "0");
    assert_eq!(v.status().unwrap().pending_outbox, "2");
}
#[test]
fn folder_create_process_death_recovers_every_publication_phase() {
    for phase in [
        "committed",
        "directory_prepared",
        "directory_stage_written",
        "directory_staged",
        "directory_published_before_record",
        "directory_before_baseline",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        drop(NativeVault::open(root).unwrap());
        assert_eq!(
            scan_child(root, "folder_crash")
                .env("ZORID_SCAN_TEST_PHASE", phase)
                .status()
                .unwrap()
                .code(),
            Some(79)
        );
        let mut v = NativeVault::open_existing(root).unwrap();
        let r = v.recover().unwrap();
        assert!(r.blocked.is_empty(), "{phase}: {r:?}");
        assert!(root.join("folder").is_dir());
        assert_eq!(v.status().unwrap().pending_projection, "0");
        assert_eq!(v.status().unwrap().pending_outbox, "1");
    }
}
#[test]
fn external_folder_destination_cannot_be_adopted_as_our_staged_inode() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    drop(NativeVault::open(root).unwrap());
    assert_eq!(
        scan_child(root, "folder_crash")
            .env("ZORID_SCAN_TEST_PHASE", "directory_staged")
            .status()
            .unwrap()
            .code(),
        Some(79)
    );
    stdfs::create_dir(root.join("folder")).unwrap();
    stdfs::write(root.join("folder/external"), b"unique").unwrap();
    let mut v = NativeVault::open_existing(root).unwrap();
    let r = v.recover().unwrap();
    assert!(!r.blocked.is_empty());
    assert_eq!(
        stdfs::read(root.join("folder/external")).unwrap(),
        b"unique"
    );
    assert_eq!(v.status().unwrap().directory_attempts.len(), 1);
    assert_eq!(v.status().unwrap().pending_projection, "1");
    let r = v.rescan().unwrap();
    assert!(!r.run.complete);
    assert!(r.missing.is_empty());
    assert_eq!(
        stdfs::read(root.join("folder/external")).unwrap(),
        b"unique"
    );
}
#[test]
fn recursive_rescan_imports_offline_edits_and_nested_hidden_binary_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    drop(v);
    stdfs::write(root.join(path().as_str()), b"offline edit").unwrap();
    stdfs::create_dir_all(root.join(".hidden/nested/.zorid")).unwrap();
    stdfs::write(
        root.join(".hidden/nested/.zorid/任意.unknown"),
        [0, 255, 128],
    )
    .unwrap();
    let mut v = NativeVault::open_existing(root).unwrap();
    let report = v.rescan().unwrap();
    assert!(report.run.complete, "{report:?}");
    assert_eq!(
        v.read(&id()).unwrap().unwrap().content.unwrap(),
        b"offline edit"
    );
    let state = v
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.path.as_str() == ".hidden/nested/.zorid/任意.unknown")
        .unwrap();
    assert_eq!(
        v.read(&state.id).unwrap().unwrap().content.unwrap(),
        vec![0, 255, 128]
    );
    assert!(!v
        .list()
        .unwrap()
        .iter()
        .any(|s| s.path.as_str().starts_with(".zorid/")));
    assert_eq!(v.status().unwrap().pending_projection, "0");
    let repeat = v.rescan().unwrap();
    assert!(repeat.run.complete);
    assert_eq!(repeat.run.imported, 0);
}
#[test]
fn interrupted_scan_leaves_incomplete_record_and_restart_has_no_duplicate_import() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    drop(NativeVault::open(root).unwrap());
    stdfs::write(root.join("a"), b"one").unwrap();
    stdfs::write(root.join("b"), b"two").unwrap();
    assert_eq!(
        scan_child(root, "scan_crash").status().unwrap().code(),
        Some(80)
    );
    let db = Store::open(root.join(".zorid/vault.sqlite")).unwrap();
    let interrupted = db.latest_scan().unwrap().unwrap();
    assert!(!interrupted.finished && !interrupted.complete);
    assert_eq!(db.list().unwrap().len(), 1);
    drop(db);
    let mut v = NativeVault::open_existing(root).unwrap();
    let report = v.rescan().unwrap();
    assert!(report.run.complete, "{report:?}");
    assert_eq!(report.run.imported, 1);
    assert_eq!(v.list().unwrap().len(), 2);
    assert_eq!(v.status().unwrap().pending_outbox, "2");
    let db = Store::open(root.join(".zorid/vault.sqlite")).unwrap();
    assert!(!db.scan_run(&interrupted.scan_id).unwrap().finished);
}
#[test]
fn complete_scan_records_absence_without_deleting_or_recreating() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    stdfs::remove_file(root.join(path().as_str())).unwrap();
    let report = v.rescan().unwrap();
    assert!(report.run.complete, "{report:?}");
    assert_eq!(report.missing, vec![path()]);
    assert!(!root.join(path().as_str()).exists());
    assert_eq!(v.read(&id()).unwrap().unwrap().content.unwrap(), b"base");
    let db = Store::open(root.join(".zorid/vault.sqlite")).unwrap();
    assert!(db
        .scan_observations(&report.run.scan_id)
        .unwrap()
        .iter()
        .any(|o| o.kind == zorid_store::ScanObservationKind::Absent));
    assert_eq!(db.pending_counts().unwrap(), (1, 0));
}
#[test]
fn scan_limits_and_unreadable_directories_never_produce_absence() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    stdfs::remove_file(root.join(path().as_str())).unwrap();
    stdfs::write(root.join("a"), b"one").unwrap();
    stdfs::write(root.join("b"), b"two").unwrap();
    let r = v
        .rescan_with_options(ScanOptions {
            max_entries: 1,
            ..Default::default()
        })
        .unwrap();
    assert!(!r.run.complete);
    assert!(r.missing.is_empty());
    let r = v
        .rescan_with_options(ScanOptions {
            max_duration: Duration::ZERO,
            ..Default::default()
        })
        .unwrap();
    assert!(!r.run.complete && r.missing.is_empty());
    stdfs::create_dir(root.join("unreadable")).unwrap();
    stdfs::write(root.join("unreadable/keep"), b"precious").unwrap();
    stdfs::set_permissions(root.join("unreadable"), stdfs::Permissions::from_mode(0)).unwrap();
    let r = v.rescan().unwrap();
    stdfs::set_permissions(
        root.join("unreadable"),
        stdfs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert!(!r.run.complete, "{r:?}");
    assert!(r.missing.is_empty());
    assert_eq!(v.read(&id()).unwrap().unwrap().content.unwrap(), b"base");
    assert_eq!(
        stdfs::read(root.join("unreadable/keep")).unwrap(),
        b"precious"
    );
    let db = Store::open(root.join(".zorid/vault.sqlite")).unwrap();
    assert!(!db
        .scan_observations(&r.run.scan_id)
        .unwrap()
        .iter()
        .any(|o| o.kind == zorid_store::ScanObservationKind::Absent));
}
#[test]
fn zero_byte_and_depth_limits_are_incomplete_and_preserve_content() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    stdfs::write(root.join("empty"), []).unwrap();
    stdfs::write(root.join("nonempty"), b"data").unwrap();
    let r = v
        .rescan_with_options(ScanOptions {
            max_total_bytes: 0,
            ..Default::default()
        })
        .unwrap();
    assert!(!r.run.complete);
    assert!(v.list().unwrap().iter().any(|s| s.path.as_str() == "empty"));
    assert!(!v
        .list()
        .unwrap()
        .iter()
        .any(|s| s.path.as_str() == "nonempty"));
    stdfs::create_dir(root.join("nested")).unwrap();
    stdfs::write(root.join("nested/child"), b"child").unwrap();
    let r = v
        .rescan_with_options(ScanOptions {
            max_depth: 0,
            ..Default::default()
        })
        .unwrap();
    assert!(!r.run.complete);
    assert!(!v
        .list()
        .unwrap()
        .iter()
        .any(|s| s.path.as_str() == "nested/child"));
    assert_eq!(stdfs::read(root.join("nested/child")).unwrap(), b"child");
}
#[test]
fn concurrent_process_rescans_and_mkdir_keep_one_authority() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    drop(NativeVault::open(root).unwrap());
    stdfs::write(root.join("external"), b"bytes").unwrap();
    let mut a = scan_child(root, "scan").spawn().unwrap();
    let mut b = scan_child(root, "scan").spawn().unwrap();
    assert!(a.wait().unwrap().success());
    assert!(b.wait().unwrap().success());
    let mut a = scan_child(root, "mkdir").spawn().unwrap();
    let mut b = scan_child(root, "mkdir").spawn().unwrap();
    assert!(a.wait().unwrap().success());
    assert!(b.wait().unwrap().success());
    let v = NativeVault::open_existing(root).unwrap();
    assert_eq!(v.list().unwrap().len(), 2);
    assert_eq!(v.status().unwrap().pending_outbox, "2");
    assert_eq!(v.status().unwrap().pending_projection, "0");
}

#[test]
fn interrupted_scan_finalization_exposes_no_draft_absence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    v.apply(&create()).unwrap();
    drop(v);
    stdfs::remove_file(root.join(path().as_str())).unwrap();
    assert_eq!(
        scan_child(root, "scan_finalize_crash")
            .status()
            .unwrap()
            .code(),
        Some(81)
    );
    let db = Store::open(root.join(".zorid/vault.sqlite")).unwrap();
    let unfinished = db.latest_scan().unwrap().unwrap();
    assert!(!unfinished.finished);
    assert!(!db
        .scan_observations(&unfinished.scan_id)
        .unwrap()
        .iter()
        .any(|o| o.kind == zorid_store::ScanObservationKind::Absent));
    drop(db);
    let mut v = NativeVault::open_existing(root).unwrap();
    let r = v.rescan().unwrap();
    assert!(r.run.complete);
    assert_eq!(r.missing, vec![path()]);
    assert_eq!(v.read(&id()).unwrap().unwrap().content.unwrap(), b"base");
}
#[test]
fn replaced_completed_parent_cannot_produce_final_absence() {
    thread_local! {static REPLACE:std::cell::RefCell<Option<std::path::PathBuf>>=const{std::cell::RefCell::new(None)};}
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    stdfs::create_dir(root.join("folder")).unwrap();
    stdfs::write(root.join("folder/child"), b"precious").unwrap();
    let mut v = NativeVault::open(root).unwrap();
    assert!(v.rescan().unwrap().run.complete);
    stdfs::remove_file(root.join("folder/child")).unwrap();
    REPLACE.with(|v| *v.borrow_mut() = Some(root.to_owned()));
    v.fault = Some(|point| {
        if point == "scan_before_absence_validation" {
            REPLACE.with(|v| {
                let root = v.borrow_mut().take().unwrap();
                stdfs::rename(root.join("folder"), root.join("moved-folder")).unwrap();
                stdfs::create_dir(root.join("folder")).unwrap();
            });
        }
    });
    let r = v.rescan().unwrap();
    assert!(!r.run.complete);
    assert!(r.missing.is_empty());
    let db = Store::open(root.join(".zorid/vault.sqlite")).unwrap();
    assert!(!db
        .scan_observations(&r.run.scan_id)
        .unwrap()
        .iter()
        .any(|o| o.kind == zorid_store::ScanObservationKind::Absent));
    let child = v
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.path.as_str() == "folder/child")
        .unwrap();
    assert_eq!(
        v.read(&child.id).unwrap().unwrap().content.unwrap(),
        b"precious"
    );
}

#[test]
fn recursive_scan_never_traverses_external_symlink() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    stdfs::write(outside.path().join("outside-only"), b"private").unwrap();
    let root = dir.path();
    let mut v = NativeVault::open(root).unwrap();
    symlink(outside.path(), root.join("linked")).unwrap();
    let r = v.rescan().unwrap();
    assert!(!r.run.complete);
    assert!(r.missing.is_empty());
    assert!(v.list().unwrap().is_empty());
    assert_eq!(
        stdfs::read(outside.path().join("outside-only")).unwrap(),
        b"private"
    );
}

#[test]
fn explicit_directory_hint_imports_and_missing_directory_stays_retained() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    stdfs::create_dir(root.join("existing")).unwrap();
    let mut v = NativeVault::open(root).unwrap();
    let path = VaultPath::new("existing").unwrap();
    let r = v.reconcile(&[path.clone()]).unwrap();
    assert!(r.blocked.is_empty(), "{r:?}");
    assert_eq!(r.imported.len(), 1);
    assert_eq!(v.status().unwrap().pending_projection, "0");
    stdfs::remove_dir(root.join("existing")).unwrap();
    let r = v.reconcile(&[path.clone()]).unwrap();
    assert!(!r.blocked.is_empty());
    assert!(v.list().unwrap().iter().any(|s| s.path == path));
    assert!(!root.join("existing").exists());
}

#[test]
fn coherent_path_reads_use_committed_bytes_while_projection_is_pending() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault.apply(&create()).unwrap();
    let before = vault.list_snapshot().unwrap();
    let mut store = Store::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    let req = write(
        "database-only",
        revision(&vault),
        b"unprojected binary\0\xff",
    );
    let receipt = store.apply_at(&req, 1).unwrap();
    let entry = vault.read_path(&path()).unwrap().unwrap();
    assert_eq!(entry.state.id, id());
    assert_eq!(
        entry.state.revision,
        receipt
            .changes
            .iter()
            .find(|c| c.after.id == id())
            .unwrap()
            .after
            .revision
    );
    assert_eq!(entry.content, Some(b"unprojected binary\0\xff".to_vec()));
    assert_eq!(entry.presentation.size_bytes, 20);
    assert_eq!(disk(root.path()), b"base");
    let page = vault.changes_after(&before.cursor, 100).unwrap();
    assert_eq!(page.changes.len(), 1);
    assert_eq!(page.changes[0].entries[0].state, entry.state);
    vault.recover().unwrap();
    assert_eq!(vault.list_snapshot().unwrap().cursor, page.next_cursor);
}
#[test]
fn external_scan_imports_update_presentation_and_change_stream_once() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    let initial = vault.list_snapshot().unwrap();
    stdfs::create_dir(root.path().join("external")).unwrap();
    stdfs::write(root.path().join("external/file.unknown"), [0, 255, 17]).unwrap();
    assert!(vault.rescan().unwrap().run.complete);
    let after = vault.list_snapshot().unwrap();
    assert_eq!(after.entries.len(), 2);
    let file = vault
        .read_path(&VaultPath::new("external/file.unknown").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(file.presentation.size_bytes, 3);
    assert!(file.presentation.ctime_ms > 0);
    let page = vault.changes_after(&initial.cursor, 100).unwrap();
    assert_eq!(page.changes.len(), 2);
    assert_eq!(page.next_cursor, after.cursor);
    assert!(vault.rescan().unwrap().run.complete);
    assert_eq!(vault.list_snapshot().unwrap(), after);
}

#[test]
fn host_intent_worker() {
    let Some(root) = std::env::var_os("ZORID_HOST_INTENT_ROOT") else {
        return;
    };
    let mut vault = NativeVault::open(root).unwrap();
    vault.fault = Some(|point| {
        if std::env::var("ZORID_HOST_INTENT_PHASE").ok().as_deref() == Some(point) {
            std::process::exit(86);
        }
    });
    let client = OperationId::new("desktop").unwrap();
    let prepared = vault.prepare_host_intent(&client, &create()).unwrap();
    let reference = HostIntentRef {
        client_id: client,
        token: prepared.token,
    };
    let committed = vault.commit_host_intent(&reference).unwrap();
    let receipt = committed.receipt.unwrap();
    vault
        .acknowledge_host_intent(
            &reference,
            &HostIntentAcknowledgment::Committed {
                operation_id: receipt.operation_id,
                sequence: receipt.sequence.to_string(),
            },
        )
        .unwrap();
}
#[test]
fn host_intent_crash_boundaries_preserve_authorization_and_exact_receipt() {
    for phase in [
        "host_intent_prepared",
        "host_intent_commit_requested",
        "committed",
        "host_intent_core_committed",
        "host_intent_settled",
        "host_intent_acknowledged",
    ] {
        let root = tempfile::tempdir().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::host_intent_worker", "--nocapture"])
            .env("ZORID_HOST_INTENT_ROOT", root.path())
            .env("ZORID_HOST_INTENT_PHASE", phase)
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86), "{phase}");
        let mut vault = NativeVault::open(root.path()).unwrap();
        let client = OperationId::new("desktop").unwrap();
        let page = vault.list_host_intents(&client, "0", 10).unwrap();
        assert_eq!(page.intents.len(), 1);
        let intent = &page.intents[0];
        let reference = HostIntentRef {
            client_id: client,
            token: intent.token.clone(),
        };
        vault.recover().unwrap();
        if phase == "host_intent_prepared" {
            assert!(vault.list().unwrap().is_empty());
            assert_eq!(
                vault.query_host_intent(&reference).unwrap().unwrap().state,
                HostIntentState::Prepared
            );
            assert!(!root.path().join(path().as_str()).exists());
        }
        let settled = vault.commit_host_intent(&reference).unwrap();
        assert_eq!(settled.state, HostIntentState::Committed);
        let receipt = settled.receipt.clone().unwrap();
        let snapshot = vault.list_snapshot().unwrap();
        assert_eq!(
            vault.commit_host_intent(&reference).unwrap().receipt,
            Some(receipt.clone())
        );
        assert_eq!(vault.list_snapshot().unwrap(), snapshot);
        assert_eq!(disk(root.path()), b"base");
        let ack = HostIntentAcknowledgment::Committed {
            operation_id: receipt.operation_id,
            sequence: receipt.sequence.to_string(),
        };
        assert!(
            vault
                .acknowledge_host_intent(&reference, &ack)
                .unwrap()
                .acknowledged
        );
    }
}
#[test]
fn host_prepared_fence_precedes_external_import_and_semantic_rejection_persists() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault.apply(&create()).unwrap();
    let old = revision(&vault);
    let req = write("prepared", old.clone(), b"authored");
    let client = OperationId::new("desktop").unwrap();
    let prepared = vault.prepare_host_intent(&client, &req).unwrap();
    let reference = HostIntentRef {
        client_id: client,
        token: prepared.token,
    };
    let before = vault.list_snapshot().unwrap();
    stdfs::write(root.path().join(path().as_str()), b"external").unwrap();
    assert!(vault.apply(&req).is_err());
    assert_eq!(vault.list_snapshot().unwrap(), before);
    let rejected = vault.commit_host_intent(&reference).unwrap();
    assert_eq!(rejected.state, HostIntentState::Rejected);
    assert_eq!(
        rejected.error.unwrap().code,
        HostRejectionCode::RevisionConflict
    );
    assert_eq!(
        vault.read_path(&path()).unwrap().unwrap().content,
        Some(b"external".to_vec())
    );
    drop(vault);
    let mut vault = NativeVault::open(root.path()).unwrap();
    assert_eq!(
        vault.commit_host_intent(&reference).unwrap().state,
        HostIntentState::Rejected
    );
    assert!(vault.apply(&req).is_err());
}
#[test]
fn environmental_failure_keeps_requested_intent_replayable() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault.apply(&create()).unwrap();
    let req = write("intent-write", revision(&vault), b"authored");
    let prepared = vault
        .prepare_host_intent(&OperationId::new("desktop").unwrap(), &req)
        .unwrap();
    let reference = HostIntentRef {
        client_id: prepared.client_id,
        token: prepared.token,
    };
    stdfs::remove_file(root.path().join(path().as_str())).unwrap();
    assert!(vault.commit_host_intent(&reference).is_err());
    assert_eq!(
        vault.query_host_intent(&reference).unwrap().unwrap().state,
        HostIntentState::CommitRequested
    );
    stdfs::write(root.path().join(path().as_str()), b"base").unwrap();
    assert_eq!(
        vault.commit_host_intent(&reference).unwrap().state,
        HostIntentState::Committed
    );
    assert_eq!(
        vault.read_path(&path()).unwrap().unwrap().content,
        Some(b"authored".to_vec())
    );
}
