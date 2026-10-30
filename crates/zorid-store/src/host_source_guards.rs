//! Host-only physical source evidence retained with its conditional write.
//! Native validates the actual file; this journal neither reads files nor adds
//! execution authority. The ordinary host commit authorization remains required.
//! Unattached captures survive host loss and have no TTL/implicit garbage
//! collection: Native cannot infer whether a renderer journal still references
//! one. Only explicit same-client release, exact-lease revocation, or atomic
//! attachment frees their bounded pending capacity. Attached intent evidence
//! keeps its existing durable replay lifetime independently of that capacity.
use super::*;
use zorid_core::OperationId;

pub const MAX_HOST_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_HOST_SOURCE_PATH_BYTES: usize = 4096;
pub const MAX_HOST_SOURCE_CAPTURES: u64 = 8;
pub const MAX_HOST_SOURCE_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("host_intent_sources", "CREATE TABLE host_intent_sources (operation_id TEXT PRIMARY KEY NOT NULL REFERENCES host_intents(operation_id), capture_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL)"),
];
pub(super) const CAPTURE_SCHEMA: &[(&str, &str)] = &[
    ("host_source_captures", "CREATE TABLE host_source_captures (capture_id TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL, lease_token TEXT NOT NULL, source_length INTEGER NOT NULL CHECK(source_length>=0 AND source_length<=8388608), record TEXT NOT NULL)"),
];

