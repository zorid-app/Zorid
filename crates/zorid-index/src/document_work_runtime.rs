//! One execution gate for committed indexing and transient draft analysis.
//!
//! Child reducers retain all admission, cancellation, retry, cleanup and resource
//! policy. This owner selects existing descriptors; it owns no source, facts,
//! stage, pin, receipt payload, clock, timer, IO, or additional effect counter.
//! A caller must re-enter its real operation queue between execution turns.
use crate::{document_runtime as committed, draft_runtime as draft};
use zorid_core::OperationId;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    Committed,
    Draft,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChildEffect {
    Committed(committed::IssuedEffect),
    Draft(draft::IssuedEffect),
}
impl ChildEffect {
    pub fn lane(&self) -> Lane {
        match self {
            Self::Committed(_) => Lane::Committed,
            Self::Draft(_) => Lane::Draft,
        }
    }
}
/// The complete existing child descriptor is the identity. Reusing it avoids a
/// second counter whose exhaustion could prevent final memory or stage drain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub incarnation: OperationId,
    pub effect: ChildEffect,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Execute,
    /// Route to the child's existing one bounded actual receipt, without IO or
    /// reducer completion. Missing/expired child receipt must fail closed; this
    /// routing result is not a replacement receipt or success proof.
    /// The selector deliberately retains no receipt payload.
    Replay(Lane),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Completion {
    Committed(committed::EffectResult),
    Draft(draft::Completion),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settlement {
    Committed(committed::Reduction),
    Draft(draft::Reduction),
    Replay(Lane),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkState {
    Ready,
    Waiting,
    /// Pure child drain only. Before releasing a lease the adapter must also
    /// verify that its actual transient handles and accepted calls are gone.
    Quiesced,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
    pub ticket: Option<Ticket>,
    /// A pure Continue can itself finish foreground demands. Deliver its actual
    /// outcomes rather than silently discarding them during lane selection.
    pub continued: Option<committed::Reduction>,
    pub state: WorkState,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Close {
    pub committed: committed::Reduction,
    pub draft: draft::Reduction,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub selected: Option<Ticket>,
    pub last_settled: Option<Ticket>,
    pub last_served: Option<Lane>,
    pub closing: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkError {
    WrongTicket,
    ExpiredChild,
    WrongCompletion,
    Committed(committed::RuntimeError),
    Draft(draft::RuntimeError),
}

/// Minimal selector state. Every successful settlement advances fairness once;
/// selecting, observing, replaying or rejecting a call does not advance it.
pub struct DocumentWorkRuntime {
    incarnation: OperationId,
    selected: Option<Ticket>,
    last_settled: Option<Ticket>,
    last_served: Option<Lane>,
    closing: bool,
}
impl DocumentWorkRuntime {
    pub fn new(incarnation: OperationId) -> Self {
        Self {
            incarnation,
            selected: None,
            last_settled: None,
            last_served: None,
            closing: false,
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            selected: self.selected.clone(),
            last_settled: self.last_settled.clone(),
            last_served: self.last_served,
            closing: self.closing,
        }
    }
    /// Call only on a newly admitted host macrotask, never recursively from a
    /// settlement. `committed_execution` must be the latest actual child
    /// reduction, updated after EVERY accepted committed command/completion.
    /// Descriptor eligibility always comes from the actual child in_flight.
    pub fn select_next_turn(
        &mut self,
        committed: &mut committed::DocumentRuntime,
        committed_execution: &mut committed::Execution,
        draft: &draft::DraftRuntime,
    ) -> Result<Turn, WorkError> {
        if let Some(ticket) = &self.selected {
            self.check_child(ticket, committed, draft)?;
            return Ok(Turn {
                ticket: Some(ticket.clone()),
                continued: None,
                state: WorkState::Ready,
            });
        }
        let continued = if !self.closing
            && committed.in_flight().is_none()
            && *committed_execution == committed::Execution::Yield
        {
            let result = committed
                .reduce(committed::Input::Continue)
                .map_err(WorkError::Committed)?;
            *committed_execution = result.execution;
            Some(result)
        } else {
            None
        };
        let lane = match (committed.in_flight(), draft.in_flight()) {
            (Some(_), None) => Some(Lane::Committed),
            (None, Some(_)) => Some(Lane::Draft),
            (Some(_), Some(_)) => Some(match self.last_served {
                Some(Lane::Committed) => Lane::Draft,
                Some(Lane::Draft) => Lane::Committed,
                None if committed.update().has_foreground_demand => Lane::Committed,
                None => Lane::Draft,
            }),
            (None, None) => None,
        };
        self.selected = lane.map(|lane| Ticket {
            incarnation: self.incarnation.clone(),
            effect: match lane {
                Lane::Committed => ChildEffect::Committed(committed.in_flight().unwrap().clone()),
                Lane::Draft => ChildEffect::Draft(draft.in_flight().unwrap().clone()),
            },
        });
        let state = if self.selected.is_some() {
            WorkState::Ready
        } else if self.closing
            && *committed_execution == committed::Execution::Quiesced
            && committed.update().phase == committed::Phase::Releasing
            && draft.snapshot().execution == draft::Execution::Quiesced
        {
            WorkState::Quiesced
        } else {
            WorkState::Waiting
        };
        Ok(Turn {
            ticket: self.selected.clone(),
            continued,
            state,
        })
    }
    /// Validate before actual IO/parsing. Exact last-ticket replay routes only
    /// to the child's actual retained receipt, even if another ticket is now
    /// selected. Older tickets expire when the next actual settlement occurs.
    pub fn admit(
        &self,
        ticket: &Ticket,
        committed: &committed::DocumentRuntime,
        draft: &draft::DraftRuntime,
    ) -> Result<Admission, WorkError> {
        if ticket.incarnation != self.incarnation {
            return Err(WorkError::WrongTicket);
        }
        if self.last_settled.as_ref() == Some(ticket) {
            return Ok(Admission::Replay(ticket.effect.lane()));
        }
        if self.selected.as_ref() != Some(ticket) {
            return Err(WorkError::WrongTicket);
        }
        self.check_child(ticket, committed, draft)?;
        Ok(Admission::Execute)
    }
    /// Route the exact selected completion through the existing child reducer.
    /// No next effect is selected/executed here. A rejected child completion
    /// preserves the ticket and fairness. Replay never completes a child twice.
    pub fn settle(
        &mut self,
        ticket: &Ticket,
        completion: Completion,
        committed: &mut committed::DocumentRuntime,
        committed_execution: &mut committed::Execution,
        draft: &mut draft::DraftRuntime,
    ) -> Result<Settlement, WorkError> {
        if !matches!(
            (&ticket.effect, &completion),
            (ChildEffect::Committed(_), Completion::Committed(_))
                | (ChildEffect::Draft(_), Completion::Draft(_))
        ) {
            return Err(WorkError::WrongCompletion);
        }
        if let Admission::Replay(lane) = self.admit(ticket, committed, draft)? {
            return Ok(Settlement::Replay(lane));
        }
        let result = match (&ticket.effect, completion) {
            (ChildEffect::Committed(effect), Completion::Committed(result)) => {
                let reduction = committed
                    .reduce(committed::Input::Complete {
                        lifetime: effect.lifetime.clone(),
                        effect_id: effect.id,
                        result,
                    })
                    .map_err(WorkError::Committed)?;
                *committed_execution = reduction.execution;
                Settlement::Committed(reduction)
            }
            (ChildEffect::Draft(effect), Completion::Draft(completion)) => {
                let reduction = draft
                    .reduce(draft::Input::Complete {
                        effect: effect.clone(),
                        completion,
                    })
                    .map_err(WorkError::Draft)?;
                Settlement::Draft(reduction)
            }
            _ => return Err(WorkError::WrongCompletion),
        };
        self.last_served = Some(ticket.effect.lane());
        self.last_settled = self.selected.take();
        Ok(result)
    }
    /// Reject new feature admission in the owning adapter BEFORE calling this.
    /// Retire is irreversible; preserve the selected descriptor and drain it.
    /// Child Retire preserves its already-issued operation and never rewrites a
    /// ticket into a guessed cancellation, storage result, or different effect.
    pub fn begin_close(
        &mut self,
        committed: &mut committed::DocumentRuntime,
        committed_execution: &mut committed::Execution,
        draft: &mut draft::DraftRuntime,
    ) -> Result<Close, WorkError> {
        // Close intent is irreversible even if a child reports a failure.
        // Preserve the selection so a caller can retry its exact drain; never
        // resume admission after the other child may already have retired.
        self.closing = true;
        self.last_settled = None;
        if let Some(ticket) = &self.selected {
            self.check_child(ticket, committed, draft)?;
        }
        let committed_result = committed
            .reduce(committed::Input::Retire)
            .map_err(WorkError::Committed)?;
        *committed_execution = committed_result.execution;
        let draft_result = draft
            .reduce(draft::Input::Retire)
            .map_err(WorkError::Draft)?;
        Ok(Close {
            committed: committed_result,
            draft: draft_result,
        })
    }
    fn check_child(
        &self,
        ticket: &Ticket,
        committed: &committed::DocumentRuntime,
        draft: &draft::DraftRuntime,
    ) -> Result<(), WorkError> {
        match &ticket.effect {
            ChildEffect::Committed(effect) if committed.in_flight() == Some(effect) => Ok(()),
            ChildEffect::Draft(effect) if draft.in_flight() == Some(effect) => Ok(()),
            _ => Err(WorkError::ExpiredChild),
        }
    }
}
