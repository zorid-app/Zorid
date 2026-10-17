use super::*;
use crate::binary_stream::{verify_complete_binary_manifests, ChunkSource};
use crate::metadata::{GraphRecord, GraphRecordBody};
use crate::{Manifest, Projection, RecoveryReason, Scope, Sha256Digest};
use zorid_sync_protocol::{RealmId, VaultId};

fn id(value: &str) -> UpdateId {
    UpdateId::new(value).unwrap()
}
fn entry(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn revision(value: &str) -> Revision {
    Revision::new(value).unwrap()
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
fn payload(name: &str, update: &str, parents: &[&str], effect: v2::Effect) -> v2::Payload {
    v2::Payload {
        family: Family::Files,
        format_version: v2::FORMAT_VERSION,
        scope: scope(),
        id: id(update),
        body: v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: id(update),
                identity: identity(name),
                parents: parents.iter().map(|parent| id(parent)).collect(),
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
fn graph(records: Vec<v2::Payload>) -> v2::State {
    v2::State::from_records(
        scope(),
        revision("graph"),
        records
            .into_iter()
            .map(|record| (record.id.clone(), record))
            .collect(),
        BTreeMap::new(),
    )
    .unwrap()
}
fn append(graph: &v2::State, payload: v2::Payload) -> v2::State {
    let mut records = graph.records().clone();
    let next = revision(&format!("graph-{}", payload.id.as_str()));
    assert!(records.insert(payload.id.clone(), payload).is_none());
    v2::State::from_records(scope(), next, records, graph.activities().clone()).unwrap()
}
fn baseline(graph: &v2::State, name: &str, path: &str) -> PhysicalNamespaceBaseline {
    let view = graph.view().unwrap();
    let value = &view.namespace.entries[&entry(name)];
    PhysicalNamespaceBaseline {
        identity: value.identity.clone(),
        physical_revision: revision(&format!("physical-{name}")),
        path: VaultPath::new(path).unwrap(),
        kind: value.kind,
        heads: value.heads.clone(),
        location_event: value.locations.last().unwrap().event.clone(),
    }
}
fn allocation(updates: &[&str]) -> Allocation {
    Allocation {
        next_revision: revision(&format!("next-{}", updates.join("-"))),
        update_ids: updates.iter().map(|value| id(value)).collect(),
    }
}
fn metadata(graph: &v2::State) -> MetadataState {
    // Differential fixture conversion only. Production metadata paths never
    // construct a legacy state or load its chunk bodies.
    MetadataState::from_legacy(graph).unwrap()
}
fn compare(
    graph: &v2::State,
    baselines: &[PhysicalNamespaceBaseline],
    action: &ExternalNamespaceAction,
    allocation: &Allocation,
) -> (Plan, MetadataNamespacePlan) {
    let legacy = plan_external_namespace(graph, baselines, action, allocation).unwrap();
    let state = metadata(graph);
    let planned = prepare_metadata_namespace(&state, baselines, action, allocation).unwrap();
    assert_eq!(planned.expected_baselines(), legacy.expected_baselines);
    assert_eq!(planned.authored(), legacy.authored);
    assert_eq!(planned.allocated_update_ids(), legacy.allocated_update_ids);
    assert_eq!(planned.candidate().expected_state(), &state);
    assert_eq!(
        planned.candidate().next_state().unwrap(),
        &metadata(&legacy.next_graph)
    );
    assert_eq!(
        planned.candidate().metadata_view().as_v2(),
        &legacy.next_graph.view().unwrap()
    );
    (legacy, planned)
}
fn authored_events(files: &[AuthoredFile]) -> Vec<v2::EntryEvent> {
    files
        .iter()
        .map(
            |file| match v2::Payload::decode(&file.payload_bytes).unwrap().body {
                v2::Body::Events { mut events } => events.remove(0),
                _ => panic!("only bounded namespace events may be authored"),
            },
        )
        .collect()
}
fn with_unseen_text(graph: &v2::State, name: &str) -> v2::State {
    // Trusted restored graph fixture, not an authenticated ingress capability.
    let activity: v2::StoredActivity = serde_json::from_value(serde_json::json!({
        "identity": {
            "realm_id": scope().realm_id, "vault_id": scope().vault_id,
            "entry_id": entry(name), "bootstrap_id": id(&format!("text-{name}"))
        },
        "update_id": "remote-text",
        "namespace": {"bootstrap_id": identity(name).bootstrap_id,
                      "parents": [identity(name).bootstrap_id]},
        "payload_bytes": 64, "payload_digest": Sha256Digest::of(b"checked payload")
    }))
    .unwrap();
    v2::State::from_records(
        scope(),
        revision("remote-text"),
        graph.records().clone(),
        BTreeMap::from([(id("remote-text"), activity)]),
    )
    .unwrap()
}

#[test]
fn stale_saved_delete_retains_unseen_remote_activity_as_conflict() {
    let base = graph(vec![create("note", None, EntryKind::File)]);
    let saved = baseline(&base, "note", "note");
    let current = with_unseen_text(&base, "note");
    let (_, plan) = compare(
        &current,
        &[saved.clone()],
        &ExternalNamespaceAction::Delete {
            root: entry("note"),
        },
        &allocation(&["disk-delete"]),
    );
    assert_eq!(authored_events(plan.authored())[0].parents, saved.heads);
    let next = plan.candidate().verification_state();
    assert!(next.activities().contains_key(&id("remote-text")));
    assert_eq!(
        next.metadata_view().unwrap().namespace().entries[&entry("note")].liveness,
        Liveness::DeleteConflict
    );
}

#[test]
fn offline_namespace_moves_preserve_both_locations_with_identical_payloads() {
    let base = graph(vec![create("note", None, EntryKind::File)]);
    let saved = baseline(&base, "note", "note");
    let current = append(
        &base,
        payload(
            "note",
            "remote-move",
            &["create-note"],
            v2::Effect::Move {
                location: location(None, "remote"),
            },
        ),
    );
    let (_, plan) = compare(
        &current,
        &[saved.clone()],
        &ExternalNamespaceAction::Move {
            root: entry("note"),
            target: location(None, "disk"),
        },
        &allocation(&["disk-move"]),
    );
    assert_eq!(authored_events(plan.authored())[0].parents, saved.heads);
    assert_eq!(
        plan.candidate().metadata_view().namespace().entries[&entry("note")]
            .locations
            .len(),
        2
    );
}

#[test]
fn captured_directory_delete_never_adds_unseen_remote_descendants() {
    let base = graph(vec![
        create("folder", None, EntryKind::Folder),
        create("child", Some("folder"), EntryKind::File),
    ]);
    let saved = [
        baseline(&base, "child", "folder/child"),
        baseline(&base, "folder", "folder"),
    ];
    let current = append(&base, create("new", Some("folder"), EntryKind::File));
    let (_, plan) = compare(
        &current,
        &saved,
        &ExternalNamespaceAction::Delete {
            root: entry("folder"),
        },
        &allocation(&["delete-child", "delete-folder"]),
    );
    assert_eq!(
        authored_events(plan.authored())
            .iter()
            .map(|event| event.identity.entry_id.clone())
            .collect::<Vec<_>>(),
        vec![entry("child"), entry("folder")]
    );
    let view = plan.candidate().metadata_view();
    assert_eq!(
        view.namespace().entries[&entry("new")].liveness,
        Liveness::Live
    );
    assert!(matches!(
        view.namespace().entries[&entry("new")].projection,
        Projection::Recovery { .. }
    ));
}

#[test]
fn folder_move_is_root_only_and_cas_includes_every_saved_physical_witness() {
    let base = graph(vec![
        create("folder", None, EntryKind::Folder),
        create("child", Some("folder"), EntryKind::File),
    ]);
    let saved = [
        baseline(&base, "child", "folder/child"),
        baseline(&base, "folder", "folder"),
    ];
    let (_, plan) = compare(
        &base,
        &saved,
        &ExternalNamespaceAction::Move {
            root: entry("folder"),
            target: location(None, "renamed"),
        },
        &allocation(&["move-folder"]),
    );
    let events = authored_events(plan.authored());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].identity.entry_id, entry("folder"));
    assert_eq!(
        plan.candidate().metadata_view().namespace().entries[&entry("child")].heads,
        vec![id("create-child")]
    );
    let state = metadata(&base);
    plan.check_preconditions(&state, &saved, true).unwrap();
    assert_eq!(
        plan.check_preconditions(&state, &saved, false),
        Err(Error::DuplicateMismatch)
    );
    for field in 0..3 {
        let mut changed = saved.clone();
        match field {
            0 => changed[0].physical_revision = revision("different"),
            1 => changed[0].path = VaultPath::new("elsewhere/child").unwrap(),
            _ => changed[0].location_event = id("different"),
        }
        assert_eq!(
            plan.check_preconditions(&state, &changed, true),
            Err(Error::VersionConflict)
        );
    }
    assert_eq!(
        plan.check_preconditions(plan.candidate().verification_state(), &saved, true),
        Err(Error::VersionConflict)
    );
    let (captured, authored, ids, candidate) = plan.into_parts();
    assert_eq!(captured, saved);
    assert_eq!(authored.len(), 1);
    assert_eq!(ids, vec![id("move-folder")]);
    assert_eq!(candidate.expected_state(), &state);
}

#[test]
fn saved_live_frontier_stays_valid_when_current_state_is_tombstone_or_recovery() {
    let base = graph(vec![create("note", None, EntryKind::File)]);
    let saved = baseline(&base, "note", "note");
    let deleted = append(
        &base,
        payload("note", "delete", &["create-note"], v2::Effect::Delete),
    );
    let conflict = append(
        &deleted,
        payload(
            "note",
            "remote-move",
            &["create-note"],
            v2::Effect::Move {
                location: location(None, "remote"),
            },
        ),
    );
    for current in [&deleted, &conflict] {
        validate_metadata_baselines(&metadata(current), &[saved.clone()]).unwrap();
        compare(
            current,
            &[saved.clone()],
            &ExternalNamespaceAction::Move {
                root: entry("note"),
                target: location(None, "disk"),
            },
            &allocation(&["disk-move"]),
        );
    }
}

#[test]
fn malformed_historical_baselines_match_legacy_rejection() {
    let base = graph(vec![create("note", None, EntryKind::File)]);
    let saved = baseline(&base, "note", "note");
    let current = append(
        &base,
        payload(
            "note",
            "move",
            &["create-note"],
            v2::Effect::Move {
                location: location(None, "new"),
            },
        ),
    );
    for field in 0..8 {
        let mut bad = saved.clone();
        match field {
            0 => bad.heads.clear(),
            1 => bad.heads.push(id("create-note")),
            2 => bad.heads = vec![id("create-note"), id("move")],
            3 => bad.location_event = id("move"),
            4 => bad.kind = EntryKind::Folder,
            5 => bad.identity.bootstrap_id = id("wrong"),
            6 => bad.path = VaultPath::new("fake/note").unwrap(),
            _ => bad.heads = vec![id("missing")],
        }
        let old = validate_baselines(&current, &[bad.clone()]);
        assert!(old.is_err(), "case {field}");
        assert_eq!(
            validate_metadata_baselines(&metadata(&current), &[bad]),
            old
        );
    }
    assert_eq!(
        validate_metadata_baselines(&metadata(&base), &[]),
        validate_baselines(&base, &[])
    );
}

#[test]
fn pending_future_move_does_not_replace_saved_heads_or_invalidate_baseline() {
    let base = graph(vec![create("note", None, EntryKind::File)]);
    let saved = baseline(&base, "note", "note");
    let current = append(
        &base,
        payload(
            "note",
            "pending",
            &["missing"],
            v2::Effect::Move {
                location: location(None, "future"),
            },
        ),
    );
    let (_, plan) = compare(
        &current,
        &[saved.clone()],
        &ExternalNamespaceAction::Delete {
            root: entry("note"),
        },
        &allocation(&["disk-delete"]),
    );
    assert_eq!(authored_events(plan.authored())[0].parents, saved.heads);
    assert!(plan
        .candidate()
        .metadata_view()
        .namespace()
        .pending
        .contains(&id("pending")));
}

struct NoChunks;
impl ChunkSource for NoChunks {
    fn read_chunk(&mut self, _: &Scope, _: &UpdateId, _: &GraphRecord) -> Result<Vec<u8>> {
        panic!("historical namespace planning must not read binary content")
    }
}

#[test]
fn missing_historical_binary_needs_no_bytes_for_namespace_plan_or_pending_finalize() {
    let manifest = Manifest {
        bytes: 5,
        digest: Sha256Digest::of(b"bytes"),
        pages: vec![crate::PageRef {
            id: id("missing-page"),
            bytes: 5,
            digest: Sha256Digest::of(b"page"),
        }],
    };
    let base = graph(vec![payload(
        "file",
        "create-file",
        &[],
        v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: location(None, "file"),
            content: Some(v2::ContentSeed::Binary { manifest }),
        },
    )]);
    let saved = baseline(&base, "file", "file");
    let (_, plan) = compare(
        &base,
        &[saved],
        &ExternalNamespaceAction::Move {
            root: entry("file"),
            target: location(None, "moved"),
        },
        &allocation(&["disk-move"]),
    );
    for record in plan.candidate().verification_state().records().values() {
        assert!(matches!(record.body(), GraphRecordBody::Events { .. }));
    }
    let proof =
        verify_complete_binary_manifests(plan.candidate().verification_state(), &mut NoChunks)
            .unwrap();
    assert!(proof.is_empty());
    plan.into_parts().3.finalize(proof).unwrap();
}

#[test]
fn transient_root_move_then_captured_child_delete_matches_legacy_compound_graph() {
    let base = graph(vec![
        create("folder", None, EntryKind::Folder),
        create("child", Some("folder"), EntryKind::File),
        create("unseen", Some("folder"), EntryKind::File),
    ]);
    let child = baseline(&base, "child", "folder/child");
    let captured = [child.clone(), baseline(&base, "folder", "folder")];
    let (legacy_move, metadata_move) = compare(
        &base,
        &captured,
        &ExternalNamespaceAction::Move {
            root: entry("folder"),
            target: location(None, "renamed"),
        },
        &allocation(&["move-folder"]),
    );
    let action = ExternalNamespaceAction::Delete {
        root: entry("child"),
    };
    let allocation = allocation(&["delete-child"]);
    let expected = plan_external_namespace(
        &legacy_move.next_graph,
        &[child.clone()],
        &action,
        &allocation,
    )
    .unwrap();
    let actual = prepare_metadata_namespace(
        metadata_move.candidate().verification_state(),
        &[child],
        &action,
        &allocation,
    )
    .unwrap();
    assert_eq!(actual.authored(), expected.authored);
    assert_eq!(
        actual.candidate().verification_state(),
        &metadata(&expected.next_graph)
    );
    assert_eq!(
        actual.candidate().metadata_view().namespace().entries[&entry("unseen")].projection,
        Projection::Normal {
            path: VaultPath::new("renamed/unseen").unwrap()
        }
    );
}

#[test]
fn binary_move_away_back_keeps_old_physical_frontier_separate_from_equal_byte_remote_head() {
    let manifest = Manifest {
        bytes: 0,
        digest: Sha256Digest::of(&[]),
        pages: vec![],
    };
    let base = graph(vec![payload(
        "file",
        "create-file",
        &[],
        v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: location(None, "file"),
            content: Some(v2::ContentSeed::Binary {
                manifest: manifest.clone(),
            }),
        },
    )]);
    let saved = baseline(&base, "file", "file");
    let current = append(
        &base,
        payload(
            "file",
            "remote-content",
            &["create-file"],
            v2::Effect::SetContent { content: manifest },
        ),
    );
    let (away_legacy, away) = compare(
        &current,
        &[saved.clone()],
        &ExternalNamespaceAction::Move {
            root: entry("file"),
            target: location(None, "away"),
        },
        &allocation(&["disk-away"]),
    );
    let away_state = away.candidate().verification_state();
    let heads = away_state
        .join_physical_move_frontier(&saved.identity, &saved.heads, &id("disk-away"))
        .unwrap();
    assert_eq!(heads, vec![id("disk-away")]);
    assert_eq!(
        heads,
        away_legacy
            .next_graph
            .join_physical_move_frontier(&saved.identity, &saved.heads, &id("disk-away"))
            .unwrap()
    );
    let mut physically_away = saved.clone();
    physically_away.path = VaultPath::new("away").unwrap();
    physically_away.physical_revision = revision("physically-away");
    physically_away.location_event = id("disk-away");
    physically_away.heads = heads;
    let (back_legacy, back) = compare(
        &away_legacy.next_graph,
        &[physically_away.clone()],
        &ExternalNamespaceAction::Move {
            root: entry("file"),
            target: location(None, "file"),
        },
        &allocation(&["disk-back"]),
    );
    let back_state = back.candidate().verification_state();
    let heads = back_state
        .join_physical_move_frontier(&saved.identity, &physically_away.heads, &id("disk-back"))
        .unwrap();
    assert_eq!(heads, vec![id("disk-back")]);
    assert_eq!(
        heads,
        back_legacy
            .next_graph
            .join_physical_move_frontier(&saved.identity, &physically_away.heads, &id("disk-back"))
            .unwrap()
    );
    assert!(!heads.contains(&id("remote-content")));
    let content = back_state
        .binary_content_ref(&saved.identity, &id("remote-content"))
        .unwrap();
    assert_eq!(content.selected_event(), &id("remote-content"));
    assert_eq!(
        back_state.metadata_view().unwrap().namespace().entries[&entry("file")]
            .contents
            .last()
            .unwrap()
            .event,
        id("remote-content")
    );
}

