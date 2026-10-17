use super::*;
use zorid_crypto::{CryptoError, EntropySource};
use zorid_sync_protocol::Header;

struct Entropy(u8);
impl EntropySource for Entropy {
    fn fill(&mut self, out: &mut [u8]) -> std::result::Result<(), CryptoError> {
        out.fill(self.0);
        self.0 += 1;
        Ok(())
    }
}
fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn empty() -> TextState {
    TextState::empty(
        TextIdentity {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
            entry_id: EntryId::new("entry").unwrap(),
            bootstrap_id: id("original-text-bootstrap"),
        },
        rev("initial"),
    )
}
fn context(parents: &[&str]) -> TextNamespaceContext {
    TextNamespaceContext {
        bootstrap_id: id("namespace-bootstrap"),
        parents: parents.iter().map(|s| id(s)).collect(),
    }
}
fn request(state: &TextState, name: &str, actor: u32, edits: Vec<Edit>) -> AuthorRequest {
    AuthorRequest {
        expected_version: state.version.clone(),
        next_version: rev(name),
        update_id: id(name),
        actor: ActorRegistration {
            actor,
            owner: ActorOwner {
                replica_id: DeviceId::new(format!("device-{actor}")).unwrap(),
                incarnation_id: OperationId::new("incarnation").unwrap(),
            },
        },
        edits,
    }
}
fn insert(index: u32, text: &str) -> Edit {
    Edit::Insert {
        index,
        text: text.into(),
    }
}
fn seal(bytes: &[u8], update: &UpdateId) -> Vec<u8> {
    let identity = empty().identity;
    let header = Header::new(
        identity.realm_id,
        identity.vault_id,
        update.clone(),
        DeviceId::new("sender").unwrap(),
        1,
    )
    .unwrap();
    zorid_crypto::seal(
        &header,
        bytes,
        &VaultKey::from_bytes([5; 32]),
        &mut Entropy(9),
    )
    .unwrap()
    .encode()
}
fn open(bytes: &[u8], update: &UpdateId) -> Result<AuthenticatedText> {
    let identity = empty().identity;
    AuthenticatedText::open(
        &seal(bytes, update),
        &ExpectedContext {
            realm_id: identity.realm_id,
            vault_id: identity.vault_id,
            update_id: update.clone(),
            key_epoch: 1,
        },
        &VaultKey::from_bytes([5; 32]),
    )
}
fn incoming(plan: &AuthoredTextPlan) -> AuthenticatedText {
    open(
        &plan.plan.authored.payload_bytes,
        &plan.plan.authored.update_id,
    )
    .unwrap()
}
fn receive(state: &TextState, incoming: &AuthenticatedText, name: &str) -> ReceivedPlan {
    plan_received_text(
        state,
        &ReceiveRequest {
            expected_version: state.version.clone(),
            next_version: rev(name),
            delivery: None,
        },
        incoming,
        None,
        None,
    )
    .unwrap()
}
fn restart(state: &TextState) -> TextState {
    serde_json::from_slice(&serde_json::to_vec(state).unwrap()).unwrap()
}

#[test]
fn immutable_distinct_bootstraps_and_strict_version_boundary() {
    let state = empty();
    let request = request(&state, "one", 1, vec![insert(0, "Hello 😀")]);
    let v1 = crate::plan_authored_text(&state, &request).unwrap();
    assert!(matches!(
        open(&v1.authored.payload_bytes, &request.update_id),
        Err(SyncError::UnsupportedFormat)
    ));
    let plan = plan_authored_text(&state, &request, &context(&["namespace-bootstrap"])).unwrap();
    let opened = incoming(&plan);
    assert_eq!(
        opened.identity().bootstrap_id,
        id("original-text-bootstrap")
    );
    assert_eq!(
        opened.activity().namespace().bootstrap_id,
        id("namespace-bootstrap")
    );
    assert_eq!(
        opened.activity().payload_bytes(),
        plan.plan.authored.payload_bytes
    );
    let identity = empty().identity;
    assert!(matches!(
        crate::AuthenticatedText::open(
            &seal(opened.activity().payload_bytes(), &request.update_id),
            &ExpectedContext {
                realm_id: identity.realm_id,
                vault_id: identity.vault_id,
                update_id: request.update_id.clone(),
                key_epoch: 1
            },
            &VaultKey::from_bytes([5; 32])
        ),
        Err(SyncError::UnsupportedFormat)
    ));
    let mut payload: serde_json::Value =
        serde_json::from_slice(opened.activity().payload_bytes()).unwrap();
    payload["namespace"]["invented"] = true.into();
    assert!(matches!(
        open(&serde_json::to_vec(&payload).unwrap(), &request.update_id),
        Err(SyncError::InvalidPayload)
    ));
}

