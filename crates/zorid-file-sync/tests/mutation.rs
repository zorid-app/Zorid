use std::collections::BTreeMap;
use zorid_client_sync::{ActorOwner, ActorRegistration, TextState};
use zorid_core::{
    EntryId, EntryKind, EntryState, Mutation, MutationRequest, OperationId, Revision, VaultPath,
};
use zorid_file_sync::{mutation::*, v2, Projection, Scope, MAX_CHUNK_BYTES};
use zorid_sync_protocol::{DeviceId, RealmId, UpdateId, VaultId};
fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn update(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn path(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}
fn request(op: &str, mutation: Mutation) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(op).unwrap(),
        mutation,
    }
}
fn create(op: &str, name: &str, kind: EntryKind, bytes: Option<Vec<u8>>) -> MutationRequest {
    request(
        op,
        Mutation::Create {
            id: id(op),
            path: path(name),
            kind,
            content: bytes,
        },
    )
}
fn empty() -> v2::State {
    v2::State::empty(
        Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        },
        rev("initial"),
    )
}
fn allocate(
    req: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> Allocation {
    let needs = requirements(req, entries, graph, mode, text).unwrap();
    let op = req.operation_id.as_str();
    Allocation {
        metadata_revision: rev(&format!("{op}-metadata")),
        graph_revision: rev(&format!("{op}-graph")),
        update_ids: (0..needs.update_count)
            .map(|i| update(&format!("{op}-{i}")))
            .collect(),
        text: match needs.text {
            TextRequirement::None => None,
            kind => Some(TextAllocation {
                actor: ActorRegistration {
                    actor: 7,
                    owner: ActorOwner {
                        replica_id: DeviceId::new("replica").unwrap(),
                        incarnation_id: OperationId::new("incarnation").unwrap(),
                    },
                },
                new_text: (kind == TextRequirement::Create).then(|| NewText {
                    bootstrap_id: update(&format!("{op}-text-bootstrap")),
                    empty_revision: rev(&format!("{op}-empty")),
                }),
            }),
        },
    }
}
fn plan(
    req: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> MutationPlan {
    plan_mutation(
        req,
        entries,
        graph,
        mode,
        text,
        &allocate(req, entries, graph, mode, text),
    )
    .unwrap()
}
fn entries_after(before: &[EntryState], plan: &MutationPlan) -> Vec<EntryState> {
    let mut entries: BTreeMap<_, _> = before.iter().map(|e| (e.id.clone(), e.clone())).collect();
    for c in &plan.changes {
        entries.insert(c.after.id.clone(), c.after.clone());
    }
    entries.into_values().collect()
}
fn state<'a>(entries: &'a [EntryState], name: &str) -> &'a EntryState {
    entries.iter().find(|e| e.id == id(name)).unwrap()
}
fn manifest(plan: &MutationPlan, name: &str) -> zorid_file_sync::Manifest {
    plan.next_graph.view().unwrap().namespace.entries[&id(name)]
        .contents
        .last()
        .unwrap()
        .manifest
        .clone()
}

#[test]
fn binary_exact_bytes_and_payload_dependency_order() {
    let bytes: Vec<u8> = (0..MAX_CHUNK_BYTES * 2 + 17)
        .map(|i| (i % 256) as u8)
        .collect();
    let req = create("binary", "opaque.md", EntryKind::File, Some(bytes.clone()));
    let graph = empty();
    let p = plan(&req, &[], &graph, Some(CreateMode::Binary), None);
    assert_eq!(p.authored_files.len(), 5); // 3 chunks, page, Create
    assert!(p.text.is_none());
    assert_eq!(
        p.next_graph.materialize(&manifest(&p, "binary")).unwrap(),
        Some(bytes)
    );
    let kinds: Vec<_> = p
        .authored_files
        .iter()
        .map(|a| {
            let wire = v2::Payload::decode(&a.payload_bytes).unwrap();
            assert_eq!(wire.id, a.update_id);
            match wire.body {
                v2::Body::Chunk { .. } => "chunk",
                v2::Body::Page { .. } => "page",
                _ => "event",
            }
        })
        .collect();
    assert_eq!(kinds, ["chunk", "chunk", "chunk", "page", "event"]);
    p.check_preconditions(&[], &graph, None, true).unwrap();
    assert_eq!(
        p.check_preconditions(&[], &graph, None, false),
        Err(Error::InvalidAllocation)
    );
}