#[test]
fn metadata_move_frontier_rejects_cross_entry_pending_restore_and_dominated_prior() {
    let base = graph(vec![
        create("note", None, EntryKind::File),
        create("folder", None, EntryKind::Folder),
    ]);
    let moved = append(
        &base,
        payload(
            "note",
            "move",
            &["create-note"],
            v2::Effect::Move {
                location: location(None, "moved"),
            },
        ),
    );
    let pending = append(
        &moved,
        payload(
            "note",
            "pending",
            &["missing"],
            v2::Effect::Move {
                location: location(None, "pending"),
            },
        ),
    );
    let restored = append(
        &pending,
        payload(
            "note",
            "restore",
            &["move"],
            v2::Effect::Restore {
                location: location(None, "restored"),
            },
        ),
    );
    let state = metadata(&restored);
    for (prior, applied) in [
        (vec![], id("move")),
        (vec![id("create-note"), id("move")], id("move")),
        (vec![id("create-folder")], id("move")),
        (vec![id("create-note")], id("pending")),
        (vec![id("pending")], id("move")),
        (vec![id("create-note")], id("restore")),
    ] {
        let expected = restored.join_physical_move_frontier(&identity("note"), &prior, &applied);
        assert!(expected.is_err());
        assert_eq!(
            state.join_physical_move_frontier(&identity("note"), &prior, &applied),
            expected
        );
    }
}

