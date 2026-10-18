use super::*;
use zorid_records::{Action, Cell, Field, Kind, Policy};
use zorid_sync_protocol::{DeviceId, Header, RealmId, UpdateId, VaultId};
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn fixture(policy: Policy) -> Facts {
    let r = Registration {
        realm: id("r"),
        vault: id("v"),
        owner: id("owner!"),
        schema: zorid_records::Schema {
            collection: id("c"),
            version: 1,
            policy,
            fields: std::collections::BTreeMap::from([(
                id("integer"),
                Field {
                    kind: Kind::Integer,
                    required: false,
                    nullable: false,
                    default: None,
                },
            )]),
        },
    };
    let scope = Scope {
        realm: id("r"),
        vault: id("v"),
        owner: id("owner!"),
        collection: id("c"),
        record: id("record!"),
        generation: id("create"),
        restores: None,
    };
    let state = State::new(r.schema.clone(), scope.clone()).unwrap();
    Facts {
        registration: Some(text(encode(&r).unwrap()).unwrap()),
        registration_revision: Some("registration-revision".into()),
        scope,
        accepted: None,
        restore_source: None,
        operation_sources: vec![],
        local: Some(Local {
            operation: id("create"),
            expected_revision: Sha256Digest::of(&state.snapshot().unwrap()).0,
            prior_request: None,
            prior_result: None,
        }),
        usage: Usage {
            records: "0".into(),
            state_bytes: "0".into(),
            replaced_bytes: "0".into(),
            receipts: "0".into(),
            receipt_bytes: "0".into(),
            operation_bytes: "0".into(),
            local_operations: "0".into(),
            local_bytes: "0".into(),
            changes: "0".into(),
        },
        receipt: None,
        cursor: Some(Cursor {
            epoch: "server_epoch-uuid".into(),
            position: "0".into(),
        }),
    }
}
fn raw_scope(scope: &Scope) -> String {
    text(encode(scope).unwrap()).unwrap()
}
fn raw(f: &Facts) -> String {
    text(encode(f).unwrap()).unwrap()
}
fn command_bytes(n: i64) -> Vec<u8> {
    encode(&Command::Create(vec![Action::Write {
        field: id("integer"),
        cell: Cell::Value(zorid_records::Value::Integer(n)),
    }]))
    .unwrap()
}
fn local(f: &Facts, n: i64) -> RecordsPlan {
    prepare_local_inner(&raw(f), &command_bytes(n)).unwrap()
}
fn payload(plan: &RecordsPlan) -> Payload {
    Payload::decode(plan.payload.as_ref().unwrap()).unwrap()
}
fn opened(p: &Payload) -> crate::sync::WasmSyncUpdate {
    let key = zorid_crypto::VaultKey::from_bytes([9; 32]);
    let header = Header::new(
        RealmId::new("r").unwrap(),
        VaultId::new("v").unwrap(),
        UpdateId::new(p.id().as_str()).unwrap(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        &p.encode().unwrap(),
        &key,
        &mut zorid_crypto::SystemEntropy,
    )
    .unwrap()
    .encode();
    crate::sync::open_update(
        &key,
        r#"{"realm_id":"r","vault_id":"v","update_id":"create","key_epoch":1}"#,
        &wire,
    )
    .unwrap()
}
#[test]
fn local_integer_extremes_remain_exact_in_state_projection_payload_and_request() {
    for n in [i64::MIN, i64::MAX] {
        let f = fixture(Policy::Synced);
        let plan = local(&f, n);
        for bytes in [
            plan.state.as_ref().unwrap(),
            plan.projection.as_ref().unwrap(),
            plan.payload.as_ref().unwrap(),
            plan.request.as_ref().unwrap(),
        ] {
            assert!(std::str::from_utf8(bytes).unwrap().contains(&n.to_string()));
        }
        assert_eq!(payload(&plan).scope(), &f.scope);
        let metadata: serde_json::Value =
            serde_json::from_str(plan.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(metadata["format_version"], 1);
        assert_eq!(metadata["family"], "records");
        assert!(metadata["text_binding"].is_null());
        assert!(plan.bindings[0].content.contains(&n.to_string()));
        assert_eq!(
            canonical_local_request(
                f.registration.as_ref().unwrap().as_bytes(),
                &raw_scope(&f.scope),
                "create",
                &f.local.as_ref().unwrap().expected_revision,
                &command_bytes(n)
            )
            .unwrap(),
            *plan.request.as_ref().unwrap()
        );
    }
}
#[test]
fn local_cache_do_not_emit_sync_work_but_keep_request_and_commitments() {
    for policy in [Policy::Local, Policy::Cache] {
        let plan = local(&fixture(policy), 7);
        assert!(plan.payload.is_none());
        assert!(plan.metadata.is_none());
        assert!(plan.request.is_some());
        assert_eq!(plan.bindings.len(), 1);
    }
}
#[test]
fn local_exact_replay_precedes_stale_state_restore_and_quota_checks() {
    let mut f = fixture(Policy::Local);
    let original = local(&f, 7);
    let result = encode(&Commit {
        operation: id("create"),
        revision: Sha256Digest(original.output.revision.unwrap()),
        sequence: "9007199254740993".into(),
    })
    .unwrap();
    assert_eq!(
        finalize_local_result(
            "create",
            &original.output.revision.unwrap(),
            "9007199254740993"
        )
        .unwrap(),
        result
    );
    let l = f.local.as_mut().unwrap();
    l.prior_request = Some(text(original.request.unwrap()).unwrap());
    l.prior_result = Some(text(result.clone()).unwrap());
    f.accepted = Some("invalid current state must not be decoded on exact replay".into());
    f.restore_source = Some("invalid restore".into());
    f.usage.local_bytes = u64::MAX.to_string();
    f.usage.local_operations = u64::MAX.to_string();
    let replay = local(&f, 7);
    assert_eq!(replay.output.replay_result.unwrap().as_bytes(), result);
    assert!(replay.state.is_none());
    assert!(replay.payload.is_none());
    assert!(replay.bindings.is_empty());
    assert!(prepare_local_inner(&raw(&f), &command_bytes(8))
        .err()
        .unwrap()
        .contains("collision"));
}
#[test]
fn real_aead_open_gives_records_only_capability_and_no_graph_descriptor() {
    let f = fixture(Policy::Synced);
    let plan = local(&f, i64::MAX);
    let p = payload(&plan);
    let update = opened(&p);
    assert!(update.matches_payload(plan.payload.as_ref().unwrap()));
    assert_eq!(update.exact_plaintext(), *plan.payload.as_ref().unwrap());
    let descriptor: serde_json::Value =
        serde_json::from_str(&update.authenticated_descriptor_json().unwrap()).unwrap();
    assert_eq!(descriptor["kind"], "records");
    assert!(descriptor["record"].is_null());
    assert!(descriptor["activity"].is_null());
    assert!(descriptor["summary_digest"].is_null());
    let mut remote = f.clone();
    remote.local = None;
    let received = prepare_received(&p, &raw(&remote)).unwrap();
    assert_eq!(received.output.status, Status::Accepted);
    assert_eq!(received.state, plan.state);
    let set: serde_json::Value =
        serde_json::from_str(&update.records_read_set_json().unwrap()).unwrap();
    assert_eq!(set["operations"], serde_json::json!(["create"]));
    assert_eq!(set["scope"]["owner"], "owner!");
}
#[test]
fn commitment_forks_gate_before_registration_and_list_all_affected_updates() {
    let mut f = fixture(Policy::Synced);
    let p = payload(&local(&f, 1));
    f.local = None;
    f.registration = Some("corrupt later registration must not be read".into());
    let content = bindings(&p).unwrap()[0].content.clone();
    f.operation_sources = vec![
        Binding {
            operation: id("create"),
            update: id("a"),
            content: content.clone(),
        },
        Binding {
            operation: id("create"),
            update: id("b"),
            content: content.replace("\"value\":1", "\"value\":2"),
        },
    ];
    let plan = prepare_received(&p, &raw(&f)).unwrap();
    assert_eq!(plan.output.status, Status::IntegrityConflict);
    assert_eq!(plan.output.conflicting_updates, vec!["a", "b", "create"]);
    assert!(plan.state.is_none());
}
#[test]
fn facts_cas_observes_added_removed_commitments_and_cursor_with_same_state() {
    let mut f = fixture(Policy::Synced);
    let plan = local(&f, 7);
    let expected = plan.expected.as_ref().unwrap();
    assert_eq!(expected, &facts(&raw(&f)).unwrap());
    f.operation_sources = plan.bindings.clone();
    assert_ne!(expected, &facts(&raw(&f)).unwrap());
    f.operation_sources.clear();
    f.cursor.as_mut().unwrap().position = "1".into();
    assert_ne!(expected, &facts(&raw(&f)).unwrap());
}
#[test]
fn received_missing_registration_and_source_quota_preserve_no_candidate_state() {
    let mut f = fixture(Policy::Synced);
    let p = payload(&local(&f, 1));
    f.local = None;
    f.registration = None;
    let plan = prepare_received(&p, &raw(&f)).unwrap();
    assert_eq!(plan.output.status, Status::MissingRegistration);
    assert!(plan.state.is_none());
    f.usage.operation_bytes = admission::MAX_RECEIPT_BYTES.to_string();
    assert!(prepare_received(&p, &raw(&f)).is_err());
}
#[test]
fn received_state_capacity_is_retained_and_local_capacity_is_error() {
    let mut f = fixture(Policy::Synced);
    let p = payload(&local(&f, 1));
    f.usage.records = "1024".into();
    assert!(prepare_local_inner(&raw(&f), &command_bytes(1)).is_err());
    f.local = None;
    assert_eq!(
        prepare_received(&p, &raw(&f)).unwrap().output.status,
        Status::Capacity
    );
}
#[test]
fn received_duplicate_retry_does_not_recharge_receipt_or_source_quota() {
    let mut f = fixture(Policy::Synced);
    let p = payload(&local(&f, 1));
    f.local = None;
    f.receipt = Some(Receipt {
        status: Status::MissingRegistration,
        revision: "opaque-receipt-uuid".into(),
    });
    f.usage.operation_bytes = admission::MAX_RECEIPT_BYTES.to_string();
    f.usage.receipt_bytes = admission::MAX_RECEIPT_BYTES.to_string();
    f.usage.receipts = "4096".into();
    assert_eq!(
        prepare_received(&p, &raw(&f)).unwrap().output.status,
        Status::Accepted
    );
}

#[test]
fn stored_operation_validator_rejects_same_length_corruption_scope_and_static_shape() {
    let f = fixture(Policy::Synced);
    let plan = local(&f, i64::MAX);
    let binding = &plan.bindings[0];
    let scope = raw_scope(&f.scope);
    assert!(validate_stored_operation_inner(
        &scope,
        "create",
        "create",
        binding.content.as_bytes()
    )
    .is_ok());
    let damaged = binding.content.replacen("Integer", "IntegeX", 1);
    assert_eq!(damaged.len(), binding.content.len());
    assert!(
        validate_stored_operation_inner(&scope, "create", "create", damaged.as_bytes()).is_err()
    );
    assert!(
        validate_stored_operation_inner(&scope, "wrong", "create", binding.content.as_bytes())
            .is_err()
    );
    let mut other = f.scope.clone();
    other.record = id("other");
    assert!(validate_stored_operation_inner(
        &raw_scope(&other),
        "create",
        "create",
        binding.content.as_bytes()
    )
    .is_err());
    let mut op: zorid_records::Operation = serde_json::from_str(&binding.content).unwrap();
    op.parents.push(id("self"));
    assert!(
        validate_stored_operation_inner(&scope, "create", "create", &encode(&op).unwrap()).is_err()
    );
}
#[test]
fn stored_replay_validator_keeps_exact_i64_and_rejects_corrupt_identity_digest_and_sequence() {
    let f = fixture(Policy::Local);
    let plan = local(&f, i64::MIN);
    let collection = r#"{"realmId":"r","vaultId":"v","owner":"owner!","collection":"c"}"#;
    let request = plan.request.as_ref().unwrap();
    let result =
        finalize_local_result("create", &plan.output.revision.unwrap(), "9007199254740993")
            .unwrap();
    assert!(validate_stored_replay_inner(collection, "create", request, &result).is_ok());
    let wrong_collection = collection.replace("owner!", "owner?");
    assert!(validate_stored_replay_inner(&wrong_collection, "create", request, &result).is_err());
    assert!(validate_stored_replay_inner(collection, "other", request, &result).is_err());
    for changed in [
        String::from_utf8(result.clone())
            .unwrap()
            .replace("9007199254740993", "900719925474099X"),
        String::from_utf8(result.clone())
            .unwrap()
            .replace("9007199254740993", "9223372036854775808"),
        String::from_utf8(result.clone())
            .unwrap()
            .replace("9007199254740993", "0"),
        String::from_utf8(result.clone())
            .unwrap()
            .replace("\"revision\":[", "\"revision\":[0,"),
    ] {
        assert!(
            validate_stored_replay_inner(collection, "create", request, changed.as_bytes())
                .is_err()
        );
    }
    let damaged = std::str::from_utf8(request)
        .unwrap()
        .replace("Integer", "IntegeX");
    assert!(
        validate_stored_replay_inner(collection, "create", damaged.as_bytes(), &result).is_err()
    );
}

#[test]
fn stored_operation_validation_retains_conflicting_restore_links_under_same_row_key() {
    let f = fixture(Policy::Synced);
    let plan = local(&f, 1);
    let mut op: zorid_records::Operation = serde_json::from_str(&plan.bindings[0].content).unwrap();
    for prior in ["old-generation-a", "old-generation-b"] {
        op.scope.restores = Some(id(prior));
        assert!(validate_stored_operation_inner(
            &raw_scope(&f.scope),
            "create",
            "create",
            &encode(&op).unwrap()
        )
        .is_ok());
    }
    op.scope.restores = Some(id("create"));
    assert!(validate_stored_operation_inner(
        &raw_scope(&f.scope),
        "create",
        "create",
        &encode(&op).unwrap()
    )
    .is_err());
}

#[test]
fn binding_provenance_rejects_canonical_same_length_value_change_and_wrong_source() {
    let f = fixture(Policy::Synced);
    let plan = local(&f, 1);
    let content = plan.bindings[0].content.as_bytes();
    let evidence=serde_json::json!({"payload":std::str::from_utf8(plan.payload.as_ref().unwrap()).unwrap(),"registration":null,"accepted":null}).to_string();
    let scope = raw_scope(&f.scope);
    assert!(validate_stored_binding_inner(&scope, "create", "create", content, &evidence).is_ok());
    let changed = std::str::from_utf8(content)
        .unwrap()
        .replace("\"value\":1", "\"value\":2");
    assert_eq!(changed.len(), content.len());
    assert!(
        validate_stored_operation_inner(&scope, "create", "create", changed.as_bytes()).is_ok()
    );
    assert!(validate_stored_binding_inner(
        &scope,
        "create",
        "create",
        changed.as_bytes(),
        &evidence
    )
    .is_err());
    assert!(
        validate_stored_binding_inner(&scope, "create", "wrong-update", content, &evidence)
            .is_err()
    );
    let wrong_payload = local(&f, 2).payload.unwrap();
    let wrong=serde_json::json!({"payload":std::str::from_utf8(&wrong_payload).unwrap(),"registration":null,"accepted":null}).to_string();
    assert!(validate_stored_binding_inner(&scope, "create", "create", content, &wrong).is_err());
}
#[test]
fn local_cache_binding_provenance_requires_exact_complete_history_and_policy() {
    for policy in [Policy::Local, Policy::Cache] {
        let f = fixture(policy);
        let plan = local(&f, i64::MIN);
        let scope = raw_scope(&f.scope);
        let evidence=serde_json::json!({"payload":null,"registration":f.registration,"accepted":std::str::from_utf8(plan.state.as_ref().unwrap()).unwrap()}).to_string();
        let content = plan.bindings[0].content.as_bytes();
        assert!(
            validate_stored_binding_inner(&scope, "create", "create", content, &evidence).is_ok()
        );
        let changed = std::str::from_utf8(content)
            .unwrap()
            .replace("-9223372036854775808", "-9223372036854775807");
        assert!(validate_stored_binding_inner(
            &scope,
            "create",
            "create",
            changed.as_bytes(),
            &evidence
        )
        .is_err());
        assert!(validate_stored_binding_inner(
            &scope,
            "create",
            "wrong-update",
            content,
            &evidence
        )
        .is_err());
        let missing =
            serde_json::json!({"payload":null,"registration":f.registration,"accepted":null})
                .to_string();
        assert!(
            validate_stored_binding_inner(&scope, "create", "create", content, &missing).is_err()
        );
    }
    let f = fixture(Policy::Synced);
    let plan = local(&f, 1);
    let evidence=serde_json::json!({"payload":null,"registration":f.registration,"accepted":std::str::from_utf8(plan.state.as_ref().unwrap()).unwrap()}).to_string();
    assert!(validate_stored_binding_inner(
        &raw_scope(&f.scope),
        "create",
        "create",
        plan.bindings[0].content.as_bytes(),
        &evidence
    )
    .is_err());
}
