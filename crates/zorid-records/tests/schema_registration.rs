use std::collections::BTreeMap;
use zorid_records::{
    admission::{received_gate, registration_change, Registration, Status},
    wire::Payload,
    *,
};

fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn field(kind: Kind) -> Field {
    Field {
        kind,
        required: false,
        nullable: false,
        default: None,
    }
}
fn registration() -> Registration {
    Registration {
        realm: id("realm"),
        vault: id("vault"),
        owner: id("owner"),
        schema: Schema {
            collection: id("collection"),
            version: 1,
            policy: Policy::Synced,
            fields: BTreeMap::new(),
        },
    }
}
fn scope() -> Scope {
    let r = registration();
    Scope {
        realm: r.realm,
        vault: r.vault,
        owner: r.owner,
        collection: r.schema.collection,
        record: id("record"),
        generation: id("create"),
        restores: None,
    }
}
fn successor(old: &Registration) -> Registration {
    let mut next = old.clone();
    next.schema.version += 1;
    next
}
fn write(name: &str, cell: Cell) -> Action {
    Action::Write {
        field: id(name),
        cell,
    }
}
fn authored(schema: Schema, actions: Vec<Action>) -> State {
    State::new(schema, scope())
        .unwrap()
        .prepare(id("create"), Command::Create(actions))
        .unwrap()
        .next()
        .clone()
}

#[test]
fn exact_repeat_and_version_only_bump_are_distinct() {
    let mut old = registration();
    let mut title = field(Kind::String);
    title.required = true;
    old.schema.fields.insert(id("title"), title);
    assert_eq!(registration_change(&old, &old), Ok(false));
    assert_eq!(registration_change(&old, &successor(&old)), Ok(true));
}

#[test]
fn optional_supported_additions_accept_creation_defaults_null_and_unset() {
    let old = registration();
    let mut next = successor(&old);
    for (name, kind, default) in [
        (
            "flag",
            Kind::Boolean,
            Some(Cell::Value(Value::Boolean(true))),
        ),
        (
            "title",
            Kind::String,
            Some(Cell::Value(Value::String("normal".into()))),
        ),
        ("count", Kind::Integer, Some(Cell::Value(Value::Integer(1)))),
        ("ratio", Kind::Number, Some(Cell::Value(Value::Number(0.5)))),
        (
            "object",
            Kind::Object,
            Some(Cell::Value(Value::Object(BTreeMap::new()))),
        ),
        ("members", Kind::Set, None),
        ("null", Kind::String, Some(Cell::Null)),
        ("absent", Kind::String, Some(Cell::Unset)),
    ] {
        next.schema.fields.insert(
            id(name),
            Field {
                kind,
                required: false,
                nullable: name == "null",
                default,
            },
        );
    }
    assert_eq!(registration_change(&old, &next), Ok(true));
}

#[test]
fn required_additions_fail_without_any_records_or_preexisting_fields() {
    let old = registration();
    for (kind, default) in [
        (Kind::String, None),
        (Kind::Integer, Some(Cell::Value(Value::Integer(1)))),
        (Kind::Set, None),
    ] {
        let mut next = successor(&old);
        next.schema.fields.insert(
            id("new"),
            Field {
                kind,
                required: true,
                nullable: false,
                default,
            },
        );
        assert_eq!(
            next.schema.validate(),
            Ok(()),
            "valid declaration is still an incompatible addition"
        );
        assert_eq!(registration_change(&old, &next), Err(Error::InvalidSchema));
    }
}

#[test]
fn scoped_identity_cannot_change_even_for_an_empty_collection() {
    let old = registration();
    for component in ["realm", "vault", "owner", "collection"] {
        let mut next = successor(&old);
        match component {
            "realm" => next.realm = id("other"),
            "vault" => next.vault = id("other"),
            "owner" => next.owner = id("other"),
            _ => next.schema.collection = id("other"),
        }
        assert_eq!(
            registration_change(&old, &next),
            Err(Error::Scope),
            "{component}"
        );
    }
}

