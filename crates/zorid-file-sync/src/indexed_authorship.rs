//! Bounded local authorship candidates over checked, targeted namespace reads.
//!
//! No complete graph, partial snapshot masquerading as one, receipt, or commit
//! capability is constructed here. The host owns selector/source completeness,
//! original operation and staged-content provenance, allocation reservations,
//! final graph reduction and atomic publication through its private readset.
use crate::binary_mutation::BinaryTarget;
use crate::binary_stream::AuthoredRecord;
use crate::mutation::{
    self, Allocation, AllocationRequirements, AuthoredFile, CreateMode, DestinationParent, Error,
    FamilyCommand, TextChange, TextRequirement,
};
use crate::{v2, EntryIdentity, Family, Location, Manifest, Scope, MAX_PARENTS};
use zorid_client_sync::{v2::TextNamespaceContext, TextState};
use zorid_core::{EntryChange, EntryId, EntryKind, EntryState, Mutation, Revision, VaultPath};
use zorid_sync_protocol::{UpdateId, MAX_PLAINTEXT_BYTES};

/// Ordinary checked-reader data, not proof of source or publication authority.
/// Retained content manifests and location histories are intentionally omitted.
#[derive(Debug)]
pub struct AuthoringEntry {
    pub materialized: EntryState,
    pub identity: EntryIdentity,
    pub heads: Vec<UpdateId>,
    pub binding: Option<v2::ContentBinding>,
    pub preferred_binary_content_event: Option<UpdateId>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorshipWork {
    Read,
    Retain { encoded_bytes: usize },
    Emit { encoded_bytes: usize },
}
/// All selectors use one transaction-current graph head. `entry` cross-checks
/// normal projection, kind, path, revision, publication and immutable sources.
/// `known_entry` includes pending graph identities and tombstones. Parent reads
/// are exact live immediate-parent selectors, including negative witnesses.
///
/// Each selector admits encoded source sizes BEFORE decoding/returning owned
/// values. `admit` checks cancellation and finite work/retained/output budgets;
/// rejection is an error, never truncation. Charges concern encoded records,
/// not Rust/Yrs heap usage. The host must not implement this using a subset
/// asserted complete by a caller or accept these public candidates as authority.
pub trait IndexedAuthorshipReader {
    type Error: From<Error>;
    fn admit(&mut self, work: AuthorshipWork) -> Result<(), Self::Error>;
    fn entry(&mut self, id: &EntryId) -> Result<Option<AuthoringEntry>, Self::Error>;
    fn known_entry(&mut self, id: &EntryId) -> Result<bool, Self::Error>;
    fn destination_parent(&mut self, path: &VaultPath) -> Result<Option<EntryState>, Self::Error>;
    /// Validate actual host historical/current reservations, without a scan.
    fn require_fresh_revision(&mut self, revision: &Revision) -> Result<(), Self::Error>;
    /// Includes missing remote references, not only existing source envelopes.
    fn require_unused_update_id(&mut self, id: &UpdateId) -> Result<(), Self::Error>;
}
#[derive(Debug)]
pub struct AuthorshipCandidate {
    files: Vec<AuthoredFile>,
    text: Option<TextChange>,
    activity: Option<v2::StoredActivity>,
}
impl AuthorshipCandidate {
    pub fn authored_files(&self) -> &[AuthoredFile] {
        &self.files
    }
    pub fn text(&self) -> Option<&TextChange> {
        self.text.as_ref()
    }
    pub fn activity(&self) -> Option<&v2::StoredActivity> {
        self.activity.as_ref()
    }
    pub fn into_parts(
        self,
    ) -> (
        Vec<AuthoredFile>,
        Option<TextChange>,
        Option<v2::StoredActivity>,
    ) {
        (self.files, self.text, self.activity)
    }
}
fn large() -> Error {
    crate::Error::TooLarge.into()
}
fn bound(bytes: usize) -> Result<usize, Error> {
    bytes
        .checked_mul(6)
        .and_then(|n| n.checked_add(2048))
        .ok_or_else(large)
}
fn add(a: usize, b: usize) -> Result<usize, Error> {
    a.checked_add(b).ok_or_else(large)
}
fn row_bound(entry: &AuthoringEntry) -> Result<usize, Error> {
    let mut bytes = add(entry.materialized.path.as_str().len(), 768)?;
    for id in &entry.heads {
        bytes = add(bytes, id.as_str().len())?;
    }
    bound(bytes)
}
fn step<R: IndexedAuthorshipReader>(r: &mut R) -> Result<(), R::Error> {
    r.admit(AuthorshipWork::Read)
}
fn target<R: IndexedAuthorshipReader>(
    r: &mut R,
    id: &EntryId,
    expected: &Revision,
) -> Result<AuthoringEntry, R::Error> {
    step(r)?;
    let entry = r
        .entry(id)?
        .ok_or_else(|| R::Error::from(Error::SnapshotMismatch))?;
    if entry.heads.len() > MAX_PARENTS {
        return Err(large().into());
    }
    if entry.materialized.id != *id
        || entry.identity.entry_id != *id
        || entry.materialized.deleted
        || entry.materialized.revision != *expected
        || entry.heads.is_empty()
        || entry.heads.windows(2).any(|p| p[0] >= p[1])
    {
        return Err(Error::SnapshotMismatch.into());
    }
    r.admit(AuthorshipWork::Retain {
        encoded_bytes: row_bound(&entry)?,
    })?;
    Ok(entry)
}
fn parent<R: IndexedAuthorshipReader>(
    r: &mut R,
    path: &VaultPath,
    guard: Option<&DestinationParent>,
) -> Result<Location, R::Error> {
    step(r)?;
    r.admit(AuthorshipWork::Retain {
        encoded_bytes: bound(path.as_str().len())?,
    })?;
    let id = match path.parent() {
        None => {
            if guard.is_some_and(|g| !matches!(g, DestinationParent::Root)) {
                return Err(Error::SnapshotMismatch.into());
            }
            None
        }
        Some(p) => {
            step(r)?;
            let e = r
                .destination_parent(path)?
                .ok_or_else(|| R::Error::from(Error::SnapshotMismatch))?;
            if e.deleted || e.kind != EntryKind::Folder || e.path != p {
                return Err(Error::SnapshotMismatch.into());
            }
            if let Some(g) = guard {
                if !matches!(g, DestinationParent::Folder { id, revision, path } if *id == e.id && *revision == e.revision && *path == e.path)
                {
                    return Err(Error::SnapshotMismatch.into());
                }
            }
            Some(e.id)
        }
    };
    Ok(Location {
        parent: id,
        name: path.file_name().into(),
    })
}
fn changes<'a, R: IndexedAuthorshipReader>(
    r: &mut R,
    rows: &'a [EntryChange],
    id: &EntryId,
) -> Result<&'a EntryChange, R::Error> {
    let mut last = None;
    let mut found = None;
    for change in rows {
        step(r)?;
        if last.is_some_and(|old| old >= &change.after.id)
            || change
                .before
                .as_ref()
                .is_some_and(|before| before.id != change.after.id)
        {
            return Err(Error::SnapshotMismatch.into());
        }
        last = Some(&change.after.id);
        if &change.after.id == id {
            found = Some(change);
        }
    }
    found.ok_or_else(|| Error::SnapshotMismatch.into())
}
fn check_before<R: IndexedAuthorshipReader>(
    entry: &AuthoringEntry,
    change: &EntryChange,
) -> Result<(), R::Error> {
    if change.before.as_ref() != Some(&entry.materialized) {
        return Err(Error::SnapshotMismatch.into());
    }
    Ok(())
}
fn text_bytes(command: &FamilyCommand) -> Result<&[u8], Error> {
    let bytes = match &command.request.mutation {
        Mutation::Create {
            content: Some(bytes),
            ..
        }
        | Mutation::Write { content: bytes, .. } => bytes,
        _ => return Err(Error::InvalidMode),
    };
    if bytes.len() > zorid_client_sync::MAX_TEXT_BYTES {
        return Err(large());
    }
    std::str::from_utf8(bytes)
        .map_err(|_| Error::Text(zorid_client_sync::SyncError::InvalidPayload))?;
    Ok(bytes)
}
/// Allocation count only. Core planning and source/negative-read proofs remain
/// separate; passing caller-invented changes cannot authorize publication.
pub fn requirements<R: IndexedAuthorshipReader>(
    command: &FamilyCommand,
    rows: &[EntryChange],
    text: Option<&TextState>,
    r: &mut R,
) -> Result<AllocationRequirements, R::Error> {
    step(r)?;
    command.validate()?;
    let change = changes(r, rows, command.request.mutation.id())?;
    let mut count = 1usize;
    let requirement = match &command.request.mutation {
        Mutation::Create { id, kind, path, .. } => {
            step(r)?;
            if r.known_entry(id)?
                || change.before.is_some()
                || change.after.deleted
                || change.after.path != *path
                || change.after.kind != *kind
                || text.is_some()
            {
                return Err(Error::SnapshotMismatch.into());
            }
            parent(r, path, None)?;
            match (kind, command.create_mode) {
                (EntryKind::Folder, None) => TextRequirement::None,
                (EntryKind::File, Some(CreateMode::Text)) => {
                    text_bytes(command)?;
                    count = 2;
                    TextRequirement::Create
                }
                _ => return Err(Error::InvalidMode.into()),
            }
        }
        Mutation::Write { id, expected, .. } => {
            let entry = target(r, id, expected)?;
            check_before::<R>(&entry, change)?;
            let Some(v2::ContentBinding::Text {
                text_bootstrap_id,
                text_format,
            }) = &entry.binding
            else {
                return Err(Error::InvalidMode.into());
            };
            let Some(t) = text else {
                return Err(Error::SnapshotMismatch.into());
            };
            if entry.materialized.kind != EntryKind::File
                || change.after.deleted
                || change.after.path != entry.materialized.path
                || change.after.kind != EntryKind::File
                || t.identity.entry_id != *id
                || t.identity.bootstrap_id != *text_bootstrap_id
                || t.version != *expected
                || *text_format != zorid_client_sync::v2::TEXT_FORMAT_VERSION
            {
                return Err(Error::SnapshotMismatch.into());
            }
            text_bytes(command)?;
            TextRequirement::Write
        }
        Mutation::Move { id, expected, path } => {
            let entry = target(r, id, expected)?;
            check_before::<R>(&entry, change)?;
            if text.is_some()
                || change.after.deleted
                || change.after.path != *path
                || change.after.kind != entry.materialized.kind
            {
                return Err(Error::SnapshotMismatch.into());
            }
            parent(r, path, command.destination_parent.as_ref())?;
            TextRequirement::None
        }
        Mutation::Delete {
            id,
            expected,
            recursive,
        } => {
            let entry = target(r, id, expected)?;
            check_before::<R>(&entry, change)?;
            if text.is_some() || !change.after.deleted {
                return Err(Error::SnapshotMismatch.into());
            }
            count = 0;
            for row in rows {
                step(r)?;
                if !row.after.deleted {
                    continue;
                }
                let before = row
                    .before
                    .as_ref()
                    .ok_or_else(|| R::Error::from(Error::SnapshotMismatch))?;
                if before.deleted
                    || row.after.path != before.path
                    || row.after.kind != before.kind
                    || (before.id != *id
                        && (!recursive
                            || entry.materialized.kind != EntryKind::Folder
                            || !before.path.is_descendant_of(&entry.materialized.path)))
                {
                    return Err(Error::SnapshotMismatch.into());
                }
                count = count
                    .checked_add(1)
                    .ok_or_else(|| R::Error::from(large()))?;
            }
            TextRequirement::None
        }
    };
    Ok(AllocationRequirements {
        update_count: u32::try_from(count).map_err(|_| R::Error::from(large()))?,
        text: requirement,
    })
}
fn allocation<R: IndexedAuthorshipReader>(
    r: &mut R,
    a: &Allocation,
    need: &AllocationRequirements,
    rows: &[EntryChange],
) -> Result<(), R::Error> {
    step(r)?;
    if a.update_ids.len() != need.update_count as usize || a.graph_revision == a.metadata_revision {
        return Err(Error::InvalidAllocation.into());
    }
    for row in rows {
        step(r)?;
        if row.after.revision != a.metadata_revision {
            return Err(Error::InvalidAllocation.into());
        }
    }
    step(r)?;
    r.require_fresh_revision(&a.graph_revision)?;
    step(r)?;
    r.require_fresh_revision(&a.metadata_revision)?;
    let new = match (need.text, &a.text) {
        (TextRequirement::None, None) => None,
        (TextRequirement::Create, Some(t)) if t.new_text.is_some() => t.new_text.as_ref(),
        (TextRequirement::Write, Some(t)) if t.new_text.is_none() => None,
        _ => return Err(Error::InvalidAllocation.into()),
    };
    let mut unique = std::collections::BTreeSet::new();
    for id in &a.update_ids {
        step(r)?;
        r.admit(AuthorshipWork::Retain {
            encoded_bytes: bound(id.as_str().len())?,
        })?;
        if !unique.insert(id) {
            return Err(Error::InvalidAllocation.into());
        }
        r.require_unused_update_id(id)?;
    }
    if let Some(new) = new {
        step(r)?;
        if a.update_ids.contains(&new.bootstrap_id)
            || new.empty_revision == a.metadata_revision
            || new.empty_revision == a.graph_revision
        {
            return Err(Error::InvalidAllocation.into());
        }
        r.require_unused_update_id(&new.bootstrap_id)?;
        step(r)?;
        r.require_fresh_revision(&new.empty_revision)?;
    }
    Ok(())
}
fn event_bound(
    scope: &Scope,
    identity: &EntryIdentity,
    parents: &[UpdateId],
    extra: usize,
) -> Result<usize, Error> {
    let mut n = add(
        extra,
        scope.realm_id.as_str().len()
            + scope.vault_id.as_str().len()
            + identity.entry_id.as_str().len()
            + identity.bootstrap_id.as_str().len()
            + 128,
    )?;
    for id in parents {
        n = add(n, id.as_str().len())?;
    }
    bound(n)
}
fn emit<R: IndexedAuthorshipReader>(
    r: &mut R,
    scope: &Scope,
    event: v2::EntryEvent,
    delete: bool,
) -> Result<AuthoredFile, R::Error> {
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
    let bytes = v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: scope.clone(),
        id: id.clone(),
        body,
    }
    .encode()
    .map_err(Error::from)?;
    step(r)?;
    Ok(AuthoredFile {
        update_id: id,
        payload_bytes: bytes,
    })
}
fn admit_event<R: IndexedAuthorshipReader>(r: &mut R, bytes: usize) -> Result<(), R::Error> {
    r.admit(AuthorshipWork::Retain {
        encoded_bytes: bytes,
    })?;
    r.admit(AuthorshipWork::Emit {
        encoded_bytes: bytes,
    })
}
/// Author exact existing inline Text/namespace effects. This returns data only;
/// final reduction must still establish that graph namespace matches core rows.
pub fn author<R: IndexedAuthorshipReader>(
    command: &FamilyCommand,
    scope: &Scope,
    rows: &[EntryChange],
    text: Option<&TextState>,
    a: &Allocation,
    r: &mut R,
) -> Result<AuthorshipCandidate, R::Error> {
    let need = requirements(command, rows, text, r)?;
    allocation(r, a, &need, rows)?;
    if text.is_some_and(|t| {
        t.identity.realm_id != scope.realm_id || t.identity.vault_id != scope.vault_id
    }) {
        return Err(Error::SnapshotMismatch.into());
    }
    let mut files = Vec::new();
    let mut context = None;
    let mut next = a.update_ids.iter();
    match &command.request.mutation {
        Mutation::Create { id, kind, path, .. } => {
            let event_id = next.next().expect("checked allocation");
            r.admit(AuthorshipWork::Retain {
                encoded_bytes: bound(256)?,
            })?;
            let identity = EntryIdentity {
                entry_id: id.clone(),
                bootstrap_id: event_id.clone(),
            };
            admit_event(
                r,
                event_bound(scope, &identity, &[], path.as_str().len() + 512)?,
            )?;
            let content = if need.text == TextRequirement::Create {
                Some(v2::ContentSeed::Text {
                    text_bootstrap_id: a
                        .text
                        .as_ref()
                        .and_then(|t| t.new_text.as_ref())
                        .expect("checked text allocation")
                        .bootstrap_id
                        .clone(),
                    text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
                })
            } else {
                None
            };
            let event = v2::EntryEvent {
                id: event_id.clone(),
                identity,
                parents: vec![],
                effect: v2::Effect::Create {
                    entry_kind: *kind,
                    location: parent(r, path, None)?,
                    content,
                },
            };
            files.push(emit(r, scope, event, false)?);
            if need.text == TextRequirement::Create {
                context = Some(TextNamespaceContext {
                    bootstrap_id: event_id.clone(),
                    parents: vec![event_id.clone()],
                });
            }
        }
        Mutation::Write { id, expected, .. } => {
            let entry = target(r, id, expected)?;
            r.admit(AuthorshipWork::Retain {
                encoded_bytes: row_bound(&entry)?,
            })?;
            context = Some(TextNamespaceContext {
                bootstrap_id: entry.identity.bootstrap_id,
                parents: entry.heads,
            });
        }
        Mutation::Move { id, expected, path } => {
            let entry = target(r, id, expected)?;
            admit_event(
                r,
                event_bound(scope, &entry.identity, &entry.heads, path.as_str().len())?,
            )?;
            let event = v2::EntryEvent {
                id: next.next().expect("checked allocation").clone(),
                identity: entry.identity,
                parents: entry.heads,
                effect: v2::Effect::Move {
                    location: parent(r, path, command.destination_parent.as_ref())?,
                },
            };
            files.push(emit(r, scope, event, false)?);
        }
        Mutation::Delete { .. } => {
            for change in rows.iter().filter(|c| c.after.deleted) {
                let before = change.before.as_ref().expect("checked deleted change");
                let entry = target(r, &before.id, &before.revision)?;
                check_before::<R>(&entry, change)?;
                admit_event(r, event_bound(scope, &entry.identity, &entry.heads, 0)?)?;
                let event = v2::EntryEvent {
                    id: next.next().expect("checked allocation").clone(),
                    identity: entry.identity,
                    parents: entry.heads,
                    effect: v2::Effect::Delete,
                };
                files.push(emit(r, scope, event, true)?);
            }
        }
    }
    let (text, activity) = if let Some(context) = context {
        step(r)?;
        // The existing synchronous CRDT call is not internally preemptible.
        // Pre-admit conservative ENCODED source/output before invoking it.
        let actors = text.map_or(0, |t| t.actors.len());
        if text.is_some_and(|t| {
            t.snapshot.len() > zorid_client_sync::MAX_SNAPSHOT_BYTES
                || actors > zorid_client_sync::MAX_ACTORS
        }) {
            return Err(large().into());
        }
        let source = text.map_or(0, |t| t.snapshot.len());
        let output = bound(
            2 * zorid_client_sync::MAX_SNAPSHOT_BYTES
                + zorid_client_sync::MAX_TEXT_BYTES
                + MAX_PLAINTEXT_BYTES
                + actors * 1024
                + 4096,
        )?;
        r.admit(AuthorshipWork::Retain {
            encoded_bytes: bound(source + actors * 1024 + text_bytes(command)?.len())?,
        })?;
        r.admit(AuthorshipWork::Retain {
            encoded_bytes: output,
        })?;
        r.admit(AuthorshipWork::Emit {
            encoded_bytes: output,
        })?;
        step(r)?;
        let authored = mutation::author_text(
            scope,
            &command.request,
            text,
            a,
            &context,
            next.next().expect("checked allocation").clone(),
        )?;
        step(r)?;
        let activity =
            v2::StoredActivity::from_activity(authored.activity()).map_err(Error::from)?;
        let plan = authored.into_plan();
        let change = if need.text == TextRequirement::Create {
            TextChange::Create(plan)
        } else {
            TextChange::Write(plan)
        };
        (Some(change), Some(activity))
    } else {
        (None, None)
    };
    if next.next().is_some() {
        return Err(Error::InvalidAllocation.into());
    }
    Ok(AuthorshipCandidate {
        files,
        text,
        activity,
    })
}

