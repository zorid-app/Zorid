//! Namespace scheduling does not borrow authority from unrelated file bodies.
use super::*;
use std::{cell::RefCell, collections::BTreeMap, path::Path};

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).unwrap()
}
fn options() -> ExternalReconcileOptions {
    ExternalReconcileOptions {
        scan: ScanOptions {
            max_duration: std::time::Duration::from_secs(5),
            ..ScanOptions::default()
        },
        max_work_units: std::num::NonZeroU16::new(256).unwrap(),
    }
}
fn fixture(folder: bool) -> (tempfile::TempDir, NativeVault, BTreeMap<String, EntryId>) {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: zorid_sync_protocol::RealmId::new("candidate-realm").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("candidate-vault").unwrap(),
        })
        .unwrap();
    std::fs::write(root.path().join("Kept.md"), b"kept unchanged").unwrap();
    if folder {
        std::fs::create_dir(root.path().join("Folder")).unwrap();
        std::fs::write(root.path().join("Folder/member.md"), b"member original").unwrap();
    } else {
        std::fs::write(root.path().join("Removed.md"), b"removed original").unwrap();
    }
    let report = vault
        .reconcile_external(options().scan, ExternalFileMode::Auto)
        .unwrap();
    assert!(report.complete, "{report:?}");
    let ids = vault
        .store
        .list()
        .unwrap()
        .into_iter()
        .map(|state| (state.path.as_str().to_owned(), state.id))
        .collect();
    (root, vault, ids)
}
fn corrupt_baseline(root: &Path, id: &EntryId) {
    let sql = rusqlite::Connection::open(root.join(".zorid/vault.sqlite")).unwrap();
    assert_eq!(
        sql.execute(
            "UPDATE projection_baselines SET record='invalid-json' WHERE entry_id=?1",
            [id.as_str()]
        )
        .unwrap(),
        1
    );
}
fn authored(root: &Path) -> i64 {
    rusqlite::Connection::open(root.join(".zorid/vault.sqlite"))
        .unwrap()
        .query_row("SELECT count(*) FROM authored_envelopes", [], |row| {
            row.get(0)
        })
        .unwrap()
}
fn reconcile_source(vault: &mut NativeVault) -> Result<ExternalReconcileReport> {
    let lock = vault.paths.lock(vault.options.lock_timeout)?;
    let admission = EnrolledScan::admit(vault, &lock)?;
    let options = options();
    let mut budget = external_scan_quantum::ExternalWorkBudget::new(&options)?;
    vault
        .reconcile_external_locked(
            options.scan,
            ExternalFileMode::Auto,
            &admission,
            Some(&mut budget),
        )
        .map(|(report, _)| report)
}

#[test]
fn already_processed_positive_body_does_not_block_unrelated_namespace_work() {
    let (root, mut vault, ids) = fixture(false);
    std::fs::remove_file(root.path().join("Removed.md")).unwrap();
    {
        let _lock = vault.paths.lock(vault.options.lock_timeout).unwrap();
        let mut scan = vault.external_progress_scan_locked(options().scan).unwrap();
        assert!(scan.run.complete);
        // Positive file was fully valid when acknowledged. Later corruption of
        // its unrelated saved body must not be namespace-candidate authority.
        scan.record_processed_retaining(&mut vault, &[path("Kept.md")], true)
            .unwrap();
    }
    corrupt_baseline(root.path(), &ids["Kept.md"]);
    assert!(
        vault.store.physical_bindings().is_err(),
        "explicit full audit stays strict"
    );
    assert!(
        vault.store.physical_binding(&ids["Kept.md"]).is_err(),
        "selecting damaged body stays strict"
    );
    let report = reconcile_source(&mut vault).unwrap();
    assert!(report.complete, "{report:?}");
    assert_eq!(report.namespace.len(), 1);
    assert!(vault
        .store
        .read_metadata(&ids["Removed.md"])
        .unwrap()
        .is_none());
    assert!(matches!(
        vault
            .store
            .family_materialization(&ids["Removed.md"])
            .unwrap()
            .unwrap()
            .publication,
        zorid_store::FamilyPublication::Tombstone
    ));
    assert_eq!(
        std::fs::read(root.path().join("Kept.md")).unwrap(),
        b"kept unchanged"
    );
    assert!(
        vault.store.physical_bindings().is_err(),
        "unrelated damage was deferred, not repaired/blessed"
    );
    assert!(vault.store.physical_binding(&ids["Kept.md"]).is_err());
}

