//! Portable contracts shared by independent Zorid client processes.
//!
//! This crate performs lexical and mutation-precondition validation. It does not
//! access a filesystem, database, clock, random generator, network, or runtime.
//! A successful validation is not a durable commit. See the crate README for
//! transaction, idempotency, projection, and recovery obligations on adapters.

mod identity;
mod mutation;
mod path;
mod plan;

pub use identity::{EntryId, OperationId, Revision};
pub use mutation::{
    check_idempotency, validate_target, CommitResult, EntryChange, EntryKind, EntryState,
    IdempotencyCheck, Mutation, MutationRequest, RecordedOperation,
};
pub use path::VaultPath;
pub use plan::{
    plan_file_content_mutation, plan_file_materialization, plan_mutation, validate_snapshot,
    FileContentTarget,
};

use serde::{Deserialize, Serialize};
use std::fmt;

/// Domain failures only. Adapters must distinguish these from I/O, lock timeout,
/// quota, authorization, and uncertain-commit failures rather than swallowing them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContractError {
    InvalidPath {
        reason: String,
    },
    InvalidIdentifier {
        kind: String,
    },
    InvalidMutation {
        reason: String,
    },
    EntryNotFound {
        id: EntryId,
    },
    EntryDeleted {
        id: EntryId,
    },
    RevisionConflict {
        id: EntryId,
        expected: Revision,
        actual: Revision,
    },
    IdempotencyConflict {
        operation_id: OperationId,
    },
    InvalidOperationRecord,
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath { reason } => write!(f, "Invalid vault path: {reason}"),
            Self::InvalidIdentifier { kind } => write!(f, "Invalid {kind}"),
            Self::InvalidMutation { reason } => write!(f, "Invalid mutation: {reason}"),
            Self::EntryNotFound { id } => write!(f, "Entry does not exist: {id}"),
            Self::EntryDeleted { id } => write!(f, "Entry is deleted: {id}"),
            Self::RevisionConflict { id, .. } => write!(f, "Entry changed: {id}"),
            Self::IdempotencyConflict { operation_id } => {
                write!(
                    f,
                    "Operation ID was used for a different request: {operation_id}"
                )
            }
            Self::InvalidOperationRecord => write!(f, "Stored operation record is inconsistent"),
        }
    }
}

impl std::error::Error for ContractError {}
