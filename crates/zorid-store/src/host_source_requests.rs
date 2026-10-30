//! Durable caller-owned capture identity. Physical authority stays in Native's
//! guard; old attached proofs remain an indexed immutable part of this ledger.
use super::host_source_guards as guards;
use super::*;
use zorid_core::{OperationId, VaultPath};

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("host_source_requests", "CREATE TABLE host_source_requests (capture_id TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','attached','released','changed')), lease_token TEXT, record TEXT NOT NULL)"),
    ("host_source_requests_pending", "CREATE INDEX host_source_requests_pending ON host_source_requests(client_id,capture_id) WHERE state='pending'"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostSourceWitness {
    pub entry_id: EntryId,
    pub revision: Revision,
    pub path: VaultPath,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostSourceCaptureRequest {
    pub capture_id: OperationId,
    pub logical_witness: HostSourceWitness,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostSourceRequestLookup {
    Missing,
    Pending(HostSourceCapture),
    Attached { operation_id: OperationId },
    Released,
    Changed,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostSourcePendingRequest {
    pub capture_id: OperationId,
    pub logical_witness: HostSourceWitness,
    pub lease_token: OperationId,
    pub legacy: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Pending,
    Attached,
    Released,
    Changed,
}
impl State {
    fn text(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Attached => "attached",
            Self::Released => "released",
            Self::Changed => "changed",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    local_store_id: OperationId,
    capture_id: OperationId,
    client_id: OperationId,
    logical_witness: Option<HostSourceWitness>,
    state: State,
    lease_token: Option<OperationId>,
    operation_id: Option<OperationId>,
    legacy: bool,
}
fn corrupt() -> StoreError {
    StoreError::Corrupt("inconsistent conditional source request".into())
}
fn conflict(id: &OperationId) -> StoreError {
    ContractError::IdempotencyConflict {
        operation_id: id.clone(),
    }
    .into()
}
pub(super) fn witness(guard: &HostSourceGuard) -> HostSourceWitness {
    HostSourceWitness {
        entry_id: guard.logical_state.id.clone(),
        revision: guard.logical_state.revision.clone(),
        path: guard.logical_state.path.clone(),
    }
}
fn valid_request(client: &OperationId, request: &HostSourceCaptureRequest) -> Result<()> {
    if !guards::valid_owner(client)
        || !guards::valid_owner(&request.capture_id)
        || request.logical_witness.path.as_str().len() > MAX_HOST_SOURCE_PATH_BYTES
    {
        return Err(conflict(&request.capture_id));
    }
    Ok(())
}
fn base(tx: &Connection, client: &OperationId, id: &OperationId, state: State) -> Result<Receipt> {
    Ok(Receipt {
        version: 1,
        local_store_id: text_sync::identity(tx)?.local_store_id,
        capture_id: id.clone(),
        client_id: client.clone(),
        logical_witness: None,
        state,
        lease_token: None,
        operation_id: None,
        legacy: false,
    })
}
fn write(tx: &Connection, value: &Receipt, insert: bool) -> Result<()> {
    let record = serde_json::to_string(value)?;
    if record.len() > 65536 {
        return Err(corrupt());
    }
    let sql = if insert {
        "INSERT INTO host_source_requests(capture_id,client_id,state,lease_token,record) VALUES(?1,?2,?3,?4,?5)"
    } else {
        "UPDATE host_source_requests SET client_id=?2,state=?3,lease_token=?4,record=?5 WHERE capture_id=?1"
    };
    if tx.execute(
        sql,
        params![
            value.capture_id.as_str(),
            value.client_id.as_str(),
            value.state.text(),
            value.lease_token.as_ref().map(OperationId::as_str),
            record
        ],
    )? != 1
    {
        return Err(corrupt());
    }
    Ok(())
}
/// A selected legacy proof is decoded completely; never scan history at open.
fn attachment(tx: &Connection, id: &OperationId) -> Result<Option<(Receipt, MutationRequest)>> {
    let operation: Option<String> = tx
        .query_row(
            "SELECT operation_id FROM host_intent_sources WHERE capture_id=?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let Some(operation) = operation else {
        return Ok(None);
    };
    let operation = OperationId::new(operation).map_err(|_| corrupt())?;
    let binding = guards::load(tx, &operation)?.ok_or_else(corrupt)?;
    let (client, token): (String, String) = tx.query_row(
        "SELECT client_id,token FROM host_intents WHERE operation_id=?1",
        [operation.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let client = OperationId::new(client).map_err(|_| corrupt())?;
    let reference = HostIntentRef {
        client_id: client.clone(),
        token: OperationId::new(token).map_err(|_| corrupt())?,
    };
    let command = host_intents::request(tx, &reference)?;
    if command.operation_id != operation || binding.capture_id() != id {
        return Err(corrupt());
    }
    let mut value = base(tx, &client, id, State::Attached)?;
    value.legacy = true;
    value.operation_id = Some(operation);
    value.logical_witness = match binding {
        guards::HostSourceBinding::Verified(guard) => Some(witness(&guard)),
        guards::HostSourceBinding::Rejected { .. } => None,
    };
    Ok(Some((value, command)))
}
fn raw(tx: &Connection, id: &OperationId) -> Result<Option<Receipt>> {
    let row=tx.query_row("SELECT client_id,state,lease_token,record FROM host_source_requests WHERE capture_id=?1",[id.as_str()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,String>(3)?))).optional()?;
    row.map(|(client, state, token, json)| {
        if json.len() > 65536 {
            return Err(corrupt());
        }
        let value: Receipt = serde_json::from_str(&json).map_err(|_| corrupt())?;
        if value.version != 1
            || value.local_store_id != text_sync::identity(tx)?.local_store_id
            || value.capture_id != *id
            || value.client_id.as_str() != client
            || value.state.text() != state
            || value.lease_token.as_ref().map(OperationId::as_str) != token.as_deref()
            || value.lease_token.is_some() != (value.state == State::Pending)
            || value.operation_id.is_some() != (value.state == State::Attached)
            || (!value.legacy
                && (!guards::valid_owner(&value.client_id) || !guards::valid_owner(id)))
            || value
                .logical_witness
                .as_ref()
                .is_some_and(|w| w.path.as_str().len() > MAX_HOST_SOURCE_PATH_BYTES)
            || (value.logical_witness.is_none()
                && value.state != State::Released
                && !(value.legacy && value.state == State::Attached))
            || value
                .lease_token
                .as_ref()
                .is_some_and(|token| !guards::valid_owner(token))
        {
            return Err(corrupt());
        }
        Ok(value)
    })
    .transpose()
}
fn load(tx: &Connection, id: &OperationId) -> Result<Option<Receipt>> {
    let value = raw(tx, id)?;
    let pending = guards::pending(tx, id)?;
    let attached = attachment(tx, id)?;
    match value {
        None => {
            if pending.is_some() {
                return Err(corrupt());
            }
            Ok(attached.map(|(receipt, _)| receipt))
        }
        Some(value) => {
            match value.state {
                State::Pending => {
                    let pending = pending.ok_or_else(corrupt)?;
                    if attached.is_some()
                        || value.client_id != pending.client_id
                        || value.lease_token.as_ref() != Some(&pending.lease_token)
                        || value.logical_witness.as_ref() != Some(&witness(&pending.guard))
                    {
                        return Err(corrupt());
                    }
                }
                State::Attached => {
                    let (old, command) = attached.ok_or_else(corrupt)?;
                    if pending.is_some() || value.client_id!=old.client_id || value.operation_id!=old.operation_id
                        || old.logical_witness.as_ref().is_some_and(|w|Some(w)!=value.logical_witness.as_ref())
                        || value.logical_witness.as_ref().is_some_and(|w|!matches!(&command.mutation,Mutation::Write{id,expected,..} if id==&w.entry_id&&expected==&w.revision)) {return Err(corrupt());}
                }
                State::Released | State::Changed => {
                    if pending.is_some() || attached.is_some() {
                        return Err(corrupt());
                    }
                }
            }
            Ok(Some(value))
        }
    }
}
fn lookup(
    tx: &Connection,
    client: &OperationId,
    request: &HostSourceCaptureRequest,
) -> Result<HostSourceRequestLookup> {
    valid_request(client, request)?;
    let Some(value) = load(tx, &request.capture_id)? else {
        return Ok(HostSourceRequestLookup::Missing);
    };
    if value.client_id != *client
        || value
            .logical_witness
            .as_ref()
            .is_some_and(|w| w != &request.logical_witness)
    {
        return Err(conflict(&request.capture_id));
    }
    if value.legacy && value.state == State::Attached && value.logical_witness.is_none() {
        let (_, command) = attachment(tx, &request.capture_id)?.ok_or_else(corrupt)?;
        if !matches!(&command.mutation, Mutation::Write { id, expected, .. }
            if id == &request.logical_witness.entry_id && expected == &request.logical_witness.revision)
        {
            return Err(conflict(&request.capture_id));
        }
    }
    outcome(tx, &value)
}
fn outcome(tx: &Connection, value: &Receipt) -> Result<HostSourceRequestLookup> {
    Ok(match value.state {
        State::Pending => HostSourceRequestLookup::Pending(
            guards::pending(tx, &value.capture_id)?.ok_or_else(corrupt)?,
        ),
        State::Attached => HostSourceRequestLookup::Attached {
            operation_id: value.operation_id.clone().ok_or_else(corrupt)?,
        },
        State::Released => HostSourceRequestLookup::Released,
        State::Changed => HostSourceRequestLookup::Changed,
    })
}
pub(super) fn insert_pending(
    tx: &Connection,
    capture: &HostSourceCapture,
    legacy: bool,
) -> Result<()> {
    let mut receipt = base(
        tx,
        &capture.client_id,
        &capture.guard.capture_id,
        State::Pending,
    )?;
    receipt.logical_witness = Some(witness(&capture.guard));
    receipt.lease_token = Some(capture.lease_token.clone());
    receipt.legacy = legacy;
    write(tx, &receipt, true)
}
pub(super) fn validate_pending_set(tx: &Connection) -> Result<(u64, u64)> {
    let budget = guards::usage(tx)?;
    let count = budget.0;
    let ids = tx
        .prepare("SELECT capture_id FROM host_source_requests WHERE state='pending' LIMIT 9")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.len() as u64 != count {
        return Err(corrupt());
    }
    for id in ids {
        if load(tx, &OperationId::new(id).map_err(|_| corrupt())?)?.is_none() {
            return Err(corrupt());
        }
    }
    Ok(budget)
}
/// Called only inside the existing prepare transaction, before consuming guard.
pub(super) fn attach(
    tx: &Connection,
    capture: &HostSourceCapture,
    operation: &OperationId,
) -> Result<()> {
    let mut value = load(tx, &capture.guard.capture_id)?.ok_or_else(corrupt)?;
    if value.state != State::Pending
        || value.client_id != capture.client_id
        || value.lease_token.as_ref() != Some(&capture.lease_token)
        || guards::pending(tx, &capture.guard.capture_id)?.as_ref() != Some(capture)
    {
        return Err(conflict(&capture.guard.capture_id));
    }
    value.state = State::Attached;
    value.lease_token = None;
    value.operation_id = Some(operation.clone());
    write(tx, &value, false)
}
pub(super) fn migrate(tx: &Connection) -> Result<()> {
    // Validate at most nine existing guards. Never traverse historical intents.
    guards::usage(tx)?;
    let ids = tx
        .prepare("SELECT capture_id FROM host_source_captures LIMIT 9")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        let id = OperationId::new(id).map_err(|_| corrupt())?;
        let capture = guards::pending(tx, &id)?.ok_or_else(corrupt)?;
        if attachment(tx, &id)?.is_some() {
            return Err(corrupt());
        }
        insert_pending(tx, &capture, true)?;
    }
    validate_pending_set(tx)?;
    Ok(())
}
impl Store {
    /// Prepare/cancellation status only: a Write may no longer know the old
    /// path. This does not admit a capture or replace exact-witness lookup.
    pub fn host_source_request_status(
        &self,
        client: &OperationId,
        capture: &OperationId,
    ) -> Result<HostSourceRequestLookup> {
        if !guards::valid_owner(client) {
            return Err(conflict(capture));
        }
        let tx = self.connection.unchecked_transaction()?;
        let value = match load(&tx, capture)? {
            Some(value) => {
                if value.client_id != *client {
                    return Err(conflict(capture));
                }
                outcome(&tx, &value)?
            }
            None => HostSourceRequestLookup::Missing,
        };
        tx.commit()?;
        Ok(value)
    }
    pub fn host_source_request(
        &self,
        client: &OperationId,
        request: &HostSourceCaptureRequest,
    ) -> Result<HostSourceRequestLookup> {
        let tx = self.connection.unchecked_transaction()?;
        let value = lookup(&tx, client, request)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn record_host_source_request_changed(
        &mut self,
        client: &OperationId,
        request: &HostSourceCaptureRequest,
    ) -> Result<HostSourceRequestLookup> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = lookup(&tx, client, request)?;
        match previous {
            HostSourceRequestLookup::Missing => {
                let mut value = base(&tx, client, &request.capture_id, State::Changed)?;
                value.logical_witness = Some(request.logical_witness.clone());
                write(&tx, &value, true)?;
            }
            HostSourceRequestLookup::Pending(ref capture) => {
                let mut value = raw(&tx, &request.capture_id)?.ok_or_else(corrupt)?;
                guards::consume(&tx, capture)?;
                value.state = State::Changed;
                value.lease_token = None;
                write(&tx, &value, false)?;
            }
            _ => {
                tx.commit()?;
                return Ok(previous);
            }
        }
        tx.commit()?;
        Ok(HostSourceRequestLookup::Changed)
    }
    pub fn host_source_pending_requests(
        &self,
        client: &OperationId,
    ) -> Result<Vec<HostSourcePendingRequest>> {
        if !guards::valid_owner(client) {
            return Err(conflict(client));
        }
        let tx = self.connection.unchecked_transaction()?;
        validate_pending_set(&tx)?;
        let ids=tx.prepare("SELECT capture_id FROM host_source_requests WHERE client_id=?1 AND state='pending' ORDER BY capture_id LIMIT 9")?.query_map([client.as_str()],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if ids.len() > MAX_HOST_SOURCE_CAPTURES as usize {
            return Err(corrupt());
        }
        let mut values = Vec::with_capacity(ids.len());
        for id in ids {
            let value =
                load(&tx, &OperationId::new(id).map_err(|_| corrupt())?)?.ok_or_else(corrupt)?;
            values.push(HostSourcePendingRequest {
                capture_id: value.capture_id,
                logical_witness: value.logical_witness.ok_or_else(corrupt)?,
                lease_token: value.lease_token.ok_or_else(corrupt)?,
                legacy: value.legacy,
            });
        }
        tx.commit()?;
        Ok(values)
    }
}
/// Trusted registration checks precede insertion in the same Immediate tx.
pub(super) fn admit(tx: &Connection, client: &OperationId, guard: &HostSourceGuard) -> Result<()> {
    let request = HostSourceCaptureRequest {
        capture_id: guard.capture_id.clone(),
        logical_witness: witness(guard),
    };
    valid_request(client, &request)?;
    if load(tx, &guard.capture_id)?.is_some() {
        return Err(conflict(&guard.capture_id));
    }
    Ok(())
}
pub(super) fn validate_capture(tx: &Connection, id: &OperationId) -> Result<()> {
    let _ = load(tx, id)?;
    Ok(())
}
/// Old trusted prepare APIs cannot bypass a caller-owned receipt with stale evidence.
pub(super) fn admit_legacy_attachment(tx: &Connection, id: &OperationId) -> Result<()> {
    if load(tx, id)?.is_some() {
        return Err(conflict(id));
    }
    Ok(())
}
pub(super) fn release(tx: &Connection, client: &OperationId, id: &OperationId) -> Result<()> {
    if !guards::valid_owner(client) {
        return Err(conflict(id));
    }
    match load(tx, id)? {
        Some(mut value) if value.client_id == *client && value.state == State::Pending => {
            let capture = guards::pending(tx, id)?.ok_or_else(corrupt)?;
            guards::consume(tx, &capture)?;
            value.state = State::Released;
            value.lease_token = None;
            write(tx, &value, false)?;
        }
        Some(_) => {} // Foreign and attached releases disclose no ownership or proof.
        None => {
            if !guards::valid_owner(id) {
                return Err(conflict(id));
            }
            write(tx, &base(tx, client, id, State::Released)?, true)?;
        }
    }
    Ok(())
}
