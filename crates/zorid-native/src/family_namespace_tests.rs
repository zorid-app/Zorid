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

/// Synthetic interruption only: no user vault or note content participates.
fn captured_move_then_newer_logical_move(root: &std::path::Path) -> (OperationId, String) {
    let mut vault = enrolled(root);
    logical_move(&mut vault);
    vault.fault = Some(|point| {
        if point == "namespace_captured" {
            panic!("synthetic interruption after durable namespace capture");
        }
    });
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.recover().unwrap();
    }))
    .is_err());
    vault.fault = None;
    let attempt = vault
        .store
        .namespace_attempts(false)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(attempt.members.len(), 1);
    assert!(attempt.members[0].captured);
    assert!(!attempt.members[0].published);
    assert!(!attempt.members[0].finished);
    let captured_name = format!("{}.0.namespace", attempt.job.job_id.as_str());
    assert_eq!(
        std::fs::read(root.join(".zorid").join(&captured_name)).unwrap(),
        b"before"
    );
    assert!(!root.join("note.md").exists());
    assert!(!root.join("renamed.md").exists());
    // Durable family updates may advance while physical recovery is pending.
    // These are normal core operations, not fabricated journal rows.
    for (operation, mutation) in [("write-after-capture", false), ("move-after-capture", true)] {
        let current = vault.store.read(&entry_id()).unwrap().unwrap().state;
        let mutation = if mutation {
            Mutation::Move {
                id: entry_id(),
                expected: current.revision,
                path: VaultPath::new("latest.md").unwrap(),
            }
        } else {
            Mutation::Write {
                id: entry_id(),
                expected: current.revision,
                content: b"newer committed content".to_vec(),
            }
        };
        vault
            .store
            .family_apply(&request(operation, mutation), None)
            .unwrap();
    }
    assert_eq!(
        vault
            .store
            .read(&entry_id())
            .unwrap()
            .unwrap()
            .state
            .path
            .as_str(),
        "latest.md"
    );
    assert!(!root.join("latest.md").exists());
    (attempt.job.job_id, captured_name)
}

#[test]
fn captured_family_move_superseded_by_later_move_recovers_latest_target() {
    let directory = tempfile::tempdir().unwrap();
    let (_old_job, _captured_name) = captured_move_then_newer_logical_move(directory.path());
    let mut vault = NativeVault::open_existing(directory.path()).unwrap();
    let report = vault.recover().unwrap();
    assert!(report.blocked.is_empty(), "{report:?}");
    assert_eq!(
        std::fs::read(directory.path().join("latest.md")).unwrap(),
        b"newer committed content"
    );
    assert!(!directory.path().join("note.md").exists());
    assert!(!directory.path().join("renamed.md").exists());
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
    drop(vault);
    let mut vault = NativeVault::open_existing(directory.path()).unwrap();
    assert!(vault.recover().unwrap().blocked.is_empty());
    assert_eq!(
        std::fs::read(directory.path().join("latest.md")).unwrap(),
        b"newer committed content"
    );
}

#[test]
fn captured_superseded_move_never_overwrites_a_competing_latest_occupant() {
    let directory = tempfile::tempdir().unwrap();
    let (_, captured_name) = captured_move_then_newer_logical_move(directory.path());
    std::fs::write(directory.path().join("latest.md"), b"independent occupant").unwrap();
    let mut vault = NativeVault::open_existing(directory.path()).unwrap();
    let result = vault.recover();
    if let Ok(report) = result {
        assert!(!report.blocked.is_empty(), "{report:?}");
    }
    assert_eq!(
        std::fs::read(directory.path().join("latest.md")).unwrap(),
        b"independent occupant"
    );
    assert_eq!(
        std::fs::read(directory.path().join(".zorid").join(captured_name)).unwrap(),
        b"before"
    );
    assert_eq!(
        vault
            .store
            .read(&entry_id())
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        b"newer committed content"
    );
}

