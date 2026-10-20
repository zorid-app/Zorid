use rusqlite::Connection;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{NamespaceAttempt, NamespaceEvidence, PhysicalIdentity, ProjectionPhase, Store};

const INDEX: &str = "external_observation_unresolved_path";
fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn fixture(database: &std::path::Path) -> NamespaceAttempt {
    let mut store = Store::open(database).unwrap();
    let id = EntryId::new("file").unwrap();
    store
        .apply(&MutationRequest {
            operation_id: op("create"),
            mutation: Mutation::Create {
                id: id.clone(),
                path: VaultPath::new("original.md").unwrap(),
                kind: EntryKind::File,
                content: Some(b"durable original".to_vec()),
            },
        })
        .unwrap();
    let publication = store.begin_projection_bound(&id, "root-inode").unwrap();
    store
        .mark_projection(
            &publication.attempt_id,
            ProjectionPhase::Staged,
            Some("source-inode".into()),
        )
        .unwrap();
    store
        .finish_projection_bound(
            &publication.attempt_id,
            &PhysicalIdentity {
                inode: "source-inode".into(),
                parent_inode: "root-inode".into(),
            },
        )
        .unwrap();
    let baseline = store.projection_baseline(&id).unwrap().unwrap();
    let evidence = NamespaceEvidence {
        before: baseline.state.clone(),
        source_identity: "source-inode".into(),
        source_parent_identity: "root-inode".into(),
        destination_parent_identity: Some("root-inode".into()),
        content: Some(baseline.content.clone()),
        file_baseline: Some(baseline.clone()),
        directory_baseline: None,
        physical_binding: store.physical_binding(&id).unwrap(),
    };
    let request = MutationRequest {
        operation_id: op("move"),
        mutation: Mutation::Move {
            id,
            expected: baseline.state.revision,
            path: VaultPath::new("moved.md").unwrap(),
        },
    };
    store.apply_namespace(&request, &[evidence]).unwrap();
    let mut attempt = store
        .namespace_for_operation(&request.operation_id)
        .unwrap()
        .unwrap();
    let mut next = attempt.members[0].clone();
    next.captured = true;
    attempt.members[0] = store
        .update_namespace_member(&attempt.job.job_id, &attempt.members[0], &next)
        .unwrap();
    store
        .record_external(
            &VaultPath::new("retained.txt").unwrap(),
            None,
            b"retained observation".to_vec(),
        )
        .unwrap();
    attempt
}
fn downgrade(database: &std::path::Path, version: i64) {
    let mut connection = Connection::open(database).unwrap();
    // Reconstruct the exact old payload constraint, preserving all fixture rows.
    // Merely changing user_version on a v15 schema is not a predecessor fixture.
    connection.pragma_update(None, "foreign_keys", true).unwrap();
    let current: String = connection.query_row("SELECT sql FROM sqlite_master WHERE name='immutable_payloads'", [], |row| row.get(0)).unwrap();
    let triggers: Vec<String> = connection.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='immutable_payloads'").unwrap()
        .query_map([], |row| row.get(0)).unwrap().map(|row| row.unwrap()).collect();
    let legacy = current.replacen("CREATE TABLE \"immutable_payloads\"", "CREATE TABLE immutable_payloads", 1)
        .replace("CASE WHEN family='text' THEN 8388608 ELSE 1048576 END", "1048576");
    let tx = connection.transaction().unwrap();
    tx.pragma_update(None, "defer_foreign_keys", true).unwrap();
    tx.execute_batch("CREATE TEMP TABLE payload_copy AS SELECT * FROM immutable_payloads; DROP TABLE immutable_payloads;").unwrap();
    tx.execute_batch(&legacy).unwrap();
    tx.execute_batch("INSERT INTO immutable_payloads SELECT * FROM payload_copy; DROP TABLE payload_copy;").unwrap();
    for sql in triggers { tx.execute_batch(&sql).unwrap(); }
    assert!(tx.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
    tx.pragma_update(None, "defer_foreign_keys", false).unwrap();
    tx.commit().unwrap();
    if version < 14 { connection.execute_batch("DROP INDEX external_observation_unresolved_path;").unwrap(); }
    if version == 12 {
        connection
            .execute_batch("DROP TABLE namespace_successions;")
            .unwrap();
    }
    connection
        .pragma_update(None, "user_version", version)
        .unwrap();
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
}
fn records(database: &std::path::Path) -> Vec<(String, String)> {
    let connection = Connection::open(database).unwrap();
    let mut result = Vec::new();
    for (table, column) in [
        ("external_observations", "record"),
        ("namespace_attempts", "record"),
        ("namespace_members", "evidence"),
        ("physical_bindings", "record"),
        ("projection_baselines", "record"),
    ] {
        let rows: Vec<String> = connection
            .prepare(&format!("SELECT {column} FROM {table} ORDER BY rowid"))
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        result.extend(rows.into_iter().map(|value| (table.to_string(), value)));
    }
    result
}
#[test]
fn known_twelve_and_thirteen_migrate_directly_to_current_preserving_pending_proof_history() {
    for version in [12, 13] {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("db");
        let attempt = fixture(&database);
        downgrade(&database, version);
        let before = records(&database);
        let prior_succession_schema = if version == 13 {
            Some(
                Connection::open(&database)
                    .unwrap()
                    .query_row(
                        "SELECT sql FROM sqlite_master WHERE name='namespace_successions'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
            )
        } else {
            None
        };
        let store = Store::open(&database).unwrap();
        assert_eq!(
            store.namespace_attempt(&attempt.job.job_id).unwrap(),
            attempt
        );
        assert_eq!(
            store
                .read(&EntryId::new("file").unwrap())
                .unwrap()
                .unwrap()
                .content
                .unwrap(),
            b"durable original"
        );
        drop(store);
        assert_eq!(records(&database), before);
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            15
        );
        let index: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name=?1",
                [INDEX],
                |row| row.get(0),
            )
            .unwrap();
        assert!(index.contains("json_extract(record,'$.path')"));
        assert!(index.contains("WHERE json_extract(record,'$.resolution') IS NULL"));
        let current_succession: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='namespace_successions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if let Some(previous) = prior_succession_schema {
            assert_eq!(current_succession, previous);
        }
        drop(connection);
        assert_eq!(
            Store::open_existing_no_follow(std::fs::canonicalize(&database).unwrap())
                .unwrap()
                .namespace_attempt(&attempt.job.job_id)
                .unwrap(),
            attempt
        );
    }
}
#[test]
fn unknown_partial_or_foreign_schema_never_changes_bytes_version_or_journal() {
    for (version,change) in [
        (12,"CREATE TABLE namespace_successions(unregistered)"),
        (12,"CREATE TRIGGER foreign_trigger AFTER INSERT ON entries BEGIN SELECT 1; END"),
        (13,"DROP TABLE namespace_successions"),
        (13,"DROP TABLE namespace_successions; CREATE TABLE namespace_successions(wrong)"),
        (13,"CREATE INDEX external_observation_unresolved_path ON external_observations(observation_id)"),
        (14,"DROP INDEX external_observation_unresolved_path"),
        (14,"DROP INDEX external_observation_unresolved_path; CREATE INDEX external_observation_unresolved_path ON external_observations(observation_id)"),
        (14,"PRAGMA application_id=42"),
        (16,"SELECT 1"),
    ] {
        let directory=tempfile::tempdir().unwrap();let database=directory.path().join("db");
        drop(Store::open(&database).unwrap());
        if version<=14 {downgrade(&database,version);}else{let connection=Connection::open(&database).unwrap();connection.pragma_update(None,"user_version",version).unwrap();connection.pragma_update(None,"journal_mode","DELETE").unwrap();}
        let connection=Connection::open(&database).unwrap();connection.execute_batch(change).unwrap();drop(connection);
        let before=std::fs::read(&database).unwrap();assert!(Store::open(&database).is_err(),"version {version}: {change}");assert_eq!(std::fs::read(&database).unwrap(),before,"version {version}: {change}");
        let connection=Connection::open(&database).unwrap();assert_eq!(connection.pragma_query_value(None,"user_version",|row|row.get::<_,i64>(0)).unwrap(),version);assert_eq!(connection.pragma_query_value(None,"journal_mode",|row|row.get::<_,String>(0)).unwrap(),"delete");
    }
}
#[test]
fn malformed_legacy_json_is_rejected_before_expression_index_migration_changes_wal() {
    for version in [12, 13] {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("db");
        drop(Store::open(&database).unwrap());
        downgrade(&database, version);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "INSERT INTO external_observations VALUES('retained','malformed JSON')",
                [],
            )
            .unwrap();
        drop(connection);
        let before = std::fs::read(&database).unwrap();
        assert!(Store::open(&database).is_err());
        assert_eq!(std::fs::read(&database).unwrap(), before);
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            version
        );
    }
}
