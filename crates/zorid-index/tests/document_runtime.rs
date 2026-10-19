// Compile the owned module directly until the shared lib export is integrated.
// Its crate-relative imports resolve to these existing public identity types.
use zorid_index::{IndexSnapshotId, SemanticVersions, SourceSnapshotId, SourceWatermark};
#[path = "../src/document_runtime.rs"]
mod document_runtime;
use document_runtime::*;
use zorid_core::OperationId;

fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn versions() -> SemanticVersions {
    SemanticVersions::new(2, "extract", "resolver", "query").unwrap()
}
fn source(n: u64) -> SourceSnapshotId {
    SourceSnapshotId::new(op("store"), SourceWatermark::new(n.to_string()).unwrap())
}
fn snapshot(n: u64) -> IndexSnapshotId {
    IndexSnapshotId::new(op("store"), op("epoch"), n, versions()).unwrap()
}
fn runtime() -> DocumentRuntime {
    DocumentRuntime::new(RuntimeIdentity {
        lifetime: op("lifetime"),
        local_store: op("store"),
        versions: versions(),
    })
}
fn status(n: u64, published: Option<u64>, current: bool) -> EffectResult {
    EffectResult::Observed(Observation {
        source: source(n),
        published: published.map(snapshot),
        current,
        rebuild_required: false,
        coverage_complete: published.map(|_| true),
    })
}
fn stage(n: u64, prepared: u32, total: u32) -> StageObservation {
    StageObservation {
        source: source(n),
        snapshot: snapshot(2),
        progress: Some(StageProgress {
            prepared,
            total,
            ready: prepared == total,
        }),
    }
}
fn complete(r: &mut DocumentRuntime, result: EffectResult) -> Reduction {
    let e = r.in_flight().unwrap().clone();
    r.reduce(Input::Complete {
        lifetime: e.lifetime,
        effect_id: e.id,
        result,
    })
    .unwrap()
}
fn wake(r: &mut DocumentRuntime) -> Reduction {
    r.reduce(Input::Wake { monotonic_ms: 0 }).unwrap()
}
fn request(r: &mut DocumentRuntime, id: u64, pumps: u8) -> Reduction {
    r.reduce(Input::Request(FreshnessRequest {
        id,
        max_pumps: pumps,
        max_restarts: 1,
        force_rebuild: false,
    }))
    .unwrap()
}
fn expect(r: &DocumentRuntime, effect: Effect) {
    assert_eq!(r.in_flight().unwrap().kind, effect);
}
fn begin(r: &mut DocumentRuntime, total: u32) {
    expect(r, Effect::Observe);
    complete(r, status(1, Some(1), false));
    expect(r, Effect::RecoverStage);
    complete(r, EffectResult::Recovered(None));
    expect(r, Effect::Begin);
    complete(r, EffectResult::Stage(stage(1, 0, total)));
    expect(
        r,
        Effect::Pump {
            snapshot: snapshot(2),
        },
    );
}

#[test]
fn hundreds_of_hints_coalesce_and_observation_registration_race_is_closed() {
    let mut r = runtime();
    wake(&mut r);
    let effect = r.in_flight().unwrap().clone();
    let first_revision = r.update().revision;
    for _ in 0..500 {
        let reduction = r.reduce(Input::SourceHint).unwrap();
        assert!(reduction.effect.is_none());
    }
    assert_eq!(r.update().revision, first_revision);
    assert_eq!(r.in_flight(), Some(&effect));
    let reduction = complete(&mut r, status(1, Some(1), true));
    assert_eq!(reduction.effect.unwrap().kind, Effect::Observe);
    let revision = r.update().revision;
    let done = complete(&mut r, status(2, Some(1), false));
    assert!(matches!(done.effect.unwrap().kind, Effect::RecoverStage));
    assert!(r.update().revision > revision);
    assert_eq!(r.update().source, Some(source(2)));
}

#[test]
fn invalid_completion_is_an_exact_no_mutation_rejection() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    let e = r.in_flight().unwrap().clone();
    let before = format!("{r:?}");
    for (lifetime, id, result) in [
        (op("old-lifetime"), e.id, status(1, Some(1), true)),
        (e.lifetime.clone(), e.id + 1, status(1, Some(1), true)),
        (e.lifetime.clone(), e.id, EffectResult::Done),
        (
            e.lifetime.clone(),
            e.id,
            EffectResult::Observed(Observation {
                source: SourceSnapshotId::new(
                    op("other-store"),
                    SourceWatermark::new("1").unwrap(),
                ),
                published: None,
                current: false,
                rebuild_required: false,
                coverage_complete: None,
            }),
        ),
    ] {
        assert_eq!(
            r.reduce(Input::Complete {
                lifetime,
                effect_id: id,
                result
            }),
            Err(RuntimeError::UnexpectedCompletion)
        );
        assert_eq!(format!("{r:?}"), before);
    }
}

