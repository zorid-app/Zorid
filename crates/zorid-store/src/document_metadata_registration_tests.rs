//! Registration checks consume only admitted immutable data, never cached bodies.
use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn create(name: &str) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(format!("create-{name}")).unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new(name).unwrap(),
            path: zorid_core::VaultPath::new(format!("{name}.md")).unwrap(),
            kind: EntryKind::File,
            content: Some(b"# retained heading\n#retained\n".to_vec()),
        },
    }
}
fn build(store: &mut Store) {
    let stage = store.begin_document_index().unwrap();
    while !store.pump_document_index(&stage).unwrap().ready {}
    store.publish_document_index(&stage).unwrap();
}

#[test]
fn cached_database_state_cannot_replace_an_existing_pin_context(){
    let(_dir,mut store)=fixture(1);let pin=store.open_document_snapshot().unwrap();let original=pin.database_state().clone();let key=Snapshot::of(pin.generation.id()).key();
    let raw:String=store.document_cache.connection.query_row("SELECT record FROM document_index_generations WHERE snapshot_key=?1",[&key],|r|r.get(0)).unwrap();let mut header:serde_json::Value=serde_json::from_str(&raw).unwrap();header["manifest"]["database_state"]["revision"]=serde_json::json!("999");store.document_cache.connection.execute("UPDATE document_index_generations SET record=?1 WHERE snapshot_key=?2",params![serde_json::to_string(&header).unwrap(),key]).unwrap();
    assert_eq!(pin.database_state(),&original);assert!(matches!(store.document_snapshot_manifest(&pin),Err(DocumentIndexError::RebuildRequired)));assert!(matches!(store.read_document_projection(&pin,&EntryId::new("entry-00").unwrap()),Err(DocumentIndexError::RebuildRequired)));
}

#[test]
fn published_pin_keeps_original_database_state_after_new_schema_generation(){
    let(_dir,mut store)=fixture(1);let old=store.open_document_snapshot().unwrap();assert!(old.database_state().collections.is_empty());let created=store.database_request(&crate::DatabaseRequest::Create{operation_id:OperationId::new("collection-create").unwrap(),name:"Books".into(),preset:None,properties:vec![]}).unwrap();build(&mut store);let latest=store.open_document_snapshot().unwrap();assert!(old.database_state().collections.is_empty());assert_eq!(latest.database_state().collections,created.collections);assert_ne!(old.database_state().revision,latest.database_state().revision);store.document_snapshot_manifest(&old).unwrap();store.document_snapshot_manifest(&latest).unwrap();
}
fn fixture(count: usize) -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut store = Store::open(root.join("vault.sqlite")).unwrap();
    store
        .enable_document_cache(root.join("cache.sqlite"))
        .unwrap();
    for n in 0..count {
        store.apply(&create(&format!("entry-{n:02}"))).unwrap();
    }
    store.initialize_document_index().unwrap();
    build(&mut store);
    (dir, store)
}
fn expired(result: IndexResult<()>) {
    assert!(matches!(
        result,
        Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
    ));
}
fn unchanged_check(store: &Store, pin: &DocumentQueryPin) -> IndexResult<()> {
    let before = (
        store.connection.total_changes(),
        store.document_cache.connection.total_changes(),
    );
    let result = store.check_document_metadata_pin_registration(pin);
    assert_eq!(
        (
            store.connection.total_changes(),
            store.document_cache.connection.total_changes()
        ),
        before
    );
    result
}

// Observe both actual connections, with no production instrumentation or FFI allocation.
struct RegistrationReads<'a> {
    connections: [&'a Connection; 2],
    counts: Box<std::cell::Cell<[usize; 5]>>,
}
impl<'a> RegistrationReads<'a> {
    fn new(store: &'a Store) -> Self {
        unsafe extern "C" fn observe(
            event: u32,
            context: *mut std::ffi::c_void,
            _: *mut std::ffi::c_void,
            sql: *mut std::ffi::c_void,
        ) -> i32 {
            if event == rusqlite::ffi::SQLITE_TRACE_STMT && !context.is_null() && !sql.is_null() {
                let sql = unsafe { std::ffi::CStr::from_ptr(sql.cast()) }.to_bytes();
                let has = |part: &[u8]| sql.windows(part.len()).any(|window| window == part);
                let cell = unsafe { &*context.cast::<std::cell::Cell<[usize; 5]>>() };
                let mut counts = cell.get();
                counts[0] += 1;
                if sql.starts_with(b"SELECT record FROM document_index_control WHERE") {
                    counts[1] += 1;
                }
                if has(b"document_index_generations") {
                    if sql.starts_with(b"SELECT EXISTS(SELECT 1 FROM document_index_generations WHERE snapshot_key=") {
                        counts[2] += 1;
                    } else {counts[3] += 1;}
                }
                if has(b"document_index_rows")
                    || has(b" FROM entries")
                    || has(b"projection_baselines")
                    || has(b" FROM local_changes")
                    || has(b"text_revisions")
                {
                    counts[4] += 1;
                }
                cell.set(counts);
            }
            0
        }
        let value = Self {
            connections: [&store.connection, &store.document_cache.connection],
            counts: Box::new(std::cell::Cell::new([0; 5])),
        };
        for connection in value.connections {
            assert_eq!(
                unsafe {
                    rusqlite::ffi::sqlite3_trace_v2(
                        connection.handle(),
                        rusqlite::ffi::SQLITE_TRACE_STMT,
                        Some(observe),
                        (&*value.counts as *const std::cell::Cell<[usize; 5]>)
                            .cast_mut()
                            .cast(),
                    )
                },
                rusqlite::ffi::SQLITE_OK
            );
        }
        value
    }
}
impl Drop for RegistrationReads<'_> {
    fn drop(&mut self) {
        for connection in self.connections {
            assert_eq!(
                unsafe {
                    rusqlite::ffi::sqlite3_trace_v2(
                        connection.handle(),
                        0,
                        None,
                        std::ptr::null_mut(),
                    )
                },
                rusqlite::ffi::SQLITE_OK
            );
        }
    }
}

