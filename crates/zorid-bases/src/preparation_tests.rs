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
    .into_iter()
    .map(|mut case| {
        let id = &case.request.snapshot_id;
        let versions = zorid_index::SemanticVersions::new(
            id.versions().schema(),
            zorid_index::document_extraction_version(),
            id.versions().resolver(),
            id.versions().query(),
        )
        .unwrap();
        case.request.snapshot_id = IndexSnapshotId::new(
            id.local_store_id().clone(),
            id.generation_epoch().clone(),
            id.generation(),
            versions,
        )
        .unwrap();
        case
    })
    .collect()
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
    let expected = crate::query_generation(&program, &generation, &[], &r.options).unwrap();
    assert_eq!(expected.rows.len(), 1);
    assert_eq!(
        semantics(query_prepared(&program, &large, &r.options).unwrap()),
        semantics(expected.clone())
    );
    let mut tight = r.options.clone();
    tight.max_steps = expected.steps_used;
    let uncached = BasePreparationCache::new()
        .prepare_generation(&generation, &[], &tight, 0)
        .unwrap();
    assert_eq!(uncached.outcome(), PreparationCacheOutcome::Uncached);
    let actual = query_prepared(&program, &uncached, &tight).unwrap();
    assert_eq!(actual.steps_used, expected.steps_used);
    assert_eq!(semantics(actual), semantics(expected));
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
    assert!(GenerationProof::new(
        &generation,
        &r.facts,
        generation.records().count(),
        &mut maintenance,
        0
    )
    .is_none());
    assert!(maintenance.used <= MAX_PREPARATION_CACHE_WORK);
    let mut exhausted = Maintenance::new(Some(&r.options));
    exhausted.used = MAX_PREPARATION_CACHE_WORK;
    assert!(GenerationProof::new(
        &generation,
        &r.facts,
        generation.records().count(),
        &mut exhausted,
        MAX_PREPARED_GENERATION_BYTES
    )
    .is_none());
    assert_eq!(exhausted.used, MAX_PREPARATION_CACHE_WORK);
    assert!(costs([usize::MAX, 1]).is_none());
    assert!(slots::<u64>(usize::MAX, &mut Maintenance::new(None)).is_none());
}

const STATIC_ANSWER_BASE: &str =
    "views:\n  - type: table\n    name: Table\n    order: [file.name]\n";
