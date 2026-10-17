//! Shared disposable row transport. Deserialization alone is not validation.
use crate::{EntryWitness, Exclusion, IndexError, IndexRecord, MetadataProjection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedIndexRecord {
    pub metadata: Option<MetadataProjection>,
    pub digest: Option<[u8; 32]>,
    pub text_bytes: usize,
    pub exclusion: Option<Exclusion>,
}
impl PersistedIndexRecord {
    pub fn of(record: &IndexRecord) -> Self {
        Self::from(record)
    }
    /// Hosts bound encoded bytes BEFORE decoding. A witness must come from the
    /// exact stored manifest; heads/fences remain host transaction authority.
    pub fn restore(self, witness: EntryWitness) -> Result<IndexRecord, IndexError> {
        IndexRecord::from_persisted(
            witness,
            self.metadata,
            self.digest,
            self.text_bytes,
            self.exclusion,
        )
    }
}
impl From<&IndexRecord> for PersistedIndexRecord {
    fn from(record: &IndexRecord) -> Self {
        Self {
            metadata: record.metadata().cloned(),
            digest: record.text_digest().copied(),
            text_bytes: record.text_bytes(),
            exclusion: record.exclusion().cloned(),
        }
    }
}
