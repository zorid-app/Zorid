//! Direct, bounded native binary I/O. Durable stages and read pins belong to the
//! embedded core; the CLI introduces no daemon, file-body JSON or staging cache.
use super::{projection_json, Failure, Result};
use base64::{engine::general_purpose::STANDARD, write::EncoderWriter};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read, Write},
    path::Path,
};
use zorid_core::{ContractError, EntryId, OperationId, Revision, VaultPath};
use zorid_native::NativeVault;
use zorid_store::{
    BinarySourceRef, BinaryStageRef, BinaryStageRequest, BinaryTarget, ContentMetadata,
    Sha256Digest, StagePhase, BINARY_READ_MAX_RANGE_BYTES, BINARY_STAGE_MAX_CHUNK_BYTES,
    BINARY_STAGE_MAX_FILE_BYTES, DEFAULT_STREAMING_LIMITS,
};

const CLIENT: &str = "zorid_cli_binary";
// Separate from mutation authority and every desktop/editor owner. The existing
// canonical-UUID OS lease permits safe cleanup after a previous CLI read died.
const READ_CLIENT: &str = "903d6a52-2b38-43e3-9ffb-d582bcf6c954";
fn client() -> Result<OperationId> {
    Ok(OperationId::new(CLIENT)?)
}
fn conflict(operation: &OperationId) -> Failure {
    ContractError::IdempotencyConflict {
        operation_id: operation.clone(),
    }
    .into()
}
fn input(path: &Path) -> Result<Box<dyn Read>> {
    if path == Path::new("-") {
        Ok(Box::new(io::stdin()))
    } else {
        Ok(Box::new(File::open(path).map_err(|_| input_error())?))
    }
}
fn input_error() -> Failure {
    Failure::new(
        "input_io",
        "Could not read input; retain the original operation ID and staged state for exact retry",
        1,
    )
}
fn output_error() -> Failure {
    Failure::new(
        "output_io",
        "Could not deliver complete output; partial output must be discarded",
        1,
    )
}

pub fn create(
    vault: &mut NativeVault,
    id: EntryId,
    path: VaultPath,
    operation: OperationId,
    input_path: &Path,
) -> Result<Value> {
    mutate(
        vault,
        &operation,
        BinaryTarget::Create { id, path },
        input_path,
    )
}

/// Existing stages select their original Write target before mutable entry
/// metadata. This preserves exact retries after a newer write or deletion.
pub fn write(
    vault: &mut NativeVault,
    id: EntryId,
    expected: Revision,
    operation: OperationId,
    input_path: &Path,
) -> Result<Option<Value>> {
    let owner = client()?;
    if let Some(stage) = vault.resume_binary_stage(&owner, &operation)? {
        let original = vault.binary_stage_request(&stage)?;
        if !matches!(&original.target, BinaryTarget::Write { id: prior_id, expected_revision, .. }
            if prior_id == &id && expected_revision == &expected)
        {
            return Err(conflict(&operation));
        }
        return mutate_stage(vault, &operation, &stage, input_path).map(Some);
    }
    let Some(metadata) = vault.read_metadata(&id)? else {
        return Ok(None);
    };
    let Some(ContentMetadata::BinaryRef {
        reference: BinarySourceRef::Graph(source),
    }) = metadata.content
    else {
        return Ok(None);
    };
    let target = BinaryTarget::Write {
        id,
        expected_revision: expected,
        expected_content_event: source.selected_event,
    };
    mutate(vault, &operation, target, input_path).map(Some)
}

fn mutate(
    vault: &mut NativeVault,
    operation: &OperationId,
    target: BinaryTarget,
    input_path: &Path,
) -> Result<Value> {
    let owner = client()?;
    // None is intentional for both files and stdin. Transport/read boundaries
    // cannot change the operation's persisted request on an exact retry.
    let request = BinaryStageRequest {
        target,
        expected_length: None,
    };
    let stage = match vault.resume_binary_stage(&owner, operation)? {
        Some(stage) => {
            if vault.binary_stage_request(&stage)? != request {
                return Err(conflict(operation));
            }
            stage
        }
        None => vault.begin_binary_stage(&owner, operation, &request, DEFAULT_STREAMING_LIMITS)?,
    };
    mutate_stage(vault, operation, &stage, input_path)
}

