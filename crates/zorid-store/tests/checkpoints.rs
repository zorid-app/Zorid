use std::{
    process::Command,
    sync::{Arc, Barrier},
};
use zorid_core::OperationId;
use zorid_store::{
    Checkpoint, CheckpointError, CheckpointScope, CheckpointWrite, Store, MAX_CHECKPOINT_BYTES,
};

fn scope(store: &Store, client: &str) -> CheckpointScope {
    CheckpointScope {
        vault_id: store.identity().unwrap().local_store_id,
        client_id: OperationId::new(client).unwrap(),
    }
}
fn revision(value: u64) -> String {
    format!("00000000-0000-4000-8000-{value:012x}")
}
fn cas(
    store: &mut Store,
    scope: &CheckpointScope,
    key: &str,
    expected: Option<&str>,
    next: &str,
    state: Option<&str>,
) -> Result<Checkpoint, CheckpointError> {
    store.checkpoint_compare_and_swap(
        scope,
        CheckpointWrite {
            key,
            expected_revision: expected,
            next_revision: next,
            encoded_state: state,
        },
    )
}

#[test]
fn checkpoint_worker_commit_then_exit() {
    let Some(path) = std::env::var_os("ZORID_CHECKPOINT_CHILD_DB") else {
        return;
    };
    let mut store = Store::open(path).unwrap();
    let scope = scope(&store, "child");
    cas(
        &mut store,
        &scope,
        "draft",
        None,
        &revision(1),
        Some("\u{feff}draft\r\n🚀"),
    )
    .unwrap();
    // Drop/close is intentionally bypassed: success already meant SQLite commit.
    std::process::exit(0);
}

#[test]
fn lost_ack_reopens_exactly_without_domain_or_sync_side_effects() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let mut store = Store::open(&path).unwrap();
    let before = store.list_snapshot().unwrap();
    drop(store);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "checkpoint_worker_commit_then_exit",
            "--nocapture",
        ])
        .env("ZORID_CHECKPOINT_CHILD_DB", &path)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("checkpoint child timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    store = Store::open(&path).unwrap();
    let scope = scope(&store, "child");
    let head = store.checkpoint_load(&scope, "draft").unwrap().unwrap();
    assert_eq!(head.encoded_state.as_deref(), Some("\u{feff}draft\r\n🚀"));
    assert_eq!(head.byte_length as usize, "\u{feff}draft\r\n🚀".len());
    assert_eq!(
        cas(
            &mut store,
            &scope,
            "draft",
            None,
            &revision(1),
            head.encoded_state.as_deref()
        )
        .unwrap(),
        head
    );
    assert_eq!(
        store
            .checkpoint_changes(&scope, "0", 10, None)
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(store.pending_counts().unwrap(), (0, 0));
    assert_eq!(store.list_snapshot().unwrap(), before);
}

#[test]
fn only_current_exact_retry_is_successful_and_tombstones_retain_fences() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let mut store = Store::open(&path).unwrap();
    let scope = scope(&store, "client");
    let (a, b, c) = (revision(1), revision(2), revision(3));
    cas(
        &mut store,
        &scope,
        "draft",
        None,
        &a,
        Some("old private draft"),
    )
    .unwrap();
    for (key, expected, state) in [
        ("draft", None, Some("altered")),
        ("different-key", None, Some("old private draft")),
        ("draft", Some(a.as_str()), Some("old private draft")),
    ] {
        assert!(matches!(
            cas(&mut store, &scope, key, expected, &a, state),
            Err(CheckpointError::Conflict)
        ));
    }
    let tombstone = cas(&mut store, &scope, "draft", Some(&a), &b, None).unwrap();
    assert!(tombstone.deleted);
    assert_eq!(
        cas(&mut store, &scope, "draft", Some(&a), &b, None).unwrap(),
        tombstone
    );
    assert!(store
        .checkpoint_list(&scope, 10, None)
        .unwrap()
        .items
        .is_empty());
    assert!(matches!(
        cas(&mut store, &scope, "draft", None, &c, Some("new")),
        Err(CheckpointError::Conflict)
    ));
    assert!(matches!(
        cas(
            &mut store,
            &scope,
            "draft",
            None,
            &a,
            Some("old private draft")
        ),
        Err(CheckpointError::Conflict)
    ));
    cas(&mut store, &scope, "draft", Some(&b), &c, Some("new")).unwrap();
    assert!(matches!(
        cas(&mut store, &scope, "draft", Some(&a), &b, None),
        Err(CheckpointError::Conflict)
    ));
    assert!(matches!(
        cas(
            &mut store,
            &scope,
            "draft",
            Some(&c),
            &a,
            Some("old private draft")
        ),
        Err(CheckpointError::Conflict)
    ));
    let db = rusqlite::Connection::open(&path).unwrap();
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(checkpoint_revisions)")
        .unwrap()
        .query_map([], |r| r.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        columns,
        [
            "sequence",
            "client_id",
            "checkpoint_key",
            "revision",
            "expected_revision",
            "deleted",
            "state_bytes"
        ]
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM checkpoint_heads", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT encoded_state FROM checkpoint_heads", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "new"
    );
}

