use super::*;
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
};
use zorid_core::{EntryId, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_index::{CompiledSearchQuery, SearchLimits, SearchOptions};

fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn create(vault: &mut NativeVault, name: &str, path: &str, content: &[u8]) {
    vault
        .apply(&MutationRequest {
            operation_id: OperationId::new(format!("create-{name}")).unwrap(),
            mutation: Mutation::Create {
                id: id(name),
                path: VaultPath::new(path).unwrap(),
                kind: EntryKind::File,
                content: Some(content.to_vec()),
            },
        })
        .unwrap();
}
fn build(vault: &mut NativeVault) {
    let stage = vault.begin_document_index().unwrap();
    for _ in 0..100 {
        if vault.pump_document_index(&stage).unwrap().ready {
            vault.publish_document_index(&stage).unwrap();
            return;
        }
    }
    panic!("bounded fixture did not finish");
}
const FIRST: &[u8] = b"---\nstatus: todo\ntags: [topic]\n---\ncat one\ncat two\n";
fn fixture(vault: &mut NativeVault, binary: bool) {
    for (name, path) in [("notes-folder", "Notes"), ("else-folder", "Else")] {
        vault
            .apply(&MutationRequest {
                operation_id: OperationId::new(format!("create-{name}")).unwrap(),
                mutation: Mutation::Create {
                    id: id(name),
                    path: VaultPath::new(path).unwrap(),
                    kind: EntryKind::Folder,
                    content: None,
                },
            })
            .unwrap();
    }
    create(vault, "first", "Notes/Only-name.md", FIRST);
    create(vault, "second", "Else/Second.md", b"cat three\n");
    if binary {
        create(vault, "binary", "image.png", &[0, 255, 128, 10]);
    }
    vault.initialize_document_index().unwrap();
    build(vault);
}
fn spec(query: &str) -> SearchSpec {
    SearchSpec {
        query: query.into(),
        case_sensitive: false,
        sort: SearchSort::NameAsc,
        context: SearchContext::Line,
        explain: true,
    }
}
fn ready(vault: &NativeVault, query: &NativeRichQuery) -> NativeRichCursor {
    for _ in 0..100 {
        match vault
            .prepare_rich_document_query(query, 2_000_000, |_| Ok(()))
            .unwrap()
        {
            NativeRichPreparation::Ready(cursor) => return cursor,
            NativeRichPreparation::Preparing => {}
        }
    }
    panic!("bounded order preparation did not finish");
}
fn expected_error<T>(value: NativeDocumentResult<T>, code: &str) {
    match value {
        Err(error) => assert_eq!(error.code(), code, "{error}"),
        Ok(_) => panic!("expected {code}"),
    }
}

#[test]
fn rich_pages_retry_and_read_the_guarded_retained_generation_after_a_new_commit() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    fixture(&mut vault, false);
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let source = pin.generation().manifest().source().clone();
    let expected_first = pin
        .generation()
        .manifest()
        .entry(&id("first"))
        .unwrap()
        .clone();
    let mut profile = RichPageProfile::default();
    profile.chunks = 1;
    profile.documents = 1;
    profile.locations_per_chunk = 1;
    let query = vault
        .start_rich_document_query(pin.clone(), spec("cat"), profile, |_| Ok(()))
        .unwrap();
    let cursor = ready(&vault, &query);
    let first = vault
        .rich_document_page(&query, &cursor, |_| Ok(()))
        .unwrap();
    let retry = vault
        .rich_document_page(&query, &cursor, |_| Ok(()))
        .unwrap();
    assert_eq!(first.result.value, retry.result.value);
    assert!(first.next == retry.next);
    assert!(!first.result.value.complete);
    assert_eq!(first.result.value.files[0].chunk, 0);
    assert_eq!(first.result.value.files[0].occurrence_count, 2);
    vault
        .apply(&MutationRequest {
            operation_id: OperationId::new("write-new-source").unwrap(),
            mutation: Mutation::Write {
                id: id("first"),
                expected: expected_first.revision.clone(),
                content: b"new unrelated source\n".to_vec(),
            },
        })
        .unwrap();
    build(&mut vault);
    let mut next = first.next;
    let mut chunks = first.result.value.files;
    let mut terminal = None;
    for _ in 0..32 {
        let Some(cursor) = next.take() else {
            break;
        };
        let page = vault
            .rich_document_page(&query, &cursor, |_| Ok(()))
            .unwrap();
        assert_eq!(page.result.source, source);
        assert_eq!(page.result.snapshot, *pin.generation().id());
        chunks.extend(page.result.value.files.clone());
        next = page.next;
        terminal = Some(page.result.value);
    }
    assert!(next.is_none());
    let terminal = terminal.unwrap();
    assert!(terminal.complete);
    assert_eq!(terminal.totals.files, SearchCount::Exact { value: 2 });
    assert_eq!(terminal.totals.occurrences, SearchCount::Exact { value: 3 });
    assert!(chunks
        .iter()
        .filter(|chunk| chunk.entry.id == id("first"))
        .all(|chunk| chunk.entry == expected_first && chunk.occurrence_count == 2));
    assert!(chunks
        .iter()
        .any(|chunk| chunk.entry.id == id("first") && chunk.chunk == 1 && chunk.last_chunk));
    assert_eq!(
        std::fs::read(dir.path().join("Notes/Only-name.md")).unwrap(),
        b"new unrelated source\n"
    );
}

