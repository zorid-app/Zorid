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
// Selected cells have exact typed shapes and array order. Only error prose is
// outside this oracle; number equality matches JSON/JavaScript numeric values.
fn compact_errors(value: &Value) -> Value {
    match value {
        Value::Object(fields) if fields.get("type").and_then(Value::as_str) == Some("error") => {
            json!({"type":"error","code":fields.get("code")})
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), compact_errors(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(compact_errors).collect()),
        value => value.clone(),
    }
}
fn exact_json(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            a.len() == e.len()
                && e.iter()
                    .all(|(key, e)| a.get(key).is_some_and(|a| exact_json(a, e)))
        }
        (Value::Array(a), Value::Array(e)) => {
            a.len() == e.len() && a.iter().zip(e).all(|(a, e)| exact_json(a, e))
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
        let program = match compile_base(r.configuration) {
            Ok(program) => program,
            Err(error) => {
                failures.push(format!(
                    "{}: configuration failed to compile: {error}",
                    case.id
                ));
                continue;
            }
        };
        let result = match query_generation(&program, &generation, &r.facts, &r.options) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{}: {e}", case.id));
                continue;
            }
        };
        // The fixture deliberately declares selected columns per row. Project
        // precisely those observables, without changing values or the oracle.
        let values = case
            .expected
            .get("values")
            .and_then(Value::as_object)
            .map(|paths| {
                paths
                    .iter()
                    .map(|(path, expected)| {
                        let row = result.rows.iter().find(|row| &row.path == path);
                        let cells = expected
                            .as_object()
                            .expect("expected cell mapping")
                            .keys()
                            .map(|key| {
                                let actual = row
                                    .and_then(|row| row.values.get(key))
                                    .map(|value| serde_json::to_value(value).unwrap())
                                    .unwrap_or(Value::Null);
                                (key.clone(), actual)
                            })
                            .collect::<serde_json::Map<_, _>>();
                        (path.clone(), Value::Object(cells))
                    })
                    .collect::<serde_json::Map<_, _>>()
            })
            .unwrap_or_default();
        let actual = json!({"paths":result.rows.iter().map(|row|&row.path).collect::<Vec<_>>(),"snapshotId":result.snapshot_id,"relationshipsAvailable":result.relationships_available,"metadataComplete":result.metadata_complete,"metadataIssues":result.metadata_issues,"values":values});
        for (key, expected) in case.expected.as_object().unwrap() {
            let matches = if key == "diagnostics" {
                expected.as_array().unwrap().iter().all(|e| {
                    result
                        .diagnostics
                        .iter()
                        .any(|a| subset(&serde_json::to_value(a).unwrap(), e))
                })
            } else if key == "values" {
                actual
                    .get(key)
                    .is_some_and(|a| exact_json(&compact_errors(a), &compact_errors(expected)))
            } else {
                actual.get(key).is_some_and(|a| exact_json(a, expected))
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

#[test]
fn current_entry_selection_rejects_missing_conflicting_and_unbounded_contexts() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/bases/accepted-generation-queries.json"
    ))
    .unwrap();
    let request = corpus
        .cases
        .into_iter()
        .find(|case| case.id == "current-entry-base-file-facts-with-empty-properties")
        .unwrap()
        .request;
    let generation = Generation::from_sources(
        request.source,
        request.snapshot_id,
        request.entries,
        request.sources,
    )
    .unwrap();
    let program = compile_base(request.configuration)
        .expect("current-entry base context fixture must compile");
    let mut options = request.options;
    options.current_entry_id = Some(zorid_core::EntryId::new("missing-context").unwrap());
    assert_eq!(
        query_generation(&program, &generation, &request.facts, &options)
            .unwrap_err()
            .code,
        "stale-source"
    );
    options.current_entry_id = Some(zorid_core::EntryId::new("context-base").unwrap());
    let snapshot = BaseSnapshot::from_generation(&generation, &request.facts).unwrap();
    options.evaluation.current_record = snapshot
        .records()
        .iter()
        .find(|row| row.path == "Current.md")
        .cloned();
    assert_eq!(
        query_generation(&program, &generation, &request.facts, &options)
            .unwrap_err()
            .code,
        "stale-source"
    );
    options.evaluation.current_record = None;
    for steps in [0, 1, QueryOptions::default().max_steps + 1] {
        options.max_steps = steps;
        assert_eq!(
            query_generation(&program, &generation, &request.facts, &options)
                .unwrap_err()
                .code,
            "budget"
        );
    }
}

#[test]
fn current_entry_and_step_options_reject_present_null_and_duplicate_fields() {
    assert!(serde_json::from_str::<QueryOptions>("{}").is_ok());
    for raw in [
        r#"{"currentEntryId":null}"#,
        r#"{"maxSteps":null}"#,
        r#"{"currentEntryId":"one","currentEntryId":"two"}"#,
        r#"{"maxSteps":1,"maxSteps":2}"#,
    ] {
        assert!(serde_json::from_str::<QueryOptions>(raw).is_err(), "{raw}");
    }
}
