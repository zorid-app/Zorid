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
    v.recover().unwrap();
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
