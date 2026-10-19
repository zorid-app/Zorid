//! Dedicated transient draft transport. Source/encoding allocations and parser
//! policy belong to the shared executor; this module owns control metadata only.
//! Stdio alone uses this route: no payload Vec may cross the embedded API.
use super::*;
use zorid_native::{
    DocumentWorkChildEffect, DocumentWorkTicket, DraftBufferKey, DraftExecution, DraftJobToken,
    DraftOutcomeKind, DraftReduction, DraftRequest, DraftRuntimeError, DraftSourceDescriptor,
    DraftTag, DraftUnavailableCode, NativeDocumentWorkError, NativeDraftCommand,
    NativeDraftTransferError, NativeDraftTransferProgress, NativeWorkReceipt,
};

pub(crate) const MAX_CONTROL: usize = 64 * 1024;
pub(crate) const MAX_CHUNK: usize = 128 * 1024;
const MAX_SOURCE: usize = 16 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
struct Counter(u64);
impl TryFrom<String> for Counter {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let n = value.parse::<u64>().map_err(|_| "invalid counter")?;
        if n.to_string() != value {
            return Err("invalid counter");
        }
        Ok(Self(n))
    }
}
impl From<Counter> for String {
    fn from(value: Counter) -> Self {
        value.0.to_string()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    lifetime: OperationId,
    id: Counter,
    buffer_lifetime: OperationId,
    text_revision: Counter,
}
impl Job {
    fn resolve(&self, client: &OperationId) -> Result<DraftJobToken, Value> {
        if self.id.0 == 0 {
            return Err(fault("draft_invalid_request"));
        }
        Ok(DraftJobToken {
            lifetime: self.lifetime.clone(),
            id: self.id.0,
            tag: DraftTag {
                buffer: DraftBufferKey {
                    client: client.clone(),
                    buffer_lifetime: self.buffer_lifetime.clone(),
                },
                text_revision: self.text_revision.0,
            },
        })
    }
}
fn job(value: &DraftJobToken) -> Job {
    Job {
        lifetime: value.lifetime.clone(),
        id: Counter(value.id),
        buffer_lifetime: value.tag.buffer.buffer_lifetime.clone(),
        text_revision: Counter(value.tag.text_revision),
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    bytes: usize,
    utf16: usize,
    sha256: String,
}
impl Source {
    fn checked(&self) -> Result<DraftSourceDescriptor, Value> {
        if self.bytes > MAX_SOURCE
            || self.utf16 > self.bytes
            || (self.bytes == 0) != (self.utf16 == 0)
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(fault("draft_invalid_source"));
        }
        let mut sha256 = [0; 32];
        for (i, pair) in self.sha256.as_bytes().chunks_exact(2).enumerate() {
            let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
            sha256[i] = digit(pair[0]) * 16 + digit(pair[1]);
        }
        Ok(DraftSourceDescriptor {
            bytes: self.bytes,
            utf16: self.utf16,
            sha256,
        })
    }
}
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Request {
        buffer_lifetime: OperationId,
        text_revision: Counter,
        source: Source,
    },
    UploadBegin {
        job: Job,
    },
    UploadChunk {
        job: Job,
        offset: Counter,
    },
    UploadSeal {
        job: Job,
    },
    Progress {
        job: Job,
    },
    FactsPrepare {
        job: Job,
    },
    FactsRead {
        job: Job,
        offset: Counter,
        maximum: usize,
    },
    Cancel {
        job: Job,
    },
    Acknowledge {
        job: Job,
    },
    ReleaseBuffer {
        buffer_lifetime: OperationId,
    },
    Snapshot {},
}
impl Request {
    pub(crate) fn accepts_body(&self) -> bool {
        matches!(self, Self::UploadChunk { .. })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Lane {
    Committed,
    Draft,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {
    incarnation: OperationId,
    lane: Lane,
    lifetime: OperationId,
    id: Counter,
}
fn ticket(value: &DocumentWorkTicket) -> Ticket {
    let (lane, lifetime, id) = match &value.effect {
        DocumentWorkChildEffect::Committed(v) => (Lane::Committed, v.lifetime.clone(), v.id),
        DocumentWorkChildEffect::Draft(v) => (Lane::Draft, v.lifetime.clone(), v.id),
    };
    Ticket {
        incarnation: value.incarnation.clone(),
        lane,
        lifetime,
        id: Counter(id),
    }
}
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkRequest {
    NextTurn {},
    Snapshot {},
    Step { ticket: Ticket },
    Close {},
}

fn native(error: NativeDocumentWorkError) -> Value {
    use NativeDocumentWorkError as E;
    fault(match error {
        E::Draft(DraftRuntimeError::Capacity) => "draft_capacity",
        E::Draft(DraftRuntimeError::Conflict) => "draft_conflict",
        E::Draft(DraftRuntimeError::StaleRevision) => "draft_stale_revision",
        E::Draft(DraftRuntimeError::ForeignOwner) => "draft_owner_mismatch",
        E::Draft(DraftRuntimeError::InvalidSource | DraftRuntimeError::SourceMismatch)
        | E::SourceMismatch => "draft_invalid_source",
        E::Draft(DraftRuntimeError::InvalidAcknowledgement) => "draft_invalid_ack",
        E::Draft(DraftRuntimeError::CounterExhausted) => "draft_counter_exhausted",
        E::Draft(DraftRuntimeError::Retired) | E::Closed => "draft_closed",
        E::Draft(DraftRuntimeError::Expired) | E::Expired | E::NotStarted => "draft_expired",
        E::NotReady => "draft_not_ready",
        E::Transfer(NativeDraftTransferError::Resource) => "draft_resource",
        E::Transfer(NativeDraftTransferError::InvalidOffset) => "draft_invalid_offset",
        E::Transfer(NativeDraftTransferError::InvalidChunk) => "draft_invalid_chunk",
        E::Transfer(NativeDraftTransferError::Incomplete) => "draft_incomplete",
        E::Transfer(NativeDraftTransferError::Encoding(_)) => "draft_encoding",
        E::Transfer(NativeDraftTransferError::Read(_) | NativeDraftTransferError::Write(_)) => {
            "draft_io"
        }
        E::Runtime(_) => "document_runtime_unavailable",
        _ => "draft_contract",
    })
}
fn progress(v: &NativeDraftTransferProgress) -> Value {
    json!({"source_bytes_received":v.source_bytes_received,"source_bytes_expected":v.source_bytes_expected,
        "source_sealed":v.source_sealed,"facts_bytes":v.facts_bytes,"scratch_bytes":v.scratch_bytes})
}
fn own_reduction(v: &DraftReduction, client: &OperationId) -> Value {
    let execution = match v.execution {
        DraftExecution::Dispatch => "dispatch",
        DraftExecution::WaitForInput => "wait_for_input",
        DraftExecution::WaitForAcknowledgement => "wait_for_acknowledgement",
        DraftExecution::Idle => "idle",
        DraftExecution::Quiesced => "quiesced",
    };
    let outcomes = v
        .outcomes
        .iter()
        .filter(|o| &o.job.tag.buffer.client == client)
        .map(|o| {
            let kind = match o.kind {
                DraftOutcomeKind::Ready => "ready",
                DraftOutcomeKind::Superseded => "superseded",
                DraftOutcomeKind::Cancelled => "cancelled",
                DraftOutcomeKind::Retired => "retired",
                DraftOutcomeKind::Unavailable(_) => "unavailable",
            };
            let reason = match o.kind {
                DraftOutcomeKind::Unavailable(DraftUnavailableCode::Resource) => Some("resource"),
                DraftOutcomeKind::Unavailable(DraftUnavailableCode::CounterExhausted) => {
                    Some("counter_exhausted")
                }
                _ => None,
            };
            json!({"job":job(&o.job),"kind":kind,"reason":reason})
        })
        .collect::<Vec<_>>();
    json!({"admitted":v.admitted.as_ref().filter(|j|&j.tag.buffer.client==client).map(job),"replay":v.replay,
        "execution":execution,"outcomes":outcomes,"usage":{"source_bytes":v.usage.source_bytes,"scratch_bytes":v.usage.scratch_bytes,"facts_bytes":v.usage.facts_bytes}})
}
fn renderer_reply(
    vault: &NativeVault,
    client: &OperationId,
    reduction: Option<&DraftReduction>,
    transfer: Option<&NativeDraftTransferProgress>,
) -> Value {
    let snapshot = vault.document_draft_snapshot();
    let state = reduction
        .or_else(|| snapshot.as_ref().map(|s| &s.runtime))
        .map(|s| own_reduction(s, client));
    json!({"state":state,"transfer":transfer.map(progress),"transfer_scratch_bytes":snapshot.map_or(0,|s|s.transfer_scratch_bytes)})
}
fn work_snapshot(vault: &NativeVault) -> Value {
    vault.document_draft_snapshot().map(|s|json!({"selected":s.work.selected.as_ref().map(ticket),"last_settled":s.work.last_settled.as_ref().map(ticket),
        "closing":s.work.closing,"close_ready":vault.document_work_close_ready()})).unwrap_or(Value::Null)
}
fn resolve_ticket(vault: &NativeVault, requested: &Ticket) -> Result<DocumentWorkTicket, Value> {
    if requested.id.0 == 0 {
        return Err(fault("draft_invalid_request"));
    }
    let s = vault
        .document_draft_snapshot()
        .ok_or_else(|| fault("draft_expired"))?;
    [s.work.selected, s.work.last_settled]
        .into_iter()
        .flatten()
        .find(|v| ticket(v) == *requested)
        .ok_or_else(|| fault("draft_expired"))
}
fn work(
    vault: &mut NativeVault,
    sessions: &mut documents::Sessions,
    request: &WorkRequest,
) -> Result<Value, Value> {
    let mut observed_turn = None;
    match request {
        WorkRequest::Snapshot {} => {}
        WorkRequest::NextTurn {} => {
            let turn = vault.document_work_next_turn().map_err(native)?;
            if let Some(r) = &turn.continued {
                sessions.adopt_runtime(r, false);
            }
            observed_turn = Some(
                json!({"state":match turn.state {zorid_native::DocumentWorkState::Ready=>"ready",zorid_native::DocumentWorkState::Waiting=>"waiting",zorid_native::DocumentWorkState::Quiesced=>"quiesced"}}),
            );
        }
        WorkRequest::Close {} => {
            let close = vault.document_work_begin_close().map_err(native)?;
            sessions.adopt_runtime(&close.committed, false);
        }
        WorkRequest::Step { ticket: requested } => {
            let exact = resolve_ticket(vault, requested)?;
            let replay = vault
                .document_draft_snapshot()
                .is_some_and(|s| s.work.last_settled.as_ref() == Some(&exact));
            let record = vault.document_work_step(&exact).map_err(native)?;
            if let NativeWorkReceipt::Committed(record) = record.receipt {
                let rebuilt = !replay
                    && matches!(
                        record.receipt.issued.kind,
                        zorid_native::DocumentRuntimeEffect::Rebuild
                    )
                    && matches!(
                        record.receipt.completion,
                        zorid_native::DocumentRuntimeEffectResult::Done
                    );
                sessions.adopt_runtime(&record.reduction, rebuilt);
            }
        }
    }
    Ok(json!({"work":work_snapshot(vault),"turn":observed_turn}))
}
fn ordinary(
    vault: &mut NativeVault,
    client: &OperationId,
    request: &Request,
) -> Result<Value, Value> {
    let mut reduction = None;
    let mut transfer = None;
    match request {
        Request::Request {
            buffer_lifetime,
            text_revision,
            source,
        } => {
            reduction = Some(
                vault
                    .document_draft_command(NativeDraftCommand::Request(DraftRequest {
                        tag: DraftTag {
                            buffer: DraftBufferKey {
                                client: client.clone(),
                                buffer_lifetime: buffer_lifetime.clone(),
                            },
                            text_revision: text_revision.0,
                        },
                        source: source.checked()?,
                    }))
                    .map_err(native)?,
            );
        }
        Request::UploadBegin { job } => {
            transfer = Some(
                vault
                    .document_draft_begin_source_upload(&job.resolve(client)?)
                    .map_err(native)?,
            );
        }
        Request::UploadSeal { job } => {
            let exact = job.resolve(client)?;
            // A lost seal response may be retried after the parser became Ready.
            // Observe that exact existing outcome, not a new Seal on a terminal
            // core job, and never recreate its parser or raw upload.
            if vault.document_draft_facts(&exact).is_err() {
                reduction = Some(
                    vault
                        .document_draft_seal_source_upload(&exact)
                        .map_err(native)?,
                );
            }
        }
        Request::Progress { job } => {
            transfer = Some(
                vault
                    .document_draft_transfer_progress(&job.resolve(client)?)
                    .map_err(native)?,
            );
        }
        Request::FactsPrepare { job } => {
            transfer = Some(
                vault
                    .document_draft_prepare_facts_bytes(&job.resolve(client)?)
                    .map_err(native)?,
            );
        }
        Request::Cancel { job } => {
            reduction = Some(
                vault
                    .document_draft_command(NativeDraftCommand::Cancel {
                        client: client.clone(),
                        job: job.resolve(client)?,
                    })
                    .map_err(native)?,
            );
        }
        Request::Acknowledge { job } => {
            reduction = Some(
                vault
                    .document_draft_command(NativeDraftCommand::Acknowledge {
                        client: client.clone(),
                        job: job.resolve(client)?,
                    })
                    .map_err(native)?,
            );
        }
        Request::ReleaseBuffer { buffer_lifetime } => {
            reduction = Some(
                vault
                    .document_draft_command(NativeDraftCommand::ReleaseBuffer(DraftBufferKey {
                        client: client.clone(),
                        buffer_lifetime: buffer_lifetime.clone(),
                    }))
                    .map_err(native)?,
            );
        }
        Request::Snapshot {} => {}
        Request::UploadChunk { .. } | Request::FactsRead { .. } => {
            return Err(fault("draft_invalid_request"))
        }
    }
    Ok(renderer_reply(
        vault,
        client,
        reduction.as_ref(),
        transfer.as_ref(),
    ))
}
// The caller revokes lease admission before entering this path. No host loop
// executes a parser phase here: the trusted scheduler owns future bounded turns.
pub(crate) fn release_client(
    vault: &mut NativeVault,
    sessions: &mut documents::Sessions,
    client: &OperationId,
    last: bool,
) -> Result<bool, Value> {
    let Some(snapshot) = vault.document_draft_snapshot() else {
        return Ok(false);
    };
    vault
        .document_draft_command(NativeDraftCommand::ReleaseClient(client.clone()))
        .map_err(native)?;
    if last && !snapshot.work.closing {
        let close = vault.document_work_begin_close().map_err(native)?;
        sessions.adopt_runtime(&close.committed, false);
    }
    if vault.document_draft_client_has_jobs(client) || (last && !vault.document_work_close_ready())
    {
        return Err(fault("document_drafts_draining"));
    }
    Ok(true)
}

fn drain(input: &mut impl Read, remaining: usize) -> io::Result<()> {
    let mut remaining = remaining;
    let mut scratch = [0; 4096];
    while remaining > 0 {
        let count = remaining.min(scratch.len());
        input.read_exact(&mut scratch[..count])?;
        remaining -= count;
    }
    Ok(())
}
fn response(output: &mut impl Write, id: &str, result: Result<Value, Value>) -> io::Result<()> {
    let header = match result {
        Ok(value) => json!({"version":1,"request_id":id,"ok":true,"result":value}),
        Err(error) => json!({"version":1,"request_id":id,"ok":false,"error":error}),
    };
    let mut bytes = encode_header(&header)?;
    if bytes.len() > MAX_CONTROL {
        bytes = encode_header(
            &json!({"version":1,"request_id":id,"ok":false,"error":fault("draft_control_limit")}),
        )?;
    }
    write_encoded(output, &bytes, &[])
}
/// The caller has validated framing/request identity. Lease authorization happens
/// before owner ingress allocation or raw-byte consumption. A rejected complete
/// frame is drained with stack storage; a truncated read/write terminates stdio.
pub(crate) fn execute_frame(
    vault: &mut NativeVault,
    leases: &mut ClientLeases,
    request: super::Request,
    body_len: usize,
    input: &mut impl Read,
    output: &mut impl Write,
) -> io::Result<()> {
    let id = &request.request_id;
    let admission = if request.version != 1 {
        Err(fault("unsupported_protocol"))
    } else {
        leases.authorize(vault, &request.command, request.lease.as_ref())
    };
    if let Err(error) = admission {
        drain(input, body_len)?;
        return response(output, id, Err(error));
    }
    match &request.command {
        Command::DocumentWork { request } => {
            drain(input, body_len)?;
            response(
                output,
                id,
                if body_len == 0 {
                    work(vault, &mut leases.documents, request)
                } else {
                    Err(fault("unexpected_body"))
                },
            )
        }
        Command::DocumentDrafts {
            client_id,
            request: Request::UploadChunk { job, offset },
        } => {
            let exact = match job.resolve(client_id).and_then(|j| {
                usize::try_from(offset.0)
                    .map(|o| (j, o))
                    .map_err(|_| fault("draft_invalid_offset"))
            }) {
                Ok(value) => value,
                Err(error) => {
                    drain(input, body_len)?;
                    return response(output, id, Err(error));
                }
            };
            let mut limited = input.take(body_len as u64);
            let result = vault.document_draft_read_source_upload_chunk(
                &exact.0,
                exact.1,
                body_len,
                &mut limited,
            );
            if matches!(
                &result,
                Err(NativeDocumentWorkError::Transfer(
                    NativeDraftTransferError::Read(_)
                ))
            ) {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "draft frame read failed",
                ));
            }
            let remaining = limited.limit() as usize;
            drain(&mut limited, remaining)?;
            response(
                output,
                id,
                result
                    .map(|v| renderer_reply(vault, client_id, None, Some(&v)))
                    .map_err(native),
            )
        }
        Command::DocumentDrafts {
            client_id,
            request:
                Request::FactsRead {
                    job,
                    offset,
                    maximum,
                },
        } => {
            drain(input, body_len)?;
            if body_len != 0 {
                return response(output, id, Err(fault("unexpected_body")));
            }
            let prepared = (|| {
                let exact = job.resolve(client_id)?;
                let offset =
                    usize::try_from(offset.0).map_err(|_| fault("draft_invalid_offset"))?;
                if *maximum == 0 || *maximum > MAX_CHUNK {
                    return Err(fault("draft_invalid_chunk"));
                }
                // Metadata-only progress is not a Ready authority. Prepare checks
                // current Ready and reuses the one encoding before any prefix.
                let p = vault
                    .document_draft_prepare_facts_bytes(&exact)
                    .map_err(native)?;
                let total = p.facts_bytes.ok_or_else(|| fault("draft_incomplete"))?;
                if offset > total {
                    return Err(fault("draft_invalid_offset"));
                }
                let count = (*maximum).min(total - offset);
                let header=encode_header(&json!({"version":1,"request_id":id,"ok":true,"result":{"job":job,"offset":offset.to_string(),"bytes":count,"total_bytes":total,"eof":offset+count==total}})).map_err(|_|fault("draft_control_limit"))?;
                if header.len() > MAX_CONTROL {
                    return Err(fault("draft_control_limit"));
                }
                Ok((exact, offset, count, header))
            })();
            let (exact, offset, count, header) = match prepared {
                Ok(v) => v,
                Err(error) => return response(output, id, Err(error)),
            };
            output.write_all(&(header.len() as u32).to_be_bytes())?;
            output.write_all(&(count as u32).to_be_bytes())?;
            output.write_all(&header)?;
            let written = vault
                .document_draft_write_facts_bytes(&exact, offset, *maximum, output)
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "draft frame write failed")
                })?;
            if written != count {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "draft response length",
                ));
            }
            output.flush()
        }
        Command::DocumentDrafts { client_id, request } => {
            drain(input, body_len)?;
            response(
                output,
                id,
                if body_len == 0 {
                    ordinary(vault, client_id, request)
                } else {
                    Err(fault("unexpected_body"))
                },
            )
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a draft frame",
        )),
    }
}

#[cfg(test)]
#[path = "document_drafts_tests.rs"]
mod tests;
