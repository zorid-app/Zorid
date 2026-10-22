use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

const CLIENT: &str = "10000000-0000-4000-8000-000000000001";
const OTHER: &str = "10000000-0000-4000-8000-000000000002";
const BEFORE: &[u8] = b"---\nscore: 9\nuntouched: keep\n---\nBody\n";
const AFTER: &[u8] = b"---\nscore: 1\nuntouched: keep\n---\nBody\n";
const TOUCHED: &[u8] = b"---\nscore: 7\nuntouched: keep\n---\nBody\n";
const UNRELATED: &[u8] = b"---\nscore: 9\nuntouched: external\n---\nBody\nExternal body\n";
const MERGED: &[u8] = b"---\nscore: 1\nuntouched: external\n---\nBody\nExternal body\n";

fn fixture(root: &Path) -> (NativeVault, ClientLease, ConditionalSavedSourceWitness) {
    let mut vault = NativeVault::open(root).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: zorid_sync_protocol::RealmId::new("conditional-realm").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("conditional-vault").unwrap(),
        })
        .unwrap();
    let id = EntryId::new("conditional-note").unwrap();
    let path = VaultPath::new("A.md").unwrap();
    let result = vault
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("create-conditional").unwrap(),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: path.clone(),
                    kind: EntryKind::File,
                    content: Some(BEFORE.to_vec()),
                },
            },
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    assert!(matches!(result.projection, ProjectionStatus::Projected));
    let revision = vault.read(&id).unwrap().unwrap().state.revision;
    let lease = vault
        .claim_client(&OperationId::new(CLIENT).unwrap())
        .unwrap();
    (
        vault,
        lease,
        ConditionalSavedSourceWitness {
            entry_id: id,
            revision,
            path,
        },
    )
}
fn request(witness: &ConditionalSavedSourceWitness) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("conditional-undo").unwrap(),
        mutation: Mutation::Write {
            id: witness.entry_id.clone(),
            expected: witness.revision.clone(),
            content: AFTER.to_vec(),
        },
    }
}
fn reference(view: &HostIntentView) -> HostIntentRef {
    HostIntentRef {
        client_id: view.client_id.clone(),
        token: view.token.clone(),
    }
}

#[test]
fn conditional_capture_exposes_actual_physical_text_without_importing_or_replacing_core_base() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let cursor = vault.list_snapshot().unwrap().cursor;
    std::fs::write(dir.path().join("A.md"), TOUCHED).unwrap();
    let captured = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    assert_eq!(captured.source, TOUCHED);
    assert_eq!(captured.logical_witness, witness);
    assert_eq!(
        vault
            .read(&witness.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        BEFORE
    );
    assert_eq!(vault.list_snapshot().unwrap().cursor, cursor);
    vault
        .release_conditional_saved_source(&lease, &captured.capture_id)
        .unwrap();
    vault
        .release_conditional_saved_source(&lease, &captured.capture_id)
        .unwrap();
}

#[test]
fn conditional_capture_change_before_prepare_settles_exact_rejected_intent() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let captured = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    std::fs::write(dir.path().join("A.md"), TOUCHED).unwrap();
    let rejected = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &captured.capture_id)
        .unwrap();
    assert_eq!(rejected.state, HostIntentState::Rejected);
    assert_eq!(
        rejected.error.as_ref().unwrap().code,
        HostRejectionCode::ConditionalSourceChanged
    );
    assert!(rejected.receipt.is_none());
    assert_eq!(
        vault
            .prepare_guarded_host_intent(&lease, &request(&witness), &captured.capture_id)
            .unwrap(),
        rejected
    );
    assert_eq!(
        vault.commit_host_intent(&reference(&rejected)).unwrap(),
        rejected
    );
    assert_eq!(
        vault
            .list_host_intents(&OperationId::new(CLIENT).unwrap(), "0", 10)
            .unwrap()
            .intents
            .len(),
        1
    );
    assert_eq!(
        vault
            .read(&witness.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        BEFORE
    );
    assert_eq!(std::fs::read(dir.path().join("A.md")).unwrap(), TOUCHED);
}

