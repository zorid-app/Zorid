//! Constructor-strict link identity is original destination + owning source
//! context + strict display, even when all links resolve to the same file.
use zorid_bases::{
    compile_base_source, query_base, query_generation, query_generation_with_properties,
    relations::query_property_relations, BaseSnapshot, BaseValue, OperationCancellation,
    PropertyDefinitions, QueryOptions,
};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::{
    document_extraction_version, Generation, GenerationSource, IndexSnapshotId, MetadataRequest,
    SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, RESOLVER_VERSION,
};
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
const SETTINGS:&str="properties:\n  ref: {type: relation}\n  members: {type: relation, relation: {multiple: true}}\n  references: {type: rollup, rollup: {relation: members, property: ref, aggregation: values}}\n  distinctReferences: {type: rollup, rollup: {relation: members, property: ref, aggregation: unique}}\n";
fn captured(settings: Option<&str>) -> Generation {
    let store = OperationId::new("link-origin-store").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        store,
        OperationId::new("link-origin-epoch").unwrap(),
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
    let mut inputs=vec![
        ("a","One/A.md","---\nkind: book\nref: '[[../Targets/X|Label]]'\nalternative: '[[/Targets/X.md|Label]]'\nplain: '[[../Targets/X|Label]]'\nurl: https://example.test/x\n---\n[[../Targets/X]] [[../Targets/X]]\n",true),
        ("b","Two/B.md","---\nkind: book\nref: '[[../Targets/X|Label]]'\nplain: '[[../Targets/X|Label]]'\nurl: https://example.test/x\n---\n[[../Targets/X]]\n",true),
        ("target","Targets/X.md","# X\n",true),
        ("body-a","One/Body.md","[[../Targets/X]] [[../Targets/X]]\n",true),
        ("body-b","Two/Body.md","[[../Targets/X]]\n",true),
        ("hub","Hub.md","---\nmembers: ['[[One/A]]', '[[Two/B]]']\n---\n# Hub\n",true),
    ];
    if let Some(settings) = settings {
        inputs.push(("settings", "Properties.yaml", settings, false));
    }
    let entries = inputs
        .iter()
        .map(|(name, path, _, _)| EntryState {
            id: id(name),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
            deleted: false,
        })
        .collect();
    let sources = inputs
        .into_iter()
        .map(|(name, _, source, markdown)| GenerationSource::Text {
            request: MetadataRequest {
                entry_id: id(name),
                content_revision: Revision::new("r1").unwrap(),
                source: source.into(),
            },
            markdown,
        })
        .collect();
    Generation::from_sources(source, snapshot, entries, sources).unwrap()
}
fn number(value: &BaseValue) -> f64 {
    match value {
        BaseValue::Number { value } => *value,
        other => panic!("Expected numeric identity oracle, got {other:?}"),
    }
}
fn assert_number(result: &zorid_bases::BaseQueryResult, property: &str, expected: f64) {
    assert_eq!(result.rows.len(), 1);
    assert_eq!(
        number(&result.rows[0].values[property]),
        expected,
        "{property}"
    );
}

