//! Invocation-only constructor provenance captured from evaluated runtime values.
//! Public values remain unchanged; this proof is neither inferred from property
//! names nor used to grant link resolution authority.
use super::RuntimeValue;
use crate::ExpressionDiagnostic;
use std::mem::size_of;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub(crate) enum TagShape {
    Tag,
    TagList,
    List(Vec<(usize, TagShape)>),
    Object(Vec<(String, TagShape)>),
    Link {
        raw_destination: Option<String>,
        source_path: Option<String>,
        display_shape: Option<Box<TagShape>>,
    },
    Regex {
        pattern: String,
        flags: String,
        identity: Arc<()>,
    },
}

pub(crate) fn capture_runtime_shape(
    value: &RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<TagShape>, ExpressionDiagnostic> {
    capture(value, 0, check, reserve)
}

pub(crate) fn restore_runtime_shape(
    value: &mut RuntimeValue,
    shape: &TagShape,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    restore(value, shape, 0, check)
}

/// Additional cloned data and retained identity pointers, excluding the already
/// retained proof/public value. Admit this before restoring each occurrence.
pub(crate) fn runtime_shape_restore_bytes(
    shape: &TagShape,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<usize, ExpressionDiagnostic> {
    let mut bytes = 0usize;
    restore_bytes(shape, 0, &mut bytes, check)?;
    Ok(bytes)
}

fn restore_bytes(
    shape: &TagShape,
    depth: usize,
    bytes: &mut usize,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    visit(depth, check)?;
    match shape {
        TagShape::Tag | TagShape::TagList => {}
        TagShape::List(values) => {
            for (_, shape) in values {
                restore_bytes(shape, depth + 1, bytes, check)?;
            }
        }
        TagShape::Object(values) => {
            for (key, shape) in values {
                check(key.len() / 16 + 1)?;
                restore_bytes(shape, depth + 1, bytes, check)?;
            }
        }
        TagShape::Link {
            raw_destination,
            source_path,
            display_shape,
        } => {
            for text in [raw_destination, source_path].into_iter().flatten() {
                check(text.len() / 16 + 1)?;
                add_restore_bytes(bytes, text.len())?;
            }
            if let Some(shape) = display_shape {
                restore_bytes(shape, depth + 1, bytes, check)?;
            }
        }
        TagShape::Regex { pattern, flags, .. } => {
            check(pattern.len().saturating_add(flags.len()) / 16 + 1)?;
            add_restore_bytes(bytes, pattern.len())?;
            add_restore_bytes(bytes, flags.len())?;
            add_restore_bytes(bytes, size_of::<Arc<()>>())?;
        }
    }
    Ok(())
}

fn add_restore_bytes(bytes: &mut usize, additional: usize) -> Result<(), ExpressionDiagnostic> {
    *bytes = bytes
        .checked_add(additional)
        .filter(|bytes| *bytes <= 8 * 1024 * 1024)
        .ok_or_else(|| {
            ExpressionDiagnostic::new(
                "budget",
                "Runtime provenance restoration exceeds byte budget",
            )
        })?;
    Ok(())
}

fn visit(
    depth: usize,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    check(1)?;
    if depth > 128 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Runtime provenance exceeds depth budget",
        ));
    }
    Ok(())
}

fn invalid() -> ExpressionDiagnostic {
    ExpressionDiagnostic::new("input", "Invalid runtime provenance shape")
}

