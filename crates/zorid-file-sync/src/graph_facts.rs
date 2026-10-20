//! Bounded facts from one metadata source, without whole-graph authority.
//!
//! File descriptors do not carry their ledger scope or source ID. Their labels
//! here are supplied by the caller, which must independently bind them to its
//! immutable ledger. Facts are neither authentication nor a finalized plan.
use crate::{
    metadata::{GraphRecord, GraphRecordBody},
    v2, ChunkPage, ChunkRef, EntryIdentity, Error, PageRef, Result, Scope, Sha256Digest,
};
use serde::Serialize;
use zorid_core::EntryId;
use zorid_sync_protocol::UpdateId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Events,
    Page,
    Chunk,
    Text,
}

/// Raw roles, including aliases. Compatibility with roles from other sources
/// remains a global validation responsibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum RoleClaim {
    Envelope {
        id: UpdateId,
        kind: SourceKind,
    },
    EventIdentity {
        id: UpdateId,
        identity: EntryIdentity,
    },
    NamespaceBootstrapOwner {
        id: UpdateId,
        entry_id: EntryId,
    },
    TextBootstrapOwner {
        id: UpdateId,
        entry_id: EntryId,
    },
    ParentExpectedIdentity {
        id: UpdateId,
        identity: EntryIdentity,
    },
    PageReference {
        reference: PageRef,
    },
    ChunkReference {
        reference: ChunkRef,
    },
}
impl RoleClaim {
    pub fn id(&self) -> &UpdateId {
        match self {
            Self::Envelope { id, .. }
            | Self::EventIdentity { id, .. }
            | Self::NamespaceBootstrapOwner { id, .. }
            | Self::TextBootstrapOwner { id, .. }
            | Self::ParentExpectedIdentity { id, .. } => id,
            Self::PageReference { reference } => &reference.id,
            Self::ChunkReference { reference } => &reference.id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Event {
    File(v2::EntryEvent),
    Text(v2::StoredActivity),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceEvent {
    ordinal: u32,
    identity: EntryIdentity,
    event: Event,
}
impl SourceEvent {
    pub fn ordinal(&self) -> u32 {
        self.ordinal
    }
    pub fn event(&self) -> &Event {
        &self.event
    }
    pub fn identity(&self) -> &EntryIdentity {
        &self.identity
    }
    pub fn id(&self) -> &UpdateId {
        match &self.event {
            Event::File(event) => &event.id,
            Event::Text(activity) => activity.update_id(),
        }
    }
    pub fn parents(&self) -> &[UpdateId] {
        match &self.event {
            Event::File(event) => &event.parents,
            Event::Text(activity) => &activity.namespace().parents,
        }
    }
    /// Immutable binding introduced by a namespace Create, if any.
    pub fn content_binding(&self) -> Option<v2::ContentBinding> {
        match &self.event {
            Event::File(v2::EntryEvent {
                effect:
                    v2::Effect::Create {
                        content: Some(seed),
                        ..
                    },
                ..
            }) => Some(match seed {
                v2::ContentSeed::Binary { .. } => v2::ContentBinding::Binary,
                v2::ContentSeed::Text {
                    text_bootstrap_id,
                    text_format,
                } => v2::ContentBinding::Text {
                    text_bootstrap_id: text_bootstrap_id.clone(),
                    text_format: *text_format,
                },
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChunkMetadata {
    bytes: u32,
    digest: Sha256Digest,
}
impl ChunkMetadata {
    pub fn bytes(&self) -> u32 {
        self.bytes
    }
    pub fn digest(&self) -> &Sha256Digest {
        &self.digest
    }
}

/// Constructed only through bounded per-source validation. It deliberately has
/// no deserializer or whole-graph/finalization capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceFacts {
    scope: Scope,
    source_id: UpdateId,
    kind: SourceKind,
    observed_delete: bool,
    events: Vec<SourceEvent>,
    claims: Vec<RoleClaim>,
    page: Option<ChunkPage>,
    chunk: Option<ChunkMetadata>,
}
impl SourceFacts {
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn source_id(&self) -> &UpdateId {
        &self.source_id
    }
    pub fn kind(&self) -> SourceKind {
        self.kind
    }
    pub fn observed_delete(&self) -> bool {
        self.observed_delete
    }
    pub fn events(&self) -> &[SourceEvent] {
        &self.events
    }
    pub fn claims(&self) -> &[RoleClaim] {
        &self.claims
    }
    pub fn page(&self) -> Option<&ChunkPage> {
        self.page.as_ref()
    }
    pub fn chunk(&self) -> Option<&ChunkMetadata> {
        self.chunk.as_ref()
    }

    /// `scope` and `source_id` are caller labels, not checked descriptor fields.
    pub fn file(scope: &Scope, source_id: &UpdateId, record: &GraphRecord) -> Result<Self> {
        let kind = match record.body() {
            GraphRecordBody::Events { .. } | GraphRecordBody::ObservedDelete { .. } => {
                SourceKind::Events
            }
            GraphRecordBody::Page { .. } => SourceKind::Page,
            GraphRecordBody::Chunk { .. } => SourceKind::Chunk,
        };
        let mut facts = Self::empty(scope, source_id, kind);
        match record.body() {
            GraphRecordBody::Events { events } | GraphRecordBody::ObservedDelete { events } => {
                // This also preserves the envelope's bounded duplicate/delete rules.
                facts.observed_delete =
                    matches!(record.body(), GraphRecordBody::ObservedDelete { .. });
                let body = if facts.observed_delete {
                    v2::Body::ObservedDelete {
                        events: events.clone(),
                    }
                } else {
                    v2::Body::Events {
                        events: events.clone(),
                    }
                };
                body.validate()?;
                for (ordinal, event) in events.iter().enumerate() {
                    facts.push_event(SourceEvent {
                        ordinal: ordinal as u32,
                        identity: event.identity.clone(),
                        event: Event::File(event.clone()),
                    });
                    match &event.effect {
                        v2::Effect::Create {
                            content:
                                Some(v2::ContentSeed::Text {
                                    text_bootstrap_id, ..
                                }),
                            ..
                        } => {
                            facts.claims.push(RoleClaim::TextBootstrapOwner {
                                id: text_bootstrap_id.clone(),
                                entry_id: event.identity.entry_id.clone(),
                            });
                        }
                        v2::Effect::Create {
                            content: Some(v2::ContentSeed::Binary { manifest }),
                            ..
                        }
                        | v2::Effect::SetContent { content: manifest } => {
                            for reference in &manifest.pages {
                                facts.claims.push(RoleClaim::PageReference {
                                    reference: reference.clone(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            GraphRecordBody::Page { page } => {
                page.validate()?;
                for reference in &page.chunks {
                    facts.claims.push(RoleClaim::ChunkReference {
                        reference: reference.clone(),
                    });
                }
                facts.page = Some(page.clone());
            }
            GraphRecordBody::Chunk { bytes, digest } => {
                if *bytes == 0 || *bytes as usize > crate::MAX_CHUNK_BYTES {
                    return Err(Error::TooLarge);
                }
                facts.chunk = Some(ChunkMetadata {
                    bytes: *bytes,
                    digest: *digest,
                });
            }
        }
        Ok(facts)
    }

    pub fn text(scope: &Scope, activity: &v2::StoredActivity) -> Result<Self> {
        let graph = activity.graph(scope)?;
        let mut facts = Self::empty(scope, activity.update_id(), SourceKind::Text);
        facts.push_event(SourceEvent {
            ordinal: 0,
            identity: graph.identity,
            event: Event::Text(activity.clone()),
        });
        facts.claims.push(RoleClaim::TextBootstrapOwner {
            id: activity.identity().bootstrap_id.clone(),
            entry_id: activity.identity().entry_id.clone(),
        });
        Ok(facts)
    }

    fn empty(scope: &Scope, source_id: &UpdateId, kind: SourceKind) -> Self {
        Self {
            scope: scope.clone(),
            source_id: source_id.clone(),
            kind,
            observed_delete: false,
            events: Vec::new(),
            claims: vec![RoleClaim::Envelope {
                id: source_id.clone(),
                kind,
            }],
            page: None,
            chunk: None,
        }
    }

    fn push_event(&mut self, event: SourceEvent) {
        self.claims.push(RoleClaim::EventIdentity {
            id: event.id().clone(),
            identity: event.identity.clone(),
        });
        self.claims.push(RoleClaim::NamespaceBootstrapOwner {
            id: event.identity.bootstrap_id.clone(),
            entry_id: event.identity.entry_id.clone(),
        });
        for parent in event.parents() {
            self.claims.push(RoleClaim::ParentExpectedIdentity {
                id: parent.clone(),
                identity: event.identity.clone(),
            });
        }
        self.events.push(event);
    }
}

#[cfg(test)]
#[path = "graph_facts_tests.rs"]
mod tests;
