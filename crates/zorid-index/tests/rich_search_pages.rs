//! Pure retained-generation/page integration targets. No native database, IO,
//! live-stat admission, bridge, pin, or platform parity is exercised here.
use std::{collections::BTreeMap, sync::Arc};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::*;

type HostError = &'static str;
fn check(_: usize) -> Result<(), HostError> { Ok(()) }

struct Fixture {
    path: String,
    body: Option<String>,
    exclusion: Option<Exclusion>,
    created: Option<i64>,
    modified: Option<i64>,
}
impl Fixture {
    fn text(path: &str, body: impl Into<String>) -> Self {
        Self { path: path.into(), body: Some(body.into()), exclusion: None,
            created: None, modified: None }
    }
    fn excluded(path: &str, exclusion: Exclusion) -> Self {
        Self { path: path.into(), body: None, exclusion: Some(exclusion),
            created: None, modified: None }
    }
}
fn generation(fixtures: &[Fixture]) -> Arc<Generation> {
    let source = SourceSnapshotId::new(OperationId::new("rich-page-store").unwrap(),
        SourceWatermark::new("42").unwrap());
    let entries = fixtures.iter().enumerate().map(|(i, f)| EntryState {
        id: EntryId::new(format!("rich-entry-{i}")).unwrap(),
        path: VaultPath::new(&f.path).unwrap(), kind: EntryKind::File,
        revision: Revision::new(format!("retained-revision-{i}")).unwrap(), deleted: false,
    }).collect();
    let manifest = Manifest::new(source.clone(), entries).unwrap();
    let versions = SemanticVersions::new(INDEX_SCHEMA_VERSION, document_extraction_version(),
        RESOLVER_VERSION, LITERAL_QUERY_VERSION).unwrap();
    let snapshot = IndexSnapshotId::new(OperationId::new("rich-page-store").unwrap(),
        OperationId::new("rich-page-epoch").unwrap(), 1, versions).unwrap();
    let fence = PublicationFence::new(source, None, snapshot).unwrap();
    let mut builder = GenerationBuilder::new(manifest.clone(), fence).unwrap();
    for entry in manifest.entries() {
        let f = fixtures.iter().find(|f| f.path == entry.path.as_str()).unwrap();
        let witness = manifest.witness(&entry.id).unwrap();
        let record = match &f.body {
            Some(body) => IndexRecord::text(witness, &MetadataRequest {
                entry_id: entry.id.clone(), content_revision: entry.revision.clone(),
                source: body.clone(),
            }, f.path.ends_with(".md")).unwrap(),
            None => IndexRecord::excluded(witness, f.exclusion.clone().unwrap()),
        };
        match builder.add(record.clone()) {
            Ok(()) => {},
            Err(IndexError::PumpLimit) => { builder.begin_pump(); builder.add(record).unwrap(); },
            result => panic!("fixture preparation failed: {result:?}"),
        }
    }
    Arc::new(builder.finish().unwrap().into_parts().1)
}
fn facts<'a>(g: &'a Generation, fixtures: &[Fixture]) -> Vec<SearchPresentationFacts<'a>> {
    g.manifest().entries().iter().map(|entry| {
        let f = fixtures.iter().find(|f| f.path == entry.path.as_str()).unwrap();
        SearchPresentationFacts { entry, created_ms: f.created, modified_ms: f.modified }
    }).collect()
}
fn spec(query: &str) -> SearchSpec {
    SearchSpec { query: query.into(), case_sensitive: false, sort: SearchSort::NameAsc,
        context: SearchContext::Line, explain: true }
}
fn owner(nonce: &str) -> RichSearchOwner {
    RichSearchOwner::new(OperationId::new(nonce).unwrap())
}
fn ready(owner: &mut RichSearchOwner, id: &RichQueryId) -> RichSearchCursor {
    // Small soft pumps also exercise preparation before any source read.
    for _ in 0..100_000 {
        match owner.prepare_query(id, 1, check).unwrap() {
            RichPreparation::Preparing => {},
            RichPreparation::Ready(cursor) => return cursor,
        }
    }
    panic!("bounded fixture order did not become ready")
}
fn start(owner: &mut RichSearchOwner, g: &Arc<Generation>, fixtures: &[Fixture],
    query: &str, profile: RichPageProfile) -> (RichQueryId, RichSearchCursor) {
    let id = owner.start_query(g.clone(), spec(query), &facts(g, fixtures), profile, check).unwrap();
    let cursor = ready(owner, &id);
    (id, cursor)
}
fn prepare_page(owner: &RichSearchOwner, cursor: &RichSearchCursor, fixtures: &[Fixture],
    allow_read: bool) -> PreparedRichSearchPage {
    let mut drive = owner.open_drive::<HostError>(cursor).unwrap();
    for _ in 0..100_000 {
        match drive.next_action(check).unwrap() {
            RichSearchAction::ReadText(request) => {
                assert!(allow_read, "body-free query requested {}", request.entry().path.as_str());
                let body = fixtures.iter().find(|f| f.path == request.entry().path.as_str())
                    .unwrap().body.as_ref().expect("read must refer to retained text");
                assert_eq!(request.bytes(), body.len());
                drive.accept_text(&request, body.as_bytes(), check).unwrap();
            },
            RichSearchAction::Yield | RichSearchAction::Done => {
                return drive.finish::<HostError>().unwrap();
            },
        }
    }
    panic!("bounded fixture drive did not yield")
}
fn page(owner: &mut RichSearchOwner, cursor: &RichSearchCursor, fixtures: &[Fixture],
    allow_read: bool) -> CommittedRichSearchPage {
    let prepared = prepare_page(owner, cursor, fixtures, allow_read);
    owner.commit::<HostError>(prepared).unwrap()
}
fn collect(owner: &mut RichSearchOwner, first: RichSearchCursor, fixtures: &[Fixture],
    allow_read: bool) -> Vec<DocumentRichSearchPage> {
    let mut cursor = first;
    let mut pages = Vec::new();
    for _ in 0..1000 {
        let committed = page(owner, &cursor, fixtures, allow_read);
        pages.push(committed.page);
        match committed.next { Some(next) => cursor = next, None => return pages }
    }
    panic!("bounded fixture pages did not exhaust")
}
fn request(drive: &mut RichSearchDrive) -> RichTextReadRequest {
    match drive.next_action(check).unwrap() {
        RichSearchAction::ReadText(request) => request,
        other => panic!("expected retained text request, got {other:?}"),
    }
}
fn unique_locations(pages: &[DocumentRichSearchPage]) -> BTreeMap<(EntryId, u32), SearchLocation> {
    let mut locations = BTreeMap::new();
    for chunk in pages.iter().flat_map(|p| &p.files) {
        for location in &chunk.locations {
            let key = (chunk.entry.id.clone(), location.index);
            if let Some(previous) = locations.insert(key, location.clone()) {
                assert_eq!(previous, *location, "repeated ordinal changed its proof");
            }
        }
        for snippet in &chunk.snippets {
            assert!(chunk.locations.iter().any(|l| l.index == snippet.primary_location_index));
            for highlight in &snippet.highlights {
                assert!(highlight.utf16[0] < highlight.utf16[1]);
                assert!(!highlight.location_indices.is_empty());
                assert!(highlight.location_indices.windows(2).all(|w| w[0] < w[1]));
                assert!(highlight.location_indices.iter().all(|i| chunk.locations.iter().any(|l| l.index == *i)));
            }
            assert!(snippet.highlights.windows(2).all(|w| w[0].utf16[1] <= w[1].utf16[0]));
        }
    }
    locations
}
fn assert_exact(page: &DocumentRichSearchPage, files: u64, occurrences: u64) {
    assert!(page.complete && page.scan_complete && page.output_complete);
    assert!(page.coverage.query_coverage_complete && page.coverage.scan_complete);
    assert_eq!(page.totals.files, SearchCount::Exact { value: files });
    assert_eq!(page.totals.occurrences, SearchCount::Exact { value: occurrences });
}

