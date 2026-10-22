use super::*;

fn yes(_: usize) -> Result<(), RuntimeValue> {
    Ok(())
}
fn source_link(raw: Option<&str>, source: Option<&str>) -> RuntimeValue {
    RuntimeValue::Link(BasesLink {
        raw_destination: raw.map(String::from),
        source_path: source.map(String::from),
        path: "Authors/Ada.md".into(),
        ..Default::default()
    })
}
fn strict(left: &RuntimeValue, right: &RuntimeValue) -> bool {
    strict_values_equal(left, right, &mut yes).unwrap()
}
fn object(value: RuntimeValue) -> RuntimeValue {
    RuntimeValue::Object(IndexMap::from_iter([("value".into(), value)]))
}

#[test]
fn strict_link_equality_uses_original_destination_origin_and_constructor_label() {
    let first = source_link(Some("../Authors/Ada"), Some("Notes/First.md"));
    assert!(strict(&first, &first.clone()));
    assert!(!strict(
        &first,
        &source_link(Some("../Authors/Ada"), Some("Notes/Second.md"))
    ));
    assert!(!strict(
        &first,
        &source_link(Some("Authors/Ada"), Some("Notes/First.md"))
    ));
    assert!(
        matches!(strict_values_equal(&first, &source_link(None, None), &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("unavailable\0"))
    );
    assert!(
        matches!(unique_bucket_key(&source_link(None, None), &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("unavailable\0"))
    );
    let mut number_label = match source_link(Some("A"), Some("")) {
        RuntimeValue::Link(link) => link,
        _ => unreachable!(),
    };
    number_label.display_value = Some(Box::new(RuntimeValue::Number(0.0)));
    let mut string_label = number_label.clone();
    string_label.display_value = Some(Box::new(RuntimeValue::String("0".into())));
    let a = RuntimeValue::Link(number_label);
    let b = RuntimeValue::Link(string_label);
    assert_eq!(unique_bucket_key(&a, &mut yes).unwrap(), "[[A|0]]");
    assert_eq!(
        unique_bucket_key(&a, &mut yes).unwrap(),
        unique_bucket_key(&b, &mut yes).unwrap()
    );
    assert!(!strict(&a, &b));
}

#[test]
fn strict_files_require_captured_incarnation_and_revision_instead_of_matching_paths() {
    let file = |id: &str, revision: &str| {
        RuntimeValue::File(Box::new(BasesFile {
            path: "Same.md".into(),
            witness: Some(
                serde_json::from_value(serde_json::json!({"entryId":id,"revision":revision}))
                    .unwrap(),
            ),
            ..Default::default()
        }))
    };
    assert!(strict(&file("a", "r1"), &file("a", "r1")));
    assert!(!strict(&file("a", "r1"), &file("b", "r1")));
    assert!(!strict(&file("a", "r1"), &file("a", "r2")));
    assert!(
        matches!(strict_values_equal(&file("a", "r1"), &RuntimeValue::File(Box::new(BasesFile { path: "Same.md".into(), ..Default::default() })), &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("unavailable\0"))
    );
}

#[test]
fn strict_nested_objects_keep_tag_containers_scalars_dates_and_real_errors_distinct() {
    let tag = RuntimeValue::Tag("#a".into());
    let string = RuntimeValue::String("#a".into());
    assert!(!strict(&object(tag.clone()), &object(string.clone())));
    assert!(!strict(
        &object(RuntimeValue::TagList(vec![tag.clone()])),
        &object(RuntimeValue::List(vec![tag.clone()]))
    ));
    assert!(strict(
        &object(RuntimeValue::TagList(vec![tag.clone()])),
        &object(RuntimeValue::TagList(vec![tag]))
    ));
    let date = DateValue {
        millis: 0,
        date_only: true,
        timezone: BasesTimezone::Utc,
    };
    assert!(!strict(
        &RuntimeValue::Date(date.clone()),
        &RuntimeValue::Date(DateValue {
            date_only: false,
            ..date
        })
    ));
    assert!(strict(
        &RuntimeValue::ErrorValue("first\0message".into()),
        &RuntimeValue::ErrorValue("second\0message".into())
    ));
    assert!(!strict(
        &RuntimeValue::ErrorValue("first\0message".into()),
        &string
    ));
    // Diagnostic operands are visited even if a structural mismatch could have
    // short-circuited the equality result to false.
    assert!(
        matches!(strict_values_equal(&object(RuntimeValue::Error("cancelled\0stop".into())), &RuntimeValue::Object(IndexMap::new()), &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("cancelled\0"))
    );
}

#[test]
fn bucket_keys_use_reference_object_string_values_integer_order_and_json_escaping() {
    let value = RuntimeValue::Object(IndexMap::from_iter([
        ("2".into(), RuntimeValue::Number(2.0)),
        ("1".into(), RuntimeValue::String("1".into())),
        (
            "z".into(),
            RuntimeValue::List(vec![RuntimeValue::Null, RuntimeValue::Bool(true)]),
        ),
    ]));
    assert_eq!(
        unique_bucket_key(&value, &mut yes).unwrap(),
        r#"{"1":"1","2":"2","z":"null, true"}"#
    );
    let escaped = RuntimeValue::Object(IndexMap::from_iter([(
        "quote\"\n".into(),
        RuntimeValue::String("line\n\u{1}\\".into()),
    )]));
    let encoded = unique_bucket_key(&escaped, &mut yes).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&encoded).unwrap(),
        serde_json::json!({"quote\"\n":"line\n\u{1}\\"})
    );
}

#[test]
fn regex_identity_is_fresh_per_construction_and_shared_by_formula_cache_clones() {
    let context = BasesEvaluationContext {
        formulas: Arc::new(IndexMap::from_iter([("rx".into(), "/a/".into())])),
        ..Default::default()
    };
    let mut evaluator = Evaluator::new(&context);
    let expression = Parser::parse("[formula.rx,formula.rx].unique().length").unwrap();
    assert!(matches!(
        evaluator.evaluate(&expression, &Scope::new()),
        RuntimeValue::Number(1.0)
    ));
    let a = evaluator.evaluate(&Parser::parse("/a/").unwrap(), &Scope::new());
    let b = evaluator.evaluate(&Parser::parse("/a/").unwrap(), &Scope::new());
    assert!(!strict(&a, &b));
    assert!(strict(&a, &a.clone()));
}

#[test]
fn nested_strict_and_bucket_work_are_charged_and_depth_cancellation_stays_explicit() {
    let nested = object(RuntimeValue::List(vec![
        RuntimeValue::String("same".into());
        100
    ]));
    let mut left = 20usize;
    let error = strict_values_equal(&nested, &nested, &mut |work| {
        left = left
            .checked_sub(work)
            .ok_or_else(|| RuntimeValue::Error("budget\0test work exhausted".into()))?;
        Ok(())
    })
    .unwrap_err();
    assert!(matches!(error, RuntimeValue::Error(message) if message.starts_with("budget\0")));
    assert!(
        matches!(unique_bucket_key(&nested, &mut |_| Err(RuntimeValue::Error("cancelled\0stop".into()))), Err(RuntimeValue::Error(message)) if message.starts_with("cancelled\0"))
    );
    let mut deep = RuntimeValue::Null;
    for _ in 0..130 {
        deep = RuntimeValue::List(vec![deep]);
    }
    assert!(
        matches!(unique_bucket_key(&deep, &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("budget\0"))
    );
    assert!(
        matches!(flatten_values(&[deep], &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("budget\0"))
    );
}
