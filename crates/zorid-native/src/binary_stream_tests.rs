use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use zorid_store::ExternalNamespaceObservation;
use zorid_sync_protocol::{RealmId, VaultId};

const LENGTH: u64 = 17 * 1024 * 1024 + 17;
const CHUNK: usize = 128 * 1024;

fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn path(value: &str) -> VaultPath {
    VaultPath::new(value).unwrap()
}
fn enrolled(root: &std::path::Path) -> NativeVault {
    let mut vault = NativeVault::open(root).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("large-native-realm").unwrap(),
            vault_id: VaultId::new("large-native-vault").unwrap(),
        })
        .unwrap();
    vault
}
// Offset-derived bytes make every range independently checkable, including the
// final short chunk. No expected whole-file body is retained by these fixtures.
fn bytes(offset: u64, count: usize, variant: u8) -> Vec<u8> {
    (offset..offset + count as u64)
        .map(|i| ((i.wrapping_mul(73) ^ (i >> 9) ^ (i >> 17)) as u8).wrapping_add(variant))
        .collect()
}
fn digest(variant: u8) -> Sha256Digest {
    let mut hash = Sha256::new();
    let mut offset = 0;
    while offset < LENGTH {
        let count = CHUNK.min((LENGTH - offset) as usize);
        hash.update(bytes(offset, count, variant));
        offset += count as u64;
    }
    Sha256Digest(hash.finalize().into())
}
fn write_file(file: &std::path::Path, variant: u8) {
    // Truncating an existing file preserves its public inode for the edit case.
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(file)
        .unwrap();
    let mut offset = 0;
    while offset < LENGTH {
        let chunk = bytes(offset, CHUNK.min((LENGTH - offset) as usize), variant);
        file.write_all(&chunk).unwrap();
        offset += chunk.len() as u64;
    }
    file.sync_all().unwrap();
}
fn assert_file(file: &std::path::Path, variant: u8) {
    let mut file = std::fs::File::open(file).unwrap();
    assert_eq!(file.metadata().unwrap().len(), LENGTH);
    let mut offset = 0;
    let mut actual = vec![0; CHUNK];
    while offset < LENGTH {
        let count = CHUNK.min((LENGTH - offset) as usize);
        file.read_exact(&mut actual[..count]).unwrap();
        assert_eq!(
            &actual[..count],
            bytes(offset, count, variant),
            "public offset {offset}"
        );
        offset += count as u64;
    }
    assert_eq!(file.read(&mut actual[..1]).unwrap(), 0);
}
fn assert_pin(vault: &NativeVault, session: &BinaryReadSession, variant: u8) {
    assert_eq!(session.len(), LENGTH);
    let mut offset = 0;
    while offset < LENGTH {
        let count = CHUNK.min((LENGTH - offset) as usize);
        let actual = vault
            .read_binary_range(session, offset, count as u32)
            .unwrap();
        assert_eq!(actual.offset, offset);
        assert_eq!(
            actual.bytes,
            bytes(offset, count, variant),
            "pinned offset {offset}"
        );
        offset += count as u64;
        assert_eq!(actual.eof, offset == LENGTH);
    }
    let eof = vault.read_binary_range(session, LENGTH, 1).unwrap();
    assert!(eof.bytes.is_empty() && eof.eof);
}
fn append(vault: &mut NativeVault, stage: &BinaryStageRef, start: u64, end: u64, variant: u8) {
    let mut offset = start;
    while offset < end {
        let chunk = bytes(offset, CHUNK.min((end - offset) as usize), variant);
        let receipt = vault
            .append_binary_chunk(stage, (offset / CHUNK as u64) as u32, offset, &chunk)
            .unwrap();
        assert_eq!(receipt.offset, offset);
        assert_eq!(receipt.bytes as usize, chunk.len());
        offset += chunk.len() as u64;
        assert_eq!(receipt.accepted_length, offset);
    }
}
fn sealed(
    vault: &mut NativeVault,
    operation: &str,
    request: BinaryStageRequest,
    variant: u8,
) -> BinaryStageRef {
    let stage = vault
        .begin_binary_stage(
            &op("large-client"),
            &op(operation),
            &request,
            DEFAULT_STREAMING_LIMITS,
        )
        .unwrap();
    append(vault, &stage, 0, LENGTH, variant);
    vault
        .seal_binary_stage(&stage, LENGTH, Some(digest(variant)))
        .unwrap();
    stage
}
fn options() -> ScanOptions {
    ScanOptions {
        max_duration: Duration::from_secs(120),
        ..ScanOptions::default()
    }
}
fn reconcile(vault: &mut NativeVault) -> ExternalReconcileReport {
    let report = vault
        .reconcile_external(options(), ExternalFileMode::Auto)
        .unwrap();
    assert!(report.complete, "{report:?}");
    report
}
fn state_at(vault: &NativeVault, value: &str) -> EntryState {
    vault
        .list()
        .unwrap()
        .into_iter()
        .find(|state| state.path == path(value))
        .unwrap()
}

