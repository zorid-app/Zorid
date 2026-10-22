//! Read-only first-build Bases over the exact prepared subset of a sealed capture.
//! No ordinary snapshot ID, graph, publication capability or cache is manufactured.
//! The host admits definition bytes/program identity before calling this reducer.
use crate::{
    query, BaseGroup, BaseProgram, BaseRefreshHint, BaseRow, BaseValue, DetachedRecord,
    ExpressionDiagnostic, FilePresentationFacts, GroupOption, MetadataIssue, PropertyValue,
    QueryCounts, QueryDiagnostic, QueryOptions, RecordWitness,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    mem::size_of,
};
use zorid_index::{
    PreviewProgress, PreviewRowFacts, PreviewSnapshot, PreviewSnapshotId, SourceSnapshotId,
};

pub const MAX_PREVIEW_QUERY_OWNED_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewCountsScope {
    PreparedSubset,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BasePreviewStatus {
    Indexing,
}

/// Counts and aggregates refer only to the exact prepared subset. In particular
/// a partial sum, mean, group or top-N is not asserted to be a lower bound.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasePreviewResult {
    pub status: BasePreviewStatus,
    pub complete: bool,
    pub aggregates_complete: bool,
    pub counts_scope: PreviewCountsScope,
    pub progress: PreviewProgress,
    pub prepared_scan_complete: bool,
    pub unavailable_prepared_files: usize,
    pub unavailable_filter_rows: usize,
    pub view: PropertyValue,
    pub rows: Vec<BaseRow>,
    pub groups: Vec<BaseGroup>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub summaries: std::collections::BTreeMap<String, BaseValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_previews: Option<std::collections::BTreeMap<String, BaseValue>>,
    pub group_options: Vec<GroupOption>,
    pub properties: Vec<String>,
    pub available_properties: Vec<String>,
    pub counts: QueryCounts,
    pub diagnostics: Vec<QueryDiagnostic>,
    pub steps_used: usize,
    pub relationships_available: bool,
    pub metadata_issues: Vec<MetadataIssue>,
    pub metadata_complete: bool,
    pub refresh_hint: Option<BaseRefreshHint>,
}
/// The capture ID is weak and typed, not a wire authority or mutation witness.
/// Keeping this result does not retain captured rows or their metadata.
#[derive(Debug)]
pub struct CommittedBasePreviewResult {
    pub capture: PreviewSnapshotId,
    pub source: SourceSnapshotId,
    pub value: BasePreviewResult,
    admitted_owned_bytes: usize,
}
impl CommittedBasePreviewResult {
    /// Conservative monotonic admission for this invocation's copied data.
    /// Includes short-lived copies; callers must not reclaim this allowance
    /// while retaining the result. Encoding remains the caller's responsibility.
    pub fn admitted_owned_bytes(&self) -> usize {
        self.admitted_owned_bytes
    }
}

