//! Same-generation file selection and task labels. Hosts own pin admission,
//! saved definition loading and WorkBlock joins; no managed records enter here.
use crate::tasks::{project_task_record, validate_registry, TaskDiagnostic, TaskRow};
use crate::types::{StatusCategory, TypeDiagnostic, TypeRegistry};
use crate::{
    BaseProgram, BaseQueryResult, BaseSnapshot, EntryId, ExpressionDiagnostic,
    FilePresentationFacts, IndexSnapshotId, MetadataIssue, QueryOptions, RecordWitness,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use zorid_index::Generation;

pub const MAX_CALENDAR_TASK_ROWS: usize = 1000;
pub const MAX_CALENDAR_LINKS: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarContext {
    pub clock_ms: i64,
    pub timezone: String,
}
impl CalendarContext {
    /// Validate host read context without selecting or materializing any tasks.
    pub fn validate(&self) -> Result<(), ExpressionDiagnostic> {
        self.timezone
            .parse::<chrono_tz::Tz>()
            .map_err(|_| ExpressionDiagnostic::new("timezone", "Expected IANA timezone"))?;
        chrono::DateTime::from_timestamp_millis(self.clock_ms)
            .ok_or_else(|| ExpressionDiagnostic::new("clock", "Invalid calendar clock"))?;
        Ok(())
    }
}

/// The host loads/compiles the saved definition from the admitted pin. Optional
/// exact view names resolve here; options retain search, ignore paths and `this`.
pub struct CalendarBaseSelection<'a> {
    pub program: &'a BaseProgram,
    pub presentation: &'a [FilePresentationFacts],
    pub options: &'a QueryOptions,
    pub view_name: Option<&'a str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarTaskSelection {
    pub snapshot_id: IndexSnapshotId,
    pub type_witnesses: Vec<RecordWitness>,
    pub selected_files: usize,
    pub selected_tasks: usize,
    pub excluded_non_tasks: usize,
    /// Complete ordered membership set, including completed tasks.
    pub rows: Vec<TaskRow>,
    pub coverage_complete: bool,
    pub base_result: Option<BaseQueryResult>,
    pub diagnostics: Vec<TaskDiagnostic>,
    pub type_diagnostics: Vec<TypeDiagnostic>,
    pub metadata_issues: Vec<MetadataIssue>,
}
impl CalendarTaskSelection {
    /// Picker visibility never changes the membership set or its counts.
    pub fn picker_rows(&self, show_done: bool) -> impl Iterator<Item = &TaskRow> {
        self.rows
            .iter()
            .filter(move |row| show_done || row.category != Some(StatusCategory::Done))
    }
}

