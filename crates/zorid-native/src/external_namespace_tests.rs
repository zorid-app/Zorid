use super::*;
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_store::{
    DirectoryCoverage, ExternalNamespaceAction, ExternalNamespaceMember, FamilyPublication,
    FamilyScope, PhysicalBinding,
};
use zorid_sync_protocol::{ExpectedContext, RealmId, VaultId};

thread_local! {
    static PREPARED_EDIT_ROOT: std::cell::RefCell<Option<std::path::PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

fn edit_after_namespace_prepared(point: &str) {
    if point == "external_namespace_prepared" {
        PREPARED_EDIT_ROOT.with(|root| {
            std::fs::write(
                root.borrow().as_ref().unwrap().join("after.md"),
                b"changed after namespace preparation",
            )
            .unwrap();
        });
    }
}

fn corrupt_namespace_record_after_prepared(point: &str) {
    if point == "external_namespace_prepared" {
        PREPARED_EDIT_ROOT.with(|root| {
            let sql = rusqlite::Connection::open(
                root.borrow().as_ref().unwrap().join(".zorid/vault.sqlite"),
            )
            .unwrap();
            assert_eq!(
                sql.execute(
                    "UPDATE family_external_namespace SET record='{' WHERE result IS NULL",
                    [],
                )
                .unwrap(),
                1
            );
        });
    }
}

fn corrupt_graph_cache_after_prepared(point: &str) {
    if point == "external_namespace_prepared" {
        PREPARED_EDIT_ROOT.with(|root| {
            let sql = rusqlite::Connection::open(
                root.borrow().as_ref().unwrap().join(".zorid/vault.sqlite"),
            )
            .unwrap();
            assert_eq!(
                sql.execute(
                    "UPDATE family_graph_heads SET record_count=record_count+1",
                    [],
                )
                .unwrap(),
                1
            );
        });
    }
}

fn expose_private_directory_after_prepared(point: &str) {
    if point == "external_namespace_prepared" {
        use std::os::unix::fs::PermissionsExt;
        PREPARED_EDIT_ROOT.with(|root| {
            std::fs::set_permissions(
                root.borrow().as_ref().unwrap().join(".zorid"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        });
    }
}

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).unwrap()
}

fn enrolled(root: &std::path::Path) -> NativeVault {
    let mut vault = NativeVault::open(root).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("namespace-realm").unwrap(),
            vault_id: VaultId::new("namespace-vault").unwrap(),
        })
        .unwrap();
    vault
}

fn reconcile(vault: &mut NativeVault) -> ExternalReconcileReport {
    vault
        .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
        .unwrap()
}

fn complete(vault: &mut NativeVault) -> ExternalReconcileReport {
    let report = reconcile(vault);
    assert!(report.complete, "{report:?}");
    assert!(report.run.complete, "{report:?}");
    report
}

fn state_at(vault: &NativeVault, value: &str) -> EntryState {
    vault
        .list()
        .unwrap()
        .into_iter()
        .find(|entry| entry.path == path(value))
        .unwrap_or_else(|| panic!("missing visible entry {value}"))
}

fn binding(vault: &NativeVault, id: &EntryId) -> PhysicalBinding {
    vault.store.physical_binding(id).unwrap().unwrap()
}

fn assert_file(vault: &mut NativeVault, id: &EntryId, value: &str, bytes: &[u8]) {
    let entry = vault.read(id).unwrap().unwrap();
    assert_eq!(entry.state.path, path(value));
    assert!(!entry.state.deleted);
    assert_eq!(entry.content.as_deref(), Some(bytes));
    let baseline = vault.store.projection_baseline(id).unwrap().unwrap();
    assert_eq!(baseline.state.path, path(value));
    assert_eq!(
        vault
            .test_content_bytes(Some(&baseline.state), &baseline.content)
            .unwrap(),
        bytes
    );
    assert_eq!(binding(vault, id).state, baseline.state);
}

// Receiving directly into the store deliberately leaves the old physical branch
// in place. Native receive would run recovery before the external scanner.
fn send(source: &mut NativeVault, target: &mut NativeVault, store_only: bool) {
    let key = VaultKey::from_bytes([73; 32]);
    for update in source.family_pending_authored(None, 1000).unwrap() {
        let context = ExpectedContext {
            realm_id: update.scope.realm_id,
            vault_id: update.scope.vault_id,
            update_id: update.update_id,
            key_epoch: 1,
        };
        let wire = source.family_seal(&context, &key).unwrap();
        let opened = OpenedEnvelope::open(&wire, &context, &key).unwrap();
        if store_only {
            target.store.family_receive(&opened, None).unwrap();
        } else {
            target.family_receive(&opened, None).unwrap();
        }
    }
}

fn namespace_rows(root: &std::path::Path) -> Vec<(OperationId, bool)> {
    let sql = rusqlite::Connection::open(root.join(".zorid/vault.sqlite")).unwrap();
    let mut statement = sql
        .prepare("SELECT observation_id,result IS NOT NULL FROM family_external_namespace ORDER BY observation_id")
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                OperationId::new(row.get::<_, String>(0)?).unwrap(),
                row.get(1)?,
            ))
        })
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    rows
}

#[test]
fn external_namespace_discovers_nested_parents_and_exact_auto_text_and_binary() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::create_dir_all(root.path().join("outside/deep")).unwrap();
    let bom = b"\xef\xbb\xbfhello\r\n";
    let unknown = "unknown suffix: \u{03bb}\r\n".as_bytes();
    let binary = [0, 255, 128, 13, 10];
    for (name, bytes) in [
        ("outside/deep/bom.custom", bom.as_slice()),
        ("outside/deep/plain.unknown", unknown),
        ("outside/blob.custom", binary.as_slice()),
    ] {
        std::fs::write(root.path().join(name), bytes).unwrap();
    }
    let report = complete(&mut vault);
    assert!(report.namespace.is_empty());
    assert_eq!(report.imported.len(), 5);
    let imported: Vec<_> = report
        .imported
        .iter()
        .flat_map(|receipt| {
            receipt
                .changes
                .iter()
                .map(|change| change.after.path.clone())
        })
        .collect();
    let position = |name: &str| imported.iter().position(|p| p == &path(name)).unwrap();
    assert!(position("outside") < position("outside/deep"));
    assert!(position("outside/deep") < position("outside/deep/bom.custom"));
    assert!(position("outside/deep") < position("outside/deep/plain.unknown"));
    assert!(position("outside") < position("outside/blob.custom"));
    for (name, bytes, text) in [
        ("outside/deep/bom.custom", bom.as_slice(), true),
        ("outside/deep/plain.unknown", unknown, true),
        ("outside/blob.custom", binary.as_slice(), false),
    ] {
        let state = state_at(&vault, name);
        assert_file(&mut vault, &state.id, name, bytes);
        assert_eq!(
            vault.store.family_text_state(&state.id).unwrap().is_some(),
            text
        );
        assert_eq!(std::fs::read(root.path().join(name)).unwrap(), bytes);
    }
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    let repeat = complete(&mut vault);
    assert!(repeat.imported.is_empty());
    assert!(repeat.namespace.is_empty());
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
}

