//! Public native reconciliation of an idle, content-equivalent physical copy.
use std::{fs, path::Path};
use rusqlite::{params, Connection};
use serde_json::Value;
use zorid_core::{Mutation, MutationRequest, OperationId};
use zorid_native::{ExternalFileMode, FamilyScope, NativeVault, ProjectionStatus, ScanOptions};
use zorid_sync_protocol::{RealmId, VaultId};

fn op(value: &str) -> OperationId { OperationId::new(value).unwrap() }
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("Folder")).unwrap();
    fs::write(dir.path().join("Folder/Note.md"), b"saved note\n").unwrap();
    fs::write(dir.path().join("Folder/data.bin"), [0, 255, 7]).unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault.family_enroll(&FamilyScope { realm_id: RealmId::new("rebaseline-realm").unwrap(), vault_id: VaultId::new("rebaseline-vault").unwrap() }).unwrap();
    assert!(vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto).unwrap().complete);
    assert!(vault.recover().unwrap().blocked.is_empty());
    dir
}
fn bindings(root: &Path) -> Vec<String> {
    Connection::open(root.join(".zorid/vault.sqlite")).unwrap()
        .prepare("SELECT record FROM physical_bindings ORDER BY entry_id").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}
fn proofs(root: &Path) -> Vec<String> {
    Connection::open(root.join(".zorid/vault.sqlite")).unwrap()
        .prepare("SELECT record FROM publication_parent_proofs ORDER BY attempt_id").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}
fn old_device(root: &Path) {
    let mut db = Connection::open(root.join(".zorid/vault.sqlite")).unwrap();
    let tx = db.transaction().unwrap();
    let rows: Vec<String> = tx.prepare("SELECT record FROM physical_bindings").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    for raw in rows {
        let mut row: Value = serde_json::from_str(&raw).unwrap();
        for field in ["inode", "parent_inode"] {
            let inode = row["physical"][field].as_str().unwrap().rsplit(':').next().unwrap();
            row["physical"][field] = Value::String(format!("old-device:{inode}"));
        }
        let id = row["state"]["id"].as_str().unwrap();
        tx.execute("UPDATE physical_bindings SET inode=?1,parent_inode=?2,record=?3 WHERE entry_id=?4",
            params![row["physical"]["inode"].as_str(), row["physical"]["parent_inode"].as_str(), row.to_string(), id]).unwrap();
        if row["state"]["kind"] == "folder" {
            let baseline = serde_json::json!({"state":row["state"],"identity":row["physical"]["inode"]});
            tx.execute("UPDATE directory_baselines SET record=?1 WHERE entry_id=?2", params![baseline.to_string(), id]).unwrap();
        }
    }
    tx.commit().unwrap();
}

#[test]
fn idle_equivalent_nested_files_rebaseline_and_save_without_changing_history() {
    let dir = fixture(); old_device(dir.path());
    let before = bindings(dir.path()); let history = proofs(dir.path());
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let states = vault.list().unwrap();
    // New physical files do not prevent repair of already-bound parents.
    fs::write(dir.path().join("Folder/New.md"), b"new file\n").unwrap();
    let report = vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto).unwrap();
    assert!(report.complete, "{report:?}");
    for state in states {
        let current = vault.read(&state.id).unwrap().unwrap().state;
        assert_eq!(current.path, state.path); assert_eq!(current.kind, state.kind);
        // Importing New.md legitimately advances its ancestor's revision; the
        // previously saved Text/Binary entries themselves remain unchanged.
        if state.kind == zorid_core::EntryKind::File { assert_eq!(current, state); }
    }
    assert_ne!(bindings(dir.path()), before);
    assert_eq!(proofs(dir.path()), history, "historical publication proofs are immutable");
    assert_eq!(fs::read(dir.path().join("Folder/data.bin")).unwrap(), [0, 255, 7]);
    let note = vault.list().unwrap().into_iter().find(|s| s.path.as_str() == "Folder/Note.md").unwrap();
    let saved = vault.family_apply(&MutationRequest { operation_id: op("normal-save"), mutation: Mutation::Write { id: note.id, expected: note.revision, content: b"normal saved edit\n".to_vec() } }, None).unwrap();
    assert!(matches!(saved.projection, ProjectionStatus::Projected), "{saved:?}");
    assert_eq!(fs::read(dir.path().join("Folder/Note.md")).unwrap(), b"normal saved edit\n");
}

#[test]
fn changed_bytes_do_not_rebaseline_or_get_overwritten() {
    let dir = fixture(); old_device(dir.path()); let before = bindings(dir.path());
    fs::write(dir.path().join("Folder/Note.md"), b"external changed bytes\n").unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    assert!(!vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto).unwrap().complete);
    assert_eq!(bindings(dir.path()), before);
    assert_eq!(fs::read(dir.path().join("Folder/Note.md")).unwrap(), b"external changed bytes\n");
}

#[test]
fn prepared_write_prevents_rebaseline_of_its_parent() {
    let dir = fixture(); old_device(dir.path()); let before = bindings(dir.path());
    let mut vault = NativeVault::open(dir.path()).unwrap();
    let note = vault.list().unwrap().into_iter().find(|s| s.path.as_str() == "Folder/Note.md").unwrap();
    vault.prepare_host_intent(&op("pending-client"), &MutationRequest { operation_id: op("pending-save"), mutation: Mutation::Write { id: note.id, expected: note.revision, content: b"pending bytes\n".to_vec() } }).unwrap();
    assert!(!vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto).unwrap().complete);
    assert_eq!(bindings(dir.path()), before);
    assert_eq!(fs::read(dir.path().join("Folder/Note.md")).unwrap(), b"saved note\n");
}

#[test]
fn original_inode_elsewhere_prevents_adopting_same_byte_replacement() {
    let dir = fixture(); let before = bindings(dir.path());
    fs::rename(dir.path().join("Folder/Note.md"), dir.path().join("Original.md")).unwrap();
    fs::write(dir.path().join("Folder/Note.md"), b"saved note\n").unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    assert!(!vault.reconcile_external(ScanOptions::default(), ExternalFileMode::Auto).unwrap().complete);
    assert_eq!(bindings(dir.path()), before);
    assert_eq!(fs::read(dir.path().join("Original.md")).unwrap(), b"saved note\n");
}
