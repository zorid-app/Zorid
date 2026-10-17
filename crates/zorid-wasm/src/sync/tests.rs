use super::*;
use serde_json::json;
use zorid_core::{EntryId, EntryKind};
use zorid_crypto::{CryptoError, EntropySource, VaultKey};
use zorid_file_sync::{EntryIdentity, Family, Location, Scope};
use zorid_sync_protocol::{DeviceId, Header, RealmId, UpdateId, VaultId};
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn fixture() -> (TextState, files::State, serde_json::Value) {
    let realm = RealmId::new("realm").unwrap();
    let vault = VaultId::new("vault").unwrap();
    let entry = EntryId::new("note").unwrap();
    let text = TextState::empty(
        TextIdentity {
            realm_id: realm.clone(),
            vault_id: vault.clone(),
            entry_id: entry.clone(),
            bootstrap_id: id("text-seed"),
        },
        rev("text-0"),
    );
    let scope = Scope {
        realm_id: realm,
        vault_id: vault,
    };
    let empty = files::State::empty(scope.clone(), rev("graph-0"));
    let payload = files::Payload {
        family: Family::Files,
        format_version: 2,
        scope,
        id: id("create"),
        body: files::Body::Events {
            events: vec![files::EntryEvent {
                id: id("create"),
                identity: EntryIdentity {
                    entry_id: entry,
                    bootstrap_id: id("create"),
                },
                parents: vec![],
                effect: files::Effect::Create {
                    entry_kind: EntryKind::File,
                    location: Location {
                        parent: None,
                        name: "note.md".into(),
                    },
                    content: Some(files::ContentSeed::Text {
                        text_bootstrap_id: id("text-seed"),
                        text_format: 2,
                    }),
                },
            }],
        },
    };
    let graph = files::plan_authored(&empty, &payload, rev("graph-1"))
        .unwrap()
        .graph
        .next_state
        .unwrap();
    let input = json!({"state":text,"namespace_state":graph,"request":{
        "expected_version":"text-0","next_version":"text-1","update_id":"edit","actor":{"actor":9,"owner":{"replica_id":"replica","incarnation_id":"incarnation"}},"edits":[]},
        "namespace":{"bootstrap_id":"create","parents":["create"]},"next_namespace_version":"graph-2"});
    (text, graph, input)
}
struct Entropy;
impl EntropySource for Entropy {
    fn fill(&mut self, bytes: &mut [u8]) -> std::result::Result<(), CryptoError> {
        bytes.fill(7);
        Ok(())
    }
}
#[test]
fn author_plans_both_domains_and_fences_both() {
    let (text, graph, input) = fixture();
    let plan = replace(&input.to_string(), b"hello").unwrap();
    assert_eq!(plan.text.materialized_utf8, b"hello");
    assert!(plan
        .graph
        .next_state
        .as_ref()
        .unwrap()
        .activities()
        .contains_key(&id("edit")));
    let mut check = json!({"state":text,"namespace_state":graph,"update_id_unused":true});
    plan.check(&check.to_string()).unwrap();
    check["state"]["version"] = json!("stale");
    assert!(plan.check(&check.to_string()).is_err());
    check["state"]["version"] = json!("text-0");
    check["namespace_state"]["version"] = json!("stale");
    assert!(plan.check(&check.to_string()).is_err());
    check["namespace_state"]["version"] = json!("graph-1");
    check["update_id_unused"] = json!(false);
    assert!(plan.check(&check.to_string()).is_err());
    let mut invalid = input;
    invalid["namespace"]["parents"] = json!(["missing"]);
    assert!(replace(&invalid.to_string(), b"hello").is_err());
}
#[test]
fn receive_authenticates_and_plans_same_activity_without_echo() {
    let (text, graph, input) = fixture();
    let authored = replace(&input.to_string(), b"hello").unwrap();
    let key = VaultKey::from_bytes([4; 32]);
    let header = Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        id("edit"),
        DeviceId::new("replica").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        &authored.text.authored.payload_bytes,
        &key,
        &mut Entropy,
    )
    .unwrap()
    .encode();
    let context = r#"{"realm_id":"realm","vault_id":"vault","update_id":"edit","key_epoch":1}"#;
    let request = json!({"state":text,"namespace_state":graph,"request":{"expected_version":"text-0","next_version":"received-1","delivery":null},"next_namespace_version":"graph-received","prior":null,"cursor":null});
    let plan = receive(&key, context, &request.to_string(), &wire).unwrap();
    assert_eq!(
        plan.text.materialized_utf8.as_deref(),
        Some(b"hello".as_slice())
    );
    assert_eq!(
        plan.graph.next_state.as_ref().unwrap().activities(),
        authored.graph.next_state.as_ref().unwrap().activities()
    );
    let result: serde_json::Value =
        serde_json::from_str(&output(&plan.text, &plan.graph).unwrap()).unwrap();
    assert!(result["text"].get("authored").is_none());
    plan.check(
        &json!({"state":text,"namespace_state":graph,"prior":null,"cursor":null}).to_string(),
    )
    .unwrap();
    let mut bad = wire.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert!(receive(&key, context, &request.to_string(), &bad).is_err());
    assert!(receive(
        &key,
        &context.replace("realm", "other"),
        &request.to_string(),
        &wire
    )
    .is_err());
}
#[test]
fn input_boundary_rejects_duplicate_unknown_and_numeric_cursors() {
    assert!(control::<CursorInput>(r#"{"server_epoch":"e","after":1}"#).is_err());
    assert!(control::<CursorInput>(r#"{"server_epoch":"e","after":"1","after":"2"}"#).is_err());
    assert!(control::<CursorInput>(r#"{"server_epoch":"e","after":"1","extra":0}"#).is_err());
    let value: CursorInput =
        control(r#"{"server_epoch":"e","after":"18446744073709551615"}"#).unwrap();
    assert!(json(&zorid_sync_protocol::Cursor::new(
        value.server_epoch,
        value.after
    ))
    .unwrap()
    .contains("18446744073709551615"));
    assert!(
        control::<CursorInput>(&" ".repeat(zorid_sync_protocol::MAX_CONTROL_BYTES + 1)).is_err()
    );
    assert!(replace("{}", &vec![0; text::MAX_TEXT_BYTES + 1]).is_err());
}

#[test]
fn authenticated_family_capability_preserves_metadata_and_exact_payload() {
    let (_, graph, input) = fixture();
    let authored = replace(&input.to_string(), b"hello").unwrap();
    let key = VaultKey::from_bytes([4; 32]);
    let context = r#"{"realm_id":"realm","vault_id":"vault","update_id":"edit","key_epoch":1}"#;
    let header = Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        id("edit"),
        DeviceId::new("replica").unwrap(),
        1,
    )
    .unwrap();
    let seal = |payload: &[u8]| {
        zorid_crypto::seal(&header, payload, &key, &mut Entropy)
            .unwrap()
            .encode()
    };
    let payload = &authored.text.authored.payload_bytes;
    let wire = seal(payload);
    let cap = open_update(&key, context, &wire).unwrap();
    assert_eq!(cap.wire, wire);
    assert_eq!(cap.metadata["family"], "text");
    assert_eq!(cap.metadata["format_version"], 2);
    assert_eq!(
        cap.metadata["text_binding"]["text_bootstrap_id"],
        "text-seed"
    );
    assert!(cap.matches_payload(payload));
    assert!(!cap.matches_payload(b"{}"));
    let mut obsolete: serde_json::Value = serde_json::from_slice(payload).unwrap();
    obsolete["format_version"] = json!(1);
    assert!(open_update(
        &key,
        context,
        &seal(&serde_json::to_vec(&obsolete).unwrap())
    )
    .is_err());
    let wrong = payload
        .iter()
        .copied()
        .chain(b" ".iter().copied())
        .collect::<Vec<_>>();
    let changed_wire = seal(&wrong);
    let changed = open_update(&key, context, &changed_wire).unwrap();
    assert!(!changed.matches_payload(payload)); // Semantic equivalence is not exact identity.
    assert_ne!(
        changed.metadata["payload_digest"],
        cap.metadata["payload_digest"]
    );

    let create = graph.records().get(&id("create")).unwrap();
    let file_header = Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        id("create"),
        DeviceId::new("replica").unwrap(),
        1,
    )
    .unwrap();
    let bytes = create.encode().unwrap();
    let wire = zorid_crypto::seal(&file_header, &bytes, &key, &mut Entropy)
        .unwrap()
        .encode();
    let cap = open_update(&key, &context.replace("edit", "create"), &wire).unwrap();
    assert!(matches!(&cap.family, AuthenticatedFamily::Files(_)));
    assert_eq!(cap.metadata["family"], "files");
    assert_eq!(cap.metadata["text_binding"], serde_json::Value::Null);
    assert!(cap.matches_payload(&bytes));
    let empty = files::State::empty(graph.scope().clone(), rev("empty"));
    let received = cap
        .plan_file(&json!({"state":empty,"prior":null,"next_version":"arrived"}).to_string())
        .unwrap();
    assert_eq!(
        received.plan.graph.next_state.as_ref().unwrap().records(),
        graph.records()
    );
    received.plan.check_preconditions(&empty, None).unwrap();
    assert!(received.plan.check_preconditions(&graph, None).is_err());
}

#[test]
fn received_duplicate_requires_both_histories_and_fences_cursor_and_prior() {
    let (text, graph, input) = fixture();
    let authored = replace(&input.to_string(), b"hello").unwrap();
    let key = VaultKey::from_bytes([4; 32]);
    let header = Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        id("edit"),
        DeviceId::new("replica").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        &authored.text.authored.payload_bytes,
        &key,
        &mut Entropy,
    )
    .unwrap()
    .encode();
    let context = r#"{"realm_id":"realm","vault_id":"vault","update_id":"edit","key_epoch":1}"#;
    let request = json!({"state":text,"namespace_state":graph,"request":{"expected_version":"text-0","next_version":"received-1","delivery":null},"next_namespace_version":"graph-received","prior":null,"cursor":null});
    let first = receive(&key, context, &request.to_string(), &wire).unwrap();
    let state = first.text.next_state.as_ref().unwrap();
    let next_graph = first.graph.next_state.as_ref().unwrap();
    let prior = &first.text.received_record;
    let cursor = json!({"realm_id":"realm","vault_id":"vault","server_epoch":"epoch","after":"1"});
    let next_cursor =
        json!({"realm_id":"realm","vault_id":"vault","server_epoch":"epoch","after":"2"});
    let mut repeat = json!({"state":state,"namespace_state":next_graph,"request":{"expected_version":"received-1","next_version":"unused","delivery":{"expected":cursor,"next":next_cursor}},"next_namespace_version":"unused-graph","prior":prior,"cursor":cursor});
    let duplicate = receive(&key, context, &repeat.to_string(), &wire).unwrap();
    assert!(duplicate.text.next_state.is_none());
    assert!(duplicate.graph.next_state.is_none());
    let mut check =
        json!({"state":state,"namespace_state":next_graph,"prior":prior,"cursor":cursor});
    duplicate.check(&check.to_string()).unwrap();
    check["cursor"]["after"] = json!("0");
    assert!(duplicate.check(&check.to_string()).is_err());
    check["cursor"] = cursor;
    check["prior"] = serde_json::Value::Null;
    assert!(duplicate.check(&check.to_string()).is_err());
    repeat["namespace_state"] = serde_json::to_value(&graph).unwrap();
    assert!(receive(&key, context, &repeat.to_string(), &wire).is_err());
    // A pending activity still counts as retained history before Create arrives.
    let empty = files::State::empty(graph.scope().clone(), rev("empty"));
    let mut pending = request;
    pending["namespace_state"] = serde_json::to_value(&empty).unwrap();
    let pending = receive(&key, context, &pending.to_string(), &wire).unwrap();
    assert!(pending.graph.view.namespace.pending.contains(&id("edit")));
    assert!(pending
        .graph
        .next_state
        .as_ref()
        .unwrap()
        .activities()
        .contains_key(&id("edit")));
}

#[test]
fn state_budget_is_bounded_and_successful_plans_roundtrip_to_next_call() {
    // JSON string quotes count toward the reusable-state budget.
    reusable_state(&"x".repeat(MAX_STATE_JSON_BYTES - 2)).unwrap();
    assert!(reusable_state(&"x".repeat(MAX_STATE_JSON_BYTES - 1)).is_err());
    let (_, _, input) = fixture();
    let first = replace(&input.to_string(), b"hello").unwrap();
    let mut next = input;
    next["state"] = serde_json::to_value(&first.text.next_state).unwrap();
    next["namespace_state"] =
        serde_json::to_value(first.graph.next_state.as_ref().unwrap()).unwrap();
    next["request"]["expected_version"] = json!("text-1");
    next["request"]["next_version"] = json!("text-2");
    next["request"]["update_id"] = json!("edit-2");
    next["namespace"]["parents"] = json!(["edit"]);
    next["next_namespace_version"] = json!("graph-3");
    let second = replace(&next.to_string(), b"hello again").unwrap();
    assert_eq!(second.text.materialized_utf8, b"hello again");
    reusable_state(&second.text.next_state).unwrap();
    reusable_graph(&second.graph).unwrap();
}

#[test]
fn stored_payload_and_wire_checks_do_not_mint_authentication() {
    let (_, graph, input) = fixture();
    let plan = replace(&input.to_string(), b"hello").unwrap();
    let value = &plan.text.authored;
    let expected = metadata(
        "text",
        &value.identity.realm_id,
        &value.identity.vault_id,
        &value.update_id,
        &value.payload_bytes,
        Some(&value.identity),
    )
    .unwrap();
    validate_payload(&expected.to_string(), &value.payload_bytes).unwrap();
    assert!(validate_payload(&expected.to_string(), b"{}").is_err());
    let mut bad = expected.clone();
    bad["text_binding"]["entry_id"] = json!("other");
    assert!(validate_payload(&bad.to_string(), &value.payload_bytes).is_err());
    bad = expected.clone();
    bad["payload_bytes"] = json!(0);
    assert!(validate_payload(&bad.to_string(), &value.payload_bytes).is_err());
    bad = expected.clone();
    bad["extra"] = json!(true);
    assert!(validate_payload(&bad.to_string(), &value.payload_bytes).is_err());
    let header = Header::new(
        value.identity.realm_id.clone(),
        value.identity.vault_id.clone(),
        value.update_id.clone(),
        DeviceId::new("replica").unwrap(),
        1,
    )
    .unwrap();
    let key = VaultKey::from_bytes([4; 32]);
    let mut wire = zorid_crypto::seal(&header, &value.payload_bytes, &key, &mut Entropy)
        .unwrap()
        .encode();
    validate_wire(&expected.to_string(), &wire).unwrap();
    *wire.last_mut().unwrap() ^= 1;
    // This intentionally passes framing consistency, but cannot pass AEAD open.
    validate_wire(&expected.to_string(), &wire).unwrap();
    assert!(open_update(
        &key,
        r#"{"realm_id":"realm","vault_id":"vault","update_id":"edit","key_epoch":1}"#,
        &wire
    )
    .is_err());
    bad = expected.clone();
    bad["key"]["update_id"] = json!("other");
    assert!(validate_wire(&bad.to_string(), &wire).is_err());
    let create = graph.records().get(&id("create")).unwrap();
    let bytes = create.encode().unwrap();
    let expected = metadata(
        "files",
        &create.scope.realm_id,
        &create.scope.vault_id,
        &create.id,
        &bytes,
        None,
    )
    .unwrap();
    validate_payload(&expected.to_string(), &bytes).unwrap();
}

#[test]
fn strict_file_encoding_supports_retry_without_reauthoring_graph() {
    let (_, graph, _) = fixture();
    let create = graph.records().get(&id("create")).unwrap();
    let bytes = create.encode().unwrap();
    let pretty = serde_json::to_string_pretty(create).unwrap();
    assert_eq!(encode_file_payload(&pretty).unwrap(), bytes);
    // Re-running the domain mutation must fail; comparing canonical retained
    // intent bytes can instead recognize this exact retry without altering state.
    assert!(files::plan_authored(&graph, create, rev("retry")).is_err());
    let mut changed = serde_json::to_value(create).unwrap();
    changed["body"]["events"][0]["effect"]["location"]["name"] = json!("other.md");
    assert_ne!(encode_file_payload(&changed.to_string()).unwrap(), bytes);
    let raw = String::from_utf8(bytes).unwrap();
    let duplicate = format!("{},\"id\":\"create\"}}", &raw[..raw.len() - 1]);
    assert!(encode_file_payload(&duplicate).is_err());
    changed = serde_json::to_value(create).unwrap();
    changed["format_version"] = json!(1);
    assert!(encode_file_payload(&changed.to_string()).is_err());
    changed["format_version"] = json!(2);
    changed["extra"] = json!(true);
    assert!(encode_file_payload(&changed.to_string()).is_err());
    assert!(
        encode_file_payload(&" ".repeat(zorid_sync_protocol::MAX_PLAINTEXT_BYTES + 1)).is_err()
    );
}

#[test]
fn stored_namespace_witness_must_equal_strict_payload_context() {
    let (_, _, input) = fixture();
    let plan = replace(&input.to_string(), b"hello").unwrap();
    let value = &plan.text.authored;
    let expected = metadata(
        "text",
        &value.identity.realm_id,
        &value.identity.vault_id,
        &value.update_id,
        &value.payload_bytes,
        Some(&value.identity),
    )
    .unwrap();
    assert_eq!(
        expected["text_binding"]["namespace"],
        json!({"bootstrap_id":"create","parents":["create"]})
    );
    validate_payload(&expected.to_string(), &value.payload_bytes).unwrap();
    let mut wrong = expected.clone();
    wrong["text_binding"]["namespace"]["parents"] = json!(["another-valid-id"]);
    assert!(validate_payload(&wrong.to_string(), &value.payload_bytes).is_err());
    wrong = expected.clone();
    wrong["text_binding"]["namespace"]["bootstrap_id"] = json!("another-create");
    assert!(validate_payload(&wrong.to_string(), &value.payload_bytes).is_err());
    wrong = expected;
    wrong["text_binding"]
        .as_object_mut()
        .unwrap()
        .remove("namespace");
    assert!(validate_payload(&wrong.to_string(), &value.payload_bytes).is_err());
}

fn retained_fixture() -> files::State {
    use std::collections::BTreeMap;
    use zorid_file_sync::{ChunkPage, ChunkRef, Manifest, Sha256Digest};
    let (_, text_graph, _) = fixture();
    let scope = text_graph.scope().clone();
    let bytes = vec![0, 255, 128, 42];
    let page = ChunkPage {
        chunks: vec![ChunkRef {
            id: id("chunk"),
            bytes: bytes.len() as u32,
            digest: Sha256Digest::of(&bytes),
        }],
    };
    let manifest = Manifest {
        bytes: bytes.len() as u64,
        digest: Sha256Digest::of(&bytes),
        pages: vec![page.reference(id("page")).unwrap()],
    };
    let mut create = text_graph.records().get(&id("create")).unwrap().clone();
    let files::Body::Events { events } = &mut create.body else {
        panic!("fixture create");
    };
    let files::Effect::Create { content, .. } = &mut events[0].effect else {
        panic!("fixture create");
    };
    *content = Some(files::ContentSeed::Binary { manifest });
    let empty = files::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope.clone(),
        id: id("empty-write"),
        body: files::Body::Events {
            events: vec![files::EntryEvent {
                id: id("empty-write"),
                identity: EntryIdentity {
                    entry_id: EntryId::new("note").unwrap(),
                    bootstrap_id: id("create"),
                },
                parents: vec![id("create")],
                effect: files::Effect::SetContent {
                    content: Manifest {
                        bytes: 0,
                        digest: Sha256Digest::of(&[]),
                        pages: vec![],
                    },
                },
            }],
        },
    };
    let mut records = BTreeMap::new();
    for payload in [
        create,
        empty,
        files::Payload {
            family: Family::Files,
            format_version: 2,
            scope: scope.clone(),
            id: id("chunk"),
            body: files::Body::Chunk { bytes },
        },
        files::Payload {
            family: Family::Files,
            format_version: 2,
            scope: scope.clone(),
            id: id("page"),
            body: files::Body::Page { page },
        },
    ] {
        records.insert(payload.id.clone(), payload);
    }
    files::State::from_records(scope, rev("retained"), records, BTreeMap::new()).unwrap()
}
#[test]
fn retained_wrapper_preserves_historical_bytes_missing_and_empty_distinctions() {
    let state = retained_fixture();
    let identity = r#"{"entry_id":"note","bootstrap_id":"create"}"#;
    let state_json = serde_json::to_string(&state).unwrap();
    assert_eq!(
        retained_file(&state_json, identity, "create").unwrap(),
        "[0,255,128,42]"
    );
    assert_eq!(
        retained_file(&state_json, identity, "empty-write").unwrap(),
        "[]"
    );
    let mut records = state.records().clone();
    records.remove(&id("chunk"));
    let missing = files::State::from_records(
        state.scope().clone(),
        rev("missing"),
        records,
        state.activities().clone(),
    )
    .unwrap();
    assert_eq!(
        retained_file(
            &serde_json::to_string(&missing).unwrap(),
            identity,
            "create"
        )
        .unwrap(),
        "null"
    );
    assert!(retained_file(
        &state_json,
        r#"{"entry_id":"other","bootstrap_id":"create"}"#,
        "create"
    )
    .is_err());
    assert!(retained_file(
        &state_json,
        r#"{"entry_id":"note","bootstrap_id":"other"}"#,
        "create"
    )
    .is_err());
    assert!(retained_file(&state_json, identity, "chunk").is_err());
}
#[test]
fn retained_wrapper_rejects_noncanonical_identity_and_bounded_inputs() {
    let state = serde_json::to_string(&retained_fixture()).unwrap();
    let identity = r#"{"entry_id":"note","bootstrap_id":"create"}"#;
    assert!(retained_file(
        &state,
        r#"{"entry_id":"note","entry_id":"other","bootstrap_id":"create"}"#,
        "create"
    )
    .is_err());
    assert!(retained_file(
        &state,
        r#"{"entry_id":"note","bootstrap_id":"create","extra":true}"#,
        "create"
    )
    .is_err());
    assert!(retained_file(&state, identity, "../create").is_err());
    assert!(retained_file(
        &state,
        &" ".repeat(zorid_sync_protocol::MAX_CONTROL_BYTES + 1),
        "create"
    )
    .is_err());
    assert!(retained_file(&" ".repeat(MAX_INPUT_BYTES + 1), identity, "create").is_err());
}

#[test]
fn classifier_bindings_delegate_visibility_and_recovery_without_alias_collapse() {
    let (text, graph, input) = fixture();
    let state_json = serde_json::to_string(&graph).unwrap();
    let missing: serde_json::Value =
        serde_json::from_str(&classification::classify_json(&state_json, "[]").unwrap()).unwrap();
    assert_eq!(missing["note"]["outcome"]["status"], "pending");
    assert_eq!(
        classification::recovery_json(&state_json, "[]", "note").unwrap(),
        "null"
    );
    let plan = replace(&input.to_string(), b"visible").unwrap();
    let graph = plan.graph.next_state.as_ref().unwrap();
    let state_json = serde_json::to_string(&graph).unwrap();
    let texts = serde_json::to_string(&vec![&plan.text.next_state]).unwrap();
    let classified: serde_json::Value =
        serde_json::from_str(&classification::classify_json(&state_json, &texts).unwrap()).unwrap();
    assert_eq!(classified["note"]["outcome"]["status"], "normal");
    assert_eq!(
        classified["note"]["outcome"]["content"]["bytes"],
        json!(b"visible".to_vec())
    );
    let recovered: serde_json::Value =
        serde_json::from_str(&classification::recovery_json(&state_json, &texts, "note").unwrap())
            .unwrap();
    assert_eq!(recovered["witness"]["kind"], "text");
    assert_eq!(recovered["bytes"], json!(b"visible".to_vec()));
    let duplicate = serde_json::to_string(&vec![&text, &text]).unwrap();
    assert!(classification::classify_json(&state_json, &duplicate).is_err());
    assert!(classification::recovery_json(&state_json, &texts, "unknown").is_err());
    let binary = serde_json::to_string(&retained_fixture()).unwrap();
    let binary_result: serde_json::Value =
        serde_json::from_str(&classification::recovery_json(&binary, "[]", "note").unwrap())
            .unwrap();
    assert_eq!(binary_result["witness"]["kind"], "binary");
    assert_eq!(binary_result["bytes"], json!([]));
}
#[test]
fn classifier_bindings_enforce_aggregate_text_input_and_identity_bounds() {
    let (text, graph, _) = fixture();
    let graph_json = serde_json::to_string(&graph).unwrap();
    assert!(
        classification::classify_json(&graph_json, &" ".repeat(MAX_STATE_JSON_BYTES + 1)).is_err()
    );
    assert!(classification::classify_json(&" ".repeat(MAX_STATE_JSON_BYTES + 1), "[]").is_err());
    let too_many = serde_json::to_string(&vec![&text; zorid_file_sync::MAX_RECORDS + 1]).unwrap();
    assert!(classification::classify_json(&graph_json, &too_many).is_err());
    assert!(classification::recovery_json(&graph_json, "[]", "../escape").is_err());
}
