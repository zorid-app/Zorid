//! Deterministic initial Base collation. Unicode scalar lowercase tables follow
//! the pinned Rust toolchain; no host Intl, locale or normalization is consulted.
use crate::BaseValue;
use std::{borrow::Cow, cmp::Ordering};

pub(crate) fn natural_text(left: &str, right: &str) -> Ordering {
    let left = left
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<Vec<_>>();
    let right = right
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<Vec<_>>();
    let (mut a, mut b) = (0, 0);
    while a < left.len() && b < right.len() {
        if left[a].is_ascii_digit() && right[b].is_ascii_digit() {
            let (mut ae, mut be) = (a, b);
            while ae < left.len() && left[ae].is_ascii_digit() {
                ae += 1;
            }
            while be < right.len() && right[be].is_ascii_digit() {
                be += 1;
            }
            let (mut az, mut bz) = (a, b);
            while az < ae && left[az] == '0' {
                az += 1;
            }
            while bz < be && right[bz] == '0' {
                bz += 1;
            }
            let order = (ae - az)
                .cmp(&(be - bz))
                .then_with(|| left[az..ae].cmp(&right[bz..be]));
            if order != Ordering::Equal {
                return order;
            }
            a = ae;
            b = be;
        } else {
            let order = left[a].cmp(&right[b]);
            if order != Ordering::Equal {
                return order;
            }
            a += 1;
            b += 1;
        }
    }
    (left.len() - a).cmp(&(right.len() - b))
}
/// String representation used by the reference Image subclass. Relative vault
/// paths use wikilink embeds; URI-like paths retain Markdown image syntax.
pub(crate) fn image_text(value: &str) -> String {
    if value.starts_with("./") || value.starts_with("../") || !value.contains(':') {
        format!("![[{value}]]")
    } else {
        format!("![]({value})")
    }
}
fn string_text(value: &BaseValue) -> Option<Cow<'_, str>> {
    match value {
        BaseValue::String { value } | BaseValue::Html { value } | BaseValue::Icon { value } => {
            Some(Cow::Borrowed(value))
        }
        BaseValue::Image { value } => Some(Cow::Owned(image_text(value))),
        _ => None,
    }
}
fn link_text<'a>(value: &'a BaseValue, timezone: &str) -> Cow<'a, str> {
    match value {
        BaseValue::Link {
            display_value: Some(value),
            ..
        } => Cow::Owned(crate::query::display(value, timezone)),
        BaseValue::Link {
            display: Some(value),
            ..
        } => Cow::Borrowed(value),
        BaseValue::Link { path, .. } => Cow::Borrowed(path),
        _ => unreachable!(),
    }
}
fn rank(value: &BaseValue) -> u8 {
    match value {
        BaseValue::Boolean { .. } => 0,
        BaseValue::Number { .. } => 1,
        BaseValue::Date { .. } => 2,
        BaseValue::Duration { .. } => 3,
        BaseValue::String { .. }
        | BaseValue::Html { .. }
        | BaseValue::Image { .. }
        | BaseValue::Icon { .. } => 4,
        BaseValue::List { .. } => 5,
        BaseValue::Object { .. } => 6,
        BaseValue::File { .. } => 7,
        BaseValue::Link { .. } => 8,
        BaseValue::Error { .. } => 9,
        BaseValue::Null => 10,
    }
}
/// Compare a pair of typed keys. Null/error placement is independent of direction;
/// the caller adds exact vault path as the final row tie-breaker.
pub(crate) fn compare(left: &BaseValue, right: &BaseValue, descending: bool) -> Ordering {
    compare_with_timezone(left, right, descending, "UTC")
}
/// Rich link labels can contain dates; stringify them in the invocation zone.
pub(crate) fn compare_with_timezone(
    left: &BaseValue,
    right: &BaseValue,
    descending: bool,
    timezone: &str,
) -> Ordering {
    if matches!(left, BaseValue::Null | BaseValue::Error { .. })
        || matches!(right, BaseValue::Null | BaseValue::Error { .. })
    {
        return rank(left).cmp(&rank(right));
    }
    let order = ascending(left, right, timezone);
    if descending {
        order.reverse()
    } else {
        order
    }
}
fn ascending(left: &BaseValue, right: &BaseValue, timezone: &str) -> Ordering {
    let type_order = rank(left).cmp(&rank(right));
    if type_order != Ordering::Equal {
        return type_order;
    }
    if let (Some(left), Some(right)) = (string_text(left), string_text(right)) {
        return natural_text(&left, &right);
    }
    if matches!(
        (left, right),
        (BaseValue::Link { .. }, BaseValue::Link { .. })
    ) {
        return natural_text(&link_text(left, timezone), &link_text(right, timezone));
    }
    match (left, right) {
        (BaseValue::Boolean { value: a }, BaseValue::Boolean { value: b }) => a.cmp(b),
        (BaseValue::Number { value: a }, BaseValue::Number { value: b }) => {
            a.partial_cmp(b).unwrap_or(Ordering::Equal)
        }
        (BaseValue::Date { timestamp: a, .. }, BaseValue::Date { timestamp: b, .. }) => a.cmp(b),
        (BaseValue::String { value: a }, BaseValue::String { value: b }) => natural_text(a, b),
        (BaseValue::File { path: a }, BaseValue::File { path: b })
        | (BaseValue::Link { path: a, .. }, BaseValue::Link { path: b, .. }) => natural_text(a, b),
        (BaseValue::List { value: a }, BaseValue::List { value: b }) => sequence(a, b, timezone),
        (BaseValue::Object { value: a }, BaseValue::Object { value: b }) => {
            let mut a = a.iter().collect::<Vec<_>>();
            let mut b = b.iter().collect::<Vec<_>>();
            a.sort_by(|a, b| a.0.cmp(&b.0));
            b.sort_by(|a, b| a.0.cmp(&b.0));
            for (a, b) in a.iter().zip(&b) {
                let order = a.0.cmp(&b.0).then_with(|| ascending(&a.1, &b.1, timezone));
                if order != Ordering::Equal {
                    return order;
                }
            }
            a.len().cmp(&b.len())
        }
        // The query reducer supplies clock-relative duration scalars before
        // sorting. This structural fallback never consults an ambient clock.
        (
            BaseValue::Duration {
                years: a0,
                months: a1,
                weeks: a2,
                days: a3,
                hours: a4,
                minutes: a5,
                seconds: a6,
                milliseconds: a7,
            },
            BaseValue::Duration {
                years: b0,
                months: b1,
                weeks: b2,
                days: b3,
                hours: b4,
                minutes: b5,
                seconds: b6,
                milliseconds: b7,
            },
        ) => [a0, a1, a2, a3, a4, a5, a6, a7]
            .into_iter()
            .zip([b0, b1, b2, b3, b4, b5, b6, b7])
            .map(|(a, b)| a.partial_cmp(b).unwrap_or(Ordering::Equal))
            .find(|order| *order != Ordering::Equal)
            .unwrap_or(Ordering::Equal),
        _ => Ordering::Equal,
    }
}
fn sequence(a: &[BaseValue], b: &[BaseValue], timezone: &str) -> Ordering {
    for (a, b) in a.iter().zip(b) {
        let order = ascending(a, b, timezone);
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_and_link_have_distinct_total_type_ranks() {
        let a = BaseValue::File { path: "a".into() };
        let z = BaseValue::File { path: "z".into() };
        let m = BaseValue::Link {
            path: "m".into(),
            target: None,
            display: None,
            display_value: None,
            subpath: None,
            external: false,
        };
        assert_eq!(compare(&a, &z, false), Ordering::Less);
        assert_eq!(compare(&z, &m, false), Ordering::Less);
        assert_eq!(compare(&a, &m, false), Ordering::Less);
    }
    #[test]
    fn multilingual_digits_zero_padding_and_null_direction() {
        let mut values = [
            "猫10", "Я10", "é10", "Ä10", "a10", "猫2", "я2", "É2", "ä2", "A2",
        ];
        values.sort_by(|a, b| natural_text(a, b));
        assert_eq!(
            values,
            ["A2", "a10", "ä2", "Ä10", "É2", "é10", "я2", "Я10", "猫2", "猫10"]
        );
        assert_eq!(natural_text("item02", "ITEM2"), Ordering::Equal);
        assert_eq!(
            natural_text(
                "x9999999999999999999999999999999999999",
                "x10000000000000000000000000000000000000"
            ),
            Ordering::Less
        );
        assert_eq!(
            compare(&BaseValue::Null, &BaseValue::Boolean { value: false }, true),
            Ordering::Greater
        );
    }
}

#[cfg(test)]
mod rich_tests {
    use super::*;
    #[test]
    fn rich_strings_collate_with_text_but_keep_separate_group_types() {
        assert_eq!(
            compare(
                &BaseValue::Html { value: "B2".into() },
                &BaseValue::String {
                    value: "B10".into()
                },
                false
            ),
            Ordering::Less
        );
        assert_eq!(
            compare(
                &BaseValue::Icon {
                    value: "star".into()
                },
                &BaseValue::String {
                    value: "STAR".into()
                },
                false
            ),
            Ordering::Equal
        );
        assert_eq!(image_text("cover.png"), "![[cover.png]]");
        assert_eq!(
            image_text("https://example.test/cover.png"),
            "![](https://example.test/cover.png)"
        );
        assert_eq!(
            compare(
                &BaseValue::Image {
                    value: "cover.png".into()
                },
                &BaseValue::String {
                    value: "![[cover.png]]".into()
                },
                false
            ),
            Ordering::Equal
        );
    }
}
