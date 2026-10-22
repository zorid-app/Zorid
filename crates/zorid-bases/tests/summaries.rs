//! Independent summary oracles from the documented/static reference pipeline.
//! These tests assert actual returned-row scope, not renderer-mounted rows.
use serde_json::{json, Value};
use zorid_bases::{
    compile_base, compile_base_source, query_base, BaseQueryResult, BaseSnapshot, BaseValue,
    QueryOptions,
};

fn snapshot(rows: Vec<Value>) -> BaseSnapshot {
    serde_json::from_value(json!({
        "snapshotId": {"localStoreId":"summaries-store", "generationEpoch":"summaries-epoch", "generation":"1",
            "versions":{"schema":1,"extraction":"zorid-markdown-1:metadata-1","resolver":"link-nfc-lower-segment-utf16-v1","query":"literal-lines-exact-v1"}},
        "records":rows.into_iter().enumerate().map(|(i,row)| json!({
            "witness":{"entryId":format!("entry-{i}"),"revision":"r1"},
            "path":row["path"], "properties":row["properties"], "size": row.get("size").unwrap_or(&Value::Null),
            "tags":[], "ctimeMs":null,"mtimeMs":null
        })).collect::<Vec<_>>()
    })).unwrap()
}
fn row(path: &str, properties: Value) -> Value {
    json!({"path":path,"properties":properties})
}
fn run(config: Value, rows: Vec<Value>) -> BaseQueryResult {
    let program = compile_base(serde_json::from_value(config).unwrap()).unwrap();
    query_base(&program, &snapshot(rows), &QueryOptions::default()).unwrap()
}
fn number(value: &BaseValue) -> f64 {
    match value {
        BaseValue::Number { value } => *value,
        value => panic!("expected number, got {value:?}"),
    }
}
fn numeric(name: &str, values: Vec<Value>) -> BaseValue {
    let result = run(
        json!({"views":[{"type":"table","name":"T","order":["n"],"summaries":{"n":name}}]}),
        values
            .into_iter()
            .enumerate()
            .map(|(i, value)| row(&format!("{i}.md"), json!([["n", value]])))
            .collect(),
    );
    result.summaries["note.n"].clone()
}

#[test]
fn numeric_builtins_keep_reference_selection_rounding_and_mean_denominator() {
    let values = vec![json!(2), Value::Null, json!(4), json!("12"), json!(true)];
    for (name, expected) in [
        ("Sum", 6.0),
        ("Average", 1.2),
        ("Min", 2.0),
        ("Max", 4.0),
        ("Range", 2.0),
        ("Median", 3.0),
        ("Stddev", 1.0),
    ] {
        assert_eq!(number(&numeric(name, values.clone())), expected, "{name}");
    }
    assert_eq!(
        number(&numeric(
            "Median",
            vec![json!(8), json!(1), json!(3), json!(2)]
        )),
        2.5
    );
    assert_eq!(number(&numeric("Sum", vec![json!(-1.125)])), -1.12);
    assert_eq!(
        number(&numeric(
            "Stddev",
            vec![
                json!(2),
                json!(4),
                json!(4),
                json!(4),
                json!(5),
                json!(5),
                json!(7),
                json!(9)
            ]
        )),
        2.0
    );
}

#[test]
fn class_dispatch_uses_first_nonnull_value_and_exact_names() {
    assert_eq!(
        numeric("Sum", vec![Value::Null, json!("3"), json!(4)]),
        BaseValue::Null
    );
    assert_eq!(numeric("sum", vec![json!(3), json!(4)]), BaseValue::Null);
    assert_eq!(
        numeric("Empty", vec![Value::Null, Value::Null]),
        BaseValue::Null
    );
    assert_eq!(
        number(&numeric("Empty", vec![Value::Null, json!(0), Value::Null])),
        2.0
    );
    assert_eq!(
        number(&numeric(
            "Filled",
            vec![json!(""), json!(false), Value::Null, json!([])]
        )),
        3.0
    );
    assert_eq!(
        number(&numeric(
            "Unique",
            vec![json!(1), json!("1"), Value::Null, Value::Null, json!(1)]
        )),
        3.0
    );
}

#[test]
fn checkbox_summaries_count_values_and_ignore_null() {
    let values = vec![json!(true), json!(false), Value::Null, json!(true)];
    assert_eq!(number(&numeric("Checked", values.clone())), 2.0);
    assert_eq!(number(&numeric("Unchecked", values)), 1.0);
}

