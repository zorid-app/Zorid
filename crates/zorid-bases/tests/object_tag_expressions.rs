//! Public-boundary oracles for the captured Object callback and Tag semantics.
//! Reference receipts: /private/tmp/zorid-bases-object-tag-reference-20261022
//! and /private/tmp/zorid-bases-tag-hydration-reference-20261022/provenance.json.
use serde_json::{json, Value};
use zorid_bases::{
    compile_base_source, evaluate_expression, query_base, BaseSnapshot, BaseValue, DetachedRecord,
    EvaluationOptions, OperationCancellation, PropertyValue, QueryOptions,
};

fn string(value: &str) -> BaseValue {
    BaseValue::String {
        value: value.into(),
    }
}
fn list(value: Vec<BaseValue>) -> BaseValue {
    BaseValue::List { value }
}
fn record() -> DetachedRecord {
    DetachedRecord {
        path: "Notes/Source.md".into(),
        tags: vec!["#Work/Project".into(), "#Personal".into()],
        properties: vec![
            ("index".into(), PropertyValue::Number(41.into())),
            ("acc".into(), PropertyValue::String("outer".into())),
            (
                "obj".into(),
                PropertyValue::Object(vec![
                    ("First".into(), PropertyValue::Number(1.into())),
                    ("second".into(), PropertyValue::Number(2.into())),
                    ("when".into(), PropertyValue::String("2026-01-01".into())),
                ]),
            ),
            (
                "tags".into(),
                PropertyValue::Array(vec![
                    PropertyValue::String("Work/Project".into()),
                    PropertyValue::String("Personal".into()),
                    PropertyValue::String(" Work ".into()),
                ]),
            ),
            (
                "plain".into(),
                PropertyValue::Array(vec![
                    PropertyValue::String("#Work/Project".into()),
                    PropertyValue::String("#Personal".into()),
                ]),
            ),
            (
                "config".into(),
                PropertyValue::Object(vec![
                    (
                        "TaGs".into(),
                        PropertyValue::Array(vec![PropertyValue::String("Work/Project".into())]),
                    ),
                    (
                        "children".into(),
                        PropertyValue::Array(vec![PropertyValue::Object(vec![(
                            "TAGS".into(),
                            PropertyValue::String("Deep/Child".into()),
                        )])]),
                    ),
                ]),
            ),
        ],
        ..Default::default()
    }
}
fn value(source: &str) -> BaseValue {
    evaluate_expression(source, &record(), &EvaluationOptions::default())
        .unwrap_or_else(|error| panic!("{source}: {error}"))
        .value
}
fn boolean(source: &str, expected: bool) {
    assert_eq!(
        value(source),
        BaseValue::Boolean { value: expected },
        "{source}"
    );
}

#[test]
fn object_map_returns_callback_values_in_key_order_with_exact_keys_and_typed_values() {
    assert_eq!(
        value("obj.map(key)"),
        list(vec![string("First"), string("second"), string("when")])
    );
    assert_eq!(
        value("obj.map(value)"),
        list(vec![
            BaseValue::Number { value: 1.0 },
            BaseValue::Number { value: 2.0 },
            BaseValue::Date {
                timestamp: 1767225600000,
                has_time: false
            },
        ])
    );
    assert_eq!(value("obj.map(null)"), list(vec![BaseValue::Null; 3]));
    assert_eq!(
        value("obj.map(if(key == 'when', value.isType('date'), value + 10))"),
        list(vec![
            BaseValue::Number { value: 11.0 },
            BaseValue::Number { value: 12.0 },
            BaseValue::Boolean { value: true },
        ])
    );
    // Object callbacks introduce only key/value. Outer index/acc remain visible.
    assert_eq!(
        value("obj.map(key + ':' + index + ':' + acc)"),
        list(vec![
            string("First:41:outer"),
            string("second:41:outer"),
            string("when:41:outer"),
        ])
    );
}

#[test]
fn object_filter_retains_original_values_and_object_shape() {
    assert_eq!(
        value("obj.filter(key == 'second')"),
        BaseValue::Object {
            value: vec![("second".into(), BaseValue::Number { value: 2.0 })],
        }
    );
    assert_eq!(
        value("obj.filter(value.isType('date'))"),
        BaseValue::Object {
            value: vec![(
                "when".into(),
                BaseValue::Date {
                    timestamp: 1767225600000,
                    has_time: false
                }
            )],
        }
    );
    assert_eq!(
        value("obj.filter(false)"),
        BaseValue::Object { value: vec![] }
    );
    boolean("obj.filter(true).isType('object')", true);
    boolean("obj.map(value).isType('list')", true);
}

