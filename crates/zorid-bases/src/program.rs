//! Base configuration validation over the shared ordered value. YAML decoding
//! remains the document crate's responsibility; this module never writes source.
use crate::{BaseValue, ExpressionDiagnostic, PropertyValue};
/// Change whenever Base configuration compilation or language meaning changes.
pub const BASE_COMPILER_VERSION: &str = "zorid-base-yaml-expression-v1";


#[derive(Clone, Debug)]
pub struct BaseProgram {
    pub(crate) formulas: Vec<(String, String)>,
    pub(crate) filter: Option<Filter>,
    pub(crate) views: Vec<View>,
    /// Exact decoded configuration, including unknown fields. This is not a
    /// lossless source writer and must never be serialized over the raw file.
    pub configuration: PropertyValue,
}
impl BaseProgram {
    pub fn view_names(&self) -> Vec<Option<&str>> {
        self.views
            .iter()
            .map(|view| get(&view.configuration, "name").and_then(text))
            .collect()
    }
    /// Exact names only. Duplicate names are ambiguous and return None.
    pub fn view_index_by_name(&self, name: &str) -> Option<usize> {
        let mut matches = self
            .views
            .iter()
            .enumerate()
            .filter(|(_, view)| get(&view.configuration, "name").and_then(text) == Some(name));
        let index = matches.next()?.0;
        matches.next().is_none().then_some(index)
    }
}
#[derive(Clone, Debug)]
pub(crate) enum Filter {
    Expression(String),
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Vec<Filter>),
}
#[derive(Clone, Debug)]
pub(crate) struct Criterion {
    pub property: String,
    pub descending: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct View {
    pub configuration: PropertyValue,
    pub filter: Option<Filter>,
    pub order: Vec<String>,
    pub sort: Vec<Criterion>,
    pub group: Option<Criterion>,
    pub group_order: Option<Vec<BaseValue>>,
    pub limit: Option<usize>,
}
fn error(message: &str) -> ExpressionDiagnostic {
    ExpressionDiagnostic::new("configuration", message)
}
pub(crate) fn get<'a>(value: &'a PropertyValue, key: &str) -> Option<&'a PropertyValue> {
    if let PropertyValue::Object(values) = value {
        values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    } else {
        None
    }
}
pub(crate) fn text(value: &PropertyValue) -> Option<&str> {
    if let PropertyValue::String(value) = value {
        Some(value)
    } else {
        None
    }
}
pub(crate) fn property_id(value: &str) -> String {
    if value == "file" {
        "file.file".into()
    } else if value.starts_with("file.")
        || value.starts_with("note.")
        || value.starts_with("formula.")
    {
        value.into()
    } else {
        format!("note.{value}")
    }
}
fn filter(value: &PropertyValue, depth: usize) -> Result<Filter, ExpressionDiagnostic> {
    if depth > 128 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Filter nesting exceeds 128",
        ));
    }
    if let PropertyValue::String(value) = value {
        return Ok(Filter::Expression(value.clone()));
    }
    let PropertyValue::Object(entries) = value else {
        return Err(error("Filter must be text or one logical mapping"));
    };
    if entries.len() != 1 {
        return Err(error("Filter must contain exactly one and/or/not list"));
    }
    let (name, value) = &entries[0];
    let PropertyValue::Array(values) = value else {
        return Err(error("Logical filters require arrays"));
    };
    let values = values
        .iter()
        .map(|value| filter(value, depth + 1))
        .collect::<Result<_, _>>()?;
    match name.as_str() {
        "and" => Ok(Filter::And(values)),
        "or" => Ok(Filter::Or(values)),
        "not" => Ok(Filter::Not(values)),
        _ => Err(error("Unknown filter conjunction")),
    }
}
fn criterion(value: &PropertyValue) -> Option<Criterion> {
    let property = get(value, "column")
        .or_else(|| get(value, "property"))
        .and_then(text)?;
    let direction = get(value, "direction").and_then(text)?;
    if property.is_empty() || !["ASC", "DESC"].contains(&direction) {
        return None;
    }
    Some(Criterion {
        property: property_id(property),
        descending: direction == "DESC",
    })
}
pub(crate) fn from_property(value: &PropertyValue) -> BaseValue {
    match value {
        PropertyValue::Null => BaseValue::Null,
        PropertyValue::Bool(value) => BaseValue::Boolean { value: *value },
        PropertyValue::Number(value) => BaseValue::Number {
            value: value.as_f64().unwrap_or(f64::NAN),
        },
        PropertyValue::String(value) => BaseValue::String {
            value: value.clone(),
        },
        PropertyValue::Array(values) => BaseValue::List {
            value: values.iter().map(from_property).collect(),
        },
        PropertyValue::Object(values) => BaseValue::Object {
            value: values
                .iter()
                .map(|(key, value)| (key.clone(), from_property(value)))
                .collect(),
        },
    }
}
/// Validate decoded Base configuration. Formula parse errors remain expression
/// diagnostics when used, so one broken cell does not hide every valid row.
pub fn compile_base(configuration: PropertyValue) -> Result<BaseProgram, ExpressionDiagnostic> {
    let PropertyValue::Object(_) = configuration else {
        return Err(error("A Base document must be a YAML mapping"));
    };
    let mut work = vec![(&configuration, 0usize)];
    let mut bytes = 0usize;
    while let Some((value, depth)) = work.pop() {
        if depth > 128 {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Base configuration nesting exceeds 128",
            ));
        }
        bytes = bytes.saturating_add(16);
        match value {
            PropertyValue::String(value) => bytes = bytes.saturating_add(value.len()),
            PropertyValue::Array(values) => {
                work.extend(values.iter().map(|value| (value, depth + 1)))
            }
            PropertyValue::Object(values) => {
                for (key, value) in values {
                    bytes = bytes.saturating_add(key.len());
                    work.push((value, depth + 1));
                }
            }
            _ => {}
        }
        if bytes > 262_144 {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Base configuration exceeds byte budget",
            ));
        }
    }
    configuration
        .validate_json_numbers()
        .map_err(|message| error(message))?;
    let formulas = match get(&configuration, "formulas") {
        None => Vec::new(),
        Some(PropertyValue::Object(values)) => values
            .iter()
            .map(|(name, value)| {
                text(value)
                    .map(|value| (name.clone(), value.into()))
                    .ok_or_else(|| error("Formula definitions must be strings"))
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(error("Formulas must be a named mapping")),
    };
    let root_filter = get(&configuration, "filters")
        .map(|value| filter(value, 0))
        .transpose()?;
    let defaults = vec![PropertyValue::Object(vec![
        ("type".into(), PropertyValue::String("table".into())),
        ("name".into(), PropertyValue::String("Table".into())),
    ])];
    let raw_views = match get(&configuration, "views") {
        None => &defaults,
        Some(PropertyValue::Array(values)) if values.is_empty() => &defaults,
        Some(PropertyValue::Array(values)) => values,
        _ => return Err(error("Base views must be an array")),
    };
    let mut views = Vec::new();
    for configuration in raw_views {
        if ["type", "name"].iter().any(|key| {
            get(configuration, key)
                .and_then(text)
                .is_none_or(str::is_empty)
        }) {
            return Err(error("Each view needs nonempty type and name"));
        }
        let order = match get(configuration, "order") {
            None => vec!["file.name".into()],
            Some(PropertyValue::Array(values)) => values
                .iter()
                .map(|value| {
                    text(value)
                        .map(property_id)
                        .ok_or_else(|| error("View order must contain property strings"))
                })
                .collect::<Result<_, _>>()?,
            _ => return Err(error("View order must be a list")),
        };
        let sort = match get(configuration, "sort") {
            Some(PropertyValue::Array(values)) => values.iter().filter_map(criterion).collect(),
            _ => Vec::new(),
        };
        let group = match get(configuration, "groupBy") {
            Some(value) => {
                if get(value, "property").is_none() || get(value, "direction").is_none() {
                    return Err(error("groupBy requires property and direction"));
                }
                criterion(value)
            }
            None => None,
        };
        let group_order = if group.is_some() {
            match get(configuration, "groupOrder") {
                Some(PropertyValue::Array(values)) => {
                    Some(values.iter().map(from_property).collect())
                }
                _ => None,
            }
        } else {
            None
        };
        let limit = match get(configuration, "limit") {
            Some(PropertyValue::Number(value)) => value
                .as_f64()
                .filter(|value| *value > 0.0)
                .map(|value| value.trunc() as usize),
            _ => None,
        };
        views.push(View {
            configuration: configuration.clone(),
            filter: get(configuration, "filters")
                .map(|value| filter(value, 0))
                .transpose()?,
            order,
            sort,
            group,
            group_order,
            limit,
        });
    }
    Ok(BaseProgram {
        formulas,
        filter: root_filter,
        views,
        configuration,
    })
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "phase", content = "diagnostic", rename_all = "snake_case")]
pub enum BaseCompileError {
    Yaml(zorid_document::YamlDiagnostic),
    Semantic(ExpressionDiagnostic),
}
/// Decode exact `.base` source using the same bounded Saphyr mapping decoder as
/// Markdown frontmatter. Source bytes are never normalized or rewritten.
pub fn compile_base_source(source: &str) -> Result<BaseProgram, BaseCompileError> {
    if source.len() > 262_144 {
        return Err(BaseCompileError::Semantic(ExpressionDiagnostic::new(
            "budget",
            "Base source exceeds 262144 bytes",
        )));
    }
    let value = zorid_document::parse_yaml_mapping(source).map_err(BaseCompileError::Yaml)?;
    compile_base(value).map_err(BaseCompileError::Semantic)
}
