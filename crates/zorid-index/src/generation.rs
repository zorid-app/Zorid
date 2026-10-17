use crate::{
    EntryWitness, IndexError, IndexSnapshotId, Manifest, PublicationFence, MAX_PUMP_BYTES,
    MAX_PUMP_DOCUMENTS, RESOLVER_VERSION,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zorid_core::{EntryId, EntryKind};
use zorid_document::{
    parse_markdown, DocumentMetadata, MetadataRequest, DIALECT_VERSION, MAX_SOURCE_BYTES,
    SCHEMA_VERSION,
};

pub const INDEX_SCHEMA_VERSION: u32 = 1;
/// Result shape and dialect both invalidate derived extraction records.
pub fn document_extraction_version() -> String {
    format!("{}:metadata-{}", DIALECT_VERSION, SCHEMA_VERSION)
}
pub const LITERAL_QUERY_VERSION: &str = "literal-lines-exact-v1";
/// Initial memory ceiling for derived facts only, never source bodies.
pub const MAX_GENERATION_METADATA_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Exclusion {
    Binary,
    Unreadable,
    SourceLimit,
    ExtractionLimit,
}
impl Exclusion {
    pub fn limits_coverage(&self) -> bool {
        !matches!(self, Self::Binary)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct IndexRecord {
    witness: EntryWitness,
    metadata: Option<DocumentMetadata>,
    text_digest: Option<[u8; 32]>,
    text_bytes: usize,
    exclusion: Option<Exclusion>,
}
impl IndexRecord {
    /// Build only from an exact committed read for the captured witness. The
    /// host still validates source mode/bytes against authority before calling.
    /// No body is retained. Invalid frontmatter remains current metadata with
    /// diagnostics. Over-budget documents become explicit terminal exclusions.
    pub fn text(
        witness: EntryWitness,
        request: &MetadataRequest,
        markdown: bool,
    ) -> Result<Self, IndexError> {
        if request.entry_id != witness.entry().id
            || request.content_revision != witness.entry().revision
        {
            return Err(IndexError::StaleSource);
        }
        if request.source.len() > MAX_SOURCE_BYTES {
            return Ok(Self::excluded(witness, Exclusion::SourceLimit));
        }
        if request.source.contains('\0') {
            return Ok(Self::excluded(witness, Exclusion::Binary));
        }
        let metadata = if markdown {
            match parse_markdown(request) {
                Ok(value) => Some(value),
                Err(_) => return Ok(Self::excluded(witness, Exclusion::ExtractionLimit)),
            }
        } else {
            None
        };
        if let Some(metadata) = &metadata {
            if metadata.schema_version != SCHEMA_VERSION
                || metadata.dialect_version != DIALECT_VERSION
                || metadata.entry_id != request.entry_id
                || metadata.content_revision != request.content_revision
                || metadata.source_length.bytes as usize != request.source.len()
                || metadata.source_length.utf16 as usize != request.source.encode_utf16().count()
            {
                return Err(IndexError::InvalidRecord);
            }
            if serde_json::to_vec(metadata)
                .map_err(|_| IndexError::InvalidRecord)?
                .len()
                > MAX_GENERATION_METADATA_BYTES
            {
                return Err(IndexError::GenerationLimit);
            }
        }
        Ok(Self {
            witness,
            metadata,
            text_digest: Some(Sha256::digest(request.source.as_bytes()).into()),
            text_bytes: request.source.len(),
            exclusion: None,
        })
    }
    /// Restore a disposable cached row without parsing source or doing IO.
    /// The caller bounds encoded input before decoding, obtains witness from
    /// the exact persisted manifest, and validates its publication envelope.
    /// SHA/source content is checked only when that immutable projection is read;
    /// these structural checks are not an authenticated content capability.
    pub fn from_persisted(
        witness: EntryWitness,
        metadata: Option<DocumentMetadata>,
        text_digest: Option<[u8; 32]>,
        text_bytes: usize,
        exclusion: Option<Exclusion>,
    ) -> Result<Self, IndexError> {
        if exclusion.is_some() {
            if metadata.is_some() || text_digest.is_some() || text_bytes != 0 {
                return Err(IndexError::InvalidRecord);
            }
        } else {
            if text_digest.is_none() || text_bytes > MAX_SOURCE_BYTES {
                return Err(IndexError::InvalidRecord);
            }
            if let Some(metadata) = &metadata {
                crate::restore::validate_metadata(metadata, &witness, text_bytes)?;
            }
        }
        let record = Self {
            witness,
            metadata,
            text_digest,
            text_bytes,
            exclusion,
        };
        if record.encoded_size()? > MAX_GENERATION_METADATA_BYTES {
            return Err(IndexError::GenerationLimit);
        }
        Ok(record)
    }
    pub fn excluded(witness: EntryWitness, reason: Exclusion) -> Self {
        Self {
            witness,
            metadata: None,
            text_digest: None,
            text_bytes: 0,
            exclusion: Some(reason),
        }
    }
    pub fn witness(&self) -> &EntryWitness {
        &self.witness
    }
    pub fn metadata(&self) -> Option<&DocumentMetadata> {
        self.metadata.as_ref()
    }
    pub fn text_bytes(&self) -> usize {
        self.text_bytes
    }
    pub fn exclusion(&self) -> Option<&Exclusion> {
        self.exclusion.as_ref()
    }
    pub fn text_digest(&self) -> Option<&[u8; 32]> {
        self.text_digest.as_ref()
    }
    pub fn check_text(&self, bytes: &[u8]) -> Result<(), IndexError> {
        let actual: [u8; 32] = Sha256::digest(bytes).into();
        if self.text_digest != Some(actual) || self.text_bytes != bytes.len() {
            return Err(IndexError::ContentMismatch);
        }
        Ok(())
    }
    /// Reuse only unchanged stable ID/revision/path/type in the same local store.
    /// Moving entries are reparsed in this first slice; no guessed byte identity.
    pub fn rebind_unchanged(&self, manifest: &Manifest) -> Result<Self, IndexError> {
        if self.witness.source().local_store_id() != manifest.source().local_store_id()
            || manifest.entry(&self.witness.entry().id) != Some(self.witness.entry())
        {
            return Err(IndexError::StaleSource);
        }
        let mut result = self.clone();
        result.witness = manifest.witness(&self.witness.entry().id)?;
        Ok(result)
    }
    fn encoded_size(&self) -> Result<usize, IndexError> {
        let metadata = self
            .metadata
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| IndexError::InvalidRecord)?
            .map_or(0, |bytes| bytes.len());
        Ok(metadata
            + self.witness.entry().path.as_str().len()
            + self.witness.entry().id.as_str().len()
            + 256)
    }
}
/// Immutable complete derived generation; facts and text references only. Host
/// persists generation rows/head with the prepared publication fence; query text
/// reads must select THIS generation's retained projection, never today's body.
#[derive(Clone, Debug)]
pub struct Generation {
    id: IndexSnapshotId,
    manifest: Manifest,
    records: BTreeMap<EntryId, IndexRecord>,
}
impl Generation {
    pub fn id(&self) -> &IndexSnapshotId {
        &self.id
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn record(&self, id: &EntryId) -> Option<&IndexRecord> {
        self.records.get(id)
    }
    pub fn records(&self) -> impl Iterator<Item = &IndexRecord> {
        self.manifest
            .entries()
            .iter()
            .filter_map(|e| self.records.get(&e.id))
    }
    pub fn coverage_complete(&self) -> bool {
        !self
            .records
            .values()
            .any(|r| r.exclusion.as_ref().is_some_and(Exclusion::limits_coverage))
    }
}
/// Pump batches are bounded independently of the immutable generation ceiling.
/// Duplicate rows reject; source/index heads are not advanced by staging.
pub struct GenerationBuilder {
    manifest: Manifest,
    fence: PublicationFence,
    records: BTreeMap<EntryId, IndexRecord>,
    total_bytes: usize,
    pump_documents: usize,
    pump_source_bytes: usize,
    pump_output_bytes: usize,
}
impl GenerationBuilder {
    pub fn new(manifest: Manifest, fence: PublicationFence) -> Result<Self, IndexError> {
        if manifest.source() != fence.source() {
            return Err(IndexError::StaleSource);
        }
        if fence.next_index().versions().schema() != INDEX_SCHEMA_VERSION
            || fence.next_index().versions().extraction() != document_extraction_version()
            || fence.next_index().versions().resolver() != RESOLVER_VERSION
            || fence.next_index().versions().query() != LITERAL_QUERY_VERSION
        {
            return Err(IndexError::InvalidVersion);
        }
        Ok(Self {
            manifest,
            fence,
            records: BTreeMap::new(),
            total_bytes: 0,
            pump_documents: 0,
            pump_source_bytes: 0,
            pump_output_bytes: 0,
        })
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn record(&self, id: &EntryId) -> Option<&IndexRecord> {
        self.records.get(id)
    }
    pub fn prepared_records(&self) -> usize {
        self.records.len()
    }
    pub fn metadata_bytes(&self) -> usize {
        self.total_bytes
    }
    pub fn pending_entries(&self) -> Vec<EntryWitness> {
        self.manifest
            .entries()
            .iter()
            .filter(|entry| entry.kind == EntryKind::File && !self.records.contains_key(&entry.id))
            .take(MAX_PUMP_DOCUMENTS)
            .map(|entry| self.manifest.witness(&entry.id).expect("validated file"))
            .collect()
    }
    pub fn ready(&self) -> bool {
        self.manifest
            .entries()
            .iter()
            .filter(|entry| entry.kind == EntryKind::File)
            .count()
            == self.records.len()
    }
    /// Prefer this entry point for new work: the known source budget is checked
    /// before parsing. Reused rows use add(). Errors do not advance any head.
    pub fn extract_and_add(
        &mut self,
        witness: EntryWitness,
        request: &MetadataRequest,
        markdown: bool,
    ) -> Result<(), IndexError> {
        self.manifest.check_witness(&witness)?;
        let source_bytes = if request.source.len() > MAX_SOURCE_BYTES {
            0
        } else {
            request.source.len()
        };
        if self.pump_documents == MAX_PUMP_DOCUMENTS
            || (self.pump_documents > 0 && self.pump_source_bytes + source_bytes > MAX_PUMP_BYTES)
        {
            return Err(IndexError::PumpLimit);
        }
        self.add(IndexRecord::text(witness, request, markdown)?)
    }
    /// Start another bounded pump after returning control to the caller.
    pub fn begin_pump(&mut self) {
        self.pump_documents = 0;
        self.pump_source_bytes = 0;
        self.pump_output_bytes = 0;
    }
    pub fn add(&mut self, record: IndexRecord) -> Result<(), IndexError> {
        self.manifest.check_witness(record.witness())?;
        if record.metadata.as_ref().is_some_and(|metadata| {
            metadata.schema_version != SCHEMA_VERSION || metadata.dialect_version != DIALECT_VERSION
        }) {
            return Err(IndexError::InvalidVersion);
        }
        let id = record.witness.entry().id.clone();
        if self.records.contains_key(&id) {
            return Err(IndexError::InvalidRecord);
        }
        let bytes = record.encoded_size()?;
        if self.pump_documents == MAX_PUMP_DOCUMENTS
            || (self.pump_documents > 0
                && (self.pump_source_bytes + record.text_bytes > MAX_PUMP_BYTES
                    || self.pump_output_bytes + bytes > MAX_PUMP_BYTES))
        {
            return Err(IndexError::PumpLimit);
        }
        if self.total_bytes + bytes > MAX_GENERATION_METADATA_BYTES {
            return Err(IndexError::GenerationLimit);
        }
        self.pump_documents += 1;
        self.pump_source_bytes += record.text_bytes;
        self.pump_output_bytes += bytes;
        self.total_bytes += bytes;
        self.records.insert(id, record);
        Ok(())
    }
    pub fn finish(self) -> Result<PreparedGeneration, IndexError> {
        if self
            .manifest
            .entries()
            .iter()
            .filter(|e| e.kind == EntryKind::File)
            .count()
            != self.records.len()
        {
            return Err(IndexError::InvalidRecord);
        }
        Ok(PreparedGeneration {
            generation: Generation {
                id: self.fence.next_index().clone(),
                manifest: self.manifest,
                records: self.records,
            },
            fence: self.fence,
        })
    }
}
pub struct PreparedGeneration {
    generation: Generation,
    fence: PublicationFence,
}
impl PreparedGeneration {
    pub fn generation(&self) -> &Generation {
        &self.generation
    }
    pub fn fence(&self) -> &PublicationFence {
        &self.fence
    }
    /// Inspection of staging never certifies durable publication.
    pub fn into_parts(self) -> (PublicationFence, Generation) {
        (self.fence, self.generation)
    }
}