/// Tightening ledger for NEW adapter copies and shared result retention only.
/// Existing evaluator/session temporaries retain their separate component caps;
/// this is neither an aggregate evaluator heap nor an RSS limit. Capture backing
/// remains charged by its existing 32MiB owner. Monotonic charging deliberately
/// counts short-lived derived containers conservatively rather than recycling.
pub(crate) struct PreviewAdmission {
    used: usize,
    limit: usize,
    work_used: usize,
    max_work: usize,
    cancellation: Option<crate::OperationCancellation>,
}
impl PreviewAdmission {
    pub(crate) fn new(limit: usize, options: &QueryOptions) -> Result<Self, ExpressionDiagnostic> {
        if options.max_steps == 0
            || options.max_steps > crate::MAX_QUERY_STEPS
            || options.max_scanned > crate::MAX_QUERY_SCANNED
            || options.max_rows > crate::MAX_QUERY_ROWS
            || options.max_groups > crate::MAX_QUERY_GROUPS
            || options.max_output_bytes > crate::MAX_QUERY_OUTPUT_BYTES
        {
            return Err(budget("Query ceilings exceed supported maximum"));
        }
        if limit == 0 || limit > MAX_PREVIEW_QUERY_OWNED_BYTES {
            return Err(budget(
                "Preview owned-byte ceiling exceeds supported maximum",
            ));
        }
        Ok(Self {
            used: 0,
            limit,
            work_used: 0,
            max_work: options.max_steps,
            cancellation: options.evaluation.cancellation.clone(),
        })
    }
    pub(crate) fn charge(&mut self, bytes: usize) -> Result<(), ExpressionDiagnostic> {
        self.check()?;
        self.work_used = self
            .work_used
            .checked_add(1 + bytes / 16)
            .filter(|n| *n <= self.max_work)
            .ok_or_else(|| budget("Preview admission exceeds query work budget"))?;
        self.used = self
            .used
            .checked_add(bytes)
            .filter(|n| *n <= self.limit)
            .ok_or_else(|| budget("Preview owned copies exceed byte budget"))?;
        Ok(())
    }
    pub(crate) fn estimate_fits(&self, bytes: usize) -> Result<(), ExpressionDiagnostic> {
        self.check()?;
        if bytes > self.limit.saturating_sub(self.used) {
            return Err(budget(
                "Preview estimate exceeds remaining owned-byte budget",
            ));
        }
        Ok(())
    }
    pub(crate) fn work_used(&self) -> usize {
        self.work_used
    }
    fn check(&self) -> Result<(), ExpressionDiagnostic> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(|c| c.stop_reason().is_some())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        Ok(())
    }
}
fn budget(message: &str) -> ExpressionDiagnostic {
    ExpressionDiagnostic::new("budget", message)
}
pub(crate) fn string_bytes(value: &str) -> usize {
    size_of::<String>()
        .saturating_add(value.len())
        .saturating_add(16)
}
fn vector_bytes<T>(len: usize) -> usize {
    size_of::<Vec<T>>()
        .saturating_add(
            (if len == 0 { 0 } else { len.max(4) })
                .saturating_mul(size_of::<T>())
                .saturating_mul(2),
        )
        .saturating_add(16)
}
/// Conservative typed copy estimates include inline slots and owned payloads.
/// Parser values have bounded depth; reject deeper manually supplied contexts.
pub(crate) fn property_bytes(
    value: &PropertyValue,
    admission: &mut PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    fn visit(
        value: &PropertyValue,
        depth: usize,
        admission: &mut PreviewAdmission,
    ) -> Result<usize, ExpressionDiagnostic> {
        admission.charge(0)?;
        if depth > 128 {
            return Err(budget("Preview value exceeds depth budget"));
        }
        let mut bytes = size_of::<PropertyValue>();
        match value {
            PropertyValue::String(s) => bytes = bytes.saturating_add(string_bytes(s)),
            PropertyValue::Array(values) => {
                bytes = bytes.saturating_add(vector_bytes::<PropertyValue>(values.len()));
                admission.estimate_fits(bytes)?;
                for value in values {
                    bytes = bytes.saturating_add(visit(value, depth + 1, admission)?);
                    admission.estimate_fits(bytes)?;
                }
            }
            PropertyValue::Object(values) => {
                bytes = bytes.saturating_add(vector_bytes::<(String, PropertyValue)>(values.len()));
                admission.estimate_fits(bytes)?;
                for (key, value) in values {
                    bytes = bytes.saturating_add(string_bytes(key));
                    admission.estimate_fits(bytes)?;
                    bytes = bytes.saturating_add(visit(value, depth + 1, admission)?);
                    admission.estimate_fits(bytes)?;
                }
            }
            _ => {}
        }
        admission.estimate_fits(bytes)?;
        Ok(bytes)
    }
    visit(value, 0, admission)
}
pub(crate) fn value_bytes(
    value: &BaseValue,
    admission: &mut PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    fn visit(
        value: &BaseValue,
        depth: usize,
        admission: &mut PreviewAdmission,
    ) -> Result<usize, ExpressionDiagnostic> {
        admission.charge(0)?;
        if depth > 128 {
            return Err(budget("Preview result exceeds depth budget"));
        }
        let mut bytes = size_of::<BaseValue>();
        match value {
            BaseValue::String { value } => bytes = bytes.saturating_add(string_bytes(value)),
            BaseValue::File { path } => bytes = bytes.saturating_add(string_bytes(path)),
            BaseValue::Link {
                path,
                target,
                display,
                ..
            } => {
                bytes = bytes.saturating_add(string_bytes(path));
                if let Some(target) = target {
                    bytes = bytes.saturating_add(witness_bytes(target));
                }
                if let Some(display) = display {
                    bytes = bytes.saturating_add(string_bytes(display));
                }
            }
            BaseValue::Error { code, message } => {
                bytes = bytes
                    .saturating_add(string_bytes(code))
                    .saturating_add(string_bytes(message))
            }
            BaseValue::List { value } => {
                bytes = bytes.saturating_add(vector_bytes::<BaseValue>(value.len()));
                admission.estimate_fits(bytes)?;
                for value in value {
                    bytes = bytes.saturating_add(visit(value, depth + 1, admission)?);
                    admission.estimate_fits(bytes)?;
                }
            }
            BaseValue::Object { value } => {
                bytes = bytes.saturating_add(vector_bytes::<(String, BaseValue)>(value.len()));
                admission.estimate_fits(bytes)?;
                for (key, value) in value {
                    bytes = bytes.saturating_add(string_bytes(key));
                    admission.estimate_fits(bytes)?;
                    bytes = bytes.saturating_add(visit(value, depth + 1, admission)?);
                    admission.estimate_fits(bytes)?;
                }
            }
            _ => {}
        }
        admission.estimate_fits(bytes)?;
        Ok(bytes)
    }
    visit(value, 0, admission)
}
fn witness_bytes(w: &RecordWitness) -> usize {
    size_of::<RecordWitness>()
        .saturating_add(string_bytes(w.entry_id.as_str()))
        .saturating_add(string_bytes(w.revision.as_str()))
}
pub(crate) fn record_bytes(
    row: &DetachedRecord,
    admission: &mut PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    admission.charge(0)?;
    let mut bytes = size_of::<DetachedRecord>()
        .saturating_add(string_bytes(&row.path))
        .saturating_add(vector_bytes::<(String, PropertyValue)>(
            row.properties.len(),
        ))
        .saturating_add(vector_bytes::<(String, crate::PropertyType)>(
            row.property_types.len(),
        ))
        .saturating_add(vector_bytes::<String>(row.tags.len()));
    if let Some(w) = &row.witness {
        bytes = bytes.saturating_add(witness_bytes(w));
    }
    admission.estimate_fits(bytes)?;
    for (key, value) in &row.properties {
        bytes = bytes.saturating_add(string_bytes(key));
        admission.estimate_fits(bytes)?;
        bytes = bytes.saturating_add(property_bytes(value, admission)?);
        admission.estimate_fits(bytes)?;
    }
    for (key, _) in &row.property_types {
        admission.charge(0)?;
        bytes = bytes.saturating_add(string_bytes(key));
        admission.estimate_fits(bytes)?;
    }
    for tag in &row.tags {
        admission.charge(0)?;
        bytes = bytes.saturating_add(string_bytes(tag));
        admission.estimate_fits(bytes)?;
    }
    Ok(bytes)
}
pub(crate) fn options_bytes(
    options: &QueryOptions,
    admission: &mut PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    admission.charge(0)?;
    let mut bytes = size_of::<QueryOptions>()
        .saturating_add(string_bytes(&options.evaluation.timezone))
        .saturating_add(vector_bytes::<String>(
            options
                .search_terms
                .len()
                .saturating_add(options.ignore_paths.len()),
        ))
        .saturating_add(vector_bytes::<(String, String)>(
            options.evaluation.formulas.len(),
        ));
    admission.estimate_fits(bytes)?;
    for s in options.search_terms.iter().chain(&options.ignore_paths) {
        admission.charge(0)?;
        bytes = bytes.saturating_add(string_bytes(s));
        admission.estimate_fits(bytes)?;
    }
    for (name, source) in &options.evaluation.formulas {
        admission.charge(0)?;
        bytes = bytes
            .saturating_add(string_bytes(name))
            .saturating_add(string_bytes(source));
        admission.estimate_fits(bytes)?;
    }
    if let Some(property) = &options.summary_preview_property {
        bytes = bytes.saturating_add(string_bytes(property));
    }
    if let Some(id) = &options.current_entry_id {
        bytes = bytes.saturating_add(string_bytes(id.as_str()));
    }
    admission.estimate_fits(bytes)?;
    if let Some(row) = &options.evaluation.current_record {
        bytes = bytes.saturating_add(record_bytes(row, admission)?);
    }
    admission.estimate_fits(bytes)?;
    Ok(bytes)
}
pub(crate) fn issue_bytes(
    issue: &MetadataIssue,
    admission: &mut PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    admission.charge(0)?;
    let bytes = size_of::<MetadataIssue>()
        .saturating_add(witness_bytes(&issue.witness))
        .saturating_add(vector_bytes::<zorid_document::Diagnostic>(
            issue.diagnostics.len(),
        ));
    admission.estimate_fits(bytes)?;
    Ok(bytes)
}
fn row_copy_bytes(
    row: &PreviewRowFacts<'_>,
    admission: &mut PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    admission.charge(0)?;
    let mut bytes = size_of::<DetachedRecord>()
        .saturating_add(string_bytes(row.entry_id().as_str()))
        .saturating_add(string_bytes(row.revision().as_str()))
        .saturating_add(string_bytes(row.path().as_str()));
    if let Some(metadata) = row.metadata() {
        bytes = bytes
            .saturating_add(vector_bytes::<(String, PropertyValue)>(
                metadata.properties.len(),
            ))
            .saturating_add(vector_bytes::<(String, crate::PropertyType)>(
                metadata.properties.len(),
            ))
            .saturating_add(vector_bytes::<String>(metadata.tags.len()));
        admission.estimate_fits(bytes)?;
        for property in &metadata.properties {
            bytes = bytes.saturating_add(string_bytes(&property.key).saturating_mul(2));
            admission.estimate_fits(bytes)?;
            bytes = bytes.saturating_add(property_bytes(&property.value, admission)?);
            admission.estimate_fits(bytes)?;
        }
        for tag in &metadata.tags {
            admission.charge(0)?;
            bytes = bytes.saturating_add(string_bytes(tag));
            admission.estimate_fits(bytes)?;
        }
    }
    admission.estimate_fits(bytes)?;
    Ok(bytes)
}
fn unavailable(row: &PreviewRowFacts<'_>) -> bool {
    row.exclusion().is_some_and(|e| e.limits_coverage())
        || row.metadata().is_some_and(|m| {
            matches!(
                m.frontmatter.state,
                zorid_document::FrontmatterState::Invalid
                    | zorid_document::FrontmatterState::Unclosed
            )
        })
}

