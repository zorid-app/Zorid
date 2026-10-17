use super::*;
use crate::sync::{AuthenticatedFamily, WasmSyncUpdate};
use serde::Deserialize;
use zorid_client_sync::{self as text, v2 as text_v2, TextState};
use zorid_core::{EntryChange, EntryId, EntryState, VaultPath};
use zorid_file_sync::{
    binary_mutation, metadata_mutation, mutation, reference_materialization as classifier,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FamilyInput {
    command: mutation::FamilyCommand,
    entries: Vec<EntryState>,
    text: Option<TextState>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FamilyPlanInput {
    command: mutation::FamilyCommand,
    entries: Vec<EntryState>,
    text: Option<TextState>,
    allocation: mutation::Allocation,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum TargetInput {
    Create {
        id: EntryId,
        path: VaultPath,
    },
    Write {
        id: EntryId,
        expected_revision: Revision,
        expected_content_event: UpdateId,
    },
}
impl From<TargetInput> for binary_mutation::BinaryTarget {
    fn from(value: TargetInput) -> Self {
        match value {
            TargetInput::Create { id, path } => Self::Create { id, path },
            TargetInput::Write {
                id,
                expected_revision,
                expected_content_event,
            } => Self::Write {
                id,
                expected_revision,
                expected_content_event,
            },
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BinaryInput {
    entries: Vec<EntryState>,
    target: TargetInput,
    final_event_id: UpdateId,
    metadata_revision: Revision,
    next_graph_revision: Revision,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplaceInput {
    state: TextState,
    request: text::AuthorRequest,
    namespace: text_v2::TextNamespaceContext,
    next_namespace_version: Revision,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiveInput {
    state: TextState,
    request: text::ReceiveRequest,
    next_namespace_version: Revision,
    cursor: Option<text::ReceiveCursor>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckInput {
    entries: Option<Vec<EntryState>>,
    text: Option<TextState>,
    allocated_ids_unused: Option<bool>,
    cursor: Option<text::ReceiveCursor>,
}

enum Guard {
    Namespace,
    AuthoredBatch,
    Family {
        entries: Vec<EntryState>,
        text: Option<mutation::TextChange>,
    },
    Binary {
        entries: Vec<EntryState>,
        target: binary_mutation::BinaryTarget,
    },
    TextAuthor(text::AuthoredPlan),
    TextReceive(text::ReceivedPlan),
}
impl Guard {
    fn check(&self, raw: &str, prior_wire: &[u8]) -> Result<()> {
        let input: CheckInput = bounded(raw, super::super::MAX_INPUT_BYTES)?;
        match self {
            Self::Namespace => Ok(()),
            Self::AuthoredBatch => {
                if input.allocated_ids_unused == Some(true) {
                    Ok(())
                } else {
                    Err("allocated identities must be unused".into())
                }
            }
            Self::Family { entries, text } => {
                if input.allocated_ids_unused != Some(true) {
                    return Err("allocated identities must be unused".into());
                }
                entries_match(entries, input.entries.as_deref())?;
                match (text, input.text.as_ref()) {
                    (None, None) | (Some(mutation::TextChange::Create(_)), None) => Ok(()),
                    (Some(mutation::TextChange::Write(plan)), Some(actual))
                        if &plan.expected_state == actual =>
                    {
                        Ok(())
                    }
                    _ => Err("exact Text precondition changed".into()),
                }
            }
            Self::Binary { entries, .. } => {
                if input.allocated_ids_unused != Some(true) {
                    return Err("allocated identities must be unused".into());
                }
                entries_match(entries, input.entries.as_deref())
            }
            Self::TextAuthor(plan) => domain(plan.check_preconditions(
                input.text.as_ref().ok_or("current Text state required")?,
                None,
                input.allocated_ids_unused == Some(true),
            )),
            Self::TextReceive(plan) => {
                let prior = if prior_wire.is_empty() {
                    None
                } else {
                    Some(text::ReceivedRecord {
                        identity: plan.received_record.identity.clone(),
                        update_id: plan.received_record.update_id.clone(),
                        exact_wire: prior_wire.to_vec(),
                    })
                };
                domain(plan.check_preconditions(
                    input.text.as_ref().ok_or("current Text state required")?,
                    prior.as_ref(),
                    input.cursor.as_ref(),
                ))
            }
        }
    }
    fn text_state(&self) -> Option<&TextState> {
        match self {
            Self::Family {
                text: Some(change), ..
            } => Some(&change.plan().next_state),
            Self::TextAuthor(plan) => Some(&plan.next_state),
            Self::TextReceive(plan) => plan.next_state.as_ref(),
            _ => None,
        }
    }
    fn text_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Family {
                text: Some(change), ..
            } => Some(&change.plan().materialized_utf8),
            Self::TextAuthor(plan) => Some(&plan.materialized_utf8),
            Self::TextReceive(plan) => plan.materialized_utf8.as_deref(),
            _ => None,
        }
    }
}
fn emission_metadata(exact: &[u8], guard: &Guard) -> Result<String> {
    if let Ok(payload) = files::Payload::decode(exact) {
        return json(&super::super::metadata(
            "files",
            &payload.scope.realm_id,
            &payload.scope.vault_id,
            &payload.id,
            exact,
            None,
        )?);
    }
    let text = match guard {
        Guard::Family {
            text: Some(change), ..
        } => change.plan(),
        Guard::TextAuthor(plan) => plan,
        _ => return Err("emission has no matching Text plan".into()),
    };
    if text.authored.payload_bytes != exact {
        return Err("emission differs from exact authored Text payload".into());
    }
    let authored = &text.authored;
    json(&super::super::metadata(
        "text",
        &authored.identity.realm_id,
        &authored.identity.vault_id,
        &authored.update_id,
        exact,
        Some(&authored.identity),
    )?)
}
fn entries_match(expected: &[EntryState], actual: Option<&[EntryState]>) -> Result<()> {
    let mut actual = actual.ok_or("current entries required")?.to_vec();
    actual.sort_by(|a, b| a.id.cmp(&b.id));
    if actual != expected {
        return Err("exact entry precondition changed".into());
    }
    Ok(())
}
fn wire(
    input: &[u8],
    identity: Option<&zorid_file_sync::WireRecord>,
) -> Result<Option<zorid_file_sync::WireRecord>> {
    if input.len() > zorid_sync_protocol::MAX_WIRE_BYTES {
        return Err("prior wire too large".into());
    }
    if input.is_empty() {
        return Ok(None);
    }
    let source = identity.ok_or("unexpected prior wire")?;
    Ok(Some(zorid_file_sync::WireRecord {
        scope: source.scope.clone(),
        id: source.id.clone(),
        exact_wire: input.to_vec(),
    }))
}
#[wasm_bindgen]
pub struct WasmMetadataCandidate {
    candidate: planner::MetadataCandidate,
    guard: Guard,
    // Only newly authored namespace/Text emissions, or ONE final binary event.
    // The chunk/page batch retains descriptors only; never whole Binary bodies.
    emissions: Vec<Vec<u8>>,
    changes: Vec<EntryChange>,
    allocated: Vec<UpdateId>,
}
impl WasmMetadataCandidate {
    fn plain(candidate: planner::MetadataCandidate) -> Self {
        Self {
            candidate,
            guard: Guard::Namespace,
            emissions: vec![],
            changes: vec![],
            allocated: vec![],
        }
    }
    fn finalize_inner(self, proof: WasmVerifiedBinarySet) -> Result<WasmMetadataPlan> {
        let plan = domain(self.candidate.finalize(proof.verified))?;
        Ok(WasmMetadataPlan {
            plan,
            guard: self.guard,
            emissions: self.emissions,
            changes: self.changes,
            allocated: self.allocated,
        })
    }
}
#[wasm_bindgen]
impl WasmMetadataCandidate {
    #[wasm_bindgen(js_name=verificationSession)]
    pub fn verification_session(
        &self,
    ) -> std::result::Result<WasmBinaryVerificationSession, JsValue> {
        WasmBinaryVerificationSession::from_state(self.candidate.verification_state())
            .map_err(error)
    }
    pub fn finalize(
        self,
        proof: WasmVerifiedBinarySet,
    ) -> std::result::Result<WasmMetadataPlan, JsValue> {
        self.finalize_inner(proof).map_err(error)
    }
    #[wasm_bindgen(js_name=payloadCount)]
    pub fn payload_count(&self) -> usize {
        self.emissions.len()
    }
    #[wasm_bindgen(js_name=payloadMetadataJson)]
    pub fn payload_metadata_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        emission_metadata(
            self.emissions
                .get(index(position).map_err(error)?)
                .ok_or_else(|| error("payload index out of range"))?,
            &self.guard,
        )
        .map_err(error)
    }
    #[wasm_bindgen(js_name=payloadBytes)]
    pub fn payload_bytes(&self, position: f64) -> std::result::Result<Vec<u8>, JsValue> {
        Ok(self
            .emissions
            .get(index(position).map_err(error)?)
            .ok_or_else(|| error("payload index out of range"))?
            .clone())
    }
}
#[wasm_bindgen]
impl WasmMetadataState {
    #[wasm_bindgen(js_name=mutationRequirements)]
    pub fn mutation_requirements(&self, raw: &str) -> std::result::Result<String, JsValue> {
        let run = || -> Result<String> {
            let input: FamilyInput = bounded(raw, super::super::MAX_INPUT_BYTES)?;
            input.command.validate().map_err(|e| e.to_string())?;
            json(&domain(metadata_mutation::requirements(
                &input.command.request,
                &input.entries,
                &self.state,
                input.command.create_mode,
                input.text.as_ref(),
            ))?)
        };
        run().map_err(error)
    }
    #[wasm_bindgen(js_name=prepareMutation)]
    pub fn prepare_mutation(
        &self,
        raw: &str,
    ) -> std::result::Result<WasmMetadataCandidate, JsValue> {
        self.prepare_mutation_inner(raw).map_err(error)
    }
    #[wasm_bindgen(js_name=prepareAuthoredBatch)]
    pub fn prepare_authored_batch(
        &self,
        batch: WasmAuthoredMetadataBatch,
        next_version: &str,
    ) -> std::result::Result<WasmMetadataCandidate, JsValue> {
        let candidate = planner::prepare_authored_batch(
            &self.state,
            batch.batch,
            revision(next_version).map_err(error)?,
        )
        .map_err(error)?;
        let allocated = candidate
            .authored_payload_refs()
            .iter()
            .map(|reference| reference.id().clone())
            .collect();
        Ok(WasmMetadataCandidate {
            candidate,
            guard: Guard::AuthoredBatch,
            emissions: vec![],
            changes: vec![],
            allocated,
        })
    }
    #[wasm_bindgen(js_name=prepareBinaryMutation)]
    pub fn prepare_binary_mutation(
        &self,
        raw: &str,
        batch: WasmAuthoredMetadataBatch,
        built: WasmBuiltManifest,
    ) -> std::result::Result<WasmMetadataCandidate, JsValue> {
        let run = || -> Result<WasmMetadataCandidate> {
            let input: BinaryInput = bounded(raw, super::super::MAX_STATE_JSON_BYTES)?;
            if input.metadata_revision == input.next_graph_revision
                || &input.metadata_revision == self.state.version()
            {
                return Err(
                    "binary metadata and graph revisions must be distinct and fresh".into(),
                );
            }
            let target: binary_mutation::BinaryTarget = input.target.into();
            let metadata_target = match &target {
                binary_mutation::BinaryTarget::Create { id, path } => {
                    zorid_core::FileContentTarget::Create {
                        id: id.clone(),
                        path: path.clone(),
                    }
                }
                binary_mutation::BinaryTarget::Write {
                    id,
                    expected_revision,
                    ..
                } => zorid_core::FileContentTarget::Write {
                    id: id.clone(),
                    expected: expected_revision.clone(),
                },
            };
            let changes = domain(zorid_core::plan_file_content_mutation(
                &metadata_target,
                &input.entries,
                &input.metadata_revision,
            ))?;
            let prepared = domain(binary_mutation::prepare_binary_mutation(
                &self.state,
                &input.entries,
                target,
                batch.batch,
                built.built.manifest(),
                input.final_event_id,
                input.next_graph_revision,
            ))?;
            let (target, entries, event, candidate) = prepared.into_parts();
            let allocated = candidate
                .authored_payload_refs()
                .iter()
                .map(|reference| reference.id().clone())
                .collect();
            Ok(WasmMetadataCandidate {
                candidate,
                guard: Guard::Binary { entries, target },
                emissions: vec![event.payload_bytes().to_vec()],
                changes,
                allocated,
            })
        };
        run().map_err(error)
    }
    #[wasm_bindgen(js_name=prepareTextReplace)]
    pub fn prepare_text_replace(
        &self,
        raw: &str,
        desired: &[u8],
    ) -> std::result::Result<WasmMetadataCandidate, JsValue> {
        let run = || -> Result<WasmMetadataCandidate> {
            let input: ReplaceInput = bounded(raw, super::super::MAX_INPUT_BYTES)?;
            let authored = domain(text_v2::plan_replace_text(
                &input.state,
                desired,
                &input.request,
                &input.namespace,
            ))?;
            let candidate = domain(planner::prepare_authored_text_activity(
                &self.state,
                authored.activity(),
                input.next_namespace_version,
            ))?;
            let text = authored.into_plan();
            super::super::reusable_state(&text.expected_state)?;
            super::super::reusable_state(&text.next_state)?;
            Ok(WasmMetadataCandidate {
                candidate,
                emissions: vec![text.authored.payload_bytes.clone()],
                guard: Guard::TextAuthor(text),
                changes: vec![],
                allocated: vec![],
            })
        };
        run().map_err(error)
    }
    pub fn classify(
        &self,
        proof: &WasmVerifiedBinarySet,
        texts_json: &str,
    ) -> std::result::Result<WasmMetadataClassification, JsValue> {
        classify(&self.state, &proof.verified, texts_json).map_err(error)
    }
}
impl WasmMetadataState {
    fn prepare_mutation_inner(&self, raw: &str) -> Result<WasmMetadataCandidate> {
        let input: FamilyPlanInput = bounded(raw, super::super::MAX_INPUT_BYTES)?;
        domain(input.command.validate())?;
        let prepared = domain(metadata_mutation::prepare_mutation(
            &input.command.request,
            &input.entries,
            &self.state,
            input.command.create_mode,
            input.text.as_ref(),
            &input.allocation,
        ))?;
        let (entries, changes, allocated, files, text, candidate) = prepared.into_parts();
        let mut emissions = files
            .into_iter()
            .map(|file| file.payload_bytes)
            .collect::<Vec<_>>();
        if let Some(text) = &text {
            emissions.push(text.plan().authored.payload_bytes.clone());
            super::super::reusable_state(&text.plan().next_state)?;
        }
        Ok(WasmMetadataCandidate {
            candidate,
            guard: Guard::Family { entries, text },
            emissions,
            changes,
            allocated,
        })
    }
}
#[wasm_bindgen]
pub struct WasmMetadataPlan {
    plan: planner::MetadataPlan,
    guard: Guard,
    emissions: Vec<Vec<u8>>,
    changes: Vec<EntryChange>,
    allocated: Vec<UpdateId>,
}
#[wasm_bindgen]
impl WasmMetadataPlan {
    #[wasm_bindgen(js_name=resultJson)]
    pub fn result_json(&self) -> std::result::Result<String, JsValue> {
        json(&value!({"changes":self.changes,"allocated_update_ids":self.allocated,"payload_count":self.emissions.len(),
            "next_text":self.guard.text_state(),"cursor_advance":match &self.guard{Guard::TextReceive(text)=>text.cursor_advance.as_ref(),_=>None},"record_delta_count":self.record_deltas().count(),"activity_delta_count":self.activity_deltas().count(),
            "has_next_state":self.plan.next_state().is_some(),"received_wire":self.plan.received_wire().map(|wire|value!({"scope":wire.scope,"update_id":wire.id}))})).map_err(error)
    }
    #[wasm_bindgen(js_name=nextState)]
    pub fn next_state(&self) -> Option<WasmMetadataState> {
        self.plan.next_state().map(|state| WasmMetadataState {
            state: state.clone(),
        })
    }
    #[wasm_bindgen(js_name=recordDeltaJson)]
    pub fn record_delta_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        let (id, record) = self
            .record_deltas()
            .nth(index(position).map_err(error)?)
            .ok_or_else(|| error("record delta index out of range"))?;
        metadata_json(&value!({"update_id":id,"record":record,"summary_digest":record.summary_digest().map_err(error)?})).map_err(error)
    }
    #[wasm_bindgen(js_name=activityDeltaJson)]
    pub fn activity_delta_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        let (id, activity) = self
            .activity_deltas()
            .nth(index(position).map_err(error)?)
            .ok_or_else(|| error("activity delta index out of range"))?;
        json(&value!({"update_id":id,"activity":activity,"summary_digest":Sha256Digest::of(&serde_json::to_vec(activity).map_err(error)?)})).map_err(error)
    }
    #[wasm_bindgen(js_name=payloadMetadataJson)]
    pub fn payload_metadata_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        emission_metadata(
            self.emissions
                .get(index(position).map_err(error)?)
                .ok_or_else(|| error("payload index out of range"))?,
            &self.guard,
        )
        .map_err(error)
    }
    #[wasm_bindgen(js_name=payloadBytes)]
    pub fn payload_bytes(&self, position: f64) -> std::result::Result<Vec<u8>, JsValue> {
        Ok(self
            .emissions
            .get(index(position).map_err(error)?)
            .ok_or_else(|| error("payload index out of range"))?
            .clone())
    }
    #[wasm_bindgen(js_name=receivedWireBytes)]
    pub fn received_wire_bytes(&self) -> Vec<u8> {
        match &self.guard {
            Guard::TextReceive(text) => text.received_record.exact_wire.clone(),
            _ => self
                .plan
                .received_wire()
                .map(|wire| wire.exact_wire.clone())
                .unwrap_or_default(),
        }
    }
    #[wasm_bindgen(js_name=textBytes)]
    pub fn text_bytes(&self) -> Option<Vec<u8>> {
        self.guard.text_bytes().map(<[u8]>::to_vec)
    }
    #[wasm_bindgen(js_name=checkPreconditions)]
    pub fn check_preconditions(
        &self,
        actual: &WasmMetadataState,
        input: &str,
        prior_wire: &[u8],
    ) -> std::result::Result<(), JsValue> {
        self.check(actual, input, prior_wire).map_err(error)
    }
    pub fn classify(
        &self,
        texts_json: &str,
    ) -> std::result::Result<WasmMetadataClassification, JsValue> {
        classify(
            self.plan.verification_state(),
            self.plan.verified_binaries(),
            texts_json,
        )
        .map_err(error)
    }
}
impl WasmMetadataPlan {
    fn record_deltas(&self) -> impl Iterator<Item = (&UpdateId, &meta::GraphRecord)> {
        self.plan
            .verification_state()
            .records()
            .iter()
            .filter(|(id, record)| self.plan.expected_state().records().get(*id) != Some(*record))
    }
    fn activity_deltas(&self) -> impl Iterator<Item = (&UpdateId, &files::StoredActivity)> {
        self.plan
            .verification_state()
            .activities()
            .iter()
            .filter(|(id, activity)| {
                self.plan.expected_state().activities().get(*id) != Some(*activity)
            })
    }
    fn check(&self, actual: &WasmMetadataState, input: &str, prior_wire: &[u8]) -> Result<()> {
        if prior_wire.len() > zorid_sync_protocol::MAX_WIRE_BYTES {
            return Err("prior wire too large".into());
        }
        // Text receive checks its own exact received record, independent of the
        // graph half (which stores Text activity descriptors, not file wires).
        let previous = if matches!(self.guard, Guard::TextReceive(_)) {
            None
        } else {
            wire(prior_wire, self.plan.expected_wire())?
        };
        domain(
            self.plan
                .check_preconditions(&actual.state, previous.as_ref()),
        )?;
        self.guard.check(input, prior_wire)
    }
}
#[wasm_bindgen]
impl WasmSyncUpdate {
    #[wasm_bindgen(js_name=fileChunkBytes)]
    pub fn file_chunk_bytes(&self) -> Option<Vec<u8>> {
        match &self.family {
            AuthenticatedFamily::Files(file) => match &file.payload().body {
                files::Body::Chunk { bytes } => Some(bytes.clone()),
                _ => None,
            },
            _ => None,
        }
    }
    #[wasm_bindgen(js_name=exactPlaintext)]
    pub fn exact_plaintext(&self) -> Vec<u8> {
        match &self.family {
            AuthenticatedFamily::Text(text) => text.activity().payload_bytes().to_vec(),
            AuthenticatedFamily::Files(file) => file.payload_bytes().to_vec(),
        }
    }
    #[wasm_bindgen(js_name=authenticatedDescriptorJson)]
    pub fn authenticated_descriptor_json(&self) -> std::result::Result<String, JsValue> {
        let run = || -> Result<String> {
            match &self.family {
                AuthenticatedFamily::Files(file) => {
                    let record = domain(meta::GraphRecord::from_authenticated(file))?;
                    metadata_json(
                        &value!({"kind":"files","scope":file.payload().scope,"update_id":file.payload().id,"record":record,"summary_digest":domain(record.summary_digest())?}),
                    )
                }
                AuthenticatedFamily::Text(text) => {
                    let activity = text.activity();
                    let stored = value!({"identity":activity.identity(),"update_id":activity.update_id(),"namespace":activity.namespace(),"payload_bytes":activity.payload_bytes().len(),"payload_digest":Sha256Digest::of(activity.payload_bytes())});
                    let canonical: files::StoredActivity = serde_json::from_value(stored)
                        .map_err(|_| "invalid authenticated activity")?;
                    json(
                        &value!({"kind":"text","activity":canonical,"summary_digest":Sha256Digest::of(&serde_json::to_vec(&canonical).map_err(|_|"invalid activity")?)}),
                    )
                }
            }
        };
        run().map_err(error)
    }
    #[wasm_bindgen(js_name=prepareMetadataFile)]
    pub fn prepare_metadata_file(
        &self,
        state: &WasmMetadataState,
        next_version: &str,
        prior_wire: &[u8],
    ) -> std::result::Result<WasmMetadataCandidate, JsValue> {
        let run = || -> Result<WasmMetadataCandidate> {
            let AuthenticatedFamily::Files(incoming) = &self.family else {
                return Err("wrong sync family".into());
            };
            let previous = wire(prior_wire, Some(incoming.record()))?;
            Ok(WasmMetadataCandidate::plain(domain(
                planner::prepare_received(
                    &state.state,
                    incoming,
                    previous.as_ref(),
                    revision(next_version)?,
                ),
            )?))
        };
        run().map_err(error)
    }
    #[wasm_bindgen(js_name=prepareMetadataText)]
    pub fn prepare_metadata_text(
        &self,
        state: &WasmMetadataState,
        raw: &str,
        prior_wire: &[u8],
    ) -> std::result::Result<WasmMetadataCandidate, JsValue> {
        let run = || -> Result<WasmMetadataCandidate> {
            let AuthenticatedFamily::Text(incoming) = &self.family else {
                return Err("wrong sync family".into());
            };
            if prior_wire.len() > zorid_sync_protocol::MAX_WIRE_BYTES {
                return Err("prior wire too large".into());
            }
            let input: ReceiveInput = bounded(raw, super::super::MAX_INPUT_BYTES)?;
            let prior = if prior_wire.is_empty() {
                None
            } else {
                Some(text::ReceivedRecord {
                    identity: incoming.identity().clone(),
                    update_id: incoming.update_id().clone(),
                    exact_wire: prior_wire.to_vec(),
                })
            };
            let text = domain(text_v2::plan_received_text(
                &input.state,
                &input.request,
                incoming,
                prior.as_ref(),
                input.cursor.as_ref(),
            ))?;
            let candidate = domain(planner::prepare_text_activity(
                &state.state,
                incoming.activity(),
                input.next_namespace_version,
            ))?;
            if prior.is_some() && candidate.next_state().is_some() {
                return Err("received Text/metadata history mismatch".into());
            }
            super::super::reusable_state(&text.expected_state)?;
            if let Some(next) = &text.next_state {
                super::super::reusable_state(next)?;
            }
            Ok(WasmMetadataCandidate {
                candidate,
                guard: Guard::TextReceive(text),
                emissions: vec![],
                changes: vec![],
                allocated: vec![],
            })
        };
        run().map_err(error)
    }
}
#[wasm_bindgen]
pub struct WasmMetadataClassification {
    entries: Vec<classifier::EntryMaterializationRef>,
}
fn classify(
    state: &meta::MetadataState,
    proof: &binary::VerifiedBinarySet,
    raw: &str,
) -> Result<WasmMetadataClassification> {
    let texts: Vec<TextState> = bounded(raw, super::super::MAX_STATE_JSON_BYTES)?;
    if texts.len() > zorid_file_sync::MAX_RECORDS {
        return Err("too many Text states".into());
    }
    Ok(WasmMetadataClassification {
        entries: domain(classifier::classify_metadata(
            state,
            proof,
            &texts,
            zorid_file_sync::MAX_FILE_BYTES,
            8 * 1024 * 1024,
        ))?,
    })
}
pub(super) fn classified_entry(
    entry: &classifier::EntryMaterializationRef,
) -> Result<serde_json::Value> {
    // Build the metadata projection BEFORE serde serialization. In particular,
    // never serialize Text VerifiedContent.bytes only to delete it afterwards.
    use classifier::{ContentRef, OutcomeRef};
    let outcome = match &entry.outcome {
        OutcomeRef::Normal {
            path,
            kind,
            content,
            namespace_heads,
            location_event,
        } => {
            let content = match content {
                None => serde_json::Value::Null,
                Some(ContentRef::Binary(reference)) => {
                    value!({"kind":"binary","content":{"scope":reference.scope(),"entry":reference.entry(),"selected_event":reference.selected_event(),"manifest":manifest_json(reference.manifest())?}})
                }
                Some(ContentRef::Text(text)) => {
                    value!({"kind":"text","content":{"byte_length":text.bytes.len().to_string(),"digest":text.digest,"witness":text.witness}})
                }
            };
            value!({"status":"normal","path":path,"kind":kind,"content":content,"namespace_heads":namespace_heads,"location_event":location_event})
        }
        OutcomeRef::Pending { reason } => {
            let mut reason = serde_json::to_value(reason).map_err(|_| "invalid pending reason")?;
            if let Some(object) = reason.as_object_mut() {
                for key in ["bytes", "limit"] {
                    if let Some(value) = object.get_mut(key) {
                        *value = value!(value.as_u64().ok_or("invalid byte count")?.to_string());
                    }
                }
            }
            value!({"status":"pending","reason":reason})
        }
        OutcomeRef::Recovery { reason } => value!({"status":"recovery","reason":reason}),
        OutcomeRef::Tombstone => value!({"status":"tombstone"}),
    };
    Ok(value!({"identity":entry.identity,"outcome":outcome}))
}
#[wasm_bindgen]
impl WasmMetadataClassification {
    pub fn length(&self) -> usize {
        self.entries.len()
    }
    #[wasm_bindgen(js_name=entryJson)]
    pub fn entry_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        json(
            &classified_entry(
                self.entries
                    .get(index(position).map_err(error)?)
                    .ok_or_else(|| error("classification index out of range"))?,
            )
            .map_err(error)?,
        )
        .map_err(error)
    }
    #[wasm_bindgen(js_name=textBytes)]
    pub fn text_bytes(&self, position: f64) -> std::result::Result<Option<Vec<u8>>, JsValue> {
        let entry = self
            .entries
            .get(index(position).map_err(error)?)
            .ok_or_else(|| error("classification index out of range"))?;
        Ok(match &entry.outcome {
            classifier::OutcomeRef::Normal {
                content: Some(classifier::ContentRef::Text(text)),
                ..
            } => Some(text.bytes.clone()),
            _ => None,
        })
    }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