/// Select the exact saved view before projecting/counting task rows. Budget
/// failures are errors, never partial selections or evidence of absent tasks.
pub fn select_calendar_tasks(
    generation: &Generation,
    registry: &TypeRegistry,
    base: Option<CalendarBaseSelection<'_>>,
    context: &CalendarContext,
) -> Result<CalendarTaskSelection, ExpressionDiagnostic> {
    context.validate()?;
    validate_registry(generation, registry)?;
    let base_result = base
        .map(|base| {
            let mut options = base.options.clone();
            options.evaluation.clock_ms = context.clock_ms;
            options.evaluation.timezone = context.timezone.clone();
            if let Some(name) = base.view_name {
                options.view_index = base.program.view_index_by_name(name).ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "configuration",
                        "Missing or ambiguous Base view name",
                    )
                })?;
            }
            crate::query_generation(base.program, generation, base.presentation, &options)
        })
        .transpose()?;
    let snapshot = BaseSnapshot::from_generation(generation, &[])?;
    let by_id = snapshot
        .records()
        .iter()
        .map(|r| (&r.witness.as_ref().expect("generation witness").entry_id, r))
        .collect::<HashMap<_, _>>();
    let selected = if let Some(base) = &base_result {
        base.rows
            .iter()
            .map(|r| {
                by_id.get(&r.entry_id).copied().ok_or_else(|| {
                    ExpressionDiagnostic::new("stale-source", "Base row absent from generation")
                })
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        // Stable standalone ordering; no prior task-prefix query.
        let mut records = snapshot.records().iter().collect::<Vec<_>>();
        records.sort_by(|a, b| a.path.cmp(&b.path));
        records
    };
    let unavailable = snapshot
        .metadata_issues
        .iter()
        .filter(|i| i.properties_unavailable)
        .map(|i| &i.witness.entry_id)
        .collect::<HashSet<_>>();
    let mut result = CalendarTaskSelection {
        snapshot_id: generation.id().clone(),
        type_witnesses: registry
            .sources()
            .iter()
            .map(|s| s.witness.clone())
            .collect(),
        selected_files: selected.len(),
        selected_tasks: 0,
        excluded_non_tasks: 0,
        rows: Vec::new(),
        coverage_complete: registry.diagnostics().is_empty()
            && generation.coverage_complete()
            && !snapshot
                .metadata_issues
                .iter()
                .any(|i| i.properties_unavailable)
            && base_result
                .as_ref()
                .is_none_or(|b| b.metadata_complete && b.diagnostics.is_empty()),
        base_result,
        diagnostics: Vec::new(),
        type_diagnostics: registry.diagnostics().to_vec(),
        metadata_issues: snapshot.metadata_issues.clone(),
    };
    for record in selected {
        // Never project partial/broken frontmatter as a valid task capability.
        if unavailable.contains(
            &record
                .witness
                .as_ref()
                .expect("generation witness")
                .entry_id,
        ) {
            continue;
        }
        if let Some((row, _)) = project_task_record(record, registry, &mut result.diagnostics) {
            if result.rows.len() == MAX_CALENDAR_TASK_ROWS {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Calendar exceeds selected-task row budget",
                ));
            }
            result.rows.push(row);
        }
    }
    result.selected_tasks = result.rows.len();
    // This is an omitted-file count, not proof each omitted file is a non-task.
    // Diagnostics and coverage qualify unavailable Type/metadata cases.
    result.excluded_non_tasks = result.selected_files - result.selected_tasks;
    result.coverage_complete &= !result
        .diagnostics
        .iter()
        .any(|d| matches!(d.code.as_str(), "invalid_note_type" | "unknown_note_type"));
    crate::encoded_size(&result, crate::MAX_QUERY_OUTPUT_BYTES)?;
    Ok(result)
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CalendarLink {
    Task {
        #[serde(rename = "entryId")]
        entry_id: EntryId,
        row: TaskRow,
    },
    Missing {
        #[serde(rename = "entryId")]
        entry_id: EntryId,
        path: Option<String>,
        reason: String,
    },
    NotTask {
        #[serde(rename = "entryId")]
        entry_id: EntryId,
        path: Option<String>,
        reason: String,
    },
    Unavailable {
        #[serde(rename = "entryId")]
        entry_id: EntryId,
        path: Option<String>,
        reason: String,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLinkResult {
    pub snapshot_id: IndexSnapshotId,
    pub links: Vec<CalendarLink>,
    pub diagnostics: Vec<TaskDiagnostic>,
    pub type_diagnostics: Vec<TypeDiagnostic>,
    pub metadata_issues: Vec<MetadataIssue>,
}

/// Resolve original identities independently of Base selection/showDone. The
/// visible retained manifest cannot prove deletion: absent IDs stay missing.
pub fn resolve_calendar_links(
    generation: &Generation,
    registry: &TypeRegistry,
    entry_ids: &[EntryId],
) -> Result<CalendarLinkResult, ExpressionDiagnostic> {
    if entry_ids.len() > MAX_CALENDAR_LINKS {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Too many Calendar links",
        ));
    }
    validate_registry(generation, registry)?;
    let snapshot = BaseSnapshot::from_generation(generation, &[])?;
    let by_id = snapshot
        .records()
        .iter()
        .map(|r| (&r.witness.as_ref().expect("generation witness").entry_id, r))
        .collect::<HashMap<_, _>>();
    let mut result = CalendarLinkResult {
        snapshot_id: generation.id().clone(),
        links: Vec::new(),
        diagnostics: Vec::new(),
        type_diagnostics: registry.diagnostics().to_vec(),
        metadata_issues: snapshot.metadata_issues.clone(),
    };
    for entry_id in entry_ids {
        let link = if let Some(entry) = generation.manifest().entry(entry_id) {
            let path = Some(entry.path.as_str().to_owned());
            let record = by_id.get(entry_id).copied();
            let bad_metadata = snapshot
                .metadata_issues
                .iter()
                .any(|i| &i.witness.entry_id == entry_id && i.properties_unavailable);
            let before = result.diagnostics.len();
            let row = if !bad_metadata {
                record.and_then(|r| project_task_record(r, registry, &mut result.diagnostics))
            } else {
                None
            };
            if let Some((row, _)) = row {
                CalendarLink::Task {
                    entry_id: entry_id.clone(),
                    row,
                }
            } else if bad_metadata
                || record.is_none()
                || !registry.diagnostics().is_empty()
                || !generation.coverage_complete()
                || result.diagnostics.len() != before
            {
                CalendarLink::Unavailable {
                    entry_id: entry_id.clone(),
                    path,
                    reason: "Task metadata or Type knowledge unavailable".into(),
                }
            } else {
                CalendarLink::NotTask {
                    entry_id: entry_id.clone(),
                    path,
                    reason: "No longer a task".into(),
                }
            }
        } else {
            CalendarLink::Missing {
                entry_id: entry_id.clone(),
                path: None,
                reason: "Unavailable task".into(),
            }
        };
        result.links.push(link);
    }
    crate::encoded_size(&result, crate::MAX_QUERY_OUTPUT_BYTES)?;
    Ok(result)
}
