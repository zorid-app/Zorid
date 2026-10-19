use super::*;
use serde::Deserialize;
use serde_json::json;
use zorid_index::GenerationSource;
#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    request: Request,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    source: SourceSnapshotId,
    snapshot_id: IndexSnapshotId,
    entries: Vec<EntryState>,
    sources: Vec<GenerationSource>,
    facts: Vec<FilePresentationFacts>,
    configuration: PropertyValue,
    options: QueryOptions,
}
impl Request {
    fn generation(&self) -> Generation {
        Generation::from_sources(
            self.source.clone(),
            self.snapshot_id.clone(),
            self.entries.clone(),
            self.sources.clone(),
        )
        .unwrap()
    }
}
fn cases() -> Vec<Case> {
    serde_json::from_str::<Corpus>(include_str!(
        "../../../tests/fixtures/document-semantics/bases/accepted-generation-queries.json"
    ))
    .unwrap()
    .cases
}
fn first() -> Request {
    cases().remove(0).request
}
fn semantics(mut result: BaseQueryResult) -> BaseQueryResult {
    result.steps_used = 0;
    result
}
#[test]
fn complete_generation_corpus_matches_cold_and_cross_clone_reuse() {
    for case in cases() {
        let r = case.request;
        let generation = r.generation();
        let program = crate::compile_base(r.configuration.clone()).unwrap();
        let expected = semantics(
            crate::query_generation(&program, &generation, &r.facts, &r.options).unwrap(),
        );
        let mut cache = BasePreparationCache::new();
        let cold = cache
            .prepare_generation(&generation, &r.facts, &r.options, 0)
            .unwrap();
        assert_eq!(cold.outcome(), PreparationCacheOutcome::Miss);
        assert_eq!(
            semantics(query_prepared(&program, &cold, &r.options).unwrap()),
            expected
        );
        let warm = cache
            .prepare_generation(&generation.clone(), &r.facts, &r.options, 1)
            .unwrap();
        assert_eq!(warm.outcome(), PreparationCacheOutcome::Hit);
        assert!(Arc::ptr_eq(cold.value(), warm.value()));
        assert_eq!(
            semantics(query_prepared(&program, &warm, &r.options).unwrap()),
            expected
        );
        assert!(warm.work_used() > 0);
    }
}
#[test]
fn full_actual_content_and_exact_fact_slice_prevent_claimed_identity_hits() {
    let mut r = first();
    let original = r.generation();
    let options = r.options.clone();
    let mut cache = BasePreparationCache::new();
    cache
        .prepare_generation(&original, &[], &options, 0)
        .unwrap();
    if let GenerationSource::Text { request, .. } = &mut r.sources[0] {
        request.source = "---\nchanged: 9\n---\n[[C]]\n".into();
    }
    let altered = r.generation();
    assert_eq!(altered.id(), original.id());
    assert_eq!(
        cache
            .prepare_generation(&altered, &[], &options, 1)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    let fact = FilePresentationFacts {
        witness: crate::RecordWitness {
            entry_id: r.entries[0].id.clone(),
            revision: r.entries[0].revision.clone(),
        },
        size: None,
        ctime_ms: None,
        mtime_ms: None,
    };
    assert_eq!(
        cache
            .prepare_generation(&altered, &[fact.clone()], &options, 2)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    let mut sized = fact.clone();
    sized.size = Some(0);
    assert_eq!(
        cache
            .prepare_generation(&altered, &[sized.clone()], &options, 3)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    assert!(cache
        .prepare_generation(&altered, &[sized.clone(), sized], &options, 4)
        .is_err());
    let mut stale = fact;
    stale.witness.revision = crate::Revision::new("wrong").unwrap();
    assert!(cache
        .prepare_generation(&altered, &[stale], &options, 5)
        .is_err());
    r.entries[0].path = zorid_core::VaultPath::new("renamed.md").unwrap();
    assert_eq!(
        cache
            .prepare_generation(&r.generation(), &[], &options, 6)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
}
#[test]
fn scope_epoch_source_and_facts_order_are_part_of_reuse_identity() {
    let r = first();
    let options = r.options.clone();
    let generation = r.generation();
    let facts = r
        .entries
        .iter()
        .map(|e| FilePresentationFacts {
            witness: crate::RecordWitness {
                entry_id: e.id.clone(),
                revision: e.revision.clone(),
            },
            size: None,
            ctime_ms: None,
            mtime_ms: None,
        })
        .collect::<Vec<_>>();
    let mut cache = BasePreparationCache::new();
    cache
        .prepare_generation(&generation, &facts, &options, 0)
        .unwrap();
    let mut reversed = facts.clone();
    reversed.reverse();
    assert_eq!(
        cache
            .prepare_generation(&generation, &reversed, &options, 1)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    for (i, (scope, epoch, watermark)) in [
        ("other", "epoch", "1"),
        ("graph-store", "other", "1"),
        ("graph-store", "graph-epoch", "2"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut changed = r.clone();
        let mut id = serde_json::to_value(&changed.snapshot_id).unwrap();
        id["localStoreId"] = json!(scope);
        id["generationEpoch"] = json!(epoch);
        changed.snapshot_id = serde_json::from_value(id).unwrap();
        changed.source =
            serde_json::from_value(json!({"localStoreId":scope,"watermark":watermark})).unwrap();
        assert_eq!(
            cache
                .prepare_generation(&changed.generation(), &[], &options, 10 + i as u64)
                .unwrap()
                .outcome(),
            PreparationCacheOutcome::Miss
        );
    }
}
#[test]
fn invocation_context_is_fresh_and_cancellation_limits_cannot_hide_on_hit() {
    let r = first();
    let generation = r.generation();
    let mut cache = BasePreparationCache::new();
    let program=cache.compile_source("formulas:\n  selected: this.file.path\n  clock: now()\nviews:\n  - type: table\n    name: One\n    order: [file.path, formula.selected, formula.clock]\n  - type: table\n    name: Two\n    order: [file.path]\n",0).unwrap();
    for (i, entry) in r.entries.iter().enumerate() {
        let mut options = r.options.clone();
        options.current_entry_id = Some(entry.id.clone());
        options.evaluation.clock_ms += i as i64 * 366 * 86400000;
        options.evaluation.timezone = if i % 2 == 0 { "UTC" } else { "America/Toronto" }.into();
        options.view_index = i % 2;
        let lookup = cache
            .prepare_generation(&generation, &[], &options, 1 + i as u64)
            .unwrap();
        let expected =
            crate::query_generation(program.value(), &generation, &[], &options).unwrap();
        assert_eq!(
            semantics(query_prepared(program.value(), &lookup, &options).unwrap()),
            semantics(expected)
        );
    }
    let lookup = cache
        .prepare_generation(&generation, &[], &r.options, 10)
        .unwrap();
    assert_eq!(lookup.outcome(), PreparationCacheOutcome::Hit);
    let mut invalid = r.options.clone();
    invalid.max_steps = 0;
    assert!(cache
        .prepare_generation(&generation, &[], &invalid, 11)
        .is_err());
    assert!(query_prepared(program.value(), &lookup, &invalid).is_err());
    let mut cancellation = r.options.clone();
    let token = crate::OperationCancellation::default();
    token.cancel();
    cancellation.evaluation.cancellation = Some(token);
    assert!(cache
        .prepare_generation(&generation, &[], &cancellation, 12)
        .is_err());
    assert!(query_prepared(program.value(), &lookup, &cancellation).is_err());
    let mut lowered = r.options.clone();
    lowered.max_steps = lookup.work_used().saturating_sub(1);
    assert!(query_prepared(program.value(), &lookup, &lowered).is_err());
}
#[test]
fn exact_compilation_errors_versions_and_arc_mutation_isolation() {
    let mut cache = BasePreparationCache::new();
    let source = "views:\n  - type: table\n    name: Exact\n";
    let first = cache.compile_source(source, 0).unwrap();
    let again = cache.compile_source(source, 1).unwrap();
    assert_eq!(again.outcome(), PreparationCacheOutcome::Hit);
    assert!(Arc::ptr_eq(first.value(), again.value()));
    let mut changed = Arc::clone(first.value());
    Arc::make_mut(&mut changed).configuration = PropertyValue::Null;
    assert_ne!(changed.configuration, again.value().configuration);
    assert_eq!(
        cache
            .compile_source(&format!("{source}# exact bytes\n"), 2)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    cache.programs.back_mut().unwrap().version = "old";
    assert_eq!(
        cache
            .compile_source(&format!("{source}# exact bytes\n"), 3)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    for source in ["views: [", "views: false"] {
        let expected = crate::compile_base_source(source).unwrap_err();
        assert_eq!(cache.compile_source(source, 4).err().unwrap(), expected);
    }
}
#[test]
fn lru_count_expiry_backwards_clock_and_owner_release_are_bounded() {
    let mut cache = BasePreparationCache::new();
    for i in 0..MAX_COMPILED_PROGRAMS + 1 {
        cache
            .compile_source(&format!("title: {i}\n"), i as u64)
            .unwrap();
    }
    assert_eq!(cache.programs.len(), MAX_COMPILED_PROGRAMS);
    assert!(!cache.programs.iter().any(|e| e.source == "title: 0\n"));
    let r = first();
    let mut weak = None;
    for i in 1..=MAX_PREPARED_GENERATIONS + 1 {
        let mut varied = r.clone();
        let mut id = serde_json::to_value(&varied.snapshot_id).unwrap();
        id["generation"] = json!(i.to_string());
        varied.snapshot_id = serde_json::from_value(id).unwrap();
        let lookup = cache
            .prepare_generation(&varied.generation(), &[], &r.options, 100 + i as u64)
            .unwrap();
        if i == 1 {
            weak = Some(Arc::downgrade(lookup.value()));
        }
    }
    assert_eq!(cache.generations.len(), MAX_PREPARED_GENERATIONS);
    assert!(weak.unwrap().upgrade().is_none());
    cache.compile_source("title: 64\n", 200).unwrap();
    assert_eq!(
        cache
            .compile_source("title: 64\n", 200 + PREPARATION_IDLE_MS - 1)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Hit
    );
    assert_eq!(
        cache
            .compile_source("title: 64\n", 200 + 2 * PREPARATION_IDLE_MS)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    assert!(cache.generations.is_empty());
    assert_eq!(
        cache.compile_source("title: 64\n", 0).unwrap().outcome(),
        PreparationCacheOutcome::Miss
    );
    let lookup = cache
        .prepare_generation(&r.generation(), &[], &r.options, 1)
        .unwrap();
    let weak = Arc::downgrade(lookup.value());
    drop(lookup);
    cache.clear();
    assert!(weak.upgrade().is_none());
}
#[test]
fn actual_structure_bytes_evict_before_count_and_supported_large_prep_is_uncached() {
    let mut cache = BasePreparationCache::new();
    let padding = "x".repeat(180_000);
    for i in 0..64 {
        cache
            .compile_source(&format!("unknown: {padding}{i}\n"), i)
            .unwrap();
    }
    assert!(cache.programs.len() < 64);
    assert!(
        cache.programs.iter().map(|e| e.bytes).sum::<usize>()
            + cache.programs.capacity() * size_of::<ProgramEntry>()
            + size_of::<BasePreparationCache>()
            <= MAX_COMPILED_PROGRAM_BYTES
    );
    let mut r = first();
    r.entries.clear();
    r.sources.clear();
    let wide = "x".repeat(250_000);
    let source =
        format!("---\nanchor: &v {wide}\nwide: [*v, *v, *v, *v, *v, *v, *v, *v, *v, *v]\n---\n");
    for i in 0..7 {
        let entry = EntryState {
            id: crate::EntryId::new(format!("large-{i}")).unwrap(),
            path: zorid_core::VaultPath::new(format!("large-{i}.md")).unwrap(),
            kind: zorid_core::EntryKind::File,
            revision: crate::Revision::new("r1").unwrap(),
            deleted: false,
        };
        r.sources.push(GenerationSource::Text {
            request: zorid_document::MetadataRequest {
                entry_id: entry.id.clone(),
                content_revision: entry.revision.clone(),
                source: source.clone(),
            },
            markdown: true,
        });
        r.entries.push(entry);
    }
    let generation = r.generation();
    let large = cache
        .prepare_generation(&generation, &[], &r.options, 1000)
        .unwrap();
    assert_eq!(large.outcome(), PreparationCacheOutcome::Uncached);
    assert!(cache.generations.is_empty());
    let program = crate::compile_base_source(
        "filters: file.path == \"large-0.md\"\nviews:\n  - type: table\n    name: Table\n    order: [file.path]\n",
    )
    .unwrap();
    assert_eq!(
        query_prepared(&program, &large, &r.options)
            .unwrap()
            .rows
            .len(),
        1
    );
}

#[test]
fn sealed_snapshot_byte_credit_is_exact_and_never_reserializes_static_data() {
    struct NoStaticSerialization;
    impl serde::Serialize for NoStaticSerialization {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            panic!("sealed request validation serialized the immutable snapshot")
        }
    }
    let r = first();
    let mut cache = BasePreparationCache::new();
    let lookup = cache
        .prepare_generation(&r.generation(), &r.facts, &r.options, 0)
        .unwrap();
    let bytes = lookup.value.query.snapshot_bytes.unwrap();
    let snapshot = &lookup.value.snapshot;
    for current in [None, Some(snapshot.records[0].clone())] {
        let mut options = r.options.clone();
        options.evaluation.current_record = current;
        options.search_terms = vec!["UTF8 é 🐋 \" \\ ".into()];
        let exact =
            crate::encoded_size(&(snapshot, &options), crate::MAX_BASE_REQUEST_BYTES).unwrap();
        assert_eq!(
            query::request_size(&NoStaticSerialization, &options, Some(bytes)).unwrap(),
            exact
        );
        assert_eq!(
            query::request_size(snapshot, &options, None).unwrap(),
            exact
        );
        assert!(query::request_size(
            &NoStaticSerialization,
            &options,
            Some(crate::MAX_BASE_REQUEST_BYTES)
        )
        .is_err());
    }
}

#[test]
fn optional_probe_copy_and_expensive_hit_preserve_tight_cold_budget() {
    let r = first();
    let generation = r.generation();
    let program = crate::compile_base(r.configuration.clone()).unwrap();
    let expected = crate::query_generation(&program, &generation, &r.facts, &r.options).unwrap();
    let mut tight = r.options.clone();
    tight.max_steps = expected.steps_used;
    assert_eq!(
        semantics(crate::query_generation(&program, &generation, &r.facts, &tight).unwrap()),
        semantics(expected.clone())
    );
    let mut cache = BasePreparationCache::new();
    let cold = cache
        .prepare_generation(&generation, &r.facts, &tight, 0)
        .unwrap();
    assert_eq!(cold.outcome(), PreparationCacheOutcome::Miss);
    assert!(cold.cache_work_used() > cold.work_used());
    assert_eq!(
        semantics(query_prepared(&program, &cold, &tight).unwrap()),
        semantics(expected.clone())
    );
    // Same claimed generation ID with different real metadata forces a deep
    // failed probe, then a cold preparation under exactly the original budget.
    let mut other = r.clone();
    if let GenerationSource::Text { request, .. } = &mut other.sources[0] {
        request.source.push_str("\nchanged #cache-mismatch");
    }
    let mut foreign = BasePreparationCache::new();
    foreign
        .prepare_generation(&other.generation(), &r.facts, &r.options, 0)
        .unwrap();
    let failed_probe = foreign
        .prepare_generation(&generation, &r.facts, &tight, 1)
        .unwrap();
    assert_eq!(failed_probe.outcome(), PreparationCacheOutcome::Miss);
    assert_eq!(
        semantics(query_prepared(&program, &failed_probe, &tight).unwrap()),
        semantics(expected.clone())
    );
    assert!(failed_probe.cache_work_used() > cold.cache_work_used());
    // Even an exact match must bypass optional reuse if checking its saved
    // proof would cost more than the sealed factory's exact cold preparation.
    let entry = cache.generations.back_mut().unwrap();
    entry.proof.compare_work = entry.value.cold_work.saturating_add(1);
    let expensive = cache
        .prepare_generation(&generation, &r.facts, &tight, 2)
        .unwrap();
    assert_eq!(expensive.outcome(), PreparationCacheOutcome::Miss);
    assert_eq!(
        semantics(query_prepared(&program, &expensive, &tight).unwrap()),
        semantics(expected)
    );
}

#[test]
fn optional_allowance_overflow_and_incomplete_copy_decline_without_retaining() {
    let r = first();
    let generation = r.generation();
    let mut maintenance = Maintenance::new(Some(&r.options));
    assert!(GenerationProof::new(&generation, &r.facts, &mut maintenance, 0).is_none());
    assert!(maintenance.used <= MAX_PREPARATION_CACHE_WORK);
    let mut exhausted = Maintenance::new(Some(&r.options));
    exhausted.used = MAX_PREPARATION_CACHE_WORK;
    assert!(GenerationProof::new(
        &generation,
        &r.facts,
        &mut exhausted,
        MAX_PREPARED_GENERATION_BYTES
    )
    .is_none());
    assert_eq!(exhausted.used, MAX_PREPARATION_CACHE_WORK);
    assert!(costs([usize::MAX, 1]).is_none());
    assert!(slots::<u64>(usize::MAX, &mut Maintenance::new(None)).is_none());
}
