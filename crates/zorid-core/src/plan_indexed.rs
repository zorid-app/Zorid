//! Targeted candidate planning over a transaction-current indexed reader.
//!
//! This does not validate a complete vault or confer publication authority.
//! Completeness of negative/path/subtree selectors, checked source provenance,
//! revision allocation and the transaction fence belong to the host. A reader
//! backed by an arbitrary subset is not an implementation of this contract.

use crate::{
    validate_target, ContractError, EntryChange, EntryId, EntryKind, EntryState, FileContentTarget,
    Mutation, MutationRequest, Revision, VaultPath,
};
use std::collections::{BTreeMap, BTreeSet};

/// Admission units for one candidate calculation. These are conservative
/// encoded-record charges, not a measurement of Rust allocator overhead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexedMutationWork {
    /// Check cancellation and charge one logical selector/processing step.
    Read,
    /// Reserve bytes before retaining or copying candidate metadata.
    Retain { encoded_bytes: usize },
    /// Reserve bytes before constructing an output change.
    Emit { encoded_bytes: usize },
}

/// Checked indexed access used only to calculate mutation candidates.
///
/// All methods observe the same transaction-current revision. `entry` includes
/// tombstones; `live_path` uses exact spelling and excludes tombstones.
/// `next_live_descendant` returns the least live descendant path strictly after
/// `after`, in Rust string/BINARY collation order; None proves exhaustion of the
/// complete selector, not exhaustion of a caller-supplied prefix. These methods
/// must check source-record sizes and admit their own decoding allocations
/// before returning owned records. The planner checks returned row shape and
/// consistency, but cannot establish selector completeness or authenticity.
///
/// `admit` must check cancellation on every call, enforce a finite work limit,
/// and accumulate retained/output encoded-byte charges. Rejection must return
/// an error; it cannot silently truncate a selector. No result is returned on
/// cancellation or budget exhaustion. Hosts needing larger operations must use
/// a separately checked durable frontier, rather than pass partial data here.
pub trait IndexedMutationReader {
    type Error: From<ContractError>;

    fn admit(&mut self, work: IndexedMutationWork) -> Result<(), Self::Error>;
    /// Verify the actual allocation/reservation fence, including history. This
    /// must not scan every EntryState or accept an unverified caller assertion.
    fn require_fresh_revision(&mut self, revision: &Revision) -> Result<(), Self::Error>;
    fn entry(&mut self, id: &EntryId) -> Result<Option<EntryState>, Self::Error>;
    fn live_path(&mut self, path: &VaultPath) -> Result<Option<EntryState>, Self::Error>;
    fn next_live_descendant(
        &mut self,
        root: &VaultPath,
        after: Option<&VaultPath>,
    ) -> Result<Option<EntryState>, Self::Error>;
}

fn invalid(reason: &str) -> ContractError {
    ContractError::InvalidMutation {
        reason: reason.into(),
    }
}

// Six bytes per input byte bounds JSON escaping; the fixed allowance covers
// structure, enum/boolean spelling and the bounded opaque identifiers. The
// estimate also conservatively charges selector/map keys copied with a row.
fn encoded_bound(
    path_bytes: usize,
    id_bytes: usize,
    revision_bytes: usize,
) -> Result<usize, ContractError> {
    path_bytes
        .checked_add(id_bytes)
        .and_then(|n| n.checked_add(revision_bytes))
        .and_then(|n| n.checked_mul(6))
        .and_then(|n| n.checked_add(1024))
        .ok_or_else(|| invalid("indexed mutation size accounting overflow"))
}

fn entry_bound(entry: &EntryState) -> Result<usize, ContractError> {
    encoded_bound(
        entry.path.as_str().len(),
        entry.id.as_str().len(),
        entry.revision.as_str().len(),
    )
}

/// Calculate existing local mutation semantics using only accessed entries and
/// the complete affected subtree. Output remains ordered by stable entry ID.
/// This candidate Vec is bounded by reader admission; it is not a resumable
/// publication API, operation receipt, authorization or durable commit.
pub fn plan_indexed_mutation<R: IndexedMutationReader>(
    request: &MutationRequest,
    reader: &mut R,
    next_revision: &Revision,
) -> Result<Vec<EntryChange>, R::Error> {
    request.validate()?;
    let mut plan = Plan::new(reader, next_revision)?;
    match &request.mutation {
        Mutation::Create { id, path, kind, .. } => plan.create(id, path, *kind)?,
        Mutation::Write { id, expected, .. } => plan.materialize(id, expected)?,
        Mutation::Move { id, expected, path } => plan.move_entry(id, expected, path)?,
        Mutation::Delete {
            id,
            expected,
            recursive,
        } => plan.delete(id, expected, *recursive)?,
    }
    plan.finish()
}

