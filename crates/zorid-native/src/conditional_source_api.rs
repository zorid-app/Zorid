//! A physical saved-source observation is deliberately separate from core read
//! content. Its logical witness identifies the entry, not the returned bytes.
use crate::{EntryId, OperationId, Revision, VaultPath};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const MAX_CONDITIONAL_SOURCE_BYTES: usize = zorid_store::MAX_HOST_SOURCE_BYTES as usize;
pub const MAX_CONDITIONAL_SOURCE_CAPTURES: usize = zorid_store::MAX_HOST_SOURCE_CAPTURES as usize;
pub const MAX_CONDITIONAL_SOURCE_TOTAL_BYTES: u64 = zorid_store::MAX_HOST_SOURCE_TOTAL_BYTES;
pub const MAX_CONDITIONAL_SOURCE_PATH_BYTES: usize = zorid_store::MAX_HOST_SOURCE_PATH_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConditionalSavedSourceWitness {
    pub entry_id: EntryId,
    pub revision: Revision,
    pub path: VaultPath,
}

#[derive(Debug)]
pub struct ConditionalSavedSourceCapture {
    pub capture_id: OperationId,
    pub logical_witness: ConditionalSavedSourceWitness,
    /// Exact UTF-8 physical bytes; never a replacement CRDT baseline.
    pub source: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionalSourceError {
    Changed,
    Owner,
    Limit,
}
impl fmt::Display for ConditionalSourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Changed => {
                "The captured saved source changed; the conditional write was not authored"
            }
            Self::Owner => "The saved-source capture belongs to another owner",
            Self::Limit => "The bounded saved-source capture capacity was exhausted",
        })
    }
}
