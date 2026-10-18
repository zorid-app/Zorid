//! Bounded two-source observation, never a cross-Store atomic snapshot.
use super::*;
use crate::document_api::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub use zorid_bases::calendar::CalendarContext;
use zorid_bases::calendar::{CalendarBaseSelection, CalendarTaskSelection};
use zorid_bases::tasks::TaskRow;
use zorid_bases::types::{TaskTypeSummary, TypeRegistry};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CalendarScope {
    Tasks {
        type_ids: Vec<EntryId>,
    },
    Base {
        type_ids: Vec<EntryId>,
        definition_id: EntryId,
        view_name: Option<String>,
        view_index: Option<usize>,
        current_entry_id: EntryId,
        #[serde(default)]
        search_terms: Vec<String>,
        #[serde(default)]
        ignore_paths: Vec<String>,
    },
}
impl CalendarScope {
    fn type_ids(&self) -> &[EntryId] {
        match self {
            Self::Tasks { type_ids } | Self::Base { type_ids, .. } => type_ids,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CalendarRead {
    Window {
        scope: CalendarScope,
        context: CalendarContext,
        from_ms: String,
        until_ms: String,
        cursor: Option<String>,
        limit: u32,
        byte_limit: u32,
        expected_work_block_watermark: Option<String>,
    },
    Tasks {
        scope: CalendarScope,
        context: CalendarContext,
        without_blocks: bool,
        show_done: bool,
        cursor: Option<String>,
        limit: u32,
        byte_limit: u32,
    },
    Links {
        type_ids: Vec<EntryId>,
        entry_ids: Vec<EntryId>,
        context: CalendarContext,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarLinkLabel {
    Task {
        entry_id: EntryId,
        row: TaskRow,
        #[serde(rename = "type")]
        task_type: TaskTypeSummary,
    },
    Missing {
        entry_id: EntryId,
        path: Option<String>,
        reason: String,
    },
    NotTask {
        entry_id: EntryId,
        path: Option<String>,
        reason: String,
    },
    Unavailable {
        entry_id: EntryId,
        path: Option<String>,
        reason: String,
    },
}
#[derive(Clone, Debug, Serialize)]
pub struct CalendarTarget {
    pub record: zorid_records::Id,
    pub generation: zorid_records::Id,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CalendarMembership {
    Present { witness: CalendarTarget },
    Absent,
    Unknown { reason: String },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSelection {
    pub definition: Option<EntryState>,
    pub selected_files: usize,
    pub selected_tasks: usize,
    pub excluded_non_tasks: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvidence {
    pub document_snapshot: IndexSnapshotId,
    pub document_source: SourceSnapshotId,
    pub document_coverage_complete: bool,
    pub task_coverage_complete: bool,
    pub work_block_watermark: Option<String>,
    pub work_block_scan_complete: bool,
    pub membership_complete: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct CalendarBlock {
    pub value: WorkBlockRead,
    pub links: Vec<CalendarLinkLabel>,
}
#[derive(Clone, Debug, Serialize)]
pub struct CalendarTask {
    pub row: TaskRow,
    #[serde(rename = "type")]
    pub task_type: TaskTypeSummary,
    pub membership: CalendarMembership,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarReadValue {
    pub kind: String,
    pub selection: Option<CalendarSelection>,
    pub evidence: CalendarEvidence,
    pub phase: String,
    pub cursor: Option<String>,
    pub scanned: u32,
    pub bytes: u32,
    pub blocks: Vec<CalendarBlock>,
    pub tasks: Vec<CalendarTask>,
    pub links: Vec<CalendarLinkLabel>,
    /// Original diagnostic objects, tagged by engine; witnesses/ranges are preserved.
    pub diagnostics: Vec<serde_json::Value>,
    pub base_result: Option<zorid_bases::BaseQueryResult>,
}
/// Host-owned alongside its exact pin. Clear before closing the pin/releasing its
/// client. No capabilities, query rows or cursors are accepted from the renderer.
#[derive(Default)]
pub struct CalendarJoinState {
    active: Option<Join>,
}
impl CalendarJoinState {
    pub fn has_active(&self) -> bool {
        self.active.is_some()
    }
    pub fn clear(&mut self) {
        self.active = None;
    }
}
struct Join {
    _slot: CalendarSlot,
    identity: String,
    snapshot: IndexSnapshotId,
    source: SourceSnapshotId,
    watermark: String,
    selection: CalendarTaskSelection,
    definition: Option<EntryState>,
    registry: TypeRegistry,
    types: Vec<TaskTypeSummary>,
    present: BTreeMap<EntryId, CalendarTarget>,
    uncertain: bool,
    after: Option<String>,
    records_done: bool,
    summary: Option<zorid_store::ManagedUnresolvedCursor>,
    summary_done: bool,
    pages: usize,
    bytes: usize,
    offset: usize,
    token: Option<String>,
}
const STEP_BYTES: usize = 1024 * 1024;
const RETAIN_BYTES: usize = 8 * STEP_BYTES;
fn invalid(code: &str, message: &str) -> NativeDocumentError {
    zorid_bases::ExpressionDiagnostic::new(code, message).into()
}
fn encoded<T: Serialize>(value: &T) -> NativeDocumentResult<usize> {
    Ok(serde_json::to_vec(value)
        .map_err(|_| invalid("codec", "Calendar encoding failed"))?
        .len())
}
fn diagnostics<T: Serialize>(
    engine: &str,
    values: &[T],
    out: &mut Vec<serde_json::Value>,
) -> NativeDocumentResult<()> {
    for value in values {
        let mut v = serde_json::to_value(value)
            .map_err(|_| invalid("codec", "Calendar diagnostics failed"))?;
        if let Some(v) = v.as_object_mut() {
            v.insert("engine".into(), engine.into());
        }
        out.push(v);
    }
    Ok(())
}
#[cfg(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "ios",
    target_os = "android"
))]
impl NativeVault {
    fn calendar_admit(
        &self,
        lease: &ClientLease,
        session: &WorkBlockSession,
        pin: &DocumentQueryPin,
    ) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        self.verify_client_lease(lease)
            .map_err(WorkBlockError::from)?;
        if lease.reference() != &session.lease
            || self
                .store
                .family_status()
                .map_err(Error::from)?
                .scope
                .as_ref()
                != Some(&session.scope)
        {
            return Err(WorkBlockError::StaleSession.into());
        }
        self.document_manifest(pin)?;
        if self.document_index_status_with_source()?.0 != *pin.generation().manifest().source() {
            return Err(zorid_index::IndexError::StaleSource.into());
        }
        self.store
            .managed_watermark(&session.handle)
            .map_err(Error::from)?;
        Ok(())
    }
    fn calendar_registry(
        &self,
        pin: &DocumentQueryPin,
        ids: &[EntryId],
    ) -> NativeDocumentResult<TypeRegistry> {
        use zorid_bases::types::*;
        if ids.len() > MAX_TYPE_SOURCES {
            return Err(invalid("budget", "Too many Type selectors"));
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut sources = Vec::new();
        let mut total = 0usize;
        for id in ids {
            if !seen.insert(id) {
                return Err(invalid("type-source", "Duplicate Type selector"));
            }
            let projected = self.store.read_document_projection(pin, id)?;
            let bytes = projected
                .content
                .ok_or_else(|| NativeDocumentError::SourceUnavailable(id.clone()))?;
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| invalid("budget", "Type byte budget"))?;
            if bytes.len() > MAX_TYPE_SOURCE_BYTES || total > MAX_TYPE_BYTES {
                return Err(invalid("budget", "Type byte budget"));
            }
            let entry = projected.witness.entry();
            sources.push(TypeYamlSource {
                witness: zorid_bases::RecordWitness {
                    entry_id: entry.id.clone(),
                    revision: entry.revision.clone(),
                },
                path: entry.path.to_string(),
                source: String::from_utf8(bytes)
                    .map_err(|_| NativeDocumentError::SourceUnavailable(id.clone()))?,
            });
        }
        Ok(compile_type_yaml(sources)?)
    }
    fn calendar_selection(
        &self,
        pin: &DocumentQueryPin,
        registry: &TypeRegistry,
        scope: &CalendarScope,
        context: &CalendarContext,
    ) -> NativeDocumentResult<(CalendarTaskSelection, Option<EntryState>)> {
        use zorid_bases::calendar::select_calendar_tasks;
        let CalendarScope::Base {
            definition_id,
            view_name,
            view_index,
            current_entry_id,
            search_terms,
            ignore_paths,
            ..
        } = scope
        else {
            return Ok((
                select_calendar_tasks(pin.generation(), registry, None, context)?,
                None,
            ));
        };
        if view_name.is_some() && view_index.is_some() {
            return Err(invalid("invalid_query", "Choose one Base view selector"));
        }
        let manifest = self.document_manifest(pin)?;
        let projected = self.store.read_document_projection(pin, definition_id)?;
        let definition = projected.witness.entry().clone();
        let bytes = projected
            .content
            .ok_or_else(|| NativeDocumentError::SourceUnavailable(definition_id.clone()))?;
        let source = std::str::from_utf8(&bytes)
            .map_err(|_| NativeDocumentError::SourceUnavailable(definition_id.clone()))?;
        let program = zorid_bases::compile_base_source(source)?;
        let facts = manifest
            .entries()
            .iter()
            .zip(manifest.presentations())
            .filter(|(entry, _)| entry.state.kind == zorid_core::EntryKind::File)
            .map(|(entry, p)| zorid_bases::FilePresentationFacts {
                witness: zorid_bases::RecordWitness {
                    entry_id: entry.state.id.clone(),
                    revision: entry.state.revision.clone(),
                },
                size: Some(p.size_bytes),
                ctime_ms: i64::try_from(p.ctime_ms).ok(),
                mtime_ms: i64::try_from(p.mtime_ms).ok(),
            })
            .collect::<Vec<_>>();
        let options = QueryOptions {
            current_entry_id: Some(current_entry_id.clone()),
            view_index: view_index.unwrap_or(0),
            search_terms: search_terms.clone(),
            ignore_paths: ignore_paths.clone(),
            ..QueryOptions::default()
        };
        let selection = select_calendar_tasks(
            pin.generation(),
            registry,
            Some(CalendarBaseSelection {
                program: &program,
                presentation: &facts,
                options: &options,
                view_name: view_name.as_deref(),
            }),
            context,
        )?;
        Ok((selection, Some(definition)))
    }
    fn calendar_labels(
        &self,
        pin: &DocumentQueryPin,
        registry: &TypeRegistry,
        types: &[TaskTypeSummary],
        ids: &[EntryId],
        out: &mut Vec<serde_json::Value>,
    ) -> NativeDocumentResult<Vec<CalendarLinkLabel>> {
        use zorid_bases::calendar::{resolve_calendar_links, CalendarLink};
        let result = resolve_calendar_links(pin.generation(), registry, ids)?;
        diagnostics("task", &result.diagnostics, out)?;
        diagnostics("type", &result.type_diagnostics, out)?;
        diagnostics("metadata", &result.metadata_issues, out)?;
        result
            .links
            .into_iter()
            .map(|link| {
                Ok(match link {
                    CalendarLink::Task { entry_id, row } => {
                        let task_type = types
                            .iter()
                            .find(|t| t.type_id == row.type_id)
                            .ok_or_else(|| invalid("type-source", "Task Type summary unavailable"))?
                            .clone();
                        CalendarLinkLabel::Task {
                            entry_id,
                            row,
                            task_type,
                        }
                    }
                    CalendarLink::Missing {
                        entry_id,
                        path,
                        reason,
                    } => CalendarLinkLabel::Missing {
                        entry_id,
                        path,
                        reason,
                    },
                    CalendarLink::NotTask {
                        entry_id,
                        path,
                        reason,
                    } => CalendarLinkLabel::NotTask {
                        entry_id,
                        path,
                        reason,
                    },
                    CalendarLink::Unavailable {
                        entry_id,
                        path,
                        reason,
                    } => CalendarLinkLabel::Unavailable {
                        entry_id,
                        path,
                        reason,
                    },
                })
            })
            .collect()
    }
    fn calendar_deliver(
        &self,
        lease: &ClientLease,
        session: &WorkBlockSession,
        pin: &DocumentQueryPin,
        value: CalendarReadValue,
    ) -> NativeDocumentResult<DocumentQueryResult<CalendarReadValue>> {
        self.calendar_admit(lease, session, pin)?;
        if let Some(watermark) = &value.evidence.work_block_watermark {
            self.workblock_fence(session, watermark)?;
        }
        let result = self.document_result(pin, value)?;
        if encoded(&result)? > STEP_BYTES {
            return Err(invalid("budget", "Expanded Calendar reply exceeds 1 MiB"));
        }
        Ok(result)
    }
}

struct CalendarSlot(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl Drop for CalendarSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}
impl Join {
    fn retained_bytes(&self) -> NativeDocumentResult<usize> {
        Ok(encoded(&(
            &self.identity,
            &self.snapshot,
            &self.source,
            &self.watermark,
            &self.selection,
            &self.definition,
            &self.types,
            &self.present,
            &self.after,
            &self.token,
        ))? + 3 * encoded(&self.registry.sources())?
            + 8192)
    }
    fn value(&self, pin: &DocumentQueryPin, kind: &str) -> NativeDocumentResult<CalendarReadValue> {
        let mut out = Vec::new();
        diagnostics("task", &self.selection.diagnostics, &mut out)?;
        diagnostics("type", &self.selection.type_diagnostics, &mut out)?;
        diagnostics("metadata", &self.selection.metadata_issues, &mut out)?;
        let complete = self.records_done && self.summary_done;
        Ok(CalendarReadValue {
            kind: kind.into(),
            selection: Some(CalendarSelection {
                definition: self.definition.clone(),
                selected_files: self.selection.selected_files,
                selected_tasks: self.selection.selected_tasks,
                excluded_non_tasks: self.selection.excluded_non_tasks,
            }),
            evidence: CalendarEvidence {
                document_snapshot: self.snapshot.clone(),
                document_source: self.source.clone(),
                document_coverage_complete: pin.generation().coverage_complete(),
                task_coverage_complete: self.selection.coverage_complete,
                work_block_watermark: Some(self.watermark.clone()),
                work_block_scan_complete: complete,
                membership_complete: complete
                    && !self.uncertain
                    && self.selection.coverage_complete,
            },
            phase: if complete { "results" } else { "scan" }.into(),
            cursor: None,
            scanned: 0,
            bytes: 0,
            blocks: Vec::new(),
            tasks: Vec::new(),
            links: Vec::new(),
            diagnostics: out,
            base_result: self.selection.base_result.clone(),
        })
    }
}
#[cfg(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "ios",
    target_os = "android"
))]
impl NativeVault {
    /// Host must keep `join` with this exact pin and clear it before pin/client
    /// release. Each continuation is single-use; expired tokens never restart.
    pub fn query_calendar_documents(
        &mut self,
        lease: &ClientLease,
        session: &mut WorkBlockSession,
        pin: &DocumentQueryPin,
        join: &mut CalendarJoinState,
        request: CalendarRead,
    ) -> NativeDocumentResult<DocumentQueryResult<CalendarReadValue>> {
        let result = self.calendar_query_inner(lease, session, pin, join, request);
        if result.is_err() {
            join.clear();
        }
        result
    }
    fn calendar_query_inner(
        &mut self,
        lease: &ClientLease,
        session: &mut WorkBlockSession,
        pin: &DocumentQueryPin,
        retained: &mut CalendarJoinState,
        mut request: CalendarRead,
    ) -> NativeDocumentResult<DocumentQueryResult<CalendarReadValue>> {
        self.calendar_admit(lease, session, pin)?;
        if let CalendarRead::Links {
            type_ids,
            entry_ids,
            context,
        } = request
        {
            retained.clear();
            // Validate the explicit context even though link projection has no clock reads.
            let registry = self.calendar_registry(pin, &type_ids)?;
            context.validate()?;
            let types = zorid_bases::types::task_type_summaries(&registry)?;
            let mut out = Vec::new();
            let links = self.calendar_labels(pin, &registry, &types, &entry_ids, &mut out)?;
            let labels_complete = !links
                .iter()
                .any(|label| matches!(label, CalendarLinkLabel::Unavailable { .. }));
            return self.calendar_deliver(
                lease,
                session,
                pin,
                CalendarReadValue {
                    kind: "links".into(),
                    selection: None,
                    evidence: CalendarEvidence {
                        document_snapshot: pin.generation().id().clone(),
                        document_source: pin.generation().manifest().source().clone(),
                        document_coverage_complete: pin.generation().coverage_complete(),
                        task_coverage_complete: labels_complete
                            && registry.diagnostics().is_empty()
                            && pin.generation().coverage_complete(),
                        work_block_watermark: None,
                        work_block_scan_complete: false,
                        membership_complete: false,
                    },
                    phase: "results".into(),
                    cursor: None,
                    scanned: 0,
                    bytes: 0,
                    blocks: Vec::new(),
                    tasks: Vec::new(),
                    links,
                    diagnostics: out,
                    base_result: None,
                },
            );
        }
        let (scope, context, cursor, limit, byte_limit, expected, window) = match &mut request {
            CalendarRead::Window {
                scope,
                context,
                cursor,
                limit,
                byte_limit,
                expected_work_block_watermark,
                from_ms,
                until_ms,
            } => (
                scope.clone(),
                context.clone(),
                cursor.take(),
                *limit,
                *byte_limit,
                expected_work_block_watermark.clone(),
                Some(domain::Window::new(from_ms, until_ms).map_err(WorkBlockError::from)?),
            ),
            CalendarRead::Tasks {
                scope,
                context,
                cursor,
                limit,
                byte_limit,
                ..
            } => (
                scope.clone(),
                context.clone(),
                cursor.take(),
                *limit,
                *byte_limit,
                None,
                None,
            ),
            CalendarRead::Links { .. } => unreachable!(),
        };
        if limit != 64 || byte_limit != STEP_BYTES as u32 {
            return Err(invalid(
                "invalid_budget",
                "Calendar steps require 64 items / 1 MiB",
            ));
        }
        let identity = serde_json::to_string(&request)
            .map_err(|_| invalid("codec", "Calendar query identity"))?;
        let mut join = if let Some(cursor) = cursor {
            let old = retained
                .active
                .take()
                .ok_or(WorkBlockError::CursorExpired)?;
            if old.token.as_deref() != Some(&cursor) {
                return Err(WorkBlockError::CursorExpired.into());
            }
            if old.identity != identity
                || old.snapshot != *pin.generation().id()
                || old.source != *pin.generation().manifest().source()
            {
                return Err(invalid(
                    "query_mismatch",
                    "Calendar continuation does not match pin/request",
                ));
            }
            old
        } else {
            retained.clear();
            let registry = self.calendar_registry(pin, scope.type_ids())?;
            let types = zorid_bases::types::task_type_summaries(&registry)?;
            let (selection, definition) =
                self.calendar_selection(pin, &registry, &scope, &context)?;
            let watermark = self.workblock_watermark(session)?;
            if expected.as_ref().is_some_and(|e| e != &watermark) {
                return Err(WorkBlockError::WindowChanged.into());
            }
            while session.cursors.len()
                + session
                    .calendar_slots
                    .load(std::sync::atomic::Ordering::Relaxed)
                >= 8
            {
                let old = session.order.pop_front().ok_or(WorkBlockError::Limit)?;
                session.cursors.remove(&old);
            }
            session
                .calendar_slots
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Join {
                _slot: CalendarSlot(session.calendar_slots.clone()),
                identity,
                snapshot: pin.generation().id().clone(),
                source: pin.generation().manifest().source().clone(),
                watermark,
                selection,
                definition,
                registry,
                types,
                present: BTreeMap::new(),
                uncertain: false,
                after: None,
                records_done: false,
                summary: None,
                summary_done: false,
                pages: 0,
                bytes: 0,
                offset: 0,
                token: None,
            }
        };
        self.workblock_fence(session, &join.watermark)?;
        if join.retained_bytes()? > RETAIN_BYTES {
            return Err(invalid("budget", "Calendar retained join exceeds 8 MiB"));
        }
        let kind = if window.is_some() { "window" } else { "tasks" };
        let mut value = join.value(pin, kind)?;
        if !join.records_done {
            if join.pages == 128 {
                return Err(invalid(
                    "budget",
                    "Calendar scan exceeds 128 combined pages",
                ));
            }
            join.pages += 1;
            for _ in 0..limit {
                let page = self
                    .store
                    .managed_export(&session.handle, join.after.as_deref(), 1)
                    .map_err(Error::from)?;
                let Some(snapshot) = page.records.into_iter().next() else {
                    join.records_done = true;
                    break;
                };
                let size = encoded(&snapshot)?;
                if size > byte_limit as usize {
                    return Err(invalid("budget", "Calendar record exceeds scan step"));
                }
                if value.bytes as usize + size > byte_limit as usize {
                    break;
                }
                if join.bytes + size > RETAIN_BYTES {
                    return Err(invalid("budget", "Calendar scan exceeds 8 MiB"));
                }
                value.bytes += size as u32;
                value.scanned += 1;
                join.bytes += size;
                join.after = page.next;
                let state = restore(&snapshot)?;
                let in_window = match &window {
                    Some(window) => domain::read(&state)
                        .map_err(WorkBlockError::from)?
                        .as_ref()
                        .map(|block| window.intersects(block))
                        .transpose()
                        .map_err(WorkBlockError::from)?
                        .unwrap_or(false),
                    None => false,
                };
                let read = view(snapshot)?;
                if !read.unresolved.is_empty() || !read.created {
                    join.uncertain = true;
                }
                if !read.created || read.deleted {
                    continue;
                }
                if let Some(block) = &read.block {
                    let witness = CalendarTarget {
                        record: read.record.clone(),
                        generation: read.generation.clone(),
                    };
                    for row in &join.selection.rows {
                        if block.task_refs.contains(&row.witness.entry_id) {
                            join.present
                                .entry(row.witness.entry_id.clone())
                                .or_insert_with(|| witness.clone());
                        }
                    }
                    if window.is_some() {
                        let in_scope = matches!(&scope, CalendarScope::Tasks { .. })
                            || block.task_refs.iter().any(|id| {
                                join.selection
                                    .rows
                                    .iter()
                                    .any(|r| &r.witness.entry_id == id)
                            });
                        if in_window && in_scope {
                            let links = self.calendar_labels(
                                pin,
                                &join.registry,
                                &join.types,
                                &block.task_refs,
                                &mut value.diagnostics,
                            )?;
                            value.blocks.push(CalendarBlock { value: read, links });
                        }
                    }
                } else {
                    join.uncertain = true;
                }
            }
        } else if !join.summary_done {
            if join.pages == 128 {
                return Err(invalid(
                    "budget",
                    "Calendar scan exceeds 128 combined pages",
                ));
            }
            join.pages += 1;
            let summary = self
                .store
                .managed_unresolved_summary(
                    &session.handle,
                    &join.watermark,
                    join.summary.as_ref(),
                    limit,
                    byte_limit,
                )
                .map_err(Error::from)?;
            join.bytes += summary.bytes as usize;
            if join.bytes > RETAIN_BYTES {
                return Err(invalid("budget", "Calendar scan exceeds 8 MiB"));
            }
            value.scanned = summary.examined;
            value.bytes = summary.bytes;
            join.summary_done = summary.complete;
            // Partial Unknown does not persist uncertainty: only settled evidence does.
            if summary.complete
                && summary.evidence == zorid_store::ManagedUnresolvedEvidence::Unknown
            {
                join.uncertain = true;
            }
            join.summary = summary.next;
        }
        let complete = join.records_done && join.summary_done;
        value.evidence.work_block_scan_complete = complete;
        value.evidence.membership_complete =
            complete && !join.uncertain && join.selection.coverage_complete;
        value.phase = if complete { "results" } else { "scan" }.into();
        let mut more = !complete;
        if window.is_none() && complete {
            let (without_blocks, show_done) = match request {
                CalendarRead::Tasks {
                    without_blocks,
                    show_done,
                    ..
                } => (without_blocks, show_done),
                _ => unreachable!(),
            };
            let rows = join
                .selection
                .picker_rows(show_done)
                .filter(|r| !without_blocks || !join.present.contains_key(&r.witness.entry_id))
                .collect::<Vec<_>>();
            for row in rows.iter().skip(join.offset).take(limit as usize) {
                let membership = if let Some(witness) = join.present.get(&row.witness.entry_id) {
                    CalendarMembership::Present {
                        witness: witness.clone(),
                    }
                } else if value.evidence.membership_complete {
                    CalendarMembership::Absent
                } else {
                    CalendarMembership::Unknown {
                        reason: "Local scheduling coverage unavailable".into(),
                    }
                };
                let task_type = join
                    .types
                    .iter()
                    .find(|t| t.type_id == row.type_id)
                    .ok_or_else(|| invalid("type-source", "Task Type summary unavailable"))?
                    .clone();
                value.tasks.push(CalendarTask {
                    row: (**row).clone(),
                    task_type,
                    membership,
                });
            }
            join.offset += value.tasks.len();
            more = join.offset < rows.len();
        }
        if more {
            let token = uuid::Uuid::new_v4().to_string();
            value.cursor = Some(token.clone());
            join.token = Some(token);
        } else {
            join.token = None;
        }
        if join.retained_bytes()? > RETAIN_BYTES {
            return Err(invalid("budget", "Calendar retained join exceeds 8 MiB"));
        }
        let result = self.calendar_deliver(lease, session, pin, value)?;
        if more {
            retained.active = Some(join);
        }
        Ok(result)
    }
}
