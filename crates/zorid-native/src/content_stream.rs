//! Internal content plumbing. Callers hold the native vault lock throughout:
//! source references identify immutable bytes, never public inode ownership.
use super::*;
use crate::fs_stream::{self, StreamSnapshot};
use sha2::{Digest, Sha256};
use zorid_store::{
    BinaryCaptureRequest, BinaryReadSession, BinarySourceRef, Sha256Digest, StoredContent,
    StreamingLimits,
};

const CORE_CONTENT_CLIENT: &str = "zorid_core_native_content";

pub(super) fn core_client() -> Result<OperationId> {
    Ok(OperationId::new(CORE_CONTENT_CLIENT)?)
}

#[cfg(test)]
#[path = "content_stream_capture_tests.rs"]
mod capture_tests;

pub(super) fn file_snapshot(parent: &File, name: &str) -> Result<Option<StreamSnapshot>> {
    fs_stream::stream_snapshot(parent, name, fs_stream::MAX_STREAM_BYTES, |_| Ok(()))
}

fn key_bytes(key: &mut Sha256, bytes: &[u8]) {
    key.update((bytes.len() as u64).to_be_bytes());
    key.update(bytes);
}
fn key_state(key: &mut Sha256, state: &EntryState) {
    for bytes in [
        state.id.as_str().as_bytes(),
        state.path.as_str().as_bytes(),
        state.revision.as_str().as_bytes(),
    ] {
        key_bytes(key, bytes);
    }
    key.update([
        u8::from(state.kind == EntryKind::File),
        u8::from(state.deleted),
    ]);
}
fn key_content(key: &mut Sha256, content: &StoredContent) {
    key.update(content.len().to_be_bytes());
    key.update(content.digest().0);
    let reference = match content {
        StoredContent::InlineBytes(_) => {
            key.update([0]);
            return;
        }
        StoredContent::BinaryRef(reference) => reference,
    };
    match reference {
        BinarySourceRef::Graph(source) => {
            key.update([1]);
            for bytes in [
                source.scope.realm_id.as_str().as_bytes(),
                source.scope.vault_id.as_str().as_bytes(),
                source.identity.entry_id.as_str().as_bytes(),
                source.identity.bootstrap_id.as_str().as_bytes(),
                source.selected_event.as_str().as_bytes(),
            ] {
                key_bytes(key, bytes);
            }
        }
        BinarySourceRef::Capture(source) => {
            key.update([2]);
            for id in [
                &source.stage.local_store_id,
                &source.stage.client_id,
                &source.stage.operation_id,
                &source.stage.stage_id,
            ] {
                key_bytes(key, id.as_str().as_bytes());
            }
            key.update(source.source_commitment.0);
        }
    }
    key.update((reference.manifest().pages.len() as u64).to_be_bytes());
    for page in &reference.manifest().pages {
        key_bytes(key, page.id.as_str().as_bytes());
        key.update(page.bytes.to_be_bytes());
        key.update(page.digest.0);
    }
}

pub(super) fn snapshot_matches_content(snapshot: &StreamSnapshot, content: &StoredContent) -> bool {
    snapshot.length == content.len() && snapshot.digest == content.digest().0
}

pub(super) fn metadata_matches_content(
    metadata: &zorid_store::ContentMetadata,
    content: &StoredContent,
) -> bool {
    match (metadata, content) {
        (
            zorid_store::ContentMetadata::InlineBytes { bytes, digest },
            StoredContent::InlineBytes(content),
        ) => *bytes == content.len() as u64 && *digest == Sha256Digest::of(content),
        (
            zorid_store::ContentMetadata::BinaryRef { reference },
            StoredContent::BinaryRef(content),
        ) => reference == content,
        _ => false,
    }
}

pub(super) enum ContentSource<'a> {
    Inline(&'a [u8]),
    Binary {
        store: &'a Store,
        session: &'a BinaryReadSession,
    },
}
impl ContentSource<'_> {
    fn read(&self, offset: u64, max: usize) -> Result<Vec<u8>> {
        if max > fs_stream::STREAM_CHUNK_BYTES {
            return Err(Error::Unsupported("content source range exceeds 128 KiB"));
        }
        match self {
            Self::Inline(bytes) => {
                let offset = usize::try_from(offset)
                    .map_err(|_| Error::Busy("inline source offset overflow"))?;
                if offset > bytes.len() {
                    return Err(Error::Busy("inline source offset exceeds content"));
                }
                Ok(bytes[offset..bytes.len().min(offset + max)].to_vec())
            }
            Self::Binary { store, session } => {
                let chunk = store.read_binary_range(session, offset, max as u32)?;
                let end = offset
                    .checked_add(chunk.bytes.len() as u64)
                    .ok_or_else(|| {
                        zorid_store::StoreError::Corrupt("binary source range overflow".into())
                    })?;
                if chunk.offset != offset
                    || chunk.bytes.len() > max
                    || end > session.len()
                    || chunk.eof != (end == session.len())
                {
                    return Err(zorid_store::StoreError::Corrupt(
                        "binary source returned an inconsistent range".into(),
                    )
                    .into());
                }
                Ok(chunk.bytes)
            }
        }
    }
}

