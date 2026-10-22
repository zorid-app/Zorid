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
