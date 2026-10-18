//! Independent counterexamples for the portable authority, not durable-adapter proof.
use std::collections::{BTreeMap, BTreeSet};
use zorid_records::{
    Action, Cell, Command, Error, Field, Id, Kind, Operation, Policy, Schema, Scope,
    State, Value, MAX_BYTES, MAX_PARENTS,
};

fn id(s: &str) -> Id { Id::new(s).unwrap() }
fn scope() -> Scope {
    Scope {
        realm: id("realm"), vault: id("vault"), owner: id("first-party"),
        collection: id("blocks"), record: id("record"), generation: id("gen"),
        restores: None,
    }
}
fn field(kind: Kind) -> Field {
    Field { kind, required: false, nullable: false, default: None }
}
fn schema() -> Schema {
    Schema {
        collection: id("blocks"), version: 1, policy: Policy::Synced,
        fields: BTreeMap::from([
            (id("title"), field(Kind::String)), (id("color"), field(Kind::String)),
            (id("tags"), field(Kind::Set)), (id("other-tags"), field(Kind::Set)),
        ]),
    }
}
fn write(name: &str, value: &str) -> Action {
    Action::Write { field: id(name), cell: Cell::Value(Value::String(value.into())) }
}
fn add(name: &str, member: &str) -> Action {
    Action::Add { field: id(name), member: id(member) }
}
fn remove(name: &str, member: &str, tag: &str) -> Action {
    Action::Remove { field: id(name), member: id(member), tags: vec![id(tag)] }
}
fn op(name: &str, parents: &[&str], command: Command) -> Operation {
    let mut parents: Vec<_> = parents.iter().map(|p| id(p)).collect();
    parents.sort();
    Operation { id: id(name), parents, scope: scope(), schema_version: 1, command }
}
fn patch(name: &str, parents: &[&str], actions: Vec<Action>) -> Operation {
    op(name, parents, Command::Patch(actions))
}
fn seeded() -> State {
    let mut state = State::new(schema(), scope()).unwrap();
    state.union(&[op("gen", &[], Command::Create(vec![]))]).unwrap();
    state
}
fn unchanged_on_error(state: &mut State, operations: &[Operation], expected: Error) {
    let before = state.clone();
    let bytes = state.snapshot().unwrap();
    assert_eq!(state.union(operations), Err(expected));
    assert_eq!(*state, before, "rejection changed causal state or registration");
    assert_eq!(state.snapshot().unwrap(), bytes);
}

#[test]
fn field_maxima_survive_unrelated_descendants_and_causal_resolution() {
    let a = patch("a", &["gen"], vec![write("title", "alpha")]);
    let b = patch("b", &["gen"], vec![write("title", "beta")]);
    let x = patch("x", &["a"], vec![write("color", "red")]);
    let resolve = patch("resolve", &["b", "x"], vec![write("title", "resolved")]);
    let mut left = seeded();
    left.union(&[x.clone(), b.clone(), a.clone()]).unwrap();
    let projection = left.projection().unwrap();
    let candidates = &projection.fields[&id("title")];
    assert_eq!(candidates.iter().map(|c| c.operation.clone()).collect::<Vec<_>>(),
               vec![id("a"), id("b")]);
    assert_eq!(candidates[0].cell, Cell::Value(Value::String("alpha".into())));
    assert_eq!(candidates[1].cell, Cell::Value(Value::String("beta".into())));
    assert_eq!(projection.fields[&id("color")][0].operation, id("x"));
    let mut right = seeded();
    right.union(&[resolve.clone(), a, x, b]).unwrap();
    left.union(&[resolve]).unwrap();
    assert_eq!(left.snapshot().unwrap(), right.snapshot().unwrap());
    let projection = left.projection().unwrap();
    assert_eq!(projection.fields[&id("title")].len(), 1);
    assert_eq!(projection.fields[&id("title")][0].operation, id("resolve"));
    assert_eq!(left.history().len(), 5, "resolution must retain both losing writes");
}

#[test]
fn tag_presence_is_not_causal_or_member_or_field_authorization() {
    let source = patch("add", &["gen"], vec![add("tags", "member")]);
    // The same tag is in local storage, but the remove did not observe its add.
    for bad in [
        patch("concurrent", &["gen"], vec![remove("tags", "member", "add")]),
        patch("member-theft", &["add"], vec![remove("tags", "other", "add")]),
        patch("field-theft", &["add"], vec![remove("other-tags", "member", "add")]),
    ] {
        let mut state = seeded();
        state.union(&[source.clone()]).unwrap();
        unchanged_on_error(&mut state, &[bad.clone()], Error::InvalidOperation);
        let mut reverse = seeded();
        // Invalid ancestry can be known before or only after the add arrives.
        let before = reverse.clone();
        match reverse.union(&[bad]) {
            Ok(()) => unchanged_on_error(&mut reverse, &[source.clone()], Error::InvalidOperation),
            Err(Error::InvalidOperation) => assert_eq!(reverse, before),
            other => panic!("unexpected tag-authorization result: {other:?}"),
        }
    }
    let mut state = seeded();
    state.union(&[
        source,
        patch("concurrent-add", &["gen"], vec![add("tags", "member")]),
        patch("valid-remove", &["add"], vec![remove("tags", "member", "add")]),
    ]).unwrap();
    assert_eq!(state.projection().unwrap().sets[&id("tags")], BTreeSet::from([id("member")]));
}

