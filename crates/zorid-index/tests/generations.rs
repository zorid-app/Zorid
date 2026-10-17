use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::{MetadataRequest, MAX_SOURCE_BYTES};
use zorid_index::*;
fn source() -> SourceSnapshotId {
    SourceSnapshotId::new(
        OperationId::new("local-store").unwrap(),
        SourceWatermark::new("10").unwrap(),
    )
}
fn build(epoch: &str, documents: &[(&str, &str, bool)]) -> Generation {
    let entries: Vec<_> = documents
        .iter()
        .enumerate()
        .map(|(n, (path, _, _))| EntryState {
            id: EntryId::new(format!("entry-{n}")).unwrap(),
            path: VaultPath::new(*path).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("content-1").unwrap(),
            deleted: false,
        })
        .collect();
    let manifest = Manifest::new(source(), entries).unwrap();
    let versions = SemanticVersions::new(
        INDEX_SCHEMA_VERSION,
        document_extraction_version(),
        RESOLVER_VERSION,
        LITERAL_QUERY_VERSION,
    )
    .unwrap();
    let id = IndexSnapshotId::new(
        OperationId::new("local-store").unwrap(),
        OperationId::new(epoch).unwrap(),
        1,
        versions,
    )
    .unwrap();
    let fence = PublicationFence::new(source(), None, id).unwrap();
    let mut builder = GenerationBuilder::new(manifest.clone(), fence).unwrap();
    for (n, (_, text, markdown)) in documents.iter().enumerate() {
        let id = EntryId::new(format!("entry-{n}")).unwrap();
        let record = IndexRecord::text(
            manifest.witness(&id).unwrap(),
            &MetadataRequest {
                entry_id: id,
                content_revision: Revision::new("content-1").unwrap(),
                source: (*text).into(),
            },
            *markdown,
        )
        .unwrap();
        match builder.add(record.clone()) {
            Ok(()) => {}
            Err(IndexError::PumpLimit) => {
                builder.begin_pump();
                builder.add(record).unwrap();
            }
            other => panic!("unexpected preparation result {other:?}"),
        }
    }
    builder.finish().unwrap().into_parts().1
}
#[test]
fn exact_literal_pages_preserve_source_ranges_order_and_snapshot_identity() {
    let first = "\u{feff}😀\r\nneedle one\r\nneedle two\n";
    let documents = [("B.md", first, true), ("A.custom", "needle alpha", false)];
    let generation = build("epoch-original", &documents);
    let query = LiteralQuery::new("needle").unwrap();
    let mut token = None;
    let mut hits = Vec::new();
    loop {
        let mut page =
            LiteralPageBuilder::new(&generation, query.clone(), token.as_ref(), 1).unwrap();
        while let Some(request) = page.next_read() {
            let text = documents
                .iter()
                .find(|(path, _, _)| *path == request.entry().path.as_str())
                .unwrap()
                .1;
            page.accept(&request, text.as_bytes()).unwrap();
        }
        let result = page.finish().unwrap();
        assert_eq!(result.snapshot, *generation.id());
        hits.extend(result.hits);
        token = result.next;
        if token.is_none() {
            assert!(result.complete);
            break;
        }
    }
    assert_eq!(
        hits.iter()
            .map(|h| h.entry.path.as_str())
            .collect::<Vec<_>>(),
        ["A.custom", "B.md", "B.md"]
    );
    assert_eq!(hits[1].line, 1);
    assert_eq!(hits[1].range.bytes, [9, 15]);
    assert_eq!(hits[1].range.utf16, [5, 11]);
}
#[test]
fn query_never_substitutes_current_source_or_fresh_cache_epoch() {
    let generation = build("epoch-a", &[("A.md", "needle one\nneedle two", true)]);
    let query = LiteralQuery::new("needle").unwrap();
    let mut page = LiteralPageBuilder::new(&generation, query.clone(), None, 1).unwrap();
    let request = page.next_read().unwrap();
    assert_eq!(
        page.accept(&request, b"needle BAD\nneedle two"),
        Err(IndexError::ContentMismatch)
    );
    page.accept(&request, b"needle one\nneedle two").unwrap();
    let token = page.finish().unwrap().next.unwrap();
    let fresh = build(
        "new-host-csprng-epoch",
        &[("A.md", "needle one\nneedle two", true)],
    );
    assert!(matches!(
        LiteralPageBuilder::new(&fresh, query.clone(), Some(&token), 1),
        Err(IndexError::SnapshotExpired)
    ));
    assert!(matches!(
        LiteralPageBuilder::new(
            &generation,
            LiteralQuery::new("other").unwrap(),
            Some(&token),
            1
        ),
        Err(IndexError::QueryMismatch)
    ));
}
#[test]
fn soft_budget_allows_one_document_above_one_mib_without_no_progress() {
    let text = "x".repeat(2 * MAX_PUMP_BYTES);
    let generation = build("epoch-a", &[("Large.custom", &text, false)]);
    assert!(generation.coverage_complete());
    let mut page =
        LiteralPageBuilder::new(&generation, LiteralQuery::new("x").unwrap(), None, 10).unwrap();
    let request = page.next_read().unwrap();
    assert_eq!(request.bytes(), text.len());
    page.accept(&request, text.as_bytes()).unwrap();
    let result = page.finish().unwrap();
    assert!(result.complete);
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.source_bytes, 2 * MAX_PUMP_BYTES);
}
#[test]
fn terminal_source_limit_finishes_scan_with_explicit_incomplete_coverage() {
    let text = "x".repeat(MAX_SOURCE_BYTES + 1);
    let generation = build("epoch-a", &[("BeyondDocumentLimit.custom", &text, false)]);
    let record = generation.records().next().unwrap();
    assert_eq!(record.exclusion(), Some(&Exclusion::SourceLimit));
    let mut page =
        LiteralPageBuilder::new(&generation, LiteralQuery::new("x").unwrap(), None, 10).unwrap();
    assert!(page.next_read().is_none());
    let result = page.finish().unwrap();
    assert!(result.scan_complete);
    assert!(!result.coverage_complete);
    assert!(!result.complete);
    assert!(result.next.is_none());
}
#[test]
fn malformed_yaml_is_current_diagnostic_metadata_and_source_still_searchable() {
    let text = "---\nvalue: [unterminated\n---\nneedle body";
    let generation = build("epoch-a", &[("A.md", text, true)]);
    let metadata = generation.records().next().unwrap().metadata().unwrap();
    assert!(!metadata.diagnostics.is_empty());
    assert_eq!(metadata.content_revision.as_str(), "content-1");
    let mut page =
        LiteralPageBuilder::new(&generation, LiteralQuery::new("needle").unwrap(), None, 10)
            .unwrap();
    let request = page.next_read().unwrap();
    page.accept(&request, text.as_bytes()).unwrap();
    assert_eq!(page.finish().unwrap().hits.len(), 1);
}
#[test]
fn complete_generation_requires_every_file_and_same_source_fence() {
    let complete = build("epoch-a", &[("A.md", "needle", true)]);
    let next = IndexSnapshotId::new(
        OperationId::new("local-store").unwrap(),
        OperationId::new("epoch-a").unwrap(),
        2,
        complete.id().versions().clone(),
    )
    .unwrap();
    let fence = PublicationFence::new(source(), Some(complete.id().clone()), next).unwrap();
    let empty = GenerationBuilder::new(complete.manifest().clone(), fence).unwrap();
    assert!(matches!(empty.finish(), Err(IndexError::InvalidRecord)));
    // A prepared generation is not published and cannot authorize a later head.
    let newer = SourceSnapshotId::new(
        OperationId::new("local-store").unwrap(),
        SourceWatermark::new("11").unwrap(),
    );
    let fence = PublicationFence::new(
        source(),
        Some(complete.id().clone()),
        IndexSnapshotId::new(
            OperationId::new("local-store").unwrap(),
            OperationId::new("fresh-epoch").unwrap(),
            1,
            complete.id().versions().clone(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        fence.check(&newer, Some(complete.id())),
        Err(IndexError::StaleSource)
    );
}

#[test]
fn nul_content_is_nontext_like_existing_cli_search() {
    let generation = build("epoch-a", &[("A.custom", "visible\0needle", false)]);
    assert_eq!(
        generation.records().next().unwrap().exclusion(),
        Some(&Exclusion::Binary)
    );
    let mut page =
        LiteralPageBuilder::new(&generation, LiteralQuery::new("needle").unwrap(), None, 10)
            .unwrap();
    assert!(page.next_read().is_none());
    let result = page.finish().unwrap();
    assert!(result.complete);
    assert!(result.hits.is_empty());
}
#[test]
fn escaped_control_query_and_near_full_hits_fit_page_output_guard() {
    let query = "\u{0001}".repeat(4096);
    let body = format!("{query}\n").repeat(1050);
    let generation = build("epoch-a", &[("A.custom", &body, false)]);
    let mut page = LiteralPageBuilder::new(
        &generation,
        LiteralQuery::new(query.clone()).unwrap(),
        None,
        1000,
    )
    .unwrap();
    let request = page.next_read().unwrap();
    page.accept(&request, body.as_bytes()).unwrap();
    let result = page.finish().unwrap();
    assert!(result.next.is_some());
    assert!(result.hits.len() > 200);
    // Representative transport encoding includes the escaped query again in
    // its continuation identity; hashes never depend on this JSON ordering.
    let hits: Vec<_> = result
        .hits
        .iter()
        .map(|hit| {
            serde_json::json!({"entry":hit.entry,"line":hit.line,
        "range":hit.range,"snippet":hit.snippet,"snippet_truncated":hit.snippet_truncated})
        })
        .collect();
    let versions = generation.id().versions();
    let encoded=serde_json::to_vec(&serde_json::json!({"snapshot":{
        "store":generation.id().local_store_id(),"epoch":generation.id().generation_epoch(),
        "generation":generation.id().generation().to_string(),"versions":{
            "schema":versions.schema(),"extraction":versions.extraction(),"resolver":versions.resolver(),"query":versions.query()}},
        "hits":hits,"next":{"query":query,"row":"0","line_start":body.len().to_string()}})).unwrap();
    assert!(encoded.len() <= MAX_PUMP_BYTES, "{}", encoded.len());
}
#[test]
fn cache_restore_validates_metadata_without_reparsing_source() {
    let generation = build("epoch-a", &[("A.md", "# Heading\n[[Target]]", true)]);
    let record = generation.records().next().unwrap();
    let restore = |metadata: Option<MetadataProjection>,
                   digest: Option<[u8; 32]>,
                   bytes,
                   exclusion| {
        IndexRecord::from_persisted(record.witness().clone(), metadata, digest, bytes, exclusion)
    };
    assert_eq!(
        restore(
            record.metadata().cloned(),
            record.text_digest().copied(),
            record.text_bytes(),
            None
        )
        .unwrap(),
        *record
    );
    let mut wrong = record.metadata().unwrap().clone();
    wrong.schema_version += 1;
    assert_eq!(
        restore(
            Some(wrong),
            record.text_digest().copied(),
            record.text_bytes(),
            None
        ),
        Err(IndexError::InvalidVersion)
    );
    let mut wrong = record.metadata().unwrap().clone();
    wrong.entry_id = EntryId::new("another-entry").unwrap();
    assert_eq!(
        restore(
            Some(wrong),
            record.text_digest().copied(),
            record.text_bytes(),
            None
        ),
        Err(IndexError::StaleSource)
    );
    let mut wrong = record.metadata().unwrap().clone();
    wrong.links[0].target_range.bytes = [0, wrong.source_length.bytes + 1];
    assert_eq!(
        restore(
            Some(wrong),
            record.text_digest().copied(),
            record.text_bytes(),
            None
        ),
        Err(IndexError::InvalidRecord)
    );
    assert_eq!(
        restore(
            None,
            record.text_digest().copied(),
            record.text_bytes(),
            Some(Exclusion::Binary)
        ),
        Err(IndexError::InvalidRecord)
    );
}

#[test]
fn forged_cache_task_status_cannot_be_an_astral_scalar() {
    let generation = build("epoch-a", &[("A.md", "- [x] complete", true)]);
    let record = generation.records().next().unwrap();
    let mut metadata = record.metadata().unwrap().clone();
    assert_eq!(metadata.tasks.len(), 1);
    metadata.tasks[0].status = "😀".into();
    assert_eq!(
        IndexRecord::from_persisted(
            record.witness().clone(),
            Some(metadata),
            record.text_digest().copied(),
            record.text_bytes(),
            None
        ),
        Err(IndexError::InvalidRecord)
    );
}

#[test]
fn coherent_relationship_pages_keep_exact_witnesses_and_expire_old_tokens() {
    let documents = [
        (
            "A.md",
            "[[B]] ![[B]] [[Missing]] [web](https://example.org)",
            true,
        ),
        ("B.md", "target", true),
    ];
    let generation = build("epoch-a", &documents);
    let graph = ResolutionView::new(&generation)
        .snapshot(10, MAX_PUMP_BYTES)
        .unwrap();
    assert_eq!(graph.snapshot_id(), generation.id());
    assert_eq!(graph.source(), generation.manifest().source());
    assert!(graph.complete());
    assert_eq!(graph.edges().len(), 4);
    let a = EntryId::new("entry-0").unwrap();
    let b = EntryId::new("entry-1").unwrap();
    assert_eq!(graph.resolve(&a, "B").unwrap()[0].id, b);
    assert_eq!(graph.edges()[0].source().id, a);
    assert_eq!(graph.edges()[0].target().unwrap().id, b);
    assert_eq!(
        graph.edges()[0].target().unwrap().revision.as_str(),
        "content-1"
    );
    assert!(graph.edges()[2].target().is_none());
    assert!(graph.edges()[3].target().is_none());
    let first = graph
        .query(&b, RelationshipDirection::Incoming, None, 1)
        .unwrap();
    assert_eq!(first.edges.len(), 1);
    assert!(!first.complete);
    let second = graph
        .query(&b, RelationshipDirection::Incoming, first.next.as_ref(), 10)
        .unwrap();
    assert_eq!(second.edges.len(), 1);
    assert!(second.complete);
    assert!(second.edges[0].link().embed);
    let rebuilt = build("epoch-b", &documents);
    let other = ResolutionView::new(&rebuilt)
        .snapshot(10, MAX_PUMP_BYTES)
        .unwrap();
    assert!(matches!(
        other.query(&b, RelationshipDirection::Incoming, first.next.as_ref(), 10),
        Err(IndexError::SnapshotExpired)
    ));
    assert!(matches!(
        graph.query(&a, RelationshipDirection::Outgoing, first.next.as_ref(), 10),
        Err(IndexError::QueryMismatch)
    ));
    assert!(matches!(
        ResolutionView::new(&generation).snapshot(1, MAX_PUMP_BYTES),
        Err(IndexError::GenerationLimit)
    ));
    let encoded = serde_json::to_vec(&graph).unwrap();
    assert!(encoded.len() < MAX_PUMP_BYTES);
    assert!(serde_json::from_slice::<serde_json::Value>(&encoded)
        .unwrap()
        .get("manifest")
        .is_none());
}

#[test]
fn shared_literal_state_safely_pins_owned_generation() {
    let generation = std::sync::Arc::new(build("epoch-a", &[("A.md", "needle", true)]));
    let mut page: LiteralPageBuilder<'static> = LiteralPageBuilder::new_shared(
        generation.clone(),
        LiteralQuery::new("needle").unwrap(),
        None,
        10,
    )
    .unwrap();
    drop(generation);
    let request = page.next_read().unwrap();
    page.accept(&request, b"needle").unwrap();
    let result = page.finish().unwrap();
    assert!(result.complete);
    assert_eq!(result.hits.len(), 1);
}

#[test]
fn bounded_generation_factory_and_shared_record_transport_preserve_validation() {
    let original = build(
        "epoch-a",
        &[("A.md", "[[B]]", true), ("B.md", "target", true)],
    );
    let inputs = vec![
        GenerationSource::Text {
            request: MetadataRequest {
                entry_id: EntryId::new("entry-0").unwrap(),
                content_revision: Revision::new("content-1").unwrap(),
                source: "[[B]]".into(),
            },
            markdown: true,
        },
        GenerationSource::Text {
            request: MetadataRequest {
                entry_id: EntryId::new("entry-1").unwrap(),
                content_revision: Revision::new("content-1").unwrap(),
                source: "target".into(),
            },
            markdown: true,
        },
    ];
    let factory = |sources| {
        Generation::from_sources(
            source(),
            original.id().clone(),
            original.manifest().entries().to_vec(),
            sources,
        )
    };
    let imported = factory(inputs.clone()).unwrap();
    assert_eq!(
        imported.records().collect::<Vec<_>>(),
        original.records().collect::<Vec<_>>()
    );
    assert!(matches!(
        factory(vec![inputs[0].clone()]),
        Err(IndexError::MissingSource)
    ));
    assert!(matches!(
        factory(vec![inputs[0].clone(), inputs[0].clone()]),
        Err(IndexError::InvalidRecord)
    ));
    for row in imported.records() {
        let encoded = serde_json::to_vec(&PersistedIndexRecord::from(row)).unwrap();
        let dto: PersistedIndexRecord = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(dto.restore(row.witness().clone()).unwrap(), *row);
    }
}

#[test]
fn restored_cache_rejects_impossible_ranges_task_flags_and_expanded_strings() {
    let text = "---\ntitle: valid\n---\n- [x] complete\n[[Target]] #tag";
    let generation = build("epoch-a", &[("A.md", text, true)]);
    let row = generation.records().next().unwrap();
    let valid = row.metadata().unwrap();
    let check = |metadata| {
        IndexRecord::from_persisted(
            row.witness().clone(),
            Some(metadata),
            row.text_digest().copied(),
            row.text_bytes(),
            None,
        )
    };
    assert!(check(valid.clone()).is_ok());
    let mut bad = valid.clone();
    bad.links[0].target_range.bytes = [1, 2];
    bad.links[0].target_range.utf16 = [1, 1];
    assert!(matches!(check(bad), Err(IndexError::InvalidRecord)));
    let mut bad = valid.clone();
    bad.tasks[0].checked = false;
    assert!(matches!(check(bad), Err(IndexError::InvalidRecord)));
    let mut bad = valid.clone();
    bad.tasks[0].status = "\n".into();
    assert!(matches!(check(bad), Err(IndexError::InvalidRecord)));
    let mut bad = valid.clone();
    bad.properties[0].value = zorid_document::PropertyValue::String(
        "x".repeat(zorid_document::MAX_EXPANDED_YAML_BYTES + 1),
    );
    assert!(matches!(check(bad), Err(IndexError::InvalidRecord)));
    let mut bad = valid.clone();
    bad.frontmatter.state = zorid_document::FrontmatterState::Absent;
    assert!(matches!(check(bad), Err(IndexError::InvalidRecord)));
}
