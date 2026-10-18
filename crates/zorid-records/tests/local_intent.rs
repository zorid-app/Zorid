//! Production-catalog integration checks. Test-only optional-v2/R1 fixtures live
//! inside local_intent.rs so no caller-controlled catalog enters the public API.
use zorid_records::{
    admission, first_party as domain, local_intent::*, workblock_service as service, Action,
    Command, Id, State,
};
fn id(value: &str) -> Id {
    Id::new(value).unwrap()
}
const AUTH: &str = "11111111-1111-4111-8111-111111111111";
const REV: &str = "22222222-2222-4222-8222-222222222222";
fn registration() -> ValidatedRegistration {
    compiled_registration(id("realm"), id("vault")).unwrap()
}
fn scope() -> zorid_records::Scope {
    service::fixed_scope(id("realm"), id("vault"), id("record"), id("create")).unwrap()
}
fn semantic() -> service::WorkBlockCommand {
    service::WorkBlockCommand::Create {
        record: id("record"),
        generation: id("create"),
        operation: id("create"),
        range: domain::Range::new(0, 10, "UTC").unwrap(),
        title: None,
    }
}
fn command() -> Command {
    service::command_for_new(&semantic(), None).unwrap()
}
fn capture() -> LocalIntentV1 {
    capture_local_intent(
        &registration(),
        AUTH,
        REV,
        id("create"),
        scope(),
        [7; 32],
        command(),
        Some(&serde_json::to_vec(&semantic()).unwrap()),
    )
    .unwrap()
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    format_version: u8,
    store_authority: String,
    capture_revision: String,
    operation: Id,
    scope: zorid_records::Scope,
    origin_registration: String,
    expected_revision: [u8; 32],
    command: Command,
    semantic_request: Option<String>,
}
fn wire() -> Wire {
    serde_json::from_slice(&canonical_intent_request(&capture()).unwrap()).unwrap()
}
fn validate(bytes: &[u8]) -> IntentResult<ValidatedLocalIntent> {
    validate_retained_intent(
        &registration(),
        AUTH,
        &scope(),
        &capture().reference(),
        bytes,
    )
}
fn raw(w: &Wire) -> Vec<u8> {
    serde_json::to_vec(w).unwrap()
}
#[test]
fn canonical_full_request_embeds_documents_as_strings_and_preserves_complete_identity() {
    let original = capture();
    let bytes = canonical_intent_request(&original).unwrap();
    let decoded = validate(&bytes).unwrap();
    assert_eq!(canonical_intent_request(&decoded).unwrap(), bytes);
    assert_eq!(
        decoded.reference(),
        ManagedIntentRef {
            operation: id("create"),
            capture_revision: REV.into()
        }
    );
    assert_eq!(decoded.scope(), &scope());
    assert_eq!(decoded.expected_revision(), &[7; 32]);
    assert_eq!(decoded.command(), &command());
    assert_eq!(
        decoded.semantic_request(),
        Some(serde_json::to_vec(&semantic()).unwrap().as_slice())
    );
    assert!(require_fresh_origin(&registration(), &decoded).is_ok());
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["format_version"], 1);
    assert!(value["origin_registration"].is_string());
    assert!(value["semantic_request"].is_string());
    let prefix = String::from_utf8(bytes).unwrap();
    assert!(prefix.starts_with("{\"format_version\":1,\"store_authority\":"));
    assert_eq!(
        decoded.origin().lineage_identity().unwrap(),
        registration().lineage_identity().unwrap()
    );
}
#[test]
fn old_tuple_missing_origin_unknown_fields_and_noncanonical_bytes_are_rejected() {
    assert_eq!(validate(&[]).err(), Some(IntentError::OriginMissing));
    let old = admission::local_request(&scope(), &[7; 32], &command()).unwrap();
    assert_eq!(validate(&old).err(), Some(IntentError::OriginInvalid));
    let mut missing: serde_json::Value =
        serde_json::from_slice(&canonical_intent_request(&capture()).unwrap()).unwrap();
    missing
        .as_object_mut()
        .unwrap()
        .remove("origin_registration");
    assert!(validate(&serde_json::to_vec(&missing).unwrap()).is_err());
    let mut extra = wire();
    extra.format_version = 2;
    assert_eq!(
        validate(&raw(&extra)).err(),
        Some(IntentError::OriginInvalid)
    );
    let mut bytes = canonical_intent_request(&capture()).unwrap();
    bytes.push(b' ');
    assert_eq!(validate(&bytes).err(), Some(IntentError::OriginInvalid));
    let reordered = serde_json::to_vec(
        &serde_json::from_slice::<serde_json::Value>(
            &canonical_intent_request(&capture()).unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_ne!(reordered, canonical_intent_request(&capture()).unwrap());
    assert!(validate(&reordered).is_err());
    let old_registration =
        serde_json::to_vec(&domain::registration(id("realm"), id("vault")).unwrap()).unwrap();
    assert!(validate_registration(&old_registration).is_err());
}
#[test]
fn authority_reference_and_every_scope_component_are_bound() {
    let original = capture();
    let bytes = canonical_intent_request(&original).unwrap();
    assert_eq!(
        validate_retained_intent(
            &registration(),
            "33333333-3333-4333-8333-333333333333",
            &scope(),
            &original.reference(),
            &bytes
        )
        .err(),
        Some(IntentError::Scope)
    );
    let mut reference = original.reference();
    reference.capture_revision = "44444444-4444-4444-8444-444444444444".into();
    assert_eq!(
        validate_retained_intent(&registration(), AUTH, &scope(), &reference, &bytes).err(),
        Some(IntentError::HeadConflict)
    );
    reference = original.reference();
    reference.operation = id("other");
    assert_eq!(
        validate_retained_intent(&registration(), AUTH, &scope(), &reference, &bytes).err(),
        Some(IntentError::OperationCollision)
    );
    for field in 0..7 {
        let mut changed = scope();
        match field {
            0 => changed.realm = id("other"),
            1 => changed.vault = id("other"),
            2 => changed.owner = id("other"),
            3 => changed.collection = id("other"),
            4 => changed.record = id("other"),
            5 => changed.generation = id("other"),
            _ => changed.restores = Some(id("previous")),
        };
        assert!(
            validate_retained_intent(
                &registration(),
                AUTH,
                &changed,
                &original.reference(),
                &bytes
            )
            .is_err(),
            "scope field {field}"
        );
        let mut w = wire();
        w.scope = changed;
        assert!(validate(&raw(&w)).is_err(), "stored scope field {field}");
    }
}
#[test]
fn trusted_catalog_rejects_caller_versions_forks_and_semantic_registration_changes() {
    let original = registration();
    let mut declaration = original.declaration().clone();
    declaration.schema.version = 2;
    declaration.lineage.schemas.push(declaration.schema.clone());
    assert!(validate_registration(&serde_json::to_vec(&declaration).unwrap()).is_err());
    let mut fork = original.declaration().clone();
    fork.schema.fields.get_mut(&id("title")).unwrap().nullable = true;
    fork.lineage.schemas[0] = fork.schema.clone();
    assert!(validate_registration(&serde_json::to_vec(&fork).unwrap()).is_err());
    let mut w = wire();
    w.origin_registration = serde_json::to_string(&declaration).unwrap();
    assert!(validate(&raw(&w)).is_err());
    let mut text = String::from_utf8(original.canonical_bytes().to_vec()).unwrap();
    text.push(' ');
    assert!(validate_registration(text.as_bytes()).is_err());
    assert_eq!(validate_extension(&original, &original).unwrap(), false);
}
#[test]
fn semantic_operation_target_witness_and_command_binding_cannot_be_replaced() {
    let original = capture();
    assert_eq!(
        require_matching_input(
            &original,
            &scope(),
            &id("create"),
            &[8; 32],
            &command(),
            original.semantic_request()
        ),
        Err(IntentError::OperationCollision)
    );
    let mut w = wire();
    let mut request = semantic();
    if let service::WorkBlockCommand::Create { operation, .. } = &mut request {
        *operation = id("other");
    }
    w.semantic_request = Some(serde_json::to_string(&request).unwrap());
    assert!(validate(&raw(&w)).is_err());
    let mut request = semantic();
    if let service::WorkBlockCommand::Create { title, .. } = &mut request {
        *title = Some("changed".into());
    }
    w = wire();
    w.semantic_request = Some(serde_json::to_string(&request).unwrap());
    assert_eq!(
        validate(&raw(&w)).err(),
        Some(IntentError::OperationCollision)
    );
    let mut request = semantic();
    if let service::WorkBlockCommand::Create { record, .. } = &mut request {
        *record = id("other");
    }
    w = wire();
    w.semantic_request = Some(serde_json::to_string(&request).unwrap());
    assert!(validate(&raw(&w)).is_err());
    assert_eq!(
        require_matching_input(
            &original,
            &scope(),
            &id("create"),
            &[7; 32],
            &command(),
            None
        ),
        Err(IntentError::OperationCollision)
    );
    let mut w = wire();
    w.command = Command::Create(vec![]);
    assert!(validate(&raw(&w)).is_err());
    let mut w = wire();
    w.semantic_request = Some(format!("{} ", w.semantic_request.unwrap()));
    assert!(validate(&raw(&w)).is_err());
    // Validly-shaped changes still cannot match original input or full journal bytes.
    let mut changed = wire();
    changed.expected_revision = [8; 32];
    let altered = validate(&raw(&changed)).unwrap();
    assert_ne!(
        canonical_intent_request(&altered).unwrap(),
        canonical_intent_request(&original).unwrap()
    );
    assert_eq!(
        require_matching_input(
            &altered,
            &scope(),
            &id("create"),
            &[7; 32],
            &command(),
            original.semantic_request()
        ),
        Err(IntentError::OperationCollision)
    );
}
#[test]
fn remove_semantics_preserve_original_tags_and_repeated_capture_binds_them() {
    let task = zorid_core::EntryId::new("task").unwrap();
    let mut state = State::new(domain::schema(), scope()).unwrap();
    let p = state.prepare(id("create"), command()).unwrap();
    state.install(p).unwrap();
    let p = state.prepare(id("add"), domain::add_task(&task)).unwrap();
    state.install(p).unwrap();
    let semantic = service::WorkBlockCommand::RemoveRef {
        record: id("record"),
        generation: id("create"),
        operation: id("remove"),
        expected_revision: service::WorkBlockRevision([7; 32]),
        task: task.clone(),
    };
    let raw_command = service::command_for_new(&semantic, Some(&state)).unwrap();
    let semantic_bytes = serde_json::to_vec(&semantic).unwrap();
    let captured = capture_local_intent(
        &registration(),
        AUTH,
        REV,
        id("remove"),
        scope(),
        [7; 32],
        raw_command.clone(),
        Some(&semantic_bytes),
    )
    .unwrap();
    let p = state.prepare(id("remove"), raw_command.clone()).unwrap();
    state.install(p).unwrap();
    let p = state.prepare(id("readd"), domain::add_task(&task)).unwrap();
    state.install(p).unwrap();
    let newer = service::command_for_new(&semantic, Some(&state)).unwrap();
    assert_ne!(raw_command, newer);
    let bytes = canonical_intent_request(&captured).unwrap();
    let retained = validate_retained_intent(
        &registration(),
        AUTH,
        &scope(),
        &captured.reference(),
        &bytes,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_vec(retained.command()).unwrap(),
        serde_json::to_vec(&raw_command).unwrap()
    );
    assert!(require_matching_input(
        &retained,
        &scope(),
        &id("remove"),
        &[7; 32],
        &raw_command,
        Some(&semantic_bytes)
    )
    .is_ok());
    assert_eq!(
        require_matching_input(
            &retained,
            &scope(),
            &id("remove"),
            &[7; 32],
            &newer,
            Some(&semantic_bytes)
        ),
        Err(IntentError::OperationCollision)
    );
    let changed = service::WorkBlockCommand::RemoveRef {
        record: id("record"),
        generation: id("create"),
        operation: id("remove"),
        expected_revision: service::WorkBlockRevision([8; 32]),
        task,
    };
    assert!(capture_local_intent(
        &registration(),
        AUTH,
        REV,
        id("remove"),
        scope(),
        [7; 32],
        raw_command,
        Some(&serde_json::to_vec(&changed).unwrap())
    )
    .is_err());
}
#[test]
fn identity_guards_and_fixed_collection_operation_key_do_not_issue_authority() {
    assert_eq!(
        RESERVED_CHECKPOINT_CLIENT,
        "f7bca1bf-2a2c-438e-b430-b3f05e5d9324"
    );
    for value in [
        RESERVED_CHECKPOINT_CLIENT.to_owned(),
        RESERVED_CHECKPOINT_CLIENT.to_uppercase(),
    ] {
        assert!(is_reserved_checkpoint_client(&value));
        assert_eq!(
            validate_ordinary_checkpoint_client(&value),
            Err(IntentError::ReservedClient)
        );
    }
    assert!(validate_ordinary_checkpoint_client(AUTH).is_ok());
    assert!(validate_ordinary_checkpoint_client("not-a-uuid").is_err());
    assert_eq!(
        intent_checkpoint_key(&scope(), &id("create")).unwrap(),
        r#"["managed-record-intent-v1","realm","vault","zorid_firstparty_calendar","workblocks","create"]"#
    );
    let mut alternate = scope();
    alternate.record = id("another");
    assert_eq!(
        intent_checkpoint_key(&scope(), &id("create")).unwrap(),
        intent_checkpoint_key(&alternate, &id("create")).unwrap()
    );
    assert!(capture_local_intent(
        &registration(),
        "not-authority",
        REV,
        id("create"),
        scope(),
        [0; 32],
        command(),
        None
    )
    .is_err());
    assert!(capture_local_intent(
        &registration(),
        AUTH,
        "NOT-REVISION",
        id("create"),
        scope(),
        [0; 32],
        command(),
        None
    )
    .is_err());
}
#[test]
fn declared_bounds_fail_before_decode_and_do_not_loosen_existing_domain_rules() {
    assert_eq!(
        validate(&vec![b' '; MAX_INTENT_BYTES + 1]).err(),
        Some(IntentError::Limit)
    );
    assert_eq!(
        validate_registration(&vec![b' '; MAX_REGISTRATION_BYTES + 1]).err(),
        Some(IntentError::Limit)
    );
    assert_eq!(
        capture_local_intent(
            &registration(),
            AUTH,
            REV,
            id("create"),
            scope(),
            [0; 32],
            command(),
            Some(&vec![b'x'; MAX_SEMANTIC_BYTES + 1])
        )
        .err(),
        Some(IntentError::Limit)
    );
    let mut escaped = scope();
    let long = id(&"\"".repeat(128));
    escaped.realm = long.clone();
    escaped.vault = long.clone();
    escaped.owner = long.clone();
    escaped.collection = long.clone();
    assert_eq!(
        intent_checkpoint_key(&escaped, &long).err(),
        Some(IntentError::Limit)
    );
    assert!(capture_local_intent(
        &registration(),
        AUTH,
        REV,
        id("create"),
        scope(),
        [0; 32],
        Command::Create(vec![]),
        None
    )
    .is_err());
    let mut invalid = command();
    if let Command::Create(actions) = &mut invalid {
        actions.push(Action::Add {
            field: id("task_refs"),
            member: id("bad\"ref"),
        });
    }
    assert!(capture_local_intent(
        &registration(),
        AUTH,
        REV,
        id("create"),
        scope(),
        [0; 32],
        invalid,
        None
    )
    .is_err());
    // No state preparation occurs merely by capturing or validating the intent.
    let state = State::new(domain::schema(), scope()).unwrap();
    let before = state.snapshot().unwrap();
    let _ = capture();
    assert_eq!(state.snapshot().unwrap(), before);
}
