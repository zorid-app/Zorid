use super::*;
use crate::{document_runtime as c, document_work_runtime as w, draft_runtime as d};
use crate::{IndexSnapshotId, SemanticVersions, SourceSnapshotId, SourceWatermark};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::{ParseFactsPhase, ParseFactsStepBudget};

fn id(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn versions() -> SemanticVersions {
    SemanticVersions::new(2, "extract", "resolver", "query").unwrap()
}
fn request(buffer: &str, revision: u64, text: &str) -> d::DraftRequest {
    d::DraftRequest {
        tag: d::DraftTag {
            buffer: d::BufferKey {
                client: id("client"),
                buffer_lifetime: id(buffer),
            },
            text_revision: revision,
        },
        source: d::SourceDescriptor {
            bytes: text.len(),
            utf16: text.encode_utf16().count(),
            sha256: Sha256::digest(text.as_bytes()).into(),
        },
    }
}
struct Host {
    executor: DocumentDraftExecutor,
    committed: c::DocumentRuntime,
    execution: c::Execution,
}
impl Host {
    fn new() -> Self {
        Self {
            executor: DocumentDraftExecutor::new(id("draft"), id("work")),
            committed: c::DocumentRuntime::new(c::RuntimeIdentity {
                lifetime: id("committed"),
                local_store: id("store"),
                versions: versions(),
            }),
            execution: c::Execution::WaitForWake,
        }
    }
    fn reserve(&mut self, request: d::DraftRequest) -> d::JobToken {
        self.executor
            .command(DraftCommand::Request(request))
            .unwrap()
            .admitted
            .unwrap()
    }
    fn attach(&mut self, buffer: &str, revision: u64, source: &Arc<str>) -> d::JobToken {
        let job = self.reserve(request(buffer, revision, source));
        self.executor
            .attach_source(&job, Arc::clone(source))
            .unwrap();
        job
    }
    fn next(&mut self) -> w::Ticket {
        self.executor
            .next_turn(&mut self.committed, &mut self.execution)
            .unwrap()
            .ticket
            .expect("fixture has actual selected work")
    }
    fn step(&mut self, ticket: &w::Ticket) -> DraftStepRecord {
        self.executor
            .step_draft(ticket, &mut self.committed, &mut self.execution)
            .unwrap()
    }
    fn phase(&mut self, job: &d::JobToken, completed: u8) {
        let ticket = self.next();
        let w::ChildEffect::Draft(effect) = &ticket.effect else {
            panic!("draft phase required")
        };
        assert_eq!(&effect.job, job);
        assert!(
            matches!(effect.kind, d::Effect::ParsePhase { phases_completed, .. } if phases_completed == completed)
        );
        let actual = self.step(&ticket);
        let d::Completion::Parsed(progress) = actual.completion else {
            panic!("actual parser phase required")
        };
        assert_eq!(progress.phases_completed, completed + 1);
    }
    fn drive(&mut self) -> Vec<DraftStepRecord> {
        let mut records = Vec::new();
        for _ in 0..64 {
            let turn = self
                .executor
                .next_turn(&mut self.committed, &mut self.execution)
                .unwrap();
            let Some(ticket) = turn.ticket else {
                return records;
            };
            records.push(self.step(&ticket));
        }
        panic!("portable fixture exceeded 64 actual turns");
    }
}
fn assert_unchanged(host: &Host, before: &DraftSnapshot) {
    let after = host.executor.snapshot();
    assert_eq!(after.runtime, before.runtime);
    assert_eq!(after.work, before.work);
    assert_eq!(after.handles, before.handles);
}

#[test]
fn portable_constructor_and_reservation_do_not_parse_or_copy_source() {
    let mut host = Host::new();
    let empty = host.executor.snapshot();
    assert_eq!(empty.handles, 0);
    assert_eq!(
        empty.runtime.usage,
        zorid_document::ParseFactsUsage::default()
    );
    let source: Arc<str> = Arc::from("# Draft 😀\r\n[[Target]]");
    let job = host.reserve(request("buffer", 1, &source));
    assert_eq!(Arc::strong_count(&source), 1);
    let reserved = host.executor.snapshot();
    assert_eq!(reserved.handles, 1);
    assert_eq!(reserved.runtime.usage.source_bytes, source.len());
    assert_eq!(
        reserved.runtime.usage.facts_bytes + reserved.runtime.usage.scratch_bytes,
        0
    );
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    assert_eq!(Arc::strong_count(&source), 2);
    let attached = host.executor.snapshot();
    assert_eq!(
        attached.runtime.usage.facts_bytes + attached.runtime.usage.scratch_bytes,
        0
    );
    assert!(matches!(
        attached.runtime.in_flight.unwrap().kind,
        d::Effect::ParsePhase {
            phase: ParseFactsPhase::Positions,
            phases_completed: 0,
            ..
        }
    ));
}

#[test]
fn portable_duplicate_admission_reuses_actual_arc_and_parser_progress() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Heading\n[[Target]]");
    let request = request("buffer", 1, &source);
    let job = host.reserve(request.clone());
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    host.phase(&job, 0);
    let before = host.executor.snapshot();
    let replay = host
        .executor
        .command(DraftCommand::Request(request))
        .unwrap();
    assert!(replay.replay);
    assert_eq!(replay.admitted, Some(job.clone()));
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    assert_eq!(Arc::strong_count(&source), 2);
    assert_unchanged(&host, &before);
    host.phase(&job, 1);
}

