//! Independently authored call-contract fixtures for the shipped 1.14.4 API.
use super::*;

fn eval(source: &str) -> Result<BaseValue, ExpressionDiagnostic> {
    evaluate(source, &BasesEvaluationContext::default()).map(|result| result.value)
}
fn bool_value(value: bool) -> BaseValue {
    BaseValue::Boolean { value }
}
fn number_value(value: f64) -> BaseValue {
    BaseValue::Number { value }
}
fn string_value(value: &str) -> BaseValue {
    BaseValue::String {
        value: value.into(),
    }
}
fn code(source: &str, expected: &str) {
    assert_eq!(eval(source).unwrap_err().code, expected, "{source}");
}

#[test]
fn ordinary_calls_validate_registration_before_arguments_and_supplied_arguments_in_order() {
    let missing = eval("missingFunction(alsoMissing())").unwrap_err();
    assert!(missing.message.contains("missingFunction"), "{missing:?}");
    code("now(unknown())", "unknown-function");
    code("now(1)", "arity");
    code("'x'.replace(unknown())", "unknown-function");
    code("'x'.replace('x')", "arity");
    code("'x'.toString(unknown())", "unknown-function");
    code("'x'.toString(1)", "arity");
    code("'x'.isTruthy(false)", "arity");
    code("(1).abs(2)", "arity");
    code("(1).toFixed()", "arity");
    code("true.isEmpty()", "unknown-function");
    assert_eq!(
        eval("null.unknown(alsoMissing())").unwrap(),
        BaseValue::Null
    );
}

#[test]
fn required_null_stops_before_later_arguments_and_required_types_do_not_coerce() {
    for source in [
        "'abc'.startsWith(null)",
        "'abc'.replace(null, unknown())",
        "max(2, null, unknown())",
        "min(null, 2)",
        "list(null)",
        "null.isType(null)",
    ] {
        assert_eq!(eval(source).unwrap(), BaseValue::Null, "{source}");
    }
    for source in [
        "'abc'.contains(1)",
        "'abc'.repeat('2')",
        "[1].join(2)",
        "(1).toFixed('2')",
        "max(true)",
    ] {
        code(source, "type");
    }
    assert_eq!(eval("max()").unwrap(), BaseValue::Null);
    assert_eq!(eval("min(4,2,7)").unwrap(), number_value(2.0));
}

#[test]
fn optional_null_is_absent_for_display_precision_and_end_limits() {
    assert_eq!(eval("'abc'.slice(1,null)").unwrap(), string_value("bc"));
    assert_eq!(
        eval("[1,2,3].slice(1,null).join(',')").unwrap(),
        string_value("2,3")
    );
    assert_eq!(
        eval("'a,b,c'.split(',',null).join('|')").unwrap(),
        string_value("a|b|c")
    );
    assert_eq!(eval("(1.7).round(null)").unwrap(), number_value(2.0));
    let BaseValue::Link {
        display,
        display_value,
        ..
    } = eval("link('A', null)").unwrap()
    else {
        panic!("expected link")
    };
    assert_eq!(display, None);
    assert_eq!(display_value, None);
    let context = BasesEvaluationContext {
        file: file_defaults("A.md"),
        ..Default::default()
    };
    let BaseValue::Link {
        display,
        display_value,
        ..
    } = evaluate("file.asLink(null)", &context).unwrap().value
    else {
        panic!("expected file link")
    };
    assert_eq!(display, None);
    assert_eq!(display_value, None);
}

#[test]
fn lowercase_if_is_lazy_supports_subject_and_checks_total_arity_first() {
    for source in [
        "if(true,7,unknown())",
        "true.if(7,unknown())",
        "''.if(unknown(),7)",
    ] {
        assert_eq!(eval(source).unwrap(), number_value(7.0), "{source}");
    }
    assert_eq!(eval("if(false,unknown())").unwrap(), BaseValue::Null);
    code("if(unknown())", "arity");
    code("unknown().if()", "arity");
    code("if(unknown(),1,2,3)", "arity");
    code("unknown().if(1,2,3)", "arity");
}

#[test]
fn mixed_case_if_uses_eager_boolean_registry_and_has_no_method_registration() {
    code("IF(true,7,unknown())", "unknown-function");
    code("IF(1,7,8)", "type");
    assert_eq!(eval("IF(true,7)").unwrap(), number_value(7.0));
    assert_eq!(eval("IF(false,7)").unwrap(), BaseValue::Null);
    assert_eq!(eval("IF(null,unknown())").unwrap(), BaseValue::Null);
    code("true.IF(7,8)", "unknown-function");
    assert_eq!(eval("null.IF(unknown())").unwrap(), BaseValue::Null);
}

