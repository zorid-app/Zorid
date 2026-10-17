//! Snapshot-bound relationship adaptation. The index owns parsing and resolution.
use crate::{
    expression::{BasesFile, BasesLink},
    BaseProgram, BaseQueryResult, BaseSnapshot, DetachedRecord, ExpressionDiagnostic, QueryOptions,
    RecordWitness,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use zorid_core::EntryId;
use zorid_index::{Generation, ResolutionSnapshot, ResolutionView, Resolver};

pub const MAX_RELATIONSHIP_EDGES: usize = 100_000;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilePresentationFacts {
    pub witness: RecordWitness,
    pub size: Option<u64>,
    pub ctime_ms: Option<i64>,
    pub mtime_ms: Option<i64>,
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
impl BaseSnapshot {
    /// Metadata, paths and graph derive solely from this immutable generation.
    /// Facts may add only host file presentation fields with exact witnesses.
    pub fn from_generation(
        generation: &Generation,
        facts: &[FilePresentationFacts],
    ) -> Result<Self, ExpressionDiagnostic> {
        if facts.len() > crate::MAX_QUERY_SCANNED {
            return Err(ExpressionDiagnostic::new("budget", "Too many file facts"));
        }
        let mut by_id = HashMap::new();
        for fact in facts {
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
        let mut bytes = 0usize;
        for record in generation.records() {
            if records.len() >= crate::MAX_QUERY_SCANNED {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Too many generation records",
                ));
            }
            let entry = record.witness().entry();
            let facts = by_id.get(&entry.id);
            let metadata = record.metadata();
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
            bytes = bytes.saturating_add(
                serde_json::to_vec(&row)
                    .map_err(|_| ExpressionDiagnostic::new("input", "Invalid generation row"))?
                    .len(),
            );
            if bytes > crate::MAX_BASE_REQUEST_BYTES {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Generation rows exceed Base input budget",
                ));
            }
            records.push(row);
        }
        let relationships = ResolutionView::new(generation)
            .snapshot(MAX_RELATIONSHIP_EDGES, crate::MAX_BASE_REQUEST_BYTES)
            .map_err(index_error)?;
        Ok(Self {
            snapshot_id: generation.id().clone(),
            records,
            relationships: Some(relationships),
        })
    }
}
pub fn query_generation(
    program: &BaseProgram,
    generation: &Generation,
    facts: &[FilePresentationFacts],
    options: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    if options
        .evaluation
        .cancellation
        .as_ref()
        .is_some_and(|c| c.stop_reason().is_some())
    {
        return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
    }
    crate::query_base(
        program,
        &BaseSnapshot::from_generation(generation, facts)?,
        options,
    )
}
#[derive(Default)]
struct FileRelations {
    links: Vec<BasesLink>,
    embeds: Vec<BasesLink>,
    backlinks: Vec<BasesLink>,
}
pub(crate) struct PreparedRelationships<'a> {
    graph: &'a ResolutionSnapshot,
    resolver: Resolver<'a>,
    files: HashMap<EntryId, FileRelations>,
}
impl<'a> PreparedRelationships<'a> {
    pub(crate) fn new(graph: &'a ResolutionSnapshot) -> Result<Self, ExpressionDiagnostic> {
        let mut files: HashMap<EntryId, FileRelations> = HashMap::new();
        let mut incoming = HashSet::new();
        for edge in graph.edges() {
            let target = edge.target().map(|entry| RecordWitness {
                entry_id: entry.id.clone(),
                revision: entry.revision.clone(),
            });
            let link = BasesLink {
                path: edge.link().destination.clone(),
                target,
                display: None,
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
                            resolved_path: Some(Some(edge.source().path.as_str().into())),
                            external: false,
                        });
                }
            }
        }
        // Edge order is shared namespace path/ID order then parser occurrence.
        Ok(Self {
            graph,
            resolver: graph.resolver(),
            files,
        })
    }
    pub(crate) fn complete(&self) -> bool {
        self.graph.complete()
    }
    pub(crate) fn attach(&self, file: &mut BasesFile) {
        if let Some(edges) = file
            .witness
            .as_ref()
            .and_then(|w| self.files.get(&w.entry_id))
        {
            file.links = edges.links.clone();
            file.embeds = edges.embeds.clone();
            file.backlinks = edges.backlinks.clone();
        }
    }
    pub(crate) fn has_link(
        &self,
        file: &BasesFile,
        target: &str,
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
        let candidates = self
            .resolver
            .candidates(&source.entry_id, target)
            .map_err(index_error)?;
        let selected = candidates.first().map(|entry| &entry.id);
        Ok(selected.is_some_and(|id| {
            file.links
                .iter()
                .any(|link| link.target.as_ref().is_some_and(|w| &w.entry_id == id))
        }))
    }
}
