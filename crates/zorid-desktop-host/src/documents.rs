//! Admitted semantic transport. Pins/tokens stay Rust objects; JSON is a report,
//! never a capability. Typed serialization preserves recursive YAML map order.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Write};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use zorid_core::{EntryId, OperationId};
use zorid_native::{
    DocumentQueryPin, IndexSnapshotId, LiteralQuery, LiteralToken, NativeDocumentError,
    NativeBasePreview, NativeBasePreviewReply, NativeMetadataRows, NativeRichCursor,
    NativeRichPreparation, NativeRichQuery, NativeVault,
    QueryOptions, RelationshipToken, RichPageProfile, SearchSpec, TaskFilter, TaskQueryOptions,
};

pub(crate) const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
// Independent search/backlink/Base views may retain separate lifetimes; the
// native Store also enforces its global four-pin ceiling across all clients.
const MAX_PINS_PER_CLIENT: usize = 4;
const MAX_CURSORS_PER_PIN: usize = 8;
const MAX_RICH_QUERIES_PER_PIN: usize = 4;
const MAX_RICH_PAGE_BYTES: usize = 1024 * 1024;
const MAX_RICH_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const RICH_PREPARE_WORK: usize = 2_000_000;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    schema_version: u32,
    command: DocumentCommand,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum DocumentCommand {
    RuntimeObserve,
    RuntimeSnapshot,
    RuntimeControl { sequence: crate::document_runtime::Counter, command: crate::document_runtime::Feature },
    RuntimeAck { sequence: crate::document_runtime::Counter },
    RuntimeOutcomeAck { lifetime: OperationId, id: crate::document_runtime::Counter },
    RuntimeOwner { sequence: crate::document_runtime::Counter, command: crate::document_runtime::Owner },
    RuntimeOwnerAck { sequence: crate::document_runtime::Counter },
    RuntimeStep { lifetime: OperationId, effect_id: crate::document_runtime::Counter },
    Status,
    Initialize,
    Rebuild,
    Begin,
    Stages,
    Resume {
        snapshot: IndexSnapshotId,
    },
    Pump {
        snapshot: IndexSnapshotId,
    },
    Publish {
        snapshot: IndexSnapshotId,
    },
    Discard {
        snapshot: IndexSnapshotId,
    },
    Open {
        pin_id: OperationId,
    },
    Close {
        pin_id: OperationId,
    },
    PreviewOpen { preview_id: OperationId },
    PreviewBase {
        preview_id: OperationId,
        id: EntryId,
        view_name: Option<String>,
        #[serde(default)]
        options: BaseOptions,
    },
    PreviewClose { preview_id: OperationId },
    Metadata {
        pin_id: OperationId,
        id: EntryId,
    },
    MetadataRows {
        pin_id: OperationId,
        #[serde(
            default,
            deserialize_with = "metadata_baseline",
            skip_serializing_if = "Option::is_none"
        )]
        baseline: Option<MetadataBaseline>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<OperationId>,
        #[serde(
            default,
            deserialize_with = "metadata_limit",
            skip_serializing_if = "Option::is_none"
        )]
        limit: Option<usize>,
    },
    Search {
        pin_id: OperationId,
        query: String,
        cursor: Option<OperationId>,
        limit: usize,
    },
    RichStart {
        pin_id: OperationId,
        spec: SearchSpec,
    },
    RichPrepare {
        pin_id: OperationId,
        query_id: OperationId,
    },
    RichPage {
        pin_id: OperationId,
        query_id: OperationId,
        cursor: OperationId,
    },
    RichClose {
        pin_id: OperationId,
        query_id: OperationId,
    },
    Backlinks {
        pin_id: OperationId,
        id: EntryId,
        cursor: Option<OperationId>,
        limit: usize,
    },
    Tasks {
        pin_id: OperationId,
        type_ids: Vec<EntryId>,
        #[serde(default)]
        options: TaskOptions,
    },
    Base {
        pin_id: OperationId,
        id: EntryId,
        view_name: Option<String>,
        #[serde(default)]
        options: BaseOptions,
    },
}
impl Request {
    pub(crate) fn is_preview(&self) -> bool {
        matches!(self.command,
            DocumentCommand::PreviewOpen { .. } | DocumentCommand::PreviewBase { .. }
            | DocumentCommand::PreviewClose { .. })
    }
    pub(crate) fn is_preview_base(&self) -> bool {
        matches!(self.command, DocumentCommand::PreviewBase { .. })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct BaseOptions {
    view_index: usize,
    search_terms: Vec<String>,
    ignore_paths: Vec<String>,
    #[serde(
        default,
        deserialize_with = "clock_option",
        skip_serializing_if = "Option::is_none"
    )]
    clock_ms: Option<i64>,
    timezone: String,
    max_rows: usize,
    #[serde(default, deserialize_with = "current_entry_option")]
    current_entry_id: Option<EntryId>,
    max_steps: usize,
}
impl Default for BaseOptions {
    fn default() -> Self {
        Self {
            view_index: 0,
            search_terms: Vec::new(),
            ignore_paths: Vec::new(),
            clock_ms: None,
            timezone: "UTC".into(),
            max_rows: 1000,
            current_entry_id: None,
            max_steps: QueryOptions::default().max_steps,
        }
    }
}
impl BaseOptions {
    fn into_options(self) -> Result<QueryOptions, Value> {
        self.into_options_with_clock(capture_clock_ms)
    }
    fn into_options_with_clock(
        self,
        capture: impl FnOnce() -> Result<i64, Value>,
    ) -> Result<QueryOptions, Value> {
        if self.max_rows == 0
            || self.max_rows > 10_000
            || self.view_index > 1000
            || self.max_steps == 0
            || self.max_steps > QueryOptions::default().max_steps
        {
            return Err(failure("invalid_budget"));
        }
        let mut options = QueryOptions::default();
        options.view_index = self.view_index;
        options.search_terms = self.search_terms;
        options.ignore_paths = self.ignore_paths;
        // Capture one host clock for this invocation. The portable engine gets
        // an explicit value; explicit zero/custom request clocks never read it.
        options.evaluation.clock_ms = safe_clock_ms(match self.clock_ms {
            Some(clock) => clock,
            None => capture()?,
        })?;
        options.evaluation.timezone = self.timezone;
        options.max_rows = self.max_rows;
        options.max_steps = self.max_steps;
        options.current_entry_id = self.current_entry_id;
        Ok(options)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct TaskOptions {
    filter: TaskFilter,
    #[serde(
        default,
        deserialize_with = "clock_option",
        skip_serializing_if = "Option::is_none"
    )]
    clock_ms: Option<i64>,
    timezone: String,
    show_done: bool,
    max_rows: usize,
}
impl Default for TaskOptions {
    fn default() -> Self {
        Self {
            filter: TaskFilter::All,
            clock_ms: None,
            timezone: "UTC".into(),
            show_done: false,
            max_rows: 1000,
        }
    }
}
impl TaskOptions {
    fn into_options(self) -> Result<TaskQueryOptions, Value> {
        self.into_options_with_clock(capture_clock_ms)
    }
    fn into_options_with_clock(
        self,
        capture: impl FnOnce() -> Result<i64, Value>,
    ) -> Result<TaskQueryOptions, Value> {
        if self.max_rows == 0 || self.max_rows > 10000 || self.timezone.len() > 128 {
            return Err(failure("invalid_budget"));
        }
        let clock_ms = match self.clock_ms {
            Some(clock) => safe_clock_ms(clock)?,
            None => safe_clock_ms(capture()?)?,
        };
        Ok(TaskQueryOptions {
            filter: self.filter,
            clock_ms,
            timezone: self.timezone,
            show_done: self.show_done,
            max_rows: self.max_rows,
        })
    }
}
// An optional selector may be omitted, but present null must not erase it.
fn current_entry_option<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<EntryId>, D::Error> {
    EntryId::deserialize(deserializer).map(Some)
}
// Missing differs from explicit null: only omission selects the host clock.
fn clock_option<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    i64::deserialize(deserializer).map(Some)
}
const MAX_SAFE_CLOCK_MS: i64 = 9_007_199_254_740_991;
fn safe_clock_ms(clock: i64) -> Result<i64, Value> {
    if !(-MAX_SAFE_CLOCK_MS..=MAX_SAFE_CLOCK_MS).contains(&clock) {
        return Err(failure("invalid_clock"));
    }
    Ok(clock)
}
fn capture_clock_ms() -> Result<i64, Value> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| failure("invalid_clock"))?
        .as_millis();
    safe_clock_ms(i64::try_from(millis).map_err(|_| failure("invalid_clock"))?)
}
fn metadata_baseline<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<MetadataBaseline>, D::Error> {
    MetadataBaseline::deserialize(d).map(Some)
}
fn metadata_limit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<usize>, D::Error> {
    usize::deserialize(d).map(Some)
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetadataBaseline {
    pin_id: OperationId,
    snapshot: IndexSnapshotId,
}
#[derive(Clone, PartialEq, Eq)]
struct MetadataCursor {
    // Original request permits exact first-page retries without a second
    // whole-generation coverage admission. Only effective baseline is fenced.
    requested: Option<MetadataBaseline>,
    baseline: Option<MetadataBaseline>,
    limit: usize,
    initial: bool,
    value: NativeMetadataRows,
}
#[derive(Clone, PartialEq, Eq)]
enum Cursor {
    Metadata(MetadataCursor),
    Search {
        query: String,
        token: LiteralToken,
    },
    Backlinks {
        id: EntryId,
        token: RelationshipToken,
    },
}
struct Pin {
    value: Arc<DocumentQueryPin>,
    rich_queries: BTreeMap<OperationId, RichQuery>,
    next_query: u64,
    cursors: BTreeMap<OperationId, Cursor>,
    cursor_order: VecDeque<OperationId>,
    next_cursor: u64,
    cursor_prefix: String,
}
// The actual guard owns this pin's Arc, not merely its snapshot identity.
struct RichQuery {
    guard: NativeRichQuery,
    cursors: BTreeMap<OperationId, NativeRichCursor>,
    cursor_order: VecDeque<OperationId>,
    next_cursor: u64,
    prefix: String,
}
impl RichQuery {
    fn save_cursor(&mut self, cursor: NativeRichCursor) -> Result<OperationId, Value> {
        if let Some((id, _)) = self.cursors.iter().find(|(_, old)| **old == cursor) {
            return Ok(id.clone());
        }
        self.next_cursor = self
            .next_cursor
            .checked_add(1)
            .ok_or_else(|| failure("search_resource"))?;
        let id = OperationId::new(format!("{}-c{}", self.prefix, self.next_cursor))
            .map_err(|_| failure("search_resource"))?;
        if self.cursors.len() == MAX_CURSORS_PER_PIN {
            let oldest = self
                .cursor_order
                .pop_front()
                .expect("registered rich cursor");
            self.cursors.remove(&oldest);
        }
        self.cursor_order.push_back(id.clone());
        self.cursors.insert(id.clone(), cursor);
        Ok(id)
    }
}
impl Drop for Pin {
    fn drop(&mut self) {
        // Query Drop closes core state before releasing its Arc pin. Retire all
        // guards and opaque cursors before the containing close acknowledges.
        self.rich_queries.clear();
        self.cursors.clear();
    }
}
impl Pin {
    fn save_cursor(&mut self, cursor: Cursor) -> Result<OperationId, Value> {
        // Exact page retry reuses its continuation handle, rather than leaking
        // a new capability. Older continuations may expire explicitly.
        if let Some((id, _)) = self.cursors.iter().find(|(_, old)| **old == cursor) {
            return Ok(id.clone());
        }
        self.next_cursor = self
            .next_cursor
            .checked_add(1)
            .ok_or_else(|| failure("cursor_capacity"))?;
        let id = OperationId::new(format!("{}-c{}", self.cursor_prefix, self.next_cursor))
            .map_err(|_| failure("cursor_capacity"))?;
        if self.cursors.len() == MAX_CURSORS_PER_PIN {
            let oldest = self.cursor_order.pop_front().expect("registered cursor");
            self.cursors.remove(&oldest);
        }
        self.cursor_order.push_back(id.clone());
        self.cursors.insert(id.clone(), cursor);
        Ok(id)
    }
}
#[derive(Default)]
struct Client {
    pins: BTreeMap<OperationId, Pin>,
    // Constant-size retry fence permits indefinitely many opens. An ID at or
    // below this floor can only replay its still-live original pin or expire.
    last_open: u64,
    previews: BTreeMap<OperationId, NativeBasePreview>,
    last_preview_open: u64,
}
#[derive(Default)]
pub(crate) struct Sessions {
    clients: BTreeMap<OperationId, Client>,
    runtime: crate::document_runtime::Sessions,
}
impl Sessions {
    // Only actual core Continue/step receipts supply this reduction. Keep the
    // existing request mapping and successful rebuild pin-disposal behavior.
    pub(crate) fn adopt_runtime(
        &mut self,
        reduction: &zorid_native::DocumentRuntimeReduction,
        rebuilt: bool,
    ) {
        self.runtime.adopt(reduction);
        if rebuilt {
            for client in self.clients.values_mut() {
                client.pins.clear();
                client.previews.clear();
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn retained_pin_count(&self) -> usize {
        self.clients.values().map(|client| client.pins.len()).sum()
    }
    pub(crate) fn release_runtime_after_work(
        &mut self,
        vault: &mut NativeVault,
        client: &OperationId,
        last: bool,
    ) -> Result<(), Value> {
        if self.runtime.release_after_work(vault, client, last)? {
            for client in self.clients.values_mut() {
                client.pins.clear();
                client.previews.clear();
            }
        }
        Ok(())
    }
    pub(crate) fn release_runtime(&mut self, vault: &mut NativeVault, client: &OperationId, last: bool) -> Result<(),Value> {
        if self.runtime.release(vault,client,last)? {
            for client in self.clients.values_mut() {
                client.pins.clear();
                client.previews.clear();
            }
        }
        Ok(())
    }
    pub(crate) fn release(&mut self, client: &OperationId) {
        self.clients.remove(client); // Drop releases even already-expired pins.
    }
}
fn failure(code: &str) -> Value {
    json!({"code":code,"commit_uncertain":false,"message":"Document query failed; authoritative source remains unchanged"})
}
fn native_transport_code(code: &str) -> String {
    // The stdio envelope admits only lowercase ASCII/underscore categories.
    // Shared typed diagnostics retain their original spelling inside results.
    if code.is_empty()
        || code.len() > 64
        || !code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'-')
    {
        return "document_query_failed".into();
    }
    code.replace('-', "_")
}
pub(crate) fn native(error: NativeDocumentError) -> Value {
    let mut value = failure(&native_transport_code(error.code()));
    if let NativeDocumentError::SearchCompile(diagnostic) = error {
        value["details"] = json!({"diagnostic": diagnostic});
    }
    value
}
struct Capped(Vec<u8>, usize);
impl Write for Capped {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > self.1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "document response limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a, T> {
    schema_version: u32,
    op: &'a str,
    value: T,
}
fn answer<T: Serialize>(op: &str, value: T) -> Result<(Value, Vec<u8>), Value> {
    answer_with_limit(op, value, MAX_RESPONSE_BYTES)
}
fn answer_with_limit<T: Serialize>(
    op: &str,
    value: T,
    limit: usize,
) -> Result<(Value, Vec<u8>), Value> {
    let mut body = Capped(Vec::new(), limit);
    serde_json::to_writer(
        &mut body,
        &Response {
            schema_version: 1,
            op,
            value,
        },
    )
    .map_err(|_| failure("response_limit"))?;
    Ok((
        json!({"documents":true,"schemaVersion":1,"bytes":body.0.len()}),
        body.0,
    ))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened<'a> {
    pin_id: &'a OperationId,
    snapshot: &'a IndexSnapshotId,
    source: &'a zorid_native::SourceSnapshotId,
    coverage_complete: bool,
}
#[derive(Serialize)]
struct StatusReport {
    source: zorid_native::SourceSnapshotId,
    #[serde(flatten)]
    status: zorid_native::DocumentIndexStatus,
}
#[derive(Serialize)]
struct Paged<T> {
    result: T,
    cursor: Option<OperationId>,
}

/// Actual encoding has its own complete-envelope byte bound and cancellation
/// callback. This is separate from the pure pager's2M preparation ledger.
fn metadata_answer(
    value: impl Serialize,
    maximum: usize,
    check: &mut impl FnMut() -> bool,
) -> Result<(Value, Vec<u8>), Value> {
    struct Checked<'a> {
        bytes: Vec<u8>,
        maximum: usize,
        check: &'a mut dyn FnMut() -> bool,
        cancelled: bool,
    }
    impl Write for Checked<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if !(self.check)() {
                self.cancelled = true;
                return Err(io::Error::other("metadata encoding cancelled"));
            }
            if self
                .bytes
                .len()
                .checked_add(bytes.len())
                .is_none_or(|n| n > self.maximum)
            {
                return Err(io::Error::other("metadata response limit"));
            }
            self.bytes
                .try_reserve(bytes.len())
                .map_err(|_| io::Error::other("metadata allocation limit"))?;
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut output = Checked {
        bytes: Vec::new(),
        maximum,
        check,
        cancelled: false,
    };
    if serde_json::to_writer(
        &mut output,
        &Response {
            schema_version: 1,
            op: "metadata_rows",
            value,
        },
    )
    .is_err()
    {
        return Err(failure(if output.cancelled {
            "cancelled"
        } else {
            "response_limit"
        }));
    }
    if !(output.check)() {
        return Err(failure("cancelled"));
    }
    Ok((
        json!({"documents":true,"schemaVersion":1,"bytes":output.bytes.len()}),
        output.bytes,
    ))
}
fn metadata_actual_pins(
    sessions: &Sessions,
    client: &OperationId,
    pin_id: &OperationId,
    baseline: Option<&MetadataBaseline>,
) -> Result<(Arc<DocumentQueryPin>, Option<Arc<DocumentQueryPin>>), Value> {
    let owner = sessions
        .clients
        .get(client)
        .ok_or_else(|| failure("snapshot_expired"))?;
    let destination = owner
        .pins
        .get(pin_id)
        .ok_or_else(|| failure("snapshot_expired"))?
        .value
        .clone();
    let old = baseline
        .map(|expected| {
            let pin = owner
                .pins
                .get(&expected.pin_id)
                .ok_or_else(|| failure("snapshot_expired"))?;
            if pin.value.generation().id() != &expected.snapshot {
                return Err(failure("query_mismatch"));
            }
            Ok(pin.value.clone())
        })
        .transpose()?;
    Ok((destination, old))
}
fn retire_metadata_pin(sessions: &mut Sessions, client: &OperationId, id: &OperationId) {
    if let Some(owner) = sessions.clients.get_mut(client) {
        owner.pins.remove(id);
        for pin in owner.pins.values_mut() {
            pin.cursors.retain(|_, cursor| {
                !matches!(cursor,
                Cursor::Metadata(state) if state.baseline.as_ref().is_some_and(|b| &b.pin_id == id))
            });
            pin.cursor_order.retain(|id| pin.cursors.contains_key(id));
        }
    }
}
fn metadata_rows_checked(
    vault: &NativeVault,
    sessions: &mut Sessions,
    client: &OperationId,
    pin_id: OperationId,
    requested: Option<MetadataBaseline>,
    cursor: Option<OperationId>,
    limit: Option<usize>,
    maximum: usize,
    check: &mut impl FnMut() -> bool,
) -> Result<(Value, Vec<u8>), Value> {
    let baseline = if let Some(id) = &cursor {
        sessions
            .clients
            .get(client)
            .and_then(|c| c.pins.get(&pin_id))
            .and_then(|p| p.cursors.get(id))
            .and_then(|entry| match entry {
                Cursor::Metadata(state) => state.baseline.clone(),
                _ => None,
            })
    } else {
        requested.clone()
    };
    metadata_rows_inner(
        vault,
        sessions,
        client,
        pin_id.clone(),
        requested,
        cursor,
        limit,
        maximum,
        check,
    )
    .map_err(|error| {
        if error["code"] == "snapshot_expired" {
            // Distinguish a proven expired destination from baseline-only
            // expiry. Never retire an unrelated still-valid destination.
            for id in [Some(&pin_id), baseline.as_ref().map(|b| &b.pin_id)]
                .into_iter()
                .flatten()
            {
                let actual = sessions
                    .clients
                    .get(client)
                    .and_then(|c| c.pins.get(id))
                    .map(|p| p.value.clone());
                if actual.as_ref().is_some_and(|p| {
                    vault
                        .check_document_metadata_pin_registration(p)
                        .is_err_and(|e| e.code() == "snapshot_expired")
                }) {
                    retire_metadata_pin(sessions, client, id);
                }
            }
        }
        error
    })
}
fn metadata_rows_inner(
    vault: &NativeVault,
    sessions: &mut Sessions,
    client: &OperationId,
    pin_id: OperationId,
    requested: Option<MetadataBaseline>,
    cursor: Option<OperationId>,
    limit: Option<usize>,
    maximum: usize,
    check: &mut impl FnMut() -> bool,
) -> Result<(Value, Vec<u8>), Value> {
    if limit.is_some_and(|n| !(1..=32).contains(&n)) {
        return Err(failure("invalid_budget"));
    }
    if cursor.is_some() && requested.is_some() {
        return Err(failure("invalid_request"));
    }
    let mut state = if let Some(id) = cursor {
        let pin = pin(sessions, client, &pin_id)?;
        let state = match pin.cursors.get(&id) {
            Some(Cursor::Metadata(state)) => state.clone(),
            Some(_) => return Err(failure("query_mismatch")),
            None => return Err(failure("cursor_expired")),
        };
        if limit.is_some_and(|n| n != state.limit) {
            return Err(failure("query_mismatch"));
        }
        state
    } else {
        let (destination, _) = metadata_actual_pins(sessions, client, &pin_id, None)?;
        vault
            .check_document_metadata_pin_registration(&destination)
            .map_err(native)?;
        let mut effective = None;
        if let Some(expected) = &requested {
            if expected.snapshot.local_store_id() != destination.generation().id().local_store_id()
            {
                return Err(failure("query_mismatch"));
            }
            // IDs belong only to this authenticated client. Unknown IDs cannot
            // borrow another client's same numeric pin; initial history resets.
            if let Some(old) = sessions
                .clients
                .get(client)
                .and_then(|c| c.pins.get(&expected.pin_id))
                .map(|p| p.value.clone())
            {
                if old.generation().id() != &expected.snapshot {
                    return Err(failure("query_mismatch"));
                }
                match vault.check_document_metadata_pin_registration(&old) {
                    Ok(()) => {
                        // Match the pure factory's compatibility selection before
                        // looking up an initial retry, including reset profiles.
                        if old.generation().id().versions()
                            == destination.generation().id().versions()
                            && old.generation().id().generation_epoch()
                                == destination.generation().id().generation_epoch()
                        {
                            effective = Some(expected.clone());
                        }
                    }
                    Err(error) if error.code() == "snapshot_expired" => {
                        retire_metadata_pin(sessions, client, &expected.pin_id)
                    }
                    Err(error) => return Err(native(error)),
                }
            }
        }
        let selected_limit = limit.unwrap_or(32);
        let cached =
            pin(sessions, client, &pin_id)?
                .cursors
                .values()
                .find_map(|entry| match entry {
                    Cursor::Metadata(old)
                        if old.initial
                            && old.requested == requested
                            && old.baseline == effective
                            && old.limit == selected_limit =>
                    {
                        Some(old.clone())
                    }
                    _ => None,
                });
        if let Some(old) = cached {
            old
        } else {
            let (_, old) = metadata_actual_pins(sessions, client, &pin_id, effective.as_ref())?;
            let value = vault
                .begin_document_metadata_rows(&destination, old.as_deref(), selected_limit, check)
                .map_err(native)?;
            if !value.uses_baseline() {
                effective = None;
            }
            let state = MetadataCursor {
                requested,
                baseline: effective,
                limit: selected_limit,
                initial: true,
                value,
            };
            // Retain the unadvanced input checkpoint for first-page retries;
            // successful page advancement is not installed until after encoding.
            pin(sessions, client, &pin_id)?.save_cursor(Cursor::Metadata(state.clone()))?;
            state
        }
    };
    let (destination, baseline) =
        metadata_actual_pins(sessions, client, &pin_id, state.baseline.as_ref())?;
    let result = vault
        .document_metadata_rows(&destination, baseline.as_deref(), &state.value, check)
        .map_err(native)?;
    let done = result.value.scan_complete();
    let next_id = if done {
        None
    } else {
        let pin = pin(sessions, client, &pin_id)?;
        let existing = pin.cursors.iter().find_map(|(id, entry)| match entry {
            Cursor::Metadata(old)
                if !old.initial
                    && old.baseline == state.baseline
                    && old.limit == state.limit
                    && state.value.has_successor(&old.value) =>
            {
                Some(id.clone())
            }
            _ => None,
        });
        Some(match existing {
            Some(id) => id,
            None => OperationId::new(format!(
                "{}-c{}",
                pin.cursor_prefix,
                pin.next_cursor
                    .checked_add(1)
                    .ok_or_else(|| failure("cursor_capacity"))?
            ))
            .map_err(|_| failure("cursor_capacity"))?,
        })
    };
    let encoded = metadata_answer(
        Paged {
            result: &result,
            cursor: next_id.clone(),
        },
        maximum,
        check,
    )?;
    // Actual client registrations (not merely matching snapshot labels) still
    // have to name the same pin allocations after complete response encoding.
    let (current, old) = metadata_actual_pins(sessions, client, &pin_id, state.baseline.as_ref())?;
    if !Arc::ptr_eq(&current, &destination)
        || match (&old, &baseline) {
            (None, None) => false,
            (Some(a), Some(b)) => !Arc::ptr_eq(a, b),
            _ => true,
        }
    {
        return Err(failure("snapshot_expired"));
    }
    vault
        .commit_document_metadata_rows(
            &destination,
            baseline.as_deref(),
            &mut state.value,
            result.value,
            check,
        )
        .map_err(native)?;
    if let Some(expected) = next_id {
        state.initial = false;
        let actual = pin(sessions, client, &pin_id)?.save_cursor(Cursor::Metadata(state))?;
        if actual != expected {
            return Err(failure("cursor_capacity"));
        }
    }
    Ok(encoded)
}

fn runtime_answer(vault:&mut NativeVault,sessions:&mut Sessions,client:&OperationId,op:&str,command:crate::document_runtime::Command)->Result<(Value,Vec<u8>),Value> {
    let reply=sessions.runtime.execute(vault,client,command)?;
    if reply.rebuilt {
        for client in sessions.clients.values_mut() {
            client.pins.clear();
            client.previews.clear();
        }
    }
    let encoded=answer(op,reply.value)?;
    if encoded.1.len()>crate::document_runtime::MAX_BYTES {return Err(failure("document_runtime_capacity"));}
    Ok(encoded)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewOpened<'a> {
    preview_id: &'a OperationId,
    #[serde(flatten)]
    descriptor: zorid_native::NativePreviewDescriptor,
}
fn preview_expired(error: &NativeDocumentError) -> bool {
    matches!(error.code(), "index_preview_expired" | "snapshot_expired" | "stale_source" | "stale_index")
}
fn prune_previews(vault: &NativeVault, client: &mut Client) -> Result<(), Value> {
    let mut expired = Vec::with_capacity(MAX_PINS_PER_CLIENT);
    for (id, preview) in &client.previews {
        if let Err(error) = vault.check_document_preview_handle(preview) {
            if preview_expired(&error) { expired.push(id.clone()); } else { return Err(native(error)); }
        }
    }
    for id in expired { client.previews.remove(&id); }
    Ok(())
}
/// Preserve the actual request for final lease authorization. Only its owned
/// options move into the query; no complete response Vec escapes this path.
pub(crate) fn preview_base_reply(
    vault: &NativeVault,
    sessions: &Sessions,
    client: &OperationId,
    request: &mut Request,
) -> Result<(OperationId, NativeBasePreviewReply), Value> {
    if request.schema_version != 1 { return Err(failure("unsupported_protocol")); }
    let DocumentCommand::PreviewBase { preview_id, id, view_name, options } = &mut request.command else {
        return Err(failure("invalid_request"));
    };
    pin_sequence(preview_id)?;
    let preview = sessions.clients.get(client).and_then(|c| c.previews.get(preview_id))
        .ok_or_else(|| failure("index_preview_expired"))?;
    let options = std::mem::take(options).into_options()?;
    let reply = vault.query_base_preview(preview, id, view_name.as_deref(), options, |_| Ok(()))
        .map_err(native)?;
    Ok((preview_id.clone(), reply))
}

pub(crate) fn execute(
    vault: &mut NativeVault,
    sessions: &mut Sessions,
    client: &OperationId,
    lease_token: &OperationId,
    request: Request,
) -> Result<(Value, Vec<u8>), Value> {
    if request.schema_version != 1 {
        return Err(failure("unsupported_protocol"));
    }
    if serde_json::to_vec(&request)
        .map_err(|_| failure("invalid_request"))?
        .len()
        > MAX_REQUEST_BYTES
    {
        return Err(failure("request_limit"));
    }
    use DocumentCommand::*;
    let pin_on_error = match &request.command {
        Open { pin_id }
        | Close { pin_id }
        | Metadata { pin_id, .. }
        | Search { pin_id, .. }
        | RichStart { pin_id, .. }
        | RichPrepare { pin_id, .. }
        | RichPage { pin_id, .. }
        | RichClose { pin_id, .. }
        | Backlinks { pin_id, .. }
        | Base { pin_id, .. }
        | Tasks { pin_id, .. } => Some(pin_id.clone()),
        _ => None,
    };
    let result = (|| {
        match request.command {
            RuntimeObserve => runtime_answer(vault,sessions,client,"runtime_observe",crate::document_runtime::Command::Observe),
            RuntimeSnapshot => runtime_answer(vault,sessions,client,"runtime_snapshot",crate::document_runtime::Command::Snapshot),
            RuntimeControl {sequence,command} => runtime_answer(vault,sessions,client,"runtime_control",crate::document_runtime::Command::Control{sequence,command}),
            RuntimeAck {sequence} => runtime_answer(vault,sessions,client,"runtime_ack",crate::document_runtime::Command::Ack{sequence}),
            RuntimeOutcomeAck {lifetime,id} => runtime_answer(vault,sessions,client,"runtime_outcome_ack",crate::document_runtime::Command::OutcomeAck{lifetime,id}),
            RuntimeOwner {sequence,command} => runtime_answer(vault,sessions,client,"runtime_owner",crate::document_runtime::Command::Owner{sequence,command}),
            RuntimeOwnerAck {sequence} => runtime_answer(vault,sessions,client,"runtime_owner_ack",crate::document_runtime::Command::OwnerAck{sequence}),
            RuntimeStep {lifetime,effect_id} => runtime_answer(vault,sessions,client,"runtime_step",crate::document_runtime::Command::Step{lifetime,effect_id}),
            Status => {
                let (source, status) = vault.document_index_status_with_source().map_err(native)?;
                answer("status", StatusReport { source, status })
            }
            Initialize => {
                vault.initialize_document_index().map_err(native)?;
                answer("initialize", true)
            }
            Rebuild => {
                vault.rebuild_document_index().map_err(native)?;
                // Keep replay floors fenced; only a new sequence may open again.
                for client in sessions.clients.values_mut() {
                    client.pins.clear();
                    client.previews.clear();
                }
                answer("rebuild", true)
            }
            Begin => answer("begin", vault.begin_document_index().map_err(native)?),
            Stages => answer("stages", vault.document_index_stages().map_err(native)?),
            Resume { snapshot } => answer(
                "resume",
                vault.resume_document_index(&snapshot).map_err(native)?,
            ),
            Pump { snapshot } => {
                let stage = vault.resume_document_index(&snapshot).map_err(native)?;
                answer("pump", vault.pump_document_index(&stage).map_err(native)?)
            }
            Publish { snapshot } => {
                let stage = vault.resume_document_index(&snapshot).map_err(native)?;
                answer(
                    "publish",
                    vault.publish_document_index(&stage).map_err(native)?,
                )
            }
            Discard { snapshot } => {
                // Cleanup must work after stale source/index work. Do not call
                // resume_document_index, whose publication fences are stricter.
                vault
                    .discard_document_index_stage(&snapshot)
                    .map_err(native)?;
                answer("discard", true)
            }
            Open { pin_id } => {
                let sequence = pin_sequence(&pin_id)?;
                let client = sessions.clients.entry(client.clone()).or_default();
                prune_previews(vault, client)?;
                if !client.pins.contains_key(&pin_id) {
                    if sequence <= client.last_open {
                        return Err(failure("snapshot_expired"));
                    }
                    if client.pins.len() + client.previews.len() >= MAX_PINS_PER_CLIENT {
                        return Err(failure("pin_capacity"));
                    }
                    let value = vault.open_document_snapshot().map_err(native)?;
                    client.last_open = sequence;
                    client.pins.insert(
                        pin_id.clone(),
                        Pin {
                            value: Arc::new(value),
                            rich_queries: BTreeMap::new(),
                            next_query: 0,
                            cursors: BTreeMap::new(),
                            cursor_order: VecDeque::new(),
                            next_cursor: 0,
                            cursor_prefix: format!("{}-p{}", lease_token.as_str(), sequence),
                        },
                    );
                }
                let pin = &client.pins[&pin_id].value;
                // Native revalidates retained epoch/header even on exact open retry.
                vault.document_snapshot_identity(pin).map_err(native)?;
                answer(
                    "open",
                    Opened {
                        pin_id: &pin_id,
                        snapshot: pin.generation().id(),
                        source: pin.generation().manifest().source(),
                        coverage_complete: pin.generation().coverage_complete(),
                    },
                )
            }
            PreviewOpen { preview_id } => {
                let sequence = pin_sequence(&preview_id)?;
                let client = sessions.clients.entry(client.clone()).or_default();
                prune_previews(vault, client)?;
                if let Some(preview) = client.previews.get(&preview_id) {
                    let descriptor = preview.descriptor().map_err(native)?;
                    return answer("preview_open", PreviewOpened { preview_id: &preview_id, descriptor });
                }
                if sequence <= client.last_preview_open {
                    return Err(failure("index_preview_expired"));
                }
                if client.pins.len() + client.previews.len() >= MAX_PINS_PER_CLIENT {
                    return Err(failure("pin_capacity"));
                }
                let preview = vault.open_document_preview().map_err(native)?;
                // Null consumes its sequence without retaining a map entry.
                client.last_preview_open = sequence;
                let Some(preview) = preview else { return answer("preview_open", Option::<bool>::None); };
                let descriptor = preview.descriptor().map_err(native)?;
                client.previews.insert(preview_id.clone(), preview);
                answer("preview_open", PreviewOpened { preview_id: &preview_id, descriptor })
            }
            PreviewClose { preview_id } => {
                let sequence = pin_sequence(&preview_id)?;
                let client = sessions.clients.entry(client.clone()).or_default();
                if client.previews.remove(&preview_id).is_none()
                    && sequence > client.last_preview_open
                {
                    // Match ordinary close: fabricated future tokens are not
                    // acknowledged and do not reserve or advance open history.
                    return Err(failure("index_preview_expired"));
                }
                answer("preview_close", json!({"closed":true}))
            }
            PreviewBase { .. } => Err(failure("preview_requires_stdio")),
            Close { pin_id } => {
                let sequence = pin_sequence(&pin_id)?;
                let client = sessions.clients.entry(client.clone()).or_default();
                if client.pins.remove(&pin_id).is_none() && sequence > client.last_open {
                    return Err(failure("snapshot_expired"));
                }
                // Closed history must not remain retained through another
                // pin's capability-free metadata cursor. At most4*8 slots.
                for pin in client.pins.values_mut() {
                    pin.cursors.retain(|_, cursor| !matches!(cursor,
                        Cursor::Metadata(state) if state.baseline.as_ref().is_some_and(|b| b.pin_id == pin_id)));
                    pin.cursor_order.retain(|id| pin.cursors.contains_key(id));
                }
                answer("close", true)
            }
            MetadataRows {
                pin_id,
                baseline,
                cursor,
                limit,
            } => metadata_rows_checked(
                vault,
                sessions,
                client,
                pin_id,
                baseline,
                cursor,
                limit,
                MAX_RESPONSE_BYTES,
                &mut || true,
            ),
            Metadata { pin_id, id } => {
                let pin = pin(sessions, client, &pin_id)?;
                answer(
                    "metadata",
                    vault.document_metadata(&pin.value, &id).map_err(native)?,
                )
            }
            Search {
                pin_id,
                query,
                cursor,
                limit,
            } => {
                let pin = pin(sessions, client, &pin_id)?;
                let token = match cursor {
                    Some(cursor) => match pin.cursors.get(&cursor) {
                        Some(Cursor::Search { query: old, token }) if old == &query => {
                            Some(token.clone())
                        }
                        Some(_) => return Err(failure("query_mismatch")),
                        None => return Err(failure("cursor_expired")),
                    },
                    None => None,
                };
                let literal =
                    LiteralQuery::new(query.clone()).map_err(|_| failure("invalid_query"))?;
                let mut result = vault
                    .search_documents(&pin.value, literal, token.as_ref(), limit)
                    .map_err(native)?;
                let cursor = result
                    .value
                    .next
                    .take()
                    .map(|token| pin.save_cursor(Cursor::Search { query, token }))
                    .transpose()?;
                answer("search", Paged { result, cursor })
            }
            RichStart { pin_id, spec } => {
                let pin = pin(sessions, client, &pin_id)?;
                if pin.rich_queries.len() >= MAX_RICH_QUERIES_PER_PIN {
                    return Err(failure("search_resource"));
                }
                // Reserve the host locator before creating native state, so a
                // failed handle allocation cannot orphan a live native query.
                let sequence = pin
                    .next_query
                    .checked_add(1)
                    .ok_or_else(|| failure("search_resource"))?;
                let query_id = OperationId::new(format!("{}-q{}", pin.cursor_prefix, sequence))
                    .map_err(|_| failure("search_resource"))?;
                let guard = vault
                    .start_rich_document_query(
                        Arc::clone(&pin.value),
                        spec,
                        RichPageProfile::default(),
                        |_| Ok(()),
                    )
                    .map_err(native)?;
                pin.next_query = sequence;
                pin.rich_queries.insert(
                    query_id.clone(),
                    RichQuery {
                        guard,
                        cursors: BTreeMap::new(),
                        cursor_order: VecDeque::new(),
                        next_cursor: 0,
                        prefix: query_id.as_str().to_owned(),
                    },
                );
                answer("rich_start", json!({"queryId": query_id}))
            }
            RichPrepare { pin_id, query_id } => {
                let pin = pin(sessions, client, &pin_id)?;
                let query = pin
                    .rich_queries
                    .get_mut(&query_id)
                    .ok_or_else(|| failure("search_expired"))?;
                match vault
                    .prepare_rich_document_query(&query.guard, RICH_PREPARE_WORK, |_| Ok(()))
                    .map_err(native)?
                {
                    NativeRichPreparation::Preparing => {
                        answer("rich_prepare", json!({"state":"preparing"}))
                    }
                    NativeRichPreparation::Ready(cursor) => {
                        let cursor = query.save_cursor(cursor)?;
                        answer("rich_prepare", json!({"state":"ready", "cursor":cursor}))
                    }
                }
            }
            RichPage {
                pin_id,
                query_id,
                cursor,
            } => {
                let pin = pin(sessions, client, &pin_id)?;
                let query = pin
                    .rich_queries
                    .get_mut(&query_id)
                    .ok_or_else(|| failure("search_expired"))?;
                let cursor = query
                    .cursors
                    .get(&cursor)
                    .ok_or_else(|| failure("search_expired"))?;
                let page = vault
                    .rich_document_page(&query.guard, cursor, |_| Ok(()))
                    .map_err(native)?;
                // Enforce the inner encoding independently of the outer frame.
                // A failed encoding never returns a continuation; retry retains
                // the original immutable Rust checkpoint and identical page.
                let mut inner = Capped(Vec::new(), MAX_RICH_PAGE_BYTES);
                serde_json::to_writer(&mut inner, &page.result.value)
                    .map_err(|_| failure("response_limit"))?;
                drop(inner);
                let cursor = page
                    .next
                    .map(|cursor| query.save_cursor(cursor))
                    .transpose()?;
                answer_with_limit(
                    "rich_page",
                    Paged {
                        result: page.result,
                        cursor,
                    },
                    MAX_RICH_RESPONSE_BYTES,
                )
            }
            RichClose { pin_id, query_id } => {
                let pin = pin(sessions, client, &pin_id)?;
                if let Some(query) = pin.rich_queries.remove(&query_id) {
                    // Explicit Drop before acknowledgement, including all cursor handles.
                    drop(query);
                } else {
                    // Constant-size retry fence, scoped to this exact pin/lease.
                    let prefix = format!("{}-q", pin.cursor_prefix);
                    let sequence = query_id.as_str().strip_prefix(&prefix).and_then(|s| {
                        s.parse::<u64>()
                            .ok()
                            .filter(|n| *n > 0 && n.to_string() == s)
                    });
                    if !sequence.is_some_and(|n| n <= pin.next_query) {
                        return Err(failure("search_expired"));
                    }
                }
                answer("rich_close", true)
            }
            Backlinks {
                pin_id,
                id,
                cursor,
                limit,
            } => {
                let pin = pin(sessions, client, &pin_id)?;
                let token = match cursor {
                    Some(cursor) => match pin.cursors.get(&cursor) {
                        Some(Cursor::Backlinks { id: old, token }) if old == &id => {
                            Some(token.clone())
                        }
                        Some(_) => return Err(failure("query_mismatch")),
                        None => return Err(failure("cursor_expired")),
                    },
                    None => None,
                };
                let mut result = vault
                    .document_backlinks(&pin.value, &id, token.as_ref(), limit)
                    .map_err(native)?;
                let cursor = result
                    .value
                    .next
                    .take()
                    .map(|token| pin.save_cursor(Cursor::Backlinks { id, token }))
                    .transpose()?;
                answer("backlinks", Paged { result, cursor })
            }
            Tasks {
                pin_id,
                type_ids,
                options,
            } => {
                let pin = pin(sessions, client, &pin_id)?;
                let options = options.into_options()?;
                answer(
                    "tasks",
                    vault
                        .query_task_documents(&pin.value, &type_ids, &options)
                        .map_err(native)?,
                )
            }
            Base {
                pin_id,
                id,
                view_name,
                options,
            } => {
                if view_name.as_ref().is_some_and(|s| s.len() > 1024) {
                    return Err(failure("request_limit"));
                }
                let pin = pin(sessions, client, &pin_id)?;
                let options = options.into_options()?;
                let result = match view_name {
                    Some(name) => vault.query_base_document_view(&pin.value, &id, &name, &options),
                    None => vault.query_base_document(&pin.value, &id, &options),
                }
                .map_err(native)?;
                answer("base", result)
            }
        }
    })();
    if result
        .as_ref()
        .is_err_and(|error| error.get("code").and_then(Value::as_str) == Some("snapshot_expired"))
    {
        if let Some(id) = pin_on_error {
            if let Some(client) = sessions.clients.get_mut(client) {
                client.pins.remove(&id);
            }
        }
    }
    result
}
fn pin<'a>(
    sessions: &'a mut Sessions,
    client: &OperationId,
    id: &OperationId,
) -> Result<&'a mut Pin, Value> {
    sessions
        .clients
        .get_mut(client)
        .and_then(|c| c.pins.get_mut(id))
        .ok_or_else(|| failure("snapshot_expired"))
}