#[test]
fn independent_connections_race_cas_and_only_one_advances() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let mut store = Store::open(&path).unwrap();
    let scope = scope(&store, "client");
    let first = revision(1);
    cas(&mut store, &scope, "draft", None, &first, Some("base")).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = [2, 3]
        .into_iter()
        .map(|i| {
            let mut worker_store = Store::open(&path).unwrap();
            let scope = scope.clone();
            let barrier = barrier.clone();
            let first = first.clone();
            std::thread::spawn(move || {
                barrier.wait();
                cas(
                    &mut worker_store,
                    &scope,
                    "draft",
                    Some(&first),
                    &revision(i),
                    Some("changed"),
                )
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(CheckpointError::Conflict)))
            .count(),
        1
    );
    assert_eq!(
        store
            .checkpoint_changes(&scope, "0", 10, None)
            .unwrap()
            .items
            .len(),
        2
    );
}

#[test]
fn stable_metadata_pages_survive_concurrent_updates_and_changes_catch_up() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let mut store = Store::open(&path).unwrap();
    let scope = scope(&store, "client");
    for (i, key) in [(1, "a"), (2, "b"), (3, "c")] {
        cas(
            &mut store,
            &scope,
            key,
            None,
            &revision(i),
            Some("secret payload"),
        )
        .unwrap();
    }
    let first = store.checkpoint_list(&scope, 1, None).unwrap();
    assert_eq!(first.items[0].key, "a");
    assert!(first.cursor.is_some());
    let mut peer = Store::open(&path).unwrap();
    cas(
        &mut peer,
        &scope,
        "b",
        Some(&revision(2)),
        &revision(4),
        Some("new secret"),
    )
    .unwrap();
    cas(
        &mut peer,
        &scope,
        "c",
        Some(&revision(3)),
        &revision(5),
        None,
    )
    .unwrap();
    cas(&mut peer, &scope, "d", None, &revision(6), Some("new key")).unwrap();
    let second = store
        .checkpoint_list(&scope, 1, first.cursor.as_deref())
        .unwrap();
    assert_eq!(second.high_water, first.high_water);
    assert_eq!(second.items[0].key, "b");
    assert_eq!(second.items[0].revision, revision(2));
    assert_eq!(
        store
            .checkpoint_load(&scope, "b")
            .unwrap()
            .unwrap()
            .revision,
        revision(4)
    );
    let third = store
        .checkpoint_list(&scope, 1, second.cursor.as_deref())
        .unwrap();
    assert_eq!(third.items[0].key, "c");
    assert!(!third.items[0].deleted);
    assert!(third.cursor.is_none());
    let changes = store
        .checkpoint_changes(&scope, &first.high_water, 2, None)
        .unwrap();
    assert_eq!(
        changes
            .items
            .iter()
            .map(|m| m.key.as_str())
            .collect::<Vec<_>>(),
        ["b", "c"]
    );
    assert!(changes.items[1].deleted);
    cas(
        &mut peer,
        &scope,
        "d",
        Some(&revision(6)),
        &revision(7),
        Some("later"),
    )
    .unwrap();
    let end = store
        .checkpoint_changes(&scope, &first.high_water, 2, changes.cursor.as_deref())
        .unwrap();
    assert_eq!(end.high_water, changes.high_water);
    assert_eq!(end.items.len(), 1);
    assert_eq!(end.items[0].revision, revision(6));
    assert!(end.cursor.is_none());
    let last = store
        .checkpoint_changes(&scope, &end.high_water, 2, None)
        .unwrap();
    assert_eq!(last.items[0].revision, revision(7));
    let encoded = serde_json::to_string(&last).unwrap();
    assert!(!encoded.contains("encodedState"));
    assert!(!encoded.contains("later"));
}

