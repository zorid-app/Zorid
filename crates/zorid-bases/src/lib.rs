//! Portable, host-fed Bases expressions adapted from MDBASE's existing evaluator.
//! This crate owns neither files nor a running vault. See UPSTREAM.md for scope.
mod expression;
pub mod types;
pub mod tasks;
pub mod calendar;
mod files;
mod graph;
pub use graph::{query_generation, FilePresentationFacts, MetadataIssue, MAX_RELATIONSHIP_EDGES};
mod order;
mod program;
mod query;
pub use program::{compile_base, compile_base_source, BaseCompileError, BaseProgram};
pub use query::{
    query_base, BaseGroup, BaseQueryResult, BaseRow, BaseSnapshot, GroupOption, QueryCounts,
    QueryDiagnostic, QueryOptions,
};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
pub use zorid_core::{EntryId, Revision};
pub use zorid_document::{PropertyType, PropertyValue};
pub use zorid_index::IndexSnapshotId;
pub const MAX_EXPRESSION_STEPS: usize = 100_000;
pub const MAX_BASE_SOURCE_BYTES: usize = 262_144;
pub const MAX_BASE_REQUEST_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BaseValue {
    Null,
    Boolean {
        value: bool,
    },
    Number {
        value: f64,
    },
    String {
        value: String,
    },
    List {
        value: Vec<BaseValue>,
    },
    Object {
        value: Vec<(String, BaseValue)>,
    },
    Date {
        timestamp: i64,
        #[serde(rename = "hasTime")]
        has_time: bool,
    },
    Duration {
        years: f64,
        months: f64,
        weeks: f64,
        days: f64,
        hours: f64,
        minutes: f64,
        seconds: f64,
        milliseconds: f64,
    },
    File {
        path: String,
    },
    Link {
        path: String,
        target: Option<RecordWitness>,
        display: Option<String>,
        external: bool,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExpressionDiagnostic {
    pub code: String,
    pub message: String,
}
impl ExpressionDiagnostic {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for ExpressionDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for ExpressionDiagnostic {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationResult {
    pub value: BaseValue,
    pub steps_used: usize,
}

/// Host-owned facts from one coherent document-index generation. Property order
/// is recursive through the shared document value, including nested collisions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordWitness {
    pub entry_id: EntryId,
    pub revision: Revision,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DetachedRecord {
    pub witness: Option<RecordWitness>,
    pub path: String,
    #[serde(default)]
    pub properties: Vec<(String, PropertyValue)>,
    /// Exact metadata type hints for existing source property keys. Ordered
    /// values stay intact; date conversion uses the invocation timezone only.
    #[serde(default)]
    pub property_types: Vec<(String, PropertyType)>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub size: Option<u64>,
    pub ctime_ms: Option<i64>,
    pub mtime_ms: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct OperationCancellation(Arc<AtomicBool>);
impl OperationCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub(crate) fn stop_reason(&self) -> Option<()> {
        self.0.load(Ordering::Relaxed).then_some(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationOptions {
    /// One captured operation clock; no ambient clock is read by the engine.
    pub clock_ms: i64,
    /// UTC is the default. Local aliases are deliberately rejected.
    pub timezone: String,
    pub max_steps: usize,
    pub formulas: Vec<(String, String)>,
    pub current_record: Option<DetachedRecord>,
    #[serde(skip)]
    pub cancellation: Option<OperationCancellation>,
}
impl Default for EvaluationOptions {
    fn default() -> Self {
        Self {
            clock_ms: 0,
            timezone: "UTC".into(),
            max_steps: 100_000,
            formulas: Vec::new(),
            current_record: None,
            cancellation: None,
        }
    }
}

/// Count serialized bytes with early rejection, without allocating an oversized buffer.
pub(crate) fn encoded_size<T: Serialize>(
    value: &T,
    maximum: usize,
) -> Result<usize, ExpressionDiagnostic> {
    struct Counter {
        bytes: usize,
        maximum: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self
                .bytes
                .checked_add(bytes.len())
                .filter(|n| *n <= self.maximum)
                .ok_or_else(|| std::io::Error::other("Base encoded byte budget exceeded"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0, maximum };
    serde_json::to_writer(&mut counter, value)
        .map_err(|_| ExpressionDiagnostic::new("budget", "Base encoded byte budget exceeded"))?;
    Ok(counter.bytes)
}
fn instant(millis: i64) -> Result<String, ExpressionDiagnostic> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .map(|date| date.to_rfc3339())
        .ok_or_else(|| ExpressionDiagnostic::new("input", "Clock or timestamp is out of range"))
}

fn runtime_value(
    value: &PropertyValue,
    depth: usize,
    bytes: &mut usize,
) -> Result<expression::RuntimeValue, ExpressionDiagnostic> {
    use expression::RuntimeValue as R;
    if depth > 128 || *bytes > 8 * 1024 * 1024 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Property input exceeds depth/byte budget",
        ));
    }
    *bytes = bytes.saturating_add(16);
    Ok(match value {
        PropertyValue::Null => R::Null,
        PropertyValue::Bool(value) => R::Bool(*value),
        PropertyValue::Number(value) => R::Number(
            value
                .as_f64()
                .ok_or_else(|| ExpressionDiagnostic::new("input", "Invalid numeric property"))?,
        ),
        PropertyValue::String(value) => {
            *bytes = bytes.saturating_add(value.len());
            R::String(value.clone())
        }
        PropertyValue::Array(values) => R::List(
            values
                .iter()
                .map(|value| runtime_value(value, depth + 1, bytes))
                .collect::<Result<_, _>>()?,
        ),
        PropertyValue::Object(values) => {
            let mut result = IndexMap::new();
            for (key, value) in values {
                *bytes = bytes.saturating_add(key.len());
                if result.contains_key(key) {
                    return Err(ExpressionDiagnostic::new(
                        "input",
                        "Duplicate exact property key",
                    ));
                }
                result.insert(key.clone(), runtime_value(value, depth + 1, bytes)?);
            }
            R::Object(result)
        }
    })
}
fn runtime_file(
    record: &DetachedRecord,
    timezone: &expression::BasesTimezone,
) -> Result<expression::BasesFile, ExpressionDiagnostic> {
    if (record.path.is_empty() && record.witness.is_some())
        || record.path.starts_with('/')
        || record.path.contains('\\')
        || (!record.path.is_empty()
            && record
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err(ExpressionDiagnostic::new(
            "input",
            "Expected a normalized vault-relative path",
        ));
    }
    let fullname = record.path.rsplit('/').next().unwrap_or_default();
    let (basename, extension) = fullname.rsplit_once('.').unwrap_or((fullname, ""));
    let mut bytes = record.path.len().saturating_add(
        record
            .tags
            .iter()
            .map(|tag| tag.len().saturating_add(16))
            .sum::<usize>(),
    );
    if bytes > 8 * 1024 * 1024 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "File facts exceed byte budget",
        ));
    }
    let mut hints = std::collections::HashMap::new();
    for (name, hint) in &record.property_types {
        bytes = bytes.saturating_add(name.len() + 16);
        if bytes > 8 * 1024 * 1024 {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Property hints exceed byte budget",
            ));
        }
        if hints.insert(name.as_str(), hint).is_some() {
            return Err(ExpressionDiagnostic::new(
                "input",
                "Duplicate property type hint",
            ));
        }
    }
    let mut properties = IndexMap::new();
    for (key, value) in &record.properties {
        bytes += key.len();
        if properties.contains_key(key) {
            return Err(ExpressionDiagnostic::new(
                "input",
                "Duplicate exact property key",
            ));
        }
        let value = runtime_value(value, 0, &mut bytes)?;
        let value = if let Some(hint) = hints.get(key.as_str()) {
            expression::apply_property_type(value, hint, timezone)
        } else {
            value
        };
        properties.insert(key.clone(), value);
    }
    if hints.keys().any(|name| !properties.contains_key(*name)) {
        return Err(ExpressionDiagnostic::new(
            "input",
            "Property type hints require existing exact keys",
        ));
    }
    if bytes > 8 * 1024 * 1024 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Property input exceeds byte budget",
        ));
    }
    Ok(expression::BasesFile {
        witness: record.witness.clone(),
        path: record.path.clone(),
        name: if extension == "md" {
            basename.into()
        } else {
            fullname.into()
        },
        basename: basename.into(),
        folder: record
            .path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("/")
            .into(),
        extension: extension.into(),
        size: record.size,
        properties,
        tags: record.tags.clone(),
        ctime: record.ctime_ms.map(instant).transpose()?,
        mtime: record.mtime_ms.map(instant).transpose()?,
        ..Default::default()
    })
}

