//! Real transactions exercise quotas, rollback, reopen and serialized writers.
use super::*;
use family_ledger::{EnvelopeKey, EnvelopeMetadata, Family};
use zorid_file_sync::{metadata::GraphRecord, v2, Scope, Sha256Digest};
use zorid_sync_protocol::{RealmId, UpdateId, VaultId};

fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("usage-realm").unwrap(),
        vault_id: VaultId::new("usage-vault").unwrap(),
    }
}
fn source(id: &str, bytes: &[u8]) -> (EnvelopeMetadata, Vec<u8>) {
    let payload = v2::Payload {
        family: zorid_file_sync::Family::Files,
        format_version: 2,
        scope: scope(),
        id: UpdateId::new(id).unwrap(),
        body: v2::Body::Chunk {
            bytes: bytes.to_vec(),
        },
    };
    let exact = payload.encode().unwrap();
    let record = GraphRecord::from_authored_exact(&exact).unwrap().2;
    (
        EnvelopeMetadata {
            key: EnvelopeKey {
                realm_id: scope().realm_id,
                vault_id: scope().vault_id,
                update_id: payload.id,
            },
            family: Family::Files,
            format_version: 2,
            payload_bytes: exact.len() as u32,
            payload_digest: Sha256Digest::of(&exact),
            file_summary_digest: Some(record.summary_digest().unwrap()),
            text_binding: None,
        },
        exact,
    )
}
fn counts(tx: &Connection) -> (i64, i64, i64, i64) {
    tx.query_row("SELECT (SELECT records FROM family_graph_payload_usage),(SELECT bytes FROM family_graph_payload_usage),(SELECT records FROM family_graph_revision_usage),(SELECT highest FROM family_graph_revision_usage)", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap()
}
fn create() -> MutationRequest {
    MutationRequest {
        operation_id: zorid_core::OperationId::new("create").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("note").unwrap(),
            path: zorid_core::VaultPath::new("note.md").unwrap(),
            kind: EntryKind::File,
            content: Some(b"note".to_vec()),
        },
    }
}

#[test]
fn exact_payload_replay_and_rejected_different_bytes_do_not_charge_again() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let store = Store::open(&path).unwrap();
    let (metadata, exact) = source("first", b"one");
    let tx = store.connection.unchecked_transaction().unwrap();
    immutable_payloads::put_exact(&tx, &metadata, &exact, exact.len() as u64).unwrap();
    let expected = counts(&tx);
    immutable_payloads::put_exact(&tx, &metadata, &exact, 1).unwrap();
    assert_eq!(counts(&tx), expected);
    let (different, bytes) = source("first", b"two");
    assert!(immutable_payloads::put_exact(&tx, &different, &bytes, 100_000).is_err());
    assert_eq!(counts(&tx), expected);
    storage_accounting::audit(&tx).unwrap();
    tx.commit().unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(counts(&store.connection), expected);
    storage_accounting::audit(&store.connection).unwrap();
}

#[test]
fn rejected_source_quota_and_dropped_writer_leave_usage_and_fences_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("db")).unwrap();
    let (metadata, exact) = source("first", b"one");
    let initial = counts(&store.connection);
    {
        let tx = store.connection.unchecked_transaction().unwrap();
        immutable_payloads::put_exact(&tx, &metadata, &exact, exact.len() as u64).unwrap();
        text_sync::reserve_revision(&tx, &Revision::new("temporary").unwrap()).unwrap();
        let (second, body) = source("second", b"two");
        assert!(matches!(
            immutable_payloads::put_exact(&tx, &second, &body, exact.len() as u64),
            Err(StoreError::FileSync(zorid_file_sync::Error::TooLarge))
        ));
        assert!(immutable_payloads::head(&tx, &second.key)
            .unwrap()
            .is_none());
        assert_eq!(counts(&tx), (1, exact.len() as i64, 1, 1));
        // The enclosing operation refuses and rolls back its earlier prefix.
    }
    assert_eq!(counts(&store.connection), initial);
    assert!(immutable_payloads::head(&store.connection, &metadata.key)
        .unwrap()
        .is_none());
    storage_accounting::audit(&store.connection).unwrap();
}

