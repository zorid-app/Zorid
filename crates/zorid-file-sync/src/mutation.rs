//! One portable mapping from local commands to current family protocol plans.
//!
//! Call only after exact `(MutationRequest, CreateMode)` receipt lookup, inside
//! the host transaction. The host owns global historical ID/revision fences,
//! actor allocation, durable outbox/receipt publication, and filesystem work.
//! A plan is ordinary data, not an authentication or commit capability. Hosts
//! must not accept plans supplied by an untrusted caller instead of replanning.
//!
//! This first implementation uses whole snapshots and whole file buffers. It
//! retains one expected graph and one resulting graph for atomic CAS, plus exact
//! new wire plaintext. It does not retain an intermediate graph per chunk. The
//! manifest's 64 MiB ceiling is NOT a promise that every such file fits aggregate
//! encoded graph/host transport bounds (numeric JSON bytes can expand fourfold).
use crate::{
    v2, ChunkPage, ChunkRef, EntryIdentity, Family, Location, Manifest, Projection, Sha256Digest,
    MAX_CHUNK_BYTES, MAX_FILE_BYTES, MAX_PAGE_CHUNKS,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zorid_client_sync::{
    v2::TextNamespaceContext, ActorRegistration, AuthorRequest, AuthoredPlan, TextIdentity,
    TextState,
};
use zorid_core::{
    ContractError, EntryChange, EntryId, EntryKind, EntryState, Mutation, MutationRequest,
    Revision, VaultPath,
};
use zorid_sync_protocol::UpdateId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Contract(ContractError),
    Files(crate::Error),
    Text(zorid_client_sync::SyncError),
    InvalidMode,
    UnsupportedCommandVersion,
    InvalidAllocation,
    SnapshotMismatch,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
impl From<ContractError> for Error {
    fn from(e: ContractError) -> Self {
        Self::Contract(e)
    }
}
impl From<crate::Error> for Error {
    fn from(e: crate::Error) -> Self {
        Self::Files(e)
    }
}
impl From<zorid_client_sync::SyncError> for Error {
    fn from(e: zorid_client_sync::SyncError) -> Self {
        Self::Text(e)
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateMode {
    Text,
    Binary,
}
/// Complete durable local command identity for an enrolled family vault.
/// Persist this at PREPARE, before authorization. Receipts and prepared intents
/// compare the entire value before import, allocation or planning. This is not a
/// sync wire payload. The write-only editor capability can construct `None`;
/// generic file creation must obtain an explicit mode from its caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawFamilyCommand")]
pub struct FamilyCommand {
    pub version: u32,
    pub request: MutationRequest,
    pub create_mode: Option<CreateMode>,
}
// A custom field decoder without a default makes create_mode REQUIRED even
// when its explicit value is null. Plain Option<T> accepts an omitted field.
fn required_mode<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<Option<CreateMode>, D::Error> {
    Option::<CreateMode>::deserialize(decoder)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFamilyCommand {
    version: u32,
    request: MutationRequest,
    #[serde(deserialize_with = "required_mode")]
    create_mode: Option<CreateMode>,
}
impl TryFrom<RawFamilyCommand> for FamilyCommand {
    type Error = Error;
    fn try_from(raw: RawFamilyCommand) -> Result<Self> {
        let command = Self {
            version: raw.version,
            request: raw.request,
            create_mode: raw.create_mode,
        };
        command.validate()?;
        Ok(command)
    }
}
impl FamilyCommand {
    pub fn new(request: MutationRequest, create_mode: Option<CreateMode>) -> Result<Self> {
        let command = Self {
            version: 1,
            request,
            create_mode,
        };
        command.validate()?;
        Ok(command)
    }
    /// Required for direct Rust construction as well as strict serde decoding.
    /// Hosts bound the encoded input BEFORE parsing; serde validation is not an
    /// allocation limit. No filename/content guessing or implicit default mode.
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(Error::UnsupportedCommandVersion);
        }
        self.request.validate()?;
        match (&self.request.mutation, self.create_mode) {
            (
                Mutation::Create {
                    kind: EntryKind::File,
                    ..
                },
                Some(_),
            ) => Ok(()),
            (
                Mutation::Create {
                    kind: EntryKind::File,
                    ..
                },
                None,
            ) => Err(Error::InvalidMode),
            (_, None) => Ok(()),
            (_, Some(_)) => Err(Error::InvalidMode),
        }
    }
    /// The caller finds `prior` by operation ID in its scoped durable journal.
    /// This does NOT authorize a prepared intent or validate an attached receipt.
    /// On success the host returns that original receipt, without replanning or
    /// checking current target revisions. Legacy plain requests are not matches.
    pub fn check_replay(&self, prior: &Self) -> Result<()> {
        self.validate()?;
        prior.validate()?;
        if self != prior {
            return Err(ContractError::IdempotencyConflict {
                operation_id: self.request.operation_id.clone(),
            }
            .into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextRequirement {
    None,
    Create,
    Write,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllocationRequirements {
    pub update_count: u32,
    pub text: TextRequirement,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewText {
    /// Independent immutable text bootstrap, distinct from namespace Create.
    pub bootstrap_id: UpdateId,
    /// Ephemeral empty text state version; never a persisted local receipt.
    pub empty_revision: Revision,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextAllocation {
    pub actor: ActorRegistration,
    pub new_text: Option<NewText>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Allocation {
    pub metadata_revision: Revision,
    pub graph_revision: Revision,
    /// Exact required count; consumed in chunk, page, then event order. Recursive
    /// deletion events are ordered by stable entry ID. No allocation is ignored.
    pub update_ids: Vec<UpdateId>,
    pub text: Option<TextAllocation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoredFile {
    pub update_id: UpdateId,
    pub payload_bytes: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "plan",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TextChange {
    /// Requires absence of a prior text state; plan.expected_state is only the
    /// explicitly allocated empty bootstrap used to author initial bytes once.
    Create(AuthoredPlan),
    Write(AuthoredPlan),
}
impl TextChange {
    pub fn plan(&self) -> &AuthoredPlan {
        match self {
            Self::Create(p) | Self::Write(p) => p,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MutationPlan {
    pub expected_entries: Vec<EntryState>,
    pub expected_graph: v2::State,
    pub changes: Vec<EntryChange>,
    pub next_graph: v2::State,
    /// Includes the independently allocated text bootstrap, when present.
    pub allocated_update_ids: Vec<UpdateId>,
    /// File payloads precede the optional text activity in authored order.
    pub authored_files: Vec<AuthoredFile>,
    pub text: Option<TextChange>,
}
impl MutationPlan {
    /// Check transaction-current inputs. A reordered entry snapshot is equivalent.
    /// Before this check the host must return an exact retained command receipt,
    /// if any; replay is never implemented by generating another plan.
    pub fn check_preconditions(
        &self,
        entries: &[EntryState],
        graph: &v2::State,
        text: Option<&TextState>,
        allocated_ids_unused: bool,
    ) -> Result<()> {
        if !allocated_ids_unused {
            return Err(Error::InvalidAllocation);
        }
        let mut actual = entries.to_vec();
        actual.sort_by(|a, b| a.id.cmp(&b.id));
        if actual != self.expected_entries || graph != &self.expected_graph {
            return Err(Error::SnapshotMismatch);
        }
        match (&self.text, text) {
            (Some(TextChange::Create(_)), None) | (None, None) => Ok(()),
            (Some(TextChange::Write(plan)), Some(actual)) if &plan.expected_state == actual => {
                Ok(())
            }
            _ => Err(Error::SnapshotMismatch),
        }
    }
}

fn checked_view(
    request: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> Result<v2::VaultView> {
    request.validate()?;
    zorid_core::validate_snapshot(entries)?;
    let view = graph.view()?;
    // The host may not have materialized every graph entry (missing content).
    // Every supplied LIVE entry must nevertheless match the graph's exact path.
    for entry in entries.iter().filter(|e| !e.deleted) {
        let visible = view
            .namespace
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
    match &request.mutation {
        Mutation::Create {
            id,
            kind: EntryKind::File,
            ..
        } => {
            if mode.is_none() {
                return Err(Error::InvalidMode);
            }
            if text.is_some() || known_entry(graph, id) {
                return Err(Error::SnapshotMismatch);
            }
        }
        Mutation::Create {
            id,
            kind: EntryKind::Folder,
            ..
        } => {
            if mode.is_some() {
                return Err(Error::InvalidMode);
            }
            if text.is_some() || known_entry(graph, id) {
                return Err(Error::SnapshotMismatch);
            }
        }
        Mutation::Write { id, expected, .. } => {
            if mode.is_some() {
                return Err(Error::InvalidMode);
            }
            let target =
                zorid_core::validate_target(entries.iter().find(|e| &e.id == id), id, expected)?;
            match view.content_bindings.get(id) {
                Some(v2::ContentBinding::Text {
                    text_bootstrap_id, ..
                }) => {
                    let t = text.ok_or(Error::SnapshotMismatch)?;
                    if t.version != target.revision
                        || t.identity.entry_id != *id
                        || t.identity.bootstrap_id != *text_bootstrap_id
                        || t.identity.realm_id != graph.scope().realm_id
                        || t.identity.vault_id != graph.scope().vault_id
                    {
                        return Err(Error::SnapshotMismatch);
                    }
                }
                Some(v2::ContentBinding::Binary) if text.is_none() => (),
                _ => return Err(Error::SnapshotMismatch),
            }
        }
        Mutation::Move { id, expected, .. } | Mutation::Delete { id, expected, .. } => {
            if mode.is_some() {
                return Err(Error::InvalidMode);
            }
            if text.is_some() {
                return Err(Error::SnapshotMismatch);
            }
            zorid_core::validate_target(entries.iter().find(|e| &e.id == id), id, expected)?;
        }
    }
    require_affected_coverage(request, entries, &view)?;
    Ok(view)
}
// Missing materialization is allowed elsewhere, but must not hide occupancy or
// members of the subtree a local namespace operation is about to change. In
// particular a deterministic name-collision winner must not displace an omitted
// entry that the core metadata planner could not see.
fn require_affected_coverage(
    request: &MutationRequest,
    entries: &[EntryState],
    view: &v2::VaultView,
) -> Result<()> {
    let target = entries.iter().find(|e| &e.id == request.mutation.id());
    for entry in view.namespace.entries.values() {
        let Projection::Normal { path } = &entry.projection else {
            continue;
        };
        let affected = match &request.mutation {
            Mutation::Create {
                path: destination, ..
            } => path == destination,
            Mutation::Move {
                path: destination, ..
            } => {
                path == destination
                    || path.is_descendant_of(destination)
                    || target.is_some_and(|t| {
                        path == &t.path
                            || (t.kind == EntryKind::Folder && path.is_descendant_of(&t.path))
                    })
            }
            Mutation::Delete { .. } => target.is_some_and(|t| {
                path == &t.path || (t.kind == EntryKind::Folder && path.is_descendant_of(&t.path))
            }),
            Mutation::Write { .. } => false,
        };
        if affected
            && !entries
                .iter()
                .any(|e| !e.deleted && e.id == entry.identity.entry_id && e.path == *path)
        {
            return Err(Error::SnapshotMismatch);
        }
    }
    Ok(())
}
fn known_entry(graph: &v2::State, id: &EntryId) -> bool {
    graph.records().values().any(|p| match &p.body {
        v2::Body::Events { events } | v2::Body::ObservedDelete { events } => {
            events.iter().any(|e| &e.identity.entry_id == id)
        }
        _ => false,
    }) || graph
        .activities()
        .values()
        .any(|a| &a.identity().entry_id == id)
}
fn deleted_members<'a>(
    request: &MutationRequest,
    entries: &'a [EntryState],
) -> Vec<&'a EntryState> {
    let id = request.mutation.id();
    let target = entries.iter().find(|e| &e.id == id);
    let mut members: Vec<_> = entries.iter().filter(|e| !e.deleted && (&e.id == id ||
        matches!((&request.mutation, target), (Mutation::Delete { recursive: true, .. }, Some(t))
            if t.kind == EntryKind::Folder && e.path.is_descendant_of(&t.path)))).collect();
    members.sort_by(|a, b| a.id.cmp(&b.id));
    members
}
/// Allocation sizing only, not authorization. `plan_mutation` still checks the
/// complete core mutation preconditions with the freshly allocated revision.
pub fn requirements(
    request: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> Result<AllocationRequirements> {
    let view = checked_view(request, entries, graph, mode, text)?;
    requirements_with_view(request, entries, &view, mode)
}
fn requirements_with_view(
    request: &MutationRequest,
    entries: &[EntryState],
    view: &v2::VaultView,
    mode: Option<CreateMode>,
) -> Result<AllocationRequirements> {
    let mut text = TextRequirement::None;
    let count = match &request.mutation {
        Mutation::Create {
            kind: EntryKind::File,
            content: Some(bytes),
            ..
        } => match mode {
            Some(CreateMode::Text) => {
                text = TextRequirement::Create;
                check_text(bytes)?;
                2
            }
            Some(CreateMode::Binary) => binary_count(bytes)?,
            None => return Err(Error::InvalidMode),
        },
        Mutation::Write { id, content, .. } => match view.content_bindings.get(id) {
            Some(v2::ContentBinding::Text { .. }) => {
                text = TextRequirement::Write;
                check_text(content)?;
                1
            }
            Some(v2::ContentBinding::Binary) => binary_count(content)?,
            _ => return Err(Error::SnapshotMismatch),
        },
        Mutation::Delete { .. } => deleted_members(request, entries).len(),
        _ => 1,
    };
    Ok(AllocationRequirements {
        update_count: u32::try_from(count).map_err(|_| Error::InvalidAllocation)?,
        text,
    })
}
fn check_text(bytes: &[u8]) -> Result<()> {
    if bytes.len() > zorid_client_sync::MAX_TEXT_BYTES {
        return Err(zorid_client_sync::SyncError::TooLarge.into());
    }
    std::str::from_utf8(bytes)
        .map_err(|_| Error::Text(zorid_client_sync::SyncError::InvalidPayload))?;
    Ok(())
}
fn binary_count(bytes: &[u8]) -> Result<usize> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(crate::Error::TooLarge.into());
    }
    let chunks = bytes.len().div_ceil(MAX_CHUNK_BYTES);
    Ok(chunks + chunks.div_ceil(MAX_PAGE_CHUNKS) + 1)
}
fn reserved_ids(graph: &v2::State) -> BTreeSet<UpdateId> {
    let mut ids = BTreeSet::new();
    let mut manifests = Vec::new();
    for p in graph.records().values() {
        ids.insert(p.id.clone());
        match &p.body {
            v2::Body::Events { events } | v2::Body::ObservedDelete { events } => {
                for e in events {
                    ids.insert(e.id.clone());
                    ids.insert(e.identity.bootstrap_id.clone());
                    ids.extend(e.parents.iter().cloned());
                    match &e.effect {
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
                        } => manifests.push(manifest),
                        v2::Effect::SetContent { content } => manifests.push(content),
                        _ => (),
                    }
                }
            }
            v2::Body::Page { page } => {
                ids.extend(page.chunks.iter().map(|c| c.id.clone()));
            }
            _ => (),
        }
    }
    for m in manifests {
        ids.extend(m.pages.iter().map(|p| p.id.clone()));
    }
    for (id, a) in graph.activities() {
        ids.insert(id.clone());
        ids.insert(a.identity().bootstrap_id.clone());
        ids.insert(a.namespace().bootstrap_id.clone());
        ids.extend(a.namespace().parents.iter().cloned());
    }
    ids
}
fn validate_allocation(
    a: &Allocation,
    need: &AllocationRequirements,
    entries: &[EntryState],
    graph: &v2::State,
    text: Option<&TextState>,
) -> Result<()> {
    if a.update_ids.len() != need.update_count as usize
        || a.graph_revision == *graph.version()
        || a.metadata_revision == *graph.version()
        || a.graph_revision == a.metadata_revision
        || entries.iter().any(|e| e.revision == a.graph_revision)
        || text.is_some_and(|t| t.version == a.graph_revision || t.version == a.metadata_revision)
    {
        return Err(Error::InvalidAllocation);
    }
    let new = match (need.text, &a.text) {
        (TextRequirement::None, None) => None,
        (TextRequirement::Create, Some(t)) if t.new_text.is_some() => t.new_text.as_ref(),
        (TextRequirement::Write, Some(t)) if t.new_text.is_none() => None,
        _ => return Err(Error::InvalidAllocation),
    };
    let mut ids = reserved_ids(graph);
    for id in &a.update_ids {
        if !ids.insert(id.clone()) {
            return Err(Error::InvalidAllocation);
        }
    }
    if let Some(t) = new {
        if !ids.insert(t.bootstrap_id.clone())
            || t.empty_revision == a.metadata_revision
            || t.empty_revision == a.graph_revision
            || t.empty_revision == *graph.version()
            || entries.iter().any(|e| e.revision == t.empty_revision)
        {
            return Err(Error::InvalidAllocation);
        }
    }
    Ok(())
}
fn location(path: &VaultPath, entries: &[EntryState]) -> Result<Location> {
    let parent = match path.parent() {
        None => None,
        Some(p) => Some(
            entries
                .iter()
                .find(|e| !e.deleted && e.kind == EntryKind::Folder && e.path == p)
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
struct Builder<'a> {
    graph: &'a v2::State,
    ids: std::slice::Iter<'a, UpdateId>,
    records: BTreeMap<UpdateId, v2::Payload>,
    authored: Vec<AuthoredFile>,
}
impl<'a> Builder<'a> {
    fn id(&mut self) -> Result<UpdateId> {
        self.ids.next().cloned().ok_or(Error::InvalidAllocation)
    }
    fn add(&mut self, id: UpdateId, body: v2::Body) -> Result<()> {
        let payload = v2::Payload {
            family: Family::Files,
            format_version: v2::FORMAT_VERSION,
            scope: self.graph.scope().clone(),
            id: id.clone(),
            body,
        };
        let payload_bytes = payload.encode()?;
        if self.records.insert(id.clone(), payload).is_some() {
            return Err(Error::InvalidAllocation);
        }
        self.authored.push(AuthoredFile {
            update_id: id,
            payload_bytes,
        });
        Ok(())
    }
    fn binary(&mut self, bytes: &[u8]) -> Result<Manifest> {
        let mut refs = Vec::new();
        for chunk in bytes.chunks(MAX_CHUNK_BYTES) {
            let id = self.id()?;
            refs.push(ChunkRef {
                id: id.clone(),
                bytes: chunk.len() as u32,
                digest: Sha256Digest::of(chunk),
            });
            self.add(
                id,
                v2::Body::Chunk {
                    bytes: chunk.to_vec(),
                },
            )?;
        }
        let mut pages = Vec::new();
        for chunks in refs.chunks(MAX_PAGE_CHUNKS) {
            let id = self.id()?;
            let page = ChunkPage {
                chunks: chunks.to_vec(),
            };
            pages.push(page.reference(id.clone())?);
            self.add(id, v2::Body::Page { page })?;
        }
        Ok(Manifest {
            bytes: bytes.len() as u64,
            digest: Sha256Digest::of(bytes),
            pages,
        })
    }
    fn event(&mut self, event: v2::EntryEvent, delete: bool) -> Result<()> {
        let id = event.id.clone();
        let body = if delete {
            v2::Body::ObservedDelete {
                events: vec![event],
            }
        } else {
            v2::Body::Events {
                events: vec![event],
            }
        };
        self.add(id, body)
    }
}

/// Plans local Create/Write/Move/Delete without filesystem, randomness or clocks.
/// Move/Delete only change namespace+metadata: hosts rebind affected retained
/// text states to metadata revisions atomically without modifying CRDT snapshots
/// or authoring text updates. Physical observation/import uses a different API.
#[allow(clippy::too_many_arguments)]
pub fn plan_mutation(
    request: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text_state: Option<&TextState>,
    allocation: &Allocation,
) -> Result<MutationPlan> {
    let view = checked_view(request, entries, graph, mode, text_state)?;
    let need = requirements_with_view(request, entries, &view, mode)?;
    validate_allocation(allocation, &need, entries, graph, text_state)?;
    let changes = zorid_core::plan_mutation(request, entries, &allocation.metadata_revision)?;
    let mut b = Builder {
        graph,
        ids: allocation.update_ids.iter(),
        records: graph.records().clone(),
        authored: Vec::new(),
    };
    let mut text_context = None;
    match &request.mutation {
        Mutation::Create {
            id,
            path,
            kind,
            content,
        } => {
            let seed = match (kind, mode) {
                (EntryKind::Folder, None) => None,
                (EntryKind::File, Some(CreateMode::Binary)) => Some(v2::ContentSeed::Binary {
                    manifest: b.binary(content.as_deref().ok_or(Error::InvalidMode)?)?,
                }),
                (EntryKind::File, Some(CreateMode::Text)) => Some(v2::ContentSeed::Text {
                    text_bootstrap_id: allocation
                        .text
                        .as_ref()
                        .and_then(|t| t.new_text.as_ref())
                        .ok_or(Error::InvalidAllocation)?
                        .bootstrap_id
                        .clone(),
                    text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
                }),
                _ => return Err(Error::InvalidMode),
            };
            let event_id = b.id()?;
            let identity = EntryIdentity {
                entry_id: id.clone(),
                bootstrap_id: event_id.clone(),
            };
            b.event(
                v2::EntryEvent {
                    id: event_id.clone(),
                    identity,
                    parents: vec![],
                    effect: v2::Effect::Create {
                        entry_kind: *kind,
                        location: location(path, entries)?,
                        content: seed,
                    },
                },
                false,
            )?;
            if need.text == TextRequirement::Create {
                text_context = Some(TextNamespaceContext {
                    bootstrap_id: event_id.clone(),
                    parents: vec![event_id],
                });
            }
        }
        Mutation::Write { id, content, .. } => {
            let entry = view
                .namespace
                .entries
                .get(id)
                .ok_or(Error::SnapshotMismatch)?;
            if need.text == TextRequirement::Write {
                text_context = Some(TextNamespaceContext {
                    bootstrap_id: entry.identity.bootstrap_id.clone(),
                    parents: entry.heads.clone(),
                });
            } else {
                let manifest = b.binary(content)?;
                let event_id = b.id()?;
                b.event(
                    v2::EntryEvent {
                        id: event_id,
                        identity: entry.identity.clone(),
                        parents: entry.heads.clone(),
                        effect: v2::Effect::SetContent { content: manifest },
                    },
                    false,
                )?;
            }
        }
        Mutation::Move { id, path, .. } => {
            let entry = view
                .namespace
                .entries
                .get(id)
                .ok_or(Error::SnapshotMismatch)?;
            let event_id = b.id()?;
            b.event(
                v2::EntryEvent {
                    id: event_id,
                    identity: entry.identity.clone(),
                    parents: entry.heads.clone(),
                    effect: v2::Effect::Move {
                        location: location(path, entries)?,
                    },
                },
                false,
            )?;
        }
        Mutation::Delete { .. } => {
            for member in deleted_members(request, entries) {
                let entry = view
                    .namespace
                    .entries
                    .get(&member.id)
                    .ok_or(Error::SnapshotMismatch)?;
                let event_id = b.id()?;
                b.event(
                    v2::EntryEvent {
                        id: event_id,
                        identity: entry.identity.clone(),
                        parents: entry.heads.clone(),
                        effect: v2::Effect::Delete,
                    },
                    true,
                )?;
            }
        }
    }
    // The staging version is never persisted. Text activity makes the final
    // graph transition to the single allocated graph revision below.
    let stage_version = if text_context.is_some() {
        graph.version().clone()
    } else {
        allocation.graph_revision.clone()
    };
    let stage = v2::State::from_records(
        graph.scope().clone(),
        stage_version,
        b.records,
        graph.activities().clone(),
    )?;
    let (next_graph, text) = if let Some(context) = text_context {
        let ta = allocation.text.as_ref().ok_or(Error::InvalidAllocation)?;
        let initial;
        let state = if let Some(new) = &ta.new_text {
            initial = TextState::empty(
                TextIdentity {
                    realm_id: graph.scope().realm_id.clone(),
                    vault_id: graph.scope().vault_id.clone(),
                    entry_id: request.mutation.id().clone(),
                    bootstrap_id: new.bootstrap_id.clone(),
                },
                new.empty_revision.clone(),
            );
            &initial
        } else {
            text_state.ok_or(Error::SnapshotMismatch)?
        };
        let bytes = match &request.mutation {
            Mutation::Create {
                content: Some(bytes),
                ..
            }
            | Mutation::Write { content: bytes, .. } => bytes,
            _ => return Err(Error::InvalidMode),
        };
        let update_id = b.ids.next().cloned().ok_or(Error::InvalidAllocation)?;
        let authored = zorid_client_sync::v2::plan_replace_text(
            state,
            bytes,
            &AuthorRequest {
                expected_version: state.version.clone(),
                next_version: allocation.metadata_revision.clone(),
                update_id,
                actor: ta.actor.clone(),
                edits: vec![],
            },
            &context,
        )?;
        let graph_plan = v2::plan_authored_text_activity(
            &stage,
            authored.activity(),
            allocation.graph_revision.clone(),
        )?;
        let text = if ta.new_text.is_some() {
            TextChange::Create(authored.into_plan())
        } else {
            TextChange::Write(authored.into_plan())
        };
        (
            graph_plan.next_state.ok_or(Error::SnapshotMismatch)?,
            Some(text),
        )
    } else {
        (stage, None)
    };
    if b.ids.next().is_some() {
        return Err(Error::InvalidAllocation);
    }
    let final_view = next_graph.view()?;
    // Local commands may never author unresolved causality or a namespace result
    // different from the metadata operation the user actually requested.
    for file in &b.authored {
        if final_view.namespace.pending.contains(&file.update_id) {
            return Err(crate::Error::InvalidCausality.into());
        }
    }
    for change in &changes {
        let entry = final_view
            .namespace
            .entries
            .get(&change.after.id)
            .ok_or(Error::SnapshotMismatch)?;
        let expected = if change.after.deleted {
            Projection::Tombstone
        } else {
            Projection::Normal {
                path: change.after.path.clone(),
            }
        };
        if entry.kind != change.after.kind || entry.projection != expected {
            return Err(Error::SnapshotMismatch);
        }
    }
    let mut expected_entries = entries.to_vec();
    expected_entries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut allocated_update_ids = allocation.update_ids.clone();
    if let Some(new) = allocation.text.as_ref().and_then(|t| t.new_text.as_ref()) {
        allocated_update_ids.push(new.bootstrap_id.clone());
    }
    Ok(MutationPlan {
        expected_entries,
        expected_graph: graph.clone(),
        changes,
        next_graph,
        allocated_update_ids,
        authored_files: b.authored,
        text,
    })
}
