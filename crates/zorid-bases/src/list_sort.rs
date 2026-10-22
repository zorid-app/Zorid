//! Concrete List.sort ordering, separate from value-to-text conversion.
//!
//! The reference uses numeric subtraction only for two Number operands and an
//! ambient-locale, numeric, base-sensitive Intl.Collator for every other pair.
//! Zorid deliberately pins English and ICU4X data across native, CLI and WASM.
//! This does not change scalar string indexing/slicing or row sorting.
//!
//! Mixed Number/String comparisons need not be transitive (negative numbers
//! are one example). A bounded left-on-equal merge therefore avoids the total
//! ordering precondition of Rust's general-purpose sort implementations. The
//! resulting order for inconsistent comparisons is deterministic, not a claim
//! to reproduce a particular JavaScript engine's sorting algorithm.

use crate::expression::RuntimeValue;
use icu_collator::{
    options::{CaseLevel, CollatorOptions, Strength},
    preferences::CollationNumericOrdering,
    Collator, CollatorBorrowed,
};
use std::cmp::Ordering;

const MAX_SORT_BYTES: usize = 8 * 1024 * 1024;

/// Already checked, reference-derived conversion supplied by the evaluator.
/// `number` is present only for an actual Number, never a numeric-looking text.
pub(crate) struct ListSortKey<'a> {
    pub(crate) number: Option<f64>,
    pub(crate) text: &'a str,
}