#[test]
fn object_enumeration_uses_javascript_integer_key_order_across_callback_and_eager_methods() {
    let insertion = ["b", "10", "2", "01", "0", "4294967295", "4294967294", "a"];
    let ordered = ["0", "2", "10", "4294967294", "b", "01", "4294967295", "a"];
    let record = DetachedRecord {
        path: "Enumeration.md".into(),
        properties: vec![(
            "obj".into(),
            PropertyValue::Object(
                insertion
                    .iter()
                    .map(|key| ((*key).into(), PropertyValue::String(format!("v-{key}"))))
                    .collect(),
            ),
        )],
        ..Default::default()
    };
    for source in ["obj.keys()", "obj.map(key)", "obj.filter(true).keys()"] {
        assert_eq!(
            evaluate_expression(source, &record, &EvaluationOptions::default())
                .unwrap()
                .value,
            list(ordered.iter().map(|key| string(key)).collect()),
            "{source}"
        );
    }
    for source in [
        "obj.values()",
        "obj.map(value)",
        "obj.filter(true).values()",
    ] {
        assert_eq!(
            evaluate_expression(source, &record, &EvaluationOptions::default())
                .unwrap()
                .value,
            list(
                ordered
                    .iter()
                    .map(|key| string(&format!("v-{key}")))
                    .collect()
            ),
            "{source}"
        );
    }
}

#[test]
fn only_exact_lowercase_map_and_filter_activate_callback_scopes() {
    // Ordinary descriptor dispatch is case insensitive, while the callback
    // special cases are selected by the exact method spelling.
    assert_eq!(value("obj.MAP(value + 1)"), value("obj.values()"));
    assert_eq!(value("obj.FILTER(false)"), value("obj"));
    boolean("tags.MAP(value).contains('work')", true);
    boolean("tags.map(value).contains('work')", false);
}

#[test]
fn object_callbacks_have_exact_arity_and_propagate_callback_errors() {
    for source in [
        "obj.map()",
        "obj.map(value, key)",
        "obj.filter()",
        "obj.filter(true, false)",
    ] {
        assert_eq!(
            evaluate_expression(source, &record(), &EvaluationOptions::default())
                .unwrap_err()
                .code,
            "arity",
            "{source}"
        );
    }
    for source in ["obj.map(number('bad'))", "obj.filter(number('bad'))"] {
        assert_eq!(
            evaluate_expression(source, &record(), &EvaluationOptions::default())
                .unwrap_err()
                .code,
            "type",
            "{source}"
        );
    }
}

#[test]
fn null_members_of_raw_note_tag_arrays_report_a_type_diagnostic() {
    let record = DetachedRecord {
        path: "Invalid tags.md".into(),
        properties: vec![(
            "tags".into(),
            PropertyValue::Array(vec![PropertyValue::Null]),
        )],
        ..Default::default()
    };
    assert_eq!(
        evaluate_expression("tags", &record, &EvaluationOptions::default())
            .unwrap_err()
            .code,
        "type"
    );
}

#[test]
fn tags_hydrate_only_at_named_metadata_boundaries_and_keep_existing_wire_types() {
    assert_eq!(
        value("tags"),
        list(vec![
            string("#Work/Project"),
            string("#Personal"),
            string("# Work ")
        ])
    );
    assert_eq!(
        value("file.tags"),
        list(vec![string("#Work/Project"), string("#Personal")])
    );
    assert_eq!(
        value("plain"),
        list(vec![string("#Work/Project"), string("#Personal")])
    );
    assert_eq!(value("config.TaGs"), list(vec![string("#Work/Project")]));
    assert_eq!(
        value("config.children[0].TAGS"),
        list(vec![string("#Deep/Child")])
    );
    boolean("tags.isType('list')", true);
    boolean("tags[0].isType('string')", true);
    boolean("config.TaGs[0].matches('WORK')", true);
    boolean("config.children[0].TAGS[0].matches('deep')", true);
    // Raw note property hydration prefixes '#', but never trims stored text.
    boolean("tags[2].matches(' Work ')", true);
    boolean("tags[2].matches('Work')", false);
}