#[test]
fn pending_cycles_and_equivocation_reject_without_partial_publication() {
    let a = patch("a", &["b"], vec![write("title", "pending")]);
    let b = patch("b", &["a"], vec![write("color", "cycle")]);
    for (first, second) in [(a.clone(), b.clone()), (b, a.clone())] {
        let mut state = seeded();
        state.union(&[first]).unwrap();
        assert_eq!(state.projection().unwrap().pending.len(), 1);
        let mut restored = State::restore(schema(), &state.snapshot().unwrap()).unwrap();
        unchanged_on_error(&mut restored, &[second], Error::Cycle);
    }
    let mut state = seeded();
    state.union(&[a.clone()]).unwrap();
    let mut altered = a.clone();
    altered.command = Command::Patch(vec![write("title", "equivocated")]);
    // A valid companion in the same batch must also roll back.
    unchanged_on_error(&mut state, &[
        patch("companion", &["gen"], vec![write("color", "blue")]), altered,
    ], Error::Collision);
    let bytes = state.snapshot().unwrap();
    state.union(&[a]).unwrap();
    assert_eq!(state.snapshot().unwrap(), bytes, "exact pending replay is idempotent");
}

#[test]
fn invalid_pending_remove_cannot_poison_parent_activation_partially() {
    let parent = patch("parent", &["gen"], vec![add("tags", "actual")]);
    let pending = patch("remove", &["parent"], vec![remove("tags", "wrong", "parent")]);
    let mut state = seeded();
    state.union(&[pending.clone()]).unwrap();
    let mut restored = State::restore(schema(), &state.snapshot().unwrap()).unwrap();
    assert_eq!(restored.projection().unwrap().pending, BTreeSet::from([id("remove")]));
    unchanged_on_error(&mut restored, &[parent.clone()], Error::InvalidOperation);
    assert!(!restored.history().contains_key(&id("parent")));
    let mut reverse = seeded();
    reverse.union(&[parent]).unwrap();
    unchanged_on_error(&mut reverse, &[pending], Error::InvalidOperation);
}

#[test]
fn old_client_patch_preserves_additive_scalar_object_and_set_history() {
    let mut newer_schema = schema();
    newer_schema.version = 2;
    newer_schema.fields.extend([
        (id("future-scalar"), field(Kind::String)),
        (id("future-object"), field(Kind::Object)),
        (id("future-set"), field(Kind::Set)),
    ]);
    let mut new_client = State::new(newer_schema.clone(), scope()).unwrap();
    new_client.receive(&seeded().snapshot().unwrap()).unwrap();
    let object = Cell::Value(Value::Object(BTreeMap::from([
        ("schedule".into(), serde_json::json!({"start": 10, "end": 20, "zone": "UTC"})),
    ])));
    let mut future = patch("future", &["gen"], vec![
        write("future-scalar", "retained"),
        Action::Write { field: id("future-object"), cell: object.clone() },
        add("future-set", "stable-option"),
    ]);
    future.schema_version = 2;
    new_client.union(&[future.clone()]).unwrap();
    let mut old_client = seeded();
    let offline = old_client.prepare(id("offline"), Command::Patch(vec![write("title", "old-client")])).unwrap();
    old_client.install(offline).unwrap();
    old_client.receive(&new_client.snapshot().unwrap()).unwrap();
    let edit = old_client.prepare(id("known-unset"), Command::Patch(vec![
        Action::Write { field: id("color"), cell: Cell::Unset },
    ])).unwrap();
    old_client.install(edit).unwrap();
    let restored = State::restore(schema(), &old_client.snapshot().unwrap()).unwrap();
    assert_eq!(restored.history()[&id("future")], future);
    let projection = restored.projection().unwrap();
    assert_eq!(projection.fields[&id("future-object")][0].cell, object);
    assert_eq!(projection.fields[&id("future-scalar")][0].cell,
               Cell::Value(Value::String("retained".into())));
    assert_eq!(projection.sets[&id("future-set")], BTreeSet::from([id("stable-option")]));
    assert!(matches!(restored.prepare(id("invent"), Command::Patch(vec![
        write("future-scalar", "forbidden-local"),
    ])), Err(Error::UnknownField)));
    let mut incompatible = restored.clone();
    unchanged_on_error(&mut incompatible, &[
        patch("companion", &["known-unset"], vec![write("color", "must-roll-back")]),
        patch("type-change", &["known-unset"], vec![Action::Write {
            field: id("title"), cell: Cell::Value(Value::Integer(42)),
        }]),
    ], Error::InvalidValue);
    new_client.receive(&restored.snapshot().unwrap()).unwrap();
    assert_eq!(new_client.snapshot().unwrap(), restored.snapshot().unwrap());
}

