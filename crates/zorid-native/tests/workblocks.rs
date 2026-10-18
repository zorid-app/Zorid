#![cfg(any(target_os = "macos", target_os = "linux"))]
use serde_json::{json, Value};
use zorid_core::OperationId;
use zorid_native::*;
fn client() -> OperationId {
    OperationId::new("10000000-0000-4000-8000-000000000001").unwrap()
}
fn setup() -> (
    tempfile::TempDir,
    NativeVault,
    ClientLease,
    WorkBlockSession,
) {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: zorid_sync_protocol::RealmId::new("local_test").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("vault_test").unwrap(),
        })
        .unwrap();
    let lease = vault.claim_client(&client()).unwrap();
    let session = vault.open_workblocks(&lease).unwrap();
    (dir, vault, lease, session)
}
fn call(
    v: &mut NativeVault,
    l: &ClientLease,
    s: &mut WorkBlockSession,
    c: Value,
) -> std::result::Result<Value, WorkBlockError> {
    v.execute_workblocks(l, s, serde_json::from_value(c).unwrap())
        .map(|r| serde_json::to_value(r).unwrap())
}
fn create(record: &str) -> Value {
    json!({"op":"create","record":record,"generation":format!("g_{record}"),"operation":format!("g_{record}"),"range":{"start_ms":"0","end_ms":"3600000","timezone":"America/Toronto"},"title":"Focus"})
}
fn read(record: &str) -> Value {
    json!({"op":"read","record":record,"generation":format!("g_{record}")})
}
fn mutation(op: &str, operation: &str, revision: Value) -> Value {
    json!({"op":op,"record":"one","generation":"g_one","operation":operation,"expectedRevision":revision})
}
#[test]
fn durable_create_replay_after_changes_and_reopen_preserves_original_receipt() {
    let (dir, mut v, l, mut s) = setup();
    let original = call(&mut v, &l, &mut s, create("one")).unwrap();
    let mut title = mutation("title", "title1", original["revision"].clone());
    title["title"] = json!("Changed");
    let changed = call(&mut v, &l, &mut s, title.clone()).unwrap();
    assert_eq!(call(&mut v, &l, &mut s, create("one")).unwrap(), original);
    assert_eq!(call(&mut v, &l, &mut s, title).unwrap(), changed);
    let mut stale = mutation("title", "stale", original["revision"].clone());
    stale["title"] = json!("lost");
    assert_eq!(
        call(&mut v, &l, &mut s, stale).unwrap_err().code(),
        "stale_revision"
    );
    drop(s);
    drop(l);
    drop(v);
    let mut v = NativeVault::open_existing(dir.path()).unwrap();
    let l = v.claim_client(&client()).unwrap();
    let mut s = v.open_workblocks(&l).unwrap();
    assert_eq!(call(&mut v, &l, &mut s, create("one")).unwrap(), original);
    let read = call(&mut v, &l, &mut s, read("one")).unwrap();
    assert_eq!(read["block"]["titles"][0]["title"], "Changed");
    assert_eq!(read["revision"], changed["revision"]);
    assert_eq!(v.family_status().unwrap().pending_authored, "2");
}
#[test]
fn observed_remove_exact_replay_does_not_erase_later_readdition() {
    let (_dir, mut v, l, mut s) = setup();
    let created = call(&mut v, &l, &mut s, create("one")).unwrap();
    let mut add = mutation("add_ref", "add1", created["revision"].clone());
    add["task"] = json!("missing_note");
    let added = call(&mut v, &l, &mut s, add).unwrap();
    let mut remove = mutation("remove_ref", "remove1", added["revision"].clone());
    remove["task"] = json!("missing_note");
    let removed = call(&mut v, &l, &mut s, remove.clone()).unwrap();
    let mut again = mutation("add_ref", "add2", removed["revision"].clone());
    again["task"] = json!("missing_note");
    call(&mut v, &l, &mut s, again).unwrap();
    assert_eq!(call(&mut v, &l, &mut s, remove.clone()).unwrap(), removed);
    remove["task"] = json!("different_note");
    assert!(call(&mut v, &l, &mut s, remove).is_err());
    let current = call(&mut v, &l, &mut s, read("one")).unwrap();
    assert_eq!(current["block"]["taskRefs"], json!(["missing_note"]));
}
#[test]
fn window_continuation_retries_and_invalidates_on_collection_change() {
    let (_dir, mut v, l, mut s) = setup();
    for r in ["one", "two", "three"] {
        call(&mut v, &l, &mut s, create(r)).unwrap();
    }
    let query = json!({"op":"window","fromMs":"0","untilMs":"1000","limit":1,"byteLimit":1048576});
    let first = call(&mut v, &l, &mut s, query.clone()).unwrap();
    assert_eq!(first["scanned"], 1);
    assert_eq!(first["blocks"].as_array().unwrap().len(), 1);
    let mut next = query.clone();
    next["cursor"] = first["cursor"].clone();
    let second = call(&mut v, &l, &mut s, next.clone()).unwrap();
    assert_eq!(call(&mut v, &l, &mut s, next.clone()).unwrap(), second);
    let mut mismatch = next.clone();
    mismatch["untilMs"] = json!("1001");
    assert_eq!(
        call(&mut v, &l, &mut s, mismatch).unwrap_err().code(),
        "invalid_request"
    );
    let mut independent = NativeVault::open_existing(_dir.path()).unwrap();
    let other = independent
        .claim_client(&OperationId::new("10000000-0000-4000-8000-000000000002").unwrap())
        .unwrap();
    let mut independent_session = independent.open_workblocks(&other).unwrap();
    call(
        &mut independent,
        &other,
        &mut independent_session,
        create("four"),
    )
    .unwrap();
    assert_eq!(
        call(&mut v, &l, &mut s, next).unwrap_err().code(),
        "window_changed"
    );
    let mut tiny = query.clone();
    tiny["byteLimit"] = json!(1);
    assert_eq!(call(&mut v, &l, &mut s, tiny).unwrap_err().code(), "limit");
    let mut half = query;
    half["fromMs"] = json!("3600000");
    half["untilMs"] = json!("3600001");
    let empty = call(&mut v, &l, &mut s, half).unwrap();
    assert_eq!(empty["blocks"], json!([]));
    assert_eq!(empty["scanned"], 1);
    assert!(empty["cursor"].is_string());
}
#[test]
fn invalid_range_empty_read_and_replaced_lease_never_bypass_checks() {
    let (_dir, mut v, l, mut s) = setup();
    let empty = call(&mut v, &l, &mut s, read("absent")).unwrap();
    assert_eq!(empty["created"], false);
    assert!(empty["block"].is_null());
    assert_eq!(empty["revision"].as_array().unwrap().len(), 32);
    let missing_title = mutation("title", "missing_title", empty["revision"].clone());
    assert!(serde_json::from_value::<WorkBlockCommand>(missing_title).is_err());
    let mut bad = create("bad");
    bad["range"]["start_ms"] = json!("00");
    assert_eq!(
        call(&mut v, &l, &mut s, bad).unwrap_err().code(),
        "invalid_workblock"
    );
    assert_eq!(v.family_status().unwrap().pending_authored, "0");
    drop(l);
    let replacement = v.claim_client(&client()).unwrap();
    assert_eq!(
        call(&mut v, &replacement, &mut s, read("absent"))
            .unwrap_err()
            .code(),
        "stale_session"
    );
    let mut fresh = v.open_workblocks(&replacement).unwrap();
    assert!(call(&mut v, &replacement, &mut fresh, read("absent")).is_ok());
}

