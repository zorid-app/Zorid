//! Task capability projection over the existing pinned document-generation facts.
use crate::types::{date_only, StatusCategory, TypeDiagnostic, TypeRegistry};
use crate::{BaseSnapshot, ExpressionDiagnostic, IndexSnapshotId, PropertyValue, RecordWitness};
use chrono::DateTime;
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zorid_index::Generation;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskFilter {
    #[default]
    All,
    Today,
    Unscheduled,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskQueryOptions {
    pub filter: TaskFilter,
    pub clock_ms: i64,
    pub timezone: String,
    pub show_done: bool,
    pub max_rows: usize,
}
impl Default for TaskQueryOptions {
    fn default() -> Self {
        Self {
            filter: TaskFilter::All,
            clock_ms: 0,
            timezone: "UTC".into(),
            show_done: false,
            max_rows: 1000,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiagnostic {
    pub witness: RecordWitness,
    pub property: String,
    pub code: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub witness: RecordWitness,
    pub path: String,
    pub title: String,
    pub type_id: String,
    pub status_id: Option<String>,
    pub status_label: Option<String>,
    pub category: Option<StatusCategory>,
    pub status_defaulted: bool,
    pub planned_day: Option<String>,
    pub deadline: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    pub type_id: String,
    pub category: Option<StatusCategory>,
    pub status_id: Option<String>,
    pub entry_ids: Vec<crate::EntryId>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueryResult {
    pub snapshot_id: IndexSnapshotId,
    pub type_witnesses: Vec<RecordWitness>,
    pub coverage_complete: bool,
    pub rows: Vec<TaskRow>,
    pub groups: Vec<TaskGroup>,
    pub matched: usize,
    pub truncated: bool,
    pub diagnostics: Vec<TaskDiagnostic>,
    pub type_diagnostics: Vec<TypeDiagnostic>,
    pub metadata_issues: Vec<crate::MetadataIssue>,
}
fn property<'a>(pairs: &'a [(String, PropertyValue)], key: &str) -> Option<&'a PropertyValue> {
    pairs.iter().find_map(|(k, v)| (k == key).then_some(v))
}
fn date(
    value: Option<&PropertyValue>,
    key: &str,
    witness: &RecordWitness,
    diagnostics: &mut Vec<TaskDiagnostic>,
) -> (Option<String>, bool) {
    match value {
        None | Some(PropertyValue::Null) => (None, true),
        Some(PropertyValue::String(s)) if s.is_empty() => (None, true),
        Some(PropertyValue::String(s)) if date_only(s) => (Some(s.clone()), false),
        _ => {
            diagnostics.push(TaskDiagnostic {
                witness: witness.clone(),
                property: key.into(),
                code: "invalid_task_date".into(),
            });
            (None, false)
        }
    }
}
/// Type configuration revisions must belong to this exact namespace generation.
/// No current-path substitution, detached rows or mutable host metadata are read.
/// Hosts still own pin admission/revocation/expiry and must recheck before
/// delivering results; a borrowed Generation itself is not a live capability.
pub fn query_tasks(
    generation: &Generation,
    registry: &TypeRegistry,
    options: &TaskQueryOptions,
) -> Result<TaskQueryResult, ExpressionDiagnostic> {
    if options.max_rows == 0 || options.max_rows > crate::MAX_QUERY_ROWS {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Invalid task row budget",
        ));
    }
    let timezone: Tz = options
        .timezone
        .parse()
        .map_err(|_| ExpressionDiagnostic::new("timezone", "Expected IANA timezone"))?;
    let today = DateTime::from_timestamp_millis(options.clock_ms)
        .ok_or_else(|| ExpressionDiagnostic::new("clock", "Invalid task clock"))?
        .with_timezone(&timezone)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    validate_registry(generation, registry)?;
    // Reuse the sealed Base extraction/coverage path, never parse or evaluate
    // Markdown a second time. Predefined task predicates are domain filters.
    let snapshot = BaseSnapshot::from_generation(generation, &[])?;
    let mut result = TaskQueryResult {
        snapshot_id: generation.id().clone(),
        type_witnesses: registry
            .sources()
            .iter()
            .map(|s| s.witness.clone())
            .collect(),
        coverage_complete: registry.diagnostics().is_empty()
            && generation.coverage_complete()
            && !snapshot
                .metadata_issues
                .iter()
                .any(|i| i.properties_unavailable),
        rows: Vec::new(),
        groups: Vec::new(),
        matched: 0,
        truncated: false,
        diagnostics: Vec::new(),
        type_diagnostics: registry.diagnostics().to_vec(),
        metadata_issues: snapshot.metadata_issues.clone(),
    };
    for record in snapshot.records() {
        let Some((row, unscheduled)) =
            project_task_record(record, registry, &mut result.diagnostics)
        else {
            continue;
        };
        let done = row.category == Some(StatusCategory::Done);
        if done && !options.show_done {
            continue;
        }
        let matches = match options.filter {
            TaskFilter::All => true,
            // Invalid mapped dates must not qualify as unscheduled.
            TaskFilter::Unscheduled => unscheduled,
            TaskFilter::Today => {
                row.planned_day.as_ref() == Some(&today)
                    || (!done && row.deadline.as_ref().is_some_and(|d| d <= &today))
            }
        };
        if matches {
            result.rows.push(row);
        }
    }
    result.rows.sort_by(|a, b| {
        let date_cmp = match (&a.deadline, &b.deadline) {
            (Some(a), Some(b)) => a.cmp(b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        };
        date_cmp
            .then(a.title.cmp(&b.title))
            .then(a.witness.entry_id.cmp(&b.witness.entry_id))
    });
    result.matched = result.rows.len();
    result.truncated = result.matched > options.max_rows;
    result.rows.truncate(options.max_rows);
    let mut groups: BTreeMap<
        (Option<StatusCategory>, String, Option<String>),
        Vec<crate::EntryId>,
    > = BTreeMap::new();
    for row in &result.rows {
        groups
            .entry((
                row.category.clone(),
                row.type_id.clone(),
                row.status_id.clone(),
            ))
            .or_default()
            .push(row.witness.entry_id.clone());
    }
    // Unknown status groups follow the three semantic categories.
    result.groups = groups
        .into_iter()
        .map(|((category, type_id, status_id), entry_ids)| TaskGroup {
            type_id,
            category,
            status_id,
            entry_ids,
        })
        .collect();
    result.groups.sort_by_key(|g| {
        (
            g.category.is_none(),
            g.category.clone(),
            g.type_id.clone(),
            g.status_id.clone(),
        )
    });
    crate::encoded_size(&result, crate::MAX_QUERY_OUTPUT_BYTES)?;
    Ok(result)
}

/// Shared capability projection; callers select records before materialization.
pub(crate) fn project_task_record(
    record: &crate::DetachedRecord,
    registry: &TypeRegistry,
    diagnostics: &mut Vec<TaskDiagnostic>,
) -> Option<(TaskRow, bool)> {
    if !record
        .path
        .rsplit('.')
        .next()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return None;
    }
    let witness = record
        .witness
        .as_ref()
        .expect("generation rows have witnesses");
    let Some(type_value) = property(&record.properties, "type") else {
        return None;
    };
    let Some(type_id) = type_value.as_str() else {
        diagnostics.push(TaskDiagnostic {
            witness: witness.clone(),
            property: "type".into(),
            code: "invalid_note_type".into(),
        });
        return None;
    };
    let Some(definition) = registry.get(type_id) else {
        diagnostics.push(TaskDiagnostic {
            witness: witness.clone(),
            property: "type".into(),
            code: "unknown_note_type".into(),
        });
        return None;
    };
    let Some(mapping) = &definition.capabilities.task else {
        return None;
    };
    let status = definition
        .property(&mapping.status)
        .expect("validated mapping");
    let raw_status = property(&record.properties, &status.key);
    let defaulted = raw_status.is_none();
    let status_id = raw_status
        .or(status.default.as_ref())
        .and_then(PropertyValue::as_str)
        .map(String::from);
    let option = status_id
        .as_ref()
        .and_then(|id| status.options.iter().find(|o| &o.id == id));
    if option.is_none() {
        diagnostics.push(TaskDiagnostic {
            witness: witness.clone(),
            property: status.key.clone(),
            code: "unknown_task_status".into(),
        });
    }
    let mut mapped_date = |id: &Option<String>| {
        id.as_ref()
            .map(|id| definition.property(id).expect("validated mapping"))
            .map(|p| {
                date(
                    property(&record.properties, &p.key),
                    &p.key,
                    witness,
                    diagnostics,
                )
            })
            .unwrap_or((None, true))
    };
    let (planned_day, unscheduled) = mapped_date(&mapping.planned_day);
    let (deadline, _) = mapped_date(&mapping.deadline);
    let category = option.and_then(|o| o.category.clone());
    Some((
        TaskRow {
            witness: witness.clone(),
            title: record
                .path
                .rsplit('/')
                .next()
                .unwrap_or(&record.path)
                .rsplit_once('.')
                .map(|(stem, _)| stem)
                .unwrap_or(&record.path)
                .into(),
            path: record.path.clone(),
            type_id: type_id.into(),
            status_id,
            status_label: option.map(|o| o.label.clone()),
            category,
            status_defaulted: defaulted,
            planned_day,
            deadline,
        },
        unscheduled,
    ))
}

pub(crate) fn validate_registry(
    generation: &Generation,
    registry: &TypeRegistry,
) -> Result<(), ExpressionDiagnostic> {
    for source in registry.sources() {
        let entry = generation
            .manifest()
            .entry(&source.witness.entry_id)
            .ok_or_else(|| {
                ExpressionDiagnostic::new("stale-source", "Type file absent from generation")
            })?;
        if entry.path.as_str() != source.path
            || entry.revision != source.witness.revision
            || entry.kind != zorid_core::EntryKind::File
        {
            return Err(ExpressionDiagnostic::new(
                "stale-source",
                "Type file changed",
            ));
        }
    }
    Ok(())
}
