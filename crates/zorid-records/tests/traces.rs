use std::collections::{BTreeMap, BTreeSet};
use zorid_records::*;

fn id(s: &str) -> Id { Id::new(s).unwrap() }
fn schema() -> Schema {
    Schema { collection: id("collection"), version: 1, policy: Policy::Synced,
        fields: [("title", Kind::String), ("color", Kind::String), ("tags", Kind::Set),
                 ("object", Kind::Object), ("number", Kind::Number)]
            .into_iter().map(|(name, kind)| (id(name), Field { kind,
                required: false, nullable: name != "tags", default: None })).collect() }
}
fn empty() -> State {
    State::new(schema(), Scope { realm: id("realm"), vault: id("vault"), owner: id("owner"),
        collection: id("collection"), record: id("record"), generation: id("C"), restores: None }).unwrap()
}
fn write(field: &str, text: &str) -> Action {
    Action::Write { field: id(field), cell: Cell::Value(Value::String(text.into())) }
}
fn add(member: &str) -> Action { Action::Add { field: id("tags"), member: id(member) } }
fn remove(member: &str, tags: &[&str]) -> Action {
    Action::Remove { field: id("tags"), member: id(member), tags: tags.iter().map(|s| id(s)).collect() }
}
fn local(state: &mut State, name: &str, command: Command) -> Operation {
    let prepared = state.prepare(id(name), command).unwrap();
    let op = prepared.next().history()[&id(name)].clone();
    state.install(prepared).unwrap(); op
}
fn seed() -> State {
    let mut s = empty(); local(&mut s, "C", Command::Create(vec![write("title", "seed")])); s
}
fn patch(s: &State, name: &str, actions: Vec<Action>) -> Operation {
    s.prepare(id(name), Command::Patch(actions)).unwrap().next().history()[&id(name)].clone()
}
fn op(name: &str, parents: &[&str], command: Command) -> Operation {
    Operation { id: id(name), parents: parents.iter().map(|s| id(s)).collect(), scope: empty().scope().clone(),
        schema_version: 1, command }
}
fn unchanged(s: &mut State, operations: &[Operation], error: Error) {
    let before = s.snapshot().unwrap();
    assert_eq!(s.union(operations), Err(error)); assert_eq!(s.snapshot().unwrap(), before);
}
fn title(s: &State) -> Vec<Candidate> { s.projection().unwrap().fields[&id("title")].clone() }

