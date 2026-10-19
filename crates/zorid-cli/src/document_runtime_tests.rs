use super::*;
use std::{cell::Cell, rc::Rc, sync::Arc};
use zorid_core::OperationId;
use zorid_native::{
    DocumentRuntimeFreshness, DocumentRuntimePhase, DocumentRuntimePriority,
    DocumentRuntimeStageObservation, DocumentRuntimeStageProgress, DocumentRuntimeUpdate,
    SourceSnapshotId,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    StaleOnce,
    Fail,
    Endless,
    NoProgress,
    ForeignReceipt,
    PeerPublication,
    ReadyRecovery,
}
struct Fake {
    mode: Mode,
    source: SourceSnapshotId,
    snapshot: IndexSnapshotId,
    lifetime: OperationId,
    next: u64,
    revision: u64,
    target: u32,
    pumps: u32,
    cycle_pumps: u32,
    active: Option<DocumentFreshnessRequest>,
    requests: Vec<DocumentFreshnessRequest>,
    cancelled: Vec<u64>,
    attempts: u32,
    failed_once: bool,
    successful: Rc<Cell<u32>>,
}
impl Fake {
    fn new(mode: Mode, target: u32) -> Self {
        // Construct real typed IDs without a second reducer/identity format in
        // this adapter test. The backend below alone is deliberately scripted.
        let dir = tempfile::tempdir().unwrap();
        let mut store = zorid_store::Store::open(dir.path().join("vault.sqlite")).unwrap();
        store.initialize_document_index().unwrap();
        let stage = store.begin_document_index().unwrap();
        Self {
            mode,
            source: stage.source().clone(),
            snapshot: stage.snapshot().clone(),
            lifetime: OperationId::new("cli-test-runtime").unwrap(),
            next: 0,
            revision: 0,
            target,
            pumps: 0,
            cycle_pumps: 0,
            active: None,
            requests: Vec::new(),
            cancelled: Vec::new(),
            attempts: 0,
            failed_once: false,
            successful: Rc::new(Cell::new(0)),
        }
    }
    fn observation(&self, current: bool) -> Observation {
        Observation {
            source: self.source.clone(),
            published: current.then(|| self.snapshot.clone()),
            current,
            rebuild_required: false,
            coverage_complete: current.then_some(true),
        }
    }
    fn report(
        &mut self,
        execution: Execution,
        effect: Option<Effect>,
        outcomes: Vec<Outcome>,
    ) -> Reduction {
        self.revision += 1;
        let effect = effect.map(|kind| {
            self.next += 1;
            IssuedEffect {
                lifetime: self.lifetime.clone(),
                id: self.next,
                priority: DocumentRuntimePriority::Foreground,
                kind,
                target_source: Some(self.source.clone()),
            }
        });
        Reduction {
            effect,
            execution,
            request_outcomes: outcomes,
            update: DocumentRuntimeUpdate {
                lifetime: self.lifetime.clone(),
                revision: self.revision,
                source: Some(self.source.clone()),
                published: None,
                freshness: DocumentRuntimeFreshness::Lagging,
                phase: DocumentRuntimePhase::Indexing,
                progress: None,
                coverage_complete: None,
                has_foreground_demand: self.active.is_some(),
                error: None,
            },
        }
    }
    fn finished(&mut self, current: bool) -> Reduction {
        let id = self.active.take().unwrap().id;
        let observation = self.observation(current);
        self.report(
            if current {
                Execution::WaitForWake
            } else {
                Execution::Yield
            },
            None,
            vec![Outcome::Finished { id, observation }],
        )
    }
    fn pump(&mut self) -> Reduction {
        self.report(
            Execution::Dispatch,
            Some(Effect::Pump {
                snapshot: self.snapshot.clone(),
            }),
            Vec::new(),
        )
    }
}
impl Backend for Fake {
    fn command(&mut self, command: Command) -> Result<Reduction> {
        Ok(match command {
            Command::Request(request) => {
                self.cycle_pumps = 0;
                self.requests.push(request.clone());
                self.active = Some(request.clone());
                if self.mode == Mode::NoProgress {
                    self.finished(false)
                } else if self.mode == Mode::Endless {
                    self.report(Execution::Dispatch, Some(Effect::Observe), Vec::new())
                } else if self.mode == Mode::ReadyRecovery {
                    self.report(Execution::Dispatch, Some(Effect::RecoverStage), Vec::new())
                } else if request.force_rebuild {
                    self.report(Execution::Dispatch, Some(Effect::Rebuild), Vec::new())
                } else {
                    self.pump()
                }
            }
            Command::Continue => {
                if self.mode == Mode::ReadyRecovery || self.pumps >= self.target {
                    if self.mode == Mode::PeerPublication {
                        self.finished(true)
                    } else {
                        self.report(
                            Execution::Dispatch,
                            Some(Effect::Publish {
                                snapshot: self.snapshot.clone(),
                            }),
                            Vec::new(),
                        )
                    }
                } else if self.cycle_pumps >= u32::from(self.active.as_ref().unwrap().max_pumps) {
                    self.finished(false)
                } else {
                    self.pump()
                }
            }
            Command::CancelRequest { id } => {
                self.cancelled.push(id);
                self.active = None;
                self.report(
                    Execution::WaitForWake,
                    None,
                    vec![Outcome::Cancelled { id }],
                )
            }
            _ => return Err(protocol_failure()),
        })
    }
    fn step(&mut self, issued: &IssuedEffect) -> Result<(Reduction, NativeDocumentRuntimeReceipt)> {
        self.attempts += 1;
        let (completion, pump, reduction) = match &issued.kind {
            Effect::Observe if self.mode == Mode::Endless => {
                let completion = EffectResult::Observed(self.observation(false));
                (
                    completion,
                    None,
                    self.report(Execution::Dispatch, Some(Effect::Observe), Vec::new()),
                )
            }
            Effect::Rebuild => (
                EffectResult::Done,
                None,
                self.report(Execution::Yield, None, Vec::new()),
            ),
            Effect::RecoverStage => {
                let stage = DocumentRuntimeStageObservation {
                    source: self.source.clone(),
                    snapshot: self.snapshot.clone(),
                    progress: Some(DocumentRuntimeStageProgress {
                        prepared: self.target,
                        total: self.target,
                        ready: true,
                    }),
                };
                (
                    EffectResult::Recovered(Some(stage)),
                    None,
                    self.report(Execution::Yield, None, Vec::new()),
                )
            }
            Effect::Pump { .. } if self.mode == Mode::Fail => {
                let id = self.active.take().unwrap().id;
                (
                    EffectResult::Failed(RuntimeFailure::InvalidData),
                    None,
                    self.report(
                        Execution::WaitForWake,
                        None,
                        vec![Outcome::Failed {
                            id,
                            failure: RuntimeFailure::InvalidData,
                        }],
                    ),
                )
            }
            Effect::Pump { .. } if self.mode == Mode::StaleOnce && !self.failed_once => {
                self.failed_once = true;
                (
                    EffectResult::Failed(RuntimeFailure::StaleSource),
                    None,
                    self.report(Execution::Yield, None, Vec::new()),
                )
            }
            Effect::Pump { snapshot } => {
                self.pumps += 1;
                self.cycle_pumps += 1;
                self.successful.set(self.pumps);
                let ready = self.pumps >= self.target;
                let mut progress = zero_progress(
                    snapshot.clone(),
                    self.pumps as usize,
                    self.target as usize,
                    ready,
                );
                progress.reused_documents = 7;
                progress.parse_cache.hits = 3;
                let stage = DocumentRuntimeStageObservation {
                    source: self.source.clone(),
                    snapshot: snapshot.clone(),
                    progress: Some(DocumentRuntimeStageProgress {
                        prepared: self.pumps,
                        total: self.target,
                        ready,
                    }),
                };
                (
                    EffectResult::Stage(stage),
                    Some(Arc::new(progress)),
                    self.report(Execution::Yield, None, Vec::new()),
                )
            }
            Effect::Publish { snapshot } => (
                EffectResult::Published(snapshot.clone()),
                None,
                self.finished(true),
            ),
            _ => return Err(protocol_failure()),
        };
        let mut actual = issued.clone();
        if self.mode == Mode::ForeignReceipt {
            actual.id += 1;
        }
        Ok((
            reduction,
            NativeDocumentRuntimeReceipt {
                issued: actual,
                completion,
                pump,
            },
        ))
    }
}

