// The public library export stays with the main integration owner.
#[path = "../src/draft_runtime.rs"]
mod draft_runtime;
use draft_runtime::*;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::{ParseFactsJob, ParseFactsPhase, ParseFactsStep, ParseFactsUsage};

fn id(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn runtime() -> DraftRuntime {
    DraftRuntime::new(id("runtime"))
}
fn descriptor(source: &str) -> SourceDescriptor {
    SourceDescriptor {
        bytes: source.len(),
        utf16: source.encode_utf16().count(),
        sha256: Sha256::digest(source.as_bytes()).into(),
    }
}
fn request(client: &str, buffer: &str, revision: u64, source: &str) -> DraftRequest {
    DraftRequest {
        tag: DraftTag {
            buffer: BufferKey {
                client: id(client),
                buffer_lifetime: id(buffer),
            },
            text_revision: revision,
        },
        source: descriptor(source),
    }
}
fn admit(runtime: &mut DraftRuntime, request: &DraftRequest) -> JobToken {
    runtime
        .reduce(Input::Request(request.clone()))
        .unwrap()
        .admitted
        .unwrap()
}
fn seal(runtime: &mut DraftRuntime, token: &JobToken, source: &SourceDescriptor) {
    runtime
        .reduce(Input::Seal {
            job: token.clone(),
            actual: source.clone(),
        })
        .unwrap();
}
fn complete(runtime: &mut DraftRuntime, completion: Completion) -> Reduction {
    let effect = runtime.in_flight().unwrap().clone();
    runtime
        .reduce(Input::Complete { effect, completion })
        .unwrap()
}
fn parsed(runtime: &mut DraftRuntime, source: usize, scratch: usize, facts: usize) -> Reduction {
    let Effect::ParsePhase {
        phase,
        phases_completed,
        ..
    } = runtime.in_flight().unwrap().kind
    else {
        panic!("expected parse");
    };
    let ready = phase == ParseFactsPhase::Tags;
    complete(
        runtime,
        Completion::Parsed(ParseFactsStep {
            completed_phase: phase,
            phases_completed: phases_completed + 1,
            ready,
            usage: ParseFactsUsage {
                source_bytes: if ready { 0 } else { source },
                scratch_bytes: if ready { 0 } else { scratch },
                facts_bytes: facts,
            },
        }),
    )
}
fn dropped(runtime: &mut DraftRuntime) -> Reduction {
    assert_eq!(runtime.in_flight().unwrap().kind, Effect::DropJob);
    complete(runtime, Completion::Dropped)
}
fn ready(runtime: &mut DraftRuntime, source: usize, facts: usize) {
    for _ in 0..7 {
        parsed(runtime, source, 0, facts);
    }
    assert!(runtime.in_flight().is_none());
}
fn zero() -> ParseFactsUsage {
    ParseFactsUsage {
        source_bytes: 0,
        scratch_bytes: 0,
        facts_bytes: 0,
    }
}
fn outcome<'a>(reduction: &'a Reduction, token: &JobToken) -> &'a OutcomeKind {
    &reduction
        .outcomes
        .iter()
        .find(|o| o.job == *token)
        .unwrap()
        .kind
}

#[test]
fn input_is_reserved_before_upload_and_mismatched_seal_is_unchanged() {
    let mut runtime = runtime();
    let request = request("client", "buffer", 1, "🐋\r\n");
    let token = admit(&mut runtime, &request);
    assert_eq!(runtime.usage().source_bytes, request.source.bytes);
    assert_eq!(runtime.snapshot().execution, Execution::WaitForInput);
    assert!(runtime.in_flight().is_none());
    let before = runtime.snapshot();
    let mut wrong = request.source.clone();
    wrong.sha256[0] ^= 1;
    assert_eq!(
        runtime.reduce(Input::Seal {
            job: token.clone(),
            actual: wrong
        }),
        Err(RuntimeError::SourceMismatch)
    );
    assert_eq!(runtime.snapshot(), before);
    seal(&mut runtime, &token, &request.source);
    assert!(matches!(
        runtime.in_flight().unwrap().kind,
        Effect::ParsePhase {
            phase: ParseFactsPhase::Positions,
            ..
        }
    ));
}

