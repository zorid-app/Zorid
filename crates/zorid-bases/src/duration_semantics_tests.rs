use super::*;
use crate::query::BaseClockDependency as Dependency;

fn context(clock: &str, zone: &str) -> BasesEvaluationContext<'static> {
    BasesEvaluationContext {
        now: Some(clock.into()),
        timezone: BasesTimezone::from_setting(Some(zone)).unwrap(),
        ..Default::default()
    }
}
fn eval(source: &str, clock: &str, zone: &str) -> BaseValue {
    evaluate(source, &context(clock, zone))
        .unwrap_or_else(|error| panic!("{source}: {error:?}"))
        .value
}
fn number(source: &str, clock: &str, zone: &str, expected: f64) {
    let actual = eval(source, clock, zone);
    let BaseValue::Number { value } = actual else {
        panic!("{source}: expected number, got {actual:?}")
    };
    assert!(
        (value - expected).abs() < 1e-9,
        "{source} at {clock}/{zone}: {value} != {expected}"
    );
}
fn boolean(source: &str, clock: &str, expected: bool) {
    assert_eq!(
        eval(source, clock, "UTC"),
        BaseValue::Boolean { value: expected },
        "{source} at {clock}"
    );
}
const JAN: &str = "2024-01-01T12:00:00Z";
const FEB: &str = "2024-02-01T12:00:00Z";

