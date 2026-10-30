//! Real Native save/import interleaving. This is a progress and authority
//! regression, not a wall-clock or GUI latency measurement.
#![cfg(any(target_os = "macos", target_os = "linux"))]
use std::{fs, num::NonZeroU16, path::Path, time::Duration};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_native::{
    ExternalFileMode, ExternalReconcileOptions, ExternalReconcileQuantum, ExternalWorkPhase,
    FamilyCreateMode, FamilyScope, HostIntentRef, HostIntentState, HostProjectionState,
    NativeVault, ScanOptions,
};
use zorid_sync_protocol::{RealmId, VaultId};

fn op(value: impl Into<String>) -> OperationId {
    OperationId::new(value).unwrap()
}
fn options() -> ExternalReconcileOptions {
    ExternalReconcileOptions {
        scan: ScanOptions {
            max_duration: Duration::from_secs(5),
            ..Default::default()
        },
        max_work_units: NonZeroU16::new(1).unwrap(),
    }
}
fn turn(vault: &mut NativeVault) -> ExternalReconcileQuantum {
    let result = vault
        .reconcile_external_quantum(options(), ExternalFileMode::Auto)
        .unwrap();
    assert!(result.work_units <= 1, "{result:?}");
    result
}
fn create(vault: &mut NativeVault, id: &str, name: &str) {
    vault
        .family_apply(
            &MutationRequest {
                operation_id: op(format!("create-{id}")),
                mutation: Mutation::Create {
                    id: EntryId::new(id).unwrap(),
                    path: VaultPath::new(name).unwrap(),
                    kind: EntryKind::File,
                    content: Some(b"initial saved body\n".to_vec()),
                },
            },
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
}
fn fixture() -> (tempfile::TempDir, NativeVault, OperationId) {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("own-publication-realm").unwrap(),
            vault_id: VaultId::new("own-publication-vault").unwrap(),
        })
        .unwrap();
    create(&mut vault, "own", "a-own.md");
    create(&mut vault, "missing", "b-missing.md");
    fs::remove_file(root.path().join("b-missing.md")).unwrap();
    for index in 0..24 {
        fs::write(
            root.path().join(format!("n-{index:03}.md")),
            format!("external note {index}\n"),
        )
        .unwrap();
    }
    fs::write(
        root.path().join("z-last.md"),
        b"last independently captured note\n",
    )
    .unwrap();
    let first = turn(&mut vault);
    assert!(
        first.pending && !first.reconciliation.run.finished && !first.reconciliation.run.complete
    );
    assert_eq!(
        first.reconciliation.run.observed, 1,
        "first quantum selects the owned file"
    );
    (root, vault, first.reconciliation.run.scan_id)
}
fn save(vault: &mut NativeVault, index: usize) {
    let id = EntryId::new("own").unwrap();
    let expected = vault.read(&id).unwrap().unwrap().state.revision;
    let prepared = vault
        .prepare_host_intent(
            &op("own-publication-client"),
            &MutationRequest {
                operation_id: op(format!("save-{index}")),
                mutation: Mutation::Write {
                    id,
                    expected,
                    content: format!("ordinary saved edit {index}\n").into_bytes(),
                },
            },
        )
        .unwrap();
    assert_eq!(prepared.state, HostIntentState::Prepared);
    let committed = vault
        .commit_host_intent(&HostIntentRef {
            client_id: prepared.client_id,
            token: prepared.token,
        })
        .unwrap();
    assert_eq!(committed.state, HostIntentState::Committed);
    assert_eq!(committed.projection, Some(HostProjectionState::Projected));
}
fn connection(root: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(
        root.join(".zorid/vault.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
fn proof(root: &Path, scan: &OperationId) -> String {
    connection(root)
        .query_row(
            "SELECT record FROM family_external_scan_proofs WHERE scan_id=?1 AND path='a-own.md'",
            [scan.as_str()],
            |row| row.get(0),
        )
        .unwrap()
}
fn assert_fenced(root: &Path, scan: &OperationId) {
    let db = connection(root);
    let run: String = db
        .query_row(
            "SELECT record FROM scan_runs WHERE scan_id=?1",
            [scan.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let run: serde_json::Value = serde_json::from_str(&run).unwrap();
    assert_eq!(run["finished"], true);
    assert_eq!(run["complete"], false);
    let cursor: Option<String> = db.query_row("SELECT encoded_state FROM checkpoint_heads WHERE client_id='zorid_core_external_scan' AND checkpoint_key='external-scan-progress-v1'", [], |row| row.get(0)).unwrap();
    assert!(
        cursor.is_none(),
        "mixed positive hints must not persist old namespace authority"
    );
}
fn listed(vault: &NativeVault, name: &str) -> bool {
    vault
        .list()
        .unwrap()
        .iter()
        .any(|entry| entry.path.as_str() == name && !entry.deleted)
}

#[test]
fn own_saves_drain_finite_positive_hints_before_a_fresh_namespace_inventory() {
    let (root, mut vault, old_scan) = fixture();
    let immutable_proof = proof(root.path(), &old_scan);
    let mut reached_last = false;
    for index in 0..32 {
        // Repeated foreground writes must not reset or append to the finite
        // source-hint queue, even though every publication replaces its inode.
        save(&mut vault, index);
        let next = turn(&mut vault);
        assert_eq!(
            next.reconciliation.run.scan_id, old_scan,
            "own save must not restart discovery"
        );
        assert!(next.pending, "{next:?}");
        assert_eq!(next.phase, ExternalWorkPhase::Discovery);
        assert!(!next.reconciliation.complete && !next.reconciliation.run.complete);
        assert!(next.reconciliation.namespace.is_empty() && next.publication.projected.is_empty());
        assert_fenced(root.path(), &old_scan);
        assert_eq!(proof(root.path(), &old_scan), immutable_proof);
        assert!(
            listed(&vault, "b-missing.md"),
            "hint absence cannot delete a tracked entry"
        );
        if listed(&vault, "z-last.md") {
            reached_last = true;
            break;
        }
    }
    assert!(reached_last, "continuous own saves starved the finite tail");
    let mut fresh_scan = false;
    let mut complete = false;
    for _ in 0..256 {
        let next = turn(&mut vault);
        fresh_scan |= next.reconciliation.run.scan_id != old_scan;
        if !next.pending {
            assert!(next.reconciliation.complete, "{next:?}");
            assert_eq!(next.phase, ExternalWorkPhase::Complete);
            complete = true;
            break;
        }
    }
    assert!(
        fresh_scan && complete,
        "a fresh normal namespace epoch must follow finite hints"
    );
    assert!(!listed(&vault, "b-missing.md"));
    assert_eq!(
        fs::read(root.path().join("z-last.md")).unwrap(),
        b"last independently captured note\n"
    );
}

#[test]
fn positive_only_hint_state_is_discarded_on_native_reopen() {
    let (root, mut vault, old_scan) = fixture();
    save(&mut vault, 0);
    let next = turn(&mut vault);
    assert!(next.pending && !next.reconciliation.complete, "{next:?}");
    assert_eq!(next.reconciliation.run.scan_id, old_scan);
    assert_fenced(root.path(), &old_scan);
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let fresh = turn(&mut vault);
    assert_ne!(
        fresh.reconciliation.run.scan_id, old_scan,
        "RAM hints cannot resume as persisted scan authority"
    );
    assert!(!fresh.reconciliation.run.complete);
    assert_eq!(
        fs::read(root.path().join("a-own.md")).unwrap(),
        b"ordinary saved edit 0\n"
    );
}

#[test]
fn unknown_root_mutation_before_own_publication_keeps_normal_invalidation() {
    let (root, mut vault, old_scan) = fixture();
    fs::write(
        root.path().join("new-before-own-save.md"),
        b"external addition\n",
    )
    .unwrap();
    save(&mut vault, 0);
    let next = turn(&mut vault);
    assert_eq!(next.reconciliation.run.scan_id, old_scan);
    assert!(!next.pending && !next.reconciliation.complete);
    assert_eq!(next.phase, ExternalWorkPhase::Blocked);
    assert!(next
        .reconciliation
        .issues
        .iter()
        .any(|issue| issue.reason.contains("root marker changed")));
    let fresh = turn(&mut vault);
    assert_ne!(fresh.reconciliation.run.scan_id, old_scan);
}
