//! Author filesystem namespace observations against their saved causal frontier.
//! The host supplies immutable physical publication witnesses, proves actual inode/
//! path observations, and atomically compares those witnesses plus the graph before
//! persisting these exact payloads. Valid graph history alone is NOT physical proof.
//! No filesystem access, current-descendant expansion, text mutation or receipt here.
use crate::metadata::MetadataState;
use crate::metadata_plan::{prepare_authored_batch, AuthoredMetadataBatch, MetadataCandidate};
use crate::{
    mutation::AuthoredFile, v2, EntryIdentity, Error, Family, Liveness, Location, Result,
    MAX_EVENTS, MAX_PARENTS, MAX_RECORDS,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zorid_core::{EntryId, EntryKind, Revision, VaultPath};
use zorid_sync_protocol::UpdateId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalNamespaceBaseline {
    pub identity: EntryIdentity,
    pub physical_revision: Revision,
    /// Actual saved physical path; ancestors may have moved since publication.
    pub path: VaultPath,
    pub kind: EntryKind,
    pub heads: Vec<UpdateId>,
    pub location_event: UpdateId,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalNamespaceAction {
    Move { root: EntryId, target: Location },
    Delete { root: EntryId },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allocation {
    pub next_revision: Revision,
    /// One ID for Move; one per baseline for Delete, in stable EntryId order.
    /// Each sole event uses its envelope ID, avoiding nested-ID ledger ambiguity.
    pub update_ids: Vec<UpdateId>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub expected_graph: v2::State,
    pub expected_baselines: Vec<PhysicalNamespaceBaseline>,
    pub next_graph: v2::State,
    pub authored: Vec<AuthoredFile>,
    pub allocated_update_ids: Vec<UpdateId>,
}
impl Plan {
    /// The host obtains baselines from immutable physical history inside the same
    /// transaction, not from a caller's echo of this plan. It must also reserve a
    /// globally unused graph revision and fence every allocated ID across families.
    pub fn check_preconditions(
        &self,
        graph: &v2::State,
        baselines: &[PhysicalNamespaceBaseline],
        all_update_ids_unused: bool,
    ) -> Result<()> {
        if graph != &self.expected_graph || baselines != self.expected_baselines {
            return Err(Error::VersionConflict);
        }
        if !all_update_ids_unused {
            return Err(Error::DuplicateMismatch);
        }
        Ok(())
    }
}

/// Namespace-only payloads plus an unverified metadata candidate. Physical
/// baselines remain independent immutable host witnesses; finalization requires
/// the exact candidate's complete retained binary verification set.
#[derive(Debug)]
pub struct MetadataNamespacePlan {
    expected_baselines: Vec<PhysicalNamespaceBaseline>,
    authored: Vec<AuthoredFile>,
    allocated_update_ids: Vec<UpdateId>,
    candidate: MetadataCandidate,
}
impl MetadataNamespacePlan {
    pub fn expected_baselines(&self) -> &[PhysicalNamespaceBaseline] {
        &self.expected_baselines
    }
    pub fn authored(&self) -> &[AuthoredFile] {
        &self.authored
    }
    pub fn allocated_update_ids(&self) -> &[UpdateId] {
        &self.allocated_update_ids
    }
    pub fn candidate(&self) -> &MetadataCandidate {
        &self.candidate
    }
    pub fn check_preconditions(
        &self,
        state: &MetadataState,
        baselines: &[PhysicalNamespaceBaseline],
        all_update_ids_unused: bool,
    ) -> Result<()> {
        if state != self.candidate.expected_state() || baselines != self.expected_baselines {
            return Err(Error::VersionConflict);
        }
        if !all_update_ids_unused {
            return Err(Error::DuplicateMismatch);
        }
        Ok(())
    }
    pub fn into_parts(
        self,
    ) -> (
        Vec<PhysicalNamespaceBaseline>,
        Vec<AuthoredFile>,
        Vec<UpdateId>,
        MetadataCandidate,
    ) {
        (
            self.expected_baselines,
            self.authored,
            self.allocated_update_ids,
            self.candidate,
        )
    }
}

/// Validate canonical saved frontiers against actual retained historical events.
/// This proves their same-entry bootstrap, kind, liveness and selected location;
/// it cannot prove the supplied physical revision/path ever reached the disk.
/// Parent moves are independent events, so full saved paths are host witnesses.
pub fn validate_baselines(
    graph: &v2::State,
    baselines: &[PhysicalNamespaceBaseline],
) -> Result<()> {
    validated_locations(graph, baselines).map(|_| ())
}
fn validated_locations(
    graph: &v2::State,
    baselines: &[PhysicalNamespaceBaseline],
) -> Result<BTreeMap<EntryId, Location>> {
    validate_baseline_order(baselines)?;
    let (_, ancestry) = graph.view_and_ancestry()?;
    validated_locations_from_ancestry(&ancestry, baselines)
}

/// Metadata-only validation of the same historical physical namespace cuts.
/// Missing binary data does not invalidate a saved namespace frontier; complete
/// binary content still requires verification before the host commits a plan.
pub fn validate_metadata_baselines(
    graph: &MetadataState,
    baselines: &[PhysicalNamespaceBaseline],
) -> Result<()> {
    metadata_locations(graph, baselines).map(|_| ())
}

fn metadata_locations(
    graph: &MetadataState,
    baselines: &[PhysicalNamespaceBaseline],
) -> Result<BTreeMap<EntryId, Location>> {
    validate_baseline_order(baselines)?;
    let (_, ancestry) = graph.view_and_ancestry()?;
    validated_locations_from_ancestry(&ancestry, baselines)
}

fn validate_baseline_order(baselines: &[PhysicalNamespaceBaseline]) -> Result<()> {
    if baselines.is_empty() || baselines.len() > MAX_EVENTS {
        return Err(Error::TooLarge);
    }
    if baselines
        .windows(2)
        .any(|pair| pair[0].identity.entry_id >= pair[1].identity.entry_id)
    {
        return Err(Error::InvalidState);
    }
    Ok(())
}

fn validated_locations_from_ancestry(
    ancestry: &crate::GraphAncestry,
    baselines: &[PhysicalNamespaceBaseline],
) -> Result<BTreeMap<EntryId, Location>> {
    let mut paths = BTreeSet::new();
    let mut indexed = BTreeMap::new();
    for baseline in baselines {
        if !paths.insert(&baseline.path) {
            return Err(Error::InvalidLocation);
        }
        if baseline.heads.is_empty() || baseline.heads.len() > MAX_PARENTS {
            return Err(Error::InvalidCausality);
        }
        if baseline.heads.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(Error::InvalidCausality);
        }
        for head in &baseline.heads {
            if ancestry.resolved_event(head)?.identity != baseline.identity {
                return Err(Error::IdentityMismatch);
            }
            for other in &baseline.heads {
                if head != other && ancestry.is_ancestor(head, other)? {
                    return Err(Error::InvalidCausality);
                }
            }
        }
        indexed.insert(&baseline.identity.entry_id, baseline);
    }
    // Reuse the existing namespace derivation on the union of these per-entry
    // historical cuts. Cross-entry physical paths are deliberately not derived
    // from this mixture of publication times. Content pages are unnecessary for
    // historical namespace selection; missing binary content is never published.
    let mut historical = BTreeMap::new();
    for (id, event) in &ancestry.events {
        if !ancestry.ancestors.contains_key(id) {
            continue;
        }
        if let Some(baseline) = indexed.get(&event.identity.entry_id) {
            let mut observed = false;
            for head in &baseline.heads {
                if id == head || ancestry.is_ancestor(id, head)? {
                    observed = true;
                    break;
                }
            }
            if observed {
                historical.insert(id.clone(), event.clone());
            }
        }
    }
    let (historical, _) = crate::derive_graph_with_status(historical, |manifest| {
        manifest.validate()?;
        Ok(crate::ContentStatus {
            missing: manifest.pages.iter().map(|page| page.id.clone()).collect(),
        })
    })?;
    let mut locations = BTreeMap::new();
    for baseline in baselines {
        let entry = historical
            .entries
            .get(&baseline.identity.entry_id)
            .ok_or(Error::InvalidCausality)?;
        let location = entry.locations.last().ok_or(Error::InvalidLocation)?;
        if entry.identity != baseline.identity || entry.kind != baseline.kind {
            return Err(Error::IdentityMismatch);
        }
        if entry.heads != baseline.heads || entry.liveness != Liveness::Live {
            return Err(Error::InvalidCausality);
        }
        if location.event != baseline.location_event
            || location.location.name != baseline.path.file_name()
        {
            return Err(Error::InvalidLocation);
        }
        // A root location has a fully verifiable path; otherwise only the leaf
        // and any explicitly supplied physical ancestor chain can be checked.
        if location.location.parent.is_none() && baseline.path.parent().is_some() {
            return Err(Error::InvalidLocation);
        }
        locations.insert(
            baseline.identity.entry_id.clone(),
            location.location.clone(),
        );
    }
    Ok(locations)
}

pub fn plan_external_namespace(
    graph: &v2::State,
    baselines: &[PhysicalNamespaceBaseline],
    action: &ExternalNamespaceAction,
    allocation: &Allocation,
) -> Result<Plan> {
    let locations = validated_locations(graph, baselines)?;
    if &allocation.next_revision == graph.version() {
        return Err(Error::VersionConflict);
    }
    let (_, ancestry) = graph.view_and_ancestry()?;
    let reserved = reserved_namespace_ids(
        &ancestry,
        graph.records().iter().map(|(id, record)| {
            (
                id,
                match &record.body {
                    v2::Body::Page { page } => Some(page),
                    _ => None,
                },
            )
        }),
    );
    let authored = authored_namespace(
        graph.scope(),
        baselines,
        &locations,
        action,
        allocation,
        graph.records().len() + graph.activities().len(),
        |id| reserved.contains(id),
    )?;
    let mut records = graph.records().clone();
    for file in &authored {
        records.insert(
            file.update_id.clone(),
            v2::Payload::decode(&file.payload_bytes)?,
        );
    }
    let next_graph = v2::State::from_records(
        graph.scope().clone(),
        allocation.next_revision.clone(),
        records,
        graph.activities().clone(),
    )?;
    let view = next_graph.view()?;
    if allocation
        .update_ids
        .iter()
        .any(|id| view.namespace.pending.contains(id))
    {
        return Err(Error::InvalidCausality);
    }
    Ok(Plan {
        expected_graph: graph.clone(),
        expected_baselines: baselines.to_vec(),
        next_graph,
        authored,
        allocated_update_ids: allocation.update_ids.clone(),
    })
}

/// Prepare external namespace authorship against the saved physical frontier,
/// retaining only metadata and bounded Move/Delete payloads. No current remote
/// descendants or current heads are substituted for captured physical witnesses.
pub fn prepare_metadata_namespace(
    graph: &MetadataState,
    baselines: &[PhysicalNamespaceBaseline],
    action: &ExternalNamespaceAction,
    allocation: &Allocation,
) -> Result<MetadataNamespacePlan> {
    let locations = metadata_locations(graph, baselines)?;
    if &allocation.next_revision == graph.version() {
        return Err(Error::VersionConflict);
    }
    let (_, ancestry) = graph.view_and_ancestry()?;
    let reserved = reserved_namespace_ids(
        &ancestry,
        graph.records().iter().map(|(id, record)| {
            (
                id,
                match record.body() {
                    crate::metadata::GraphRecordBody::Page { page } => Some(page),
                    _ => None,
                },
            )
        }),
    );
    let authored = authored_namespace(
        graph.scope(),
        baselines,
        &locations,
        action,
        allocation,
        graph.records().len() + graph.activities().len(),
        |id| reserved.contains(id),
    )?;
    let mut batch = AuthoredMetadataBatch::new(graph.scope().clone());
    for file in &authored {
        batch.push_exact(&file.payload_bytes)?;
    }
    let candidate = prepare_authored_batch(graph, batch, allocation.next_revision.clone())?;
    Ok(MetadataNamespacePlan {
        expected_baselines: baselines.to_vec(),
        authored,
        allocated_update_ids: allocation.update_ids.clone(),
        candidate,
    })
}

// A missing dependency still reserves its identity. Earlier external planning
// checked only present rows/events, allowing a fresh same-entry local event to
// impersonate a missing remote parent. Match local-command allocation fences on
// both namespace paths and reject every observed role/reference before emission.
fn reserved_namespace_ids<'a>(
    ancestry: &crate::GraphAncestry,
    records: impl Iterator<Item = (&'a UpdateId, Option<&'a crate::ChunkPage>)>,
) -> BTreeSet<UpdateId> {
    let mut reserved = BTreeSet::new();
    for (id, page) in records {
        reserved.insert(id.clone());
        if let Some(page) = page {
            reserved.extend(page.chunks.iter().map(|chunk| chunk.id.clone()));
        }
    }
    for event in ancestry.events.values() {
        reserved.insert(event.id.clone());
        reserved.insert(event.identity.bootstrap_id.clone());
        reserved.extend(event.parents.iter().cloned());
        match &event.effect {
            crate::GraphEffect::Create {
                content: Some(manifest),
                ..
            }
            | crate::GraphEffect::SetContent { content: manifest } => {
                reserved.extend(manifest.pages.iter().map(|page| page.id.clone()));
            }
            crate::GraphEffect::CreateText { binding, .. }
            | crate::GraphEffect::TextActivity { binding } => {
                reserved.insert(binding.text_bootstrap_id.clone());
            }
            _ => (),
        }
    }
    reserved
}

fn authored_namespace(
    scope: &crate::Scope,
    baselines: &[PhysicalNamespaceBaseline],
    locations: &BTreeMap<EntryId, Location>,
    action: &ExternalNamespaceAction,
    allocation: &Allocation,
    existing_records: usize,
    mut id_occupied: impl FnMut(&UpdateId) -> bool,
) -> Result<Vec<AuthoredFile>> {
    let (root, moving) = match action {
        ExternalNamespaceAction::Move { root, target } => {
            target.validate()?;
            (root, true)
        }
        ExternalNamespaceAction::Delete { root } => (root, false),
    };
    let root_baseline = baselines
        .iter()
        .find(|b| &b.identity.entry_id == root)
        .ok_or(Error::IdentityMismatch)?;
    if baselines.len() > 1 && root_baseline.kind != EntryKind::Folder {
        return Err(Error::InvalidLocation);
    }
    let by_path: BTreeMap<_, _> = baselines.iter().map(|b| (&b.path, b)).collect();
    for baseline in baselines.iter().filter(|b| &b.identity.entry_id != root) {
        if !baseline.path.is_descendant_of(&root_baseline.path) {
            return Err(Error::InvalidLocation);
        }
        let parent_path = baseline.path.parent().ok_or(Error::InvalidLocation)?;
        let parent = by_path.get(&parent_path).ok_or(Error::InvalidLocation)?;
        if parent.kind != EntryKind::Folder
            || locations[&baseline.identity.entry_id].parent.as_ref()
                != Some(&parent.identity.entry_id)
        {
            return Err(Error::InvalidLocation);
        }
    }
    if let ExternalNamespaceAction::Move { target, .. } = action {
        if target == &locations[root]
            || target
                .parent
                .as_ref()
                .is_some_and(|parent| baselines.iter().any(|b| &b.identity.entry_id == parent))
        {
            return Err(Error::InvalidLocation);
        }
    }
    let count = if moving { 1 } else { baselines.len() };
    if allocation.update_ids.len() != count
        || existing_records
            .checked_add(count)
            .is_none_or(|total| total > MAX_RECORDS)
    {
        return Err(Error::TooLarge);
    }
    let mut unused = BTreeSet::new();
    for id in &allocation.update_ids {
        if !unused.insert(id) || id_occupied(id) {
            return Err(Error::DuplicateMismatch);
        }
    }
    let affected: Vec<_> = if moving {
        vec![root_baseline]
    } else {
        baselines.iter().collect()
    };
    let mut authored = Vec::with_capacity(count);
    for (baseline, update_id) in affected.into_iter().zip(&allocation.update_ids) {
        let effect = match action {
            ExternalNamespaceAction::Move { target, .. } => v2::Effect::Move {
                location: target.clone(),
            },
            ExternalNamespaceAction::Delete { .. } => v2::Effect::Delete,
        };
        let payload = v2::Payload {
            family: Family::Files,
            format_version: v2::FORMAT_VERSION,
            scope: scope.clone(),
            id: update_id.clone(),
            body: v2::Body::Events {
                events: vec![v2::EntryEvent {
                    id: update_id.clone(),
                    identity: baseline.identity.clone(),
                    parents: baseline.heads.clone(),
                    effect,
                }],
            },
        };
        let payload_bytes = payload.encode()?;
        authored.push(AuthoredFile {
            update_id: update_id.clone(),
            payload_bytes,
        });
    }
    Ok(authored)
}

#[cfg(test)]
#[path = "external_namespace_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "metadata_external_namespace_tests.rs"]
mod metadata_tests;