#[test]
fn wrong_stage_source_version_and_regressing_progress_do_not_mutate() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    begin(&mut r, 10);
    let e = r.in_flight().unwrap().clone();
    let before = format!("{r:?}");
    let mut wrong_version = stage(1, 1, 10);
    wrong_version.snapshot = IndexSnapshotId::new(
        op("store"),
        op("epoch"),
        2,
        SemanticVersions::new(2, "other", "resolver", "query").unwrap(),
    )
    .unwrap();
    for s in [stage(2, 1, 10), wrong_version, stage(1, 2, 11)] {
        assert_eq!(
            r.reduce(Input::Complete {
                lifetime: e.lifetime.clone(),
                effect_id: e.id,
                result: EffectResult::Stage(s)
            }),
            Err(RuntimeError::UnexpectedCompletion)
        );
        assert_eq!(format!("{r:?}"), before);
    }
    complete(&mut r, EffectResult::Stage(stage(1, 3, 10)));
    wake(&mut r);
    complete(&mut r, status(1, Some(1), false));
    let e = r.in_flight().unwrap().clone();
    let before = format!("{r:?}");
    assert_eq!(
        r.reduce(Input::Complete {
            lifetime: e.lifetime,
            effect_id: e.id,
            result: EffectResult::Stage(stage(1, 2, 10))
        }),
        Err(RuntimeError::UnexpectedCompletion)
    );
    assert_eq!(format!("{r:?}"), before);
}

#[test]
fn first_foreground_budget_is_shared_and_exhaustion_does_not_reset() {
    let mut r = runtime();
    request(&mut r, 1, 3);
    begin(&mut r, 10);
    request(&mut r, 2, 1);
    for n in 1..=3 {
        let result = complete(&mut r, EffectResult::Stage(stage(1, n, 10)));
        assert_eq!(result.execution, Execution::Yield);
        assert!(result.effect.is_none());
        wake(&mut r);
        expect(&r, Effect::Observe);
        let observed = complete(&mut r, status(1, Some(1), false));
        if n < 3 {
            expect(
                &r,
                Effect::Pump {
                    snapshot: snapshot(2),
                },
            );
            assert!(observed.request_outcomes.is_empty());
        } else {
            assert!(observed.effect.is_none());
            assert_eq!(observed.execution, Execution::Yield);
            assert_eq!(observed.request_outcomes.len(), 2);
            assert!(observed.request_outcomes.iter().all(|o| matches!(
                o,
                RequestOutcome::Finished {
                    observation: Observation { current: false, .. },
                    ..
                }
            )));
        }
    }
    assert_eq!(r.stage().unwrap().progress.as_ref().unwrap().prepared, 3);
    assert_eq!(r.request_count(), 0);
}

#[test]
fn foreground_joining_background_gets_its_own_budget_after_one_quantum() {
    let mut r = runtime();
    wake(&mut r);
    begin(&mut r, 10);
    assert_eq!(r.in_flight().unwrap().priority, Priority::Background);
    request(&mut r, 1, 2);
    complete(&mut r, EffectResult::Stage(stage(1, 1, 10)));
    wake(&mut r);
    let done_background = complete(&mut r, status(1, Some(1), false));
    assert!(done_background.request_outcomes.is_empty());
    assert_eq!(r.request_count(), 1);
    wake(&mut r);
    complete(&mut r, status(1, Some(1), false));
    assert_eq!(r.in_flight().unwrap().priority, Priority::Foreground);
    for n in 2..=3 {
        complete(&mut r, EffectResult::Stage(stage(1, n, 10)));
        wake(&mut r);
        let observed = complete(&mut r, status(1, Some(1), false));
        if n == 3 {
            assert_eq!(observed.request_outcomes.len(), 1);
        }
    }
}

