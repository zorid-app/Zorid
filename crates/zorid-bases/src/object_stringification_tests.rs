use super::*;

fn object(values: &[(&str, RuntimeValue)]) -> RuntimeValue {
    RuntimeValue::Object(
        values
            .iter()
            .map(|(key, value)| ((*key).into(), value.clone()))
            .collect(),
    )
}
fn text(value: &RuntimeValue) -> String {
    stringify_checked(value, &mut |_| Ok(())).unwrap()
}
fn evaluated(source: &str, value: RuntimeValue) -> BaseValue {
    let context = BasesEvaluationContext {
        note: IndexMap::from([("payload".into(), value)]),
        ..Default::default()
    };
    evaluate(source, &context).unwrap().value
}
fn expected(value: &str) -> BaseValue {
    BaseValue::String {
        value: value.into(),
    }
}

#[test]
fn object_to_string_uses_child_strings_without_changing_typed_json() {
    let value = object(&[
        ("n", RuntimeValue::Number(1.0)),
        ("b", RuntimeValue::Bool(true)),
        ("none", RuntimeValue::Null),
    ]);
    let oracle = r#"{"n":"1","b":"true","none":"null"}"#;
    assert_eq!(text(&value), oracle);
    assert_eq!(
        evaluated("note.payload.toString()", value.clone()),
        expected(oracle)
    );
    // to_plain remains typed projection, not reference toString.
    assert_eq!(
        to_plain(&value),
        serde_json::json!({"n":1.0,"b":true,"none":null})
    );
}

#[test]
fn recursive_children_use_their_actual_typed_string_representation() {
    let link = RuntimeValue::Link(BasesLink {
        path: "Canonical/A.md".into(),
        raw_destination: Some("A#H".into()),
        source_path: Some("Owner.md".into()),
        display: Some("Ali".into()),
        ..Default::default()
    });
    let value = object(&[
        ("nested", object(&[("x", RuntimeValue::Number(1.0))])),
        (
            "items",
            RuntimeValue::List(vec![
                RuntimeValue::Number(1.0),
                RuntimeValue::Null,
                RuntimeValue::Bool(true),
            ]),
        ),
        ("tag", RuntimeValue::Tag("#Topic/Child".into())),
        ("link", link),
        ("problem", RuntimeValue::ErrorValue("type\0bad".into())),
    ]);
    assert_eq!(
        text(&value),
        r##"{"nested":"{\"x\":\"1\"}","items":"1, null, true","tag":"#Topic/Child","link":"[[A#H|Ali]]","problem":"Error: bad"}"##
    );
}

#[test]
fn object_own_key_order_keeps_numeric_indices_and_safe_user_keys() {
    let value = object(&[
        ("z", RuntimeValue::Number(9.0)),
        ("2", RuntimeValue::Number(2.0)),
        ("1", RuntimeValue::Number(1.0)),
        ("01", RuntimeValue::Number(0.0)),
        ("__proto__", RuntimeValue::String("kept".into())),
        ("constructor", RuntimeValue::String("data".into())),
    ]);
    // Deliberate Zorid data-preservation choice: unlike assignment to the
    // reference's temporary {}, __proto__ remains an ordinary inert user key.
    assert_eq!(
        text(&value),
        r#"{"1":"1","2":"2","z":"9","01":"0","__proto__":"kept","constructor":"data"}"#
    );
    let RuntimeValue::Object(values) = value else {
        unreachable!()
    };
    assert_eq!(values.len(), 6);
}