#[test]
fn exact_lowercase_callbacks_keep_scope_but_mixed_case_uses_eager_stubs() {
    assert_eq!(
        eval("[1,2].map(value+1).join(',')").unwrap(),
        string_value("2,3")
    );
    assert_eq!(eval("[1,2].MAP(7).join(',')").unwrap(), string_value("1,2"));
    assert_eq!(
        eval("[1,2].FILTER(false).join(',')").unwrap(),
        string_value("1,2")
    );
    assert_eq!(
        eval("[1,2].REDUCE(7,8).join(',')").unwrap(),
        string_value("1,2")
    );
    code("[1].FILTER(1)", "type");
    code("[1].MAP(unknown())", "unknown-function");
    code("[1].map(unknown(),unknown())", "arity");
    code("[1].reduce(unknown())", "arity");
    code("[1].REDUCE(unknown())", "unknown-function");
}

#[test]
fn string_contracts_consume_rich_raw_data_while_concatenation_uses_text_form() {
    for source in [
        "'abc'.startsWith(image('a'))",
        "'abc'.contains(icon('b'))",
        "'x'.isType(icon('String'))",
    ] {
        assert_eq!(eval(source).unwrap(), bool_value(true), "{source}");
    }
    assert_eq!(
        eval("html('x').replace(image('x'),icon('y'))").unwrap(),
        string_value("y")
    );
    assert_eq!(
        eval("image('a') + icon('b')").unwrap(),
        string_value("![[a]]b")
    );
    assert_eq!(eval("null + image('a')").unwrap(), string_value("![[a]]"));
    assert_eq!(eval("image('a') + null").unwrap(), string_value("![[a]]"));
    assert_eq!(eval("html('a') + html('b')").unwrap(), string_value("ab"));
    assert_eq!(
        eval("link('A') + link('B')").unwrap(),
        string_value("[[A]][[B]]")
    );
}

#[test]
fn public_ancestry_includes_any_and_icon_inherits_string_without_icon_type_name() {
    for source in [
        "null.isType('any')",
        "(1).isType('Any')",
        "true.isType('boolean')",
        "icon('book').isType('String')",
        "image('a').isType('Image')",
        "image('a').isType('string')",
        "html('x').isType('any')",
    ] {
        assert_eq!(eval(source).unwrap(), bool_value(true), "{source}");
    }
    assert_eq!(
        eval("icon('book').isType('icon')").unwrap(),
        bool_value(false)
    );
}

#[test]
fn returned_error_data_is_accepted_by_any_but_thrown_errors_abort() {
    let context = BasesEvaluationContext::default();
    let scope = BTreeMap::from([(
        "problem".into(),
        RuntimeValue::ErrorValue("type\0retained problem".into()),
    )]);
    let mut evaluator = Evaluator::new(&context);
    for (source, expected) in [
        ("problem.isType('Error')", bool_value(true)),
        ("problem.isType('Any')", bool_value(true)),
        ("problem.isTruthy()", bool_value(false)),
        (
            "problem.toString()",
            string_value("Error: retained problem"),
        ),
        ("IF(false, problem, 4)", number_value(4.0)),
        ("if(problem, unknown(), 4)", number_value(4.0)),
    ] {
        assert_eq!(
            typed_result(evaluator.evaluate(&parse_cached(source).unwrap(), &scope)).unwrap(),
            expected,
            "{source}"
        );
    }
    code("IF(false, unknown(), 4)", "unknown-function");
    code("unknown().isType('Error')", "unknown-function");
    code("unknown().toString()", "unknown-function");
}

#[test]
fn null_validation_and_any_do_not_swallow_preexisting_cancellation_or_argument_budget() {
    let context = BasesEvaluationContext {
        work_limit: Some(3),
        ..Default::default()
    };
    assert_eq!(
        evaluate("IF(true, 1, 'a'.repeat(10))", &context)
            .unwrap_err()
            .code,
        "budget"
    );
    let token = OperationCancellation::default();
    token.cancel();
    let context = BasesEvaluationContext {
        cancellation: Some(token),
        ..Default::default()
    };
    assert_eq!(
        evaluate("max(null, unknown())", &context).unwrap_err().code,
        "cancelled"
    );
}
