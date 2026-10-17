use serde::Deserialize;
use serde_json::{json, Value};
use zorid_bases::{
    evaluate_expression, BaseValue, DetachedRecord, EvaluationOptions, PropertyValue,
};

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    expression: String,
    current: Value,
    proposed: Option<Value>,
    context: Option<Context>,
    repeat: Option<usize>,
}
#[derive(Default, Deserialize)]
struct Context {
    note: Option<PropertyValue>,
    formulas: Option<PropertyValue>,
    now: Option<String>,
    #[serde(rename = "maxSteps")]
    max_steps: Option<usize>,
}
fn pairs(value: Option<PropertyValue>) -> Vec<(String, PropertyValue)> {
    match value {
        Some(PropertyValue::Object(value)) => value,
        None => Vec::new(),
        _ => panic!("expected fixture object"),
    }
}
fn compact(value: &BaseValue) -> Value {
    match value {
        BaseValue::Error { code, .. } => json!({"type":"error","code":code}),
        BaseValue::List { value } => {
            json!({"type":"list","value":value.iter().map(compact).collect::<Vec<_>>()})
        }
        _ => serde_json::to_value(value).unwrap(),
    }
}
#[test]
fn accepted_expression_corpus_uses_reused_engine() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/bases/expressions.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in corpus.cases {
        let context = case.context.unwrap_or_default();
        let record = DetachedRecord {
            entry_id: "entry-a".into(),
            revision: "r1".into(),
            path: "a.md".into(),
            properties: pairs(context.note),
            ..Default::default()
        };
        let formulas = pairs(context.formulas)
            .into_iter()
            .map(|(name, value)| match value {
                PropertyValue::String(value) => (name, value),
                _ => panic!("formula string"),
            })
            .collect();
        let clock_ms = chrono::DateTime::parse_from_rfc3339(
            context.now.as_deref().unwrap_or("2024-01-15T10:20:30Z"),
        )
        .unwrap()
        .timestamp_millis();
        let options = EvaluationOptions {
            clock_ms,
            formulas,
            max_steps: context.max_steps.unwrap_or(100_000),
            ..Default::default()
        };
        let actual = (0..case.repeat.unwrap_or(1))
            .map(
                |_| match evaluate_expression(&case.expression, &record, &options) {
                    Ok(value) => compact(&value.value),
                    Err(error) => json!({"type":"error","code":error.code}),
                },
            )
            .collect::<Vec<_>>();
        let actual = if case.repeat.is_some() {
            Value::Array(actual)
        } else {
            actual.into_iter().next().unwrap()
        };
        let expected = case.proposed.unwrap_or(case.current);
        if actual != expected {
            failures.push(format!("{}: expected {expected}, actual {actual}", case.id));
        }
    }
    assert!(
        failures.is_empty(),
        "{} accepted corpus mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
#[test]
fn budgets_cancellation_and_missing_host_facts_are_observable() {
    let record = DetachedRecord {
        path: "a.md".into(),
        ..Default::default()
    };
    let options = EvaluationOptions::default();
    assert_eq!(
        evaluate_expression("file.ctime", &record, &options)
            .unwrap()
            .value,
        BaseValue::Null
    );
    assert_eq!(
        evaluate_expression("file.links.length", &record, &options)
            .unwrap_err()
            .code,
        "unsupported"
    );
    let cancellation = zorid_bases::OperationCancellation::default();
    cancellation.cancel();
    assert_eq!(
        evaluate_expression(
            "1",
            &record,
            &EvaluationOptions {
                cancellation: Some(cancellation),
                ..options.clone()
            }
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
    let deep = format!("{}1{}", "(".repeat(129), ")".repeat(129));
    assert_eq!(
        evaluate_expression(&deep, &record, &options)
            .unwrap_err()
            .code,
        "parse"
    );
    assert!(evaluate_expression("\"x\".repeat(10000000)", &record, &options).is_err());
    assert_eq!(
        evaluate_expression("/(?=a)/.matches(\"a\")", &record, &options)
            .unwrap_err()
            .code,
        "unsupported"
    );
}