#[test]
fn conditional_prepared_guard_rejects_changed_physical_source_before_authorship() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let captured = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    let prepared = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &captured.capture_id)
        .unwrap();
    std::fs::write(dir.path().join("A.md"), TOUCHED).unwrap();
    let result = vault.commit_host_intent(&reference(&prepared)).unwrap();
    assert_eq!(result.state, HostIntentState::Rejected);
    assert_eq!(
        result.error.as_ref().unwrap().code,
        HostRejectionCode::ConditionalSourceChanged
    );
    assert!(result.receipt.is_none());
    assert_eq!(
        vault.commit_host_intent(&reference(&prepared)).unwrap(),
        result
    );
    assert_eq!(
        vault
            .read(&witness.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        BEFORE
    );
    assert_eq!(std::fs::read(dir.path().join("A.md")).unwrap(), TOUCHED);
}

#[test]
fn conditional_prepared_unrelated_physical_branch_keeps_original_crdt_merge() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    std::fs::write(dir.path().join("A.md"), UNRELATED).unwrap();
    let captured = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    assert_eq!(captured.source, UNRELATED);
    let prepared = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &captured.capture_id)
        .unwrap();
    let result = vault.commit_host_intent(&reference(&prepared)).unwrap();
    assert_eq!(result.state, HostIntentState::Committed);
    assert_eq!(result.projection, Some(HostProjectionState::Pending));
    let report = vault
        .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
        .unwrap();
    assert!(report.complete, "{report:?}");
    assert!(vault.recover().unwrap().blocked.is_empty());
    assert_eq!(
        vault
            .read(&witness.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        MERGED
    );
    assert_eq!(std::fs::read(dir.path().join("A.md")).unwrap(), MERGED);
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
}

#[test]
fn conditional_prepared_guard_survives_restart_and_lost_prepare_reply() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let captured = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    let prepared = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &captured.capture_id)
        .unwrap();
    drop(lease);
    drop(vault);
    let mut vault = NativeVault::open_existing(dir.path()).unwrap();
    let lease = vault
        .claim_client(&OperationId::new(CLIENT).unwrap())
        .unwrap();
    let replayed = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &captured.capture_id)
        .unwrap();
    assert_eq!(replayed, prepared);
    let committed = vault.commit_host_intent(&reference(&prepared)).unwrap();
    assert_eq!(committed.state, HostIntentState::Committed);
    let receipt = committed.receipt.clone();
    std::fs::write(dir.path().join("A.md"), TOUCHED).unwrap();
    let replayed = vault.commit_host_intent(&reference(&prepared)).unwrap();
    assert_eq!(replayed.state, HostIntentState::Committed);
    assert_eq!(replayed.receipt, receipt);
    assert_eq!(std::fs::read(dir.path().join("A.md")).unwrap(), TOUCHED);
}

#[test]
fn conditional_capture_ownership_release_and_global_count_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let other = vault
        .claim_client(&OperationId::new(OTHER).unwrap())
        .unwrap();
    let capture = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    assert!(matches!(
        vault.release_conditional_saved_source(&other, &capture.capture_id),
        Err(Error::ConditionalSource(ConditionalSourceError::Owner))
    ));
    assert!(matches!(
        vault.prepare_guarded_host_intent(&other, &request(&witness), &capture.capture_id),
        Err(Error::ConditionalSource(ConditionalSourceError::Owner))
    ));
    for _ in 1..MAX_CONDITIONAL_SOURCE_CAPTURES {
        vault
            .capture_conditional_saved_source(&lease, &witness)
            .unwrap();
    }
    assert!(matches!(
        vault.capture_conditional_saved_source(&other, &witness),
        Err(Error::ConditionalSource(ConditionalSourceError::Limit))
    ));
    vault.retire_conditional_saved_sources(lease.reference());
    let expired = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &capture.capture_id)
        .unwrap();
    assert_eq!(expired.state, HostIntentState::Rejected);
    assert_eq!(
        expired.error.unwrap().code,
        HostRejectionCode::SourceCaptureExpired
    );
    assert!(vault
        .capture_conditional_saved_source(&other, &witness)
        .is_ok());
}

#[test]
fn conditional_source_replacement_inode_and_symlink_never_retarget_guard() {
    for link in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, lease, witness) = fixture(dir.path());
        let capture = vault
            .capture_conditional_saved_source(&lease, &witness)
            .unwrap();
        let prepared = vault
            .prepare_guarded_host_intent(&lease, &request(&witness), &capture.capture_id)
            .unwrap();
        std::fs::write(dir.path().join("other.md"), BEFORE).unwrap();
        if link {
            std::fs::remove_file(dir.path().join("A.md")).unwrap();
            symlink("other.md", dir.path().join("A.md")).unwrap();
        } else {
            std::fs::rename(dir.path().join("other.md"), dir.path().join("A.md")).unwrap();
        }
        let result = vault.commit_host_intent(&reference(&prepared)).unwrap();
        assert_eq!(result.state, HostIntentState::Rejected);
        assert_eq!(
            result.error.unwrap().code,
            HostRejectionCode::ConditionalSourceChanged
        );
        assert_eq!(std::fs::read(dir.path().join("A.md")).unwrap(), BEFORE);
    }
}