#[test]
fn overall_and_groups_cover_exact_filtered_visible_searched_sorted_limited_rows() {
    let program = compile_base(
        serde_json::from_value(json!({
            "filters":"active == true",
            "views":[{"type":"table","name":"T","order":["file.name","n"],"filters":"n >= 3",
                "groupBy":{"property":"group","direction":"ASC"},"groupOrder":["A","B"],
                "sort":[{"property":"n","direction":"DESC"}],"limit":2,"summaries":{"n":"Sum"}}]
        }))
        .unwrap(),
    )
    .unwrap();
    let rows = [
        ("Keep low.md", 4, "A", true),
        ("Keep high.md", 9, "A", true),
        ("Keep middle.md", 7, "B", true),
        ("Keep excluded.md", 100, "C", true),
        ("Other.md", 99, "B", true),
        ("Keep inactive.md", 200, "A", false),
        ("Keep small.md", 1, "B", true),
    ]
    .into_iter()
    .map(|(path, n, group, active)| {
        row(
            path,
            json!([["n", n], ["group", group], ["active", active]]),
        )
    })
    .collect();
    let mut options = QueryOptions::default();
    options.search_terms = vec!["Keep".into()];
    let result = query_base(&program, &snapshot(rows), &options).unwrap();
    assert_eq!(
        result
            .rows
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>(),
        vec!["Keep high.md", "Keep middle.md"]
    );
    assert_eq!(
        (
            result.counts.matched,
            result.counts.after_group_order,
            result.counts.after_search,
            result.counts.returned
        ),
        (5, 4, 3, 2)
    );
    assert_eq!(number(&result.summaries["note.n"]), 16.0);
    assert_eq!(result.groups.len(), 2);
    assert_eq!(number(&result.groups[0].summaries["note.n"]), 9.0);
    assert_eq!(number(&result.groups[1].summaries["note.n"]), 7.0);
    assert_eq!(
        result
            .groups
            .iter()
            .map(|g| g.entry_ids.len())
            .sum::<usize>(),
        2
    );
}

#[test]
fn custom_summaries_override_builtins_and_run_for_empty_results_and_missing_properties() {
    let result = run(
        json!({"summaries":{"Sum":"values.length","Count":"values.length"},
        "views":[{"type":"table","name":"T","summaries":{"n":"Sum","missing":"Count"}}]}),
        vec![
            row("A.md", json!([["n", 10]])),
            row("B.md", json!([["n", 20]])),
        ],
    );
    assert_eq!(number(&result.summaries["note.n"]), 2.0);
    assert_eq!(number(&result.summaries["note.missing"]), 2.0);
    let empty = run(
        json!({"summaries":{"Count":"values.length"},"views":[{"type":"table","name":"T","summaries":{"missing":"Count"}}]}),
        vec![],
    );
    assert_eq!(number(&empty.summaries["note.missing"]), 0.0);
    assert_eq!(number(&empty.groups[0].summaries["note.missing"]), 0.0);
}

#[test]
fn all_null_group_custom_sum_plus_one_stays_null_with_independent_overall_scope() {
    let result = run(
        json!({"summaries":{"TotalPlusOne":"values.sum() + 1"},
        "views":[{"type":"table","name":"T","groupBy":{"property":"group","direction":"ASC"},
            "summaries":{"n":"TotalPlusOne"}}]}),
        vec![
            row("Missing.md", json!([])),
            row("Null.md", json!([["n", null], ["group", null]])),
            row("Ten.md", json!([["n", 10], ["group", "Numbers"]])),
            row("Twenty.md", json!([["n", 20], ["group", "Numbers"]])),
        ],
    );

    assert_eq!(result.rows.len(), 4);
    assert_eq!(result.groups.len(), 2);
    let null_group = result
        .groups
        .iter()
        .find(|group| matches!(group.key, Some(BaseValue::Null)))
        .expect("missing and explicit-null properties share the empty group");
    assert_eq!(null_group.entry_ids.len(), 2);
    assert_eq!(null_group.summaries.get("note.n"), Some(&BaseValue::Null));
    let numeric_group = result
        .groups
        .iter()
        .find(|group| matches!(&group.key, Some(BaseValue::String { value }) if value == "Numbers"))
        .expect("numeric rows retain their separate group");
    assert_eq!(numeric_group.entry_ids.len(), 2);
    assert_eq!(number(&numeric_group.summaries["note.n"]), 31.0);
    assert_eq!(number(&result.summaries["note.n"]), 31.0);
    assert!(result.diagnostics.is_empty());
}

#[test]
fn summary_context_exposes_only_values_with_case_insensitive_lookup_and_callback_bindings() {
    let result = run(
        json!({"formulas":{"secret":"99"},"summaries":{
        "Scope":"if(note == null && file == null && this == null && formula.secret == null, VALUES.map(value * 2).sum(), 999)"},
        "views":[{"type":"table","name":"T","summaries":{"n":"Scope"}}]}),
        vec![row("A.md", json!([["n", 2], ["values", [900]]]))],
    );
    assert_eq!(number(&result.summaries["note.n"]), 4.0);
}

