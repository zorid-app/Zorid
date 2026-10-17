//! Additive bounded files-v2 binary emission and verification. No persistence,
//! authorization, visibility or physical-path ownership is granted by this module.
use crate::metadata::{BinaryContentRef, GraphRecord, GraphRecordBody, MetadataState};
use crate::{v2, ChunkPage, ChunkRef, Error, Manifest, PageRef, Result, Scope, Sha256Digest};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zorid_sync_protocol::UpdateId;

/// The host resolves only immutable authenticated/authored content in this scope.
/// A descriptor with missing backing bytes is damaged storage, not a download.
/// Implementations recheck exact payload/summary commitments against their ledger.
pub trait ChunkSource {
    fn read_chunk(
        &mut self,
        scope: &Scope,
        id: &UpdateId,
        expected: &GraphRecord,
    ) -> Result<Vec<u8>>;
}
/// Sink writes must stay private until finish. A failed stream may have written
/// provisional chunks, but never authorizes a partial public file or receipt.
pub trait ContentSink {
    fn write_chunk(&mut self, bytes: &[u8]) -> Result<()>;
    fn finish(&mut self, verified: &VerifiedManifest) -> Result<()>;
}
/// One bounded exact payload emission. Persist it before advancing stage state.
#[derive(Debug)]
pub struct AuthoredRecord {
    id: UpdateId,
    scope: Scope,
    payload: Vec<u8>,
    record: GraphRecord,
}
impl AuthoredRecord {
    pub fn id(&self) -> &UpdateId {
        &self.id
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn payload_bytes(&self) -> &[u8] {
        &self.payload
    }
    pub fn record(&self) -> &GraphRecord {
        &self.record
    }
}
/// Built from actual input bytes, but not a proof of their durable storage.
#[derive(Debug)]
pub struct BuiltManifest {
    manifest: Manifest,
}
impl BuiltManifest {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
}

/// Holds at most one page of chunk references, bounded page refs and a hasher.
/// A short chunk terminates input. Flush pending refs before finish.
pub struct BinaryManifestBuilder {
    scope: Scope,
    hasher: Sha256,
    length: u64,
    pending: Vec<ChunkRef>,
    pages: Vec<PageRef>,
    ids: BTreeSet<UpdateId>,
    short_chunk: bool,
}
impl BinaryManifestBuilder {
    pub fn new(scope: Scope) -> Self {
        Self {
            scope,
            hasher: Sha256::new(),
            length: 0,
            pending: Vec::new(),
            pages: Vec::new(),
            ids: BTreeSet::new(),
            short_chunk: false,
        }
    }
    pub fn pending_chunks(&self) -> usize {
        self.pending.len()
    }
    pub fn accepted_length(&self) -> u64 {
        self.length
    }
    fn emission(&self, id: UpdateId, body: v2::Body) -> Result<AuthoredRecord> {
        let payload = v2::Payload {
            family: crate::Family::Files,
            format_version: v2::FORMAT_VERSION,
            scope: self.scope.clone(),
            id,
            body,
        };
        let bytes = payload.encode()?;
        let (scope, id, record) = GraphRecord::from_authored_exact(&bytes)?;
        Ok(AuthoredRecord {
            id,
            scope,
            payload: bytes,
            record,
        })
    }
    pub fn push_chunk(&mut self, id: UpdateId, bytes: &[u8]) -> Result<AuthoredRecord> {
        if bytes.is_empty()
            || bytes.len() > crate::MAX_CHUNK_BYTES
            || self.pending.len() >= crate::MAX_PAGE_CHUNKS
            || self.short_chunk
        {
            return Err(Error::InvalidContent);
        }
        let length = self
            .length
            .checked_add(bytes.len() as u64)
            .ok_or(Error::TooLarge)?;
        if length > crate::MAX_FILE_BYTES || self.pages.len() >= crate::MAX_MANIFEST_PAGES {
            return Err(Error::TooLarge);
        }
        if self.ids.contains(&id) {
            return Err(Error::DuplicateMismatch);
        }
        // Validate/encode before changing builder state, preserving exact retry.
        let emission = self.emission(
            id.clone(),
            v2::Body::Chunk {
                bytes: bytes.to_vec(),
            },
        )?;
        self.pending.push(ChunkRef {
            id: id.clone(),
            bytes: bytes.len() as u32,
            digest: Sha256Digest::of(bytes),
        });
        self.ids.insert(id);
        self.hasher.update(bytes);
        self.length = length;
        self.short_chunk = bytes.len() < crate::MAX_CHUNK_BYTES;
        Ok(emission)
    }
    pub fn flush_page(&mut self, id: UpdateId) -> Result<AuthoredRecord> {
        if self.pending.is_empty() {
            return Err(Error::InvalidContent);
        }
        if self.pages.len() >= crate::MAX_MANIFEST_PAGES {
            return Err(Error::TooLarge);
        }
        if self.ids.contains(&id) {
            return Err(Error::DuplicateMismatch);
        }
        let page = ChunkPage {
            chunks: self.pending.clone(),
        };
        let reference = page.reference(id.clone())?;
        let emission = self.emission(id.clone(), v2::Body::Page { page })?;
        self.ids.insert(id);
        self.pages.push(reference);
        self.pending.clear();
        Ok(emission)
    }
    pub fn finish(self) -> Result<BuiltManifest> {
        if !self.pending.is_empty() {
            return Err(Error::InvalidContent);
        }
        let manifest = Manifest {
            bytes: self.length,
            digest: Sha256Digest(self.hasher.finalize().into()),
            pages: self.pages,
        };
        manifest.validate()?;
        Ok(BuiltManifest { manifest })
    }
}

/// In-process content proof, bound to exact metadata and a complete manifest.
/// No Deserialize or public constructor. It does not authorize namespace writes.
#[derive(Debug)]
pub struct VerifiedManifest {
    state: Sha256Digest,
    manifest: Manifest,
}
impl VerifiedManifest {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn check_preconditions(&self, actual: &MetadataState, manifest: &Manifest) -> Result<()> {
        if self.state != actual.fingerprint()? || &self.manifest != manifest {
            return Err(Error::VersionConflict);
        }
        Ok(())
    }
}
/// Complete retained manifests only. Incomplete dependencies remain metadata
/// pending; this set cannot be deserialized or restored from a boolean cache.
#[derive(Debug)]
pub struct VerifiedBinarySet {
    state: Sha256Digest,
    manifests: BTreeMap<Vec<u8>, VerifiedManifest>,
}
impl VerifiedBinarySet {
    pub fn check_preconditions(&self, actual: &MetadataState) -> Result<()> {
        if self.state != actual.fingerprint()? {
            return Err(Error::VersionConflict);
        }
        Ok(())
    }
    pub fn get(&self, manifest: &Manifest) -> Result<Option<&VerifiedManifest>> {
        let key = serde_json::to_vec(manifest).map_err(|_| Error::InvalidContent)?;
        Ok(self.manifests.get(&key))
    }
    pub fn len(&self) -> usize {
        self.manifests.len()
    }
    pub fn is_empty(&self) -> bool {
        self.manifests.is_empty()
    }
}
/// One exact request from a verifier. The sequence disambiguates repeated chunk
/// IDs in a manifest; manifest_index disambiguates all-history verification.
#[derive(Debug, Clone)]
pub struct ChunkRequest {
    manifest_index: u32,
    sequence: u32,
    scope: Scope,
    id: UpdateId,
    expected: GraphRecord,
}
impl ChunkRequest {
    pub fn manifest_index(&self) -> u32 {
        self.manifest_index
    }
    pub fn sequence(&self) -> u32 {
        self.sequence
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn id(&self) -> &UpdateId {
        &self.id
    }
    pub fn expected(&self) -> &GraphRecord {
        &self.expected
    }
}
/// Portable resumable driver for asynchronous host storage. Hashing, ordering
/// and proof creation stay in Rust; JSON cannot manufacture a completed proof.
pub struct ManifestVerificationSession {
    fingerprint: Sha256Digest,
    manifest: Manifest,
    requests: Vec<ChunkRequest>,
    position: usize,
    total: u64,
    hasher: Sha256,
}
impl ManifestVerificationSession {
    pub fn new(state: &MetadataState, manifest: &Manifest) -> Result<Self> {
        state.metadata_view()?;
        Self::from_validated(state, manifest, 0, state.fingerprint()?)
    }
    fn from_validated(
        state: &MetadataState,
        manifest: &Manifest,
        index: u32,
        fingerprint: Sha256Digest,
    ) -> Result<Self> {
        if !state.content_status(manifest)?.missing.is_empty() {
            return Err(Error::InvalidContent);
        }
        let mut requests = Vec::new();
        for page_ref in &manifest.pages {
            let record = state
                .records()
                .get(&page_ref.id)
                .ok_or(Error::InvalidState)?;
            let GraphRecordBody::Page { page } = record.body() else {
                return Err(Error::InvalidContent);
            };
            for chunk in &page.chunks {
                let expected = state
                    .records()
                    .get(&chunk.id)
                    .ok_or(Error::InvalidState)?
                    .clone();
                requests.push(ChunkRequest {
                    manifest_index: index,
                    sequence: requests.len() as u32,
                    scope: state.scope().clone(),
                    id: chunk.id.clone(),
                    expected,
                });
            }
        }
        Ok(Self {
            fingerprint,
            manifest: manifest.clone(),
            requests,
            position: 0,
            total: 0,
            hasher: Sha256::new(),
        })
    }
    pub fn next_chunk(&self) -> Option<&ChunkRequest> {
        self.requests.get(self.position)
    }
    pub fn provide_chunk(&mut self, sequence: u32, bytes: &[u8]) -> Result<()> {
        let request = self.next_chunk().ok_or(Error::InvalidState)?;
        if request.sequence != sequence {
            return Err(Error::VersionConflict);
        }
        let GraphRecordBody::Chunk {
            bytes: expected,
            digest,
        } = request.expected.body()
        else {
            return Err(Error::InvalidContent);
        };
        if bytes.len() > crate::MAX_CHUNK_BYTES
            || bytes.len() != *expected as usize
            || Sha256Digest::of(bytes) != *digest
        {
            return Err(Error::InvalidContent);
        }
        let total = self
            .total
            .checked_add(bytes.len() as u64)
            .ok_or(Error::TooLarge)?;
        if total > self.manifest.bytes {
            return Err(Error::InvalidContent);
        }
        self.hasher.update(bytes);
        self.total = total;
        self.position += 1;
        Ok(())
    }
    pub fn finish(self) -> Result<VerifiedManifest> {
        if self.position != self.requests.len()
            || self.total != self.manifest.bytes
            || Sha256Digest(self.hasher.finalize().into()) != self.manifest.digest
        {
            return Err(Error::InvalidContent);
        }
        Ok(VerifiedManifest {
            state: self.fingerprint,
            manifest: self.manifest,
        })
    }
}
/// Holds one active manifest driver. Metadata is owned so a WASM wrapper can
/// await IndexedDB without self-referential borrows or whole-content preload.
pub struct AllBinaryVerificationSession {
    state: MetadataState,
    fingerprint: Sha256Digest,
    manifests: Vec<Manifest>,
    index: usize,
    current: Option<ManifestVerificationSession>,
    verified: BTreeMap<Vec<u8>, VerifiedManifest>,
}
impl AllBinaryVerificationSession {
    pub fn new(state: MetadataState) -> Result<Self> {
        state.metadata_view()?;
        let fingerprint = state.fingerprint()?;
        let mut complete = BTreeMap::new();
        let mut work = 0u64;
        for manifest in state.manifests() {
            let key = serde_json::to_vec(manifest).map_err(|_| Error::InvalidContent)?;
            if complete.contains_key(&key) || !state.content_status(manifest)?.missing.is_empty() {
                continue;
            }
            work = work.checked_add(manifest.bytes).ok_or(Error::TooLarge)?;
            if work > crate::MAX_MANIFEST_VERIFY_BYTES {
                return Err(Error::TooLarge);
            }
            complete.insert(key, manifest.clone());
        }
        Ok(Self {
            state,
            fingerprint,
            manifests: complete.into_values().collect(),
            index: 0,
            current: None,
            verified: BTreeMap::new(),
        })
    }
    pub fn next_chunk(&mut self) -> Result<Option<&ChunkRequest>> {
        loop {
            if self.current.is_none() {
                let Some(manifest) = self.manifests.get(self.index) else {
                    return Ok(None);
                };
                self.current = Some(ManifestVerificationSession::from_validated(
                    &self.state,
                    manifest,
                    self.index as u32,
                    self.fingerprint.clone(),
                )?);
            }
            if self
                .current
                .as_ref()
                .ok_or(Error::InvalidState)?
                .next_chunk()
                .is_some()
            {
                break;
            }
            let verified = self.current.take().ok_or(Error::InvalidState)?.finish()?;
            let key = serde_json::to_vec(verified.manifest()).map_err(|_| Error::InvalidContent)?;
            self.verified.insert(key, verified);
            self.index += 1;
        }
        Ok(self
            .current
            .as_ref()
            .and_then(|current| current.next_chunk()))
    }
    pub fn provide_chunk(
        &mut self,
        manifest_index: u32,
        sequence: u32,
        bytes: &[u8],
    ) -> Result<()> {
        if manifest_index as usize != self.index {
            return Err(Error::VersionConflict);
        }
        self.current
            .as_mut()
            .ok_or(Error::InvalidState)?
            .provide_chunk(sequence, bytes)
    }
    pub fn finish(mut self) -> Result<VerifiedBinarySet> {
        if self.next_chunk()?.is_some() {
            return Err(Error::InvalidContent);
        }
        Ok(VerifiedBinarySet {
            state: self.fingerprint,
            manifests: self.verified,
        })
    }
}
fn visit_chunks(
    state: &MetadataState,
    manifest: &Manifest,
    source: &mut impl ChunkSource,
    mut consume: impl FnMut(&[u8]) -> Result<()>,
) -> Result<VerifiedManifest> {
    let mut session = ManifestVerificationSession::new(state, manifest)?;
    while let Some(request) = session.next_chunk().cloned() {
        let bytes = source.read_chunk(request.scope(), request.id(), request.expected())?;
        session.provide_chunk(request.sequence(), &bytes)?;
        consume(&bytes)?;
    }
    session.finish()
}
/// Validates metadata roles and actual source bytes through the same resumable
/// driver used by asynchronous hosts. No whole-file result is allocated.
pub fn verify_manifest(
    state: &MetadataState,
    manifest: &Manifest,
    source: &mut impl ChunkSource,
) -> Result<VerifiedManifest> {
    visit_chunks(state, manifest, source, |_| Ok(()))
}
/// Preserve all-history ingress verification and the existing work cap. There
/// is no persisted verification-boolean cache and no preferred-head shortcut.
pub fn verify_complete_binary_manifests(
    state: &MetadataState,
    source: &mut impl ChunkSource,
) -> Result<VerifiedBinarySet> {
    let mut session = AllBinaryVerificationSession::new(state.clone())?;
    while let Some(request) = session.next_chunk()?.cloned() {
        let bytes = source.read_chunk(request.scope(), request.id(), request.expected())?;
        session.provide_chunk(request.manifest_index(), request.sequence(), &bytes)?;
    }
    session.finish()
}
/// Historical causal identity is re-derived from metadata, never substituted by
/// an unrelated manifest with identical bytes. Preverify before writing anything,
/// then recheck bytes while feeding a private sink; finish alone authorizes its
/// caller to finalize the exact complete content. Read corruption remains error.
pub fn stream_binary(
    state: &MetadataState,
    content: &BinaryContentRef,
    source: &mut impl ChunkSource,
    sink: &mut impl ContentSink,
) -> Result<VerifiedManifest> {
    if state.scope() != content.scope() {
        return Err(Error::IdentityMismatch);
    }
    let actual = state.binary_content_ref(content.entry(), content.selected_event())?;
    if actual != *content {
        return Err(Error::VersionConflict);
    }
    let verified = verify_manifest(state, content.manifest(), source)?;
    visit_chunks(state, content.manifest(), source, |bytes| {
        sink.write_chunk(bytes)
    })?;
    sink.finish(&verified)?;
    Ok(verified)
}