#[test]
fn conditional_unknown_io_retains_exact_prepared_guard_for_retry() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let capture = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    let prepared = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &capture.capture_id)
        .unwrap();
    let path = dir.path().join("A.md");
    let permissions = std::fs::metadata(&path).unwrap().permissions();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
    let result = vault.commit_host_intent(&reference(&prepared));
    std::fs::set_permissions(&path, permissions).unwrap();
    assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
    let pending = vault
        .query_host_intent(&reference(&prepared))
        .unwrap()
        .unwrap();
    assert_eq!(pending.state, HostIntentState::CommitRequested);
    assert!(pending.receipt.is_none());
    assert_eq!(
        vault
            .commit_host_intent(&reference(&prepared))
            .unwrap()
            .state,
        HostIntentState::Committed
    );
    assert_eq!(std::fs::read(path).unwrap(), AFTER);
}

#[test]
fn conditional_unprepared_capture_expires_across_restart_as_durable_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let capture = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    drop(lease);
    drop(vault);
    let mut vault = NativeVault::open_existing(dir.path()).unwrap();
    let lease = vault
        .claim_client(&OperationId::new(CLIENT).unwrap())
        .unwrap();
    let rejected = vault
        .prepare_guarded_host_intent(&lease, &request(&witness), &capture.capture_id)
        .unwrap();
    assert_eq!(rejected.state, HostIntentState::Rejected);
    assert_eq!(
        rejected.error.as_ref().unwrap().code,
        HostRejectionCode::SourceCaptureExpired
    );
    assert!(rejected.receipt.is_none());
    assert_eq!(
        vault
            .prepare_guarded_host_intent(&lease, &request(&witness), &capture.capture_id)
            .unwrap(),
        rejected
    );
    assert_eq!(
        vault.commit_host_intent(&reference(&rejected)).unwrap(),
        rejected
    );
    let acknowledged = vault
        .acknowledge_host_intent(
            &reference(&rejected),
            &HostIntentAcknowledgment::Rejected {
                operation_id: rejected.operation_id,
                code: HostRejectionCode::SourceCaptureExpired,
            },
        )
        .unwrap();
    assert!(acknowledged.acknowledged);
    assert_eq!(
        vault
            .read(&witness.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        BEFORE
    );
    assert_eq!(std::fs::read(dir.path().join("A.md")).unwrap(), BEFORE);
}

#[test]
fn conditional_reserved_operation_cannot_bypass_guard_through_native_apply() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let capture = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap();
    let command = request(&witness);
    let prepared = vault
        .prepare_guarded_host_intent(&lease, &command, &capture.capture_id)
        .unwrap();
    vault
        .store
        .request_host_commit(&reference(&prepared))
        .unwrap();
    std::fs::write(dir.path().join("A.md"), TOUCHED).unwrap();
    assert!(matches!(
        vault.apply(&command),
        Err(Error::ConditionalSource(ConditionalSourceError::Changed))
    ));
    assert_eq!(
        vault
            .read(&witness.entry_id)
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        BEFORE
    );
    assert_eq!(std::fs::read(dir.path().join("A.md")).unwrap(), TOUCHED);
}

#[test]
fn conditional_capture_byte_budget_is_shared_across_client_leases() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, lease, witness) = fixture(dir.path());
    let other = vault
        .claim_client(&OperationId::new(OTHER).unwrap())
        .unwrap();
    std::fs::write(dir.path().join("A.md"), vec![b'x'; 5 * 1024 * 1024]).unwrap();
    let first = vault
        .capture_conditional_saved_source(&lease, &witness)
        .unwrap()
        .capture_id;
    for index in 1..6 {
        vault
            .capture_conditional_saved_source(
                if index % 2 == 0 { &lease } else { &other },
                &witness,
            )
            .unwrap();
    }
    assert!(matches!(
        vault.capture_conditional_saved_source(&other, &witness),
        Err(Error::ConditionalSource(ConditionalSourceError::Limit))
    ));
    vault
        .release_conditional_saved_source(&lease, &first)
        .unwrap();
    assert!(vault
        .capture_conditional_saved_source(&other, &witness)
        .is_ok());
}
