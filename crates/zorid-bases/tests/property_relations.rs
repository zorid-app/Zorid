//! Independent note fixtures exercise definitions and derived values through
//! the same Rust Base query pipeline used by the supported native/WASM hosts.
use zorid_bases::{
    compile_base_source, properties::PropertyDefinitions, query_base,
    query_generation_with_properties, relations::query_property_relations, BaseSnapshot, BaseValue,
    QueryOptions,
};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::{
    document_extraction_version, Generation, GenerationSource, IndexSnapshotId, MetadataRequest,
    SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, RESOLVER_VERSION,
};

const SETTINGS: &str = r#"version: 1
unfamiliar-setting: retained
properties:
  author:
    type: relation
    relation:
      multiple: false
      targetFilter: 'type == "author"'
  books:
    type: reverseRelation
    reverseRelation:
      property: author
  bookCount:
    type: rollup
    rollup:
      relation: books
      aggregation: count
  averageRating:
    type: rollup
    rollup:
      relation: books
      property: rating
      aggregation: average
  topics:
    type: multiselect
    options:
      - value: Rust
        color: orange
      - value: Design
        color: blue
"#;

fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}

fn generation(settings: &str, books: &[(&str, &str)]) -> Generation {
    let store = OperationId::new("properties-store").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        store,
        OperationId::new("properties-epoch").unwrap(),
        1,
        SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .unwrap(),
    )
    .unwrap();
    let mut inputs = vec![
        (
            "settings",
            "Properties.yaml".to_string(),
            settings.to_string(),
            false,
        ),
        (
            "ada",
            "Authors/Ada.md".to_string(),
            "---\ntype: author\n---\nAda's body\n".to_string(),
            true,
        ),
        (
            "grace",
            "Authors/Grace.md".to_string(),
            "---\ntype: author\n---\nGrace's body\n".to_string(),
            true,
        ),
    ];
    inputs.extend(
        books
            .iter()
            .map(|(name, text)| (*name, format!("Books/{name}.md"), text.to_string(), true)),
    );
    let entries = inputs
        .iter()
        .map(|(name, path, _, _)| EntryState {
            id: id(name),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
            deleted: false,
        })
        .collect::<Vec<_>>();
    let sources = inputs
        .into_iter()
        .map(|(name, _, text, markdown)| GenerationSource::Text {
            request: MetadataRequest {
                entry_id: id(name),
                content_revision: Revision::new("r1").unwrap(),
                source: text,
            },
            markdown,
        })
        .collect();
    Generation::from_sources(source, snapshot, entries, sources).unwrap()
}

