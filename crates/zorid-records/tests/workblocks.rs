use zorid_core::EntryId;
use zorid_records::{
    admission::{self, Admission, Status},
    first_party as wb, *,
};
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn state() -> State {
    State::new(
        wb::schema(),
        Scope {
            realm: id("realm"),
            vault: id("vault"),
            owner: id(wb::OWNER),
            collection: id(wb::COLLECTION),
            record: id("record"),
            generation: id("root"),
            restores: None,
        },
    )
    .unwrap()
}
fn range(a: i64, b: i64) -> wb::Range {
    wb::Range::new(a, b, "America/Toronto").unwrap()
}
fn apply(s: &mut State, op: &str, command: Command) {
    let p = s.prepare(id(op), command).unwrap();
    s.install(p).unwrap();
}
fn created() -> State {
    let mut s = state();
    apply(
        &mut s,
        "root",
        wb::create(&range(0, 3600000), None).unwrap(),
    );
    s
}
fn op(s: &State, name: &str, parents: &[&str], command: Command) -> Operation {
    Operation {
        id: id(name),
        parents: parents.iter().map(|s| id(s)).collect(),
        scope: s.scope().clone(),
        schema_version: 1,
        command,
    }
}
fn intent(s: &State, operations: &[Operation]) -> Vec<u8> {
    // Match the private local envelope field order, including canonical typed operations.
    format!(
        "{{\"format\":1,\"scope\":{},\"operations\":{}}}",
        serde_json::to_string(s.scope()).unwrap(),
        serde_json::to_string(operations).unwrap()
    )
    .into_bytes()
}
fn payload(s: &State, name: &str, operations: &[Operation]) -> wire::Payload {
    let p = wire::Payload::from_intent(id(name), &intent(s, operations)).unwrap();
    wire::Payload::decode(&p.encode().unwrap()).unwrap()
}
fn bad_range() -> Cell {
    let Cell::Value(Value::Object(mut map)) = range(0, 1000).cell().unwrap() else {
        unreachable!()
    };
    map.insert("start_ms".into(), serde_json::json!("00"));
    Cell::Value(Value::Object(map))
}
#[test]
fn compiled_registration_cannot_be_downgraded() {
    let s = state();
    for mutate in 0..5 {
        let mut schema = wb::schema();
        match mutate {
            0 => schema.policy = Policy::Local,
            1 => schema.version = 2,
            2 => schema.fields.clear(),
            3 => schema.fields.get_mut(&id("range")).unwrap().required = false,
            _ => schema.fields.get_mut(&id("title")).unwrap().nullable = true,
        }
        assert_eq!(
            State::new(schema.clone(), s.scope().clone()).unwrap_err(),
            Error::InvalidSchema
        );
        let old = wb::registration(id("realm"), id("vault")).unwrap();
        let mut next = old.clone();
        next.schema = schema;
        assert_eq!(
            admission::registration_change(&old, &next),
            Err(Error::InvalidSchema)
        );
    }
    let r = wb::registration(id("realm"), id("vault")).unwrap();
    admission::check_scope(&r, s.scope()).unwrap();
}
#[test]
fn invalid_local_received_pending_and_restore_are_equivalent() {
    let s = created();
    for cell in [bad_range(), Cell::Null, Cell::Unset] {
        let command = Command::Patch(vec![Action::Write {
            field: id("range"),
            cell,
        }]);
        assert_eq!(
            s.prepare(id("bad"), command.clone()).unwrap_err(),
            Error::InvalidValue
        );
        for parents in [vec!["root"], vec!["absent"]] {
            let bad = op(&s, "bad", &parents, command.clone());
            let before = s.snapshot().unwrap();
            let mut receiver = s.clone();
            assert_eq!(receiver.union(&[bad.clone()]), Err(Error::InvalidValue));
            assert_eq!(receiver.snapshot().unwrap(), before);
            let payload = payload(&s, "update", &[bad.clone()]);
            assert!(matches!(
                admission::admit_received(s.clone(), &payload, true).unwrap(),
                Admission::Retained(Status::InvalidOperation)
            ));
            let history = vec![s.history()[&id("root")].clone(), bad];
            assert_eq!(
                State::restore(wb::schema(), &intent(&s, &history)).unwrap_err(),
                Error::InvalidValue
            );
        }
    }
    assert!(state()
        .prepare(id("root"), Command::Create(vec![]))
        .is_err());
}
#[test]
fn range_keys_instants_and_utf8_title_bounds() {
    for start in [
        "+1",
        "01",
        "-0",
        "1.0",
        "9223372036854775808",
        "9223372036854775807",
    ] {
        let r = wb::Range {
            start_ms: start.into(),
            end_ms: "2000".into(),
            timezone: "UTC".into(),
        };
        assert!(r.validate().is_err());
    }
    assert!(wb::Range::new(0, 1, "not/a_zone").is_err());
    assert!(wb::Range::new(1, 1, "UTC").is_err());
    assert!(wb::Range::new(-2208988800000, 7258118400000, "UTC").is_ok());
    let mut cell = range(0, 1).cell().unwrap();
    if let Cell::Value(Value::Object(m)) = &mut cell {
        m.insert("extra".into(), serde_json::json!(true));
    }
    assert!(wb::Range::from_cell(&cell).is_err());
    assert!(wb::set_title(Some("é".repeat(256))).is_ok());
    assert!(wb::set_title(Some("é".repeat(257))).is_err());
    let bad = Command::Patch(vec![Action::Write {
        field: id("title"),
        cell: Cell::Value(Value::String("é".repeat(257))),
    }]);
    assert_eq!(
        created().prepare(id("badtitle"), bad).unwrap_err(),
        Error::InvalidValue
    );
}
#[test]
fn explicit_dst_offset_choice_and_nonexistent_rejection() {
    use wb::{resolve_wall_time as resolve, WallTimeError as E};
    let local = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
    assert_eq!(
        resolve(local("2026-03-08 02:30:00"), "America/Toronto", None),
        Err(E::Nonexistent)
    );
    let fall = local("2026-11-01 01:30:00");
    assert_eq!(resolve(fall, "America/Toronto", None), Err(E::Ambiguous));
    let a = resolve(fall, "America/Toronto", Some(-14400)).unwrap();
    let b = resolve(fall, "America/Toronto", Some(-18000)).unwrap();
    assert_eq!(b - a, 3600000);
    assert_eq!(
        resolve(fall, "America/Toronto", Some(0)),
        Err(E::InvalidOffset)
    );
    assert_eq!(
        resolve(local("2026-01-01 12:00:00"), "UTC", Some(3600)),
        Err(E::InvalidOffset)
    );
}
#[test]
fn atomic_ranges_conflicts_history_and_resolution() {
    let base = created();
    let a = base
        .prepare(id("a"), wb::set_range(&range(10000, 20000)).unwrap())
        .unwrap();
    let b = base
        .prepare(id("b"), wb::set_range(&range(30000, 40000)).unwrap())
        .unwrap();
    let mut x = base.clone();
    x.receive(a.payload()).unwrap();
    x.receive(b.payload()).unwrap();
    let mut y = base;
    y.receive(b.payload()).unwrap();
    y.receive(a.payload()).unwrap();
    assert_eq!(x, y);
    let block = wb::read(&x).unwrap().unwrap();
    assert_eq!(block.ranges.len(), 2);
    assert!(block.ranges.iter().any(|c| c.range == range(10000, 20000)));
    assert!(block.ranges.iter().any(|c| c.range == range(30000, 40000)));
    apply(
        &mut x,
        "resolved",
        wb::set_range(&range(50000, 60000)).unwrap(),
    );
    assert_eq!(wb::read(&x).unwrap().unwrap().ranges.len(), 1);
    assert_eq!(x.history().len(), 4);
    assert_eq!(
        State::restore(wb::schema(), &x.snapshot().unwrap()).unwrap(),
        x
    );
    // A malformed overwritten candidate must not be excused by a valid descendant.
    let mut history: Vec<_> = x.history().values().cloned().collect();
    for item in &mut history {
        if item.id == id("a") {
            item.command = Command::Patch(vec![Action::Write {
                field: id("range"),
                cell: bad_range(),
            }]);
        }
    }
    assert_eq!(
        State::restore(wb::schema(), &intent(&x, &history)).unwrap_err(),
        Error::InvalidValue
    );
}
#[test]
fn refs_structural_validation_observed_removal_and_unknown_preservation() {
    let mut s = created();
    let task = EntryId::new("missing_note").unwrap();
    apply(&mut s, "add", wb::add_task(&task));
    assert!(wb::read(&s).unwrap().unwrap().task_refs.contains(&task));
    let command = wb::remove_task(&s, &task).unwrap();
    apply(&mut s, "remove", command);
    assert!(wb::read(&s).unwrap().unwrap().task_refs.is_empty());
    for command in [
        Command::Patch(vec![Action::Add {
            field: id("task_refs"),
            member: id("bad.ref"),
        }]),
        Command::Patch(vec![Action::Remove {
            field: id("task_refs"),
            member: id("bad.ref"),
            tags: vec![],
        }]),
    ] {
        assert_eq!(
            s.prepare(id("invalid"), command.clone()).unwrap_err(),
            Error::InvalidValue
        );
        let bad = op(&s, "invalid", &["remove"], command);
        let payload = payload(&s, "invalid_update", &[bad]);
        assert!(matches!(
            admission::admit_received(s.clone(), &payload, true).unwrap(),
            Admission::Retained(Status::InvalidOperation)
        ));
    }
    let unknown = op(
        &s,
        "future",
        &["remove"],
        Command::Patch(vec![Action::Write {
            field: id("future_field"),
            cell: Cell::Value(Value::String("preserved".into())),
        }]),
    );
    s.union(&[unknown]).unwrap();
    let restored = State::restore(wb::schema(), &s.snapshot().unwrap()).unwrap();
    assert_eq!(
        restored.projection().unwrap().fields[&id("future_field")][0].cell,
        Cell::Value(Value::String("preserved".into()))
    );
}
#[test]
fn concurrent_ref_capacity_retains_whole_operation_without_truncating() {
    let mut s = created();
    for n in 0..63 {
        apply(
            &mut s,
            &format!("add{n:02}"),
            wb::add_task(&EntryId::new(format!("task{n}")).unwrap()),
        );
    }
    let a = s
        .prepare(id("a"), wb::add_task(&EntryId::new("task_a").unwrap()))
        .unwrap();
    let b = s
        .prepare(id("b"), wb::add_task(&EntryId::new("task_b").unwrap()))
        .unwrap();
    let mut left = s.clone();
    left.receive(a.payload()).unwrap();
    let before = left.snapshot().unwrap();
    assert_eq!(left.receive(b.payload()), Err(Error::Limit));
    assert_eq!(left.snapshot().unwrap(), before);
    let payload = wire::Payload::from_intent(id("over_capacity"), b.payload()).unwrap();
    assert!(matches!(
        admission::admit_received(left.clone(), &payload, true).unwrap(),
        Admission::Retained(Status::Capacity)
    ));
    assert!(Status::Capacity.retry_eligible());
    let remove = wb::remove_task(&left, &EntryId::new("task0").unwrap()).unwrap();
    apply(&mut left, "remove", remove);
    left.receive(b.payload()).unwrap();
    assert_eq!(wb::read(&left).unwrap().unwrap().task_refs.len(), 64);
    // A single atomic union of both branches fails regardless of input order.
    for bytes in [[a.payload(), b.payload()], [b.payload(), a.payload()]] {
        let mut receiver = s.clone();
        let mut operations = Vec::new();
        for (i, bytes) in bytes.iter().enumerate() {
            operations.extend(
                wire::Payload::from_intent(id(&format!("u{i}")), bytes)
                    .unwrap()
                    .operations()
                    .to_vec(),
            );
        }
        assert_eq!(receiver.union(&operations), Err(Error::Limit));
        assert_eq!(receiver, s);
    }
}
#[test]
fn shared_query_uses_half_open_intersection_and_all_conflicts() {
    let s = created();
    let block = wb::read(&s).unwrap().unwrap();
    assert!(!wb::Window::new("3600000", "3600001")
        .unwrap()
        .intersects(&block)
        .unwrap());
    assert!(wb::Window::new("3599999", "3600001")
        .unwrap()
        .intersects(&block)
        .unwrap());
    assert!(wb::Window::new("0", "2678400001").is_err());
    let p = s
        .prepare(id("a"), wb::set_range(&range(5000000, 6000000)).unwrap())
        .unwrap();
    let q = s
        .prepare(id("z"), wb::set_range(&range(7000000, 8000000)).unwrap())
        .unwrap();
    let mut s = s;
    s.receive(p.payload()).unwrap();
    s.receive(q.payload()).unwrap();
    assert!(wb::Window::new("5000000", "5000001")
        .unwrap()
        .intersects(&wb::read(&s).unwrap().unwrap())
        .unwrap());
}