#[test]
fn native_large_stage_restart_receipt_and_lost_open_ack_keep_original_sources() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    let id = EntryId::new("large-file").unwrap();
    let client = op("large-client");
    let operation = op("large-create");
    let request = BinaryStageRequest {
        target: BinaryTarget::Create {
            id: id.clone(),
            path: path("large.bin"),
        },
        expected_length: Some(LENGTH),
    };
    let stage = vault
        .begin_binary_stage(&client, &operation, &request, DEFAULT_STREAMING_LIMITS)
        .unwrap();
    append(&mut vault, &stage, 0, 2 * CHUNK as u64, 3);
    assert!(vault.read_metadata(&id).unwrap().is_none());
    assert!(!root.path().join("large.bin").exists());
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let resumed = vault
        .resume_binary_stage(&client, &operation)
        .unwrap()
        .unwrap();
    assert_eq!(resumed, stage);
    assert_eq!(vault.binary_stage_request(&resumed).unwrap(), request);
    let progress = vault.query_binary_stage(&resumed).unwrap();
    assert_eq!(progress.state, StagePhase::Receiving);
    assert_eq!(progress.accepted_length, 2 * CHUNK as u64);
    assert_eq!(progress.next_sequence, 2);
    append(&mut vault, &resumed, progress.accepted_length, LENGTH, 3);
    vault
        .seal_binary_stage(&resumed, LENGTH, Some(digest(3)))
        .unwrap();
    assert_eq!(
        vault.query_binary_stage(&resumed).unwrap().state,
        StagePhase::Sealed
    );
    assert!(vault.read_metadata(&id).unwrap().is_none());
    vault.request_commit_binary_stage(&resumed).unwrap();
    let original = vault.commit_binary_stage(&resumed).unwrap();
    assert!(
        matches!(original.projection, ProjectionStatus::Projected),
        "{original:?}"
    );
    assert_file(&root.path().join("large.bin"), 3);
    let first = vault
        .open_binary_read(&client, &op("lost-open-ack"), &id, None)
        .unwrap();
    assert_pin(&vault, &first, 3);
    let old_ref = first.reference().clone();
    let old_source = first.source().clone();
    let old_state = first.state().unwrap().clone();
    drop(first); // Simulate the caller losing the Open response, not closing it.
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let resumed = vault
        .resume_binary_stage(&client, &operation)
        .unwrap()
        .unwrap();
    let terminal = vault.query_binary_stage(&resumed).unwrap();
    assert_eq!(terminal.state, StagePhase::Committed);
    let Some(BinaryStageTerminal::Committed(committed)) = terminal.terminal else {
        panic!("missing original receipt")
    };
    assert_eq!(committed.receipt, original.commit);
    let BinarySourceRef::Graph(old_graph) = &old_source else {
        panic!("expected published source")
    };
    let newer = sealed(
        &mut vault,
        "large-write",
        BinaryStageRequest {
            target: BinaryTarget::Write {
                id: id.clone(),
                expected_revision: old_state.revision.clone(),
                expected_content_event: old_graph.selected_event.clone(),
            },
            expected_length: Some(LENGTH),
        },
        19,
    );
    let changed = vault.commit_binary_stage(&newer).unwrap();
    assert!(
        matches!(changed.projection, ProjectionStatus::Projected),
        "{changed:?}"
    );
    assert_file(&root.path().join("large.bin"), 19);
    let retry = vault
        .open_binary_read(&client, &op("lost-open-ack"), &id, None)
        .unwrap();
    assert_eq!(retry.reference(), &old_ref);
    assert_eq!(retry.source(), &old_source);
    assert_eq!(retry.state(), Some(&old_state));
    assert_pin(&vault, &retry, 3);
    vault.close_binary_read(retry.reference()).unwrap();
    let current = vault
        .open_binary_read(&client, &op("lost-open-ack"), &id, None)
        .unwrap();
    assert_ne!(current.reference().pin_id(), old_ref.pin_id());
    assert_ne!(current.source(), &old_source);
    assert_pin(&vault, &current, 19);
    vault.close_binary_read(current.reference()).unwrap();
    let replay = vault.commit_binary_stage(&resumed).unwrap();
    assert_eq!(replay.commit, original.commit);
    assert!(matches!(replay.projection, ProjectionStatus::Projected));
    assert_file(&root.path().join("large.bin"), 19);
}

