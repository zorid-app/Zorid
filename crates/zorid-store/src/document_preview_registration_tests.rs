//! Registered previews bind frozen presentation/text facts to a live Store
//! instance and unpublished stage; these are never ordinary published pins.
use super::*;
use std::{cell::Cell, path::PathBuf};

const DEFINITION: &str = "\u{feff}views:\r\n  - type: table\r\n    name: \"😀\"\r\n";
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn request(bytes: usize) -> DocumentPreviewCaptureRequest {
    DocumentPreviewCaptureRequest {
        owner_nonce: op("registered-incarnation"),
        stage_id: op("registered-stage"),
        retained_byte_limit: bytes,
    }
}
fn create(n: usize, definition: &str) -> MutationRequest {
    let name = format!("note-{n:02}");
    MutationRequest {
        operation_id: op(&format!("create-{n}")),
        mutation: Mutation::Create {
            id: id(&name),
            path: zorid_core::VaultPath::new(if n == 0 {
                "definition.base".into()
            } else {
                format!("{name}.md")
            })
            .unwrap(),
            kind: EntryKind::File,
            content: Some(if n == 0 {
                definition.as_bytes().to_vec()
            } else {
                format!("text-{n:02}").into_bytes()
            }),
        },
    }
}
fn fixture(
    count: usize,
    definition: &str,
) -> (
    tempfile::TempDir,
    Store,
    PathBuf,
    PathBuf,
    DocumentIndexStage,
) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let authority = root.join("vault.sqlite");
    let cache = root.join("cache.sqlite");
    let mut store = Store::open(&authority).unwrap();
    store.enable_document_cache(&cache).unwrap();
    for n in 0..count {
        store.apply(&create(n, definition)).unwrap();
    }
    store.initialize_document_index().unwrap();
    let stage = store.begin_document_index().unwrap();
    (dir, store, authority, cache, stage)
}
fn capture(store: &mut Store, stage: &DocumentIndexStage) -> DocumentPreviewCapture {
    store
        .pump_document_index_with_registered_preview(
            stage,
            Some(request(zorid_index::MAX_SEARCH_OWNED_BYTES)),
            |_| Ok::<_, &'static str>(()),
        )
        .unwrap()
        .preview
        .unwrap()
        .unwrap()
}
fn expired<T>(result: IndexResult<T>) {
    assert!(matches!(
        result,
        Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
    ));
}
fn source_mismatch<T>(result: IndexResult<T>) {
    assert!(matches!(
        result,
        Err(DocumentIndexError::Contract(IndexError::ContentMismatch))
    ));
}

