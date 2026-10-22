//! Checked construction of literal regex wrappers before any lazy evaluation.
//! The parser remains a bounded syntax reader; compilation occurs only after
//! the caller's work/cancellation callback admits this walk and literal bytes.
use super::*;

pub(super) fn admit(
    expression: &Expr,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<(), RuntimeValue> {
    fn visit(
        expression: &Expr,
        depth: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(1)?;
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Regex literal admission nesting exceeds128".into(),
            ));
        }
        match expression {
            Expr::Regex(pattern, flags, _) => {
                check(pattern.len() / 16 + flags.len() + 1)?;
                if pattern
                    .len()
                    .saturating_mul(6)
                    .saturating_add(flags.len() + 3)
                    > 8 * 1024 * 1024
                {
                    return Err(RuntimeValue::Error(
                        "budget\0Regex string representation exceeds byte budget".into(),
                    ));
                }
                let flags = canonical_regex_flags(flags).map_err(RuntimeValue::Error)?;
                compile_regex(pattern, &flags).map_err(RuntimeValue::Error)?;
                check(0)?;
            }
            Expr::Unary(_, value) => visit(value, depth + 1, check)?,
            Expr::Binary(_, left, right) => {
                visit(left, depth + 1, check)?;
                visit(right, depth + 1, check)?;
            }
            Expr::Array(values) => {
                for value in values {
                    visit(value, depth + 1, check)?;
                }
            }
            Expr::Member(object, member) => {
                visit(object, depth + 1, check)?;
                if let Member::Computed(value) = member {
                    visit(value, depth + 1, check)?;
                }
            }
            Expr::Call(callee, values) => {
                visit(callee, depth + 1, check)?;
                for value in values {
                    visit(value, depth + 1, check)?;
                }
            }
            Expr::Literal(_) | Expr::Identifier(_) => {}
        }
        Ok(())
    }
    visit(expression, 0, check)
}

/// Imported budget/cancellation errors are fatal even when construction fails.
/// This checks only inert transport data; it never resolves File/Link metadata.
pub(super) fn fatal_summary_inputs(
    values: &[&BaseValue],
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<(), RuntimeValue> {
    fn text(
        value: &str,
        bytes: &mut usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(value.len() / 16 + 1)?;
        *bytes = bytes.saturating_add(value.len());
        if *bytes > 8 * 1024 * 1024 {
            return Err(RuntimeValue::Error(
                "budget\0Summary inputs exceed byte budget".into(),
            ));
        }
        Ok(())
    }
    fn visit(
        value: &BaseValue,
        depth: usize,
        bytes: &mut usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(1)?;
        *bytes = bytes.saturating_add(64);
        if depth > 128 || *bytes > 8 * 1024 * 1024 {
            return Err(RuntimeValue::Error(
                "budget\0Summary inputs exceed depth/byte budget".into(),
            ));
        }
        match value {
            BaseValue::List { value } => {
                for value in value {
                    visit(value, depth + 1, bytes, check)?;
                }
            }
            BaseValue::Object { value } => {
                for (key, value) in value {
                    text(key, bytes, check)?;
                    visit(value, depth + 1, bytes, check)?;
                }
            }
            BaseValue::Link {
                path,
                subpath,
                target,
                display,
                display_value,
                ..
            } => {
                text(path, bytes, check)?;
                for value in [subpath, display] {
                    if let Some(value) = value {
                        text(value, bytes, check)?;
                    }
                }
                if let Some(target) = target {
                    text(target.entry_id.as_str(), bytes, check)?;
                    text(target.revision.as_str(), bytes, check)?;
                }
                if let Some(value) = display_value {
                    visit(value, depth + 1, bytes, check)?;
                }
            }
            BaseValue::String { value }
            | BaseValue::Html { value }
            | BaseValue::Image { value }
            | BaseValue::Icon { value } => text(value, bytes, check)?,
            BaseValue::File { path } => text(path, bytes, check)?,
            BaseValue::Error { code, message } => {
                text(code, bytes, check)?;
                text(message, bytes, check)?;
                if ["budget", "cancelled"].contains(&code.as_str()) {
                    return Err(RuntimeValue::Error(format!("{code}\0{message}")));
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut bytes = 0;
    for value in values {
        visit(value, 0, &mut bytes, check)?;
    }
    Ok(())
}
