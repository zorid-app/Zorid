use serde::Deserialize;
use serde_json::{json, Value};
use zorid_bases::{
    compile_base, compile_base_source, query_base, BaseSnapshot, DetachedRecord, PropertyValue,
    QueryOptions,
};
#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    document: PropertyValue,
    snapshot: Snapshot,
    options: Options,
    current: Value,
    proposed: Option<Value>,
}
#[derive(Deserialize)]
struct Snapshot {
    version: String,
    files: Vec<File>,
}
#[derive(Deserialize)]
struct File {
    path: String,
    properties: Option<PropertyValue>,
    tags: Option<Vec<String>>,
    size: Option<u64>,
    ctime: Option<i64>,
    mtime: Option<i64>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    current_file_path: Option<String>,
    search_terms: Option<Vec<String>>,
}
fn record(file: File) -> DetachedRecord {
    let properties = match file.properties {
        Some(PropertyValue::Object(value)) => value,
        None => Vec::new(),
        _ => panic!("fixture property mapping"),
    };
    DetachedRecord {
        entry_id: file.path.clone(),
        revision: "r1".into(),
        path: file.path,
        properties,
        tags: file.tags.unwrap_or_default(),
        size: file.size,
        ctime_ms: file.ctime,
        mtime_ms: file.mtime,
    }
}
#[test]
fn accepted_query_corpus_uses_one_row_scoped_evaluator() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/bases/queries.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in corpus.cases {
        let snapshot = BaseSnapshot {
            snapshot_id: case.snapshot.version,
            records: case.snapshot.files.into_iter().map(record).collect(),
        };
        let mut options = QueryOptions {
            search_terms: case.options.search_terms.unwrap_or_default(),
            ..Default::default()
        };
        options.evaluation.clock_ms = 1705314030000;
        options.evaluation.current_record = case.options.current_file_path.and_then(|path| {
            snapshot
                .records
                .iter()
                .find(|record| record.path == path)
                .cloned()
        });
        let program = compile_base(case.document).unwrap();
        let result = match query_base(&program, &snapshot, &options) {
            Ok(result) => result,
            Err(error) => {
                failures.push(format!("{}: {error}", case.id));
                continue;
            }
        };
        let actual = json!({"paths":result.rows.iter().map(|row|&row.path).collect::<Vec<_>>(),"properties":result.properties,"counts":result.counts,"groups":result.groups.iter().map(|group|json!({"key":group.key,"paths":group.entry_ids})).collect::<Vec<_>>(),"groupOptions":result.group_options});
        let expected = case.proposed.unwrap_or(case.current);
        for (key, expected) in expected.as_object().unwrap() {
            match key.as_str() {
                "values" => {
                    for (path, values) in expected.as_object().unwrap() {
                        let row = result.rows.iter().find(|row| &row.path == path).unwrap();
                        for (property, expected) in values.as_object().unwrap() {
                            let actual =
                                serde_json::to_value(row.values.get(property).unwrap()).unwrap();
                            if actual != *expected {
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
                        let found = result.diagnostics.iter().any(|diagnostic| {
                            let actual = serde_json::to_value(diagnostic).unwrap();
                            expected
                                .as_object()
                                .unwrap()
                                .iter()
                                .all(|(key, value)| actual.get(key) == Some(value))
                        });
                        if !found {
                            failures.push(format!("{}: missing diagnostic {expected}", case.id));
                        }
                    }
                }
                key => {
                    if actual.get(key) != Some(expected) {
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
fn query_limit_does_not_hide_resource_failure() {
    let program =
        compile_base_source("views:\n  - type: table\n    name: Table\n    limit: 1\n").unwrap();
    let snapshot = BaseSnapshot {
        snapshot_id: "g1".into(),
        records: vec![DetachedRecord {
            entry_id: "a".into(),
            revision: "r1".into(),
            path: "a.md".into(),
            ..Default::default()
        }],
    };
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
}
