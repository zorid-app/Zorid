//! Bounded delivery ownership around the native committed-index reducer.
//! No parser, pump policy, timer, source writer or unsolicited framing lives here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use zorid_core::OperationId;
use zorid_native::{
    DocumentFreshnessRequest, DocumentRuntimeCommand, DocumentRuntimeEffect as Effect,
    DocumentRuntimeEffectResult as Completion, DocumentRuntimeFailure as Failure,
    DocumentRuntimeIssuedEffect as Issued, DocumentRuntimeObservation as Observation,
    DocumentRuntimePhase as Phase, DocumentRuntimePriority as Priority,
    DocumentRuntimeReduction as Reduction, DocumentRuntimeRequestOutcome as Outcome,
    DocumentRuntimeStageProgress as Progress, DocumentRuntimeUpdate as Update,
    NativeDocumentRuntimeSnapshot, NativeVault,
};
pub(crate) const MAX_BYTES: usize = 64 * 1024;
const MAX_REQUESTS: usize = 32;
fn error(code: &str) -> Value {
    json!({"code":code,"commit_uncertain":false,"message":"Document maintenance is unavailable"})
}
type Result<T> = std::result::Result<T, Value>;
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct Counter(u64);
impl TryFrom<String> for Counter {
    type Error = &'static str;
    fn try_from(value: String) -> std::result::Result<Self, Self::Error> {
        let n = value.parse::<u64>().map_err(|_| "invalid counter")?;
        if n.to_string() != value {
            return Err("invalid counter");
        }
        Ok(Self(n))
    }
}
impl From<Counter> for String {
    fn from(v: Counter) -> Self {
        v.0.to_string()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Feature {
    Request {
        lifetime: OperationId,
        id: Counter,
        max_pumps: u8,
        max_restarts: u8,
        force_rebuild: bool,
    },
    Cancel {
        lifetime: OperationId,
        id: Counter,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Owner {
    Wake { monotonic_ms: Counter },
    Continue {},
    SourceHint {},
    Retire {},
}
pub(crate) enum Command {
    Observe,
    Control {
        sequence: Counter,
        command: Feature,
    },
    Ack {
        sequence: Counter,
    },
    OutcomeAck {
        lifetime: OperationId,
        id: Counter,
    },
    Snapshot,
    Owner {
        sequence: Counter,
        command: Owner,
    },
    OwnerAck {
        sequence: Counter,
    },
    Step {
        lifetime: OperationId,
        effect_id: Counter,
    },
}
struct ControlSlot<T> {
    floor: u64,
    acknowledged: Option<u64>,
    pending: Option<(u64, T, Value)>,
}
impl<T> Default for ControlSlot<T> {
    fn default() -> Self {
        Self {
            floor: 0,
            acknowledged: None,
            pending: None,
        }
    }
}
impl<T: PartialEq> ControlSlot<T> {
    fn replay(&self, n: u64, value: &T) -> Result<Option<Value>> {
        if let Some((old, command, reply)) = &self.pending {
            return if n == *old && value == command {
                Ok(Some(reply.clone()))
            } else {
                Err(error(if n == *old {
                    "document_runtime_conflict"
                } else {
                    "document_runtime_busy"
                }))
            };
        }
        if n == 0 || n <= self.floor {
            return Err(error("document_runtime_expired"));
        }
        Ok(None)
    }
    fn ack(&mut self, n: u64) -> Result<()> {
        if self.pending.as_ref().map(|v| v.0) == Some(n) {
            self.pending = None;
            self.floor = n;
            self.acknowledged = Some(n);
            return Ok(());
        }
        if self.pending.is_none() && self.acknowledged == Some(n) {
            return Ok(());
        }
        Err(error("document_runtime_invalid_ack"))
    }
    fn expire(&mut self) {
        self.acknowledged = None;
        if let Some((n, _, _)) = self.pending.take() {
            self.floor = n;
        }
    }
}
struct Record {
    global: u64,
    lifetime: OperationId,
    local: u64,
    options: Feature,
    outcome: Option<Outcome>,
}
#[derive(Default)]
struct Client {
    control: ControlSlot<Feature>,
    highwater: u64,
    records: BTreeMap<u64, Record>,
    last_ack: Option<(OperationId, u64)>,
}
#[derive(Default)]
pub(crate) struct Sessions {
    local_store: Option<OperationId>,
    lifetime: Option<OperationId>,
    next_request: u64,
    clients: BTreeMap<OperationId, Client>,
    owner: ControlSlot<Owner>,
}
pub(crate) struct Reply {
    pub value: Value,
    pub rebuilt: bool,
}
impl Sessions {
    fn count(&self) -> usize {
        self.clients.values().map(|c| c.records.len()).sum()
    }
    fn sync(&mut self, vault: &NativeVault) {
        let observed = vault.document_runtime_update().map(|u| u.lifetime);
        if observed != self.lifetime {
            for client in self.clients.values_mut() {
                client.control.expire();
                // A different/null actual owner expires derived continuation
                // ownership atomically. No cross-lifetime ACK can free a new
                // slot, and checked request/control highwaters still fence late
                // replays. Authoritative writes/receipts are unrelated.
                client.records.clear();
                client.last_ack = None;
            }
            self.owner.expire();
            self.next_request = 0;
            self.lifetime = observed;
        }
    }
    fn adopt(&mut self, reduction: &Reduction) {
        for outcome in &reduction.request_outcomes {
            let id = outcome_id(outcome);
            for client in self.clients.values_mut() {
                if let Some(record) = client.records.values_mut().find(|r| r.global == id) {
                    if record.outcome.is_none() {
                        record.outcome = Some(outcome.clone());
                    }
                    break;
                }
            }
        }
    }
    fn frame(&self, vault: &NativeVault, client: &OperationId) -> Value {
        let outcomes = self
            .clients
            .get(client)
            .map(|c| {
                c.records
                    .values()
                    .filter_map(|r| {
                        r.outcome
                            .as_ref()
                            .map(|o| json!({"lifetime":r.lifetime,"outcome":outcome(o,r.local)}))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        json!({"version":1,"scope":{"localStoreId":self.local_store,"clientId":client},"update":vault.document_runtime_update().as_ref().map(update),"outcomes":outcomes})
    }
    pub(crate) fn execute(
        &mut self,
        vault: &mut NativeVault,
        client: &OperationId,
        command: Command,
    ) -> Result<Reply> {
        if self.local_store.is_none() {
            self.local_store = Some(
                vault
                    .identity()
                    .map_err(|_| error("document_runtime_unavailable"))?
                    .local_store_id,
            );
        }
        self.sync(vault);
        let mut rebuilt = false;
        let value = match command {
            Command::Observe => self.frame(vault, client),
            Command::Snapshot => json!({"snapshot":snapshot(vault)}),
            Command::Ack { sequence } => {
                self.clients
                    .get_mut(client)
                    .ok_or_else(|| error("document_runtime_invalid_ack"))?
                    .control
                    .ack(sequence.0)?;
                json!(true)
            }
            Command::OutcomeAck { lifetime, id } => {
                let selected = self
                    .clients
                    .get_mut(client)
                    .ok_or_else(|| error("document_runtime_invalid_ack"))?;
                if selected.last_ack.as_ref() == Some(&(lifetime.clone(), id.0)) {
                    json!(true)
                } else {
                    let record = selected
                        .records
                        .get(&id.0)
                        .filter(|r| r.lifetime == lifetime && r.outcome.is_some())
                        .ok_or_else(|| error("document_runtime_invalid_ack"))?;
                    let _ = record;
                    selected.records.remove(&id.0);
                    selected.last_ack = Some((lifetime, id.0));
                    json!(true)
                }
            }
            Command::Control { sequence, command } => {
                if !self.clients.contains_key(client) && self.clients.len() >= 32 {
                    return Err(error("document_runtime_capacity"));
                }
                if let Some(reply) = self
                    .clients
                    .entry(client.clone())
                    .or_default()
                    .control
                    .replay(sequence.0, &command)?
                {
                    return Ok(Reply {
                        value: fresh_snapshot(reply, vault),
                        rebuilt: false,
                    });
                }
                match &command {
                    Feature::Request {
                        lifetime,
                        id,
                        max_pumps,
                        max_restarts,
                        force_rebuild,
                    } => {
                        if *max_pumps == 0 || *max_pumps > 128 || *max_restarts > 2 || id.0 == 0 {
                            return Err(error("invalid_request"));
                        }
                        if let Some(record) = self.clients[client].records.get(&id.0) {
                            if &record.options != &command {
                                return Err(error("document_runtime_conflict"));
                            }
                        } else {
                            if self.lifetime.as_ref() != Some(lifetime) {
                                return Err(error("document_runtime_expired"));
                            }
                            if id.0 <= self.clients[client].highwater {
                                return Err(error("document_runtime_expired"));
                            }
                            if self.count() >= MAX_REQUESTS {
                                return Err(error("document_runtime_capacity"));
                            }
                            let global = self
                                .next_request
                                .checked_add(1)
                                .ok_or_else(|| error("document_runtime_capacity"))?;
                            let reduction = vault
                                .document_runtime_command(DocumentRuntimeCommand::Request(
                                    DocumentFreshnessRequest {
                                        id: global,
                                        max_pumps: *max_pumps,
                                        max_restarts: *max_restarts,
                                        force_rebuild: *force_rebuild,
                                    },
                                ))
                                .map_err(native_error)?;
                            self.next_request = global;
                            let selected = self.clients.get_mut(client).expect("client");
                            selected.highwater = id.0;
                            selected.records.insert(
                                id.0,
                                Record {
                                    global,
                                    lifetime: lifetime.clone(),
                                    local: id.0,
                                    options: command.clone(),
                                    outcome: None,
                                },
                            );
                            self.adopt(&reduction);
                        }
                    }
                    Feature::Cancel { lifetime, id } => {
                        let record = self.clients[client]
                            .records
                            .get(&id.0)
                            .filter(|r| &r.lifetime == lifetime)
                            .ok_or_else(|| error("document_runtime_expired"))?;
                        if record.outcome.is_none() {
                            let reduction = vault
                                .document_runtime_command(DocumentRuntimeCommand::CancelRequest {
                                    id: record.global,
                                })
                                .map_err(native_error)?;
                            self.adopt(&reduction);
                        }
                    }
                }
                let reply = json!({"sequence":sequence,"command":command,"frame":self.frame(vault,client),"snapshot":snapshot(vault)});
                bounded(&reply)?;
                self.clients
                    .get_mut(client)
                    .expect("client")
                    .control
                    .pending = Some((sequence.0, command, reply.clone()));
                reply
            }
            Command::OwnerAck { sequence } => {
                self.owner.ack(sequence.0)?;
                json!(true)
            }
            Command::Owner { sequence, command } => {
                if let Some(reply) = self.owner.replay(sequence.0, &command)? {
                    return Ok(Reply {
                        value: fresh_snapshot(reply, vault),
                        rebuilt: false,
                    });
                }
                if matches!(command, Owner::Wake { .. }) {
                    if let Some(old) = vault.document_runtime_snapshot() {
                        if old.update.phase == Phase::Releasing && old.in_flight.is_none() {
                            vault.restart_document_runtime().map_err(native_error)?;
                        }
                    }
                }
                let control = match &command {
                    Owner::Wake { monotonic_ms } => DocumentRuntimeCommand::Wake {
                        monotonic_ms: monotonic_ms.0,
                    },
                    Owner::Continue {} => DocumentRuntimeCommand::Continue,
                    Owner::SourceHint {} => DocumentRuntimeCommand::SourceHint,
                    Owner::Retire {} => DocumentRuntimeCommand::Retire,
                };
                let reduction = vault
                    .document_runtime_command(control)
                    .map_err(native_error)?;
                self.sync(vault);
                self.adopt(&reduction);
                let reply =
                    json!({"sequence":sequence,"command":command,"snapshot":snapshot(vault)});
                bounded(&reply)?;
                self.owner.pending = Some((sequence.0, command, reply.clone()));
                reply
            }
            Command::Step {
                lifetime,
                effect_id,
            } => {
                let before = vault.document_runtime_snapshot();
                let replay = before
                    .as_ref()
                    .and_then(|s| s.last_step.as_ref())
                    .map_or(false, |s| {
                        s.lifetime == lifetime && s.effect_id == effect_id.0
                    });
                let record = vault
                    .document_runtime_step_record(&lifetime, effect_id.0)
                    .map_err(native_error)?;
                self.adopt(&record.reduction);
                rebuilt = !replay
                    && matches!(record.receipt.issued.kind, Effect::Rebuild)
                    && matches!(record.receipt.completion, Completion::Done);
                json!({"snapshot":snapshot(vault)})
            }
        };
        bounded(&value)?;
        Ok(Reply { value, rebuilt })
    }
    /// Called by trusted release after existing flush/admission handling. It
    /// cancels only this client's demand; last-owner retirement drains at most
    /// the one issued effect before the native lease is dropped.
    pub(crate) fn release(
        &mut self,
        vault: &mut NativeVault,
        client: &OperationId,
        last: bool,
    ) -> Result<bool> {
        self.sync(vault);
        let ids = self
            .clients
            .get(client)
            .map(|c| {
                c.records
                    .values()
                    .filter(|r| r.outcome.is_none())
                    .map(|r| r.global)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for id in ids {
            let reduction = vault
                .document_runtime_command(DocumentRuntimeCommand::CancelRequest { id })
                .map_err(native_error)?;
            self.adopt(&reduction);
        }
        self.clients.remove(client);
        let mut rebuilt = false;
        if last && vault.document_runtime_update().is_some() {
            let reduction = vault
                .document_runtime_command(DocumentRuntimeCommand::Retire)
                .map_err(native_error)?;
            self.adopt(&reduction);
            if let Some(issued) = vault.document_runtime_snapshot().and_then(|s| s.in_flight) {
                let record = vault
                    .document_runtime_step_record(&issued.lifetime, issued.id)
                    .map_err(native_error)?;
                rebuilt = matches!(record.receipt.issued.kind, Effect::Rebuild)
                    && matches!(record.receipt.completion, Completion::Done);
                self.adopt(&record.reduction);
            }
            self.owner.expire();
        }
        Ok(rebuilt)
    }
}
// Only this private execution observation is refreshed. The public control
// ACK sequence/command/frame remain the exact historical accepted reply.
fn fresh_snapshot(mut reply: Value, vault: &NativeVault) -> Value {
    reply
        .as_object_mut()
        .expect("stored control reply")
        .insert("snapshot".into(), snapshot(vault));
    reply
}
fn bounded(v: &Value) -> Result<()> {
    if serde_json::to_vec(v)
        .map_err(|_| error("document_runtime_invalid_result"))?
        .len()
        > MAX_BYTES
    {
        Err(error("document_runtime_capacity"))
    } else {
        Ok(())
    }
}
fn native_error(e: zorid_native::NativeDocumentRuntimeError) -> Value {
    error(e.code())
}
fn outcome_id(v: &Outcome) -> u64 {
    match v {
        Outcome::Finished { id, .. }
        | Outcome::Failed { id, .. }
        | Outcome::Cancelled { id }
        | Outcome::Retired { id } => *id,
    }
}
fn failure(v: Failure) -> &'static str {
    match v {
        Failure::StaleSource => "staleSource",
        Failure::StaleIndex => "staleIndex",
        Failure::SnapshotExpired => "snapshotExpired",
        Failure::RebuildRequired => "rebuildRequired",
        Failure::Uncertain => "uncertain",
        Failure::Unavailable => "unavailable",
        Failure::InvalidData => "invalidData",
        Failure::Fatal => "fatal",
    }
}
fn observation(v: &Observation) -> Value {
    json!({"source":v.source,"published":v.published,"current":v.current,"rebuildRequired":v.rebuild_required,"coverageComplete":v.coverage_complete})
}
fn progress(v: &Progress) -> Value {
    json!({"prepared":v.prepared,"total":v.total,"ready":v.ready})
}
fn update(v: &Update) -> Value {
    use zorid_native::DocumentRuntimeFreshness as F;
    json!({"lifetime":v.lifetime,"revision":v.revision.to_string(),"source":v.source,"published":v.published,"freshness":match v.freshness{F::Unknown=>"unknown",F::Current=>"current",F::Lagging=>"lagging",F::Unavailable=>"unavailable"},"phase":match v.phase{Phase::Idle=>"idle",Phase::Observing=>"observing",Phase::Initializing=>"initializing",Phase::Recovering=>"recovering",Phase::Indexing=>"indexing",Phase::Publishing=>"publishing",Phase::Rebuilding=>"rebuilding",Phase::Releasing=>"releasing"},"progress":v.progress.as_ref().map(progress),"coverageComplete":v.coverage_complete,"hasForegroundDemand":v.has_foreground_demand,"error":v.error.map(failure)})
}
fn issued(v: &Issued) -> Value {
    json!({"lifetime":v.lifetime,"effectId":v.id.to_string(),"priority":match v.priority{Priority::Foreground=>"foreground",Priority::Background=>"background"},"targetSource":v.target_source,"effect":match &v.kind{Effect::Observe=>json!({"kind":"observe"}),Effect::RecoverStage=>json!({"kind":"recoverStage"}),Effect::Initialize=>json!({"kind":"initialize"}),Effect::Begin=>json!({"kind":"begin"}),Effect::Pump{snapshot}=>json!({"kind":"pump","snapshot":snapshot}),Effect::Publish{snapshot}=>json!({"kind":"publish","snapshot":snapshot}),Effect::Discard{snapshot}=>json!({"kind":"discard","snapshot":snapshot}),Effect::Rebuild=>json!({"kind":"rebuild"})}})
}
fn outcome(v: &Outcome, id: u64) -> Value {
    match v {
        Outcome::Finished { observation: v, .. } => {
            json!({"kind":"finished","id":id.to_string(),"observation":observation(v)})
        }
        Outcome::Failed { failure: v, .. } => {
            json!({"kind":"failed","id":id.to_string(),"failure":failure(*v)})
        }
        Outcome::Cancelled { .. } => json!({"kind":"cancelled","id":id.to_string()}),
        Outcome::Retired { .. } => json!({"kind":"retired","id":id.to_string()}),
    }
}
fn execution(value: zorid_native::DocumentRuntimeExecution) -> &'static str {
    use zorid_native::DocumentRuntimeExecution as E;
    match value {
        E::Dispatch => "dispatch",
        E::Yield => "yield",
        E::WaitForWake => "waitForWake",
        E::Quiesced => "quiesced",
    }
}
fn reduction(v: &Reduction) -> Value {
    use zorid_native::DocumentRuntimeExecution as E;
    json!({"effect":v.effect.as_ref().map(issued),"update":update(&v.update),"requestOutcomes":v.request_outcomes.iter().map(|o|outcome(o,outcome_id(o))).collect::<Vec<_>>(),"execution":match v.execution{E::Dispatch=>"dispatch",E::Yield=>"yield",E::WaitForWake=>"waitForWake",E::Quiesced=>"quiesced"}})
}
fn snapshot(vault: &NativeVault) -> Value {
    vault.document_runtime_snapshot().map(|s:NativeDocumentRuntimeSnapshot|json!({"execution":execution(s.execution),"update":update(&s.update),"inFlight":s.in_flight.as_ref().map(issued),"lastStep":s.last_step.as_ref().map(|r|json!({"lifetime":r.lifetime,"effectId":r.effect_id.to_string(),"reduction":reduction(&r.reduction)}))})).unwrap_or(Value::Null)
}
#[cfg(test)]
#[path = "document_runtime_tests.rs"]
mod tests;
