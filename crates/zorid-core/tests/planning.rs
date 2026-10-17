use zorid_core::{
    plan_mutation, ContractError, EntryChange, EntryId, EntryKind, EntryState, Mutation,
    MutationRequest, OperationId, Revision, VaultPath,
};

fn entry(id: &str, path: &str, kind: EntryKind) -> EntryState {
    EntryState {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: Revision::new(format!("before-{id}")).unwrap(),
        deleted: false,
    }
}

fn tree() -> Vec<EntryState> {
    vec![
        entry("a", "notes", EntryKind::Folder),
        entry("b", "notes/topic", EntryKind::Folder),
        entry("c", "notes/topic/note.md", EntryKind::File),
        entry("d", "notes/keep.unknown", EntryKind::File),
        entry("e", "archive", EntryKind::Folder),
    ]
}

fn request(mutation: Mutation) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("operation").unwrap(),
        mutation,
    }
}

fn plan(mutation: Mutation, entries: &[EntryState]) -> Result<Vec<EntryChange>, ContractError> {
    plan_mutation(&request(mutation), entries, &Revision::new("next").unwrap())
}

fn moved(entry: &EntryState, path: &str) -> Mutation {
    Mutation::Move {
        id: entry.id.clone(),
        expected: entry.revision.clone(),
        path: VaultPath::new(path).unwrap(),
    }
}

fn deleted(entry: &EntryState, recursive: bool) -> Mutation {
    Mutation::Delete {
        id: entry.id.clone(),
        expected: entry.revision.clone(),
        recursive,
    }
}

fn create(id: &str, path: &str) -> Mutation {
    Mutation::Create {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind: EntryKind::File,
        content: Some(vec![0, 255]),
    }
}

#[test]
fn write_bumps_all_ancestors_without_touching_siblings() {
    let entries = tree();
    let file = &entries[2];
    let changes = plan(
        Mutation::Write {
            id: file.id.clone(),
            expected: file.revision.clone(),
            content: vec![255],
        },
        &entries,
    )
    .unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|change| change.after.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "c"]
    );
    for change in &changes {
        assert_eq!(change.after.revision.as_str(), "next");
        assert_eq!(change.before.as_ref().unwrap().path, change.after.path);
    }
    assert_eq!(
        entries[2].revision.as_str(),
        "before-c",
        "planning does not mutate inputs"
    );
}

#[test]
fn folder_move_preserves_ids_and_changes_old_and_new_ancestors() {
    let entries = tree();
    let changes = plan(moved(&entries[1], "archive/renamed"), &entries).unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|change| change.after.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "c", "e"]
    );
    assert_eq!(changes[1].after.path.as_str(), "archive/renamed");
    assert_eq!(changes[2].after.path.as_str(), "archive/renamed/note.md");
    assert_eq!(
        changes[2].before.as_ref().unwrap().path.as_str(),
        "notes/topic/note.md"
    );
    assert!(changes
        .iter()
        .all(|change| !change.after.deleted && change.after.revision.as_str() == "next"));
}

#[test]
fn folder_cannot_move_inside_itself_or_onto_an_occupied_destination() {
    let entries = tree();
    for destination in [
        "notes/topic/nested",
        "notes",
        "notes/keep.unknown",
        "missing/topic",
        "notes/keep.unknown/topic",
    ] {
        assert!(
            plan(moved(&entries[1], destination), &entries).is_err(),
            "accepted {destination}"
        );
    }
    assert!(
        plan(moved(&entries[1], "notes/topic"), &entries).is_ok(),
        "same-path operation still commits a fresh revision"
    );
}

#[test]
fn deleting_nonempty_folder_requires_recursive_and_preserves_tombstones() {
    let entries = tree();
    assert!(plan(deleted(&entries[1], false), &entries).is_err());
    let changes = plan(deleted(&entries[1], true), &entries).unwrap();
    assert_eq!(changes.len(), 3);
    assert!(!changes[0].after.deleted, "live ancestor remains");
    assert!(changes[1].after.deleted);
    assert!(changes[2].after.deleted);
    assert_eq!(changes[2].after.id, entries[2].id);
    assert_eq!(changes[2].after.path, entries[2].path);
}

#[test]
fn empty_folder_and_file_delete_work_without_recursive_flag() {
    let entries = tree();
    assert_eq!(
        plan(deleted(&entries[4], false), &entries).unwrap().len(),
        1
    );
    assert_eq!(
        plan(deleted(&entries[2], false), &entries).unwrap().len(),
        3
    );
}

