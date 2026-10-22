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

#[test]
fn regex_wrappers_belong_to_definition_nodes_and_survive_syntax_cache_eviction() {
    let formulas = vec![("a".into(), "/a/".into()), ("b".into(), "/a/".into())];
    let prepared = prepare_formula_expressions(&formulas, &mut yes, &mut yes).unwrap();
    let context = BasesEvaluationContext {
        formulas: Arc::new(formulas.into_iter().collect()),
        preparsed_formulas: Some(prepared),
        ..Default::default()
    };
    let expression = Parser::parse("[formula.a,formula.b,formula.a].unique().length").unwrap();
    let mut first = Evaluator::new(&context);
    assert!(matches!(
        first.evaluate(&expression, &Scope::new()),
        RuntimeValue::Number(2.0)
    ));
    let a = first.formula("a");
    for n in 0..70 {
        parse_cached(&format!("{n} + 1")).unwrap();
    }
    let mut second = Evaluator::new(&context);
    assert!(strict(&a, &second.formula("a")));
    assert!(!strict(&a, &second.formula("b")));
    let callback = Parser::parse("[1,2].map(/a/).unique().length").unwrap();
    assert!(matches!(
        second.evaluate(&callback, &Scope::new()),
        RuntimeValue::Number(1.0)
    ));
    let a = first.formula("a");
    let b = first.formula("b");
    assert!(first.equals_checked(&a, &a.clone()).unwrap());
    assert!(!first.equals_checked(&a, &b).unwrap());
    assert!(!first
        .equals_checked(&a, &RuntimeValue::String("/a/".into()))
        .unwrap());
    assert!(first
        .equals_checked(&RuntimeValue::List(vec![a.clone()]), &a)
        .unwrap());
}

