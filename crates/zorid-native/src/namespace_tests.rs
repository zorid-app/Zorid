use super::*;
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
};
use zorid_core::{EntryKind, Mutation};
fn eid(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}
fn add(v: &mut NativeVault, id: &str, path: &str, bytes: Option<&[u8]>) {
    let out = v
        .apply(&MutationRequest {
            operation_id: op(&format!("create-{id}")),
            mutation: Mutation::Create {
                id: eid(id),
                path: vp(path),
                kind: if bytes.is_some() {
                    EntryKind::File
                } else {
                    EntryKind::Folder
                },
                content: bytes.map(Vec::from),
            },
        })
        .unwrap();
    assert!(
        matches!(out.projection, ProjectionStatus::Projected),
        "{:?}",
        out.projection
    );
}
fn command(v: &NativeVault, id: &str, target: Option<&str>) -> MutationRequest {
    let expected = v.read(&eid(id)).unwrap().unwrap().state.revision;
    MutationRequest {
        operation_id: op("namespace-command"),
        mutation: match target {
            Some(path) => Mutation::Move {
                id: eid(id),
                expected,
                path: vp(path),
            },
            None => Mutation::Delete {
                id: eid(id),
                expected,
                recursive: true,
            },
        },
    }
}
fn fixture(root: &Path, folder: bool) -> NativeVault {
    let mut v = NativeVault::open(root).unwrap();
    if folder {
        add(&mut v, "subject", "Old", None);
        add(&mut v, "nested", "Old/nested", None);
        add(&mut v, "empty", "Old/empty", None);
        add(
            &mut v,
            "leaf",
            "Old/nested/.bytes.blob",
            Some(&[0, 255, 10, 128]),
        );
        add(&mut v, "other", "Old/other.blob", Some(b"other"));
    } else {
        add(&mut v, "subject", "Old.blob", Some(b"base"));
    }
    v
}
fn child(root: &Path, folder: bool, delete: bool) -> Command {
    let mut c = Command::new(std::env::current_exe().unwrap());
    c.args([
        "--exact",
        "namespace_tests::namespace_process_worker",
        "--nocapture",
    ])
    .env("ZORID_NAMESPACE_ROOT", root)
    .env("ZORID_NAMESPACE_FOLDER", if folder { "1" } else { "0" })
    .env("ZORID_NAMESPACE_DELETE", if delete { "1" } else { "0" })
    .stdout(Stdio::null());
    c
}
#[test]
fn namespace_process_worker() {
    let Some(root) = std::env::var_os("ZORID_NAMESPACE_ROOT") else {
        return;
    };
    let folder = std::env::var("ZORID_NAMESPACE_FOLDER").unwrap() == "1";
    let delete = std::env::var("ZORID_NAMESPACE_DELETE").unwrap() == "1";
    let mut v = NativeVault::open(&root).unwrap();
    v.fault = Some(|point| {
        if std::env::var("ZORID_NAMESPACE_PHASE").ok().as_deref() != Some(point) {
            return;
        }
        let root = std::path::PathBuf::from(std::env::var_os("ZORID_NAMESPACE_ROOT").unwrap());
        let folder = std::env::var("ZORID_NAMESPACE_FOLDER").unwrap() == "1";
        let source = if folder { "Old" } else { "Old.blob" };
        match std::env::var("ZORID_NAMESPACE_ACTION").ok().as_deref() {
            Some("recreate-source") => {
                fs::rename(root.join(source), root.join("external-original")).unwrap();
                fs::write(root.join(source), b"base").unwrap();
            }
            Some("replace-destination-parent") => {
                fs::rename(root.join("Dest"), root.join("external-parent")).unwrap();
                fs::create_dir(root.join("Dest")).unwrap();
            }
            Some("replace-source-parent") => {
                fs::rename(root.join("Source"), root.join("external-parent")).unwrap();
                fs::create_dir(root.join("Source")).unwrap();
                fs::write(root.join("Source/Old.blob"), b"replacement").unwrap();
            }
            Some("new-source") => {
                fs::write(root.join(source), b"new occupant").unwrap();
            }
            Some("occupy-destination") => {
                fs::write(root.join("New.blob"), b"occupant").unwrap();
            }
            Some("recreate-destination") => {
                fs::rename(root.join("New.blob"), root.join("external-original")).unwrap();
                fs::write(root.join("New.blob"), b"base").unwrap();
            }
            Some("external-edit") => {
                fs::write(root.join(source), b"external edit").unwrap();
            }
            Some("late-child") => {
                fs::write(root.join("Old/late.blob"), b"unique child").unwrap();
            }
            _ => std::process::exit(77),
        }
    });
    let target_override = std::env::var("ZORID_NAMESPACE_TARGET").ok();
    let request = command(
        &v,
        "subject",
        if delete {
            None
        } else {
            Some(
                target_override
                    .as_deref()
                    .unwrap_or(if folder { "New" } else { "New.blob" }),
            )
        },
    );
    let outcome = v.apply(&request).unwrap();
    assert!(
        matches!(outcome.projection, ProjectionStatus::Pending(_)),
        "fault expected pending: {:?}",
        outcome
    );
}
#[test]
fn file_move_delete_and_original_receipts_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = fixture(dir.path(), false);
    let mv = command(&v, "subject", Some("New.blob"));
    let receipt = v.apply(&mv).unwrap();
    assert!(matches!(receipt.projection, ProjectionStatus::Projected));
    assert!(!dir.path().join("Old.blob").exists());
    assert_eq!(fs::read(dir.path().join("New.blob")).unwrap(), b"base");
    drop(v);
    let mut v = NativeVault::open(dir.path()).unwrap();
    assert_eq!(v.apply(&mv).unwrap().commit, receipt.commit);
    let mut delete = command(&v, "subject", None);
    delete.operation_id = op("delete-command");
    let deleted = v.apply(&delete).unwrap();
    assert!(
        matches!(deleted.projection, ProjectionStatus::Projected),
        "{:?}",
        deleted.projection
    );
    assert!(!dir.path().join("New.blob").exists());
    assert!(v.read(&eid("subject")).unwrap().is_none());
    let status = v.status().unwrap();
    let recovery = &status.namespace_attempts.last().unwrap().members[0].recovery_path;
    assert_eq!(fs::read(dir.path().join(recovery)).unwrap(), b"base");
    drop(v);
    let mut v = NativeVault::open(dir.path()).unwrap();
    assert!(v.recover().unwrap().blocked.is_empty());
    assert_eq!(v.apply(&delete).unwrap().commit, deleted.commit);
    assert!(matches!(
        v.apply(&mv).unwrap().projection,
        ProjectionStatus::Projected
    ));
}
#[test]
fn explicit_folder_members_move_then_delete_with_stable_ids() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = fixture(dir.path(), true);
    let mv = command(&v, "subject", Some("New"));
    let out = v.apply(&mv).unwrap();
    assert!(
        matches!(out.projection, ProjectionStatus::Projected),
        "{:?}",
        out.projection
    );
    assert!(!dir.path().join("Old").exists());
    assert!(dir.path().join("New/empty").is_dir());
    assert_eq!(
        fs::read(dir.path().join("New/nested/.bytes.blob")).unwrap(),
        [0, 255, 10, 128]
    );
    assert_eq!(
        v.read(&eid("leaf")).unwrap().unwrap().state.path,
        vp("New/nested/.bytes.blob")
    );
    let mut delete = command(&v, "subject", None);
    delete.operation_id = op("delete-folder");
    let out = v.apply(&delete).unwrap();
    assert!(
        matches!(out.projection, ProjectionStatus::Projected),
        "{:?}",
        out.projection
    );
    assert!(!dir.path().join("New").exists());
    assert!(v.list().unwrap().is_empty());
    let status = v.status().unwrap();
    let leaf = status
        .namespace_attempts
        .last()
        .unwrap()
        .members
        .iter()
        .find(|m| m.entry_id == eid("leaf"))
        .unwrap();
    assert_eq!(
        fs::read(dir.path().join(&leaf.recovery_path)).unwrap(),
        [0, 255, 10, 128]
    );
}
#[test]
fn case_only_file_and_folder_moves_use_private_intermediate() {
    for folder in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut v = fixture(dir.path(), folder);
        let request = command(&v, "subject", Some(if folder { "old" } else { "old.blob" }));
        let out = v.apply(&request).unwrap();
        assert!(
            matches!(out.projection, ProjectionStatus::Projected),
            "{:?}",
            out.projection
        );
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert!(names
            .iter()
            .any(|n| n.to_str() == Some(if folder { "old" } else { "old.blob" })));
        assert!(!names
            .iter()
            .any(|n| n.to_str() == Some(if folder { "Old" } else { "Old.blob" })));
        assert_eq!(
            fs::read(dir.path().join(if folder {
                "old/nested/.bytes.blob"
            } else {
                "old.blob"
            }))
            .unwrap(),
            if folder {
                vec![0, 255, 10, 128]
            } else {
                b"base".to_vec()
            }
        );
    }
}
#[test]
fn file_namespace_process_crashes_recover_exact_job_twice() {
    for delete in [false, true] {
        let mut phases = vec![
            "namespace_committed",
            "namespace_before_capture",
            "namespace_captured_before_record",
            "namespace_captured",
            "namespace_member_finished",
            "namespace_before_finish",
            "namespace_finished",
        ];
        if !delete {
            phases.extend(["namespace_published_before_record", "namespace_published"]);
        }
        for phase in phases {
            let dir = tempfile::tempdir().unwrap();
            let v = fixture(dir.path(), false);
            let request = command(&v, "subject", if delete { None } else { Some("New.blob") });
            drop(v);
            assert_eq!(
                child(dir.path(), false, delete)
                    .env("ZORID_NAMESPACE_PHASE", phase)
                    .status()
                    .unwrap()
                    .code(),
                Some(77),
                "{phase}"
            );
            for _ in 0..2 {
                let mut v = NativeVault::open(dir.path()).unwrap();
                let recovery = v.recover().unwrap();
                assert!(
                    recovery.blocked.is_empty(),
                    "{phase}: {:?}",
                    recovery.blocked
                );
                assert!(matches!(
                    v.apply(&request).unwrap().projection,
                    ProjectionStatus::Projected
                ));
            }
            assert!(!dir.path().join("Old.blob").exists());
            if !delete {
                assert_eq!(fs::read(dir.path().join("New.blob")).unwrap(), b"base");
            }
        }
    }
}
#[test]
fn folder_namespace_crashes_recover_partial_members_and_directory_stages() {
    for phase in [
        "namespace_captured_before_record",
        "namespace_captured",
        "namespace_directory_stage_written",
        "namespace_directory_staged",
        "namespace_directory_published_before_record",
        "namespace_member_finished",
        "namespace_before_finish",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let v = fixture(dir.path(), true);
        let request = command(&v, "subject", Some("New"));
        drop(v);
        assert_eq!(
            child(dir.path(), true, false)
                .env("ZORID_NAMESPACE_PHASE", phase)
                .status()
                .unwrap()
                .code(),
            Some(77),
            "{phase}"
        );
        for _ in 0..2 {
            let mut v = NativeVault::open(dir.path()).unwrap();
            let r = v.recover().unwrap();
            assert!(r.blocked.is_empty(), "{phase}: {:?}", r.blocked);
            assert!(matches!(
                v.apply(&request).unwrap().projection,
                ProjectionStatus::Projected
            ));
        }
        assert_eq!(
            fs::read(dir.path().join("New/nested/.bytes.blob")).unwrap(),
            [0, 255, 10, 128]
        );
    }
}
#[test]
fn source_recreation_before_capture_and_during_rename_is_preserved() {
    for phase in ["namespace_committed", "namespace_before_capture"] {
        let dir = tempfile::tempdir().unwrap();
        drop(fixture(dir.path(), false));
        assert!(child(dir.path(), false, true)
            .env("ZORID_NAMESPACE_PHASE", phase)
            .env("ZORID_NAMESPACE_ACTION", "recreate-source")
            .status()
            .unwrap()
            .success());
        let mut v = NativeVault::open(dir.path()).unwrap();
        assert!(!v.recover().unwrap().blocked.is_empty());
        assert_eq!(fs::read(dir.path().join("Old.blob")).unwrap(), b"base");
        assert_eq!(
            fs::read(dir.path().join("external-original")).unwrap(),
            b"base"
        );
        assert!(!v.status().unwrap().namespace_attempts[0].completed);
    }
}
#[test]
fn occupied_and_recreated_destination_never_overwritten() {
    for (phase, action, expected) in [
        (
            "namespace_captured",
            "occupy-destination",
            b"occupant".as_slice(),
        ),
        (
            "namespace_published_before_record",
            "recreate-destination",
            b"base".as_slice(),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        drop(fixture(dir.path(), false));
        assert!(child(dir.path(), false, false)
            .env("ZORID_NAMESPACE_PHASE", phase)
            .env("ZORID_NAMESPACE_ACTION", action)
            .status()
            .unwrap()
            .success());
        let mut v = NativeVault::open(dir.path()).unwrap();
        assert!(!v.recover().unwrap().blocked.is_empty());
        assert_eq!(fs::read(dir.path().join("New.blob")).unwrap(), expected);
        let status = v.status().unwrap();
        assert!(!status.namespace_attempts[0].completed);
        if action == "occupy-destination" {
            assert_eq!(
                fs::read(
                    dir.path()
                        .join(&status.namespace_attempts[0].members[0].recovery_path)
                )
                .unwrap(),
                b"base"
            );
        } else {
            assert_eq!(
                fs::read(dir.path().join("external-original")).unwrap(),
                b"base"
            );
        }
    }
}
#[test]
fn postcommit_external_edit_is_retained_with_observation() {
    let dir = tempfile::tempdir().unwrap();
    drop(fixture(dir.path(), false));
    assert!(child(dir.path(), false, true)
        .env("ZORID_NAMESPACE_PHASE", "namespace_committed")
        .env("ZORID_NAMESPACE_ACTION", "external-edit")
        .status()
        .unwrap()
        .success());
    let mut v = NativeVault::open(dir.path()).unwrap();
    assert!(!v.recover().unwrap().blocked.is_empty());
    let status = v.status().unwrap();
    assert!(!status.observations.is_empty());
    assert_eq!(
        fs::read(
            dir.path()
                .join(&status.namespace_attempts[0].members[0].recovery_path)
        )
        .unwrap(),
        b"external edit"
    );
}
#[test]
fn unlisted_child_is_not_swept_by_recursive_delete_or_scanner() {
    let dir = tempfile::tempdir().unwrap();
    drop(fixture(dir.path(), true));
    assert!(child(dir.path(), true, true)
        .env("ZORID_NAMESPACE_PHASE", "namespace_committed")
        .env("ZORID_NAMESPACE_ACTION", "late-child")
        .status()
        .unwrap()
        .success());
    let mut v = NativeVault::open(dir.path()).unwrap();
    assert!(!v.recover().unwrap().blocked.is_empty());
    let before = v.list().unwrap();
    let scan = v.rescan().unwrap();
    assert!(!scan.issues.is_empty());
    assert_eq!(v.list().unwrap(), before);
    assert_eq!(
        fs::read(dir.path().join("Old/late.blob")).unwrap(),
        b"unique child"
    );
    assert!(!v.status().unwrap().namespace_attempts[0].completed);
}
#[test]
fn late_open_file_and_directory_handles_remain_recoverable_after_delete() {
    use std::io::{Seek, SeekFrom, Write};
    let dir = tempfile::tempdir().unwrap();
    let mut v = fixture(dir.path(), false);
    let mut handle = fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join("Old.blob"))
        .unwrap();
    let request = command(&v, "subject", None);
    assert!(matches!(
        v.apply(&request).unwrap().projection,
        ProjectionStatus::Projected
    ));
    handle.seek(SeekFrom::Start(0)).unwrap();
    handle.write_all(b"late").unwrap();
    handle.sync_all().unwrap();
    assert!(!v.recover().unwrap().blocked.is_empty());
    let status = v.status().unwrap();
    assert_eq!(
        fs::read(
            dir.path()
                .join(&status.namespace_attempts[0].members[0].recovery_path)
        )
        .unwrap(),
        b"late"
    );
    assert!(!status.observations.is_empty());
    let dir = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    add(&mut v, "subject", "Old", None);
    let old = fs::File::open(dir.path().join("Old")).unwrap();
    let request = command(&v, "subject", None);
    assert!(matches!(
        v.apply(&request).unwrap().projection,
        ProjectionStatus::Projected
    ));
    crate::fs::stage(&old, "late.blob", b"late child").unwrap();
    crate::fs::stage(&old, "other.blob", b"second child").unwrap();
    assert!(!v.recover().unwrap().blocked.is_empty());
    let status = v.status().unwrap();
    assert_eq!(
        fs::read(
            dir.path()
                .join(&status.namespace_attempts[0].members[0].recovery_path)
                .join("late.blob")
        )
        .unwrap(),
        b"late child"
    );
}
#[test]
fn external_edit_before_command_preserves_original_revision_cas() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = fixture(dir.path(), false);
    let request = command(&v, "subject", None);
    fs::write(dir.path().join("Old.blob"), b"external").unwrap();
    assert!(v.apply(&request).is_err());
    assert_eq!(fs::read(dir.path().join("Old.blob")).unwrap(), b"external");
    assert!(v.status().unwrap().namespace_attempts.is_empty());
}
#[test]
fn legacy_unproven_job_is_pending_and_never_adopts_identical_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let v = fixture(dir.path(), false);
    let request = command(&v, "subject", None);
    drop(v);
    let mut store = zorid_store::Store::open(dir.path().join(".zorid/vault.sqlite")).unwrap();
    store.apply(&request).unwrap();
    drop(store);
    fs::rename(
        dir.path().join("Old.blob"),
        dir.path().join("external-original"),
    )
    .unwrap();
    fs::write(dir.path().join("Old.blob"), b"base").unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    assert!(!v.recover().unwrap().blocked.is_empty());
    assert!(matches!(
        v.apply(&request).unwrap().projection,
        ProjectionStatus::Pending(_)
    ));
    assert_eq!(fs::read(dir.path().join("Old.blob")).unwrap(), b"base");
    assert!(v.status().unwrap().namespace_attempts.is_empty());
}
#[test]
fn prior_file_projection_crashes_are_settled_before_namespace_commit() {
    for phase in ["prepared", "staged", "displaced", "published_before_record"] {
        let dir = tempfile::tempdir().unwrap();
        let mut v = NativeVault::open(dir.path()).unwrap();
        add(&mut v, "file", "note.unknown", Some(b"base"));
        drop(v);
        let code = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::process_worker", "--nocapture"])
            .env("ZORID_NATIVE_TEST_ROOT", dir.path())
            .env("ZORID_NATIVE_TEST_MODE", "crash")
            .env("ZORID_NATIVE_TEST_PHASE", phase)
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .code();
        assert_eq!(code, Some(77));
        let mut v = NativeVault::open(dir.path()).unwrap();
        let request = command(&v, "file", Some("moved.blob"));
        let out = v.apply(&request).unwrap();
        assert!(
            matches!(out.projection, ProjectionStatus::Projected),
            "{phase}: {:?}",
            out.projection
        );
        assert_eq!(fs::read(dir.path().join("moved.blob")).unwrap(), b"desired");
    }
}