#[test]
fn two_view_attachments_share_exact_revision_and_different_source_conflicts() {
    let mut runtime = runtime();
    let request = request("client", "buffer", 7, "# Heading");
    let first = admit(&mut runtime, &request);
    seal(&mut runtime, &first, &request.source);
    let before = runtime.snapshot();
    let second = runtime.reduce(Input::Request(request.clone())).unwrap();
    assert!(second.replay);
    assert_eq!(second.admitted, Some(first));
    assert_eq!(second.in_flight, before.in_flight);
    assert_eq!(second.usage, before.usage);
    let mut wrong = request;
    wrong.source.sha256[0] ^= 1;
    assert_eq!(
        runtime.reduce(Input::Request(wrong)),
        Err(RuntimeError::Conflict)
    );
    assert_eq!(runtime.snapshot(), before);
}

#[test]
fn superseded_upload_keeps_reservation_until_actual_drop_and_never_seals() {
    let mut runtime = runtime();
    let old = request("client", "buffer", 1, "old");
    let old_token = admit(&mut runtime, &old);
    let new = request("client", "buffer", 2, "newer");
    let new_token = admit(&mut runtime, &new);
    assert_eq!(runtime.usage().source_bytes, 8);
    assert_eq!(runtime.in_flight().unwrap().job, old_token);
    assert_eq!(
        runtime.reduce(Input::Seal {
            job: old_token.clone(),
            actual: old.source
        }),
        Err(RuntimeError::Expired)
    );
    assert_eq!(
        outcome(&runtime.snapshot(), &old_token),
        &OutcomeKind::Superseded
    );
    dropped(&mut runtime);
    assert_eq!(runtime.usage().source_bytes, 5);
    seal(&mut runtime, &new_token, &new.source);
    assert_eq!(runtime.in_flight().unwrap().job, new_token);
}

#[test]
fn actual_cancel_at_each_phase_stops_remaining_parser_work_instead_of_dropping_reply() {
    let source: Arc<str> =
        Arc::from("---\naliases: [Ocean]\n---\n# 🐋 Heading\r\n[[Note]] #tag\n- [ ] task\n");
    for completed_count in 0..7 {
        let mut runtime = runtime();
        let request = request("client", "buffer", 1, &source);
        let token = admit(&mut runtime, &request);
        seal(&mut runtime, &token, &request.source);
        let mut parser = ParseFactsJob::new(source.clone()).unwrap();
        for _ in 0..completed_count {
            let Effect::ParsePhase { phase, budget, .. } = runtime.in_flight().unwrap().kind else {
                panic!("expected parse");
            };
            assert_eq!(parser.phase(), phase);
            let step = parser.step(budget).unwrap();
            complete(&mut runtime, Completion::Parsed(step));
        }
        assert_eq!(parser.phases_completed(), completed_count);
        let issued = runtime.in_flight().unwrap().clone();
        runtime
            .reduce(Input::Cancel {
                client: id("client"),
                job: token.clone(),
            })
            .unwrap();
        assert!(!runtime.phase_is_current(&issued).unwrap());
        parser.cancel();
        assert_eq!(parser.usage(), zero());
        // Repeated work requests fail and the actual parser counter stays fixed.
        if let Effect::ParsePhase { budget, .. } = issued.kind {
            assert!(parser.step(budget).is_err());
        }
        assert_eq!(parser.phases_completed(), completed_count);
        complete(
            &mut runtime,
            Completion::Stopped {
                usage: parser.usage(),
                phases_completed: parser.phases_completed(),
            },
        );
        let final_state = dropped(&mut runtime);
        assert_eq!(outcome(&final_state, &token), &OutcomeKind::Cancelled);
        assert!(final_state.in_flight.is_none());
        assert_eq!(final_state.usage, zero());
    }
}

#[test]
fn round_robin_gives_each_sealed_buffer_one_phase_per_turn() {
    let mut runtime = runtime();
    let a = request("one", "buffer", 1, "a");
    let b = request("two", "buffer", 1, "b");
    let a_token = admit(&mut runtime, &a);
    seal(&mut runtime, &a_token, &a.source);
    let b_token = admit(&mut runtime, &b);
    seal(&mut runtime, &b_token, &b.source);
    let mut seen = Vec::new();
    for _ in 0..6 {
        let e = runtime.in_flight().unwrap();
        let Effect::ParsePhase { phase, .. } = e.kind else {
            panic!("parse");
        };
        seen.push((e.job.clone(), phase));
        parsed(&mut runtime, 1, 1, 1);
    }
    assert_eq!(
        seen,
        vec![
            (a_token.clone(), ParseFactsPhase::Positions),
            (b_token.clone(), ParseFactsPhase::Positions),
            (a_token.clone(), ParseFactsPhase::Frontmatter),
            (b_token.clone(), ParseFactsPhase::Frontmatter),
            (a_token, ParseFactsPhase::InitialMaskAndComments),
            (b_token, ParseFactsPhase::InitialMaskAndComments)
        ]
    );
}

