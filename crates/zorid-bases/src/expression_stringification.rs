//! Checked reference toString conversion. Typed JSON projection is deliberately
//! separate: Object.toString serializes each child's *string*, in JS own-key order.
//! Zorid preserves `__proto__` as inert user data; it does not copy the reference
//! temporary plain object's legacy setter, which can omit that particular key.
use super::{
    error_message, format_date, format_duration, format_number, js_array_index, RuntimeValue,
};
use std::mem::size_of;

const TEXT_LIMIT: usize = 8 * 1024 * 1024;
const SCRATCH_LIMIT: usize = crate::MAX_BASE_REQUEST_BYTES;

#[derive(Clone, Copy)]
pub(super) enum LinkPolicy {
    Presentation,
    StrictOrigin,
}
fn budget(message: &str) -> RuntimeValue {
    RuntimeValue::Error(format!("budget\0{message}"))
}

pub(super) fn stringify(
    value: &RuntimeValue,
    policy: LinkPolicy,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    stringify_with_scratch_limit(value, policy, SCRATCH_LIMIT, check)
}

pub(super) fn stringify_with_scratch_limit(
    value: &RuntimeValue,
    policy: LinkPolicy,
    scratch_limit: usize,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    Renderer {
        check,
        policy,
        held: 0,
        limit: scratch_limit.min(SCRATCH_LIMIT),
    }
    .render(value, 0)
}

pub(super) fn copy_text(
    text: &str,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    copy_text_with_scratch_limit(text, SCRATCH_LIMIT, check)
}

pub(super) fn copy_text_with_scratch_limit(
    text: &str,
    scratch_limit: usize,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    let mut renderer = Renderer {
        check,
        policy: LinkPolicy::Presentation,
        held: 0,
        limit: scratch_limit.min(SCRATCH_LIMIT),
    };
    let mut output = String::new();
    renderer.append(&mut output, text)?;
    Ok(output)
}

pub(super) fn join(
    values: &[RuntimeValue],
    separator: &str,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    let mut renderer = Renderer {
        check,
        policy: LinkPolicy::Presentation,
        held: 0,
        limit: SCRATCH_LIMIT,
    };
    let mut output = String::new();
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            renderer.append(&mut output, separator)?;
        }
        renderer.render_into(&mut output, value, 0)?;
    }
    Ok(output)
}

pub(super) fn concatenate(
    left: &RuntimeValue,
    right: &RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    let mut renderer = Renderer {
        check,
        policy: LinkPolicy::Presentation,
        held: 0,
        limit: SCRATCH_LIMIT,
    };
    let mut output = String::new();
    for value in [left, right] {
        if !matches!(value, RuntimeValue::Null) {
            renderer.render_into(&mut output, value, 0)?;
        }
    }
    Ok(output)
}