fn pin_sequence(id: &OperationId) -> Result<u64, Value> {
    id.as_str()
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && n.to_string() == id.as_str())
        .ok_or_else(|| failure("invalid_pin_id"))
}

#[cfg(test)]
mod clock_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn tasks_clock_is_captured_once_and_explicit_zero_never_reads_it() {
        let calls = Cell::new(0);
        let options: TaskOptions = serde_json::from_str("{}").unwrap();
        let result = options
            .into_options_with_clock(|| {
                calls.set(calls.get() + 1);
                Ok(42)
            })
            .unwrap();
        assert_eq!(result.clock_ms, 42);
        assert_eq!(calls.get(), 1);
        assert_eq!(result.timezone, "UTC");
        assert_eq!(result.max_rows, 1000);
        let options: TaskOptions = serde_json::from_str(r#"{"clockMs":0}"#).unwrap();
        assert_eq!(
            options
                .into_options_with_clock(|| panic!("clock must not run"))
                .unwrap()
                .clock_ms,
            0
        );
        assert!(serde_json::from_str::<TaskOptions>(r#"{"clockMs":null}"#).is_err());
        assert!(serde_json::from_str::<TaskOptions>(r#"{"owner":"forged"}"#).is_err());
    }
    #[test]
    fn omitted_base_clock_is_captured_once_with_utc_and_row_defaults() {
        let calls = Cell::new(0);
        let request: BaseOptions = serde_json::from_str("{}").unwrap();
        let options = request
            .into_options_with_clock(|| {
                calls.set(calls.get() + 1);
                Ok(1_720_000_000_123)
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(options.evaluation.clock_ms, 1_720_000_000_123);
        assert_eq!(options.evaluation.timezone, "UTC");
        assert_eq!(options.max_rows, 1000);
    }

    #[test]
    fn explicit_zero_and_custom_base_clocks_do_not_read_ambient_time() {
        for clock in [0, -42, 1_720_000_000_123, MAX_SAFE_CLOCK_MS] {
            let request: BaseOptions =
                serde_json::from_str(&format!(r#"{{"clockMs":{clock}}}"#)).unwrap();
            let options = request
                .into_options_with_clock(|| panic!("explicit clock must not capture ambient time"))
                .unwrap();
            assert_eq!(options.evaluation.clock_ms, clock);
        }
    }

    #[test]
    fn base_clock_rejects_unsafe_values_and_never_falls_back_to_epoch_zero() {
        for clock in [
            MAX_SAFE_CLOCK_MS + 1,
            -MAX_SAFE_CLOCK_MS - 1,
            i64::MAX,
            i64::MIN,
        ] {
            let request = BaseOptions {
                clock_ms: Some(clock),
                ..BaseOptions::default()
            };
            let error = request
                .into_options_with_clock(|| panic!("explicit clock must not capture ambient time"))
                .unwrap_err();
            assert_eq!(error["code"], "invalid_clock");
        }
        let error = BaseOptions::default()
            .into_options_with_clock(|| Ok(MAX_SAFE_CLOCK_MS + 1))
            .unwrap_err();
        assert_eq!(error["code"], "invalid_clock");
        let error = BaseOptions::default()
            .into_options_with_clock(|| Err(failure("clock_unavailable")))
            .unwrap_err();
        assert_eq!(error["code"], "clock_unavailable");
        for raw in [
            r#"{"clockMs":null}"#,
            r#"{"clockMs":1.5}"#,
            r#"{"clockMs":"0"}"#,
            r#"{"clockMs":NaN}"#,
        ] {
            assert!(serde_json::from_str::<BaseOptions>(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn base_context_options_preserve_strong_selector_and_bound_query_steps() {
        let input: BaseOptions =
            serde_json::from_str(r#"{"currentEntryId":"current-note","maxSteps":17,"clockMs":0}"#)
                .unwrap();
        let options = input
            .into_options_with_clock(|| panic!("explicit clock must be preserved"))
            .unwrap();
        assert_eq!(
            options.current_entry_id,
            Some(EntryId::new("current-note").unwrap())
        );
        assert_eq!(options.max_steps, 17);
        for steps in [0, QueryOptions::default().max_steps + 1] {
            assert!(BaseOptions {
                max_steps: steps,
                ..BaseOptions::default()
            }
            .into_options_with_clock(|| Ok(0))
            .is_err());
        }
        for raw in [
            r#"{"currentEntryId":"bad:path"}"#,
            r#"{"currentEntryId":null}"#,
            r#"{"maxSteps":null}"#,
            r#"{"currentEntryId":"one","currentEntryId":"two"}"#,
            r#"{"maxSteps":1,"maxSteps":2}"#,
        ] {
            assert!(serde_json::from_str::<BaseOptions>(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn native_frame_error_categories_are_safe_without_rewriting_shared_diagnostics() {
        for (shared, wire) in [
            ("stale-source", "stale_source"),
            ("numeric-domain", "numeric_domain"),
            ("view_not_found", "view_not_found"),
        ] {
            assert_eq!(native_transport_code(shared), wire);
        }
        assert_eq!(native_transport_code("not/a/code"), "document_query_failed");
    }
}

#[cfg(test)]
mod rich_transport_tests {
    use super::*;
    use zorid_core::{EntryKind, Mutation, MutationRequest, VaultPath};

    pub(super) fn operation(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    pub(super) fn call(
        vault: &mut NativeVault,
        sessions: &mut Sessions,
        client: &str,
        command: Value,
    ) -> Result<Value, Value> {
        let request = serde_json::from_value(json!({"schemaVersion":1,"command":command})).unwrap();
        let (_, body) = execute(
            vault,
            sessions,
            &operation(client),
            &operation(client),
            request,
        )?;
        Ok(serde_json::from_slice::<Value>(&body).unwrap()["value"].clone())
    }
    fn spec(query: &str) -> Value {
        json!({"query":query,"caseSensitive":false,"sort":"nameAsc","context":"line","explain":false})
    }
    pub(super) fn fixture(documents: usize) -> (tempfile::TempDir, tempfile::TempDir, NativeVault) {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        vault
            .enable_local_document_cache(cache.path().join("cache.sqlite"))
            .unwrap();
        for index in 0..documents {
            vault
                .apply(&MutationRequest {
                    operation_id: operation(&format!("create-{index}")),
                    mutation: Mutation::Create {
                        id: EntryId::new(format!("note-{index}")).unwrap(),
                        path: VaultPath::new(format!("Note-{index:03}.md")).unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"needle\n".to_vec()),
                    },
                })
                .unwrap();
        }
        vault.initialize_document_index().unwrap();
        let stage = vault.begin_document_index().unwrap();
        for _ in 0..100 {
            if vault.pump_document_index(&stage).unwrap().ready {
                vault.publish_document_index(&stage).unwrap();
                return (root, cache, vault);
            }
        }
        panic!("bounded fixture did not publish");
    }
    pub(super) fn open(vault: &mut NativeVault, sessions: &mut Sessions, client: &str, pin: &str) {
        call(vault, sessions, client, json!({"op":"open","pinId":pin})).unwrap();
    }
    fn start(vault: &mut NativeVault, sessions: &mut Sessions, client: &str, pin: &str) -> Value {
        call(
            vault,
            sessions,
            client,
            json!({"op":"rich_start","pinId":pin,"spec":spec("file:Note")}),
        )
        .unwrap()["queryId"]
            .clone()
    }
    fn ready(
        vault: &mut NativeVault,
        sessions: &mut Sessions,
        client: &str,
        pin: &str,
        query: &Value,
    ) -> Value {
        for _ in 0..100 {
            let value = call(
                vault,
                sessions,
                client,
                json!({"op":"rich_prepare","pinId":pin,"queryId":query}),
            )
            .unwrap();
            if value["state"] == "ready" {
                return value["cursor"].clone();
            }
            assert_eq!(value, json!({"state":"preparing"}));
        }
        panic!("bounded query did not prepare");
    }
    #[test]
    fn rich_guards_scope_actual_client_pin_query_and_retry_cursor() {
        let (_root, _cache, mut vault) = fixture(36);
        let mut sessions = Sessions::default();
        open(&mut vault, &mut sessions, "client-a", "1");
        open(&mut vault, &mut sessions, "client-a", "2");
        open(&mut vault, &mut sessions, "client-b", "1");
        let query = start(&mut vault, &mut sessions, "client-a", "1");
        let cursor = ready(&mut vault, &mut sessions, "client-a", "1", &query);
        for (client, pin) in [("client-a", "2"), ("client-b", "1")] {
            let error = call(
                &mut vault,
                &mut sessions,
                client,
                json!({"op":"rich_prepare","pinId":pin,"queryId":query}),
            )
            .unwrap_err();
            assert_eq!(error["code"], "search_expired");
        }
        let other_query = start(&mut vault, &mut sessions, "client-a", "1");
        let foreign = call(
            &mut vault,
            &mut sessions,
            "client-a",
            json!({"op":"rich_page","pinId":"1","queryId":other_query,"cursor":cursor}),
        )
        .unwrap_err();
        assert_eq!(foreign["code"], "search_expired");
        let command = json!({"op":"rich_page","pinId":"1","queryId":query,"cursor":cursor});
        let page = call(&mut vault, &mut sessions, "client-a", command.clone()).unwrap();
        assert_eq!(
            call(&mut vault, &mut sessions, "client-a", command).unwrap(),
            page,
            "input retry reuses exact opaque next handle"
        );
        assert_eq!(page["result"]["value"]["next"], Value::Null);
        assert!(
            !page["cursor"].is_null(),
            "default document budget requires continuation"
        );
        let first_pin = &sessions.clients[&operation("client-a")].pins[&operation("1")];
        let second_pin = &sessions.clients[&operation("client-a")].pins[&operation("2")];
        assert_eq!(
            first_pin.value.generation().id(),
            second_pin.value.generation().id()
        );
        assert!(
            !Arc::ptr_eq(&first_pin.value, &second_pin.value),
            "same snapshot does not imply same pin authority"
        );
        assert_eq!(
            first_pin.rich_queries[&serde_json::from_value::<OperationId>(query.clone()).unwrap()]
                .cursors
                .len(),
            2
        );
        call(
            &mut vault,
            &mut sessions,
            "client-a",
            json!({"op":"rich_close","pinId":"1","queryId":query}),
        )
        .unwrap();
        call(
            &mut vault,
            &mut sessions,
            "client-a",
            json!({"op":"rich_close","pinId":"1","queryId":query}),
        )
        .unwrap();
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                "client-a",
                json!({"op":"rich_prepare","pinId":"1","queryId":query})
            )
            .unwrap_err()["code"],
            "search_expired"
        );
        sessions.release(&operation("client-a"));
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                "client-a",
                json!({"op":"rich_prepare","pinId":"1","queryId":other_query})
            )
            .unwrap_err()["code"],
            "snapshot_expired"
        );
    }
    #[test]
    fn rich_close_pin_and_rebuild_drop_guards_before_ack_and_compile_details_stay_typed() {
        let (_root, _cache, mut vault) = fixture(1);
        let mut sessions = Sessions::default();
        open(&mut vault, &mut sessions, "client", "1");
        let error = call(
            &mut vault,
            &mut sessions,
            "client",
            json!({"op":"rich_start","pinId":"1","spec":spec("/(?=a)/")}),
        )
        .unwrap_err();
        assert_eq!(error["code"], "search_compile");
        assert_eq!(error["details"]["diagnostic"]["code"], "unsupported-regex");
        assert!(error["details"]["diagnostic"]["queryRange"].is_object());
        assert_eq!(
            sessions.clients[&operation("client")].pins[&operation("1")]
                .rich_queries
                .len(),
            0
        );
        // Four is an upper bound, not a guaranteed admission count: the
        // unchanged native byte reservation may reject unprepared queries first.
        fn admitted_until_resource(
            vault: &mut NativeVault,
            sessions: &mut Sessions,
            pin: &str,
        ) -> Vec<Value> {
            let mut queries = Vec::new();
            for _ in 0..=MAX_RICH_QUERIES_PER_PIN {
                match call(
                    vault,
                    sessions,
                    "client",
                    json!({"op":"rich_start","pinId":pin,"spec":spec("file:Note")}),
                ) {
                    Ok(value) => queries.push(value["queryId"].clone()),
                    Err(error) => {
                        assert_eq!(error["code"], "search_resource");
                        assert!(
                            !queries.is_empty(),
                            "the isolated fixture must admit one query"
                        );
                        assert!(queries.len() <= MAX_RICH_QUERIES_PER_PIN);
                        assert_eq!(
                            sessions.clients[&operation("client")].pins[&operation(pin)]
                                .rich_queries
                                .len(),
                            queries.len(),
                            "failed admission must not register an orphan host guard",
                        );
                        return queries;
                    }
                }
            }
            panic!("rich query admission exceeded its unchanged upper bound");
        }
        let admitted_before = admitted_until_resource(&mut vault, &mut sessions, "1");
        call(
            &mut vault,
            &mut sessions,
            "client",
            json!({"op":"close","pinId":"1"}),
        )
        .unwrap();
        assert!(sessions.clients[&operation("client")].pins.is_empty());
        open(&mut vault, &mut sessions, "client", "2");
        let admitted_after = admitted_until_resource(&mut vault, &mut sessions, "2");
        assert_eq!(
            admitted_after.len(),
            admitted_before.len(),
            "pin close acknowledgement must release every actual native guard/reservation",
        );
        let query = &admitted_after[0];
        call(&mut vault, &mut sessions, "client", json!({"op":"rebuild"})).unwrap();
        assert!(sessions.clients[&operation("client")].pins.is_empty());
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                "client",
                json!({"op":"rich_prepare","pinId":"2","queryId":query})
            )
            .unwrap_err()["code"],
            "snapshot_expired"
        );
    }
    #[test]
    fn rich_transport_keeps_strict_request_and_independent_encoding_bounds() {
        for command in [
            json!({"op":"rich_page","pinId":"1","queryId":"q","cursor":{"offset":0}}),
            json!({"op":"rich_start","pinId":"1","spec":{"query":"x","caseSensitive":false,"sort":"nameAsc","context":"line","explain":false,"offset":0}}),
            json!({"op":"rich_prepare","pinId":"1","queryId":"q","maxWork":1}),
        ] {
            assert!(serde_json::from_value::<Request>(
                json!({"schemaVersion":1,"command":command})
            )
            .is_err());
        }
        let mut inner = Capped(Vec::new(), MAX_RICH_PAGE_BYTES);
        assert!(serde_json::to_writer(&mut inner, &"x".repeat(MAX_RICH_PAGE_BYTES)).is_err());
        assert_eq!(
            answer_with_limit(
                "rich_page",
                "x".repeat(MAX_RICH_RESPONSE_BYTES),
                MAX_RICH_RESPONSE_BYTES
            )
            .unwrap_err()["code"],
            "response_limit"
        );
        assert!(
            answer("metadata", "x".repeat(MAX_RICH_RESPONSE_BYTES)).is_ok(),
            "generic ceiling is unchanged"
        );
        assert_eq!(
            native(NativeDocumentError::QueryCancelled)["code"],
            "cancelled"
        );
        assert_eq!(
            native(NativeDocumentError::SearchBusy)["code"],
            "search_busy"
        );
        assert_eq!(
            native(NativeDocumentError::SearchExpired)["code"],
            "search_expired"
        );
        assert!(
            native(NativeDocumentError::SearchResource("/private/internal"))
                .get("details")
                .is_none()
        );
    }
}

#[cfg(test)]
mod metadata_rows_transport_tests {
    use super::rich_transport_tests::{call, fixture, open, operation};
    use super::*;
    use zorid_core::{Mutation, MutationRequest};
    fn decode(reply: (Value, Vec<u8>)) -> Value {
        assert!(reply.1.len() <= MAX_RESPONSE_BYTES);
        serde_json::from_slice::<Value>(&reply.1).unwrap()["value"].clone()
    }
    fn request(pin: &str, cursor: Option<Value>, limit: Option<usize>) -> Value {
        let mut value = json!({"op":"metadata_rows","pinId":pin});
        if let Some(cursor) = cursor {
            value["cursor"] = cursor;
        }
        if let Some(limit) = limit {
            value["limit"] = json!(limit);
        }
        value
    }
    fn publish(vault: &mut NativeVault) {
        let stage = vault.begin_document_index().unwrap();
        for _ in 0..10 {
            if vault.pump_document_index(&stage).unwrap().ready {
                vault.publish_document_index(&stage).unwrap();
                return;
            }
        }
        panic!("bounded metadata fixture did not publish");
    }
    #[test]
    fn reset_pages_have_exact_retry_handles_and_bounded_unique_rows() {
        let (_root, _cache, mut vault) = fixture(9);
        let mut sessions = Sessions::default();
        open(&mut vault, &mut sessions, "client", "1");
        let first_request = request("1", None, Some(2));
        let first = call(&mut vault, &mut sessions, "client", first_request.clone()).unwrap();
        assert_eq!(
            first,
            call(&mut vault, &mut sessions, "client", first_request).unwrap()
        );
        assert_eq!(first["result"]["value"]["mode"], "reset");
        let mut page = first;
        let mut ids = std::collections::BTreeSet::new();
        loop {
            for row in page["result"]["value"]["rows"].as_array().unwrap() {
                assert!(ids.insert(row["value"]["entry"]["id"].as_str().unwrap().to_owned()));
            }
            if page["cursor"].is_null() {
                break;
            }
            let next = request("1", Some(page["cursor"].clone()), None);
            page = call(&mut vault, &mut sessions, "client", next.clone()).unwrap();
            assert_eq!(
                page,
                call(&mut vault, &mut sessions, "client", next).unwrap()
            );
        }
        assert_eq!(ids.len(), 9);
        assert!(
            sessions.clients[&operation("client")].pins[&operation("1")]
                .cursors
                .len()
                <= 8
        );
    }
    #[test]
    fn delta_uses_actual_baseline_missing_history_resets_and_close_expires_continuation() {
        let (_root, _cache, mut vault) = fixture(2);
        let mut sessions = Sessions::default();
        open(&mut vault, &mut sessions, "client", "1");
        let old = sessions.clients[&operation("client")].pins[&operation("1")]
            .value
            .generation()
            .id()
            .clone();
        let read = vault
            .read(&EntryId::new("note-0").unwrap())
            .unwrap()
            .unwrap();
        vault
            .apply(&MutationRequest {
                operation_id: operation("update"),
                mutation: Mutation::Write {
                    id: EntryId::new("note-0").unwrap(),
                    expected: read.state.revision,
                    content: b"new metadata\n".to_vec(),
                },
            })
            .unwrap();
        publish(&mut vault);
        open(&mut vault, &mut sessions, "client", "2");
        let mut start = request("2", None, Some(1));
        start["baseline"] = json!({"pinId":"1","snapshot":old});
        let first = call(&mut vault, &mut sessions, "client", start.clone()).unwrap();
        assert_eq!(first["result"]["value"]["mode"], "delta");
        assert!(!first["cursor"].is_null());
        let mut bad = request("2", None, None);
        bad["baseline"] = json!({"pinId":"2","snapshot":old});
        assert_eq!(
            call(&mut vault, &mut sessions, "client", bad).unwrap_err()["code"],
            "query_mismatch"
        );
        call(
            &mut vault,
            &mut sessions,
            "client",
            json!({"op":"close","pinId":"1"}),
        )
        .unwrap();
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                "client",
                request("2", Some(first["cursor"].clone()), None)
            )
            .unwrap_err()["code"],
            "cursor_expired"
        );
        let reset = call(&mut vault, &mut sessions, "client", start).unwrap();
        assert_eq!(reset["result"]["value"]["mode"], "reset");
        assert!(reset["result"]["value"]["from"].is_null());
        // A foreign client's colliding numeric pin is never selected as history.
        open(&mut vault, &mut sessions, "other", "1");
        let mut unknown = request("2", None, None);
        unknown["baseline"] = json!({"pinId":"1","snapshot":old});
        assert_eq!(
            call(&mut vault, &mut sessions, "client", unknown).unwrap()["result"]["value"]["mode"],
            "reset"
        );
    }
    #[test]
    fn encoding_byte_failure_and_late_cancellation_keep_retry_checkpoint() {
        let (_root, _cache, mut vault) = fixture(2);
        let mut sessions = Sessions::default();
        open(&mut vault, &mut sessions, "client", "1");
        let args = (operation("client"), operation("1"));
        assert_eq!(
            metadata_rows_checked(
                &vault,
                &mut sessions,
                &args.0,
                args.1.clone(),
                None,
                None,
                Some(1),
                64,
                &mut || true
            )
            .unwrap_err()["code"],
            "response_limit"
        );
        let expected = decode(
            metadata_rows_checked(
                &vault,
                &mut sessions,
                &args.0,
                args.1.clone(),
                None,
                None,
                Some(1),
                MAX_RESPONSE_BYTES,
                &mut || true,
            )
            .unwrap(),
        );
        let mut calls = 0;
        let repeat = decode(
            metadata_rows_checked(
                &vault,
                &mut sessions,
                &args.0,
                args.1.clone(),
                None,
                None,
                Some(1),
                MAX_RESPONSE_BYTES,
                &mut || {
                    calls += 1;
                    true
                },
            )
            .unwrap(),
        );
        assert_eq!(repeat, expected);
        assert!(calls > 4);
        let mut seen = 0;
        assert_eq!(
            metadata_rows_checked(
                &vault,
                &mut sessions,
                &args.0,
                args.1.clone(),
                None,
                None,
                Some(1),
                MAX_RESPONSE_BYTES,
                &mut || {
                    seen += 1;
                    seen != calls - 2
                }
            )
            .unwrap_err()["code"],
            "cancelled"
        );
        assert_eq!(
            decode(
                metadata_rows_checked(
                    &vault,
                    &mut sessions,
                    &args.0,
                    args.1,
                    None,
                    None,
                    Some(1),
                    MAX_RESPONSE_BYTES,
                    &mut || true
                )
                .unwrap()
            ),
            expected
        );
    }
    #[test]
    fn metadata_shares_four_pin_and_eight_cursor_limits_and_rejects_profile_changes() {
        for command in [
            json!({"op":"metadata_rows","pinId":"1","baseline":null}),
            json!({"op":"metadata_rows","pinId":"1","limit":null}),
            json!({"op":"metadata_rows","pinId":"1","limit":1.5}),
            json!({"op":"metadata_rows","pinId":"1","unexpected":true}),
        ] {
            assert!(serde_json::from_value::<Request>(
                json!({"schemaVersion":1,"command":command})
            )
            .is_err());
        }
        let (_root, _cache, mut vault) = fixture(12);
        let mut sessions = Sessions::default();
        for id in ["1", "2", "3", "4"] {
            open(&mut vault, &mut sessions, "client", id);
        }
        assert!(call(
            &mut vault,
            &mut sessions,
            "client",
            json!({"op":"open","pinId":"5"})
        )
        .is_err());
        let first = call(
            &mut vault,
            &mut sessions,
            "client",
            request("1", None, Some(1)),
        )
        .unwrap();
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                "client",
                request("1", Some(first["cursor"].clone()), Some(2))
            )
            .unwrap_err()["code"],
            "query_mismatch"
        );
        for limit in 2..=10 {
            call(
                &mut vault,
                &mut sessions,
                "client",
                request("1", None, Some(limit)),
            )
            .unwrap();
            assert!(
                sessions.clients[&operation("client")].pins[&operation("1")]
                    .cursors
                    .len()
                    <= MAX_CURSORS_PER_PIN
            );
        }
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                "client",
                request("1", Some(first["cursor"].clone()), None)
            )
            .unwrap_err()["code"],
            "cursor_expired"
        );
        sessions.release(&operation("client"));
        assert!(sessions.clients.is_empty());
        // Pure cursor generation Arcs have not secretly extended the pin count.
        assert!(vault.open_document_snapshot().is_ok());
    }
}

#[cfg(test)]
mod metadata_rows_expiry_tests {
    use super::rich_transport_tests::{call, fixture, open, operation};
    use super::*;
    #[test]
    fn independent_rebuild_retires_only_proven_expired_registrations_and_frees_slots() {
        let (root, cache, mut vault) = fixture(1);
        let mut sessions = Sessions::default();
        for id in ["1", "2", "3", "4"] {
            open(&mut vault, &mut sessions, "client", id);
        }
        let mut peer = NativeVault::open_existing(root.path()).unwrap();
        peer.enable_local_document_cache(cache.path().join("cache.sqlite"))
            .unwrap();
        peer.rebuild_document_index().unwrap();
        for id in ["1", "2", "3", "4"] {
            let error = call(
                &mut vault,
                &mut sessions,
                "client",
                json!({"op":"metadata_rows","pinId":id}),
            )
            .unwrap_err();
            assert_eq!(error["code"], "snapshot_expired");
            assert!(!sessions.clients[&operation("client")]
                .pins
                .contains_key(&operation(id)));
        }
        let stage = peer.begin_document_index().unwrap();
        assert!(peer.pump_document_index(&stage).unwrap().ready);
        peer.publish_document_index(&stage).unwrap();
        open(&mut vault, &mut sessions, "client", "5");
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                "client",
                json!({"op":"metadata_rows","pinId":"5"})
            )
            .unwrap()["result"]["value"]["rows"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}

#[cfg(test)]
#[path = "document_preview_tests.rs"]
mod preview_tests;