#[test]
fn registration_work_is_constant_for_one_or_thirty_two_metadata_candidates() {
    let (_dir, store) = fixture(32);
    let pin = store.open_document_snapshot().unwrap();
    let trace = RegistrationReads::new(&store);
    let mut observations = Vec::new();
    for candidates in [1, 32] {
        trace.counts.set([0; 5]);
        unchanged_check(&store, &pin).unwrap();
        for n in 0..candidates {
            let id = EntryId::new(format!("entry-{n:02}")).unwrap();
            assert!(pin.generation().record(&id).unwrap().metadata().is_some());
        }
        unchanged_check(&store, &pin).unwrap();
        let counts = trace.counts.get();
        assert!(counts[0] > 0);
        assert_eq!(&counts[1..], &[2, 2, 0, 0], "{counts:?}");
        observations.push(counts);
    }
    assert_eq!(observations[0], observations[1]);
}

#[test]
fn admitted_facts_do_not_consume_changed_header_row_or_body_bytes() {
    let (_dir, store) = fixture(1);
    let pin = store.open_document_snapshot().unwrap();
    let id = EntryId::new("entry-00").unwrap();
    let original = pin.generation().record(&id).unwrap().clone();
    store
        .document_cache
        .connection
        .execute(
            "UPDATE document_index_generations SET record='corrupt header'",
            [],
        )
        .unwrap();
    store
        .document_cache
        .connection
        .execute(
            "UPDATE document_index_rows SET record='corrupt row',text=x'ff'",
            [],
        )
        .unwrap();
    unchanged_check(&store, &pin).unwrap();
    assert_eq!(pin.generation().record(&id), Some(&original));
    // Existing body/header readers keep their full cache validation unchanged.
    assert!(matches!(
        store.document_snapshot_manifest(&pin),
        Err(DocumentIndexError::RebuildRequired)
    ));
    assert!(matches!(
        store.read_document_projection(&pin, &id),
        Err(DocumentIndexError::RebuildRequired)
    ));
}

#[test]
fn old_and_new_actual_pins_remain_registered_across_source_edits_and_publication() {
    let (_dir, mut store) = fixture(1);
    let old = store.open_document_snapshot().unwrap();
    let id = EntryId::new("entry-00").unwrap();
    let previous = old.generation().manifest().entry(&id).unwrap().clone();
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("edit").unwrap(),
            mutation: Mutation::Write {
                id: id.clone(),
                expected: previous.revision.clone(),
                content: b"new source".to_vec(),
            },
        })
        .unwrap();
    unchanged_check(&store, &old).unwrap();
    build(&mut store);
    let current = store.open_document_snapshot().unwrap();
    assert_ne!(old.generation().id(), current.generation().id());
    assert_eq!(store.document_query_pins.load(Ordering::Relaxed), 2);
    unchanged_check(&store, &old).unwrap();
    unchanged_check(&store, &current).unwrap();
    assert_eq!(old.generation().manifest().entry(&id), Some(&previous));
    assert_ne!(
        current.generation().manifest().entry(&id).unwrap().revision,
        previous.revision
    );
}

#[test]
fn foreign_store_provider_and_counter_allocations_do_not_admit_a_pin() {
    let (dir, mut store) = fixture(1);
    let pin = store.open_document_snapshot().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut foreign = Store::open(root.join("vault.sqlite")).unwrap();
    foreign
        .enable_document_cache(root.join("cache.sqlite"))
        .unwrap();
    let trace = RegistrationReads::new(&foreign);
    expired(unchanged_check(&foreign, &pin));
    assert_eq!(trace.counts.get(), [0; 5]);
    drop(trace);
    let forged_counter = DocumentQueryPin {
        owner: pin.owner.clone(),
        generation: pin.shared_generation(),
        pins: Arc::new(AtomicUsize::new(1)),
        database_state: pin.database_state.clone(),
    };
    expired(unchanged_check(&store, &forged_counter));
    drop(forged_counter);
    store
        .enable_document_cache(root.join("replacement-cache.sqlite"))
        .unwrap();
    expired(unchanged_check(&store, &pin));
    assert_eq!(store.document_query_pins.load(Ordering::Relaxed), 0);
}

