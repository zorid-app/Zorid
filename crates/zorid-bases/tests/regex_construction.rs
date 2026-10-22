//! Hand-authored whole-expression construction oracles. Reference provenance:
//! docs/history/bases-regex-construction-reference-20261022.md. The reference
//! replay establishes the constructor boundary, not a full grammar/app pass.
use zorid_bases::{evaluate_expression, BaseValue, DetachedRecord, EvaluationOptions};
fn record() -> DetachedRecord {
    serde_json::from_value(serde_json::json!({"path":"Fixture.md"})).unwrap()
}
#[test]
fn untaken_malformed_literals_invalidate_the_expression_before_lazy_selection() {
    for source in [
        "if(false,/(/,1)",
        "if(true,1,/a/ii)",
        "false && /(/",
        "[].map(/(/)",
        "max(null,/(/)",
    ] {
        assert_eq!(
            evaluate_expression(source, &record(), &EvaluationOptions::default())
                .unwrap_err()
                .code,
            "parse",
            "{source}"
        );
    }
    assert_eq!(
        evaluate_expression("if(false,/a/,1)", &record(), &EvaluationOptions::default())
            .unwrap()
            .value,
        BaseValue::Number { value: 1.0 }
    );
}
#[test]
fn valid_javascript_features_outside_the_portable_subset_stay_explicitly_unsupported() {
    for source in [
        r"if(false,/(?=a)/,1)",
        r"if(false,/(a)\1/,1)",
        "if(false,/a/y,1)",
    ] {
        assert_eq!(
            evaluate_expression(source, &record(), &EvaluationOptions::default())
                .unwrap_err()
                .code,
            "unsupported",
            "{source}"
        );
    }
}