#[test]
fn native_large_compound_external_restart_reuses_original_pending_capture() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = enrolled(root.path());
    std::fs::create_dir(root.path().join("before")).unwrap();
    write_file(&root.path().join("before/data.bin"), 7);
    std::fs::write(
        root.path().join("before/gone.custom"),
        b"tracked small child",
    )
    .unwrap();
    reconcile(&mut vault);
    let folder = state_at(&vault, "before");
    let binary = state_at(&vault, "before/data.bin");
    let gone = state_at(&vault, "before/gone.custom");
    let bindings = vault.store.physical_bindings().unwrap();
    let binary_binding = vault.store.physical_binding(&binary.id).unwrap().unwrap();
    let status = vault.family_status().unwrap();
    std::fs::rename(root.path().join("before"), root.path().join("after")).unwrap();
    write_file(&root.path().join("after/data.bin"), 29);
    std::fs::remove_file(root.path().join("after/gone.custom")).unwrap();
    let partial = vault
        .reconcile_external(
            ScanOptions {
                max_entries: 1,
                ..options()
            },
            ExternalFileMode::Auto,
        )
        .unwrap();
    assert!(
        !partial.run.complete,
        "partial inventory must not authorize deletion: {partial:?}"
    );
    assert!(partial.namespace.is_empty());
    assert_eq!(vault.store.physical_bindings().unwrap(), bindings);
    assert_eq!(state_at(&vault, "before/gone.custom"), gone);
    vault.fault = Some(|point| {
        if point == "external_namespace_prepared" {
            panic!("compound prepared interruption")
        }
    });
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| reconcile(&mut vault))).is_err()
    );
    assert_eq!(vault.store.physical_bindings().unwrap(), bindings);
    assert_eq!(vault.family_status().unwrap(), status);
    assert_eq!(state_at(&vault, "before"), folder);
    assert_eq!(state_at(&vault, "before/data.bin"), binary);
    assert_eq!(state_at(&vault, "before/gone.custom"), gone);
    let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    let (raw, completed): (String, bool) = sql
        .query_row(
            "SELECT record,result IS NOT NULL FROM family_external_namespace",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(!completed);
    let prepared: ExternalNamespaceObservation = serde_json::from_str(&raw).unwrap();
    let content = prepared
        .members
        .iter()
        .find(|m| m.before.state.id == binary.id)
        .unwrap()
        .observed_content
        .as_ref()
        .unwrap();
    let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content else {
        panic!("large edit must remain captured")
    };
    let pending_id = capture.stage.operation_id.clone();
    let capture = capture.clone();
    drop(sql);
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let report = reconcile(&mut vault);
    assert!(report.run.complete);
    assert_eq!(report.namespace.len(), 1, "{report:?}");
    let receipt = &report.namespace[0];
    assert_eq!(receipt.observation_id, prepared.observation_id);
    assert_eq!(receipt.authored.len(), 2);
    assert_eq!(receipt.pending_content, vec![pending_id.clone()]);
    assert_eq!(
        report.imported.len(),
        1,
        "only the retained large edit should import: {report:?}"
    );
    assert_eq!(report.imported[0].operation_id, pending_id);
    assert_eq!(state_at(&vault, "after").id, folder.id);
    assert_eq!(state_at(&vault, "after/data.bin").id, binary.id);
    assert!(!root.path().join("before").exists());
    assert!(!root.path().join("after/gone.custom").exists());
    assert!(vault.store.physical_binding(&gone.id).unwrap().is_none());
    assert!(vault.store.projection_baseline(&gone.id).unwrap().is_none());
    assert!(!vault
        .list()
        .unwrap()
        .iter()
        .any(|state| state.id == gone.id));
    let moved = vault.store.physical_binding(&binary.id).unwrap().unwrap();
    assert_eq!(moved.physical.inode, binary_binding.physical.inode);
    assert_eq!(moved.state.path, path("after/data.bin"));
    let observations = vault.store.external_observations().unwrap();
    let exact: Vec<_> = observations
        .iter()
        .filter(|o| o.path == path("after/data.bin"))
        .collect();
    assert_eq!(
        exact.len(),
        1,
        "pending edit must not allocate a second observation"
    );
    assert_eq!(exact[0].observation_id, pending_id);
    assert_eq!(exact[0].resolution.as_ref(), Some(&pending_id));
    assert_eq!(
        exact[0].content,
        StoredContent::BinaryRef(BinarySourceRef::Capture(capture.clone()))
    );
    let retained = vault
        .open_capture_read(&capture.stage.client_id, &capture)
        .unwrap();
    assert_pin(&vault, &retained, 29);
    vault.close_binary_read(retained.reference()).unwrap();
    let current = vault
        .open_binary_read(&op("compound-reader"), &op("current"), &binary.id, None)
        .unwrap();
    assert_pin(&vault, &current, 29);
    vault.close_binary_read(current.reference()).unwrap();
    assert_file(&root.path().join("after/data.bin"), 29);
    assert_eq!(
        vault
            .store
            .import_family_namespace_observation(&prepared.observation_id)
            .unwrap(),
        *receipt
    );
    let status = vault.family_status().unwrap();
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let quiet = reconcile(&mut vault);
    assert!(
        quiet.namespace.is_empty() && quiet.imported.is_empty(),
        "{quiet:?}"
    );
    assert_eq!(vault.family_status().unwrap(), status);
    assert_eq!(
        vault
            .store
            .family_namespace_observation_result(&prepared.observation_id)
            .unwrap()
            .as_ref(),
        Some(receipt)
    );
    assert_file(&root.path().join("after/data.bin"), 29);
}