#[test]
fn registered_partial_capture_keeps_sorted_frozen_presentations_and_reads_exact_definition() {
    let (_dir, mut store, _authority, _cache, stage) = fixture(35, DEFINITION);
    let first = capture(&mut store, &stage);
    assert_eq!(first.source(), stage.source());
    assert!(first.is_first_build());
    assert_eq!(
        (
            first.snapshot().progress().prepared_files,
            first.snapshot().progress().pending_files
        ),
        (32, 3)
    );
    let facts = first.presentations();
    assert_eq!(facts.len(), 32);
    assert!(facts
        .windows(2)
        .all(|pair| pair[0].entry().id < pair[1].entry().id));
    let ids: Vec<_> = first
        .snapshot()
        .facts_view_checked(&mut |_| Ok::<_, ()>(()))
        .unwrap()
        .rows()
        .map(|row| row.entry_id().clone())
        .collect();
    assert_eq!(
        facts
            .iter()
            .map(|row| row.entry().id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    for row in facts {
        assert_eq!(&row.entry().id, &row.presentation().id);
        assert_eq!(
            row.source_text_bytes().map(|n| n as u64),
            Some(row.presentation().size_bytes)
        );
    }
    assert!(first.retained_bytes() > first.snapshot().retention().total_bytes());
    assert!(first.retained_bytes() <= zorid_index::MAX_SEARCH_OWNED_BYTES);
    store.check_document_preview_registration(&first).unwrap();
    let definition = store
        .read_document_preview_definition(&first, &id("note-00"), DEFINITION.len())
        .unwrap();
    assert_eq!(definition.text(), DEFINITION);
    assert_eq!(definition.entry(), facts[0].entry());
    assert_eq!(definition.presentation(), facts[0].presentation());
    assert!(definition.text_heap_bytes() >= DEFINITION.len());
    assert!(definition.text_heap_bytes() <= DEFINITION.len() + 16);
    assert!(matches!(
        store.read_document_preview_definition(&first, &id("note-34"), 262144),
        Err(DocumentIndexError::NotReady)
    ));
    assert!(matches!(
        store.read_document_preview_definition(&first, &id("unknown"), 262144),
        Err(DocumentIndexError::NotReady)
    ));
    assert!(matches!(
        store.open_document_snapshot(),
        Err(DocumentIndexError::NotReady)
    ));

    let next = capture(&mut store, &stage);
    assert_eq!(
        (
            next.snapshot().progress().prepared_files,
            next.snapshot().progress().pending_files
        ),
        (35, 0)
    );
    assert_ne!(first.snapshot().id(), next.snapshot().id());
    store.check_document_preview_registration(&first).unwrap();
    assert_eq!(first.presentations().len(), 32);
    assert!(matches!(
        store.read_document_preview_definition(&first, &id("note-34"), 262144),
        Err(DocumentIndexError::NotReady)
    ));
    assert_eq!(
        store
            .read_document_preview_definition(&next, &id("note-34"), 262144)
            .unwrap()
            .text(),
        "text-34"
    );
    assert!(matches!(
        store.open_document_snapshot(),
        Err(DocumentIndexError::NotReady)
    ));
}

#[test]
fn registered_preview_expires_on_source_head_discard_and_rebuild_without_changing_frozen_data() {
    for fault in ["source", "head", "discard", "rebuild"] {
        let (_dir, mut store, _authority, _cache, stage) = fixture(1, DEFINITION);
        let preview = capture(&mut store, &stage);
        let original = preview.presentations()[0].entry().clone();
        match fault {
            "source" => {
                store
                    .apply(&MutationRequest {
                        operation_id: op("edit-source"),
                        mutation: Mutation::Write {
                            id: original.id.clone(),
                            expected: original.revision.clone(),
                            content: b"new definition".to_vec(),
                        },
                    })
                    .unwrap();
            }
            "head" => {
                store.publish_document_index(&stage).unwrap();
            }
            "discard" => {
                store
                    .discard_document_index_stage(stage.snapshot())
                    .unwrap();
            }
            "rebuild" => {
                store.rebuild_document_index().unwrap();
            }
            _ => unreachable!(),
        }
        expired(store.check_document_preview_registration(&preview));
        expired(store.read_document_preview_definition(&preview, &original.id, 262144));
        assert_eq!(preview.presentations()[0].entry(), &original);
        preview
            .snapshot()
            .check_text(&original.id, DEFINITION.as_bytes())
            .unwrap();
        assert_eq!(preview.source(), stage.source());
    }
}

#[test]
fn registered_preview_cannot_cross_store_reopen_or_same_provider_replacement() {
    let (_dir, mut store, authority, cache, stage) = fixture(1, DEFINITION);
    let preview = capture(&mut store, &stage);
    let owner_label = store.document_query_owner.clone();
    let mut foreign = Store::open(&authority).unwrap();
    foreign.enable_document_cache(&cache).unwrap();
    // Deliberately align every scalar owner label with the captured Store.
    // Only the separate provider backing can reject this otherwise identical
    // authority/cache/source/stage registration.
    foreign.document_query_owner = owner_label.clone();
    expired(foreign.check_document_preview_registration(&preview));
    expired(foreign.read_document_preview_definition(&preview, &id("note-00"), 262144));
    drop(foreign);
    // Replacing the provider with the SAME durable cache still creates a fresh
    // process-local registration incarnation; identical rows cannot renew it.
    store.enable_document_cache(&cache).unwrap();
    store.document_query_owner = owner_label.clone();
    expired(store.check_document_preview_registration(&preview));
    drop(store);
    let mut reopened = Store::open(&authority).unwrap();
    reopened.enable_document_cache(&cache).unwrap();
    reopened.document_query_owner = owner_label;
    expired(reopened.check_document_preview_registration(&preview));
    expired(reopened.read_document_preview_definition(&preview, &id("note-00"), 262144));
    preview
        .snapshot()
        .check_text(&id("note-00"), DEFINITION.as_bytes())
        .unwrap();
}

#[test]
fn registered_definition_rejects_missing_wrong_length_wrong_digest_utf8_type_and_excluded_bytes() {
    for fault in [
        "missing row",
        "null body",
        "length",
        "digest",
        "utf8",
        "type",
    ] {
        let (_dir, mut store, _authority, _cache, stage) = fixture(1, DEFINITION);
        let preview = capture(&mut store, &stage);
        let key = Snapshot::of(stage.snapshot()).key();
        match fault {
            "missing row" => {
                store
                    .document_cache
                    .connection
                    .execute(
                        "DELETE FROM document_index_rows WHERE snapshot_key=?1 AND entry_id=?2",
                        params![key, "note-00"],
                    )
                    .unwrap();
            }
            "null body" => {
                store.document_cache.connection.execute("UPDATE document_index_rows SET text=NULL WHERE snapshot_key=?1 AND entry_id=?2", params![key, "note-00"]).unwrap();
            }
            "type" => {
                store.document_cache.connection.execute("UPDATE document_index_rows SET text=?3 WHERE snapshot_key=?1 AND entry_id=?2", params![key, "note-00", DEFINITION]).unwrap();
            }
            other => {
                let mut bytes = DEFINITION.as_bytes().to_vec();
                match other {
                    "length" => {
                        bytes.pop();
                    }
                    "digest" => bytes[3] = b'V',
                    "utf8" => bytes[3] = 0xff,
                    _ => unreachable!(),
                }
                store.document_cache.connection.execute("UPDATE document_index_rows SET text=?3 WHERE snapshot_key=?1 AND entry_id=?2", params![key, "note-00", bytes]).unwrap();
            }
        }
        let result = store.read_document_preview_definition(&preview, &id("note-00"), 262144);
        if fault == "missing row" {
            expired(result);
        } else {
            source_mismatch(result);
        }
    }
    let (_dir, mut store, _authority, _cache, _unused) = fixture(0, "");
    store
        .apply(&MutationRequest {
            operation_id: op("create-binary"),
            mutation: Mutation::Create {
                id: id("binary"),
                path: zorid_core::VaultPath::new("binary.base").unwrap(),
                kind: EntryKind::File,
                content: Some(vec![0xff, 0, 1]),
            },
        })
        .unwrap();
    let stage = store.begin_document_index().unwrap();
    let preview = capture(&mut store, &stage);
    assert_eq!(preview.presentations()[0].source_text_bytes(), None);
    assert!(matches!(
        store.read_document_preview_definition(&preview, &id("binary"), 262144),
        Err(DocumentIndexError::Contract(IndexError::InvalidTarget))
    ));
}

#[test]
fn registered_definition_enforces_byte_ceiling_and_allows_genuine_empty_text_at_zero() {
    let (_dir, mut store, _authority, _cache, stage) = fixture(1, DEFINITION);
    let preview = capture(&mut store, &stage);
    for maximum in [0, DEFINITION.len() - 1] {
        assert!(matches!(
            store.read_document_preview_definition(&preview, &id("note-00"), maximum),
            Err(DocumentIndexError::Contract(IndexError::GenerationLimit))
        ));
    }
    for maximum in [262145, usize::MAX] {
        assert!(matches!(
            store.read_document_preview_definition(&preview, &id("note-00"), maximum),
            Err(DocumentIndexError::Contract(IndexError::InvalidBudget))
        ));
    }
    assert_eq!(
        store
            .read_document_preview_definition(&preview, &id("note-00"), 262144)
            .unwrap()
            .text(),
        DEFINITION
    );
    let oversized = "x".repeat(262145);
    let (_large_dir, mut large, _authority, _cache, stage) = fixture(1, &oversized);
    let large_preview = capture(&mut large, &stage);
    assert!(matches!(
        large.read_document_preview_definition(&large_preview, &id("note-00"), 262144),
        Err(DocumentIndexError::Contract(IndexError::GenerationLimit))
    ));
    let (_empty_dir, mut empty, _authority, _cache, stage) = fixture(1, "");
    let preview = capture(&mut empty, &stage);
    assert_eq!(preview.presentations()[0].source_text_bytes(), Some(0));
    let definition = empty
        .read_document_preview_definition(&preview, &id("note-00"), 0)
        .unwrap();
    assert_eq!(definition.text(), "");
    assert_eq!(definition.text_heap_bytes(), 0);
    assert_eq!(definition.into_text(), "");
}

// Test-local SQLite policy, registered on both live connections. It blocks
// expensive persisted metadata/source-body reloads while permitting the exact
// retained text target and the small control/existence/source fences.
struct NoMetadataReload<'a> {
    connections: [&'a Connection; 2],
    reads: Box<Cell<[usize; 4]>>,
}
impl<'a> NoMetadataReload<'a> {
    fn new(store: &'a Store) -> Self {
        unsafe extern "C" fn authorize(
            context: *mut std::ffi::c_void,
            action: i32,
            table: *const std::ffi::c_char,
            column: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
        ) -> i32 {
            if action != rusqlite::ffi::SQLITE_READ
                || context.is_null()
                || table.is_null()
                || column.is_null()
            {
                return rusqlite::ffi::SQLITE_OK;
            }
            let table = unsafe { std::ffi::CStr::from_ptr(table) }.to_bytes();
            let column = unsafe { std::ffi::CStr::from_ptr(column) }.to_bytes();
            let state = unsafe { &*context.cast::<Cell<[usize; 4]>>() };
            let mut reads = state.get();
            reads[0] += 1;
            if table == b"document_index_rows" {
                reads[3] += 1;
            }
            let forbidden = ((table == b"document_index_generations"
                || table == b"document_index_rows")
                && column == b"record")
                || (table == b"entries"
                    && [b"content".as_slice(), b"content_ref", b"content_digest"]
                        .contains(&column));
            if forbidden {
                reads[1] += 1;
            }
            if table == b"document_index_rows" && column == b"text" {
                reads[2] += 1;
            }
            state.set(reads);
            if forbidden {
                rusqlite::ffi::SQLITE_DENY
            } else {
                rusqlite::ffi::SQLITE_OK
            }
        }
        let guard = Self {
            connections: [&store.connection, &store.document_cache.connection],
            reads: Box::new(Cell::new([0; 4])),
        };
        for connection in guard.connections {
            assert_eq!(
                unsafe {
                    rusqlite::ffi::sqlite3_set_authorizer(
                        connection.handle(),
                        Some(authorize),
                        (&*guard.reads as *const Cell<[usize; 4]>).cast_mut().cast(),
                    )
                },
                rusqlite::ffi::SQLITE_OK
            );
        }
        guard
    }
}
impl Drop for NoMetadataReload<'_> {
    fn drop(&mut self) {
        for connection in self.connections {
            unsafe {
                rusqlite::ffi::sqlite3_set_authorizer(
                    connection.handle(),
                    None,
                    std::ptr::null_mut(),
                );
            }
        }
    }
}
#[test]
fn registered_preview_checks_are_constant_and_never_reload_header_or_row_metadata() {
    let (_dir, mut store, _authority, _cache, stage) = fixture(32, DEFINITION);
    let preview = capture(&mut store, &stage);
    store.document_cache.connection.execute("UPDATE document_index_generations SET record='unreadable header' WHERE snapshot_key=?1", [Snapshot::of(stage.snapshot()).key()]).unwrap();
    store
        .document_cache
        .connection
        .execute(
            "UPDATE document_index_rows SET record='unreadable facts' WHERE snapshot_key=?1",
            [Snapshot::of(stage.snapshot()).key()],
        )
        .unwrap();
    let changes = (
        store.connection.total_changes(),
        store.document_cache.connection.total_changes(),
    );
    let fence = NoMetadataReload::new(&store);
    let mut observations = Vec::new();
    for count in [1, 32] {
        fence.reads.set([0; 4]);
        store.check_document_preview_registration(&preview).unwrap();
        for fact in preview.presentations().iter().take(count) {
            assert!(fact.source_text_bytes().is_some());
        }
        store.check_document_preview_registration(&preview).unwrap();
        let reads = fence.reads.get();
        assert!(reads[0] > 0);
        assert_eq!(&reads[1..], &[0, 0, 0]);
        observations.push(reads);
    }
    assert_eq!(observations[0], observations[1]);
    fence.reads.set([0; 4]);
    let definition = store
        .read_document_preview_definition(&preview, &id("note-00"), 262144)
        .unwrap();
    assert_eq!(definition.text(), DEFINITION);
    let reads = fence.reads.get();
    assert_eq!(reads[1], 0);
    assert!(reads[2] > 0);
    assert_eq!(
        (
            store.connection.total_changes(),
            store.document_cache.connection.total_changes()
        ),
        changes
    );
}

#[test]
fn registered_capture_accounts_presentation_package_and_keeps_successful_durable_progress_on_resource(
) {
    let (_dir, mut store, _authority, _cache, stage) = fixture(1, DEFINITION);
    let registered = capture(&mut store, &stage);
    let core_limit = registered.snapshot().retention().total_bytes();
    assert!(registered.retained_bytes() > core_limit);
    // The thin core capture alone fits this limit; the registered presentation
    // package must admit its extra allocations in that SAME retained budget.
    let core = store
        .pump_document_index_with_preview(&stage, Some(request(core_limit)), |_| Ok::<_, ()>(()))
        .unwrap();
    assert!(core.progress.ready);
    assert!(core.preview.unwrap().is_ok());
    let result = store
        .pump_document_index_with_registered_preview(&stage, Some(request(core_limit)), |_| {
            Ok::<_, ()>(())
        })
        .unwrap();
    assert!(result.progress.ready);
    assert_eq!(result.progress.prepared_documents, 1);
    assert!(matches!(
        result.preview,
        Some(Err(PreviewCaptureError::Resource(_)))
    ));
    let rows: i64 = store
        .document_cache
        .connection
        .query_row(
            "SELECT count(*) FROM document_index_rows WHERE snapshot_key=?1",
            [Snapshot::of(stage.snapshot()).key()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);
    store
        .check_document_preview_registration(&registered)
        .unwrap();
    assert_eq!(
        store
            .read_document_preview_definition(&registered, &id("note-00"), 262144)
            .unwrap()
            .text(),
        DEFINITION
    );
}
