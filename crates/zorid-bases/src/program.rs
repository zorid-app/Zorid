//! Base configuration validation over the shared ordered value. YAML decoding
//! remains the document crate's responsibility; this module never writes source.
use crate::{BaseValue, ExpressionDiagnostic, PropertyValue};
/// Change whenever Base configuration compilation or language meaning changes.
pub const BASE_COMPILER_VERSION: &str = "zorid-base-view-sources-v10";

/// A view has exactly one source. Display labels never identify membership.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum BaseViewSource {
    #[default]
    Untyped,
    Collection { id: String },
}
impl BaseViewSource {
    pub fn validate(&self) -> Result<(), ExpressionDiagnostic> {
        if let Self::Collection { id } = self {
            if id.len() != 12 || !id.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()) {
                return Err(error("Collection source requires a 12-character lowercase alphanumeric identity"));
            }
        }
        Ok(())
    }
}
fn view_source(value: Option<&PropertyValue>) -> Result<BaseViewSource, ExpressionDiagnostic> {
    let Some(value) = value else { return Ok(BaseViewSource::Untyped); };
    let PropertyValue::Object(fields) = value else { return Err(error("View source must be a mapping")); };
    let source = match get(value, "kind").and_then(text) {
        Some("untyped") if fields.len() == 1 => BaseViewSource::Untyped,
        Some("collection") if fields.len() == 2 && get(value, "id").and_then(text).is_some() => BaseViewSource::Collection { id: get(value, "id").and_then(text).unwrap().into() },
        _ => return Err(error("Choose exactly one collection or untyped notes as the view source")),
    };
    source.validate()?;
    Ok(source)
}
fn named_expressions(configuration: &PropertyValue, key: &str) -> Result<Vec<(String, String)>, ExpressionDiagnostic> {
    match get(configuration, key) {
        None => Ok(Vec::new()),
        Some(PropertyValue::Object(values)) => values.iter().map(|(name, value)| text(value).map(|value| (name.clone(), value.into())).ok_or_else(|| error("Expression definitions must be strings"))).collect(),
        _ => Err(error("Expression definitions must be a named mapping")),
    }
}

