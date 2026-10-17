//! Cross-engine regression: canonical parser facts survive the disposable index
//! transport without a serde_json::Value detour that would reorder YAML maps.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::{parse_markdown, DocumentMetadata, MetadataRequest, PropertyValue};
use zorid_index::*;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    request: MetadataRequest,
    expected: DocumentMetadata,
}

fn source() -> SourceSnapshotId {
    SourceSnapshotId::new(
        OperationId::new("corpus-store").unwrap(),
        SourceWatermark::new("9007199254740993").unwrap(),
    )
}
fn entry(id: &EntryId, revision: &Revision, path: &str) -> EntryState {
    EntryState {
        id: id.clone(),
        revision: revision.clone(),
        path: VaultPath::new(path).unwrap(),
        kind: EntryKind::File,
        deleted: false,
    }
}

fn restore_case(case: &Case) -> Result<(), String> {
    let parsed = parse_markdown(&case.request).map_err(|e| format!("parse: {e:?}"))?;
    if parsed != case.expected {
        return Err("parser differs from canonical metadata, including ordered properties".into());
    }
    let manifest = Manifest::new(
        source(),
        vec![entry(
            &case.request.entry_id,
            &case.request.content_revision,
            "Corpus/😀.md",
        )],
    )
    .map_err(|e| format!("manifest: {e}"))?;
    let witness = manifest
        .witness(&case.request.entry_id)
        .map_err(|e| format!("witness: {e}"))?;
    let dto = PersistedIndexRecord {
        metadata: Some(parsed),
        digest: Some(Sha256::digest(case.request.source.as_bytes()).into()),
        text_bytes: case.request.source.len(),
        exclusion: None,
    };
    // Deserialize the actual typed JSON wire shape, not a JSON map value.
    let encoded = serde_json::to_vec(&dto).map_err(|e| format!("encode: {e}"))?;
    let decoded: PersistedIndexRecord =
        serde_json::from_slice(&encoded).map_err(|e| format!("decode: {e}"))?;
    let restored = decoded
        .restore(witness.clone())
        .map_err(|e| format!("restore: {e}"))?;
    if restored.metadata() != Some(&case.expected) || restored.witness() != &witness {
        return Err("metadata or committed source witness changed during restore".into());
    }
    if restored.metadata().unwrap().properties != case.expected.properties {
        return Err("recursive YAML entry ordering changed during restore".into());
    }
    restored
        .check_text(case.request.source.as_bytes())
        .map_err(|e| format!("retained source digest: {e}"))?;
    let reencoded = serde_json::to_vec(&PersistedIndexRecord::from(&restored))
        .map_err(|e| format!("reencode: {e}"))?;
    if encoded != reencoded {
        return Err("typed JSON transport changed source facts or property ordering".into());
    }
    Ok(())
}

#[test]
fn canonical_markdown_corpus_survives_typed_persisted_index_restore() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/markdown/corpus.json"
    ))
    .unwrap();
    assert_eq!(
        corpus.cases.len(),
        49,
        "review new canonical cases explicitly"
    );
    // Ordinary serde_json maps remain sorted: no global preserve_order feature
    // is needed or allowed to carry the semantic YAML entry order.
    let mut ordinary = serde_json::Map::new();
    ordinary.insert("z".into(), 1.into());
    ordinary.insert("a".into(), 2.into());
    assert_eq!(
        serde_json::to_string(&ordinary).unwrap(),
        r#"{"a":2,"z":1}"#
    );
    let mut failures = Vec::new();
    for case in &corpus.cases {
        if let Err(error) = restore_case(case) {
            failures.push(format!("{}: {error}", case.id));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    // These paired canonical cases distinguish recursive source order from the
    // ordinary JSON map ordering above, even when all names/values are equal.
    let nested_order = |id: &str| {
        let case = corpus.cases.iter().find(|case| case.id == id).unwrap();
        let PropertyValue::Object(entries) = &case.expected.properties[0].value else {
            panic!("{id}: expected nested ordered object");
        };
        entries
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(nested_order("nested-order-forward"), ["Title", "title"]);
    assert_eq!(nested_order("nested-order-reverse"), ["title", "Title"]);
}

#[test]
fn relationship_pages_distinguish_scan_completion_from_source_coverage() {
    for (label, exclusion, covered) in [
        ("unreadable", Exclusion::Unreadable, false),
        ("source-limit", Exclusion::SourceLimit, false),
        ("binary", Exclusion::Binary, true),
    ] {
        let revision = Revision::new("revision-1").unwrap();
        let referring = EntryId::new("referring").unwrap();
        let target = EntryId::new("target").unwrap();
        let omitted = EntryId::new("omitted").unwrap();
        let versions = SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .unwrap();
        let snapshot = IndexSnapshotId::new(
            source().local_store_id().clone(),
            OperationId::new(format!("epoch-{label}")).unwrap(),
            1,
            versions,
        )
        .unwrap();
        let generation = Generation::from_sources(
            source(),
            snapshot.clone(),
            vec![
                entry(&referring, &revision, "A.md"),
                entry(&target, &revision, "Target.md"),
                entry(&omitted, &revision, "Omitted.md"),
            ],
            vec![
                GenerationSource::Text {
                    request: MetadataRequest {
                        entry_id: referring.clone(),
                        content_revision: revision.clone(),
                        source: "[[Target]] ![[Target]] [[Target]]".into(),
                    },
                    markdown: true,
                },
                GenerationSource::Text {
                    request: MetadataRequest {
                        entry_id: target.clone(),
                        content_revision: revision.clone(),
                        source: "target".into(),
                    },
                    markdown: true,
                },
                GenerationSource::Excluded {
                    entry_id: omitted,
                    content_revision: revision.clone(),
                    reason: exclusion,
                },
            ],
        )
        .unwrap();
        let graph = ResolutionView::new(&generation)
            .snapshot(3, MAX_PUMP_BYTES)
            .unwrap();
        assert_eq!(graph.complete(), covered, "{label}");
        let mut token = None;
        let mut occurrences = Vec::new();
        for page_number in 0..3 {
            let page = graph
                .query(&target, RelationshipDirection::Incoming, token.as_ref(), 1)
                .unwrap();
            assert_eq!(page.snapshot, snapshot, "{label}");
            assert_eq!(page.edges.len(), 1, "bounded {label} page");
            assert_eq!(page.coverage_complete, covered, "{label}");
            assert_eq!(page.scan_complete, page_number == 2, "{label}");
            assert_eq!(page.complete, covered && page_number == 2, "{label}");
            let edge = &page.edges[0];
            assert_eq!(edge.source().id, referring);
            assert_eq!(edge.source().revision, revision);
            assert_eq!(edge.target().unwrap().id, target);
            assert_eq!(edge.target().unwrap().revision, revision);
            occurrences.push((edge.link_index(), edge.link().embed));
            token = page.next;
            assert_eq!(token.is_none(), page_number == 2, "{label}");
        }
        assert_eq!(occurrences, [(0, false), (1, true), (2, false)]);
    }
}
