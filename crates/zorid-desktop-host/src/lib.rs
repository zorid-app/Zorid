//! Private desktop transport only. Storage, recovery and conflict policy belong
//! to NativeVault. No listener, daemon, filesystem writes or alternate store here.
mod binary;
mod documents;
mod document_runtime;
mod document_drafts;
mod recovery;
mod workblocks;
mod embedded_fixture_sync;
mod staged_import;
pub use staged_import::{
    ImportProgress, TrustedImportSelection, TrustedStagedImportSource, MAX_IMPORT_RESULT_BYTES,
};
pub use embedded_fixture_sync::{
    EmbeddedFixtureSyncLimits, MobileFixtureReport, MobileFixtureStatus, TrustedFixtureSyncOptions,
    MAX_EMBEDDED_FIXTURE_RESULT_BYTES,
};
mod family;
use family::WireFamilyCommand;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, Revision, VaultPath};
use zorid_native::{
    ClientAdmissionError, ClientLease, ClientLeaseRef, HostIntentAcknowledgment, HostIntentRef,
    NativeVault, ProjectionStatus,
};
use zorid_native_sync::FixtureSync;
use zorid_store::{Checkpoint, CheckpointError, CheckpointScope, CheckpointWrite};

const MAX_HEADER: usize = 1024 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_CHECKPOINT_BODY: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    request_id: String,
    command: Command,
    lease: Option<ClientLeaseRef>,
}
#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    RecoveryList {
        entry_id: EntryId,
        limit: usize,
        before: Option<recovery::Cursor>,
    },
    RecoveryRead {
        entry_id: EntryId,
        snapshot_id: String,
    },
    Workblocks { client_id: OperationId, request: workblocks::Request },
    Documents {
        client_id: OperationId,
        request: documents::Request,
    },
    Binary {
        client_id: OperationId,
    },
    DocumentDrafts {
        client_id: OperationId,
        request: document_drafts::Request,
    },
    DocumentWork {
        request: document_drafts::WorkRequest,
    },
    FixtureFamilyEnroll,
    FixtureFamilyStatus,
    FixtureFamilyOnce {
        max_push: u32,
        max_pages: u32,
    },
    FixtureFamilyApply {
        family: WireFamilyCommand,
    },
    FileCommand {
        client_id: OperationId,
        family: WireFamilyCommand,
    },
    FileCommandCompact {
        client_id: OperationId,
        family: WireFamilyCommand,
    },
    FileCommandStatus {
        client_id: OperationId,
        family: WireFamilyCommand,
    },
    CreateText {
        client_id: OperationId,
        operation_id: OperationId,
        id: EntryId,
        path: VaultPath,
    },
    Identity,
    ClaimClient {
        client_id: OperationId,
    },
    ReleaseClient {
        reference: ClientLeaseRef,
    },
    CheckpointLoad {
        scope: CheckpointScope,
        key: String,
    },
    CheckpointCas {
        scope: CheckpointScope,
        key: String,
        expected_revision: Option<String>,
        next_revision: String,
        has_state: bool,
    },
    CheckpointList {
        scope: CheckpointScope,
        limit: u32,
        cursor: Option<String>,
    },
    CheckpointChanges {
        scope: CheckpointScope,
        after: String,
        limit: u32,
        cursor: Option<String>,
    },
    List,
    PrepareIntent {
        client_id: OperationId,
        operation_id: OperationId,
        mutation: WireMutation,
    },
    CommitIntent {
        reference: HostIntentRef,
    },
    QueryIntent {
        reference: HostIntentRef,
    },
    ListIntents {
        client_id: OperationId,
        cursor: String,
        limit: u32,
    },
    AcknowledgeIntent {
        reference: HostIntentRef,
        expected: HostIntentAcknowledgment,
    },
    ListSnapshot,
    StatPath {
        path: VaultPath,
    },
    ReadPath {
        path: VaultPath,
    },
    ReadPresented {
        id: EntryId,
    },
    ChangesAfter {
        cursor: String,
        limit: u32,
    },
    Read {
        id: EntryId,
    },
    Apply {
        operation_id: OperationId,
        mutation: WireMutation,
    },
    Reconcile {
        paths: Vec<VaultPath>,
    },
    Recover,
    Rescan,
    LocalFamilyStatus,
    Status,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WireMutation {
    Create {
        id: EntryId,
        path: VaultPath,
        kind: EntryKind,
    },
    Write {
        id: EntryId,
        expected: Revision,
    },
    Move {
        id: EntryId,
        expected: Revision,
        path: VaultPath,
    },
    Delete {
        id: EntryId,
        expected: Revision,
        recursive: bool,
    },
}

fn fault(code: &'static str) -> Value {
    json!({"code":code,"commit_uncertain":matches!(code, "storage_io" | "filesystem_io" | "sync_failed" | "crypto_failed" | "protocol_failed"),"message":"Native host operation failed; preserve the identical mutation request when acknowledgement is uncertain"})
}
fn core_code(error: &zorid_core::ContractError) -> &'static str {
    use zorid_core::ContractError::*;
    match error {
        RevisionConflict { .. } => "revision_conflict",
        IdempotencyConflict { .. } => "idempotency_conflict",
        EntryNotFound { .. } | EntryDeleted { .. } => "not_found",
        InvalidOperationRecord => "corrupt_storage",
        _ => "invalid_request",
    }
}
fn native_fault(error: zorid_native::Error) -> Value {
    use zorid_native::Error::*;
    fault(match error {
        Contract(ref e) | Store(zorid_store::StoreError::Contract(ref e)) => core_code(e),
        UnsafePath(_) => "unsafe_path",
        Busy(_) => "filesystem_changed",
        Unsupported(_) => "unsupported",
        LockTimeout => "lock_timeout",
        Store(zorid_store::StoreError::StreamRequired { .. }) => "stream_required",
        Store(zorid_store::StoreError::UnsupportedSchema(_)) => "unsupported_schema",
        Store(zorid_store::StoreError::ReloadRequired(_)) => "reload_required",
        Store(zorid_store::StoreError::Corrupt(_)) | Store(zorid_store::StoreError::Json(_)) => {
            "corrupt_storage"
        }
        Store(zorid_store::StoreError::Sync(_)) => "sync_failed",
        Store(zorid_store::StoreError::Crypto(_)) => "crypto_failed",
        Store(zorid_store::StoreError::Protocol(_)) => "protocol_failed",
        Store(_) => "storage_io",
        Io(_) => "filesystem_io",
        Recovery(_) => "local_recovery_unavailable",
    })
}

