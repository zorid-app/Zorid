use super::*;
use crate::{
    document_extraction_version, Exclusion, IndexSnapshotId, MetadataRequest, PublicationFence,
    SemanticVersions, SourceWatermark, INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION,
    MAX_PUMP_DOCUMENTS, RESOLVER_VERSION,
};
use zorid_core::EntryState;
fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn ok(_: usize) -> Result<(), &'static str> {
    Ok(())
}
fn builder(entries: Vec<EntryState>) -> GenerationBuilder {
    let source = SourceSnapshotId::new(op("facts-store"), SourceWatermark::new("10").unwrap());
    let manifest = Manifest::new(source.clone(), entries).unwrap();
    let versions = SemanticVersions::new(
        INDEX_SCHEMA_VERSION,
        document_extraction_version(),
        RESOLVER_VERSION,
        LITERAL_QUERY_VERSION,
    )
    .unwrap();
    let snapshot = IndexSnapshotId::new(op("facts-store"), op("facts-epoch"), 1, versions).unwrap();
    GenerationBuilder::new(
        manifest,
        PublicationFence::new(source, None, snapshot).unwrap(),
    )
    .unwrap()
}
fn entry(name: &str, path: &str, kind: EntryKind) -> EntryState {
    EntryState {
        id: id(name),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: Revision::new("facts-revision").unwrap(),
        deleted: false,
    }
}
fn small() -> GenerationBuilder {
    builder(vec![
        entry("z", "A.md", EntryKind::File),
        entry("a", "Z.md", EntryKind::File),
        entry("pending", "pending.md", EntryKind::File),
        entry("folder", "folder", EntryKind::Folder),
    ])
}
fn text(builder: &mut GenerationBuilder, name: &str, source: &str, markdown: bool) {
    let witness = builder.manifest().witness(&id(name)).unwrap();
    let request = MetadataRequest {
        entry_id: id(name),
        content_revision: witness.entry().revision.clone(),
        source: source.into(),
    };
    builder
        .add(IndexRecord::text(witness, &request, markdown).unwrap())
        .unwrap();
}
fn capture(builder: &GenerationBuilder, names: &[&str]) -> PreviewSnapshot {
    PreviewCaptureOwner::new(op("facts-incarnation"), op("facts-stage"), builder)
        .capture_checked(
            builder,
            &names.iter().map(|name| id(name)).collect::<Vec<_>>(),
            MAX_SEARCH_OWNED_BYTES,
            ok,
        )
        .unwrap()
}
#[test]
fn facts_view_zero_partial_all_use_sealed_membership_and_id_order() {
    let mut builder = small();
    text(&mut builder, "z", "# first", true);
    text(&mut builder, "a", "# second", true);
    text(&mut builder, "pending", "not committed yet", true);
    for (names, expected, pending) in [
        (vec![], vec![], 3),
        (vec!["z"], vec!["z"], 2),
        (vec!["a", "z"], vec!["a", "z"], 1),
        (vec!["z", "pending", "a"], vec!["a", "pending", "z"], 0),
    ] {
        let snapshot = capture(&builder, &names);
        let view = snapshot.facts_view_checked(&mut ok).unwrap();
        assert_eq!(view.id(), snapshot.id());
        assert_eq!(view.source(), snapshot.source());
        assert_eq!(view.progress().pending_files, pending);
        assert_eq!(view.rows().len(), expected.len());
        let rows: Vec<_> = view.rows().collect();
        assert_eq!(
            rows.iter()
                .map(|row| row.entry_id().as_str())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(rows.iter().all(|row| row.entry_id() != &id("folder")));
    }
}
#[test]
fn facts_view_borrows_large_metadata_and_logical_fields_without_arc_acquisition() {
    let mut builder = small();
    let source = format!("---\nvalue: {}\n---\n# heading\n", "x".repeat(128 * 1024));
    text(&mut builder, "z", &source, true);
    let snapshot = capture(&builder, &["z"]);
    let record = builder.record(&id("z")).unwrap();
    let original_metadata = record.metadata().unwrap();
    let retained = snapshot.retained_bytes();
    let strong = Arc::strong_count(&snapshot.backing.rows[0]);
    let mut charged = Vec::new();
    let view = snapshot
        .facts_view_checked(&mut |n| {
            charged.push(n);
            Ok::<_, ()>(())
        })
        .unwrap();
    let row = view.rows().next().unwrap();
    assert_eq!(charged, [0, 1]);
    assert!(std::ptr::eq(row.metadata().unwrap(), original_metadata));
    assert!(std::ptr::eq(row.entry_id(), &record.witness().entry().id));
    assert!(std::ptr::eq(
        row.revision(),
        &record.witness().entry().revision
    ));
    assert!(std::ptr::eq(row.path(), &record.witness().entry().path));
    assert_eq!(row.source_text_bytes(), Some(source.len()));
    assert_eq!(row.exclusion(), None);
    assert_eq!(Arc::strong_count(&snapshot.backing.rows[0]), strong);
    assert_eq!(snapshot.retained_bytes(), retained);
}
#[test]
fn facts_view_preserves_plain_empty_binary_and_unavailable_metadata_distinctions() {
    let cases = [
        "empty",
        "plain",
        "binary",
        "unreadable",
        "source-limit",
        "extraction-limit",
    ];
    let mut builder = builder(
        cases
            .iter()
            .map(|name| entry(name, &format!("{name}.txt"), EntryKind::File))
            .collect(),
    );
    text(&mut builder, "empty", "", false);
    text(&mut builder, "plain", "text", false);
    for (name, reason) in [
        ("binary", Exclusion::Binary),
        ("unreadable", Exclusion::Unreadable),
        ("source-limit", Exclusion::SourceLimit),
        ("extraction-limit", Exclusion::ExtractionLimit),
    ] {
        let witness = builder.manifest().witness(&id(name)).unwrap();
        builder.add(IndexRecord::excluded(witness, reason)).unwrap();
    }
    let snapshot = capture(&builder, &cases);
    let view = snapshot.facts_view_checked(&mut ok).unwrap();
    for row in view.rows() {
        assert!(row.metadata().is_none());
        match row.entry_id().as_str() {
            "empty" => {
                assert_eq!(row.source_text_bytes(), Some(0));
                assert_eq!(row.exclusion(), None);
            }
            "plain" => {
                assert_eq!(row.source_text_bytes(), Some(4));
                assert_eq!(row.exclusion(), None);
            }
            "binary" => {
                assert_eq!(row.source_text_bytes(), None);
                assert_eq!(row.exclusion(), Some(&Exclusion::Binary));
            }
            "unreadable" => {
                assert_eq!(row.source_text_bytes(), None);
                assert_eq!(row.exclusion(), Some(&Exclusion::Unreadable));
            }
            "source-limit" => {
                assert_eq!(row.source_text_bytes(), None);
                assert_eq!(row.exclusion(), Some(&Exclusion::SourceLimit));
            }
            "extraction-limit" => {
                assert_eq!(row.source_text_bytes(), None);
                assert_eq!(row.exclusion(), Some(&Exclusion::ExtractionLimit));
            }
            _ => panic!("unexpected member"),
        }
    }
}
#[test]
fn facts_view_stays_bound_to_old_capture_during_builder_growth_and_finish() {
    let mut builder = small();
    text(&mut builder, "z", "# old", true);
    let old = capture(&builder, &["z"]);
    let old_view = old.facts_view_checked(&mut ok).unwrap();
    text(&mut builder, "a", "# appended", true);
    text(&mut builder, "pending", "# committed", true);
    let new = capture(&builder, &["a", "z", "pending"]);
    let new_view = new.facts_view_checked(&mut ok).unwrap();
    let generation = builder.finish().unwrap().into_parts().1;
    assert_eq!(old_view.rows().len(), 1);
    assert_eq!(old_view.progress().pending_files, 2);
    assert_eq!(new_view.rows().len(), 3);
    assert_ne!(old_view.id(), new_view.id());
    let row = old_view.rows().next().unwrap();
    assert_eq!(row.entry_id(), &id("z"));
    assert!(std::ptr::eq(
        row.metadata().unwrap(),
        generation.record(&id("z")).unwrap().metadata().unwrap()
    ));
}
#[test]
fn facts_view_factory_preserves_callback_errors_before_either_boundary() {
    #[derive(Debug, PartialEq, Eq)]
    struct Cancel(u8);
    let builder = small();
    let snapshot = capture(&builder, &[]);
    let before = snapshot.retained_bytes();
    let mut seen = Vec::new();
    let first = snapshot.facts_view_checked(&mut |n| {
        seen.push(n);
        Err(Cancel(7))
    });
    assert_eq!(first.err(), Some(Cancel(7)));
    assert_eq!(seen, [0]);
    seen.clear();
    let second = snapshot.facts_view_checked(&mut |n| {
        seen.push(n);
        if n == 1 {
            Err(Cancel(9))
        } else {
            Ok(())
        }
    });
    assert_eq!(second.err(), Some(Cancel(9)));
    assert_eq!(seen, [0, 1]);
    assert_eq!(snapshot.retained_bytes(), before);
    assert_eq!(
        snapshot.facts_view_checked(&mut ok).unwrap().rows().len(),
        0
    );
}
#[test]
fn facts_view_exact_backing_identity_cannot_alias_equal_scalar_capture_stamps() {
    let mut builder = small();
    text(&mut builder, "z", "same", false);
    // Even a host violating the fresh-nonce obligation cannot make two distinct
    // immutable backing allocations compare as the same typed capture ID.
    let a = capture(&builder, &["z"]);
    let b = capture(&builder, &["z"]);
    let av = a.facts_view_checked(&mut ok).unwrap();
    let bv = b.facts_view_checked(&mut ok).unwrap();
    assert_eq!(av.id().owner_nonce(), bv.id().owner_nonce());
    assert_eq!(av.id().stage_id(), bv.id().stage_id());
    assert_eq!(av.id().capture_serial(), bv.id().capture_serial());
    assert_eq!(av.source(), bv.source());
    assert_ne!(av.id(), bv.id());
    assert_eq!(
        av.rows().next().unwrap().path(),
        bv.rows().next().unwrap().path()
    );
}
#[test]
fn facts_view_128_of_100k_has_constant_admission_and_visits_only_prepared_rows() {
    const FILES: usize = 100_000;
    const PREPARED: usize = 128;
    let mut builder = builder(
        (0..FILES)
            .map(|n| {
                entry(
                    &format!("id{n:05}"),
                    &format!("n{n:05}.txt"),
                    EntryKind::File,
                )
            })
            .collect(),
    );
    let selected: Vec<_> = (0..PREPARED)
        .map(|n| id(&format!("id{:05}", n * (FILES / PREPARED))))
        .collect();
    for (n, entry_id) in selected.iter().enumerate() {
        if n % MAX_PUMP_DOCUMENTS == 0 {
            builder.begin_pump();
        }
        let witness = builder.manifest().witness(entry_id).unwrap();
        builder
            .add(IndexRecord::excluded(witness, Exclusion::Binary))
            .unwrap();
    }
    let snapshot = PreviewCaptureOwner::new(op("large-incarnation"), op("large-stage"), &builder)
        .capture_checked(&builder, &selected, MAX_SEARCH_OWNED_BYTES, ok)
        .unwrap();
    let strong = Arc::strong_count(&snapshot.backing.rows[0]);
    let mut boundaries = Vec::new();
    let mut units = 0usize;
    let view = snapshot
        .facts_view_checked(&mut |n| {
            boundaries.push(n);
            units = units.checked_add(n).unwrap();
            if units > 1 {
                return Err("facts view factory budget");
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(boundaries, [0, 1]);
    assert_eq!(units, 1);
    assert_eq!(view.id(), snapshot.id());
    assert_eq!(view.source(), snapshot.source());
    assert_eq!(view.rows().len(), PREPARED);
    assert_eq!(
        view.progress(),
        PreviewProgress {
            prepared_files: PREPARED as u32,
            total_files: FILES as u32,
            pending_files: (FILES - PREPARED) as u32
        }
    );
    let ids: Vec<_> = view.rows().map(|row| row.entry_id().clone()).collect();
    assert_eq!(ids, selected);
    assert_eq!(Arc::strong_count(&snapshot.backing.rows[0]), strong);
}
