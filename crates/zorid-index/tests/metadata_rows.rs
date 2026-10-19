use std::collections::BTreeMap;
use std::sync::Arc;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::{DocumentMetadata, MetadataRequest, PropertyValue};
use zorid_index::*;

#[derive(Clone)]
enum Body {
    Text(String, bool),
    Excluded(Exclusion),
    Folder,
}
#[derive(Clone)]
struct Spec {
    entry: EntryState,
    body: Body,
}
impl Spec {
    fn text(id: &str, path: &str, text: &str) -> Self {
        Self {
            entry: entry(id, path, EntryKind::File),
            body: Body::Text(text.into(), true),
        }
    }
    fn folder(id: &str, path: &str) -> Self {
        Self {
            entry: entry(id, path, EntryKind::Folder),
            body: Body::Folder,
        }
    }
    fn excluded(id: &str, path: &str, reason: Exclusion) -> Self {
        Self {
            entry: entry(id, path, EntryKind::File),
            body: Body::Excluded(reason),
        }
    }
}
fn entry(id: &str, path: &str, kind: EntryKind) -> EntryState {
    EntryState {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: Revision::new("revision-1").unwrap(),
        deleted: false,
    }
}
fn build(
    mark: &str,
    epoch: &str,
    specs: &[Spec],
    mut edit: impl FnMut(&str, &mut DocumentMetadata),
) -> Arc<Generation> {
    build_store("local-store", mark, epoch, specs, &mut edit)
}
fn build_store(
    store: &str,
    mark: &str,
    epoch: &str,
    specs: &[Spec],
    edit: &mut impl FnMut(&str, &mut DocumentMetadata),
) -> Arc<Generation> {
    let source = SourceSnapshotId::new(
        OperationId::new(store).unwrap(),
        SourceWatermark::new(mark).unwrap(),
    );
    let manifest = Manifest::new(
        source.clone(),
        specs.iter().map(|s| s.entry.clone()).collect(),
    )
    .unwrap();
    let id = IndexSnapshotId::new(
        OperationId::new(store).unwrap(),
        OperationId::new(epoch).unwrap(),
        mark.parse().unwrap(),
        SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .unwrap(),
    )
    .unwrap();
    let mut builder = GenerationBuilder::new(
        manifest.clone(),
        PublicationFence::new(source, None, id).unwrap(),
    )
    .unwrap();
    for spec in specs {
        let witness = match spec.entry.kind {
            EntryKind::Folder => continue,
            EntryKind::File => manifest.witness(&spec.entry.id).unwrap(),
        };
        let record = match &spec.body {
            Body::Folder => unreachable!(),
            Body::Excluded(reason) => IndexRecord::excluded(witness, reason.clone()),
            Body::Text(text, markdown) => {
                let record = IndexRecord::text(
                    witness.clone(),
                    &MetadataRequest {
                        entry_id: spec.entry.id.clone(),
                        content_revision: spec.entry.revision.clone(),
                        source: text.clone(),
                    },
                    *markdown,
                )
                .unwrap();
                let mut metadata = record.metadata().cloned();
                if let Some(metadata) = &mut metadata {
                    edit(spec.entry.id.as_str(), metadata);
                }
                IndexRecord::from_persisted(
                    witness,
                    metadata,
                    record.text_digest().copied(),
                    record.text_bytes(),
                    record.exclusion().cloned(),
                )
                .unwrap()
            }
        };
        match builder.add(record.clone()) {
            Ok(()) => (),
            Err(IndexError::PumpLimit) => {
                builder.begin_pump();
                builder.add(record).unwrap();
            }
            result => panic!("{result:?}"),
        }
    }
    Arc::new(builder.finish().unwrap().into_parts().1)
}
fn scan(
    destination: Arc<Generation>,
    baseline: Option<Arc<Generation>>,
    limit: usize,
) -> MetadataRowsScan {
    MetadataRowsScan::new_checked(destination, baseline, limit, &mut || true).unwrap()
}
fn page_json(page: &PreparedMetadataRowsPage) -> serde_json::Value {
    let bytes = serde_json::to_vec(page).unwrap();
    assert!(bytes.len() <= page.encoded_bytes_bound());
    assert!(page.encoded_bytes_bound() <= MAX_METADATA_ROWS_BYTES);
    assert!(page.preparation_work_used() <= MAX_METADATA_ROWS_WORK);
    assert!(page.scanned_entries() <= MAX_METADATA_ROWS);
    assert!(page.rows().count() + page.removed_entry_ids().count() <= MAX_METADATA_ROWS);
    serde_json::from_slice(&bytes).unwrap()
}
fn collect(scan: &mut MetadataRowsScan) -> (Vec<serde_json::Value>, Vec<String>, usize) {
    let (mut rows, mut removed, mut pages) = (Vec::new(), Vec::new(), 0);
    loop {
        let page = scan.page_checked(&mut || true).unwrap();
        let json = page_json(&page);
        rows.extend(json["rows"].as_array().unwrap().iter().cloned());
        removed.extend(
            json["removedEntryIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned()),
        );
        pages += 1;
        let done = page.scan_complete();
        scan.commit_page(page).unwrap();
        if done {
            break;
        }
        assert!(pages <= 1000);
    }
    (rows, removed, pages)
}
fn row_id(row: &serde_json::Value) -> &str {
    if row["kind"] == "file" {
        row["value"]["entry"]["id"].as_str().unwrap()
    } else {
        row["entry"]["id"].as_str().unwrap()
    }
}

#[test]
fn reset_preserves_folders_full_file_facts_exclusions_and_empty_namespace() {
    let mut plain = Spec::text("plain", "Other.txt", "plain text");
    plain.body = Body::Text("plain text".into(), false);
    let specs = [
        Spec::folder("folder", "Folder"),
        Spec::text(
            "note",
            "Folder/Note.md",
            "---\naliases: [Alias]\ntags: [one]\n---\nTitle\n=====\n- [ ] todo\r\n[[Other]]",
        ),
        Spec::text("empty", "Empty.md", ""),
        plain,
        Spec::excluded("binary", "pixel.png", Exclusion::Binary),
        Spec::excluded("limit", "TooLarge.md", Exclusion::SourceLimit),
    ];
    let generation = build("1", "epoch", &specs, |_, _| {});
    let mut s = scan(generation.clone(), None, 2);
    let first = s.page_checked(&mut || true).unwrap();
    assert_eq!(first.mode(), MetadataRowsMode::Reset);
    assert!(first.from().is_none());
    assert!(!first.coverage_complete());
    for row in first.rows() {
        if let MetadataRowsItem::File { value } = row {
            assert!(std::ptr::eq(
                value.entry,
                generation.manifest().entry(&value.entry.id).unwrap()
            ));
            if let Some(metadata) = value.metadata {
                assert!(std::ptr::eq(
                    metadata,
                    generation
                        .record(&value.entry.id)
                        .unwrap()
                        .metadata()
                        .unwrap()
                ));
            }
        }
    }
    let (rows, removed, pages) = collect(&mut s);
    assert_eq!(pages, 3);
    assert_eq!(rows.len(), 6);
    assert!(removed.is_empty());
    let note = &rows.iter().find(|r| row_id(r) == "note").unwrap()["value"];
    assert_eq!(
        note["metadata"],
        serde_json::to_value(
            generation
                .record(&EntryId::new("note").unwrap())
                .unwrap()
                .metadata()
        )
        .unwrap()
    );
    assert!(!note["metadata"]["headings"].as_array().unwrap().is_empty());
    assert!(!note["metadata"]["listItems"].as_array().unwrap().is_empty());
    assert_eq!(
        rows.iter().find(|r| row_id(r) == "binary").unwrap()["value"]["exclusion"],
        "binary"
    );
    let plain = &rows.iter().find(|r| row_id(r) == "plain").unwrap()["value"];
    assert!(plain["metadata"].is_null() && plain["exclusion"].is_null());
    let done = s.page_checked(&mut || true).unwrap();
    assert!(done.scan_complete() && !done.complete());
    assert!(done.rows().next().is_none());
    let mut empty = scan(build("2", "epoch", &[], |_, _| {}), None, 32);
    let page = empty.page_checked(&mut || true).unwrap();
    assert!(page.scan_complete() && page.complete());
    assert_eq!(page_json(&page)["rows"], serde_json::json!([]));
    empty.commit_page(page).unwrap();
}

#[test]
fn delta_folder_move_removal_and_same_path_replacement_reconstruct_exact_namespace() {
    let old_specs = [
        Spec::folder("f", "Old"),
        Spec::folder("nested", "Old/Nested"),
        Spec::text("a", "Old/Nested/A.md", "# One"),
        Spec::text("gone", "Removed.md", "gone"),
        Spec::text("same", "Same.md", "same"),
    ];
    let new_specs = [
        Spec::folder("f", "New"),
        Spec::folder("nested", "New/Nested"),
        Spec::text("a", "New/Nested/A.md", "# One"),
        Spec::text("new-id", "Removed.md", "new"),
        Spec::text("same", "Same.md", "same"),
    ];
    let old = build("1", "epoch", &old_specs, |_, _| {});
    let new = build("2", "epoch", &new_specs, |_, _| {});
    let (old_rows, _, _) = collect(&mut scan(old.clone(), None, 32));
    let mut frame: BTreeMap<String, _> = old_rows
        .into_iter()
        .map(|r| (row_id(&r).to_owned(), r))
        .collect();
    let mut delta = scan(new.clone(), Some(old.clone()), 2);
    let first = delta.page_checked(&mut || true).unwrap();
    assert_eq!(first.mode(), MetadataRowsMode::Delta);
    assert_eq!(first.from(), Some(old.id()));
    assert_eq!(first.snapshot(), new.id());
    assert_eq!(first.source(), new.manifest().source());
    let (rows, removed, _) = collect(&mut delta);
    assert_eq!(removed, ["gone"]);
    assert_eq!(
        rows.iter().map(row_id).collect::<Vec<_>>(),
        ["f", "nested", "a", "new-id"]
    );
    for id in removed {
        frame.remove(&id);
    }
    for row in rows {
        frame.insert(row_id(&row).to_owned(), row);
    }
    let (reset, _, _) = collect(&mut scan(new, None, 32));
    assert_eq!(
        frame,
        reset
            .into_iter()
            .map(|r| (row_id(&r).to_owned(), r))
            .collect()
    );
}

#[test]
fn same_labels_revision_and_digest_do_not_hide_nested_numeric_or_fact_changes() {
    let specs = [Spec::text(
        "a",
        "A.md",
        "---\nv: 0.0\n---\n# Same\n- [ ] todo",
    )];
    let number = |n: serde_json::Number| {
        PropertyValue::Object(vec![(
            "inner".into(),
            PropertyValue::Array(vec![PropertyValue::Number(n)]),
        )])
    };
    let old = build("1", "epoch", &specs, |_, m| {
        m.properties[0].value = number(serde_json::Number::from_f64(-0.0).unwrap())
    });
    for value in [
        number(serde_json::Number::from_f64(0.0).unwrap()),
        number(0.into()),
    ] {
        let new = build("1", "epoch", &specs, |_, m| {
            m.properties[0].value = value.clone()
        });
        assert_eq!(old.id(), new.id());
        assert_eq!(
            old.records().next().unwrap().text_digest(),
            new.records().next().unwrap().text_digest()
        );
        let (rows, removed, _) = collect(&mut scan(new, Some(old.clone()), 32));
        assert_eq!(rows.len(), 1);
        assert!(removed.is_empty());
    }
    // Positive float zero and integer zero are distinct too, independently
    // of the signed-zero case above.
    let float = build("1", "epoch", &specs, |_, m| {
        m.properties[0].value = number(serde_json::Number::from_f64(0.0).unwrap());
    });
    let integer = build("1", "epoch", &specs, |_, m| {
        m.properties[0].value = number(0.into());
    });
    assert_eq!(collect(&mut scan(integer, Some(float), 32)).0.len(), 1);
    let changed = build("1", "epoch", &specs, |_, m| {
        m.properties[0].value = number(serde_json::Number::from_f64(-0.0).unwrap());
        m.headings[0].text = "Other".into();
    });
    assert_eq!(collect(&mut scan(changed, Some(old), 32)).0.len(), 1);
    let before = build(
        "1",
        "epoch",
        &[Spec::excluded("x", "x.png", Exclusion::Binary)],
        |_, _| {},
    );
    let after = build(
        "1",
        "epoch",
        &[Spec::excluded("x", "x.png", Exclusion::Unreadable)],
        |_, _| {},
    );
    let mut delta = scan(after, Some(before), 32);
    let page = delta.page_checked(&mut || true).unwrap();
    assert!(!page.coverage_complete());
    assert_eq!(
        page_json(&page)["rows"][0]["value"]["exclusion"],
        "unreadable"
    );
    delta.commit_page(page).unwrap();
}

#[test]
fn source_watermark_only_changes_produce_bounded_empty_progress_pages() {
    let specs: Vec<_> = (0..65)
        .map(|n| Spec::text(&format!("entry-{n}"), &format!("{n:03}.md"), "same"))
        .collect();
    let old = build("1", "epoch", &specs, |_, _| {});
    let new = build("2", "epoch", &specs, |_, _| {});
    let mut s = scan(new, Some(old), 32);
    let mut total = 0;
    loop {
        let p = s.page_checked(&mut || true).unwrap();
        assert!(p.rows().next().is_none() && p.removed_entry_ids().next().is_none());
        total += p.scanned_entries();
        let done = p.scan_complete();
        s.commit_page(p).unwrap();
        if done {
            break;
        }
    }
    assert_eq!(total, 130);
    assert_eq!(collect(&mut s).2, 1);
}

#[test]
fn uncommitted_encoding_failure_retry_and_foreign_or_stale_checkpoint_are_safe() {
    let g = build(
        "1",
        "epoch",
        &[Spec::text("a", "A.md", "a"), Spec::text("b", "B.md", "b")],
        |_, _| {},
    );
    let mut s = scan(g.clone(), None, 1);
    let first = s.page_checked(&mut || true).unwrap();
    let expected = page_json(&first);
    // Exercise the separate adapter writer gate: a byte cap or cancellation
    // can fail ACTUAL encoding after preparation. Neither commits the scan.
    struct TransportWriter {
        remaining: usize,
        writes: usize,
        cancel_after: usize,
    }
    impl std::io::Write for TransportWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            if self.writes > self.cancel_after || bytes.len() > self.remaining {
                return Err(std::io::Error::other(
                    "owned transport byte/cancellation gate",
                ));
            }
            self.remaining -= bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    for (remaining, cancel_after) in [(64, usize::MAX), (MAX_METADATA_ROWS_BYTES, 3)] {
        let mut writer = TransportWriter {
            remaining,
            writes: 0,
            cancel_after,
        };
        assert!(serde_json::to_writer(&mut writer, &first).is_err());
        assert!(writer.writes > 0);
    }
    // A failed final pin fence likewise drops the prepared selection.
    drop(first);
    let retry = s.page_checked(&mut || true).unwrap();
    assert_eq!(page_json(&retry), expected);
    let stale = s.page_checked(&mut || true).unwrap();
    let mut foreign = scan(g.clone(), None, 1);
    assert_eq!(
        foreign.commit_page(stale),
        Err(MetadataRowsError::CheckpointMismatch)
    );
    let stale = s.page_checked(&mut || true).unwrap();
    s.commit_page(retry).unwrap();
    assert_eq!(
        s.commit_page(stale),
        Err(MetadataRowsError::CheckpointMismatch)
    );
    let second = s.page_checked(&mut || true).unwrap();
    assert_eq!(row_id(&page_json(&second)["rows"][0]), "b");
    assert!(second.scan_complete());
    s.commit_page(second).unwrap();
}

#[test]
fn cancellation_during_admission_comparison_encoding_or_final_check_never_advances() {
    let specs = [Spec::text("a", "A.md", "---\nv: [1,2,3]\n---\n# Heading")];
    let old = build("1", "epoch", &specs, |_, _| {});
    let new = build("2", "epoch", &specs, |_, _| {});
    assert!(matches!(
        MetadataRowsScan::new_checked(new.clone(), None, 1, &mut || false),
        Err(MetadataRowsError::Cancelled)
    ));
    for baseline in [None, Some(old)] {
        let s = scan(new.clone(), baseline, 1);
        let mut calls = 0;
        let expected = s
            .page_checked(&mut || {
                calls += 1;
                true
            })
            .unwrap();
        let expected = page_json(&expected);
        for stop in [1, calls / 2, calls] {
            let mut seen = 0;
            assert!(matches!(
                s.page_checked(&mut || {
                    seen += 1;
                    seen != stop
                }),
                Err(MetadataRowsError::Cancelled)
            ));
            assert_eq!(page_json(&s.page_checked(&mut || true).unwrap()), expected);
        }
    }
}

#[test]
fn byte_oversize_is_explicit_and_partial_page_does_not_skip_the_large_candidate() {
    let huge = "x".repeat(MAX_METADATA_ROWS_BYTES + 1);
    let specs = [
        Spec::text("a", "A.md", "small"),
        Spec::text("z", "Z.md", "large"),
    ];
    let g = build("1", "epoch", &specs, |id, m| {
        if id == "z" {
            m.aliases = vec![huge.clone()];
        }
    });
    let mut s = scan(g.clone(), None, 32);
    let first = s.page_checked(&mut || true).unwrap();
    assert_eq!(first.rows().count(), 1);
    assert!(!first.scan_complete());
    assert_eq!(row_id(&page_json(&first)["rows"][0]), "a");
    s.commit_page(first).unwrap();
    for _ in 0..2 {
        assert!(matches!(
            s.page_checked(&mut || true),
            Err(MetadataRowsError::ResourceLimit)
        ));
    }
    // All source/facts remain available and unchanged; no cache row is deleted.
    assert_eq!(
        g.records().last().unwrap().metadata().unwrap().aliases[0].len(),
        huge.len()
    );
}

#[test]
fn work_ceiling_returns_progress_without_false_unchanged_omission() {
    let specs: Vec<_> = (0..12)
        .map(|n| Spec::text(&format!("entry-{n}"), &format!("{n:03}.md"), "body"))
        .collect();
    // No properties/numeric validation bypass: these are bounded accepted alias
    // arrays in restored metadata, below the existing64MiB generation ceiling.
    let edit = |_: &str, m: &mut DocumentMetadata| m.aliases = vec![String::new(); 100_000];
    let old = build("1", "epoch", &specs, edit);
    let new = build("2", "epoch", &specs, edit);
    let mut s = scan(new, Some(old), 32);
    let first = s.page_checked(&mut || true).unwrap();
    assert!(!first.scan_complete());
    assert!(first.rows().next().is_none());
    assert!(first.scanned_entries() < MAX_METADATA_ROWS);
    assert!(first.preparation_work_used() <= MAX_METADATA_ROWS_WORK);
    s.commit_page(first).unwrap();
    let (rows, removed, pages) = collect(&mut s);
    assert!(rows.is_empty() && removed.is_empty());
    assert!(pages >= 1);
}

#[test]
fn incompatible_history_resets_foreign_store_and_invalid_limits_reject() {
    let specs = [Spec::text("a", "A.md", "same")];
    let old = build("1", "old-epoch", &specs, |_, _| {});
    let new = build("2", "new-epoch", &specs, |_, _| {});
    let mut s = scan(new.clone(), Some(old), 32);
    assert_eq!(s.mode(), MetadataRowsMode::Reset);
    assert!(s.from().is_none());
    assert_eq!(collect(&mut s).0.len(), 1);
    for limit in [0, 33, usize::MAX] {
        assert!(matches!(
            MetadataRowsScan::new_checked(new.clone(), None, limit, &mut || true),
            Err(MetadataRowsError::InvalidLimit)
        ));
    }
    let foreign = build_store("foreign-store", "1", "new-epoch", &specs, &mut |_, _| {});
    assert!(matches!(
        MetadataRowsScan::new_checked(new, Some(foreign), 32, &mut || true),
        Err(MetadataRowsError::ForeignScope)
    ));
}
