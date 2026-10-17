//! Durable host-to-core handoff, separate from synchronization outbox/receipts.
use super::*;
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
                "SELECT result,request=(SELECT request FROM host_intents WHERE client_id=?2 AND token=?3) FROM operations WHERE operation_id=?1",
                params![operation_id.as_str(),reference.client_id.as_str(),reference.token.as_str()],
                |r| Ok((r.get::<_, String>(0)?,r.get::<_,bool>(1)?)),
            )
            .optional()?
            .map(|(json, exact_request)| -> Result<CommitResult> {
                if !exact_request { return Err(StoreError::Corrupt("host intent differs from durable receipt request".into())); }
                let result: CommitResult = serde_json::from_str(&json)?;
                result.validate()?;
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
    let record = raw
        .map(|(a, b)| -> Result<RecordedOperation> {
            Ok(RecordedOperation {
                request: serde_json::from_str(&a)?,
                result: serde_json::from_str(&b)?,
            })
        })
        .transpose()?;
    match check_idempotency(request, record.as_ref())? {
        IdempotencyCheck::New => Ok(None),
        IdempotencyCheck::Replay(r) => Ok(Some(r.clone())),
    }
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
        command.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
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
            reference
        } else {
            if super::blob_stage::operation_reserved(&tx, &command.operation_id)? {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: command.operation_id.clone(),
                }
                .into());
            }
            prior(&tx, command)?;
            let reference = HostIntentRef {
                client_id: client.clone(),
                token: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            };
            tx.execute("INSERT INTO host_intents(client_id,token,operation_id,entry_id,request,state,acknowledged) VALUES(?1,?2,?3,?4,?5,'prepared',0)",params![client.as_str(),reference.token.as_str(),command.operation_id.as_str(),command.mutation.id().as_str(),serde_json::to_string(command)?])?;
            reference
        };
        let outcome = view(&tx, &reference)?.unwrap();
        tx.commit()?;
        Ok(outcome)
    }
    pub fn query_host_intent(&self, reference: &HostIntentRef) -> Result<Option<HostIntentView>> {
        let tx = self.connection.unchecked_transaction()?;
        let value = view(&tx, reference)?;
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