#[test]
fn replaced_source_and_destination_parents_keep_all_occupants() {
    for source in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut v = NativeVault::open(dir.path()).unwrap();
        if source {
            add(&mut v, "parent", "Source", None);
            add(&mut v, "subject", "Source/Old.blob", Some(b"base"));
        } else {
            add(&mut v, "subject", "Old.blob", Some(b"base"));
            add(&mut v, "parent", "Dest", None);
        }
        drop(v);
        assert!(child(dir.path(), false, false)
            .env(
                "ZORID_NAMESPACE_TARGET",
                if source { "New.blob" } else { "Dest/New.blob" }
            )
            .env("ZORID_NAMESPACE_PHASE", "namespace_committed")
            .env(
                "ZORID_NAMESPACE_ACTION",
                if source {
                    "replace-source-parent"
                } else {
                    "replace-destination-parent"
                }
            )
            .status()
            .unwrap()
            .success());
        let mut v = NativeVault::open(dir.path()).unwrap();
        assert!(!v.recover().unwrap().blocked.is_empty());
        assert!(!v.status().unwrap().namespace_attempts[0].completed);
        if source {
            assert_eq!(
                fs::read(dir.path().join("Source/Old.blob")).unwrap(),
                b"replacement"
            );
            assert_eq!(
                fs::read(dir.path().join("external-parent/Old.blob")).unwrap(),
                b"base"
            );
        } else {
            assert!(!dir.path().join("Dest/New.blob").exists());
            assert_eq!(
                fs::read(
                    dir.path()
                        .join(&v.status().unwrap().namespace_attempts[0].members[0].recovery_path)
                )
                .unwrap(),
                b"base"
            );
        }
    }
}
#[test]
fn postcapture_new_source_survives_delete_and_is_imported_as_new_identity() {
    let dir = tempfile::tempdir().unwrap();
    drop(fixture(dir.path(), false));
    // Stop after capture, then independently recreate the source before recovery.
    assert_eq!(
        child(dir.path(), false, true)
            .env("ZORID_NAMESPACE_PHASE", "namespace_captured")
            .status()
            .unwrap()
            .code(),
        Some(77)
    );
    fs::write(dir.path().join("Old.blob"), b"new occupant").unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    assert!(v.recover().unwrap().blocked.is_empty());
    assert_eq!(
        fs::read(dir.path().join("Old.blob")).unwrap(),
        b"new occupant"
    );
    v.rescan().unwrap();
    let live = v.list().unwrap();
    assert_eq!(live.len(), 1);
    assert_ne!(live[0].id, eid("subject"));
    assert_eq!(
        v.read(&live[0].id).unwrap().unwrap().content.unwrap(),
        b"new occupant"
    );
}
#[test]
fn same_path_move_preserves_inode_and_completes_only_its_job() {
    use std::os::unix::fs::MetadataExt;
    for folder in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut v = fixture(dir.path(), folder);
        let p = if folder { "Old" } else { "Old.blob" };
        let inode = fs::metadata(dir.path().join(p)).unwrap().ino();
        let request = command(&v, "subject", Some(p));
        let out = v.apply(&request).unwrap();
        assert!(
            matches!(out.projection, ProjectionStatus::Projected),
            "{:?}",
            out.projection
        );
        assert_eq!(fs::metadata(dir.path().join(p)).unwrap().ino(), inode);
        assert!(matches!(
            v.apply(&request).unwrap().projection,
            ProjectionStatus::Projected
        ));
        assert!(v.status().unwrap().namespace_attempts[0].completed);
    }
}
#[cfg(target_os = "linux")]
#[test]
fn non_utf8_retained_child_is_reported_without_aborting_recovery() {
    use std::os::unix::ffi::OsStringExt;
    let dir = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    add(&mut v, "subject", "Old", None);
    let request = command(&v, "subject", None);
    v.apply(&request).unwrap();
    let location = v.status().unwrap().namespace_attempts[0].members[0]
        .recovery_path
        .clone();
    fs::write(
        dir.path()
            .join(location)
            .join(std::ffi::OsString::from_vec(vec![255])),
        b"retained",
    )
    .unwrap();
    let report = v.recover().unwrap();
    assert!(!report.blocked.is_empty());
}

