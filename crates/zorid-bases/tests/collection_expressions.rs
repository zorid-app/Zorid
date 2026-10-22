//! Independently authored scalar/collection examples. These expected values do
//! not come from the implementation or a copied reference evaluator.
use serde_json::json;
use zorid_bases::{
    evaluate_expression, BaseValue, DetachedRecord, EvaluationOptions, PropertyValue,
};

fn record() -> DetachedRecord {
    serde_json::from_value(
        json!({"path":"Fixture.md","witness":{"entryId":"fixture","revision":"r1"}}),
    )
    .unwrap()
}
fn evaluate(source: &str) -> BaseValue {
    evaluate_expression(source, &record(), &EvaluationOptions::default())
        .unwrap_or_else(|error| panic!("{source}: {error}"))
        .value
}
fn text(value: &str) -> BaseValue {
    BaseValue::String {
        value: value.into(),
    }
}
fn number(value: f64) -> BaseValue {
    BaseValue::Number { value }
}
fn list(value: Vec<BaseValue>) -> BaseValue {
    BaseValue::List { value }
}

#[test]
fn string_membership_folds_each_query_and_empty_literal_replacement_is_unchanged() {
    for source in [
        r#""Alpha BETA".containsAll("alpha", "beta")"#,
        r#""Alpha BETA".containsAny("missing", "BeTa")"#,
        r#""ÉCOLE".containsAll("école")"#,
        r#""".containsAll("")"#,
    ] {
        assert_eq!(
            evaluate(source),
            BaseValue::Boolean { value: true },
            "{source}"
        );
    }
    assert_eq!(evaluate(r#""abc".replace("", "x")"#), text("abc"));
    assert_eq!(evaluate(r#""aba".replace("a", "$&")"#), text("$&b$&"));
    assert_eq!(
        evaluate(r#""abc".containsAny("Z", "Q")"#),
        BaseValue::Boolean { value: false }
    );
}

#[test]
fn computed_string_indices_use_numeric_char_at_and_the_accepted_scalar_unicode_policy() {
    for (source, expected) in [
        (r#""café🦀"[4]"#, text("🦀")),
        (r#""abc"[1.9]"#, text("b")),
        (r#""abc"[-0.5]"#, text("a")),
        (r#""abc"[-1]"#, text("")),
        (r#""abc"[3]"#, text("")),
        (r#""abc"[null]"#, BaseValue::Null),
        (r#"icon("book")[1]"#, text("o")),
        (r#"html("ab")[1]"#, text("b")),
        (r#""café🦀".length"#, number(5.0)),
    ] {
        assert_eq!(evaluate(source), expected, "{source}");
    }
    assert_eq!(
        evaluate_expression(r#""abc"["1"]"#, &record(), &EvaluationOptions::default())
            .unwrap_err()
            .code,
        "access"
    );
}

#[test]
fn regex_replacement_uses_javascript_templates_without_changing_literal_replacement() {
    for (source, expected) in [
        (r#""aba".replace(/a/, "<$&>")"#, "<a>ba"),
        (r#""aba".replace(/a/g, "<$&>")"#, "<a>b<a>"),
        (r#""xabcy".replace(/(a)(b)(c)/, "$3$2$1")"#, "xcbay"),
        (r#""abc".replace(/b/, "$$|$&|$`|$'")"#, "a$|b|a|cc"),
        (
            r#""a".replace(/(a)(b)?/, "$2:$1:$10:$01:$0:$99")"#,
            ":a:a0:a:$0:$99",
        ),
        (r#""a".replace(/(?<word>a)/, "$<word>:$<missing>")"#, "a:"),
        (r#""a".replace(/a/, "$<word>")"#, "$<word>"),
        (r#""ab".replace(/(?:)/g, "-")"#, "-a-b-"),
    ] {
        assert_eq!(evaluate(source), text(expected), "{source}");
    }
}

#[test]
fn split_injects_captures_null_alternatives_and_uses_uint32_limits() {
    for (source, expected) in [
        (
            r#""a,b;c".split(/([,;])/)"#,
            list(vec![text("a"), text(","), text("b"), text(";"), text("c")]),
        ),
        (
            r#""ab".split(/(x)?/)"#,
            list(vec![text("a"), BaseValue::Null, text("b")]),
        ),
        (r#""".split(/(?:)/)"#, list(vec![])),
        (r#""".split(/x/)"#, list(vec![text("")])),
        (r#""ab".split(/(?:)/)"#, list(vec![text("a"), text("b")])),
        (r#""🦀x".split("")"#, list(vec![text("🦀"), text("x")])),
        (
            r#""a,b,c".split(",", -1)"#,
            list(vec![text("a"), text("b"), text("c")]),
        ),
        (r#""a,b,c".split(",", 4294967297)"#, list(vec![text("a")])),
        (r#""a,b,c".split(",", 1.9)"#, list(vec![text("a")])),
        (r#""a,b".split(/(,)/, 2)"#, list(vec![text("a"), text(",")])),
    ] {
        assert_eq!(evaluate(source), expected, "{source}");
    }
}

#[test]
fn recursive_flat_and_single_list_membership_keep_nested_values_meaningful() {
    assert_eq!(
        evaluate("[1,[2,[],[3,[4]]],5].flat()"),
        list((1..=5).map(|value| number(value as f64)).collect())
    );
    assert_eq!(
        evaluate("[1,2,3].containsAll([1,3])"),
        BaseValue::Boolean { value: true }
    );
    assert_eq!(
        evaluate("[1,2,3].containsAny([4,2])"),
        BaseValue::Boolean { value: true }
    );
    assert_eq!(
        evaluate("[1,2,3].containsAll([])"),
        BaseValue::Boolean { value: true }
    );
    assert_eq!(
        evaluate("[1,2,3].containsAny([])"),
        BaseValue::Boolean { value: false }
    );
}

#[test]
fn unique_uses_strict_nested_constructors_and_reference_bucket_key_order() {
    assert_eq!(
        evaluate(r#"[3,1,2,3,"2",true,"1",false].unique()"#),
        list(vec![
            number(1.0),
            text("1"),
            number(2.0),
            text("2"),
            number(3.0),
            BaseValue::Boolean { value: true },
            BaseValue::Boolean { value: false }
        ])
    );
    assert_eq!(
        evaluate(r#"[html("x"),"y","x",icon("x"),"y",html("x")].unique()"#),
        list(vec![
            BaseValue::Html { value: "x".into() },
            text("x"),
            BaseValue::Icon { value: "x".into() },
            text("y")
        ])
    );
    assert_eq!(evaluate(r#"[[1],["1"],[1]].unique().length"#), number(2.0));
    let mut input = record();
    input.properties = vec![
        (
            "a".into(),
            PropertyValue::Object(vec![("x".into(), PropertyValue::Number(1.into()))]),
        ),
        (
            "b".into(),
            PropertyValue::Object(vec![("x".into(), PropertyValue::String("1".into()))]),
        ),
        (
            "c".into(),
            PropertyValue::Object(vec![("x".into(), PropertyValue::Number(1.into()))]),
        ),
        (
            "tags".into(),
            PropertyValue::Array(vec![PropertyValue::String("topic".into())]),
        ),
    ];
    for source in [
        "[note.a,note.b,note.c].unique().length",
        "[tags,tags.map(value)].unique().length",
        r##"[tags[0],"#topic",tags[0]].unique().length"##,
    ] {
        assert_eq!(
            evaluate_expression(source, &input, &EvaluationOptions::default())
                .unwrap()
                .value,
            number(2.0),
            "{source}"
        );
    }
}

#[test]
fn unique_keeps_regex_object_identity_and_exact_link_constructor_labels() {
    for (source, expected) in [
        ("[/a/,/a/].unique().length", 2.0),
        ("[/a/].map([value,value]).flat().unique().length", 1.0),
        (r#"[link("A",0),link("A","0")].unique().length"#, 2.0),
        (
            r#"[link("A",false),link("A","false")].unique().length"#,
            2.0,
        ),
        (r#"[link("A",""),link("A")].unique().length"#, 2.0),
        (r#"[link("A"),link("A",null)].unique().length"#, 1.0),
        (
            r#"[link("[[A|x]]","y"),link("A","x")].unique().length"#,
            1.0,
        ),
        ("[file,file].unique().length", 1.0),
    ] {
        assert_eq!(evaluate(source), number(expected), "{source}");
    }
}

#[test]
fn number_round_and_fixed_use_reference_domains_binary_ties_and_exponents() {
    for (source, expected) in [
        ("(123.6).round(-2)", number(124.0)),
        ("(-1.5).round(-1)", number(-1.0)),
        ("(1.25).toFixed(1)", text("1.3")),
        ("(-2.5).toFixed(0)", text("-3")),
        ("(1.005).toFixed(2)", text("1.00")),
        ("(2.55).toFixed(1)", text("2.5")),
        ("(0.1).toFixed(20)", text("0.10000000000000000555")),
        ("(1.25).toFixed(1.9)", text("1.3")),
        ("(1.25).toFixed(-0.9)", text("1")),
        ("(-0).toFixed(2)", text("0.00")),
        ("(-0.1).toFixed(0)", text("-0")),
        ("(1e21).toFixed(2)", text("1e+21")),
        ("(-1.25e22).toFixed(2)", text("-1.25e+22")),
    ] {
        assert_eq!(evaluate(source), expected, "{source}");
    }
    for (source, code) in [("(1).toFixed(-1)", "type"), ("(1).toFixed(101)", "budget")] {
        assert_eq!(
            evaluate_expression(source, &record(), &EvaluationOptions::default())
                .unwrap_err()
                .code,
            code
        );
    }
}

#[test]
fn collection_traversals_and_expanding_regex_templates_are_bounded_and_cancellable() {
    let cancellation = zorid_bases::OperationCancellation::default();
    cancellation.cancel();
    assert_eq!(
        evaluate_expression(
            "[1,[2]].flat()",
            &record(),
            &EvaluationOptions {
                cancellation: Some(cancellation),
                ..Default::default()
            }
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
    let mut input = record();
    input.properties.push((
        "items".into(),
        PropertyValue::Array(
            (0..100)
                .map(|_| PropertyValue::Array(vec![PropertyValue::Number(1.into()); 20]))
                .collect(),
        ),
    ));
    for source in ["items.flat()", "items.unique()"] {
        assert_eq!(
            evaluate_expression(
                source,
                &input,
                &EvaluationOptions {
                    max_steps: 100,
                    ..Default::default()
                }
            )
            .unwrap_err()
            .code,
            "budget",
            "{source}"
        );
    }
    assert_eq!(
        evaluate_expression(
            r#""a".repeat(10000).replace(/a/g, "$`")"#,
            &record(),
            &EvaluationOptions::default()
        )
        .unwrap_err()
        .code,
        "budget"
    );
}

#[test]
fn regex_empty_tails_and_canonical_flags_follow_native_replacement_buckets() {
    for (source, expected) in [
        (r#""ab".replace(/a*/g, "-")"#, "--b-"),
        (r#""aa".replace(/a?/g, "-")"#, "---"),
        (r#"/a/ig.toString()"#, "/a/gi"),
        (
            r#"[/a/ig,"gap",/a/gi].unique().join("|")"#,
            "/a/gi|/a/gi|gap",
        ),
    ] {
        assert_eq!(evaluate(source), text(expected), "{source}");
    }
    assert_eq!(evaluate("[1,2].map(/a/).unique().length"), number(1.0));
    // A literal constructor is encountered even inside an eager unselected
    // ordinary argument. Unsupported patterns are explicit diagnostics.
    assert!(evaluate_expression(
        "IF(false, /(/, 1)",
        &record(),
        &EvaluationOptions::default()
    )
    .is_err());
}

#[test]
fn number_strings_and_prefix_whitespace_keep_reference_buckets() {
    for (source, expected) in [
        ("(-0).toString()", "0"),
        ("(1e21).toString()", "1e+21"),
        ("(1e-7).toString()", "1e-7"),
        ("(1000000000000000100).toString()", "1000000000000000100"),
        (
            r#"[1e21,"gap","1e+21"].unique().join("|")"#,
            "1e+21|1e+21|gap",
        ),
    ] {
        assert_eq!(evaluate(source), text(expected), "{source}");
    }
    assert_eq!(evaluate("[0,-0].unique().length"), number(1.0));
    assert_eq!(evaluate("number('\u{feff}2')"), number(2.0));
    assert_eq!(evaluate("'\u{feff}2\u{feff}'.trim()"), text("2"));
    assert_eq!(evaluate("'\u{85}2\u{85}'.trim()"), text("\u{85}2\u{85}"));
    assert!(evaluate_expression(
        "number('\u{85}2')",
        &record(),
        &EvaluationOptions::default()
    )
    .is_err());
}
