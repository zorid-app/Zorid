//! Snapshot query policy around the reused MDBASE expression evaluator. No IO,
//! live vault state or storage ownership enters this reducer. Private callbacks
//! perform bounded core admission only; they supply no source authority.
use crate::{
    expression, order,
    program::{self, BaseProgram, Criterion, Filter},
    with_session_prepared_files, BaseValue, DetachedRecord, EvaluationOptions,
    ExpressionDiagnostic, PropertyValue,
};
use serde::{Deserialize, Serialize};
#[path = "grouping.rs"]
mod grouping;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub const MAX_QUERY_STEPS: usize = 2_000_000;
pub const MAX_QUERY_SCANNED: usize = 50_000;
pub const MAX_QUERY_ROWS: usize = 10_000;
pub const MAX_QUERY_GROUPS: usize = 5_000;
pub const MAX_QUERY_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// Conservative time dependency of the selected Base invocation. This controls
/// visible-view wakeups only; it is not an answer-cache independence proof.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BaseClockDependency {
    #[default]
    None,
    Day,
    Instant,
}
impl BaseClockDependency {
    pub(crate) fn join(self, other: Self) -> Self {
        self.max(other)
    }
}
/// A host executes at most one wakeup for this captured query hint. A missing
/// deadline means no representable future wakeup; the dependency remains explicit.
/// No ambient clock or device timezone is read by the core.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRefreshHint {
    pub dependency: BaseClockDependency,
    pub timezone: String,
    pub next_wake_ms: Option<i64>,
}
/// Records and graph are sealed together; deserialization supplies detached rows only.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseSnapshot {
    pub(crate) snapshot_id: crate::IndexSnapshotId,
    pub(crate) records: Vec<DetachedRecord>,
    pub(crate) relationships: Option<zorid_index::ResolutionSnapshot>,
    pub(crate) metadata_issues: Vec<crate::MetadataIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) property_values: Option<crate::relations::PropertyRelationValues>,
}
impl BaseSnapshot {
    pub fn detached(snapshot_id: crate::IndexSnapshotId, records: Vec<DetachedRecord>) -> Self {
        Self {
            snapshot_id,
            records,
            relationships: None,
            metadata_issues: Vec::new(),
            property_values: None,
        }
    }
    pub fn snapshot_id(&self) -> &crate::IndexSnapshotId {
        &self.snapshot_id
    }
    pub fn records(&self) -> &[DetachedRecord] {
        &self.records
    }
}
impl<'de> Deserialize<'de> for BaseSnapshot {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Detached {
            snapshot_id: crate::IndexSnapshotId,
            records: Vec<DetachedRecord>,
            #[serde(default)]
            relationships: Option<serde_json::Value>,
        }
        let value = Detached::deserialize(deserializer)?;
        if value.relationships.is_some() {
            return Err(serde::de::Error::custom(
                "Relationships require a Rust-owned Generation factory",
            ));
        }
        Ok(Self::detached(value.snapshot_id, value.records))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryOptions {
    pub view_index: usize,
    pub search_terms: Vec<String>,
    pub ignore_paths: Vec<String>,
    pub evaluation: EvaluationOptions,
    /// Select `this` only from the exact query snapshot, never from caller fields.
    #[serde(
        default,
        deserialize_with = "current_entry_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_entry_id: Option<crate::EntryId>,
    /// Trusted host selector for the verified saved Base/inline containing file.
    /// It is deliberately absent from transport; callers cannot override origin.
    #[serde(skip)]
    pub definition_entry_id: Option<crate::EntryId>,
    /// Ephemeral footer-picker previews for one property, never saved settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_preview_property: Option<String>,
    /// Exact opaque group identity for a footer picker; None selects overall.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_preview_group_key_id: Option<String>,
    pub max_steps: usize,
    pub max_scanned: usize,
    pub max_rows: usize,
    pub max_groups: usize,
    pub max_output_bytes: usize,
}
fn current_entry_option<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<crate::EntryId>, D::Error> {
    crate::EntryId::deserialize(deserializer).map(Some)
}
impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            view_index: 0,
            search_terms: Vec::new(),
            ignore_paths: Vec::new(),
            evaluation: EvaluationOptions::default(),
            current_entry_id: None,
            definition_entry_id: None,
            summary_preview_property: None,
            summary_preview_group_key_id: None,
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
    pub entry_id: crate::EntryId,
    pub path: String,
    pub property: Option<String>,
    pub code: String,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRow {
    pub entry_id: crate::EntryId,
    pub revision: crate::Revision,
    pub path: String,
    pub values: BTreeMap<String, BaseValue>,
    /// Exact logical persisted note values where rendering inferred another
    /// value type. Absent entries may fall back only to raw-safe primitives,
    /// lists and objects; generated file/formula/derived values are not source.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub edit_values: BTreeMap<String, BaseValue>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseGroup {
    /// Opaque presentation identity; None is only the ungrouped sentinel.
    pub key_id: Option<String>,
    pub key: Option<BaseValue>,
    /// Writable persisted note value for this exact opaque key identity.
    /// Absence is readonly; lists are whole-key assignments, never split items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_key: Option<BaseValue>,
    /// Persistable manual-order key, independent of note write permission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_key: Option<BaseValue>,
    pub entry_ids: Vec<crate::EntryId>,
    /// Aggregates of exactly this group's returned rows, including offscreen rows.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub summaries: BTreeMap<String, BaseValue>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupOption {
    pub key_id: String,
    pub key: BaseValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_key: Option<BaseValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_key: Option<BaseValue>,
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
    pub snapshot_id: crate::IndexSnapshotId,
    pub view: PropertyValue,
    pub rows: Vec<BaseRow>,
    pub groups: Vec<BaseGroup>,
    /// Aggregates after filters, group visibility, search, ordering and limit.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub summaries: BTreeMap<String, BaseValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_previews: Option<BTreeMap<String, BaseValue>>,
    pub group_options: Vec<GroupOption>,
    pub properties: Vec<String>,
    pub available_properties: Vec<String>,
    pub counts: QueryCounts,
    pub diagnostics: Vec<QueryDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation_targets: Option<BTreeMap<String, Vec<crate::relations::RelationTarget>>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub property_definition_diagnostics: Vec<crate::properties::PropertyDefinitionDiagnostic>,
    pub steps_used: usize,
    pub relationships_available: bool,
    pub metadata_issues: Vec<crate::MetadataIssue>,
    pub metadata_complete: bool,
    /// Null preserves lazy captures which were not admitted by any evaluated
    /// row. Valid clock-independent queries carry an explicit no-deadline hint.
    #[serde(default)]
    pub refresh_hint: Option<BaseRefreshHint>,
}

/// Private borrowed reducer input. A preview has no fabricated snapshot identity.
pub(crate) struct QueryRows<'a> {
    pub(crate) records: &'a [DetachedRecord],
    pub(crate) relationships: Option<&'a zorid_index::ResolutionSnapshot>,
    pub(crate) metadata_issues: &'a [crate::MetadataIssue],
    pub(crate) unavailable: Option<&'a HashSet<crate::EntryId>>,
    pub(crate) property_values: Option<&'a crate::relations::PropertyRelationValues>,
}
impl<'a> QueryRows<'a> {
    fn published(snapshot: &'a BaseSnapshot) -> Self {
        Self {
            records: &snapshot.records,
            relationships: snapshot.relationships.as_ref(),
            metadata_issues: &snapshot.metadata_issues,
            unavailable: None,
            property_values: snapshot.property_values.as_ref(),
        }
    }
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryRowsResult {
    pub(crate) view: PropertyValue,
    pub(crate) rows: Vec<BaseRow>,
    pub(crate) groups: Vec<BaseGroup>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) summaries: BTreeMap<String, BaseValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) summary_previews: Option<BTreeMap<String, BaseValue>>,
    pub(crate) group_options: Vec<GroupOption>,
    pub(crate) properties: Vec<String>,
    pub(crate) available_properties: Vec<String>,
    pub(crate) counts: QueryCounts,
    pub(crate) diagnostics: Vec<QueryDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) relation_targets: Option<BTreeMap<String, Vec<crate::relations::RelationTarget>>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) property_definition_diagnostics:
        Vec<crate::properties::PropertyDefinitionDiagnostic>,
    pub(crate) steps_used: usize,
    pub(crate) relationships_available: bool,
    pub(crate) metadata_issues: Vec<crate::MetadataIssue>,
    pub(crate) metadata_complete: bool,
    pub(crate) refresh_hint: Option<BaseRefreshHint>,
}

type Admission<'a> = Option<&'a mut crate::preview::PreviewAdmission>;
fn admit(
    admission: &mut Admission<'_>,
    bytes: impl FnOnce(&mut crate::preview::PreviewAdmission) -> Result<usize, ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    if let Some(admission) = admission.as_deref_mut() {
        let bytes = bytes(admission)?;
        admission.charge(bytes)?;
    }
    Ok(())
}
fn slots<T>(count: usize) -> usize {
    if count == 0 {
        return 0;
    }
    count
        .max(4)
        .saturating_mul(std::mem::size_of::<T>())
        .saturating_mul(2)
}
fn map_slot<K, V>() -> usize {
    std::mem::size_of::<(K, V)>()
        .saturating_mul(16)
        .saturating_add(64)
}
fn string_copies<'a>(
    values: impl IntoIterator<Item = &'a str>,
    admission: &mut crate::preview::PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    let mut bytes = 0usize;
    for value in values {
        admission.charge(0)?;
        bytes = bytes.saturating_add(crate::preview::string_bytes(value));
        admission.estimate_fits(bytes)?;
    }
    Ok(bytes)
}
fn admission_work(admission: &Admission<'_>) -> usize {
    admission
        .as_deref()
        .map_or(0, crate::preview::PreviewAdmission::work_used)
}
fn check_query_work(
    steps: usize,
    admission: &Admission<'_>,
    options: &QueryOptions,
    message: &str,
) -> Result<(), ExpressionDiagnostic> {
    if steps.saturating_add(admission_work(admission)) > options.max_steps {
        return Err(ExpressionDiagnostic::new("budget", message));
    }
    Ok(())
}
fn canonical_admission(
    value: &BaseValue,
    admission: &mut Admission<'_>,
) -> Result<(), ExpressionDiagnostic> {
    admit(admission, |admission| {
        admission.charge(0)?;
        // Normalization clones the typed value before writing JSON. Its encoded
        // form cannot grow when negative zero and object order are normalized.
        let value_bytes = crate::preview::value_bytes(value, admission)?;
        let encoded = crate::encoded_size(value, crate::MAX_BASE_REQUEST_BYTES)?;
        Ok(value_bytes
            .saturating_add(crate::preview::string_bytes(""))
            .saturating_add(encoded.saturating_mul(2))
            .saturating_add(128))
    })
}
// A shape-only upper bound for the existing display implementation and its
// intermediate string/list/map copies. JSON string escaping grows at most sixfold.
fn display_copy_bytes(
    value: &BaseValue,
    depth: usize,
    admission: &mut crate::preview::PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    admission.charge(0)?;
    if depth > 128 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Preview display nesting exceeds limit",
        ));
    }
    let bytes = match value {
        BaseValue::String { value } | BaseValue::Html { value } | BaseValue::Icon { value } => {
            crate::preview::string_bytes(value)
        }
        BaseValue::Image { value } => crate::preview::string_bytes(value).saturating_add(16),
        BaseValue::File { path } => crate::preview::string_bytes(path),
        BaseValue::Link {
            path,
            display,
            display_value,
            ..
        } => {
            if let Some(value) = display_value {
                display_copy_bytes(value, depth + 1, admission)?.saturating_add(64)
            } else {
                crate::preview::string_bytes(display.as_deref().unwrap_or(path))
            }
        }
        BaseValue::Error { message, .. } => {
            crate::preview::string_bytes(message).saturating_add(16)
        }
        BaseValue::List { value } => {
            let mut bytes = slots::<String>(value.len()).saturating_add(128);
            admission.estimate_fits(bytes)?;
            for child in value {
                bytes = bytes.saturating_add(
                    display_copy_bytes(child, depth + 1, admission)?.saturating_mul(2),
                );
                admission.estimate_fits(bytes)?;
            }
            bytes.saturating_add(value.len().saturating_mul(2))
        }
        BaseValue::Object { value } => {
            let mut bytes =
                128usize.saturating_add(value.len().saturating_mul(map_slot::<String, String>()));
            admission.estimate_fits(bytes)?;
            for (key, child) in value {
                bytes = bytes.saturating_add(crate::preview::string_bytes(key).saturating_mul(8));
                admission.estimate_fits(bytes)?;
                bytes = bytes.saturating_add(
                    display_copy_bytes(child, depth + 1, admission)?.saturating_mul(8),
                );
                admission.estimate_fits(bytes)?;
            }
            bytes
        }
        BaseValue::Duration { .. } => {
            crate::preview::value_bytes(value, admission)?.saturating_add(8_192)
        }
        // Finite number display (including tiny/large decimal spellings), bool,
        // null and bounded date formatting fit this conservative scalar reserve.
        _ => 1_024,
    };
    admission.estimate_fits(bytes)?;
    Ok(bytes)
}