fn answer_inputs(
    cache: &mut BasePreparationCache,
    r: &Request,
    source: &str,
    now: u64,
) -> (
    PreparationLookup<Arc<BaseProgram>>,
    PreparationLookup<Arc<PreparedBaseGeneration>>,
) {
    (
        cache.compile_source(source, now).unwrap(),
        cache
            .prepare_generation(&r.generation(), &r.facts, &r.options, now)
            .unwrap(),
    )
}
#[test]
fn answers_cross_fresh_lookups_and_valid_clocks_without_evaluator_sessions() {
    let r = first();
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    let expected = semantics(query_prepared(program.value(), &prepared, &r.options).unwrap());
    let seed = cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    assert_eq!(seed.outcome(), PreparationCacheOutcome::Miss);
    assert_eq!(semantics(seed.into_value()), expected);
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 1);
    let before = crate::expression::session_starts();
    let mut options = r.options.clone();
    options.evaluation.clock_ms = 1_729_382_400_000;
    let hit = cache
        .query_prepared_cached(&program, &prepared, &options, 1)
        .unwrap();
    assert_eq!(hit.outcome(), PreparationCacheOutcome::Hit);
    assert_eq!(
        crate::expression::session_starts(),
        before,
        "a genuine answer hit cannot recreate evaluator sessions"
    );
    assert_eq!(semantics(hit.value().clone()), expected);
    assert!(hit.work_used() >= prepared.work_used());
    assert_eq!(hit.value().steps_used, hit.work_used());
    assert!(hit.cache_work_used() > prepared.cache_work_used());
    assert!(hit.cache_work_used() <= MAX_PREPARATION_CACHE_WORK);
}
#[test]
fn answer_clock_proof_is_exhaustive_and_calls_use_exact_clock() {
    assert!(answer_clock_representable(0));
    assert!(answer_clock_representable(
        chrono::DateTime::parse_from_rfc3339("9999-12-31T00:00:00Z")
            .unwrap()
            .timestamp_millis()
    ));
    for clock in [
        i64::MIN,
        i64::MAX,
        chrono::DateTime::<chrono::Utc>::MIN_UTC.timestamp_millis(),
        chrono::DateTime::<chrono::Utc>::MAX_UTC.timestamp_millis(),
    ] {
        assert!(!answer_clock_representable(clock));
    }
    for source in [
        "true",
        "-note.priority + 2 * 3",
        "[note.x, note['y']]",
        "note['now()']",
        "/now\\(\\)/",
    ] {
        assert!(
            crate::expression::clock_independent(source, &mut |_| Some(())),
            "{source}"
        );
    }
    for source in [
        "now()",
        "today()",
        "note.day.relative()",
        "formula['clock']()",
        "(note.x",
        "unknown()",
    ] {
        assert!(
            !crate::expression::clock_independent(source, &mut |_| Some(())),
            "{source}"
        );
    }
    let r = first();
    let mut cache = BasePreparationCache::new();
    let source = "formulas:\n  hidden: now()\n  displayed: formula.hidden\nviews:\n  - type: table\n    name: Table\n    order: [formula.displayed]\n";
    let (program, prepared) = answer_inputs(&mut cache, &r, source, 0);
    let seed = cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    assert_eq!(seed.outcome(), PreparationCacheOutcome::Miss);
    assert!(!cache.answers.back().unwrap().clock_independent);
    let before = crate::expression::session_starts();
    let same = cache
        .query_prepared_cached(&program, &prepared, &r.options, 1)
        .unwrap();
    assert_eq!(same.outcome(), PreparationCacheOutcome::Hit);
    assert_eq!(crate::expression::session_starts(), before);
    for clock in [1, 86_400_000, 1_710_054_000_000, 1_730_613_600_000] {
        let mut options = r.options.clone();
        options.evaluation.clock_ms = clock;
        options.evaluation.timezone = "America/Toronto".into();
        let expected = semantics(query_prepared(program.value(), &prepared, &options).unwrap());
        let miss = cache
            .query_prepared_cached(&program, &prepared, &options, 2)
            .unwrap();
        assert_ne!(miss.outcome(), PreparationCacheOutcome::Hit);
        assert_eq!(semantics(miss.into_value()), expected);
    }
    for source in [
        "filters: now() != null\n",
        "views:\n  - type: table\n    name: Table\n    filters: today() != null\n",
    ] {
        let program = crate::compile_base_source(source).unwrap();
        assert!(!program::clock_independent(&program, &mut |_| Some(())));
    }
}
#[test]
fn answer_owner_clear_expiry_eviction_and_retired_lookup_tokens_never_alias() {
    let r = first();
    let mut cache = BasePreparationCache::new();
    let (old_program, old_prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    assert_eq!(
        cache
            .query_prepared_cached(&old_program, &old_prepared, &r.options, 0)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    let mut foreign = BasePreparationCache::new();
    assert_eq!(
        foreign
            .query_prepared_cached(&old_program, &old_prepared, &r.options, 0)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Uncached
    );
    assert!(foreign.answers.is_empty());
    cache.clear();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 1);
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &r.options, 1)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    assert_eq!(
        cache
            .query_prepared_cached(&old_program, &old_prepared, &r.options, 2)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Uncached
    );
    for n in 0..MAX_COMPILED_PROGRAMS {
        cache.compile_source(&format!("title: {n}\n"), 3).unwrap();
    }
    assert!(cache.answers.is_empty());
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &r.options, 3)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Uncached
    );
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 4);
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 4)
        .unwrap();
    for n in 0..MAX_PREPARED_GENERATIONS {
        let mut next = r.clone();
        next.snapshot_id = IndexSnapshotId::new(
            next.snapshot_id.local_store_id().clone(),
            next.snapshot_id.generation_epoch().clone(),
            100 + n as u64,
            next.snapshot_id.versions().clone(),
        )
        .unwrap();
        cache
            .prepare_generation(&next.generation(), &next.facts, &next.options, 5)
            .unwrap();
    }
    assert!(cache.answers.is_empty());
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &r.options, 5)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Uncached
    );
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 10);
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 10)
        .unwrap();
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &r.options, 10 + PREPARATION_IDLE_MS)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Uncached
    );
    let (program, prepared) =
        answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 20 + PREPARATION_IDLE_MS);
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 20 + PREPARATION_IDLE_MS)
        .unwrap();
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &r.options, 0)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Uncached
    );
}
#[test]
fn answer_all_options_are_exact_and_invalid_current_context_still_rejects() {
    let r = first();
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    let mut cases = Vec::new();
    macro_rules! changed {
        ($field:ident,$value:expr) => {{
            let mut o = r.options.clone();
            o.$field = $value;
            cases.push(o);
        }};
    }
    changed!(max_steps, r.options.max_steps - 1);
    changed!(max_scanned, r.options.max_scanned - 1);
    changed!(max_rows, r.options.max_rows - 1);
    changed!(max_groups, r.options.max_groups - 1);
    changed!(max_output_bytes, r.options.max_output_bytes - 1);
    changed!(search_terms, vec!["A".into()]);
    changed!(search_terms, vec!["B".into(), "A".into()]);
    changed!(search_terms, vec!["A".into(), "B".into()]);
    changed!(ignore_paths, vec!["none".into(), "other".into()]);
    changed!(ignore_paths, vec!["other".into(), "none".into()]);
    changed!(current_entry_id, Some(r.entries[0].id.clone()));
    let mut o = r.options.clone();
    o.evaluation.max_steps -= 1;
    cases.push(o);
    let mut o = r.options.clone();
    o.evaluation.timezone = "+01:00".into();
    cases.push(o);
    let mut o = r.options.clone();
    o.evaluation.formulas = vec![("unused".into(), "1 + 2".into())];
    cases.push(o);
    let mut o = r.options.clone();
    o.evaluation.current_record = Some(prepared.value.snapshot.records[0].clone());
    cases.push(o);
    for (n, o) in cases.into_iter().enumerate() {
        let expected = query_prepared(program.value(), &prepared, &o).map(semantics);
        let answer = cache
            .query_prepared_cached(&program, &prepared, &o, 1 + n as u64)
            .unwrap();
        assert_ne!(answer.outcome(), PreparationCacheOutcome::Hit);
        assert_eq!(Ok(semantics(answer.into_value())), expected);
    }
    let mut invalid = r.options.clone();
    invalid.current_entry_id = Some(crate::EntryId::new("absent").unwrap());
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &invalid, 100)
            .err(),
        query_prepared(program.value(), &prepared, &invalid).err()
    );
    invalid = r.options.clone();
    invalid.evaluation.current_record = Some(prepared.value.snapshot.records[0].clone());
    invalid.evaluation.current_record.as_mut().unwrap().path = "wrong.md".into();
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &invalid, 101)
            .err(),
        query_prepared(program.value(), &prepared, &invalid).err()
    );
    invalid = r.options.clone();
    invalid.view_index = 999;
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &invalid, 102)
            .err(),
        query_prepared(program.value(), &prepared, &invalid).err()
    );
    invalid = r.options.clone();
    invalid.evaluation.cancellation = Some(crate::OperationCancellation::default());
    invalid.evaluation.cancellation.as_ref().unwrap().cancel();
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &invalid, 103)
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
}
#[test]
fn answer_tight_budget_failed_probes_and_exhausted_maintenance_fall_back_once() {
    let r = first();
    let mut cache = BasePreparationCache::new();
    let (program, mut prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    let cold = query_prepared(program.value(), &prepared, &r.options).unwrap();
    let mut tight = r.options.clone();
    tight.max_steps = cold.steps_used;
    let expected = semantics(query_prepared(program.value(), &prepared, &tight).unwrap());
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    let result = cache
        .query_prepared_cached(&program, &prepared, &tight, 1)
        .unwrap();
    assert_eq!(semantics(result.into_value()), expected);
    let mut invalid = tight.clone();
    invalid.max_steps = prepared.work_used();
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &invalid, 2)
            .err(),
        query_prepared(program.value(), &prepared, &invalid).err()
    );
    prepared.cache_work = MAX_PREPARATION_CACHE_WORK;
    let before = crate::expression::session_starts();
    let result = cache
        .query_prepared_cached(&program, &prepared, &tight, 3)
        .unwrap();
    assert_eq!(result.outcome(), PreparationCacheOutcome::Uncached);
    assert_eq!(semantics(result.into_value()), expected);
    assert!(crate::expression::session_starts() > before);
    assert_eq!(
        cache
            .answers
            .iter()
            .filter(|a| a.options.max_steps == tight.max_steps)
            .count(),
        1
    );
}

