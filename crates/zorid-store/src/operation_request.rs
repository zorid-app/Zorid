//! Local journal request identity. References contain no binary bytes and grant
//! no authority: their stage and immutable sources must still be resolved.
use super::*;
use crate::content::BinaryStageLocator;
use zorid_core::{OperationId, VaultPath};
use zorid_file_sync::{Manifest, Sha256Digest};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OperationRequest {
    Inline(MutationRequest),
    BinaryRef(BinaryOperationRequest),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BinaryOperationRequest {
    pub stage: BinaryStageLocator,
    pub request: BinaryStageRequest,
    #[serde(with = "manifest_decimal")]
    pub manifest: Manifest,
    pub source_commitment: Sha256Digest,
    pub original_inline: Option<InlineCallCommitment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InlineCallTarget {
    Create {
        id: EntryId,
        path: VaultPath,
    },
    Write {
        id: EntryId,
        expected_revision: Revision,
    },
}

/// Original small-inline call identity, retained without its content bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineCallCommitment {
    pub target: InlineCallTarget,
    pub create_mode: Option<FamilyCreateMode>,
    #[serde(with = "decimal")]
    pub bytes: u64,
    pub digest: Sha256Digest,
}
impl InlineCallCommitment {
    pub fn from_request(request: &MutationRequest, mode: Option<FamilyCreateMode>) -> Result<Self> {
        request.validate()?;
        let (target, content) = match &request.mutation {
            Mutation::Create {
                id,
                path,
                kind: EntryKind::File,
                content: Some(content),
            } if mode == Some(FamilyCreateMode::Binary) => (
                InlineCallTarget::Create {
                    id: id.clone(),
                    path: path.clone(),
                },
                content,
            ),
            Mutation::Write {
                id,
                expected,
                content,
            } if mode.is_none() => (
                InlineCallTarget::Write {
                    id: id.clone(),
                    expected_revision: expected.clone(),
                },
                content,
            ),
            _ => {
                return Err(ContractError::InvalidMutation {
                    reason: "inline binary commitment requires binary create or write".into(),
                }
                .into())
            }
        };
        Ok(Self {
            target,
            create_mode: mode,
            bytes: content.len() as u64,
            digest: Sha256Digest::of(content),
        })
    }
}
impl OperationRequest {
    pub fn operation_id(&self) -> &OperationId {
        match self {
            Self::Inline(request) => &request.operation_id,
            Self::BinaryRef(request) => &request.stage.operation_id,
        }
    }
    pub fn inline(&self) -> Option<&MutationRequest> {
        match self {
            Self::Inline(request) => Some(request),
            Self::BinaryRef(_) => None,
        }
    }
    fn entry_id(&self) -> &EntryId {
        match self {
            Self::Inline(request) => request.mutation.id(),
            Self::BinaryRef(request) => match &request.request.target {
                BinaryTarget::Create { id, .. } | BinaryTarget::Write { id, .. } => id,
            },
        }
    }
    fn validate(&self) -> Result<()> {
        match self {
            Self::Inline(request) => request.validate().map_err(|_| corrupt()),
            Self::BinaryRef(request) => request.validate(),
        }
    }
}
impl BinaryOperationRequest {
    fn validate(&self) -> Result<()> {
        let manifest = &self.manifest;
        if manifest.bytes > BINARY_STAGE_MAX_FILE_BYTES
            || manifest.pages.len() > 4
            || self
                .request
                .expected_length
                .is_some_and(|n| n != manifest.bytes)
            || matches!(&self.request.target, BinaryTarget::Create { path, .. } if path.as_str().len() > BINARY_STAGE_MAX_PATH_BYTES)
        {
            return Err(corrupt());
        }
        let mut total = 0u64;
        let mut ids = std::collections::BTreeSet::new();
        for page in &manifest.pages {
            if page.bytes == 0
                || page.bytes > 128 * BINARY_STAGE_MAX_CHUNK_BYTES as u64
                || !ids.insert(&page.id)
            {
                return Err(corrupt());
            }
            total = total.checked_add(page.bytes).ok_or_else(corrupt)?;
        }
        if total != manifest.bytes
            || (manifest.bytes == 0 && manifest.digest != Sha256Digest::of(&[]))
        {
            return Err(corrupt());
        }
        if let Some(original) = &self.original_inline {
            let matches = match (&original.target, &self.request.target) {
                (
                    InlineCallTarget::Create { id, path },
                    BinaryTarget::Create {
                        id: actual_id,
                        path: actual_path,
                    },
                ) => {
                    id == actual_id
                        && path == actual_path
                        && original.create_mode == Some(FamilyCreateMode::Binary)
                }
                (
                    InlineCallTarget::Write {
                        id,
                        expected_revision,
                    },
                    BinaryTarget::Write {
                        id: actual_id,
                        expected_revision: actual_revision,
                        ..
                    },
                ) => {
                    id == actual_id
                        && expected_revision == actual_revision
                        && original.create_mode.is_none()
                }
                _ => false,
            };
            if !matches || original.bytes != manifest.bytes || original.digest != manifest.digest {
                return Err(corrupt());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredOperation {
    pub request: OperationRequest,
    pub result: CommitResult,
}
impl StoredOperation {
    pub fn validate(&self, expected: &OperationId) -> Result<()> {
        self.request.validate()?;
        self.result.validate().map_err(|_| corrupt())?;
        if self.request.operation_id() != expected
            || &self.result.operation_id != expected
            || !self
                .result
                .changes
                .iter()
                .any(|change| &change.after.id == self.request.entry_id())
        {
            return Err(corrupt());
        }
        Ok(())
    }
    pub(super) fn as_inline_record(&self, expected: &OperationId) -> Result<RecordedOperation> {
        self.validate(expected)?;
        let request = self.request.inline().ok_or_else(|| conflict(expected))?;
        Ok(RecordedOperation {
            request: request.clone(),
            result: self.result.clone(),
        })
    }
}
fn corrupt() -> StoreError {
    StoreError::Corrupt("invalid stored operation identity".into())
}
fn conflict(operation_id: &OperationId) -> StoreError {
    ContractError::IdempotencyConflict {
        operation_id: operation_id.clone(),
    }
    .into()
}
pub(super) fn encode_inline(request: &MutationRequest) -> Result<String> {
    request.validate()?;
    Ok(serde_json::to_string(&OperationRequest::Inline(
        request.clone(),
    ))?)
}
pub(super) fn decode_inline(raw: &str, expected: &OperationId) -> Result<MutationRequest> {
    let request: OperationRequest = serde_json::from_str(raw).map_err(|_| corrupt())?;
    request.validate()?;
    if request.operation_id() != expected {
        return Err(corrupt());
    }
    request.inline().cloned().ok_or_else(|| conflict(expected))
}
pub(super) fn decode_record(
    raw: &str,
    result: &str,
    expected: &OperationId,
) -> Result<StoredOperation> {
    let record = StoredOperation {
        request: serde_json::from_str(raw).map_err(|_| corrupt())?,
        result: serde_json::from_str(result).map_err(|_| corrupt())?,
    };
    record.validate(expected)?;
    Ok(record)
}
pub(super) fn decode_inline_record(
    raw: &str,
    result: &str,
    expected: &OperationId,
) -> Result<RecordedOperation> {
    decode_record(raw, result, expected)?.as_inline_record(expected)
}
/// Replay is resolved before current target metadata or stage source access.
/// Matching the original small-inline commitment does not authorize a new write.
pub(super) fn replay_inline_with_mode(
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
    raw: &str,
    result: &str,
) -> Result<CommitResult> {
    request.validate()?;
    let record = decode_record(raw, result, &request.operation_id)?;
    match &record.request {
        OperationRequest::Inline(_) => {
            let inline = record.as_inline_record(&request.operation_id)?;
            check_idempotency(request, Some(&inline))?;
        }
        OperationRequest::BinaryRef(binary) => {
            let original = InlineCallCommitment::from_request(request, mode)
                .map_err(|_| conflict(&request.operation_id))?;
            if binary.original_inline.as_ref() != Some(&original) {
                return Err(conflict(&request.operation_id));
            }
        }
    }
    Ok(record.result)
}

mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let value = raw.parse::<u64>().map_err(serde::de::Error::custom)?;
        if raw != value.to_string() {
            return Err(serde::de::Error::custom("noncanonical decimal count"));
        }
        Ok(value)
    }
}
mod manifest_decimal {
    use super::*;
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Page {
        id: zorid_sync_protocol::UpdateId,
        #[serde(with = "decimal")]
        bytes: u64,
        digest: Sha256Digest,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Value {
        #[serde(with = "decimal")]
        bytes: u64,
        digest: Sha256Digest,
        pages: Vec<Page>,
    }
    pub fn serialize<S: serde::Serializer>(
        manifest: &Manifest,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        Value {
            bytes: manifest.bytes,
            digest: manifest.digest,
            pages: manifest
                .pages
                .iter()
                .map(|p| Page {
                    id: p.id.clone(),
                    bytes: p.bytes,
                    digest: p.digest,
                })
                .collect(),
        }
        .serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Manifest, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(Manifest {
            bytes: value.bytes,
            digest: value.digest,
            pages: value
                .pages
                .into_iter()
                .map(|p| zorid_file_sync::PageRef {
                    id: p.id,
                    bytes: p.bytes,
                    digest: p.digest,
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn op(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn id(value: &str) -> EntryId {
        EntryId::new(value).unwrap()
    }
    fn request() -> MutationRequest {
        MutationRequest {
            operation_id: op("create"),
            mutation: Mutation::Create {
                id: id("file"),
                path: VaultPath::new("file.bin").unwrap(),
                kind: EntryKind::File,
                content: Some(vec![]),
            },
        }
    }
    fn result(request: &MutationRequest) -> CommitResult {
        CommitResult {
            operation_id: request.operation_id.clone(),
            sequence: 1,
            changes: vec![zorid_core::EntryChange {
                before: None,
                after: EntryState {
                    id: request.mutation.id().clone(),
                    path: VaultPath::new("file.bin").unwrap(),
                    kind: EntryKind::File,
                    revision: Revision::new("created").unwrap(),
                    deleted: false,
                },
            }],
        }
    }
    fn binary(request: &MutationRequest) -> OperationRequest {
        OperationRequest::BinaryRef(BinaryOperationRequest {
            stage: BinaryStageLocator {
                local_store_id: op("store"),
                client_id: op("client"),
                operation_id: request.operation_id.clone(),
                stage_id: op("stage"),
            },
            request: BinaryStageRequest {
                target: BinaryTarget::Create {
                    id: id("file"),
                    path: VaultPath::new("file.bin").unwrap(),
                },
                expected_length: Some(0),
            },
            manifest: Manifest {
                bytes: 0,
                digest: Sha256Digest::of(&[]),
                pages: vec![],
            },
            source_commitment: Sha256Digest::of(b"sources"),
            original_inline: Some(
                InlineCallCommitment::from_request(request, Some(FamilyCreateMode::Binary))
                    .unwrap(),
            ),
        })
    }
    #[test]
    fn tagged_inline_roundtrip_and_legacy_request_rejection() {
        let request = request();
        let raw = encode_inline(&request).unwrap();
        assert_eq!(decode_inline(&raw, &request.operation_id).unwrap(), request);
        assert!(matches!(
            decode_inline(
                &serde_json::to_string(&request).unwrap(),
                &request.operation_id
            ),
            Err(StoreError::Corrupt(_))
        ));
        let receipt = result(&request);
        assert_eq!(
            decode_record(
                &raw,
                &serde_json::to_string(&receipt).unwrap(),
                &request.operation_id
            )
            .unwrap()
            .result,
            receipt
        );
        assert!(matches!(
            decode_record(
                &raw,
                &serde_json::to_string(&receipt).unwrap(),
                &op("different")
            ),
            Err(StoreError::Corrupt(_))
        ));
    }
    #[test]
    fn binary_receipt_replays_only_exact_original_inline_call() {
        let request = request();
        let raw = serde_json::to_string(&binary(&request)).unwrap();
        let receipt = result(&request);
        let json = serde_json::to_string(&receipt).unwrap();
        assert_eq!(
            replay_inline_with_mode(&request, Some(FamilyCreateMode::Binary), &raw, &json).unwrap(),
            receipt
        );
        assert!(matches!(
            decode_inline(&raw, &request.operation_id),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
        assert!(matches!(
            replay_inline_with_mode(&request, Some(FamilyCreateMode::Text), &raw, &json),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
        let mut changed = request.clone();
        if let Mutation::Create { content, .. } = &mut changed.mutation {
            *content = Some(vec![1]);
        }
        assert!(matches!(
            replay_inline_with_mode(&changed, Some(FamilyCreateMode::Binary), &raw, &json),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
        let mut no_original = binary(&request);
        if let OperationRequest::BinaryRef(value) = &mut no_original {
            value.original_inline = None;
        }
        assert!(matches!(
            replay_inline_with_mode(
                &request,
                Some(FamilyCreateMode::Binary),
                &serde_json::to_string(&no_original).unwrap(),
                &json
            ),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
    }
    #[test]
    fn binary_counts_are_canonical_and_receipt_cannot_change_identity() {
        let request = request();
        let mut raw = serde_json::to_value(binary(&request)).unwrap();
        assert_eq!(raw["request"]["manifest"]["bytes"], "0");
        assert_eq!(raw["request"]["original_inline"]["bytes"], "0");
        raw["request"]["manifest"]["bytes"] = serde_json::json!(0);
        assert!(serde_json::from_value::<OperationRequest>(raw).is_err());
        let mut receipt = result(&request);
        receipt.changes[0].after.id = id("unrelated");
        assert!(matches!(
            decode_record(
                &serde_json::to_string(&binary(&request)).unwrap(),
                &serde_json::to_string(&receipt).unwrap(),
                &request.operation_id
            ),
            Err(StoreError::Corrupt(_))
        ));
        let mut malformed = binary(&request);
        if let OperationRequest::BinaryRef(value) = &mut malformed {
            value.manifest.bytes = 1;
        }
        assert!(malformed.validate().is_err());
    }
}