// Two big-endian u32 lengths, then UTF-8 JSON header and exact binary bytes.
// Check both lengths before allocation. Partial frames are terminal; never resync.
struct FrameHead {
    header: Vec<u8>,
    request: Request,
    body_len: usize,
}
fn read_frame_head(input: &mut impl Read) -> io::Result<Option<FrameHead>> {
    let mut prefix = [0; 8];
    loop {
        match input.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    input.read_exact(&mut prefix[1..])?;
    let header_len = u32::from_be_bytes(prefix[..4].try_into().unwrap()) as usize;
    let body_len = u32::from_be_bytes(prefix[4..].try_into().unwrap()) as usize;
    if header_len == 0 || header_len > MAX_HEADER || body_len > MAX_CHECKPOINT_BODY {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame limit"));
    }
    let mut header = vec![0; header_len];
    input.read_exact(&mut header)?;
    let request: Request = serde_json::from_slice(&header)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request"))?;
    let transient = matches!(
        &request.command,
        Command::DocumentDrafts { .. } | Command::DocumentWork { .. }
    );
    let preview = matches!(&request.command, Command::Documents { request, .. } if request.is_preview());
    let maximum = match &request.command {
        Command::Documents { request, .. } if request.is_preview() => 0,
        Command::DocumentDrafts { request, .. } if request.accepts_body() => {
            document_drafts::MAX_CHUNK
        }
        Command::DocumentDrafts { .. } | Command::DocumentWork { .. } => 0,
        Command::Binary { .. } => binary::MAX_FRAME,
        Command::CheckpointCas { .. } => MAX_CHECKPOINT_BODY,
        _ => MAX_BODY,
    };
    if body_len > maximum || ((transient || preview) && header_len > document_drafts::MAX_CONTROL) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "body/control limit",
        ));
    }
    Ok(Some(FrameHead {
        header,
        request,
        body_len,
    }))
}
fn read_frame_body(input: &mut impl Read, length: usize) -> io::Result<Vec<u8>> {
    let mut body = vec![0; length];
    input.read_exact(&mut body)?;
    Ok(body)
}
// Compatibility helper for existing framed tests/embedded commands. The stdio
// draft lane never calls this allocating body helper.
fn read_frame(input: &mut impl Read) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let Some(head) = read_frame_head(input)? else {
        return Ok(None);
    };
    if matches!(
        &head.request.command,
        Command::DocumentDrafts { .. } | Command::DocumentWork { .. }
    ) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "stdio-only draft frame",
        ));
    }
    let body = read_frame_body(input, head.body_len)?;
    Ok(Some((head.header, body)))
}
struct HeaderBuffer(Vec<u8>);
impl Write for HeaderBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_HEADER {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "response limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode_header(header: &Value) -> io::Result<Vec<u8>> {
    let mut buffer = HeaderBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, header)?;
    Ok(buffer.0)
}
fn write_encoded(output: &mut impl Write, header: &[u8], body: &[u8]) -> io::Result<()> {
    output.write_all(&(header.len() as u32).to_be_bytes())?;
    output.write_all(&(body.len() as u32).to_be_bytes())?;
    output.write_all(header)?;
    output.write_all(body)?;
    output.flush()
}
fn write_frame(output: &mut impl Write, header: &Value, body: &[u8]) -> io::Result<()> {
    let bytes = encode_header(header)?;
    if body.len() > MAX_CHECKPOINT_BODY {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "response limit"));
    }
    write_encoded(output, &bytes, body)
}
fn reply(
    output: &mut impl Write,
    request_id: &str,
    answer: Result<(Value, Vec<u8>), Value>,
    may_commit: bool,
) -> io::Result<()> {
    let (header, body) = match answer {
        Ok((result, bytes)) => (
            json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            bytes,
        ),
        Err(error) => (
            json!({"version":1,"request_id":request_id,"ok":false,"error":error}),
            vec![],
        ),
    };
    // Serialize into a capped writer before writing ANY prefix. A valid but
    // oversized response leaves framing intact and does not poison the child.
    match encode_header(&header) {
        Ok(encoded) if body.len() <= MAX_CHECKPOINT_BODY => write_encoded(output, &encoded, &body),
        _ => write_frame(
            output,
            &json!({"version":1,"request_id":request_id,"ok":false,"error":{
                "code":"response_limit","commit_uncertain":may_commit,
                "message":"Response exceeds transport bounds; retain mutation intent and identical operation ID"
            }}),
            &[],
        ),
    }
}
fn command_may_commit(command: &Command) -> bool {
    if let Command::Workblocks { request, .. } = command { return request.may_commit(); }
    matches!(
        command,
        Command::Apply { .. }
            | Command::Binary { .. }
            | Command::FixtureFamilyEnroll
            | Command::FixtureFamilyOnce { .. }
            | Command::FixtureFamilyApply { .. }
            | Command::CreateText { .. }
            | Command::FileCommand { .. }
            | Command::FileCommandCompact { .. }
            | Command::ClaimClient { .. }
            | Command::ReleaseClient { .. }
            | Command::CheckpointCas { .. }
            | Command::PrepareIntent { .. }
            | Command::CommitIntent { .. }
            | Command::AcknowledgeIntent { .. }
            | Command::Reconcile { .. }
            | Command::Recover
            | Command::Rescan
    )
}