#[test]
fn answer_invalid_time_errors_and_incomplete_or_diagnostic_results_are_uncached() {
    let r = first();
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    for (clock, timezone) in [(i64::MAX, "UTC"), (0, "local"), (0, "invalid/timezone")] {
        let mut options = r.options.clone();
        options.evaluation.clock_ms = clock;
        options.evaluation.timezone = timezone.into();
        assert_eq!(
            cache
                .query_prepared_cached(&program, &prepared, &options, 1)
                .err(),
            query_prepared(program.value(), &prepared, &options).err()
        );
        options.ignore_paths = r.entries.iter().map(|e| e.path.as_str().into()).collect();
        let expected = semantics(query_prepared(program.value(), &prepared, &options).unwrap());
        let result = cache
            .query_prepared_cached(&program, &prepared, &options, 2)
            .unwrap();
        assert_eq!(result.outcome(), PreparationCacheOutcome::Uncached);
        assert_eq!(semantics(result.into_value()), expected);
    }
    let source = "formulas:\n  broken: unknown()\nviews:\n  - type: table\n    name: Table\n    order: [formula.broken]\n";
    let (program, prepared) = answer_inputs(&mut cache, &r, source, 3);
    let result = cache
        .query_prepared_cached(&program, &prepared, &r.options, 3)
        .unwrap();
    assert!(!result.value().diagnostics.is_empty());
    assert_eq!(result.outcome(), PreparationCacheOutcome::Uncached);
    let before = crate::expression::session_starts();
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 4)
        .unwrap();
    assert!(crate::expression::session_starts() > before);
    let mut excluded = r.clone();
    excluded.sources[0] = GenerationSource::Excluded {
        entry_id: excluded.entries[0].id.clone(),
        content_revision: excluded.entries[0].revision.clone(),
        reason: zorid_index::Exclusion::Unreadable,
    };
    let (program, prepared) = answer_inputs(&mut cache, &excluded, STATIC_ANSWER_BASE, 5);
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &excluded.options, 5)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Uncached
    );
}
#[test]
fn answer_entry_and_owner_byte_caps_lru_and_declined_large_key_are_real() {
    let r = first();
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    for n in 0..MAX_PREPARED_ANSWERS + 1 {
        let mut options = r.options.clone();
        options.ignore_paths = vec![format!("absent-{n}")];
        assert_eq!(
            cache
                .query_prepared_cached(&program, &prepared, &options, 1)
                .unwrap()
                .outcome(),
            PreparationCacheOutcome::Miss
        );
    }
    assert_eq!(cache.answers.len(), MAX_PREPARED_ANSWERS);
    assert!(!cache
        .answers
        .iter()
        .any(|a| a.options.ignore_paths == ["absent-0"]));
    let mut large = r.options.clone();
    large.ignore_paths = vec!["x".repeat(MAX_PREPARED_ANSWER_ENTRY_BYTES)];
    let expected = semantics(query_prepared(program.value(), &prepared, &large).unwrap());
    let before = cache.answers.len();
    let result = cache
        .query_prepared_cached(&program, &prepared, &large, 2)
        .unwrap();
    assert_eq!(result.outcome(), PreparationCacheOutcome::Uncached);
    assert_eq!(semantics(result.into_value()), expected);
    assert_eq!(cache.answers.len(), before);
    let mut expression = String::from("1");
    for _ in 0..11 {
        expression = format!("({expression} + {expression})");
    }
    let source = format!(
        "formulas:\n  balanced: '{expression}'\nviews:\n  - type: table\n    name: Table\n    order: [formula.balanced]\n"
    );
    let program = cache.compile_source(&source, 3).unwrap();
    cache.answers.clear();
    let padding = "q".repeat(600_000);
    for n in 0..MAX_PREPARED_ANSWERS {
        let mut options = r.options.clone();
        let suffix = n.to_string();
        let mut key = String::with_capacity(padding.len() + suffix.len());
        key.push_str(&padding);
        key.push_str(&suffix);
        assert_eq!(key.capacity(), key.len());
        options.ignore_paths = vec![key];
        let answer = cache
            .query_prepared_cached(&program, &prepared, &options, 3)
            .unwrap();
        assert_eq!(
            answer.outcome(),
            PreparationCacheOutcome::Miss,
            "seed={n}, semantic={}, optional={}, diagnostics={:?}",
            answer.work_used(),
            answer.cache_work_used(),
            answer.value().diagnostics
        );
    }
    assert!(cache.answers.len() < MAX_PREPARED_ANSWERS);
    assert!(cache
        .answers
        .iter()
        .all(|a| a.bytes <= MAX_PREPARED_ANSWER_ENTRY_BYTES));
    assert!(
        cache.answers.iter().map(|a| a.bytes).sum::<usize>()
            + size_of::<BasePreparationCache>()
            + cache.answers.capacity() * size_of::<AnswerEntry>()
            + TOKEN_BYTES
            <= MAX_PREPARED_ANSWER_BYTES
    );
}
#[test]
fn answer_oversized_valid_output_runs_without_retention() {
    let mut r = first();
    let padding = "p".repeat(600_000);
    for source in r.sources.iter_mut().take(2) {
        if let GenerationSource::Text { request, .. } = source {
            request.source = format!("---\npad: {padding}\n---\n");
        }
    }
    let mut cache = BasePreparationCache::new();
    let source = "views:\n  - type: table\n    name: Table\n    order: [note.pad]\n";
    let (program, prepared) = answer_inputs(&mut cache, &r, source, 0);
    let expected = semantics(query_prepared(program.value(), &prepared, &r.options).unwrap());
    let result = cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    assert_eq!(result.outcome(), PreparationCacheOutcome::Uncached);
    assert_eq!(semantics(result.into_value()), expected);
    assert!(cache.answers.is_empty());
}
#[test]
fn answer_dynamic_key_preserves_numeric_bits_and_view_context() {
    let mut a = QueryOptions::default();
    let mut b = a.clone();
    let mut record = DetachedRecord::default();
    record.properties.push((
        "signed".into(),
        PropertyValue::Number(serde_json::Number::from_f64(-0.0).unwrap()),
    ));
    a.evaluation.current_record = Some(record.clone());
    record.properties[0].1 = PropertyValue::Number(serde_json::Number::from_f64(0.0).unwrap());
    b.evaluation.current_record = Some(record);
    assert!(!options_exact(&a, &b, true));
    b.evaluation.current_record.as_mut().unwrap().properties[0].1 =
        PropertyValue::Number(serde_json::Number::from(0));
    assert!(!options_exact(&a, &b, true));
    // Exercise the real answer path too: detached canonical equality preserves
    // existing Number equality, while an exact answer key must not merge signs.
    let mut numeric = first();
    if let GenerationSource::Text { request, .. } = &mut numeric.sources[0] {
        request.source = "---\nsigned: -0.0\n---\n".into();
    }
    let mut cache = BasePreparationCache::new();
    let source = "formulas:\n  signed: 'this.signed + \"\"'\nviews:\n  - type: table\n    name: Table\n    order: [formula.signed]\n";
    let (program, prepared) = answer_inputs(&mut cache, &numeric, source, 0);
    let mut negative = numeric.options.clone();
    negative.evaluation.current_record = Some(
        prepared
            .value
            .snapshot
            .records
            .iter()
            .find(|r| r.witness.as_ref().unwrap().entry_id == numeric.entries[0].id)
            .unwrap()
            .clone(),
    );
    let seed = cache
        .query_prepared_cached(&program, &prepared, &negative, 0)
        .unwrap();
    assert_eq!(seed.outcome(), PreparationCacheOutcome::Miss);
    let mut positive = negative.clone();
    positive
        .evaluation
        .current_record
        .as_mut()
        .unwrap()
        .properties[0]
        .1 = PropertyValue::Number(serde_json::Number::from_f64(0.0).unwrap());
    let expected = semantics(query_prepared(program.value(), &prepared, &positive).unwrap());
    assert_ne!(semantics(seed.into_value()), expected);
    let changed = cache
        .query_prepared_cached(&program, &prepared, &positive, 1)
        .unwrap();
    assert_eq!(changed.outcome(), PreparationCacheOutcome::Miss);
    assert_eq!(semantics(changed.into_value()), expected);
    let r = first();
    let source = "views:\n  - type: table\n    name: Names\n    order: [file.name]\n  - type: table\n    name: Paths\n    order: [file.path]\n";
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, source, 0);
    cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    let mut options = r.options.clone();
    options.view_index = 1;
    let expected = semantics(query_prepared(program.value(), &prepared, &options).unwrap());
    let result = cache
        .query_prepared_cached(&program, &prepared, &options, 1)
        .unwrap();
    assert_eq!(result.outcome(), PreparationCacheOutcome::Miss);
    assert_eq!(semantics(result.into_value()), expected);
}
#[test]
fn same_claimed_generation_and_digest_with_changed_numeric_bits_misses_preparation() {
    let mut r = first();
    for source in &mut r.sources {
        if let GenerationSource::Text { request, .. } = source {
            request.source = "---\nsigned: -0.0\n---\n".into();
        }
    }
    let negative = r.generation();
    let fence =
        zorid_index::PublicationFence::new(r.source.clone(), None, r.snapshot_id.clone()).unwrap();
    let mut builder =
        zorid_index::GenerationBuilder::new(negative.manifest().clone(), fence).unwrap();
    for record in negative.records() {
        let mut metadata = record.metadata().cloned().unwrap();
        metadata.properties[0].value =
            PropertyValue::Number(serde_json::Number::from_f64(0.0).unwrap());
        builder
            .add(
                IndexRecord::from_persisted(
                    record.witness().clone(),
                    Some(metadata),
                    record.text_digest().copied(),
                    record.text_bytes(),
                    record.exclusion().cloned(),
                )
                .unwrap(),
            )
            .unwrap();
    }
    let positive = builder.finish().unwrap().generation().clone();
    assert_eq!(negative.id(), positive.id());
    assert_eq!(
        negative.records().next().unwrap().text_digest(),
        positive.records().next().unwrap().text_digest()
    );
    let mut cache = BasePreparationCache::new();
    let initial = cache
        .prepare_generation(&negative, &r.facts, &r.options, 0)
        .unwrap();
    assert_eq!(initial.outcome(), PreparationCacheOutcome::Miss);
    let changed = cache
        .prepare_generation(&positive, &r.facts, &r.options, 1)
        .unwrap();
    assert_eq!(changed.outcome(), PreparationCacheOutcome::Miss);
    assert!(!Arc::ptr_eq(initial.value(), changed.value()));
    let source = "views:\n  - type: table\n    name: Table\n    order: [note.signed]\n";
    let program = crate::compile_base_source(source).unwrap();
    assert_eq!(
        semantics(query_prepared(&program, &changed, &r.options).unwrap()),
        semantics(crate::query_generation(&program, &positive, &r.facts, &r.options).unwrap())
    );
}

