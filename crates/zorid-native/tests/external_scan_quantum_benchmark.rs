//! Opt-in latency/progress evidence. Not a startup, GUI or priority benchmark.
use std::{collections::BTreeMap, time::Instant};
use zorid_core::OperationId;
use zorid_native::{CheckpointScope, CheckpointWrite, ExternalFileMode, ExternalReconcileOptions, FamilyScope, NativeVault};
use zorid_sync_protocol::{RealmId, VaultId};

fn quantile(values: &[f64], fraction: f64) -> f64 {
    values[((values.len() - 1) as f64 * fraction).ceil() as usize]
}
fn drive(vault: &mut NativeVault, scope: &CheckpointScope, label: &str) -> serde_json::Value {
    let started = Instant::now();
    let mut times = Vec::new();
    let mut work_units = 0;
    let mut imports = 0;
    let mut phases = BTreeMap::<String, usize>::new();
    let mut checkpoint: Option<String> = None;
    for index in 0..10_000 {
        let call = Instant::now();
        let quantum = vault.reconcile_external_quantum(ExternalReconcileOptions::default(), ExternalFileMode::Auto).unwrap();
        times.push(call.elapsed().as_secs_f64() * 1_000.0);
        assert!(quantum.work_units <= 16);
        work_units += u64::from(quantum.work_units);
        imports += quantum.reconciliation.imported.len();
        *phases.entry(format!("{:?}", quantum.phase)).or_default() += 1;
        // A normal public foreground CAS executes after every yielded quantum.
        // This proves no private scope/operation bypass, not FIFO priority.
        let next = format!("{}-1a27-46d2-a65b-{index:012x}", if label == "fresh" { "a30c7f5a" } else { "b30c7f5a" });
        vault.checkpoint_compare_and_swap(scope, CheckpointWrite { key: label, expected_revision: checkpoint.as_deref(), next_revision: &next, encoded_state: Some("{\"draft\":\"retained\"}") }).unwrap();
        checkpoint = Some(next);
        if !quantum.pending {
            assert!(quantum.reconciliation.complete, "{quantum:?}");
            times.sort_by(f64::total_cmp);
            return serde_json::json!({"kind":"direct-native-quantum","mode":label,"turns":times.len(),"workUnits":work_units,"imports":imports,"phases":phases,"quantumMs":{"p50":quantile(&times,0.50),"p95":quantile(&times,0.95),"maximum":times.last()},"totalWithForegroundCheckpointMs":started.elapsed().as_secs_f64()*1_000.0});
        }
    }
    panic!("benchmark failed to make finite progress");
}
#[test]
#[ignore = "opt-in 1000-note fixture; serialize with native/desktop verification"]
fn fresh_and_reopened_1000_note_quantum_latency_with_variable_selected_file_sizes() {
    for selected_bytes in [8 * 1024, 512 * 1024, 5 * 1024 * 1024] {
        let root = tempfile::tempdir().unwrap();
        let selected = vec![b'a'; selected_bytes];
        std::fs::write(root.path().join("000Selected.md"), &selected).unwrap();
        for index in 1..1000 { std::fs::write(root.path().join(format!("Note{index:04}.md")), format!("# Note {index}\nSaved fixture body.\n")).unwrap(); }
        let mut vault = NativeVault::open(root.path()).unwrap();
        vault.family_enroll(&FamilyScope { realm_id: RealmId::new("quantum-benchmark-realm").unwrap(), vault_id: VaultId::new("quantum-benchmark-vault").unwrap() }).unwrap();
        let scope = CheckpointScope { vault_id: vault.identity().unwrap().local_store_id, client_id: OperationId::new("fa8de90c-4199-4684-94cf-589b496b4bdc").unwrap() };
        let fresh = drive(&mut vault, &scope, "fresh");
        assert_eq!(vault.list().unwrap().len(), 1000);
        assert_eq!(std::fs::read(root.path().join("000Selected.md")).unwrap(), selected);
        drop(vault);
        let mut vault = NativeVault::open_existing(root.path()).unwrap();
        let reopened = drive(&mut vault, &scope, "reopen");
        assert_eq!(vault.list().unwrap().len(), 1000);
        assert_eq!(std::fs::read(root.path().join("000Selected.md")).unwrap(), selected);
        println!("{}", serde_json::json!({"fixtureNotes":1000,"selectedBytes":selected_bytes,"fresh":fresh,"reopen":reopened}));
    }
}
