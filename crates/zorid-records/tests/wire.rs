//! Ready for `pub mod wire;`; intentionally uncompiled until registration is granted.
use serde::Serialize;
use std::collections::BTreeMap;
use zorid_records::{wire::Payload, Action, Cell, Command, Error, Id, Operation, Scope,
    Value, MAX_ACTIONS, MAX_BYTES, MAX_DEPTH, MAX_HISTORY, MAX_ID, MAX_PARENTS, MAX_VALUE};

fn id(value: &str) -> Id { Id::new(value).unwrap() }
fn scope() -> Scope {
    Scope { realm: id("realm"), vault: id("vault"), owner: id("first-party"),
        collection: id("collection"), record: id("record"), generation: id("create"),
        restores: Some(id("old-generation")) }
}
fn create() -> Operation {
    Operation { id: id("create"), parents: vec![], scope: scope(), schema_version: 7,
        command: Command::Create(vec![
            Action::Write { field: id("title"), cell: Cell::Value(Value::String("hello".into())) },
            Action::Write { field: id("optional"), cell: Cell::Null },
            Action::Add { field: id("labels"), member: id("important") },
        ]) }
}
fn patch() -> Operation {
    Operation { id: id("patch"), parents: vec![id("create")], scope: scope(), schema_version: 9,
        command: Command::Patch(vec![
            Action::Write { field: id("optional"), cell: Cell::Unset },
            Action::Remove { field: id("labels"), member: id("important"), tags: vec![id("create")] },
        ]) }
}
#[derive(Serialize)]
struct Intent { format: u32, scope: Scope, operations: Vec<Operation> }
fn intent(operations: Vec<Operation>) -> Vec<u8> {
    serde_json::to_vec(&Intent { format: 1, scope: scope(), operations }).unwrap()
}
fn payload() -> Payload {
    // Reverse causal order deliberately: wrapping must preserve immutable content
    // and batch order rather than turn a local intent into a sorted snapshot.
    Payload::from_intent(id("update"), &intent(vec![patch(), create()])).unwrap()
}
fn replace(bytes: &[u8], from: &str, to: &str) -> Vec<u8> {
    let text = std::str::from_utf8(bytes).unwrap();
    assert!(text.contains(from));
    text.replacen(from, to, 1).into_bytes()
}

#[test]
fn roundtrip_preserves_identity_typed_operations_and_exact_intent() {
    let source = intent(vec![patch(), create()]);
    let wrapped = Payload::from_intent(id("update"), &source).unwrap();
    let bytes = wrapped.encode().unwrap();
    let decoded = Payload::decode(&bytes).unwrap();
    assert_eq!(decoded, wrapped);
    assert_eq!(decoded.scope(), &scope());
    assert_eq!(decoded.id(), &id("update"));
    assert_eq!(decoded.operations(), &[patch(), create()]);
    assert_eq!(decoded.intent().unwrap(), source);
    assert_eq!(decoded.encode().unwrap(), bytes);
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["family"], "records");
    assert_eq!(json["format_version"], 1);
    assert!(json["operations"][0].is_object());
    assert_eq!(json.as_object().unwrap().len(), 5);
}

#[test]
fn context_requires_each_exact_identity_component() {
    let p = payload();
    assert_eq!(p.check_context("realm", "vault", "update"), Ok(()));
    for (realm, vault, update) in [("other", "vault", "update"),
        ("realm", "other", "update"), ("realm", "vault", "other")] {
        assert_eq!(p.check_context(realm, vault, update), Err(Error::Scope));
    }
}

#[test]
fn family_versions_and_unknown_fields_fail_closed() {
    let bytes = payload().encode().unwrap();
    for changed in [
        replace(&bytes, "\"records\"", "\"text\""),
        replace(&bytes, "\"format_version\":1", "\"format_version\":2"),
        replace(&bytes, "\"format_version\":1", "\"format_version\":0"),
        replace(&bytes, "\"family\":", "\"extra\":true,\"family\":"),
        replace(&bytes, "\"owner\":", "\"extra\":true,\"owner\":"),
        replace(&bytes, "\"schema_version\":9", "\"schema_version\":9,\"extra\":true"),
        replace(&bytes, "\"command\":\"Patch\"", "\"command\":\"Patch\",\"extra\":true"),
    ] { assert_eq!(Payload::decode(&changed), Err(Error::Codec)); }
    let local = intent(vec![create()]);
    assert_eq!(Payload::from_intent(id("update"), &replace(&local,
        "\"format\":1", "\"format\":2")), Err(Error::Codec));
}

#[test]
fn forged_operation_scope_and_invalid_ids_are_rejected() {
    let bytes = payload().encode().unwrap();
    // Changing only wrapper scope leaves every operation bound to the old vault.
    assert_eq!(Payload::decode(&replace(&bytes, "\"vault\":\"vault\"",
        "\"vault\":\"foreign\"")), Err(Error::Scope));
    for invalid in ["", "bad id", "é"] {
        assert_eq!(Payload::decode(&replace(&bytes, "\"id\":\"update\"",
            &format!("\"id\":\"{invalid}\""))), Err(Error::InvalidId));
    }
    let mut forged = create();
    forged.scope.owner = id("other-owner");
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![forged])), Err(Error::Scope));
    assert_eq!(Payload::decode(&replace(&bytes, "\"id\":\"patch\"",
        &format!("\"id\":\"{}\"", "x".repeat(MAX_ID + 1)))), Err(Error::InvalidId));
}