#[test]
fn simple_duration_syntax_is_complete_anchored_integer_case_sensitive() {
    for (source, field, amount) in [
        ("-2 years", "years", -2.0),
        ("3M", "months", 3.0),
        ("3m", "minutes", 3.0),
        ("2 weeks", "days", 14.0),
        ("0s", "seconds", 0.0),
    ] {
        let value = parse_duration(source).unwrap();
        let actual = match field {
            "years" => value.years,
            "months" => value.months,
            "minutes" => value.minutes,
            "days" => value.days,
            _ => value.seconds,
        };
        assert_eq!(actual, amount, "{source}");
        assert_eq!(value.weeks, 0.0);
    }
    for source in [
        "1d 2h",
        "1.5h",
        ".5h",
        "+1h",
        " 1h",
        "1h ",
        "1  hour",
        "1\thour",
        "1H",
        "1MONTH",
        "1ms",
        "1 millisecond",
        "noise 1h",
    ] {
        assert!(
            parse_duration(source).is_none(),
            "unexpected simple syntax: {source:?}"
        );
        assert_eq!(
            eval(
                &format!("duration({})", serde_json::to_string(source).unwrap()),
                JAN,
                "UTC"
            ),
            BaseValue::Null
        );
    }
}
#[test]
fn iso_duration_retains_reference_mandatory_t_unanchored_and_integer_components() {
    let value = parse_duration("prefix P1.9Y2,5M3W4DT5H6M7S suffix").unwrap();
    assert_eq!(
        (
            value.years,
            value.months,
            value.days,
            value.hours,
            value.minutes,
            value.seconds
        ),
        (1.0, 2.0, 25.0, 5.0, 6.0, 7.0)
    );
    assert_eq!(value.weeks, 0.0);
    assert!(parse_duration("P1D").is_none());
    assert!(parse_duration("P1Y").is_none());
    assert!(duration_finite(&parse_duration("PT").unwrap()));
    assert!(!duration_finite(&parse_duration("P.5YT").unwrap()));
    let value = eval("duration('P.5YT')", JAN, "UTC");
    assert!(
        matches!(value,BaseValue::Error {ref code,..} if code=="numeric-domain"),
        "{value:?}"
    );
}
#[test]
fn duration_properties_are_converted_totals_using_the_captured_anchor() {
    number("duration('1M').days", JAN, "UTC", 31.0);
    number("duration('1M').days", FEB, "UTC", 29.0);
    number("duration('1M').hours", FEB, "UTC", 696.0);
    number("duration('1M').minutes", FEB, "UTC", 41760.0);
    number("duration('1M').seconds", FEB, "UTC", 2505600.0);
    number("duration('1M').milliseconds", FEB, "UTC", 2505600000.0);
    number("duration('1M').weeks", FEB, "UTC", 29.0 / 7.0);
    number("duration('1M').months", FEB, "UTC", 1.0);
    number("duration('1M').years", FEB, "UTC", 1.0 / 12.0);
    number("duration('15d').months", JAN, "UTC", 15.0 / 31.0);
    number("duration('15d').MONTHS", JAN, "UTC", 15.0 / 31.0);
    assert_eq!(
        eval("duration('1M').keys().join(',')", JAN, "UTC"),
        BaseValue::String {
            value: "years,months,days,weeks,hours,minutes,seconds,milliseconds".into()
        }
    );
}
#[test]
fn zero_truth_is_component_based_and_division_preserves_duration_type() {
    boolean("duration('0d').isTruthy()", JAN, false);
    boolean("duration('PT').isTruthy()", JAN, false);
    boolean("(duration('1d') + duration('-24h')).isTruthy()", JAN, true);
    number("(duration('3h') / 2).hours", JAN, "UTC", 1.0); // setter truncates complete hour
    assert!(matches!(
        eval("duration('3h') / 2", JAN, "UTC"),
        BaseValue::Duration { hours: 1.5, .. }
    ));
    assert!(matches!(
        eval("duration('3h') / 10", JAN, "UTC"),
        BaseValue::Duration { hours: 0.3, .. }
    ));
    number("(duration('3h') - duration('1h')).hours", JAN, "UTC", 2.0);
    number("(duration('3h') * 2).hours", JAN, "UTC", 6.0);
    for source in ["duration('1h') / 0", "duration('1h') * 1e308"] {
        assert!(
            matches!(eval(source,JAN,"UTC"),BaseValue::Error {ref code,..} if code=="numeric-domain"),
            "{source}"
        );
    }
    for source in [
        "2 * duration('1h')",
        "2 / duration('1h')",
        "duration('1h') % 2",
        "duration('1h') - 2",
        "duration('1h') + 2",
    ] {
        assert!(
            matches!(eval(source, JAN, "UTC"), BaseValue::Error { .. }),
            "{source}"
        );
    }
}
#[test]
fn javascript_calendar_setters_overflow_in_order_instead_of_clamping() {
    for (source, expected) in [
        (
            "(date('2024-01-31') + duration('1M')).format('YYYY-MM-DD')",
            "2024-03-02",
        ),
        (
            "(date('2023-01-31') + duration('1M')).format('YYYY-MM-DD')",
            "2023-03-03",
        ),
        (
            "(date('2024-02-29') + duration('1y')).format('YYYY-MM-DD')",
            "2025-03-01",
        ),
        (
            "(date('2024-02-29') + duration('P1Y1MT')).format('YYYY-MM-DD')",
            "2025-04-01",
        ),
        (
            "(date('2024-03-31') - duration('1M')).format('YYYY-MM-DD')",
            "2024-03-02",
        ),
        (
            "(date('2024-01-01T12:30:00Z') + duration('1h') / 2).format('HH:mm')",
            "12:30",
        ),
    ] {
        assert_eq!(
            eval(source, JAN, "UTC"),
            BaseValue::String {
                value: expected.into()
            },
            "{source}"
        );
    }
    assert!(matches!(
        eval("date('2024-01-02') - date('2024-01-01')", JAN, "UTC"),
        BaseValue::Duration {
            milliseconds: 86400000.0,
            ..
        }
    ));
}
#[test]
fn calendar_fields_and_elapsed_comparisons_observe_dst_but_not_ambient_time() {
    for (clock, hours) in [
        ("2024-03-09T17:00:00Z", 23.0),
        ("2024-11-02T16:00:00Z", 25.0),
    ] {
        number("duration('1d').days", clock, "America/New_York", 1.0);
        number("duration('1d').hours", clock, "America/New_York", hours);
        number("duration('24h').hours", clock, "America/New_York", hours);
        let duration = eval("duration('1d')", clock, "America/New_York");
        let millis = DateTime::parse_from_rfc3339(clock)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            duration_scalar(&duration, millis, "America/New_York").unwrap(),
            hours * 3600000.0
        );
    }
    // D1 remains explicit: Zorid does not guess JS platform gap/fold policy.
    for (clock, zone) in [
        ("2024-03-09T07:30:00Z", "America/New_York"),
        ("2024-11-02T05:30:00Z", "America/New_York"),
    ] {
        assert!(
            matches!(eval("duration('1d').hours",clock,zone),BaseValue::Error {ref code,..} if code=="invalid-local-time")
        );
    }
    boolean("duration('1M') > duration('30d')", JAN, true);
    boolean("duration('1M') > duration('30d')", FEB, false);
    boolean("duration('1M') == '31d'", JAN, true);
    boolean("duration('1M') == '31d'", FEB, false);
    boolean("[duration('1M')].contains('31d')", JAN, true);
    boolean("[duration('1M')].contains('31d')", FEB, false);
    boolean("duration('1h') == 'not duration'", JAN, false);
    boolean("duration('1h') >= 'not duration'", JAN, false);
    boolean("'1h' >= duration('1h')", JAN, false);
    boolean("duration('1h') >= '1h'", JAN, true);
    boolean("duration('0h') < true", JAN, false);
    boolean("duration('0h') <= false", JAN, false);
    boolean("duration('0h') >= ' '", JAN, true);
}
#[test]
fn duration_sensitive_ast_analysis_is_conservative_across_aliases_callbacks_and_indexes() {
    for source in [
        "duration('1M').days",
        "duration('1M') == '31d'",
        "duration('1M') > 0",
        "formula.elapsed > 0",
        "'abc'.slice(duration('1M'))",
        "'abc'.repeat(duration('1M'))",
        "(2).round(duration('1M'))",
        "duration('1d') == html('1d')",
        "duration('1d') == link('1d')",
        "formula.elapsed.days",
        "formula.object.length.days",
        "duration('1d') == file.basename",
        "formula[note.key].hours",
        "this.elapsed.hours",
        "note[note.property][note.unit]",
        "[duration('1M')].contains('31d')",
        "[duration('1M')].containsAny('book', '31d')",
        "[[duration('1M')]].flat().map(value.days)",
        "list(formula.durations).map(value > 0)",
        "[duration('1M')].reduce(acc + value, duration('0d')).days",
        "if(note.ready, duration('1M'), 2).days",
        "unknown().days",
        "(date('2024-01-02') - date('2024-01-01')) == '1d'",
        "[duration('1M')].map(value).map(value.hours)",
    ] {
        assert_eq!(
            clock_dependency(source, &mut |_| Some(())),
            Dependency::Instant,
            "{source}"
        );
    }
    for source in [
        "duration('1M')",
        "duration('1M') / 2",
        "duration('0d').isTruthy()",
        "note.type == 'book'",
        "note.status != 'complete'",
        "file.size > 0",
        "[1,2].map(value * 2).sum()",
        "[1,2].map(value > 0)",
        "[1,2].reduce(acc + value,0) > 1",
        "formula[note.key]",
        "duration('1M') == 'not duration'",
        "[duration('1M')].contains('book')",
    ] {
        assert_eq!(
            clock_dependency(source, &mut |_| Some(())),
            Dependency::None,
            "{source}"
        );
    }
    assert!(!clock_independent("formula.duration.days", &mut |_| Some(
        ()
    )));
    assert!(!clock_independent(
        "formula.duration > 0",
        &mut |_| Some(())
    ));
    assert!(clock_independent("note.type == 'book'", &mut |_| Some(())));
    let mut remaining = 3usize;
    assert_eq!(
        clock_dependency("formula.duration.days", &mut |work| {
            remaining = remaining.checked_sub(work)?;
            Some(())
        }),
        Dependency::Instant
    );
}