#[test]
fn cancellation_detaches_one_demand_and_preserves_durable_progress() {
    let mut r = runtime();
    request(&mut r, 1, 2);
    begin(&mut r, 3);
    request(&mut r, 2, 1);
    let cancel = r.reduce(Input::CancelRequest { id: 1 }).unwrap();
    assert_eq!(
        cancel.request_outcomes,
        vec![RequestOutcome::Cancelled { id: 1 }]
    );
    assert_eq!(r.request_count(), 1);
    r.reduce(Input::CancelRequest { id: 2 }).unwrap();
    complete(&mut r, EffectResult::Stage(stage(1, 1, 3)));
    assert_eq!(r.stage().unwrap().progress.as_ref().unwrap().prepared, 1);
    wake(&mut r);
    complete(&mut r, status(1, Some(1), false));
    assert_eq!(r.in_flight().unwrap().priority, Priority::Background);
}

#[test]
fn ready_last_pump_publishes_even_when_budget_was_consumed() {
    let mut r = runtime();
    request(&mut r, 1, 1);
    begin(&mut r, 1);
    complete(&mut r, EffectResult::Stage(stage(1, 1, 1)));
    wake(&mut r);
    complete(&mut r, status(1, Some(1), false));
    expect(
        &r,
        Effect::Publish {
            snapshot: snapshot(2),
        },
    );
    complete(&mut r, EffectResult::Published(snapshot(2)));
    expect(&r, Effect::Observe);
    let done = complete(&mut r, status(1, Some(2), true));
    assert!(matches!(
        done.request_outcomes.as_slice(),
        [RequestOutcome::Finished {
            id: 1,
            observation: Observation { current: true, .. }
        }]
    ));
}

#[test]
fn lost_publication_ack_is_recognized_even_after_source_moves() {
    let mut r = runtime();
    request(&mut r, 1, 1);
    begin(&mut r, 1);
    complete(&mut r, EffectResult::Stage(stage(1, 1, 1)));
    wake(&mut r);
    complete(&mut r, status(1, Some(1), false));
    complete(&mut r, EffectResult::Failed(Failure::Uncertain));
    expect(&r, Effect::Observe);
    let result = complete(&mut r, status(2, Some(2), false));
    assert!(r.stage().is_none());
    assert_eq!(result.request_outcomes.len(), 1);
    assert!(matches!(
        &result.request_outcomes[0],
        RequestOutcome::Finished {
            observation: Observation { current: false, .. },
            ..
        }
    ));
    assert!(result.effect.is_none());
}

#[test]
fn uncertain_begin_recovers_instead_of_blindly_repeating() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    complete(&mut r, status(1, Some(1), false));
    complete(&mut r, EffectResult::Recovered(None));
    expect(&r, Effect::Begin);
    complete(&mut r, EffectResult::Failed(Failure::Uncertain));
    expect(&r, Effect::Observe);
    complete(&mut r, status(1, Some(1), false));
    expect(&r, Effect::RecoverStage);
    complete(&mut r, EffectResult::Recovered(Some(stage(1, 4, 10))));
    expect(
        &r,
        Effect::Pump {
            snapshot: snapshot(2),
        },
    );
}

#[test]
fn restart_recovers_a_persisted_ready_stage_without_reparsing() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    complete(&mut r, status(1, Some(1), false));
    complete(&mut r, EffectResult::Recovered(Some(stage(1, 10, 10))));
    expect(
        &r,
        Effect::Publish {
            snapshot: snapshot(2),
        },
    );
}

#[test]
fn uncertain_destructive_operations_are_not_repeated_without_proof() {
    for rebuild in [false, true] {
        let mut r = runtime();
        let mut q = FreshnessRequest::new(1);
        q.force_rebuild = rebuild;
        r.reduce(Input::Request(q)).unwrap();
        if !rebuild {
            complete(&mut r, status(1, None, false));
            expect(&r, Effect::Initialize);
        } else {
            expect(&r, Effect::Rebuild);
        }
        complete(&mut r, EffectResult::Failed(Failure::Uncertain));
        expect(&r, Effect::Observe);
        let reduction = complete(&mut r, status(1, None, false));
        assert_eq!(
            reduction.request_outcomes,
            vec![RequestOutcome::Failed {
                id: 1,
                failure: Failure::Unavailable
            }]
        );
        assert!(reduction.effect.is_none());
        wake(&mut r);
        let again = complete(&mut r, status(1, None, false));
        assert!(again.effect.is_none());
    }
}

