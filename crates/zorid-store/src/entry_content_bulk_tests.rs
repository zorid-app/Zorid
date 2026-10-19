use super::*;
use rusqlite::types::Value;
use zorid_core::OperationId;

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("store.sqlite")).unwrap();
    (dir, store)
}
fn create(id: &str, path: &str, kind: EntryKind) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(format!("create-{id}")).unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new(id).unwrap(),
            path: VaultPath::new(path).unwrap(),
            kind,
            content: (kind == EntryKind::File).then(|| path.as_bytes().to_vec()),
        },
    }
}
fn delete(store: &mut Store, id: &str) {
    let id = EntryId::new(id).unwrap();
    let state = store.read_metadata(&id).unwrap().unwrap().state;
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new(format!("delete-{id}")).unwrap(),
            mutation: Mutation::Delete {
                id,
                expected: state.revision,
                recursive: false,
            },
        })
        .unwrap();
}
fn mixed_store() -> (tempfile::TempDir, Store) {
    let (dir, mut store) = store();
    for (id, path, kind) in [
        ("folder", "dir", EntryKind::Folder),
        ("upper", "dir/A.md", EntryKind::File),
        ("lower", "dir/a.md", EntryKind::File),
        ("unicode-z", "é.md", EntryKind::File),
        ("unicode-a", "å.md", EntryKind::File),
        ("hidden", "hidden.md", EntryKind::File),
        ("z-first", "reused.md", EntryKind::File),
    ] {
        store.apply(&create(id, path, kind)).unwrap();
    }
    delete(&mut store, "z-first");
    store
        .apply(&create("a-second", "reused.md", EntryKind::File))
        .unwrap();
    delete(&mut store, "a-second");
    store
        .apply(&create("m-live", "reused.md", EntryKind::File))
        .unwrap();
    store
        .connection
        .execute("UPDATE entries SET visible=0 WHERE id='hidden'", [])
        .unwrap();
    (dir, store)
}
fn graph_store() -> (tempfile::TempDir, Store) {
    let (dir, mut store) = store();
    store
        .family_enroll(&blob_index::test_support::scope())
        .unwrap();
    store
        .family_apply(
            &create("binary", "binary.bin", EntryKind::File),
            Some(FamilyCreateMode::Binary),
        )
        .unwrap();
    (dir, store)
}

// Original complete-snapshot reader, retained only as a differential oracle.
fn point_states(tx: &Connection, include_deleted: bool) -> Result<Vec<EntryState>> {
    let ids = tx
        .prepare("SELECT id FROM entries WHERE visible=1 AND (?1 OR deleted=0) ORDER BY path")?
        .query_map([include_deleted], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            read_metadata_row(tx, &EntryId::new(id)?)?
                .map(|entry| entry.state)
                .ok_or_else(|| corrupt("listed entry disappeared"))
        })
        .collect()
}
fn assert_matches_points(store: &Store) {
    let tx = store.connection.unchecked_transaction().unwrap();
    for include_deleted in [false, true] {
        assert_eq!(
            read_states(&tx, include_deleted).unwrap(),
            point_states(&tx, include_deleted).unwrap()
        );
    }
    let expected = point_states(&tx, false)
        .unwrap()
        .into_iter()
        .map(|state| read_metadata_row(&tx, &state.id).unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(read_visible_metadata(&tx).unwrap(), expected);
    tx.commit().unwrap();
}
// All authoritative table values, including bodies, receipts, retained proofs
// and SQLite sequences. Test fixtures are small; production readers never do this.
fn authority(store: &Store) -> Vec<(String, Vec<Vec<Value>>)> {
    let tables = store
        .connection
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|name| {
            let sql = format!(
                "SELECT * FROM \"{}\" ORDER BY rowid",
                name.replace('"', "\"\"")
            );
            let mut statement = store.connection.prepare(&sql).unwrap();
            let columns = statement.column_count();
            let values = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, Value>(column))
                        .collect()
                })
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            (name, values)
        })
        .collect()
}
fn write(id: &str, expected: Revision, operation: &str, content: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(operation).unwrap(),
        mutation: Mutation::Write {
            id: EntryId::new(id).unwrap(),
            expected,
            content: content.to_vec(),
        },
    }
}

