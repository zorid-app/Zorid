//! Typed content locators. Serialization carries identity, never verification or
//! permission. Every use resolves the owning store and immutable source rows.
//! These serde forms are versioned local SQL persistence, not a public JSON
//! transport contract. Generated protobuf adapters own boundary encoding and
//! must not turn a locator into a private proof. No files-v2 encoding changes.
use super::*;
use zorid_core::OperationId;
use zorid_file_sync::{
    metadata::{BinaryContentRef, MetadataState},
    EntryIdentity, Manifest, Scope, Sha256Digest,
};
use zorid_sync_protocol::UpdateId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BinaryStageLocator {
    pub local_store_id: OperationId,
    pub client_id: OperationId,
    pub operation_id: OperationId,
    pub stage_id: OperationId,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublishedBinaryRef {
    pub scope: Scope,
    pub identity: EntryIdentity,
    pub selected_event: UpdateId,
    pub manifest: Manifest,
}
impl PublishedBinaryRef {
    pub(super) fn from_verified_content(value: &BinaryContentRef) -> Self {
        Self {
            scope: value.scope().clone(),
            identity: value.entry().clone(),
            selected_event: value.selected_event().clone(),
            manifest: value.manifest().clone(),
        }
    }
    pub(super) fn resolve(&self, metadata: &MetadataState) -> Result<BinaryContentRef> {
        if &self.scope != metadata.scope() {
            return Err(zorid_file_sync::Error::IdentityMismatch.into());
        }
        let actual = metadata.binary_content_ref(&self.identity, &self.selected_event)?;
        if actual.manifest() != &self.manifest {
            return Err(StoreError::Corrupt(
                "published content locator differs from causal authority".into(),
            ));
        }
        Ok(actual)
    }
}
/// A sealed, owner-bound local capture has no causal event or graph identity.
/// It cannot become desired publication merely by being retained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapturedBinaryRef {
    pub stage: BinaryStageLocator,
    pub manifest: Manifest,
    pub source_commitment: Sha256Digest,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "source",
    content = "reference",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum BinarySourceRef {
    Graph(PublishedBinaryRef),
    Capture(CapturedBinaryRef),
}
impl BinarySourceRef {
    pub fn manifest(&self) -> &Manifest {
        match self {
            Self::Graph(value) => &value.manifest,
            Self::Capture(value) => &value.manifest,
        }
    }
    pub fn len(&self) -> u64 {
        self.manifest().bytes
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn digest(&self) -> &Sha256Digest {
        &self.manifest().digest
    }
}
/// Inline is bounded text or an explicitly unenrolled legacy byte value.
/// Enrolled binary files always use BinaryRef, including empty binary files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "content",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum StoredContent {
    InlineBytes(Vec<u8>),
    BinaryRef(BinarySourceRef),
}
impl StoredContent {
    pub fn len(&self) -> u64 {
        match self {
            Self::InlineBytes(bytes) => bytes.len() as u64,
            Self::BinaryRef(value) => value.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn digest(&self) -> Sha256Digest {
        match self {
            Self::InlineBytes(bytes) => Sha256Digest::of(bytes),
            Self::BinaryRef(value) => *value.digest(),
        }
    }
    pub fn inline_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::InlineBytes(bytes) => Some(bytes),
            Self::BinaryRef(_) => None,
        }
    }
    pub fn binary_ref(&self) -> Option<&BinarySourceRef> {
        match self {
            Self::BinaryRef(value) => Some(value),
            Self::InlineBytes(_) => None,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentMetadata {
    InlineBytes { bytes: u64, digest: Sha256Digest },
    BinaryRef { reference: BinarySourceRef },
}
impl ContentMetadata {
    pub fn len(&self) -> u64 {
        match self {
            Self::InlineBytes { bytes, .. } => *bytes,
            Self::BinaryRef { reference } => reference.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn digest(&self) -> &Sha256Digest {
        match self {
            Self::InlineBytes { digest, .. } => digest,
            Self::BinaryRef { reference } => reference.digest(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredEntryMetadata {
    pub state: EntryState,
    /// None is a folder. Every file, including an empty one, has Some content.
    pub content: Option<ContentMetadata>,
}
