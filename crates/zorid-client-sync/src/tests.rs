use super::*;
use zorid_crypto::{CryptoError, EntropySource};
use zorid_sync_protocol::Header;

// Deterministic entropy exists only inside this test module; never production.
struct FixtureEntropy(u8);
impl EntropySource for FixtureEntropy {
    fn fill(&mut self, output: &mut [u8]) -> std::result::Result<(), CryptoError> {
        output.fill(self.0);
        self.0 = self.0.wrapping_add(1);
        Ok(())
    }
}
fn revision(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn identity() -> TextIdentity {
    TextIdentity {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        entry_id: EntryId::new("file").unwrap(),
        bootstrap_id: UpdateId::new("bootstrap").unwrap(),
    }
}
fn actor(id: u32, owner: &str) -> ActorRegistration {
    ActorRegistration {
        actor: id,
        owner: ActorOwner {
            replica_id: DeviceId::new(owner).unwrap(),
            incarnation_id: OperationId::new("incarnation").unwrap(),
        },
    }
}
fn empty() -> TextState {
    TextState::empty(identity(), revision("empty"))
}
fn request(
    state: &TextState,
    name: &str,
    actor: ActorRegistration,
    edits: Vec<Edit>,
) -> AuthorRequest {
    AuthorRequest {
        expected_version: state.version.clone(),
        next_version: revision(name),
        update_id: UpdateId::new(name).unwrap(),
        actor,
        edits,
    }
}
fn insert(index: u32, text: &str) -> Edit {
    Edit::Insert {
        index,
        text: text.into(),
    }
}
fn seed(text: &str) -> AuthoredPlan {
    let initial = empty();
    plan_authored_text(
        &initial,
        &request(&initial, "seed", actor(1, "creator"), vec![insert(0, text)]),
    )
    .unwrap()
}
fn wire(payload: &[u8], id: &UpdateId, nonce: u8) -> Vec<u8> {
    let identity = identity();
    let header = Header::new(
        identity.realm_id,
        identity.vault_id,
        id.clone(),
        DeviceId::new("transport-origin").unwrap(),
        1,
    )
    .unwrap();
    zorid_crypto::seal(
        &header,
        payload,
        &VaultKey::from_bytes([7; 32]),
        &mut FixtureEntropy(nonce),
    )
    .unwrap()
    .encode()
}
fn open(payload: &[u8], id: &UpdateId, nonce: u8) -> AuthenticatedText {
    open_wire(&wire(payload, id, nonce), id).unwrap()
}
fn open_wire(wire: &[u8], id: &UpdateId) -> Result<AuthenticatedText> {
    let identity = identity();
    AuthenticatedText::open(
        wire,
        &ExpectedContext {
            realm_id: identity.realm_id,
            vault_id: identity.vault_id,
            update_id: id.clone(),
            key_epoch: 1,
        },
        &VaultKey::from_bytes([7; 32]),
    )
}
fn authored(plan: &AuthoredPlan) -> AuthenticatedText {
    open(&plan.authored.payload_bytes, &plan.authored.update_id, 1)
}
fn receive(state: &TextState, update: &AuthenticatedText, name: &str) -> ReceivedPlan {
    plan_received_text(
        state,
        &ReceiveRequest {
            expected_version: state.version.clone(),
            next_version: revision(name),
            delivery: None,
        },
        update,
        None,
        None,
    )
    .unwrap()
}
fn restart(state: &TextState) -> TextState {
    serde_json::from_slice(&serde_json::to_vec(state).unwrap()).unwrap()
}
fn string(state: &TextState) -> String {
    String::from_utf8(state.materialized_utf8().unwrap()).unwrap()
}

#[test]
fn offline_unicode_edits_converge_with_reverse_delivery_and_restart() {
    let seed = seed("A😀 middle Z\r\n");
    let a = restart(&seed.next_state);
    let b = receive(&empty(), &authored(&seed), "b-seed")
        .next_state
        .unwrap();
    let left = plan_authored_text(
        &a,
        &request(&a, "left", actor(2, "a"), vec![insert(0, "left ")]),
    )
    .unwrap();
    let right = plan_authored_text(
        &b,
        &request(&b, "right", actor(3, "b"), vec![insert(3, "右")]),
    )
    .unwrap();
    let final_a = receive(&restart(&left.next_state), &authored(&right), "a-receive")
        .next_state
        .unwrap();
    let final_b = receive(&restart(&right.next_state), &authored(&left), "b-receive")
        .next_state
        .unwrap();
    assert_eq!(string(&final_a), "left A😀右 middle Z\r\n");
    assert_eq!(string(&final_a), string(&final_b));
    assert_ne!(final_a.version, final_b.version); // Local versions never synchronize.
}

#[test]
fn pending_dependency_and_actor_ownership_survive_serialized_restart() {
    let seed = seed("base");
    let first = plan_authored_text(
        &seed.next_state,
        &request(
            &seed.next_state,
            "first",
            actor(2, "a"),
            vec![insert(4, "X")],
        ),
    )
    .unwrap();
    let second = plan_authored_text(
        &first.next_state,
        &request(
            &first.next_state,
            "second",
            actor(2, "a"),
            vec![insert(5, "Y")],
        ),
    )
    .unwrap();
    let queued = receive(&empty(), &authored(&second), "queued")
        .next_state
        .unwrap();
    assert_eq!(string(&queued), "");
    assert_eq!(queued.actors.get(&2), Some(&actor(2, "a").owner));
    let after_seed = receive(&restart(&queued), &authored(&seed), "got-seed")
        .next_state
        .unwrap();
    let final_state = receive(&restart(&after_seed), &authored(&first), "got-first")
        .next_state
        .unwrap();
    assert_eq!(string(&final_state), "baseXY");
}

#[test]
fn deletion_only_update_and_delete_before_insert_survive_restart() {
    let seed = seed("😀abc");
    let before = load(&seed.next_state, 0).unwrap().state_vector();
    let deletion = plan_authored_text(
        &seed.next_state,
        &request(
            &seed.next_state,
            "deletion",
            actor(2, "a"),
            vec![Edit::Delete {
                index: 2,
                length: 1,
            }],
        ),
    )
    .unwrap();
    assert_eq!(
        before,
        load(&deletion.next_state, 0).unwrap().state_vector()
    );
    let early = receive(&empty(), &authored(&deletion), "early")
        .next_state
        .unwrap();
    let after = receive(&restart(&early), &authored(&seed), "seed-late")
        .next_state
        .unwrap();
    assert_eq!(string(&after), "😀bc");
}

#[test]
fn duplicate_can_advance_cursor_without_revision_or_authored_output() {
    let seed = seed("hello");
    let update = authored(&seed);
    let first = receive(&empty(), &update, "first");
    let state = first.next_state.unwrap();
    let old_cursor = ReceiveCursor {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        server_epoch: ServerEpoch::new("epoch").unwrap(),
        after: LogPosition::new(9007199254740993),
    };
    let mut next_cursor = old_cursor.clone();
    next_cursor.after = LogPosition::new(9007199254740994);
    let req = ReceiveRequest {
        expected_version: state.version.clone(),
        next_version: state.version.clone(),
        delivery: Some(CursorAdvance {
            expected: old_cursor.clone(),
            next: next_cursor.clone(),
        }),
    };
    let replay = plan_received_text(
        &state,
        &req,
        &update,
        Some(&first.received_record),
        Some(&old_cursor),
    )
    .unwrap();
    assert!(replay.next_state.is_none());
    assert!(replay.materialized_utf8.is_none());
    assert_eq!(replay.expected_record, Some(first.received_record));
    assert_eq!(replay.expected_cursor, Some(old_cursor.clone()));
    let json = serde_json::to_value(&replay).unwrap();
    assert!(json.get("authored").is_none());
    assert!(json.get("outbox").is_none());
    assert_eq!(json["cursor_advance"]["next"]["after"], "9007199254740994");
    assert_eq!(
        plan_received_text(&state, &req, &update, None, Some(&next_cursor)).unwrap_err(),
        SyncError::CursorConflict
    );
    let mut other_epoch = old_cursor;
    other_epoch.server_epoch = ServerEpoch::new("restored").unwrap();
    assert_eq!(
        plan_received_text(&state, &req, &update, None, Some(&other_epoch)).unwrap_err(),
        SyncError::CursorConflict
    );
}

#[test]
fn same_update_id_reencrypted_is_dedupe_mismatch_even_if_plaintext_matches() {
    let seed = seed("hello");
    let first = receive(&empty(), &authored(&seed), "first");
    let state = first.next_state.unwrap();
    let different_wire = open(&seed.authored.payload_bytes, &seed.authored.update_id, 2);
    let request = ReceiveRequest {
        expected_version: state.version.clone(),
        next_version: revision("next"),
        delivery: None,
    };
    assert_eq!(
        plan_received_text(
            &state,
            &request,
            &different_wire,
            Some(&first.received_record),
            None
        )
        .unwrap_err(),
        SyncError::DedupeMismatch
    );
    let mut wrong_lookup = first.received_record;
    wrong_lookup.update_id = UpdateId::new("wrong-lookup-key").unwrap();
    assert_eq!(
        plan_received_text(
            &state,
            &request,
            &authored(&seed),
            Some(&wrong_lookup),
            None
        )
        .unwrap_err(),
        SyncError::DedupeMismatch
    );
}

#[test]
fn forced_actor_collision_fails_before_merging_concurrent_clock_zero() {
    let base = seed("base").next_state;
    let a = plan_authored_text(
        &base,
        &request(&base, "a", actor(42, "replica-a"), vec![insert(0, "A")]),
    )
    .unwrap();
    let b = plan_authored_text(
        &base,
        &request(&base, "b", actor(42, "replica-b"), vec![insert(0, "B")]),
    )
    .unwrap();
    let input = ReceiveRequest {
        expected_version: a.next_state.version.clone(),
        next_version: revision("bad"),
        delivery: None,
    };
    assert_eq!(
        plan_received_text(&a.next_state, &input, &authored(&b), None, None).unwrap_err(),
        SyncError::ActorCollision
    );
    assert_eq!(string(&a.next_state), "Abase");
}

#[test]
fn external_multihunk_edit_uses_old_baseline_without_erasing_remote_text() {
    let base = seed("start 😀 center end").next_state;
    let baseline = base.projection_baseline().unwrap();
    let remote = plan_authored_text(
        &base,
        &request(
            &base,
            "remote",
            actor(2, "remote"),
            vec![insert(16, "REMOTE ")],
        ),
    )
    .unwrap();
    let req = request(&remote.next_state, "external", actor(3, "scanner"), vec![]);
    let imported = plan_external_text(
        &remote.next_state,
        &baseline,
        "START 😀 center END".as_bytes(),
        &req,
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(imported.materialized_utf8.clone()).unwrap(),
        "START 😀 center REMOTE END"
    );
    assert_eq!(imported.expected_baseline, Some(baseline.clone()));
    let other = receive(&base, &authored(&imported), "other-external")
        .next_state
        .unwrap();
    let other = receive(&other, &authored(&remote), "other-remote")
        .next_state
        .unwrap();
    assert_eq!(string(&other), string(&imported.next_state));
    let mut reused = req;
    reused.actor = actor(2, "remote");
    assert_eq!(
        plan_external_text(&remote.next_state, &baseline, b"replacement", &reused).unwrap_err(),
        SyncError::FreshActorRequired
    );
}

#[test]
fn external_baseline_bytes_identity_and_registry_are_checked() {
    let base = seed("baseline").next_state;
    let req = request(&base, "external", actor(3, "scanner"), vec![]);
    let mut baseline = base.projection_baseline().unwrap();
    baseline.materialized_utf8 = b"fake".to_vec();
    assert_eq!(
        plan_external_text(&base, &baseline, b"new", &req).unwrap_err(),
        SyncError::InvalidState
    );
    baseline = base.projection_baseline().unwrap();
    baseline.state.identity.bootstrap_id = UpdateId::new("another-bootstrap").unwrap();
    assert_eq!(
        plan_external_text(&base, &baseline, b"new", &req).unwrap_err(),
        SyncError::IdentityMismatch
    );
    baseline = base.projection_baseline().unwrap();
    baseline.state.actors.get_mut(&1).unwrap().replica_id =
        DeviceId::new("different-owner").unwrap();
    assert_eq!(
        plan_external_text(&base, &baseline, b"new", &req).unwrap_err(),
        SyncError::InvalidState
    );
    assert_eq!(
        plan_external_text(&base, &base.projection_baseline().unwrap(), &[0xff], &req).unwrap_err(),
        SyncError::InvalidEdit
    );
}

#[test]
fn invalid_utf16_batch_does_not_partially_mutate_replica() {
    let replica = TextReplica::new(1);
    replica.insert(0, "😀").unwrap();
    assert!(replica
        .edit(&[
            TextEdit::Insert {
                index: 2,
                text: "okay".into()
            },
            TextEdit::Delete {
                index: 1,
                length: 1
            }
        ])
        .is_err());
    assert_eq!(replica.text(), "😀");
    let state = seed("😀").next_state;
    assert_eq!(
        plan_authored_text(
            &state,
            &request(&state, "bad", actor(2, "a"), vec![insert(1, "bad")])
        )
        .unwrap_err(),
        SyncError::InvalidEdit
    );
}

#[test]
fn strict_payload_context_and_actor_declaration_fail_closed() {
    let seed = seed("hello");
    let mut payload: serde_json::Value =
        serde_json::from_slice(&seed.authored.payload_bytes).unwrap();
    payload["unknown_required"] = true.into();
    assert!(matches!(
        open_wire(
            &wire(
                &serde_json::to_vec(&payload).unwrap(),
                &seed.authored.update_id,
                1
            ),
            &seed.authored.update_id
        ),
        Err(SyncError::InvalidPayload)
    ));
    payload.as_object_mut().unwrap().remove("unknown_required");
    payload["format_version"] = 2.into();
    assert!(matches!(
        open_wire(
            &wire(
                &serde_json::to_vec(&payload).unwrap(),
                &seed.authored.update_id,
                1
            ),
            &seed.authored.update_id
        ),
        Err(SyncError::UnsupportedFormat)
    ));
    payload["format_version"] = 1.into();
    payload["actor"]["actor"] = 99.into();
    assert!(matches!(
        open_wire(
            &wire(
                &serde_json::to_vec(&payload).unwrap(),
                &seed.authored.update_id,
                1
            ),
            &seed.authored.update_id
        ),
        Err(SyncError::InvalidPayload)
    ));
    let mut bytes = wire(&seed.authored.payload_bytes, &seed.authored.update_id, 1);
    *bytes.last_mut().unwrap() ^= 1;
    assert!(matches!(
        open_wire(&bytes, &seed.authored.update_id),
        Err(SyncError::AuthenticationFailed)
    ));
    assert!(matches!(
        open_wire(
            &wire(&seed.authored.payload_bytes, &seed.authored.update_id, 1),
            &UpdateId::new("another").unwrap()
        ),
        Err(SyncError::AuthenticationFailed)
    ));
}

#[test]
fn bounds_and_stale_version_are_explicit_errors() {
    let state = empty();
    let mut req = request(&state, "new", actor(1, "a"), vec![insert(0, "x")]);
    req.expected_version = revision("stale");
    assert_eq!(
        plan_authored_text(&state, &req).unwrap_err(),
        SyncError::VersionConflict
    );
    req.expected_version = state.version.clone();
    req.edits = vec![insert(0, &"x".repeat(MAX_TEXT_BYTES + 1))];
    assert_eq!(
        plan_authored_text(&state, &req).unwrap_err(),
        SyncError::TooLarge
    );
    req.edits.clear();
    assert_eq!(
        plan_external_text(
            &state,
            &state.projection_baseline().unwrap(),
            "x".repeat(MAX_TEXT_BYTES + 1).as_bytes(),
            &req
        )
        .unwrap_err(),
        SyncError::TooLarge
    );
    assert!(matches!(
        AuthenticatedText::open(
            &vec![0; MAX_WIRE_BYTES + 1],
            &ExpectedContext {
                realm_id: identity().realm_id,
                vault_id: identity().vault_id,
                update_id: req.update_id,
                key_epoch: 1,
            },
            &VaultKey::from_bytes([7; 32])
        ),
        Err(SyncError::TooLarge)
    ));
}

#[test]
fn new_bootstrap_with_same_text_is_not_same_document() {
    let seed = seed("hello");
    let mut other = empty();
    other.identity.bootstrap_id = UpdateId::new("other").unwrap();
    let request = ReceiveRequest {
        expected_version: other.version.clone(),
        next_version: revision("next"),
        delivery: None,
    };
    assert_eq!(
        plan_received_text(&other, &request, &authored(&seed), None, None).unwrap_err(),
        SyncError::IdentityMismatch
    );
}

#[test]
fn committing_preconditions_cover_provenance_ledger_and_cursor_races() {
    let empty = empty();
    let seed = seed("hello");
    seed.check_preconditions(&empty, None, true).unwrap();
    assert_eq!(
        seed.check_preconditions(&empty, None, false).unwrap_err(),
        SyncError::DedupeMismatch
    );
    let mut same_version_different_cause = empty.clone();
    same_version_different_cause
        .actors
        .insert(55, actor(55, "racer").owner);
    assert_eq!(
        seed.check_preconditions(&same_version_different_cause, None, true)
            .unwrap_err(),
        SyncError::VersionConflict
    );
    let received = receive(&empty, &authored(&seed), "new");
    received.check_preconditions(&empty, None, None).unwrap();
    assert_eq!(
        received
            .check_preconditions(&empty, Some(&received.received_record), None)
            .unwrap_err(),
        SyncError::DedupeMismatch
    );
    let cursor = ReceiveCursor {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        server_epoch: ServerEpoch::new("epoch").unwrap(),
        after: LogPosition::new(1),
    };
    assert_eq!(
        received
            .check_preconditions(&empty, None, Some(&cursor))
            .unwrap_err(),
        SyncError::CursorConflict
    );
}

#[test]
fn transaction_capture_does_not_rebroadcast_historical_remote_deletes() {
    let seed = seed("abc");
    let deletion = plan_authored_text(
        &seed.next_state,
        &request(
            &seed.next_state,
            "delete",
            actor(2, "a"),
            vec![Edit::Delete {
                index: 1,
                length: 1,
            }],
        ),
    )
    .unwrap();
    let remote_state = receive(&seed.next_state, &authored(&deletion), "remote")
        .next_state
        .unwrap();
    let no_change = plan_authored_text(
        &remote_state,
        &request(&remote_state, "noop", actor(3, "b"), vec![]),
    )
    .unwrap();
    let payload = TextPayload::decode(&no_change.authored.payload_bytes).unwrap();
    assert_eq!(payload.update, TextReplica::new(99).edit(&[]).unwrap());
    assert_ne!(
        payload.update,
        load(&remote_state, 0)
            .unwrap()
            .changes_since(&load(&remote_state, 0).unwrap().state_vector())
            .unwrap()
    );
}

#[test]
fn actor_with_pending_clock_cannot_be_reused_to_author() {
    let seed = seed("base");
    let first = plan_authored_text(
        &seed.next_state,
        &request(
            &seed.next_state,
            "first",
            actor(2, "a"),
            vec![insert(4, "X")],
        ),
    )
    .unwrap();
    let second = plan_authored_text(
        &first.next_state,
        &request(
            &first.next_state,
            "second",
            actor(2, "a"),
            vec![insert(5, "Y")],
        ),
    )
    .unwrap();
    let pending = receive(&empty(), &authored(&second), "pending")
        .next_state
        .unwrap();
    assert_eq!(
        plan_authored_text(
            &pending,
            &request(&pending, "danger", actor(2, "a"), vec![insert(0, "new")])
        )
        .unwrap_err(),
        SyncError::FreshActorRequired
    );
    let safe = plan_authored_text(
        &pending,
        &request(&pending, "safe", actor(3, "a"), vec![insert(0, "new")]),
    )
    .unwrap();
    assert_eq!(string(&safe.next_state), "new");
}

#[test]
fn hidden_map_payload_never_produces_an_ingest_commit_plan() {
    use yrs::{Doc, Map, ReadTxn, StateVector, Transact};
    let foreign = Doc::with_client_id(7);
    let map = foreign.get_or_insert_map("content");
    map.insert(&mut foreign.transact_mut(), "hidden", "first");
    let first = foreign
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let first_vector = foreign.transact().state_vector();
    map.insert(&mut foreign.transact_mut(), "hidden", "second");
    let second = foreign.transact().encode_state_as_update_v1(&first_vector);
    let make = |update: Vec<u8>, id: &str| {
        let payload = TextPayload {
            family: "text".into(),
            format_version: 1,
            identity: identity(),
            actor: actor(7, "foreign"),
            update,
        };
        open(&payload.encode().unwrap(), &UpdateId::new(id).unwrap(), 1)
    };
    let initial = empty();
    let first = make(first, "first");
    let second = make(second, "second");
    let request = |state: &TextState| ReceiveRequest {
        expected_version: state.version.clone(),
        next_version: revision("next"),
        delivery: None,
    };
    assert_eq!(
        plan_received_text(&initial, &request(&initial), &first, None, None).unwrap_err(),
        SyncError::InvalidPayload
    );
    let pending = receive(&initial, &second, "pending").next_state.unwrap();
    let restored = restart(&pending);
    assert_eq!(
        plan_received_text(&restored, &request(&restored), &first, None, None).unwrap_err(),
        SyncError::InvalidPayload
    );
    assert_eq!(string(&restored), "");
}

#[test]
fn required_family_rejects_legacy_unknown_and_duplicate_discriminators() {
    let seed = seed("family");
    let mut payload: serde_json::Value =
        serde_json::from_slice(&seed.authored.payload_bytes).unwrap();
    assert_eq!(payload["family"], "text");
    payload.as_object_mut().unwrap().remove("family");
    let legacy = wire(
        &serde_json::to_vec(&payload).unwrap(),
        &seed.authored.update_id,
        1,
    );
    assert!(matches!(
        open_wire(&legacy, &seed.authored.update_id),
        Err(SyncError::UnsupportedFormat)
    ));
    payload["family"] = "files".into();
    let other = wire(
        &serde_json::to_vec(&payload).unwrap(),
        &seed.authored.update_id,
        1,
    );
    assert!(matches!(
        open_wire(&other, &seed.authored.update_id),
        Err(SyncError::UnsupportedFormat)
    ));
    let duplicate = br#"{"family":"files","family":"text","format_version":1}"#;
    assert_eq!(
        TextPayload::decode(duplicate).unwrap_err(),
        SyncError::InvalidPayload
    );
    assert_eq!(
        TextPayload::decode(br#"{"family":"text"}"#).unwrap_err(),
        SyncError::UnsupportedFormat
    );
}

#[test]
fn shared_authenticated_capability_decodes_without_reopening_ciphertext() {
    let seed = seed("once");
    let bytes = wire(&seed.authored.payload_bytes, &seed.authored.update_id, 8);
    let context = ExpectedContext {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        update_id: seed.authored.update_id.clone(),
        key_epoch: 1,
    };
    let opened = OpenedEnvelope::open(&bytes, &context, &VaultKey::from_bytes([7; 32])).unwrap();
    let decoded = AuthenticatedText::from_opened(&opened).unwrap();
    assert_eq!(decoded.record.exact_wire, bytes);
    assert_eq!(decoded.update_id(), &seed.authored.update_id);
    assert_eq!(
        string(&receive(&empty(), &decoded, "received").next_state.unwrap()),
        "once"
    );
}

#[test]
fn replace_current_text_preserves_bom_line_endings_and_supplementary_characters() {
    let initial = empty();
    let wanted = "\u{feff}A😀\r\n𐐷Z\n".as_bytes();
    let created = plan_replace_text(
        &initial,
        wanted,
        &request(&initial, "created", actor(1, "a"), vec![]),
    )
    .unwrap();
    assert_eq!(created.materialized_utf8, wanted);
    assert!(created.expected_baseline.is_none());
    let wanted = "\u{feff}B😀\r\n𐐷END\n".as_bytes();
    let updated = plan_replace_text(
        &created.next_state,
        wanted,
        &request(&created.next_state, "updated", actor(1, "a"), vec![]),
    )
    .unwrap();
    assert_eq!(updated.materialized_utf8, wanted);
    assert!(updated.expected_baseline.is_none());
    let other = receive(&initial, &authored(&created), "received-created")
        .next_state
        .unwrap();
    let other = receive(&other, &authored(&updated), "received-updated")
        .next_state
        .unwrap();
    assert_eq!(other.materialized_utf8().unwrap(), wanted);
    let cleared = plan_replace_text(
        &updated.next_state,
        b"",
        &request(&updated.next_state, "cleared", actor(1, "a"), vec![]),
    )
    .unwrap();
    assert!(cleared.materialized_utf8.is_empty());
    assert!(cleared.expected_baseline.is_none());
}

#[test]
fn replace_empty_and_identical_text_have_empty_transaction_updates() {
    for base in [
        empty(),
        seed("😀unchanged\r\n").next_state,
        seed(&"😀unchanged\r\n".repeat(MAX_DIFF_CHARS / 4)).next_state,
    ] {
        let current = base.materialized_utf8().unwrap();
        let plan = plan_replace_text(
            &base,
            &current,
            &request(&base, "noop-replacement", actor(2, "a"), vec![]),
        )
        .unwrap();
        assert_eq!(plan.materialized_utf8, current);
        assert_eq!(
            TextPayload::decode(&plan.authored.payload_bytes)
                .unwrap()
                .update,
            TextReplica::new(99).edit(&[]).unwrap()
        );
        assert_eq!(plan.expected_state, base);
        assert!(plan.expected_baseline.is_none());
    }
}

#[test]
fn stale_whole_text_command_cannot_overwrite_newer_concurrent_content() {
    let base = seed("original").next_state;
    let stale = request(&base, "replacement", actor(2, "a"), vec![]);
    let concurrent = plan_authored_text(
        &base,
        &request(&base, "other", actor(3, "b"), vec![insert(8, " remote")]),
    )
    .unwrap();
    assert_eq!(
        plan_replace_text(&concurrent.next_state, b"replacement", &stale).unwrap_err(),
        SyncError::VersionConflict
    );
    assert_eq!(string(&concurrent.next_state), "original remote");
    // Even a plan prepared before the competing commit cannot pass commit CAS.
    let prepared = plan_replace_text(&base, b"replacement", &stale).unwrap();
    assert_eq!(
        prepared
            .check_preconditions(&concurrent.next_state, None, true)
            .unwrap_err(),
        SyncError::VersionConflict
    );
}

#[test]
fn whole_text_replacement_rejects_lossy_double_and_oversized_content() {
    let base = seed("unchanged").next_state;
    let mut req = request(&base, "replace", actor(2, "a"), vec![]);
    assert_eq!(
        plan_replace_text(&base, &[0xef, 0xbb, 0xbf, 0xff], &req).unwrap_err(),
        SyncError::InvalidEdit
    );
    assert_eq!(
        plan_replace_text(&base, &vec![b'x'; MAX_TEXT_BYTES + 1], &req).unwrap_err(),
        SyncError::TooLarge
    );
    req.edits.push(insert(0, "sneaky"));
    assert_eq!(
        plan_replace_text(&base, b"replacement", &req).unwrap_err(),
        SyncError::InvalidEdit
    );
    assert_eq!(string(&base), "unchanged");
}

#[test]
fn external_observed_baseline_excludes_unpublished_remote_edits_across_restart() {
    let base = seed("a😀b").next_state;
    let baseline = base.projection_baseline().unwrap();
    let remote = plan_authored_text(
        &base,
        &request(
            &base,
            "remote-prefix",
            actor(2, "remote"),
            vec![insert(0, "REMOTE ")],
        ),
    )
    .unwrap();
    let req = request(
        &remote.next_state,
        "external-delete",
        actor(3, "scanner"),
        vec![],
    );
    let plan = plan_external_text_with_baseline(
        &remote.next_state,
        &baseline,
        "a😀".as_bytes(),
        &req,
        &revision("observed-1"),
    )
    .unwrap();
    assert_eq!(
        plan.authored,
        plan_external_text(&remote.next_state, &baseline, "a😀".as_bytes(), &req).unwrap()
    );
    assert_eq!(plan.observed_baseline.materialized_utf8, "a😀".as_bytes());
    assert_eq!(string(&plan.observed_baseline.state), "a😀");
    assert_eq!(string(&plan.authored.next_state), "REMOTE a😀");
    assert_eq!(plan.authored.expected_baseline, Some(baseline.clone()));
    assert!(!plan.observed_baseline.state.actors.contains_key(&2));
    // Deletion-only branches still reserve their fresh actor ownership.
    assert_eq!(
        plan.observed_baseline.state.actors.get(&3),
        Some(&req.actor.owner)
    );
    assert!(plan.authored.next_state.actors.contains_key(&2));
    let from_branch = receive(
        &plan.observed_baseline.state,
        &authored(&remote),
        "branch-merged",
    );
    assert_eq!(
        from_branch.materialized_utf8,
        Some(plan.authored.materialized_utf8.clone())
    );

    // A second disk edit arrives before the merged state is physically published.
    // Its baseline is the observed branch, so it cannot delete the remote prefix.
    let current = restart(&plan.authored.next_state);
    let observed: TextBaseline =
        serde_json::from_slice(&serde_json::to_vec(&plan.observed_baseline).unwrap()).unwrap();
    let next_req = request(
        &current,
        "second-observation",
        actor(4, "scanner-next"),
        vec![],
    );
    let second = plan_external_text_with_baseline(
        &current,
        &observed,
        b"a",
        &next_req,
        &revision("observed-2"),
    )
    .unwrap();
    assert_eq!(string(&second.authored.next_state), "REMOTE a");
    assert_eq!(second.observed_baseline.materialized_utf8, b"a");
    assert_eq!(string(&second.observed_baseline.state), "a");
    assert_eq!(
        second
            .authored
            .check_preconditions(&current, Some(&observed), true),
        Ok(())
    );
    assert_eq!(
        second
            .authored
            .check_preconditions(&current, Some(&baseline), true),
        Err(SyncError::InvalidState)
    );
}

#[test]
fn external_observed_revision_must_be_separate_and_noop_preserves_exact_bytes() {
    let base = seed("\u{feff}😀\r\n").next_state;
    let baseline = base.projection_baseline().unwrap();
    let remote = plan_authored_text(
        &base,
        &request(&base, "remote", actor(2, "remote"), vec![insert(0, "R")]),
    )
    .unwrap();
    let req = request(
        &remote.next_state,
        "noop-import",
        actor(3, "scanner"),
        vec![],
    );
    for used in [&base.version, &remote.next_state.version, &req.next_version] {
        assert_eq!(
            plan_external_text_with_baseline(
                &remote.next_state,
                &baseline,
                &baseline.materialized_utf8,
                &req,
                used
            )
            .unwrap_err(),
            SyncError::VersionConflict
        );
    }
    let plan = plan_external_text_with_baseline(
        &remote.next_state,
        &baseline,
        &baseline.materialized_utf8,
        &req,
        &revision("observed"),
    )
    .unwrap();
    assert_eq!(
        plan.observed_baseline.materialized_utf8,
        baseline.materialized_utf8
    );
    assert_eq!(plan.authored.materialized_utf8, remote.materialized_utf8);
    assert_eq!(plan.observed_baseline.state.version, revision("observed"));
    assert_eq!(plan.authored.next_state.version, req.next_version);
    assert_eq!(
        plan_external_text_with_baseline(
            &remote.next_state,
            &baseline,
            &[0xff],
            &req,
            &revision("invalid")
        )
        .unwrap_err(),
        SyncError::InvalidEdit
    );
}

#[test]
fn diff_large_shared_text_preserves_utf16_character_boundaries() {
    let prefix = "前😀".repeat(MAX_DIFF_CHARS);
    let suffix = "終𐐷\r\n".repeat(MAX_DIFF_CHARS);
    // The differing supplementary characters share UTF-8 leading bytes.
    let old = format!("{prefix}A😀B{suffix}");
    let new = format!("{prefix}A𐐷B{suffix}");
    let index = prefix.encode_utf16().count() as u32 + 1;
    let edits = diff_edits(&old, &new).unwrap();
    assert_eq!(
        edits,
        vec![
            TextEdit::Delete { index, length: 2 },
            TextEdit::Insert {
                index,
                text: "𐐷".into()
            },
        ]
    );
    let replica = TextReplica::new(1);
    replica.insert(0, &old).unwrap();
    replica.edit(&edits).unwrap();
    assert_eq!(replica.text(), new);
}

#[test]
fn diff_large_changed_middle_uses_bounded_unicode_replacement() {
    let prefix = "前😀";
    let suffix = "é\r\n";
    let old_middle = "😀".repeat(MAX_DIFF_CHARS + 1);
    let new_middle = "𐐷".repeat(MAX_DIFF_CHARS + 1);
    let old = format!("{prefix}{old_middle}{suffix}");
    let new = format!("{prefix}{new_middle}{suffix}");
    let edits = diff_edits(&old, &new).unwrap();
    assert_eq!(
        edits,
        vec![
            TextEdit::Delete {
                index: 3,
                length: 2 * (MAX_DIFF_CHARS as u32 + 1),
            },
            TextEdit::Insert {
                index: 3,
                text: new_middle
            },
        ]
    );
    let replica = TextReplica::new(1);
    replica.insert(0, &old).unwrap();
    replica.edit(&edits).unwrap();
    assert_eq!(replica.text(), new);
}

#[test]
fn replace_large_text_keeps_identity_exact_bytes_and_replication() {
    let initial = empty();
    let wanted = format!("\u{feff}{}", "😀x\r\n".repeat(MAX_DIFF_CHARS / 2));
    let created = plan_replace_text(
        &initial,
        wanted.as_bytes(),
        &request(&initial, "large-created", actor(1, "a"), vec![]),
    )
    .unwrap();
    assert_eq!(created.materialized_utf8, wanted.as_bytes());
    assert_eq!(created.next_state.identity, initial.identity);
    let wanted = format!("\u{feff}{}", "𐐷y\r\n".repeat(MAX_DIFF_CHARS / 2));
    let updated = plan_replace_text(
        &created.next_state,
        wanted.as_bytes(),
        &request(&created.next_state, "large-updated", actor(1, "a"), vec![]),
    )
    .unwrap();
    assert_eq!(updated.materialized_utf8, wanted.as_bytes());
    assert_eq!(updated.next_state.identity, initial.identity);
    let peer = receive(&initial, &authored(&created), "large-peer-created")
        .next_state
        .unwrap();
    let peer = receive(&peer, &authored(&updated), "large-peer-updated")
        .next_state
        .unwrap();
    assert_eq!(peer.materialized_utf8().unwrap(), wanted.as_bytes());
}

#[test]
fn external_large_shared_text_retains_remote_edit_between_small_hunks() {
    let prefix = "前😀".repeat(MAX_DIFF_CHARS);
    let suffix = "終𐐷".repeat(MAX_DIFF_CHARS);
    let original = format!("{prefix}start 😀 center end{suffix}");
    let observed = format!("{prefix}START 😀 center END{suffix}");
    let base = seed(&original).next_state;
    let baseline = base.projection_baseline().unwrap();
    let remote = plan_authored_text(
        &base,
        &request(
            &base,
            "large-remote",
            actor(2, "remote"),
            vec![insert(prefix.encode_utf16().count() as u32 + 16, "REMOTE ")],
        ),
    )
    .unwrap();
    let imported = plan_external_text(
        &remote.next_state,
        &baseline,
        observed.as_bytes(),
        &request(
            &remote.next_state,
            "large-external",
            actor(3, "scanner"),
            vec![],
        ),
    )
    .unwrap();
    assert_eq!(
        string(&imported.next_state),
        format!("{prefix}START 😀 center REMOTE END{suffix}")
    );
    assert_eq!(imported.next_state.identity, base.identity);
    assert_eq!(imported.expected_baseline, Some(baseline));
}

#[test]
fn external_large_coarse_replacement_preserves_remote_and_physical_branch() {
    let old_middle = "a".repeat(MAX_DIFF_CHARS + 1);
    let new_middle = "b".repeat(MAX_DIFF_CHARS + 1);
    let original = format!("😀{old_middle}終\r\n");
    let observed = format!("😀{new_middle}終\r\n");
    let base = seed(&original).next_state;
    let baseline = base.projection_baseline().unwrap();
    let remote = plan_authored_text(
        &base,
        &request(
            &base,
            "coarse-remote",
            actor(2, "remote"),
            vec![
                insert(2 + MAX_DIFF_CHARS as u32 / 2, "REMOTE_MIDDLE"),
                insert(0, "REMOTE_PREFIX"),
            ],
        ),
    )
    .unwrap();
    let imported = plan_external_text_with_baseline(
        &remote.next_state,
        &baseline,
        observed.as_bytes(),
        &request(
            &remote.next_state,
            "coarse-external",
            actor(3, "scanner"),
            vec![],
        ),
        &revision("coarse-observed"),
    )
    .unwrap();
    let merged = string(&imported.authored.next_state);
    assert!(merged.contains("REMOTE_MIDDLE"));
    assert!(merged.starts_with("REMOTE_PREFIX"));
    assert_eq!(
        merged
            .replace("REMOTE_MIDDLE", "")
            .replace("REMOTE_PREFIX", ""),
        observed
    );
    assert_eq!(
        imported.observed_baseline.materialized_utf8,
        observed.as_bytes()
    );
    assert_eq!(string(&imported.observed_baseline.state), observed);
    assert_eq!(imported.authored.expected_baseline, Some(baseline));
    assert_eq!(imported.authored.next_state.identity, base.identity);
    assert!(!imported.observed_baseline.state.actors.contains_key(&2));
    let peer = receive(&base, &authored(&imported.authored), "coarse-peer-import")
        .next_state
        .unwrap();
    let peer = receive(&peer, &authored(&remote), "coarse-peer-remote")
        .next_state
        .unwrap();
    assert_eq!(string(&peer), merged);
}

#[test]
fn diff_many_small_hunks_fall_back_without_exceeding_edit_budget() {
    let old = "ab".repeat(MAX_DIFF_CHARS / 2);
    let new = "ac".repeat(MAX_DIFF_CHARS / 2);
    // Both changed windows fit Myers, but independent delete/insert hunks
    // exceed MAX_EDITS. Keep the shared first scalar and replace the middle.
    let edits = diff_edits(&old, &new).unwrap();
    assert_eq!(
        edits,
        vec![
            TextEdit::Delete {
                index: 1,
                length: MAX_DIFF_CHARS as u32 - 1
            },
            TextEdit::Insert {
                index: 1,
                text: new[1..].into()
            },
        ]
    );
    let replica = TextReplica::new(1);
    replica.insert(0, &old).unwrap();
    replica.edit(&edits).unwrap();
    assert_eq!(replica.text(), new);
}