#[test]
fn full_membership_and_path_order_match_points_including_tombstone_ties() {
    let (_dir, store) = mixed_store();
    let before = authority(&store);
    assert_matches_points(&store);
    let retained = read_states(&store.connection, true).unwrap();
    let ties: Vec<_> = retained
        .iter()
        .filter(|state| state.path.as_str() == "reused.md")
        .map(|state| (state.id.as_str(), state.deleted))
        .collect();
    assert_eq!(
        ties,
        vec![("z-first", true), ("a-second", true), ("m-live", false)]
    );
    assert_eq!(retained.len(), 8);
    assert!(!retained.iter().any(|state| state.id.as_str() == "hidden"));
    assert!(retained.windows(2).all(|pair| pair[0].path <= pair[1].path));
    assert_eq!(store.list().unwrap().len(), 6);
    assert_eq!(authority(&store), before);
}

#[test]
fn bundled_sqlite_streams_inline_and_graph_metadata_without_a_sorter() {
    for (_dir, store) in [mixed_store(), graph_store()] {
        let before = authority(&store);
        assert_matches_points(&store);
        let plan: Vec<String> = store
            .connection
            .prepare(&format!("EXPLAIN QUERY PLAN {READ_STATES_SQL}"))
            .unwrap()
            .query_map(
                params![true, MAX_REFERENCE_BYTES, MAX_DIGEST_BYTES],
                |row| row.get(3),
            )
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter().all(|line| !line.contains("TEMP B-TREE")),
            "{plan:?}"
        );
        let ops: Vec<String> = store
            .connection
            .prepare(&format!("EXPLAIN {READ_STATES_SQL}"))
            .unwrap()
            .query_map(
                params![true, MAX_REFERENCE_BYTES, MAX_DIGEST_BYTES],
                |row| row.get(1),
            )
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert!(
            ops.iter()
                .all(|op| !op.starts_with("Sorter") && op != "OpenEphemeral"),
            "{ops:?}"
        );
        assert_eq!(authority(&store), before);
    }
}

