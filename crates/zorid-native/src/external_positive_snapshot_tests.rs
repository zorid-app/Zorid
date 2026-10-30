use super::*;
use std::{
    cell::{Cell, RefCell},
    fs::{FileTimes, OpenOptions},
    os::unix::fs::MetadataExt,
};

const ORIGINAL: &[u8] = b"original body";
const CAPTURED: &[u8] = b"captured body";
const MODIFIED: &[u8] = b"modified body";
thread_local! {
    static PROOFS: Cell<usize> = const { Cell::new(0) };
    static AFTER_CAPTURE: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
}
fn probe(point: &str) {
    if point == "external_positive_file_proof" {
        PROOFS.with(|count| count.set(count.get() + 1));
    }
    if point == "external_positive_snapshot_captured" {
        let action = AFTER_CAPTURE.with(|slot| slot.borrow_mut().take());
        if let Some(action) = action {
            action();
        }
    }
}
struct Reset;
impl Drop for Reset {
    fn drop(&mut self) {
        AFTER_CAPTURE.with(|slot| slot.borrow_mut().take());
    }
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
fn fixture(existing: bool) -> (tempfile::TempDir, NativeVault) {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: zorid_sync_protocol::RealmId::new("positive-realm").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("positive-vault").unwrap(),
        })
        .unwrap();
    std::fs::create_dir(root.path().join("Folder")).unwrap();
    if existing {
        std::fs::write(root.path().join("Folder/note.md"), ORIGINAL).unwrap();
    }
    assert!(
        vault
            .reconcile_external(options().scan, ExternalFileMode::Auto)
            .unwrap()
            .complete
    );
    std::fs::write(root.path().join("Folder/note.md"), CAPTURED).unwrap();
    PROOFS.with(|count| count.set(0));
    vault.fault = Some(probe);
    (root, vault)
}
fn source(vault: &mut NativeVault) -> Result<ExternalReconcileReport> {
    let lock = vault.paths.lock(vault.options.lock_timeout)?;
    let admitted = EnrolledScan::admit(vault, &lock)?;
    let options = options();
    let mut budget = external_scan_quantum::ExternalWorkBudget::new(&options)?;
    vault
        .reconcile_external_locked(
            options.scan,
            ExternalFileMode::Auto,
            &admitted,
            Some(&mut budget),
        )
        .map(|(report, _)| report)
}
fn authored(root: &std::path::Path) -> i64 {
    rusqlite::Connection::open(root.join(".zorid/vault.sqlite"))
        .unwrap()
        .query_row("SELECT count(*) FROM authored_envelopes", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn positive_existing_and_new_file_enrollment_request_one_inventory_file_proof() {
    for existing in [true, false] {
        let (_root, mut vault) = fixture(existing);
        let _reset = Reset;
        let report = source(&mut vault).unwrap();
        assert!(report.complete, "{report:?}");
        assert_eq!(
            PROOFS.with(Cell::get),
            1,
            "one positive attempt, existing={existing}"
        );
        assert_eq!(
            vault
                .store
                .read_path(&VaultPath::new("Folder/note.md").unwrap())
                .unwrap()
                .unwrap()
                .content
                .as_deref(),
            Some(CAPTURED)
        );
    }
}

#[test]
fn changes_after_initial_file_proof_preserve_data_without_stale_authoring() {
    for existing in [true, false] {
        for race in [
            "same-inode-size-mtime",
            "replacement-inode",
            "replacement-parent",
        ] {
            let (root, mut vault) = fixture(existing);
            let _reset = Reset;
            let note = root.path().join("Folder/note.md");
            let before = std::fs::metadata(&note).unwrap();
            let modified = before.modified().unwrap();
            let original_inode = (before.dev(), before.ino());
            let root_path = root.path().to_owned();
            let authors = authored(root.path());
            let cursor = vault.store.changes_after("0", 1).unwrap().head_cursor;
            AFTER_CAPTURE.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    let public = root_path.join("Folder/note.md");
                    match race {
                        "same-inode-size-mtime" => {
                            std::fs::write(&public, MODIFIED).unwrap();
                        }
                        "replacement-inode" => {
                            std::fs::rename(&public, root_path.join(".zorid/old-note.md")).unwrap();
                            std::fs::write(&public, CAPTURED).unwrap();
                        }
                        _ => {
                            std::fs::rename(root_path.join("Folder"), root_path.join("Detached"))
                                .unwrap();
                            std::fs::create_dir(root_path.join("Folder")).unwrap();
                            std::fs::rename(root_path.join("Detached/note.md"), &public).unwrap();
                        }
                    }
                    OpenOptions::new()
                        .write(true)
                        .open(&public)
                        .unwrap()
                        .set_times(FileTimes::new().set_modified(modified))
                        .unwrap();
                    let after = std::fs::metadata(&public).unwrap();
                    assert_eq!(after.len(), CAPTURED.len() as u64);
                    assert_eq!(after.modified().unwrap(), modified);
                    if race != "replacement-inode" {
                        assert_eq!((after.dev(), after.ino()), original_inode);
                    }
                }))
            });
            let rejected = match source(&mut vault) {
                Err(_) => true,
                Ok(report) => !report.complete,
            };
            assert!(rejected, "{existing}/{race}");
            assert!(
                AFTER_CAPTURE.with(|slot| slot.borrow().is_none()),
                "real race hook ran"
            );
            assert_eq!(authored(root.path()), authors);
            assert_eq!(
                vault.store.changes_after("0", 1).unwrap().head_cursor,
                cursor
            );
            assert_eq!(
                std::fs::read(&note).unwrap(),
                if race == "same-inode-size-mtime" {
                    MODIFIED
                } else {
                    CAPTURED
                }
            );
            if race == "replacement-inode" {
                assert_eq!(
                    std::fs::read(root.path().join(".zorid/old-note.md")).unwrap(),
                    CAPTURED
                );
            }
            let logical = vault
                .store
                .read_path(&VaultPath::new("Folder/note.md").unwrap())
                .unwrap();
            if existing {
                assert_eq!(logical.unwrap().content.as_deref(), Some(ORIGINAL));
            } else {
                assert!(logical.is_none());
            }
        }
    }
}
