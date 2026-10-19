//! Transient native draft analysis and the shared committed/draft execution gate.
//!
//! No JSON, upload framing, file writes, cache publication, clock or host loop.
//! Each call executes at most one core-selected effect. Source Arc attachment
//! does not prove a caller's earlier allocation/conversion was memory bounded.
use super::NativeVault;
use crate::document_api::*;
use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::ParseFacts;
use zorid_index::{document_work_runtime as w, draft_runtime as d};

use zorid_index::document_draft_executor::{DocumentDraftExecutor, DraftExecutorError};
pub use zorid_index::document_draft_executor::{
    DraftCommand as NativeDraftCommand, DraftSnapshot as NativeDraftSnapshot,
    DraftStepRecord as NativeDraftStepRecord,
};

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
impl From<DraftExecutorError> for NativeDocumentWorkError {
    fn from(error: DraftExecutorError) -> Self {
        match error {
            DraftExecutorError::Draft(error) => Self::Draft(error),
            DraftExecutorError::Work(error) => Self::Work(error),
            DraftExecutorError::SourceMismatch => Self::SourceMismatch,
            DraftExecutorError::Expired => Self::Expired,
            DraftExecutorError::NotReady => Self::NotReady,
            DraftExecutorError::Closed => Self::Closed,
            DraftExecutorError::UnexpectedParserState => Self::UnexpectedParserState,
        }
    }
}
pub(super) type NativeDocumentDrafts = DocumentDraftExecutor;
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
            self.document_drafts =
                Some(NativeDocumentDrafts::new(super::new_op(), super::new_op()));
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
        Ok(self.document_drafts.as_mut().unwrap().command(command)?)
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
        Ok(self
            .document_drafts
            .as_mut()
            .ok_or(NativeDocumentWorkError::NotStarted)?
            .attach_source(token, source)?)
    }
    /// Borrow current exact Ready facts. The Rust borrow prevents quota release
    /// while this reference is held. Transport encoding/copying is a separate
    /// later bounded data-plane responsibility, never a cloned ACK payload.
    pub fn document_draft_facts(
        &self,
        token: &d::JobToken,
    ) -> Result<&ParseFacts, NativeDocumentWorkError> {
        Ok(self
            .document_drafts
            .as_ref()
            .ok_or(NativeDocumentWorkError::NotStarted)?
            .facts(token)?)
    }
    pub fn document_draft_snapshot(&self) -> Option<NativeDraftSnapshot> {
        self.document_drafts
            .as_ref()
            .map(DocumentDraftExecutor::snapshot)
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
        Ok(draft.next_turn(&mut committed.core, &mut committed.execution)?)
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
        let receipt = match &ticket.effect {
            w::ChildEffect::Committed(effect) => {
                let admission = draft.admit(ticket, &committed.core)?;
                if let w::Admission::Replay(lane) = admission {
                    if lane != w::Lane::Committed {
                        return Err(NativeDocumentWorkError::Expired);
                    }
                    let record = self
                        .document_runtime_snapshot()
                        .and_then(|s| s.last_step)
                        .filter(|record| record.receipt.issued == *effect)
                        .ok_or(NativeDocumentWorkError::Expired)?;
                    return Ok(NativeWorkStepRecord {
                        ticket: ticket.clone(),
                        receipt: NativeWorkReceipt::Committed(record),
                    });
                }
                // Actual native IO is separate from the shared once-only settlement.
                let actual = self.execute_document_runtime_receipt(effect);
                let committed = self.document_runtime.as_mut().unwrap();
                let reduction = self.document_drafts.as_mut().unwrap().settle_committed(
                    ticket,
                    actual.completion.clone(),
                    &mut committed.core,
                    &mut committed.execution,
                )?;
                NativeWorkReceipt::Committed(committed.record(reduction, actual))
            }
            w::ChildEffect::Draft(_) => {
                let committed = self.document_runtime.as_mut().unwrap();
                let record = self.document_drafts.as_mut().unwrap().step_draft(
                    ticket,
                    &mut committed.core,
                    &mut committed.execution,
                )?;
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
        committed.expire_step_receipt();
        Ok(draft.begin_close(&mut committed.core, &mut committed.execution)?)
    }
    /// Pure core drain AND actual payload disposal are required. This is not a
    /// lease release or a claim that external encoded handles have been added.
    pub fn document_work_close_ready(&self) -> bool {
        match (&self.document_runtime, &self.document_drafts) {
            (Some(committed), Some(draft)) => {
                draft.close_ready(&committed.core, committed.execution)
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
            let state = owner.work_snapshot();
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
#[cfg(test)]
#[path = "document_drafts_tests.rs"]
mod tests;
