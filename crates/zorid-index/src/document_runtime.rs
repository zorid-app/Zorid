//! Committed document-index maintenance policy, independent of storage and IO.
//!
//! Effects are executed outside this reducer. An effect is not publication
//! authority: adapters retain their source/head/epoch checks and transaction CAS.
//! `Yield` is a real host admission boundary, not a claim of mid-call preemption.
use crate::{IndexSnapshotId, SemanticVersions, SourceSnapshotId};
use zorid_core::OperationId;

pub const MAX_RUNTIME_REQUESTS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub lifetime: OperationId,
    pub local_store: OperationId,
    pub versions: SemanticVersions,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageProgress {
    pub prepared: u32,
    pub total: u32,
    pub ready: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageObservation {
    pub source: SourceSnapshotId,
    pub snapshot: IndexSnapshotId,
    pub progress: Option<StageProgress>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub source: SourceSnapshotId,
    pub published: Option<IndexSnapshotId>,
    pub current: bool,
    pub rebuild_required: bool,
    pub coverage_complete: Option<bool>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    Foreground,
    Background,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FreshnessRequest {
    pub id: u64,
    pub max_pumps: u8,
    pub max_restarts: u8,
    pub force_rebuild: bool,
}
impl FreshnessRequest {
    pub fn new(id: u64) -> Self {
        Self {
            id,
            max_pumps: 8,
            max_restarts: 1,
            force_rebuild: false,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    /// Resume after a yielded host turn. Unlike Wake, this is not a durable
    /// observation trigger; pending hints/uncertainty still force observation.
    Continue,
    Wake {
        monotonic_ms: u64,
    },
    SourceHint,
    Request(FreshnessRequest),
    CancelRequest {
        id: u64,
    },
    Complete {
        lifetime: OperationId,
        effect_id: u64,
        result: EffectResult,
    },
    Retire,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Observe,
    /// Adapter uses bounded deterministic enumeration/resume; it skips only
    /// stale-source, stale-index and expired-stage candidates, as the CLI does.
    RecoverStage,
    Initialize,
    Begin,
    Pump {
        snapshot: IndexSnapshotId,
    },
    Publish {
        snapshot: IndexSnapshotId,
    },
    Discard {
        snapshot: IndexSnapshotId,
    },
    Rebuild,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedEffect {
    pub lifetime: OperationId,
    pub id: u64,
    pub priority: Priority,
    pub kind: Effect,
    pub target_source: Option<SourceSnapshotId>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EffectResult {
    Observed(Observation),
    Recovered(Option<StageObservation>),
    Stage(StageObservation),
    Published(IndexSnapshotId),
    Done,
    Failed(Failure),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    StaleSource,
    StaleIndex,
    SnapshotExpired,
    RebuildRequired,
    Uncertain,
    Unavailable,
    InvalidData,
    Fatal,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    Unknown,
    Current,
    Lagging,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Observing,
    Initializing,
    Recovering,
    Indexing,
    Publishing,
    Rebuilding,
    Releasing,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeUpdate {
    pub lifetime: OperationId,
    pub revision: u64,
    pub source: Option<SourceSnapshotId>,
    pub published: Option<IndexSnapshotId>,
    pub freshness: Freshness,
    pub phase: Phase,
    pub progress: Option<StageProgress>,
    pub coverage_complete: Option<bool>,
    pub has_foreground_demand: bool,
    pub error: Option<Failure>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestOutcome {
    Finished { id: u64, observation: Observation },
    Failed { id: u64, failure: Failure },
    Cancelled { id: u64 },
    Retired { id: u64 },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Execution {
    Dispatch,
    Yield,
    WaitForWake,
    Quiesced,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reduction {
    pub effect: Option<IssuedEffect>,
    pub update: RuntimeUpdate,
    pub request_outcomes: Vec<RequestOutcome>,
    pub execution: Execution,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    InvalidRequest,
    Capacity,
    Retired,
    UnexpectedCompletion,
}
impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Document runtime: {self:?}")
    }
}
impl std::error::Error for RuntimeError {}

#[derive(Clone, Debug)]
struct Pending {
    issued: IssuedEffect,
    hints: u64,
}
#[derive(Clone, Debug)]
struct Cycle {
    foreground: bool,
    pumps: u8,
    restarts: u8,
    max_pumps: u8,
    max_restarts: u8,
    finish_after_observe: bool,
    uncertain_seen: bool,
}
/// One authority lifetime, one issued effect, bounded demand records, no text,
/// parsed records, callbacks, pins, durable queue or ambient clock.
#[derive(Clone, Debug)]
pub struct DocumentRuntime {
    identity: RuntimeIdentity,
    observation: Option<Observation>,
    stage: Option<StageObservation>,
    pending: Option<Pending>,
    requests: Vec<FreshnessRequest>,
    cycle: Option<Cycle>,
    hints: u64,
    needs_observe: bool,
    recovered: bool,
    initialized: bool,
    rebuild_latched: bool,
    explicit_rebuild: bool,
    discard_before_restart: bool,
    uncertain_destructive: bool,
    yielded: bool,
    blocked: bool,
    retired: bool,
    next_effect: u64,
    last_wake: Option<u64>,
    update: RuntimeUpdate,
}
impl DocumentRuntime {
    pub fn new(identity: RuntimeIdentity) -> Self {
        let update = RuntimeUpdate {
            lifetime: identity.lifetime.clone(),
            revision: 0,
            source: None,
            published: None,
            freshness: Freshness::Unknown,
            phase: Phase::Idle,
            progress: None,
            coverage_complete: None,
            has_foreground_demand: false,
            error: None,
        };
        Self {
            identity,
            observation: None,
            stage: None,
            pending: None,
            requests: Vec::new(),
            cycle: None,
            hints: 0,
            needs_observe: true,
            recovered: false,
            initialized: false,
            rebuild_latched: false,
            explicit_rebuild: false,
            discard_before_restart: false,
            uncertain_destructive: false,
            yielded: false,
            blocked: false,
            retired: false,
            next_effect: 1,
            last_wake: None,
            update,
        }
    }
    /// Register subscriptions against this same copied revision. Updates are
    /// observations, not an event log; a delivery gap requires another observe.
    pub fn update(&self) -> RuntimeUpdate {
        self.update.clone()
    }
    pub fn stage(&self) -> Option<&StageObservation> {
        self.stage.as_ref()
    }
    pub fn request_count(&self) -> usize {
        self.requests.len()
    }
    pub fn in_flight(&self) -> Option<&IssuedEffect> {
        self.pending.as_ref().map(|p| &p.issued)
    }

    pub fn reduce(&mut self, input: Input) -> Result<Reduction, RuntimeError> {
        // All external validation precedes mutation, including exact closed
        // completion correspondence. Reserve counters before accepting input.
        self.validate_input(&input)?;
        // Reserve the retirement update and the one pending completion. At
        // exhaustion new work is refused; explicit retirement and settlement
        // remain possible and never wrap either counter.
        if self.counter_exhausted() && !matches!(input, Input::Complete { .. } | Input::Retire) {
            return Err(RuntimeError::Capacity);
        }
        let before = self.update.clone();
        let mut outcomes = Vec::new();
        match input {
            Input::Continue => self.yielded = false,
            Input::Wake { monotonic_ms } => {
                self.last_wake = Some(monotonic_ms);
                self.hints += 1;
                self.yielded = false;
                self.blocked = false;
                // Wakes repair missing notifications even with no listeners.
                self.needs_observe = true;
            }
            Input::SourceHint => {
                self.hints += 1;
                self.needs_observe = true;
                // A hint cannot authorize content, advance source, or unblock a
                // failed cycle; only a new wake/request retries failures.
            }
            Input::Request(request) => {
                if !self.requests.iter().any(|r| r.id == request.id) {
                    if request.force_rebuild && !self.is_rebuilding() {
                        self.explicit_rebuild = true;
                    }
                    self.requests.push(request);
                    self.hints += 1;
                    self.blocked = false;
                    self.needs_observe = true;
                }
            }
            Input::CancelRequest { id } => {
                if let Some(at) = self.requests.iter().position(|r| r.id == id) {
                    self.requests.remove(at);
                    outcomes.push(RequestOutcome::Cancelled { id });
                }
            }
            Input::Complete { result, .. } => {
                let pending = self.pending.take().expect("validated pending effect");
                self.complete(pending, result, &mut outcomes);
            }
            Input::Retire => {
                self.retired = true;
                for request in self.requests.drain(..) {
                    outcomes.push(RequestOutcome::Retired { id: request.id });
                }
            }
        }
        if self.counter_exhausted() && !self.retired {
            self.retired = true;
            for request in self.requests.drain(..) {
                outcomes.push(RequestOutcome::Retired { id: request.id });
            }
        }
        let effect = self.plan(&mut outcomes);
        self.refresh_update();
        if self.update != before {
            self.update.revision = before.revision + 1;
        }
        let execution = if self.retired && self.pending.is_none() {
            Execution::Quiesced
        } else if effect.is_some() {
            Execution::Dispatch
        } else if self.yielded {
            Execution::Yield
        } else {
            Execution::WaitForWake
        };
        Ok(Reduction {
            effect,
            update: self.update.clone(),
            request_outcomes: outcomes,
            execution,
        })
    }
    fn counter_exhausted(&self) -> bool {
        self.update.revision >= u64::MAX - 2
            || self.next_effect == u64::MAX
            || self.hints == u64::MAX
    }
    fn validate_input(&self, input: &Input) -> Result<(), RuntimeError> {
        if self.retired && !matches!(input, Input::Complete { .. } | Input::Retire) {
            return Err(RuntimeError::Retired);
        }
        match input {
            Input::SourceHint if self.hints == u64::MAX => return Err(RuntimeError::Capacity),
            Input::Request(r) => {
                if r.max_pumps == 0 || r.max_pumps > 128 || r.max_restarts > 2 {
                    return Err(RuntimeError::InvalidRequest);
                }
                if let Some(old) = self.requests.iter().find(|old| old.id == r.id) {
                    if old != r {
                        return Err(RuntimeError::InvalidRequest);
                    }
                } else if self.requests.len() == MAX_RUNTIME_REQUESTS {
                    return Err(RuntimeError::Capacity);
                }
            }
            Input::Complete {
                lifetime,
                effect_id,
                result,
            } => {
                let p = self
                    .pending
                    .as_ref()
                    .ok_or(RuntimeError::UnexpectedCompletion)?;
                if lifetime != &self.identity.lifetime
                    || effect_id != &p.issued.id
                    || !self.valid_result(&p.issued, result)
                {
                    return Err(RuntimeError::UnexpectedCompletion);
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn valid_snapshot(&self, snapshot: &IndexSnapshotId) -> bool {
        snapshot.local_store_id() == &self.identity.local_store
            && snapshot.versions() == &self.identity.versions
    }
    fn source_not_older(&self, source: &SourceSnapshotId) -> bool {
        let value = |source: &SourceSnapshotId| {
            source
                .watermark()
                .as_str()
                .parse::<u64>()
                .expect("validated source watermark")
        };
        self.observation
            .as_ref()
            .map_or(true, |old| value(source) >= value(&old.source))
    }
    fn valid_stage(&self, stage: &StageObservation) -> bool {
        stage.source.local_store_id() == &self.identity.local_store
            && self.valid_snapshot(&stage.snapshot)
            && stage.progress.as_ref().map_or(true, |p| {
                p.prepared <= p.total && (!p.ready || p.prepared == p.total)
            })
    }
    fn valid_result(&self, effect: &IssuedEffect, result: &EffectResult) -> bool {
        match (&effect.kind, result) {
            (_, EffectResult::Failed(_)) => true,
            (Effect::Observe, EffectResult::Observed(o)) => {
                o.source.local_store_id() == &self.identity.local_store
                    && self.source_not_older(&o.source)
                    && o.published.as_ref().map_or(true, |s| {
                        s.local_store_id() == &self.identity.local_store
                            && (self.valid_snapshot(s) || o.rebuild_required && !o.current)
                    })
                    && (!o.current || o.published.is_some() && !o.rebuild_required)
                    && (o.published.is_some() || o.coverage_complete.is_none())
            }
            (Effect::RecoverStage, EffectResult::Recovered(s)) => {
                s.as_ref().map_or(true, |s| self.valid_stage(s))
            }
            (Effect::Begin, EffectResult::Stage(s)) => {
                self.valid_stage(s) && self.source_not_older(&s.source)
            }
            (Effect::Pump { snapshot }, EffectResult::Stage(s)) => {
                self.valid_stage(s)
                    && &s.snapshot == snapshot
                    && effect.target_source.as_ref() == Some(&s.source)
                    && self
                        .stage
                        .as_ref()
                        .and_then(|s| s.progress.as_ref())
                        .map_or(true, |old| {
                            s.progress.as_ref().map_or(false, |new| {
                                new.prepared >= old.prepared
                                    && new.total == old.total
                                    && (!old.ready || new.ready)
                            })
                        })
            }
            (Effect::Publish { snapshot }, EffectResult::Published(s)) => s == snapshot,
            (Effect::Initialize | Effect::Rebuild | Effect::Discard { .. }, EffectResult::Done) => {
                true
            }
            _ => false,
        }
    }
    fn complete(
        &mut self,
        pending: Pending,
        result: EffectResult,
        outcomes: &mut Vec<RequestOutcome>,
    ) {
        let kind = pending.issued.kind;
        match result {
            EffectResult::Observed(observation) => {
                if self.stage.as_ref().map(|s| &s.snapshot) == observation.published.as_ref()
                    && observation.published.is_some()
                {
                    self.stage = None;
                    if let Some(cycle) = &mut self.cycle {
                        cycle.finish_after_observe = true;
                    }
                }
                if observation.current {
                    self.rebuild_latched = false;
                    self.uncertain_destructive = false;
                }
                self.needs_observe = self.hints != pending.hints;
                self.observation = Some(observation);
                self.update.error = None;
            }
            EffectResult::Recovered(stage) => {
                self.stage = stage;
                self.recovered = true;
                if self.stage.as_ref().map(|s| &s.source)
                    != self.observation.as_ref().map(|o| &o.source)
                    && self.stage.is_some()
                {
                    self.needs_observe = true;
                }
            }
            EffectResult::Stage(stage) => {
                // Durable progress is saved even after the last cancellation or
                // retirement. The caller owns no scratch-stage lifetime.
                if matches!(kind, Effect::Pump { .. }) {
                    if let Some(cycle) = &mut self.cycle {
                        cycle.pumps += 1;
                        if cycle.pumps >= cycle.max_pumps
                            && !stage.progress.as_ref().map_or(false, |p| p.ready)
                        {
                            cycle.finish_after_observe = true;
                            self.needs_observe = true;
                        }
                    }
                    self.yielded = true;
                }
                if self.observation.as_ref().map(|o| &o.source) != Some(&stage.source) {
                    self.needs_observe = true;
                }
                self.stage = Some(stage);
            }
            EffectResult::Published(_) => {
                self.stage = None;
                self.needs_observe = true;
                if let Some(c) = &mut self.cycle {
                    c.finish_after_observe = true;
                }
            }
            EffectResult::Done => match kind {
                Effect::Initialize => {
                    self.initialized = true;
                    self.uncertain_destructive = false;
                }
                Effect::Rebuild => {
                    self.stage = None;
                    self.initialized = true;
                    self.uncertain_destructive = false;
                    self.recovered = false;
                    self.needs_observe = true;
                }
                Effect::Discard { .. } => {
                    self.stage = None;
                    self.discard_before_restart = false;
                    if self.observation.as_ref().map_or(false, |o| !o.current) {
                        self.needs_observe = true;
                        self.yielded = true;
                    }
                }
                _ => unreachable!("validated correspondence"),
            },
            EffectResult::Failed(failure) => self.fail_effect(kind, failure, outcomes),
        }
    }
    fn fail_effect(&mut self, kind: Effect, failure: Failure, outcomes: &mut Vec<RequestOutcome>) {
        if self.retired {
            self.update.error = Some(failure);
            return;
        }
        if failure == Failure::Uncertain {
            // One uncertainty reconciliation per bounded cycle. Repeated lost
            // acknowledgments must not create an unbounded observe/resume loop.
            if self.cycle.as_ref().map_or(false, |c| c.uncertain_seen) {
                self.fail_cycle(Failure::Unavailable, outcomes);
                return;
            }
            if let Some(cycle) = &mut self.cycle {
                cycle.uncertain_seen = true;
            }
            self.needs_observe = true;
            match kind {
                Effect::Begin | Effect::Pump { .. } | Effect::Publish { .. } => {
                    self.recovered = false
                }
                Effect::Initialize | Effect::Rebuild => self.uncertain_destructive = true,
                _ => {
                    self.fail_cycle(Failure::Unavailable, outcomes);
                    return;
                }
            }
            return;
        }
        if failure == Failure::RebuildRequired
            && !self.rebuild_latched
            && !matches!(kind, Effect::Rebuild)
        {
            self.explicit_rebuild = true;
            return;
        }
        if matches!(
            failure,
            Failure::StaleSource | Failure::StaleIndex | Failure::SnapshotExpired
        ) && !matches!(kind, Effect::Discard { .. })
        {
            if let Some(cycle) = &mut self.cycle {
                if cycle.restarts < cycle.max_restarts {
                    cycle.restarts += 1;
                    self.discard_before_restart = self.stage.is_some();
                    self.recovered = false;
                    self.needs_observe = true;
                    self.yielded = true;
                    return;
                }
            }
        }
        self.fail_cycle(failure, outcomes);
    }
    fn fail_cycle(&mut self, failure: Failure, outcomes: &mut Vec<RequestOutcome>) {
        self.update.error = Some(failure);
        self.blocked = true;
        self.cycle = None;
        for r in self.requests.drain(..) {
            outcomes.push(RequestOutcome::Failed { id: r.id, failure });
        }
    }
    fn is_rebuilding(&self) -> bool {
        self.pending
            .as_ref()
            .map_or(false, |p| matches!(p.issued.kind, Effect::Rebuild))
    }
    fn start_cycle(&mut self) {
        let (foreground, max_pumps, max_restarts) = match self.requests.first() {
            Some(r) => (true, r.max_pumps, r.max_restarts),
            None => (false, 1, 1),
        };
        self.cycle = Some(Cycle {
            foreground,
            max_pumps,
            max_restarts,
            pumps: 0,
            restarts: 0,
            finish_after_observe: false,
            uncertain_seen: false,
        });
    }
    fn finish_cycle(&mut self, outcomes: &mut Vec<RequestOutcome>) {
        let foreground = self.cycle.take().map_or(false, |c| c.foreground);
        if foreground {
            if let Some(observation) = &self.observation {
                for r in self.requests.drain(..) {
                    outcomes.push(RequestOutcome::Finished {
                        id: r.id,
                        observation: observation.clone(),
                    });
                }
            }
        }
        // A current idle runtime waits for a real wake. Scheduling Continue
        // here would otherwise create an Observe/Yield idle spin forever.
        self.yielded =
            !self.requests.is_empty() || self.observation.as_ref().map_or(false, |o| !o.current);
    }
    fn plan(&mut self, outcomes: &mut Vec<RequestOutcome>) -> Option<IssuedEffect> {
        if self.retired || self.pending.is_some() || self.blocked || self.yielded {
            return None;
        }
        if self.cycle.is_none() {
            self.start_cycle();
        }
        let kind = if self.explicit_rebuild {
            self.explicit_rebuild = false;
            self.rebuild_latched = true;
            Effect::Rebuild
        } else if self.discard_before_restart {
            if let Some(stage) = &self.stage {
                Effect::Discard {
                    snapshot: stage.snapshot.clone(),
                }
            } else {
                self.discard_before_restart = false;
                return self.plan(outcomes);
            }
        } else if self.needs_observe || self.observation.is_none() {
            Effect::Observe
        } else {
            let observation = self.observation.as_ref().expect("observed");
            if observation.current {
                if let Some(stage) = &self.stage {
                    Effect::Discard {
                        snapshot: stage.snapshot.clone(),
                    }
                } else {
                    self.finish_cycle(outcomes);
                    return None;
                }
            } else if self.uncertain_destructive {
                self.fail_cycle(Failure::Unavailable, outcomes);
                return None;
            } else if observation.rebuild_required {
                if self.rebuild_latched {
                    self.fail_cycle(Failure::RebuildRequired, outcomes);
                    return None;
                }
                self.rebuild_latched = true;
                Effect::Rebuild
            } else if self
                .cycle
                .as_ref()
                .map_or(false, |c| c.finish_after_observe)
            {
                self.finish_cycle(outcomes);
                return None;
            } else if observation.published.is_none() && self.stage.is_none() && !self.initialized {
                Effect::Initialize
            } else if !self.recovered {
                Effect::RecoverStage
            } else if let Some(stage) = &self.stage {
                if stage.source != observation.source {
                    let cycle = self.cycle.as_mut().expect("cycle");
                    if cycle.restarts >= cycle.max_restarts {
                        self.fail_cycle(Failure::StaleSource, outcomes);
                        return None;
                    }
                    cycle.restarts += 1;
                    self.discard_before_restart = true;
                    return self.plan(outcomes);
                }
                if stage.progress.as_ref().map_or(false, |p| p.ready) {
                    Effect::Publish {
                        snapshot: stage.snapshot.clone(),
                    }
                } else if self
                    .cycle
                    .as_ref()
                    .map_or(false, |c| c.pumps >= c.max_pumps)
                {
                    self.cycle.as_mut().expect("cycle").finish_after_observe = true;
                    self.needs_observe = true;
                    return self.plan(outcomes);
                } else {
                    Effect::Pump {
                        snapshot: stage.snapshot.clone(),
                    }
                }
            } else {
                Effect::Begin
            }
        };
        let issued = IssuedEffect {
            lifetime: self.identity.lifetime.clone(),
            id: self.next_effect,
            priority: if self.requests.is_empty() {
                Priority::Background
            } else {
                Priority::Foreground
            },
            kind,
            target_source: self
                .stage
                .as_ref()
                .map(|s| s.source.clone())
                .or_else(|| self.observation.as_ref().map(|o| o.source.clone())),
        };
        self.next_effect += 1;
        self.pending = Some(Pending {
            issued: issued.clone(),
            hints: self.hints,
        });
        Some(issued)
    }
    fn refresh_update(&mut self) {
        self.update.source = self.observation.as_ref().map(|o| o.source.clone());
        self.update.published = self.observation.as_ref().and_then(|o| o.published.clone());
        self.update.coverage_complete = self.observation.as_ref().and_then(|o| o.coverage_complete);
        self.update.freshness = if self.update.error.is_some() {
            Freshness::Unavailable
        } else {
            match &self.observation {
                None => Freshness::Unknown,
                Some(o) if o.current => Freshness::Current,
                Some(_) => Freshness::Lagging,
            }
        };
        self.update.progress = self.stage.as_ref().and_then(|s| s.progress.clone());
        self.update.has_foreground_demand = !self.requests.is_empty();
        self.update.phase = if self.retired {
            Phase::Releasing
        } else {
            match self.pending.as_ref().map(|p| &p.issued.kind) {
                Some(Effect::Observe) => Phase::Observing,
                Some(Effect::RecoverStage) => Phase::Recovering,
                Some(Effect::Initialize) => Phase::Initializing,
                Some(Effect::Begin | Effect::Pump { .. }) => Phase::Indexing,
                Some(Effect::Publish { .. }) => Phase::Publishing,
                Some(Effect::Rebuild) => Phase::Rebuilding,
                _ => Phase::Idle,
            }
        };
    }
}

#[cfg(test)]
mod counter_tests {
    use super::*;
    fn runtime() -> DocumentRuntime {
        DocumentRuntime::new(RuntimeIdentity {
            lifetime: OperationId::new("lifetime").unwrap(),
            local_store: OperationId::new("store").unwrap(),
            versions: SemanticVersions::new(2, "extract", "resolver", "query").unwrap(),
        })
    }
    #[test]
    fn effect_id_exhaustion_keeps_retirement_and_pending_settlement_available() {
        let mut r = runtime();
        r.next_effect = u64::MAX - 1;
        let issued = r
            .reduce(Input::Wake { monotonic_ms: 0 })
            .unwrap()
            .effect
            .unwrap();
        assert_eq!(issued.id, u64::MAX - 1);
        assert_eq!(r.reduce(Input::SourceHint), Err(RuntimeError::Capacity));
        r.reduce(Input::Retire).unwrap();
        let settled = r
            .reduce(Input::Complete {
                lifetime: issued.lifetime,
                effect_id: issued.id,
                result: EffectResult::Failed(Failure::Unavailable),
            })
            .unwrap();
        assert_eq!(settled.execution, Execution::Quiesced);
        assert!(settled.effect.is_none());
    }
    #[test]
    fn revision_exhaustion_reserves_retirement_and_completion_updates() {
        let mut r = runtime();
        let issued = r
            .reduce(Input::Wake { monotonic_ms: 0 })
            .unwrap()
            .effect
            .unwrap();
        r.update.revision = u64::MAX - 2;
        assert_eq!(r.reduce(Input::SourceHint), Err(RuntimeError::Capacity));
        let retired = r.reduce(Input::Retire).unwrap();
        assert_eq!(retired.update.revision, u64::MAX - 1);
        let settled = r
            .reduce(Input::Complete {
                lifetime: issued.lifetime,
                effect_id: issued.id,
                result: EffectResult::Failed(Failure::Unavailable),
            })
            .unwrap();
        assert_eq!(settled.update.revision, u64::MAX);
        assert_eq!(settled.execution, Execution::Quiesced);
        assert_eq!(r.reduce(Input::Retire).unwrap().update.revision, u64::MAX);
    }
}