/// Final event only. The host proves sealed stage contents and all stage IDs;
/// this accepts no fabricated inline MutationRequest or copied chunk bodies.
#[allow(clippy::too_many_arguments)]
pub fn author_staged_binary<R: IndexedAuthorshipReader>(
    target_command: &BinaryTarget,
    scope: &Scope,
    rows: &[EntryChange],
    manifest: &Manifest,
    final_id: &UpdateId,
    graph_revision: &Revision,
    r: &mut R,
) -> Result<AuthoredRecord, R::Error> {
    step(r)?;
    let change = changes(r, rows, target_command.id())?;
    for row in rows {
        step(r)?;
        if row.after.revision != change.after.revision || row.after.revision == *graph_revision {
            return Err(Error::InvalidAllocation.into());
        }
    }
    step(r)?;
    r.require_fresh_revision(&change.after.revision)?;
    step(r)?;
    r.require_fresh_revision(graph_revision)?;
    step(r)?;
    r.require_unused_update_id(final_id)?;
    if manifest.pages.len() > crate::MAX_MANIFEST_PAGES {
        return Err(large().into());
    }
    for page in &manifest.pages {
        step(r)?;
        if page.id == *final_id {
            return Err(Error::InvalidAllocation.into());
        }
    }
    // Count serialized manifest without allocating its JSON representation.
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(b.len())
                .ok_or_else(|| std::io::Error::other("manifest size overflow"))?;
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, manifest).map_err(|_| R::Error::from(large()))?;
    r.admit(AuthorshipWork::Retain {
        encoded_bytes: count.0,
    })?;
    manifest.validate().map_err(Error::from)?;
    let (identity, parents, effect) = match target_command {
        BinaryTarget::Create { id, path } => {
            step(r)?;
            if r.known_entry(id)?
                || change.before.is_some()
                || change.after.deleted
                || change.after.kind != EntryKind::File
                || change.after.path != *path
            {
                return Err(Error::SnapshotMismatch.into());
            }
            r.admit(AuthorshipWork::Retain {
                encoded_bytes: bound(256)?,
            })?;
            let identity = EntryIdentity {
                entry_id: id.clone(),
                bootstrap_id: final_id.clone(),
            };
            admit_event(
                r,
                event_bound(scope, &identity, &[], add(count.0, path.as_str().len())?)?,
            )?;
            let effect = v2::Effect::Create {
                entry_kind: EntryKind::File,
                location: parent(r, path, None)?,
                content: Some(v2::ContentSeed::Binary {
                    manifest: manifest.clone(),
                }),
            };
            (identity, Vec::new(), effect)
        }
        BinaryTarget::Write {
            id,
            expected_revision,
            expected_content_event,
        } => {
            let entry = target(r, id, expected_revision)?;
            check_before::<R>(&entry, change)?;
            if entry.materialized.kind != EntryKind::File
                || entry.binding != Some(v2::ContentBinding::Binary)
                || entry.preferred_binary_content_event.as_ref() != Some(expected_content_event)
                || change.after.deleted
                || change.after.path != entry.materialized.path
                || change.after.kind != EntryKind::File
            {
                return Err(Error::SnapshotMismatch.into());
            }
            admit_event(
                r,
                event_bound(scope, &entry.identity, &entry.heads, count.0)?,
            )?;
            (
                entry.identity,
                entry.heads,
                v2::Effect::SetContent {
                    content: manifest.clone(),
                },
            )
        }
    };
    let record = AuthoredRecord::from_payload(v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: scope.clone(),
        id: final_id.clone(),
        body: v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: final_id.clone(),
                identity,
                parents,
                effect,
            }],
        },
    })
    .map_err(Error::from)?;
    step(r)?;
    Ok(record)
}

#[cfg(test)]
#[path = "indexed_authorship_tests.rs"]
mod tests;
