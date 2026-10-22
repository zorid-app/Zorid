//! Rich values stay typed through real generation queries and text presentation.
use zorid_bases::{compile_base_source, query_generation, BaseValue, QueryOptions};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::{
    document_extraction_version, Generation, GenerationSource, IndexSnapshotId, MetadataRequest,
    SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, RESOLVER_VERSION,
};
fn generation() -> Generation {
    let store = OperationId::new("rich-query-store").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        store,
        OperationId::new("rich-query-epoch").unwrap(),
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
    let inputs = [
        ("a", "A.md", "---\nlabel: B10\nglyph: star\n---\n"),
        ("b", "B.md", "---\nlabel: B2\nglyph: heart\n---\n"),
        ("target", "Target.md", "Target body\n"),
    ];
    let entries = inputs
        .iter()
        .map(|(id, path, _)| EntryState {
            id: EntryId::new(*id).unwrap(),
            path: VaultPath::new(*path).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
            deleted: false,
        })
        .collect();
    let sources = inputs
        .iter()
        .map(|(id, _, text)| GenerationSource::Text {
            request: MetadataRequest {
                entry_id: EntryId::new(*id).unwrap(),
                content_revision: Revision::new("r1").unwrap(),
                source: (*text).into(),
            },
            markdown: true,
        })
        .collect();
    Generation::from_sources(source, snapshot, entries, sources).unwrap()
}
const SOURCE:&str="filters: file.path != 'Target.md'\nformulas:\n  richHtml: html(label)\n  richImage: image('cover.png')\n  richIcon: icon(glyph)\n  richLink: link('Target', icon(glyph))\nviews:\n  - type: table\n    name: T\n    order: [formula.richHtml, formula.richImage, formula.richIcon, formula.richLink]\n    sort:\n      - property: formula.richHtml\n        direction: ASC\n";
#[test]
fn generation_results_preserve_rich_transport_and_sort_string_subclasses() {
    let result = query_generation(
        &compile_base_source(SOURCE).unwrap(),
        &generation(),
        &[],
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(
        result
            .rows
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>(),
        vec!["B.md", "A.md"]
    );
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(
        result.rows[0].values["formula.richHtml"],
        BaseValue::Html { value: "B2".into() }
    );
    assert_eq!(
        result.rows[0].values["formula.richImage"],
        BaseValue::Image {
            value: "cover.png".into()
        }
    );
    assert_eq!(
        result.rows[0].values["formula.richIcon"],
        BaseValue::Icon {
            value: "heart".into()
        }
    );
    assert!(
        matches!(&result.rows[0].values["formula.richLink"],BaseValue::Link{target:Some(target),display_value:Some(value),..}
        if target.entry_id.as_str()=="target" && **value==BaseValue::Icon{value:"heart".into()})
    );
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(
        wire["rows"][0]["values"]["formula.richLink"]["displayValue"]["type"],
        "icon"
    );
}
#[test]
fn visible_rich_values_participate_in_search_and_relation_grouping_keeps_identity() {
    let generation = generation();
    let mut options = QueryOptions::default();
    options.search_terms = vec!["B2".into()];
    let result = query_generation(
        &compile_base_source(SOURCE).unwrap(),
        &generation,
        &[],
        &options,
    )
    .unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].path, "B.md");
    let source =
        format!("{SOURCE}    groupBy:\n      property: formula.richLink\n      direction: ASC\n");
    let result = query_generation(
        &compile_base_source(&source).unwrap(),
        &generation,
        &[],
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(
        result.groups.len(),
        1,
        "rich display aliases must not split target identity"
    );
    assert_eq!(result.groups[0].entry_ids.len(), 2);
}
#[test]
fn rich_payloads_count_toward_existing_query_output_budget() {
    let source="filters: file.path == 'A.md'\nformulas:\n  rich: html('x'.repeat(4096))\nviews:\n  - type: table\n    name: T\n    order: [formula.rich]\n";
    let mut options = QueryOptions::default();
    options.max_output_bytes = 2048;
    assert_eq!(
        query_generation(
            &compile_base_source(source).unwrap(),
            &generation(),
            &[],
            &options
        )
        .unwrap_err()
        .code,
        "budget"
    );
}