#[test]
fn external_namespace_file_rename_and_edit_preserve_identity_inode_and_exact_bytes() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("before.custom"), b"before\r\n").unwrap();
    complete(&mut vault);
    let old = state_at(&vault, "before.custom");
    let physical = binding(&vault, &old.id);
    std::fs::rename(
        root.path().join("before.custom"),
        root.path().join("after.custom"),
    )
    .unwrap();
    let bytes = b"\xef\xbb\xbfafter edit\r\n";
    std::fs::write(root.path().join("after.custom"), bytes).unwrap();
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    assert_eq!(report.namespace[0].authored.len(), 1);
    assert_eq!(report.namespace[0].pending_content.len(), 1);
    assert_eq!(vault.list().unwrap().len(), 1);
    assert_file(&mut vault, &old.id, "after.custom", bytes);
    assert_eq!(
        binding(&vault, &old.id).physical.inode,
        physical.physical.inode
    );
    assert!(!root.path().join("before.custom").exists());
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    assert_file(&mut vault, &old.id, "after.custom", bytes);
    assert!(complete(&mut vault).namespace.is_empty());
}

#[test]
fn external_namespace_nested_folder_move_and_edits_preserve_every_descendant() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::create_dir_all(root.path().join("old/nested")).unwrap();
    std::fs::write(root.path().join("old/nested/note.custom"), b"before").unwrap();
    std::fs::write(root.path().join("old/blob.bin"), [0, 255, 1]).unwrap();
    complete(&mut vault);
    let before = vault.store.physical_bindings().unwrap();
    std::fs::create_dir(root.path().join("new-parent")).unwrap();
    std::fs::rename(
        root.path().join("old"),
        root.path().join("new-parent/moved"),
    )
    .unwrap();
    std::fs::create_dir(root.path().join("new-parent/moved/fresh")).unwrap();
    std::fs::write(
        root.path().join("new-parent/moved/fresh/added.custom"),
        b"created inside moved folder",
    )
    .unwrap();
    let text = b"\xef\xbb\xbfchanged\r\n";
    let binary = [128, 0, 255, 2, 3];
    std::fs::write(
        root.path().join("new-parent/moved/nested/note.custom"),
        text,
    )
    .unwrap();
    std::fs::write(root.path().join("new-parent/moved/blob.bin"), binary).unwrap();
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    assert_eq!(
        report.namespace[0].authored.len(),
        1,
        "only the folder root moves causally"
    );
    assert_eq!(report.namespace[0].pending_content.len(), 2);
    assert_eq!(vault.list().unwrap().len(), before.len() + 3);
    let added_folder = state_at(&vault, "new-parent/moved/fresh");
    let added_file = state_at(&vault, "new-parent/moved/fresh/added.custom");
    assert_eq!(added_folder.kind, EntryKind::Folder);
    assert!(!before.iter().any(|old| old.state.id == added_folder.id));
    assert!(!before.iter().any(|old| old.state.id == added_file.id));
    assert_file(
        &mut vault,
        &added_file.id,
        "new-parent/moved/fresh/added.custom",
        b"created inside moved folder",
    );
    for old in before {
        let suffix = old.state.path.as_str().strip_prefix("old").unwrap();
        let expected = path(&format!("new-parent/moved{suffix}"));
        let after = binding(&vault, &old.state.id);
        assert_eq!(after.state.path, expected);
        assert_eq!(after.physical.inode, old.physical.inode);
        assert_eq!(state_at(&vault, expected.as_str()).id, old.state.id);
    }
    let note = state_at(&vault, "new-parent/moved/nested/note.custom");
    let blob = state_at(&vault, "new-parent/moved/blob.bin");
    assert_file(&mut vault, &note.id, note.path.as_str(), text);
    assert_file(&mut vault, &blob.id, blob.path.as_str(), &binary);
    assert!(!root.path().join("old").exists());
}

#[test]
fn external_namespace_delete_removes_only_captured_file_and_folder_members() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let mut remote = enrolled(peer.path());
    std::fs::create_dir_all(root.path().join("gone/nested")).unwrap();
    for name in ["gone/nested/child.md", "loose.md", "keep.md"] {
        std::fs::write(root.path().join(name), name.as_bytes()).unwrap();
    }
    complete(&mut vault);
    let captured: Vec<_> = vault
        .list()
        .unwrap()
        .into_iter()
        .filter(|e| e.path.as_str() != "keep.md")
        .collect();
    let keep = binding(&vault, &state_at(&vault, "keep.md").id);
    send(&mut vault, &mut remote, false);
    std::fs::write(peer.path().join("gone/unseen.md"), b"remote unseen child").unwrap();
    complete(&mut remote);
    let unseen = state_at(&remote, "gone/unseen.md");
    std::fs::remove_dir_all(root.path().join("gone")).unwrap();
    std::fs::remove_file(root.path().join("loose.md")).unwrap();
    send(&mut remote, &mut vault, true);
    assert!(vault.store.physical_binding(&unseen.id).unwrap().is_none());
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 2, "{report:?}");
    assert_eq!(
        report
            .namespace
            .iter()
            .map(|r| r.authored.len())
            .sum::<usize>(),
        captured.len()
    );
    for old in captured {
        assert!(vault.store.physical_binding(&old.id).unwrap().is_none());
        assert!(vault.store.projection_baseline(&old.id).unwrap().is_none());
        assert!(!vault.list().unwrap().iter().any(|e| e.id == old.id));
    }
    assert_eq!(binding(&vault, &keep.state.id), keep);
    assert_file(&mut vault, &keep.state.id, "keep.md", b"keep.md");
    assert!(matches!(
        vault
            .store
            .family_materialization(&unseen.id)
            .unwrap()
            .unwrap()
            .publication,
        FamilyPublication::Recovery { .. }
    ));
    assert!(vault.store.physical_binding(&unseen.id).unwrap().is_none());
}

