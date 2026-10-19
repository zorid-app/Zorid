//! Private worker binding for the portable draft executor. Controls contain no
//! completion, parser phase, work budget, source body or encoded facts payload.
//! JS conversion/output allocations remain the browser bridge's responsibility.
use crate::document_runtime::{self as binding, State, WasmDocumentRuntimeOwner};
use js_sys::Uint8Array;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    io::{self, Read, Write},
    rc::Rc,
};
use wasm_bindgen::prelude::*;
use zorid_core::OperationId;
use zorid_index::{
    document_draft_executor as x, document_runtime as c, document_work_runtime as w,
    draft_runtime as d,
};

type Result<T> = std::result::Result<T, &'static str>;
const CONTROL_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DraftScope {
    client: OperationId,
    lifetime: OperationId,
    incarnation: OperationId,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
struct Counter(u64);
impl TryFrom<String> for Counter {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self> {
        binding::decimal(&value)
            .map(Self)
            .map_err(|_| "draft_invalid_request")
    }
}
impl From<Counter> for String {
    fn from(value: Counter) -> Self {
        value.0.to_string()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    lifetime: OperationId,
    id: Counter,
    buffer_lifetime: OperationId,
    text_revision: Counter,
}
impl Job {
    fn resolve(&self, client: &OperationId) -> Result<d::JobToken> {
        if self.id.0 == 0 {
            return Err("draft_invalid_request");
        }
        Ok(d::JobToken {
            lifetime: self.lifetime.clone(),
            id: self.id.0,
            tag: d::DraftTag {
                buffer: d::BufferKey {
                    client: client.clone(),
                    buffer_lifetime: self.buffer_lifetime.clone(),
                },
                text_revision: self.text_revision.0,
            },
        })
    }
}
fn job(value: &d::JobToken) -> Job {
    Job {
        lifetime: value.lifetime.clone(),
        id: Counter(value.id),
        buffer_lifetime: value.tag.buffer.buffer_lifetime.clone(),
        text_revision: Counter(value.tag.text_revision),
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    bytes: usize,
    utf16: usize,
    sha256: String,
}
impl Source {
    fn checked(&self) -> Result<d::SourceDescriptor> {
        if self.bytes > d::MAX_DRAFT_SOURCE_BYTES
            || self.utf16 > self.bytes
            || (self.bytes == 0) != (self.utf16 == 0)
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("draft_invalid_source");
        }
        let mut sha256 = [0; 32];
        for (i, pair) in self.sha256.as_bytes().chunks_exact(2).enumerate() {
            let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
            sha256[i] = digit(pair[0]) * 16 + digit(pair[1]);
        }
        Ok(d::SourceDescriptor {
            bytes: self.bytes,
            utf16: self.utf16,
            sha256,
        })
    }
}
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Request {
        buffer_lifetime: OperationId,
        text_revision: Counter,
        source: Source,
    },
    UploadBegin {
        job: Job,
    },
    UploadChunk {
        job: Job,
        offset: Counter,
    },
    UploadSeal {
        job: Job,
    },
    Progress {
        job: Job,
    },
    FactsPrepare {
        job: Job,
    },
    FactsRead {
        job: Job,
        offset: Counter,
        maximum: usize,
    },
    Cancel {
        job: Job,
    },
    Acknowledge {
        job: Job,
    },
    ReleaseBuffer {
        buffer_lifetime: OperationId,
    },
    Snapshot,
}
fn request(raw: &str) -> Result<Request> {
    if raw.len() > CONTROL_BYTES {
        return Err("draft_control_limit");
    }
    serde_json::from_str(raw).map_err(|_| "draft_invalid_request")
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Lane {
    Committed,
    Draft,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {
    incarnation: OperationId,
    lane: Lane,
    lifetime: OperationId,
    id: Counter,
}
fn ticket(value: &w::Ticket) -> Ticket {
    let (lane, lifetime, id) = match &value.effect {
        w::ChildEffect::Committed(v) => (Lane::Committed, v.lifetime.clone(), v.id),
        w::ChildEffect::Draft(v) => (Lane::Draft, v.lifetime.clone(), v.id),
    };
    Ticket {
        incarnation: value.incarnation.clone(),
        lane,
        lifetime,
        id: Counter(id),
    }
}
fn resolve_ticket(state: &State, raw: &str) -> Result<w::Ticket> {
    if raw.len() > CONTROL_BYTES {
        return Err("draft_control_limit");
    }
    let wanted: Ticket = serde_json::from_str(raw).map_err(|_| "draft_invalid_request")?;
    if wanted.id.0 == 0 {
        return Err("draft_invalid_request");
    }
    let snapshot = state
        .drafts
        .as_ref()
        .ok_or("draft_expired")?
        .work_snapshot();
    [snapshot.selected, snapshot.last_settled]
        .into_iter()
        .flatten()
        .find(|actual| ticket(actual) == wanted)
        .ok_or("draft_expired")
}
pub(crate) fn draft_error(error: x::DraftExecutorError) -> &'static str {
    use x::{DraftExecutorError as E, DraftTransferError as T};
    match error {
        E::Draft(d::RuntimeError::Capacity) => "draft_capacity",
        E::Draft(d::RuntimeError::Conflict) => "draft_conflict",
        E::Draft(d::RuntimeError::StaleRevision) => "draft_stale_revision",
        E::Draft(d::RuntimeError::ForeignOwner) => "draft_owner_mismatch",
        E::Draft(d::RuntimeError::InvalidSource | d::RuntimeError::SourceMismatch)
        | E::SourceMismatch => "draft_invalid_source",
        E::Draft(d::RuntimeError::InvalidAcknowledgement) => "draft_invalid_ack",
        E::Draft(d::RuntimeError::CounterExhausted) => "draft_counter_exhausted",
        E::Draft(d::RuntimeError::Retired) | E::Closed => "draft_closed",
        E::Draft(d::RuntimeError::Expired) | E::Expired => "draft_expired",
        E::NotReady => "draft_not_ready",
        E::Transfer(T::Resource) => "draft_resource",
        E::Transfer(T::InvalidOffset) => "draft_invalid_offset",
        E::Transfer(T::InvalidChunk) => "draft_invalid_chunk",
        E::Transfer(T::Incomplete) => "draft_incomplete",
        E::Transfer(T::Encoding(_)) => "draft_encoding",
        E::Transfer(T::Read(_) | T::Write(_)) => "draft_io",
        E::Work(_) => "document_runtime_unavailable",
        _ => "draft_contract",
    }
}
fn encoded(value: Value) -> Result<String> {
    let raw = value.to_string();
    if raw.len() > CONTROL_BYTES {
        Err("draft_control_limit")
    } else {
        Ok(raw)
    }
}
fn reduction(value: &d::Reduction, client: &OperationId) -> Value {
    let execution = match value.execution {
        d::Execution::Dispatch => "dispatch",
        d::Execution::WaitForInput => "wait_for_input",
        d::Execution::WaitForAcknowledgement => "wait_for_acknowledgement",
        d::Execution::Idle => "idle",
        d::Execution::Quiesced => "quiesced",
    };
    let outcomes = value
        .outcomes
        .iter()
        .filter(|o| &o.job.tag.buffer.client == client)
        .map(|o| {
            let kind = match o.kind {
                d::OutcomeKind::Ready => "ready",
                d::OutcomeKind::Superseded => "superseded",
                d::OutcomeKind::Cancelled => "cancelled",
                d::OutcomeKind::Retired => "retired",
                d::OutcomeKind::Unavailable(_) => "unavailable",
            };
            let reason = match o.kind {
                d::OutcomeKind::Unavailable(d::UnavailableCode::Resource) => Some("resource"),
                d::OutcomeKind::Unavailable(d::UnavailableCode::CounterExhausted) => {
                    Some("counter_exhausted")
                }
                _ => None,
            };
            json!({"job":job(&o.job),"kind":kind,"reason":reason})
        })
        .collect::<Vec<_>>();
    json!({"admitted":value.admitted.as_ref().filter(|j| &j.tag.buffer.client == client).map(job),"replay":value.replay,
        "execution":execution,"outcomes":outcomes,"usage":{"source_bytes":value.usage.source_bytes,
        "scratch_bytes":value.usage.scratch_bytes,"facts_bytes":value.usage.facts_bytes}})
}
fn progress(value: &x::DraftTransferProgress) -> Value {
    json!({"source_bytes_received":value.source_bytes_received,"source_bytes_expected":value.source_bytes_expected,
        "source_sealed":value.source_sealed,"facts_bytes":value.facts_bytes,"scratch_bytes":value.scratch_bytes})
}
fn reply(
    state: &State,
    actual: Option<&d::Reduction>,
    transfer: Option<&x::DraftTransferProgress>,
) -> Result<String> {
    let client = &state
        .draft_scope
        .as_ref()
        .ok_or("draft_owner_mismatch")?
        .client;
    let snapshot = state
        .drafts
        .as_ref()
        .map(x::DocumentDraftExecutor::snapshot);
    let own = actual
        .or_else(|| snapshot.as_ref().map(|s| &s.runtime))
        .map(|r| reduction(r, client));
    encoded(
        json!({"state":own,"transfer":transfer.map(progress),"transfer_scratch_bytes":snapshot.map_or(0,|s|s.transfer_scratch_bytes)}),
    )
}
fn work(state: &State) -> Value {
    state.drafts.as_ref().map(|owner| { let snapshot = owner.work_snapshot();
        json!({"selected":snapshot.selected.as_ref().map(ticket),"last_settled":snapshot.last_settled.as_ref().map(ticket),
            "closing":snapshot.closing,"close_ready":owner.close_ready(&state.core,state.execution)})
    }).unwrap_or(Value::Null)
}
fn report(raw: &c::Reduction) -> Result<Value> {
    serde_json::from_str(&binding::reduction(raw)?).map_err(|_| "draft_contract")
}
fn live(owner: &WasmDocumentRuntimeOwner) -> Result<()> {
    if owner.live.get() {
        Ok(())
    } else {
        Err("document_runtime_expired")
    }
}
fn configure(state: &mut State, client: &str, lifetime: &str, incarnation: &str) -> Result<()> {
    if state.core.update().phase == c::Phase::Releasing {
        return Err("draft_closed");
    }
    let parse = |v: &str| OperationId::new(v).map_err(|_| "draft_invalid_request");
    let scope = DraftScope {
        client: parse(client)?,
        lifetime: parse(lifetime)?,
        incarnation: parse(incarnation)?,
    };
    match &state.draft_scope {
        Some(old) if old != &scope => Err("draft_owner_mismatch"),
        Some(_) => Ok(()),
        None => {
            state.draft_scope = Some(scope);
            Ok(())
        }
    }
}
fn command(state: &mut State, request: Request) -> Result<String> {
    let scope = state
        .draft_scope
        .as_ref()
        .ok_or("draft_owner_mismatch")?
        .clone();
    // Validate controls/source before creating the one lazy owner.
    let input = match request {
        Request::Request {
            buffer_lifetime,
            text_revision,
            source,
        } => Some(x::DraftCommand::Request(d::DraftRequest {
            tag: d::DraftTag {
                buffer: d::BufferKey {
                    client: scope.client.clone(),
                    buffer_lifetime,
                },
                text_revision: text_revision.0,
            },
            source: source.checked()?,
        })),
        Request::Cancel { job } => Some(x::DraftCommand::Cancel {
            client: scope.client.clone(),
            job: job.resolve(&scope.client)?,
        }),
        Request::Acknowledge { job } => Some(x::DraftCommand::Acknowledge {
            client: scope.client.clone(),
            job: job.resolve(&scope.client)?,
        }),
        Request::ReleaseBuffer { buffer_lifetime } => {
            Some(x::DraftCommand::ReleaseBuffer(d::BufferKey {
                client: scope.client.clone(),
                buffer_lifetime,
            }))
        }
        Request::Snapshot => return reply(state, None, None),
        Request::UploadChunk { .. } | Request::FactsRead { .. } => {
            return Err("draft_invalid_request")
        }
        Request::UploadBegin { job } => {
            let exact = job.resolve(&scope.client)?;
            let transfer = state
                .drafts
                .as_mut()
                .ok_or("draft_expired")?
                .begin_source_upload(&exact)
                .map_err(draft_error)?;
            return reply(state, None, Some(&transfer));
        }
        Request::UploadSeal { job } => {
            let exact = job.resolve(&scope.client)?;
            let owner = state.drafts.as_mut().ok_or("draft_expired")?;
            let actual = if owner.facts(&exact).is_ok() {
                None
            } else {
                Some(owner.seal_source_upload(&exact).map_err(draft_error)?)
            };
            return reply(state, actual.as_ref(), None);
        }
        Request::Progress { job } => {
            let exact = job.resolve(&scope.client)?;
            let transfer = state
                .drafts
                .as_ref()
                .ok_or("draft_expired")?
                .transfer_progress(&exact)
                .map_err(draft_error)?;
            return reply(state, None, Some(&transfer));
        }
        Request::FactsPrepare { job } => {
            let exact = job.resolve(&scope.client)?;
            let transfer = state
                .drafts
                .as_mut()
                .ok_or("draft_expired")?
                .prepare_facts_bytes(&exact)
                .map_err(draft_error)?;
            return reply(state, None, Some(&transfer));
        }
    };
    let input = input.unwrap();
    if state.drafts.is_none() {
        if !matches!(&input, x::DraftCommand::Request(_)) {
            return Err("draft_expired");
        }
        if state.core.update().phase == c::Phase::Releasing {
            return Err("draft_closed");
        }
        state.drafts = Some(x::DocumentDraftExecutor::new(
            scope.lifetime,
            scope.incarnation,
        ));
    }
    let result = state
        .drafts
        .as_mut()
        .unwrap()
        .command(input)
        .map_err(draft_error)?;
    reply(state, Some(&result), None)
}
fn upload(state: &mut State, raw: &str, length: usize, reader: &mut impl Read) -> Result<String> {
    let Request::UploadChunk { job, offset } = request(raw)? else {
        return Err("draft_invalid_request");
    };
    let client = &state
        .draft_scope
        .as_ref()
        .ok_or("draft_owner_mismatch")?
        .client;
    let exact = job.resolve(client)?;
    let offset = usize::try_from(offset.0).map_err(|_| "draft_invalid_offset")?;
    let transfer = state
        .drafts
        .as_mut()
        .ok_or("draft_expired")?
        .read_source_upload_chunk(&exact, offset, length, reader)
        .map_err(draft_error)?;
    reply(state, None, Some(&transfer))
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct ReadPlan {
    job: Job,
    offset: Counter,
    bytes: usize,
    total_bytes: usize,
    eof: bool,
}
fn read_plan(state: &State, raw: &str) -> Result<(d::JobToken, ReadPlan, usize)> {
    let Request::FactsRead {
        job,
        offset,
        maximum,
    } = request(raw)?
    else {
        return Err("draft_invalid_request");
    };
    if maximum == 0 || maximum > x::MAX_DRAFT_TRANSFER_CHUNK_BYTES {
        return Err("draft_invalid_chunk");
    }
    let client = &state
        .draft_scope
        .as_ref()
        .ok_or("draft_owner_mismatch")?
        .client;
    let exact = job.resolve(client)?;
    let owner = state.drafts.as_ref().ok_or("draft_expired")?;
    owner.facts(&exact).map_err(draft_error)?;
    let total = owner
        .transfer_progress(&exact)
        .map_err(draft_error)?
        .facts_bytes
        .ok_or("draft_incomplete")?;
    let at = usize::try_from(offset.0).map_err(|_| "draft_invalid_offset")?;
    if at > total {
        return Err("draft_invalid_offset");
    }
    let bytes = maximum.min(total - at);
    Ok((
        exact,
        ReadPlan {
            job,
            offset,
            bytes,
            total_bytes: total,
            eof: at + bytes == total,
        },
        maximum,
    ))
}
fn read_into(state: &State, raw: &str, length: usize, writer: &mut impl Write) -> Result<String> {
    let (exact, plan, maximum) = read_plan(state, raw)?;
    if length != plan.bytes {
        return Err("draft_invalid_chunk");
    }
    let count = state
        .drafts
        .as_ref()
        .unwrap()
        .write_facts_bytes(&exact, plan.offset.0 as usize, maximum, writer)
        .map_err(draft_error)?;
    if count != plan.bytes {
        return Err("draft_contract");
    }
    encoded(serde_json::to_value(plan).map_err(|_| "draft_encoding")?)
}
// The JS object reaches Rust without wasm-bindgen's &[u8] payload allocation.
// The portable owner allocates/reconciles ingress before it invokes Read.
struct JsIngress<'a> {
    input: &'a Uint8Array,
    consumed: bool,
}
impl Read for JsIngress<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.consumed {
            return Ok(0);
        }
        if output.len() != self.input.length() as usize {
            return Err(io::Error::other("draft ingress changed length"));
        }
        self.input.copy_to(output);
        self.consumed = true;
        Ok(output.len())
    }
}
// write_facts_bytes supplies its borrowed complete bounded slice to Write once.
// This copies directly into the bridge's existing exact-length JS allocation.
struct JsOutput<'a> {
    output: &'a Uint8Array,
    written: bool,
}
impl Write for JsOutput<'_> {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        if self.written || input.len() != self.output.length() as usize {
            return Err(io::Error::other("draft output changed length"));
        }
        self.output.copy_from(input);
        self.written = true;
        Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn next_turn(state: &mut State) -> Result<String> {
    let Some(owner) = state.drafts.as_mut() else {
        return encoded(json!({"work":null,"turn":null,"continued":null}));
    };
    let turn = owner
        .next_turn(&mut state.core, &mut state.execution)
        .map_err(draft_error)?;
    let continued = turn.continued.as_ref().map(report).transpose()?;
    let selected = match turn.state {
        w::WorkState::Ready => "ready",
        w::WorkState::Waiting => "waiting",
        w::WorkState::Quiesced => "quiesced",
    };
    encoded(json!({"work":work(state),"turn":{"state":selected},"continued":continued}))
}
fn begin_close(state: &mut State, release_client: bool) -> Result<String> {
    let mut committed = None;
    if let Some(owner) = state.drafts.as_mut() {
        if release_client {
            let client = state
                .draft_scope
                .as_ref()
                .ok_or("draft_owner_mismatch")?
                .client
                .clone();
            owner
                .command(x::DraftCommand::ReleaseClient(client))
                .map_err(draft_error)?;
        }
        // Repeated release/close observes the retained drain rather than
        // clearing the last-settled replay every time a host polls for disposal.
        if !owner.work_snapshot().closing {
            let close = owner
                .begin_close(&mut state.core, &mut state.execution)
                .map_err(draft_error)?;
            state.replay = None;
            committed = Some(report(&close.committed)?);
        }
    }
    let client_has_jobs = state.draft_scope.as_ref().is_some_and(|scope| {
        state
            .drafts
            .as_ref()
            .is_some_and(|owner| owner.client_has_jobs(&scope.client))
    });
    encoded(
        json!({"work":work(state),"turn":null,"committed":committed,"client_has_jobs":client_has_jobs}),
    )
}
fn step_draft(state: &mut State, raw: &str) -> Result<String> {
    let exact = resolve_ticket(state, raw)?;
    if !matches!(exact.effect, w::ChildEffect::Draft(_)) {
        return Err("draft_expired");
    }
    state
        .drafts
        .as_mut()
        .unwrap()
        .step_draft(&exact, &mut state.core, &mut state.execution)
        .map_err(draft_error)?;
    encoded(json!({"work":work(state),"turn":null}))
}
#[wasm_bindgen]
impl WasmDocumentRuntimeOwner {
    /// Trusted worker setup fixes one client scope; no parser/executor exists
    /// until the first validated Request. Reconfiguration never changes owner.
    #[wasm_bindgen(js_name=configureDrafts)]
    pub fn configure_drafts(
        &self,
        client: &str,
        lifetime: &str,
        incarnation: &str,
    ) -> std::result::Result<(), JsValue> {
        let action = || -> Result<()> {
            live(self)?;
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| "document_runtime_busy")?;
            configure(&mut state, client, lifetime, incarnation)
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=draftCommandJson)]
    pub fn draft_command_json(&self, raw: &str) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            let request = request(raw)?;
            live(self)?;
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| "document_runtime_busy")?;
            command(&mut state, request)
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=draftUploadChunkJson)]
    pub fn draft_upload_chunk_json(
        &self,
        raw: &str,
        input: &Uint8Array,
    ) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| "document_runtime_busy")?;
            let length = input.length() as usize;
            upload(
                &mut state,
                raw,
                length,
                &mut JsIngress {
                    input,
                    consumed: false,
                },
            )
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=draftReadPlanJson)]
    pub fn draft_read_plan_json(&self, raw: &str) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let state = self
                .state
                .try_borrow()
                .map_err(|_| "document_runtime_busy")?;
            let (_, plan, _) = read_plan(&state, raw)?;
            encoded(serde_json::to_value(plan).map_err(|_| "draft_encoding")?)
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=draftReadIntoJson)]
    pub fn draft_read_into_json(
        &self,
        raw: &str,
        output: &Uint8Array,
    ) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let state = self
                .state
                .try_borrow()
                .map_err(|_| "document_runtime_busy")?;
            read_into(
                &state,
                raw,
                output.length() as usize,
                &mut JsOutput {
                    output,
                    written: false,
                },
            )
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=workNextTurnJson)]
    pub fn work_next_turn_json(&self) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| "document_runtime_busy")?;
            next_turn(&mut state)
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=workSnapshotJson)]
    pub fn work_snapshot_json(&self) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let state = self
                .state
                .try_borrow()
                .map_err(|_| "document_runtime_busy")?;
            encoded(json!({"work":work(&state),"turn":null,"continued":null}))
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=workIssued)]
    pub fn work_issued(&self, raw: &str) -> std::result::Result<WasmDocumentWorkIssued, JsValue> {
        self.issue_work(raw).map_err(binding::error)
    }
    #[wasm_bindgen(js_name=workStepDraftJson)]
    pub fn work_step_draft_json(&self, raw: &str) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| "document_runtime_busy")?;
            step_draft(&mut state, raw)
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=workBeginCloseJson)]
    pub fn work_begin_close_json(&self) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| "document_runtime_busy")?;
            begin_close(&mut state, false)
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=draftReleaseClientJson)]
    pub fn draft_release_client_json(&self) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            live(self)?;
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| "document_runtime_busy")?;
            if state.draft_scope.is_none() {
                return Err("draft_owner_mismatch");
            }
            begin_close(&mut state, true)
        };
        action().map_err(binding::error)
    }
}
impl WasmDocumentRuntimeOwner {
    fn issue_work(&self, raw: &str) -> Result<WasmDocumentWorkIssued> {
        live(self)?;
        let state = self
            .state
            .try_borrow()
            .map_err(|_| "document_runtime_busy")?;
        let exact = resolve_ticket(&state, raw)?;
        if !matches!(exact.effect, w::ChildEffect::Committed(_)) {
            return Err("draft_expired");
        }
        state
            .drafts
            .as_ref()
            .unwrap()
            .admit(&exact, &state.core)
            .map_err(draft_error)?;
        Ok(WasmDocumentWorkIssued {
            state: self.state.clone(),
            live: self.live.clone(),
            ticket: exact,
            consumed: false,
        })
    }
}
/// Actual selector ticket plus its shared owner, never caller-composed work.
#[wasm_bindgen]
pub struct WasmDocumentWorkIssued {
    state: Rc<RefCell<State>>,
    live: Rc<Cell<bool>>,
    ticket: w::Ticket,
    consumed: bool,
}
impl WasmDocumentWorkIssued {
    fn admission(&self, state: &State) -> Result<w::Admission> {
        if self.consumed || !self.live.get() {
            return Err("document_runtime_expired");
        }
        state
            .drafts
            .as_ref()
            .ok_or("draft_expired")?
            .admit(&self.ticket, &state.core)
            .map_err(draft_error)
    }
    fn replay(&self, state: &State) -> Result<Option<String>> {
        match self.admission(state)? {
            w::Admission::Execute => Ok(None),
            w::Admission::Replay(w::Lane::Committed) => {
                let w::ChildEffect::Committed(effect) = &self.ticket.effect else {
                    return Err("draft_expired");
                };
                state
                    .replay
                    .as_ref()
                    .filter(|r| r.lifetime == effect.lifetime && r.id == effect.id)
                    .map(|r| Some(r.report.clone()))
                    .ok_or("document_runtime_expired")
            }
            _ => Err("draft_expired"),
        }
    }
    fn complete(&mut self, raw: &str) -> Result<String> {
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| "document_runtime_busy")?;
        if let Some(report) = self.replay(&state)? {
            self.consumed = true;
            return Ok(report);
        }
        let completion = binding::decode_completion(raw)?;
        let State {
            core,
            execution,
            drafts,
            ..
        } = &mut *state;
        let reduced = drafts
            .as_mut()
            .unwrap()
            .settle_committed(&self.ticket, completion, core, execution)
            .map_err(draft_error)?;
        self.consumed = true;
        let report = binding::reduction(&reduced)?;
        let w::ChildEffect::Committed(effect) = &self.ticket.effect else {
            return Err("draft_expired");
        };
        state.replay = if reduced.execution != c::Execution::Quiesced {
            Some(binding::Replay {
                lifetime: effect.lifetime.clone(),
                id: effect.id,
                report: report.clone(),
            })
        } else {
            None
        };
        Ok(report)
    }
}
#[wasm_bindgen]
impl WasmDocumentWorkIssued {
    /// Identical committed effect descriptor to legacy issued.descriptorJson().
    #[wasm_bindgen(js_name=descriptorJson)]
    pub fn descriptor_json(&self) -> std::result::Result<String, JsValue> {
        let action = || -> Result<String> {
            let state = self
                .state
                .try_borrow()
                .map_err(|_| "document_runtime_busy")?;
            self.admission(&state)?;
            let w::ChildEffect::Committed(effect) = &self.ticket.effect else {
                return Err("draft_expired");
            };
            binding::encode(binding::effect(effect))
        };
        action().map_err(binding::error)
    }
    /// Check before actual IO; replay never runs another IDB operation.
    #[wasm_bindgen(js_name=replayJson)]
    pub fn replay_json(&self) -> std::result::Result<Option<String>, JsValue> {
        let action = || -> Result<Option<String>> {
            let state = self
                .state
                .try_borrow()
                .map_err(|_| "document_runtime_busy")?;
            self.replay(&state)
        };
        action().map_err(binding::error)
    }
    #[wasm_bindgen(js_name=completeJson)]
    pub fn complete_json(&mut self, raw: &str) -> std::result::Result<String, JsValue> {
        self.complete(raw).map_err(binding::error)
    }
}

#[cfg(test)]
#[path = "document_drafts_tests.rs"]
mod tests;
