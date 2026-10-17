//! A bounded selected-content read plan, not a durable read pin. The browser host
//! owns read IDs, source pins, lease/generation limits and final transaction CAS.
//! Exact-state all-history verification is done once at construction; individual
//! reads verify exact source bytes without retaining/rebuilding the whole graph.
use super::*;
use serde::Deserialize;
use zorid_file_sync::{ChunkRef, EntryIdentity, Manifest};

// Root-approved browser read-plan budget matches its admitted graph chunk cap.
// Out-of-budget references fail explicitly and are never partially exposed.
const MAX_READ_CHUNKS: usize = 2048;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Locator {
    scope: Scope,
    entry: EntryIdentity,
    selected_event: UpdateId,
    manifest: Manifest,
}
struct ReadChunk {
    reference: ChunkRef,
    offset: u64,
    expected: meta::GraphRecord,
}
/// No constructor or JSON proof import. Stores only the selected chunk metadata;
/// it owns no MetadataState, content bytes, authorization token or durable pin.
#[wasm_bindgen]
pub struct WasmBinaryReadPlan {
    scope: Scope,
    length: u64,
    chunks: Vec<ReadChunk>,
}
impl WasmBinaryReadPlan {
    fn open(
        state: &meta::MetadataState,
        proof: &binary::VerifiedBinarySet,
        raw: &str,
    ) -> Result<Self> {
        domain(proof.check_preconditions(state))?;
        let mut normalized: serde_json::Value = row(raw)?;
        manifest_lengths(&mut normalized, true)?;
        let locator: Locator =
            serde_json::from_value(normalized).map_err(|_| "invalid binary content locator")?;
        if &locator.scope != state.scope() {
            return Err("binary content scope differs from state".into());
        }
        // Serialized fields locate historical content; they never substitute
        // for the private proof or authorize an invented/equal-byte causal head.
        let content = domain(state.binary_content_ref(&locator.entry, &locator.selected_event))?;
        if content.scope() != &locator.scope || content.manifest() != &locator.manifest {
            return Err("binary content locator differs from retained event".into());
        }
        let selected = domain(proof.get(content.manifest()))?
            .ok_or("binary content has no verified complete manifest")?;
        domain(selected.check_preconditions(state, content.manifest()))?;
        let mut chunks = Vec::new();
        let mut offset = 0u64;
        for page_ref in &content.manifest().pages {
            let page = state
                .records()
                .get(&page_ref.id)
                .ok_or("verified page descriptor missing")?;
            let meta::GraphRecordBody::Page { page } = page.body() else {
                return Err("verified page descriptor has wrong role".into());
            };
            if domain(page.reference(page_ref.id.clone()))? != *page_ref {
                return Err("verified page differs from manifest reference".into());
            }
            for reference in &page.chunks {
                if chunks.len() >= MAX_READ_CHUNKS {
                    return Err("binary_read_chunk_limit_exceeded".into());
                }
                let expected = state
                    .records()
                    .get(&reference.id)
                    .ok_or("verified chunk descriptor missing")?;
                if !matches!(expected.body(),meta::GraphRecordBody::Chunk{bytes,digest} if *bytes==reference.bytes&&*digest==reference.digest)
                {
                    return Err("verified chunk differs from page reference".into());
                }
                chunks.push(ReadChunk {
                    reference: reference.clone(),
                    offset,
                    expected: expected.clone(),
                });
                offset = offset
                    .checked_add(u64::from(reference.bytes))
                    .ok_or("binary read length overflow")?;
            }
        }
        if offset != content.manifest().bytes {
            return Err("binary read length differs from verified manifest".into());
        }
        Ok(Self {
            scope: state.scope().clone(),
            length: offset,
            chunks,
        })
    }
    fn verify(&self, position: f64, exact: &[u8]) -> Result<Vec<u8>> {
        let chunk = self
            .chunks
            .get(index(position)?)
            .ok_or("binary read index out of range")?;
        let bytes =
            checked_chunk_payload(&self.scope, &chunk.reference.id, &chunk.expected, exact)?;
        if bytes.len() != chunk.reference.bytes as usize
            || Sha256Digest::of(&bytes) != chunk.reference.digest
        {
            return Err("binary read bytes differ from selected chunk reference".into());
        }
        Ok(bytes)
    }
}
#[wasm_bindgen]
impl WasmMetadataState {
    #[wasm_bindgen(js_name=openBinaryRead)]
    pub fn open_binary_read(
        &self,
        proof: &WasmVerifiedBinarySet,
        reference_json: &str,
    ) -> std::result::Result<WasmBinaryReadPlan, JsValue> {
        WasmBinaryReadPlan::open(&self.state, &proof.verified, reference_json).map_err(error)
    }
}
#[wasm_bindgen]
impl WasmBinaryReadPlan {
    pub fn length(&self) -> String {
        self.length.to_string()
    }
    #[wasm_bindgen(js_name=chunkCount)]
    pub fn chunk_count(&self) -> u32 {
        self.chunks.len() as u32
    }
    #[wasm_bindgen(js_name=chunkJson)]
    pub fn chunk_json(&self, position: f64) -> std::result::Result<String, JsValue> {
        let chunk = self
            .chunks
            .get(index(position).map_err(error)?)
            .ok_or_else(|| error("binary read index out of range"))?;
        metadata_json(&value!({"scope":self.scope,"update_id":chunk.reference.id,"offset":chunk.offset.to_string(),"length":chunk.reference.bytes.to_string(),"expected":chunk.expected,"summary_digest":chunk.expected.summary_digest().map_err(error)?})).map_err(error)
    }
    /// Returns one verified chunk only. The owning host must still pin/recheck
    /// the immutable source and never treat this call as a receipt or lease.
    #[wasm_bindgen(js_name=verifyPayload)]
    pub fn verify_payload(
        &self,
        position: f64,
        exact: &[u8],
    ) -> std::result::Result<Vec<u8>, JsValue> {
        self.verify(position, exact).map_err(error)
    }
}
#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, scope, verify};
    use super::*;
    fn locator(state: &meta::MetadataState) -> String {
        let identity = EntryIdentity {
            entry_id: zorid_core::EntryId::new("file").unwrap(),
            bootstrap_id: id("create").unwrap(),
        };
        let reference = state
            .binary_content_ref(&identity, &id("create").unwrap())
            .unwrap();
        json(&value!({"scope":reference.scope(),"entry":reference.entry(),"selected_event":reference.selected_event(),"manifest":manifest_json(reference.manifest()).unwrap()})).unwrap()
    }
    #[test]
    fn selected_read_retains_only_metadata_and_rechecks_every_exact_payload() {
        let (state, payloads) = fixture();
        let proof = verify(&state, &payloads);
        let plan = WasmBinaryReadPlan::open(&state, &proof, &locator(&state)).unwrap();
        drop(proof);
        drop(state);
        assert_eq!(plan.length(), "29");
        assert_eq!(plan.chunk_count(), 1);
        let exact = &payloads[&id("chunk").unwrap()];
        assert_eq!(
            plan.verify(0.0, exact).unwrap(),
            b"binary bytes stay out of JSON"
        );
        let mut padded = b" \n".to_vec();
        padded.extend(exact);
        assert!(plan.verify(0.0, &padded).is_err());
        assert!(plan.verify(0.5, exact).is_err());
        assert!(plan.verify(4294967296.0, exact).is_err());
        let mut corrupt = files::Payload::decode(exact).unwrap();
        if let files::Body::Chunk { bytes } = &mut corrupt.body {
            bytes[0] ^= 1;
        }
        assert!(plan.verify(0.0, &corrupt.encode().unwrap()).is_err());
        assert_eq!(
            plan.verify(0.0, exact).unwrap(),
            b"binary bytes stay out of JSON"
        );
    }
    #[test]
    fn read_locator_and_proof_cannot_substitute_for_selected_state_or_event() {
        let (state, payloads) = fixture();
        let proof = verify(&state, &payloads);
        let raw = locator(&state);
        let empty = meta::MetadataState::empty(scope(), revision("empty").unwrap());
        let other_proof = binary::AllBinaryVerificationSession::new(empty)
            .unwrap()
            .finish()
            .unwrap();
        assert!(WasmBinaryReadPlan::open(&state, &other_proof, &raw).is_err());
        let mut forged: serde_json::Value = serde_json::from_str(&raw).unwrap();
        forged["selected_event"] = value!("page");
        assert!(WasmBinaryReadPlan::open(&state, &proof, &forged.to_string()).is_err());
        let mut forged: serde_json::Value = serde_json::from_str(&raw).unwrap();
        forged["manifest"]["bytes"] = value!("0");
        assert!(WasmBinaryReadPlan::open(&state, &proof, &forged.to_string()).is_err());
        let mut forged: serde_json::Value = serde_json::from_str(&raw).unwrap();
        forged["scope"]["vault_id"] = value!("other");
        assert!(WasmBinaryReadPlan::open(&state, &proof, &forged.to_string()).is_err());
    }
}

