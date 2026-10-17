use std::path::Path;
use zorid_core::{
    ContractError, EntryId, EntryKind, Mutation, MutationRequest, OperationId, Revision, VaultPath,
};
use zorid_store::{Store, StoreError};

fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn request(op: &str, mutation: Mutation) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(op).unwrap(),
        mutation,
    }
}
fn create(op: &str, name: &str, path: &str, content: &[u8]) -> MutationRequest {
    request(
        op,
        Mutation::Create {
            id: id(name),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(content.to_vec()),
        },
    )
}
fn write(op: &str, revision: Revision, content: &[u8]) -> MutationRequest {
    request(
        op,
        Mutation::Write {
            id: id("file"),
            expected: revision,
            content: content.to_vec(),
        },
    )
}
fn database() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    (dir, path)
}

#[test]
fn committed_binary_and_all_durable_intents_survive_reopen() {
    let (_dir, path) = database();
    let payload = vec![0, 255, 128, 13, 10, 0, 42];
    let operation = create("create", "file", ".hidden.unknown", &payload);
    let receipt = Store::open(&path).unwrap().apply(&operation).unwrap();
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.read(&id("file")).unwrap().unwrap().content,
        Some(payload)
    );
    assert_eq!(reopened.pending_counts().unwrap(), (1, 1));
    let log = reopened.operations_after(0, 10).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].request, operation);
    assert_eq!(log[0].result, receipt);
}

#[test]
fn retry_after_lost_ack_is_idempotent_but_reusing_key_for_new_bytes_fails() {
    let (_dir, path) = database();
    let operation = create("retry", "file", "note.md", b"original");
    let original = Store::open(&path).unwrap().apply(&operation).unwrap();
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.apply(&operation).unwrap(), original);
    assert_eq!(reopened.pending_counts().unwrap(), (1, 1));
    assert!(matches!(
        reopened.apply(&create("retry", "file", "note.md", b"different")),
        Err(StoreError::Contract(
            ContractError::IdempotencyConflict { .. }
        ))
    ));
    assert_eq!(
        reopened
            .read(&id("file"))
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        b"original"
    );
}

#[test]
fn stale_second_connection_cannot_overwrite_newer_commit() {
    let (_dir, path) = database();
    let mut first = Store::open(&path).unwrap();
    first
        .apply(&create("create", "file", "note.md", b"base"))
        .unwrap();
    let mut second = Store::open(&path).unwrap();
    let old_revision = second.read(&id("file")).unwrap().unwrap().state.revision;
    first
        .apply(&write("first", old_revision.clone(), b"first edit"))
        .unwrap();
    assert!(matches!(
        second.apply(&write("second", old_revision, b"stale edit")),
        Err(StoreError::Contract(ContractError::RevisionConflict { .. }))
    ));
    assert_eq!(
        second.read(&id("file")).unwrap().unwrap().content.unwrap(),
        b"first edit"
    );
    assert_eq!(second.operations_after(0, 10).unwrap().len(), 2);
}

#[test]
fn failure_in_outgoing_intent_rolls_back_entry_receipt_and_projection() {
    let (_dir, path) = database();
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&create("create", "file", "note.md", b"before"))
        .unwrap();
    let before = store.read(&id("file")).unwrap().unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    assert!(store
        .apply(&write(
            "failure",
            before.state.revision.clone(),
            b"must not survive"
        ))
        .is_err());
    assert_eq!(store.read(&id("file")).unwrap().unwrap(), before);
    assert_eq!(store.operations_after(0, 10).unwrap().len(), 1);
    assert_eq!(store.pending_counts().unwrap(), (1, 1));
    connection
        .execute_batch("DROP TRIGGER reject_outbox;")
        .unwrap();
    // Failed transaction did not consume the operation ID.
    store
        .apply(&write("failure", before.state.revision, b"retry succeeds"))
        .unwrap();
}

#[test]
fn folder_revision_covers_descendant_edits_and_move_preserves_bytes() {
    let (_dir, path) = database();
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&request(
            "folder",
            Mutation::Create {
                id: id("folder"),
                path: VaultPath::new("notes").unwrap(),
                kind: EntryKind::Folder,
                content: None,
            },
        ))
        .unwrap();
    store
        .apply(&create("child", "file", "notes/opaque.data", &[0, 254, 1]))
        .unwrap();
    let stale_folder = store.read(&id("folder")).unwrap().unwrap().state.revision;
    let file_revision = store.read(&id("file")).unwrap().unwrap().state.revision;
    store
        .apply(&write("child-edit", file_revision, &[255, 0, 7]))
        .unwrap();
    assert!(matches!(
        store.apply(&request(
            "stale-delete",
            Mutation::Delete {
                id: id("folder"),
                expected: stale_folder,
                recursive: true,
            }
        )),
        Err(StoreError::Contract(ContractError::RevisionConflict { .. }))
    ));
    let current = store.read(&id("folder")).unwrap().unwrap().state.revision;
    store
        .apply(&request(
            "move",
            Mutation::Move {
                id: id("folder"),
                expected: current,
                path: VaultPath::new("archive").unwrap(),
            },
        ))
        .unwrap();
    let entry = store.read(&id("file")).unwrap().unwrap();
    assert_eq!(entry.state.path.as_str(), "archive/opaque.data");
    assert_eq!(entry.content.unwrap(), [255, 0, 7]);
    let revision = store.read(&id("folder")).unwrap().unwrap().state.revision;
    store
        .apply(&request(
            "delete",
            Mutation::Delete {
                id: id("folder"),
                expected: revision,
                recursive: true,
            },
        ))
        .unwrap();
    assert!(store.list().unwrap().is_empty());
    let operations = store.operations_after(0, 100).unwrap();
    assert_eq!(
        operations
            .iter()
            .map(|op| op.request.operation_id.as_str())
            .collect::<Vec<_>>(),
        ["folder", "child", "child-edit", "move", "delete"]
    );
}

