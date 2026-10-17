use crate::{
    validate_target, ContractError, EntryChange, EntryId, EntryKind, EntryState, Mutation,
    MutationRequest, Revision, VaultPath,
};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(reason: &str) -> ContractError {
    ContractError::InvalidMutation {
        reason: reason.into(),
    }
}

/// Validate a complete persisted metadata snapshot without planning a mutation.
/// Hosts still validate byte/presentation storage consistency separately.
pub fn validate_snapshot(entries: &[EntryState]) -> Result<(), ContractError> {
    Snapshot::new(entries).map(|_| ())
}

/// Metadata target for creating or replacing file content supplied separately.
/// This carries no operation identity, content bytes or authorization evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileContentTarget {
    Create { id: EntryId, path: VaultPath },
    Write { id: EntryId, expected: Revision },
}

/// Plan file metadata without constructing or copying its content bytes.
///
/// The complete snapshot must be transaction-current. Create always creates a
/// file with a never-reused entry ID; Write requires the exact live file revision.
/// Both revise live ancestors and require a fresh revision in this snapshot.
/// Historical revision uniqueness remains the host allocator's responsibility.
///
/// This creates no operation ID, receipt, journal or outbox authorization. The
/// host must bind this target to the original staged operation and independently
/// verified content/source/selected-event evidence, then atomically commit the
/// metadata, content and operation records. The target alone is not that proof.
pub fn plan_file_content_mutation(
    target: &FileContentTarget,
    entries: &[EntryState],
    next_revision: &Revision,
) -> Result<Vec<EntryChange>, ContractError> {
    let snapshot = Snapshot::new(entries)?;
    snapshot.require_fresh_revision(next_revision)?;
    let mut changed = BTreeMap::new();
    match target {
        FileContentTarget::Create { id, path } => {
            snapshot.create_entry(id, path, EntryKind::File, next_revision, &mut changed)?;
        }
        FileContentTarget::Write { id, expected } => {
            snapshot.materialize_file(id, expected, next_revision, &mut changed)?;
        }
    }
    Ok(snapshot.changes(changed))
}

/// Plan metadata changes for newly materialized content of an existing live file.
///
/// This is not a local command: it creates no operation ID, receipt or outbox
/// record and does not authenticate or interpret content bytes. The host checks
/// receive deduplication/authentication first, then atomically persists this plan
/// with the materialized bytes, received state and cursor. The complete snapshot
/// must be transaction-current. IDs, paths, kinds and tombstones are unchanged;
/// only the file and its live ancestors receive the freshly allocated revision.
/// The allocator must also avoid reuse of revisions absent from this snapshot.
pub fn plan_file_materialization(
    id: &EntryId,
    expected_revision: &Revision,
    next_revision: &Revision,
    entries: &[EntryState],
) -> Result<Vec<EntryChange>, ContractError> {
    let snapshot = Snapshot::new(entries)?;
    snapshot.require_fresh_revision(next_revision)?;
    let mut changed = BTreeMap::new();
    snapshot.materialize_file(id, expected_revision, next_revision, &mut changed)?;
    Ok(snapshot.changes(changed))
}

/// Plan one local mutation from a complete, transaction-current metadata snapshot.
///
/// Returns a deterministic batch ordered by stable entry ID, with ancestor
/// revisions included. It never reads/copies file bodies from storage. The caller
/// checks idempotency first, allocates a never-reused revision, then persists this
/// plan, payload bytes and required journal/intents atomically. No mutation is
/// committed by this function. Paths here use exact logical spelling; adapters
/// must separately reject aliases on their actual filesystem before projection.
///
/// First-slice cost is O(n log n + d log n), plus path lengths, where n is all
/// metadata entries and d is changed descendants/ancestors. This full-snapshot
/// interface is deliberately not a claim of large-vault indexing performance.
pub fn plan_mutation(
    request: &MutationRequest,
    entries: &[EntryState],
    next_revision: &Revision,
) -> Result<Vec<EntryChange>, ContractError> {
    request.validate()?;
    let snapshot = Snapshot::new(entries)?;
    snapshot.require_fresh_revision(next_revision)?;
    let mut changed = BTreeMap::<EntryId, EntryState>::new();
    match &request.mutation {
        Mutation::Create { id, path, kind, .. } => {
            snapshot.create_entry(id, path, *kind, next_revision, &mut changed)?;
        }
        Mutation::Write { id, expected, .. } => {
            snapshot.materialize_file(id, expected, next_revision, &mut changed)?;
        }
        Mutation::Move { id, expected, path } => {
            let current = validate_target(snapshot.by_id.get(id).copied(), id, expected)?;
            if current.kind == EntryKind::Folder && path.is_descendant_of(&current.path) {
                return Err(invalid("cannot move a folder inside itself"));
            }
            snapshot.require_parent(path)?;
            let moving: Vec<_> = entries
                .iter()
                .filter(|entry| {
                    !entry.deleted
                        && (entry.id == *id
                            || (current.kind == EntryKind::Folder
                                && entry.path.is_descendant_of(&current.path)))
                })
                .collect();
            let moving_ids: BTreeSet<_> = moving.iter().map(|entry| &entry.id).collect();
            for entry in &moving {
                let destination = if entry.id == *id {
                    path.clone()
                } else {
                    entry
                        .path
                        .rebase(&current.path, path)
                        .expect("selected a descendant")
                };
                if snapshot
                    .live_paths
                    .get(&destination)
                    .is_some_and(|occupant| !moving_ids.contains(&occupant.id))
                {
                    return Err(invalid("destination path is occupied"));
                }
                let mut after = (*entry).clone();
                after.path = destination;
                after.revision = next_revision.clone();
                changed.insert(after.id.clone(), after);
            }
            snapshot.bump_ancestors(&current.path, next_revision, &mut changed);
            snapshot.bump_ancestors(path, next_revision, &mut changed);
        }
        Mutation::Delete {
            id,
            expected,
            recursive,
        } => {
            let current = validate_target(snapshot.by_id.get(id).copied(), id, expected)?;
            let descendants: Vec<_> = entries
                .iter()
                .filter(|entry| !entry.deleted && entry.path.is_descendant_of(&current.path))
                .collect();
            if !recursive && !descendants.is_empty() {
                return Err(invalid(
                    "deleting a nonempty folder requires recursive=true",
                ));
            }
            for entry in std::iter::once(current).chain(descendants) {
                let mut after = entry.clone();
                after.deleted = true;
                after.revision = next_revision.clone();
                changed.insert(after.id.clone(), after);
            }
            snapshot.bump_ancestors(&current.path, next_revision, &mut changed);
        }
    }
    Ok(snapshot.changes(changed))
}

