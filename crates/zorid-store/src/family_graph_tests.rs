//! Route-level checks of durable facts against the independent bounded oracle.
//! These small fixtures establish integrity/atomicity, not large-vault capacity.
use super::*;
use rusqlite::types::Value;
use zorid_core::{OperationId, VaultPath};
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_file_sync::{metadata::MetadataState, Scope};
use zorid_sync_protocol::{ExpectedContext, RealmId, UpdateId, VaultId};

fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("graph-realm").unwrap(),
        vault_id: VaultId::new("graph-vault").unwrap(),
    }
}
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn create(value: &str, path: &str, content: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(format!("create-{value}")).unwrap(),
        mutation: Mutation::Create {
            id: id(value),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(content.to_vec()),
        },
    }
}
fn write(store: &Store, operation: &str, value: &str, content: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(operation).unwrap(),
        mutation: Mutation::Write {
            id: id(value),
            expected: store.read(&id(value)).unwrap().unwrap().state.revision,
            content: content.to_vec(),
        },
    }
}
fn enrolled(path: &Path) -> Store {
    let mut store = Store::open(path).unwrap();
    store.family_enroll(&scope()).unwrap();
    checked(&store);
    store
}
fn graph(store: &Store) -> MetadataState {
    blob_index::load_metadata(&store.connection, &scope())
        .unwrap()
        .unwrap()
}
fn checked(store: &Store) {
    let tx = store.connection.unchecked_transaction().unwrap();
    family_graph::check_current(&tx).unwrap();
    let graph = blob_index::load_metadata(&tx, &scope()).unwrap().unwrap();
    family_graph::audit_reference(&tx, &graph).unwrap();
    tx.commit().unwrap();
}

// Capture all persisted rows, including receipts, sources and sqlite_sequence:
// an error must not leave a prefix of graph/membership/materialization writes.
fn rows(connection: &Connection) -> Vec<(String, Vec<Vec<Value>>)> {
    let names: Vec<String> = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence') ORDER BY name"
    ).unwrap().query_map([], |row| row.get(0)).unwrap()
        .collect::<rusqlite::Result<_>>().unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            let values = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, Value>(column))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (name, values)
        })
        .collect()
}
fn no_receipt(store: &Store, request: &MutationRequest) {
    let present: bool = store
        .connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id=?1)",
            [request.operation_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!present);
}
fn packets(store: &mut Store) -> Vec<(FamilyPayloadKind, ExpectedContext, Vec<u8>)> {
    store
        .family_pending_authored(None, 1000)
        .unwrap()
        .into_iter()
        .map(|pending| {
            let expected = ExpectedContext {
                realm_id: pending.scope.realm_id,
                vault_id: pending.scope.vault_id,
                update_id: pending.update_id,
                key_epoch: 1,
            };
            let wire = store
                .family_seal(&expected, &VaultKey::from_bytes([7; 32]))
                .unwrap();
            (pending.family, expected, wire)
        })
        .collect()
}
fn receive(
    store: &mut Store,
    packet: &(FamilyPayloadKind, ExpectedContext, Vec<u8>),
) -> FamilyReceiveCommit {
    let opened =
        OpenedEnvelope::open(&packet.2, &packet.1, &VaultKey::from_bytes([7; 32])).unwrap();
    store.family_receive(&opened, None).unwrap()
}

#[test]
fn text_create_write_exact_replay_and_reopen_preserve_checked_facts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let mut store = enrolled(&path);
    let create = create("text", "note.md", "hello 🦀\r\n".as_bytes());
    let first = store
        .family_apply(&create, Some(FamilyCreateMode::Text))
        .unwrap();
    checked(&store);
    let before = rows(&store.connection);
    assert_eq!(
        store
            .family_apply(&create, Some(FamilyCreateMode::Text))
            .unwrap(),
        first
    );
    assert_eq!(rows(&store.connection), before);
    let edit = write(&store, "edit-text", "text", b"changed\n");
    let receipt = store.family_apply(&edit, None).unwrap();
    checked(&store);
    let before = rows(&store.connection);
    assert_eq!(store.family_apply(&edit, None).unwrap(), receipt);
    assert_eq!(rows(&store.connection), before);
    drop(store);
    let mut store = Store::open_existing_no_follow(std::fs::canonicalize(&path).unwrap()).unwrap();
    checked(&store);
    assert_eq!(rows(&store.connection), before);
    assert_eq!(
        store.read(&id("text")).unwrap().unwrap().content.as_deref(),
        Some(b"changed\n".as_slice())
    );
    assert_eq!(store.family_apply(&edit, None).unwrap(), receipt);
    assert_eq!(rows(&store.connection), before);
}

