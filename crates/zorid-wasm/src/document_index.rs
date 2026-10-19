//! Bounded browser index transport. Persistence and publication remain host-owned.
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc, sync::Arc};
use wasm_bindgen::prelude::*;
use zorid_core::{EntryId, EntryState};
use zorid_index::{
    document_extraction_version, extract_content, parse_cache_admission, ContentExtractionKey,
    ContentExtractionOutcome, ContentExtractionResult, EntryWitness, Exclusion, ExtractionDomain,
    ExtractionMode, ExtractionScope, Generation, GenerationBuilder, IndexError, IndexRecord,
    IndexSnapshotId, LiteralPageBuilder, LiteralQuery, LiteralToken, Manifest, MetadataRequest,
    ParseCacheOutcome, ParseCacheUsage, PersistedIndexRecord, PublicationFence,
    RelationshipDirection, RelationshipToken, ResolutionView, Resolver, SemanticVersions,
    SourceSnapshotId, FACTS_ENCODING_VERSION, INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION,
    MAX_PARSE_CACHE_BYTES, MAX_PARSE_CACHE_EVICTIONS_PER_WRITE, MAX_PARSE_CACHE_ROWS,
    MAX_PARSE_CACHE_ROW_BYTES, RESOLVER_VERSION,
};