// Shape-only bound for one side of order::compare. The comparator's temporary
// buffers are reclaimed between comparisons, so callers reserve the maximum
// simultaneous pair once per sort, rather than charging every comparison.
fn comparator_side_scratch(
    value: &BaseValue,
    depth: usize,
    admission: &mut crate::preview::PreviewAdmission,
) -> Result<usize, ExpressionDiagnostic> {
    admission.charge(0)?;
    if depth > 128 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Preview comparator nesting exceeds limit",
        ));
    }
    let bytes = match value {
        BaseValue::String { value } | BaseValue::Html { value } | BaseValue::Icon { value } => {
            lowercase_scratch(value)
        }
        BaseValue::Image { value } => lowercase_scratch(value)
            .saturating_add(crate::preview::string_bytes(value))
            .saturating_add(1024),
        BaseValue::File { path } => lowercase_scratch(path),
        BaseValue::Link {
            path,
            display,
            display_value,
            ..
        } => {
            if let Some(value) = display_value {
                // Rich labels stringify before collation. The display reserve
                // covers both retained text and its lowercase scalar buffers.
                display_copy_bytes(value, depth + 1, admission)?
                    .saturating_mul(32)
                    .saturating_add(1024)
            } else {
                lowercase_scratch(display.as_deref().unwrap_or(path))
            }
        }
        BaseValue::List { value } => {
            let mut maximum = 0;
            for child in value {
                maximum = maximum.max(comparator_side_scratch(child, depth + 1, admission)?);
                admission.estimate_fits(maximum)?;
            }
            maximum
        }
        BaseValue::Object { value } => {
            let references = slots::<&(String, BaseValue)>(value.len())
                .saturating_add(std::mem::size_of::<Vec<&(String, BaseValue)>>());
            let sort_scratch = slots::<&(String, BaseValue)>(value.len());
            admission.estimate_fits(references.saturating_add(sort_scratch))?;
            let mut nested = 0;
            for (_, child) in value {
                nested = nested.max(comparator_side_scratch(child, depth + 1, admission)?);
                admission.estimate_fits(references.saturating_add(sort_scratch.max(nested)))?;
            }
            // Parent reference vectors survive while a nested pair is compared.
            // Their key-only sorts need no lowercase buffers and finish first.
            references.saturating_add(sort_scratch.max(nested))
        }
        _ => 0,
    };
    admission.estimate_fits(bytes)?;
    Ok(bytes)
}
fn lowercase_scratch(value: &str) -> usize {
    // Up to three lowercase scalars per input scalar, each four bytes:12xUTF8
    // payload. slots adds explicit2xgrowth plus minimum Vec capacity; retain its
    // header too. This deliberately exceeds the Unicode-specific common case.
    slots::<char>(value.len().saturating_mul(3)).saturating_add(std::mem::size_of::<Vec<char>>())
}
fn comparator_scratch_admission<'a>(
    values: impl IntoIterator<Item = &'a BaseValue>,
    admission: &mut Admission<'_>,
) -> Result<(), ExpressionDiagnostic> {
    if let Some(admission) = admission.as_deref_mut() {
        let mut maximum = 0;
        for value in values {
            maximum = maximum.max(comparator_side_scratch(value, 0, admission)?);
            admission.estimate_fits(maximum.saturating_mul(2))?;
        }
        admission.charge(maximum.saturating_mul(2))?;
    }
    Ok(())
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
        BaseValue::String { value }
        | BaseValue::Html { value }
        | BaseValue::Image { value }
        | BaseValue::Icon { value } => !value.is_empty(),
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
    admission: &mut Admission<'_>,
) -> Result<(), ExpressionDiagnostic> {
    admit(admission, |admission| {
        admission.charge(0)?;
        Ok(slots::<QueryDiagnostic>(1).saturating_add(string_copies(
            [
                phase,
                record
                    .witness
                    .as_ref()
                    .expect("validated witness")
                    .entry_id
                    .as_str(),
                &record.path,
                property.unwrap_or(""),
                &error.code,
                &error.message,
            ],
            admission,
        )?))
    })?;
    let diagnostic = QueryDiagnostic {
        phase: phase.into(),
        entry_id: record
            .witness
            .as_ref()
            .expect("query witness validated")
            .entry_id
            .clone(),
        path: record.path.clone(),
        property: property.map(String::from),
        code: error.code,
        message: error.message,
    };
    // Each unique entry/property is evaluated once per phase; no quadratic
    // whole-vector de-duplication is needed.
    diagnostics.push(diagnostic);
    Ok(())
}
fn fatal(error: &ExpressionDiagnostic) -> bool {
    ["budget", "cancelled"].contains(&error.code.as_str())
}
// Syntax construction consumes the selected program even when the captured
// row set is empty. Semantic parse errors keep their existing cell/filter
// presentation; resource and cancellation failures reject the invocation.
fn admit_selected_syntax(
    program: &BaseProgram,
    view: &program::View,
    options: &QueryOptions,
    steps: &mut usize,
    admission: &mut Admission<'_>,
) -> Result<(), ExpressionDiagnostic> {
    fn work(
        cost: usize,
        options: &QueryOptions,
        steps: &mut usize,
        admission: &Admission<'_>,
    ) -> Result<(), ExpressionDiagnostic> {
        if options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        *steps = steps.saturating_add(cost);
        check_query_work(
            *steps,
            admission,
            options,
            "Selected syntax admission exceeds query work budget",
        )
    }
    fn source(
        source: &str,
        options: &QueryOptions,
        steps: &mut usize,
        admission: &Admission<'_>,
    ) -> Result<(), ExpressionDiagnostic> {
        match expression::validate_checked(source, &mut |cost| {
            work(cost, options, steps, admission).map_err(|error| {
                expression::RuntimeValue::Error(format!("{}\0{}", error.code, error.message))
            })
        }) {
            Ok(()) => Ok(()),
            Err(value) => {
                let error = expression::runtime_diagnostic(value);
                if fatal(&error) {
                    Err(error)
                } else {
                    Ok(())
                }
            }
        }
    }
    fn filter(
        value: &Filter,
        options: &QueryOptions,
        steps: &mut usize,
        admission: &Admission<'_>,
    ) -> Result<(), ExpressionDiagnostic> {
        work(1, options, steps, admission)?;
        match value {
            Filter::Expression(value) => source(value, options, steps, admission),
            Filter::And(children) | Filter::Or(children) | Filter::Not(children) => {
                for child in children {
                    filter(child, options, steps, admission)?;
                }
                Ok(())
            }
        }
    }
    for selected in [program.filter.as_ref(), view.filter.as_ref()]
        .into_iter()
        .flatten()
    {
        filter(selected, options, steps, admission)?;
    }
    for (name, expression) in &program.summaries {
        work(1, options, steps, admission)?;
        let mut selected = options.summary_preview_property.is_some();
        if !selected {
            for (_, summary) in &view.summaries {
                work(
                    name.len().max(summary.len()) / 16 + 1,
                    options,
                    steps,
                    admission,
                )?;
                if summary == name {
                    selected = true;
                    break;
                }
            }
        }
        if selected {
            source(expression, options, steps, admission)?;
        }
    }
    Ok(())
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

/// Runtime property access is exact-first, then Unicode case-folded in
/// insertion order. Preserve that same source selection for edit provenance
/// and readonly derived-property decisions, including exact-case siblings.
fn resolved_note_property<'a>(
    record: &'a DetachedRecord,
    properties: Option<&'a crate::relations::PropertyRelationValues>,
    requested: &str,
) -> Option<&'a str> {
    let overlay = record
        .witness
        .as_ref()
        .and_then(|witness| {
            properties
                .and_then(|properties| properties.rows().get(&witness.entry_id))
                .filter(|row| &row.witness == witness)
        })
        .map(|row| &row.values);
    record
        .properties
        .iter()
        .find(|(key, _)| key == requested)
        .map(|(key, _)| key.as_str())
        .or_else(|| {
            overlay
                .and_then(|values| values.get_key_value(requested))
                .map(|(key, _)| key.as_str())
        })
        .or_else(|| {
            let folded = requested.to_lowercase();
            record
                .properties
                .iter()
                .find(|(key, _)| key.to_lowercase() == folded)
                .map(|(key, _)| key.as_str())
                .or_else(|| {
                    overlay
                        .and_then(|values| values.keys().find(|key| key.to_lowercase() == folded))
                        .map(String::as_str)
                })
        })
}
fn readonly_note_property(
    record: &DetachedRecord,
    properties: Option<&crate::relations::PropertyRelationValues>,
    requested: &str,
) -> bool {
    let resolved = resolved_note_property(record, properties, requested).unwrap_or(requested);
    properties.is_some_and(|properties| properties.is_read_only_property(resolved))
}
fn readonly_empty_group_property(
    properties: Option<&crate::relations::PropertyRelationValues>,
    requested: &str,
) -> bool {
    properties.is_some_and(|properties| {
        let resolved = properties
            .property_names()
            .find(|name| *name == requested)
            .or_else(|| {
                let folded = requested.to_lowercase();
                properties
                    .property_names()
                    .find(|name| name.to_lowercase() == folded)
            });
        resolved.is_some_and(|name| properties.is_read_only_property(name))
    })
}

fn raw_matches_rendered(
    raw: &PropertyValue,
    rendered: &BaseValue,
    check: &mut impl FnMut() -> Result<(), ExpressionDiagnostic>,
) -> Result<bool, ExpressionDiagnostic> {
    check()?;
    Ok(match (raw, rendered) {
        (PropertyValue::Null, BaseValue::Null) => true,
        (PropertyValue::Bool(raw), BaseValue::Boolean { value }) => raw == value,
        (PropertyValue::Number(raw), BaseValue::Number { value }) => raw.as_f64() == Some(*value),
        (PropertyValue::String(raw), BaseValue::String { value }) => raw == value,
        (PropertyValue::Array(raw), BaseValue::List { value }) if raw.len() == value.len() => {
            let mut equal = true;
            for (raw, rendered) in raw.iter().zip(value) {
                if !raw_matches_rendered(raw, rendered, check)? {
                    equal = false;
                    break;
                }
            }
            equal
        }
        (PropertyValue::Object(raw), BaseValue::Object { value }) if raw.len() == value.len() => {
            let mut equal = true;
            for ((raw_key, raw), (key, rendered)) in raw.iter().zip(value) {
                if raw_key != key || !raw_matches_rendered(raw, rendered, check)? {
                    equal = false;
                    break;
                }
            }
            equal
        }
        _ => false,
    })
}

