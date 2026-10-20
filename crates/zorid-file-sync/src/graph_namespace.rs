//! One namespace projection candidate from checked indexed entry summaries.
//!
//! This follows the reference `locate` ordering without deriving a VaultView.
//! Source provenance, complete affected closures and publication remain host
//! obligations; neither these summaries nor the result authorize a commit.

use crate::{EntryIdentity, Error, Liveness, LocationHead, Projection, RecoveryReason};
use std::collections::BTreeSet;
use zorid_core::{EntryId, EntryKind, VaultPath};

/// Small candidate summary. The host proves current liveness/kind and that the
/// preferred location is the last maximal location head by event ID. Local
/// construction validates only the optional location's lexical shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamespaceNode {
    identity: EntryIdentity,
    kind: EntryKind,
    liveness: Liveness,
    preferred_location: Option<LocationHead>,
}

impl NamespaceNode {
    pub fn new(
        identity: EntryIdentity,
        kind: EntryKind,
        liveness: Liveness,
        preferred_location: Option<LocationHead>,
    ) -> Result<Self, Error> {
        if let Some(location) = &preferred_location {
            location.location.validate()?;
        }
        Ok(Self {
            identity,
            kind,
            liveness,
            preferred_location,
        })
    }
    pub fn identity(&self) -> &EntryIdentity {
        &self.identity
    }
    pub fn kind(&self) -> EntryKind {
        self.kind
    }
    pub fn liveness(&self) -> &Liveness {
        &self.liveness
    }
    pub fn preferred_location(&self) -> Option<&LocationHead> {
        self.preferred_location.as_ref()
    }
}

/// Conservative encoded-record admission units, not allocator measurements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamespaceWork {
    /// Check cancellation and charge a logical processing/selector step.
    Read,
    /// Reserve before retaining visited IDs, names, or copied path metadata.
    Retain { encoded_bytes: usize },
    /// Reserve before constructing the final Projection or joined path.
    Emit { encoded_bytes: usize },
}

/// Transaction-current source-backed access for a projection candidate.
///
/// Every positive node/winner must be checked against its actual source facts.
/// `sibling_winner` returns the smallest EntryId among ALL Live nodes whose
/// preferred location has this exact (parent,name). Include pending entries,
/// entries in recovery, and entries with alternative location heads. Do not
/// filter by visibility, successful parent projection, or preferred entry kind.
/// Deleted/DeleteConflict nodes do not participate. Completeness and negative
/// selector integrity belong to the durable host invariant, not this trait.
///
/// The reader admits source sizes/decoding allocations before returning owned
/// nodes. `admit` checks cancellation every time and enforces finite work and
/// cumulative retained/output encoded-byte limits. Exhaustion is an error, never
/// a truncated chain or successful recovery projection. Arbitrary implementations
/// of this trait do not gain Store publication authority.
pub trait NamespaceProjectionReader {
    type Error: From<Error>;
    fn admit(&mut self, work: NamespaceWork) -> Result<(), Self::Error>;
    fn node(&mut self, id: &EntryId) -> Result<Option<NamespaceNode>, Self::Error>;
    fn sibling_winner(
        &mut self,
        parent: Option<&EntryId>,
        name: &str,
    ) -> Result<Option<NamespaceNode>, Self::Error>;
}

fn bound(id_bytes: usize, path_bytes: usize) -> Result<usize, Error> {
    id_bytes
        .checked_add(path_bytes)
        .and_then(|bytes| bytes.checked_mul(6))
        .and_then(|bytes| bytes.checked_add(2048))
        .ok_or(Error::TooLarge)
}

fn recovery<R: NamespaceProjectionReader>(
    reader: &mut R,
    target: &EntryId,
    reason: RecoveryReason,
) -> Result<Projection, R::Error> {
    reader.admit(NamespaceWork::Emit {
        encoded_bytes: bound(target.as_str().len(), 0)?,
    })?;
    Ok(Projection::Recovery {
        entry: target.clone(),
        reason,
    })
}

