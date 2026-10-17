use serde::Deserialize;
use serde_json::{json, Value};
use zorid_bases::{
    compile_base, compile_base_source, query_base, BaseSnapshot, PropertyValue, QueryOptions,
};
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
struct Request {
    configuration: PropertyValue,
    snapshot: BaseSnapshot,
    options: QueryOptions,
}
#[test]
fn accepted_query_corpus_uses_shared_transport_requests() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/bases/accepted-queries.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in corpus.cases {
        let program = compile_base(case.request.configuration).unwrap();
        let result = match query_base(&program, &case.request.snapshot, &case.request.options) {
            Ok(result) => result,
            Err(error) => {
                failures.push(format!("{}: {error}", case.id));
                continue;
            }
        };
        let actual = json!({"paths":result.rows.iter().map(|row|&row.path).collect::<Vec<_>>(),"properties":result.properties,"counts":result.counts,"groups":result.groups,"groupOptions":result.group_options});
        for (key, expected) in case.expected.as_object().unwrap() {
            match key.as_str() {
                "values" => {
                    for (path, values) in expected.as_object().unwrap() {
                        let row = result.rows.iter().find(|row| &row.path == path).unwrap();
                        for (property, expected) in values.as_object().unwrap() {
                            let actual =
                                serde_json::to_value(row.values.get(property).unwrap()).unwrap();
                            if !json_equal(&actual, expected) {
                                failures.push(format!(
                                    "{}: {path} {property}: {actual} != {expected}",
                                    case.id
                                ));
                            }
                        }
                    }
                }
                "diagnostics" => {
                    for expected in expected.as_array().unwrap() {
                        if !result.diagnostics.iter().any(|diagnostic| {
                            let actual = serde_json::to_value(diagnostic).unwrap();
                            expected
                                .as_object()
                                .unwrap()
                                .iter()
                                .all(|(key, value)| actual.get(key) == Some(value))
                        }) {
                            failures.push(format!("{}: missing diagnostic {expected}", case.id));
                        }
                    }
                }
                key => {
                    if !actual
                        .get(key)
                        .is_some_and(|actual| json_equal(actual, expected))
                    {
                        failures.push(format!(
                            "{}: {key}: {} != {expected}",
                            case.id,
                            actual.get(key).unwrap_or(&Value::Null)
                        ));
                    }
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} query mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
#[test]
fn shared_yaml_decoder_preserves_unknown_configuration_and_raw_source() {
    let source =
        "\u{feff}# Keep me\r\nunknown: keep\r\nviews:\r\n  - type: custom\r\n    name: Custom\r\n";
    let before = source.to_string();
    let program = compile_base_source(source).unwrap();
    assert_eq!(source, before);
    assert_eq!(
        program.configuration.get("unknown"),
        Some(&PropertyValue::String("keep".into()))
    );
    assert!(compile_base_source("views: [\n").is_err());
    assert!(compile_base_source("views: []\nviews: []\n").is_err());
    assert!(compile_base_source("loop: &loop [*loop]\n").is_err());
    assert!(compile_base_source("").is_ok());
}
#[test]
fn query_limit_does_not_hide_resource_failure_or_missing_witness() {
    let program =
        compile_base_source("views:\n  - type: table\n    name: Table\n    limit: 1\n").unwrap();
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/bases/accepted-queries.json"
    ))
    .unwrap();
    let mut snapshot = corpus.cases.into_iter().next().unwrap().request.snapshot;
    assert_eq!(
        query_base(
            &program,
            &snapshot,
            &QueryOptions {
                max_steps: 1,
                ..Default::default()
            }
        )
        .unwrap_err()
        .code,
        "budget"
    );
    let mut records = snapshot.records().to_vec();
    records[0].witness = None;
    snapshot = BaseSnapshot::detached(snapshot.snapshot_id().clone(), records);
    assert_eq!(
        query_base(&program, &snapshot, &QueryOptions::default())
            .unwrap_err()
            .code,
        "input"
    );
}
fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| json_equal(a, b)))
        }
        _ => a == b,
    }
}