/// Transfer serialization is deliberately destination-independent. Ordinary
/// cell editValues keep original bytes; grouping moves may root a link path to
/// preserve its captured target identity in a different destination folder.
fn transfer_group_edit_key(
    rendered: &BaseValue,
    source: &BaseValue,
    records: &HashMap<&crate::EntryId, &DetachedRecord>,
    graph: Option<&crate::graph::PreparedRelationships<'_>>,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<BaseValue>, ExpressionDiagnostic> {
    check(1)?;
    match rendered {
        BaseValue::Link {
            path,
            target,
            display,
            external,
            subpath,
            ..
        } => {
            if *external {
                return Ok(configured_group_edit_key(source));
            }
            let raw_link = match source {
                BaseValue::String { value } => expression::wikilink(value),
                _ => None,
            };
            let original_path = raw_link
                .as_ref()
                .map_or(path.as_str(), |link| link.path.as_str());
            let Some(witness) = target else {
                if original_path.starts_with('/') {
                    return Ok(configured_group_edit_key(source));
                }
                return Err(ExpressionDiagnostic::new("unavailable", "Unresolved relative link groups cannot be transferred safely to another folder"));
            };
            let record = records
                .get(&witness.entry_id)
                .filter(|record| record.witness.as_ref() == Some(witness))
                .ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "unavailable",
                        "Group link target has no exact captured revision",
                    )
                })?;
            check(record.path.len())?;
            let mut rooted = encode_rooted_group_path(&record.path);
            // Captured paths can contain literal '#'. Only parsed destination
            // metadata denotes a heading/block; never split the file path.
            let fragment = raw_link
                .as_ref()
                .map(|link| link.subpath.as_deref())
                .unwrap_or(subpath.as_deref());
            if let Some(fragment) = fragment {
                if !fragment.starts_with('#') {
                    return Err(ExpressionDiagnostic::new(
                        "unavailable",
                        "Group link has invalid subpath metadata",
                    ));
                }
                check(fragment.len())?;
                rooted.push_str(fragment);
            }
            let alias = raw_link
                .as_ref()
                .and_then(|link| link.display.as_ref())
                .or(display.as_ref());
            if rooted.len() > 4096
                || rooted.contains("]]")
                || rooted.contains("[[")
                || rooted.contains('|')
                || alias.is_some_and(|alias| alias.contains("]]") || alias.contains("[["))
            {
                return Err(ExpressionDiagnostic::new(
                    "unavailable",
                    "Group link cannot be represented safely as a readable rooted wiki link",
                ));
            }
            let resolved = graph
                .ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "unavailable",
                        "Group link transfer requires the captured namespace",
                    )
                })?
                .resolve_target(&expression::BasesFile::default(), &rooted, check)?;
            if !resolved
                .as_ref()
                .is_some_and(|(_, target)| target == witness)
            {
                return Err(ExpressionDiagnostic::new(
                    "unavailable",
                    "Rooted group link does not preserve the captured target identity",
                ));
            }
            let value = if let Some(alias) = alias {
                format!("[[{rooted}|{alias}]]")
            } else {
                format!("[[{rooted}]]")
            };
            Ok(Some(BaseValue::String { value }))
        }
        BaseValue::List { value } => {
            let raw = match source {
                BaseValue::List { value: raw } if raw.len() == value.len() => Some(raw.as_slice()),
                _ => None,
            };
            let mut result = Vec::with_capacity(value.len());
            for (index, value) in value.iter().enumerate() {
                let source = raw.map_or(source, |raw| &raw[index]);
                let Some(value) = transfer_group_edit_key(value, source, records, graph, check)?
                else {
                    return Ok(None);
                };
                result.push(value);
            }
            Ok(Some(BaseValue::List { value: result }))
        }
        BaseValue::Object { value } => {
            let BaseValue::Object { value: raw } = source else {
                return Ok(None);
            };
            if raw.len() != value.len() {
                return Ok(None);
            }
            let mut result = Vec::with_capacity(value.len());
            for ((key, value), (raw_key, source)) in value.iter().zip(raw) {
                if key != raw_key {
                    return Ok(None);
                }
                let Some(value) = transfer_group_edit_key(value, source, records, graph, check)?
                else {
                    return Ok(None);
                };
                result.push((key.clone(), value));
            }
            Ok(Some(BaseValue::Object { value: result }))
        }
        BaseValue::Error { .. }
        | BaseValue::File { .. }
        | BaseValue::Html { .. }
        | BaseValue::Image { .. }
        | BaseValue::Icon { .. }
        | BaseValue::Duration { .. } => Ok(None),
        _ => Ok(configured_group_edit_key(source)),
    }
}
fn hydrate_group_order_key(
    source: &BaseValue,
    property: &str,
    origin: Option<&DetachedRecord>,
    graph: Option<&crate::graph::PreparedRelationships<'_>>,
    timezone: &expression::BasesTimezone,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    admit: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<BaseValue, ExpressionDiagnostic> {
    let raw = expression::runtime_from_base_value(source, timezone)?;
    let value = expression::infer_frontmatter_value(raw, timezone);
    fn inspect(
        value: &expression::RuntimeValue,
        has_origin: bool,
        has_graph: bool,
        check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<(), ExpressionDiagnostic> {
        check(1)?;
        match value {
            expression::RuntimeValue::Link(link) if !link.external => {
                if !has_graph {
                    return Err(ExpressionDiagnostic::new(
                        "unavailable",
                        "Manual link group order requires the captured namespace",
                    ));
                }
                if !has_origin && !link.path.starts_with('/') {
                    return Err(ExpressionDiagnostic::new("unavailable", "Relative manual group-order links require a verified Base definition origin"));
                }
            }
            expression::RuntimeValue::List(values) => {
                for value in values {
                    inspect(value, has_origin, has_graph, check)?;
                }
            }
            expression::RuntimeValue::Object(values) => {
                for value in values.values() {
                    inspect(value, has_origin, has_graph, check)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    inspect(&value, origin.is_some(), graph.is_some(), check)?;
    let mut file = expression::BasesFile {
        path: origin.map_or_else(String::new, |record| record.path.clone()),
        witness: origin.and_then(|record| record.witness.clone()),
        ..Default::default()
    };
    file.properties.insert(property.to_string(), value);
    if let Some(graph) = graph {
        graph.resolve_property_links(&mut file, check, admit)?;
    }
    expression::typed_result(
        file.properties
            .shift_remove(property)
            .expect("inserted group order value"),
    )
}

fn serialize_group_order_key(
    value: &BaseValue,
    source: &BaseValue,
    records: &HashMap<&crate::EntryId, &DetachedRecord>,
    graph: Option<&crate::graph::PreparedRelationships<'_>>,
    timezone: &expression::BasesTimezone,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<BaseValue>, ExpressionDiagnostic> {
    check(1)?;
    match value {
        BaseValue::Date {
            timestamp,
            has_time,
        } => {
            let instant = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(*timestamp)
                .ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "unavailable",
                        "Group date is outside the serializable range",
                    )
                })?;
            let pattern = if *has_time {
                "%Y-%m-%dT%H:%M:%S%.3f%:z"
            } else {
                "%Y-%m-%d"
            };
            let value = match timezone {
                expression::BasesTimezone::Utc => instant.format(pattern).to_string(),
                expression::BasesTimezone::Fixed(offset) => {
                    instant.with_timezone(offset).format(pattern).to_string()
                }
                expression::BasesTimezone::Named(zone) => {
                    instant.with_timezone(zone).format(pattern).to_string()
                }
            };
            Ok(Some(BaseValue::String { value }))
        }
        BaseValue::File { path } => {
            let encoded = encode_rooted_group_path(path);
            let (_, witness) = graph
                .ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "unavailable",
                        "File group order requires the captured namespace",
                    )
                })?
                .resolve_target(&expression::BasesFile::default(), &encoded, check)?
                .filter(|(resolved, _)| resolved == path)
                .ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "unavailable",
                        "File group order cannot identify the exact captured path",
                    )
                })?;
            transfer_group_edit_key(
                &BaseValue::Link {
                    path: path.clone(),
                    target: Some(witness),
                    display: None,
                    display_value: None,
                    subpath: None,
                    external: false,
                },
                source,
                records,
                graph,
                check,
            )
        }
        BaseValue::List { value } => {
            let raw = match source {
                BaseValue::List { value: raw } if raw.len() == value.len() => Some(raw),
                _ => None,
            };
            let mut result = Vec::with_capacity(value.len());
            for (index, value) in value.iter().enumerate() {
                let Some(value) = serialize_group_order_key(
                    value,
                    raw.map_or(source, |raw| &raw[index]),
                    records,
                    graph,
                    timezone,
                    check,
                )?
                else {
                    return Ok(None);
                };
                result.push(value);
            }
            Ok(Some(BaseValue::List { value: result }))
        }
        BaseValue::Object { value } => {
            let BaseValue::Object { value: raw } = source else {
                return Ok(None);
            };
            if raw.len() != value.len() {
                return Ok(None);
            }
            let mut result = Vec::with_capacity(value.len());
            for ((key, value), (raw_key, source)) in value.iter().zip(raw) {
                if key != raw_key {
                    return Ok(None);
                }
                let Some(value) =
                    serialize_group_order_key(value, source, records, graph, timezone, check)?
                else {
                    return Ok(None);
                };
                result.push((key.clone(), value));
            }
            Ok(Some(BaseValue::Object { value: result }))
        }
        _ => transfer_group_edit_key(value, source, records, graph, check),
    }
}

fn encode_rooted_group_path(path: &str) -> String {
    let mut result = String::from("/");
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'.' | b'_' | b'~') {
            result.push(byte as char);
        } else {
            result.push('%');
            result.push(HEX[(byte >> 4) as usize] as char);
            result.push(HEX[(byte & 15) as usize] as char);
        }
    }
    result
}

fn configured_group_edit_key(value: &BaseValue) -> Option<BaseValue> {
    match value {
        BaseValue::Null
        | BaseValue::Boolean { .. }
        | BaseValue::Number { .. }
        | BaseValue::String { .. } => Some(value.clone()),
        BaseValue::List { value } => Some(BaseValue::List {
            value: value
                .iter()
                .map(configured_group_edit_key)
                .collect::<Option<Vec<_>>>()?,
        }),
        BaseValue::Object { value } => Some(BaseValue::Object {
            value: value
                .iter()
                .map(|(key, value)| Some((key.clone(), configured_group_edit_key(value)?)))
                .collect::<Option<Vec<_>>>()?,
        }),
        _ => None,
    }
}