#[test]
fn policies_downgrades_and_same_version_divergence_are_rejected() {
    for policy in [Policy::Synced, Policy::Local, Policy::Cache] {
        let mut old = registration();
        old.schema.policy = policy.clone();
        old.schema.version = 2;
        for replacement in [Policy::Synced, Policy::Local, Policy::Cache] {
            if replacement == policy {
                continue;
            }
            let mut next = successor(&old);
            next.schema.policy = replacement;
            assert_eq!(registration_change(&old, &next), Err(Error::InvalidSchema));
        }
        let mut stale = old.clone();
        stale.schema.version = 1;
        assert_eq!(registration_change(&old, &stale), Err(Error::InvalidSchema));
        let mut fork = old.clone();
        fork.schema
            .fields
            .insert(id("optional"), field(Kind::String));
        assert_eq!(registration_change(&old, &fork), Err(Error::InvalidSchema));
    }
}

#[test]
fn existing_field_declarations_are_immutable_including_permissive_changes() {
    let mut old = registration();
    let mut title = field(Kind::String);
    title.default = Some(Cell::Value(Value::String("old".into())));
    old.schema.fields.insert(id("title"), title.clone());
    let mut changes = vec![None];
    let mut kind = title.clone();
    kind.kind = Kind::Object;
    kind.default = None;
    changes.push(Some(kind));
    let mut required = title.clone();
    required.required = true;
    changes.push(Some(required));
    let mut nullable = title.clone();
    nullable.nullable = true;
    changes.push(Some(nullable));
    let mut default = title.clone();
    default.default = Some(Cell::Value(Value::String("new".into())));
    changes.push(Some(default));
    let mut no_default = title.clone();
    no_default.default = None;
    changes.push(Some(no_default));
    for replacement in changes {
        let mut next = successor(&old);
        next.schema.fields.remove(&id("title"));
        if let Some(replacement) = replacement {
            next.schema.fields.insert(id("title"), replacement);
        }
        assert_eq!(next.schema.validate(), Ok(()));
        assert_eq!(registration_change(&old, &next), Err(Error::InvalidSchema));
    }
    let mut required_old = old.clone();
    required_old
        .schema
        .fields
        .get_mut(&id("title"))
        .unwrap()
        .required = true;
    let mut relaxed = successor(&required_old);
    relaxed
        .schema
        .fields
        .get_mut(&id("title"))
        .unwrap()
        .required = false;
    assert_eq!(
        registration_change(&required_old, &relaxed),
        Err(Error::InvalidSchema)
    );
}

#[test]
fn both_declarations_and_exact_repeats_are_validated_before_comparison() {
    let valid = registration();
    let mut invalids = Vec::new();
    let mut zero = valid.clone();
    zero.schema.version = 0;
    invalids.push(zero);
    let mut too_many = valid.clone();
    for n in 0..=MAX_FIELDS {
        too_many
            .schema
            .fields
            .insert(id(&format!("f{n}")), field(Kind::String));
    }
    invalids.push(too_many);
    for bad_field in [
        Field {
            nullable: true,
            ..field(Kind::Set)
        },
        Field {
            default: Some(Cell::Value(Value::Boolean(true))),
            ..field(Kind::String)
        },
        Field {
            default: Some(Cell::Value(Value::Number(f64::NAN))),
            ..field(Kind::Number)
        },
    ] {
        let mut invalid = valid.clone();
        invalid.schema.fields.insert(id("bad"), bad_field);
        invalids.push(invalid);
    }
    for invalid in invalids {
        assert!(registration_change(&invalid, &invalid).is_err());
        assert!(registration_change(&valid, &invalid).is_err());
        assert!(registration_change(&invalid, &successor(&valid)).is_err());
    }
}

#[test]
fn decoded_ids_use_existing_validation_on_both_sides_and_repeats() {
    let valid = registration();
    for component in ["realm", "vault", "owner", "collection", "field"] {
        for bad in [
            "".to_string(),
            "has space".into(),
            "é".into(),
            "x".repeat(MAX_ID + 1),
        ] {
            let mut raw = serde_json::to_value(&valid).unwrap();
            if component == "field" {
                raw["schema"]["fields"] = serde_json::json!({bad: field(Kind::String)});
            } else if component == "collection" {
                raw["schema"][component] = bad.into();
            } else {
                raw[component] = bad.into();
            }
            let invalid: Registration = serde_json::from_value(raw).unwrap();
            assert_eq!(
                registration_change(&invalid, &invalid),
                Err(Error::InvalidId),
                "{component}"
            );
            assert_eq!(registration_change(&valid, &invalid), Err(Error::InvalidId));
            assert_eq!(
                registration_change(&invalid, &successor(&valid)),
                Err(Error::InvalidId)
            );
        }
    }
}

