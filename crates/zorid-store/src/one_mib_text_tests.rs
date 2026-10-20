use super::*;
use rusqlite::types::Value;
use std::collections::BTreeMap;
use zorid_core::{OperationId, VaultPath};
use zorid_sync_protocol::{RealmId, VaultId};

fn create(id: &str, bytes: &[u8]) -> MutationRequest {
    MutationRequest { operation_id: OperationId::new(format!("create-{id}")).unwrap(), mutation: Mutation::Create {
        id: EntryId::new(id).unwrap(), path: VaultPath::new(format!("{id}.md")).unwrap(), kind: EntryKind::File, content: Some(bytes.to_vec()),
    } }
}
fn graph_object(name: &str) -> bool {
    family_graph::SCHEMA.iter().chain(storage_accounting::schema()).any(|(registered, _)| *registered == name)
}
fn records(connection: &Connection) -> BTreeMap<String, Vec<Vec<Value>>> {
    let names: Vec<String> = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").unwrap()
        .query_map([], |row| row.get(0)).unwrap().map(|row| row.unwrap()).collect();
    names.into_iter().map(|name| {
        let mut statement = connection.prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid")).unwrap();
        let columns = statement.column_count();
        if graph_object(&name) {
            // Rebuilt derived rows can have different insertion order. Compare
            // their complete values in canonical SQL column order instead.
            let order = (1..=columns).map(|column| column.to_string()).collect::<Vec<_>>().join(",");
            statement = connection.prepare(&format!("SELECT * FROM \"{name}\" ORDER BY {order}")).unwrap();
        }
        let rows = statement.query_map([], |row| (0..columns).map(|column| row.get(column)).collect::<rusqlite::Result<Vec<Value>>>()).unwrap()
            .map(|row| row.unwrap()).collect();
        (name, rows)
    }).collect()
}
fn legacy_copy(source: &std::path::Path, destination: &std::path::Path, version: i64) {
    assert!(matches!(version, OBSERVATION_SCHEMA_VERSION | TEXT_SCHEMA_VERSION));
    let mut connection = Connection::open(destination).unwrap();
    connection.pragma_update(None, "foreign_keys", true).unwrap();
    for (name, sql) in schema_objects().into_iter().filter(|(name, _)| !graph_object(name)) {
        connection.execute_batch(if name == "immutable_payloads" && version < TEXT_SCHEMA_VERSION { immutable_payloads::LEGACY_TABLE_SQL } else { sql }).unwrap();
    }
    connection.execute("ATTACH DATABASE ?1 AS previous", [source.to_str().unwrap()]).unwrap();
    let tables: Vec<String> = connection.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").unwrap()
        .query_map([], |row| row.get(0)).unwrap().map(|row| row.unwrap()).collect();
    let tx = connection.transaction().unwrap();
    tx.pragma_update(None, "defer_foreign_keys", true).unwrap();
    for name in tables { tx.execute_batch(&format!("INSERT INTO main.\"{name}\" SELECT * FROM previous.\"{name}\";")).unwrap(); }
    tx.pragma_update(None, "application_id", APPLICATION_ID).unwrap();
    tx.pragma_update(None, "user_version", version).unwrap();
    tx.commit().unwrap();
    connection.execute_batch("DETACH DATABASE previous; PRAGMA journal_mode=DELETE;").unwrap();
    assert_eq!(check_schema(&connection).unwrap(), version);
}