#[test]
fn namespace_successor_restarts_at_durable_handoff_and_rename_boundaries() {
    thread_local! { static PHASE: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) }; }
    for phase in [
        "namespace_successor_prepared",
        "namespace_successor_relocated_before_record",
        "namespace_published_before_record",
        "namespace_before_finish",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let (old_job, _) = captured_move_then_newer_logical_move(directory.path());
        let mut vault = NativeVault::open_existing(directory.path()).unwrap();
        PHASE.with(|slot| slot.set(Some(phase)));
        vault.fault = Some(|point| {
            PHASE.with(|slot| {
                if slot.get() == Some(point) {
                    panic!("synthetic interruption during namespace successor");
                }
            });
        });
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                vault.recover().unwrap();
            }))
            .is_err(),
            "{phase}"
        );
        let old = vault.store.namespace_attempt(&old_job).unwrap();
        assert!(old.delegated_to.is_some(), "{phase}");
        assert!(old.members[0].captured);
        assert!(!old.members[0].published);
        assert!(!old.members[0].finished);
        drop(vault);
        let mut vault = NativeVault::open_existing(directory.path()).unwrap();
        let report = vault.recover().unwrap();
        assert!(report.blocked.is_empty(), "{phase}: {report:?}");
        assert_eq!(
            std::fs::read(directory.path().join("latest.md")).unwrap(),
            b"newer committed content",
            "{phase}"
        );
        assert_eq!(
            vault.family_status().unwrap().pending_projection,
            "0",
            "{phase}"
        );
        let old = vault.store.namespace_attempt(&old_job).unwrap();
        assert!(old.completed);
        assert!(old.members[0].captured);
        assert!(!old.members[0].published);
        assert!(!old.members[0].finished);
        let status = vault
            .status()
            .unwrap()
            .namespace_attempts
            .into_iter()
            .find(|attempt| attempt.job_id == old_job)
            .unwrap();
        assert!(status.completed);
        assert_eq!(status.delegated_to, old.delegated_to);
        assert!(vault.recover().unwrap().blocked.is_empty(), "{phase}");
    }
}

#[test]
fn changed_captured_predecessor_remains_durable_without_retargeting() {
    let directory = tempfile::tempdir().unwrap();
    let (old_job, captured_name) = captured_move_then_newer_logical_move(directory.path());
    let retained = directory.path().join(".zorid").join(&captured_name);
    std::fs::write(&retained, b"external captured edit").unwrap();
    let mut vault = NativeVault::open_existing(directory.path()).unwrap();
    let report = vault.recover().unwrap();
    assert!(!report.blocked.is_empty());
    assert_eq!(std::fs::read(&retained).unwrap(), b"external captured edit");
    assert!(!directory.path().join("latest.md").exists());
    assert!(vault
        .store
        .namespace_attempt(&old_job)
        .unwrap()
        .delegated_to
        .is_none());
    assert!(vault
        .store
        .external_observations()
        .unwrap()
        .iter()
        .any(|observation| {
            vault
                .test_content_bytes(None, &observation.content)
                .unwrap()
                == b"external captured edit"
        }));
    assert_eq!(
        vault
            .store
            .read(&entry_id())
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        b"newer committed content"
    );
}

#[test]
fn delegated_namespace_capture_with_multiple_locations_is_never_guessed() {
    for occupant in ["retained", "destination"] {
        let directory = tempfile::tempdir().unwrap();
        let (old_job, captured_name) = captured_move_then_newer_logical_move(directory.path());
        let mut vault = NativeVault::open_existing(directory.path()).unwrap();
        vault.fault = Some(|point| {
            if point == "namespace_successor_prepared" {
                panic!("synthetic prepared handoff interruption");
            }
        });
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.recover().unwrap();
        }))
        .is_err());
        let successor = vault
            .store
            .namespace_attempt(&old_job)
            .unwrap()
            .delegated_to
            .unwrap();
        let path = if occupant == "retained" {
            directory
                .path()
                .join(".zorid")
                .join(format!("{}.0.namespace", successor.as_str()))
        } else {
            directory.path().join("latest.md")
        };
        std::fs::write(&path, b"independent occupant").unwrap();
        drop(vault);
        let mut vault = NativeVault::open_existing(directory.path()).unwrap();
        let report = vault.recover().unwrap();
        assert!(!report.blocked.is_empty(), "{occupant}");
        assert_eq!(std::fs::read(&path).unwrap(), b"independent occupant");
        assert_eq!(
            std::fs::read(directory.path().join(".zorid").join(captured_name)).unwrap(),
            b"before"
        );
        assert_eq!(
            vault
                .store
                .read(&entry_id())
                .unwrap()
                .unwrap()
                .content
                .unwrap(),
            b"newer committed content"
        );
    }
}

#[test]
fn delegated_namespace_capture_rejects_a_replaced_saved_parent() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("vault");
    std::fs::create_dir(&root).unwrap();
    let (_, captured_name) = captured_move_then_newer_logical_move(&root);
    let mut vault = NativeVault::open_existing(&root).unwrap();
    vault.fault = Some(|point| {
        if point == "namespace_successor_prepared" {
            panic!("synthetic prepared handoff interruption");
        }
    });
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.recover().unwrap();
    }))
    .is_err());
    drop(vault);
    let relocated = directory.path().join("old-parent");
    std::fs::rename(&root, &relocated).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::rename(relocated.join(".zorid"), root.join(".zorid")).unwrap();
    let mut vault = NativeVault::open_existing(&root).unwrap();
    let report = vault.recover().unwrap();
    assert!(!report.blocked.is_empty());
    assert!(!root.join("latest.md").exists());
    assert_eq!(
        std::fs::read(root.join(".zorid").join(captured_name)).unwrap(),
        b"before"
    );
    assert_eq!(
        vault
            .store
            .read(&entry_id())
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        b"newer committed content"
    );
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