#[test]
fn scope_cursor_and_input_bounds_fail_without_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp.path().join("db")).unwrap();
    let a = scope(&store, "a");
    let b = scope(&store, "b");
    cas(&mut store, &a, "draft", None, &revision(1), Some("a")).unwrap();
    cas(&mut store, &a, "other", None, &revision(2), Some("a")).unwrap();
    assert_eq!(store.checkpoint_load(&b, "draft").unwrap(), None);
    cas(&mut store, &b, "draft", None, &revision(1), Some("b")).unwrap();
    let other = CheckpointScope {
        vault_id: OperationId::new("foreign").unwrap(),
        client_id: a.client_id.clone(),
    };
    assert!(matches!(
        store.checkpoint_load(&other, "draft"),
        Err(CheckpointError::ScopeMismatch)
    ));
    let page = store.checkpoint_list(&a, 1, None).unwrap();
    assert!(matches!(
        store.checkpoint_list(&b, 1, page.cursor.as_deref()),
        Err(CheckpointError::ScopeMismatch)
    ));
    assert!(matches!(
        store.checkpoint_changes(&a, "0", 1, page.cursor.as_deref()),
        Err(CheckpointError::Invalid)
    ));
    for limit in [0, 1001] {
        assert!(matches!(
            store.checkpoint_list(&a, limit, None),
            Err(CheckpointError::Limit)
        ));
    }
    assert!(matches!(
        store.checkpoint_changes(&a, "999", 1, None),
        Err(CheckpointError::Invalid)
    ));
    for key in ["", "nul\0key"] {
        assert!(matches!(
            cas(&mut store, &a, key, None, &revision(3), Some("bad")),
            Err(CheckpointError::Invalid)
        ));
    }
    assert!(matches!(
        cas(&mut store, &a, &"é".repeat(513), None, &revision(3), None),
        Err(CheckpointError::Limit)
    ));
    assert!(matches!(
        cas(&mut store, &a, "new", None, "not-a-uuid", None),
        Err(CheckpointError::Invalid)
    ));
    assert_eq!(
        store
            .checkpoint_changes(&a, "0", 10, None)
            .unwrap()
            .items
            .len(),
        2
    );
}

#[test]
fn state_limit_counts_utf8_bytes_and_never_truncates() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp.path().join("db")).unwrap();
    let scope = scope(&store, "client");
    let oversized = "é".repeat(MAX_CHECKPOINT_BYTES / 2 + 1);
    assert!(matches!(
        cas(
            &mut store,
            &scope,
            "draft",
            None,
            &revision(1),
            Some(&oversized)
        ),
        Err(CheckpointError::Limit)
    ));
    assert_eq!(store.checkpoint_load(&scope, "draft").unwrap(), None);
    drop(oversized);
    let exact = "é".repeat(MAX_CHECKPOINT_BYTES / 2);
    let result = cas(
        &mut store,
        &scope,
        "draft",
        None,
        &revision(1),
        Some(&exact),
    )
    .unwrap();
    assert_eq!(result.byte_length as usize, MAX_CHECKPOINT_BYTES);
    assert_eq!(result.encoded_state.as_deref(), Some(exact.as_str()));
    drop(result);
    assert_eq!(
        store
            .checkpoint_load(&scope, "draft")
            .unwrap()
            .unwrap()
            .encoded_state
            .as_deref(),
        Some(exact.as_str())
    );
}