const MAX_JSON: usize = 16 * 1024 * 1024;
const MAX_TEXT: usize = 16 * 1024 * 1024;
const MAX_TOKENS: usize = 16;
fn error(code: &str) -> JsValue {
    JsValue::from_str(&format!("{{\"code\":\"{code}\"}}"))
}
fn contract_code(value: &IndexError) -> &'static str {
    match value {
        IndexError::StaleSource => "index_source_changed",
        IndexError::StaleIndex => "index_head_changed",
        IndexError::PumpLimit => "index_pump_limit",
        IndexError::GenerationLimit => "index_generation_limit",
        IndexError::SnapshotExpired => "index_snapshot_expired",
        IndexError::QueryMismatch => "index_query_mismatch",
        IndexError::InvalidQuery => "index_invalid_query",
        IndexError::InvalidBudget => "index_invalid_budget",
        IndexError::InvalidTarget => "index_invalid_target",
        IndexError::MissingSource => "index_missing_source",
        IndexError::NoProgress => "index_no_progress",
        // A persisted projection/record/version failure cannot invalidate raw
        // source. Surface the shared explicit derived-cache rebuild category.
        _ => "index_rebuild_required",
    }
}
fn contract(value: IndexError) -> JsValue {
    error(contract_code(&value))
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
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtractionKeyDescriptor {
    key: ContentExtractionKey,
    storage_key: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseCachePolicy {
    format_version: u32,
    max_rows: usize,
    max_bytes: usize,
    max_row_bytes: usize,
    max_evictions_per_write: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedTextAdmission {
    outcome: ParseCacheOutcome,
    added: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedTextAdmission {
    payload: Option<String>,
    added: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParseCacheAdmissionRequest {
    usage: ParseCacheUsage,
    replaced_payload_bytes: Option<usize>,
    incoming_payload_bytes: usize,
    evicted_rows: usize,
}
#[wasm_bindgen(js_name = documentParseCachePolicyJson)]
pub fn document_parse_cache_policy_json() -> Result<String, JsValue> {
    encode(&ParseCachePolicy {
        format_version: FACTS_ENCODING_VERSION,
        max_rows: MAX_PARSE_CACHE_ROWS,
        max_bytes: MAX_PARSE_CACHE_BYTES,
        max_row_bytes: MAX_PARSE_CACHE_ROW_BYTES,
        max_evictions_per_write: MAX_PARSE_CACHE_EVICTIONS_PER_WRITE,
    })
}
#[wasm_bindgen(js_name = documentParseCacheAdmissionJson)]
pub fn document_parse_cache_admission_json(input: &str) -> Result<String, JsValue> {
    let request: ParseCacheAdmissionRequest = decode(input)?;
    encode(
        &parse_cache_admission(
            request.usage,
            request.replaced_payload_bytes,
            request.incoming_payload_bytes,
            request.evicted_rows,
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
        let markdown = witness
            .entry()
            .path
            .as_str()
            .to_ascii_lowercase()
            .ends_with(".md");
        // Extraction budget checks must run before parsing.
        builder
            .extract_and_add(witness, &request, markdown)
            .map_err(contract)?;
        Ok(())
    }
    /// The host has already validated captured descriptor/actual bytes. This
    /// key is content-derived only; final source/publication fencing still runs.
    #[wasm_bindgen(js_name=cacheKeyJson)]
    pub fn cache_key_json(&self, id: &str, bytes: &[u8]) -> Result<String, JsValue> {
        let (witness, scope, mode) = self.extraction_context(id)?;
        self.builder
            .as_ref()
            .ok_or_else(|| error("index_builder_closed"))?
            .preflight_extraction(&witness, bytes.len())
            .map_err(contract)?;
        let descriptor = if bytes.len() > MAX_TEXT {
            None
        } else if let Ok(source) = std::str::from_utf8(bytes) {
            if source.contains('\0') {
                None
            } else {
                let key =
                    ContentExtractionKey::for_source(scope, mode, source).map_err(contract)?;
                Some(ExtractionKeyDescriptor {
                    storage_key: key.storage_key().map_err(contract)?,
                    key,
                })
            }
        } else {
            None
        };
        encode(&descriptor)
    }
    /// A bounded optional-cache decode cannot alter a builder until shared Rust
    /// key/version/checksum/structure validation and contextual binding succeed.
    #[wasm_bindgen(js_name=addCachedText)]
    pub fn add_cached_text(
        &mut self,
        id: &str,
        expected: &str,
        payload: &str,
    ) -> Result<String, JsValue> {
        let descriptor: ExtractionKeyDescriptor = decode(expected)?;
        let (witness, scope, mode) = self.extraction_context(id)?;
        if descriptor.key.scope() != &scope
            || descriptor.key.mode() != mode
            || descriptor.storage_key != descriptor.key.storage_key().map_err(contract)?
        {
            return Err(error("index_source_changed"));
        }
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| error("index_builder_closed"))?;
        builder
            .preflight_extraction(&witness, descriptor.key.source_bytes())
            .map_err(contract)?;
        if payload.len() > MAX_PARSE_CACHE_ROW_BYTES {
            return encode(&CachedTextAdmission {
                outcome: ParseCacheOutcome::Corrupt,
                added: false,
            });
        }
        let cached: ContentExtractionResult = match serde_json::from_str(payload) {
            Ok(value) => value,
            Err(_) => {
                return encode(&CachedTextAdmission {
                    outcome: ParseCacheOutcome::Corrupt,
                    added: false,
                })
            }
        };
        let record = match cached.bind(&descriptor.key, witness, mode) {
            Ok(record) => record,
            Err(IndexError::InvalidVersion) => {
                return encode(&CachedTextAdmission {
                    outcome: ParseCacheOutcome::Unsupported,
                    added: false,
                })
            }
            Err(_) => {
                return encode(&CachedTextAdmission {
                    outcome: ParseCacheOutcome::Corrupt,
                    added: false,
                })
            }
        };
        let added = match builder.add(record) {
            Ok(()) => true,
            Err(IndexError::PumpLimit) => false,
            Err(value) => return Err(contract(value)),
        };
        encode(&CachedTextAdmission {
            outcome: ParseCacheOutcome::Hit,
            added,
        })
    }
    /// A miss and a rejected optional cache use the same pure extractor once.
    /// Oversized supported facts remain indexable but return no cache payload.
    #[wasm_bindgen(js_name=extractText)]
    pub fn extract_text(&mut self, id: &str, bytes: &[u8]) -> Result<String, JsValue> {
        let (witness, scope, mode) = self.extraction_context(id)?;
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| error("index_builder_closed"))?;
        builder
            .preflight_extraction(&witness, bytes.len())
            .map_err(contract)?;
        if bytes.len() > MAX_TEXT {
            builder
                .add(IndexRecord::excluded(witness, Exclusion::SourceLimit))
                .map_err(contract)?;
            return encode(&ExtractedTextAdmission {
                payload: None,
                added: true,
            });
        }
        let Some(source) = std::str::from_utf8(bytes).ok() else {
            builder
                .add(IndexRecord::excluded(witness, Exclusion::Unreadable))
                .map_err(contract)?;
            return encode(&ExtractedTextAdmission {
                payload: None,
                added: true,
            });
        };
        let (record, payload) = match extract_content(scope, mode, source).map_err(contract)? {
            ContentExtractionOutcome::Extracted(result) => {
                let payload =
                    if result.encoded_size().map_err(contract)? <= MAX_PARSE_CACHE_ROW_BYTES {
                        Some(
                            serde_json::to_string(&result)
                                .map_err(|_| error("index_invalid_record"))?,
                        )
                    } else {
                        None
                    };
                let key = result.key().clone();
                (result.bind(&key, witness, mode).map_err(contract)?, payload)
            }
            ContentExtractionOutcome::Excluded(reason) => {
                (IndexRecord::excluded(witness, reason), None)
            }
        };
        let added = match builder.add(record) {
            Ok(()) => true,
            Err(IndexError::PumpLimit) => false,
            Err(value) => return Err(contract(value)),
        };
        encode(&ExtractedTextAdmission { payload, added })
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
    fn extraction_context(
        &self,
        id: &str,
    ) -> Result<(EntryWitness, ExtractionScope, ExtractionMode), JsValue> {
        let builder = self
            .builder
            .as_ref()
            .ok_or_else(|| error("index_builder_closed"))?;
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let witness = builder.manifest().witness(&id).map_err(contract)?;
        let mode = if witness
            .entry()
            .path
            .as_str()
            .to_ascii_lowercase()
            .ends_with(".md")
        {
            ExtractionMode::Markdown
        } else {
            ExtractionMode::PlainText
        };
        let scope = ExtractionScope::new(
            ExtractionDomain::DocumentIndex,
            self.header.source.local_store_id().clone(),
        );
        Ok((witness, scope, mode))
    }
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
impl Tokens {
    fn reserve(&mut self) -> Result<String, JsValue> {
        // Bound retained continuations, not lifetime page count. Explicitly
        // expire the oldest opaque token while preserving forward progress.
        if self.values.len() + self.relationships.len() >= MAX_TOKENS {
            let oldest = self
                .values
                .keys()
                .chain(self.relationships.keys())
                .filter_map(|k| k.parse::<u64>().ok())
                .min()
                .ok_or_else(|| error("index_invalid_record"))?
                .to_string();
            self.values.remove(&oldest);
            self.relationships.remove(&oldest);
        }
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| error("index_token_limit"))?;
        Ok(self.counter.to_string())
    }
    fn literal(&mut self, token: LiteralToken) -> Result<String, JsValue> {
        if let Some((key, _)) = self.values.iter().find(|(_, value)| **value == token) {
            return Ok(key.clone());
        }
        let key = self.reserve()?;
        self.values.insert(key.clone(), token);
        Ok(key)
    }
    fn relationship(&mut self, token: RelationshipToken) -> Result<String, JsValue> {
        if let Some((key, _)) = self
            .relationships
            .iter()
            .find(|(_, value)| **value == token)
        {
            return Ok(key.clone());
        }
        let key = self.reserve()?;
        self.relationships.insert(key.clone(), token);
        Ok(key)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryReport<'a, T: Serialize> {
    snapshot: &'a IndexSnapshotId,
    source: &'a SourceSnapshotId,
    coverage_complete: bool,
    value: T,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataRead<'a> {
    entry: &'a EntryState,
    metadata: Option<&'a zorid_index::MetadataProjection>,
    exclusion: Option<&'a Exclusion>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BaseRead<'a> {
    definition: &'a EntryState,
    result: zorid_bases::BaseQueryResult,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct BaseReadOptions {
    view_index: Option<usize>,
    search_terms: Vec<String>,
    ignore_paths: Vec<String>,
    clock_ms: Option<i64>,
    timezone: Option<String>,
    max_rows: Option<usize>,
    #[serde(default, deserialize_with = "present_option")]
    current_entry_id: Option<EntryId>,
    #[serde(default, deserialize_with = "present_option")]
    max_steps: Option<usize>,
}
fn present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
fn base_error(code: &str, diagnostic: &impl Serialize) -> JsValue {
    JsValue::from_str(
        &serde_json::to_string(&serde_json::json!({"code":code,"diagnostic":diagnostic}))
            .unwrap_or_else(|_| "{\"code\":\"index_invalid_record\"}".into()),
    )
}
// Session-owned pure data, deliberately separate from each admitted generation.
// Its TTL clock comes from the browser host, never a query's evaluation clock.
#[wasm_bindgen]
pub struct WasmDocumentIndexPreparationCache {
    inner: zorid_bases::BasePreparationCache,
}
#[wasm_bindgen]
impl WasmDocumentIndexPreparationCache {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: zorid_bases::BasePreparationCache::new(),
        }
    }
    pub fn clear(&mut self) {
        self.inner.clear();
    }
    #[wasm_bindgen(js_name=baseJson)]
    pub fn base_json(
        &mut self,
        generation: &WasmDocumentIndexGeneration,
        id: &str,
        bytes: &[u8],
        facts_json: &str,
        options_json: &str,
        monotonic_ms: f64,
        view_name: Option<String>,
    ) -> Result<String, JsValue> {
        let clock = checked_monotonic_ms(monotonic_ms).map_err(error)?;
        base_report(
            generation,
            id,
            bytes,
            facts_json,
            options_json,
            view_name,
            Some((&mut self.inner, clock)),
        )
    }
}
impl Default for WasmDocumentIndexPreparationCache {
    fn default() -> Self {
        Self::new()
    }
}
fn checked_monotonic_ms(value: f64) -> Result<u64, &'static str> {
    // A JS number must be lossless before conversion; no wasm integer coercion.
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=9007199254740991.0).contains(&value) {
        return Err("index_invalid_budget");
    }
    Ok(value as u64)
}
#[derive(Debug)]
enum BaseReadError {
    Code(&'static str),
    Index(IndexError),
    Compile(zorid_bases::BaseCompileError),
    Evaluation(zorid_bases::ExpressionDiagnostic),
}
impl BaseReadError {
    fn js(self) -> JsValue {
        match self {
            Self::Code(code) => error(code),
            Self::Index(value) => contract(value),
            Self::Compile(value) => base_error("index_base_compile", &value),
            Self::Evaluation(value) => base_error("index_base_evaluation", &value),
        }
    }
}
#[derive(Debug)]
#[cfg_attr(not(test), allow(dead_code))]
struct BaseOutcomes {
    program: zorid_bases::PreparationCacheOutcome,
    preparation: zorid_bases::PreparationCacheOutcome,
    answer: zorid_bases::PreparationCacheOutcome,
}
fn base_query_options(
    input: BaseReadOptions,
    view_name: Option<&str>,
    program: &zorid_bases::BaseProgram,
) -> Result<zorid_bases::QueryOptions, BaseReadError> {
    let mut options = zorid_bases::QueryOptions::default();
    if let Some(index) = input.view_index {
        options.view_index = index;
    }
    if let Some(name) = view_name {
        options.view_index = program
            .view_index_by_name(name)
            .ok_or(BaseReadError::Code("index_view_not_found"))?;
    }
    options.current_entry_id = input.current_entry_id;
    if let Some(steps) = input.max_steps {
        options.max_steps = steps;
    }
    options.search_terms = input.search_terms;
    options.ignore_paths = input.ignore_paths;
    if let Some(clock) = input.clock_ms {
        options.evaluation.clock_ms = clock;
    }
    if let Some(timezone) = input.timezone {
        options.evaluation.timezone = timezone;
    }
    if let Some(rows) = input.max_rows {
        options.max_rows = rows;
    }
    Ok(options)
}
fn evaluate_base<'a>(
    generation: &'a Generation,
    id: &EntryId,
    bytes: &[u8],
    facts: &[zorid_bases::FilePresentationFacts],
    input: BaseReadOptions,
    view_name: Option<&str>,
    mut cache: Option<(&mut zorid_bases::BasePreparationCache, u64)>,
) -> Result<(BaseRead<'a>, Option<BaseOutcomes>), BaseReadError> {
    let record = generation
        .record(id)
        .ok_or(BaseReadError::Code("index_missing_source"))?;
    // A cached program or generation is no proof of source admission. Even a
    // warm query must recheck this exact retained definition and UTF8 first.
    record.check_text(bytes).map_err(BaseReadError::Index)?;
    let source =
        std::str::from_utf8(bytes).map_err(|_| BaseReadError::Code("index_source_unavailable"))?;
    // Keep the sealed lookup until answer evaluation: an Arc alone does not
    // carry the current cache owner's dependency provenance.
    let compiled = if let Some((cache, clock)) = cache.as_mut() {
        Some(
            cache
                .compile_source(source, *clock)
                .map_err(BaseReadError::Compile)?,
        )
    } else {
        None
    };
    let program = match &compiled {
        Some(lookup) => Arc::clone(lookup.value()),
        None => Arc::new(zorid_bases::compile_base_source(source).map_err(BaseReadError::Compile)?),
    };
    // Current invocation options are always admitted. The shared cache decides
    // whether an exact answer can be reused, including clock dependencies.
    let options = base_query_options(input, view_name, &program)?;
    let (result, outcomes) = if let Some((cache, clock)) = cache {
        let prepared = cache
            .prepare_generation(generation, facts, &options, clock)
            .map_err(BaseReadError::Evaluation)?;
        let compiled = compiled.as_ref().expect("cached program");
        let answer = cache
            .query_prepared_cached(compiled, &prepared, &options, clock)
            .map_err(BaseReadError::Evaluation)?;
        let outcomes = BaseOutcomes {
            program: compiled.outcome(),
            preparation: prepared.outcome(),
            answer: answer.outcome(),
        };
        (answer.into_value(), Some(outcomes))
    } else {
        (
            zorid_bases::query_generation(&program, generation, facts, &options)
                .map_err(BaseReadError::Evaluation)?,
            None,
        )
    };
    // The generation is immutable; keep the source fence explicit on both paths.
    record.check_text(bytes).map_err(BaseReadError::Index)?;
    Ok((
        BaseRead {
            definition: record.witness().entry(),
            result,
        },
        outcomes,
    ))
}
fn base_report(
    generation: &WasmDocumentIndexGeneration,
    id: &str,
    bytes: &[u8],
    facts_json: &str,
    options_json: &str,
    view_name: Option<String>,
    cache: Option<(&mut zorid_bases::BasePreparationCache, u64)>,
) -> Result<String, JsValue> {
    if bytes.len() > 262144 || facts_json.len() > 8 * 1024 * 1024 || options_json.len() > 65536 {
        return Err(error("index_input_limit"));
    }
    let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
    let facts: Vec<zorid_bases::FilePresentationFacts> = decode(facts_json)?;
    let input: BaseReadOptions = decode(options_json)?;
    let (read, _) = evaluate_base(
        &generation.generation,
        &id,
        bytes,
        &facts,
        input,
        view_name.as_deref(),
        cache,
    )
    .map_err(BaseReadError::js)?;
    generation.report(read)
}

// Selectors carry only lossless retained source text. Witnesses and paths are
// always recovered from this generation, never accepted from the caller.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskSource {
    id: EntryId,
    source: String,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskReadOptions {
    #[serde(default, deserialize_with = "present_option")]
    filter: Option<zorid_bases::tasks::TaskFilter>,
    #[serde(default, deserialize_with = "present_option")]
    clock_ms: Option<i64>,
    #[serde(default, deserialize_with = "present_option")]
    timezone: Option<String>,
    #[serde(default, deserialize_with = "present_option")]
    show_done: Option<bool>,
    #[serde(default, deserialize_with = "present_option")]
    max_rows: Option<usize>,
}
impl TaskReadOptions {
    fn options(self) -> zorid_bases::tasks::TaskQueryOptions {
        let mut options = zorid_bases::tasks::TaskQueryOptions::default();
        if let Some(value) = self.filter {
            options.filter = value;
        }
        if let Some(value) = self.clock_ms {
            options.clock_ms = value;
        }
        if let Some(value) = self.timezone {
            options.timezone = value;
        }
        if let Some(value) = self.show_done {
            options.show_done = value;
        }
        if let Some(value) = self.max_rows {
            options.max_rows = value;
        }
        options
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TasksRead {
    definitions: Vec<EntryState>,
    types: Vec<zorid_bases::types::TaskTypeSummary>,
    result: zorid_bases::tasks::TaskQueryResult,
}
#[derive(Debug)]
enum TaskReadError {
    Index(IndexError),
    Limit,
    Duplicate,
    Compile(zorid_bases::ExpressionDiagnostic),
    Evaluation(zorid_bases::ExpressionDiagnostic),
}
impl TaskReadError {
    fn js(self) -> JsValue {
        match self {
            Self::Index(error) => contract(error),
            Self::Limit => error("index_input_limit"),
            Self::Duplicate => error("index_invalid_request"),
            Self::Compile(diagnostic) => base_error("index_type_compile", &diagnostic),
            Self::Evaluation(diagnostic) => base_error("index_task_evaluation", &diagnostic),
        }
    }
}
fn read_tasks(
    generation: &Generation,
    projections: Vec<TaskSource>,
    options: &zorid_bases::tasks::TaskQueryOptions,
) -> Result<TasksRead, TaskReadError> {
    use zorid_bases::types::{
        compile_type_yaml, task_type_summaries, TypeYamlSource, MAX_TYPE_BYTES, MAX_TYPE_SOURCES,
        MAX_TYPE_SOURCE_BYTES,
    };
    if projections.len() > MAX_TYPE_SOURCES {
        return Err(TaskReadError::Limit);
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0usize;
    let mut sources = Vec::with_capacity(projections.len());
    let mut definitions = Vec::with_capacity(projections.len());
    for projection in projections {
        if !seen.insert(projection.id.clone()) {
            return Err(TaskReadError::Duplicate);
        }
        total = total
            .checked_add(projection.source.len())
            .ok_or(TaskReadError::Limit)?;
        if projection.source.len() > MAX_TYPE_SOURCE_BYTES || total > MAX_TYPE_BYTES {
            return Err(TaskReadError::Limit);
        }
        let record = generation
            .record(&projection.id)
            .ok_or(TaskReadError::Index(IndexError::MissingSource))?;
        record
            .check_text(projection.source.as_bytes())
            .map_err(TaskReadError::Index)?;
        let entry = record.witness().entry().clone();
        sources.push(TypeYamlSource {
            witness: zorid_bases::RecordWitness {
                entry_id: entry.id.clone(),
                revision: entry.revision.clone(),
            },
            path: entry.path.to_string(),
            source: projection.source,
        });
        definitions.push(entry);
    }
    let registry = compile_type_yaml(sources).map_err(TaskReadError::Compile)?;
    let result = zorid_bases::tasks::query_tasks(generation, &registry, options)
        .map_err(TaskReadError::Evaluation)?;
    let types = task_type_summaries(&registry).map_err(TaskReadError::Compile)?;
    Ok(TasksRead {
        definitions,
        types,
        result,
    })
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
            Some(tokens.relationship(token)?)
        } else {
            None
        };
        encode(
            &serde_json::json!({"snapshot":page.snapshot,"edges":page.edges,"next":next,"scanComplete":page.scan_complete,"coverageComplete":page.coverage_complete,"complete":page.complete}),
        )
    }
    #[wasm_bindgen(js_name=metadataJson)]
    pub fn metadata_json(&self, id: &str) -> Result<String, JsValue> {
        let id = EntryId::new(id).map_err(|_| error("index_invalid_record"))?;
        let record = self
            .generation
            .record(&id)
            .ok_or_else(|| error("index_missing_source"))?;
        self.report(MetadataRead {
            entry: record.witness().entry(),
            metadata: record.metadata(),
            exclusion: record.exclusion(),
        })
    }
    #[wasm_bindgen(js_name=tasksJson)]
    pub fn tasks_json(&self, sources_json: &str, options_json: &str) -> Result<String, JsValue> {
        // JSON escaping can expand the bounded 1 MiB source payload sixfold.
        if sources_json.len() > 7 * 1024 * 1024 || options_json.len() > 4096 {
            return Err(error("index_input_limit"));
        }
        let sources: Vec<TaskSource> = decode(sources_json)?;
        let options: TaskReadOptions = decode(options_json)?;
        self.report(
            read_tasks(&self.generation, sources, &options.options()).map_err(TaskReadError::js)?,
        )
    }
    #[wasm_bindgen(js_name=baseJson)]
    pub fn base_json(
        &self,
        id: &str,
        bytes: &[u8],
        facts_json: &str,
        options_json: &str,
        view_name: Option<String>,
    ) -> Result<String, JsValue> {
        base_report(self, id, bytes, facts_json, options_json, view_name, None)
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
impl WasmDocumentIndexGeneration {
    fn report<T: Serialize>(&self, value: T) -> Result<String, JsValue> {
        // Keep recursive source-map insertion order by avoiding generic Value.
        encode(&QueryReport {
            snapshot: self.generation.id(),
            source: self.generation.manifest().source(),
            coverage_complete: self.generation.coverage_complete(),
            value,
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
            Some(tokens.literal(token)?)
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

#[cfg(test)]
mod tests {
    use super::*;
    fn header() -> String {
        let versions: serde_json::Value =
            serde_json::from_str(&document_index_versions_json().unwrap()).unwrap();
        serde_json::json!({
            "source":{"localStoreId":"store","watermark":"7"},
            "entries":[
                {"id":"a","path":"a.md","kind":"file","revision":"r1","deleted":false},
                {"id":"b","path":"b.md","kind":"file","revision":"r2","deleted":false}
            ],
            "expectedIndex":null,
            "nextIndex":{"localStoreId":"store","generationEpoch":"epoch","generation":"1","versions":versions}
        }).to_string()
    }
    #[test]
    fn incremental_transport_extracts_and_restores_same_rust_generation() {
        let header = header();
        let mut builder = WasmDocumentIndexBuilder::new(&header).unwrap();
        builder.begin_pump().unwrap();
        builder
            .add_text("a", b"---\ntitle: Original\n---\n# Header\n[[b]]\nneedle\n")
            .unwrap();
        let a = builder.row_json("a").unwrap();
        builder.add_text("b", b"target\n").unwrap();
        let b = builder.row_json("b").unwrap();
        let generation = builder.finish().unwrap();
        let mut restored = WasmDocumentIndexBuilder::new(&header).unwrap();
        restored.add_persisted("a", &a).unwrap();
        restored.add_persisted("b", &b).unwrap();
        let restored = restored.finish().unwrap();
        assert_eq!(
            generation.snapshot_json().unwrap(),
            restored.snapshot_json().unwrap()
        );
        assert_eq!(
            generation.row_json("a").unwrap(),
            restored.row_json("a").unwrap()
        );
        let backlinks: serde_json::Value =
            serde_json::from_str(&restored.backlinks_json("b", "", 10.0).unwrap()).unwrap();
        assert_eq!(backlinks["edges"].as_array().unwrap().len(), 1);
        assert_eq!(backlinks["edges"][0]["source"]["id"], "a");
        assert_eq!(backlinks["complete"], true);
    }
    #[test]
    fn owned_literal_page_keeps_generation_alive_and_reads_one_projection_at_a_time() {
        let mut builder = WasmDocumentIndexBuilder::new(&header()).unwrap();
        builder.add_text("a", b"needle\n").unwrap();
        builder.add_binary("b").unwrap();
        let generation = builder.finish().unwrap();
        let mut page = generation.open_literal("needle", "", 1.0).unwrap();
        drop(generation); // Arc in the owned portable page retains exact facts.
        let request: serde_json::Value =
            serde_json::from_str(&page.next_read_json().unwrap()).unwrap();
        assert_eq!(request["id"], "a");
        page.accept(b"needle\n").unwrap();
        let first = page.finish_json().unwrap();
        assert_eq!(first, page.finish_json().unwrap());
        let report: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(report["hits"][0]["entry"]["id"], "a");
        assert_eq!(report["hits"][0]["line"], 0);
    }
    #[test]
    fn pagination_continues_beyond_retained_token_capacity_and_uppercase_markdown_is_extracted() {
        let mut h: serde_json::Value = serde_json::from_str(&header()).unwrap();
        h["entries"][0]["path"] = serde_json::json!("A.MD");
        let source = format!("# Heading\n{}", "needle\n".repeat(24));
        let mut builder = WasmDocumentIndexBuilder::new(&h.to_string()).unwrap();
        builder.add_text("a", source.as_bytes()).unwrap();
        builder.add_binary("b").unwrap();
        let row: serde_json::Value = serde_json::from_str(&builder.row_json("a").unwrap()).unwrap();
        assert_eq!(row["metadata"]["headings"][0]["text"], "Heading");
        let generation = builder.finish().unwrap();
        let mut token = String::new();
        let mut hits = 0;
        loop {
            let mut page = generation.open_literal("needle", &token, 1.0).unwrap();
            if page.next_read_json().unwrap() != "null" {
                page.accept(source.as_bytes()).unwrap();
            }
            let report: serde_json::Value =
                serde_json::from_str(&page.finish_json().unwrap()).unwrap();
            hits += report["hits"].as_array().unwrap().len();
            if let Some(next) = report["next"].as_str() {
                token = next.into();
            } else {
                break;
            }
        }
        assert_eq!(hits, 24);
    }
    #[test]
    fn metadata_and_base_use_the_same_owned_generation_and_retained_definition() {
        let mut h: serde_json::Value = serde_json::from_str(&header()).unwrap();
        h["entries"].as_array_mut().unwrap().push(serde_json::json!({"id":"base","path":"Links.base","kind":"file","revision":"r3","deleted":false}));
        let definition=b"filters: file.hasLink(\"b\")\nviews:\n  - type: table\n    name: Links\n    order: [file.path]\n";
        let mut builder = WasmDocumentIndexBuilder::new(&h.to_string()).unwrap();
        builder
            .add_text(
                "a",
                b"---\ntitle: Original\nobject: {z: 1, a: 2}\n---\n[[b]]\n",
            )
            .unwrap();
        builder.add_text("b", b"target\n").unwrap();
        builder.add_text("base", definition).unwrap();
        let generation = builder.finish().unwrap();
        let metadata_raw = generation.metadata_json("a").unwrap();
        assert!(metadata_raw.contains("{\"z\":1,\"a\":2}"));
        let metadata: serde_json::Value = serde_json::from_str(&metadata_raw).unwrap();
        assert_eq!(metadata["source"]["watermark"], "7");
        assert_eq!(
            metadata["value"]["metadata"]["properties"][0]["value"],
            "Original"
        );
        let facts=serde_json::json!([{"witness":{"entryId":"a","revision":"r1"},"size":33,"ctimeMs":1,"mtimeMs":2}]).to_string();
        let report: serde_json::Value = serde_json::from_str(
            &generation
                .base_json("base", definition, &facts, "{}", Some("Links".into()))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(report["snapshot"], metadata["snapshot"]);
        assert_eq!(report["value"]["definition"]["revision"], "r3");
        assert_eq!(
            report["value"]["result"]["rows"].as_array().unwrap().len(),
            1
        );
        assert_eq!(report["value"]["result"]["rows"][0]["entryId"], "a");
    }
    fn base_generation(definition: &[u8]) -> WasmDocumentIndexGeneration {
        let mut h: serde_json::Value = serde_json::from_str(&header()).unwrap();
        h["entries"].as_array_mut().unwrap().push(serde_json::json!({"id":"base","path":"Links.base","kind":"file","revision":"r3","deleted":false}));
        let mut builder = WasmDocumentIndexBuilder::new(&h.to_string()).unwrap();
        builder
            .add_text("a", b"---\ntitle: Original\n---\n[[b]]\n")
            .unwrap();
        builder.add_text("b", b"target\n").unwrap();
        builder.add_text("base", definition).unwrap();
        builder.finish().unwrap()
    }
    const BASE_DEFINITION: &[u8] = b"filters: file.hasLink(\"b\")\nformulas:\n  selected: this.file.path\n  clock: now()\nviews:\n  - type: table\n    name: Links\n    order: [file.path, formula.selected, formula.clock]\n  - type: table\n    name: Paths\n    order: [file.path]\n";
    fn base_input(clock: i64, current: &str) -> BaseReadOptions {
        serde_json::from_value(
            serde_json::json!({"clockMs":clock,"timezone":"UTC","currentEntryId":current}),
        )
        .unwrap()
    }
    #[test]
    fn preparation_cache_reuses_fresh_generations_and_reruns_current_invocation() {
        use zorid_bases::PreparationCacheOutcome::{Hit, Miss};
        let id = EntryId::new("base").unwrap();
        let mut owner = WasmDocumentIndexPreparationCache::new();
        let first = base_generation(BASE_DEFINITION);
        let (_, outcomes) = evaluate_base(
            &first.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            Some("Links"),
            Some((&mut owner.inner, 100)),
        )
        .unwrap();
        assert_eq!(
            outcomes.map(|o| (o.program, o.preparation)),
            Some((Miss, Miss))
        );
        drop(first); // Closing a pin does not close the session-owned pure cache.
        let fresh = base_generation(BASE_DEFINITION);
        let (warm, outcomes) = evaluate_base(
            &fresh.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(86400000, "b"),
            Some("Links"),
            Some((&mut owner.inner, 101)),
        )
        .unwrap();
        assert_eq!(
            outcomes.map(|o| (o.program, o.preparation)),
            Some((Hit, Hit))
        );
        let (cold, _) = evaluate_base(
            &fresh.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(86400000, "b"),
            Some("Links"),
            None,
        )
        .unwrap();
        let mut actual = warm.result;
        actual.steps_used = 0;
        let mut expected = cold.result;
        expected.steps_used = 0;
        assert_eq!(actual, expected);
        let (other, outcomes) = evaluate_base(
            &fresh.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            Some("Paths"),
            Some((&mut owner.inner, 102)),
        )
        .unwrap();
        assert_eq!(
            outcomes.map(|o| (o.program, o.preparation)),
            Some((Hit, Hit))
        );
        let (cold, _) = evaluate_base(
            &fresh.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            Some("Paths"),
            None,
        )
        .unwrap();
        let mut actual = other.result;
        actual.steps_used = 0;
        let mut expected = cold.result;
        expected.steps_used = 0;
        assert_eq!(actual, expected);
    }
    #[test]
    fn preparation_cache_wrapper_preserves_base_report_envelope() {
        let generation = base_generation(BASE_DEFINITION);
        let mut owner = WasmDocumentIndexPreparationCache::new();
        let mut cached: serde_json::Value = serde_json::from_str(
            &owner
                .base_json(
                    &generation,
                    "base",
                    BASE_DEFINITION,
                    "[]",
                    "{}",
                    0.0,
                    Some("Links".into()),
                )
                .unwrap(),
        )
        .unwrap();
        let mut cold: serde_json::Value = serde_json::from_str(
            &generation
                .base_json("base", BASE_DEFINITION, "[]", "{}", Some("Links".into()))
                .unwrap(),
        )
        .unwrap();
        cached["value"]["result"]["stepsUsed"] = serde_json::json!(0);
        cold["value"]["result"]["stepsUsed"] = serde_json::json!(0);
        assert_eq!(cached, cold);
    }
    #[test]
    fn preparation_cache_warm_source_admission_budget_and_expiry_remain_independent() {
        use zorid_bases::PreparationCacheOutcome::{Hit, Miss};
        let id = EntryId::new("base").unwrap();
        let generation = base_generation(BASE_DEFINITION);
        let mut owner = WasmDocumentIndexPreparationCache::new();
        evaluate_base(
            &generation.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            None,
            Some((&mut owner.inner, 1)),
        )
        .unwrap();
        let mut changed = BASE_DEFINITION.to_vec();
        changed[0] = b'F';
        assert!(matches!(
            evaluate_base(
                &generation.generation,
                &id,
                &changed,
                &[],
                base_input(0, "a"),
                None,
                Some((&mut owner.inner, 2))
            ),
            Err(BaseReadError::Index(_))
        ));
        assert!(matches!(
            evaluate_base(
                &generation.generation,
                &id,
                &[255],
                &[],
                base_input(0, "a"),
                None,
                Some((&mut owner.inner, 2))
            ),
            Err(BaseReadError::Index(_))
        ));
        let mut tiny = base_input(0, "a");
        tiny.max_steps = Some(1);
        assert!(matches!(
            evaluate_base(
                &generation.generation,
                &id,
                BASE_DEFINITION,
                &[],
                tiny,
                None,
                Some((&mut owner.inner, 2))
            ),
            Err(BaseReadError::Evaluation(_))
        ));
        let (_, outcomes) = evaluate_base(
            &generation.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            None,
            Some((&mut owner.inner, 3)),
        )
        .unwrap();
        assert_eq!(
            outcomes.map(|o| (o.program, o.preparation)),
            Some((Hit, Hit))
        );
        // TTL is explicit monotonic host time; unchanged evaluation time cannot
        // keep an idle entry alive. Backwards host time expires optional data.
        let (_, outcomes) = evaluate_base(
            &generation.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            None,
            Some((&mut owner.inner, 300003)),
        )
        .unwrap();
        assert_eq!(
            outcomes.map(|o| (o.program, o.preparation)),
            Some((Miss, Miss))
        );
        let (_, outcomes) = evaluate_base(
            &generation.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            None,
            Some((&mut owner.inner, 1)),
        )
        .unwrap();
        assert_eq!(
            outcomes.map(|o| (o.program, o.preparation)),
            Some((Miss, Miss))
        );
        owner.clear();
        let (_, outcomes) = evaluate_base(
            &generation.generation,
            &id,
            BASE_DEFINITION,
            &[],
            base_input(0, "a"),
            None,
            Some((&mut owner.inner, 2)),
        )
        .unwrap();
        assert_eq!(
            outcomes.map(|o| (o.program, o.preparation)),
            Some((Miss, Miss))
        );
    }
    const ANSWER_DEFINITION: &[u8] = b"filters: file.hasLink(\"b\")\nformulas:\n  selected: this.file.path\nviews:\n  - type: table\n    name: Links\n    order: [file.path, formula.selected]\n  - type: table\n    name: Paths\n    order: [file.path]\n";
    fn same_base_semantics(
        mut actual: zorid_bases::BaseQueryResult,
        mut expected: zorid_bases::BaseQueryResult,
    ) {
        // Work is a modeled semantic charge; all result data remain identical.
        actual.steps_used = 0;
        expected.steps_used = 0;
        assert_eq!(actual, expected);
    }
    #[test]
    fn answer_cache_crosses_fresh_generation_wrappers_with_unchanged_report() {
        use zorid_bases::PreparationCacheOutcome::{Hit, Miss};
        let id = EntryId::new("base").unwrap();
        let mut owner = WasmDocumentIndexPreparationCache::new();
        let first = base_generation(ANSWER_DEFINITION);
        let (seed, outcome) = evaluate_base(
            &first.generation,
            &id,
            ANSWER_DEFINITION,
            &[],
            base_input(0, "a"),
            Some("Links"),
            Some((&mut owner.inner, 10)),
        )
        .unwrap();
        assert_eq!(outcome.unwrap().answer, Miss);
        let tight_ceiling = seed.result.steps_used;
        drop(first);
        let fresh = base_generation(ANSWER_DEFINITION);
        let (warm, outcome) = evaluate_base(
            &fresh.generation,
            &id,
            ANSWER_DEFINITION,
            &[],
            base_input(86400000, "a"),
            Some("Links"),
            Some((&mut owner.inner, 11)),
        )
        .unwrap();
        let outcome = outcome.unwrap();
        assert_eq!(
            (outcome.program, outcome.preparation, outcome.answer),
            (Hit, Hit, Hit)
        );
        let (cold, _) = evaluate_base(
            &fresh.generation,
            &id,
            ANSWER_DEFINITION,
            &[],
            base_input(86400000, "a"),
            Some("Links"),
            None,
        )
        .unwrap();
        same_base_semantics(warm.result, cold.result);
        // The current ceiling is itself part of the exact answer key. Seed
        // that tight-valid invocation, then prove its second call can hit.
        let mut tight = base_input(86400000, "a");
        tight.max_steps = Some(tight_ceiling);
        evaluate_base(
            &fresh.generation,
            &id,
            ANSWER_DEFINITION,
            &[],
            tight,
            Some("Links"),
            Some((&mut owner.inner, 12)),
        )
        .unwrap();
        let mut tight = base_input(86400000, "a");
        tight.max_steps = Some(tight_ceiling);
        let (warm, outcome) = evaluate_base(
            &fresh.generation,
            &id,
            ANSWER_DEFINITION,
            &[],
            tight,
            Some("Links"),
            Some((&mut owner.inner, 12)),
        )
        .unwrap();
        assert_eq!(outcome.unwrap().answer, Hit);
        let mut tight = base_input(86400000, "a");
        tight.max_steps = Some(tight_ceiling);
        let (cold, _) = evaluate_base(
            &fresh.generation,
            &id,
            ANSWER_DEFINITION,
            &[],
            tight,
            Some("Links"),
            None,
        )
        .unwrap();
        same_base_semantics(warm.result, cold.result);
        let mut cached: serde_json::Value = serde_json::from_str(
            &owner
                .base_json(
                    &fresh,
                    "base",
                    ANSWER_DEFINITION,
                    "[]",
                    r#"{"clockMs":86400000,"currentEntryId":"a"}"#,
                    13.0,
                    Some("Links".into()),
                )
                .unwrap(),
        )
        .unwrap();
        let mut cold: serde_json::Value = serde_json::from_str(
            &fresh
                .base_json(
                    "base",
                    ANSWER_DEFINITION,
                    "[]",
                    r#"{"clockMs":86400000,"currentEntryId":"a"}"#,
                    Some("Links".into()),
                )
                .unwrap(),
        )
        .unwrap();
        cached["value"]["result"]["stepsUsed"] = serde_json::json!(0);
        cold["value"]["result"]["stepsUsed"] = serde_json::json!(0);
        assert_eq!(cached, cold);
    }
    #[test]
    fn answer_cache_preserves_current_view_clock_source_and_budget_admission() {
        use zorid_bases::PreparationCacheOutcome::Hit;
        let id = EntryId::new("base").unwrap();
        let generation = base_generation(BASE_DEFINITION);
        let mut owner = WasmDocumentIndexPreparationCache::new();
        for clock in 0..2 {
            let (_, outcome) = evaluate_base(
                &generation.generation,
                &id,
                BASE_DEFINITION,
                &[],
                base_input(0, "a"),
                Some("Links"),
                Some((&mut owner.inner, clock)),
            )
            .unwrap();
            if clock == 1 {
                assert_eq!(outcome.unwrap().answer, Hit);
            }
        }
        for (clock, current, view) in [
            (86400000, "a", "Links"),
            (0, "b", "Links"),
            (0, "a", "Paths"),
        ] {
            let (actual, outcome) = evaluate_base(
                &generation.generation,
                &id,
                BASE_DEFINITION,
                &[],
                base_input(clock, current),
                Some(view),
                Some((&mut owner.inner, 3)),
            )
            .unwrap();
            assert_ne!(outcome.unwrap().answer, Hit);
            let (expected, _) = evaluate_base(
                &generation.generation,
                &id,
                BASE_DEFINITION,
                &[],
                base_input(clock, current),
                Some(view),
                None,
            )
            .unwrap();
            same_base_semantics(actual.result, expected.result);
        }
        let mut changed = BASE_DEFINITION.to_vec();
        changed[0] = b'F';
        assert!(matches!(
            evaluate_base(
                &generation.generation,
                &id,
                &changed,
                &[],
                base_input(0, "a"),
                Some("Links"),
                Some((&mut owner.inner, 4))
            ),
            Err(BaseReadError::Index(_))
        ));
        for cached in [false, true] {
            let mut tiny = base_input(0, "a");
            tiny.max_steps = Some(1);
            let cache = if cached {
                Some((&mut owner.inner, 5))
            } else {
                None
            };
            assert!(matches!(
                evaluate_base(
                    &generation.generation,
                    &id,
                    BASE_DEFINITION,
                    &[],
                    tiny,
                    Some("Links"),
                    cache
                ),
                Err(BaseReadError::Evaluation(_))
            ));
        }
    }
    #[test]
    fn answer_cache_expiry_clear_and_changed_definition_never_reuse_old_answer() {
        use zorid_bases::PreparationCacheOutcome::{Hit, Miss};
        let id = EntryId::new("base").unwrap();
        let generation = base_generation(ANSWER_DEFINITION);
        let mut owner = WasmDocumentIndexPreparationCache::new();
        for (clock, expected) in [(0, Miss), (1, Hit), (300001, Miss), (0, Miss)] {
            let (_, outcome) = evaluate_base(
                &generation.generation,
                &id,
                ANSWER_DEFINITION,
                &[],
                base_input(0, "a"),
                Some("Links"),
                Some((&mut owner.inner, clock)),
            )
            .unwrap();
            assert_eq!(outcome.unwrap().answer, expected);
        }
        owner.clear();
        let (_, outcome) = evaluate_base(
            &generation.generation,
            &id,
            ANSWER_DEFINITION,
            &[],
            base_input(0, "a"),
            Some("Links"),
            Some((&mut owner.inner, 1)),
        )
        .unwrap();
        assert_eq!(outcome.unwrap().answer, Miss);
        let changed = String::from_utf8(ANSWER_DEFINITION.to_vec())
            .unwrap()
            .replace("file.hasLink(\"b\")", "true");
        let fresh = base_generation(changed.as_bytes());
        let (actual, outcome) = evaluate_base(
            &fresh.generation,
            &id,
            changed.as_bytes(),
            &[],
            base_input(0, "a"),
            Some("Links"),
            Some((&mut owner.inner, 2)),
        )
        .unwrap();
        let outcome = outcome.unwrap();
        assert_eq!(
            (outcome.program, outcome.preparation, outcome.answer),
            (Miss, Miss, Miss)
        );
        let (expected, _) = evaluate_base(
            &fresh.generation,
            &id,
            changed.as_bytes(),
            &[],
            base_input(0, "a"),
            Some("Links"),
            None,
        )
        .unwrap();
        same_base_semantics(actual.result, expected.result);
        let facts: Vec<zorid_bases::FilePresentationFacts> =
            serde_json::from_value(serde_json::json!([{
                "witness":{"entryId":"a","revision":"r1"},"size":42,"ctimeMs":0,"mtimeMs":1
            }]))
            .unwrap();
        let (actual, outcome) = evaluate_base(
            &fresh.generation,
            &id,
            changed.as_bytes(),
            &facts,
            base_input(0, "a"),
            Some("Links"),
            Some((&mut owner.inner, 3)),
        )
        .unwrap();
        let outcome = outcome.unwrap();
        assert_eq!(
            (outcome.program, outcome.preparation, outcome.answer),
            (Hit, Miss, Miss)
        );
        let (expected, _) = evaluate_base(
            &fresh.generation,
            &id,
            changed.as_bytes(),
            &facts,
            base_input(0, "a"),
            Some("Links"),
            None,
        )
        .unwrap();
        same_base_semantics(actual.result, expected.result);
    }
    #[test]
    fn preparation_cache_portable_clock_rejects_lossy_js_numbers() {
        assert_eq!(checked_monotonic_ms(0.0), Ok(0));
        assert_eq!(
            checked_monotonic_ms(9007199254740991.0),
            Ok(9007199254740991)
        );
        for value in [-1.0, 0.5, f64::NAN, f64::INFINITY, 9007199254740992.0] {
            assert_eq!(checked_monotonic_ms(value), Err("index_invalid_budget"));
        }
    }
    fn task_generation(type_source: &str, task: &str) -> WasmDocumentIndexGeneration {
        let mut h: serde_json::Value = serde_json::from_str(&header()).unwrap();
        h["entries"][0]["path"] = serde_json::json!("Task.yaml");
        let mut builder = WasmDocumentIndexBuilder::new(&h.to_string()).unwrap();
        builder.add_text("a", type_source.as_bytes()).unwrap();
        builder.add_text("b", task.as_bytes()).unwrap();
        builder.finish().unwrap()
    }
    fn task_source(source: &str) -> Vec<TaskSource> {
        vec![TaskSource {
            id: EntryId::new("a").unwrap(),
            source: source.into(),
        }]
    }
    #[test]
    fn tasks_use_retained_yaml_and_metadata_witnesses_with_date_only_today_and_reopen() {
        let yaml = include_str!("../../../tests/fixtures/tasks/task-type.json");
        let generation = task_generation(yaml, "---\ntype: type-task\nstate: active\nplan: 2026-10-18\ndue: 2026-10-17\n---\nTask body\n");
        let options = r#"{"filter":"today","clockMs":1792324800000,"timezone":"America/Toronto"}"#;
        let sources = serde_json::json!([{"id":"a","source":yaml}]).to_string();
        let raw = generation.tasks_json(&sources, options).unwrap();
        let report: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(report["snapshot"], report["value"]["result"]["snapshotId"]);
        assert_eq!(report["value"]["definitions"][0]["revision"], "r1");
        assert_eq!(report["value"]["definitions"][0]["path"], "Task.yaml");
        assert_eq!(report["value"]["types"][0]["witness"]["entryId"], "a");
        assert_eq!(
            report["value"]["result"]["typeWitnesses"][0]["revision"],
            "r1"
        );
        assert_eq!(
            report["value"]["result"]["rows"][0]["witness"]["revision"],
            "r2"
        );
        assert_eq!(
            report["value"]["result"]["rows"][0]["plannedDay"],
            "2026-10-18"
        );
        let mut restored =
            WasmDocumentIndexBuilder::new(&generation.header_json().unwrap()).unwrap();
        restored
            .add_persisted("a", &generation.row_json("a").unwrap())
            .unwrap();
        restored
            .add_persisted("b", &generation.row_json("b").unwrap())
            .unwrap();
        assert_eq!(
            restored
                .finish()
                .unwrap()
                .tasks_json(&sources, options)
                .unwrap(),
            raw
        );
    }
    #[test]
    fn tasks_today_uses_explicit_timezone_without_shifting_date_only_fields() {
        let yaml = include_str!("../../../tests/fixtures/tasks/task-type.json");
        let generation = task_generation(yaml, "---\ntype: type-task\nplan: 2026-10-18\n---\n");
        let mut options = zorid_bases::tasks::TaskQueryOptions::default();
        options.filter = zorid_bases::tasks::TaskFilter::Today;
        options.clock_ms = 1792290600000; // Oct 18 02:30 UTC, still Oct 17 in Toronto.
        options.timezone = "America/Toronto".into();
        let local = read_tasks(&generation.generation, task_source(yaml), &options).unwrap();
        assert!(local.result.rows.is_empty());
        options.timezone = "UTC".into();
        let utc = read_tasks(&generation.generation, task_source(yaml), &options).unwrap();
        assert_eq!(utc.result.rows.len(), 1);
        assert_eq!(
            utc.result.rows[0].planned_day.as_deref(),
            Some("2026-10-18")
        );
    }
    #[test]
    fn tasks_reject_detached_sources_duplicates_binary_and_byte_budgets() {
        let yaml = include_str!("../../../tests/fixtures/tasks/task-type.json");
        let generation = task_generation(yaml, "---\ntype: type-task\n---\n");
        let options = zorid_bases::tasks::TaskQueryOptions::default();
        assert!(matches!(
            read_tasks(&generation.generation, task_source("version: 1"), &options),
            Err(TaskReadError::Index(IndexError::ContentMismatch))
        ));
        let mut duplicate = task_source(yaml);
        duplicate.extend(task_source(yaml));
        assert!(matches!(
            read_tasks(&generation.generation, duplicate, &options),
            Err(TaskReadError::Duplicate)
        ));
        assert!(matches!(
            read_tasks(
                &generation.generation,
                task_source(&"x".repeat(256 * 1024 + 1)),
                &options
            ),
            Err(TaskReadError::Limit)
        ));
        let sources = (0..129)
            .map(|_| TaskSource {
                id: EntryId::new("a").unwrap(),
                source: yaml.into(),
            })
            .collect();
        assert!(matches!(
            read_tasks(&generation.generation, sources, &options),
            Err(TaskReadError::Limit)
        ));
        let mut missing = task_source(yaml);
        missing[0].id = EntryId::new("missing").unwrap();
        assert!(matches!(
            read_tasks(&generation.generation, missing, &options),
            Err(TaskReadError::Index(IndexError::MissingSource))
        ));
        let mut binary = WasmDocumentIndexBuilder::new(&header()).unwrap();
        binary.add_binary("a").unwrap();
        binary.add_binary("b").unwrap();
        assert!(matches!(
            read_tasks(
                &binary.finish().unwrap().generation,
                task_source(yaml),
                &options
            ),
            Err(TaskReadError::Index(_))
        ));
    }
    #[test]
    fn malformed_task_yaml_is_retained_diagnostic_and_options_decode_strictly() {
        let yaml = "properties: [\n";
        let generation = task_generation(yaml, "---\ntype: type-task\n---\n");
        let report = read_tasks(
            &generation.generation,
            task_source(yaml),
            &zorid_bases::tasks::TaskQueryOptions::default(),
        )
        .unwrap();
        assert!(report.types.is_empty());
        assert!(report.result.rows.is_empty());
        assert!(!report.result.coverage_complete);
        assert_eq!(report.result.type_diagnostics[0].code, "invalid_type_yaml");
        assert_eq!(
            report.result.type_diagnostics[0].witness.revision.as_str(),
            "r1"
        );
        for raw in [
            r#"{"filter":null}"#,
            r#"{"clockMs":null}"#,
            r#"{"showDone":null}"#,
            r#"{"maxRows":null}"#,
            r#"{"timezone":null}"#,
            r#"{"filter":"checkboxes"}"#,
            r#"{"clockMs":0,"clockMs":1}"#,
            r#"{"configuration":{}}"#,
        ] {
            assert!(
                serde_json::from_str::<TaskReadOptions>(raw).is_err(),
                "{raw}"
            );
        }
        assert!(serde_json::from_str::<TaskReadOptions>("{}").is_ok());
        assert!(
            serde_json::from_str::<TaskSource>(r#"{"id":"a","source":"x","witness":{}}"#).is_err()
        );
    }
    #[test]
    fn corrupted_projection_and_cached_versions_request_derived_rebuild_only() {
        assert_eq!(
            contract_code(&IndexError::ContentMismatch),
            "index_rebuild_required"
        );
        assert_eq!(
            contract_code(&IndexError::InvalidRecord),
            "index_rebuild_required"
        );
        assert_eq!(
            contract_code(&IndexError::InvalidVersion),
            "index_rebuild_required"
        );
        assert_eq!(
            contract_code(&IndexError::InvalidQuery),
            "index_invalid_query"
        );
    }
    #[test]
    fn base_read_selector_and_steps_reject_present_null_and_duplicate_fields() {
        let defaults: BaseReadOptions = serde_json::from_str("{}").unwrap();
        assert!(defaults.current_entry_id.is_none());
        assert!(defaults.max_steps.is_none());
        for raw in [
            r#"{"currentEntryId":null}"#,
            r#"{"maxSteps":null}"#,
            r#"{"currentEntryId":"one","currentEntryId":"two"}"#,
            r#"{"maxSteps":1,"maxSteps":2}"#,
        ] {
            assert!(
                serde_json::from_str::<BaseReadOptions>(raw).is_err(),
                "{raw}"
            );
        }
    }
    #[test]
    fn cache_transport_rebinds_identity_free_facts_and_preserves_legacy_rows() {
        let source = b"---\ntitle: Same\n---\n# Shared\n[[b]]\nneedle\n";
        let mut builder = WasmDocumentIndexBuilder::new(&header()).unwrap();
        let a_key = builder.cache_key_json("a", source).unwrap();
        let extracted: serde_json::Value =
            serde_json::from_str(&builder.extract_text("a", source).unwrap()).unwrap();
        assert_eq!(extracted["added"], true);
        let payload = extracted["payload"].as_str().unwrap();
        assert!(!payload.contains("entryId"));
        assert!(!payload.contains("contentRevision"));
        let b_key = builder.cache_key_json("b", source).unwrap();
        assert_eq!(a_key, b_key);
        let hit: serde_json::Value =
            serde_json::from_str(&builder.add_cached_text("b", &b_key, payload).unwrap()).unwrap();
        assert_eq!(hit, serde_json::json!({"outcome":"hit","added":true}));
        let row: serde_json::Value = serde_json::from_str(&builder.row_json("b").unwrap()).unwrap();
        assert_eq!(row["metadata"]["entryId"], "b");
        assert_eq!(row["metadata"]["contentRevision"], "r2");
        let generation = builder.finish().unwrap();
        let mut reopened = WasmDocumentIndexBuilder::new(&header()).unwrap();
        reopened
            .add_persisted("a", &generation.row_json("a").unwrap())
            .unwrap();
        reopened
            .add_persisted("b", &generation.row_json("b").unwrap())
            .unwrap();
        assert!(reopened.ready());
        assert_eq!(
            reopened.row_json("b").unwrap(),
            generation.row_json("b").unwrap()
        );
    }
    #[test]
    fn cache_transport_rejects_corrupt_versions_modes_and_other_store_facts() {
        let source = b"# Original\nneedle\n";
        let mut origin = WasmDocumentIndexBuilder::new(&header()).unwrap();
        let extracted: serde_json::Value =
            serde_json::from_str(&origin.extract_text("a", source).unwrap()).unwrap();
        let payload = extracted["payload"].as_str().unwrap();
        for kind in ["checksum", "version", "mode", "scope", "oversized"] {
            let mut h: serde_json::Value = serde_json::from_str(&header()).unwrap();
            if kind == "mode" {
                h["entries"][0]["path"] = "a.txt".into();
            }
            if kind == "scope" {
                h["source"]["localStoreId"] = "other".into();
                h["nextIndex"]["localStoreId"] = "other".into();
            }
            let mut builder = WasmDocumentIndexBuilder::new(&h.to_string()).unwrap();
            let key = builder.cache_key_json("a", source).unwrap();
            let mut value: serde_json::Value = serde_json::from_str(payload).unwrap();
            if kind == "checksum" {
                value["facts"]["facts"]["headings"][0]["text"] = "Changed".into();
            }
            if kind == "version" {
                value["key"]["factsEncodingVersion"] = 999.into();
            }
            let modified = if kind == "oversized" {
                " ".repeat(MAX_PARSE_CACHE_ROW_BYTES + 1)
            } else {
                value.to_string()
            };
            let outcome: serde_json::Value =
                serde_json::from_str(&builder.add_cached_text("a", &key, &modified).unwrap())
                    .unwrap();
            assert_eq!(
                outcome["outcome"],
                if kind == "version" {
                    "unsupported"
                } else {
                    "corrupt"
                },
                "{kind}"
            );
            assert_eq!(outcome["added"], false);
            assert_eq!(
                builder.pending_json().unwrap().contains("\"id\":\"a\""),
                true
            );
            let fresh: serde_json::Value =
                serde_json::from_str(&builder.extract_text("a", source).unwrap()).unwrap();
            assert_eq!(fresh["added"], true);
            let row: serde_json::Value =
                serde_json::from_str(&builder.row_json("a").unwrap()).unwrap();
            if kind == "mode" {
                assert!(row["metadata"].is_null());
            } else {
                assert_eq!(row["metadata"]["entryId"], "a");
            }
        }
    }
    #[test]
    fn oversized_supported_facts_skip_optional_cache_without_excluding_the_source() {
        let source = format!("# {}\n", "x".repeat(MAX_PARSE_CACHE_ROW_BYTES));
        let mut builder = WasmDocumentIndexBuilder::new(&header()).unwrap();
        let result: serde_json::Value =
            serde_json::from_str(&builder.extract_text("a", source.as_bytes()).unwrap()).unwrap();
        assert_eq!(result, serde_json::json!({"payload":null,"added":true}));
        let row: serde_json::Value = serde_json::from_str(&builder.row_json("a").unwrap()).unwrap();
        assert!(row["exclusion"].is_null());
        assert_eq!(
            row["metadata"]["headings"][0]["text"]
                .as_str()
                .unwrap()
                .len(),
            MAX_PARSE_CACHE_ROW_BYTES
        );
    }
    #[test]
    fn cache_transport_keeps_size_before_utf8_and_nul_source_exclusions() {
        let mut builder = WasmDocumentIndexBuilder::new(&header()).unwrap();
        let result: serde_json::Value =
            serde_json::from_str(&builder.extract_text("a", &vec![255; MAX_TEXT + 1]).unwrap())
                .unwrap();
        assert_eq!(result, serde_json::json!({"payload":null,"added":true}));
        let row: serde_json::Value = serde_json::from_str(&builder.row_json("a").unwrap()).unwrap();
        assert_eq!(row["exclusion"], "sourceLimit");
        assert_eq!(builder.cache_key_json("b", b"nul\0text").unwrap(), "null");
        builder.add_text("b", b"nul\0text").unwrap();
        let row: serde_json::Value = serde_json::from_str(&builder.row_json("b").unwrap()).unwrap();
        assert_eq!(row["exclusion"], "binary");
    }
    #[test]
    fn cache_policy_transport_exports_shared_limits_and_admission() {
        let policy: serde_json::Value =
            serde_json::from_str(&document_parse_cache_policy_json().unwrap()).unwrap();
        assert_eq!(policy["maxRowBytes"], MAX_PARSE_CACHE_ROW_BYTES);
        assert_eq!(policy["maxBytes"], MAX_PARSE_CACHE_BYTES);
        assert_eq!(policy["maxRows"], MAX_PARSE_CACHE_ROWS);
        assert_eq!(
            policy["maxEvictionsPerWrite"],
            MAX_PARSE_CACHE_EVICTIONS_PER_WRITE
        );
        let result = document_parse_cache_admission_json(&serde_json::json!({"usage":{"rows":0,"bytes":0},"replacedPayloadBytes":null,"incomingPayloadBytes":1,"evictedRows":0}).to_string()).unwrap();
        assert_eq!(result, "\"write\"");
    }

    #[test]
    fn validated_cache_hit_reports_a_completed_lookup_when_output_budget_pauses_add() {
        let source = "[text](target) ".repeat(3000);
        let mut origin = WasmDocumentIndexBuilder::new(&header()).unwrap();
        let result: serde_json::Value =
            serde_json::from_str(&origin.extract_text("a", source.as_bytes()).unwrap()).unwrap();
        let payload = result["payload"].as_str().unwrap();
        assert!(payload.len() > zorid_index::MAX_PUMP_BYTES / 2);
        assert!(payload.len() <= MAX_PARSE_CACHE_ROW_BYTES);
        let mut builder = WasmDocumentIndexBuilder::new(&header()).unwrap();
        let a = builder.cache_key_json("a", source.as_bytes()).unwrap();
        let first: serde_json::Value =
            serde_json::from_str(&builder.add_cached_text("a", &a, payload).unwrap()).unwrap();
        assert_eq!(first["added"], true);
        let b = builder.cache_key_json("b", source.as_bytes()).unwrap();
        let paused: serde_json::Value =
            serde_json::from_str(&builder.add_cached_text("b", &b, payload).unwrap()).unwrap();
        assert_eq!(paused, serde_json::json!({"outcome":"hit","added":false}));
        builder.begin_pump().unwrap();
        let resumed: serde_json::Value =
            serde_json::from_str(&builder.add_cached_text("b", &b, payload).unwrap()).unwrap();
        assert_eq!(resumed, serde_json::json!({"outcome":"hit","added":true}));
        assert!(builder.ready());
    }
}
