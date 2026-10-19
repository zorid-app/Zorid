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
        let baseline = vault.store.projection_baseline(&entry.id).unwrap().unwrap();
        assert_eq!(
            vault
                .test_content_bytes(Some(&baseline.state), &baseline.content)
                .unwrap(),
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
    let client = content_stream::core_client().unwrap();
    let intent = vault
        .store
        .prepare_family_external_create_content(
            &client,
            &observation.observation_id,
            EntryKind::File,
            Some(FamilyCreateMode::Binary),
        )
        .unwrap();
    let zorid_store::ExternalCreateIntent::BinaryCapture {
        observation_id: prepared_operation,
        entry_id: prepared_entry,
        path: prepared_path,
        capture,
    } = intent
    else {
        panic!("explicit Binary create must retain its original capture intent")
    };
    assert_eq!(prepared_operation, observation.observation_id);
    assert_eq!(prepared_path, VaultPath::new("same.custom").unwrap());
    assert_eq!(capture.stage.operation_id, prepared_operation);
    assert!(vault.store.list().unwrap().is_empty());
    drop(vault);
    let mut vault = NativeVault::open(root.path()).unwrap();
    assert!(vault
        .store
        .prepare_family_external_create_content(
            &client,
            &observation.observation_id,
            EntryKind::File,
            Some(FamilyCreateMode::Text)
        )
        .is_err());
    let receipt = import_file(&mut vault, "same.custom", FamilyCreateMode::Binary);
    assert_eq!(receipt.operation_id, prepared_operation);
    assert_eq!(receipt.changes[0].after.id, prepared_entry);
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

#[test]
fn external_create_occupied_path_guard_does_not_decode_unrelated_metadata() {
    for kind in [EntryKind::File, EntryKind::Folder] {
        let root = tempfile::tempdir().unwrap();
        let mut vault = enrolled(root.path());
        for (id, name, entry_kind) in [
            ("selected", "Selected", kind),
            ("unrelated", "unrelated.md", EntryKind::File),
        ] {
            // A committed logical entry can precede physical publication. It
            // still prevents adopting an independently created occupant.
            vault
                .store
                .family_apply(
                    &MutationRequest {
                        operation_id: OperationId::new(format!("create-{id}")).unwrap(),
                        mutation: Mutation::Create {
                            id: EntryId::new(id).unwrap(),
                            path: VaultPath::new(name).unwrap(),
                            kind: entry_kind,
                            content: (entry_kind == EntryKind::File).then(|| b"committed".to_vec()),
                        },
                    },
                    (entry_kind == EntryKind::File).then_some(FamilyCreateMode::Text),
                )
                .unwrap();
        }
        let path = VaultPath::new("Selected").unwrap();
        if kind == EntryKind::File {
            std::fs::write(root.path().join("Selected"), b"independent occupant").unwrap();
        } else {
            std::fs::create_dir(root.path().join("Selected")).unwrap();
        }
        let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
        assert_eq!(
            sql.execute(
                "UPDATE entries SET state=json_set(state,'$.unexpected',1) WHERE id='unrelated'",
                []
            )
            .unwrap(),
            1
        );
        assert!(vault.store.list().is_err()); // Old whole-catalogue guard fails here.
        assert!(vault.store.physical_owner_at(&path).unwrap().is_none());
        let entries: String = sql.query_row("SELECT json_group_array(json_array(id,state,visible,deleted)) FROM entries ORDER BY id", [], |row| row.get(0)).unwrap();
        let operations: i64 = sql
            .query_row("SELECT count(*) FROM operations", [], |row| row.get(0))
            .unwrap();
        let (parent, name) = vault.paths.parent(&path).unwrap();
        let error = if kind == EntryKind::File {
            let disk = fs::snapshot(&parent, &name, vault.options.max_file_bytes)
                .unwrap()
                .unwrap();
            vault
                .observe_new_family_file(&path, &parent, &disk, FamilyCreateMode::Text)
                .unwrap_err()
        } else {
            let directory = fs::optional_directory(&parent, &name).unwrap().unwrap();
            vault
                .observe_new_family_directory(
                    &path,
                    &parent,
                    &PhysicalIdentity {
                        inode: fs::identity(&directory).unwrap(),
                        parent_inode: fs::identity(&parent).unwrap(),
                    },
                )
                .unwrap_err()
        };
        assert!(
            matches!(
                error,
                Error::Busy(
                    "new external file path already has an owner"
                        | "new external directory path already has an owner"
                )
            ),
            "{error}"
        );
        assert_eq!(sql.query_row("SELECT json_group_array(json_array(id,state,visible,deleted)) FROM entries ORDER BY id", [], |row| row.get::<_, String>(0)).unwrap(), entries);
        assert_eq!(
            sql.query_row("SELECT count(*) FROM operations", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            operations
        );
        if kind == EntryKind::File {
            assert_eq!(
                std::fs::read(root.path().join("Selected")).unwrap(),
                b"independent occupant"
            );
        } else {
            assert!(root.path().join("Selected").is_dir());
        }
    }
}

#[test]
fn external_create_selected_path_metadata_corruption_remains_fatal() {
    for kind in [EntryKind::File, EntryKind::Folder] {
        let root = tempfile::tempdir().unwrap();
        let mut vault = enrolled(root.path());
        vault
            .store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("create-selected").unwrap(),
                    mutation: Mutation::Create {
                        id: EntryId::new("selected").unwrap(),
                        path: VaultPath::new("Selected").unwrap(),
                        kind,
                        content: (kind == EntryKind::File).then(|| b"committed".to_vec()),
                    },
                },
                (kind == EntryKind::File).then_some(FamilyCreateMode::Text),
            )
            .unwrap();
        if kind == EntryKind::File {
            std::fs::write(root.path().join("Selected"), b"independent").unwrap();
        } else {
            std::fs::create_dir(root.path().join("Selected")).unwrap();
        }
        let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
        assert_eq!(
            sql.execute(
                "UPDATE entries SET state=json_set(state,'$.unexpected',1) WHERE id='selected'",
                []
            )
            .unwrap(),
            1
        );
        let before: String = sql
            .query_row("SELECT state FROM entries WHERE id='selected'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let path = VaultPath::new("Selected").unwrap();
        let (parent, name) = vault.paths.parent(&path).unwrap();
        let error = if kind == EntryKind::File {
            let disk = fs::snapshot(&parent, &name, vault.options.max_file_bytes)
                .unwrap()
                .unwrap();
            vault
                .observe_new_family_file(&path, &parent, &disk, FamilyCreateMode::Text)
                .unwrap_err()
        } else {
            let directory = fs::optional_directory(&parent, &name).unwrap().unwrap();
            vault
                .observe_new_family_directory(
                    &path,
                    &parent,
                    &PhysicalIdentity {
                        inode: fs::identity(&directory).unwrap(),
                        parent_inode: fs::identity(&parent).unwrap(),
                    },
                )
                .unwrap_err()
        };
        assert!(matches!(error, Error::Store(_)), "{error}");
        assert_eq!(
            sql.query_row("SELECT state FROM entries WHERE id='selected'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            before
        );
    }
}

#[test]
fn external_create_inode_guard_is_targeted_but_selected_corruption_is_fatal() {
    for kind in [EntryKind::File, EntryKind::Folder] {
        for corrupt_selected in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let mut vault = enrolled(root.path());
            let original = VaultPath::new("original.custom").unwrap();
            if kind == EntryKind::File {
                std::fs::write(root.path().join(original.as_str()), b"retained inode").unwrap();
                import_file(&mut vault, original.as_str(), FamilyCreateMode::Text);
            } else {
                std::fs::create_dir(root.path().join(original.as_str())).unwrap();
                let (parent, name) = vault.paths.parent(&original).unwrap();
                let directory = fs::optional_directory(&parent, &name).unwrap().unwrap();
                vault
                    .observe_new_family_directory(
                        &original,
                        &parent,
                        &PhysicalIdentity {
                            inode: fs::identity(&directory).unwrap(),
                            parent_inode: fs::identity(&parent).unwrap(),
                        },
                    )
                    .unwrap();
            }
            std::fs::write(
                root.path().join("unrelated.md"),
                b"unrelated retained bytes",
            )
            .unwrap();
            import_file(&mut vault, "unrelated.md", FamilyCreateMode::Text);
            std::fs::rename(
                root.path().join(original.as_str()),
                root.path().join("renamed.custom"),
            )
            .unwrap();
            let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
            if corrupt_selected {
                assert_eq!(sql.execute("UPDATE physical_bindings SET record=json_set(record,'$.physical.inode','column-mismatch') WHERE path='original.custom'", []).unwrap(), 1);
            } else {
                assert_eq!(sql.execute("UPDATE projection_baselines SET record='invalid-json' WHERE entry_id=(SELECT entry_id FROM physical_bindings WHERE path='unrelated.md')", []).unwrap(), 1);
            }
            // The previous full binding guard reads the unrelated saved body.
            assert!(vault.store.physical_bindings().is_err());
            let before: String = sql.query_row("SELECT json_group_array(json_array(entry_id,path,revision,kind,inode,parent_inode,record)) FROM physical_bindings ORDER BY entry_id", [], |r| r.get(0)).unwrap();
            let before_receipts = vault.store.operations_after(0, 1000).unwrap().len();
            let before_outbox = vault.family_pending_authored(None, 1000).unwrap().len();
            let path = VaultPath::new("renamed.custom").unwrap();
            let (parent, name) = vault.paths.parent(&path).unwrap();
            let error = if kind == EntryKind::File {
                let disk = fs::snapshot(&parent, &name, vault.options.max_file_bytes)
                    .unwrap()
                    .unwrap();
                vault
                    .observe_new_family_file(&path, &parent, &disk, FamilyCreateMode::Text)
                    .unwrap_err()
            } else {
                let directory = fs::optional_directory(&parent, &name).unwrap().unwrap();
                vault
                    .observe_new_family_directory(
                        &path,
                        &parent,
                        &PhysicalIdentity {
                            inode: fs::identity(&directory).unwrap(),
                            parent_inode: fs::identity(&parent).unwrap(),
                        },
                    )
                    .unwrap_err()
            };
            if corrupt_selected {
                assert!(matches!(error, Error::Store(_)), "{error}");
            } else {
                assert!(
                    matches!(
                        error,
                        Error::Busy(
                            "new external file path already has an owner"
                                | "new external directory path already has an owner"
                        )
                    ),
                    "{error}"
                );
            }
            assert_eq!(sql.query_row("SELECT json_group_array(json_array(entry_id,path,revision,kind,inode,parent_inode,record)) FROM physical_bindings ORDER BY entry_id", [], |r| r.get::<_, String>(0)).unwrap(), before);
            assert_eq!(
                vault.store.operations_after(0, 1000).unwrap().len(),
                before_receipts
            );
            assert_eq!(
                vault.family_pending_authored(None, 1000).unwrap().len(),
                before_outbox
            );
            assert!(!root.path().join(original.as_str()).exists());
            if kind == EntryKind::File {
                assert_eq!(
                    std::fs::read(root.path().join("renamed.custom")).unwrap(),
                    b"retained inode"
                );
            } else {
                assert!(root.path().join("renamed.custom").is_dir());
            }
            assert_eq!(
                std::fs::read(root.path().join("unrelated.md")).unwrap(),
                b"unrelated retained bytes"
            );
        }
    }
}
