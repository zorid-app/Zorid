use super::*;
use std::io::Cursor;

fn owner() -> WasmDocumentRuntimeOwner {
    let owner = WasmDocumentRuntimeOwner::new("committed", "store").unwrap();
    configure(&mut owner.state.borrow_mut(), "client", "draft", "work").unwrap();
    owner
}
fn value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap()
}
fn control(owner: &WasmDocumentRuntimeOwner, raw: Value) -> Value {
    value(
        &command(
            &mut owner.state.borrow_mut(),
            request(&raw.to_string()).unwrap(),
        )
        .unwrap(),
    )
}
fn source(text: &str) -> Value {
    let hash = zorid_file_sync::Sha256Digest::of(text.as_bytes())
        .0
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    json!({"bytes":text.len(),"utf16":text.encode_utf16().count(),"sha256":hash})
}
fn reserve(owner: &WasmDocumentRuntimeOwner, buffer: &str, revision: &str, text: &str) -> Value {
    control(owner,json!({"op":"request","buffer_lifetime":buffer,"text_revision":revision,"source":source(text)}))["state"]["admitted"].clone()
}
fn attach(owner: &WasmDocumentRuntimeOwner, job: &Value, text: &str) {
    control(owner, json!({"op":"upload_begin","job":job}));
    if !text.is_empty() {
        let raw = json!({"op":"upload_chunk","job":job,"offset":"0"}).to_string();
        upload(
            &mut owner.state.borrow_mut(),
            &raw,
            text.len(),
            &mut Cursor::new(text.as_bytes()),
        )
        .unwrap();
    }
    control(owner, json!({"op":"upload_seal","job":job}));
}
fn next(owner: &WasmDocumentRuntimeOwner) -> Value {
    value(&next_turn(&mut owner.state.borrow_mut()).unwrap())
}
fn drive_ready(owner: &WasmDocumentRuntimeOwner, job: &Value) {
    let exact: Job = serde_json::from_value(job.clone()).unwrap();
    let exact = exact.resolve(&OperationId::new("client").unwrap()).unwrap();
    for _ in 0..32 {
        if owner
            .state
            .borrow()
            .drafts
            .as_ref()
            .unwrap()
            .facts(&exact)
            .is_ok()
        {
            return;
        }
        let turn = next(owner);
        assert_eq!(turn["work"]["selected"]["lane"], "draft");
        step_draft(
            &mut owner.state.borrow_mut(),
            &turn["work"]["selected"].to_string(),
        )
        .unwrap();
    }
    panic!("draft failed to become Ready in bounded fixture turns");
}

