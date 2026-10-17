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

#[test]
fn hidden_active_publications_preserve_attempts_baselines_and_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut store = Store::open(&db).unwrap();
    for (name, kind) in [
        ("hidden-file", EntryKind::File),
        ("hidden-folder", EntryKind::Folder),
    ] {
        let id = EntryId::new(name).unwrap();
        store
            .apply(&MutationRequest {
                operation_id: op(name),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: VaultPath::new(name).unwrap(),
                    kind,
                    content: (kind == EntryKind::File).then(|| b"pending".to_vec()),
                },
            })
            .unwrap();
        let attempt = if kind == EntryKind::File {
            let attempt = store.begin_projection_bound(&id, "parent").unwrap();
            store
                .mark_projection(
                    &attempt.attempt_id,
                    ProjectionPhase::Staged,
                    Some("stage".into()),
                )
                .unwrap();
            attempt.attempt_id
        } else {
            let attempt = store
                .begin_directory_projection_bound(&id, "parent")
                .unwrap();
            store
                .mark_directory_projection(
                    &attempt.attempt_id,
                    zorid_store::DirectoryPhase::Staged,
                    Some("stage".into()),
                )
                .unwrap();
            attempt.attempt_id
        };
        let jobs = store.pending_projection_jobs(100).unwrap();
        let files = store.projection_attempts(false).unwrap();
        let folders = store.directory_attempts(false).unwrap();
        let connection = rusqlite::Connection::open(&db).unwrap();
        // Simulate the visibility transition committed by family materialization.
        assert_eq!(
            connection
                .execute("UPDATE entries SET visible=0 WHERE id=?1", [id.as_str()])
                .unwrap(),
            1
        );
        assert!(!store.is_visible_entry(&id).unwrap());
        if kind == EntryKind::File {
            assert!(store.begin_projection_bound(&id, "parent").is_err());
            assert!(store
                .mark_projection(&attempt, ProjectionPhase::Published, None)
                .is_err());
            assert!(store
                .finish_projection_bound(&attempt, &physical("stage", "parent"))
                .is_err());
            assert!(store.finish_projection(&attempt, false).is_err());
        } else {
            assert!(store
                .begin_directory_projection_bound(&id, "parent")
                .is_err());
            assert!(store
                .mark_directory_projection(&attempt, zorid_store::DirectoryPhase::Published, None)
                .is_err());
            assert!(store
                .finish_directory_projection_bound(&attempt, &physical("stage", "parent"))
                .is_err());
        }
        assert_eq!(store.projection_attempts(false).unwrap(), files);
        assert_eq!(store.directory_attempts(false).unwrap(), folders);
        assert_eq!(store.pending_projection_jobs(100).unwrap(), jobs);
        assert!(store.projection_baseline(&id).unwrap().is_none());
        assert!(store.directory_baseline(&id).unwrap().is_none());
        assert!(store.physical_binding(&id).unwrap().is_none());
    }
}

#[test]
fn directory_completion_records_attempt_target_after_child_revision_advances() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let folder = EntryId::new("folder").unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("create-folder"),
            mutation: Mutation::Create {
                id: folder.clone(),
                path: VaultPath::new("folder").unwrap(),
                kind: EntryKind::Folder,
                content: None,
            },
        })
        .unwrap();
    let attempt = store
        .begin_directory_projection_bound(&folder, "parent")
        .unwrap();
    store
        .mark_directory_projection(
            &attempt.attempt_id,
            zorid_store::DirectoryPhase::Staged,
            Some("stage".into()),
        )
        .unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("create-child"),
            mutation: Mutation::Create {
                id: EntryId::new("child").unwrap(),
                path: VaultPath::new("folder/child").unwrap(),
                kind: EntryKind::File,
                content: Some(b"child".to_vec()),
            },
        })
        .unwrap();
    assert_ne!(
        store.read(&folder).unwrap().unwrap().state.revision,
        attempt.target.revision
    );
    store
        .finish_directory_projection_bound(&attempt.attempt_id, &physical("stage", "parent"))
        .unwrap();
    assert_eq!(
        store.directory_baseline(&folder).unwrap().unwrap().state,
        attempt.target
    );
    assert_eq!(
        store.physical_binding(&folder).unwrap().unwrap().state,
        attempt.target
    );
    let pending = store.pending_projection_jobs(100).unwrap();
    assert_eq!(pending.len(), 1);
    let current = store.read(&folder).unwrap().unwrap().state;
    store
        .bind_directory_bound(&current, &physical("stage", "parent"))
        .unwrap();
    assert_eq!(
        store.directory_baseline(&folder).unwrap().unwrap().state,
        current
    );
    assert_eq!(
        store.physical_binding(&folder).unwrap().unwrap().state,
        current
    );
    assert_eq!(store.pending_projection_jobs(100).unwrap(), pending);
}
