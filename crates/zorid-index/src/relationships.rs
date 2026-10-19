//! Snapshot-bound links derived from the same immutable metadata and namespace.
//! No graph deserialization, source IO or second resolver authority.
use crate::{
    Generation, IndexError, IndexSnapshotId, PreparedNamespace, Resolver, SourceSnapshotId,
    MAX_GENERATION_METADATA_BYTES,
};
use serde::Serialize;
use zorid_core::{EntryId, EntryState};
use zorid_document::Link;

/// One parsed link occurrence, including unresolved/external destinations.
/// Target selection follows the shared resolver; metadata ranges remain original.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEdge {
    source: EntryState,
    link_index: u32,
    link: Link,
    target: Option<EntryState>,
}
impl ResolvedEdge {
    pub fn source(&self) -> &EntryState {
        &self.source
    }
    pub fn link_index(&self) -> u32 {
        self.link_index
    }
    pub fn link(&self) -> &Link {
        &self.link
    }
    pub fn target(&self) -> Option<&EntryState> {
        self.target.as_ref()
    }
}

/// Owned, validated relationship view, constructed only from a Generation.
/// Serialized output is a report, never a capability that may be deserialized
/// back into a coherent graph. The namespace is retained privately for arbitrary
/// file.hasLink/asFile targets using exactly the same resolver and snapshot.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionSnapshot {
    snapshot_id: IndexSnapshotId,
    source: SourceSnapshotId,
    complete: bool,
    edges: Vec<ResolvedEdge>,
    #[serde(skip)]
    namespace: PreparedNamespace,
    #[serde(skip)]
    retained_bytes: usize,
}
impl ResolutionSnapshot {
    pub fn snapshot_id(&self) -> &IndexSnapshotId {
        &self.snapshot_id
    }
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
    pub fn complete(&self) -> bool {
        self.complete
    }
    pub fn edges(&self) -> &[ResolvedEdge] {
        &self.edges
    }
    /// Construct once per consumer query and reuse for arbitrary destinations.
    /// This borrows this graph's namespace, never today's source inventory.
    pub fn resolver(&self) -> Resolver<'_> {
        self.namespace
            .resolver_checked(&mut |_| Ok::<(), IndexError>(()))
            .expect("infallible checkpoint")
    }
    /// Preserve consumer work/cancellation accounting while preparing the same
    /// private immutable namespace for arbitrary hasLink/asFile destinations.
    pub fn resolver_checked<E>(
        &self,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Resolver<'_>, E> {
        self.namespace.resolver_checked(check)
    }
    /// Share the exact namespace already prepared during graph construction.
    /// This checks cancellation and charges only handle acquisition, not a
    /// fictitious second namespace rebuild.
    pub fn prepare_namespace_checked<E>(
        &self,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<PreparedNamespace, E> {
        check(0)?;
        check(1)?;
        Ok(self.namespace.clone())
    }
    /// Conservative graph allocation charge, including its full shared namespace
    /// charge. Shared handles can outlive any one graph/cache owner.
    pub fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }
    pub fn resolve(
        &self,
        source: &EntryId,
        destination: &str,
    ) -> Result<Vec<&EntryState>, IndexError> {
        self.resolver().candidates(source, destination)
    }
}

