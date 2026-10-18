use zorid_bases::types::{
    compile_type_yaml, task_type_summaries, TypeYamlSource, MAX_TYPE_SOURCE_BYTES,
};
use zorid_bases::{PropertyValue, RecordWitness};
use zorid_core::{EntryId, Revision};
fn source(name: &str, text: String) -> TypeYamlSource {
    TypeYamlSource {
        witness: RecordWitness {
            entry_id: EntryId::new(name).unwrap(),
            revision: Revision::new("r1").unwrap(),
        },
        path: format!("{name}.yaml"),
        source: text,
    }
}
#[test]
fn actual_yaml_uses_shared_parser_and_exposes_validated_capture_defaults() {
    let registry = compile_type_yaml(vec![source(
        "type-file",
        include_str!("../../../tests/fixtures/tasks/task-type.json").into(),
    )])
    .unwrap();
    let summaries = task_type_summaries(&registry).unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].status.key, "state");
    assert_eq!(summaries[0].planned_day.as_ref().unwrap().key, "plan");
    assert!(summaries[0]
        .capture_defaults
        .contains(&("detail".into(), PropertyValue::Null)));
    assert!(summaries[0]
        .capture_defaults
        .contains(&("state".into(), PropertyValue::String("todo".into()))));
}
#[test]
fn invalid_yaml_keeps_witness_diagnostic_without_typed_definition_or_defaults() {
    let registry =
        compile_type_yaml(vec![source("broken", "version: [unterminated\n".into())]).unwrap();
    assert_eq!(registry.sources()[0].witness.entry_id.as_str(), "broken");
    assert_eq!(registry.diagnostics()[0].code, "invalid_type_yaml");
    assert!(registry.diagnostics()[0].yaml.is_some());
    assert!(task_type_summaries(&registry).unwrap().is_empty());
}
#[test]
fn retained_source_byte_budget_precedes_yaml_parsing() {
    assert_eq!(
        compile_type_yaml(vec![source("large", " ".repeat(MAX_TYPE_SOURCE_BYTES + 1))])
            .unwrap_err()
            .code,
        "budget"
    );
}
