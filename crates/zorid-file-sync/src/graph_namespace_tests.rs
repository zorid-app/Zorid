use super::*;
use crate::{EntryView, Location};
use std::collections::{BTreeMap, BTreeSet};
use zorid_sync_protocol::UpdateId;

#[derive(Debug, PartialEq, Eq)]
enum ReadError {
    Domain(Error),
    Admission,
    Source,
}
impl From<Error> for ReadError {
    fn from(error: Error) -> Self {
        Self::Domain(error)
    }
}

struct Reader {
    nodes: BTreeMap<EntryId, NamespaceNode>,
    winners: BTreeMap<(Option<EntryId>, String), NamespaceNode>,
    reads: Vec<String>,
    admissions: Vec<NamespaceWork>,
    reject_at: Option<usize>,
    source_error: bool,
    wrong_node: bool,
    bad_winner: usize,
}
impl Reader {
    fn new(entries: &BTreeMap<EntryId, EntryView>) -> Self {
        let nodes: BTreeMap<_, _> = entries
            .iter()
            .map(|(id, entry)| {
                (
                    id.clone(),
                    NamespaceNode::new(
                        entry.identity.clone(),
                        entry.kind,
                        entry.liveness.clone(),
                        entry.locations.last().cloned(),
                    )
                    .unwrap(),
                )
            })
            .collect();
        let mut winners = BTreeMap::new();
        for node in nodes.values() {
            if node.liveness != Liveness::Live {
                continue;
            }
            if let Some(location) = &node.preferred_location {
                winners
                    .entry((
                        location.location.parent.clone(),
                        location.location.name.clone(),
                    ))
                    .or_insert_with(|| node.clone());
            }
        }
        Self {
            nodes,
            winners,
            reads: Vec::new(),
            admissions: Vec::new(),
            reject_at: None,
            source_error: false,
            wrong_node: false,
            bad_winner: 0,
        }
    }
    fn record(&mut self, selector: String) -> Result<(), ReadError> {
        assert_eq!(self.admissions.last(), Some(&NamespaceWork::Read));
        self.reads.push(selector);
        if self.source_error {
            Err(ReadError::Source)
        } else {
            Ok(())
        }
    }
}
impl NamespaceProjectionReader for Reader {
    type Error = ReadError;
    fn admit(&mut self, work: NamespaceWork) -> Result<(), ReadError> {
        self.admissions.push(work);
        if self.reject_at == Some(self.admissions.len()) {
            Err(ReadError::Admission)
        } else {
            Ok(())
        }
    }
    fn node(&mut self, id: &EntryId) -> Result<Option<NamespaceNode>, ReadError> {
        self.record(format!("node:{id}"))?;
        let mut node = self.nodes.get(id).cloned();
        if self.wrong_node {
            if let Some(node) = &mut node {
                node.identity.entry_id = eid("wrong");
            }
        }
        Ok(node)
    }
    fn sibling_winner(
        &mut self,
        parent: Option<&EntryId>,
        name: &str,
    ) -> Result<Option<NamespaceNode>, ReadError> {
        self.record(format!(
            "winner:{}:{name}",
            parent.map(EntryId::as_str).unwrap_or("")
        ))?;
        if self.bad_winner == 1 {
            return Ok(None);
        }
        let mut winner = self
            .winners
            .get(&(parent.cloned(), name.to_owned()))
            .cloned();
        if let Some(winner) = &mut winner {
            match self.bad_winner {
                2 => winner.liveness = Liveness::Deleted,
                3 => winner.preferred_location.as_mut().unwrap().location.name = "different".into(),
                4 => winner.identity.entry_id = eid("zzzz"),
                5 => {
                    winner.kind = if winner.kind == EntryKind::File {
                        EntryKind::Folder
                    } else {
                        EntryKind::File
                    }
                }
                _ => {}
            }
        }
        Ok(winner)
    }
}