/// A prebuilt namespace resolver tied to one immutable generation.
pub struct ResolutionView<'a> {
    generation: &'a Generation,
    resolver: Resolver<'a>,
}
impl<'a> ResolutionView<'a> {
    pub fn new(generation: &'a Generation) -> Self {
        Self {
            generation,
            resolver: Resolver::new(generation.manifest()),
        }
    }
    pub fn snapshot_id(&self) -> &IndexSnapshotId {
        self.generation.id()
    }
    pub fn source(&self) -> &SourceSnapshotId {
        self.generation.manifest().source()
    }
    pub fn resolve(
        &self,
        source: &EntryId,
        destination: &str,
    ) -> Result<Vec<&'a EntryState>, IndexError> {
        self.resolver.candidates(source, destination)
    }
    /// Produce all occurrences in manifest path/id then parser link order.
    /// Resource failure returns an explicit error; no truncated graph claims
    /// completeness. Complete=false means source/extraction exclusions remain.
    /// max_bytes bounds the exact serialized report, with a 64MiB hard ceiling.
    pub fn snapshot(
        &self,
        max_edges: usize,
        max_bytes: usize,
    ) -> Result<ResolutionSnapshot, IndexError> {
        self.snapshot_with(max_edges, max_bytes, &mut |_| Ok::<(), IndexError>(()))
    }
    /// Controlled construction begins BEFORE resolver/namespace allocation.
    /// The host callback charges work and checks cancellation; its error remains
    /// intact. Namespace, records, edges and resolver visits are checkpointed;
    /// sorting reserves conservative comparison work before running.
    pub fn snapshot_checked<E: From<IndexError>>(
        generation: &'a Generation,
        max_edges: usize,
        max_bytes: usize,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<ResolutionSnapshot, E> {
        check(0)?;
        if max_bytes == 0 || max_bytes > MAX_GENERATION_METADATA_BYTES {
            return Err(E::from(IndexError::InvalidBudget));
        }
        let resolver = Resolver::new_checked(generation.manifest(), &mut check)?;
        Self {
            generation,
            resolver,
        }
        .snapshot_with(max_edges, max_bytes, &mut check)
    }
    fn snapshot_with<E: From<IndexError>>(
        &self,
        max_edges: usize,
        max_bytes: usize,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<ResolutionSnapshot, E> {
        check(0)?;
        if max_bytes == 0 || max_bytes > MAX_GENERATION_METADATA_BYTES {
            return Err(E::from(IndexError::InvalidBudget));
        }
        // Charge coverage before scanning it; the owned namespace factory
        // separately charges the one exact manifest clone and reuses tables.
        check(self.generation.manifest().entries().len())?;
        let namespace = self.resolver.owned_namespace_checked(check)?;
        let mut result = ResolutionSnapshot {
            snapshot_id: self.snapshot_id().clone(),
            source: self.source().clone(),
            complete: self.generation.coverage_complete(),
            edges: Vec::new(),
            namespace,
            retained_bytes: 0,
        };
        let mut bytes = serde_json::to_vec(&result)
            .map_err(|_| E::from(IndexError::InvalidRecord))?
            .len();
        if bytes > max_bytes {
            return Err(E::from(IndexError::GenerationLimit));
        }
        for record in self.generation.records() {
            check(1)?;
            let Some(metadata) = record.metadata() else {
                continue;
            };
            for (n, link) in metadata.links.iter().enumerate() {
                check(1)?;
                if result.edges.len() >= max_edges {
                    return Err(E::from(IndexError::GenerationLimit));
                }
                let target = self
                    .resolver
                    .candidates_checked(&record.witness().entry().id, &link.destination, check)?
                    .first()
                    .map(|entry| (*entry).clone());
                let edge = ResolvedEdge {
                    source: record.witness().entry().clone(),
                    link_index: u32::try_from(n)
                        .map_err(|_| E::from(IndexError::GenerationLimit))?,
                    link: link.clone(),
                    target,
                };
                bytes = bytes
                    .checked_add(
                        serde_json::to_vec(&edge)
                            .map_err(|_| E::from(IndexError::InvalidRecord))?
                            .len(),
                    )
                    .and_then(|n| n.checked_add(usize::from(!result.edges.is_empty())))
                    .ok_or_else(|| E::from(IndexError::GenerationLimit))?;
                if bytes > max_bytes {
                    return Err(E::from(IndexError::GenerationLimit));
                }
                result.edges.push(edge);
            }
        }
        let versions = result.snapshot_id.versions();
        let mut retained_bytes = std::mem::size_of::<ResolutionSnapshot>()
            .saturating_add(result.namespace.retained_bytes())
            .saturating_add(
                result
                    .edges
                    .capacity()
                    .saturating_mul(std::mem::size_of::<ResolvedEdge>()),
            )
            .saturating_add(result.snapshot_id.local_store_id().as_str().len())
            .saturating_add(result.snapshot_id.generation_epoch().as_str().len())
            .saturating_add(versions.extraction().len())
            .saturating_add(versions.resolver().len())
            .saturating_add(versions.query().len())
            .saturating_add(result.source.local_store_id().as_str().len())
            .saturating_add(result.source.watermark().as_str().len());
        for edge in &result.edges {
            check(1)?;
            retained_bytes = retained_bytes
                .saturating_add(crate::resolver::entry_heap_bytes(&edge.source))
                .saturating_add(
                    edge.target
                        .as_ref()
                        .map_or(0, crate::resolver::entry_heap_bytes),
                )
                .saturating_add(edge.link.target.capacity())
                .saturating_add(edge.link.fragment.capacity())
                .saturating_add(edge.link.destination.capacity());
        }
        result.retained_bytes = retained_bytes;
        check(0)?;
        Ok(result)
    }
}

/// Direction of a metadata relationship query. Embedded links are included in
/// outgoing/incoming; Embeds selects only outgoing embedded occurrences.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipDirection {
    Outgoing,
    Incoming,
    Embeds,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipToken {
    snapshot: IndexSnapshotId,
    entry: EntryId,
    direction: RelationshipDirection,
    offset: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipPage {
    pub snapshot: IndexSnapshotId,
    pub edges: Vec<ResolvedEdge>,
    pub next: Option<RelationshipToken>,
    pub scan_complete: bool,
    pub coverage_complete: bool,
    pub complete: bool,
}
impl ResolutionSnapshot {
    /// Bounded occurrence page, ordered exactly as edges(). Continuation binds
    /// entry, direction and full snapshot identity. Never reports complete when
    /// source/extraction exclusions leave the graph incomplete.
    pub fn query(
        &self,
        entry: &EntryId,
        direction: RelationshipDirection,
        token: Option<&RelationshipToken>,
        limit: usize,
    ) -> Result<RelationshipPage, IndexError> {
        if !(1..=1000).contains(&limit) {
            return Err(IndexError::InvalidBudget);
        }
        self.namespace.manifest().witness(entry)?;
        let mut offset = 0;
        if let Some(token) = token {
            if token.snapshot != self.snapshot_id {
                return Err(IndexError::SnapshotExpired);
            }
            if token.entry != *entry || token.direction != direction {
                return Err(IndexError::QueryMismatch);
            }
            if token.offset >= self.edges.len() {
                return Err(IndexError::SnapshotExpired);
            }
            offset = token.offset;
        }
        let mut edges = Vec::new();
        let mut bytes = 8192usize; // bounded identity, token and report envelope
        while offset < self.edges.len() {
            let edge = &self.edges[offset];
            let matches = match direction {
                RelationshipDirection::Outgoing => edge.source.id == *entry,
                RelationshipDirection::Incoming => edge
                    .target
                    .as_ref()
                    .is_some_and(|target| target.id == *entry),
                RelationshipDirection::Embeds => edge.source.id == *entry && edge.link.embed,
            };
            if matches {
                let size = serde_json::to_vec(edge)
                    .map_err(|_| IndexError::InvalidRecord)?
                    .len()
                    + 1;
                if bytes + size > crate::MAX_PUMP_BYTES {
                    if edges.is_empty() {
                        return Err(IndexError::GenerationLimit);
                    }
                    break;
                }
                bytes += size;
                edges.push(edge.clone());
            }
            offset += 1;
            if edges.len() == limit {
                break;
            }
        }
        let scan_complete = offset == self.edges.len();
        let next = (!scan_complete).then(|| RelationshipToken {
            snapshot: self.snapshot_id.clone(),
            entry: entry.clone(),
            direction,
            offset,
        });
        Ok(RelationshipPage {
            snapshot: self.snapshot_id.clone(),
            edges,
            next,
            scan_complete,
            coverage_complete: self.complete,
            complete: scan_complete && self.complete,
        })
    }
}
