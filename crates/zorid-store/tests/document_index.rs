//! Actual SQLite authority/cache transactions, using disposable fixtures only.
use rusqlite::{types::Value, Connection};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_index::{IndexError, LiteralQuery, SearchHit};
use zorid_store::{
    document_index::*, CheckpointScope, CheckpointWrite, FamilyCreateMode, FamilyScope, Store,
};
use zorid_sync_protocol::{RealmId, VaultId};
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn request(name: &str, mutation: Mutation) -> MutationRequest {
    MutationRequest {
        operation_id: op(name),
        mutation,
    }
}
fn create(name: &str, path: &str, bytes: &[u8]) -> MutationRequest {
    request(
        &format!("create_{name}"),
        Mutation::Create {
            id: id(name),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(bytes.to_vec()),
        },
    )
}
fn write(store: &mut Store, name: &str, entry: &str, bytes: &[u8]) {
    let state = store.read_metadata(&id(entry)).unwrap().unwrap().state;
    store
        .apply(&request(
            name,
            Mutation::Write {
                id: state.id,
                expected: state.revision,
                content: bytes.to_vec(),
            },
        ))
        .unwrap();
}
fn build(store: &mut Store) {
    let stage = store.begin_document_index().unwrap();
    loop {
        if store.pump_document_index(&stage).unwrap().ready {
            break;
        }
    }
    store.publish_document_index(&stage).unwrap();
}
fn hits(store: &Store, needle: &str) -> Vec<SearchHit> {
    let pin = store.open_document_snapshot().unwrap();
    let mut token = None;
    let mut hits = Vec::new();
    loop {
        let page = store
            .literal_document_page(
                &pin,
                LiteralQuery::new(needle).unwrap(),
                token.as_ref(),
                1000,
            )
            .unwrap();
        hits.extend(page.hits);
        token = page.next;
        if token.is_none() {
            break;
        }
    }
    store.close_document_snapshot(pin);
    hits
}
// Compare every authority table, including sync, outbox and draft checkpoints.
fn authority(path: &std::path::Path) -> Vec<(String, Vec<Vec<String>>)> {
    let db = Connection::open(path).unwrap();
    let names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('document_index_control','document_index_generations','document_index_rows') ORDER BY name").unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut statement = db
                .prepare(&format!(
                    "SELECT * FROM \"{}\" ORDER BY rowid",
                    name.replace('"', "\"\"")
                ))
                .unwrap();
            let count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..count)
                        .map(|i| row.get::<_, Value>(i).map(|v| format!("{v:?}")))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}
