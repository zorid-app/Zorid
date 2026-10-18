//! Synthetic representation experiments, not a managed-record API or sync engine.
//! No persistence, encryption, schema migration, permissions, or app integration.
//! Policy helpers intentionally accept only trusted, bounded fixture operations.
//! Tags and keys are trusted synthetic identities, not validated host inputs.
//! Scalar arbitration does not preserve conflict loser history for recovery.
use serde_json::{json, Value};
use std::collections::BTreeSet;
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{any, Any, Doc, Map, MapPrelim, ReadTxn, StateVector, Transact, Update};

fn replica(actor: u64, seed: &[u8]) -> Doc {
    let doc = Doc::with_client_id(actor);
    // Stable root identity avoids concurrent creation of competing nested maps.
    for root in ["fields", "adds", "removes", "deletions"] {
        doc.get_or_insert_map(root);
    }
    apply(&doc, seed);
    doc
}

fn apply(doc: &Doc, bytes: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(bytes).unwrap())
        .unwrap();
}

fn snapshot(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

fn empty_seed() -> Vec<u8> {
    snapshot(&Doc::with_client_id(11))
}

fn put(doc: &Doc, root: &str, key: &str, value: Any) -> Vec<u8> {
    let map = doc.get_or_insert_map(root);
    let mut tx = doc.transact_mut();
    map.insert(&mut tx, key, value);
    tx.encode_update_v1()
}

fn unset(doc: &Doc, root: &str, key: &str) -> Vec<u8> {
    let map = doc.get_or_insert_map(root);
    let mut tx = doc.transact_mut();
    map.remove(&mut tx, key);
    tx.encode_update_v1()
}

fn root_json(doc: &Doc, root: &str) -> Value {
    let map = doc.get_or_insert_map(root);
    serde_json::to_value(map.to_json(&doc.transact())).unwrap()
}

fn members(doc: &Doc) -> BTreeSet<String> {
    let adds = root_json(doc, "adds");
    let removes = root_json(doc, "removes");
    adds.as_object().unwrap().iter()
        .filter(|(tag, _)| removes.get(*tag).is_none())
        .map(|(_, member)| member.as_str().unwrap().to_owned())
        .collect()
}

fn projection(doc: &Doc) -> Value {
    json!({
        "fields": root_json(doc, "fields"),
        "members": members(doc),
        "deletions": root_json(doc, "deletions"),
    })
}

fn expected(fields: Value, members: &[&str], deletions: Value) -> Value {
    let members: BTreeSet<_> = members.iter().copied().collect();
    json!({"fields": fields, "members": members, "deletions": deletions})
}

fn orders(n: usize) -> Vec<Vec<usize>> {
    fn visit(prefix: &mut Vec<usize>, n: usize, out: &mut Vec<Vec<usize>>) {
        if prefix.len() == n {
            out.push(prefix.clone());
        } else {
            for i in 0..n {
                if !prefix.contains(&i) {
                    prefix.push(i);
                    visit(prefix, n, out);
                    prefix.pop();
                }
            }
        }
    }
    assert!(n <= 4, "keep permutation exploration bounded");
    let mut out = Vec::new();
    visit(&mut Vec::new(), n, &mut out);
    out
}

/// Every delivery permutation, duplicate delivery, snapshot at every prefix,
/// then an independent observer. Compare logical JSON, never wire byte order.
fn assert_replay(seed: &[u8], updates: &[Vec<u8>], want: Value) {
    for order in orders(updates.len()) {
        let mut observer = replica(44, seed);
        for index in order {
            apply(&observer, &updates[index]);
            apply(&observer, &updates[index]);
            observer = replica(44, &snapshot(&observer));
        }
        assert!(!observer.transact().has_missing_updates());
        assert_eq!(projection(&observer), want);
        let restored = replica(55, &snapshot(&observer));
        assert_eq!(projection(&restored), want);
    }
}

fn seed_fields() -> Vec<u8> {
    let seed = replica(11, &empty_seed());
    put(&seed, "fields", "title", any!("original"));
    put(&seed, "fields", "color", any!("gray"));
    snapshot(&seed)
}

#[test]
fn independent_field_patches_survive_all_delivery_orders() {
    let seed = seed_fields();
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    let ua = put(&a, "fields", "title", any!("edited"));
    let ub = put(&b, "fields", "color", any!("blue"));
    let want = expected(json!({"title":"edited", "color":"blue"}), &[], json!({}));
    apply(&a, &ub);
    apply(&b, &ua);
    assert_eq!(projection(&a), want);
    assert_eq!(projection(&b), want);
    assert_replay(&seed, &[ua, ub], want);
}

#[test]
fn replacing_whole_objects_loses_an_independent_field_negative_control() {
    let seed = replica(11, &empty_seed());
    put(&seed, "fields", "record", any!({"title":"original", "color":"gray"}));
    let seed = snapshot(&seed);
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    let ua = put(&a, "fields", "record", any!({"title":"edited", "color":"gray"}));
    let ub = put(&b, "fields", "record", any!({"title":"original", "color":"blue"}));
    // Higher concurrent actor wins the entire atomic object, losing A's title.
    assert_replay(&seed, &[ua, ub], expected(
        json!({"record":{"title":"original", "color":"blue"}}), &[], json!({})));
}

#[test]
fn concurrently_created_nested_maps_do_not_deep_merge_negative_control() {
    let seed = empty_seed();
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    let create = |doc: &Doc, key: &str, value: &str| {
        let root = doc.get_or_insert_map("fields");
        let mut tx = doc.transact_mut();
        let child = root.insert(&mut tx, "record", MapPrelim::default());
        child.insert(&mut tx, key, value);
        tx.encode_update_v1()
    };
    let ua = create(&a, "title", "edited");
    let ub = create(&b, "color", "blue");
    assert_replay(&seed, &[ua, ub], expected(
        json!({"record":{"color":"blue"}}), &[], json!({})));
}

#[test]
fn scalar_arbitration_uses_actor_order_then_causal_overwrite() {
    for (actor_a, actor_b, winner) in [(22, 33, "B"), (33, 22, "A")] {
        let seed = seed_fields();
        let a = replica(actor_a, &seed);
        let b = replica(actor_b, &seed);
        let ua = put(&a, "fields", "title", any!("A"));
        let ub = put(&b, "fields", "title", any!("B"));
        assert_replay(&seed, &[ua.clone(), ub.clone()], expected(
            json!({"title":winner, "color":"gray"}), &[], json!({})));
        apply(&a, &ub);
        let later = put(&a, "fields", "title", any!("causally later"));
        assert_replay(&seed, &[ua, ub, later], expected(
            json!({"title":"causally later", "color":"gray"}), &[], json!({})));
    }
}

fn schedule(doc: &Doc, start: i64, end: i64, zone: &str) -> Result<Vec<u8>, &'static str> {
    if start >= end || zone.is_empty() {
        return Err("invalid synthetic schedule");
    }
    // Atomic Any::Map, deliberately not a nested shared map.
    Ok(put(doc, "fields", "schedule", any!({"start":start, "end":end, "zone":zone})))
}