#[test]
fn selected_negative_move_and_replacement_reject_damaged_body_before_authoring() {
    for action in ["delete", "move", "replacement"] {
        let (root, mut vault, ids) = fixture(false);
        match action {
            "delete" => std::fs::remove_file(root.path().join("Removed.md")).unwrap(),
            "move" => std::fs::rename(root.path().join("Removed.md"), root.path().join("Moved.md"))
                .unwrap(),
            _ => {
                std::fs::rename(
                    root.path().join("Removed.md"),
                    root.path().join(".zorid/original.md"),
                )
                .unwrap();
                std::fs::write(root.path().join("Removed.md"), b"replacement occupant").unwrap();
            }
        }
        corrupt_baseline(root.path(), &ids["Removed.md"]);
        let before = authored(root.path());
        assert!(
            reconcile_source(&mut vault).is_err(),
            "selected corruption: {action}"
        );
        assert_eq!(
            authored(root.path()),
            before,
            "no authored namespace mutation: {action}"
        );
        let retained = if action == "move" {
            "Moved.md"
        } else if action == "replacement" {
            ".zorid/original.md"
        } else {
            "Kept.md"
        };
        assert_eq!(
            std::fs::read(root.path().join(retained)).unwrap(),
            if action == "delete" {
                b"kept unchanged".as_slice()
            } else {
                b"removed original".as_slice()
            }
        );
        if action == "replacement" {
            assert_eq!(
                std::fs::read(root.path().join("Removed.md")).unwrap(),
                b"replacement occupant"
            );
        }
    }
}

#[test]
fn moved_folder_validates_every_selected_member_before_authoring() {
    let (root, mut vault, ids) = fixture(true);
    std::fs::rename(root.path().join("Folder"), root.path().join("MovedFolder")).unwrap();
    corrupt_baseline(root.path(), &ids["Folder/member.md"]);
    assert!(
        vault
            .store
            .physical_binding(&ids["Folder"])
            .unwrap()
            .is_some(),
        "root itself is valid"
    );
    let before = authored(root.path());
    assert!(reconcile_source(&mut vault).is_err());
    assert_eq!(authored(root.path()), before);
    assert_eq!(
        std::fs::read(root.path().join("MovedFolder/member.md")).unwrap(),
        b"member original"
    );
}

thread_local! { static FOREIGN_CHANGE: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) }; }
fn foreign_change(point: &str) {
    if point == "external_namespace_candidates_loaded" {
        let change = FOREIGN_CHANGE.with(|slot| slot.borrow_mut().take());
        if let Some(change) = change {
            change();
        }
    }
}
struct ClearForeign;
impl Drop for ClearForeign {
    fn drop(&mut self) {
        FOREIGN_CHANGE.with(|slot| slot.borrow_mut().take());
    }
}

#[test]
fn foreign_corruption_after_candidate_enumeration_cannot_author_a_stale_namespace_change() {
    let (root, mut vault, ids) = fixture(false);
    std::fs::remove_file(root.path().join("Removed.md")).unwrap();
    let before = authored(root.path());
    let root_path = root.path().to_owned();
    let selected = ids["Removed.md"].clone();
    FOREIGN_CHANGE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || corrupt_baseline(&root_path, &selected)))
    });
    let _clear = ClearForeign;
    vault.fault = Some(foreign_change);
    let rejected = match reconcile_source(&mut vault) {
        Err(_) => true,
        Ok(report) => !report.issues.is_empty(),
    };
    assert!(
        FOREIGN_CHANGE.with(|slot| slot.borrow().is_none()),
        "foreign writer actually ran after enumeration"
    );
    assert!(rejected);
    assert_eq!(authored(root.path()), before);
    assert_eq!(
        std::fs::read(root.path().join("Kept.md")).unwrap(),
        b"kept unchanged"
    );
}

#[test]
fn clean_folder_move_and_delete_keep_ids_and_member_closure_across_restart() {
    let (root, vault, ids) = fixture(true);
    drop(vault);
    std::fs::rename(root.path().join("Folder"), root.path().join("MovedFolder")).unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    let moved = reconcile_source(&mut vault).unwrap();
    assert!(moved.complete, "{moved:?}");
    assert_eq!(
        vault
            .store
            .read_path_metadata(&path("MovedFolder"))
            .unwrap()
            .unwrap()
            .state
            .id,
        ids["Folder"]
    );
    assert_eq!(
        vault
            .store
            .read_path_metadata(&path("MovedFolder/member.md"))
            .unwrap()
            .unwrap()
            .state
            .id,
        ids["Folder/member.md"]
    );
    drop(vault);
    std::fs::remove_dir_all(root.path().join("MovedFolder")).unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    let deleted = reconcile_source(&mut vault).unwrap();
    assert!(deleted.complete, "{deleted:?}");
    for id in [&ids["Folder"], &ids["Folder/member.md"]] {
        assert!(vault.store.read_metadata(id).unwrap().is_none());
        assert!(matches!(
            vault
                .store
                .family_materialization(id)
                .unwrap()
                .unwrap()
                .publication,
            zorid_store::FamilyPublication::Tombstone
        ));
    }
    assert_eq!(
        std::fs::read(root.path().join("Kept.md")).unwrap(),
        b"kept unchanged"
    );
}
