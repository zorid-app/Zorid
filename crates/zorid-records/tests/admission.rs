use std::collections::BTreeMap;
use zorid_records::{admission::*, wire::Payload, *};
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn registration() -> Registration {
    Registration {
        realm: id("r"),
        vault: id("v"),
        owner: id("o"),
        schema: Schema {
            collection: id("c"),
            version: 1,
            policy: Policy::Synced,
            fields: BTreeMap::new(),
        },
    }
}
fn scope() -> Scope {
    Scope {
        realm: id("r"),
        vault: id("v"),
        owner: id("o"),
        collection: id("c"),
        record: id("record"),
        generation: id("create"),
        restores: None,
    }
}
fn empty() -> State {
    State::new(registration().schema, scope()).unwrap()
}
fn payload(op: Operation) -> Payload {
    #[derive(serde::Serialize)]
    struct Intent {
        format: u32,
        scope: Scope,
        operations: Vec<Operation>,
    }
    Payload::from_intent(
        id("update"),
        &serde_json::to_vec(&Intent {
            format: 1,
            scope: scope(),
            operations: vec![op],
        })
        .unwrap(),
    )
    .unwrap()
}
fn operation(name: &str, parents: Vec<Id>, command: Command) -> Operation {
    Operation {
        id: id(name),
        parents,
        scope: scope(),
        schema_version: 1,
        command,
    }
}
#[test]
fn received_gate_precedence_and_terminal_retry_set() {
    let p = payload(operation("create", vec![], Command::Create(vec![])));
    let mut r = registration();
    assert_eq!(
        received_gate(&p, None, true),
        Some(Status::IntegrityConflict)
    );
    assert_eq!(
        received_gate(&p, None, false),
        Some(Status::MissingRegistration)
    );
    r.schema.policy = Policy::Local;
    r.schema.version = 2;
    assert_eq!(
        received_gate(&p, Some(&r), false),
        Some(Status::PolicyMismatch)
    );
    r.schema.policy = Policy::Synced;
    assert_eq!(
        received_gate(&p, Some(&r), false),
        Some(Status::IncompatibleSchema)
    );
    for status in [
        Status::Accepted,
        Status::IntegrityConflict,
        Status::InvalidOperation,
    ] {
        assert!(!status.retry_eligible());
    }
    for status in [
        Status::MissingRegistration,
        Status::PolicyMismatch,
        Status::Capacity,
        Status::WaitingDependencies,
        Status::WaitingRestoreSource,
        Status::IncompatibleSchema,
    ] {
        assert!(status.retry_eligible());
    }
}
#[test]
fn restore_precedes_union_and_pending_is_never_published() {
    let p = payload(operation(
        "child",
        vec![id("missing")],
        Command::Patch(vec![]),
    ));
    assert!(matches!(
        admit_received(empty(), &p, false).unwrap(),
        Admission::Retained(Status::WaitingRestoreSource)
    ));
    assert!(matches!(
        admit_received(empty(), &p, true).unwrap(),
        Admission::Retained(Status::WaitingDependencies)
    ));
    let create = payload(operation("create", vec![], Command::Create(vec![])));
    let Admission::Accepted(accepted) = admit_received(empty(), &create, true).unwrap() else {
        panic!()
    };
    assert!(accepted.state.projection().unwrap().pending.is_empty());
    assert_eq!(accepted.state_bytes, accepted.state.snapshot().unwrap());
}
#[test]
fn quota_replacement_boundary_and_overflow_are_exact() {
    assert!(state_fits(
        StateUsage {
            count: 1024,
            used_bytes: MAX_STATE_BYTES,
            replaced_bytes: 2
        },
        1,
        1
    ));
    assert!(!state_fits(
        StateUsage {
            count: 1024,
            used_bytes: 2,
            replaced_bytes: 0
        },
        1,
        1
    ));
    assert!(!state_fits(
        StateUsage {
            count: 1,
            used_bytes: MAX_STATE_BYTES,
            replaced_bytes: 1
        },
        1,
        1
    ));
    assert!(!state_fits(
        StateUsage {
            count: 1,
            used_bytes: 0,
            replaced_bytes: 1
        },
        1,
        1
    ));
    assert!(!state_fits(
        StateUsage {
            count: 1,
            used_bytes: u64::MAX,
            replaced_bytes: 0
        },
        1,
        1
    ));
}
#[test]
fn local_tuple_and_projection_preserve_original_direct_numeric_serialization() {
    let mut r = registration();
    for (name, kind) in [
        ("n", Kind::Number),
        ("min", Kind::Integer),
        ("max", Kind::Integer),
        ("obj", Kind::Object),
    ] {
        r.schema.fields.insert(
            id(name),
            Field {
                kind,
                required: false,
                nullable: false,
                default: None,
            },
        );
    }
    let state = State::new(r.schema, scope()).unwrap();
    let float = 51.248178375505404_f64;
    let values = [
        ("n", Value::Number(float)),
        ("min", Value::Integer(i64::MIN)),
        ("max", Value::Integer(i64::MAX)),
        (
            "obj",
            Value::Object(BTreeMap::from([("n".into(), serde_json::json!(float))])),
        ),
    ];
    let command = Command::Create(
        values
            .iter()
            .map(|(field, value)| Action::Write {
                field: id(field),
                cell: Cell::Value(value.clone()),
            })
            .collect(),
    );
    let prepared = state.prepare(id("create"), command.clone()).unwrap();
    let p = prepared.next().projection().unwrap();
    // Original native projection implementation, with no added JSON parse.
    let fields: BTreeMap<_, _> = p
        .fields
        .iter()
        .map(|(id, c)| {
            (
                id.as_str(),
                c.iter()
                    .map(|c| serde_json::json!({"operation":c.operation,"cell":c.cell}))
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    let original =
        serde_json::json!({"created":p.created,"deleted":p.deleted,"fields":fields,"sets":p.sets});
    assert_eq!(projection_value(prepared.next()).unwrap(), original);
    assert_eq!(
        projection_bytes(prepared.next()).unwrap(),
        serde_json::to_vec(&original).unwrap()
    );
    let digest = [123u8; 32];
    assert_eq!(
        local_request(&scope(), &digest, &command).unwrap(),
        serde_json::to_vec(&(scope(), digest, &command)).unwrap()
    );
    assert!(
        String::from_utf8(projection_bytes(prepared.next()).unwrap())
            .unwrap()
            .contains("9223372036854775807")
    );
}
#[test]
fn restore_source_identity_pending_and_missing_remain_distinct() {
    let mut restored = scope();
    restored.generation = id("new");
    restored.restores = Some(id("create"));
    assert_eq!(restore_ready(&restored, None), Ok(false));
    let mut wrong = empty();
    assert_eq!(restore_ready(&restored, Some(&wrong)), Ok(false));
    restored.record = id("other");
    assert_eq!(restore_ready(&restored, Some(&wrong)), Err(Error::Scope));
    restored.record = id("record");
    wrong
        .union(&[operation(
            "child",
            vec![id("missing")],
            Command::Patch(vec![]),
        )])
        .unwrap();
    assert_eq!(
        restore_ready(&restored, Some(&wrong)),
        Err(Error::MissingDependency)
    );
}
#[test]
fn authored_numeric_counterexamples_restore_and_wrap_exactly() {
    let mut r = registration();
    r.schema.fields.insert(
        id("n"),
        Field {
            kind: Kind::Number,
            required: false,
            nullable: false,
            default: None,
        },
    );
    r.schema.fields.insert(
        id("obj"),
        Field {
            kind: Kind::Object,
            required: false,
            nullable: false,
            default: None,
        },
    );
    for n in [51.248178375505404_f64, 0.1_f64, 0.84551240822557006_f64] {
        let empty = State::new(r.schema.clone(), scope()).unwrap();
        let prepared = empty
            .prepare(
                id("create"),
                Command::Create(vec![
                    Action::Write {
                        field: id("n"),
                        cell: Cell::Value(Value::Number(n)),
                    },
                    Action::Write {
                        field: id("obj"),
                        cell: Cell::Value(Value::Object(BTreeMap::from([(
                            "n".into(),
                            serde_json::json!(n),
                        )]))),
                    },
                ]),
            )
            .unwrap();
        let bytes = prepared.next().snapshot().unwrap();
        let restored = State::restore(r.schema.clone(), &bytes)
            .expect("authored canonical state must restore");
        assert_eq!(restored.snapshot().unwrap(), bytes);
        let p = Payload::from_intent(id("update"), prepared.payload())
            .expect("authored intent must wrap");
        assert_eq!(Payload::decode(&p.encode().unwrap()).unwrap(), p);
    }
}
