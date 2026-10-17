//! Portable transaction planning for the first sync-managed plain-text document.
//! No storage/network/runtime ownership. Every plan requires an atomic host commit.
//! Local commands/receipts are not a wire format. See docs/client-sync.md.
pub mod v2;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};
use zorid_core::{EntryId, OperationId, Revision};
use zorid_crdt::{TextEdit, TextReplica};
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_sync_protocol::{
    DeviceId, ExpectedContext, LogPosition, RealmId, ServerEpoch, UpdateId, VaultId,
    MAX_PLAINTEXT_BYTES, MAX_WIRE_BYTES,
};

pub const TEXT_FORMAT_VERSION: u32 = 1;
pub const MAX_TEXT_BYTES: usize = 256 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ACTORS: usize = 4096;
pub const MAX_EDITS: usize = 4096;
/// Conservative CPU bound for whole-text imports; larger imports fail explicitly.
pub const MAX_DIFF_CHARS: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    TooLarge,
    InvalidPayload,
    UnsupportedFormat,
    InvalidState,
    InvalidEdit,
    IdentityMismatch,
    VersionConflict,
    ActorCollision,
    FreshActorRequired,
    DedupeMismatch,
    CursorConflict,
    AuthenticationFailed,
}
impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for SyncError {}
pub type Result<T> = std::result::Result<T, SyncError>;

/// Bootstrap identity is established once by the creator and shared unchanged.
/// A matching path or identical text does NOT establish the same document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextIdentity {
    pub realm_id: RealmId,
    pub vault_id: VaultId,
    pub entry_id: EntryId,
    pub bootstrap_id: UpdateId,
}

/// A replica incarnation changes after restore/fork. This is not a signature or
/// proof of physical-device identity; all holders of the vault key are trusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActorOwner {
    pub replica_id: DeviceId,
    pub incarnation_id: OperationId,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActorRegistration {
    pub actor: u32,
    pub owner: ActorOwner,
}