#[derive(Clone, Debug)]
pub struct BaseProgram {
    pub(crate) formulas: Vec<(String, String)>,
    pub(crate) summaries: Vec<(String, String)>,
    pub(crate) summary_preview_dependency: crate::query::BaseClockDependency,
    pub(crate) filter: Option<Filter>,
    pub(crate) views: Vec<View>,
    /// Exact decoded configuration, including unknown fields. This is not a
    /// lossless source writer and must never be serialized over the raw file.
    pub configuration: PropertyValue,
}
impl BaseProgram {
    pub fn view_source(&self, index: usize) -> Option<&BaseViewSource> { self.views.get(index).map(|view| &view.source) }
    /// Explicitly sourced views own their expressions and filters. Legacy root
    /// configuration is inherited only by views without a source declaration.
    pub(crate) fn effective_view(&self, index: usize) -> Result<std::borrow::Cow<'_, Self>, ExpressionDiagnostic> {
        let view = self.views.get(index).ok_or_else(|| error("View index out of range"))?;
        if !view.explicit_source { return Ok(std::borrow::Cow::Borrowed(self)); }
        let mut selected = self.clone();
        selected.filter = None;
        selected.formulas = named_expressions(&view.configuration, "formulas")?;
        selected.summaries = named_expressions(&view.configuration, "summaryDefinitions")?;
        selected.summary_preview_dependency = crate::query::BaseClockDependency::Instant;
        Ok(std::borrow::Cow::Owned(selected))
    }
    pub fn view_names(&self) -> Vec<Option<&str>> {
        self.views
            .iter()
            .map(|view| get(&view.configuration, "name").and_then(text))
            .collect()
    }
    /// Stable optional view identity. Duplicate IDs are rejected at compile time.
    pub fn view_index_by_id(&self, id: &str) -> Option<usize> {
        self.views.iter().position(|view| get(&view.configuration, "id").and_then(text) == Some(id))
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
    /// Semantic refresh dependence for this compiled view. This is independent
    /// of the stricter optional-answer cache proof and runtime sort upgrades.
    pub fn refresh_dependency(&self, view_index: usize) -> crate::query::BaseClockDependency {
        self.views
            .get(view_index)
            .map_or(crate::query::BaseClockDependency::Instant, |view| {
                view.refresh_dependency
            })
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
    pub source: BaseViewSource,
    pub explicit_source: bool,
    pub configuration: PropertyValue,
    pub filter: Option<Filter>,
    pub order: Vec<String>,
    pub sort: Vec<Criterion>,
    pub group: Option<Criterion>,
    pub group_order: Option<Vec<BaseValue>>,
    pub limit: Option<usize>,
    pub summaries: Vec<(String, String)>,
    pub refresh_dependency: crate::query::BaseClockDependency,
}

fn filter_clock_dependency(
    filter: &Filter,
    check: &mut impl FnMut(usize) -> Option<()>,
) -> crate::query::BaseClockDependency {
    use crate::query::BaseClockDependency as Dependency;
    if check(1).is_none() {
        return Dependency::Instant;
    }
    match filter {
        Filter::Expression(source) => crate::expression::clock_dependency(source, check),
        Filter::And(children) | Filter::Or(children) | Filter::Not(children) => {
            let mut dependency = Dependency::None;
            for child in children {
                dependency = dependency.join(filter_clock_dependency(child, check));
                if dependency == Dependency::Instant {
                    break;
                }
            }
            dependency
        }
    }
}
pub(crate) fn clock_independent(
    program: &BaseProgram,
    check: &mut impl FnMut(usize) -> Option<()>,
) -> bool {
    // Scoped expression definitions are selected per invocation. Until the
    // answer-cache proof captures that selection, use fresh answers for them.
    if program.views.iter().any(|view| view.explicit_source) { return false; }
    fn filter(value: &Filter, check: &mut impl FnMut(usize) -> Option<()>) -> bool {
        if check(1).is_none() {
            return false;
        }
        match value {
            Filter::Expression(source) => crate::expression::clock_independent(source, check),
            Filter::And(v) | Filter::Or(v) | Filter::Not(v) => v.iter().all(|f| filter(f, check)),
        }
    }
    program
        .formulas
        .iter()
        .all(|(_, source)| crate::expression::clock_independent(source, check))
        && program
            .summaries
            .iter()
            .all(|(_, source)| crate::expression::clock_independent(source, check))
        && program.filter.as_ref().is_none_or(|f| filter(f, check))
        && program
            .views
            .iter()
            .all(|view| view.filter.as_ref().is_none_or(|f| filter(f, check)))
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
    let formulas: Vec<(String, String)> = match get(&configuration, "formulas") {
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
    let summaries: Vec<(String, String)> = match get(&configuration, "summaries") {
        None => Vec::new(),
        Some(PropertyValue::Object(values)) => values
            .iter()
            .map(|(name, value)| {
                text(value)
                    .map(|value| (name.clone(), value.into()))
                    .ok_or_else(|| error("Summary definitions must be strings"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(error("Summaries must be a named mapping")),
    };
    let root_filter = get(&configuration, "filters")
        .map(|value| filter(value, 0))
        .transpose()?;
    // A finite compile-time proof allowance, separate from query semantic work.
    // Exhaustion can only make scheduling conservative; it cannot reject lazy
    // formula errors or claim an unproved expression has no clock dependency.
    let mut refresh_work = 262_144usize;
    let mut refresh_check = |work: usize| {
        refresh_work = refresh_work.checked_sub(work)?;
        Some(())
    };
    let mut common_refresh = crate::query::BaseClockDependency::None;
    // Current query evaluation includes every formula in its available/needed
    // cells, including hidden formulas and transitive/dynamic formula members.
    for (_, source) in &formulas {
        common_refresh = common_refresh.join(crate::expression::clock_dependency(
            source,
            &mut refresh_check,
        ));
        if common_refresh == crate::query::BaseClockDependency::Instant {
            break;
        }
    }
    if let Some(filter) = &root_filter {
        common_refresh = common_refresh.join(filter_clock_dependency(filter, &mut refresh_check));
    }
    let mut summary_preview_dependency = crate::query::BaseClockDependency::None;
    for (_, source) in &summaries {
        summary_preview_dependency = summary_preview_dependency.join(
            crate::expression::clock_dependency(source, &mut refresh_check),
        );
    }
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
    let mut view_ids = std::collections::BTreeSet::new();
    for configuration in raw_views {
        if let Some(raw) = get(configuration, "id") {
            let id = text(raw).ok_or_else(|| error("View identity must be text"))?;
            if id.len() != 12 || !id.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()) || !view_ids.insert(id.to_string()) { return Err(error("View identity is invalid or duplicated")); }
        }
        if ["type", "name"].iter().any(|key| {
            get(configuration, key)
                .and_then(text)
                .is_none_or(str::is_empty)
        }) {
            return Err(error("Each view needs nonempty type and name"));
        }
        let source = view_source(get(configuration, "source"))?;
        let explicit_source = get(configuration, "source").is_some();
        if explicit_source {
            named_expressions(configuration, "formulas")?;
            named_expressions(configuration, "summaryDefinitions")?;
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
        let view_filter = get(configuration, "filters")
            .map(|value| filter(value, 0))
            .transpose()?;
        let view_summaries = match get(configuration, "summaries") {
            None => Vec::new(),
            Some(PropertyValue::Object(values)) => values
                .iter()
                .map(|(property, name)| {
                    text(name)
                        .map(|name| (property_id(property), name.into()))
                        .ok_or_else(|| error("View summary selections must be strings"))
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(error("View summaries must be a property-to-name mapping")),
        };
        let mut summary_refresh = common_refresh;
        for (_, name) in &view_summaries {
            if let Some((_, source)) = summaries.iter().find(|(candidate, _)| candidate == name) {
                summary_refresh = summary_refresh.join(crate::expression::clock_dependency(
                    source,
                    &mut refresh_check,
                ));
            }
        }
        let refresh_dependency = view_filter.as_ref().map_or(summary_refresh, |filter| {
            summary_refresh.join(filter_clock_dependency(filter, &mut refresh_check))
        });
        views.push(View {
            configuration: configuration.clone(),
            source, explicit_source,
            filter: view_filter,
            order,
            sort,
            group,
            group_order,
            limit,
            summaries: view_summaries,
            refresh_dependency: if explicit_source { crate::query::BaseClockDependency::Instant } else { refresh_dependency },
        });
    }
    Ok(BaseProgram {
        formulas,
        summaries,
        summary_preview_dependency,
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

#[cfg(test)]
mod refresh_dependency_tests {
    use super::*;
    use crate::query::BaseClockDependency as Dependency;

    #[test]
    fn summaries_select_view_filter_but_include_common_root_and_hidden_formulas() {
        let program = compile_base_source(
            "formulas:\n  pure: file.name.lower()\nviews:\n  - type: table\n    name: Pure\n    filters: file.name.contains('note')\n  - type: table\n    name: Day\n    filters: today() != null\n  - type: table\n    name: Instant\n    filters: now() != null\n",
        ).unwrap();
        assert_eq!(program.refresh_dependency(0), Dependency::None);
        assert_eq!(program.refresh_dependency(1), Dependency::Day);
        assert_eq!(program.refresh_dependency(2), Dependency::Instant);
        assert_eq!(program.refresh_dependency(3), Dependency::Instant);

        let hidden = compile_base_source(
            "formulas:\n  hidden: today()\n  derived: formula.hidden\n  dynamic: formula[note.selected]\nviews:\n  - type: table\n    name: Table\n    order: [file.name]\n",
        ).unwrap();
        assert_eq!(hidden.refresh_dependency(0), Dependency::Day);
        let root = compile_base_source("filters: today() != null\n").unwrap();
        assert_eq!(root.refresh_dependency(0), Dependency::Day);
    }

    #[test]
    fn lazy_formula_parse_errors_and_dynamic_calls_are_conservative_without_rejection() {
        for expression in ["(", "formula['clock']()", "date('2024-01-01').relative()"] {
            let program = compile_base(PropertyValue::Object(vec![(
                "formulas".into(),
                PropertyValue::Object(vec![(
                    "hidden".into(),
                    PropertyValue::String(expression.into()),
                )]),
            )]))
            .unwrap();
            assert_eq!(program.refresh_dependency(0), Dependency::Instant);
        }
    }
}
