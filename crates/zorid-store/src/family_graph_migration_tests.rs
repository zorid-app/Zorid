//! Schema transitions exercise real immutable sources, rather than caller-made
//! derived graph facts. These tests may use private schema registration only.
use super::*;
use crate::blob_index::test_support::{append, scope};
use rusqlite::types::Value;

fn drop_graph_schema(connection: &Connection) {
    for (name, _) in family_graph::SCHEMA
        .iter()
        .chain(storage_accounting::schema())
        .rev()
    {
        let kind: String = connection
            .query_row(
                "SELECT type FROM sqlite_master WHERE name=?1",
                [name],
                |row| row.get(0),
            )
            .unwrap();
        assert!(matches!(kind.as_str(), "table" | "index" | "trigger"));
        connection
            .execute_batch(&format!("DROP {kind} \"{name}\""))
            .unwrap();
    }
}

pub(super) fn downgrade(path: &Path, version: i64) {
    let mut connection = Connection::open(path).unwrap();
    databases::drop_schema_for_test(&connection);
    connection.execute_batch("DROP TABLE host_intent_sources").unwrap();
    drop_graph_schema(&connection);
    if version < TEXT_SCHEMA_VERSION {
        one_mib_text_tests::restore_legacy_payload_table(&mut connection);
    }
    if version < OBSERVATION_SCHEMA_VERSION {
        connection
            .execute_batch("DROP INDEX external_observation_unresolved_path")
            .unwrap();
    }
    if version == PREDECESSOR_SCHEMA_VERSION {
        connection
            .execute_batch("DROP TABLE namespace_successions")
            .unwrap();
    }
    connection
        .pragma_update(None, "user_version", version)
        .unwrap();
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
}

fn source_rows(connection: &Connection) -> Vec<(String, Vec<Vec<Value>>)> {
    let names: Vec<String> = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
    ).unwrap().query_map([], |row| row.get(0)).unwrap()
        .collect::<rusqlite::Result<_>>().unwrap();
    names
        .into_iter()
        .filter(|name| {
            !family_graph::SCHEMA
                .iter()
                .any(|(graph_name, _)| *graph_name == name.as_str())
                && !storage_accounting::schema()
                    .any(|(accounting_name, _)| *accounting_name == name.as_str())
                && name != "namespace_successions"
                && name != "host_intent_sources"
                && !databases::SCHEMA.iter().any(|(database_name,_)|*database_name==name)
        })
        .map(|name| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, Value>(column))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}

fn seeded(path: &Path) -> zorid_file_sync::metadata::MetadataState {
    let mut store = Store::open(path).unwrap();
    store.family_enroll(&scope()).unwrap();
    let initial = blob_index::load_metadata(&store.connection, &scope())
        .unwrap()
        .unwrap();
    append(&store.connection, &initial, "retained-chunk", "next")
}

#[test]
fn empty_initialization_registers_current_schema_and_reopens() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let store = Store::open(&path).unwrap();
    assert_eq!(check_schema(&store.connection).unwrap(), SCHEMA_VERSION);
    family_graph::check_current(&store.connection).unwrap();
    drop(store);
    assert_eq!(
        check_schema(&Store::open(&path).unwrap().connection).unwrap(),
        SCHEMA_VERSION
    );
}

#[test]
fn known_old_schemas_backfill_real_graph_without_rewriting_sources() {
    for version in [
        PREDECESSOR_SCHEMA_VERSION,
        NAMESPACE_SCHEMA_VERSION,
        OBSERVATION_SCHEMA_VERSION,
        TEXT_SCHEMA_VERSION,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        let expected = seeded(&path);
        downgrade(&path, version);
        let before = source_rows(&Connection::open(&path).unwrap());
        let store = Store::open(&path).unwrap();
        assert_eq!(check_schema(&store.connection).unwrap(), SCHEMA_VERSION);
        assert_eq!(
            blob_index::load_metadata(&store.connection, &scope()).unwrap(),
            Some(expected)
        );
        family_graph::check_current(&store.connection).unwrap();
        assert_eq!(source_rows(&store.connection), before);
        drop(store);
        let reopened =
            Store::open_existing_no_follow(std::fs::canonicalize(&path).unwrap()).unwrap();
        family_graph::check_current(&reopened.connection).unwrap();
        assert_eq!(source_rows(&reopened.connection), before);
    }
}