#[test]
fn tag_matches_normalizes_query_case_and_prefix_at_slash_boundaries() {
    for (source, expected) in [
        ("tags[0].matches('work')", true),
        ("tags[0].matches('#WORK')", true),
        ("tags[0].matches('Work/Project')", true),
        ("tags[0].matches('wor')", false),
        ("tags[0].matches('work/pro')", false),
        ("tags[0].matches('work/project/child')", false),
        ("file.tags[0].matches('WORK')", true),
    ] {
        boolean(source, expected);
    }
    assert_eq!(value("tags[0].matches(null)"), BaseValue::Null);
    for source in ["tags[0].matches()", "tags[0].matches('work', 'personal')"] {
        assert_eq!(
            evaluate_expression(source, &record(), &EvaluationOptions::default())
                .unwrap_err()
                .code,
            "arity",
            "{source}"
        );
    }
    assert_eq!(
        evaluate_expression(
            "tags[0].matches(1)",
            &record(),
            &EvaluationOptions::default()
        )
        .unwrap_err()
        .code,
        "type"
    );
}

#[test]
fn tags_keep_string_lexical_comparisons_and_computed_property_keys() {
    for (source, expected) in [
        ("tags[0] < '#Z'", true),
        ("'#A' < tags[0]", true),
        ("tags[0] > tags[1]", true),
        ("tags[0] <= '#Work/Project'", true),
        ("'#Work/Project' >= tags[0]", true),
        ("tags[0] < tags[1]", false),
    ] {
        boolean(source, expected);
    }
    let mut record = record();
    record.properties.push((
        "lookup".into(),
        PropertyValue::Object(vec![(
            "#Work/Project".into(),
            PropertyValue::Number(9.into()),
        )]),
    ));
    assert_eq!(
        evaluate_expression("lookup[tags[0]]", &record, &EvaluationOptions::default())
            .unwrap()
            .value,
        BaseValue::Number { value: 9.0 }
    );
}

#[test]
fn specialized_tag_membership_and_generic_list_membership_remain_distinct() {
    for source in [
        "tags.contains('WORK')",
        "file.tags.contains('work')",
        "tags.containsAny(['missing', 'WORK'])",
        "tags.containsAll(['work', '#PERSONAL'])",
        "tags.containsAll([])",
        "tags.map(value)[0].matches('work')",
        "tags.filter(true)[0].matches('work')",
        "tags.slice(0, 1)[0].matches('work')",
        "tags.reverse()[2].matches('work')",
        "tags.map(value).contains('#Work/Project')",
        "plain.containsAny(['missing', '#Work/Project'])",
        "plain.containsAll(['#Work/Project', '#Personal'])",
    ] {
        boolean(source, true);
    }
    for source in [
        "tags.contains('wor')",
        "tags.containsAll(['work', 'missing'])",
        "tags.map(value).contains('work')",
        "tags.filter(true).contains('work')",
        "tags.slice(0, 1).contains('work')",
        "tags.reverse().contains('work')",
        "tags.map(value).contains('#work/project')",
        "plain.contains('work')",
        "plain.containsAny(['missing', '#work/project'])",
        "tags.containsAny([])",
    ] {
        boolean(source, false);
    }
}

fn snapshot(rows: Vec<Value>) -> BaseSnapshot {
    serde_json::from_value(json!({
        "snapshotId": {"localStoreId":"object-tag-store", "generationEpoch":"object-tag-epoch", "generation":"1",
            "versions":{"schema":1,"extraction":"zorid-markdown-1:metadata-1","resolver":"link-nfc-lower-segment-utf16-v1","query":"literal-lines-exact-v1"}},
        "records":rows.into_iter().enumerate().map(|(i,row)| json!({
            "witness":{"entryId":format!("entry-{i}"),"revision":"r1"},
            "path":row["path"], "properties":row["properties"], "tags":[],
            "size":null,"ctimeMs":null,"mtimeMs":null
        })).collect::<Vec<_>>()
    })).unwrap()
}

