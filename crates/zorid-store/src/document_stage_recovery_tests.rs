//! Real cache/authority reads for the lifecycle driver's bounded recovery seam.
use super::*;
use zorid_core::{Mutation, MutationRequest, VaultPath};

fn create(name: &str) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(format!("create-{name}")).unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new(name).unwrap(),
            path: VaultPath::new(format!("{name}.md")).unwrap(),
            kind: EntryKind::File,
            content: Some(b"# retained\n".to_vec()),
        },
    }
}
fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("vault.sqlite")).unwrap();
    store.initialize_document_index().unwrap();
    (dir, store)
}
fn publish_empty(store: &mut Store) {
    let stage = store.begin_document_index().unwrap();
    assert!(store.pump_document_index(&stage).unwrap().ready);
    store.publish_document_index(&stage).unwrap();
}
fn read_header(store: &Store, stage: &DocumentIndexStage) -> Header {
    let raw: String = store
        .document_cache
        .connection
        .query_row(
            "SELECT record FROM document_index_generations WHERE snapshot_key=?1",
            [Snapshot::of(stage.snapshot()).key()],
            |row| row.get(0),
        )
        .unwrap();
    decode(&raw).unwrap()
}
fn replace_header(store: &Store, stage: &DocumentIndexStage, h: &Header) {
    assert_eq!(
        store
            .document_cache
            .connection
            .execute(
                "UPDATE document_index_generations SET record=?1 WHERE snapshot_key=?2",
                params![encode(h).unwrap(), Snapshot::of(stage.snapshot()).key()],
            )
            .unwrap(),
        1
    );
}
fn assert_recovery_read_only(
    store: &Store,
) -> IndexResult<Option<(DocumentIndexStage, DocumentStageProgress)>> {
    let before = (
        store.connection.total_changes(),
        store.document_cache.connection.total_changes(),
    );
    let result = store.recover_document_index_stage();
    assert_eq!(
        (
            store.connection.total_changes(),
            store.document_cache.connection.total_changes()
        ),
        before
    );
    result
}

// Same connection-local SQLite trace pattern as the existing capture CSE test.
// Count actual reads without changing production readers or allocating in FFI.
struct RecoveryReads<'a> {
    connection: &'a Connection,
    counts: Box<std::cell::Cell<[usize; 4]>>,
}
impl<'a> RecoveryReads<'a> {
    fn new(connection: &'a Connection) -> Self {
        unsafe extern "C" fn observe(
            event: u32,
            context: *mut std::ffi::c_void,
            _: *mut std::ffi::c_void,
            sql: *mut std::ffi::c_void,
        ) -> i32 {
            if event == rusqlite::ffi::SQLITE_TRACE_STMT && !context.is_null() && !sql.is_null() {
                let bytes = unsafe { std::ffi::CStr::from_ptr(sql.cast()) }.to_bytes();
                let counter = unsafe { &*context.cast::<std::cell::Cell<[usize; 4]>>() };
                let slot = if bytes.starts_with(b"SELECT record FROM document_index_control") {
                    Some(0)
                } else if bytes.starts_with(b"SELECT record FROM document_index_generations WHERE")
                {
                    Some(1)
                } else if bytes.starts_with(
                    b"SELECT snapshot_key,record FROM document_index_generations NOT INDEXED",
                ) {
                    Some(2)
                } else if bytes
                    .starts_with(b"SELECT entry_id,record,length(text) FROM document_index_rows")
                {
                    Some(3)
                } else {
                    None
                };
                if let Some(slot) = slot {
                    let mut counts = counter.get();
                    counts[slot] = counts[slot].saturating_add(1);
                    counter.set(counts);
                }
            }
            0
        }
        let trace = Self {
            connection,
            counts: Box::new(std::cell::Cell::new([0; 4])),
        };
        assert_eq!(
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    connection.handle(),
                    rusqlite::ffi::SQLITE_TRACE_STMT,
                    Some(observe),
                    (&*trace.counts as *const std::cell::Cell<[usize; 4]>)
                        .cast_mut()
                        .cast(),
                )
            },
            rusqlite::ffi::SQLITE_OK
        );
        trace
    }
}
impl Drop for RecoveryReads<'_> {
    fn drop(&mut self) {
        unsafe {
            rusqlite::ffi::sqlite3_trace_v2(
                self.connection.handle(),
                0,
                None,
                std::ptr::null_mut(),
            );
        }
    }
}