fn eid(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn uid(value: &str) -> UpdateId {
    UpdateId::new(value).unwrap()
}
fn at(parent: Option<&str>, name: &str, event: &str) -> LocationHead {
    LocationHead {
        event: uid(event),
        location: Location {
            parent: parent.map(eid),
            name: name.into(),
        },
    }
}
fn node(id: &str, kind: EntryKind, parent: Option<&str>, name: &str) -> EntryView {
    EntryView {
        identity: EntryIdentity {
            entry_id: eid(id),
            bootstrap_id: uid(&format!("bootstrap-{id}")),
        },
        kind,
        heads: vec![uid(&format!("bootstrap-{id}"))],
        contents: vec![],
        locations: vec![at(parent, name, "location")],
        liveness: Liveness::Live,
        projection: Projection::Tombstone,
    }
}
fn map(nodes: Vec<EntryView>) -> BTreeMap<EntryId, EntryView> {
    nodes
        .into_iter()
        .map(|node| (node.identity.entry_id.clone(), node))
        .collect()
}
fn tree() -> BTreeMap<EntryId, EntryView> {
    map(vec![
        node("folder", EntryKind::Folder, None, "notes"),
        node("nested", EntryKind::Folder, Some("folder"), "topic"),
        node("file", EntryKind::File, Some("nested"), "note.md"),
    ])
}
fn collisions(entries: &BTreeMap<EntryId, EntryView>) -> BTreeSet<EntryId> {
    let mut occupied = BTreeSet::new();
    let mut collisions = BTreeSet::new();
    for (id, entry) in entries {
        if entry.liveness == Liveness::Live {
            if let Some(location) = entry.locations.last() {
                if !occupied.insert((
                    location.location.parent.clone(),
                    location.location.name.clone(),
                )) {
                    collisions.insert(id.clone());
                }
            }
        }
    }
    collisions
}
fn compare(entries: &BTreeMap<EntryId, EntryView>, target: &str) -> Projection {
    let target = eid(target);
    let expected = crate::locate(&target, entries, &collisions(entries));
    assert_eq!(
        project_namespace_candidate(&target, &mut Reader::new(entries)),
        Ok(expected.clone())
    );
    expected
}
fn recovery_reason(projection: Projection) -> RecoveryReason {
    match projection {
        Projection::Recovery { reason, .. } => reason,
        other => panic!("{other:?}"),
    }
}

#[test]
fn namespace_normal_missing_and_liveness_match_locate() {
    let entries = tree();
    for id in ["folder", "nested", "file", "missing"] {
        compare(&entries, id);
    }
    for liveness in [Liveness::Deleted, Liveness::DeleteConflict] {
        for changed in ["folder", "nested", "file"] {
            let mut entries = tree();
            entries.get_mut(&eid(changed)).unwrap().liveness = liveness.clone();
            for id in ["folder", "nested", "file"] {
                compare(&entries, id);
            }
        }
    }
    let mut entries = tree();
    entries.get_mut(&eid("nested")).unwrap().locations.clear();
    assert_eq!(
        recovery_reason(compare(&entries, "file")),
        RecoveryReason::ParentUnavailable
    );
    let mut entries = tree();
    entries.remove(&eid("nested"));
    assert_eq!(
        recovery_reason(compare(&entries, "file")),
        RecoveryReason::ParentUnavailable
    );
}

#[test]
fn namespace_cycle_and_file_parent_precedence_match_locate() {
    let mut entries = tree();
    entries.get_mut(&eid("folder")).unwrap().locations[0]
        .location
        .parent = Some(eid("nested"));
    for id in ["folder", "nested", "file"] {
        assert_eq!(
            recovery_reason(compare(&entries, id)),
            RecoveryReason::Cycle
        );
    }
    let mut reader = Reader::new(&entries);
    project_namespace_candidate(&eid("file"), &mut reader).unwrap();
    assert_eq!(
        reader
            .reads
            .iter()
            .filter(|read| read.as_str() == "node:nested")
            .count(),
        1,
        "repeat cycle ID must stop before a second node or winner access"
    );
    let mut entries = tree();
    entries.get_mut(&eid("nested")).unwrap().kind = EntryKind::File;
    assert_eq!(
        recovery_reason(compare(&entries, "file")),
        RecoveryReason::ParentUnavailable
    );
    entries.insert(
        eid("a-winner"),
        node("a-winner", EntryKind::File, Some("folder"), "topic"),
    );
    assert_eq!(
        recovery_reason(compare(&entries, "file")),
        RecoveryReason::NameCollision,
        "collision precedes a file ancestor check"
    );
}

#[test]
fn namespace_collision_ownership_and_losing_folder_descendants_match_locate() {
    let mut entries = tree();
    entries.insert(
        eid("a-winner"),
        node("a-winner", EntryKind::Folder, None, "notes"),
    );
    assert!(matches!(
        compare(&entries, "a-winner"),
        Projection::Normal { .. }
    ));
    for id in ["folder", "nested", "file"] {
        assert_eq!(
            recovery_reason(compare(&entries, id)),
            RecoveryReason::NameCollision
        );
    }
    for liveness in [Liveness::Deleted, Liveness::DeleteConflict] {
        let mut nonlive = entries.clone();
        nonlive.get_mut(&eid("a-winner")).unwrap().liveness = liveness;
        assert!(matches!(
            compare(&nonlive, "file"),
            Projection::Normal { .. }
        ));
    }
}

#[test]
fn namespace_nonlive_nodes_never_query_sibling_ownership() {
    for liveness in [Liveness::Deleted, Liveness::DeleteConflict] {
        let mut entries = tree();
        entries.get_mut(&eid("folder")).unwrap().liveness = liveness;
        entries.insert(
            eid("a-winner"),
            node("a-winner", EntryKind::Folder, None, "notes"),
        );
        let mut reader = Reader::new(&entries);
        assert_eq!(
            project_namespace_candidate(&eid("folder"), &mut reader),
            Ok(crate::locate(
                &eid("folder"),
                &entries,
                &collisions(&entries)
            ))
        );
        assert!(reader.reads.iter().all(|read| !read.starts_with("winner:")));
    }
}

#[test]
fn namespace_last_location_and_unavailable_live_competitors_match_locate() {
    let mut entries = tree();
    let preferred = at(None, "preferred", "zz-last");
    entries
        .get_mut(&eid("folder"))
        .unwrap()
        .locations
        .push(preferred);
    assert_eq!(
        compare(&entries, "file"),
        Projection::Normal {
            path: VaultPath::new("preferred/topic/note.md").unwrap()
        }
    );
    entries.insert(
        eid("a-unavailable"),
        node("a-unavailable", EntryKind::File, Some("missing"), "same"),
    );
    entries.insert(
        eid("b-loser"),
        node("b-loser", EntryKind::Folder, Some("missing"), "same"),
    );
    assert_eq!(
        recovery_reason(compare(&entries, "a-unavailable")),
        RecoveryReason::ParentUnavailable
    );
    assert_eq!(
        recovery_reason(compare(&entries, "b-loser")),
        RecoveryReason::NameCollision,
        "a live node owns its sibling key even when its own projection is recovery"
    );
    // Pending/activity/publication status is deliberately absent from the
    // selector contract. A host must not filter such live namespace nodes out.
    entries
        .get_mut(&eid("a-unavailable"))
        .unwrap()
        .locations
        .insert(0, at(None, "alternative", "aa-first"));
    assert_eq!(
        recovery_reason(compare(&entries, "b-loser")),
        RecoveryReason::NameCollision
    );
}

#[test]
fn namespace_projection_access_does_not_enumerate_unrelated_nodes() {
    let mut entries = tree();
    for n in 0..10_000 {
        let id = format!("unrelated-{n}");
        entries.insert(eid(&id), node(&id, EntryKind::File, None, &id));
    }
    let mut reader = Reader::new(&entries);
    assert_eq!(
        project_namespace_candidate(&eid("file"), &mut reader),
        Ok(crate::locate(&eid("file"), &entries, &collisions(&entries)))
    );
    assert_eq!(reader.reads.len(), 6);
    assert!(reader.reads.iter().all(|read| !read.contains("unrelated")));
}

#[test]
fn namespace_every_admission_rejection_returns_no_projection() {
    let mut cases = vec![(tree(), "file")];
    let mut deleted = tree();
    deleted.get_mut(&eid("file")).unwrap().liveness = Liveness::Deleted;
    cases.push((deleted, "file"));
    let mut collision = tree();
    collision.insert(eid("a"), node("a", EntryKind::Folder, None, "notes"));
    cases.push((collision, "file"));
    let mut cycle = tree();
    cycle.get_mut(&eid("folder")).unwrap().locations[0]
        .location
        .parent = Some(eid("nested"));
    cases.push((cycle, "file"));
    cases.push((tree(), "missing"));
    for (entries, target) in cases {
        let mut baseline = Reader::new(&entries);
        project_namespace_candidate(&eid(target), &mut baseline).unwrap();
        assert!(baseline
            .admissions
            .iter()
            .any(|work| matches!(work, NamespaceWork::Retain { .. })));
        assert!(matches!(
            baseline.admissions.last(),
            Some(NamespaceWork::Emit { .. })
        ));
        for stop in 1..=baseline.admissions.len() {
            let mut reader = Reader::new(&entries);
            reader.reject_at = Some(stop);
            assert_eq!(
                project_namespace_candidate(&eid(target), &mut reader),
                Err(ReadError::Admission)
            );
            assert_eq!(reader.admissions.len(), stop);
            assert_eq!(reader.nodes, baseline.nodes);
            if stop == 1 {
                assert!(reader.reads.is_empty());
            }
        }
    }
}

#[test]
fn namespace_rejects_wrong_node_and_contradictory_sibling_winners() {
    let entries = tree();
    let mut reader = Reader::new(&entries);
    reader.wrong_node = true;
    assert_eq!(
        project_namespace_candidate(&eid("folder"), &mut reader),
        Err(ReadError::Domain(Error::InvalidState))
    );
    for bad in 1..=5 {
        let mut reader = Reader::new(&entries);
        reader.bad_winner = bad;
        assert_eq!(
            project_namespace_candidate(&eid("folder"), &mut reader),
            Err(ReadError::Domain(Error::InvalidState))
        );
    }
}

#[test]
fn namespace_source_error_is_not_a_recovery_candidate() {
    let mut reader = Reader::new(&tree());
    reader.source_error = true;
    assert_eq!(
        project_namespace_candidate(&eid("file"), &mut reader),
        Err(ReadError::Source)
    );
}

#[test]
fn namespace_constructor_is_local_validation_and_output_bound_covers_json() {
    let mut entries = tree();
    entries.get_mut(&eid("folder")).unwrap().locations[0]
        .location
        .name = "quoted\"é".into();
    let mut reader = Reader::new(&entries);
    let projection = project_namespace_candidate(&eid("file"), &mut reader).unwrap();
    let Some(NamespaceWork::Emit { encoded_bytes }) = reader.admissions.last() else {
        panic!("missing output admission")
    };
    assert!(serde_json::to_vec(&projection).unwrap().len() <= *encoded_bytes);
    let entry = entries.get(&eid("file")).unwrap();
    assert_eq!(
        NamespaceNode::new(
            entry.identity.clone(),
            entry.kind,
            entry.liveness.clone(),
            Some(at(None, "bad/name", "bad"))
        ),
        Err(Error::InvalidLocation)
    );
    // No maximum/preferred-head proof is claimed by local construction.
    let candidate = NamespaceNode::new(
        entry.identity.clone(),
        entry.kind,
        entry.liveness.clone(),
        None,
    )
    .unwrap();
    assert_eq!(candidate.identity(), &entry.identity);
    assert_eq!(candidate.kind(), entry.kind);
    assert_eq!(candidate.liveness(), &Liveness::Live);
    assert!(candidate.preferred_location().is_none());
}
