//! File-authoritative note types. Hosts parse bounded YAML with the existing YAML
//! adapter and supply its ordered PropertyValue AST; this module does no IO/YAML.
use crate::{ExpressionDiagnostic, PropertyValue, RecordWitness};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zorid_core::{EntryId, VaultPath};

pub const MAX_TYPE_SOURCES: usize = 128;
pub const MAX_TYPE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeSource {
    pub witness: RecordWitness,
    pub path: String,
    pub configuration: PropertyValue,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusCategory {
    NotStarted,
    Working,
    Done,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypeOption {
    pub id: String,
    pub label: String,
    pub category: Option<StatusCategory>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TypeDatatype {
    Text,
    Date,
    Status,
    Select,
    MultiSelect,
    Number,
    Checkbox,
    Datetime,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TypeProperty {
    pub id: String,
    pub key: String,
    pub label: String,
    pub datatype: TypeDatatype,
    #[serde(default)]
    pub options: Vec<TypeOption>,
    #[serde(default, deserialize_with = "present_default")]
    pub default: Option<PropertyValue>,
}
fn present_default<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<PropertyValue>, D::Error> {
    PropertyValue::deserialize(d).map(Some)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCapability {
    pub status: String,
    pub planned_day: Option<String>,
    pub deadline: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TypeCapabilities {
    pub task: Option<TaskCapability>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoteType {
    pub version: u32,
    pub id: String,
    pub label: String,
    pub properties: Vec<TypeProperty>,
    #[serde(default)]
    pub capabilities: TypeCapabilities,
}
impl NoteType {
    pub fn property(&self, id: &str) -> Option<&TypeProperty> {
        self.properties.iter().find(|p| p.id == id)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeDiagnostic {
    pub witness: RecordWitness,
    pub code: String,
}
/// Invalid/unknown source data remains available; only valid, unique definitions
/// enter the capability registry. No label, path or special name grants taskhood.
#[derive(Clone, Debug)]
pub struct TypeRegistry {
    sources: Vec<TypeSource>,
    definitions: BTreeMap<String, NoteType>,
    diagnostics: Vec<TypeDiagnostic>,
}
impl TypeRegistry {
    pub fn sources(&self) -> &[TypeSource] {
        &self.sources
    }
    pub fn diagnostics(&self) -> &[TypeDiagnostic] {
        &self.diagnostics
    }
    pub fn get(&self, id: &str) -> Option<&NoteType> {
        self.definitions.get(id)
    }
    pub fn iter(&self) -> impl Iterator<Item = &NoteType> {
        self.definitions.values()
    }
}
fn valid_id(s: &str) -> bool {
    EntryId::new(s).is_ok()
}
fn label(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}
pub(crate) fn date_only(s: &str) -> bool {
    s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s.bytes()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit())
        && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}
fn validate_default(p: &TypeProperty, value: &PropertyValue) -> bool {
    match (&p.datatype, value) {
        (_, PropertyValue::Null) => p.datatype != TypeDatatype::Status,
        (TypeDatatype::Text, PropertyValue::String(_)) => true,
        (TypeDatatype::Date, PropertyValue::String(s)) => date_only(s),
        (TypeDatatype::Datetime, PropertyValue::String(s)) => {
            chrono::DateTime::parse_from_rfc3339(s).is_ok()
        }
        (TypeDatatype::Number, PropertyValue::Number(_))
        | (TypeDatatype::Checkbox, PropertyValue::Bool(_)) => true,
        (TypeDatatype::Status | TypeDatatype::Select, PropertyValue::String(s)) => {
            p.options.iter().any(|o| &o.id == s)
        }
        (TypeDatatype::MultiSelect, PropertyValue::Array(a)) => {
            let mut seen = BTreeSet::new();
            a.iter().all(|v| {
                v.as_str()
                    .is_some_and(|s| seen.insert(s) && p.options.iter().any(|o| o.id == s))
            })
        }
        _ => false,
    }
}
fn validate_type(t: &NoteType) -> Result<(), &'static str> {
    if t.version != 1 {
        return Err("unsupported_type_version");
    }
    if !valid_id(&t.id) || !label(&t.label) || t.properties.len() > 64 {
        return Err("invalid_type");
    }
    let (mut ids, mut keys) = (BTreeSet::new(), BTreeSet::new());
    for p in &t.properties {
        if !valid_id(&p.id)
            || !ids.insert(&p.id)
            || !label(&p.key)
            || p.key == "type"
            || !keys.insert(&p.key)
            || !label(&p.label)
            || p.options.len() > 128
        {
            return Err("invalid_property");
        }
        let mut options = BTreeSet::new();
        for o in &p.options {
            if !valid_id(&o.id)
                || !label(&o.label)
                || !options.insert(&o.id)
                || (p.datatype == TypeDatatype::Status && o.category.is_none())
                || (p.datatype != TypeDatatype::Status && o.category.is_some())
            {
                return Err("invalid_option");
            }
        }
        if matches!(
            p.datatype,
            TypeDatatype::Status | TypeDatatype::Select | TypeDatatype::MultiSelect
        ) {
            if p.options.is_empty() {
                return Err("missing_options");
            }
        } else if !p.options.is_empty() {
            return Err("unexpected_options");
        }
        if p.default.as_ref().is_some_and(|v| !validate_default(p, v)) {
            return Err("invalid_default");
        }
    }
    if let Some(task) = &t.capabilities.task {
        let status = t.property(&task.status).ok_or("invalid_task_mapping")?;
        if status.datatype != TypeDatatype::Status || status.default.is_none() {
            return Err("invalid_task_status");
        }
        let mut mapped = BTreeSet::from([task.status.as_str()]);
        for id in [&task.planned_day, &task.deadline].into_iter().flatten() {
            if !mapped.insert(id)
                || t.property(id)
                    .is_none_or(|p| p.datatype != TypeDatatype::Date)
            {
                return Err("invalid_task_mapping");
            }
        }
    }
    Ok(())
}
/// Host must bound bytes before deserialization too. Unknown keys are retained in
/// sources while typed interpretation ignores them. Duplicate AST keys fail.
pub fn compile_types(sources: Vec<TypeSource>) -> Result<TypeRegistry, ExpressionDiagnostic> {
    if sources.len() > MAX_TYPE_SOURCES {
        return Err(ExpressionDiagnostic::new("budget", "Too many type files"));
    }
    // Bound host-fed/programmatically constructed ASTs before recursive encoding.
    for source in &sources {
        let mut pending = vec![(&source.configuration, 0usize)];
        let mut nodes = 0usize;
        while let Some((value, depth)) = pending.pop() {
            nodes += 1;
            if depth > 32 || nodes > 8192 {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Type AST exceeds structural limits",
                ));
            }
            match value {
                PropertyValue::Array(values) => {
                    if values.len() + pending.len() + nodes > 8192 {
                        return Err(ExpressionDiagnostic::new(
                            "budget",
                            "Type AST exceeds structural limits",
                        ));
                    }
                    pending.extend(values.iter().map(|v| (v, depth + 1)));
                }
                PropertyValue::Object(values) => {
                    if values.len() + pending.len() + nodes > 8192 {
                        return Err(ExpressionDiagnostic::new(
                            "budget",
                            "Type AST exceeds structural limits",
                        ));
                    }
                    pending.extend(values.iter().map(|(_, v)| (v, depth + 1)));
                }
                _ => {}
            }
        }
    }
    crate::encoded_size(&sources, MAX_TYPE_BYTES)?;
    let mut registry = TypeRegistry {
        sources,
        definitions: BTreeMap::new(),
        diagnostics: Vec::new(),
    };
    let mut claimed_ids: BTreeMap<String, usize> = BTreeMap::new();
    for source in &registry.sources {
        if let Some(id) = source
            .configuration
            .get("id")
            .and_then(PropertyValue::as_str)
        {
            *claimed_ids.entry(id.into()).or_default() += 1;
        }
    }
    let mut entries = BTreeSet::new();
    for source in &registry.sources {
        if !entries.insert(source.witness.entry_id.clone()) {
            return Err(ExpressionDiagnostic::new(
                "type-source",
                "Duplicate type source identity",
            ));
        }
        let result = (|| {
            if source
                .configuration
                .get("id")
                .and_then(PropertyValue::as_str)
                .is_some_and(|id| claimed_ids.get(id).is_some_and(|n| *n > 1))
            {
                return Err("duplicate_type_id");
            }
            VaultPath::new(source.path.clone()).map_err(|_| "invalid_type_path")?;
            if !source.path.ends_with(".yaml") && !source.path.ends_with(".yml") {
                return Err("invalid_type_path");
            }
            source
                .configuration
                .validate_json_numbers()
                .map_err(|_| "invalid_type_ast")?;
            // Round-trip through PropertyValue first: duplicate keys/depth are rejected
            // by its existing bounded decoder, not silently collapsed by serde Value.
            let bytes =
                serde_json::to_vec(&source.configuration).map_err(|_| "invalid_type_ast")?;
            let _: PropertyValue =
                serde_json::from_slice(&bytes).map_err(|_| "invalid_type_ast")?;
            let definition: NoteType =
                serde_json::from_slice(&bytes).map_err(|_| "invalid_type_shape")?;
            validate_type(&definition)?;
            Ok(definition)
        })();
        match result {
            Ok(t) => {
                registry.definitions.insert(t.id.clone(), t);
            }
            Err(code) => registry.diagnostics.push(TypeDiagnostic {
                witness: source.witness.clone(),
                code: code.into(),
            }),
        }
    }
    Ok(registry)
}
/// New captures persist defaults rather than relying on query-time display fallback.
pub fn task_capture_defaults(
    registry: &TypeRegistry,
    type_id: &str,
) -> Result<Vec<(String, PropertyValue)>, ExpressionDiagnostic> {
    let t = registry
        .get(type_id)
        .filter(|t| t.capabilities.task.is_some())
        .ok_or_else(|| ExpressionDiagnostic::new("task-type", "Task type is unavailable"))?;
    let mut values = vec![("type".into(), PropertyValue::String(t.id.clone()))];
    values.extend(
        t.properties
            .iter()
            .filter_map(|p| p.default.clone().map(|v| (p.key.clone(), v))),
    );
    Ok(values)
}
