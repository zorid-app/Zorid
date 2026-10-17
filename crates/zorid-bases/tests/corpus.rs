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
    expected: Value,
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
        "../../../tests/fixtures/document-semantics/bases/accepted-expressions.json"
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
        let expected = case.expected;
        if !json_equal(&actual, &expected) {
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

#[test]
fn boolean_paths_preserve_numeric_budget_and_cancellation_errors() {
    let record = DetachedRecord {
        path: "a.md".into(),
        ..Default::default()
    };
    for source in [
        "!(1/0)",
        "(1/0)||true",
        "if(1/0,1,2)",
        "[1].filter(1/0)",
        "[1].contains(1/0)",
        "[1].containsAll(1/0)",
        "(1).isType(1/0)",
        "/a/.matches(1/0)",
        "note[1/0]",
        "[1,2].reduce(if(index==0,1/0,7),0)",
    ] {
        assert_eq!(
            evaluate_expression(source, &record, &EvaluationOptions::default())
                .unwrap_err()
                .code,
            "numeric-domain",
            "{source}"
        );
    }
    for source in [
        "!true",
        "true && true",
        "false || true",
        "if(true,1,2)",
        "[1].filter(true)",
    ] {
        let options = EvaluationOptions {
            max_steps: 1,
            ..Default::default()
        };
        assert_eq!(
            evaluate_expression(source, &record, &options)
                .unwrap_err()
                .code,
            "budget",
            "{source}"
        );
    }
}

#[test]
fn numeric_and_calendar_edges_cannot_panic_or_erase_types() {
    let record = DetachedRecord {
        path: "a.md".into(),
        ..Default::default()
    };
    let options = EvaluationOptions::default();
    for source in [
        "1e400",
        "date(\"2024-01-15\")+duration(\"999999999999999999999 days\")",
        "date(\"2024-01-15\")+duration(\"-2147483648 months\")",
    ] {
        assert_eq!(
            evaluate_expression(source, &record, &options)
                .unwrap_err()
                .code,
            "numeric-domain",
            "{source}"
        );
    }
    assert_eq!(
        evaluate_expression("date(\"2024-01-15\").format(\"%Q\")", &record, &options)
            .unwrap_err()
            .code,
        "unsupported"
    );
    assert_eq!(
        evaluate_expression("date(\"2024-01-15\").format(\"%z\")", &record, &options)
            .unwrap_err()
            .code,
        "unsupported"
    );
    let huge = format!("duration(\"{} days\")", "9".repeat(400));
    assert_eq!(
        evaluate_expression(&huge, &record, &options)
            .unwrap_err()
            .code,
        "numeric-domain"
    );
    assert_eq!(
        evaluate_expression("\"x\".repeat(1000000).split(\"\",1)", &record, &options)
            .unwrap()
            .value,
        BaseValue::List {
            value: vec![BaseValue::String { value: "x".into() }]
        }
    );
    let record = DetachedRecord {
        properties: vec![(
            "items".into(),
            PropertyValue::Array(vec![PropertyValue::Null; 1000]),
        )],
        ..record
    };
    assert_eq!(
        evaluate_expression(
            "items.sum()",
            &record,
            &EvaluationOptions {
                max_steps: 5,
                ..options
            }
        )
        .unwrap_err()
        .code,
        "budget"
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

#[test]
fn repeated_membership_work_is_charged_before_traversal() {
    let record = DetachedRecord {
        path: "a.md".into(),
        properties: vec![(
            "items".into(),
            PropertyValue::Array(vec![PropertyValue::Number(1.into()); 50]),
        )],
        ..Default::default()
    };
    let options = EvaluationOptions {
        max_steps: 100,
        ..Default::default()
    };
    assert_eq!(
        evaluate_expression("items.containsAll(1,1,1)", &record, &options)
            .unwrap_err()
            .code,
        "budget"
    );
}