#[test]
fn two_actual_connections_serialize_quota_and_counter_publication() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let mut first = Store::open(&path).unwrap();
    let mut second = Store::open(&path).unwrap();
    second
        .connection
        .busy_timeout(std::time::Duration::ZERO)
        .unwrap();
    let (a, a_bytes) = source("first", b"one");
    let (b, b_bytes) = source("second", b"two");
    let quota = (a_bytes.len() + b_bytes.len()) as u64;
    let tx = first
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    immutable_payloads::put_exact(&tx, &a, &a_bytes, quota).unwrap();
    assert!(second
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .is_err());
    tx.commit().unwrap();
    let tx = second
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    assert_eq!(
        immutable_payloads::total_bytes(&tx).unwrap(),
        a_bytes.len() as u64
    );
    immutable_payloads::put_exact(&tx, &b, &b_bytes, quota).unwrap();
    text_sync::reserve_revision(&tx, &Revision::new("peer-revision").unwrap()).unwrap();
    tx.commit().unwrap();
    assert_eq!(counts(&first.connection), (2, quota as i64, 1, 1));
    storage_accounting::audit(&first.connection).unwrap();
}

#[test]
fn missing_usage_refuses_family_command_without_receipt_or_new_source() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().join("db")).unwrap();
    store.family_enroll(&scope()).unwrap();
    store
        .connection
        .execute("DELETE FROM family_graph_payload_usage", [])
        .unwrap();
    let request = create();
    assert!(matches!(
        store.family_apply(&request, Some(FamilyCreateMode::Text)),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM operations", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM immutable_payloads", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn deleted_fence_stays_detectable_without_recounting_the_history() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("db")).unwrap();
    text_sync::reserve_revision(&store.connection, &Revision::new("first").unwrap()).unwrap();
    text_sync::reserve_revision(&store.connection, &Revision::new("second").unwrap()).unwrap();
    store
        .connection
        .execute("DELETE FROM revision_fences WHERE ordinal=1", [])
        .unwrap();
    assert_eq!(counts(&store.connection).2, 1);
    assert!(matches!(
        text_sync::reserve_revision(&store.connection, &Revision::new("third").unwrap()),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM revision_fences", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn explicit_accounting_audit_detects_unrelated_usage_substitution() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("db")).unwrap();
    let (metadata, exact) = source("first", b"one");
    immutable_payloads::put_exact(&store.connection, &metadata, &exact, 100_000).unwrap();
    store
        .connection
        .execute("UPDATE family_graph_payload_usage SET bytes=bytes+1", [])
        .unwrap();
    // Scalar sanity is not falsely advertised as a complete corruption scrub.
    storage_accounting::check_current(&store.connection).unwrap();
    assert!(matches!(
        storage_accounting::audit(&store.connection),
        Err(StoreError::Corrupt(_))
    ));
}

#[test]
fn schema_fifteen_backfill_accounts_unpublished_sources_and_existing_fences() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.family_enroll(&scope()).unwrap();
    store
        .family_apply(&create(), Some(FamilyCreateMode::Text))
        .unwrap();
    let (metadata, exact) = source("unpublished", b"retained but not a graph member");
    immutable_payloads::put_exact(&store.connection, &metadata, &exact, 100_000).unwrap();
    let expected = counts(&store.connection);
    for (name, _) in family_graph::SCHEMA
        .iter()
        .chain(storage_accounting::schema())
        .rev()
    {
        let kind: String = store
            .connection
            .query_row(
                "SELECT type FROM sqlite_master WHERE name=?1",
                [name],
                |row| row.get(0),
            )
            .unwrap();
        store
            .connection
            .execute_batch(&format!("DROP {kind} \"{name}\""))
            .unwrap();
    }
    // Version15 already has the expanded Text payload constraint; only graph
    // facts/accounting are introduced by the version16 migration.
    store.connection.execute_batch("DROP TABLE host_intent_sources").unwrap();
    store
        .connection
        .pragma_update(None, "user_version", TEXT_SCHEMA_VERSION)
        .unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(counts(&store.connection), expected);
    storage_accounting::audit(&store.connection).unwrap();
    assert_eq!(
        immutable_payloads::read_exact(&store.connection, &metadata).unwrap(),
        exact
    );
    assert_eq!(store.family_status().unwrap().graph_records, 2);
}