#[test]
fn chunk_limits_one_and_one_hundred_deliver_every_ordinal_and_retry_identically() {
    let body = (0..105).map(|i| format!("needle {i:03}\n")).collect::<String>();
    let fixtures = [Fixture::text("Only.md", body.clone())];
    let g = generation(&fixtures);
    for chunks in [1, 100] {
        let mut owner = owner("chunk-owner");
        let profile = RichPageProfile { chunks, locations_per_chunk: 1, ..Default::default() };
        let (_, first) = start(&mut owner, &g, &fixtures, "content:needle", profile);
        let initial = page(&mut owner, &first, &fixtures, true);
        let retry = page(&mut owner, &first, &fixtures, true);
        assert_eq!(serde_json::to_vec(&initial.page).unwrap(), serde_json::to_vec(&retry.page).unwrap());
        assert_eq!(initial.next, retry.next, "retry must return the same opaque continuation");
        let wire = serde_json::to_value(&initial.page).unwrap();
        assert_eq!(wire["next"], serde_json::Value::Null);
        assert_eq!(wire["dialect"], SEARCH_DIALECT);
        assert_eq!(wire["spec"]["query"], "content:needle");
        assert_eq!(wire["spec"]["sort"], "nameAsc");
        assert_eq!(wire["coverage"]["candidateFiles"], 1);
        assert_eq!(wire["outputComplete"], false);
        assert_eq!(wire["scanComplete"], true);
        assert_eq!(wire["coverage"]["scanComplete"], true);
        assert_eq!(wire["complete"], false);
        assert_eq!(wire["totals"]["files"]["relation"], "exact");
        assert_eq!(wire["totals"]["files"]["value"], 1);
        assert_eq!(wire["totals"]["occurrences"]["relation"], "exact");
        assert_eq!(wire["totals"]["occurrences"]["value"], 105);
        assert_eq!(wire["files"][0]["locations"][0]["role"], "occurrence");
        assert_eq!(wire["explanation"]["dialect"], SEARCH_DIALECT);
        assert_eq!(initial.page.files.len(), chunks);
        assert_eq!(initial.page.totals.files, SearchCount::Exact { value: 1 });
        assert_eq!(initial.page.totals.occurrences, SearchCount::Exact { value: 105 });
        assert!(initial.page.scan_complete && initial.page.coverage.scan_complete);
        assert!(initial.page.coverage.query_coverage_complete);
        assert!(!initial.page.output_complete && !initial.page.complete);
        assert!(initial.next.is_some());
        let mut pages = vec![initial.page];
        pages.extend(collect(&mut owner, initial.next.unwrap(), &fixtures, true));
        let chunks = pages.iter().flat_map(|p| &p.files).collect::<Vec<_>>();
        assert_eq!(chunks.len(), 105);
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.chunk, i as u32);
            assert_eq!(chunk.last_chunk, i == 104);
            assert_eq!(chunk.occurrence_count, 105);
            assert_eq!(chunk.entry, g.manifest().entries()[0]);
        }
        let locations = unique_locations(&pages);
        assert_eq!(locations.len(), 105);
        for (i, (offset, _)) in body.match_indices("needle").enumerate() {
            let location = &locations[&(g.manifest().entries()[0].id.clone(), i as u32)];
            assert_eq!(location.occurrences, 1);
            assert!(matches!(&location.locator, SearchLocator::Source { range, .. }
                if range.bytes == [offset as u32, (offset + 6) as u32]));
        }
        assert_exact(pages.last().unwrap(), 1, 105);
        assert!(pages.iter().all(|p| p.snapshot == *g.id()));
    }
}

#[test]
fn encoded_byte_bound_continues_inside_a_file_without_losing_locations() {
    let body = (0..40).map(|i| format!("{i:03} needle {}\n", "x".repeat(180))).collect::<String>();
    let fixtures = [Fixture::text("Byte-bound.md", body)];
    let g = generation(&fixtures);
    let mut owner = owner("byte-owner");
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:needle",
        RichPageProfile { bytes: 4096, ..Default::default() });
    let first = page(&mut owner, &cursor, &fixtures, true);
    assert!(first.next.is_some());
    assert!(!first.page.files.is_empty());
    assert!(!first.page.files.last().unwrap().last_chunk);
    let retry = page(&mut owner, &cursor, &fixtures, true);
    assert_eq!(serde_json::to_vec(&first.page).unwrap(), serde_json::to_vec(&retry.page).unwrap());
    assert_eq!(first.next, retry.next);
    let mut pages = vec![first.page];
    pages.extend(collect(&mut owner, first.next.unwrap(), &fixtures, true));
    assert!(pages.len() > 1);
    for (i, p) in pages.iter().enumerate() {
        assert!(serde_json::to_vec(p).unwrap().len() <= 4096);
        assert!(p.scan_complete && p.coverage.scan_complete && p.coverage.query_coverage_complete);
        assert_eq!(p.coverage.evaluated_files, 1);
        assert_eq!(p.totals.files, SearchCount::Exact { value: 1 });
        assert_eq!(p.totals.occurrences, SearchCount::Exact { value: 40 });
        let final_page = i + 1 == pages.len();
        assert_eq!(p.output_complete, final_page);
        assert_eq!(p.complete, final_page);
    }
    let locations = unique_locations(&pages);
    assert_eq!(locations.keys().map(|(_, i)| *i).collect::<Vec<_>>(), (0..40).collect::<Vec<_>>());
    assert_exact(pages.last().unwrap(), 1, 40);
}