#[test]
fn failure_after_revision_insert_rolls_back_fence_and_head() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let scope = scope(&store, "client");
    let first = cas(
        &mut store,
        &scope,
        "draft",
        None,
        &revision(1),
        Some("safe"),
    )
    .unwrap();
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture.execute_batch("CREATE TRIGGER checkpoint_fixture_failure BEFORE UPDATE ON checkpoint_heads BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(matches!(
        cas(
            &mut store,
            &scope,
            "draft",
            Some(&revision(1)),
            &revision(2),
            Some("uncertain")
        ),
        Err(CheckpointError::Store(_))
    ));
    assert_eq!(
        store.checkpoint_load(&scope, "draft").unwrap().unwrap(),
        first
    );
    assert_eq!(
        store
            .checkpoint_changes(&scope, "0", 10, None)
            .unwrap()
            .items
            .len(),
        1
    );
    fixture
        .execute_batch("DROP TRIGGER checkpoint_fixture_failure")
        .unwrap();
    cas(
        &mut store,
        &scope,
        "draft",
        Some(&revision(1)),
        &revision(2),
        Some("uncertain"),
    )
    .unwrap();
}

#[test]
fn missing_retained_head_and_deleted_tail_are_corruption_not_never_existed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let scope = scope(&store, "client");
    cas(
        &mut store,
        &scope,
        "draft",
        None,
        &revision(1),
        Some("retained"),
    )
    .unwrap();
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture.execute("DELETE FROM checkpoint_heads", []).unwrap();
    assert!(matches!(
        store.checkpoint_load(&scope, "draft"),
        Err(CheckpointError::Store(_))
    ));
    assert!(matches!(
        cas(
            &mut store,
            &scope,
            "draft",
            None,
            &revision(2),
            Some("replacement")
        ),
        Err(CheckpointError::Store(_))
    ));
    fixture
        .execute("DELETE FROM checkpoint_revisions", [])
        .unwrap();
    assert!(matches!(
        store.checkpoint_list(&scope, 10, None),
        Err(CheckpointError::Store(_))
    ));
    assert!(matches!(
        cas(
            &mut store,
            &scope,
            "draft",
            None,
            &revision(2),
            Some("replacement")
        ),
        Err(CheckpointError::Store(_))
    ));
}

#[test]
fn missing_interior_revision_cannot_remove_cross_key_reuse_fence() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let scope = scope(&store, "client");
    cas(&mut store, &scope, "draft", None, &revision(1), Some("old")).unwrap();
    cas(
        &mut store,
        &scope,
        "draft",
        Some(&revision(1)),
        &revision(2),
        Some("head"),
    )
    .unwrap();
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture
        .execute("DELETE FROM checkpoint_revisions WHERE sequence=1", [])
        .unwrap();
    assert!(matches!(
        cas(
            &mut store,
            &scope,
            "other",
            None,
            &revision(1),
            Some("reused")
        ),
        Err(CheckpointError::Store(_))
    ));
    assert!(matches!(
        store.checkpoint_load(&scope, "draft"),
        Err(CheckpointError::Store(_))
    ));
    assert!(matches!(
        store.checkpoint_changes(&scope, "0", 10, None),
        Err(CheckpointError::Store(_))
    ));
    assert_eq!(
        fixture
            .query_row("SELECT count(*) FROM checkpoint_heads", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
