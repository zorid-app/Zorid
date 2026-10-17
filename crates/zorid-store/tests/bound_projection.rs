use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{ObservationPhysical, PhysicalIdentity, ProjectionPhase, Store};
fn physical(inode: &str, parent: &str) -> PhysicalIdentity {
    PhysicalIdentity {
        inode: inode.into(),
        parent_inode: parent.into(),
    }
}
fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn eid() -> EntryId {
    EntryId::new("file").unwrap()
}
fn vp() -> VaultPath {
    VaultPath::new("note.md").unwrap()
}
fn import(s: &mut Store) {
    let obs = s
        .record_external_bound(
            &vp(),
            None,
            b"before".to_vec(),
            &ObservationPhysical {
                physical: physical("old-inode", "parent"),
                expected_binding: None,
            },
        )
        .unwrap();
    s.import_observation(
        &obs.observation_id,
        &MutationRequest {
            operation_id: obs.observation_id.clone(),
            mutation: Mutation::Create {
                id: eid(),
                path: vp(),
                kind: EntryKind::File,
                content: Some(b"before".to_vec()),
            },
        },
    )
    .unwrap();
}
#[test]
fn bound_file_finish_rejects_wrong_proof_and_rolls_back_baseline_binding_and_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    import(&mut s);
    let before = s.physical_binding(&eid()).unwrap().unwrap();
    let base = s.projection_baseline(&eid()).unwrap().unwrap();
    s.apply(&MutationRequest {
        operation_id: op("write"),
        mutation: Mutation::Write {
            id: eid(),
            expected: before.state.revision.clone(),
            content: b"after".to_vec(),
        },
    })
    .unwrap();
    let a = s.begin_projection_bound(&eid(), "parent").unwrap();
    s.mark_projection(&a.attempt_id, ProjectionPhase::Staged, Some("stage".into()))
        .unwrap();
    let pending = s.pending_projection_jobs(100).unwrap();
    assert!(s
        .finish_projection_bound(&a.attempt_id, &physical("stage", "wrong-parent"))
        .is_err());
    assert!(s.finish_projection(&a.attempt_id, true).is_err());
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch("CREATE TRIGGER fail_binding BEFORE INSERT ON physical_bindings BEGIN SELECT RAISE(ABORT,'binding commit failure'); END;").unwrap();
    assert!(s
        .finish_projection_bound(&a.attempt_id, &physical("stage", "parent"))
        .is_err());
    assert_eq!(s.physical_binding(&eid()).unwrap(), Some(before));
    assert_eq!(s.projection_baseline(&eid()).unwrap(), Some(base));
    assert_eq!(s.pending_projection_jobs(100).unwrap(), pending);
    assert_eq!(s.projection_attempts(false).unwrap().len(), 1);
    c.execute_batch("DROP TRIGGER fail_binding").unwrap();
    s.finish_projection_bound(&a.attempt_id, &physical("stage", "parent"))
        .unwrap();
    let binding = s.physical_binding(&eid()).unwrap().unwrap();
    assert_eq!(
        binding.state,
        s.projection_baseline(&eid()).unwrap().unwrap().state
    );
    assert_eq!(binding.physical, physical("stage", "parent"));
    assert!(s.pending_projection_jobs(100).unwrap().is_empty());
    drop(s);
    let s = Store::open(&db).unwrap();
    assert_eq!(s.physical_binding(&eid()).unwrap(), Some(binding));
}
#[test]
fn first_folder_import_rolls_back_without_splitting_baseline_and_logical_state() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    let req = MutationRequest {
        operation_id: op("folder-import"),
        mutation: Mutation::Create {
            id: EntryId::new("folder").unwrap(),
            path: VaultPath::new("folder").unwrap(),
            kind: EntryKind::Folder,
            content: None,
        },
    };
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch("CREATE TRIGGER fail_folder_binding BEFORE INSERT ON physical_bindings BEGIN SELECT RAISE(ABORT,'folder binding failure'); END;").unwrap();
    assert!(s
        .import_directory_bound(&req, &physical("folder-inode", "parent"))
        .is_err());
    assert!(s.read(req.mutation.id()).unwrap().is_none());
    assert!(s.directory_baseline(req.mutation.id()).unwrap().is_none());
    assert!(s.physical_binding(req.mutation.id()).unwrap().is_none());
    assert!(s.pending_projection_jobs(100).unwrap().is_empty());
    c.execute_batch("DROP TRIGGER fail_folder_binding").unwrap();
    let result = s
        .import_directory_bound(&req, &physical("folder-inode", "parent"))
        .unwrap();
    let binding = s.physical_binding(req.mutation.id()).unwrap().unwrap();
    assert_eq!(
        binding.state,
        s.directory_baseline(req.mutation.id())
            .unwrap()
            .unwrap()
            .state
    );
    assert_eq!(binding.physical, physical("folder-inode", "parent"));
    assert!(s.pending_projection_jobs(100).unwrap().is_empty());
    // Receipt replay does not adopt a newly supplied physical occupant.
    assert_eq!(
        s.import_directory_bound(&req, &physical("replacement", "different-parent"))
            .unwrap(),
        result
    );
    assert_eq!(
        s.physical_binding(req.mutation.id()).unwrap(),
        Some(binding)
    );
}
