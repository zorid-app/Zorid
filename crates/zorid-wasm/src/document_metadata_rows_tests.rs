//! Hosted Rust checks for the thin WASM metadata adapter. Actual browser pin
//! registration/IDB/opaque-cursor admission belongs to the browser host tests.
use super::*;

fn generation(
    store: &str,
    epoch: &str,
    number: &str,
    changed: bool,
    limited: bool,
) -> WasmDocumentIndexGeneration {
    let versions = SemanticVersions::new(
        INDEX_SCHEMA_VERSION,
        document_extraction_version(),
        RESOLVER_VERSION,
        LITERAL_QUERY_VERSION,
    )
    .unwrap();
    let folder = if changed { "Archive" } else { "Notes" };
    let mut entries = vec![
        serde_json::json!({"id":"folder","path":folder,"kind":"folder","revision":if changed {"folder-r2"} else {"folder-r1"},"deleted":false}),
        serde_json::json!({"id":"one","path":format!("{folder}/One.md"),"kind":"file","revision":if changed {"one-r2"} else {"one-r1"},"deleted":false}),
        serde_json::json!({"id":"binary","path":"image.png","kind":"file","revision":"binary-r1","deleted":false}),
    ];
    entries.push(if changed {
        serde_json::json!({"id":"new","path":"New.md","kind":"file","revision":"new-r1","deleted":false})
    } else {
        serde_json::json!({"id":"plain","path":"plain.txt","kind":"file","revision":"plain-r1","deleted":false})
    });
    let header = serde_json::json!({
        "source":{"localStoreId":store,"watermark":number},"entries":entries,"expectedIndex":null,
        "nextIndex":{"localStoreId":store,"generationEpoch":epoch,"generation":number,"versions":versions}
    });
    let mut builder = WasmDocumentIndexBuilder::new(&header.to_string()).unwrap();
    if limited {
        builder.add_excluded("one", Exclusion::SourceLimit).unwrap();
    } else {
        builder.add_text("one", if changed { b"---\nvalue: 2\n---\n# Updated\n[[New]]\n" } else { b"---\nvalue: 1\nobject: {z: 1, a: 2}\n---\n# Original \"heading\" \xf0\x9f\x98\x80\n[[plain]]\n" }).unwrap();
    }
    builder.add_binary("binary").unwrap();
    if changed {
        builder.add_text("new", b"# New\n").unwrap();
    } else {
        builder.add_text("plain", b"plain payload\n").unwrap();
    }
    builder.finish().unwrap()
}
fn page(scan: &mut WasmDocumentMetadataRowsScan, token: &str) -> String {
    scan.page_json_checked(token, MAX_JSON, &mut || true)
        .unwrap()
}
fn value(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap()
}

#[test]
fn reset_streams_existing_file_schema_and_structural_folders_without_source_reads() {
    let generation = generation("store", "epoch", "1", false, false);
    let mut scan = WasmDocumentMetadataRowsScan::create(&generation, None, 2.0).unwrap();
    drop(generation); // Retained data survives; this is deliberately not admission.
    let mut rows = Vec::new();
    loop {
        let raw = page(&mut scan, "opaque-next");
        let result = value(&raw);
        let report = &result["result"];
        let p = &report["value"];
        assert_eq!(report["snapshot"], p["snapshot"]);
        assert_eq!(report["coverageComplete"], true);
        assert_eq!(p["coverageComplete"], true);
        assert_eq!(p["next"], serde_json::Value::Null);
        assert_eq!(p["mode"], "reset");
        assert!(p["from"].is_null());
        assert!(p["removedEntryIds"].as_array().unwrap().is_empty());
        assert!(p["rows"].as_array().unwrap().len() <= 2);
        rows.extend(p["rows"].as_array().unwrap().iter().cloned());
        if p["scanComplete"] == true {
            assert!(result["cursor"].is_null());
            assert_eq!(p["complete"], true);
            break;
        }
        assert_eq!(result["cursor"], "opaque-next");
    }
    assert_eq!(rows.len(), 4);
    let folder = rows.iter().find(|r| r["kind"] == "folder").unwrap();
    assert_eq!(folder["entry"]["id"], "folder");
    assert!(folder.get("value").is_none());
    let plain = rows
        .iter()
        .find(|r| r["value"]["entry"]["id"] == "plain")
        .unwrap();
    assert!(plain["value"]["metadata"].is_null());
    assert!(plain["value"]["exclusion"].is_null());
    let markdown = rows
        .iter()
        .find(|r| r["value"]["entry"]["id"] == "one")
        .unwrap();
    assert_eq!(
        markdown["value"]["metadata"]["headings"][0]["text"],
        "Original \"heading\" 😀"
    );
    assert!(rows
        .iter()
        .any(|r| r["value"]["entry"]["id"] == "binary" && !r["value"]["exclusion"].is_null()));
}