#[test]
fn recursive_move_uses_one_parent_event_delete_names_observed_members() {
    let folder = plan(
        &create("folder", "a", EntryKind::Folder, None),
        &[],
        &empty(),
        None,
        None,
    );
    let mut entries = entries_after(&[], &folder);
    let note = plan(
        &create("child", "a/c", EntryKind::File, Some(vec![0, 255])),
        &entries,
        &folder.next_graph,
        Some(CreateMode::Binary),
        None,
    );
    entries = entries_after(&entries, &note);
    let child_identity = note.next_graph.view().unwrap().namespace.entries[&id("child")]
        .identity
        .clone();
    let child_heads = note.next_graph.view().unwrap().namespace.entries[&id("child")]
        .heads
        .clone();
    let req = request(
        "move",
        Mutation::Move {
            id: id("folder"),
            expected: state(&entries, "folder").revision.clone(),
            path: path("b"),
        },
    );
    let moved = plan(&req, &entries, &note.next_graph, None, None);
    assert_eq!(moved.authored_files.len(), 1);
    let view = moved.next_graph.view().unwrap();
    assert_eq!(
        view.namespace.entries[&id("child")].identity,
        child_identity
    );
    assert_eq!(view.namespace.entries[&id("child")].heads, child_heads);
    assert_eq!(
        view.namespace.entries[&id("child")].projection,
        Projection::Normal { path: path("b/c") }
    );
    entries = entries_after(&entries, &moved);
    let req = request(
        "delete",
        Mutation::Delete {
            id: id("folder"),
            expected: state(&entries, "folder").revision.clone(),
            recursive: true,
        },
    );
    let deleted = plan(&req, &entries, &moved.next_graph, None, None);
    let observed: Vec<_> = deleted
        .authored_files
        .iter()
        .map(
            |a| match v2::Payload::decode(&a.payload_bytes).unwrap().body {
                v2::Body::ObservedDelete { events } => {
                    assert_eq!(events.len(), 1);
                    events[0].identity.entry_id.clone()
                }
                _ => panic!("expected observed deletion"),
            },
        )
        .collect();
    assert_eq!(observed, [id("child"), id("folder")]);
    assert!(deleted.changes.iter().all(|c| c.after.deleted));
    assert_eq!(
        deleted
            .next_graph
            .materialize(&manifest(&note, "child"))
            .unwrap(),
        Some(vec![0, 255])
    );
}

#[test]
fn independent_text_bootstrap_write_move_and_delete_preserve_snapshot() {
    let req = create(
        "text",
        "image.bin",
        EntryKind::File,
        Some("héllo".as_bytes().to_vec()),
    );
    let graph = empty();
    let p = plan(&req, &[], &graph, Some(CreateMode::Text), None);
    assert_eq!(p.authored_files.len(), 1);
    let t = p.text.as_ref().unwrap().plan();
    assert!(matches!(p.text, Some(TextChange::Create(_))));
    assert_eq!(t.materialized_utf8, "héllo".as_bytes());
    let entry = &p.next_graph.view().unwrap().namespace.entries[&id("text")];
    assert_ne!(
        entry.identity.bootstrap_id,
        t.next_state.identity.bootstrap_id
    );
    assert_eq!(entry.heads, vec![t.authored.update_id.clone()]);
    let mut entries = entries_after(&[], &p);
    let req = request(
        "write",
        Mutation::Write {
            id: id("text"),
            expected: state(&entries, "text").revision.clone(),
            content: b"changed".to_vec(),
        },
    );
    let written = plan(&req, &entries, &p.next_graph, None, Some(&t.next_state));
    assert!(written.authored_files.is_empty());
    assert_eq!(
        written.text.as_ref().unwrap().plan().materialized_utf8,
        b"changed"
    );
    written
        .check_preconditions(&entries, &p.next_graph, Some(&t.next_state), true)
        .unwrap();
    assert_eq!(
        written.check_preconditions(&entries, &p.next_graph, None, true),
        Err(Error::SnapshotMismatch)
    );
    entries = entries_after(&entries, &written);
    let req = request(
        "move",
        Mutation::Move {
            id: id("text"),
            expected: state(&entries, "text").revision.clone(),
            path: path("other"),
        },
    );
    let moved = plan(&req, &entries, &written.next_graph, None, None);
    assert!(moved.text.is_none());
    assert_eq!(
        moved.next_graph.activities(),
        written.next_graph.activities()
    );
    entries = entries_after(&entries, &moved);
    let req = request(
        "delete",
        Mutation::Delete {
            id: id("text"),
            expected: state(&entries, "text").revision.clone(),
            recursive: false,
        },
    );
    let deleted = plan(&req, &entries, &moved.next_graph, None, None);
    assert!(deleted.text.is_none());
    assert_eq!(
        deleted.next_graph.activities(),
        written.next_graph.activities()
    );
    assert_eq!(
        written
            .text
            .as_ref()
            .unwrap()
            .plan()
            .next_state
            .materialized_utf8()
            .unwrap(),
        b"changed"
    );
}