#[test]
fn corrupt_legacy_source_rolls_back_graph_schema_and_prior_migrations() {
    for version in [
        PREDECESSOR_SCHEMA_VERSION,
        NAMESPACE_SCHEMA_VERSION,
        OBSERVATION_SCHEMA_VERSION,
        TEXT_SCHEMA_VERSION,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        seeded(&path);
        downgrade(&path, version);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE family_graph_heads SET record_count=record_count+1",
                [],
            )
            .unwrap();
        let before = source_rows(&connection);
        drop(connection);
        assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))));
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            version
        );
        assert_eq!(source_rows(&connection), before);
        for (name, _) in family_graph::SCHEMA.iter().chain(storage_accounting::schema()) {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                    [name],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(
                !exists,
                "partial graph object {name} survived migration failure"
            );
        }
        let unresolved: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [projection::EXTERNAL_UNRESOLVED_INDEX.0],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unresolved, version >= OBSERVATION_SCHEMA_VERSION);
        let succession: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='namespace_successions')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(succession, version != PREDECESSOR_SCHEMA_VERSION);
        drop(connection);
        // A failed backfill is retryable after the original source is corrected.
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE family_graph_heads SET record_count=record_count-1",
                [],
            )
            .unwrap();
        drop(connection);
        let store = Store::open(&path).unwrap();
        assert_eq!(check_schema(&store.connection).unwrap(), SCHEMA_VERSION);
    }
}

#[test]
fn missing_current_graph_object_is_rejected_before_journal_changes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    drop(Store::open(&path).unwrap());
    let connection = Connection::open(&path).unwrap();
    drop_graph_schema(&connection);
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
}

#[test]
fn immutable_descriptor_corruption_is_not_blessed_by_backfill() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    seeded(&path);
    downgrade(&path, OBSERVATION_SCHEMA_VERSION);
    let connection = Connection::open(&path).unwrap();
    let original: String = connection
        .query_row("SELECT descriptor FROM immutable_payloads", [], |row| {
            row.get(0)
        })
        .unwrap();
    // Model external corruption while retaining the exact registered schema.
    let trigger = immutable_payloads::SCHEMA
        .iter()
        .find(|(name, _)| *name == "immutable_payloads_no_update")
        .unwrap()
        .1;
    connection
        .execute_batch("DROP TRIGGER immutable_payloads_no_update")
        .unwrap();
    connection
        .execute("UPDATE immutable_payloads SET descriptor='{}'", [])
        .unwrap();
    connection.execute_batch(trigger).unwrap();
    let before = source_rows(&connection);
    drop(connection);
    assert!(matches!(Store::open(&path), Err(StoreError::Corrupt(_))));
    let connection = Connection::open(&path).unwrap();
    assert_eq!(source_rows(&connection), before);
    assert_eq!(
        check_schema(&connection).unwrap(),
        OBSERVATION_SCHEMA_VERSION
    );
    connection
        .execute_batch("DROP TRIGGER immutable_payloads_no_update")
        .unwrap();
    connection
        .execute("UPDATE immutable_payloads SET descriptor=?1", [original])
        .unwrap();
    connection.execute_batch(trigger).unwrap();
    drop(connection);
    let store = Store::open(&path).unwrap();
    family_graph::check_current(&store.connection).unwrap();
}

