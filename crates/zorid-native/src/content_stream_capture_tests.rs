use super::*;

#[test]
fn inert_private_capture_keeps_exact_bytes_without_public_path_authority() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    std::fs::write(
        root.path().join(".zorid/retained.blob"),
        b"private recovery bytes",
    )
    .unwrap();
    let parent = vault.paths.private.try_clone().unwrap();
    let snapshot = file_snapshot(&parent, "retained.blob").unwrap().unwrap();
    let content = vault
        .capture_observed_file(
            &VaultPath::new("original.blob").unwrap(),
            &parent,
            "retained.blob",
            &OperationId::new("private-capture-fixture").unwrap(),
            None,
            None,
            &snapshot,
            true,
        )
        .unwrap();
    assert_eq!(
        content.inline_bytes(),
        Some(b"private recovery bytes".as_slice())
    );
    assert!(vault.store.list().unwrap().is_empty());
    assert!(vault.store.physical_bindings().unwrap().is_empty());
}

#[test]
fn public_observation_rejects_private_parent_and_capture_rejects_snapshot_substitution() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    std::fs::write(root.path().join("note.blob"), b"same bytes").unwrap();
    std::fs::write(root.path().join(".zorid/note.blob"), b"same bytes").unwrap();
    let path = VaultPath::new("note.blob").unwrap();
    let public = vault.paths.root.try_clone().unwrap();
    let private = vault.paths.private.try_clone().unwrap();
    let public_snapshot = file_snapshot(&public, "note.blob").unwrap().unwrap();
    let private_snapshot = file_snapshot(&private, "note.blob").unwrap().unwrap();
    let origin = OperationId::new("wrong-parent-fixture").unwrap();
    // Matching private bytes/inode facts cannot grant public write authority.
    assert!(matches!(
        vault.observe_streamed_file(&path, &private, &private_snapshot, &origin),
        Err(Error::Busy(_))
    ));
    // Nor can an inert capture replace its caller's actual original snapshot.
    assert!(matches!(
        vault.capture_observed_file(
            &path,
            &private,
            "note.blob",
            &origin,
            None,
            None,
            &public_snapshot,
            true
        ),
        Err(Error::Busy(_))
    ));
    assert_eq!(
        std::fs::read(root.path().join("note.blob")).unwrap(),
        b"same bytes"
    );
    assert!(vault.store.list().unwrap().is_empty());
    assert!(vault.store.physical_bindings().unwrap().is_empty());
}
