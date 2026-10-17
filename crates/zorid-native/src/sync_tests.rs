use super::*;
use zorid_client_sync::{AuthenticatedText, ReceiveRequest, TextIdentity};
use zorid_core::{EntryKind, Mutation};
use zorid_crypto::VaultKey;
use zorid_sync_protocol::{ExpectedContext, RealmId, UpdateId, VaultId};
fn identity() -> TextIdentity {
    TextIdentity {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        entry_id: EntryId::new("file").unwrap(),
        bootstrap_id: UpdateId::new("bootstrap").unwrap(),
    }
}
fn create() -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("create").unwrap(),
        mutation: Mutation::Create {
            id: identity().entry_id,
            path: VaultPath::new("note.md").unwrap(),
            kind: EntryKind::File,
            content: Some(vec![]),
        },
    }
}
fn empty(vault: &mut NativeVault) {
    vault.apply(&create()).unwrap();
    let revision = vault
        .read(&identity().entry_id)
        .unwrap()
        .unwrap()
        .state
        .revision;
    vault.bind_empty_text(&identity(), &revision).unwrap();
}
fn authored(vault: &mut NativeVault, op: &str, bytes: &[u8]) -> (ExpectedContext, Vec<u8>) {
    let revision = vault
        .read(&identity().entry_id)
        .unwrap()
        .unwrap()
        .state
        .revision;
    vault
        .apply(&MutationRequest {
            operation_id: OperationId::new(op).unwrap(),
            mutation: Mutation::Write {
                id: identity().entry_id,
                expected: revision,
                content: bytes.to_vec(),
            },
        })
        .unwrap();
    let pending = vault.pending_authored_text(None, 100).unwrap();
    let update = pending.iter().find(|s| !s.sealed).unwrap();
    let context = ExpectedContext {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        update_id: update.update_id.clone(),
        key_epoch: 1,
    };
    let wire = vault
        .seal_authored_text(&context, &VaultKey::from_bytes([7; 32]))
        .unwrap();
    (context, wire)
}
fn receive(
    vault: &mut NativeVault,
    context: &ExpectedContext,
    wire: &[u8],
    next: &str,
) -> ReceiveOutcome {
    let incoming = AuthenticatedText::open(wire, context, &VaultKey::from_bytes([7; 32])).unwrap();
    let request = ReceiveRequest {
        expected_version: vault
            .text_state(&identity().entry_id)
            .unwrap()
            .unwrap()
            .version,
        next_version: Revision::new(next).unwrap(),
        delivery: None,
    };
    vault.receive_text(&incoming, &request).unwrap()
}
#[test]
fn native_received_commit_crash_child() {
    let Some(root) = std::env::var_os("ZORID_RECEIVE_CRASH_ROOT") else {
        return;
    };
    let wire = std::fs::read(std::path::Path::new(&root).join("wire.fixture")).unwrap();
    let context = ExpectedContext {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        update_id: UpdateId::new(std::env::var("ZORID_RECEIVE_UPDATE").unwrap()).unwrap(),
        key_epoch: 1,
    };
    let mut vault =
        NativeVault::open_existing(std::path::Path::new(&root).join("receiver")).unwrap();
    vault.fault = Some(|phase| {
        if phase == "received_committed" {
            std::process::exit(73)
        }
    });
    receive(&mut vault, &context, &wire, "received_after_crash");
    panic!("crash hook did not fire");
}
#[test]
fn received_commit_survives_process_exit_before_projection_without_authored_echo() {
    let dir = tempfile::tempdir().unwrap();
    let sender = dir.path().join("sender");
    let receiver = dir.path().join("receiver");
    std::fs::create_dir(&sender).unwrap();
    std::fs::create_dir(&receiver).unwrap();
    let mut a = NativeVault::open(&sender).unwrap();
    empty(&mut a);
    let mut b = NativeVault::open(&receiver).unwrap();
    empty(&mut b);
    drop(b);
    let (context, wire) = authored(&mut a, "write", b"remote content");
    std::fs::write(dir.path().join("wire.fixture"), &wire).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "sync_tests::native_received_commit_crash_child",
            "--nocapture",
        ])
        .env("ZORID_RECEIVE_CRASH_ROOT", dir.path())
        .env("ZORID_RECEIVE_UPDATE", context.update_id.as_str())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("receive crash child timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(73));
    assert_eq!(std::fs::read(receiver.join("note.md")).unwrap(), b"");
    let mut b = NativeVault::open_existing(&receiver).unwrap();
    assert_eq!(
        b.read(&identity().entry_id).unwrap().unwrap().content,
        Some(b"remote content".to_vec())
    );
    assert!(b.pending_authored_text(None, 100).unwrap().is_empty());
    let recovery = b.recover().unwrap();
    assert!(recovery.blocked.is_empty());
    assert_eq!(
        std::fs::read(receiver.join("note.md")).unwrap(),
        b"remote content"
    );
    let before = b.list_snapshot().unwrap();
    assert!(
        !receive(&mut b, &context, &wire, "duplicate_unused")
            .commit
            .changed
    );
    assert_eq!(b.list_snapshot().unwrap(), before);
}
#[test]
fn external_edit_while_stopped_merges_with_received_revision_and_publishes_both() {
    let dir = tempfile::tempdir().unwrap();
    let sender = dir.path().join("sender");
    let receiver = dir.path().join("receiver");
    std::fs::create_dir(&sender).unwrap();
    std::fs::create_dir(&receiver).unwrap();
    let mut a = NativeVault::open(&sender).unwrap();
    let mut b = NativeVault::open(&receiver).unwrap();
    empty(&mut a);
    empty(&mut b);
    let (context, wire) = authored(&mut a, "seed", b"base");
    receive(&mut b, &context, &wire, "seed");
    drop(b);
    std::fs::write(receiver.join("note.md"), b"local base").unwrap();
    let (context, wire) = authored(&mut a, "remote", b"base remote");
    let mut b = NativeVault::open_existing(&receiver).unwrap();
    let outcome = receive(&mut b, &context, &wire, "remote");
    assert!(matches!(outcome.projection, ProjectionStatus::Pending(_)));
    assert_eq!(
        std::fs::read(receiver.join("note.md")).unwrap(),
        b"local base"
    );
    let report = b.reconcile(&[VaultPath::new("note.md").unwrap()]).unwrap();
    assert_eq!(report.imported.len(), 1);
    assert!(report.projected.contains(&identity().entry_id));
    let recovered = b.recover().unwrap();
    assert!(recovered.blocked.is_empty(), "{:?}", recovered.blocked);
    assert_eq!(
        std::fs::read(receiver.join("note.md")).unwrap(),
        b"local base remote"
    );
    let pending = b.pending_authored_text(None, 100).unwrap();
    assert_eq!(pending.len(), 1);
    let context = ExpectedContext {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        update_id: pending[0].update_id.clone(),
        key_epoch: 1,
    };
    let wire = b
        .seal_authored_text(&context, &VaultKey::from_bytes([7; 32]))
        .unwrap();
    receive(&mut a, &context, &wire, "merged_from_peer");
    assert_eq!(
        std::fs::read(sender.join("note.md")).unwrap(),
        b"local base remote"
    );
    assert_eq!(
        a.read(&identity().entry_id).unwrap().unwrap().content,
        b.read(&identity().entry_id).unwrap().unwrap().content
    );
}