impl NativeVault {
    pub(super) fn retain_observed_content(
        &mut self,
        path: &VaultPath,
        baseline: Option<&zorid_store::ProjectionBaseline>,
        content: &StoredContent,
        physical: Option<&ObservationPhysical>,
    ) -> Result<zorid_store::ExternalObservation> {
        Ok(self.store.retain_external_content(
            &core_client()?,
            path,
            baseline,
            content,
            physical,
        )?)
    }

    /// Inline Text remains separately bounded. Binary and oversized retained
    /// alternatives use the same inert capture source, without retyping Text.
    pub(super) fn capture_observed_file(
        &mut self,
        path: &VaultPath,
        parent: &File,
        name: &str,
        origin: &OperationId,
        baseline: Option<&zorid_store::ProjectionBaseline>,
        physical: Option<&ObservationPhysical>,
        expected: &StreamSnapshot,
        prefer_inline: bool,
    ) -> Result<StoredContent> {
        self.capture_observed_file_with_scan(path, parent, name, origin, baseline, physical, expected, prefer_inline, None)
    }

    /// Reuse only the enrollment admission held by this exclusive discovery pass.
    /// The capture/source and Store mutation checks below remain independent.
    pub(super) fn capture_observed_file_with_scan(
        &mut self,
        path: &VaultPath,
        parent: &File,
        name: &str,
        origin: &OperationId,
        baseline: Option<&zorid_store::ProjectionBaseline>,
        physical: Option<&ObservationPhysical>,
        expected: &StreamSnapshot,
        prefer_inline: bool,
        scan: Option<&external_namespace::EnrolledScan<'_>>,
    ) -> Result<StoredContent> {
        let enrolled = match scan {
            Some(scan) => { scan.check(self)?; true }
            None => {
                self.paths.verify_parent(path, parent)?;
                self.store.family_enrollment_ready()?
            },
        };
        let inline_limit = if enrolled {
            self.options
                .max_file_bytes
                .min(zorid_client_sync::MAX_TEXT_BYTES)
        } else {
            self.options.max_file_bytes.min(16 * 1024 * 1024)
        };
        if (prefer_inline || !enrolled) && expected.length <= inline_limit as u64 {
            let disk = fs::snapshot(parent, name, inline_limit)?
                .ok_or(Error::Busy("inline capture source disappeared"))?;
            let content = StoredContent::InlineBytes(disk.bytes);
            if disk.identity != expected.identity
                || fs::identity(parent)? != expected.parent_identity
                || !snapshot_matches_content(expected, &content)
            {
                return Err(Error::Busy(
                    "inline capture differs from immutable observation",
                ));
            }
            return Ok(content);
        }
        let (captured, content) = self
            .capture_binary_file(
                path,
                parent,
                name,
                origin,
                baseline,
                physical,
                zorid_store::DEFAULT_STREAMING_LIMITS,
            )?
            .ok_or(Error::Busy("binary capture source disappeared"))?;
        if &captured != expected {
            return Err(Error::Busy(
                "binary capture differs from immutable observation",
            ));
        }
        Ok(content)
    }

    pub(super) fn capture_projection_file(
        &mut self,
        attempt: &ProjectionAttempt,
        parent: &File,
        name: &str,
    ) -> Result<()> {
        let snapshot = file_snapshot(parent, name)?
            .ok_or(Error::Busy("projection capture source disappeared"))?;
        self.capture_projection_snapshot(attempt, parent, name, &snapshot)
    }