#[test]
fn date_summaries_keep_typed_dates_and_duration_range() {
    let result = run(
        json!({"formulas":{"day":"date(day)"},"views":[{"type":"table","name":"T","summaries":{"formula.day":"Earliest"}}]}),
        vec![
            row("A.md", json!([["day", "2024-01-03"]])),
            row("B.md", json!([["day", "2024-01-01"]])),
        ],
    );
    assert_eq!(
        result.summaries["formula.day"],
        BaseValue::Date {
            timestamp: 1704067200000,
            has_time: true
        }
    );
    let result = run(
        json!({"formulas":{"day":"date(day)"},"views":[{"type":"table","name":"T","summaries":{"formula.day":"Range"}}]}),
        vec![
            row("A.md", json!([["day", "2024-01-03"]])),
            row("B.md", json!([["day", "2024-01-01"]])),
        ],
    );
    match &result.summaries["formula.day"] {
        BaseValue::Duration { milliseconds, .. } => assert_eq!(*milliseconds, 172800000.0),
        other => panic!("{other:?}"),
    }
}

#[test]
fn custom_file_summary_reads_exact_snapshot_metadata() {
    let result = run(
        json!({"summaries":{"Bytes":"values.map(value.size).sum()"},"views":[{"type":"table","name":"T","summaries":{"file.file":"Bytes"}}]}),
        vec![
            json!({"path":"A.md","properties":[],"size":12}),
            json!({"path":"B.png","properties":[],"size":30}),
        ],
    );
    assert_eq!(number(&result.summaries["file.file"]), 42.0);
}

#[test]
fn summary_semantic_errors_are_cells_and_input_errors_can_be_counted() {
    let result = run(
        json!({"formulas":{"bad":"number('bad')"},"summaries":{"Broken":"missingFunction()","Filled":"values.filter(!value.isType('null')).length"},
        "views":[{"type":"table","name":"T","summaries":{"n":"Broken","formula.bad":"Filled"}}]}),
        vec![row("A.md", json!([["n", 1]]))],
    );
    assert!(
        matches!(&result.summaries["note.n"],BaseValue::Error{code,..} if code=="unknown-function")
    );
    assert_eq!(number(&result.summaries["formula.bad"]), 1.0);
}

#[test]
fn summaries_share_query_work_budget_and_custom_clocks_set_refresh_dependency() {
    let program=compile_base_source("summaries:\n  Today: today()\nviews:\n  - type: table\n    name: T\n    summaries:\n      n: Today\n").unwrap();
    assert_eq!(
        program.refresh_dependency(0),
        zorid_bases::BaseClockDependency::Day
    );
    let rows = snapshot(vec![row("A.md", json!([["n", 1]]))]);
    let normal = query_base(&program, &rows, &QueryOptions::default()).unwrap();
    let mut options = QueryOptions::default();
    options.max_steps = normal.steps_used - 1;
    assert_eq!(
        query_base(&program, &rows, &options).unwrap_err().code,
        "budget"
    );
    options = QueryOptions::default();
    options.evaluation.max_steps = 1;
    assert_eq!(
        query_base(&program, &rows, &options).unwrap_err().code,
        "budget"
    );
}

#[test]
fn absent_summaries_do_not_add_wire_keys_and_invalid_mappings_reject() {
    let result = run(json!({}), vec![row("A.md", json!([]))]);
    let wire = serde_json::to_value(result).unwrap();
    assert!(wire.get("summaries").is_none());
    assert!(wire["groups"][0].get("summaries").is_none());
    for source in [
        "summaries: []",
        "summaries: {Total: 1}",
        "views: [{type: table, name: T, summaries: []}]",
        "views: [{type: table, name: T, summaries: {n: 3}}]",
    ] {
        assert!(compile_base_source(source).is_err(), "{source}");
    }
}

#[test]
fn footer_picker_previews_one_hidden_property_without_saving_summary_configuration() {
    let program =
        compile_base_source("views:\n  - type: table\n    name: T\n    order: [file.name]\n")
            .unwrap();
    let rows = snapshot(vec![
        row("A.md", json!([["rating", 10]])),
        row("B.md", json!([["rating", 20]])),
        row("C.md", json!([])),
    ]);
    let mut options = QueryOptions::default();
    options.summary_preview_property = Some("rating".into());
    let result = query_base(&program, &rows, &options).unwrap();
    let previews = result.summary_previews.as_ref().unwrap();
    for (name, expected) in [
        ("Empty", 1.0),
        ("Filled", 2.0),
        ("Unique", 3.0),
        ("Average", 10.0),
        ("Sum", 30.0),
        ("Min", 10.0),
        ("Max", 20.0),
        ("Range", 10.0),
        ("Median", 15.0),
        ("Stddev", 5.0),
    ] {
        assert_eq!(number(&previews[name]), expected, "{name}");
    }
    assert_eq!(previews.len(), 10);
    assert!(result.summaries.is_empty());
    assert!(result.groups[0].summaries.is_empty());
    assert!(program.configuration.get("summaries").is_none());
    options.summary_preview_property = None;
    assert!(query_base(&program, &rows, &options)
        .unwrap()
        .summary_previews
        .is_none());
}

