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
                    recursive: false,
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
    let evidence = &attempt.members[0].evidence;
    assert_eq!(
        vault
            .test_content_bytes(Some(&evidence.before), evidence.content.as_ref().unwrap())
            .unwrap(),
        b"before"
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
#[test]
fn mixed_folder_move_and_child_delete_retire_parent_only_after_remaining_members_restart() {
    let directory = tempfile::tempdir().unwrap();
    let mut vault = enrolled(directory.path());
    let folder = EntryId::new("mixed-folder").unwrap();
    let removed = EntryId::new("removed-child").unwrap();
    let kept = EntryId::new("kept-child").unwrap();
    for (operation, id, path, kind, content, mode) in [
        (
            "mixed-folder-create",
            folder.clone(),
            "folder",
            EntryKind::Folder,
            None,
            None,
        ),
        (
            "removed-create",
            removed.clone(),
            "folder/removed.md",
            EntryKind::File,
            Some(b"remove".to_vec()),
            Some(FamilyCreateMode::Text),
        ),
        (
            "kept-create",
            kept.clone(),
            "folder/kept.md",
            EntryKind::File,
            Some(b"keep".to_vec()),
            Some(FamilyCreateMode::Text),
        ),
    ] {
        let outcome = vault
            .family_apply(
                &request(
                    operation,
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
            matches!(outcome.projection, ProjectionStatus::Projected),
            "{outcome:?}"
        );
    }
    let folder_state = vault.store.read(&folder).unwrap().unwrap().state;
    vault
        .store
        .family_apply(
            &request(
                "mixed-move",
                Mutation::Move {
                    id: folder.clone(),
                    expected: folder_state.revision,
                    path: VaultPath::new("moved").unwrap(),
                },
            ),
            None,
        )
        .unwrap();
    let removed_state = vault.store.read(&removed).unwrap().unwrap().state;
    vault
        .store
        .family_apply(
            &request(
                "mixed-delete",
                Mutation::Delete {
                    id: removed.clone(),
                    expected: removed_state.revision,
                    recursive: false,
                },
            ),
            None,
        )
        .unwrap();
    let jobs = vault.store.pending_namespace_jobs().unwrap();
    let original_move=jobs.iter().find(|j|matches!(&j.origin,zorid_store::ProjectionOrigin::LocalCommand{operation_id} if operation_id.as_str()=="mixed-move")).unwrap().job_id.clone();
    let targets = vault.store.family_namespace_targets(&jobs).unwrap();
    assert!(targets.iter().any(|t| t.deleted) && targets.iter().any(|t| !t.deleted));
    let deleted: Vec<_> = targets.into_iter().filter(|t| t.deleted).collect();
    let binding = vault.store.physical_binding(&removed).unwrap().unwrap();
    let baseline = vault.store.projection_baseline(&removed).unwrap().unwrap();
    let evidence = zorid_store::NamespaceEvidence {
        before: binding.state.clone(),
        source_identity: binding.physical.inode.clone(),
        source_parent_identity: binding.physical.parent_inode.clone(),
        destination_parent_identity: None,
        content: Some(baseline.content.clone()),
        file_baseline: Some(baseline),
        directory_baseline: None,
        physical_binding: Some(binding),
    };
    let attempt = vault
        .store
        .family_namespace_prepare(&jobs, &deleted, &[evidence])
        .unwrap()
        .unwrap();
    vault.resume_namespace(attempt).unwrap();
    assert!(
        !vault
            .store
            .projection_job(&original_move)
            .unwrap()
            .completed
    );
    assert!(!directory.path().join("folder/removed.md").exists());
    assert_eq!(
        std::fs::read(directory.path().join("folder/kept.md")).unwrap(),
        b"keep"
    );
    drop(vault);
    let mut vault = NativeVault::open(directory.path()).unwrap();
    let report = vault.recover().unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert!(!directory.path().join("folder").exists());
    assert!(!directory.path().join("moved/removed.md").exists());
    assert_eq!(
        std::fs::read(directory.path().join("moved/kept.md")).unwrap(),
        b"keep"
    );
    assert!(
        vault
            .store
            .projection_job(&original_move)
            .unwrap()
            .completed
    );
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
}

#[test]
fn namespace_handoff_settles_interrupted_file_phases_before_move_or_delete() {
    let phases: [(&str, fn(&str)); 3] = [
        ("prepared", |p| {
            if p == "prepared" {
                panic!("interrupt prepared");
            }
        }),
        ("displaced_before_record", |p| {
            if p == "displaced_before_record" {
                panic!("interrupt displaced");
            }
        }),
        ("published_before_record", |p| {
            if p == "published_before_record" {
                panic!("interrupt published");
            }
        }),
    ];
    for (phase, fault) in phases {
        for delete in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let mut vault = enrolled(directory.path());
            let before = vault.store.read(&entry_id()).unwrap().unwrap().state;
            vault
                .store
                .family_apply(
                    &request(
                        "interrupted-write",
                        Mutation::Write {
                            id: entry_id(),
                            expected: before.revision,
                            content: b"updated".to_vec(),
                        },
                    ),
                    None,
                )
                .unwrap();
            vault.fault = Some(fault);
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    vault.project(&entry_id()).unwrap();
                }))
                .is_err(),
                "fault not reached: {phase}"
            );
            drop(vault);
            let mut vault = NativeVault::open(directory.path()).unwrap();
            let current = vault.store.read(&entry_id()).unwrap().unwrap().state;
            if delete {
                vault
                    .store
                    .family_apply(
                        &request(
                            "delete-after-interruption",
                            Mutation::Delete {
                                id: entry_id(),
                                expected: current.revision,
                                recursive: false,
                            },
                        ),
                        None,
                    )
                    .unwrap();
            } else {
                logical_move(&mut vault);
            }
            let report = vault.recover().unwrap();
            assert!(
                report.blocked.is_empty(),
                "{phase} delete={delete}: {report:?}"
            );
            assert!(!directory.path().join("note.md").exists());
            if delete {
                assert!(vault.store.physical_binding(&entry_id()).unwrap().is_none());
            } else {
                assert_eq!(
                    std::fs::read(directory.path().join("renamed.md")).unwrap(),
                    b"updated"
                );
            }
            assert!(vault.store.projection_attempts(false).unwrap().is_empty());
            assert_eq!(vault.family_status().unwrap().pending_projection, "0");
        }
    }
}

