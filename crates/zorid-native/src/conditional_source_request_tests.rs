use super::*;
use std::os::unix::fs::PermissionsExt;

const CLIENT: &str = "10000000-0000-4000-8000-000000000001";
fn id() -> OperationId {
    OperationId::new(uuid::Uuid::new_v4().to_string()).unwrap()
}

// Tests-only old seam for a controlled semantic RED: the current Native API
// cannot receive the caller's ID. Product changes this one adapter to the new
// request type after recording that retries create duplicate durable guards.
fn capture(
    vault: &mut NativeVault,
    lease: &ClientLease,
    _id: &OperationId,
    witness: &ConditionalSavedSourceWitness,
) -> Result<ConditionalSavedSourceCapture> {
    vault.capture_conditional_saved_source(lease, witness)
}
fn fixture() -> (
    tempfile::TempDir,
    NativeVault,
    ClientLease,
    ConditionalSavedSourceWitness,
) {
    let root = tempfile::tempdir().unwrap();
    let (vault, lease, witness) = super::super::conditional_source_tests::fixture(root.path());
    (root, vault, lease, witness)
}

#[test]
fn lost_initial_capture_reply_reuses_original_identity_and_quota_after_restart() {
    let (root, mut vault, lease, witness) = fixture();
    let request_id = id();
    let first = capture(&mut vault, &lease, &request_id, &witness).unwrap();
    let original_guard = vault
        .store
        .host_source_capture(&first.capture_id)
        .unwrap()
        .unwrap();
    drop(lease);
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let lease = vault
        .claim_client(&OperationId::new(CLIENT).unwrap())
        .unwrap();
    let retried = capture(&mut vault, &lease, &request_id, &witness).unwrap();
    assert_eq!(
        retried.capture_id, first.capture_id,
        "lost reply must not create another durable guard"
    );
    assert_eq!(retried.capture_id, request_id);
    assert_eq!(retried.source, first.source);
    assert_eq!(
        vault.store.host_source_capture_usage().unwrap(),
        (1, first.source.len() as u64)
    );
    let retained = vault
        .store
        .host_source_capture(&retried.capture_id)
        .unwrap()
        .unwrap();
    assert_eq!(retained.guard, original_guard.guard);
    assert_eq!(retained.lease_token, original_guard.lease_token);
}

#[test]
fn lost_initial_changed_reply_cannot_recapture_after_original_inode_returns() {
    let (root, mut vault, lease, witness) = fixture();
    let request_id = id();
    std::fs::rename(root.path().join("A.md"), root.path().join("Original.md")).unwrap();
    std::fs::write(root.path().join("A.md"), b"replacement").unwrap();
    assert!(matches!(
        capture(&mut vault, &lease, &request_id, &witness),
        Err(Error::ConditionalSource(ConditionalSourceError::Changed))
    ));
    std::fs::remove_file(root.path().join("A.md")).unwrap();
    std::fs::rename(root.path().join("Original.md"), root.path().join("A.md")).unwrap();
    assert!(
        matches!(
            capture(&mut vault, &lease, &request_id, &witness),
            Err(Error::ConditionalSource(ConditionalSourceError::Changed))
        ),
        "lost definitive negative reply remains terminal"
    );
    assert_eq!(vault.store.host_source_capture_usage().unwrap(), (0, 0));
}

#[test]
fn unknown_id_cancellation_fences_late_capture_dispatch() {
    let (_root, mut vault, lease, witness) = fixture();
    let request_id = id();
    vault
        .release_conditional_saved_source(&lease, &request_id)
        .unwrap();
    assert!(
        capture(&mut vault, &lease, &request_id, &witness).is_err(),
        "cancellation must fence a command that had not reached Native yet"
    );
    assert_eq!(vault.store.host_source_capture_usage().unwrap(), (0, 0));
}

#[test]
fn pending_request_unknown_io_preserves_original_guard_for_exact_retry() {
    let (root, mut vault, lease, witness) = fixture();
    let request_id = id();
    let first = capture(&mut vault, &lease, &request_id, &witness).unwrap();
    let path = root.path().join("A.md");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
    let failed = capture(&mut vault, &lease, &request_id, &witness);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        matches!(failed,Err(Error::Io(ref error)) if error.kind()==std::io::ErrorKind::PermissionDenied)
    );
    assert_eq!(vault.store.host_source_capture_usage().unwrap().0, 1);
    let retried = capture(&mut vault, &lease, &request_id, &witness).unwrap();
    assert_eq!(retried.capture_id, first.capture_id);
    assert_eq!(retried.source, first.source);
}
