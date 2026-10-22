//! Explicit fragments must survive canonical resolution without turning literal
//! hash characters in captured filenames into headings.
use zorid_bases::{
    compile_base_source, query_generation_with_properties, BaseValue, PropertyDefinitions,
    QueryOptions,
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

#[test]
fn resolved_relations_and_edges_keep_explicit_subpaths_while_identity_links_do_not() {
    let settings = "properties:\n  author:\n    type: relation\n    relation: {targetFilter: 'type == \"author\"'}\n  books:\n    type: reverseRelation\n    reverseRelation: {property: author}\n";
    let records = [
        ("settings", "Properties.yaml", settings, false),
        ("author", "People/A#B.md", "---\ntype: author\n---\n# Biography\nText ^block-id\n", true),
        ("book", "Books/Book#One.md", "---\ntype: book\nauthor: '[[../People/A%23B.md#^block-id|Boss]]'\n---\n[Heading](../People/A%23B.md#Biography&amp;Life) [[../People/A%23B.md#^block-id|Jump]]\n", true),
    ];
    let store = OperationId::new("fragment-store").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        store,
        OperationId::new("fragment-epoch").unwrap(),
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
    let entries = records
        .iter()
        .map(|(name, path, _, _)| EntryState {
            id: id(name),
            path: VaultPath::new(*path).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
            deleted: false,
        })
        .collect();
    let sources = records
        .into_iter()
        .map(|(name, _, text, markdown)| GenerationSource::Text {
            request: MetadataRequest {
                entry_id: id(name),
                content_revision: Revision::new("r1").unwrap(),
                source: text.into(),
            },
            markdown,
        })
        .collect();
    let generation = Generation::from_sources(source, snapshot, entries, sources).unwrap();
    let definitions =
        PropertyDefinitions::from_generation_source(&generation, &id("settings"), settings)
            .unwrap();
    let program = compile_base_source("filters: file.ext == \"md\"\nformulas:\n  identity: file.asLink()\n  direct: link('../People/A%23B.md#Biography')\nviews:\n  - type: table\n    name: Fragments\n    order: [file.path, note.author, note.books, file.links, file.backlinks, formula.identity, formula.direct]\n").unwrap();
    let result = query_generation_with_properties(
        &program,
        &generation,
        &[],
        &definitions,
        &QueryOptions::default(),
    )
    .unwrap();
    assert!(
        result.diagnostics.is_empty(),
        "Fragment fixture query diagnostics: {:?}",
        result.diagnostics
    );
    assert_eq!(
        result.rows.len(),
        2,
        "Expected the two Markdown identity rows, got paths {:?}; counts: {:?}",
        result.rows.iter().map(|row| &row.path).collect::<Vec<_>>(),
        result.counts
    );
    let book = result
        .rows
        .iter()
        .find(|row| row.entry_id == id("book"))
        .expect("Fragment fixture must return the captured Book#One.md source record");
    let author = result
        .rows
        .iter()
        .find(|row| row.entry_id == id("author"))
        .expect("Fragment fixture must return the captured A#B.md target record");
    assert!(
        matches!(&book.values["note.author"], BaseValue::Link {path, target: Some(target), subpath: Some(subpath), display: Some(display), ..} if path == "People/A#B.md" && target.entry_id == id("author") && subpath == "#^block-id" && display == "Boss")
    );
    assert!(
        matches!(&book.edit_values["note.author"], BaseValue::String {value} if value == "[[../People/A%23B.md#^block-id|Boss]]")
    );
    for row in [book, author] {
        assert!(
            matches!(&row.values["formula.identity"], BaseValue::Link {path, target: Some(target), subpath: None, ..} if path == &row.path && target.entry_id == row.entry_id)
        );
        assert!(
            matches!(&row.values["formula.direct"], BaseValue::Link {target: Some(target), subpath: Some(subpath), ..} if target.entry_id == id("author") && subpath == "#Biography")
        );
    }
    let BaseValue::List { value: links } = &book.values["file.links"] else {
        panic!("expected outgoing links")
    };
    assert!(links.iter().any(|link| matches!(link, BaseValue::Link {target: Some(target), subpath: Some(subpath), ..} if target.entry_id == id("author") && subpath == "#Biography&Life")), "Markdown entities are decoded by the existing document parser before semantic fragment capture");
    assert!(links.iter().any(|link| matches!(link, BaseValue::Link {subpath: Some(subpath), ..} if subpath == "#^block-id")));
    for property in ["note.books", "file.backlinks"] {
        let BaseValue::List { value: links } = &author.values[property] else {
            panic!("expected incoming identity links")
        };
        assert_eq!(links.len(), 1);
        assert!(
            matches!(&links[0], BaseValue::Link {path, target: Some(target), subpath: None, ..} if path == "Books/Book#One.md" && target.entry_id == id("book"))
        );
    }
}
