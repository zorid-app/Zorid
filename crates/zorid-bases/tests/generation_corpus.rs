use serde::Deserialize;
use serde_json::{json, Value};
use zorid_bases::{
    compile_base, query_generation, BaseSnapshot, FilePresentationFacts, PropertyValue,
    QueryOptions,
};
use zorid_core::EntryState;
use zorid_index::{Generation, GenerationSource, IndexSnapshotId, SourceSnapshotId};
#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    request: Request,
    expected: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    source: SourceSnapshotId,
    snapshot_id: IndexSnapshotId,
    entries: Vec<EntryState>,
    sources: Vec<GenerationSource>,
    facts: Vec<FilePresentationFacts>,
    configuration: PropertyValue,
    options: QueryOptions,
}
fn subset(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => e
            .iter()
            .all(|(key, value)| a.get(key).is_some_and(|a| subset(a, value))),
        (Value::Array(a), Value::Array(e)) => {
            a.len() == e.len() && a.iter().zip(e).all(|(a, e)| subset(a, e))
        }
        (Value::Number(a), Value::Number(e)) => a.as_f64() == e.as_f64(),
        _ => actual == expected,
    }
}
#[test]
fn generation_factory_canonical_graph_corpus() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/bases/accepted-generation-queries.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in corpus.cases {
        let r = case.request;
        let generation =
            Generation::from_sources(r.source, r.snapshot_id, r.entries, r.sources).unwrap();
        let program = compile_base(r.configuration).unwrap();
        let result = match query_generation(&program, &generation, &r.facts, &r.options) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{}: {e}", case.id));
                continue;
            }
        };
        let values = result
            .rows
            .iter()
            .map(|row| (row.path.clone(), serde_json::to_value(&row.values).unwrap()))
            .collect::<serde_json::Map<_, _>>();
        let actual = json!({"paths":result.rows.iter().map(|row|&row.path).collect::<Vec<_>>(),"snapshotId":result.snapshot_id,"relationshipsAvailable":result.relationships_available,"values":values});
        for (key, expected) in case.expected.as_object().unwrap() {
            let matches = if key == "diagnostics" {
                expected.as_array().unwrap().iter().all(|e| {
                    result
                        .diagnostics
                        .iter()
                        .any(|a| subset(&serde_json::to_value(a).unwrap(), e))
                })
            } else {
                actual.get(key).is_some_and(|a| subset(a, expected))
            };
            if !matches {
                failures.push(format!(
                    "{} {key}: {} != {expected}",
                    case.id,
                    actual.get(key).unwrap_or(&Value::Null)
                ));
            }
        }
        let snapshot = BaseSnapshot::from_generation(&generation, &r.facts).unwrap();
        let mut options = r.options;
        options.evaluation.current_record = snapshot.records().first().cloned();
        if let Some(record) = options.evaluation.current_record.as_mut() {
            record.tags.push("spoofed".into());
        }
        assert_eq!(
            query_generation(&program, &generation, &r.facts, &options)
                .unwrap_err()
                .code,
            "stale-source"
        );
    }
    assert!(
        failures.is_empty(),
        "{} graph mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
#[test]
fn detached_transport_cannot_import_a_relationship_report() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/bases/accepted-generation-queries.json"
    ))
    .unwrap();
    let id = &corpus.cases[0].request.snapshot_id;
    assert!(serde_json::from_value::<BaseSnapshot>(
        json!({"snapshotId":id,"records":[],"relationships":{}})
    )
    .is_err());
}