    /// Bind retention to the caller's exact observed bytes and inode. Taking a
    /// fresh unrelated snapshot here could preserve B while a caller authorizes
    /// deleting A after an A -> B -> A sequence.
    pub(super) fn capture_projection_snapshot(
        &mut self,
        attempt: &ProjectionAttempt,
        parent: &File,
        name: &str,
        snapshot: &StreamSnapshot,
    ) -> Result<()> {
        let content = self.capture_observed_file(
            &attempt.target.state.path,
            parent,
            name,
            &attempt.attempt_id,
            attempt.baseline.as_ref(),
            None,
            snapshot,
            attempt
                .baseline
                .as_ref()
                .is_some_and(|baseline| baseline.content.inline_bytes().is_some()),
        )?;
        self.retain_observed_content(
            &attempt.target.state.path,
            attempt.baseline.as_ref(),
            &content,
            None,
        )?;
        Ok(())
    }

    /// Explicitly retire only this synchronous core actor's interrupted pins.
    /// Its whole operation holds the filesystem lock, so another core operation
    /// cannot still be using them. Frontend/CLI actors are never selected here.
    fn release_interrupted_content_reads(&mut self) -> Result<()> {
        let client = core_client()?;
        for reference in self.store.list_binary_reads(&client)? {
            self.store.close_binary_read(&reference)?;
        }
        Ok(())
    }

