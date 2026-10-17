//! Private desktop transport only. Storage, recovery and conflict policy belong
//! to NativeVault. No listener, daemon, filesystem writes or alternate store here.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, Revision, VaultPath};
use zorid_native::{
    ClientAdmissionError, ClientLease, ClientLeaseRef, HostIntentAcknowledgment, HostIntentRef,
    NativeVault, ProjectionStatus,
};
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
    })
}

// Two big-endian u32 lengths, then UTF-8 JSON header and exact binary bytes.
// Check both lengths before allocation. Partial frames are terminal; never resync.
fn read_frame(input: &mut impl Read) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
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
    if body_len > MAX_BODY && !matches!(request.command, Command::CheckpointCas { .. }) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "body limit"));
    }
    let mut body = vec![0; body_len];
    input.read_exact(&mut body)?;
    Ok(Some((header, body)))
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
    active: BTreeMap<String, ClientLease>,
    released: BTreeMap<String, ClientLeaseRef>,
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
            Command::PrepareIntent { client_id, .. } | Command::ListIntents { client_id, .. } => {
                Some(client_id)
            }
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
            Command::ClaimClient { .. }
            | Command::ReleaseClient { .. }
            | Command::Apply { .. }
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
fn execute(
    vault: &mut NativeVault,
    leases: &mut ClientLeases,
    command: Command,
    body: Vec<u8>,
) -> Result<(Value, Vec<u8>), Value> {
    let result = match command {
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
                leases.active.remove(reference.token.as_str()); // Drop releases kernel ownership; NEVER unlink.
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
            let projection = match outcome.projection {
                ProjectionStatus::Projected => json!({"state":"projected"}),
                ProjectionStatus::Pending(_) => {
                    json!({"state":"pending","code":"projection_pending"})
                }
            };
            json!({"commit":outcome.commit,"projection":projection})
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
        Command::Rescan => {
            empty(&body)?;
            let report = vault.rescan().map_err(native_fault)?;
            let issues: Vec<_> = report
                .issues
                .into_iter()
                .map(|issue| json!({"path":issue.path,"code":"scan_incomplete"}))
                .collect();
            json!({"scan_id":report.run.scan_id,"complete":report.run.complete,"finished":report.run.finished,
                "observed":report.run.observed,"imported":report.run.imported,"missing":report.missing,"issues":issues})
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
fn run() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    // Only the trusted main process supplies this startup root. Requests cannot
    // initialize storage or change it. Fixture initialization uses the CLI/core.
    if args.len() != 2 || args[0] != "--vault" {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "usage"));
    }
    let mut output = io::stdout().lock();
    let mut vault = match NativeVault::open_existing(std::path::Path::new(&args[1])) {
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
    write_frame(
        &mut output,
        &json!({"version":1,"request_id":"0","ok":true,"result":{"transport":"zorid-native-stdio","max_header":MAX_HEADER,"max_body":MAX_BODY,"max_checkpoint_body":MAX_CHECKPOINT_BODY,"capabilities":["claim_client","release_client","checkpoint_load","checkpoint_cas","checkpoint_list","checkpoint_changes","identity","list","read","apply","reconcile","recover","status","list_snapshot","read_path","read_presented","changes_after","rescan","prepare_intent","commit_intent","query_intent","list_intents","acknowledge_intent"]}}),
        &[],
    )?;
    let mut input = io::stdin().lock();
    let mut leases = ClientLeases::default();
    while let Some((header, body)) = read_frame(&mut input)? {
        // Parse directly into typed input: reject duplicate/unknown fields.
        let request: Request = match serde_json::from_slice(&header) {
            Ok(request) => request,
            Err(_) => return Err(io::Error::new(io::ErrorKind::InvalidData, "request")),
        };
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
        let may_commit = matches!(
            &request.command,
            Command::Apply { .. }
                | Command::ClaimClient { .. }
                | Command::ReleaseClient { .. }
                | Command::CheckpointCas { .. }
                | Command::PrepareIntent { .. }
                | Command::CommitIntent { .. }
                | Command::AcknowledgeIntent { .. }
                | Command::Reconcile { .. }
                | Command::Recover
                | Command::Rescan
        );
        let answer = if request.version == 1 {
            leases
                .authorize(&vault, &request.command, request.lease.as_ref())
                .and_then(|()| execute(&mut vault, &mut leases, request.command, body))
        } else {
            Err(fault("unsupported_protocol"))
        };
        reply(&mut output, &request.request_id, answer, may_commit)?;
    }
    Ok(())
}
fn main() -> std::process::ExitCode {
    // Intentionally do not format errors: paths/content/SQL may contain secrets.
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("Native host transport terminated; retry mutations only with identical operation ID and request");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