#[test]
fn deterministic_plan_is_not_a_command_retry_and_mode_is_explicit() {
    let req = create("file", "no-extension", EntryKind::File, Some(vec![]));
    let graph = empty();
    assert_eq!(
        requirements(&req, &[], &graph, None, None),
        Err(Error::InvalidMode)
    );
    let a = allocate(&req, &[], &graph, Some(CreateMode::Binary), None);
    let p = plan_mutation(&req, &[], &graph, Some(CreateMode::Binary), None, &a).unwrap();
    assert_eq!(
        p,
        plan_mutation(&req, &[], &graph, Some(CreateMode::Binary), None, &a).unwrap()
    );
    assert_eq!(
        p.next_graph.materialize(&manifest(&p, "file")).unwrap(),
        Some(vec![])
    );
    let committed = entries_after(&[], &p);
    assert!(plan_mutation(
        &req,
        &committed,
        &p.next_graph,
        Some(CreateMode::Binary),
        None,
        &a
    )
    .is_err());
    assert!(p
        .check_preconditions(&committed, &p.next_graph, None, true)
        .is_err());
    // The host returns the original receipt for this case, before allocating or calling us.
    let folder = create("folder", "folder", EntryKind::Folder, None);
    assert_eq!(
        requirements(&folder, &[], &graph, Some(CreateMode::Binary), None),
        Err(Error::InvalidMode)
    );
}

#[test]
fn allocation_count_duplicates_revisions_and_bootstrap_reuse_fail_without_mutation() {
    let req = create("file", "file", EntryKind::File, Some(vec![1]));
    let graph = empty();
    let a = allocate(&req, &[], &graph, Some(CreateMode::Binary), None);
    for bad in [
        Allocation {
            update_ids: a.update_ids[..2].to_vec(),
            ..a.clone()
        },
        Allocation {
            update_ids: vec![update("same"); 3],
            ..a.clone()
        },
        Allocation {
            graph_revision: graph.version().clone(),
            ..a.clone()
        },
        Allocation {
            metadata_revision: a.graph_revision.clone(),
            ..a.clone()
        },
    ] {
        assert_eq!(
            plan_mutation(&req, &[], &graph, Some(CreateMode::Binary), None, &bad),
            Err(Error::InvalidAllocation)
        );
        assert!(graph.records().is_empty());
    }
    let text_req = create("text", "text", EntryKind::File, Some(vec![]));
    let mut a = allocate(&text_req, &[], &graph, Some(CreateMode::Text), None);
    a.text
        .as_mut()
        .unwrap()
        .new_text
        .as_mut()
        .unwrap()
        .bootstrap_id = a.update_ids[0].clone();
    assert_eq!(
        plan_mutation(&text_req, &[], &graph, Some(CreateMode::Text), None, &a),
        Err(Error::InvalidAllocation)
    );
}

