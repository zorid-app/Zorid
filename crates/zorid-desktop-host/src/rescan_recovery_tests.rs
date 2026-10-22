//! Exercise the ordinary family-mode desktop poll, including its physical file
//! oracle. A logical committed receipt alone cannot prove file publication.
use super::*;
use zorid_native::{HostIntentState, HostProjectionState};
use zorid_store::{FamilyCreateMode, ProjectionPhase, Store};

const INITIAL: &[u8] = b"---\nscore: 9\nuntouched: keep\n---\nBody sentinel\n";
const UNDO: &[u8] = b"---\nscore: 1\nuntouched: keep\n---\nBody sentinel\n";
const EXTERNAL: &[u8] =
    b"---\nscore: 9\nuntouched: external-unrelated\n---\nBody sentinel\nExternal body marker\n";
const MERGED: &[u8] =
    b"---\nscore: 1\nuntouched: external-unrelated\n---\nBody sentinel\nExternal body marker\n";

fn pending_undo(root: &Path) -> (NativeVault, HostIntentRef, zorid_core::CommitResult) {
    let mut vault = NativeVault::open(root).unwrap();
    assert!(initialize_desktop_vault(&mut vault).unwrap().complete);
    let id = EntryId::new("note").unwrap();
    let created = vault
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("create").unwrap(),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: VaultPath::new("A.md").unwrap(),
                    kind: EntryKind::File,
                    content: Some(INITIAL.to_vec()),
                },
            },
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    assert!(matches!(created.projection, ProjectionStatus::Projected));
    let revision = vault.read(&id).unwrap().unwrap().state.revision;
    // The external writer changes the saved physical branch before watcher
    // discovery. The ordinary editor undo still has the current core witness.
    std::fs::write(root.join("A.md"), EXTERNAL).unwrap();
    let client = OperationId::new("editor-client").unwrap();
    let prepared = vault
        .prepare_host_intent(
            &client,
            &MutationRequest {
                operation_id: OperationId::new("conditional-undo").unwrap(),
                mutation: Mutation::Write {
                    id,
                    expected: revision,
                    content: UNDO.to_vec(),
                },
            },
        )
        .unwrap();
    let reference = HostIntentRef {
        client_id: client,
        token: prepared.token,
    };
    let committed = vault.commit_host_intent(&reference).unwrap();
    assert_eq!(committed.state, HostIntentState::Committed);
    assert_eq!(committed.projection, Some(HostProjectionState::Pending));
    let receipt = committed.receipt.unwrap();
    let acknowledged = vault
        .acknowledge_host_intent(
            &reference,
            &HostIntentAcknowledgment::Committed {
                operation_id: receipt.operation_id.clone(),
                sequence: receipt.sequence.to_string(),
            },
        )
        .unwrap();
    assert!(acknowledged.acknowledged);
    assert_eq!(std::fs::read(root.join("A.md")).unwrap(), EXTERNAL);
    assert_ne!(vault.family_status().unwrap().pending_projection, "0");
    let store = Store::open_existing_no_follow(root.join(".zorid/vault.sqlite")).unwrap();
    assert!(store
        .projection_attempts(false)
        .unwrap()
        .iter()
        .any(|attempt| attempt.target.state.id.as_str() == "note"
            && matches!(
                attempt.phase,
                ProjectionPhase::Prepared | ProjectionPhase::Staged
            )));
    (vault, reference, receipt)
}

#[test]
fn family_rescan_publishes_merged_acknowledged_undo_after_cancelled_attempt() {
    let root = tempfile::tempdir().unwrap();
    let (mut vault, reference, receipt) = pending_undo(root.path());
    let mut leases = ClientLeases::default();
    let (scan, body) = execute(&mut vault, &mut leases, None, Command::Rescan, vec![]).unwrap();
    assert!(body.is_empty());
    assert_eq!(scan["complete"], true, "{scan}");
    assert_eq!(scan["reconciliation"]["complete"], true, "{scan}");
    assert_eq!(scan["imported"], 1, "{scan}");
    let current = vault.read(&EntryId::new("note").unwrap()).unwrap().unwrap();
    assert_eq!(current.content.as_deref(), Some(MERGED));
    assert_ne!(current.state.revision, receipt.changes[0].after.revision);
    assert_eq!(
        std::fs::read(root.path().join("A.md")).unwrap(),
        MERGED,
        "ordinary rescan must publish the merge, not leave core-only undo state"
    );
    assert_eq!(vault.family_status().unwrap().pending_projection, "0");
    {
        let store =
            Store::open_existing_no_follow(root.path().join(".zorid/vault.sqlite")).unwrap();
        assert!(store
            .projection_attempts(true)
            .unwrap()
            .iter()
            .any(|attempt| attempt.target.state.id.as_str() == "note"
                && attempt.phase == ProjectionPhase::Cancelled));
        assert!(store.projection_attempts(false).unwrap().is_empty());
        assert!(store.pending_projection_jobs(100).unwrap().is_empty());
    }
    // Poll/retry cannot author a second undo or lose the merged external edit.
    let cursor = vault.list_snapshot().unwrap().cursor;
    let (again, _) = execute(&mut vault, &mut leases, None, Command::Rescan, vec![]).unwrap();
    assert_eq!(again["complete"], true, "{again}");
    assert_eq!(again["imported"], 0, "{again}");
    assert_eq!(
        vault.commit_host_intent(&reference).unwrap().receipt,
        Some(receipt)
    );
    assert_eq!(vault.list_snapshot().unwrap().cursor, cursor);
    assert_eq!(std::fs::read(root.path().join("A.md")).unwrap(), MERGED);
}

#[test]
fn family_rescan_reports_retained_recovery_without_overwriting_replacement_inode() {
    let root = tempfile::tempdir().unwrap();
    let (mut vault, _, _) = pending_undo(root.path());
    let replacement = b"Unrelated replacement inode\n";
    std::fs::write(root.path().join("replacement.tmp"), replacement).unwrap();
    std::fs::rename(
        root.path().join("replacement.tmp"),
        root.path().join("A.md"),
    )
    .unwrap();
    let (scan, _) = execute(
        &mut vault,
        &mut ClientLeases::default(),
        None,
        Command::Rescan,
        vec![],
    )
    .unwrap();
    assert_eq!(scan["complete"], false, "{scan}");
    assert_eq!(scan["reconciliation"]["complete"], false, "{scan}");
    assert!(
        scan["reconciliation"]["issueCount"].as_u64().unwrap() > 0,
        "{scan}"
    );
    assert!(
        scan["reconciliation"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["code"] == "recovery_retained"),
        "{scan}"
    );
    assert_eq!(
        std::fs::read(root.path().join("A.md")).unwrap(),
        replacement
    );
    assert_ne!(vault.family_status().unwrap().pending_projection, "0");
}
