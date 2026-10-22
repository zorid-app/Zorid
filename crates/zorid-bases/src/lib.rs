//! Portable, host-fed Bases expressions adapted from MDBASE's existing evaluator.
//! This crate owns neither files nor a running vault. See UPSTREAM.md for scope.
mod expression;
pub mod properties;
pub mod relations;
mod property_targets;
pub use property_targets::{CurrentRelationValues, PropertyTargetsQueryResult};
pub use graph::query_generation_property_targets_with_current;
pub use graph::{query_generation_with_properties, query_generation_property_targets};
pub use properties::PropertyDefinitions;
pub mod calendar;
mod files;
mod graph;
pub mod tasks;
pub mod types;
pub use graph::{query_generation, FilePresentationFacts, MetadataIssue, MAX_RELATIONSHIP_EDGES};
mod order;
mod preparation;
mod program;
pub use preparation::{
    query_prepared, BasePreparationCache, PreparationCacheOutcome, PreparationLookup,
    PreparedBaseGeneration, MAX_COMPILED_PROGRAMS, MAX_COMPILED_PROGRAM_BYTES,
    MAX_PREPARED_GENERATIONS, MAX_PREPARED_GENERATION_BYTES, PREPARATION_IDLE_MS,
};
mod preview;
mod query;
mod summaries;
pub use preview::{
    query_preview, BasePreviewResult, BasePreviewStatus, CommittedBasePreviewResult,
    PreviewCountsScope, MAX_PREVIEW_QUERY_OWNED_BYTES,
};
pub use program::{
    compile_base, compile_base_source, BaseCompileError, BaseProgram, BASE_COMPILER_VERSION,
};
pub use query::{
    query_base, BaseClockDependency, BaseGroup, BaseQueryResult, BaseRefreshHint, BaseRow,
    BaseSnapshot, GroupOption, QueryCounts, QueryDiagnostic, QueryOptions,
};

#[cfg(test)]
#[path = "link_identity_admission_tests.rs"]
mod link_identity_admission_tests;

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
        /// Explicit semantic fragment, including leading `#`; absent for links
        /// created from file identity, even when the filename contains `#`.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_link_subpath")]
        subpath: Option<String>,
        target: Option<RecordWitness>,
        display: Option<String>,
        #[serde(default, rename = "displayValue", skip_serializing_if = "Option::is_none")]
        display_value: Option<Box<BaseValue>>,
        external: bool,
    },
    /// Inert rich outputs. Hosts must sanitize HTML and resolve image resources.
    Html { value: String },
    Image { value: String },
    Icon { value: String },
    Error {
        code: String,
        message: String,
    },
}

