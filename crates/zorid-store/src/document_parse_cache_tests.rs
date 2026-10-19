use super::*;
use crate::{
    document_index::{DocumentIndexError, DocumentIndexProgress},
    Store,
};
use std::path::PathBuf;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_index::{
    extract_content, ContentExtractionOutcome, ExtractionDomain, MetadataRequest,
    MAX_PARSE_CACHE_BYTES, MAX_PARSE_CACHE_ROWS,
};

const SOURCE: &str =
    "\u{feff}---\r\ntags: [cache]\r\n---\r\n# Title 🦀\r\n- [ ] task [[Other]]\r\n";
fn create(id: &str, path: &str, source: &str) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(format!("create-{id}")).unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new(id).unwrap(),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(source.as_bytes().to_vec()),
        },
    }
}
fn fixture(source: &str) -> (tempfile::TempDir, Store, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let authority = root.join("vault.sqlite");
    let cache = root.join("cache.sqlite");
    let mut store = Store::open(&authority).unwrap();
    store.apply(&create("a", "a.md", source)).unwrap();
    store.enable_document_cache(&cache).unwrap();
    store.initialize_document_index().unwrap();
    (dir, store, authority, cache)
}
fn build(store: &mut Store) -> DocumentIndexProgress {
    let stage = store.begin_document_index().unwrap();
    let progress = store.pump_document_index(&stage).unwrap();
    assert!(progress.ready, "tiny fixture must finish in one pump");
    store.publish_document_index(&stage).unwrap();
    progress
}
fn key_witness(
    store: &Store,
    source: &str,
    id: &str,
    mode: ExtractionMode,
) -> (ContentExtractionKey, EntryWitness) {
    let manifest = store
        .capture_document_manifest()
        .unwrap()
        .manifest()
        .unwrap();
    let witness = manifest.witness(&EntryId::new(id).unwrap()).unwrap();
    let scope = ExtractionScope::new(
        ExtractionDomain::DocumentIndex,
        witness.source().local_store_id().clone(),
    );
    (
        ContentExtractionKey::for_source(scope, mode, source).unwrap(),
        witness,
    )
}
fn extraction(key: &ContentExtractionKey, source: &str) -> ContentExtractionResult {
    let ContentExtractionOutcome::Extracted(result) =
        extract_content(key.scope().clone(), key.mode(), source).unwrap()
    else {
        panic!("eligible source")
    };
    result
}
fn count(progress: &DocumentIndexProgress) -> usize {
    let c = &progress.parse_cache;
    c.hits + c.misses + c.unavailable + c.corrupt + c.unsupported
}
type EntryRow = (
    String,
    String,
    Option<Vec<u8>>,
    Option<String>,
    Option<String>,
);
fn authority(store: &Store) -> (Vec<EntryRow>, Vec<(String, String)>) {
    let entries = store
        .connection
        .prepare("SELECT id,state,content,content_ref,content_digest FROM entries ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let receipts = store
        .connection
        .prepare("SELECT request,result FROM operations ORDER BY sequence")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    (entries, receipts)
}

fn assert_current(store: &Store, id: &str, source: &str, mode: ExtractionMode) {
    let pin = store.open_document_snapshot().unwrap();
    let record = pin.generation().record(&EntryId::new(id).unwrap()).unwrap();
    let witness = record.witness().clone();
    let expected = IndexRecord::text(
        witness.clone(),
        &MetadataRequest {
            entry_id: witness.entry().id.clone(),
            content_revision: witness.entry().revision.clone(),
            source: source.into(),
        },
        mode == ExtractionMode::Markdown,
    )
    .unwrap();
    assert_eq!(record, &expected);
    record.check_text(source.as_bytes()).unwrap();
    store.close_document_snapshot(pin);
}
#[test]
fn restart_generation_rebuild_and_new_identity_rebind_exact_current_metadata() {
    let (_dir, mut store, db, cache) = fixture(SOURCE);
    let cold = build(&mut store);
    assert_eq!(cold.parse_cache.misses, 1);
    let before = authority(&store);
    drop(store);
    let mut store = Store::open_existing_no_follow(&db).unwrap();
    store.enable_document_cache(&cache).unwrap();
    store.rebuild_document_index().unwrap();
    let warm = build(&mut store);
    assert_eq!(
        (
            warm.reused_documents,
            warm.parse_cache.hits,
            warm.parse_cache.misses
        ),
        (0, 1, 0)
    );
    assert_current(&store, "a", SOURCE, ExtractionMode::Markdown);
    assert_eq!(authority(&store), before);
    store.apply(&create("b", "b.md", SOURCE)).unwrap();
    let progress = build(&mut store);
    assert_eq!(
        (
            progress.reused_documents,
            progress.parse_cache.hits,
            count(&progress)
        ),
        (1, 1, 1)
    );
    assert_current(&store, "b", SOURCE, ExtractionMode::Markdown);
    let old = store
        .read_metadata(&EntryId::new("b").unwrap())
        .unwrap()
        .unwrap()
        .state;
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("rename").unwrap(),
            mutation: Mutation::Move {
                id: old.id,
                expected: old.revision,
                path: VaultPath::new("renamed.md").unwrap(),
            },
        })
        .unwrap();
    let renamed = build(&mut store);
    assert_eq!((renamed.reused_documents, renamed.parse_cache.hits), (1, 1));
    assert_current(&store, "b", SOURCE, ExtractionMode::Markdown);
}
#[test]
fn byte_mode_and_store_scope_do_not_reuse_the_wrong_facts() {
    let (_dir, mut store, _db, _cache) = fixture(SOURCE);
    build(&mut store);
    let old = store
        .read_metadata(&EntryId::new("a").unwrap())
        .unwrap()
        .unwrap()
        .state;
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("mode").unwrap(),
            mutation: Mutation::Move {
                id: old.id,
                expected: old.revision,
                path: VaultPath::new("a.txt").unwrap(),
            },
        })
        .unwrap();
    let mode = build(&mut store);
    assert_eq!((mode.parse_cache.misses, mode.parse_cache.hits), (1, 0));
    assert_current(&store, "a", SOURCE, ExtractionMode::PlainText);
    let state = store
        .read_metadata(&EntryId::new("a").unwrap())
        .unwrap()
        .unwrap()
        .state;
    let changed = format!("{SOURCE}changed\n");
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("write").unwrap(),
            mutation: Mutation::Write {
                id: state.id,
                expected: state.revision,
                content: changed.as_bytes().to_vec(),
            },
        })
        .unwrap();
    assert_eq!(build(&mut store).parse_cache.misses, 1);
    let (_other, mut other, _, _) = fixture(SOURCE);
    assert_eq!(build(&mut other).parse_cache.misses, 1);
    let (other_key, other_witness) = key_witness(&other, SOURCE, "a", ExtractionMode::Markdown);
    assert!(matches!(
        lookup(
            &store.document_cache,
            &other_key,
            other_witness,
            ExtractionMode::Markdown
        ),
        (ParseCacheOutcome::Corrupt, None)
    ));
}
#[test]
fn unchanged_generation_reuse_is_separate_and_pump_preflight_has_no_outcome() {
    let (_dir, mut store, _, _) = fixture(SOURCE);
    for n in 1..33 {
        store
            .apply(&create(&format!("n-{n}"), &format!("n-{n}.md"), SOURCE))
            .unwrap();
    }
    let stage = store.begin_document_index().unwrap();
    let first = store.pump_document_index(&stage).unwrap();
    assert!(!first.ready);
    assert_eq!(first.prepared_documents, 32);
    assert_eq!(count(&first), 32);
    let last = store.pump_document_index(&stage).unwrap();
    assert!(last.ready);
    assert_eq!(count(&last), 1);
    store.publish_document_index(&stage).unwrap();
    let stage = store.begin_document_index().unwrap();
    let first = store.pump_document_index(&stage).unwrap();
    assert_eq!((first.reused_documents, count(&first)), (32, 0));
    let last = store.pump_document_index(&stage).unwrap();
    assert_eq!((last.reused_documents, count(&last)), (1, 0));
}
#[test]
fn value_corruption_and_unsupported_version_recompute_with_disjoint_outcomes() {
    for unsupported in [false, true] {
        let (_dir, mut store, _, _) = fixture(SOURCE);
        build(&mut store);
        store.rebuild_document_index().unwrap();
        let (key, _) = key_witness(&store, SOURCE, "a", ExtractionMode::Markdown);
        let locator = key.storage_key().unwrap();
        let raw: Vec<u8> = store
            .document_cache
            .connection
            .query_row(
                "SELECT record FROM document_parse_cache_rows WHERE storage_key=?1",
                [&locator],
                |r| r.get(0),
            )
            .unwrap();
        let mut json: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        if unsupported {
            json["key"]["factsEncodingVersion"] = serde_json::json!(2);
        } else {
            assert_eq!(json["facts"]["facts"]["headings"][0]["text"], "Title 🦀");
            json["facts"]["facts"]["headings"][0]["text"] = serde_json::json!("Other 🦀");
        }
        let raw = serde_json::to_vec(&json).unwrap();
        store.document_cache.connection.execute("UPDATE document_parse_cache_rows SET record=?1,payload_bytes=?2 WHERE storage_key=?3",params![raw,raw.len()as i64,&locator]).unwrap();
        // Canonical Value ordering can change encoded length; maintain only the
        // accounting fixture, never repair the intentionally stale facts hash.
        store
            .document_cache
            .connection
            .execute(
                "UPDATE document_parse_cache_usage SET record=?1",
                [encode_usage(
                    key.scope(),
                    ParseCacheUsage {
                        rows: 1,
                        bytes: raw.len(),
                    },
                )
                .unwrap()],
            )
            .unwrap();
        let before = authority(&store);
        let progress = build(&mut store);
        assert_eq!(count(&progress), 1);
        assert_eq!(progress.parse_cache.misses, 0);
        assert_eq!(
            if unsupported {
                progress.parse_cache.unsupported
            } else {
                progress.parse_cache.corrupt
            },
            1
        );
        assert_current(&store, "a", SOURCE, ExtractionMode::Markdown);
        assert_eq!(authority(&store), before);
    }
}
#[test]
fn oversize_partial_and_corrupt_usage_are_optional_without_raw_allocation() {
    for tamper in ["oversize", "partial", "usage"] {
        let (_dir, mut store, _, _) = fixture(SOURCE);
        build(&mut store);
        store.rebuild_document_index().unwrap();
        match tamper {
            "oversize" => {
                store
                    .document_cache
                    .connection
                    .execute(
                        "UPDATE document_parse_cache_rows SET record=zeroblob(?1),payload_bytes=?1",
                        [(MAX_PARSE_CACHE_ROW_BYTES + 1) as i64],
                    )
                    .unwrap();
            }
            "partial" => {
                store
                    .document_cache
                    .connection
                    .execute("DROP TABLE document_parse_cache_usage", [])
                    .unwrap();
            }
            "usage" => {
                store.document_cache.connection.execute("UPDATE document_parse_cache_usage SET record=json_set(record,'$.usage.rows',2)",[]).unwrap();
            }
            _ => unreachable!(),
        }
        let before = authority(&store);
        let progress = build(&mut store);
        assert_eq!(
            (
                progress.parse_cache.corrupt,
                progress.parse_cache.misses,
                count(&progress)
            ),
            (1, 0, 1)
        );
        assert_current(&store, "a", SOURCE, ExtractionMode::Markdown);
        assert_eq!(authority(&store), before);
    }
}
#[test]
fn full_disposable_file_removal_is_cold_and_preserves_authority() {
    let (_dir, mut store, db, cache) = fixture(SOURCE);
    build(&mut store);
    let before = authority(&store);
    drop(store);
    std::fs::remove_file(&cache).unwrap();
    let mut store = Store::open_existing_no_follow(&db).unwrap();
    store.enable_document_cache(&cache).unwrap();
    store.initialize_document_index().unwrap();
    assert_eq!(build(&mut store).parse_cache.misses, 1);
    assert_eq!(authority(&store), before);
}
#[test]
fn cache_contention_is_short_restores_timeout_and_never_reserves_authority() {
    let (_dir, mut store, _, cache) = fixture(SOURCE);
    let (key, witness) = key_witness(&store, SOURCE, "a", ExtractionMode::Markdown);
    let fact = prepare(&extraction(&key, SOURCE)).unwrap();
    store
        .document_cache
        .connection
        .busy_timeout(Duration::from_millis(517))
        .unwrap();
    let blocker = Connection::open(&cache).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    write(&store.document_cache, fact);
    let timeout: i64 = store
        .document_cache
        .connection
        .pragma_query_value(None, "busy_timeout", |r| r.get(0))
        .unwrap();
    assert_eq!(timeout, 517);
    store
        .connection
        .busy_timeout(Duration::from_millis(50))
        .unwrap();
    store.apply(&create("save", "save.md", "saved")).unwrap();
    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        lookup(
            &store.document_cache,
            &key,
            witness,
            ExtractionMode::Markdown
        )
        .0,
        ParseCacheOutcome::Miss
    );
}
#[test]
fn cache_facts_never_authorize_stale_publication_or_mask_source_corruption() {
    let (_dir, mut store, _, _) = fixture(SOURCE);
    let stage = store.begin_document_index().unwrap();
    let (key, witness) = key_witness(&store, SOURCE, "a", ExtractionMode::Markdown);
    let fact = prepare(&extraction(&key, SOURCE)).unwrap();
    let current = witness.entry().clone();
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("advance").unwrap(),
            mutation: Mutation::Write {
                id: current.id,
                expected: current.revision,
                content: b"new source".to_vec(),
            },
        })
        .unwrap();
    write(&store.document_cache, fact);
    assert!(matches!(
        store.pump_document_index(&stage),
        Err(DocumentIndexError::Contract(IndexError::StaleSource))
    ));
    assert!(matches!(
        lookup(
            &store.document_cache,
            &key,
            witness,
            ExtractionMode::Markdown
        ),
        (ParseCacheOutcome::Hit, Some(_))
    ));
    let stage = store.begin_document_index().unwrap();
    store
        .connection
        .execute("UPDATE entries SET content_digest=NULL", [])
        .unwrap();
    assert!(matches!(
        store.pump_document_index(&stage),
        Err(DocumentIndexError::Authority(crate::StoreError::Corrupt(_)))
    ));
}
#[test]
fn parse_schema_is_cache_only_and_foreign_authority_open_never_mutates_it() {
    let (_dir, mut store, db, _) = fixture(SOURCE);
    build(&mut store);
    let names: i64 = store
        .connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name GLOB 'document_parse_cache_*'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(names, 0);
    drop(store);
    let connection = Connection::open(&db).unwrap();
    connection.execute_batch(SCHEMA[0].1).unwrap();
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
    drop(connection);
    let before = std::fs::read(&db).unwrap();
    assert!(Store::open_existing_no_follow(&db).is_err());
    assert_eq!(std::fs::read(&db).unwrap(), before);
}
#[test]
fn fifo_replacement_and_bounded_eviction_use_only_owned_fact_rows() {
    for full_bytes in [false, true] {
        let source = "# title\n".repeat(400);
        let (_dir, store, _, _) = fixture(&source);
        let (key, witness) = key_witness(&store, &source, "a", ExtractionMode::Markdown);
        let result = extraction(&key, &source);
        let fact = prepare(&result).unwrap();
        let incoming = fact.payload.len();
        write(&store.document_cache, fact);
        let bytes = if full_bytes {
            MAX_PARSE_CACHE_BYTES
        } else {
            MAX_PARSE_CACHE_ROWS
        };
        let each = if full_bytes {
            MAX_PARSE_CACHE_BYTES / MAX_PARSE_CACHE_ROWS
        } else {
            1
        };
        let last = bytes - each * (MAX_PARSE_CACHE_ROWS - 1);
        if full_bytes {
            assert!(incoming > 32 * each);
        }
        let tx = store
            .document_cache
            .connection
            .unchecked_transaction()
            .unwrap();
        tx.execute("DELETE FROM document_parse_cache_rows", [])
            .unwrap();
        tx.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?1) INSERT INTO document_parse_cache_rows(storage_key,payload_bytes,record) SELECT printf('%064x',x),CASE WHEN x=?1 THEN ?3 ELSE ?2 END,zeroblob(CASE WHEN x=?1 THEN ?3 ELSE ?2 END) FROM n",params![MAX_PARSE_CACHE_ROWS as i64,each as i64,last as i64]).unwrap();
        tx.execute(
            "UPDATE document_parse_cache_usage SET record=?1",
            [encode_usage(
                key.scope(),
                ParseCacheUsage {
                    rows: MAX_PARSE_CACHE_ROWS,
                    bytes,
                },
            )
            .unwrap()],
        )
        .unwrap();
        tx.commit().unwrap();
        if !full_bytes {
            let connection = &store.document_cache.connection;
            let oldest: i64 = connection
                .query_row(
                    "SELECT min(ordinal) FROM document_parse_cache_rows",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let usage_before = read_usage(connection, key.scope()).unwrap();
            for expression in [
                "CAST(zeroblob(1048577) AS TEXT)",
                "CAST(printf('%064x',1) AS BLOB)",
            ] {
                connection.execute(&format!("UPDATE document_parse_cache_rows SET storage_key={expression} WHERE ordinal=?1"), [oldest]).unwrap();
                let shape_before: (String,i64) = connection.query_row("SELECT typeof(storage_key),length(CAST(storage_key AS BLOB)) FROM document_parse_cache_rows WHERE ordinal=?1", [oldest], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                write(&store.document_cache, prepare(&result).unwrap());
                assert_eq!(read_usage(connection, key.scope()).unwrap(), usage_before);
                let shape_after: (String,i64) = connection.query_row("SELECT typeof(storage_key),length(CAST(storage_key AS BLOB)) FROM document_parse_cache_rows WHERE ordinal=?1", [oldest], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                assert_eq!(shape_after, shape_before);
                let (rows, incoming_present): (i64,bool) = connection.query_row("SELECT count(*),EXISTS(SELECT 1 FROM document_parse_cache_rows WHERE storage_key=?1) FROM document_parse_cache_rows", [key.storage_key().unwrap()], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                assert_eq!(rows, MAX_PARSE_CACHE_ROWS as i64);
                assert!(!incoming_present);
                connection.execute("UPDATE document_parse_cache_rows SET storage_key=printf('%064x',1) WHERE ordinal=?1", [oldest]).unwrap();
            }
        }
        let before = authority(&store);
        write(&store.document_cache, prepare(&result).unwrap());
        let connection = &store.document_cache.connection;
        let usage = read_usage(connection, key.scope()).unwrap();
        let present: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM document_parse_cache_rows WHERE storage_key=?1)",
                [key.storage_key().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        if full_bytes {
            assert!(!present);
            assert_eq!(
                usage,
                ParseCacheUsage {
                    rows: MAX_PARSE_CACHE_ROWS,
                    bytes
                }
            );
            let oldest:i64=connection.query_row("SELECT count(*) FROM document_parse_cache_rows WHERE storage_key<=printf('%064x',33)",[],|r|r.get(0)).unwrap();
            assert_eq!(oldest, 33);
        } else {
            assert!(present);
            assert_eq!(usage.rows, MAX_PARSE_CACHE_ROWS);
            assert_eq!(usage.bytes, bytes - 1 + incoming);
            let first:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM document_parse_cache_rows WHERE storage_key=printf('%064x',1))",[],|r|r.get(0)).unwrap();
            assert!(!first);
            let ordinal: i64 = connection
                .query_row(
                    "SELECT ordinal FROM document_parse_cache_rows WHERE storage_key=?1",
                    [key.storage_key().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                lookup(
                    &store.document_cache,
                    &key,
                    witness,
                    ExtractionMode::Markdown
                )
                .0,
                ParseCacheOutcome::Hit
            );
            write(&store.document_cache, prepare(&result).unwrap());
            let after: i64 = connection
                .query_row(
                    "SELECT ordinal FROM document_parse_cache_rows WHERE storage_key=?1",
                    [key.storage_key().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(ordinal, after);
            assert_eq!(read_usage(connection, key.scope()).unwrap(), usage);
        }
        let actual: (i64, i64) = connection
            .query_row(
                "SELECT count(*),sum(length(CAST(record AS BLOB))) FROM document_parse_cache_rows",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(actual, (usage.rows as i64, usage.bytes as i64));
        assert_eq!(authority(&store), before);
        let plan:Vec<String>=connection.prepare("EXPLAIN QUERY PLAN SELECT ordinal,payload_bytes,length(CAST(record AS BLOB)),CASE WHEN typeof(storage_key)='text' AND length(CAST(storage_key AS BLOB))=64 THEN storage_key NOT GLOB '*[^0-9a-f]*' ELSE 0 END FROM document_parse_cache_rows NOT INDEXED WHERE storage_key<>?1 ORDER BY ordinal LIMIT 1").unwrap().query_map([key.storage_key().unwrap()],|r|r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert!(plan.iter().all(|p| !p.contains("TEMP B-TREE")), "{plan:?}");
    }
}

#[test]
fn supported_oversized_facts_skip_only_persistence_and_nul_has_no_lookup() {
    let source = format!("# {}", "x".repeat(MAX_PARSE_CACHE_ROW_BYTES));
    let (_dir, mut store, _, _) = fixture(&source);
    let (key, _) = key_witness(&store, &source, "a", ExtractionMode::Markdown);
    let result = extraction(&key, &source);
    assert!(result.encoded_size().unwrap() > MAX_PARSE_CACHE_ROW_BYTES);
    assert!(prepare(&result).is_none());
    let before = authority(&store);
    assert_eq!(build(&mut store).parse_cache.misses, 1);
    assert_current(&store, "a", &source, ExtractionMode::Markdown);
    assert_eq!(
        schema_count(&store.document_cache.connection, key.scope()).unwrap(),
        0
    );
    assert_eq!(authority(&store), before);
    let (_dir, mut store, _, _) = fixture("body\0binary");
    let progress = build(&mut store);
    assert_eq!(count(&progress), 0);
    let pin = store.open_document_snapshot().unwrap();
    assert_eq!(
        pin.generation()
            .record(&EntryId::new("a").unwrap())
            .unwrap()
            .exclusion(),
        Some(&zorid_index::Exclusion::Binary)
    );
}

#[test]
fn unavailable_cache_read_is_not_an_authority_error_and_timeout_is_restored() {
    let (_dir, mut store, _, cache) = fixture(SOURCE);
    let (key, witness) = key_witness(&store, SOURCE, "a", ExtractionMode::Markdown);
    // Rollback-journal EXCLUSIVE provides deterministic read contention; this
    // is only an owned cache fixture, not a product configuration change.
    store
        .document_cache
        .connection
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
    store
        .document_cache
        .connection
        .busy_timeout(Duration::from_millis(519))
        .unwrap();
    let blocker = Connection::open(cache).unwrap();
    blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(matches!(
        lookup(
            &store.document_cache,
            &key,
            witness,
            ExtractionMode::Markdown
        ),
        (ParseCacheOutcome::Unavailable, None)
    ));
    let timeout: i64 = store
        .document_cache
        .connection
        .pragma_query_value(None, "busy_timeout", |row| row.get(0))
        .unwrap();
    assert_eq!(timeout, 519);
    store
        .apply(&create("ordinary-save", "saved.md", "saved"))
        .unwrap();
    blocker.execute_batch("ROLLBACK").unwrap();
}
