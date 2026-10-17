mod common;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{ChangeOrigin, EntryPresentation, Store};
fn create(name: &str, bytes: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(name.replace('.', "_")).unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new(name.replace('.', "_")).unwrap(),
            path: VaultPath::new(name).unwrap(),
            kind: EntryKind::File,
            content: Some(bytes.to_vec()),
        },
    }
}
fn write(store: &Store, op: &str, name: &str, bytes: &[u8]) -> MutationRequest {
    let prior = store
        .read(&EntryId::new(name.replace('.', "_")).unwrap())
        .unwrap()
        .unwrap();
    MutationRequest {
        operation_id: OperationId::new(op).unwrap(),
        mutation: Mutation::Write {
            id: prior.state.id,
            expected: prior.state.revision,
            content: bytes.to_vec(),
        },
    }
}
#[test]
fn committed_path_read_presentation_replay_and_clock_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let req = create("binary.unknown", &[0, 255, 1]);
    let receipt = store.apply_at(&req, 100).unwrap();
    let baseline = store.list_snapshot().unwrap();
    let first = store
        .read_path(&VaultPath::new("binary.unknown").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(first.content, Some(vec![0, 255, 1]));
    assert_eq!(first.presentation.ctime_ms, 100);
    assert_eq!(first.presentation.size_bytes, 3);
    assert_eq!(store.apply_at(&req, 999).unwrap(), receipt);
    assert_eq!(store.apply_at(&req, u64::MAX).unwrap(), receipt);
    assert_eq!(store.list_snapshot().unwrap(), baseline);
    let req = write(&store, "write", "binary.unknown", b"longer");
    store.apply_at(&req, 50).unwrap();
    let later = store
        .read_path(&VaultPath::new("binary.unknown").unwrap())
        .unwrap()
        .unwrap();
    assert_ne!(first.state.revision, later.state.revision);
    assert_eq!(later.presentation.mtime_ms, 100);
    assert_eq!(later.presentation.ctime_ms, 100);
    assert_eq!(later.presentation.size_bytes, 6);
    let page = store.changes_after(&baseline.cursor, 10).unwrap();
    assert_eq!(page.changes.len(), 1);
    assert!(!page.has_more);
    assert_eq!(page.changes[0].entries[0].presentation, later.presentation);
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.read_path(&later.state.path).unwrap().unwrap(), later);
}
#[test]
fn presentation_and_journal_failure_rolls_back_whole_commit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let before = store.list_snapshot().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER fail_journal BEFORE INSERT ON local_changes BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    assert!(store.apply_at(&create("a", b"new"), 10).is_err());
    assert_eq!(store.list_snapshot().unwrap(), before);
    assert_eq!(store.pending_counts().unwrap(), (0, 0));
    assert!(store.operations_after(0, 100).unwrap().is_empty());
    db.execute_batch("DROP TRIGGER fail_journal").unwrap();
    store.apply_at(&create("a", b"new"), 10).unwrap();
    db.execute("UPDATE entry_presentation SET size_bytes=99", [])
        .unwrap();
    let req = write(&store, "change", "a", b"replacement");
    assert!(store.apply_at(&req, 20).is_err());
    assert_eq!(
        store
            .read(&EntryId::new("a").unwrap())
            .unwrap()
            .unwrap()
            .content,
        Some(b"new".to_vec())
    );
    assert!(store.read_path(&VaultPath::new("a").unwrap()).is_err());
}
#[test]
fn v3_migration_has_explicit_unknown_times_and_reload_boundary() {
    for corrupt in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let req = create("a", b"old");
        let receipt = Store::open(&path).unwrap().apply_at(&req, 900).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        common::downgrade_v6_to_v5(&db);
        db.execute_batch("DROP TABLE host_intents; DROP TABLE entry_presentation; DROP TABLE local_changes; PRAGMA user_version=3; PRAGMA journal_mode=DELETE;").unwrap();
        if corrupt {
            db.execute_batch("DROP INDEX active_directory_projection")
                .unwrap();
        }
        drop(db);
        if corrupt {
            assert!(Store::open(&path).is_err());
            let db = rusqlite::Connection::open(&path).unwrap();
            assert_eq!(
                db.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                    .unwrap(),
                "delete"
            );
            continue;
        }
        let mut store = Store::open(&path).unwrap();
        let snapshot = store.list_snapshot().unwrap();
        assert_eq!(snapshot.entries[0].presentation.ctime_ms, 0);
        assert_eq!(snapshot.entries[0].presentation.mtime_ms, 0);
        assert_eq!(snapshot.entries[0].presentation.size_bytes, 3);
        let page = store.changes_after("0", 10).unwrap();
        assert_eq!(page.changes.len(), 1);
        assert!(page.changes[0].requires_full_reload);
        assert!(matches!(page.changes[0].origin, ChangeOrigin::Bootstrap));
        assert!(page.changes[0].entries.is_empty());
        assert_eq!(store.apply_at(&req, 1000).unwrap(), receipt);
        assert_eq!(store.list_snapshot().unwrap(), snapshot);
    }
}
#[test]
fn safe_integer_metadata_and_canonical_cursor_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    assert!(store
        .apply_at(&create("a", b""), 9_007_199_254_740_992)
        .is_err());
    assert!(store.list().unwrap().is_empty());
    for invalid in ["-1", "01", "+1", "18446744073709551615", ""] {
        assert!(store.changes_after(invalid, 10).is_err());
    }
    assert!(store.changes_after("0", 0).is_err());
    assert!(store.changes_after("0", 1001).is_err());
    assert!(store.changes_after("2", 10).is_err());
    assert!(serde_json::from_str::<EntryPresentation>(
        r#"{"id":"a","ctime_ms":9007199254740992,"mtime_ms":0,"size_bytes":0}"#
    )
    .is_err());
}
#[test]
fn journal_pagination_gaps_and_large_decimal_cursors_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply_at(&create("a", b"a"), 10).unwrap();
    store.apply_at(&create("b", b"b"), 20).unwrap();
    let page = store.changes_after("0", 1).unwrap();
    assert!(page.has_more);
    assert_eq!(page.next_cursor, "1");
    assert_eq!(page.head_cursor, "3");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("DELETE FROM local_changes WHERE cursor=2", [])
        .unwrap();
    assert!(store.changes_after("1", 10).is_err());
    // Valid near-limit decimal cursor survives JSON without conversion to f64.
    db.execute_batch("DELETE FROM local_changes; INSERT INTO local_changes(cursor,record) VALUES(9007199254740993,'{\"cursor\":\"9007199254740993\",\"origin\":{\"kind\":\"bootstrap\"},\"requires_full_reload\":true,\"entries\":[]}');").unwrap();
    let page = store.changes_after("9007199254740992", 1).unwrap();
    assert_eq!(page.next_cursor, "9007199254740993");
    assert!(serde_json::to_string(&page)
        .unwrap()
        .contains("\"9007199254740993\""));
    db.execute(
        "UPDATE local_changes SET record=?1",
        [" ".repeat(1024 * 1024 + 1)],
    )
    .unwrap();
    assert!(store.changes_after("9007199254740992", 1).is_err());
}
#[test]
fn independent_writer_snapshot_cursor_has_no_missed_commits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let reader = Store::open(&path).unwrap();
    let thread = std::thread::spawn(move || {
        let mut writer = Store::open(&path).unwrap();
        for i in 0..40 {
            writer
                .apply_at(&create(&format!("file{i}"), b"bytes"), i + 1)
                .unwrap();
        }
    });
    for _ in 0..40 {
        let snapshot = reader.list_snapshot().unwrap();
        let cursor = snapshot.cursor.parse::<usize>().unwrap();
        assert_eq!(snapshot.entries.len() + 1, cursor);
        for entry in snapshot.entries {
            assert_eq!(entry.presentation.size_bytes, 5);
            assert_eq!(entry.state.id, entry.presentation.id);
        }
    }
    thread.join().unwrap();
    let snapshot = reader.list_snapshot().unwrap();
    assert_eq!(snapshot.entries.len(), 40);
    assert_eq!(snapshot.cursor, "41");
}

