use super::*;

fn allow(_: usize) -> Result<(), RuntimeValue> {
    Ok(())
}
fn code(error: RuntimeValue) -> String {
    runtime_diagnostic(error).code
}

#[test]
fn whole_expression_validation_keeps_malformed_literals_and_d6_features_distinct() {
    for source in [
        "if(false,/(/,1)",
        "if(true,1,/a/ii)",
        "false && /(/",
        "[].map(/(/)",
        "max(null,/(/)",
    ] {
        assert_eq!(
            code(validate_checked(source, &mut allow).unwrap_err()),
            "parse",
            "{source}"
        );
        assert!(validate(source).is_err(), "{source}");
    }
    for source in [
        r"if(false,/(?=a)/,1)",
        r"if(false,/(a)\1/,1)",
        "if(false,/a/y,1)",
        "if(false,/(?=unclosed group)/,1)",
    ] {
        assert_eq!(
            code(validate_checked(source, &mut allow).unwrap_err()),
            "unsupported",
            "{source}"
        );
    }
    assert!(validate("if(false,/a/,1)").is_ok());
}

#[test]
fn warm_literal_admission_still_polls_and_charges_before_compilation() {
    let source = "if(false,/a+/,1)";
    let mut cold_work = 0;
    validate_checked(source, &mut |work| {
        cold_work += work;
        Ok(())
    })
    .unwrap();
    let mut warm_work = 0;
    validate_checked(source, &mut |work| {
        warm_work += work;
        Ok(())
    })
    .unwrap();
    assert_eq!(cold_work, warm_work);
    assert!(warm_work > 0);
    assert_eq!(
        code(
            validate_checked("if(false,/(/,1)", &mut |_| Err(RuntimeValue::Error(
                "cancelled\0stop before constructor".into()
            )))
            .unwrap_err()
        ),
        "cancelled"
    );
    let expression = Parser::parse("/(/").unwrap();
    let mut visits = 0;
    let error = regex_admission::admit(&expression, &mut |_| {
        visits += 1;
        if visits == 2 {
            Err(RuntimeValue::Error("budget\0pattern not admitted".into()))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(code(error), "budget");
    assert_eq!(visits, 2);
}

#[test]
fn prepared_formulas_keep_semantic_failures_but_propagate_resource_failures_without_rows() {
    let formulas = vec![
        ("broken".into(), "if(false,/(/,1)".into()),
        ("good".into(), "if(false,formula.broken,1)".into()),
    ];
    let prepared = prepare_formula_expressions(&formulas, &mut allow, &mut allow).unwrap();
    assert!(
        matches!(prepared.expressions.get("broken"), Some((_, Err(message))) if message.starts_with("parse\0"))
    );
    let context = BasesEvaluationContext {
        formulas: Arc::new(formulas.into_iter().collect()),
        preparsed_formulas: Some(prepared),
        ..Default::default()
    };
    let mut session = Session::new(&context);
    assert_eq!(
        session.evaluate("formula.broken").unwrap_err().code,
        "parse"
    );
    assert_eq!(
        session.evaluate("formula.good").unwrap(),
        BaseValue::Number { value: 1.0 }
    );
    let fallback = BasesEvaluationContext {
        preparsed_formulas: None,
        ..context.clone()
    };
    assert_eq!(
        Session::new(&fallback)
            .evaluate("formula.broken")
            .unwrap_err()
            .code,
        "parse"
    );
    let work_limited = vec![("large".into(), "if(false,/a{1000000}/,1)".into())];
    assert_eq!(
        code(
            prepare_formula_expressions(&work_limited, &mut allow, &mut allow)
                .err()
                .unwrap()
        ),
        "budget"
    );
    assert_eq!(
        code(
            prepare_formula_expressions(&work_limited, &mut allow, &mut |_| Err(
                RuntimeValue::Error("cancelled\0stop".into())
            ))
            .err()
            .unwrap()
        ),
        "cancelled"
    );
}

#[test]
fn summary_constructor_errors_precede_input_hydration_and_remain_visible_cells() {
    let file = BaseValue::File {
        path: "Unavailable.md".into(),
    };
    for values in [&[][..], &[&file][..]] {
        let result = evaluate_summary(
            "if(false,/(/,1)",
            values,
            &[],
            None,
            &crate::EvaluationOptions::default(),
            None,
            None,
            |_| panic!("invalid literal must precede file hydration"),
        )
        .unwrap();
        assert!(matches!(result.value, BaseValue::Error { ref code, .. } if code == "parse"));
        assert!(result.steps_used > 0);
    }
    let cancellation = OperationCancellation::default();
    cancellation.cancel();
    let options = crate::EvaluationOptions {
        cancellation: Some(cancellation),
        ..Default::default()
    };
    assert_eq!(
        evaluate_summary(
            "if(false,/(/,1)",
            &[&file],
            &[],
            None,
            &options,
            None,
            None,
            |_| panic!("cancelled admission must precede file hydration")
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
}

#[test]
fn admission_does_not_replace_literal_identity_or_run_dependency_compilers() {
    let source = "[1,2].map(/a/).unique().length";
    let context = BasesEvaluationContext::default();
    assert_eq!(
        Session::new(&context).evaluate(source).unwrap(),
        BaseValue::Number { value: 1.0 }
    );
    assert!(parse_cached("if(false,/(/,1)").is_ok());
    assert!(!uses_relationships("if(false,/(/,1)"));
    assert_eq!(
        matches("if(false,/(/,1)", &context)
            .unwrap_err()
            .split_once('\0')
            .unwrap()
            .0,
        "parse"
    );
}

#[test]
fn summary_nested_fatal_inputs_precede_semantic_constructor_failures_without_file_lookup() {
    for code in ["cancelled", "budget"] {
        let fatal = BaseValue::Error {
            code: code.into(),
            message: "imported guard must remain fatal".into(),
        };
        let nested = BaseValue::Object {
            value: vec![(
                "nested".into(),
                BaseValue::List {
                    value: vec![BaseValue::Link {
                        path: "Unavailable.md".into(),
                        subpath: None,
                        target: None,
                        display: None,
                        display_value: Some(Box::new(fatal)),
                        external: false,
                    }],
                },
            )],
        };
        let error = evaluate_summary(
            "if(false,/(/,1)",
            &[&nested],
            &[],
            None,
            &crate::EvaluationOptions::default(),
            None,
            None,
            |_| panic!("fatal preflight must not hydrate files"),
        )
        .unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.message, "imported guard must remain fatal");
    }
    let ordinary_error = BaseValue::Error {
        code: "unavailable".into(),
        message: "ordinary error data".into(),
    };
    let result = evaluate_summary(
        "if(false,/(/,1)",
        &[&ordinary_error],
        &[],
        None,
        &crate::EvaluationOptions::default(),
        None,
        None,
        |_| panic!("semantic admission must not hydrate files"),
    )
    .unwrap();
    assert!(matches!(result.value, BaseValue::Error { ref code, .. } if code == "parse"));
    let oversized = BaseValue::String {
        value: "x".repeat(8 * 1024 * 1024 + 1),
    };
    assert_eq!(
        evaluate_summary(
            "if(false,/(/,1)",
            &[&oversized],
            &[],
            None,
            &crate::EvaluationOptions::default(),
            None,
            None,
            |_| panic!("resource preflight must not hydrate files")
        )
        .unwrap_err()
        .code,
        "budget"
    );
}

#[test]
fn settings_syntax_boundary_leaves_literal_construction_to_checked_invocation() {
    for source in ["if(false,/(/,1)", "if(false,/a{1000000}/,1)"] {
        assert!(validate_syntax(source).is_ok());
        assert!(validate_checked(source, &mut allow).is_err());
    }
    assert!(validate_syntax("if(").is_err());
}
