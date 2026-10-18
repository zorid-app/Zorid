#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Real native/SQLite fixture; run only in the coordinator's Rust validation turn.
use serde_json::{json, Value};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_native::*;
fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn create(v: &mut NativeVault, name: &str, path: &str, content: &str) {
    v.family_apply(
        &MutationRequest {
            operation_id: OperationId::new(format!("create-{name}")).unwrap(),
            mutation: Mutation::Create {
                id: id(name),
                path: VaultPath::new(path).unwrap(),
                kind: EntryKind::File,
                content: Some(content.as_bytes().to_vec()),
            },
        },
        Some(FamilyCreateMode::Text),
    )
    .unwrap();
}
fn setup() -> (
    tempfile::TempDir,
    NativeVault,
    ClientLease,
    WorkBlockSession,
) {
    let dir = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    v.family_enroll(&FamilyScope {
        realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
        vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
    })
    .unwrap();
    create(
        &mut v,
        "type-file",
        "Task.yaml",
        include_str!("../../../tests/fixtures/tasks/task-type.json"),
    );
    create(
        &mut v,
        "task",
        "Task.md",
        "---\ntype: type-task\n---\n# A task\n",
    );
    let l = v
        .claim_client(&OperationId::new("10000000-0000-4000-8000-000000000001").unwrap())
        .unwrap();
    let s = v.open_workblocks(&l).unwrap();
    (dir, v, l, s)
}
fn pin(v: &mut NativeVault) -> DocumentQueryPin {
    v.initialize_document_index().unwrap();
    let stage = v.begin_document_index().unwrap();
    for _ in 0..1000 {
        if v.pump_document_index(&stage).unwrap().ready {
            v.publish_document_index(&stage).unwrap();
            return v.open_document_snapshot().unwrap();
        }
    }
    panic!("fixture exceeded bounded pump");
}
fn request() -> Value {
    json!({"kind":"tasks","scope":{"kind":"tasks","typeIds":["type-file"]},"context":{"clockMs":0,"timezone":"America/Toronto"},"withoutBlocks":false,"showDone":true,"limit":64,"byteLimit":1048576})
}
fn query(
    v: &mut NativeVault,
    l: &ClientLease,
    s: &mut WorkBlockSession,
    p: &DocumentQueryPin,
    j: &mut CalendarJoinState,
    q: Value,
) -> NativeDocumentResult<DocumentQueryResult<CalendarReadValue>> {
    v.query_calendar_documents(l, s, p, j, serde_json::from_value(q).unwrap())
}
fn finish(
    v: &mut NativeVault,
    l: &ClientLease,
    s: &mut WorkBlockSession,
    p: &DocumentQueryPin,
    j: &mut CalendarJoinState,
    mut q: Value,
) -> Value {
    for _ in 0..130 {
        let value = serde_json::to_value(query(v, l, s, p, j, q.clone()).unwrap()).unwrap();
        if value["value"]["phase"] == "results" {
            return value;
        }
        assert!(value["value"]["tasks"].as_array().unwrap().is_empty());
        q["cursor"] = value["value"]["cursor"].clone();
    }
    panic!("join did not settle");
}
fn error<T>(r: NativeDocumentResult<T>, code: &str) {
    match r {
        Err(e) => assert_eq!(e.code(), code, "{e}"),
        Ok(_) => panic!("expected {code}"),
    }
}
fn command(v: &mut NativeVault, l: &ClientLease, s: &mut WorkBlockSession, q: Value) -> Value {
    serde_json::to_value(
        v.execute_workblocks(l, s, serde_json::from_value(q).unwrap())
            .unwrap(),
    )
    .unwrap()
}
fn block(
    v: &mut NativeVault,
    l: &ClientLease,
    s: &mut WorkBlockSession,
    name: &str,
    task: Option<&str>,
) -> Value {
    let created = command(
        v,
        l,
        s,
        json!({"op":"create","record":name,"generation":format!("g-{name}"),"operation":format!("g-{name}"),"range":{"start_ms":"-3600000","end_ms":"-1","timezone":"UTC"},"title":"Past"}),
    );
    if let Some(task) = task {
        command(
            v,
            l,
            s,
            json!({"op":"add_ref","record":name,"generation":format!("g-{name}"),"operation":format!("add-{name}"),"expectedRevision":created["revision"],"task":task}),
        )
    } else {
        created
    }
}
fn receipt(v: &mut NativeVault, incompatible: bool) {
    use zorid_records::first_party as domain;
    use zorid_records::{Id, Operation, Scope};
    use zorid_sync_protocol::{DeviceId, ExpectedContext, Header, RealmId, UpdateId, VaultId};
    let rid = |s: &str| Id::new(s).unwrap();
    let scope = Scope {
        realm: rid("realm"),
        vault: rid("vault"),
        owner: rid(domain::OWNER),
        collection: rid(domain::COLLECTION),
        record: rid("receipt-only"),
        generation: rid("receipt-create"),
        restores: None,
    };
    let op = Operation {
        id: rid(if incompatible {
            "receipt-create"
        } else {
            "receipt-child"
        }),
        scope: scope.clone(),
        parents: if incompatible {
            vec![]
        } else {
            vec![rid("receipt-create")]
        },
        schema_version: if incompatible { 2 } else { 1 },
        command: if incompatible {
            domain::create(&domain::Range::new(0, 1000, "UTC").unwrap(), None).unwrap()
        } else {
            domain::add_task(&id("task"))
        },
    };
    let intent = json!({"format":1,"scope":scope,"operations":[op]});
    let update = if incompatible {
        "future-receipt"
    } else {
        "waiting-receipt"
    };
    let payload = zorid_records::wire::Payload::from_intent(
        rid(update),
        &serde_json::to_vec(&intent).unwrap(),
    )
    .unwrap();
    let expected = ExpectedContext {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        update_id: UpdateId::new(update).unwrap(),
        key_epoch: 1,
    };
    let key = zorid_crypto::VaultKey::from_bytes([17; 32]);
    let header = Header::new(
        expected.realm_id.clone(),
        expected.vault_id.clone(),
        expected.update_id.clone(),
        DeviceId::new("origin").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        &payload.encode().unwrap(),
        &key,
        &mut zorid_crypto::SystemEntropy,
    )
    .unwrap()
    .encode();
    v.family_receive(
        &zorid_crypto::OpenedEnvelope::open(&wire, &expected, &key).unwrap(),
        None,
    )
    .unwrap();
}
#[test]
fn receipt_only_waiting_or_incompatible_never_proves_absence() {
    for incompatible in [false, true] {
        let (dir, mut v, l, mut s) = setup();
        receipt(&mut v, incompatible);
        let db = rusqlite::Connection::open(dir.path().join(".zorid/vault.sqlite")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM managed_records", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM managed_receipts WHERE status!='accepted'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let p = pin(&mut v);
        let mut j = CalendarJoinState::default();
        let r = finish(&mut v, &l, &mut s, &p, &mut j, request());
        assert_eq!(r["value"]["tasks"][0]["membership"]["state"], "unknown");
        assert_eq!(r["value"]["evidence"]["membershipComplete"], false);
        assert_eq!(r["value"]["evidence"]["workBlockScanComplete"], true);
        let window = json!({"kind":"window","scope":{"kind":"tasks","typeIds":["type-file"]},"context":{"clockMs":0,"timezone":"UTC"},"fromMs":"0","untilMs":"1000","limit":64,"byteLimit":1048576});
        let r = finish(&mut v, &l, &mut s, &p, &mut j, window);
        assert_eq!(r["value"]["evidence"]["membershipComplete"], false);
        assert_eq!(r["value"]["evidence"]["workBlockScanComplete"], true);
        assert!(r["value"]["blocks"].as_array().unwrap().is_empty());
    }
}
#[test]
fn all_time_live_refs_prove_presence_deleted_refs_do_not_count() {
    let (_dir, mut v, l, mut s) = setup();
    block(&mut v, &l, &mut s, "past", Some("task"));
    let p = pin(&mut v);
    let mut j = CalendarJoinState::default();
    let r = finish(&mut v, &l, &mut s, &p, &mut j, request());
    assert_eq!(r["value"]["tasks"][0]["membership"]["state"], "present");
    let current = command(
        &mut v,
        &l,
        &mut s,
        json!({"op":"read","record":"past","generation":"g-past"}),
    );
    command(
        &mut v,
        &l,
        &mut s,
        json!({"op":"delete","record":"past","generation":"g-past","operation":"delete-past","expectedRevision":current["revision"]}),
    );
    let r = finish(&mut v, &l, &mut s, &p, &mut j, request());
    assert_eq!(r["value"]["tasks"][0]["membership"]["state"], "absent");
    assert!(!j.has_active());
}
#[test]
fn exact_saved_base_selection_precedes_native_task_cap() {
    let (dir, v, l, s) = setup();
    // Preserve the >1000 real-file counterexample without running whole-vault
    // native projection recovery after each individual fixture command.
    drop(s);
    drop(l);
    drop(v);
    let mut store =
        zorid_store::Store::open_existing_no_follow(dir.path().join(".zorid/vault.sqlite"))
            .unwrap();
    let body = "---\ntype: type-task\n---\n";
    for n in 0..1001 {
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new(format!("create-unrelated-{n}")).unwrap(),
                    mutation: Mutation::Create {
                        id: id(&format!("unrelated-{n}")),
                        path: VaultPath::new(format!("A{n:04}.md")).unwrap(),
                        kind: EntryKind::File,
                        content: Some(body.as_bytes().to_vec()),
                    },
                },
                Some(FamilyCreateMode::Text),
            )
            .unwrap();
        if n % 250 == 0 {
            eprintln!("Calendar real fixture authored {}/1001", n + 1);
        }
    }
    let base = "views:\n  - type: calendar\n    name: Selected\n    filters: 'file.name == \"Task\"'\n    limit: 1\n";
    store
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("create-base").unwrap(),
                mutation: Mutation::Create {
                    id: id("base"),
                    path: VaultPath::new("Selected.base").unwrap(),
                    kind: EntryKind::File,
                    content: Some(base.as_bytes().to_vec()),
                },
            },
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    drop(store);
    let mut v = NativeVault::open_existing(dir.path()).unwrap();
    let recovered = v.recover().unwrap();
    assert!(recovered.blocked.is_empty(), "{:?}", recovered.blocked);
    assert_eq!(v.list().unwrap().len(), 1004);
    for n in 0..1001 {
        assert_eq!(
            std::fs::read(dir.path().join(format!("A{n:04}.md"))).unwrap(),
            body.as_bytes()
        );
    }
    assert_eq!(
        std::fs::read(dir.path().join("Selected.base")).unwrap(),
        base.as_bytes()
    );
    let l = v
        .claim_client(&OperationId::new("10000000-0000-4000-8000-000000000001").unwrap())
        .unwrap();
    let mut s = v.open_workblocks(&l).unwrap();
    let p = pin(&mut v);
    let mut j = CalendarJoinState::default();
    let mut q = request();
    q["scope"] = json!({"kind":"base","typeIds":["type-file"],"definitionId":"base","viewName":"Selected","currentEntryId":"task"});
    let r = finish(&mut v, &l, &mut s, &p, &mut j, q);
    assert_eq!(r["value"]["selection"]["selectedFiles"], 1);
    assert_eq!(r["value"]["tasks"][0]["row"]["witness"]["entryId"], "task");
    error(query(&mut v, &l, &mut s, &p, &mut j, request()), "budget");
}
#[test]
fn original_id_same_pin_labels_and_current_source_fence() {
    let (_dir, mut v, l, mut s) = setup();
    let p = pin(&mut v);
    let mut j = CalendarJoinState::default();
    let labels = json!({"kind":"links","typeIds":["type-file"],"entryIds":["task","missing"],"context":{"clockMs":0,"timezone":"UTC"}});
    let r = serde_json::to_value(query(&mut v, &l, &mut s, &p, &mut j, labels.clone()).unwrap())
        .unwrap();
    assert_eq!(r["value"]["links"][0]["state"], "task");
    assert_eq!(r["value"]["links"][1]["state"], "missing");
    assert_eq!(r["value"]["links"][0]["entryId"], "task");
    let old = v.read(&id("task")).unwrap().unwrap().state;
    v.apply(&MutationRequest {
        operation_id: OperationId::new("rename-task").unwrap(),
        mutation: Mutation::Move {
            id: id("task"),
            expected: old.revision,
            path: VaultPath::new("Renamed.md").unwrap(),
        },
    })
    .unwrap();
    error(
        query(&mut v, &l, &mut s, &p, &mut j, labels),
        "stale_source",
    );
    assert!(!j.has_active());
}
#[test]
fn continuation_collection_change_replacement_and_explicit_close_expire() {
    let (_dir, mut v, l, mut s) = setup();
    let p = pin(&mut v);
    let mut j = CalendarJoinState::default();
    let first =
        serde_json::to_value(query(&mut v, &l, &mut s, &p, &mut j, request()).unwrap()).unwrap();
    assert_eq!(first["value"]["phase"], "scan");
    assert!(j.has_active());
    let mut next = request();
    next["cursor"] = first["value"]["cursor"].clone();
    block(&mut v, &l, &mut s, "change", None);
    error(
        query(&mut v, &l, &mut s, &p, &mut j, next),
        "window_changed",
    );
    assert!(!j.has_active());
    let first =
        serde_json::to_value(query(&mut v, &l, &mut s, &p, &mut j, request()).unwrap()).unwrap();
    let mut old = request();
    old["cursor"] = first["value"]["cursor"].clone();
    query(&mut v,&l,&mut s,&p,&mut j,json!({"kind":"links","typeIds":["type-file"],"entryIds":[],"context":{"clockMs":0,"timezone":"UTC"}})).unwrap();
    error(query(&mut v, &l, &mut s, &p, &mut j, old), "cursor_expired");
    let first =
        serde_json::to_value(query(&mut v, &l, &mut s, &p, &mut j, request()).unwrap()).unwrap();
    let mut next = request();
    next["cursor"] = first["value"]["cursor"].clone();
    j.clear();
    v.close_document_snapshot(p);
    let p = v.open_document_snapshot().unwrap();
    error(
        query(&mut v, &l, &mut s, &p, &mut j, next),
        "cursor_expired",
    );
}
#[test]
fn bounds_and_replaced_lease_are_explicit_failures() {
    let (_dir, mut v, l, mut s) = setup();
    let p = pin(&mut v);
    let mut j = CalendarJoinState::default();
    let mut q = request();
    q["limit"] = json!(65);
    error(query(&mut v, &l, &mut s, &p, &mut j, q), "invalid_budget");
    let mut q = json!({"kind":"window","scope":{"kind":"tasks","typeIds":["type-file"]},"context":{"clockMs":0,"timezone":"UTC"},"fromMs":"0","untilMs":"3628800000","limit":64,"byteLimit":1048576});
    error(
        query(&mut v, &l, &mut s, &p, &mut j, q.clone()),
        "invalid_workblock",
    );
    q["untilMs"] = json!("2678400000");
    q["expectedWorkBlockWatermark"] = json!("999");
    error(query(&mut v, &l, &mut s, &p, &mut j, q), "window_changed");
    let q = json!({"kind":"links","typeIds":[],"entryIds":[],"context":{"clockMs":0,"timezone":"Not/A_Zone"}});
    error(query(&mut v, &l, &mut s, &p, &mut j, q), "timezone");
    drop(l);
    let replacement = v
        .claim_client(&OperationId::new("10000000-0000-4000-8000-000000000001").unwrap())
        .unwrap();
    error(
        query(&mut v, &replacement, &mut s, &p, &mut j, request()),
        "stale_session",
    );
}
#[test]
fn eight_join_slot_ceiling_releases_on_clear_and_drop() {
    let (_dir, mut v, l, mut s) = setup();
    let p = pin(&mut v);
    let mut joins = (0..8)
        .map(|_| CalendarJoinState::default())
        .collect::<Vec<_>>();
    for j in &mut joins {
        query(&mut v, &l, &mut s, &p, j, request()).unwrap();
        assert!(j.has_active());
    }
    let mut ninth = CalendarJoinState::default();
    error(
        query(&mut v, &l, &mut s, &p, &mut ninth, request()),
        "limit",
    );
    joins[0].clear();
    query(&mut v, &l, &mut s, &p, &mut ninth, request()).unwrap();
    assert!(ninth.has_active());
    drop(ninth);
    let mut replacement = CalendarJoinState::default();
    query(&mut v, &l, &mut s, &p, &mut replacement, request()).unwrap();
}
#[test]
fn expanded_type_labels_fail_explicitly_before_delivering_oversize_results() {
    let (_dir, mut v, l, mut s) = setup();
    let mut definition: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/tasks/task-type.json")).unwrap();
    definition["properties"][0]["options"]=Value::Array((0..128).map(|n|json!({"id":if n==0 {"todo".into()}else{format!("option-{n}")},"label":"L".repeat(500),"category":"not_started"})).collect());
    let old = v.read(&id("type-file")).unwrap().unwrap().state;
    v.apply(&MutationRequest {
        operation_id: OperationId::new("large-type").unwrap(),
        mutation: Mutation::Write {
            id: id("type-file"),
            expected: old.revision,
            content: serde_json::to_vec(&definition).unwrap(),
        },
    })
    .unwrap();
    for n in 0..63 {
        create(
            &mut v,
            &format!("extra-{n}"),
            &format!("Extra{n}.md"),
            "---\ntype: type-task\n---\n",
        );
    }
    let p = pin(&mut v);
    let mut j = CalendarJoinState::default();
    let first =
        serde_json::to_value(query(&mut v, &l, &mut s, &p, &mut j, request()).unwrap()).unwrap();
    let mut next = request();
    next["cursor"] = first["value"]["cursor"].clone();
    error(query(&mut v, &l, &mut s, &p, &mut j, next), "budget");
    assert!(!j.has_active());
}
#[test]
fn split_month_windows_share_fence_and_preserve_original_link_labels() {
    let (_dir, mut v, l, mut s) = setup();
    let created = command(
        &mut v,
        &l,
        &mut s,
        json!({"op":"create","record":"span","generation":"g-span","operation":"g-span","range":{"start_ms":"2592000000","end_ms":"2851200000","timezone":"UTC"},"title":"Spans split"}),
    );
    let added = command(
        &mut v,
        &l,
        &mut s,
        json!({"op":"add_ref","record":"span","generation":"g-span","operation":"span-task","expectedRevision":created["revision"],"task":"task"}),
    );
    command(
        &mut v,
        &l,
        &mut s,
        json!({"op":"add_ref","record":"span","generation":"g-span","operation":"span-missing","expectedRevision":added["revision"],"task":"missing"}),
    );
    let p = pin(&mut v);
    let mut j = CalendarJoinState::default();
    let mut watermark: Option<Value> = None;
    let mut dedup = std::collections::BTreeSet::new();
    for (from, until) in [("0", "2678400000"), ("2678400000", "3628800000")] {
        let mut q = json!({"kind":"window","scope":{"kind":"tasks","typeIds":["type-file"]},"context":{"clockMs":0,"timezone":"UTC"},"fromMs":from,"untilMs":until,"limit":64,"byteLimit":1048576});
        if let Some(w) = &watermark {
            q["expectedWorkBlockWatermark"] = w.clone();
        }
        let mut found = false;
        for _ in 0..4 {
            let r = serde_json::to_value(query(&mut v, &l, &mut s, &p, &mut j, q.clone()).unwrap())
                .unwrap();
            let w = r["value"]["evidence"]["workBlockWatermark"].clone();
            if let Some(old) = &watermark {
                assert_eq!(old, &w);
            } else {
                watermark = Some(w);
            }
            for block in r["value"]["blocks"].as_array().unwrap() {
                found = true;
                dedup.insert((
                    block["value"]["record"].as_str().unwrap().to_owned(),
                    block["value"]["generation"].as_str().unwrap().to_owned(),
                ));
                assert!(block["links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|l| l["entryId"] == "task" && l["state"] == "task"));
                assert!(block["links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|l| l["entryId"] == "missing" && l["state"] == "missing"));
            }
            if r["value"]["cursor"].is_null() {
                break;
            }
            q["cursor"] = r["value"]["cursor"].clone();
        }
        assert!(found);
    }
    assert_eq!(dedup.len(), 1);
}
