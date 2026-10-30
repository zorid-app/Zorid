//! Private bounded local Text transaction path. Durable source-backed selectors
//! replace whole-vault snapshots; no host-supplied plan is accepted as authority.
use super::*;
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
};
use zorid_core::{EntryChange, IndexedMutationReader, IndexedMutationWork, VaultPath};
use zorid_file_sync::{
    graph_entry::EntryReduction,
    graph_facts::SourceEvent,
    graph_namespace::{NamespaceNode, NamespaceProjectionReader, NamespaceWork},
    indexed_authorship::{AuthoringEntry, AuthorshipWork, IndexedAuthorshipReader},
    EntryView, Liveness, Projection, Scope,
};
use zorid_sync_protocol::UpdateId;

fn corrupt(message: &'static str) -> StoreError {
    StoreError::Corrupt(message.into())
}
fn large() -> StoreError {
    zorid_file_sync::Error::TooLarge.into()
}

/// Source reads and every owned candidate copy share one retained-byte budget.
/// Authorship alone pairs output Retain with Emit for the same candidate; track
/// that serialization admission separately instead of charging its owned bytes
/// twice. Core and namespace Emit allocate additional owned output and remain
/// charged to retained bytes. All dimensions are finite encoded bounds, not RSS.
struct Budget {
    steps: Cell<u64>,
    bytes: Cell<u64>,
    output_bytes: Cell<u64>,
}
impl Budget {
    fn new() -> Self {
        Self {
            steps: Cell::new(0),
            bytes: Cell::new(0),
            output_bytes: Cell::new(0),
        }
    }
    fn charge(&self, bytes: u64) -> Result<()> {
        let steps = self.steps.get().checked_add(1).ok_or_else(large)?;
        let total = self.bytes.get().checked_add(bytes).ok_or_else(large)?;
        if steps > 262_144 || total > zorid_file_sync::MAX_STATE_BYTES as u64 {
            return Err(large());
        }
        self.steps.set(steps);
        self.bytes.set(total);
        Ok(())
    }
    fn output(&self, bytes: u64) -> Result<()> {
        self.charge(0)?;
        let total = self
            .output_bytes
            .get()
            .checked_add(bytes)
            .ok_or_else(large)?;
        if total > zorid_file_sync::MAX_STATE_BYTES as u64 {
            return Err(large());
        }
        self.output_bytes.set(total);
        Ok(())
    }
    fn retain(&self, value: &impl Serialize) -> Result<()> {
        struct Count(u64);
        impl std::io::Write for Count {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 = self
                    .0
                    .checked_add(bytes.len() as u64)
                    .ok_or_else(|| std::io::Error::other("indexed size overflow"))?;
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut count = Count(0);
        serde_json::to_writer(&mut count, value)?;
        self.charge(count.0)
    }
    fn graph(&self, work: family_graph_read::Work) -> Result<()> {
        self.charge(match work {
            family_graph_read::Work::Read => 0,
            family_graph_read::Work::SourceBytes(n) | family_graph_read::Work::RetainBytes(n) => n,
        })
    }
}

struct Reader<'tx> {
    snapshot: family_graph_read::GraphSnapshot<'tx>,
    budget: Budget,
    causal: BTreeMap<EntryId, EntryReduction>,
    checked: BTreeMap<EntryId, EntryView>,
    overlay: Option<EntryId>,
}
impl<'tx> Reader<'tx> {
    fn open(tx: &'tx Connection, scope: &Scope) -> Result<Self> {
        Ok(Self {
            snapshot: family_graph_read::GraphSnapshot::open(tx, scope)?,
            budget: Budget::new(),
            causal: BTreeMap::new(),
            checked: BTreeMap::new(),
            overlay: None,
        })
    }
    fn tx(&self) -> &Connection {
        self.snapshot.tx()
    }
    fn reduction(&mut self, id: &EntryId) -> Result<EntryReduction> {
        if let Some(entry) = self.causal.get(id) {
            self.budget.retain(entry)?;
            return Ok(entry.clone());
        }
        let mut events = Vec::new();
        let mut cursor = None;
        loop {
            let page = self.snapshot.events(
                &family_graph_read::EventSelector::Entry(id.clone()),
                cursor.as_ref(),
                &mut |work| self.budget.graph(work),
            )?;
            if events.len().saturating_add(page.events.len()) > zorid_file_sync::MAX_EVENTS {
                return Err(large());
            }
            events.extend(page.events);
            cursor = page.cursor;
            if cursor.is_none() {
                break;
            }
        }
        let reduction =
            zorid_file_sync::graph_entry::reduce(self.snapshot.scope(), id, &events, |_| {
                Err(zorid_file_sync::Error::InvalidContent)
            })?;
        self.budget.retain(&reduction)?;
        self.causal.insert(id.clone(), reduction.clone());
        Ok(reduction)
    }
    fn graph_entry(&mut self, id: &EntryId) -> Result<Option<EntryView>> {
        if let Some(entry) = self.checked.get(id) {
            self.budget.retain(entry)?;
            return Ok(Some(entry.clone()));
        }
        let reduction = self.reduction(id)?;
        if reduction.entry().is_none() {
            let known: bool = self.tx().query_row("SELECT EXISTS(SELECT 1 FROM family_graph_entries WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3)", params![self.snapshot.scope().realm_id.as_str(), self.snapshot.scope().vault_id.as_str(), id.as_str()], |row| row.get(0))?;
            if known {
                return Err(corrupt("indexed entry lacks causal source"));
            }
            return Ok(None);
        }
        let projection = zorid_file_sync::graph_namespace::project_namespace_candidate(id, self)?;
        let binding = reduction.binding().cloned();
        let entry = reduction
            .project(projection)
            .ok_or_else(|| corrupt("causal entry disappeared"))?;
        family_graph::check_entry(self.tx(), self.snapshot.scope(), &entry, binding.as_ref())?;
        self.budget.retain(&entry)?;
        self.checked.insert(id.clone(), entry.clone());
        Ok(Some(entry))
    }
    fn state(&mut self, id: &EntryId) -> Result<Option<EntryState>> {
        self.budget.charge(0)?;
        let row = entry_content::read_metadata_row(self.tx(), id)?;
        let Some(row) = row else {
            if family_materialization::get(self.tx(), id)?.is_some_and(|record| {
                matches!(record.publication, FamilyPublication::Normal { .. })
            }) {
                return Err(corrupt("normal indexed publication lost its entry"));
            }
            return Ok(None);
        };
        let graph = self
            .graph_entry(id)?
            .ok_or_else(|| corrupt("retained entry lost graph identity"))?;
        let publication = family_materialization::get(self.tx(), id)?
            .ok_or_else(|| corrupt("retained entry lost publication"))?;
        let visible: bool = self.tx().query_row(
            "SELECT visible FROM entries WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )?;
        if publication.identity != graph.identity || row.state.kind != graph.kind {
            return Err(corrupt("publication differs from indexed source"));
        }
        if let FamilyPublication::Normal {
            path,
            namespace_heads,
            location_event,
            ..
        } = &publication.publication
        {
            if !visible
                || row.state.deleted
                || graph.projection != (Projection::Normal { path: path.clone() })
                || &row.state.path != path
                || &graph.heads != namespace_heads
                || graph.locations.last().map(|head| &head.event) != Some(location_event)
                || !self.reduction(id)?.pending().is_empty()
            {
                return Err(corrupt("normal publication contradicts causal namespace"));
            }
        } else if visible {
            return Err(corrupt("hidden publication is visible"));
        }
        Ok(Some(row.state))
    }
    fn path(&mut self, path: &VaultPath) -> Result<Option<EntryState>> {
        self.budget.charge(0)?;
        let id: Option<String> = self
            .tx()
            .query_row(
                "SELECT id FROM entries WHERE path=?1 AND visible=1 AND deleted=0",
                [path.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        id.map(|id| {
            self.state(&EntryId::new(id)?)
                .and_then(|state| state.ok_or_else(|| corrupt("indexed path lost entry")))
        })
        .transpose()
    }
    fn fresh(&self, revision: &Revision) -> Result<()> {
        self.budget.charge(0)?;
        let present: bool = self.tx().query_row(
            "SELECT EXISTS(SELECT 1 FROM revision_fences WHERE revision=?1)",
            [revision.as_str()],
            |row| row.get(0),
        )?;
        if present {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
        Ok(())
    }
}
impl NamespaceProjectionReader for Reader<'_> {
    type Error = StoreError;
    fn admit(&mut self, work: NamespaceWork) -> Result<()> {
        match work {
            NamespaceWork::Read => self.budget.charge(0),
            NamespaceWork::Retain { encoded_bytes } => self.budget.charge(encoded_bytes as u64),
            NamespaceWork::Emit { encoded_bytes } => self.budget.charge(encoded_bytes as u64),
        }
    }
    fn node(&mut self, id: &EntryId) -> Result<Option<NamespaceNode>> {
        let reduced = self.reduction(id)?;
        reduced
            .entry()
            .map(|entry| {
                NamespaceNode::new(
                    entry.identity.clone(),
                    entry.kind,
                    entry.liveness.clone(),
                    entry.locations.last().cloned(),
                )
                .map_err(StoreError::from)
            })
            .transpose()
    }
    fn sibling_winner(
        &mut self,
        parent: Option<&EntryId>,
        name: &str,
    ) -> Result<Option<NamespaceNode>> {
        let id: Option<String> = self.tx().query_row("SELECT entry_id FROM family_graph_entries WHERE realm_id=?1 AND vault_id=?2 AND parent_key=?3 AND name=?4 AND liveness='live' ORDER BY entry_id LIMIT 1", params![self.snapshot.scope().realm_id.as_str(), self.snapshot.scope().vault_id.as_str(), parent.map_or("", EntryId::as_str), name], |row| row.get(0)).optional()?;
        let persisted = id.map(EntryId::new).transpose()?;
        let overlay = self
            .overlay
            .clone()
            .map(|id| self.node(&id))
            .transpose()?
            .flatten()
            .filter(|node| {
                node.liveness() == &Liveness::Live
                    && node.preferred_location().is_some_and(|location| {
                        location.location.parent.as_ref() == parent
                            && location.location.name == name
                    })
            });
        let selected = match (persisted, overlay) {
            (Some(id), Some(overlay)) if id <= overlay.identity().entry_id => self.node(&id)?,
            (_, Some(overlay)) => Some(overlay),
            (Some(id), None) => self.node(&id)?,
            (None, None) => None,
        };
        let Some(node) = selected else {
            return Ok(None);
        };
        if node.liveness() != &Liveness::Live
            || node.preferred_location().is_none_or(|location| {
                location.location.parent.as_ref() != parent || location.location.name != name
            })
        {
            return Err(corrupt("namespace winner contradicts indexed selector"));
        }
        Ok(Some(node))
    }
}
impl IndexedMutationReader for Reader<'_> {
    type Error = StoreError;
    fn admit(&mut self, work: IndexedMutationWork) -> Result<()> {
        match work {
            IndexedMutationWork::Read => self.budget.charge(0),
            IndexedMutationWork::Retain { encoded_bytes } => {
                self.budget.charge(encoded_bytes as u64)
            }
            IndexedMutationWork::Emit { encoded_bytes } => self.budget.charge(encoded_bytes as u64),
        }
    }
    fn require_fresh_revision(&mut self, revision: &Revision) -> Result<()> {
        self.fresh(revision)
    }
    fn entry(&mut self, id: &EntryId) -> Result<Option<EntryState>> {
        self.state(id)
    }
    fn live_path(&mut self, path: &VaultPath) -> Result<Option<EntryState>> {
        self.path(path)
    }
    fn next_live_descendant(
        &mut self,
        root: &VaultPath,
        after: Option<&VaultPath>,
    ) -> Result<Option<EntryState>> {
        let prefix = format!("{}/", root.as_str());
        let end = format!("{}0", root.as_str());
        let id: Option<String> = self.tx().query_row("SELECT id FROM entries WHERE visible=1 AND deleted=0 AND path>=?1 AND path<?2 AND (?3 IS NULL OR path>?3) ORDER BY path LIMIT 1", params![prefix, end, after.map(VaultPath::as_str)], |row| row.get(0)).optional()?;
        id.map(|id| {
            self.state(&EntryId::new(id)?)
                .and_then(|state| state.ok_or_else(|| corrupt("descendant lost entry")))
        })
        .transpose()
    }
}
impl IndexedAuthorshipReader for Reader<'_> {
    type Error = StoreError;
    fn admit(&mut self, work: AuthorshipWork) -> Result<()> {
        match work {
            AuthorshipWork::Read => self.budget.charge(0),
            AuthorshipWork::Retain { encoded_bytes } => self.budget.charge(encoded_bytes as u64),
            AuthorshipWork::Emit { encoded_bytes } => self.budget.output(encoded_bytes as u64),
        }
    }
    fn entry(&mut self, id: &EntryId) -> Result<Option<AuthoringEntry>> {
        let Some(materialized) = self.state(id)? else {
            return Ok(None);
        };
        let graph = self
            .graph_entry(id)?
            .ok_or_else(|| corrupt("authoring entry lacks graph"))?;
        Ok(Some(AuthoringEntry {
            materialized,
            identity: graph.identity,
            heads: graph.heads,
            binding: self.reduction(id)?.binding().cloned(),
            preferred_binary_content_event: graph.contents.last().map(|head| head.event.clone()),
        }))
    }
    fn known_entry(&mut self, id: &EntryId) -> Result<bool> {
        self.budget.charge(0)?;
        Ok(self.tx().query_row("SELECT EXISTS(SELECT 1 FROM family_graph_events WHERE realm_id=?1 AND vault_id=?2 AND entry_id=?3)", params![self.snapshot.scope().realm_id.as_str(), self.snapshot.scope().vault_id.as_str(), id.as_str()], |row| row.get(0))?)
    }
    fn destination_parent(&mut self, path: &VaultPath) -> Result<Option<EntryState>> {
        path.parent()
            .map(|parent| self.path(&parent))
            .unwrap_or(Ok(None))
    }
    fn require_fresh_revision(&mut self, revision: &Revision) -> Result<()> {
        self.fresh(revision)
    }
    fn require_unused_update_id(&mut self, id: &UpdateId) -> Result<()> {
        self.budget.charge(0)?;
        let referenced: bool = self.tx().query_row("SELECT EXISTS(SELECT 1 FROM family_graph_claims WHERE realm_id=?1 AND vault_id=?2 AND reserved_id=?3)", params![self.snapshot.scope().realm_id.as_str(), self.snapshot.scope().vault_id.as_str(), id.as_str()], |row| row.get(0))?;
        if referenced
            || !family_ledger::unused(self.tx(), &family_commands::key(self.snapshot.scope(), id))?
        {
            return Err(family_commands::mapped(
                zorid_file_sync::mutation::Error::InvalidAllocation,
            ));
        }
        Ok(())
    }
}
impl From<zorid_file_sync::mutation::Error> for StoreError {
    fn from(error: zorid_file_sync::mutation::Error) -> Self {
        family_commands::mapped(error)
    }
}

fn identity_binding(
    tx: &Connection,
    scope: &Scope,
    id: &EntryId,
) -> Result<
    Option<(
        zorid_file_sync::EntryIdentity,
        Option<zorid_file_sync::v2::ContentBinding>,
    )>,
> {
    let reader = Reader::open(tx, scope)?;
    let mut cursor = None;
    let mut identity = None;
    let mut binding = None;
    loop {
        let page = reader.snapshot.events(
            &family_graph_read::EventSelector::Entry(id.clone()),
            cursor.as_ref(),
            &mut |work| reader.budget.graph(work),
        )?;
        for event in page.events {
            if identity.as_ref().is_some_and(|old| old != event.identity()) {
                return Err(corrupt("contradictory target identity"));
            }
            identity = Some(event.identity().clone());
            let value = event.content_binding().or_else(|| match event.event() {
                zorid_file_sync::graph_facts::Event::Text(activity) => {
                    Some(zorid_file_sync::v2::ContentBinding::Text {
                        text_bootstrap_id: activity.identity().bootstrap_id.clone(),
                        text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
                    })
                }
                _ => None,
            });
            if let Some(value) = value {
                if binding.as_ref().is_some_and(|old| old != &value) {
                    return Err(corrupt("contradictory target binding"));
                }
                binding = Some(value);
            }
        }
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(identity.map(|identity| (identity, binding)))
}
pub(super) fn binding(
    tx: &Connection,
    scope: &Scope,
    id: &EntryId,
) -> Result<Option<zorid_file_sync::v2::ContentBinding>> {
    Ok(identity_binding(tx, scope, id)?.and_then(|(_, binding)| binding))
}

pub(super) struct Ready {
    command: zorid_file_sync::mutation::FamilyCommand,
    allocation: zorid_file_sync::mutation::Allocation,
    scope: Scope,
    store: zorid_core::OperationId,
    head: Revision,
    changes: Vec<EntryChange>,
    expected_text: Option<zorid_client_sync::TextState>,
    observed: BTreeMap<EntryId, EntryView>,
    authored: Vec<zorid_file_sync::mutation::AuthoredFile>,
    text: Option<zorid_file_sync::mutation::TextChange>,
    activity: Option<zorid_file_sync::v2::StoredActivity>,
    next: EntryView,
    binding: Option<zorid_file_sync::v2::ContentBinding>,
    publications: BTreeMap<EntryId, FamilyMaterialization>,
}
impl Ready {
    pub(super) fn command(&self) -> &zorid_file_sync::mutation::FamilyCommand {
        &self.command
    }
    pub(super) fn changes(&self) -> &[EntryChange] {
        &self.changes
    }
    pub(super) fn request(&self) -> &MutationRequest {
        &self.command.request
    }
}
fn check_roles(
    reader: &Reader<'_>,
    facts: &[zorid_file_sync::graph_facts::SourceFacts],
) -> Result<()> {
    let mut ids = BTreeSet::new();
    for source in facts {
        for claim in source.claims() {
            reader.budget.charge(256)?;
            ids.insert(claim.id().clone());
        }
    }
    for id in ids {
        let mut reducer =
            zorid_file_sync::graph_roles::RoleReducer::new(reader.snapshot.scope(), &id);
        let mut cursor = None;
        loop {
            let page = reader
                .snapshot
                .roles(&id, cursor.as_ref(), &mut |work| reader.budget.graph(work))?;
            for claim in page.claims {
                reducer.push(zorid_file_sync::graph_roles::Claim::at(
                    claim.facts(),
                    claim.ordinal(),
                )?)?;
            }
            cursor = page.cursor;
            if cursor.is_none() {
                break;
            }
        }
        for source in facts {
            for (ordinal, claim) in source
                .claims()
                .iter()
                .enumerate()
                .filter(|(_, claim)| claim.id() == &id)
            {
                let _ = claim;
                reducer.push(zorid_file_sync::graph_roles::Claim::at(source, ordinal)?)?;
            }
        }
        reducer.finish()?;
    }
    Ok(())
}
/// A bounded read snapshot produces a private Ready object. All fields originate
/// from checked selectors and existing portable authorship; callers cannot
/// deserialize it or provide mutation authority through candidate DTOs.
pub(super) fn prepare(
    tx: &Connection,
    command: &zorid_file_sync::mutation::FamilyCommand,
    scope: &Scope,
) -> Result<Ready> {
    use zorid_file_sync::{indexed_authorship, mutation as mapper};
    let mut reader = Reader::open(tx, scope)?;
    let metadata_revision = family_commands::fresh_revision()?;
    let changes =
        zorid_core::plan_indexed_mutation(&command.request, &mut reader, &metadata_revision)?;
    let expected_text = if matches!(command.request.mutation, Mutation::Write { .. }) {
        text_sync::retained(tx, command.request.mutation.id())?
    } else {
        None
    };
    let need =
        indexed_authorship::requirements(command, &changes, expected_text.as_ref(), &mut reader)?;
    let allocation = mapper::Allocation {
        metadata_revision,
        graph_revision: family_commands::fresh_revision()?,
        update_ids: (0..need.update_count)
            .map(|_| family_commands::fresh_update())
            .collect::<Result<_>>()?,
        text: match need.text {
            mapper::TextRequirement::None => None,
            requirement => Some(mapper::TextAllocation {
                actor: family_commands::actor(tx, expected_text.as_ref())?,
                new_text: if matches!(requirement, mapper::TextRequirement::Create) {
                    Some(mapper::NewText {
                        bootstrap_id: family_commands::fresh_update()?,
                        empty_revision: family_commands::fresh_revision()?,
                    })
                } else {
                    None
                },
            }),
        },
    };
    let candidate = indexed_authorship::author(
        command,
        scope,
        &changes,
        expected_text.as_ref(),
        &allocation,
        &mut reader,
    )?;
    finish_preparation(tx, command, scope, reader, allocation, changes, expected_text, candidate)
}

/// Only a portable physical-branch plan created in this read snapshot enters
/// here. The observation owner retains its independent physical proof and final
/// transaction checks; this path replaces unrelated whole-vault graph reads.
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_observed_text(
    tx: &Connection,
    command: &zorid_file_sync::mutation::FamilyCommand,
    scope: &Scope,
    current: &zorid_client_sync::TextState,
    baseline: &zorid_client_sync::v2::TextPhysicalBaseline,
    external: &zorid_client_sync::v2::ExternalTextPlan,
    allocation: zorid_file_sync::mutation::Allocation,
) -> Result<Ready> {
    let mut reader = Reader::open(tx, scope)?;
    let changes = zorid_core::plan_indexed_mutation(
        &command.request, &mut reader, &allocation.metadata_revision,
    )?;
    let candidate = zorid_file_sync::indexed_authorship::external_text_candidate(
        command, scope, &changes, current, baseline, external, &allocation, &mut reader,
    )?;
    finish_preparation(tx, command, scope, reader, allocation, changes, Some(current.clone()), candidate)
}

#[allow(clippy::too_many_arguments)]
fn finish_preparation(
    tx: &Connection,
    command: &zorid_file_sync::mutation::FamilyCommand,
    scope: &Scope,
    mut reader: Reader<'_>,
    allocation: zorid_file_sync::mutation::Allocation,
    changes: Vec<EntryChange>,
    expected_text: Option<zorid_client_sync::TextState>,
    candidate: zorid_file_sync::indexed_authorship::AuthorshipCandidate,
) -> Result<Ready> {
    use zorid_file_sync::graph_facts::SourceFacts;
    let (authored, text, activity) = candidate.into_parts();
    let mut facts = Vec::new();
    for file in &authored {
        let (_, _, record) =
            zorid_file_sync::metadata::GraphRecord::from_authored_exact(&file.payload_bytes)?;
        facts.push(SourceFacts::file(scope, &file.update_id, &record)?);
    }
    if let Some(activity) = &activity {
        facts.push(SourceFacts::text(scope, activity)?);
    }
    check_roles(&reader, &facts)?;
    let target = command.request.mutation.id();
    reader.budget.retain(&reader.checked)?;
    let observed = reader.checked.clone();
    let mut events = Vec::<SourceEvent>::new();
    let mut cursor = None;
    loop {
        let page = reader.snapshot.events(
            &family_graph_read::EventSelector::Entry(target.clone()),
            cursor.as_ref(),
            &mut |work| reader.budget.graph(work),
        )?;
        events.extend(page.events);
        if events.len() > zorid_file_sync::MAX_EVENTS {
            return Err(large());
        }
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }
    for source in &facts {
        reader.budget.retain(source)?;
        events.extend(source.events().iter().cloned());
    }
    let reduction = zorid_file_sync::graph_entry::reduce(scope, target, &events, |_| {
        Err(zorid_file_sync::Error::InvalidContent)
    })?;
    if !reduction.pending().is_empty() {
        return Err(corrupt("local command introduced pending causal history"));
    }
    let binding = reduction.binding().cloned();
    if matches!(command.request.mutation, Mutation::Create { .. }) {
        let location = reduction
            .entry()
            .and_then(|entry| entry.locations.last())
            .ok_or_else(|| corrupt("new local target lacks location"))?;
        // The first indexed local slice publishes only the target and its folder
        // revisions. A competing hidden live entry can change projection when
        // this ID wins; reject before any publication until that closure is
        // supported, rather than leaving the older projection stale.
        if reader
            .sibling_winner(location.location.parent.as_ref(), &location.location.name)?
            .is_some()
        {
            return Err(zorid_file_sync::Error::VersionConflict.into());
        }
    }
    reader.budget.retain(&reduction)?;
    reader.causal.insert(target.clone(), reduction.clone());
    reader.checked.remove(target);
    reader.overlay = Some(target.clone());
    let projection =
        zorid_file_sync::graph_namespace::project_namespace_candidate(target, &mut reader)?;
    // A new root is absent from the persisted sibling selector until commit.
    // The overlay must still participate in the deterministic winner selection.
    let next = reduction
        .project(projection)
        .ok_or_else(|| corrupt("local command has no causal target"))?;
    let target_change = changes
        .iter()
        .find(|change| &change.after.id == target)
        .ok_or_else(|| corrupt("local command missing target change"))?;
    if next.projection
        != (Projection::Normal {
            path: target_change.after.path.clone(),
        })
        || next.kind != target_change.after.kind
        || next.liveness != Liveness::Live
    {
        return Err(zorid_file_sync::Error::VersionConflict.into());
    }
    let mut publications = BTreeMap::new();
    for change in &changes {
        let record = if &change.after.id == target {
            let retained_content = text
                .as_ref()
                .map(|value| {
                    let state = &value.plan().next_state;
                    let bytes = state
                        .complete_materialized_utf8()?
                        .ok_or_else(|| corrupt("local Text output lacks dependencies"))?;
                    Ok::<_, StoreError>(FamilyContentWitness {
                        digest: zorid_file_sync::Sha256Digest::of(&bytes),
                        witness: zorid_file_sync::materialization::ContentWitness::Text {
                            identity: state.identity.clone(),
                            revision: state.version.clone(),
                            snapshot_digest: zorid_file_sync::Sha256Digest::of(&state.snapshot),
                        },
                    })
                })
                .transpose()?;
            FamilyMaterialization {
                identity: next.identity.clone(),
                publication: FamilyPublication::Normal {
                    path: change.after.path.clone(),
                    kind: next.kind,
                    namespace_heads: next.heads.clone(),
                    location_event: next
                        .locations
                        .last()
                        .ok_or_else(|| corrupt("local target lacks location"))?
                        .event
                        .clone(),
                },
                retained_content,
            }
        } else {
            reader
                .graph_entry(&change.after.id)?
                .ok_or_else(|| corrupt("ancestor lost causal source"))?;
            family_materialization::get(tx, &change.after.id)?
                .ok_or_else(|| corrupt("ancestor lost publication"))?
        };
        publications.insert(change.after.id.clone(), record);
    }
    let store = text_sync::identity(tx)?.local_store_id;
    Ok(Ready {
        command: command.clone(),
        allocation,
        scope: scope.clone(),
        store,
        head: reader.snapshot.revision().clone(),
        changes,
        expected_text,
        observed,
        authored,
        text,
        activity,
        next,
        binding,
        publications,
    })
}

pub(super) fn commit(tx: &Connection, ready: &Ready) -> Result<CommitResult> {
    use family_ledger::{EnvelopeMetadata, Family, TextBinding};
    use zorid_file_sync::{graph_facts::SourceFacts, metadata::GraphRecord};
    let mut reader = Reader::open(tx, &ready.scope)?;
    if text_sync::identity(tx)?.local_store_id != ready.store
        || reader.snapshot.revision() != &ready.head
    {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    for (id, expected) in &ready.observed {
        if reader.graph_entry(id)?.as_ref() != Some(expected) {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
    }
    for change in &ready.changes {
        if reader.state(&change.after.id)? != change.before {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
    }
    if text_sync::retained(tx, ready.command.request.mutation.id())? != ready.expected_text {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    for id in &ready.allocation.update_ids {
        reader.require_unused_update_id(id)?;
    }
    if let Some(new) = ready
        .allocation
        .text
        .as_ref()
        .and_then(|text| text.new_text.as_ref())
    {
        reader.require_unused_update_id(&new.bootstrap_id)?;
    }
    reader.fresh(&ready.allocation.metadata_revision)?;
    reader.fresh(&ready.allocation.graph_revision)?;
    if let Some(new) = ready
        .allocation
        .text
        .as_ref()
        .and_then(|text| text.new_text.as_ref())
    {
        reader.fresh(&new.empty_revision)?;
    }
    let mut facts = Vec::new();
    for authored in &ready.authored {
        let record = GraphRecord::from_authored_exact(&authored.payload_bytes)?.2;
        facts.push(SourceFacts::file(
            &ready.scope,
            &authored.update_id,
            &record,
        )?);
    }
    if let Some(activity) = &ready.activity {
        facts.push(SourceFacts::text(&ready.scope, activity)?);
    }
    check_roles(&reader, &facts)?;
    reader.snapshot.check_current()?;
    text_sync::reserve_revision(tx, &ready.allocation.metadata_revision)?;
    text_sync::reserve_revision(tx, &ready.allocation.graph_revision)?;
    if let Some(new) = ready
        .allocation
        .text
        .as_ref()
        .and_then(|text| text.new_text.as_ref())
    {
        text_sync::reserve_revision(tx, &new.empty_revision)?;
    }
    for authored in &ready.authored {
        let record = GraphRecord::from_authored_exact(&authored.payload_bytes)?.2;
        let metadata = EnvelopeMetadata {
            key: family_commands::key(&ready.scope, &authored.update_id),
            family: Family::Files,
            format_version: 2,
            payload_digest: zorid_file_sync::Sha256Digest::of(&authored.payload_bytes),
            payload_bytes: u32::try_from(authored.payload_bytes.len()).map_err(|_| large())?,
            file_summary_digest: Some(record.summary_digest()?),
            text_binding: None,
        };
        family_ledger::insert_authored(tx, &metadata, &authored.payload_bytes)?;
        tx.execute(
            "INSERT INTO family_file_records VALUES(?1,?2,?3)",
            params![
                ready.scope.realm_id.as_str(),
                ready.scope.vault_id.as_str(),
                authored.update_id.as_str()
            ],
        )?;
    }
    if let Some(change) = &ready.text {
        let plan = change.plan();
        let activity = ready
            .activity
            .as_ref()
            .ok_or_else(|| corrupt("Text candidate lacks namespace activity"))?;
        let metadata = EnvelopeMetadata {
            key: family_commands::key(&ready.scope, &plan.authored.update_id),
            family: Family::Text,
            format_version: 2,
            payload_digest: zorid_file_sync::Sha256Digest::of(&plan.authored.payload_bytes),
            payload_bytes: u32::try_from(plan.authored.payload_bytes.len()).map_err(|_| large())?,
            file_summary_digest: None,
            text_binding: Some(TextBinding {
                entry_id: plan.next_state.identity.entry_id.clone(),
                text_bootstrap_id: plan.next_state.identity.bootstrap_id.clone(),
                namespace: activity.namespace().clone(),
            }),
        };
        family_ledger::insert_authored(tx, &metadata, &plan.authored.payload_bytes)?;
        text_sync::put_current(tx, &plan.next_state)?;
        tx.execute(
            "INSERT INTO family_text_activities VALUES(?1,?2,?3,?4)",
            params![
                ready.scope.realm_id.as_str(),
                ready.scope.vault_id.as_str(),
                activity.update_id().as_str(),
                serde_json::to_string(activity)?
            ],
        )?;
    }
    for source in &facts {
        let metadata = family_ledger::metadata_only(
            tx,
            &family_commands::key(&ready.scope, source.source_id()),
        )?
        .ok_or_else(|| corrupt("new source lost ledger"))?
        .metadata;
        family_graph::insert_source(tx, &metadata, source)?;
        family_graph::check_source(tx, &ready.scope, source.source_id())?;
    }
    family_graph::write_entry(tx, &ready.scope, &ready.next, ready.binding.as_ref())?;
    let record_add = i64::try_from(ready.authored.len()).map_err(|_| large())?;
    let activity_add = i64::from(ready.activity.is_some());
    let event_add = i64::try_from(
        facts
            .iter()
            .map(|source| source.events().len())
            .sum::<usize>(),
    )
    .map_err(|_| large())?;
    let entry_add =
        i64::from(ready.changes.iter().any(|change| {
            change.after.id == ready.next.identity.entry_id && change.before.is_none()
        }));
    if tx.execute("UPDATE family_graph_state SET revision=?1,record_count=record_count+?2,activity_count=activity_count+?3,event_count=event_count+?4,entry_count=entry_count+?5 WHERE realm_id=?6 AND vault_id=?7 AND revision=?8", params![ready.allocation.graph_revision.as_str(), record_add, activity_add, event_add, entry_add, ready.scope.realm_id.as_str(), ready.scope.vault_id.as_str(), ready.head.as_str()])? != 1 { return Err(zorid_client_sync::SyncError::VersionConflict.into()); }
    if tx.execute("UPDATE family_graph_heads SET revision=?1,record_count=record_count+?2,activity_count=activity_count+?3 WHERE realm_id=?4 AND vault_id=?5 AND revision=?6", params![ready.allocation.graph_revision.as_str(), record_add, activity_add, ready.scope.realm_id.as_str(), ready.scope.vault_id.as_str(), ready.head.as_str()])? != 1 { return Err(zorid_client_sync::SyncError::VersionConflict.into()); }
    let request = &ready.command.request;
    tx.execute(
        "INSERT INTO operations(operation_id,request) VALUES(?1,?2)",
        params![
            request.operation_id.as_str(),
            operation_request::encode_inline(request)?
        ],
    )?;
    let sequence = u64::try_from(tx.last_insert_rowid())
        .map_err(|_| corrupt("operation sequence overflow"))?;
    let receipt = CommitResult {
        operation_id: request.operation_id.clone(),
        sequence,
        changes: ready.changes.clone(),
    };
    receipt.validate()?;
    family_materialization::apply_indexed_local_text(
        tx,
        request,
        &ready.changes,
        &ready.publications,
        ready.text.as_ref().map(|text| &text.plan().next_state),
    )?;
    tx.execute(
        "UPDATE operations SET result=?1 WHERE operation_id=?2",
        params![
            serde_json::to_string(&receipt)?,
            request.operation_id.as_str()
        ],
    )?;
    tx.execute(
        "INSERT INTO family_commands VALUES(?1,?2)",
        params![
            request.operation_id.as_str(),
            serde_json::to_string(&ready.command)?
        ],
    )?;
    projection_jobs::enqueue_local(tx, request, &receipt)?;
    host_intents::record_commit(tx, request)?;
    Ok(receipt)
}

fn enrolled_scope(tx: &Connection) -> Result<Scope> {
    let authority = text_sync::identity(tx)?;
    match (authority.realm_id, authority.vault_id) {
        (Some(realm_id), Some(vault_id)) => Ok(Scope { realm_id, vault_id }),
        _ => Err(zorid_client_sync::SyncError::IdentityMismatch.into()),
    }
}
pub(super) fn checked_entry(tx: &Connection, id: &EntryId) -> Result<Option<EntryView>> {
    Reader::open(tx, &enrolled_scope(tx)?)?.graph_entry(id)
}
pub(super) fn checked_binding(
    tx: &Connection,
    id: &EntryId,
) -> Result<
    Option<(
        zorid_file_sync::EntryIdentity,
        Option<zorid_file_sync::v2::ContentBinding>,
    )>,
> {
    let scope = enrolled_scope(tx)?;
    let found = identity_binding(tx, &scope, id)?;
    // Binding inspection must not materialize binary contents. Text/folder
    // histories additionally reuse the complete local causal validation.
    if found.as_ref().is_some_and(|(_, binding)| {
        !matches!(binding, Some(zorid_file_sync::v2::ContentBinding::Binary))
    }) {
        Reader::open(tx, &scope)?.reduction(id)?;
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::OperationId;
    use zorid_sync_protocol::{RealmId, VaultId};
    fn fixture() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("store")).unwrap();
        store
            .family_enroll(&Scope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        (dir, store)
    }
    fn create(n: usize) -> MutationRequest {
        MutationRequest {
            operation_id: OperationId::new(format!("create-{n}")).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(format!("note-{n}")).unwrap(),
                path: VaultPath::new(format!("note-{n}.md")).unwrap(),
                kind: EntryKind::File,
                content: Some(format!("# Note {n}\nbody\n").into_bytes()),
            },
        }
    }
    fn write(store: &Store, n: usize) -> MutationRequest {
        let id = EntryId::new(format!("note-{n}")).unwrap();
        let current = store.read_metadata(&id).unwrap().unwrap();
        MutationRequest {
            operation_id: OperationId::new(format!("write-{n}")).unwrap(),
            mutation: Mutation::Write {
                id,
                expected: current.state.revision,
                content: b"changed\n".to_vec(),
            },
        }
    }
    #[test]
    fn admission_tracks_owned_copies_and_paired_authorship_serialization() {
        let (_dir, store) = fixture();
        let tx = store.connection.unchecked_transaction().unwrap();
        let scope = scope(&tx);
        let limit = zorid_file_sync::MAX_STATE_BYTES;
        // Core output clones and namespace joined paths remain real retained
        // allocations, even though their interface calls the operation Emit.
        let mut core = Reader::open(&tx, &scope).unwrap();
        IndexedMutationReader::admit(
            &mut core,
            IndexedMutationWork::Retain {
                encoded_bytes: limit - 1,
            },
        )
        .unwrap();
        assert!(IndexedMutationReader::admit(
            &mut core,
            IndexedMutationWork::Emit { encoded_bytes: 2 }
        )
        .is_err());
        let mut namespace = Reader::open(&tx, &scope).unwrap();
        NamespaceProjectionReader::admit(
            &mut namespace,
            NamespaceWork::Retain {
                encoded_bytes: limit - 1,
            },
        )
        .unwrap();
        assert!(NamespaceProjectionReader::admit(
            &mut namespace,
            NamespaceWork::Emit { encoded_bytes: 2 }
        )
        .is_err());
        // Authorship pre-admits one candidate in both interface dimensions. It
        // can use each allowance once; neither counter can then overflow.
        let mut author = Reader::open(&tx, &scope).unwrap();
        IndexedAuthorshipReader::admit(
            &mut author,
            AuthorshipWork::Retain {
                encoded_bytes: limit,
            },
        )
        .unwrap();
        IndexedAuthorshipReader::admit(
            &mut author,
            AuthorshipWork::Emit {
                encoded_bytes: limit,
            },
        )
        .unwrap();
        assert!(IndexedAuthorshipReader::admit(
            &mut author,
            AuthorshipWork::Retain { encoded_bytes: 1 }
        )
        .is_err());
        assert!(IndexedAuthorshipReader::admit(
            &mut author,
            AuthorshipWork::Emit { encoded_bytes: 1 }
        )
        .is_err());
    }
    #[test]
    fn normal_text_create_write_replay_and_reopen() {
        let (dir, mut store) = fixture();
        let create = create(0);
        let created = store
            .family_apply(&create, Some(FamilyCreateMode::Text))
            .unwrap();
        assert_eq!(
            store
                .family_apply(&create, Some(FamilyCreateMode::Text))
                .unwrap(),
            created
        );
        let request = write(&store, 0);
        let receipt = store.family_apply(&request, None).unwrap();
        assert_eq!(store.family_apply(&request, None).unwrap(), receipt);
        drop(store);
        let mut reopened = Store::open(dir.path().join("store")).unwrap();
        assert_eq!(reopened.family_apply(&request, None).unwrap(), receipt);
        let text = text_sync::retained(&reopened.connection, request.mutation.id())
            .unwrap()
            .unwrap();
        assert_eq!(
            text.complete_materialized_utf8().unwrap().unwrap(),
            b"changed\n"
        );
        let tx = reopened.connection.unchecked_transaction().unwrap();
        let reference = blob_index::load_metadata(&tx, &scope(&tx))
            .unwrap()
            .unwrap();
        family_graph::audit_reference(&tx, &reference).unwrap();
    }
    fn scope(tx: &Connection) -> Scope {
        let identity = text_sync::identity(tx).unwrap();
        Scope {
            realm_id: identity.realm_id.unwrap(),
            vault_id: identity.vault_id.unwrap(),
        }
    }
    #[test]
    fn normal_nested_text_bumps_only_target_and_ancestors() {
        let (_dir, mut store) = fixture();
        let folder = MutationRequest {
            operation_id: OperationId::new("folder-create").unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new("folder").unwrap(),
                path: VaultPath::new("Folder").unwrap(),
                kind: EntryKind::Folder,
                content: None,
            },
        };
        store.family_apply(&folder, None).unwrap();
        store
            .family_apply(&create(1), Some(FamilyCreateMode::Text))
            .unwrap();
        let unrelated = store
            .read_metadata(&EntryId::new("note-1").unwrap())
            .unwrap()
            .unwrap();
        let mut nested = create(0);
        if let Mutation::Create { path, .. } = &mut nested.mutation {
            *path = VaultPath::new("Folder/note-0.md").unwrap();
        }
        let created = store
            .family_apply(&nested, Some(FamilyCreateMode::Text))
            .unwrap();
        assert_eq!(created.changes.len(), 2);
        let old_folder = store
            .read_metadata(&EntryId::new("folder").unwrap())
            .unwrap()
            .unwrap();
        let receipt = store.family_apply(&write(&store, 0), None).unwrap();
        assert_eq!(receipt.changes.len(), 2);
        assert_ne!(
            store
                .read_metadata(&EntryId::new("folder").unwrap())
                .unwrap()
                .unwrap()
                .state
                .revision,
            old_folder.state.revision
        );
        assert_eq!(
            store
                .read_metadata(&EntryId::new("note-1").unwrap())
                .unwrap()
                .unwrap(),
            unrelated
        );
        let tx = store.connection.unchecked_transaction().unwrap();
        let reference = blob_index::load_metadata(&tx, &scope(&tx))
            .unwrap()
            .unwrap();
        family_graph::audit_reference(&tx, &reference).unwrap();
    }
    #[test]
    fn status_matches_exact_reference_json_encoding_without_restoring_it() {
        fn assert_metrics(store: &Store) {
            let status = store.family_status().unwrap();
            let tx = store.connection.unchecked_transaction().unwrap();
            let reference = blob_index::load_metadata(&tx, &scope(&tx))
                .unwrap()
                .unwrap();
            assert_eq!(
                status.graph_records as usize,
                reference.records().len() + reference.activities().len()
            );
            assert_eq!(
                status.graph_encoded_bytes,
                serde_json::to_vec(&reference).unwrap().len() as u64
            );
        }
        let (_dir, mut store) = fixture();
        assert_metrics(&store);
        let folder = MutationRequest {
            operation_id: OperationId::new("folder-create").unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new("folder").unwrap(),
                path: VaultPath::new("Folder").unwrap(),
                kind: EntryKind::Folder,
                content: None,
            },
        };
        store.family_apply(&folder, None).unwrap();
        assert_metrics(&store);
        let mut request = create(0);
        if let Mutation::Create { path, .. } = &mut request.mutation {
            *path = VaultPath::new("é-notes.md").unwrap();
        }
        store
            .family_apply(&request, Some(FamilyCreateMode::Text))
            .unwrap();
        store
            .family_apply(&create(1), Some(FamilyCreateMode::Text))
            .unwrap();
        store.family_apply(&write(&store, 0), None).unwrap();
        let status = store.family_status().unwrap();
        let tx = store.connection.unchecked_transaction().unwrap();
        let reference = blob_index::load_metadata(&tx, &scope(&tx))
            .unwrap()
            .unwrap();
        assert_eq!(
            status.graph_records as usize,
            reference.records().len() + reference.activities().len()
        );
        assert_eq!(
            status.graph_encoded_bytes,
            serde_json::to_vec(&reference).unwrap().len() as u64
        );
        assert_eq!(status.pending_dependencies, "0");
        assert_eq!(status.recovery_entries, "0");
    }
    #[test]
    fn peer_head_change_rejects_ready_without_partial_receipt() {
        let (dir, mut store) = fixture();
        store
            .family_apply(&create(0), Some(FamilyCreateMode::Text))
            .unwrap();
        let request = write(&store, 0);
        let command = zorid_file_sync::mutation::FamilyCommand::new(request.clone(), None).unwrap();
        let tx = store.connection.unchecked_transaction().unwrap();
        let ready = prepare(&tx, &command, &scope(&tx)).unwrap();
        tx.commit().unwrap();
        let mut peer = Store::open(dir.path().join("store")).unwrap();
        peer.family_apply(&create(1), Some(FamilyCreateMode::Text))
            .unwrap();
        let before: i64 = store
            .connection
            .query_row("SELECT count(*) FROM immutable_payloads", [], |row| {
                row.get(0)
            })
            .unwrap();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(matches!(
            commit(&tx, &ready),
            Err(StoreError::Sync(
                zorid_client_sync::SyncError::VersionConflict
            ))
        ));
        tx.rollback().unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM immutable_payloads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            before
        );
        assert!(!store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id=?1)",
                [request.operation_id.as_str()],
                |row| row.get::<_, bool>(0)
            )
            .unwrap());
    }
    #[test]
    fn selected_source_corruption_rejects_normal_write() {
        let (_dir, mut store) = fixture();
        store
            .family_apply(&create(0), Some(FamilyCreateMode::Text))
            .unwrap();
        let request = write(&store, 0);
        store.connection.execute_batch("DROP TRIGGER family_graph_events_no_update; UPDATE family_graph_events SET record='{}' WHERE entry_id='note-0';").unwrap();
        let count = store
            .connection
            .query_row("SELECT count(*) FROM operations", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert!(store.family_apply(&request, None).is_err());
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM operations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            count
        );
    }
    #[test]
    fn normal_create_crosses_legacy_combined_membership_limit() {
        let (_dir, mut store) = fixture();
        for n in 0..2050 {
            store
                .family_apply(&create(n), Some(FamilyCreateMode::Text))
                .unwrap();
        }
        let members: i64 = store
            .connection
            .query_row(
                "SELECT record_count+activity_count FROM family_graph_heads",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(members, 4100);
        store.family_apply(&write(&store, 0), None).unwrap();
        store.family_apply(&write(&store, 2049), None).unwrap();
        assert_eq!(store.family_status().unwrap().graph_records, 4102);
        for n in [0, 2049] {
            let id = EntryId::new(format!("note-{n}")).unwrap();
            let row = store.read(&id).unwrap().unwrap();
            let current = store.family_materialization(&id).unwrap().unwrap();
            assert_eq!(
                store
                    .family_publication(&id, &row.state.revision)
                    .unwrap()
                    .unwrap(),
                current
            );
            let tx = store.connection.unchecked_transaction().unwrap();
            family_materialization::check_publication(&tx, &row.state, row.content.as_deref())
                .unwrap();
        }
    }
    #[test]
    #[ignore = "retained normal 10k workload; run explicitly after correctness gates"]
    fn normal_ten_thousand_text_create_and_first_last_write() {
        fn build(store: &mut Store) -> (u128, usize, usize) {
            let start = std::time::Instant::now();
            let stage = store.begin_document_index().unwrap();
            let mut reused = 0;
            let mut cache_hits = 0;
            for _ in 0..10_004 {
                let progress = store.pump_document_index(&stage).unwrap();
                reused += progress.reused_documents;
                cache_hits += progress.parse_cache.hits;
                if progress.ready {
                    store.publish_document_index(&stage).unwrap();
                    return (start.elapsed().as_millis(), reused, cache_hits);
                }
            }
            panic!("normal10k index did not complete within finite pump bound");
        }
        fn search(store: &Store, value: &str) -> Vec<EntryId> {
            let pin = store.open_document_snapshot().unwrap();
            assert_eq!(pin.generation().manifest().entries().len(), 10_000);
            let query = zorid_index::LiteralQuery::new(value).unwrap();
            let mut token = None;
            let mut found = Vec::new();
            for _ in 0..10_004 {
                let page = store
                    .literal_document_page(&pin, query.clone(), token.as_ref(), 128)
                    .unwrap();
                found.extend(page.hits.into_iter().map(|hit| hit.entry.id));
                if page.complete {
                    return found;
                }
                token = page.next;
                assert!(
                    token.is_some(),
                    "incomplete normal10k search lost continuation"
                );
            }
            panic!("normal10k query did not complete within finite page bound");
        }
        let (dir, mut store) = fixture();
        let cache = dir.path().join("document-cache.sqlite");
        store.enable_document_cache(&cache).unwrap();
        store.initialize_document_index().unwrap();
        let start = std::time::Instant::now();
        for n in 0..10_000 {
            store
                .family_apply(&create(n), Some(FamilyCreateMode::Text))
                .unwrap();
            if (n + 1) % 1_000 == 0 {
                println!(
                    "normal10k phase=create notes={} elapsed_ms={}",
                    n + 1,
                    start.elapsed().as_millis()
                );
            }
        }
        let created_ms = start.elapsed().as_millis();
        assert_eq!(store.family_status().unwrap().graph_records, 20_000);
        let (cold_index_ms, _, _) = build(&mut store);
        assert_eq!(
            search(&store, "Note 9999"),
            vec![EntryId::new("note-9999").unwrap()]
        );
        let first = write(&store, 0);
        let start = std::time::Instant::now();
        store.family_apply(&first, None).unwrap();
        let first_us = start.elapsed().as_micros();
        let last = write(&store, 9_999);
        let start = std::time::Instant::now();
        store.family_apply(&last, None).unwrap();
        let last_us = start.elapsed().as_micros();
        let (incremental_index_ms, reused, cache_hits) = build(&mut store);
        assert_eq!(
            reused, 9_998,
            "unchanged note parser records must be reused"
        );
        let mut found = search(&store, "changed");
        found.sort();
        assert_eq!(
            found,
            vec![
                EntryId::new("note-0").unwrap(),
                EntryId::new("note-9999").unwrap()
            ]
        );
        let source = store.capture_document_manifest().unwrap();
        assert_eq!(source.manifest().unwrap().entries().len(), 10_000);
        drop(store);
        let mut reopened = Store::open(dir.path().join("store")).unwrap();
        reopened.enable_document_cache(&cache).unwrap();
        reopened.family_apply(&first, None).unwrap();
        reopened.family_apply(&last, None).unwrap();
        let mut after_reopen = search(&reopened, "changed");
        after_reopen.sort();
        assert_eq!(after_reopen, found);
        assert_eq!(reopened.capture_document_manifest().unwrap(), source);
        for n in [0, 9_999] {
            let id = EntryId::new(format!("note-{n}")).unwrap();
            let row = reopened.read(&id).unwrap().unwrap();
            assert_eq!(row.content.as_deref(), Some(b"changed\n".as_slice()));
            let current = reopened.family_materialization(&id).unwrap().unwrap();
            assert_eq!(
                reopened
                    .family_publication(&id, &row.state.revision)
                    .unwrap()
                    .unwrap(),
                current
            );
            let tx = reopened.connection.unchecked_transaction().unwrap();
            family_materialization::check_publication(&tx, &row.state, row.content.as_deref())
                .unwrap();
        }
        println!("normal10k create_ms={created_ms} cold_index_ms={cold_index_ms} first_write_us={first_us} last_write_us={last_us} incremental_index_ms={incremental_index_ms} reused={reused} cache_hits={cache_hits}");
    }
}
