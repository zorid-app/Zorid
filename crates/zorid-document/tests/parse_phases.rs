use std::sync::Arc;
use zorid_document::{
    parse_markdown_facts, ParseFactsJob, ParseFactsJobError, ParseFactsPhase,
    ParseFactsResourceKind, ParseFactsStepBudget, ParseFactsUsage, MAX_SOURCE_BYTES,
};

const BUDGET: ParseFactsStepBudget = ParseFactsStepBudget {
    max_scratch_bytes: 128 * 1024 * 1024,
    max_facts_bytes: 64 * 1024 * 1024,
};
const PHASES: [ParseFactsPhase; 7] = [
    ParseFactsPhase::Positions, ParseFactsPhase::Frontmatter,
    ParseFactsPhase::InitialMaskAndComments, ParseFactsPhase::WikiRepairs,
    ParseFactsPhase::ProtectedExclusions, ParseFactsPhase::Semantics, ParseFactsPhase::Tags,
];
fn job(source: &str) -> ParseFactsJob { ParseFactsJob::new(Arc::from(source)).unwrap() }
fn advance(job: &mut ParseFactsJob, count: usize) {
    for _ in 0..count { job.step(BUDGET).unwrap(); }
}

#[test]
fn admission_reuses_arc_and_performs_no_extraction() {
    let source: Arc<str> = Arc::from("# Heading [[Target]] #tag");
    let mut parse = ParseFactsJob::new(Arc::clone(&source)).unwrap();
    assert_eq!(Arc::strong_count(&source), 2);
    assert_eq!(parse.phase(), ParseFactsPhase::Positions);
    assert_eq!(parse.phases_completed(), 0);
    assert_eq!(parse.usage(), ParseFactsUsage { source_bytes: source.len(), scratch_bytes: 0, facts_bytes: 0 });
    parse.cancel();
    assert_eq!(Arc::strong_count(&source), 1);
    assert_eq!(parse.usage(), ParseFactsUsage::default());
    assert_eq!(parse.phases_completed(), 0);
}

#[test]
fn each_step_completes_exactly_one_phase_and_ready_drops_source_scratch() {
    let source = "---\r\naliases: [One, Two]\r\n---\r\n# Heading 😀\r\n[[Target#Part]] #tag\r\n- [x] done";
    let mut parse = job(source);
    for (index, expected) in PHASES.into_iter().enumerate() {
        assert_eq!(parse.phase(), expected);
        assert!(parse.take_facts().is_none());
        let progress = parse.step(BUDGET).unwrap();
        assert_eq!(progress.completed_phase, expected);
        assert_eq!(progress.phases_completed as usize, index + 1);
        assert_eq!(progress.ready, index == 6);
        assert_eq!(progress.usage, parse.usage());
        assert!(progress.usage.scratch_bytes <= BUDGET.max_scratch_bytes);
        assert!(progress.usage.facts_bytes <= BUDGET.max_facts_bytes);
        assert_eq!(progress.usage.source_bytes, if index == 6 { 0 } else { source.len() });
    }
    assert_eq!(parse.phase(), ParseFactsPhase::Ready);
    assert_eq!(parse.usage().scratch_bytes, 0);
    assert!(parse.usage().facts_bytes > 0);
    assert_eq!(parse.take_facts().unwrap(), parse_markdown_facts(source).unwrap());
    assert_eq!(parse.usage(), ParseFactsUsage::default());
    assert!(parse.take_facts().is_none());
    assert_eq!(parse.step(BUDGET), Err(ParseFactsJobError::Finished));
    assert_eq!(parse.phases_completed(), 7);
}

#[test]
fn cancellation_after_every_checkpoint_prevents_all_remaining_passes() {
    let source = "---\naliases: [Uno, Deux]\ntags: [yaml]\n---\n   # ![[b|c]] b\\](aa)\n[[Target]] #body\n- [x] done";
    for after in 0..=7 {
        let mut parse = job(source);
        advance(&mut parse, after);
        parse.cancel();
        assert_eq!(parse.phase(), ParseFactsPhase::Cancelled);
        assert_eq!(parse.phases_completed() as usize, after);
        assert_eq!(parse.usage(), ParseFactsUsage::default());
        for _ in 0..3 {
            assert_eq!(parse.step(BUDGET), Err(ParseFactsJobError::Cancelled));
            assert_eq!(parse.phases_completed() as usize, after);
            assert!(parse.take_facts().is_none());
        }
    }
}

