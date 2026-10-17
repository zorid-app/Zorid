use super::*;
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_store::{FamilyCreateMode, FamilyScope};
use zorid_sync_protocol::{ExpectedContext, RealmId, VaultId};

fn id() -> EntryId {
    EntryId::new("external-note").unwrap()
}
fn path() -> VaultPath {
    VaultPath::new("note.custom").unwrap()
}
fn enrolled(root: &std::path::Path) -> NativeVault {
    let mut vault = NativeVault::open(root).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("external-realm").unwrap(),
            vault_id: VaultId::new("external-vault").unwrap(),
        })
        .unwrap();
    vault
}
fn create(vault: &mut NativeVault, mode: FamilyCreateMode, bytes: &[u8]) {
    let result = vault
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("create").unwrap(),
                mutation: Mutation::Create {
                    id: id(),
                    path: path(),
                    kind: EntryKind::File,
                    content: Some(bytes.to_vec()),
                },
            },
            Some(mode),
        )
        .unwrap();
    assert!(
        matches!(result.projection, ProjectionStatus::Projected),
        "{result:?}"
    );
}
fn write(vault: &mut NativeVault, operation: &str, bytes: &[u8]) {
    let revision = vault.read(&id()).unwrap().unwrap().state.revision;
    vault
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new(operation).unwrap(),
                mutation: Mutation::Write {
                    id: id(),
                    expected: revision,
                    content: bytes.to_vec(),
                },
            },
            None,
        )
        .unwrap();
}
fn send(source: &mut NativeVault, target: &mut NativeVault) {
    let key = VaultKey::from_bytes([37; 32]);
    for update in source.family_pending_authored(None, 1000).unwrap() {
        let context = ExpectedContext {
            realm_id: update.scope.realm_id,
            vault_id: update.scope.vault_id,
            update_id: update.update_id,
            key_epoch: 1,
        };
        let wire = source.family_seal(&context, &key).unwrap();
        let opened = OpenedEnvelope::open(&wire, &context, &key).unwrap();
        target.family_receive(&opened, None).unwrap();
        source
            .family_ack(
                &context.realm_id,
                &context.vault_id,
                &context.update_id,
                &wire,
            )
            .unwrap();
    }
}

#[test]
fn family_external_text_branch_merges_remote_edit_then_reopens_and_converges() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let mut left = enrolled(a.path());
    let mut right = enrolled(b.path());
    create(&mut left, FamilyCreateMode::Text, b"base");
    send(&mut left, &mut right);
    // The external writer edits the older physical branch while another replica
    // authors a concurrent change. Receive must retain, not overwrite, this file.
    std::fs::write(b.path().join("note.custom"), b"base LOCAL").unwrap();
    write(&mut left, "remote-write", b"REMOTE base");
    send(&mut left, &mut right);
    assert_eq!(
        std::fs::read(b.path().join("note.custom")).unwrap(),
        b"base LOCAL"
    );
    let report = right.reconcile(&[path()]).unwrap();
    assert_eq!(report.imported.len(), 1, "{report:?}");
    let receipt = report.imported[0].clone();
    let merged = right.read(&id()).unwrap().unwrap().content.unwrap();
    assert_eq!(merged, b"REMOTE base LOCAL");
    assert_eq!(std::fs::read(b.path().join("note.custom")).unwrap(), merged);
    assert_eq!(right.family_pending_authored(None, 100).unwrap().len(), 1);
    drop(right);
    let mut right = NativeVault::open_existing(b.path()).unwrap();
    assert_eq!(
        right
            .store
            .import_family_observation(&receipt.operation_id)
            .unwrap(),
        receipt
    );
    assert_eq!(
        right.family_pending_authored(None, 100).unwrap().len(),
        1,
        "receipt replay must not author another update"
    );
    send(&mut right, &mut left);
    assert_eq!(left.read(&id()).unwrap().unwrap().content.unwrap(), merged);
    assert_eq!(std::fs::read(a.path().join("note.custom")).unwrap(), merged);
    assert!(right.recover().unwrap().blocked.is_empty());
    assert_eq!(right.family_status().unwrap().pending_projection, "0");
}