#[test]
fn full_file_counts_survive_touch_merged_highlights_and_zero_location_success() {
    let fixtures = [Fixture::text("Count.md", "aaaa")];
    let g = generation(&fixtures);
    let mut owner = owner("count-owner");
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:aa OR content:aa", Default::default());
    let p = page(&mut owner, &cursor, &fixtures, true).page;
    assert_exact(&p, 1, 2);
    assert_eq!(p.files[0].occurrence_count, 2);
    assert_eq!(p.files[0].locations.len(), 1);
    assert_eq!(p.files[0].locations[0].occurrences, 2);
    assert!(matches!(&p.files[0].locations[0].locator, SearchLocator::Source { range, .. }
        if range.bytes == [0, 4]));
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:-missing", Default::default());
    let p = page(&mut owner, &cursor, &fixtures, true).page;
    assert_exact(&p, 1, 0);
    assert_eq!(p.files.len(), 1);
    assert_eq!(p.files[0].chunk, 0);
    assert!(p.files[0].last_chunk);
    assert_eq!(p.files[0].occurrence_count, 0);
    assert!(p.files[0].locations.is_empty() && p.files[0].snippets.is_empty());
}

#[test]
fn name_and_metadata_queries_never_read_bodies_and_keep_generation_coverage_honest() {
    let fixtures = [Fixture::text("A.md", "---\nstatus: ready\n---\nsecret body"),
        Fixture::excluded("B.bin", Exclusion::Binary), Fixture::excluded("C.txt", Exclusion::Unreadable)];
    let g = generation(&fixtures);
    assert!(!g.coverage_complete());
    let mut owner = owner("body-free-owner");
    let (_, cursor) = start(&mut owner, &g, &fixtures, "file:.", Default::default());
    let p = page(&mut owner, &cursor, &fixtures, false).page;
    assert_exact(&p, 3, 3);
    assert!(!p.coverage_complete);
    assert_eq!(p.work.source_bytes, 0);
    assert_eq!(p.coverage.unavailable_files, 0);
    // The metadata query's fixture is fully covered, including a known binary.
    let fixtures = &fixtures[..2];
    let g = generation(fixtures);
    let (_, cursor) = start(&mut owner, &g, fixtures, "[status:ready]", Default::default());
    let p = page(&mut owner, &cursor, fixtures, false).page;
    assert_exact(&p, 1, 1);
    assert_eq!(p.work.source_bytes, 0);
    assert!(p.coverage_complete);
    assert_eq!(p.files[0].entry.path.as_str(), "A.md");
}

#[test]
fn whole_file_and_and_exclusion_are_not_split_at_newlines_or_soft_source_budget() {
    let fixtures = [Fixture::text("A.md", "first\nplain\nlast"),
        Fixture::text("B.md", "first\nblocked\nlast"), Fixture::text("C.md", "first only")];
    let g = generation(&fixtures);
    let mut owner = owner("boolean-owner");
    let (_, cursor) = start(&mut owner, &g, &fixtures,
        "content:first content:last -content:blocked",
        RichPageProfile { documents: 1, source_bytes: 1, ..Default::default() });
    let pages = collect(&mut owner, cursor, &fixtures, true);
    assert!(pages.len() >= 3);
    let chunks = pages.iter().flat_map(|p| &p.files).collect::<Vec<_>>();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].entry.path.as_str(), "A.md");
    assert_eq!(chunks[0].occurrence_count, 2);
    assert_exact(pages.last().unwrap(), 1, 2);
    assert_eq!(pages.last().unwrap().coverage.evaluated_files, 3);
}

#[test]
fn missing_required_extraction_exhausts_with_unavailable_coverage_and_lower_bound_counts() {
    let fixtures = [Fixture::text("A.md", "needle"),
        Fixture::excluded("B.txt", Exclusion::Unreadable), Fixture::excluded("C.bin", Exclusion::Binary)];
    let g = generation(&fixtures);
    let mut owner = owner("coverage-owner");
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let result = page(&mut owner, &cursor, &fixtures, true);
    assert!(result.next.is_none());
    let p = result.page;
    assert!(p.scan_complete && p.output_complete);
    assert!(!p.complete && !p.coverage_complete && !p.coverage.query_coverage_complete);
    assert_eq!(p.coverage.candidate_files, 3);
    assert_eq!(p.coverage.evaluated_files, 3);
    assert_eq!(p.coverage.unavailable_files, 1);
    assert_eq!(p.totals.files, SearchCount::AtLeast { value: 1 });
    assert_eq!(p.totals.occurrences, SearchCount::AtLeast { value: 1 });
    assert_eq!(p.files.len(), 1);
}

#[test]
fn tamper_foreign_request_and_cancellation_poison_only_the_drive_and_retry_is_safe() {
    let fixtures = [Fixture::text("A.md", "needle")];
    let g = generation(&fixtures);
    let mut owner = owner("poison-owner");
    let (_, first) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let baseline = page(&mut owner, &first, &fixtures, true);
    let (_, other) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let mut other_drive = owner.open_drive::<HostError>(&other).unwrap();
    let foreign = request(&mut other_drive);
    drop(other_drive);
    for failure in 0..4 {
        let mut drive = owner.open_drive::<HostError>(&first).unwrap();
        let expected = request(&mut drive);
        assert_eq!(expected.snapshot(), g.id());
        assert_eq!(expected.entry(), &g.manifest().entries()[0]);
        assert_eq!(expected.digest(), g.records().next().unwrap().text_digest().unwrap());
        match failure {
            0 => assert!(matches!(drive.accept_text(&expected, b"NEEDLE", check),
                Err(RichSearchError::Index(IndexError::ContentMismatch)))),
            1 => assert!(matches!(drive.accept_text(&foreign, b"needle", check),
                Err(RichSearchError::Invalid(_)))),
            2 => assert!(matches!(drive.accept_text(&expected, b"needle", |_| Err("cancelled")),
                Err(RichSearchError::Host("cancelled")))),
            _ => assert!(matches!(drive.next_action(|_| Err("cancelled")),
                Err(RichSearchError::Host("cancelled")))),
        }
        assert!(matches!(drive.finish::<HostError>(), Err(RichSearchError::Invalid(_))));
        let retry = page(&mut owner, &first, &fixtures, true);
        assert_eq!(serde_json::to_vec(&baseline.page).unwrap(), serde_json::to_vec(&retry.page).unwrap());
        assert_eq!(baseline.next, retry.next);
    }
}