#[test]
fn snapshot_keeps_losers_tombstone_and_pending_then_completes_dependencies() {
    let mut state = seeded();
    let pending = patch("late", &["missing"], vec![write("color", "late-color")]);
    state.union(&[
        patch("a", &["gen"], vec![write("title", "loser-a")]),
        patch("b", &["gen"], vec![write("title", "loser-b")]),
        patch("resolve", &["a", "b"], vec![write("title", "resolved")]),
        op("delete", &["resolve"], Command::Delete), pending.clone(),
    ]).unwrap();
    let bytes = state.snapshot().unwrap();
    let mut restored = State::restore(schema(), &bytes).unwrap();
    assert_eq!(restored, state);
    assert_eq!(restored.snapshot().unwrap(), bytes);
    assert_eq!(restored.history().len(), 6);
    assert_eq!(restored.history()[&id("late")], pending);
    assert!(restored.projection().unwrap().deleted);
    assert_eq!(restored.projection().unwrap().pending, BTreeSet::from([id("late")]));
    restored.union(&[patch("missing", &["gen"], vec![write("color", "predecessor")])]).unwrap();
    let projection = restored.projection().unwrap();
    assert!(projection.pending.is_empty());
    assert!(projection.deleted, "late edits must not resurrect the generation");
    assert_eq!(projection.fields[&id("color")][0].operation, id("late"));
    assert_eq!(restored.history().len(), 7);
}

#[test]
fn duplicate_json_keys_in_envelope_and_atomic_object_are_rejected() {
    let mut state = seeded();
    state.union(&[patch("object", &["gen"], vec![Action::Write {
        field: id("future-object"),
        cell: Cell::Value(Value::Object(BTreeMap::from([("marker".into(), serde_json::json!(7))]))),
    }])]).unwrap();
    let canonical = String::from_utf8(state.snapshot().unwrap()).unwrap();
    for (needle, replacement) in [
        ("\"format\":1", "\"format\":1,\"format\":1"),
        ("\"marker\":7", "\"marker\":7,\"marker\":7"),
    ] {
        assert!(canonical.contains(needle), "fixture no longer matches snapshot encoding");
        let malformed = canonical.replacen(needle, replacement, 1);
        let before = state.clone();
        assert!(matches!(State::restore(schema(), malformed.as_bytes()), Err(Error::Codec)));
        assert_eq!(state.receive(malformed.as_bytes()), Err(Error::Codec));
        assert_eq!(state, before);
    }
}

#[test]
fn excess_heads_block_local_resolution_instead_of_omitting_observed_writes() {
    let mut state = seeded();
    let heads: Vec<_> = (0..=MAX_PARENTS).map(|n|
        patch(&format!("head-{n:02}"), &["gen"], vec![write("title", &format!("value-{n}"))])
    ).collect();
    state.union(&heads).unwrap();
    assert_eq!(state.projection().unwrap().fields[&id("title")].len(), MAX_PARENTS + 1);
    let before = state.clone();
    assert!(matches!(state.prepare(id("resolve"), Command::Patch(vec![write("title", "resolved")])), Err(Error::Limit)));
    assert_eq!(state, before);
}

#[test]
fn individually_bounded_pending_payloads_cannot_exceed_aggregate_snapshot_budget() {
    let mut state = seeded();
    let value = "x".repeat(12 * 1024);
    let mut rejected = false;
    // Independent missing parents keep the causal trace small while testing retained bytes.
    for n in 0..96 {
        let operation = patch(&format!("pending-{n:02}"), &["missing"], vec![write("title", &value)]);
        let before = state.clone();
        match state.union(&[operation]) {
            Ok(()) => assert!(state.snapshot().unwrap().len() <= MAX_BYTES),
            Err(Error::Limit) => {
                assert_eq!(state, before);
                rejected = true;
                break;
            }
            other => panic!("unexpected bounded admission result: {other:?}"),
        }
    }
    assert!(rejected, "aggregate retained bytes escaped the snapshot limit");
    assert!(!state.projection().unwrap().pending.is_empty());
}