/// Calculate one projection along its parent chain. It does not enumerate the
/// vault or recursively project sibling winners. Errors (including budget and
/// cancellation) return no candidate. The host separately checks the complete
/// affected namespace closure and seals any eventual publication.
pub fn project_namespace_candidate<R: NamespaceProjectionReader>(
    target: &EntryId,
    reader: &mut R,
) -> Result<Projection, R::Error> {
    reader.admit(NamespaceWork::Retain {
        encoded_bytes: bound(target.as_str().len(), 0)?,
    })?;
    let mut current = target.clone();
    let mut seen = BTreeSet::new();
    let mut names = Vec::new();
    let mut path_bytes = 0usize;
    loop {
        reader.admit(NamespaceWork::Read)?;
        // Cycle takes precedence over every other condition at a repeated ID.
        if seen.contains(&current) {
            return recovery(reader, target, RecoveryReason::Cycle);
        }
        reader.admit(NamespaceWork::Retain {
            encoded_bytes: bound(current.as_str().len(), 0)?,
        })?;
        seen.insert(current.clone());
        reader.admit(NamespaceWork::Read)?;
        let Some(node) = reader.node(&current)? else {
            return recovery(reader, target, RecoveryReason::ParentUnavailable);
        };
        if node.identity.entry_id != current {
            return Err(Error::InvalidState.into());
        }

        // The reference collision set contains Live entries only. Collision
        // precedes ancestor-kind/path checks, including a colliding file parent.
        if node.liveness == Liveness::Live {
            if let Some(location) = &node.preferred_location {
                reader.admit(NamespaceWork::Read)?;
                let winner = reader
                    .sibling_winner(location.location.parent.as_ref(), &location.location.name)?
                    .ok_or(Error::InvalidState)?;
                let same_key = winner.preferred_location.as_ref().is_some_and(|preferred| {
                    preferred.location.parent == location.location.parent
                        && preferred.location.name == location.location.name
                });
                if winner.liveness != Liveness::Live
                    || !same_key
                    || winner.identity.entry_id > current
                    || (winner.identity.entry_id == current && winner != node)
                {
                    return Err(Error::InvalidState.into());
                }
                if winner.identity.entry_id < current {
                    return recovery(reader, target, RecoveryReason::NameCollision);
                }
            }
        }

        match node.liveness {
            Liveness::Deleted if current == *target => {
                reader.admit(NamespaceWork::Emit {
                    encoded_bytes: bound(target.as_str().len(), 0)?,
                })?;
                return Ok(Projection::Tombstone);
            }
            Liveness::Deleted => {
                return recovery(reader, target, RecoveryReason::ParentUnavailable)
            }
            Liveness::DeleteConflict => {
                return recovery(reader, target, RecoveryReason::DeleteConflict)
            }
            Liveness::Live => {}
        }
        if current != *target && node.kind != EntryKind::Folder {
            return recovery(reader, target, RecoveryReason::ParentUnavailable);
        }
        let Some(location) = node.preferred_location else {
            return recovery(reader, target, RecoveryReason::ParentUnavailable);
        };
        path_bytes = path_bytes
            .checked_add(location.location.name.len())
            .and_then(|bytes| bytes.checked_add(usize::from(!names.is_empty())))
            .ok_or(Error::TooLarge)?;
        reader.admit(NamespaceWork::Retain {
            encoded_bytes: bound(
                location
                    .location
                    .parent
                    .as_ref()
                    .map(|id| id.as_str().len())
                    .unwrap_or(0),
                location.location.name.len(),
            )?,
        })?;
        names.push(location.location.name);
        match location.location.parent {
            Some(parent) => current = parent,
            None => break,
        }
    }
    reader.admit(NamespaceWork::Emit {
        encoded_bytes: bound(target.as_str().len(), path_bytes)?,
    })?;
    names.reverse();
    match VaultPath::new(names.join("/")) {
        Ok(path) => Ok(Projection::Normal { path }),
        Err(_) => recovery(reader, target, RecoveryReason::ParentUnavailable),
    }
}

#[cfg(test)]
#[path = "graph_namespace_tests.rs"]
mod tests;
