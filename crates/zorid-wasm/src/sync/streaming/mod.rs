//! Additive worker-local streaming bindings. Handles are transient planning data;
//! the host still owns immutable source pins, client admission and atomic commit.
//! No handle or JSON representation is a durable stage/receipt capability.
mod plan;
#[cfg(test)]
mod tests;

use super::{domain, error, json, Result};
use serde::de::DeserializeOwned;
use serde_json::json as value;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;
use zorid_core::Revision;
use zorid_file_sync::{
    binary_stream as binary, metadata as meta, metadata_plan as planner, v2 as files, Scope,
    Sha256Digest,
};
use zorid_sync_protocol::UpdateId;

fn bounded<T: DeserializeOwned>(raw: &str, maximum: usize) -> Result<T> {
    if raw.len() > maximum {
        return Err("stream metadata exceeds binding budget".into());
    }
    serde_json::from_str(raw).map_err(|_| "invalid stream metadata".into())
}
fn index(value: f64) -> Result<usize> {
    crate::checked_u32(value, "index").map(|v| v as usize)
}
fn digest(bytes: &[u8]) -> Result<Sha256Digest> {
    Ok(Sha256Digest(
        bytes
            .try_into()
            .map_err(|_| "digest must contain exactly 32 bytes")?,
    ))
}
fn id(raw: &str) -> Result<UpdateId> {
    domain(UpdateId::new(raw))
}
fn revision(raw: &str) -> Result<Revision> {
    domain(Revision::new(raw))
}
fn control<T: DeserializeOwned>(raw: &str) -> Result<T> {
    bounded(raw, zorid_sync_protocol::MAX_CONTROL_BYTES)
}
fn row<T: DeserializeOwned>(raw: &str) -> Result<T> {
    bounded(raw, meta::MAX_GRAPH_RECORD_BYTES)
}
fn metadata_value(value: &impl serde::Serialize) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(value).map_err(|_| "invalid metadata output")?;
    manifest_lengths(&mut value, false)?;
    Ok(value)
}
fn metadata_json(value: &impl serde::Serialize) -> Result<String> {
    json(&metadata_value(value)?)
}
fn manifest_lengths(value: &mut serde_json::Value, decode: bool) -> Result<()> {
    if let Some(object) = value.as_object_mut() {
        if object.contains_key("pages")
            && object.contains_key("digest")
            && object.contains_key("bytes")
        {
            let convert = |value: &mut serde_json::Value| -> Result<()> {
                if decode {
                    let raw = value
                        .as_str()
                        .ok_or("manifest byte count must be a decimal string")?;
                    if raw.is_empty()
                        || (raw.len() > 1 && raw.starts_with('0'))
                        || !raw.bytes().all(|b| b.is_ascii_digit())
                    {
                        return Err("invalid decimal byte count".into());
                    }
                    *value = value!(raw.parse::<u64>().map_err(|_| "byte count exceeds u64")?);
                } else {
                    *value = value!(value
                        .as_u64()
                        .ok_or("invalid manifest byte count")?
                        .to_string());
                }
                Ok(())
            };
            convert(object.get_mut("bytes").ok_or("missing manifest length")?)?;
            for page in object
                .get_mut("pages")
                .and_then(|p| p.as_array_mut())
                .ok_or("invalid manifest pages")?
            {
                convert(page.get_mut("bytes").ok_or("missing page length")?)?;
            }
        }
        for child in object.values_mut() {
            manifest_lengths(child, decode)?;
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            manifest_lengths(child, decode)?;
        }
    }
    Ok(())
}
fn descriptor(record: &meta::GraphRecord) -> Result<String> {
    metadata_json(record)
}
fn reference(reference: &planner::AuthoredPayloadRef) -> Result<serde_json::Value> {
    Ok(
        value!({"scope":reference.scope(),"update_id":reference.id(),"record":reference.record(),
        "payload_bytes":reference.payload_bytes(),"payload_digest":reference.payload_digest(),"summary_digest":reference.summary_digest()}),
    )
}
// Only u64 byte counts are strings. Chunk sizes/sequences are bounded u32.
fn manifest_json(manifest: &zorid_file_sync::Manifest) -> Result<serde_json::Value> {
    let mut result = serde_json::to_value(manifest).map_err(|_| "invalid manifest")?;
    result["bytes"] = value!(manifest.bytes.to_string());
    for (output, page) in result["pages"]
        .as_array_mut()
        .ok_or("invalid manifest pages")?
        .iter_mut()
        .zip(&manifest.pages)
    {
        output["bytes"] = value!(page.bytes.to_string());
    }
    Ok(result)
}