fn empty(body: &[u8]) -> Result<(), Value> {
    if body.is_empty() {
        Ok(())
    } else {
        Err(fault("unexpected_body"))
    }
}
fn report(report: zorid_native::ReconcileReport) -> Value {
    let blocked: Vec<_> = report
        .blocked
        .into_iter()
        .map(|(path, _)| json!({"path":path,"code":"reconciliation_blocked"}))
        .collect();
    json!({"imported":report.imported,"projected":report.projected,"blocked":blocked})
}
#[derive(Default)]
struct ClientLeases {
    next_recovery_snapshot_ms: Option<i64>,
    staged_import: Option<staged_import::StagedImport>,
    documents: documents::Sessions,
    workblocks: workblocks::Sessions,
    active: BTreeMap<String, ClientLease>,
    binary_reads: BTreeMap<(OperationId, OperationId), zorid_store::BinaryReadSession>,
    released: BTreeMap<String, ClientLeaseRef>,
    // Retain kernel ownership while trusted turns dispose actual F payloads.
    revoking: BTreeMap<String, ()>,
}
fn admission_fault(error: ClientAdmissionError) -> Value {
    match error {
        ClientAdmissionError::Native(error) => native_fault(error),
        ClientAdmissionError::InvalidClient => fault("invalid_client_id"),
        ClientAdmissionError::InUse => fault("client_in_use"),
    }
}
impl ClientLeases {
    fn authorize(
        &self,
        vault: &NativeVault,
        command: &Command,
        reference: Option<&ClientLeaseRef>,
    ) -> Result<(), Value> {
        let client = match command {
            Command::Binary { client_id }
            | Command::Documents { client_id, .. }
            | Command::Workblocks { client_id, .. }
            | Command::DocumentDrafts { client_id, .. }
            | Command::PrepareIntent { client_id, .. }
            | Command::ListIntents { client_id, .. }
            | Command::CreateText { client_id, .. }
            | Command::FileCommand { client_id, .. }
            | Command::FileCommandCompact { client_id, .. }
            | Command::FileCommandStatus { client_id, .. } => Some(client_id),
            Command::CommitIntent { reference }
            | Command::QueryIntent { reference }
            | Command::AcknowledgeIntent { reference, .. } => Some(&reference.client_id),
            Command::CheckpointLoad { scope, .. }
            | Command::CheckpointCas { scope, .. }
            | Command::CheckpointList { scope, .. }
            | Command::CheckpointChanges { scope, .. } => Some(&scope.client_id),
            _ => None,
        };
        let Some(reference) = reference else {
            return if client.is_some() {
                Err(fault("client_not_admitted"))
            } else {
                Ok(())
            };
        };
        let lease = self
            .active
            .get(reference.token.as_str())
            .filter(|lease| lease.reference() == reference)
            .ok_or_else(|| fault("client_not_admitted"))?;
        vault.verify_client_lease(lease).map_err(admission_fault)?;
        if self.revoking.contains_key(reference.token.as_str()) {
            return Err(fault("client_not_admitted"));
        }
        if client.is_some_and(|client| client != &reference.client_id) {
            return Err(fault("client_scope_mismatch"));
        }
        match command {
            Command::CheckpointLoad { scope, .. }
            | Command::CheckpointCas { scope, .. }
            | Command::CheckpointList { scope, .. }
            | Command::CheckpointChanges { scope, .. }
                if scope.vault_id != reference.local_store_id =>
            {
                Err(fault("client_scope_mismatch"))
            }
            Command::DocumentWork { .. }
            | Command::ClaimClient { .. }
            | Command::ReleaseClient { .. }
            | Command::Apply { .. }
            | Command::FixtureFamilyEnroll
            | Command::FixtureFamilyOnce { .. }
            | Command::FixtureFamilyApply { .. }
            | Command::Reconcile { .. }
            | Command::Recover
            | Command::Rescan => Err(fault("client_operation_unsupported")),
            _ => Ok(()),
        }
    }
}
fn checkpoint_fault(error: CheckpointError) -> Value {
    let (code, uncertain) = match error {
        CheckpointError::Conflict => ("checkpoint_conflict", false),
        CheckpointError::Invalid => ("checkpoint_invalid", false),
        CheckpointError::Limit => ("checkpoint_limit", false),
        CheckpointError::ScopeMismatch => ("checkpoint_scope_mismatch", false),
        CheckpointError::Store(_) | CheckpointError::ExternalStorage(_) => {
            ("checkpoint_storage", true)
        }
    };
    json!({"code":code,"commit_uncertain":uncertain,"message":"Checkpoint request failed; retain the exact checkpoint request"})
}
fn checkpoint_reply(mut checkpoint: Checkpoint) -> (Value, Vec<u8>) {
    let body = checkpoint
        .encoded_state
        .take()
        .map(String::into_bytes)
        .unwrap_or_default();
    let mut metadata = json!(checkpoint);
    metadata.as_object_mut().unwrap().remove("encodedState");
    (json!({"checkpoint":metadata}), body)
}
fn wire_mutation(mutation: WireMutation, body: Vec<u8>) -> Result<Mutation, Value> {
    Ok(match mutation {
        WireMutation::Create { id, path, kind } => {
            let content = match kind {
                EntryKind::File => Some(body),
                EntryKind::Folder => {
                    empty(&body)?;
                    None
                }
            };
            Mutation::Create {
                id,
                path,
                kind,
                content,
            }
        }
        WireMutation::Write { id, expected } => Mutation::Write {
            id,
            expected,
            content: body,
        },
        WireMutation::Move { id, expected, path } => {
            empty(&body)?;
            Mutation::Move { id, expected, path }
        }
        WireMutation::Delete {
            id,
            expected,
            recursive,
        } => {
            empty(&body)?;
            Mutation::Delete {
                id,
                expected,
                recursive,
            }
        }
    })
}
fn apply_reply(outcome: zorid_native::ApplyOutcome) -> Value {
    let projection = match outcome.projection {
        ProjectionStatus::Projected => json!({"state":"projected"}),
        ProjectionStatus::Pending(_) => json!({"state":"pending","code":"projection_pending"}),
    };
    json!({"commit":outcome.commit,"projection":projection})
}
fn execute(
    vault: &mut NativeVault,
    leases: &mut ClientLeases,
    sync: Option<&FixtureSync>,
    command: Command,
    body: Vec<u8>,
) -> Result<(Value, Vec<u8>), Value> {
    let result = match command {
        Command::DocumentDrafts { .. } | Command::DocumentWork { .. } => {
            return Err(fault("client_operation_unsupported"));
        }
        Command::RecoveryList { entry_id, limit, before } => {
            empty(&body)?;
            return recovery::list(vault, &entry_id, limit, before);
        }
        Command::RecoveryRead { entry_id, snapshot_id } => {
            empty(&body)?;
            return recovery::read(vault, &entry_id, &snapshot_id);
        }
        Command::Workblocks { client_id, request } => {
            empty(&body)?;
            let lease = leases.active.values().find(|lease| lease.reference().client_id == client_id)
                .ok_or_else(|| fault("client_not_admitted"))?;
            return workblocks::execute(vault, &mut leases.workblocks, lease, request);
        }
        Command::Documents { client_id, request } => {
            empty(&body)?;
            let token = leases.active.values()
                .find(|lease| lease.reference().client_id == client_id)
                .map(|lease| lease.reference().token.clone())
                .ok_or_else(|| fault("client_not_admitted"))?;
            return documents::execute(vault, &mut leases.documents, &client_id, &token, request);
        }
        Command::Binary { client_id } => {
            return Ok(binary::execute(vault, leases, &client_id, &body))
        }
        command @ (Command::FixtureFamilyEnroll
        | Command::FixtureFamilyStatus
        | Command::FixtureFamilyOnce { .. }
        | Command::FixtureFamilyApply { .. }
        | Command::CreateText { .. }
        | Command::FileCommand { .. }
        | Command::FileCommandCompact { .. }
        | Command::FileCommandStatus { .. }) => {
            return family::execute(vault, sync, command, body);
        }
        Command::ClaimClient { client_id } => {
            empty(&body)?;
            if leases.active.len() >= 32 || leases.active.len() + leases.released.len() >= 1024 {
                return Err(fault("client_capacity"));
            }
            let lease = vault.claim_client(&client_id).map_err(admission_fault)?;
            let reference = lease.reference().clone();
            leases
                .active
                .insert(reference.token.as_str().to_owned(), lease);
            json!({"lease":reference})
        }
        Command::ReleaseClient { reference } => {
            empty(&body)?;
            if leases
                .active
                .get(reference.token.as_str())
                .is_some_and(|lease| lease.reference() == &reference)
            {
                let last_runtime_owner = leases.active.values().all(|lease| lease.reference().client_id == reference.client_id);
                let composite = vault.document_draft_snapshot().is_some();
                if last_runtime_owner {
                    // Actual authenticated last-client revocation retires weak
                    // preview backing immediately, even if F must still drain.
                    vault.retire_document_preview_owner();
                }
                if composite {
                    leases
                        .revoking
                        .insert(reference.token.as_str().to_owned(), ());
                }
                if document_drafts::release_client(
                    vault,
                    &mut leases.documents,
                    &reference.client_id,
                    last_runtime_owner,
                )? {
                    leases.documents.release_runtime_after_work(
                        vault,
                        &reference.client_id,
                        last_runtime_owner,
                    )?;
                } else {
                    leases
                        .documents
                        .release_runtime(vault, &reference.client_id, last_runtime_owner)?;
                }
                leases
                    .binary_reads
                    .retain(|(client, _), _| client != &reference.client_id);
                leases.documents.release(&reference.client_id);
                leases.workblocks.release(&reference.client_id);
                leases.active.remove(reference.token.as_str()); // Drop releases kernel ownership; NEVER unlink.
                leases.revoking.remove(reference.token.as_str());
                leases
                    .released
                    .insert(reference.token.as_str().to_owned(), reference.clone());
            } else if leases.released.get(reference.token.as_str()) != Some(&reference) {
                return Err(fault("client_not_admitted"));
            }
            json!({"released":true,"reference":reference})
        }
        Command::CheckpointLoad { scope, key } => {
            empty(&body)?;
            return Ok(
                match vault
                    .checkpoint_load(&scope, &key)
                    .map_err(checkpoint_fault)?
                {
                    Some(value) => checkpoint_reply(value),
                    None => (json!({"checkpoint":null}), vec![]),
                },
            );
        }
        Command::CheckpointCas {
            scope,
            key,
            expected_revision,
            next_revision,
            has_state,
        } => {
            if !has_state {
                empty(&body)?;
            }
            let encoded = std::str::from_utf8(&body).map_err(|_| fault("checkpoint_invalid"))?;
            let value = vault
                .checkpoint_compare_and_swap(
                    &scope,
                    CheckpointWrite {
                        key: &key,
                        expected_revision: expected_revision.as_deref(),
                        next_revision: &next_revision,
                        encoded_state: has_state.then_some(encoded),
                    },
                )
                .map_err(checkpoint_fault)?;
            return Ok(checkpoint_reply(value));
        }
        Command::CheckpointList {
            scope,
            limit,
            cursor,
        } => {
            empty(&body)?;
            json!(vault
                .checkpoint_list(&scope, limit, cursor.as_deref())
                .map_err(checkpoint_fault)?)
        }
        Command::CheckpointChanges {
            scope,
            after,
            limit,
            cursor,
        } => {
            empty(&body)?;
            json!(vault
                .checkpoint_changes(&scope, &after, limit, cursor.as_deref())
                .map_err(checkpoint_fault)?)
        }
        Command::Identity => {
            empty(&body)?;
            json!({"identity":vault.identity().map_err(native_fault)?})
        }
        Command::PrepareIntent {
            client_id,
            operation_id,
            mutation,
        } => {
            let request = MutationRequest {
                operation_id,
                mutation: wire_mutation(mutation, body)?,
            };
            json!({"intent":vault.prepare_host_intent(&client_id, &request).map_err(native_fault)?})
        }
        Command::CommitIntent { reference } => {
            empty(&body)?;
            let intent = vault.commit_host_intent(&reference).map_err(|error| {
                let mut error = native_fault(error);
                // Authorization may already be durable. Only returned rejected
                // intent outcomes prove a definitive semantic failure.
                error["commit_uncertain"] = json!(true);
                error
            })?;
            json!({"intent":intent})
        }
        Command::QueryIntent { reference } => {
            empty(&body)?;
            json!({"intent":vault.query_host_intent(&reference).map_err(native_fault)?})
        }
        Command::ListIntents {
            client_id,
            cursor,
            limit,
        } => {
            empty(&body)?;
            json!(vault
                .list_host_intents(&client_id, &cursor, limit)
                .map_err(native_fault)?)
        }
        Command::AcknowledgeIntent {
            reference,
            expected,
        } => {
            empty(&body)?;
            json!({"intent":vault.acknowledge_host_intent(&reference, &expected).map_err(native_fault)?})
        }
        Command::Apply {
            operation_id,
            mutation,
        } => {
            let mutation = wire_mutation(mutation, body)?;
            let outcome = vault
                .apply(&MutationRequest {
                    operation_id,
                    mutation,
                })
                .map_err(native_fault)?;
            apply_reply(outcome)
        }
        Command::Read { id } => {
            empty(&body)?;
            let entry = vault
                .read(&id)
                .map_err(native_fault)?
                .ok_or_else(|| fault("not_found"))?;
            if entry
                .content
                .as_ref()
                .is_some_and(|bytes| bytes.len() > MAX_BODY)
            {
                return Err(fault("response_limit"));
            }
            return Ok((
                json!({"entry":entry.state,"has_content":entry.content.is_some()}),
                entry.content.unwrap_or_default(),
            ));
        }
        Command::ListSnapshot => {
            empty(&body)?;
            json!(vault.list_snapshot().map_err(native_fault)?)
        }
        Command::StatPath { path } => {
            empty(&body)?;
            match vault.stat_path(&path).map_err(native_fault)? {
                None => json!({"entry":null}),
                Some(value) => json!({"has_content":value.state.kind == EntryKind::File,"entry":value.state,"presentation":value.presentation}),
            }
        }
        Command::ReadPath { path } => {
            empty(&body)?;
            match vault.read_path(&path).map_err(native_fault)? {
                Some(entry) => {
                    if entry
                        .content
                        .as_ref()
                        .is_some_and(|bytes| bytes.len() > MAX_BODY)
                    {
                        return Err(fault("response_limit"));
                    }
                    return Ok((
                        json!({"entry":entry.state,"presentation":entry.presentation,"has_content":entry.content.is_some()}),
                        entry.content.unwrap_or_default(),
                    ));
                }
                None => json!({"entry":null}),
            }
        }
        Command::ReadPresented { id } => {
            empty(&body)?;
            match vault.read_presented(&id).map_err(native_fault)? {
                None => json!({"entry":null}),
                Some(value) => {
                    let has_content = value.content.is_some();
                    if value
                        .content
                        .as_ref()
                        .is_some_and(|bytes| bytes.len() > MAX_BODY)
                    {
                        return Err(fault("response_limit"));
                    }
                    return Ok((
                        json!({"entry":value.state,"presentation":value.presentation,"has_content":has_content}),
                        value.content.unwrap_or_default(),
                    ));
                }
            }
        }
        Command::ChangesAfter { cursor, limit } => {
            empty(&body)?;
            json!(vault.changes_after(&cursor, limit).map_err(native_fault)?)
        }
        Command::List => {
            empty(&body)?;
            json!({"entries":vault.list().map_err(native_fault)?})
        }
        Command::Reconcile { paths } => {
            empty(&body)?;
            if paths.len() > 1024 {
                return Err(fault("request_limit"));
            }
            report(vault.reconcile(&paths).map_err(native_fault)?)
        }
        Command::LocalFamilyStatus => {
            empty(&body)?;
            json!({"family":vault.family_status().map_err(native_fault)?})
        }
        Command::Rescan => {
            empty(&body)?;
            if vault.family_status().map_err(native_fault)?.scope.is_some() {
                let report = vault
                    .reconcile_external(
                        zorid_native::ScanOptions::default(),
                        zorid_native::ExternalFileMode::Auto,
                    )
                    .map_err(native_fault)?;
                let reconciliation = reconciliation_status(&report);
                let issues: Vec<_> = reconciliation
                    .issues
                    .iter()
                    .map(|issue| json!({"path":issue.path,"code":"scan_incomplete"}))
                    .collect();
                json!({"scan_id":report.run.scan_id,"complete":report.complete,"finished":report.run.finished,
                    "observed":report.run.observed,"imported":report.imported.len(),"missing":[],"issues":issues,
                    "reconciliation":reconciliation})
            } else {
                let report = vault.rescan().map_err(native_fault)?;
                let issues: Vec<_> = report
                    .issues
                    .into_iter()
                    .map(|issue| json!({"path":issue.path,"code":"scan_incomplete"}))
                    .collect();
                json!({"scan_id":report.run.scan_id,"complete":report.run.complete,"finished":report.run.finished,
                    "observed":report.run.observed,"imported":report.run.imported,"missing":report.missing,"issues":issues})
            }
        }
        Command::Recover => {
            empty(&body)?;
            report(vault.recover().map_err(native_fault)?)
        }
        Command::Status => {
            empty(&body)?;
            json!(vault.status().map_err(native_fault)?)
        }
    };
    Ok((result, vec![]))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReconciliationStatus {
    scan_id: OperationId,
    complete: bool,
    scan_complete: bool,
    finished: bool,
    observed: u32,
    imported: usize,
    namespace_applied: usize,
    issue_count: usize,
    issues_truncated: bool,
    issues: Vec<ReconciliationIssue>,
}
#[derive(Serialize)]
struct ReconciliationIssue {
    path: Option<String>,
    code: &'static str,
}
fn reconciliation_status(report: &zorid_native::ExternalReconcileReport) -> ReconciliationStatus {
    // Never forward native error strings, arbitrary absolute paths or an
    // unbounded issue vector to the renderer/startup header.
    let issues: Vec<_> = report
        .issues
        .iter()
        .take(32)
        .map(|issue| {
            let code = if issue.reason.contains("budget") {
                "scan_limit"
            } else if issue.reason.contains("retained for recovery") {
                "recovery_retained"
            } else if ["changed", "disappeared", "reappeared"]
                .iter()
                .any(|word| issue.reason.contains(word))
            {
                "changed_during_scan"
            } else {
                "reconciliation_blocked"
            };
            ReconciliationIssue {
                path: issue
                    .path
                    .as_ref()
                    .filter(|path| path.as_str().len() <= 2048)
                    .map(|path| path.as_str().to_owned()),
                code,
            }
        })
        .collect();
    ReconciliationStatus {
        scan_id: report.run.scan_id.clone(),
        complete: report.complete,
        scan_complete: report.run.complete,
        finished: report.run.finished,
        observed: report.run.observed,
        imported: report.imported.len(),
        namespace_applied: report.namespace.len(),
        issue_count: report.issues.len(),
        issues_truncated: report.issues.len() > issues.len(),
        issues,
    }
}
fn initialize_desktop_vault(vault: &mut NativeVault) -> Result<ReconciliationStatus, Value> {
    if vault.family_status().map_err(native_fault)?.scope.is_none() {
        let identity = vault.identity().map_err(native_fault)?;
        let scope: zorid_native::FamilyScope = serde_json::from_value(json!({
            "realm_id":format!("local_{}",identity.local_store_id.as_str()),
            "vault_id":format!("vault_{}",identity.local_store_id.as_str())
        }))
        .map_err(|_| fault("invalid_local_authority"))?;
        vault.family_enroll(&scope).map_err(native_fault)?;
    }
    // Shared native import policy owns bytes, family mode and safe filesystem observation.
    let report = vault
        .reconcile_external(
            zorid_native::ScanOptions::default(),
            zorid_native::ExternalFileMode::Auto,
        )
        .map_err(native_fault)?;
    // Discovery must precede publication recovery so externally moved/deleted
    // branches are observed before pending journal state is retried.
    let recovered = vault.recover().map_err(native_fault)?;
    let mut status = reconciliation_status(&report);
    for (path, _) in recovered.blocked {
        status.complete = false;
        status.issue_count += 1;
        if status.issues.len() < 32 {
            status.issues.push(ReconciliationIssue { path: Some(path.as_str().to_owned()), code: "recovery_retained" });
        } else {
            status.issues_truncated = true;
        }
    }
    // Diagnostics remain transport state; product UI supplies ordinary language.
    Ok(status)
}

const RECOVERY_SNAPSHOT_INTERVAL_MS: i64 = 5 * 60 * 1_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn local_recovery_path(root: &Path, data_root: &Path, local_store_id: &OperationId) -> io::Result<PathBuf> {
    Ok(zorid_native::LocalStoragePaths::resolve(root, local_store_id, data_root)?.recovery)
}

fn app_local_data_root() -> io::Result<PathBuf> {
    zorid_native::LocalStoragePaths::app_data_root()
}

fn enable_local_document_cache(vault: &mut NativeVault, root: &Path, data_root: &Path) {
    let enabled = (|| -> Result<(), String> {
        let identity = vault.identity().map_err(|error| error.to_string())?;
        let paths = zorid_native::LocalStoragePaths::resolve(root, &identity.local_store_id, data_root)
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(paths.cache.parent().expect("cache bucket has a parent"))
            .map_err(|error| error.to_string())?;
        vault.enable_local_document_cache(paths.cache).map_err(|error| error.to_string())
    })();
    if let Err(error) = enabled {
        eprintln!("Local document cache unavailable; using temporary cache: {error}");
    }
}

fn enable_local_recovery(vault: &mut NativeVault, root: &Path, data_root: &Path) -> Result<(), Value> {
    let identity = vault.identity().map_err(native_fault)?;
    let path = local_recovery_path(root, data_root, &identity.local_store_id)
        .map_err(|_| fault("local_recovery_unavailable"))?;
    std::fs::create_dir_all(path.parent().expect("recovery bucket has a parent"))
        .map_err(|_| fault("local_recovery_unavailable"))?;
    vault.enable_local_recovery(path, now_ms()).map_err(native_fault)
}

fn snapshot_local_recovery_if_due(vault: &mut NativeVault, leases: &mut ClientLeases, now: i64) {
    if leases.next_recovery_snapshot_ms.is_some_and(|next| now < next) {
        return;
    }
    // Bound secondary body reads at interactive command boundaries. Touched-note
    // save snapshots remain immediate; the inventory is captured once per cycle.
    leases.next_recovery_snapshot_ms = Some(now.saturating_add(RECOVERY_SNAPSHOT_INTERVAL_MS));
    match vault.maintain_local_recovery(now, 16) {
        Ok(progress) => {
            if progress.pending { leases.next_recovery_snapshot_ms = Some(now.saturating_add(1_000)); }
            if progress.failed_notes > 0 { eprintln!("Local recovery skipped unavailable note snapshots"); }
        }
        Err(error) => eprintln!("Local recovery maintenance failed: {error}"),
    }
}

/// Trusted in-process native host. The shell supplies a selected filesystem root;
/// web content only submits the existing bounded command frames. No daemon.
pub struct EmbeddedHost {
    fixture_sync: Option<embedded_fixture_sync::EmbeddedFixtureSync>,
    vault: NativeVault,
    leases: ClientLeases,
    reconciliation: ReconciliationStatus,
}
impl EmbeddedHost {
    pub fn open_local(root: &std::path::Path) -> Result<Self, Value> {
        let mut vault = NativeVault::open(root).map_err(native_fault)?;
        let reconciliation = initialize_desktop_vault(&mut vault)?;
        Ok(Self { vault, leases: ClientLeases::default(), reconciliation, fixture_sync: None })
    }
    /// Shell-selected app-private data root. The ordinary constructor remains
    /// path-neutral for fixtures and shells that have not configured recovery.
    pub fn open_local_with_data_root(root: &Path, data_root: &Path) -> Result<Self, Value> {
        let mut vault = NativeVault::open(root).map_err(native_fault)?;
        enable_local_document_cache(&mut vault, root, data_root);
        enable_local_recovery(&mut vault, root, data_root)?;
        let reconciliation = initialize_desktop_vault(&mut vault)?;
        let mut leases = ClientLeases::default();
        snapshot_local_recovery_if_due(&mut vault, &mut leases, now_ms());
        Ok(Self { vault, leases, reconciliation, fixture_sync: None })
    }
    pub fn reconciliation(&self) -> Value {
        serde_json::to_value(&self.reconciliation).expect("serializable status")
    }
    /// Native-owned bounded reconciliation, separate from editor command dispatch.
    pub fn refresh_local(&mut self) -> Result<Value, Value> {
        self.reconciliation = initialize_desktop_vault(&mut self.vault)?;
        snapshot_local_recovery_if_due(&mut self.vault, &mut self.leases, now_ms());
        Ok(self.reconciliation())
    }
    /// Exactly one complete request frame and one bounded response frame.
    /// Caller serializes access and retains this host until all accepted calls drain.
    pub fn dispatch(&mut self, frame: &[u8]) -> io::Result<Vec<u8>> {
        let mut input = frame;
        let head = read_frame_head(&mut input)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "empty frame"))?;
        if input.len() != head.body_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "trailing/truncated frame",
            ));
        }
        let request = head.request;
        let transient = matches!(
            &request.command,
            Command::DocumentDrafts { .. } | Command::DocumentWork { .. }
        );
        // Reject before making an embedded payload or response-body copy.
        let preview = matches!(&request.command, Command::Documents { request, .. } if request.is_preview());
        let body = if transient || preview {
            vec![]
        } else {
            read_frame_body(&mut input, head.body_len)?
        };
        if request.request_id.is_empty() || request.request_id.len() > 64
            || !request.request_id.bytes().all(|b| b.is_ascii_digit()) || request.request_id == "0" {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request identity"));
        }
        // Any failed transport after dispatch must be treated conservatively.
        // Stdio has a trusted main-process owner. Embedded requests come from
        // the editor: omitting a lease must not expose main-only mutations.
        let trusted_only = matches!(&request.command,
            Command::Apply { .. } | Command::FixtureFamilyEnroll |
            Command::FixtureFamilyOnce { .. } | Command::FixtureFamilyApply { .. } |
            Command::FixtureFamilyStatus | Command::Reconcile { .. } |
            Command::Recover | Command::Rescan);
        let may_commit = command_may_commit(&request.command);
        let answer = if trusted_only || transient || preview { Err(fault("client_operation_unsupported")) }
        else if request.version == 1 {
            self.leases.authorize(&self.vault, &request.command, request.lease.as_ref())
                .and_then(|()| execute(&mut self.vault, &mut self.leases, None, request.command, body))
        } else { Err(fault("unsupported_protocol")) };
        let mut output = Vec::new();
        snapshot_local_recovery_if_due(&mut self.vault, &mut self.leases, now_ms());
        reply(&mut output, &request.request_id, answer, may_commit)?;
        Ok(output)
    }
}