#[test]
fn external_allocations_reserve_missing_parent_page_chunk_and_text_bootstrap_ids() {
    let note = graph(vec![create("note", None, EntryKind::File)]);
    let saved_note = baseline(&note, "note", "note");
    let pending = append(
        &note,
        payload(
            "note",
            "pending",
            &["missing-parent"],
            v2::Effect::Move {
                location: location(None, "future"),
            },
        ),
    );
    let missing_page = Manifest {
        bytes: 1,
        digest: Sha256Digest::of(b"x"),
        pages: vec![crate::PageRef {
            id: id("missing-page"),
            bytes: 1,
            digest: Sha256Digest::of(b"page"),
        }],
    };
    let file = graph(vec![payload(
        "file",
        "create-file",
        &[],
        v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: location(None, "file"),
            content: Some(v2::ContentSeed::Binary {
                manifest: missing_page,
            }),
        },
    )]);
    let saved_file = baseline(&file, "file", "file");
    let mut orphan = create("note", None, EntryKind::File);
    orphan.id = id("orphan-page");
    orphan.body = v2::Body::Page {
        page: crate::ChunkPage {
            chunks: vec![crate::ChunkRef {
                id: id("missing-chunk"),
                bytes: 1,
                digest: Sha256Digest::of(b"x"),
            }],
        },
    };
    let orphan = append(&note, orphan);
    for (current, saved, update) in [
        (&pending, &saved_note, "missing-parent"),
        (&file, &saved_file, "missing-page"),
        (&orphan, &saved_note, "missing-chunk"),
        (&note, &saved_note, "text-note"),
    ] {
        let action = ExternalNamespaceAction::Delete {
            root: saved.identity.entry_id.clone(),
        };
        let allocation = allocation(&[update]);
        assert_eq!(
            plan_external_namespace(current, &[saved.clone()], &action, &allocation).unwrap_err(),
            Error::DuplicateMismatch
        );
        assert_eq!(
            prepare_metadata_namespace(&metadata(current), &[saved.clone()], &action, &allocation)
                .unwrap_err(),
            Error::DuplicateMismatch
        );
    }
}

