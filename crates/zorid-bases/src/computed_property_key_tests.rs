use super::*;

fn evaluate(source: &str, context: &BasesEvaluationContext<'_>) -> RuntimeValue {
    let expression = parse_cached(source).unwrap();
    Evaluator::new(context).evaluate(&expression, &Scope::new())
}

fn operand_work(key: Expr, context: &BasesEvaluationContext<'_>) -> usize {
    let mut evaluator = Evaluator::new(context);
    let initial = evaluator.remaining_work;
    evaluator.evaluate(&Expr::Identifier("note".into()), &Scope::new());
    evaluator.evaluate(&key, &Scope::new());
    initial - evaluator.remaining_work
}

#[test]
fn computed_string_key_consumes_admitted_text_without_rendering_a_second_copy() {
    let context = BasesEvaluationContext {
        note: IndexMap::from([
            ("score".into(), RuntimeValue::Number(7.0)),
            ("key".into(), RuntimeValue::String("score".into())),
        ]),
        ..Default::default()
    };
    let work = operand_work(Expr::Literal(Value::String("score".into())), &context);
    let constrained = BasesEvaluationContext {
        // The member node plus actual receiver and literal evaluation fits;
        // creating a second String representation would exceed this allowance.
        work_limit: Some(work + 1),
        ..context
    };
    assert!(matches!(
        evaluate("note['score']", &constrained),
        RuntimeValue::Number(7.0)
    ));
}

#[test]
fn computed_nonliteral_owned_string_uses_the_same_move() {
    let context = BasesEvaluationContext {
        note: IndexMap::from([
            ("score".into(), RuntimeValue::Number(7.0)),
            ("key".into(), RuntimeValue::String("score".into())),
        ]),
        ..Default::default()
    };
    let work = operand_work(Expr::Identifier("key".into()), &context);
    let constrained = BasesEvaluationContext {
        work_limit: Some(work + 1),
        ..context
    };
    assert!(matches!(
        evaluate("note[key]", &constrained),
        RuntimeValue::Number(7.0)
    ));
}

#[test]
fn computed_non_string_keys_keep_checked_renderer_policy_including_tags() {
    let object_key =
        RuntimeValue::Object(IndexMap::from([("x".into(), RuntimeValue::Number(7.0))]));
    let context = BasesEvaluationContext {
        note: IndexMap::from([
            ("key".into(), object_key),
            ("{\"x\":\"7\"}".into(), RuntimeValue::Number(19.0)),
            ("tag".into(), RuntimeValue::Tag("#topic".into())),
            ("#topic".into(), RuntimeValue::Number(23.0)),
            ("number".into(), RuntimeValue::Number(7.0)),
            ("7".into(), RuntimeValue::Number(31.0)),
            (
                "list".into(),
                RuntimeValue::List(vec![
                    RuntimeValue::String("a".into()),
                    RuntimeValue::String("b".into()),
                ]),
            ),
            ("a, b".into(), RuntimeValue::Number(37.0)),
        ]),
        ..Default::default()
    };
    assert!(matches!(
        evaluate("note[key]", &context),
        RuntimeValue::Number(19.0)
    ));
    assert!(matches!(
        evaluate("note[tag]", &context),
        RuntimeValue::Number(23.0)
    ));
    assert!(matches!(
        evaluate("note[number]", &context),
        RuntimeValue::Number(31.0)
    ));
    assert!(matches!(
        evaluate("note[list]", &context),
        RuntimeValue::Number(37.0)
    ));
    for key in ["key", "tag", "number", "list"] {
        let work = operand_work(Expr::Identifier(key.into()), &context);
        let constrained = BasesEvaluationContext {
            work_limit: Some(work + 1),
            ..context.clone()
        };
        assert!(
            matches!(evaluate(&format!("note[{key}]"), &constrained), RuntimeValue::Error(error) if error.starts_with("budget\0"))
        );
    }
}

#[test]
fn string_receiver_indices_and_first_literal_copy_remain_checked() {
    assert!(
        matches!(evaluate("'abc'['length']", &BasesEvaluationContext::default()), RuntimeValue::Error(error) if error.starts_with("access\0"))
    );
    let context = BasesEvaluationContext {
        work_limit: Some(64),
        ..Default::default()
    };
    assert!(
        matches!(evaluate(&format!("note['{}']", "a".repeat(4096)), &context), RuntimeValue::Error(error) if error.starts_with("budget\0"))
    );
}

#[test]
fn cached_string_literal_keys_remain_cancellable_and_keep_the_literal_byte_cap() {
    let cancellation = OperationCancellation::default();
    let context = BasesEvaluationContext {
        note: IndexMap::from([("score".into(), RuntimeValue::Number(7.0))]),
        cancellation: Some(cancellation.clone()),
        ..Default::default()
    };
    assert!(matches!(
        evaluate("note['score']", &context),
        RuntimeValue::Number(7.0)
    ));
    cancellation.cancel();
    assert!(
        matches!(evaluate("note['score']", &context), RuntimeValue::Error(error) if error.starts_with("cancelled\0"))
    );
    // Isolate the hard literal-copy cap from the smaller normal work ceiling;
    // the checked renderer must reject this before allocating its output.
    let context = BasesEvaluationContext {
        work_limit: Some(2_000_000),
        ..Default::default()
    };
    let expression = Expr::Literal(Value::String("a".repeat(8 * 1024 * 1024 + 1)));
    assert!(
        matches!(Evaluator::new(&context).evaluate(&expression, &Scope::new()), RuntimeValue::Error(error) if error.starts_with("budget\0"))
    );
}