#[test]
fn stage_source_is_actual_capture_and_snapshot_only_wire_is_unchanged() {
    let (_dir, mut store) = fixture();
    store.apply(&create("original")).unwrap();
    let captured = store.document_index_status_with_source().unwrap().0;
    let stage = store.begin_document_index().unwrap();
    assert_eq!(stage.source(), &captured);
    assert_eq!(
        serde_json::to_value(&stage).unwrap(),
        serde_json::json!({"snapshot": stage.snapshot()})
    );
    let resumed = store.resume_document_index(stage.snapshot()).unwrap();
    assert_eq!(resumed.source(), &captured);
    store.apply(&create("later")).unwrap();
    assert_ne!(
        store.document_index_status_with_source().unwrap().0,
        captured
    );
    assert_eq!(stage.source(), &captured);
    let discovered = store.document_index_stages().unwrap();
    assert_eq!(discovered.len(), 1);
    assert_eq!(discovered[0].source(), &captured);
    assert!(matches!(
        store.resume_document_index(stage.snapshot()),
        Err(DocumentIndexError::Contract(IndexError::StaleSource))
    ));
    assert!(assert_recovery_read_only(&store).unwrap().is_none());
}

#[test]
fn restart_recovers_actual_partial_and_ready_work_without_republishing() {
    let (dir, mut store) = fixture();
    let cache = dir.path().canonicalize().unwrap().join("cache.sqlite");
    store.enable_document_cache(&cache).unwrap();
    store.initialize_document_index().unwrap();
    for n in 0..=zorid_index::MAX_PUMP_DOCUMENTS {
        store.apply(&create(&format!("note-{n:03}"))).unwrap();
    }
    let stage = store.begin_document_index().unwrap();
    let partial = store.pump_document_index(&stage).unwrap();
    assert_eq!(partial.prepared_documents, zorid_index::MAX_PUMP_DOCUMENTS);
    assert!(!partial.ready);
    let captured = stage.source().clone();
    drop(store);
    let mut store = Store::open(dir.path().join("vault.sqlite")).unwrap();
    store.enable_document_cache(&cache).unwrap();
    let trace = RecoveryReads::new(&store.document_cache.connection);
    let (recovered, progress) = assert_recovery_read_only(&store).unwrap().unwrap();
    assert_eq!(
        trace.counts.get(),
        [1, 0, 1, 1],
        "one control read, no duplicate header load, one candidate scan and one builder restore"
    );
    drop(trace);
    assert_eq!(recovered.snapshot(), stage.snapshot());
    assert_eq!(recovered.source(), &captured);
    assert_eq!(
        progress,
        DocumentStageProgress {
            prepared_documents: partial.prepared_documents,
            total_documents: zorid_index::MAX_PUMP_DOCUMENTS + 1,
            ready: false,
        }
    );
    assert!(store.pump_document_index(&recovered).unwrap().ready);
    let (ready, progress) = assert_recovery_read_only(&store).unwrap().unwrap();
    assert!(progress.ready);
    assert_eq!(progress.prepared_documents, progress.total_documents);
    assert_eq!(
        store.publish_document_index(&ready).unwrap(),
        *stage.snapshot()
    );
    assert!(assert_recovery_read_only(&store).unwrap().is_none());
    assert_eq!(
        store
            .read(&EntryId::new("note-000").unwrap())
            .unwrap()
            .unwrap()
            .content,
        Some(b"# retained\n".to_vec())
    );
}

