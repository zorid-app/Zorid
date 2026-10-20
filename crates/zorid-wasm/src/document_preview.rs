//! Read-only first-build Bases. Durable membership and source admission remain
//! with the browser adapter. Scalars never reconstruct an actual capture.
//! One preview pool covers adapter backing/query/output logical reservations;
//! rich Search and existing compiler/evaluator components retain separate caps.
use crate::document_index::{
    base_query_options, BaseReadError, BaseReadOptions, WasmDocumentIndexBuilder,
};
use js_sys::Uint8Array;
use serde::{Deserialize, Serialize, Serializer};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    io::{self, Write},
    mem::size_of,
    rc::{Rc, Weak},
};
use wasm_bindgen::prelude::*;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId};
use zorid_index::{
    GenerationBuilder, PreviewCaptureError, PreviewCaptureOwner, PreviewProgress, PreviewSnapshot,
    SourceSnapshotId,
};

const CONTROL: usize = 64 * 1024;
const RESPONSE: usize = 16 * 1024 * 1024;
const POOL: usize = zorid_index::MAX_SEARCH_OWNED_BYTES;
const QUERY: usize = zorid_bases::MAX_PREVIEW_QUERY_OWNED_BYTES;
const SOURCE: usize = 256 * 1024;
const ALLOCATION: usize = 8 * size_of::<usize>();
const CONTROL_RESERVE: usize = 2 * CONTROL;
type Result<T> = std::result::Result<T, &'static str>;
fn js(code: &str) -> JsValue {
    JsValue::from_str(&format!("{{\"code\":\"{code}\"}}"))
}
fn identity(value: &str) -> Result<OperationId> {
    OperationId::new(value).map_err(|_| "index_invalid_request")
}
fn counter(value: &str) -> Result<()> {
    let parsed = value.parse::<u64>().map_err(|_| "index_invalid_request")?;
    if parsed == 0 || parsed.to_string() != value {
        return Err("index_invalid_request");
    }
    Ok(())
}
fn capture_error<E>(value: PreviewCaptureError<E>) -> &'static str {
    match value {
        PreviewCaptureError::Resource(_) => "index_preview_resource",
        PreviewCaptureError::Host(_) => "index_preview_expired",
        PreviewCaptureError::Index(_) => "index_invalid_request",
    }
}
fn source_error(_: zorid_index::IndexError) -> &'static str {
    "index_source_changed"
}
fn entry_bytes(value: &EntryState) -> usize {
    size_of::<EntryState>()
        .saturating_add(value.id.heap_capacity_bytes())
        .saturating_add(value.path.heap_capacity_bytes())
        .saturating_add(value.revision.heap_capacity_bytes())
}
#[derive(Default)]
struct Budget {
    used: Cell<usize>,
}
impl Budget {
    fn remaining(&self) -> usize {
        POOL.saturating_sub(self.used.get())
    }
    fn reserve(self: &Rc<Self>, bytes: usize) -> Result<Reservation> {
        if bytes > self.remaining() {
            return Err("index_preview_resource");
        }
        self.used.set(self.used.get() + bytes);
        Ok(Reservation {
            pool: self.clone(),
            bytes: Cell::new(bytes),
        })
    }
}
struct Reservation {
    pool: Rc<Budget>,
    bytes: Cell<usize>,
}
impl Reservation {
    fn resize(&self, bytes: usize) -> Result<()> {
        let old = self.bytes.get();
        if bytes > old && bytes - old > self.pool.remaining() {
            return Err("index_preview_resource");
        }
        self.pool.used.set(self.pool.used.get() - old + bytes);
        self.bytes.set(bytes);
        Ok(())
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.pool.used.set(self.pool.used.get() - self.bytes.get());
    }
}
struct Owner {
    _client: OperationId,
    _nonce: OperationId,
    epoch: Cell<u64>,
    live: Cell<bool>,
    latest: RefCell<Option<Rc<Capture>>>,
    pool: Rc<Budget>,
    // Fields holding actual payloads precede their reservations throughout.
    _charge: Reservation,
}
impl Owner {
    fn active(&self, epoch: u64) -> Result<()> {
        if self.live.get() && self.epoch.get() == epoch {
            Ok(())
        } else {
            Err("index_preview_expired")
        }
    }
    fn retire_latest(&self) {
        if let Some(old) = self.latest.borrow_mut().take() {
            old.live.set(false);
            drop(old);
        }
    }
    fn clear(&self) -> Result<()> {
        self.retire_latest();
        let next = self
            .epoch
            .get()
            .checked_add(1)
            .ok_or("index_preview_resource")?;
        self.epoch.set(next);
        Ok(())
    }
}
#[wasm_bindgen]
pub struct WasmDocumentPreviewOwner {
    inner: Rc<Owner>,
}
impl WasmDocumentPreviewOwner {
    fn create(client: &str, nonce: &str) -> Result<Self> {
        let client = identity(client)?;
        let nonce = identity(nonce)?;
        let pool = Rc::new(Budget::default());
        let charge = pool.reserve(
            CONTROL_RESERVE
                + size_of::<Owner>()
                + ALLOCATION * 2
                + client.heap_capacity_bytes()
                + nonce.heap_capacity_bytes(),
        )?;
        Ok(Self {
            inner: Rc::new(Owner {
                _client: client,
                _nonce: nonce,
                epoch: Cell::new(1),
                live: Cell::new(true),
                latest: RefCell::new(None),
                pool,
                _charge: charge,
            }),
        })
    }
}
#[wasm_bindgen]
impl WasmDocumentPreviewOwner {
    #[wasm_bindgen(constructor)]
    pub fn new(client: &str, nonce: &str) -> std::result::Result<Self, JsValue> {
        Self::create(client, nonce).map_err(js)
    }
    pub fn clear(&self) -> std::result::Result<(), JsValue> {
        self.inner.clear().map_err(js)
    }
    #[wasm_bindgen(js_name=retireStage)]
    pub fn retire_stage(&self, stage: &str) -> std::result::Result<(), JsValue> {
        let stage = identity(stage).map_err(js)?;
        let matches = self
            .inner
            .latest
            .borrow()
            .as_ref()
            .is_some_and(|capture| capture.stage == stage);
        if matches {
            self.inner.retire_latest();
        }
        Ok(())
    }
}
impl Drop for WasmDocumentPreviewOwner {
    fn drop(&mut self) {
        self.inner.live.set(false);
        self.inner.retire_latest();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Presentation {
    size: u64,
    ctime_ms: i64,
    mtime_ms: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommittedRow {
    entry: EntryState,
    presentation: Presentation,
}
impl CommittedRow {
    fn fact(&self) -> zorid_bases::FilePresentationFacts {
        zorid_bases::FilePresentationFacts {
            witness: zorid_bases::RecordWitness {
                entry_id: self.entry.id.clone(),
                revision: self.entry.revision.clone(),
            },
            size: Some(self.presentation.size),
            ctime_ms: Some(self.presentation.ctime_ms),
            mtime_ms: Some(self.presentation.mtime_ms),
        }
    }
    fn bytes(&self) -> usize {
        // A conservative full B-tree node per row also covers underfilled/root
        // nodes, keys, edge slots and allocator bookkeeping; no hidden map pool.
        entry_bytes(&self.entry)
            + self.entry.id.heap_capacity_bytes()
            + (size_of::<EntryId>() + size_of::<CommittedRow>() + size_of::<usize>()) * 16
            + ALLOCATION * 4
    }
}
/// Bookkeeping is optional and fed only from real committed browser receipts.
/// It is not a public source proof or another parser/namespace authority.
pub(crate) struct PreviewProducer {
    rows: BTreeMap<EntryId, CommittedRow>,
    capture: PreviewCaptureOwner,
    owner: Weak<Owner>,
    epoch: u64,
    retired: Cell<bool>,
    nonce: OperationId,
    stage: OperationId,
    identity: Rc<()>,
    _charge: Reservation,
}
impl PreviewProducer {
    fn create(
        builder: &GenerationBuilder,
        owner: &WasmDocumentPreviewOwner,
        nonce: &str,
        stage: &str,
    ) -> Result<Self> {
        let nonce = identity(nonce)?;
        let stage = identity(stage)?;
        let epoch = owner.inner.epoch.get();
        owner.inner.active(epoch)?;
        let charge = owner.inner.pool.reserve(
            size_of::<Self>()
                + ALLOCATION * 3
                + nonce.heap_capacity_bytes() * 2
                + stage.heap_capacity_bytes() * 2
                + 512,
        )?;
        let capture = PreviewCaptureOwner::new(nonce.clone(), stage.clone(), builder);
        Ok(Self {
            rows: BTreeMap::new(),
            capture,
            owner: Rc::downgrade(&owner.inner),
            epoch,
            retired: Cell::new(false),
            nonce,
            stage,
            identity: Rc::new(()),
            _charge: charge,
        })
    }
    fn owner(&self) -> Result<Rc<Owner>> {
        if self.retired.get() {
            return Err("index_preview_expired");
        }
        let owner = self.owner.upgrade().ok_or("index_preview_expired")?;
        owner.active(self.epoch)?;
        Ok(owner)
    }
    fn retire(&self) {
        self.retired.set(true);
        if let Some(owner) = self.owner.upgrade() {
            let remove = owner
                .latest
                .borrow()
                .as_ref()
                .is_some_and(|c| Rc::ptr_eq(&c.producer, &self.identity));
            if remove {
                owner.retire_latest();
            }
        }
    }
    fn commit(&mut self, builder: &GenerationBuilder, raw: &str) -> Result<()> {
        let owner = self.owner()?;
        if raw.len() > CONTROL {
            return Err("index_input_limit");
        }
        // Reserve before serde's typed vector/String allocations; measured
        // persistent rows replace the temporary conservative control allowance.
        let transient = owner
            .pool
            .reserve(raw.len().saturating_mul(32).saturating_add(4096))?;
        let rows: Vec<CommittedRow> =
            serde_json::from_str(raw).map_err(|_| "index_invalid_request")?;
        if rows.len() > 32 {
            return Err("index_invalid_request");
        }
        let mut ids = BTreeSet::new();
        let mut added = 0usize;
        for row in &rows {
            if row.entry.kind != EntryKind::File
                || row.entry.deleted
                || self.rows.contains_key(&row.entry.id)
                || !ids.insert(&row.entry.id)
            {
                return Err("index_invalid_request");
            }
            let record = builder
                .record(&row.entry.id)
                .ok_or("index_invalid_request")?;
            if record.witness().entry() != &row.entry {
                return Err("index_invalid_request");
            }
            // Browser presentation DTOs use exact safe integers.
            if row.presentation.size > 9_007_199_254_740_991
                || row.presentation.ctime_ms.unsigned_abs() > 9_007_199_254_740_991
                || row.presentation.mtime_ms.unsigned_abs() > 9_007_199_254_740_991
            {
                return Err("index_invalid_request");
            }
            added = added
                .checked_add(row.bytes())
                .ok_or("index_preview_resource")?;
        }
        let retained = self
            ._charge
            .bytes
            .get()
            .checked_add(added)
            .ok_or("index_preview_resource")?;
        // Transfer an already-reserved part to the persistent owner without
        // momentarily pretending it was released before the rows moved.
        let extra = added.saturating_sub(transient.bytes.get());
        if extra > owner.pool.remaining() {
            return Err("index_preview_resource");
        }
        transient.resize(transient.bytes.get().saturating_sub(added))?;
        self._charge.resize(retained)?;
        for row in rows {
            self.rows.insert(row.entry.id.clone(), row);
        }
        drop(transient);
        Ok(())
    }
    fn capture(&mut self, builder: &GenerationBuilder) -> Result<WasmDocumentPreview> {
        let owner = self.owner()?;
        if self.rows.len() != builder.prepared_records() {
            return Err("index_invalid_request");
        }
        // All map members were individually checked against this exact builder;
        // equal counts now establish its entire prepared set was committed.
        owner.retire_latest();
        // A weak JS wrapper keeps the Rc control/inline allocation alive after
        // row backing dies. Its own charge survives until that wrapper is freed.
        let handle_charge = owner
            .pool
            .reserve(size_of::<WasmDocumentPreview>() + size_of::<Capture>() + ALLOCATION * 3)?;
        let mut entries = Vec::new();
        let mut facts = Vec::new();
        let mut source_bytes = Vec::new();
        let count = self.rows.len();
        let table_plan = count
            .checked_mul(
                size_of::<EntryState>()
                    + size_of::<zorid_bases::FilePresentationFacts>()
                    + size_of::<Option<usize>>()
                    + ALLOCATION * 4,
            )
            .ok_or("index_preview_resource")?;
        let payload = self
            .rows
            .values()
            .try_fold(
                table_plan
                    + size_of::<Capture>()
                    + ALLOCATION * 4
                    + self.nonce.heap_capacity_bytes()
                    + self.stage.heap_capacity_bytes(),
                |n, row| {
                    n.checked_add(entry_bytes(&row.entry)).and_then(|n| {
                        n.checked_add(
                            size_of::<zorid_bases::FilePresentationFacts>()
                                + row.entry.id.heap_capacity_bytes()
                                + row.entry.revision.heap_capacity_bytes()
                                + ALLOCATION * 2,
                        )
                    })
                },
            )
            .ok_or("index_preview_resource")?;
        let charge = owner.pool.reserve(payload)?;
        entries
            .try_reserve_exact(count)
            .map_err(|_| "index_preview_resource")?;
        facts
            .try_reserve_exact(count)
            .map_err(|_| "index_preview_resource")?;
        source_bytes
            .try_reserve_exact(count)
            .map_err(|_| "index_preview_resource")?;
        let extra = entries.capacity().saturating_sub(count) * size_of::<EntryState>()
            + facts.capacity().saturating_sub(count)
                * size_of::<zorid_bases::FilePresentationFacts>()
            + source_bytes.capacity().saturating_sub(count) * size_of::<Option<usize>>();
        charge.resize(payload.checked_add(extra).ok_or("index_preview_resource")?)?;
        for row in self.rows.values() {
            entries.push(row.entry.clone());
            facts.push(row.fact());
        }
        let limit = owner.pool.remaining();
        let snapshot = self
            .capture
            .capture_prepared_checked(builder, limit, |_| owner.active(self.epoch))
            .map_err(capture_error)?;
        charge.resize(
            charge
                .bytes
                .get()
                .checked_add(snapshot.retention().total_bytes())
                .ok_or("index_preview_resource")?,
        )?;
        let view = snapshot
            .facts_view_checked(&mut |_| owner.active(self.epoch))
            .map_err(|_| "index_preview_expired")?;
        for (at, row) in view.rows().enumerate() {
            if entries
                .get(at)
                .is_none_or(|entry| entry.id != *row.entry_id())
            {
                return Err("index_invalid_request");
            }
            source_bytes.push(row.source_text_bytes());
        }
        if source_bytes.len() != count {
            return Err("index_invalid_request");
        }
        owner.active(self.epoch)?;
        let capture = Rc::new(Capture {
            snapshot,
            entries,
            facts,
            source_bytes,
            producer: self.identity.clone(),
            stage: self.stage.clone(),
            owner: Rc::downgrade(&owner),
            epoch: self.epoch,
            live: Cell::new(true),
            _charge: charge,
        });
        let handle = WasmDocumentPreview {
            capture: Rc::downgrade(&capture),
            _charge: handle_charge,
        };
        *owner.latest.borrow_mut() = Some(capture);
        Ok(handle)
    }
}
impl Drop for PreviewProducer {
    fn drop(&mut self) { /* finish may leave an unpublished retained capture eligible; explicit stage retirement is host-owned. */
    }
}
struct Capture {
    snapshot: PreviewSnapshot,
    entries: Vec<EntryState>,
    facts: Vec<zorid_bases::FilePresentationFacts>,
    source_bytes: Vec<Option<usize>>,
    producer: Rc<()>,
    stage: OperationId,
    owner: Weak<Owner>,
    epoch: u64,
    live: Cell<bool>,
    _charge: Reservation,
}
impl Capture {
    fn active(&self) -> Result<Rc<Owner>> {
        if !self.live.get() {
            return Err("index_preview_expired");
        }
        let owner = self.owner.upgrade().ok_or("index_preview_expired")?;
        owner.active(self.epoch)?;
        Ok(owner)
    }
}
#[derive(Clone, Copy)]
struct Decimal(u64);
impl Serialize for Decimal {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stamp<'a> {
    owner_nonce: &'a OperationId,
    stage_id: &'a OperationId,
    serial: Decimal,
}
fn stamp(c: &Capture) -> Stamp<'_> {
    Stamp {
        owner_nonce: c.snapshot.id().owner_nonce(),
        stage_id: c.snapshot.id().stage_id(),
        serial: Decimal(c.snapshot.id().capture_serial()),
    }
}
#[derive(Serialize)]
struct Descriptor<'a> {
    capture: Stamp<'a>,
    source: &'a SourceSnapshotId,
    progress: PreviewProgress,
}
fn descriptor(c: &Capture) -> Descriptor<'_> {
    Descriptor {
        capture: stamp(c),
        source: c.snapshot.source(),
        progress: c.snapshot.progress(),
    }
}
#[wasm_bindgen]
pub struct WasmDocumentPreview {
    capture: Weak<Capture>,
    _charge: Reservation,
}
impl WasmDocumentPreview {
    fn admitted(&self) -> Result<Rc<Capture>> {
        let c = self.capture.upgrade().ok_or("index_preview_expired")?;
        c.active()?;
        Ok(c)
    }
}
#[wasm_bindgen]
impl WasmDocumentIndexBuilder {
    #[wasm_bindgen(js_name=configurePreview)]
    pub fn configure_preview(
        &mut self,
        owner: &WasmDocumentPreviewOwner,
        nonce: &str,
        stage: &str,
    ) -> std::result::Result<(), JsValue> {
        let create = || -> Result<PreviewProducer> {
            if self.preview.is_some() {
                return Err("index_invalid_request");
            }
            PreviewProducer::create(
                self.builder.as_ref().ok_or("index_builder_closed")?,
                owner,
                nonce,
                stage,
            )
        };
        self.preview = Some(create().map_err(js)?);
        Ok(())
    }
    #[wasm_bindgen(js_name=commitPreviewRowsJson)]
    pub fn commit_preview_rows_json(&mut self, raw: &str) -> std::result::Result<(), JsValue> {
        let mut result = || -> Result<()> {
            self.preview
                .as_mut()
                .ok_or("index_preview_expired")?
                .commit(self.builder.as_ref().ok_or("index_builder_closed")?, raw)
        };
        result().map_err(js)
    }
    #[wasm_bindgen(js_name=capturePreview)]
    pub fn capture_preview(&mut self) -> std::result::Result<Option<WasmDocumentPreview>, JsValue> {
        let mut capture = || -> Result<WasmDocumentPreview> {
            self.preview
                .as_mut()
                .ok_or("index_preview_expired")?
                .capture(self.builder.as_ref().ok_or("index_builder_closed")?)
        };
        capture().map(Some).map_err(js)
    }
    #[wasm_bindgen(js_name=retirePreview)]
    pub fn retire_preview(&mut self) {
        if let Some(producer) = self.preview.take() {
            producer.retire();
            drop(producer);
        }
    }
}
#[wasm_bindgen]
impl WasmDocumentPreview {
    #[wasm_bindgen(js_name=descriptorJson)]
    pub fn descriptor_json(&self) -> std::result::Result<String, JsValue> {
        let c = self.admitted().map_err(js)?;
        control_json(&descriptor(&c)).map_err(js)
    }
    #[wasm_bindgen(js_name=sameCapture)]
    pub fn same_capture(&self, other: &Self) -> bool {
        match (self.admitted(), other.admitted()) {
            (Ok(a), Ok(b)) => Rc::ptr_eq(&a, &b) && a.snapshot.same_capture(&b.snapshot),
            _ => false,
        }
    }
    #[wasm_bindgen(js_name=beginBase)]
    pub fn begin_base(&self, raw: &str) -> std::result::Result<WasmDocumentPreviewQuery, JsValue> {
        self.begin(raw).map_err(js)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BaseRequest {
    preview_id: String,
    id: EntryId,
    view_name: Option<String>,
    #[serde(default)]
    options: BaseReadOptions,
}
struct QueryState {
    capture: Rc<Capture>,
    request: BaseRequest,
    entry: usize,
    source_bytes: usize,
    owned_limit: usize,
    result_and_output_limit: usize,
    used: Cell<bool>,
    cancelled: Cell<bool>,
    cancellation: zorid_bases::OperationCancellation,
    _charge: Reservation,
}
impl QueryState {
    fn active(&self) -> Result<()> {
        if self.cancelled.get() {
            return Err("index_preview_expired");
        }
        self.capture.active()?;
        Ok(())
    }
    fn definition(&self) -> &EntryState {
        &self.capture.entries[self.entry]
    }
}
#[wasm_bindgen]
pub struct WasmDocumentPreviewQuery {
    inner: Rc<QueryState>,
}
impl WasmDocumentPreview {
    fn begin(&self, raw: &str) -> Result<WasmDocumentPreviewQuery> {
        if raw.len() > CONTROL {
            return Err("index_input_limit");
        }
        let capture = self.admitted()?;
        let owner = capture.active()?;
        let limit = QUERY.min(owner.pool.remaining());
        let charge = owner.pool.reserve(limit)?;
        // Typed parsing is admitted before allocations. The32x allowance covers
        // worst-case tiny string vector elements plus geometric spare capacity;
        // actual retained capacities replace it after the bounded decode.
        if raw.len().saturating_mul(32).saturating_add(4096) > limit {
            return Err("index_preview_resource");
        }
        let request: BaseRequest =
            serde_json::from_str(raw).map_err(|_| "index_invalid_request")?;
        counter(&request.preview_id)?;
        let entry = capture
            .entries
            .binary_search_by(|e| e.id.cmp(&request.id))
            .map_err(|_| "index_preview_not_ready")?;
        let source_bytes = capture.source_bytes[entry].ok_or("index_source_unavailable")?;
        if source_bytes > SOURCE {
            return Err("index_input_limit");
        }
        let fixed = size_of::<QueryState>()
            + ALLOCATION * 3
            + request.preview_id.capacity()
            + request.id.heap_capacity_bytes()
            + request.view_name.as_ref().map_or(0, String::capacity)
            + request.options.retained_bytes().saturating_mul(2)
            + source_bytes.saturating_mul(2)
            // Serialize(into=String) clones core scalar wrappers before the
            // writer sees them. Only the definition uses VaultPath here;
            // result paths are borrowed Strings and all other wrappers are
            // bounded IDs/watermarks. One scalar is serialized at a time.
            + capture.entries[entry].path.as_str().len().max(128)
            + ALLOCATION
            + 4096;
        let rest = limit.checked_sub(fixed).ok_or("index_preview_resource")?;
        // The DTO and actual output share this ONE reservation. Keep a bounded
        // minimum for output while evaluating, then subtract the reducer's
        // conservative monotonic admission before counting/allocating output.
        // Do not reserve two maximum-sized outputs for every small result.
        let owned_limit = rest
            .checked_sub(CONTROL)
            .filter(|n| *n > 0)
            .ok_or("index_preview_resource")?;
        capture.active()?;
        Ok(WasmDocumentPreviewQuery {
            inner: Rc::new(QueryState {
                capture,
                request,
                entry,
                source_bytes,
                owned_limit,
                result_and_output_limit: rest,
                used: Cell::new(false),
                cancelled: Cell::new(false),
                cancellation: zorid_bases::OperationCancellation::default(),
                _charge: charge,
            }),
        })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryDescriptor<'a> {
    capture: Stamp<'a>,
    source: &'a SourceSnapshotId,
    definition: &'a EntryState,
    source_bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BaseValue<'a> {
    preview_id: &'a str,
    capture: Stamp<'a>,
    source: &'a SourceSnapshotId,
    definition: &'a EntryState,
    result: &'a zorid_bases::BasePreviewResult,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    schema_version: u32,
    op: &'static str,
    value: BaseValue<'a>,
}
#[wasm_bindgen]
pub struct WasmDocumentPreviewReply {
    result: zorid_bases::BasePreviewResult,
    query: Rc<QueryState>,
    length: usize,
    admitted_owned_bytes: usize,
    written: Cell<bool>,
}
impl WasmDocumentPreviewReply {
    fn envelope(&self) -> Envelope<'_> {
        Envelope {
            schema_version: 1,
            op: "preview_base",
            value: BaseValue {
                preview_id: &self.query.request.preview_id,
                capture: stamp(&self.query.capture),
                source: self.query.capture.snapshot.source(),
                definition: self.query.definition(),
                result: &self.result,
            },
        }
    }
    fn write(&self, writer: &mut impl Write) -> Result<()> {
        self.query.active()?;
        if self
            .admitted_owned_bytes
            .checked_add(self.length)
            .is_none_or(|bytes| bytes > self.query.result_and_output_limit)
        {
            return Err("index_preview_resource");
        }
        let result = serde_json::to_writer(writer, &self.envelope());
        self.query.active()?;
        result.map_err(|_| "index_output_limit")
    }
}
// No JSON payload Vec/String/value exists in this path. Counting and output
// serialize the same borrowed immutable DTO with a whole-envelope byte ceiling.
struct Count<'a> {
    bytes: usize,
    maximum: usize,
    check: &'a dyn Fn() -> Result<()>,
}
impl Write for Count<'_> {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        (self.check)().map_err(|_| io::Error::other("preview retired"))?;
        if input.len() > self.maximum.saturating_sub(self.bytes) {
            return Err(io::Error::other("preview output limit"));
        }
        self.bytes += input.len();
        Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn control_json(value: &impl Serialize) -> Result<String> {
    // Controls alone retain the existing64KiB component allowance. This helper
    // is never used for a Base result or metadata/facts corpus.
    let mut writer = ControlWriter { bytes: Vec::new() };
    serde_json::to_writer(&mut writer, value).map_err(|_| "index_output_limit")?;
    String::from_utf8(writer.bytes).map_err(|_| "index_invalid_request")
}
struct ControlWriter {
    bytes: Vec<u8>,
}
impl Write for ControlWriter {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        if input.len() > CONTROL.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("preview control limit"));
        }
        self.bytes
            .try_reserve_exact(input.len())
            .map_err(|_| io::Error::other("preview control allocation"))?;
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct JsWriter<'a> {
    output: &'a Uint8Array,
    at: usize,
    expected: usize,
    check: &'a dyn Fn() -> Result<()>,
}
impl Write for JsWriter<'_> {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        (self.check)().map_err(|_| io::Error::other("preview retired"))?;
        if self.output.length() as usize != self.expected
            || input.len() > self.expected.saturating_sub(self.at)
        {
            return Err(io::Error::other("preview target limit"));
        }
        if !input.is_empty() {
            // New view, same already-admitted JS backing; no payload allocation.
            let view = Uint8Array::new_with_byte_offset_and_length(
                &self.output.buffer(),
                self.output.byte_offset() + self.at as u32,
                input.len() as u32,
            );
            view.copy_from(input);
        }
        self.at += input.len();
        (self.check)().map_err(|_| io::Error::other("preview retired"))?;
        Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl WasmDocumentPreviewQuery {
    fn prepare(&self, bytes: &[u8]) -> Result<WasmDocumentPreviewReply> {
        self.inner.active()?;
        if bytes.len() != self.inner.source_bytes {
            return Err("index_source_changed");
        }
        let query = &self.inner;
        query
            .capture
            .snapshot
            .check_text(&query.request.id, bytes)
            .map_err(source_error)?;
        let source = std::str::from_utf8(bytes).map_err(|_| "index_source_unavailable")?;
        // Invocation-only compiler/YAML allocations keep their existing source
        // and component ceilings, separate from this adapter ledger. No program
        // is retained by the owner/query/reply or inserted into a cache. This
        // allowance does not claim aggregate parser/process heap.
        let program = zorid_bases::compile_base_source(source).map_err(|_| "index_base_compile")?;
        // Move-free option reuse: the only typed option clone is bounded and
        // pre-admitted in the existing per-query control allowance.
        let input = query.request.options.clone();
        let mut options = base_query_options(input, query.request.view_name.as_deref(), &program)
            .map_err(|error| match error {
            BaseReadError::Code(code) => code,
            _ => "index_base_evaluation",
        })?;
        options.max_output_bytes = options.max_output_bytes.min(
            query
                .result_and_output_limit
                .saturating_sub(CONTROL)
                .min(RESPONSE),
        );
        options.evaluation.cancellation = Some(query.cancellation.clone());
        query.active()?;
        let result = zorid_bases::query_preview(
            &program,
            &query.capture.snapshot,
            &query.request.id,
            &query.capture.facts,
            &options,
            query.owned_limit,
        )
        .map_err(|error| match error.code.as_str() {
            "budget" => "index_preview_resource",
            "unavailable" => "index_preview_not_ready",
            "cancelled" => "index_preview_expired",
            _ => "index_base_evaluation",
        })?;
        query
            .capture
            .snapshot
            .check_text(&query.request.id, bytes)
            .map_err(source_error)?;
        query.active()?;
        if result.capture != *query.capture.snapshot.id()
            || result.source != *query.capture.snapshot.source()
        {
            return Err("index_invalid_request");
        }
        let admitted_owned_bytes = result.admitted_owned_bytes();
        let encoded_limit = query
            .result_and_output_limit
            .checked_sub(admitted_owned_bytes)
            .ok_or("index_preview_resource")?
            .min(RESPONSE);
        let mut reply = WasmDocumentPreviewReply {
            result: result.value,
            query: query.clone(),
            length: 0,
            admitted_owned_bytes,
            written: Cell::new(false),
        };
        let check = || query.active();
        let mut count = Count {
            bytes: 0,
            maximum: encoded_limit,
            check: &check,
        };
        reply.write(&mut count)?;
        reply.length = count.bytes;
        query.active()?;
        Ok(reply)
    }
}
#[wasm_bindgen]
impl WasmDocumentPreviewQuery {
    #[wasm_bindgen(js_name=descriptorJson)]
    pub fn descriptor_json(&self) -> std::result::Result<String, JsValue> {
        self.inner.active().map_err(js)?;
        control_json(&QueryDescriptor {
            capture: stamp(&self.inner.capture),
            source: self.inner.capture.snapshot.source(),
            definition: self.inner.definition(),
            source_bytes: self.inner.source_bytes,
        })
        .map_err(js)
    }
    #[wasm_bindgen(js_name=prepareBase)]
    pub fn prepare_base(
        &self,
        input: &Uint8Array,
    ) -> std::result::Result<WasmDocumentPreviewReply, JsValue> {
        let action = || -> Result<WasmDocumentPreviewReply> {
            self.inner.active()?;
            if self.inner.used.replace(true) {
                return Err("index_preview_busy");
            }
            if input.length() as usize != self.inner.source_bytes {
                return Err("index_source_changed");
            }
            let mut bytes = Vec::new();
            bytes
                .try_reserve_exact(self.inner.source_bytes)
                .map_err(|_| "index_preview_resource")?;
            if bytes.capacity() > self.inner.source_bytes.saturating_add(ALLOCATION) {
                return Err("index_preview_resource");
            }
            bytes.resize(self.inner.source_bytes, 0);
            input.copy_to(&mut bytes);
            self.prepare(&bytes)
        };
        action().map_err(js)
    }
    pub fn cancel(&self) {
        self.inner.cancelled.set(true);
        self.inner.cancellation.cancel();
    }
}
#[wasm_bindgen]
impl WasmDocumentPreviewReply {
    #[wasm_bindgen(js_name=encodedLength)]
    pub fn encoded_length(&self) -> std::result::Result<f64, JsValue> {
        self.query.active().map_err(js)?;
        Ok(self.length as f64)
    }
    #[wasm_bindgen(js_name=writeInto)]
    pub fn write_into(&self, output: &Uint8Array) -> std::result::Result<(), JsValue> {
        let action = || -> Result<()> {
            self.query.active()?;
            if output.length() as usize != self.length {
                return Err("index_output_limit");
            }
            if self.written.replace(true) {
                return Err("index_preview_busy");
            }
            let check = || self.query.active();
            let mut writer = JsWriter {
                output,
                at: 0,
                expected: self.length,
                check: &check,
            };
            self.write(&mut writer)?;
            if writer.at != self.length {
                return Err("index_output_limit");
            }
            self.query.active()
        };
        action().map_err(js)
    }
}
#[cfg(test)]
#[path = "document_preview_tests.rs"]
mod tests;
