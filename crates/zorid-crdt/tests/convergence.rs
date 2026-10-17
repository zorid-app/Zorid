use zorid_crdt::TextReplica;

#[test]
fn offline_unicode_edits_converge_with_duplicate_and_reordered_updates() {
    let base = TextReplica::new(1);
    base.insert(0, "Hello 🦀 world").unwrap();
    let seed = base.snapshot();
    let a = TextReplica::new(2);
    let b = TextReplica::new(3);
    a.apply(&seed).unwrap();
    b.apply(&seed).unwrap();
    let before_a = a.state_vector();
    a.insert(8, " Rust").unwrap();
    let first = a.changes_since(&before_a).unwrap();
    let before_second = a.state_vector();
    a.insert(13, "!").unwrap();
    let second = a.changes_since(&before_second).unwrap();
    b.delete(9, 5).unwrap();
    b.insert(9, "世界").unwrap();
    let b_update = b.changes_since(&before_a).unwrap();
    a.apply(&b_update).unwrap();
    b.apply(&second).unwrap(); // Depends on first, delivered before it.
    b.apply(&second).unwrap();
    b.apply(&first).unwrap();
    b.apply(&first).unwrap();
    assert_eq!(a.text(), "Hello 🦀 Rust! 世界");
    assert_eq!(a.text(), b.text());
    let restored = TextReplica::new(4);
    restored.apply(&a.snapshot()).unwrap();
    assert_eq!(restored.text(), a.text());
}

#[test]
fn deletion_only_updates_are_not_detectable_from_state_vector_equality() {
    let a = TextReplica::new(1);
    a.insert(0, "keep remove").unwrap();
    let b = TextReplica::new(2);
    b.apply(&a.snapshot()).unwrap();
    let before = a.state_vector();
    a.delete(4, 7).unwrap();
    assert_eq!(before, a.state_vector());
    b.apply(&a.changes_since(&before).unwrap()).unwrap();
    assert_eq!(b.text(), "keep");
    // State vectors alone are not a durable revision or an acknowledgement.
}

#[test]
fn rejects_invalid_local_ranges_and_malformed_fixture_payloads() {
    let doc = TextReplica::new(1);
    doc.insert(0, "a🦀z").unwrap();
    assert!(doc.insert(2, "x").is_err());
    assert!(doc.delete(1, 1).is_err());
    assert!(doc.delete(u32::MAX, 1).is_err());
    assert!(doc.insert(5, "x").is_err());
    assert!(doc.apply(&[255]).is_err());
    assert!(doc.changes_since(&[255]).is_err());
    assert_eq!(doc.text(), "a🦀z");
}

#[test]
fn reads_persisted_yjs13_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../prototypes/core-crdt/yjs13-fixture.json"
    ))
    .unwrap();
    let bytes = |field: &str| -> Vec<u8> {
        fixture[field]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| u8::try_from(n.as_u64().unwrap()).unwrap())
            .collect()
    };
    let doc = TextReplica::new(102);
    doc.apply(&bytes("deleted")).unwrap(); // Delete arrives before its target.
    doc.apply(&bytes("seed")).unwrap();
    doc.apply(&bytes("deleted")).unwrap();
    assert_eq!(doc.text(), fixture["expected"].as_str().unwrap());
    assert_eq!(doc.state_vector(), bytes("before"));
}