#[test]
fn portable_source_owner_and_ticket_rejections_preserve_selected_work() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("😀x");
    let job = host.reserve(request("buffer", 1, &source));
    let reserved = host.executor.snapshot();
    assert!(host
        .executor
        .attach_source(&job, Arc::from("abcde"))
        .is_err());
    assert!(host.executor.attach_source(&job, Arc::from("😀y")).is_err());
    assert_unchanged(&host, &reserved);
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    let ticket = host.next();
    let before = host.executor.snapshot();
    assert!(host
        .executor
        .command(DraftCommand::Cancel {
            client: id("foreign"),
            job: job.clone()
        })
        .is_err());
    let mut forged = ticket.clone();
    forged.incarnation = id("foreign-work");
    assert!(host
        .executor
        .step_draft(&forged, &mut host.committed, &mut host.execution)
        .is_err());
    assert_unchanged(&host, &before);
    host.step(&ticket);
}

#[test]
fn portable_receipt_replay_never_runs_next_phase_and_old_receipt_expires() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Heading");
    let job = host.attach("buffer", 1, &source);
    let ticket = host.next();
    let actual = host.step(&ticket);
    let before = host.executor.snapshot();
    let replay = host.step(&ticket);
    assert_eq!(actual.issued, replay.issued);
    assert_eq!(actual.completion, replay.completion);
    assert_eq!(actual.reduction, replay.reduction);
    assert_unchanged(&host, &before);
    host.phase(&job, 1);
    let newer = host.executor.snapshot();
    assert!(host
        .executor
        .step_draft(&ticket, &mut host.committed, &mut host.execution)
        .is_err());
    assert_unchanged(&host, &newer);
}

#[test]
fn portable_cancel_releases_actual_input_and_prevents_remaining_passes() {
    for completed in [0, 3, 7] {
        let mut host = Host::new();
        let source: Arc<str> = Arc::from("---\naliases: [One, Two]\n---\n# Draft\n[[Target]] #tag");
        let job = host.attach("buffer", 1, &source);
        for phase in 0..completed {
            host.phase(&job, phase);
        }
        host.executor
            .command(DraftCommand::Cancel {
                client: id("client"),
                job: job.clone(),
            })
            .unwrap();
        assert!(host.executor.facts(&job).is_err());
        for receipt in host.drive() {
            match receipt.completion {
                d::Completion::Stopped {
                    phases_completed,
                    usage,
                } => {
                    assert_eq!(phases_completed, completed);
                    assert_eq!(usage, zorid_document::ParseFactsUsage::default());
                }
                d::Completion::Dropped => {}
                other => panic!("cancelled portable job performed further work: {other:?}"),
            }
        }
        assert_eq!(Arc::strong_count(&source), 1);
        let after = host.executor.snapshot();
        assert_eq!(after.handles, 0);
        assert_eq!(
            after.runtime.usage,
            zorid_document::ParseFactsUsage::default()
        );
        assert!(after
            .runtime
            .outcomes
            .iter()
            .any(|outcome| outcome.job == job && outcome.kind == d::OutcomeKind::Cancelled));
    }
}

#[test]
fn portable_ready_ack_keeps_facts_charged_until_exact_actual_drop() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Ready\n[[Target]]");
    let job = host.attach("buffer", 1, &source);
    let receipts = host.drive();
    assert_eq!(receipts.len(), 7);
    assert_eq!(host.executor.facts(&job).unwrap().headings[0].text, "Ready");
    let ready = host.executor.snapshot();
    assert_eq!(
        ready.runtime.usage.source_bytes + ready.runtime.usage.scratch_bytes,
        0
    );
    assert!(ready.runtime.usage.facts_bytes > 0);
    assert_eq!(Arc::strong_count(&source), 1);
    host.executor
        .command(DraftCommand::Acknowledge {
            client: id("client"),
            job: job.clone(),
        })
        .unwrap();
    let acknowledged = host.executor.snapshot();
    assert_eq!(
        acknowledged.runtime.usage.facts_bytes,
        ready.runtime.usage.facts_bytes
    );
    assert_eq!(acknowledged.handles, 1);
    assert!(host.executor.facts(&job).is_err());
    let drops = host.drive();
    assert_eq!(drops.len(), 1);
    assert_eq!(drops[0].issued.job, job);
    assert_eq!(drops[0].issued.kind, d::Effect::DropJob);
    assert_eq!(drops[0].completion, d::Completion::Dropped);
    assert_eq!(host.executor.snapshot().handles, 0);
    assert_eq!(
        host.executor.snapshot().runtime.usage,
        zorid_document::ParseFactsUsage::default()
    );
}

