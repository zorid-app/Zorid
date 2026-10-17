use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{PhysicalBinding, PhysicalIdentity, ProjectionBaseline, Store};

fn fixture() -> (tempfile::TempDir, Store, PhysicalBinding) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let id = EntryId::new("file").unwrap();
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("create").unwrap(),
            mutation: Mutation::Create {
                id: id.clone(),
                path: VaultPath::new("note.md").unwrap(),
                kind: EntryKind::File,
                content: Some(b"saved".to_vec()),
            },
        })
        .unwrap();
    let state = store.read(&id).unwrap().unwrap().state;
    let binding = PhysicalBinding {
        state: state.clone(),
        physical: PhysicalIdentity {
            inode: "device:inode".into(),
            parent_inode: "device:parent".into(),
        },
    };
    let db = rusqlite::Connection::open(dir.path().join("db")).unwrap();
    db.execute(
        "INSERT INTO projection_baselines(entry_id,record) VALUES(?1,?2)",
        rusqlite::params![
            id.as_str(),
            serde_json::to_string(&ProjectionBaseline {
                state,
                content: b"saved".to_vec()
            })
            .unwrap()
        ],
    )
    .unwrap();
    db.execute("INSERT INTO physical_bindings(entry_id,path,revision,kind,inode,parent_inode,record) VALUES(?1,?2,?3,'file',?4,?5,?6)",rusqlite::params![id.as_str(),binding.state.path.as_str(),binding.state.revision.as_str(),binding.physical.inode,binding.physical.parent_inode,serde_json::to_string(&binding).unwrap()]).unwrap();
    (dir, store, binding)
}
#[test]
fn physical_binding_survives_restart_without_rebinding() {
    let (dir, store, binding) = fixture();
    assert_eq!(
        store.physical_binding(&binding.state.id).unwrap(),
        Some(binding.clone())
    );
    drop(store);
    let store = Store::open(dir.path().join("db")).unwrap();
    assert_eq!(
        store.physical_binding(&binding.state.id).unwrap(),
        Some(binding)
    );
}
#[test]
fn physical_binding_column_and_baseline_corruption_fails_closed() {
    for sql in [
        "UPDATE physical_bindings SET inode='different'",
        "UPDATE physical_bindings SET parent_inode='different'",
        "UPDATE physical_bindings SET path='elsewhere'",
        "UPDATE physical_bindings SET revision='different'",
        "UPDATE physical_bindings SET kind='directory'",
        "UPDATE physical_bindings SET record=json_set(record,'$.unexpected',1)",
        "UPDATE physical_bindings SET record=json_set(record,'$.state.deleted',json('true'))",
        "DELETE FROM projection_baselines",
        "UPDATE projection_baselines SET record=json_set(record,'$.state.revision','different')",
    ] {
        let (dir, store, binding) = fixture();
        let db = rusqlite::Connection::open(dir.path().join("db")).unwrap();
        db.execute(sql, []).unwrap();
        assert!(store.physical_binding(&binding.state.id).is_err(), "{sql}");
    }
}
#[test]
fn prior_schema_is_rejected_without_mutation_or_invented_binding() {
    let (dir, store, binding) = fixture();
    drop(store);
    let path = dir.path().join("db");
    let db = rusqlite::Connection::open(&path).unwrap();
    let original: String = db
        .query_row(
            "SELECT record FROM projection_baselines WHERE entry_id=?1",
            [binding.state.id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    db.execute_batch("DROP TABLE observation_physical; DROP TABLE publication_parent_proofs; DROP TABLE physical_bindings; PRAGMA user_version=7;").unwrap();
    drop(db);
    assert!(matches!(
        Store::open(&path),
        Err(zorid_store::StoreError::UnsupportedSchema(7))
    ));
    let db =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('physical_bindings','physical_binding_paths','publication_parent_proofs','observation_physical')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let retained: String = db
        .query_row(
            "SELECT record FROM projection_baselines WHERE entry_id=?1",
            [binding.state.id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(retained, original);
    assert_eq!(
        serde_json::from_str::<ProjectionBaseline>(&retained)
            .unwrap()
            .content,
        b"saved"
    );
}

#[test]
fn physical_path_owner_survives_hidden_logical_path_and_rejects_ambiguity() {
    let (dir, mut store, binding) = fixture();
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("move").unwrap(),
            mutation: Mutation::Move {
                id: binding.state.id.clone(),
                expected: binding.state.revision.clone(),
                path: VaultPath::new("elsewhere.md").unwrap(),
            },
        })
        .unwrap();
    assert_eq!(
        store.physical_owner_at(&binding.state.path).unwrap(),
        Some(binding.clone())
    );
    assert!(store
        .physical_owner_at(&VaultPath::new("elsewhere.md").unwrap())
        .unwrap()
        .is_none());
    let other_id = EntryId::new("other").unwrap();
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("create-other").unwrap(),
            mutation: Mutation::Create {
                id: other_id.clone(),
                path: VaultPath::new("other.md").unwrap(),
                kind: EntryKind::File,
                content: Some(b"other".to_vec()),
            },
        })
        .unwrap();
    let mut other = binding.clone();
    other.state = store.read(&other_id).unwrap().unwrap().state;
    other.state.path = binding.state.path.clone();
    other.physical.inode = "other-inode".into();
    let db = rusqlite::Connection::open(dir.path().join("db")).unwrap();
    db.execute(
        "INSERT INTO projection_baselines(entry_id,record) VALUES(?1,?2)",
        rusqlite::params![
            other_id.as_str(),
            serde_json::to_string(&ProjectionBaseline {
                state: other.state.clone(),
                content: b"other".to_vec()
            })
            .unwrap()
        ],
    )
    .unwrap();
    db.execute("INSERT INTO physical_bindings(entry_id,path,revision,kind,inode,parent_inode,record) VALUES(?1,?2,?3,'file',?4,?5,?6)",rusqlite::params![other_id.as_str(),other.state.path.as_str(),other.state.revision.as_str(),other.physical.inode,other.physical.parent_inode,serde_json::to_string(&other).unwrap()]).unwrap();
    assert_eq!(store.physical_binding(&other_id).unwrap(), Some(other));
    assert!(store
        .physical_owner_at(&binding.state.path)
        .unwrap_err()
        .to_string()
        .contains("multiple physical owners"));
}