fn needs_shared_files(program: &BaseProgram, view: &program::View, preview: bool) -> bool {
    fn filter(value: &Filter) -> bool {
        match value {
            Filter::Expression(source) => expression::uses_relationships(source),
            Filter::And(children) | Filter::Or(children) | Filter::Not(children) => {
                children.iter().any(filter)
            }
        }
    }
    program.filter.as_ref().is_some_and(filter)
        || view.filter.as_ref().is_some_and(filter)
        || program
            .formulas
            .iter()
            .any(|(_, source)| expression::uses_relationships(source))
        || program.summaries.iter().any(|(name, source)| {
            (preview || view.summaries.iter().any(|(_, selected)| selected == name))
                && expression::uses_relationships(source)
        })
}
/// Semantic group/unique identity, separate from the displayed value/witness.
/// A resolved relationship keeps its identity across aliases, moves and target
/// revisions. Unresolved destinations retain their readable path for repair.
pub(crate) fn canonical(value: &BaseValue) -> String {
    struct Canonical<'a>(&'a BaseValue);
    impl Serialize for Canonical<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeStruct;
            match self.0 {
                BaseValue::Link {
                    target: Some(target),
                    ..
                } => {
                    let mut record = serializer.serialize_struct("LinkIdentity", 2)?;
                    record.serialize_field("type", "link")?;
                    record.serialize_field("entryId", &target.entry_id)?;
                    record.end()
                }
                BaseValue::Link { path, external, .. } => {
                    let mut record = serializer.serialize_struct("LinkIdentity", 3)?;
                    record.serialize_field("type", "link")?;
                    record.serialize_field("path", path)?;
                    record.serialize_field("external", external)?;
                    record.end()
                }
                BaseValue::Number { value } if *value == 0.0 => {
                    BaseValue::Number { value: 0.0 }.serialize(serializer)
                }
                BaseValue::List { value } => {
                    let mut record = serializer.serialize_struct("List", 2)?;
                    record.serialize_field("type", "list")?;
                    record.serialize_field(
                        "value",
                        &value.iter().map(Canonical).collect::<Vec<_>>(),
                    )?;
                    record.end()
                }
                BaseValue::Object { value } => {
                    let mut entries = value
                        .iter()
                        .map(|(key, value)| (key, Canonical(value)))
                        .collect::<Vec<_>>();
                    entries.sort_by(|a, b| a.0.cmp(b.0));
                    let mut record = serializer.serialize_struct("Object", 2)?;
                    record.serialize_field("type", "object")?;
                    record.serialize_field("value", &entries)?;
                    record.end()
                }
                value => value.serialize(serializer),
            }
        }
    }
    serde_json::to_string(&Canonical(value)).expect("finite typed value serializes")
}
fn group_key_id(value: &BaseValue) -> String {
    format!("base-key-v1:{}", canonical(value))
}
pub(crate) fn display(value: &BaseValue, timezone: &str) -> String {
    match value {
        BaseValue::Null => "null".into(),
        BaseValue::Boolean { value } => value.to_string(),
        BaseValue::Number { value } => value.to_string(),
        BaseValue::String { value } | BaseValue::Html { value } | BaseValue::Icon { value } => {
            value.clone()
        }
        BaseValue::Image { value } => order::image_text(value),
        BaseValue::File { path } => path.clone(),
        BaseValue::Link {
            path,
            display: label,
            display_value,
            ..
        } => display_value
            .as_ref()
            .map(|value| display(value, timezone))
            .or_else(|| label.clone())
            .unwrap_or_else(|| path.clone()),
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

/// Generation-only adjacency and property discovery; invocation formulas and
/// selected view are added afresh by the evaluator.
pub(crate) struct QueryPreparation {
    // Set only by the sealed generation factory after exact bounded encoding.
    pub(crate) snapshot_bytes: Option<usize>,
    pub(crate) relationships: Option<crate::graph::OwnedRelationships>,
    pub(crate) available: Vec<String>,
    pub(crate) work_used: usize,
}
pub(crate) fn prepare_snapshot(
    snapshot: &BaseSnapshot,
    options: &QueryOptions,
) -> Result<QueryPreparation, ExpressionDiagnostic> {
    prepare_rows(&QueryRows::published(snapshot), options, None)
}
pub(crate) fn prepare_rows(
    input: &QueryRows<'_>,
    options: &QueryOptions,
    mut admission: Admission<'_>,
) -> Result<QueryPreparation, ExpressionDiagnostic> {
    let budget = |message: &str| ExpressionDiagnostic::new("budget", message);
    let graph_work = input.relationships.map_or(0, |graph| graph.edges().len());
    if graph_work.saturating_add(admission_work(&admission)) > options.max_steps {
        return Err(budget("Relationships exceed query work budget"));
    }
    let mut graph_preparation = 0usize;
    let mut check = |work: usize| {
        if options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|c| c.stop_reason().is_some())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        graph_preparation = graph_preparation.saturating_add(work);
        if graph_preparation.saturating_add(admission_work(&admission)) > options.max_steps {
            return Err(budget("Relationship preparation exceeds query work budget"));
        }
        Ok(())
    };
    let relationships = input
        .relationships
        .map(|graph| {
            crate::graph::OwnedRelationships::new(graph, input.metadata_issues, &mut check)
        })
        .transpose()?;
    let relationship_available = input.relationships.is_some_and(|graph| graph.complete());
    let mut discovery = 0usize;
    let mut preparation_work = graph_preparation;
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(slots::<String>(FILE_PROPERTIES.len() + 3)
            .saturating_add(string_copies(FILE_PROPERTIES.iter().copied(), admission)?)
            .saturating_add(string_copies(
                ["file.links", "file.embeds", "file.backlinks"],
                admission,
            )?))
    })?;
    let mut available = FILE_PROPERTIES
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    if relationship_available {
        available.extend(["file.links", "file.embeds", "file.backlinks"].map(String::from));
    }
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(available
            .iter()
            .map(|value| {
                map_slot::<String, ()>().saturating_add(crate::preview::string_bytes(value))
            })
            .fold(0usize, usize::saturating_add))
    })?;
    let mut available_set = available.iter().cloned().collect::<HashSet<_>>();
    for record in input.records {
        if options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|v| v.stop_reason().is_some())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        preparation_work = preparation_work.saturating_add(
            record.properties.len() + record.property_types.len() + record.tags.len() + 1,
        );
        if preparation_work.saturating_add(admission_work(&admission)) > options.max_steps {
            return Err(budget("Property discovery exceeds query work budget"));
        }
        for (key, _) in &record.properties {
            discovery = discovery.saturating_add(key.len() + 16);
            if discovery > crate::MAX_BASE_REQUEST_BYTES {
                return Err(budget("Property discovery exceeds byte budget"));
            }
            admit(&mut admission, |admission| {
                admission.charge(0)?;
                Ok(slots::<String>(1)
                    .saturating_add(map_slot::<String, ()>())
                    .saturating_add(crate::preview::string_bytes(key).saturating_mul(2))
                    .saturating_add(32))
            })?;
            let property = format!("note.{key}");
            if available_set.insert(property.clone()) {
                available.push(property);
            }
        }
        check_query_work(
            preparation_work,
            &admission,
            options,
            "Property discovery exceeds query work budget",
        )?;
    }
    Ok(QueryPreparation {
        snapshot_bytes: None,
        relationships,
        available,
        work_used: preparation_work,
    })
}

pub(crate) fn validate_snapshot_rows(snapshot: &BaseSnapshot) -> Result<(), ExpressionDiagnostic> {
    validate_record_rows(&snapshot.records)
}
fn validate_record_rows(records: &[DetachedRecord]) -> Result<(), ExpressionDiagnostic> {
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for record in records {
        let witness = record.witness.as_ref().ok_or_else(|| {
            ExpressionDiagnostic::new("input", "Query records require an entry/revision witness")
        })?;
        if !ids.insert(&witness.entry_id) || !paths.insert(&record.path) {
            return Err(ExpressionDiagnostic::new(
                "input",
                "Snapshot entry IDs and paths must be nonempty and unique",
            ));
        }
    }
    Ok(())
}

// A JSON tuple is exactly `[snapshot,options]`. Only the private sealed factory
// can supply the immutable snapshot byte credit. Detached callers keep the full
// streaming validation; fresh options (including selected `this`) are counted
// on every invocation, without walking the retained graph again.
pub(crate) fn request_size(
    snapshot: &impl Serialize,
    options: &QueryOptions,
    snapshot_bytes: Option<usize>,
) -> Result<usize, ExpressionDiagnostic> {
    if let Some(bytes) = snapshot_bytes {
        let dynamic = crate::encoded_size(options, crate::MAX_BASE_REQUEST_BYTES)?;
        bytes
            .checked_add(dynamic)
            .and_then(|n| n.checked_add(3))
            .filter(|n| *n <= crate::MAX_BASE_REQUEST_BYTES)
            .ok_or_else(|| ExpressionDiagnostic::new("budget", "Base encoded byte budget exceeded"))
    } else {
        crate::encoded_size(&(snapshot, options), crate::MAX_BASE_REQUEST_BYTES)
    }
}

/// Execute one bounded coherent snapshot. Any resource/cancellation failure is
/// an explicit Err; no silently truncated prefix is returned as a full query.
pub fn query_base(
    program: &BaseProgram,
    snapshot: &BaseSnapshot,
    options: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    query_base_prepared(program, snapshot, options, None)
}
pub(crate) fn query_base_prepared(
    program: &BaseProgram,
    snapshot: &BaseSnapshot,
    options: &QueryOptions,
    prepared: Option<&QueryPreparation>,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    let validated = validate_invocation(program, snapshot, options, prepared)?;
    query_base_validated(program, snapshot, options, prepared, &validated, &mut false)
}