fn assert_coverage_failure_preserves_legacy(path: &Path, version: i64) {
    let connection = Connection::open(path).unwrap();
    let before = source_rows(&connection);
    drop(connection);
    assert!(matches!(Store::open(path), Err(StoreError::Corrupt(_))));
    let connection = Connection::open(path).unwrap();
    assert_eq!(check_schema(&connection).unwrap(), version);
    assert_eq!(source_rows(&connection), before);
    for (name, _) in family_graph::SCHEMA.iter().chain(storage_accounting::schema()) {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [name],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!exists, "graph object {name} survived rejected coverage");
    }
}

#[test]
fn missing_empty_combined_enrollment_head_is_not_blessed_by_migration() {
    for version in [
        PREDECESSOR_SCHEMA_VERSION,
        NAMESPACE_SCHEMA_VERSION,
        OBSERVATION_SCHEMA_VERSION,
        TEXT_SCHEMA_VERSION,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        let mut store = Store::open(&path).unwrap();
        store.family_enroll(&scope()).unwrap();
        drop(store);
        downgrade(&path, version);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM family_graph_heads")
            .unwrap();
        drop(connection);
        assert_coverage_failure_preserves_legacy(&path, version);
    }
}

#[test]
fn orphan_legacy_member_without_head_is_not_omitted_from_backfill() {
    for version in [
        PREDECESSOR_SCHEMA_VERSION,
        NAMESPACE_SCHEMA_VERSION,
        OBSERVATION_SCHEMA_VERSION,
        TEXT_SCHEMA_VERSION,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        seeded(&path);
        downgrade(&path, version);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM family_graph_heads")
            .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM family_file_records", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(connection);
        assert_coverage_failure_preserves_legacy(&path, version);
    }
}

#[test]
fn legacy_graph_head_without_enrolled_authority_rolls_back_migration() {
    for version in [
        PREDECESSOR_SCHEMA_VERSION,
        NAMESPACE_SCHEMA_VERSION,
        OBSERVATION_SCHEMA_VERSION,
        TEXT_SCHEMA_VERSION,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        seeded(&path);
        downgrade(&path, version);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE authority_identity SET realm_id=NULL,vault_id=NULL",
                [],
            )
            .unwrap();
        drop(connection);
        assert_coverage_failure_preserves_legacy(&path, version);
    }
}

#[test]
fn genuine_legacy_bound_text_migrates_without_combined_graph_enrollment() {
    for version in [
        PREDECESSOR_SCHEMA_VERSION,
        NAMESPACE_SCHEMA_VERSION,
        OBSERVATION_SCHEMA_VERSION,
        TEXT_SCHEMA_VERSION,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        let mut store = Store::open(&path).unwrap();
        let identity = zorid_client_sync::TextIdentity {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            entry_id: EntryId::new("legacy-text").unwrap(),
            bootstrap_id: zorid_sync_protocol::UpdateId::new("legacy-bootstrap").unwrap(),
        };
        let created = store
            .apply(&MutationRequest {
                operation_id: zorid_core::OperationId::new("legacy-create").unwrap(),
                mutation: Mutation::Create {
                    id: identity.entry_id.clone(),
                    path: zorid_core::VaultPath::new("legacy.md").unwrap(),
                    kind: EntryKind::File,
                    content: Some(Vec::new()),
                },
            })
            .unwrap();
        let revision = &created
            .changes
            .iter()
            .find(|change| change.after.id == identity.entry_id)
            .unwrap()
            .after
            .revision;
        let text = store.bind_empty_text(&identity, revision).unwrap();
        assert!(!store.family_is_enrolled().unwrap());
        drop(store);
        downgrade(&path, version);
        let before = source_rows(&Connection::open(&path).unwrap());
        let store = Store::open(&path).unwrap();
        assert_eq!(check_schema(&store.connection).unwrap(), SCHEMA_VERSION);
        assert!(!store.family_is_enrolled().unwrap());
        assert_eq!(
            store.text_state(&identity.entry_id).unwrap(),
            Some(text.clone())
        );
        assert_eq!(source_rows(&store.connection), before);
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.text_state(&identity.entry_id).unwrap(), Some(text));
    }
}