thread_local! {
    static READS: Cell<usize> = const { Cell::new(0) };
    static CANCEL_AT: RefCell<Option<&'static str>> = const { RefCell::new(None) };
    static CANCELLED: Cell<bool> = const { Cell::new(false) };
}
fn observe(point: &str) {
    if point == "rich_search_before_read" {
        READS.with(|value| value.set(value.get() + 1));
    }
    CANCEL_AT.with(|value| {
        if *value.borrow() == Some(point) {
            CANCELLED.with(|flag| flag.set(true));
        }
    });
}
fn cancellation(_: usize) -> NativeDocumentResult<()> {
    if CANCELLED.with(Cell::get) {
        Err(NativeDocumentError::QueryCancelled)
    } else {
        Ok(())
    }
}

#[test]
fn metadata_and_name_queries_never_read_bodies_but_corrupt_expected_text_is_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let cache_path = cache.path().canonicalize().unwrap().join("cache.sqlite");
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault.enable_local_document_cache(&cache_path).unwrap();
    fixture(&mut vault, true);
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let connection = rusqlite::Connection::open(&cache_path).unwrap();
    assert_eq!(
        connection
            .execute(
                "UPDATE document_index_rows SET text=?1 WHERE entry_id='first'",
                [b"corrupted".as_slice()]
            )
            .unwrap(),
        1
    );
    READS.with(|value| value.set(0));
    CANCEL_AT.with(|value| *value.borrow_mut() = None);
    vault.fault = Some(observe);
    for query_source in ["file:Only-name", "path:Notes", "[status:todo]", "tag:topic"] {
        let query = vault
            .start_rich_document_query(
                pin.clone(),
                spec(query_source),
                RichPageProfile::default(),
                |_| Ok(()),
            )
            .unwrap();
        let cursor = ready(&vault, &query);
        let page = vault
            .rich_document_page(&query, &cursor, |_| Ok(()))
            .unwrap();
        assert!(page.result.value.scan_complete && page.result.value.output_complete);
        let needs_metadata = query_source.starts_with('[') || query_source.starts_with("tag:");
        assert_eq!(
            page.result.value.complete, !needs_metadata,
            "{query_source}"
        );
        assert_eq!(
            page.result.value.coverage.query_coverage_complete,
            !needs_metadata
        );
        assert_eq!(
            page.result.value.coverage.unavailable_files,
            u32::from(needs_metadata)
        );
        assert_eq!(
            page.result.value.totals.files,
            if needs_metadata {
                SearchCount::AtLeast { value: 1 }
            } else {
                SearchCount::Exact { value: 1 }
            }
        );
        assert_eq!(page.result.value.work.source_bytes, 0);
        assert_eq!(READS.with(Cell::get), 0);
    }
    let query = vault
        .start_rich_document_query(pin, spec("cat"), RichPageProfile::default(), |_| Ok(()))
        .unwrap();
    let cursor = ready(&vault, &query);
    expected_error(
        vault.rich_document_page(&query, &cursor, |_| Ok(())),
        "rebuild_required",
    );
    assert_eq!(READS.with(Cell::get), 1);
    assert_eq!(
        std::fs::read(dir.path().join("Notes/Only-name.md")).unwrap(),
        FIRST
    );
}