#[test]
fn trusted_configuration_is_lazy_fixed_and_rejects_releasing_owner() {
    let owner = owner();
    assert!(owner.state.borrow().drafts.is_none());
    assert_eq!(
        next(&owner),
        json!({"work":null,"turn":null,"continued":null})
    );
    assert!(control(&owner, json!({"op":"snapshot"}))["state"].is_null());
    configure(&mut owner.state.borrow_mut(), "client", "draft", "work").unwrap();
    assert_eq!(
        configure(&mut owner.state.borrow_mut(), "foreign", "draft", "work"),
        Err("draft_owner_mismatch")
    );
    owner.command_json(r#"{"kind":"retire"}"#).unwrap();
    assert_eq!(
        configure(&mut owner.state.borrow_mut(), "client", "draft", "work"),
        Err("draft_closed")
    );
}
#[test]
fn controls_reject_payload_phase_completion_unknown_duplicate_and_noncanonical_fields() {
    for raw in [
        r#"{"op":"complete","job":{}}"#,
        r#"{"op":"request","buffer_lifetime":"b","text_revision":"01","source":{"bytes":0,"utf16":0,"sha256":"00"}}"#,
        r#"{"op":"snapshot","proof":true}"#,
        r#"{"op":"snapshot","op":"snapshot"}"#,
        r#"{"op":"request","buffer_lifetime":"b","text_revision":"0","phase":"parse","source":{}}"#,
        r#"{"op":"upload_chunk","job":{"lifetime":"draft","id":"0","buffer_lifetime":"b","text_revision":"0"},"offset":"0","bytes":[1]}"#,
    ] {
        assert!(request(raw).is_err(), "{raw}");
    }
    assert_eq!(
        request(&"x".repeat(CONTROL_BYTES + 1)).unwrap_err(),
        "draft_control_limit"
    );
    let owner = owner();
    let invalid=request(r#"{"op":"request","buffer_lifetime":"b","text_revision":"0","source":{"bytes":1,"utf16":1,"sha256":"AA"}}"#).unwrap();
    assert_eq!(
        command(&mut owner.state.borrow_mut(), invalid),
        Err("draft_invalid_source")
    );
    assert!(owner.state.borrow().drafts.is_none());
    let before = control(&owner, json!({"op":"snapshot"}));
    assert!(request(r#"{"op":"snapshot","proof":true}"#).is_err());
    let after = control(&owner, json!({"op":"snapshot"}));
    assert_eq!(after, before);
    assert!(owner.state.borrow().drafts.is_none());
}
#[test]
fn request_reply_is_scoped_decimal_exact_and_replay_keeps_one_actual_executor_job() {
    let owner = owner();
    let first = reserve(&owner, "buffer", "18446744073709551615", "small");
    assert_eq!(first["text_revision"], "18446744073709551615");
    assert!(first.get("client").is_none());
    let second = control(
        &owner,
        json!({"op":"request","buffer_lifetime":"buffer","text_revision":"18446744073709551615","source":source("small")}),
    );
    assert_eq!(second["state"]["admitted"], first);
    assert_eq!(second["state"]["replay"], true);
    assert!(second["state"].get("in_flight").is_none());
    assert_eq!(
        owner
            .state
            .borrow()
            .drafts
            .as_ref()
            .unwrap()
            .snapshot()
            .handles,
        1
    );
}
#[test]
fn portable_ingress_is_admitted_before_reader_and_invalid_replay_cannot_rewrite_source() {
    struct ObservedRead {
        reads: usize,
    }
    impl Read for ObservedRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            Ok(0)
        }
    }
    let owner = owner();
    let job = reserve(&owner, "buffer", "1", "abcd");
    control(&owner, json!({"op":"upload_begin","job":job}));
    let mut reader = ObservedRead { reads: 0 };
    let raw = json!({"op":"upload_chunk","job":job,"offset":"1"}).to_string();
    assert_eq!(
        upload(&mut owner.state.borrow_mut(), &raw, 1, &mut reader),
        Err("draft_invalid_offset")
    );
    assert_eq!(reader.reads, 0);
    let raw = json!({"op":"upload_chunk","job":job,"offset":"0"}).to_string();
    upload(
        &mut owner.state.borrow_mut(),
        &raw,
        4,
        &mut Cursor::new(b"abcd"),
    )
    .unwrap();
    upload(
        &mut owner.state.borrow_mut(),
        &raw,
        4,
        &mut Cursor::new(b"abcd"),
    )
    .unwrap();
    assert_eq!(
        upload(
            &mut owner.state.borrow_mut(),
            &raw,
            4,
            &mut Cursor::new(b"abce")
        ),
        Err("draft_invalid_offset")
    );
    let progress = control(&owner, json!({"op":"progress","job":job}));
    assert_eq!(progress["transfer"]["source_bytes_received"], 4);
    assert!(progress["transfer_scratch_bytes"].as_u64().unwrap() >= 4);
    control(&owner, json!({"op":"upload_seal","job":job}));
}
#[test]
fn source_mismatch_rejects_seal_and_never_fabricates_ready_facts() {
    let owner = owner();
    let job = reserve(&owner, "buffer", "1", "abcd");
    control(&owner, json!({"op":"upload_begin","job":job}));
    let raw = json!({"op":"upload_chunk","job":job,"offset":"0"}).to_string();
    upload(
        &mut owner.state.borrow_mut(),
        &raw,
        4,
        &mut Cursor::new(b"abce"),
    )
    .unwrap();
    let seal = request(&json!({"op":"upload_seal","job":job}).to_string()).unwrap();
    assert_eq!(
        command(&mut owner.state.borrow_mut(), seal),
        Err("draft_invalid_source")
    );
    assert!(
        control(&owner, json!({"op":"snapshot"}))["state"]["outcomes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn facts_plan_and_writer_revalidate_ready_exact_output_and_revoked_jobs() {
    let owner = owner();
    let job = reserve(&owner, "buffer", "1", "# Heading 😀\n[[Target]]");
    attach(&owner, &job, "# Heading 😀\n[[Target]]");
    drive_ready(&owner, &job);
    control(&owner, json!({"op":"facts_prepare","job":job}));
    let raw = json!({"op":"facts_read","job":job,"offset":"0","maximum":131072}).to_string();
    let (_, plan, _) = read_plan(&owner.state.borrow(), &raw).unwrap();
    assert!(plan.bytes > 0);
    assert!(plan.eof);
    assert_eq!(plan.bytes, plan.total_bytes);
    let mut output = Vec::new();
    assert_eq!(
        read_into(&owner.state.borrow(), &raw, plan.bytes - 1, &mut output),
        Err("draft_invalid_chunk")
    );
    assert!(output.is_empty());
    let actual = read_into(&owner.state.borrow(), &raw, plan.bytes, &mut output).unwrap();
    assert_eq!(value(&actual)["bytes"], output.len());
    assert!(serde_json::from_slice::<Value>(&output).is_ok());
    control(&owner, json!({"op":"acknowledge","job":job}));
    assert!(read_plan(&owner.state.borrow(), &raw).is_err());
    let mut late = Vec::new();
    assert!(read_into(&owner.state.borrow(), &raw, plan.bytes, &mut late).is_err());
    assert!(late.is_empty());
}
#[test]
fn every_selected_draft_step_is_one_actual_phase_and_exact_retry_replays() {
    let owner = owner();
    let job = reserve(&owner, "buffer", "1", "# Heading");
    attach(&owner, &job, "# Heading");
    let turn = next(&owner);
    let selected = turn["work"]["selected"].to_string();
    let first = step_draft(&mut owner.state.borrow_mut(), &selected).unwrap();
    let before = owner.state.borrow().drafts.as_ref().unwrap().snapshot();
    let replay = step_draft(&mut owner.state.borrow_mut(), &selected).unwrap();
    assert_eq!(first, replay);
    assert_eq!(
        owner.state.borrow().drafts.as_ref().unwrap().snapshot(),
        before
    );
    let after = next(&owner);
    assert_ne!(after["work"]["selected"], turn["work"]["selected"]);
}
#[test]
fn committed_steps_use_selected_composite_ticket_and_exact_receipt_before_any_retry_io() {
    let owner = owner();
    reserve(&owner, "buffer", "1", "waiting for upload");
    owner
        .command_json(r#"{"kind":"wake","monotonicMs":"0"}"#)
        .unwrap();
    let turn = next(&owner);
    assert_eq!(turn["work"]["selected"]["lane"], "committed");
    let raw = turn["work"]["selected"].to_string();
    let mut issued = owner.issue_work(&raw).unwrap();
    assert!(issued.replay(&owner.state.borrow()).unwrap().is_none());
    let completion = r#"{"kind":"observed","observation":{"source":{"localStoreId":"store","watermark":"1"},"published":null,"current":false,"rebuildRequired":false,"coverageComplete":null}}"#;
    let actual = issued.complete(completion).unwrap();
    let before = owner.state.borrow().core.update();
    let mut retry = owner.issue_work(&raw).unwrap();
    assert_eq!(
        retry.replay(&owner.state.borrow()).unwrap(),
        Some(actual.clone())
    );
    assert_eq!(
        retry
            .complete("ignored only for the exact retained replay")
            .unwrap(),
        actual
    );
    assert_eq!(owner.state.borrow().core.update(), before);
    let mut forged = value(&raw);
    forged["id"] = json!("999");
    assert!(owner.issue_work(&forged.to_string()).is_err());
}
#[test]
fn portable_aggregate_source_admission_is_not_reimplemented_by_binding() {
    let owner = owner();
    let request_for = |buffer: &str| {
        request(&json!({"op":"request","buffer_lifetime":buffer,"text_revision":"1","source":{"bytes":d::MAX_DRAFT_SOURCE_BYTES,"utf16":d::MAX_DRAFT_SOURCE_BYTES,"sha256":"00".repeat(32)}}).to_string()).unwrap()
    };
    command(&mut owner.state.borrow_mut(), request_for("a")).unwrap();
    command(&mut owner.state.borrow_mut(), request_for("b")).unwrap();
    let before = owner.state.borrow().drafts.as_ref().unwrap().snapshot();
    assert_eq!(
        command(&mut owner.state.borrow_mut(), request_for("c")),
        Err("draft_capacity")
    );
    assert_eq!(
        owner.state.borrow().drafts.as_ref().unwrap().snapshot(),
        before
    );
    assert_eq!(before.runtime.usage.source_bytes, d::MAX_DRAFT_INPUT_BYTES);
}
#[test]
fn release_retains_actual_jobs_until_future_selected_drop_turns_prove_close_ready() {
    let owner = owner();
    let job = reserve(&owner, "buffer", "1", "retained source");
    attach(&owner, &job, "retained source");
    let _ = next(&owner);
    let closing = value(&begin_close(&mut owner.state.borrow_mut(), true).unwrap());
    assert_eq!(closing["client_has_jobs"], true);
    assert_eq!(closing["work"]["close_ready"], false);
    let mut ready = false;
    for _ in 0..16 {
        let turn = next(&owner);
        if turn["work"]["close_ready"] == true {
            ready = true;
            break;
        }
        let selected = turn["work"]["selected"].to_string();
        step_draft(&mut owner.state.borrow_mut(), &selected).unwrap();
    }
    assert!(ready);
    let closed = value(&begin_close(&mut owner.state.borrow_mut(), true).unwrap());
    assert_eq!(closed["client_has_jobs"], false);
    assert_eq!(closed["work"]["close_ready"], true);
    let request = request(
        &json!({"op":"request","buffer_lifetime":"new","text_revision":"1","source":source("new")})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        command(&mut owner.state.borrow_mut(), request),
        Err("draft_closed")
    );
}