#[test]
fn schedule_tuple_stays_atomic_and_invalid_local_write_does_not_mutate() {
    let seed = empty_seed();
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    let before = projection(&a);
    assert!(schedule(&a, 20, 10, "UTC").is_err());
    assert_eq!(projection(&a), before);
    let ua = schedule(&a, 10, 20, "UTC").unwrap();
    let ub = schedule(&b, 30, 40, "America/Toronto").unwrap();
    assert_replay(&seed, &[ua, ub], expected(json!({
        "schedule":{"start":30,"end":40,"zone":"America/Toronto"}
    }), &[], json!({})));
}

#[test]
fn independently_merged_schedule_components_can_break_invariants_negative_control() {
    let seed = replica(11, &empty_seed());
    put(&seed, "fields", "start", any!(10));
    put(&seed, "fields", "end", any!(20));
    let seed = snapshot(&seed);
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    // Each writer leaves a locally valid interval: [19,20] and [10,11].
    let ua = put(&a, "fields", "start", any!(19));
    let ub = put(&b, "fields", "end", any!(11));
    // CRDT convergence alone does not preserve start < end.
    assert_replay(&seed, &[ua, ub], expected(
        json!({"start":19,"end":11}), &[], json!({})));
}

/// Tags are unique fixture operation IDs; callers cannot recycle them.
fn add(doc: &Doc, tag: &str, member: &str) -> Vec<u8> {
    put(doc, "adds", tag, Any::from(member))
}

fn remove_observed(doc: &Doc, member: &str) -> Vec<u8> {
    let adds = root_json(doc, "adds");
    let removes = doc.get_or_insert_map("removes");
    let mut tx = doc.transact_mut();
    for (tag, value) in adds.as_object().unwrap() {
        if value.as_str() == Some(member) {
            removes.insert(&mut tx, tag.as_str(), true);
        }
    }
    tx.encode_update_v1()
}

#[test]
fn observed_remove_set_deduplicates_members_and_concurrent_add_survives() {
    let seed = replica(11, &empty_seed());
    add(&seed, "11:1", "option-red");
    let seed = snapshot(&seed);
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    let removed = remove_observed(&a, "option-red");
    let readded = add(&b, "33:1", "option-red");
    let distinct = add(&b, "33:2", "option-blue");
    assert_replay(&seed, &[removed.clone(), readded.clone(), distinct.clone()], expected(
        json!({}), &["option-blue", "option-red"], json!({})));
    apply(&a, &readded);
    apply(&a, &distinct);
    let observed_all = remove_observed(&a, "option-red");
    assert_replay(&seed, &[removed, readded, distinct, observed_all], expected(
        json!({}), &["option-blue"], json!({})));
}

#[test]
fn two_concurrent_adds_of_same_stable_member_have_one_logical_membership() {
    let seed = empty_seed();
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    let ua = add(&a, "22:1", "option-red");
    let ub = add(&b, "33:1", "option-red");
    assert_replay(&seed, &[ua, ub], expected(json!({}), &["option-red"], json!({})));
}

fn delete_generation(doc: &Doc, generation: &str) -> Vec<u8> {
    // No clearing operation: restoration gets a distinct generation identity.
    put(doc, "deletions", generation, any!(true))
}

