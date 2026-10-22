//! Captured frontmatter tags retain their native contains behavior through
//! Properties.yaml overlays and the same immutable cross-file query context.
use zorid_bases::{
    compile_base_source, query_generation, query_generation_with_properties, BaseValue,
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
fn captured(settings: Option<&str>, note: &str) -> Generation {
    let store = OperationId::new("frontmatter-tag-store").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        store,
        OperationId::new("frontmatter-tag-epoch").unwrap(),
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
    let mut inputs = vec![("tagged", "Tagged.md", note, true)];
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
fn boolean(value: &BaseValue) -> bool {
    match value {
        BaseValue::Boolean { value } => *value,
        other => panic!("Expected boolean oracle, received {other:?}"),
    }
}

#[test]
fn configured_tags_overlay_preserves_captured_tag_subclass_without_promoting_other_lists() {
    let settings = "properties:\n  tags: {type: tags}\n  otherTags: {type: tags}\n";
    let generation = captured(
        Some(settings),
        "---\ntags: ['#root/child']\notherTags: ['root/child']\n---\n# Tagged\n",
    );
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    let program=compile_base_source(r#"filters: 'file.name == "Tagged"'
formulas:
  actualParent: 'note.tags.contains("root")'
  actualExact: 'note.tags.contains("root/child")'
  notPrefix: 'note.tags.contains("roo")'
  ordinaryList: 'note.otherTags.contains("root")'
  tags: '["root/child"]'
  formulaList: 'formula.tags.contains("root")'
  capturedOtherFile: 'file("Tagged.md").properties.tags.contains("root")'
views:
  - type: table
    name: Tags
    order: [file.name, formula.actualParent, formula.actualExact, formula.notPrefix, formula.ordinaryList, formula.formulaList, formula.capturedOtherFile]
"#).unwrap();
    let result = query_generation_with_properties(
        &program,
        &generation,
        &[],
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(result.rows.len(), 1);
    let values = &result.rows[0].values;
    for property in [
        "formula.actualParent",
        "formula.actualExact",
        "formula.capturedOtherFile",
    ] {
        assert!(
            boolean(&values[property]),
            "{property} preserves the captured native tags subtype"
        );
    }
    for property in [
        "formula.notPrefix",
        "formula.ordinaryList",
        "formula.formulaList",
    ] {
        assert!(
            !boolean(&values[property]),
            "{property} must retain ordinary exact list semantics"
        );
    }
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn incompatible_scalar_tags_definition_keeps_raw_value_and_diagnostic() {
    let settings = "properties:\n  tags: {type: tags}\n";
    let generation = captured(Some(settings), "---\ntags: root/child\n---\n# Tagged\n");
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    let program = compile_base_source(
        "filters: 'file.name == \"Tagged\"'\nviews: [{type: table, name: Scalar, order: [tags]}]\n",
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
    assert_eq!(result.rows.len(), 1);
    assert_eq!(
        result.rows[0].values["note.tags"],
        BaseValue::String {
            value: "root/child".into()
        }
    );
    assert!(result
        .diagnostics
        .iter()
        .any(|issue| issue.entry_id == id("tagged")
            && issue.phase == "property"
            && issue.code == "incompatible_property_value"));
}

#[test]
fn ordinary_captured_scalar_tags_without_a_registry_keep_parent_tag_semantics() {
    let generation = captured(None, "---\ntags: root/child\n---\n# Tagged\n");
    let program = compile_base_source(
        r#"formulas:
  parent: 'note.tags.contains("root")'
  unrelated: '["root/child"].contains("root")'
views: [{type: table, name: Ordinary, order: [tags, formula.parent, formula.unrelated]}]
"#,
    )
    .unwrap();
    let result = query_generation(&program, &generation, &[], &QueryOptions::default()).unwrap();
    assert_eq!(result.rows.len(), 1);
    assert!(boolean(&result.rows[0].values["formula.parent"]));
    assert!(!boolean(&result.rows[0].values["formula.unrelated"]));
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}