#[test]
fn durable_bounded_stage_resumes_after_restart_without_authority_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    for n in 0..33 {
        store
            .apply(&create(
                &format!("file{n}"),
                &format!("file{n:02}.md"),
                b"needle\r\n",
            ))
            .unwrap();
    }
    let local = store.identity().unwrap().local_store_id;
    store
        .checkpoint_compare_and_swap(
            &CheckpointScope {
                vault_id: local,
                client_id: op("editor"),
            },
            CheckpointWrite {
                key: "draft",
                expected_revision: None,
                next_revision: "draft_revision",
                encoded_state: Some("unsaved draft"),
            },
        )
        .unwrap();
    let before = authority(&path);
    store.initialize_document_index().unwrap();
    let stage = store.begin_document_index().unwrap();
    let progress = store.pump_document_index(&stage).unwrap();
    assert_eq!(progress.prepared_documents, 32);
    assert!(!progress.ready);
    assert!(matches!(
        store.open_document_snapshot(),
        Err(DocumentIndexError::NotReady)
    ));
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let recovered = store.document_index_stages().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].snapshot(), stage.snapshot());
    let stage = store
        .resume_document_index(recovered[0].snapshot())
        .unwrap();
    assert!(store.pump_document_index(&stage).unwrap().ready);
    store.publish_document_index(&stage).unwrap();
    assert_eq!(hits(&store, "needle").len(), 33);
    assert_eq!(authority(&path), before);
}
#[test]
fn independent_connections_reject_stale_source_and_derived_head_publications() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut a = Store::open(&path).unwrap();
    a.apply(&create("a", "a.md", b"old")).unwrap();
    a.initialize_document_index().unwrap();
    let mut b = Store::open(&path).unwrap();
    let sa = a.begin_document_index().unwrap();
    let sb = b.begin_document_index().unwrap();
    a.pump_document_index(&sa).unwrap();
    b.pump_document_index(&sb).unwrap();
    a.publish_document_index(&sa).unwrap();
    assert!(matches!(
        b.publish_document_index(&sb),
        Err(DocumentIndexError::Contract(IndexError::StaleIndex))
    ));
    let stale = b.begin_document_index().unwrap();
    b.pump_document_index(&stale).unwrap();
    write(&mut a, "edit", "a", b"new");
    assert!(matches!(
        b.publish_document_index(&stale),
        Err(DocumentIndexError::Contract(IndexError::StaleSource))
    ));
    assert_eq!(hits(&a, "old").len(), 1);
    assert!(hits(&a, "new").is_empty());
    assert!(
        matches!(a.document_index_status().unwrap(),DocumentIndexStatus::Ready {covered_watermark,observed_source_head,..} if covered_watermark!=observed_source_head)
    );
    build(&mut b);
    assert_eq!(hits(&a, "new").len(), 1);
}
#[test]
fn pinned_pages_use_retained_bytes_and_expire_on_rebuild_or_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&create("a", "a.md", b"needle old one\nneedle old two\n"))
        .unwrap();
    store.initialize_document_index().unwrap();
    build(&mut store);
    let pin = store.open_document_snapshot().unwrap();
    let page = store
        .literal_document_page(&pin, LiteralQuery::new("needle").unwrap(), None, 1)
        .unwrap();
    assert_eq!(page.hits[0].snippet, "needle old one");
    let token = page.next.unwrap();
    write(&mut store, "edit", "a", b"needle NEW\n");
    build(&mut store);
    let page = store
        .literal_document_page(&pin, LiteralQuery::new("needle").unwrap(), Some(&token), 1)
        .unwrap();
    assert_eq!(page.hits[0].snippet, "needle old two");
    assert_eq!(hits(&store, "NEW").len(), 1);
    let other = Store::open(&path).unwrap();
    assert!(matches!(
        other.literal_document_page(&pin, LiteralQuery::new("needle").unwrap(), Some(&token), 1),
        Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
    ));
    let old = pin.generation().id().clone();
    store.rebuild_document_index().unwrap();
    assert!(matches!(
        store.literal_document_page(&pin, LiteralQuery::new("needle").unwrap(), Some(&token), 1),
        Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
    ));
    build(&mut store);
    let current = store.open_document_snapshot().unwrap();
    assert_ne!(
        old.generation_epoch(),
        current.generation().id().generation_epoch()
    );
}
#[test]
fn move_delete_recreate_and_rebuild_have_identical_results_without_source_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store
        .apply(&create("old", "before.md", b"needle [[target]]"))
        .unwrap();
    store.initialize_document_index().unwrap();
    build(&mut store);
    let s = store.read_metadata(&id("old")).unwrap().unwrap().state;
    store
        .apply(&request(
            "move",
            Mutation::Move {
                id: s.id,
                expected: s.revision,
                path: VaultPath::new("after.md").unwrap(),
            },
        ))
        .unwrap();
    build(&mut store);
    assert_eq!(hits(&store, "needle")[0].entry.path.as_str(), "after.md");
    let s = store.read_metadata(&id("old")).unwrap().unwrap().state;
    store
        .apply(&request(
            "delete",
            Mutation::Delete {
                id: s.id,
                expected: s.revision,
                recursive: false,
            },
        ))
        .unwrap();
    store
        .apply(&create("new", "after.md", b"needle replacement"))
        .unwrap();
    build(&mut store);
    let incremental = hits(&store, "needle");
    assert_eq!(incremental[0].entry.id, id("new"));
    let before = authority(&path);
    store.rebuild_document_index().unwrap();
    build(&mut store);
    assert_eq!(hits(&store, "needle"), incremental);
    assert_eq!(authority(&path), before);
}
#[test]
fn corrupt_or_missing_cache_is_explicit_and_does_not_block_note_saves() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create("a", "a.md", b"before")).unwrap();
    store.initialize_document_index().unwrap();
    build(&mut store);
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE document_index_rows SET record='{}'", [])
        .unwrap();
    assert!(matches!(
        store.document_index_status().unwrap(),
        DocumentIndexStatus::RebuildRequired
    ));
    write(&mut store, "save", "a", b"after");
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert!(matches!(
        store.document_index_status().unwrap(),
        DocumentIndexStatus::RebuildRequired
    ));
    let before = authority(&path);
    store.rebuild_document_index().unwrap();
    build(&mut store);
    assert_eq!(authority(&path), before);
    db.execute_batch("DROP TABLE document_index_rows").unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert!(matches!(
        store.document_index_status().unwrap(),
        DocumentIndexStatus::RebuildRequired
    ));
    assert!(matches!(
        store.initialize_document_index(),
        Err(DocumentIndexError::RebuildRequired)
    ));
    let before = authority(&path);
    store.rebuild_document_index().unwrap();
    build(&mut store);
    assert_eq!(authority(&path), before);
    assert_eq!(hits(&store, "after").len(), 1);
    db.execute("DELETE FROM document_index_rows", []).unwrap();
    assert!(matches!(
        store.document_index_status().unwrap(),
        DocumentIndexStatus::RebuildRequired
    ));
}
#[test]
fn optional_schema_is_exact_and_unknown_objects_still_fail_closed() {
    for sql in [
        "CREATE TABLE document_index_rows (record TEXT)",
        "CREATE TABLE document_index_unregistered (record TEXT)",
        "CREATE TRIGGER document_index_bad AFTER UPDATE ON entries BEGIN DELETE FROM outbox; END",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let store = Store::open(&path).unwrap();
        drop(store);
        Connection::open(&path).unwrap().execute_batch(sql).unwrap();
        assert!(Store::open(&path).is_err(), "{sql}");
    }
}
#[test]
fn binary_mode_and_invalid_text_are_explicit_while_current_invalid_yaml_keeps_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        })
        .unwrap();
    store
        .family_apply(
            &create("binary", "binary.md", b"needle binary"),
            Some(FamilyCreateMode::Binary),
        )
        .unwrap();
    store
        .family_apply(
            &create("text", "text.md", b"---\na: [\n---\nneedle text\n"),
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    let before = authority(&path);
    store.initialize_document_index().unwrap();
    build(&mut store);
    assert_eq!(authority(&path), before);
    let pin = store.open_document_snapshot().unwrap();
    assert!(matches!(
        pin.generation().record(&id("binary")).unwrap().exclusion(),
        Some(zorid_index::Exclusion::Binary)
    ));
    let metadata = pin
        .generation()
        .record(&id("text"))
        .unwrap()
        .metadata()
        .unwrap();
    assert!(!metadata.diagnostics.is_empty());
    assert_eq!(
        metadata.content_revision,
        store
            .read_metadata(&id("text"))
            .unwrap()
            .unwrap()
            .state
            .revision
    );
    let found = hits(&store, "needle");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].entry.id, id("text"));
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    store
        .apply(&create("nul", "nul.unknown", b"needle\0hidden"))
        .unwrap();
    store
        .apply(&create("utf8", "unknown.extension", b"needle plain"))
        .unwrap();
    store.initialize_document_index().unwrap();
    build(&mut store);
    assert_eq!(hits(&store, "needle").len(), 1);
    assert!(matches!(
        store.document_index_status().unwrap(),
        DocumentIndexStatus::Ready {
            coverage_complete: false,
            ..
        }
    ));
}
#[test]
fn count_based_retention_and_pin_limit_are_bounded_with_explicit_expiry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create("a", "a.md", b"needle")).unwrap();
    store.initialize_document_index().unwrap();
    build(&mut store);
    let mut pins = Vec::new();
    for _ in 0..DOCUMENT_INDEX_MAX_QUERY_PINS {
        pins.push(store.open_document_snapshot().unwrap());
    }
    assert!(matches!(
        store.open_document_snapshot(),
        Err(DocumentIndexError::Contract(IndexError::GenerationLimit))
    ));
    store.close_document_snapshot(pins.pop().unwrap());
    assert!(store.open_document_snapshot().is_ok());
    let old = pins.pop().unwrap();
    drop(pins);
    for _ in 0..DOCUMENT_INDEX_RETAINED_GENERATIONS {
        build(&mut store);
    }
    assert!(matches!(
        store.literal_document_page(&old, LiteralQuery::new("needle").unwrap(), None, 1),
        Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
    ));
    let db = Connection::open(&path).unwrap();
    assert_eq!(db.query_row("SELECT count(*) FROM document_index_generations WHERE json_extract(record,'$.value.published')=1",[],|r|r.get::<_,usize>(0)).unwrap(),DOCUMENT_INDEX_RETAINED_GENERATIONS);
    let oldest = store.begin_document_index().unwrap();
    for _ in 0..DOCUMENT_INDEX_RETAINED_STAGES {
        store.begin_document_index().unwrap();
    }
    assert!(store.resume_document_index(oldest.snapshot()).is_err());
    assert_eq!(
        store.document_index_stages().unwrap().len(),
        DOCUMENT_INDEX_RETAINED_STAGES
    );
}
#[test]
fn exact_committed_id_revision_read_rejects_stale_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create("a", "a.md", b"old")).unwrap();
    let manifest = store.capture_document_manifest().unwrap();
    assert_eq!(
        store
            .read_document_source(&manifest, &id("a"))
            .unwrap()
            .content,
        Some(b"old".to_vec())
    );
    write(&mut store, "edit", "a", b"new");
    assert!(matches!(
        store.read_document_source(&manifest, &id("a")),
        Err(DocumentIndexError::Contract(IndexError::StaleSource))
    ));
    let current = store.capture_document_manifest().unwrap();
    assert_eq!(
        store
            .read_document_source(&current, &id("a"))
            .unwrap()
            .content,
        Some(b"new".to_vec())
    );
}
#[test]
fn unchanged_records_are_reused_but_changed_or_moved_witnesses_are_reparsed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create("a", "a.md", b"needle a")).unwrap();
    store.apply(&create("b", "b.md", b"needle b")).unwrap();
    store.initialize_document_index().unwrap();
    build(&mut store);
    let unchanged = store.begin_document_index().unwrap();
    let progress = store.pump_document_index(&unchanged).unwrap();
    assert_eq!(progress.reused_documents, 2);
    assert!(progress.ready);
    store.publish_document_index(&unchanged).unwrap();
    write(&mut store, "edit", "a", b"needle updated");
    let changed = store.begin_document_index().unwrap();
    let progress = store.pump_document_index(&changed).unwrap();
    assert_eq!(progress.reused_documents, 1);
    assert!(progress.ready);
    store.publish_document_index(&changed).unwrap();
    let b = store.read_metadata(&id("b")).unwrap().unwrap().state;
    store
        .apply(&request(
            "move",
            Mutation::Move {
                id: b.id,
                expected: b.revision,
                path: VaultPath::new("moved.md").unwrap(),
            },
        ))
        .unwrap();
    let moved = store.begin_document_index().unwrap();
    let progress = store.pump_document_index(&moved).unwrap();
    assert_eq!(progress.reused_documents, 1);
    assert!(progress.ready);
    store.publish_document_index(&moved).unwrap();
    let incremental = hits(&store, "needle");
    store.rebuild_document_index().unwrap();
    build(&mut store);
    assert_eq!(hits(&store, "needle"), incremental);
}
#[test]
fn one_sixteen_mib_text_row_can_advance_a_soft_one_mib_pump() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let mut bytes = vec![b'x'; zorid_store::FAMILY_MAX_INLINE_BYTES as usize];
    bytes[..6].copy_from_slice(b"needle");
    store.apply(&create("large", "large.txt", &bytes)).unwrap();
    drop(bytes);
    store.initialize_document_index().unwrap();
    let stage = store.begin_document_index().unwrap();
    let progress = store.pump_document_index(&stage).unwrap();
    assert!(progress.ready);
    assert_eq!(progress.prepared_documents, 1);
    store.publish_document_index(&stage).unwrap();
    let pin = store.open_document_snapshot().unwrap();
    let page = store
        .literal_document_page(&pin, LiteralQuery::new("needle").unwrap(), None, 1)
        .unwrap();
    assert_eq!(page.hits.len(), 1);
    assert_eq!(
        page.source_bytes,
        zorid_store::FAMILY_MAX_INLINE_BYTES as usize
    );
    assert!(page.complete);
}