fn deserialize_link_subpath<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let subpath = Option::<String>::deserialize(deserializer)?;
    if subpath.as_ref().is_some_and(|value| !value.starts_with('#')) {
        return Err(serde::de::Error::custom("Link subpath must include its leading #"));
    }
    Ok(subpath)
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
    /// Whether the caller has requested cancellation of this operation.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
    pub(crate) fn stop_reason(&self) -> Option<()> {
        self.is_cancelled().then_some(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationOptions {
    /// One captured operation clock; no ambient clock is read by the engine.
    pub clock_ms: i64,
    /// Host-captured view-load entropy; absent seeds use deterministic zero.
    pub random_seed: Option<u64>,
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
            random_seed: None,
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
/// Conservative admission for source identity copied into inferred links.
/// Count possible captured wiki strings before parsing, so short links under a long
/// owning path cannot bypass shared-context memory/work limits.
pub(crate) fn frontmatter_link_identity_bytes(
    record: &DetachedRecord,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<usize, ExpressionDiagnostic> {
    fn visit(
        value: &PropertyValue,
        path_bytes: usize,
        depth: usize,
        bytes: &mut usize,
        check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<(), ExpressionDiagnostic> {
        check(1)?;
        if depth > 128 {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Frontmatter link identity exceeds depth budget",
            ));
        }
        match value {
            PropertyValue::String(value) => {
                // This probe reads only the four delimiter bytes. Ordinary
                // scalar payloads are already admitted by input preparation;
                // charge their node, not unread contents, to this new walk.
                if !value.starts_with("[[") || !value.ends_with("]]") {
                    return Ok(());
                }
                check(1 + value.len() / 16)?;
                *bytes = bytes
                    .checked_add(value.len().saturating_add(path_bytes).saturating_add(64))
                    .filter(|bytes| *bytes <= 8 * 1024 * 1024)
                    .ok_or_else(|| {
                        ExpressionDiagnostic::new(
                            "budget",
                            "Frontmatter link identity exceeds byte budget",
                        )
                    })?;
            }
            PropertyValue::Array(values) => {
                for value in values {
                    visit(value, path_bytes, depth + 1, bytes, check)?;
                }
            }
            PropertyValue::Object(values) => {
                for (key, value) in values {
                    check(1 + key.len() / 16)?;
                    visit(value, path_bytes, depth + 1, bytes, check)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut bytes = 0;
    check(0)?;
    for (key, value) in &record.properties {
        check(1 + key.len() / 16)?;
        visit(value, record.path.len(), 0, &mut bytes, check)?;
    }
    Ok(bytes)
}
fn bind_frontmatter_link_identity(
    value: &mut expression::RuntimeValue,
    source_path: &str,
    depth: usize,
    bytes: &mut usize,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    use expression::RuntimeValue;
    check(1)?;
    if depth > 128 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Frontmatter link identity exceeds depth budget",
        ));
    }
    match value {
        RuntimeValue::Link(link) if !link.external => {
            let added = link
                .raw_destination
                .is_none()
                .then_some(link.path.len())
                .unwrap_or(0)
                .saturating_add(
                    link.source_path
                        .is_none()
                        .then_some(source_path.len())
                        .unwrap_or(0),
                );
            *bytes = bytes
                .checked_add(added)
                .filter(|bytes| *bytes <= 8 * 1024 * 1024)
                .ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "budget",
                        "Frontmatter link identity exceeds byte budget",
                    )
                })?;
            check(1 + added / 16)?;
            if link.raw_destination.is_none() {
                link.raw_destination = Some(link.path.clone());
            }
            // An absent detached note path is unknown context, not an explicit
            // ROOT constructor. Only actual files supply frontmatter origin.
            if link.source_path.is_none() && !source_path.is_empty() {
                link.source_path = Some(source_path.into());
            }
            if let Some(display) = link.display_value.as_deref_mut() {
                bind_frontmatter_link_identity(display, source_path, depth + 1, bytes, check)?;
            }
        }
        RuntimeValue::List(values) => {
            for value in values {
                bind_frontmatter_link_identity(value, source_path, depth + 1, bytes, check)?;
            }
        }
        RuntimeValue::Object(values) => {
            for value in values.values_mut() {
                bind_frontmatter_link_identity(value, source_path, depth + 1, bytes, check)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn runtime_file(
    record: &DetachedRecord,
    timezone: &expression::BasesTimezone,
) -> Result<expression::BasesFile, ExpressionDiagnostic> {
    let mut work = 0usize;
    runtime_file_checked(record, timezone, &mut |added| {
        work = work.saturating_add(added);
        if work > MAX_EXPRESSION_STEPS {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Frontmatter link identity exceeds work budget",
            ));
        }
        Ok(())
    })
}
pub(crate) fn runtime_file_checked(
    record: &DetachedRecord,
    timezone: &expression::BasesTimezone,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<expression::BasesFile, ExpressionDiagnostic> {
    check(0)?;
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
        let mut value = expression::infer_frontmatter_property(key, value, timezone);
        bind_frontmatter_link_identity(&mut value, &record.path, 0, &mut bytes, check)?;
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
    with_session_availability(source, record, options, relationships, None, run)
}

pub(crate) fn with_session_availability<T>(
    source: &str,
    record: &DetachedRecord,
    options: &EvaluationOptions,
    relationships: Option<&graph::PreparedRelationships<'_>>,
    unavailable: Option<&std::collections::HashSet<EntryId>>,
    run: impl FnOnce(&mut expression::Session<'_>) -> Result<T, ExpressionDiagnostic>,
) -> Result<T, ExpressionDiagnostic> {
    with_session_properties(
        source,
        record,
        options,
        relationships,
        unavailable,
        None,
        run,
    )
}

pub(crate) fn with_session_properties<T>(
    source: &str,
    record: &DetachedRecord,
    options: &EvaluationOptions,
    relationships: Option<&graph::PreparedRelationships<'_>>,
    unavailable: Option<&std::collections::HashSet<EntryId>>,
    property_values: Option<&relations::PropertyRelationValues>,
    run: impl FnOnce(&mut expression::Session<'_>) -> Result<T, ExpressionDiagnostic>,
) -> Result<T, ExpressionDiagnostic> {
    with_session_files(
        source,
        record,
        options,
        relationships,
        unavailable,
        property_values,
        None,
        run,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn with_session_files<T>(
    source: &str,
    record: &DetachedRecord,
    options: &EvaluationOptions,
    relationships: Option<&graph::PreparedRelationships<'_>>,
    unavailable: Option<&std::collections::HashSet<EntryId>>,
    property_values: Option<&relations::PropertyRelationValues>,
    shared_files: Option<Arc<files::BasesFiles>>,
    run: impl FnOnce(&mut expression::Session<'_>) -> Result<T, ExpressionDiagnostic>,
) -> Result<T, ExpressionDiagnostic> {
    with_session_prepared_files(
        source,
        record,
        options,
        relationships,
        unavailable,
        property_values,
        shared_files,
        None,
        run,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn with_session_prepared_files<T>(
    source: &str,
    record: &DetachedRecord,
    options: &EvaluationOptions,
    relationships: Option<&graph::PreparedRelationships<'_>>,
    unavailable: Option<&std::collections::HashSet<EntryId>>,
    property_values: Option<&relations::PropertyRelationValues>,
    shared_files: Option<Arc<files::BasesFiles>>,
    prepared_formulas: Option<Arc<expression::PreparedFormulaExpressions>>,
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
    let mut property_work = 0usize;
    if shared_files.is_none() {
        for record in std::iter::once(record).chain(options.current_record.iter()) {
            if options
                .cancellation
                .as_ref()
                .is_some_and(|cancel| cancel.is_cancelled())
            {
                return Err(ExpressionDiagnostic::new(
                    "cancelled",
                    "Evaluation cancelled",
                ));
            }
            let identity_bytes = frontmatter_link_identity_bytes(record, &mut |work| {
                property_work = property_work.saturating_add(work);
                if options
                    .cancellation
                    .as_ref()
                    .is_some_and(|cancel| cancel.is_cancelled())
                {
                    return Err(ExpressionDiagnostic::new(
                        "cancelled",
                        "Evaluation cancelled",
                    ));
                }
                if property_work > options.max_steps {
                    return Err(ExpressionDiagnostic::new(
                        "budget",
                        "Frontmatter link identity exceeds work budget",
                    ));
                }
                Ok(())
            })?;
            property_work = property_work.saturating_add(identity_bytes / 16);
            if property_work > options.max_steps {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Frontmatter link identity exceeds work budget",
                ));
            }
        }
    }
    let mut captured_file =
        |record: &DetachedRecord| -> Result<expression::BasesFile, ExpressionDiagnostic> {
            if let Some(files) = &shared_files {
                files
                    .by_path(&record.path)
                    .filter(|file| file.witness == record.witness)
                    .cloned()
                    .ok_or_else(|| {
                        ExpressionDiagnostic::new(
                            "unavailable",
                            "Session file is not hydrated at the captured revision",
                        )
                    })
            } else {
                runtime_file_checked(record, &timezone, &mut |work| {
                    property_work = property_work.saturating_add(work);
                    if options
                        .cancellation
                        .as_ref()
                        .is_some_and(|cancel| cancel.is_cancelled())
                    {
                        return Err(ExpressionDiagnostic::new(
                            "cancelled",
                            "Evaluation cancelled",
                        ));
                    }
                    if property_work > options.max_steps {
                        return Err(ExpressionDiagnostic::new(
                            "budget",
                            "Frontmatter link identity exceeds work budget",
                        ));
                    }
                    Ok(())
                })
            }
        };
    let mut projection_work = 0usize;
    let mut resolve = |file: &mut expression::BasesFile| -> Result<(), ExpressionDiagnostic> {
        if shared_files.is_none() {
            if let Some(graph) = relationships {
                graph.attach(file);
                graph.resolve_property_links(
                    file,
                    &mut |work| {
                        projection_work = projection_work.saturating_add(work);
                        if options
                            .cancellation
                            .as_ref()
                            .is_some_and(|c| c.is_cancelled())
                        {
                            return Err(ExpressionDiagnostic::new(
                                "cancelled",
                                "Evaluation cancelled",
                            ));
                        }
                        if projection_work > options.max_steps {
                            return Err(ExpressionDiagnostic::new(
                                "budget",
                                "Property link resolution exceeds work budget",
                            ));
                        }
                        Ok(())
                    },
                    &mut |_| Ok(()),
                )?;
            }
        }
        Ok(())
    };
    let mut file = captured_file(record)?;
    resolve(&mut file)?;
    let mut this_file = options
        .current_record
        .as_ref()
        .map(captured_file)
        .transpose()?;
    if let Some(file) = this_file.as_mut() {
        resolve(file)?;
    }
    if let Some(derived) = property_values {
        for file in std::iter::once(&mut file).chain(this_file.iter_mut()) {
            if let Some(row) = file
                .witness
                .as_ref()
                .and_then(|w| derived.rows().get(&w.entry_id))
            {
                property_work = property_work
                    .saturating_add(1 + encoded_size(&row.values, 8 * 1024 * 1024)? / 16)
                    .saturating_add(
                        file.witness.as_ref().map_or(0, |witness| {
                            derived.attachment_shape_bytes(&witness.entry_id)
                        }) / 16,
                    );
            }
            if shared_files.is_none() {
                derived.attach(file, &timezone, &mut |work| {
                    property_work = property_work.saturating_add(work);
                    if options
                        .cancellation
                        .as_ref()
                        .is_some_and(|cancel| cancel.is_cancelled())
                    {
                        return Err(ExpressionDiagnostic::new(
                            "cancelled",
                            "Evaluation cancelled",
                        ));
                    }
                    if property_work > options.max_steps {
                        return Err(ExpressionDiagnostic::new(
                            "budget",
                            "Derived runtime provenance exceeds work budget",
                        ));
                    }
                    Ok(())
                })?;
            }
        }
    }
    // Preview extraction failures are not absent properties. Published callers
    // keep the existing graph-owned availability behavior by passing None.
    if let Some(unavailable) = unavailable {
        file.metadata_unavailable |= record
            .witness
            .as_ref()
            .is_some_and(|w| unavailable.contains(&w.entry_id));
        if let (Some(current), Some(file)) = (options.current_record.as_ref(), this_file.as_mut()) {
            file.metadata_unavailable |= current
                .witness
                .as_ref()
                .is_some_and(|w| unavailable.contains(&w.entry_id));
        }
    }
    let context = expression::BasesEvaluationContext {
        relationships,
        note: file.properties.clone(),
        file: file.clone(),
        this_file,
        files: shared_files.unwrap_or_else(|| Arc::new(files::BasesFiles::new(vec![file]))),
        formulas: Arc::new(formulas),
        preparsed_formulas: prepared_formulas,
        now: Some(
            expression::invocation_clock(options.clock_ms)
                .ok_or_else(|| {
                    ExpressionDiagnostic::new("input", "Clock or timestamp is out of range")
                })?
                .to_rfc3339(),
        ),
        timezone,
        work_limit: Some(options.max_steps),
        cancellation: options.cancellation.clone(),
        random_seed: options.random_seed,
        ..Default::default()
    };
    let mut session = expression::Session::new(&context);
    session.charge_preparation(property_work.saturating_add(projection_work))?;
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