#[test]
fn corruption_rebuild_latch_survives_source_motion_and_join_during_rebuild() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    let corrupt = |n| {
        EffectResult::Observed(Observation {
            source: source(n),
            published: None,
            current: false,
            rebuild_required: true,
            coverage_complete: None,
        })
    };
    complete(&mut r, corrupt(1));
    expect(&r, Effect::Rebuild);
    let mut q = FreshnessRequest::new(2);
    q.force_rebuild = true;
    r.reduce(Input::Request(q)).unwrap();
    complete(&mut r, EffectResult::Done);
    expect(&r, Effect::Observe);
    let blocked = complete(&mut r, corrupt(2));
    assert_eq!(blocked.request_outcomes.len(), 2);
    assert_eq!(blocked.update.error, Some(Failure::RebuildRequired));
    wake(&mut r);
    let still = complete(&mut r, corrupt(3));
    assert!(still.effect.is_none());
    wake(&mut r);
    complete(&mut r, status(3, Some(3), true));
    request(&mut r, 3, 8);
    wake(&mut r);
    complete(&mut r, corrupt(4));
    // The wake arrived after this Observe was issued. It must be repaired by
    // one fresh observation before the cleared latch may authorize a rebuild.
    expect(&r, Effect::Observe);
    complete(&mut r, corrupt(4));
    expect(&r, Effect::Rebuild);
}

#[test]
fn stale_restarts_are_bounded_and_do_not_turn_source_motion_into_rebuilds() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    begin(&mut r, 10);
    let yielded = complete(&mut r, EffectResult::Failed(Failure::StaleSource));
    assert_eq!(yielded.execution, Execution::Yield);
    wake(&mut r);
    expect(
        &r,
        Effect::Discard {
            snapshot: snapshot(2),
        },
    );
    complete(&mut r, EffectResult::Done);
    wake(&mut r);
    complete(&mut r, status(2, Some(1), false));
    complete(&mut r, EffectResult::Recovered(None));
    let mut s = stage(2, 0, 10);
    s.snapshot = snapshot(3);
    complete(&mut r, EffectResult::Stage(s));
    let done = complete(&mut r, EffectResult::Failed(Failure::StaleIndex));
    assert_eq!(
        done.request_outcomes,
        vec![RequestOutcome::Failed {
            id: 1,
            failure: Failure::StaleIndex
        }]
    );
    assert!(done.effect.is_none());
    assert!(r.stage().is_some());
}

#[test]
fn late_hint_does_not_publish_stage_from_a_different_observed_source() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    begin(&mut r, 1);
    r.reduce(Input::SourceHint).unwrap();
    complete(&mut r, EffectResult::Stage(stage(1, 1, 1)));
    wake(&mut r);
    complete(&mut r, status(2, Some(1), false));
    expect(
        &r,
        Effect::Discard {
            snapshot: snapshot(2),
        },
    );
}

#[test]
fn retirement_reconciles_each_issued_effect_without_new_effects_or_deletion() {
    let cases = [
        Effect::Observe,
        Effect::Initialize,
        Effect::RecoverStage,
        Effect::Begin,
        Effect::Pump {
            snapshot: snapshot(2),
        },
        Effect::Publish {
            snapshot: snapshot(2),
        },
        Effect::Rebuild,
        Effect::Discard {
            snapshot: snapshot(2),
        },
    ];
    for target in cases {
        let mut r = runtime();
        if target == Effect::Rebuild {
            let mut q = FreshnessRequest::new(1);
            q.force_rebuild = true;
            r.reduce(Input::Request(q)).unwrap();
        } else {
            request(&mut r, 1, 8);
            if target != Effect::Observe {
                complete(
                    &mut r,
                    status(
                        1,
                        if target == Effect::Initialize {
                            None
                        } else {
                            Some(1)
                        },
                        false,
                    ),
                );
            }
            if !matches!(
                target,
                Effect::Observe | Effect::Initialize | Effect::RecoverStage
            ) {
                complete(&mut r, EffectResult::Recovered(None));
                if target != Effect::Begin {
                    complete(&mut r, EffectResult::Stage(stage(1, 0, 1)));
                }
                if matches!(target, Effect::Publish { .. } | Effect::Discard { .. }) {
                    complete(&mut r, EffectResult::Stage(stage(1, 1, 1)));
                    wake(&mut r);
                    complete(
                        &mut r,
                        status(
                            if matches!(target, Effect::Discard { .. }) {
                                2
                            } else {
                                1
                            },
                            Some(1),
                            false,
                        ),
                    );
                }
            }
        }
        expect(&r, target.clone());
        let retiring = r.reduce(Input::Retire).unwrap();
        assert_eq!(retiring.request_outcomes.len(), 1);
        assert!(retiring.effect.is_none());
        let result = match target {
            Effect::Observe => status(1, Some(1), false),
            Effect::RecoverStage => EffectResult::Recovered(Some(stage(1, 0, 1))),
            Effect::Begin | Effect::Pump { .. } => EffectResult::Stage(stage(1, 1, 1)),
            Effect::Publish { .. } => EffectResult::Published(snapshot(2)),
            _ => EffectResult::Done,
        };
        let settled = complete(&mut r, result);
        assert_eq!(settled.execution, Execution::Quiesced);
        assert!(settled.effect.is_none());
        if matches!(
            target,
            Effect::Begin | Effect::Pump { .. } | Effect::RecoverStage
        ) {
            assert!(r.stage().is_some());
        }
        assert_eq!(
            r.reduce(Input::Request(FreshnessRequest::new(2))),
            Err(RuntimeError::Retired)
        );
    }
}