fn mutate_stage(
    vault: &mut NativeVault,
    operation: &OperationId,
    stage: &BinaryStageRef,
    input_path: &Path,
) -> Result<Value> {
    let mut reader = input(input_path)?;
    let status = vault.query_binary_stage(stage)?;
    if status.state == StagePhase::Aborted {
        return Err(conflict(operation));
    }
    let append = status.state == StagePhase::Receiving && !status.seal_requested;
    let (length, digest) = consume_input(&mut reader, |sequence, offset, bytes| {
        if append {
            let receipt = vault.append_binary_chunk(stage, sequence, offset, bytes)?;
            if receipt.sequence != sequence
                || receipt.offset != offset
                || receipt.bytes as usize != bytes.len()
                || receipt.accepted_length != offset + bytes.len() as u64
                || receipt.digest != Sha256Digest::of(bytes)
            {
                return Err(Failure::new(
                    "corrupt_storage",
                    "Staged chunk receipt failed validation",
                    1,
                ));
            }
        }
        Ok(())
    })?;
    if status.state == StagePhase::Receiving {
        // This also resumes an uncertain Seal whose durable request prevents
        // further Append. The core compares the exact original length/hash.
        vault.seal_binary_stage(stage, length, Some(digest))?;
    } else {
        let manifest = vault.binary_stage_content_manifest(stage)?.ok_or_else(|| {
            Failure::new(
                "corrupt_storage",
                "Sealed operation lacks its original content metadata",
                1,
            )
        })?;
        if manifest.bytes != length || manifest.digest != digest {
            return Err(conflict(operation));
        }
    }
    // Native authorization/commit remains durable and idempotent. On an unknown
    // outcome leave the stage intact and retry this operation/input unchanged.
    let outcome = vault.commit_binary_stage(stage)?;
    Ok(
        json!({"durable_local_commit":true,"synced":false,"commit":outcome.commit,"projection":projection_json(outcome.projection)}),
    )
}

fn consume_input(
    reader: &mut dyn Read,
    mut chunk: impl FnMut(u32, u64, &[u8]) -> Result<()>,
) -> Result<(u64, Sha256Digest)> {
    let mut buffer = vec![0u8; BINARY_STAGE_MAX_CHUNK_BYTES];
    let mut length = 0u64;
    let mut sequence = 0u32;
    let mut hash = Sha256::new();
    loop {
        let mut filled = 0;
        while filled < buffer.len() {
            match reader.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(count) => filled += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(input_error()),
            }
        }
        if filled == 0 {
            break;
        }
        let end = length.checked_add(filled as u64).ok_or_else(input_error)?;
        if end > BINARY_STAGE_MAX_FILE_BYTES {
            return Err(Failure::new("input_too_large", "Binary input exceeds the 67108864 byte limit; staged bytes remain private and uncommitted", 2));
        }
        hash.update(&buffer[..filled]);
        chunk(sequence, length, &buffer[..filled])?;
        length = end;
        sequence += 1;
        if filled < buffer.len() {
            break;
        }
    }
    Ok((length, Sha256Digest(hash.finalize().into())))
}

fn admission(error: zorid_native::ClientAdmissionError) -> Failure {
    match error {
        zorid_native::ClientAdmissionError::Native(error) => error.into(),
        zorid_native::ClientAdmissionError::InUse => Failure::new(
            "client_in_use",
            "Another CLI binary read owns this vault; retry after it completes",
            3,
        ),
        zorid_native::ClientAdmissionError::InvalidClient => Failure::new(
            "invalid_identifier",
            "Binary read owner identity is invalid",
            2,
        ),
    }
}

