use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId};

pub const MAX_PUMP_DOCUMENTS: usize = 32;
pub const MAX_PUMP_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IndexError {
    InvalidWatermark,
    InvalidVersion,
    InvalidGeneration,
    InvalidManifest,
    MissingSource,
    StaleSource,
    StaleIndex,
    InvalidTarget,
    InvalidRecord,
    GenerationLimit,
    PumpLimit,
    InvalidQuery,
    InvalidBudget,
    SnapshotExpired,
    QueryMismatch,
    ContentMismatch,
    NoProgress,
}
impl std::fmt::Display for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Derived index contract error: {self:?}")
    }
}
impl std::error::Error for IndexError {}

/// Local authority sequence; never a remote cursor or content revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SourceWatermark(String);
impl SourceWatermark {
    pub fn new(value: impl Into<String>) -> Result<Self, IndexError> {
        let value = value.into();
        match value.parse::<u64>() {
            Ok(n) if n.to_string() == value => Ok(Self(value)),
            _ => Err(IndexError::InvalidWatermark),
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSnapshotId {
    local_store_id: OperationId,
    watermark: SourceWatermark,
}
impl SourceSnapshotId {
    pub fn new(local_store_id: OperationId, watermark: SourceWatermark) -> Self {
        Self {
            local_store_id,
            watermark,
        }
    }
    pub fn local_store_id(&self) -> &OperationId {
        &self.local_store_id
    }
    pub fn watermark(&self) -> &SourceWatermark {
        &self.watermark
    }
}
/// Opaque case-sensitive semantic tags. Equality determines compatibility.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "VersionsWire", into = "VersionsWire")]
pub struct SemanticVersions {
    schema: u32,
    extraction: String,
    resolver: String,
    query: String,
}
impl SemanticVersions {
    pub fn new(
        schema: u32,
        extraction: impl Into<String>,
        resolver: impl Into<String>,
        query: impl Into<String>,
    ) -> Result<Self, IndexError> {
        let (extraction, resolver, query) = (extraction.into(), resolver.into(), query.into());
        if schema == 0
            || [&extraction, &resolver, &query].iter().any(|s| {
                s.is_empty()
                    || s.len() > 128
                    || !s.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':')
                    })
            })
        {
            return Err(IndexError::InvalidVersion);
        }
        Ok(Self {
            schema,
            extraction,
            resolver,
            query,
        })
    }
    pub fn schema(&self) -> u32 {
        self.schema
    }
    pub fn extraction(&self) -> &str {
        &self.extraction
    }
    pub fn resolver(&self) -> &str {
        &self.resolver
    }
    pub fn query(&self) -> &str {
        &self.query
    }
}
/// Immutable derived row-set identity; serialize generation as decimal at JS boundaries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "IndexSnapshotWire", into = "IndexSnapshotWire")]
pub struct IndexSnapshotId {
    local_store_id: OperationId,
    generation_epoch: OperationId,
    generation: u64,
    versions: SemanticVersions,
}
impl IndexSnapshotId {
    pub fn new(
        local_store_id: OperationId,
        generation_epoch: OperationId,
        generation: u64,
        versions: SemanticVersions,
    ) -> Result<Self, IndexError> {
        if generation == 0 {
            return Err(IndexError::InvalidGeneration);
        }
        Ok(Self {
            local_store_id,
            generation_epoch,
            generation,
            versions,
        })
    }
    pub fn local_store_id(&self) -> &OperationId {
        &self.local_store_id
    }
    /// Fresh host-CSPRNG token after cache discard/rebuild; never reuse an epoch.
    pub fn generation_epoch(&self) -> &OperationId {
        &self.generation_epoch
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn versions(&self) -> &SemanticVersions {
        &self.versions
    }
}
/// Complete committed namespace, without document bodies. Construction validates
/// shape, not that the host actually captured its inventory/head transactionally.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    source: SourceSnapshotId,
    entries: Vec<EntryState>,
}
impl Manifest {
    pub fn new(source: SourceSnapshotId, mut entries: Vec<EntryState>) -> Result<Self, IndexError> {
        let (mut ids, mut paths) = (BTreeSet::new(), BTreeSet::new());
        for entry in &entries {
            if entry.deleted || !ids.insert(entry.id.clone()) || !paths.insert(entry.path.clone()) {
                return Err(IndexError::InvalidManifest);
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
        Ok(Self { source, entries })
    }
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
    pub fn entries(&self) -> &[EntryState] {
        &self.entries
    }
    pub fn entry(&self, id: &EntryId) -> Option<&EntryState> {
        self.entries.iter().find(|entry| &entry.id == id)
    }
    pub fn witness(&self, id: &EntryId) -> Result<EntryWitness, IndexError> {
        let entry = self
            .entry(id)
            .filter(|e| e.kind == EntryKind::File)
            .ok_or(IndexError::MissingSource)?;
        Ok(EntryWitness {
            source: self.source.clone(),
            entry: entry.clone(),
        })
    }
    /// Namespace precondition only. Later metadata plans additionally verify
    /// exact content mode/digest/parser provenance; this is not a byte proof.
    pub fn check_witness(&self, witness: &EntryWitness) -> Result<(), IndexError> {
        if self.source != witness.source || self.entry(&witness.entry.id) != Some(&witness.entry) {
            return Err(IndexError::StaleSource);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryWitness {
    source: SourceSnapshotId,
    entry: EntryState,
}
impl EntryWitness {
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
    pub fn entry(&self) -> &EntryState {
        &self.entry
    }
}
/// Host must recheck this fence inside its atomic source/index publish transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationFence {
    source: SourceSnapshotId,
    expected_index: Option<IndexSnapshotId>,
    next_index: IndexSnapshotId,
}
impl PublicationFence {
    pub fn new(
        source: SourceSnapshotId,
        expected_index: Option<IndexSnapshotId>,
        next_index: IndexSnapshotId,
    ) -> Result<Self, IndexError> {
        if source.local_store_id != next_index.local_store_id
            || expected_index.as_ref().is_some_and(|old| {
                old.local_store_id != source.local_store_id
                    || (old.generation_epoch == next_index.generation_epoch
                        && old.generation >= next_index.generation)
            })
        {
            return Err(IndexError::InvalidGeneration);
        }
        Ok(Self {
            source,
            expected_index,
            next_index,
        })
    }
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
    pub fn expected_index(&self) -> Option<&IndexSnapshotId> {
        self.expected_index.as_ref()
    }
    pub fn next_index(&self) -> &IndexSnapshotId {
        &self.next_index
    }
    pub fn check(
        &self,
        observed_source: &SourceSnapshotId,
        observed_index: Option<&IndexSnapshotId>,
    ) -> Result<(), IndexError> {
        if observed_source != &self.source {
            return Err(IndexError::StaleSource);
        }
        if observed_index != self.expected_index.as_ref() {
            return Err(IndexError::StaleIndex);
        }
        Ok(())
    }
}

impl TryFrom<String> for SourceWatermark {
    type Error = IndexError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
impl From<SourceWatermark> for String {
    fn from(value: SourceWatermark) -> Self {
        value.0
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionsWire {
    schema: u32,
    extraction: String,
    resolver: String,
    query: String,
}
impl TryFrom<VersionsWire> for SemanticVersions {
    type Error = IndexError;
    fn try_from(value: VersionsWire) -> Result<Self, Self::Error> {
        Self::new(value.schema, value.extraction, value.resolver, value.query)
    }
}
impl From<SemanticVersions> for VersionsWire {
    fn from(value: SemanticVersions) -> Self {
        Self {
            schema: value.schema,
            extraction: value.extraction,
            resolver: value.resolver,
            query: value.query,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexSnapshotWire {
    local_store_id: OperationId,
    generation_epoch: OperationId,
    generation: String,
    versions: SemanticVersions,
}
impl TryFrom<IndexSnapshotWire> for IndexSnapshotId {
    type Error = IndexError;
    fn try_from(value: IndexSnapshotWire) -> Result<Self, Self::Error> {
        let generation = value
            .generation
            .parse::<u64>()
            .ok()
            .filter(|n| n.to_string() == value.generation)
            .ok_or(IndexError::InvalidGeneration)?;
        Self::new(
            value.local_store_id,
            value.generation_epoch,
            generation,
            value.versions,
        )
    }
}
impl From<IndexSnapshotId> for IndexSnapshotWire {
    fn from(value: IndexSnapshotId) -> Self {
        Self {
            local_store_id: value.local_store_id,
            generation_epoch: value.generation_epoch,
            generation: value.generation.to_string(),
            versions: value.versions,
        }
    }
}