#[test]
fn future_schema_decodes_but_gate_retains_and_restore_rejects_even_delete() {
    let s = created();
    for command in [
        Command::Delete,
        wb::set_range(&range(100, 200)).unwrap(),
        Command::Patch(vec![Action::Write {
            field: id("range"),
            cell: bad_range(),
        }]),
    ] {
        let mut future = op(&s, "future", &["root"], command);
        future.schema_version = 2;
        let p = payload(&s, "future_update", &[future.clone()]);
        let registration = wb::registration(id("realm"), id("vault")).unwrap();
        assert_eq!(
            admission::received_gate(&p, Some(&registration), false),
            Some(Status::IncompatibleSchema)
        );
        let mut history = vec![s.history()[&id("root")].clone()];
        history.push(future.clone());
        assert_eq!(
            State::restore(wb::schema(), &intent(&s, &history)).unwrap_err(),
            Error::InvalidSchema
        );
        assert_eq!(s.clone().union(&[future]), Err(Error::InvalidSchema));
    }
    let valid = payload(&s, "valid_update", &[s.history()[&id("root")].clone()]);
    assert!(matches!(
        admission::admit_received(state(), &valid, true).unwrap(),
        Admission::Accepted(_)
    ));
}
#[test]
fn query_pages_keep_continuations_and_enforce_bounds() {
    let window = wb::Window::new("0", "1000").unwrap();
    let first = wb::query_page(&window, &[created()], Some("opaque-host-token")).unwrap();
    assert_eq!(first.blocks.len(), 1);
    assert!(first.incomplete);
    assert_eq!(first.continuation, Some("opaque-host-token"));
    let last = wb::query_page::<String>(&window, &[], None).unwrap();
    assert!(!last.incomplete);
    assert_eq!(
        wb::query_page::<String>(&window, &vec![created(); 201], None).unwrap_err(),
        Error::Limit
    );
}