#[test]
fn newer_schema_is_rejected_without_reinitialization() {
    let (_dir, path) = database();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "PRAGMA user_version=99; CREATE TABLE future(x); INSERT INTO future VALUES(42);",
        )
        .unwrap();
    assert!(matches!(
        Store::open(&path),
        Err(StoreError::UnsupportedSchema(99))
    ));
    assert_eq!(
        connection
            .query_row("SELECT x FROM future", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        42
    );
}

#[test]
fn foreign_and_incomplete_schemas_are_rejected_without_repair() {
    for sql in [
        "PRAGMA user_version=1;",
        "PRAGMA user_version=1; PRAGMA application_id=1515147844;",
        "CREATE TABLE unrelated(value); INSERT INTO unrelated VALUES(42);",
        "CREATE TABLE sqliteXuser(value); INSERT INTO sqliteXuser VALUES(42);",
    ] {
        let (_dir, path) = database();
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch(sql).unwrap();
        let before: String = connection
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))));
        let after: String = connection
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(
            before, after,
            "rejected database's persistent journal mode changed"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='entries'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    let (_dir, path) = database();
    drop(Store::open(&path).unwrap());
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("DROP INDEX live_paths;").unwrap();
    assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))));
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='live_paths'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn inconsistent_logical_rows_fail_reads_and_mutations() {
    for sql in [
        "UPDATE entries SET path='other.md'",
        "UPDATE entries SET content=NULL",
    ] {
        let (_dir, path) = database();
        let mut store = Store::open(&path).unwrap();
        store
            .apply(&create("create", "file", "note.md", b"base"))
            .unwrap();
        let revision = store.read(&id("file")).unwrap().unwrap().state.revision;
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(sql)
            .unwrap();
        assert!(matches!(
            store.read(&id("file")),
            Err(StoreError::Corrupt(_))
        ));
        assert!(matches!(store.list(), Err(StoreError::Corrupt(_))));
        assert!(matches!(
            store.apply(&write("edit", revision, b"new")),
            Err(StoreError::Corrupt(_))
        ));
        assert_eq!(store.operations_after(0, 10).unwrap().len(), 1);
    }
}

// Spawn this integration-test executable to exercise genuinely separate process
// instances. Both receive the same pre-read revision; exactly one can commit.
#[test]
fn process_writer() {
    let Some(path) = std::env::var_os("ZORID_TEST_DB") else {
        return;
    };
    let operation = std::env::var("ZORID_TEST_OPERATION").unwrap();
    let revision = Revision::new(std::env::var("ZORID_TEST_REVISION").unwrap()).unwrap();
    if let Some(path) = std::env::var_os("ZORID_TEST_READY") {
        std::fs::write(path, b"ready").unwrap();
    }
    let mut store = Store::open(Path::new(&path)).unwrap();
    match store.apply(&write(&operation, revision, operation.as_bytes())) {
        Ok(_) => std::process::exit(0),
        Err(StoreError::Contract(ContractError::RevisionConflict { .. })) => std::process::exit(10),
        Err(error) => panic!("unexpected child failure: {error}"),
    }
}

#[test]
fn independent_processes_cannot_both_commit_the_same_expected_revision() {
    let (_dir, path) = database();
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&create("create", "file", "note.md", b"base"))
        .unwrap();
    let revision = store.read(&id("file")).unwrap().unwrap().state.revision;
    let spawn = |name: &str| {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_writer", "--nocapture"])
            .env("ZORID_TEST_DB", &path)
            .env("ZORID_TEST_OPERATION", name)
            .env("ZORID_TEST_REVISION", revision.as_str())
            .spawn()
            .unwrap()
    };
    let mut first = spawn("desktop");
    let mut second = spawn("cli");
    let mut codes = [
        first.wait().unwrap().code().unwrap(),
        second.wait().unwrap().code().unwrap(),
    ];
    codes.sort();
    assert_eq!(codes, [0, 10]);
    assert_eq!(store.operations_after(0, 10).unwrap().len(), 2);
    assert_eq!(store.pending_counts().unwrap(), (2, 2));
}

#[test]
fn independent_process_waits_for_active_write_transaction() {
    let (dir, path) = database();
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&create("create", "file", "note.md", b"base"))
        .unwrap();
    let revision = store.read(&id("file")).unwrap().unwrap().state.revision;
    let mut holder = rusqlite::Connection::open(&path).unwrap();
    let tx = holder
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let ready = dir.path().join("ready");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "process_writer", "--nocapture"])
        .env("ZORID_TEST_DB", &path)
        .env("ZORID_TEST_OPERATION", "cli")
        .env("ZORID_TEST_REVISION", revision.as_str())
        .env("ZORID_TEST_READY", &ready)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let started = ready.exists();
    std::thread::sleep(std::time::Duration::from_millis(80));
    let still_waiting = child.try_wait().unwrap().is_none();
    tx.commit().unwrap();
    let code = child.wait().unwrap().code();
    assert!(started, "child failed to reach the lock attempt");
    assert!(
        still_waiting,
        "child unexpectedly finished while another writer held the transaction"
    );
    assert_eq!(code, Some(0));
    assert_eq!(
        store.read(&id("file")).unwrap().unwrap().content.unwrap(),
        b"cli"
    );
}