#[test]
fn requests_are_bounded_idempotent_and_conflicting_ids_are_rejected() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    let before = format!("{r:?}");
    request(&mut r, 1, 8);
    assert_eq!(format!("{r:?}"), before);
    assert_eq!(
        r.reduce(Input::Request(FreshnessRequest {
            id: 1,
            max_pumps: 1,
            max_restarts: 1,
            force_rebuild: false
        })),
        Err(RuntimeError::InvalidRequest)
    );
    assert_eq!(format!("{r:?}"), before);
    for id in 2..=32 {
        request(&mut r, id, 8);
    }
    let before = format!("{r:?}");
    assert_eq!(
        r.reduce(Input::Request(FreshnessRequest::new(33))),
        Err(RuntimeError::Capacity)
    );
    assert_eq!(format!("{r:?}"), before);
    r.reduce(Input::CancelRequest { id: 10 }).unwrap();
    request(&mut r, 33, 8);
    assert_eq!(r.request_count(), 32);
}

#[test]
fn invalid_data_never_silently_recreates_the_cache_and_hints_cannot_spin() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    let failed = complete(&mut r, EffectResult::Failed(Failure::InvalidData));
    assert_eq!(failed.update.error, Some(Failure::InvalidData));
    for _ in 0..100 {
        assert!(r.reduce(Input::SourceHint).unwrap().effect.is_none());
    }
    wake(&mut r);
    expect(&r, Effect::Observe);
}

#[test]
fn clean_pump_continuation_avoids_redundant_status_io_but_hint_forces_observe() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    begin(&mut r, 10);
    complete(&mut r, EffectResult::Stage(stage(1, 1, 10)));
    let resumed = r.reduce(Input::Continue).unwrap();
    assert!(matches!(resumed.effect.unwrap().kind, Effect::Pump { .. }));
    complete(&mut r, EffectResult::Stage(stage(1, 2, 10)));
    r.reduce(Input::SourceHint).unwrap();
    let dirty = r.reduce(Input::Continue).unwrap();
    assert_eq!(dirty.effect.unwrap().kind, Effect::Observe);
}

#[test]
fn actual_wake_repairs_missed_hints_with_no_subscribers_or_next_commit() {
    let mut r = runtime();
    wake(&mut r);
    complete(&mut r, status(1, Some(1), true));
    assert_eq!(r.request_count(), 0);
    let repair = wake(&mut r);
    assert_eq!(repair.effect.unwrap().kind, Effect::Observe);
    complete(&mut r, status(2, Some(1), false));
    expect(&r, Effect::RecoverStage);
}

#[test]
fn current_idle_waits_and_source_hint_dispatches_without_a_listener() {
    let mut r = runtime();
    wake(&mut r);
    let idle = complete(&mut r, status(1, Some(1), true));
    assert_eq!(idle.execution, Execution::WaitForWake);
    assert!(idle.effect.is_none());
    let next = r.reduce(Input::SourceHint).unwrap();
    assert_eq!(next.execution, Execution::Dispatch);
    assert_eq!(next.effect.unwrap().kind, Effect::Observe);
}