#[test]
fn every_bad_range_candidate_is_invalid_on_all_admission_paths() {
    let s = created();
    let mut cells = Vec::new();
    for (key, value) in [
        ("start_ms", serde_json::json!("9223372036854775807")),
        ("start_ms", serde_json::json!(0)),
        ("end_ms", serde_json::json!("0")),
        ("timezone", serde_json::json!("Bad/Timezone")),
        ("extra", serde_json::json!(true)),
    ] {
        let Cell::Value(Value::Object(mut m)) = range(0, 1000).cell().unwrap() else {
            unreachable!()
        };
        m.insert(key.into(), value);
        cells.push(Cell::Value(Value::Object(m)));
    }
    let Cell::Value(Value::Object(mut missing)) = range(0, 1000).cell().unwrap() else {
        unreachable!()
    };
    missing.remove("timezone");
    cells.push(Cell::Value(Value::Object(missing)));
    for cell in cells {
        let command = Command::Patch(vec![Action::Write {
            field: id("range"),
            cell,
        }]);
        assert_eq!(
            s.prepare(id("bad"), command.clone()).unwrap_err(),
            Error::InvalidValue
        );
        let bad = op(&s, "bad", &["root"], command);
        let p = payload(&s, "bad_update", &[bad.clone()]);
        assert!(matches!(
            admission::admit_received(s.clone(), &p, true).unwrap(),
            Admission::Retained(Status::InvalidOperation)
        ));
        let history = vec![s.history()[&id("root")].clone(), bad];
        assert_eq!(
            State::restore(wb::schema(), &intent(&s, &history)).unwrap_err(),
            Error::InvalidValue
        );
    }
}

#[test]
fn query_page_byte_budget_is_explicit_not_silent_truncation() {
    let mut s = created();
    let unknown = op(
        &s,
        "large",
        &["root"],
        Command::Patch(vec![Action::Write {
            field: id("future_field"),
            cell: Cell::Value(Value::String("x".repeat(8000))),
        }]),
    );
    s.union(&[unknown]).unwrap();
    let window = wb::Window::new("0", "1000").unwrap();
    assert_eq!(
        wb::query_page::<String>(&window, &vec![s; 140], None).unwrap_err(),
        Error::Limit
    );
}