#[test]
fn external_namespace_incomplete_budgets_never_author_deletion() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::create_dir(root.path().join("nested")).unwrap();
    for name in ["gone.md", "root.md", "nested/a.md", "nested/b.md"] {
        std::fs::write(root.path().join(name), b"retained baseline").unwrap();
    }
    complete(&mut vault);
    let gone = state_at(&vault, "gone.md");
    let before = binding(&vault, &gone.id);
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    std::fs::remove_file(root.path().join("gone.md")).unwrap();
    let budgets = [
        ScanOptions {
            max_entries: 1,
            ..ScanOptions::default()
        },
        ScanOptions {
            max_total_bytes: 0,
            ..ScanOptions::default()
        },
        ScanOptions {
            max_depth: 0,
            ..ScanOptions::default()
        },
        ScanOptions {
            max_duration: std::time::Duration::ZERO,
            ..ScanOptions::default()
        },
    ];
    for options in budgets {
        let report = vault
            .reconcile_external(options, ExternalFileMode::Auto)
            .unwrap();
        assert!(!report.complete, "{report:?}");
        assert!(!report.run.complete);
        assert!(!report.issues.is_empty());
        assert!(report.namespace.is_empty());
        assert!(report.imported.is_empty());
        assert_eq!(binding(&vault, &gone.id), before);
        assert_eq!(state_at(&vault, "gone.md"), gone);
        assert_eq!(
            vault.family_pending_authored(None, 1000).unwrap().len(),
            authored
        );
        assert!(namespace_rows(root.path()).is_empty());
    }
    assert_eq!(complete(&mut vault).namespace.len(), 1);
    assert!(vault.store.physical_binding(&gone.id).unwrap().is_none());
}

#[test]
fn external_namespace_prepared_restart_reuses_observation_identity_and_receipt() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("before.md"), b"original").unwrap();
    complete(&mut vault);
    let before = state_at(&vault, "before.md");
    let physical = binding(&vault, &before.id);
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    std::fs::rename(root.path().join("before.md"), root.path().join("after.md")).unwrap();
    std::fs::write(root.path().join("after.md"), b"changed during move").unwrap();
    vault.fault = Some(|point| {
        if point == "external_namespace_prepared" {
            panic!("prepared namespace interruption");
        }
    });
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| reconcile(&mut vault))).is_err()
    );
    let rows = namespace_rows(root.path());
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].1);
    let observation = rows[0].0.clone();
    assert_eq!(binding(&vault, &before.id), physical);
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 1);
    let receipt = report.namespace[0].clone();
    assert_eq!(receipt.observation_id, observation);
    assert_eq!(
        namespace_rows(root.path()),
        vec![(observation.clone(), true)]
    );
    assert_file(&mut vault, &before.id, "after.md", b"changed during move");
    assert_eq!(
        binding(&vault, &before.id).physical.inode,
        physical.physical.inode
    );
    let pending = vault.family_pending_authored(None, 1000).unwrap().len();
    assert_eq!(
        vault
            .store
            .import_family_namespace_observation(&observation)
            .unwrap(),
        receipt
    );
    assert_eq!(
        vault
            .store
            .family_namespace_observation_result(&observation)
            .unwrap(),
        Some(receipt)
    );
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        pending
    );
    let repeat = complete(&mut vault);
    assert!(repeat.namespace.is_empty());
    assert!(repeat.imported.is_empty());
    assert_eq!(namespace_rows(root.path()), vec![(observation, true)]);
}

#[test]
fn external_namespace_store_requires_explicit_absence_not_only_complete_coverage() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("gone.md"), b"keep logical bytes").unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "gone.md").id);
    std::fs::remove_file(root.path().join("gone.md")).unwrap();
    let run = vault.store.begin_scan(10).unwrap();
    vault
        .store
        .record_directory_coverage(
            &run.scan_id,
            &DirectoryCoverage {
                path: None,
                identity: Some(before.physical.parent_inode.clone()),
                complete: true,
                issue: None,
            },
        )
        .unwrap();
    let run = vault.store.finish_scan(&run.scan_id, true, None).unwrap();
    assert!(run.complete);
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    assert!(vault
        .store
        .record_family_namespace_observation(
            &run.scan_id,
            ExternalNamespaceAction::Delete {
                root: before.state.id.clone()
            },
            vec![ExternalNamespaceMember {
                before: before.clone(),
                after: None,
                observed_content: None
            }],
        )
        .is_err());
    assert_eq!(binding(&vault, &before.state.id), before);
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
    assert!(namespace_rows(root.path()).is_empty());
    assert_eq!(complete(&mut vault).namespace.len(), 1);
}

#[test]
fn external_namespace_store_rejects_forged_move_bytes_against_capture_proof() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("old.md"), b"base").unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "old.md").id);
    std::fs::rename(root.path().join("old.md"), root.path().join("new.md")).unwrap();
    std::fs::write(root.path().join("new.md"), b"real").unwrap();
    let scan = vault.external_scan_locked(ScanOptions::default()).unwrap();
    assert!(scan.run.complete, "{:?}", scan.issues);
    let captured = &scan.entries[&path("new.md")];
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    assert!(vault
        .store
        .record_family_namespace_observation(
            &scan.run.scan_id,
            ExternalNamespaceAction::Move {
                root: before.state.id.clone(),
                path: path("new.md")
            },
            vec![ExternalNamespaceMember {
                before: before.clone(),
                after: Some((
                    path("new.md"),
                    PhysicalIdentity {
                        inode: captured.identity.clone(),
                        parent_inode: captured.parent_identity.clone(),
                    }
                )),
                observed_content: Some(zorid_store::StoredContent::InlineBytes(b"fake".to_vec())),
            }],
        )
        .is_err());
    assert_eq!(binding(&vault, &before.state.id), before);
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
    assert!(namespace_rows(root.path()).is_empty());
    assert_eq!(complete(&mut vault).namespace.len(), 1);
    assert_file(&mut vault, &before.state.id, "new.md", b"real");
}