/// Candidate-only counterpart of `plan_file_content_mutation`, retaining its
/// original target and existing EntryChange output contract.
pub fn plan_indexed_file_content_mutation<R: IndexedMutationReader>(
    target: &FileContentTarget,
    reader: &mut R,
    next_revision: &Revision,
) -> Result<Vec<EntryChange>, R::Error> {
    let mut plan = Plan::new(reader, next_revision)?;
    match target {
        FileContentTarget::Create { id, path } => plan.create(id, path, EntryKind::File)?,
        FileContentTarget::Write { id, expected } => plan.materialize(id, expected)?,
    }
    plan.finish()
}

/// Candidate-only counterpart of `plan_file_materialization`. The host still
/// checks receive provenance, bytes, cursor, replay and atomic publication.
pub fn plan_indexed_file_materialization<R: IndexedMutationReader>(
    id: &EntryId,
    expected_revision: &Revision,
    next_revision: &Revision,
    reader: &mut R,
) -> Result<Vec<EntryChange>, R::Error> {
    let mut plan = Plan::new(reader, next_revision)?;
    plan.materialize(id, expected_revision)?;
    plan.finish()
}

struct Plan<'a, R: IndexedMutationReader> {
    reader: &'a mut R,
    revision: &'a Revision,
    originals: BTreeMap<EntryId, Option<EntryState>>,
    paths: BTreeMap<VaultPath, Option<EntryId>>,
    observed_live: BTreeMap<VaultPath, EntryId>,
    changed: BTreeMap<EntryId, EntryState>,
}

impl<'a, R: IndexedMutationReader> Plan<'a, R> {
    fn new(reader: &'a mut R, revision: &'a Revision) -> Result<Self, R::Error> {
        reader.admit(IndexedMutationWork::Read)?;
        reader.require_fresh_revision(revision)?;
        Ok(Self {
            reader,
            revision,
            originals: BTreeMap::new(),
            paths: BTreeMap::new(),
            observed_live: BTreeMap::new(),
            changed: BTreeMap::new(),
        })
    }

    fn retain(&mut self, bytes: usize) -> Result<(), R::Error> {
        self.reader.admit(IndexedMutationWork::Retain {
            encoded_bytes: bytes,
        })
    }

    fn copy(&mut self, entry: &EntryState) -> Result<EntryState, R::Error> {
        self.retain(entry_bound(entry)?)?;
        Ok(entry.clone())
    }

    fn remember(&mut self, entry: &EntryState) -> Result<(), R::Error> {
        if !entry.deleted {
            if self
                .paths
                .get(&entry.path)
                .is_some_and(|id| id.as_ref() != Some(&entry.id))
                || self
                    .observed_live
                    .get(&entry.path)
                    .is_some_and(|id| id != &entry.id)
            {
                return Err(invalid("indexed reader returned inconsistent live path rows").into());
            }
            if !self.observed_live.contains_key(&entry.path) {
                self.retain(entry_bound(entry)?)?;
                self.observed_live
                    .insert(entry.path.clone(), entry.id.clone());
            }
        }
        if let Some(old) = self.originals.get(&entry.id) {
            if old.as_ref() != Some(entry) {
                return Err(invalid("indexed reader returned inconsistent entry rows").into());
            }
        } else {
            let copied = self.copy(entry)?;
            self.originals.insert(entry.id.clone(), Some(copied));
        }
        Ok(())
    }

    fn entry(&mut self, id: &EntryId) -> Result<Option<EntryState>, R::Error> {
        self.reader.admit(IndexedMutationWork::Read)?;
        if let Some(old) = self.originals.get(id) {
            // Charge before cloning a retained row, without cloning to satisfy
            // the borrow checker before admission.
            let bytes = old.as_ref().map(entry_bound).transpose()?;
            if let Some(bytes) = bytes {
                self.retain(bytes)?;
            }
            return Ok(self.originals.get(id).expect("retained key").clone());
        }
        let entry = self.reader.entry(id)?;
        if entry.as_ref().is_some_and(|entry| entry.id != *id) {
            return Err(invalid("indexed reader returned a different entry ID").into());
        }
        match &entry {
            Some(entry) => self.remember(entry)?,
            None => {
                self.retain(encoded_bound(0, id.as_str().len(), 0)?)?;
                self.originals.insert(id.clone(), None);
            }
        }
        Ok(entry)
    }

