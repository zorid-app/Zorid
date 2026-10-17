//! File-v2 explicitly binds text content to its immutable text bootstrap.
//! Legacy v1 remains available at the crate root; there is no trial decoding or
//! automatic upgrade. Current fresh-fixture ingestion requires v2; obsolete v1
//! payloads are explicitly unsupported and cannot acquire an invented frontier.
use super::{
    EntryIdentity, Error, Family, GraphEffect, GraphEvent, Location, Manifest, Result, Scope,
    Sha256Digest, WireRecord,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zorid_client_sync::{v2::TextActivity, TextIdentity};
use zorid_core::{EntryId, EntryKind, Revision};
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_sync_protocol::{ExpectedContext, UpdateId, MAX_PLAINTEXT_BYTES};

pub const FORMAT_VERSION: u32 = 2;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextBinding {
    pub text_bootstrap_id: UpdateId,
    pub text_format: u32,
}
impl TextBinding {
    fn validate(&self) -> Result<()> {
        if self.text_format != zorid_client_sync::v2::TEXT_FORMAT_VERSION {
            return Err(Error::UnsupportedFormat);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentSeed {
    Binary {
        manifest: Manifest,
    },
    Text {
        text_bootstrap_id: UpdateId,
        text_format: u32,
    },
}
/// Immutable mode/binding only. Current binary bytes come from namespace
/// EntryView.contents, never the original Create seed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentBinding {
    Binary,
    Text {
        text_bootstrap_id: UpdateId,
        text_format: u32,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Effect {
    Create {
        entry_kind: EntryKind,
        location: Location,
        content: Option<ContentSeed>,
    },
    SetContent {
        content: Manifest,
    },
    Move {
        location: Location,
    },
    Delete,
    Restore {
        location: Location,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryEvent {
    pub id: UpdateId,
    pub identity: EntryIdentity,
    pub parents: Vec<UpdateId>,
    pub effect: Effect,
}
fn parents(id: &UpdateId, values: &[UpdateId], create: bool) -> Result<()> {
    if values.len() > super::MAX_PARENTS {
        return Err(Error::TooLarge);
    }
    let unique: BTreeSet<_> = values.iter().collect();
    if unique.len() != values.len() || unique.contains(id) || (create != values.is_empty()) {
        return Err(Error::InvalidCausality);
    }
    Ok(())
}
impl EntryEvent {
    pub(super) fn graph(&self) -> Result<GraphEvent> {
        let create = matches!(self.effect, Effect::Create { .. });
        parents(&self.id, &self.parents, create)?;
        if create != (self.id == self.identity.bootstrap_id) {
            return Err(Error::InvalidCausality);
        }
        let effect = match &self.effect {
            Effect::Create {
                entry_kind,
                location,
                content,
            } => {
                location.validate()?;
                match (entry_kind, content) {
                    (EntryKind::Folder, None) => GraphEffect::Create {
                        entry_kind: *entry_kind,
                        location: location.clone(),
                        content: None,
                    },
                    (EntryKind::File, Some(ContentSeed::Binary { manifest })) => {
                        manifest.validate()?;
                        GraphEffect::Create {
                            entry_kind: *entry_kind,
                            location: location.clone(),
                            content: Some(manifest.clone()),
                        }
                    }
                    (
                        EntryKind::File,
                        Some(ContentSeed::Text {
                            text_bootstrap_id,
                            text_format,
                        }),
                    ) => {
                        let binding = TextBinding {
                            text_bootstrap_id: text_bootstrap_id.clone(),
                            text_format: *text_format,
                        };
                        binding.validate()?;
                        GraphEffect::CreateText {
                            location: location.clone(),
                            binding,
                        }
                    }
                    _ => return Err(Error::InvalidContent),
                }
            }
            Effect::SetContent { content } => {
                content.validate()?;
                GraphEffect::SetContent {
                    content: content.clone(),
                }
            }
            Effect::Move { location } => {
                location.validate()?;
                GraphEffect::Move {
                    location: location.clone(),
                }
            }
            Effect::Delete => GraphEffect::Delete,
            Effect::Restore { location } => {
                location.validate()?;
                GraphEffect::Restore {
                    location: location.clone(),
                }
            }
        };
        Ok(GraphEvent {
            id: self.id.clone(),
            identity: self.identity.clone(),
            parents: self.parents.clone(),
            effect,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Body {
    Events { events: Vec<EntryEvent> },
    ObservedDelete { events: Vec<EntryEvent> },
    Page { page: super::ChunkPage },
    Chunk { bytes: Vec<u8> },
}
impl Body {
    fn events(&self) -> &[EntryEvent] {
        match self {
            Self::Events { events } | Self::ObservedDelete { events } => events,
            _ => &[],
        }
    }
    pub(super) fn validate(&self) -> Result<()> {
        match self {
            Self::Events { events } | Self::ObservedDelete { events } => {
                if events.is_empty() || events.len() > super::MAX_BATCH_EVENTS {
                    return Err(Error::TooLarge);
                }
                let mut ids = BTreeSet::new();
                let mut entries = BTreeSet::new();
                for event in events {
                    event.graph()?;
                    if !ids.insert(&event.id) {
                        return Err(Error::DuplicateMismatch);
                    }
                    if matches!(self, Self::ObservedDelete { .. })
                        && (!matches!(event.effect, Effect::Delete)
                            || !entries.insert(&event.identity.entry_id))
                    {
                        return Err(Error::InvalidPayload);
                    }
                }
            }
            Self::Page { page } => {
                page.validate()?;
            }
            Self::Chunk { bytes } => {
                if bytes.is_empty() || bytes.len() > super::MAX_CHUNK_BYTES {
                    return Err(Error::TooLarge);
                }
            }
        };
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub family: Family,
    pub format_version: u32,
    pub scope: Scope,
    pub id: UpdateId,
    pub body: Body,
}
impl Payload {
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.format_version != FORMAT_VERSION {
            return Err(Error::UnsupportedFormat);
        }
        self.body.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::InvalidPayload)?;
        if bytes.len() > MAX_PLAINTEXT_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_PLAINTEXT_BYTES {
            return Err(Error::TooLarge);
        }
        #[derive(Deserialize)]
        struct Routing {
            family: Option<String>,
            format_version: Option<u32>,
        }
        let routing: Routing = serde_json::from_slice(bytes).map_err(|_| Error::InvalidPayload)?;
        if routing.family.as_deref() != Some("files")
            || routing.format_version != Some(FORMAT_VERSION)
        {
            return Err(Error::UnsupportedFormat);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| Error::InvalidPayload)?;
        value.encode()?;
        Ok(value)
    }
}
/// Trusted persistence metadata, NOT an authentication capability. A host must
/// restore this only from its immutable ledger, cross-checking plaintext digest
/// and scope against that ledger. Fresh ingestion requires TextActivity below.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredActivity {
    identity: TextIdentity,
    update_id: UpdateId,
    namespace: zorid_client_sync::v2::TextNamespaceContext,
    payload_digest: Sha256Digest,
    payload_bytes: u32,
}
impl StoredActivity {
    pub fn identity(&self) -> &TextIdentity {
        &self.identity
    }
    pub fn update_id(&self) -> &UpdateId {
        &self.update_id
    }
    pub fn namespace(&self) -> &zorid_client_sync::v2::TextNamespaceContext {
        &self.namespace
    }
    pub fn payload_digest(&self) -> &Sha256Digest {
        &self.payload_digest
    }
    pub fn payload_bytes(&self) -> u32 {
        self.payload_bytes
    }
    fn from_activity(a: &TextActivity) -> Result<Self> {
        let size = a.payload_bytes().len();
        if size == 0 || size > MAX_PLAINTEXT_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            identity: a.identity().clone(),
            update_id: a.update_id().clone(),
            namespace: a.namespace().clone(),
            payload_digest: Sha256Digest::of(a.payload_bytes()),
            payload_bytes: size as u32,
        })
    }
    pub(super) fn graph(&self, scope: &Scope) -> Result<GraphEvent> {
        if self.identity.realm_id != scope.realm_id || self.identity.vault_id != scope.vault_id {
            return Err(Error::IdentityMismatch);
        }
        if self.payload_bytes == 0 || self.payload_bytes as usize > MAX_PLAINTEXT_BYTES {
            return Err(Error::TooLarge);
        }
        parents(&self.update_id, &self.namespace.parents, false)?;
        if self.namespace.parents.windows(2).any(|p| p[0] >= p[1]) {
            return Err(Error::InvalidCausality);
        }
        if self.update_id == self.namespace.bootstrap_id
            || self.update_id == self.identity.bootstrap_id
        {
            return Err(Error::InvalidCausality);
        }
        Ok(GraphEvent {
            id: self.update_id.clone(),
            identity: EntryIdentity {
                entry_id: self.identity.entry_id.clone(),
                bootstrap_id: self.namespace.bootstrap_id.clone(),
            },
            parents: self.namespace.parents.clone(),
            effect: GraphEffect::TextActivity {
                binding: TextBinding {
                    text_bootstrap_id: self.identity.bootstrap_id.clone(),
                    text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
                },
            },
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    scope: Scope,
    version: Revision,
    records: BTreeMap<UpdateId, Payload>,
    activities: BTreeMap<UpdateId, StoredActivity>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultView {
    pub namespace: super::VaultView,
    pub content_bindings: BTreeMap<EntryId, ContentBinding>,
}
impl State {
    pub fn empty(scope: Scope, version: Revision) -> Self {
        Self {
            scope,
            version,
            records: BTreeMap::new(),
            activities: BTreeMap::new(),
        }
    }
    pub fn from_records(
        scope: Scope,
        version: Revision,
        records: BTreeMap<UpdateId, Payload>,
        activities: BTreeMap<UpdateId, StoredActivity>,
    ) -> Result<Self> {
        let state = Self {
            scope,
            version,
            records,
            activities,
        };
        state.view()?;
        Ok(state)
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn version(&self) -> &Revision {
        &self.version
    }
    pub fn records(&self) -> &BTreeMap<UpdateId, Payload> {
        &self.records
    }
    pub fn activities(&self) -> &BTreeMap<UpdateId, StoredActivity> {
        &self.activities
    }
    fn binary_records(&self) -> super::State {
        let records = self
            .records
            .iter()
            .filter_map(|(id, p)| {
                let body = match &p.body {
                    Body::Chunk { bytes } => super::Body::Chunk {
                        bytes: bytes.clone(),
                    },
                    Body::Page { page } => super::Body::Page { page: page.clone() },
                    _ => return None,
                };
                Some((
                    id.clone(),
                    super::Payload {
                        family: Family::Files,
                        format_version: super::FORMAT_VERSION,
                        scope: p.scope.clone(),
                        id: id.clone(),
                        body,
                    },
                ))
            })
            .collect();
        super::State {
            scope: self.scope.clone(),
            version: self.version.clone(),
            records,
        }
    }
    pub fn view(&self) -> Result<VaultView> {
        self.view_and_ancestry().map(|(view, _)| view)
    }
    pub(super) fn view_and_ancestry(&self) -> Result<(VaultView, super::GraphAncestry)> {
        let metadata = crate::metadata::MetadataState::from_legacy(self)?;
        let (events, mut content_bindings) = metadata.legacy_graph_inputs()?;
        let (namespace, ancestry) =
            super::derive_graph_with_ancestry(&self.binary_records(), events)?;
        content_bindings.retain(|id, _| namespace.entries.contains_key(id));
        Ok((
            VaultView {
                namespace,
                content_bindings,
            },
            ancestry,
        ))
    }
    pub fn materialize(&self, manifest: &Manifest) -> Result<Option<Vec<u8>>> {
        self.view()?;
        self.binary_records().materialize(manifest)
    }
}

pub struct AuthenticatedPayload {
    payload: Payload,
    payload_bytes: Vec<u8>,
    record: WireRecord,
}
impl AuthenticatedPayload {
    pub fn open(wire: &[u8], expected: &ExpectedContext, key: &VaultKey) -> Result<Self> {
        let opened =
            OpenedEnvelope::open(wire, expected, key).map_err(|_| Error::AuthenticationFailed)?;
        Self::from_opened(&opened)
    }
    pub fn from_opened(opened: &OpenedEnvelope) -> Result<Self> {
        let payload = Payload::decode(opened.plaintext())?;
        let h = opened.header();
        if &payload.scope.realm_id != h.realm_id()
            || &payload.scope.vault_id != h.vault_id()
            || &payload.id != h.update_id()
        {
            return Err(Error::IdentityMismatch);
        }
        let record = WireRecord {
            scope: payload.scope.clone(),
            id: payload.id.clone(),
            exact_wire: opened.envelope().encode(),
        };
        Ok(Self {
            payload,
            payload_bytes: opened.plaintext().to_vec(),
            record,
        })
    }
    pub fn payload(&self) -> &Payload {
        &self.payload
    }
    /// Exact authenticated plaintext, not re-encoded canonical JSON.
    pub fn payload_bytes(&self) -> &[u8] {
        &self.payload_bytes
    }
    pub fn record(&self) -> &WireRecord {
        &self.record
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePlan {
    pub expected_state: State,
    pub next_state: Option<State>,
    pub view: VaultView,
}
impl FilePlan {
    pub fn check_preconditions(&self, actual: &State) -> Result<()> {
        if actual != &self.expected_state {
            return Err(Error::VersionConflict);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoredPlan {
    pub graph: FilePlan,
    pub payload: Payload,
    pub payload_bytes: Vec<u8>,
}
impl AuthoredPlan {
    pub fn check_preconditions(&self, actual: &State, identity_unused: bool) -> Result<()> {
        self.graph.check_preconditions(actual)?;
        if !identity_unused {
            return Err(Error::DuplicateMismatch);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedPlan {
    pub graph: FilePlan,
    pub expected_record: Option<WireRecord>,
    pub received_record: WireRecord,
}
impl ReceivedPlan {
    pub fn check_preconditions(&self, actual: &State, record: Option<&WireRecord>) -> Result<()> {
        self.graph.check_preconditions(actual)?;
        if record != self.expected_record.as_ref() {
            return Err(Error::DuplicateMismatch);
        }
        Ok(())
    }
}
fn insert(state: &State, payload: &Payload, next_version: Revision) -> Result<State> {
    if state.scope != payload.scope {
        return Err(Error::IdentityMismatch);
    }
    if state.version == next_version {
        return Err(Error::VersionConflict);
    }
    if state.records.contains_key(&payload.id) || state.activities.contains_key(&payload.id) {
        return Err(Error::DuplicateMismatch);
    }
    payload.encode()?;
    let mut next = state.clone();
    next.version = next_version;
    next.records.insert(payload.id.clone(), payload.clone());
    Ok(next)
}
pub fn plan_authored(
    state: &State,
    payload: &Payload,
    next_version: Revision,
) -> Result<AuthoredPlan> {
    state.view()?;
    let next = insert(state, payload, next_version)?;
    let view = next.view()?;
    if payload
        .body
        .events()
        .iter()
        .any(|e| view.namespace.pending.contains(&e.id))
    {
        return Err(Error::InvalidCausality);
    }
    Ok(AuthoredPlan {
        graph: FilePlan {
            expected_state: state.clone(),
            next_state: Some(next),
            view,
        },
        payload: payload.clone(),
        payload_bytes: payload.encode()?,
    })
}
pub fn plan_received(
    state: &State,
    incoming: &AuthenticatedPayload,
    prior: Option<&WireRecord>,
    next_version: Revision,
) -> Result<ReceivedPlan> {
    let view = state.view()?;
    if state.scope != incoming.payload.scope {
        return Err(Error::IdentityMismatch);
    }
    let graph = if let Some(prior) = prior {
        if prior != &incoming.record {
            return Err(Error::DuplicateMismatch);
        }
        if state.records.get(&incoming.payload.id) != Some(&incoming.payload) {
            return Err(Error::InvalidState);
        }
        FilePlan {
            expected_state: state.clone(),
            next_state: None,
            view,
        }
    } else {
        let next = insert(state, &incoming.payload, next_version)?;
        let view = next.view()?;
        FilePlan {
            expected_state: state.clone(),
            next_state: Some(next),
            view,
        }
    };
    Ok(ReceivedPlan {
        graph,
        expected_record: prior.cloned(),
        received_record: incoming.record.clone(),
    })
}
/// This graph-only plan must commit together with the original text plan and
/// exact shared wire record. It creates no authored payload, receipt or outbox.
/// Host wire-ledger checks still distinguish same-plaintext changed-nonce reuse.
pub fn plan_received_text_activity(
    state: &State,
    activity: &TextActivity,
    next_version: Revision,
) -> Result<FilePlan> {
    let view = state.view()?;
    let stored = StoredActivity::from_activity(activity)?;
    stored.graph(&state.scope)?;
    if state.records.contains_key(&stored.update_id) {
        return Err(Error::DuplicateMismatch);
    }
    if let Some(prior) = state.activities.get(&stored.update_id) {
        if prior != &stored {
            return Err(Error::DuplicateMismatch);
        }
        return Ok(FilePlan {
            expected_state: state.clone(),
            next_state: None,
            view,
        });
    }
    if state.version == next_version {
        return Err(Error::VersionConflict);
    }
    let mut next = state.clone();
    next.version = next_version;
    next.activities.insert(stored.update_id.clone(), stored);
    let view = next.view()?;
    Ok(FilePlan {
        expected_state: state.clone(),
        next_state: Some(next),
        view,
    })
}
pub fn plan_authored_text_activity(
    state: &State,
    activity: &TextActivity,
    next_version: Revision,
) -> Result<FilePlan> {
    let plan = plan_received_text_activity(state, activity, next_version)?;
    if plan.next_state.is_none() {
        return Err(Error::DuplicateMismatch);
    }
    if plan.view.namespace.pending.contains(activity.update_id()) {
        return Err(Error::InvalidCausality);
    }
    Ok(plan)
}
#[cfg(test)]
mod tests;

mod frontier;
mod retained;
