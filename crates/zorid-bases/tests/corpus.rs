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
    request: Request,
    expected: Value,
    repeat: Option<usize>,
}
#[derive(Deserialize)]
struct Request {
    expression: String,
    record: DetachedRecord,
    options: EvaluationOptions,
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
        let actual = (0..case.repeat.unwrap_or(1))
            .map(|_| {
                match evaluate_expression(
                    &case.request.expression,
                    &case.request.record,
                    &case.request.options,
                ) {
                    Ok(value) => compact(&value.value),
                    Err(error) => json!({"type":"error","code":error.code}),
                }
            })
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
        "unavailable"
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
    // Percent is a literal; following letters still use Moment token meaning.
    assert_eq!(
        evaluate_expression("date(\"2024-01-15\").format(\"%Q\")", &record, &options)
            .unwrap()
            .value,
        BaseValue::String { value: "%1".into() }
    );
    assert_eq!(
        evaluate_expression("date(\"2024-01-15\").format(\"%z\")", &record, &options)
            .unwrap()
            .value,
        BaseValue::String { value: "%".into() }
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

#[test]
fn typed_date_properties_and_unbound_context_keep_their_meaning() {
    use zorid_bases::PropertyType;
    let record = DetachedRecord {
        path: "a.md".into(),
        properties: vec![
            (
                "Due".into(),
                PropertyValue::String("2024-01-15T10:00:00+02:00".into()),
            ),
            ("due".into(), PropertyValue::String("2024-01-16".into())),
        ],
        property_types: vec![
            ("Due".into(), PropertyType::Datetime),
            ("due".into(), PropertyType::Date),
        ],
        ..Default::default()
    };
    let before = record.clone();
    let options = EvaluationOptions::default();
    assert_eq!(
        evaluate_expression("DUE", &record, &options).unwrap().value,
        BaseValue::Date {
            timestamp: 1705305600000,
            has_time: true
        }
    );
    assert_eq!(
        evaluate_expression("due", &record, &options).unwrap().value,
        BaseValue::Date {
            timestamp: 1705363200000,
            has_time: false
        }
    );
    assert_eq!(record, before);
    assert_eq!(
        evaluate_expression("1+1", &DetachedRecord::default(), &options)
            .unwrap()
            .value,
        BaseValue::Number { value: 2.0 }
    );
    assert_eq!(
        evaluate_expression("file.path", &DetachedRecord::default(), &options)
            .unwrap()
            .value,
        BaseValue::Null
    );
    let invalid = DetachedRecord {
        path: "bad.md".into(),
        properties: vec![("date".into(), PropertyValue::String("2024-02-30".into()))],
        property_types: vec![("date".into(), PropertyType::Date)],
        ..Default::default()
    };
    assert_eq!(
        evaluate_expression("date", &invalid, &options)
            .unwrap()
            .value,
        BaseValue::Null
    );
}

#[test]
fn shared_metadata_date_hints_and_nested_case_order_are_observable() {
    let record = DetachedRecord {
        path: "a.md".into(),
        properties: vec![
            ("day".into(), PropertyValue::String("2024-01-15".into())),
            ("invalid".into(), PropertyValue::String("not a date".into())),
            (
                "config".into(),
                PropertyValue::Object(vec![
                    ("Title".into(), PropertyValue::String("first".into())),
                    ("title".into(), PropertyValue::String("second".into())),
                ]),
            ),
        ],
        property_types: vec![
            ("day".into(), zorid_bases::PropertyType::Date),
            ("invalid".into(), zorid_bases::PropertyType::Datetime),
        ],
        ..Default::default()
    };
    let options = EvaluationOptions::default();
    assert_eq!(
        evaluate_expression("day", &record, &options).unwrap().value,
        BaseValue::Date {
            timestamp: 1705276800000,
            has_time: false
        }
    );
    assert_eq!(
        evaluate_expression("invalid", &record, &options)
            .unwrap()
            .value,
        BaseValue::Null
    );
    assert_eq!(
        evaluate_expression("config.TITLE", &record, &options)
            .unwrap()
            .value,
        BaseValue::String {
            value: "first".into()
        }
    );
    let mut duplicate = record;
    duplicate
        .property_types
        .push(("day".into(), zorid_bases::PropertyType::Text));
    assert_eq!(
        evaluate_expression("day", &duplicate, &options)
            .unwrap_err()
            .code,
        "input"
    );
}