#[test]
fn strict_identity_keys_match_constructor_equality_and_preserve_actual_label_data() {
    fn key(value: &RuntimeValue, context: &mut StrictIdentityContext) -> String {
        strict_runtime_identity_key(value, context, &mut yes, &mut yes).unwrap()
    }
    let mut context = StrictIdentityContext::default();
    let mut a = match source_link(Some("A"), Some("")) {
        RuntimeValue::Link(link) => link,
        _ => unreachable!(),
    };
    a.display_value = Some(Box::new(RuntimeValue::String("One".into())));
    let mut b = a.clone();
    b.display_value = Some(Box::new(RuntimeValue::String("Two".into())));
    assert_ne!(
        key(&object(RuntimeValue::Link(a.clone())), &mut context),
        key(&object(RuntimeValue::Link(b)), &mut context)
    );
    assert_eq!(
        key(&RuntimeValue::Number(-0.0), &mut context),
        key(&RuntimeValue::Number(0.0), &mut context)
    );
    assert_ne!(
        key(&RuntimeValue::Tag("#a".into()), &mut context),
        key(&RuntimeValue::String("#a".into()), &mut context)
    );
    let absent = RuntimeValue::Link(BasesLink {
        display_value: None,
        ..a.clone()
    });
    let null = RuntimeValue::Link(BasesLink {
        display_value: Some(Box::new(RuntimeValue::Null)),
        ..a.clone()
    });
    let zero = RuntimeValue::Link(BasesLink {
        display_value: Some(Box::new(RuntimeValue::Number(0.0))),
        ..a.clone()
    });
    assert_eq!(key(&absent, &mut context), key(&null, &mut context));
    assert_ne!(key(&absent, &mut context), key(&zero, &mut context));
    let mut external = a.clone();
    external.external = true;
    let mut other_origin = external.clone();
    other_origin.raw_destination = None;
    other_origin.source_path = None;
    assert_eq!(
        key(&RuntimeValue::Link(external), &mut context),
        key(&RuntimeValue::Link(other_origin), &mut context)
    );
    let left = RuntimeValue::Object(IndexMap::from_iter([
        ("b".into(), RuntimeValue::Number(2.0)),
        ("a".into(), RuntimeValue::Number(1.0)),
    ]));
    let right = RuntimeValue::Object(IndexMap::from_iter([
        ("a".into(), RuntimeValue::Number(1.0)),
        ("b".into(), RuntimeValue::Number(2.0)),
    ]));
    assert_eq!(key(&left, &mut context), key(&right, &mut context));
    let rx = RuntimeValue::Regex("a".into(), "".into(), Arc::new(()));
    assert_eq!(key(&rx, &mut context), key(&rx.clone(), &mut context));
    assert_ne!(
        key(&rx, &mut context),
        key(
            &RuntimeValue::Regex("a".into(), "".into(), Arc::new(())),
            &mut context
        )
    );
    assert!(
        matches!(strict_runtime_identity_key(&source_link(None, None), &mut context, &mut yes, &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("unavailable\0"))
    );
}

#[test]
fn strict_identity_admits_allocations_and_polls_registry_and_file_copy_work() {
    let rx = RuntimeValue::Regex("a".into(), "".into(), Arc::new(()));
    let mut context = StrictIdentityContext::default();
    let denied = strict_runtime_identity_key(
        &rx,
        &mut context,
        &mut |_| Err(RuntimeValue::Error("budget\0no allocation".into())),
        &mut yes,
    );
    assert!(matches!(denied, Err(RuntimeValue::Error(message)) if message.starts_with("budget\0")));
    assert!(context.regex_tokens.is_empty());
    let mut reserved = 0;
    strict_runtime_identity_key(
        &rx,
        &mut context,
        &mut |bytes| {
            reserved += bytes;
            Ok(())
        },
        &mut yes,
    )
    .unwrap();
    assert!(reserved >= 64 + std::mem::size_of::<Arc<()>>());
    let before = context.regex_tokens.len();
    assert!(
        matches!(context.regex_ordinal(&Arc::new(()), &mut yes, &mut |_| Err(RuntimeValue::Error("cancelled\0stop".into()))), Err(RuntimeValue::Error(message)) if message.starts_with("cancelled\0"))
    );
    assert_eq!(context.regex_tokens.len(), before);
    let file = RuntimeValue::File(Box::new(BasesFile {
        path: "A.md".into(),
        properties: IndexMap::from_iter([("large".into(), RuntimeValue::String("x".repeat(4096)))]),
        ..Default::default()
    }));
    // A bucket only needs the filename. Copying a retained result needs the
    // entire captured metadata tree and must poll it before cloning.
    let mut bucket_work = 0;
    assert_eq!(
        unique_bucket_key(&file, &mut |n| {
            bucket_work += n;
            Ok(())
        })
        .unwrap(),
        "A.md"
    );
    let mut copy_work = 0;
    charged_value_bytes(&file, &mut |n| {
        copy_work += n;
        Ok(())
    })
    .unwrap();
    assert!(copy_work > bucket_work + 200);
    let long_keys = RuntimeValue::Object(IndexMap::from_iter(
        (0..20).map(|n| (format!("{}{n}", "x".repeat(1000)), RuntimeValue::Null)),
    ));
    let mut work = 100usize;
    assert!(
        matches!(strict_runtime_identity_key(&long_keys, &mut context, &mut yes, &mut |n| {work = work.checked_sub(n).ok_or_else(|| RuntimeValue::Error("budget\0sort work".into()))?; Ok(())}), Err(RuntimeValue::Error(message)) if message.starts_with("budget\0"))
    );
}

#[test]
fn prepared_formula_retention_is_admitted_and_keeps_more_than_cache_capacity() {
    let formulas: Vec<_> = (0..70).map(|n| (format!("rx{n}"), "/a/".into())).collect();
    assert!(
        matches!(prepare_formula_expressions(&formulas, &mut |_| Err(RuntimeValue::Error("budget\0no map".into())), &mut yes), Err(RuntimeValue::Error(message)) if message.starts_with("budget\0"))
    );
    assert!(
        matches!(prepare_formula_expressions(&formulas, &mut yes, &mut |_| Err(RuntimeValue::Error("cancelled\0stop".into()))), Err(RuntimeValue::Error(message)) if message.starts_with("cancelled\0"))
    );
    let mut retained = 0usize;
    let prepared = prepare_formula_expressions(
        &formulas,
        &mut |bytes| {
            retained += bytes;
            Ok(())
        },
        &mut yes,
    )
    .unwrap();
    assert!(retained > 70 * std::mem::size_of::<Expr>());
    let context = BasesEvaluationContext {
        formulas: Arc::new(formulas.into_iter().collect()),
        preparsed_formulas: Some(prepared),
        ..Default::default()
    };
    let mut a = Evaluator::new(&context);
    let mut b = Evaluator::new(&context);
    assert!(strict(&a.formula("rx0"), &b.formula("rx0")));
    assert!(strict(&a.formula("rx69"), &b.formula("rx69")));
    assert!(!strict(&a.formula("rx0"), &b.formula("rx69")));
    assert_eq!(regex_string("", "ig"), "/(?:)/gi");
    assert_eq!(
        regex_string("a/b\n\r\u{2028}\u{2029}", "mi"),
        "/a\\/b\\n\\r\\u2028\\u2029/im"
    );
}