#[test]
fn nested_formula_tag_lists_survive_query_group_summary_and_picker_projection() {
    let program = compile_base_source(
        r#"
formulas:
  wrapped: '[config]'
summaries:
  WorkCount: 'values.filter(value[0].TaGs.contains("work")).length'
  GenericWork: 'values.filter(value[0].plain.contains("work")).length'
views:
  - type: table
    name: Tags
    order: [file.name, formula.wrapped]
    groupBy: {property: group, direction: ASC}
    summaries: {formula.wrapped: WorkCount}
"#,
    )
    .unwrap();
    let rows = snapshot(vec![
        json!({"path":"A.md", "properties":[["group","A"],["config",{"TaGs":["Work/Project"],"plain":["#Work/Project"]}]]}),
        json!({"path":"B.md", "properties":[["group","B"],["config",{"TaGs":["Home"],"plain":["#Work/Project"]}]]}),
    ]);
    let mut options = QueryOptions::default();
    options.summary_preview_property = Some("formula.wrapped".into());
    let result = query_base(&program, &rows, &options).unwrap();
    assert_eq!(
        result.summaries["formula.wrapped"],
        BaseValue::Number { value: 1.0 }
    );
    assert_eq!(
        result.summary_previews.as_ref().unwrap()["WorkCount"],
        BaseValue::Number { value: 1.0 }
    );
    assert_eq!(
        result.summary_previews.as_ref().unwrap()["GenericWork"],
        BaseValue::Number { value: 0.0 }
    );
    assert_eq!(
        result.rows[0].values["formula.wrapped"],
        list(vec![BaseValue::Object {
            value: vec![
                ("TaGs".into(), list(vec![string("#Work/Project")])),
                ("plain".into(), list(vec![string("#Work/Project")])),
            ],
        }])
    );
    assert_eq!(result.groups.len(), 2);
    for group in &result.groups {
        let expected = if group.entry_ids.iter().any(|id| id.as_str() == "entry-0") {
            1.0
        } else {
            0.0
        };
        assert_eq!(
            group.summaries["formula.wrapped"],
            BaseValue::Number { value: expected }
        );
        options.summary_preview_group_key_id = group.key_id.clone();
        assert!(options.summary_preview_group_key_id.is_some());
        let scoped = query_base(&program, &rows, &options).unwrap();
        assert_eq!(
            scoped.summary_previews.as_ref().unwrap()["WorkCount"],
            BaseValue::Number { value: expected }
        );
        assert_eq!(
            scoped.summary_previews.as_ref().unwrap()["GenericWork"],
            BaseValue::Number { value: 0.0 }
        );
    }
}

#[test]
fn query_tag_shape_captures_the_evaluated_random_formula_without_reexecution() {
    // Both branches have identical public DTOs. Only the captured runtime list
    // kind decides membership; reevaluating random() cannot reconstruct it.
    let program = compile_base_source(
        r#"
formulas:
  mixed: 'if(random() > 0.5, tags, plain)'
  observed: 'formula.mixed.contains("work")'
summaries:
  WorkCount: 'values.filter(value.contains("work")).length'
views:
  - type: table
    name: Tags
    order: [file.name, formula.mixed, formula.observed]
    summaries: {formula.mixed: WorkCount}
"#,
    )
    .unwrap();
    let rows = snapshot(
        (0..24)
            .map(|i| {
                json!({
                    "path":format!("{i:02}.md"),
                    "properties":[["tags",["Work/Project"]],["plain",["#Work/Project"]]]
                })
            })
            .collect(),
    );
    let mut options = QueryOptions::default();
    options.evaluation.random_seed = Some(731);
    options.summary_preview_property = Some("formula.mixed".into());
    let result = query_base(&program, &rows, &options).unwrap();
    let count = result
        .rows
        .iter()
        .filter(|row| row.values["formula.observed"] == BaseValue::Boolean { value: true })
        .count();
    for row in &result.rows {
        assert_eq!(
            row.values["formula.mixed"],
            list(vec![string("#Work/Project")])
        );
    }
    let expected = BaseValue::Number {
        value: count as f64,
    };
    assert_eq!(result.summaries["formula.mixed"], expected);
    assert_eq!(
        result.summary_previews.as_ref().unwrap()["WorkCount"],
        expected
    );
}

#[test]
fn object_callbacks_and_tag_queries_respect_public_work_and_cancellation_limits() {
    let mut record = record();
    record.properties.push((
        "wide".into(),
        PropertyValue::Object(
            (0..128)
                .map(|i| (format!("key-{i}"), PropertyValue::Number(i.into())))
                .collect(),
        ),
    ));
    let preparation = evaluate_expression("1", &record, &EvaluationOptions::default())
        .unwrap()
        .steps_used;
    let options = EvaluationOptions {
        max_steps: preparation + 12,
        ..Default::default()
    };
    for source in ["wide.map(key + value)", "wide.filter(value >= 0)"] {
        assert_eq!(
            evaluate_expression(source, &record, &options)
                .unwrap_err()
                .code,
            "budget",
            "{source}"
        );
    }
    let cancellation = OperationCancellation::default();
    cancellation.cancel();
    let options = EvaluationOptions {
        cancellation: Some(cancellation),
        ..Default::default()
    };
    for source in ["obj.map(value)", "tags.containsAll(['work', 'personal'])"] {
        assert_eq!(
            evaluate_expression(source, &record, &options)
                .unwrap_err()
                .code,
            "cancelled",
            "{source}"
        );
    }
}
