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

fn micro_options() -> ExternalReconcileOptions {
    ExternalReconcileOptions {
        scan: ScanOptions {
            max_duration: std::time::Duration::from_secs(5),
            ..ScanOptions::default()
        },
        max_work_units: std::num::NonZeroU16::new(4).unwrap(),
    }
}

fn micro_fixture(count: usize) -> (tempfile::TempDir, NativeVault) {
    let root = tempfile::tempdir().unwrap();
    for index in 0..count {
        std::fs::write(root.path().join(format!("{index:02}.md")), b"stable note\n").unwrap();
    }
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("micro-realm").unwrap(),
            vault_id: VaultId::new("micro-vault").unwrap(),
        })
        .unwrap();
    (root, vault)
}

fn finish_micro(vault: &mut NativeVault) -> (usize, usize) {
    let mut scan_id = None;
    let mut units = 0;
    for turn in 1..=256 {
        let result = vault
            .reconcile_external_quantum(micro_options(), ExternalFileMode::Auto)
            .unwrap();
        assert!(result.work_units <= 4);
        if let Some(expected) = &scan_id {
            assert_eq!(&result.reconciliation.run.scan_id, expected);
        } else {
            scan_id = Some(result.reconciliation.run.scan_id.clone());
        }
        units += usize::from(result.work_units);
        if !result.pending {
            assert!(result.reconciliation.complete, "{result:?}");
            return (turn, units);
        }
    }
    panic!("stable micro-quantum inventory did not finish");
}

#[test]
fn micro_quantum_exact_present_audit_has_no_empty_absence_work() {
    let (_root, mut vault) = micro_fixture(32);
    finish_micro(&mut vault);
    let before = vault.list().unwrap();
    let (turns, units) = finish_micro(&mut vault);
    assert_eq!(vault.list().unwrap(), before);
    eprintln!("stable 32-file audit: turns={turns}, work_units={units}");
    // Discovery, complete-authority positive retries, publication, and its one
    // final check remain. Exact Present captures need no absence inspection.
    assert_eq!(units, 32 * 3 + 1);
}

#[test]
fn micro_quantum_unchanged_current_directory_writes_only_advanced_cursor() {
    let (_root, mut vault) = micro_fixture(12);
    let _lock = vault.paths.lock(vault.options.lock_timeout).unwrap();
    let options = micro_options();
    let mut budget =
        super::super::external_scan_quantum::ExternalWorkBudget::new(&options).unwrap();
    let mut first = vault
        .external_progress_scan_with_budget(options.scan.clone(), Some(&mut budget))
        .unwrap();
    assert_eq!(first.run.observed, 4);
    first
        .record_processed_retaining(&mut vault, &first.pending_paths(), true)
        .unwrap();
    let before = revisions(&mut vault);
    let mut budget =
        super::super::external_scan_quantum::ExternalWorkBudget::new(&options).unwrap();
    let second = vault
        .external_progress_scan_with_budget(options.scan, Some(&mut budget))
        .unwrap();
    assert_eq!(second.run.scan_id, first.run.scan_id);
    assert_eq!(second.run.observed, 8);
    assert!(!second.run.complete);
    let added = revisions(&mut vault) - before;
    eprintln!("unchanged current-directory batch checkpoint revisions: {added}");
    assert_eq!(added, 1, "only the newly advanced cursor needs a revision");
}

#[test]
fn micro_quantum_old_broad_absence_cursor_retains_and_finishes_missing_proofs() {
    let (root, mut vault) = micro_fixture(5);
    finish_micro(&mut vault);
    let mut bindings = vault.store.physical_bindings().unwrap();
    bindings.sort_by(|a, b| a.state.id.cmp(&b.state.id));
    let before = bindings.first().unwrap().clone();
    let after = bindings.last().unwrap().clone();
    let middle = bindings[2].clone();
    for missing in [&before, &after] {
        std::fs::remove_file(root.path().join(missing.state.path.as_str())).unwrap();
    }
    let mut options = micro_options();
    options.max_work_units = std::num::NonZeroU16::new(1).unwrap();
    let scan_id;
    {
        let _lock = vault.paths.lock(vault.options.lock_timeout).unwrap();
        let mut captured = None;
        for _ in 0..32 {
            let mut budget =
                super::super::external_scan_quantum::ExternalWorkBudget::new(&options).unwrap();
            let mut scan = vault
                .external_progress_scan_with_budget(options.scan.clone(), Some(&mut budget))
                .unwrap();
            if scan.inventory.absence_after.as_ref() == Some(&before.state.id) {
                captured = Some(scan);
                break;
            }
            assert!(!scan.run.complete);
            scan.record_processed_retaining(&mut vault, &scan.pending_paths(), true)
                .unwrap();
        }
        let mut scan = captured.expect("first missing binding must be durably captured");
        assert!(matches!(
            scan.proofs.get(&before.state.path),
            Some(ExternalScanProof::Absent { .. })
        ));
        assert!(matches!(
            scan.proofs.get(&middle.state.path),
            Some(ExternalScanProof::Present { .. })
        ));
        scan_id = scan.run.scan_id.clone();
        // The old loop advanced across exact Present bindings as well. This
        // represents its durable cursor after the first absence and a later
        // harmless Present binding, but before the final missing binding.
        scan.inventory.absence_after = Some(middle.state.id.clone());
        vault
            .store
            .save_external_scan_progress(scan.checkpoint_revision.as_deref(), Some(&scan.inventory))
            .unwrap();
    }
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let _lock = vault.paths.lock(vault.options.lock_timeout).unwrap();
    for _ in 0..16 {
        let mut budget =
            super::super::external_scan_quantum::ExternalWorkBudget::new(&options).unwrap();
        let scan = vault
            .external_progress_scan_with_budget(options.scan.clone(), Some(&mut budget))
            .unwrap();
        assert_eq!(scan.run.scan_id, scan_id);
        if scan.run.complete {
            for missing in [&before, &after] {
                assert!(
                    matches!(scan.proofs.get(&missing.state.path), Some(ExternalScanProof::Absent { before: original }) if original == missing)
                );
                assert_eq!(
                    vault
                        .store
                        .physical_binding(&missing.state.id)
                        .unwrap()
                        .as_ref(),
                    Some(missing),
                    "inventory capture alone must not delete a binding"
                );
            }
            assert!(matches!(
                scan.proofs.get(&middle.state.path),
                Some(ExternalScanProof::Present { .. })
            ));
            return;
        }
    }
    panic!("old broad absence cursor did not finish its remaining actual candidate");
}
