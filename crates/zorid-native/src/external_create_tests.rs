use super::external_create::{select_external_file_mode, ExternalFileMode};
use super::*;
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_store::{FamilyCreateMode, FamilyScope};
use zorid_sync_protocol::{ExpectedContext, RealmId, VaultId};
fn enrolled(root: &std::path::Path) -> NativeVault {
    let mut vault = NativeVault::open(root).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("create-realm").unwrap(),
            vault_id: VaultId::new("create-vault").unwrap(),
        })
        .unwrap();
    vault
}
fn import_file(vault: &mut NativeVault, path: &str, mode: FamilyCreateMode) -> CommitResult {
    let path = VaultPath::new(path).unwrap();
    let (parent, name) = vault.paths.parent(&path).unwrap();
    let disk = fs::snapshot(&parent, &name, vault.options.max_file_bytes)
        .unwrap()
        .unwrap();
    vault
        .observe_new_family_file(&path, &parent, &disk, mode)
        .unwrap()
}
#[test]
fn external_create_folder_and_exact_text_binary_publish_and_sync() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let mut target = enrolled(peer.path());
    std::fs::create_dir(root.path().join("outside")).unwrap();
    let path = VaultPath::new("outside").unwrap();
    let (parent, name) = vault.paths.parent(&path).unwrap();
    let folder = fs::optional_directory(&parent, &name).unwrap().unwrap();
    vault
        .observe_new_family_directory(
            &path,
            &parent,
            &PhysicalIdentity {
                inode: fs::identity(&folder).unwrap(),
                parent_inode: fs::identity(&parent).unwrap(),
            },
        )
        .unwrap();
    let text = b"\xef\xbb\xbfhello\r\n";
    let binary = [0, 255, 128, 1];
    for (path, bytes, mode) in [
        (
            "outside/note.custom",
            text.as_slice(),
            FamilyCreateMode::Text,
        ),
        (
            "outside/data.bin",
            binary.as_slice(),
            FamilyCreateMode::Binary,
        ),
    ] {
        std::fs::write(root.path().join(path), bytes).unwrap();
        let receipt = import_file(&mut vault, path, mode);
        let entry = receipt
            .changes
            .iter()
            .find(|c| c.after.path.as_str() == path)
            .unwrap()
            .after
            .clone();
        assert_eq!(
            vault
                .store
                .projection_baseline(&entry.id)
                .unwrap()
                .unwrap()
                .content,
            bytes
        );
        assert_eq!(
            vault
                .store
                .physical_binding(&entry.id)
                .unwrap()
                .unwrap()
                .state,
            entry
        );
    }
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
    let key = VaultKey::from_bytes([61; 32]);
    for update in vault.family_pending_authored(None, 1000).unwrap() {
        let context = ExpectedContext {
            realm_id: update.scope.realm_id,
            vault_id: update.scope.vault_id,
            update_id: update.update_id,
            key_epoch: 1,
        };
        let wire = vault.family_seal(&context, &key).unwrap();
        let opened = OpenedEnvelope::open(&wire, &context, &key).unwrap();
        target.family_receive(&opened, None).unwrap();
    }
    assert_eq!(
        std::fs::read(peer.path().join("outside/note.custom")).unwrap(),
        text
    );
    assert_eq!(
        std::fs::read(peer.path().join("outside/data.bin")).unwrap(),
        binary
    );
}
#[test]
fn external_create_prepared_restart_keeps_identity_and_rejects_mode_change() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("same.custom"), b"text but chosen binary").unwrap();
    vault.fault = Some(|point| {
        if point == "external_create_prepared" {
            panic!("prepared interruption")
        }
    });
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| import_file(
            &mut vault,
            "same.custom",
            FamilyCreateMode::Binary
        )))
        .is_err()
    );
    let observation = vault.store.external_observations().unwrap().pop().unwrap();
    let command = vault
        .store
        .prepare_family_external_create(
            &observation.observation_id,
            EntryKind::File,
            Some(FamilyCreateMode::Binary),
        )
        .unwrap();
    assert!(vault.store.list().unwrap().is_empty());
    drop(vault);
    let mut vault = NativeVault::open(root.path()).unwrap();
    assert!(vault
        .store
        .prepare_family_external_create(
            &observation.observation_id,
            EntryKind::File,
            Some(FamilyCreateMode::Text)
        )
        .is_err());
    let receipt = import_file(&mut vault, "same.custom", FamilyCreateMode::Binary);
    assert_eq!(receipt.operation_id, command.request.operation_id);
    assert_eq!(receipt.changes[0].after.id, *command.request.mutation.id());
    let pending = vault.family_pending_authored(None, 1000).unwrap().len();
    assert_eq!(
        vault
            .store
            .import_family_external_create(&observation.observation_id)
            .unwrap(),
        receipt
    );
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        pending
    );
}
#[test]
fn external_create_auto_mode_inspects_utf8_nul_and_binary_extension_without_rewriting() {
    let custom = VaultPath::new("unknown.custom").unwrap();
    assert_eq!(
        select_external_file_mode(&custom, b"\xef\xbb\xbfBOM\r\n", ExternalFileMode::Auto).unwrap(),
        FamilyCreateMode::Text
    );
    for bytes in [b"hello\0".as_slice(), [255, 128].as_slice()] {
        assert_eq!(
            select_external_file_mode(&custom, bytes, ExternalFileMode::Auto).unwrap(),
            FamilyCreateMode::Binary
        );
    }
    assert_eq!(
        select_external_file_mode(
            &VaultPath::new("PHOTO.PNG").unwrap(),
            b"ascii",
            ExternalFileMode::Auto
        )
        .unwrap(),
        FamilyCreateMode::Binary
    );
    assert_eq!(
        select_external_file_mode(
            &VaultPath::new("data.bin").unwrap(),
            b"ascii",
            ExternalFileMode::Text
        )
        .unwrap(),
        FamilyCreateMode::Text
    );
    assert!(select_external_file_mode(&custom, &[255], ExternalFileMode::Text).is_err());
}

#[test]
fn external_create_rejects_renamed_bound_inode_as_a_new_identity() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::write(root.path().join("original.custom"), b"retained identity").unwrap();
    let receipt = import_file(&mut vault, "original.custom", FamilyCreateMode::Text);
    let original = receipt.changes[0].after.id.clone();
    let before_receipts = vault.store.operations_after(0, 1000).unwrap().len();
    let before_outbox = vault.family_pending_authored(None, 1000).unwrap().len();
    std::fs::rename(
        root.path().join("original.custom"),
        root.path().join("renamed.custom"),
    )
    .unwrap();
    let path = VaultPath::new("renamed.custom").unwrap();
    let (parent, name) = vault.paths.parent(&path).unwrap();
    let disk = fs::snapshot(&parent, &name, vault.options.max_file_bytes)
        .unwrap()
        .unwrap();
    assert!(vault
        .observe_new_family_file(&path, &parent, &disk, FamilyCreateMode::Text)
        .is_err());
    assert_eq!(vault.store.list().unwrap().len(), 1);
    assert_eq!(vault.store.list().unwrap()[0].id, original);
    assert_eq!(
        vault.store.operations_after(0, 1000).unwrap().len(),
        before_receipts
    );
    assert_eq!(
        vault.family_pending_authored(None, 1000).unwrap().len(),
        before_outbox
    );
    assert_eq!(
        std::fs::read(root.path().join("renamed.custom")).unwrap(),
        b"retained identity"
    );
}
