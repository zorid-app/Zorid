use zorid_core::{
    plan_file_materialization, plan_mutation, ContractError, EntryId, EntryKind, EntryState,
    Mutation, MutationRequest, OperationId, Revision, VaultPath,
};

fn entry(id: &str, path: &str, kind: EntryKind, deleted: bool) -> EntryState {
    EntryState {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: Revision::new(format!("before-{id}")).unwrap(),
        deleted,
    }
}

fn tree() -> Vec<EntryState> {
    vec![
        entry("parent", "notes", EntryKind::Folder, false),
        entry("nested", "notes/topic", EntryKind::Folder, false),
        entry("file", "notes/topic/text.md", EntryKind::File, false),
        entry("sibling", "notes/other.bin", EntryKind::File, false),
        // A retained historical identity can share the current file's path.
        entry("old", "notes/topic/text.md", EntryKind::File, true),
        entry("root", "root.bin", EntryKind::File, false),
    ]
}

#[test]
fn materialization_only_revises_file_and_ancestors_preserving_namespace() {
    let entries = tree();
    let file = &entries[2];
    let next = Revision::new("received-1").unwrap();
    let changes = plan_file_materialization(&file.id, &file.revision, &next, &entries).unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|change| change.after.id.as_str())
            .collect::<Vec<_>>(),
        ["file", "nested", "parent"]
    );
    let mut applied = entries.clone();
    for change in &changes {
        let original = entries
            .iter()
            .find(|entry| entry.id == change.after.id)
            .unwrap();
        assert_eq!(change.before.as_ref(), Some(original));
        let mut expected = original.clone();
        expected.revision = next.clone();
        assert_eq!(change.after, expected);
        *applied
            .iter_mut()
            .find(|entry| entry.id == change.after.id)
            .unwrap() = change.after.clone();
    }
    for (before, after) in entries.iter().zip(&applied) {
        assert_eq!(
            (&before.id, &before.path, before.kind, before.deleted),
            (&after.id, &after.path, after.kind, after.deleted)
        );
    }
    for index in [3, 4, 5] {
        assert_eq!(
            applied[index], entries[index],
            "unrelated and tombstoned entries stay exact"
        );
    }
    let mut reversed = entries.clone();
    reversed.reverse();
    assert_eq!(
        changes,
        plan_file_materialization(&file.id, &file.revision, &next, &reversed).unwrap()
    );
    assert_eq!(
        entries,
        tree(),
        "planning leaves the source snapshot unchanged"
    );
}

#[test]
fn materialization_rejects_stale_missing_deleted_and_folder_targets() {
    let entries = tree();
    let next = Revision::new("received-1").unwrap();
    let stale = Revision::new("stale").unwrap();
    assert_eq!(
        plan_file_materialization(&entries[2].id, &stale, &next, &entries),
        Err(ContractError::RevisionConflict {
            id: entries[2].id.clone(),
            expected: stale.clone(),
            actual: entries[2].revision.clone()
        })
    );
    let missing = EntryId::new("missing").unwrap();
    assert_eq!(
        plan_file_materialization(&missing, &stale, &next, &entries),
        Err(ContractError::EntryNotFound { id: missing })
    );
    assert_eq!(
        plan_file_materialization(&entries[4].id, &entries[4].revision, &next, &entries),
        Err(ContractError::EntryDeleted {
            id: entries[4].id.clone()
        })
    );
    assert!(matches!(
        plan_file_materialization(&entries[0].id, &entries[0].revision, &next, &entries),
        Err(ContractError::InvalidMutation { .. })
    ));
}

#[test]
fn materialization_rejects_revision_reuse_including_unrelated_tombstones() {
    let entries = tree();
    let file = &entries[2];
    for entry in &entries {
        assert!(matches!(
            plan_file_materialization(&file.id, &file.revision, &entry.revision, &entries),
            Err(ContractError::InvalidMutation { .. })
        ));
    }
}

#[test]
fn materialization_validates_complete_snapshot_before_emitting_changes() {
    let entries = tree();
    let file = &entries[2];
    let next = Revision::new("received-1").unwrap();
    let mut duplicate_id = entries.clone();
    duplicate_id.push(entries[3].clone());
    let mut duplicate_path = entries.clone();
    duplicate_path.push(entry(
        "duplicate",
        "notes/topic/text.md",
        EntryKind::File,
        false,
    ));
    let mut missing_parent = entries.clone();
    missing_parent.remove(1);
    let mut file_parent = entries.clone();
    file_parent[1].kind = EntryKind::File;
    for malformed in [duplicate_id, duplicate_path, missing_parent, file_parent] {
        assert!(matches!(
            plan_file_materialization(&file.id, &file.revision, &next, &malformed),
            Err(ContractError::InvalidMutation { .. })
        ));
    }
}

#[test]
fn materialization_matches_write_metadata_for_nested_and_root_files() {
    let entries = tree();
    let next = Revision::new("received-1").unwrap();
    for index in [2, 5] {
        let file = &entries[index];
        let materialized =
            plan_file_materialization(&file.id, &file.revision, &next, &entries).unwrap();
        let written = plan_mutation(
            &MutationRequest {
                operation_id: OperationId::new("local-write").unwrap(),
                mutation: Mutation::Write {
                    id: file.id.clone(),
                    expected: file.revision.clone(),
                    content: vec![0, 255],
                },
            },
            &entries,
            &next,
        )
        .unwrap();
        assert_eq!(materialized, written);
        if index == 5 {
            assert_eq!(materialized.len(), 1);
        }
    }
}
