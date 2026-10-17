//! Explicit one-entry Markdown interpretation, independent of filename extension.
//! Native read_metadata distinguishes retained Binary from inline sources. For
//! unenrolled vaults InlineBytes has no authored text mode: this explicit command
//! accepts only strict UTF-8 without NUL and reports the inline source kind.
//! No physical file read, rescan, source rewrite, index or sync occurs here.
use super::{Failure, Result};
use serde::Serialize;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId};
use zorid_document::{
    parse_markdown, DocumentMetadata, ExtractionError, MetadataRequest, DIALECT_VERSION,
    MAX_SOURCE_BYTES, SCHEMA_VERSION,
};
use zorid_native::{ContentMetadata, EntryPresentation, NativeVault, Sha256Digest};

#[derive(Serialize)]
struct Provenance {
    local_store_id: OperationId,
    source_kind: &'static str,
    interpretation: &'static str,
    source_bytes: usize,
    source_sha256: Sha256Digest,
    parser_schema: u32,
    parser_dialect: &'static str,
}
#[derive(Serialize)]
struct MetadataResult {
    entry: EntryState,
    presentation: EntryPresentation,
    metadata: DocumentMetadata,
    consistency: &'static str,
    provenance: Provenance,
    synced: bool,
}
#[derive(Serialize)]
struct Envelope {
    version: u32,
    ok: bool,
    result: MetadataResult,
}

/// Returns an already enveloped JSON document to preserve ordered maps. Going
/// through serde_json::Value would silently sort nested metadata property keys.
pub fn run(vault: &NativeVault, id: EntryId) -> Result<Vec<u8>> {
    let identity = vault.identity()?;
    let listed = vault
        .read_metadata(&id)?
        .filter(|entry| !entry.state.deleted)
        .ok_or_else(|| Failure::new("not_found", "Entry was not found", 4))?;
    if listed.state.kind != EntryKind::File {
        return Err(Failure::new("not_file", "Entry is a folder, not a file", 2));
    }
    let (length, digest) = match listed.content {
        Some(ContentMetadata::InlineBytes { bytes, digest }) => (bytes, digest),
        Some(ContentMetadata::BinaryRef { .. }) => {
            return Err(Failure::new(
                "metadata_binary_source",
                "Binary source cannot be interpreted as Markdown",
                2,
            ));
        }
        None => {
            return Err(Failure::new(
                "corrupt_storage",
                "File content is missing",
                1,
            ))
        }
    };
    if length > MAX_SOURCE_BYTES as u64 {
        return Err(source_limit());
    }
    // Each read is committed and internally coherent. Compare the opaque state
    // plus exact length/digest, so preflight mode from another revision can never
    // authorize parsing a replacement body. A race is explicit, never a retry
    // that quietly changes the revision printed with these metadata results.
    let presented = vault.read_presented(&id)?.ok_or_else(source_changed)?;
    let bytes = presented.content.ok_or_else(source_changed)?;
    if presented.state != listed.state
        || bytes.len() as u64 != length
        || Sha256Digest::of(&bytes) != digest
    {
        return Err(source_changed());
    }
    let source = source_text(bytes)?;
    let source_bytes = source.len();
    let metadata = parse_markdown(&MetadataRequest {
        entry_id: presented.state.id.clone(),
        content_revision: presented.state.revision.clone(),
        source,
    })
    .map_err(|error| match error {
        ExtractionError::SourceTooLarge { .. } => source_limit(),
    })?;
    let envelope = Envelope {
        version: 1,
        ok: true,
        result: MetadataResult {
            entry: presented.state,
            presentation: presented.presentation,
            metadata,
            consistency: "committed_per_entry",
            provenance: Provenance {
                local_store_id: identity.local_store_id,
                source_kind: "inline_bytes",
                interpretation: "explicit_markdown",
                source_bytes,
                source_sha256: digest,
                parser_schema: SCHEMA_VERSION,
                parser_dialect: DIALECT_VERSION,
            },
            synced: false,
        },
    };
    let mut output = serde_json::to_vec(&envelope).map_err(|_| {
        Failure::new(
            "metadata_encoding",
            "Could not encode extracted metadata",
            1,
        )
    })?;
    output.push(b'\n');
    Ok(output)
}
fn source_text(bytes: Vec<u8>) -> Result<String> {
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(source_limit());
    }
    if bytes.contains(&0) {
        return Err(Failure::new(
            "metadata_nul_source",
            "Markdown metadata requires a source without NUL bytes",
            2,
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        Failure::new(
            "metadata_invalid_utf8",
            "Markdown metadata requires valid UTF-8",
            2,
        )
    })
}
fn source_limit() -> Failure {
    Failure::new(
        "metadata_source_too_large",
        "Markdown source exceeds the shared parser byte limit",
        2,
    )
}
fn source_changed() -> Failure {
    Failure::new(
        "metadata_source_changed",
        "Committed source changed during metadata preflight; retry the command",
        3,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_source_checks_do_not_lossily_decode_or_raise_parser_limit() {
        assert_eq!(
            source_text(vec![255]).unwrap_err().code,
            "metadata_invalid_utf8"
        );
        assert_eq!(
            source_text(vec![b'a', 0]).unwrap_err().code,
            "metadata_nul_source"
        );
        assert_eq!(
            source_text(vec![b'x'; MAX_SOURCE_BYTES + 1])
                .unwrap_err()
                .code,
            "metadata_source_too_large"
        );
    }
}
