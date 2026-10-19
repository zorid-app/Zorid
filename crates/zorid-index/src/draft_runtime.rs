//! Latest-only, identity-free draft analysis policy. Hosts execute one issued
//! parser phase or memory release outside this reducer. No draft is a durable
//! entry witness, query generation, cache publication, or save operation.
//!
//! Parser phases are cooperative boundaries. A pinned parser constructor or YAML
//! scan can still be monolithic; this module makes no mid-phase latency promise.
use std::collections::{BTreeMap, VecDeque};
use zorid_core::OperationId;
use zorid_document::{ParseFactsPhase, ParseFactsStep, ParseFactsStepBudget, ParseFactsUsage};

pub const MAX_DRAFT_BUFFERS: usize = 32;
pub const MAX_DRAFT_REQUESTS: usize = 32;
pub const MAX_DRAFT_SOURCE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DRAFT_INPUT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_DRAFT_FACTS_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_DRAFT_SCRATCH_BYTES: usize = 128 * 1024 * 1024;
// Leave enough effect identities to release every retained job without wrapping.
const LAST_NORMAL_EFFECT: u64 = u64::MAX - MAX_DRAFT_REQUESTS as u64;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct BufferKey {
    pub client: OperationId,
    pub buffer_lifetime: OperationId,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftTag {
    pub buffer: BufferKey,
    pub text_revision: u64,
}
/// Fingerprinting itself scans bounded source. Native can hash while uploading;
/// browser admission must not claim a free or interruptible string/hash scan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceDescriptor {
    pub bytes: usize,
    pub utf16: usize,
    pub sha256: [u8; 32],
}
impl SourceDescriptor {
    fn valid(&self) -> bool {
        self.bytes <= MAX_DRAFT_SOURCE_BYTES
            && self.utf16 <= self.bytes
            && (self.bytes == 0) == (self.utf16 == 0)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftRequest {
    pub tag: DraftTag,
    pub source: SourceDescriptor,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobToken {
    pub lifetime: OperationId,
    pub id: u64,
    pub tag: DraftTag,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedEffect {
    pub lifetime: OperationId,
    pub id: u64,
    pub job: JobToken,
    pub kind: Effect,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    ParsePhase {
        phase: ParseFactsPhase,
        budget: ParseFactsStepBudget,
        phases_completed: u8,
    },
    /// Drop the actual upload, parser job, and any transferred facts handle.
    /// Reservations remain charged until this exact release settles.
    DropJob,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Completion {
    Parsed(ParseFactsStep),
    /// The parser hit an owned-resource limit and released its payload. Hosts
    /// read its actual usage/counter after the error; no guessed empty facts.
    Resource {
        usage: ParseFactsUsage,
        phases_completed: u8,
    },
    /// Cancel an already-issued but not executed obsolete phase without parsing.
    /// A phase that actually ran must use Parsed, even after supersession.
    Stopped {
        usage: ParseFactsUsage,
        phases_completed: u8,
    },
    Dropped,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnavailableCode {
    Resource,
    CounterExhausted,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutcomeKind {
    Ready,
    Superseded,
    Cancelled,
    Retired,
    Unavailable(UnavailableCode),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub job: JobToken,
    pub kind: OutcomeKind,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    /// Reserve source bytes BEFORE retaining an upload or parser input. This
    /// command does no parsing. The host must not allocate on rejection.
    Request(DraftRequest),
    /// Seal only the exact reserved bytes/fingerprint after UTF8 validation.
    Seal {
        job: JobToken,
        actual: SourceDescriptor,
    },
    Cancel {
        client: OperationId,
        job: JobToken,
    },
    Acknowledge {
        client: OperationId,
        job: JobToken,
    },
    ReleaseBuffer(BufferKey),
    ReleaseClient(OperationId),
    Complete {
        effect: IssuedEffect,
        completion: Completion,
    },
    Continue,
    Retire,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Execution {
    Dispatch,
    WaitForInput,
    WaitForAcknowledgement,
    Idle,
    Quiesced,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reduction {
    pub admitted: Option<JobToken>,
    pub replay: bool,
    pub execution: Execution,
    pub in_flight: Option<IssuedEffect>,
    /// Bounded retained outcomes, independent of UI listeners or update changes.
    pub outcomes: Vec<Outcome>,
    pub usage: ParseFactsUsage,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    InvalidSource,
    SourceMismatch,
    StaleRevision,
    Conflict,
    Expired,
    ForeignOwner,
    Capacity,
    Retired,
    CounterExhausted,
    InvalidCompletion,
    InvalidUsage,
    InvalidAcknowledgement,
}
#[derive(Clone)]
struct Buffer {
    revision: u64,
    source: SourceDescriptor,
    current: Option<u64>,
    releasing: bool,
}
#[derive(Clone)]
struct Job {
    token: JobToken,
    source: SourceDescriptor,
    sealed: bool,
    phase: ParseFactsPhase,
    phases_completed: u8,
    usage: ParseFactsUsage,
    outcome: Option<OutcomeKind>,
    needs_drop: bool,
    acknowledged: bool,
}
#[derive(Clone)]
pub struct DraftRuntime {
    lifetime: OperationId,
    buffers: BTreeMap<BufferKey, Buffer>,
    jobs: BTreeMap<u64, Job>,
    queue: VecDeque<u64>,
    in_flight: Option<IssuedEffect>,
    next_job: u64,
    next_effect: u64,
    retired: bool,
}
fn zero() -> ParseFactsUsage {
    ParseFactsUsage {
        source_bytes: 0,
        scratch_bytes: 0,
        facts_bytes: 0,
    }
}
fn next_phase(phase: ParseFactsPhase) -> Option<ParseFactsPhase> {
    use ParseFactsPhase::*;
    Some(match phase {
        Positions => Frontmatter,
        Frontmatter => InitialMaskAndComments,
        InitialMaskAndComments => WikiRepairs,
        WikiRepairs => ProtectedExclusions,
        ProtectedExclusions => Semantics,
        Semantics => Tags,
        Tags => Ready,
        Ready | Cancelled => return None,
    })
}
impl DraftRuntime {
    pub fn new(lifetime: OperationId) -> Self {
        Self {
            lifetime,
            buffers: BTreeMap::new(),
            jobs: BTreeMap::new(),
            queue: VecDeque::new(),
            in_flight: None,
            next_job: 0,
            next_effect: 0,
            retired: false,
        }
    }
    pub fn in_flight(&self) -> Option<&IssuedEffect> {
        self.in_flight.as_ref()
    }
    pub fn snapshot(&self) -> Reduction {
        self.report(None, false)
    }
    /// A host can skip an obsolete issued phase by cancelling its real job and
    /// settling Stopped. This checks the exact descriptor before any execution.
    pub fn phase_is_current(&self, effect: &IssuedEffect) -> Result<bool, RuntimeError> {
        if self.in_flight.as_ref() != Some(effect) {
            return Err(RuntimeError::InvalidCompletion);
        }
        let job = self.jobs.get(&effect.job.id).ok_or(RuntimeError::Expired)?;
        Ok(job.outcome.is_none() && !self.retired)
    }
    pub fn usage(&self) -> ParseFactsUsage {
        let mut total = zero();
        for job in self.jobs.values() {
            total.source_bytes += job.usage.source_bytes;
            total.scratch_bytes += job.usage.scratch_bytes;
            total.facts_bytes += job.usage.facts_bytes;
        }
        total
    }
    /// Transactional bounded metadata copy means every rejected input leaves the
    /// reducer unchanged. Source, facts, parsers, and allocations live in hosts.
    pub fn reduce(&mut self, input: Input) -> Result<Reduction, RuntimeError> {
        let mut next = self.clone();
        let (admitted, replay) = next.apply(input)?;
        next.plan()?;
        let result = next.report(admitted, replay);
        *self = next;
        Ok(result)
    }
    fn apply(&mut self, input: Input) -> Result<(Option<JobToken>, bool), RuntimeError> {
        match input {
            Input::Request(request) => {
                if self.retired {
                    return Err(RuntimeError::Retired);
                }
                if !request.source.valid() {
                    return Err(RuntimeError::InvalidSource);
                }
                if let Some(buffer) = self.buffers.get(&request.tag.buffer) {
                    if buffer.releasing {
                        return Err(RuntimeError::Retired);
                    }
                    if request.tag.text_revision < buffer.revision {
                        return Err(RuntimeError::StaleRevision);
                    }
                    if request.tag.text_revision == buffer.revision {
                        if request.source != buffer.source {
                            return Err(RuntimeError::Conflict);
                        }
                        let job = buffer
                            .current
                            .and_then(|id| self.jobs.get(&id))
                            .ok_or(RuntimeError::Expired)?;
                        return Ok((Some(job.token.clone()), true));
                    }
                } else if self.buffers.len() >= MAX_DRAFT_BUFFERS {
                    return Err(RuntimeError::Capacity);
                }
                if self.jobs.len() >= MAX_DRAFT_REQUESTS
                    || request.source.bytes > MAX_DRAFT_INPUT_BYTES - self.usage().source_bytes
                {
                    return Err(RuntimeError::Capacity);
                }
                if self.next_effect >= LAST_NORMAL_EFFECT {
                    return Err(RuntimeError::CounterExhausted);
                }
                let id = self
                    .next_job
                    .checked_add(1)
                    .ok_or(RuntimeError::CounterExhausted)?;
                if let Some(previous) = self
                    .buffers
                    .get(&request.tag.buffer)
                    .and_then(|b| b.current)
                {
                    self.stop(previous, OutcomeKind::Superseded);
                }
                let token = JobToken {
                    lifetime: self.lifetime.clone(),
                    id,
                    tag: request.tag.clone(),
                };
                self.jobs.insert(
                    id,
                    Job {
                        token: token.clone(),
                        source: request.source.clone(),
                        sealed: false,
                        phase: ParseFactsPhase::Positions,
                        phases_completed: 0,
                        usage: ParseFactsUsage {
                            source_bytes: request.source.bytes,
                            scratch_bytes: 0,
                            facts_bytes: 0,
                        },
                        outcome: None,
                        needs_drop: false,
                        acknowledged: false,
                    },
                );
                self.buffers.insert(
                    request.tag.buffer,
                    Buffer {
                        revision: request.tag.text_revision,
                        source: request.source,
                        current: Some(id),
                        releasing: false,
                    },
                );
                self.next_job = id;
                return Ok((Some(token), false));
            }
            Input::Seal { job, actual } => {
                let selected = self.selected(&job)?;
                if selected.source != actual {
                    return Err(RuntimeError::SourceMismatch);
                }
                if selected.outcome.is_some() {
                    return Err(RuntimeError::Expired);
                }
                if selected.sealed {
                    return Ok((Some(job), true));
                }
                self.jobs.get_mut(&job.id).unwrap().sealed = true;
                self.queue.push_back(job.id);
            }
            Input::Cancel { client, job } => {
                self.owned(&client, &job)?;
                if self.jobs[&job.id].outcome.is_none()
                    || self.jobs[&job.id].outcome == Some(OutcomeKind::Ready)
                {
                    self.stop(job.id, OutcomeKind::Cancelled);
                }
            }
            Input::Acknowledge { client, job } => {
                self.owned(&client, &job)?;
                if self.jobs[&job.id].outcome.is_none() {
                    return Err(RuntimeError::InvalidAcknowledgement);
                }
                let selected = self.jobs.get_mut(&job.id).unwrap();
                selected.acknowledged = true;
                // Non-ready terminal payloads may already have been released.
                // ACK must not dispatch a redundant empty memory-release step.
                if selected.outcome == Some(OutcomeKind::Ready) {
                    selected.needs_drop = true;
                }
                self.remove_released(job.id);
            }
            Input::ReleaseBuffer(buffer) => {
                if let Some(selected) = self.buffers.get_mut(&buffer) {
                    selected.releasing = true;
                }
                let ids: Vec<_> = self
                    .jobs
                    .values()
                    .filter(|j| j.token.tag.buffer == buffer)
                    .map(|j| j.token.id)
                    .collect();
                for id in ids {
                    self.release(id);
                }
                self.prune_buffers();
            }
            Input::ReleaseClient(client) => {
                let keys: Vec<_> = self
                    .buffers
                    .keys()
                    .filter(|b| b.client == client)
                    .cloned()
                    .collect();
                for key in keys {
                    self.buffers.get_mut(&key).unwrap().releasing = true;
                    let ids: Vec<_> = self
                        .jobs
                        .values()
                        .filter(|j| j.token.tag.buffer == key)
                        .map(|j| j.token.id)
                        .collect();
                    for id in ids {
                        self.release(id);
                    }
                }
                self.prune_buffers();
            }
            Input::Complete { effect, completion } => self.complete(effect, completion)?,
            Input::Continue => {}
            Input::Retire => {
                self.retired = true;
                let ids: Vec<_> = self.jobs.keys().copied().collect();
                for id in ids {
                    self.release(id);
                }
                for buffer in self.buffers.values_mut() {
                    buffer.releasing = true;
                }
                self.prune_buffers();
            }
        }
        Ok((None, false))
    }
    fn selected(&self, token: &JobToken) -> Result<&Job, RuntimeError> {
        if token.lifetime != self.lifetime {
            return Err(RuntimeError::Expired);
        }
        self.jobs
            .get(&token.id)
            .filter(|j| j.token == *token)
            .ok_or(RuntimeError::Expired)
    }
    fn owned(&self, client: &OperationId, token: &JobToken) -> Result<(), RuntimeError> {
        self.selected(token)?;
        if token.tag.buffer.client != *client {
            return Err(RuntimeError::ForeignOwner);
        }
        Ok(())
    }
    fn stop(&mut self, id: u64, reason: OutcomeKind) {
        let job = self.jobs.get_mut(&id).unwrap();
        // A later revision invalidates a previously Ready transient handle too.
        if job.outcome.is_none() || job.outcome == Some(OutcomeKind::Ready) {
            job.outcome = Some(reason);
            job.needs_drop = true;
        }
        self.queue.retain(|queued| *queued != id);
    }
    fn release(&mut self, id: u64) {
        self.stop(id, OutcomeKind::Retired);
        self.jobs.get_mut(&id).unwrap().acknowledged = true;
        self.remove_released(id);
    }
    fn complete(
        &mut self,
        effect: IssuedEffect,
        completion: Completion,
    ) -> Result<(), RuntimeError> {
        if self.in_flight.as_ref() != Some(&effect) || effect.lifetime != self.lifetime {
            return Err(RuntimeError::InvalidCompletion);
        }
        let selected = self.selected(&effect.job)?;
        match (&effect.kind, completion) {
            (Effect::DropJob, Completion::Dropped) => {
                let job = self.jobs.get_mut(&effect.job.id).unwrap();
                job.usage = zero();
                job.needs_drop = false;
            }
            (
                Effect::ParsePhase {
                    phase,
                    budget,
                    phases_completed,
                },
                Completion::Parsed(step),
            ) => {
                if step.completed_phase != *phase
                    || step.phases_completed
                        != phases_completed
                            .checked_add(1)
                            .ok_or(RuntimeError::InvalidCompletion)?
                    || selected.phase != *phase
                    || selected.phases_completed != *phases_completed
                    || step.ready != (*phase == ParseFactsPhase::Tags)
                {
                    return Err(RuntimeError::InvalidCompletion);
                }
                self.validate_usage(&selected.source, budget, &step.usage, step.ready)?;
                let job = self.jobs.get_mut(&effect.job.id).unwrap();
                job.usage = step.usage;
                job.phases_completed = step.phases_completed;
                job.phase = next_phase(*phase).ok_or(RuntimeError::InvalidCompletion)?;
                if job.outcome.is_none() {
                    if step.ready {
                        job.outcome = Some(OutcomeKind::Ready);
                    } else {
                        self.queue.push_back(effect.job.id);
                    }
                }
            }
            (
                Effect::ParsePhase {
                    phases_completed, ..
                },
                Completion::Resource {
                    usage,
                    phases_completed: actual,
                },
            ) => {
                if actual != *phases_completed || usage != zero() {
                    return Err(RuntimeError::InvalidUsage);
                }
                let job = self.jobs.get_mut(&effect.job.id).unwrap();
                job.usage = zero();
                if job.outcome.is_none() {
                    job.outcome = Some(OutcomeKind::Unavailable(UnavailableCode::Resource));
                }
                job.needs_drop = true;
            }
            (
                Effect::ParsePhase {
                    phases_completed, ..
                },
                Completion::Stopped {
                    usage,
                    phases_completed: actual,
                },
            ) => {
                if selected.outcome.is_none() || actual != *phases_completed || usage != zero() {
                    return Err(RuntimeError::InvalidCompletion);
                }
                self.jobs.get_mut(&effect.job.id).unwrap().usage = zero();
            }
            _ => return Err(RuntimeError::InvalidCompletion),
        }
        self.in_flight = None;
        self.remove_released(effect.job.id);
        Ok(())
    }
    fn validate_usage(
        &self,
        source: &SourceDescriptor,
        budget: &ParseFactsStepBudget,
        usage: &ParseFactsUsage,
        ready: bool,
    ) -> Result<(), RuntimeError> {
        if usage.source_bytes != if ready { 0 } else { source.bytes }
            || usage.scratch_bytes > budget.max_scratch_bytes
            || usage.facts_bytes > budget.max_facts_bytes
            || ready && usage.scratch_bytes != 0
        {
            return Err(RuntimeError::InvalidUsage);
        }
        Ok(())
    }
    fn remove_released(&mut self, id: u64) {
        let remove = self.jobs.get(&id).map_or(false, |j| {
            j.acknowledged
                && !j.needs_drop
                && j.usage == zero()
                && self.in_flight.as_ref().map_or(true, |e| e.job.id != id)
        });
        if remove {
            let token = self.jobs.remove(&id).unwrap().token;
            if let Some(buffer) = self.buffers.get_mut(&token.tag.buffer) {
                if buffer.current == Some(id) {
                    buffer.current = None;
                }
            }
        }
        self.prune_buffers();
    }
    fn prune_buffers(&mut self) {
        self.buffers.retain(|key, buffer| {
            !buffer.releasing || self.jobs.values().any(|j| j.token.tag.buffer == *key)
        });
    }
    fn plan(&mut self) -> Result<(), RuntimeError> {
        if self.in_flight.is_some() {
            return Ok(());
        }
        if let Some(id) = self
            .jobs
            .iter()
            .find_map(|(id, j)| j.needs_drop.then_some(*id))
        {
            return self.issue(id, Effect::DropJob);
        }
        if self.retired {
            return Ok(());
        }
        if self.next_effect >= LAST_NORMAL_EFFECT {
            let ids: Vec<_> = self
                .jobs
                .iter()
                .filter_map(|(id, j)| j.outcome.is_none().then_some(*id))
                .collect();
            for id in ids {
                self.stop(
                    id,
                    OutcomeKind::Unavailable(UnavailableCode::CounterExhausted),
                );
            }
            if let Some(id) = self
                .jobs
                .iter()
                .find_map(|(id, j)| j.needs_drop.then_some(*id))
            {
                return self.issue(id, Effect::DropJob);
            }
            return Ok(());
        }
        let total = self.usage();
        // Finished unacknowledged facts can legitimately block new work. Partial
        // jobs alone never all wait: attempt a phase with remaining headroom;
        // actual Resource terminates/releases that job so the others can run.
        if total.facts_bytes == MAX_DRAFT_FACTS_BYTES
            && self
                .jobs
                .values()
                .any(|j| j.outcome == Some(OutcomeKind::Ready) && j.usage.facts_bytes > 0)
        {
            return Ok(());
        }
        while let Some(id) = self.queue.pop_front() {
            let Some(job) = self.jobs.get(&id) else {
                continue;
            };
            if job.outcome.is_some() || !job.sealed {
                continue;
            }
            let budget = ParseFactsStepBudget {
                max_scratch_bytes: MAX_DRAFT_SCRATCH_BYTES
                    - (total.scratch_bytes - job.usage.scratch_bytes),
                max_facts_bytes: MAX_DRAFT_FACTS_BYTES
                    - (total.facts_bytes - job.usage.facts_bytes),
            };
            return self.issue(
                id,
                Effect::ParsePhase {
                    phase: job.phase,
                    budget,
                    phases_completed: job.phases_completed,
                },
            );
        }
        Ok(())
    }
    fn issue(&mut self, id: u64, kind: Effect) -> Result<(), RuntimeError> {
        let sequence = self
            .next_effect
            .checked_add(1)
            .ok_or(RuntimeError::CounterExhausted)?;
        self.next_effect = sequence;
        self.in_flight = Some(IssuedEffect {
            lifetime: self.lifetime.clone(),
            id: sequence,
            job: self.jobs[&id].token.clone(),
            kind,
        });
        Ok(())
    }
    fn report(&self, admitted: Option<JobToken>, replay: bool) -> Reduction {
        let usage = self.usage();
        let execution = if self.in_flight.is_some() {
            Execution::Dispatch
        } else if self.retired && self.jobs.is_empty() {
            Execution::Quiesced
        } else if usage.facts_bytes == MAX_DRAFT_FACTS_BYTES
            && self
                .jobs
                .values()
                .any(|j| j.outcome == Some(OutcomeKind::Ready))
        {
            Execution::WaitForAcknowledgement
        } else if self.jobs.values().any(|j| j.outcome.is_none() && !j.sealed) {
            Execution::WaitForInput
        } else {
            Execution::Idle
        };
        Reduction {
            admitted,
            replay,
            execution,
            in_flight: self.in_flight.clone(),
            outcomes: self
                .jobs
                .values()
                .filter(|j| !j.acknowledged)
                .filter_map(|j| {
                    j.outcome.clone().map(|kind| Outcome {
                        job: j.token.clone(),
                        kind,
                    })
                })
                .collect(),
            usage,
        }
    }
}
