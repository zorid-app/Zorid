//! Shared summaries over the exact displayed result, independent of DOM paging.
//! Built-ins use the same bounded expression interpreter as custom summaries.
use crate::{
    expression, BaseProgram, BaseValue, EvaluationOptions, EvaluationResult, ExpressionDiagnostic,
};

pub(crate) fn evaluate(
    program: &BaseProgram,
    name: &str,
    values: &[&BaseValue],
    options: &EvaluationOptions,
    relationships: Option<&crate::graph::PreparedRelationships<'_>>,
    file: impl FnMut(&str) -> Result<expression::BasesFile, ExpressionDiagnostic>,
) -> Result<EvaluationResult, ExpressionDiagnostic> {
    // Custom definitions override built-ins by exact name, even when the list
    // is empty or every selected property is null.
    let source = program
        .summaries
        .iter()
        .find(|(candidate, _)| candidate == name)
        .map(|(_, source)| source.as_str())
        .or_else(|| {
            builtin(
                name,
                values
                    .iter()
                    .copied()
                    .find(|value| !matches!(value, BaseValue::Null)),
            )
        });
    match source {
        Some(source) => expression::evaluate_summary(source, values, options, relationships, file),
        None => Ok(EvaluationResult {
            value: BaseValue::Null,
            steps_used: 0,
        }),
    }
}

fn builtin(name: &str, first: Option<&BaseValue>) -> Option<&'static str> {
    // The reference dispatches through the first non-null value's class. No
    // class exists for all-null/empty columns, so only custom summaries run.
    let first = first?;
    match (first, name) {
        (BaseValue::Number { .. }, "Average") => Some("values.mean().round(2)"),
        (BaseValue::Number { .. }, "Min") => Some("values.min()"),
        (BaseValue::Number { .. }, "Max") => Some("values.max()"),
        (BaseValue::Number { .. }, "Sum") => Some("values.sum().round(2)"),
        (BaseValue::Number { .. }, "Range") => Some("values.max() - values.min()"),
        (BaseValue::Number { .. }, "Median") => Some("values.median()"),
        (BaseValue::Number { .. }, "Stddev") => Some("values.stddev().round(2)"),
        (BaseValue::Date { .. }, "Earliest") => Some("values.earliest()"),
        (BaseValue::Date { .. }, "Latest") => Some("values.latest()"),
        (BaseValue::Date { .. }, "Range") => Some("values.latest() - values.earliest()"),
        (BaseValue::Boolean { .. }, "Checked") => Some("values.filter(value == true).length"),
        (BaseValue::Boolean { .. }, "Unchecked") => Some("values.filter(value == false).length"),
        (_, "Empty") => Some("values.filter(value.isType('null')).length"),
        (_, "Filled") => Some("values.filter(!value.isType('null')).length"),
        (_, "Unique") => Some("values.unique().length"),
        _ => None,
    }
}

/// Picker candidates follow the same class dispatch as selected summaries.
/// Custom definitions are available for every value class and override names.
pub(crate) fn names(program: &BaseProgram, first: Option<&BaseValue>) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(first) = first {
        names.extend(["Empty", "Filled", "Unique"].map(String::from));
        names.extend(
            match first {
                BaseValue::Number { .. } => {
                    vec!["Average", "Min", "Max", "Sum", "Range", "Median", "Stddev"]
                }
                BaseValue::Date { .. } => vec!["Earliest", "Latest", "Range"],
                BaseValue::Boolean { .. } => vec!["Checked", "Unchecked"],
                _ => Vec::new(),
            }
            .into_iter()
            .map(String::from),
        );
    }
    for (name, _) in &program.summaries {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    names
}
