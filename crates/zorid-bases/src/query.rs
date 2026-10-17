//! Snapshot query policy around the reused MDBASE expression evaluator. No IO,
//! callbacks, live vault state or storage ownership enters this reducer.
use crate::{
    expression, order,
    program::{self, BaseProgram, Criterion, Filter},
    with_session, BaseValue, DetachedRecord, EvaluationOptions, ExpressionDiagnostic,
    PropertyValue,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseSnapshot {
    pub snapshot_id: String,
    pub records: Vec<DetachedRecord>,
}
#[derive(Clone, Debug)]
pub struct QueryOptions {
    pub view_index: usize,
    pub search_terms: Vec<String>,
    pub ignore_paths: Vec<String>,
    pub evaluation: EvaluationOptions,
    pub max_steps: usize,
    pub max_scanned: usize,
    pub max_rows: usize,
    pub max_groups: usize,
    pub max_output_bytes: usize,
}
impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            view_index: 0,
            search_terms: Vec::new(),
            ignore_paths: Vec::new(),
            evaluation: EvaluationOptions::default(),
            max_steps: 2_000_000,
            max_scanned: 50_000,
            max_rows: 10_000,
            max_groups: 5_000,
            max_output_bytes: 8 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDiagnostic {
    pub phase: String,
    pub entry_id: String,
    pub path: String,
    pub property: Option<String>,
    pub code: String,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRow {
    pub entry_id: String,
    pub revision: String,
    pub path: String,
    pub values: BTreeMap<String, BaseValue>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseGroup {
    pub key: Option<BaseValue>,
    pub entry_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GroupOption {
    pub key: BaseValue,
    pub count: usize,
    pub listed: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCounts {
    pub scanned: usize,
    pub matched: usize,
    pub after_group_order: usize,
    pub after_search: usize,
    pub returned: usize,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseQueryResult {
    pub snapshot_id: String,
    pub view: PropertyValue,
    pub rows: Vec<BaseRow>,
    pub groups: Vec<BaseGroup>,
    pub group_options: Vec<GroupOption>,
    pub properties: Vec<String>,
    pub available_properties: Vec<String>,
    pub counts: QueryCounts,
    pub diagnostics: Vec<QueryDiagnostic>,
    pub steps_used: usize,
}

const FILE_PROPERTIES: &[&str] = &[
    "file.file",
    "file.name",
    "file.basename",
    "file.fullname",
    "file.path",
    "file.folder",
    "file.ext",
    "file.ctime",
    "file.mtime",
    "file.size",
    "file.tags",
];
fn truth(value: &BaseValue) -> bool {
    match value {
        BaseValue::Null | BaseValue::Error { .. } => false,
        BaseValue::Boolean { value } => *value,
        BaseValue::Number { value } => *value != 0.0 && !value.is_nan(),
        BaseValue::String { value } => !value.is_empty(),
        BaseValue::List { value } => !value.is_empty(),
        BaseValue::Object { value } => !value.is_empty(),
        _ => true,
    }
}
fn filter_matches(
    filter: &Filter,
    session: &mut expression::Session<'_>,
) -> Result<bool, ExpressionDiagnostic> {
    match filter {
        Filter::Expression(value) => session.evaluate(value).map(|value| truth(&value)),
        Filter::And(values) => {
            for value in values {
                if !filter_matches(value, session)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Filter::Or(values) => {
            for value in values {
                if filter_matches(value, session)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Filter::Not(values) => {
            for value in values {
                if filter_matches(value, session)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
    }
}
fn report(
    diagnostics: &mut Vec<QueryDiagnostic>,
    record: &DetachedRecord,
    phase: &str,
    property: Option<&str>,
    error: ExpressionDiagnostic,
) {
    let diagnostic = QueryDiagnostic {
        phase: phase.into(),
        entry_id: record.entry_id.clone(),
        path: record.path.clone(),
        property: property.map(String::from),
        code: error.code,
        message: error.message,
    };
    // Each unique entry/property is evaluated once per phase; no quadratic
    // whole-vector de-duplication is needed.
    diagnostics.push(diagnostic);
}
fn fatal(error: &ExpressionDiagnostic) -> bool {
    ["budget", "cancelled"].contains(&error.code.as_str())
}
fn value_expression(property: &str) -> String {
    let (namespace, name) = property.split_once('.').unwrap_or(("note", property));
    if namespace == "file" && name == "file" {
        "file".into()
    } else {
        format!(
            "{namespace}[{}]",
            serde_json::to_string(name).expect("string serializes")
        )
    }
}
fn canonical(value: &BaseValue) -> String {
    fn normalized(value: &BaseValue) -> BaseValue {
        match value {
            BaseValue::Object { value } => {
                let mut entries = value
                    .iter()
                    .map(|(key, value)| (key.clone(), normalized(value)))
                    .collect::<Vec<_>>();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                BaseValue::Object { value: entries }
            }
            BaseValue::List { value } => BaseValue::List {
                value: value.iter().map(normalized).collect(),
            },
            _ => value.clone(),
        }
    }
    serde_json::to_string(&normalized(value)).expect("finite typed value serializes")
}
fn display(value: &BaseValue, timezone: &str) -> String {
    match value {
        BaseValue::Null => "null".into(),
        BaseValue::Boolean { value } => value.to_string(),
        BaseValue::Number { value } => value.to_string(),
        BaseValue::String { value } => value.clone(),
        BaseValue::File { path } => path.clone(),
        BaseValue::List { value } => value
            .iter()
            .map(|value| display(value, timezone))
            .collect::<Vec<_>>()
            .join(", "),
        BaseValue::Object { value } => serde_json::to_string(
            &value
                .iter()
                .map(|(key, value)| (key.clone(), display(value, timezone)))
                .collect::<BTreeMap<_, _>>(),
        )
        .unwrap_or_default(),
        BaseValue::Date {
            timestamp,
            has_time,
        } => expression::display_date(*timestamp, *has_time, timezone).unwrap_or_default(),
        BaseValue::Error { message, .. } => format!("Error: {message}"),
        BaseValue::Duration { .. } => canonical(value),
    }
}
fn scalar_for_sort(
    value: &BaseValue,
    options: &QueryOptions,
) -> Result<BaseValue, ExpressionDiagnostic> {
    if matches!(value, BaseValue::Duration { .. }) {
        expression::duration_scalar(
            value,
            options.evaluation.clock_ms,
            &options.evaluation.timezone,
        )
        .map(|value| BaseValue::Number { value })
    } else {
        Ok(value.clone())
    }
}

/// Execute one bounded coherent snapshot. Any resource/cancellation failure is
/// an explicit Err; no silently truncated prefix is returned as a full query.
pub fn query_base(
    program: &BaseProgram,
    snapshot: &BaseSnapshot,
    options: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    let budget = |message: &str| ExpressionDiagnostic::new("budget", message);
    let view = program
        .views
        .get(options.view_index)
        .ok_or_else(|| ExpressionDiagnostic::new("configuration", "View index out of range"))?;
    if snapshot.records.len() > options.max_scanned {
        return Err(budget("Snapshot exceeds scanned-record budget"));
    }
    if options.search_terms.iter().map(String::len).sum::<usize>() > 65_536 {
        return Err(budget("Search terms exceed byte budget"));
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for record in &snapshot.records {
        if record.entry_id.is_empty()
            || !ids.insert(&record.entry_id)
            || !paths.insert(&record.path)
        {
            return Err(ExpressionDiagnostic::new(
                "input",
                "Snapshot entry IDs and paths must be nonempty and unique",
            ));
        }
    }
    let mut counts = QueryCounts {
        scanned: snapshot.records.len(),
        ..Default::default()
    };
    let mut available = FILE_PROPERTIES
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    for record in &snapshot.records {
        for (key, _) in &record.properties {
            let property = format!("note.{key}");
            if !available.contains(&property) {
                available.push(property);
            }
        }
    }
    for (name, _) in &program.formulas {
        available.push(format!("formula.{name}"));
    }
    let properties = view
        .order
        .iter()
        .filter(|property| property.starts_with("note.") || available.contains(property))
        .cloned()
        .collect::<Vec<_>>();
    let mut needed = available
        .iter()
        .chain(properties.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(group) = &view.group {
        needed.insert(group.property.clone());
    }
    for sort in &view.sort {
        needed.insert(sort.property.clone());
    }
    if let Some(image) = program::get(&view.configuration, "image").and_then(program::text) {
        needed.insert(program::property_id(image));
    }
    let mut diagnostics = Vec::new();
    let mut rows = Vec::new();
    let mut steps_used = 0usize;
    let mut retained_bytes = 0usize;
    let ignored = options.ignore_paths.iter().collect::<HashSet<_>>();
    for record in &snapshot.records {
        if ignored.contains(&record.path) {
            continue;
        }
        let mut invocation = options.evaluation.clone();
        invocation.formulas = program.formulas.clone();
        invocation.max_steps = invocation
            .max_steps
            .min(options.max_steps.saturating_sub(steps_used));
        let row = with_session("", record, &invocation, |session| {
            let filtered = (|| {
                for filter in [program.filter.as_ref(), view.filter.as_ref()]
                    .into_iter()
                    .flatten()
                {
                    if !filter_matches(filter, session)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            })();
            let included = match filtered {
                Ok(value) => value,
                Err(error) => {
                    if fatal(&error) {
                        return Err(error);
                    }
                    report(&mut diagnostics, record, "filter", None, error);
                    false
                }
            };
            if !included {
                steps_used = steps_used.saturating_add(session.steps_used());
                return Ok(None);
            }
            let mut values = BTreeMap::new();
            for property in &needed {
                let value = match session.evaluate(&value_expression(property)) {
                    Ok(value) => value,
                    Err(error) => {
                        if fatal(&error) {
                            return Err(error);
                        }
                        let value = BaseValue::Error {
                            code: error.code.clone(),
                            message: error.message.clone(),
                        };
                        report(&mut diagnostics, record, "value", Some(property), error);
                        value
                    }
                };
                values.insert(property.clone(), value);
            }
            steps_used = steps_used.saturating_add(session.steps_used());
            Ok(Some(BaseRow {
                entry_id: record.entry_id.clone(),
                revision: record.revision.clone(),
                path: record.path.clone(),
                values,
            }))
        })?;
        if let Some(row) = row {
            retained_bytes = retained_bytes.saturating_add(
                serde_json::to_vec(&row)
                    .map_err(|error| ExpressionDiagnostic::new("output", error.to_string()))?
                    .len(),
            );
            if retained_bytes > options.max_output_bytes {
                return Err(budget("Intermediate query rows exceed byte budget"));
            }
            rows.push(row);
        }
    }
    counts.matched = rows.len();
    let null = BaseValue::Null;
    let group_key = |row: &BaseRow| {
        view.group
            .as_ref()
            .and_then(|group| row.values.get(&group.property))
            .unwrap_or(&null)
            .clone()
    };
    let mut group_options = Vec::new();
    if let Some(keys) = &view.group_order {
        if keys.len() > options.max_groups {
            return Err(budget("Configured groups exceed group budget"));
        }
        let mut indexed = BTreeMap::<String, (BaseValue, usize)>::new();
        for row in &rows {
            let key = group_key(row);
            let entry = indexed.entry(canonical(&key)).or_insert((key, 0));
            entry.1 += 1;
            if indexed.len() > options.max_groups {
                return Err(budget("Query exceeds group-option budget"));
            }
        }
        let listed = keys.iter().map(canonical).collect::<HashSet<_>>();
        for key in keys {
            group_options.push(GroupOption {
                key: key.clone(),
                count: indexed
                    .get(&canonical(key))
                    .map(|(_, count)| *count)
                    .unwrap_or(0),
                listed: true,
            });
        }
        group_options.extend(
            indexed
                .into_iter()
                .filter(|(key, _)| !listed.contains(key))
                .map(|(_, (key, count))| GroupOption {
                    key,
                    count,
                    listed: false,
                }),
        );
        rows.retain(|row| listed.contains(&canonical(&group_key(row))));
    }
    counts.after_group_order = rows.len();
    let search_work = rows
        .len()
        .saturating_mul(properties.len())
        .saturating_mul(options.search_terms.len())
        .saturating_add(retained_bytes.saturating_mul(options.search_terms.len()) / 256);
    steps_used = steps_used.saturating_add(search_work);
    if steps_used > options.max_steps {
        return Err(budget("Search exceeds query work budget"));
    }
    let terms = options
        .search_terms
        .iter()
        .map(|term| term.to_lowercase())
        .collect::<Vec<_>>();
    rows.retain(|row| {
        terms.iter().all(|term| {
            properties
                .iter()
                .filter_map(|property| row.values.get(property))
                .filter(|value| !matches!(value, BaseValue::Null | BaseValue::Error { .. }))
                .any(|value| {
                    display(value, &options.evaluation.timezone)
                        .to_lowercase()
                        .contains(term)
                })
        })
    });
    counts.after_search = rows.len();
    let mut matched_available = FILE_PROPERTIES
        .iter()
        .map(|property| property.to_string())
        .collect::<Vec<_>>();
    let by_id = snapshot
        .records
        .iter()
        .map(|record| (&record.entry_id, record))
        .collect::<HashMap<_, _>>();
    for row in &rows {
        if let Some(record) = by_id.get(&row.entry_id) {
            for (key, _) in &record.properties {
                let property = format!("note.{key}");
                if !matched_available.contains(&property) {
                    matched_available.push(property);
                }
            }
        }
    }
    for (name, _) in &program.formulas {
        matched_available.push(format!("formula.{name}"));
    }
    let available = matched_available;
    let mut retained = available
        .iter()
        .chain(properties.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(group) = &view.group {
        retained.insert(group.property.clone());
    }
    if let Some(image) = program::get(&view.configuration, "image").and_then(program::text) {
        retained.insert(program::property_id(image));
    }
    for row in &mut rows {
        row.values.retain(|property, _| retained.contains(property));
    }
    let mut sort = view
        .sort
        .iter()
        .filter(|sort| available.contains(&sort.property))
        .cloned()
        .collect::<Vec<_>>();
    if sort.is_empty() {
        sort.push(Criterion {
            property: "file.name".into(),
            descending: false,
        });
    }
    let sort_work = rows
        .len()
        .saturating_mul((usize::BITS - rows.len().max(1).leading_zeros()) as usize)
        .saturating_mul(sort.len());
    steps_used = steps_used.saturating_add(sort_work);
    if steps_used > options.max_steps {
        return Err(budget("Sorting exceeds query work budget"));
    }
    let mut scalars = HashMap::new();
    for row in &rows {
        for criterion in &sort {
            let value = row.values.get(&criterion.property).unwrap_or(&null);
            let value = scalar_for_sort(value, options)?;
            scalars.insert((row.entry_id.clone(), criterion.property.clone()), value);
        }
    }
    rows.sort_by(|a, b| {
        for criterion in &sort {
            let a = scalars
                .get(&(a.entry_id.clone(), criterion.property.clone()))
                .unwrap_or(&null);
            let b = scalars
                .get(&(b.entry_id.clone(), criterion.property.clone()))
                .unwrap_or(&null);
            let order = order::compare(a, b, criterion.descending);
            if !order.is_eq() {
                return order;
            }
        }
        a.path.cmp(&b.path)
    });
    if let Some(limit) = view.limit {
        rows.truncate(limit);
    }
    if rows.len() > options.max_rows {
        return Err(budget("Query exceeds returned-row budget"));
    }
    counts.returned = rows.len();
    let mut groups = Vec::<BaseGroup>::new();
    if let Some(group) = &view.group {
        let mut by_key = HashMap::new();
        for row in &rows {
            let key = group_key(row);
            let key_id = canonical(&key);
            let index = if let Some(index) = by_key.get(&key_id) {
                *index
            } else {
                if groups.len() >= options.max_groups {
                    return Err(budget("Query exceeds group budget"));
                }
                let index = groups.len();
                groups.push(BaseGroup {
                    key: Some(key),
                    entry_ids: Vec::new(),
                });
                by_key.insert(key_id, index);
                index
            };
            groups[index].entry_ids.push(row.entry_id.clone());
        }
        if let Some(keys) = &view.group_order {
            let positions = keys
                .iter()
                .enumerate()
                .map(|(index, key)| (canonical(key), index))
                .collect::<HashMap<_, _>>();
            groups.sort_by_key(|group| {
                positions
                    .get(&canonical(group.key.as_ref().unwrap()))
                    .copied()
                    .unwrap_or(usize::MAX)
            });
        } else {
            groups.sort_by(|a, b| {
                order::compare(
                    a.key.as_ref().unwrap(),
                    b.key.as_ref().unwrap(),
                    group.descending,
                )
            });
        }
    } else {
        groups.push(BaseGroup {
            key: None,
            entry_ids: rows.iter().map(|row| row.entry_id.clone()).collect(),
        });
    }
    let result = BaseQueryResult {
        snapshot_id: snapshot.snapshot_id.clone(),
        view: view.configuration.clone(),
        rows,
        groups,
        group_options,
        properties,
        available_properties: available,
        counts,
        diagnostics,
        steps_used,
    };
    if serde_json::to_vec(&result)
        .map_err(|error| ExpressionDiagnostic::new("output", error.to_string()))?
        .len()
        > options.max_output_bytes
    {
        return Err(budget("Encoded result exceeds byte budget"));
    }
    Ok(result)
}