#[test]
fn portable_new_revision_invalidates_ready_facts_before_old_payload_drop() {
    let mut host = Host::new();
    let old: Arc<str> = Arc::from("# Old\n[[Before]]");
    let old_job = host.attach("buffer", 1, &old);
    host.drive();
    let old_facts_bytes = host.executor.snapshot().runtime.usage.facts_bytes;
    let new: Arc<str> = Arc::from("# New\n[[After]]");
    let new_job = host.attach("buffer", 2, &new);
    assert!(host.executor.facts(&old_job).is_err());
    assert_eq!(
        host.executor.snapshot().runtime.usage.facts_bytes,
        old_facts_bytes
    );
    let receipts = host.drive();
    assert!(receipts
        .iter()
        .any(|r| r.issued.job == old_job && r.completion == d::Completion::Dropped));
    let facts = host.executor.facts(&new_job).unwrap();
    assert_eq!(facts.headings[0].text, "New");
    assert_eq!(facts.links[0].target, "After");
}

#[test]
fn portable_close_retires_both_children_and_waits_for_actual_payload_release() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Draft");
    let job = host.attach("buffer", 1, &source);
    let selected = host.next();
    host.executor
        .begin_close(&mut host.committed, &mut host.execution)
        .unwrap();
    assert!(!host.executor.close_ready(&host.committed, host.execution));
    assert!(host.executor.facts(&job).is_err());
    assert!(host
        .executor
        .command(DraftCommand::Request(request("new-buffer", 1, "x")))
        .is_err());
    assert_eq!(host.next(), selected);
    host.drive();
    assert!(host.executor.close_ready(&host.committed, host.execution));
    assert_eq!(host.executor.snapshot().handles, 0);
    assert_eq!(
        host.executor
            .next_turn(&mut host.committed, &mut host.execution)
            .unwrap()
            .state,
        w::WorkState::Quiesced
    );
    assert_eq!(Arc::strong_count(&source), 1);
}

#[test]
fn portable_committed_selection_cannot_be_executed_as_a_draft_phase() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Draft");
    let job = host.attach("buffer", 1, &source);
    let demand = host
        .committed
        .reduce(c::Input::Request(c::FreshnessRequest::new(1)))
        .unwrap();
    host.execution = demand.execution;
    let committed = host.next();
    assert!(matches!(committed.effect, w::ChildEffect::Committed(_)));
    assert_eq!(
        host.executor.admit(&committed, &host.committed).unwrap(),
        w::Admission::Execute
    );
    let before = host.executor.snapshot();
    assert!(host
        .executor
        .step_draft(&committed, &mut host.committed, &mut host.execution)
        .is_err());
    assert_unchanged(&host, &before);
    host.executor
        .settle_committed(
            &committed,
            c::EffectResult::Observed(c::Observation {
                source: SourceSnapshotId::new(id("store"), SourceWatermark::new("1").unwrap()),
                published: Some(
                    IndexSnapshotId::new(id("store"), id("epoch"), 1, versions()).unwrap(),
                ),
                current: true,
                rebuild_required: false,
                coverage_complete: Some(true),
            }),
            &mut host.committed,
            &mut host.execution,
        )
        .unwrap();
    host.phase(&job, 0);
}

#[test]
fn cancelled_or_finished_actual_parser_is_not_fabricated_as_resource_exhaustion() {
    for unexpectedly_finished in [false, true] {
        let mut host = Host::new();
        let source: Arc<str> = Arc::from("# Draft");
        let job = host.attach("buffer", 1, &source);
        let ticket = host.next();
        // Relocated native fault fixture. Disturb only the real parser while
        // leaving its core descriptor untouched; execution must fail closed.
        let parser = host
            .executor
            .jobs
            .get_mut(&job.id)
            .unwrap()
            .parser
            .as_mut()
            .unwrap();
        if unexpectedly_finished {
            for _ in 0..7 {
                parser
                    .step(ParseFactsStepBudget {
                        max_scratch_bytes: d::MAX_DRAFT_SCRATCH_BYTES,
                        max_facts_bytes: d::MAX_DRAFT_FACTS_BYTES,
                    })
                    .unwrap();
            }
        } else {
            parser.cancel();
        }
        let before = host.executor.snapshot();
        assert!(matches!(
            host.executor
                .step_draft(&ticket, &mut host.committed, &mut host.execution),
            Err(DraftExecutorError::UnexpectedParserState)
        ));
        assert_unchanged(&host, &before);
        assert!(!before.runtime.outcomes.iter().any(|outcome| matches!(
            outcome.kind,
            d::OutcomeKind::Unavailable(d::UnavailableCode::Resource)
        )));
        host.executor
            .begin_close(&mut host.committed, &mut host.execution)
            .unwrap();
        // Disposal of this deliberately inconsistent actual parser occurs on
        // owner drop; never invent a successful phase/drop counter to drain it.
    }
}
