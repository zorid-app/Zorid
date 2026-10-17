use super::*;
use crate::binary_stream::{verify_complete_binary_manifests, ChunkSource};
use crate::metadata::GraphRecord;
use crate::mutation::{self, NewText, TextAllocation, TextRequirement};
use crate::Scope;
use std::collections::BTreeMap;
use zorid_client_sync::{ActorOwner, ActorRegistration};
use zorid_core::{EntryId, OperationId, Revision, VaultPath};
use zorid_sync_protocol::{DeviceId, RealmId, VaultId};
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
fn create(op: &str, name: &str, kind: EntryKind, content: Option<Vec<u8>>) -> MutationRequest {
    request(
        op,
        Mutation::Create {
            id: id(op),
            path: path(name),
            kind,
            content,
        },
    )
}
fn empty() -> v2::State {
    v2::State::empty(
        Scope {
            realm_id: RealmId::new("r").unwrap(),
            vault_id: VaultId::new("v").unwrap(),
        },
        rev("initial"),
    )
}
fn allocation(
    req: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> Allocation {
    let need = mutation::requirements(req, entries, graph, mode, text).unwrap();
    let op = req.operation_id.as_str();
    Allocation {
        metadata_revision: rev(&format!("{op}-metadata")),
        graph_revision: rev(&format!("{op}-graph")),
        update_ids: (0..need.update_count)
            .map(|n| update(&format!("{op}-{n}")))
            .collect(),
        text: match need.text {
            TextRequirement::None => None,
            kind => Some(TextAllocation {
                actor: ActorRegistration {
                    actor: 7,
                    owner: ActorOwner {
                        replica_id: DeviceId::new("device").unwrap(),
                        incarnation_id: OperationId::new("incarnation").unwrap(),
                    },
                },
                new_text: (kind == TextRequirement::Create).then(|| NewText {
                    bootstrap_id: update(&format!("{op}-bootstrap")),
                    empty_revision: rev(&format!("{op}-empty")),
                }),
            }),
        },
    }
}
fn legacy(
    req: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> mutation::MutationPlan {
    mutation::plan_mutation(
        req,
        entries,
        graph,
        mode,
        text,
        &allocation(req, entries, graph, mode, text),
    )
    .unwrap()
}
fn after(entries: &[EntryState], plan: &mutation::MutationPlan) -> Vec<EntryState> {
    let mut rows: BTreeMap<_, _> = entries
        .iter()
        .map(|entry| (entry.id.clone(), entry.clone()))
        .collect();
    for change in &plan.changes {
        rows.insert(change.after.id.clone(), change.after.clone());
    }
    rows.into_values().collect()
}
fn compare(
    req: &MutationRequest,
    entries: &[EntryState],
    graph: &v2::State,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> mutation::MutationPlan {
    let metadata = MetadataState::from_legacy(graph).unwrap();
    assert_eq!(
        requirements(req, entries, &metadata, mode, text).unwrap(),
        mutation::requirements(req, entries, graph, mode, text).unwrap()
    );
    let allocation = allocation(req, entries, graph, mode, text);
    let old = mutation::plan_mutation(req, entries, graph, mode, text, &allocation).unwrap();
    let new = prepare_mutation(req, entries, &metadata, mode, text, &allocation).unwrap();
    assert_eq!(new.changes(), old.changes);
    assert_eq!(new.authored_files(), old.authored_files);
    assert_eq!(new.text(), old.text.as_ref());
    assert_eq!(new.allocated_update_ids(), old.allocated_update_ids);
    assert_eq!(
        new.candidate().verification_state(),
        &MetadataState::from_legacy(&old.next_graph).unwrap()
    );
    new.check_preconditions(entries, &metadata, text, true)
        .unwrap();
    assert_eq!(
        new.check_preconditions(entries, &metadata, text, false)
            .unwrap_err(),
        Error::InvalidAllocation
    );
    old
}
fn binary_fixture() -> (v2::State, Vec<EntryState>) {
    let folder = legacy(
        &create("folder", "folder", EntryKind::Folder, None),
        &[],
        &empty(),
        None,
        None,
    );
    let entries = after(&[], &folder);
    let binary = legacy(
        &create(
            "binary",
            "folder/data.bin",
            EntryKind::File,
            Some(vec![1, 2, 3]),
        ),
        &entries,
        &folder.next_graph,
        Some(CreateMode::Binary),
        None,
    );
    (binary.next_graph.clone(), after(&entries, &binary))
}
#[test]
fn namespace_commands_match_legacy_beside_retained_binary_content() {
    let (graph, entries) = binary_fixture();
    let extra = compare(
        &create("empty-folder", "folder/child", EntryKind::Folder, None),
        &entries,
        &graph,
        None,
        None,
    );
    let entries = after(&entries, &extra);
    let root = entries
        .iter()
        .find(|entry| entry.id == id("folder"))
        .unwrap();
    let moved = compare(
        &request(
            "move",
            Mutation::Move {
                id: root.id.clone(),
                expected: root.revision.clone(),
                path: path("renamed"),
            },
        ),
        &entries,
        &extra.next_graph,
        None,
        None,
    );
    let entries = after(&entries, &moved);
    let root = entries
        .iter()
        .find(|entry| entry.id == id("folder"))
        .unwrap();
    compare(
        &request(
            "delete",
            Mutation::Delete {
                id: root.id.clone(),
                expected: root.revision.clone(),
                recursive: true,
            },
        ),
        &entries,
        &moved.next_graph,
        None,
        None,
    );
}
#[test]
fn text_create_and_write_keep_exact_namespace_context_and_payload() {
    let (graph, entries) = binary_fixture();
    let created = compare(
        &create(
            "text",
            "folder/note.md",
            EntryKind::File,
            Some("😀first\r\n".as_bytes().to_vec()),
        ),
        &entries,
        &graph,
        Some(CreateMode::Text),
        None,
    );
    let entries = after(&entries, &created);
    let state = created.text.as_ref().unwrap().plan().next_state.clone();
    let target = entries.iter().find(|entry| entry.id == id("text")).unwrap();
    compare(
        &request(
            "write",
            Mutation::Write {
                id: target.id.clone(),
                expected: target.revision.clone(),
                content: "é changed\r\n".as_bytes().to_vec(),
            },
        ),
        &entries,
        &created.next_graph,
        None,
        Some(&state),
    );
}
#[test]
fn inline_binary_commands_cannot_bypass_the_staged_mapper() {
    let (graph, entries) = binary_fixture();
    let metadata = MetadataState::from_legacy(&graph).unwrap();
    assert_eq!(
        requirements(
            &create("other", "other.bin", EntryKind::File, Some(vec![])),
            &entries,
            &metadata,
            Some(CreateMode::Binary),
            None
        )
        .unwrap_err(),
        Error::InvalidMode
    );
    let binary = entries
        .iter()
        .find(|entry| entry.id == id("binary"))
        .unwrap();
    assert_eq!(
        requirements(
            &request(
                "write",
                Mutation::Write {
                    id: binary.id.clone(),
                    expected: binary.revision.clone(),
                    content: vec![]
                }
            ),
            &entries,
            &metadata,
            None,
            None
        )
        .unwrap_err(),
        Error::InvalidMode
    );
}
struct Missing;
impl ChunkSource for Missing {
    fn read_chunk(&mut self, _: &Scope, _: &UpdateId, _: &GraphRecord) -> crate::Result<Vec<u8>> {
        Err(crate::Error::InvalidState)
    }
}
#[test]
fn namespace_preparation_never_loads_binary_but_finalize_requires_backing_integrity() {
    let (graph, entries) = binary_fixture();
    let metadata = MetadataState::from_legacy(&graph).unwrap();
    let file = entries
        .iter()
        .find(|entry| entry.id == id("binary"))
        .unwrap();
    let req = request(
        "move",
        Mutation::Move {
            id: file.id.clone(),
            expected: file.revision.clone(),
            path: path("folder/new.bin"),
        },
    );
    let prepared = prepare_mutation(
        &req,
        &entries,
        &metadata,
        None,
        None,
        &allocation(&req, &entries, &graph, None, None),
    )
    .unwrap();
    assert_eq!(prepared.authored_files().len(), 1);
    assert_eq!(
        verify_complete_binary_manifests(prepared.candidate().verification_state(), &mut Missing)
            .unwrap_err(),
        crate::Error::InvalidState
    );
}
#[test]
fn stale_text_and_allocation_are_checked_without_reading_attachments() {
    let (graph, entries) = binary_fixture();
    let req = create("text", "folder/note", EntryKind::File, Some(b"hi".to_vec()));
    let metadata = MetadataState::from_legacy(&graph).unwrap();
    let mut allocation = allocation(&req, &entries, &graph, Some(CreateMode::Text), None);
    allocation.update_ids[0] = graph.records().keys().next().unwrap().clone();
    assert_eq!(
        prepare_mutation(
            &req,
            &entries,
            &metadata,
            Some(CreateMode::Text),
            None,
            &allocation
        )
        .unwrap_err(),
        Error::InvalidAllocation
    );
    let created = legacy(&req, &entries, &graph, Some(CreateMode::Text), None);
    let entries = after(&entries, &created);
    let current = created.text.as_ref().unwrap().plan().next_state.clone();
    let mut stale = current.clone();
    stale.version = rev("stale");
    let req = request(
        "write",
        Mutation::Write {
            id: id("text"),
            expected: current.version.clone(),
            content: b"next".to_vec(),
        },
    );
    let metadata = MetadataState::from_legacy(&created.next_graph).unwrap();
    assert_eq!(
        requirements(&req, &entries, &metadata, None, Some(&stale)).unwrap_err(),
        Error::SnapshotMismatch
    );
}
#[test]
fn omitted_destination_occupants_and_partial_recursive_subtrees_stay_blocked() {
    let (graph, entries) = binary_fixture();
    let metadata = MetadataState::from_legacy(&graph).unwrap();
    let only_folder: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Folder)
        .cloned()
        .collect();
    assert_eq!(
        requirements(
            &create("other", "folder/data.bin", EntryKind::Folder, None),
            &only_folder,
            &metadata,
            None,
            None
        )
        .unwrap_err(),
        Error::SnapshotMismatch
    );
    let root = &only_folder[0];
    assert_eq!(
        requirements(
            &request(
                "delete",
                Mutation::Delete {
                    id: root.id.clone(),
                    expected: root.revision.clone(),
                    recursive: true
                }
            ),
            &only_folder,
            &metadata,
            None,
            None
        )
        .unwrap_err(),
        Error::SnapshotMismatch
    );
}
