//! Private storage-independent decisions shared by the native and browser adapters.
//! Facts are not authentication or authorization. Storage owns reads and atomic commit.
use super::*;
use wire::Payload;

pub const MAX_RECORDS: u64 = 1024;
pub const MAX_STATE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_RECEIPTS: u64 = 4096;
pub const MAX_RECEIPT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_CHANGES: u64 = 65536;
pub const MAX_RETRY_COUNT: u32 = 16;
pub const MAX_RETRY_BYTES: usize = MAX_BYTES;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Accepted,
    WaitingDependencies,
    WaitingRestoreSource,
    MissingRegistration,
    IncompatibleSchema,
    PolicyMismatch,
    InvalidOperation,
    Capacity,
    IntegrityConflict,
}
impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::WaitingDependencies => "waiting_dependencies",
            Self::WaitingRestoreSource => "waiting_restore_source",
            Self::MissingRegistration => "missing_registration",
            Self::IncompatibleSchema => "incompatible_schema",
            Self::PolicyMismatch => "policy_mismatch",
            Self::InvalidOperation => "invalid_operation",
            Self::Capacity => "capacity",
            Self::IntegrityConflict => "integrity_conflict",
        }
    }
    pub fn retry_eligible(self) -> bool {
        !matches!(
            self,
            Self::Accepted | Self::IntegrityConflict | Self::InvalidOperation
        )
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub realm: Id,
    pub vault: Id,
    pub owner: Id,
    pub schema: Schema,
}
#[derive(Clone, Copy, Debug)]
pub struct StateUsage {
    pub count: u64,
    pub used_bytes: u64,
    pub replaced_bytes: u64,
}
#[derive(Debug)]
pub struct Accepted {
    pub state: State,
    pub state_bytes: Vec<u8>,
    pub projection_bytes: Vec<u8>,
}
#[derive(Debug)]
pub enum Admission {
    Retained(Status),
    Accepted(Accepted),
}

