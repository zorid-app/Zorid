//! Persisted native projection regression for the pure-admission extraction.
use std::collections::BTreeMap;
use zorid_records::{
    admission, Action, Cell, Command, Field, Id, Kind, Policy, Schema, Scope, State, Value,
};
use zorid_store::{FamilyScope, ManagedRegistration, ManagedTarget, Store};
use zorid_sync_protocol::{RealmId, VaultId};
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
#[test]
fn persisted_projection_matches_original_direct_f64_and_i64_values() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("store.sqlite");
    let mut store = Store::open(&path).unwrap();
    store
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("r").unwrap(),
            vault_id: VaultId::new("v").unwrap(),
        })
        .unwrap();
    let fields = [
        ("number", Kind::Number),
        ("minimum", Kind::Integer),
        ("maximum", Kind::Integer),
        ("object", Kind::Object),
    ]
    .into_iter()
    .map(|(name, kind)| {
        (
            id(name),
            Field {
                kind,
                required: false,
                nullable: false,
                default: None,
            },
        )
    })
    .collect();
    let schema = Schema {
        collection: id("c"),
        version: 1,
        policy: Policy::Local,
        fields,
    };
    let r = ManagedRegistration {
        realm: id("r"),
        vault: id("v"),
        owner: id("o"),
        schema: schema.clone(),
    };
    let h = store.managed_register(&r).unwrap();
    let target = ManagedTarget {
        record: id("record"),
        generation: id("create"),
        restores: None,
    };
    let initial = store.managed_snapshot(&h, &target).unwrap();
    let f = 51.248178375505404_f64;
    let command = Command::Create(
        [
            ("number", Value::Number(f)),
            ("minimum", Value::Integer(i64::MIN)),
            ("maximum", Value::Integer(i64::MAX)),
            (
                "object",
                Value::Object(BTreeMap::from([("float".into(), serde_json::json!(f))])),
            ),
        ]
        .into_iter()
        .map(|(field, value)| Action::Write {
            field: id(field),
            cell: Cell::Value(value),
        })
        .collect(),
    );
    let scope = Scope {
        realm: id("r"),
        vault: id("v"),
        owner: id("o"),
        collection: id("c"),
        record: id("record"),
        generation: id("create"),
        restores: None,
    };
    let expected = State::new(schema, scope)
        .unwrap()
        .prepare(id("create"), command.clone())
        .unwrap();
    store
        .managed_apply(&h, &target, id("create"), &initial.revision, command)
        .unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let stored: Vec<u8> = db
        .query_row("SELECT projection FROM managed_records", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        stored,
        admission::projection_bytes(expected.next()).unwrap()
    );
    // Check the direct primitive; parsing projection JSON here would hide drift.
    let raw = String::from_utf8(stored).unwrap();
    assert!(raw.contains(&serde_json::to_string(&f).unwrap()));
    assert!(raw.contains("-9223372036854775808"));
    assert!(raw.contains("9223372036854775807"));
    drop(db);
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    let handle = reopened.managed_register(&r).unwrap();
    let snapshot = reopened.managed_snapshot(&handle, &target).unwrap();
    assert_eq!(
        serde_json::to_vec(&snapshot.projection).unwrap(),
        raw.as_bytes()
    );
    assert_eq!(
        snapshot.state.as_bytes(),
        expected.next().snapshot().unwrap()
    );
}
