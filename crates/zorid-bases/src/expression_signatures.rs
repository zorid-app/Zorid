//! Public built-in call contracts from the Obsidian 1.14.4 registration catalogue.
//! This is API metadata, independently expressed for the portable evaluator.
use super::{canonical_function_name, string_data, RuntimeValue};

#[derive(Clone, Copy)]
enum Kind {
    Any,
    NonNull,
    String,
    Number,
    Boolean,
    Regex,
    Date,
    File,
    Link,
}
#[derive(Clone, Copy)]
struct Parameter {
    name: &'static str,
    kinds: &'static [Kind],
    optional: bool,
    variadic: bool,
}
const fn required(name: &'static str, kinds: &'static [Kind]) -> Parameter {
    Parameter {
        name,
        kinds,
        optional: false,
        variadic: false,
    }
}
const fn optional(name: &'static str, kinds: &'static [Kind]) -> Parameter {
    Parameter {
        name,
        kinds,
        optional: true,
        variadic: false,
    }
}
const fn variadic(name: &'static str, kinds: &'static [Kind]) -> Parameter {
    Parameter {
        name,
        kinds,
        optional: false,
        variadic: true,
    }
}
macro_rules! params {
    ($($parameter:expr),* $(,)?) => {{
        const PARAMETERS: &[Parameter] = &[$($parameter),*];
        PARAMETERS
    }};
}
#[derive(Clone, Copy)]
pub(super) struct Signature(&'static [Parameter]);
pub(super) enum Argument {
    Value(RuntimeValue),
    Omitted,
    Null,
}
impl Kind {
    fn accepts(self, value: &RuntimeValue) -> bool {
        match self {
            Self::Any => true,
            Self::NonNull => !matches!(
                value,
                RuntimeValue::Null | RuntimeValue::Error(_) | RuntimeValue::ErrorValue(_)
            ),
            Self::String => string_data(value).is_some(),
            Self::Number => matches!(value, RuntimeValue::Number(_)),
            Self::Boolean => matches!(value, RuntimeValue::Bool(_)),
            Self::Regex => matches!(value, RuntimeValue::Regex(_, _)),
            Self::Date => matches!(value, RuntimeValue::Date(_)),
            Self::File => matches!(value, RuntimeValue::File(_)),
            Self::Link => matches!(value, RuntimeValue::Link(link) if !link.external),
        }
    }
}
impl Signature {
    fn parameter(self, index: usize) -> Option<Parameter> {
        self.0.get(index).copied().or_else(|| {
            self.0
                .last()
                .copied()
                .filter(|parameter| parameter.variadic)
        })
    }
    /// Invoked AFTER evaluating this one supplied argument, matching the reference
    /// validator's error ordering. Do not preflight ordinary call arity.
    pub(super) fn argument(
        self,
        name: &str,
        index: usize,
        value: RuntimeValue,
    ) -> Result<Argument, RuntimeValue> {
        let Some(parameter) = self.parameter(index) else {
            return Err(arity_error(name, "too many"));
        };
        if parameter.optional && matches!(value, RuntimeValue::Null) {
            return Ok(Argument::Omitted);
        }
        if !parameter.kinds.iter().any(|kind| kind.accepts(&value)) {
            if matches!(value, RuntimeValue::Null) {
                return Ok(Argument::Null);
            }
            return Err(RuntimeValue::Error(format!(
                "type\0{name}(): incompatible {} argument",
                parameter.name
            )));
        }
        // A String contract consumes inherited raw data. Explicit Link/File
        // union contracts retain the original value and its captured identity.
        let explicit_link = parameter
            .kinds
            .iter()
            .any(|kind| matches!(kind, Kind::Link))
            && matches!(&value, RuntimeValue::Link(link) if !link.external);
        let string_contract = parameter
            .kinds
            .iter()
            .any(|kind| matches!(kind, Kind::String))
            && !explicit_link;
        let value = if string_contract {
            if let Some(data) = string_data(&value) {
                RuntimeValue::String(data.to_owned())
            } else {
                value
            }
        } else {
            value
        };
        Ok(Argument::Value(value))
    }
    pub(super) fn finish(self, name: &str, supplied: usize) -> Result<(), RuntimeValue> {
        if self
            .0
            .iter()
            .skip(supplied)
            .any(|parameter| !parameter.optional && !parameter.variadic)
        {
            Err(arity_error(name, "not enough"))
        } else {
            Ok(())
        }
    }
}
pub(super) fn arity_error(name: &str, reason: &str) -> RuntimeValue {
    RuntimeValue::Error(format!("arity\0{name}(): {reason} arguments"))
}
pub(super) fn global(name: &str) -> Option<Signature> {
    use Kind::*;
    Some(Signature(match canonical_function_name(name) {
        "now" | "today" | "random" => params![],
        "date" => params![required("input", &[String, Date])],
        "if" => params![
            required("condition", &[Boolean]),
            required("true_result", &[Any]),
            optional("false_result", &[Any])
        ],
        "min" | "max" => params![variadic("inputs", &[Number])],
        "list" | "number" => params![required("input", &[NonNull])],
        "link" => params![
            required("input", &[String, File]),
            optional("display", &[Any])
        ],
        "file" => params![required("input", &[String, Link, File])],
        "image" => params![required("input", &[String, File, Link])],
        "duration" | "html" | "icon" | "escapeHTML" => params![required("input", &[String])],
        _ => return None,
    }))
}
pub(super) fn method(receiver: &RuntimeValue, name: &str) -> Option<Signature> {
    use Kind::*;
    let name = canonical_function_name(name);
    if matches!(name, "toString" | "isTruthy") {
        return Some(Signature(params![]));
    }
    if name == "isType" {
        return Some(Signature(params![required("type", &[String])]));
    }
    if matches!(receiver, RuntimeValue::Tag(_)) && name == "matches" {
        return Some(Signature(params![required("tag", &[String])]));
    }
    if matches!(receiver, RuntimeValue::Link(link) if !link.external) {
        match name {
            "asFile" => return Some(Signature(params![])),
            "linksTo" => return Some(Signature(params![required("file", &[File])])),
            _ => {}
        }
    }
    if string_data(receiver).is_some() {
        return Some(Signature(match name {
            "trim" | "title" | "isEmpty" | "reverse" | "lower" => params![],
            "startsWith" | "endsWith" | "contains" => params![required("query", &[String])],
            "replace" => params![
                required("pattern", &[String, Regex]),
                required("replacement", &[String])
            ],
            "split" => params![
                required("separator", &[String, Regex]),
                optional("n", &[Number])
            ],
            "containsAny" | "containsAll" => params![variadic("values", &[String])],
            "slice" => params![required("start", &[Number]), optional("end", &[Number])],
            "repeat" => params![required("count", &[Number])],
            _ => return None,
        }));
    }
    Some(Signature(match receiver {
        RuntimeValue::Null if name == "isEmpty" => params![],
        RuntimeValue::Number(_) => match name {
            "round" => params![optional("digits", &[Number])],
            "ceil" | "floor" | "abs" | "isEmpty" => params![],
            "toFixed" => params![required("precision", &[Number])],
            _ => return None,
        },
        RuntimeValue::List(_) | RuntimeValue::TagList(_) => match name {
            "isEmpty" | "earliest" | "latest" | "median" | "mean" | "max" | "min" | "sum"
            | "stddev" | "reverse" | "flat" | "unique" | "sort" => params![],
            "join" => params![required("separator", &[String])],
            "contains" | "map" => params![required("value", &[Any])],
            "filter" => params![required("value", &[Boolean])],
            "reduce" => params![required("value", &[Any]), required("acc", &[Any])],
            "containsAny" | "containsAll" => params![variadic("values", &[Any])],
            "slice" => params![required("start", &[Number]), optional("end", &[Number])],
            _ => return None,
        },
        RuntimeValue::Object(_) => match name {
            "isEmpty" | "keys" | "values" => params![],
            "map" => params![required("value", &[Any])],
            "filter" => params![required("value", &[Boolean])],
            _ => return None,
        },
        RuntimeValue::Regex(_, _) if name == "matches" => params![required("value", &[String])],
        RuntimeValue::Date(_) => match name {
            "format" => params![required("format", &[String])],
            "date" | "time" | "relative" | "isEmpty" => params![],
            _ => return None,
        },
        RuntimeValue::File(_) => match name {
            "asLink" => params![optional("display", &[Any])],
            "hasLink" => params![required("dest", &[File, Link, String])],
            "inFolder" | "hasProperty" => params![required("value", &[String])],
            "hasTag" => params![variadic("values", &[String])],
            _ => return None,
        },
        _ => return None,
    }))
}
pub(super) fn special_callback_arity(receiver: &RuntimeValue, name: &str) -> Option<usize> {
    match (receiver, name) {
        (RuntimeValue::List(_) | RuntimeValue::TagList(_), "map" | "filter")
        | (RuntimeValue::Object(_), "map" | "filter") => Some(1),
        (RuntimeValue::List(_) | RuntimeValue::TagList(_), "reduce") => Some(2),
        _ => None,
    }
}
pub(super) fn is_type(value: &RuntimeValue, expected: &str) -> bool {
    expected.eq_ignore_ascii_case("any")
        || public_types(value)
            .iter()
            .any(|name| name.eq_ignore_ascii_case(expected))
}
fn public_types(value: &RuntimeValue) -> &'static [&'static str] {
    match value {
        RuntimeValue::Tag(_) | RuntimeValue::Icon(_) | RuntimeValue::String(_) => &["String"],
        RuntimeValue::Html(_) => &["HTML", "String"],
        RuntimeValue::Image(_) => &["Image", "String"],
        RuntimeValue::Link(link) if link.external => &["URL", "String"],
        RuntimeValue::Link(_) => &["Link", "String"],
        RuntimeValue::List(_) | RuntimeValue::TagList(_) => &["List"],
        RuntimeValue::Null => &["Null"],
        RuntimeValue::Bool(_) => &["Boolean"],
        RuntimeValue::Number(_) => &["Number"],
        RuntimeValue::Date(_) => &["Date"],
        RuntimeValue::Duration(_) => &["Duration"],
        RuntimeValue::Object(_) => &["Object"],
        RuntimeValue::File(_) => &["File"],
        RuntimeValue::Regex(_, _) => &["RegExp"],
        RuntimeValue::Error(_) | RuntimeValue::ErrorValue(_) => &["Error"],
    }
}