#[test]
fn cancellation_before_commit_releases_drive_without_advancing_and_late_cancel_expires_query() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    fixture(&mut vault, false);
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let query = vault
        .start_rich_document_query(pin, spec("cat"), RichPageProfile::default(), |_| Ok(()))
        .unwrap();
    let cursor = ready(&vault, &query);
    let baseline = vault
        .rich_document_page(&query, &cursor, |_| Ok(()))
        .unwrap();
    vault.fault = Some(observe);
    for point in ["rich_search_after_read", "rich_search_before_commit"] {
        CANCELLED.with(|flag| flag.set(false));
        CANCEL_AT.with(|value| *value.borrow_mut() = Some(point));
        expected_error(
            vault.rich_document_page(&query, &cursor, cancellation),
            "cancelled",
        );
        CANCEL_AT.with(|value| *value.borrow_mut() = None);
        CANCELLED.with(|flag| flag.set(false));
        let retry = vault
            .rich_document_page(&query, &cursor, cancellation)
            .unwrap();
        assert_eq!(retry.result.value, baseline.result.value);
        assert!(retry.next == baseline.next);
    }
    CANCELLED.with(|flag| flag.set(true));
    expected_error(
        vault.rich_document_page(&query, &cursor, cancellation),
        "cancelled",
    );
    CANCELLED.with(|flag| flag.set(false));
    CANCEL_AT.with(|value| *value.borrow_mut() = Some("rich_search_committed"));
    expected_error(
        vault.rich_document_page(&query, &cursor, cancellation),
        "cancelled",
    );
    CANCEL_AT.with(|value| *value.borrow_mut() = None);
    CANCELLED.with(|flag| flag.set(false));
    expected_error(
        vault.rich_document_page(&query, &cursor, cancellation),
        "search_expired",
    );
    assert_eq!(vault.rich_owner().unwrap().retained_bytes(), 0);
}

#[test]
fn guards_bind_actual_owner_query_and_pin_and_drop_releases_busy_and_lifetime() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    fixture(&mut vault, false);
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let weak_pin = Arc::downgrade(&pin);
    let query = vault
        .start_rich_document_query(pin.clone(), spec("cat"), RichPageProfile::default(), |_| {
            Ok(())
        })
        .unwrap();
    let cursor = ready(&vault, &query);
    let other = vault
        .start_rich_document_query(
            pin.clone(),
            spec("file:Only-name"),
            RichPageProfile::default(),
            |_| Ok(()),
        )
        .unwrap();
    let other_cursor = ready(&vault, &other);
    expected_error(
        vault.rich_document_page(&query, &other_cursor, |_| Ok(())),
        "invalid_request",
    );
    let foreign = NativeVault::open_existing(dir.path()).unwrap();
    expected_error(
        foreign.prepare_rich_document_query(&query, 2_000_000, |_| Ok(())),
        "search_expired",
    );
    expected_error(
        foreign.start_rich_document_query(
            pin.clone(),
            spec("cat"),
            RichPageProfile::default(),
            |_| Ok(()),
        ),
        "snapshot_expired",
    );
    let drive = vault
        .rich_owner()
        .unwrap()
        .open_drive::<NativeDocumentError>(&cursor.value)
        .unwrap();
    expected_error(
        vault.rich_document_page(&query, &cursor, |_| Ok(())),
        "search_busy",
    );
    drop(drive);
    assert!(vault
        .rich_document_page(&query, &cursor, |_| Ok(()))
        .is_ok());
    drop(other);
    drop(pin);
    assert!(
        weak_pin.upgrade().is_some(),
        "the actual query guard owns its admitted pin"
    );
    vault.close_rich_document_query(query);
    assert!(
        weak_pin.upgrade().is_none(),
        "opaque cursors never keep the pin alive"
    );
    assert_eq!(vault.rich_owner().unwrap().retained_bytes(), 0);
    let fresh = Arc::new(vault.open_document_snapshot().unwrap());
    let replacement = vault
        .start_rich_document_query(fresh, spec("cat"), RichPageProfile::default(), |_| Ok(()))
        .unwrap();
    ready(&vault, &replacement);
    expected_error(
        vault.rich_document_page(&replacement, &cursor, |_| Ok(())),
        "invalid_request",
    );
}