#[test]
fn namespace_frontier_is_bounded_canonical_and_cannot_reference_self() {
    let state = empty();
    let request = request(&state, "update", 1, vec![]);
    let valid = plan_authored_text(&state, &request, &context(&["namespace-bootstrap"])).unwrap();
    let mut payload: serde_json::Value =
        serde_json::from_slice(&valid.plan.authored.payload_bytes).unwrap();
    for ctx in [
        context(&[]),
        context(&["z", "a"]),
        context(&["a", "a"]),
        context(&["update"]),
        TextNamespaceContext {
            bootstrap_id: id("update"),
            parents: vec![id("other")],
        },
    ] {
        payload["namespace"] = serde_json::to_value(&ctx).unwrap();
        assert!(matches!(
            open(&serde_json::to_vec(&payload).unwrap(), &request.update_id),
            Err(SyncError::InvalidPayload)
        ));
        assert!(matches!(
            plan_authored_text(&state, &request, &ctx),
            Err(SyncError::InvalidPayload)
        ));
    }
    let oversized = TextNamespaceContext {
        bootstrap_id: id("bootstrap"),
        parents: (0..=MAX_NAMESPACE_PARENTS)
            .map(|n| id(&format!("parent-{n:04}")))
            .collect(),
    };
    assert!(plan_authored_text(&state, &request, &oversized).is_err());
    payload["namespace"] = serde_json::to_value(oversized).unwrap();
    assert!(matches!(
        open(&serde_json::to_vec(&payload).unwrap(), &request.update_id),
        Err(SyncError::InvalidPayload)
    ));
}

#[test]
fn encrypted_namespace_tampering_cannot_mint_activity() {
    use zorid_sync_protocol::Envelope;
    let state = empty();
    let request = request(&state, "sealed", 1, vec![insert(0, "text")]);
    let plan = plan_authored_text(&state, &request, &context(&["namespace-bootstrap"])).unwrap();
    let plaintext = &plan.plan.authored.payload_bytes;
    let wire = seal(plaintext, &request.update_id);
    let envelope = Envelope::decode(&wire).unwrap();
    // XChaCha20 preserves plaintext/ciphertext byte offsets. Flip the ciphertext
    // covering the namespace bootstrap, keeping valid framing/header/nonce/tag.
    let at = plaintext
        .windows(b"namespace-bootstrap".len())
        .position(|part| part == b"namespace-bootstrap")
        .unwrap();
    let mut ciphertext = envelope.ciphertext().to_vec();
    ciphertext[at] ^= 1;
    let tampered = Envelope::from_parts(envelope.header_bytes(), *envelope.nonce(), &ciphertext)
        .unwrap()
        .encode();
    assert!(matches!(
        AuthenticatedText::open(
            &tampered,
            &ExpectedContext {
                realm_id: state.identity.realm_id,
                vault_id: state.identity.vault_id,
                update_id: request.update_id,
                key_epoch: 1
            },
            &VaultKey::from_bytes([5; 32])
        ),
        Err(SyncError::AuthenticationFailed)
    ));
}

#[test]
fn reverse_dependencies_restart_delete_only_and_duplicate_do_not_echo() {
    let empty = empty();
    let first = plan_authored_text(
        &empty,
        &request(&empty, "one", 1, vec![insert(0, "a😀b")]),
        &context(&["namespace-bootstrap"]),
    )
    .unwrap();
    let second = plan_authored_text(
        &first.plan.next_state,
        &request(
            &first.plan.next_state,
            "two",
            1,
            vec![Edit::Delete {
                index: 1,
                length: 2,
            }],
        ),
        &context(&["one"]),
    )
    .unwrap();
    let peer = plan_authored_text(
        &first.plan.next_state,
        &request(
            &first.plan.next_state,
            "peer",
            2,
            vec![insert(0, "remote ")],
        ),
        &context(&["one"]),
    )
    .unwrap();
    let pending = receive(&empty, &incoming(&second), "pending");
    let pending = restart(pending.next_state.as_ref().unwrap());
    assert_eq!(pending.materialized_utf8().unwrap(), b"");
    let after_first = receive(&pending, &incoming(&first), "after-first")
        .next_state
        .unwrap();
    let complete = receive(&after_first, &incoming(&peer), "complete")
        .next_state
        .unwrap();
    let other = receive(&peer.plan.next_state, &incoming(&second), "other")
        .next_state
        .unwrap();
    assert_eq!(complete.materialized_utf8().unwrap(), b"remote ab");
    assert_eq!(
        complete.materialized_utf8().unwrap(),
        other.materialized_utf8().unwrap()
    );
    let incoming = incoming(&peer);
    let record = receive(&after_first, &incoming, "record").received_record;
    let duplicate = plan_received_text(
        &complete,
        &ReceiveRequest {
            expected_version: complete.version.clone(),
            next_version: rev("unused"),
            delivery: None,
        },
        &incoming,
        Some(&record),
        None,
    )
    .unwrap();
    assert!(duplicate.next_state.is_none());
    // ReceivedPlan has only receive state/receipt/cursor; no local author intent.
    assert!(serde_json::to_value(&duplicate)
        .unwrap()
        .get("authored")
        .is_none());
}