// Private proof that the existing dynamic request/current-row checks ran. It
// contains only invocation data, never authority/pin/source capabilities.
pub(crate) struct ValidatedInvocation {
    selected_options: Option<QueryOptions>,
}
pub(crate) fn validate_invocation(
    program: &BaseProgram,
    snapshot: &BaseSnapshot,
    options: &QueryOptions,
    prepared: Option<&QueryPreparation>,
) -> Result<ValidatedInvocation, ExpressionDiagnostic> {
    validate_rows_invocation(
        program,
        &QueryRows::published(snapshot),
        options,
        prepared,
        |options| {
            request_size(snapshot, options, prepared.and_then(|p| p.snapshot_bytes)).map(|_| ())
        },
        None,
    )
}
pub(crate) fn validate_rows_invocation(
    program: &BaseProgram,
    input: &QueryRows<'_>,
    options: &QueryOptions,
    prepared: Option<&QueryPreparation>,
    mut request_size: impl FnMut(&QueryOptions) -> Result<(), ExpressionDiagnostic>,
    mut admission: Admission<'_>,
) -> Result<ValidatedInvocation, ExpressionDiagnostic> {
    let budget = |message: &str| ExpressionDiagnostic::new("budget", message);
    if options.max_steps == 0
        || options.max_steps > MAX_QUERY_STEPS
        || options.max_scanned > MAX_QUERY_SCANNED
        || options.max_rows > MAX_QUERY_ROWS
        || options.max_groups > MAX_QUERY_GROUPS
        || options.max_output_bytes > MAX_QUERY_OUTPUT_BYTES
    {
        return Err(budget("Query ceilings exceed supported maximum"));
    }

    request_size(options)?;
    if let Some(values) = input.property_values {
        values.validate_context(&options.evaluation)?;
    }
    program
        .views
        .get(options.view_index)
        .ok_or_else(|| ExpressionDiagnostic::new("configuration", "View index out of range"))?;
    if input.records.len() > options.max_scanned {
        return Err(budget("Snapshot exceeds scanned-record budget"));
    }
    if let Some(group) = &options.summary_preview_group_key_id {
        if options.summary_preview_property.is_none() || group.is_empty() {
            return Err(ExpressionDiagnostic::new(
                "configuration",
                "A group summary preview requires a property and nonempty group identity",
            ));
        }
        if group.len() > MAX_QUERY_OUTPUT_BYTES {
            return Err(budget("Summary preview group identity exceeds byte budget"));
        }
    }
    if options
        .summary_preview_property
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 65_536)
    {
        return Err(budget(
            "Summary preview property must be nonempty and within byte budget",
        ));
    }
    if options.search_terms.iter().map(String::len).sum::<usize>() > 65_536 {
        return Err(budget("Search terms exceed byte budget"));
    }
    if prepared.and_then(|p| p.snapshot_bytes).is_none() {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(input.records.len().saturating_mul(
                map_slot::<&crate::EntryId, ()>().saturating_add(map_slot::<&String, ()>()),
            ))
        })?;
        validate_record_rows(input.records)?;
    }
    let selected_current = options.current_entry_id.as_ref().and_then(|id| {
        input
            .records
            .iter()
            .find(|record| record.witness.as_ref().is_some_and(|w| &w.entry_id == id))
    });
    let selected_options = if options.current_entry_id.is_some() {
        let current = selected_current.ok_or_else(|| {
            ExpressionDiagnostic::new("stale-source", "Current entry is absent from this snapshot")
        })?;
        if options
            .evaluation
            .current_record
            .as_ref()
            .is_some_and(|provided| provided != current)
        {
            return Err(ExpressionDiagnostic::new(
                "stale-source",
                "Current record conflicts with selected entry",
            ));
        }
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(crate::preview::options_bytes(options, admission)?
                .saturating_add(crate::preview::record_bytes(current, admission)?))
        })?;
        let mut selected = options.clone();
        selected.evaluation.current_record = Some(current.clone());
        request_size(&selected)?;
        Some(selected)
    } else {
        None
    };
    let options = selected_options.as_ref().unwrap_or(options);
    if let Some(current) = &options.evaluation.current_record {
        let witness = current.witness.as_ref().ok_or_else(|| {
            ExpressionDiagnostic::new("input", "Current query record requires a witness")
        })?;
        if !input
            .records
            .iter()
            .any(|row| row.witness.as_ref() == Some(witness) && row == current)
        {
            return Err(ExpressionDiagnostic::new(
                "stale-source",
                "Current record does not match this snapshot",
            ));
        }
    }
    Ok(ValidatedInvocation { selected_options })
}
pub(crate) fn query_base_validated(
    program: &BaseProgram,
    snapshot: &BaseSnapshot,
    options: &QueryOptions,
    prepared: Option<&QueryPreparation>,
    validated: &ValidatedInvocation,
    clock_sensitive_sort: &mut bool,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    if snapshot
        .property_values
        .as_ref()
        .is_some_and(|values| values.snapshot_id() != snapshot.snapshot_id())
    {
        return Err(ExpressionDiagnostic::new(
            "stale-source",
            "Derived properties belong to another snapshot",
        ));
    }
    let rows = query_rows_validated(
        program,
        &QueryRows::published(snapshot),
        options,
        prepared,
        validated,
        clock_sensitive_sort,
        None,
    )?;
    let result = BaseQueryResult {
        snapshot_id: snapshot.snapshot_id.clone(),
        view: rows.view,
        rows: rows.rows,
        groups: rows.groups,
        summaries: rows.summaries,
        summary_previews: rows.summary_previews,
        group_options: rows.group_options,
        properties: rows.properties,
        available_properties: rows.available_properties,
        counts: rows.counts,
        diagnostics: rows.diagnostics,
        relation_targets: rows.relation_targets,
        property_definition_diagnostics: rows.property_definition_diagnostics,
        steps_used: rows.steps_used,
        relationships_available: rows.relationships_available,
        metadata_issues: rows.metadata_issues,
        metadata_complete: rows.metadata_complete,
        refresh_hint: rows.refresh_hint,
    };
    let options = validated.selected_options.as_ref().unwrap_or(options);
    crate::encoded_size(&result, options.max_output_bytes)?;
    Ok(result)
}
pub(crate) fn query_rows_validated(
    program: &BaseProgram,
    input: &QueryRows<'_>,
    options: &QueryOptions,
    prepared: Option<&QueryPreparation>,
    validated: &ValidatedInvocation,
    clock_sensitive_sort: &mut bool,
    mut admission: Admission<'_>,
) -> Result<QueryRowsResult, ExpressionDiagnostic> {
    let budget = |message: &str| ExpressionDiagnostic::new("budget", message);
    let options = validated.selected_options.as_ref().unwrap_or(options);
    let view = program
        .views
        .get(options.view_index)
        .expect("validated view");
    let owned;
    let (prepared, preparation_work) = if let Some(prepared) = prepared {
        (prepared, 0)
    } else {
        owned = prepare_rows(input, options, admission.as_deref_mut())?;
        let work = owned.work_used;
        (&owned, work)
    };
    let relationships = prepared
        .relationships
        .as_ref()
        .map(crate::graph::PreparedRelationships::borrowed);
    let relationship_available = relationships.as_ref().is_some_and(|graph| graph.complete());
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(
            slots::<String>(prepared.available.len()).saturating_add(string_copies(
                prepared.available.iter().map(String::as_str),
                admission,
            )?),
        )
    })?;
    let mut available = prepared.available.clone();
    if let Some(values) = input.property_values {
        for name in values.property_names() {
            let property = format!("note.{name}");
            admit(&mut admission, |_| {
                Ok(slots::<String>(1).saturating_add(crate::preview::string_bytes(&property)))
            })?;
            if !available.contains(&property) {
                available.push(property);
            }
        }
    }
    let mut counts = QueryCounts {
        scanned: input.records.len(),
        ..Default::default()
    };
    for (name, _) in &program.formulas {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(slots::<String>(1)
                .saturating_add(crate::preview::string_bytes(name))
                .saturating_add(32))
        })?;
        available.push(format!("formula.{name}"));
    }
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(
            slots::<String>(view.order.len()).saturating_add(string_copies(
                view.order.iter().map(String::as_str),
                admission,
            )?),
        )
    })?;
    let properties = view
        .order
        .iter()
        .filter(|property| property.starts_with("note.") || available.contains(property))
        .cloned()
        .collect::<Vec<_>>();
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(available
            .iter()
            .chain(properties.iter())
            .map(|value| {
                map_slot::<String, ()>().saturating_add(crate::preview::string_bytes(value))
            })
            .fold(0usize, usize::saturating_add))
    })?;
    let mut needed = available
        .iter()
        .chain(properties.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(property) = &options.summary_preview_property {
        let property = program::property_id(property);
        admit(&mut admission, |_| {
            Ok(map_slot::<String, ()>().saturating_add(crate::preview::string_bytes(&property)))
        })?;
        needed.insert(property);
    }
    for (property, _) in &view.summaries {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(map_slot::<String, ()>().saturating_add(crate::preview::string_bytes(property)))
        })?;
        needed.insert(property.clone());
    }
    if let Some(group) = &view.group {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(map_slot::<String, ()>()
                .saturating_add(crate::preview::string_bytes(&group.property)))
        })?;
        needed.insert(group.property.clone());
    }
    for sort in &view.sort {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(map_slot::<String, ()>()
                .saturating_add(crate::preview::string_bytes(&sort.property)))
        })?;
        needed.insert(sort.property.clone());
    }
    if let Some(image) = program::get(&view.configuration, "image").and_then(program::text) {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(map_slot::<String, ()>()
                .saturating_add(crate::preview::string_bytes(image))
                .saturating_add(32))
        })?;
        needed.insert(program::property_id(image));
    }
    let mut diagnostics = Vec::new();
    // Invocation-only metadata from actual evaluated runtime results. It never
    // enters the public rows/DTO or an answer cache, and never reevaluates a row.
    let mut tag_shapes: HashMap<crate::EntryId, BTreeMap<String, expression::TagShape>> =
        HashMap::new();
    let mut tag_shape_bytes = 0usize;
    let mut tag_properties = std::collections::BTreeSet::new();
    for (property, _) in &view.summaries {
        admit(&mut admission, |_| {
            Ok(map_slot::<String, ()>() + crate::preview::string_bytes(property))
        })?;
        tag_properties.insert(property.clone());
    }
    if let Some(property) = &options.summary_preview_property {
        admit(&mut admission, |_| {
            Ok(map_slot::<String, ()>() + crate::preview::string_bytes(property) + 16)
        })?;
        tag_properties.insert(program::property_id(property));
    }
    if let Some(group) = &view.group {
        admit(&mut admission, |_| {
            Ok(map_slot::<String, ()>() + crate::preview::string_bytes(&group.property))
        })?;
        tag_properties.insert(group.property.clone());
    }
    let mut rows = Vec::new();
    let mut steps_used = preparation_work;
    // Keep definition-owned syntax alive for the complete invocation. This
    // preserves literal identity across rows and optional parse-cache eviction.
    let prepared_formulas = if program.formulas.is_empty() {
        None
    } else {
        admit(&mut admission, |admission| {
            Ok(
                slots::<(String, String)>(program.formulas.len()).saturating_add(string_copies(
                    program
                        .formulas
                        .iter()
                        .flat_map(|(name, source)| [name.as_str(), source.as_str()]),
                    admission,
                )?),
            )
        })?;
        let work = std::cell::Cell::new(0usize);
        let ledger = std::cell::RefCell::new(&mut admission);
        let prepared = expression::prepare_formula_expressions(
            &program.formulas,
            &mut |bytes| {
                admit(&mut **ledger.borrow_mut(), |_| Ok(bytes)).map_err(|error| {
                    expression::RuntimeValue::Error(format!("{}\0{}", error.code, error.message))
                })
            },
            &mut |cost| {
                work.set(work.get().saturating_add(cost));
                if options
                    .evaluation
                    .cancellation
                    .as_ref()
                    .is_some_and(|token| token.is_cancelled())
                {
                    return Err(expression::RuntimeValue::Error(
                        "cancelled\0Query cancelled".into(),
                    ));
                }
                check_query_work(
                    steps_used.saturating_add(work.get()),
                    &**ledger.borrow(),
                    options,
                    "Formula syntax preparation exceeds query work budget",
                )
                .map_err(|error| {
                    expression::RuntimeValue::Error(format!("{}\0{}", error.code, error.message))
                })
            },
        )
        .map_err(expression::runtime_diagnostic)?;
        steps_used = steps_used.saturating_add(work.get());
        Some(prepared)
    };
    admit_selected_syntax(program, view, options, &mut steps_used, &mut admission)?;
    let mut retained_bytes = 0usize;
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(options
            .ignore_paths
            .len()
            .saturating_mul(map_slot::<&String, ()>()))
    })?;
    let ignored = options.ignore_paths.iter().collect::<HashSet<_>>();
    let shared_files = if input.relationships.is_some()
        && needs_shared_files(program, view, options.summary_preview_property.is_some())
        && input
            .records
            .iter()
            .any(|record| !ignored.contains(&record.path))
    {
        let timezone = expression::BasesTimezone::from_setting(Some(&options.evaluation.timezone))
            .map_err(|message| ExpressionDiagnostic::new("input", message))?;
        let mut hydration_work = 0usize;
        let remaining = options
            .max_steps
            .saturating_sub(steps_used)
            .saturating_sub(admission_work(&admission));
        let files = crate::files::hydrate(
            input.records,
            relationships.as_ref(),
            input.unavailable,
            input.property_values,
            &timezone,
            &mut |work| {
                if options
                    .evaluation
                    .cancellation
                    .as_ref()
                    .is_some_and(|c| c.is_cancelled())
                {
                    return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                }
                hydration_work = hydration_work.saturating_add(work);
                if hydration_work > remaining {
                    return Err(budget("Shared file context exceeds query work budget"));
                }
                Ok(())
            },
            &mut |bytes| admit(&mut admission, |_| Ok(bytes)),
        )?;
        steps_used = steps_used.saturating_add(hydration_work);
        check_query_work(
            steps_used,
            &admission,
            options,
            "Shared file context exceeds query work budget",
        )?;
        Some(files)
    } else {
        None
    };
    for record in input.records {
        if ignored.contains(&record.path) {
            continue;
        }
        let mut invocation = options.evaluation.clone();
        invocation.formulas = program.formulas.clone();
        invocation.max_steps = invocation.max_steps.min(
            options
                .max_steps
                .saturating_sub(steps_used)
                .saturating_sub(admission_work(&admission)),
        );
        let mut row_tag_shapes = BTreeMap::new();
        let row = with_session_prepared_files(
            "",
            record,
            &invocation,
            relationships.as_ref(),
            input.unavailable,
            input.property_values,
            shared_files.clone(),
            prepared_formulas.clone(),
            |session| {
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
                        report(
                            &mut diagnostics,
                            record,
                            "filter",
                            None,
                            error,
                            &mut admission,
                        )?;
                        false
                    }
                };
                if !included {
                    steps_used = steps_used.saturating_add(session.steps_used());
                    return Ok(None);
                }
                let mut values = BTreeMap::new();
                for property in &needed {
                    check_query_work(
                        steps_used.saturating_add(session.steps_used()),
                        &admission,
                        options,
                        "Preview admission exceeds query work budget",
                    )?;
                    admit(&mut admission, |admission| {
                        admission.charge(0)?;
                        Ok(crate::preview::string_bytes(property)
                            .saturating_mul(24)
                            .saturating_add(256))
                    })?;
                    let evaluated = if tag_properties.contains(property) {
                        session.evaluate_with_tag_shape(&value_expression(property), |bytes| {
                            tag_shape_bytes = tag_shape_bytes.saturating_add(bytes);
                            if tag_shape_bytes > options.max_output_bytes {
                                return Err(budget("Tag provenance exceeds byte budget"));
                            }
                            admit(&mut admission, |_| Ok(bytes))
                        })
                    } else {
                        session
                            .evaluate(&value_expression(property))
                            .map(|value| (value, None))
                    };
                    let value = match evaluated {
                        Ok((value, shape)) => {
                            if let Some(shape) = shape {
                                let bytes = map_slot::<String, expression::TagShape>()
                                    .saturating_add(crate::preview::string_bytes(property));
                                tag_shape_bytes = tag_shape_bytes.saturating_add(bytes);
                                if tag_shape_bytes > options.max_output_bytes {
                                    return Err(budget("Tag provenance exceeds byte budget"));
                                }
                                admit(&mut admission, |_| Ok(bytes))?;
                                row_tag_shapes.insert(property.clone(), shape);
                            }
                            value
                        }
                        Err(error) => {
                            if fatal(&error) {
                                return Err(error);
                            }
                            admit(&mut admission, |admission| {
                                admission.charge(0)?;
                                Ok(string_copies(
                                    [error.code.as_str(), error.message.as_str()],
                                    admission,
                                )?)
                            })?;
                            let value = BaseValue::Error {
                                code: error.code.clone(),
                                message: error.message.clone(),
                            };
                            report(
                                &mut diagnostics,
                                record,
                                "value",
                                Some(property),
                                error,
                                &mut admission,
                            )?;
                            value
                        }
                    };
                    admit(&mut admission, |admission| {
                        admission.charge(0)?;
                        Ok(map_slot::<String, BaseValue>()
                            .saturating_add(crate::preview::string_bytes(property))
                            .saturating_add(crate::preview::value_bytes(&value, admission)?))
                    })?;
                    values.insert(property.clone(), value);
                    check_query_work(
                        steps_used.saturating_add(session.steps_used()),
                        &admission,
                        options,
                        "Preview admission exceeds query work budget",
                    )?;
                }
                let mut edit_values = BTreeMap::new();
                for (property, rendered) in &values {
                    let Some(requested) = property.strip_prefix("note.") else {
                        continue;
                    };
                    steps_used = steps_used.saturating_add(requested.len() + 1);
                    check_query_work(
                        steps_used.saturating_add(session.steps_used()),
                        &admission,
                        options,
                        "Raw property name resolution exceeds query work budget",
                    )?;
                    // Name resolution follows exact-first/casefold runtime lookup.
                    // Charge every candidate before the repeated scans or lowercase
                    // allocations, including finding the original raw source below.
                    let overlay = record.witness.as_ref().and_then(|witness| {
                        input
                            .property_values
                            .and_then(|properties| properties.rows().get(&witness.entry_id))
                    });
                    for name in record
                        .properties
                        .iter()
                        .map(|(name, _)| name.as_str())
                        .chain(
                            overlay
                                .into_iter()
                                .flat_map(|row| row.values.keys().map(String::as_str)),
                        )
                    {
                        steps_used = steps_used
                            .saturating_add(name.len().saturating_add(1).saturating_mul(4));
                        if options
                            .evaluation
                            .cancellation
                            .as_ref()
                            .is_some_and(|token| token.is_cancelled())
                        {
                            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                        }
                        check_query_work(
                            steps_used.saturating_add(session.steps_used()),
                            &admission,
                            options,
                            "Raw property name resolution exceeds query work budget",
                        )?;
                    }
                    if readonly_note_property(record, input.property_values, requested) {
                        continue;
                    }
                    let Some(actual) =
                        resolved_note_property(record, input.property_values, requested)
                    else {
                        continue;
                    };
                    let Some((_, raw)) = record.properties.iter().find(|(name, _)| name == actual)
                    else {
                        continue;
                    };
                    if raw_matches_rendered(raw, rendered, &mut || {
                        steps_used = steps_used.saturating_add(1);
                        if options
                            .evaluation
                            .cancellation
                            .as_ref()
                            .is_some_and(|c| c.is_cancelled())
                        {
                            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                        }
                        check_query_work(
                            steps_used.saturating_add(session.steps_used()),
                            &admission,
                            options,
                            "Raw edit value comparison exceeds query work budget",
                        )
                    })? {
                        continue;
                    }
                    admit(&mut admission, |admission| {
                        admission.charge(0)?;
                        Ok(map_slot::<String, BaseValue>()
                            .saturating_add(crate::preview::string_bytes(&property))
                            .saturating_add(
                                crate::preview::property_bytes(raw, admission)?.saturating_mul(4),
                            ))
                    })?;
                    let raw = expression::typed_result(crate::runtime_value(raw, 0, &mut 0usize)?)?;
                    edit_values.insert(property.clone(), raw);
                    steps_used = steps_used.saturating_add(1);
                    check_query_work(
                        steps_used.saturating_add(session.steps_used()),
                        &admission,
                        options,
                        "Raw edit values exceed query work budget",
                    )?;
                }
                steps_used = steps_used.saturating_add(session.steps_used());
                admit(&mut admission, |admission| {
                    admission.charge(0)?;
                    Ok(slots::<BaseRow>(1).saturating_add(string_copies(
                        [
                            record
                                .witness
                                .as_ref()
                                .expect("validated witness")
                                .entry_id
                                .as_str(),
                            record
                                .witness
                                .as_ref()
                                .expect("validated witness")
                                .revision
                                .as_str(),
                            &record.path,
                        ],
                        admission,
                    )?))
                })?;
                Ok(Some(BaseRow {
                    entry_id: record
                        .witness
                        .as_ref()
                        .expect("query witness validated")
                        .entry_id
                        .clone(),
                    revision: record
                        .witness
                        .as_ref()
                        .expect("query witness validated")
                        .revision
                        .clone(),
                    path: record.path.clone(),
                    values,
                    edit_values,
                }))
            },
        )?;
        if let Some(row) = row {
            let encoded = if admission.is_some() {
                crate::encoded_size(&row, options.max_output_bytes)?
            } else {
                serde_json::to_vec(&row)
                    .map_err(|error| ExpressionDiagnostic::new("output", error.to_string()))?
                    .len()
            };
            retained_bytes = retained_bytes.saturating_add(encoded);
            if retained_bytes > options.max_output_bytes {
                return Err(budget("Intermediate query rows exceed byte budget"));
            }
            if !row_tag_shapes.is_empty() {
                let bytes = map_slot::<crate::EntryId, BTreeMap<String, expression::TagShape>>()
                    + crate::preview::string_bytes(row.entry_id.as_str());
                tag_shape_bytes = tag_shape_bytes.saturating_add(bytes);
                if tag_shape_bytes > options.max_output_bytes {
                    return Err(budget("Tag provenance exceeds byte budget"));
                }
                admit(&mut admission, |_| Ok(bytes))?;
                tag_shapes.insert(row.entry_id.clone(), row_tag_shapes);
            }
            rows.push(row);
        }
    }
    counts.matched = rows.len();
    let null = BaseValue::Null;
    admit(&mut admission, |_| {
        Ok(input.records.len().saturating_mul(
            map_slot::<&crate::EntryId, &DetachedRecord>().saturating_add(
                if view.group.is_some() {
                    map_slot::<&str, &DetachedRecord>()
                } else {
                    0
                },
            ),
        ))
    })?;
    let by_id = input
        .records
        .iter()
        .map(|record| {
            (
                &record.witness.as_ref().expect("validated witness").entry_id,
                record,
            )
        })
        .collect::<HashMap<_, _>>();
    let by_path = if view.group.is_some() {
        input
            .records
            .iter()
            .map(|record| (record.path.as_str(), record))
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    let group_timezone = if view.group.is_some() {
        expression::BasesTimezone::from_setting(Some(&options.evaluation.timezone))
            .map_err(|message| ExpressionDiagnostic::new("input", message))?
    } else {
        expression::BasesTimezone::default()
    };
    let definition_origin = if view.group.is_some() {
        options
            .definition_entry_id
            .as_ref()
            .map(|id| {
                by_id.get(id).copied().ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "stale-source",
                        "Base definition origin is outside the captured snapshot",
                    )
                })
            })
            .transpose()?
    } else {
        None
    };
    let grouping = if view.group.is_some() {
        Some(grouping::Engine::prepare(
            &rows,
            &mut grouping::Context {
                view,
                options,
                tag_shapes: &tag_shapes,
                clock_sensitive: clock_sensitive_sort,
                timezone: &group_timezone,
                records: &by_id,
                paths: &by_path,
                graph: relationships.as_ref(),
                properties: input.property_values,
                origin: definition_origin,
                diagnostics: &mut diagnostics,
                steps: &mut steps_used,
                admission: &mut admission,
            },
        )?)
    } else {
        None
    };
    // The chooser inventories the matched collection before manual admission,
    // search, sorting and the global limit. Its representatives may differ
    // from the display groups, exactly as its independent source rows do.
    let group_options = if let Some(grouping) = &grouping {
        grouping.options(
            &rows,
            &mut grouping::Context {
                view,
                options,
                tag_shapes: &tag_shapes,
                clock_sensitive: clock_sensitive_sort,
                timezone: &group_timezone,
                records: &by_id,
                paths: &by_path,
                graph: relationships.as_ref(),
                properties: input.property_values,
                origin: definition_origin,
                diagnostics: &mut diagnostics,
                steps: &mut steps_used,
                admission: &mut admission,
            },
        )?
    } else {
        Vec::new()
    };
    if let Some(grouping) = &grouping {
        rows.retain(|row| grouping.admits(row));
    }
    counts.after_group_order = rows.len();
    let search_work = rows
        .len()
        .saturating_mul(properties.len())
        .saturating_mul(options.search_terms.len())
        .saturating_add(retained_bytes.saturating_mul(options.search_terms.len()) / 256);
    steps_used = steps_used.saturating_add(search_work);
    check_query_work(
        steps_used,
        &admission,
        options,
        "Search exceeds query work budget",
    )?;
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(slots::<String>(options.search_terms.len()).saturating_add(
            options
                .search_terms
                .iter()
                .map(|term| {
                    crate::preview::string_bytes(term)
                        .saturating_mul(6)
                        .saturating_add(128)
                })
                .fold(0usize, usize::saturating_add),
        ))
    })?;
    let terms = options
        .search_terms
        .iter()
        .map(|term| term.to_lowercase())
        .collect::<Vec<_>>();
    if admission.is_some() && !terms.is_empty() {
        // The unchanged renderer below may short-circuit. Pre-admit every
        // possible derived display/lowercase buffer before entering retain.
        for row in &rows {
            for property in &properties {
                if let Some(value) = row.values.get(property) {
                    admit(&mut admission, |admission| {
                        admission.charge(0)?;
                        Ok(display_copy_bytes(value, 0, admission)?
                            .saturating_mul(8)
                            .saturating_add(128)
                            .saturating_mul(terms.len()))
                    })?;
                }
            }
        }
    }
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
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(slots::<String>(FILE_PROPERTIES.len() + 3)
            .saturating_add(string_copies(FILE_PROPERTIES.iter().copied(), admission)?)
            .saturating_add(string_copies(
                ["file.links", "file.embeds", "file.backlinks"],
                admission,
            )?))
    })?;
    let mut matched_available = FILE_PROPERTIES
        .iter()
        .map(|property| property.to_string())
        .collect::<Vec<_>>();
    if relationship_available {
        matched_available.extend(["file.links", "file.embeds", "file.backlinks"].map(String::from));
    }
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(matched_available
            .iter()
            .map(|value| {
                map_slot::<String, ()>().saturating_add(crate::preview::string_bytes(value))
            })
            .fold(0usize, usize::saturating_add))
    })?;
    if let Some(values) = input.property_values {
        for name in values.property_names() {
            let property = format!("note.{name}");
            admit(&mut admission, |_| {
                Ok(slots::<String>(1).saturating_add(crate::preview::string_bytes(&property)))
            })?;
            if !matched_available.contains(&property) {
                matched_available.push(property);
            }
        }
    }
    let mut matched_set = matched_available.iter().cloned().collect::<HashSet<_>>();
    for row in &rows {
        if let Some(record) = by_id.get(&row.entry_id) {
            for (key, _) in &record.properties {
                admit(&mut admission, |admission| {
                    admission.charge(0)?;
                    Ok(slots::<String>(1)
                        .saturating_add(map_slot::<String, ()>())
                        .saturating_add(crate::preview::string_bytes(key).saturating_mul(2))
                        .saturating_add(32))
                })?;
                let property = format!("note.{key}");
                if matched_set.insert(property.clone()) {
                    matched_available.push(property);
                }
            }
        }
    }
    for (name, _) in &program.formulas {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(slots::<String>(1)
                .saturating_add(crate::preview::string_bytes(name))
                .saturating_add(32))
        })?;
        matched_available.push(format!("formula.{name}"));
    }
    let available = matched_available;
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(available
            .iter()
            .chain(properties.iter())
            .map(|value| {
                map_slot::<String, ()>().saturating_add(crate::preview::string_bytes(value))
            })
            .fold(0usize, usize::saturating_add))
    })?;
    let mut retained = available
        .iter()
        .chain(properties.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(group) = &view.group {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(map_slot::<String, ()>()
                .saturating_add(crate::preview::string_bytes(&group.property)))
        })?;
        retained.insert(group.property.clone());
    }
    if let Some(image) = program::get(&view.configuration, "image").and_then(program::text) {
        admit(&mut admission, |admission| {
            admission.charge(0)?;
            Ok(map_slot::<String, ()>()
                .saturating_add(crate::preview::string_bytes(image))
                .saturating_add(32))
        })?;
        retained.insert(program::property_id(image));
    }
    for row in &mut rows {
        row.values.retain(|property, _| retained.contains(property));
        row.edit_values
            .retain(|property, _| retained.contains(property));
    }
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(slots::<Criterion>(view.sort.len().saturating_add(1))
            .saturating_add(string_copies(
                view.sort
                    .iter()
                    .map(|criterion| criterion.property.as_str()),
                admission,
            )?)
            .saturating_add(crate::preview::string_bytes("file.name")))
    })?;
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
    check_query_work(
        steps_used,
        &admission,
        options,
        "Sorting exceeds query work budget",
    )?;
    let mut scalars = HashMap::new();
    for row in &rows {
        for criterion in &sort {
            let value = row.values.get(&criterion.property).unwrap_or(&null);
            // Duration ordering applies the value to the invocation clock, even
            // for no-call formulas and rows later removed by limit/truncation.
            // Keep this dependency with the checked evaluation, not final cells.
            if matches!(value, BaseValue::Duration { .. }) {
                *clock_sensitive_sort = true;
            }
            admit(&mut admission, |admission| {
                admission.charge(0)?;
                Ok(map_slot::<(&crate::EntryId, &str), BaseValue>()
                    .saturating_add(crate::preview::value_bytes(value, admission)?))
            })?;
            let value = scalar_for_sort(value, options)?;
            // Keys borrow immutable source witnesses and compiled criteria,
            // remaining stable while the independent result rows are sorted.
            let source_id = &by_id[&row.entry_id]
                .witness
                .as_ref()
                .expect("validated witness")
                .entry_id;
            scalars.insert((source_id, criterion.property.as_str()), value);
        }
    }
    admit(&mut admission, |_| Ok(slots::<BaseRow>(rows.len())))?;
    if rows.len() > 1 {
        let null = &null;
        comparator_scratch_admission(
            rows.iter().flat_map(|row| {
                sort.iter()
                    .map(move |criterion| row.values.get(&criterion.property).unwrap_or(null))
            }),
            &mut admission,
        )?;
    }
    check_query_work(
        steps_used,
        &admission,
        options,
        "Comparator scratch exceeds query work budget",
    )?;
    rows.sort_by(|a, b| {
        for criterion in &sort {
            let left = a.values.get(&criterion.property).unwrap_or(&null);
            let right = b.values.get(&criterion.property).unwrap_or(&null);
            let comparison = if matches!(
                (left, right),
                (BaseValue::Duration { .. }, BaseValue::Duration { .. })
            ) {
                order::compare_with_timezone(
                    scalars
                        .get(&(&a.entry_id, criterion.property.as_str()))
                        .unwrap_or(&null),
                    scalars
                        .get(&(&b.entry_id, criterion.property.as_str()))
                        .unwrap_or(&null),
                    criterion.descending,
                    &options.evaluation.timezone,
                )
            } else {
                order::compare_with_timezone(
                    left,
                    right,
                    criterion.descending,
                    &options.evaluation.timezone,
                )
            };
            if !comparison.is_eq() {
                return comparison;
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
    let mut groups = if let Some(grouping) = &grouping {
        grouping.display(
            &rows,
            &mut grouping::Context {
                view,
                options,
                tag_shapes: &tag_shapes,
                clock_sensitive: clock_sensitive_sort,
                timezone: &group_timezone,
                records: &by_id,
                paths: &by_path,
                graph: relationships.as_ref(),
                properties: input.property_values,
                origin: definition_origin,
                diagnostics: &mut diagnostics,
                steps: &mut steps_used,
                admission: &mut admission,
            },
        )?
    } else {
        admit(&mut admission, |admission| {
            Ok(slots::<BaseGroup>(1)
                .saturating_add(slots::<crate::EntryId>(rows.len()))
                .saturating_add(string_copies(
                    rows.iter().map(|row| row.entry_id.as_str()),
                    admission,
                )?))
        })?;
        vec![BaseGroup {
            key_id: None,
            key: None,
            edit_key: None,
            order_key: None,
            entry_ids: rows.iter().map(|row| row.entry_id.clone()).collect(),
            summaries: BTreeMap::new(),
        }]
    };
    let (summaries, summary_previews) = summarize_rows(
        program,
        view,
        &rows,
        &mut groups,
        &tag_shapes,
        prepared_formulas.as_ref(),
        input,
        options,
        relationships.as_ref(),
        shared_files.as_ref(),
        &mut steps_used,
        &mut admission,
    )?;
    let (relation_targets, property_definition_diagnostics) =
        if let Some(values) = input.property_values {
            // The map is sealed by the generation factory. Budget output and copies
            // before cloning its candidate witnesses; callers cannot inject targets.
            let bytes = crate::encoded_size(
                &(values.relation_targets(), values.definition_diagnostics()),
                options.max_output_bytes,
            )?;
            admit(&mut admission, |_| {
                Ok(bytes.saturating_mul(8).saturating_add(256))
            })?;
            for issue in values.diagnostics() {
                let record = by_id
                    .get(&issue.witness.entry_id)
                    .filter(|record| record.witness.as_ref() == Some(&issue.witness))
                    .ok_or_else(|| {
                        ExpressionDiagnostic::new(
                            "stale-source",
                            "Property diagnostic has no matching query revision",
                        )
                    })?;
                report(
                    &mut diagnostics,
                    record,
                    "property",
                    Some(&program::property_id(&issue.property)),
                    ExpressionDiagnostic::new(&issue.code, &issue.message),
                    &mut admission,
                )?;
                steps_used = steps_used.saturating_add(1);
            }
            (
                Some(values.relation_targets().clone()),
                values.definition_diagnostics().to_vec(),
            )
        } else {
            (None, Vec::new())
        };
    let dependency = program
        .refresh_dependency(options.view_index)
        .join(
            input
                .property_values
                .map_or(BaseClockDependency::None, |values| {
                    values.clock_dependency()
                }),
        )
        .join(if options.summary_preview_property.is_some() {
            program.summary_preview_dependency
        } else {
            BaseClockDependency::None
        })
        .join(if *clock_sensitive_sort {
            BaseClockDependency::Instant
        } else {
            BaseClockDependency::None
        });
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        Ok(crate::preview::string_bytes(&options.evaluation.timezone).saturating_add(128))
    })?;
    let refresh_hint = refresh_hint_checked(dependency, &options.evaluation, |work| {
        if options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|token| token.stop_reason().is_some())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        steps_used = steps_used
            .checked_add(work)
            .filter(|&used| used.saturating_add(admission_work(&admission)) <= options.max_steps)
            .ok_or_else(|| budget("Refresh hint exceeds query work budget"))?;
        Ok(())
    })?;
    admit(&mut admission, |admission| {
        admission.charge(0)?;
        let mut bytes = std::mem::size_of::<QueryRowsResult>()
            .saturating_add(crate::preview::property_bytes(
                &view.configuration,
                admission,
            )?)
            .saturating_add(slots::<crate::MetadataIssue>(input.metadata_issues.len()));
        for issue in input.metadata_issues {
            bytes = bytes.saturating_add(crate::preview::issue_bytes(issue, admission)?);
        }
        Ok(bytes)
    })?;
    steps_used = steps_used
        .checked_add(admission_work(&admission))
        .filter(|used| *used <= options.max_steps)
        .ok_or_else(|| budget("Preview admission exceeds query work budget"))?;
    let result = QueryRowsResult {
        view: view.configuration.clone(),
        rows,
        groups,
        summaries,
        summary_previews,
        group_options,
        properties,
        available_properties: available,
        counts,
        diagnostics,
        relation_targets,
        property_definition_diagnostics,
        steps_used,
        relationships_available: relationship_available,
        metadata_issues: input.metadata_issues.to_vec(),
        metadata_complete: input.relationships.is_some()
            && !input
                .metadata_issues
                .iter()
                .any(|i| i.properties_unavailable),
        refresh_hint,
    };
    Ok(result)
}