/// Persist this together with materialized bytes, not in a process-local cache.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextState {
    pub identity: TextIdentity,
    pub version: Revision,
    pub snapshot: Vec<u8>,
    pub actors: BTreeMap<u32, ActorOwner>,
}
impl TextState {
    /// Creates the agreed empty bootstrap. Seed content must be authored ONCE,
    /// then its update exchanged; independently inserting the seed duplicates it.
    pub fn empty(identity: TextIdentity, version: Revision) -> Self {
        Self {
            identity,
            version,
            snapshot: TextReplica::new(0).snapshot(),
            actors: BTreeMap::new(),
        }
    }
    pub fn materialized_utf8(&self) -> Result<Vec<u8>> {
        Ok(load(self, 0)?.text().into_bytes())
    }
    /// A host must persist this baseline only when it corresponds to the bytes
    /// actually projected/observed on disk, retaining its causal snapshot.
    pub fn projection_baseline(&self) -> Result<TextBaseline> {
        Ok(TextBaseline {
            state: self.clone(),
            materialized_utf8: self.materialized_utf8()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextBaseline {
    pub state: TextState,
    pub materialized_utf8: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Edit {
    Insert { index: u32, text: String },
    Delete { index: u32, length: u32 },
}
impl From<&Edit> for TextEdit {
    fn from(edit: &Edit) -> Self {
        match edit {
            Edit::Insert { index, text } => Self::Insert {
                index: *index,
                text: text.clone(),
            },
            Edit::Delete { index, length } => Self::Delete {
                index: *index,
                length: *length,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorRequest {
    pub expected_version: Revision,
    pub next_version: Revision,
    pub update_id: UpdateId,
    pub actor: ActorRegistration,
    pub edits: Vec<Edit>,
}

/// Full expected state protects causal snapshot/actor provenance as well as the
/// visible revision. Host must also require the authored UpdateId is unused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoredPlan {
    pub expected_state: TextState,
    pub expected_baseline: Option<TextBaseline>,
    pub next_state: TextState,
    pub materialized_utf8: Vec<u8>,
    pub authored: AuthoredUpdate,
}
/// One external observation has two causal states: the merged database state
/// and the branch that actually produced the observed physical file bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalTextPlan {
    pub authored: AuthoredPlan,
    pub observed_baseline: TextBaseline,
}

impl AuthoredPlan {
    /// Run inside the committing host transaction. Check local command replay
    /// first; a replay returns its original receipt instead of replanning.
    pub fn check_preconditions(
        &self,
        actual: &TextState,
        baseline: Option<&TextBaseline>,
        update_id_unused: bool,
    ) -> Result<()> {
        if actual != &self.expected_state {
            return Err(SyncError::VersionConflict);
        }
        if baseline != self.expected_baseline.as_ref() {
            return Err(SyncError::InvalidState);
        }
        if !update_id_unused {
            return Err(SyncError::DedupeMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoredUpdate {
    pub identity: TextIdentity,
    pub update_id: UpdateId,
    pub payload_bytes: Vec<u8>,
}

/// Typed text semantics inside encrypted plaintext. Decoder rejects unknown fields
/// and unsupported versions; JSON numeric bytes count toward envelope's 1 MiB cap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextPayload {
    family: String,
    format_version: u32,
    identity: TextIdentity,
    actor: ActorRegistration,
    update: Vec<u8>,
}
impl TextPayload {
    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_PLAINTEXT_BYTES {
            return Err(SyncError::TooLarge);
        }
        // Decode the required routing/version fields first for an explicit
        // unsupported-family/version result, then validate the complete schema.
        // This is not a fallback decoder or acceptance of optional semantics.
        #[derive(Deserialize)]
        struct Discriminator {
            #[serde(default)]
            family: Option<String>,
            #[serde(default)]
            format_version: Option<u32>,
        }
        let discriminator: Discriminator =
            serde_json::from_slice(bytes).map_err(|_| SyncError::InvalidPayload)?;
        if discriminator.family.as_deref() != Some("text")
            || discriminator.format_version != Some(TEXT_FORMAT_VERSION)
        {
            return Err(SyncError::UnsupportedFormat);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| SyncError::InvalidPayload)?;
        let actors =
            TextReplica::update_actors(&value.update).map_err(|_| SyncError::InvalidPayload)?;
        if actors.iter().any(|actor| *actor != value.actor.actor) {
            return Err(SyncError::InvalidPayload);
        }
        Ok(value)
    }
    fn encode(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(self).map_err(|_| SyncError::InvalidPayload)?;
        Self::decode(&bytes)?;
        Ok(bytes)
    }
}

/// Immutable, bounded exact wire bytes, indexed by realm/vault/update ID, not by
/// document revision or relay sequence. This record survives relay epoch changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceivedRecord {
    pub identity: TextIdentity,
    pub update_id: UpdateId,
    pub exact_wire: Vec<u8>,
}

/// Private construction prevents treating structurally valid plaintext as AEAD
/// authenticated. The expected context must come from independently selected host
/// realm/vault/key epoch and the requested delivery, not copied from the header.
pub struct AuthenticatedText {
    payload: TextPayload,
    record: ReceivedRecord,
}
impl AuthenticatedText {
    pub fn open(wire: &[u8], expected: &ExpectedContext, key: &VaultKey) -> Result<Self> {
        if wire.len() > MAX_WIRE_BYTES {
            return Err(SyncError::TooLarge);
        }
        let opened = OpenedEnvelope::open(wire, expected, key)
            .map_err(|_| SyncError::AuthenticationFailed)?;
        Self::from_opened(&opened)
    }
    /// Family dispatchers authenticate once, then pass this unforgeable-in-safe-
    /// Rust capability to the strict decoder. No raw plaintext constructor exists.
    pub fn from_opened(opened: &OpenedEnvelope) -> Result<Self> {
        let payload = TextPayload::decode(opened.plaintext())?;
        let header = opened.header();
        if &payload.identity.realm_id != header.realm_id()
            || &payload.identity.vault_id != header.vault_id()
        {
            return Err(SyncError::IdentityMismatch);
        }
        let record = ReceivedRecord {
            identity: payload.identity.clone(),
            update_id: header.update_id().clone(),
            exact_wire: opened.envelope().encode(),
        };
        Ok(Self { payload, record })
    }
    pub fn identity(&self) -> &TextIdentity {
        &self.payload.identity
    }
    pub fn update_id(&self) -> &UpdateId {
        &self.record.update_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiveCursor {
    pub realm_id: RealmId,
    pub vault_id: VaultId,
    pub server_epoch: ServerEpoch,
    pub after: LogPosition,
}
/// This is a trusted ordered-delivery assertion, not proof that a relay page has
/// no gaps. The transport must validate the actual page chain before planning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CursorAdvance {
    pub expected: ReceiveCursor,
    pub next: ReceiveCursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiveRequest {
    pub expected_version: Revision,
    pub next_version: Revision,
    pub delivery: Option<CursorAdvance>,
}

/// Deliberately has no authored/outbox field. A duplicate may advance the cursor
/// without changing the document, so all three preconditions are independent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceivedPlan {
    pub expected_state: TextState,
    pub expected_record: Option<ReceivedRecord>,
    pub expected_cursor: Option<ReceiveCursor>,
    pub next_state: Option<TextState>,
    pub materialized_utf8: Option<Vec<u8>>,
    pub received_record: ReceivedRecord,
    pub cursor_advance: Option<CursorAdvance>,
}
impl ReceivedPlan {
    /// Must run inside the SAME transaction that writes the state, projection
    /// intent, received ledger and cursor. None means a required absent record.
    pub fn check_preconditions(
        &self,
        actual: &TextState,
        record: Option<&ReceivedRecord>,
        cursor: Option<&ReceiveCursor>,
    ) -> Result<()> {
        if actual != &self.expected_state {
            return Err(SyncError::VersionConflict);
        }
        if record != self.expected_record.as_ref() {
            return Err(SyncError::DedupeMismatch);
        }
        if cursor != self.expected_cursor.as_ref() {
            return Err(SyncError::CursorConflict);
        }
        Ok(())
    }
}

pub fn plan_authored_text(state: &TextState, request: &AuthorRequest) -> Result<AuthoredPlan> {
    check_version(state, &request.expected_version, &request.next_version)?;
    check_edits(&request.edits)?;
    let mut actors = state.actors.clone();
    register(&mut actors, &request.actor, false)?;
    let doc = load(state, request.actor.actor)?;
    if state.actors.contains_key(&request.actor.actor) && doc.has_missing_updates() {
        // A queued block may already reserve this actor's next clock. Use a new
        // actor until dependency delivery reconstructs its contiguous history.
        return Err(SyncError::FreshActorRequired);
    }
    let edits: Vec<_> = request.edits.iter().map(TextEdit::from).collect();
    let update = doc.edit(&edits).map_err(|_| SyncError::InvalidEdit)?;
    authored_plan(state, None, request, actors, doc, update)
}

/// An explicit whole-text command against the caller's exact current revision.
/// This is NOT a watcher import or stale-edit merge: on VersionConflict retain
/// the original command and let its caller decide; never automatically replace
/// newer content by changing expected_version behind the caller's back.
pub fn plan_replace_text(
    state: &TextState,
    desired_utf8: &[u8],
    request: &AuthorRequest,
) -> Result<AuthoredPlan> {
    if !request.edits.is_empty() {
        return Err(SyncError::InvalidEdit);
    }
    check_version(state, &request.expected_version, &request.next_version)?;
    if desired_utf8.len() > MAX_TEXT_BYTES {
        return Err(SyncError::TooLarge);
    }
    let desired = std::str::from_utf8(desired_utf8).map_err(|_| SyncError::InvalidEdit)?;
    let current = load(state, 0)?;
    let edits = diff_edits(&current.text(), desired)?;
    let mut authored = request.clone();
    authored.edits = edits
        .into_iter()
        .map(|edit| match edit {
            TextEdit::Insert { index, text } => Edit::Insert { index, text },
            TextEdit::Delete { index, length } => Edit::Delete { index, length },
        })
        .collect();
    // Reuse all actor ownership, pending-clock, snapshot and payload checks. This
    // path intentionally has no projection baseline precondition.
    plan_authored_text(state, &authored)
}

/// Baseline comes from the persistent projection record, NEVER from whatever text
/// is current when a watcher fires. The host CAS includes that exact baseline.
/// Fresh branch actor is mandatory even if the requested edits only delete.
pub fn plan_external_text(
    state: &TextState,
    baseline: &TextBaseline,
    observed_utf8: &[u8],
    request: &AuthorRequest,
) -> Result<AuthoredPlan> {
    plan_external_branch(state, baseline, observed_utf8, request).map(|(authored, _)| authored)
}

/// Import an external edit while retaining the causal branch of the observed
/// physical bytes. Persist both states atomically with one authored intent.
/// `observed_revision` must be freshly allocated independently of the merged
/// revision; the host also rejects reuse in retained historical states.
/// Do not label the physical file with the merged state before publishing it.
pub fn plan_external_text_with_baseline(
    state: &TextState,
    baseline: &TextBaseline,
    observed_utf8: &[u8],
    request: &AuthorRequest,
    observed_revision: &Revision,
) -> Result<ExternalTextPlan> {
    if observed_revision == &state.version
        || observed_revision == &baseline.state.version
        || observed_revision == &request.next_version
    {
        return Err(SyncError::VersionConflict);
    }
    let (authored, branch) = plan_external_branch(state, baseline, observed_utf8, request)?;
    let mut actors = baseline.state.actors.clone();
    register(&mut actors, &request.actor, true)?;
    let (state, materialized_utf8) =
        next_state(&baseline.state, observed_revision, actors, &branch)?;
    Ok(ExternalTextPlan {
        authored,
        observed_baseline: TextBaseline {
            state,
            materialized_utf8,
        },
    })
}

fn plan_external_branch(
    state: &TextState,
    baseline: &TextBaseline,
    observed_utf8: &[u8],
    request: &AuthorRequest,
) -> Result<(AuthoredPlan, TextReplica)> {
    check_version(state, &request.expected_version, &request.next_version)?;
    if !request.edits.is_empty() {
        return Err(SyncError::InvalidEdit);
    }
    if baseline.state.identity != state.identity {
        return Err(SyncError::IdentityMismatch);
    }
    if baseline.materialized_utf8.len() > MAX_TEXT_BYTES || observed_utf8.len() > MAX_TEXT_BYTES {
        return Err(SyncError::TooLarge);
    }
    let current = load(state, 0)?;
    let branch = load(&baseline.state, request.actor.actor)?;
    if branch.text().as_bytes() != baseline.materialized_utf8 {
        return Err(SyncError::InvalidState);
    }
    for (actor, owner) in &baseline.state.actors {
        if state.actors.get(actor) != Some(owner) {
            return Err(SyncError::InvalidState);
        }
    }
    let mut actors = state.actors.clone();
    register(&mut actors, &request.actor, true)?;
    let observed = std::str::from_utf8(observed_utf8).map_err(|_| SyncError::InvalidEdit)?;
    let edits = diff_edits(&branch.text(), observed)?;
    let update = branch.edit(&edits).map_err(|_| SyncError::InvalidEdit)?;
    if branch.text() != observed {
        return Err(SyncError::InvalidState);
    }
    current
        .apply(&update)
        .map_err(|_| SyncError::InvalidPayload)?;
    let authored = authored_plan(
        state,
        Some(baseline.clone()),
        request,
        actors,
        current,
        update,
    )?;
    Ok((authored, branch))
}

pub fn plan_received_text(
    state: &TextState,
    request: &ReceiveRequest,
    incoming: &AuthenticatedText,
    prior: Option<&ReceivedRecord>,
    cursor: Option<&ReceiveCursor>,
) -> Result<ReceivedPlan> {
    if &state.version != &request.expected_version {
        return Err(SyncError::VersionConflict);
    }
    if incoming.payload.identity != state.identity {
        return Err(SyncError::IdentityMismatch);
    }
    check_cursor(&state.identity, request.delivery.as_ref(), cursor)?;
    // Validate even for a duplicate: the stored snapshot/provenance is authority.
    let doc = load(state, 0)?;
    if let Some(prior) = prior {
        if prior.exact_wire.len() > MAX_WIRE_BYTES || prior != &incoming.record {
            return Err(SyncError::DedupeMismatch);
        }
        return Ok(ReceivedPlan {
            expected_state: state.clone(),
            expected_record: Some(prior.clone()),
            expected_cursor: cursor.cloned(),
            next_state: None,
            materialized_utf8: None,
            received_record: incoming.record.clone(),
            cursor_advance: request.delivery.clone(),
        });
    }
    check_version(state, &request.expected_version, &request.next_version)?;
    let mut actors = state.actors.clone();
    // This registration is included in next_state even when Yrs queues this update
    // for a missing prerequisite and visible text does not change yet.
    register(&mut actors, &incoming.payload.actor, false)?;
    doc.apply(&incoming.payload.update)
        .map_err(|_| SyncError::InvalidPayload)?;
    let (next_state, materialized_utf8) = next_state(state, &request.next_version, actors, &doc)?;
    Ok(ReceivedPlan {
        expected_state: state.clone(),
        expected_record: None,
        expected_cursor: cursor.cloned(),
        next_state: Some(next_state),
        materialized_utf8: Some(materialized_utf8),
        received_record: incoming.record.clone(),
        cursor_advance: request.delivery.clone(),
    })
}

fn check_version(state: &TextState, expected: &Revision, next: &Revision) -> Result<()> {
    if &state.version != expected || next == expected {
        Err(SyncError::VersionConflict)
    } else {
        Ok(())
    }
}
fn register(
    actors: &mut BTreeMap<u32, ActorOwner>,
    registration: &ActorRegistration,
    fresh: bool,
) -> Result<()> {
    if let Some(owner) = actors.get(&registration.actor) {
        if fresh {
            return Err(SyncError::FreshActorRequired);
        }
        if owner != &registration.owner {
            return Err(SyncError::ActorCollision);
        }
    } else {
        if actors.len() >= MAX_ACTORS {
            return Err(SyncError::TooLarge);
        }
        actors.insert(registration.actor, registration.owner.clone());
    }
    Ok(())
}
fn load(state: &TextState, actor: u32) -> Result<TextReplica> {
    if state.snapshot.len() > MAX_SNAPSHOT_BYTES || state.actors.len() > MAX_ACTORS {
        return Err(SyncError::TooLarge);
    }
    let present =
        TextReplica::update_actors(&state.snapshot).map_err(|_| SyncError::InvalidState)?;
    if present.iter().any(|id| !state.actors.contains_key(id)) {
        return Err(SyncError::InvalidState);
    }
    let doc = TextReplica::new(actor);
    doc.apply(&state.snapshot)
        .map_err(|_| SyncError::InvalidState)?;
    doc.validate_plain_text()
        .map_err(|_| SyncError::InvalidState)?;
    if doc.text().len() > MAX_TEXT_BYTES {
        return Err(SyncError::TooLarge);
    }
    Ok(doc)
}
fn check_edits(edits: &[Edit]) -> Result<()> {
    if edits.len() > MAX_EDITS {
        return Err(SyncError::TooLarge);
    }
    let mut total = 0usize;
    for edit in edits {
        if let Edit::Insert { text, .. } = edit {
            total = total.checked_add(text.len()).ok_or(SyncError::TooLarge)?;
            if total > MAX_TEXT_BYTES {
                return Err(SyncError::TooLarge);
            }
        }
    }
    Ok(())
}
fn next_state(
    previous: &TextState,
    version: &Revision,
    actors: BTreeMap<u32, ActorOwner>,
    doc: &TextReplica,
) -> Result<(TextState, Vec<u8>)> {
    doc.validate_plain_text()
        .map_err(|_| SyncError::InvalidPayload)?;
    let content = doc.text().into_bytes();
    let snapshot = doc.snapshot();
    if content.len() > MAX_TEXT_BYTES || snapshot.len() > MAX_SNAPSHOT_BYTES {
        return Err(SyncError::TooLarge);
    }
    Ok((
        TextState {
            identity: previous.identity.clone(),
            version: version.clone(),
            snapshot,
            actors,
        },
        content,
    ))
}
fn authored_plan(
    state: &TextState,
    baseline: Option<TextBaseline>,
    request: &AuthorRequest,
    actors: BTreeMap<u32, ActorOwner>,
    doc: TextReplica,
    update: Vec<u8>,
) -> Result<AuthoredPlan> {
    let payload_bytes = TextPayload {
        family: "text".into(),
        format_version: TEXT_FORMAT_VERSION,
        identity: state.identity.clone(),
        actor: request.actor.clone(),
        update,
    }
    .encode()?;
    let (next_state, materialized_utf8) = next_state(state, &request.next_version, actors, &doc)?;
    Ok(AuthoredPlan {
        expected_state: state.clone(),
        expected_baseline: baseline,
        next_state,
        materialized_utf8,
        authored: AuthoredUpdate {
            identity: state.identity.clone(),
            update_id: request.update_id.clone(),
            payload_bytes,
        },
    })
}
fn check_cursor(
    identity: &TextIdentity,
    delivery: Option<&CursorAdvance>,
    cursor: Option<&ReceiveCursor>,
) -> Result<()> {
    match (delivery, cursor) {
        (None, None) => Ok(()),
        (Some(delivery), Some(cursor)) => {
            if &delivery.expected != cursor
                || cursor.realm_id != identity.realm_id
                || cursor.vault_id != identity.vault_id
                || delivery.next.realm_id != cursor.realm_id
                || delivery.next.vault_id != cursor.vault_id
                || delivery.next.server_epoch != cursor.server_epoch
                || delivery.next.after <= cursor.after
            {
                return Err(SyncError::CursorConflict);
            }
            Ok(())
        }
        _ => Err(SyncError::CursorConflict),
    }
}
fn diff_edits(old: &str, new: &str) -> Result<Vec<TextEdit>> {
    let old: Vec<char> = old.chars().collect();
    let new: Vec<char> = new.chars().collect();
    if old.len() > MAX_DIFF_CHARS || new.len() > MAX_DIFF_CHARS {
        return Err(SyncError::TooLarge);
    }
    let mut offsets = vec![0u32];
    for character in &old {
        offsets.push(offsets.last().copied().unwrap() + character.len_utf16() as u32);
    }
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old, &new);
    let mut edits = Vec::new();
    // Apply from the end so old offsets remain valid across independent hunks.
    for op in ops.iter().rev() {
        if op.tag() == similar::DiffTag::Equal {
            continue;
        }
        let before = op.old_range();
        let after = op.new_range();
        let index = offsets[before.start];
        if !before.is_empty() {
            edits.push(TextEdit::Delete {
                index,
                length: offsets[before.end] - index,
            });
        }
        if !after.is_empty() {
            edits.push(TextEdit::Insert {
                index,
                text: new[after].iter().collect(),
            });
        }
    }
    if edits.len() > MAX_EDITS {
        return Err(SyncError::TooLarge);
    }
    Ok(edits)
}

#[cfg(test)]
mod tests;
