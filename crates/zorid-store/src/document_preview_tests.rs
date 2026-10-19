//! Store capture is data from a completed pump, never an alternate publication.
use super::*;
use std::cell::Cell;
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn create(index: usize) -> MutationRequest {
    let name = format!("note-{index:02}");
    MutationRequest {
        operation_id: op(&format!("create-{index}")),
        mutation: Mutation::Create {
            id: id(&name),
            path: zorid_core::VaultPath::new(format!("{name}.md")).unwrap(),
            kind: EntryKind::File,
            content: Some(format!("text-{index:02}").into_bytes()),
        },
    }
}
fn setup(count: usize) -> (tempfile::TempDir, Store, DocumentIndexStage) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
    for n in 0..count {
        store.apply(&create(n)).unwrap();
    }
    store.initialize_document_index().unwrap();
    let stage = store.begin_document_index().unwrap();
    (dir, store, stage)
}
fn request(bytes: usize) -> DocumentPreviewCaptureRequest {
    DocumentPreviewCaptureRequest {
        owner_nonce: op("capture-incarnation"),
        stage_id: op("capture-stage"),
        owned_byte_limit: bytes,
    }
}
fn persisted(store: &Store, stage: &DocumentIndexStage) -> Vec<String> {
    store
        .document_cache
        .connection
        .prepare("SELECT entry_id FROM document_index_rows WHERE snapshot_key=?1 ORDER BY entry_id")
        .unwrap()
        .query_map([Snapshot::of(stage.snapshot()).key()], |row| row.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}
fn captured(preview: &PreviewSnapshot) -> Vec<String> {
    let view = preview
        .facts_view_checked(&mut |_| Ok::<_, ()>(()))
        .unwrap();
    view.rows()
        .map(|row| row.entry_id().as_str().to_owned())
        .collect()
}
#[test]
fn capture_runs_after_commit_and_exactly_matches_persisted_prepared_membership() {
    let (_dir, mut store, stage) = setup(35);
    let handle = unsafe { store.document_cache.connection.handle() };
    let mut visits = 0;
    let first = store
        .pump_document_index_with_preview(
            &stage,
            Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
            |_| {
                visits += 1;
                // The Store/connection remains alive for this synchronous call. This
                // read-only SQLite query allocates nothing and cannot invoke user code.
                assert_eq!(unsafe { rusqlite::ffi::sqlite3_get_autocommit(handle) }, 1);
                Ok::<_, ()>(())
            },
        )
        .unwrap();
    assert!(visits > 0);
    assert_eq!(
        (
            first.progress.prepared_documents,
            first.progress.total_documents,
            first.progress.ready
        ),
        (32, 35, false)
    );
    let old = first.preview.unwrap().unwrap();
    assert_eq!(old.source(), stage.source());
    assert_eq!(captured(&old), persisted(&store, &stage));
    assert_eq!(
        (old.progress().prepared_files, old.progress().pending_files),
        (32, 3)
    );
    old.check_text(&id("note-00"), b"text-00").unwrap();
    assert_eq!(
        old.check_text(&id("note-34"), b"text-34"),
        Err(IndexError::MissingSource)
    );
    let next = store
        .pump_document_index_with_preview(
            &stage,
            Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
    assert!(next.progress.ready);
    let next = next.preview.unwrap().unwrap();
    assert_eq!(captured(&next), persisted(&store, &stage));
    assert_eq!(
        (
            next.progress().prepared_files,
            next.progress().pending_files
        ),
        (35, 0)
    );
    assert_ne!(old.id(), next.id()); // Equal caller labels/serial cannot alias backing.
    assert_eq!(old.progress().prepared_files, 32);
    assert!(matches!(
        store.open_document_snapshot(),
        Err(DocumentIndexError::NotReady)
    ));
}
#[test]
fn optional_capture_cancel_and_resource_failure_keep_successful_durable_progress() {
    let (_dir, mut store, stage) = setup(35);
    let first = store
        .pump_document_index_with_preview(
            &stage,
            Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
            |_| Err::<(), _>("stop-capture"),
        )
        .unwrap();
    assert_eq!(first.progress.prepared_documents, 32);
    assert!(matches!(
        first.preview,
        Some(Err(PreviewCaptureError::Host("stop-capture")))
    ));
    assert_eq!(persisted(&store, &stage).len(), 32);
    let last = store
        .pump_document_index_with_preview(&stage, Some(request(0)), |_| Ok::<_, ()>(()))
        .unwrap();
    assert_eq!(last.progress.prepared_documents, 35);
    assert!(last.progress.ready);
    assert!(matches!(
        last.preview,
        Some(Err(PreviewCaptureError::Resource(_)))
    ));
    assert_eq!(persisted(&store, &stage).len(), 35);
    store.publish_document_index(&stage).unwrap();
    let pin = store.open_document_snapshot().unwrap();
    assert_eq!(pin.generation().records().count(), 35);
    store.close_document_snapshot(pin);
}
// Test-only connection-local authorizer. It rejects the second stage INSERT,
// after one row has been written inside the same transaction. The guard is
// declared after Store and dropped before Store can close its SQLite handle.
// The stable Box lives through unregister, including assertion unwinding.
struct RejectSecondInsert {
    handle: *mut rusqlite::ffi::sqlite3,
    visits: Box<Cell<usize>>,
}
impl RejectSecondInsert {
    fn new(connection: &Connection) -> Self {
        unsafe extern "C" fn authorize(
            context: *mut std::ffi::c_void,
            action: i32,
            first: *const std::ffi::c_char,
            _second: *const std::ffi::c_char,
            _database: *const std::ffi::c_char,
            _trigger: *const std::ffi::c_char,
        ) -> i32 {
            if action == rusqlite::ffi::SQLITE_INSERT
                && !context.is_null()
                && !first.is_null()
                && unsafe { std::ffi::CStr::from_ptr(first) }.to_bytes() == b"document_index_rows"
            {
                let visits = unsafe { &*context.cast::<Cell<usize>>() };
                let n = visits.get().saturating_add(1);
                visits.set(n);
                if n == 2 {
                    return rusqlite::ffi::SQLITE_DENY;
                }
            }
            rusqlite::ffi::SQLITE_OK
        }
        let guard = Self {
            handle: unsafe { connection.handle() },
            visits: Box::new(Cell::new(0)),
        };
        let status = unsafe {
            rusqlite::ffi::sqlite3_set_authorizer(
                guard.handle,
                Some(authorize),
                (&*guard.visits as *const Cell<usize>).cast_mut().cast(),
            )
        };
        assert_eq!(status, rusqlite::ffi::SQLITE_OK);
        guard
    }
}
impl Drop for RejectSecondInsert {
    fn drop(&mut self) {
        unsafe {
            rusqlite::ffi::sqlite3_set_authorizer(self.handle, None, std::ptr::null_mut());
        }
    }
}
#[test]
fn failed_pump_transaction_exposes_no_capture_or_uncommitted_builder_rows() {
    let (_dir, mut store, stage) = setup(2);
    let reject = RejectSecondInsert::new(&store.document_cache.connection);
    let mut visits = 0;
    let result = store.pump_document_index_with_preview(
        &stage,
        Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
        |_| {
            visits += 1;
            Ok::<_, ()>(())
        },
    );
    assert!(result.is_err());
    assert_eq!(reject.visits.get(), 2);
    assert_eq!(visits, 0);
    drop(reject);
    assert!(persisted(&store, &stage).is_empty());
    let result = store
        .pump_document_index_with_preview(
            &stage,
            Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
    assert!(result.progress.ready);
    assert_eq!(
        captured(&result.preview.unwrap().unwrap()),
        persisted(&store, &stage)
    );
}
#[test]
fn stale_stage_source_rejects_before_any_capture_work_and_keeps_old_data_coherent() {
    let (_dir, mut store, stage) = setup(35);
    let first = store
        .pump_document_index_with_preview(
            &stage,
            Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
    let old = first.preview.unwrap().unwrap();
    let state = store.read_metadata(&id("note-00")).unwrap().unwrap().state;
    store
        .apply(&MutationRequest {
            operation_id: op("changed-source"),
            mutation: Mutation::Write {
                id: state.id,
                expected: state.revision,
                content: b"changed".to_vec(),
            },
        })
        .unwrap();
    let mut visits = 0;
    let result = store.pump_document_index_with_preview(
        &stage,
        Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
        |_| {
            visits += 1;
            Ok::<_, ()>(())
        },
    );
    assert!(matches!(
        result,
        Err(DocumentIndexError::Contract(IndexError::StaleSource))
    ));
    assert_eq!(visits, 0);
    assert_eq!(persisted(&store, &stage).len(), 32);
    assert_eq!(old.source(), stage.source());
    old.check_text(&id("note-00"), b"text-00").unwrap();
    // Immutable old data remain data; only a separate live source/stage/client
    // admission can authorize a future read-only platform query.
    assert_ne!(
        old.source(),
        store
            .capture_document_manifest()
            .unwrap()
            .manifest()
            .unwrap()
            .source()
    );
}
#[test]
fn old_api_and_none_request_preserve_progress_and_skip_all_capture_callbacks() {
    let (_old_dir, mut old, old_stage) = setup(35);
    let (_new_dir, mut optional, new_stage) = setup(35);
    let old_progress = old.pump_document_index(&old_stage).unwrap();
    let new_progress = optional
        .pump_document_index_with_preview(&new_stage, None, |_| -> std::result::Result<(), ()> {
            panic!("None cannot invoke capture");
        })
        .unwrap();
    assert!(new_progress.preview.is_none());
    let new_progress = new_progress.progress;
    assert_eq!(
        (
            old_progress.prepared_documents,
            old_progress.total_documents,
            old_progress.ready,
            old_progress.reused_documents
        ),
        (
            new_progress.prepared_documents,
            new_progress.total_documents,
            new_progress.ready,
            new_progress.reused_documents
        )
    );
    assert_eq!(
        serde_json::to_value(old_progress.parse_cache).unwrap(),
        serde_json::to_value(new_progress.parse_cache).unwrap()
    );
    assert_eq!(
        persisted(&old, &old_stage),
        persisted(&optional, &new_stage)
    );
}
