//! Source-query explanation/accounting checks, separate from runtime/paging gates.
use zorid_document::SourceRange;
use zorid_index::{
    CompiledSearchQuery, ExplanationNode, SearchExplanationKind as Kind, SearchLimits,
    SearchOptions, SearchScope, SEARCH_DIALECT,
};

fn compile(query: &str, case_sensitive: bool) -> CompiledSearchQuery {
    CompiledSearchQuery::compile(
        query,
        SearchOptions { case_sensitive },
        SearchLimits::default(),
    )
    .unwrap()
}
fn range(query: &str, spelling: &str) -> SourceRange {
    let start = query.find(spelling).unwrap();
    let end = start + spelling.len();
    SourceRange {
        bytes: [start as u32, end as u32],
        utf16: [
            query[..start].encode_utf16().count() as u32,
            query[..end].encode_utf16().count() as u32,
        ],
    }
}
fn node(query: &str) -> ExplanationNode {
    compile(query, false).explanation().root.unwrap()
}

#[test]
fn exact_unicode_and_escaped_spelling_ranges_come_from_compiled_tokens() {
    let query = r#"  file:("😀a" OR -/b\/c/) [tag:>2]  "#;
    let compiled = compile(query, false);
    let explanation = compiled.explanation();
    assert_eq!(explanation.dialect, SEARCH_DIALECT);
    let root = explanation.root.unwrap();
    assert_eq!(root.kind, Kind::And);
    assert_eq!(
        root.query_range,
        range(query, r#"file:("😀a" OR -/b\/c/) [tag:>2]"#)
    );
    let file = &root.children[0];
    assert_eq!(file.kind, Kind::Scope);
    assert_eq!(file.scope, Some(SearchScope::File));
    let or = &file.children[0];
    assert_eq!(or.kind, Kind::Or);
    assert_eq!(or.query_range, range(query, r#"("😀a" OR -/b\/c/)"#));
    assert_eq!(or.children[0].kind, Kind::Quoted);
    assert_eq!(or.children[0].query_range, range(query, r#""😀a""#));
    assert_eq!(or.children[0].operand.as_deref(), Some("😀a"));
    assert_eq!(or.children[0].scope, Some(SearchScope::File));
    let not = &or.children[1];
    assert_eq!(not.kind, Kind::Not);
    assert_eq!(not.query_range, range(query, r#"-/b\/c/"#));
    assert_eq!(not.children[0].kind, Kind::Regex);
    assert_eq!(not.children[0].operand.as_deref(), Some("b/c"));
    assert_eq!(not.children[0].query_range, range(query, r#"/b\/c/"#));
    let property = &root.children[1];
    assert_eq!(property.kind, Kind::Property);
    assert_eq!(property.query_range, range(query, "[tag:>2]"));
    assert_eq!(property.children.len(), 2);
    assert_eq!(property.children[0].operand.as_deref(), Some("tag"));
    assert_eq!(property.children[1].kind, Kind::Compare);
    assert_eq!(property.children[1].operand.as_deref(), Some(">2"));
    assert!(property.children[1].children.is_empty());
}

#[test]
fn effective_case_and_field_scope_follow_evaluator_context() {
    let root = compile("match-case:file:(A ignore-case:B)", false)
        .explanation()
        .root
        .unwrap();
    assert_eq!(root.scope, Some(SearchScope::MatchCase));
    assert!(root.case_sensitive);
    let file = &root.children[0];
    assert_eq!(file.scope, Some(SearchScope::File));
    assert!(file.case_sensitive);
    let and = &file.children[0];
    assert_eq!(and.kind, Kind::And);
    assert!(and.children[0].case_sensitive);
    assert_eq!(and.children[0].scope, Some(SearchScope::File));
    assert_eq!(and.children[1].scope, Some(SearchScope::IgnoreCase));
    assert!(!and.children[1].case_sensitive);
    assert_eq!(and.children[1].children[0].scope, Some(SearchScope::File));
    assert!(!and.children[1].children[0].case_sensitive);

    let tag = compile("match-case:tag:Topic", true)
        .explanation()
        .root
        .unwrap();
    assert_eq!(tag.children[0].scope, Some(SearchScope::Tag));
    assert!(!tag.children[0].case_sensitive);
    assert!(!tag.children[0].children[0].case_sensitive);
    assert_eq!(tag.children[0].children[0].scope, Some(SearchScope::Tag));
}

#[test]
fn quoted_property_keys_override_case_without_changing_other_key_or_value_operands() {
    let query = r#"match-case:["status":ACTIVE]"#;
    let root = node(query);
    let property = &root.children[0];
    assert!(root.case_sensitive);
    assert!(property.case_sensitive);
    assert_eq!(property.children[0].kind, Kind::Quoted);
    assert_eq!(
        property.children[0].query_range,
        range(query, r#""status""#)
    );
    assert!(!property.children[0].case_sensitive);
    assert_eq!(property.children[1].kind, Kind::Text);
    assert_eq!(property.children[1].query_range, range(query, "ACTIVE"));
    assert!(property.children[1].case_sensitive);

    let ordinary = node(r#"match-case:[status:"ACTIVE"]"#);
    let property = &ordinary.children[0];
    assert_eq!(property.children[0].kind, Kind::Text);
    assert!(property.children[0].case_sensitive);
    assert_eq!(property.children[1].kind, Kind::Quoted);
    assert!(property.children[1].case_sensitive);

    let grouped = node(r#"match-case:[("status" OR -"archived" OR /state/):"ACTIVE"]"#);
    let property = &grouped.children[0];
    let key = &property.children[0];
    assert_eq!(key.kind, Kind::Or);
    assert!(key.case_sensitive);
    assert!(!key.children[0].case_sensitive);
    assert_eq!(key.children[1].kind, Kind::Not);
    assert!(key.children[1].case_sensitive);
    assert!(!key.children[1].children[0].case_sensitive);
    assert_eq!(key.children[2].kind, Kind::Regex);
    assert!(key.children[2].case_sensitive);
    assert!(property.children[1].case_sensitive);
}

#[test]
fn explanations_preserve_real_parser_precedence_and_tolerant_empty_shapes() {
    let root = node("(a OR b) c");
    assert_eq!(root.kind, Kind::And);
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].kind, Kind::Or);
    assert_eq!(root.children[0].children.len(), 2);
    assert_eq!(root.children[0].query_range.bytes, [0, 8]);
    assert_eq!(node("foo OR").kind, Kind::Text);
    assert_eq!(node("foo OR").query_range.bytes, [0, 3]);
    for empty in ["", "   ", "-", "OR ignored"] {
        assert!(compile(empty, false).explanation().root.is_none());
    }
    let scope = node("file:");
    assert_eq!(scope.query_range.bytes, [0, 5]);
    assert_eq!(scope.children[0].query_range.bytes, [5, 5]);
    assert_eq!(scope.children[0].operand.as_deref(), Some(""));
    assert_eq!(scope.children[0].scope, Some(SearchScope::File));
    let property = node("[a:]");
    assert_eq!(property.children.len(), 1);
    let empty_group = node("()");
    assert_eq!(empty_group.kind, Kind::Text);
    assert_eq!(empty_group.query_range.bytes, [0, 2]);
}

#[test]
fn explanation_clones_are_detached_and_admission_limits_stay_unchanged() {
    let compiled = compile("TRUE FALSE EMPTY", true);
    let mut copy = compiled.explanation();
    copy.root.as_mut().unwrap().children.clear();
    let original = compiled.explanation().root.unwrap();
    assert_eq!(original.children.len(), 3);
    assert!(original
        .children
        .iter()
        .all(|c| c.kind == Kind::Constant && c.case_sensitive));
    let too_long = "a".repeat(4097);
    assert!(CompiledSearchQuery::compile(
        &too_long,
        SearchOptions::default(),
        SearchLimits::default()
    )
    .is_err());
    let too_many = std::iter::repeat_n("a", 513).collect::<Vec<_>>().join(" ");
    assert!(CompiledSearchQuery::compile(
        &too_many,
        SearchOptions::default(),
        SearchLimits::default()
    )
    .is_err());
}

#[test]
fn retained_accounting_includes_owned_tree_and_both_case_component_reservations() {
    let limits = SearchLimits {
        regex_bytes: 256 * 1024,
        regex_variant_bytes: 64 * 1024,
        ..SearchLimits::default()
    };
    let compile =
        |q| CompiledSearchQuery::compile(q, SearchOptions::default(), limits.clone()).unwrap();
    let literal = compile("alpha");
    let pair = compile("alpha beta");
    // Two retained case variants, each with compiled-program + lazy-DFA admission.
    assert!(literal.retained_bytes() >= 4 * 64 * 1024 + "alpha".len() * 2);
    assert!(pair.retained_bytes() >= 8 * 64 * 1024 + "alpha beta".len());
    // Comparator parsing temporarily compiled a pattern, then discarded it:
    // neither it nor the process-owned fixed word classifier is retained here.
    assert!(compile("<2").retained_bytes() < 64 * 1024);
    assert!(compile("TRUE").retained_bytes() < 64 * 1024);
    assert!(compile("").retained_bytes() > 0);
}