#[test]
fn deleted_tail_and_empty_authored_event_never_look_caught_up() {
    for empty in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = Store::open(&path).unwrap();
        store.apply_at(&create("a", b"a"), 1).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        if empty {
            db.execute("UPDATE local_changes SET record=json_set(record,'$.entries',json('[]')) WHERE cursor=2",[]).unwrap();
        } else {
            db.execute("DELETE FROM local_changes WHERE cursor=2", [])
                .unwrap();
        }
        assert!(store.changes_after("1", 10).is_err());
        if !empty {
            assert!(store.list_snapshot().is_err());
            assert!(store.apply_at(&create("b", b"b"), 2).is_err());
            assert!(store.read(&EntryId::new("b").unwrap()).unwrap().is_none());
        }
    }
}

#[test]
fn subtree_move_and_delete_events_keep_identity_creation_time_and_tombstones() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let folder = EntryId::new("folder").unwrap();
    store
        .apply_at(
            &MutationRequest {
                operation_id: OperationId::new("folder").unwrap(),
                mutation: Mutation::Create {
                    id: folder.clone(),
                    path: VaultPath::new("folder").unwrap(),
                    kind: EntryKind::Folder,
                    content: None,
                },
            },
            10,
        )
        .unwrap();
    let mut child = create("child", b"preserved");
    if let Mutation::Create { path, .. } = &mut child.mutation {
        *path = VaultPath::new("folder/child").unwrap();
    }
    store.apply_at(&child, 20).unwrap();
    let before = store.list_snapshot().unwrap();
    let state = store.read(&folder).unwrap().unwrap().state;
    store
        .apply_at(
            &MutationRequest {
                operation_id: OperationId::new("move").unwrap(),
                mutation: Mutation::Move {
                    id: folder.clone(),
                    expected: state.revision,
                    path: VaultPath::new("moved").unwrap(),
                },
            },
            30,
        )
        .unwrap();
    assert!(store
        .read_path(&VaultPath::new("folder/child").unwrap())
        .unwrap()
        .is_none());
    let moved = store
        .read_path(&VaultPath::new("moved/child").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(moved.presentation.ctime_ms, 20);
    assert_eq!(moved.presentation.mtime_ms, 30);
    assert_eq!(moved.content, Some(b"preserved".to_vec()));
    let state = store.read(&folder).unwrap().unwrap().state;
    store
        .apply_at(
            &MutationRequest {
                operation_id: OperationId::new("delete").unwrap(),
                mutation: Mutation::Delete {
                    id: folder,
                    expected: state.revision,
                    recursive: true,
                },
            },
            40,
        )
        .unwrap();
    assert!(store.list_snapshot().unwrap().entries.is_empty());
    let page = store.changes_after(&before.cursor, 100).unwrap();
    assert_eq!(page.changes.len(), 2);
    assert_eq!(page.changes[1].entries.len(), 2);
    assert!(page.changes[1].entries.iter().all(|e| e.state.deleted));
    assert_eq!(
        page.changes[1]
            .entries
            .iter()
            .find(|e| e.state.id.as_str() == "child")
            .unwrap()
            .presentation
            .size_bytes,
        9
    );
}