pub(super) fn restore_legacy_payload_table(connection: &mut Connection) {
    connection.pragma_update(None, "foreign_keys", true).unwrap();
    let tx = connection.transaction().unwrap();
    tx.pragma_update(None, "defer_foreign_keys", true).unwrap();
    tx.execute_batch("CREATE TEMP TABLE payload_copy AS SELECT * FROM immutable_payloads; DROP TABLE immutable_payloads;").unwrap();
    tx.execute_batch(immutable_payloads::LEGACY_TABLE_SQL).unwrap();
    tx.execute_batch("INSERT INTO immutable_payloads SELECT * FROM payload_copy; DROP TABLE payload_copy;").unwrap();
    for (_, sql) in &immutable_payloads::SCHEMA[1..] { tx.execute_batch(sql).unwrap(); }
    assert!(tx.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
    tx.pragma_update(None, "defer_foreign_keys", false).unwrap();
    tx.commit().unwrap();
}

#[test]
fn one_mib_text_migration_preserves_populated_fourteen_and_reopens_large_note() {
    assert_eq!(zorid_sync_protocol::MAX_PLAINTEXT_BYTES, 8 * 1024 * 1024);
    let directory = tempfile::tempdir().unwrap();
    let current = directory.path().join("source.db");
    let legacy = directory.path().join("legacy.db");
    let mut store = Store::open(&current).unwrap();
    store.family_enroll(&FamilyScope { realm_id: RealmId::new("realm").unwrap(), vault_id: VaultId::new("vault").unwrap() }).unwrap();
    store.family_apply(&create("retained", b"original bytes"), Some(FamilyCreateMode::Text)).unwrap();
    let checkpoint_scope = CheckpointScope { vault_id: store.identity().unwrap().local_store_id, client_id: OperationId::new("client").unwrap() };
    let checkpoint = store.checkpoint_compare_and_swap(&checkpoint_scope, CheckpointWrite {
        key: "retained-draft", expected_revision: None, next_revision: "00000000-0000-4000-8000-000000000001", encoded_state: Some("retained recovery bytes"),
    }).unwrap();
    let before = records(&store.connection);
    legacy_copy(&current, &legacy, OBSERVATION_SCHEMA_VERSION);
    let mut migrated = Store::open(&legacy).unwrap();
    assert!(records(&migrated.connection) == before, "migration must preserve all durable table values");
    assert_eq!(migrated.connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
    assert!(migrated.connection.pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0)).unwrap());
    assert_eq!(migrated.checkpoint_load(&checkpoint_scope, "retained-draft").unwrap(), Some(checkpoint.clone()));
    assert!(migrated.connection.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
    let text = format!("{}x", "\u{800}".repeat((1024 * 1024) / 3));
    migrated.family_apply(&create("large", text.as_bytes()), Some(FamilyCreateMode::Text)).unwrap();
    let row = migrated.read(&EntryId::new("large").unwrap()).unwrap().unwrap();
    assert_eq!(row.content.as_deref(), Some(text.as_bytes()));
    let write = MutationRequest { operation_id: OperationId::new("large-edit").unwrap(), mutation: Mutation::Write {
        id: row.state.id.clone(), expected: row.state.revision, content: format!("{}y", "\u{800}".repeat((1024 * 1024) / 3)).into_bytes(),
    } };
    migrated.family_apply(&write, None).unwrap();
    let expected = migrated.read(&row.state.id).unwrap().unwrap();
    drop(migrated);
    let mut reopened = Store::open(&legacy).unwrap();
    assert_eq!(reopened.read(&row.state.id).unwrap(), Some(expected));
    assert_eq!(reopened.checkpoint_load(&checkpoint_scope, "retained-draft").unwrap(), Some(checkpoint));
}

#[test]
fn populated_fifteen_migrates_large_text_payload_to_sixteen_without_rewriting_sources() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.db");
    let legacy = directory.path().join("fifteen.db");
    let mut store = Store::open(&source).unwrap();
    store.family_enroll(&FamilyScope { realm_id: RealmId::new("realm").unwrap(), vault_id: VaultId::new("vault").unwrap() }).unwrap();
    // The note respects the 1 MiB document limit, while its exact encoded Text
    // envelope exceeds the former 1 MiB immutable-payload constraint.
    let text = format!("{}x", "\u{800}".repeat((1024 * 1024) / 3));
    assert_eq!(text.len(), zorid_client_sync::MAX_TEXT_BYTES);
    store.family_apply(&create("large-fifteen", text.as_bytes()), Some(FamilyCreateMode::Text)).unwrap();
    let payload_size: i64 = store.connection.query_row("SELECT max(payload_bytes) FROM immutable_payloads WHERE family='text'", [], |row| row.get(0)).unwrap();
    assert!(payload_size > 1024 * 1024);
    let checkpoint_scope = CheckpointScope { vault_id: store.identity().unwrap().local_store_id, client_id: OperationId::new("fifteen-client").unwrap() };
    let checkpoint = store.checkpoint_compare_and_swap(&checkpoint_scope, CheckpointWrite {
        key: "retained-draft", expected_revision: None, next_revision: "00000000-0000-4000-8000-000000000015", encoded_state: Some("version fifteen recovery"),
    }).unwrap();
    let expected = records(&store.connection);
    let expected_text = text_sync::retained(&store.connection, &EntryId::new("large-fifteen").unwrap()).unwrap();
    legacy_copy(&source, &legacy, TEXT_SCHEMA_VERSION);
    let predecessor = Connection::open(&legacy).unwrap();
    assert_eq!(check_schema(&predecessor).unwrap(), TEXT_SCHEMA_VERSION);
    let expected_sources: BTreeMap<_, _> = expected.iter().filter(|(name, _)| !graph_object(name)).map(|(name, rows)| (name.clone(), rows.clone())).collect();
    assert_eq!(records(&predecessor), expected_sources);
    let table_sql: String = predecessor.query_row("SELECT sql FROM sqlite_master WHERE name='immutable_payloads'", [], |row| row.get(0)).unwrap();
    assert_eq!(table_sql, immutable_payloads::SCHEMA[0].1);
    drop(predecessor);
    drop(store);
    let mut migrated = Store::open(&legacy).unwrap();
    assert_eq!(check_schema(&migrated.connection).unwrap(), SCHEMA_VERSION);
    assert_eq!(records(&migrated.connection), expected);
    family_graph::check_current(&migrated.connection).unwrap();
    storage_accounting::audit(&migrated.connection).unwrap();
    assert_eq!(migrated.read(&EntryId::new("large-fifteen").unwrap()).unwrap().unwrap().content.as_deref(), Some(text.as_bytes()));
    assert_eq!(text_sync::retained(&migrated.connection, &EntryId::new("large-fifteen").unwrap()).unwrap(), expected_text);
    assert_eq!(migrated.checkpoint_load(&checkpoint_scope, "retained-draft").unwrap(), Some(checkpoint.clone()));
    drop(migrated);
    let mut reopened = Store::open(&legacy).unwrap();
    assert_eq!(records(&reopened.connection), expected);
    assert_eq!(reopened.checkpoint_load(&checkpoint_scope, "retained-draft").unwrap(), Some(checkpoint));
}

