use super::*;

fn eval(source: &str) -> BaseValue {
    evaluate(source, &BasesEvaluationContext::default())
        .unwrap()
        .value
}

#[test]
fn raw_destinations_preserve_explicit_heading_and_block_fragments() {
    for (destination, expected) in [
        ("Ada#Biography", Some("#Biography")),
        ("Ada#^block-id", Some("#^block-id")),
        ("A%23B.md#Heading%20One", Some("#Heading%20One")),
        ("A%23B.md", None),
        ("Ada#", Some("#")),
    ] {
        let value = eval(&format!(
            "link({})",
            serde_json::to_string(destination).unwrap()
        ));
        assert!(
            matches!(&value, BaseValue::Link {path, subpath, ..} if path == destination && subpath.as_deref() == expected)
        );
        let inferred = wikilink(&format!("[[{destination}|Alias]]")).unwrap();
        assert_eq!(inferred.path, destination);
        assert_eq!(inferred.subpath.as_deref(), expected);
    }
}

#[test]
fn file_identity_literal_hash_does_not_gain_a_fragment_after_typed_roundtrip() {
    let witness = crate::RecordWitness {
        entry_id: crate::EntryId::new("literal-hash").unwrap(),
        revision: crate::Revision::new("r1").unwrap(),
    };
    let context = BasesEvaluationContext {
        file: BasesFile {
            path: "A#B.md".into(),
            witness: Some(witness.clone()),
            ..Default::default()
        },
        ..Default::default()
    };
    for source in ["file.asLink()", "link(file)"] {
        let value = evaluate(source, &context).unwrap().value;
        assert!(
            matches!(&value, BaseValue::Link {path, target: Some(target), subpath: None, ..} if path == "A#B.md" && target == &witness)
        );
        let wire = serde_json::to_value(&value).unwrap();
        assert!(wire.get("subpath").is_none());
        let decoded: BaseValue = serde_json::from_value(wire).unwrap();
        let roundtrip = runtime_from_base_value(&decoded, &BasesTimezone::Utc)
            .and_then(typed_result)
            .unwrap();
        assert_eq!(
            roundtrip, value,
            "A witnessed literal hash must remain a filename after a DTO/runtime roundtrip"
        );
    }
}

#[test]
fn typed_and_shared_input_roundtrips_keep_fragment_metadata_explicit() {
    let value = eval("link('A%23B.md#^block', 'Alias')");
    let wire = serde_json::to_value(&value).unwrap();
    assert_eq!(wire["subpath"], "#^block");
    let decoded: BaseValue = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(
        runtime_from_base_value(&decoded, &BasesTimezone::Utc)
            .and_then(typed_result)
            .unwrap(),
        value
    );
    let shared = runtime_link_from_json(
        &serde_json::json!({"type":"Link","value":{"path":"A%23B.md#^block","subpath":"#^block"}}),
    )
    .unwrap();
    assert_eq!(shared.subpath.as_deref(), Some("#^block"));
    let explicit_file_path = runtime_link_from_json(
        &serde_json::json!({"type":"Link","value":{"path":"A#B.md","subpath":null}}),
    )
    .unwrap();
    assert!(explicit_file_path.subpath.is_none());
    let legacy_shared =
        runtime_link_from_json(&serde_json::json!({"type":"Link","value":{"path":"A#B.md"}}))
            .unwrap();
    assert!(legacy_shared.subpath.is_none());
    let mut legacy = wire;
    legacy.as_object_mut().unwrap().remove("subpath");
    assert!(
        matches!(
            serde_json::from_value::<BaseValue>(legacy).unwrap(),
            BaseValue::Link { subpath: None, .. }
        ),
        "Legacy typed values never authorize a guessed heading"
    );
    for invalid in ["Heading", "", "/Other.md"] {
        let mut bad = serde_json::to_value(&value).unwrap();
        bad["subpath"] = invalid.into();
        assert!(serde_json::from_value::<BaseValue>(bad).is_err());
    }
}

#[test]
fn fragment_payload_is_charged_by_runtime_and_preview_admission() {
    let value = BaseValue::Link {
        path: "A.md".into(),
        target: None,
        subpath: Some(format!("#{}", "x".repeat(4096))),
        display: None,
        display_value: None,
        external: false,
    };
    let mut admission =
        crate::preview::PreviewAdmission::new(1024, &crate::QueryOptions::default()).unwrap();
    assert_eq!(
        crate::preview::value_bytes(&value, &mut admission)
            .unwrap_err()
            .code,
        "budget"
    );
    let runtime = runtime_from_base_value(&value, &BasesTimezone::Utc).unwrap();
    assert!(value_bytes(&runtime).unwrap() >= 4097);
}
