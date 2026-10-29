//! Generated protobuf data is never a Store proof. Every operation resolves its
//! locator through the admitted client and the existing NativeVault authority.
use super::*;
use zorid_file_sync::{Manifest, Sha256Digest};
use zorid_proto::{zorid::common::v1 as common, zorid::stream::v1 as wire, Message};
use zorid_store::{
    BinarySourceRef, BinaryStageRef, BinaryStageRequest, BinaryStageStatus, BinaryStageTerminal,
    BinaryTarget, StagePhase, StreamingLimits,
};
pub(super) const MAX_FRAME: usize = 128 * 1024 + 16 * 1024;
pub(super) const MAX_CHUNK: usize = 128 * 1024;
pub(super) const SMALL_READ: u64 = 16 * 1024 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024;
type Result<T> = std::result::Result<T, wire::ErrorCode>;
fn invalid() -> wire::ErrorCode {
    wire::ErrorCode::InvalidRequest
}
fn operation(value: &str) -> Result<OperationId> {
    OperationId::new(value.to_owned()).map_err(|_| invalid())
}
fn native(error: zorid_native::Error) -> wire::ErrorCode {
    if matches!(
        &error,
        zorid_native::Error::Store(zorid_store::StoreError::FileSync(
            zorid_file_sync::Error::TooLarge
        ))
    ) {
        return wire::ErrorCode::TooLarge;
    }
    let value = native_fault(error);
    match value["code"].as_str() {
        Some("invalid_request") => wire::ErrorCode::InvalidRequest,
        Some("revision_conflict") => wire::ErrorCode::RevisionConflict,
        Some("idempotency_conflict") => wire::ErrorCode::IdempotencyConflict,
        Some("entry_not_found" | "not_found") => wire::ErrorCode::NotFound,
        Some("client_scope_mismatch" | "client_not_admitted") => wire::ErrorCode::OwnerMismatch,
        Some("busy" | "filesystem_changed" | "lock_timeout" | "storage_busy") => wire::ErrorCode::Busy,
        Some("stream_required" | "request_limit" | "too_large") => wire::ErrorCode::TooLarge,
        Some("storage_corrupt" | "store_corrupt" | "corrupt_storage") => wire::ErrorCode::Corrupt,
        Some("io" | "io_error" | "storage_io" | "filesystem_io" | "storage_io_retryable"
            | "storage_capacity" | "filesystem_io_retryable") => wire::ErrorCode::Io,
        _ => wire::ErrorCode::OutcomeUnknown,
    }
}
fn owner(
    vault: &NativeVault,
    client: &OperationId,
    value: Option<&wire::StageOwner>,
) -> Result<()> {
    let value = value.ok_or_else(invalid)?;
    if value.client_id != client.as_str()
        || value.local_store_id != vault.identity().map_err(native)?.local_store_id.as_str()
    {
        return Err(wire::ErrorCode::OwnerMismatch);
    }
    Ok(())
}
fn locator(value: &BinaryStageRef) -> wire::StageLocator {
    wire::StageLocator {
        local_store_id: value.local_store_id().as_str().into(),
        client_id: value.client_id().as_str().into(),
        operation_id: value.operation_id().as_str().into(),
        stage_id: value.stage_id().as_str().into(),
    }
}
fn stage(
    vault: &NativeVault,
    client: &OperationId,
    value: Option<&wire::StageLocator>,
) -> Result<BinaryStageRef> {
    let value = value.ok_or_else(invalid)?;
    owner(
        vault,
        client,
        Some(&wire::StageOwner {
            local_store_id: value.local_store_id.clone(),
            client_id: value.client_id.clone(),
        }),
    )?;
    let reference = vault
        .resume_binary_stage(client, &operation(&value.operation_id)?)
        .map_err(native)?
        .ok_or(wire::ErrorCode::NotFound)?;
    if locator(&reference) != *value {
        return Err(wire::ErrorCode::OwnerMismatch);
    }
    // Internal external-capture stages never become frontend commands.
    vault.binary_stage_request(&reference).map_err(native)?;
    Ok(reference)
}
fn manifest(value: &Manifest) -> common::Manifest {
    common::Manifest {
        bytes: value.bytes,
        digest: value.digest.0.to_vec(),
        pages: value
            .pages
            .iter()
            .map(|page| common::PageRef {
                id: page.id.as_str().into(),
                bytes: page.bytes,
                digest: page.digest.0.to_vec(),
            })
            .collect(),
    }
}
fn entry(value: &zorid_core::EntryState) -> common::EntryState {
    common::EntryState {
        id: value.id.as_str().into(),
        path: value.path.as_str().into(),
        kind: match value.kind {
            EntryKind::File => common::EntryKind::File as i32,
            EntryKind::Folder => common::EntryKind::Folder as i32,
        },
        revision: value.revision.as_str().into(),
        deleted: value.deleted,
    }
}
fn receipt(value: &zorid_core::CommitResult) -> common::CommitReceipt {
    common::CommitReceipt {
        operation_id: value.operation_id.as_str().into(),
        sequence: value.sequence,
        changes: value
            .changes
            .iter()
            .map(|change| common::EntryChange {
                before: change.before.as_ref().map(entry),
                after: Some(entry(&change.after)),
            })
            .collect(),
    }
}
fn projection(value: &ProjectionStatus) -> wire::ProjectionStatus {
    wire::ProjectionStatus {
        status: Some(match value {
            ProjectionStatus::Projected => {
                wire::projection_status::Status::Projected(wire::Projected {})
            }
            ProjectionStatus::Pending(_) => {
                wire::projection_status::Status::Pending(wire::ProjectionPending {
                    reason: "Binary publication remains pending.".into(),
                })
            }
        }),
    }
}
fn outcome(value: &zorid_native::ApplyOutcome) -> wire::StageCommitted {
    wire::StageCommitted {
        receipt: Some(receipt(&value.commit)),
        projection: Some(projection(&value.projection)),
    }
}
fn rejection(value: &zorid_store::BinaryStageRejection) -> wire::Failure {
    use zorid_store::BinaryStageRejectionCode as Code;
    let code = match value.code {
        Code::TargetMissing | Code::TargetDeleted => wire::ErrorCode::NotFound,
        Code::RevisionConflict | Code::PathConflict => wire::ErrorCode::RevisionConflict,
        Code::ContentChanged => wire::ErrorCode::ContentMismatch,
        Code::TooLarge => wire::ErrorCode::TooLarge,
    };
    wire::Failure {
        code: code as i32,
        message: "The original binary operation was rejected.".into(),
    }
}
fn status(
    vault: &NativeVault,
    reference: &BinaryStageRef,
    value: BinaryStageStatus,
) -> Result<wire::StageStatus> {
    use wire::stage_status::State;
    let state = match (value.state, value.terminal) {
        (StagePhase::Receiving, None) => State::Receiving(wire::Receiving {}),
        (StagePhase::Sealed, None) => State::Sealed(wire::Sealed {}),
        (StagePhase::CommitRequested, None) => State::CommitRequested(wire::CommitRequested {}),
        (StagePhase::Aborted, None) => State::Aborted(wire::Aborted {}),
        (StagePhase::Committed, Some(BinaryStageTerminal::Committed(commit))) => {
            State::Committed(wire::StageCommitted {
                receipt: Some(receipt(&commit.receipt)),
                projection: Some(projection(
                    &vault
                        .binary_stage_projection_status(reference)
                        .map_err(native)?,
                )),
            })
        }
        (StagePhase::Rejected, Some(BinaryStageTerminal::Rejected(value))) => {
            State::Rejected(rejection(&value))
        }
        _ => return Err(wire::ErrorCode::Corrupt),
    };
    Ok(wire::StageStatus {
        stage: Some(locator(reference)),
        accepted_length: value.accepted_length,
        next_sequence: value.next_sequence,
        state: Some(state),
        seal_requested: value.seal_requested,
        finalized: value.finalized.map(|value| wire::SealedStage {
            manifest: Some(manifest(value.manifest())),
        }),
    })
}
fn execute_command(
    vault: &mut NativeVault,
    leases: &mut ClientLeases,
    client: &OperationId,
    command: wire::binary_command::Command,
) -> Result<wire::binary_result::Result> {
    use wire::{binary_command::Command as C, binary_result::Result as R};
    Ok(match command {
        C::Begin(value) => {
            owner(vault, client, value.owner.as_ref())?;
            if value.expected_length.is_some_and(|n| n > MAX_FILE) {
                return Err(wire::ErrorCode::TooLarge);
            }
            let target = match value
                .target
                .and_then(|value| value.target)
                .ok_or_else(invalid)?
            {
                wire::binary_target::Target::Create(value) => {
                    if value.path.len() > 4096 {
                        return Err(wire::ErrorCode::TooLarge);
                    }
                    BinaryTarget::Create {
                        id: EntryId::new(value.id).map_err(|_| invalid())?,
                        path: VaultPath::new(value.path).map_err(|_| invalid())?,
                    }
                }
                wire::binary_target::Target::Write(value) => BinaryTarget::Write {
                    id: EntryId::new(value.id).map_err(|_| invalid())?,
                    expected_revision: Revision::new(value.expected_revision)
                        .map_err(|_| invalid())?,
                    expected_content_event: value
                        .expected_content_event
                        .try_into()
                        .map_err(|_| invalid())?,
                },
            };
            let reference = vault
                .begin_binary_stage(
                    client,
                    &operation(&value.operation_id)?,
                    &BinaryStageRequest {
                        target,
                        expected_length: value.expected_length,
                    },
                    StreamingLimits {
                        max_active_stages: 8,
                        max_stage_records: 4096,
                        max_staged_bytes: 512 * 1024 * 1024,
                        max_chunk_records: 4096,
                        max_page_records: 256,
                    },
                )
                .map_err(native)?;
            R::Begun(wire::StageBegun {
                stage: Some(locator(&reference)),
            })
        }
        C::Resume(value) => {
            owner(vault, client, value.owner.as_ref())?;
            let reference = vault
                .resume_binary_stage(client, &operation(&value.operation_id)?)
                .map_err(native)?
                .ok_or(wire::ErrorCode::NotFound)?;
            vault.binary_stage_request(&reference).map_err(native)?;
            R::Begun(wire::StageBegun {
                stage: Some(locator(&reference)),
            })
        }
        C::Append(value) => {
            if value.data.is_empty() || value.data.len() > MAX_CHUNK {
                return Err(wire::ErrorCode::TooLarge);
            }
            let reference = stage(vault, client, value.stage.as_ref())?;
            let value = vault
                .append_binary_chunk(&reference, value.sequence, value.offset, &value.data)
                .map_err(native)?;
            R::Appended(wire::ChunkReceipt {
                sequence: value.sequence,
                offset: value.offset,
                bytes: value.bytes,
                digest: value.digest.0.to_vec(),
                accepted_length: value.accepted_length,
            })
        }
        C::Query(value) => {
            let reference = stage(vault, client, value.stage.as_ref())?;
            R::Status(status(
                vault,
                &reference,
                vault.query_binary_stage(&reference).map_err(native)?,
            )?)
        }
        C::Seal(value) => {
            let reference = stage(vault, client, value.stage.as_ref())?;
            if value.final_length > MAX_FILE {
                return Err(wire::ErrorCode::TooLarge);
            }
            let expected = value
                .expected_digest
                .map(|value| {
                    <[u8; 32]>::try_from(value)
                        .map(Sha256Digest)
                        .map_err(|_| invalid())
                })
                .transpose()?;
            let value = vault
                .seal_binary_stage(&reference, value.final_length, expected)
                .map_err(native)?;
            R::Sealed(wire::StageSealed {
                stage: Some(locator(&reference)),
                diagnostic: Some(wire::SealedStage {
                    manifest: Some(manifest(value.manifest())),
                }),
            })
        }
        C::Commit(value) => {
            let reference = stage(vault, client, value.stage.as_ref())?;
            vault
                .request_commit_binary_stage(&reference)
                .map_err(native)?;
            R::Committed(outcome(
                &vault.commit_binary_stage(&reference).map_err(native)?,
            ))
        }
        C::Abort(value) => {
            let reference = stage(vault, client, value.stage.as_ref())?;
            vault.abort_binary_stage(&reference).map_err(native)?;
            R::Aborted(wire::StageAborted {
                stage: Some(locator(&reference)),
            })
        }
        C::OpenRead(value) => {
            owner(vault, client, value.owner.as_ref())?;
            let revision = value
                .expected_revision
                .map(Revision::new)
                .transpose()
                .map_err(|_| invalid())?;
            let session = vault
                .open_binary_read(
                    client,
                    &operation(&value.read_id)?,
                    &EntryId::new(value.id).map_err(|_| invalid())?,
                    revision.as_ref(),
                )
                .map_err(native)?;
            let reference = session.reference();
            let state = session.state().ok_or(wire::ErrorCode::Corrupt)?;
            let source = match session.source() {
                BinarySourceRef::Graph(value) => value,
                BinarySourceRef::Capture(_) => return Err(wire::ErrorCode::OwnerMismatch),
            };
            let result = R::ReadOpened(wire::ReadOpened {
                read: Some(wire::ReadLocator {
                    owner: Some(wire::StageOwner {
                        local_store_id: reference.local_store_id().as_str().into(),
                        client_id: reference.client_id().as_str().into(),
                    }),
                    read_id: reference.pin_id().as_str().into(),
                }),
                content: Some(wire::BinaryContent {
                    scope: Some(common::Scope {
                        realm_id: source.scope.realm_id.as_str().into(),
                        vault_id: source.scope.vault_id.as_str().into(),
                    }),
                    entry: Some(common::EntryIdentity {
                        entry_id: source.identity.entry_id.as_str().into(),
                        bootstrap_id: source.identity.bootstrap_id.as_str().into(),
                    }),
                    selected_event: source.selected_event.as_str().into(),
                    manifest: Some(manifest(&source.manifest)),
                }),
                entry_revision: state.revision.as_str().into(),
            });
            leases.binary_reads.insert(
                (client.clone(), session.reference().pin_id().clone()),
                session,
            );
            result
        }
        C::ReadChunk(value) => {
            if value.max_bytes == 0 || value.max_bytes as usize > MAX_CHUNK {
                return Err(wire::ErrorCode::TooLarge);
            }
            let reference = value.read.ok_or_else(invalid)?;
            owner(vault, client, reference.owner.as_ref())?;
            let key = (client.clone(), operation(&reference.read_id)?);
            if !leases.binary_reads.contains_key(&key) {
                if !vault
                    .list_binary_reads(client)
                    .map_err(native)?
                    .iter()
                    .any(|reference| reference.pin_id() == &key.1)
                {
                    return Err(wire::ErrorCode::NotFound);
                }
                let session = vault.resume_binary_read(client, &key.1).map_err(native)?;
                leases.binary_reads.insert(key.clone(), session);
            }
            let session = leases
                .binary_reads
                .get(&key)
                .ok_or(wire::ErrorCode::NotFound)?;
            if !matches!(session.source(), BinarySourceRef::Graph(_)) {
                return Err(wire::ErrorCode::OwnerMismatch);
            }
            let value = vault
                .read_binary_range(session, value.offset, value.max_bytes)
                .map_err(native)?;
            R::ReadChunk(wire::ReadChunkResult {
                offset: value.offset,
                data: value.bytes,
                eof: value.eof,
            })
        }
        C::CloseRead(value) => {
            let reference = value.read.ok_or_else(invalid)?;
            owner(vault, client, reference.owner.as_ref())?;
            let key = (client.clone(), operation(&reference.read_id)?);
            let owned = vault.list_binary_reads(client).map_err(native)?;
            if let Some(reference) = owned.iter().find(|reference| reference.pin_id() == &key.1) {
                vault.close_binary_read(reference).map_err(native)?;
            }
            leases.binary_reads.remove(&key);
            R::ReadClosed(wire::ReadClosed {})
        }
    })
}
pub(super) fn execute(
    vault: &mut NativeVault,
    leases: &mut ClientLeases,
    client: &OperationId,
    body: &[u8],
) -> (Value, Vec<u8>) {
    let result = (|| {
        if body.is_empty() || body.len() > MAX_FRAME {
            return Err(wire::ErrorCode::TooLarge);
        }
        let value = wire::BinaryCommand::decode(body).map_err(|_| invalid())?;
        if value.schema_version != 1 {
            return Err(wire::ErrorCode::UnsupportedVersion);
        }
        if !value.required_features.is_empty() {
            return Err(wire::ErrorCode::UnsupportedRequiredFeature);
        }
        execute_command(vault, leases, client, value.command.ok_or_else(invalid)?)
    })();
    let result = result.unwrap_or_else(|code| {
        wire::binary_result::Result::Failure(wire::Failure {
            code: code as i32,
            message: "The binary operation did not complete; retain its original locator.".into(),
        })
    });
    let body = wire::BinaryResult {
        schema_version: 1,
        required_features: vec![],
        result: Some(result),
    }
    .encode_to_vec();
    (json!({"binary":true}), body)
}

#[cfg(test)]
mod retry_fault_tests {
    use super::*;
    #[test]
    fn retry_fault_binary_uses_classified_busy_io_and_corrupt_categories() {
        let classify = |code| native(zorid_native::Error::Store(zorid_store::StoreError::Sql(
            rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None))));
        assert_eq!(classify(rusqlite::ffi::SQLITE_BUSY), wire::ErrorCode::Busy);
        assert_eq!(classify(rusqlite::ffi::SQLITE_IOERR_WRITE), wire::ErrorCode::Io);
        assert_eq!(classify(rusqlite::ffi::SQLITE_FULL), wire::ErrorCode::Io);
        assert_eq!(classify(rusqlite::ffi::SQLITE_CORRUPT), wire::ErrorCode::Corrupt);
    }
}
