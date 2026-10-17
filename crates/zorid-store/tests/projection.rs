use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{ProjectionPhase, Store};
fn create(id: &str, path: &str, kind: EntryKind) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(format!("create-{id}")).unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new(id).unwrap(),
            path: VaultPath::new(path).unwrap(),
            kind,
            content: (kind == EntryKind::File).then(|| b"original".to_vec()),
        },
    }
}
fn downgrade(path: &std::path::Path) {
    let c = rusqlite::Connection::open(path).unwrap();
    c.execute_batch("DROP TABLE directory_baselines; DROP TABLE directory_attempts; DROP TABLE scan_observations; DROP TABLE scan_directories; DROP TABLE scan_runs; DROP TABLE projection_baselines; DROP TABLE projection_attempts; DROP TABLE external_observations; PRAGMA user_version=1; PRAGMA journal_mode=DELETE;").unwrap();
}
#[test]
fn migrates_v1_preserving_receipts_and_intents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let req = create("file", "note", EntryKind::File);
    let receipt = Store::open(&path).unwrap().apply(&req).unwrap();
    downgrade(&path);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.apply(&req).unwrap(), receipt);
    assert_eq!(store.pending_counts().unwrap(), (1, 1));
    assert!(store.projection_attempts(false).unwrap().is_empty());
    let c = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}
#[test]
fn malformed_or_foreign_v1_is_rejected_before_wal_change() {
    for change in ["DROP INDEX live_paths", "PRAGMA application_id=42"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        drop(Store::open(&path).unwrap());
        downgrade(&path);
        {
            let c = rusqlite::Connection::open(&path).unwrap();
            c.execute_batch(change).unwrap();
        }
        assert!(Store::open(&path).is_err());
        let c = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
#[test]
fn v2_requires_canonical_constraints() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    drop(Store::open(&path).unwrap());
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("DROP INDEX active_projection; CREATE INDEX active_projection ON projection_attempts(entry_id) WHERE completed=0").unwrap();
    assert!(Store::open(&path).is_err());
}
#[test]
fn older_publication_keeps_later_file_and_folder_intents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&create("folder", "folder", EntryKind::Folder))
        .unwrap();
    store
        .apply(&create("file", "folder/note", EntryKind::File))
        .unwrap();
    let id = EntryId::new("file").unwrap();
    let a = store.begin_projection(&id).unwrap();
    store
        .mark_projection(
            &a.attempt_id,
            ProjectionPhase::Staged,
            Some("dev:ino".into()),
        )
        .unwrap();
    let req = MutationRequest {
        operation_id: OperationId::new("write").unwrap(),
        mutation: Mutation::Write {
            id: id.clone(),
            expected: a.target.state.revision.clone(),
            content: b"newer".to_vec(),
        },
    };
    store.apply(&req).unwrap();
    store.finish_projection(&a.attempt_id, true).unwrap();
    assert_eq!(store.pending_counts().unwrap(), (3, 2));
    assert_eq!(
        store.projection_baseline(&id).unwrap().unwrap().content,
        b"original"
    );
    assert_eq!(store.read(&id).unwrap().unwrap().content.unwrap(), b"newer");
    let next = store.begin_projection(&id).unwrap();
    assert_eq!(next.baseline.unwrap().content, b"original");
    assert_eq!(serde_json::to_value(&next.through_sequence).unwrap(), "3");
}
#[test]
fn import_conflict_keeps_unresolved_external_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let req = create("file", "note", EntryKind::File);
    store.apply(&req).unwrap();
    let id = EntryId::new("file").unwrap();
    let a = store.begin_projection(&id).unwrap();
    store
        .mark_projection(
            &a.attempt_id,
            ProjectionPhase::Staged,
            Some("identity".into()),
        )
        .unwrap();
    store.finish_projection(&a.attempt_id, true).unwrap();
    let base = store.projection_baseline(&id).unwrap().unwrap();
    let observation = store
        .record_external(&base.state.path, Some(base.clone()), b"external".to_vec())
        .unwrap();
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("db-write").unwrap(),
            mutation: Mutation::Write {
                id: id.clone(),
                expected: base.state.revision.clone(),
                content: b"db".to_vec(),
            },
        })
        .unwrap();
    let import = MutationRequest {
        operation_id: observation.observation_id.clone(),
        mutation: Mutation::Write {
            id,
            expected: base.state.revision,
            content: b"external".to_vec(),
        },
    };
    assert!(store
        .import_observation(&observation.observation_id, &import)
        .is_err());
    assert_eq!(store.external_observations().unwrap(), vec![observation]);
}

#[test]
fn corrupt_projection_rows_fail_before_metadata_mutation() {
    for corruption in [
        "UPDATE entries SET state=json_set(state,'$.id','wrong')",
        "UPDATE projection_attempts SET record=json_set(record,'$.attempt_id','wrong')",
        "UPDATE projection_attempts SET record=json_set(record,'$.target.state.kind','folder')",
        "UPDATE projection_attempts SET record=json_set(record,'$.through_sequence','01')",
        "UPDATE projection_attempts SET record=json_set(record,'$.baseline',json_object('state',json_extract(record,'$.target.state'),'content',json_array()))",
    ] {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("db");let mut store=Store::open(&path).unwrap();store.apply(&create("file","note",EntryKind::File)).unwrap();let id=EntryId::new("file").unwrap();
        let a=store.begin_projection(&id).unwrap();let db=rusqlite::Connection::open(&path).unwrap();
        if corruption.contains("'$.baseline'") {
            // A baseline bound to another entry must be rejected.
            db.execute_batch(corruption).unwrap();db.execute_batch("UPDATE projection_attempts SET record=json_set(record,'$.baseline.state.id','wrong')").unwrap();
        } else {db.execute_batch(corruption).unwrap();}
        let before:String=db.query_row("SELECT record FROM projection_attempts",[],|r|r.get(0)).unwrap();
        if corruption.starts_with("UPDATE entries") {
            db.execute("DELETE FROM projection_attempts",[]).unwrap();assert!(store.begin_projection(&id).is_err());
            assert_eq!(db.query_row("SELECT count(*) FROM projection_attempts",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        } else {
            assert!(store.projection_attempts(true).is_err());assert!(store.mark_projection(&a.attempt_id,ProjectionPhase::Staged,Some("inode".into())).is_err());
            let after:String=db.query_row("SELECT record FROM projection_attempts",[],|r|r.get(0)).unwrap();assert_eq!(before,after);
        }
    }
}
