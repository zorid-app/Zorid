use super::*;

fn fixture(documents: usize) -> (tempfile::TempDir, Store) {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path().join("store.sqlite")).unwrap();
    let tx = store.connection.unchecked_transaction().unwrap();
    for index in 0..documents {
        let name = format!("reuse-{index:04}");
        Store::apply_transaction_at(&tx, &MutationRequest {
            operation_id: OperationId::new(format!("create-{name}")).unwrap(),
            mutation: Mutation::Create { id: EntryId::new(&name).unwrap(), path: zorid_core::VaultPath::new(format!("{name}.md")).unwrap(), kind: EntryKind::File, content: Some(format!("# Note {index}\nneedle\n").into_bytes()) },
        }, Some(index as u64 + 100)).unwrap();
    }
    tx.commit().unwrap();
    store.initialize_document_index().unwrap();
    (root, store)
}
fn publish(store: &mut Store) {
    let stage = store.begin_document_index().unwrap();
    while !store.pump_document_index(&stage).unwrap().ready {}
    store.publish_document_index(&stage).unwrap();
}
fn change(store: &mut Store, index: usize) {
    let id = EntryId::new(format!("reuse-{index:04}")).unwrap();
    let current = store.read(&id).unwrap().unwrap();
    store.apply(&MutationRequest { operation_id: OperationId::new(format!("change-{index}")).unwrap(), mutation: Mutation::Write { id, expected: current.state.revision, content: format!("# Updated {index}\nnew body\n").into_bytes() } }).unwrap();
}
#[test]
fn warm_reuse_pump_advances_past_thirty_two_with_one_changed_note() {
    let (_root, mut store) = fixture(129);
    publish(&mut store);
    change(&mut store, 0);
    let stage = store.begin_document_index().unwrap();
    let progress = pump_at(&mut store, &stage, &mut || std::time::Duration::ZERO).unwrap();
    assert_eq!((progress.prepared_documents, progress.reused_documents, progress.total_documents, progress.ready), (128, 127, 129, false));
    while !store.pump_document_index(&stage).unwrap().ready {}
    store.publish_document_index(&stage).unwrap();
    let pin = store.open_document_snapshot().unwrap();
    assert_eq!(pin.generation().records().count(), 129);
    for index in 0..129 {
        let id = EntryId::new(format!("reuse-{index:04}")).unwrap();
        let projection = store.read_document_projection(&pin, &id).unwrap();
        let expected = if index == 0 { format!("# Updated {index}\nnew body\n") } else { format!("# Note {index}\nneedle\n") };
        assert_eq!(projection.content.unwrap(), expected.as_bytes());
        assert_eq!(pin.generation().manifest().check_witness(&projection.witness), Ok(()));
    }
}


