//! Durable inventory acknowledgements must not create new history for no delta.
use super::*;
use zorid_store::FamilyScope;
use zorid_sync_protocol::{RealmId, VaultId};

fn fixture() -> (tempfile::TempDir, NativeVault, ProgressScan) {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("noop-realm").unwrap(),
            vault_id: VaultId::new("noop-vault").unwrap(),
        })
        .unwrap();
    std::fs::write(root.path().join("note.md"), b"inventory no-op fixture").unwrap();
    let scan = vault
        .external_progress_scan_locked(ScanOptions {
            max_duration: std::time::Duration::from_secs(5),
            ..ScanOptions::default()
        })
        .unwrap();
    assert!(scan.run.complete && scan.active());
    assert_eq!(
        scan.pending_paths(),
        vec![VaultPath::new("note.md").unwrap()]
    );
    (root, vault, scan)
}

fn revisions(vault: &mut NativeVault) -> u64 {
    let scope = CheckpointScope {
        vault_id: vault.store.identity().unwrap().local_store_id,
        client_id: OperationId::new("zorid_core_external_scan").unwrap(),
    };
    vault
        .store
        .checkpoint_changes(&scope, "0", 1, None)
        .unwrap()
        .high_water
        .parse()
        .unwrap()
}

fn noop(scan: &mut ProgressScan, vault: &mut NativeVault, operation: u8) -> Result<()> {
    match operation {
        0 => scan.retain_issues(vault, &[]),
        1 => scan.record_namespace_processed(vault, scan.namespace_processed()),
        2 => scan.record_processed_retaining(vault, &[], true),
        _ => unreachable!(),
    }
}

#[test]
fn healthy_import_tail_without_inventory_delta_appends_no_checkpoint_revisions() {
    let (_root, mut vault, mut scan) = fixture();
    let before = revisions(&mut vault);
    // The three acknowledgements performed at a healthy import-turn tail.
    for operation in 0..3 {
        noop(&mut scan, &mut vault, operation).unwrap();
    }
    let after = revisions(&mut vault);
    eprintln!(
        "healthy no-delta inventory revisions appended: {}",
        after - before
    );
    assert_eq!(
        after, before,
        "no semantic delta must not manufacture durable history"
    );
}

#[test]
fn changed_inventory_acknowledgements_survive_restart_and_repeats_do_not_write() {
    let (root, mut vault, mut scan) = fixture();
    let issue = ScanIssue {
        path: Some(VaultPath::new("note.md").unwrap()),
        reason: "retained fixture issue".into(),
    };
    let namespaces = BTreeSet::from([EntryId::new("namespace-fixture").unwrap()]);
    let processed = [VaultPath::new("note.md").unwrap()];
    let before = revisions(&mut vault);
    scan.retain_issues(&mut vault, &[issue.clone()]).unwrap();
    scan.record_namespace_processed(&mut vault, namespaces.clone())
        .unwrap();
    scan.record_processed_retaining(&mut vault, &processed, true)
        .unwrap();
    assert_eq!(revisions(&mut vault), before + 3);
    scan.retain_issues(&mut vault, &[issue]).unwrap();
    scan.record_namespace_processed(&mut vault, namespaces.clone())
        .unwrap();
    scan.record_processed_retaining(&mut vault, &processed, true)
        .unwrap();
    assert_eq!(
        revisions(&mut vault),
        before + 3,
        "exact acknowledgements are read-only"
    );
    drop(vault);
    let mut reopened = NativeVault::open(root.path()).unwrap();
    let (_, durable) = reopened
        .store
        .external_scan_progress::<Inventory>()
        .unwrap();
    let durable = durable.unwrap();
    durable.validate().unwrap();
    assert_eq!(durable.namespace_processed, namespaces);
    assert_eq!(durable.processed, BTreeSet::from(processed));
    assert_eq!(durable.reconciliation_issues.len(), 1);
    assert_eq!(
        durable.reconciliation_issues[0].reason,
        "retained fixture issue"
    );
}

#[test]
fn no_delta_still_rejects_a_foreign_checkpoint_revision_without_overwriting_it() {
    for operation in 0..3 {
        let (root, mut vault, mut scan) = fixture();
        let mut foreign = Store::open(root.path().join(".zorid/vault.sqlite")).unwrap();
        let (revision, durable) = foreign.external_scan_progress::<Inventory>().unwrap();
        let next = foreign
            .save_external_scan_progress(revision.as_deref(), durable.as_ref())
            .unwrap();
        let before = revisions(&mut vault);
        assert!(noop(&mut scan, &mut vault, operation).is_err());
        assert_eq!(revisions(&mut vault), before);
        assert_eq!(
            foreign.external_scan_progress::<Inventory>().unwrap().0,
            Some(next)
        );
    }
}

#[test]
fn no_delta_keeps_checkpoint_corruption_checks() {
    for operation in 0..3 {
        let (root, mut vault, mut scan) = fixture();
        let foreign = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
        foreign
            .execute(
                "UPDATE checkpoint_revisions SET state_bytes=state_bytes+1 WHERE revision=?1",
                [scan.checkpoint_revision.as_ref().unwrap()],
            )
            .unwrap();
        assert!(
            noop(&mut scan, &mut vault, operation).is_err(),
            "corrupt retained checkpoint must fail closed"
        );
    }
}

#[test]
fn no_delta_processed_acknowledgement_still_requires_its_present_proof() {
    let (_root, mut vault, mut scan) = fixture();
    let path = VaultPath::new("note.md").unwrap();
    scan.record_processed_retaining(&mut vault, &[path.clone()], true)
        .unwrap();
    scan.proofs.remove(&path);
    assert!(scan
        .record_processed_retaining(&mut vault, &[path], true)
        .is_err());
}

#[test]
fn empty_acknowledgement_still_durably_retires_finished_inventory_when_requested() {
    let (_root, mut vault, mut scan) = fixture();
    scan.record_processed_retaining(&mut vault, &[VaultPath::new("note.md").unwrap()], true)
        .unwrap();
    let before = revisions(&mut vault);
    scan.record_processed_retaining(&mut vault, &[], false)
        .unwrap();
    assert!(!scan.active());
    assert_eq!(revisions(&mut vault), before + 1);
    assert!(vault
        .store
        .external_scan_progress::<Inventory>()
        .unwrap()
        .1
        .is_none());
}