pub(crate) fn with_session<T>(
    source: &str,
    record: &DetachedRecord,
    options: &EvaluationOptions,
    relationships: Option<&graph::PreparedRelationships<'_>>,
    run: impl FnOnce(&mut expression::Session<'_>) -> Result<T, ExpressionDiagnostic>,
) -> Result<T, ExpressionDiagnostic> {
    if options.max_steps == 0 || options.max_steps > MAX_EXPRESSION_STEPS {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Expression step ceiling exceeds supported maximum",
        ));
    }
    if options.formulas.len() > 1024 {
        return Err(ExpressionDiagnostic::new("budget", "Too many formulas"));
    }
    let mut formulas = IndexMap::new();
    let mut bytes = source.len();
    for (name, source) in &options.formulas {
        bytes = bytes.saturating_add(name.len() + source.len());
        if bytes > 262_144 {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Formula program exceeds byte budget",
            ));
        }
        if formulas.insert(name.clone(), source.clone()).is_some() {
            return Err(ExpressionDiagnostic::new("input", "Duplicate formula name"));
        }
    }
    let timezone = expression::BasesTimezone::from_setting(Some(&options.timezone))
        .map_err(|message| ExpressionDiagnostic::new("input", message))?;
    let mut file = runtime_file(record, &timezone)?;
    if let Some(graph) = relationships {
        graph.attach(&mut file);
    }
    let mut this_file = options
        .current_record
        .as_ref()
        .map(|record| runtime_file(record, &timezone))
        .transpose()?;
    if let (Some(graph), Some(file)) = (relationships, this_file.as_mut()) {
        graph.attach(file);
    }
    let context = expression::BasesEvaluationContext {
        relationships,
        note: file.properties.clone(),
        file: file.clone(),
        this_file,
        files: Arc::new(files::BasesFiles::new(vec![file])),
        formulas: Arc::new(formulas),
        now: Some(instant(options.clock_ms)?),
        timezone,
        work_limit: Some(options.max_steps),
        cancellation: options.cancellation.clone(),
        ..Default::default()
    };
    let mut session = expression::Session::new(&context);
    run(&mut session)
}

pub fn evaluate_expression(
    source: &str,
    record: &DetachedRecord,
    options: &EvaluationOptions,
) -> Result<EvaluationResult, ExpressionDiagnostic> {
    with_session(source, record, options, None, |session| {
        let value = session.evaluate(source)?;
        Ok(EvaluationResult {
            value,
            steps_used: session.steps_used(),
        })
    })
}

pub use query::{
    MAX_QUERY_GROUPS, MAX_QUERY_OUTPUT_BYTES, MAX_QUERY_ROWS, MAX_QUERY_SCANNED, MAX_QUERY_STEPS,
};
