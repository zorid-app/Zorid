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