/// Query one exact capture. Definition program/source byte correlation is host
/// responsibility; this function proves only prepared readable membership of its
/// definition ID. Presentation facts must match prepared revisions exactly.
/// Relationships are deliberately unavailable, including negative predicates.
/// `owned_byte_limit` is a tightening reservation supplied by the caller from
/// its existing preview/query owner budget (at most 8MiB here). The caller keeps
/// that reservation while retaining the returned owned DTO; this pure reducer
/// creates no independent owner pool. Existing evaluator component temporaries
/// and the captured backing remain separately bounded/accounted as described
/// above. Encoding/transport after transfer belongs to the caller's bounds.
pub fn query_preview(
    program: &BaseProgram,
    preview: &PreviewSnapshot,
    definition_entry_id: &crate::EntryId,
    facts: &[FilePresentationFacts],
    options: &QueryOptions,
    owned_byte_limit: usize,
) -> Result<CommittedBasePreviewResult, ExpressionDiagnostic> {
    let mut admission = PreviewAdmission::new(owned_byte_limit, options)?;
    let view = preview.facts_view_checked(&mut |_| admission.charge(0))?;
    if view.rows().len() > options.max_scanned || facts.len() > crate::MAX_QUERY_SCANNED {
        return Err(budget("Preview exceeds scanned-record budget"));
    }
    admission.charge(
        size_of::<BasePreviewResult>()
            + size_of::<CommittedBasePreviewResult>()
            + string_bytes(view.source().local_store_id().as_str())
            + string_bytes(view.source().watermark().as_str()),
    )?;
    admission.charge(
        facts
            .len()
            .saturating_mul(size_of::<(&crate::EntryId, &FilePresentationFacts)>() * 16),
    )?;
    let mut by_id = HashMap::new();
    for fact in facts {
        admission.charge(0)?;
        if by_id.insert(&fact.witness.entry_id, fact).is_some() {
            return Err(ExpressionDiagnostic::new(
                "stale-source",
                "Duplicate preview file facts",
            ));
        }
    }
    admission.charge(vector_bytes::<DetachedRecord>(view.rows().len()))?;
    admission.charge(
        view.rows()
            .len()
            .saturating_mul(size_of::<crate::EntryId>() * 16),
    )?;
    let mut records = Vec::new();
    records
        .try_reserve_exact(view.rows().len())
        .map_err(|_| budget("Preview row allocation failed"))?;
    let mut issues = Vec::new();
    let mut unavailable_ids = HashSet::new();
    let mut readable_definition = false;
    let mut current_prepared = options.current_entry_id.is_none();
    for row in view.rows() {
        let row_bytes = row_copy_bytes(&row, &mut admission)?;
        admission.charge(row_bytes)?;
        let fact = by_id.remove(row.entry_id());
        if fact.is_some_and(|f| &f.witness.revision != row.revision()) {
            return Err(ExpressionDiagnostic::new(
                "stale-source",
                "Stale preview file facts",
            ));
        }
        if row.entry_id() == definition_entry_id {
            readable_definition = row.source_text_bytes().is_some();
        }
        if options.current_entry_id.as_ref() == Some(row.entry_id()) {
            current_prepared = true;
        }
        let metadata = row.metadata();
        let properties_unavailable = unavailable(&row);
        if properties_unavailable {
            admission.charge(string_bytes(row.entry_id().as_str()))?;
            unavailable_ids.insert(row.entry_id().clone());
        }
        if row.exclusion().is_some() || metadata.is_some_and(|m| !m.diagnostics.is_empty()) {
            admission.charge(
                size_of::<MetadataIssue>() * 4
                    + string_bytes(row.entry_id().as_str())
                    + string_bytes(row.revision().as_str())
                    + vector_bytes::<zorid_document::Diagnostic>(
                        metadata.map_or(0, |m| m.diagnostics.len()),
                    ),
            )?;
            issues.push(MetadataIssue {
                witness: RecordWitness {
                    entry_id: row.entry_id().clone(),
                    revision: row.revision().clone(),
                },
                exclusion: row.exclusion().cloned(),
                diagnostics: metadata.map(|m| m.diagnostics.clone()).unwrap_or_default(),
                properties_unavailable,
            });
        }
        records.push(DetachedRecord {
            witness: Some(RecordWitness {
                entry_id: row.entry_id().clone(),
                revision: row.revision().clone(),
            }),
            path: row.path().as_str().into(),
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
            size: fact
                .and_then(|f| f.size)
                .or_else(|| row.source_text_bytes().map(|n| n as u64)),
            ctime_ms: fact.and_then(|f| f.ctime_ms),
            mtime_ms: fact.and_then(|f| f.mtime_ms),
        });
    }
    if !by_id.is_empty() {
        return Err(ExpressionDiagnostic::new(
            "stale-source",
            "File facts are absent from prepared preview rows",
        ));
    }
    if !readable_definition {
        return Err(ExpressionDiagnostic::new(
            "unavailable",
            "Base definition is not prepared readable text",
        ));
    }
    if !current_prepared {
        return Err(ExpressionDiagnostic::new(
            "unavailable",
            "Current entry is not prepared in this preview",
        ));
    }
    if options
        .evaluation
        .current_record
        .as_ref()
        .and_then(|r| r.witness.as_ref())
        .is_some_and(|w| {
            !records.iter().any(|r| {
                r.witness
                    .as_ref()
                    .is_some_and(|rw| rw.entry_id == w.entry_id)
            })
        })
    {
        return Err(ExpressionDiagnostic::new(
            "unavailable",
            "Current record is not prepared in this preview",
        ));
    }
    let rows = query::QueryRows {
        records: &records,
        relationships: None,
        metadata_issues: &issues,
        unavailable: Some(&unavailable_ids),
        property_values: None,
    };
    let validated = query::validate_rows_invocation(
        program,
        &rows,
        options,
        None,
        |options| {
            crate::encoded_size(&(&records, &issues, options), crate::MAX_BASE_REQUEST_BYTES)
                .map(|_| ())
        },
        Some(&mut admission),
    )?;
    let result = query::query_rows_validated(
        program,
        &rows,
        options,
        None,
        &validated,
        &mut false,
        Some(&mut admission),
    )?;
    let unavailable_filter_rows = result
        .diagnostics
        .iter()
        .filter(|d| d.phase == "filter" && d.code == "unavailable")
        .count();
    let value = BasePreviewResult {
        status: BasePreviewStatus::Indexing,
        complete: false,
        aggregates_complete: false,
        counts_scope: PreviewCountsScope::PreparedSubset,
        progress: view.progress(),
        prepared_scan_complete: true,
        unavailable_prepared_files: unavailable_ids.len(),
        unavailable_filter_rows,
        view: result.view,
        rows: result.rows,
        groups: result.groups,
        summaries: result.summaries,
        summary_previews: result.summary_previews,
        group_options: result.group_options,
        properties: result.properties,
        available_properties: result.available_properties,
        counts: result.counts,
        diagnostics: result.diagnostics,
        steps_used: result.steps_used,
        relationships_available: false,
        metadata_issues: result.metadata_issues,
        metadata_complete: false,
        refresh_hint: result.refresh_hint,
    };
    crate::encoded_size(&value, options.max_output_bytes)?;
    admission.check()?;
    Ok(CommittedBasePreviewResult {
        capture: view.id().clone(),
        source: view.source().clone(),
        value,
        admitted_owned_bytes: admission.used,
    })
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn wide_estimates_reject_container_slots_before_walking_children() {
        let options = QueryOptions::default();
        let mut admission = PreviewAdmission::new(1024, &options).unwrap();
        let value = PropertyValue::Array(vec![PropertyValue::Null; 10_000]);
        assert_eq!(
            property_bytes(&value, &mut admission).unwrap_err().code,
            "budget"
        );
        assert_eq!(admission.work_used(), 1); // Only the root is visited.
        assert_eq!(admission.used, 0); // No copied value was admitted or allocated.
        let mut admission = PreviewAdmission::new(1024, &options).unwrap();
        let value = BaseValue::List {
            value: vec![BaseValue::Null; 10_000],
        };
        assert_eq!(
            value_bytes(&value, &mut admission).unwrap_err().code,
            "budget"
        );
        assert_eq!(admission.work_used(), 1);
    }
    #[test]
    fn typed_walks_charge_before_each_visit_and_honor_cancellation() {
        let mut options = QueryOptions::default();
        options.max_steps = 1;
        let mut admission = PreviewAdmission::new(MAX_PREVIEW_QUERY_OWNED_BYTES, &options).unwrap();
        let value = PropertyValue::Array(vec![PropertyValue::Array(vec![PropertyValue::Null])]);
        assert_eq!(
            property_bytes(&value, &mut admission).unwrap_err().code,
            "budget"
        );
        assert_eq!(admission.work_used(), 1); // The child cannot start unpaid.
        let cancellation = crate::OperationCancellation::default();
        cancellation.cancel();
        options = QueryOptions::default();
        options.evaluation.cancellation = Some(cancellation);
        let mut admission = PreviewAdmission::new(MAX_PREVIEW_QUERY_OWNED_BYTES, &options).unwrap();
        assert_eq!(
            property_bytes(&value, &mut admission).unwrap_err().code,
            "cancelled"
        );
        assert_eq!(admission.work_used(), 0);
    }
}
