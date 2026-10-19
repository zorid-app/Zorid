//! Transient native draft analysis and the shared committed/draft execution gate.
//!
//! No JSON, upload framing, file writes, cache publication, clock or host loop.
//! Each call executes at most one core-selected effect. Source Arc attachment
//! does not prove a caller's earlier allocation/conversion was memory bounded.
use super::NativeVault;
use crate::document_api::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::{ParseFacts, ParseFactsJob, ParseFactsJobError};
use zorid_index::{document_work_runtime as w, draft_runtime as d};

// Future document_api.rs export leaf (that file is owned by the E2 batch):
// NativeDraftCommand, NativeDraftSnapshot, NativeDraftStepRecord,
// NativeDocumentWorkError, NativeWorkReceipt, NativeWorkStepRecord.
#[derive(Clone, Debug)]
pub enum NativeDraftCommand {
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
pub struct NativeDraftSnapshot {
    pub runtime: d::Reduction,
    pub work: w::Snapshot,
    pub handles: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeDraftStepRecord {
    pub issued: d::IssuedEffect,
    pub completion: d::Completion,
    pub reduction: d::Reduction,
}
#[derive(Clone, Debug)]
pub enum NativeWorkReceipt {
    Committed(NativeDocumentRuntimeStepRecord),
    Draft(NativeDraftStepRecord),
}
#[derive(Clone, Debug)]
pub struct NativeWorkStepRecord {
    pub ticket: w::Ticket,
    pub receipt: NativeWorkReceipt,
}
#[derive(Debug)]
pub enum NativeDocumentWorkError {
    Runtime(NativeDocumentRuntimeError),
    Draft(d::RuntimeError),
    Work(w::WorkError),
    NotStarted,
    SourceMismatch,
    Expired,
    NotReady,
    Closed,
    UnexpectedParserState,
}
impl std::fmt::Display for NativeDocumentWorkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for NativeDocumentWorkError {}
impl From<NativeDocumentRuntimeError> for NativeDocumentWorkError {
    fn from(error: NativeDocumentRuntimeError) -> Self {
        Self::Runtime(error)
    }
}
impl From<d::RuntimeError> for NativeDocumentWorkError {
    fn from(error: d::RuntimeError) -> Self {
        Self::Draft(error)
    }
}
impl From<w::WorkError> for NativeDocumentWorkError {
    fn from(error: w::WorkError) -> Self {
        Self::Work(error)
    }
}
pub(super) fn legacy_error(error: NativeDocumentWorkError) -> NativeDocumentRuntimeError {
    match error {
        NativeDocumentWorkError::Runtime(error) => error,
        NativeDocumentWorkError::Work(w::WorkError::Committed(error)) => error.into(),
        NativeDocumentWorkError::NotStarted => NativeDocumentRuntimeError::NotStarted,
        _ => DocumentRuntimeContractError::UnexpectedCompletion.into(),
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
pub(super) struct NativeDocumentDrafts {
    core: d::DraftRuntime,
    work: w::DocumentWorkRuntime,
    jobs: BTreeMap<u64, OwnedJob>,
    // One bounded actual draft receipt; no source or facts payload.
    last_step: Option<NativeDraftStepRecord>,
}
impl NativeVault {
    fn ensure_document_drafts(&mut self) -> Result<(), NativeDocumentWorkError> {
        self.ensure_document_runtime()?;
        if self.document_drafts.is_none() {
            // Starting after a fully retired committed core would create a
            // composite that cannot receive normal wakes. Require trusted reset.
            if self.document_runtime_snapshot().unwrap().update.phase
                == DocumentRuntimePhase::Releasing
            {
                return Err(NativeDocumentWorkError::Closed);
            }
            self.document_drafts = Some(NativeDocumentDrafts {
                core: d::DraftRuntime::new(super::new_op()),
                work: w::DocumentWorkRuntime::new(super::new_op()),
                jobs: BTreeMap::new(),
                last_step: None,
            });
        }
        Ok(())
    }
    /// Reserve source bytes before retaining an input. This allocates bounded
    /// control metadata only; no parser phase executes during a command.
    pub fn document_draft_command(
        &mut self,
        command: NativeDraftCommand,
    ) -> Result<d::Reduction, NativeDocumentWorkError> {
        self.ensure_document_drafts()?;
        let owner = self.document_drafts.as_mut().unwrap();
        if matches!(&command, NativeDraftCommand::Request(_)) && owner.work.snapshot().closing {
            return Err(NativeDocumentWorkError::Closed);
        }
        let request = match &command {
            NativeDraftCommand::Request(request) => Some(request.clone()),
            _ => None,
        };
        let input = match command {
            NativeDraftCommand::Request(request) => d::Input::Request(request),
            NativeDraftCommand::Cancel { client, job } => d::Input::Cancel { client, job },
            NativeDraftCommand::Acknowledge { client, job } => {
                d::Input::Acknowledge { client, job }
            }
            NativeDraftCommand::ReleaseBuffer(buffer) => d::Input::ReleaseBuffer(buffer),
            NativeDraftCommand::ReleaseClient(client) => d::Input::ReleaseClient(client),
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
    /// Attach one immutable source to its PREVIOUSLY reserved input. The Arc is
    /// moved into the parser, without a source copy. UTF8 is guaranteed by str;
    /// length, UTF16 length and SHA256 are checked by bounded scans. A future
    /// upload/Arc conversion must reserve its own transient copy space first.
    pub fn document_draft_attach_source(
        &mut self,
        token: &d::JobToken,
        source: Arc<str>,
    ) -> Result<d::Reduction, NativeDocumentWorkError> {
        let owner = self
            .document_drafts
            .as_mut()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        if owner.work.snapshot().closing {
            return Err(NativeDocumentWorkError::Closed);
        }
        let owned = owner
            .jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .ok_or(NativeDocumentWorkError::Expired)?;
        if source.len() != owned.source.bytes
            || source.len() > d::MAX_DRAFT_SOURCE_BYTES
            || source.encode_utf16().count() != owned.source.utf16
            || <[u8; 32]>::from(Sha256::digest(source.as_bytes())) != owned.source.sha256
        {
            return Err(NativeDocumentWorkError::SourceMismatch);
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
        let parser =
            ParseFactsJob::new(source).map_err(|_| NativeDocumentWorkError::SourceMismatch)?;
        let result = owner.core.reduce(d::Input::Seal {
            job: token.clone(),
            actual,
        })?;
        owner.jobs.get_mut(&token.id).unwrap().parser = Some(parser);
        Ok(result)
    }
    /// Borrow current exact Ready facts. The Rust borrow prevents quota release
    /// while this reference is held. Transport encoding/copying is a separate
    /// later bounded data-plane responsibility, never a cloned ACK payload.
    pub fn document_draft_facts(
        &self,
        token: &d::JobToken,
    ) -> Result<&ParseFacts, NativeDocumentWorkError> {
        let owner = self
            .document_drafts
            .as_ref()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        if owner.work.snapshot().closing {
            return Err(NativeDocumentWorkError::Closed);
        }
        let current = owner
            .core
            .snapshot()
            .outcomes
            .iter()
            .any(|outcome| outcome.job == *token && outcome.kind == d::OutcomeKind::Ready);
        if !current {
            return Err(NativeDocumentWorkError::NotReady);
        }
        owner
            .jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .and_then(|job| job.facts.as_ref())
            .ok_or(NativeDocumentWorkError::Expired)
    }
    pub fn document_draft_snapshot(&self) -> Option<NativeDraftSnapshot> {
        self.document_drafts
            .as_ref()
            .map(|owner| NativeDraftSnapshot {
                runtime: owner.core.snapshot(),
                work: owner.work.snapshot(),
                handles: owner.jobs.len(),
            })
    }
    /// One newly admitted host turn. A returned pure Continue reduction may
    /// contain actual finished demand outcomes and must be delivered by hosts.
    pub fn document_work_next_turn(&mut self) -> Result<w::Turn, NativeDocumentWorkError> {
        let committed = self
            .document_runtime
            .as_mut()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        let draft = self
            .document_drafts
            .as_mut()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        Ok(draft.work.select_next_turn(
            &mut committed.core,
            &mut committed.execution,
            &draft.core,
        )?)
    }
    /// Validate the exact global selection before work, then settle the actual
    /// result once. This method never calls a complete-and-step wrapper or
    /// recursively selects another effect.
    pub fn document_work_step(
        &mut self,
        ticket: &w::Ticket,
    ) -> Result<NativeWorkStepRecord, NativeDocumentWorkError> {
        let committed = self
            .document_runtime
            .as_ref()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        let draft = self
            .document_drafts
            .as_ref()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        if let w::Admission::Replay(lane) =
            draft.work.admit(ticket, &committed.core, &draft.core)?
        {
            let receipt = match (&ticket.effect, lane) {
                (w::ChildEffect::Committed(effect), w::Lane::Committed) => {
                    let record = self
                        .document_runtime_snapshot()
                        .and_then(|s| s.last_step)
                        .filter(|record| record.receipt.issued == *effect)
                        .ok_or(NativeDocumentWorkError::Expired)?;
                    NativeWorkReceipt::Committed(record)
                }
                (w::ChildEffect::Draft(effect), w::Lane::Draft) => {
                    let record = draft
                        .last_step
                        .as_ref()
                        .filter(|record| record.issued == *effect)
                        .cloned()
                        .ok_or(NativeDocumentWorkError::Expired)?;
                    NativeWorkReceipt::Draft(record)
                }
                _ => return Err(NativeDocumentWorkError::Expired),
            };
            return Ok(NativeWorkStepRecord {
                ticket: ticket.clone(),
                receipt,
            });
        }
        let receipt = match &ticket.effect {
            w::ChildEffect::Committed(effect) => {
                // Preserve actual typed errors, successful pump metrics and the
                // call-owned final Rebuild receipt; do not complete here.
                let actual = self.execute_document_runtime_receipt(effect);
                let committed = self.document_runtime.as_mut().unwrap();
                let draft = self.document_drafts.as_mut().unwrap();
                let settlement = draft.work.settle(
                    ticket,
                    w::Completion::Committed(actual.completion.clone()),
                    &mut committed.core,
                    &mut committed.execution,
                    &mut draft.core,
                )?;
                let w::Settlement::Committed(reduction) = settlement else {
                    return Err(NativeDocumentWorkError::UnexpectedParserState);
                };
                NativeWorkReceipt::Committed(committed.record(reduction, actual))
            }
            w::ChildEffect::Draft(effect) => {
                let draft = self.document_drafts.as_mut().unwrap();
                let actual = execute_draft_effect(draft, effect)?;
                let committed = self.document_runtime.as_mut().unwrap();
                let settlement = draft.work.settle(
                    ticket,
                    w::Completion::Draft(actual.clone()),
                    &mut committed.core,
                    &mut committed.execution,
                    &mut draft.core,
                )?;
                let w::Settlement::Draft(reduction) = settlement else {
                    return Err(NativeDocumentWorkError::UnexpectedParserState);
                };
                let record = NativeDraftStepRecord {
                    issued: effect.clone(),
                    completion: actual,
                    reduction,
                };
                if record.reduction.execution != d::Execution::Quiesced {
                    draft.last_step = Some(record.clone());
                }
                NativeWorkReceipt::Draft(record)
            }
        };
        Ok(NativeWorkStepRecord {
            ticket: ticket.clone(),
            receipt,
        })
    }
    /// Irreversibly retire both child cores, preserving the selected ticket.
    /// No IO, parser phase or memory drop is hidden inside this command.
    pub fn document_work_begin_close(&mut self) -> Result<w::Close, NativeDocumentWorkError> {
        let committed = self
            .document_runtime
            .as_mut()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        let draft = self
            .document_drafts
            .as_mut()
            .ok_or(NativeDocumentWorkError::NotStarted)?;
        // Match existing child retirement: older receipt ownership expires.
        committed.expire_step_receipt();
        draft.last_step = None;
        Ok(draft.work.begin_close(
            &mut committed.core,
            &mut committed.execution,
            &mut draft.core,
        )?)
    }
    /// Pure core drain AND actual payload disposal are required. This is not a
    /// lease release or a claim that external encoded handles have been added.
    pub fn document_work_close_ready(&self) -> bool {
        match (&self.document_runtime, &self.document_drafts) {
            (Some(committed), Some(draft)) => {
                draft.work.snapshot().closing
                    && draft.work.snapshot().selected.is_none()
                    && committed.execution == DocumentRuntimeExecution::Quiesced
                    && committed.core.update().phase == DocumentRuntimePhase::Releasing
                    && committed.core.in_flight().is_none()
                    && draft.core.snapshot().execution == d::Execution::Quiesced
                    && draft.core.in_flight().is_none()
                    && draft.jobs.is_empty()
            }
            _ => false,
        }
    }
    /// Compatibility entry point: committed-only callers retain their old path.
    /// Once composite ownership is active, an old step can execute ONLY its
    /// actual selected committed effect, or replay its actual retained receipt.
    pub(super) fn document_work_legacy_step_record(
        &mut self,
        lifetime: &OperationId,
        effect_id: u64,
    ) -> NativeDocumentRuntimeResult<NativeDocumentRuntimeStepRecord> {
        let result = (|| -> Result<NativeDocumentRuntimeStepRecord, NativeDocumentWorkError> {
            let owner = self
                .document_drafts
                .as_ref()
                .ok_or(NativeDocumentWorkError::NotStarted)?;
            let state = owner.work.snapshot();
            let matches = |ticket: &w::Ticket| match &ticket.effect {
                w::ChildEffect::Committed(effect) => {
                    &effect.lifetime == lifetime && effect.id == effect_id
                }
                _ => false,
            };
            let ticket = if let Some(ticket) = state.last_settled.filter(matches) {
                ticket
            } else if let Some(ticket) = state.selected {
                if !matches(&ticket) {
                    return Err(NativeDocumentWorkError::Expired);
                }
                ticket
            } else {
                let current = self
                    .document_runtime_snapshot()
                    .and_then(|s| s.in_flight)
                    .ok_or(NativeDocumentWorkError::Expired)?;
                if &current.lifetime != lifetime || current.id != effect_id {
                    return Err(NativeDocumentWorkError::Expired);
                }
                let ticket = self
                    .document_work_next_turn()?
                    .ticket
                    .ok_or(NativeDocumentWorkError::Expired)?;
                if !matches(&ticket) {
                    return Err(NativeDocumentWorkError::Expired);
                }
                ticket
            };
            match self.document_work_step(&ticket)?.receipt {
                NativeWorkReceipt::Committed(record) => Ok(record),
                _ => Err(NativeDocumentWorkError::Expired),
            }
        })();
        result.map_err(legacy_error)
    }
}
fn execute_draft_effect(
    owner: &mut NativeDocumentDrafts,
    effect: &d::IssuedEffect,
) -> Result<d::Completion, NativeDocumentWorkError> {
    match &effect.kind {
        d::Effect::DropJob => {
            if let Some(job) = owner.jobs.get(&effect.job.id) {
                if job.token != effect.job {
                    return Err(NativeDocumentWorkError::Expired);
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
                .ok_or(NativeDocumentWorkError::Expired)?;
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
                .ok_or(NativeDocumentWorkError::UnexpectedParserState)?;
            if parser.phase() != *phase || parser.phases_completed() != *phases_completed {
                return Err(NativeDocumentWorkError::UnexpectedParserState);
            }
            match parser.step(*budget) {
                Ok(step) => {
                    if step.ready {
                        job.facts = Some(
                            parser
                                .take_facts()
                                .ok_or(NativeDocumentWorkError::UnexpectedParserState)?,
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
                    Err(NativeDocumentWorkError::UnexpectedParserState)
                }
            }
        }
    }
}
#[cfg(test)]
#[path = "document_drafts_tests.rs"]
mod tests;