#[test]
fn external_observation_preserves_old_namespace_and_exact_physical_witness() {
    let initial = empty();
    let seed = plan_authored_text(
        &initial,
        &request(&initial, "seed", 1, vec![insert(0, "abc")]),
        &context(&["namespace-bootstrap"]),
    )
    .unwrap();
    let physical = TextPhysicalBaseline {
        text: seed.plan.next_state.projection_baseline().unwrap(),
        namespace: context(&["seed"]),
        location: TextPhysicalLocation {
            path: VaultPath::new("old-parent/note.md").unwrap(),
            location_event: id("namespace-bootstrap"),
        },
    };
    let concurrent = plan_authored_text(
        &seed.plan.next_state,
        &request(
            &seed.plan.next_state,
            "remote",
            2,
            vec![insert(0, "remote ")],
        ),
        &context(&["moved-parent"]),
    )
    .unwrap();
    let current = &concurrent.plan.next_state;
    let req = request(current, "observed", 3, vec![]);
    let result =
        plan_external_text_with_baseline(current, &physical, b"ac", &req, &rev("observed-branch"))
            .unwrap();
    assert_eq!(result.authored.activity().namespace(), &physical.namespace);
    assert_eq!(result.observed_baseline.location, physical.location);
    assert_eq!(
        result.observed_baseline.namespace.parents,
        vec![id("observed")]
    );
    assert_eq!(result.observed_baseline.text.materialized_utf8, b"ac");
    assert_eq!(result.authored.plan.materialized_utf8, b"remote ac");
    result
        .check_preconditions(current, &physical, true)
        .unwrap();
    let mut changed = physical.clone();
    changed.location.path = VaultPath::new("new-parent/note.md").unwrap();
    assert!(matches!(
        result.check_preconditions(current, &changed, true),
        Err(SyncError::InvalidState)
    ));
    changed = physical.clone();
    changed.location.location_event = id("different-location-event");
    assert!(matches!(
        result.check_preconditions(current, &changed, true),
        Err(SyncError::InvalidState)
    ));
    changed = physical.clone();
    changed.namespace = context(&["remote"]);
    assert!(result.check_preconditions(current, &changed, true).is_err());
    let baseline: TextPhysicalBaseline =
        serde_json::from_slice(&serde_json::to_vec(result.observed_baseline()).unwrap()).unwrap();
    let second = plan_external_text_with_baseline(
        &result.authored.plan.next_state,
        &baseline,
        b"a",
        &request(&result.authored.plan.next_state, "again", 4, vec![]),
        &rev("again-branch"),
    )
    .unwrap();
    assert_eq!(second.authored.plan.materialized_utf8, b"remote a");
    assert_eq!(
        second.authored.activity().namespace().parents,
        vec![id("observed")]
    );
}

#[test]
fn plaintext_inspection_is_strict_bounded_and_only_returns_data() {
    let state = empty();
    let request = request(&state, "inspect", 1, vec![insert(0, "text")]);
    let plan = plan_authored_text(&state, &request, &context(&["namespace-bootstrap"])).unwrap();
    let bytes = &plan.plan.authored.payload_bytes;
    let metadata = inspect_payload(bytes, &request.update_id).unwrap();
    assert_eq!(metadata.identity, state.identity);
    assert_eq!(metadata.namespace, context(&["namespace-bootstrap"]));
    // Metadata is deliberately ordinary serializable data, not an activity.
    let restored: TextPayloadMetadata =
        serde_json::from_slice(&serde_json::to_vec(&metadata).unwrap()).unwrap();
    assert_eq!(restored, metadata);
    assert!(matches!(
        inspect_payload(&vec![b' '; MAX_PLAINTEXT_BYTES + 1], &request.update_id),
        Err(SyncError::TooLarge)
    ));
    for (field, value) in [
        ("format_version", serde_json::json!(1)),
        ("unexpected", serde_json::json!(true)),
        (
            "actor",
            serde_json::json!({"actor":2,"owner":{"replica_id":"other","incarnation_id":"incarnation"}}),
        ),
    ] {
        let mut changed: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        changed[field] = value;
        assert!(
            inspect_payload(&serde_json::to_vec(&changed).unwrap(), &request.update_id).is_err()
        );
    }
    assert!(inspect_payload(bytes, &id("namespace-bootstrap")).is_err());
}

