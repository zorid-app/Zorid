//! Snapshot-bound relationship adaptation. The index owns parsing and resolution.
use crate::{
    expression::{BasesFile, BasesLink},
    BaseProgram, BaseQueryResult, BaseSnapshot, DetachedRecord, ExpressionDiagnostic, QueryOptions,
    RecordWitness,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use zorid_core::EntryId;
use zorid_index::{Generation, PreparedNamespace, ResolutionSnapshot, ResolutionView};

pub const MAX_RELATIONSHIP_EDGES: usize = 100_000;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilePresentationFacts {
    pub witness: RecordWitness,
    pub size: Option<u64>,
    pub ctime_ms: Option<i64>,
    pub mtime_ms: Option<i64>,
}
/// Current revision extraction evidence, including unavailable source and parser diagnostics.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataIssue {
    pub witness: RecordWitness,
    pub exclusion: Option<zorid_index::Exclusion>,
    pub diagnostics: Vec<zorid_document::Diagnostic>,
    pub properties_unavailable: bool,
}
fn index_error(error: zorid_index::IndexError) -> ExpressionDiagnostic {
    let code = if matches!(
        error,
        zorid_index::IndexError::GenerationLimit | zorid_index::IndexError::InvalidBudget
    ) {
        "budget"
    } else {
        "relationship"
    };
    ExpressionDiagnostic::new(code, error.to_string())
}
impl From<zorid_index::IndexError> for ExpressionDiagnostic {
    fn from(error: zorid_index::IndexError) -> Self {
        index_error(error)
    }
}
fn charge(
    remaining: &mut usize,
    cancellation: Option<&crate::OperationCancellation>,
    work: usize,
) -> Result<(), ExpressionDiagnostic> {
    if cancellation.is_some_and(|c| c.stop_reason().is_some()) {
        return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
    }
    *remaining = remaining.checked_sub(work).ok_or_else(|| {
        ExpressionDiagnostic::new("budget", "Generation preparation exceeds query work budget")
    })?;
    Ok(())
}
impl BaseSnapshot {
    /// Metadata, paths and graph derive solely from this immutable generation.
    /// Facts may add only host file presentation fields with exact witnesses.
    pub fn from_generation(
        generation: &Generation,
        facts: &[FilePresentationFacts],
    ) -> Result<Self, ExpressionDiagnostic> {
        let mut remaining = crate::MAX_QUERY_STEPS;
        Self::from_generation_checked(generation, facts, &mut |work| {
            charge(&mut remaining, None, work)
        })
    }
    pub(crate) fn from_generation_checked(
        generation: &Generation,
        facts: &[FilePresentationFacts],
        check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<Self, ExpressionDiagnostic> {
        check(0)?;
        if facts.len() > crate::MAX_QUERY_SCANNED {
            return Err(ExpressionDiagnostic::new("budget", "Too many file facts"));
        }
        let mut by_id = HashMap::new();
        for fact in facts {
            check(1)?;
            let record = generation.record(&fact.witness.entry_id).ok_or_else(|| {
                ExpressionDiagnostic::new("stale-source", "File fact is absent from generation")
            })?;
            if record.witness().entry().revision != fact.witness.revision
                || by_id.insert(&fact.witness.entry_id, fact).is_some()
            {
                return Err(ExpressionDiagnostic::new(
                    "stale-source",
                    "Duplicate or stale file facts",
                ));
            }
        }
        let mut records = Vec::new();
        let mut metadata_issues = Vec::new();
        let mut bytes = crate::encoded_size(
            &serde_json::json!({"snapshotId":generation.id(),"records":[],"relationships":null,"metadataIssues":[]}),
            crate::MAX_BASE_REQUEST_BYTES,
        )?;
        for record in generation.records() {
            check(
                1 + record
                    .metadata()
                    .map_or(0, |m| m.properties.len().saturating_mul(2) + m.tags.len()),
            )?;
            if records.len() >= crate::MAX_QUERY_SCANNED {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Too many generation records",
                ));
            }
            let entry = record.witness().entry();
            let facts = by_id.get(&entry.id);
            let metadata = record.metadata();
            let properties_unavailable = record.exclusion().is_some_and(|e| e.limits_coverage())
                || metadata.is_some_and(|m| {
                    matches!(
                        m.frontmatter.state,
                        zorid_document::FrontmatterState::Invalid
                            | zorid_document::FrontmatterState::Unclosed
                    )
                });
            if record.exclusion().is_some() || metadata.is_some_and(|m| !m.diagnostics.is_empty()) {
                metadata_issues.push(MetadataIssue {
                    witness: RecordWitness {
                        entry_id: entry.id.clone(),
                        revision: entry.revision.clone(),
                    },
                    exclusion: record.exclusion().cloned(),
                    diagnostics: metadata.map(|m| m.diagnostics.clone()).unwrap_or_default(),
                    properties_unavailable,
                });
                bytes = bytes
                    .saturating_add(crate::encoded_size(
                        metadata_issues.last().expect("just inserted"),
                        crate::MAX_BASE_REQUEST_BYTES,
                    )?)
                    .saturating_add(usize::from(metadata_issues.len() > 1));
            }

            let row = DetachedRecord {
                witness: Some(RecordWitness {
                    entry_id: entry.id.clone(),
                    revision: entry.revision.clone(),
                }),
                path: entry.path.as_str().into(),
                properties: metadata
                    .map(|m| {
                        m.properties
                            .iter()
                            .map(|p| (p.key.clone(), p.value.clone()))
                            .collect()
                    })
                    .unwrap_or_default(),
                property_types: metadata
                    .map(|m| {
                        m.properties
                            .iter()
                            .map(|p| (p.key.clone(), p.property_type.clone()))
                            .collect()
                    })
                    .unwrap_or_default(),
                tags: metadata.map(|m| m.tags.clone()).unwrap_or_default(),
                size: facts
                    .and_then(|f| f.size)
                    .or_else(|| record.text_digest().map(|_| record.text_bytes() as u64)),
                ctime_ms: facts.and_then(|f| f.ctime_ms),
                mtime_ms: facts.and_then(|f| f.mtime_ms),
            };
            bytes = bytes
                .saturating_add(crate::encoded_size(&row, crate::MAX_BASE_REQUEST_BYTES)?)
                .saturating_add(usize::from(!records.is_empty()));
            if bytes > crate::MAX_BASE_REQUEST_BYTES {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Generation rows exceed Base input budget",
                ));
            }
            records.push(row);
        }
        let relationships = ResolutionView::snapshot_checked(
            generation,
            MAX_RELATIONSHIP_EDGES,
            crate::MAX_BASE_REQUEST_BYTES
                .saturating_sub(bytes)
                .saturating_add(4)
                .min(crate::MAX_BASE_REQUEST_BYTES),
            check,
        )?;
        Ok(Self {
            snapshot_id: generation.id().clone(),
            records,
            relationships: Some(relationships),
            metadata_issues,
            property_values: None,
        })
    }
}
pub fn query_generation(
    program: &BaseProgram,
    generation: &Generation,
    facts: &[FilePresentationFacts],
    options: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    preflight_generation(generation, options)?;
    let mut remaining = options.max_steps;
    let snapshot = BaseSnapshot::from_generation_checked(generation, facts, &mut |work| {
        charge(
            &mut remaining,
            options.evaluation.cancellation.as_ref(),
            work,
        )
    })?;
    let used = options.max_steps - remaining;
    let mut invocation = options.clone();
    invocation.max_steps = remaining;
    let mut result = crate::query_base(program, &snapshot, &invocation)?;
    result.steps_used = result.steps_used.saturating_add(used);
    crate::encoded_size(&result, options.max_output_bytes)?;
    Ok(result)
}

