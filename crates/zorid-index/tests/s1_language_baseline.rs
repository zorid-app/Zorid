//! Frozen current Rust literal behavior, deliberately separate from target search
//! language expectations stored alongside it. No storage/runtime parity claim.
use serde::Deserialize;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::{MetadataRequest, SourceRange};
use zorid_index::*;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    query: String,
    document: Document,
    current_rust_literal: Expected,
}
#[derive(Deserialize)]
struct Document {
    path: String,
    text: String,
}
#[derive(Deserialize)]
struct Expected {
    hits: Vec<ExpectedHit>,
}
#[derive(Debug, PartialEq, Deserialize)]
struct ExpectedHit {
    line: u32,
    range: SourceRange,
}

fn generation(case: &Case) -> Generation {
    let local = OperationId::new("language-store").unwrap();
    let source = SourceSnapshotId::new(local.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        local,
        OperationId::new("language-epoch").unwrap(),
        1,
        SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .unwrap(),
    )
    .unwrap();
    let entry = EntryState {
        id: EntryId::new("language-entry").unwrap(),
        revision: Revision::new("language-revision").unwrap(),
        path: VaultPath::new(&case.document.path).unwrap(),
        kind: EntryKind::File,
        deleted: false,
    };
    Generation::from_sources(
        source,
        snapshot,
        vec![entry.clone()],
        vec![GenerationSource::Text {
            request: MetadataRequest {
                entry_id: entry.id,
                content_revision: entry.revision,
                source: case.document.text.clone(),
            },
            markdown: true,
        }],
    )
    .unwrap()
}

#[test]
fn frozen_literal_oracles_survive_small_and_large_pages_without_target_language_reinterpretation() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/search/s1-language.json"
    ))
    .unwrap();
    assert_eq!(
        corpus.cases.len(),
        19,
        "Review new semantic cases explicitly"
    );
    for case in corpus.cases {
        let generation = generation(&case);
        for limit in [1, 100] {
            let query = LiteralQuery::new(&case.query).unwrap();
            let mut token = None;
            let mut hits = Vec::new();
            let mut complete = false;
            for _ in 0..=case.document.text.lines().count() + 1 {
                let mut builder =
                    LiteralPageBuilder::new(&generation, query.clone(), token.as_ref(), limit)
                        .unwrap();
                while let Some(request) = builder.next_read() {
                    assert_eq!(request.entry().id.as_str(), "language-entry", "{}", case.id);
                    builder
                        .accept(&request, case.document.text.as_bytes())
                        .unwrap();
                }
                let page = builder.finish().unwrap();
                assert_eq!(page.snapshot, *generation.id(), "{}", case.id);
                assert!(page.coverage_complete, "{}", case.id);
                for hit in page.hits {
                    assert_eq!(hit.entry.path.as_str(), case.document.path, "{}", case.id);
                    assert_eq!(
                        hit.entry.revision.as_str(),
                        "language-revision",
                        "{}",
                        case.id
                    );
                    hits.push(ExpectedHit {
                        line: hit.line,
                        range: hit.range,
                    });
                }
                token = page.next;
                if token.is_none() {
                    assert!(page.complete && page.scan_complete, "{}", case.id);
                    complete = true;
                    break;
                }
                assert!(!page.complete && !page.scan_complete, "{}", case.id);
            }
            assert!(complete, "{}: pagination failed to terminate", case.id);
            assert_eq!(
                hits, case.current_rust_literal.hits,
                "{} limit={limit}",
                case.id
            );
        }
    }
}