#[test]
fn schema2_structure_cost_and_exact_facts_remain_part_of_preparation_proof() {
    let mut r = first();
    if let GenerationSource::Text { request, .. } = &mut r.sources[0] {
        request.source = "- [x] task\n- plain item\n\nparagraph\n".into();
    }
    let original = r.generation();
    let selected = original
        .records()
        .find(|record| record.witness().entry().id == r.entries[0].id)
        .unwrap();
    let metadata = selected.metadata().unwrap();
    assert!(!metadata.blocks.is_empty());
    assert!(!metadata.list_items.is_empty());
    assert!(!metadata.tasks.is_empty());
    let original_cost = record_heap(selected, &mut Maintenance::new(Some(&r.options))).unwrap();
    let mut empty = metadata.clone();
    empty.blocks = Vec::new();
    empty.list_items = Vec::new();
    empty.tasks = Vec::new();
    let empty = IndexRecord::from_persisted(
        selected.witness().clone(),
        Some(empty),
        selected.text_digest().copied(),
        selected.text_bytes(),
        selected.exclusion().cloned(),
    )
    .unwrap();
    let empty_cost = record_heap(&empty, &mut Maintenance::new(Some(&r.options))).unwrap();
    assert!(
        original_cost - empty_cost
            >= metadata.blocks.capacity() * size_of::<zorid_document::MarkdownBlock>()
                + metadata.list_items.capacity() * size_of::<zorid_document::ListItem>()
                + metadata
                    .list_items
                    .iter()
                    .map(|i| i.task_status.as_ref().map_or(0, String::capacity))
                    .sum::<usize>()
    );
    let rebuild = |change: usize| {
        let fence =
            zorid_index::PublicationFence::new(r.source.clone(), None, r.snapshot_id.clone())
                .unwrap();
        let mut builder =
            zorid_index::GenerationBuilder::new(original.manifest().clone(), fence).unwrap();
        for record in original.records() {
            let mut metadata = record.metadata().cloned().unwrap();
            if record.witness().entry().id == r.entries[0].id {
                if change == 0 {
                    metadata.blocks[0].kind = zorid_document::BlockKind::Html;
                } else {
                    let item = metadata
                        .list_items
                        .iter_mut()
                        .find(|i| i.task_status.is_none())
                        .unwrap();
                    item.range.bytes[1] -= 1;
                    item.range.utf16[1] -= 1;
                }
            }
            builder
                .add(
                    IndexRecord::from_persisted(
                        record.witness().clone(),
                        Some(metadata),
                        record.text_digest().copied(),
                        record.text_bytes(),
                        record.exclusion().cloned(),
                    )
                    .unwrap(),
                )
                .unwrap();
        }
        builder.finish().unwrap().generation().clone()
    };
    for change in 0..2 {
        let changed = rebuild(change);
        let mut cache = BasePreparationCache::new();
        cache
            .prepare_generation(&original, &r.facts, &r.options, 0)
            .unwrap();
        assert_eq!(
            cache
                .prepare_generation(&changed, &r.facts, &r.options, 1)
                .unwrap()
                .outcome(),
            PreparationCacheOutcome::Miss
        );
    }
}