#[test]
fn query_and_owner_close_expire_active_drives_prepared_pages_and_foreign_owner_cursors() {
    let fixtures = [Fixture::text("A.md", "needle")];
    let g = generation(&fixtures);
    let mut owner = owner("lifetime-owner");
    let (id, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let prepared = prepare_page(&owner, &cursor, &fixtures, true);
    assert!(owner.close_query(&id));
    assert!(!owner.close_query(&id));
    assert!(matches!(owner.commit::<HostError>(prepared), Err(RichSearchError::Expired)));
    assert!(matches!(owner.open_drive::<HostError>(&cursor), Err(RichSearchError::Expired)));
    let other = RichSearchOwner::new(OperationId::new("different-owner").unwrap());
    assert!(matches!(other.open_drive::<HostError>(&cursor), Err(RichSearchError::Expired)));
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let mut drive = owner.open_drive::<HostError>(&cursor).unwrap();
    let read = request(&mut drive);
    owner.clear();
    assert!(owner.retained_bytes() > 0, "live external drive still owns reservations");
    assert!(matches!(drive.accept_text(&read, b"needle", check), Err(RichSearchError::Expired)));
    drop(drive);
    assert_eq!(owner.retained_bytes(), 0);
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let drive = owner.open_drive::<HostError>(&cursor).unwrap();
    drop(owner);
    assert!(matches!(drive.finish::<HostError>(), Err(RichSearchError::Expired)));
}

#[test]
fn eight_checkpoints_expire_the_oldest_and_dropped_guards_release_busy() {
    let fixtures = [Fixture::text("A.md", "needle\n".repeat(12))];
    let g = generation(&fixtures);
    let mut owner = owner("checkpoint-owner");
    let (id, initial) = start(&mut owner, &g, &fixtures, "content:needle",
        RichPageProfile { chunks: 1, locations_per_chunk: 1, ..Default::default() });
    let drive = owner.open_drive::<HostError>(&initial).unwrap();
    assert!(matches!(owner.open_drive::<HostError>(&initial), Err(RichSearchError::Busy)));
    drop(drive);
    let prepared = prepare_page(&owner, &initial, &fixtures, true);
    assert!(matches!(owner.open_drive::<HostError>(&initial), Err(RichSearchError::Busy)));
    drop(prepared);
    let mut cursor = initial.clone();
    for _ in 0..MAX_SEARCH_CHECKPOINTS {
        cursor = page(&mut owner, &cursor, &fixtures, true).next.unwrap();
    }
    assert!(matches!(owner.open_drive::<HostError>(&initial), Err(RichSearchError::Expired)));
    assert!(matches!(owner.prepare_query(&id, 1, check), Err(RichSearchError::Expired)));
    let pages = collect(&mut owner, cursor, &fixtures, true);
    assert_exact(pages.last().unwrap(), 1, 12);
    assert_eq!(pages.last().unwrap().coverage.evaluated_files, 1);
}

#[test]
fn invalid_profiles_failed_admission_and_query_caps_leave_no_partial_state() {
    let fixtures = [Fixture::excluded("A.bin", Exclusion::Binary)];
    let g = generation(&fixtures);
    let mut owner = owner("bounds-owner");
    let valid = RichPageProfile::default();
    let mut invalid = Vec::new();
    for chunks in [0, 101] { invalid.push(RichPageProfile { chunks, ..valid.clone() }); }
    for bytes in [1023, MAX_SEARCH_PAGE_BYTES + 1] { invalid.push(RichPageProfile { bytes, ..valid.clone() }); }
    for locations_per_chunk in [0, 65] { invalid.push(RichPageProfile { locations_per_chunk, ..valid.clone() }); }
    for documents in [0, 33] { invalid.push(RichPageProfile { documents, ..valid.clone() }); }
    for source_bytes in [0, MAX_PUMP_BYTES + 1] { invalid.push(RichPageProfile { source_bytes, ..valid.clone() }); }
    for work in [0, 2_000_001] { invalid.push(RichPageProfile { work, ..valid.clone() }); }
    for profile in invalid {
        assert!(matches!(owner.start_query(g.clone(), spec("file:."), &facts(&g, &fixtures), profile, check),
            Err(RichSearchError::Invalid(_))));
        assert_eq!(owner.retained_bytes(), 0);
    }
    assert!(matches!(owner.start_query(g.clone(), spec("unknown:needle"), &facts(&g, &fixtures), valid.clone(), check),
        Err(RichSearchError::Compile(_))));
    assert_eq!(owner.retained_bytes(), 0);
    assert!(matches!(owner.start_query(g.clone(), spec("file:."), &[], valid.clone(), check),
        Err(RichSearchError::Invalid(_))));
    assert_eq!(owner.retained_bytes(), 0);
    assert!(matches!(owner.start_query(g.clone(), spec("file:."), &facts(&g, &fixtures), valid.clone(), |_| Err("cancelled")),
        Err(RichSearchError::Host("cancelled"))));
    assert_eq!(owner.retained_bytes(), 0);
    // Syntactically valid lower byte bound still must fit the real envelope.
    let (small_id, small_cursor) = start(&mut owner, &g, &fixtures, "file:.",
        RichPageProfile { bytes: 1024, ..valid.clone() });
    let before_drive = owner.retained_bytes();
    let mut drive = owner.open_drive::<HostError>(&small_cursor).unwrap();
    assert!(owner.retained_bytes() > before_drive);
    assert!(matches!(drive.next_action(check), Err(RichSearchError::Resource(_))));
    assert!(matches!(drive.finish::<HostError>(), Err(RichSearchError::Invalid(_))));
    assert_eq!(owner.retained_bytes(), before_drive, "failed drive released its guard and reservation");
    assert!(owner.close_query(&small_id));
    assert_eq!(owner.retained_bytes(), 0);
    let mut ids = Vec::new();
    for _ in 0..MAX_SEARCH_QUERIES {
        let before = owner.retained_bytes();
        match owner.start_query(g.clone(), spec("file:."), &facts(&g, &fixtures), valid.clone(), check) {
            Ok(id) => {
                let _ = ready(&mut owner, &id);
                ids.push(id);
                assert!(owner.retained_bytes() <= MAX_SEARCH_OWNED_BYTES);
            },
            Err(RichSearchError::Resource(_)) => {
                assert_eq!(owner.retained_bytes(), before);
                break;
            },
            other => panic!("unexpected query admission result: {other:?}"),
        }
    }
    // Four is a ceiling; owned byte reservations may reject admission sooner.
    assert!(!ids.is_empty() && ids.len() <= MAX_SEARCH_QUERIES);
    let before = owner.retained_bytes();
    assert!(matches!(owner.start_query(g.clone(), spec("file:."), &facts(&g, &fixtures), valid.clone(), check),
        Err(RichSearchError::Resource(_))));
    assert_eq!(owner.retained_bytes(), before);
    assert!(owner.close_query(&ids[0]));
    let _ = start(&mut owner, &g, &fixtures, "file:.", valid);
    owner.clear();
    assert_eq!(owner.retained_bytes(), 0);
}

#[test]
fn all_six_sorts_use_captured_facts_and_stable_ties_across_pages() {
    let mut fixtures = vec![Fixture::excluded("z/alpha.md", Exclusion::Binary),
        Fixture::excluded("a/Alpha.md", Exclusion::Binary),
        Fixture::excluded("b/alpha.md", Exclusion::Binary),
        Fixture::excluded("B.md", Exclusion::Binary)];
    for f in &mut fixtures {
        (f.created, f.modified) = match f.path.as_str() {
            "a/Alpha.md" => (Some(0), Some(10)),
            "b/alpha.md" => (Some(0), Some(-1)),
            "z/alpha.md" => (Some(1), None),
            _ => (None, Some(-1)),
        };
    }
    let g = generation(&fixtures);
    for (sort, expected) in [
        (SearchSort::NameAsc, ["a/Alpha.md", "b/alpha.md", "z/alpha.md", "B.md"]),
        (SearchSort::NameDesc, ["B.md", "a/Alpha.md", "b/alpha.md", "z/alpha.md"]),
        (SearchSort::ModifiedAsc, ["b/alpha.md", "B.md", "a/Alpha.md", "z/alpha.md"]),
        (SearchSort::ModifiedDesc, ["a/Alpha.md", "b/alpha.md", "B.md", "z/alpha.md"]),
        (SearchSort::CreatedAsc, ["a/Alpha.md", "b/alpha.md", "z/alpha.md", "B.md"]),
        (SearchSort::CreatedDesc, ["z/alpha.md", "a/Alpha.md", "b/alpha.md", "B.md"]),
    ] {
        let mut owner = owner("sort-owner");
        let mut captured = facts(&g, &fixtures);
        let mut query = spec("file:.");
        query.sort = sort;
        let id = owner.start_query(g.clone(), query, &captured,
            RichPageProfile { chunks: 1, ..Default::default() }, check).unwrap();
        // Mutating the host facts after admission cannot reorder the query.
        for (i, f) in captured.iter_mut().enumerate() {
            f.created_ms = Some(1000 - i as i64);
            f.modified_ms = Some(1000 - i as i64);
        }
        let cursor = ready(&mut owner, &id);
        let pages = collect(&mut owner, cursor, &fixtures, false);
        let paths = pages.iter().flat_map(|p| &p.files).map(|c| c.entry.path.as_str()).collect::<Vec<_>>();
        assert_eq!(paths, expected, "{sort:?}");
        assert_exact(pages.last().unwrap(), 4, 4);
    }
}

#[test]
fn unicode_crlf_locations_and_snippet_slices_stay_in_original_coordinate_spaces() {
    let body = "😀\r\nneedle\r\n";
    let fixtures = [Fixture::text("Unicode.md", body)];
    let g = generation(&fixtures);
    let mut owner = owner("unicode-owner");
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let p = page(&mut owner, &cursor, &fixtures, true).page;
    assert_exact(&p, 1, 1);
    let chunk = &p.files[0];
    assert!(matches!(&chunk.locations[0].locator, SearchLocator::Source { range, .. }
        if range.bytes == [6, 12] && range.utf16 == [4, 10]));
    assert!(!chunk.snippets.is_empty());
    for snippet in &chunk.snippets {
        assert_eq!(snippet.origin, SearchSnippetOrigin::Source);
        let [start, end] = snippet.origin_range.bytes;
        assert_eq!(snippet.text, body[start as usize..end as usize]);
        let utf16 = snippet.text.encode_utf16().collect::<Vec<_>>();
        for highlight in &snippet.highlights {
            let [start, end] = highlight.utf16;
            assert_eq!(String::from_utf16(&utf16[start as usize..end as usize]).unwrap(), "needle");
        }
    }
    unique_locations(&[p]);
}

#[test]
fn progressed_drives_require_a_latched_terminal_boundary_before_finish() {
    let fixtures = [Fixture::text("A.md", "needle"), Fixture::text("B.md", "needle")];
    let g = generation(&fixtures);
    let mut owner = owner("terminal-boundary-owner");
    let (_, initial) = start(&mut owner, &g, &fixtures, "content:needle",
        RichPageProfile { documents: 1, ..Default::default() });

    let mut early = owner.open_drive::<HostError>(&initial).unwrap();
    let read = request(&mut early);
    assert_eq!(read.entry().path.as_str(), "A.md");
    early.accept_text(&read, b"needle", check).unwrap();
    // An accepted row is progress, but only the core chooses the page boundary.
    assert!(matches!(early.finish::<HostError>(), Err(RichSearchError::Invalid(_))));

    let mut drive = owner.open_drive::<HostError>(&initial).unwrap();
    let read = request(&mut drive);
    drive.accept_text(&read, b"needle", check).unwrap();
    assert_eq!(drive.next_action(check).unwrap(), RichSearchAction::Yield);
    assert_eq!(drive.next_action(check).unwrap(), RichSearchAction::Yield);
    let prepared = drive.finish::<HostError>().unwrap();
    let first = owner.commit::<HostError>(prepared).unwrap();
    assert_eq!(first.page.files.len(), 1);
    assert_eq!(first.page.files[0].entry.path.as_str(), "A.md");
    assert!(!first.page.scan_complete);
    let retry = page(&mut owner, &initial, &fixtures, true);
    assert_eq!(serde_json::to_vec(&first.page).unwrap(), serde_json::to_vec(&retry.page).unwrap());
    assert_eq!(first.next, retry.next);

    let mut drive = owner.open_drive::<HostError>(&first.next.unwrap()).unwrap();
    let read = request(&mut drive);
    assert_eq!(read.entry().path.as_str(), "B.md");
    drive.accept_text(&read, b"needle", check).unwrap();
    assert_eq!(drive.next_action(check).unwrap(), RichSearchAction::Done);
    assert_eq!(drive.next_action(check).unwrap(), RichSearchAction::Done);
    let prepared = drive.finish::<HostError>().unwrap();
    let last = owner.commit::<HostError>(prepared).unwrap();
    assert!(last.next.is_none());
    assert_eq!(last.page.files[0].entry.path.as_str(), "B.md");
    assert_exact(&last.page, 2, 2);
}


#[test]
fn repeated_clear_keeps_multiple_stale_drives_charged_until_the_last_handle_drops() {
    let fixtures = [Fixture::text("A.md", "needle")];
    let g = generation(&fixtures);
    let mut owner = owner("stale-pressure-owner");
    // Admit the tiny queries before taking drives: provisional constructor
    // admission and drive admission are independent reservations.
    let mut cursors = Vec::new();
    for _ in 0..2 {
        let (_, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
        cursors.push(cursor);
    }
    let mut stale = cursors.iter().map(|cursor| owner.open_drive::<HostError>(cursor).unwrap())
        .collect::<Vec<_>>();
    let held = owner.retained_bytes();
    assert!(held > 0 && held <= MAX_SEARCH_OWNED_BYTES);
    owner.clear();
    assert_eq!(owner.retained_bytes(), held, "clear cannot erase externally held reservations");

    let mut saw_pressure = false;
    for _ in 0..=MAX_SEARCH_QUERIES {
        let before = owner.retained_bytes();
        match owner.start_query(g.clone(), spec("content:needle"), &facts(&g, &fixtures),
            RichPageProfile::default(), check) {
            Ok(id) => {
                let cursor = ready(&mut owner, &id);
                match owner.open_drive::<HostError>(&cursor) {
                    Ok(drive) => stale.push(drive),
                    Err(RichSearchError::Resource(_)) => {
                        saw_pressure = true;
                        assert!(owner.close_query(&id));
                        assert_eq!(owner.retained_bytes(), before);
                    },
                    _ => panic!("unexpected drive admission result"),
                }
            },
            Err(RichSearchError::Resource(_)) => {
                saw_pressure = true;
                assert_eq!(owner.retained_bytes(), before, "failed admission leaked a reservation");
            },
            other => panic!("unexpected query admission result: {other:?}"),
        }
        let held = owner.retained_bytes();
        assert!(held >= before && held <= MAX_SEARCH_OWNED_BYTES);
        owner.clear();
        assert_eq!(owner.retained_bytes(), held, "repeated clear must use the same reservation ledger");
    }
    assert!(saw_pressure, "retained stale drives must eventually prevent further admission");
    assert!(stale.len() >= 2, "the control must retain multiple independent stale handles");
    let before_drop = owner.retained_bytes();
    drop(stale.pop().unwrap());
    assert!(owner.retained_bytes() > 0 && owner.retained_bytes() < before_drop);
    let still_held = owner.retained_bytes();
    owner.clear();
    assert_eq!(owner.retained_bytes(), still_held);
    drop(stale);
    assert_eq!(owner.retained_bytes(), 0);
    let (_, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    assert_exact(&page(&mut owner, &cursor, &fixtures, true).page, 1, 1);
    owner.clear();
    assert_eq!(owner.retained_bytes(), 0);
}

#[test]
fn successful_empty_value_comparison_has_a_body_free_zero_occurrence_predicate_snippet() {
    let fixtures = [Fixture::text("Empty-value.md", "---\nempty: \"\"\n---\nbody")];
    let g = generation(&fixtures);
    let mut owner = owner("empty-value-predicate-owner");
    let (_, cursor) = start(&mut owner, &g, &fixtures, "[empty:<a]", Default::default());
    let committed = page(&mut owner, &cursor, &fixtures, false);
    assert!(committed.next.is_none());
    let p = committed.page;
    assert_exact(&p, 1, 0);
    assert_eq!(p.work.source_bytes, 0);
    assert_eq!(p.coverage.unavailable_files, 0);
    assert_eq!(p.files.len(), 1);
    let chunk = &p.files[0];
    assert_eq!(chunk.chunk, 0);
    assert!(chunk.last_chunk);
    assert_eq!(chunk.occurrence_count, 0);
    assert_eq!(chunk.locations.len(), 1);
    let location = &chunk.locations[0];
    assert_eq!(location.role, SearchLocationRole::Predicate);
    assert_eq!(location.occurrences, 0);
    assert!(matches!(&location.locator, SearchLocator::PropertyValue {
        key, array_path, value_text, range,
    } if key == "empty" && array_path.is_empty() && value_text.is_empty()
        && range.bytes == [0, 0] && range.utf16 == [0, 0]));
    assert_eq!(chunk.snippets.len(), 1);
    let snippet = &chunk.snippets[0];
    assert_eq!(snippet.origin, SearchSnippetOrigin::PropertyValue);
    assert_eq!(snippet.key.as_deref(), Some("empty"));
    assert_eq!(snippet.text, "");
    assert_eq!(snippet.origin_range.bytes, [0, 0]);
    assert_eq!(snippet.origin_range.utf16, [0, 0]);
    assert_eq!(snippet.primary_location_index, location.index);
    assert!(snippet.highlights.is_empty());
    assert!(!snippet.clipped_before && !snippet.clipped_after);
    unique_locations(&[p]);
}

#[test]
fn start_callback_can_retire_other_queries_and_expire_their_prepared_and_live_drives() {
    let fixtures = [Fixture::text("A.md", "needle")];
    let g = generation(&fixtures);
    let mut owner = owner("start-retirement-owner");
    let (prepared_id, prepared_cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let (drive_id, drive_cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let prepared = prepare_page(&owner, &prepared_cursor, &fixtures, true);
    let mut drive = owner.open_drive::<HostError>(&drive_cursor).unwrap();
    let _ = request(&mut drive);
    let mut callbacks = 0;
    let admitted = owner.start_query(g.clone(), spec("file:."), &facts(&g, &fixtures),
        RichPageProfile::default(), |_| {
            callbacks += 1;
            // These handles carry an atomic lifetime signal; no owner borrow
            // or recursively acquired owner lock is needed in a callback.
            prepared_id.retire();
            drive_id.retire();
            Ok::<(), HostError>(())
        });
    assert!(callbacks > 0);
    // Stale external allocations may prevent this admission even after the
    // callback retires their queries. Both paths must preserve retirement.
    match admitted {
        Ok(id) => { assert!(owner.close_query(&id)); },
        Err(RichSearchError::Resource(_)) => {},
        other => panic!("unexpected callback admission result: {other:?}"),
    }
    assert!(matches!(owner.open_drive::<HostError>(&prepared_cursor), Err(RichSearchError::Expired)));
    assert!(matches!(owner.open_drive::<HostError>(&drive_cursor), Err(RichSearchError::Expired)));
    assert!(matches!(drive.next_action(check), Err(RichSearchError::Expired)));
    assert!(matches!(owner.commit::<HostError>(prepared), Err(RichSearchError::Expired)));
    drop(drive);
    let (_, cursor) = start(&mut owner, &g, &fixtures, "file:.", Default::default());
    assert_exact(&page(&mut owner, &cursor, &fixtures, false).page, 1, 1);
    owner.clear();
    assert_eq!(owner.retained_bytes(), 0);
}

#[test]
fn preparation_callback_retirement_is_pruned_without_query_ids_retaining_owned_state() {
    let fixtures = [Fixture::excluded("A.bin", Exclusion::Binary)];
    let g = generation(&fixtures);
    let mut owner = owner("prepare-retirement-owner");
    let mut ids = Vec::new();
    for _ in 0..MAX_SEARCH_QUERIES {
        match owner.start_query(g.clone(), spec("file:."), &facts(&g, &fixtures),
            RichPageProfile::default(), check) {
            Ok(id) => { let _ = ready(&mut owner, &id); ids.push(id); },
            Err(RichSearchError::Resource(_)) => break,
            other => panic!("unexpected tiny-query admission result: {other:?}"),
        }
    }
    assert!(ids.len() >= 2 && ids.len() <= MAX_SEARCH_QUERIES);
    let mut callbacks = 0;
    let preparation = owner.prepare_query(&ids[0], 1, |_| {
        callbacks += 1;
        for other in &ids[1..] { other.retire(); }
        Ok::<(), HostError>(())
    }).unwrap();
    assert!(callbacks > 0);
    assert!(matches!(preparation, RichPreparation::Ready(_)));
    for retired in &ids[1..] {
        assert!(matches!(owner.prepare_query(retired, 1, check), Err(RichSearchError::Expired)));
    }
    ids[0].retire();
    ids[0].retire();
    assert!(matches!(owner.prepare_query(&ids[0], 1, check), Err(RichSearchError::Expired)));
    assert_eq!(owner.retained_bytes(), 0, "retained query IDs must not retain query-owned allocations");
    let (_, cursor) = start(&mut owner, &g, &fixtures, "file:.", Default::default());
    assert_exact(&page(&mut owner, &cursor, &fixtures, false).page, 1, 1);
    owner.clear();
    assert_eq!(owner.retained_bytes(), 0);
}

#[test]
fn repeated_atomic_retirement_and_pruning_preserve_stale_drive_reservations_until_drop() {
    let fixtures = [Fixture::text("A.md", "needle")];
    let g = generation(&fixtures);
    let mut owner = owner("retirement-ledger-owner");
    let (id, cursor) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    let mut drive = owner.open_drive::<HostError>(&cursor).unwrap();
    let _ = request(&mut drive);
    let held = owner.retained_bytes();
    assert!(held > 0 && held <= MAX_SEARCH_OWNED_BYTES);
    id.retire();
    id.retire();
    // The in-flight drive observes retirement without a subsequent owner call.
    assert!(matches!(drive.next_action(check), Err(RichSearchError::Expired)));
    for _ in 0..3 {
        assert!(matches!(owner.prepare_query(&id, 1, check), Err(RichSearchError::Expired)));
        assert_eq!(owner.retained_bytes(), held);
        assert!(matches!(owner.open_drive::<HostError>(&cursor), Err(RichSearchError::Expired)));
        id.retire();
        owner.clear();
        assert_eq!(owner.retained_bytes(), held, "retire/prune/clear must preserve the shared ledger");
    }
    drop(drive);
    assert_eq!(owner.retained_bytes(), 0);
    // The still-retained ID/cursor can only refer to their expired query.
    assert!(matches!(owner.open_drive::<HostError>(&cursor), Err(RichSearchError::Expired)));
    let (_, fresh) = start(&mut owner, &g, &fixtures, "content:needle", Default::default());
    assert_ne!(fresh, cursor);
    assert_exact(&page(&mut owner, &fresh, &fixtures, true).page, 1, 1);
    owner.clear();
    assert_eq!(owner.retained_bytes(), 0);
}

#[test]
fn dense_four_mib_actual_rich_pages_preserve_all_matches_under_unchanged_limits() {
    const RECORDS: usize = 8192;
    const RECORD_BYTES: usize = 512;
    let limits = SearchLimits::default();
    assert_eq!(limits.work, 2_000_000);
    assert_eq!(limits.spans, 10_000);
    assert_eq!(limits.output_bytes, 1024 * 1024);
    let profile = RichPageProfile::default();
    assert_eq!(profile.chunks, 100);
    assert_eq!(profile.locations_per_chunk, 64);
    assert_eq!(profile.work, 2_000_000);
    assert_eq!(profile.bytes, 1024 * 1024);
    let setup_started = std::time::Instant::now();
    let line = format!("needle {}\n", "x".repeat(504));
    assert_eq!(line.len(), RECORD_BYTES);
    let fixtures = [Fixture::text("Dense.md", line.repeat(RECORDS))];
    let body = fixtures[0].body.as_ref().unwrap().as_bytes();
    assert_eq!(body.len(), 4 * 1024 * 1024);
    let g = generation(&fixtures);
    assert!(g.coverage_complete());
    assert_eq!(g.manifest().entries().len(), 1);
    let entry = &g.manifest().entries()[0];
    let record = g.record(&entry.id).unwrap();
    assert!(record.exclusion().is_none());
    assert_eq!(record.text_bytes(), body.len());
    let setup_ms = setup_started.elapsed().as_millis();
    println!("rich_dense_gate setup_ms={setup_ms} source_bytes={} records={RECORDS} debug_assertions={} single_observation=true performance_claim=false",
        body.len(), cfg!(debug_assertions));

    for query in ["needle", "\"needle\"", "/needle/"] {
        let query_started = std::time::Instant::now();
        let mut pages = 0usize;
        let mut chunks = 0usize;
        let mut source_reads = 0usize;
        let mut source_bytes = 0u64;
        let mut engine_units = 0u64;
        let mut presentation_units = 0u64;
        let mut source_validation_units = 0u64;
        let mut seen = vec![false; RECORDS];
        let mut exhausted = false;
        let mut saw_last_chunk = false;
        let mut owner = owner("dense-gate-owner");
        println!("rich_dense_gate begin query={query:?} setup_ms={setup_ms} defaults=true debug_assertions={} single_observation=true performance_claim=false",
            cfg!(debug_assertions));
        let (_, mut cursor) = start(&mut owner, &g, &fixtures, query, profile.clone());
        macro_rules! fail_dense {
            ($phase:expr, $error:expr, $current:expr) => {{
                let error = $error;
                println!("rich_dense_gate failure query={query:?} phase={} error={error:?} query_ms={} pages={pages} chunks={chunks} source_reads={source_reads} source_bytes={source_bytes} engine_units={engine_units} presentation_units={presentation_units} source_validation_units={source_validation_units} current_breakdown={:?} single_observation=true performance_claim=false",
                    $phase, query_started.elapsed().as_millis(), $current);
                panic!("dense actual-page gate failed for {query:?} during {}: {error:?}", $phase);
            }};
        }
        for _ in 0..=RECORDS {
            let mut drive = match owner.open_drive::<HostError>(&cursor) {
                Ok(drive) => drive,
                Err(error) => fail_dense!("open_drive", error, "not opened"),
            };
            let mut reached_boundary = false;
            for _ in 0..=RECORDS {
                let action = match drive.next_action(check) {
                    Ok(action) => action,
                    Err(error) => fail_dense!("next_action", error, drive.work_breakdown()),
                };
                match action {
                    RichSearchAction::ReadText(request) => {
                        assert_eq!(request.snapshot(), g.id(), "query={query:?}");
                        assert_eq!(request.entry(), entry, "query={query:?}");
                        assert_eq!(request.bytes(), body.len(), "query={query:?}");
                        assert_eq!(request.digest(), record.text_digest().unwrap(), "query={query:?}");
                        source_reads += 1;
                        source_bytes += body.len() as u64;
                        if let Err(error) = drive.accept_text(&request, body, check) {
                            fail_dense!("accept_text", error, drive.work_breakdown());
                        }
                    },
                    RichSearchAction::Yield | RichSearchAction::Done => {
                        reached_boundary = true;
                        break;
                    },
                }
            }
            assert!(reached_boundary, "query={query:?}: drive did not reach its bounded terminal action");
            let breakdown = drive.work_breakdown().clone();
            let prepared = match drive.finish::<HostError>() {
                Ok(prepared) => prepared,
                Err(error) => fail_dense!("finish", error, &breakdown),
            };
            let committed = match owner.commit::<HostError>(prepared) {
                Ok(committed) => committed,
                Err(error) => fail_dense!("commit", error, &breakdown),
            };
            pages += 1;
            engine_units += breakdown.engine_units;
            presentation_units += breakdown.presentation_units;
            source_validation_units += breakdown.source_validation_units;
            let p = committed.page;
            assert_eq!(p.snapshot, *g.id(), "query={query:?}");
            assert_eq!(p.spec.query, query);
            assert!(p.coverage_complete && p.coverage.query_coverage_complete, "query={query:?}");
            assert_eq!(p.coverage.candidate_files, 1);
            assert_eq!(p.coverage.unavailable_files, 0);
            assert_eq!(p.work.units, breakdown.engine_units + breakdown.presentation_units + breakdown.source_validation_units);
            assert!(serde_json::to_vec(&p).unwrap().len() <= MAX_SEARCH_PAGE_BYTES, "query={query:?}");
            for chunk in &p.files {
                assert_eq!(chunk.entry, *entry, "query={query:?}");
                assert_eq!(chunk.chunk as usize, chunks, "query={query:?}");
                assert!(!saw_last_chunk, "query={query:?}: output followed a last chunk");
                chunks += 1;
                saw_last_chunk = chunk.last_chunk;
                assert_eq!(chunk.occurrence_count, RECORDS as u32, "query={query:?}");
                for location in &chunk.locations {
                    let ordinal = location.index as usize;
                    assert!(ordinal < RECORDS, "query={query:?}: unexpected ordinal {ordinal}");
                    assert_eq!(location.role, SearchLocationRole::Occurrence, "query={query:?}");
                    assert_eq!(location.occurrences, 1, "query={query:?} ordinal={ordinal}");
                    let expected = [(RECORD_BYTES * ordinal) as u32, (RECORD_BYTES * ordinal + 6) as u32];
                    assert!(matches!(&location.locator, SearchLocator::Source {
                        range, kind: SearchContentKind::Occurrence,
                    } if range.bytes == expected && range.utf16 == expected),
                        "query={query:?} ordinal={ordinal}: {:?}", location.locator);
                    seen[ordinal] = true;
                }
            }
            match committed.next {
                Some(next) => cursor = next,
                None => {
                    assert_exact(&p, 1, RECORDS as u64);
                    assert_eq!(p.coverage.evaluated_files, 1);
                    exhausted = true;
                },
            }
            // Each old response is dropped here; only its scalar oracle remains.
            drop(p);
            if exhausted { break; }
        }
        println!("rich_dense_gate result query={query:?} setup_ms={setup_ms} query_ms={} pages={pages} chunks={chunks} source_reads={source_reads} source_bytes={source_bytes} engine_units={engine_units} presentation_units={presentation_units} source_validation_units={source_validation_units} delivered_ordinals={} exhausted={exhausted} debug_assertions={} single_observation=true performance_claim=false",
            query_started.elapsed().as_millis(), seen.iter().filter(|seen| **seen).count(), cfg!(debug_assertions));
        assert!(exhausted && saw_last_chunk, "query={query:?}: bounded pagination did not exhaust");
        assert!(seen.iter().all(|seen| *seen), "query={query:?}: at least one of the full 8192 ordinals was omitted");
        owner.clear();
        assert_eq!(owner.retained_bytes(), 0);
    }
}
