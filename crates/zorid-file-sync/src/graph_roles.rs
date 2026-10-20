//! Compatibility of checked claims at one ID, not a whole-graph proof.
//!
//! Hosts must supply the complete same-ID claim readset from ledger-bound
//! sources. Causality, membership, transactions and durable publication remain
//! separate gates. No whole-vault map or deserialized authority is constructed.
use crate::{
    graph_facts::{Event, RoleClaim, SourceFacts, SourceKind},
    v2, ChunkRef, EntryIdentity, Error, PageRef, Result, Scope,
};
use zorid_core::EntryId;
use zorid_sync_protocol::UpdateId;

/// An immutable claim selected from a checked source, retaining its evidence.
#[derive(Debug, Clone, Copy)]
pub struct Claim<'a> {
    source: &'a SourceFacts,
    ordinal: usize,
}
impl<'a> Claim<'a> {
    pub fn at(source: &'a SourceFacts, ordinal: usize) -> Result<Self> {
        source.claims().get(ordinal).ok_or(Error::InvalidState)?;
        Ok(Self { source, ordinal })
    }
    pub fn source(&self) -> &'a SourceFacts {
        self.source
    }
    pub fn ordinal(&self) -> usize {
        self.ordinal
    }
    pub fn claim(&self) -> &'a RoleClaim {
        &self.source.claims()[self.ordinal]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    Event(EntryIdentity),
    Page,
    Chunk,
    Envelope,
    TextBootstrap(EntryId),
}

/// Compatibility of the supplied evidence only; not a finalization capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleState {
    role: Option<Role>,
    occupied: bool,
    expected_page: Option<PageRef>,
    expected_chunk: Option<ChunkRef>,
}
impl RoleState {
    pub fn role(&self) -> Option<&Role> {
        self.role.as_ref()
    }
    pub fn occupied(&self) -> bool {
        self.occupied
    }
    pub fn expected_page(&self) -> Option<&PageRef> {
        self.expected_page.as_ref()
    }
    pub fn expected_chunk(&self) -> Option<&ChunkRef> {
        self.expected_chunk.as_ref()
    }
}

/// Reduce indexed existing claims and incoming claims at exactly one ID. Role
/// promotion is deferred until both iterators end, independently of input order.
pub fn reduce<'a>(
    scope: &Scope,
    id: &UpdateId,
    existing: impl IntoIterator<Item = Claim<'a>>,
    incoming: impl IntoIterator<Item = Claim<'a>>,
) -> Result<RoleState> {
    let mut reducer = RoleReducer::new(scope, id);
    for checked in existing.into_iter().chain(incoming) {
        reducer.push(checked)?;
    }
    reducer.finish()
}