#[wasm_bindgen]
pub struct WasmMetadataStateBuilder {
    scope: Scope,
    version: Revision,
    records: BTreeMap<UpdateId, meta::GraphRecord>,
    activities: BTreeMap<UpdateId, files::StoredActivity>,
    bytes: usize,
}
impl WasmMetadataStateBuilder {
    fn reserve(&self, id: &UpdateId, size: usize) -> Result<usize> {
        if self.records.contains_key(id) || self.activities.contains_key(id) {
            return Err("duplicate metadata identity".into());
        }
        if self.records.len() + self.activities.len() >= zorid_file_sync::MAX_RECORDS {
            return Err("too many metadata records".into());
        }
        self.bytes
            .checked_add(size)
            .filter(|bytes| *bytes <= zorid_file_sync::MAX_STATE_BYTES)
            .ok_or("metadata state exceeds portable budget".into())
    }
    fn restore_record(
        &mut self,
        key: &str,
        raw: &str,
        length: f64,
        payload: &[u8],
        summary: &[u8],
    ) -> Result<()> {
        let key = id(key)?;
        let length = crate::checked_u32(length, "payload length")?;
        let mut normalized: serde_json::Value = row(raw)?;
        manifest_lengths(&mut normalized, true)?;
        let normalized =
            serde_json::to_string(&normalized).map_err(|_| "invalid metadata record")?;
        let record = domain(meta::GraphRecord::from_persisted_json(
            &normalized,
            length,
            digest(payload)?,
            digest(summary)?,
        ))?;
        let total = self.reserve(&key, raw.len())?;
        self.records.insert(key, record);
        self.bytes = total;
        Ok(())
    }
    fn finish_inner(self) -> Result<WasmMetadataState> {
        Ok(WasmMetadataState {
            state: domain(meta::MetadataState::from_records(
                self.scope,
                self.version,
                self.records,
                self.activities,
            ))?,
        })
    }
}
#[wasm_bindgen]
impl WasmMetadataStateBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(scope_json: &str, version: &str) -> std::result::Result<Self, JsValue> {
        Ok(Self {
            scope: control(scope_json).map_err(error)?,
            version: revision(version).map_err(error)?,
            records: BTreeMap::new(),
            activities: BTreeMap::new(),
            bytes: 0,
        })
    }
    /// Expected commitments must come from the independently checked immutable
    /// ledger, not from the supplied descriptor. This restores metadata only.
    #[wasm_bindgen(js_name=restoreRecord)]
    pub fn restore_record_js(
        &mut self,
        key: &str,
        raw: &str,
        length: f64,
        payload: &[u8],
        summary: &[u8],
    ) -> std::result::Result<(), JsValue> {
        self.restore_record(key, raw, length, payload, summary)
            .map_err(error)
    }
    #[wasm_bindgen(js_name=restoreActivity)]
    pub fn restore_activity(
        &mut self,
        key: &str,
        raw: &str,
        length: f64,
        payload: &[u8],
        summary: &[u8],
    ) -> std::result::Result<(), JsValue> {
        let apply = || -> Result<(UpdateId, files::StoredActivity, usize)> {
            let key = id(key)?;
            let activity: files::StoredActivity = row(raw)?;
            let canonical = serde_json::to_vec(&activity).map_err(|_| "invalid activity")?;
            if activity.update_id() != &key
                || activity.payload_bytes() != crate::checked_u32(length, "payload length")?
                || activity.payload_digest() != &digest(payload)?
                || Sha256Digest::of(&canonical) != digest(summary)?
            {
                return Err("activity differs from immutable ledger commitments".into());
            }
            let total = self.reserve(&key, canonical.len())?;
            Ok((key, activity, total))
        };
        let (key, activity, total) = apply().map_err(error)?;
        self.activities.insert(key, activity);
        self.bytes = total;
        Ok(())
    }
    pub fn finish(self) -> std::result::Result<WasmMetadataState, JsValue> {
        self.finish_inner().map_err(error)
    }
}
#[wasm_bindgen]
pub struct WasmMetadataState {
    state: meta::MetadataState,
}
#[wasm_bindgen]
impl WasmMetadataState {
    #[wasm_bindgen(js_name=metadataHeadJson)]
    pub fn metadata_head_json(&self) -> std::result::Result<String, JsValue> {
        json(&value!({"scope":self.state.scope(),"version":self.state.version(),
            "record_count":self.state.records().len(),"activity_count":self.state.activities().len()})).map_err(error)
    }
    #[wasm_bindgen(js_name=recordId)]
    pub fn record_id(&self, position: f64) -> std::result::Result<String, JsValue> {
        self.state
            .records()
            .keys()
            .nth(index(position).map_err(error)?)
            .map(|id| id.as_str().to_owned())
            .ok_or_else(|| error("record index out of range"))
    }
    #[wasm_bindgen(js_name=recordJson)]
    pub fn record_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        descriptor(
            self.state
                .records()
                .values()
                .nth(index(position).map_err(error)?)
                .ok_or_else(|| error("record index out of range"))?,
        )
        .map_err(error)
    }
    #[wasm_bindgen(js_name=activityId)]
    pub fn activity_id(&self, position: f64) -> std::result::Result<String, JsValue> {
        self.state
            .activities()
            .keys()
            .nth(index(position).map_err(error)?)
            .map(|id| id.as_str().to_owned())
            .ok_or_else(|| error("activity index out of range"))
    }
    #[wasm_bindgen(js_name=activityJson)]
    pub fn activity_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        json(
            self.state
                .activities()
                .values()
                .nth(index(position).map_err(error)?)
                .ok_or_else(|| error("activity index out of range"))?,
        )
        .map_err(error)
    }
    #[wasm_bindgen(js_name=verificationSession)]
    pub fn verification_session(
        &self,
    ) -> std::result::Result<WasmBinaryVerificationSession, JsValue> {
        WasmBinaryVerificationSession::from_state(&self.state).map_err(error)
    }
}
#[wasm_bindgen]
pub struct WasmBinaryBuilder {
    builder: binary::BinaryManifestBuilder,
}
#[wasm_bindgen]
impl WasmBinaryBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(scope_json: &str) -> std::result::Result<Self, JsValue> {
        Ok(Self {
            builder: binary::BinaryManifestBuilder::new(control(scope_json).map_err(error)?),
        })
    }
    #[wasm_bindgen(js_name=pushChunk)]
    pub fn push_chunk(
        &mut self,
        key: &str,
        bytes: &[u8],
    ) -> std::result::Result<WasmAuthoredRecord, JsValue> {
        Ok(WasmAuthoredRecord {
            record: self
                .builder
                .push_chunk(id(key).map_err(error)?, bytes)
                .map_err(error)?,
        })
    }
    #[wasm_bindgen(js_name=flushPage)]
    pub fn flush_page(&mut self, key: &str) -> std::result::Result<WasmAuthoredRecord, JsValue> {
        Ok(WasmAuthoredRecord {
            record: self
                .builder
                .flush_page(id(key).map_err(error)?)
                .map_err(error)?,
        })
    }
    #[wasm_bindgen(js_name=statusJson)]
    pub fn status_json(&self) -> std::result::Result<String, JsValue> {
        json(&value!({"accepted_length":self.builder.accepted_length().to_string(),"pending_chunks":self.builder.pending_chunks()})).map_err(error)
    }
    pub fn finish(self) -> std::result::Result<WasmBuiltManifest, JsValue> {
        Ok(WasmBuiltManifest {
            built: self.builder.finish().map_err(error)?,
        })
    }
}
#[wasm_bindgen]
pub struct WasmBuiltManifest {
    built: binary::BuiltManifest,
}
#[wasm_bindgen]
impl WasmBuiltManifest {
    #[wasm_bindgen(js_name=manifestJson)]
    pub fn manifest_json(&self) -> std::result::Result<String, JsValue> {
        json(&manifest_json(self.built.manifest()).map_err(error)?).map_err(error)
    }
}
#[wasm_bindgen]
pub struct WasmAuthoredRecord {
    record: binary::AuthoredRecord,
}
#[wasm_bindgen]
impl WasmAuthoredRecord {
    #[wasm_bindgen(js_name=descriptorJson)]
    pub fn descriptor_json(&self) -> std::result::Result<String, JsValue> {
        metadata_json(&value!({"scope":self.record.scope(),"update_id":self.record.id(),"record":self.record.record(),
            "summary_digest":self.record.record().summary_digest().map_err(error)?})).map_err(error)
    }
    #[wasm_bindgen(js_name=chunkBytes)]
    pub fn chunk_bytes(&self) -> std::result::Result<Option<Vec<u8>>, JsValue> {
        let payload = files::Payload::decode(self.record.payload_bytes()).map_err(error)?;
        Ok(match payload.body {
            files::Body::Chunk { bytes } => Some(bytes),
            _ => None,
        })
    }
    #[wasm_bindgen(js_name=payloadBytes)]
    pub fn payload_bytes(&self) -> Vec<u8> {
        self.record.payload_bytes().to_vec()
    }
}
#[wasm_bindgen]
pub struct WasmAuthoredMetadataBatch {
    batch: planner::AuthoredMetadataBatch,
}
#[wasm_bindgen]
impl WasmAuthoredMetadataBatch {
    #[wasm_bindgen(constructor)]
    pub fn new(scope_json: &str) -> std::result::Result<Self, JsValue> {
        Ok(Self {
            batch: planner::AuthoredMetadataBatch::new(control(scope_json).map_err(error)?),
        })
    }
    #[wasm_bindgen(js_name=pushRecord)]
    pub fn push_record(
        &mut self,
        record: &WasmAuthoredRecord,
    ) -> std::result::Result<String, JsValue> {
        self.push_payload(record.record.payload_bytes())
    }
    /// Local stage restoration only; this does not authenticate received bytes.
    #[wasm_bindgen(js_name=pushPayload)]
    pub fn push_payload(&mut self, exact: &[u8]) -> std::result::Result<String, JsValue> {
        metadata_json(&reference(&self.batch.push_exact(exact).map_err(error)?).map_err(error)?)
            .map_err(error)
    }
}
#[wasm_bindgen]
pub struct WasmBinaryVerificationSession {
    session: binary::AllBinaryVerificationSession,
}
impl WasmBinaryVerificationSession {
    fn from_state(state: &meta::MetadataState) -> Result<Self> {
        Ok(Self {
            session: domain(binary::AllBinaryVerificationSession::new(state.clone()))?,
        })
    }
    fn provide(&mut self, manifest_index: f64, sequence: f64, exact: &[u8]) -> Result<Vec<u8>> {
        let manifest_index = crate::checked_u32(manifest_index, "manifest index")?;
        let sequence = crate::checked_u32(sequence, "chunk sequence")?;
        let request = domain(self.session.next_chunk())?
            .ok_or("verification has no pending chunk")?
            .clone();
        if request.manifest_index() != manifest_index || request.sequence() != sequence {
            return Err("verification request changed".into());
        }
        // Strict decode derives both commitments from EXACT supplied plaintext.
        // Compare before exposing any raw chunk to the resumable hasher.
        let (scope, key, record) = domain(meta::GraphRecord::from_authored_exact(exact))?;
        if &scope != request.scope() || &key != request.id() || &record != request.expected() {
            return Err("chunk plaintext differs from immutable descriptor".into());
        }
        let payload = domain(files::Payload::decode(exact))?;
        let files::Body::Chunk { bytes } = payload.body else {
            return Err("requested payload is not a chunk".into());
        };
        domain(self.session.provide_chunk(manifest_index, sequence, &bytes))?;
        Ok(bytes)
    }
}
#[wasm_bindgen]
impl WasmBinaryVerificationSession {
    #[wasm_bindgen(js_name=nextChunkJson)]
    pub fn next_chunk_json(&mut self) -> std::result::Result<Option<String>, JsValue> {
        domain(self.session.next_chunk()).and_then(|request|request.map(|r|metadata_json(&value!({"manifest_index":r.manifest_index(),"sequence":r.sequence(),"scope":r.scope(),"update_id":r.id(),"expected":r.expected()}))).transpose()).map_err(error)
    }
    #[wasm_bindgen(js_name=providePayload)]
    pub fn provide_payload(
        &mut self,
        manifest_index: f64,
        sequence: f64,
        exact: &[u8],
    ) -> std::result::Result<Vec<u8>, JsValue> {
        self.provide(manifest_index, sequence, exact).map_err(error)
    }
    pub fn finish(self) -> std::result::Result<WasmVerifiedBinarySet, JsValue> {
        Ok(WasmVerifiedBinarySet {
            verified: self.session.finish().map_err(error)?,
        })
    }
}
/// No constructor, Deserialize, boolean or JSON import can manufacture a proof.
#[wasm_bindgen]
pub struct WasmVerifiedBinarySet {
    verified: binary::VerifiedBinarySet,
}