#[test]
fn different_fields_merge_and_canonical_order() {
    let c = seed();
    let a = patch(&c, "A", vec![write("title", "a")]);
    let b = patch(&c, "B", vec![write("color", "red")]);
    let mut left = c.clone(); let mut right = c;
    left.union(&[a.clone(), b.clone()]).unwrap(); right.union(&[b, a]).unwrap();
    assert_eq!(left.snapshot(), right.snapshot());
    assert_eq!(title(&left)[0].cell, Cell::Value(Value::String("a".into())));
    assert_eq!(left.projection().unwrap().fields[&id("color")].len(), 1);
}
#[test]
fn same_field_candidates_survive_unrelated_heads_and_resolution_reload() {
    let mut s = seed();
    let a = patch(&s, "A", vec![write("title", "a")]);
    let b = patch(&s, "B", vec![write("title", "b")]);
    s.union(&[a, b]).unwrap();
    s.union(&[op("X", &["A"], Command::Patch(vec![write("color", "red")]))]).unwrap();
    let candidates = title(&s);
    assert_eq!(candidates.iter().map(|c| c.operation.clone()).collect::<Vec<_>>(), vec![id("A"), id("B")]);
    assert_eq!(candidates.last().unwrap().cell, Cell::Value(Value::String("b".into())));
    local(&mut s, "R", Command::Patch(vec![write("title", "resolved")]));
    assert_eq!(title(&s).len(), 1); assert_eq!(s.history().len(), 5);
    let restored = State::restore(schema(), &s.snapshot().unwrap()).unwrap();
    assert_eq!(restored, s); assert!(restored.history().contains_key(&id("A")));
}
#[test]
fn equal_concurrent_values_keep_both_identities() {
    let mut s = seed();
    let a = patch(&s, "A", vec![write("title", "same")]);
    let b = patch(&s, "B", vec![write("title", "same")]);
    s.union(&[a, b]).unwrap(); assert_eq!(title(&s).len(), 2);
}
#[test]
fn null_and_unset_are_distinct_candidates() {
    let mut s = seed();
    let a = patch(&s, "A", vec![Action::Write { field: id("title"), cell: Cell::Null }]);
    let b = patch(&s, "B", vec![Action::Write { field: id("title"), cell: Cell::Unset }]);
    s.union(&[a,b]).unwrap();
    assert_eq!(title(&s).iter().map(|c| c.cell.clone()).collect::<Vec<_>>(), vec![Cell::Null, Cell::Unset]);
    assert_eq!(State::restore(schema(), &s.snapshot().unwrap()).unwrap(), s);
}
#[test]
fn observed_remove_add_wins_and_all_tags_clear() {
    let mut s = seed();
    let a = patch(&s, "A", vec![add("member")]); let b = patch(&s, "B", vec![add("member")]);
    s.union(&[a]).unwrap();
    let r = patch(&s, "R", vec![remove("member", &["A"])]);
    s.union(&[b, r]).unwrap();
    assert_eq!(s.projection().unwrap().sets[&id("tags")], BTreeSet::from([id("member")]));
    local(&mut s, "Z", Command::Patch(vec![remove("member", &["A", "B"])]));
    assert!(!s.projection().unwrap().sets.contains_key(&id("tags")));
}
#[test]
fn remove_must_observe_exact_add_field_member_and_generation() {
    let mut s = seed(); local(&mut s, "A", Command::Patch(vec![add("member")]));
    unchanged(&mut s, &[op("R", &["C"], Command::Patch(vec![remove("member", &["A"])]))], Error::InvalidOperation);
    unchanged(&mut s, &[op("R", &["A"], Command::Patch(vec![remove("other", &["A"])]))], Error::InvalidOperation);
    let mut foreign = op("R", &["A"], Command::Patch(vec![remove("member", &["A"])]));
    foreign.scope.generation = id("H"); unchanged(&mut s, &[foreign], Error::Scope);
    let other_field = Action::Remove { field: id("unknownSet"), member: id("member"), tags: vec![id("A")] };
    unchanged(&mut s, &[op("R", &["A"], Command::Patch(vec![other_field]))], Error::InvalidOperation);
}
#[test]
fn delete_edit_and_two_restores_are_generation_isolated() {
    let mut old = seed();
    let edit = patch(&old, "E", vec![write("title", "offline")]);
    local(&mut old, "D", Command::Delete); old.union(&[edit]).unwrap();
    assert!(old.projection().unwrap().deleted); assert_eq!(title(&old)[0].operation, id("E"));
    assert!(matches!(old.prepare(id("N"), Command::Patch(vec![])), Err(Error::Deleted)));
    for generation in ["H", "I"] {
        let mut scope = old.scope().clone(); scope.generation = id(generation); scope.restores = Some(id("C"));
        let mut fresh = State::new(schema(), scope).unwrap();
        local(&mut fresh, generation, Command::Create(vec![write("title", "restored")]));
        unchanged(&mut fresh, &[old.history()[&id("D")].clone()], Error::Scope);
        unchanged(&mut fresh, &[old.history()[&id("E")].clone()], Error::Scope);
        assert!(!fresh.projection().unwrap().deleted);
        assert_eq!(fresh.scope().restores, Some(id("C")));
    }
}
#[test]
fn duplicates_reordered_pending_completion_and_pending_snapshot() {
    let c = seed(); let a = patch(&c, "A", vec![write("title", "a")]);
    let b = op("B", &["A"], Command::Patch(vec![write("title", "b")]));
    let root = c.history()[&id("C")].clone();
    for order in [vec![b.clone(), a.clone(), root.clone()], vec![root.clone(), b.clone(), a.clone()],
                  vec![a.clone(), root.clone(), b.clone()]] {
        let mut s = empty(); s.union(&order[..1]).unwrap();
        if order[0].id != id("C") {
            assert_eq!(s.projection().unwrap().pending.len(), 1);
            assert!(s.projection().unwrap().fields.is_empty());
            assert!(matches!(s.prepare(id("L"), Command::Patch(vec![])), Err(Error::MissingDependency)));
        }
        s = State::restore(schema(), &s.snapshot().unwrap()).unwrap();
        s.union(&order[1..]).unwrap(); let before = s.snapshot().unwrap();
        s.union(&order).unwrap(); assert_eq!(s.snapshot().unwrap(), before);
        assert!(s.projection().unwrap().pending.is_empty()); assert_eq!(title(&s)[0].operation, id("B"));
    }
}
#[test]
fn missing_dependency_cycle_and_pending_equivocation_reject_atomically() {
    let mut s = seed();
    let a = op("A", &["B"], Command::Patch(vec![write("title", "a")]));
    s.union(&[a.clone()]).unwrap();
    unchanged(&mut s, &[op("B", &["A"], Command::Patch(vec![]))], Error::Cycle);
    let mut rewrite = a; rewrite.command = Command::Patch(vec![write("title", "rewritten")]);
    unchanged(&mut s, &[rewrite], Error::Collision);
}
#[test]
fn invalid_pending_descendant_blocks_parent_without_partial_publication() {
    let mut s = seed();
    let r = op("R", &["P"], Command::Patch(vec![remove("wrong", &["P"])]));
    s.union(&[r.clone()]).unwrap();
    let p = op("P", &["C"], Command::Patch(vec![add("member")]));
    unchanged(&mut s, &[p.clone()], Error::InvalidOperation);
    let mut reversed = seed(); reversed.union(&[p]).unwrap();
    unchanged(&mut reversed, &[r], Error::InvalidOperation);
}
#[test]
fn malformed_self_cycle_collision_schema_type_and_action_reject_no_mutation() {
    let mut s = seed();
    unchanged(&mut s, &[op("A", &["A"], Command::Patch(vec![]))], Error::Cycle);
    unchanged(&mut s, &[op("C", &[], Command::Create(vec![]))], Error::Collision);
    unchanged(&mut s, &[op("otherCreate", &[], Command::Create(vec![]))], Error::InvalidOperation);
    let mut bad_schema = op("A", &["C"], Command::Patch(vec![])); bad_schema.schema_version = 0;
    unchanged(&mut s, &[bad_schema], Error::InvalidSchema);
    let bad = Action::Write { field: id("title"), cell: Cell::Value(Value::Boolean(true)) };
    unchanged(&mut s, &[op("A", &["C"], Command::Patch(vec![bad]))], Error::InvalidValue);
    unchanged(&mut s, &[op("A", &["C"], Command::Patch(vec![write("title", "a"), write("title", "b")]))], Error::InvalidOperation);
    for cell in [Cell::Null, Cell::Unset, Cell::Value(Value::String("array replacement".into()))] {
        unchanged(&mut s, &[op("A", &["C"], Command::Patch(vec![Action::Write { field: id("tags"), cell }]))], Error::InvalidValue);
    }
    let before = s.snapshot().unwrap(); assert_eq!(s.receive(b"{"), Err(Error::Codec));
    assert_eq!(s.snapshot().unwrap(), before);
}
#[test]
fn unknown_additive_fields_survive_older_patches_and_history_roundtrip() {
    let mut s = seed();
    let mut newer = op("U", &["C"], Command::Patch(vec![write("futureScalar", "v2"),
        Action::Write { field: id("futureObject"), cell: Cell::Value(Value::Object(BTreeMap::from([
            ("nested".into(), serde_json::json!({"a": [1, null, true]}))]))) },
        Action::Add { field: id("futureSet"), member: id("option") }]));
    newer.schema_version = 2; s.union(&[newer]).unwrap();
    local(&mut s, "L", Command::Patch(vec![write("title", "older"),
        Action::Write { field: id("color"), cell: Cell::Unset }]));
    assert!(matches!(s.prepare(id("bad"), Command::Patch(vec![write("futureScalar", "x")])), Err(Error::UnknownField)));
    let restored = State::restore(schema(), &s.snapshot().unwrap()).unwrap();
    assert_eq!(restored, s); let p = restored.projection().unwrap();
    assert_eq!(p.fields[&id("futureScalar")][0].operation, id("U"));
    assert!(p.fields.contains_key(&id("futureObject"))); assert!(p.sets.contains_key(&id("futureSet")));
    unchanged(&mut s, &[op("T", &["U"], Command::Patch(vec![Action::Add { field: id("futureScalar"), member: id("x") }]))], Error::InvalidValue);
}
#[test]
fn defaults_once_required_validation_and_schema_policy_cas() {
    let mut registration = schema();
    let f = registration.fields.get_mut(&id("title")).unwrap();
    f.required = true; f.default = Some(Cell::Value(Value::String("default".into())));
    let mut s = State::new(registration.clone(), empty().scope().clone()).unwrap();
    local(&mut s, "C", Command::Create(vec![]));
    assert_eq!(title(&s)[0].cell, Cell::Value(Value::String("default".into())));
    assert!(matches!(s.prepare(id("A"), Command::Patch(vec![Action::Write { field: id("title"), cell: Cell::Unset }])), Err(Error::InvalidValue)));
    let prepared = s.prepare(id("A"), Command::Patch(vec![write("title", "a")])).unwrap();
    registration.policy = Policy::Local;
    let mut changed_policy = State::restore(registration, &s.snapshot().unwrap()).unwrap();
    let before = changed_policy.snapshot().unwrap();
    assert_eq!(changed_policy.install(prepared), Err(Error::Stale)); assert_eq!(changed_policy.snapshot().unwrap(), before);
    // Restore replay must not invent a default absent from the original create.
    let restored = State::restore(schema(), &s.snapshot().unwrap()).unwrap(); assert_eq!(restored.history(), s.history());
}
#[test]
fn prepared_exact_replay_stale_history_and_collision() {
    let mut s = seed(); let cmd = Command::Patch(vec![write("title", "a")]);
    let plan = s.prepare(id("A"), cmd.clone()).unwrap(); s.install(plan.clone()).unwrap();
    assert_eq!(s.install(plan), Err(Error::Stale));
    let retry = s.prepare(id("A"), cmd).unwrap(); let before = s.snapshot().unwrap();
    s.install(retry).unwrap(); assert_eq!(s.snapshot().unwrap(), before);
    assert!(matches!(s.prepare(id("A"), Command::Patch(vec![write("title", "different")])), Err(Error::Collision)));
    let plan = s.prepare(id("B"), Command::Patch(vec![])).unwrap();
    s.union(&[op("P", &["missing"], Command::Patch(vec![]))]).unwrap();
    assert_eq!(s.install(plan), Err(Error::Stale));
}
#[test]
fn scalar_limits_json_depth_nonfinite_and_invalid_id_no_mutation() {
    assert_eq!(Id::new(""), Err(Error::InvalidId)); assert_eq!(Id::new("a b"), Err(Error::InvalidId));
    assert_eq!(Id::new("é"), Err(Error::InvalidId)); assert_eq!(Id::new("x".repeat(MAX_ID + 1)), Err(Error::InvalidId));
    let mut s = seed();
    let large = Action::Write { field: id("title"), cell: Cell::Value(Value::String("x".repeat(MAX_VALUE))) };
    unchanged(&mut s, &[op("A", &["C"], Command::Patch(vec![large]))], Error::Limit);
    let nonfinite = Action::Write { field: id("number"), cell: Cell::Value(Value::Number(f64::INFINITY)) };
    unchanged(&mut s, &[op("A", &["C"], Command::Patch(vec![nonfinite]))], Error::InvalidValue);
    let mut deep = serde_json::json!(0);
    for i in 0..MAX_DEPTH { deep = if i % 2 == 0 { serde_json::json!([deep]) } else { serde_json::json!({"v": deep}) }; }
    let action = Action::Write { field: id("object"), cell: Cell::Value(Value::Object(BTreeMap::from([("root".into(), deep)]))) };
    unchanged(&mut s, &[op("A", &["C"], Command::Patch(vec![action]))], Error::Limit);
}
#[test]
fn aggregate_fields_and_payload_bytes_are_bounded() {
    let mut s = seed();
    for i in 0..(MAX_FIELDS - schema().fields.len()) {
        s.union(&[op(&format!("U{i:03}"), &["C"], Command::Patch(vec![write(&format!("unknown{i}"), "x")]))]).unwrap();
    }
    unchanged(&mut s, &[op("overflow", &["C"], Command::Patch(vec![write("oneMore", "x")]))], Error::Limit);
    let before = s.snapshot().unwrap(); assert_eq!(s.receive(&vec![b' '; MAX_BYTES + 1]), Err(Error::Limit));
    assert_eq!(s.snapshot().unwrap(), before);
    let mut s = seed(); let mut blocked = false;
    for i in 0..100 {
        let operation = op(&format!("large{i:03}"), &["C"], Command::Patch(vec![write("title", &"x".repeat(MAX_VALUE - 100))]));
        let before = s.snapshot().unwrap();
        if s.union(&[operation]) == Err(Error::Limit) {
            assert_eq!(s.snapshot().unwrap(), before); blocked = true; break;
        }
    }
    assert!(blocked); assert!(s.history().len() < MAX_HISTORY);
}
#[test]
fn concurrent_heads_parent_limit_is_explicit_backpressure() {
    let mut s = seed();
    let ops: Vec<_> = (0..33).map(|i| op(&format!("head{i:02}"), &["C"], Command::Patch(vec![]))).collect();
    s.union(&ops).unwrap(); let before = s.snapshot().unwrap();
    assert!(matches!(s.prepare(id("resolve"), Command::Patch(vec![write("title", "x")])), Err(Error::Limit)));
    assert_eq!(s.snapshot().unwrap(), before);
}
#[test]
fn history_cap_rejects_union_without_eviction_and_counts_pending() {
    let root = seed();
    let common: Vec<_> = (0..(MAX_HISTORY - 2)).map(|i|
        op(&format!("n{i:04}"), &["C"], Command::Patch(vec![]))).collect();
    let mut left = root.clone(); left.union(&common).unwrap(); let mut right = left.clone();
    left.union(&[op("left", &["C"], Command::Patch(vec![]))]).unwrap();
    right.union(&[op("right", &["C"], Command::Patch(vec![]))]).unwrap();
    unchanged(&mut left, &[right.history()[&id("right")].clone()], Error::Limit);
    unchanged(&mut right, &[left.history()[&id("left")].clone()], Error::Limit);
    let pending: Vec<_> = (0..MAX_HISTORY).map(|i|
        op(&format!("p{i:04}"), &["missing"], Command::Patch(vec![]))).collect();
    let mut s = empty(); s.union(&pending).unwrap(); assert_eq!(s.projection().unwrap().pending.len(), MAX_HISTORY);
    unchanged(&mut s, &[root.history()[&id("C")].clone()], Error::Limit);
}
#[test]
fn canonical_codec_rejects_duplicate_keys_unsupported_actions_and_numeric_overflow() {
    let mut s = seed(); let snapshot = String::from_utf8(s.snapshot().unwrap()).unwrap();
    let before = s.snapshot().unwrap();
    for bytes in [snapshot.replacen("\"format\":1", "\"format\":1,\"format\":1", 1),
                  snapshot.replace("\"Create\"", "\"FutureCommand\""),
                  snapshot.replace("\"format\":1", "\"format\":2"),
                  format!(" {snapshot}")] {
        assert_eq!(s.receive(bytes.as_bytes()), Err(Error::Codec)); assert_eq!(s.snapshot().unwrap(), before);
    }
    let numeric = op("N", &["C"], Command::Patch(vec![Action::Write { field: id("number"), cell: Cell::Value(Value::Integer(1)) }]));
    // Bad known-field type rejects before mutation even without wire decoding.
    unchanged(&mut s, &[numeric], Error::InvalidValue);
    let mut object_state = seed();
    local(&mut object_state, "O", Command::Patch(vec![Action::Write { field: id("object"),
        cell: Cell::Value(Value::Object(BTreeMap::from([("k".into(), serde_json::json!(1))]))) }]));
    let wire = String::from_utf8(object_state.snapshot().unwrap()).unwrap();
    let duplicate = wire.replace("\"k\":1", "\"k\":1,\"k\":2");
    assert_eq!(s.receive(duplicate.as_bytes()), Err(Error::Codec));
    let overflow = wire.replace("\"k\":1", "\"k\":1e9999");
    assert_eq!(s.receive(overflow.as_bytes()), Err(Error::Codec));
}
#[test]
fn signed_zero_operation_content_collision_is_not_numeric_equality() {
    let mut s = seed();
    let operation = op("N", &["C"], Command::Patch(vec![Action::Write { field: id("number"), cell: Cell::Value(Value::Number(0.0)) }]));
    s.union(&[operation]).unwrap();
    let changed = op("N", &["C"], Command::Patch(vec![Action::Write { field: id("number"), cell: Cell::Value(Value::Number(-0.0)) }]));
    unchanged(&mut s, &[changed], Error::Collision);
}
#[test]
fn atomic_objects_are_candidates_without_cross_component_mixing() {
    let mut s = seed();
    let tuple = |start: i64, end: i64| Action::Write { field: id("object"),
        cell: Cell::Value(Value::Object(BTreeMap::from([
            ("start".into(), serde_json::json!(start)), ("end".into(), serde_json::json!(end)),
            ("timezone".into(), serde_json::json!("UTC"))]))) };
    let a = patch(&s, "A", vec![tuple(10, 20)]); let b = patch(&s, "B", vec![tuple(30, 40)]);
    s.union(&[b, a]).unwrap(); let p = s.projection().unwrap();
    assert_eq!(p.fields[&id("object")].len(), 2);
    assert_eq!(p.fields[&id("object")].last().unwrap().cell,
        if let Action::Write { cell, .. } = tuple(30, 40) { cell } else { unreachable!() });
}
#[test]
fn full_history_snapshot_keeps_losers_removal_tombstone_and_pending() {
    let mut s = seed();
    let a = patch(&s, "A", vec![write("title", "loser"), add("member")]);
    let b = patch(&s, "B", vec![write("title", "winner")]); s.union(&[a, b]).unwrap();
    local(&mut s, "R", Command::Patch(vec![write("title", "resolved"), remove("member", &["A"])]));
    local(&mut s, "D", Command::Delete);
    s.union(&[op("P", &["missing"], Command::Patch(vec![write("title", "pending")]))]).unwrap();
    let bytes = s.snapshot().unwrap(); let restored = State::restore(schema(), &bytes).unwrap();
    assert_eq!(restored.history(), s.history()); assert_eq!(restored.snapshot().unwrap(), bytes);
    let p = restored.projection().unwrap(); assert!(p.deleted); assert_eq!(p.pending, BTreeSet::from([id("P")]));
    assert_eq!(title(&restored)[0].operation, id("R")); assert!(p.sets.is_empty());
    assert_eq!(restored.history().len(), 6);
}
#[test]
fn operation_limits_and_invalid_decoded_id_reject_before_mutation() {
    let mut s = seed();
    let actions: Vec<_> = (0..65).map(|i| write(&format!("field{i}"), "x")).collect();
    unchanged(&mut s, &[op("A", &["C"], Command::Patch(actions))], Error::Limit);
    let parents: Vec<_> = (0..33).map(|i| id(&format!("p{i:02}"))).collect();
    let mut too_many = op("A", &["C"], Command::Patch(vec![])); too_many.parents = parents;
    unchanged(&mut s, &[too_many], Error::Limit);
    unchanged(&mut s, &[op("A", &["C", "C"], Command::Patch(vec![]))], Error::InvalidOperation);
    let mut too_many_tags = remove("member", &[]);
    if let Action::Remove { tags, .. } = &mut too_many_tags {
        *tags = (0..(MAX_HISTORY + 1)).map(|i| id(&format!("t{i:04}"))).collect();
    }
    unchanged(&mut s, &[op("A", &["C"], Command::Patch(vec![too_many_tags]))], Error::Limit);
    let mut bad_id = op("A", &["C"], Command::Patch(vec![]));
    bad_id.id = serde_json::from_str("\"bad id\"").unwrap();
    unchanged(&mut s, &[bad_id], Error::InvalidId);
    let before = s.snapshot().unwrap(); let mut bad_schema = schema();
    bad_schema.fields.get_mut(&id("tags")).unwrap().nullable = true;
    assert_eq!(State::new(bad_schema, s.scope().clone()), Err(Error::InvalidSchema));
    assert_eq!(s.snapshot().unwrap(), before);
}
#[test]
fn dependency_chain_crosses_bitset_words_with_pending_tags_and_field_conflicts() {
    let mut s = seed();
    let branch = patch(&s, "B", vec![write("title", "concurrent")]);
    // Reverse lexical IDs ensure ordinals cannot be mistaken for causal order.
    // 256 dependencies cross multiple 64-bit words in both directions.
    let mut chain = Vec::new();
    let mut parent = "C".to_owned();
    let first_add = "chain0256";
    for step in 1..=256 {
        let name = format!("chain{:04}", 257 - step);
        let mut actions = vec![write("color", &format!("step{step}"))];
        if step == 1 { actions.push(add("member")); }
        if step == 65 { actions.push(write("title", "deep candidate")); }
        if step == 193 { actions.push(remove("member", &[first_add])); }
        chain.push(op(&name, &[&parent], Command::Patch(actions)));
        parent = name;
    }
    let tail = chain.last().unwrap().clone();
    s.union(&[tail.clone(), branch]).unwrap();
    let pending = s.projection().unwrap();
    assert_eq!(pending.pending, BTreeSet::from([tail.id.clone()]));
    assert!(!pending.fields.contains_key(&id("color")));
    assert_eq!(title(&s)[0].operation, id("B"));
    s = State::restore(schema(), &s.snapshot().unwrap()).unwrap();
    // Completing the missing chain in reverse delivery order must activate its
    // removal only after the exact add is in its transitive ancestor bitset.
    let predecessors: Vec<_> = chain[..255].iter().rev().cloned().collect();
    s.union(&predecessors).unwrap();
    let complete = s.projection().unwrap();
    assert!(complete.pending.is_empty());
    assert_eq!(complete.fields[&id("color")][0].operation, tail.id);
    assert_eq!(title(&s).iter().map(|c| c.operation.clone()).collect::<Vec<_>>(),
        vec![id("B"), id("chain0192")]);
    assert!(complete.sets.is_empty());
    assert_eq!(s.history().len(), 258);
    local(&mut s, "R", Command::Patch(vec![write("title", "causal resolution")]));
    assert_eq!(title(&s)[0].operation, id("R")); assert_eq!(title(&s).len(), 1);
    assert_eq!(State::restore(schema(), &s.snapshot().unwrap()).unwrap(), s);
    assert_eq!(s.history().len(), 259);
}
