//! Final file-event mapping for a sealed, operation-bound staged binary.
//! This does not create a receipt, validate filesystem authority or plan core
//! EntryChanges. Hosts retain the original target and stage identity, verify the
//! candidate, then atomically check metadata/source pins and commit all effects.
use crate::binary_stream::AuthoredRecord;
use crate::metadata::{GraphRecordBody, MetadataState};
use crate::metadata_plan::{prepare_authored_batch, AuthoredMetadataBatch, MetadataCandidate};
use crate::mutation::{Error, Result};
use crate::{v2, EntryIdentity, Family, Location, Manifest, Projection};
use std::collections::BTreeSet;
use zorid_core::{EntryId, EntryKind, EntryState, Revision, VaultPath};
use zorid_sync_protocol::UpdateId;

/// Exact original stream target. Equal content bytes do not make two different
/// selected causal events interchangeable. Hosts bind this to the durable stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinaryTarget {
    Create {
        id: EntryId,
        path: VaultPath,
    },
    Write {
        id: EntryId,
        expected_revision: Revision,
        expected_content_event: UpdateId,
    },
}
impl BinaryTarget {
    pub fn id(&self) -> &EntryId {
        match self {
            Self::Create { id, .. } | Self::Write { id, .. } => id,
        }
    }
}

/// Metadata plus ONE bounded final event, not all staged file payloads. This is
/// still an unverified candidate and cannot be deserialized as commit authority.
#[derive(Debug)]
pub struct PreparedBinaryMutation {
    target: BinaryTarget,
    expected_entries: Vec<EntryState>,
    final_event: AuthoredRecord,
    candidate: MetadataCandidate,
}
impl PreparedBinaryMutation {
    pub fn target(&self) -> &BinaryTarget {
        &self.target
    }
    pub fn expected_entries(&self) -> &[EntryState] {
        &self.expected_entries
    }
    pub fn final_event(&self) -> &AuthoredRecord {
        &self.final_event
    }
    pub fn candidate(&self) -> &MetadataCandidate {
        &self.candidate
    }
    pub fn check_preconditions(&self, state: &MetadataState, entries: &[EntryState]) -> Result<()> {
        if state != self.candidate.expected_state() {
            return Err(Error::SnapshotMismatch);
        }
        let mut entries = entries.to_vec();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        if entries != self.expected_entries {
            return Err(Error::SnapshotMismatch);
        }
        Ok(())
    }
    pub fn into_parts(
        self,
    ) -> (
        BinaryTarget,
        Vec<EntryState>,
        AuthoredRecord,
        MetadataCandidate,
    ) {
        (
            self.target,
            self.expected_entries,
            self.final_event,
            self.candidate,
        )
    }
}

fn known_entry(state: &MetadataState, id: &EntryId) -> bool {
    state.records().values().any(|record| match record.body() {
        GraphRecordBody::Events { events } | GraphRecordBody::ObservedDelete { events } => {
            events.iter().any(|event| &event.identity.entry_id == id)
        }
        _ => false,
    }) || state
        .activities()
        .values()
        .any(|activity| &activity.identity().entry_id == id)
}

// Allocate outside every observed historical/future reference, not just rows
// present now. Otherwise local authorship could impersonate a missing remote ID.
fn reserved_ids(state: &MetadataState) -> BTreeSet<UpdateId> {
    let mut ids = BTreeSet::new();
    for (id, record) in state.records() {
        ids.insert(id.clone());
        match record.body() {
            GraphRecordBody::Events { events } | GraphRecordBody::ObservedDelete { events } => {
                for event in events {
                    ids.insert(event.id.clone());
                    ids.insert(event.identity.bootstrap_id.clone());
                    ids.extend(event.parents.iter().cloned());
                    match &event.effect {
                        v2::Effect::Create {
                            content:
                                Some(v2::ContentSeed::Text {
                                    text_bootstrap_id, ..
                                }),
                            ..
                        } => {
                            ids.insert(text_bootstrap_id.clone());
                        }
                        v2::Effect::Create {
                            content: Some(v2::ContentSeed::Binary { manifest }),
                            ..
                        }
                        | v2::Effect::SetContent { content: manifest } => {
                            ids.extend(manifest.pages.iter().map(|page| page.id.clone()));
                        }
                        _ => (),
                    }
                }
            }
            GraphRecordBody::Page { page } => {
                ids.extend(page.chunks.iter().map(|chunk| chunk.id.clone()));
            }
            _ => (),
        }
    }
    for (id, activity) in state.activities() {
        ids.insert(id.clone());
        ids.insert(activity.identity().bootstrap_id.clone());
        ids.insert(activity.namespace().bootstrap_id.clone());
        ids.extend(activity.namespace().parents.iter().cloned());
    }
    ids
}

// This first mapper accepts a complete newly staged file, not a delta or shared
// retained sources. Exact closure prevents unrelated records from piggybacking
// on the stage commit. Content hashes still require the private verifier later.
fn check_stage(batch: &AuthoredMetadataBatch, manifest: &Manifest) -> Result<()> {
    manifest.validate()?;
    if batch.activity_ids().next().is_some() {
        return Err(Error::InvalidAllocation);
    }
    let records: std::collections::BTreeMap<_, _> = batch
        .payload_refs()
        .iter()
        .map(|reference| (reference.id().clone(), reference.record()))
        .collect();
    let mut used = BTreeSet::new();
    for page_ref in &manifest.pages {
        let record = records.get(&page_ref.id).ok_or(Error::InvalidAllocation)?;
        let GraphRecordBody::Page { page } = record.body() else {
            return Err(Error::InvalidAllocation);
        };
        if page.reference(page_ref.id.clone())? != *page_ref {
            return Err(Error::SnapshotMismatch);
        }
        if !used.insert(page_ref.id.clone()) {
            return Err(Error::InvalidAllocation);
        }
        for chunk in &page.chunks {
            let record = records.get(&chunk.id).ok_or(Error::InvalidAllocation)?;
            if !matches!(record.body(), GraphRecordBody::Chunk { bytes, digest } if *bytes == chunk.bytes && *digest == chunk.digest)
            {
                return Err(Error::SnapshotMismatch);
            }
            // The staged builder emits stable unique IDs per input chunk.
            if !used.insert(chunk.id.clone()) {
                return Err(Error::InvalidAllocation);
            }
        }
    }
    if used.len() != records.len() {
        return Err(Error::InvalidAllocation);
    }
    Ok(())
}

