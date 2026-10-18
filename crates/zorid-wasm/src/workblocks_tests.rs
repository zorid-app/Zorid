use super::*;
use zorid_records::Command as RecordCommand;
const ENROLLED: &str = r#"{"realm_id":"realm","vault_id":"vault"}"#;
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn fixed(record: &str) -> Scope {
    service::fixed_scope(id("realm"), id("vault"), id(record), id("root")).unwrap()
}
fn create(record: &str) -> Command {
    Command::Create {
        record: id(record),
        generation: id("root"),
        operation: id("root"),
        range: domain::Range::new(0, 10, "UTC").unwrap(),
        title: None,
    }
}
fn apply(state: &mut State, operation: &str, command: RecordCommand) {
    let prepared = state.prepare(id(operation), command).unwrap();
    state.install(prepared).unwrap();
}
fn created(record: &str) -> State {
    let mut state = State::new(domain::schema(), fixed(record)).unwrap();
    apply(
        &mut state,
        "root",
        service::command_for_new(&create(record), None).unwrap(),
    );
    state
}
fn snap(state: &State) -> Vec<u8> {
    snapshot(
        &serde_json::to_string(state.scope()).unwrap(),
        Some(&state.snapshot().unwrap()),
        "[]",
    )
    .unwrap()
}
fn facts(input: &Command, state: Option<&State>) -> serde_json::Value {
    let scope = scope(&enrolled(ENROLLED).unwrap(), input).unwrap();
    let expected = expected(input, &scope).unwrap();
    serde_json::json!({"registration":serde_json::to_string(&domain::registration(id("realm"),id("vault")).unwrap()).unwrap(),
        "registration_revision":"registration-1","scope":scope,
        "accepted":state.map(|s|String::from_utf8(s.snapshot().unwrap()).unwrap()),"restore_source":null,
        "operation_sources":[],"local":{"operation":identity(input).unwrap().2.unwrap(),"expected_revision":expected,"prior_request":null,"prior_result":null},
        "usage":{"records":"0","state_bytes":"0","replaced_bytes":"0","receipts":"0","receipt_bytes":"0","operation_bytes":"0","local_operations":"0","local_bytes":"0","changes":"0"},"receipt":null,"cursor":null})
}
fn window(limit: u32, bytes: u32, cursor: Option<&str>) -> String {
    serde_json::to_string(&Command::Window {
        from_ms: "0".into(),
        until_ms: "10".into(),
        limit,
        byte_limit: bytes,
        cursor: cursor.map(str::to_string),
    })
    .unwrap()
}
fn page(scan: &mut WorkBlockWindowScan, eof: bool, token: &str) -> service::WorkBlockWindowPage {
    serde_json::from_slice(&scan.complete(eof, token).unwrap()).unwrap()
}
fn assert_code<T>(result: Result<T>, code: &str) {
    let failure = result.err().expect("expected rejection");
    assert_eq!(failure.code, code);
    assert_eq!(failure.source, "workblocks");
    assert!(!failure.commit_uncertain);
}
#[test]
fn fixed_read_set_rejects_authority_injection_and_invalid_bounds() {
    let set: serde_json::Value =
        serde_json::from_str(&read_set(ENROLLED, &encode(&create("record")).unwrap()).unwrap())
            .unwrap();
    assert_eq!(set["scope"], serde_json::to_value(fixed("record")).unwrap());
    assert_eq!(set["operation"], "root");
    assert_eq!(set["kind"], "mutation");
    assert_eq!(
        set["expectedRevision"],
        serde_json::json!(
            Sha256Digest::of(&service::empty_state_bytes(&fixed("record")).unwrap()).0
        )
    );
    let mut injected = serde_json::to_value(create("record")).unwrap();
    injected["owner"] = serde_json::json!("foreign");
    assert_code(
        read_set(ENROLLED, &serde_json::to_vec(&injected).unwrap()),
        "invalid_request",
    );
    assert_code(
        read_set(
            r#"{"realm_id":"realm","vault_id":"vault","owner":"foreign"}"#,
            &encode(&create("record")).unwrap(),
        ),
        "invalid_request",
    );
    assert_code(read_set(ENROLLED, window(65, 1, None).as_bytes()), "limit");
    assert_code(
        read_set(ENROLLED, br#"{"op":"changes","after":"01","limit":1}"#),
        "invalid_request",
    );
    assert_code(
        read_set(ENROLLED, br#"{"op":"changes","after":"0","limit":0}"#),
        "limit",
    );
    let mut wrong = create("record");
    if let Command::Create { operation, .. } = &mut wrong {
        *operation = id("other");
    }
    assert_code(
        read_set(ENROLLED, &encode(&wrong).unwrap()),
        "invalid_request",
    );
}
#[test]
fn plan_reuses_generic_authoring_bytes_and_original_empty_create_witness() {
    let command = create("record");
    let f = facts(&command, None);
    let raw = f.to_string();
    let plan = prepare(&raw, &encode(&command).unwrap()).unwrap();
    let generic = records::prepare_local_inner(
        &raw,
        &encode(&service::command_for_new(&command, None).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(plan.next_state(), generic.next_state());
    assert_eq!(plan.payload(), generic.payload());
    assert_eq!(plan.projection(), generic.projection());
    assert_eq!(plan.local_request(), generic.local_request());
    assert_eq!(
        plan.operation_bindings().unwrap(),
        generic.operation_bindings().unwrap()
    );
    let mut stale = f;
    stale["accepted"] =
        serde_json::json!(String::from_utf8(created("record").snapshot().unwrap()).unwrap());
    assert_code(
        prepare(&stale.to_string(), &encode(&command).unwrap()),
        "stale_revision",
    );
}
#[test]
fn exact_replay_returns_retained_receipt_without_current_state_facts() {
    let input = create("record");
    let scope = fixed("record");
    let witness = expected(&input, &scope).unwrap();
    let prior = admission::local_request(
        &scope,
        &witness,
        &service::command_for_new(&input, None).unwrap(),
    )
    .unwrap();
    // Stored receipt encoding is canonical struct order, not JSON Value map order.
    #[derive(Serialize)]
    struct Receipt<'a> {
        operation: &'a str,
        revision: [u8; 32],
        sequence: &'a str,
    }
    let result = encode(&Receipt {
        operation: "root",
        revision: [8; 32],
        sequence: "7",
    })
    .unwrap();
    assert_eq!(
        replay(
            ENROLLED,
            &encode(&input).unwrap(),
            Some(&prior),
            Some(&result)
        )
        .unwrap(),
        Some(result.clone())
    );
    assert!(replay(ENROLLED, &encode(&input).unwrap(), None, None)
        .unwrap()
        .is_none());
    assert_code(
        replay(ENROLLED, &encode(&input).unwrap(), Some(&prior), None),
        "storage_corrupt",
    );
    assert_code(
        replay(ENROLLED, &encode(&input).unwrap(), None, Some(&result)),
        "storage_corrupt",
    );
    assert_code(
        replay(
            ENROLLED,
            &encode(&input).unwrap(),
            Some(b"corrupt"),
            Some(&result),
        ),
        "storage_corrupt",
    );
    let mut other = input.clone();
    if let Command::Create { title, .. } = &mut other {
        *title = Some("changed".into());
    }
    assert_code(
        replay(
            ENROLLED,
            &encode(&other).unwrap(),
            Some(&prior),
            Some(&result),
        ),
        "operation_collision",
    );
    let mut damaged: serde_json::Value = serde_json::from_slice(&result).unwrap();
    damaged["operation"] = serde_json::json!("wrong");
    assert_code(
        replay(
            ENROLLED,
            &encode(&input).unwrap(),
            Some(&prior),
            Some(&serde_json::to_vec(&damaged).unwrap()),
        ),
        "storage_corrupt",
    );
}
#[test]
fn remove_replay_keeps_original_tags_after_readd() {
    let task = zorid_core::EntryId::new("task").unwrap();
    let mut state = created("record");
    apply(&mut state, "add", domain::add_task(&task));
    let witness = Sha256Digest::of(&state.snapshot().unwrap()).0;
    let input = Command::RemoveRef {
        record: id("record"),
        generation: id("root"),
        operation: id("remove"),
        expected_revision: WorkBlockRevision(witness),
        task: task.clone(),
    };
    let original = service::command_for_new(&input, Some(&state)).unwrap();
    let prior = admission::local_request(&fixed("record"), &witness, &original).unwrap();
    apply(&mut state, "remove", original.clone());
    apply(&mut state, "readd", domain::add_task(&task));
    assert_ne!(
        original,
        service::command_for_new(&input, Some(&state)).unwrap()
    );
    #[derive(Serialize)]
    struct Receipt {
        operation: Id,
        revision: [u8; 32],
        sequence: String,
    }
    let receipt = encode(&Receipt {
        operation: id("remove"),
        revision: [9; 32],
        sequence: "3".into(),
    })
    .unwrap();
    assert_eq!(
        replay(
            ENROLLED,
            &encode(&input).unwrap(),
            Some(&prior),
            Some(&receipt)
        )
        .unwrap(),
        Some(receipt)
    );
    assert_eq!(
        domain::read(&state)
            .unwrap()
            .unwrap()
            .task_refs
            .into_iter()
            .collect::<Vec<_>>(),
        vec![task]
    );
}
#[test]
fn snapshots_keep_all_conflicts_and_unknown_unresolved_statuses() {
    let base = created("record");
    let mut state = base.clone();
    for (op, range) in [
        ("move-a", domain::Range::new(20, 30, "UTC").unwrap()),
        ("move-b", domain::Range::new(5, 8, "UTC").unwrap()),
    ] {
        let p = base
            .prepare(id(op), domain::set_range(&range).unwrap())
            .unwrap();
        state.receive(p.payload()).unwrap();
    }
    let rows = r#"[{"updateId":"u1","status":"future_status","revision":"r1"},{"updateId":"u2","status":"future_status","revision":"r2"},{"updateId":"u3","status":"accepted","revision":"r3"}]"#;
    let bytes = snapshot(
        &serde_json::to_string(state.scope()).unwrap(),
        Some(&state.snapshot().unwrap()),
        rows,
    )
    .unwrap();
    let (view, _) = read(&bytes).unwrap();
    assert_eq!(view.block.as_ref().unwrap().ranges.len(), 2);
    assert_eq!(
        view.unresolved,
        BTreeMap::from([("future_status".into(), "2".into())])
    );
    let native: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(native["state"].is_string());
    assert_eq!(
        native["revision"],
        serde_json::json!(Sha256Digest::of(&state.snapshot().unwrap()).0)
    );
    let session = WorkBlockWindowSession::new();
    let mut scan = session.start(&window(1, 1_048_576, None), "9").unwrap();
    assert!(scan.accept(&bytes, r#"["record","root"]"#).unwrap());
    assert_eq!(page(&mut scan, false, "cursor1").blocks.len(), 1);
    session.close();
}
#[test]
fn absent_deleted_and_corrupt_snapshots() {
    let bytes = snapshot(
        &serde_json::to_string(&fixed("record")).unwrap(),
        None,
        "[]",
    )
    .unwrap();
    let (view, _) = read(&bytes).unwrap();
    assert!(!view.created);
    assert!(view.block.is_none());
    let mut state = created("record");
    apply(&mut state, "delete", domain::delete());
    let (view, _) = read(&snap(&state)).unwrap();
    assert!(view.deleted);
    assert!(view.block.is_none());
    let mut damaged: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    damaged["revision"] = serde_json::json!(vec![0; 32]);
    assert_code(
        read(&serde_json::to_vec(&damaged).unwrap()),
        "storage_corrupt",
    );
    let mut excessive: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    excessive["unresolved"] = serde_json::json!({"future":"4097"});
    assert_code(
        read(&serde_json::to_vec(&excessive).unwrap()),
        "storage_corrupt",
    );
    assert_code(
        snapshot(
            &serde_json::to_string(&fixed("record")).unwrap(),
            Some(b"bad"),
            "[]",
        ),
        "storage_corrupt",
    );
    let duplicate = r#"[{"updateId":"u","status":"future","revision":"r"},{"updateId":"u","status":"future","revision":"r"}]"#;
    assert_code(
        snapshot(
            &serde_json::to_string(&fixed("record")).unwrap(),
            None,
            duplicate,
        ),
        "storage_corrupt",
    );
}
#[test]
fn changes_use_native_tuple_and_identity_and_monotonic_next() {
    let rows = r#"[{"sequence":"2","record":"record","generation":"root","operationId":"u2","status":"future"},{"sequence":"9","record":"other","generation":"root","operationId":"u9","status":"accepted"}]"#;
    let page: serde_json::Value = serde_json::from_slice(&changes(rows, "1").unwrap()).unwrap();
    assert_eq!(page["next"], "9");
    assert_eq!(page["changes"][0]["record_key"], r#"["record","root"]"#);
    assert_eq!(page["changes"][0]["update_id"], "u2");
    assert_eq!(page["changes"][0]["status"], "future");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&changes("[]", "17").unwrap()).unwrap()["next"],
        "17"
    );
    assert_code(changes(rows, "2"), "storage_corrupt");
    assert_code(changes(rows, "01"), "invalid_request");
}
#[test]
fn byte_rejected_row_is_not_consumed_and_first_oversize_is_limit() {
    let a = snap(&created("a"));
    let b = snap(&created("b"));
    let session = WorkBlockWindowSession::new();
    let mut tiny = session
        .start(&window(64, a.len() as u32 - 1, None), "0")
        .unwrap();
    assert_code(tiny.accept(&a, r#"["a","root"]"#), "limit");
    assert_eq!(tiny.after, None);
    let mut scan = session
        .start(&window(64, (a.len() + b.len() - 1) as u32, None), "0")
        .unwrap();
    assert!(scan.accept(&a, r#"["a","root"]"#).unwrap());
    assert!(!scan.accept(&b, r#"["b","root"]"#).unwrap());
    assert_eq!(scan.after.as_deref(), Some(r#"["a","root"]"#));
    let page = page(&mut scan, false, "next");
    assert_eq!(page.bytes, a.len() as u32);
    assert_eq!(page.scanned, 1);
    assert!(page.incomplete);
    let scan = session
        .start(
            &window(64, (a.len() + b.len() - 1) as u32, Some("next")),
            "0",
        )
        .unwrap();
    assert_eq!(scan.after.as_deref(), Some(r#"["a","root"]"#));
}
#[test]
fn filtered_and_deleted_rows_cost_bytes_rows_and_make_empty_continuation() {
    let mut state = created("a");
    apply(
        &mut state,
        "away",
        domain::set_range(&domain::Range::new(10, 20, "UTC").unwrap()).unwrap(),
    );
    let a = snap(&state);
    let mut state = created("b");
    apply(&mut state, "delete", domain::delete());
    let b = snap(&state);
    let session = WorkBlockWindowSession::new();
    let mut scan = session.start(&window(2, 1_048_576, None), "0").unwrap();
    assert!(scan.accept(&a, r#"["a","root"]"#).unwrap());
    assert!(scan.accept(&b, r#"["b","root"]"#).unwrap());
    let p = page(&mut scan, false, "next");
    assert!(p.blocks.is_empty());
    assert_eq!(p.scanned, 2);
    assert_eq!(p.bytes, (a.len() + b.len()) as u32);
    let mut next = session
        .start(&window(2, 1_048_576, Some("next")), "0")
        .unwrap();
    let end = page(&mut next, true, "");
    assert_eq!(end.scanned, 0);
    assert!(!end.incomplete);
    assert!(end.cursor.is_none());
}
#[test]
fn cursor_query_fence_lifetime_and_eviction_are_session_owned() {
    let session = WorkBlockWindowSession::new();
    let a = snap(&created("a"));
    let mut scan = session.start(&window(1, 1_048_576, None), "4").unwrap();
    scan.accept(&a, r#"["a","root"]"#).unwrap();
    let p = page(&mut scan, false, "first");
    assert_eq!(p.cursor.as_deref(), Some("first"));
    assert_code(
        session.start(&window(2, 1_048_576, Some("first")), "4"),
        "invalid_request",
    );
    assert_code(
        session.start(&window(1, 1_048_576, Some("first")), "5"),
        "window_changed",
    );
    assert_code(
        WorkBlockWindowSession::new().start(&window(1, 1_048_576, Some("first")), "4"),
        "cursor_expired",
    );
    // Same progress gets the existing token, even if the host supplies no new token.
    let mut same = session.start(&window(1, 1_048_576, None), "4").unwrap();
    same.accept(&a, r#"["a","root"]"#).unwrap();
    assert_eq!(page(&mut same, false, "").cursor, p.cursor);
    for i in 0..8 {
        let mut s = session
            .start(&window(1, 1_048_576, None), &(10 + i).to_string())
            .unwrap();
        s.accept(&a, r#"["a","root"]"#).unwrap();
        page(&mut s, false, &format!("token{i}"));
    }
    assert_eq!(session.inner.borrow().cursors.len(), 8);
    assert_code(
        session.start(&window(1, 1_048_576, Some("first")), "4"),
        "cursor_expired",
    );
    let mut live = session.start(&window(1, 1_048_576, None), "20").unwrap();
    session.close();
    assert_code(live.accept(&a, r#"["a","root"]"#), "stale_session");
    assert_code(live.complete(true, ""), "stale_session");
}
#[test]
fn window_rejects_noncanonical_or_mismatched_keys_and_repeated_finish() {
    let session = WorkBlockWindowSession::new();
    let a = snap(&created("a"));
    let mut scan = session.start(&window(2, 1_048_576, None), "0").unwrap();
    assert_code(scan.accept(&a, r#"[ "a", "root" ]"#), "invalid_request");
    assert_code(scan.accept(&a, r#"["wrong","root"]"#), "storage_corrupt");
    assert!(scan.accept(&a, r#"["a","root"]"#).unwrap());
    assert_code(scan.accept(&a, r#"["a","root"]"#), "invalid_request");
    page(&mut scan, true, "");
    assert_code(scan.complete(true, ""), "stale_session");
    assert_code(
        session.start(&window(1, 1_048_576, None), "00"),
        "invalid_request",
    );
    let too_long = serde_json::json!({"op":"window","fromMs":"0","untilMs":"2678400001","limit":1,"byteLimit":100});
    assert_code(
        session.start(&too_long.to_string(), "0"),
        "invalid_workblock",
    );
}

#[test]
fn remote_authored_identity_without_local_receipt_is_collision_before_stale_or_corrupt_state() {
    let input = create("record");
    let mut f = facts(&input, None);
    f["accepted"] = serde_json::json!("corrupt current state");
    f["operation_sources"] = serde_json::json!([{"operation":"root","update":"remote-update","content":"retained remote source"}]);
    assert_code(
        prepare(&f.to_string(), &encode(&input).unwrap()),
        "operation_collision",
    );
    // Preparation never accepts a journal path; the host must call replay before reading facts.
    f["local"]["prior_request"] = serde_json::json!("retained");
    assert_code(
        prepare(&f.to_string(), &encode(&input).unwrap()),
        "invalid_request",
    );
}

#[test]
fn private_storage_keys_use_idb_tuple_order_even_when_json_escaping_changes_lexical_order() {
    let session = WorkBlockWindowSession::new();
    let mut scan = session.start(&window(2, 1_048_576, None), "0").unwrap();
    let first = "a\"";
    let second = "a-";
    let first_key = serde_json::to_string(&(first, "root")).unwrap();
    let second_key = serde_json::to_string(&(second, "root")).unwrap();
    assert!(first < second);
    assert!(first_key > second_key);
    assert_eq!(work_block_storage_key(&first_key).unwrap(), first_key);
    assert!(scan.accept(&snap(&created(first)), &first_key).unwrap());
    assert!(scan.accept(&snap(&created(second)), &second_key).unwrap());
    assert_eq!(page(&mut scan, true, "").scanned, 2);
    assert_code(key(r#"["a","root","extra"]"#), "invalid_request");
    assert_code(key(r#"["","root"]"#), "invalid_request");
}
