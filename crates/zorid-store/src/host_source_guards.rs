//! Host-only physical source evidence retained with its conditional write.
//! Native validates the actual file; this journal neither reads files nor adds
//! execution authority. The ordinary host commit authorization remains required.
use super::*;
use zorid_core::OperationId;

pub const MAX_HOST_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_HOST_SOURCE_PATH_BYTES: usize = 4096;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("host_intent_sources", "CREATE TABLE host_intent_sources (operation_id TEXT PRIMARY KEY NOT NULL REFERENCES host_intents(operation_id), capture_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL)"),
];

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
    pub(super) fn validate(&self, tx: &Connection, command: &MutationRequest) -> Result<()> {
        let valid_write = matches!(&command.mutation, Mutation::Write { id, expected, .. }
            if id == &self.logical_state.id && expected == &self.logical_state.revision);
        if self.version != 1
            || !valid_write
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