thread_local! {
    static REBUILD: RefCell<Option<(&'static str, PathBuf, PathBuf)>> = const { RefCell::new(None) };
}
fn rebuild_at(point: &str) {
    let paths = REBUILD.with(|value| {
        let matches = value
            .borrow()
            .as_ref()
            .is_some_and(|entry| entry.0 == point);
        if matches {
            value.borrow_mut().take()
        } else {
            None
        }
    });
    if let Some((_, root, cache)) = paths {
        let mut other = NativeVault::open_existing(root).unwrap();
        other.enable_local_document_cache(cache).unwrap();
        other.rebuild_document_index().unwrap();
    }
}
#[test]
fn final_fences_reject_independent_rebuilds_and_owner_drop_expires_outstanding_drives() {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let cache_path = cache.path().canonicalize().unwrap().join("cache.sqlite");
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault.enable_local_document_cache(&cache_path).unwrap();
    fixture(&mut vault, false);
    for point in [
        "rich_search_after_read",
        "rich_search_before_commit",
        "rich_search_committed",
    ] {
        let pin = Arc::new(vault.open_document_snapshot().unwrap());
        let query = vault
            .start_rich_document_query(pin, spec("cat"), RichPageProfile::default(), |_| Ok(()))
            .unwrap();
        let cursor = ready(&vault, &query);
        REBUILD.with(|value| {
            *value.borrow_mut() = Some((point, dir.path().to_owned(), cache_path.clone()))
        });
        vault.fault = Some(rebuild_at);
        expected_error(
            vault.rich_document_page(&query, &cursor, |_| Ok(())),
            "snapshot_expired",
        );
        vault.fault = None;
        drop(query);
        build(&mut vault);
    }
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let query = vault
        .start_rich_document_query(pin, spec("cat"), RichPageProfile::default(), |_| Ok(()))
        .unwrap();
    let cursor = ready(&vault, &query);
    let mut drive = vault
        .rich_owner()
        .unwrap()
        .open_drive::<NativeDocumentError>(&cursor.value)
        .unwrap();
    drop(vault);
    assert!(matches!(
        drive.next_action(|_| Ok::<(), NativeDocumentError>(())),
        Err(RichSearchError::Expired)
    ));
    drop(drive);
    drop(query);
}

#[test]
fn compile_diagnostics_remain_typed_and_native_cancellation_is_constructible() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    fixture(&mut vault, false);
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let query_source = "content:/(?=cat)/";
    let expected = match CompiledSearchQuery::compile(
        query_source,
        SearchOptions::default(),
        SearchLimits::default(),
    ) {
        Err(error) => error,
        Ok(_) => panic!("unsupported regex compiled directly"),
    };
    match vault.start_rich_document_query(
        pin.clone(),
        spec(query_source),
        RichPageProfile::default(),
        |_| Ok(()),
    ) {
        Err(NativeDocumentError::SearchCompile(actual)) => {
            assert_eq!(actual, expected);
            assert_eq!(actual.code, SearchDiagnosticCode::UnsupportedRegex);
        }
        Err(error) => panic!("unexpected error {error}"),
        Ok(_) => panic!("unsupported regex compiled"),
    }
    expected_error(
        vault.start_rich_document_query(pin, spec("cat"), RichPageProfile::default(), |_| {
            Err(NativeDocumentError::QueryCancelled)
        }),
        "cancelled",
    );
    assert_eq!(vault.rich_owner().unwrap().retained_bytes(), 0);
}