#[test]
fn captured_descendant_chain_noop_and_in_tree_move_rejections_match_legacy() {
    let base = graph(vec![
        create("folder", None, EntryKind::Folder),
        create("child", Some("folder"), EntryKind::Folder),
        create("note", Some("child"), EntryKind::File),
    ]);
    let folder = baseline(&base, "folder", "folder");
    let child = baseline(&base, "child", "folder/child");
    let note = baseline(&base, "note", "folder/child/note");
    let cases = [
        (
            vec![folder.clone(), note],
            ExternalNamespaceAction::Delete {
                root: entry("folder"),
            },
            allocation(&["delete-folder", "delete-note"]),
        ),
        (
            vec![child.clone(), folder.clone()],
            ExternalNamespaceAction::Move {
                root: entry("folder"),
                target: location(Some("child"), "nested"),
            },
            allocation(&["nested-move"]),
        ),
        (
            vec![child.clone(), folder.clone()],
            ExternalNamespaceAction::Move {
                root: entry("folder"),
                target: location(None, "folder"),
            },
            allocation(&["noop-move"]),
        ),
        (
            vec![folder, child],
            ExternalNamespaceAction::Delete {
                root: entry("folder"),
            },
            allocation(&["delete-folder", "delete-child"]),
        ),
    ];
    for (saved, action, allocation) in cases {
        let expected = plan_external_namespace(&base, &saved, &action, &allocation).unwrap_err();
        assert_eq!(
            prepare_metadata_namespace(&metadata(&base), &saved, &action, &allocation).unwrap_err(),
            expected
        );
    }
}
