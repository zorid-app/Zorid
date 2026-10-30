use super::*;
use std::os::unix::fs::PermissionsExt;

const CLIENT: &str = "10000000-0000-4000-8000-000000000001";
fn id() -> OperationId {
    OperationId::new(uuid::Uuid::new_v4().to_string()).unwrap()
}

// Tests-only5a5f813c used the old ID-less Native API for the controlled RED.
fn capture(
    vault: &mut NativeVault,
    lease: &ClientLease,
    id: &OperationId,
    witness: &ConditionalSavedSourceWitness,
) -> Result<ConditionalSavedSourceCapture> {
    vault.capture_conditional_saved_source(
        lease,
        &ConditionalSavedSourceRequest {
            capture_id: id.clone(),
            logical_witness: witness.clone(),
        },
    )
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
fn changed_pending_replay_closes_original_guard_without_authoring_an_intent() {
    let (root, mut vault, lease, witness) = fixture();
    let request_id = id();
    let first = capture(&mut vault, &lease, &request_id, &witness).unwrap();
    let path = root.path().join("A.md");
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let mut changed = first.source.clone();
    changed[0] = b'x';
    std::fs::write(&path, &changed).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert!(matches!(
        capture(&mut vault, &lease, &request_id, &witness),
        Err(Error::ConditionalSource(ConditionalSourceError::Changed))
    ));
    assert_eq!(vault.store.host_source_capture_usage().unwrap(), (0, 0));
    std::fs::write(&path, &first.source).unwrap();
    drop(lease);
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let lease = vault
        .claim_client(&OperationId::new(CLIENT).unwrap())
        .unwrap();
    assert!(matches!(
        capture(&mut vault, &lease, &request_id, &witness),
        Err(Error::ConditionalSource(ConditionalSourceError::Changed))
    ));
    let write = MutationRequest {
        operation_id: id(),
        mutation: Mutation::Write {
            id: witness.entry_id.clone(),
            expected: witness.revision.clone(),
            content: changed,
        },
    };
    assert!(matches!(
        vault.prepare_guarded_host_intent(&lease, &write, &request_id),
        Err(Error::ConditionalSource(ConditionalSourceError::Changed))
    ));
    assert!(vault
        .store
        .host_intent_for_operation(&write.operation_id)
        .unwrap()
        .is_none());
    assert_eq!(std::fs::read(&path).unwrap(), first.source);
}

#[test]
fn unknown_id_cancellation_fences_late_capture_dispatch() {
    let (_root, mut vault, lease, witness) = fixture();
    let request_id = id();
    vault
        .release_conditional_saved_source(&lease, &request_id)
        .unwrap();
    assert!(
        matches!(
            capture(&mut vault, &lease, &request_id, &witness),
            Err(Error::ConditionalSource(ConditionalSourceError::Closed))
        ),
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

#[test]
fn exact_pending_replay_precedes_shared_capacity_and_capacity_is_not_terminal() {
    let (_root, mut vault, lease, witness) = fixture();
    let first_id = id();
    let first = capture(&mut vault, &lease, &first_id, &witness).unwrap();
    let mut ids = vec![first_id.clone()];
    for _ in 1..MAX_CONDITIONAL_SOURCE_CAPTURES {
        let next = id();
        capture(&mut vault, &lease, &next, &witness).unwrap();
        ids.push(next);
    }
    assert_eq!(
        capture(&mut vault, &lease, &first_id, &witness)
            .unwrap()
            .source,
        first.source
    );
    let pending = vault
        .list_conditional_saved_source_requests(&lease)
        .unwrap();
    assert_eq!(pending.len(), 8);
    assert!(pending
        .iter()
        .all(|row| !row.legacy && row.logical_witness == witness));
    let blocked = id();
    assert!(matches!(
        capture(&mut vault, &lease, &blocked, &witness),
        Err(Error::ConditionalSource(ConditionalSourceError::Capacity))
    ));
    vault
        .release_conditional_saved_source(&lease, &ids[1])
        .unwrap();
    assert_eq!(
        capture(&mut vault, &lease, &blocked, &witness)
            .unwrap()
            .capture_id,
        blocked
    );
}

#[test]
fn individually_oversized_capture_is_limit_not_shared_capacity() {
    let (_root, mut vault, lease, witness) = fixture();
    vault.options.max_file_bytes = 1;
    assert!(matches!(
        capture(&mut vault, &lease, &id(), &witness),
        Err(Error::ConditionalSource(ConditionalSourceError::Limit))
    ));
    assert!(vault
        .list_conditional_saved_source_requests(&lease)
        .unwrap()
        .is_empty());
}

#[test]
fn owned_pending_list_and_capture_identity_reject_foreign_or_mismatched_witness() {
    let (_root, mut vault, lease, witness) = fixture();
    let request_id = id();
    capture(&mut vault, &lease, &request_id, &witness).unwrap();
    let mut wrong = witness.clone();
    wrong.path = VaultPath::new("Other.md").unwrap();
    assert!(capture(&mut vault, &lease, &request_id, &wrong).is_err());
    let other = vault
        .claim_client(&OperationId::new("10000000-0000-4000-8000-000000000002").unwrap())
        .unwrap();
    assert!(capture(&mut vault, &other, &request_id, &witness).is_err());
    assert!(vault
        .list_conditional_saved_source_requests(&other)
        .unwrap()
        .is_empty());
    vault
        .release_conditional_saved_source(&other, &request_id)
        .unwrap();
    assert_eq!(
        vault
            .list_conditional_saved_source_requests(&lease)
            .unwrap()
            .len(),
        1
    );
}