#[test]
fn delta_preserves_actual_baseline_identity_upserts_and_removals() {
    let baseline = generation("store", "epoch", "1", false, false);
    let destination = generation("store", "epoch", "2", true, false);
    let mut scan =
        WasmDocumentMetadataRowsScan::create(&destination, Some(&baseline), 32.0).unwrap();
    assert!(scan.uses_baseline());
    let result = value(&page(&mut scan, "unused-terminal-token"));
    let p = &result["result"]["value"];
    assert_eq!(p["mode"], "delta");
    assert_eq!(p["from"]["generation"], "1");
    assert_eq!(p["snapshot"]["generation"], "2");
    assert_eq!(p["removedEntryIds"], serde_json::json!(["plain"]));
    assert_eq!(p["rows"].as_array().unwrap().len(), 3);
    assert!(p["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "folder" && r["entry"]["path"] == "Archive"));
    assert!(
        p["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["value"]["entry"]["id"] == "one"
                && r["value"]["entry"]["revision"] == "one-r2")
    );
}

#[test]
fn incompatible_history_selects_reset_but_foreign_store_rejects() {
    let baseline = generation("store", "old-epoch", "1", false, false);
    let destination = generation("store", "new-epoch", "2", true, false);
    let mut scan =
        WasmDocumentMetadataRowsScan::create(&destination, Some(&baseline), 32.0).unwrap();
    assert!(!scan.uses_baseline());
    assert_eq!(
        value(&page(&mut scan, "next"))["result"]["value"]["mode"],
        "reset"
    );
    let foreign = generation("another-store", "epoch", "1", false, false);
    assert!(matches!(
        WasmDocumentMetadataRowsScan::create(&destination, Some(&foreign), 32.0),
        Err(MetadataRowsBindingError::Contract(
            MetadataRowsError::ForeignScope
        ))
    ));
}

#[test]
fn retained_checkpoint_forks_retry_exact_bytes_and_have_private_constant_size_identity() {
    let generation = generation("store", "epoch", "1", false, false);
    let original = WasmDocumentMetadataRowsScan::create(&generation, None, 1.0).unwrap();
    let mut first = original.fork_checked().unwrap();
    let mut retry = original.fork_checked().unwrap();
    assert!(first.same_checkpoint(&original));
    let expected = page(&mut first, "next-opaque");
    assert_eq!(expected, page(&mut retry, "next-opaque"));
    assert!(first.same_checkpoint(&retry));
    assert!(first.is_next_checkpoint_of(&original));
    assert!(!first.same_checkpoint(&original));
    let unrelated = WasmDocumentMetadataRowsScan::create(&generation, None, 1.0).unwrap();
    assert!(!original.same_checkpoint(&unrelated));
    assert!(!first.is_next_checkpoint_of(&unrelated));
    assert!(Arc::strong_count(&generation.generation) >= 5);
}

#[test]
fn complete_envelope_cap_fails_before_advancing_and_retry_is_identical() {
    let generation = generation("store", "epoch", "1", false, false);
    let original = WasmDocumentMetadataRowsScan::create(&generation, None, 1.0).unwrap();
    let mut expected = original.fork_checked().unwrap();
    let raw = page(&mut expected, "next-opaque");
    let mut candidate = original.fork_checked().unwrap();
    assert_eq!(
        candidate.page_json_checked("next-opaque", raw.len() - 1, &mut || true),
        Err(MetadataRowsBindingError::OutputLimit)
    );
    assert!(candidate.same_checkpoint(&original));
    assert_eq!(page(&mut candidate, "next-opaque"), raw);
}

#[test]
fn cancellation_after_encoding_does_not_advance_a_checkpoint() {
    let generation = generation("store", "epoch", "1", false, false);
    let original = WasmDocumentMetadataRowsScan::create(&generation, None, 1.0).unwrap();
    let mut observed = original.fork_checked().unwrap();
    let mut calls = 0usize;
    let raw = observed
        .page_json_checked("next", MAX_JSON, &mut || {
            calls += 1;
            true
        })
        .unwrap();
    assert!(calls > 3);
    let mut candidate = original.fork_checked().unwrap();
    let mut cancelled_calls = 0usize;
    assert_eq!(
        candidate.page_json_checked("next", MAX_JSON, &mut || {
            cancelled_calls += 1;
            cancelled_calls < calls
        }),
        Err(MetadataRowsBindingError::Cancelled)
    );
    assert!(candidate.same_checkpoint(&original));
    assert_eq!(page(&mut candidate, "next"), raw);
}

#[test]
fn shared_retirement_expires_all_forks_without_fabricating_pin_authority() {
    let generation = generation("store", "epoch", "1", false, false);
    let original = WasmDocumentMetadataRowsScan::create(&generation, None, 1.0).unwrap();
    let mut fork = original.fork_checked().unwrap();
    original.retire();
    assert!(matches!(
        original.fork_checked(),
        Err(MetadataRowsBindingError::Retired)
    ));
    assert_eq!(
        fork.page_json_checked("next", MAX_JSON, &mut || true),
        Err(MetadataRowsBindingError::Retired)
    );
}

#[test]
fn checked_profile_and_counter_rejections_do_not_mutate_checkpoint() {
    for value in [0.0, 33.0, 1.5, f64::NAN, f64::INFINITY] {
        assert!(metadata_rows_limit(value).is_err());
    }
    let generation = generation("store", "epoch", "1", false, false);
    let mut scan = WasmDocumentMetadataRowsScan::create(&generation, None, 1.0).unwrap();
    for cursor in [String::new(), "x".repeat(257)] {
        assert_eq!(
            scan.page_json_checked(&cursor, MAX_JSON, &mut || true),
            Err(MetadataRowsBindingError::InvalidCursor)
        );
        assert_eq!(scan.ordinal, 0);
    }
    scan.ordinal = u64::MAX;
    assert_eq!(
        scan.page_json_checked("next", MAX_JSON, &mut || true),
        Err(MetadataRowsBindingError::CounterLimit)
    );
    assert_eq!(scan.ordinal, u64::MAX);
}

#[test]
fn incomplete_coverage_is_cached_in_both_reports_and_not_confused_with_scan_completion() {
    let generation = generation("store", "epoch", "1", false, true);
    let mut scan = WasmDocumentMetadataRowsScan::create(&generation, None, 32.0).unwrap();
    let result = value(&page(&mut scan, "terminal"));
    assert_eq!(result["result"]["coverageComplete"], false);
    assert_eq!(result["result"]["value"]["coverageComplete"], false);
    assert_eq!(result["result"]["value"]["scanComplete"], true);
    assert_eq!(result["result"]["value"]["complete"], false);
    assert!(result["cursor"].is_null());
}

#[test]
fn bounded_writer_never_grows_for_a_rejected_chunk_and_does_not_retry_cancellation() {
    let mut admitted = || true;
    let mut writer = MetadataRowsWriter {
        bytes: Vec::new(),
        limit: 17,
        check: &mut admitted,
        failure: None,
    };
    writer.write_all(b"small").unwrap();
    let capacity = writer.bytes.capacity();
    assert!(writer.write_all(&[0; 32]).is_err());
    assert_eq!(writer.bytes, b"small");
    assert_eq!(writer.bytes.capacity(), capacity);
    assert!(capacity <= 17);
    let mut checks = 0;
    let mut denied = || {
        checks += 1;
        false
    };
    let mut writer = MetadataRowsWriter {
        bytes: Vec::new(),
        limit: MAX_JSON,
        check: &mut denied,
        failure: None,
    };
    assert!(writer.write_all(b"never allocated").is_err());
    assert!(writer.bytes.is_empty());
    assert_eq!(writer.bytes.capacity(), 0);
    drop(writer);
    assert_eq!(checks, 1);
}
