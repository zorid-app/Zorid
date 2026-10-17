//! Synchronous trusted-host v2 planning. No persistence and no authenticated
//! plaintext constructor. The host must commit BOTH plans and its common wire
//! ledger/cursor atomically; a text plan alone never authorizes visibility.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zorid_client_sync::{self as text, v2, AuthorRequest, ReceiveRequest, TextIdentity, TextState};
use zorid_core::Revision;
use zorid_file_sync::v2 as files;
use zorid_sync_protocol::MAX_WIRE_BYTES;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
// Two states plus a bounded exact-wire prior and request fit the input envelope.
const MAX_STATE_JSON_BYTES: usize = 8 * 1024 * 1024;
fn reusable_state(value: &impl Serialize) -> Result<()> {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_STATE_JSON_BYTES.saturating_sub(self.0) {
                return Err(std::io::Error::other(
                    "state exceeds reusable binding budget",
                ));
            }
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Count(0), value)
        .map_err(|_| "state exceeds reusable binding budget".into())
}
fn reusable_graph(graph: &files::FilePlan) -> Result<()> {
    reusable_state(&graph.expected_state)?;
    if let Some(next) = &graph.next_state {
        reusable_state(next)?;
    }
    Ok(())
}
fn reusable_text_author(text: &text::AuthoredPlan, graph: &files::FilePlan) -> Result<()> {
    reusable_state(&text.expected_state)?;
    reusable_state(&text.next_state)?;
    reusable_graph(graph)
}
fn reusable_text_receive(text: &text::ReceivedPlan, graph: &files::FilePlan) -> Result<()> {
    reusable_state(&text.expected_state)?;
    if let Some(next) = &text.next_state {
        reusable_state(next)?;
    }
    reusable_graph(graph)
}
type Result<T> = std::result::Result<T, String>;
fn error(value: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&value.to_string())
}
fn parse<T: DeserializeOwned>(json: &str) -> Result<T> {
    if json.len() > MAX_INPUT_BYTES {
        return Err("sync input too large".into());
    }
    serde_json::from_str(json).map_err(|_| "invalid sync input".into())
}
// Bound serialization while writing, rather than only after allocating output.
struct BoundedOutput(Vec<u8>);
impl std::io::Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_OUTPUT_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("sync output too large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn json(value: &impl Serialize) -> Result<String> {
    let mut out = BoundedOutput(Vec::new());
    serde_json::to_writer(&mut out, value).map_err(|_| "invalid or oversized sync output")?;
    String::from_utf8(out.0).map_err(|_| "invalid sync output".into())
}
fn domain<T>(result: std::result::Result<T, impl std::fmt::Display>) -> Result<T> {
    result.map_err(|e| e.to_string())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyInput {
    identity: TextIdentity,
    version: Revision,
}
#[wasm_bindgen(js_name = createEmptyTextState)]
pub fn create_empty_text_state(input: &str) -> std::result::Result<String, JsValue> {
    let input: EmptyInput = parse(input).map_err(error)?;
    json(&TextState::empty(input.identity, input.version)).map_err(error)
}
#[wasm_bindgen(js_name = materializeTextState)]
pub fn materialize_text_state(input: &str) -> std::result::Result<Vec<u8>, JsValue> {
    let state: TextState = parse(input).map_err(error)?;
    reusable_state(&state).map_err(error)?;
    state.materialized_utf8().map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplaceInput {
    state: TextState,
    namespace_state: files::State,
    request: AuthorRequest,
    namespace: v2::TextNamespaceContext,
    next_namespace_version: Revision,
}
#[derive(Serialize)]
struct GraphOutput<'a> {
    next_state: &'a Option<files::State>,
    view: &'a files::VaultView,
}
#[derive(Serialize)]
struct PlanOutput<'a, T> {
    text: &'a T,
    namespace: GraphOutput<'a>,
}
fn output<T: Serialize>(text: &T, graph: &files::FilePlan) -> Result<String> {
    json(&PlanOutput {
        text,
        namespace: GraphOutput {
            next_state: &graph.next_state,
            view: &graph.view,
        },
    })
}
#[wasm_bindgen]
pub struct WasmAuthoredTextPlan {
    text: text::AuthoredPlan,
    graph: files::FilePlan,
}
fn replace(input: &str, desired: &[u8]) -> Result<WasmAuthoredTextPlan> {
    if desired.len() > text::MAX_TEXT_BYTES {
        return Err("text too large".into());
    }
    let input: ReplaceInput = parse(input)?;
    let authored = domain(v2::plan_replace_text(
        &input.state,
        desired,
        &input.request,
        &input.namespace,
    ))?;
    let graph = domain(files::plan_authored_text_activity(
        &input.namespace_state,
        authored.activity(),
        input.next_namespace_version,
    ))?;
    reusable_text_author(authored.plan(), &graph)?;
    Ok(WasmAuthoredTextPlan {
        text: authored.into_plan(),
        graph,
    })
}
#[wasm_bindgen(js_name = planTextReplace)]
pub fn plan_text_replace(
    input: &str,
    desired: &[u8],
) -> std::result::Result<WasmAuthoredTextPlan, JsValue> {
    replace(input, desired).map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorCheck {
    state: TextState,
    namespace_state: files::State,
    update_id_unused: bool,
}
#[wasm_bindgen]
impl WasmAuthoredTextPlan {
    #[wasm_bindgen(js_name = metadataJson)]
    pub fn metadata_json(&self) -> std::result::Result<String, JsValue> {
        let value = &self.text.authored;
        json(
            &metadata(
                "text",
                &value.identity.realm_id,
                &value.identity.vault_id,
                &value.update_id,
                &value.payload_bytes,
                Some(&value.identity),
            )
            .map_err(error)?,
        )
        .map_err(error)
    }
    #[wasm_bindgen(js_name = resultJson)]
    pub fn result_json(&self) -> std::result::Result<String, JsValue> {
        output(&self.text, &self.graph).map_err(error)
    }
    /// Run against actual current values read INSIDE the committing transaction.
    /// update_id_unused covers the common family ledger, not a text-only table.
    #[wasm_bindgen(js_name = checkPreconditions)]
    pub fn check_preconditions(&self, input: &str) -> std::result::Result<(), JsValue> {
        self.check(input).map_err(error)
    }
}
impl WasmAuthoredTextPlan {
    fn check(&self, input: &str) -> Result<()> {
        let actual: AuthorCheck = parse(input)?;
        domain(
            self.text
                .check_preconditions(&actual.state, None, actual.update_id_unused),
        )?;
        domain(self.graph.check_preconditions(&actual.namespace_state))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiveInput {
    state: TextState,
    namespace_state: files::State,
    request: ReceiveRequest,
    next_namespace_version: Revision,
    prior: Option<text::ReceivedRecord>,
    cursor: Option<text::ReceiveCursor>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiveCheck {
    state: TextState,
    namespace_state: files::State,
    prior: Option<text::ReceivedRecord>,
    cursor: Option<text::ReceiveCursor>,
}
#[wasm_bindgen]
pub struct WasmReceivedTextPlan {
    text: text::ReceivedPlan,
    graph: files::FilePlan,
}
// Context is separately parsed/bounded and independently chosen by the trusted
// host; header routing cannot supply the expected realm/vault/key epoch.
pub(crate) fn receive(
    key: &zorid_crypto::VaultKey,
    context_json: &str,
    input: &str,
    wire: &[u8],
) -> Result<WasmReceivedTextPlan> {
    if wire.len() > MAX_WIRE_BYTES {
        return Err("envelope too large".into());
    }
    let context = super::crypto::context(context_json)?;
    let input: ReceiveInput = parse(input)?;
    let incoming = domain(v2::AuthenticatedText::open(wire, &context, key))?;
    let text = domain(v2::plan_received_text(
        &input.state,
        &input.request,
        &incoming,
        input.prior.as_ref(),
        input.cursor.as_ref(),
    ))?;
    let graph = domain(files::plan_received_text_activity(
        &input.namespace_state,
        incoming.activity(),
        input.next_namespace_version,
    ))?;
    if input.prior.is_some() && graph.next_state.is_some() {
        return Err("received text/namespace history mismatch".into());
    }
    reusable_text_receive(&text, &graph)?;
    Ok(WasmReceivedTextPlan { text, graph })
}
#[wasm_bindgen]
impl WasmReceivedTextPlan {
    #[wasm_bindgen(js_name = resultJson)]
    pub fn result_json(&self) -> std::result::Result<String, JsValue> {
        output(&self.text, &self.graph).map_err(error)
    }
    #[wasm_bindgen(js_name = checkPreconditions)]
    pub fn check_preconditions(&self, input: &str) -> std::result::Result<(), JsValue> {
        self.check(input).map_err(error)
    }
}
impl WasmReceivedTextPlan {
    fn check(&self, input: &str) -> Result<()> {
        let actual: ReceiveCheck = parse(input)?;
        domain(self.text.check_preconditions(
            &actual.state,
            actual.prior.as_ref(),
            actual.cursor.as_ref(),
        ))?;
        domain(self.graph.check_preconditions(&actual.namespace_state))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HelloExpected {
    realm_id: zorid_sync_protocol::RealmId,
    server_epoch: zorid_sync_protocol::ServerEpoch,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedExpected {
    vault_id: zorid_sync_protocol::VaultId,
    update_id: zorid_sync_protocol::UpdateId,
    server_epoch: zorid_sync_protocol::ServerEpoch,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorInput {
    server_epoch: zorid_sync_protocol::ServerEpoch,
    after: zorid_sync_protocol::LogPosition,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageExpected {
    server_epoch: zorid_sync_protocol::ServerEpoch,
    after: zorid_sync_protocol::LogPosition,
    through: Option<zorid_sync_protocol::LogPosition>,
}
fn control<T: DeserializeOwned>(input: &str) -> Result<T> {
    if input.len() > zorid_sync_protocol::MAX_CONTROL_BYTES {
        return Err("sync context too large".into());
    }
    parse(input)
}
#[wasm_bindgen(js_name = encodeSyncCursor)]
pub fn encode_sync_cursor(input: &str) -> std::result::Result<String, JsValue> {
    let input: CursorInput = control(input).map_err(error)?;
    json(&zorid_sync_protocol::Cursor::new(
        input.server_epoch,
        input.after,
    ))
    .map_err(error)
}
#[wasm_bindgen(js_name = decodeSyncHello)]
pub fn decode_sync_hello(expected: &str, raw: &[u8]) -> std::result::Result<(), JsValue> {
    let expected: HelloExpected = control(expected).map_err(error)?;
    zorid_sync_protocol::transport::decode_hello(raw, &expected.realm_id, &expected.server_epoch)
        .map_err(error)
}
#[wasm_bindgen(js_name = decodeSyncAccepted)]
pub fn decode_sync_accepted(expected: &str, raw: &[u8]) -> std::result::Result<String, JsValue> {
    let expected: AcceptedExpected = control(expected).map_err(error)?;
    let accepted = zorid_sync_protocol::transport::decode_accepted(
        raw,
        &expected.vault_id,
        &expected.update_id,
        &expected.server_epoch,
    )
    .map_err(error)?;
    json(&accepted).map_err(error)
}
#[wasm_bindgen(js_name = decodeSyncPage)]
pub fn decode_sync_page(expected: &str, raw: &[u8]) -> std::result::Result<String, JsValue> {
    let expected: PageExpected = control(expected).map_err(error)?;
    let cursor = zorid_sync_protocol::Cursor::new(expected.server_epoch, expected.after);
    let page = zorid_sync_protocol::transport::decode_page(raw, &cursor, expected.through)
        .map_err(error)?;
    json(&page).map_err(error)
}

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyFileInput {
    scope: zorid_file_sync::Scope,
    version: Revision,
}
#[wasm_bindgen(js_name = createEmptyFileState)]
pub fn create_empty_file_state(input: &str) -> std::result::Result<String, JsValue> {
    let input: EmptyFileInput = parse(input).map_err(error)?;
    json(&files::State::empty(input.scope, input.version)).map_err(error)
}
#[wasm_bindgen(js_name = inspectFileState)]
pub fn inspect_file_state(input: &str) -> std::result::Result<String, JsValue> {
    let state: files::State = parse(input).map_err(error)?;
    reusable_state(&state).map_err(error)?;
    json(&state.view().map_err(error)?).map_err(error)
}
// JSON byte array or null preserves 'missing chunks' separately from empty bytes.
#[wasm_bindgen(js_name = materializeFile)]
pub fn materialize_file(state: &str, manifest: &str) -> std::result::Result<String, JsValue> {
    let state: files::State = parse(state).map_err(error)?;
    let manifest: zorid_file_sync::Manifest = parse(manifest).map_err(error)?;
    if manifest.bytes > ((MAX_OUTPUT_BYTES - 2) / 4) as u64 {
        return Err(error("materialized file too large for JSON binding"));
    }
    json(&state.materialize(&manifest).map_err(error)?).map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileAuthorInput {
    state: files::State,
    payload: files::Payload,
    next_version: Revision,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileAuthorCheck {
    state: files::State,
    update_id_unused: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileReceiveInput {
    state: files::State,
    prior: Option<zorid_file_sync::WireRecord>,
    next_version: Revision,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileReceiveCheck {
    state: files::State,
    prior: Option<zorid_file_sync::WireRecord>,
}
#[wasm_bindgen]
pub struct WasmAuthoredFilePlan {
    plan: files::AuthoredPlan,
}
#[wasm_bindgen(js_name = planFileMutation)]
pub fn plan_file_mutation(input: &str) -> std::result::Result<WasmAuthoredFilePlan, JsValue> {
    let input: FileAuthorInput = parse(input).map_err(error)?;
    let plan =
        files::plan_authored(&input.state, &input.payload, input.next_version).map_err(error)?;
    reusable_graph(&plan.graph).map_err(error)?;
    Ok(WasmAuthoredFilePlan { plan })
}
#[wasm_bindgen]
impl WasmAuthoredFilePlan {
    #[wasm_bindgen(js_name = metadataJson)]
    pub fn metadata_json(&self) -> std::result::Result<String, JsValue> {
        let value = &self.plan.payload;
        json(
            &metadata(
                "files",
                &value.scope.realm_id,
                &value.scope.vault_id,
                &value.id,
                &self.plan.payload_bytes,
                None,
            )
            .map_err(error)?,
        )
        .map_err(error)
    }
    #[wasm_bindgen(js_name = resultJson)]
    pub fn result_json(&self) -> std::result::Result<String, JsValue> {
        #[derive(Serialize)]
        struct Output<'a> {
            namespace: GraphOutput<'a>,
            payload: &'a files::Payload,
            payload_bytes: &'a [u8],
        }
        json(&Output {
            namespace: GraphOutput {
                next_state: &self.plan.graph.next_state,
                view: &self.plan.graph.view,
            },
            payload: &self.plan.payload,
            payload_bytes: &self.plan.payload_bytes,
        })
        .map_err(error)
    }
    #[wasm_bindgen(js_name = checkPreconditions)]
    pub fn check_preconditions(&self, input: &str) -> std::result::Result<(), JsValue> {
        let input: FileAuthorCheck = parse(input).map_err(error)?;
        self.plan
            .check_preconditions(&input.state, input.update_id_unused)
            .map_err(error)
    }
}
#[wasm_bindgen]
pub struct WasmReceivedFilePlan {
    plan: files::ReceivedPlan,
}
#[wasm_bindgen]
impl WasmReceivedFilePlan {
    #[wasm_bindgen(js_name = resultJson)]
    pub fn result_json(&self) -> std::result::Result<String, JsValue> {
        #[derive(Serialize)]
        struct Output<'a> {
            namespace: GraphOutput<'a>,
            received_record: &'a zorid_file_sync::WireRecord,
        }
        json(&Output {
            namespace: GraphOutput {
                next_state: &self.plan.graph.next_state,
                view: &self.plan.graph.view,
            },
            received_record: &self.plan.received_record,
        })
        .map_err(error)
    }
    #[wasm_bindgen(js_name = checkPreconditions)]
    pub fn check_preconditions(&self, input: &str) -> std::result::Result<(), JsValue> {
        let input: FileReceiveCheck = parse(input).map_err(error)?;
        self.plan
            .check_preconditions(&input.state, input.prior.as_ref())
            .map_err(error)
    }
}
enum AuthenticatedFamily {
    Text(v2::AuthenticatedText),
    Files(files::AuthenticatedPayload),
}
#[wasm_bindgen]
pub struct WasmSyncUpdate {
    family: AuthenticatedFamily,
    metadata: serde_json::Value,
    wire: Vec<u8>,
}
pub(crate) fn open_update(
    key: &zorid_crypto::VaultKey,
    context: &str,
    wire: &[u8],
) -> Result<WasmSyncUpdate> {
    if wire.len() > MAX_WIRE_BYTES {
        return Err("envelope too large".into());
    }
    let expected = super::crypto::context(context)?;
    let opened = domain(zorid_crypto::OpenedEnvelope::open(wire, &expected, key))?;
    #[derive(Deserialize)]
    struct Tag {
        family: String,
        format_version: u32,
    }
    let tag: Tag =
        serde_json::from_slice(opened.plaintext()).map_err(|_| "invalid sync payload")?;
    if tag.format_version != 2 {
        return Err("unsupported sync format".into());
    }
    let family = match tag.family.as_str() {
        "text" => AuthenticatedFamily::Text(domain(v2::AuthenticatedText::from_opened(&opened))?),
        "files" => {
            AuthenticatedFamily::Files(domain(files::AuthenticatedPayload::from_opened(&opened))?)
        }
        _ => return Err("unsupported sync family".into()),
    };
    let identity = match &family {
        AuthenticatedFamily::Text(value) => Some(value.identity()),
        _ => None,
    };
    let header = opened.header();
    let metadata = metadata(
        &tag.family,
        header.realm_id(),
        header.vault_id(),
        header.update_id(),
        opened.plaintext(),
        identity,
    )?;
    Ok(WasmSyncUpdate {
        family,
        metadata,
        wire: wire.to_vec(),
    })
}
fn metadata(
    family: &str,
    realm: &zorid_sync_protocol::RealmId,
    vault: &zorid_sync_protocol::VaultId,
    update: &zorid_sync_protocol::UpdateId,
    payload: &[u8],
    identity: Option<&TextIdentity>,
) -> Result<serde_json::Value> {
    let binding = if let Some(identity) = identity {
        let inspected = domain(v2::inspect_payload(payload, update))?;
        if &inspected.identity != identity {
            return Err("text metadata identity mismatch".into());
        }
        Some(
            serde_json::json!({"entry_id":identity.entry_id,"text_bootstrap_id":identity.bootstrap_id,"namespace":inspected.namespace}),
        )
    } else {
        None
    };
    Ok(
        serde_json::json!({"key":{"realm_id":realm,"vault_id":vault,"update_id":update},
        "family":family,"format_version":2,"payload_digest":zorid_file_sync::Sha256Digest::of(payload),
        "payload_bytes":payload.len() as u32,"text_binding":binding}),
    )
}
#[wasm_bindgen]
impl WasmSyncUpdate {
    /// Exact plaintext comparison for the trusted host's seal-winner CAS.
    #[wasm_bindgen(js_name = matchesPayload)]
    pub fn matches_payload(&self, payload: &[u8]) -> bool {
        if payload.len() > zorid_sync_protocol::MAX_PLAINTEXT_BYTES {
            return false;
        }
        match &self.family {
            AuthenticatedFamily::Text(value) => value.activity().payload_bytes() == payload,
            AuthenticatedFamily::Files(value) => value.payload_bytes() == payload,
        }
    }
    #[wasm_bindgen(js_name = metadataJson)]
    pub fn metadata_json(&self) -> std::result::Result<String, JsValue> {
        json(&self.metadata).map_err(error)
    }
    #[wasm_bindgen(js_name = exactWire)]
    pub fn exact_wire(&self) -> Vec<u8> {
        self.wire.clone()
    }
    #[wasm_bindgen(js_name = planText)]
    pub fn plan_text(&self, input: &str) -> std::result::Result<WasmReceivedTextPlan, JsValue> {
        let incoming = match &self.family {
            AuthenticatedFamily::Text(value) => value,
            _ => return Err(error("wrong sync family")),
        };
        let input: ReceiveInput = parse(input).map_err(error)?;
        let text = v2::plan_received_text(
            &input.state,
            &input.request,
            incoming,
            input.prior.as_ref(),
            input.cursor.as_ref(),
        )
        .map_err(error)?;
        let graph = files::plan_received_text_activity(
            &input.namespace_state,
            incoming.activity(),
            input.next_namespace_version,
        )
        .map_err(error)?;
        if input.prior.is_some() && graph.next_state.is_some() {
            return Err(error("received text/namespace history mismatch"));
        }
        reusable_text_receive(&text, &graph).map_err(error)?;
        Ok(WasmReceivedTextPlan { text, graph })
    }
    #[wasm_bindgen(js_name = planFile)]
    pub fn plan_file(&self, input: &str) -> std::result::Result<WasmReceivedFilePlan, JsValue> {
        let incoming = match &self.family {
            AuthenticatedFamily::Files(value) => value,
            _ => return Err(error("wrong sync family")),
        };
        let input: FileReceiveInput = parse(input).map_err(error)?;
        let plan = files::plan_received(
            &input.state,
            incoming,
            input.prior.as_ref(),
            input.next_version,
        )
        .map_err(error)?;
        reusable_graph(&plan.graph).map_err(error)?;
        Ok(WasmReceivedFilePlan { plan })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredKey {
    realm_id: zorid_sync_protocol::RealmId,
    vault_id: zorid_sync_protocol::VaultId,
    update_id: zorid_sync_protocol::UpdateId,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredTextBinding {
    entry_id: zorid_core::EntryId,
    text_bootstrap_id: zorid_sync_protocol::UpdateId,
    namespace: v2::TextNamespaceContext,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredMetadata {
    key: StoredKey,
    family: String,
    format_version: u32,
    payload_digest: zorid_file_sync::Sha256Digest,
    payload_bytes: u32,
    text_binding: Option<StoredTextBinding>,
}
fn stored_metadata(input: &str) -> Result<StoredMetadata> {
    let value: StoredMetadata = control(input)?;
    if value.format_version != 2
        || value.payload_bytes == 0
        || value.payload_bytes as usize > zorid_sync_protocol::MAX_PLAINTEXT_BYTES
        || !matches!(value.family.as_str(), "text" | "files")
        || (value.family == "text") != value.text_binding.is_some()
    {
        return Err("invalid stored sync metadata".into());
    }
    Ok(value)
}
fn validate_payload(input: &str, payload: &[u8]) -> Result<()> {
    if payload.len() > zorid_sync_protocol::MAX_PLAINTEXT_BYTES {
        return Err("payload too large".into());
    }
    let expected = stored_metadata(input)?;
    let actual = if expected.family == "text" {
        let inspected = domain(v2::inspect_payload(payload, &expected.key.update_id))?;
        metadata(
            "text",
            &inspected.identity.realm_id,
            &inspected.identity.vault_id,
            &expected.key.update_id,
            payload,
            Some(&inspected.identity),
        )?
    } else {
        let inspected = domain(files::Payload::decode(payload))?;
        metadata(
            "files",
            &inspected.scope.realm_id,
            &inspected.scope.vault_id,
            &inspected.id,
            payload,
            None,
        )?
    };
    if serde_json::to_value(expected).map_err(|_| "invalid stored sync metadata")? != actual {
        return Err("stored sync payload mismatch".into());
    }
    Ok(())
}
/// Validates retained authored bytes only. It does not authenticate remote data
/// and returns no activity or authenticated capability.
#[wasm_bindgen(js_name = validateAuthoredSyncPayload)]
pub fn validate_authored_sync_payload(
    input: &str,
    payload: &[u8],
) -> std::result::Result<(), JsValue> {
    validate_payload(input, payload).map_err(error)
}
fn validate_wire(input: &str, wire: &[u8]) -> Result<()> {
    if wire.len() > MAX_WIRE_BYTES {
        return Err("envelope too large".into());
    }
    let expected = stored_metadata(input)?;
    let envelope = domain(zorid_sync_protocol::Envelope::decode(wire))?;
    let header = envelope.header();
    if header.realm_id() != &expected.key.realm_id
        || header.vault_id() != &expected.key.vault_id
        || header.update_id() != &expected.key.update_id
    {
        return Err("stored sync wire mismatch".into());
    }
    Ok(())
}
/// Framing and identity consistency only; without the key this cannot verify
/// AEAD, encrypted family/digest, or independently authorized key epoch.
#[wasm_bindgen(js_name = validateSyncWire)]
pub fn validate_sync_wire(input: &str, wire: &[u8]) -> std::result::Result<(), JsValue> {
    validate_wire(input, wire).map_err(error)
}

fn encode_file_payload(input: &str) -> Result<Vec<u8>> {
    // Decode raw JSON directly: parsing into JS objects first loses duplicate keys.
    let payload = domain(files::Payload::decode(input.as_bytes()))?;
    domain(payload.encode())
}
/// Strict canonical bytes for local authored intent retry comparison, not a
/// namespace plan or authentication capability.
#[wasm_bindgen(js_name = encodeFilePayload)]
pub fn encode_file_payload_binding(input: &str) -> std::result::Result<Vec<u8>, JsValue> {
    encode_file_payload(input).map_err(error)
}

fn retained_file(state_json: &str, identity_json: &str, event_id: &str) -> Result<String> {
    let state: files::State = parse(state_json)?;
    reusable_state(&state)?;
    let identity: zorid_file_sync::EntryIdentity = control(identity_json)?;
    if event_id.len() > zorid_sync_protocol::MAX_CONTROL_BYTES {
        return Err("event identity too large".into());
    }
    let event_id = domain(zorid_sync_protocol::UpdateId::new(event_id))?;
    // Numeric JSON bytes require at most four bytes each plus outer brackets.
    // Enforce before portable materialization allocates the expanded file.
    let bytes = domain(state.materialize_retained_binary_bounded(
        &identity,
        &event_id,
        ((MAX_OUTPUT_BYTES - 2) / 4) as u64,
    ))?;
    json(&bytes)
}
/// Validate the immutable historical content witness and materialize in Rust.
/// null means missing dependencies; [] is a verified empty file. Historical
/// bytes do not authorize publication at the current live path.
#[wasm_bindgen(js_name = materializeRetainedFile)]
pub fn materialize_retained_file(
    state_json: &str,
    identity_json: &str,
    event_id: &str,
) -> std::result::Result<String, JsValue> {
    retained_file(state_json, identity_json, event_id).map_err(error)
}