#[test]
fn external_namespace_hidden_recovery_move_keeps_unseen_text_and_historical_parents() {
    let root = tempfile::tempdir().unwrap();
    let deleter_root = tempfile::tempdir().unwrap();
    let writer_root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let mut deleter = enrolled(deleter_root.path());
    let mut writer = enrolled(writer_root.path());
    std::fs::write(root.path().join("note.md"), b"base").unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "note.md").id);
    let historical = vault
        .store
        .family_publication(&before.state.id, &before.state.revision)
        .unwrap()
        .unwrap();
    let FamilyPublication::Normal {
        namespace_heads, ..
    } = historical.publication
    else {
        panic!("fixture must have a normal physical baseline");
    };
    assert_eq!(namespace_heads.len(), 1);
    send(&mut vault, &mut deleter, false);
    send(&mut vault, &mut writer, false);
    let deleted = deleter.read(&before.state.id).unwrap().unwrap().state;
    deleter
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("remote-delete").unwrap(),
                mutation: Mutation::Delete {
                    id: before.state.id.clone(),
                    expected: deleted.revision,
                    recursive: false,
                },
            },
            None,
        )
        .unwrap();
    let written = writer.read(&before.state.id).unwrap().unwrap().state;
    writer
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("remote-text").unwrap(),
                mutation: Mutation::Write {
                    id: before.state.id.clone(),
                    expected: written.revision,
                    content: b"REMOTE base".to_vec(),
                },
            },
            None,
        )
        .unwrap();
    send(&mut deleter, &mut vault, true);
    send(&mut writer, &mut vault, true);
    let recovery = vault
        .store
        .family_materialization(&before.state.id)
        .unwrap()
        .unwrap();
    assert!(matches!(
        recovery.publication,
        FamilyPublication::Recovery { .. }
    ));
    assert!(vault.list().unwrap().is_empty());
    let text = vault
        .store
        .family_text_state(&before.state.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        text.complete_materialized_utf8().unwrap().unwrap(),
        b"REMOTE base"
    );
    assert_eq!(binding(&vault, &before.state.id), before);
    std::fs::rename(root.path().join("note.md"), root.path().join("moved.md")).unwrap();
    let report = reconcile(&mut vault);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    let receipt = &report.namespace[0];
    assert_eq!(receipt.authored.len(), 1);
    assert!(receipt.pending_content.is_empty());
    let moved = binding(&vault, &before.state.id);
    assert_eq!(moved.state.path, path("moved.md"));
    assert_eq!(moved.physical.inode, before.physical.inode);
    assert_eq!(
        vault
            .store
            .family_materialization(&before.state.id)
            .unwrap()
            .unwrap(),
        recovery
    );
    assert_eq!(
        vault
            .store
            .family_text_state(&before.state.id)
            .unwrap()
            .unwrap(),
        text
    );
    assert!(vault.list().unwrap().is_empty());
    assert_eq!(
        std::fs::read(root.path().join("moved.md")).unwrap(),
        b"base"
    );
    let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    // file_state.rs retains graph membership keys; immutable_payloads.rs owns
    // the exact authenticated payload. Join the complete scope, not update ID alone.
    let (count, parent): (i64, String) = sql.query_row(
        "SELECT json_array_length(json_extract(CAST(p.payload AS TEXT),'$.body.events[0].parents')),json_extract(CAST(p.payload AS TEXT),'$.body.events[0].parents[0]') FROM family_file_records f JOIN immutable_payloads p USING(realm_id,vault_id,update_id) WHERE f.realm_id=?1 AND f.vault_id=?2 AND f.update_id=?3 AND p.family='files'",
        ["namespace-realm", "namespace-vault", receipt.authored[0].as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        parent,
        namespace_heads[0].as_str(),
        "unseen Delete/Text heads must not be consumed"
    );
    drop(sql);
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    assert_eq!(
        vault
            .store
            .import_family_namespace_observation(&receipt.observation_id)
            .unwrap(),
        *receipt
    );
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
    assert_eq!(namespace_rows(root.path()).len(), 1);
}

#[test]
fn external_namespace_hidden_tombstone_delete_retires_only_retained_physical_branch() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let mut remote = enrolled(peer.path());
    std::fs::write(root.path().join("gone.md"), b"retained").unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "gone.md").id);
    send(&mut vault, &mut remote, false);
    let revision = remote
        .read(&before.state.id)
        .unwrap()
        .unwrap()
        .state
        .revision;
    remote
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("remote-tombstone").unwrap(),
                mutation: Mutation::Delete {
                    id: before.state.id.clone(),
                    expected: revision,
                    recursive: false,
                },
            },
            None,
        )
        .unwrap();
    send(&mut remote, &mut vault, true);
    assert!(matches!(
        vault
            .store
            .family_materialization(&before.state.id)
            .unwrap()
            .unwrap()
            .publication,
        FamilyPublication::Tombstone
    ));
    assert_eq!(binding(&vault, &before.state.id), before);
    std::fs::remove_file(root.path().join("gone.md")).unwrap();
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    assert_eq!(report.namespace[0].authored.len(), 1);
    assert!(vault
        .store
        .physical_binding(&before.state.id)
        .unwrap()
        .is_none());
    assert!(vault
        .store
        .projection_baseline(&before.state.id)
        .unwrap()
        .is_none());
    assert!(matches!(
        vault
            .store
            .family_materialization(&before.state.id)
            .unwrap()
            .unwrap()
            .publication,
        FamilyPublication::Tombstone
    ));
    assert!(vault.list().unwrap().is_empty());
    assert_eq!(
        vault
            .store
            .import_family_namespace_observation(&report.namespace[0].observation_id)
            .unwrap(),
        report.namespace[0]
    );
}

#[test]
fn external_namespace_prepared_content_race_retains_observation_and_retries_exact_bytes() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("before.md"), b"original bytes").unwrap();
    complete(&mut vault);
    let state = state_at(&vault, "before.md");
    let before = binding(&vault, &state.id);
    let baseline = vault.store.projection_baseline(&state.id).unwrap();
    let logical = vault.read(&state.id).unwrap();
    let status = vault.family_status().unwrap();
    std::fs::rename(root.path().join("before.md"), root.path().join("after.md")).unwrap();
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = Some(root.path().to_path_buf()));
    vault.fault = Some(edit_after_namespace_prepared);
    let report = reconcile(&mut vault);
    vault.fault = None;
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = None);
    assert!(!report.complete, "{report:?}");
    assert!(
        report.run.complete,
        "the capture finished before the content race"
    );
    assert!(!report.issues.is_empty());
    assert!(report.namespace.is_empty());
    assert!(report.imported.is_empty());
    assert_eq!(vault.family_status().unwrap(), status);
    assert_eq!(binding(&vault, &state.id), before);
    assert_eq!(
        vault.store.projection_baseline(&state.id).unwrap(),
        baseline
    );
    assert_eq!(vault.read(&state.id).unwrap(), logical);
    let prepared = namespace_rows(root.path());
    assert_eq!(prepared.len(), 1);
    assert!(!prepared[0].1);
    assert_eq!(
        vault
            .store
            .family_namespace_observation_result(&prepared[0].0)
            .unwrap(),
        None
    );
    let changed = b"changed after namespace preparation";
    assert_eq!(
        std::fs::read(root.path().join("after.md")).unwrap(),
        changed
    );
    let retry = complete(&mut vault);
    assert_eq!(retry.namespace.len(), 1, "{retry:?}");
    assert_ne!(
        retry.namespace[0].observation_id, prepared[0].0,
        "changed capture bytes require a new immutable observation"
    );
    assert_file(&mut vault, &state.id, "after.md", changed);
    assert_eq!(
        binding(&vault, &state.id).physical.inode,
        before.physical.inode
    );
    assert_eq!(
        std::fs::read(root.path().join("after.md")).unwrap(),
        changed
    );
    assert_eq!(
        vault
            .store
            .family_namespace_observation_result(&prepared[0].0)
            .unwrap(),
        None,
        "the stale captured bytes must never receive a committed receipt"
    );
    let rows = namespace_rows(root.path());
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().filter(|(_, resolved)| *resolved).count(), 1);
}

