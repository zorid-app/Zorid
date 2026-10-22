//! Selected syntax is admitted before row iteration, including an empty vault.
use serde_json::{json, Value};
use zorid_bases::{
    compile_base_source, query_base, BaseSnapshot, BaseValue, OperationCancellation, QueryOptions,
};

fn snapshot(rows: Vec<Value>) -> BaseSnapshot {
    serde_json::from_value(json!({
        "snapshotId":{"localStoreId":"regex-admission","generationEpoch":"epoch","generation":"1",
          "versions":{"schema":1,"extraction":"zorid-markdown-1:metadata-1","resolver":"link-nfc-lower-segment-utf16-v1","query":"literal-lines-exact-v1"}},
        "records":rows.into_iter().enumerate().map(|(i,row)| json!({
          "witness":{"entryId":format!("entry-{i}"),"revision":"r1"},
          "path":row["path"],"properties":[],"tags":[],"size":null,"ctimeMs":null,"mtimeMs":null
        })).collect::<Vec<_>>()
    })).unwrap()
}

fn assert_parse(value: &BaseValue) {
    assert!(
        matches!(value, BaseValue::Error {code, ..} if code == "parse"),
        "{value:?}"
    );
}

#[test]
fn malformed_untaken_regex_keeps_formula_and_filter_error_presentation() {
    let empty = snapshot(vec![]);
    let one = snapshot(vec![json!({"path":"A.md"})]);
    let options = QueryOptions::default();
    let formulas = compile_base_source("formulas:\n  invalid: 'if(true, 1, /(/)'\nviews:\n  - type: table\n    name: Formula\n    order: [formula.invalid]\n").unwrap();
    let no_rows = query_base(&formulas, &empty, &options).unwrap();
    assert!(no_rows.rows.is_empty());
    assert!(no_rows.diagnostics.is_empty());
    let rows = query_base(&formulas, &one, &options).unwrap();
    assert_parse(&rows.rows[0].values["formula.invalid"]);

    let filters = compile_base_source(
        "filters: 'if(true, true, /(/)'\nviews:\n  - type: table\n    name: Filter\n",
    )
    .unwrap();
    let no_rows = query_base(&filters, &empty, &options).unwrap();
    assert!(no_rows.rows.is_empty());
    assert!(no_rows.diagnostics.is_empty());
    let rows = query_base(&filters, &one, &options).unwrap();
    assert!(rows.rows.is_empty());
    assert!(rows
        .diagnostics
        .iter()
        .any(|issue| issue.phase == "filter" && issue.code == "parse"));
}

#[test]
fn malformed_selected_summary_is_a_visible_error_even_with_no_values() {
    let program = compile_base_source("summaries:\n  Invalid: 'if(true, 1, /(/)'\nviews:\n  - type: table\n    name: Summary\n    summaries: {note.n: Invalid}\n").unwrap();
    let rows = query_base(&program, &snapshot(vec![]), &QueryOptions::default()).unwrap();
    assert_parse(&rows.summaries["note.n"]);
}

#[test]
fn selected_filters_pay_regex_admission_on_empty_rows_and_warm_caches() {
    let expression = format!("if(true, true, /{}/)", "a".repeat(4096));
    let source = format!("views:\n  - type: table\n    name: Unselected\n  - type: table\n    name: Selected\n    filters:\n      or:\n        - 'true'\n        - '{expression}'\n");
    let program = compile_base_source(&source).unwrap();
    let empty = snapshot(vec![]);
    let mut options = QueryOptions::default();
    options.view_index = 1;
    assert!(query_base(&program, &empty, &options)
        .unwrap()
        .rows
        .is_empty());
    options.max_steps = 128;
    assert_eq!(
        query_base(&program, &empty, &options).unwrap_err().code,
        "budget"
    );
    options.view_index = 0;
    assert!(query_base(&program, &empty, &options)
        .unwrap()
        .rows
        .is_empty());
}

#[test]
fn preview_admits_all_custom_summaries_but_otherwise_only_selected_names() {
    let expression = format!("if(true, 1, /{}/)", "a".repeat(4096));
    let source = format!("summaries:\n  Small: 'values.length'\n  Expensive: '{expression}'\nviews:\n  - type: table\n    name: Small only\n    summaries: {{note.n: Small}}\n  - type: table\n    name: Expensive\n    summaries: {{note.n: Expensive}}\n");
    let program = compile_base_source(&source).unwrap();
    let empty = snapshot(vec![]);
    let mut options = QueryOptions::default();
    options.max_steps = 128;
    assert_eq!(
        query_base(&program, &empty, &options).unwrap().summaries["note.n"],
        BaseValue::Number { value: 0.0 }
    );
    options.view_index = 1;
    assert_eq!(
        query_base(&program, &empty, &options).unwrap_err().code,
        "budget"
    );
    options.view_index = 0;
    options.summary_preview_property = Some("note.n".into());
    assert_eq!(
        query_base(&program, &empty, &options).unwrap_err().code,
        "budget"
    );
}

#[test]
fn empty_query_formula_admission_preserves_resource_and_cancellation_failures() {
    let source = format!(
        "formulas:\n  expensive: 'if(true, 1, /{}/)'\nviews:\n  - type: table\n    name: Formula\n",
        "a".repeat(4096)
    );
    let program = compile_base_source(&source).unwrap();
    let empty = snapshot(vec![]);
    let mut options = QueryOptions::default();
    options.max_steps = 128;
    assert_eq!(
        query_base(&program, &empty, &options).unwrap_err().code,
        "budget"
    );
    let cancellation = OperationCancellation::default();
    cancellation.cancel();
    options.evaluation.cancellation = Some(cancellation);
    assert_eq!(
        query_base(&program, &empty, &options).unwrap_err().code,
        "cancelled"
    );
}