struct Renderer<'a, F> {
    check: &'a mut F,
    policy: LinkPolicy,
    // Includes live child strings, ordered-entry scratch and output capacities.
    // Admission precedes allocation, including old+new capacity during growth.
    held: usize,
    limit: usize,
}
impl<F: FnMut(usize) -> Result<(), RuntimeValue>> Renderer<'_, F> {
    fn reserve(&mut self, bytes: usize) -> Result<(), RuntimeValue> {
        (self.check)(1)?;
        self.held = self
            .held
            .checked_add(bytes)
            .filter(|bytes| *bytes <= self.limit)
            .ok_or_else(|| budget("String conversion scratch exceeds byte budget"))?;
        Ok(())
    }
    fn release(&mut self, bytes: usize) {
        self.held -= bytes;
    }
    fn append(&mut self, output: &mut String, text: &str) -> Result<(), RuntimeValue> {
        (self.check)(text.len() / 16 + 1)?;
        let required = output
            .len()
            .checked_add(text.len())
            .filter(|size| *size <= TEXT_LIMIT)
            .ok_or_else(|| budget("String conversion exceeds byte budget"))?;
        if required > output.capacity() {
            let old = output.capacity();
            let target = required.max(old.saturating_mul(2).max(32)).min(TEXT_LIMIT);
            (self.check)(output.len() / 16 + 1)?;
            self.reserve(target)?;
            output
                .try_reserve_exact(target - output.len())
                .map_err(|_| budget("String conversion allocation failed"))?;
            if output.capacity() > target {
                self.reserve(output.capacity() - target)?;
            }
            self.release(old);
        }
        output.push_str(text);
        Ok(())
    }
    fn json_text(&mut self, output: &mut String, text: &str) -> Result<(), RuntimeValue> {
        (self.check)(text.len() / 16 + 1)?;
        self.append(output, "\"")?;
        let mut start = 0;
        for (ordinal, (at, character)) in text.char_indices().enumerate() {
            // Cancellation stays cooperative even in one long unescaped run.
            if ordinal % 256 == 0 {
                (self.check)(1)?;
            }
            let escaped = match character {
                '"' => Some("\\\""),
                '\\' => Some("\\\\"),
                '\u{8}' => Some("\\b"),
                '\u{c}' => Some("\\f"),
                '\n' => Some("\\n"),
                '\r' => Some("\\r"),
                '\t' => Some("\\t"),
                _ => None,
            };
            if escaped.is_some() || character < '\u{20}' {
                self.append(output, &text[start..at])?;
                if let Some(escaped) = escaped {
                    self.append(output, escaped)?;
                } else {
                    let digits = b"0123456789abcdef";
                    let code = character as usize;
                    let bytes = [
                        b'\\',
                        b'u',
                        b'0',
                        b'0',
                        digits[code >> 4],
                        digits[code & 15],
                    ];
                    self.append(output, std::str::from_utf8(&bytes).expect("ASCII escape"))?;
                }
                start = at + character.len_utf8();
            }
        }
        self.append(output, &text[start..])?;
        self.append(output, "\"")
    }
    fn render(&mut self, value: &RuntimeValue, depth: usize) -> Result<String, RuntimeValue> {
        let mut output = String::new();
        self.render_into(&mut output, value, depth)?;
        Ok(output)
    }
    fn render_into(
        &mut self,
        output: &mut String,
        value: &RuntimeValue,
        depth: usize,
    ) -> Result<(), RuntimeValue> {
        (self.check)(1)?;
        if depth > 128 {
            return Err(budget("String conversion nesting exceeds 128"));
        }
        match value {
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                for (index, value) in values.iter().enumerate() {
                    if index != 0 {
                        self.append(output, ", ")?;
                    }
                    self.render_into(output, value, depth + 1)?;
                }
            }
            RuntimeValue::Object(values) => {
                type Entry<'a> = (Option<u32>, usize, &'a String, &'a RuntimeValue);
                let slots = values
                    .len()
                    .checked_mul(size_of::<Entry<'_>>())
                    .ok_or_else(|| budget("Object string key ordering exceeds byte budget"))?;
                let mut longest = 0;
                for key in values.keys() {
                    (self.check)(key.len() / 16 + 1)?;
                    longest = longest.max(key.len());
                }
                let levels = usize::BITS - values.len().max(1).leading_zeros();
                (self.check)(
                    values
                        .len()
                        .saturating_mul(longest / 16 + 1)
                        .saturating_mul((levels as usize).saturating_mul(2) + 1),
                )?;
                self.reserve(slots)?;
                let mut entries = Vec::new();
                entries
                    .try_reserve_exact(values.len())
                    .map_err(|_| budget("Object string key ordering allocation failed"))?;
                for (ordinal, (key, value)) in values.iter().enumerate() {
                    entries.push((js_array_index(key), ordinal, key, value));
                }
                entries.sort_unstable_by(|a, b| match (a.0, b.0) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.1.cmp(&b.1),
                });
                self.append(output, "{")?;
                for (index, (_, _, key, value)) in entries.iter().enumerate() {
                    if index != 0 {
                        self.append(output, ",")?;
                    }
                    self.json_text(output, key)?;
                    self.append(output, ":")?;
                    let child = self.render(value, depth + 1)?;
                    self.json_text(output, &child)?;
                    self.release(child.capacity());
                }
                self.append(output, "}")?;
                self.release(slots);
            }
            RuntimeValue::Link(link) if !link.external => {
                if matches!(self.policy, LinkPolicy::StrictOrigin)
                    && (link.raw_destination.is_none() || link.source_path.is_none())
                {
                    return Err(RuntimeValue::Error(
                        "unavailable\0Unique Link key requires original destination and source"
                            .into(),
                    ));
                }
                self.append(output, "[[")?;
                if let Some(raw) = &link.raw_destination {
                    self.append(output, raw)?;
                } else {
                    self.append(output, &link.path)?;
                    if link.resolved_path.as_ref().and_then(Option::as_deref)
                        == Some(link.path.as_str())
                    {
                        if let Some(subpath) = &link.subpath {
                            self.append(output, subpath)?;
                        }
                    }
                }
                match link.display_value.as_deref() {
                    Some(RuntimeValue::Null) => {}
                    Some(display) => {
                        self.append(output, "|")?;
                        self.render_into(output, display, depth + 1)?;
                    }
                    None => {
                        if let Some(display) = &link.display {
                            self.append(output, "|")?;
                            self.append(output, display)?;
                        }
                    }
                }
                self.append(output, "]]")?;
            }
            RuntimeValue::Null => self.append(output, "null")?,
            RuntimeValue::Bool(value) => {
                self.append(output, if *value { "true" } else { "false" })?
            }
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Icon(value) => self.append(output, value)?,
            RuntimeValue::File(value) => self.append(output, &value.path)?,
            RuntimeValue::Link(value) => self.append(output, &value.path)?,
            RuntimeValue::Image(value) => {
                (self.check)(value.len() / 16 + 1)?;
                let wiki =
                    value.starts_with("./") || value.starts_with("../") || !value.contains(':');
                self.append(output, if wiki { "![[" } else { "![](" })?;
                self.append(output, value)?;
                self.append(output, if wiki { "]]" } else { ")" })?;
            }
            RuntimeValue::Regex(pattern, flags, _) => {
                (self.check)(pattern.len() / 16 + flags.len() + 1)?;
                self.append(output, "/")?;
                if pattern.is_empty() {
                    self.append(output, "(?:)")?;
                } else {
                    let mut escaped = false;
                    for character in pattern.chars() {
                        let mut bytes = [0; 4];
                        self.append(
                            output,
                            match character {
                                '/' if !escaped => "\\/",
                                '\n' => "\\n",
                                '\r' => "\\r",
                                '\u{2028}' => "\\u2028",
                                '\u{2029}' => "\\u2029",
                                other => other.encode_utf8(&mut bytes),
                            },
                        )?;
                        escaped = character == '\\' && !escaped;
                    }
                }
                self.append(output, "/")?;
                for flag in "gimsu".chars() {
                    if flags.contains(flag) {
                        self.append(output, flag.encode_utf8(&mut [0; 4]))?;
                    }
                }
            }
            RuntimeValue::Error(message) => {
                (self.check)(message.len() / 16 + 1)?;
                if message.len() > TEXT_LIMIT {
                    return Err(budget("String conversion diagnostic exceeds byte budget"));
                }
                self.reserve(message.len())?;
                return Err(RuntimeValue::Error(message.clone()));
            }
            RuntimeValue::ErrorValue(message) => {
                (self.check)(message.len() / 16 + 1)?;
                self.append(output, "Error: ")?;
                self.append(output, error_message(message))?;
            }
            // Scalar formatters have bounded output (scientific numbers, fixed
            // date format, finite duration humanization). Admit their scratch
            // before formatting, and never call the recursive legacy converter.
            value => {
                self.reserve(512)?;
                (self.check)(32)?;
                let text = match value {
                    RuntimeValue::Number(value) => format_number(*value),
                    RuntimeValue::Date(value) => format_date(
                        value,
                        if value.date_only {
                            "YYYY-MM-DD"
                        } else {
                            "YYYY-MM-DDTHH:mm:ss"
                        },
                    ),
                    RuntimeValue::Duration(value) => format_duration(value),
                    _ => unreachable!("all runtime constructors handled"),
                };
                self.append(output, &text)?;
                self.release(512);
            }
        }
        Ok(())
    }
}