    fn live_path(&mut self, path: &VaultPath) -> Result<Option<EntryState>, R::Error> {
        self.reader.admit(IndexedMutationWork::Read)?;
        if let Some(id) = self.paths.get(path) {
            let bytes = id
                .as_ref()
                .and_then(|id| self.originals.get(id))
                .and_then(Option::as_ref)
                .map(entry_bound)
                .transpose()?;
            if let Some(bytes) = bytes {
                self.retain(bytes)?;
            }
            return Ok(self
                .paths
                .get(path)
                .and_then(Option::as_ref)
                .and_then(|id| self.originals.get(id))
                .and_then(Option::as_ref)
                .cloned());
        }
        let entry = self.reader.live_path(path)?;
        if entry.is_none() && self.observed_live.contains_key(path) {
            return Err(invalid("indexed reader omitted an already observed live path").into());
        }
        if entry
            .as_ref()
            .is_some_and(|entry| entry.deleted || entry.path != *path)
        {
            return Err(invalid("indexed reader returned a different live path").into());
        }
        if let Some(entry) = &entry {
            self.remember(entry)?;
        }
        self.retain(encoded_bound(path.as_str().len(), 128, 0)?)?;
        self.paths
            .insert(path.clone(), entry.as_ref().map(|entry| entry.id.clone()));
        Ok(entry)
    }

    fn target(&mut self, id: &EntryId, expected: &Revision) -> Result<EntryState, R::Error> {
        let entry = self.entry(id)?;
        validate_target(entry.as_ref(), id, expected)?;
        Ok(entry.expect("validated target"))
    }

    fn require_parent(&mut self, path: &VaultPath) -> Result<(), R::Error> {
        self.retain(encoded_bound(path.as_str().len(), 0, 0)?)?;
        if let Some(parent) = path.parent() {
            if !self
                .live_path(&parent)?
                .is_some_and(|entry| entry.kind == EntryKind::Folder)
            {
                return Err(invalid("parent path must be an existing live folder").into());
            }
        }
        Ok(())
    }

    fn bump_ancestors(&mut self, path: &VaultPath) -> Result<(), R::Error> {
        self.retain(encoded_bound(path.as_str().len(), 0, 0)?)?;
        let mut parent = path.parent();
        while let Some(path) = parent {
            let entry = self
                .live_path(&path)?
                .filter(|entry| entry.kind == EntryKind::Folder)
                .ok_or_else(|| invalid("parent path must be an existing live folder"))?;
            if !self.changed.contains_key(&entry.id) {
                let mut after = self.copy(&entry)?;
                after.revision = self.revision.clone();
                self.changed.insert(after.id.clone(), after);
            } else {
                self.changed
                    .get_mut(&entry.id)
                    .expect("changed key")
                    .revision = self.revision.clone();
            }
            self.retain(encoded_bound(path.as_str().len(), 0, 0)?)?;
            parent = path.parent();
        }
        Ok(())
    }

    fn create(&mut self, id: &EntryId, path: &VaultPath, kind: EntryKind) -> Result<(), R::Error> {
        if self.entry(id)?.is_some() {
            return Err(invalid("entry ID already exists, including retained tombstones").into());
        }
        self.require_parent(path)?;
        if self.live_path(path)?.is_some() {
            return Err(invalid("destination path is occupied").into());
        }
        self.retain(encoded_bound(
            path.as_str().len(),
            id.as_str().len(),
            self.revision.as_str().len(),
        )?)?;
        self.changed.insert(
            id.clone(),
            EntryState {
                id: id.clone(),
                path: path.clone(),
                kind,
                revision: self.revision.clone(),
                deleted: false,
            },
        );
        self.bump_ancestors(path)
    }

    fn materialize(&mut self, id: &EntryId, expected: &Revision) -> Result<(), R::Error> {
        let current = self.target(id, expected)?;
        if current.kind != EntryKind::File {
            return Err(invalid("cannot write content to a folder").into());
        }
        let mut after = self.copy(&current)?;
        after.revision = self.revision.clone();
        self.changed.insert(after.id.clone(), after);
        self.bump_ancestors(&current.path)
    }