#[test]
fn external_namespace_receipt_failure_rolls_back_all_state_and_retries_same_observation() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("before.md"), b"preserve these bytes").unwrap();
    complete(&mut vault);
    let state = state_at(&vault, "before.md");
    let before = binding(&vault, &state.id);
    let baseline = vault.store.projection_baseline(&state.id).unwrap();
    let logical = vault.read(&state.id).unwrap();
    let materialization = vault.store.family_materialization(&state.id).unwrap();
    let status = vault.family_status().unwrap();
    std::fs::rename(root.path().join("before.md"), root.path().join("after.md")).unwrap();
    let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    sql.execute_batch(
        "CREATE TRIGGER fixture_abort_namespace_receipt BEFORE UPDATE OF result ON family_external_namespace WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture namespace receipt abort'); END;",
    ).unwrap();
    let error = vault
        .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
        .unwrap_err();
    assert!(
        matches!(error, Error::Store(zorid_store::StoreError::Sql(_))),
        "{error:?}"
    );
    assert_eq!(
        vault.family_status().unwrap(),
        status,
        "graph records and authored updates must roll back with the receipt"
    );
    assert_eq!(binding(&vault, &state.id), before);
    assert_eq!(
        vault.store.projection_baseline(&state.id).unwrap(),
        baseline
    );
    assert_eq!(vault.read(&state.id).unwrap(), logical);
    assert_eq!(
        vault.store.family_materialization(&state.id).unwrap(),
        materialization
    );
    assert_eq!(state_at(&vault, "before.md"), state);
    assert_eq!(
        std::fs::read(root.path().join("after.md")).unwrap(),
        b"preserve these bytes"
    );
    let rows = namespace_rows(root.path());
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].1);
    let observation = rows[0].0.clone();
    assert_eq!(
        vault
            .store
            .family_namespace_observation_result(&observation)
            .unwrap(),
        None
    );
    sql.execute_batch("DROP TRIGGER fixture_abort_namespace_receipt")
        .unwrap();
    drop(sql);
    let retry = complete(&mut vault);
    assert_eq!(retry.namespace.len(), 1, "{retry:?}");
    let receipt = &retry.namespace[0];
    assert_eq!(receipt.observation_id, observation);
    assert_eq!(receipt.authored.len(), 1);
    assert_file(&mut vault, &state.id, "after.md", b"preserve these bytes");
    assert_eq!(
        binding(&vault, &state.id).physical.inode,
        before.physical.inode
    );
    assert_eq!(
        namespace_rows(root.path()),
        vec![(observation.clone(), true)]
    );
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    assert_eq!(
        vault
            .store
            .import_family_namespace_observation(&observation)
            .unwrap(),
        *receipt
    );
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
}

#[test]
fn external_namespace_binary_same_bytes_remote_rewrite_blocks_external_edit() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let mut remote = enrolled(peer.path());
    let original = [0, 255, 128, 1];
    std::fs::write(root.path().join("data.bin"), original).unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "data.bin").id);
    let baseline = vault.store.projection_baseline(&before.state.id).unwrap();
    let historical = vault
        .store
        .family_publication(&before.state.id, &before.state.revision)
        .unwrap()
        .unwrap();
    send(&mut vault, &mut remote, false);
    let revision = remote
        .read(&before.state.id)
        .unwrap()
        .unwrap()
        .state
        .revision;
    let outcome = remote
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("same-bytes-remote-write").unwrap(),
                mutation: Mutation::Write {
                    id: before.state.id.clone(),
                    expected: revision,
                    content: original.to_vec(),
                },
            },
            None,
        )
        .unwrap();
    assert!(
        matches!(outcome.projection, ProjectionStatus::Projected),
        "{outcome:?}"
    );
    send(&mut remote, &mut vault, true);
    let current = vault
        .store
        .family_materialization(&before.state.id)
        .unwrap()
        .unwrap();
    assert_ne!(
        current.retained_content, historical.retained_content,
        "identical bytes still have a new binary selected event"
    );
    let logical = vault.read(&before.state.id).unwrap().unwrap();
    assert_ne!(logical.state.revision, before.state.revision);
    assert_eq!(logical.content.as_deref(), Some(original.as_slice()));
    assert_eq!(logical.state.path, before.state.path);
    assert_eq!(binding(&vault, &before.state.id), before);
    let status = vault.family_status().unwrap();
    let external = [128, 0, 222, 4];
    std::fs::write(root.path().join("data.bin"), external).unwrap();
    let report = reconcile(&mut vault);
    assert!(!report.complete, "{report:?}");
    assert!(report.run.complete);
    assert!(report.imported.is_empty());
    assert!(report.namespace.is_empty());
    assert!(!report.issues.is_empty());
    assert_eq!(binding(&vault, &before.state.id), before);
    assert_eq!(
        vault.store.projection_baseline(&before.state.id).unwrap(),
        baseline
    );
    assert_eq!(vault.read(&before.state.id).unwrap().unwrap(), logical);
    assert_eq!(
        vault
            .store
            .family_materialization(&before.state.id)
            .unwrap()
            .unwrap(),
        current
    );
    assert_eq!(vault.family_status().unwrap(), status);
    assert_eq!(
        std::fs::read(root.path().join("data.bin")).unwrap(),
        external
    );
    let observations = vault.store.external_observations().unwrap();
    let observations: Vec<_> = observations
        .into_iter()
        .filter(|o| {
            o.baseline
                .as_ref()
                .is_some_and(|b| b.state.id == before.state.id)
                && vault.test_content_bytes(None, &o.content).unwrap() == external
                && o.resolution.is_none()
        })
        .collect();
    assert_eq!(
        observations.len(),
        1,
        "conflicting external bytes must remain durable"
    );
    assert!(vault
        .store
        .import_family_observation(&observations[0].observation_id)
        .is_err());
    assert_eq!(
        vault
            .store
            .family_materialization(&before.state.id)
            .unwrap()
            .unwrap(),
        current
    );
    assert_eq!(binding(&vault, &before.state.id), before);
}