#[test]
fn picker_previews_keep_custom_errors_and_clock_refresh_without_widening_normal_queries() {
    let program=compile_base_source("summaries:\n  Sum: values.length\n  Broken: unknownFunction()\n  Today: today()\nviews:\n  - type: table\n    name: T\n").unwrap();
    let rows = snapshot(vec![row("A.md", json!([["n", 100]]))]);
    assert_eq!(
        program.refresh_dependency(0),
        zorid_bases::BaseClockDependency::None
    );
    let mut options = QueryOptions::default();
    options.summary_preview_property = Some("n".into());
    let result = query_base(&program, &rows, &options).unwrap();
    let previews = result.summary_previews.unwrap();
    assert_eq!(number(&previews["Sum"]), 1.0);
    assert!(matches!(&previews["Broken"],BaseValue::Error{code,..} if code=="unknown-function"));
    assert_eq!(
        result.refresh_hint.unwrap().dependency,
        zorid_bases::BaseClockDependency::Instant,
        "unknown functions retain conservative instant dependence"
    );
    let baseline = query_base(&program, &rows, &QueryOptions::default()).unwrap();
    assert_eq!(
        baseline.refresh_hint.unwrap().dependency,
        zorid_bases::BaseClockDependency::None
    );
}

#[test]
fn group_footer_previews_use_only_that_groups_final_limited_rows() {
    let program=compile_base_source("views:\n  - type: table\n    name: T\n    groupBy: {property: group, direction: ASC}\n    sort: [{property: n, direction: DESC}]\n    limit: 2\n").unwrap();
    let rows = snapshot(vec![
        row("A.md", json!([["group", "A"], ["n", 2]])),
        row("B.md", json!([["group", "A"], ["n", 6]])),
        row("C.md", json!([["group", "B"], ["n", 100]])),
    ]);
    let mut options = QueryOptions::default();
    options.summary_preview_property = Some("n".into());
    let overall = query_base(&program, &rows, &options).unwrap();
    assert_eq!(
        number(&overall.summary_previews.as_ref().unwrap()["Sum"]),
        106.0
    );
    options.summary_preview_group_key_id = overall
        .groups
        .iter()
        .find(|group| group.key == Some(BaseValue::String { value: "A".into() }))
        .unwrap()
        .key_id
        .clone();
    let scoped = query_base(&program, &rows, &options).unwrap();
    assert_eq!(
        number(&scoped.summary_previews.as_ref().unwrap()["Sum"]),
        6.0,
        "limit excludes the other A row before summary grouping"
    );
    assert_eq!(scoped.rows, overall.rows);
    assert_eq!(scoped.counts, overall.counts);
    assert!(scoped.summaries.is_empty());
    options.summary_preview_group_key_id = Some("base-key-v1:no-longer-present".into());
    assert_eq!(
        query_base(&program, &rows, &options).unwrap_err().code,
        "stale-source"
    );
    options.summary_preview_property = None;
    assert_eq!(
        query_base(&program, &rows, &options).unwrap_err().code,
        "configuration"
    );
}

#[test]
fn group_picker_candidates_use_the_groups_own_first_nonnull_value_class() {
    let program=compile_base_source("summaries:\n  Count: values.length\nviews:\n  - type: table\n    name: T\n    groupBy: {property: group, direction: ASC}\n").unwrap();
    let rows = snapshot(vec![
        row("A.md", json!([["group", "A"], ["n", 10]])),
        row("B.md", json!([["group", "B"], ["n", "ten"]])),
    ]);
    let baseline = query_base(&program, &rows, &QueryOptions::default()).unwrap();
    let mut options = QueryOptions::default();
    options.summary_preview_property = Some("n".into());
    options.summary_preview_group_key_id = baseline
        .groups
        .iter()
        .find(|group| group.key == Some(BaseValue::String { value: "B".into() }))
        .unwrap()
        .key_id
        .clone();
    let result = query_base(&program, &rows, &options).unwrap();
    let previews = result.summary_previews.unwrap();
    assert!(!previews.contains_key("Sum"));
    assert_eq!(number(&previews["Count"]), 1.0);
    assert_eq!(number(&previews["Filled"]), 1.0);
}