#[test]
fn wrong_client_cannot_cancel_or_ack_another_buffer() {
    let mut runtime = runtime();
    let request = request("owner", "buffer", 1, "x");
    let token = admit(&mut runtime, &request);
    let before = runtime.snapshot();
    assert_eq!(
        runtime.reduce(Input::Cancel {
            client: id("foreign"),
            job: token.clone()
        }),
        Err(RuntimeError::ForeignOwner)
    );
    assert_eq!(
        runtime.reduce(Input::Acknowledge {
            client: id("foreign"),
            job: token.clone()
        }),
        Err(RuntimeError::ForeignOwner)
    );
    assert_eq!(
        runtime.reduce(Input::Acknowledge {
            client: id("owner"),
            job: token
        }),
        Err(RuntimeError::InvalidAcknowledgement)
    );
    assert_eq!(runtime.snapshot(), before);
}

#[test]
fn wrong_effect_tag_phase_counter_and_resource_usage_reject_without_mutation() {
    let mut runtime = runtime();
    let request = request("client", "buffer", 1, "x");
    let token = admit(&mut runtime, &request);
    seal(&mut runtime, &token, &request.source);
    let before = runtime.snapshot();
    let effect = runtime.in_flight().unwrap().clone();
    let valid = ParseFactsStep {
        completed_phase: ParseFactsPhase::Positions,
        phases_completed: 1,
        ready: false,
        usage: ParseFactsUsage {
            source_bytes: 1,
            scratch_bytes: 2,
            facts_bytes: 3,
        },
    };
    let mut wrong_effect = effect.clone();
    wrong_effect.job.tag.text_revision = 2;
    assert_eq!(
        runtime.reduce(Input::Complete {
            effect: wrong_effect,
            completion: Completion::Parsed(valid)
        }),
        Err(RuntimeError::InvalidCompletion)
    );
    let wrong_phase = ParseFactsStep {
        completed_phase: ParseFactsPhase::Tags,
        phases_completed: 1,
        ready: true,
        usage: zero(),
    };
    assert_eq!(
        runtime.reduce(Input::Complete {
            effect: effect.clone(),
            completion: Completion::Parsed(wrong_phase)
        }),
        Err(RuntimeError::InvalidCompletion)
    );
    assert_eq!(
        runtime.reduce(Input::Complete {
            effect: effect.clone(),
            completion: Completion::Resource {
                usage: ParseFactsUsage {
                    source_bytes: 1,
                    scratch_bytes: 0,
                    facts_bytes: 0
                },
                phases_completed: 0
            }
        }),
        Err(RuntimeError::InvalidUsage)
    );
    assert_eq!(runtime.snapshot(), before);
    parsed(&mut runtime, 1, 2, 3);
    assert_eq!(
        runtime.reduce(Input::Complete {
            effect,
            completion: Completion::Dropped
        }),
        Err(RuntimeError::InvalidCompletion)
    );
}

#[test]
fn partial_facts_saturation_terminates_resource_job_and_other_buffer_can_finish() {
    let mut runtime = runtime();
    let a = request("a", "buffer", 1, "a");
    let b = request("b", "buffer", 1, "b");
    let at = admit(&mut runtime, &a);
    seal(&mut runtime, &at, &a.source);
    let bt = admit(&mut runtime, &b);
    seal(&mut runtime, &bt, &b.source);
    parsed(&mut runtime, 1, 1, MAX_DRAFT_FACTS_BYTES / 2);
    parsed(&mut runtime, 1, 1, MAX_DRAFT_FACTS_BYTES / 2);
    let effect = runtime.in_flight().unwrap();
    assert_eq!(effect.job, at);
    let Effect::ParsePhase {
        budget,
        phases_completed,
        ..
    } = effect.kind
    else {
        panic!("parse");
    };
    assert_eq!(budget.max_facts_bytes, MAX_DRAFT_FACTS_BYTES / 2);
    complete(
        &mut runtime,
        Completion::Resource {
            usage: zero(),
            phases_completed,
        },
    );
    assert_eq!(runtime.in_flight().unwrap().kind, Effect::DropJob);
    dropped(&mut runtime);
    assert_eq!(runtime.in_flight().unwrap().job, bt);
    let Effect::ParsePhase { budget, .. } = runtime.in_flight().unwrap().kind else {
        panic!("parse");
    };
    assert_eq!(budget.max_facts_bytes, MAX_DRAFT_FACTS_BYTES);
    for _ in 0..6 {
        parsed(&mut runtime, 1, 1, MAX_DRAFT_FACTS_BYTES / 2);
    }
    assert_eq!(
        outcome(&runtime.snapshot(), &at),
        &OutcomeKind::Unavailable(UnavailableCode::Resource)
    );
    assert_eq!(outcome(&runtime.snapshot(), &bt), &OutcomeKind::Ready);
}