#[test]
fn recoverable_stream_failures_are_typed_without_masking_corruption() {
    use zorid_store::{ReloadReason, StoreError};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    assert!(matches!(
        store.changes_after("2", 10),
        Err(StoreError::ReloadRequired(ReloadReason::CursorAhead))
    ));
    store.apply_at(&create("a", b"a"), 1).unwrap();
    store.apply_at(&create("b", b"b"), 2).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("DELETE FROM local_changes WHERE cursor=2", [])
        .unwrap();
    assert!(matches!(
        store.changes_after("1", 10),
        Err(StoreError::ReloadRequired(ReloadReason::JournalGap))
    ));
    assert!(store.list_snapshot().is_ok());
    db.execute(
        "UPDATE local_changes SET record=?1 WHERE cursor=3",
        [" ".repeat(1024 * 1024 + 1)],
    )
    .unwrap();
    assert!(matches!(
        store.changes_after("2", 10),
        Err(StoreError::ReloadRequired(ReloadReason::EventTooLarge))
    ));
    db.execute("DELETE FROM local_changes WHERE cursor=3", [])
        .unwrap();
    assert!(matches!(
        store.changes_after("1", 10),
        Err(StoreError::Corrupt(_))
    ));
    assert!(store.list_snapshot().is_err());
}
