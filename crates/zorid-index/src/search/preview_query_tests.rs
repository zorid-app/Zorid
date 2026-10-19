use super::*;
use crate::{
    document_extraction_version, Exclusion, GenerationBuilder, IndexSnapshotId, MetadataRequest,
    PreviewCaptureOwner, PublicationFence, SemanticVersions, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, MAX_SEARCH_OWNED_BYTES, RESOLVER_VERSION,
};
use zorid_core::{EntryKind, OperationId, Revision, VaultPath};
fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn eid(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn ok(_: usize) -> Result<(), &'static str> {
    Ok(())
}
fn fixture() -> GenerationBuilder {
    let source = SourceSnapshotId::new(op("store"), SourceWatermark::new("1").unwrap());
    let entries = [
        ("a", "Alpha.md", EntryKind::File),
        ("b", "beta.md", EntryKind::File),
        ("c", "folder/pending.md", EntryKind::File),
        ("folder", "folder", EntryKind::Folder),
    ]
    .into_iter()
    .map(|(id, path, kind)| EntryState {
        id: eid(id),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: Revision::new("r1").unwrap(),
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
    let snapshot = IndexSnapshotId::new(op("store"), op("epoch"), 1, versions).unwrap();
    GenerationBuilder::new(
        manifest,
        PublicationFence::new(source, None, snapshot).unwrap(),
    )
    .unwrap()
}
fn add(b: &mut GenerationBuilder, id: &str, text: &str) {
    let witness = b.manifest().witness(&eid(id)).unwrap();
    let request = MetadataRequest {
        entry_id: eid(id),
        content_revision: witness.entry().revision.clone(),
        source: text.into(),
    };
    b.extract_and_add(witness, &request, true).unwrap();
}
fn capture(b: &GenerationBuilder, names: &[&str], nonce: &str) -> PreviewSnapshot {
    PreviewCaptureOwner::new(op(nonce), op("stage"), b)
        .capture_checked(
            b,
            &names.iter().map(|s| eid(s)).collect::<Vec<_>>(),
            MAX_SEARCH_OWNED_BYTES,
            ok,
        )
        .unwrap()
}
fn facts(p: &PreviewSnapshot) -> Vec<SearchPresentationFacts<'_>> {
    p.manifest()
        .entries()
        .iter()
        .filter(|e| p.record(&e.id).is_some())
        .map(|entry| {
            let n = match entry.id.as_str() {
                "a" => 1,
                "b" => 2,
                _ => 3,
            };
            SearchPresentationFacts {
                entry,
                created_ms: Some(n),
                modified_ms: Some(4 - n),
            }
        })
        .collect()
}
fn spec(q: &str) -> SearchSpec {
    SearchSpec {
        query: q.into(),
        case_sensitive: false,
        sort: SearchSort::NameAsc,
        context: SearchContext::Line,
        explain: true,
    }
}
fn ready(owner: &mut RichSearchOwner, id: &PreviewQueryId) -> PreviewSearchCursor {
    for _ in 0..100_000 {
        match owner.prepare_preview_query(id, 1, ok).unwrap() {
            PreviewPreparation::Ready(c) => return c,
            PreviewPreparation::Preparing => {}
        }
    }
    panic!("preview preparation bound")
}
fn start(
    owner: &mut RichSearchOwner,
    p: &PreviewSnapshot,
    q: &str,
    profile: RichPageProfile,
) -> (PreviewQueryId, PreviewSearchCursor) {
    let id = owner
        .start_preview_query(p.clone(), spec(q), &facts(p), profile, ok)
        .unwrap();
    let cursor = ready(owner, &id);
    (id, cursor)
}
fn prepared(
    owner: &RichSearchOwner,
    c: &PreviewSearchCursor,
    bodies: &[(&str, &str)],
    reads: bool,
) -> PreparedPreviewSearchPage {
    let mut d = owner.open_preview_drive::<&str>(c).unwrap();
    for _ in 0..1000 {
        match d.next_action(ok).unwrap() {
            PreviewSearchAction::ReadText(r) => {
                assert!(reads, "body-free query requested a body");
                assert_eq!(r.capture(), c.query().capture());
                let body = bodies
                    .iter()
                    .find(|(id, _)| *id == r.entry().id.as_str())
                    .unwrap()
                    .1;
                d.accept_text(&r, body.as_bytes(), ok).unwrap();
            }
            PreviewSearchAction::Yield | PreviewSearchAction::Done => {
                return d.finish::<&str>().unwrap()
            }
        }
    }
    panic!("preview drive bound")
}
fn page(
    owner: &mut RichSearchOwner,
    c: &PreviewSearchCursor,
    bodies: &[(&str, &str)],
    reads: bool,
) -> CommittedPreviewSearchPage {
    let p = prepared(owner, c, bodies, reads);
    owner.commit_preview::<&str>(p).unwrap()
}
fn paths(p: &PreviewRichSearchPage) -> Vec<&str> {
    p.files.iter().map(|f| f.entry.path.as_str()).collect()
}
fn atleast(count: &SearchCount, n: u64) {
    assert_eq!(count, &SearchCount::AtLeast { value: n });
}

#[test]
fn preview_pending_rows_never_match_empty_filename_or_negative_queries() {
    let mut b = fixture();
    add(&mut b, "a", "left");
    add(&mut b, "b", "uncommitted");
    let p = capture(&b, &["a"], "capture");
    let mut owner = RichSearchOwner::new(op("owner"));
    for (q, n) in [
        ("", 0),
        ("-file:zzz", 1),
        ("file:pending", 0),
        ("file:beta", 0),
    ] {
        let (id, c) = start(&mut owner, &p, q, Default::default());
        let result = page(&mut owner, &c, &[], false);
        assert_eq!(result.page.files.len(), n, "{q}");
        assert_eq!(result.page.coverage.candidate_files, 1);
        assert_eq!(result.page.progress.pending_files, 2);
        assert!(result.page.prepared_scan_complete);
        assert!(result.page.output_complete);
        assert!(!result.page.complete);
        assert_eq!(result.page.status, PreviewSearchStatus::Indexing);
        atleast(&result.page.totals.files, n as u64);
        assert!(result.next.is_none());
        owner.close_preview_query(&id);
    }
    let empty = capture(&b, &[], "empty");
    let (_, c) = start(&mut owner, &empty, "", Default::default());
    let result = page(&mut owner, &c, &[], false);
    assert!(result.page.prepared_scan_complete && result.page.files.is_empty());
    atleast(&result.page.totals.files, 0);
}
#[test]
fn preview_all_prepared_still_indexing_and_all_six_sorts_use_admitted_facts() {
    let mut b = fixture();
    for id in ["a", "b", "c"] {
        add(&mut b, id, "body");
    }
    let p = capture(&b, &["a", "b", "c"], "capture");
    for (sort, expected) in [
        (
            SearchSort::NameAsc,
            vec!["Alpha.md", "beta.md", "folder/pending.md"],
        ),
        (
            SearchSort::NameDesc,
            vec!["folder/pending.md", "beta.md", "Alpha.md"],
        ),
        (
            SearchSort::CreatedAsc,
            vec!["Alpha.md", "beta.md", "folder/pending.md"],
        ),
        (
            SearchSort::CreatedDesc,
            vec!["folder/pending.md", "beta.md", "Alpha.md"],
        ),
        (
            SearchSort::ModifiedAsc,
            vec!["folder/pending.md", "beta.md", "Alpha.md"],
        ),
        (
            SearchSort::ModifiedDesc,
            vec!["Alpha.md", "beta.md", "folder/pending.md"],
        ),
    ] {
        let mut owner = RichSearchOwner::new(op("owner"));
        let mut query = spec("-file:zzz");
        query.sort = sort;
        let id = owner
            .start_preview_query(p.clone(), query, &facts(&p), Default::default(), ok)
            .unwrap();
        let c = ready(&mut owner, &id);
        let result = page(&mut owner, &c, &[], false);
        assert_eq!(paths(&result.page), expected);
        assert_eq!(result.page.progress.pending_files, 0);
        assert!(!result.page.complete);
        atleast(&result.page.totals.files, 3);
        let encoded = serde_json::to_value(&result.page).unwrap();
        assert_eq!(encoded["status"], "indexing");
        assert!(encoded.get("snapshot").is_none());
    }
}
#[test]
fn preview_full_file_and_metadata_semantics_are_reused_without_cross_row_matches() {
    let mut b = fixture();
    let a = "---\nstatus: done\n---\nleft 😀 word word\n";
    let bb = "right\n";
    add(&mut b, "a", a);
    add(&mut b, "b", bb);
    let p = capture(&b, &["a", "b"], "capture");
    let mut owner = RichSearchOwner::new(op("owner"));
    for (q, expected, reads) in [
        ("left right", 0, true),
        ("[status:done]", 1, false),
        ("content:word", 1, true),
    ] {
        let (id, c) = start(&mut owner, &p, q, Default::default());
        let result = page(&mut owner, &c, &[("a", a), ("b", bb)], reads);
        assert_eq!(result.page.files.len(), expected, "{q}");
        assert!(result.page.coverage.query_coverage_complete);
        if q == "content:word" {
            assert_eq!(result.page.files[0].occurrence_count, 2);
        }
        owner.close_preview_query(&id);
    }
}
#[test]
fn preview_prepared_unreadable_is_distinct_from_pending_and_binary_is_body_free() {
    let mut b = fixture();
    for (id, reason) in [("a", Exclusion::Binary), ("b", Exclusion::Unreadable)] {
        let w = b.manifest().witness(&eid(id)).unwrap();
        b.add(IndexRecord::excluded(w, reason)).unwrap();
    }
    let p = capture(&b, &["a", "b"], "capture");
    let mut owner = RichSearchOwner::new(op("owner"));
    let (id, c) = start(&mut owner, &p, "file:.", Default::default());
    let result = page(&mut owner, &c, &[], false);
    assert_eq!(result.page.files.len(), 2);
    assert_eq!(result.page.progress.pending_files, 1);
    owner.close_preview_query(&id);
    let (_, c) = start(&mut owner, &p, "content:word", Default::default());
    let result = page(&mut owner, &c, &[], false);
    assert_eq!(result.page.coverage.evaluated_files, 2);
    assert_eq!(result.page.coverage.unavailable_files, 1);
    assert!(!result.page.coverage.query_coverage_complete);
    assert_eq!(result.page.progress.pending_files, 1);
}
#[test]
fn preview_old_capture_and_retry_are_frozen_while_new_capture_grows() {
    let mut b = fixture();
    let body = "word ".repeat(140);
    add(&mut b, "a", &body);
    let old = capture(&b, &["a"], "old");
    let mut owner = RichSearchOwner::new(op("owner"));
    let profile = RichPageProfile {
        chunks: 1,
        locations_per_chunk: 8,
        ..Default::default()
    };
    let (id, c) = start(&mut owner, &old, "word", profile);
    let first = page(&mut owner, &c, &[("a", &body)], true);
    assert!(!first.page.output_complete);
    assert_eq!(first.page.files[0].occurrence_count, 140);
    let retry = page(&mut owner, &c, &[("a", &body)], true);
    assert_eq!(first.page, retry.page);
    assert_eq!(first.next, retry.next);
    add(&mut b, "b", "word");
    let new = capture(&b, &["a", "b"], "new");
    let mut next = first.next;
    let mut chunks = 1;
    while let Some(c) = next {
        let result = page(&mut owner, &c, &[("a", &body)], true);
        chunks += result.page.files.len();
        assert!(result.page.files.iter().all(|f| f.entry.id == eid("a")));
        assert_eq!(result.page.progress.prepared_files, 1);
        next = result.next;
    }
    assert!(chunks > 1);
    owner.close_preview_query(&id);
    let (_, c) = start(&mut owner, &new, "word", Default::default());
    let result = page(&mut owner, &c, &[("a", &body), ("b", "word")], true);
    atleast(&result.page.totals.files, 2);
}
#[test]
fn preview_capture_binding_and_read_validation_reject_cross_capture_and_wrong_bytes() {
    let mut b = fixture();
    add(&mut b, "a", "word");
    let a = capture(&b, &["a"], "a");
    let b = capture(&b, &["a"], "b");
    let mut owner = RichSearchOwner::new(op("owner"));
    let (id, c) = start(&mut owner, &a, "word", Default::default());
    let mut forged = id.clone();
    forged.capture = b.id().clone();
    assert!(matches!(
        owner.prepare_preview_query(&forged, 1, ok),
        Err(RichSearchError::Expired)
    ));
    let mut forged_cursor = c.clone();
    forged_cursor.query = forged;
    assert!(matches!(
        owner.open_preview_drive::<&str>(&forged_cursor),
        Err(RichSearchError::Expired)
    ));
    let (_, other) = start(&mut owner, &b, "word", Default::default());
    let mut d = owner.open_preview_drive::<&str>(&c).unwrap();
    let PreviewSearchAction::ReadText(r) = d.next_action(ok).unwrap() else {
        panic!()
    };
    assert_eq!(r.source(), a.source());
    assert_eq!(r.capture(), a.id());
    let mut otherdrive = owner.open_preview_drive::<&str>(&other).unwrap();
    let PreviewSearchAction::ReadText(otherrequest) = otherdrive.next_action(ok).unwrap() else {
        panic!()
    };
    assert!(matches!(
        d.accept_text(&otherrequest, b"word", ok),
        Err(RichSearchError::Invalid(_))
    ));
    drop(d);
    drop(otherdrive);
    for bytes in [&b"wrong"[..], &b"wor\0"[..], &[0xff; 4][..]] {
        let mut d = owner.open_preview_drive::<&str>(&c).unwrap();
        let PreviewSearchAction::ReadText(r) = d.next_action(ok).unwrap() else {
            panic!()
        };
        assert!(matches!(
            d.accept_text(&r, bytes, ok),
            Err(RichSearchError::Index(_))
        ));
    }
}
#[test]
fn preview_and_published_share_four_query_slots_and_existing_owner_and_drive_ledgers() {
    let mut b = fixture();
    for id in ["a", "b", "c"] {
        add(&mut b, id, "word");
    }
    let p = capture(&b, &["a"], "capture");
    let g = Arc::new(b.finish().unwrap().into_parts().1);
    let allfacts: Vec<_> = g
        .manifest()
        .entries()
        .iter()
        .filter(|e| e.kind == EntryKind::File)
        .map(|entry| SearchPresentationFacts {
            entry,
            created_ms: None,
            modified_ms: None,
        })
        .collect();
    let mut owner = RichSearchOwner::new(op("owner"));
    let mut preview_ids = Vec::new();
    let mut cursors = Vec::new();
    // Empty AST states intentionally retain no regex components. Four is the
    // shared count ceiling; expensive states may hit the byte ceiling sooner.
    for _ in 0..2 {
        let (id, c) = start(&mut owner, &p, "", Default::default());
        preview_ids.push(id);
        cursors.push(c);
    }
    for _ in 0..2 {
        let id = owner
            .start_query(g.clone(), spec(""), &allfacts, Default::default(), ok)
            .unwrap();
        loop {
            if matches!(
                owner.prepare_query(&id, 1000, ok).unwrap(),
                RichPreparation::Ready(_)
            ) {
                break;
            }
        }
    }
    assert!(matches!(
        owner.start_preview_query(p.clone(), spec(""), &facts(&p), Default::default(), ok),
        Err(RichSearchError::Resource("search query count"))
    ));
    assert!(owner.retained_bytes() >= p.retained_bytes() * 2);
    assert!(owner.retained_bytes() <= MAX_SEARCH_OWNED_BYTES);
    let d1 = owner.open_preview_drive::<&str>(&cursors[0]).unwrap();
    let d2 = owner.open_preview_drive::<&str>(&cursors[1]).unwrap();
    assert!(owner.retained_bytes() >= 16 * 1024 * 1024);
    assert!(matches!(
        owner.open_preview_drive::<&str>(&cursors[0]),
        Err(RichSearchError::Busy)
    ));
    owner.clear();
    assert!(owner.retained_bytes() > 0);
    drop(d1);
    drop(d2);
    assert_eq!(owner.retained_bytes(), 0);
    assert!(matches!(
        owner.prepare_preview_query(&preview_ids[0], 1, ok),
        Err(RichSearchError::Expired)
    ));
}
#[test]
fn preview_request_keeps_capture_charged_after_retirement_and_drive_drop() {
    let mut b = fixture();
    add(&mut b, "a", "word");
    let p = capture(&b, &["a"], "capture");
    let mut owner = RichSearchOwner::new(op("owner"));
    let (_, c) = start(&mut owner, &p, "word", Default::default());
    let query_bytes = owner.retained_bytes();
    let mut d = owner.open_preview_drive::<&str>(&c).unwrap();
    let PreviewSearchAction::ReadText(r) = d.next_action(ok).unwrap() else {
        panic!()
    };
    owner.clear();
    drop(d);
    assert!(owner.retained_bytes() > 0);
    assert!(owner.retained_bytes() <= query_bytes);
    assert_eq!(r.entry().id, eid("a"));
    drop(r);
    assert_eq!(owner.retained_bytes(), 0);
}
#[test]
fn preview_checkpoint_eviction_and_callback_retirement_preserve_existing_bounds() {
    let mut b = fixture();
    let body = "word ".repeat(40);
    add(&mut b, "a", &body);
    let p = capture(&b, &["a"], "capture");
    let mut owner = RichSearchOwner::new(op("owner"));
    let (id, first) = start(
        &mut owner,
        &p,
        "word",
        RichPageProfile {
            chunks: 1,
            locations_per_chunk: 1,
            ..Default::default()
        },
    );
    let mut c = first.clone();
    for _ in 0..9 {
        c = page(&mut owner, &c, &[("a", &body)], true).next.unwrap();
    }
    assert!(matches!(
        owner.open_preview_drive::<&str>(&first),
        Err(RichSearchError::Expired)
    ));
    let mut d = owner.open_preview_drive::<&str>(&c).unwrap();
    id.retire();
    assert!(matches!(d.next_action(ok), Err(RichSearchError::Expired)));
    drop(d);
    assert!(matches!(
        owner.prepare_preview_query(&id, 1, ok),
        Err(RichSearchError::Expired)
    ));
    assert_eq!(owner.retained_bytes(), 0);
}
#[test]
fn preview_cancellation_releases_start_and_drive_reservations_without_commit() {
    let mut b = fixture();
    add(&mut b, "a", "word");
    let p = capture(&b, &["a"], "capture");
    let mut owner = RichSearchOwner::new(op("owner"));
    assert!(matches!(
        owner.start_preview_query(
            p.clone(),
            spec("word"),
            &facts(&p),
            Default::default(),
            |_| Err("cancel")
        ),
        Err(RichSearchError::Host("cancel"))
    ));
    assert_eq!(owner.retained_bytes(), 0);
    let (_, c) = start(&mut owner, &p, "word", Default::default());
    let before = owner.retained_bytes();
    let mut d = owner.open_preview_drive::<&str>(&c).unwrap();
    assert!(matches!(
        d.next_action(|_| Err("cancel")),
        Err(RichSearchError::Host("cancel"))
    ));
    assert!(matches!(
        d.finish::<&str>(),
        Err(RichSearchError::Invalid(_))
    ));
    assert_eq!(owner.retained_bytes(), before);
    let result = page(&mut owner, &c, &[("a", "word")], true);
    atleast(&result.page.totals.files, 1);
}

#[test]
fn preview_100k_namespace_with_128_prepared_rows_admits_by_linear_membership_work() {
    const FILES: usize = 100_000;
    const PREPARED: usize = 128;
    let source = SourceSnapshotId::new(op("large-store"), SourceWatermark::new("1").unwrap());
    // Reverse exact ID and path order to require a real merge/remapping. The
    // committed rows are spread across the whole retained namespace.
    let entries = (0..FILES)
        .map(|i| EntryState {
            id: eid(&format!("id{:05}", FILES - 1 - i)),
            path: VaultPath::new(format!("n{i:05}.md")).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
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
    let snapshot = IndexSnapshotId::new(op("large-store"), op("large-epoch"), 1, versions).unwrap();
    let mut builder = GenerationBuilder::new(
        manifest,
        PublicationFence::new(source, None, snapshot).unwrap(),
    )
    .unwrap();
    let committed: Vec<_> = (0..PREPARED)
        .map(|i| eid(&format!("id{:05}", i * (FILES / PREPARED))))
        .collect();
    for (ordinal, id) in committed.iter().enumerate() {
        if ordinal % crate::MAX_PUMP_DOCUMENTS == 0 {
            builder.begin_pump();
        }
        let witness = builder.manifest().witness(id).unwrap();
        builder
            .add(IndexRecord::excluded(witness, Exclusion::Binary))
            .unwrap();
    }
    let mut capture_owner =
        PreviewCaptureOwner::new(op("large-incarnation"), op("large-stage"), &builder);
    let preview = capture_owner
        .capture_checked(&builder, &committed, MAX_SEARCH_OWNED_BYTES, ok)
        .unwrap();
    let facts = facts(&preview);
    let mut owner = RichSearchOwner::new(op("large-query-owner"));
    let mut admission_work = 0usize;
    let id = owner
        .start_preview_query(
            preview.clone(),
            spec("-file:zzz"),
            &facts,
            Default::default(),
            |n| {
                admission_work = admission_work.checked_add(n).unwrap();
                assert!(admission_work <= MAX_SEARCH_ORDER_ADMISSION_WORK);
                Ok::<_, &'static str>(())
            },
        )
        .unwrap();
    // This is a declared work-budget regression, not a measured latency claim.
    // The previous per-file binary membership admission alone required4M units.
    assert!(admission_work >= FILES);
    let cursor = ready(&mut owner, &id);
    let mut next = Some(cursor);
    let mut found = Vec::new();
    while let Some(cursor) = next {
        let result = page(&mut owner, &cursor, &[], false);
        assert_eq!(result.page.coverage.candidate_files, PREPARED as u32);
        assert_eq!(
            result.page.progress.pending_files,
            (FILES - PREPARED) as u32
        );
        found.extend(result.page.files.into_iter().map(|f| f.entry.id));
        next = result.next;
    }
    found.sort();
    let mut expected = committed;
    expected.sort();
    assert_eq!(found, expected);
}

#[test]
fn preview_and_published_regex_states_share_byte_rejection_and_close_readmission() {
    let mut b = fixture();
    for id in ["a", "b", "c"] {
        add(&mut b, id, "word");
    }
    let preview = capture(&b, &["a"], "capture");
    let generation = Arc::new(b.finish().unwrap().into_parts().1);
    let published_facts: Vec<_> = generation
        .manifest()
        .entries()
        .iter()
        .filter(|entry| entry.kind == EntryKind::File)
        .map(|entry| SearchPresentationFacts {
            entry,
            created_ms: None,
            modified_ms: None,
        })
        .collect();
    let mut owner = RichSearchOwner::new(op("byte-owner"));
    let (preview_id, _) = start(&mut owner, &preview, "/word.*/", Default::default());
    let published_id = owner
        .start_query(
            generation.clone(),
            spec("/word.*/"),
            &published_facts,
            Default::default(),
            ok,
        )
        .unwrap();
    loop {
        if matches!(
            owner.prepare_query(&published_id, 1000, ok).unwrap(),
            RichPreparation::Ready(_)
        ) {
            break;
        }
    }
    let before_rejection = owner.retained_bytes();
    assert!(before_rejection >= 8 * 1024 * 1024);
    assert!(before_rejection <= MAX_SEARCH_OWNED_BYTES);
    // Both compiled queries retain their existing conservative component
    // reservations. A new provisional admission must fit the same32MiB pool,
    // even though fewer than four query slots are in use.
    assert!(matches!(
        owner.start_preview_query(
            preview.clone(),
            spec(""),
            &facts(&preview),
            Default::default(),
            ok
        ),
        Err(RichSearchError::Resource("search owner bytes"))
    ));
    assert_eq!(owner.retained_bytes(), before_rejection);
    assert!(matches!(
        owner.start_query(
            generation.clone(),
            spec(""),
            &published_facts,
            Default::default(),
            ok
        ),
        Err(RichSearchError::Resource("search owner bytes"))
    ));
    assert_eq!(owner.retained_bytes(), before_rejection);
    assert!(owner.close_preview_query(&preview_id));
    assert!(owner.retained_bytes() < before_rejection);
    let (replacement, _) = start(&mut owner, &preview, "", Default::default());
    assert!(owner.close_preview_query(&replacement));
    let replacement = owner
        .start_query(
            generation.clone(),
            spec(""),
            &published_facts,
            Default::default(),
            ok,
        )
        .unwrap();
    assert!(owner.close_query(&replacement));
    assert!(owner.close_query(&published_id));
    assert_eq!(owner.retained_bytes(), 0);
}