#[test]
fn completed_facts_backpressure_until_own_ack_releases_then_next_buffer_runs() {
    let mut runtime = runtime();
    let a = request("a", "buffer", 1, "a");
    let at = admit(&mut runtime, &a);
    seal(&mut runtime, &at, &a.source);
    ready(&mut runtime, 1, MAX_DRAFT_FACTS_BYTES);
    let b = request("b", "buffer", 1, "b");
    let bt = admit(&mut runtime, &b);
    seal(&mut runtime, &bt, &b.source);
    assert_eq!(
        runtime.snapshot().execution,
        Execution::WaitForAcknowledgement
    );
    assert!(runtime.in_flight().is_none());
    runtime
        .reduce(Input::Acknowledge {
            client: id("a"),
            job: at,
        })
        .unwrap();
    assert_eq!(runtime.usage().facts_bytes, MAX_DRAFT_FACTS_BYTES);
    dropped(&mut runtime);
    assert_eq!(runtime.usage().facts_bytes, 0);
    assert_eq!(runtime.in_flight().unwrap().job, bt);
}

#[test]
fn ready_result_cancel_releases_capacity_without_exposing_old_facts_as_current() {
    let mut runtime = runtime();
    let a = request("a", "buffer", 1, "a");
    let at = admit(&mut runtime, &a);
    seal(&mut runtime, &at, &a.source);
    ready(&mut runtime, 1, MAX_DRAFT_FACTS_BYTES);
    let cancelled = runtime
        .reduce(Input::Cancel {
            client: id("a"),
            job: at.clone(),
        })
        .unwrap();
    assert_eq!(outcome(&cancelled, &at), &OutcomeKind::Cancelled);
    assert_eq!(cancelled.usage.facts_bytes, MAX_DRAFT_FACTS_BYTES);
    dropped(&mut runtime);
    assert_eq!(runtime.usage(), zero());
    let ack = runtime
        .reduce(Input::Acknowledge {
            client: id("a"),
            job: at,
        })
        .unwrap();
    assert!(ack.in_flight.is_none());
    assert!(ack.outcomes.is_empty());
}

#[test]
fn late_old_ready_completion_is_settled_then_dropped_without_ready_publication() {
    let mut runtime = runtime();
    let old = request("client", "buffer", 1, "old");
    let ot = admit(&mut runtime, &old);
    seal(&mut runtime, &ot, &old.source);
    for _ in 0..6 {
        parsed(&mut runtime, 3, 1, 4);
    }
    let new = request("client", "buffer", 2, "new");
    let nt = admit(&mut runtime, &new);
    seal(&mut runtime, &nt, &new.source);
    let settled = parsed(&mut runtime, 3, 0, MAX_DRAFT_FACTS_BYTES);
    assert_eq!(outcome(&settled, &ot), &OutcomeKind::Superseded);
    assert_eq!(settled.usage.facts_bytes, MAX_DRAFT_FACTS_BYTES);
    assert_eq!(settled.in_flight.unwrap().kind, Effect::DropJob);
    dropped(&mut runtime);
    assert_eq!(runtime.in_flight().unwrap().job, nt);
}

#[test]
fn source_pool_rejects_before_retention_and_cancel_drop_restores_capacity() {
    let mut runtime = runtime();
    let mut a = request("a", "buffer", 1, "x");
    a.source.bytes = MAX_DRAFT_SOURCE_BYTES;
    a.source.utf16 = MAX_DRAFT_SOURCE_BYTES;
    let mut b = a.clone();
    b.tag.buffer.client = id("b");
    let at = admit(&mut runtime, &a);
    admit(&mut runtime, &b);
    let c = request("c", "buffer", 1, "x");
    let before = runtime.snapshot();
    assert_eq!(
        runtime.reduce(Input::Request(c.clone())),
        Err(RuntimeError::Capacity)
    );
    assert_eq!(runtime.snapshot(), before);
    runtime
        .reduce(Input::Cancel {
            client: id("a"),
            job: at,
        })
        .unwrap();
    assert_eq!(runtime.usage().source_bytes, MAX_DRAFT_INPUT_BYTES);
    dropped(&mut runtime);
    admit(&mut runtime, &c);
    assert_eq!(runtime.usage().source_bytes, MAX_DRAFT_SOURCE_BYTES + 1);
}