#[test]
fn persistent_uncertain_begin_is_bounded_even_with_no_stale_restart_budget() {
    let mut r = runtime();
    let mut q = FreshnessRequest::new(1);
    q.max_restarts = 0;
    r.reduce(Input::Request(q)).unwrap();
    complete(&mut r, status(1, Some(1), false));
    complete(&mut r, EffectResult::Recovered(None));
    complete(&mut r, EffectResult::Failed(Failure::Uncertain));
    complete(&mut r, status(1, Some(1), false));
    complete(&mut r, EffectResult::Recovered(None));
    expect(&r, Effect::Begin);
    let done = complete(&mut r, EffectResult::Failed(Failure::Uncertain));
    assert_eq!(
        done.request_outcomes,
        vec![RequestOutcome::Failed {
            id: 1,
            failure: Failure::Unavailable
        }]
    );
    assert!(done.effect.is_none());
    assert!(r.reduce(Input::Continue).unwrap().effect.is_none());
}

#[test]
fn persistent_uncertain_publish_without_exact_witness_retains_stage_and_stops() {
    let mut r = runtime();
    request(&mut r, 1, 1);
    begin(&mut r, 1);
    complete(&mut r, EffectResult::Stage(stage(1, 1, 1)));
    r.reduce(Input::Continue).unwrap();
    expect(
        &r,
        Effect::Publish {
            snapshot: snapshot(2),
        },
    );
    complete(&mut r, EffectResult::Failed(Failure::Uncertain));
    complete(&mut r, status(1, Some(1), false));
    complete(&mut r, EffectResult::Recovered(Some(stage(1, 1, 1))));
    expect(
        &r,
        Effect::Publish {
            snapshot: snapshot(2),
        },
    );
    let done = complete(&mut r, EffectResult::Failed(Failure::Uncertain));
    assert_eq!(
        done.request_outcomes,
        vec![RequestOutcome::Failed {
            id: 1,
            failure: Failure::Unavailable
        }]
    );
    assert_eq!(r.stage().unwrap(), &stage(1, 1, 1));
    assert!(done.effect.is_none());
}

#[test]
fn wake_during_captured_observation_cannot_be_erased_by_its_old_completion() {
    let mut r = runtime();
    wake(&mut r);
    let old = r.in_flight().unwrap().clone();
    // The adapter already captured source1. A lifecycle wake must repair a
    // missed notification for source2 even if no further commit ever happens.
    wake(&mut r);
    assert_eq!(r.in_flight(), Some(&old));
    let first = complete(&mut r, status(1, Some(1), true));
    assert_eq!(first.effect.unwrap().kind, Effect::Observe);
    complete(&mut r, status(2, Some(1), false));
    expect(&r, Effect::RecoverStage);
}

#[test]
fn new_demand_during_captured_observation_gets_a_post_registration_observation() {
    let mut r = runtime();
    wake(&mut r);
    request(&mut r, 1, 8);
    let first = complete(&mut r, status(1, Some(1), true));
    assert!(first.request_outcomes.is_empty());
    assert_eq!(first.effect.unwrap().kind, Effect::Observe);
    // The request joined a background cycle. A current proof must not be lost
    // while waiting for its own foreground cycle.
    complete(&mut r, status(1, Some(1), true));
    let done = r.reduce(Input::Continue).unwrap();
    assert!(matches!(
        done.request_outcomes.as_slice(),
        [RequestOutcome::Finished { id: 1, .. }]
    ));
}

#[test]
fn authoritative_observe_and_begin_cannot_regress_local_source_watermark() {
    let mut r = runtime();
    request(&mut r, 1, 8);
    complete(&mut r, status(10, Some(1), false));
    complete(&mut r, EffectResult::Recovered(None));
    expect(&r, Effect::Begin);
    let e = r.in_flight().unwrap().clone();
    let before = format!("{r:?}");
    assert_eq!(
        r.reduce(Input::Complete {
            lifetime: e.lifetime,
            effect_id: e.id,
            result: EffectResult::Stage(stage(9, 0, 10))
        }),
        Err(RuntimeError::UnexpectedCompletion)
    );
    assert_eq!(format!("{r:?}"), before);
    complete(&mut r, EffectResult::Stage(stage(10, 0, 10)));
    complete(&mut r, EffectResult::Stage(stage(10, 1, 10)));
    wake(&mut r);
    let e = r.in_flight().unwrap().clone();
    let before = format!("{r:?}");
    assert_eq!(
        r.reduce(Input::Complete {
            lifetime: e.lifetime,
            effect_id: e.id,
            result: status(9, Some(1), false)
        }),
        Err(RuntimeError::UnexpectedCompletion)
    );
    assert_eq!(format!("{r:?}"), before);
}
