//! Narrow source-derived oracles, not runtime/reference-app acceptance.
//! Obsidian 1.14.4 app.js SHA-256
//! 958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9.
//! Python character ranges (end-exclusive): title registration 2223409–2223757,
//! SHA-256 e2795bbb0adbe040d94bcec9b19465a04d55f537d5b10f9e2811e46a0b70c33a;
//! getDates 2195226–2195460,
//! SHA-256 8fc6402a5908b98a478f0dce0a5871c4ee8ecad55cc28a56f277381c4d0d67c6.
//! Bounded REA parent ev_e891224000b775011206eb47939a0a10bb8bbbd5163ab5bef1c34b824505b6e1
//! parses two inert standalone selections: 584 bytes, 196 AST nodes, zero parse
//! failures. Only the final bundle-sequence comma is changed to semicolon for
//! standalone syntax (initial untouched fragments had two parse failures).
//! Graph coverage remains partial/unknown; external classes stay unresolved.
//! Pinned source stays in private temporary reference storage. Only the observed
//! literal-space boundary and raw String-derived date eligibility are adapted.
use super::*;

fn context() -> BasesEvaluationContext<'static> {
    BasesEvaluationContext {
        now: Some("2024-01-31T12:00:00Z".into()),
        timezone: BasesTimezone::Utc,
        ..Default::default()
    }
}
fn value(source: &str) -> BaseValue {
    evaluate(source, &context())
        .unwrap_or_else(|error| panic!("{source}: {error:?}"))
        .value
}
fn date(source: &str, timestamp: i64) {
    assert_eq!(
        value(source),
        BaseValue::Date {
            timestamp,
            has_time: true
        },
        "{source}"
    );
}

#[test]
fn title_only_splits_literal_spaces_and_preserves_empty_segments() {
    for (raw, expected) in [
        ("", ""),
        ("hello-world", "Hello-world"),
        ("hELLO.world", "Hello.world"),
        ("say\tHELLO", "Say\thello"),
        ("hello\nWORLD", "Hello\nworld"),
        ("  ONE  TWO ", "  One  Two "),
        ("'HELLO' \"WORLD\"", "'hello' \"world\""),
        ("123HELLO", "123hello"),
        ("HELLO-WORLD AGAIN", "Hello-world Again"),
    ] {
        assert_eq!(title_case(raw), expected, "{raw:?}");
        let source = format!("{}.title()", serde_json::to_string(raw).unwrap());
        assert_eq!(
            value(&source),
            BaseValue::String {
                value: expected.into()
            },
            "{source}"
        );
    }
    assert_eq!(
        value("icon('hello-world').title()"),
        BaseValue::String {
            value: "Hello-world".into()
        }
    );
    // Repeated separators are streamed rather than collected into token vectors.
    let spaces = " ".repeat(65536);
    assert_eq!(title_case(&spaces), spaces);
}

#[test]
fn date_extrema_accept_all_parseable_rich_string_raw_payloads() {
    for wrapper in ["html", "image", "icon", "link"] {
        date(
            &format!("[{wrapper}('2024-01-01')].earliest()"),
            1704067200000,
        );
        date(
            &format!("[{wrapper}('2024-01-01')].latest()"),
            1704067200000,
        );
    }
    date(
        "[link('2024-01-01', 'not a date')].earliest()",
        1704067200000,
    );
    assert_eq!(
        value("[link('not a date', '2024-01-01')].earliest()"),
        BaseValue::Null
    );
    date("[date('2024-01-01')].earliest()", 1704067200000);
    date(
        "[link('2024-01-03'), html('2024-01-01'), icon('2024-01-02')].earliest()",
        1704067200000,
    );
    date(
        "[link('2024-01-03'), html('2024-01-01'), icon('2024-01-02')].latest()",
        1704240000000,
    );
    assert_eq!(
        value("[icon('bad'), false, 1704067200000].earliest()"),
        BaseValue::Null
    );
}