/// Preserve raw/base64 JSON while writing one verified range at a time. The
/// owner lease spans output and cleanup; failed output must be discarded.
pub fn read(
    vault: &mut NativeVault,
    id: &EntryId,
    raw: bool,
    read_id: Option<&OperationId>,
) -> Result<bool> {
    // Unspecified reads may inspect only metadata to preserve the inline path.
    // Explicit read IDs restore their original pin before inspecting new state.
    if read_id.is_none()
        && !matches!(
            vault.read_metadata(id)?.and_then(|entry| entry.content),
            Some(ContentMetadata::BinaryRef { .. })
        )
    {
        return Ok(false);
    }
    let owner = OperationId::new(READ_CLIENT)?;
    let lease = vault.claim_client(&owner).map_err(admission)?;
    let pins = vault.list_binary_reads(&owner)?;
    let prior = pins
        .iter()
        .find(|pin| read_id.is_some_and(|id| id == pin.read_id()))
        .cloned();
    for pin in &pins {
        if prior.as_ref() != Some(pin) {
            vault.close_binary_read(pin)?;
        }
    }
    vault.verify_client_lease(&lease).map_err(admission)?;
    let session = if let Some(prior) = prior {
        let session = vault.resume_binary_read(&owner, prior.pin_id())?;
        if session.state().is_none_or(|state| &state.id != id) {
            return Err(conflict(prior.read_id()));
        }
        session
    } else {
        if !matches!(
            vault.read_metadata(id)?.and_then(|entry| entry.content),
            Some(ContentMetadata::BinaryRef { .. })
        ) {
            return Ok(false);
        }
        let generated = OperationId::new(uuid::Uuid::new_v4().to_string())?;
        vault.open_binary_read(&owner, read_id.unwrap_or(&generated), id, None)?
    };
    let result = (|| {
        let state = session.state().ok_or_else(|| {
            Failure::new("corrupt_storage", "Binary read has no committed entry", 1)
        })?;
        let mut out = io::BufWriter::new(io::stdout().lock());
        if raw {
            emit_ranges(vault, &session, &lease, &mut out)?;
        } else {
            out.write_all(b"{\"version\":1,\"ok\":true,\"result\":{\"entry\":")
                .map_err(|_| output_error())?;
            serde_json::to_writer(&mut out, state).map_err(|_| output_error())?;
            out.write_all(b",\"encoding\":\"base64\",\"bytes\":\"")
                .map_err(|_| output_error())?;
            let mut encoded = EncoderWriter::new(&mut out, &STANDARD);
            emit_ranges(vault, &session, &lease, &mut encoded)?;
            encoded.finish().map_err(|_| output_error())?;
            drop(encoded);
            out.write_all(b"\"}}\n").map_err(|_| output_error())?;
        }
        out.flush().map_err(|_| output_error())?;
        vault.verify_client_lease(&lease).map_err(admission)
    })();
    // Always try closing the pin, including output/range errors. A typed fatal
    // storage failure during cleanup takes precedence over ordinary output I/O.
    vault.close_binary_read(session.reference())?;
    result?;
    Ok(true)
}
fn emit_ranges(
    vault: &NativeVault,
    session: &zorid_store::BinaryReadSession,
    lease: &zorid_native::ClientLease,
    out: &mut impl Write,
) -> Result<()> {
    let mut offset = 0u64;
    while offset < session.len() {
        vault.verify_client_lease(lease).map_err(admission)?;
        let chunk = vault.read_binary_range(session, offset, BINARY_READ_MAX_RANGE_BYTES)?;
        let end = offset
            .checked_add(chunk.bytes.len() as u64)
            .ok_or_else(|| Failure::new("corrupt_storage", "Binary range length overflow", 1))?;
        if chunk.offset != offset
            || chunk.bytes.is_empty()
            || chunk.bytes.len() > BINARY_READ_MAX_RANGE_BYTES as usize
            || end > session.len()
            || chunk.eof != (end == session.len())
        {
            return Err(Failure::new(
                "corrupt_storage",
                "Binary read range failed validation",
                1,
            ));
        }
        out.write_all(&chunk.bytes).map_err(|_| output_error())?;
        vault.verify_client_lease(lease).map_err(admission)?;
        offset = end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct ShortReads {
        left: usize,
    }
    impl Read for ShortReads {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            let count = bytes.len().min(self.left).min(997);
            bytes[..count].fill(37);
            self.left -= count;
            Ok(count)
        }
    }
    #[test]
    fn short_stdin_reads_still_form_canonical_chunks_and_a_bounded_tail() {
        let length = 2 * BINARY_STAGE_MAX_CHUNK_BYTES + 17;
        let mut source = ShortReads { left: length };
        let mut lengths = Vec::new();
        let (actual, digest) = consume_input(&mut source, |sequence, offset, bytes| {
            assert_eq!(sequence as usize, lengths.len());
            assert_eq!(offset as usize, lengths.iter().sum::<usize>());
            lengths.push(bytes.len());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            lengths,
            [
                BINARY_STAGE_MAX_CHUNK_BYTES,
                BINARY_STAGE_MAX_CHUNK_BYTES,
                17
            ]
        );
        assert_eq!(actual, length as u64);
        assert_eq!(digest, Sha256Digest::of(&vec![37; length]));
    }
}