/// A first-build Base result is written while its actual capture/query guard
/// remains charged. Once a prefix is written, any failure is terminal.
fn preview_base_frame(
    vault: &NativeVault,
    leases: &ClientLeases,
    mut request: Request,
    output: &mut impl Write,
) -> io::Result<()> {
    let prepared = (|| {
        if request.version != 1 { return Err(fault("unsupported_protocol")); }
        leases.authorize(vault, &request.command, request.lease.as_ref())?;
        let Command::Documents { client_id, request: document } = &mut request.command else {
            return Err(fault("invalid_request"));
        };
        let (preview_id, reply) = documents::preview_base_reply(vault, &leases.documents, client_id, document)?;
        let length = reply.write_json(&preview_id, &mut io::sink(), documents::MAX_RESPONSE_BYTES, || Ok(()))
            .map_err(documents::native)?;
        leases.authorize(vault, &request.command, request.lease.as_ref())?;
        vault.check_document_preview_reply(&reply)
            .map_err(documents::native)?;
        Ok((preview_id, reply, length))
    })();
    let (preview_id, reply, length) = match prepared {
        Ok(value) => value,
        Err(error) => return reply(output, &request.request_id, Err(error), false),
    };
    let header = encode_header(&json!({"version":1,"request_id":request.request_id,"ok":true,
        "result":{"documents":true,"schemaVersion":1,"bytes":length}}))?;
    output.write_all(&(header.len() as u32).to_be_bytes())?;
    output.write_all(&(length as u32).to_be_bytes())?;
    output.write_all(&header)?;
    let written = reply.write_json(&preview_id, output, documents::MAX_RESPONSE_BYTES, || Ok(()))
        .map_err(|_| io::Error::other("preview response interrupted"))?;
    if written != length { return Err(io::Error::other("preview response changed")); }
    leases.authorize(vault, &request.command, request.lease.as_ref())
        .map_err(|_| io::Error::other("preview lease expired"))?;
    vault.check_document_preview_reply(&reply)
        .map_err(|_| io::Error::other("preview capture expired"))?;
    output.flush()
}

