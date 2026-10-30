//! An external edit must not reload unrelated notes to import one Text branch.
use rusqlite::ffi;
use std::{cell::Cell, ffi::{c_char, c_int, c_void, CStr}, sync::Mutex};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_native::{FamilyCreateMode, FamilyScope, NativeVault};
use zorid_sync_protocol::{RealmId, VaultId};

thread_local! {
    static ATTACH: Cell<bool> = const { Cell::new(false) };
    static MEASURE: Cell<bool> = const { Cell::new(false) };
    static READS: Cell<[usize; 3]> = const { Cell::new([0; 3]) };
}
static REGISTRATION: Mutex<()> = Mutex::new(());
unsafe extern "C" fn trace(event: u32, _: *mut c_void, _: *mut c_void, sql: *mut c_void) -> c_int {
    if event == ffi::SQLITE_TRACE_STMT && !sql.is_null() && MEASURE.with(Cell::get) {
        let sql = unsafe { CStr::from_ptr(sql.cast()) }.to_bytes();
        let has = |part: &[u8]| sql.windows(part.len()).any(|window| window == part);
        READS.with(|value| {
            let mut reads = value.get();
            // Observe real executed whole-corpus reads, not Rust helper calls.
            reads[0] += usize::from(has(b"SELECT entry_id FROM text_bindings WHERE realm_id="));
            reads[1] += usize::from(has(b"FROM entries NOT INDEXED"));
            reads[2] += usize::from(has(b"SELECT update_id FROM family_file_records WHERE realm_id=")
                || has(b"SELECT update_id FROM family_text_activities WHERE realm_id="));
            value.set(reads);
        });
    }
    0
}
unsafe extern "C" fn attach(db: *mut ffi::sqlite3, _: *mut *mut c_char, _: *const ffi::sqlite3_api_routines) -> c_int {
    if ATTACH.with(Cell::get) {
        unsafe { ffi::sqlite3_trace_v2(db, ffi::SQLITE_TRACE_STMT, Some(trace), std::ptr::null_mut()); }
    }
    ffi::SQLITE_OK
}
fn traced_open<T>(open: impl FnOnce() -> T) -> T {
    ATTACH.with(|value| value.set(true));
    assert_eq!(unsafe { ffi::sqlite3_auto_extension(Some(attach)) }, ffi::SQLITE_OK);
    let value = open();
    ATTACH.with(|value| value.set(false));
    unsafe { ffi::sqlite3_cancel_auto_extension(Some(attach)); }
    value
}
fn observed_edit(notes: usize) -> [usize; 3] {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault.family_enroll(&FamilyScope {
        realm_id: RealmId::new("external-indexed-realm").unwrap(),
        vault_id: VaultId::new("external-indexed-vault").unwrap(),
    }).unwrap();
    drop(vault);
    // Queue logical creates together, then project once. Repeated full Native
    // recovery after each setup create is outside this import regression.
    let mut store = zorid_store::Store::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    for index in 0..notes {
        store.family_apply(&MutationRequest {
            operation_id: OperationId::new(format!("create-{index}")).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(format!("note-{index}")).unwrap(),
                path: VaultPath::new(format!("Note {index:04}.md")).unwrap(),
                kind: EntryKind::File,
                content: Some(b"base\r\n".to_vec()),
            },
        }, Some(FamilyCreateMode::Text)).unwrap();
    }
    drop(store);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    assert!(vault.recover().unwrap().blocked.is_empty());
    let target = EntryId::new(format!("note-{}", notes - 1)).unwrap();
    let path = VaultPath::new(format!("Note {:04}.md", notes - 1)).unwrap();
    let before = vault.list().unwrap();
    let authored = vault.family_status().unwrap().pending_authored.parse::<usize>().unwrap();
    std::fs::write(root.path().join(path.as_str()), b"base\r\nexternal\r\n").unwrap();
    // Retain a real Native observation without accepting its logical mutation.
    // The same trigger-failure boundary is exercised by the atomicity controls.
    let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    sql.execute_batch("CREATE TRIGGER fixture_hold_external BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'fixture external import hold'); END;").unwrap();
    let held = vault.reconcile(&[path.clone()]).unwrap();
    assert!(held.imported.is_empty());
    assert!(held.blocked.iter().any(|(_, reason)| reason.contains("fixture external import hold")), "{held:?}");
    assert_eq!(vault.list().unwrap(), before);
    let observation: String = sql.query_row(
        "SELECT observation_id FROM external_observations WHERE json_extract(record,'$.path')=?1 AND json_extract(record,'$.resolution') IS NULL",
        [path.as_str()], |row| row.get(0),
    ).unwrap();
    sql.execute_batch("DROP TRIGGER fixture_hold_external").unwrap();
    drop(sql);
    drop(vault);
    let mut store = traced_open(|| zorid_store::Store::open(root.path().join(".zorid/vault.sqlite")).unwrap());
    READS.with(|value| value.set([0; 3]));
    MEASURE.with(|value| value.set(true));
    let result = store.import_family_observation(&OperationId::new(observation).unwrap());
    MEASURE.with(|value| value.set(false));
    let reads = READS.with(Cell::get);
    let receipt = result.unwrap();
    assert_eq!(receipt.changes.len(), 1);
    assert_eq!(store.import_family_observation(&receipt.operation_id).unwrap(), receipt);
    drop(store);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    assert!(vault.reconcile(&[path.clone()]).unwrap().blocked.is_empty());
    let after = vault.list().unwrap();
    for old in &before {
        let new = after.iter().find(|entry| entry.id == old.id).unwrap();
        if old.id == target {
            assert_eq!(new.id, old.id);
            assert_eq!(new.path, old.path);
            assert_ne!(new.revision, old.revision);
        } else { assert_eq!(new, old); }
    }
    assert_eq!(std::fs::read(root.path().join(path.as_str())).unwrap(), b"base\r\nexternal\r\n");
    assert_eq!(vault.read(&target).unwrap().unwrap().content.unwrap(), b"base\r\nexternal\r\n");
    assert_eq!(vault.family_status().unwrap().pending_authored.parse::<usize>().unwrap(), authored + 1);
    drop(vault);
    let mut store = zorid_store::Store::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    assert_eq!(store.import_family_observation(&receipt.operation_id).unwrap(), receipt);
    drop(store);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    assert!(vault.reconcile(&[path]).unwrap().imported.is_empty());
    assert_eq!(vault.family_status().unwrap().pending_authored.parse::<usize>().unwrap(), authored + 1);
    assert_eq!(vault.read(&target).unwrap().unwrap().content.unwrap(), b"base\r\nexternal\r\n");
    reads
}

#[test]
fn one_external_text_edit_does_not_reload_the_vault() {
    let _serial = REGISTRATION.lock().unwrap();
    let small = observed_edit(16);
    let large = observed_edit(1_000);
    eprintln!("whole-corpus reads [retained Text, entries, graph]: 16={small:?}, 1000={large:?}");
    assert_eq!(small, [0; 3], "even a small external edit must use selected sources");
    assert_eq!(large, [0; 3], "an external edit must not restore unrelated notes");
}