fn pump_at(store: &mut Store, stage: &DocumentIndexStage, elapsed: &mut dyn FnMut() -> std::time::Duration) -> IndexResult<DocumentIndexProgress> {
    store.pump_document_index_capture_with_clock(stage, None, |_| Ok::<_, ()>(()), elapsed, |_, _, _, _, _| Ok::<_, PreviewCaptureError<()>>(()))
        .map(|(progress, _)| progress)
}
#[test]
fn cold_pump_never_extracts_or_visits_parse_cache_for_a_thirty_third_record() {
    let (_root, mut store) = fixture(129);
    let stage = store.begin_document_index().unwrap();
    let progress = pump_at(&mut store, &stage, &mut || std::time::Duration::ZERO).unwrap();
    assert_eq!((progress.prepared_documents, progress.reused_documents), (32, 0));
    let cache = progress.parse_cache;
    assert_eq!(cache.hits + cache.misses + cache.unavailable + cache.corrupt + cache.unsupported, 32);
}
#[test]
fn changed_records_keep_the_new_record_budget_after_unchanged_prefix() {
    let (_root, mut store) = fixture(129);
    publish(&mut store);
    for index in 40..73 { change(&mut store, index); }
    let stage = store.begin_document_index().unwrap();
    let progress = pump_at(&mut store, &stage, &mut || std::time::Duration::ZERO).unwrap();
    assert_eq!((progress.prepared_documents, progress.reused_documents), (72, 40));
    let cache = progress.parse_cache;
    assert_eq!(cache.hits + cache.misses + cache.unavailable + cache.corrupt + cache.unsupported, 32, "the 33rd changed record cannot reach extraction/cache lookup");
}
#[test]
fn expired_extension_deadline_preserves_legacy_thirty_two_then_yields() {
    let (_root, mut store) = fixture(129);
    publish(&mut store);
    change(&mut store, 128);
    let stage = store.begin_document_index().unwrap();
    let mut calls = 0;
    let progress = pump_at(&mut store, &stage, &mut || { calls += 1; std::time::Duration::from_millis(if calls == 1 { 100 } else { 108 }) }).unwrap();
    assert_eq!((progress.prepared_documents, progress.reused_documents, progress.ready), (32, 32, false));
    let progress = pump_at(&mut store, &stage, &mut || std::time::Duration::ZERO).unwrap();
    assert_eq!((progress.prepared_documents, progress.reused_documents, progress.ready), (129, 96, true));
}
#[test]
fn unchanged_large_sources_still_share_the_one_mib_source_budget() {
    let (_root, mut store) = fixture(3);
    for index in 0..3 {
        let id = EntryId::new(format!("reuse-{index:04}")).unwrap();
        let current = store.read(&id).unwrap().unwrap();
        store.apply(&MutationRequest { operation_id: OperationId::new(format!("large-{index}")).unwrap(), mutation: Mutation::Write { id, expected: current.state.revision, content: vec![b'x'; 600 * 1024] } }).unwrap();
    }
    publish(&mut store);
    let stage = store.begin_document_index().unwrap();
    let progress = pump_at(&mut store, &stage, &mut || std::time::Duration::ZERO).unwrap();
    assert_eq!((progress.prepared_documents, progress.reused_documents, progress.ready), (1, 1, false));
}
#[test]
fn corrupt_previous_record_cannot_use_the_unchanged_allowance() {
    let (_root, mut store) = fixture(129);
    publish(&mut store);
    let stage = store.begin_document_index().unwrap();
    store.document_cache.connection.execute("UPDATE document_index_rows SET record='{}' WHERE entry_id='reuse-0000'", []).unwrap();
    assert!(matches!(pump_at(&mut store, &stage, &mut || std::time::Duration::ZERO), Err(DocumentIndexError::RebuildRequired)));
}
#[test]
fn concurrent_source_change_still_rejects_the_final_reuse_commit() {
    let (root, mut store) = fixture(129);
    publish(&mut store);
    let stage = store.begin_document_index().unwrap();
    let writer = Connection::open(root.path().join("store.sqlite")).unwrap();
    let mut calls = 0;
    let result = pump_at(&mut store, &stage, &mut || {
        calls += 1;
        if calls == 2 { writer.execute("UPDATE entry_presentation SET mtime_ms=mtime_ms+1", []).unwrap(); }
        std::time::Duration::from_millis(if calls == 1 { 100 } else { 108 })
    });
    assert!(matches!(result, Err(DocumentIndexError::RebuildRequired)));
    let rows: i64 = store.document_cache.connection.query_row("SELECT count(*) FROM document_index_rows WHERE snapshot_key=?1", [Snapshot::of(&stage.snapshot).key()], |row| row.get(0)).unwrap();
    assert_eq!(rows, 0, "rejected reuse never publishes partial prepared rows");
}

#[test]
fn expensive_mandatory_admission_does_not_consume_the_new_record_time_budget() {
    let (_root, mut store) = fixture(129);
    publish(&mut store);
    change(&mut store, 0);
    let stage = store.begin_document_index().unwrap();
    PUMP_MANIFEST_ENTRY_VISITS.with(|count| count.set(0));
    let mut calls = 0;
    let progress = pump_at(&mut store, &stage, &mut || {
        calls += 1;
        if calls == 1 { assert_eq!(PUMP_MANIFEST_ENTRY_VISITS.with(std::cell::Cell::get), 129, "clock origin follows mandatory restore and original lookup"); }
        // Simulate a full minute already spent before new record preparation.
        std::time::Duration::from_secs(60)
    }).unwrap();
    assert_eq!((progress.prepared_documents, progress.reused_documents), (128, 127));
}