    fn descendants(
        &mut self,
        root: &VaultPath,
        stop_after_first: bool,
    ) -> Result<Vec<EntryState>, R::Error> {
        let mut entries = Vec::new();
        let mut after: Option<VaultPath> = None;
        loop {
            self.reader.admit(IndexedMutationWork::Read)?;
            let Some(entry) = self.reader.next_live_descendant(root, after.as_ref())? else {
                break;
            };
            if entry.deleted
                || !entry.path.is_descendant_of(root)
                || after.as_ref().is_some_and(|after| entry.path <= *after)
            {
                return Err(
                    invalid("indexed reader returned an invalid descendant cursor row").into(),
                );
            }
            self.remember(&entry)?;
            self.retain(entry_bound(&entry)?)?;
            after = Some(entry.path.clone());
            entries.push(entry);
            if stop_after_first {
                break;
            }
        }
        Ok(entries)
    }

    fn move_entry(
        &mut self,
        id: &EntryId,
        expected: &Revision,
        path: &VaultPath,
    ) -> Result<(), R::Error> {
        let current = self.target(id, expected)?;
        if current.kind == EntryKind::Folder && path.is_descendant_of(&current.path) {
            return Err(invalid("cannot move a folder inside itself").into());
        }
        self.require_parent(path)?;
        let mut moving = if current.kind == EntryKind::Folder {
            self.descendants(&current.path, false)?
        } else {
            Vec::new()
        };
        self.retain(entry_bound(&current)?)?;
        moving.push(self.copy(&current)?);
        let mut moving_ids = BTreeSet::new();
        for entry in &moving {
            self.reader.admit(IndexedMutationWork::Read)?;
            self.retain(encoded_bound(0, entry.id.as_str().len(), 0)?)?;
            if !moving_ids.insert(entry.id.clone()) {
                return Err(invalid("indexed reader returned duplicate descendant IDs").into());
            }
        }
        for entry in moving {
            self.reader.admit(IndexedMutationWork::Read)?;
            let destination_bytes = if entry.id == *id {
                path.as_str().len()
            } else {
                path.as_str()
                    .len()
                    .checked_add(entry.path.as_str().len() - current.path.as_str().len())
                    .ok_or_else(|| invalid("indexed mutation size accounting overflow"))?
            };
            self.retain(encoded_bound(
                destination_bytes,
                entry.id.as_str().len(),
                self.revision.as_str().len(),
            )?)?;
            let destination = if entry.id == *id {
                path.clone()
            } else {
                entry
                    .path
                    .rebase(&current.path, path)
                    .expect("checked descendant")
            };
            if self
                .live_path(&destination)?
                .is_some_and(|occupant| !moving_ids.contains(&occupant.id))
            {
                return Err(invalid("destination path is occupied").into());
            }
            let mut after = entry;
            after.path = destination;
            after.revision = self.revision.clone();
            self.changed.insert(after.id.clone(), after);
        }
        self.bump_ancestors(&current.path)?;
        self.bump_ancestors(path)
    }

    fn delete(
        &mut self,
        id: &EntryId,
        expected: &Revision,
        recursive: bool,
    ) -> Result<(), R::Error> {
        let current = self.target(id, expected)?;
        let descendants = self.descendants(&current.path, !recursive)?;
        if !recursive && !descendants.is_empty() {
            return Err(invalid("deleting a nonempty folder requires recursive=true").into());
        }
        let parent_path = &current.path;
        let mut after = self.copy(&current)?;
        after.deleted = true;
        after.revision = self.revision.clone();
        self.changed.insert(after.id.clone(), after);
        for mut entry in descendants {
            self.reader.admit(IndexedMutationWork::Read)?;
            self.retain(entry_bound(&entry)?)?;
            entry.deleted = true;
            entry.revision = self.revision.clone();
            self.changed.insert(entry.id.clone(), entry);
        }
        self.bump_ancestors(parent_path)
    }

    fn finish(mut self) -> Result<Vec<EntryChange>, R::Error> {
        // Admit every output before constructing any output Vec. Failure cannot
        // escape as a prefix success, even if earlier candidates were prepared.
        for after in self.changed.values() {
            let before = self.originals.get(&after.id).and_then(Option::as_ref);
            let bytes = entry_bound(after)?
                .checked_add(before.map(entry_bound).transpose()?.unwrap_or(0))
                .and_then(|n| n.checked_add(64))
                .ok_or_else(|| invalid("indexed mutation size accounting overflow"))?;
            self.reader.admit(IndexedMutationWork::Emit {
                encoded_bytes: bytes,
            })?;
        }
        Ok(self
            .changed
            .into_values()
            .map(|after| EntryChange {
                before: self.originals.get(&after.id).cloned().flatten(),
                after,
            })
            .collect())
    }
}

#[cfg(test)]
#[path = "plan_indexed_tests.rs"]
mod tests;
