//! Pure publication classification for a validated namespace graph and retained text.
//!
//! These values are decisions, not authentication or persistence capabilities.
//! Hosts commit graph/text changes atomically and retain previous published bytes
//! whenever the outcome is hidden. Only actual publication establishes a physical
//! baseline. Explicit recovery reads use `recovery_content` instead.
use crate::{
    v2, EntryIdentity, EntryView, Error, Manifest, Projection, RecoveryReason, Result,
    Sha256Digest, MAX_FILE_BYTES, MAX_STATE_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zorid_client_sync::{TextIdentity, TextState};
use zorid_core::{EntryId, EntryKind, Revision, VaultPath};
use zorid_sync_protocol::UpdateId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryMaterialization {
    pub identity: EntryIdentity,
    pub outcome: Outcome,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Outcome {
    Normal {
        path: VaultPath,
        kind: EntryKind,
        /// None is a folder; Some with empty bytes is a complete empty file.
        content: Option<VerifiedContent>,
        namespace_heads: Vec<UpdateId>,
        location_event: UpdateId,
    },
    Pending {
        reason: PendingReason,
    },
    Recovery {
        reason: RecoveryReason,
    },
    Tombstone,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PendingReason {
    MissingBootstrap,
    CausalDependencies { events: BTreeSet<UpdateId> },
    MissingText,
    TextDependencies,
    BinaryDependencies { ids: BTreeSet<UpdateId> },
    FileLimitExceeded { bytes: u64, limit: u64 },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedContent {
    pub bytes: Vec<u8>,
    pub digest: Sha256Digest,
    pub witness: ContentWitness,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentWitness {
    Text {
        identity: TextIdentity,
        revision: Revision,
        snapshot_digest: Sha256Digest,
    },
    Binary {
        selected_event: UpdateId,
        manifest: Manifest,
    },
}

struct Context<'a> {
    state: &'a v2::State,
    view: v2::VaultView,
    identities: BTreeMap<EntryId, EntryIdentity>,
    bindings: BTreeMap<EntryId, v2::ContentBinding>,
    pending: BTreeMap<EntryId, BTreeSet<UpdateId>>,
    text: BTreeMap<EntryId, &'a TextState>,
    limit: u64,
}
impl<'a> Context<'a> {
    fn new(state: &'a v2::State, texts: &'a [TextState], limit: u64) -> Result<Self> {
        if limit > MAX_FILE_BYTES {
            return Err(Error::TooLarge);
        }
        let view = state.view()?;
        let mut result = Self {
            state,
            view,
            identities: BTreeMap::new(),
            bindings: BTreeMap::new(),
            pending: BTreeMap::new(),
            text: BTreeMap::new(),
            limit,
        };
        for payload in state.records().values() {
            let events = match &payload.body {
                v2::Body::Events { events } | v2::Body::ObservedDelete { events } => events,
                _ => continue,
            };
            for event in events {
                result.add_identity(&event.identity, &event.id)?;
                if let v2::Effect::Create {
                    content: Some(seed),
                    ..
                } = &event.effect
                {
                    let binding = match seed {
                        v2::ContentSeed::Binary { .. } => v2::ContentBinding::Binary,
                        v2::ContentSeed::Text {
                            text_bootstrap_id,
                            text_format,
                        } => v2::ContentBinding::Text {
                            text_bootstrap_id: text_bootstrap_id.clone(),
                            text_format: *text_format,
                        },
                    };
                    result.add_binding(&event.identity.entry_id, binding)?;
                }
            }
        }
        for activity in state.activities().values() {
            let identity = EntryIdentity {
                entry_id: activity.identity().entry_id.clone(),
                bootstrap_id: activity.namespace().bootstrap_id.clone(),
            };
            result.add_identity(&identity, activity.update_id())?;
            result.add_binding(
                &identity.entry_id,
                v2::ContentBinding::Text {
                    text_bootstrap_id: activity.identity().bootstrap_id.clone(),
                    text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
                },
            )?;
        }
        // A slice preserves duplicates until we explicitly reject aliases. A host
        // must not first collapse full logical identities into an EntryId map.
        for text in texts {
            let id = &text.identity.entry_id;
            if text.identity.realm_id != state.scope().realm_id
                || text.identity.vault_id != state.scope().vault_id
                || !result.identities.contains_key(id)
                || result.text.insert(id.clone(), text).is_some()
            {
                return Err(Error::IdentityMismatch);
            }
            match result.bindings.get(id) {
                Some(v2::ContentBinding::Text {
                    text_bootstrap_id,
                    text_format,
                }) if text_bootstrap_id == &text.identity.bootstrap_id
                    && *text_format == zorid_client_sync::v2::TEXT_FORMAT_VERSION => {}
                _ => return Err(Error::IdentityMismatch),
            }
        }
        Ok(result)
    }
    fn add_identity(&mut self, identity: &EntryIdentity, event: &UpdateId) -> Result<()> {
        if self
            .identities
            .insert(identity.entry_id.clone(), identity.clone())
            .is_some_and(|old| old != *identity)
        {
            return Err(Error::IdentityMismatch);
        }
        if self.view.namespace.pending.contains(event) {
            self.pending
                .entry(identity.entry_id.clone())
                .or_default()
                .insert(event.clone());
        }
        Ok(())
    }
    fn add_binding(&mut self, id: &EntryId, binding: v2::ContentBinding) -> Result<()> {
        if self
            .bindings
            .insert(id.clone(), binding.clone())
            .is_some_and(|old| old != binding)
        {
            return Err(Error::IdentityMismatch);
        }
        Ok(())
    }
    fn pending_ancestors(&self, entry: &EntryView) -> Result<BTreeSet<UpdateId>> {
        let mut pending = BTreeSet::new();
        let mut visited = BTreeSet::new();
        let mut current = Some(&entry.identity.entry_id);
        while let Some(id) = current {
            if !visited.insert(id) {
                return Err(Error::InvalidState);
            }
            if let Some(events) = self.pending.get(id) {
                pending.extend(events.iter().cloned());
            }
            let parent = self
                .view
                .namespace
                .entries
                .get(id)
                .ok_or(Error::InvalidState)?;
            current = parent
                .locations
                .last()
                .ok_or(Error::InvalidState)?
                .location
                .parent
                .as_ref();
        }
        Ok(pending)
    }
    fn content(
        &self,
        id: &EntryId,
        budget: &mut u64,
    ) -> Result<std::result::Result<Option<VerifiedContent>, PendingReason>> {
        match self.bindings.get(id) {
            None => {
                if self
                    .view
                    .namespace
                    .entries
                    .get(id)
                    .is_some_and(|e| e.kind == EntryKind::Folder)
                {
                    Ok(Ok(None))
                } else {
                    Ok(Err(PendingReason::MissingBootstrap))
                }
            }
            Some(v2::ContentBinding::Text { .. }) => {
                let Some(text) = self.text.get(id) else {
                    return Ok(Err(PendingReason::MissingText));
                };
                let Some(bytes) = text.complete_materialized_utf8().map_err(|e| match e {
                    zorid_client_sync::SyncError::TooLarge => Error::TooLarge,
                    _ => Error::InvalidState,
                })?
                else {
                    return Ok(Err(PendingReason::TextDependencies));
                };
                if bytes.len() as u64 > self.limit {
                    return Ok(Err(PendingReason::FileLimitExceeded {
                        bytes: bytes.len() as u64,
                        limit: self.limit,
                    }));
                }
                reserve(budget, bytes.len() as u64)?;
                Ok(Ok(Some(VerifiedContent {
                    digest: Sha256Digest::of(&bytes),
                    bytes,
                    witness: ContentWitness::Text {
                        identity: text.identity.clone(),
                        revision: text.version.clone(),
                        snapshot_digest: Sha256Digest::of(&text.snapshot),
                    },
                })))
            }
            Some(v2::ContentBinding::Binary) => {
                let Some(entry) = self.view.namespace.entries.get(id) else {
                    return Ok(Err(PendingReason::MissingBootstrap));
                };
                // The portable graph orders all retained alternatives by event ID.
                // An incomplete preferred head never falls back to another head.
                let head = entry.contents.last().ok_or(Error::InvalidState)?;
                if head.manifest.bytes > self.limit {
                    return Ok(Err(PendingReason::FileLimitExceeded {
                        bytes: head.manifest.bytes,
                        limit: self.limit,
                    }));
                }
                if !head.status.missing.is_empty() {
                    return Ok(Err(PendingReason::BinaryDependencies {
                        ids: head.status.missing.clone(),
                    }));
                }
                reserve(budget, head.manifest.bytes)?;
                let bytes = self.binary_bytes(&head.manifest)?;
                Ok(Ok(Some(VerifiedContent {
                    digest: head.manifest.digest,
                    bytes,
                    witness: ContentWitness::Binary {
                        selected_event: head.event.clone(),
                        manifest: head.manifest.clone(),
                    },
                })))
            }
        }
    }
    fn binary_bytes(&self, manifest: &Manifest) -> Result<Vec<u8>> {
        // Context construction validated every page reference, chunk reference,
        // length and final digest once. Do not rebuild the entire graph per file.
        let mut bytes =
            Vec::with_capacity(usize::try_from(manifest.bytes).map_err(|_| Error::TooLarge)?);
        for reference in &manifest.pages {
            let Some(v2::Payload {
                body: v2::Body::Page { page },
                ..
            }) = self.state.records().get(&reference.id)
            else {
                return Err(Error::InvalidContent);
            };
            for chunk in &page.chunks {
                let Some(v2::Payload {
                    body: v2::Body::Chunk { bytes: part },
                    ..
                }) = self.state.records().get(&chunk.id)
                else {
                    return Err(Error::InvalidContent);
                };
                if (bytes.len() as u64)
                    .checked_add(part.len() as u64)
                    .is_none_or(|n| n > manifest.bytes)
                {
                    return Err(Error::InvalidContent);
                }
                bytes.extend_from_slice(part);
            }
        }
        if bytes.len() as u64 != manifest.bytes || Sha256Digest::of(&bytes) != manifest.digest {
            return Err(Error::InvalidContent);
        }
        Ok(bytes)
    }
}
fn reserve(budget: &mut u64, bytes: u64) -> Result<()> {
    *budget = budget.checked_sub(bytes).ok_or(Error::TooLarge)?;
    Ok(())
}

/// Classify every stable identity, including events/activity preceding Create.
/// Hidden outcomes contain no replacement bytes. Aggregate returned content is
/// bounded by MAX_STATE_BYTES, including repeated use of a shared manifest.
pub fn classify(
    state: &v2::State,
    texts: &[TextState],
    max_file_bytes: u64,
) -> Result<BTreeMap<EntryId, EntryMaterialization>> {
    classify_bounded(state, texts, max_file_bytes, MAX_STATE_BYTES as u64)
}

/// Same classification with a caller-selected aggregate content budget. Binary
/// output is reserved before allocation; text uses the client-sync bounded
/// decoder (at most MAX_TEXT_BYTES transient content) before reserving its result.
/// This bounds returned raw content, not serialized JSON or total runtime memory.
pub fn classify_bounded(
    state: &v2::State,
    texts: &[TextState],
    max_file_bytes: u64,
    max_total_content_bytes: u64,
) -> Result<BTreeMap<EntryId, EntryMaterialization>> {
    if max_total_content_bytes > MAX_STATE_BYTES as u64 {
        return Err(Error::TooLarge);
    }
    let context = Context::new(state, texts, max_file_bytes)?;
    let mut output = BTreeMap::new();
    let mut budget = max_total_content_bytes;
    for (id, identity) in &context.identities {
        let outcome = match context.view.namespace.entries.get(id) {
            None => Outcome::Pending {
                reason: PendingReason::MissingBootstrap,
            },
            Some(_) if context.pending.contains_key(id) => Outcome::Pending {
                reason: PendingReason::CausalDependencies {
                    events: context.pending[id].clone(),
                },
            },
            Some(entry) => match &entry.projection {
                Projection::Tombstone => Outcome::Tombstone,
                Projection::Recovery { reason, .. } => Outcome::Recovery {
                    reason: reason.clone(),
                },
                Projection::Normal { path } => {
                    let pending = context.pending_ancestors(entry)?;
                    if !pending.is_empty() {
                        Outcome::Pending {
                            reason: PendingReason::CausalDependencies { events: pending },
                        }
                    } else {
                        match context.content(id, &mut budget)? {
                            Err(reason) => Outcome::Pending { reason },
                            Ok(content) => Outcome::Normal {
                                path: path.clone(),
                                kind: entry.kind,
                                content,
                                namespace_heads: entry.heads.clone(),
                                location_event: entry
                                    .locations
                                    .last()
                                    .ok_or(Error::InvalidState)?
                                    .event
                                    .clone(),
                            },
                        }
                    }
                }
            },
        };
        output.insert(
            id.clone(),
            EntryMaterialization {
                identity: identity.clone(),
                outcome,
            },
        );
    }
    Ok(output)
}

/// Explicit recovery read of the current deterministic content, independent of
/// path/liveness/publication. None means a folder or unavailable dependencies;
/// oversize content is an error. This never advances a physical baseline and
/// never substitutes an older binary alternative when the chosen head is pending.
pub fn recovery_content(
    state: &v2::State,
    texts: &[TextState],
    entry: &EntryId,
    max_file_bytes: u64,
) -> Result<Option<VerifiedContent>> {
    let context = Context::new(state, texts, max_file_bytes)?;
    if !context.identities.contains_key(entry) {
        return Err(Error::IdentityMismatch);
    }
    match context.content(entry, &mut (MAX_STATE_BYTES as u64))? {
        Ok(content) => Ok(content),
        Err(PendingReason::FileLimitExceeded { .. }) => Err(Error::TooLarge),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
#[path = "materialization_tests.rs"]
mod tests;
