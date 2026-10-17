use serde::Deserialize;
use zorid_document::{parse_markdown, DocumentMetadata, MetadataRequest};

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

#[test]
fn shared_markdown_corpus() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/markdown/corpus.json"
    ))
    .unwrap();
    for case in corpus.cases {
        let actual =
            parse_markdown(&case.request).unwrap_or_else(|error| panic!("{}: {error}", case.id));
        assert_eq!(actual, case.expected, "fixture {}", case.id);
    }
}