#[test]
fn recovery_skips_stale_source_candidate_and_preserves_newest_first_order() {
    let (_dir, mut store) = fixture();
    let old = store.begin_document_index().unwrap();
    store.apply(&create("new-source")).unwrap();
    let current = store.begin_document_index().unwrap();
    let newest = store.begin_document_index().unwrap();
    assert_eq!(
        assert_recovery_read_only(&store)
            .unwrap()
            .unwrap()
            .0
            .snapshot(),
        newest.snapshot()
    );
    store
        .discard_document_index_stage(newest.snapshot())
        .unwrap();
    // Put the unchanged, genuinely stale header first in row order. Its proof
    // remains exact; recovery must continue, rather than fail or select it.
    assert_eq!(
        store
            .document_cache
            .connection
            .execute(
                "UPDATE document_index_generations SET rowid=100 WHERE snapshot_key=?1",
                [Snapshot::of(old.snapshot()).key()],
            )
            .unwrap(),
        1
    );
    let (recovered, progress) = assert_recovery_read_only(&store).unwrap().unwrap();
    assert_eq!(recovered.snapshot(), current.snapshot());
    assert_eq!(recovered.source(), current.source());
    assert_eq!(
        progress,
        DocumentStageProgress {
            prepared_documents: 0,
            total_documents: 1,
            ready: false
        }
    );
    assert_eq!(store.document_index_stages().unwrap().len(), 2);
}

#[test]
fn recovery_skips_stale_index_and_published_attempts_without_cleanup() {
    let (_dir, mut store) = fixture();
    let old = store.begin_document_index().unwrap();
    let published = store.begin_document_index().unwrap();
    assert!(store.pump_document_index(&published).unwrap().ready);
    store.publish_document_index(&published).unwrap();
    assert!(assert_recovery_read_only(&store).unwrap().is_none());
    assert_eq!(
        store.document_index_stages().unwrap()[0].snapshot(),
        old.snapshot()
    );
    let current = store.begin_document_index().unwrap();
    let (recovered, progress) = assert_recovery_read_only(&store).unwrap().unwrap();
    assert_eq!(recovered.snapshot(), current.snapshot());
    assert_eq!(
        progress,
        DocumentStageProgress {
            prepared_documents: 0,
            total_documents: 0,
            ready: true
        }
    );
}