fn copy_string(
    value: &str,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<String, ExpressionDiagnostic> {
    check(value.len() / 16 + 1)?;
    reserve(value.len())?;
    Ok(value.to_owned())
}

fn copy_optional_string(
    value: Option<&str>,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<String>, ExpressionDiagnostic> {
    value
        .map(|value| copy_string(value, check, reserve))
        .transpose()
}

fn reserve_slot<T>(
    values: &mut Vec<T>,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    if values.len() == values.capacity() {
        let capacity = values.capacity();
        let target = capacity.saturating_mul(2).max(4);
        check(capacity.saturating_mul(size_of::<T>()) / 16 + 1)?;
        reserve(
            target
                .saturating_sub(capacity)
                .saturating_mul(size_of::<T>()),
        )?;
        values
            .try_reserve_exact(target - values.len())
            .map_err(|_| {
                ExpressionDiagnostic::new("budget", "Runtime provenance allocation exceeds budget")
            })?;
    }
    Ok(())
}

fn boxed(
    shape: Option<TagShape>,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<Box<TagShape>>, ExpressionDiagnostic> {
    shape
        .map(|shape| {
            check(1)?;
            reserve(size_of::<TagShape>())?;
            Ok(Box::new(shape))
        })
        .transpose()
}

fn sort_object(
    values: &mut [(String, TagShape)],
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    if values.len() > 1 {
        let longest = values.iter().map(|(key, _)| key.len()).max().unwrap_or(0);
        let comparisons = values
            .len()
            .saturating_mul(values.len().ilog2() as usize + 1);
        check(
            comparisons
                .saturating_mul(longest / 16 + 1)
                .saturating_mul(2),
        )?;
        values.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    }
    Ok(())
}

fn capture(
    value: &RuntimeValue,
    depth: usize,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<TagShape>, ExpressionDiagnostic> {
    visit(depth, check)?;
    Ok(match value {
        RuntimeValue::Tag(_) => Some(TagShape::Tag),
        RuntimeValue::TagList(_) => Some(TagShape::TagList),
        RuntimeValue::Regex(pattern, flags, identity) => {
            let pattern = copy_string(pattern, check, reserve)?;
            let flags = copy_string(flags, check, reserve)?;
            check(1)?;
            reserve(size_of::<Arc<()>>())?;
            Some(TagShape::Regex {
                pattern,
                flags,
                identity: Arc::clone(identity),
            })
        }
        RuntimeValue::List(values) => {
            let mut shapes = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if let Some(shape) = capture(value, depth + 1, check, reserve)? {
                    reserve_slot(&mut shapes, check, reserve)?;
                    shapes.push((index, shape));
                }
            }
            (!shapes.is_empty()).then_some(TagShape::List(shapes))
        }
        RuntimeValue::Object(values) => {
            let mut shapes = Vec::new();
            for (key, value) in values {
                check(key.len() / 16 + 1)?;
                if let Some(shape) = capture(value, depth + 1, check, reserve)? {
                    reserve_slot(&mut shapes, check, reserve)?;
                    shapes.push((copy_string(key, check, reserve)?, shape));
                }
            }
            sort_object(&mut shapes, check)?;
            (!shapes.is_empty()).then_some(TagShape::Object(shapes))
        }
        RuntimeValue::Link(link) => {
            let display_shape = link
                .display_value
                .as_deref()
                .map(|value| capture(value, depth + 1, check, reserve))
                .transpose()?
                .flatten();
            let raw_destination = (!link.external)
                .then_some(link.raw_destination.as_deref())
                .flatten();
            let source_path = (!link.external)
                .then_some(link.source_path.as_deref())
                .flatten();
            if raw_destination.is_none() && source_path.is_none() && display_shape.is_none() {
                None
            } else {
                Some(TagShape::Link {
                    raw_destination: copy_optional_string(raw_destination, check, reserve)?,
                    source_path: copy_optional_string(source_path, check, reserve)?,
                    display_shape: boxed(display_shape, check, reserve)?,
                })
            }
        }
        _ => None,
    })
}

fn restore(
    value: &mut RuntimeValue,
    shape: &TagShape,
    depth: usize,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    visit(depth, check)?;
    match (value, shape) {
        (
            value @ (RuntimeValue::String(_) | RuntimeValue::Regex(_, _, _)),
            TagShape::Regex {
                pattern,
                flags,
                identity,
            },
        ) => {
            check(pattern.len().saturating_add(flags.len()) / 16 + 1)?;
            *value = RuntimeValue::Regex(pattern.clone(), flags.clone(), Arc::clone(identity));
        }
        (value @ RuntimeValue::String(_), TagShape::Tag) => {
            let RuntimeValue::String(text) = std::mem::replace(value, RuntimeValue::Null) else {
                unreachable!()
            };
            *value = RuntimeValue::Tag(text);
        }
        (RuntimeValue::Tag(_), TagShape::Tag) => {}
        (value @ (RuntimeValue::List(_) | RuntimeValue::TagList(_)), TagShape::TagList) => {
            let (RuntimeValue::List(mut values) | RuntimeValue::TagList(mut values)) =
                std::mem::replace(value, RuntimeValue::Null)
            else {
                unreachable!()
            };
            for value in &mut values {
                restore(value, &TagShape::Tag, depth + 1, check)?;
            }
            *value = RuntimeValue::TagList(values);
        }
        (RuntimeValue::List(values) | RuntimeValue::TagList(values), TagShape::List(shapes)) => {
            for (index, shape) in shapes {
                restore(
                    values.get_mut(*index).ok_or_else(invalid)?,
                    shape,
                    depth + 1,
                    check,
                )?;
            }
        }
        (RuntimeValue::Object(values), TagShape::Object(shapes)) => {
            for (key, shape) in shapes {
                check(key.len() / 16 + 1)?;
                restore(
                    values.get_mut(key).ok_or_else(invalid)?,
                    shape,
                    depth + 1,
                    check,
                )?;
            }
        }
        (
            RuntimeValue::Link(link),
            TagShape::Link {
                raw_destination,
                source_path,
                display_shape,
            },
        ) => {
            // Only the captured proof supplies these fields. In particular,
            // Some("") is distinct from absent constructor data.
            check(
                raw_destination
                    .as_ref()
                    .map_or(0, String::len)
                    .saturating_add(source_path.as_ref().map_or(0, String::len))
                    / 16
                    + 1,
            )?;
            link.raw_destination = raw_destination.clone();
            link.source_path = source_path.clone();
            if let Some(shape) = display_shape {
                restore(
                    link.display_value.as_deref_mut().ok_or_else(invalid)?,
                    shape,
                    depth + 1,
                    check,
                )?;
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expression::BasesLink;
    use indexmap::IndexMap;

    #[test]
    fn link_capture_restores_empty_raw_data_and_tag_display_without_authority() {
        let original = RuntimeValue::Link(BasesLink {
            path: "People/A".into(),
            raw_destination: Some(String::new()),
            source_path: Some("Folder/Source.md".into()),
            display_value: Some(Box::new(RuntimeValue::Tag("#people".into()))),
            ..Default::default()
        });
        let mut reserved = 0usize;
        let shape = capture_runtime_shape(&original, &mut |_| Ok(()), &mut |bytes| {
            reserved += bytes;
            Ok(())
        })
        .unwrap()
        .unwrap();
        assert_eq!(reserved, "Folder/Source.md".len() + size_of::<TagShape>());
        let mut restored = RuntimeValue::Link(BasesLink {
            path: "People/A".into(),
            display_value: Some(Box::new(RuntimeValue::String("#people".into()))),
            ..Default::default()
        });
        restore_runtime_shape(&mut restored, &shape, &mut |_| Ok(())).unwrap();
        let RuntimeValue::Link(link) = restored else {
            panic!("expected Link")
        };
        assert_eq!(link.raw_destination.as_deref(), Some(""));
        assert_eq!(link.source_path.as_deref(), Some("Folder/Source.md"));
        assert!(
            matches!(link.display_value.as_deref(), Some(RuntimeValue::Tag(value)) if value == "#people")
        );
        assert!(link.target.is_none());
        assert!(link.resolved_path.is_none());
    }

    #[test]
    fn capture_admits_growth_and_key_copy_before_allocating() {
        let runtime = RuntimeValue::Object(IndexMap::from([(
            "field".into(),
            RuntimeValue::Tag("#topic".into()),
        )]));
        let mut reservations = Vec::new();
        let error = capture_runtime_shape(&runtime, &mut |_| Ok(()), &mut |bytes| {
            reservations.push(bytes);
            Err(ExpressionDiagnostic::new("budget", "rejected"))
        })
        .unwrap_err();
        assert_eq!(error.code, "budget");
        assert_eq!(reservations, [4 * size_of::<(String, TagShape)>()]);

        let mut calls = 0;
        let error = capture_runtime_shape(&runtime, &mut |_| Ok(()), &mut |_| {
            calls += 1;
            if calls == 2 {
                Err(ExpressionDiagnostic::new("budget", "key rejected"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(error.code, "budget");
        assert_eq!(calls, 2);
    }

    #[test]
    fn external_links_omit_origin_proof_and_preserve_display_subclasses() {
        let mut runtime = RuntimeValue::Link(BasesLink {
            path: "https://example.test".into(),
            raw_destination: Some("https://example.test/other-spelling".into()),
            source_path: Some("Notes/Source.md".into()),
            external: true,
            ..Default::default()
        });
        assert!(
            capture_runtime_shape(&runtime, &mut |_| Ok(()), &mut |_| Ok(()))
                .unwrap()
                .is_none()
        );
        let RuntimeValue::Link(link) = &mut runtime else {
            unreachable!()
        };
        link.display_value = Some(Box::new(RuntimeValue::Tag("#website".into())));
        let shape = capture_runtime_shape(&runtime, &mut |_| Ok(()), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert!(matches!(shape, TagShape::Link {
            raw_destination: None,
            source_path: None,
            display_shape: Some(ref display),
        } if matches!(display.as_ref(), TagShape::Tag)));
        assert_eq!(
            runtime_shape_restore_bytes(&shape, &mut |_| Ok(())).unwrap(),
            0
        );
    }

    #[test]
    fn restoration_estimate_counts_only_copied_strings_and_preserves_diagnostics() {
        let shape = TagShape::Object(vec![(
            "key-not-cloned-by-restore".into(),
            TagShape::List(vec![(
                0,
                TagShape::Link {
                    raw_destination: Some("raw".into()),
                    source_path: Some(String::new()),
                    display_shape: Some(Box::new(TagShape::Link {
                        raw_destination: None,
                        source_path: Some("nested-source".into()),
                        display_shape: Some(Box::new(TagShape::Tag)),
                    })),
                },
            )]),
        )]);
        assert_eq!(
            runtime_shape_restore_bytes(&shape, &mut |_| Ok(())).unwrap(),
            "raw".len() + "nested-source".len()
        );
        let error = runtime_shape_restore_bytes(&shape, &mut |_| {
            Err(ExpressionDiagnostic::new("cancelled", "stopped"))
        })
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        let mut remaining = 2usize;
        let error = runtime_shape_restore_bytes(&shape, &mut |work| {
            remaining = remaining
                .checked_sub(work)
                .ok_or_else(|| ExpressionDiagnostic::new("budget", "work rejected"))?;
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error.code, "budget");
        let oversized = TagShape::Link {
            raw_destination: Some("x".repeat(8 * 1024 * 1024)),
            source_path: Some("extra".into()),
            display_shape: None,
        };
        let error = runtime_shape_restore_bytes(&oversized, &mut |_| Ok(())).unwrap_err();
        assert_eq!(error.code, "budget");
    }

    #[test]
    fn captured_object_keys_have_canonical_order() {
        let runtime = RuntimeValue::Object(IndexMap::from([
            ("z".into(), RuntimeValue::Tag("#z".into())),
            ("a".into(), RuntimeValue::Tag("#a".into())),
        ]));
        let shape = capture_runtime_shape(&runtime, &mut |_| Ok(()), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        let TagShape::Object(values) = shape else {
            panic!("expected Object")
        };
        assert_eq!(
            values
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            ["a", "z"]
        );
        assert!(values
            .iter()
            .all(|(_, shape)| matches!(shape, TagShape::Tag)));
    }

    #[test]
    fn regex_proof_preserves_actual_shared_identity_without_guessing_from_text() {
        let identity = Arc::new(());
        let original = RuntimeValue::Regex("same".into(), "g".into(), Arc::clone(&identity));
        let shape = capture_runtime_shape(&original, &mut |_| Ok(()), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        let TagShape::Regex {
            identity: captured, ..
        } = &shape
        else {
            panic!("expected Regex proof")
        };
        assert!(Arc::ptr_eq(&identity, captured));
        let mut restored = RuntimeValue::String("/same/g".into());
        assert!(
            capture_runtime_shape(&restored, &mut |_| Ok(()), &mut |_| Ok(()))
                .unwrap()
                .is_none()
        );
        restore_runtime_shape(&mut restored, &shape, &mut |_| Ok(())).unwrap();
        let RuntimeValue::Regex(pattern, flags, restored_identity) = restored else {
            panic!("expected restored Regex")
        };
        assert_eq!(pattern, "same");
        assert_eq!(flags, "g");
        assert!(Arc::ptr_eq(&identity, &restored_identity));
        let distinct = RuntimeValue::Regex("same".into(), "g".into(), Arc::new(()));
        let distinct_shape = capture_runtime_shape(&distinct, &mut |_| Ok(()), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        let TagShape::Regex {
            identity: distinct_identity,
            ..
        } = distinct_shape
        else {
            panic!("expected distinct Regex proof")
        };
        assert!(!Arc::ptr_eq(&identity, &distinct_identity));
        assert_eq!(
            restore_runtime_shape(&mut RuntimeValue::Number(1.0), &shape, &mut |_| Ok(()))
                .unwrap_err()
                .code,
            "input"
        );
    }

    #[test]
    fn regex_capture_and_restore_account_strings_and_retained_identity_pointer() {
        let runtime = RuntimeValue::Regex("same".into(), "g".into(), Arc::new(()));
        let mut reservations = Vec::new();
        let shape = capture_runtime_shape(&runtime, &mut |_| Ok(()), &mut |bytes| {
            reservations.push(bytes);
            Ok(())
        })
        .unwrap()
        .unwrap();
        assert_eq!(reservations, [4, 1, size_of::<Arc<()>>()]);
        assert_eq!(
            runtime_shape_restore_bytes(&shape, &mut |_| Ok(())).unwrap(),
            5 + size_of::<Arc<()>>()
        );
        let error = capture_runtime_shape(&runtime, &mut |_| Ok(()), &mut |_| {
            Err(ExpressionDiagnostic::new("budget", "copy rejected"))
        })
        .unwrap_err();
        assert_eq!(error.code, "budget");
        let mut restored = RuntimeValue::String("/same/g".into());
        let error = restore_runtime_shape(&mut restored, &shape, &mut |_| {
            Err(ExpressionDiagnostic::new("cancelled", "stopped"))
        })
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(matches!(restored, RuntimeValue::String(_)));
        let error = runtime_shape_restore_bytes(&shape, &mut |_| {
            Err(ExpressionDiagnostic::new("budget", "work rejected"))
        })
        .unwrap_err();
        assert_eq!(error.code, "budget");
    }
}