#[test]
fn properties_are_optional_and_preserve_unknown_settings_and_readable_options() {
    let generation = generation(SETTINGS, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    assert!(definitions.diagnostics().is_empty());
    assert_eq!(definitions.source(), Some(SETTINGS));
    assert_eq!(
        definitions
            .configuration()
            .get("unfamiliar-setting")
            .unwrap()
            .as_str(),
        Some("retained")
    );
    assert_eq!(definitions.get("topics").unwrap().options[0].value, "Rust");
    assert!(PropertyDefinitions::absent(&generation).is_err());
    assert!(PropertyDefinitions::from_generation_source(
        &generation,
        &id("settings"),
        "properties: {}\n"
    )
    .is_err());
    assert!(PropertyDefinitions::from_generation_source(
        &generation,
        &id("ada"),
        "---\ntype: author\n---\nAda's body\n"
    )
    .is_err());
}

#[test]
fn normal_queries_filter_sort_formula_and_group_using_rollups() {
    let generation = generation(
        SETTINGS,
        &[
            (
                "first",
                "---\nauthor: '[[Authors/Ada]]'\nrating: 4\n---\nFirst body\n",
            ),
            (
                "second",
                "---\nauthor: '[[Authors/Ada|Ada Lovelace]]'\nrating: 2\n---\nSecond body\n",
            ),
            (
                "third",
                "---\nauthor: '[[Authors/Grace]]'\nrating: 5\n---\nThird body\n",
            ),
        ],
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let program = compile_base_source(
        r#"filters: 'type == "author" && bookCount >= 1'
formulas:
  doubled: bookCount * 2
views:
  - type: table
    name: Authors
    order: [file.name, books, bookCount, averageRating, formula.doubled]
    sort:
      - property: bookCount
        direction: DESC
"#,
    )
    .unwrap();
    let result = query_generation_with_properties(
        &program,
        &generation,
        &[],
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0].entry_id, id("ada"));
    assert_eq!(
        result.rows[0].values["note.bookCount"],
        BaseValue::Number { value: 2.0 }
    );
    assert_eq!(
        result.rows[0].values["note.averageRating"],
        BaseValue::Number { value: 3.0 }
    );
    assert_eq!(
        result.rows[0].values["formula.doubled"],
        BaseValue::Number { value: 4.0 }
    );
    assert!(result
        .available_properties
        .iter()
        .any(|name| name == "note.books"));
    match &result.rows[0].values["note.books"] {
        BaseValue::List { value } => {
            assert_eq!(value.len(), 2);
            assert!(
                matches!(&value[0], BaseValue::Link { target: Some(target), .. } if target.entry_id == id("first"))
            );
        }
        value => panic!("expected links: {value:?}"),
    }
}

#[test]
fn unresolved_and_incompatible_values_survive_without_false_rollups() {
    let generation = generation(
        SETTINGS,
        &[
            (
                "missing",
                "---\nauthor: '[[Deleted author]]'\nrating: 4\n---\n",
            ),
            ("invalid", "---\nauthor: 42\n---\n"),
            ("wrong", "---\nauthor: '[[Books/missing]]'\n---\n"),
        ],
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let snapshot = BaseSnapshot::from_generation(&generation, &[]).unwrap();
    let derived =
        query_property_relations(&snapshot, &definitions, &QueryOptions::default()).unwrap();
    assert!(
        matches!(&derived.rows()[&id("missing")].values["author"], BaseValue::Link { target: None, path, .. } if path == "Deleted author")
    );
    assert!(
        matches!(&derived.rows()[&id("invalid")].values["author"], BaseValue::Error { code, .. } if code == "invalid_relation")
    );
    assert!(derived
        .diagnostics()
        .iter()
        .any(|d| d.code == "relation_target_filter"));
    assert_eq!(
        derived.rows()[&id("ada")].values["bookCount"],
        BaseValue::Number { value: 0.0 }
    );
    let missing_record = snapshot
        .records()
        .iter()
        .find(|r| r.witness.as_ref().unwrap().entry_id == id("missing"))
        .unwrap();
    assert_eq!(
        missing_record
            .properties
            .iter()
            .find(|(name, _)| name == "author")
            .unwrap()
            .1
            .as_str(),
        Some("[[Deleted author]]")
    );
}

#[test]
fn count_deduplicates_targets_and_empty_numeric_rollups_have_defined_values() {
    let settings = "properties:\n  related:\n    type: relation\n    relation:\n      multiple: true\n  count:\n    type: rollup\n    rollup:\n      relation: related\n      aggregation: count\n  total:\n    type: rollup\n    rollup:\n      relation: related\n      property: rating\n      aggregation: sum\n";
    let generation = generation(
        settings,
        &[(
            "first",
            "---\nrelated: ['[[Authors/Ada]]', '[[Authors/Ada]]']\n---\n",
        )],
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    let values = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(
        values.rows()[&id("first")].values["count"],
        BaseValue::Number { value: 1.0 }
    );
    assert_eq!(
        values.rows()[&id("ada")].values["count"],
        BaseValue::Number { value: 0.0 }
    );
    assert_eq!(
        values.rows()[&id("ada")].values["total"],
        BaseValue::Number { value: 0.0 }
    );
}

#[test]
fn invalid_yaml_and_unknown_definition_kinds_are_visible_and_never_discard_source() {
    for settings in [
        "properties: [",
        "properties:\n  odd:\n    type: future-kind\n",
    ] {
        let generation = generation(settings, &[]);
        let definitions =
            PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
                .unwrap();
        assert!(!definitions.diagnostics().is_empty());
        assert_eq!(definitions.source(), Some(settings));
    }
}

#[test]
fn derived_values_cannot_be_attached_to_detached_rows_or_forged_graphs() {
    let generation = generation(SETTINGS, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let detached = BaseSnapshot::detached(generation.id().clone(), Vec::new());
    assert!(query_property_relations(&detached, &definitions, &QueryOptions::default()).is_err());
    let program = compile_base_source("views:\n  - type: table\n    name: Books\n").unwrap();
    assert!(query_base(&program, &detached, &QueryOptions::default()).is_ok());
}

#[test]
fn relation_work_and_output_are_bounded_and_cancellable() {
    let generation = generation(
        SETTINGS,
        &[("first", "---\nauthor: '[[Authors/Ada]]'\nrating: 4\n---\n")],
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let snapshot = BaseSnapshot::from_generation(&generation, &[]).unwrap();
    let mut options = QueryOptions::default();
    options.max_steps = 1;
    assert!(query_property_relations(&snapshot, &definitions, &options).is_err());
    options = QueryOptions::default();
    options.max_output_bytes = 128;
    assert!(query_property_relations(&snapshot, &definitions, &options).is_err());
    options = QueryOptions::default();
    let cancellation = zorid_bases::OperationCancellation::default();
    cancellation.cancel();
    options.evaluation.cancellation = Some(cancellation);
    assert!(query_property_relations(&snapshot, &definitions, &options).is_err());
}
