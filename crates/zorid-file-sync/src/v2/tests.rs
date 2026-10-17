use super::*;
use crate::{Liveness, Projection, RecoveryReason};
use zorid_client_sync::{ActorOwner, ActorRegistration, AuthorRequest, Edit, TextState};
use zorid_crypto::{CryptoError, EntropySource};
use zorid_sync_protocol::{DeviceId, Header, RealmId, VaultId};
fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn entry(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn empty() -> State {
    State::empty(scope(), rev("initial"))
}
fn location(name: &str) -> Location {
    Location {
        parent: None,
        name: name.into(),
    }
}
fn identity() -> EntryIdentity {
    EntryIdentity {
        entry_id: entry("note"),
        bootstrap_id: id("namespace-create"),
    }
}
fn event(name: &str, parents: &[&str], effect: Effect) -> EntryEvent {
    EntryEvent {
        id: id(name),
        identity: identity(),
        parents: parents.iter().map(|p| id(p)).collect(),
        effect,
    }
}
fn create() -> EntryEvent {
    event(
        "namespace-create",
        &[],
        Effect::Create {
            entry_kind: EntryKind::File,
            location: location("note.md"),
            content: Some(ContentSeed::Text {
                text_bootstrap_id: id("legacy-text-bootstrap"),
                text_format: 2,
            }),
        },
    )
}
fn payload(event: EntryEvent) -> Payload {
    Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: event.id.clone(),
        body: Body::Events {
            events: vec![event],
        },
    }
}
struct Entropy;
impl EntropySource for Entropy {
    fn fill(&mut self, b: &mut [u8]) -> std::result::Result<(), CryptoError> {
        b.fill(7);
        Ok(())
    }
}
fn received(p: &Payload) -> AuthenticatedPayload {
    let h = Header::new(
        p.scope.realm_id.clone(),
        p.scope.vault_id.clone(),
        p.id.clone(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let k = VaultKey::from_bytes([9; 32]);
    let wire = zorid_crypto::seal(&h, &p.encode().unwrap(), &k, &mut Entropy)
        .unwrap()
        .encode();
    AuthenticatedPayload::open(
        &wire,
        &ExpectedContext {
            realm_id: p.scope.realm_id.clone(),
            vault_id: p.scope.vault_id.clone(),
            update_id: p.id.clone(),
            key_epoch: 1,
        },
        &k,
    )
    .unwrap()
}
fn apply(state: &State, event: EntryEvent) -> State {
    let p = payload(event);
    plan_received(
        state,
        &received(&p),
        None,
        rev(&format!("next-{}", p.id.as_str())),
    )
    .unwrap()
    .graph
    .next_state
    .unwrap()
}
fn activity(name: &str, parents: &[&str], text: &str) -> zorid_client_sync::v2::AuthoredTextPlan {
    let state = TextState::empty(
        TextIdentity {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            entry_id: entry("note"),
            bootstrap_id: id("legacy-text-bootstrap"),
        },
        rev("text-base"),
    );
    let request = AuthorRequest {
        expected_version: state.version.clone(),
        next_version: rev(name),
        update_id: id(name),
        actor: ActorRegistration {
            actor: 17,
            owner: ActorOwner {
                replica_id: DeviceId::new("device").unwrap(),
                incarnation_id: zorid_core::OperationId::new("incarnation").unwrap(),
            },
        },
        edits: vec![Edit::Insert {
            index: 0,
            text: text.into(),
        }],
    };
    zorid_client_sync::v2::plan_authored_text(
        &state,
        &request,
        &zorid_client_sync::v2::TextNamespaceContext {
            bootstrap_id: id("namespace-create"),
            parents: parents.iter().map(|p| id(p)).collect(),
        },
    )
    .unwrap()
}
fn add_activity(state: &State, a: &zorid_client_sync::v2::AuthoredTextPlan) -> State {
    plan_received_text_activity(
        state,
        a.activity(),
        rev(&format!("graph-{}", a.activity().update_id().as_str())),
    )
    .unwrap()
    .next_state
    .unwrap()
}
fn restart(state: &State) -> State {
    let decoded: State = serde_json::from_slice(&serde_json::to_vec(state).unwrap()).unwrap();
    State::from_records(
        decoded.scope,
        decoded.version,
        decoded.records,
        decoded.activities,
    )
    .unwrap()
}
#[test]
fn concurrent_delete_edit_both_orders_retain_activity_and_explicit_restore() {
    let base = apply(&empty(), create());
    let edit = activity("edit", &["namespace-create"], "unique text");
    let delete = event("delete", &["namespace-create"], Effect::Delete);
    let a = restart(&add_activity(&apply(&base, delete.clone()), &edit));
    let b = restart(&apply(&add_activity(&base, &edit), delete));
    assert_eq!(a.view().unwrap(), b.view().unwrap());
    let v = a.view().unwrap();
    let row = &v.namespace.entries[&entry("note")];
    assert_eq!(row.liveness, Liveness::DeleteConflict);
    assert!(row.contents.is_empty());
    assert!(matches!(
        row.projection,
        Projection::Recovery {
            reason: RecoveryReason::DeleteConflict,
            ..
        }
    ));
    assert_eq!(row.heads, vec![id("delete"), id("edit")]);
    assert_eq!(
        a.activities()[&id("edit")].payload_digest(),
        &Sha256Digest::of(edit.activity().payload_bytes())
    );
    let restored = apply(
        &a,
        event(
            "restore",
            &["delete", "edit"],
            Effect::Restore {
                location: location("restored.md"),
            },
        ),
    );
    assert!(
        matches!(&restored.view().unwrap().namespace.entries[&entry("note")].projection,Projection::Normal {path} if path.as_str()=="restored.md")
    );
    assert_eq!(restored.activities(), a.activities());
    let deleted = apply(
        &add_activity(&base, &edit),
        event("observed-delete", &["edit"], Effect::Delete),
    );
    assert_eq!(
        deleted.view().unwrap().namespace.entries[&entry("note")].liveness,
        Liveness::Deleted
    );
    let forbidden = activity("after-delete", &["observed-delete"], "must restore");
    assert_eq!(
        plan_received_text_activity(&deleted, forbidden.activity(), rev("rejected")).unwrap_err(),
        Error::InvalidCausality
    );
}
#[test]
fn move_edit_orders_preserve_location_and_independent_bootstrap() {
    let base = apply(&empty(), create());
    let edit = activity("edit", &["namespace-create"], "new text");
    let moved = event(
        "move",
        &["namespace-create"],
        Effect::Move {
            location: location("moved.md"),
        },
    );
    let a = add_activity(&apply(&base, moved.clone()), &edit);
    let b = apply(&add_activity(&base, &edit), moved);
    assert_eq!(a.view().unwrap(), b.view().unwrap());
    let view = a.view().unwrap();
    assert!(
        matches!(&view.namespace.entries[&entry("note")].projection,Projection::Normal {path} if path.as_str()=="moved.md")
    );
    assert_eq!(
        view.content_bindings[&entry("note")],
        ContentBinding::Text {
            text_bootstrap_id: id("legacy-text-bootstrap"),
            text_format: 2
        }
    );
}
#[test]
fn unknown_create_and_frontier_are_pending_after_restart_not_guessed() {
    let edit = activity("edit", &["move"], "pending");
    let pending = restart(&add_activity(&empty(), &edit));
    assert!(pending.view().unwrap().namespace.entries.is_empty());
    assert!(pending
        .view()
        .unwrap()
        .namespace
        .pending
        .contains(&id("edit")));
    assert_eq!(
        plan_authored_text_activity(&empty(), edit.activity(), rev("bad")).unwrap_err(),
        Error::InvalidCausality
    );
    let with_create = apply(&pending, create());
    assert!(with_create
        .view()
        .unwrap()
        .namespace
        .pending
        .contains(&id("edit")));
    let done = apply(
        &with_create,
        event(
            "move",
            &["namespace-create"],
            Effect::Move {
                location: location("found.md"),
            },
        ),
    );
    assert!(done.view().unwrap().namespace.pending.is_empty());
    assert_eq!(
        done.view().unwrap().namespace.entries[&entry("note")].heads,
        vec![id("edit")]
    );
}
#[test]
fn mode_bootstrap_antichain_and_global_id_collisions_fail_closed() {
    let base = apply(&empty(), create());
    let edit = activity("edit", &["namespace-create"], "a");
    let state = add_activity(&base, &edit);
    let different = activity("edit", &["namespace-create"], "b");
    assert_eq!(
        plan_received_text_activity(&state, different.activity(), rev("another")).unwrap_err(),
        Error::DuplicateMismatch
    );
    assert!(
        plan_received_text_activity(&state, edit.activity(), state.version().clone())
            .unwrap()
            .next_state
            .is_none()
    );
    let binary = payload(event(
        "binary",
        &["namespace-create"],
        Effect::SetContent {
            content: Manifest {
                bytes: 0,
                digest: Sha256Digest::of(&[]),
                pages: vec![],
            },
        },
    ));
    assert_eq!(
        plan_authored(&base, &binary, rev("bad")).unwrap_err(),
        Error::InvalidContent
    );
    let redundant = activity("redundant", &["edit", "namespace-create"], "c");
    assert_eq!(
        plan_received_text_activity(&state, redundant.activity(), rev("bad")).unwrap_err(),
        Error::InvalidCausality
    );
    let collision = Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("edit"),
        body: Body::Chunk { bytes: vec![1] },
    };
    assert_eq!(
        plan_authored(&state, &collision, rev("bad")).unwrap_err(),
        Error::DuplicateMismatch
    );
    let embedded = payload(event(
        "edit",
        &["namespace-create"],
        Effect::Move {
            location: location("x"),
        },
    ));
    assert_eq!(
        plan_authored(&state, &embedded, rev("bad")).unwrap_err(),
        Error::DuplicateMismatch
    );
    let mut wrong = create();
    if let Effect::Create {
        content: Some(ContentSeed::Text {
            text_bootstrap_id, ..
        }),
        ..
    } = &mut wrong.effect
    {
        *text_bootstrap_id = id("different-text");
    }
    let wrong_base = apply(&empty(), wrong);
    assert_eq!(
        plan_received_text_activity(&wrong_base, edit.activity(), rev("bad")).unwrap_err(),
        Error::IdentityMismatch
    );
    let mut foreign = create();
    foreign.identity.entry_id = entry("other");
    foreign.identity.bootstrap_id = id("other-create");
    foreign.id = id("other-create");
    assert_eq!(
        plan_authored(&base, &payload(foreign), rev("bad")).unwrap_err(),
        Error::IdentityMismatch
    );
}
#[test]
fn v1_and_v2_remain_explicit_and_raw_text_activity_is_not_a_file_payload() {
    let p = payload(create());
    let bytes = p.encode().unwrap();
    assert_eq!(
        crate::Payload::decode(&bytes).unwrap_err(),
        Error::UnsupportedFormat
    );
    let mut value = serde_json::to_value(&p).unwrap();
    value["format_version"] = serde_json::json!(1);
    assert_eq!(
        Payload::decode(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        Error::UnsupportedFormat
    );
    value["format_version"] = serde_json::json!(2);
    value["body"]["events"][0]["effect"] = serde_json::json!({"kind":"text_activity"});
    assert_eq!(
        Payload::decode(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
        Error::InvalidPayload
    );
}

#[test]
fn authenticated_text_event_is_same_id_and_never_emits_a_file_payload() {
    let base = apply(&empty(), create());
    let authored = activity(
        "authenticated-edit",
        &["namespace-create"],
        "encrypted content",
    );
    let a = authored.activity();
    let k = VaultKey::from_bytes([9; 32]);
    let header = Header::new(
        scope().realm_id,
        scope().vault_id,
        a.update_id().clone(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(&header, a.payload_bytes(), &k, &mut Entropy)
        .unwrap()
        .encode();
    let expected = ExpectedContext {
        realm_id: scope().realm_id,
        vault_id: scope().vault_id,
        update_id: a.update_id().clone(),
        key_epoch: 1,
    };
    let remote = zorid_client_sync::v2::AuthenticatedText::open(&wire, &expected, &k).unwrap();
    let received =
        plan_received_text_activity(&base, remote.activity(), rev("shared-version")).unwrap();
    let local = plan_authored_text_activity(&base, a, rev("shared-version")).unwrap();
    assert_eq!(received, local);
    let next = received.next_state.unwrap();
    assert_eq!(next.records(), base.records());
    assert_eq!(next.activities().len(), 1);
    assert_eq!(
        next.view().unwrap().namespace.entries[&entry("note")].heads,
        vec![a.update_id().clone()]
    );
    assert_eq!(remote.update_id(), a.update_id());
    assert!(matches!(
        AuthenticatedPayload::from_opened(&OpenedEnvelope::open(&wire, &expected, &k).unwrap()),
        Err(Error::UnsupportedFormat)
    ));
}

#[test]
fn pending_cycles_and_trusted_storage_binding_corruption_reject() {
    let pending_edit = activity("edit", &["move"], "waiting");
    let pending = add_activity(&empty(), &pending_edit);
    let cycle = payload(event(
        "move",
        &["edit"],
        Effect::Move {
            location: location("cycle.md"),
        },
    ));
    assert_eq!(
        plan_received(&pending, &received(&cycle), None, rev("cycle")).unwrap_err(),
        Error::InvalidCausality
    );
    let base = apply(&empty(), create());
    let mut wrong = StoredActivity::from_activity(pending_edit.activity()).unwrap();
    wrong.identity.bootstrap_id = id("wrong-text-bootstrap");
    assert_eq!(
        State::from_records(
            base.scope.clone(),
            rev("bad"),
            base.records.clone(),
            BTreeMap::from([(wrong.update_id.clone(), wrong)])
        )
        .unwrap_err(),
        Error::IdentityMismatch
    );
    let mut malformed = StoredActivity::from_activity(pending_edit.activity()).unwrap();
    malformed.namespace.parents = vec![id("z"), id("a")];
    assert_eq!(
        State::from_records(
            scope(),
            rev("bad"),
            BTreeMap::new(),
            BTreeMap::from([(malformed.update_id.clone(), malformed)])
        )
        .unwrap_err(),
        Error::InvalidCausality
    );
}

#[test]
fn embedded_event_payload_collisions_and_binary_wrong_kind_references_reject() {
    let mut created = payload(create());
    created.id = id("create-record");
    let state = plan_received(&empty(), &received(&created), None, rev("created"))
        .unwrap()
        .graph
        .next_state
        .unwrap();
    // The Create event ID is occupied even though its envelope has another ID.
    let chunk = Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("namespace-create"),
        body: Body::Chunk { bytes: vec![1] },
    };
    assert_eq!(
        plan_received(&state, &received(&chunk), None, rev("collision")).unwrap_err(),
        Error::DuplicateMismatch
    );
    let binary_event = EntryEvent {
        id: id("binary-create"),
        identity: EntryIdentity {
            entry_id: entry("binary"),
            bootstrap_id: id("binary-create"),
        },
        parents: vec![],
        effect: Effect::Create {
            entry_kind: EntryKind::File,
            location: location("binary.dat"),
            content: Some(ContentSeed::Binary {
                manifest: Manifest {
                    bytes: 1,
                    digest: Sha256Digest::of(&[1]),
                    pages: vec![crate::PageRef {
                        id: id("create-record"),
                        bytes: 1,
                        digest: Sha256Digest::of(&[1]),
                    }],
                },
            }),
        },
    };
    assert_eq!(
        plan_received(
            &state,
            &received(&payload(binary_event)),
            None,
            rev("wrong-kind")
        )
        .unwrap_err(),
        Error::InvalidContent
    );
}

#[test]
fn v2_binary_heads_remain_authoritative_after_set_content() {
    let empty_manifest = Manifest {
        bytes: 0,
        digest: Sha256Digest::of(&[]),
        pages: vec![],
    };
    let mut file = create();
    file.effect = Effect::Create {
        entry_kind: EntryKind::File,
        location: location("binary.dat"),
        content: Some(ContentSeed::Binary {
            manifest: empty_manifest.clone(),
        }),
    };
    let base = apply(&empty(), file);
    let next = apply(
        &base,
        event(
            "write",
            &["namespace-create"],
            Effect::SetContent {
                content: empty_manifest.clone(),
            },
        ),
    );
    let view = next.view().unwrap();
    assert_eq!(
        view.content_bindings[&entry("note")],
        ContentBinding::Binary
    );
    assert_eq!(
        view.namespace.entries[&entry("note")].contents[0].event,
        id("write")
    );
    assert_eq!(next.materialize(&empty_manifest).unwrap(), Some(vec![]));
    let p = payload(event(
        "move",
        &["write"],
        Effect::Move {
            location: location("moved.bin"),
        },
    ));
    let incoming = received(&p);
    let plan = plan_received(&next, &incoming, None, rev("moved")).unwrap();
    let actual = plan.graph.next_state.unwrap();
    let replay = plan_received(
        &actual,
        &incoming,
        Some(incoming.record()),
        actual.version().clone(),
    )
    .unwrap();
    assert!(replay.graph.next_state.is_none());
    assert!(replay
        .check_preconditions(&actual, Some(incoming.record()))
        .is_ok());
    assert_eq!(
        replay
            .check_preconditions(&next, Some(incoming.record()))
            .unwrap_err(),
        Error::VersionConflict
    );
}

#[test]
fn reserved_roles_reject_impossible_dependencies_in_both_delivery_orders() {
    let mut create_record = payload(create());
    create_record.id = id("container");
    let with_create = plan_received(&empty(), &received(&create_record), None, rev("created"))
        .unwrap()
        .graph
        .next_state
        .unwrap();
    for reserved in ["namespace-create", "legacy-text-bootstrap"] {
        let page = Payload {
            family: Family::Files,
            format_version: 2,
            scope: scope(),
            id: id("page"),
            body: Body::Page {
                page: crate::ChunkPage {
                    chunks: vec![crate::ChunkRef {
                        id: id(reserved),
                        bytes: 1,
                        digest: Sha256Digest::of(&[1]),
                    }],
                },
            },
        };
        assert_eq!(
            plan_received(&with_create, &received(&page), None, rev("bad")).unwrap_err(),
            Error::InvalidContent
        );
        let early = plan_received(&empty(), &received(&page), None, rev("early"))
            .unwrap()
            .graph
            .next_state
            .unwrap();
        assert_eq!(
            plan_received(&early, &received(&create_record), None, rev("bad")).unwrap_err(),
            Error::InvalidContent
        );
        let ordinary = payload(event(
            reserved,
            &["missing"],
            Effect::Move {
                location: location("bad.md"),
            },
        ));
        // Namespace root cannot be used by a non-Create even before graph lookup.
        if reserved == "namespace-create" {
            assert_eq!(ordinary.encode().unwrap_err(), Error::InvalidCausality);
        } else {
            assert_eq!(
                plan_received(&with_create, &received(&ordinary), None, rev("bad")).unwrap_err(),
                Error::IdentityMismatch
            );
            let early = plan_received(&empty(), &received(&ordinary), None, rev("early"))
                .unwrap()
                .graph
                .next_state
                .unwrap();
            assert_eq!(
                plan_received(&early, &received(&create_record), None, rev("bad")).unwrap_err(),
                Error::IdentityMismatch
            );
        }
    }
    let chunk = Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("not-event"),
        body: Body::Chunk { bytes: vec![1] },
    };
    let child = payload(event(
        "child",
        &["not-event"],
        Effect::Move {
            location: location("child.md"),
        },
    ));
    let chunks = plan_received(&empty(), &received(&chunk), None, rev("chunk"))
        .unwrap()
        .graph
        .next_state
        .unwrap();
    assert_eq!(
        plan_received(&chunks, &received(&child), None, rev("bad")).unwrap_err(),
        Error::InvalidCausality
    );
    let children = plan_received(&empty(), &received(&child), None, rev("child"))
        .unwrap()
        .graph
        .next_state
        .unwrap();
    assert_eq!(
        plan_received(&children, &received(&chunk), None, rev("bad")).unwrap_err(),
        Error::InvalidCausality
    );
    let parent_container = payload(event(
        "uses-container",
        &["container"],
        Effect::Move {
            location: location("bad.md"),
        },
    ));
    assert_eq!(
        plan_received(&with_create, &received(&parent_container), None, rev("bad")).unwrap_err(),
        Error::InvalidCausality
    );
}

#[test]
fn pending_binary_and_text_activity_contradict_before_create_in_both_orders() {
    let text = activity("text", &["missing"], "retained");
    let binary = payload(event(
        "binary",
        &["missing"],
        Effect::SetContent {
            content: Manifest {
                bytes: 0,
                digest: Sha256Digest::of(&[]),
                pages: vec![],
            },
        },
    ));
    let text_first = add_activity(&empty(), &text);
    assert_eq!(
        plan_received(&text_first, &received(&binary), None, rev("bad")).unwrap_err(),
        Error::InvalidContent
    );
    let binary_first = plan_received(&empty(), &received(&binary), None, rev("binary"))
        .unwrap()
        .graph
        .next_state
        .unwrap();
    assert_eq!(
        plan_received_text_activity(&binary_first, text.activity(), rev("bad")).unwrap_err(),
        Error::InvalidContent
    );
}

#[test]
fn mutually_incompatible_missing_roles_cannot_become_permanent_pending_work() {
    let manifest = Manifest {
        bytes: 1,
        digest: Sha256Digest::of(&[1]),
        pages: vec![crate::PageRef {
            id: id("missing"),
            bytes: 1,
            digest: Sha256Digest::of(&[1]),
        }],
    };
    let mut file = create();
    file.effect = Effect::Create {
        entry_kind: EntryKind::File,
        location: location("binary.dat"),
        content: Some(ContentSeed::Binary { manifest }),
    };
    let file = payload(file);
    let page = Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("page"),
        body: Body::Page {
            page: crate::ChunkPage {
                chunks: vec![crate::ChunkRef {
                    id: id("missing"),
                    bytes: 1,
                    digest: Sha256Digest::of(&[1]),
                }],
            },
        },
    };
    let parent = payload(event(
        "move",
        &["missing"],
        Effect::Move {
            location: location("pending.md"),
        },
    ));
    for other in [page, parent] {
        for (first, second) in [(&file, &other), (&other, &file)] {
            let early = plan_received(&empty(), &received(first), None, rev("first"))
                .unwrap()
                .graph
                .next_state
                .unwrap();
            assert_eq!(
                plan_received(&early, &received(second), None, rev("second")).unwrap_err(),
                Error::InvalidContent
            );
        }
    }
    let mut one = event("one", &["shared-parent"], Effect::Delete);
    one.identity = EntryIdentity {
        entry_id: entry("one"),
        bootstrap_id: id("one-create"),
    };
    let mut two = event("two", &["shared-parent"], Effect::Delete);
    two.identity = EntryIdentity {
        entry_id: entry("two"),
        bootstrap_id: id("two-create"),
    };
    let early = apply(&empty(), one);
    assert_eq!(
        plan_received(&early, &received(&payload(two)), None, rev("bad")).unwrap_err(),
        Error::IdentityMismatch
    );
}

#[test]
fn missing_reference_digest_and_size_promises_are_immutable_in_both_orders() {
    for unequal_size in [false, true] {
        let first_ref = crate::ChunkRef {
            id: id("missing-chunk"),
            bytes: 1,
            digest: Sha256Digest::of(&[1]),
        };
        let mut second_ref = first_ref.clone();
        if unequal_size {
            second_ref.bytes = 2;
        } else {
            second_ref.digest = Sha256Digest::of(&[2]);
        }
        let chunk_pages: Vec<_> = [first_ref, second_ref]
            .into_iter()
            .enumerate()
            .map(|(i, r)| Payload {
                family: Family::Files,
                format_version: 2,
                scope: scope(),
                id: id(&format!("chunk-page-{i}")),
                body: Body::Page {
                    page: crate::ChunkPage { chunks: vec![r] },
                },
            })
            .collect();
        for (first, second) in [
            (&chunk_pages[0], &chunk_pages[1]),
            (&chunk_pages[1], &chunk_pages[0]),
        ] {
            let early = plan_received(&empty(), &received(first), None, rev("early"))
                .unwrap()
                .graph
                .next_state
                .unwrap();
            assert_eq!(
                plan_received(&early, &received(second), None, rev("bad")).unwrap_err(),
                Error::InvalidContent
            );
        }
        let first_ref = crate::PageRef {
            id: id("missing-page"),
            bytes: 1,
            digest: Sha256Digest::of(&[1]),
        };
        let mut second_ref = first_ref.clone();
        if unequal_size {
            second_ref.bytes = 2;
        } else {
            second_ref.digest = Sha256Digest::of(&[2]);
        }
        let files: Vec<_> = [first_ref, second_ref]
            .into_iter()
            .enumerate()
            .map(|(i, r)| {
                let name = format!("file-{i}");
                payload(EntryEvent {
                    id: id(&name),
                    identity: EntryIdentity {
                        entry_id: entry(&name),
                        bootstrap_id: id(&name),
                    },
                    parents: vec![],
                    effect: Effect::Create {
                        entry_kind: EntryKind::File,
                        location: location(&name),
                        content: Some(ContentSeed::Binary {
                            manifest: Manifest {
                                bytes: r.bytes,
                                digest: Sha256Digest::of(&[1]),
                                pages: vec![r],
                            },
                        }),
                    },
                })
            })
            .collect();
        for (first, second) in [(&files[0], &files[1]), (&files[1], &files[0])] {
            let early = plan_received(&empty(), &received(first), None, rev("early"))
                .unwrap()
                .graph
                .next_state
                .unwrap();
            assert_eq!(
                plan_received(&early, &received(second), None, rev("bad")).unwrap_err(),
                Error::InvalidContent
            );
        }
    }
}

#[test]
fn orphan_page_reference_checks_existing_chunk_bytes_before_any_manifest() {
    let chunk = Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("chunk"),
        body: Body::Chunk { bytes: vec![1] },
    };
    let page = Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("page"),
        body: Body::Page {
            page: crate::ChunkPage {
                chunks: vec![crate::ChunkRef {
                    id: id("chunk"),
                    bytes: 1,
                    digest: Sha256Digest::of(&[2]),
                }],
            },
        },
    };
    for (first, second) in [(&chunk, &page), (&page, &chunk)] {
        let early = plan_received(&empty(), &received(first), None, rev("early"))
            .unwrap()
            .graph
            .next_state
            .unwrap();
        assert_eq!(
            plan_received(&early, &received(second), None, rev("bad")).unwrap_err(),
            Error::InvalidContent
        );
    }
}