#[test]
fn independent_rebuild_or_retention_loss_between_page_fences_expires_transfer() {
    for rebuild in [false, true] {
        let (dir, store) = fixture(1);
        let baseline = store.open_document_snapshot().unwrap();
        let destination = store.open_document_snapshot().unwrap();
        unchanged_check(&store, &baseline).unwrap();
        unchanged_check(&store, &destination).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let mut competitor = Store::open(root.join("vault.sqlite")).unwrap();
        competitor
            .enable_document_cache(root.join("cache.sqlite"))
            .unwrap();
        if rebuild {
            competitor.rebuild_document_index().unwrap();
        } else {
            // Three later publications retire the original published registration.
            for _ in 0..DOCUMENT_INDEX_RETAINED_GENERATIONS {
                build(&mut competitor);
            }
        }
        expired(unchanged_check(&store, &baseline));
        expired(unchanged_check(&store, &destination));
        assert!(baseline
            .generation()
            .record(&EntryId::new("entry-00").unwrap())
            .is_some());
    }
}

#[test]
fn control_identity_format_allocation_and_bounded_encoding_fail_closed() {
    for fault in 0..7 {
        let (_dir, store) = fixture(1);
        let pin = store.open_document_snapshot().unwrap();
        let tx = store
            .document_transaction(TransactionBehavior::Deferred)
            .unwrap();
        let mut c = control(&tx).unwrap();
        tx.commit().unwrap();
        let raw = match fault {
            0 => {
                c.format = 2;
                encode(&c).unwrap()
            }
            1 => {
                c.allocated = 0;
                encode(&c).unwrap()
            }
            2 => {
                c.head.as_mut().unwrap().local = fresh();
                encode(&c).unwrap()
            }
            3 => {
                c.head.as_mut().unwrap().schema = 0;
                encode(&c).unwrap()
            }
            4 => "invalid-json".into(),
            5 => "x".repeat(DOCUMENT_INDEX_MAX_CONTROL_BYTES + 1),
            _ => {
                store
                    .document_cache
                    .connection
                    .execute("DELETE FROM document_index_control", [])
                    .unwrap();
                String::new()
            }
        };
        if fault != 6 {
            store
                .document_cache
                .connection
                .execute("UPDATE document_index_control SET record=?1", [raw])
                .unwrap();
        }
        assert!(
            matches!(
                unchanged_check(&store, &pin),
                Err(DocumentIndexError::RebuildRequired)
            ),
            "fault {fault}"
        );
    }
}

#[test]
fn missing_retention_and_scope_corruption_are_not_admitted_as_metadata() {
    for scope_fault in [false, true] {
        let (_dir, store) = fixture(1);
        let pin = store.open_document_snapshot().unwrap();
        if scope_fault {
            store
                .document_cache
                .connection
                .execute(
                    "UPDATE document_cache_scope SET local_store_id=?1",
                    [fresh().as_str()],
                )
                .unwrap();
            assert!(matches!(
                unchanged_check(&store, &pin),
                Err(DocumentIndexError::RebuildRequired)
            ));
        } else {
            store
                .document_cache
                .connection
                .execute(
                    "DELETE FROM document_index_generations WHERE snapshot_key=?1",
                    [Snapshot::of(pin.generation().id()).key()],
                )
                .unwrap();
            expired(unchanged_check(&store, &pin));
        }
    }
}

#[test]
fn dropping_a_pin_releases_admission_even_when_immutable_data_survive() {
    let (_dir, store) = fixture(1);
    let pin = store.open_document_snapshot().unwrap();
    let data = pin.shared_generation();
    unchanged_check(&store, &pin).unwrap();
    store.close_document_snapshot(pin);
    assert_eq!(store.document_query_pins.load(Ordering::Relaxed), 0);
    let pins: Vec<_> = (0..DOCUMENT_INDEX_MAX_QUERY_PINS)
        .map(|_| store.open_document_snapshot().unwrap())
        .collect();
    for pin in &pins {
        unchanged_check(&store, pin).unwrap();
    }
    assert!(matches!(
        store.open_document_snapshot(),
        Err(DocumentIndexError::Contract(IndexError::GenerationLimit))
    ));
    assert!(data.record(&EntryId::new("entry-00").unwrap()).is_some());
    drop(pins);
    assert_eq!(store.document_query_pins.load(Ordering::Relaxed), 0);
}