#[test]
fn external_namespace_binary_remote_move_away_and_back_blocks_external_edit() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let mut remote = enrolled(peer.path());
    let original = [0, 255, 128, 1];
    std::fs::write(root.path().join("data.bin"), original).unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "data.bin").id);
    let baseline = vault.store.projection_baseline(&before.state.id).unwrap();
    let historical = vault
        .store
        .family_publication(&before.state.id, &before.state.revision)
        .unwrap()
        .unwrap();
    send(&mut vault, &mut remote, false);
    for (operation, target) in [
        ("remote-move-away", "away.bin"),
        ("remote-move-back", "data.bin"),
    ] {
        let revision = remote
            .read(&before.state.id)
            .unwrap()
            .unwrap()
            .state
            .revision;
        let outcome = remote
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new(operation).unwrap(),
                    mutation: Mutation::Move {
                        id: before.state.id.clone(),
                        expected: revision,
                        path: path(target),
                    },
                },
                None,
            )
            .unwrap();
        assert!(
            matches!(outcome.projection, ProjectionStatus::Projected),
            "{outcome:?}"
        );
        assert_eq!(std::fs::read(peer.path().join(target)).unwrap(), original);
    }
    assert!(!peer.path().join("away.bin").exists());
    send(&mut remote, &mut vault, true);
    let current = vault
        .store
        .family_materialization(&before.state.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        current.retained_content, historical.retained_content,
        "the remote namespace round trip did not change binary content"
    );
    let (
        FamilyPublication::Normal {
            path: old_path,
            namespace_heads: old_heads,
            ..
        },
        FamilyPublication::Normal {
            path: new_path,
            namespace_heads: new_heads,
            ..
        },
    ) = (&historical.publication, &current.publication)
    else {
        panic!("both materializations must have normal publication");
    };
    assert_eq!(new_path, old_path);
    assert_ne!(
        new_heads, old_heads,
        "matching paths must not hide unseen namespace heads"
    );
    let logical = vault.read(&before.state.id).unwrap().unwrap();
    assert_ne!(logical.state.revision, before.state.revision);
    assert_eq!(logical.state.path, before.state.path);
    assert_eq!(logical.content.as_deref(), Some(original.as_slice()));
    assert_eq!(binding(&vault, &before.state.id), before);
    let status = vault.family_status().unwrap();
    let external = [9, 0, 255, 7];
    std::fs::write(root.path().join("data.bin"), external).unwrap();
    let report = reconcile(&mut vault);
    assert!(!report.complete, "{report:?}");
    assert!(report.run.complete);
    assert!(report.imported.is_empty());
    assert!(report.namespace.is_empty());
    assert!(!report.issues.is_empty());
    assert_eq!(binding(&vault, &before.state.id), before);
    assert_eq!(
        vault.store.projection_baseline(&before.state.id).unwrap(),
        baseline
    );
    assert_eq!(vault.read(&before.state.id).unwrap().unwrap(), logical);
    assert_eq!(
        vault
            .store
            .family_materialization(&before.state.id)
            .unwrap()
            .unwrap(),
        current
    );
    assert_eq!(vault.family_status().unwrap(), status);
    assert_eq!(
        std::fs::read(root.path().join("data.bin")).unwrap(),
        external
    );
    let observations = vault.store.external_observations().unwrap();
    let observations: Vec<_> = observations
        .into_iter()
        .filter(|o| {
            o.baseline
                .as_ref()
                .is_some_and(|b| b.state.id == before.state.id)
                && vault.test_content_bytes(None, &o.content).unwrap() == external
                && o.resolution.is_none()
        })
        .collect();
    assert_eq!(observations.len(), 1, "{report:?}");
    assert!(vault
        .store
        .import_family_observation(&observations[0].observation_id)
        .is_err());
    assert_eq!(
        vault
            .store
            .family_materialization(&before.state.id)
            .unwrap()
            .unwrap(),
        current
    );
    assert_eq!(binding(&vault, &before.state.id), before);
}

#[test]
fn external_namespace_folder_move_child_edit_and_delete_commit_as_one_observation() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::create_dir(root.path().join("ExternalTools")).unwrap();
    std::fs::write(
        root.path().join("ExternalTools/note.custom"),
        b"original note",
    )
    .unwrap();
    std::fs::write(root.path().join("ExternalTools/outside.bin"), [0, 255, 1]).unwrap();
    complete(&mut vault);
    let folder = binding(&vault, &state_at(&vault, "ExternalTools").id);
    let note = binding(&vault, &state_at(&vault, "ExternalTools/note.custom").id);
    let deleted = binding(&vault, &state_at(&vault, "ExternalTools/outside.bin").id);
    std::fs::rename(
        root.path().join("ExternalTools"),
        root.path().join("ExternalRenamed"),
    )
    .unwrap();
    let bytes = b"\xef\xbb\xbfexternally edited note\r\n";
    std::fs::write(root.path().join("ExternalRenamed/note.custom"), bytes).unwrap();
    std::fs::remove_file(root.path().join("ExternalRenamed/outside.bin")).unwrap();
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    assert_eq!(report.namespace[0].authored.len(), 2);
    assert_eq!(report.namespace[0].pending_content.len(), 1);
    assert_eq!(vault.list().unwrap().len(), 2);
    assert_eq!(state_at(&vault, "ExternalRenamed").id, folder.state.id);
    assert_eq!(
        binding(&vault, &folder.state.id).physical.inode,
        folder.physical.inode
    );
    assert_eq!(
        binding(&vault, &note.state.id).physical.inode,
        note.physical.inode
    );
    assert_file(
        &mut vault,
        &note.state.id,
        "ExternalRenamed/note.custom",
        bytes,
    );
    assert!(vault
        .store
        .physical_binding(&deleted.state.id)
        .unwrap()
        .is_none());
    assert!(vault
        .store
        .projection_baseline(&deleted.state.id)
        .unwrap()
        .is_none());
    assert!(!vault
        .list()
        .unwrap()
        .iter()
        .any(|e| e.id == deleted.state.id));
    assert!(!root.path().join("ExternalTools").exists());
    assert!(!root.path().join("ExternalRenamed/outside.bin").exists());
    assert_eq!(
        std::fs::read(root.path().join("ExternalRenamed/note.custom")).unwrap(),
        bytes
    );
    assert_eq!(
        namespace_rows(root.path()),
        vec![(report.namespace[0].observation_id.clone(), true)]
    );
}

#[test]
fn external_namespace_prepared_invalid_json_is_fatal_and_never_authors() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("before.md"), b"retained").unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "before.md").id);
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    std::fs::rename(root.path().join("before.md"), root.path().join("after.md")).unwrap();
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = Some(root.path().to_path_buf()));
    vault.fault = Some(corrupt_namespace_record_after_prepared);
    let result = vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto);
    vault.fault = None;
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = None);
    let error = result.unwrap_err();
    assert!(
        matches!(error, Error::Store(zorid_store::StoreError::Json(_))),
        "{error:?}"
    );
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
    assert_eq!(binding(&vault, &before.state.id), before);
    assert_eq!(namespace_rows(root.path()).len(), 1);
    assert!(!namespace_rows(root.path())[0].1);
    assert_eq!(
        std::fs::read(root.path().join("after.md")).unwrap(),
        b"retained"
    );
}

