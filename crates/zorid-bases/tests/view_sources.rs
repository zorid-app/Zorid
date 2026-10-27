//! Local view selection never derives owning membership from frontmatter labels.
use std::collections::BTreeMap;
use zorid_bases::{compile_base_source, query_generation, query_generation_scoped, BaseSourceScope,
    BaseValue, BaseViewSource, PropertyDefinitions, PropertyType, PropertyValue, QueryOptions};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::{document_extraction_version, Generation, GenerationSource, IndexSnapshotId,
    MetadataRequest, SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, RESOLVER_VERSION};
const A: &str = "aaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbb";
const FIELD: &str = "ffffffffffff";
fn id(value: &str) -> EntryId { EntryId::new(value).unwrap() }
fn generation(inputs: &[(&str, &str, &str)]) -> Generation {
    let store = OperationId::new("source-test").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(store, OperationId::new("source-epoch").unwrap(), 1,
        SemanticVersions::new(INDEX_SCHEMA_VERSION, document_extraction_version(), RESOLVER_VERSION, LITERAL_QUERY_VERSION).unwrap()).unwrap();
    let entries = inputs.iter().map(|(name, path, _)| EntryState { id: id(name), path: VaultPath::new(*path).unwrap(), kind: EntryKind::File, revision: Revision::new("r1").unwrap(), deleted: false }).collect();
    let sources = inputs.iter().map(|(name, path, source)| GenerationSource::Text { request: MetadataRequest { entry_id: id(name), content_revision: Revision::new("r1").unwrap(), source: (*source).into() }, markdown: path.ends_with(".md") }).collect();
    Generation::from_sources(source, snapshot, entries, sources).unwrap()
}
fn memberships() -> BTreeMap<EntryId, String> { BTreeMap::from([(id("a"), A.into()), (id("b"), B.into())]) }
fn scope(source: BaseViewSource) -> BaseSourceScope {
    let values = match source {
        BaseViewSource::Untyped => BTreeMap::new(),
        _ => BTreeMap::from([(id("a"), vec![(FIELD.into(), PropertyValue::Number(3.into()))])]),
    };
    let types = if matches!(source, BaseViewSource::Untyped) { vec![] } else { vec![(FIELD.into(), PropertyType::Number)] };
    BaseSourceScope::captured(source, "1".into(), &memberships(), values, types).unwrap()
}
#[test]
fn legacy_registry_is_ordinary_data_and_does_not_block_or_define_note_values() {
    let generation = generation(&[("settings", "Properties.yaml", "properties: [malformed registry]\n"), ("n", "Note.md", "---\nscore: 7\n---\nBody"), ("asset", "image.png", "plain asset")]);
    assert!(PropertyDefinitions::absent(&generation).unwrap().iter().next().is_none());
    let program = compile_base_source("filters: score == 7\nviews: [{type: table, name: Notes, order: [score]}]\n").unwrap();
    let result = query_generation(&program, &generation, &[], &QueryOptions::default()).unwrap();
    assert_eq!(result.rows.len(), 1); assert_eq!(result.rows[0].entry_id, id("n"));
    assert_eq!(result.properties, ["file.name"]); assert!(result.available_properties.iter().all(|key| key.starts_with("file.")));
    assert!(result.rows[0].values.keys().all(|key| key.starts_with("file."))); assert!(result.rows[0].edit_values.is_empty());
}
#[test]
fn untyped_scope_excludes_owned_entries_and_ignores_forged_type_names() {
    let generation = generation(&[("a", "A.md", "---\n_type: Books\n---\n"), ("b", "B.md", "---\n_type: Books\n---\n"), ("n", "Ordinary.md", "---\n_type: Books\nscore: 7\n---\n")]);
    let program = compile_base_source("views: [{type: list, name: Notes, source: {kind: untyped}, filters: score == 7}]\n").unwrap();
    let result = query_generation_scoped(&program, &generation, &[], scope(BaseViewSource::Untyped), &QueryOptions::default()).unwrap();
    assert_eq!(result.rows.iter().map(|row| row.entry_id.clone()).collect::<Vec<_>>(), [id("n")]);
}
#[test]
fn collection_uses_captured_values_and_stable_ids_instead_of_frontmatter_names() {
    let generation = generation(&[("a", "A.md", "---\n_type: Old name\nffffffffffff: 99\n---\n"), ("b", "B.md", "---\n_type: Same label\nffffffffffff: 3\n---\n"), ("n", "Fake.md", "---\n_type: Same label\nffffffffffff: 3\n---\n")]);
    let program = compile_base_source(&format!("filters: 'false'\nformulas: {{leak: '99'}}\nviews:\n  - type: table\n    name: Books\n    source: {{kind: collection, id: {A}}}\n    filters: note.{FIELD} == 3\n    order: [file.name, note.{FIELD}]\n")).unwrap();
    let result = query_generation_scoped(&program, &generation, &[], scope(BaseViewSource::Collection { id: A.into() }), &QueryOptions::default()).unwrap();
    assert_eq!(result.rows.len(), 1); assert_eq!(result.rows[0].entry_id, id("a"));
    assert_eq!(result.rows[0].values[&format!("note.{FIELD}")], BaseValue::Number { value: 3.0 });
    assert!(!result.available_properties.iter().any(|key| key == "formula.leak"));
}
#[test]
fn each_view_owns_its_source_and_expressions() {
    let generation = generation(&[("a", "A.md", "---\nscore: 0\n---\n"), ("b", "B.md", "---\nscore: 0\n---\n"), ("n", "N.md", "---\nscore: 8\n---\n")]);
    let program = compile_base_source(&format!("filters: 'false'\nformulas: {{wrong: 'false'}}\nviews:\n  - type: table\n    name: Books\n    source: {{kind: collection, id: {A}}}\n    formulas: {{double: 'note.{FIELD} * 2'}}\n    filters: formula.double == 6\n    order: [file.name, formula.double]\n  - type: list\n    name: Notes\n    source: {{kind: untyped}}\n    filters: score == 8\n")).unwrap();
    let result = query_generation_scoped(&program, &generation, &[], scope(BaseViewSource::Collection { id: A.into() }), &QueryOptions::default()).unwrap();
    assert_eq!(result.rows[0].values["formula.double"], BaseValue::Number { value: 6.0 });
    let result = query_generation_scoped(&program, &generation, &[], scope(BaseViewSource::Untyped), &QueryOptions { view_index: 1, ..QueryOptions::default() }).unwrap();
    assert_eq!(result.rows.len(), 1); assert_eq!(result.rows[0].entry_id, id("n"));
}
#[test]
fn missing_or_mismatched_authority_fails_closed_and_client_json_cannot_grant_membership() {
    let generation = generation(&[("a", "A.md", "body")]);
    let program = compile_base_source(&format!("views: [{{type: table, name: Books, source: {{kind: collection, id: {A}}}}}]\n")).unwrap();
    assert_eq!(query_generation(&program, &generation, &[], &QueryOptions::default()).unwrap_err().code, "source-unavailable");
    assert_eq!(query_generation_scoped(&program, &generation, &[], scope(BaseViewSource::Untyped), &QueryOptions::default()).unwrap_err().code, "source-mismatch");
    assert!(serde_json::from_str::<QueryOptions>(r#"{"sourceScope":{"source":{"kind":"collection","id":"aaaaaaaaaaaa"},"members":["a"]}}"#).is_err());
}
#[test]
fn malformed_or_multi_source_configuration_is_rejected() {
    for source in ["[]", "{kind: all}", "{kind: collection, id: short}", "{kind: collection, id: AAAAAAAAAAAA}", "{kind: untyped, id: aaaaaaaaaaaa}", "{kind: collection, id: aaaaaaaaaaaa, extra: true}"] {
        assert!(compile_base_source(&format!("views: [{{type: table, name: Bad, source: {source}}}]\n")).is_err(), "{source}");
    }
}