#[test]
fn tag_and_url_date_eligibility_uses_raw_data_without_resolver_authority() {
    // URL is an external Link runtime subclass. A synthetic raw-date instance
    // exercises eligibility directly; it grants no namespace/file witness.
    for raw in [
        RuntimeValue::Tag("2024-01-01".into()),
        RuntimeValue::Link(BasesLink {
            path: "2024-01-01".into(),
            display: Some("not a date".into()),
            external: true,
            ..Default::default()
        }),
    ] {
        let mut context = context();
        context
            .note
            .insert("raw".into(), RuntimeValue::List(vec![raw]));
        for source in ["note.raw.earliest()", "note.raw.latest()"] {
            assert_eq!(
                evaluate(source, &context).unwrap().value,
                BaseValue::Date {
                    timestamp: 1704067200000,
                    has_time: true
                },
                "{source}"
            );
        }
    }
    let mut context = context();
    context.timezone = BasesTimezone::from_setting(Some("+05:30")).unwrap();
    assert_eq!(
        evaluate("[icon('2024-01-01')].earliest()", &context)
            .unwrap()
            .value,
        BaseValue::Date {
            timestamp: 1704047400000,
            has_time: true
        }
    );
}

#[test]
fn rich_date_scans_charge_raw_bytes_and_observe_cancellation() {
    let mut context = context();
    let mut evaluator = Evaluator::new(&context);
    evaluator.remaining_work = 8;
    let values = vec![RuntimeValue::Icon("x".repeat(1024))];
    assert!(
        matches!(evaluator.list_method(&values,"earliest",&[],&BTreeMap::new(),false,Some(&[])),RuntimeValue::Error(message) if message.starts_with("budget\0"))
    );
    let cancellation = OperationCancellation::default();
    cancellation.cancel();
    context.cancellation = Some(cancellation);
    assert!(
        matches!(Evaluator::new(&context).list_method(&values,"latest",&[],&BTreeMap::new(),false,Some(&[])),RuntimeValue::Error(message) if message.starts_with("cancelled\0"))
    );
}

#[test]
fn date_extrema_skip_compact_raw_strings_but_keep_explicit_date_constructor_values() {
    // getDates calls wK.parseFromString, whose hyphenated shape check is
    // separate from global date()'s compact 8/12-digit constructor fallback.
    // REA ev_310966fadf6d4076dae872628a354d75f60d4dd63ad5c86e01495d29ce6b99d0;
    // retained source ranges 2195226–2195459,
    // 2203357–2203621 and 2216085–2216852.
    for raw in ["20240101", "202401011200"] {
        for wrapper in [
            None,
            Some("html"),
            Some("image"),
            Some("icon"),
            Some("link"),
        ] {
            let quoted = serde_json::to_string(raw).unwrap();
            let item = wrapper.map_or_else(|| quoted.clone(), |name| format!("{name}({quoted})"));
            for method in ["earliest", "latest"] {
                let source = format!("[{item}].{method}()");
                assert_eq!(value(&source), BaseValue::Null, "{source}");
            }
        }
    }
    date(
        "['20240101', icon('202401011200'), '2024-01-02'].earliest()",
        1704153600000,
    );
    date(
        "['20241231', html('202412311200'), '2024-01-02'].latest()",
        1704153600000,
    );
    date("[date('20240101')].earliest()", 1704067200000);
    date("[date('202401011200')].latest()", 1704110400000);
    assert_eq!(
        value("date('20240101')"),
        BaseValue::Date {
            timestamp: 1704067200000,
            has_time: false
        }
    );
    let mut captured = context();
    captured.timezone = BasesTimezone::from_setting(Some("+05:30")).unwrap();
    assert_eq!(
        evaluate("[date('202401011200')].latest()", &captured)
            .unwrap()
            .value,
        BaseValue::Date {
            timestamp: 1704090600000,
            has_time: true
        }
    );
    assert_eq!(
        evaluate("[icon('202401011200')].latest()", &captured)
            .unwrap()
            .value,
        BaseValue::Null
    );
}