#[test]
fn inline_binary_staging_maintains_chunk_and_namespace_facts_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let mut store = enrolled(&path);
    let request = create("binary", "image.bin", &[0, 255, 1, 127]);
    let receipt = store
        .family_apply(&request, Some(FamilyCreateMode::Binary))
        .unwrap();
    checked(&store);
    let stages: i64 = store
        .connection
        .query_row(
            "SELECT count(*) FROM binary_stages WHERE phase='committed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stages, 1, "fixture must traverse the real staged writer");
    let chunks: i64 = store
        .connection
        .query_row(
            "SELECT count(*) FROM family_graph_sources WHERE kind='chunk'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(chunks > 0);
    let edit = write(&store, "write-binary", "binary", &[8, 0, 254]);
    let edit_receipt = store.family_apply(&edit, None).unwrap();
    checked(&store);
    let before = rows(&store.connection);
    assert_eq!(
        store
            .family_apply(&request, Some(FamilyCreateMode::Binary))
            .unwrap(),
        receipt
    );
    assert_eq!(store.family_apply(&edit, None).unwrap(), edit_receipt);
    assert_eq!(rows(&store.connection), before);
    drop(store);
    let store = Store::open(&path).unwrap();
    checked(&store);
    assert_eq!(
        store.read(&id("binary")).unwrap().unwrap().content,
        Some(vec![8, 0, 254])
    );
    assert_eq!(rows(&store.connection), before);
}

#[test]
fn received_text_before_files_and_binary_sources_converge_and_replay_without_fact_changes() {
    let directory = tempfile::tempdir().unwrap();
    let mut author = enrolled(&directory.path().join("author"));
    let receiver_path = directory.path().join("receiver");
    let mut receiver = enrolled(&receiver_path);
    author
        .family_apply(
            &create("text", "note.md", b"received text"),
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    let mut text = packets(&mut author);
    text.sort_by_key(|packet| {
        if packet.0 == FamilyPayloadKind::Text {
            0
        } else {
            1
        }
    });
    assert_eq!(text[0].0, FamilyPayloadKind::Text);
    let pending = receive(&mut receiver, &text[0]);
    assert!(pending.pending_prerequisites > 0);
    checked(&receiver);
    assert!(receiver.list().unwrap().is_empty());
    drop(receiver);
    receiver = Store::open(&receiver_path).unwrap();
    checked(&receiver);
    for packet in &text[1..] {
        receive(&mut receiver, packet);
        checked(&receiver);
    }
    assert_eq!(
        receiver
            .read(&id("text"))
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        Some(b"received text".as_slice())
    );
    author
        .family_apply(
            &create("binary", "asset.bin", &[255, 0, 254]),
            Some(FamilyCreateMode::Binary),
        )
        .unwrap();
    let all = packets(&mut author);
    for packet in &all {
        receive(&mut receiver, packet);
        checked(&receiver);
    }
    assert_eq!(
        receiver.read(&id("binary")).unwrap().unwrap().content,
        Some(vec![255, 0, 254])
    );
    assert!(receiver
        .family_pending_authored(None, 100)
        .unwrap()
        .is_empty());
    let before = rows(&receiver.connection);
    for packet in &all {
        assert!(receive(&mut receiver, packet).duplicate);
    }
    assert_eq!(rows(&receiver.connection), before);
    checked(&receiver);
}

#[test]
fn changed_target_fact_corruption_rejects_write_without_membership_or_receipt_prefix() {
    for table in ["family_graph_entries", "family_graph_entry_heads"] {
        let directory = tempfile::tempdir().unwrap();
        let mut store = enrolled(&directory.path().join("db"));
        store
            .family_apply(
                &create("target", "target.md", b"original"),
                Some(FamilyCreateMode::Text),
            )
            .unwrap();
        let edit = write(&store, "corrupt-target-write", "target", b"new bytes");
        let changed = store
            .connection
            .execute(
                &format!("UPDATE {table} SET record='{{}}' WHERE entry_id='target'"),
                [],
            )
            .unwrap();
        assert!(changed > 0);
        let before = rows(&store.connection);
        assert!(
            matches!(store.family_apply(&edit, None), Err(StoreError::Corrupt(_))),
            "{table}"
        );
        assert_eq!(
            rows(&store.connection),
            before,
            "{table}: failed writer leaked rows"
        );
        no_receipt(&store, &edit);
        assert!(matches!(
            family_graph::audit_reference(&store.connection, &graph(&store)),
            Err(StoreError::Corrupt(_))
        ));
    }
}

#[test]
fn unrelated_event_fact_corruption_is_detected_by_explicit_source_check_and_scrub() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let mut store = enrolled(&path);
    for (entry, path) in [("untouched", "untouched.md"), ("edited", "edited.md")] {
        store
            .family_apply(
                &create(entry, path, b"original"),
                Some(FamilyCreateMode::Text),
            )
            .unwrap();
    }
    let (source, event): (String, String) = store.connection.query_row(
        "SELECT source_id,event_id FROM family_graph_events WHERE entry_id='untouched' ORDER BY event_id LIMIT 1", [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    let source = UpdateId::new(source).unwrap();
    let (_, guard) = family_graph::SCHEMA
        .iter()
        .find(|(name, _)| *name == "family_graph_events_no_update")
        .unwrap();
    store
        .connection
        .execute_batch("DROP TRIGGER family_graph_events_no_update")
        .unwrap();
    assert_eq!(
        store
            .connection
            .execute(
                "UPDATE family_graph_events SET record='{}' WHERE event_id=?1",
                [event]
            )
            .unwrap(),
        1
    );
    store.connection.execute_batch(guard).unwrap();
    // Reopen validates schema/readiness/head, rather than unrelated event history.
    drop(store);
    let mut store = Store::open(&path).unwrap();
    family_graph::check_current(&store.connection).unwrap();
    let edit = write(&store, "unrelated-edit", "edited", b"still editable");
    store.family_apply(&edit, None).unwrap();
    assert_eq!(
        store
            .read(&id("edited"))
            .unwrap()
            .unwrap()
            .content
            .as_deref(),
        Some(b"still editable".as_slice())
    );
    assert!(matches!(
        family_graph::check_source(&store.connection, &scope(), &source),
        Err(StoreError::Corrupt(_))
    ));
    assert!(matches!(
        family_graph::audit_reference(&store.connection, &graph(&store)),
        Err(StoreError::Corrupt(_))
    ));
}

#[test]
fn immutable_source_event_claim_and_parent_rows_reject_sql_update_and_delete() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = enrolled(&directory.path().join("db"));
    store
        .family_apply(
            &create("text", "note.md", b"first"),
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    let edit = write(&store, "make-parent", "text", b"second");
    store.family_apply(&edit, None).unwrap();
    checked(&store);
    let before = rows(&store.connection);
    for (table, column) in [
        ("family_graph_sources", "metadata"),
        ("family_graph_events", "record"),
        ("family_graph_claims", "record"),
        ("family_graph_parents", "parent_id"),
    ] {
        let count: i64 = store
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(count > 0, "{table}: fixture must exercise the guard");
        for sql in [
            format!("UPDATE {table} SET {column}={column}"),
            format!("DELETE FROM {table}"),
        ] {
            let error = store.connection.execute(&sql, []).unwrap_err();
            assert!(
                matches!(&error, rusqlite::Error::SqliteFailure(_, Some(message)) if message.contains("immutable")),
                "{table}: {error}"
            );
            assert_eq!(rows(&store.connection), before);
        }
    }
    checked(&store);
}