#[test]
fn complete_content_distinguishes_empty_from_pending_insert_and_delete_after_restart() {
    let initial = empty();
    assert_eq!(initial.complete_materialized_utf8().unwrap(), Some(vec![]));
    let first = plan_authored_text(
        &initial,
        &request(&initial, "first", 1, vec![insert(0, "abc")]),
        &context(&["namespace-bootstrap"]),
    )
    .unwrap();
    for (name, edit, expected) in [
        ("insert", insert(3, "!"), b"abc!".as_slice()),
        (
            "delete",
            Edit::Delete {
                index: 0,
                length: 3,
            },
            b"".as_slice(),
        ),
    ] {
        let second = plan_authored_text(
            &first.plan.next_state,
            &request(&first.plan.next_state, name, 1, vec![edit]),
            &context(&["first"]),
        )
        .unwrap();
        // The update contains only the second transaction, not its predecessor.
        let pending = receive(&initial, &incoming(&second), "pending")
            .next_state
            .unwrap();
        assert_eq!(pending.materialized_utf8().unwrap(), b"");
        assert_eq!(pending.complete_materialized_utf8().unwrap(), None);
        let pending = restart(&pending);
        assert_eq!(pending.complete_materialized_utf8().unwrap(), None);
        let complete = receive(&pending, &incoming(&first), "complete")
            .next_state
            .unwrap();
        assert_eq!(
            complete.complete_materialized_utf8().unwrap(),
            Some(expected.to_vec())
        );
        assert_eq!(
            restart(&complete).complete_materialized_utf8().unwrap(),
            Some(expected.to_vec())
        );
    }
    let mut corrupt = initial;
    corrupt.snapshot = vec![255];
    assert!(corrupt.complete_materialized_utf8().is_err());
}

#[test]
fn rebind_revision_preserves_exact_causal_state_and_rejects_stale_or_invalid_state() {
    let initial = empty();
    let authored = plan_authored_text(
        &initial,
        &request(&initial, "authored", 1, vec![insert(0, "\u{feff}Hello 😀")]),
        &context(&["namespace-bootstrap"]),
    )
    .unwrap();
    for state in [&initial, &authored.plan.next_state] {
        let rebound = state
            .rebind_revision(&state.version, &rev("moved"))
            .unwrap();
        let mut expected = state.clone();
        expected.version = rev("moved");
        assert_eq!(rebound, expected);
        assert_eq!(restart(&rebound), expected);
        assert_eq!(
            rebound.materialized_utf8().unwrap(),
            state.materialized_utf8().unwrap()
        );
        assert_eq!(
            state.rebind_revision(&rev("stale"), &rev("moved")),
            Err(SyncError::VersionConflict)
        );
        assert_eq!(
            state.rebind_revision(&state.version, &state.version),
            Err(SyncError::VersionConflict)
        );
    }
    let mut corrupt = authored.plan.next_state.clone();
    corrupt.snapshot = vec![255];
    assert!(corrupt
        .rebind_revision(&corrupt.version, &rev("moved"))
        .is_err());
    let mut missing_owner = authored.plan.next_state.clone();
    missing_owner.actors.clear();
    assert_eq!(
        missing_owner.rebind_revision(&missing_owner.version, &rev("moved")),
        Err(SyncError::InvalidState)
    );
}

#[test]
fn rebind_revision_retains_pending_insert_and_delete_dependencies() {
    let initial = empty();
    let first = plan_authored_text(
        &initial,
        &request(&initial, "first", 1, vec![insert(0, "abc")]),
        &context(&["namespace-bootstrap"]),
    )
    .unwrap();
    for (name, edit, expected) in [
        ("insert", insert(3, "!"), b"abc!".as_slice()),
        (
            "delete",
            Edit::Delete {
                index: 0,
                length: 3,
            },
            b"".as_slice(),
        ),
    ] {
        let second = plan_authored_text(
            &first.plan.next_state,
            &request(&first.plan.next_state, name, 1, vec![edit]),
            &context(&["first"]),
        )
        .unwrap();
        let pending = receive(&initial, &incoming(&second), "pending")
            .next_state
            .unwrap();
        assert_eq!(pending.complete_materialized_utf8().unwrap(), None);
        let rebound = pending
            .rebind_revision(&pending.version, &rev("namespace-change"))
            .unwrap();
        assert_eq!(rebound.identity, pending.identity);
        assert_eq!(rebound.snapshot, pending.snapshot);
        assert_eq!(rebound.actors, pending.actors);
        let rebound = restart(&rebound);
        assert_eq!(rebound.complete_materialized_utf8().unwrap(), None);
        let complete = receive(&rebound, &incoming(&first), "complete")
            .next_state
            .unwrap();
        assert_eq!(
            complete.complete_materialized_utf8().unwrap(),
            Some(expected.to_vec())
        );
    }
}
