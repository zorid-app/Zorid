//! Publication classification without expanding binary content into memory.
//!
//! Metadata dependency completeness is not a content proof. Every binary Normal
//! result requires an exact-state verified manifest. Text keeps the existing
//! bounded CRDT decoder and an independently checked retained-output budget;
//! one temporary text buffer may exist beyond that retained-output budget.
//! These decisions do not authenticate records or authorize physical publication.
use crate::binary_stream::VerifiedBinarySet;
use crate::materialization::{ContentWitness, PendingReason, VerifiedContent};
use crate::metadata::{BinaryContentRef, GraphRecordBody, MetadataState, MetadataView};
use crate::{
    v2, EntryIdentity, EntryView, Error, Projection, RecoveryReason, Result, Sha256Digest,
    MAX_FILE_BYTES, MAX_STATE_BYTES,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use zorid_client_sync::TextState;
use zorid_core::{EntryId, EntryKind, VaultPath};
use zorid_sync_protocol::UpdateId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EntryMaterializationRef {
    pub identity: EntryIdentity,
    pub outcome: OutcomeRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OutcomeRef {
    Normal {
        path: VaultPath,
        kind: EntryKind,
        /// None is a folder. An empty file still has a content reference.
        content: Option<ContentRef>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "content", rename_all = "snake_case")]
pub enum ContentRef {
    Binary(BinaryContentRef),
    Text(VerifiedContent),
}

struct Context<'a> {
    state: &'a MetadataState,
    verified: &'a VerifiedBinarySet,
    view: MetadataView,
    identities: BTreeMap<EntryId, EntryIdentity>,
    bindings: BTreeMap<EntryId, v2::ContentBinding>,
    pending: BTreeMap<EntryId, BTreeSet<UpdateId>>,
    text: BTreeMap<EntryId, &'a TextState>,
    limit: u64,
}

impl<'a> Context<'a> {
    fn new(
        state: &'a MetadataState,
        verified: &'a VerifiedBinarySet,
        texts: &'a [TextState],
        limit: u64,
    ) -> Result<Self> {
        if limit > MAX_FILE_BYTES {
            return Err(Error::TooLarge);
        }
        let mut result = Self {
            state,
            verified,
            view: state.metadata_view()?,
            identities: BTreeMap::new(),
            bindings: BTreeMap::new(),
            pending: BTreeMap::new(),
            text: BTreeMap::new(),
            limit,
        };
        for record in state.records().values() {
            let events = match record.body() {
                GraphRecordBody::Events { events } | GraphRecordBody::ObservedDelete { events } => {
                    events
                }
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
        // Check full logical identities before collapsing anything to EntryId.
        // These checks also apply to hidden and tombstoned text.
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
        if self.view.namespace().pending.contains(event) {
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
                .namespace()
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
        text_budget: &mut u64,
    ) -> Result<std::result::Result<Option<ContentRef>, PendingReason>> {
        match self.bindings.get(id) {
            None => {
                if self
                    .view
                    .namespace()
                    .entries
                    .get(id)
                    .is_some_and(|entry| entry.kind == EntryKind::Folder)
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
                let Some(bytes) = text.complete_materialized_utf8().map_err(text_error)? else {
                    return Ok(Err(PendingReason::TextDependencies));
                };
                let length = bytes.len() as u64;
                if length > self.limit {
                    return Ok(Err(PendingReason::FileLimitExceeded {
                        bytes: length,
                        limit: self.limit,
                    }));
                }
                // Use one existing bounded decoder result. The aggregate budget
                // bounds retained output, not this temporary or CRDT decoding.
                // Reject before retaining bytes in the classification result.
                *text_budget = text_budget.checked_sub(length).ok_or(Error::TooLarge)?;
                Ok(Ok(Some(ContentRef::Text(VerifiedContent {
                    digest: Sha256Digest::of(&bytes),
                    bytes,
                    witness: ContentWitness::Text {
                        identity: text.identity.clone(),
                        revision: text.version.clone(),
                        snapshot_digest: Sha256Digest::of(&text.snapshot),
                    },
                }))))
            }
            Some(v2::ContentBinding::Binary) => {
                let Some(entry) = self.view.namespace().entries.get(id) else {
                    return Ok(Err(PendingReason::MissingBootstrap));
                };
                // Preserve deterministic preferred-head selection, including
                // equal-byte alternatives with different causal witnesses.
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
                let proof = self
                    .verified
                    .get(&head.manifest)?
                    .ok_or(Error::InvalidContent)?;
                proof.check_preconditions(self.state, &head.manifest)?;
                let content = self
                    .state
                    .binary_content_ref(&entry.identity, &head.event)?;
                Ok(Ok(Some(ContentRef::Binary(content))))
            }
        }
    }
}

fn text_error(error: zorid_client_sync::SyncError) -> Error {
    match error {
        zorid_client_sync::SyncError::TooLarge => Error::TooLarge,
        _ => Error::InvalidState,
    }
}

/// Classify every stable identity in deterministic EntryId order. Binary output
/// contains retained causal references only and never consumes the text budget.
/// Text uses client-sync's existing 256 KiB content limit. One temporary decoder
/// result can exist beyond the aggregate retained-output budget; that budget is
/// checked before retaining content, and does not bound total decoding memory.
/// Hidden outcomes contain no content.
pub fn classify_metadata(
    state: &MetadataState,
    verified: &VerifiedBinarySet,
    texts: &[TextState],
    max_file_bytes: u64,
    max_text_output_bytes: u64,
) -> Result<Vec<EntryMaterializationRef>> {
    verified.check_preconditions(state)?;
    if max_text_output_bytes > MAX_STATE_BYTES as u64 {
        return Err(Error::TooLarge);
    }
    let context = Context::new(state, verified, texts, max_file_bytes)?;
    let mut output = Vec::with_capacity(context.identities.len());
    let mut text_budget = max_text_output_bytes;
    for (id, identity) in &context.identities {
        let outcome = match context.view.namespace().entries.get(id) {
            None => OutcomeRef::Pending {
                reason: PendingReason::MissingBootstrap,
            },
            Some(_) if context.pending.contains_key(id) => OutcomeRef::Pending {
                reason: PendingReason::CausalDependencies {
                    events: context.pending[id].clone(),
                },
            },
            Some(entry) => match &entry.projection {
                Projection::Tombstone => OutcomeRef::Tombstone,
                Projection::Recovery { reason, .. } => OutcomeRef::Recovery {
                    reason: reason.clone(),
                },
                Projection::Normal { path } => {
                    let pending = context.pending_ancestors(entry)?;
                    if !pending.is_empty() {
                        OutcomeRef::Pending {
                            reason: PendingReason::CausalDependencies { events: pending },
                        }
                    } else {
                        match context.content(id, &mut text_budget)? {
                            Err(reason) => OutcomeRef::Pending { reason },
                            Ok(content) => OutcomeRef::Normal {
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
        output.push(EntryMaterializationRef {
            identity: identity.clone(),
            outcome,
        });
    }
    Ok(output)
}

#[cfg(test)]
#[path = "reference_materialization_tests.rs"]
mod tests;