#[test]
fn family_external_import_failure_rolls_back_causal_state_receipt_and_physical_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = enrolled(dir.path());
    create(&mut vault, FamilyCreateMode::Text, b"original");
    let before = vault.read(&id()).unwrap().unwrap();
    let baseline = vault.store.projection_baseline(&id()).unwrap();
    let binding = vault.store.physical_binding(&id()).unwrap();
    let status = vault.family_status().unwrap();
    let sql = rusqlite::Connection::open(dir.path().join(".zorid/vault.sqlite")).unwrap();
    sql.execute_batch("CREATE TRIGGER fixture_abort_observation BEFORE UPDATE OF record ON external_observations WHEN json_extract(NEW.record,'$.resolution') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture observation finalization abort'); END;").unwrap();
    std::fs::write(dir.path().join("note.custom"), b"external").unwrap();
    let report = vault.reconcile(&[path()]).unwrap();
    assert!(report.imported.is_empty());
    assert!(!report.blocked.is_empty());
    assert_eq!(vault.read(&id()).unwrap().unwrap(), before);
    assert_eq!(vault.store.projection_baseline(&id()).unwrap(), baseline);
    assert_eq!(vault.store.physical_binding(&id()).unwrap(), binding);
    assert_eq!(
        vault.family_status().unwrap().pending_authored,
        status.pending_authored
    );
    assert_eq!(
        std::fs::read(dir.path().join("note.custom")).unwrap(),
        b"external"
    );
    let operations: i64 = sql
        .query_row("SELECT count(*) FROM operations", [], |r| r.get(0))
        .unwrap();
    assert_eq!(operations, 1);
    sql.execute_batch("DROP TRIGGER fixture_abort_observation")
        .unwrap();
    let report = vault.reconcile(&[path()]).unwrap();
    assert_eq!(report.imported.len(), 1, "{report:?}");
    assert_eq!(
        vault.read(&id()).unwrap().unwrap().content.unwrap(),
        b"external"
    );
    drop(sql);
    drop(vault);
    let vault = NativeVault::open_existing(dir.path()).unwrap();
    assert_eq!(
        vault.read(&id()).unwrap().unwrap().content.unwrap(),
        b"external"
    );
}

#[test]
fn family_external_binary_edit_is_byte_exact_and_remote_divergence_is_not_overwritten() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let mut left = enrolled(a.path());
    let mut right = enrolled(b.path());
    create(&mut left, FamilyCreateMode::Binary, &[0, 255, 128]);
    send(&mut left, &mut right);
    std::fs::write(b.path().join("note.custom"), [255, 0, 13, 10, 128]).unwrap();
    let report = right.reconcile(&[path()]).unwrap();
    assert_eq!(report.imported.len(), 1, "{report:?}");
    send(&mut right, &mut left);
    assert_eq!(
        left.read(&id()).unwrap().unwrap().content.unwrap(),
        [255, 0, 13, 10, 128]
    );
    std::fs::write(b.path().join("note.custom"), [9, 8, 7]).unwrap();
    write(&mut left, "remote-binary", &[4, 3, 2]);
    send(&mut left, &mut right);
    let before = right.family_status().unwrap().pending_authored;
    let report = right.reconcile(&[path()]).unwrap();
    assert!(report.imported.is_empty());
    assert!(!report.blocked.is_empty());
    assert_eq!(
        right.read(&id()).unwrap().unwrap().content.unwrap(),
        [4, 3, 2]
    );
    assert_eq!(
        std::fs::read(b.path().join("note.custom")).unwrap(),
        [9, 8, 7]
    );
    assert_eq!(right.family_status().unwrap().pending_authored, before);
}