#[test]
fn move_delete_reopen_and_cross_vault_capability_are_fenced() {
    let (dir, mut v, l, mut s) = setup();
    let created = call(&mut v, &l, &mut s, create("one")).unwrap();
    let mut moved = mutation("move", "move1", created["revision"].clone());
    moved["range"] = json!({"start_ms":"5000","end_ms":"9000","timezone":"UTC"});
    let receipt = call(&mut v, &l, &mut s, moved.clone()).unwrap();
    assert_eq!(
        call(&mut v, &l, &mut s, read("one")).unwrap()["block"]["ranges"][0]["range"]["start_ms"],
        "5000"
    );
    let (_otherdir, mut other, otherlease, _othersession) = setup();
    assert_eq!(
        call(&mut other, &otherlease, &mut s, read("one"))
            .unwrap_err()
            .code(),
        "stale_session"
    );
    let delete = mutation("delete", "delete1", receipt["revision"].clone());
    let deleted = call(&mut v, &l, &mut s, delete.clone()).unwrap();
    assert_eq!(call(&mut v, &l, &mut s, moved).unwrap(), receipt);
    drop(s);
    drop(l);
    drop(v);
    let mut v = NativeVault::open_existing(dir.path()).unwrap();
    let l = v.claim_client(&client()).unwrap();
    let mut s = v.open_workblocks(&l).unwrap();
    assert_eq!(call(&mut v, &l, &mut s, delete).unwrap(), deleted);
    let current = call(&mut v, &l, &mut s, read("one")).unwrap();
    assert_eq!(current["deleted"], true);
    assert!(current["block"].is_null());
}