/// Summary inputs come from returned rows, after saved limits. Preview callers
/// keep their existing explicit prepared-subset aggregate coverage markers.
fn summarize_rows(
    program: &BaseProgram,
    view: &program::View,
    rows: &[BaseRow],
    groups: &mut [BaseGroup],
    tag_shapes: &HashMap<crate::EntryId, BTreeMap<String, expression::TagShape>>,
    prepared_formulas: Option<&std::sync::Arc<expression::PreparedFormulaExpressions>>,
    input: &QueryRows<'_>,
    options: &QueryOptions,
    relationships: Option<&crate::graph::PreparedRelationships<'_>>,
    shared_files: Option<&std::sync::Arc<crate::files::BasesFiles>>,
    steps: &mut usize,
    admission: &mut Admission<'_>,
) -> Result<
    (
        BTreeMap<String, BaseValue>,
        Option<BTreeMap<String, BaseValue>>,
    ),
    ExpressionDiagnostic,
> {
    if view.summaries.is_empty() && options.summary_preview_property.is_none() {
        return Ok((BTreeMap::new(), None));
    }
    admit(admission, |_| {
        Ok(input
            .records
            .len()
            .saturating_mul(map_slot::<&str, &DetachedRecord>())
            .saturating_add(
                rows.len()
                    .saturating_mul(map_slot::<&crate::EntryId, &BaseRow>()),
            )
            .saturating_add(slots::<&BaseRow>(rows.len())))
    })?;
    *steps = steps
        .saturating_add(input.records.len())
        .saturating_add(rows.len());
    check_query_work(
        *steps,
        admission,
        options,
        "Summary lookup exceeds query work budget",
    )?;
    let by_path = input
        .records
        .iter()
        .map(|record| (record.path.as_str(), record))
        .collect::<HashMap<_, _>>();
    let by_id = rows
        .iter()
        .map(|row| (&row.entry_id, row))
        .collect::<HashMap<_, _>>();
    let timezone = expression::BasesTimezone::from_setting(Some(&options.evaluation.timezone))
        .map_err(|message| ExpressionDiagnostic::new("input", message))?;
    let mut summary_files = shared_files.cloned();
    let mut evaluate = |selected: &[&BaseRow],
                        selections: &[(&str, &str, &str)],
                        steps: &mut usize,
                        admission: &mut Admission<'_>| {
        let mut result = BTreeMap::new();
        for &(key, property, name) in selections {
            if options
                .evaluation
                .cancellation
                .as_ref()
                .is_some_and(|token| token.stop_reason().is_some())
            {
                return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
            }
            admit(admission, |_| Ok(slots::<&BaseValue>(selected.len())))?;
            *steps = steps.saturating_add(selected.len()).saturating_add(1);
            check_query_work(
                *steps,
                admission,
                options,
                "Summary inputs exceed query work budget",
            )?;
            let null = BaseValue::Null;
            let values = selected
                .iter()
                .map(|row| row.values.get(property).unwrap_or(&null))
                .collect::<Vec<_>>();
            admit(admission, |_| {
                Ok(slots::<Option<&expression::TagShape>>(selected.len()))
            })?;
            let selected_shapes = selected
                .iter()
                .map(|row| {
                    tag_shapes
                        .get(&row.entry_id)
                        .and_then(|shapes| shapes.get(property))
                })
                .collect::<Vec<_>>();
            // Each summary invocation owns newly rehydrated private constructor
            // data. Admit those copies before restoring any runtime values.
            for shape in selected_shapes.iter().flatten() {
                let bytes = expression::runtime_shape_restore_bytes(shape, &mut |work| {
                    *steps = steps.saturating_add(work);
                    if options
                        .evaluation
                        .cancellation
                        .as_ref()
                        .is_some_and(|token| token.is_cancelled())
                    {
                        return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                    }
                    check_query_work(
                        *steps,
                        admission,
                        options,
                        "Summary runtime provenance exceeds work budget",
                    )
                })?;
                admit(admission, |_| Ok(bytes))?;
            }
            // File values expose complete captured properties, including nested
            // links. Build their shared projection once for all summaries, even
            // when the summary uses only value.properties and no global lookup.
            fn has_file(
                value: &BaseValue,
                check: &mut impl FnMut() -> Result<(), ExpressionDiagnostic>,
            ) -> Result<bool, ExpressionDiagnostic> {
                check()?;
                match value {
                    BaseValue::File { .. } => Ok(true),
                    BaseValue::List { value } => {
                        for value in value {
                            if has_file(value, check)? {
                                return Ok(true);
                            }
                        }
                        Ok(false)
                    }
                    BaseValue::Object { value } => {
                        for (_, value) in value {
                            if has_file(value, check)? {
                                return Ok(true);
                            }
                        }
                        Ok(false)
                    }
                    _ => Ok(false),
                }
            }
            let mut needs_files = false;
            if summary_files.is_none() {
                for value in &values {
                    if has_file(value, &mut || {
                        *steps = steps.saturating_add(1);
                        check_query_work(
                            *steps,
                            admission,
                            options,
                            "Summary file scan exceeds query work budget",
                        )
                    })? {
                        needs_files = true;
                        break;
                    }
                }
            }
            if needs_files {
                let mut work = 0usize;
                let remaining = options
                    .max_steps
                    .saturating_sub(*steps)
                    .saturating_sub(admission_work(admission));
                summary_files = Some(crate::files::hydrate(
                    input.records,
                    relationships,
                    input.unavailable,
                    input.property_values,
                    &timezone,
                    &mut |cost| {
                        work = work.saturating_add(cost);
                        if options
                            .evaluation
                            .cancellation
                            .as_ref()
                            .is_some_and(|c| c.is_cancelled())
                        {
                            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                        }
                        if work > remaining {
                            return Err(ExpressionDiagnostic::new(
                                "budget",
                                "Summary file context exceeds query work budget",
                            ));
                        }
                        Ok(())
                    },
                    &mut |bytes| admit(admission, |_| Ok(bytes)),
                )?);
                *steps = steps.saturating_add(work);
                check_query_work(
                    *steps,
                    admission,
                    options,
                    "Summary file context exceeds query work budget",
                )?;
            }
            let mut invocation = options.evaluation.clone();
            invocation.formulas.clear();
            invocation.current_record = None;
            invocation.max_steps = invocation.max_steps.min(
                options
                    .max_steps
                    .saturating_sub(*steps)
                    .saturating_sub(admission_work(admission)),
            );
            let mut file_work = 0usize;
            let evaluated = crate::summaries::evaluate(
                program,
                name,
                &values,
                &selected_shapes,
                prepared_formulas.cloned(),
                &invocation,
                relationships,
                summary_files.clone(),
                |path| {
                    if let Some(files) = &summary_files {
                        return files.by_path(path).cloned().ok_or_else(|| {
                            ExpressionDiagnostic::new(
                                "unavailable",
                                "Summary file is not hydrated in the captured snapshot",
                            )
                        });
                    }
                    let record = by_path.get(path).ok_or_else(|| {
                        ExpressionDiagnostic::new(
                            "unavailable",
                            "Summary file is not in the query snapshot",
                        )
                    })?;
                    let mut check_file = |work| {
                        file_work = file_work.saturating_add(work);
                        if options
                            .evaluation
                            .cancellation
                            .as_ref()
                            .is_some_and(|cancel| cancel.is_cancelled())
                        {
                            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                        }
                        if file_work > invocation.max_steps {
                            return Err(ExpressionDiagnostic::new(
                                "budget",
                                "Summary file identity exceeds work budget",
                            ));
                        }
                        Ok(())
                    };
                    let identity_bytes =
                        crate::frontmatter_link_identity_bytes(record, &mut check_file)?;
                    let shape_bytes = input.property_values.map_or(0, |derived| {
                        record.witness.as_ref().map_or(0, |witness| {
                            derived.attachment_shape_bytes(&witness.entry_id)
                        })
                    });
                    admit(
                        admission,
                        |_| Ok(identity_bytes.saturating_add(shape_bytes)),
                    )?;
                    let mut file = crate::runtime_file_checked(record, &timezone, &mut check_file)?;
                    if let Some(graph) = relationships {
                        graph.attach(&mut file);
                        graph.resolve_property_links(&mut file, &mut check_file, &mut |bytes| {
                            admit(admission, |_| Ok(bytes))
                        })?;
                    }
                    if let Some(derived) = input.property_values {
                        derived.attach(&mut file, &timezone, &mut check_file)?;
                    }
                    file.metadata_unavailable |= record.witness.as_ref().is_some_and(|witness| {
                        input
                            .unavailable
                            .is_some_and(|ids| ids.contains(&witness.entry_id))
                    });
                    Ok(file)
                },
            )?;
            *steps = steps
                .saturating_add(evaluated.steps_used)
                .saturating_add(file_work);
            check_query_work(
                *steps,
                admission,
                options,
                "Summary evaluation exceeds query work budget",
            )?;
            admit(admission, |admission| {
                let value_bytes = crate::preview::value_bytes(&evaluated.value, admission)?;
                Ok(map_slot::<String, BaseValue>()
                    .saturating_add(crate::preview::string_bytes(key))
                    .saturating_add(value_bytes))
            })?;
            crate::encoded_size(&evaluated.value, options.max_output_bytes)?;
            result.insert(key.to_string(), evaluated.value);
        }
        Ok::<_, ExpressionDiagnostic>(result)
    };
    let selected = rows.iter().collect::<Vec<_>>();
    let configured = view
        .summaries
        .iter()
        .map(|(property, name)| (property.as_str(), property.as_str(), name.as_str()))
        .collect::<Vec<_>>();
    let overall = evaluate(&selected, &configured, steps, admission)?;
    let previews = if let Some(property) = &options.summary_preview_property {
        let property = program::property_id(property);
        let scoped;
        let preview_rows = if let Some(key_id) = &options.summary_preview_group_key_id {
            *steps = steps.saturating_add(groups.len());
            check_query_work(
                *steps,
                admission,
                options,
                "Summary preview group lookup exceeds work budget",
            )?;
            let group = groups
                .iter()
                .find(|group| group.key_id.as_ref() == Some(key_id))
                .ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "stale-source",
                        "Summary preview group is not in the current result",
                    )
                })?;
            admit(admission, |_| Ok(slots::<&BaseRow>(group.entry_ids.len())))?;
            scoped = group
                .entry_ids
                .iter()
                .map(|id| by_id[id])
                .collect::<Vec<_>>();
            &scoped
        } else {
            &selected
        };
        let first = preview_rows
            .iter()
            .filter_map(|row| row.values.get(&property))
            .find(|value| !matches!(value, BaseValue::Null));
        let names = crate::summaries::names(program, first);
        let selections = names
            .iter()
            .map(|name| (name.as_str(), property.as_str(), name.as_str()))
            .collect::<Vec<_>>();
        Some(evaluate(preview_rows, &selections, steps, admission)?)
    } else {
        None
    };
    for group in groups {
        admit(admission, |_| Ok(slots::<&BaseRow>(group.entry_ids.len())))?;
        *steps = steps.saturating_add(group.entry_ids.len());
        check_query_work(
            *steps,
            admission,
            options,
            "Group summary lookup exceeds query work budget",
        )?;
        let selected = group
            .entry_ids
            .iter()
            .map(|id| by_id[id])
            .collect::<Vec<_>>();
        group.summaries = evaluate(&selected, &configured, steps, admission)?;
    }
    Ok((overall, previews))
}

