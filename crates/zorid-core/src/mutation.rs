use crate::{ContractError, EntryId, OperationId, Revision, VaultPath};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Folder,
}

/// Durable logical metadata, including retained tombstones. Content bytes live
/// in adapter storage. A file does not need a recognized extension or UTF-8 body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryState {
    pub id: EntryId,
    pub path: VaultPath,
    pub kind: EntryKind,
    pub revision: Revision,
    pub deleted: bool,
}

/// First-slice local commands, not a CRDT update or network sync envelope.
/// Every existing-entry mutation is conditional; there is no implicit force write.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    Create {
        id: EntryId,
        path: VaultPath,
        kind: EntryKind,
        /// Files require Some(bytes), including Some(vec![]) for an empty file.
        /// Folders require None. No Markdown, text, or extension assumptions.
        content: Option<Vec<u8>>,
    },
    Write {
        id: EntryId,
        expected: Revision,
        content: Vec<u8>,
    },
    Move {
        id: EntryId,
        expected: Revision,
        path: VaultPath,
    },
    /// Logical, recoverable deletion. Adapters retain content and identity.
    /// This never means filesystem purge or system-trash completion.
    Delete {
        id: EntryId,
        expected: Revision,
        recursive: bool,
    },
}

impl Mutation {
    pub fn id(&self) -> &EntryId {
        match self {
            Self::Create { id, .. }
            | Self::Write { id, .. }
            | Self::Move { id, .. }
            | Self::Delete { id, .. } => id,
        }
    }

    pub fn expected(&self) -> Option<&Revision> {
        match self {
            Self::Create { .. } => None,
            Self::Write { expected, .. }
            | Self::Move { expected, .. }
            | Self::Delete { expected, .. } => Some(expected),
        }
    }

    pub fn validate(&self) -> Result<(), ContractError> {
        if let Self::Create { kind, content, .. } = self {
            match (kind, content) {
                (EntryKind::File, None) => {
                    return Err(ContractError::InvalidMutation {
                        reason: "creating a file requires content bytes".into(),
                    })
                }
                (EntryKind::Folder, Some(_)) => {
                    return Err(ContractError::InvalidMutation {
                        reason: "a folder cannot have content bytes".into(),
                    })
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawRequest")]
pub struct MutationRequest {
    pub operation_id: OperationId,
    pub mutation: Mutation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRequest {
    operation_id: OperationId,
    mutation: Mutation,
}

impl TryFrom<RawRequest> for MutationRequest {
    type Error = ContractError;
    fn try_from(value: RawRequest) -> Result<Self, Self::Error> {
        let request = Self {
            operation_id: value.operation_id,
            mutation: value.mutation,
        };
        request.validate()?;
        Ok(request)
    }
}

impl MutationRequest {
    /// Also required for callers constructing requests directly in Rust.
    pub fn validate(&self) -> Result<(), ContractError> {
        self.mutation.validate()
    }
}

/// Invoke against fresh transaction state, never a renderer/process cache.
/// This checks identity, liveness and optimistic revision only; the adapter must
/// additionally enforce kind, path occupancy, parent and subtree constraints.
pub fn validate_target<'a>(
    state: Option<&'a EntryState>,
    id: &EntryId,
    expected: &Revision,
) -> Result<&'a EntryState, ContractError> {
    let state = state
        .filter(|state| state.id == *id)
        .ok_or_else(|| ContractError::EntryNotFound { id: id.clone() })?;
    if state.deleted {
        return Err(ContractError::EntryDeleted { id: id.clone() });
    }
    if state.revision != *expected {
        return Err(ContractError::RevisionConflict {
            id: id.clone(),
            expected: expected.clone(),
            actual: state.revision.clone(),
        });
    }
    Ok(state)
}

/// One changed entry in a committed batch, including changed ancestor revisions
/// and every affected descendant during a folder move or recursive deletion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryChange {
    pub before: Option<EntryState>,
    pub after: EntryState,
}

/// Returned only after the local database transaction durably commits the entry
/// changes, bytes/references, journal, projection intents and idempotency record.
/// The sequence also identifies the journal event for this entire atomic batch.
/// It says nothing about filesystem projection, remote receipt, or backup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitResult {
    pub operation_id: OperationId,
    /// Local to one replica. Serialized as a positive decimal string so JS never
    /// rounds a u64. It is not a cross-device clock or a document revision.
    #[serde(with = "sequence_wire")]
    pub sequence: u64,
    pub changes: Vec<EntryChange>,
}

impl CommitResult {
    /// Structural checks only; transaction completeness is an adapter obligation.
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.sequence == 0 || self.changes.is_empty() {
            return Err(ContractError::InvalidOperationRecord);
        }
        let mut seen = BTreeSet::new();
        for change in &self.changes {
            if !seen.insert(&change.after.id) {
                return Err(ContractError::InvalidOperationRecord);
            }
            match &change.before {
                Some(before)
                    if before.id != change.after.id
                        || before.kind != change.after.kind
                        || before.revision == change.after.revision =>
                {
                    return Err(ContractError::InvalidOperationRecord);
                }
                None if change.after.deleted => return Err(ContractError::InvalidOperationRecord),
                _ => {}
            }
        }
        Ok(())
    }
}

/// Persist this atomically with the mutation. Lookup is scoped to the local
/// vault and authorized caller boundary; records cannot bypass authorization.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedOperation {
    pub request: MutationRequest,
    pub result: CommitResult,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdempotencyCheck<'a> {
    New,
    Replay(&'a CommitResult),
}

/// Check inside the write transaction *before* target preconditions. An exact
/// retry returns its original result even when the target has since changed.
/// Different bytes/paths/preconditions under the same ID must never be applied.
pub fn check_idempotency<'a>(
    request: &MutationRequest,
    record: Option<&'a RecordedOperation>,
) -> Result<IdempotencyCheck<'a>, ContractError> {
    request.validate()?;
    let Some(record) = record else {
        return Ok(IdempotencyCheck::New);
    };
    record.result.validate()?;
    if record.request.operation_id != request.operation_id
        || record.result.operation_id != request.operation_id
        || !record
            .result
            .changes
            .iter()
            .any(|change| change.after.id == *record.request.mutation.id())
    {
        return Err(ContractError::InvalidOperationRecord);
    }
    if record.request != *request {
        return Err(ContractError::IdempotencyConflict {
            operation_id: request.operation_id.clone(),
        });
    }
    Ok(IdempotencyCheck::Replay(&record.result))
}

mod sequence_wire {
    use serde::{de::Error, ser::Error as _, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        if *value == 0 {
            return Err(S::Error::custom("commit sequence must be positive"));
        }
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.starts_with('0')
            || value.is_empty()
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(D::Error::custom(
                "commit sequence must be a canonical positive decimal string",
            ));
        }
        value.parse().map_err(D::Error::custom)
    }
}