#[test]
fn create_requires_live_parent_unoccupied_path_and_never_reused_id() {
    let entries = tree();
    for (id, path) in [
        ("new", "missing/child"),
        ("new", "notes/keep.unknown/child"),
        ("new", "notes/keep.unknown"),
        ("c", "notes/new.md"),
    ] {
        assert!(
            plan(create(id, path), &entries).is_err(),
            "accepted {id}: {path}"
        );
    }
    let changes = plan(create("new", "notes/topic/.secret-format"), &entries).unwrap();
    assert_eq!(changes.len(), 3);
    assert_eq!(changes[2].before, None);
    assert_eq!(changes[2].after.path.as_str(), "notes/topic/.secret-format");
    assert!(plan(create("root", ".unknown"), &[]).is_ok());
}

#[test]
fn deleted_path_can_be_reused_but_deleted_identity_cannot() {
    let mut tombstone = entry("old", "recreated.bin", EntryKind::File);
    tombstone.deleted = true;
    let entries = [tombstone];
    assert!(plan(create("new", "recreated.bin"), &entries).is_ok());
    assert!(plan(create("old", "different.bin"), &entries).is_err());
    assert!(matches!(
        plan(moved(&entries[0], "moved.bin"), &entries),
        Err(ContractError::EntryDeleted { .. })
    ));
}

#[test]
fn folder_move_does_not_rewrite_historical_tombstone_paths() {
    let mut entries = tree();
    let mut tombstone = entry("old", "notes/topic/deleted.bin", EntryKind::File);
    tombstone.deleted = true;
    entries.push(tombstone);
    let changes = plan(moved(&entries[1], "archive/new"), &entries).unwrap();
    assert!(!changes
        .iter()
        .any(|change| change.after.id.as_str() == "old"));
}

#[test]
fn changed_descendant_invalidates_an_older_recursive_delete() {
    let mut entries = tree();
    let deletion = deleted(&entries[0], true);
    let changed = plan(
        Mutation::Write {
            id: entries[2].id.clone(),
            expected: entries[2].revision.clone(),
            content: vec![],
        },
        &entries,
    )
    .unwrap();
    for change in changed {
        let slot = entries
            .iter_mut()
            .find(|entry| entry.id == change.after.id)
            .unwrap();
        *slot = change.after;
    }
    assert!(matches!(
        plan_mutation(
            &request(deletion),
            &entries,
            &Revision::new("later").unwrap()
        ),
        Err(ContractError::RevisionConflict { .. })
    ));
}

#[test]
fn malformed_snapshots_fail_before_producing_partial_plans() {
    let entries = tree();
    let mutation = moved(&entries[1], "archive/new");
    let mut duplicate_id = entries.clone();
    duplicate_id.push(entries[2].clone());
    let mut duplicate_path = entries.clone();
    duplicate_path.push(entry("other", "notes/topic/note.md", EntryKind::File));
    let mut file_parent = entries.clone();
    file_parent[1].kind = EntryKind::File;
    let mut deleted_parent = entries.clone();
    deleted_parent[1].deleted = true;
    let mut missing_parent = entries.clone();
    missing_parent.remove(1);
    for malformed in [
        duplicate_id,
        duplicate_path,
        file_parent,
        deleted_parent,
        missing_parent,
    ] {
        assert!(plan(mutation.clone(), &malformed).is_err());
    }
}

#[test]
fn planner_rejects_stale_targets_folder_writes_and_reused_revision() {
    let entries = tree();
    let mut stale = moved(&entries[2], "new.md");
    if let Mutation::Move { expected, .. } = &mut stale {
        *expected = Revision::new("stale").unwrap();
    }
    assert!(matches!(
        plan(stale, &entries),
        Err(ContractError::RevisionConflict { .. })
    ));
    let folder_write = Mutation::Write {
        id: entries[0].id.clone(),
        expected: entries[0].revision.clone(),
        content: vec![],
    };
    assert!(plan(folder_write, &entries).is_err());
    assert!(plan_mutation(
        &request(moved(&entries[2], "new.md")),
        &entries,
        &entries[2].revision
    )
    .is_err());
}

#[test]
fn batch_order_is_deterministic_independent_of_snapshot_order() {
    let entries = tree();
    let mutation = moved(&entries[1], "archive/new");
    let first = plan(mutation.clone(), &entries).unwrap();
    let mut reversed = entries;
    reversed.reverse();
    assert_eq!(first, plan(mutation, &reversed).unwrap());
}