/// Recompute only scheduling metadata for this invocation. This does not prove
/// answer reuse and never substitutes for the caller's retained source checks.
pub(crate) fn refresh_hint_checked(
    dependency: BaseClockDependency,
    options: &EvaluationOptions,
    mut check: impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<BaseRefreshHint>, ExpressionDiagnostic> {
    expression::refresh_deadline(dependency, options.clock_ms, &options.timezone, &mut check).map(
        |capture| {
            capture.map(|(timezone, next_wake_ms)| BaseRefreshHint {
                dependency,
                timezone,
                next_wake_ms,
            })
        },
    )
}

#[cfg(test)]
mod comparator_admission_tests {
    use super::*;

    #[test]
    fn comparator_scratch_is_bounded_before_comparison_and_reuses_one_maximum_pair() {
        let options = QueryOptions::default();
        let long = BaseValue::String {
            value: "x".repeat(256),
        };
        let mut tight = crate::preview::PreviewAdmission::new(1_024, &options).unwrap();
        let error = comparator_scratch_admission([&long], &mut Some(&mut tight)).unwrap_err();
        assert_eq!(error.code, "budget");

        let small = BaseValue::String {
            value: "Ab12".into(),
        };
        let mut repeated = crate::preview::PreviewAdmission::new(512, &options).unwrap();
        // One pair fits512 bytes. Three cumulative pair allocations would not;
        // only shape visits accumulate because comparison scratch is reclaimed.
        comparator_scratch_admission([&small, &small, &small], &mut Some(&mut repeated)).unwrap();
        assert!(repeated.work_used() > 0 && repeated.work_used() < 100);

        let nested = BaseValue::Object {
            value: vec![(
                "key".into(),
                BaseValue::List {
                    value: vec![BaseValue::String { value: "İ".into() }],
                },
            )],
        };
        let mut nested_ledger = crate::preview::PreviewAdmission::new(512, &options).unwrap();
        comparator_scratch_admission([&nested], &mut Some(&mut nested_ledger)).unwrap();
        assert!(nested_ledger.work_used() > 0 && nested_ledger.work_used() < 100);
    }
}

#[cfg(test)]
mod group_identity_tests {
    use super::*;
    #[test]
    fn opaque_group_ids_preserve_existing_canonical_type_and_date_distinctions() {
        let number = BaseValue::Number { value: 2.0 };
        let string = BaseValue::String { value: "2".into() };
        let list = BaseValue::List {
            value: vec![number.clone()],
        };
        let date = BaseValue::Date {
            timestamp: 0,
            has_time: false,
        };
        let datetime = BaseValue::Date {
            timestamp: 0,
            has_time: true,
        };
        let values = [&number, &string, &list, &date, &datetime, &BaseValue::Null];
        let ids = values.into_iter().map(group_key_id).collect::<HashSet<_>>();
        assert_eq!(ids.len(), 6);
        assert!(ids.iter().all(|id| id.starts_with("base-key-v1:")));
        assert_eq!(
            group_key_id(&BaseValue::Number { value: -0.0 }),
            group_key_id(&BaseValue::Number { value: 0.0 })
        );
    }
    #[test]
    fn opaque_group_ids_reuse_recursive_canonical_object_equivalence() {
        let first = BaseValue::Object {
            value: vec![
                ("z".into(), BaseValue::Number { value: 2.0 }),
                ("a".into(), BaseValue::String { value: "2".into() }),
            ],
        };
        let mut reversed = first.clone();
        if let BaseValue::Object { value } = &mut reversed {
            value.reverse();
        }
        let first = BaseValue::List { value: vec![first] };
        let reversed = BaseValue::List {
            value: vec![reversed],
        };
        assert_eq!(group_key_id(&first), group_key_id(&reversed));
    }
}

#[cfg(test)]
mod relation_group_identity_tests {
    use super::*;
    fn link(entry: &str, revision: &str, path: &str, display: &str) -> BaseValue {
        BaseValue::Link {
            path: path.into(),
            display: Some(display.into()),
            display_value: None,
            subpath: None,
            external: false,
            target: Some(crate::RecordWitness {
                entry_id: crate::EntryId::new(entry).unwrap(),
                revision: crate::Revision::new(revision).unwrap(),
            }),
        }
    }
    #[test]
    fn canonical_relations_ignore_alias_path_and_revision_but_preserve_target_identity() {
        let original = link("author-a", "r1", "Authors/A.md", "A");
        let renamed = link("author-a", "r2", "People/Ada.md", "Ada");
        assert_eq!(canonical(&original), canonical(&renamed));
        assert_ne!(
            canonical(&original),
            canonical(&link("author-b", "r1", "Authors/A.md", "A"))
        );
        assert_eq!(
            canonical(&BaseValue::List {
                value: vec![original]
            }),
            canonical(&BaseValue::List {
                value: vec![renamed]
            })
        );
        let unresolved = BaseValue::Link {
            path: "Missing".into(),
            target: None,
            display: Some("Alias".into()),
            display_value: None,
            subpath: None,
            external: false,
        };
        let mut other_alias = unresolved.clone();
        if let BaseValue::Link { display, .. } = &mut other_alias {
            *display = None;
        }
        assert_eq!(canonical(&unresolved), canonical(&other_alias));
    }
}