struct Snapshot<'a> {
    by_id: BTreeMap<EntryId, &'a EntryState>,
    live_paths: BTreeMap<VaultPath, &'a EntryState>,
}

impl<'a> Snapshot<'a> {
    fn new(entries: &'a [EntryState]) -> Result<Self, ContractError> {
        let mut snapshot = Self {
            by_id: BTreeMap::new(),
            live_paths: BTreeMap::new(),
        };
        for entry in entries {
            if snapshot.by_id.insert(entry.id.clone(), entry).is_some() {
                return Err(invalid("metadata snapshot contains duplicate entry IDs"));
            }
            if !entry.deleted
                && snapshot
                    .live_paths
                    .insert(entry.path.clone(), entry)
                    .is_some()
            {
                return Err(invalid("metadata snapshot contains duplicate live paths"));
            }
        }
        for entry in snapshot.live_paths.values() {
            snapshot.require_parent(&entry.path)?;
        }
        Ok(snapshot)
    }

    fn require_fresh_revision(&self, revision: &Revision) -> Result<(), ContractError> {
        // Historical uniqueness still belongs to the host's revision allocator.
        if self.by_id.values().any(|entry| entry.revision == *revision) {
            return Err(invalid("next revision must be freshly allocated"));
        }
        Ok(())
    }

    fn create_entry(
        &self,
        id: &EntryId,
        path: &VaultPath,
        kind: EntryKind,
        next_revision: &Revision,
        changed: &mut BTreeMap<EntryId, EntryState>,
    ) -> Result<(), ContractError> {
        if self.by_id.contains_key(id) {
            return Err(invalid(
                "entry ID already exists, including retained tombstones",
            ));
        }
        self.require_parent(path)?;
        if self.live_paths.contains_key(path) {
            return Err(invalid("destination path is occupied"));
        }
        changed.insert(
            id.clone(),
            EntryState {
                id: id.clone(),
                path: path.clone(),
                kind,
                revision: next_revision.clone(),
                deleted: false,
            },
        );
        self.bump_ancestors(path, next_revision, changed);
        Ok(())
    }

    fn materialize_file(
        &self,
        id: &EntryId,
        expected: &Revision,
        next_revision: &Revision,
        changed: &mut BTreeMap<EntryId, EntryState>,
    ) -> Result<(), ContractError> {
        let current = validate_target(self.by_id.get(id).copied(), id, expected)?;
        if current.kind != EntryKind::File {
            return Err(invalid("cannot write content to a folder"));
        }
        let mut after = current.clone();
        after.revision = next_revision.clone();
        changed.insert(id.clone(), after);
        self.bump_ancestors(&current.path, next_revision, changed);
        Ok(())
    }

    fn changes(&self, changed: BTreeMap<EntryId, EntryState>) -> Vec<EntryChange> {
        changed
            .into_values()
            .map(|after| EntryChange {
                before: self.by_id.get(&after.id).map(|entry| (*entry).clone()),
                after,
            })
            .collect()
    }

    fn require_parent(&self, path: &VaultPath) -> Result<(), ContractError> {
        if let Some(parent) = path.parent() {
            if !self
                .live_paths
                .get(&parent)
                .is_some_and(|entry| entry.kind == EntryKind::Folder)
            {
                return Err(invalid("parent path must be an existing live folder"));
            }
        }
        Ok(())
    }

    fn bump_ancestors(
        &self,
        path: &VaultPath,
        revision: &Revision,
        changed: &mut BTreeMap<EntryId, EntryState>,
    ) {
        let mut parent = path.parent();
        while let Some(path) = parent {
            let entry = self
                .live_paths
                .get(&path)
                .expect("validated parent hierarchy");
            let after = changed
                .entry(entry.id.clone())
                .or_insert_with(|| (*entry).clone());
            after.revision = revision.clone();
            parent = path.parent();
        }
    }
}