#[test]
fn stale_metadata_wrong_paths_and_wrong_text_identity_fail_closed() {
    let p = plan(
        &create("file", "f", EntryKind::File, Some(vec![1])),
        &[],
        &empty(),
        Some(CreateMode::Binary),
        None,
    );
    let entries = entries_after(&[], &p);
    let stale = request(
        "write",
        Mutation::Write {
            id: id("file"),
            expected: rev("stale"),
            content: vec![2],
        },
    );
    assert!(matches!(
        requirements(&stale, &entries, &p.next_graph, None, None),
        Err(Error::Contract(
            zorid_core::ContractError::RevisionConflict { .. }
        ))
    ));
    let mut wrong = entries.clone();
    wrong[0].path = path("unrelated");
    let valid = request(
        "write",
        Mutation::Write {
            id: id("file"),
            expected: entries[0].revision.clone(),
            content: vec![2],
        },
    );
    assert_eq!(
        requirements(&valid, &wrong, &p.next_graph, None, None),
        Err(Error::SnapshotMismatch)
    );
    let text = plan(
        &create("text", "t", EntryKind::File, Some(vec![])),
        &[],
        &empty(),
        Some(CreateMode::Text),
        None,
    );
    let entries = entries_after(&[], &text);
    let mut state = text.text.as_ref().unwrap().plan().next_state.clone();
    state.identity.bootstrap_id = update("other-bootstrap");
    let req = request(
        "write",
        Mutation::Write {
            id: id("text"),
            expected: entries[0].revision.clone(),
            content: vec![1],
        },
    );
    assert_eq!(
        requirements(&req, &entries, &text.next_graph, None, Some(&state)),
        Err(Error::SnapshotMismatch)
    );
}

#[test]
fn binary_write_preserves_identity_and_ancestor_changes_match_core() {
    let folder = plan(
        &create("folder", "f", EntryKind::Folder, None),
        &[],
        &empty(),
        None,
        None,
    );
    let entries = entries_after(&[], &folder);
    let file = plan(
        &create("file", "f/c", EntryKind::File, Some(vec![1])),
        &entries,
        &folder.next_graph,
        Some(CreateMode::Binary),
        None,
    );
    let entries = entries_after(&entries, &file);
    let req = request(
        "write",
        Mutation::Write {
            id: id("file"),
            expected: state(&entries, "file").revision.clone(),
            content: vec![0, 255, 1, 128],
        },
    );
    let a = allocate(&req, &entries, &file.next_graph, None, None);
    let p = plan_mutation(&req, &entries, &file.next_graph, None, None, &a).unwrap();
    assert_eq!(
        p.changes,
        zorid_core::plan_mutation(&req, &entries, &a.metadata_revision).unwrap()
    );
    assert_eq!(p.changes.len(), 2);
    assert_eq!(
        file.next_graph.view().unwrap().namespace.entries[&id("file")].identity,
        p.next_graph.view().unwrap().namespace.entries[&id("file")].identity
    );
    assert_eq!(
        p.next_graph.materialize(&manifest(&p, "file")).unwrap(),
        Some(vec![0, 255, 1, 128])
    );
    assert_eq!(
        p.next_graph.materialize(&manifest(&file, "file")).unwrap(),
        Some(vec![1])
    );
}

fn pending_child_fixture() -> (Vec<EntryState>, v2::State) {
    let folder = plan(
        &create("folder", "f", EntryKind::Folder, None),
        &[],
        &empty(),
        None,
        None,
    );
    let entries = entries_after(&[], &folder);
    let child = plan(
        &create("z-child", "f/c", EntryKind::File, Some(vec![42])),
        &entries,
        &folder.next_graph,
        Some(CreateMode::Binary),
        None,
    );
    let entries = entries_after(&entries, &child);
    let outsider = plan(
        &create("outside", "outside", EntryKind::File, Some(vec![])),
        &entries,
        &child.next_graph,
        Some(CreateMode::Binary),
        None,
    );
    let entries = entries_after(&entries, &outsider)
        .into_iter()
        .filter(|e| e.id != id("z-child"))
        .collect();
    let records = outsider
        .next_graph
        .records()
        .iter()
        .filter(|(_, p)| !matches!(p.body, v2::Body::Chunk { .. } | v2::Body::Page { .. }))
        .map(|(id, p)| (id.clone(), p.clone()))
        .collect();
    let graph = v2::State::from_records(
        outsider.next_graph.scope().clone(),
        outsider.next_graph.version().clone(),
        records,
        outsider.next_graph.activities().clone(),
    )
    .unwrap();
    let view = graph.view().unwrap();
    assert_eq!(
        view.namespace.entries[&id("z-child")].projection,
        Projection::Normal { path: path("f/c") }
    );
    assert_eq!(
        graph
            .materialize(&view.namespace.entries[&id("z-child")].contents[0].manifest)
            .unwrap(),
        None
    );
    (entries, graph)
}

