//! Bounded two-source observation, never a cross-Store atomic snapshot.
use super::*;
use crate::document_api::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zorid_bases::calendar::{CalendarBaseSelection, CalendarTaskSelection};
use zorid_bases::tasks::TaskRow;
use zorid_bases::types::{TaskTypeSummary, TypeRegistry};
pub use zorid_bases::calendar::CalendarContext;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum CalendarScope {
    Tasks { type_ids: Vec<EntryId> },
    Base {
        type_ids: Vec<EntryId>, definition_id: EntryId,
        view_name: Option<String>, view_index: Option<usize>, current_entry_id: EntryId,
        #[serde(default)] search_terms: Vec<String>,
        #[serde(default)] ignore_paths: Vec<String>,
    },
}
impl CalendarScope {
    fn type_ids(&self) -> &[EntryId] { match self { Self::Tasks { type_ids } | Self::Base { type_ids, .. } => type_ids } }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum CalendarRead {
    Window { scope: CalendarScope, context: CalendarContext, from_ms: String, until_ms: String,
        cursor: Option<String>, limit: u32, byte_limit: u32, expected_work_block_watermark: Option<String> },
    Tasks { scope: CalendarScope, context: CalendarContext, without_blocks: bool, show_done: bool,
        cursor: Option<String>, limit: u32, byte_limit: u32 },
    Links { type_ids: Vec<EntryId>, entry_ids: Vec<EntryId>, context: CalendarContext },
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CalendarLinkLabel {
    Task { entry_id: EntryId, row: TaskRow, #[serde(rename = "type")] task_type: TaskTypeSummary },
    Missing { entry_id: EntryId, path: Option<String>, reason: String },
    NotTask { entry_id: EntryId, path: Option<String>, reason: String },
    Unavailable { entry_id: EntryId, path: Option<String>, reason: String },
}
#[derive(Clone, Debug, Serialize)]
pub struct CalendarTarget { pub record: zorid_records::Id, pub generation: zorid_records::Id }
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CalendarMembership { Present { witness: CalendarTarget }, Absent, Unknown { reason: String } }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSelection { pub definition: Option<EntryState>, pub selected_files: usize, pub selected_tasks: usize, pub excluded_non_tasks: usize }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvidence {
    pub document_snapshot: IndexSnapshotId, pub document_source: SourceSnapshotId,
    pub document_coverage_complete: bool, pub task_coverage_complete: bool,
    pub work_block_watermark: Option<String>, pub work_block_scan_complete: bool, pub membership_complete: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct CalendarBlock { pub value: WorkBlockRead, pub links: Vec<CalendarLinkLabel> }
#[derive(Clone, Debug, Serialize)]
pub struct CalendarTask { pub row: TaskRow, #[serde(rename = "type")] pub task_type: TaskTypeSummary, pub membership: CalendarMembership }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarReadValue {
    pub kind: String, pub selection: Option<CalendarSelection>, pub evidence: CalendarEvidence,
    pub phase: String, pub cursor: Option<String>, pub scanned: u32, pub bytes: u32,
    pub blocks: Vec<CalendarBlock>, pub tasks: Vec<CalendarTask>, pub links: Vec<CalendarLinkLabel>,
    /// Original diagnostic objects, tagged by engine; witnesses/ranges are preserved.
    pub diagnostics: Vec<serde_json::Value>,
    pub base_result: Option<zorid_bases::BaseQueryResult>,
}
/// Host-owned alongside its exact pin. Clear before closing the pin/releasing its
/// client. No capabilities, query rows or cursors are accepted from the renderer.
#[derive(Default)]
pub struct CalendarJoinState { active: Option<Join> }
impl CalendarJoinState { pub fn clear(&mut self) { self.active = None; } }
struct Join {
    identity: String, snapshot: IndexSnapshotId, source: SourceSnapshotId,
    watermark: String, selection: CalendarTaskSelection, definition: Option<EntryState>,
    registry: TypeRegistry, types: Vec<TaskTypeSummary>,
    present: BTreeMap<EntryId, CalendarTarget>, uncertain: bool,
    after: Option<String>, records_done: bool,
    summary: Option<zorid_store::ManagedUnresolvedCursor>, summary_done: bool,
    pages: usize, bytes: usize, offset: usize, token: Option<String>,
}
const STEP_BYTES: usize = 1024 * 1024;
const RETAIN_BYTES: usize = 8 * STEP_BYTES;
fn invalid(code: &str, message: &str) -> NativeDocumentError {
    zorid_bases::ExpressionDiagnostic::new(code, message).into()
}
fn encoded<T: Serialize>(value: &T) -> NativeDocumentResult<usize> {
    Ok(serde_json::to_vec(value).map_err(|_| invalid("codec", "Calendar encoding failed"))?.len())
}
fn diagnostics<T: Serialize>(engine: &str, values: &[T], out: &mut Vec<serde_json::Value>) -> NativeDocumentResult<()> {
    for value in values {
        let mut v = serde_json::to_value(value).map_err(|_| invalid("codec", "Calendar diagnostics failed"))?;
        if let Some(v) = v.as_object_mut() { v.insert("engine".into(), engine.into()); }
        out.push(v);
    }
    Ok(())
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
impl NativeVault {
    fn calendar_admit(&self, lease: &ClientLease, session: &WorkBlockSession, pin: &DocumentQueryPin) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        self.verify_client_lease(lease).map_err(WorkBlockError::from)?;
        if lease.reference() != &session.lease || self.store.family_status().map_err(Error::from)?.scope.as_ref() != Some(&session.scope) {
            return Err(WorkBlockError::StaleSession.into());
        }
        self.document_manifest(pin)?;
        if self.document_index_status_with_source()?.0 != *pin.generation().manifest().source() {
            return Err(zorid_index::IndexError::StaleSource.into());
        }
        self.store.managed_watermark(&session.handle).map_err(Error::from)?;
        Ok(())
    }
    fn calendar_registry(&self, pin: &DocumentQueryPin, ids: &[EntryId]) -> NativeDocumentResult<TypeRegistry> {
        use zorid_bases::types::*;
        if ids.len() > MAX_TYPE_SOURCES { return Err(invalid("budget", "Too many Type selectors")); }
        let mut seen = std::collections::BTreeSet::new();
        let mut sources = Vec::new(); let mut total = 0usize;
        for id in ids {
            if !seen.insert(id) { return Err(invalid("type-source", "Duplicate Type selector")); }
            let projected = self.store.read_document_projection(pin, id)?;
            let bytes = projected.content.ok_or_else(|| NativeDocumentError::SourceUnavailable(id.clone()))?;
            total = total.checked_add(bytes.len()).ok_or_else(|| invalid("budget", "Type byte budget"))?;
            if bytes.len() > MAX_TYPE_SOURCE_BYTES || total > MAX_TYPE_BYTES { return Err(invalid("budget", "Type byte budget")); }
            let entry = projected.witness.entry();
            sources.push(TypeYamlSource { witness: zorid_bases::RecordWitness { entry_id: entry.id.clone(), revision: entry.revision.clone() },
                path: entry.path.to_string(), source: String::from_utf8(bytes).map_err(|_| NativeDocumentError::SourceUnavailable(id.clone()))? });
        }
        Ok(compile_type_yaml(sources)?)
    }
    fn calendar_selection(&self, pin: &DocumentQueryPin, registry: &TypeRegistry, scope: &CalendarScope, context: &CalendarContext) -> NativeDocumentResult<(CalendarTaskSelection, Option<EntryState>)> {
        use zorid_bases::calendar::select_calendar_tasks;
        let CalendarScope::Base { definition_id, view_name, view_index, current_entry_id, search_terms, ignore_paths, .. } = scope else {
            return Ok((select_calendar_tasks(pin.generation(), registry, None, context)?, None));
        };
        if view_name.is_some() && view_index.is_some() { return Err(invalid("invalid_query", "Choose one Base view selector")); }
        let manifest = self.document_manifest(pin)?;
        let projected = self.store.read_document_projection(pin, definition_id)?;
        let definition = projected.witness.entry().clone();
        let bytes = projected.content.ok_or_else(|| NativeDocumentError::SourceUnavailable(definition_id.clone()))?;
        let source = std::str::from_utf8(&bytes).map_err(|_| NativeDocumentError::SourceUnavailable(definition_id.clone()))?;
        let program = zorid_bases::compile_base_source(source)?;
        let facts = manifest.entries().iter().zip(manifest.presentations())
            .filter(|(entry, _)| entry.state.kind == zorid_core::EntryKind::File)
            .map(|(entry, p)| zorid_bases::FilePresentationFacts {
                witness: zorid_bases::RecordWitness { entry_id: entry.state.id.clone(), revision: entry.state.revision.clone() },
                size: Some(p.size_bytes), ctime_ms: i64::try_from(p.ctime_ms).ok(), mtime_ms: i64::try_from(p.mtime_ms).ok(),
            }).collect::<Vec<_>>();
        let options = QueryOptions { current_entry_id: Some(current_entry_id.clone()), view_index: view_index.unwrap_or(0),
            search_terms: search_terms.clone(), ignore_paths: ignore_paths.clone(), ..QueryOptions::default() };
        let selection = select_calendar_tasks(pin.generation(), registry, Some(CalendarBaseSelection {
            program: &program, presentation: &facts, options: &options, view_name: view_name.as_deref(),
        }), context)?;
        Ok((selection, Some(definition)))
    }
    fn calendar_labels(&self, pin: &DocumentQueryPin, registry: &TypeRegistry, types: &[TaskTypeSummary], ids: &[EntryId], out: &mut Vec<serde_json::Value>) -> NativeDocumentResult<Vec<CalendarLinkLabel>> {
        use zorid_bases::calendar::{resolve_calendar_links, CalendarLink};
        let result = resolve_calendar_links(pin.generation(), registry, ids)?;
        diagnostics("task", &result.diagnostics, out)?;
        diagnostics("type", &result.type_diagnostics, out)?;
        diagnostics("metadata", &result.metadata_issues, out)?;
        result.links.into_iter().map(|link| Ok(match link {
            CalendarLink::Task { entry_id, row } => { let task_type = types.iter().find(|t| t.type_id == row.type_id)
                .ok_or_else(|| invalid("type-source", "Task Type summary unavailable"))?.clone();
                CalendarLinkLabel::Task { entry_id, row, task_type } },
            CalendarLink::Missing { entry_id, path, reason } => CalendarLinkLabel::Missing { entry_id, path, reason },
            CalendarLink::NotTask { entry_id, path, reason } => CalendarLinkLabel::NotTask { entry_id, path, reason },
            CalendarLink::Unavailable { entry_id, path, reason } => CalendarLinkLabel::Unavailable { entry_id, path, reason },
        })).collect()
    }
    fn calendar_deliver(&self, lease: &ClientLease, session: &WorkBlockSession, pin: &DocumentQueryPin, value: CalendarReadValue) -> NativeDocumentResult<DocumentQueryResult<CalendarReadValue>> {
        self.calendar_admit(lease, session, pin)?;
        if let Some(watermark) = &value.evidence.work_block_watermark { self.workblock_fence(session, watermark)?; }
        let result = self.document_result(pin, value)?;
        if encoded(&result)? > STEP_BYTES { return Err(invalid("budget", "Expanded Calendar reply exceeds 1 MiB")); }
        Ok(result)
    }
}
