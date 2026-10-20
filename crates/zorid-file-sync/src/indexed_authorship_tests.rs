use super::*;
use std::collections::{BTreeMap, BTreeSet};
use zorid_client_sync::{ActorOwner, ActorRegistration};
use zorid_core::{MutationRequest, OperationId};
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
fn empty() -> v2::State {
    v2::State::empty(
        Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        },
        rev("initial"),
    )
}
fn command(op: &str, mutation: Mutation, mode: Option<CreateMode>) -> FamilyCommand {
    FamilyCommand::new(
        MutationRequest {
            operation_id: OperationId::new(op).unwrap(),
            mutation,
        },
        mode,
    )
    .unwrap()
}
fn create(op: &str, name: &str, kind: EntryKind) -> FamilyCommand {
    command(
        op,
        Mutation::Create {
            id: id(op),
            path: path(name),
            kind,
            content: (kind == EntryKind::File).then(|| "😀 first\r\n".as_bytes().to_vec()),
        },
        (kind == EntryKind::File).then_some(CreateMode::Text),
    )
}
#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Mapping(Error),
    Admission,
}
impl From<Error> for Failure {
    fn from(e: Error) -> Self {
        Self::Mapping(e)
    }
}
struct Reader<'a> {
    entries: &'a [EntryState],
    graph: &'a v2::State,
    work: Vec<AuthorshipWork>,
    fail_at: Option<usize>,
    max_emit: usize,
    max_retain: usize,
    retained: usize,
    reserved: BTreeSet<UpdateId>,
    wrong_head_order: bool,
    oversized_heads: bool,
    empty_heads: bool,
}
impl<'a> Reader<'a> {
    fn new(graph: &'a v2::State, entries: &'a [EntryState]) -> Self {
        Self {
            graph,
            entries,
            work: vec![],
            fail_at: None,
            max_emit: usize::MAX,
            max_retain: usize::MAX,
            retained: 0,
            reserved: BTreeSet::new(),
            wrong_head_order: false,
            oversized_heads: false,
            empty_heads: false,
        }
    }
}
// Whole-graph construction is exclusively a small TEST oracle, not the reader
// implementation or production source/selector proof proposed for Store.
impl IndexedAuthorshipReader for Reader<'_> {
    type Error = Failure;
    fn admit(&mut self, work: AuthorshipWork) -> Result<(), Failure> {
        self.work.push(work);
        if let AuthorshipWork::Retain { encoded_bytes } = work {
            self.retained = self
                .retained
                .checked_add(encoded_bytes)
                .ok_or(Failure::Admission)?;
        }
        if self.fail_at == Some(self.work.len())
            || matches!(work, AuthorshipWork::Emit { encoded_bytes } if encoded_bytes > self.max_emit)
            || self.retained > self.max_retain
        {
            return Err(Failure::Admission);
        }
        Ok(())
    }
    fn entry(&mut self, target: &EntryId) -> Result<Option<AuthoringEntry>, Failure> {
        self.admit(AuthorshipWork::Retain {
            encoded_bytes: 64 * 1024,
        })?;
        let Some(materialized) = self.entries.iter().find(|e| e.id == *target) else {
            return Ok(None);
        };
        let view = self.graph.view().unwrap();
        let e = view.namespace.entries.get(target).unwrap();
        let mut heads = e.heads.clone();
        if self.wrong_head_order {
            heads = vec![update("z"), update("a")];
        }
        if self.oversized_heads {
            heads = (0..=MAX_PARENTS)
                .map(|i| update(&format!("head-{i:03}")))
                .collect();
        }
        if self.empty_heads {
            heads.clear();
        }
        Ok(Some(AuthoringEntry {
            materialized: materialized.clone(),
            identity: e.identity.clone(),
            heads,
            binding: view.content_bindings.get(target).cloned(),
            preferred_binary_content_event: e.contents.last().map(|h| h.event.clone()),
        }))
    }
    fn known_entry(&mut self, target: &EntryId) -> Result<bool, Failure> {
        Ok(self
            .graph
            .view()
            .unwrap()
            .namespace
            .entries
            .contains_key(target))
    }
    fn destination_parent(
        &mut self,
        destination: &VaultPath,
    ) -> Result<Option<EntryState>, Failure> {
        self.admit(AuthorshipWork::Retain {
            encoded_bytes: 4096,
        })?;
        Ok(self
            .entries
            .iter()
            .find(|e| {
                !e.deleted
                    && e.kind == EntryKind::Folder
                    && Some(&e.path) == destination.parent().as_ref()
            })
            .cloned())
    }
    fn require_fresh_revision(&mut self, revision: &Revision) -> Result<(), Failure> {
        if revision == self.graph.version() || self.entries.iter().any(|e| e.revision == *revision)
        {
            Err(Error::InvalidAllocation.into())
        } else {
            Ok(())
        }
    }
    fn require_unused_update_id(&mut self, id: &UpdateId) -> Result<(), Failure> {
        if self.graph.records().contains_key(id)
            || self.graph.activities().contains_key(id)
            || self.reserved.contains(id)
        {
            Err(Error::InvalidAllocation.into())
        } else {
            Ok(())
        }
    }
}
fn allocation(
    c: &FamilyCommand,
    entries: &[EntryState],
    graph: &v2::State,
    text: Option<&TextState>,
) -> Allocation {
    let need = mutation::requirements(&c.request, entries, graph, c.create_mode, text).unwrap();
    let op = c.request.operation_id.as_str();
    Allocation {
        metadata_revision: rev(&format!("{op}-metadata")),
        graph_revision: rev(&format!("{op}-graph")),
        update_ids: (0..need.update_count)
            .map(|n| update(&format!("{op}-{n}")))
            .collect(),
        text: match need.text {
            TextRequirement::None => None,
            kind => Some(mutation::TextAllocation {
                actor: ActorRegistration {
                    actor: 7,
                    owner: ActorOwner {
                        replica_id: DeviceId::new("device").unwrap(),
                        incarnation_id: OperationId::new("incarnation").unwrap(),
                    },
                },
                new_text: (kind == TextRequirement::Create).then(|| mutation::NewText {
                    bootstrap_id: update(&format!("{op}-bootstrap")),
                    empty_revision: rev(&format!("{op}-empty")),
                }),
            }),
        },
    }
}
fn compare(
    c: &FamilyCommand,
    entries: &[EntryState],
    graph: &v2::State,
    text: Option<&TextState>,
) -> mutation::MutationPlan {
    let a = allocation(c, entries, graph, text);
    let old = mutation::plan_mutation(&c.request, entries, graph, c.create_mode, text, &a).unwrap();
    let mut reader = Reader::new(graph, entries);
    assert_eq!(
        requirements(c, &old.changes, text, &mut reader).unwrap(),
        mutation::requirements(&c.request, entries, graph, c.create_mode, text).unwrap()
    );
    let candidate = author(c, graph.scope(), &old.changes, text, &a, &mut reader).unwrap();
    assert_eq!(candidate.authored_files(), old.authored_files);
    assert_eq!(candidate.text(), old.text.as_ref());
    if let Some(activity) = candidate.activity() {
        assert_eq!(
            old.next_graph.activities().get(activity.update_id()),
            Some(activity)
        );
    } else {
        assert!(old.text.is_none());
    }
    old
}
fn after(entries: &[EntryState], plan: &mutation::MutationPlan) -> Vec<EntryState> {
    let mut all: BTreeMap<_, _> = entries.iter().map(|e| (e.id.clone(), e.clone())).collect();
    for change in &plan.changes {
        all.insert(change.after.id.clone(), change.after.clone());
    }
    all.into_values().collect()
}
fn fixture() -> (v2::State, Vec<EntryState>, TextState) {
    let folder = compare(
        &create("folder", "folder", EntryKind::Folder),
        &[],
        &empty(),
        None,
    );
    let entries = after(&[], &folder);
    let note = compare(
        &create("note", "folder/note.md", EntryKind::File),
        &entries,
        &folder.next_graph,
        None,
    );
    let text = note.text.as_ref().unwrap().plan().next_state.clone();
    (note.next_graph.clone(), after(&entries, &note), text)
}
#[test]
fn text_and_folder_create_are_byte_identical_to_legacy() {
    fixture();
}
#[test]
fn text_write_is_byte_identical_and_authors_only_activity() {
    let (graph, entries, text) = fixture();
    let c = command(
        "write",
        Mutation::Write {
            id: id("note"),
            expected: text.version.clone(),
            content: "changed é\n".as_bytes().to_vec(),
        },
        None,
    );
    let plan = compare(&c, &entries, &graph, Some(&text));
    assert!(plan.authored_files.is_empty());
}
#[test]
fn move_and_recursive_delete_exclude_ancestor_bumps_from_events() {
    let (graph, entries, _) = fixture();
    let folder = entries.iter().find(|e| e.id == id("folder")).unwrap();
    let c = command(
        "move",
        Mutation::Move {
            id: folder.id.clone(),
            expected: folder.revision.clone(),
            path: path("renamed"),
        },
        None,
    );
    let moved = compare(&c, &entries, &graph, None);
    assert_eq!(moved.authored_files.len(), 1);
    let entries = after(&entries, &moved);
    let folder = entries.iter().find(|e| e.id == id("folder")).unwrap();
    let deleted = compare(
        &command(
            "delete",
            Mutation::Delete {
                id: folder.id.clone(),
                expected: folder.revision.clone(),
                recursive: true,
            },
            None,
        ),
        &entries,
        &moved.next_graph,
        None,
    );
    assert_eq!(deleted.authored_files.len(), 2);
    assert!(deleted.authored_files.iter().all(|f| matches!(
        v2::Payload::decode(&f.payload_bytes).unwrap().body,
        v2::Body::ObservedDelete { .. }
    )));
}
#[test]
fn exact_destination_parent_guard_is_rechecked() {
    let (graph, entries, _) = fixture();
    let note = entries.iter().find(|e| e.id == id("note")).unwrap();
    let mut c = command(
        "move",
        Mutation::Move {
            id: note.id.clone(),
            expected: note.revision.clone(),
            path: path("folder/renamed.md"),
        },
        None,
    );
    c.destination_parent = Some(DestinationParent::Folder {
        id: id("wrong"),
        revision: rev("wrong"),
        path: path("folder"),
    });
    let a = allocation(&c, &entries, &graph, None);
    let rows = zorid_core::plan_mutation(&c.request, &entries, &a.metadata_revision).unwrap();
    assert_eq!(
        author(
            &c,
            graph.scope(),
            &rows,
            None,
            &a,
            &mut Reader::new(&graph, &entries)
        )
        .unwrap_err(),
        Failure::Mapping(Error::SnapshotMismatch)
    );
}
#[test]
fn text_scope_bootstrap_and_revision_mismatches_fail() {
    let (graph, entries, text) = fixture();
    let c = command(
        "write",
        Mutation::Write {
            id: id("note"),
            expected: text.version.clone(),
            content: vec![],
        },
        None,
    );
    let a = allocation(&c, &entries, &graph, Some(&text));
    let rows = zorid_core::plan_mutation(&c.request, &entries, &a.metadata_revision).unwrap();
    let mut wrong = text.clone();
    wrong.identity.vault_id = VaultId::new("other").unwrap();
    assert_eq!(
        author(
            &c,
            graph.scope(),
            &rows,
            Some(&wrong),
            &a,
            &mut Reader::new(&graph, &entries)
        )
        .unwrap_err(),
        Failure::Mapping(Error::SnapshotMismatch)
    );
    let mut wrong = text.clone();
    wrong.identity.bootstrap_id = update("wrong");
    assert!(author(
        &c,
        graph.scope(),
        &rows,
        Some(&wrong),
        &a,
        &mut Reader::new(&graph, &entries)
    )
    .is_err());
    let mut wrong = text;
    wrong.version = rev("wrong");
    assert!(author(
        &c,
        graph.scope(),
        &rows,
        Some(&wrong),
        &a,
        &mut Reader::new(&graph, &entries)
    )
    .is_err());
}
#[test]
fn missing_unsorted_or_oversized_frontier_fails() {
    let (graph, entries, text) = fixture();
    let c = command(
        "write",
        Mutation::Write {
            id: id("note"),
            expected: text.version.clone(),
            content: vec![],
        },
        None,
    );
    let a = allocation(&c, &entries, &graph, Some(&text));
    let rows = zorid_core::plan_mutation(&c.request, &entries, &a.metadata_revision).unwrap();
    let mut r = Reader::new(&graph, &entries);
    r.empty_heads = true;
    assert_eq!(
        author(&c, graph.scope(), &rows, Some(&text), &a, &mut r).unwrap_err(),
        Failure::Mapping(Error::SnapshotMismatch)
    );
    let mut r = Reader::new(&graph, &entries);
    r.wrong_head_order = true;
    assert!(author(&c, graph.scope(), &rows, Some(&text), &a, &mut r).is_err());
    let mut r = Reader::new(&graph, &entries);
    r.oversized_heads = true;
    assert_eq!(
        author(&c, graph.scope(), &rows, Some(&text), &a, &mut r).unwrap_err(),
        Failure::Mapping(large())
    );
}
#[test]
fn reserved_or_duplicate_allocation_fails() {
    let graph = empty();
    let c = create("note", "note.md", EntryKind::File);
    let a = allocation(&c, &[], &graph, None);
    let rows = zorid_core::plan_mutation(&c.request, &[], &a.metadata_revision).unwrap();
    let mut r = Reader::new(&graph, &[]);
    r.reserved.insert(a.update_ids[0].clone());
    assert_eq!(
        author(&c, graph.scope(), &rows, None, &a, &mut r).unwrap_err(),
        Failure::Mapping(Error::InvalidAllocation)
    );
    let mut wrong = a;
    wrong.update_ids[1] = wrong.update_ids[0].clone();
    assert_eq!(
        author(
            &c,
            graph.scope(),
            &rows,
            None,
            &wrong,
            &mut Reader::new(&graph, &[])
        )
        .unwrap_err(),
        Failure::Mapping(Error::InvalidAllocation)
    );
}
#[test]
fn every_admission_failure_returns_no_candidate() {
    let graph = empty();
    let c = create("note", "note.md", EntryKind::File);
    let a = allocation(&c, &[], &graph, None);
    let rows = zorid_core::plan_mutation(&c.request, &[], &a.metadata_revision).unwrap();
    let mut reference = Reader::new(&graph, &[]);
    author(&c, graph.scope(), &rows, None, &a, &mut reference).unwrap();
    for n in 1..=reference.work.len() {
        let mut r = Reader::new(&graph, &[]);
        r.fail_at = Some(n);
        assert_eq!(
            author(&c, graph.scope(), &rows, None, &a, &mut r).unwrap_err(),
            Failure::Admission,
            "step {n}"
        );
    }
}
#[test]
fn output_budget_rejects_before_text_crdt_planning() {
    let graph = empty();
    let c = create("note", "note.md", EntryKind::File);
    let a = allocation(&c, &[], &graph, None);
    let rows = zorid_core::plan_mutation(&c.request, &[], &a.metadata_revision).unwrap();
    let mut r = Reader::new(&graph, &[]);
    r.max_emit = 64 * 1024;
    assert_eq!(
        author(&c, graph.scope(), &rows, None, &a, &mut r).unwrap_err(),
        Failure::Admission
    );
    assert!(
        matches!(r.work.last(), Some(AuthorshipWork::Emit { encoded_bytes }) if *encoded_bytes > 64 * 1024)
    );
}
#[test]
fn retained_text_output_budget_rejects_before_crdt_planning() {
    let (graph, entries, mut text) = fixture();
    let c = command(
        "write",
        Mutation::Write {
            id: id("note"),
            expected: text.version.clone(),
            content: b"new".to_vec(),
        },
        None,
    );
    let a = allocation(&c, &entries, &graph, Some(&text));
    let rows = zorid_core::plan_mutation(&c.request, &entries, &a.metadata_revision).unwrap();
    // This malformed snapshot would fail inside the CRDT planner. A separate
    // retained-output ceiling must reject earlier even with unlimited Emit.
    text.snapshot = vec![255];
    let mut r = Reader::new(&graph, &entries);
    r.max_retain = 256 * 1024;
    assert_eq!(
        author(&c, graph.scope(), &rows, Some(&text), &a, &mut r).unwrap_err(),
        Failure::Admission
    );
    assert!(
        matches!(r.work.last(), Some(AuthorshipWork::Retain { encoded_bytes }) if *encoded_bytes > 256 * 1024)
    );
    assert!(!r
        .work
        .iter()
        .any(|w| matches!(w, AuthorshipWork::Emit { .. })));
    assert_eq!(
        author(
            &c,
            graph.scope(),
            &rows,
            Some(&text),
            &a,
            &mut Reader::new(&graph, &entries)
        )
        .unwrap_err(),
        Failure::Mapping(Error::Text(zorid_client_sync::SyncError::InvalidState))
    );
}
fn binary_create() -> (FamilyCommand, mutation::MutationPlan) {
    binary_create_content(vec![])
}
fn binary_create_content(bytes: Vec<u8>) -> (FamilyCommand, mutation::MutationPlan) {
    let c = command(
        "binary",
        Mutation::Create {
            id: id("binary"),
            path: path("data.bin"),
            kind: EntryKind::File,
            content: Some(bytes),
        },
        Some(CreateMode::Binary),
    );
    let graph = empty();
    let a = allocation(&c, &[], &graph, None);
    let old = mutation::plan_mutation(&c.request, &[], &graph, c.create_mode, None, &a).unwrap();
    (c, old)
}
fn manifest(plan: &mutation::MutationPlan) -> &Manifest {
    let view = plan.next_graph.view().unwrap();
    let event = view
        .namespace
        .entries
        .get(&id("binary"))
        .unwrap()
        .contents
        .last()
        .unwrap()
        .event
        .clone();
    let p = plan.next_graph.records().get(&event).unwrap();
    match &p.body {
        v2::Body::Events { events } => match &events[0].effect {
            v2::Effect::Create {
                content: Some(v2::ContentSeed::Binary { manifest }),
                ..
            } => manifest,
            v2::Effect::SetContent { content } => content,
            _ => panic!("binary effect"),
        },
        _ => panic!("events"),
    }
}
#[test]
fn staged_binary_create_final_event_matches_legacy_without_copying_body() {
    let (_, old) = binary_create();
    let graph = empty();
    let record = author_staged_binary(
        &BinaryTarget::Create {
            id: id("binary"),
            path: path("data.bin"),
        },
        graph.scope(),
        &old.changes,
        manifest(&old),
        &old.authored_files.last().unwrap().update_id,
        old.next_graph.version(),
        &mut Reader::new(&graph, &[]),
    )
    .unwrap();
    assert_eq!(
        record.payload_bytes(),
        old.authored_files.last().unwrap().payload_bytes
    );
}
#[test]
fn staged_binary_write_preserves_original_selected_content_event() {
    let (_, created) = binary_create();
    let entries = after(&[], &created);
    let graph = &created.next_graph;
    let c = command(
        "writebin",
        Mutation::Write {
            id: id("binary"),
            expected: entries[0].revision.clone(),
            content: vec![],
        },
        None,
    );
    let a = allocation(&c, &entries, graph, None);
    let old = mutation::plan_mutation(&c.request, &entries, graph, None, None, &a).unwrap();
    let mut target = BinaryTarget::Write {
        id: id("binary"),
        expected_revision: entries[0].revision.clone(),
        expected_content_event: created.authored_files.last().unwrap().update_id.clone(),
    };
    let result = author_staged_binary(
        &target,
        graph.scope(),
        &old.changes,
        manifest(&old),
        &old.authored_files.last().unwrap().update_id,
        old.next_graph.version(),
        &mut Reader::new(graph, &entries),
    )
    .unwrap();
    assert_eq!(
        result.payload_bytes(),
        old.authored_files.last().unwrap().payload_bytes
    );
    if let BinaryTarget::Write {
        expected_content_event,
        ..
    } = &mut target
    {
        *expected_content_event = update("wrong");
    }
    assert_eq!(
        author_staged_binary(
            &target,
            graph.scope(),
            &old.changes,
            manifest(&old),
            &old.authored_files.last().unwrap().update_id,
            old.next_graph.version(),
            &mut Reader::new(graph, &entries)
        )
        .unwrap_err(),
        Failure::Mapping(Error::SnapshotMismatch)
    );
}
#[test]
fn nonempty_staged_binary_create_and_write_final_events_match_legacy() {
    let (_, created) = binary_create_content(vec![1, 2, 3]);
    let initial = empty();
    assert_eq!(manifest(&created).bytes, 3);
    assert!(!manifest(&created).pages.is_empty());
    // Actual reference-planned chunk/page emissions back the new manifest;
    // the candidate mapper receives only its metadata and final event slot.
    assert!(matches!(
        v2::Payload::decode(&created.authored_files[0].payload_bytes)
            .unwrap()
            .body,
        v2::Body::Chunk { .. }
    ));
    assert!(matches!(
        v2::Payload::decode(&created.authored_files[1].payload_bytes)
            .unwrap()
            .body,
        v2::Body::Page { .. }
    ));
    let record = author_staged_binary(
        &BinaryTarget::Create {
            id: id("binary"),
            path: path("data.bin"),
        },
        initial.scope(),
        &created.changes,
        manifest(&created),
        &created.authored_files.last().unwrap().update_id,
        created.next_graph.version(),
        &mut Reader::new(&initial, &[]),
    )
    .unwrap();
    assert_eq!(
        record.payload_bytes(),
        created.authored_files.last().unwrap().payload_bytes
    );

    let entries = after(&[], &created);
    let graph = &created.next_graph;
    let c = command(
        "writebin",
        Mutation::Write {
            id: id("binary"),
            expected: entries[0].revision.clone(),
            content: vec![4, 5, 6, 7],
        },
        None,
    );
    let a = allocation(&c, &entries, graph, None);
    let old = mutation::plan_mutation(&c.request, &entries, graph, None, None, &a).unwrap();
    assert_eq!(manifest(&old).bytes, 4);
    assert!(!manifest(&old).pages.is_empty());
    let target = BinaryTarget::Write {
        id: id("binary"),
        expected_revision: entries[0].revision.clone(),
        expected_content_event: created.authored_files.last().unwrap().update_id.clone(),
    };
    let record = author_staged_binary(
        &target,
        graph.scope(),
        &old.changes,
        manifest(&old),
        &old.authored_files.last().unwrap().update_id,
        old.next_graph.version(),
        &mut Reader::new(graph, &entries),
    )
    .unwrap();
    assert_eq!(
        record.payload_bytes(),
        old.authored_files.last().unwrap().payload_bytes
    );
}
#[test]
fn inline_binary_is_routed_to_the_staged_api() {
    let (c, old) = binary_create();
    let graph = empty();
    assert_eq!(
        requirements(&c, &old.changes, None, &mut Reader::new(&graph, &[])).unwrap_err(),
        Failure::Mapping(Error::InvalidMode)
    );
}