#[test]
fn bulk_metadata_keeps_unread_body_hashes_out_of_snapshot_validation() {
    let (_dir, mut store) = store();
    store
        .apply(&create("file", "file.md", EntryKind::File))
        .unwrap();
    // Metadata reports the actual inline length and stored digest. It must not
    // materialize/hash a body while validating the complete planner snapshot.
    store
        .connection
        .execute("UPDATE entries SET content=zeroblob(1048576)", [])
        .unwrap();
    let before = authority(&store);
    assert_matches_points(&store);
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(
        store
            .read_metadata(&EntryId::new("file").unwrap())
            .unwrap()
            .unwrap()
            .content
            .unwrap()
            .len(),
        1048576
    );
    assert!(matches!(
        store.read(&EntryId::new("file").unwrap()),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(authority(&store), before);
}

#[test]
fn every_visible_row_keeps_canonical_and_content_checks_before_mutation() {
    for sql in [
        "UPDATE entries SET state=json_set(state,'$.path','other.md') WHERE id='file'",
        "UPDATE entries SET state=json_set(state,'$.id','other') WHERE id='file'",
        "UPDATE entries SET state=json_set(state,'$.unexpected',true) WHERE id='file'",
        "UPDATE entries SET state=json_set(state,'$.deleted',json('true')) WHERE id='file'",
        "UPDATE entries SET content_digest=NULL WHERE id='file'",
        "UPDATE entries SET content_digest='not-json' WHERE id='file'",
        "UPDATE entries SET content_ref='{}' WHERE id='file'",
    ] {
        let (_dir, mut store) = store();
        store
            .apply(&create("file", "file.md", EntryKind::File))
            .unwrap();
        store.connection.execute(sql, []).unwrap();
        let before = authority(&store);
        assert!(
            read_metadata_row(&store.connection, &EntryId::new("file").unwrap()).is_err(),
            "{sql}"
        );
        for include_deleted in [false, true] {
            assert!(
                read_states(&store.connection, include_deleted).is_err(),
                "{sql}"
            );
        }
        assert!(read_visible_metadata(&store.connection).is_err(), "{sql}");
        assert!(
            store
                .apply(&create("unrelated", "unrelated.md", EntryKind::File))
                .is_err(),
            "{sql}"
        );
        assert_eq!(authority(&store), before, "{sql}");
    }
}

#[test]
fn bounds_precede_string_getters_and_original_sql_types_are_preserved() {
    for (column, value, bounds_error) in [
        (
            "content_ref",
            Value::Text("x".repeat(MAX_REFERENCE_BYTES as usize + 1)),
            true,
        ),
        (
            "content_ref",
            Value::Blob(vec![b'x'; MAX_REFERENCE_BYTES as usize + 1]),
            true,
        ),
        ("content_ref", Value::Blob(b"{}".to_vec()), false),
        ("content_ref", Value::Text(String::new()), true),
        ("content_digest", Value::Text("é".repeat(129)), true),
        (
            "content_digest",
            Value::Blob(vec![b'x'; MAX_DIGEST_BYTES as usize + 1]),
            true,
        ),
        ("content_digest", Value::Blob(b"{}".to_vec()), false),
        ("content_digest", Value::Text(String::new()), true),
    ] {
        let (_dir, store) = store();
        // No double-authority error masks the reference bound/type under test.
        let mut state = create("file", "file.md", EntryKind::File);
        if let Mutation::Create { content, .. } = &mut state.mutation {
            *content = Some(vec![]);
        }
        let mut store = store;
        store.apply(&state).unwrap();
        if column == "content_ref" {
            store
                .connection
                .execute("UPDATE entries SET content=NULL", [])
                .unwrap();
        }
        store
            .connection
            .execute(&format!("UPDATE entries SET {column}=?1"), [value])
            .unwrap();
        let before = authority(&store);
        for error in [
            read_metadata_row(&store.connection, &EntryId::new("file").unwrap()).unwrap_err(),
            read_states(&store.connection, true).unwrap_err(),
            read_visible_metadata(&store.connection).unwrap_err(),
        ] {
            if bounds_error {
                assert!(
                    matches!(error, StoreError::Corrupt(ref message) if message == "invalid entry content authority or metadata bounds"),
                    "{error:?}"
                );
            } else {
                assert!(
                    matches!(
                        error,
                        StoreError::Sql(rusqlite::Error::InvalidColumnType(..))
                    ),
                    "{error:?}"
                );
            }
        }
        assert_eq!(authority(&store), before);
    }
}

#[test]
fn hidden_corruption_stays_filtered_but_visible_tombstones_are_checked() {
    let (_dir, mut store) = mixed_store();
    store
        .connection
        .execute(
            "UPDATE entries SET content_digest=NULL WHERE id='hidden'",
            [],
        )
        .unwrap();
    let before = authority(&store);
    assert_matches_points(&store);
    assert_eq!(authority(&store), before);
    // The same corrupt authority cannot evade the complete mutation snapshot by
    // being a tombstone. A public live-only list still excludes that row.
    store
        .connection
        .execute(
            "UPDATE entries SET content_digest=NULL WHERE id='z-first'",
            [],
        )
        .unwrap();
    let before = authority(&store);
    assert_eq!(
        read_states(&store.connection, false).unwrap(),
        point_states(&store.connection, false).unwrap()
    );
    assert!(read_states(&store.connection, true).is_err());
    assert!(point_states(&store.connection, true).is_err());
    assert!(store
        .apply(&create("unrelated", "unrelated.md", EntryKind::File))
        .is_err());
    assert_eq!(authority(&store), before);
}

#[test]
fn graph_references_keep_owner_digest_and_immutable_source_checks() {
    for tamper in ["owner", "digest", "event", "backing"] {
        let (_dir, store) = graph_store();
        assert_matches_points(&store);
        match tamper {
            "owner" | "event" => {
                let json: String = store
                    .connection
                    .query_row(
                        "SELECT content_ref FROM entries WHERE id='binary'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let BinarySourceRef::Graph(mut reference) = serde_json::from_str(&json).unwrap()
                else {
                    panic!("expected graph")
                };
                if tamper == "owner" {
                    reference.identity.entry_id = EntryId::new("other-owner").unwrap();
                } else {
                    reference.selected_event =
                        zorid_sync_protocol::UpdateId::new("missing-event").unwrap();
                }
                store
                    .connection
                    .execute(
                        "UPDATE entries SET content_ref=?1 WHERE id='binary'",
                        [serde_json::to_string(&BinarySourceRef::Graph(reference)).unwrap()],
                    )
                    .unwrap();
            }
            "digest" => {
                store
                    .connection
                    .execute(
                        "UPDATE entries SET content_digest=?1 WHERE id='binary'",
                        [serde_json::to_string(&Sha256Digest::of(b"other")).unwrap()],
                    )
                    .unwrap();
            }
            "backing" => {
                // Simulate backing corruption without deleting retained rows or
                // disabling foreign keys. Reinstate the exact registered guard
                // before exercising either reader.
                let registered = immutable_payloads::SCHEMA
                    .iter()
                    .find(|(name, _)| *name == "immutable_payloads_no_update")
                    .unwrap()
                    .1;
                let trigger_sql = || {
                    store.connection.query_row(
                    "SELECT sql FROM sqlite_schema WHERE name='immutable_payloads_no_update'",
                    [], |row| row.get::<_, String>(0),
                ).unwrap()
                };
                assert_eq!(trigger_sql(), registered);
                store
                    .connection
                    .execute_batch("DROP TRIGGER immutable_payloads_no_update")
                    .unwrap();
                let changed = store
                    .connection
                    .execute(
                        "UPDATE immutable_payloads SET descriptor='{}' WHERE family='files'",
                        [],
                    )
                    .unwrap();
                assert!(
                    changed > 0,
                    "fixture must damage an existing backing descriptor"
                );
                store.connection.execute_batch(registered).unwrap();
                assert_eq!(trigger_sql(), registered);
            }
            _ => unreachable!(),
        }
        let before = authority(&store);
        assert!(
            read_metadata_row(&store.connection, &EntryId::new("binary").unwrap()).is_err(),
            "{tamper}"
        );
        for include_deleted in [false, true] {
            assert!(
                read_states(&store.connection, include_deleted).is_err(),
                "{tamper}"
            );
        }
        assert!(
            read_visible_metadata(&store.connection).is_err(),
            "{tamper}"
        );
        assert_eq!(authority(&store), before, "{tamper}");
    }
}

#[test]
fn peer_freshness_pinned_snapshots_stale_cas_and_exact_replay_survive() {
    let (dir, mut store) = store();
    let created = store
        .apply(&create("file", "file.md", EntryKind::File))
        .unwrap();
    let initial = created
        .changes
        .iter()
        .find(|change| change.after.id.as_str() == "file")
        .unwrap()
        .after
        .clone();
    let mut peer = Store::open_existing_no_follow(
        std::fs::canonicalize(dir.path().join("store.sqlite")).unwrap(),
    )
    .unwrap();
    let snapshot = store.connection.unchecked_transaction().unwrap();
    let pinned = read_states(&snapshot, true).unwrap();
    let request = write(
        "file",
        initial.revision.clone(),
        "peer-write",
        b"peer bytes",
    );
    let receipt = peer.apply(&request).unwrap();
    assert_eq!(read_states(&snapshot, true).unwrap(), pinned);
    snapshot.commit().unwrap();
    assert_matches_points(&store);
    let current = store.read_metadata(&initial.id).unwrap().unwrap().state;
    assert_ne!(current.revision, initial.revision);
    let before = authority(&store);
    assert!(matches!(
        store.apply(&write("file", initial.revision, "stale", b"stale bytes")),
        Err(StoreError::Contract(ContractError::RevisionConflict { .. }))
    ));
    assert_eq!(authority(&store), before);
    assert_eq!(store.apply(&request).unwrap(), receipt);
    assert_eq!(authority(&store), before);
    let final_receipt = store
        .apply(&write("file", current.revision, "fresh", b"latest bytes"))
        .unwrap();
    assert_ne!(final_receipt.sequence, receipt.sequence);
    let before = authority(&store);
    assert_eq!(peer.apply(&request).unwrap(), receipt);
    assert_eq!(authority(&store), before);
    assert_eq!(
        peer.read(&initial.id).unwrap().unwrap().content,
        Some(b"latest bytes".to_vec())
    );
}
