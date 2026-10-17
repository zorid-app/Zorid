use super::*;
use crate::{Manifest, Projection, RecoveryReason, Scope, Sha256Digest};
use zorid_client_sync::{
    ActorOwner, ActorRegistration, AuthorRequest, Edit, TextIdentity, TextState,
};
use zorid_core::OperationId;
use zorid_crypto::{CryptoError, EntropySource, VaultKey};
use zorid_sync_protocol::{DeviceId, ExpectedContext, Header, RealmId, VaultId};
fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn entry(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn identity(name: &str) -> EntryIdentity {
    EntryIdentity {
        entry_id: entry(name),
        bootstrap_id: id(&format!("create-{name}")),
    }
}
fn location(parent: Option<&str>, name: &str) -> Location {
    Location {
        parent: parent.map(entry),
        name: name.into(),
    }
}
fn empty() -> v2::State {
    v2::State::empty(scope(), rev("initial"))
}
fn payload(name: &str, event: &str, parents: &[&str], effect: v2::Effect) -> v2::Payload {
    v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id(event),
        body: v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: id(event),
                identity: identity(name),
                parents: parents.iter().map(|p| id(p)).collect(),
                effect,
            }],
        },
    }
}
fn create(name: &str, parent: Option<&str>, kind: EntryKind) -> v2::Payload {
    payload(
        name,
        &format!("create-{name}"),
        &[],
        v2::Effect::Create {
            entry_kind: kind,
            location: location(parent, name),
            content: (kind == EntryKind::File).then(|| v2::ContentSeed::Text {
                text_bootstrap_id: id(&format!("text-{name}")),
                text_format: 2,
            }),
        },
    )
}
fn authored(graph: &v2::State, payload: &v2::Payload) -> v2::State {
    v2::plan_authored(graph, payload, rev(&format!("rev-{}", payload.id.as_str())))
        .unwrap()
        .graph
        .next_state
        .unwrap()
}
fn baseline(graph: &v2::State, name: &str, path: &str) -> PhysicalNamespaceBaseline {
    let view = graph.view().unwrap();
    let e = &view.namespace.entries[&entry(name)];
    PhysicalNamespaceBaseline {
        identity: e.identity.clone(),
        physical_revision: rev(&format!("physical-{name}")),
        path: VaultPath::new(path).unwrap(),
        kind: e.kind,
        heads: e.heads.clone(),
        location_event: e.locations.last().unwrap().event.clone(),
    }
}
fn allocation(ids: &[&str]) -> Allocation {
    Allocation {
        next_revision: rev("next-external"),
        update_ids: ids.iter().map(|s| id(s)).collect(),
    }
}
fn events(plan: &Plan) -> Vec<v2::EntryEvent> {
    plan.authored
        .iter()
        .map(
            |a| match v2::Payload::decode(&a.payload_bytes).unwrap().body {
                v2::Body::Events { mut events } => events.remove(0),
                _ => panic!("event"),
            },
        )
        .collect()
}
struct Entropy;
impl EntropySource for Entropy {
    fn fill(&mut self, b: &mut [u8]) -> std::result::Result<(), CryptoError> {
        b.fill(17);
        Ok(())
    }
}
fn receive(graph: &v2::State, payload: &v2::Payload) -> v2::State {
    let key = VaultKey::from_bytes([9; 32]);
    let h = Header::new(
        scope().realm_id,
        scope().vault_id,
        payload.id.clone(),
        DeviceId::new("peer").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(&h, &payload.encode().unwrap(), &key, &mut Entropy)
        .unwrap()
        .encode();
    let opened = v2::AuthenticatedPayload::open(
        &wire,
        &ExpectedContext {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            update_id: payload.id.clone(),
            key_epoch: 1,
        },
        &key,
    )
    .unwrap();
    v2::plan_received(
        graph,
        &opened,
        None,
        rev(&format!("received-{}", payload.id.as_str())),
    )
    .unwrap()
    .graph
    .next_state
    .unwrap()
}
fn remote_text(graph: &v2::State, name: &str) -> v2::State {
    let initial = TextState::empty(
        TextIdentity {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            entry_id: entry(name),
            bootstrap_id: id(&format!("text-{name}")),
        },
        rev("empty-text"),
    );
    let plan = zorid_client_sync::v2::plan_authored_text(
        &initial,
        &AuthorRequest {
            expected_version: initial.version.clone(),
            next_version: rev("remote-text"),
            update_id: id("remote-text"),
            actor: ActorRegistration {
                actor: 1,
                owner: ActorOwner {
                    replica_id: DeviceId::new("peer").unwrap(),
                    incarnation_id: OperationId::new("incarnation").unwrap(),
                },
            },
            edits: vec![Edit::Insert {
                index: 0,
                text: "unseen 🦀".into(),
            }],
        },
        &zorid_client_sync::v2::TextNamespaceContext {
            bootstrap_id: identity(name).bootstrap_id,
            parents: vec![id(&format!("create-{name}"))],
        },
    )
    .unwrap();
    v2::plan_authored_text_activity(graph, plan.activity(), rev("remote-graph"))
        .unwrap()
        .next_state
        .unwrap()
}

#[test]
fn stale_physical_delete_keeps_unseen_text_as_delete_conflict_after_restart() {
    let base = authored(&empty(), &create("note", None, EntryKind::File));
    let physical = baseline(&base, "note", "note");
    let current = remote_text(&base, "note");
    let plan = plan_external_namespace(
        &current,
        &[physical.clone()],
        &ExternalNamespaceAction::Delete {
            root: entry("note"),
        },
        &allocation(&["disk-delete"]),
    )
    .unwrap();
    assert_eq!(events(&plan)[0].parents, physical.heads);
    let restart: v2::State =
        serde_json::from_slice(&serde_json::to_vec(&plan.next_graph).unwrap()).unwrap();
    let view = restart.view().unwrap();
    let e = &view.namespace.entries[&entry("note")];
    assert_eq!(e.liveness, Liveness::DeleteConflict);
    assert!(matches!(
        e.projection,
        Projection::Recovery {
            reason: RecoveryReason::DeleteConflict,
            ..
        }
    ));
    assert!(restart.activities().contains_key(&id("remote-text")));
    assert_eq!(plan.authored.len(), 1);
}

#[test]
fn offline_moves_preserve_both_locations_and_converge_when_exchanged() {
    let base = authored(&empty(), &create("note", None, EntryKind::File));
    let physical = baseline(&base, "note", "note");
    let remote = payload(
        "note",
        "remote-move",
        &["create-note"],
        v2::Effect::Move {
            location: location(None, "remote"),
        },
    );
    let current = authored(&base, &remote);
    let action = ExternalNamespaceAction::Move {
        root: entry("note"),
        target: location(None, "disk"),
    };
    let local = plan_external_namespace(
        &base,
        &[physical.clone()],
        &action,
        &allocation(&["disk-move"]),
    )
    .unwrap();
    let combined =
        plan_external_namespace(&current, &[physical], &action, &allocation(&["disk-move"]))
            .unwrap();
    assert_eq!(local.authored, combined.authored);
    let exchange = receive(&local.next_graph, &remote);
    assert_eq!(
        exchange.view().unwrap(),
        combined.next_graph.view().unwrap()
    );
    let e = &exchange.view().unwrap().namespace.entries[&entry("note")];
    assert_eq!(e.locations.len(), 2);
    assert_eq!(events(&combined)[0].parents, vec![id("create-note")]);
    // Reverse delivery retains the dependency and resolves when Create arrives.
    let disk = v2::Payload::decode(&combined.authored[0].payload_bytes).unwrap();
    let reverse = receive(
        &receive(&receive(&empty(), &disk), &remote),
        &create("note", None, EntryKind::File),
    );
    assert_eq!(reverse.view().unwrap(), combined.next_graph.view().unwrap());
}

#[test]
fn observed_directory_delete_never_expands_to_new_remote_children() {
    let mut base = authored(&empty(), &create("folder", None, EntryKind::Folder));
    base = authored(&base, &create("child", Some("folder"), EntryKind::File));
    let saved = vec![
        baseline(&base, "child", "folder/child"),
        baseline(&base, "folder", "folder"),
    ];
    let latest = authored(&base, &create("new", Some("folder"), EntryKind::File));
    let plan = plan_external_namespace(
        &latest,
        &saved,
        &ExternalNamespaceAction::Delete {
            root: entry("folder"),
        },
        &allocation(&["delete-child", "delete-folder"]),
    )
    .unwrap();
    assert_eq!(
        events(&plan)
            .iter()
            .map(|e| e.identity.entry_id.clone())
            .collect::<Vec<_>>(),
        vec![entry("child"), entry("folder")]
    );
    for authored in &plan.authored {
        assert_eq!(
            events(&Plan {
                authored: vec![authored.clone()],
                ..plan.clone()
            })[0]
                .id,
            authored.update_id
        );
    }
    let view = plan.next_graph.view().unwrap();
    assert_eq!(
        view.namespace.entries[&entry("new")].liveness,
        Liveness::Live
    );
    assert!(matches!(
        view.namespace.entries[&entry("new")].projection,
        Projection::Recovery { .. }
    ));
}

#[test]
fn folder_move_emits_only_root_and_preconditions_capture_all_physical_witnesses() {
    let mut base = authored(&empty(), &create("folder", None, EntryKind::Folder));
    base = authored(&base, &create("child", Some("folder"), EntryKind::File));
    let saved = vec![
        baseline(&base, "child", "folder/child"),
        baseline(&base, "folder", "folder"),
    ];
    let plan = plan_external_namespace(
        &base,
        &saved,
        &ExternalNamespaceAction::Move {
            root: entry("folder"),
            target: location(None, "renamed"),
        },
        &allocation(&["move-folder"]),
    )
    .unwrap();
    assert_eq!(events(&plan).len(), 1);
    assert_eq!(events(&plan)[0].identity.entry_id, entry("folder"));
    assert_eq!(
        plan.next_graph.view().unwrap().namespace.entries[&entry("child")].heads,
        vec![id("create-child")]
    );
    plan.check_preconditions(&base, &saved, true).unwrap();
    assert_eq!(
        plan.check_preconditions(&base, &saved, false),
        Err(Error::DuplicateMismatch)
    );
    for field in 0..3 {
        let mut changed = saved.clone();
        match field {
            0 => changed[0].physical_revision = rev("other"),
            1 => changed[0].path = VaultPath::new("other/child").unwrap(),
            _ => changed[0].location_event = id("other"),
        };
        assert_eq!(
            plan.check_preconditions(&base, &changed, true),
            Err(Error::VersionConflict)
        );
    }
    assert_eq!(
        plan.check_preconditions(&plan.next_graph, &saved, true),
        Err(Error::VersionConflict)
    );
}

#[test]
fn invalid_historical_frontiers_and_nonphysical_members_fail_closed() {
    let base = authored(&empty(), &create("note", None, EntryKind::File));
    let moved = authored(
        &base,
        &payload(
            "note",
            "move",
            &["create-note"],
            v2::Effect::Move {
                location: location(None, "new"),
            },
        ),
    );
    let saved = baseline(&base, "note", "note");
    for field in 0..7 {
        let mut bad = saved.clone();
        match field {
            0 => bad.heads.clear(),
            1 => bad.heads.push(id("create-note")),
            2 => bad.heads = vec![id("create-note"), id("move")],
            3 => bad.location_event = id("move"),
            4 => bad.kind = EntryKind::Folder,
            5 => bad.identity.bootstrap_id = id("wrong"),
            _ => bad.path = VaultPath::new("fake/note").unwrap(),
        }
        assert!(validate_baselines(&moved, &[bad]).is_err(), "case {field}");
    }
    let deleted = authored(
        &base,
        &payload("note", "delete", &["create-note"], v2::Effect::Delete),
    );
    let bad = baseline(&deleted, "note", "note");
    assert!(validate_baselines(&deleted, &[bad]).is_err());
    let action = ExternalNamespaceAction::Delete {
        root: entry("note"),
    };
    assert!(plan_external_namespace(
        &base,
        &[saved.clone()],
        &action,
        &allocation(&["create-note"])
    )
    .is_err());
    assert!(plan_external_namespace(&base, &[saved.clone()], &action, &allocation(&[])).is_err());
    let mut same = allocation(&["external"]);
    same.next_revision = base.version().clone();
    assert!(plan_external_namespace(&base, &[saved], &action, &same).is_err());
}

#[test]
fn pending_future_event_does_not_invalidate_real_saved_baseline() {
    let base = authored(&empty(), &create("note", None, EntryKind::File));
    let saved = baseline(&base, "note", "note");
    let pending = payload(
        "note",
        "pending",
        &["missing"],
        v2::Effect::Move {
            location: location(None, "later"),
        },
    );
    let graph = receive(&base, &pending);
    validate_baselines(&graph, &[saved.clone()]).unwrap();
    let result = plan_external_namespace(
        &graph,
        &[saved],
        &ExternalNamespaceAction::Delete {
            root: entry("note"),
        },
        &allocation(&["observed-delete"]),
    )
    .unwrap();
    assert!(result
        .next_graph
        .view()
        .unwrap()
        .namespace
        .pending
        .contains(&id("pending")));
}

#[test]
fn historical_binary_content_need_not_be_present_to_validate_namespace() {
    let manifest = Manifest {
        bytes: 1,
        digest: Sha256Digest::of(b"x"),
        pages: vec![crate::PageRef {
            id: id("missing-page"),
            bytes: 1,
            digest: Sha256Digest::of(b"page"),
        }],
    };
    let create = payload(
        "binary",
        "create-binary",
        &[],
        v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: location(None, "binary"),
            content: Some(v2::ContentSeed::Binary { manifest }),
        },
    );
    let graph = authored(&empty(), &create);
    assert!(
        !graph.view().unwrap().namespace.entries[&entry("binary")].contents[0]
            .status
            .missing
            .is_empty()
    );
    let saved = baseline(&graph, "binary", "binary");
    validate_baselines(&graph, &[saved]).unwrap();
}
