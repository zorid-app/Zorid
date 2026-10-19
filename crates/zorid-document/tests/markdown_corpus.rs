#[path = "../../../tests/fixtures/document-semantics/markdown/legacy_projection.rs"]
mod legacy_projection;
use legacy_projection::{schema_one_projection, LegacyMetadata};
use serde::Deserialize;
use zorid_document::{parse_markdown, MetadataRequest};

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    request: MetadataRequest,
    expected: LegacyMetadata,
}

fn differences(
    expected: &serde_json::Value,
    actual: &serde_json::Value,
    path: &str,
    output: &mut Vec<String>,
) {
    match (expected, actual) {
        (serde_json::Value::Object(expected), serde_json::Value::Object(actual)) => {
            for (key, value) in expected {
                if let Some(actual) = actual.get(key) {
                    differences(value, actual, &format!("{path}.{key}"), output);
                } else {
                    output.push(format!("{path}.{key}: missing"));
                }
            }
        }
        (serde_json::Value::Array(expected), serde_json::Value::Array(actual)) => {
            if expected.len() != actual.len() {
                output.push(format!(
                    "{path}: expected {} entries, got {}",
                    expected.len(),
                    actual.len()
                ));
            }
            for (index, (expected, actual)) in expected.iter().zip(actual).enumerate() {
                differences(expected, actual, &format!("{path}[{index}]"), output);
            }
        }
        _ if expected != actual => {
            output.push(format!("{path}: expected {expected}, got {actual}"))
        }
        _ => {}
    }
}
#[test]
fn shared_markdown_corpus() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/markdown/corpus.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in corpus.cases {
        match parse_markdown(&case.request) {
            Ok(actual) if schema_one_projection(&actual) == case.expected => {}
            Ok(actual) => {
                let mut diff = Vec::new();
                differences(
                    &serde_json::to_value(&case.expected).unwrap(),
                    &serde_json::to_value(schema_one_projection(&actual)).unwrap(),
                    &case.id,
                    &mut diff,
                );
                if diff.is_empty() {
                    diff.push(format!("{}: ordered property mappings differ", case.id));
                }
                if actual.links != case.expected.links {
                    let options = pulldown_cmark::Options::ENABLE_TABLES
                        | pulldown_cmark::Options::ENABLE_STRIKETHROUGH
                        | pulldown_cmark::Options::ENABLE_TASKLISTS
                        | pulldown_cmark::Options::ENABLE_WIKILINKS;
                    let events: Vec<_> =
                        pulldown_cmark::Parser::new_ext(&case.request.source, options)
                            .into_offset_iter()
                            .filter(|(event, _)| {
                                matches!(
                                    event,
                                    pulldown_cmark::Event::Start(
                                        pulldown_cmark::Tag::Link { .. }
                                            | pulldown_cmark::Tag::Image { .. }
                                    )
                                )
                            })
                            .collect();
                    diff.push(format!("{}: raw upstream link events {events:?}", case.id));
                }
                failures.push(diff.join("\n"));
            }
            Err(error) => failures.push(format!("{}: extraction error {error}", case.id)),
        }
    }
    assert!(
        failures.is_empty(),
        "{} corpus cases failed:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
