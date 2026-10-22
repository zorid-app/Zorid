//! Relational dispatch oracles from Obsidian's shipped TQ comparison node.
//! Static REA parent ev_1e238f001f4f2a9516be02733a8983fb5be82e706592b895ebd561296830986f.
//! Decoded Unicode [2328947,2330158), UTF-16 [2329102,2330313),
//! wrapped snippet SHA44f54daff9d83e5fbe3a0c9704c3d68e44c77424cc8a48ff60620966b6609589.
//! Invalid parsing retains the original String; only LEFT Date parses it. The
//! native JS numeric fallback yields NaN/false for nonnumeric original strings.
//! This is authored source-derived coverage, not reference-app execution.
use super::*;

fn public_value(source: &str, timezone: &str) -> BaseValue {
    let record = crate::DetachedRecord {
        path: "Notes/Comparison.md".into(),
        mtime_ms: Some(1704067200000),
        ..Default::default()
    };
    crate::evaluate_expression(
        source,
        &record,
        &crate::EvaluationOptions {
            timezone: timezone.into(),
            ..Default::default()
        },
    )
    .unwrap_or_else(|error| panic!("{source} in {timezone}: {error:?}"))
    .value
}
fn boolean(source: &str, timezone: &str, expected: bool) {
    assert_eq!(
        public_value(source, timezone),
        BaseValue::Boolean { value: expected },
        "{source} in {timezone}"
    );
}

#[test]
fn left_date_compares_quoted_iso_strings_and_real_file_timestamp_values() {
    for (operator, expected) in [("<", false), (">", true), ("<=", false), (">=", true)] {
        boolean(
            &format!("date('2024-01-02') {operator} '2024-01-01'"),
            "UTC",
            expected,
        );
    }
    boolean("file.mtime >= '2024-01-01T00:00:00Z'", "UTC", true);
    boolean("file.mtime <= '2024-01-01T05:30:00+05:30'", "UTC", true);
    boolean("file.mtime < '2024-01-01T00:00:00Z'", "UTC", false);
}

#[test]
fn date_string_parsing_uses_captured_timezone_for_local_dates_and_times() {
    boolean("file.mtime < '2024-01-01'", "UTC", false);
    boolean("file.mtime < '2024-01-01'", "America/Toronto", true);
    boolean("file.mtime > '2024-01-01'", "+05:30", true);
    boolean("file.mtime > '2024-01-01 00:00'", "+05:30", true);
    boolean("file.mtime <= '2024-01-01 05:30'", "+05:30", true);
}

#[test]
fn invalid_dates_and_unparsed_original_strings_keep_js_nan_and_numeric_behavior() {
    for raw in [
        "not a date",
        "2024-99-99",
        "2024-01-01T99:00:00",
        "20240101",
    ] {
        for operator in ["<", ">", "<=", ">="] {
            // Compact numeric text is NOT a date, but remains numeric text.
            let expected = raw == "20240101" && matches!(operator, ">" | ">=");
            boolean(
                &format!(
                    "file.mtime {operator} {}",
                    serde_json::to_string(raw).unwrap()
                ),
                "UTC",
                expected,
            );
        }
    }
    boolean("file.mtime > '1'", "UTC", true);
    boolean("file.mtime < 'Infinity'", "UTC", true);
    boolean("file.mtime >= '1704067200000'", "UTC", true);
    boolean("file.mtime <= '1704067200000'", "UTC", true);
}

#[test]
fn reversed_date_comparisons_do_not_parse_the_left_string() {
    for operator in ["<", ">", "<=", ">="] {
        boolean(&format!("'2024-01-01' {operator} file.mtime"), "UTC", false);
    }
    boolean("'1' < file.mtime", "UTC", true);
    boolean("'1704067200000' >= file.mtime", "UTC", true);
    boolean("'1704067200000' <= file.mtime", "UTC", true);
}

#[test]
fn string_subclasses_parse_raw_date_data_but_keep_original_fallback_spelling() {
    for wrapper in ["html", "image", "icon", "link"] {
        boolean(
            &format!("date('2024-01-02') > {wrapper}('2024-01-01')"),
            "UTC",
            true,
        );
        for operator in ["<", ">", "<=", ">="] {
            boolean(
                &format!("{wrapper}('2024-01-01') {operator} file.mtime"),
                "UTC",
                false,
            );
        }
    }
    boolean(
        "date('2024-01-02') > link('2024-01-01', '2099-01-01')",
        "UTC",
        true,
    );
    // A failed Date parse leaves the rich object intact: Link/Image stringify
    // as wiki/embed markup, rather than silently becoming raw numeric text.
    boolean("file.mtime > link('1')", "UTC", false);
    boolean("file.mtime > image('1')", "UTC", false);
    boolean("file.mtime > html('1')", "UTC", true);
}

#[test]
fn existing_null_relational_guard_and_other_typed_comparisons_remain_intact() {
    // Null was already handled before compare(); this pins existing behavior.
    for operator in ["<", ">", "<=", ">="] {
        for source in [
            format!("null {operator} 1"),
            format!("1 {operator} null"),
            format!("null {operator} null"),
            format!("file.mtime {operator} null"),
        ] {
            assert_eq!(public_value(&source, "UTC"), BaseValue::Null, "{source}");
        }
    }
    boolean("null == null", "UTC", true);
    boolean("null == 0", "UTC", false);
    boolean("null != 0", "UTC", true);
    boolean("date('2024-01-01') <= date('2024-01-01')", "UTC", true);
    boolean("file.mtime > 1", "UTC", true);
    boolean("duration('2d') > '1d'", "UTC", true);
}

#[test]
fn date_string_work_and_cancellation_are_admitted_before_parse_or_fallback() {
    let context = BasesEvaluationContext::default();
    let date = RuntimeValue::Date(DateValue {
        millis: 1704067200000,
        date_only: false,
        timezone: BasesTimezone::Utc,
    });
    for raw in [
        RuntimeValue::String("x".repeat(1024)),
        RuntimeValue::Image("x".repeat(1024)),
    ] {
        let mut evaluator = Evaluator::new(&context);
        evaluator.remaining_work = 8;
        assert!(evaluator
            .compare(&date, &raw, "<")
            .unwrap_err()
            .starts_with("budget\0"));
        let mut evaluator = Evaluator::new(&context);
        evaluator.remaining_work = 8;
        assert!(evaluator
            .compare(&raw, &date, "<")
            .unwrap_err()
            .starts_with("budget\0"));
    }
    let cancellation = OperationCancellation::default();
    cancellation.cancel();
    let context = BasesEvaluationContext {
        cancellation: Some(cancellation),
        ..Default::default()
    };
    let raw = RuntimeValue::String("2024-01-01".into());
    assert!(Evaluator::new(&context)
        .compare(&date, &raw, "<")
        .unwrap_err()
        .starts_with("cancelled\0"));
    assert!(Evaluator::new(&context)
        .compare(&raw, &date, "<")
        .unwrap_err()
        .starts_with("cancelled\0"));
}
