use super::*;
use crate::expression::RuntimeValue;

#[test]
fn temporary_derived_filter_placeholders_keep_the_original_thrown_diagnostic() {
    let message = "Target filters cannot read derived reverse relations or rollups before relationship graph construction";
    let placeholder = error("unavailable", message);
    let value = attachment_value(&placeholder, &BasesTimezone::Utc, true).unwrap();
    assert!(
        matches!(value, RuntimeValue::Error(encoded) if encoded == format!("unavailable\0{message}"))
    );
}

#[test]
fn published_error_values_are_data_even_when_their_code_is_unavailable() {
    for code in ["unavailable", "type", "numeric-domain"] {
        let data = error(code, "An ordinary returned error value");
        let value = attachment_value(&data, &BasesTimezone::Utc, false).unwrap();
        assert!(
            matches!(value, RuntimeValue::ErrorValue(encoded) if encoded == format!("{code}\0An ordinary returned error value"))
        );
    }
}

#[test]
fn published_values_clear_the_candidate_phase_and_replace_all_temporary_sentinels() {
    use zorid_core::{EntryKind, EntryState, OperationId, Revision, VaultPath};
    use zorid_index::{
        document_extraction_version, Generation, GenerationSource, IndexSnapshotId,
        MetadataRequest, SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
        LITERAL_QUERY_VERSION, RESOLVER_VERSION,
    };
    let settings = "properties:\n  ref: {type: relation, relation: {targetFilter: 'count > 0'}}\n  incoming: {type: reverseRelation, reverseRelation: {property: ref}}\n  count: {type: rollup, rollup: {relation: incoming, aggregation: count}}\n";
    let store = OperationId::new("filter-sentinel-test").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot_id = IndexSnapshotId::new(
        store,
        OperationId::new("epoch").unwrap(),
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
    let revision = Revision::new("r1").unwrap();
    let fixtures = [
        ("settings", "Properties.yaml", settings, false),
        ("note", "Note.md", "# Note\n", true),
    ];
    let entries = fixtures
        .iter()
        .map(|(id, path, _, _)| EntryState {
            id: EntryId::new(*id).unwrap(),
            path: VaultPath::new(*path).unwrap(),
            kind: EntryKind::File,
            revision: revision.clone(),
            deleted: false,
        })
        .collect();
    let sources = fixtures
        .iter()
        .map(|(id, _, text, markdown)| GenerationSource::Text {
            request: MetadataRequest {
                entry_id: EntryId::new(*id).unwrap(),
                content_revision: revision.clone(),
                source: (*text).into(),
            },
            markdown: *markdown,
        })
        .collect();
    let generation = Generation::from_sources(source, snapshot_id, entries, sources).unwrap();
    let definitions = PropertyDefinitions::from_generation_source(
        &generation,
        &EntryId::new("settings").unwrap(),
        settings,
    )
    .unwrap();
    let snapshot = BaseSnapshot::from_generation(&generation, &[]).unwrap();
    let values =
        query_property_relations(&snapshot, &definitions, &QueryOptions::default()).unwrap();
    assert!(values.relation_targets()["ref"].is_empty());
    assert!(values
        .diagnostics()
        .iter()
        .any(|error| error.code == "relation_target_filter"
            && error
                .message
                .contains("cannot read derived reverse relations or rollups")));
    assert!(!values.target_filter_phase);
    assert!(serde_json::to_value(&values)
        .unwrap()
        .get("targetFilterPhase")
        .is_none());
    let record = snapshot
        .records
        .iter()
        .find(|record| record.path == "Note.md")
        .unwrap();
    assert_eq!(
        values.rows()[&EntryId::new("note").unwrap()].values["count"],
        BaseValue::Number { value: 0.0 }
    );
    // Retained published overlays attach their completed values, never the
    // construction-phase placeholder or a thrown unavailable diagnostic.
    let mut file = crate::runtime_file(record, &BasesTimezone::Utc).unwrap();
    values
        .attach(&mut file, &BasesTimezone::Utc, &mut |_| Ok(()))
        .unwrap();
    assert!(matches!(file.properties["count"], RuntimeValue::Number(value) if value == 0.0));
}

#[test]
fn guard_errors_keep_their_existing_fatal_import_contract() {
    for code in ["budget", "cancelled"] {
        let failure = attachment_value(
            &error(code, "Original guard diagnostic"),
            &BasesTimezone::Utc,
            false,
        )
        .unwrap_err();
        assert_eq!(failure.code, code);
        assert_eq!(failure.message, "Original guard diagnostic");
    }
}