struct ListCollator(CollatorBorrowed<'static>);

impl ListCollator {
    fn new() -> Result<Self, RuntimeValue> {
        let mut preferences: icu_collator::CollatorPreferences =
            icu_locale_core::locale!("en").into();
        preferences.numeric_ordering = Some(CollationNumericOrdering::True);
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        options.case_level = Some(CaseLevel::Off);
        Collator::try_new(preferences, options)
            .map(Self)
            .map_err(|_| {
                RuntimeValue::Error("unavailable\0List sort collation is unavailable".into())
            })
    }

    fn compare(
        &self,
        left: &ListSortKey<'_>,
        right: &ListSortKey<'_>,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<Ordering, RuntimeValue> {
        if let (Some(left), Some(right)) = (left.number, right.number) {
            check(1)?;
            // Admission rejects nonfinite inputs. Numeric subtraction could
            // overflow despite finite operands, whereas comparison cannot.
            return Ok(if left < right {
                Ordering::Less
            } else if left > right {
                Ordering::Greater
            } else {
                Ordering::Equal
            });
        }
        // ICU has no per-code-point cancellation hook. Admit the complete two
        // bounded strings before entering it; never hide repeated scans behind
        // only an n*log(n) element estimate.
        let work = left
            .text
            .len()
            .checked_add(right.text.len())
            .and_then(|bytes| bytes.checked_add(1))
            .ok_or_else(budget_error)?;
        check(work)?;
        Ok(self.0.compare(left.text, right.text))
    }
}

fn budget_error() -> RuntimeValue {
    RuntimeValue::Error("budget\0List sort exceeds byte budget".into())
}

/// Sort a permutation, leaving checked keys and original values untouched on
/// failure. Errors from `check` (including cancellation) pass through unchanged.
pub(crate) fn sorted_indices(
    keys: &[ListSortKey<'_>],
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<Vec<usize>, RuntimeValue> {
    check(1)?;
    let scratch_bytes = keys
        .len()
        .checked_mul(std::mem::size_of::<usize>())
        .and_then(|bytes| bytes.checked_mul(2))
        .filter(|bytes| *bytes <= MAX_SORT_BYTES)
        .ok_or_else(budget_error)?;
    let mut text_bytes = 0usize;
    for key in keys {
        check(1)?;
        text_bytes = text_bytes
            .checked_add(key.text.len())
            .filter(|bytes| *bytes <= MAX_SORT_BYTES)
            .ok_or_else(budget_error)?;
        check(key.text.len().saturating_add(1))?;
        if key.number.is_some_and(|number| !number.is_finite()) {
            return Err(RuntimeValue::Error(
                "numeric-domain\0Nonfinite List sort number".into(),
            ));
        }
    }
    // Both buffers are admitted before either allocation. try_reserve prevents
    // capacity errors from turning an ordinary resource failure into a panic.
    check(scratch_bytes.saturating_add(1))?;
    let mut order = Vec::new();
    let mut scratch = Vec::new();
    order
        .try_reserve_exact(keys.len())
        .map_err(|_| budget_error())?;
    scratch
        .try_reserve_exact(keys.len())
        .map_err(|_| budget_error())?;
    for index in 0..keys.len() {
        check(1)?;
        order.push(index);
        scratch.push(0);
    }
    if keys.len() < 2 {
        return Ok(order);
    }
    let collator = ListCollator::new()?;
    let mut width = 1usize;
    while width < order.len() {
        check(1)?;
        let mut start = 0usize;
        while start < order.len() {
            check(1)?;
            let middle = start.saturating_add(width).min(order.len());
            let end = middle.saturating_add(width).min(order.len());
            let (mut left, mut right) = (start, middle);
            for destination in start..end {
                check(1)?;
                let take_left = if left == middle {
                    false
                } else if right == end {
                    true
                } else {
                    collator.compare(&keys[order[left]], &keys[order[right]], check)?
                        != Ordering::Greater
                };
                scratch[destination] = if take_left {
                    let index = order[left];
                    left += 1;
                    index
                } else {
                    let index = order[right];
                    right += 1;
                    index
                };
            }
            start = end;
        }
        std::mem::swap(&mut order, &mut scratch);
        width = width.saturating_mul(2);
    }
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_keys<'a>(values: &'a [&'a str]) -> Vec<ListSortKey<'a>> {
        values
            .iter()
            .map(|text| ListSortKey { number: None, text })
            .collect()
    }

    fn sorted_text<'a>(values: &'a [&'a str]) -> Vec<&'a str> {
        let keys = text_keys(values);
        sorted_indices(&keys, &mut |_| Ok(()))
            .unwrap()
            .into_iter()
            .map(|index| values[index])
            .collect()
    }

    #[test]
    fn natural_digits_are_not_lexical_or_decimal_number_parsing() {
        assert_eq!(sorted_text(&["a10", "a2", "a1"]), ["a1", "a2", "a10"]);
        assert_eq!(sorted_text(&["2.10", "2.2"]), ["2.2", "2.10"]);
        assert_eq!(sorted_text(&["a02", "a2", "a002"]), ["a02", "a2", "a002"]);
    }

    #[test]
    fn empty_single_and_odd_merge_passes_keep_every_original_index() {
        assert!(sorted_indices(&[], &mut |_| Ok(())).unwrap().is_empty());
        assert_eq!(sorted_text(&["alone"]), ["alone"]);
        assert_eq!(
            sorted_text(&["a7", "a6", "a5", "a4", "a3", "a2", "a1"]),
            ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]
        );
    }

    #[test]
    fn base_sensitive_ties_preserve_input_order() {
        assert_eq!(
            sorted_text(&["é", "E", "e\u{301}", "e", "a"]),
            ["a", "é", "E", "e\u{301}", "e"]
        );
        assert_eq!(
            sorted_text(&["ⓓⓔⓐⓛ", "DEAL", "deal"]),
            ["ⓓⓔⓐⓛ", "DEAL", "deal"]
        );
    }

    #[test]
    fn decimal_digits_from_other_scripts_use_numeric_collation() {
        assert_eq!(sorted_text(&["a١٠", "a٢", "a1"]), ["a1", "a٢", "a١٠"]);
    }

    #[test]
    fn english_policy_and_canonical_equivalence_are_explicit() {
        assert_eq!(sorted_text(&["z", "ö", "o", "a"]), ["a", "ö", "o", "z"]);
        let collator = ListCollator::new().unwrap();
        let keys = text_keys(&["é", "e\u{301}", "a-b", "ab"]);
        assert_eq!(
            collator
                .compare(&keys[0], &keys[1], &mut |_| Ok(()))
                .unwrap(),
            Ordering::Equal
        );
        assert_ne!(
            collator
                .compare(&keys[2], &keys[3], &mut |_| Ok(()))
                .unwrap(),
            Ordering::Equal
        );
    }

    #[test]
    fn only_two_actual_numbers_take_numeric_branch() {
        let keys = [
            ListSortKey {
                number: Some(-2.0),
                text: "-2",
            },
            ListSortKey {
                number: Some(-10.0),
                text: "-10",
            },
        ];
        assert_eq!(sorted_indices(&keys, &mut |_| Ok(())).unwrap(), [1, 0]);
        let keys = [
            ListSortKey {
                number: Some(2.0),
                text: "2",
            },
            ListSortKey {
                number: None,
                text: "02",
            },
            ListSortKey {
                number: Some(10.0),
                text: "10",
            },
        ];
        assert_eq!(sorted_indices(&keys, &mut |_| Ok(())).unwrap(), [0, 1, 2]);
    }

    #[test]
    fn inconsistent_mixed_comparisons_have_bounded_deterministic_permutation() {
        let keys = [
            ListSortKey {
                number: Some(-10.0),
                text: "-10",
            },
            ListSortKey {
                number: Some(-2.0),
                text: "-2",
            },
            ListSortKey {
                number: None,
                text: "-3",
            },
        ];
        let order = sorted_indices(&keys, &mut |_| Ok(())).unwrap();
        assert_eq!(order, [2, 0, 1]);
        assert_eq!(sorted_indices(&keys, &mut |_| Ok(())).unwrap(), order);
    }

    #[test]
    fn already_converted_null_dates_and_booleans_receive_no_type_rank() {
        assert_eq!(
            sorted_text(&["null", "true", "2026-10-22", "2026-2-1", "false"]),
            ["2026-2-1", "2026-10-22", "false", "null", "true"]
        );
    }

    #[test]
    fn complete_comparison_input_is_charged_before_icu() {
        let collator = ListCollator::new().unwrap();
        let left = "a".repeat(1024);
        let right = "b".repeat(2048);
        let texts = [left.as_str(), right.as_str()];
        let keys = text_keys(&texts);
        let mut observed = Vec::new();
        let result = collator.compare(&keys[0], &keys[1], &mut |work| {
            observed.push(work);
            Err(RuntimeValue::Error(
                "cancelled\0original cancellation".into(),
            ))
        });
        assert!(
            matches!(result, Err(RuntimeValue::Error(message)) if message == "cancelled\0original cancellation")
        );
        assert_eq!(observed, [3073]);
    }

    #[test]
    fn cancellation_at_each_checkpoint_never_publishes_partial_order() {
        let keys = text_keys(&["a10", "a2", "a1", "a3"]);
        let mut count = 0;
        let complete = sorted_indices(&keys, &mut |_| {
            count += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(complete, [2, 1, 3, 0]);
        for fail_at in 1..=count {
            let mut calls = 0;
            let result = sorted_indices(&keys, &mut |_| {
                calls += 1;
                if calls == fail_at {
                    Err(RuntimeValue::Error(
                        "cancelled\0exact original error".into(),
                    ))
                } else {
                    Ok(())
                }
            });
            assert!(
                matches!(result, Err(RuntimeValue::Error(message)) if message == "cancelled\0exact original error")
            );
        }
    }

    #[test]
    fn byte_and_nonfinite_admission_fail_before_sort() {
        let oversized = "a".repeat(MAX_SORT_BYTES + 1);
        let keys = [ListSortKey {
            number: None,
            text: &oversized,
        }];
        assert!(
            matches!(sorted_indices(&keys, &mut |_| Ok(())), Err(RuntimeValue::Error(message)) if message.starts_with("budget\0"))
        );
        let keys = [ListSortKey {
            number: Some(f64::NAN),
            text: "NaN",
        }];
        assert!(
            matches!(sorted_indices(&keys, &mut |_| Ok(())), Err(RuntimeValue::Error(message)) if message.starts_with("numeric-domain\0"))
        );
    }
}
