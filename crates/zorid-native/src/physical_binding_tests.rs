use super::*;
use std::{
    fs as stdfs,
    process::{Command, Stdio},
};
use zorid_core::Revision;

fn id() -> EntryId {
    EntryId::new("bound-file").unwrap()
}
fn path() -> VaultPath {
    VaultPath::new("folder/file.md").unwrap()
}
fn create(v: &mut NativeVault) {
    let folder = v
        .apply(&MutationRequest {
            operation_id: OperationId::new("create-folder").unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new("bound-folder").unwrap(),
                path: VaultPath::new("folder").unwrap(),
                kind: EntryKind::Folder,
                content: None,
            },
        })
        .unwrap();
    assert!(
        matches!(folder.projection, ProjectionStatus::Projected),
        "{folder:?}"
    );
    let result = v
        .apply(&MutationRequest {
            operation_id: OperationId::new("create-bound").unwrap(),
            mutation: Mutation::Create {
                id: id(),
                path: path(),
                kind: EntryKind::File,
                content: Some(b"before".to_vec()),
            },
        })
        .unwrap();
    assert!(
        matches!(result.projection, ProjectionStatus::Projected),
        "{result:?}"
    );
}
fn write(revision: Revision) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("write-bound").unwrap(),
        mutation: Mutation::Write {
            id: id(),
            expected: revision,
            content: b"after".to_vec(),
        },
    }
}
fn binding(v: &NativeVault) -> zorid_store::PhysicalBinding {
    v.store.physical_binding(&id()).unwrap().unwrap()
}
#[test]
fn fresh_file_folder_import_binds_physical_baseline_atomically() {
    let dir = tempfile::tempdir().unwrap();
    stdfs::create_dir(dir.path().join("folder")).unwrap();
    stdfs::write(dir.path().join("folder/file.md"), b"external").unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    let report = v.reconcile(&[path()]).unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    for state in v.list().unwrap() {
        let b = v.store.physical_binding(&state.id).unwrap().unwrap();
        let baseline = if state.kind == EntryKind::File {
            v.store
                .projection_baseline(&state.id)
                .unwrap()
                .unwrap()
                .state
        } else {
            v.store
                .directory_baseline(&state.id)
                .unwrap()
                .unwrap()
                .state
        };
        assert_eq!(b.state, baseline);
        assert_eq!(b.state.path, state.path);
        let (parent, name) = v.paths.parent(&state.path).unwrap();
        assert_eq!(b.physical.parent_inode, fs::identity(&parent).unwrap());
        let actual = if state.kind == EntryKind::File {
            fs::snapshot(&parent, &name, 1024)
                .unwrap()
                .unwrap()
                .identity
        } else {
            fs::identity(&v.paths.directory(&state.path).unwrap()).unwrap()
        };
        assert_eq!(b.physical.inode, actual);
    }
    let before = v
        .list()
        .unwrap()
        .into_iter()
        .map(|s| v.store.physical_binding(&s.id).unwrap().unwrap())
        .collect::<Vec<_>>();
    drop(v);
    let v = NativeVault::open(dir.path()).unwrap();
    for b in before {
        assert_eq!(v.store.physical_binding(&b.state.id).unwrap(), Some(b));
    }
}
#[test]
fn external_atomic_save_updates_binding_but_equal_bytes_do_not_authorize_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    create(&mut v);
    let old = binding(&v);
    stdfs::write(dir.path().join("replacement"), b"external").unwrap();
    stdfs::rename(
        dir.path().join("replacement"),
        dir.path().join(path().as_str()),
    )
    .unwrap();
    let report = v.reconcile(&[path()]).unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    let edited = binding(&v);
    assert_ne!(old.physical.inode, edited.physical.inode);
    assert_ne!(old.state.revision, edited.state.revision);
    assert_eq!(
        v.read(&id()).unwrap().unwrap().content.unwrap(),
        b"external"
    );
    stdfs::write(dir.path().join("replacement"), b"external").unwrap();
    stdfs::rename(
        dir.path().join("replacement"),
        dir.path().join(path().as_str()),
    )
    .unwrap();
    let report = v.reconcile(&[path()]).unwrap();
    assert!(!report.blocked.is_empty());
    assert_eq!(binding(&v), edited);
    assert_eq!(
        stdfs::read(dir.path().join(path().as_str())).unwrap(),
        b"external"
    );
}
fn crash(root: &std::path::Path, phase: &str) {
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "native::physical_binding_tests::binding_crash_worker",
            "--nocapture",
        ])
        .env("ZORID_BINDING_TEST_ROOT", root)
        .env("ZORID_BINDING_TEST_PHASE", phase)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(77));
}
#[test]
fn binding_crash_worker() {
    let Some(root) = std::env::var_os("ZORID_BINDING_TEST_ROOT") else {
        return;
    };
    let mut v = NativeVault::open(root).unwrap();
    v.fault = Some(|point| {
        if std::env::var("ZORID_BINDING_TEST_PHASE").unwrap() == point {
            std::process::exit(77)
        }
    });
    let revision = v.read(&id()).unwrap().unwrap().state.revision;
    v.apply(&write(revision)).unwrap();
    panic!("fault not reached");
}
#[test]
fn publication_parent_and_prior_inode_survive_restart_before_displacement() {
    for replace_parent in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut v = NativeVault::open(dir.path()).unwrap();
        create(&mut v);
        let original = binding(&v);
        drop(v);
        crash(dir.path(), "prepared");
        if replace_parent {
            stdfs::rename(
                dir.path().join("folder"),
                dir.path().join("original-folder"),
            )
            .unwrap();
            stdfs::create_dir(dir.path().join("folder")).unwrap();
            stdfs::write(dir.path().join(path().as_str()), b"before").unwrap();
        } else {
            stdfs::write(dir.path().join("replacement"), b"before").unwrap();
            stdfs::rename(
                dir.path().join("replacement"),
                dir.path().join(path().as_str()),
            )
            .unwrap();
        }
        let mut v = NativeVault::open(dir.path()).unwrap();
        let report = v.recover().unwrap();
        assert!(!report.blocked.is_empty(), "{report:?}");
        assert_eq!(binding(&v), original);
        assert_eq!(
            stdfs::read(dir.path().join(path().as_str())).unwrap(),
            b"before"
        );
        assert_eq!(v.read(&id()).unwrap().unwrap().content.unwrap(), b"after");
    }
}
#[test]
fn publication_binding_is_committed_with_recovered_baseline_at_each_phase() {
    for phase in [
        "prepared",
        "staged",
        "displaced_before_record",
        "published_before_record",
        "before_baseline",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut v = NativeVault::open(dir.path()).unwrap();
        create(&mut v);
        let before = binding(&v);
        drop(v);
        crash(dir.path(), phase);
        let mut v = NativeVault::open(dir.path()).unwrap();
        let report = v.recover().unwrap();
        assert!(report.blocked.is_empty(), "{phase}: {report:?}");
        let after = binding(&v);
        assert_ne!(after.physical.inode, before.physical.inode);
        assert_eq!(
            after.state,
            v.store.projection_baseline(&id()).unwrap().unwrap().state
        );
        let (parent, name) = v.paths.parent(&path()).unwrap();
        assert_eq!(
            after.physical.inode,
            fs::snapshot(&parent, &name, 1024)
                .unwrap()
                .unwrap()
                .identity
        );
        assert_eq!(after.physical.parent_inode, fs::identity(&parent).unwrap());
        assert_eq!(
            stdfs::read(dir.path().join(path().as_str())).unwrap(),
            b"after"
        );
        assert!(v.recover().unwrap().blocked.is_empty());
    }
}

#[test]
fn changed_bytes_under_replaced_parent_do_not_rebind_original_entry() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    create(&mut v);
    let original = binding(&v);
    stdfs::rename(
        dir.path().join("folder"),
        dir.path().join("original-folder"),
    )
    .unwrap();
    stdfs::create_dir(dir.path().join("folder")).unwrap();
    stdfs::write(
        dir.path().join(path().as_str()),
        b"replacement parent contents",
    )
    .unwrap();
    let report = v.reconcile(&[path()]).unwrap();
    assert!(!report.blocked.is_empty());
    assert_eq!(binding(&v), original);
    assert_eq!(v.read(&id()).unwrap().unwrap().content.unwrap(), b"before");
    assert_eq!(
        stdfs::read(dir.path().join(path().as_str())).unwrap(),
        b"replacement parent contents"
    );
    assert_eq!(
        stdfs::read(dir.path().join("original-folder/file.md")).unwrap(),
        b"before"
    );
}