#[test]
fn namespace_handoff_preserves_recreated_source_occupant() {
    let directory = tempfile::tempdir().unwrap();
    let mut vault = enrolled(directory.path());
    let before = vault.store.read(&entry_id()).unwrap().unwrap().state;
    vault
        .store
        .family_apply(
            &request(
                "interrupted-write",
                Mutation::Write {
                    id: entry_id(),
                    expected: before.revision,
                    content: b"updated".to_vec(),
                },
            ),
            None,
        )
        .unwrap();
    vault.fault = Some(|p| {
        if p == "prepared" {
            panic!("interrupt prepared");
        }
    });
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.project(&entry_id()).unwrap();
    }))
    .is_err());
    drop(vault);
    std::fs::rename(
        directory.path().join("note.md"),
        directory.path().join("external-original.md"),
    )
    .unwrap();
    std::fs::write(directory.path().join("note.md"), b"external replacement").unwrap();
    let mut vault = NativeVault::open(directory.path()).unwrap();
    logical_move(&mut vault);
    let report = vault.recover().unwrap();
    assert!(!report.blocked.is_empty());
    assert_eq!(
        std::fs::read(directory.path().join("note.md")).unwrap(),
        b"external replacement"
    );
    assert_eq!(
        std::fs::read(directory.path().join("external-original.md")).unwrap(),
        b"before"
    );
    assert!(!directory.path().join("renamed.md").exists());
    assert!(!vault.store.projection_attempts(false).unwrap().is_empty());
}

#[test]
fn namespace_handoff_settles_interrupted_directory_create_before_move() {
    let phases: [fn(&str); 2] = [
        |p| {
            if p == "directory_prepared" {
                panic!("interrupt prepared directory");
            }
        },
        |p| {
            if p == "directory_published_before_record" {
                panic!("interrupt published directory");
            }
        },
    ];
    for fault in phases {
        let directory = tempfile::tempdir().unwrap();
        let mut vault = enrolled(directory.path());
        let folder = EntryId::new("interrupted-folder").unwrap();
        vault
            .store
            .family_apply(
                &request(
                    "folder-create",
                    Mutation::Create {
                        id: folder.clone(),
                        path: VaultPath::new("old-folder").unwrap(),
                        kind: EntryKind::Folder,
                        content: None,
                    },
                ),
                None,
            )
            .unwrap();
        vault.fault = Some(fault);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.project_directory(&folder).unwrap();
        }))
        .is_err());
        drop(vault);
        let mut vault = NativeVault::open(directory.path()).unwrap();
        let before = vault.store.read(&folder).unwrap().unwrap().state;
        vault
            .store
            .family_apply(
                &request(
                    "folder-move",
                    Mutation::Move {
                        id: folder.clone(),
                        expected: before.revision,
                        path: VaultPath::new("new-folder").unwrap(),
                    },
                ),
                None,
            )
            .unwrap();
        let report = vault.recover().unwrap();
        assert!(report.blocked.is_empty(), "{report:?}");
        assert!(!directory.path().join("old-folder").exists());
        assert!(directory.path().join("new-folder").is_dir());
        assert!(vault.store.directory_attempts(false).unwrap().is_empty());
        assert_eq!(vault.family_status().unwrap().pending_projection, "0");
    }
}
