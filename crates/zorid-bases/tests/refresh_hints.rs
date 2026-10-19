//! Shared query/answer-cache refresh metadata; expected deadlines are fixed
//! calendar fixtures, not values obtained from the implementation under test.
use zorid_bases::{
    compile_base_source, query_base, query_generation, BaseClockDependency as Dependency,
    BasePreparationCache, BaseQueryResult, BaseSnapshot, FilePresentationFacts,
    PreparationCacheOutcome, QueryOptions, RecordWitness,
};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_index::{
    document_extraction_version, Generation, GenerationSource, IndexSnapshotId, MetadataRequest,
    SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, RESOLVER_VERSION,
};

fn generation() -> Generation {
    let store = OperationId::new("refresh-store").unwrap();
    let source = SourceSnapshotId::new(store.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        store,
        OperationId::new("refresh-epoch").unwrap(),
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
    let entries = (0..8)
        .map(|i| EntryState {
            id: EntryId::new(format!("entry-{i}")).unwrap(),
            path: VaultPath::new(format!("Note{i}.md")).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
            deleted: false,
        })
        .collect::<Vec<_>>();
    let sources = entries
        .iter()
        .map(|entry| GenerationSource::Text {
            request: MetadataRequest {
                entry_id: entry.id.clone(),
                content_revision: entry.revision.clone(),
                source: "Saved body\n".into(),
            },
            markdown: true,
        })
        .collect();
    Generation::from_sources(source, snapshot, entries, sources).unwrap()
}
fn options(clock_ms: i64, timezone: &str) -> QueryOptions {
    let mut options = QueryOptions::default();
    options.evaluation.clock_ms = clock_ms;
    options.evaluation.timezone = timezone.into();
    options
}
fn assert_hint(
    result: &BaseQueryResult,
    dependency: Dependency,
    timezone: &str,
    next: Option<i64>,
) {
    let hint = result.refresh_hint.as_ref().expect("valid captured hint");
    assert_eq!(hint.dependency, dependency);
    assert_eq!(hint.timezone, timezone);
    assert_eq!(hint.next_wake_ms, next);
    let wire = serde_json::to_value(hint).unwrap();
    assert_eq!(wire["nextWakeMs"], serde_json::json!(next));
}
#[test]
fn selected_view_and_hidden_formula_dependencies_are_rust_owned() {
    let generation = generation();
    let source = "views:\n  - type: table\n    name: Plain\n    order: [file.name]\n  - type: table\n    name: Daily\n    filters: today() != null\n    order: [file.name]\n";
    let program = compile_base_source(source).unwrap();
    let mut options = options(0, "UTC");
    let plain = query_generation(&program, &generation, &[], &options).unwrap();
    assert_hint(&plain, Dependency::None, "UTC", None);
    options.view_index = 1;
    let daily = query_generation(&program, &generation, &[], &options).unwrap();
    assert_hint(&daily, Dependency::Day, "UTC", Some(86_400_000));
    let hidden = compile_base_source("formulas:\n  hidden: today()\n  chain: formula.hidden\nviews:\n  - type: table\n    name: Table\n    order: [file.name]\n").unwrap();
    options.view_index = 0;
    let result = query_generation(&hidden, &generation, &[], &options).unwrap();
    assert_hint(&result, Dependency::Day, "UTC", Some(86_400_000));
    let relative = compile_base_source("formulas:\n  relative: date(\"2024-01-01\").relative()\nviews:\n  - type: table\n    name: Table\n    order: [file.name]\n").unwrap();
    let result = query_generation(&relative, &generation, &[], &options).unwrap();
    assert_hint(&result, Dependency::Instant, "UTC", Some(1_000));
}
#[test]
fn civil_day_deadlines_follow_selected_zone_and_short_or_long_dst_day() {
    let generation = generation();
    let program = compile_base_source("filters: today() != null\nviews:\n  - type: table\n    name: Table\n    order: [file.name]\n").unwrap();
    for (clock, timezone, next) in [
        (1_710_046_800_000, "America/Toronto", 1_710_129_600_000), // 23h spring day
        (1_730_606_400_000, "America/Toronto", 1_730_696_400_000), // 25h autumn day
        (1_710_046_800_000, "UTC", 1_710_115_200_000),             // selected UTC date
        (0, "+02:00", 79_200_000),
    ] {
        let result =
            query_generation(&program, &generation, &[], &options(clock, timezone)).unwrap();
        assert_hint(&result, Dependency::Day, timezone, Some(next));
    }
}
#[test]
fn empty_and_fully_ignored_invalid_captures_keep_lazy_success_without_advice() {
    let generation = generation();
    let program = compile_base_source("formulas:\n  clock: now()\nviews:\n  - type: table\n    name: Table\n    order: [formula.clock]\n").unwrap();
    let empty = BaseSnapshot::detached(generation.id().clone(), vec![]);
    for (clock, timezone) in [(i64::MAX, "UTC"), (0, "local"), (0, "Not/A_Zone")] {
        let mut options = options(clock, timezone);
        let result = query_base(&program, &empty, &options).unwrap();
        assert!(result.rows.is_empty());
        assert!(result.refresh_hint.is_none());
        options.ignore_paths = generation
            .manifest()
            .entries()
            .iter()
            .map(|e| e.path.as_str().to_owned())
            .collect();
        let result = query_generation(&program, &generation, &[], &options).unwrap();
        assert!(result.rows.is_empty());
        assert!(result.refresh_hint.is_none());
    }
}
#[test]
fn runtime_duration_sort_upgrades_advice_before_positive_fractional_limit() {
    let generation = generation();
    let facts = generation
        .manifest()
        .entries()
        .iter()
        .map(|entry| FilePresentationFacts {
            witness: RecordWitness {
                entry_id: entry.id.clone(),
                revision: entry.revision.clone(),
            },
            size: None,
            ctime_ms: Some(0),
            mtime_ms: Some(86_400_000),
        })
        .collect::<Vec<_>>();
    let source = "formulas:\n  elapsed: file.mtime - file.ctime\nviews:\n  - type: table\n    name: Table\n    order: [formula.elapsed]\n    sort:\n      - property: formula.elapsed\n        direction: ASC\n    limit: 0.5\n";
    let program = compile_base_source(source).unwrap();
    assert_eq!(program.refresh_dependency(0), Dependency::None);
    let result = query_generation(&program, &generation, &facts, &options(0, "UTC")).unwrap();
    assert!(result.rows.is_empty());
    assert_hint(&result, Dependency::Instant, "UTC", Some(1_000));
}
#[test]
fn answer_hits_keep_current_hints_without_widening_time_or_timezone_identity() {
    let generation = generation();
    let mut cache = BasePreparationCache::new();
    let mut options = options(0, "UTC");
    let static_source = "views:\n  - type: table\n    name: Table\n    order: [file.name]\n";
    let program = cache.compile_source(static_source, 0).unwrap();
    let prepared = cache
        .prepare_generation(&generation, &[], &options, 0)
        .unwrap();
    let seed = cache
        .query_prepared_cached(&program, &prepared, &options, 0)
        .unwrap();
    assert_eq!(seed.outcome(), PreparationCacheOutcome::Miss);
    assert_hint(seed.value(), Dependency::None, "UTC", None);
    options.evaluation.clock_ms = 10_000;
    let hit = cache
        .query_prepared_cached(&program, &prepared, &options, 1)
        .unwrap();
    assert_eq!(hit.outcome(), PreparationCacheOutcome::Hit);
    assert_hint(hit.value(), Dependency::None, "UTC", None);
    options.evaluation.timezone = "America/Toronto".into();
    let changed = cache
        .query_prepared_cached(&program, &prepared, &options, 2)
        .unwrap();
    assert_ne!(changed.outcome(), PreparationCacheOutcome::Hit);
    assert_hint(changed.value(), Dependency::None, "America/Toronto", None);
    options = self::options(0, "UTC");
    let program = cache.compile_source("filters: today() != null\nviews:\n  - type: table\n    name: Table\n    order: [file.name]\n", 3).unwrap();
    let prepared = cache
        .prepare_generation(&generation, &[], &options, 3)
        .unwrap();
    let seed = cache
        .query_prepared_cached(&program, &prepared, &options, 3)
        .unwrap();
    assert_hint(seed.value(), Dependency::Day, "UTC", Some(86_400_000));
    let hit = cache
        .query_prepared_cached(&program, &prepared, &options, 4)
        .unwrap();
    assert_eq!(hit.outcome(), PreparationCacheOutcome::Hit);
    assert_hint(hit.value(), Dependency::Day, "UTC", Some(86_400_000));
    options.evaluation.clock_ms = 1;
    let changed = cache
        .query_prepared_cached(&program, &prepared, &options, 5)
        .unwrap();
    assert_ne!(
        changed.outcome(),
        PreparationCacheOutcome::Hit,
        "no new day-bucket answer reuse"
    );
    assert_hint(changed.value(), Dependency::Day, "UTC", Some(86_400_000));
}
#[test]
fn added_advice_obeys_query_budgets_and_checked_terminal_clock() {
    let generation = generation();
    let program = compile_base_source("formulas:\n  clock: now()\nviews:\n  - type: table\n    name: Table\n    order: [formula.clock]\n").unwrap();
    let baseline = query_generation(&program, &generation, &[], &options(0, "UTC")).unwrap();
    assert_hint(&baseline, Dependency::Instant, "UTC", Some(1_000));
    let mut limited = options(0, "UTC");
    limited.max_steps = baseline.steps_used - 1;
    assert_eq!(
        query_generation(&program, &generation, &[], &limited)
            .unwrap_err()
            .code,
        "budget"
    );
    limited = options(0, "UTC");
    limited.max_output_bytes = serde_json::to_vec(&baseline).unwrap().len() - 1;
    assert_eq!(
        query_generation(&program, &generation, &[], &limited)
            .unwrap_err()
            .code,
        "budget"
    );
    let at_horizon = query_generation(
        &program,
        &generation,
        &[],
        &options(253_402_300_799_999, "UTC"),
    )
    .unwrap();
    assert_hint(&at_horizon, Dependency::Instant, "UTC", None);
}