#[test]
fn callbacks_can_retire_other_guards_and_reentrant_owner_work_is_busy() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    fixture(&mut vault, false);
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let mut victim = Some(
        vault
            .start_rich_document_query(pin.clone(), spec("cat"), RichPageProfile::default(), |_| {
                Ok(())
            })
            .unwrap(),
    );
    ready(&vault, victim.as_ref().unwrap());
    let mut retired_during_start = false;
    let active = vault
        .start_rich_document_query(pin.clone(), spec("cat"), RichPageProfile::default(), |_| {
            if victim.is_some()
                && matches!(
                    vault.rich_search_owner.try_lock(),
                    Err(TryLockError::WouldBlock)
                )
            {
                expected_error(
                    vault.prepare_rich_document_query(victim.as_ref().unwrap(), 1, |_| Ok(())),
                    "search_busy",
                );
                drop(victim.take());
                retired_during_start = true;
            }
            Ok(())
        })
        .unwrap();
    assert!(retired_during_start);
    ready(&vault, &active);
    // Four is a count ceiling; the unchanged byte reservation can admit fewer.
    // Retirement must restore the same capacity as an independent fresh owner.
    let mut live = vec![active];
    for _ in 1..zorid_index::MAX_SEARCH_QUERIES {
        match vault.start_rich_document_query(
            pin.clone(),
            spec("cat"),
            RichPageProfile::default(),
            |_| Ok(()),
        ) {
            Ok(query) => {
                ready(&vault, &query);
                live.push(query);
            }
            Err(NativeDocumentError::SearchResource(_)) => break,
            Err(error) => panic!("unexpected admission error: {error}"),
        }
    }
    let mut fresh = NativeVault::open(dir.path()).unwrap();
    fresh.initialize_document_index().unwrap();
    build(&mut fresh);
    let fresh_pin = Arc::new(fresh.open_document_snapshot().unwrap());
    let mut fresh_live = Vec::new();
    for _ in 0..zorid_index::MAX_SEARCH_QUERIES {
        match fresh.start_rich_document_query(
            fresh_pin.clone(),
            spec("cat"),
            RichPageProfile::default(),
            |_| Ok(()),
        ) {
            Ok(query) => {
                ready(&fresh, &query);
                fresh_live.push(query);
            }
            Err(NativeDocumentError::SearchResource(_)) => break,
            Err(error) => panic!("unexpected fresh admission error: {error}"),
        }
    }
    assert!(
        live.len() >= 2,
        "retired guard left no additional query capacity"
    );
    assert_eq!(live.len(), fresh_live.len());
    assert_eq!(
        vault.rich_owner().unwrap().retained_bytes(),
        fresh.rich_owner().unwrap().retained_bytes()
    );
    drop(live);
    drop(fresh_live);
    assert_eq!(vault.rich_owner().unwrap().retained_bytes(), 0);
    assert_eq!(fresh.rich_owner().unwrap().retained_bytes(), 0);
    drop(fresh_pin);
    drop(fresh);

    let mut victim = Some(
        vault
            .start_rich_document_query(pin.clone(), spec("cat"), RichPageProfile::default(), |_| {
                Ok(())
            })
            .unwrap(),
    );
    let victim_cursor = ready(&vault, victim.as_ref().unwrap());
    let active = vault
        .start_rich_document_query(pin, spec("cat"), RichPageProfile::default(), |_| Ok(()))
        .unwrap();
    let mut stale_drive = vault
        .rich_owner()
        .unwrap()
        .open_drive::<NativeDocumentError>(&victim_cursor.value)
        .unwrap();
    let mut retired_during_prepare = false;
    let preparation = vault
        .prepare_rich_document_query(&active, 2_000_000, |_| {
            if victim.is_some()
                && matches!(
                    vault.rich_search_owner.try_lock(),
                    Err(TryLockError::WouldBlock)
                )
            {
                drop(victim.take());
                assert!(matches!(
                    stale_drive.next_action(|_| Ok::<(), NativeDocumentError>(())),
                    Err(RichSearchError::Expired)
                ));
                retired_during_prepare = true;
            }
            Ok(())
        })
        .unwrap();
    assert!(matches!(preparation, NativeRichPreparation::Ready(_)));
    assert!(retired_during_prepare);
    drop(stale_drive);
    drop(active);
    assert_eq!(vault.rich_owner().unwrap().retained_bytes(), 0);
}

#[test]
fn callback_unwind_retires_captured_guard_and_rebuild_clears_poisoned_pure_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    fixture(&mut vault, false);
    let pin = Arc::new(vault.open_document_snapshot().unwrap());
    let mut victim = Some(
        vault
            .start_rich_document_query(pin.clone(), spec("cat"), RichPageProfile::default(), |_| {
                Ok(())
            })
            .unwrap(),
    );
    ready(&vault, victim.as_ref().unwrap());
    let active = vault
        .start_rich_document_query(pin, spec("cat"), RichPageProfile::default(), |_| Ok(()))
        .unwrap();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = vault.prepare_rich_document_query(&active, 2_000_000, |_| {
            if victim.is_some()
                && matches!(
                    vault.rich_search_owner.try_lock(),
                    Err(TryLockError::WouldBlock)
                )
            {
                let _retire_during_unwind = victim.take().unwrap();
                panic!("intentional query callback panic");
            }
            Ok(())
        });
    }));
    assert!(outcome.is_err());
    assert!(victim.is_none());
    drop(active); // Poison recovery still releases both retired registrations.
    {
        let owner = vault
            .rich_search_owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(owner.retained_bytes(), 0);
    }
    vault.rebuild_document_index().unwrap();
    build(&mut vault);
    let query = vault
        .start_rich_document_query(
            Arc::new(vault.open_document_snapshot().unwrap()),
            spec("cat"),
            RichPageProfile::default(),
            |_| Ok(()),
        )
        .unwrap();
    let cursor = ready(&vault, &query);
    assert!(
        vault
            .rich_document_page(&query, &cursor, |_| Ok(()))
            .unwrap()
            .result
            .value
            .complete
    );
    assert_eq!(
        std::fs::read(dir.path().join("Notes/Only-name.md")).unwrap(),
        FIRST
    );
}
