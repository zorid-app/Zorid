//! Portable causal binary/namespace planning. Hosts own atomic persistence,
//! transport cursor accounting and recoverable filesystem projection.
//! Plans are not durable until committed; no received plan produces an outbox.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zorid_core::{EntryId, EntryKind, Revision, VaultPath};
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_sync_protocol::{
    ExpectedContext, RealmId, UpdateId, VaultId, MAX_PLAINTEXT_BYTES, MAX_WIRE_BYTES,
};

pub mod binary_stream;
pub mod binary_mutation;
pub mod external_namespace;
pub mod materialization;
pub mod metadata;
pub mod metadata_plan;
pub mod reference_materialization;
pub mod mutation;
pub mod v2;

pub const FORMAT_VERSION: u32 = 1;
pub const MAX_CHUNK_BYTES: usize = 128 * 1024;
pub const MAX_PAGE_CHUNKS: usize = 128;
pub const MAX_MANIFEST_PAGES: usize = 128;
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_RECORDS: usize = 4096;
pub const MAX_EVENTS: usize = 4096;
pub const MAX_PARENTS: usize = 128;
pub const MAX_BATCH_EVENTS: usize = 128;
pub const MAX_STATE_BYTES: usize = 128 * 1024 * 1024;
/// Per-rebuild whole-file verification work, counting identical manifests once.
pub const MAX_MANIFEST_VERIFY_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    TooLarge,
    InvalidPayload,
    InvalidState,
    UnsupportedFormat,
    IdentityMismatch,
    DuplicateMismatch,
    InvalidCausality,
    InvalidLocation,
    InvalidContent,
    VersionConflict,
    AuthenticationFailed,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub realm_id: RealmId,
    pub vault_id: VaultId,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryIdentity {
    pub entry_id: EntryId,
    pub bootstrap_id: UpdateId,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    pub parent: Option<EntryId>,
    pub name: String,
}
impl Location {
    fn validate(&self) -> Result<()> {
        if self.name.is_empty() || self.name.contains('/') || self.name.contains('\\') {
            return Err(Error::InvalidLocation);
        }
        let path = if self.parent.is_none() {
            self.name.clone()
        } else {
            format!("parent/{}", self.name)
        };
        VaultPath::new(path).map_err(|_| Error::InvalidLocation)?;
        if self.name.len() > 255 {
            return Err(Error::TooLarge);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sha256Digest(pub [u8; 32]);
impl Sha256Digest {
    pub fn of(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChunkRef {
    pub id: UpdateId,
    pub bytes: u32,
    pub digest: Sha256Digest,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChunkPage {
    pub chunks: Vec<ChunkRef>,
}
impl ChunkPage {
    pub fn reference(&self, id: UpdateId) -> Result<PageRef> {
        Ok(PageRef {
            id,
            bytes: self.validate()?,
            digest: Sha256Digest::of(&serde_json::to_vec(self).map_err(|_| Error::InvalidPayload)?),
        })
    }
    fn validate(&self) -> Result<u64> {
        if self.chunks.is_empty() || self.chunks.len() > MAX_PAGE_CHUNKS {
            return Err(Error::TooLarge);
        }
        let mut size = 0u64;
        for chunk in &self.chunks {
            if chunk.bytes == 0 || chunk.bytes as usize > MAX_CHUNK_BYTES {
                return Err(Error::InvalidContent);
            }
            size = size
                .checked_add(u64::from(chunk.bytes))
                .ok_or(Error::TooLarge)?;
        }
        Ok(size)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageRef {
    pub id: UpdateId,
    pub bytes: u64,
    pub digest: Sha256Digest,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub bytes: u64,
    pub digest: Sha256Digest,
    pub pages: Vec<PageRef>,
}
impl Manifest {
    fn validate(&self) -> Result<()> {
        if self.bytes > MAX_FILE_BYTES || self.pages.len() > MAX_MANIFEST_PAGES {
            return Err(Error::TooLarge);
        }
        let mut bytes = 0u64;
        for page in &self.pages {
            if page.bytes == 0 || page.bytes > (MAX_PAGE_CHUNKS * MAX_CHUNK_BYTES) as u64 {
                return Err(Error::InvalidContent);
            }
            bytes = bytes.checked_add(page.bytes).ok_or(Error::TooLarge)?;
        }
        if bytes != self.bytes || (self.bytes == 0 && self.digest != Sha256Digest::of(&[])) {
            return Err(Error::InvalidContent);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Effect {
    Create {
        entry_kind: EntryKind,
        location: Location,
        content: Option<Manifest>,
    },
    SetContent {
        content: Manifest,
    },
    Move {
        location: Location,
    },
    Delete,
    /// Explicitly acknowledges observed deletion and restores a chosen location.
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
impl EntryEvent {
    fn validate(&self) -> Result<()> {
        if self.parents.len() > MAX_PARENTS {
            return Err(Error::TooLarge);
        }
        let unique: BTreeSet<_> = self.parents.iter().collect();
        if unique.len() != self.parents.len() || unique.contains(&self.id) {
            return Err(Error::InvalidCausality);
        }
        match &self.effect {
            Effect::Create {
                entry_kind,
                location,
                content,
            } => {
                if self.id != self.identity.bootstrap_id || !self.parents.is_empty() {
                    return Err(Error::InvalidCausality);
                }
                location.validate()?;
                match (entry_kind, content) {
                    (EntryKind::File, Some(content)) => content.validate()?,
                    (EntryKind::Folder, None) => {}
                    _ => return Err(Error::InvalidContent),
                }
            }
            effect => {
                if self.parents.is_empty() || self.id == self.identity.bootstrap_id {
                    return Err(Error::InvalidCausality);
                }
                match effect {
                    Effect::SetContent { content } => content.validate()?,
                    Effect::Move { location } | Effect::Restore { location } => {
                        location.validate()?
                    }
                    Effect::Delete => {}
                    Effect::Create { .. } => unreachable!(),
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Body {
    Events {
        events: Vec<EntryEvent>,
    },
    /// The author lists observed IDs and their causal parents. A receiver never
    /// expands this into its current subtree. All members must be Delete events.
    ObservedDelete {
        events: Vec<EntryEvent>,
    },
    Page {
        page: ChunkPage,
    },
    Chunk {
        bytes: Vec<u8>,
    },
}
impl Body {
    fn events(&self) -> &[EntryEvent] {
        match self {
            Self::Events { events } | Self::ObservedDelete { events } => events,
            _ => &[],
        }
    }
    fn validate(&self) -> Result<()> {
        match self {
            Self::Events { events } | Self::ObservedDelete { events } => {
                if events.is_empty() || events.len() > MAX_BATCH_EVENTS {
                    return Err(Error::TooLarge);
                }
                let mut ids = BTreeSet::new();
                let mut entries = BTreeSet::new();
                for event in events {
                    event.validate()?;
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
                if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
                    return Err(Error::TooLarge);
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Family {
    Files,
}
/// Separate strict plaintext family; this does not extend the text decoder.
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
        struct Discriminator {
            #[serde(default)]
            family: Option<String>,
            #[serde(default)]
            format_version: Option<u32>,
        }
        let discriminator: Discriminator =
            serde_json::from_slice(bytes).map_err(|_| Error::InvalidPayload)?;
        if discriminator.family.as_deref() != Some("files")
            || discriminator.format_version != Some(FORMAT_VERSION)
        {
            return Err(Error::UnsupportedFormat);
        }
        let payload: Self = serde_json::from_slice(bytes).map_err(|_| Error::InvalidPayload)?;
        payload.encode()?;
        Ok(payload)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub scope: Scope,
    pub version: Revision,
    pub records: BTreeMap<UpdateId, Payload>,
}
impl State {
    pub fn empty(scope: Scope, version: Revision) -> Self {
        Self {
            scope,
            version,
            records: BTreeMap::new(),
        }
    }
    pub fn view(&self) -> Result<VaultView> {
        derive(self)
    }
    /// None means bytes are not complete; never publish a partial replacement.
    pub fn materialize(&self, manifest: &Manifest) -> Result<Option<Vec<u8>>> {
        self.view()?;
        let status = content_status(self, manifest)?;
        if !status.missing.is_empty() {
            return Ok(None);
        }
        let mut output = Vec::with_capacity(manifest.bytes as usize);
        for page in &manifest.pages {
            let Body::Page { page } = &self.records.get(&page.id).ok_or(Error::InvalidState)?.body
            else {
                return Err(Error::InvalidContent);
            };
            for chunk in &page.chunks {
                let Body::Chunk { bytes } =
                    &self.records.get(&chunk.id).ok_or(Error::InvalidState)?.body
                else {
                    return Err(Error::InvalidContent);
                };
                output.extend_from_slice(bytes);
            }
        }
        Ok(Some(output))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentStatus {
    pub missing: BTreeSet<UpdateId>,
}
fn content_status(state: &State, manifest: &Manifest) -> Result<ContentStatus> {
    manifest.validate()?;
    let mut missing = BTreeSet::new();
    let mut hash = Sha256::new();
    for reference in &manifest.pages {
        match state.records.get(&reference.id) {
            None => {
                missing.insert(reference.id.clone());
            }
            Some(payload) => {
                let Body::Page { page } = &payload.body else {
                    return Err(Error::InvalidContent);
                };
                if page.reference(reference.id.clone())? != *reference {
                    return Err(Error::InvalidContent);
                }
                for chunk in &page.chunks {
                    match state.records.get(&chunk.id) {
                        None => {
                            missing.insert(chunk.id.clone());
                        }
                        Some(payload) => {
                            let Body::Chunk { bytes } = &payload.body else {
                                return Err(Error::InvalidContent);
                            };
                            if bytes.len() != chunk.bytes as usize
                                || Sha256Digest::of(bytes) != chunk.digest
                            {
                                return Err(Error::InvalidContent);
                            }
                            hash.update(bytes);
                        }
                    }
                }
            }
        }
    }
    if missing.is_empty() && Sha256Digest(hash.finalize().into()) != manifest.digest {
        return Err(Error::InvalidContent);
    }
    Ok(ContentStatus { missing })
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentHead {
    pub event: UpdateId,
    pub manifest: Manifest,
    pub status: ContentStatus,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocationHead {
    pub event: UpdateId,
    pub location: Location,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Liveness {
    Live,
    Deleted,
    DeleteConflict,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryReason {
    DeleteConflict,
    ParentUnavailable,
    Cycle,
    NameCollision,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Projection {
    Normal {
        path: VaultPath,
    },
    Recovery {
        entry: EntryId,
        reason: RecoveryReason,
    },
    Tombstone,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryView {
    pub identity: EntryIdentity,
    pub kind: EntryKind,
    pub heads: Vec<UpdateId>,
    /// Sorted by event ID; last is the deterministic preferred display version.
    /// Every alternative remains retained and accessible, even while deleted.
    pub contents: Vec<ContentHead>,
    pub locations: Vec<LocationHead>,
    pub liveness: Liveness,
    pub projection: Projection,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultView {
    pub entries: BTreeMap<EntryId, EntryView>,
    pub pending: BTreeSet<UpdateId>,
}

fn derive(state: &State) -> Result<VaultView> {
    if state.records.len() > MAX_RECORDS {
        return Err(Error::TooLarge);
    }
    let mut size = 0usize;
    let mut events: BTreeMap<UpdateId, EntryEvent> = BTreeMap::new();
    let mut identities: BTreeMap<EntryId, EntryIdentity> = BTreeMap::new();
    for (id, payload) in &state.records {
        if id != &payload.id || payload.scope != state.scope {
            return Err(Error::InvalidState);
        }
        size = size
            .checked_add(payload.encode()?.len())
            .ok_or(Error::TooLarge)?;
        if size > MAX_STATE_BYTES {
            return Err(Error::TooLarge);
        }
        for event in payload.body.events() {
            if let Some(prior) = events.insert(event.id.clone(), event.clone()) {
                if prior != *event {
                    return Err(Error::DuplicateMismatch);
                }
            }
            if let Some(prior) =
                identities.insert(event.identity.entry_id.clone(), event.identity.clone())
            {
                if prior != event.identity {
                    return Err(Error::IdentityMismatch);
                }
            }
        }
    }
    derive_graph(
        state,
        events
            .into_iter()
            .map(|(id, event)| (id, GraphEvent::from(event)))
            .collect(),
    )
}

// A private shared graph vocabulary keeps legacy wire parsing separate from v2
// authenticated text activity. Activity changes causal heads, never bytes/location.
#[derive(Clone, PartialEq, Eq)]
struct GraphEvent {
    id: UpdateId,
    identity: EntryIdentity,
    parents: Vec<UpdateId>,
    effect: GraphEffect,
}
#[derive(Clone, PartialEq, Eq)]
enum GraphEffect {
    Create {
        entry_kind: EntryKind,
        location: Location,
        content: Option<Manifest>,
    },
    CreateText {
        location: Location,
        binding: v2::TextBinding,
    },
    TextActivity {
        binding: v2::TextBinding,
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
impl From<EntryEvent> for GraphEvent {
    fn from(e: EntryEvent) -> Self {
        let effect = match e.effect {
            Effect::Create {
                entry_kind,
                location,
                content,
            } => GraphEffect::Create {
                entry_kind,
                location,
                content,
            },
            Effect::SetContent { content } => GraphEffect::SetContent { content },
            Effect::Move { location } => GraphEffect::Move { location },
            Effect::Delete => GraphEffect::Delete,
            Effect::Restore { location } => GraphEffect::Restore { location },
        };
        Self {
            id: e.id,
            identity: e.identity,
            parents: e.parents,
            effect,
        }
    }
}
/// The validated graph's existing causal closure, retained only when a caller
/// needs a historical frontier operation as well as the current view.
struct GraphAncestry {
    events: BTreeMap<UpdateId, GraphEvent>,
    indexes: BTreeMap<UpdateId, usize>,
    ancestors: BTreeMap<UpdateId, Vec<u64>>,
}
impl GraphAncestry {
    fn resolved_event(&self, id: &UpdateId) -> Result<&GraphEvent> {
        if !self.ancestors.contains_key(id) {
            return Err(Error::InvalidCausality);
        }
        self.events.get(id).ok_or(Error::InvalidCausality)
    }
    fn is_ancestor(&self, earlier: &UpdateId, later: &UpdateId) -> Result<bool> {
        self.resolved_event(earlier)?;
        let index = *self.indexes.get(earlier).ok_or(Error::InvalidCausality)?;
        let past = self.ancestors.get(later).ok_or(Error::InvalidCausality)?;
        Ok(past[index / 64] & (1u64 << (index % 64)) != 0)
    }
}
fn derive_graph(state: &State, events: BTreeMap<UpdateId, GraphEvent>) -> Result<VaultView> {
    derive_graph_with_ancestry(state, events).map(|(view, _)| view)
}
fn derive_graph_with_ancestry(
    state: &State,
    events: BTreeMap<UpdateId, GraphEvent>,
) -> Result<(VaultView, GraphAncestry)> {
    derive_graph_with_status(events, |manifest| content_status(state, manifest))
}
fn derive_graph_with_status(
    events: BTreeMap<UpdateId, GraphEvent>,
    mut resolve_content: impl FnMut(&Manifest) -> Result<ContentStatus>,
) -> Result<(VaultView, GraphAncestry)> {
    let mut identities = BTreeMap::new();
    for event in events.values() {
        if let Some(prior) =
            identities.insert(event.identity.entry_id.clone(), event.identity.clone())
        {
            if prior != event.identity {
                return Err(Error::IdentityMismatch);
            }
        }
    }
    if events.len() > MAX_EVENTS {
        return Err(Error::TooLarge);
    }
    // Known binding contradictions fail even while another causal dependency is
    // missing. Pending activity cannot establish a second text bootstrap.
    let mut text_bindings = BTreeMap::new();
    for event in events.values() {
        if let GraphEffect::CreateText { binding, .. } | GraphEffect::TextActivity { binding } =
            &event.effect
        {
            if let Some(prior) = text_bindings.insert(event.identity.entry_id.clone(), binding) {
                if prior != binding {
                    return Err(Error::IdentityMismatch);
                }
            }
        }
        if let Some(bootstrap) = events.get(&event.identity.bootstrap_id) {
            match (&event.effect, &bootstrap.effect) {
                (GraphEffect::SetContent { .. }, GraphEffect::CreateText { .. }) => {
                    return Err(Error::InvalidContent)
                }
                (
                    GraphEffect::TextActivity { binding },
                    GraphEffect::CreateText {
                        binding: expected, ..
                    },
                ) if binding == expected => {}
                (GraphEffect::TextActivity { .. }, _) => return Err(Error::IdentityMismatch),
                _ => {}
            }
        }
    }
    for event in events.values() {
        if matches!(event.effect, GraphEffect::SetContent { .. })
            && text_bindings.contains_key(&event.identity.entry_id)
        {
            return Err(Error::InvalidContent);
        }
    }
    let mut content_cache = BTreeMap::<Vec<u8>, ContentStatus>::new();
    let mut verification_bytes = 0u64;
    for event in events.values() {
        match &event.effect {
            GraphEffect::Create {
                content: Some(content),
                ..
            }
            | GraphEffect::SetContent { content } => {
                let key = serde_json::to_vec(content).map_err(|_| Error::InvalidPayload)?;
                if !content_cache.contains_key(&key) {
                    verification_bytes = verification_bytes
                        .checked_add(content.bytes)
                        .ok_or(Error::TooLarge)?;
                    if verification_bytes > MAX_MANIFEST_VERIFY_BYTES {
                        return Err(Error::TooLarge);
                    }
                    content_cache.insert(key, resolve_content(content)?);
                }
            }
            _ => {}
        }
        for parent in &event.parents {
            if let Some(parent) = events.get(parent) {
                if parent.identity != event.identity {
                    return Err(Error::IdentityMismatch);
                }
            }
        }
    }
    // One whole-graph traversal detects cycles and produces prerequisite-first
    // order, including cycles that also reference unavailable dependencies.
    let order = causal_order(&events)?;
    let mut resolved = BTreeSet::new();
    // Dense bitsets bound causal closure to MAX_EVENTS² / 8 bytes, rather
    // than cloning up to millions of long opaque ID strings.
    let indexes: BTreeMap<_, _> = events
        .keys()
        .cloned()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();
    let words = events.len().div_ceil(64);
    let has = |bits: &[u64], id: &UpdateId| {
        let i = indexes[id];
        bits[i / 64] & (1u64 << (i % 64)) != 0
    };
    let mut ancestors: BTreeMap<UpdateId, Vec<u64>> = BTreeMap::new();
    for id in order {
        let event = &events[&id];
        if !event.parents.iter().all(|p| resolved.contains(p)) {
            continue;
        }
        let mut past = vec![0u64; words];
        for parent in &event.parents {
            let i = indexes[parent];
            past[i / 64] |= 1u64 << (i % 64);
            for (word, inherited) in past
                .iter_mut()
                .zip(ancestors.get(parent).ok_or(Error::InvalidState)?)
            {
                *word |= inherited;
            }
        }
        if !matches!(
            event.effect,
            GraphEffect::Create { .. } | GraphEffect::CreateText { .. }
        ) {
            let bootstrap = events
                .get(&event.identity.bootstrap_id)
                .ok_or(Error::InvalidCausality)?;
            let entry_kind = match &bootstrap.effect {
                GraphEffect::Create { entry_kind, .. } => *entry_kind,
                GraphEffect::CreateText { .. } => EntryKind::File,
                _ => return Err(Error::InvalidCausality),
            };
            match (&event.effect, &bootstrap.effect) {
                (GraphEffect::SetContent { .. }, GraphEffect::CreateText { .. }) => {
                    return Err(Error::InvalidContent)
                }
                (
                    GraphEffect::TextActivity { binding },
                    GraphEffect::CreateText {
                        binding: expected, ..
                    },
                ) if binding == expected => {}
                (GraphEffect::TextActivity { .. }, _) => return Err(Error::IdentityMismatch),
                _ => {}
            }
            if !has(&past, &event.identity.bootstrap_id) {
                return Err(Error::InvalidCausality);
            }
            if matches!(event.effect, GraphEffect::SetContent { .. })
                && entry_kind != EntryKind::File
            {
                return Err(Error::InvalidContent);
            }
            // Parent frontier must be an antichain. Bit intersections avoid
            // quadratic pairwise long-ID lookups for wide frontiers.
            let mut frontier = vec![0u64; words];
            for parent in &event.parents {
                let i = indexes[parent];
                frontier[i / 64] |= 1u64 << (i % 64);
            }
            for parent in &event.parents {
                if frontier
                    .iter()
                    .zip(&ancestors[parent])
                    .any(|(a, b)| a & b != 0)
                {
                    return Err(Error::InvalidCausality);
                }
            }
            if !matches!(
                event.effect,
                GraphEffect::Restore { .. } | GraphEffect::Delete
            ) && event
                .parents
                .iter()
                .any(|parent| matches!(events[parent].effect, GraphEffect::Delete))
            {
                return Err(Error::InvalidCausality);
            }
        }
        ancestors.insert(event.id.clone(), past);
        resolved.insert(event.id.clone());
    }
    let pending = events
        .keys()
        .filter(|id| !resolved.contains(*id))
        .cloned()
        .collect();
    let mut entries = BTreeMap::new();
    for identity in identities.values() {
        let Some(create) = events
            .get(&identity.bootstrap_id)
            .filter(|e| resolved.contains(&e.id))
        else {
            continue;
        };
        if create.identity != *identity {
            return Err(Error::IdentityMismatch);
        }
        let entry_kind = match &create.effect {
            GraphEffect::Create { entry_kind, .. } => *entry_kind,
            GraphEffect::CreateText { .. } => EntryKind::File,
            _ => return Err(Error::InvalidCausality),
        };
        let own: Vec<_> = events
            .values()
            .filter(|e| e.identity == *identity && resolved.contains(&e.id))
            .collect();
        let maximal = |candidates: &[&GraphEvent]| -> Vec<UpdateId> {
            let mut dominated = vec![0u64; words];
            for candidate in candidates {
                for (word, past) in dominated.iter_mut().zip(&ancestors[&candidate.id]) {
                    *word |= past;
                }
            }
            candidates
                .iter()
                .filter(|e| !has(&dominated, &e.id))
                .map(|e| e.id.clone())
                .collect()
        };
        let heads = maximal(&own);
        let deletes = heads
            .iter()
            .filter(|id| matches!(events[*id].effect, GraphEffect::Delete))
            .count();
        let liveness = if deletes == 0 {
            Liveness::Live
        } else if deletes == heads.len() {
            Liveness::Deleted
        } else {
            Liveness::DeleteConflict
        };
        let writes: Vec<_> = own
            .iter()
            .copied()
            .filter(|e| {
                matches!(
                    e.effect,
                    GraphEffect::SetContent { .. }
                        | GraphEffect::Create {
                            content: Some(_),
                            ..
                        }
                )
            })
            .collect();
        let mut contents = Vec::new();
        for event_id in maximal(&writes) {
            let event = &events[&event_id];
            let manifest = match &event.effect {
                GraphEffect::SetContent { content }
                | GraphEffect::Create {
                    content: Some(content),
                    ..
                } => content.clone(),
                _ => unreachable!(),
            };
            let key = serde_json::to_vec(&manifest).map_err(|_| Error::InvalidPayload)?;
            let status = content_cache.get(&key).ok_or(Error::InvalidState)?.clone();
            contents.push(ContentHead {
                event: event.id.clone(),
                manifest,
                status,
            });
        }
        let moves: Vec<_> = own
            .iter()
            .copied()
            .filter(|e| {
                matches!(
                    e.effect,
                    GraphEffect::Create { .. }
                        | GraphEffect::CreateText { .. }
                        | GraphEffect::Move { .. }
                        | GraphEffect::Restore { .. }
                )
            })
            .collect();
        let locations = maximal(&moves)
            .iter()
            .map(|event_id| {
                let event = &events[event_id];
                let location = match &event.effect {
                    GraphEffect::Create { location, .. }
                    | GraphEffect::CreateText { location, .. }
                    | GraphEffect::Move { location }
                    | GraphEffect::Restore { location } => location.clone(),
                    _ => unreachable!(),
                };
                LocationHead {
                    event: event.id.clone(),
                    location,
                }
            })
            .collect();
        entries.insert(
            identity.entry_id.clone(),
            EntryView {
                identity: identity.clone(),
                kind: entry_kind,
                heads,
                contents,
                locations,
                liveness,
                projection: Projection::Tombstone,
            },
        );
    }
    // Choose sibling-name ownership before resolving full paths. Descendants
    // of a losing folder must follow it into recovery, never leak into the
    // winning folder merely because both spell the same pathname.
    let mut occupied = BTreeSet::new();
    let mut collisions = BTreeSet::new();
    for (id, entry) in &entries {
        if entry.liveness != Liveness::Live {
            continue;
        }
        if let Some(location) = entry.locations.last() {
            let key = (
                location.location.parent.clone(),
                location.location.name.clone(),
            );
            if !occupied.insert(key) {
                collisions.insert(id.clone());
            }
        }
    }
    for id in entries.keys().cloned().collect::<Vec<_>>() {
        let projection = locate(&id, &entries, &collisions);
        entries.get_mut(&id).unwrap().projection = projection;
    }
    Ok((
        VaultView { entries, pending },
        GraphAncestry {
            events,
            indexes,
            ancestors,
        },
    ))
}
fn causal_order(events: &BTreeMap<UpdateId, GraphEvent>) -> Result<Vec<UpdateId>> {
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    let mut order = Vec::new();
    for start in events.keys() {
        if done.contains(start) {
            continue;
        }
        let mut stack = vec![(start.clone(), false)];
        while let Some((id, exit)) = stack.pop() {
            if exit {
                visiting.remove(&id);
                if done.insert(id.clone()) {
                    order.push(id);
                }
                continue;
            }
            if done.contains(&id) {
                continue;
            }
            let Some(event) = events.get(&id) else {
                continue;
            };
            if !visiting.insert(id.clone()) {
                return Err(Error::InvalidCausality);
            }
            stack.push((id, true));
            for parent in &event.parents {
                stack.push((parent.clone(), false));
            }
        }
    }
    Ok(order)
}
fn locate(
    id: &EntryId,
    entries: &BTreeMap<EntryId, EntryView>,
    collisions: &BTreeSet<EntryId>,
) -> Projection {
    let recover = |reason| Projection::Recovery {
        entry: id.clone(),
        reason,
    };
    let mut seen = BTreeSet::new();
    let mut current = id;
    let mut names = Vec::new();
    loop {
        if !seen.insert(current.clone()) {
            return recover(RecoveryReason::Cycle);
        }
        if collisions.contains(current) {
            return recover(RecoveryReason::NameCollision);
        }
        let Some(entry) = entries.get(current) else {
            return recover(RecoveryReason::ParentUnavailable);
        };
        if entry.liveness == Liveness::Deleted {
            return if current == id {
                Projection::Tombstone
            } else {
                recover(RecoveryReason::ParentUnavailable)
            };
        }
        if entry.liveness == Liveness::DeleteConflict {
            return recover(RecoveryReason::DeleteConflict);
        }
        if current != id && entry.kind != EntryKind::Folder {
            return recover(RecoveryReason::ParentUnavailable);
        }
        let Some(location) = entry.locations.last() else {
            return recover(RecoveryReason::ParentUnavailable);
        };
        names.push(location.location.name.clone());
        match &location.location.parent {
            Some(parent) => current = parent,
            None => break,
        }
    }
    names.reverse();
    match VaultPath::new(names.join("/")) {
        Ok(path) => Projection::Normal { path },
        Err(_) => recover(RecoveryReason::ParentUnavailable),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireRecord {
    pub scope: Scope,
    pub id: UpdateId,
    pub exact_wire: Vec<u8>,
}
pub struct AuthenticatedPayload {
    payload: Payload,
    record: WireRecord,
}
impl AuthenticatedPayload {
    pub fn open(wire: &[u8], expected: &ExpectedContext, key: &VaultKey) -> Result<Self> {
        if wire.len() > MAX_WIRE_BYTES {
            return Err(Error::TooLarge);
        }
        let opened =
            OpenedEnvelope::open(wire, expected, key).map_err(|_| Error::AuthenticationFailed)?;
        Self::from_opened(&opened)
    }
    /// A shared host dispatcher can authenticate once, inspect the encrypted
    /// family and pass this unforgeable capability to its strict decoder.
    pub fn from_opened(opened: &OpenedEnvelope) -> Result<Self> {
        let payload = Payload::decode(opened.plaintext())?;
        let header = opened.header();
        if &payload.scope.realm_id != header.realm_id()
            || &payload.scope.vault_id != header.vault_id()
            || &payload.id != header.update_id()
        {
            return Err(Error::IdentityMismatch);
        }
        let record = WireRecord {
            scope: payload.scope.clone(),
            id: payload.id.clone(),
            exact_wire: opened.envelope().encode(),
        };
        Ok(Self { payload, record })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoredPlan {
    pub expected_state: State,
    pub next_state: State,
    pub payload: Payload,
    pub payload_bytes: Vec<u8>,
    pub view: VaultView,
}
impl AuthoredPlan {
    pub fn check_preconditions(&self, actual: &State, identity_unused: bool) -> Result<()> {
        if actual != &self.expected_state {
            return Err(Error::VersionConflict);
        }
        if !identity_unused {
            return Err(Error::DuplicateMismatch);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceivedPlan {
    pub expected_state: State,
    pub next_state: Option<State>,
    pub expected_record: Option<WireRecord>,
    pub received_record: WireRecord,
    pub view: VaultView,
}
impl ReceivedPlan {
    /// The adapter additionally checks its ordered-delivery cursor in this same
    /// transaction. This domain planner neither owns nor advances that cursor.
    pub fn check_preconditions(&self, actual: &State, record: Option<&WireRecord>) -> Result<()> {
        if actual != &self.expected_state {
            return Err(Error::VersionConflict);
        }
        if record != self.expected_record.as_ref() {
            return Err(Error::DuplicateMismatch);
        }
        Ok(())
    }
}
pub fn plan_authored(
    state: &State,
    payload: &Payload,
    next_version: Revision,
) -> Result<AuthoredPlan> {
    state.view()?;
    if state.records.contains_key(&payload.id) {
        return Err(Error::DuplicateMismatch);
    }
    let bytes = payload.encode()?;
    let next_state = insert(state, payload, next_version)?;
    let view = next_state.view()?;
    if payload
        .body
        .events()
        .iter()
        .any(|event| view.pending.contains(&event.id))
    {
        return Err(Error::InvalidCausality);
    }
    Ok(AuthoredPlan {
        expected_state: state.clone(),
        next_state,
        payload: payload.clone(),
        payload_bytes: bytes,
        view,
    })
}
pub fn plan_received(
    state: &State,
    incoming: &AuthenticatedPayload,
    prior: Option<&WireRecord>,
    next_version: Revision,
) -> Result<ReceivedPlan> {
    let current_view = state.view()?;
    if state.scope != incoming.payload.scope {
        return Err(Error::IdentityMismatch);
    }
    if let Some(prior) = prior {
        if prior != &incoming.record {
            return Err(Error::DuplicateMismatch);
        }
        if state.records.get(&incoming.payload.id) != Some(&incoming.payload) {
            return Err(Error::InvalidState);
        }
        return Ok(ReceivedPlan {
            expected_state: state.clone(),
            next_state: None,
            expected_record: Some(prior.clone()),
            received_record: incoming.record.clone(),
            view: current_view,
        });
    }
    // A known authored record must have a persisted sealed envelope in the
    // shared wire ledger before it can be echoed back. Without that record we
    // cannot distinguish an exact self-echo from changed-nonce ID reuse.
    if state.records.contains_key(&incoming.payload.id) {
        return Err(Error::DuplicateMismatch);
    }
    let next = insert(state, &incoming.payload, next_version)?;
    let view = next.view()?;
    let next_state = Some(next);
    Ok(ReceivedPlan {
        expected_state: state.clone(),
        next_state,
        expected_record: None,
        received_record: incoming.record.clone(),
        view,
    })
}
fn insert(state: &State, payload: &Payload, version: Revision) -> Result<State> {
    if state.version == version {
        return Err(Error::VersionConflict);
    }
    if state.scope != payload.scope {
        return Err(Error::IdentityMismatch);
    }
    payload.encode()?;
    let mut next = state.clone();
    next.version = version;
    if next
        .records
        .insert(payload.id.clone(), payload.clone())
        .is_some()
    {
        return Err(Error::DuplicateMismatch);
    }
    Ok(next)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod binary_stream_tests;

#[cfg(test)]
mod metadata_plan_tests;