    fn with_content_source<T>(
        &mut self,
        state: Option<&EntryState>,
        content: &StoredContent,
        action: impl FnOnce(ContentSource<'_>) -> Result<T>,
    ) -> Result<T> {
        self.paths.verify()?;
        let reference = match content {
            StoredContent::InlineBytes(bytes) => {
                let result = action(ContentSource::Inline(bytes));
                self.paths.verify()?;
                return result;
            }
            StoredContent::BinaryRef(reference) => reference,
        };
        self.release_interrupted_content_reads()?;
        let client = core_client()?;
        let session = match reference {
            BinarySourceRef::Graph(source) => {
                let state = state.ok_or_else(|| {
                    zorid_store::StoreError::Corrupt(
                        "published content source requires its historical state".into(),
                    )
                })?;
                self.store.open_binary_read(&client, state, source)?
            }
            BinarySourceRef::Capture(source) => {
                // The fixed admitted actor must own the capture; its serialized
                // locator's self-claimed client is never treated as authority.
                self.store.open_capture_read(&client, source)?
            }
        };
        let result = action(ContentSource::Binary {
            store: &self.store,
            session: &session,
        });
        let close = self.store.close_binary_read(session.reference());
        self.paths.verify()?;
        // A cleanup storage failure must not be hidden by a normal path conflict.
        close?;
        result
    }

    pub(super) fn stage_projection_content(
        &mut self,
        name: &str,
        state: &EntryState,
        content: &StoredContent,
    ) -> Result<String> {
        if matches!(
            content,
            StoredContent::BinaryRef(BinarySourceRef::Capture(_))
        ) {
            return Err(zorid_store::StoreError::Corrupt(
                "inert capture cannot be a desired projection target".into(),
            )
            .into());
        }
        let directory = self.paths.private.try_clone()?;
        let length = content.len();
        let digest = content.digest().0;
        let result = self.with_content_source(Some(state), content, |source| {
            fs_stream::stage_from_source(&directory, name, length, digest, |offset, max| {
                source.read(offset, max)
            })
        });
        self.paths.verify()?;
        result
    }

    /// Existing small-byte fixture oracles still read actual verified content.
    /// Large streaming fixtures must verify bounded chunks instead of this Vec.
    #[cfg(test)]
    pub(crate) fn test_content_bytes(
        &mut self,
        state: Option<&EntryState>,
        content: &StoredContent,
    ) -> Result<Vec<u8>> {
        if content.len() > 16 * 1024 * 1024 {
            return Err(Error::Unsupported("fixture inline read exceeds 16 MiB"));
        }
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let length = content.len();
        self.with_content_source(state, content, |source| {
            let mut bytes = Vec::with_capacity(length as usize);
            while (bytes.len() as u64) < length {
                let chunk = source.read(
                    bytes.len() as u64,
                    fs_stream::STREAM_CHUNK_BYTES.min(length as usize - bytes.len()),
                )?;
                if chunk.is_empty() {
                    return Err(Error::Busy("fixture content source ended early"));
                }
                bytes.extend_from_slice(&chunk);
            }
            if !source.read(length, 1)?.is_empty() {
                return Err(Error::Busy("fixture content source has excess bytes"));
            }
            Ok(bytes)
        })
    }

    pub(super) fn verify_observed_content(
        &self,
        path: &VaultPath,
        parent: &File,
        physical: &PhysicalIdentity,
        content: &StoredContent,
    ) -> Result<()> {
        self.paths.verify_parent(path, parent)?;
        if fs::identity(parent)? != physical.parent_inode {
            return Err(Error::Busy("observation parent changed"));
        }
        let snapshot = fs_stream::stream_snapshot(
            parent,
            path.file_name(),
            fs_stream::MAX_STREAM_BYTES,
            |_| Ok(()),
        )?;
        if snapshot.as_ref().is_none_or(|snapshot| {
            snapshot.identity != physical.inode || !snapshot_matches_content(snapshot, content)
        }) {
            return Err(Error::Busy("observed file changed before import"));
        }
        self.paths.verify_parent(path, parent)
    }

    /// Retain a source without inventing a graph event or authorizing a command.
    /// The stable key names this origin and its actual physical/content facts.
    /// A later late-FD edit gets a different capture while exact retries reuse it.
    pub(super) fn capture_binary_file(
        &mut self,
        path: &VaultPath,
        parent: &File,
        name: &str,
        origin: &OperationId,
        baseline: Option<&zorid_store::ProjectionBaseline>,
        physical: Option<&ObservationPhysical>,
        limits: StreamingLimits,
    ) -> Result<Option<(StreamSnapshot, StoredContent)>> {
        self.paths.verify()?;
        let Some(before) =
            fs_stream::stream_snapshot(parent, name, fs_stream::MAX_STREAM_BYTES, |_| Ok(()))?
        else {
            return Ok(None);
        };
        if physical.is_some_and(|proof| {
            proof.physical.inode != before.identity
                || proof.physical.parent_inode != before.parent_identity
        }) {
            return Err(Error::Busy(
                "capture physical proof differs from opened source",
            ));
        }
        let mut key = Sha256::new();
        for bytes in [
            origin.as_str().as_bytes(),
            path.as_str().as_bytes(),
            before.identity.as_bytes(),
            before.parent_identity.as_bytes(),
        ] {
            key_bytes(&mut key, bytes);
        }
        key.update(before.length.to_be_bytes());
        key.update(before.digest);
        if let Some(baseline) = baseline {
            key.update([1]);
            key_state(&mut key, &baseline.state);
            key_content(&mut key, &baseline.content);
        } else {
            key.update([0]);
        }
        if let Some(proof) = physical {
            key.update([1]);
            key_bytes(&mut key, proof.physical.inode.as_bytes());
            key_bytes(&mut key, proof.physical.parent_inode.as_bytes());
            if let Some(binding) = &proof.expected_binding {
                key.update([1]);
                key_state(&mut key, &binding.state);
                key_bytes(&mut key, binding.physical.inode.as_bytes());
                key_bytes(&mut key, binding.physical.parent_inode.as_bytes());
            } else {
                key.update([0]);
            }
        } else {
            key.update([0]);
        }
        let digest: [u8; 32] = key.finalize().into();
        let suffix: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        let operation = OperationId::new(format!("native_capture_{suffix}"))?;
        let client = core_client()?;
        let stage = self.store.begin_binary_capture(
            &client,
            &operation,
            &BinaryCaptureRequest {
                path: path.clone(),
                expected_length: before.length,
                expected_digest: Sha256Digest(before.digest),
            },
            limits,
        )?;
        let status = self.store.query_binary_stage(&stage)?;
        if status.state == zorid_store::StagePhase::Receiving {
            if !status.seal_requested {
                let mut sequence = 0u32;
                let mut offset = 0u64;
                let captured = fs_stream::stream_snapshot(
                    parent,
                    name,
                    fs_stream::MAX_STREAM_BYTES,
                    |bytes| {
                        self.store
                            .append_binary_chunk(&stage, sequence, offset, bytes)?;
                        sequence += 1;
                        offset += bytes.len() as u64;
                        Ok(())
                    },
                )?
                .ok_or(Error::Busy("capture source disappeared"))?;
                if captured != before {
                    return Err(Error::Busy("capture source changed between reads"));
                }
            }
            self.store.seal_binary_stage(
                &stage,
                before.length,
                Some(Sha256Digest(before.digest)),
            )?;
        } else if status.state != zorid_store::StagePhase::Sealed {
            return Err(Error::Busy("capture source stage is not resumable"));
        }
        let reference = self.store.captured_binary_ref(&stage)?;
        if reference.manifest.bytes != before.length || reference.manifest.digest.0 != before.digest
        {
            return Err(zorid_store::StoreError::Corrupt(
                "sealed capture differs from actual source facts".into(),
            )
            .into());
        }
        self.paths.verify()?;
        Ok(Some((
            before,
            StoredContent::BinaryRef(BinarySourceRef::Capture(reference)),
        )))
    }
}
