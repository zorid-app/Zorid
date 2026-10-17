use super::*;
fn realm() -> RealmId {
    RealmId::new("realm").unwrap()
}
fn epoch() -> ServerEpoch {
    ServerEpoch::new("epoch").unwrap()
}
fn vault() -> VaultId {
    VaultId::new("vault").unwrap()
}
fn update() -> UpdateId {
    UpdateId::new("update").unwrap()
}
fn cursor(after: u64) -> Cursor {
    Cursor::new(epoch(), LogPosition::new(after))
}
fn ack(sequence: u64) -> pb::AcceptedReply {
    accepted_reply(&Accepted::new(vault(), update(), epoch(), LogPosition::new(sequence)).unwrap())
}
fn page() -> pb::PullReply {
    pull_reply(
        vec![(LogPosition::new(1), vec![0, 255, 128, 1])],
        &cursor(1),
        LogPosition::new(2),
        false,
    )
    .unwrap()
}
#[test]
fn hello_requires_transport_two_and_exact_selected_identity_limits() {
    validate_hello_request(&hello_request()).unwrap();
    let good = hello_reply(&realm(), &epoch());
    validate_hello_reply(&good, &realm(), &epoch()).unwrap();
    assert!(validate_hello_reply(&good, &RealmId::new("other").unwrap(), &epoch()).is_err());
    for major in [None, Some(1), Some(65538)] {
        let mut value = good.clone();
        value.selected_transport_major = major;
        assert!(validate_hello_reply(&value, &realm(), &epoch()).is_err());
    }
    let mut value = good.clone();
    value.envelope_versions = vec![65537];
    assert!(validate_hello_reply(&value, &realm(), &epoch()).is_err());
    let mut value = good;
    value.max_page_wire_bytes = None;
    assert!(validate_hello_reply(&value, &realm(), &epoch()).is_err());
    let mut offer = hello_request();
    offer.offered_transport_majors = vec![65538];
    assert!(validate_hello_request(&offer).is_err());
}
#[test]
fn every_mandatory_control_and_context_must_exist() {
    let mut value = hello_request();
    value.control = None;
    assert!(validate_hello_request(&value).is_err());
    let mut value = hello_reply(&realm(), &epoch());
    value.control = None;
    assert!(validate_hello_reply(&value, &realm(), &epoch()).is_err());
    let mut value = append_request(&vault(), &update(), vec![1]).unwrap();
    value.context = None;
    assert!(validate_append_request(value).is_err());
    let mut value = append_request(&vault(), &update(), vec![1]).unwrap();
    value.context.as_mut().unwrap().control = None;
    assert!(validate_append_request(value).is_err());
    let mut value = pull_request(&vault(), &cursor(0), None, 64).unwrap();
    value.cursor.as_mut().unwrap().control = None;
    assert!(validate_pull_request(value).is_err());
    let mut value = ack(1);
    value.control = None;
    assert!(validate_accepted_reply(value, &vault(), &update(), &epoch()).is_err());
    let mut value = page();
    value.control = None;
    assert!(validate_pull_reply(value, &cursor(0), None).is_err());
    let mut value = page();
    value.next.as_mut().unwrap().control = None;
    assert!(validate_pull_reply(value, &cursor(0), None).is_err());
}
#[test]
fn zero_cursor_and_empty_snapshot_require_presence() {
    let value = pull_request(&vault(), &cursor(0), Some(LogPosition::new(0)), 64).unwrap();
    let valid = validate_pull_request(value.clone()).unwrap();
    assert_eq!(valid.cursor.after.get(), 0);
    assert_eq!(valid.through.unwrap().get(), 0);
    let mut bad = value.clone();
    bad.cursor.as_mut().unwrap().after = None;
    assert!(validate_pull_request(bad).is_err());
    let mut bad = value;
    bad.limit = None;
    assert!(validate_pull_request(bad).is_err());
    let empty = pull_reply(vec![], &cursor(0), LogPosition::new(0), true).unwrap();
    assert!(
        validate_pull_reply(empty.clone(), &cursor(0), Some(LogPosition::new(0)))
            .unwrap()
            .complete
    );
    let mut bad = empty;
    bad.through = None;
    assert!(validate_pull_reply(bad, &cursor(0), None).is_err());
}
#[test]
fn incomplete_false_is_valid_but_absence_is_not() {
    let value = page();
    let out = validate_pull_reply(value.clone(), &cursor(0), Some(LogPosition::new(2))).unwrap();
    assert!(!out.complete);
    assert_eq!(out.items[0].wire, [0, 255, 128, 1]);
    let mut bad = value;
    bad.complete = None;
    assert!(validate_pull_reply(bad, &cursor(0), None).is_err());
}
#[test]
fn accepted_identity_sequence_and_store_range_are_checked() {
    let value = ack(9_007_199_254_740_993);
    assert_eq!(
        validate_accepted_reply(value.clone(), &vault(), &update(), &epoch())
            .unwrap()
            .sequence()
            .get(),
        9_007_199_254_740_993
    );
    assert!(validate_accepted_reply(
        value.clone(),
        &VaultId::new("other").unwrap(),
        &update(),
        &epoch()
    )
    .is_err());
    assert!(validate_accepted_reply(
        value.clone(),
        &vault(),
        &update(),
        &ServerEpoch::new("other").unwrap()
    )
    .is_err());
    for sequence in [None, Some(0), Some(u64::MAX)] {
        let mut bad = value.clone();
        bad.sequence = sequence;
        assert!(validate_accepted_reply(bad, &vault(), &update(), &epoch()).is_err());
    }
}
#[test]
fn page_chain_and_requested_boundary_share_existing_rules() {
    let value = page();
    assert!(validate_pull_reply(value.clone(), &cursor(0), Some(LogPosition::new(3))).is_err());
    let mut bad = value.clone();
    bad.items[0].sequence = Some(2);
    assert!(validate_pull_reply(bad, &cursor(0), None).is_err());
    let mut bad = value.clone();
    bad.next.as_mut().unwrap().server_epoch = "other".into();
    assert!(validate_pull_reply(bad, &cursor(0), None).is_err());
    let mut bad = value.clone();
    bad.items[0].sequence = None;
    assert!(validate_pull_reply(bad, &cursor(0), None).is_err());
    let mut bad = value.clone();
    bad.items[0].exact_wire.clear();
    assert!(validate_pull_reply(bad, &cursor(0), None).is_err());
    let mut bad = value;
    bad.items = vec![pb::PullItem::default(); 65];
    assert!(validate_pull_reply(bad, &cursor(0), None).is_err());
}
#[test]
fn optional_information_is_bounded_and_cannot_require_meaning() {
    let mut value = hello_reply(&realm(), &epoch());
    value
        .control
        .as_mut()
        .unwrap()
        .optional_extensions
        .push(pb::InformationalExtension {
            key: "diagnostic".into(),
            value: vec![255; 512],
        });
    validate_hello_reply(&value, &realm(), &epoch()).unwrap();
    value.control.as_mut().unwrap().optional_extensions[0]
        .value
        .push(0);
    assert!(validate_hello_reply(&value, &realm(), &epoch()).is_err());
    for feature in ["future", "", "bad feature"] {
        let mut value = hello_request();
        value
            .control
            .as_mut()
            .unwrap()
            .required_features
            .push(feature.into());
        assert!(validate_hello_request(&value).is_err());
    }
}
#[test]
fn standard_message_merge_preserves_earlier_required_features() {
    let mut first = hello_request();
    first.control.as_mut().unwrap().required_features = vec!["future".into()];
    let second = pb::HelloRequest {
        offered_transport_majors: vec![],
        control: Some(empty_control()),
    };
    for (a, b) in [(&first, &second), (&second, &first)] {
        let mut bytes = a.encode_to_vec();
        bytes.extend(b.encode_to_vec());
        let decoded = pb::HelloRequest::decode(bytes.as_slice()).unwrap();
        assert_eq!(
            decoded.control.as_ref().unwrap().required_features,
            ["future"]
        );
        assert_eq!(
            validate_hello_request(&decoded).unwrap_err().code(),
            "sync_unsupported_protocol"
        );
    }
}
#[test]
fn standard_singular_last_value_policy_is_explicit_for_new_transport() {
    let first = ack(1);
    let mut second = pb::AcceptedReply::default();
    second.sequence = Some(2);
    let mut bytes = first.encode_to_vec();
    bytes.extend(second.encode_to_vec());
    assert_eq!(
        decode_accepted_reply(&bytes, &vault(), &update(), &epoch())
            .unwrap()
            .sequence()
            .get(),
        2
    );
}
#[test]
fn raw_body_caps_precede_decoding_and_errors_are_finite() {
    assert_eq!(
        decode_hello_reply(&vec![0; MAX_CONTROL_BYTES + 1], &realm(), &epoch())
            .unwrap_err()
            .code(),
        "sync_response_limit"
    );
    assert_eq!(
        decode_pull_reply(&vec![0; MAX_PULL_MESSAGE + 1], &cursor(0), None)
            .unwrap_err()
            .code(),
        "sync_response_limit"
    );
    for code in [0, 99] {
        assert!(decode_error_detail(&pb::ErrorDetail { code }.encode_to_vec()).is_err());
    }
    let known = pb::ErrorDetail {
        code: pb::ErrorCode::EpochMismatch as i32,
    };
    assert_eq!(decode_error_detail(&known.encode_to_vec()).unwrap(), known);
    assert!(decode_error_detail(&[0xff]).is_err());
}
#[test]
fn byte_caps_and_current_i64_sequence_domain_apply_to_requests() {
    assert!(append_request(&vault(), &update(), vec![]).is_err());
    assert!(append_request(&vault(), &update(), vec![0; MAX_WIRE_BYTES + 1]).is_err());
    let value = append_request(&vault(), &update(), vec![0, 255, 128, 1]).unwrap();
    assert_eq!(
        validate_append_request(value).unwrap().exact_wire,
        [0, 255, 128, 1]
    );
    assert!(pull_request(&vault(), &cursor(u64::MAX), None, 64).is_err());
    assert!(pull_request(&vault(), &cursor(2), Some(LogPosition::new(1)), 64).is_err());
}

#[test]
fn standard_recursion_limit_rejects_deep_unknown_groups() {
    let fixture = |depth| {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../proto/fixtures/rpc-hello-groups-{depth}.bin")),
        )
        .unwrap()
    };
    let shallow = fixture(8);
    let deep = fixture(128);
    assert!(shallow.len() <= MAX_CONTROL_BYTES && deep.len() <= MAX_CONTROL_BYTES);
    let hello = pb::HelloRequest::decode(shallow.as_slice()).unwrap();
    validate_hello_request(&hello).unwrap();
    let failure = pb::HelloRequest::decode(deep.as_slice()).unwrap_err();
    assert!(failure.to_string().contains("recursion"), "{failure}");
}
