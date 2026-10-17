use zorid_sync_protocol::*;

fn header() -> Header {
    Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        UpdateId::new("update").unwrap(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap()
}
fn changed(field: &str, value: serde_json::Value) -> Vec<u8> {
    let mut raw: serde_json::Value = serde_json::from_slice(&header().encode().unwrap()).unwrap();
    raw[field] = value;
    serde_json::to_vec(&raw).unwrap()
}
#[test]
fn rejects_unsupported_semantics_but_preserves_optional_extensions() {
    assert_eq!(
        Header::decode(&changed("envelope_version", 2.into())).unwrap_err(),
        ProtocolError::UnsupportedEnvelope
    );
    let future = Header::decode(&changed("document_format_version", u32::MAX.into())).unwrap();
    assert_eq!(future.document_format_version(), u32::MAX);
    assert_eq!(
        future.require_supported_document_format(),
        Err(ProtocolError::UnsupportedDocumentFormat)
    );
    assert!(Header::decode(&changed("document_format_version", 0.into())).is_err());
    assert!(Header::decode(&changed(
        "document_format_version",
        (u64::from(u32::MAX) + 1).into()
    ))
    .is_err());
    assert_eq!(
        Header::decode(&changed(
            "required_features",
            serde_json::json!(["future-delete-rules"])
        ))
        .unwrap_err(),
        ProtocolError::UnsupportedRequiredFeature
    );
    for (field, value) in [
        ("key_epoch", 0.into()),
        ("purpose", "other".into()),
        ("suite", "plaintext".into()),
        ("force", true.into()),
        ("vault_id", "../secret".into()),
    ] {
        assert!(Header::decode(&changed(field, value)).is_err());
    }
    let bytes = changed(
        "optional_extensions",
        serde_json::json!({"future-display-hint":{"color":"blue"}}),
    );
    let envelope = Envelope::from_parts(&bytes, [1; 24], &[0; 16]).unwrap();
    assert_eq!(envelope.header_bytes(), bytes);
    assert_eq!(
        Envelope::decode(&envelope.encode()).unwrap().header_bytes(),
        bytes
    );
    assert_eq!(negotiate_transport(&[9, 1]).unwrap(), 1);
    assert_eq!(
        negotiate_transport(&[9]).unwrap_err(),
        ProtocolError::UnsupportedTransport
    );
}
#[test]
fn raw_size_and_frame_lengths_are_checked_before_parsing() {
    assert_eq!(
        Header::decode(&vec![b' '; MAX_HEADER_BYTES + 1]).unwrap_err(),
        ProtocolError::TooLarge
    );
    assert!(matches!(
        Envelope::decode(&vec![0; MAX_WIRE_BYTES + 1]),
        Err(ProtocolError::TooLarge)
    ));
    let mut wire = b"ZSE1".to_vec();
    wire.extend_from_slice(&u32::MAX.to_be_bytes());
    wire.extend_from_slice(&[0; 40]);
    assert!(matches!(
        Envelope::decode(&wire),
        Err(ProtocolError::TooLarge)
    ));
    let good = Envelope::from_parts(&header().encode().unwrap(), [0; 24], &[0; 16])
        .unwrap()
        .encode();
    for cut in 0..good.len() {
        assert!(
            Envelope::decode(&good[..cut]).is_err(),
            "accepted truncated frame {cut}"
        );
    }
    assert!(Envelope::from_parts(&header().encode().unwrap(), [0; 24], &[0; 15]).is_err());
    assert!(Envelope::from_parts(
        &header().encode().unwrap(),
        [0; 24],
        &vec![0; MAX_PLAINTEXT_BYTES + TAG_BYTES + 1]
    )
    .is_err());
}
#[test]
fn exact_header_spelling_and_retry_bytes_are_preserved() {
    let pretty = serde_json::to_vec_pretty(
        &serde_json::from_slice::<serde_json::Value>(&header().encode().unwrap()).unwrap(),
    )
    .unwrap();
    let first = Envelope::from_parts(&pretty, [3; 24], &[4; 16]).unwrap();
    let decoded = Envelope::decode(&first.encode()).unwrap();
    assert_eq!(decoded.header_bytes(), pretty);
    first.check_retry(&decoded).unwrap();
    let same_fields_different_aad =
        Envelope::from_parts(&header().encode().unwrap(), [3; 24], &[4; 16]).unwrap();
    assert_eq!(
        first.check_retry(&same_fields_different_aad).unwrap_err(),
        ProtocolError::IdempotencyConflict
    );
    let different_nonce = Envelope::from_parts(&pretty, [9; 24], &[4; 16]).unwrap();
    assert_eq!(
        first.check_retry(&different_nonce).unwrap_err(),
        ProtocolError::IdempotencyConflict
    );
}
#[test]
fn sequence_cursor_and_ack_do_not_confuse_epoch_or_round_in_javascript() {
    let cursor = Cursor::new(ServerEpoch::new("old").unwrap(), LogPosition::new(u64::MAX));
    let bytes = serde_json::to_vec(&cursor).unwrap();
    assert!(std::str::from_utf8(&bytes)
        .unwrap()
        .contains("\"18446744073709551615\""));
    assert_eq!(Cursor::decode(&bytes).unwrap(), cursor);
    assert_eq!(
        cursor
            .check_epoch(&ServerEpoch::new("restored").unwrap())
            .unwrap_err(),
        ProtocolError::EpochMismatch
    );
    for bad in [
        serde_json::json!(12),
        "01".into(),
        "-1".into(),
        "18446744073709551616".into(),
    ] {
        assert!(Cursor::decode(
            &serde_json::to_vec(&serde_json::json!({"server_epoch":"old","after":bad})).unwrap()
        )
        .is_err());
    }
    assert!(Accepted::decode(
        br#"{"vault_id":"v","update_id":"u","server_epoch":"e","sequence":"0"}"#
    )
    .is_err());
    let ack = Accepted::new(
        VaultId::new("v").unwrap(),
        UpdateId::new("u").unwrap(),
        ServerEpoch::new("e").unwrap(),
        LogPosition::new(1),
    )
    .unwrap();
    assert_eq!(
        Accepted::decode(&serde_json::to_vec(&ack).unwrap()).unwrap(),
        ack
    );
    assert_eq!(
        ack.check_target(
            &VaultId::new("other").unwrap(),
            &UpdateId::new("u").unwrap(),
            &ServerEpoch::new("e").unwrap()
        ),
        Err(ProtocolError::ContextMismatch)
    );
}

#[test]
fn control_optional_additions_are_retained_but_required_changes_fail() {
    let cursor = serde_json::json!({"server_epoch":"e","after":"0","extensions":{"optional_extensions":{"future_hint":"ok"}}});
    let decoded = Cursor::decode(&serde_json::to_vec(&cursor).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(decoded).unwrap()["extensions"]["optional_extensions"]["future_hint"],
        "ok"
    );
    let ack = serde_json::json!({"vault_id":"v","update_id":"u","server_epoch":"e","sequence":"1","extensions":{"optional_extensions":{"future_hint":true}}});
    assert!(Accepted::decode(&serde_json::to_vec(&ack).unwrap()).is_ok());
    for mut input in [cursor, ack] {
        input["extensions"]["required_features"] = serde_json::json!(["future-ordering"]);
        let bytes = serde_json::to_vec(&input).unwrap();
        assert!(Cursor::decode(&bytes).is_err());
        assert!(Accepted::decode(&bytes).is_err());
    }
    assert_eq!(
        Cursor::decode(&vec![b' '; MAX_CONTROL_BYTES + 1]).unwrap_err(),
        ProtocolError::TooLarge
    );
    assert_eq!(
        Accepted::decode(&vec![b' '; MAX_CONTROL_BYTES + 1]).unwrap_err(),
        ProtocolError::TooLarge
    );
    assert_eq!(negotiate_transport(&[1; 17]), Err(ProtocolError::TooLarge));
}

#[test]
fn standalone_control_extensions_share_compatibility_policy_and_bounds() {
    assert_eq!(
        ControlExtensions::decode(b"{}").unwrap(),
        ControlExtensions::default()
    );
    let optional = serde_json::json!({"required_features":[],"optional_extensions":{"future_hint":{"nested":[true,42,"ok"]}}});
    let extensions = ControlExtensions::decode(&serde_json::to_vec(&optional).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(extensions).unwrap(), optional);
    assert_eq!(
        ControlExtensions::decode(br#"{"required_features":["future-ordering"]}"#).unwrap_err(),
        ProtocolError::UnsupportedRequiredFeature
    );
    for invalid in [
        br#"{"unknown_required_field":true}"#.as_slice(),
        br#"{"required_features":[],"required_features":[]}"#.as_slice(),
        br#"{"optional_extensions":{"":true}}"#.as_slice(),
        b"null".as_slice(),
    ] {
        assert_eq!(
            ControlExtensions::decode(invalid).unwrap_err(),
            ProtocolError::InvalidHeader
        );
    }
    let mut fields = serde_json::Map::new();
    for index in 0..16 {
        fields.insert(format!("hint-{index}"), true.into());
    }
    let accepted = serde_json::json!({"optional_extensions":fields});
    assert!(ControlExtensions::decode(&serde_json::to_vec(&accepted).unwrap()).is_ok());
    fields.insert("seventeenth".into(), true.into());
    assert_eq!(
        ControlExtensions::decode(
            &serde_json::to_vec(&serde_json::json!({"optional_extensions":fields})).unwrap()
        )
        .unwrap_err(),
        ProtocolError::InvalidHeader
    );
    for (length, valid) in [(64, true), (65, false)] {
        let input = serde_json::json!({"optional_extensions":{ "x".repeat(length):true }});
        assert_eq!(
            ControlExtensions::decode(&serde_json::to_vec(&input).unwrap()).is_ok(),
            valid
        );
    }
    // Whitespace makes valid JSON exactly the accepted input bound, then one
    // byte over. Malformed oversized JSON must also fail before parsing.
    let mut boundary = b"{}".to_vec();
    boundary.resize(MAX_CONTROL_BYTES, b' ');
    assert!(ControlExtensions::decode(&boundary).is_ok());
    boundary.push(b' ');
    assert_eq!(
        ControlExtensions::decode(&boundary).unwrap_err(),
        ProtocolError::TooLarge
    );
    assert_eq!(
        ControlExtensions::decode(&vec![b'!'; MAX_CONTROL_BYTES + 1]).unwrap_err(),
        ProtocolError::TooLarge
    );
}