fn visible(doc: &Doc, generation: &str) -> bool {
    let prefix = format!("{generation}/");
    root_json(doc, "deletions").get(generation).is_none()
        && root_json(doc, "fields").as_object().unwrap().keys()
            .any(|key| key.starts_with(&prefix))
}

#[test]
fn retained_deleted_generation_keeps_concurrent_edits_and_restore_is_distinct() {
    let seed = replica(11, &empty_seed());
    put(&seed, "fields", "g1/title", any!("original"));
    let seed = snapshot(&seed);
    let a = replica(22, &seed);
    let b = replica(33, &seed);
    let deleted = delete_generation(&a, "g1");
    let edited = put(&b, "fields", "g1/title", any!("offline edit"));
    let added = add(&b, "33:1", "g1/task-1");
    let want = expected(json!({"g1/title":"offline edit"}), &["g1/task-1"], json!({"g1":true}));
    assert_replay(&seed, &[deleted.clone(), edited.clone(), added.clone()], want);
    apply(&a, &edited);
    apply(&a, &added);
    assert!(!visible(&a, "g1"));
    let fields = a.get_or_insert_map("fields");
    let restored_title = root_json(&a, "fields")["g1/title"].as_str().unwrap().to_owned();
    let restored = {
        let mut tx = a.transact_mut();
        fields.insert(&mut tx, "g2/restoredFrom", "g1");
        fields.insert(&mut tx, "g2/title", restored_title.as_str());
        tx.encode_update_v1()
    };
    let late = put(&b, "fields", "g1/title", any!("delayed old-generation edit"));
    let after_delete = replica(66, &seed);
    apply(&after_delete, &deleted);
    // Seed the new stage with already delivered old operations, then permute
    // restore and late edit. Old generation stays hidden with payload retained.
    apply(&after_delete, &edited);
    apply(&after_delete, &added);
    let stage = snapshot(&after_delete);
    assert_replay(&stage, &[restored.clone(), late.clone()], expected(json!({
        "g1/title":"delayed old-generation edit", "g2/restoredFrom":"g1",
        "g2/title":"offline edit"
    }), &["g1/task-1"], json!({"g1":true})));
    apply(&after_delete, &restored);
    apply(&after_delete, &late);
    assert!(!visible(&after_delete, "g1"));
    assert!(visible(&after_delete, "g2"));
    assert!(!visible(&after_delete, "nonexistent"));
}

fn old_client_patch(doc: &Doc, key: &str, value: Option<Any>) -> Result<Vec<u8>, &'static str> {
    if !matches!(key, "title" | "color") {
        return Err("unknown field is not writable by this client");
    }
    Ok(match value {
        Some(value) => put(doc, "fields", key, value),
        None => unset(doc, "fields", key),
    })
}

#[test]
fn old_client_patches_preserve_unknown_scalar_tuple_and_set_fields() {
    let seed = replica(11, &seed_fields());
    put(&seed, "fields", "future-scalar", any!("new"));
    put(&seed, "fields", "future-tuple", any!({"count":2,"unit":"hours"}));
    add(&seed, "11:future", "future-set/option-red");
    let seed = snapshot(&seed);
    let old = replica(22, &seed);
    let newer = replica(33, &seed);
    let before = projection(&old);
    assert!(old_client_patch(&old, "future-scalar", Some(any!("clobber"))).is_err());
    assert_eq!(projection(&old), before);
    let title = old_client_patch(&old, "title", Some(any!("older edit"))).unwrap();
    let unset_color = old_client_patch(&old, "color", None).unwrap();
    let future = put(&newer, "fields", "future-scalar", any!("concurrent newer edit"));
    assert_replay(&seed, &[title, unset_color, future], expected(json!({
        "title":"older edit", "future-scalar":"concurrent newer edit",
        "future-tuple":{"count":2,"unit":"hours"}
    }), &["future-set/option-red"], json!({})));
}

#[test]
fn dependent_update_survives_pending_snapshot_and_duplicate_delivery() {
    let seed = empty_seed();
    let writer = replica(22, &seed);
    let first = put(&writer, "fields", "title", any!("first"));
    let second = put(&writer, "fields", "title", any!("second"));
    let pending = replica(44, &seed);
    apply(&pending, &second);
    assert!(pending.transact().has_missing_updates());
    let restored = replica(55, &snapshot(&pending));
    assert!(restored.transact().has_missing_updates());
    apply(&restored, &first);
    assert!(!restored.transact().has_missing_updates());
    assert_replay(&seed, &[first, second], expected(json!({"title":"second"}), &[], json!({})));
}

#[test]
fn structured_snapshot_is_rejected_by_existing_plain_text_boundary() {
    let structured = replica(11, &seed_fields());
    let plain = zorid_crdt::TextReplica::new(77);
    plain.validate_plain_text().unwrap();
    // Decodable Yrs bytes are not sufficient for admission as plain text.
    plain.apply(&snapshot(&structured)).unwrap();
    assert!(!plain.has_missing_updates());
    assert!(plain.validate_plain_text().is_err());
}
