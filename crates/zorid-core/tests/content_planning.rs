use zorid_core::{
    plan_file_content_mutation, ContractError, EntryChange, EntryId, EntryKind, EntryState,
    FileContentTarget, Revision, VaultPath,
};

fn revision(value: &str) -> Revision {
    Revision::new(value).unwrap()
}

fn entry(id: &str, path: &str, kind: EntryKind, deleted: bool) -> EntryState {
    EntryState {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: revision(&format!("before-{id}")),
        deleted,
    }
}

fn tree() -> Vec<EntryState> {
    vec![
        entry("parent", "notes", EntryKind::Folder, false),
        entry("nested", "notes/topic", EntryKind::Folder, false),
        entry("file", "notes/topic/data.bin", EntryKind::File, false),
        entry("sibling", "notes/other", EntryKind::File, false),
        entry("old", "notes/topic/deleted", EntryKind::File, true),
        entry("gone", "gone", EntryKind::Folder, true),
        entry("root", "root", EntryKind::File, false),
    ]
}

fn create(id: &str, path: &str) -> FileContentTarget {
    FileContentTarget::Create {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
    }
}

fn write(entry: &EntryState) -> FileContentTarget {
    FileContentTarget::Write {
        id: entry.id.clone(),
        expected: entry.revision.clone(),
    }
}

fn plan(
    target: &FileContentTarget,
    entries: &[EntryState],
) -> Result<Vec<EntryChange>, ContractError> {
    plan_file_content_mutation(target, entries, &revision("next"))
}

#[test]
fn content_create_is_file_only_and_revises_live_ancestors_deterministically() {
    let entries = tree();
    let target = create("new", "notes/topic/.unknown");
    let changes = plan(&target, &entries).unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|c| c.after.id.as_str())
            .collect::<Vec<_>>(),
        ["nested", "new", "parent"]
    );
    for change in &changes {
        assert_eq!(change.after.revision, revision("next"));
        if change.after.id.as_str() == "new" {
            assert_eq!(change.before, None);
            assert_eq!(change.after.path.as_str(), "notes/topic/.unknown");
            assert_eq!(change.after.kind, EntryKind::File);
            assert!(!change.after.deleted);
        } else {
            let original = entries.iter().find(|e| e.id == change.after.id).unwrap();
            assert_eq!(change.before.as_ref(), Some(original));
            let mut after = original.clone();
            after.revision = revision("next");
            assert_eq!(change.after, after);
        }
    }
    let mut reversed = entries.clone();
    reversed.reverse();
    assert_eq!(changes, plan(&target, &reversed).unwrap());
    assert_eq!(entries, tree());
    let root = plan(&create("new-root", ".file"), &[]).unwrap();
    assert_eq!(root.len(), 1);
    assert_eq!(root[0].after.kind, EntryKind::File);
}

#[test]
fn content_write_changes_only_file_and_ancestor_revisions() {
    let entries = tree();
    for (index, expected_ids) in [(2, vec!["file", "nested", "parent"]), (6, vec!["root"])] {
        let target = write(&entries[index]);
        let changes = plan(&target, &entries).unwrap();
        assert_eq!(
            changes
                .iter()
                .map(|c| c.after.id.as_str())
                .collect::<Vec<_>>(),
            expected_ids
        );
        for change in &changes {
            let original = entries.iter().find(|e| e.id == change.after.id).unwrap();
            assert_eq!(change.before.as_ref(), Some(original));
            let mut after = original.clone();
            after.revision = revision("next");
            assert_eq!(change.after, after);
        }
        let mut reversed = entries.clone();
        reversed.reverse();
        assert_eq!(changes, plan(&target, &reversed).unwrap());
    }
    assert_eq!(entries, tree());
}

#[test]
fn content_write_rejects_stale_missing_deleted_and_folder_targets() {
    let entries = tree();
    let stale = FileContentTarget::Write {
        id: entries[2].id.clone(),
        expected: revision("stale"),
    };
    assert_eq!(
        plan(&stale, &entries),
        Err(ContractError::RevisionConflict {
            id: entries[2].id.clone(),
            expected: revision("stale"),
            actual: entries[2].revision.clone(),
        })
    );
    let missing = EntryId::new("missing").unwrap();
    assert_eq!(
        plan(
            &FileContentTarget::Write {
                id: missing.clone(),
                expected: revision("stale")
            },
            &entries
        ),
        Err(ContractError::EntryNotFound { id: missing })
    );
    assert_eq!(
        plan(&write(&entries[4]), &entries),
        Err(ContractError::EntryDeleted {
            id: entries[4].id.clone()
        })
    );
    assert!(matches!(
        plan(&write(&entries[1]), &entries),
        Err(ContractError::InvalidMutation { .. })
    ));
}

#[test]
fn content_create_rejects_collisions_and_requires_live_folder_parent() {
    let entries = tree();
    for (id, path) in [
        ("new", "notes/topic/data.bin"),
        ("new", "notes/topic"),
        ("file", "notes/new"),
        ("old", "notes/new"),
        ("new", "missing/child"),
        ("new", "notes/other/child"),
        ("new", "gone/child"),
    ] {
        assert!(
            matches!(
                plan(&create(id, path), &entries),
                Err(ContractError::InvalidMutation { .. })
            ),
            "accepted {id}: {path}"
        );
    }
    // Reusing a deleted path is allowed only with a new logical identity.
    let changes = plan(&create("new", "notes/topic/deleted"), &entries).unwrap();
    assert!(!changes.iter().any(|c| c.after.id == entries[4].id));
    let new = changes
        .iter()
        .find(|c| c.after.id.as_str() == "new")
        .unwrap();
    assert_eq!(new.before, None);
    assert_eq!(new.after.path, entries[4].path);
    assert!(!new.after.deleted);
}

#[test]
fn content_plans_reject_revision_reuse_including_unrelated_tombstones() {
    let entries = tree();
    for target in [create("new", "notes/new"), write(&entries[2])] {
        for entry in &entries {
            assert!(matches!(
                plan_file_content_mutation(&target, &entries, &entry.revision),
                Err(ContractError::InvalidMutation { .. })
            ));
        }
    }
}

#[test]
fn content_plans_validate_complete_snapshot_before_emitting_changes() {
    let entries = tree();
    let mut duplicate_id = entries.clone();
    duplicate_id.push(entries[3].clone());
    let mut duplicate_path = entries.clone();
    duplicate_path.push(entry("collision", "notes/other", EntryKind::File, false));
    let mut missing_parent = entries.clone();
    missing_parent.remove(1);
    let mut file_parent = entries.clone();
    file_parent[1].kind = EntryKind::File;
    for malformed in [duplicate_id, duplicate_path, missing_parent, file_parent] {
        for target in [create("new", "new-root"), write(&entries[2])] {
            assert!(matches!(
                plan(&target, &malformed),
                Err(ContractError::InvalidMutation { .. })
            ));
        }
    }
}
