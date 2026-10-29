//! Durable host-to-core handoff, separate from synchronization outbox/receipts.
use super::*;
use super::host_source_guards::{HostSourceBinding, HostSourceCapture};
use zorid_core::OperationId;
pub(crate) const SCHEMA: &[(&str,&str)] = &[
    ("host_intents", "CREATE TABLE host_intents (intent_order INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE, entry_id TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','commit_requested','committed','rejected')), acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)), rejection TEXT, UNIQUE(client_id,token))"),
];
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostIntentState {
    Prepared,
    CommitRequested,
    Committed,
    Rejected,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostIntentRef {
    pub client_id: OperationId,
    pub token: OperationId,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostRejectionCode {
    InvalidPath,
    InvalidIdentifier,
    InvalidMutation,
    EntryNotFound,
    EntryDeleted,
    RevisionConflict,
    IdempotencyConflict,
    /// Native proved a definite physical source mismatch before authorship.
    ConditionalSourceChanged,
    /// The host's legitimate capture is no longer available at prepare time.
    SourceCaptureExpired,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostRejection {
    pub code: HostRejectionCode,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HostProjectionState {
    Projected,
    Pending,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostMutationKind {
    Create,
    Write,
    Move,
    Delete,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostIntentView {
    pub token: OperationId,
    pub client_id: OperationId,
    pub operation_id: OperationId,
    pub entry_id: EntryId,
    pub mutation_kind: HostMutationKind,
    pub order: String,
    pub state: HostIntentState,
    pub acknowledged: bool,
    pub receipt: Option<CommitResult>,
    pub error: Option<HostRejection>,
    pub projection: Option<HostProjectionState>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostIntentAcknowledgment {
    Committed {
        operation_id: OperationId,
        sequence: String,
    },
    Rejected {
        operation_id: OperationId,
        code: HostRejectionCode,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostIntentPage {
    pub intents: Vec<HostIntentView>,
    pub next_cursor: String,
    pub has_more: bool,
}
fn invalid(reason: &str) -> StoreError {
    ContractError::InvalidMutation {
        reason: reason.into(),
    }
    .into()
}
fn state(value: &str) -> Result<HostIntentState> {
    match value {
        "prepared" => Ok(HostIntentState::Prepared),
        "commit_requested" => Ok(HostIntentState::CommitRequested),
        "committed" => Ok(HostIntentState::Committed),
        "rejected" => Ok(HostIntentState::Rejected),
        _ => Err(StoreError::Corrupt("invalid host intent state".into())),
    }
}
fn view(tx: &Connection, reference: &HostIntentRef) -> Result<Option<HostIntentView>> {
    let raw=tx.query_row("SELECT intent_order,operation_id,entry_id,state,acknowledged,rejection,json_extract(request,'$.mutation.type') FROM host_intents WHERE client_id=?1 AND token=?2",params![reference.client_id.as_str(),reference.token.as_str()],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,String>(6)?))).optional()?;
    raw.map(|(order, operation, entry, phase, ack, rejection, kind)| {
        if order <= 0 || !matches!(ack, 0 | 1) {
            return Err(StoreError::Corrupt("invalid host intent columns".into()));
        }
        let mutation_kind=match kind.as_str(){"create"=>HostMutationKind::Create,"write"=>HostMutationKind::Write,"move"=>HostMutationKind::Move,"delete"=>HostMutationKind::Delete,_=>return Err(StoreError::Corrupt("invalid intent mutation kind".into()))};
        let operation_id = OperationId::new(operation)?;
        let entry_id = EntryId::new(entry)?;
        let state = state(&phase)?;
        let error = rejection
            .map(|json| serde_json::from_str::<HostRejection>(&json))
            .transpose()?;
        if error.is_some() != (state == HostIntentState::Rejected)
            || (ack == 1
                && !matches!(
                    state,
                    HostIntentState::Committed | HostIntentState::Rejected
                ))
        {
            return Err(StoreError::Corrupt("host intent outcome mismatch".into()));
        }
        let receipt = tx
            .query_row(
                "SELECT o.result,o.request,h.request FROM operations o JOIN host_intents h ON h.client_id=?2 AND h.token=?3 WHERE o.operation_id=?1",
                params![operation_id.as_str(),reference.client_id.as_str(),reference.token.as_str()],
                |r| Ok((r.get::<_, String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)),
            )
            .optional()?
            .map(|(json, raw_request, intent_request)| -> Result<CommitResult> {
                let intent: MutationRequest = serde_json::from_str(&intent_request)?;
                intent.validate()?;
                if intent.operation_id != operation_id || intent.mutation.id() != &entry_id {
                    return Err(StoreError::Corrupt("host intent request identity mismatch".into()));
                }
                let result = operation_request::replay_inline_with_mode(&intent, None, &raw_request, &json)?;
                if result.operation_id != operation_id
                    || !result.changes.iter().any(|c| c.after.id == entry_id)
                {
                    return Err(StoreError::Corrupt(
                        "host intent receipt identity mismatch".into(),
                    ));
                }
                Ok(result)
            })
            .transpose()?;
        if state == HostIntentState::Committed && receipt.is_none()
            || state == HostIntentState::Rejected && receipt.is_some()
        {
            return Err(StoreError::Corrupt(
                "host intent receipt/state mismatch".into(),
            ));
        }
        // An old receipt may predate prepare. It does not authorize execution of
        // the newly prepared handoff; commit attaches it by exact replay later.
        Ok(HostIntentView {
            token: reference.token.clone(),
            client_id: reference.client_id.clone(),
            operation_id,
            entry_id,
            mutation_kind,
            order: order.to_string(),
            state,
            acknowledged: ack == 1,
            receipt: if state == HostIntentState::Committed {
                receipt
            } else {
                None
            },
            error,
            projection: None,
        })
    })
    .transpose()
}
fn request(tx: &Connection, reference: &HostIntentRef) -> Result<MutationRequest> {
    let metadata = view(tx, reference)?.ok_or_else(|| invalid("host intent not found"))?;
    let json: String = tx.query_row(
        "SELECT request FROM host_intents WHERE client_id=?1 AND token=?2",
        params![reference.client_id.as_str(), reference.token.as_str()],
        |r| r.get(0),
    )?;
    let request: MutationRequest = serde_json::from_str(&json)?;
    request.validate()?;
    if request.operation_id != metadata.operation_id || request.mutation.id() != &metadata.entry_id
    {
        return Err(StoreError::Corrupt(
            "host intent request identity mismatch".into(),
        ));
    }
    Ok(request)
}
fn prior(tx: &Connection, request: &MutationRequest) -> Result<Option<CommitResult>> {
    let raw = tx
        .query_row(
            "SELECT request,result FROM operations WHERE operation_id=?1",
            [request.operation_id.as_str()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    raw.map(|(raw, result)| {
        operation_request::replay_inline_with_mode(request, None, &raw, &result)
    })
    .transpose()
}
fn admit_inline_intent(tx: &Connection, command: &MutationRequest) -> Result<()> {
    // Binary intent bytes must never become a second durable body in this
    // generic checkpoint journal. Enrolled binary clients authorize their
    // opaque stage; the editor's bounded Text intent keeps this protocol.
    let authority = text_sync::identity(tx)?;
    if let (Some(realm_id), Some(vault_id)) = (authority.realm_id, authority.vault_id) {
        let metadata = blob_index::load_metadata(tx, &zorid_file_sync::Scope { realm_id, vault_id })?
            .ok_or_else(|| StoreError::Corrupt("enrolled intent graph missing".into()))?;
        match &command.mutation {
            Mutation::Write { id, content, .. }
                if metadata.metadata_view()?.content_bindings().get(id)
                    == Some(&zorid_file_sync::v2::ContentBinding::Binary) =>
            { return Err(StoreError::StreamRequired { bytes: content.len() as u64, limit: 0 }); }
            Mutation::Create { kind: EntryKind::File, .. } => {
                return Err(invalid("enrolled file creation requires a mode-bound family command"));
            }
            _ => {}
        }
    }
    Ok(())
}
/// Called under the same write transaction before ordinary mutation planning.
pub(crate) fn check_execution(tx: &Connection, command: &MutationRequest) -> Result<()> {
    if super::blob_stage::operation_reserved(tx, &command.operation_id)? {
        return Err(ContractError::IdempotencyConflict {
            operation_id: command.operation_id.clone(),
        }
        .into());
    }
    let owner = tx
        .query_row(
            "SELECT client_id,token FROM host_intents WHERE operation_id=?1",
            [command.operation_id.as_str()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((client, token)) = owner {
        let reference = HostIntentRef {
            client_id: OperationId::new(client)?,
            token: OperationId::new(token)?,
        };
        if request(tx, &reference)? != *command {
            return Err(ContractError::IdempotencyConflict {
                operation_id: command.operation_id.clone(),
            }
            .into());
        }
        let current = view(tx, &reference)?.unwrap();
        if !matches!(
            current.state,
            HostIntentState::CommitRequested | HostIntentState::Committed
        ) {
            return Err(invalid("host intent has not authorized this operation"));
        }
    }
    Ok(())
}
/// Atomic with receipt/content/journal; an operation never needs a fake receipt.
pub(crate) fn record_commit(tx: &Connection, command: &MutationRequest) -> Result<()> {
    check_execution(tx, command)?;
    tx.execute("UPDATE host_intents SET state='committed' WHERE operation_id=?1 AND state='commit_requested'",[command.operation_id.as_str()])?;
    Ok(())
}
impl Store {
    /// Advisory preflight before filesystem work; apply rechecks in its write transaction.
    pub fn validate_host_execution(&self, command: &MutationRequest) -> Result<()> {
        let tx = self.connection.unchecked_transaction()?;
        check_execution(&tx, command)?;
        tx.commit()?;
        Ok(())
    }
    pub fn prepare_host_intent(
        &mut self,
        client: &OperationId,
        command: &MutationRequest,
    ) -> Result<HostIntentView> {
        self.prepare_host_intent_with_source(client, command, None, None)
    }
    pub fn prepare_guarded_host_intent(
        &mut self,
        client: &OperationId,
        command: &MutationRequest,
        source: &HostSourceGuard,
    ) -> Result<HostIntentView> {
        self.prepare_host_intent_with_source(client, command, Some(HostSourceBinding::Verified(source.clone())), None)
    }
    /// Native reverified this exact pending capture under a positively admitted
    /// current lease. Attaching evidence and consuming admission are atomic.
    pub fn prepare_captured_host_intent(&mut self, client:&OperationId, owner_token:&OperationId, command:&MutationRequest, source:&HostSourceGuard) -> Result<HostIntentView> {
        let capture=HostSourceCapture {client_id:client.clone(),lease_token:owner_token.clone(),guard:source.clone()};
        self.prepare_host_intent_with_source(client,command,Some(HostSourceBinding::Verified(source.clone())),Some(capture))
    }
    pub fn prepare_rejected_captured_host_intent(&mut self, client:&OperationId, owner_token:&OperationId, command:&MutationRequest, source:&HostSourceGuard, code:HostRejectionCode) -> Result<HostIntentView> {
        if !host_source_guards::rejection_code(code) { return Err(invalid("invalid conditional source rejection")); }
        let capture=HostSourceCapture {client_id:client.clone(),lease_token:owner_token.clone(),guard:source.clone()};
        let rejected=HostSourceBinding::Rejected {capture_id:source.capture_id.clone(),local_store_id:source.local_store_id.clone(),code};
        self.prepare_host_intent_with_source(client,command,Some(rejected),Some(capture))
    }
    pub fn prepare_rejected_guarded_host_intent(
        &mut self,
        client: &OperationId,
        command: &MutationRequest,
        capture: &OperationId,
        code: HostRejectionCode,
    ) -> Result<HostIntentView> {
        if !host_source_guards::rejection_code(code) {
            return Err(invalid("invalid conditional source rejection"));
        }
        let binding = HostSourceBinding::Rejected {
            capture_id: capture.clone(), local_store_id: self.identity()?.local_store_id, code,
        };
        self.prepare_host_intent_with_source(client, command, Some(binding), None)
    }
    fn prepare_host_intent_with_source(
        &mut self,
        client: &OperationId,
        command: &MutationRequest,
        source: Option<HostSourceBinding>,
        capture: Option<HostSourceCapture>,
    ) -> Result<HostIntentView> {
        command.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(source) = &source {
            source.validate(&tx, command)?;
        }
        if let Some(capture)=&capture {
            capture.guard.validate(&tx,command)?;
            if capture.client_id!=*client { return Err(invalid("conditional capture owner mismatch")); }
        }
        if source.is_none() { admit_inline_intent(&tx, command)?; }
        let existing = tx
            .query_row(
                "SELECT client_id,token FROM host_intents WHERE operation_id=?1",
                [command.operation_id.as_str()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let reference = if let Some((owner, token)) = existing {
            if owner != client.as_str() {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: command.operation_id.clone(),
                }
                .into());
            }
            let reference = HostIntentRef {
                client_id: client.clone(),
                token: OperationId::new(token)?,
            };
            if request(&tx, &reference)? != *command {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: command.operation_id.clone(),
                }
                .into());
            }
            let persisted = host_source_guards::load(&tx, &command.operation_id)?;
            let same_source = match (&persisted, &source) {
                (Some(persisted), Some(HostSourceBinding::Rejected { capture_id, .. })) => persisted.capture_id() == capture_id,
                _ => persisted == source,
            };
            if !same_source {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: command.operation_id.clone(),
                }.into());
            }
            reference
        } else {
            // Revocation/consumption and prepare cannot race a loaded guard.
            // Missing or changed pending evidence never falls back to generic
            // guarded preparation, even if a caller retained its old bytes.
            if let Some(capture)=&capture {
                if host_source_guards::pending(&tx,&capture.guard.capture_id)?.as_ref()!=Some(capture) {
                    return Err(ContractError::IdempotencyConflict {operation_id:command.operation_id.clone()}.into());
                }
            }
            if source.is_some() { admit_inline_intent(&tx, command)?; }
            if super::blob_stage::operation_reserved(&tx, &command.operation_id)? {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: command.operation_id.clone(),
                }
                .into());
            }
            let receipt = prior(&tx, command)?;
            if source.is_some() && receipt.is_some() {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: command.operation_id.clone(),
                }.into());
            }
            let reference = HostIntentRef {
                client_id: client.clone(),
                token: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            };
            let rejected = match &source { Some(HostSourceBinding::Rejected { code, .. }) => Some(HostRejection { code: *code }), _ => None };
            tx.execute("INSERT INTO host_intents(client_id,token,operation_id,entry_id,request,state,acknowledged,rejection) VALUES(?1,?2,?3,?4,?5,?6,0,?7)",params![client.as_str(),reference.token.as_str(),command.operation_id.as_str(),command.mutation.id().as_str(),serde_json::to_string(command)?,if rejected.is_some() { "rejected" } else { "prepared" },rejected.map(|rejection| serde_json::to_string(&rejection)).transpose()?])?;
            if let Some(source) = &source {
                host_source_guards::insert(&tx, command, source)?;
            }
            if let Some(capture)=&capture { host_source_guards::consume(&tx,capture)?; }
            reference
        };
        let outcome = view(&tx, &reference)?.unwrap();
        tx.commit()?;
        Ok(outcome)
    }
    /// Exact durable replay before the native host consults ephemeral captures.
    pub fn replay_guarded_host_intent(
        &self,
        client: &OperationId,
        command: &MutationRequest,
        capture: &OperationId,
    ) -> Result<Option<HostIntentView>> {
        command.validate()?;
        let tx = self.connection.unchecked_transaction()?;
        let owner = tx.query_row(
            "SELECT client_id,token FROM host_intents WHERE operation_id=?1",
            [command.operation_id.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional()?;
        let conflict = || StoreError::Contract(ContractError::IdempotencyConflict {
            operation_id: command.operation_id.clone(),
        });
        let outcome = if let Some((owner, token)) = owner {
            if owner != client.as_str() { return Err(conflict()); }
            let reference = HostIntentRef { client_id: client.clone(), token: OperationId::new(token)? };
            if request(&tx, &reference)? != *command { return Err(conflict()); }
            let source = host_source_guards::load(&tx, &command.operation_id)?.ok_or_else(|| conflict())?;
            if source.capture_id() != capture { return Err(conflict()); }
            view(&tx, &reference)?
        } else {
            let capture_used: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM host_intent_sources WHERE capture_id=?1)",
                [capture.as_str()], |row| row.get(0),
            )?;
            if capture_used || super::blob_stage::operation_reserved(&tx, &command.operation_id)?
                || prior(&tx, command)?.is_some() { return Err(conflict()); }
            None
        };
        tx.commit()?;
        Ok(outcome)
    }
    pub fn query_host_intent(&self, reference: &HostIntentRef) -> Result<Option<HostIntentView>> {
        let tx = self.connection.unchecked_transaction()?;
        let value = view(&tx, reference)?;
        tx.commit()?;
        Ok(value)
    }
    /// Native recovery lookup using the original persisted client and token.
    pub fn host_intent_for_operation(&self, operation: &OperationId) -> Result<Option<HostIntentView>> {
        let tx = self.connection.unchecked_transaction()?;
        let owner = tx.query_row(
            "SELECT client_id,token FROM host_intents WHERE operation_id=?1",
            [operation.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional()?;
        let value = owner.map(|(client, token)| {
            view(&tx, &HostIntentRef {
                client_id: OperationId::new(client)?, token: OperationId::new(token)?,
            })
        }).transpose()?.flatten();
        tx.commit()?;
        Ok(value)
    }
    /// Durable execution authorization. Only the enclosing native host invokes
    /// this after the consumer has checkpointed its returned token.
    pub fn request_host_commit(&mut self, reference: &HostIntentRef) -> Result<MutationRequest> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let command = request(&tx, reference)?;
        let current = view(&tx, reference)?.unwrap();
        if current.state == HostIntentState::Rejected {
            return Err(invalid("host intent already rejected"));
        }
        tx.execute("UPDATE host_intents SET state='commit_requested' WHERE client_id=?1 AND token=?2 AND state='prepared'",params![reference.client_id.as_str(),reference.token.as_str()])?;
        if prior(&tx, &command)?.is_some() {
            record_commit(&tx, &command)?;
        }
        tx.commit()?;
        Ok(command)
    }
    /// Store only a known semantic rejection; never call for uncertain I/O.
    pub fn reject_host_intent(
        &mut self,
        reference: &HostIntentRef,
        code: HostRejectionCode,
    ) -> Result<HostIntentView> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let command = request(&tx, reference)?;
        let current = view(&tx, reference)?.unwrap();
        if prior(&tx, &command)?.is_some() {
            record_commit(&tx, &command)?;
        } else if current.state == HostIntentState::CommitRequested {
            tx.execute("UPDATE host_intents SET state='rejected',rejection=?1 WHERE client_id=?2 AND token=?3",params![serde_json::to_string(&HostRejection{code})?,reference.client_id.as_str(),reference.token.as_str()])?;
        } else if current.state != HostIntentState::Rejected
            || current.error.as_ref().map(|e| e.code) != Some(code)
        {
            return Err(invalid("host intent cannot settle this rejection"));
        }
        let result = view(&tx, reference)?.unwrap();
        tx.commit()?;
        Ok(result)
    }
    pub fn acknowledge_host_intent(
        &mut self,
        reference: &HostIntentRef,
        expected: &HostIntentAcknowledgment,
    ) -> Result<HostIntentView> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = view(&tx, reference)?.ok_or_else(|| invalid("host intent not found"))?;
        let matches = match expected {
            HostIntentAcknowledgment::Committed {
                operation_id,
                sequence,
            } => {
                current.state == HostIntentState::Committed
                    && &current.operation_id == operation_id
                    && current
                        .receipt
                        .as_ref()
                        .map(|r| r.sequence.to_string())
                        .as_ref()
                        == Some(sequence)
            }
            HostIntentAcknowledgment::Rejected { operation_id, code } => {
                current.state == HostIntentState::Rejected
                    && &current.operation_id == operation_id
                    && current.error.as_ref().map(|e| e.code) == Some(*code)
            }
        };
        if !matches {
            return Err(invalid(
                "host intent acknowledgment does not match settled outcome",
            ));
        }
        tx.execute(
            "UPDATE host_intents SET acknowledged=1 WHERE client_id=?1 AND token=?2",
            params![reference.client_id.as_str(), reference.token.as_str()],
        )?;
        let outcome = view(&tx, reference)?.unwrap();
        tx.commit()?;
        Ok(outcome)
    }
    /// Metadata and receipts only; never serializes persisted request/file bytes.
    pub fn list_host_intents(
        &self,
        client: &OperationId,
        cursor: &str,
        limit: u32,
    ) -> Result<HostIntentPage> {
        let after = cursor
            .parse::<i64>()
            .ok()
            .filter(|v| *v >= 0 && v.to_string() == cursor)
            .ok_or_else(|| invalid("invalid host intent cursor"))?;
        if !(1..=100).contains(&limit) {
            return Err(invalid("host intent limit must be 1..=100"));
        }
        let tx = self.connection.unchecked_transaction()?;
        let tokens=tx.prepare("SELECT token FROM host_intents WHERE client_id=?1 AND intent_order>?2 ORDER BY intent_order LIMIT ?3")?.query_map(params![client.as_str(),after,limit+1],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let has_more = tokens.len() > limit as usize;
        let mut intents = Vec::new();
        for token in tokens.into_iter().take(limit as usize) {
            intents.push(
                view(
                    &tx,
                    &HostIntentRef {
                        client_id: client.clone(),
                        token: OperationId::new(token)?,
                    },
                )?
                .ok_or_else(|| StoreError::Corrupt("host intent disappeared".into()))?,
            );
        }
        let next_cursor = intents
            .last()
            .map(|v| v.order.clone())
            .unwrap_or_else(|| cursor.into());
        tx.commit()?;
        Ok(HostIntentPage {
            intents,
            next_cursor,
            has_more,
        })
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    use crate::content::BinaryStageLocator;
    use crate::operation_request::{
        BinaryOperationRequest, InlineCallCommitment, OperationRequest,
    };
    use zorid_core::VaultPath;
    use zorid_file_sync::{Manifest, PageRef, Sha256Digest};
    use zorid_sync_protocol::UpdateId;

    #[test]
    fn normalized_binary_write_intent_replays_receipt_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.db");
        let mut store = Store::open(&path).unwrap();
        let id = EntryId::new("file").unwrap();
        let client = OperationId::new("desktop").unwrap();
        store
            .apply(&MutationRequest {
                operation_id: OperationId::new("create").unwrap(),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: VaultPath::new("file.bin").unwrap(),
                    kind: EntryKind::File,
                    content: Some(vec![0]),
                },
            })
            .unwrap();
        let expected_revision = store.read(&id).unwrap().unwrap().state.revision;
        let content = vec![255, 0, 1];
        let request = MutationRequest {
            operation_id: OperationId::new("write").unwrap(),
            mutation: Mutation::Write {
                id: id.clone(),
                expected: expected_revision.clone(),
                content: content.clone(),
            },
        };
        let prepared = store.prepare_host_intent(&client, &request).unwrap();
        let reference = HostIntentRef {
            client_id: client.clone(),
            token: prepared.token,
        };
        store.request_host_commit(&reference).unwrap();
        let receipt = store.apply(&request).unwrap();
        // Normalize only the already committed request fixture. This tests
        // receipt decoding, not stage/source verification or binary activation.
        let mut normalized = BinaryOperationRequest {
            stage: BinaryStageLocator {
                local_store_id: store.identity().unwrap().local_store_id,
                client_id: client.clone(),
                operation_id: request.operation_id.clone(),
                stage_id: OperationId::new("stage").unwrap(),
            },
            request: BinaryStageRequest {
                target: BinaryTarget::Write {
                    id: id.clone(),
                    expected_revision,
                    expected_content_event: UpdateId::new("selected-before").unwrap(),
                },
                expected_length: Some(content.len() as u64),
            },
            manifest: Manifest {
                bytes: content.len() as u64,
                digest: Sha256Digest::of(&content),
                pages: vec![PageRef {
                    id: UpdateId::new("page").unwrap(),
                    bytes: content.len() as u64,
                    digest: Sha256Digest::of(b"page"),
                }],
            },
            source_commitment: Sha256Digest::of(b"durable-source-commitment"),
            original_inline: Some(InlineCallCommitment::from_request(&request, None).unwrap()),
        };
        store
            .connection
            .execute(
                "UPDATE operations SET request=?1 WHERE operation_id=?2",
                params![
                    serde_json::to_string(&OperationRequest::BinaryRef(normalized.clone()))
                        .unwrap(),
                    request.operation_id.as_str()
                ],
            )
            .unwrap();
        assert_eq!(
            store
                .query_host_intent(&reference)
                .unwrap()
                .unwrap()
                .receipt,
            Some(receipt.clone())
        );
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(
            store
                .query_host_intent(&reference)
                .unwrap()
                .unwrap()
                .receipt,
            Some(receipt.clone())
        );
        assert_eq!(
            store.list_host_intents(&client, "0", 10).unwrap().intents[0].receipt,
            Some(receipt.clone())
        );
        assert_eq!(store.request_host_commit(&reference).unwrap(), request);
        let acknowledged = store
            .acknowledge_host_intent(
                &reference,
                &HostIntentAcknowledgment::Committed {
                    operation_id: request.operation_id.clone(),
                    sequence: receipt.sequence.to_string(),
                },
            )
            .unwrap();
        assert!(acknowledged.acknowledged);
        assert_eq!(acknowledged.receipt, Some(receipt));
        normalized.original_inline = None;
        store
            .connection
            .execute(
                "UPDATE operations SET request=?1 WHERE operation_id=?2",
                params![
                    serde_json::to_string(&OperationRequest::BinaryRef(normalized)).unwrap(),
                    request.operation_id.as_str()
                ],
            )
            .unwrap();
        assert!(matches!(
            store.query_host_intent(&reference),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
    }
}

#[cfg(test)]
mod binary_checkpoint_policy_tests {
    use super::*;
    use zorid_core::VaultPath;
    #[test]
    fn enrolled_binary_bytes_never_enter_generic_intent_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("vault")).unwrap();
        store
            .family_enroll(&zorid_file_sync::Scope {
                realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
            })
            .unwrap();
        let entry = EntryId::new("binary").unwrap();
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("create").unwrap(),
                    mutation: Mutation::Create {
                        id: entry.clone(),
                        path: VaultPath::new("binary.bin").unwrap(),
                        kind: EntryKind::File,
                        content: Some(vec![]),
                    },
                },
                Some(FamilyCreateMode::Binary),
            )
            .unwrap();
        let state = store.read_metadata(&entry).unwrap().unwrap().state;
        let request = MutationRequest {
            operation_id: OperationId::new("write").unwrap(),
            mutation: Mutation::Write {
                id: entry,
                expected: state.revision,
                content: vec![],
            },
        };
        assert!(matches!(
            store.prepare_host_intent(&OperationId::new("client").unwrap(), &request),
            Err(StoreError::StreamRequired { bytes: 0, limit: 0 })
        ));
        let count: i64 = store
            .connection
            .query_row("SELECT count(*) FROM host_intents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