#[test]
fn scheduler_can_interleave_two_sources_without_finishing_either() {
    let mut first = job("# First\n[[A]]");
    let mut second = job("# Second\n[[B]]");
    for turn in 0..6 {
        let selected = if turn % 2 == 0 { &mut first } else { &mut second };
        selected.step(BUDGET).unwrap();
    }
    assert_eq!(first.phases_completed(), 3);
    assert_eq!(second.phases_completed(), 3);
    assert_eq!(first.phase(), ParseFactsPhase::WikiRepairs);
    first.cancel();
    advance(&mut second, 4);
    assert_eq!(second.take_facts().unwrap().headings[0].text, "Second");
}

#[test]
fn own_scratch_refusal_precedes_positions_and_releases_job() {
    let mut parse = job("x");
    let result = parse.step(ParseFactsStepBudget { max_scratch_bytes: 0, ..BUDGET });
    assert_eq!(result, Err(ParseFactsJobError::Resource { kind: ParseFactsResourceKind::Scratch }));
    assert_eq!(parse.phases_completed(), 0);
    assert_eq!(parse.usage(), ParseFactsUsage::default());
    assert_eq!(parse.step(BUDGET), Err(ParseFactsJobError::Cancelled));
}

#[test]
fn aggregate_headroom_includes_already_retained_allocations() {
    let mut parse = job("# Heading");
    parse.step(BUDGET).unwrap();
    let held = parse.usage();
    assert!(held.scratch_bytes > 0);
    assert_eq!(parse.step(ParseFactsStepBudget { max_scratch_bytes: held.scratch_bytes - 1, ..BUDGET }), Err(ParseFactsJobError::Resource { kind: ParseFactsResourceKind::Scratch }));
    assert_eq!(parse.phases_completed(), 1);
    assert_eq!(parse.usage(), ParseFactsUsage::default());
}

#[test]
fn yaml_output_budget_refuses_before_projection_and_never_returns_partial_facts() {
    let mut parse = job("---\naliases: [one, two, three]\n---\n# Later");
    parse.step(BUDGET).unwrap();
    let held = parse.usage().facts_bytes;
    assert_eq!(parse.step(ParseFactsStepBudget { max_facts_bytes: held, ..BUDGET }), Err(ParseFactsJobError::Resource { kind: ParseFactsResourceKind::Facts }));
    assert_eq!(parse.phases_completed(), 1);
    assert!(parse.take_facts().is_none());
    assert_eq!(parse.usage(), ParseFactsUsage::default());
}

#[test]
fn semantic_output_budget_refuses_before_emitting_dense_facts() {
    let mut parse = job(&"[[Target]] - [x] task\n".repeat(100));
    advance(&mut parse, 5);
    let held = parse.usage().facts_bytes;
    assert_eq!(parse.step(ParseFactsStepBudget { max_facts_bytes: held, ..BUDGET }), Err(ParseFactsJobError::Resource { kind: ParseFactsResourceKind::Facts }));
    assert_eq!(parse.phases_completed(), 5);
    assert_eq!(parse.usage(), ParseFactsUsage::default());
}

#[test]
fn tags_budget_refusal_preserves_successful_phase_counter() {
    let mut parse = job("#tag #another");
    advance(&mut parse, 6);
    let held = parse.usage().facts_bytes;
    assert_eq!(parse.step(ParseFactsStepBudget { max_facts_bytes: held, ..BUDGET }), Err(ParseFactsJobError::Resource { kind: ParseFactsResourceKind::Facts }));
    assert_eq!(parse.phases_completed(), 6);
    assert_eq!(parse.usage(), ParseFactsUsage::default());
}

#[test]
fn source_limit_is_identical_at_admission() {
    assert!(matches!(ParseFactsJob::new(Arc::from("x".repeat(MAX_SOURCE_BYTES + 1))), Err(zorid_document::ExtractionError::SourceTooLarge { maximum_bytes: MAX_SOURCE_BYTES })));
}

#[test]
fn all_frozen_corpus_sources_match_the_synchronous_wrapper() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/document-semantics/markdown/corpus.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let source = case["request"]["source"].as_str().unwrap();
        let mut parse = job(source);
        advance(&mut parse, 7);
        assert_eq!(parse.take_facts().unwrap(), parse_markdown_facts(source).unwrap(), "{}", case["id"]);
    }
}