#[test]
fn total_budget_above_128_uses_bounded_core_requests_and_preserves_per_pump_metrics() {
    let mut backend = Fake::new(Mode::Normal, 129);
    let run = drive_build(&mut backend, true, 129, || false).unwrap();
    assert_eq!(
        backend
            .requests
            .iter()
            .map(|r| r.max_pumps)
            .collect::<Vec<_>>(),
        [128, 1]
    );
    assert_eq!(
        backend
            .requests
            .iter()
            .map(|r| r.force_rebuild)
            .collect::<Vec<_>>(),
        [true, false]
    );
    assert!(backend.requests.iter().all(|r| r.max_restarts == 1));
    assert_eq!(run.pumps, 129);
    assert_eq!(run.publication.as_ref(), Some(&backend.snapshot));
    let progress = run.progress.unwrap();
    assert_eq!(progress.prepared_documents, 129);
    assert_eq!(progress.reused_documents, 7); // Last pump, never fabricated sum.
    assert_eq!(progress.parse_cache.hits, 3);
}
#[test]
fn failed_pump_attempt_is_not_counted_as_success_or_retried_by_adapter() {
    let mut backend = Fake::new(Mode::StaleOnce, 1);
    let run = drive_build(&mut backend, false, 1, || false).unwrap();
    assert_eq!(run.pumps, 1);
    assert_eq!(backend.attempts, 3); // Selected failed Pump, Pump, Publish.
    assert_eq!(backend.requests.len(), 1);
    let mut backend = Fake::new(Mode::Fail, 1);
    let error = drive_build(&mut backend, false, 1, || false).err().unwrap();
    assert_eq!(error.code, "index_contract_error");
    assert_eq!(backend.pumps, 0);
    assert_eq!(backend.attempts, 1);
    assert_eq!(backend.requests.len(), 1);
}
#[test]
fn attempted_effect_budget_cancels_owned_demand_without_false_completion() {
    let mut backend = Fake::new(Mode::Endless, 1);
    let error = drive_build(&mut backend, false, 1, || false).err().unwrap();
    assert_eq!(error.code, "index_execution_budget");
    assert_eq!(backend.attempts, 68);
    assert_eq!(backend.pumps, 0);
    assert_eq!(backend.cancelled, [1]);
}
#[test]
fn cancellation_after_pump_cancels_only_owned_demand_and_does_not_publish() {
    let mut backend = Fake::new(Mode::Normal, 3);
    let successful = backend.successful.clone();
    let error = drive_build(&mut backend, false, 3, || successful.get() == 1)
        .err()
        .unwrap();
    assert_eq!(error.code, "index_cancelled");
    assert_eq!(backend.pumps, 1);
    assert_eq!(backend.attempts, 1);
    assert_eq!(backend.cancelled, [1]);
}
#[test]
fn ready_recovery_publishes_without_pump_and_reports_only_actual_restored_counts() {
    let mut backend = Fake::new(Mode::ReadyRecovery, 10);
    let run = drive_build(&mut backend, false, 1, || false).unwrap();
    assert!(run.resumed);
    assert_eq!(run.pumps, 0);
    assert_eq!(backend.attempts, 2);
    assert!(run.publication.is_some());
    let progress = run.progress.unwrap();
    assert_eq!(
        (
            progress.prepared_documents,
            progress.total_documents,
            progress.ready
        ),
        (10, 10, true)
    );
    assert_eq!(progress.reused_documents, 0);
    assert_eq!(progress.parse_cache.hits, 0);
}
#[test]
fn another_producer_publication_is_not_attributed_to_this_invocation() {
    let mut backend = Fake::new(Mode::PeerPublication, 1);
    let run = drive_build(&mut backend, false, 1, || false).unwrap();
    assert!(run.observation.current);
    assert!(run.publication.is_none());
    assert_eq!(backend.attempts, 1);
}
#[test]
fn mismatched_receipt_and_zero_work_cycle_fail_closed_without_unbounded_reissue() {
    let mut backend = Fake::new(Mode::ForeignReceipt, 1);
    assert_eq!(
        drive_build(&mut backend, false, 1, || false)
            .err()
            .unwrap()
            .code,
        "document_runtime_contract"
    );
    let mut backend = Fake::new(Mode::NoProgress, 1);
    assert_eq!(
        drive_build(&mut backend, false, 1, || false)
            .err()
            .unwrap()
            .code,
        "no_progress"
    );
    assert_eq!(backend.requests.len(), 1);
    assert_eq!(backend.attempts, 0);
}