#[test]
fn no_call_duration_sort_is_exact_clock_even_when_limit_removes_all_cells() {
    let mut r = first();
    r.facts = r
        .entries
        .iter()
        .map(|entry| FilePresentationFacts {
            witness: crate::RecordWitness {
                entry_id: entry.id.clone(),
                revision: entry.revision.clone(),
            },
            size: None,
            ctime_ms: Some(0),
            mtime_ms: Some(86_400_000),
        })
        .collect();
    // Literal zero means unlimited; a positive fractional limit is admitted
    // and truncated to zero by the existing compiler.
    for limit in ["", "    limit: 0.5\n"] {
        let source = format!(
            "formulas:\n  elapsed: (file.mtime - file.ctime) * 93075000\nviews:\n  - type: table\n    name: Table\n    order: [formula.elapsed]\n    sort:\n      - property: formula.elapsed\n        direction: ASC\n{limit}"
        );
        let mut cache = BasePreparationCache::new();
        let (program, prepared) = answer_inputs(&mut cache, &r, &source, 0);
        assert!(program::clock_independent(program.value(), &mut |_| Some(
            ()
        )));
        let seed = cache
            .query_prepared_cached(&program, &prepared, &r.options, 0)
            .unwrap();
        assert_eq!(seed.outcome(), PreparationCacheOutcome::Miss);
        if !limit.is_empty() {
            assert_eq!(program.value().views[0].limit, Some(0));
            assert!(seed.value().rows.is_empty());
        }
        assert!(!cache.answers.back().unwrap().clock_independent);
        let mut near_max = r.options.clone();
        // Keep the invocation clock inside the evaluator's RFC3339 domain.
        // The large finite no-call duration fits from1970, but crosses chrono's
        // date bound when converted to a sort scalar at this later clock.
        near_max.evaluation.clock_ms = chrono::DateTime::parse_from_rfc3339("9999-12-31T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let expected = query_prepared(program.value(), &prepared, &near_max).unwrap_err();
        assert_eq!(expected.code, "numeric-domain");
        assert_eq!(
            cache
                .query_prepared_cached(&program, &prepared, &near_max, 1)
                .err(),
            Some(expected)
        );
    }
}

#[test]
fn mixed_notes_and_image_answers_preserve_benign_binary_issue_dto_on_hit() {
    let mut r = first();
    let image = EntryState {
        id: crate::EntryId::new("known-image").unwrap(),
        path: zorid_core::VaultPath::new("image.png").unwrap(),
        kind: zorid_core::EntryKind::File,
        revision: crate::Revision::new("image-r1").unwrap(),
        deleted: false,
    };
    r.sources.push(GenerationSource::Excluded {
        entry_id: image.id.clone(),
        content_revision: image.revision.clone(),
        reason: zorid_index::Exclusion::Binary,
    });
    r.entries.push(image);
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    let expected = semantics(query_prepared(program.value(), &prepared, &r.options).unwrap());
    assert!(expected.metadata_complete);
    assert_eq!(expected.metadata_issues.len(), 1);
    assert_eq!(
        expected.metadata_issues[0].exclusion,
        Some(zorid_index::Exclusion::Binary)
    );
    assert!(!expected.metadata_issues[0].properties_unavailable);
    assert!(expected.metadata_issues[0].diagnostics.is_empty());
    let mut measured = Maintenance::new(Some(&r.options));
    assert!(result_heap(&expected, &mut measured).is_some());
    let mut exhausted = Maintenance::new(Some(&r.options));
    exhausted.used = MAX_PREPARATION_CACHE_WORK;
    assert!(result_heap(&expected, &mut exhausted).is_none());
    assert_eq!(exhausted.used, MAX_PREPARATION_CACHE_WORK);
    let mut cancelled = r.options.clone();
    let token = crate::OperationCancellation::default();
    token.cancel();
    cancelled.evaluation.cancellation = Some(token);
    let mut stopped = Maintenance::new(Some(&cancelled));
    assert!(result_heap(&expected, &mut stopped).is_none());
    assert_eq!(stopped.used, 0);
    let seed = cache
        .query_prepared_cached(&program, &prepared, &r.options, 0)
        .unwrap();
    assert_eq!(seed.outcome(), PreparationCacheOutcome::Miss);
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 1);
    let mut options = r.options.clone();
    options.evaluation.clock_ms = 123456;
    let before = crate::expression::session_starts();
    let hit = cache
        .query_prepared_cached(&program, &prepared, &options, 1)
        .unwrap();
    assert_eq!(hit.outcome(), PreparationCacheOutcome::Hit);
    assert_eq!(crate::expression::session_starts(), before);
    assert_eq!(semantics(hit.into_value()), expected);
}
#[test]
fn exact_capacity_fallible_copies_stay_within_measured_nested_retention() {
    let options = QueryOptions::default();
    let small = || {
        PropertyValue::Object(vec![(
            "key".into(),
            PropertyValue::Array(vec![PropertyValue::String("value".into())]),
        )])
    };
    let property = PropertyValue::Array((0..512).map(|_| small()).collect());
    let copied = copy_property(&property, &options).unwrap();
    assert!(
        property_heap(&copied, &mut Maintenance::new(Some(&options))).unwrap()
            <= property_heap(&property, &mut Maintenance::new(Some(&options))).unwrap()
    );
    let value = crate::BaseValue::List {
        value: (0..512)
            .map(|_| crate::BaseValue::Object {
                value: vec![(
                    "key".into(),
                    crate::BaseValue::List {
                        value: vec![crate::BaseValue::String {
                            value: "value".into(),
                        }],
                    },
                )],
            })
            .collect(),
    };
    let copied = copy_value(&value, &options).unwrap();
    assert!(
        value_heap(&copied, &mut Maintenance::new(Some(&options))).unwrap()
            <= value_heap(&value, &mut Maintenance::new(Some(&options))).unwrap()
    );
    let mut key = options.clone();
    key.search_terms = vec!["one".into()];
    key.ignore_paths = vec!["other".into()];
    key.evaluation.formulas = vec![("unused".into(), "1".into())];
    key.evaluation.current_record = Some(DetachedRecord {
        properties: vec![("nested".into(), property.clone())],
        tags: vec!["tag".into()],
        ..Default::default()
    });
    let copied = copy_options(&key, false).unwrap();
    assert_eq!(copied.search_terms.capacity(), 1);
    assert_eq!(copied.ignore_paths.capacity(), 1);
    assert_eq!(copied.evaluation.formulas.capacity(), 1);
    assert!(
        options_heap(&copied, &mut Maintenance::new(Some(&options))).unwrap()
            <= options_heap(&key, &mut Maintenance::new(Some(&options))).unwrap()
    );
    let r = first();
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    let mut result = query_prepared(program.value(), &prepared, &r.options).unwrap();
    result.rows.truncate(1);
    result.rows.shrink_to_fit();
    result.rows[0].values.insert("nested".into(), value);
    result.view = property;
    let bound = result_heap(&result, &mut Maintenance::new(Some(&options))).unwrap();
    let copied = copy_result(&result, &options).unwrap();
    assert_eq!(copied.rows.capacity(), 1);
    assert!(result_heap(&copied, &mut Maintenance::new(Some(&options))).unwrap() <= bound);
    let mut generous = Vec::with_capacity(1024);
    generous.push(String::from("only-initialized-byte"));
    let mut m = Maintenance::new(Some(&options));
    vector_cost(&generous, &mut m, |s, m| m.retained(s.capacity(), s.len())).unwrap();
    assert!(m.slack_work > 0);
    assert!(
        m.used - m.slack_work < m.used,
        "unused capacity cannot be credited as avoided cold construction"
    );
}