#[test]
fn authenticated_file_exposes_original_plaintext_without_canonicalizing() {
    let payload = payload(create());
    let raw = serde_json::to_vec_pretty(&payload).unwrap();
    assert_ne!(raw, payload.encode().unwrap());
    let key = VaultKey::from_bytes([9; 32]);
    let header = Header::new(
        scope().realm_id,
        scope().vault_id,
        payload.id.clone(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(&header, &raw, &key, &mut Entropy)
        .unwrap()
        .encode();
    let expected = ExpectedContext {
        realm_id: scope().realm_id,
        vault_id: scope().vault_id,
        update_id: payload.id.clone(),
        key_epoch: 1,
    };
    let opened = AuthenticatedPayload::open(&wire, &expected, &key).unwrap();
    assert_eq!(opened.payload_bytes(), raw);
    assert_eq!(opened.payload(), &payload);
    assert_eq!(opened.record().exact_wire, wire);
}

#[test]
fn physical_move_frontier_preserves_incomparable_published_text_without_latest_heads() {
    let base = apply(&empty(), create());
    let old_edit = activity("edit", &["namespace-create"], "published bytes");
    let moved = event(
        "move",
        &["namespace-create"],
        Effect::Move {
            location: location("moved.md"),
        },
    );
    let a = apply(&add_activity(&base, &old_edit), moved.clone());
    let b = add_activity(&apply(&base, moved), &old_edit);
    for state in [a, b] {
        let unpublished = activity("unpublished", &["edit", "move"], "newer remote bytes");
        let state = restart(&add_activity(&state, &unpublished));
        assert_eq!(
            state.view().unwrap().namespace.entries[&entry("note")].heads,
            vec![id("unpublished")]
        );
        assert_eq!(
            state
                .join_physical_move_frontier(&identity(), &[id("edit")], &id("move"))
                .unwrap(),
            vec![id("edit"), id("move")]
        );
        // The semantic join does not mutate any stored activity, version or graph.
        assert_eq!(restart(&state), state);
    }
}
#[test]
fn physical_move_frontier_drops_dominated_heads_and_is_idempotent() {
    let base = add_activity(
        &apply(&empty(), create()),
        &activity("edit", &["namespace-create"], "published"),
    );
    let moved = apply(
        &base,
        event(
            "move",
            &["edit"],
            Effect::Move {
                location: location("new.md"),
            },
        ),
    );
    assert_eq!(
        moved
            .join_physical_move_frontier(&identity(), &[id("edit")], &id("move"))
            .unwrap(),
        vec![id("move")]
    );
    assert_eq!(
        moved
            .join_physical_move_frontier(&identity(), &[id("move")], &id("move"))
            .unwrap(),
        vec![id("move")]
    );
    // A retained physical head may already causally include this Move.
    let later = add_activity(&moved, &activity("later", &["move"], "later published"));
    assert_eq!(
        later
            .join_physical_move_frontier(&identity(), &[id("later")], &id("move"))
            .unwrap(),
        vec![id("later")]
    );
}
#[test]
fn physical_move_frontier_rejects_noncanonical_pending_and_wrong_entry_inputs() {
    let base = apply(&empty(), create());
    let state = apply(
        &base,
        event(
            "move",
            &["namespace-create"],
            Effect::Move {
                location: location("new.md"),
            },
        ),
    );
    for prior in [
        vec![],
        vec![id("move"), id("move")],
        vec![id("namespace-create"), id("move")],
        vec![id("move"), id("namespace-create")],
        vec![id("absent")],
    ] {
        assert!(state
            .join_physical_move_frontier(&identity(), &prior, &id("move"))
            .is_err());
    }
    let mut wrong = identity();
    wrong.bootstrap_id = id("other-bootstrap");
    assert_eq!(
        state
            .join_physical_move_frontier(&wrong, &[id("namespace-create")], &id("move"))
            .unwrap_err(),
        Error::IdentityMismatch
    );
    assert!(state
        .join_physical_move_frontier(
            &identity(),
            &[id("namespace-create")],
            &id("namespace-create")
        )
        .is_err());
    let pending = apply(
        &state,
        event(
            "pending-move",
            &["missing"],
            Effect::Move {
                location: location("pending.md"),
            },
        ),
    );
    assert!(pending
        .join_physical_move_frontier(&identity(), &[id("move")], &id("pending-move"))
        .is_err());
    assert!(pending
        .join_physical_move_frontier(&identity(), &[id("pending-move")], &id("move"))
        .is_err());
    let deleted = apply(&state, event("delete", &["move"], Effect::Delete));
    let restored = apply(
        &deleted,
        event(
            "restore",
            &["delete"],
            Effect::Restore {
                location: location("restored.md"),
            },
        ),
    );
    assert!(restored
        .join_physical_move_frontier(&identity(), &[id("move")], &id("restore"))
        .is_err());
}
#[test]
fn ancestor_folder_move_cannot_enter_child_physical_frontier() {
    let folder_identity = EntryIdentity {
        entry_id: entry("folder"),
        bootstrap_id: id("folder-create"),
    };
    let folder_create = EntryEvent {
        id: id("folder-create"),
        identity: folder_identity.clone(),
        parents: vec![],
        effect: Effect::Create {
            entry_kind: EntryKind::Folder,
            location: location("folder"),
            content: None,
        },
    };
    let mut child = create();
    if let Effect::Create { location, .. } = &mut child.effect {
        location.parent = Some(entry("folder"));
    }
    let base = apply(&apply(&empty(), folder_create), child);
    let moved = apply(
        &base,
        EntryEvent {
            id: id("folder-move"),
            identity: folder_identity.clone(),
            parents: vec![id("folder-create")],
            effect: Effect::Move {
                location: location("new-folder"),
            },
        },
    );
    assert_eq!(
        moved
            .join_physical_move_frontier(&identity(), &[id("namespace-create")], &id("folder-move"))
            .unwrap_err(),
        Error::IdentityMismatch
    );
    assert_eq!(
        moved
            .join_physical_move_frontier(
                &folder_identity,
                &[id("folder-create")],
                &id("folder-move")
            )
            .unwrap(),
        vec![id("folder-move")]
    );
    assert_eq!(
        moved.view().unwrap().namespace.entries[&entry("note")].heads,
        vec![id("namespace-create")]
    );
}
#[test]
fn physical_move_frontier_bounds_the_result_and_can_collapse_a_full_frontier() {
    let mut records = BTreeMap::new();
    let root = payload(create());
    records.insert(root.id.clone(), root);
    let mut heads = Vec::new();
    for index in 0..crate::MAX_PARENTS {
        let name = format!("head-{index:03}");
        let e = payload(event(
            &name,
            &["namespace-create"],
            Effect::Move {
                location: location("note.md"),
            },
        ));
        heads.push(e.id.clone());
        records.insert(e.id.clone(), e);
    }
    let independent = payload(event(
        "independent",
        &["namespace-create"],
        Effect::Move {
            location: location("independent.md"),
        },
    ));
    records.insert(independent.id.clone(), independent);
    let joined = payload(EntryEvent {
        id: id("joined"),
        identity: identity(),
        parents: heads.clone(),
        effect: Effect::Move {
            location: location("joined.md"),
        },
    });
    records.insert(joined.id.clone(), joined);
    let state = State::from_records(scope(), rev("wide"), records, BTreeMap::new()).unwrap();
    assert_eq!(
        state
            .join_physical_move_frontier(&identity(), &heads, &id("independent"))
            .unwrap_err(),
        Error::TooLarge
    );
    assert_eq!(
        state
            .join_physical_move_frontier(&identity(), &heads, &id("joined"))
            .unwrap(),
        vec![id("joined")]
    );
    let mut too_many = heads;
    too_many.push(id("independent"));
    assert_eq!(
        state
            .join_physical_move_frontier(&identity(), &too_many, &id("joined"))
            .unwrap_err(),
        Error::TooLarge
    );
}

fn retained_binary_fixture() -> State {
    let mut records = BTreeMap::new();
    let mut manifest_for = |prefix: &str, bytes: &[u8]| {
        let chunk_id = id(&format!("{prefix}-chunk"));
        let page_id = id(&format!("{prefix}-page"));
        let page = crate::ChunkPage {
            chunks: vec![crate::ChunkRef {
                id: chunk_id.clone(),
                bytes: bytes.len() as u32,
                digest: Sha256Digest::of(bytes),
            }],
        };
        let page_ref = page.reference(page_id.clone()).unwrap();
        records.insert(
            chunk_id.clone(),
            Payload {
                family: Family::Files,
                format_version: 2,
                scope: scope(),
                id: chunk_id,
                body: Body::Chunk {
                    bytes: bytes.to_vec(),
                },
            },
        );
        records.insert(
            page_id.clone(),
            Payload {
                family: Family::Files,
                format_version: 2,
                scope: scope(),
                id: page_id,
                body: Body::Page { page },
            },
        );
        Manifest {
            bytes: bytes.len() as u64,
            digest: Sha256Digest::of(bytes),
            pages: vec![page_ref],
        }
    };
    let first = manifest_for("old", b"retained old bytes");
    let next = manifest_for("new", b"new bytes");
    let mut root = create();
    root.effect = Effect::Create {
        entry_kind: EntryKind::File,
        location: location("binary.dat"),
        content: Some(ContentSeed::Binary { manifest: first }),
    };
    let root = payload(root);
    records.insert(root.id.clone(), root);
    let write = payload(event(
        "binary-write",
        &["namespace-create"],
        Effect::SetContent { content: next },
    ));
    records.insert(write.id.clone(), write);
    State::from_records(scope(), rev("binary-state"), records, BTreeMap::new()).unwrap()
}
#[test]
fn historical_binary_witness_reads_dominated_content_in_recovery_and_tombstone() {
    let base = retained_binary_fixture();
    assert_eq!(
        base.view().unwrap().namespace.entries[&entry("note")]
            .contents
            .len(),
        1
    );
    assert_eq!(
        base.view().unwrap().namespace.entries[&entry("note")].contents[0].event,
        id("binary-write")
    );
    let deleted = apply(&base, event("delete", &["binary-write"], Effect::Delete));
    let recovery = apply(
        &deleted,
        event(
            "concurrent-move",
            &["binary-write"],
            Effect::Move {
                location: location("recovery.dat"),
            },
        ),
    );
    for state in [base, deleted, recovery] {
        let state = restart(&state);
        assert_eq!(
            state
                .materialize_retained_binary(&identity(), &id("namespace-create"))
                .unwrap(),
            Some(b"retained old bytes".to_vec())
        );
        assert_eq!(
            state
                .materialize_retained_binary(&identity(), &id("binary-write"))
                .unwrap(),
            Some(b"new bytes".to_vec())
        );
    }
}
#[test]
fn historical_binary_witness_rejects_other_identity_mode_noncontent_and_pending_event() {
    let state = retained_binary_fixture();
    let mut wrong = identity();
    wrong.bootstrap_id = id("wrong-bootstrap");
    assert_eq!(
        state
            .materialize_retained_binary(&wrong, &id("namespace-create"))
            .unwrap_err(),
        Error::IdentityMismatch
    );
    wrong = identity();
    wrong.entry_id = entry("other");
    assert_eq!(
        state
            .materialize_retained_binary(&wrong, &id("namespace-create"))
            .unwrap_err(),
        Error::IdentityMismatch
    );
    let moved = apply(
        &state,
        event(
            "move",
            &["binary-write"],
            Effect::Move {
                location: location("moved.dat"),
            },
        ),
    );
    assert_eq!(
        moved
            .materialize_retained_binary(&identity(), &id("move"))
            .unwrap_err(),
        Error::InvalidContent
    );
    assert!(moved
        .materialize_retained_binary(&identity(), &id("old-chunk"))
        .is_err());
    let text = apply(&empty(), create());
    assert_eq!(
        text.materialize_retained_binary(&identity(), &id("namespace-create"))
            .unwrap_err(),
        Error::InvalidContent
    );
    let manifest = Manifest {
        bytes: 0,
        digest: Sha256Digest::of(&[]),
        pages: vec![],
    };
    let pending = apply(
        &state,
        event(
            "pending-write",
            &["absent"],
            Effect::SetContent { content: manifest },
        ),
    );
    assert!(pending
        .materialize_retained_binary(&identity(), &id("pending-write"))
        .is_err());
}
#[test]
fn historical_binary_witness_distinguishes_missing_chunks_empty_files_and_corruption() {
    let state = retained_binary_fixture();
    let mut records = state.records.clone();
    records.remove(&id("old-chunk"));
    let missing = State::from_records(scope(), rev("missing"), records, BTreeMap::new()).unwrap();
    assert_eq!(
        missing
            .materialize_retained_binary(&identity(), &id("namespace-create"))
            .unwrap(),
        None
    );
    assert_eq!(
        missing
            .materialize_retained_binary(&identity(), &id("binary-write"))
            .unwrap(),
        Some(b"new bytes".to_vec())
    );
    let empty_file = apply(
        &state,
        event(
            "empty-write",
            &["binary-write"],
            Effect::SetContent {
                content: Manifest {
                    bytes: 0,
                    digest: Sha256Digest::of(&[]),
                    pages: vec![],
                },
            },
        ),
    );
    assert_eq!(
        empty_file
            .materialize_retained_binary(&identity(), &id("empty-write"))
            .unwrap(),
        Some(vec![])
    );
    // Deserialization alone is not validation; the helper validates the complete
    // restored graph and reference integrity before returning historical bytes.
    let mut corrupted = state;
    corrupted.records.get_mut(&id("old-chunk")).unwrap().body = Body::Chunk {
        bytes: b"forged bytes".to_vec(),
    };
    assert!(corrupted
        .materialize_retained_binary(&identity(), &id("namespace-create"))
        .is_err());
}
