//! Internal admitted-host binding for committed index maintenance. Public control
//! messages cannot inject completions. Issued handles never leave the Worker.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use wasm_bindgen::prelude::*;
use zorid_core::OperationId;
use zorid_index::document_runtime as core;
use zorid_index::{
    document_extraction_version, IndexSnapshotId, SemanticVersions, SourceSnapshotId,
    INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION, RESOLVER_VERSION,
};

const CONTROL_BYTES: usize = 64 * 1024;
const INTERNAL_BYTES: usize = CONTROL_BYTES;
pub(crate) type Result<T> = std::result::Result<T, &'static str>;
pub(crate) fn error(code: &str) -> JsValue {
    JsValue::from_str(&json!({"code":code}).to_string())
}
fn contract(error: core::RuntimeError) -> &'static str {
    match error {
        core::RuntimeError::InvalidRequest => "invalid_request",
        core::RuntimeError::Capacity => "document_runtime_capacity",
        core::RuntimeError::Retired => "document_runtime_retired",
        core::RuntimeError::UnexpectedCompletion => "document_runtime_expired",
    }
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(raw: &str, limit: usize) -> Result<T> {
    if raw.len() > limit {
        return Err("document_runtime_capacity");
    }
    serde_json::from_str(raw).map_err(|_| "invalid_request")
}
pub(crate) fn decimal(raw: &str) -> Result<u64> {
    if raw.is_empty()
        || raw.len() > 20
        || (raw.len() > 1 && raw.starts_with('0'))
        || !raw.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("invalid_request");
    }
    raw.parse().map_err(|_| "invalid_request")
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    Wake {
        monotonic_ms: String,
    },
    Continue {},
    SourceHint {},
    Request {
        id: String,
        max_pumps: u8,
        max_restarts: u8,
        force_rebuild: bool,
    },
    CancelRequest {
        id: String,
    },
    Retire {},
}
impl Command {
    fn input(self) -> Result<core::Input> {
        Ok(match self {
            Self::Wake { monotonic_ms } => core::Input::Wake {
                monotonic_ms: decimal(&monotonic_ms)?,
            },
            Self::Continue {} => core::Input::Continue,
            Self::SourceHint {} => core::Input::SourceHint,
            Self::Request {
                id,
                max_pumps,
                max_restarts,
                force_rebuild,
            } => core::Input::Request(core::FreshnessRequest {
                id: decimal(&id)?,
                max_pumps,
                max_restarts,
                force_rebuild,
            }),
            Self::CancelRequest { id } => core::Input::CancelRequest { id: decimal(&id)? },
            Self::Retire {} => core::Input::Retire,
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    source: SourceSnapshotId,
    published: Option<IndexSnapshotId>,
    current: bool,
    rebuild_required: bool,
    coverage_complete: Option<bool>,
}
impl From<Observation> for core::Observation {
    fn from(v: Observation) -> Self {
        Self {
            source: v.source,
            published: v.published,
            current: v.current,
            rebuild_required: v.rebuild_required,
            coverage_complete: v.coverage_complete,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Progress {
    prepared: u32,
    total: u32,
    ready: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage {
    source: SourceSnapshotId,
    snapshot: IndexSnapshotId,
    progress: Option<Progress>,
}
impl From<Stage> for core::StageObservation {
    fn from(v: Stage) -> Self {
        Self {
            source: v.source,
            snapshot: v.snapshot,
            progress: v.progress.map(|p| core::StageProgress {
                prepared: p.prepared,
                total: p.total,
                ready: p.ready,
            }),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Failure {
    StaleSource,
    StaleIndex,
    SnapshotExpired,
    RebuildRequired,
    Uncertain,
    Unavailable,
    InvalidData,
    Fatal,
}
impl From<Failure> for core::Failure {
    fn from(v: Failure) -> Self {
        match v {
            Failure::StaleSource => Self::StaleSource,
            Failure::StaleIndex => Self::StaleIndex,
            Failure::SnapshotExpired => Self::SnapshotExpired,
            Failure::RebuildRequired => Self::RebuildRequired,
            Failure::Uncertain => Self::Uncertain,
            Failure::Unavailable => Self::Unavailable,
            Failure::InvalidData => Self::InvalidData,
            Failure::Fatal => Self::Fatal,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Completion {
    Observed { observation: Observation },
    Recovered { stage: Option<Stage> },
    Stage { stage: Stage },
    Published { snapshot: IndexSnapshotId },
    Done {},
    Failed { failure: Failure },
}
impl From<Completion> for core::EffectResult {
    fn from(v: Completion) -> Self {
        match v {
            Completion::Observed { observation } => Self::Observed(observation.into()),
            Completion::Recovered { stage } => Self::Recovered(stage.map(Into::into)),
            Completion::Stage { stage } => Self::Stage(stage.into()),
            Completion::Published { snapshot } => Self::Published(snapshot),
            Completion::Done {} => Self::Done,
            Completion::Failed { failure } => Self::Failed(failure.into()),
        }
    }
}
pub(crate) fn decode_completion(raw: &str) -> Result<core::EffectResult> {
    Ok(decode::<Completion>(raw, INTERNAL_BYTES)?.into())
}
fn failure(v: core::Failure) -> &'static str {
    match v {
        core::Failure::StaleSource => "staleSource",
        core::Failure::StaleIndex => "staleIndex",
        core::Failure::SnapshotExpired => "snapshotExpired",
        core::Failure::RebuildRequired => "rebuildRequired",
        core::Failure::Uncertain => "uncertain",
        core::Failure::Unavailable => "unavailable",
        core::Failure::InvalidData => "invalidData",
        core::Failure::Fatal => "fatal",
    }
}
fn observation(v: &core::Observation) -> Value {
    json!({"source":v.source,"published":v.published,"current":v.current,"rebuildRequired":v.rebuild_required,"coverageComplete":v.coverage_complete})
}
fn progress(v: &core::StageProgress) -> Value {
    json!({"prepared":v.prepared,"total":v.total,"ready":v.ready})
}
fn update(v: &core::RuntimeUpdate) -> Value {
    json!({"lifetime":v.lifetime,"revision":v.revision.to_string(),"source":v.source,"published":v.published,
    "freshness":match v.freshness{core::Freshness::Unknown=>"unknown",core::Freshness::Current=>"current",core::Freshness::Lagging=>"lagging",core::Freshness::Unavailable=>"unavailable"},
    "phase":match v.phase{core::Phase::Idle=>"idle",core::Phase::Observing=>"observing",core::Phase::Initializing=>"initializing",core::Phase::Recovering=>"recovering",core::Phase::Indexing=>"indexing",core::Phase::Publishing=>"publishing",core::Phase::Rebuilding=>"rebuilding",core::Phase::Releasing=>"releasing"},
    "progress":v.progress.as_ref().map(progress),"coverageComplete":v.coverage_complete,"hasForegroundDemand":v.has_foreground_demand,"error":v.error.map(failure)})
}
pub(crate) fn effect(v: &core::IssuedEffect) -> Value {
    json!({"lifetime":v.lifetime,"effectId":v.id.to_string(),"priority":match v.priority{core::Priority::Foreground=>"foreground",core::Priority::Background=>"background"},"targetSource":v.target_source,
    "effect":match &v.kind{core::Effect::Observe=>json!({"kind":"observe"}),core::Effect::RecoverStage=>json!({"kind":"recoverStage"}),core::Effect::Initialize=>json!({"kind":"initialize"}),core::Effect::Begin=>json!({"kind":"begin"}),core::Effect::Pump{snapshot}=>json!({"kind":"pump","snapshot":snapshot}),core::Effect::Publish{snapshot}=>json!({"kind":"publish","snapshot":snapshot}),core::Effect::Discard{snapshot}=>json!({"kind":"discard","snapshot":snapshot}),core::Effect::Rebuild=>json!({"kind":"rebuild"})}})
}
pub(crate) fn encode(v: Value) -> Result<String> {
    let raw = v.to_string();
    if raw.len() > INTERNAL_BYTES {
        Err("document_runtime_capacity")
    } else {
        Ok(raw)
    }
}
fn execution(value: core::Execution) -> &'static str {
    match value { core::Execution::Dispatch => "dispatch", core::Execution::Yield => "yield", core::Execution::WaitForWake => "waitForWake", core::Execution::Quiesced => "quiesced" }
}
pub(crate) fn reduction(v: &core::Reduction) -> Result<String> {
    encode(
        json!({"effect":v.effect.as_ref().map(effect),"update":update(&v.update),"execution":match v.execution{core::Execution::Dispatch=>"dispatch",core::Execution::Yield=>"yield",core::Execution::WaitForWake=>"waitForWake",core::Execution::Quiesced=>"quiesced"},
    "requestOutcomes":v.request_outcomes.iter().map(|o|match o{core::RequestOutcome::Finished{id,observation:v}=>json!({"kind":"finished","id":id.to_string(),"observation":observation(v)}),core::RequestOutcome::Failed{id,failure:v}=>json!({"kind":"failed","id":id.to_string(),"failure":failure(*v)}),core::RequestOutcome::Cancelled{id}=>json!({"kind":"cancelled","id":id.to_string()}),core::RequestOutcome::Retired{id}=>json!({"kind":"retired","id":id.to_string()})}).collect::<Vec<_>>()}),
    )
}
pub(crate) struct Replay {
    pub(crate) lifetime: OperationId,
    pub(crate) id: u64,
    pub(crate) report: String,
}
pub(crate) struct State {
    pub(crate) core: core::DocumentRuntime,
    pub(crate) replay: Option<Replay>,
    pub(crate) execution: core::Execution,
    pub(crate) draft_scope: Option<crate::document_drafts::DraftScope>,
    pub(crate) drafts: Option<zorid_index::document_draft_executor::DocumentDraftExecutor>,
}
#[wasm_bindgen]
pub struct WasmDocumentRuntimeOwner {
    pub(crate) state: Rc<RefCell<State>>,
    pub(crate) live: Rc<Cell<bool>>,
}
impl WasmDocumentRuntimeOwner {
    fn command(&self, raw: &str) -> Result<String> {
        let input = decode::<Command>(raw, CONTROL_BYTES)?.input()?;
        let retiring = matches!(input, core::Input::Retire);
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| "document_runtime_busy")?;
        if !self.live.get() {
            return Err("document_runtime_expired");
        }
        let result = if retiring && state.drafts.is_some() {
            let State { core, execution, drafts, .. } = &mut *state;
            drafts.as_mut().unwrap().begin_close(core, execution)
                .map_err(crate::document_drafts::draft_error)?.committed
        } else {
            let result = state.core.reduce(input).map_err(contract)?;
            state.execution = result.execution;
            result
        };
        if retiring {
            state.replay = None;
        }
        reduction(&result)
    }
    fn issue(&self, lifetime: &str, id: &str) -> Result<WasmDocumentRuntimeIssued> {
        let id = decimal(id)?;
        let state = self
            .state
            .try_borrow()
            .map_err(|_| "document_runtime_busy")?;
        if !self.live.get() {
            return Err("document_runtime_expired");
        }
        if state.drafts.is_some() {
            return Err("document_runtime_expired");
        }
        let issued = state
            .core
            .in_flight()
            .filter(|i| i.lifetime.as_str() == lifetime && i.id == id)
            .ok_or("document_runtime_expired")?
            .clone();
        Ok(WasmDocumentRuntimeIssued {
            state: self.state.clone(),
            live: self.live.clone(),
            issued,
            consumed: false,
        })
    }
}
#[wasm_bindgen]
impl WasmDocumentRuntimeOwner {
    #[wasm_bindgen(constructor)]
    pub fn new(
        lifetime: &str,
        local_store: &str,
    ) -> std::result::Result<WasmDocumentRuntimeOwner, JsValue> {
        let create = || -> Result<Self> {
            let lifetime = OperationId::new(lifetime).map_err(|_| "invalid_request")?;
            let local_store = OperationId::new(local_store).map_err(|_| "invalid_request")?;
            let versions = SemanticVersions::new(
                INDEX_SCHEMA_VERSION,
                document_extraction_version(),
                RESOLVER_VERSION,
                LITERAL_QUERY_VERSION,
            )
            .map_err(|_| "invalid_request")?;
            Ok(Self {
                state: Rc::new(RefCell::new(State {
                    core: core::DocumentRuntime::new(core::RuntimeIdentity {
                        lifetime,
                        local_store,
                        versions,
                    }),
                    replay: None,
                    execution: core::Execution::WaitForWake,
                    draft_scope: None,
                    drafts: None,
                })),
                live: Rc::new(Cell::new(true)),
            })
        };
        create().map_err(error)
    }
    #[wasm_bindgen(js_name=commandJson)]
    pub fn command_json(&self, raw: &str) -> std::result::Result<String, JsValue> {
        self.command(raw).map_err(error)
    }
    #[wasm_bindgen(js_name=updateJson)]
    pub fn update_json(&self) -> std::result::Result<String, JsValue> {
        let state = self
            .state
            .try_borrow()
            .map_err(|_| error("document_runtime_busy"))?;
        if !self.live.get() {
            return Err(error("document_runtime_expired"));
        }
        encode(update(&state.core.update())).map_err(error)
    }
    /// Read the actual current descriptor and the existing single ACK slot.
    /// This never issues work, consumes outcomes or accepts a caller proof.
    #[wasm_bindgen(js_name=snapshotJson)]
    pub fn snapshot_json(&self) -> std::result::Result<String, JsValue> {
        if !self.live.get() {
            return Err(error("document_runtime_expired"));
        }
        let state = self
            .state
            .try_borrow()
            .map_err(|_| error("document_runtime_busy"))?;
        let last_step = state.replay.as_ref().map(|r| {
            let report: Value =
                serde_json::from_str(&r.report).expect("internally encoded reduction");
            json!({"lifetime":r.lifetime,"effectId":r.id.to_string(),"reduction":report})
        });
        encode(json!({"update":update(&state.core.update()),"inFlight":state.core.in_flight().map(effect),"lastStep":last_step,"execution":execution(state.execution)})).map_err(error)
    }
    /// Only the internal admitted executor receives an issued handle.
    pub fn issued(
        &self,
        lifetime: &str,
        id: &str,
    ) -> std::result::Result<WasmDocumentRuntimeIssued, JsValue> {
        self.issue(lifetime, id).map_err(error)
    }
    #[wasm_bindgen(js_name=replayJson)]
    pub fn replay_json(
        &self,
        lifetime: &str,
        id: &str,
    ) -> std::result::Result<Option<String>, JsValue> {
        let id = decimal(id).map_err(error)?;
        let state = self
            .state
            .try_borrow()
            .map_err(|_| error("document_runtime_busy"))?;
        if !self.live.get() {
            return Err(error("document_runtime_expired"));
        }
        Ok(state
            .replay
            .as_ref()
            .filter(|r| r.lifetime.as_str() == lifetime && r.id == id)
            .map(|r| r.report.clone()))
    }
}
impl Drop for WasmDocumentRuntimeOwner {
    fn drop(&mut self) {
        self.live.set(false);
        if let Ok(mut state) = self.state.try_borrow_mut() {
            state.replay = None;
            let _ = state.core.reduce(core::Input::Retire);
            // Emergency free revokes retained handles and actually disposes all
            // draft payloads. Normal callers prove the bounded future-turn drain
            // before free; this fallback does not claim that lifecycle proof.
            state.drafts = None;
            state.draft_scope = None;
        }
    }
}
#[wasm_bindgen]
pub struct WasmDocumentRuntimeIssued {
    state: Rc<RefCell<State>>,
    live: Rc<Cell<bool>>,
    issued: core::IssuedEffect,
    consumed: bool,
}
impl WasmDocumentRuntimeIssued {
    fn complete(&mut self, raw: &str) -> Result<String> {
        if self.consumed || !self.live.get() {
            return Err("document_runtime_expired");
        }
        let result = decode::<Completion>(raw, INTERNAL_BYTES)?;
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| "document_runtime_busy")?;
        if !self.live.get() || state.drafts.is_some() || state.core.in_flight() != Some(&self.issued) {
            return Err("document_runtime_expired");
        }
        let reduced = state
            .core
            .reduce(core::Input::Complete {
                lifetime: self.issued.lifetime.clone(),
                effect_id: self.issued.id,
                result: result.into(),
            })
            .map_err(contract)?;
        state.execution = reduced.execution;
        self.consumed = true;
        let report = reduction(&reduced)?;
        if reduced.execution != core::Execution::Quiesced {
            state.replay = Some(Replay {
                lifetime: self.issued.lifetime.clone(),
                id: self.issued.id,
                report: report.clone(),
            });
        }
        Ok(report)
    }
}
#[wasm_bindgen]
impl WasmDocumentRuntimeIssued {
    #[wasm_bindgen(js_name=descriptorJson)]
    pub fn descriptor_json(&self) -> std::result::Result<String, JsValue> {
        if self.consumed || !self.live.get() {
            return Err(error("document_runtime_expired"));
        }
        let state = self
            .state
            .try_borrow()
            .map_err(|_| error("document_runtime_busy"))?;
        if !self.live.get() || state.drafts.is_some() || state.core.in_flight() != Some(&self.issued) {
            return Err(error("document_runtime_expired"));
        }
        encode(effect(&self.issued)).map_err(error)
    }
    /// Not a transport command: caller is the private admitted IDB executor.
    #[wasm_bindgen(js_name=completeJson)]
    pub fn complete_json(&mut self, raw: &str) -> std::result::Result<String, JsValue> {
        self.complete(raw).map_err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn new_owner(id: &str) -> WasmDocumentRuntimeOwner {
        WasmDocumentRuntimeOwner::new(id, "store").unwrap()
    }
    fn control(owner: &WasmDocumentRuntimeOwner, raw: &str) -> Value {
        serde_json::from_str(&owner.command(raw).unwrap()).unwrap()
    }
    fn handle(owner: &WasmDocumentRuntimeOwner, report: &Value) -> WasmDocumentRuntimeIssued {
        owner
            .issue(
                report["effect"]["lifetime"].as_str().unwrap(),
                report["effect"]["effectId"].as_str().unwrap(),
            )
            .unwrap()
    }
    fn observed(current: bool) -> String {
        let snapshot = IndexSnapshotId::new(
            OperationId::new("store").unwrap(),
            OperationId::new("epoch").unwrap(),
            1,
            SemanticVersions::new(
                INDEX_SCHEMA_VERSION,
                document_extraction_version(),
                RESOLVER_VERSION,
                LITERAL_QUERY_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
        json!({"kind":"observed","observation":{"source":{"localStoreId":"store","watermark":"7"},"published":if current{Some(snapshot)}else{None},"current":current,"rebuildRequired":false,"coverageComplete":if current{Some(true)}else{None}}}).to_string()
    }
    #[test]
    fn runtime_controls_never_accept_completion_or_caller_observation() {
        let owner = new_owner("runtime");
        for raw in [
            r#"{"kind":"complete","effectId":"1","result":{"kind":"done"}}"#,
            r#"{"kind":"observed","observation":{}}"#,
            r#"{"kind":"continue","current":true}"#,
            r#"{"kind":"sourceHint","source":{"localStoreId":"store","watermark":"7"}}"#,
            r#"{"kind":"retire","extra":1}"#,
            r#"{"kind":"wake","monotonicMs":"01"}"#,
            r#"{"kind":"request","id":"18446744073709551616","maxPumps":8,"maxRestarts":1,"forceRebuild":false}"#,
        ] {
            assert_eq!(owner.command(raw), Err("invalid_request"));
            assert!(owner.state.borrow().core.in_flight().is_none());
        }
        assert_eq!(
            owner.command(&"x".repeat(CONTROL_BYTES + 1)),
            Err("document_runtime_capacity")
        );
        let result = control(&owner, r#"{"kind":"wake","monotonicMs":"7"}"#);
        assert_eq!(result["effect"]["effect"]["kind"], "observe");
        assert_eq!(result["effect"]["effectId"], "1");
    }
    #[test]
    fn runtime_issued_handles_match_owner_effect_and_consume_exactly_once() {
        let owner = new_owner("runtime");
        let other = new_owner("other");
        let report = control(&owner, r#"{"kind":"wake","monotonicMs":"0"}"#);
        let _ = control(&other, r#"{"kind":"wake","monotonicMs":"0"}"#);
        assert!(owner.issue("other", "1").is_err());
        let mut foreign = handle(&owner, &report);
        foreign.state = other.state.clone();
        assert_eq!(
            foreign.complete(&observed(false)),
            Err("document_runtime_expired")
        );
        let mut first = handle(&owner, &report);
        let mut duplicate = handle(&owner, &report);
        assert!(first.complete(r#"{"kind":"stage","stage":null}"#).is_err());
        assert_eq!(
            first.complete(r#"{"kind":"done","proof":true}"#),
            Err("invalid_request")
        );
        let settled = first.complete(&observed(false)).unwrap();
        assert_eq!(
            first.complete(&observed(false)),
            Err("document_runtime_expired")
        );
        assert_eq!(
            duplicate.complete(&observed(false)),
            Err("document_runtime_expired")
        );
        assert_eq!(
            owner.replay_json("runtime", "1").unwrap(),
            Some(settled.clone())
        );
        let settled: Value = serde_json::from_str(&settled).unwrap();
        let mut next = handle(&owner, &settled);
        next.complete(r#"{"kind":"done"}"#).unwrap();
        assert_eq!(owner.replay_json("runtime", "1").unwrap(), None);
    }
    #[test]
    fn legacy_issued_handle_cannot_settle_after_the_composite_draft_owner_exists() {
        let owner = new_owner("runtime");
        let report = control(&owner, r#"{"kind":"wake","monotonicMs":"0"}"#);
        let mut issued = handle(&owner, &report);
        owner.configure_drafts("client", "draft", "work").unwrap();
        owner.draft_command_json(r#"{"op":"request","buffer_lifetime":"buffer","text_revision":"1","source":{"bytes":1,"utf16":1,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}"#).unwrap();
        let before = owner.state.borrow().core.update();
        assert_eq!(issued.complete(&observed(false)), Err("document_runtime_expired"));
        assert_eq!(owner.state.borrow().core.update(), before);
        assert!(owner.issue("runtime", "1").is_err());
    }
    #[test]
    fn runtime_retire_drains_only_issued_completion_and_drop_expires_old_handles() {
        let owner = new_owner("runtime");
        let report = control(&owner, r#"{"kind":"wake","monotonicMs":"0"}"#);
        let mut issued = handle(&owner, &report);
        let retired = control(&owner, r#"{"kind":"retire"}"#);
        assert_eq!(retired["update"]["phase"], "releasing");
        let settled: Value =
            serde_json::from_str(&issued.complete(&observed(false)).unwrap()).unwrap();
        assert_eq!(settled["execution"], "quiesced");
        assert!(settled["effect"].is_null());
        assert!(owner.state.borrow().replay.is_none());
        let owner = new_owner("fresh");
        let report = control(&owner, r#"{"kind":"wake","monotonicMs":"0"}"#);
        let mut issued = handle(&owner, &report);
        let weak = Rc::downgrade(&owner.state);
        drop(owner);
        assert_eq!(
            issued.complete(&observed(false)),
            Err("document_runtime_expired")
        );
        assert!(weak.upgrade().is_some());
        drop(issued);
        assert!(weak.upgrade().is_none());
        let owner = new_owner("borrowed");
        let report = control(&owner, r#"{"kind":"wake","monotonicMs":"0"}"#);
        let mut issued = handle(&owner, &report);
        let retained = owner.state.clone();
        let borrowed = retained.borrow_mut();
        drop(owner); // The separate liveness cell revokes even if clear is busy.
        assert_eq!(
            issued.complete(&observed(false)),
            Err("document_runtime_expired")
        );
        drop(borrowed);
        drop(retained);
        drop(issued);
    }
    #[test]
    fn runtime_report_keeps_decimal_u64_and_bounded_outcomes_without_loss() {
        let owner = new_owner("runtime");
        for id in 0..32u64 {
            let id = if id == 31 { u64::MAX } else { id };
            control(&owner,&json!({"kind":"request","id":id.to_string(),"maxPumps":8,"maxRestarts":1,"forceRebuild":false}).to_string());
        }
        let state: Value = serde_json::from_str(&owner.snapshot_json().unwrap()).unwrap();
        let report = json!({"effect":state["inFlight"]});
        let mut issued = handle(&owner, &report);
        // Additional hints deliberately require one more real Observe before a
        // current result can finish all demands; no current proof is fabricated.
        let mut raw = issued.complete(&observed(true)).unwrap();
        if serde_json::from_str::<Value>(&raw).unwrap()["effect"].is_object() {
            let next: Value = serde_json::from_str(&raw).unwrap();
            raw = handle(&owner, &next).complete(&observed(true)).unwrap();
        }
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["requestOutcomes"].as_array().unwrap().len(), 32);
        assert!(raw.len() <= CONTROL_BYTES);
        assert_eq!(value["requestOutcomes"][31]["id"], u64::MAX.to_string());
        assert!(value["update"]["revision"].is_string());
    }
    #[test]
    fn runtime_snapshot_preserves_failed_request_outcomes_and_next_observe() {
        let owner = new_owner("runtime");
        for id in 0..32 {
            control(&owner,&json!({"kind":"request","id":id.to_string(),"maxPumps":8,"maxRestarts":1,"forceRebuild":false}).to_string());
        }
        let before: Value = serde_json::from_str(&owner.snapshot_json().unwrap()).unwrap();
        let mut issued = handle(&owner, &json!({"effect":before["inFlight"]}));
        issued
            .complete(r#"{"kind":"failed","failure":"unavailable"}"#)
            .unwrap();
        let failed: Value = serde_json::from_str(&owner.snapshot_json().unwrap()).unwrap();
        assert_eq!(
            failed["lastStep"]["reduction"]["requestOutcomes"]
                .as_array()
                .unwrap()
                .len(),
            32
        );
        assert!(failed["inFlight"].is_null());
        control(&owner, r#"{"kind":"wake","monotonicMs":"1"}"#);
        let resumed: Value = serde_json::from_str(&owner.snapshot_json().unwrap()).unwrap();
        assert_eq!(resumed["inFlight"]["effect"]["kind"], "observe");
        assert_eq!(resumed["lastStep"], failed["lastStep"]);
        assert!(owner.snapshot_json().unwrap().len() <= CONTROL_BYTES);
    }
    #[test]
    fn runtime_snapshot_recovers_selected_effect_after_failed_step_and_yield() {
        fn complete(owner: &WasmDocumentRuntimeOwner, report: &Value, raw: &str) -> Value {
            serde_json::from_str(&handle(owner, report).complete(raw).unwrap()).unwrap()
        }
        let owner = new_owner("runtime");
        let first = control(
            &owner,
            r#"{"kind":"request","id":"1","maxPumps":8,"maxRestarts":1,"forceRebuild":false}"#,
        );
        let initialize = complete(&owner, &first, &observed(false));
        let recover = complete(&owner, &initialize, r#"{"kind":"done"}"#);
        let begin = complete(&owner, &recover, r#"{"kind":"recovered","stage":null}"#);
        let current: Value = serde_json::from_str(&observed(true)).unwrap();
        let stage = json!({"source":{"localStoreId":"store","watermark":"7"},"snapshot":current["observation"]["published"],"progress":{"prepared":0,"total":1,"ready":false}});
        let pump = complete(
            &owner,
            &begin,
            &json!({"kind":"stage","stage":stage}).to_string(),
        );
        let observe = complete(&owner, &pump, r#"{"kind":"failed","failure":"uncertain"}"#);
        let saved: Value = serde_json::from_str(&owner.snapshot_json().unwrap()).unwrap();
        assert_eq!(saved["inFlight"], observe["effect"]);
        assert_eq!(saved["inFlight"]["effect"]["kind"], "observe");
        let recover = complete(&owner, &observe, &observed(false));
        let pump = complete(
            &owner,
            &recover,
            &json!({"kind":"recovered","stage":stage}).to_string(),
        );
        let yielded = complete(
            &owner,
            &pump,
            r#"{"kind":"failed","failure":"staleSource"}"#,
        );
        assert_eq!(yielded["execution"], "yield");
        let discard = control(&owner, r#"{"kind":"continue"}"#);
        let saved: Value = serde_json::from_str(&owner.snapshot_json().unwrap()).unwrap();
        assert_eq!(saved["inFlight"], discard["effect"]);
        assert_eq!(saved["inFlight"]["effect"]["kind"], "discard");
        assert_eq!(saved["lastStep"]["reduction"], yielded);
        assert_eq!(saved["execution"], discard["execution"]);
        assert_eq!(saved["execution"], "dispatch");
        assert_ne!(saved["execution"], saved["lastStep"]["reduction"]["execution"]);
    }
}