#[test]
fn completed_retention_disappearance_is_reported_without_guessing_gc() {
    for folder in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut v = NativeVault::open(dir.path()).unwrap();
        add(
            &mut v,
            "subject",
            if folder { "Old" } else { "Old.blob" },
            if folder { None } else { Some(b"base") },
        );
        let request = command(&v, "subject", None);
        assert!(matches!(
            v.apply(&request).unwrap().projection,
            ProjectionStatus::Projected
        ));
        let status = v.status().unwrap();
        let retained = &status.namespace_attempts[0].members[0].recovery_path;
        fs::rename(
            dir.path().join(retained),
            dir.path().join("externally-relocated-capture"),
        )
        .unwrap();
        let report = v.recover().unwrap();
        assert!(report
            .blocked
            .iter()
            .any(|(_, reason)| reason.contains("missing") && reason.contains(retained)));
        assert!(dir.path().join("externally-relocated-capture").exists());
        assert!(v.status().unwrap().namespace_attempts[0].completed);
    }
}
#[test]
fn child_arriving_after_empty_check_is_restored_not_swept() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    add(&mut v, "subject", "Old", None);
    drop(v);
    assert!(child(dir.path(), true, true)
        .env("ZORID_NAMESPACE_PHASE", "namespace_before_capture")
        .env("ZORID_NAMESPACE_ACTION", "late-child")
        .status()
        .unwrap()
        .success());
    assert_eq!(
        fs::read(dir.path().join("Old/late.blob")).unwrap(),
        b"unique child"
    );
    let mut v = NativeVault::open(dir.path()).unwrap();
    assert!(!v.recover().unwrap().blocked.is_empty());
    assert!(!v.status().unwrap().namespace_attempts[0].completed);
    assert_eq!(
        fs::read(dir.path().join("Old/late.blob")).unwrap(),
        b"unique child"
    );
}