#[test]
fn omitted_pending_occupant_cannot_be_displaced_by_create_or_move() {
    let (entries, graph) = pending_child_fixture();
    let new = create("a-new", "f/c", EntryKind::File, Some(vec![]));
    assert_eq!(
        requirements(&new, &entries, &graph, Some(CreateMode::Binary), None),
        Err(Error::SnapshotMismatch)
    );
    let moved = request(
        "move",
        Mutation::Move {
            id: id("outside"),
            expected: state(&entries, "outside").revision.clone(),
            path: path("f/c"),
        },
    );
    assert_eq!(
        requirements(&moved, &entries, &graph, None, None),
        Err(Error::SnapshotMismatch)
    );
    // Pending materialization elsewhere does not block unrelated commands.
    let allowed = create("elsewhere", "elsewhere", EntryKind::File, Some(vec![]));
    assert!(
        plan(&allowed, &entries, &graph, Some(CreateMode::Binary), None)
            .text
            .is_none()
    );
}

#[test]
fn incomplete_observed_subtree_rejects_move_and_both_delete_modes() {
    let (entries, graph) = pending_child_fixture();
    for recursive in [false, true] {
        let req = request(
            "delete",
            Mutation::Delete {
                id: id("folder"),
                expected: state(&entries, "folder").revision.clone(),
                recursive,
            },
        );
        assert_eq!(
            requirements(&req, &entries, &graph, None, None),
            Err(Error::SnapshotMismatch)
        );
    }
    let req = request(
        "move",
        Mutation::Move {
            id: id("folder"),
            expected: state(&entries, "folder").revision.clone(),
            path: path("g"),
        },
    );
    assert_eq!(
        requirements(&req, &entries, &graph, None, None),
        Err(Error::SnapshotMismatch)
    );
}

#[test]
fn valid_old_text_with_fresh_metadata_is_rejected_before_allocation() {
    let p = plan(
        &create("text", "t", EntryKind::File, Some(b"old".to_vec())),
        &[],
        &empty(),
        Some(CreateMode::Text),
        None,
    );
    let mut entries = entries_after(&[], &p);
    let old = p.text.as_ref().unwrap().plan().next_state.clone();
    assert_eq!(old.materialized_utf8().unwrap(), b"old");
    entries[0].revision = rev("new-metadata");
    let req = request(
        "write",
        Mutation::Write {
            id: id("text"),
            expected: entries[0].revision.clone(),
            content: b"new".to_vec(),
        },
    );
    assert_eq!(
        requirements(&req, &entries, &p.next_graph, None, Some(&old)),
        Err(Error::SnapshotMismatch)
    );
}

#[test]
fn requirements_reject_oversize_binary_and_invalid_utf8_without_building_graph() {
    let graph = empty();
    let req = create(
        "large",
        "large",
        EntryKind::File,
        Some(vec![0; zorid_file_sync::MAX_FILE_BYTES as usize + 1]),
    );
    assert_eq!(
        requirements(&req, &[], &graph, Some(CreateMode::Binary), None),
        Err(Error::Files(zorid_file_sync::Error::TooLarge))
    );
    let req = create(
        "invalid-text",
        "note.md",
        EntryKind::File,
        Some(vec![0xff, 0xfe]),
    );
    assert_eq!(
        requirements(&req, &[], &graph, Some(CreateMode::Text), None),
        Err(Error::Text(zorid_client_sync::SyncError::InvalidPayload))
    );
    // The same exact bytes remain valid when the caller explicitly chooses Binary.
    assert!(requirements(&req, &[], &graph, Some(CreateMode::Binary), None).is_ok());
    assert!(graph.records().is_empty());
}