#[test]
fn one_mib_text_migration_rejects_changed_old_schema_without_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.db");
    let legacy = directory.path().join("legacy.db");
    drop(Store::open(&source).unwrap());
    legacy_copy(&source, &legacy, OBSERVATION_SCHEMA_VERSION);
    let connection = Connection::open(&legacy).unwrap();
    connection.execute_batch("DROP TRIGGER immutable_payloads_no_update;").unwrap();
    drop(connection);
    let before = std::fs::read(&legacy).unwrap();
    assert!(Store::open(&legacy).is_err());
    assert_eq!(std::fs::read(&legacy).unwrap(), before);
}

#[test]
fn one_mib_text_migration_bad_foreign_key_rolls_back_table_rebuild() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.db");
    let legacy = directory.path().join("legacy.db");
    drop(Store::open(&source).unwrap());
    legacy_copy(&source, &legacy, OBSERVATION_SCHEMA_VERSION);
    let connection = Connection::open(&legacy).unwrap();
    // Deliberately corrupt a known-format fixture outside the product writer.
    connection.pragma_update(None, "foreign_keys", false).unwrap();
    connection.execute("INSERT INTO authored_envelopes VALUES('realm','vault','missing-source','{}',NULL,0)", []).unwrap();
    let before = records(&connection);
    drop(connection);
    assert!(Store::open(&legacy).is_err());
    let connection = Connection::open(&legacy).unwrap();
    assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 14);
    let table_sql: String = connection.query_row("SELECT sql FROM sqlite_master WHERE name='immutable_payloads'", [], |row| row.get(0)).unwrap();
    assert_eq!(table_sql, immutable_payloads::LEGACY_TABLE_SQL);
    assert!(records(&connection) == before, "failed FK verification must roll back every table change");
}