#[test]
fn optional_defaults_do_not_rewrite_history_or_reappear_on_patch_or_unset() {
    let old = registration();
    let original = authored(old.schema.clone(), vec![]);
    let bytes = original.snapshot().unwrap();
    let mut next = successor(&old);
    next.schema.fields.insert(
        id("priority"),
        Field {
            nullable: true,
            default: Some(Cell::Value(Value::String("normal".into()))),
            ..field(Kind::String)
        },
    );
    next.schema.fields.insert(id("members"), field(Kind::Set));
    assert_eq!(registration_change(&old, &next), Ok(true));
    let restored = State::restore(next.schema.clone(), &bytes).unwrap();
    assert_eq!(restored.snapshot().unwrap(), bytes);
    assert_eq!(restored.history(), original.history());
    assert!(!restored
        .projection()
        .unwrap()
        .fields
        .contains_key(&id("priority")));
    // Empty sets have no projection entry until a membership action exists.
    assert!(!restored
        .projection()
        .unwrap()
        .sets
        .contains_key(&id("members")));
    let patched = restored
        .prepare(id("patch"), Command::Patch(vec![]))
        .unwrap();
    assert!(!patched
        .next()
        .projection()
        .unwrap()
        .fields
        .contains_key(&id("priority")));
    let created = authored(next.schema.clone(), vec![]);
    assert_eq!(
        created.projection().unwrap().fields[&id("priority")][0].cell,
        Cell::Value(Value::String("normal".into()))
    );
    for cell in [Cell::Null, Cell::Unset] {
        let explicit = authored(next.schema.clone(), vec![write("priority", cell.clone())]);
        assert_eq!(
            explicit.projection().unwrap().fields[&id("priority")][0].cell,
            cell
        );
        let patched = created
            .prepare(
                id("unset"),
                Command::Patch(vec![write("priority", cell.clone())]),
            )
            .unwrap();
        let reopened =
            State::restore(next.schema.clone(), &patched.next().snapshot().unwrap()).unwrap();
        assert_eq!(
            reopened.projection().unwrap().fields[&id("priority")][0].cell,
            cell
        );
    }
    // Guard approval cannot replace the host's accepted-history revalidation:
    // a previously unknown field can already carry incompatible typed values.
    let mut latent = original.clone();
    latent
        .union(&[Operation {
            id: id("remote"),
            parents: vec![id("create")],
            scope: scope(),
            schema_version: 1,
            command: Command::Patch(vec![write("priority", Cell::Value(Value::Integer(3)))]),
        }])
        .unwrap();
    assert_eq!(
        State::restore(next.schema.clone(), &latent.snapshot().unwrap()),
        Err(Error::InvalidValue)
    );
    // Registration does not authorize old offline operations; keep exact equality.
    let intent = original
        .prepare(id("offline"), Command::Patch(vec![]))
        .unwrap();
    let payload = Payload::from_intent(id("update"), intent.payload()).unwrap();
    assert_eq!(
        received_gate(&payload, Some(&next), false),
        Some(Status::IncompatibleSchema)
    );
    assert_eq!(received_gate(&payload, Some(&old), false), None);
}

#[test]
fn registration_preserves_set_remove_tags_generation_and_tombstone() {
    let mut old = registration();
    old.schema.fields.insert(id("members"), field(Kind::Set));
    let created = authored(
        old.schema.clone(),
        vec![Action::Add {
            field: id("members"),
            member: id("item"),
        }],
    );
    let removed = created
        .prepare(
            id("remove"),
            Command::Patch(vec![Action::Remove {
                field: id("members"),
                member: id("item"),
                tags: vec![id("create")],
            }]),
        )
        .unwrap()
        .next()
        .clone();
    let deleted = removed
        .prepare(id("delete"), Command::Delete)
        .unwrap()
        .next()
        .clone();
    let bytes = deleted.snapshot().unwrap();
    let mut next = successor(&old);
    next.schema
        .fields
        .insert(id("optional"), field(Kind::String));
    assert_eq!(registration_change(&old, &next), Ok(true));
    let reopened = State::restore(next.schema, &bytes).unwrap();
    assert_eq!(reopened.snapshot().unwrap(), bytes);
    assert_eq!(reopened.scope(), deleted.scope());
    assert_eq!(reopened.history(), deleted.history());
    assert_eq!(
        reopened.projection().unwrap(),
        deleted.projection().unwrap()
    );
    assert!(reopened.projection().unwrap().deleted);
}