#[cfg(test)]
mod history_tests {
    use super::super::tests::{fixture, scope, verify};
    use super::*;
    #[test]
    fn pinned_historical_reference_survives_new_head_and_offsets_remain_bounded() {
        let (old, payloads) = fixture();
        let mut payloads = payloads;
        let identity = EntryIdentity {
            entry_id: zorid_core::EntryId::new("file").unwrap(),
            bootstrap_id: id("create").unwrap(),
        };
        let historical = old
            .binary_content_ref(&identity, &id("create").unwrap())
            .unwrap();
        let old_locator=json(&value!({"scope":historical.scope(),"entry":historical.entry(),"selected_event":historical.selected_event(),"manifest":manifest_json(historical.manifest()).unwrap()})).unwrap();
        let mut builder = binary::BinaryManifestBuilder::new(scope());
        let first = builder
            .push_chunk(
                id("new-first").unwrap(),
                &vec![3; zorid_file_sync::MAX_CHUNK_BYTES],
            )
            .unwrap();
        let tail = builder
            .push_chunk(id("new-tail").unwrap(), b"tail")
            .unwrap();
        let page = builder.flush_page(id("new-page").unwrap()).unwrap();
        let built = builder.finish().unwrap();
        let event = files::Payload {
            family: zorid_file_sync::Family::Files,
            format_version: 2,
            scope: scope(),
            id: id("new-content").unwrap(),
            body: files::Body::Events {
                events: vec![files::EntryEvent {
                    id: id("new-content").unwrap(),
                    identity: identity.clone(),
                    parents: vec![id("create").unwrap()],
                    effect: files::Effect::SetContent {
                        content: built.manifest().clone(),
                    },
                }],
            },
        }
        .encode()
        .unwrap();
        let mut records = old.records().clone();
        for exact in [
            first.payload_bytes(),
            tail.payload_bytes(),
            page.payload_bytes(),
            &event,
        ] {
            let (_, key, record) = meta::GraphRecord::from_authored_exact(exact).unwrap();
            records.insert(key.clone(), record);
            payloads.insert(key, exact.to_vec());
        }
        let state = meta::MetadataState::from_records(
            scope(),
            revision("new-graph").unwrap(),
            records,
            old.activities().clone(),
        )
        .unwrap();
        let proof = verify(&state, &payloads);
        let old_plan = WasmBinaryReadPlan::open(&state, &proof, &old_locator).unwrap();
        assert_eq!(
            old_plan
                .verify(0.0, &payloads[&id("chunk").unwrap()])
                .unwrap(),
            b"binary bytes stay out of JSON"
        );
        let selected = state
            .binary_content_ref(&identity, &id("new-content").unwrap())
            .unwrap();
        let locator=json(&value!({"scope":selected.scope(),"entry":selected.entry(),"selected_event":selected.selected_event(),"manifest":manifest_json(selected.manifest()).unwrap()})).unwrap();
        let plan = WasmBinaryReadPlan::open(&state, &proof, &locator).unwrap();
        assert_eq!(plan.chunk_count(), 2);
        assert_eq!(plan.length(), "131076");
        let second: serde_json::Value =
            serde_json::from_str(&plan.chunk_json(1.0).unwrap()).unwrap();
        assert_eq!(second["offset"], "131072");
        assert_eq!(second["length"], "4");
        assert_eq!(
            plan.verify(1.0, &payloads[&id("new-tail").unwrap()])
                .unwrap(),
            b"tail"
        );
    }
}