/// Streaming, candidate-only compatibility reduction. Each source can be
/// dropped immediately after `push`; only bounded owned summaries remain.
/// Every push error permanently poisons this reducer, including scope/ID errors.
pub struct RoleReducer {
    scope: Scope,
    id: UpdateId,
    state: Accumulator,
    failure: Option<Error>,
}
impl RoleReducer {
    pub fn new(scope: &Scope, id: &UpdateId) -> Self {
        Self {
            scope: scope.clone(),
            id: id.clone(),
            state: Accumulator::default(),
            failure: None,
        }
    }
    pub fn push(&mut self, checked: Claim<'_>) -> Result<()> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = if checked.source.scope() != &self.scope {
            Err(Error::IdentityMismatch)
        } else if checked.claim().id() != &self.id {
            Err(Error::InvalidState)
        } else {
            self.state.push(&self.id, checked)
        };
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result
    }
    pub fn finish(self) -> Result<RoleState> {
        match self.failure {
            Some(error) => Err(error),
            None => self.state.finish(&self.id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Envelope {
    kind: SourceKind,
    page: Option<PageRef>,
    chunk: Option<ChunkRef>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct ActualEvent {
    source_id: UpdateId,
    ordinal: u32,
    event: Event,
    identity: EntryIdentity,
}
impl ActualEvent {
    fn is_create(&self) -> bool {
        matches!(
            &self.event,
            Event::File(v2::EntryEvent {
                effect: v2::Effect::Create { .. },
                ..
            })
        )
    }
    fn text_create_root(&self) -> Option<&UpdateId> {
        match &self.event {
            Event::File(v2::EntryEvent {
                effect:
                    v2::Effect::Create {
                        content:
                            Some(v2::ContentSeed::Text {
                                text_bootstrap_id, ..
                            }),
                        ..
                    },
                ..
            }) => Some(text_bootstrap_id),
            _ => None,
        }
    }
}
#[derive(Default)]
struct Accumulator {
    envelope: Option<Envelope>,
    actual: Option<ActualEvent>,
    expected_event: Option<EntryIdentity>,
    owner: Option<EntryId>,
    namespace_root: bool,
    text_root: bool,
    parent: bool,
    expected_page: Option<PageRef>,
    expected_chunk: Option<ChunkRef>,
}
impl Accumulator {
    fn expect_event(&mut self, identity: &EntryIdentity) -> Result<()> {
        if self
            .expected_event
            .as_ref()
            .is_some_and(|prior| prior != identity)
        {
            return Err(Error::IdentityMismatch);
        }
        self.expected_event = Some(identity.clone());
        Ok(())
    }
    fn bind_owner(&mut self, entry_id: &EntryId) -> Result<()> {
        if self.owner.as_ref().is_some_and(|prior| prior != entry_id) {
            return Err(Error::IdentityMismatch);
        }
        self.owner = Some(entry_id.clone());
        Ok(())
    }
    fn push(&mut self, id: &UpdateId, checked: Claim<'_>) -> Result<()> {
        let source = checked.source;
        match checked.claim() {
            RoleClaim::Envelope { kind, .. } => {
                let envelope = Envelope {
                    kind: *kind,
                    page: source
                        .page()
                        .map(|page| page.reference(id.clone()))
                        .transpose()?,
                    chunk: source.chunk().map(|chunk| ChunkRef {
                        id: id.clone(),
                        bytes: chunk.bytes(),
                        digest: *chunk.digest(),
                    }),
                };
                if self
                    .envelope
                    .as_ref()
                    .is_some_and(|prior| prior != &envelope)
                {
                    return Err(Error::DuplicateMismatch);
                }
                self.envelope = Some(envelope);
            }
            RoleClaim::EventIdentity { identity, .. } => {
                let event = source
                    .events()
                    .iter()
                    .find(|event| event.id() == id && event.identity() == identity)
                    .ok_or(Error::InvalidState)?;
                let actual = ActualEvent {
                    source_id: source.source_id().clone(),
                    ordinal: event.ordinal(),
                    event: event.event().clone(),
                    identity: identity.clone(),
                };
                if self.actual.as_ref().is_some_and(|prior| prior != &actual) {
                    return Err(Error::DuplicateMismatch);
                }
                self.actual = Some(actual);
                self.expect_event(identity)?;
            }
            RoleClaim::NamespaceBootstrapOwner { entry_id, .. } => {
                self.bind_owner(entry_id)?;
                self.namespace_root = true;
                self.expect_event(&EntryIdentity {
                    entry_id: entry_id.clone(),
                    bootstrap_id: id.clone(),
                })?;
            }
            RoleClaim::TextBootstrapOwner { entry_id, .. } => {
                self.bind_owner(entry_id)?;
                self.text_root = true;
            }
            RoleClaim::ParentExpectedIdentity { identity, .. } => {
                self.parent = true;
                // Complete MetadataState reserves unresolved parent identities
                // immediately, even before an actual parent is present.
                self.expect_event(identity)?;
            }
            RoleClaim::PageReference { reference } => {
                if self
                    .expected_page
                    .as_ref()
                    .is_some_and(|prior| prior != reference)
                {
                    return Err(Error::InvalidContent);
                }
                self.expected_page = Some(reference.clone());
            }
            RoleClaim::ChunkReference { reference } => {
                if self
                    .expected_chunk
                    .as_ref()
                    .is_some_and(|prior| prior != reference)
                {
                    return Err(Error::InvalidContent);
                }
                self.expected_chunk = Some(reference.clone());
            }
        }
        Ok(())
    }
    fn finish(self, id: &UpdateId) -> Result<RoleState> {
        if let (Some(envelope), Some(actual)) = (&self.envelope, &self.actual) {
            let same_owner = actual.source_id == *id;
            let compatible = match (&actual.event, envelope.kind) {
                (Event::File(_), SourceKind::Events) => same_owner,
                (Event::Text(_), SourceKind::Text) => same_owner,
                _ => false,
            };
            if !compatible {
                return Err(Error::DuplicateMismatch);
            }
        }
        if let Some(owner) = &self.owner {
            if self
                .envelope
                .as_ref()
                .is_some_and(|envelope| envelope.kind != SourceKind::Text)
                && !self
                    .actual
                    .as_ref()
                    .is_some_and(|actual| actual.source_id == *id && actual.is_create())
            {
                return Err(Error::IdentityMismatch);
            }
            if let Some(actual) = &self.actual {
                if actual.identity.entry_id != *owner
                    || actual.identity.bootstrap_id != *id
                    || !actual.is_create()
                {
                    return Err(Error::IdentityMismatch);
                }
                if self.text_root && actual.text_create_root() != Some(id) {
                    return Err(Error::IdentityMismatch);
                }
            }
        }
        if self.parent
            && self.actual.is_none()
            && (self
                .envelope
                .as_ref()
                .is_some_and(|envelope| envelope.kind != SourceKind::Text)
                || (self.text_root && !self.namespace_root))
        {
            return Err(Error::InvalidCausality);
        }

        let mut role = None;
        if let Some(identity) = &self.expected_event {
            reserve(&mut role, Role::Event(identity.clone()))?;
        }
        if self.text_root && !self.namespace_root {
            reserve(
                &mut role,
                Role::TextBootstrap(self.owner.clone().ok_or(Error::InvalidState)?),
            )?;
        }
        if let Some(envelope) = &self.envelope {
            let envelope_role = match envelope.kind {
                SourceKind::Events => self
                    .actual
                    .as_ref()
                    .map(|actual| Role::Event(actual.identity.clone()))
                    .unwrap_or(Role::Envelope),
                SourceKind::Text => Role::Event(
                    self.actual
                        .as_ref()
                        .ok_or(Error::InvalidState)?
                        .identity
                        .clone(),
                ),
                SourceKind::Page => Role::Page,
                SourceKind::Chunk => Role::Chunk,
            };
            reserve(&mut role, envelope_role)?;
        }
        if let Some(expected) = &self.expected_page {
            reserve(&mut role, Role::Page)?;
            if let Some(envelope) = &self.envelope {
                if envelope.page.as_ref() != Some(expected) {
                    return Err(Error::InvalidContent);
                }
            }
        }
        if let Some(expected) = &self.expected_chunk {
            reserve(&mut role, Role::Chunk)?;
            if let Some(envelope) = &self.envelope {
                if envelope.chunk.as_ref() != Some(expected) {
                    return Err(Error::InvalidContent);
                }
            }
        }
        Ok(RoleState {
            role,
            occupied: self.envelope.is_some() || self.actual.is_some(),
            expected_page: self.expected_page,
            expected_chunk: self.expected_chunk,
        })
    }
}
fn reserve(prior: &mut Option<Role>, next: Role) -> Result<()> {
    if prior.as_ref().is_some_and(|value| value != &next) {
        return Err(
            if matches!(
                (prior.as_ref(), &next),
                (Some(Role::Event(_)), Role::Event(_))
            ) {
                Error::IdentityMismatch
            } else {
                Error::InvalidContent
            },
        );
    }
    *prior = Some(next);
    Ok(())
}

#[cfg(test)]
#[path = "graph_roles_tests.rs"]
mod tests;