#[test]
fn duplicate_keys_and_noncanonical_spellings_are_rejected() {
    let bytes = payload().encode().unwrap();
    for changed in [
        replace(&bytes, "\"family\":\"records\"", "\"family\":\"records\",\"family\":\"records\""),
        replace(&bytes, "\"realm\":\"realm\"", "\"realm\":\"realm\",\"realm\":\"realm\""),
        replace(&bytes, "\"schema_version\":9", "\"schema_version\":9,\"schema_version\":9"),
        replace(&bytes, "\"family\":", "\"family\" :"),
        replace(&bytes, "\"update\"", "\"\\u0075pdate\""),
    ] { assert_eq!(Payload::decode(&changed), Err(Error::Codec)); }
    let mut object = create();
    object.command = Command::Create(vec![Action::Write { field: id("object"),
        cell: Cell::Value(Value::Object(BTreeMap::from([("key".into(), serde_json::json!(1))]))) }]);
    let bytes = Payload::from_intent(id("update"), &intent(vec![object])).unwrap().encode().unwrap();
    assert_eq!(Payload::decode(&replace(&bytes, "\"key\":1", "\"key\":0,\"key\":1")), Err(Error::Codec));
}

#[test]
fn malformed_missing_and_trailing_json_are_rejected() {
    for bytes in [b"".as_slice(), b"null", b"{}", b"[]", b"{", b"\xff", b"{}{}"] {
        assert_eq!(Payload::decode(bytes), Err(Error::Codec));
    }
    let mut bytes = payload().encode().unwrap();
    bytes.push(b'\n');
    assert_eq!(Payload::decode(&bytes), Err(Error::Codec));
    assert_eq!(Payload::decode(&vec![b' '; MAX_BYTES + 1]), Err(Error::Limit));
    assert_eq!(Payload::from_intent(id("update"), &vec![b' '; MAX_BYTES + 1]), Err(Error::Limit));
}

#[test]
fn operation_duplicates_bounds_and_cycles_reuse_existing_validation() {
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![create(), create()])),
        Err(Error::InvalidOperation));
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![create(); MAX_HISTORY + 1])),
        Err(Error::Limit));
    let mut op = patch();
    op.parents = (0..=MAX_PARENTS).map(|n| id(&format!("parent-{n:03}"))).collect();
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![op])), Err(Error::Limit));
    let mut op = create();
    op.command = Command::Create((0..=MAX_ACTIONS).map(|n|
        Action::Add { field: id(&format!("field-{n}")), member: id("member") }).collect());
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![op])), Err(Error::Limit));
    let mut op = patch();
    op.parents = vec![op.id.clone()];
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![op])), Err(Error::Cycle));
    let mut op = create();
    op.schema_version = 0;
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![op])), Err(Error::InvalidSchema));
}

#[test]
fn missing_dependencies_remain_structurally_decodable() {
    let source = intent(vec![patch()]);
    let p = Payload::from_intent(id("update"), &source).unwrap();
    assert_eq!(Payload::decode(&p.encode().unwrap()).unwrap().intent().unwrap(), source);
    // Structural acceptance must not require namespace registration, current
    // schema version equality, or the presence of the generation's create.
    assert_eq!(p.operations()[0].schema_version, 9);
}

#[test]
fn nested_values_and_value_sizes_are_bounded() {
    let mut nested = serde_json::json!(null);
    for _ in 0..MAX_DEPTH { nested = serde_json::json!([nested]); }
    let mut op = create();
    op.command = Command::Create(vec![Action::Write { field: id("object"),
        cell: Cell::Value(Value::Object(BTreeMap::from([("key".into(), nested)]))) }]);
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![op])), Err(Error::Limit));
    let mut op = create();
    op.command = Command::Create(vec![Action::Write { field: id("title"),
        cell: Cell::Value(Value::String("x".repeat(MAX_VALUE))) }]);
    assert_eq!(Payload::from_intent(id("update"), &intent(vec![op])), Err(Error::Limit));
}

#[test]
fn wrapper_bytes_count_against_the_same_transport_budget() {
    // Fill a canonical, structurally valid intent to the limit. Individual
    // operations are small and pending, so value/history/causality limits pass.
    let mut operations = Vec::new();
    while intent(operations.clone()).len() < MAX_BYTES - 12_000 {
        operations.push(Operation { id: id(&format!("op-{:03}", operations.len())),
            parents: vec![id("missing")], scope: scope(), schema_version: 1,
            command: Command::Patch(vec![Action::Write { field: id("title"),
                cell: Cell::Value(Value::String("x".repeat(10_000))) }]) });
    }
    operations.push(Operation { id: id("last"), parents: vec![id("missing")],
        scope: scope(), schema_version: 1,
        command: Command::Patch(vec![Action::Write { field: id("title"),
            cell: Cell::Value(Value::String(String::new())) }]) });
    let remaining = MAX_BYTES - intent(operations.clone()).len();
    assert!(remaining < MAX_VALUE - 100);
    if let Command::Patch(actions) = &mut operations.last_mut().unwrap().command {
        actions[0] = Action::Write { field: id("title"),
            cell: Cell::Value(Value::String("x".repeat(remaining))) };
    }
    let source = intent(operations);
    assert_eq!(source.len(), MAX_BYTES);
    assert_eq!(Payload::from_intent(id("update"), &source), Err(Error::Limit));
}