#[test]
fn ordinary_frontmatter_and_body_links_preserve_their_actual_owner_across_file_access() {
    let generation = captured(None);
    let program=compile_base_source(r#"filters: 'file.path == "One/A.md"'
formulas:
  sameSource: '[note.ref, file("One/A.md").properties.ref].unique().length'
  differentSource: '[note.ref, file("Two/B.md").properties.ref].unique().length'
  differentSpelling: '[note.ref, note.alternative].unique().length'
  urlNotOwned: '[note.url, file("Two/B.md").properties.url].unique().length'
  bodySameSource: '[file("One/Body.md").links[0], file("One/Body.md").links[1]].unique().length'
  bodyDifferentSource: '[file("One/Body.md").links[0], file("Two/Body.md").links[0]].unique().length'
views: [{type: table, name: Origins, order: [file.name, formula.sameSource, formula.differentSource, formula.differentSpelling, formula.urlNotOwned, formula.bodySameSource, formula.bodyDifferentSource]}]
"#).unwrap();
    let result = query_generation(&program, &generation, &[], &QueryOptions::default()).unwrap();
    for (property, expected) in [
        ("formula.sameSource", 1.0),
        ("formula.differentSource", 2.0),
        ("formula.differentSpelling", 2.0),
        ("formula.urlNotOwned", 1.0),
        ("formula.bodySameSource", 1.0),
        ("formula.bodyDifferentSource", 2.0),
    ] {
        assert_number(&result, property, expected);
    }
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn configured_relation_projection_and_summaries_preserve_precanonical_source_identity() {
    let generation = captured(Some(SETTINGS));
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let program=compile_base_source(r#"filters: 'note.kind == "book"'
summaries: {StrictOrigins: 'values.unique().length'}
formulas:
  sameSource: '[note.ref, file(file.path).properties.ref].unique().length'
views: [{type: table, name: Configured, order: [file.name, ref, plain, formula.sameSource], summaries: {ref: StrictOrigins, plain: StrictOrigins}}]
"#).unwrap();
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
        assert_eq!(number(&row.values["formula.sameSource"]), 1.0);
        assert!(
            matches!(&row.values["note.ref"],BaseValue::Link{path,target:Some(target),..}if path=="Targets/X.md"&&target.entry_id==id("target"))
        );
    }
    assert_eq!(number(&result.summaries["note.ref"]), 2.0);
    assert_eq!(number(&result.summaries["note.plain"]), 2.0);
    let sealed = query_property_relations(
        &BaseSnapshot::from_generation(&generation, &[]).unwrap(),
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    let wire = serde_json::to_value(&sealed).unwrap();
    assert!(wire.get("runtimeShapes").is_none());
    let wire = serde_json::to_string(&result).unwrap();
    assert!(!wire.contains("raw_destination"));
    assert!(!wire.contains("source_path"));
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn rollup_values_keep_each_selected_target_origin_and_unique_keeps_its_first_origin() {
    let generation = captured(Some(SETTINGS));
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let program=compile_base_source(r#"filters: 'file.path == "Hub.md"'
formulas:
  valuesOrigins: 'note.references.unique().length'
  extensionDistinct: 'note.distinctReferences.length'
  selectedFirst: '[note.distinctReferences[0], file("One/A.md").properties.ref].unique().length'
  notCurrentOrigin: '[note.distinctReferences[0], file("Two/B.md").properties.ref].unique().length'
views: [{type: table, name: Rollups, order: [file.name, formula.valuesOrigins, formula.extensionDistinct, formula.selectedFirst, formula.notCurrentOrigin]}]
"#).unwrap();
    let result = query_generation_with_properties(
        &program,
        &generation,
        &[],
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    for (property, expected) in [
        ("formula.valuesOrigins", 2.0),
        ("formula.extensionDistinct", 1.0),
        ("formula.selectedFirst", 1.0),
        ("formula.notCurrentOrigin", 2.0),
    ] {
        assert_number(&result, property, expected);
    }
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn retained_derived_provenance_does_not_bypass_work_or_cancellation_limits() {
    let generation = captured(Some(SETTINGS));
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), SETTINGS)
            .unwrap();
    let snapshot = BaseSnapshot::from_generation(&generation, &[])
        .unwrap()
        .with_property_definitions(&definitions, &QueryOptions::default())
        .unwrap();
    let program=compile_base_source("formulas: {origins: '[note.ref, note.ref].unique().length'}\nviews: [{type: table, name: Guarded, order: [formula.origins]}]\n").unwrap();
    let mut options = QueryOptions::default();
    options.max_steps = 1;
    assert_eq!(
        query_base(&program, &snapshot, &options).unwrap_err().code,
        "budget"
    );
    let cancellation = OperationCancellation::default();
    cancellation.cancel();
    let mut options = QueryOptions::default();
    options.evaluation.cancellation = Some(cancellation);
    assert_eq!(
        query_base(&program, &snapshot, &options).unwrap_err().code,
        "cancelled"
    );
}