#[test]
fn thirty_two_unacked_requests_are_bounded_and_client_release_drains_without_subscribers() {
    let mut runtime = runtime();
    for n in 0..32 {
        let request = request("client", &format!("b{n}"), 1, "");
        admit(&mut runtime, &request);
    }
    let before = runtime.snapshot();
    assert_eq!(
        runtime.reduce(Input::Request(request("client", "extra", 1, ""))),
        Err(RuntimeError::Capacity)
    );
    assert_eq!(runtime.snapshot(), before);
    runtime.reduce(Input::ReleaseClient(id("client"))).unwrap();
    for _ in 0..32 {
        dropped(&mut runtime);
    }
    assert_eq!(runtime.snapshot().execution, Execution::Idle);
    assert_eq!(runtime.usage(), zero());
    assert!(runtime.snapshot().outcomes.is_empty());
    admit(&mut runtime, &request("another", "extra", 1, ""));
}

#[test]
fn release_one_buffer_preserves_other_client_and_rejects_late_completion() {
    let mut runtime = runtime();
    let a = request("a", "buffer", 1, "a");
    let b = request("b", "buffer", 1, "b");
    let at = admit(&mut runtime, &a);
    seal(&mut runtime, &at, &a.source);
    let bt = admit(&mut runtime, &b);
    seal(&mut runtime, &bt, &b.source);
    let old = runtime.in_flight().unwrap().clone();
    runtime
        .reduce(Input::ReleaseBuffer(at.tag.buffer.clone()))
        .unwrap();
    complete(
        &mut runtime,
        Completion::Stopped {
            usage: zero(),
            phases_completed: 0,
        },
    );
    dropped(&mut runtime);
    assert_eq!(runtime.in_flight().unwrap().job, bt);
    let before = runtime.snapshot();
    assert_eq!(
        runtime.reduce(Input::Complete {
            effect: old,
            completion: Completion::Stopped {
                usage: zero(),
                phases_completed: 0
            }
        }),
        Err(RuntimeError::InvalidCompletion)
    );
    assert_eq!(runtime.snapshot(), before);
}

#[test]
fn retirement_drains_one_issued_phase_and_all_payloads_without_listener_ack() {
    let mut runtime = runtime();
    let a = request("a", "buffer", 1, "a");
    let at = admit(&mut runtime, &a);
    seal(&mut runtime, &at, &a.source);
    admit(&mut runtime, &request("b", "other", 1, "x"));
    runtime.reduce(Input::Retire).unwrap();
    assert!(!runtime
        .phase_is_current(runtime.in_flight().unwrap())
        .unwrap());
    complete(
        &mut runtime,
        Completion::Stopped {
            usage: zero(),
            phases_completed: 0,
        },
    );
    dropped(&mut runtime);
    let closed = dropped(&mut runtime);
    assert_eq!(closed.execution, Execution::Quiesced);
    assert_eq!(closed.usage, zero());
    assert!(closed.outcomes.is_empty());
    assert_eq!(
        runtime.reduce(Input::Request(request("c", "new", 1, "x"))),
        Err(RuntimeError::Retired)
    );
    assert_eq!(
        runtime.reduce(Input::Continue).unwrap().execution,
        Execution::Quiesced
    );
}

#[test]
fn acknowledged_revision_cannot_be_replayed_or_replaced_by_lower_revision() {
    let mut runtime = runtime();
    let request = request("client", "buffer", 9, "x");
    let token = admit(&mut runtime, &request);
    runtime
        .reduce(Input::Cancel {
            client: id("client"),
            job: token.clone(),
        })
        .unwrap();
    dropped(&mut runtime);
    runtime
        .reduce(Input::Acknowledge {
            client: id("client"),
            job: token,
        })
        .unwrap();
    assert_eq!(
        runtime.reduce(Input::Request(request.clone())),
        Err(RuntimeError::Expired)
    );
    let mut lower = request.clone();
    lower.tag.text_revision = 8;
    assert_eq!(
        runtime.reduce(Input::Request(lower)),
        Err(RuntimeError::StaleRevision)
    );
    let mut higher = request;
    higher.tag.text_revision = 10;
    admit(&mut runtime, &higher);
}