fn location(path: &VaultPath, entries: &[EntryState]) -> Result<Location> {
    let parent = match path.parent() {
        None => None,
        Some(parent) => Some(
            entries
                .iter()
                .find(|entry| {
                    !entry.deleted && entry.kind == EntryKind::Folder && entry.path == parent
                })
                .ok_or(Error::SnapshotMismatch)?
                .id
                .clone(),
        ),
    };
    Ok(Location {
        parent,
        name: path.file_name().to_owned(),
    })
}

/// Build one existing files-v2 event and an additive metadata candidate. The
/// sealed stage must supply exactly its stable chunk/page emissions. This never
/// substitutes empty bytes in a legacy MutationRequest, and never grants a
/// successful receipt until the host's separate metadata/atomic-commit contract.
pub fn prepare_binary_mutation(
    state: &MetadataState,
    entries: &[EntryState],
    target: BinaryTarget,
    mut staged: AuthoredMetadataBatch,
    manifest: &Manifest,
    final_event_id: UpdateId,
    next_graph_revision: Revision,
) -> Result<PreparedBinaryMutation> {
    zorid_core::validate_snapshot(entries)?;
    let view = state.metadata_view()?;
    if state.scope() != staged.scope() {
        return Err(crate::Error::IdentityMismatch.into());
    }
    check_stage(&staged, manifest)?;
    if state.version() == &next_graph_revision
        || entries
            .iter()
            .any(|entry| entry.revision == next_graph_revision)
    {
        return Err(Error::InvalidAllocation);
    }
    let mut reserved = reserved_ids(state);
    for reference in staged.payload_refs() {
        if !reserved.insert(reference.id().clone()) {
            return Err(Error::InvalidAllocation);
        }
    }
    if !reserved.insert(final_event_id.clone()) {
        return Err(Error::InvalidAllocation);
    }
    // Supplied materialized rows may be a subset, but every live row must still
    // describe the exact graph namespace and immutable kind.
    for entry in entries.iter().filter(|entry| !entry.deleted) {
        let visible = view
            .namespace()
            .entries
            .get(&entry.id)
            .ok_or(Error::SnapshotMismatch)?;
        if visible.kind != entry.kind
            || visible.projection
                != (Projection::Normal {
                    path: entry.path.clone(),
                })
        {
            return Err(Error::SnapshotMismatch);
        }
    }
    let (identity, parents, effect) = match &target {
        BinaryTarget::Create { id, path } => {
            if known_entry(state, id) || entries.iter().any(|entry| &entry.id == id) {
                return Err(Error::SnapshotMismatch);
            }
            // Pending binary bytes must not make an occupied logical path look
            // free merely because the host has not published its EntryState.
            if view
                .namespace()
                .entries
                .values()
                .any(|entry| entry.projection == (Projection::Normal { path: path.clone() }))
                || entries
                    .iter()
                    .any(|entry| !entry.deleted && &entry.path == path)
            {
                return Err(Error::SnapshotMismatch);
            }
            (
                EntryIdentity {
                    entry_id: id.clone(),
                    bootstrap_id: final_event_id.clone(),
                },
                vec![],
                v2::Effect::Create {
                    entry_kind: EntryKind::File,
                    location: location(path, entries)?,
                    content: Some(v2::ContentSeed::Binary {
                        manifest: manifest.clone(),
                    }),
                },
            )
        }
        BinaryTarget::Write {
            id,
            expected_revision,
            expected_content_event,
        } => {
            let target = zorid_core::validate_target(
                entries.iter().find(|entry| &entry.id == id),
                id,
                expected_revision,
            )?;
            let visible = view
                .namespace()
                .entries
                .get(id)
                .ok_or(Error::SnapshotMismatch)?;
            if target.kind != EntryKind::File
                || view.content_bindings().get(id) != Some(&v2::ContentBinding::Binary)
                || visible.contents.last().map(|head| &head.event) != Some(expected_content_event)
            {
                return Err(Error::SnapshotMismatch);
            }
            (
                visible.identity.clone(),
                visible.heads.clone(),
                v2::Effect::SetContent {
                    content: manifest.clone(),
                },
            )
        }
    };
    let final_event = AuthoredRecord::from_payload(v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: state.scope().clone(),
        id: final_event_id.clone(),
        body: v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: final_event_id,
                identity,
                parents,
                effect,
            }],
        },
    })?;
    staged.push_exact(final_event.payload_bytes())?;
    let candidate = prepare_authored_batch(state, staged, next_graph_revision)?;
    let mut expected_entries = entries.to_vec();
    expected_entries.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(PreparedBinaryMutation {
        target,
        expected_entries,
        final_event,
        candidate,
    })
}

#[cfg(test)]
#[path = "binary_mutation_tests.rs"]
mod tests;
