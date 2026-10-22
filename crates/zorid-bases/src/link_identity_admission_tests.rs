//! Focused admission oracles; these exercise the new walks directly rather
//! than relying on an earlier query-wide max_steps or pre-cancel guard.
use super::*;

fn record(value: PropertyValue) -> DetachedRecord {
    DetachedRecord {
        path: "Parent/Note.md".into(),
        properties: vec![("payload".into(), value)],
        ..Default::default()
    }
}
fn timezone() -> expression::BasesTimezone {
    expression::BasesTimezone::from_setting(Some("UTC")).unwrap()
}
fn limited(work: &mut usize, maximum: usize, added: usize) -> Result<(), ExpressionDiagnostic> {
    *work = work.saturating_add(added);
    if *work > maximum {
        Err(ExpressionDiagnostic::new("budget", "test work admission"))
    } else {
        Ok(())
    }
}

#[test]
fn linkless_wide_preflight_and_binding_each_pay_per_node() {
    let source = record(PropertyValue::Array(vec![PropertyValue::Null; 4096]));
    let mut work = 0;
    let failure =
        frontmatter_link_identity_bytes(&source, &mut |added| limited(&mut work, 32, added))
            .unwrap_err();
    assert_eq!(failure.code, "budget");
    assert!(
        work > 32 && work < 40,
        "preflight stops inside the wide list"
    );
    let mut work = 0;
    let failure = runtime_file_checked(&source, &timezone(), &mut |added| {
        limited(&mut work, 32, added)
    })
    .unwrap_err();
    assert_eq!(failure.code, "budget");
    assert!(work > 32 && work < 40, "binding stops inside the wide list");
}

#[test]
fn cancellation_during_each_walk_stops_before_the_remaining_nodes() {
    let source = record(PropertyValue::Array(vec![PropertyValue::Null; 4096]));
    for binding in [false, true] {
        let cancellation = OperationCancellation::default();
        let mut work = 0usize;
        let mut check = |added| {
            work += added;
            if work >= 17 {
                cancellation.cancel();
            }
            if cancellation.is_cancelled() {
                Err(ExpressionDiagnostic::new(
                    "cancelled",
                    "test cancellation during traversal",
                ))
            } else {
                Ok(())
            }
        };
        let failure = if binding {
            runtime_file_checked(&source, &timezone(), &mut check).map(|_| 0)
        } else {
            frontmatter_link_identity_bytes(&source, &mut check)
        }
        .unwrap_err();
        assert_eq!(failure.code, "cancelled");
        assert_eq!(work, 17);
    }
}

#[test]
fn frontmatter_identity_keeps_the_existing_128_level_input_contract() {
    for depth in [90, 128, 129] {
        let mut nested = PropertyValue::Null;
        for _ in 0..depth {
            nested = PropertyValue::Array(vec![nested]);
        }
        let source = record(nested);
        let preflight = frontmatter_link_identity_bytes(&source, &mut |_| Ok(()));
        let bound = runtime_file_checked(&source, &timezone(), &mut |_| Ok(()));
        if depth <= 128 {
            assert!(preflight.is_ok(), "depth {depth}");
            assert!(bound.is_ok(), "depth {depth}: {bound:?}");
        } else {
            assert_eq!(preflight.unwrap_err().code, "budget");
            assert_eq!(bound.unwrap_err().code, "budget");
        }
    }
}

#[test]
fn short_link_owner_amplification_is_admitted_before_origin_copying() {
    let path = format!(
        "{}/Note.md",
        vec!["abcdefghijklmnoabcdefghijklmnop"; 23].join("/")
    );
    let per_link = path.len() + "[[X]]".len() + 64;
    let count = 8 * 1024 * 1024 / per_link + 1024;
    let mut source = record(PropertyValue::Array(vec![
        PropertyValue::String(
            "[[X]]".into()
        );
        count
    ]));
    source.path = path;
    assert!(
        serde_json::to_vec(&source.properties).unwrap().len() < 256 * 1024,
        "source itself is small; only copied owning paths amplify it"
    );
    let mut visited = 0usize;
    let failure = frontmatter_link_identity_bytes(&source, &mut |_| {
        visited += 1;
        Ok(())
    })
    .unwrap_err();
    assert_eq!(failure.code, "budget");
    assert!(failure.message.contains("byte budget"));
    // The control uses identical nodes and callback sites but a short owner,
    // so it can finish the same tree without the origin amplification.
    let mut control = source.clone();
    control.path = "N.md".into();
    let mut full_walk_callbacks = 0usize;
    frontmatter_link_identity_bytes(&control, &mut |_| {
        full_walk_callbacks += 1;
        Ok(())
    })
    .unwrap();
    assert!(
        visited < full_walk_callbacks,
        "preflight rejects before the identical full-tree traversal finishes"
    );
}

#[test]
fn exhausted_origin_bytes_reject_before_mutating_an_inferred_link() {
    let mut value = expression::RuntimeValue::Link(expression::BasesLink {
        path: "X".into(),
        ..Default::default()
    });
    let mut bytes = 8 * 1024 * 1024 - 1;
    let failure = bind_frontmatter_link_identity(
        &mut value,
        "Parent/Note.md",
        0,
        &mut bytes,
        &mut |_| Ok(()),
    )
    .unwrap_err();
    assert_eq!(failure.code, "budget");
    let expression::RuntimeValue::Link(link) = value else {
        panic!("link remains a link")
    };
    assert!(link.raw_destination.is_none());
    assert!(link.source_path.is_none());
}
