use super::*;
use zorid_store::{FamilyCreateMode, FamilyScope};
use zorid_sync_protocol::{RealmId, VaultId};
fn entry_id() -> EntryId {
    EntryId::new("family-note").unwrap()
}
fn request(id: &str, mutation: Mutation) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(id).unwrap(),
        mutation,
    }
}
fn enrolled(path: &std::path::Path) -> NativeVault {
    let mut vault = NativeVault::open(path).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        })
        .unwrap();
    let result = vault
        .family_apply(
            &request(
                "create",
                Mutation::Create {
                    id: entry_id(),
                    path: VaultPath::new("note.md").unwrap(),
                    kind: EntryKind::File,
                    content: Some(b"before".to_vec()),
                },
            ),
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    assert!(
        matches!(result.projection, ProjectionStatus::Projected),
        "{result:?}"
    );
    vault
}
fn logical_move(vault: &mut NativeVault) {
    let before = vault.store.read(&entry_id()).unwrap().unwrap();
    vault
        .store
        .family_apply(
            &request(
                "move",
                Mutation::Move {
                    id: entry_id(),
                    expected: before.state.revision,
                    path: VaultPath::new("renamed.md").unwrap(),
                },
            ),
            None,
        )
        .unwrap();
}
#[test]
fn family_move_then_delete_replays_against_original_physical_path_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let mut vault = enrolled(directory.path());
    logical_move(&mut vault);
    let moved = vault.store.read(&entry_id()).unwrap().unwrap();
    vault
        .store
        .family_apply(
            &request(
                "delete",
                Mutation::Delete {
                    id: entry_id(),
                    expected: moved.state.revision,
                },
            ),
            None,
        )
        .unwrap();
    assert_eq!(
        std::fs::read(directory.path().join("note.md")).unwrap(),
        b"before"
    );
    drop(vault);
    let mut vault = NativeVault::open(directory.path()).unwrap();
    let report = vault.recover().unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert!(!directory.path().join("note.md").exists());
    assert!(!directory.path().join("renamed.md").exists());
    assert!(vault.store.physical_binding(&entry_id()).unwrap().is_none());
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
    let attempts = vault.store.namespace_attempts(true).unwrap();
    let attempt = attempts
        .iter()
        .find(|a| a.job.work == zorid_store::ProjectionWork::Delete)
        .unwrap();
    assert!(attempt.completed);
    assert_eq!(attempt.members[0].evidence.before.path.as_str(), "note.md");
    let retained = directory
        .path()
        .join(".zorid")
        .join(format!("{}.0.namespace", attempt.job.job_id.as_str()));
    assert_eq!(std::fs::read(retained).unwrap(), b"before");
    drop(vault);
    let mut vault = NativeVault::open(directory.path()).unwrap();
    assert!(vault.recover().unwrap().blocked.is_empty());
    assert_eq!(
        vault.store.namespace_attempts(true).unwrap().len(),
        attempts.len()
    );
}
#[test]
fn family_move_preserves_old_physical_text_branch_then_publishes_newer_content() {
    let directory = tempfile::tempdir().unwrap();
    let mut vault = enrolled(directory.path());
    let before = vault.store.read(&entry_id()).unwrap().unwrap();
    vault
        .store
        .family_apply(
            &request(
                "write",
                Mutation::Write {
                    id: entry_id(),
                    expected: before.state.revision,
                    content: b"new logical content".to_vec(),
                },
            ),
            None,
        )
        .unwrap();
    logical_move(&mut vault);
    let report = vault.recover().unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert!(!directory.path().join("note.md").exists());
    assert_eq!(
        std::fs::read(directory.path().join("renamed.md")).unwrap(),
        b"new logical content"
    );
    let attempt = vault.store.namespace_attempts(true).unwrap().pop().unwrap();
    assert_eq!(
        attempt.members[0].evidence.content.as_deref(),
        Some(b"before".as_slice())
    );
    let physical = vault
        .store
        .projection_baseline(&entry_id())
        .unwrap()
        .unwrap();
    let baseline = vault.store.text_baseline(&physical).unwrap().unwrap();
    assert_eq!(
        baseline
            .state
            .complete_materialized_utf8()
            .unwrap()
            .unwrap(),
        b"new logical content"
    );
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
}
#[test]
fn family_folder_move_preserves_child_frontier_and_explicit_members() {
    let directory = tempfile::tempdir().unwrap();
    let mut vault = enrolled(directory.path());
    let folder = EntryId::new("folder").unwrap();
    let child = EntryId::new("child").unwrap();
    for (id, path, kind, content, mode) in [
        (folder.clone(), "folder", EntryKind::Folder, None, None),
        (
            child.clone(),
            "folder/child.md",
            EntryKind::File,
            Some(b"child".to_vec()),
            Some(FamilyCreateMode::Text),
        ),
    ] {
        let result = vault
            .family_apply(
                &request(
                    if kind == EntryKind::Folder {
                        "create-folder-fixture"
                    } else {
                        "create-child-fixture"
                    },
                    Mutation::Create {
                        id,
                        path: VaultPath::new(path).unwrap(),
                        kind,
                        content,
                    },
                ),
                mode,
            )
            .unwrap();
        assert!(
            matches!(result.projection, ProjectionStatus::Projected),
            "{result:?}"
        );
    }
    let child_before = vault.store.projection_baseline(&child).unwrap().unwrap();
    let history_before = vault
        .store
        .family_publication(&child, &child_before.state.revision)
        .unwrap()
        .unwrap();
    let folder_state = vault.store.read(&folder).unwrap().unwrap().state;
    vault
        .store
        .family_apply(
            &request(
                "move-folder",
                Mutation::Move {
                    id: folder.clone(),
                    expected: folder_state.revision,
                    path: VaultPath::new("moved").unwrap(),
                },
            ),
            None,
        )
        .unwrap();
    let report = vault.recover().unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert!(!directory.path().join("folder").exists());
    assert_eq!(
        std::fs::read(directory.path().join("moved/child.md")).unwrap(),
        b"child"
    );
    let attempt = vault.store.namespace_attempts(true).unwrap().pop().unwrap();
    assert_eq!(attempt.members.len(), 2);
    let member = attempt
        .members
        .iter()
        .find(|m| m.change.after.id == child)
        .unwrap();
    let history_after = vault
        .store
        .family_publication(&child, &member.change.after.revision)
        .unwrap()
        .unwrap();
    let (
        zorid_store::FamilyPublication::Normal {
            namespace_heads: old_heads,
            location_event: old_event,
            ..
        },
        zorid_store::FamilyPublication::Normal {
            namespace_heads: new_heads,
            location_event: new_event,
            path,
            ..
        },
    ) = (history_before.publication, history_after.publication)
    else {
        panic!("expected retained Normal histories")
    };
    assert_eq!(old_heads, new_heads);
    assert_eq!(old_event, new_event);
    assert_eq!(path.as_str(), "moved/child.md");
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
}