#[test]
fn recovery_stops_at_first_usable_header_with_full_healthy_retention() {
    let (_dir, mut store) = fixture();
    for _ in 0..DOCUMENT_INDEX_RETAINED_GENERATIONS {
        publish_empty(&mut store);
    }
    let mut latest = None;
    for _ in 0..DOCUMENT_INDEX_RETAINED_STAGES {
        latest = Some(store.begin_document_index().unwrap());
    }
    let cache = &store.document_cache.connection;
    assert_eq!(
        cache
            .query_row(
                "SELECT count(*) FROM document_index_generations",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        7
    );
    // A lower-priority, length-admitted malformed header is not decoded before
    // returning the newest usable attempt. This is not an all-cache audit.
    assert_eq!(cache.execute("UPDATE document_index_generations SET record='{' WHERE rowid=(SELECT min(rowid) FROM document_index_generations)", []).unwrap(), 1);
    assert!(store.document_index_stages().is_err());
    assert_eq!(
        assert_recovery_read_only(&store)
            .unwrap()
            .unwrap()
            .0
            .snapshot(),
        latest.unwrap().snapshot()
    );
}

#[test]
fn recovery_preflights_count_key_and_header_lengths_before_loading_candidates() {
    for fault in ["overflow", "key", "header"] {
        let (_dir, mut store) = fixture();
        let stage = store.begin_document_index().unwrap();
        let cache = &store.document_cache.connection;
        match fault {
            "overflow" => {
                let raw: String = cache
                    .query_row("SELECT record FROM document_index_generations", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                for n in 0..7 {
                    cache
                        .execute(
                            "INSERT INTO document_index_generations VALUES(?1,?2)",
                            params![format!("overflow-{n}"), raw],
                        )
                        .unwrap();
                }
            }
            "key" => {
                cache
                    .execute(
                        "UPDATE document_index_generations SET snapshot_key=zeroblob(161)",
                        [],
                    )
                    .unwrap();
            }
            "header" => {
                cache
                    .execute(
                        "UPDATE document_index_generations SET record=zeroblob(?1)",
                        [(MAX_GENERATION_METADATA_BYTES + 1) as i64],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            matches!(
                assert_recovery_read_only(&store),
                Err(DocumentIndexError::RebuildRequired)
            ),
            "{fault}"
        );
        assert_eq!(
            stage.source().local_store_id(),
            &store.identity().unwrap().local_store_id
        );
    }
}

#[test]
fn recovery_propagates_malformed_descriptor_versions_rows_and_foreign_scope() {
    for fault in [
        "key",
        "json",
        "epoch",
        "scope",
        "allocation",
        "version",
        "row",
    ] {
        let (_dir, mut store) = fixture();
        store.apply(&create("selected")).unwrap();
        let stage = store.begin_document_index().unwrap();
        let mut h = read_header(&store, &stage);
        match fault {
            "key" => {
                store
                    .document_cache
                    .connection
                    .execute(
                        "UPDATE document_index_generations SET snapshot_key='wrong-key'",
                        [],
                    )
                    .unwrap();
            }
            "json" => {
                store
                    .document_cache
                    .connection
                    .execute("UPDATE document_index_generations SET record='{'", [])
                    .unwrap();
            }
            "epoch" => {
                h.snapshot.epoch = fresh();
                replace_header(&store, &stage, &h);
            }
            "scope" => {
                h.manifest.local_store_id = fresh();
                replace_header(&store, &stage, &h);
            }
            "allocation" => {
                h.snapshot.generation += 1;
                let key = Snapshot::of(stage.snapshot()).key();
                store.document_cache.connection.execute("UPDATE document_index_generations SET snapshot_key=?1,record=?2 WHERE snapshot_key=?3", params![h.snapshot.key(), encode(&h).unwrap(), key]).unwrap();
            }
            "version" => {
                h.snapshot.extraction = "unsupported-extraction".into();
                replace_header(&store, &stage, &h);
            }
            "row" => {
                store
                    .document_cache
                    .connection
                    .execute(
                        "INSERT INTO document_index_rows VALUES(?1,'selected','{',NULL)",
                        [Snapshot::of(stage.snapshot()).key()],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            matches!(
                assert_recovery_read_only(&store),
                Err(DocumentIndexError::RebuildRequired)
            ),
            "{fault}"
        );
    }
}

#[test]
fn recovery_preserves_authority_errors_and_final_source_publication_fences() {
    let (_dir, mut store) = fixture();
    store.apply(&create("selected")).unwrap();
    let stage = store.begin_document_index().unwrap();
    assert!(store.pump_document_index(&stage).unwrap().ready);
    let recovered = assert_recovery_read_only(&store).unwrap().unwrap().0;
    store.apply(&create("peer")).unwrap();
    assert!(matches!(
        store.publish_document_index(&recovered),
        Err(DocumentIndexError::Contract(IndexError::StaleSource))
    ));
    assert!(assert_recovery_read_only(&store).unwrap().is_none());
    let current = store.begin_document_index().unwrap();
    store
        .connection
        .execute(
            "UPDATE entries SET state=json_set(state,'$.unexpected',1) WHERE id='selected'",
            [],
        )
        .unwrap();
    assert!(matches!(
        assert_recovery_read_only(&store),
        Err(DocumentIndexError::Authority(_))
    ));
    assert_eq!(
        current.source().watermark(),
        store
            .document_index_status_with_source()
            .unwrap()
            .0
            .watermark()
    );
}