/// Inert native-only pre-prepare evidence. No source bytes, mutation, execution
/// permission, or renewable lease is stored here. Native must authenticate the
/// current same-client lease and recheck the exact physical/logical guard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostSourceCapture {
    pub client_id: OperationId,
    pub lease_token: OperationId,
    pub guard: HostSourceGuard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostSourceGuard {
    pub version: u32,
    pub capture_id: OperationId,
    pub local_store_id: OperationId,
    pub logical_state: EntryState,
    pub binding: PhysicalBinding,
    pub length: u64,
    pub digest: Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "source", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum HostSourceBinding {
    Verified(HostSourceGuard),
    Rejected { capture_id: OperationId, local_store_id: OperationId, code: HostRejectionCode },
}
impl HostSourceBinding {
    pub(super) fn capture_id(&self) -> &OperationId {
        match self { Self::Verified(guard) => &guard.capture_id, Self::Rejected { capture_id, .. } => capture_id }
    }
    pub(super) fn validate(&self, tx: &Connection, command: &MutationRequest) -> Result<()> {
        match self {
            Self::Verified(guard) => guard.validate(tx, command),
            Self::Rejected { local_store_id, code, .. } => {
                if !matches!(&command.mutation, Mutation::Write { .. })
                    || !rejection_code(*code)
                    || *local_store_id != text_sync::identity(tx)?.local_store_id
                { return Err(ContractError::InvalidMutation {
                    reason: "invalid rejected conditional host source".into(),
                }.into()); }
                Ok(())
            }
        }
    }
}
pub(super) fn rejection_code(code: HostRejectionCode) -> bool {
    matches!(code, HostRejectionCode::SourceCaptureExpired | HostRejectionCode::ConditionalSourceChanged)
}

impl HostSourceGuard {
    fn validate_capture(&self, tx: &Connection) -> Result<()> {
        if self.version != 1
            || self.length > MAX_HOST_SOURCE_BYTES
            || self.logical_state.path.as_str().len() > MAX_HOST_SOURCE_PATH_BYTES
            || self.logical_state.deleted
            || self.logical_state.kind != EntryKind::File
            || self.binding.state.deleted
            || self.binding.state.kind != EntryKind::File
            || self.binding.state.id != self.logical_state.id
            || self.binding.state.path != self.logical_state.path
            || self.local_store_id != text_sync::identity(tx)?.local_store_id
        {
            return Err(ContractError::InvalidMutation {
                reason: "conditional host source does not match this write".into(),
            }.into());
        }
        self.binding.physical.validate()?;
        Ok(())
    }
    pub(super) fn validate(&self, tx: &Connection, command: &MutationRequest) -> Result<()> {
        self.validate_capture(tx)?;
        if !matches!(&command.mutation, Mutation::Write { id, expected, .. }
            if id == &self.logical_state.id && expected == &self.logical_state.revision) {
            return Err(ContractError::InvalidMutation {
                reason: "conditional host source does not match this write".into(),
            }.into());
        }
        Ok(())
    }
}

pub(super) fn valid_owner(value: &OperationId) -> bool {
    uuid::Uuid::parse_str(value.as_str()).ok()
        .is_some_and(|id| id.hyphenated().to_string() == value.as_str())
}
fn capture_corrupt() -> StoreError {
    StoreError::Corrupt("inconsistent conditional source capture".into())
}
pub(super) fn pending(tx: &Connection, capture: &OperationId) -> Result<Option<HostSourceCapture>> {
    let raw = tx.query_row(
        "SELECT client_id,lease_token,source_length,record FROM host_source_captures WHERE capture_id=?1",
        [capture.as_str()], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?)),
    ).optional()?;
    raw.map(|(client,token,length,json)| {
        let length=u64::try_from(length).map_err(|_|capture_corrupt())?;
        if json.len() > 65536 { return Err(capture_corrupt()); }
        let value: HostSourceCapture = serde_json::from_str(&json).map_err(|_| capture_corrupt())?;
        if value.client_id.as_str()!=client || value.lease_token.as_str()!=token
            || value.guard.capture_id!=*capture || value.guard.length!=length
            || !valid_owner(&value.client_id) || !valid_owner(&value.lease_token)
            || value.guard.validate_capture(tx).is_err() { return Err(capture_corrupt()); }
        Ok(value)
    }).transpose()
}
pub(super) fn usage(tx: &Connection) -> Result<(u64,u64)> {
    let mut statement=tx.prepare("SELECT capture_id FROM host_source_captures LIMIT 9")?;
    let ids=statement.query_map([], |row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if ids.len() as u64 > MAX_HOST_SOURCE_CAPTURES { return Err(capture_corrupt()); }
    let mut bytes=0u64;
    for id in &ids {
        let value=pending(tx,&OperationId::new(id.clone()).map_err(|_|capture_corrupt())?)?.ok_or_else(capture_corrupt)?;
        bytes=bytes.checked_add(value.guard.length).ok_or_else(capture_corrupt)?;
    }
    if bytes>MAX_HOST_SOURCE_TOTAL_BYTES { return Err(capture_corrupt()); }
    Ok((ids.len() as u64,bytes))
}
pub(super) fn consume(tx:&Connection, expected:&HostSourceCapture) -> Result<()> {
    if pending(tx,&expected.guard.capture_id)?.as_ref()!=Some(expected) { return Err(ContractError::IdempotencyConflict {operation_id:expected.guard.capture_id.clone()}.into()); }
    let removed=tx.execute("DELETE FROM host_source_captures WHERE capture_id=?1 AND client_id=?2 AND lease_token=?3",params![expected.guard.capture_id.as_str(),expected.client_id.as_str(),expected.lease_token.as_str()])?;
    if removed!=1 { return Err(capture_corrupt()); }
    Ok(())
}

pub(super) fn load(tx: &Connection, operation: &OperationId) -> Result<Option<HostSourceBinding>> {
    let raw = tx.query_row(
        "SELECT capture_id,record FROM host_intent_sources WHERE operation_id=?1",
        [operation.as_str()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ).optional()?;
    raw.map(|(capture, json)| {
        let binding: HostSourceBinding = serde_json::from_str(&json)?;
        let request: Option<(String, String, String, Option<String>)> = tx.query_row(
            "SELECT request,entry_id,state,rejection FROM host_intents WHERE operation_id=?1",
            [operation.as_str()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        let (request, entry, state, rejection) = request.ok_or_else(||
            StoreError::Corrupt("conditional host source has no intent".into()))?;
        let command: MutationRequest = serde_json::from_str(&request)?;
        command.validate()?;
        if binding.capture_id().as_str() != capture || command.operation_id != *operation
            || command.mutation.id().as_str() != entry {
            return Err(StoreError::Corrupt("conditional host source columns mismatch".into()));
        }
        binding.validate(tx, &command).map_err(|_| StoreError::Corrupt(
            "invalid persisted conditional host source".into()))?;
        if let HostSourceBinding::Rejected { code, .. } = &binding {
            let rejection = rejection.map(|json| serde_json::from_str::<HostRejection>(&json)).transpose()?;
            if state != "rejected" || rejection.as_ref().map(|rejection| rejection.code) != Some(*code) {
                return Err(StoreError::Corrupt("rejected conditional source outcome mismatch".into()));
            }
        }
        Ok(binding)
    }).transpose()
}

pub(super) fn insert(tx: &Connection, command: &MutationRequest, binding: &HostSourceBinding) -> Result<()> {
    let used: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM host_intent_sources WHERE capture_id=?1)",
        [binding.capture_id().as_str()], |row| row.get(0),
    )?;
    if used {
        return Err(ContractError::IdempotencyConflict {
            operation_id: command.operation_id.clone(),
        }.into());
    }
    tx.execute(
        "INSERT INTO host_intent_sources(operation_id,capture_id,record) VALUES(?1,?2,?3)",
        params![command.operation_id.as_str(), binding.capture_id().as_str(), serde_json::to_string(binding)?],
    )?;
    Ok(())
}

impl Store {
    /// Trusted native admission only; never exposed through generic checkpoints.
    /// Bounds include all clients and survive process death. Attached intent
    /// guards are not pending captures and are not charged to this budget.
    pub fn register_host_source_capture(&mut self, client:&OperationId, token:&OperationId, guard:&HostSourceGuard) -> Result<bool> {
        let tx=self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        guard.validate_capture(&tx)?;
        if !valid_owner(client)||!valid_owner(token) { return Err(ContractError::InvalidMutation {reason:"invalid conditional source owner".into()}.into()); }
        let value=HostSourceCapture {client_id:client.clone(),lease_token:token.clone(),guard:guard.clone()};
        if let Some(existing)=pending(&tx,&guard.capture_id)? {
            host_source_requests::validate_capture(&tx,&guard.capture_id)?;
            if existing!=value { return Err(ContractError::IdempotencyConflict {operation_id:guard.capture_id.clone()}.into()); }
            tx.commit()?;return Ok(true);
        }
        host_source_requests::admit(&tx,client,guard)?;
        let (count,bytes)=host_source_requests::validate_pending_set(&tx)?;
        if count>=MAX_HOST_SOURCE_CAPTURES || guard.length>MAX_HOST_SOURCE_TOTAL_BYTES.saturating_sub(bytes) { tx.commit()?;return Ok(false); }
        let encoded=serde_json::to_string(&value)?;
        if encoded.len()>65536 { return Err(ContractError::InvalidMutation {reason:"conditional source evidence exceeds bound".into()}.into()); }
        let length=i64::try_from(guard.length).map_err(|_|capture_corrupt())?;
        tx.execute("INSERT INTO host_source_captures(capture_id,client_id,lease_token,source_length,record) VALUES(?1,?2,?3,?4,?5)",params![guard.capture_id.as_str(),client.as_str(),token.as_str(),length,encoded])?;
        host_source_requests::insert_pending(&tx,&value,false)?;
        tx.commit()?;Ok(true)
    }
    pub fn host_source_capture(&self, capture:&OperationId) -> Result<Option<HostSourceCapture>> {
        let tx=self.connection.unchecked_transaction()?;host_source_requests::validate_capture(&tx,capture)?;let value=pending(&tx,capture)?;tx.commit()?;Ok(value)
    }
    pub fn host_source_capture_usage(&self) -> Result<(u64,u64)> {
        let tx=self.connection.unchecked_transaction()?;let value=host_source_requests::validate_pending_set(&tx)?;tx.commit()?;Ok(value)
    }
    /// Current verified ownership of the same client may release an individual
    /// retained capture from a dead lease. It cannot release a foreign client.
    pub fn release_host_source_capture(&mut self, client:&OperationId, capture:&OperationId) -> Result<bool> {
        let tx=self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        host_source_requests::release(&tx,client,capture)?;tx.commit()?;Ok(true)
    }
    /// Exact lease revocation never removes a successor lease's captures.
    pub fn retire_host_source_captures(&mut self, client:&OperationId, token:&OperationId) -> Result<()> {
        let tx=self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !valid_owner(client)||!valid_owner(token){return Err(capture_corrupt());}
        host_source_requests::validate_pending_set(&tx)?;
        let ids=tx.prepare("SELECT capture_id FROM host_source_requests WHERE client_id=?1 AND state='pending' AND lease_token=?2 LIMIT 9")?.query_map(params![client.as_str(),token.as_str()],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for id in ids {host_source_requests::release(&tx,client,&OperationId::new(id).map_err(|_|capture_corrupt())?)?;}
        tx.commit()?;Ok(())
    }
    /// Durable host evidence, scoped to the same client and token as the intent.
    pub fn host_intent_source_guard(&self, reference: &HostIntentRef) -> Result<Option<HostSourceGuard>> {
        let tx = self.connection.unchecked_transaction()?;
        let operation: Option<String> = tx.query_row(
            "SELECT operation_id FROM host_intents WHERE client_id=?1 AND token=?2",
            params![reference.client_id.as_str(), reference.token.as_str()], |row| row.get(0),
        ).optional()?;
        let guard = operation.map(OperationId::new).transpose()?
            .map(|operation| load(&tx, &operation)).transpose()?.flatten()
            .and_then(|binding| match binding { HostSourceBinding::Verified(guard) => Some(guard), HostSourceBinding::Rejected { .. } => None });
        tx.commit()?;
        Ok(guard)
    }

    /// Host recovery lookup after a lost prepare reply; not a wire proof.
    pub fn host_operation_source_guard(&self, operation: &OperationId) -> Result<Option<HostSourceGuard>> {
        let tx = self.connection.unchecked_transaction()?;
        let guard = load(&tx, operation)?.and_then(|binding| match binding {
            HostSourceBinding::Verified(guard) => Some(guard), HostSourceBinding::Rejected { .. } => None,
        });
        tx.commit()?;
        Ok(guard)
    }
}