#[test]
fn external_namespace_prepared_corrupt_graph_cache_is_fatal_and_never_authors() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("before.md"), b"retained").unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "before.md").id);
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    std::fs::rename(root.path().join("before.md"), root.path().join("after.md")).unwrap();
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = Some(root.path().to_path_buf()));
    vault.fault = Some(corrupt_graph_cache_after_prepared);
    let result = vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto);
    vault.fault = None;
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = None);
    let error = result.unwrap_err();
    assert!(
        matches!(error, Error::Store(zorid_store::StoreError::Corrupt(_))),
        "{error:?}"
    );
    // Public family status intentionally rejects the corrupt graph. Inspect
    // the independent durable outbox count without loading that graph again.
    let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    let retained: i64 = sql
        .query_row(
            "SELECT count(*) FROM authored_envelopes WHERE accepted=0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(usize::try_from(retained).unwrap(), authored);
    drop(sql);
    assert_eq!(binding(&vault, &before.state.id), before);
    assert_eq!(namespace_rows(root.path()).len(), 1);
    assert!(!namespace_rows(root.path())[0].1);
    assert_eq!(
        std::fs::read(root.path().join("after.md")).unwrap(),
        b"retained"
    );
}

#[test]
fn external_namespace_prepared_private_permission_change_is_fatal_and_retryable() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("before.md"), b"retained").unwrap();
    complete(&mut vault);
    let before = binding(&vault, &state_at(&vault, "before.md").id);
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    std::fs::rename(root.path().join("before.md"), root.path().join("after.md")).unwrap();
    let permissions = std::fs::metadata(root.path().join(".zorid"))
        .unwrap()
        .permissions();
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = Some(root.path().to_path_buf()));
    vault.fault = Some(expose_private_directory_after_prepared);
    let result = vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto);
    vault.fault = None;
    std::fs::set_permissions(root.path().join(".zorid"), permissions).unwrap();
    PREPARED_EDIT_ROOT.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(
        std::fs::metadata(root.path().join(".zorid"))
            .unwrap()
            .permissions()
            .mode()
            & 0o077,
        0
    );
    let error = result.unwrap_err();
    assert!(matches!(error, Error::UnsafePath(_)), "{error:?}");
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
    assert_eq!(binding(&vault, &before.state.id), before);
    let rows = namespace_rows(root.path());
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].1);
    let retry = complete(&mut vault);
    assert_eq!(retry.namespace.len(), 1);
    assert_eq!(retry.namespace[0].observation_id, rows[0].0);
    assert_file(&mut vault, &before.state.id, "after.md", b"retained");
}

#[test]
fn external_namespace_compound_deleted_subtree_preserves_unseen_remote_text_recovery() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let mut remote = enrolled(peer.path());
    std::fs::create_dir_all(root.path().join("ExternalTools/removed/nested")).unwrap();
    std::fs::write(
        root.path().join("ExternalTools/note.custom"),
        b"original note",
    )
    .unwrap();
    std::fs::write(
        root.path().join("ExternalTools/removed/nested/gone.custom"),
        b"base",
    )
    .unwrap();
    complete(&mut vault);
    let folder = binding(&vault, &state_at(&vault, "ExternalTools").id);
    let note = binding(&vault, &state_at(&vault, "ExternalTools/note.custom").id);
    let deleted: Vec<_> = vault
        .store
        .physical_bindings()
        .unwrap()
        .into_iter()
        .filter(|b| {
            b.state.path == path("ExternalTools/removed")
                || b.state
                    .path
                    .is_descendant_of(&path("ExternalTools/removed"))
        })
        .collect();
    assert_eq!(deleted.len(), 3);
    let gone = state_at(&vault, "ExternalTools/removed/nested/gone.custom");
    send(&mut vault, &mut remote, false);
    let revision = remote.read(&gone.id).unwrap().unwrap().state.revision;
    remote
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("unseen-deleted-subtree-edit").unwrap(),
                mutation: Mutation::Write {
                    id: gone.id.clone(),
                    expected: revision,
                    content: b"REMOTE base".to_vec(),
                },
            },
            None,
        )
        .unwrap();
    std::fs::rename(
        root.path().join("ExternalTools"),
        root.path().join("ExternalRenamed"),
    )
    .unwrap();
    std::fs::write(
        root.path().join("ExternalRenamed/note.custom"),
        b"surviving note edit",
    )
    .unwrap();
    std::fs::remove_dir_all(root.path().join("ExternalRenamed/removed")).unwrap();
    send(&mut remote, &mut vault, true);
    let remote_text = vault.store.family_text_state(&gone.id).unwrap().unwrap();
    assert_eq!(
        remote_text.complete_materialized_utf8().unwrap().unwrap(),
        b"REMOTE base"
    );
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    assert_eq!(report.namespace[0].authored.len(), deleted.len() + 1);
    assert_eq!(report.namespace[0].pending_content.len(), 1);
    assert_eq!(
        binding(&vault, &folder.state.id).physical.inode,
        folder.physical.inode
    );
    assert_eq!(
        binding(&vault, &folder.state.id).state.path,
        path("ExternalRenamed")
    );
    assert_eq!(
        binding(&vault, &note.state.id).physical.inode,
        note.physical.inode
    );
    assert_file(
        &mut vault,
        &note.state.id,
        "ExternalRenamed/note.custom",
        b"surviving note edit",
    );
    for member in deleted {
        assert!(vault
            .store
            .physical_binding(&member.state.id)
            .unwrap()
            .is_none());
        assert!(vault
            .store
            .projection_baseline(&member.state.id)
            .unwrap()
            .is_none());
        assert!(!vault
            .list()
            .unwrap()
            .iter()
            .any(|e| e.id == member.state.id));
    }
    assert!(matches!(
        vault
            .store
            .family_materialization(&gone.id)
            .unwrap()
            .unwrap()
            .publication,
        FamilyPublication::Recovery { .. }
    ));
    assert_eq!(
        vault.store.family_text_state(&gone.id).unwrap().unwrap(),
        remote_text
    );
    assert!(!root.path().join("ExternalRenamed/removed").exists());
    assert_eq!(vault.list().unwrap().len(), 2);
}

