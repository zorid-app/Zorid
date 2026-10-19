use super::*;
use crate::{
    document_extraction_version, Exclusion, IndexSnapshotId, MetadataRequest, PublicationFence,
    SemanticVersions, SourceWatermark, INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION,
    RESOLVER_VERSION,
};
use zorid_core::{EntryState, Revision, VaultPath};

fn token(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn fixture(watermark: &str) -> (GenerationBuilder, PublicationFence) {
    let source = SourceSnapshotId::new(token("store"), SourceWatermark::new(watermark).unwrap());
    let entries = [
        ("a", "A.md", EntryKind::File),
        ("b", "folder/B.md", EntryKind::File),
        ("folder", "folder", EntryKind::Folder),
    ]
    .into_iter()
    .map(|(name, path, kind)| EntryState {
        id: id(name),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: Revision::new("revision").unwrap(),
        deleted: false,
    })
    .collect();
    let manifest = Manifest::new(source.clone(), entries).unwrap();
    let versions = SemanticVersions::new(
        INDEX_SCHEMA_VERSION,
        document_extraction_version(),
        RESOLVER_VERSION,
        LITERAL_QUERY_VERSION,
    )
    .unwrap();
    let previous =
        IndexSnapshotId::new(token("store"), token("epoch"), 1, versions.clone()).unwrap();
    let next = IndexSnapshotId::new(token("store"), token("epoch"), 2, versions).unwrap();
    let fence = PublicationFence::new(source, Some(previous), next).unwrap();
    (
        GenerationBuilder::new(manifest, fence.clone()).unwrap(),
        fence,
    )
}
fn owner(builder: &GenerationBuilder, incarnation: &str) -> PreviewCaptureOwner {
    PreviewCaptureOwner::new(token(incarnation), token("stage"), builder)
}
fn add(builder: &mut GenerationBuilder, name: &str, source: &str) {
    let witness = builder.manifest().witness(&id(name)).unwrap();
    let request = MetadataRequest {
        entry_id: id(name),
        content_revision: witness.entry().revision.clone(),
        source: source.into(),
    };
    builder.extract_and_add(witness, &request, true).unwrap();
}
fn capture(
    owner: &mut PreviewCaptureOwner,
    builder: &GenerationBuilder,
    names: &[&str],
) -> PreviewSnapshot {
    let ids: Vec<_> = names.iter().map(|name| id(name)).collect();
    owner
        .capture_checked(builder, &ids, MAX_SEARCH_OWNED_BYTES, |_| Ok::<_, ()>(()))
        .unwrap()
}
fn prepared_ids(snapshot: &PreviewSnapshot) -> Vec<&str> {
    snapshot
        .backing
        .rows
        .iter()
        .map(|record| record.witness().entry().id.as_str())
        .collect()
}

#[test]
fn zero_one_all_captures_use_only_declared_committed_rows_and_count_files() {
    let (mut builder, fence) = fixture("10");
    let mut capture_owner = owner(&builder, "incarnation");
    let zero = capture(&mut capture_owner, &builder, &[]);
    assert_eq!(
        zero.progress(),
        PreviewProgress {
            prepared_files: 0,
            total_files: 2,
            pending_files: 2
        }
    );
    assert_eq!(zero.source(), fence.source());
    assert!(prepared_ids(&zero).is_empty());
    add(&mut builder, "a", "# A\n");
    let first = capture(&mut capture_owner, &builder, &["a"]);
    assert_eq!(
        first.progress(),
        PreviewProgress {
            prepared_files: 1,
            total_files: 2,
            pending_files: 1
        }
    );
    add(&mut builder, "b", "# B\n");
    // Simulate builder.add preceding its adapter transaction: b exists in Rust
    // but is deliberately absent from persisted membership supplied to capture.
    let still_one = capture(&mut capture_owner, &builder, &["a"]);
    assert_eq!(prepared_ids(&still_one), ["a"]);
    assert_eq!(still_one.progress().pending_files, 1);
    let all = capture(&mut capture_owner, &builder, &["b", "a"]);
    assert_eq!(prepared_ids(&all), ["a", "b"]);
    assert_eq!(
        all.progress(),
        PreviewProgress {
            prepared_files: 2,
            total_files: 2,
            pending_files: 0
        }
    );
    assert_eq!(prepared_ids(&first), ["a"]);
    assert_eq!(zero.progress().pending_files, 2);
    assert_eq!(first.id().capture_serial(), 2);
    assert_eq!(still_one.id().capture_serial(), 3);
    assert!(!first.same_capture(&still_one));
    assert!(first.same_capture(&first.clone()));
}

#[test]
fn missing_duplicate_foreign_and_folder_membership_reject_without_serial_advance() {
    let (mut builder, _) = fixture("10");
    add(&mut builder, "a", "A\n");
    let mut capture_owner = owner(&builder, "incarnation");
    for ids in [
        vec![id("b")],
        vec![id("foreign")],
        vec![id("a"), id("a")],
        vec![id("folder")],
    ] {
        assert!(matches!(
            capture_owner
                .capture_checked(&builder, &ids, MAX_SEARCH_OWNED_BYTES, |_| Ok::<_, ()>(())),
            Err(PreviewCaptureError::Index(_))
        ));
        assert_eq!(builder.prepared_records(), 1);
    }
    let first = capture(&mut capture_owner, &builder, &["a"]);
    assert_eq!(first.id().capture_serial(), 1);
    assert_eq!(prepared_ids(&first), ["a"]);
}

#[test]
fn capture_is_bound_to_exact_builder_source_and_incarnation() {
    let (mut builder, _) = fixture("10");
    add(&mut builder, "a", "A\n");
    let mut first_owner = owner(&builder, "incarnation-one");
    let first = capture(&mut first_owner, &builder, &["a"]);
    let (mut equivalent_builder, _) = fixture("10");
    add(&mut equivalent_builder, "a", "A\n");
    assert_eq!(builder.manifest(), equivalent_builder.manifest());
    assert!(matches!(
        first_owner.capture_checked(
            &equivalent_builder,
            &[id("a")],
            MAX_SEARCH_OWNED_BYTES,
            |_| Ok::<_, ()>(())
        ),
        Err(PreviewCaptureError::Index(IndexError::StaleSource))
    ));
    let (foreign_source, _) = fixture("11");
    assert!(matches!(
        first_owner.capture_checked(
            &foreign_source,
            &[],
            MAX_SEARCH_OWNED_BYTES,
            |_| Ok::<_, ()>(())
        ),
        Err(PreviewCaptureError::Index(IndexError::StaleSource))
    ));
    let mut second_owner = owner(&equivalent_builder, "incarnation-two");
    let second = capture(&mut second_owner, &equivalent_builder, &["a"]);
    assert_eq!(first.id().stage_id(), second.id().stage_id());
    assert_eq!(first.id().capture_serial(), second.id().capture_serial());
    assert_eq!(first.progress(), second.progress());
    assert_ne!(first.id().owner_nonce(), second.id().owner_nonce());
    assert_ne!(first.id(), second.id());
    assert!(!first.same_capture(&second));
    // Even a host that incorrectly reuses scalar identity data cannot make a
    // reconstructed backing compare equal to an earlier immutable capture.
    let mut reused_nonce_owner = owner(&equivalent_builder, "incarnation-one");
    let reused = capture(&mut reused_nonce_owner, &equivalent_builder, &["a"]);
    assert_eq!(first.id().owner_nonce(), reused.id().owner_nonce());
    assert_eq!(first.id().stage_id(), reused.id().stage_id());
    assert_eq!(first.id().capture_serial(), reused.id().capture_serial());
    assert_ne!(first.id(), reused.id());
    assert!(!first.same_capture(&reused));
    let mut other_stage = PreviewCaptureOwner::new(
        token("incarnation-three"),
        token("different-stage"),
        &builder,
    );
    let other = capture(&mut other_stage, &builder, &["a"]);
    assert_ne!(first.id().stage_id(), other.id().stage_id());
    assert_ne!(first.id(), other.id());
}

#[test]
fn captures_share_large_immutable_facts_through_append_and_complete_finish() {
    let (mut builder, fence) = fixture("10");
    let large = format!("---\nlabel: {}\n---\n# heading\n", "x".repeat(128 * 1024));
    add(&mut builder, "a", &large);
    drop(large);
    let bytes_before = builder.metadata_bytes();
    let mut capture_owner = owner(&builder, "incarnation");
    let first = capture_owner
        .capture_checked(&builder, &[id("a")], 1024, |_| Ok::<_, ()>(()))
        .unwrap();
    assert!(first.retained_bytes() < 1024);
    assert!(std::ptr::eq(
        first.backing.manifest.as_ref(),
        builder.manifest()
    ));
    let retained_record = first.backing.rows[0].clone();
    assert!(std::ptr::eq(
        retained_record.as_ref(),
        builder.record(&id("a")).unwrap()
    ));
    assert_eq!(builder.metadata_bytes(), bytes_before);
    add(&mut builder, "b", "B\n");
    let all = capture(&mut capture_owner, &builder, &["a", "b"]);
    assert!(Arc::ptr_eq(&first.backing.rows[0], &all.backing.rows[0]));
    let prepared = builder.finish().unwrap();
    assert_eq!(prepared.fence(), &fence);
    assert_eq!(prepared.generation().id(), fence.next_index());
    assert_eq!(prepared.generation().manifest().source(), fence.source());
    assert_eq!(prepared.generation().records().count(), 2);
    assert!(std::ptr::eq(
        first.backing.manifest.as_ref(),
        prepared.generation().manifest()
    ));
    assert!(std::ptr::eq(
        retained_record.as_ref(),
        prepared.generation().record(&id("a")).unwrap()
    ));
    drop(prepared);
    drop(all);
    drop(capture_owner);
    assert_eq!(first.progress().prepared_files, 1);
    assert!(
        retained_record.metadata().unwrap().properties[0]
            .value
            .as_str()
            .unwrap()
            .len()
            >= 128 * 1024
    );
    assert_eq!(first.source(), fence.source());
}

#[test]
fn incomplete_finish_remains_rejected_and_terminal_exclusions_remain_explicit() {
    let (mut incomplete, _) = fixture("10");
    add(&mut incomplete, "a", "A\n");
    assert!(matches!(
        incomplete.finish(),
        Err(IndexError::InvalidRecord)
    ));
    let (mut builder, _) = fixture("10");
    builder
        .add(IndexRecord::excluded(
            builder.manifest().witness(&id("a")).unwrap(),
            Exclusion::Unreadable,
        ))
        .unwrap();
    builder
        .add(IndexRecord::excluded(
            builder.manifest().witness(&id("b")).unwrap(),
            Exclusion::Binary,
        ))
        .unwrap();
    let mut capture_owner = owner(&builder, "incarnation");
    let preview = capture(&mut capture_owner, &builder, &["a", "b"]);
    assert_eq!(preview.progress().pending_files, 0);
    assert_eq!(
        preview.backing.rows[0].exclusion(),
        Some(&Exclusion::Unreadable)
    );
    assert_eq!(
        preview.backing.rows[1].exclusion(),
        Some(&Exclusion::Binary)
    );
    let generation = builder.finish().unwrap().into_parts().1;
    assert!(!generation.coverage_complete());
}

#[test]
fn allocation_and_early_or_final_cancel_do_not_publish_identity_or_membership() {
    let (mut builder, _) = fixture("10");
    add(&mut builder, "a", "A\n");
    add(&mut builder, "b", "B\n");
    let mut capture_owner = owner(&builder, "incarnation");
    assert!(matches!(
        capture_owner.capture_checked(&builder, &[id("a")], 0, |_| Ok::<_, ()>(())),
        Err(PreviewCaptureError::Resource(_))
    ));
    assert!(matches!(
        capture_owner.capture_checked(&builder, &[id("a")], MAX_SEARCH_OWNED_BYTES, |_| Err(
            "early"
        )),
        Err(PreviewCaptureError::Host("early"))
    ));
    assert!(matches!(
        capture_owner.capture_checked(&builder, &[id("a"), id("b")], MAX_SEARCH_OWNED_BYTES, |n| {
            if n == 0 {
                Err("final")
            } else {
                Ok(())
            }
        }),
        Err(PreviewCaptureError::Host("final"))
    ));
    let first = capture(&mut capture_owner, &builder, &["a"]);
    assert_eq!(first.id().capture_serial(), 1);
    assert_eq!(prepared_ids(&first), ["a"]);
    let too_small = first.retained_bytes().saturating_sub(1);
    assert!(matches!(
        capture_owner.capture_checked(&builder, &[id("a")], too_small, |_| Ok::<_, ()>(())),
        Err(PreviewCaptureError::Resource(_))
    ));
    let second = capture(&mut capture_owner, &builder, &["a", "b"]);
    assert_eq!(second.id().capture_serial(), 2);
    assert_eq!(prepared_ids(&first), ["a"]);
}

#[test]
fn checked_serial_exhaustion_never_wraps_or_reuses_an_identity() {
    let (builder, _) = fixture("10");
    let mut capture_owner = owner(&builder, "incarnation");
    capture_owner.next_serial = u64::MAX;
    assert!(matches!(
        capture_owner.capture_checked(&builder, &[], MAX_SEARCH_OWNED_BYTES, |_| Ok::<_, ()>(())),
        Err(PreviewCaptureError::Resource(
            "preview capture serial exhausted"
        ))
    ));
    assert_eq!(capture_owner.next_serial, u64::MAX);
}

#[test]
fn weak_id_does_not_keep_captured_fact_rows_alive_after_snapshot_drop() {
    let (mut builder, _) = fixture("10");
    add(&mut builder, "a", "A\n");
    let mut capture_owner = owner(&builder, "incarnation");
    let first = capture(&mut capture_owner, &builder, &["a"]);
    let identity = first.id().clone();
    let record = Arc::downgrade(&first.backing.rows[0]);
    drop(first);
    drop(capture_owner);
    drop(builder);
    assert!(identity.backing.upgrade().is_none());
    assert!(record.upgrade().is_none());
}
