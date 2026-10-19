//! Portable actual draft parser ownership and committed/draft execution gate.
//!
//! Hosts retain committed IO and its receipt. This owner retains the actual
//! source/parser/facts and one draft receipt, and settles each selected effect
//! exactly once through the existing arbiter. Call next_turn only after reentering
//! the host operation queue. Arc attachment does not account for earlier copies.
use crate::{document_runtime as c, document_work_runtime as w, draft_runtime as d};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::{ParseFacts, ParseFactsJob, ParseFactsJobError};

#[derive(Clone, Debug)]
pub enum DraftCommand {
    Request(d::DraftRequest),
    Cancel {
        client: OperationId,
        job: d::JobToken,
    },
    Acknowledge {
        client: OperationId,
        job: d::JobToken,
    },
    ReleaseBuffer(d::BufferKey),
    ReleaseClient(OperationId),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftSnapshot {
    pub runtime: d::Reduction,
    pub work: w::Snapshot,
    pub handles: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftStepRecord {
    pub issued: d::IssuedEffect,
    pub completion: d::Completion,
    pub reduction: d::Reduction,
}
#[derive(Debug)]
pub enum DraftExecutorError {
    Draft(d::RuntimeError),
    Work(w::WorkError),
    SourceMismatch,
    Expired,
    NotReady,
    Closed,
    UnexpectedParserState,
}
impl std::fmt::Display for DraftExecutorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DraftExecutorError {}
impl From<d::RuntimeError> for DraftExecutorError {
    fn from(error: d::RuntimeError) -> Self {
        Self::Draft(error)
    }
}
impl From<w::WorkError> for DraftExecutorError {
    fn from(error: w::WorkError) -> Self {
        Self::Work(error)
    }
}
struct OwnedJob {
    token: d::JobToken,
    source: d::SourceDescriptor,
    parser: Option<ParseFactsJob>,
    // Moved out of the Ready parser, never cloned into a receipt or snapshot.
    // The core's pre-transfer phase usage stays charged until actual Drop.
    facts: Option<ParseFacts>,
}
pub struct DocumentDraftExecutor {
    core: d::DraftRuntime,
    work: w::DocumentWorkRuntime,
    jobs: BTreeMap<u64, OwnedJob>,
    // One bounded actual draft receipt; no source or facts payload.
    last_step: Option<DraftStepRecord>,
}
impl DocumentDraftExecutor {
    pub fn new(draft_lifetime: OperationId, work_incarnation: OperationId) -> Self {
        Self {
            core: d::DraftRuntime::new(draft_lifetime),
            work: w::DocumentWorkRuntime::new(work_incarnation),
            jobs: BTreeMap::new(),
            last_step: None,
        }
    }
    /// Reserve canonical input before retention; commands do not run parser phases.
    pub fn command(&mut self, command: DraftCommand) -> Result<d::Reduction, DraftExecutorError> {
        let owner = self;
        if matches!(&command, DraftCommand::Request(_)) && owner.work.snapshot().closing {
            return Err(DraftExecutorError::Closed);
        }
        let request = match &command {
            DraftCommand::Request(request) => Some(request.clone()),
            _ => None,
        };
        let input = match command {
            DraftCommand::Request(request) => d::Input::Request(request),
            DraftCommand::Cancel { client, job } => d::Input::Cancel { client, job },
            DraftCommand::Acknowledge { client, job } => d::Input::Acknowledge { client, job },
            DraftCommand::ReleaseBuffer(buffer) => d::Input::ReleaseBuffer(buffer),
            DraftCommand::ReleaseClient(client) => d::Input::ReleaseClient(client),
        };
        let result = owner.core.reduce(input)?;
        if let Some(request) = request {
            let token = result.admitted.as_ref().expect("request admitted");
            // Exact same-revision replay reuses the actual parser/Arc/facts.
            // Do not recreate an empty job after its actual payload was dropped.
            if !result.replay {
                owner.jobs.insert(
                    token.id,
                    OwnedJob {
                        token: token.clone(),
                        source: request.source,
                        parser: None,
                        facts: None,
                    },
                );
            }
        }
        Ok(result)
    }
    /// Move a previously reserved immutable source into its one actual parser.
    /// UTF-16 length and SHA checks are bounded source scans; earlier conversion
    /// and caller allocations remain a separate adapter responsibility.
    pub fn attach_source(
        &mut self,
        token: &d::JobToken,
        source: Arc<str>,
    ) -> Result<d::Reduction, DraftExecutorError> {
        let owner = self;
        if owner.work.snapshot().closing {
            return Err(DraftExecutorError::Closed);
        }
        let owned = owner
            .jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .ok_or(DraftExecutorError::Expired)?;
        if source.len() != owned.source.bytes
            || source.len() > d::MAX_DRAFT_SOURCE_BYTES
            || source.encode_utf16().count() != owned.source.utf16
            || <[u8; 32]>::from(Sha256::digest(source.as_bytes())) != owned.source.sha256
        {
            return Err(DraftExecutorError::SourceMismatch);
        }
        if owned.parser.is_some() {
            // Replay validates the actual source but never replaces the real
            // parser, resets its counter, or adds another retained source Arc.
            return Ok(owner.core.reduce(d::Input::Seal {
                job: token.clone(),
                actual: owned.source.clone(),
            })?);
        }
        let actual = owned.source.clone();
        let parser = ParseFactsJob::new(source).map_err(|_| DraftExecutorError::SourceMismatch)?;
        let result = owner.core.reduce(d::Input::Seal {
            job: token.clone(),
            actual,
        })?;
        owner.jobs.get_mut(&token.id).unwrap().parser = Some(parser);
        Ok(result)
    }
    /// Borrow exact current unacknowledged Ready facts without copying them.
    pub fn facts(&self, token: &d::JobToken) -> Result<&ParseFacts, DraftExecutorError> {
        let owner = self;
        if owner.work.snapshot().closing {
            return Err(DraftExecutorError::Closed);
        }
        let current = owner
            .core
            .snapshot()
            .outcomes
            .iter()
            .any(|outcome| outcome.job == *token && outcome.kind == d::OutcomeKind::Ready);
        if !current {
            return Err(DraftExecutorError::NotReady);
        }
        owner
            .jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .and_then(|job| job.facts.as_ref())
            .ok_or(DraftExecutorError::Expired)
    }

    pub fn snapshot(&self) -> DraftSnapshot {
        DraftSnapshot {
            runtime: self.core.snapshot(),
            work: self.work.snapshot(),
            handles: self.jobs.len(),
        }
    }
    pub fn work_snapshot(&self) -> w::Snapshot {
        self.work.snapshot()
    }
    /// One newly admitted host turn; deliver returned Continue outcomes.
    pub fn next_turn(
        &mut self,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<w::Turn, DraftExecutorError> {
        Ok(self
            .work
            .select_next_turn(committed, execution, &self.core)?)
    }
    /// Validate the complete actual ticket before any committed IO.
    pub fn admit(
        &self,
        ticket: &w::Ticket,
        committed: &c::DocumentRuntime,
    ) -> Result<w::Admission, DraftExecutorError> {
        Ok(self.work.admit(ticket, committed, &self.core)?)
    }
    /// Settle an actual committed IO result once. Hosts resolve Replay to their
    /// own actual retained receipt before IO and before calling this method.
    pub fn settle_committed(
        &mut self,
        ticket: &w::Ticket,
        completion: c::EffectResult,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<c::Reduction, DraftExecutorError> {
        match self.work.settle(
            ticket,
            w::Completion::Committed(completion),
            committed,
            execution,
            &mut self.core,
        )? {
            w::Settlement::Committed(reduction) => Ok(reduction),
            _ => Err(DraftExecutorError::UnexpectedParserState),
        }
    }
    /// Execute at most one actual phase/cancel/drop. Replay returns the exact
    /// existing receipt without running the parser or completing either child.
    pub fn step_draft(
        &mut self,
        ticket: &w::Ticket,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<DraftStepRecord, DraftExecutorError> {
        let w::ChildEffect::Draft(effect) = &ticket.effect else {
            return Err(DraftExecutorError::Expired);
        };
        if let w::Admission::Replay(lane) = self.admit(ticket, committed)? {
            if lane != w::Lane::Draft {
                return Err(DraftExecutorError::Expired);
            }
            return self
                .last_step
                .as_ref()
                .filter(|record| record.issued == *effect)
                .cloned()
                .ok_or(DraftExecutorError::Expired);
        }
        let actual = execute_draft_effect(self, effect)?;
        let settlement = self.work.settle(
            ticket,
            w::Completion::Draft(actual.clone()),
            committed,
            execution,
            &mut self.core,
        )?;
        let w::Settlement::Draft(reduction) = settlement else {
            return Err(DraftExecutorError::UnexpectedParserState);
        };
        let record = DraftStepRecord {
            issued: effect.clone(),
            completion: actual,
            reduction,
        };
        if record.reduction.execution != d::Execution::Quiesced {
            self.last_step = Some(record.clone());
        }
        Ok(record)
    }
    /// Irreversible whole-owner retirement. No actual payload drop or parse is
    /// hidden here; the retained selection must still be drained explicitly.
    pub fn begin_close(
        &mut self,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<w::Close, DraftExecutorError> {
        self.last_step = None;
        Ok(self
            .work
            .begin_close(committed, execution, &mut self.core)?)
    }
    pub fn close_ready(&self, committed: &c::DocumentRuntime, execution: c::Execution) -> bool {
        self.work.snapshot().closing
            && self.work.snapshot().selected.is_none()
            && execution == c::Execution::Quiesced
            && committed.update().phase == c::Phase::Releasing
            && committed.in_flight().is_none()
            && self.core.snapshot().execution == d::Execution::Quiesced
            && self.core.in_flight().is_none()
            && self.jobs.is_empty()
    }
}
fn execute_draft_effect(
    owner: &mut DocumentDraftExecutor,
    effect: &d::IssuedEffect,
) -> Result<d::Completion, DraftExecutorError> {
    match &effect.kind {
        d::Effect::DropJob => {
            if let Some(job) = owner.jobs.get(&effect.job.id) {
                if job.token != effect.job {
                    return Err(DraftExecutorError::Expired);
                }
            }
            // Removal really drops the parser/source/facts before quota release.
            owner.jobs.remove(&effect.job.id);
            Ok(d::Completion::Dropped)
        }
        d::Effect::ParsePhase {
            phase,
            budget,
            phases_completed,
        } => {
            let current = owner.core.phase_is_current(effect)?;
            let job = owner
                .jobs
                .get_mut(&effect.job.id)
                .filter(|job| job.token == effect.job)
                .ok_or(DraftExecutorError::Expired)?;
            if !current {
                let actual = if let Some(parser) = job.parser.as_mut() {
                    parser.cancel();
                    (parser.usage(), parser.phases_completed())
                } else {
                    (zorid_document::ParseFactsUsage::default(), 0)
                };
                job.facts = None;
                return Ok(d::Completion::Stopped {
                    usage: actual.0,
                    phases_completed: actual.1,
                });
            }
            let parser = job
                .parser
                .as_mut()
                .ok_or(DraftExecutorError::UnexpectedParserState)?;
            if parser.phase() != *phase || parser.phases_completed() != *phases_completed {
                return Err(DraftExecutorError::UnexpectedParserState);
            }
            match parser.step(*budget) {
                Ok(step) => {
                    if step.ready {
                        job.facts = Some(
                            parser
                                .take_facts()
                                .ok_or(DraftExecutorError::UnexpectedParserState)?,
                        );
                    }
                    // Keep the PRE-transfer actual step usage in core even
                    // though take_facts emptied the parser's own usage field.
                    Ok(d::Completion::Parsed(step))
                }
                Err(ParseFactsJobError::Resource { .. }) => Ok(d::Completion::Resource {
                    usage: parser.usage(),
                    phases_completed: parser.phases_completed(),
                }),
                Err(ParseFactsJobError::Cancelled | ParseFactsJobError::Finished) => {
                    Err(DraftExecutorError::UnexpectedParserState)
                }
            }
        }
    }
}
#[cfg(test)]
#[path = "document_draft_executor_tests.rs"]
mod tests;