/// Ordinary Base queries with generation-verified vault property definitions.
/// Deliberately bypasses optional prepared-answer caches: their existing proof
/// does not include property configuration or derived relation values.
pub fn query_generation_with_properties(
    program: &BaseProgram,
    generation: &Generation,
    facts: &[FilePresentationFacts],
    definitions: &crate::properties::PropertyDefinitions,
    options: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    preflight_generation(generation, options)?;
    let mut remaining = options.max_steps;
    let mut snapshot = BaseSnapshot::from_generation_checked(generation, facts, &mut |work| {
        charge(
            &mut remaining,
            options.evaluation.cancellation.as_ref(),
            work,
        )
    })?;
    let mut invocation = options.clone();
    invocation.max_steps = remaining;
    let values = crate::relations::query_property_relations(&snapshot, definitions, &invocation)?;
    charge(
        &mut remaining,
        options.evaluation.cancellation.as_ref(),
        values.steps_used(),
    )?;
    snapshot.property_values = Some(values);
    invocation.max_steps = remaining;
    let mut result = crate::query_base(program, &snapshot, &invocation)?;
    result.steps_used = result
        .steps_used
        .saturating_add(options.max_steps - remaining);
    crate::encoded_size(&result, options.max_output_bytes)?;
    Ok(result)
}
pub(crate) fn preflight_generation(
    generation: &Generation,
    options: &QueryOptions,
) -> Result<(), ExpressionDiagnostic> {
    let budget = |message: &str| ExpressionDiagnostic::new("budget", message);
    if options.max_steps == 0
        || options.max_steps > crate::MAX_QUERY_STEPS
        || options.max_scanned > crate::MAX_QUERY_SCANNED
        || options.max_rows > crate::MAX_QUERY_ROWS
        || options.max_groups > crate::MAX_QUERY_GROUPS
        || options.max_output_bytes > crate::MAX_QUERY_OUTPUT_BYTES
        || options.evaluation.max_steps == 0
        || options.evaluation.max_steps > crate::MAX_EXPRESSION_STEPS
    {
        return Err(budget("Query ceilings exceed supported maximum"));
    }
    let mut records = 0usize;
    let mut work = 0usize;
    let mut edges = 0usize;
    for record in generation.records() {
        if options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|c| c.stop_reason().is_some())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        records += 1;
        work = work.saturating_add(1);
        if let Some(metadata) = record.metadata() {
            work = work.saturating_add(
                metadata.properties.len().saturating_mul(2)
                    + metadata.tags.len()
                    + metadata.links.len(),
            );
            edges = edges.saturating_add(metadata.links.len());
        }
        if records > options.max_scanned
            || work > options.max_steps
            || edges > MAX_RELATIONSHIP_EDGES
        {
            return Err(budget("Generation preparation exceeds query budget"));
        }
    }
    Ok(())
}
#[derive(Default)]
struct FileRelations {
    links: Vec<BasesLink>,
    embeds: Vec<BasesLink>,
    backlinks: Vec<BasesLink>,
}
pub(crate) struct OwnedRelationships {
    complete: bool,
    namespace: PreparedNamespace,
    files: HashMap<EntryId, FileRelations>,
    unavailable: HashSet<EntryId>,
}
pub(crate) struct PreparedRelationships<'a> {
    data: &'a OwnedRelationships,
}
impl OwnedRelationships {
    // The sealed preparation factory builds this adjacency from the exact
    // snapshot graph, and prepare_namespace_checked only clones its existing
    // namespace Arcs. The graph's retained_bytes already accounts that shared
    // allocation. Count only this adjacency's additional allocations here.
    pub(crate) fn retained_additional_bytes(
        &self,
        check: &mut impl FnMut(usize) -> Option<()>,
    ) -> Option<usize> {
        use std::mem::size_of;
        let mut bytes = size_of::<Self>()
            .checked_add(self.files.capacity().checked_mul(2)?.checked_mul(
                size_of::<(EntryId, FileRelations)>().checked_add(size_of::<usize>())?,
            )?)?
            .checked_add(64)?
            .checked_add(
                self.unavailable
                    .capacity()
                    .checked_mul(2)?
                    .checked_mul(size_of::<EntryId>().checked_add(size_of::<usize>())?)?,
            )?
            .checked_add(64)?;
        check(1usize.checked_add(bytes / 64)?)?;
        for (id, relations) in &self.files {
            check(1usize.checked_add(id.as_str().len() / 64)?)?;
            bytes = bytes.checked_add(id.as_str().len())?;
            for links in [&relations.links, &relations.embeds, &relations.backlinks] {
                let slots = links.capacity().checked_mul(size_of::<BasesLink>())?;
                check(1usize.checked_add(slots / 64)?)?;
                bytes = bytes.checked_add(slots)?;
                for link in links {
                    let heap = link
                        .path
                        .capacity()
                        .checked_add(link.display.as_ref().map_or(0, String::capacity))?
                        .checked_add(
                            link.resolved_path
                                .as_ref()
                                .and_then(Option::as_ref)
                                .map_or(0, String::capacity),
                        )?
                        .checked_add(link.target.as_ref().map_or(0, |w| {
                            w.entry_id
                                .as_str()
                                .len()
                                .saturating_add(w.revision.as_str().len())
                        }))?;
                    check(1usize.checked_add(heap / 64)?)?;
                    bytes = bytes.checked_add(heap)?;
                }
            }
        }
        for id in &self.unavailable {
            check(1usize.checked_add(id.as_str().len() / 64)?)?;
            bytes = bytes.checked_add(id.as_str().len())?;
        }
        Some(bytes)
    }
    pub(crate) fn new(
        graph: &ResolutionSnapshot,
        issues: &[MetadataIssue],
        check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<Self, ExpressionDiagnostic> {
        let mut files: HashMap<EntryId, FileRelations> = HashMap::new();
        let mut incoming = HashSet::new();
        for edge in graph.edges() {
            check(1)?;
            let target = edge.target().map(|entry| RecordWitness {
                entry_id: entry.id.clone(),
                revision: entry.revision.clone(),
            });
            let link = BasesLink {
                path: edge.link().destination.clone(),
                target,
                display: None,
                display_value: None,
                resolved_path: Some(edge.target().map(|e| e.path.as_str().into())),
                external: zorid_index::is_external_destination(&edge.link().destination)
                    .map_err(index_error)?,
            };
            let outgoing = files.entry(edge.source().id.clone()).or_default();
            outgoing.links.push(link.clone());
            if edge.link().embed {
                outgoing.embeds.push(link);
            }
            if let Some(target) = edge.target() {
                if incoming.insert((target.id.clone(), edge.source().id.clone())) {
                    files
                        .entry(target.id.clone())
                        .or_default()
                        .backlinks
                        .push(BasesLink {
                            path: edge.source().path.as_str().into(),
                            target: Some(RecordWitness {
                                entry_id: edge.source().id.clone(),
                                revision: edge.source().revision.clone(),
                            }),
                            display: None,
                            display_value: None,
                            resolved_path: Some(Some(edge.source().path.as_str().into())),
                            external: false,
                        });
                }
            }
        }
        // Edge order is shared namespace path/ID order then parser occurrence.
        Ok(Self {
            complete: graph.complete(),
            namespace: graph.prepare_namespace_checked(check)?,
            files,
            unavailable: issues
                .iter()
                .filter(|i| i.properties_unavailable)
                .map(|i| i.witness.entry_id.clone())
                .collect(),
        })
    }
}
impl<'a> PreparedRelationships<'a> {
    pub(crate) fn borrowed(data: &'a OwnedRelationships) -> Self {
        Self { data }
    }
    fn data(&self) -> &OwnedRelationships {
        self.data
    }
    pub(crate) fn complete(&self) -> bool {
        self.data().complete
    }
    /// Resolve through the same immutable index namespace as parsed note links.
    /// A default file requests an explicit vault-root-origin expression lookup.
    pub(crate) fn resolve_target(
        &self,
        file: &BasesFile,
        target: &str,
        check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<Option<(String, RecordWitness)>, ExpressionDiagnostic> {
        let candidates = if let Some(source) = &file.witness {
            let origin = self
                .data()
                .namespace
                .candidates_checked(&source.entry_id, "", check)?;
            if !origin.first().is_some_and(|entry| {
                entry.revision == source.revision && entry.path.as_str() == file.path
            }) {
                return Err(ExpressionDiagnostic::new(
                    "stale-source",
                    "File lookup source is outside the captured revision",
                ));
            }
            self.data()
                .namespace
                .candidates_checked(&source.entry_id, target, check)?
        } else if file.path.is_empty() {
            self.data()
                .namespace
                .candidates_from_root_checked(target, check)?
        } else {
            return Err(ExpressionDiagnostic::new(
                "unavailable",
                "File lookup has no captured source witness",
            ));
        };
        check(1)?;
        Ok(candidates.first().map(|entry| {
            (
                entry.path.as_str().to_string(),
                RecordWitness {
                    entry_id: entry.id.clone(),
                    revision: entry.revision.clone(),
                },
            )
        }))
    }
    pub(crate) fn attach(&self, file: &mut BasesFile) {
        file.metadata_unavailable = file
            .witness
            .as_ref()
            .is_some_and(|w| self.data().unavailable.contains(&w.entry_id));
        if let Some(edges) = file
            .witness
            .as_ref()
            .and_then(|w| self.data().files.get(&w.entry_id))
        {
            file.links = edges.links.clone();
            file.embeds = edges.embeds.clone();
            file.backlinks = edges.backlinks.clone();
        }
    }
    pub(crate) fn attachment_bytes(
        &self,
        witness: Option<&RecordWitness>,
        check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<usize, ExpressionDiagnostic> {
        let Some(edges) = witness.and_then(|witness| self.data().files.get(&witness.entry_id))
        else {
            return Ok(0);
        };
        let mut bytes = 0usize;
        for links in [&edges.links, &edges.embeds, &edges.backlinks] {
            for link in links {
                check(1)?;
                bytes = bytes
                    .saturating_add(std::mem::size_of::<BasesLink>())
                    .saturating_add(link.path.len())
                    .saturating_add(link.display.as_ref().map_or(0, String::len))
                    .saturating_add(
                        link.resolved_path
                            .as_ref()
                            .and_then(Option::as_ref)
                            .map_or(0, String::len),
                    )
                    .saturating_add(link.target.as_ref().map_or(0, |target| {
                        target.entry_id.as_str().len() + target.revision.as_str().len()
                    }));
            }
        }
        Ok(bytes)
    }
    pub(crate) fn has_link(
        &self,
        file: &BasesFile,
        target: &str,
        check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<bool, ExpressionDiagnostic> {
        if !self.complete() {
            return Err(ExpressionDiagnostic::new(
                "unavailable",
                "Relationship coverage is incomplete",
            ));
        }
        let source = file.witness.as_ref().ok_or_else(|| {
            ExpressionDiagnostic::new("unavailable", "File has no generation witness")
        })?;
        if file.links.iter().any(|link| link.path == target) {
            return Ok(true);
        }
        let candidates =
            self.data()
                .namespace
                .candidates_checked(&source.entry_id, target, check)?;
        let selected = candidates.first().map(|entry| &entry.id);
        Ok(selected.is_some_and(|id| {
            file.links
                .iter()
                .any(|link| link.target.as_ref().is_some_and(|w| &w.entry_id == id))
        }))
    }
}
