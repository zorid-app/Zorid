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
    generation_with_settings_file(settings, books, true)
}

fn generation_with_settings_file(
    settings: &str,
    books: &[(&str, &str)],
    settings_file: bool,
) -> Generation {
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
    if !settings_file {
        inputs.remove(0);
    }
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
fn empty_or_unconfigured_property_settings_are_valid_without_invented_definitions() {
    for settings in ["", "{}\n", "version: 1\nfuture-setting: retained\n"] {
        let generation = generation(settings, &[]);
        let definitions =
            PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
                .unwrap();
        assert!(definitions.diagnostics().is_empty());
        assert_eq!(definitions.iter().count(), 0);
        assert_eq!(definitions.source(), Some(settings));
    }
}

#[test]
fn bounded_yaml_aliases_keep_the_source_and_cycles_are_diagnosed() {
    let settings = "shared: &options\n  type: multiselect\n  options: [{value: Rust}]\nproperties:\n  topics: *options\n";
    let first_generation = generation(settings, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&first_generation, &id("settings"), settings)
            .unwrap();
    assert!(definitions.diagnostics().is_empty());
    assert_eq!(definitions.get("topics").unwrap().options[0].value, "Rust");
    assert_eq!(definitions.source(), Some(settings));
    let settings = "properties: &cycle\n  cycle: *cycle\n";
    let cyclic_generation = generation(settings, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&cyclic_generation, &id("settings"), settings)
            .unwrap();
    assert!(!definitions.diagnostics().is_empty());
    assert_eq!(definitions.source(), Some(settings));
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
    let derived = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    let targets = &derived.relation_targets()["author"];
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].entry_id, id("ada"));
    assert_eq!(targets[0].path, "Authors/Ada.md");
    assert_eq!(targets[0].label, "Ada");
    assert!(
        matches!(&derived.rows()[&id("second")].values["author"], BaseValue::Link { path, display: Some(display), target: Some(target), .. } if path == "Authors/Ada.md" && display == "Ada Lovelace" && target.entry_id == id("ada"))
    );
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
fn relations_group_by_target_identity_even_when_source_links_have_different_aliases() {
    let generation = generation(
        SETTINGS,
        &[
            ("first", "---\nauthor: '[[Authors/Ada]]'\n---\n"),
            (
                "second",
                "---\nauthor: '[[Authors/Ada|Ada Lovelace]]'\n---\n",
            ),
            ("third", "---\nauthor: '[[Authors/Grace]]'\n---\n"),
        ],
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let program = compile_base_source("filters: 'file.inFolder(\"Books\")'\nviews:\n  - type: table\n    name: Books\n    order: [file.name, author]\n    groupBy: {property: author, direction: ASC}\n").unwrap();
    let result = query_generation_with_properties(
        &program,
        &generation,
        &[],
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(result.groups.len(), 2);
    let ada = result.groups.iter().find(|group| matches!(&group.key, Some(BaseValue::Link { target: Some(target), .. }) if target.entry_id == id("ada"))).unwrap();
    assert_eq!(ada.entry_ids.len(), 2);
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
fn invalid_derived_references_are_rejected_before_queries() {
    let settings = "properties:\n  broken:\n    type: reverseRelation\n    reverseRelation: {property: absent}\n  count:\n    type: rollup\n    rollup: {relation: broken, aggregation: count}\n";
    let generation = generation(settings, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    assert!(definitions.get("broken").is_none());
    assert!(definitions.get("count").is_none());
    assert_eq!(definitions.diagnostics().len(), 2);
    let values = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(values.definition_diagnostics().len(), 2);
}

#[test]
fn rollup_cycles_are_visible_errors_and_date_minima_preserve_date_type() {
    let settings = "properties:\n  related:\n    type: relation\n    relation: {multiple: true}\n  loop:\n    type: rollup\n    rollup: {relation: related, property: loop, aggregation: values}\n  earliest:\n    type: rollup\n    rollup: {relation: related, property: published, aggregation: min}\n";
    let generation = generation(
        settings,
        &[
            (
                "first",
                "---\nrelated: ['[[Books/first]]']\npublished: 2026-10-21\n---\n",
            ),
            (
                "second",
                "---\nrelated: ['[[Books/first]]', '[[Books/third]]']\n---\n",
            ),
            ("third", "---\npublished: 2026-01-01\n---\n"),
        ],
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
    assert!(
        matches!(&values.rows()[&id("first")].values["loop"], BaseValue::Error { code, .. } if code == "rollup_cycle")
    );
    assert_eq!(
        values.rows()[&id("second")].values["earliest"],
        BaseValue::Date {
            timestamp: 1767225600000,
            has_time: false
        }
    );
}

#[test]
fn omitted_relation_settings_default_to_single_note_target_picker() {
    let settings = "properties:\n  related:\n    type: relation\n";
    let generation = generation(
        settings,
        &[("first", "---\nrelated: '[[Authors/Ada]]'\n---\n")],
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    assert!(definitions.diagnostics().is_empty());
    let values = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(values.relation_targets()["related"].len(), 3);
    assert!(
        matches!(&values.rows()[&id("first")].values["related"], BaseValue::Link { target: Some(target), .. } if target.entry_id == id("ada"))
    );
    let mut options = QueryOptions::default();
    options.max_rows = 2;
    let failure = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &options,
    )
    .unwrap_err();
    assert_eq!(failure.code, "budget");
}

#[test]
fn clock_dependent_target_filters_refresh_even_when_the_base_expression_is_static() {
    let settings = "properties:\n  related:\n    type: relation\n    relation: {targetFilter: 'today() != null'}\n";
    let generation = generation(settings, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    let program = compile_base_source(
        "views:\n  - type: table\n    name: Notes\n    order: [file.name, related]\n",
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
    let hint = result.refresh_hint.unwrap();
    assert_eq!(hint.dependency, zorid_bases::BaseClockDependency::Day);
    assert_eq!(hint.next_wake_ms, Some(86_400_000));
}

#[test]
fn scalar_definitions_override_inference_and_preserve_incompatible_external_values() {
    let settings = "properties:\n  code: {type: text}\n  published: {type: date}\n  score: {type: number}\n  category:\n    type: select\n    options: [{value: Known}]\n  topics:\n    type: multiselect\n    options: [{value: Known}]\n";
    let generation = generation(settings, &[
        ("first", "---\ncode: '2026-01-01'\npublished: invalid-date\nscore: excellent\ncategory: Unknown\ntopics: [Known, Unknown]\n---\n"),
        ("second", "---\ncode: '2026-01-01'\npublished: 2026-01-01\nscore: 4\ncategory: Known\ntopics: [Known]\n---\n"),
    ]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    let program = compile_base_source("filters: 'file.inFolder(\"Books\")'\nviews:\n  - type: table\n    name: Books\n    order: [file.name, code, published, score, category, topics]\n").unwrap();
    let result = query_generation_with_properties(
        &program,
        &generation,
        &[],
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    let first = result
        .rows
        .iter()
        .find(|row| row.entry_id == id("first"))
        .unwrap();
    let second = result
        .rows
        .iter()
        .find(|row| row.entry_id == id("second"))
        .unwrap();
    assert_eq!(
        first.values["note.code"],
        BaseValue::String {
            value: "2026-01-01".into()
        }
    );
    assert_eq!(
        first.values["note.published"],
        BaseValue::String {
            value: "invalid-date".into()
        }
    );
    assert_eq!(
        first.values["note.score"],
        BaseValue::String {
            value: "excellent".into()
        }
    );
    assert_eq!(
        second.values["note.published"],
        BaseValue::Date {
            timestamp: 1767225600000,
            has_time: false
        }
    );
    assert_eq!(
        result
            .diagnostics
            .iter()
            .filter(
                |diagnostic| diagnostic.phase == "property" && diagnostic.entry_id == id("first")
            )
            .count(),
        4
    );
}

#[test]
fn plain_link_definitions_resolve_notes_and_preserve_external_urls() {
    let settings = "properties:\n  reference: {type: link}\n";
    let generation = generation(
        settings,
        &[
            ("first", "---\nreference: '[[Authors/Ada|Ada]]'\n---\n"),
            ("second", "---\nreference: https://example.org/books\n---\n"),
        ],
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
    assert!(
        matches!(&values.rows()[&id("first")].values["reference"], BaseValue::Link { path, target: Some(target), external: false, .. } if path == "Authors/Ada.md" && target.entry_id == id("ada"))
    );
    assert!(
        matches!(&values.rows()[&id("second")].values["reference"], BaseValue::Link { path, target: None, external: true, .. } if path == "https://example.org/books")
    );
    assert!(values.diagnostics().is_empty());
}

#[test]
fn file_and_link_expressions_read_the_same_snapshot_property_overlays() {
    let settings = format!("{SETTINGS}  code: {{type: text}}\n");
    let generation = generation(&settings, &[
        ("first", "---\nauthor: '[[Authors/Ada]]'\nrating: 4\ncode: '2026-01-01'\n---\n[[Authors/Ada]]\n"),
        ("second", "---\nauthor: '[[Authors/Ada]]'\nrating: 2\n---\n"),
    ]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), &settings)
            .unwrap();
    let program = compile_base_source("filters: 'file.inFolder(\"Books\")'\nformulas:\n  code: 'file(\"Books/first\").properties.code'\n  count: 'author.asFile().properties.bookCount'\n  linked: 'link(\"Authors/Ada\").asFile().properties.type'\n  missing: 'file(\"Missing\")'\n  hasAuthor: 'file.hasLink(\"Authors/Ada\")'\nsummaries:\n  AuthorKind: 'file(\"Authors/Ada\").properties.type'\nviews:\n  - type: table\n    name: Books\n    order: [file.name, formula.code, formula.count, formula.linked, formula.missing, formula.hasAuthor]\n    summaries: {file.name: AuthorKind}\n").unwrap();
    let result = query_generation_with_properties(
        &program,
        &generation,
        &[],
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(result.rows.len(), 2);
    for row in &result.rows {
        assert_eq!(
            row.values["formula.code"],
            BaseValue::String {
                value: "2026-01-01".into()
            }
        );
        assert_eq!(
            row.values["formula.count"],
            BaseValue::Number { value: 2.0 }
        );
        assert_eq!(
            row.values["formula.linked"],
            BaseValue::String {
                value: "author".into()
            }
        );
        assert_eq!(row.values["formula.missing"], BaseValue::Null);
    }
    let first = result
        .rows
        .iter()
        .find(|row| row.entry_id == id("first"))
        .unwrap();
    assert_eq!(
        first.values["formula.hasAuthor"],
        BaseValue::Boolean { value: true }
    );
    assert_eq!(
        result.summaries["file.name"],
        BaseValue::String {
            value: "author".into()
        }
    );
}

#[test]
fn relation_target_filters_use_the_same_shared_file_context() {
    let settings = SETTINGS.replace(
        "type == \"author\"",
        "type == file(\"Authors/Ada\").properties.type",
    );
    let generation = generation(&settings, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), &settings)
            .unwrap();
    assert!(definitions.diagnostics().is_empty());
    let values = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(values.relation_targets()["author"].len(), 2);
}

#[test]
fn derived_target_filter_dependencies_report_unavailable_instead_of_false_absence() {
    let settings = SETTINGS.replace("type == \"author\"", "bookCount > 0");
    let generation = generation(
        &settings,
        &[("first", "---\nauthor: '[[Authors/Ada]]'\n---\n")],
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), &settings)
            .unwrap();
    let values = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert!(values.relation_targets()["author"].is_empty());
    assert!(values.diagnostics().iter().any(|diagnostic| diagnostic.code
        == "relation_target_filter"
        && diagnostic
            .message
            .contains("cannot read derived reverse relations or rollups")));
    // Temporary filtering sentinels never escape as ordinary computed cells.
    assert_eq!(
        values.rows()[&id("ada")].values["bookCount"],
        BaseValue::Number { value: 0.0 }
    );
}

#[test]
fn retained_derived_values_cannot_be_reused_under_a_different_evaluation_context() {
    let settings = "properties:\n  published: {type: date}\n";
    let generation = generation(settings, &[("first", "---\npublished: 2026-01-01\n---\n")]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    let options = QueryOptions::default();
    let snapshot = BaseSnapshot::from_generation(&generation, &[])
        .unwrap()
        .with_property_definitions(&definitions, &options)
        .unwrap();
    let program = compile_base_source("views:\n  - type: table\n    name: Notes\n").unwrap();
    assert!(query_base(&program, &snapshot, &options).is_ok());
    let mut changed = options.clone();
    changed.evaluation.timezone = "America/Toronto".into();
    assert_eq!(
        query_base(&program, &snapshot, &changed).unwrap_err().code,
        "stale-source"
    );
    changed = options.clone();
    changed.evaluation.clock_ms = 1;
    assert_eq!(
        query_base(&program, &snapshot, &changed).unwrap_err().code,
        "stale-source"
    );
    changed = options.clone();
    changed.evaluation.random_seed = Some(1);
    assert_eq!(
        query_base(&program, &snapshot, &changed).unwrap_err().code,
        "stale-source"
    );
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

#[test]
fn raw_edit_values_preserve_aliases_and_cached_date_source() {
    let generation = generation(SETTINGS, &[("first", "---\nauthor: '[[../Authors/Ada|A. Lovelace]]'\npublished: 2026-01-01\nplain: text\n---\n")]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let source = "filters: 'published != null'\nviews:\n  - type: table\n    name: Books\n    order: [file.name, author, published, plain]\n";
    let program = compile_base_source(source).unwrap();
    let options = QueryOptions::default();
    let result =
        query_generation_with_properties(&program, &generation, &[], &definitions, &options)
            .unwrap();
    assert_eq!(
        result.rows[0].edit_values["note.author"],
        BaseValue::String {
            value: "[[../Authors/Ada|A. Lovelace]]".into()
        }
    );
    assert_eq!(
        result.rows[0].edit_values["note.published"],
        BaseValue::String {
            value: "2026-01-01".into()
        }
    );
    assert!(!result.rows[0].edit_values.contains_key("note.plain"));
    let mut cache = zorid_bases::BasePreparationCache::default();
    let compiled = cache.compile_source(source, 0).unwrap();
    let prepared = cache
        .prepare_generation(&generation, &[], &options, 0)
        .unwrap();
    cache
        .query_prepared_cached(&compiled, &prepared, &options, 0)
        .unwrap();
    let hit = cache
        .query_prepared_cached(&compiled, &prepared, &options, 1)
        .unwrap();
    assert_eq!(hit.outcome(), zorid_bases::PreparationCacheOutcome::Hit);
    let mut copied = hit.into_value();
    assert_eq!(
        copied.rows[0].edit_values["note.published"],
        BaseValue::String {
            value: "2026-01-01".into()
        }
    );
    copied.rows[0].edit_values.clear();
    let next = cache
        .query_prepared_cached(&compiled, &prepared, &options, 2)
        .unwrap();
    assert!(next.value().rows[0]
        .edit_values
        .contains_key("note.published"));
}

#[test]
fn ordinary_frontmatter_links_resolve_from_the_owning_note_without_definitions() {
    let generation = generation_with_settings_file("", &[
        ("first", "---\nauthor: '[[../Authors/Ada|A. Lovelace]]'\nnested: [{author: '[[../Authors/Grace]]'}]\nwebsite: https://example.com\npublished: 2026-01-01\n---\n"),
        ("second", "---\ntitle: reader\n---\n"),
    ], false);
    let program = compile_base_source(r#"filters: 'file.inFolder("Books")'
formulas:
  own: 'author.asFile().name'
  nested: 'file("Books/first").properties.nested[0].author.asFile().name'
  cross: 'file("Books/first").properties.author.asFile().name'
  external: 'file("Books/first").properties.website.isType("link")'
  absent: 'file("Books/first").properties.author.asFile().properties.missing'
summaries:
  Owners: 'values.map(value.properties.author.asFile().name)'
views:
  - type: table
    name: Books
    order: [file, author, nested, published, formula.own, formula.nested, formula.cross, formula.external, formula.absent]
    summaries: {file: Owners}
"#).unwrap();
    let result =
        zorid_bases::query_generation(&program, &generation, &[], &QueryOptions::default())
            .unwrap();
    assert_eq!(result.rows.len(), 2);
    for row in &result.rows {
        assert_eq!(
            row.values["formula.cross"],
            BaseValue::String {
                value: "Ada".into()
            }
        );
        assert_eq!(
            row.values["formula.nested"],
            BaseValue::String {
                value: "Grace".into()
            }
        );
        assert_eq!(
            row.values["formula.external"],
            BaseValue::Boolean { value: true }
        );
        assert_eq!(row.values["formula.absent"], BaseValue::Null);
    }
    let first = result
        .rows
        .iter()
        .find(|row| row.entry_id == id("first"))
        .unwrap();
    assert!(
        matches!(&first.values["note.author"], BaseValue::Link {target:Some(target), ..} if target.entry_id == id("ada"))
    );
    assert_eq!(
        first.edit_values["note.author"],
        BaseValue::String {
            value: "[[../Authors/Ada|A. Lovelace]]".into()
        }
    );
    assert!(matches!(
        &first.values["note.published"],
        BaseValue::Date { .. }
    ));
    assert!(
        matches!(&first.edit_values["note.nested"], BaseValue::List {value} if matches!(&value[0], BaseValue::Object {value} if matches!(&value["author"], BaseValue::String {value} if value == "[[../Authors/Grace]]")))
    );
    assert!(
        matches!(&result.summaries["file"], BaseValue::List {value} if value.contains(&BaseValue::String {value:"Ada".into()}))
    );
    let summary_only = compile_base_source("filters: 'file.inFolder(\"Books\")'\nsummaries:\n  Owners: 'values.map(value.properties.author)'\nviews:\n  - type: table\n    name: Books\n    order: [file]\n    summaries: {file: Owners}\n").unwrap();
    let summarized =
        zorid_bases::query_generation(&summary_only, &generation, &[], &QueryOptions::default())
            .unwrap();
    assert!(
        matches!(&summarized.summaries["file"], BaseValue::List {value} if value.iter().any(|value| matches!(value, BaseValue::Link {target:Some(target), ..} if target.entry_id == id("ada"))))
    );
}

#[test]
fn target_filter_this_is_diagnosed_instead_of_silent_empty_membership() {
    let source = "properties:\n  author:\n    type: relation\n    relation:\n      targetFilter: 'type == this.type'\n";
    let generation = generation(source, &[]);
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), source).unwrap();
    assert!(definitions.get("author").is_none());
    assert!(definitions
        .diagnostics()
        .iter()
        .any(|diagnostic| diagnostic.message.contains("vault-wide")
            && diagnostic.message.contains("this")));
}