#[test]
fn durable_family_command_requires_explicit_mode_and_strict_complete_shape() {
    let binary = FamilyCommand::new(
        create("file", "file", EntryKind::File, Some(vec![255])),
        Some(CreateMode::Binary),
    )
    .unwrap();
    let json = serde_json::to_value(&binary).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["create_mode"], "binary");
    assert_eq!(
        serde_json::from_value::<FamilyCommand>(json.clone()).unwrap(),
        binary
    );
    for mode in [serde_json::Value::Null, serde_json::json!("guess")] {
        let mut invalid = json.clone();
        invalid["create_mode"] = mode;
        assert!(serde_json::from_value::<FamilyCommand>(invalid).is_err());
    }
    let folder =
        FamilyCommand::new(create("folder", "folder", EntryKind::Folder, None), None).unwrap();
    let json = serde_json::to_value(&folder).unwrap();
    assert!(json["create_mode"].is_null());
    let mut missing = json.clone();
    missing.as_object_mut().unwrap().remove("create_mode");
    assert!(serde_json::from_value::<FamilyCommand>(missing).is_err());
    for version in [0, 2] {
        let mut invalid = json.clone();
        invalid["version"] = serde_json::json!(version);
        assert!(serde_json::from_value::<FamilyCommand>(invalid).is_err());
    }
    let mut unknown = json.clone();
    unknown["mode"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<FamilyCommand>(unknown).is_err());
    let encoded = serde_json::to_string(&folder).unwrap();
    let duplicate = encoded.replacen("{", "{\"create_mode\":null,", 1);
    assert!(serde_json::from_str::<FamilyCommand>(&duplicate).is_err());
    assert!(serde_json::from_value::<FamilyCommand>(
        serde_json::to_value(&folder.request).unwrap()
    )
    .is_err());
}

#[test]
fn durable_family_command_replay_binds_mode_bytes_path_and_operation_id() {
    let command = FamilyCommand::new(
        create("file", "file", EntryKind::File, Some(b"bytes".to_vec())),
        Some(CreateMode::Binary),
    )
    .unwrap();
    command.check_replay(&command.clone()).unwrap();
    let mut changes = Vec::new();
    let mut changed = command.clone();
    changed.create_mode = Some(CreateMode::Text);
    changes.push(changed);
    let mut changed = command.clone();
    if let Mutation::Create { content, .. } = &mut changed.request.mutation {
        *content = Some(b"changed".to_vec());
    }
    changes.push(changed);
    let mut changed = command.clone();
    if let Mutation::Create {
        path: destination, ..
    } = &mut changed.request.mutation
    {
        *destination = path("other");
    }
    changes.push(changed);
    let mut changed = command.clone();
    changed.request.operation_id = OperationId::new("other").unwrap();
    changes.push(changed);
    for changed in changes {
        assert!(matches!(
            changed.check_replay(&command),
            Err(Error::Contract(
                zorid_core::ContractError::IdempotencyConflict { .. }
            ))
        ));
    }
    let mut omitted = command.clone();
    omitted.create_mode = None;
    assert_eq!(omitted.check_replay(&command), Err(Error::InvalidMode));
    let mut future = command.clone();
    future.version = 2;
    assert_eq!(future.validate(), Err(Error::UnsupportedCommandVersion));
}

#[test]
fn durable_family_command_noncreate_mode_matrix_and_replay_without_current_state() {
    let commands = [
        create("folder", "folder", EntryKind::Folder, None),
        request(
            "write",
            Mutation::Write {
                id: id("entry"),
                expected: rev("old"),
                content: vec![0],
            },
        ),
        request(
            "move",
            Mutation::Move {
                id: id("entry"),
                expected: rev("old"),
                path: path("new"),
            },
        ),
        request(
            "delete",
            Mutation::Delete {
                id: id("entry"),
                expected: rev("old"),
                recursive: true,
            },
        ),
    ];
    for request in commands {
        let command = FamilyCommand::new(request.clone(), None).unwrap();
        assert_eq!(
            FamilyCommand::new(request.clone(), Some(CreateMode::Text)),
            Err(Error::InvalidMode)
        );
        assert_eq!(
            FamilyCommand::new(request, Some(CreateMode::Binary)),
            Err(Error::InvalidMode)
        );
        // Target can now be gone/stale; receipt replay compares exact command,
        // independently of the planner's current snapshot preconditions.
        command.check_replay(&command).unwrap();
        let decoded: FamilyCommand =
            serde_json::from_str(&serde_json::to_string(&command).unwrap()).unwrap();
        assert_eq!(decoded, command);
    }
}
