//! Exact-path observations must validate their selected row without decoding
//! unrelated metadata. Full inventories keep their existing broader validation.
use super::*;
use rusqlite::Connection;
use std::fs as stdfs;

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).unwrap()
}
fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn fixture() -> (tempfile::TempDir, NativeVault, Connection) {
    let directory = tempfile::tempdir().unwrap();
    stdfs::create_dir(directory.path().join("Case")).unwrap();
    stdfs::write(directory.path().join("Case/selected.md"), b"selected bytes").unwrap();
    stdfs::write(directory.path().join("unrelated.md"), b"unrelated bytes").unwrap();
    let mut vault = NativeVault::open(directory.path()).unwrap();
    let report = vault.rescan().unwrap();
    assert!(
        report.run.complete && report.issues.is_empty(),
        "{report:?}"
    );
    // Child import can advance the parent revision. Establish its already-known
    // binding before the measured no-op observation and before injecting faults.
    {
        let _guard = vault.paths.lock(vault.options.lock_timeout).unwrap();
        assert!(vault.observe_directory(&path("Case")).unwrap().is_none());
    }
    let connection = Connection::open(directory.path().join(".zorid/vault.sqlite")).unwrap();
    (directory, vault, connection)
}
fn retained_rows(connection: &Connection) -> Vec<(String, Vec<String>)> {
    [
        ("entries", "SELECT json_array(id,path,deleted,state,hex(content),visible,content_ref,content_digest) FROM entries ORDER BY id"),
        ("bindings", "SELECT record FROM physical_bindings ORDER BY entry_id"),
        ("files", "SELECT record FROM projection_baselines ORDER BY entry_id"),
        ("directories", "SELECT record FROM directory_baselines ORDER BY entry_id"),
        ("operations", "SELECT json_array(sequence,operation_id,request,result) FROM operations ORDER BY sequence"),
        ("jobs", "SELECT json_array(job_id,completed,record) FROM projection_jobs ORDER BY ordinal"),
    ].into_iter().map(|(name,sql)| {
        let rows=connection.prepare(sql).unwrap().query_map([],|row|row.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap();
        (name.into(),rows)
    }).collect()
}
#[test]
fn selected_directory_observation_does_not_decode_unrelated_metadata() {
    let (directory, mut vault, connection) = fixture();
    connection
        .execute(
            "UPDATE entries SET state=json_set(state,'$.unexpected',1) WHERE path='unrelated.md'",
            [],
        )
        .unwrap();
    let before = retained_rows(&connection);
    // The old list()+find() path fails on this unrelated row before observing Case.
    assert!(vault.store.list().is_err());
    let _guard = vault.paths.lock(vault.options.lock_timeout).unwrap();
    assert!(vault.observe_directory(&path("Case")).unwrap().is_none());
    assert_eq!(retained_rows(&connection), before);
    assert_eq!(
        stdfs::read(directory.path().join("Case/selected.md")).unwrap(),
        b"selected bytes"
    );
    assert_eq!(
        stdfs::read(directory.path().join("unrelated.md")).unwrap(),
        b"unrelated bytes"
    );
    let plans: Vec<String> = connection
        .prepare(
            "EXPLAIN QUERY PLAN SELECT id FROM entries WHERE path=?1 AND deleted=0 AND visible=1",
        )
        .unwrap()
        .query_map(["Case"], |row| row.get(3))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(
        plans
            .iter()
            .any(|plan| plan.contains("SEARCH") && plan.contains("live_paths")),
        "{plans:?}"
    );
}
#[test]
fn selected_file_observation_does_not_decode_unrelated_metadata() {
    let (directory, mut vault, connection) = fixture();
    connection
        .execute(
            "UPDATE entries SET content_digest=NULL WHERE path='unrelated.md'",
            [],
        )
        .unwrap();
    let before = retained_rows(&connection);
    assert!(vault.store.list().is_err());
    let _guard = vault.paths.lock(vault.options.lock_timeout).unwrap();
    assert!(vault.observe(&path("Case/selected.md")).unwrap().is_none());
    assert_eq!(retained_rows(&connection), before);
    assert_eq!(
        stdfs::read(directory.path().join("Case/selected.md")).unwrap(),
        b"selected bytes"
    );
}
#[test]
fn selected_state_path_and_digest_corruption_still_fail_closed() {
    for (selected, change, is_directory) in [
        (
            "Case",
            "UPDATE entries SET state=json_set(state,'$.unexpected',1) WHERE path=?1",
            true,
        ),
        (
            "Case",
            "UPDATE entries SET state=json_set(state,'$.path','different') WHERE path=?1",
            true,
        ),
        (
            "Case",
            "UPDATE entries SET content_digest='unexpected' WHERE path=?1",
            true,
        ),
        (
            "Case/selected.md",
            "UPDATE entries SET content_digest=NULL WHERE path=?1",
            false,
        ),
    ] {
        let (directory, mut vault, connection) = fixture();
        connection.execute(change, [selected]).unwrap();
        let before = retained_rows(&connection);
        let _guard = vault.paths.lock(vault.options.lock_timeout).unwrap();
        let result = if is_directory {
            vault.observe_directory(&path(selected))
        } else {
            vault.observe(&path(selected))
        };
        assert!(result.is_err(), "{change}");
        assert_eq!(retained_rows(&connection), before);
        assert_eq!(
            stdfs::read(directory.path().join("Case/selected.md")).unwrap(),
            b"selected bytes"
        );
    }
}
#[test]
fn exact_path_lookup_preserves_case_tombstone_and_recreated_identity() {
    let (_directory, mut vault, connection) = fixture();
    assert!(vault
        .store
        .read_path_metadata(&path("case"))
        .unwrap()
        .is_none());
    assert_eq!(
        vault
            .store
            .read_path_metadata(&path("Case"))
            .unwrap()
            .unwrap()
            .state
            .kind,
        EntryKind::Folder
    );
    let id = EntryId::new("tombstone").unwrap();
    let selected = path("reused.md");
    let created = vault
        .store
        .apply(&MutationRequest {
            operation_id: op("old-create"),
            mutation: Mutation::Create {
                id: id.clone(),
                path: selected.clone(),
                kind: EntryKind::File,
                content: Some(b"old".to_vec()),
            },
        })
        .unwrap();
    vault
        .store
        .apply(&MutationRequest {
            operation_id: op("old-delete"),
            mutation: Mutation::Delete {
                id: id.clone(),
                expected: created.changes[0].after.revision.clone(),
                recursive: false,
            },
        })
        .unwrap();
    assert!(vault.store.read_path_metadata(&selected).unwrap().is_none());
    let recreated = EntryId::new("recreated").unwrap();
    vault
        .store
        .apply(&MutationRequest {
            operation_id: op("new-create"),
            mutation: Mutation::Create {
                id: recreated.clone(),
                path: selected.clone(),
                kind: EntryKind::File,
                content: Some(b"new".to_vec()),
            },
        })
        .unwrap();
    let before = retained_rows(&connection);
    let exact = vault
        .store
        .read_path_metadata(&selected)
        .unwrap()
        .unwrap()
        .state;
    assert_eq!(exact.id, recreated);
    assert_eq!(
        vault
            .store
            .list()
            .unwrap()
            .into_iter()
            .find(|state| state.path == selected),
        Some(exact)
    );
    assert!(vault
        .store
        .read_path_metadata(&path("Reused.md"))
        .unwrap()
        .is_none());
    assert_eq!(
        connection
            .query_row(
                "SELECT deleted FROM entries WHERE id=?1",
                [id.as_str()],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(retained_rows(&connection), before);
}
#[test]
fn hidden_physical_owner_and_replaced_parent_remain_blocked() {
    let (_directory, mut vault, connection) = fixture();
    connection
        .execute("UPDATE entries SET visible=0 WHERE path='Case'", [])
        .unwrap();
    assert!(vault
        .store
        .read_path_metadata(&path("Case"))
        .unwrap()
        .is_none());
    let before = retained_rows(&connection);
    let _guard = vault.paths.lock(vault.options.lock_timeout).unwrap();
    let error = vault.observe_directory(&path("Case")).unwrap_err();
    assert!(
        error.to_string().contains("retained directory owner"),
        "{error}"
    );
    assert_eq!(retained_rows(&connection), before);
    drop(_guard);

    let (directory, mut vault, connection) = fixture();
    stdfs::rename(
        directory.path().join("Case"),
        directory.path().join("retained-Case"),
    )
    .unwrap();
    stdfs::create_dir(directory.path().join("Case")).unwrap();
    stdfs::write(
        directory.path().join("Case/selected.md"),
        b"independent replacement",
    )
    .unwrap();
    let before = retained_rows(&connection);
    let _guard = vault.paths.lock(vault.options.lock_timeout).unwrap();
    assert!(vault.observe_directory(&path("Case")).is_err());
    assert_eq!(retained_rows(&connection), before);
    assert_eq!(
        stdfs::read(directory.path().join("retained-Case/selected.md")).unwrap(),
        b"selected bytes"
    );
    assert_eq!(
        stdfs::read(directory.path().join("Case/selected.md")).unwrap(),
        b"independent replacement"
    );
}
