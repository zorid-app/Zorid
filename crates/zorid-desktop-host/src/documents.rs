//! Admitted semantic transport. Pins/tokens stay Rust objects; JSON is a report,
//! never a capability. Typed serialization preserves recursive YAML map order.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};
use zorid_core::{EntryId, OperationId};
use zorid_native::{
    DocumentQueryPin, IndexSnapshotId, LiteralQuery, LiteralToken, NativeDocumentError,
    NativeVault, QueryOptions, RelationshipToken,
};

pub(crate) const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
// Independent search/backlink/Base views may retain separate lifetimes; the
// native Store also enforces its global four-pin ceiling across all clients.
const MAX_PINS_PER_CLIENT: usize = 4;
const MAX_CURSORS_PER_PIN: usize = 8;

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
    Metadata {
        pin_id: OperationId,
        id: EntryId,
    },
    Search {
        pin_id: OperationId,
        query: String,
        cursor: Option<OperationId>,
        limit: usize,
    },
    Backlinks {
        pin_id: OperationId,
        id: EntryId,
        cursor: Option<OperationId>,
        limit: usize,
    },
    Base {
        pin_id: OperationId,
        id: EntryId,
        view_name: Option<String>,
        #[serde(default)]
        options: BaseOptions,
    },
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
        if self.max_rows == 0 || self.max_rows > 10_000 || self.view_index > 1000 {
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
        Ok(options)
    }
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
#[derive(Clone, PartialEq, Eq)]
enum Cursor {
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
    value: DocumentQueryPin,
    cursors: BTreeMap<OperationId, Cursor>,
    cursor_order: VecDeque<OperationId>,
    next_cursor: u64,
    cursor_prefix: String,
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
}
#[derive(Default)]
pub(crate) struct Sessions {
    clients: BTreeMap<OperationId, Client>,
}
impl Sessions {
    pub(crate) fn release(&mut self, client: &OperationId) {
        self.clients.remove(client); // Drop releases even already-expired pins.
    }
}
fn failure(code: &str) -> Value {
    json!({"code":code,"commit_uncertain":false,"message":"Document query failed; authoritative source remains unchanged"})
}
fn native(error: NativeDocumentError) -> Value {
    failure(error.code())
}
struct Capped(Vec<u8>);
impl Write for Capped {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_RESPONSE_BYTES {
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
    let mut body = Capped(Vec::new());
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
        | Backlinks { pin_id, .. }
        | Base { pin_id, .. } => Some(pin_id.clone()),
        _ => None,
    };
    let result = (|| {
        match request.command {
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
                if !client.pins.contains_key(&pin_id) {
                    if sequence <= client.last_open {
                        return Err(failure("snapshot_expired"));
                    }
                    if client.pins.len() >= MAX_PINS_PER_CLIENT {
                        return Err(failure("pin_capacity"));
                    }
                    let value = vault.open_document_snapshot().map_err(native)?;
                    client.last_open = sequence;
                    client.pins.insert(
                        pin_id.clone(),
                        Pin {
                            value,
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
            Close { pin_id } => {
                let sequence = pin_sequence(&pin_id)?;
                let client = sessions.clients.entry(client.clone()).or_default();
                if client.pins.remove(&pin_id).is_none() && sequence > client.last_open {
                    return Err(failure("snapshot_expired"));
                }
                answer("close", true)
            }
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
}
