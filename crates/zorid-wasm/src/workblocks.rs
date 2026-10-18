//! Fixed worker-private WorkBlock semantics. Storage and authoritative fences belong to the host.
use crate::records::{self, RecordsPlan};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use service::{WindowQuery, WorkBlockCommand as Command, WorkBlockRead, WorkBlockRevision};
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    rc::Rc,
};
use wasm_bindgen::prelude::*;
use zorid_file_sync::Sha256Digest;
use zorid_records::{
    admission, first_party as domain, workblock_service as service, Id, Scope, State, MAX_BYTES,
};

type Result<T> = std::result::Result<T, Failure>;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    code: &'static str,
    source: &'static str,
    commit_uncertain: bool,
}
fn fail(code: &'static str) -> Failure {
    Failure {
        code,
        source: "workblocks",
        commit_uncertain: false,
    }
}
// Bind only native globals so wasm-bindgen needs no separate inline-JS snippet.
// Rust chooses all semantic fields; these imports only construct/populate the object.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = Error)]
    type WorkBlockJsError;
    #[wasm_bindgen(constructor, js_class = "Error")]
    fn new(message: &str) -> WorkBlockJsError;
    #[wasm_bindgen(js_namespace = Reflect, js_name = set)]
    fn set_error_field(target: &JsValue, property: &str, value: &JsValue) -> bool;
}
fn js(e: Failure) -> JsValue {
    let error: JsValue = WorkBlockJsError::new(e.code).into();
    // A freshly constructed native Error is extensible and these are new own fields.
    for (property, value) in [
        ("code", JsValue::from_str(e.code)),
        ("source", JsValue::from_str(e.source)),
        ("commitUncertain", JsValue::from_bool(e.commit_uncertain)),
    ] {
        let assigned = set_error_field(&error, property, &value);
        debug_assert!(assigned);
    }
    error
}
fn domain<T>(r: zorid_records::Result<T>) -> Result<T> {
    r.map_err(|e| {
        fail(match e {
            zorid_records::Error::Limit => "limit",
            _ => "invalid_workblock",
        })
    })
}
fn shared<T>(r: service::ServiceResult<T>) -> Result<T> {
    r.map_err(|e| {
        fail(match e {
            service::ServiceError::Domain(zorid_records::Error::Limit) => "limit",
            service::ServiceError::Domain(_) => "invalid_workblock",
            service::ServiceError::InvalidRequest => "invalid_request",
            service::ServiceError::OperationCollision => "operation_collision",
            service::ServiceError::CorruptJournal => "storage_corrupt",
            service::ServiceError::Limit => "limit",
        })
    })
}
fn decode<T: DeserializeOwned>(b: &[u8], max: usize) -> Result<T> {
    if b.len() > max {
        return Err(fail("limit"));
    }
    serde_json::from_slice(b).map_err(|_| fail("invalid_request"))
}
fn encode<T: Serialize>(v: &T) -> Result<Vec<u8>> {
    let b = serde_json::to_vec(v).map_err(|_| fail("workblock_failed"))?;
    if b.len() > 4 * MAX_BYTES {
        return Err(fail("limit"));
    }
    Ok(b)
}
fn decimal(s: &str) -> Result<u64> {
    let n = s.parse::<u64>().map_err(|_| fail("invalid_request"))?;
    if n.to_string() != s || n > i64::MAX as u64 {
        return Err(fail("invalid_request"));
    }
    Ok(n)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enrolled {
    realm_id: Id,
    vault_id: Id,
}
fn enrolled(s: &str) -> Result<Enrolled> {
    decode(s.as_bytes(), 4096)
}
fn request(b: &[u8]) -> Result<Command> {
    decode(b, 16 * 1024)
}
fn identity(c: &Command) -> Option<(&Id, &Id, Option<&Id>)> {
    use Command::*;
    Some(match c {
        Create {
            record,
            generation,
            operation,
            ..
        }
        | Move {
            record,
            generation,
            operation,
            ..
        }
        | Title {
            record,
            generation,
            operation,
            ..
        }
        | AddRef {
            record,
            generation,
            operation,
            ..
        }
        | RemoveRef {
            record,
            generation,
            operation,
            ..
        }
        | Delete {
            record,
            generation,
            operation,
            ..
        } => (record, generation, Some(operation)),
        Read { record, generation } => (record, generation, None),
        _ => return None,
    })
}
fn scope(e: &Enrolled, c: &Command) -> Result<Scope> {
    let (r, g, _) = identity(c).ok_or_else(|| fail("invalid_request"))?;
    domain(service::fixed_scope(
        e.realm_id.clone(),
        e.vault_id.clone(),
        r.clone(),
        g.clone(),
    ))
}
fn expected(c: &Command, s: &Scope) -> Result<[u8; 32]> {
    use Command::*;
    match c {
        Create {
            generation,
            operation,
            ..
        } => {
            if generation != operation {
                return Err(fail("invalid_request"));
            }
            Ok(Sha256Digest::of(&domain(service::empty_state_bytes(s))?).0)
        }
        Move {
            expected_revision, ..
        }
        | Title {
            expected_revision, ..
        }
        | AddRef {
            expected_revision, ..
        }
        | RemoveRef {
            expected_revision, ..
        }
        | Delete {
            expected_revision, ..
        } => Ok(expected_revision.0),
        _ => Err(fail("invalid_request")),
    }
}
#[wasm_bindgen(js_name=workBlockIdentity)]
pub fn work_block_identity() -> String {
    format!(
        "{{\"owner\":\"{}\",\"collection\":\"{}\",\"schemaVersion\":1}}",
        domain::OWNER,
        domain::COLLECTION
    )
}
#[wasm_bindgen(js_name=workBlockRegistration)]
pub fn work_block_registration(raw: &str) -> std::result::Result<Vec<u8>, JsValue> {
    (|| {
        let e = enrolled(raw)?;
        encode(&domain(domain::registration(e.realm_id, e.vault_id))?)
    })()
    .map_err(js)
}
#[wasm_bindgen(js_name=workBlockReadSet)]
pub fn work_block_read_set(raw: &str, b: &[u8]) -> std::result::Result<String, JsValue> {
    read_set(raw, b).map_err(js)
}
fn read_set(raw: &str, b: &[u8]) -> Result<String> {
    let e = enrolled(raw)?;
    let c = request(b)?;
    let s = identity(&c).map(|_| scope(&e, &c)).transpose()?;
    if let Some((_, _, Some(op))) = identity(&c) {
        domain(Id::new(op.as_str()))?;
    }
    match &c {
        Command::Window {
            from_ms,
            until_ms,
            limit,
            byte_limit,
            ..
        } => {
            shared(service::validate_window(&WindowQuery {
                from: from_ms.clone(),
                until: until_ms.clone(),
                limit: *limit,
                bytes: *byte_limit,
            }))?;
        }
        Command::Changes { after, limit } => {
            decimal(after)?;
            if !(1..=64).contains(limit) {
                return Err(fail("limit"));
            }
        }
        _ => {}
    }
    let witness = if c.may_commit() {
        Some(expected(
            &c,
            s.as_ref().ok_or_else(|| fail("invalid_request"))?,
        )?)
    } else {
        None
    };
    let kind = match c {
        Command::Window { .. } => "window",
        Command::Changes { .. } => "changes",
        Command::Read { .. } => "read",
        _ => "mutation",
    };
    String::from_utf8(encode(
        &serde_json::json!({"scope":s,"operation":identity(&c).and_then(|(_,_,o)|o),"kind":kind,"expectedRevision":witness}),
    )?)
    .map_err(|_| fail("workblock_failed"))
}
fn replay(
    raw: &str,
    b: &[u8],
    prior: Option<&[u8]>,
    result: Option<&[u8]>,
) -> Result<Option<Vec<u8>>> {
    let e = enrolled(raw)?;
    let c = request(b)?;
    let s = scope(&e, &c)?;
    let witness = expected(&c, &s)?;
    let (prior, result) = match (prior, result) {
        (None, None) => return Ok(None),
        (Some(p), Some(r)) => (p, r),
        _ => return Err(fail("storage_corrupt")),
    };
    if prior.len() > 2 * MAX_BYTES || result.len() > 2 * MAX_BYTES {
        return Err(fail("storage_corrupt"));
    }
    shared(service::command_for_replay(&c, &s, &witness, prior))?;
    let op = identity(&c)
        .and_then(|(_, _, o)| o)
        .ok_or_else(|| fail("invalid_request"))?;
    // Generic records collection facts use camelCase, unlike enrolled scope input.
    let collection = serde_json::json!({"realmId":s.realm,"vaultId":s.vault,"owner":s.owner,"collection":s.collection});
    records::validate_stored_replay_inner(&collection.to_string(), op.as_str(), prior, result)
        .map_err(|_| fail("storage_corrupt"))?;
    Ok(Some(result.to_vec()))
}
#[wasm_bindgen(js_name=workBlockReplay)]
pub fn work_block_replay(
    raw: &str,
    b: &[u8],
    prior: Option<Vec<u8>>,
    result: Option<Vec<u8>>,
) -> std::result::Result<Option<Vec<u8>>, JsValue> {
    replay(raw, b, prior.as_deref(), result.as_deref()).map_err(js)
}
fn prepare(raw: &str, b: &[u8]) -> Result<RecordsPlan> {
    // Inspect only original identity/journal first. Accepted/restore/source/quota decoding follows replay.
    let f: serde_json::Value = decode(raw.as_bytes(), 160 * MAX_BYTES)?;
    let c = request(b)?;
    let s: Scope = serde_json::from_value(
        f.get("scope")
            .cloned()
            .ok_or_else(|| fail("invalid_request"))?,
    )
    .map_err(|_| fail("invalid_request"))?;
    let e = Enrolled {
        realm_id: s.realm.clone(),
        vault_id: s.vault.clone(),
    };
    if scope(&e, &c)? != s {
        return Err(fail("invalid_request"));
    }
    let witness = expected(&c, &s)?;
    let op = identity(&c)
        .and_then(|(_, _, o)| o)
        .ok_or_else(|| fail("invalid_request"))?;
    let local = f.get("local").ok_or_else(|| fail("invalid_request"))?;
    if local.get("operation") != Some(&serde_json::json!(op))
        || local.get("expected_revision") != Some(&serde_json::json!(witness))
    {
        return Err(fail("invalid_request"));
    }
    let prior = local.get("prior_request").filter(|v| !v.is_null());
    let result = local.get("prior_result").filter(|v| !v.is_null());
    if prior.is_some() || result.is_some() {
        // Host must return the replay result directly, never run preparation on replay.
        return Err(fail("invalid_request"));
    }
    // A remote immutable source cannot become a fresh local receipt for the same ID.
    // Preserve collision precedence over a stale witness; the generic planner still owns writes.
    let sources = f
        .get("operation_sources")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| fail("storage_corrupt"))?;
    if sources
        .iter()
        .any(|row| row.get("operation") == Some(&serde_json::json!(op)))
    {
        return Err(fail("operation_collision"));
    }
    let r = domain(domain::registration(s.realm.clone(), s.vault.clone()))?;
    if f.get("registration").and_then(|v| v.as_str())
        != Some(std::str::from_utf8(&encode(&r)?).map_err(|_| fail("workblock_failed"))?)
    {
        return Err(fail("storage_corrupt"));
    }
    let accepted = match f.get("accepted") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(v.as_str().ok_or_else(|| fail("storage_corrupt"))?),
    };
    let state = domain(admission::restore_accepted(
        &r,
        &s,
        accepted.map(str::as_bytes),
    ))?;
    let command = shared(service::command_for_new(&c, Some(&state)))?;
    records::prepare_local_inner(raw, &encode(&command)?).map_err(|s| {
        fail(match s.as_str() {
            "stale records revision" => "stale_revision",
            "records local identity collision"
            | "records operation already sourced"
            | "records Collision" => "operation_collision",
            "records Stale" => "stale_revision",
            "records Deleted"
            | "records InvalidOperation"
            | "records InvalidValue"
            | "records UnknownField" => "invalid_workblock",
            "records Limit"
            | "records local replay quota"
            | "records local request row bound"
            | "records state quota"
            | "records changes quota"
            | "records source quota"
            | "records request bound" => "limit",
            _ => "storage_corrupt",
        })
    })
}
#[wasm_bindgen(js_name=prepareWorkBlockLocal)]
pub fn prepare_work_block_local(raw: &str, b: &[u8]) -> std::result::Result<RecordsPlan, JsValue> {
    prepare(raw, b).map_err(js)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    scope: Scope,
    revision: WorkBlockRevision,
    state: String,
    projection: serde_json::Value,
    unresolved: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Unresolved {
    update_id: Id,
    status: String,
    revision: String,
}
fn snapshot(raw: &str, bytes: Option<&[u8]>, rows: &str) -> Result<Vec<u8>> {
    let s: Scope = decode(raw.as_bytes(), 4096)?;
    let fixed = domain(service::fixed_scope(
        s.realm.clone(),
        s.vault.clone(),
        s.record.clone(),
        s.generation.clone(),
    ))?;
    if s != fixed {
        return Err(fail("invalid_request"));
    }
    let r = domain(domain::registration(s.realm.clone(), s.vault.clone()))?;
    let plan =
        records::snapshot_inner(&encode(&r)?, raw, bytes).map_err(|_| fail("storage_corrupt"))?;
    let rows: Vec<Unresolved> = decode(rows.as_bytes(), 2 * MAX_BYTES)?;
    if rows.len() > 4096 {
        return Err(fail("limit"));
    }
    let mut unresolved = BTreeMap::new();
    let mut seen = std::collections::BTreeSet::new();
    for row in rows {
        Id::new(row.update_id.as_str()).map_err(|_| fail("storage_corrupt"))?;
        if !seen.insert(row.update_id)
            || row.status.is_empty()
            || row.status.len() > 128
            || row.revision.is_empty()
            || row.revision.len() > 128
        {
            return Err(fail("storage_corrupt"));
        }
        if row.status != "accepted" {
            *unresolved.entry(row.status).or_insert(0u32) += 1;
        }
    }
    let state_bytes = plan.next_state().ok_or_else(|| fail("storage_corrupt"))?;
    let projection =
        serde_json::from_slice(&plan.projection().ok_or_else(|| fail("storage_corrupt"))?)
            .map_err(|_| fail("storage_corrupt"))?;
    encode(&Snapshot {
        scope: s,
        revision: WorkBlockRevision(Sha256Digest::of(&state_bytes).0),
        state: String::from_utf8(state_bytes).map_err(|_| fail("storage_corrupt"))?,
        projection,
        unresolved: unresolved
            .into_iter()
            .map(|(k, v)| (k, v.to_string()))
            .collect(),
    })
}
#[wasm_bindgen(js_name=workBlockSnapshot)]
pub fn work_block_snapshot(
    raw: &str,
    bytes: Option<Vec<u8>>,
    rows: &str,
) -> std::result::Result<Vec<u8>, JsValue> {
    snapshot(raw, bytes.as_deref(), rows).map_err(js)
}
fn read(bytes: &[u8]) -> Result<(WorkBlockRead, State)> {
    let s: Snapshot = decode(bytes, 4 * MAX_BYTES)?;
    let canonical = snapshot(
        &serde_json::to_string(&s.scope).map_err(|_| fail("storage_corrupt"))?,
        Some(s.state.as_bytes()),
        "[]",
    )?;
    let checked: Snapshot = decode(&canonical, 4 * MAX_BYTES)?;
    if checked.revision != s.revision || checked.projection != s.projection {
        return Err(fail("storage_corrupt"));
    }
    let mut unresolved_count = 0u64;
    for (k, v) in &s.unresolved {
        let n = decimal(v).map_err(|_| fail("storage_corrupt"))?;
        unresolved_count = unresolved_count
            .checked_add(n)
            .ok_or_else(|| fail("storage_corrupt"))?;
        if k.is_empty() || k.len() > 128 || n == 0 || unresolved_count > admission::MAX_RECEIPTS {
            return Err(fail("storage_corrupt"));
        }
    }
    let state = domain(State::restore(domain::schema(), s.state.as_bytes()))?;
    let p = domain(state.projection())?;
    Ok((
        WorkBlockRead {
            record: s.scope.record,
            generation: s.scope.generation,
            revision: s.revision,
            created: p.created,
            deleted: p.deleted,
            block: domain(service::read_value(&state))?,
            unresolved: s.unresolved,
        },
        state,
    ))
}
#[wasm_bindgen(js_name=workBlockRead)]
pub fn work_block_read(bytes: &[u8]) -> std::result::Result<Vec<u8>, JsValue> {
    read(bytes).and_then(|(r, _)| encode(&r)).map_err(js)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeRow {
    sequence: String,
    status: String,
    record: Id,
    generation: Id,
    operation_id: Id,
}
#[derive(Serialize)]
struct Change {
    sequence: String,
    record_key: String,
    update_id: Id,
    status: String,
}
fn changes(raw: &str, after: &str) -> Result<Vec<u8>> {
    let mut last = decimal(after)?;
    let rows: Vec<ChangeRow> = decode(raw.as_bytes(), MAX_BYTES)?;
    if rows.len() > 64 {
        return Err(fail("limit"));
    }
    let mut changes = Vec::new();
    for r in rows {
        let n = decimal(&r.sequence).map_err(|_| fail("storage_corrupt"))?;
        if n <= last || r.status.is_empty() || r.status.len() > 128 {
            return Err(fail("storage_corrupt"));
        }
        for id in [&r.record, &r.generation, &r.operation_id] {
            Id::new(id.as_str()).map_err(|_| fail("storage_corrupt"))?;
        }
        last = n;
        changes.push(Change {
            sequence: r.sequence,
            record_key: serde_json::to_string(&(r.record, r.generation))
                .map_err(|_| fail("workblock_failed"))?,
            update_id: r.operation_id,
            status: r.status,
        });
    }
    encode(&serde_json::json!({"changes":changes,"next":last.to_string()}))
}
#[wasm_bindgen(js_name=workBlockChanges)]
pub fn work_block_changes(raw: &str, after: &str) -> std::result::Result<Vec<u8>, JsValue> {
    changes(raw, after).map_err(js)
}
#[derive(Clone)]
struct Cursor {
    query: WindowQuery,
    after: String,
    watermark: String,
}
#[derive(Default)]
struct Session {
    closed: bool,
    cursors: BTreeMap<String, Cursor>,
    order: VecDeque<String>,
}
#[wasm_bindgen]
pub struct WorkBlockWindowSession {
    inner: Rc<RefCell<Session>>,
}
#[wasm_bindgen]
pub struct WorkBlockWindowScan {
    session: Rc<RefCell<Session>>,
    query: WindowQuery,
    after: Option<String>,
    watermark: String,
    blocks: Vec<WorkBlockRead>,
    scanned: u32,
    bytes: u32,
    finished: bool,
    byte_full: bool,
}
fn key(raw: &str) -> Result<(Id, Id)> {
    let pair: (Id, Id) = decode(raw.as_bytes(), 2048)?;
    for id in [&pair.0, &pair.1] {
        Id::new(id.as_str()).map_err(|_| fail("invalid_request"))?;
    }
    if serde_json::to_string(&pair).map_err(|_| fail("invalid_request"))? != raw {
        return Err(fail("invalid_request"));
    }
    Ok(pair)
}
/// Private IDB position codec. These bytes never become a public cursor.
#[wasm_bindgen(js_name = workBlockStorageKey)]
pub fn work_block_storage_key(raw: &str) -> std::result::Result<String, JsValue> {
    key(raw).map(|_| raw.to_owned()).map_err(js)
}
impl WorkBlockWindowSession {
    fn start(&self, raw: &str, watermark: &str) -> Result<WorkBlockWindowScan> {
        decimal(watermark)?;
        let c = request(raw.as_bytes())?;
        let Command::Window {
            from_ms,
            until_ms,
            limit,
            byte_limit,
            cursor,
        } = c
        else {
            return Err(fail("invalid_request"));
        };
        let query = WindowQuery {
            from: from_ms,
            until: until_ms,
            limit,
            bytes: byte_limit,
        };
        shared(service::validate_window(&query))?;
        let session = self.inner.borrow();
        if session.closed {
            return Err(fail("stale_session"));
        }
        let after = if let Some(token) = cursor {
            let prior = session
                .cursors
                .get(&token)
                .ok_or_else(|| fail("cursor_expired"))?;
            if prior.query != query {
                return Err(fail("invalid_request"));
            }
            if prior.watermark != watermark {
                return Err(fail("window_changed"));
            }
            Some(prior.after.clone())
        } else {
            None
        };
        Ok(WorkBlockWindowScan {
            session: self.inner.clone(),
            query,
            after,
            watermark: watermark.into(),
            blocks: vec![],
            scanned: 0,
            bytes: 0,
            finished: false,
            byte_full: false,
        })
    }
}
#[wasm_bindgen]
impl WorkBlockWindowSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Rc::new(RefCell::new(Session::default())),
        }
    }
    pub fn begin(
        &self,
        raw: &str,
        watermark: &str,
    ) -> std::result::Result<WorkBlockWindowScan, JsValue> {
        self.start(raw, watermark).map_err(js)
    }
    pub fn close(&self) {
        let mut s = self.inner.borrow_mut();
        s.closed = true;
        s.cursors.clear();
        s.order.clear();
    }
}
impl WorkBlockWindowScan {
    fn active(&self) -> Result<()> {
        if self.finished || self.session.borrow().closed {
            return Err(fail("stale_session"));
        }
        Ok(())
    }
    fn accept(&mut self, snapshot: &[u8], next: &str) -> Result<bool> {
        self.active()?;
        if self.byte_full || self.scanned >= self.query.limit {
            return Ok(false);
        }
        let pair = key(next)?;
        if self
            .after
            .as_deref()
            .map(key)
            .transpose()?
            .is_some_and(|old| old >= pair)
        {
            return Err(fail("invalid_request"));
        }
        if snapshot.len() > self.query.bytes.saturating_sub(self.bytes) as usize {
            if self.scanned == 0 {
                return Err(fail("limit"));
            }
            self.byte_full = true;
            return Ok(false);
        }
        let (view, state) = read(snapshot)?;
        if (view.record.clone(), view.generation.clone()) != pair {
            return Err(fail("storage_corrupt"));
        }
        let window = shared(service::validate_window(&self.query))?;
        if let Some(block) = domain(domain::read(&state))? {
            if domain(window.intersects(&block))? {
                self.blocks.push(view);
            }
        }
        self.bytes += snapshot.len() as u32;
        self.scanned += 1;
        self.after = Some(next.into());
        Ok(true)
    }
    fn complete(&mut self, eof: bool, opaque: &str) -> Result<Vec<u8>> {
        self.active()?;
        // The host must perform its fresh authoritative post-fence BEFORE calling finish.
        if eof && self.byte_full {
            return Err(fail("invalid_request"));
        }
        let mut session = self.session.borrow_mut();
        let cursor = if eof {
            None
        } else {
            if self.scanned == 0 {
                return Err(fail("invalid_request"));
            }
            let after = self.after.clone().ok_or_else(|| fail("invalid_request"))?;
            let existing = session
                .cursors
                .iter()
                .find(|(_, c)| {
                    c.query == self.query && c.after == after && c.watermark == self.watermark
                })
                .map(|(t, _)| t.clone());
            Some(if let Some(t) = existing {
                t
            } else {
                if opaque.is_empty()
                    || opaque.len() > 128
                    || !opaque
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || session.cursors.contains_key(opaque)
                {
                    return Err(fail("invalid_request"));
                }
                if session.cursors.len() == 8 {
                    if let Some(old) = session.order.pop_front() {
                        session.cursors.remove(&old);
                    }
                }
                session.order.push_back(opaque.into());
                session.cursors.insert(
                    opaque.into(),
                    Cursor {
                        query: self.query.clone(),
                        after,
                        watermark: self.watermark.clone(),
                    },
                );
                opaque.into()
            })
        };
        let page = service::WorkBlockWindowPage {
            blocks: self.blocks.clone(),
            incomplete: cursor.is_some(),
            cursor,
            watermark: self.watermark.clone(),
            scanned: self.scanned,
            bytes: self.bytes,
        };
        let bytes = encode(&page)?;
        self.finished = true;
        Ok(bytes)
    }
}
#[wasm_bindgen]
impl WorkBlockWindowScan {
    #[wasm_bindgen(js_name=afterKeyJson)]
    pub fn after_key_json(&self) -> Option<String> {
        self.after.clone()
    }
    pub fn watermark(&self) -> String {
        self.watermark.clone()
    }
    pub fn offer(&mut self, snapshot: &[u8], next: &str) -> std::result::Result<bool, JsValue> {
        self.accept(snapshot, next).map_err(js)
    }
    pub fn finish(&mut self, eof: bool, opaque: &str) -> std::result::Result<Vec<u8>, JsValue> {
        self.complete(eof, opaque).map_err(js)
    }
}
#[cfg(test)]
#[path = "workblocks_tests.rs"]
mod tests;
