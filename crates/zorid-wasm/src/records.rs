//! Worker-private byte-preserving records plans. No storage or trusted grants here.
use crate::sync::WasmSyncUpdate;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use wasm_bindgen::prelude::*;
use zorid_file_sync::Sha256Digest;
use zorid_records::{
    admission::{self, Admission, Registration, StateUsage, Status},
    wire::Payload,
    Command, Id, Scope, State, MAX_BYTES,
};

type Result<T> = std::result::Result<T, String>;
fn err(value: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&value.to_string())
}
fn core<T>(value: zorid_records::Result<T>) -> Result<T> {
    value.map_err(|e| format!("records {e:?}"))
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8], limit: usize) -> Result<T> {
    if bytes.len() > limit {
        return Err("records input bound".into());
    }
    serde_json::from_slice(bytes).map_err(|_| "invalid records JSON".into())
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| "invalid records output".into())
}
fn canonical<T: serde::de::DeserializeOwned + Serialize>(bytes: &[u8], limit: usize) -> Result<T> {
    let value: T = decode(bytes, limit)?;
    if encode(&value)? != bytes {
        return Err("noncanonical records JSON".into());
    }
    Ok(value)
}
fn text(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|_| "invalid records UTF8".into())
}
fn decimal(value: &str) -> Result<u64> {
    let n: u64 = value.parse().map_err(|_| "invalid records decimal")?;
    if n.to_string() != value {
        return Err("invalid records decimal".into());
    }
    Ok(n)
}
fn registration(bytes: &[u8]) -> Result<Registration> {
    let r: Registration = canonical(bytes, MAX_BYTES)?;
    core(r.schema.validate())?;
    let scope = Scope {
        realm: r.realm.clone(),
        vault: r.vault.clone(),
        owner: r.owner.clone(),
        collection: r.schema.collection.clone(),
        record: core(Id::new("registration-validation"))?,
        generation: core(Id::new("registration-validation"))?,
        restores: None,
    };
    core(admission::check_scope(&r, &scope))?;
    Ok(r)
}
fn command(bytes: &[u8]) -> Result<Command> {
    canonical(bytes, 4 * MAX_BYTES)
}
fn digest(bytes: &[u8]) -> Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| "invalid records revision".into())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    operation: Id,
    update: Id,
    content: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Local {
    operation: Id,
    expected_revision: [u8; 32],
    prior_request: Option<String>,
    prior_result: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Usage {
    records: String,
    state_bytes: String,
    replaced_bytes: String,
    receipts: String,
    receipt_bytes: String,
    operation_bytes: String,
    local_operations: String,
    local_bytes: String,
    changes: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    status: Status,
    revision: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    epoch: String,
    position: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Facts {
    registration: Option<String>,
    registration_revision: Option<String>,
    scope: Scope,
    accepted: Option<String>,
    restore_source: Option<String>,
    operation_sources: Vec<Binding>,
    local: Option<Local>,
    usage: Usage,
    receipt: Option<Receipt>,
    cursor: Option<Cursor>,
}
fn facts(raw: &str) -> Result<Facts> {
    // Canonical source content totals16MiB; JSON string escaping is bounded6x.
    // Additional state/registration/replay documents are bounded independently.
    let f: Facts = decode(raw.as_bytes(), 160 * MAX_BYTES)?;
    if f.operation_sources.len() > 16 * MAX_BYTES {
        return Err("records source facts bound".into());
    }
    let mut previous = None;
    let mut size = 0usize;
    for row in &f.operation_sources {
        core(Id::new(row.operation.as_str()))?;
        core(Id::new(row.update.as_str()))?;
        let key = (&row.operation, &row.update);
        if previous.is_some_and(|p| p >= key) {
            return Err("unordered records sources".into());
        }
        previous = Some(key);
        size = size
            .checked_add(row.content.len())
            .ok_or("records source facts bound")?;
        if row.content.len() > MAX_BYTES || size > 16 * MAX_BYTES {
            return Err("records source facts bound".into());
        }
        // Match native byte comparison, including a conflicting immutable restores
        // link in a source for the same record/generation. Never decode/union it.
    }
    for n in [
        &f.usage.records,
        &f.usage.state_bytes,
        &f.usage.replaced_bytes,
        &f.usage.receipts,
        &f.usage.receipt_bytes,
        &f.usage.operation_bytes,
        &f.usage.local_operations,
        &f.usage.local_bytes,
        &f.usage.changes,
    ] {
        decimal(n)?;
    }
    if let Some(c) = &f.cursor {
        zorid_sync_protocol::ServerEpoch::new(&c.epoch)
            .map_err(|_| "invalid records cursor epoch")?;
        decimal(&c.position)?;
    }
    if let Some(r) = &f.receipt {
        if r.revision.is_empty() || r.revision.len() > 128 {
            return Err("invalid records receipt revision".into());
        }
    }
    Ok(f)
}
fn state_usage(f: &Facts) -> Result<StateUsage> {
    Ok(StateUsage {
        count: decimal(&f.usage.records)?,
        used_bytes: decimal(&f.usage.state_bytes)?,
        replaced_bytes: decimal(&f.usage.replaced_bytes)?,
    })
}
fn prior_restore(f: &Facts, r: &Registration) -> Result<Option<State>> {
    f.restore_source
        .as_deref()
        .map(|s| core(State::restore(r.schema.clone(), s.as_bytes())))
        .transpose()
}
fn bindings(payload: &Payload) -> Result<Vec<Binding>> {
    payload
        .operations()
        .iter()
        .map(|op| {
            Ok(Binding {
                operation: op.id.clone(),
                update: payload.id().clone(),
                content: text(core(admission::canonical_operation(op))?)?,
            })
        })
        .collect()
}
fn conflicting(f: &Facts, incoming: &[Binding]) -> Vec<String> {
    let mut updates = BTreeSet::new();
    for row in incoming {
        let matches: Vec<_> = f
            .operation_sources
            .iter()
            .filter(|old| old.operation == row.operation)
            .collect();
        if matches.iter().any(|old| old.content != row.content) {
            for old in matches {
                updates.insert(old.update.as_str().to_string());
            }
            updates.insert(row.update.as_str().to_string());
        }
    }
    updates.into_iter().collect()
}
#[derive(Serialize)]
struct Output {
    status: Status,
    revision: Option<[u8; 32]>,
    replay_result: Option<String>,
    payload_bytes: Option<u32>,
    conflicting_updates: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Commit {
    operation: Id,
    revision: Sha256Digest,
    sequence: String,
}

#[wasm_bindgen]
pub struct RecordsPlan {
    expected: Option<Facts>,
    output: Output,
    state: Option<Vec<u8>>,
    projection: Option<Vec<u8>>,
    payload: Option<Vec<u8>>,
    request: Option<Vec<u8>>,
    bindings: Vec<Binding>,
    metadata: Option<String>,
}
impl RecordsPlan {
    fn empty(f: Option<Facts>, status: Status) -> Self {
        Self {
            expected: f,
            output: Output {
                status,
                revision: None,
                replay_result: None,
                payload_bytes: None,
                conflicting_updates: vec![],
            },
            state: None,
            projection: None,
            payload: None,
            request: None,
            bindings: vec![],
            metadata: None,
        }
    }
    fn accept(&mut self, state: Vec<u8>, projection: Vec<u8>) {
        self.output.status = Status::Accepted;
        self.output.revision = Some(Sha256Digest::of(&state).0);
        self.state = Some(state);
        self.projection = Some(projection);
    }
}
#[wasm_bindgen]
impl RecordsPlan {
    #[wasm_bindgen(js_name=checkPreconditions)]
    pub fn check_preconditions(&self, raw: &str) -> std::result::Result<(), JsValue> {
        let actual = facts(raw).map_err(err)?;
        if self.expected.as_ref() != Some(&actual) {
            return Err(err("stale records facts"));
        }
        Ok(())
    }
    #[wasm_bindgen(js_name=resultJson)]
    pub fn result_json(&self) -> std::result::Result<String, JsValue> {
        text(encode(&self.output).map_err(err)?).map_err(err)
    }
    #[wasm_bindgen(js_name=nextState)]
    pub fn next_state(&self) -> Option<Vec<u8>> {
        self.state.clone()
    }
    pub fn projection(&self) -> Option<Vec<u8>> {
        self.projection.clone()
    }
    pub fn payload(&self) -> Option<Vec<u8>> {
        self.payload.clone()
    }
    #[wasm_bindgen(js_name=localRequest)]
    pub fn local_request(&self) -> Option<Vec<u8>> {
        self.request.clone()
    }
    #[wasm_bindgen(js_name=operationBindings)]
    pub fn operation_bindings(&self) -> std::result::Result<Vec<u8>, JsValue> {
        encode(&self.bindings).map_err(err)
    }
    #[wasm_bindgen(js_name=payloadMetadataJson)]
    pub fn payload_metadata_json(&self) -> Option<String> {
        self.metadata.clone()
    }
}
#[wasm_bindgen(js_name=validateRecordsRegistration)]
pub fn validate_registration(
    next: &[u8],
    old: Option<Vec<u8>>,
) -> std::result::Result<(), JsValue> {
    let next = registration(next).map_err(err)?;
    if let Some(old) = old {
        core(admission::registration_change(
            &registration(&old).map_err(err)?,
            &next,
        ))
        .map_err(err)?;
    }
    Ok(())
}
#[wasm_bindgen(js_name=validateRecordsAccepted)]
pub fn validate_accepted(r: &[u8], bytes: &[u8]) -> std::result::Result<(), JsValue> {
    let r = registration(r).map_err(err)?;
    let state = core(State::restore(r.schema.clone(), bytes)).map_err(err)?;
    core(admission::restore_accepted(&r, state.scope(), Some(bytes))).map_err(err)?;
    Ok(())
}
#[wasm_bindgen(js_name=recordsSnapshot)]
pub fn snapshot(
    r: &[u8],
    scope_json: &str,
    bytes: Option<Vec<u8>>,
) -> std::result::Result<RecordsPlan, JsValue> {
    snapshot_inner(r, scope_json, bytes.as_deref()).map_err(err)
}
pub(crate) fn snapshot_inner(
    r: &[u8],
    scope_json: &str,
    bytes: Option<&[u8]>,
) -> Result<RecordsPlan> {
    let r = registration(r)?;
    let scope: Scope = decode(scope_json.as_bytes(), 4096)?;
    let state = core(admission::restore_accepted(&r, &scope, bytes))?;
    let mut plan = RecordsPlan::empty(None, Status::Accepted);
    plan.accept(
        core(state.snapshot())?,
        core(admission::projection_bytes(&state))?,
    );
    Ok(plan)
}
#[wasm_bindgen(js_name=canonicalRecordsLocalRequest)]
pub fn canonical_local_request(
    r: &[u8],
    scope_json: &str,
    operation: &str,
    expected: &[u8],
    raw_command: &[u8],
) -> std::result::Result<Vec<u8>, JsValue> {
    let run = || -> Result<Vec<u8>> {
        let r = registration(r)?;
        let scope: Scope = decode(scope_json.as_bytes(), 4096)?;
        core(admission::check_scope(&r, &scope))?;
        core(Id::new(operation))?;
        let request = core(admission::local_request(
            &scope,
            &digest(expected)?,
            &command(raw_command)?,
        ))?;
        if request.len() > 4 * MAX_BYTES {
            return Err("records request bound".into());
        }
        Ok(request)
    };
    run().map_err(err)
}
fn finalize_local_result_inner(operation: &str, revision: &[u8], sequence: &str) -> Result<Vec<u8>> {
    let sequence_value = decimal(sequence)?;
    if sequence_value == 0 || sequence_value > i64::MAX as u64 {
        return Err("records sequence exhausted".into());
    }
    encode(&Commit {
        operation: core(Id::new(operation))?,
        revision: Sha256Digest(digest(revision)?),
        sequence: sequence.into(),
    })
}
#[wasm_bindgen(js_name=finalizeRecordsLocalResult)]
pub fn finalize_local_result(
    operation: &str,
    revision: &[u8],
    sequence: &str,
) -> std::result::Result<Vec<u8>, JsValue> {
    finalize_local_result_inner(operation, revision, sequence).map_err(err)
}
#[wasm_bindgen(js_name=recordsRetryEligible)]
pub fn retry_eligible(raw: &str) -> std::result::Result<bool, JsValue> {
    let status: Status = serde_json::from_value(serde_json::Value::String(raw.into()))
        .map_err(|_| err("invalid records status"))?;
    Ok(status.retry_eligible())
}
#[wasm_bindgen(js_name=recordsLocalReadSet)]
pub fn local_read_set(scope_json: &str, operation: &str) -> std::result::Result<String, JsValue> {
    let run = || -> Result<String> {
        let scope: Scope = decode(scope_json.as_bytes(), 4096)?;
        text(encode(
            &serde_json::json!({"scope":scope,"operations":[core(Id::new(operation))?]}),
        )?)
    };
    run().map_err(err)
}
/// Structural stored-source inspection only; this never grants authentication
/// or creates a receive plan. Only a real opened update can prepare a receive.
#[wasm_bindgen(js_name=recordsStoredReadSet)]
pub fn stored_read_set(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    stored_read_set_inner(bytes).map_err(err)
}
fn stored_read_set_inner(bytes: &[u8]) -> Result<String> {
    read_set(&core(Payload::decode(bytes))?)
}
pub(crate) fn read_set(payload: &Payload) -> Result<String> {
    text(encode(
        &serde_json::json!({"scope":payload.scope(),"operations":payload.operations().iter().map(|op|&op.id).collect::<Vec<_>>()}),
    )?)
}
pub(crate) fn payload_metadata(payload: &Payload, exact: &[u8]) -> Result<String> {
    // Engine IDs are broader than envelope identities; Synced authorship must
    // satisfy the same protocol key constructors used by native metadata().
    zorid_sync_protocol::RealmId::new(payload.scope().realm.as_str())
        .map_err(|_| "invalid records realm")?;
    zorid_sync_protocol::VaultId::new(payload.scope().vault.as_str())
        .map_err(|_| "invalid records vault")?;
    zorid_sync_protocol::UpdateId::new(payload.id().as_str())
        .map_err(|_| "invalid records update")?;
    text(encode(
        &serde_json::json!({"key":{"realm_id":payload.scope().realm,"vault_id":payload.scope().vault,"update_id":payload.id()},
        "family":"records","format_version":1,"payload_digest":Sha256Digest::of(exact),"payload_bytes":exact.len() as u32,"text_binding":null}),
    )?)
}
#[wasm_bindgen(js_name=prepareRecordsLocal)]
pub fn prepare_local(raw: &str, raw_command: &[u8]) -> std::result::Result<RecordsPlan, JsValue> {
    prepare_local_inner(raw, raw_command).map_err(err)
}
pub(crate) fn prepare_local_inner(raw: &str, raw_command: &[u8]) -> Result<RecordsPlan> {
    let f = facts(raw)?;
    let r = registration(
        f.registration
            .as_deref()
            .ok_or("missing records registration")?
            .as_bytes(),
    )?;
    core(admission::check_scope(&r, &f.scope))?;
    if f.registration_revision.is_none() {
        return Err("missing records registration revision".into());
    }
    let local = f.local.as_ref().ok_or("missing records local input")?;
    let command = command(raw_command)?;
    let request = core(admission::local_request(
        &f.scope,
        &local.expected_revision,
        &command,
    ))?;
    if request.len() > 4 * MAX_BYTES {
        return Err("records request bound".into());
    }
    let mut plan = RecordsPlan::empty(Some(f.clone()), Status::Accepted);
    plan.request = Some(request.clone());
    // Replay precedes reading current accepted state, restore evidence or quotas.
    if let Some(prior) = &local.prior_request {
        if prior.as_bytes() != request {
            return Err("records local identity collision".into());
        }
        let result = local
            .prior_result
            .as_ref()
            .ok_or("records replay result missing")?;
        let parsed: Commit = canonical(result.as_bytes(), 2 * MAX_BYTES)?;
        let sequence = decimal(&parsed.sequence)?;
        if parsed.operation != local.operation || sequence == 0 || sequence > i64::MAX as u64 {
            return Err("records replay result mismatch".into());
        }
        plan.output.replay_result = Some(result.clone());
        plan.output.revision = Some(parsed.revision.0);
        return Ok(plan);
    }
    if local.prior_result.is_some() {
        return Err("records replay request missing".into());
    }
    let state = core(admission::restore_accepted(
        &r,
        &f.scope,
        f.accepted.as_deref().map(str::as_bytes),
    ))?;
    if Sha256Digest::of(&core(state.snapshot())?).0 != local.expected_revision {
        return Err("stale records revision".into());
    }
    if !core(admission::restore_ready(
        &f.scope,
        prior_restore(&f, &r)?.as_ref(),
    ))? {
        return Err("records restore lacks tombstone".into());
    }
    let prepared = core(state.prepare(local.operation.clone(), command))?;
    let payload = core(Payload::from_intent(
        local.operation.clone(),
        prepared.payload(),
    ))?;
    let exact = core(payload.encode())?;
    if state.history().contains_key(&local.operation)
        || f.operation_sources
            .iter()
            .any(|row| row.operation == local.operation)
    {
        return Err("records operation already sourced".into());
    }
    if decimal(&f.usage.local_operations)? >= admission::MAX_RECEIPTS
        || decimal(&f.usage.local_bytes)?
            .checked_add(request.len() as u64)
            .and_then(|n| n.checked_add(4096))
            .is_none_or(|n| n > admission::MAX_RECEIPT_BYTES)
    {
        return Err("records local replay quota".into());
    }
    // Match native row constraints before the host attempts writes.
    if request.len() > 2 * MAX_BYTES {
        return Err("records local request row bound".into());
    }
    let state_bytes = core(prepared.next().snapshot())?;
    let projection = core(admission::projection_bytes(prepared.next()))?;
    if !admission::state_fits(state_usage(&f)?, state_bytes.len(), projection.len()) {
        return Err("records state quota".into());
    }
    plan.bindings = bindings(&payload)?;
    source_quota(&f, &plan.bindings)?;
    if decimal(&f.usage.changes)? >= admission::MAX_CHANGES {
        return Err("records changes quota".into());
    }
    plan.accept(state_bytes, projection);
    if r.schema.policy == zorid_records::Policy::Synced {
        plan.output.payload_bytes = Some(exact.len() as u32);
        plan.metadata = Some(payload_metadata(&payload, &exact)?);
        plan.payload = Some(exact);
    }
    Ok(plan)
}
fn source_quota(f: &Facts, bindings: &[Binding]) -> Result<()> {
    let added = bindings
        .iter()
        .try_fold(0u64, |n, b| n.checked_add(b.content.len() as u64))
        .ok_or("records source quota")?;
    if decimal(&f.usage.operation_bytes)?
        .checked_add(added)
        .is_none_or(|n| n > admission::MAX_RECEIPT_BYTES)
    {
        return Err("records source quota".into());
    }
    Ok(())
}
pub(crate) fn prepare_received(payload: &Payload, raw: &str) -> Result<RecordsPlan> {
    let f = facts(raw)?;
    if f.local.is_some() || &f.scope != payload.scope() {
        return Err("records receive scope mismatch".into());
    }
    let mut plan = RecordsPlan::empty(Some(f.clone()), Status::Accepted);
    plan.bindings = bindings(payload)?;
    plan.output.conflicting_updates = conflicting(&f, &plan.bindings);
    // Retry uses already retained bindings; it must not charge them a second time.
    if f.receipt.is_none() {
        source_quota(&f, &plan.bindings)?;
        let len = core(payload.encode())?.len() as u64;
        if decimal(&f.usage.receipts)? >= admission::MAX_RECEIPTS
            || decimal(&f.usage.receipt_bytes)?
                .checked_add(len)
                .is_none_or(|n| n > admission::MAX_RECEIPT_BYTES)
        {
            return Err("records receipt quota".into());
        }
    }
    if !plan.output.conflicting_updates.is_empty() {
        plan.output.status = Status::IntegrityConflict;
        return Ok(plan);
    }
    let r = f
        .registration
        .as_deref()
        .map(|s| registration(s.as_bytes()))
        .transpose()?;
    if let Some(status) = admission::received_gate(payload, r.as_ref(), false) {
        plan.output.status = status;
        return Ok(plan);
    }
    let r = r.ok_or("missing records registration")?;
    if let Some(bytes) = &f.accepted {
        let state = core(State::restore(r.schema.clone(), bytes.as_bytes()))?;
        if state.scope() != payload.scope() {
            plan.output.status = Status::IntegrityConflict;
            return Ok(plan);
        }
    }
    let state = core(admission::restore_accepted(
        &r,
        &f.scope,
        f.accepted.as_deref().map(str::as_bytes),
    ))?;
    let ready = core(admission::restore_ready(
        &f.scope,
        prior_restore(&f, &r)?.as_ref(),
    ))?;
    match core(admission::admit_received(state, payload, ready))? {
        Admission::Retained(status) => plan.output.status = status,
        Admission::Accepted(value) => {
            if admission::state_fits(
                state_usage(&f)?,
                value.state_bytes.len(),
                value.projection_bytes.len(),
            ) {
                plan.accept(value.state_bytes, value.projection_bytes);
            } else {
                plan.output.status = Status::Capacity;
            }
        }
    }
    Ok(plan)
}
#[wasm_bindgen]
impl WasmSyncUpdate {
    #[wasm_bindgen(js_name=recordsReadSetJson)]
    pub fn records_read_set_json(&self) -> std::result::Result<String, JsValue> {
        match &self.family {
            crate::sync::AuthenticatedFamily::Records(value) => {
                read_set(&value.payload).map_err(err)
            }
            _ => Err(err("wrong sync family")),
        }
    }
    #[wasm_bindgen(js_name=prepareRecords)]
    pub fn prepare_records(&self, raw: &str) -> std::result::Result<RecordsPlan, JsValue> {
        match &self.family {
            crate::sync::AuthenticatedFamily::Records(value) => {
                prepare_received(&value.payload, raw).map_err(err)
            }
            _ => Err(err("wrong sync family")),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CollectionScope {
    realm_id: Id,
    vault_id: Id,
    owner: Id,
    collection: Id,
}
#[derive(Serialize)]
struct SingleIntent<'a> {
    format: u32,
    scope: &'a Scope,
    operations: Vec<&'a zorid_records::Operation>,
}
fn static_operation(operation: &zorid_records::Operation, update: Id) -> Result<()> {
    let intent = encode(&SingleIntent {
        format: 1,
        scope: &operation.scope,
        operations: vec![operation],
    })?;
    core(Payload::from_intent(update, &intent))?;
    Ok(())
}
fn validate_stored_operation_inner(
    scope_json: &str,
    operation: &str,
    update: &str,
    content: &[u8],
) -> Result<()> {
    let scope: Scope = decode(scope_json.as_bytes(), 4096)?;
    let operation_id = core(Id::new(operation))?;
    let update = core(Id::new(update))?;
    let op: zorid_records::Operation = canonical(content, MAX_BYTES)?;
    // Durable source keys deliberately omit restores: conflicting immutable
    // restore links are retained as evidence under the same generation key.
    // Validate all six key components here and the operation's full own scope
    // through shared structural wire admission below.
    let actual = &op.scope;
    if actual.realm != scope.realm
        || actual.vault != scope.vault
        || actual.owner != scope.owner
        || actual.collection != scope.collection
        || actual.record != scope.record
        || actual.generation != scope.generation
        || op.id != operation_id
    {
        return Err("records stored operation identity mismatch".into());
    }
    static_operation(&op, update)
}
#[wasm_bindgen(js_name=validateRecordsStoredOperation)]
pub fn validate_stored_operation(
    scope_json: &str,
    operation: &str,
    update: &str,
    content: &[u8],
) -> std::result::Result<(), JsValue> {
    validate_stored_operation_inner(scope_json, operation, update, content).map_err(err)
}
pub(crate) fn validate_stored_replay_inner(
    collection_json: &str,
    operation: &str,
    request: &[u8],
    result: &[u8],
) -> Result<()> {
    let collection: CollectionScope = decode(collection_json.as_bytes(), 4096)?;
    let operation = core(Id::new(operation))?;
    let (scope, _expected, command): (Scope, [u8; 32], Command) =
        canonical(request, 2 * MAX_BYTES)?;
    if scope.realm != collection.realm_id
        || scope.vault != collection.vault_id
        || scope.owner != collection.owner
        || scope.collection != collection.collection
    {
        return Err("records stored replay collection mismatch".into());
    }
    // Validate static command/ID/value shape with the shared wire admission.
    // The retained request has no causal parents/schema version: those remain
    // in the immutable source, not invented as semantic replay evidence here.
    let parent = if operation.as_str() == "replay-validation-parent" {
        "replay-validation-parent-2"
    } else {
        "replay-validation-parent"
    };
    let parents = if matches!(command, Command::Create(_)) {
        vec![]
    } else {
        vec![core(Id::new(parent))?]
    };
    static_operation(
        &zorid_records::Operation {
            id: operation.clone(),
            scope,
            parents,
            schema_version: 1,
            command,
        },
        operation.clone(),
    )?;
    let result: Commit = canonical(result, 2 * MAX_BYTES)?;
    let sequence = decimal(&result.sequence)?;
    if result.operation != operation || sequence == 0 || sequence > i64::MAX as u64 {
        return Err("records stored replay result mismatch".into());
    }
    Ok(())
}
#[wasm_bindgen(js_name=validateRecordsStoredReplay)]
pub fn validate_stored_replay(
    collection_json: &str,
    operation: &str,
    request: &[u8],
    result: &[u8],
) -> std::result::Result<(), JsValue> {
    validate_stored_replay_inner(collection_json, operation, request, result).map_err(err)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BindingEvidence {
    payload: Option<String>,
    registration: Option<String>,
    accepted: Option<String>,
}
fn validate_stored_binding_inner(
    scope_json: &str,
    operation: &str,
    update: &str,
    content: &[u8],
    evidence_json: &str,
) -> Result<()> {
    validate_stored_operation_inner(scope_json, operation, update, content)?;
    let evidence: BindingEvidence = decode(evidence_json.as_bytes(), 20 * MAX_BYTES)?;
    let operation = core(Id::new(operation))?;
    let update = core(Id::new(update))?;
    if let Some(exact) = evidence.payload {
        let payload = core(Payload::decode(exact.as_bytes()))?;
        if payload.id() != &update {
            return Err("records binding source update mismatch".into());
        }
        // Matching exact canonical operation content includes its complete scope.
        let op = payload
            .operations()
            .iter()
            .find(|op| op.id == operation)
            .ok_or("records binding source operation missing")?;
        if core(admission::canonical_operation(op))? != content {
            return Err("records binding source content mismatch".into());
        }
        return Ok(());
    }
    let r = registration(
        evidence
            .registration
            .as_deref()
            .ok_or("records binding registration missing")?
            .as_bytes(),
    )?;
    if r.schema.policy == zorid_records::Policy::Synced || update != operation {
        return Err("records binding lacks immutable source".into());
    }
    let bytes = evidence
        .accepted
        .as_deref()
        .ok_or("records binding accepted state missing")?
        .as_bytes();
    let state = core(State::restore(r.schema.clone(), bytes))?;
    core(admission::restore_accepted(&r, state.scope(), Some(bytes)))?;
    let op = state
        .history()
        .get(&operation)
        .ok_or("records binding accepted operation missing")?;
    if core(admission::canonical_operation(op))? != content {
        return Err("records binding accepted content mismatch".into());
    }
    Ok(())
}
#[wasm_bindgen(js_name=validateRecordsStoredBinding)]
pub fn validate_stored_binding(
    scope_json: &str,
    operation: &str,
    update: &str,
    content: &[u8],
    evidence_json: &str,
) -> std::result::Result<(), JsValue> {
    validate_stored_binding_inner(scope_json, operation, update, content, evidence_json)
        .map_err(err)
}

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