pub fn check_scope(registration: &Registration, scope: &Scope) -> Result<()> {
    if registration.realm != scope.realm
        || registration.vault != scope.vault
        || registration.owner != scope.owner
        || registration.schema.collection != scope.collection
    {
        return Err(Error::Scope);
    }
    State::new(registration.schema.clone(), scope.clone())?;
    Ok(())
}
pub fn received_gate(
    payload: &Payload,
    registration: Option<&Registration>,
    conflicting_content: bool,
) -> Option<Status> {
    if conflicting_content {
        return Some(Status::IntegrityConflict);
    }
    let Some(registration) = registration else {
        return Some(Status::MissingRegistration);
    };
    if registration.schema.policy != Policy::Synced {
        return Some(Status::PolicyMismatch);
    }
    if payload
        .operations()
        .iter()
        .any(|op| op.schema_version != registration.schema.version)
    {
        return Some(Status::IncompatibleSchema);
    }
    None
}
pub fn restore_accepted(
    registration: &Registration,
    scope: &Scope,
    bytes: Option<&[u8]>,
) -> Result<State> {
    check_scope(registration, scope)?;
    let state = match bytes {
        Some(bytes) => State::restore(registration.schema.clone(), bytes)?,
        None => State::new(registration.schema.clone(), scope.clone())?,
    };
    if state.scope() != scope {
        return Err(Error::Scope);
    }
    if !state.projection()?.pending.is_empty() {
        return Err(Error::MissingDependency);
    }
    Ok(state)
}
pub fn restore_ready(scope: &Scope, prior: Option<&State>) -> Result<bool> {
    let Some(old) = &scope.restores else {
        return Ok(true);
    };
    let Some(state) = prior else {
        return Ok(false);
    };
    let p = state.scope();
    if p.realm != scope.realm
        || p.vault != scope.vault
        || p.owner != scope.owner
        || p.collection != scope.collection
        || p.record != scope.record
        || &p.generation != old
    {
        return Err(Error::Scope);
    }
    let projection = state.projection()?;
    if !projection.pending.is_empty() {
        return Err(Error::MissingDependency);
    }
    Ok(projection.created && projection.deleted)
}
pub fn projection_value(state: &State) -> Result<serde_json::Value> {
    let p = state.projection()?;
    let fields: BTreeMap<_, _> = p
        .fields
        .iter()
        .map(|(id, candidates)| {
            (
                id.as_str(),
                candidates
                    .iter()
                    .map(|c| serde_json::json!({"operation":c.operation,"cell":c.cell}))
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    // Preserve the existing native map serialization and signed integer values.
    Ok(serde_json::json!({"created":p.created,"deleted":p.deleted,"fields":fields,"sets":p.sets}))
}
pub fn projection_bytes(state: &State) -> Result<Vec<u8>> {
    serde_json::to_vec(&projection_value(state)?).map_err(|_| Error::Codec)
}
pub fn admit_received(
    mut state: State,
    payload: &Payload,
    restore_ready: bool,
) -> Result<Admission> {
    if !restore_ready {
        return Ok(Admission::Retained(Status::WaitingRestoreSource));
    }
    match state.union(payload.operations()) {
        Err(Error::Limit) => return Ok(Admission::Retained(Status::Capacity)),
        Err(_) => return Ok(Admission::Retained(Status::InvalidOperation)),
        Ok(()) => (),
    }
    if !state.projection()?.pending.is_empty() {
        return Ok(Admission::Retained(Status::WaitingDependencies));
    }
    let state_bytes = state.snapshot()?;
    let projection_bytes = projection_bytes(&state)?;
    Ok(Admission::Accepted(Accepted {
        state,
        state_bytes,
        projection_bytes,
    }))
}
pub fn state_fits(usage: StateUsage, state_len: usize, projection_len: usize) -> bool {
    if state_len > MAX_BYTES
        || projection_len > MAX_BYTES
        || (usage.replaced_bytes == 0 && usage.count >= MAX_RECORDS)
    {
        return false;
    }
    usage
        .used_bytes
        .checked_sub(usage.replaced_bytes)
        .and_then(|n| n.checked_add(state_len as u64))
        .and_then(|n| n.checked_add(projection_len as u64))
        .is_some_and(|n| n <= MAX_STATE_BYTES)
}
pub fn canonical_operation(operation: &Operation) -> Result<Vec<u8>> {
    encode(operation)
}
pub fn registration_change(old: &Registration, next: &Registration) -> Result<bool> {
    // Decoded IDs and declarations are untrusted, including on an exact repeat.
    for registration in [old, next] {
        registration.schema.validate()?;
        first_party::validate_schema(&registration.owner, &registration.schema)?;
        for id in [&registration.realm, &registration.vault, &registration.owner] {
            id.validate()?;
        }
    }
    if old.realm != next.realm
        || old.vault != next.vault
        || old.owner != next.owner
        || old.schema.collection != next.schema.collection
    {
        return Err(Error::Scope);
    }
    if serde_json::to_vec(old).map_err(|_| Error::Codec)?
        == serde_json::to_vec(next).map_err(|_| Error::Codec)?
    {
        return Ok(false);
    }
    if old.schema.policy != next.schema.policy
        || next.schema.version <= old.schema.version
        || old
            .schema
            .fields
            .iter()
            .any(|(id, field)| next.schema.fields.get(id) != Some(field))
        || next
            .schema
            .fields
            .iter()
            .any(|(id, field)| !old.schema.fields.contains_key(id) && field.required)
    {
        return Err(Error::InvalidSchema);
    }
    Ok(true)
}
pub fn local_request(
    scope: &Scope,
    expected_digest: &[u8; 32],
    command: &Command,
) -> Result<Vec<u8>> {
    // Native request encoding is not restricted to the 1MiB wire/state budget.
    serde_json::to_vec(&(scope, expected_digest, command)).map_err(|_| Error::Codec)
}
