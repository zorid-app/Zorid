//! First-build preview expectations are fixed prepared-subset facts, never an
//! ordinary published snapshot manufactured to satisfy the shared evaluator.
use zorid_bases::{
    compile_base_source, query_generation, query_preview, BaseValue, FilePresentationFacts,
    OperationCancellation, QueryOptions, RecordWitness, MAX_PREVIEW_QUERY_OWNED_BYTES,
};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::{
    document_extraction_version, Exclusion, GenerationBuilder, IndexRecord, IndexSnapshotId,
    Manifest, MetadataRequest, PreviewCaptureOwner, PreviewSnapshot, PublicationFence,
    SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, MAX_SEARCH_OWNED_BYTES, RESOLVER_VERSION,
};
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn entry(name: &str, path: &str) -> EntryState {
    EntryState {
        id: id(name),
        path: VaultPath::new(path).unwrap(),
        kind: EntryKind::File,
        revision: Revision::new("r1").unwrap(),
        deleted: false,
    }
}
fn builder(entries: Vec<EntryState>) -> GenerationBuilder {
    let source = SourceSnapshotId::new(op("preview-store"), SourceWatermark::new("1").unwrap());
    let versions = SemanticVersions::new(
        INDEX_SCHEMA_VERSION,
        document_extraction_version(),
        RESOLVER_VERSION,
        LITERAL_QUERY_VERSION,
    )
    .unwrap();
    let index =
        IndexSnapshotId::new(op("preview-store"), op("preview-epoch"), 1, versions).unwrap();
    GenerationBuilder::new(
        Manifest::new(source.clone(), entries).unwrap(),
        PublicationFence::new(source, None, index).unwrap(),
    )
    .unwrap()
}
fn source(builder: &mut GenerationBuilder, name: &str, text: &str, markdown: bool) {
    builder.begin_pump();
    let witness = builder.manifest().witness(&id(name)).unwrap();
    let request = MetadataRequest {
        entry_id: id(name),
        content_revision: Revision::new("r1").unwrap(),
        source: text.into(),
    };
    builder
        .add(IndexRecord::text(witness, &request, markdown).unwrap())
        .unwrap();
}
fn excluded(builder: &mut GenerationBuilder, name: &str, reason: Exclusion) {
    builder.begin_pump();
    let witness = builder.manifest().witness(&id(name)).unwrap();
    builder.add(IndexRecord::excluded(witness, reason)).unwrap();
}
fn capture_rows(builder: &GenerationBuilder, names: &[&str]) -> PreviewSnapshot {
    PreviewCaptureOwner::new(op("preview-owner"), op("preview-stage"), builder)
        .capture_checked(
            builder,
            &names.iter().map(|name| id(name)).collect::<Vec<_>>(),
            MAX_SEARCH_OWNED_BYTES,
            |_| Ok::<_, ()>(()),
        )
        .unwrap()
}
fn base() -> &'static str {
    "filters: file.ext == \"md\"\nviews:\n  - type: table\n    name: Table\n    order: [file.path, note.score]\n    sort:\n      - property: note.score\n        direction: DESC\n"
}
fn fixture() -> GenerationBuilder {
    let mut builder = builder(vec![
        entry("definition", "View.base"),
        entry("a", "A.md"),
        entry("b", "B.md"),
    ]);
    source(&mut builder, "definition", base(), false);
    source(&mut builder, "a", "---\nscore: 1\n---\n[[B]]\n", true);
    builder
}
#[test]
fn coherent_capture_growth_keeps_old_rows_and_explicit_partial_aggregates() {
    let mut builder = fixture();
    let old = capture_rows(&builder, &["definition", "a"]);
    let program = compile_base_source(base()).unwrap();
    let first = query_preview(
        &program,
        &old,
        &id("definition"),
        &[],
        &QueryOptions::default(),
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(first.capture, *old.id());
    assert_eq!(first.value.progress.prepared_files, 2);
    assert_eq!(first.value.progress.pending_files, 1);
    assert_eq!(first.value.counts.scanned, 2);
    assert_eq!(
        first
            .value
            .rows
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>(),
        ["A.md"]
    );
    assert!(
        !first.value.complete
            && !first.value.aggregates_complete
            && !first.value.metadata_complete
            && !first.value.relationships_available
    );
    assert!(first.value.prepared_scan_complete);
    source(&mut builder, "b", "---\nscore: 3\n---\n", true);
    let newer = capture_rows(&builder, &["a", "b", "definition"]);
    let second = query_preview(
        &program,
        &newer,
        &id("definition"),
        &[],
        &QueryOptions::default(),
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_ne!(first.capture, second.capture);
    assert_eq!(
        second
            .value
            .rows
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>(),
        ["B.md", "A.md"]
    );
    assert_eq!(
        second.value.rows[0].values["note.score"],
        BaseValue::Number { value: 3.0 }
    );
    assert_eq!(first.value.rows.len(), 1);
    let wire = serde_json::to_value(&second.value).unwrap();
    assert_eq!(wire["status"], "indexing");
    assert_eq!(wire["countsScope"], "preparedSubset");
    assert!(wire.get("snapshotId").is_none() && wire.get("capture").is_none());
    assert!(!second.value.complete); // Even all-prepared captures are not publication.
}
#[test]
fn full_prepared_scalar_rows_reuse_existing_published_evaluator() {
    let mut builder = fixture();
    source(&mut builder, "b", "---\nscore: 3\n---\n", true);
    let capture = capture_rows(&builder, &["definition", "a", "b"]);
    let program = compile_base_source(base()).unwrap();
    let options = QueryOptions::default();
    let preview = query_preview(
        &program,
        &capture,
        &id("definition"),
        &[],
        &options,
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    let prepared = builder.finish().unwrap();
    let published = query_generation(&program, prepared.generation(), &[], &options).unwrap();
    // Published generations additionally expose graph cells; that deliberate
    // availability difference is not part of this scalar equivalence oracle.
    let scalar_rows = published
        .rows
        .iter()
        .cloned()
        .map(|mut row| {
            for key in ["file.links", "file.embeds", "file.backlinks"] {
                row.values.remove(key);
            }
            row
        })
        .collect::<Vec<_>>();
    assert_eq!(preview.value.rows, scalar_rows);
    assert_eq!(preview.value.groups, published.groups);
    assert_eq!(preview.value.properties, published.properties);
    assert_eq!(preview.value.counts, published.counts);
    assert!(published.metadata_complete);
    assert!(!preview.value.metadata_complete);
}
#[test]
fn negative_relationship_filter_is_unavailable_not_false_absence() {
    let builder = fixture();
    let capture = capture_rows(&builder, &["definition", "a"]);
    for filter in ["file.hasLink(\"Missing\")", "!file.hasLink(\"Missing\")"] {
        let program = compile_base_source(&format!(
            "filters: {}\nviews:\n  - type: table\n    name: Table\n    order: [file.path]\n",
            serde_json::to_string(filter).unwrap()
        ))
        .unwrap();
        let result = query_preview(
            &program,
            &capture,
            &id("definition"),
            &[],
            &QueryOptions::default(),
            MAX_PREVIEW_QUERY_OWNED_BYTES,
        )
        .unwrap();
        assert!(result.value.rows.is_empty());
        assert_eq!(result.value.unavailable_filter_rows, 2);
        assert!(result
            .value
            .diagnostics
            .iter()
            .all(|d| d.code == "unavailable"));
    }
}
#[test]
fn failed_metadata_is_unknown_but_known_binary_and_plaintext_have_absent_properties() {
    let mut builder = builder(vec![
        entry("definition", "View.base"),
        entry("bad", "Bad.md"),
        entry("binary", "photo.png"),
        entry("plain", "Plain.txt"),
    ]);
    source(&mut builder, "definition", base(), false);
    excluded(&mut builder, "bad", Exclusion::Unreadable);
    excluded(&mut builder, "binary", Exclusion::Binary);
    source(&mut builder, "plain", "body", false);
    let capture = capture_rows(&builder, &["definition", "bad", "binary", "plain"]);
    let program = compile_base_source("filters: '!file.hasProperty(\"score\")'\nviews:\n  - type: table\n    name: Table\n    order: [file.path]\n").unwrap();
    let result = query_preview(
        &program,
        &capture,
        &id("definition"),
        &[],
        &QueryOptions::default(),
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(result.value.unavailable_prepared_files, 1);
    assert_eq!(result.value.unavailable_filter_rows, 1);
    assert_eq!(
        result
            .value
            .rows
            .iter()
            .map(|r| r.path.as_str())
            .collect::<Vec<_>>(),
        ["photo.png", "Plain.txt", "View.base"]
    );
    let mut options = QueryOptions::default();
    options.current_entry_id = Some(id("bad"));
    let known = compile_base_source("filters: file.path == \"Bad.md\"\nviews:\n  - type: table\n    name: Table\n    order: [file.path]\n").unwrap();
    let known = query_preview(
        &known,
        &capture,
        &id("definition"),
        &[],
        &options,
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(known.value.rows.len(), 1);
    assert_eq!(known.value.rows[0].path, "Bad.md");
}
#[test]
fn pending_definition_or_current_is_unavailable_and_prepared_file_fields_remain_usable() {
    let builder = fixture();
    let capture = capture_rows(&builder, &["a"]);
    let program = compile_base_source(base()).unwrap();
    assert_eq!(
        query_preview(
            &program,
            &capture,
            &id("definition"),
            &[],
            &QueryOptions::default(),
            MAX_PREVIEW_QUERY_OWNED_BYTES
        )
        .unwrap_err()
        .code,
        "unavailable"
    );
    let capture = capture_rows(&builder, &["definition", "a"]);
    let mut options = QueryOptions::default();
    options.current_entry_id = Some(id("b"));
    assert_eq!(
        query_preview(
            &program,
            &capture,
            &id("definition"),
            &[],
            &options,
            MAX_PREVIEW_QUERY_OWNED_BYTES
        )
        .unwrap_err()
        .code,
        "unavailable"
    );
    options.current_entry_id = Some(id("a"));
    let program = compile_base_source("filters: file.path == this.file.path\nviews:\n  - type: table\n    name: Table\n    order: [file.path]\n").unwrap();
    let result = query_preview(
        &program,
        &capture,
        &id("definition"),
        &[],
        &options,
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(result.value.rows.len(), 1);
    assert_eq!(result.value.rows[0].path, "A.md");
}
#[test]
fn presentation_facts_require_exact_prepared_revision_and_membership() {
    let builder = fixture();
    let capture = capture_rows(&builder, &["definition", "a"]);
    let program = compile_base_source(base()).unwrap();
    let mut fact = FilePresentationFacts {
        witness: RecordWitness {
            entry_id: id("a"),
            revision: Revision::new("r1").unwrap(),
        },
        size: Some(42),
        ctime_ms: None,
        mtime_ms: None,
    };
    let result = query_preview(
        &program,
        &capture,
        &id("definition"),
        &[fact.clone()],
        &QueryOptions::default(),
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(
        result.value.rows[0].values["file.size"],
        BaseValue::Number { value: 42.0 }
    );
    fact.witness.revision = Revision::new("r2").unwrap();
    assert_eq!(
        query_preview(
            &program,
            &capture,
            &id("definition"),
            &[fact.clone()],
            &QueryOptions::default(),
            MAX_PREVIEW_QUERY_OWNED_BYTES
        )
        .unwrap_err()
        .code,
        "stale-source"
    );
    fact.witness.entry_id = id("b");
    assert_eq!(
        query_preview(
            &program,
            &capture,
            &id("definition"),
            &[fact],
            &QueryOptions::default(),
            MAX_PREVIEW_QUERY_OWNED_BYTES
        )
        .unwrap_err()
        .code,
        "stale-source"
    );
}
#[test]
fn tightening_copy_output_work_and_cancellation_limits_never_mutate_capture() {
    let builder = fixture();
    let capture = capture_rows(&builder, &["definition", "a"]);
    let program = compile_base_source(base()).unwrap();
    let before = capture.retained_bytes();
    for bytes in [0, 1, 256, MAX_PREVIEW_QUERY_OWNED_BYTES + 1] {
        assert_eq!(
            query_preview(
                &program,
                &capture,
                &id("definition"),
                &[],
                &QueryOptions::default(),
                bytes
            )
            .unwrap_err()
            .code,
            "budget"
        );
    }
    let mut options = QueryOptions::default();
    options.max_steps = 1;
    assert_eq!(
        query_preview(
            &program,
            &capture,
            &id("definition"),
            &[],
            &options,
            MAX_PREVIEW_QUERY_OWNED_BYTES
        )
        .unwrap_err()
        .code,
        "budget"
    );
    options = QueryOptions::default();
    options.max_output_bytes = 1;
    assert_eq!(
        query_preview(
            &program,
            &capture,
            &id("definition"),
            &[],
            &options,
            MAX_PREVIEW_QUERY_OWNED_BYTES
        )
        .unwrap_err()
        .code,
        "budget"
    );
    let cancellation = OperationCancellation::default();
    cancellation.cancel();
    options = QueryOptions::default();
    options.evaluation.cancellation = Some(cancellation);
    assert_eq!(
        query_preview(
            &program,
            &capture,
            &id("definition"),
            &[],
            &options,
            MAX_PREVIEW_QUERY_OWNED_BYTES
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
    assert_eq!(capture.retained_bytes(), before);
    assert_eq!(capture.progress().prepared_files, 2);
}
#[test]
fn small_prepared_subset_does_not_prepare_a_hundred_thousand_entry_namespace() {
    let mut entries = (0..100_000)
        .map(|n| entry(&format!("note-{n:06}"), &format!("Note{n:06}.md")))
        .collect::<Vec<_>>();
    entries[0].path = VaultPath::new("View.base").unwrap();
    let mut builder = builder(entries);
    let mut names = Vec::new();
    for n in 0..128 {
        let name = format!("note-{n:06}");
        source(
            &mut builder,
            &name,
            if n == 0 {
                base()
            } else {
                "---\nscore: 2\n---\n"
            },
            n != 0,
        );
        names.push(name);
    }
    let names = names.iter().map(String::as_str).collect::<Vec<_>>();
    let capture = capture_rows(&builder, &names);
    let mut options = QueryOptions::default();
    options.max_steps = 500_000;
    let result = query_preview(
        &compile_base_source(base()).unwrap(),
        &capture,
        &id("note-000000"),
        &[],
        &options,
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(result.value.progress.total_files, 100_000);
    assert_eq!(result.value.progress.pending_files, 99_872);
    assert_eq!(result.value.counts.scanned, 128);
    assert_eq!(result.value.rows.len(), 127);
    assert!(result.value.steps_used <= 500_000);
}

#[test]
fn summaries_describe_prepared_subset_without_claiming_complete_aggregates() {
    let builder = fixture();
    let captured = capture_rows(&builder, &["definition", "a"]);
    let program = compile_base_source("filters: file.ext == 'md'\nviews:\n  - type: table\n    name: T\n    summaries:\n      score: Sum\n").unwrap();
    let result = query_preview(
        &program,
        &captured,
        &id("definition"),
        &[],
        &QueryOptions::default(),
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(
        result.value.summaries["note.score"],
        BaseValue::Number { value: 1.0 }
    );
    assert_eq!(
        result.value.groups[0].summaries["note.score"],
        BaseValue::Number { value: 1.0 }
    );
    assert!(!result.value.complete && !result.value.aggregates_complete);
    assert_eq!(
        result.value.counts_scope,
        zorid_bases::PreviewCountsScope::PreparedSubset
    );
    assert_eq!(result.value.progress.pending_files, 1);
}

#[test]
fn wiki_string_equality_in_partial_previews_is_unavailable_without_namespace_expansion() {
    let program_source="filters: author == '[[Target|Alias]]'\nviews:\n  - type: table\n    name: Partial\n    order: [file.path]\n";
    let mut builder = builder(vec![
        entry("definition", "View.base"),
        entry("a", "Folder/A.md"),
        entry("target", "Target.md"),
    ]);
    source(&mut builder, "definition", program_source, false);
    source(
        &mut builder,
        "a",
        "---\nauthor: '[[../Target]]'\n---\n",
        true,
    );
    let capture = capture_rows(&builder, &["definition", "a"]);
    let result = query_preview(
        &compile_base_source(program_source).unwrap(),
        &capture,
        &id("definition"),
        &[],
        &QueryOptions::default(),
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(result.value.counts.scanned, 2);
    assert_eq!(result.value.progress.pending_files, 1);
    assert!(!result.value.complete);
    assert!(result.value.rows.is_empty());
    assert!(result
        .value
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "unavailable"));
    let nested=compile_base_source("filters: file.ext == 'md'\nformulas:\n  contains: '[author == \"[[Target|Alias]]\"].contains(true)'\n  equality: '[author == \"[[Target|Alias]]\"] == [true]'\nviews:\n  - type: table\n    name: Nested\n    order: [file.path,formula.contains,formula.equality]\n").unwrap();
    let nested = query_preview(
        &nested,
        &capture,
        &id("definition"),
        &[],
        &QueryOptions::default(),
        MAX_PREVIEW_QUERY_OWNED_BYTES,
    )
    .unwrap();
    assert_eq!(nested.value.counts.scanned, 2);
    assert_eq!(nested.value.rows.len(), 1);
    for property in ["formula.contains", "formula.equality"] {
        assert!(
            matches!(&nested.value.rows[0].values[property],BaseValue::Error{code,..}if code=="unavailable")
        );
    }
}