#[test]
fn concatenation_join_sort_and_computed_access_share_checked_strings() {
    let value = object(&[("n", RuntimeValue::Number(1.0))]);
    assert_eq!(
        evaluated("note.payload + '!'", value.clone()),
        expected(r#"{"n":"1"}!"#)
    );
    assert_eq!(
        evaluated("'!' + note.payload", value.clone()),
        expected(r#"!{"n":"1"}"#)
    );
    assert_eq!(
        evaluated("[note.payload, null, true].join('|')", value.clone()),
        expected(r#"{"n":"1"}|null|true"#)
    );
    let context = BasesEvaluationContext {
        note: IndexMap::from([
            ("payload".into(), value.clone()),
            (
                r#"{"n":"1"}"#.into(),
                RuntimeValue::String("selected".into()),
            ),
        ]),
        ..Default::default()
    };
    assert_eq!(
        evaluate("note[note.payload]", &context).unwrap().value,
        expected("selected")
    );
    let list = RuntimeValue::List(vec![object(&[("z", RuntimeValue::Number(1.0))]), value]);
    assert_eq!(
        evaluated("note.payload.sort().join('|')", list),
        expected(r#"{"n":"1"}|{"z":"1"}"#)
    );
    assert_eq!(
        evaluated("[10,2,1].sort().join(',')", RuntimeValue::Null),
        expected("1,2,10")
    );
}

#[test]
fn groups_and_summary_values_use_the_same_reference_object_text() {
    let value = object(&[("n", RuntimeValue::Number(1.0))]);
    let spelling = r#"{"n":"1"}"#;
    assert_eq!(
        group_value_string(&value, &mut |_| Ok(())).unwrap(),
        spelling
    );
    assert!(group_values_match(
        &RuntimeValue::String(spelling.into()),
        &value,
        true,
        &BasesTimezone::Utc,
        None,
        &crate::EvaluationOptions::default(),
        &mut |_| Ok(())
    )
    .unwrap());
    assert!(!group_values_match(
        &RuntimeValue::String(spelling.into()),
        &value,
        false,
        &BasesTimezone::Utc,
        None,
        &crate::EvaluationOptions::default(),
        &mut |_| Ok(())
    )
    .unwrap());
    let base = BaseValue::Object {
        value: vec![("n".into(), BaseValue::Number { value: 1.0 })],
    };
    let result = evaluate_summary(
        "values[0].toString()",
        &[&base],
        &[],
        None,
        &crate::EvaluationOptions::default(),
        None,
        None,
        |_| unreachable!(),
    )
    .unwrap();
    assert_eq!(result.value, expected(spelling));
}

#[test]
fn common_link_text_keeps_legacy_display_while_unique_requires_origin() {
    let mut link = BasesLink {
        path: "Folder/File#literal.md".into(),
        subpath: Some("#Heading".into()),
        resolved_path: Some(Some("Folder/File#literal.md".into())),
        display_value: Some(Box::new(object(&[("n", RuntimeValue::Number(1.0))]))),
        ..Default::default()
    };
    let value = RuntimeValue::Link(link.clone());
    assert_eq!(
        text(&value),
        r#"[[Folder/File#literal.md#Heading|{"n":"1"}]]"#
    );
    let failure = unique_bucket_key(&value, &mut |_| Ok(())).unwrap_err();
    assert_eq!(runtime_diagnostic(failure).code, "unavailable");
    assert!(link.raw_destination.is_none() && link.source_path.is_none());
    link.raw_destination = Some("../File#Heading".into());
    link.source_path = Some("Owner/Source.md".into());
    assert_eq!(
        text(&RuntimeValue::Link(link.clone())),
        r#"[[../File#Heading|{"n":"1"}]]"#
    );
    assert_eq!(
        unique_bucket_key(&RuntimeValue::Link(link), &mut |_| Ok(())).unwrap(),
        r#"[[../File#Heading|{"n":"1"}]]"#
    );
}

#[test]
fn captured_internal_link_string_methods_read_original_data_without_mutating_lookup_path() {
    let link = BasesLink {
        path: "Canonical/Resolved.md".into(),
        raw_destination: Some("../Original#H".into()),
        source_path: Some("Owner/Source.md".into()),
        display: Some("Alias".into()),
        subpath: Some("#H".into()),
        resolved_path: Some(Some("Canonical/Resolved.md".into())),
        ..Default::default()
    };
    let value = RuntimeValue::Link(link.clone());
    assert_eq!(string_data(&value), Some("../Original#H"));
    assert_eq!(
        evaluated("note.payload.startsWith('../Original')", value.clone()),
        BaseValue::Boolean { value: true }
    );
    assert_eq!(
        evaluated("note.payload.contains('#H')", value.clone()),
        BaseValue::Boolean { value: true }
    );
    assert_eq!(
        evaluated("note.payload.toString()", value),
        expected("[[../Original#H|Alias]]")
    );
    assert_eq!(evaluated("note.payload.length", RuntimeValue::Link(link.clone())), BaseValue::Number { value: 13.0 });
    assert_eq!(evaluated("note.payload.lower()", RuntimeValue::Link(link.clone())), expected("../original#h"));
    assert_eq!(link.path, "Canonical/Resolved.md");
    assert_eq!(
        link.resolved_path,
        Some(Some("Canonical/Resolved.md".into()))
    );
    let external = RuntimeValue::Link(BasesLink {
        external: true,
        path: "https://example.test/x".into(),
        raw_destination: Some("wrong".into()),
        ..Default::default()
    });
    assert_eq!(string_data(&external), Some("https://example.test/x"));
}

#[test]
fn json_escaping_is_exact_and_failed_conversion_is_not_silently_stringified() {
    let value = object(&[(
        "q\"\\\n",
        RuntimeValue::String("\u{0}\u{8}\u{c}\n\r\t\"\\".into()),
    )]);
    assert_eq!(text(&value), r#"{"q\"\\\n":"\u0000\b\f\n\r\t\"\\"}"#);
    let failure = stringify_checked(
        &object(&[("bad", RuntimeValue::Error("type\0original".into()))]),
        &mut |_| Ok(()),
    )
    .unwrap_err();
    assert_eq!(
        runtime_diagnostic(failure),
        ExpressionDiagnostic::new("type", "original")
    );
}

#[test]
fn legacy_display_import_uses_checked_object_strings_and_keeps_guards_fatal() {
    let value = serde_json::json!({"type":"Link","value":{
        "path":"A#literal.md", "display":{"items":[1,null,true],"n":2}
    }});
    let link = runtime_link_from_json_checked(&value, 0, &mut 0usize, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert!(link.raw_destination.is_none() && link.source_path.is_none());
    assert!(link.subpath.is_none() && link.target.is_none());
    assert_eq!(link.path, "A#literal.md");
    assert_eq!(
        link.display.as_deref(),
        Some(r#"{"items":"1, null, true","n":"2"}"#)
    );
    let mut work = 0;
    let failure = runtime_display_string_checked(
        &serde_json::json!(["x".repeat(16_000)]),
        0,
        &mut 0usize,
        &mut |added| {
            work += added;
            if work > 32 {
                Err(RuntimeValue::Error("budget\0legacy copy ceiling".into()))
            } else {
                Ok(())
            }
        },
    )
    .unwrap_err();
    assert_eq!(
        runtime_diagnostic(failure),
        ExpressionDiagnostic::new("budget", "legacy copy ceiling")
    );
    let failure = runtime_display_string_checked(&value, 0, &mut 0usize, &mut |_| {
        Err(RuntimeValue::Error("cancelled\0legacy cancellation".into()))
    })
    .unwrap_err();
    assert_eq!(
        runtime_diagnostic(failure),
        ExpressionDiagnostic::new("cancelled", "legacy cancellation")
    );
    let data = runtime_from_base_value(
        &BaseValue::Error {
            code: "type".into(),
            message: "bad".into(),
        },
        &BasesTimezone::Utc,
    )
    .unwrap();
    assert!(matches!(data, RuntimeValue::ErrorValue(_)));
    assert_eq!(text(&data), "Error: bad");
    for code in ["budget", "cancelled"] {
        assert_eq!(
            runtime_from_base_value(
                &BaseValue::Error {
                    code: code.into(),
                    message: "guard".into()
                },
                &BasesTimezone::Utc
            )
            .unwrap_err(),
            ExpressionDiagnostic::new(code, "guard")
        );
    }
}

#[test]
fn work_cancellation_depth_and_expansion_are_admitted_cooperatively() {
    let value = object(&[("text", RuntimeValue::String("x".repeat(16_000)))]);
    let mut work = 0usize;
    let failure = stringify_checked(&value, &mut |added| {
        work += added;
        if work > 20 {
            Err(RuntimeValue::Error("budget\0test work ceiling".into()))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(
        runtime_diagnostic(failure),
        ExpressionDiagnostic::new("budget", "test work ceiling")
    );
    let mut calls = 0;
    let failure = stringify_checked(&value, &mut |_| {
        calls += 1;
        if calls == 7 {
            Err(RuntimeValue::Error("cancelled\0test cancellation".into()))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(calls, 7);
    assert_eq!(runtime_diagnostic(failure).code, "cancelled");
    let mut nested = RuntimeValue::Null;
    for _ in 0..129 {
        nested = RuntimeValue::List(vec![nested]);
    }
    assert_eq!(
        runtime_diagnostic(stringify_checked(&nested, &mut |_| Ok(())).unwrap_err()).code,
        "budget"
    );
    let oversized = object(&[("control", RuntimeValue::String("\u{0}".repeat(1_500_000)))]);
    assert_eq!(
        runtime_diagnostic(stringify_checked(&oversized, &mut |_| Ok(())).unwrap_err()).code,
        "budget"
    );
}