#[test]
fn external_namespace_compound_prepared_restart_reuses_one_receipt_and_captured_ids() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::create_dir(root.path().join("ExternalTools")).unwrap();
    std::fs::write(
        root.path().join("ExternalTools/note.custom"),
        b"original note",
    )
    .unwrap();
    std::fs::write(root.path().join("ExternalTools/outside.bin"), [0, 255, 1]).unwrap();
    complete(&mut vault);
    let folder = state_at(&vault, "ExternalTools");
    let note = state_at(&vault, "ExternalTools/note.custom");
    let deleted = state_at(&vault, "ExternalTools/outside.bin");
    let bindings = vault.store.physical_bindings().unwrap();
    let status = vault.family_status().unwrap();
    std::fs::rename(
        root.path().join("ExternalTools"),
        root.path().join("ExternalRenamed"),
    )
    .unwrap();
    std::fs::write(
        root.path().join("ExternalRenamed/note.custom"),
        b"prepared note edit\r\n",
    )
    .unwrap();
    std::fs::remove_file(root.path().join("ExternalRenamed/outside.bin")).unwrap();
    vault.fault = Some(|point| {
        if point == "external_namespace_prepared" {
            panic!("prepared compound interruption");
        }
    });
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| reconcile(&mut vault))).is_err()
    );
    assert_eq!(vault.store.physical_bindings().unwrap(), bindings);
    assert_eq!(vault.family_status().unwrap(), status);
    assert_eq!(state_at(&vault, "ExternalTools"), folder);
    assert_eq!(state_at(&vault, "ExternalTools/note.custom"), note);
    assert_eq!(state_at(&vault, "ExternalTools/outside.bin"), deleted);
    let rows = namespace_rows(root.path());
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].1);
    let observation = rows[0].0.clone();
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let report = complete(&mut vault);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    let receipt = &report.namespace[0];
    assert_eq!(receipt.observation_id, observation);
    assert_eq!(receipt.authored.len(), 2);
    assert_eq!(state_at(&vault, "ExternalRenamed").id, folder.id);
    assert_file(
        &mut vault,
        &note.id,
        "ExternalRenamed/note.custom",
        b"prepared note edit\r\n",
    );
    assert!(vault.store.physical_binding(&deleted.id).unwrap().is_none());
    assert!(vault
        .store
        .projection_baseline(&deleted.id)
        .unwrap()
        .is_none());
    assert_eq!(
        namespace_rows(root.path()),
        vec![(observation.clone(), true)]
    );
    let authored = vault.family_pending_authored(None, 1000).unwrap().len();
    assert_eq!(
        vault
            .store
            .import_family_namespace_observation(&observation)
            .unwrap(),
        *receipt
    );
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        authored
    );
    let repeat = complete(&mut vault);
    assert!(repeat.namespace.is_empty());
    assert!(repeat.imported.is_empty());
    assert_eq!(namespace_rows(root.path()), vec![(observation, true)]);
}

fn assert_compound_ambiguous_member_rejected(case: u8) {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::create_dir_all(root.path().join("ExternalTools/parent")).unwrap();
    std::fs::write(
        root.path().join("ExternalTools/parent/child.custom"),
        b"tracked child",
    )
    .unwrap();
    std::fs::write(
        root.path().join("ExternalTools/note.custom"),
        b"tracked survivor",
    )
    .unwrap();
    complete(&mut vault);
    let before = vault.store.physical_bindings().unwrap();
    let logical = vault.list().unwrap();
    let status = vault.family_status().unwrap();
    // Retain descriptors so a freshly created replacement cannot accidentally
    // reuse an unlinked fixture inode and turn this into a different test.
    let held_parent = std::fs::File::open(root.path().join("ExternalTools/parent")).unwrap();
    let held_child =
        std::fs::File::open(root.path().join("ExternalTools/parent/child.custom")).unwrap();
    std::fs::rename(
        root.path().join("ExternalTools"),
        root.path().join("ExternalRenamed"),
    )
    .unwrap();
    match case {
        0 => {
            std::fs::remove_file(root.path().join("ExternalRenamed/parent/child.custom")).unwrap();
            std::fs::write(
                root.path().join("ExternalRenamed/parent/child.custom"),
                b"replacement",
            )
            .unwrap();
            let replacement =
                std::fs::File::open(root.path().join("ExternalRenamed/parent/child.custom"))
                    .unwrap();
            assert_ne!(
                fs::identity(&replacement).unwrap(),
                fs::identity(&held_child).unwrap()
            );
        }
        1 => {
            std::fs::remove_dir_all(root.path().join("ExternalRenamed/parent")).unwrap();
            std::fs::create_dir(root.path().join("ExternalRenamed/parent")).unwrap();
            let replacement =
                std::fs::File::open(root.path().join("ExternalRenamed/parent")).unwrap();
            assert_ne!(
                fs::identity(&replacement).unwrap(),
                fs::identity(&held_parent).unwrap()
            );
        }
        2 => {
            std::fs::rename(
                root.path().join("ExternalRenamed/parent/child.custom"),
                root.path().join("escaped.custom"),
            )
            .unwrap();
            let escaped = std::fs::File::open(root.path().join("escaped.custom")).unwrap();
            assert_eq!(
                fs::identity(&escaped).unwrap(),
                fs::identity(&held_child).unwrap()
            );
        }
        _ => unreachable!(),
    }
    let report = reconcile(&mut vault);
    assert!(!report.complete, "{report:?}");
    assert!(report.run.complete);
    assert!(!report.issues.is_empty());
    assert!(report.namespace.is_empty());
    assert!(report.imported.is_empty());
    assert_eq!(vault.family_status().unwrap(), status);
    assert_eq!(vault.store.physical_bindings().unwrap(), before);
    assert_eq!(vault.list().unwrap(), logical);
    assert!(namespace_rows(root.path()).is_empty());
    for member in before {
        if member.state.kind == EntryKind::File {
            let baseline = vault
                .store
                .projection_baseline(&member.state.id)
                .unwrap()
                .unwrap();
            assert_eq!(baseline.state, member.state);
            assert_eq!(
                vault
                    .test_content_bytes(Some(&baseline.state), &baseline.content)
                    .unwrap(),
                if member.state.path.file_name() == "child.custom" {
                    b"tracked child".to_vec()
                } else {
                    b"tracked survivor".to_vec()
                }
            );
        }
    }
}

#[test]
fn external_namespace_compound_rejects_replacement_at_relocated_child_path() {
    assert_compound_ambiguous_member_rejected(0);
}

#[test]
fn external_namespace_compound_rejects_replaced_missing_child_parent_inode() {
    assert_compound_ambiguous_member_rejected(1);
}

#[test]
fn external_namespace_compound_rejects_deleted_inode_observed_elsewhere() {
    assert_compound_ambiguous_member_rejected(2);
}
