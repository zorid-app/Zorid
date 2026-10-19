use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::{ParseFactsJob, ParseFactsPhase, ParseFactsStep, ParseFactsUsage};
use zorid_index::{document_runtime as c, document_work_runtime as w, draft_runtime as d};
use zorid_index::{IndexSnapshotId, SemanticVersions, SourceSnapshotId, SourceWatermark};

fn id(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn versions() -> SemanticVersions {
    SemanticVersions::new(2, "extract", "resolver", "query").unwrap()
}
fn source(n: u64) -> SourceSnapshotId {
    SourceSnapshotId::new(id("store"), SourceWatermark::new(n.to_string()).unwrap())
}
fn snapshot(n: u64) -> IndexSnapshotId {
    IndexSnapshotId::new(id("store"), id("epoch"), n, versions()).unwrap()
}
fn observed(n: u64, current: bool) -> c::EffectResult {
    c::EffectResult::Observed(c::Observation {
        source: source(n),
        published: Some(snapshot(1)),
        current,
        rebuild_required: false,
        coverage_complete: Some(true),
    })
}
fn stage(n: u64, prepared: u32, total: u32) -> c::StageObservation {
    c::StageObservation {
        source: source(n),
        snapshot: snapshot(2),
        progress: Some(c::StageProgress {
            prepared,
            total,
            ready: prepared == total,
        }),
    }
}
fn zero() -> ParseFactsUsage {
    ParseFactsUsage::default()
}
struct Host {
    committed: c::DocumentRuntime,
    execution: c::Execution,
    draft: d::DraftRuntime,
    work: w::DocumentWorkRuntime,
}
impl Host {
    fn new() -> Self {
        Self {
            committed: c::DocumentRuntime::new(c::RuntimeIdentity {
                lifetime: id("committed"),
                local_store: id("store"),
                versions: versions(),
            }),
            execution: c::Execution::WaitForWake,
            draft: d::DraftRuntime::new(id("draft")),
            work: w::DocumentWorkRuntime::new(id("incarnation")),
        }
    }
    fn command(&mut self, input: c::Input) -> c::Reduction {
        let r = self.committed.reduce(input).unwrap();
        self.execution = r.execution;
        r
    }
    fn wake(&mut self) {
        self.command(c::Input::Wake { monotonic_ms: 1 });
    }
    fn request(&mut self) {
        self.command(c::Input::Request(c::FreshnessRequest::new(1)));
    }
    fn draft(&mut self, buffer: &str, text: &str) -> d::JobToken {
        let source = d::SourceDescriptor {
            bytes: text.len(),
            utf16: text.encode_utf16().count(),
            sha256: [7; 32],
        };
        let request = d::DraftRequest {
            tag: d::DraftTag {
                buffer: d::BufferKey {
                    client: id("client"),
                    buffer_lifetime: id(buffer),
                },
                text_revision: 1,
            },
            source: source.clone(),
        };
        let token = self
            .draft
            .reduce(d::Input::Request(request))
            .unwrap()
            .admitted
            .unwrap();
        self.draft
            .reduce(d::Input::Seal {
                job: token.clone(),
                actual: source,
            })
            .unwrap();
        token
    }
    fn turn(&mut self) -> w::Turn {
        self.work
            .select_next_turn(&mut self.committed, &mut self.execution, &self.draft)
            .unwrap()
    }
    fn settle(&mut self, ticket: &w::Ticket, result: w::Completion) -> w::Settlement {
        self.work
            .settle(
                ticket,
                result,
                &mut self.committed,
                &mut self.execution,
                &mut self.draft,
            )
            .unwrap()
    }
    fn committed(&mut self, result: c::EffectResult) -> w::Settlement {
        let t = self.turn().ticket.unwrap();
        assert_eq!(t.effect.lane(), w::Lane::Committed);
        self.settle(&t, w::Completion::Committed(result))
    }
    fn close(&mut self) -> w::Close {
        self.work
            .begin_close(&mut self.committed, &mut self.execution, &mut self.draft)
            .unwrap()
    }
}
fn parsed(ticket: &w::Ticket, bytes: usize) -> d::Completion {
    let w::ChildEffect::Draft(effect) = &ticket.effect else {
        panic!("draft");
    };
    let d::Effect::ParsePhase {
        phase,
        phases_completed,
        ..
    } = effect.kind
    else {
        panic!("parse");
    };
    let ready = phase == ParseFactsPhase::Tags;
    d::Completion::Parsed(ParseFactsStep {
        completed_phase: phase,
        phases_completed: phases_completed + 1,
        ready,
        usage: ParseFactsUsage {
            source_bytes: if ready { 0 } else { bytes },
            scratch_bytes: 0,
            facts_bytes: 1,
        },
    })
}

#[test]
fn first_background_tie_is_draft_and_first_foreground_tie_is_committed() {
    let mut background = Host::new();
    background.wake();
    background.draft("buffer", "x");
    assert_eq!(
        background.turn().ticket.unwrap().effect.lane(),
        w::Lane::Draft
    );
    let mut foreground = Host::new();
    foreground.wake();
    let frozen = foreground.committed.in_flight().unwrap().clone();
    assert_eq!(frozen.priority, c::Priority::Background);
    foreground.request();
    foreground.draft("buffer", "x");
    let selected = foreground.turn().ticket.unwrap();
    assert_eq!(selected.effect, w::ChildEffect::Committed(frozen));
    assert!(foreground.committed.update().has_foreground_demand);
}

#[test]
fn actual_wait_for_wake_with_issued_descriptor_is_executable_not_idle() {
    let mut host = Host::new();
    host.wake();
    let descriptor = host.committed.in_flight().unwrap().clone();
    host.command(c::Input::SourceHint);
    assert_eq!(host.execution, c::Execution::WaitForWake);
    let ticket = host.turn().ticket.unwrap();
    assert_eq!(ticket.effect, w::ChildEffect::Committed(descriptor));
    assert_eq!(
        host.work.admit(&ticket, &host.committed, &host.draft),
        Ok(w::Admission::Execute)
    );
    assert!(matches!(
        host.settle(&ticket, w::Completion::Committed(observed(1, true))),
        w::Settlement::Committed(_)
    ));
}

#[test]
fn continually_eligible_lanes_alternate_one_actual_effect_without_changing_child_policy() {
    let mut host = Host::new();
    host.wake();
    host.draft("buffer", "x");
    let mut seen = Vec::new();
    for c_result in [
        observed(1, false),
        c::EffectResult::Recovered(None),
        c::EffectResult::Stage(stage(1, 0, 2)),
    ] {
        let draft = host.turn().ticket.unwrap();
        seen.push(draft.effect.lane());
        let completion = parsed(&draft, 1);
        host.settle(&draft, w::Completion::Draft(completion));
        let committed = host.turn().ticket.unwrap();
        seen.push(committed.effect.lane());
        host.settle(&committed, w::Completion::Committed(c_result));
    }
    assert_eq!(
        seen,
        vec![
            w::Lane::Draft,
            w::Lane::Committed,
            w::Lane::Draft,
            w::Lane::Committed,
            w::Lane::Draft,
            w::Lane::Committed
        ]
    );
    assert!(matches!(
        host.committed.in_flight().unwrap().kind,
        c::Effect::Pump { .. }
    ));
    assert!(matches!(
        host.draft.in_flight().unwrap().kind,
        d::Effect::ParsePhase {
            phase: ParseFactsPhase::WikiRepairs,
            ..
        }
    ));
}

#[test]
fn selection_observation_and_own_command_changes_do_not_advance_fairness() {
    let mut host = Host::new();
    host.wake();
    host.draft("buffer", "x");
    let selected = host.turn().ticket.unwrap();
    for _ in 0..10 {
        assert_eq!(host.turn().ticket, Some(selected.clone()));
        assert_eq!(host.work.snapshot().last_served, None);
    }
    host.request();
    assert_eq!(host.turn().ticket, Some(selected.clone()));
    assert_eq!(host.work.snapshot().last_served, None);
    host.settle(&selected, w::Completion::Draft(parsed(&selected, 1)));
    assert_eq!(host.work.snapshot().last_served, Some(w::Lane::Draft));
}

#[test]
fn exact_last_ack_retry_does_not_complete_twice_or_advance_to_selected_next_effect() {
    let mut host = Host::new();
    host.wake();
    host.draft("buffer", "x");
    let old = host.turn().ticket.unwrap();
    let completion = parsed(&old, 1);
    host.settle(&old, w::Completion::Draft(completion.clone()));
    let next = host.turn().ticket.unwrap();
    let before = host.work.snapshot();
    let actual = host.draft.snapshot();
    assert_eq!(
        host.work.admit(&old, &host.committed, &host.draft),
        Ok(w::Admission::Replay(w::Lane::Draft))
    );
    assert_eq!(
        host.settle(&old, w::Completion::Draft(completion)),
        w::Settlement::Replay(w::Lane::Draft)
    );
    assert_eq!(host.work.snapshot(), before);
    assert_eq!(host.draft.snapshot(), actual);
    assert_eq!(host.work.snapshot().selected, Some(next.clone()));
    host.settle(&next, w::Completion::Committed(observed(1, false)));
    assert_eq!(
        host.work.admit(&old, &host.committed, &host.draft),
        Err(w::WorkError::WrongTicket)
    );
}

#[test]
fn wrong_incarnation_child_identity_phase_budget_and_result_reject_without_work() {
    let mut host = Host::new();
    host.draft("buffer", "x");
    let selected = host.turn().ticket.unwrap();
    let before = host.work.snapshot();
    let child = host.draft.snapshot();
    let mut wrong = selected.clone();
    wrong.incarnation = id("foreign");
    assert_eq!(
        host.work.admit(&wrong, &host.committed, &host.draft),
        Err(w::WorkError::WrongTicket)
    );
    for kind in 0..5 {
        let mut wrong = selected.clone();
        let w::ChildEffect::Draft(effect) = &mut wrong.effect else {
            panic!("draft");
        };
        match kind {
            0 => effect.id += 1,
            1 => effect.lifetime = id("other"),
            2 => effect.job.tag.text_revision += 1,
            3 => {
                let d::Effect::ParsePhase { phase, .. } = &mut effect.kind else {
                    panic!("phase");
                };
                *phase = ParseFactsPhase::Tags;
            }
            _ => {
                let d::Effect::ParsePhase { budget, .. } = &mut effect.kind else {
                    panic!("budget");
                };
                budget.max_facts_bytes -= 1;
            }
        }
        assert_eq!(
            host.work.admit(&wrong, &host.committed, &host.draft),
            Err(w::WorkError::WrongTicket)
        );
    }
    assert_eq!(
        host.work.settle(
            &selected,
            w::Completion::Committed(c::EffectResult::Done),
            &mut host.committed,
            &mut host.execution,
            &mut host.draft
        ),
        Err(w::WorkError::WrongCompletion)
    );
    let invalid = d::Completion::Parsed(ParseFactsStep {
        completed_phase: ParseFactsPhase::Tags,
        phases_completed: 7,
        ready: true,
        usage: zero(),
    });
    assert_eq!(
        host.work.settle(
            &selected,
            w::Completion::Draft(invalid),
            &mut host.committed,
            &mut host.execution,
            &mut host.draft
        ),
        Err(w::WorkError::Draft(d::RuntimeError::InvalidCompletion))
    );
    assert_eq!(host.work.snapshot(), before);
    assert_eq!(host.draft.snapshot(), child);
}

#[test]
fn single_lane_runs_and_empty_children_never_manufacture_io_or_draft_work() {
    let mut host = Host::new();
    assert_eq!(host.turn().state, w::WorkState::Waiting);
    assert!(host.committed.in_flight().is_none());
    assert!(host.draft.in_flight().is_none());
    host.draft("buffer", "x");
    for _ in 0..7 {
        let t = host.turn().ticket.unwrap();
        assert_eq!(t.effect.lane(), w::Lane::Draft);
        host.settle(&t, w::Completion::Draft(parsed(&t, 1)));
    }
    assert_eq!(host.turn().state, w::WorkState::Waiting);
    host.wake();
    assert_eq!(
        host.turn().ticket.unwrap().effect.lane(),
        w::Lane::Committed
    );
}

#[test]
fn pump_yield_resumes_only_on_next_turn_and_available_draft_runs_between_pumps() {
    let mut host = Host::new();
    host.request();
    host.committed(observed(1, false));
    host.committed(c::EffectResult::Recovered(None));
    host.committed(c::EffectResult::Stage(stage(1, 0, 10)));
    let pump = host.turn().ticket.unwrap();
    assert!(matches!(
        pump.effect,
        w::ChildEffect::Committed(c::IssuedEffect {
            kind: c::Effect::Pump { .. },
            ..
        })
    ));
    host.settle(
        &pump,
        w::Completion::Committed(c::EffectResult::Stage(stage(1, 1, 10))),
    );
    assert_eq!(host.execution, c::Execution::Yield);
    assert!(host.committed.in_flight().is_none());
    assert!(host.work.snapshot().selected.is_none());
    host.draft("buffer", "x");
    let later = host.turn();
    assert!(later.continued.is_some());
    assert_eq!(later.ticket.unwrap().effect.lane(), w::Lane::Draft);
    assert!(matches!(
        host.committed.in_flight().unwrap().kind,
        c::Effect::Pump { .. }
    ));
}

#[test]
fn pure_continuation_preserves_actual_finished_request_outcome() {
    let mut host = Host::new();
    host.wake();
    host.request();
    host.committed(observed(1, true));
    host.committed(observed(1, true));
    assert_eq!(host.execution, c::Execution::Yield);
    host.draft("buffer", "x");
    let turn = host.turn();
    let continued = turn.continued.unwrap();
    assert!(matches!(
        continued.request_outcomes.as_slice(),
        [c::RequestOutcome::Finished { id: 1, .. }]
    ));
    assert_eq!(turn.ticket.unwrap().effect.lane(), w::Lane::Draft);
}

#[test]
fn cancelling_selected_draft_preserves_ticket_and_real_parser_stops_before_any_phase() {
    let mut host = Host::new();
    host.wake();
    let text: Arc<str> = Arc::from("# Heading\n[[Link]]\n");
    let job = host.draft("buffer", &text);
    let ticket = host.turn().ticket.unwrap();
    let mut parser = ParseFactsJob::new(text).unwrap();
    host.draft
        .reduce(d::Input::Cancel {
            client: id("client"),
            job,
        })
        .unwrap();
    assert_eq!(host.turn().ticket, Some(ticket.clone()));
    let w::ChildEffect::Draft(effect) = &ticket.effect else {
        panic!("draft");
    };
    assert!(!host.draft.phase_is_current(effect).unwrap());
    parser.cancel();
    assert_eq!(parser.phases_completed(), 0);
    assert_eq!(parser.usage(), zero());
    host.settle(
        &ticket,
        w::Completion::Draft(d::Completion::Stopped {
            usage: parser.usage(),
            phases_completed: parser.phases_completed(),
        }),
    );
    assert_eq!(
        host.turn().ticket.unwrap().effect.lane(),
        w::Lane::Committed
    );
    assert_eq!(parser.phases_completed(), 0);
}

fn reach(host: &mut Host, kind: &str) {
    if kind == "rebuild" {
        host.command(c::Input::Request(c::FreshnessRequest {
            id: 1,
            max_pumps: 8,
            max_restarts: 1,
            force_rebuild: true,
        }));
        return;
    }
    host.wake();
    if kind == "observe" {
        return;
    }
    if kind == "initialize" {
        host.committed(c::EffectResult::Observed(c::Observation {
            source: source(1),
            published: None,
            current: false,
            rebuild_required: false,
            coverage_complete: None,
        }));
        return;
    }
    host.committed(observed(1, false));
    if kind == "recover" {
        return;
    }
    if kind == "publish" {
        host.committed(c::EffectResult::Recovered(Some(stage(1, 1, 1))));
        return;
    }
    if kind == "discard" {
        host.committed(c::EffectResult::Recovered(Some(stage(0, 0, 1))));
        host.committed(observed(1, false));
        return;
    }
    host.committed(c::EffectResult::Recovered(None));
    if kind == "begin" {
        return;
    }
    host.committed(c::EffectResult::Stage(stage(1, 0, 2)));
}
fn committed_result(effect: &c::IssuedEffect) -> c::EffectResult {
    match &effect.kind {
        c::Effect::Observe => observed(1, true),
        c::Effect::RecoverStage => c::EffectResult::Recovered(None),
        c::Effect::Begin => c::EffectResult::Stage(stage(1, 0, 2)),
        c::Effect::Pump { .. } => c::EffectResult::Stage(stage(1, 1, 2)),
        c::Effect::Publish { snapshot } => c::EffectResult::Published(snapshot.clone()),
        c::Effect::Initialize | c::Effect::Discard { .. } | c::Effect::Rebuild => {
            c::EffectResult::Done
        }
    }
}
#[test]
fn close_preserves_and_drains_each_actual_committed_effect_kind_without_new_work() {
    for kind in [
        "observe",
        "initialize",
        "recover",
        "begin",
        "pump",
        "publish",
        "discard",
        "rebuild",
    ] {
        let mut host = Host::new();
        reach(&mut host, kind);
        let selected = host.turn().ticket.unwrap();
        let w::ChildEffect::Committed(effect) = &selected.effect else {
            panic!("committed");
        };
        let actual_kind = match effect.kind {
            c::Effect::Observe => "observe",
            c::Effect::Initialize => "initialize",
            c::Effect::RecoverStage => "recover",
            c::Effect::Begin => "begin",
            c::Effect::Pump { .. } => "pump",
            c::Effect::Publish { .. } => "publish",
            c::Effect::Discard { .. } => "discard",
            c::Effect::Rebuild => "rebuild",
        };
        assert_eq!(actual_kind, kind);
        host.close();
        assert_eq!(host.work.snapshot().selected, Some(selected.clone()));
        assert!(host.work.snapshot().last_settled.is_none());
        host.settle(
            &selected,
            w::Completion::Committed(committed_result(effect)),
        );
        assert!(host.committed.in_flight().is_none());
        assert_eq!(host.execution, c::Execution::Quiesced);
        let final_turn = host.turn();
        assert_eq!(final_turn.state, w::WorkState::Quiesced);
        assert!(final_turn.ticket.is_none());
        assert!(final_turn.continued.is_none());
        host.close();
        assert_eq!(host.turn().state, w::WorkState::Quiesced);
    }
}

#[test]
fn close_at_every_actual_parser_checkpoint_drains_cancel_and_drop_without_later_phases() {
    for count in 0..=7 {
        let mut host = Host::new();
        let text: Arc<str> = Arc::from("---\naliases: [Whale]\n---\n# 🐋\n[[Link]] #tag\n");
        host.draft("buffer", &text);
        let mut parser = ParseFactsJob::new(text).unwrap();
        for _ in 0..count {
            let ticket = host.turn().ticket.unwrap();
            let w::ChildEffect::Draft(effect) = &ticket.effect else {
                panic!("draft");
            };
            let d::Effect::ParsePhase { budget, .. } = effect.kind else {
                panic!("phase");
            };
            let step = parser.step(budget).unwrap();
            host.settle(&ticket, w::Completion::Draft(d::Completion::Parsed(step)));
        }
        let selected = host.turn().ticket;
        host.close();
        assert_eq!(host.work.snapshot().selected, selected);
        for _ in 0..3 {
            let turn = host.turn();
            let Some(ticket) = turn.ticket else {
                assert_eq!(turn.state, w::WorkState::Quiesced);
                break;
            };
            let w::ChildEffect::Draft(effect) = &ticket.effect else {
                panic!("draft");
            };
            let completion = match effect.kind {
                d::Effect::ParsePhase { .. } => {
                    parser.cancel();
                    d::Completion::Stopped {
                        usage: parser.usage(),
                        phases_completed: parser.phases_completed(),
                    }
                }
                d::Effect::DropJob => {
                    parser.cancel();
                    d::Completion::Dropped
                }
            };
            host.settle(&ticket, w::Completion::Draft(completion));
        }
        assert_eq!(host.turn().state, w::WorkState::Quiesced);
        assert_eq!(parser.phases_completed(), count);
        assert_eq!(parser.usage(), zero());
        assert_eq!(host.draft.usage(), zero());
    }
}

#[test]
fn close_drains_pending_upload_ready_facts_and_both_child_descriptors() {
    let mut host = Host::new();
    host.draft("ready", "x");
    for _ in 0..7 {
        let t = host.turn().ticket.unwrap();
        host.settle(&t, w::Completion::Draft(parsed(&t, 1)));
    }
    // An admitted but unsealed upload is also retained, with no parser phase.
    let upload = d::DraftRequest {
        tag: d::DraftTag {
            buffer: d::BufferKey {
                client: id("client"),
                buffer_lifetime: id("upload"),
            },
            text_revision: 1,
        },
        source: d::SourceDescriptor {
            bytes: 16,
            utf16: 16,
            sha256: [8; 32],
        },
    };
    host.draft.reduce(d::Input::Request(upload)).unwrap();
    host.wake();
    host.close();
    let mut lanes = Vec::new();
    for _ in 0..4 {
        let turn = host.turn();
        let Some(ticket) = turn.ticket else {
            assert_eq!(turn.state, w::WorkState::Quiesced);
            break;
        };
        lanes.push(ticket.effect.lane());
        let completion = match &ticket.effect {
            w::ChildEffect::Committed(effect) => w::Completion::Committed(committed_result(effect)),
            w::ChildEffect::Draft(effect) => {
                assert_eq!(effect.kind, d::Effect::DropJob);
                w::Completion::Draft(d::Completion::Dropped)
            }
        };
        host.settle(&ticket, completion);
    }
    assert_eq!(
        lanes
            .iter()
            .filter(|lane| **lane == w::Lane::Committed)
            .count(),
        1
    );
    assert_eq!(
        lanes.iter().filter(|lane| **lane == w::Lane::Draft).count(),
        2
    );
    assert_eq!(host.draft.usage(), zero());
    assert_eq!(host.turn().state, w::WorkState::Quiesced);
}

#[test]
fn scoped_buffer_release_preserves_other_client_and_the_committed_lane() {
    let mut host = Host::new();
    host.wake();
    let old = host.draft("old", "x");
    let other = d::DraftRequest {
        tag: d::DraftTag {
            buffer: d::BufferKey {
                client: id("other-client"),
                buffer_lifetime: id("other-buffer"),
            },
            text_revision: 1,
        },
        source: d::SourceDescriptor {
            bytes: 1,
            utf16: 1,
            sha256: [9; 32],
        },
    };
    let other_token = host
        .draft
        .reduce(d::Input::Request(other.clone()))
        .unwrap()
        .admitted
        .unwrap();
    host.draft
        .reduce(d::Input::Seal {
            job: other_token.clone(),
            actual: other.source,
        })
        .unwrap();
    let selected = host.turn().ticket.unwrap();
    host.draft
        .reduce(d::Input::ReleaseBuffer(old.tag.buffer))
        .unwrap();
    assert_eq!(host.turn().ticket, Some(selected.clone()));
    host.settle(
        &selected,
        w::Completion::Draft(d::Completion::Stopped {
            usage: zero(),
            phases_completed: 0,
        }),
    );
    let committed = host.turn().ticket.unwrap();
    assert_eq!(committed.effect.lane(), w::Lane::Committed);
    host.settle(&committed, w::Completion::Committed(observed(1, true)));
    let drop = host.turn().ticket.unwrap();
    assert!(matches!(
        drop.effect,
        w::ChildEffect::Draft(d::IssuedEffect {
            kind: d::Effect::DropJob,
            ..
        })
    ));
    host.settle(&drop, w::Completion::Draft(d::Completion::Dropped));
    let next = host.turn().ticket.unwrap();
    let w::ChildEffect::Draft(effect) = next.effect else {
        panic!("draft");
    };
    assert_eq!(effect.job, other_token);
    assert!(!host.work.snapshot().closing);
}

#[test]
fn authoritative_child_replacement_expires_selection_and_requires_new_incarnation() {
    let mut host = Host::new();
    host.wake();
    let old = host.turn().ticket.unwrap();
    host.committed = c::DocumentRuntime::new(c::RuntimeIdentity {
        lifetime: id("replacement"),
        local_store: id("store"),
        versions: versions(),
    });
    host.execution = c::Execution::WaitForWake;
    let before = host.work.snapshot();
    assert_eq!(
        host.work.admit(&old, &host.committed, &host.draft),
        Err(w::WorkError::ExpiredChild)
    );
    assert_eq!(
        host.work
            .select_next_turn(&mut host.committed, &mut host.execution, &host.draft),
        Err(w::WorkError::ExpiredChild)
    );
    assert_eq!(host.work.snapshot(), before);
    host.work = w::DocumentWorkRuntime::new(id("replacement-incarnation"));
    assert_eq!(
        host.work.admit(&old, &host.committed, &host.draft),
        Err(w::WorkError::WrongTicket)
    );
    host.wake();
    assert_ne!(host.turn().ticket.unwrap().incarnation, old.incarnation);
}