#[test]
fn invocation_clock_domain_is_structured_and_shared_by_all_base_paths() {
    let r = first();
    let generation = r.generation();
    let mut cache = BasePreparationCache::new();
    let (program, prepared) = answer_inputs(&mut cache, &r, STATIC_ANSWER_BASE, 0);
    assert_eq!(
        cache
            .query_prepared_cached(&program, &prepared, &r.options, 0)
            .unwrap()
            .outcome(),
        PreparationCacheOutcome::Miss
    );
    let first = chrono::DateTime::parse_from_rfc3339("0000-01-01T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let last = chrono::DateTime::parse_from_rfc3339("9999-12-31T23:59:59.999Z")
        .unwrap()
        .timestamp_millis();
    for clock in [first, 0, last] {
        let mut options = r.options.clone();
        options.evaluation.clock_ms = clock;
        assert_eq!(
            crate::evaluate_expression("now()", &DetachedRecord::default(), &options.evaluation)
                .unwrap()
                .value,
            crate::BaseValue::Date {
                timestamp: clock,
                has_time: true
            }
        );
        let cold =
            crate::query_generation(program.value(), &generation, &r.facts, &options).unwrap();
        assert_eq!(
            semantics(query_prepared(program.value(), &prepared, &options).unwrap()),
            semantics(cold.clone())
        );
        let hit = cache
            .query_prepared_cached(&program, &prepared, &options, 1)
            .unwrap();
        assert_eq!(hit.outcome(), PreparationCacheOutcome::Hit);
        assert_eq!(semantics(hit.into_value()), semantics(cold));
    }
    let expected = ExpressionDiagnostic::new("input", "Clock or timestamp is out of range");
    for clock in [
        first - 1,
        last + 1,
        chrono::DateTime::<chrono::Utc>::MIN_UTC.timestamp_millis(),
        chrono::DateTime::<chrono::Utc>::MAX_UTC.timestamp_millis(),
        i64::MIN,
        i64::MAX,
    ] {
        let mut options = r.options.clone();
        options.evaluation.clock_ms = clock;
        assert_eq!(
            crate::evaluate_expression("1", &DetachedRecord::default(), &options.evaluation).err(),
            Some(expected.clone())
        );
        assert_eq!(
            crate::query_generation(program.value(), &generation, &r.facts, &options).err(),
            Some(expected.clone())
        );
        assert_eq!(
            query_prepared(program.value(), &prepared, &options).err(),
            Some(expected.clone())
        );
        assert_eq!(
            cache
                .query_prepared_cached(&program, &prepared, &options, 2)
                .err(),
            Some(expected.clone())
        );
        // Clock validation remains lazy when the query evaluates no rows.
        options.ignore_paths = r
            .entries
            .iter()
            .map(|entry| entry.path.as_str().into())
            .collect();
        let cold =
            crate::query_generation(program.value(), &generation, &r.facts, &options).unwrap();
        assert!(cold.rows.is_empty());
        assert_eq!(
            semantics(query_prepared(program.value(), &prepared, &options).unwrap()),
            semantics(cold.clone())
        );
        let uncached = cache
            .query_prepared_cached(&program, &prepared, &options, 2)
            .unwrap();
        assert_eq!(uncached.outcome(), PreparationCacheOutcome::Uncached);
        assert_eq!(semantics(uncached.into_value()), semantics(cold));
    }
    // Invocation validation does not narrow file timestamp serialization.
    let record = DetachedRecord {
        path: "sample.md".into(),
        ctime_ms: Some(chrono::DateTime::<chrono::Utc>::MIN_UTC.timestamp_millis()),
        mtime_ms: Some(chrono::DateTime::<chrono::Utc>::MAX_UTC.timestamp_millis()),
        ..Default::default()
    };
    assert_eq!(
        crate::evaluate_expression("file.name", &record, &r.options.evaluation)
            .unwrap()
            .value,
        crate::BaseValue::String {
            value: "sample".into()
        }
    );
}

#[test]
fn proof_fixed_slots_precede_walks_and_keep_exact_record_count_and_fit() {
    let mut r = first();
    r.entries.push(EntryState {
        id: crate::EntryId::new("folder-without-record").unwrap(),
        path: zorid_core::VaultPath::new("Folder").unwrap(),
        kind: zorid_core::EntryKind::Folder,
        revision: crate::Revision::new("folder-r1").unwrap(),
        deleted: false,
    });
    let generation = r.generation();
    let prepared = BasePreparationCache::new()
        .prepare_generation(&generation, &r.facts, &r.options, 0)
        .unwrap();
    let count = prepared.value().snapshot.records.len();
    assert_eq!(count, generation.records().count());
    assert!(count < generation.manifest().entries().len());
    let fixed = GenerationProof::fixed_bytes(&generation, &r.facts, count).unwrap();
    assert_eq!(
        GenerationProof::fixed_bytes(&generation, &r.facts, count + 1).unwrap() - fixed,
        size_of::<IndexRecord>()
    );
    let mut rejected = Maintenance::new(Some(&r.options));
    assert!(GenerationProof::new(&generation, &r.facts, count, &mut rejected, fixed - 1).is_none());
    assert_eq!(rejected.used, 1, "only the fixed-slot preflight may run");
    assert!(GenerationProof::fixed_bytes(&generation, &r.facts, usize::MAX).is_none());
    let mut overflow = Maintenance::new(Some(&r.options));
    assert!(GenerationProof::new(
        &generation,
        &r.facts,
        usize::MAX,
        &mut overflow,
        MAX_PREPARED_GENERATION_BYTES
    )
    .is_none());
    assert_eq!(overflow.used, 1);
    for wrong in [count - 1, count + 1] {
        assert!(GenerationProof::new(
            &generation,
            &r.facts,
            wrong,
            &mut Maintenance::new(Some(&r.options)),
            MAX_PREPARED_GENERATION_BYTES
        )
        .is_none());
    }
    let proof = GenerationProof::new(
        &generation,
        &r.facts,
        count,
        &mut Maintenance::new(Some(&r.options)),
        MAX_PREPARED_GENERATION_BYTES,
    )
    .unwrap();
    assert_eq!(
        proof.record_work.capacity(),
        generation.manifest().entries().len()
    );
    let exact = proof.retained_bytes();
    for allowance in [exact - 1, exact, exact + 1] {
        let result = GenerationProof::new(
            &generation,
            &r.facts,
            count,
            &mut Maintenance::new(Some(&r.options)),
            allowance,
        );
        assert_eq!(result.is_some(), allowance >= exact);
        if let Some(proof) = result {
            assert_eq!(proof.retained_bytes(), exact);
        }
    }
    let mut options = r.options.clone();
    let token = crate::OperationCancellation::default();
    token.cancel();
    options.evaluation.cancellation = Some(token);
    let mut cancelled = Maintenance::new(Some(&options));
    assert!(
        GenerationProof::new(&generation, &r.facts, count, &mut cancelled, fixed - 1).is_none()
    );
    assert_eq!(cancelled.used, 0);
    assert_eq!(
        BasePreparationCache::new()
            .prepare_generation(&generation, &r.facts, &options, 0)
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
}

#[test]
fn proof_running_heap_stops_after_each_record_entry_and_fact() {
    let mut r = first();
    r.facts = r
        .entries
        .iter()
        .map(|entry| FilePresentationFacts {
            witness: crate::RecordWitness {
                entry_id: entry.id.clone(),
                revision: entry.revision.clone(),
            },
            size: Some(1),
            ctime_ms: None,
            mtime_ms: None,
        })
        .collect();
    let generation = r.generation();
    let count = generation.records().count();
    let fixed = GenerationProof::fixed_bytes(&generation, &r.facts, count).unwrap();
    let mut measured = Maintenance::new(Some(&r.options));
    measured.take(1).unwrap();
    slots::<usize>(generation.manifest().entries().len(), &mut measured).unwrap();
    let mut heap = 0usize;
    let mut boundaries = Vec::new();
    for record in generation.records() {
        heap += record_heap(record, &mut measured).unwrap();
        boundaries.push((heap, measured.used));
    }
    for entry in generation.manifest().entries() {
        measured.take(state_work(entry)).unwrap();
        heap += state_heap(entry);
        boundaries.push((heap, measured.used));
    }
    for fact in &r.facts {
        measured.take(fact_work(fact)).unwrap();
        heap += fact_heap(fact);
        boundaries.push((heap, measured.used));
    }
    assert!(boundaries.windows(2).all(|pair| pair[0].0 < pair[1].0));
    for (heap, work) in boundaries {
        let mut stopped = Maintenance::new(Some(&r.options));
        assert!(
            GenerationProof::new(&generation, &r.facts, count, &mut stopped, fixed + heap - 1)
                .is_none()
        );
        assert_eq!(
            stopped.used, work,
            "walk continued beyond the remaining heap allowance"
        );
    }
}
