//! Bounded browser index transport. Persistence and publication remain host-owned.
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc, sync::Arc};
use wasm_bindgen::prelude::*;
use zorid_core::{EntryId, EntryState};
use zorid_index::{
    document_extraction_version, Exclusion, Generation, GenerationBuilder, IndexError, IndexRecord,
    IndexSnapshotId, LiteralPageBuilder, LiteralQuery, LiteralToken, Manifest, MetadataRequest,
    PersistedIndexRecord, PublicationFence, RelationshipDirection, RelationshipToken,
    ResolutionView, Resolver, SemanticVersions, SourceSnapshotId, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, RESOLVER_VERSION,
};

const MAX_JSON: usize = 16 * 1024 * 1024;
const MAX_TEXT: usize = 16 * 1024 * 1024;
const MAX_TOKENS: usize = 16;
fn error(code: &str) -> JsValue {
    JsValue::from_str(&format!("{{\"code\":\"{code}\"}}"))
}
fn contract(value: IndexError) -> JsValue {
    let code = match value {
        IndexError::StaleSource => "index_source_changed",
        IndexError::StaleIndex => "index_head_changed",
        IndexError::PumpLimit => "index_pump_limit",
        IndexError::GenerationLimit => "index_generation_limit",
        IndexError::SnapshotExpired => "index_snapshot_expired",
        IndexError::QueryMismatch => "index_query_mismatch",
        _ => "index_invalid_record",
    };
    error(code)
}
fn decode<T: serde::de::DeserializeOwned>(input: &str) -> Result<T, JsValue> {
    if input.len() > MAX_JSON {
        return Err(error("index_input_limit"));
    }
    serde_json::from_str(input).map_err(|_| error("index_invalid_record"))
}
fn encode(value: &impl Serialize) -> Result<String, JsValue> {
    let output = serde_json::to_string(value).map_err(|_| error("index_invalid_record"))?;
    if output.len() > MAX_JSON {
        return Err(error("index_output_limit"));
    }
    Ok(output)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    source: SourceSnapshotId,
    entries: Vec<EntryState>,
    expected_index: Option<IndexSnapshotId>,
    next_index: IndexSnapshotId,
}
impl Header {
    fn builder(&self) -> Result<GenerationBuilder, JsValue> {
        let manifest =
            Manifest::new(self.source.clone(), self.entries.clone()).map_err(contract)?;
        let fence = PublicationFence::new(
            self.source.clone(),
            self.expected_index.clone(),
            self.next_index.clone(),
        )
        .map_err(contract)?;
        GenerationBuilder::new(manifest, fence).map_err(contract)
    }
}
#[wasm_bindgen(js_name = documentIndexVersionsJson)]
pub fn document_index_versions_json() -> Result<String, JsValue> {
    encode(
        &SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .map_err(contract)?,
    )
}
#[wasm_bindgen]
pub struct WasmDocumentIndexBuilder {
    header: Header,
    builder: Option<GenerationBuilder>,
}
#[wasm_bindgen]
impl WasmDocumentIndexBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(input: &str) -> Result<Self, JsValue> {
        let header: Header = decode(input)?;
        let builder = header.builder()?;
        Ok(Self {
            header,
            builder: Some(builder),
        })
    }
    #[wasm_bindgen(js_name=headerJson)]
    pub fn header_json(&self) -> Result<String, JsValue> {
        encode(&self.header)
    }
    #[wasm_bindgen(js_name=pendingJson)]
    pub fn pending_json(&self) -> Result<String, JsValue> {
        let builder = self
            .builder
            .as_ref()
            .ok_or_else(|| error("index_builder_closed"))?;
        encode(
            &builder
                .pending_entries()
                .iter()
                .map(|w| w.entry().clone())
                .collect::<Vec<_>>(),
        )
    }
    #[wasm_bindgen(js_name=beginPump)]
    pub fn begin_pump(&mut self) -> Result<(), JsValue> {
        self.builder
            .as_mut()
            .ok_or_else(|| error("index_builder_closed"))?
            .begin_pump();
        Ok(())
    }
    #[wasm_bindgen(js_name=addText)]
    pub fn add_text(&mut self, id: &str, bytes: &[u8]) -> Result<(), JsValue> {
        if bytes.len() > MAX_TEXT {
            return self.add_excluded(id, Exclusion::SourceLimit);
        }
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| error("index_builder_closed"))?;
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let witness = builder.manifest().witness(&id).map_err(contract)?;
        let Ok(source) = std::str::from_utf8(bytes) else {
            return self.add_excluded(id.as_str(), Exclusion::Unreadable);
        };
        let request = MetadataRequest {
            entry_id: id,
            content_revision: witness.entry().revision.clone(),
            source: source.into(),
        };
        let markdown = witness.entry().path.as_str().ends_with(".md");
        // Extraction budget checks must run before parsing.
        builder
            .extract_and_add(witness, &request, markdown)
            .map_err(contract)?;
        Ok(())
    }
    #[wasm_bindgen(js_name=addBinary)]
    pub fn add_binary(&mut self, id: &str) -> Result<(), JsValue> {
        self.add_excluded(id, Exclusion::Binary)
    }
    #[wasm_bindgen(js_name=addUnreadable)]
    pub fn add_unreadable(&mut self, id: &str) -> Result<(), JsValue> {
        self.add_excluded(id, Exclusion::Unreadable)
    }
    #[wasm_bindgen(js_name=addPersisted)]
    pub fn add_persisted(&mut self, id: &str, row: &str) -> Result<(), JsValue> {
        let persisted: PersistedIndexRecord = decode(row)?;
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| error("index_builder_closed"))?;
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let record = persisted
            .restore(builder.manifest().witness(&id).map_err(contract)?)
            .map_err(contract)?;
        builder.add(record).map_err(contract)
    }
    #[wasm_bindgen(js_name=rowJson)]
    pub fn row_json(&self, id: &str) -> Result<String, JsValue> {
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let builder = self
            .builder
            .as_ref()
            .ok_or_else(|| error("index_builder_closed"))?;
        encode(&PersistedIndexRecord::of(
            builder
                .record(&id)
                .ok_or_else(|| error("index_invalid_record"))?,
        ))
    }
    pub fn ready(&self) -> bool {
        self.builder.as_ref().is_some_and(|b| b.ready())
    }
    pub fn finish(&mut self) -> Result<WasmDocumentIndexGeneration, JsValue> {
        let builder = self
            .builder
            .take()
            .ok_or_else(|| error("index_builder_closed"))?;
        let (_, generation) = builder.finish().map_err(contract)?.into_parts();
        Ok(WasmDocumentIndexGeneration {
            header: self.header.clone(),
            generation: Arc::new(generation),
            tokens: Rc::new(RefCell::new(Tokens::default())),
        })
    }
}
impl WasmDocumentIndexBuilder {
    fn add_excluded(&mut self, id: &str, reason: Exclusion) -> Result<(), JsValue> {
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| error("index_builder_closed"))?;
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let record =
            IndexRecord::excluded(builder.manifest().witness(&id).map_err(contract)?, reason);
        builder.add(record).map_err(contract)
    }
}
#[derive(Default)]
struct Tokens {
    counter: u64,
    values: BTreeMap<String, LiteralToken>,
    relationships: BTreeMap<String, RelationshipToken>,
}
#[wasm_bindgen]
pub struct WasmDocumentIndexGeneration {
    header: Header,
    generation: Arc<Generation>,
    tokens: Rc<RefCell<Tokens>>,
}
#[wasm_bindgen]
impl WasmDocumentIndexGeneration {
    #[wasm_bindgen(js_name=headerJson)]
    pub fn header_json(&self) -> Result<String, JsValue> {
        encode(&self.header)
    }
    #[wasm_bindgen(js_name=snapshotJson)]
    pub fn snapshot_json(&self) -> Result<String, JsValue> {
        encode(self.generation.id())
    }
    #[wasm_bindgen(js_name=recordIdsJson)]
    pub fn record_ids_json(&self) -> Result<String, JsValue> {
        encode(
            &self
                .generation
                .records()
                .map(|r| r.witness().entry().id.clone())
                .collect::<Vec<_>>(),
        )
    }
    #[wasm_bindgen(js_name=rowJson)]
    pub fn row_json(&self, id: &str) -> Result<String, JsValue> {
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let record = self
            .generation
            .record(&id)
            .ok_or_else(|| error("index_invalid_record"))?;
        encode(&PersistedIndexRecord::of(record))
    }
    #[wasm_bindgen(js_name=coverageComplete)]
    pub fn coverage_complete(&self) -> bool {
        self.generation.coverage_complete()
    }
    #[wasm_bindgen(js_name=backlinksJson)]
    pub fn backlinks_json(&self, id: &str, token: &str, limit: f64) -> Result<String, JsValue> {
        if !limit.is_finite() || limit.fract() != 0.0 || !(1.0..=1000.0).contains(&limit) {
            return Err(error("index_invalid_budget"));
        }
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let graph = ResolutionView::new(&self.generation)
            .snapshot(100000, MAX_JSON)
            .map_err(contract)?;
        let mut tokens = self.tokens.borrow_mut();
        let token = if token.is_empty() {
            None
        } else {
            Some(
                tokens
                    .relationships
                    .get(token)
                    .ok_or_else(|| error("index_snapshot_expired"))?,
            )
        };
        let page = graph
            .query(&id, RelationshipDirection::Incoming, token, limit as usize)
            .map_err(contract)?;
        let next = if let Some(token) = page.next {
            if tokens.values.len() + tokens.relationships.len() >= MAX_TOKENS {
                return Err(error("index_token_limit"));
            }
            tokens.counter += 1;
            let key = tokens.counter.to_string();
            tokens.relationships.insert(key.clone(), token);
            Some(key)
        } else {
            None
        };
        encode(
            &serde_json::json!({"snapshot":page.snapshot,"edges":page.edges,"next":next,"scanComplete":page.scan_complete,"coverageComplete":page.coverage_complete,"complete":page.complete}),
        )
    }
    #[wasm_bindgen(js_name=resolveJson)]
    pub fn resolve_json(&self, source_id: &str, destination: &str) -> Result<String, JsValue> {
        let id = EntryId::new(source_id).map_err(|_| error("index_invalid_record"))?;
        encode(
            &Resolver::new(self.generation.manifest())
                .candidates(&id, destination)
                .map_err(contract)?,
        )
    }
    #[wasm_bindgen(js_name=openLiteral)]
    pub fn open_literal(
        &self,
        query: &str,
        token: &str,
        limit: f64,
    ) -> Result<WasmDocumentLiteralPage, JsValue> {
        if !limit.is_finite() || limit.fract() != 0.0 || !(1.0..=1000.0).contains(&limit) {
            return Err(error("index_invalid_budget"));
        }
        let tokens = self.tokens.borrow();
        let token = if token.is_empty() {
            None
        } else {
            Some(
                tokens
                    .values
                    .get(token)
                    .ok_or_else(|| error("index_snapshot_expired"))?,
            )
        };
        let page = LiteralPageBuilder::new_shared(
            self.generation.clone(),
            LiteralQuery::new(query).map_err(contract)?,
            token,
            limit as usize,
        )
        .map_err(contract)?;
        Ok(WasmDocumentLiteralPage {
            page: Some(page),
            tokens: self.tokens.clone(),
            result: None,
        })
    }
}
#[wasm_bindgen]
pub struct WasmDocumentLiteralPage {
    page: Option<LiteralPageBuilder<'static>>,
    tokens: Rc<RefCell<Tokens>>,
    result: Option<String>,
}
#[wasm_bindgen]
impl WasmDocumentLiteralPage {
    #[wasm_bindgen(js_name=nextReadJson)]
    pub fn next_read_json(&mut self) -> Result<String, JsValue> {
        let request = self
            .page
            .as_mut()
            .ok_or_else(|| error("index_page_closed"))?
            .next_read();
        encode(&request.as_ref().map(|r| r.entry().clone()))
    }
    pub fn accept(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        let page = self
            .page
            .as_mut()
            .ok_or_else(|| error("index_page_closed"))?;
        let request = page
            .next_read()
            .ok_or_else(|| error("index_invalid_record"))?;
        page.accept(&request, bytes).map_err(contract)
    }
    #[wasm_bindgen(js_name=finishJson)]
    pub fn finish_json(&mut self) -> Result<String, JsValue> {
        if let Some(result) = &self.result {
            return Ok(result.clone());
        }
        let page = self
            .page
            .take()
            .ok_or_else(|| error("index_page_closed"))?
            .finish()
            .map_err(contract)?;
        let next = if let Some(token) = page.next {
            let mut tokens = self.tokens.borrow_mut();
            if tokens.values.len() + tokens.relationships.len() >= MAX_TOKENS {
                return Err(error("index_token_limit"));
            }
            tokens.counter += 1;
            let key = tokens.counter.to_string();
            tokens.values.insert(key.clone(), token);
            Some(key)
        } else {
            None
        };
        let hits=page.hits.into_iter().map(|h|serde_json::json!({"entry":h.entry,"line":h.line,"range":h.range,"snippet":h.snippet,"snippetTruncated":h.snippet_truncated})).collect::<Vec<_>>();
        let result = encode(
            &serde_json::json!({"snapshot":page.snapshot,"hits":hits,"next":next,"scanComplete":page.scan_complete,"coverageComplete":page.coverage_complete,"complete":page.complete,"sourceBytes":page.source_bytes,"documents":page.documents}),
        )?;
        self.result = Some(result.clone());
        Ok(result)
    }
}