pub fn run_stdio() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    // Initialization is a trusted main-process startup decision, never a framed RPC.
    if args.len() < 2 || args[0] != "--vault" {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "usage"));
    }
    let mut initialize_local = false;
    let mut local_cache = false;
    let mut config = None;
    let mut index = 2;
    while index < args.len() {
        if args[index] == "--initialize-local" && !initialize_local {
            initialize_local = true;
            index += 1;
        } else if args[index] == "--local-cache" && !local_cache {
            local_cache = true;
            index += 1;
        } else if args[index] == "--fixture-sync-config"
            && config.is_none()
            && index + 1 < args.len()
        {
            config = Some(std::path::Path::new(&args[index + 1]));
            index += 2;
        } else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "usage"));
        }
    }
    if config.is_some_and(|path| !path.is_absolute()) || initialize_local && config.is_some() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "usage"));
    }
    let mut output = io::stdout().lock();
    let mut vault = match if initialize_local {
        NativeVault::open(std::path::Path::new(&args[1]))
    } else {
        NativeVault::open_existing(std::path::Path::new(&args[1]))
    } {
        Ok(vault) => vault,
        Err(error) => {
            write_frame(
                &mut output,
                &json!({"version":1,"request_id":"0","ok":false,"error":native_fault(error)}),
                &[],
            )?;
            return Ok(());
        }
    };
    if initialize_local {
        // Configure history before reconciliation, which may settle interrupted
        // writes. Failure here is diagnostic; it must not prevent opening notes.
        let enabled = app_local_data_root()
            .map_err(|_| fault("local_recovery_unavailable"))
            .and_then(|data_root| enable_local_recovery(&mut vault, Path::new(&args[1]), &data_root));
        if let Err(error) = enabled {
            eprintln!("Local recovery initialization failed: {error}");
        }
    }
    if initialize_local || local_cache {
        match app_local_data_root() {
            Ok(data_root) => enable_local_document_cache(&mut vault, Path::new(&args[1]), &data_root),
            Err(error) => eprintln!("Local document cache unavailable; using temporary cache: {error}"),
        }
    }
    // The trusted main process selects a protected config path once. No framed
    // command accepts credential bytes, paths, endpoints or key material.
    let sync = if let Some(config) = config {
        match FixtureSync::load(config, std::path::Path::new(&args[1])) {
            Ok(sync) => Some(sync),
            Err(error) => {
                write_frame(
                    &mut output,
                    &json!({"version":1,"request_id":"0","ok":false,
                    "error":family::sync_fault(error, false)}),
                    &[],
                )?;
                return Ok(());
            }
        }
    } else {
        None
    };
    let reconciliation = if initialize_local {
        match initialize_desktop_vault(&mut vault) {
            Ok(status) => Some(status),
            Err(error) => {
                write_frame(
                    &mut output,
                    &json!({"version":1,"request_id":"0","ok":false,"error":error}),
                    &[],
                )?;
                return Ok(());
            }
        }
    } else {
        None
    };
    let mut leases = ClientLeases::default();
    if initialize_local { snapshot_local_recovery_if_due(&mut vault, &mut leases, now_ms()); }
    write_frame(
        &mut output,
        &json!({"version":1,"request_id":"0","ok":true,"result":{"transport":"zorid-native-stdio","max_header":MAX_HEADER,"max_body":MAX_BODY,"max_checkpoint_body":MAX_CHECKPOINT_BODY,"max_binary_frame":binary::MAX_FRAME,"binary_limits":{"maxFileBytes":"67108864","maxChunkBytes":binary::MAX_CHUNK,"smallReadBytes":binary::SMALL_READ.to_string()},"reconciliation":reconciliation,"capabilities":["workblocks","documents","document_base_preview","document_metadata_rows","document_property_targets","document_runtime","document_drafts","binary_streams","reconciliation_status","local_family_status","file_command","file_command_compact","file_command_status","create_text","claim_client","release_client","checkpoint_load","checkpoint_cas","checkpoint_list","checkpoint_changes","identity","list","read","apply","reconcile","recover","status","list_snapshot","stat_path","read_path","read_presented","changes_after","rescan","prepare_intent","commit_intent","query_intent","list_intents","acknowledge_intent","fixture_family_enroll","fixture_family_status","fixture_family_once","fixture_family_apply"]}}),
        &[],
    )?;
    let mut input = io::stdin().lock();
    while let Some(head) = read_frame_head(&mut input)? {
        let request = head.request;
        if request.request_id.is_empty()
            || request.request_id.len() > 64
            || !request.request_id.bytes().all(|b| b.is_ascii_digit())
            || request.request_id == "0"
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request identity",
            ));
        }
        if matches!(
            &request.command,
            Command::DocumentDrafts { .. } | Command::DocumentWork { .. }
        ) {
            document_drafts::execute_frame(
                &mut vault,
                &mut leases,
                request,
                head.body_len,
                &mut input,
                &mut output,
            )?;
            continue;
        }
        if matches!(&request.command, Command::Documents { request, .. } if request.is_preview_base()) {
            preview_base_frame(&vault, &leases, request, &mut output)?;
            continue;
        }
        let body = read_frame_body(&mut input, head.body_len)?;
        let may_commit = command_may_commit(&request.command);
        let answer = if request.version == 1 {
            leases
                .authorize(&vault, &request.command, request.lease.as_ref())
                .and_then(|()| {
                    execute(
                        &mut vault,
                        &mut leases,
                        sync.as_ref(),
                        request.command,
                        body,
                    )
                })
        } else {
            Err(fault("unsupported_protocol"))
        };
        if initialize_local { snapshot_local_recovery_if_due(&mut vault, &mut leases, now_ms()); }
        reply(&mut output, &request.request_id, answer, may_commit)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reconciliation_diagnostics_bound_and_sanitize_issues_and_use_committed_import_count() {
        let report = zorid_native::ExternalReconcileReport {
            complete: false,
            run: zorid_store::ScanRun {
                scan_id: OperationId::new("scan").unwrap(),
                max_entries: 100,
                finished: true,
                complete: true,
                observed: 40,
                imported: 99,
                issue: None,
            },
            imported: vec![],
            namespace: vec![],
            issues: (0..40)
                .map(|_| zorid_native::ScanIssue {
                    path: Some(VaultPath::new("retained.md").unwrap()),
                    reason: "external physical branch retained for recovery /private/secret TOKEN"
                        .into(),
                })
                .collect(),
        };
        let status = serde_json::to_value(reconciliation_status(&report)).unwrap();
        assert_eq!(
            status["imported"], 0,
            "scan observations are not committed imports"
        );
        assert_eq!(status["issueCount"], 40);
        assert_eq!(status["issuesTruncated"], true);
        assert_eq!(status["issues"].as_array().unwrap().len(), 32);
        assert_eq!(status["issues"][0]["code"], "recovery_retained");
        assert!(!status.to_string().contains("secret"));
    }

    // Responses intentionally have a different schema from inbound requests.
    // Decode only the bounded frame here; never weaken read_frame's request gate.
    fn response_frame(input: &mut &[u8]) -> (Value, Vec<u8>) {
        assert!(input.len() >= 8);
        let header_len = u32::from_be_bytes(input[..4].try_into().unwrap()) as usize;
        let body_len = u32::from_be_bytes(input[4..8].try_into().unwrap()) as usize;
        assert!((1..=MAX_HEADER).contains(&header_len));
        assert!(body_len <= MAX_CHECKPOINT_BODY);
        assert!(input.len() >= 8 + header_len + body_len);
        let header = serde_json::from_slice(&input[8..8 + header_len]).unwrap();
        let body = input[8 + header_len..8 + header_len + body_len].to_vec();
        *input = &input[8 + header_len + body_len..];
        (header, body)
    }

    #[test]
    fn stat_path_wire_is_body_free_for_files_folders_and_missing_paths() {
        let root = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        let mut leases = ClientLeases::default();
        for (name, kind, content) in [
            ("file", EntryKind::File, Some(b"payload".to_vec())),
            ("empty", EntryKind::File, Some(vec![])),
            ("folder", EntryKind::Folder, None),
        ] {
            vault
                .apply(&MutationRequest {
                    operation_id: OperationId::new(name).unwrap(),
                    mutation: Mutation::Create {
                        id: EntryId::new(name).unwrap(),
                        path: VaultPath::new(name).unwrap(),
                        kind,
                        content,
                    },
                })
                .unwrap();
        }
        for (name, file, size) in [("file", true, 7), ("empty", true, 0), ("folder", false, 0)] {
            let command: Command =
                serde_json::from_value(json!({"method":"stat_path","path":name})).unwrap();
            let (result, body) = execute(&mut vault, &mut leases, None, command, vec![]).unwrap();
            assert!(body.is_empty());
            assert_eq!(result["entry"]["path"], name);
            assert_eq!(result["presentation"]["id"], result["entry"]["id"]);
            assert_eq!(result["presentation"]["size_bytes"], size);
            assert_eq!(result["has_content"], file);
            assert_eq!(result.as_object().unwrap().len(), 3);
        }
        let (missing, body) = execute(
            &mut vault,
            &mut leases,
            None,
            Command::StatPath {
                path: VaultPath::new("missing").unwrap(),
            },
            vec![],
        )
        .unwrap();
        assert_eq!(missing, json!({"entry":null}));
        assert!(body.is_empty());
        let error = execute(
            &mut vault,
            &mut leases,
            None,
            Command::StatPath {
                path: VaultPath::new("file").unwrap(),
            },
            vec![1],
        )
        .unwrap_err();
        assert_eq!(error["code"], "unexpected_body");
        assert!(serde_json::from_value::<Command>(
            json!({"method":"stat_path","path":"../outside"})
        )
        .is_err());
    }

    #[test]
    fn oversized_success_is_bounded_error_and_stream_remains_usable() {
        let mut output = vec![];
        let large = json!({"entries":vec!["x".repeat(1024); 2048]});
        reply(&mut output, "1", Ok((large, vec![])), true).unwrap();
        reply(&mut output, "2", Ok((json!({"entries":[]}), vec![])), false).unwrap();
        assert!(output.len() < 1024);
        let mut input = output.as_slice();
        let (first, body) = response_frame(&mut input);
        assert_eq!(first["error"]["code"], "response_limit");
        assert_eq!(first["error"]["commit_uncertain"], true);
        assert!(body.is_empty());
        let (next, _) = response_frame(&mut input);
        assert_eq!(next["request_id"], "2");
        assert_eq!(next["ok"], true);
        assert!(input.is_empty());
    }

    #[test]
    fn inbound_frames_still_reject_response_schema() {
        let mut encoded = vec![];
        reply(&mut encoded, "1", Ok((json!({}), vec![])), false).unwrap();
        assert_eq!(
            read_frame(&mut encoded.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn ordinary_request_rejects_checkpoint_sized_body_before_reading_it() {
        let header = br#"{"version":1,"request_id":"1","command":{"method":"list"}}"#;
        assert!(matches!(
            serde_json::from_slice::<Request>(header).unwrap().command,
            Command::List
        ));
        let mut encoded = vec![];
        encoded.extend_from_slice(&(header.len() as u32).to_be_bytes());
        encoded.extend_from_slice(&((MAX_BODY + 1) as u32).to_be_bytes());
        encoded.extend_from_slice(header);
        // No body is supplied: InvalidData, rather than UnexpectedEof, proves
        // command-specific size admission happens before body allocation/read.
        assert_eq!(
            read_frame(&mut encoded.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}

#[cfg(test)]
mod embedded_tests {
    use super::*;
    fn request(host: &mut EmbeddedHost, command: Value, lease: Option<Value>, body: &[u8]) -> (Value, Vec<u8>) {
        let mut frame = Vec::new();
        write_frame(&mut frame, &json!({"version":1,"request_id":"1","command":command,"lease":lease}), body).unwrap();
        let reply = host.dispatch(&frame).unwrap();
        let header_len = u32::from_be_bytes(reply[..4].try_into().unwrap()) as usize;
        (serde_json::from_slice(&reply[8..8+header_len]).unwrap(), reply[8+header_len..].to_vec())
    }
    #[test]
    fn embedded_lease_and_checkpoint_survive_host_restart() {
        let root = tempfile::tempdir().unwrap();
        let client = "abcdefab-0000-4000-8000-000000000001";
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        let (identity, _) = request(&mut host, json!({"method":"identity"}), None, &[]);
        let vault_id = identity["result"]["identity"]["local_store_id"].clone();
        let scope = json!({"vaultId":vault_id,"clientId":client});
        let (claim, _) = request(&mut host, json!({"method":"claim_client","client_id":client}), None, &[]);
        let lease = claim["result"]["lease"].clone();
        let load = json!({"method":"checkpoint_load","scope":scope,"key":"mobile/restart"});
        let (denied, _) = request(&mut host, load.clone(), None, &[]);
        assert_eq!(denied["error"]["code"], "client_not_admitted");
        let bytes = br#"{"draft":"retained"}"#;
        let (saved, _) = request(&mut host, json!({"method":"checkpoint_cas","scope":scope,"key":"mobile/restart","expected_revision":null,"next_revision":"20000000-0000-4000-8000-000000000002","has_state":true}), Some(lease), bytes);
        assert_eq!(saved["ok"], true, "{saved}");
        drop(host);
        let mut reopened = EmbeddedHost::open_local(root.path()).unwrap();
        let (claim, _) = request(&mut reopened, json!({"method":"claim_client","client_id":client}), None, &[]);
        assert_eq!(claim["ok"], true);
        let (loaded, data) = request(&mut reopened, load, Some(claim["result"]["lease"].clone()), &[]);
        assert_eq!(loaded["ok"], true);
        assert_eq!(data, bytes);
    }
    #[test]
    fn embedded_rejects_extra_frames_without_executing_first() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        let mut frame = Vec::new();
        write_frame(&mut frame, &json!({"version":1,"request_id":"1","command":{"method":"claim_client","client_id":"10000000-0000-4000-8000-000000000001"}}), &[]).unwrap();
        frame.extend_from_slice(&[0;8]);
        assert!(host.dispatch(&frame).is_err());
        assert!(host.leases.active.is_empty());
    }
}

#[cfg(test)]
mod embedded_admission_tests {
    use super::*;
    #[test]
    fn renderer_cannot_omit_lease_to_reach_trusted_mutation() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        for command in [
            json!({"method":"apply","operation_id":"unleased","mutation":{"type":"create","id":"forbidden","path":"Forbidden.md","kind":"file"}}),
            json!({"method":"recover"}), json!({"method":"rescan"}),
            json!({"method":"fixture_family_enroll"})
        ] {
            let mut frame = Vec::new();
            write_frame(&mut frame,&json!({"version":1,"request_id":"1","command":command}),&[]).unwrap();
            let response = host.dispatch(&frame).unwrap();
            let length = u32::from_be_bytes(response[..4].try_into().unwrap()) as usize;
            let header: Value = serde_json::from_slice(&response[8..8+length]).unwrap();
            assert_eq!(header["error"]["code"], "client_operation_unsupported");
        }
        assert!(host.vault.list().unwrap().is_empty());
    }
}

#[cfg(test)]
mod local_recovery_tests {
    use super::*;
    use zorid_recovery::{RecoveryScope, RecoveryStore};

    #[test]
    fn local_history_key_is_stable_isolated_and_outside_vault() {
        let roots = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let first = roots.path().join("one");
        let second = roots.path().join("two");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let identity = OperationId::new("authority-one").unwrap();
        let path = local_recovery_path(&first, data.path(), &identity).unwrap();
        assert!(path.starts_with(std::fs::canonicalize(data.path()).unwrap().join("vaults")));
        assert!(!path.starts_with(&first));
        assert_eq!(path.file_name().unwrap(), "recovery.sqlite");
        assert_eq!(path, local_recovery_path(&first.join("."), data.path(), &identity).unwrap());
        assert_ne!(path, local_recovery_path(&second, data.path(), &identity).unwrap());
        assert_ne!(path, local_recovery_path(&first, data.path(), &OperationId::new("authority-two").unwrap()).unwrap());
        assert!(local_recovery_path(&first, Path::new("relative"), &identity).is_err());
        assert!(local_recovery_path(&first, &first.join("new-data"), &identity).is_err());
        assert!(!first.join("new-data").exists());
        let new_data = data.path().join("not-created-yet/nested");
        assert!(local_recovery_path(&first, &new_data, &identity).unwrap().starts_with(std::fs::canonicalize(data.path()).unwrap()));
        assert!(!new_data.exists());
        #[cfg(unix)] {
            let alias = roots.path().join("alias");
            std::os::unix::fs::symlink(&first, &alias).unwrap();
            assert_eq!(path, local_recovery_path(&alias, data.path(), &identity).unwrap());
            let inside_alias = data.path().join("inside-alias");
            std::os::unix::fs::symlink(&first, &inside_alias).unwrap();
            assert!(local_recovery_path(&first, &inside_alias.join("new-data"), &identity).is_err());
            assert!(!first.join("new-data").exists());
            std::os::unix::fs::symlink(&first, data.path().join("vaults")).unwrap();
            assert!(local_recovery_path(&first, data.path(), &identity).is_err());
            assert_eq!(std::fs::read_dir(&first).unwrap().count(), 0);
        }
    }

    #[test]
    fn explicit_data_root_captures_note_bytes_and_reuses_history_on_reopen() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let data_root = data.path().join("new-app-data/nested");
        let bytes = b"Recovery note\n";
        std::fs::write(root.path().join("Note.md"), bytes).unwrap();
        let mut host = EmbeddedHost::open_local_with_data_root(root.path(), &data_root).unwrap();
        let authority = host.vault.identity().unwrap().local_store_id;
        let entry = host.vault.read_path(&VaultPath::new("Note.md").unwrap()).unwrap().unwrap();
        let id = entry.state.id.as_str();
        let path = local_recovery_path(root.path(), &data_root, &authority).unwrap();
        assert!(path.is_file());
        let scope = RecoveryScope { vault_id: authority.as_str().to_owned(), replica_id: "native-local".into() };
        let snapshots = RecoveryStore::open(std::fs::canonicalize(&path).unwrap(), &scope, now_ms()).unwrap();
        let versions = snapshots.list(id, None, 10).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(snapshots.read(versions[0].id).unwrap().unwrap().content, bytes);
        drop(snapshots);
        drop(host);
        let reopened = EmbeddedHost::open_local_with_data_root(root.path(), &data_root).unwrap();
        let snapshots = RecoveryStore::open(std::fs::canonicalize(&path).unwrap(), &scope, now_ms()).unwrap();
        assert_eq!(snapshots.list(id, None, 10).unwrap(), versions);
        assert_eq!(std::fs::read(root.path().join("Note.md")).unwrap(), bytes);
        drop(reopened);
    }

    #[test]
    fn whole_vault_snapshot_work_is_throttled_at_command_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        let mut leases = ClientLeases::default();
        leases.next_recovery_snapshot_ms = Some(1_000);
        snapshot_local_recovery_if_due(&mut vault, &mut leases, 999);
        assert_eq!(leases.next_recovery_snapshot_ms, Some(1_000));
        snapshot_local_recovery_if_due(&mut vault, &mut leases, 1_000);
        assert_eq!(leases.next_recovery_snapshot_ms, Some(1_000 + RECOVERY_SNAPSHOT_INTERVAL_MS));
    }
}
