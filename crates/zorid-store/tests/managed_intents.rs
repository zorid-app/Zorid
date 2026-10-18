//! Real SQLite Store foundation. No native lease/product cutover or v2 catalog claim.
use zorid_records::{first_party as domain, Id};
use zorid_store::{
    FamilyScope, ManagedCollection, ManagedIntentDisposition as Disposition, ManagedIntentInput,
    ManagedIntentRef, ManagedIntentSettlement as Settlement, ManagedRegistration, ManagedTarget,
    Store,
};
use zorid_sync_protocol::{RealmId, VaultId};

fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn open(path: &std::path::Path) -> (Store, ManagedCollection) {
    let mut store = Store::open(path).unwrap();
    store
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("r").unwrap(),
            vault_id: VaultId::new("v").unwrap(),
        })
        .unwrap();
    let r = domain::registration(id("r"), id("v")).unwrap();
    let handle = store
        .managed_register(&ManagedRegistration {
            realm: r.realm,
            vault: r.vault,
            owner: r.owner,
            schema: r.schema,
        })
        .unwrap();
    (store, handle)
}
fn create(store: &Store, handle: &ManagedCollection, name: &str) -> ManagedIntentInput {
    let target = ManagedTarget {
        record: id(name),
        generation: id(name),
        restores: None,
    };
    let expected = store.managed_snapshot(handle, &target).unwrap().revision;
    ManagedIntentInput {
        target,
        operation: id(name),
        expected,
        command: domain::create(
            &domain::Range::new(1000, 2000, "UTC").unwrap(),
            Some("original".into()),
        )
        .unwrap(),
        semantic_request: None,
    }
}
fn counts(path: &std::path::Path) -> Vec<i64> {
    let db = rusqlite::Connection::open(path).unwrap();
    [
        "managed_records",
        "managed_operation_sources",
        "managed_changes",
        "managed_local_operations",
        "authored_envelopes",
        "operations",
    ]
    .iter()
    .map(|table| {
        db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    })
    .collect()
}
fn checkpoints(path: &std::path::Path) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row("SELECT count(*) FROM checkpoint_revisions", [], |r| {
            r.get(0)
        })
        .unwrap()
}

#[test]
fn capture_survives_reopen_without_domain_dispatch_and_rejects_changed_input() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "create");
    let before = counts(&path);
    let reference = store
        .managed_capture_intent(&handle, input.clone())
        .unwrap();
    assert_eq!(counts(&path), before);
    assert_eq!(checkpoints(&path), 1);
    assert_eq!(
        store
            .managed_capture_intent(&handle, input.clone())
            .unwrap(),
        reference
    );
    let mut changed = input.clone();
    changed.command = domain::create(
        &domain::Range::new(1000, 2000, "UTC").unwrap(),
        Some("changed".into()),
    )
    .unwrap();
    assert!(store.managed_capture_intent(&handle, changed).is_err());
    drop(store);
    let (mut store, current) = open(&path);
    assert!(store.managed_apply_intent(&handle, &reference).is_err());
    let pending = store.managed_pending_intents(&current, None, 32).unwrap();
    assert_eq!(pending.intents.len(), 1);
    assert_eq!(pending.intents[0].reference, reference);
    assert!(std::str::from_utf8(&pending.intents[0].request)
        .unwrap()
        .contains("origin_registration"));
    assert_eq!(
        store.managed_capture_intent(&current, input).unwrap(),
        reference
    );
    assert_eq!(counts(&path), before);
    assert_eq!(checkpoints(&path), 1);
}

#[test]
fn committed_patch_lost_ack_replays_original_receipt_and_settles_after_newer_state() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "create");
    let reference = store
        .managed_capture_intent(&handle, input.clone())
        .unwrap();
    let create_receipt = store.managed_apply_intent(&handle, &reference).unwrap();
    let patch = ManagedIntentInput {
        target: input.target.clone(),
        operation: id("patch"),
        expected: create_receipt.revision,
        command: domain::set_title(Some("patched".into())).unwrap(),
        semantic_request: None,
    };
    let patch_ref = store
        .managed_capture_intent(&handle, patch.clone())
        .unwrap();
    let original = store.managed_apply_intent(&handle, &patch_ref).unwrap();
    let newer = ManagedIntentInput {
        target: input.target,
        operation: id("newer"),
        expected: original.revision.clone(),
        command: domain::set_title(Some("newer".into())).unwrap(),
        semantic_request: None,
    };
    let newer_ref = store.managed_capture_intent(&handle, newer).unwrap();
    store.managed_apply_intent(&handle, &newer_ref).unwrap();
    let before = counts(&path);
    drop(store);
    let (mut store, handle) = open(&path);
    assert_eq!(
        store.managed_capture_intent(&handle, patch).unwrap(),
        patch_ref
    );
    assert_eq!(
        store.managed_apply_intent(&handle, &patch_ref).unwrap(),
        original
    );
    assert_eq!(
        store
            .managed_settle_intent(
                &handle,
                &patch_ref,
                &patch_ref.capture_revision,
                Disposition::ReconciledUncommitted
            )
            .unwrap(),
        Settlement::Committed {
            original_receipt: original.clone()
        }
    );
    let mut wrong = original.clone();
    wrong.sequence = "0001".into();
    assert!(store
        .managed_settle_intent(
            &handle,
            &patch_ref,
            &patch_ref.capture_revision,
            Disposition::AcknowledgedCommitted {
                original_receipt: wrong
            }
        )
        .is_err());
    let retired = store
        .managed_settle_intent(
            &handle,
            &patch_ref,
            &patch_ref.capture_revision,
            Disposition::AcknowledgedCommitted {
                original_receipt: original.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        store
            .managed_settle_intent(
                &handle,
                &patch_ref,
                &patch_ref.capture_revision,
                Disposition::AcknowledgedCommitted {
                    original_receipt: original.clone()
                }
            )
            .unwrap(),
        retired
    );
    assert_eq!(
        store.managed_apply_intent(&handle, &patch_ref).unwrap(),
        original
    );
    assert_eq!(counts(&path), before);
    assert_eq!(checkpoints(&path), 4);
}

#[test]
fn retirement_is_idempotent_frees_live_capacity_and_never_reuses_unknown_ids() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let before = counts(&path);
    let mut retained = Vec::new();
    for i in 0..32 {
        let input = create(&store, &handle, &format!("create-{i}"));
        let reference = store
            .managed_capture_intent(&handle, input.clone())
            .unwrap();
        retained.push((input, reference));
    }
    let overflow = create(&store, &handle, "overflow");
    assert!(store
        .managed_capture_intent(&handle, overflow.clone())
        .is_err());
    assert_eq!(checkpoints(&path), 32);
    assert_eq!(
        store
            .managed_pending_intents(&handle, None, 32)
            .unwrap()
            .intents
            .len(),
        32
    );
    for (input, reference) in retained {
        let retired = store
            .managed_settle_intent(
                &handle,
                &reference,
                &reference.capture_revision,
                Disposition::ReconciledUncommitted,
            )
            .unwrap();
        assert_eq!(
            store
                .managed_settle_intent(
                    &handle,
                    &reference,
                    &reference.capture_revision,
                    Disposition::ReconciledUncommitted
                )
                .unwrap(),
            retired
        );
        assert!(store.managed_capture_intent(&handle, input).is_err());
        assert!(store.managed_apply_intent(&handle, &reference).is_err());
    }
    assert!(store
        .managed_pending_intents(&handle, None, 32)
        .unwrap()
        .intents
        .is_empty());
    store.managed_capture_intent(&handle, overflow).unwrap();
    assert_eq!(checkpoints(&path), 65);
    assert_eq!(counts(&path), before);
}

#[test]
fn wrong_ref_head_store_and_receipt_have_zero_effects() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "create");
    let reference = store.managed_capture_intent(&handle, input).unwrap();
    let before = counts(&path);
    let wrong = ManagedIntentRef {
        operation: reference.operation.clone(),
        capture_revision: "00000000-0000-4000-8000-000000000001".into(),
    };
    assert!(store.managed_apply_intent(&handle, &wrong).is_err());
    assert!(store
        .managed_settle_intent(
            &handle,
            &wrong,
            &wrong.capture_revision,
            Disposition::ReconciledUncommitted
        )
        .is_err());
    assert!(store
        .managed_settle_intent(
            &handle,
            &reference,
            &wrong.capture_revision,
            Disposition::ReconciledUncommitted
        )
        .is_err());
    let (mut other, other_handle) = open(&temp.path().join("other.db"));
    assert!(other
        .managed_apply_intent(&other_handle, &reference)
        .is_err());
    assert!(other.managed_apply_intent(&handle, &reference).is_err());
    assert_eq!(counts(&path), before);
    assert_eq!(checkpoints(&path), 1);
}

#[test]
fn precommit_publication_failure_retains_original_pending_without_partial_domain_writes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "create");
    let reference = store.managed_capture_intent(&handle, input).unwrap();
    let before = counts(&path);
    let db = rusqlite::Connection::open(&path).unwrap();
    // Test-owned persistent trigger injects a real SQL abort after state/source work.
    db.execute_batch("CREATE TRIGGER reject_intent_journal BEFORE INSERT ON managed_local_operations BEGIN SELECT RAISE(ABORT,'injected journal failure'); END;").unwrap();
    assert!(store.managed_apply_intent(&handle, &reference).is_err());
    assert_eq!(counts(&path), before);
    assert_eq!(
        store
            .managed_pending_intents(&handle, None, 32)
            .unwrap()
            .intents[0]
            .reference,
        reference
    );
    db.execute_batch("DROP TRIGGER reject_intent_journal")
        .unwrap();
    assert!(store.managed_apply_intent(&handle, &reference).is_ok());
}

#[test]
fn corrupt_receipt_cannot_be_replayed_or_acknowledged() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "create");
    let reference = store.managed_capture_intent(&handle, input).unwrap();
    let receipt = store.managed_apply_intent(&handle, &reference).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("UPDATE managed_local_operations SET result=json_set(CAST(result AS TEXT),'$.unexpected',1)",[]).unwrap();
    assert!(store.managed_apply_intent(&handle, &reference).is_err());
    assert!(store
        .managed_settle_intent(
            &handle,
            &reference,
            &reference.capture_revision,
            Disposition::AcknowledgedCommitted {
                original_receipt: receipt
            }
        )
        .is_err());
    assert_eq!(checkpoints(&path), 1);
}

#[test]
fn apply_and_reconcile_race_preserves_explicit_committed_or_retired_outcome() {
    use std::sync::{Arc, Barrier};
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "race");
    let reference = store.managed_capture_intent(&handle, input).unwrap();
    drop(store);
    let barrier = Arc::new(Barrier::new(2));
    let other_barrier = barrier.clone();
    let other_path = path.clone();
    let other_ref = reference.clone();
    let thread = std::thread::spawn(move || {
        let (mut store, handle) = open(&other_path);
        other_barrier.wait();
        store.managed_apply_intent(&handle, &other_ref)
    });
    let (mut store, handle) = open(&path);
    barrier.wait();
    let settled = store
        .managed_settle_intent(
            &handle,
            &reference,
            &reference.capture_revision,
            Disposition::ReconciledUncommitted,
        )
        .unwrap();
    let applied = thread.join().unwrap();
    match settled {
        Settlement::Retired { .. } => {
            assert!(applied.is_err());
            assert_eq!(counts(&path)[3], 0);
            assert!(store.managed_apply_intent(&handle, &reference).is_err());
        }
        Settlement::Committed { original_receipt } => {
            assert_eq!(applied.unwrap(), original_receipt);
            assert_eq!(counts(&path)[3], 1);
            assert_eq!(checkpoints(&path), 1);
        }
    }
}

#[test]
fn semantic_capture_retains_exact_rust_request_and_observed_remove_tags() {
    use zorid_records::workblock_service::{self as service, WorkBlockCommand, WorkBlockRevision};
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "create");
    let reference = store
        .managed_capture_intent(&handle, input.clone())
        .unwrap();
    let receipt = store.managed_apply_intent(&handle, &reference).unwrap();
    let task = zorid_core::EntryId::new("00000000-0000-4000-8000-000000000009").unwrap();
    let add = ManagedIntentInput {
        target: input.target.clone(),
        operation: id("add"),
        expected: receipt.revision,
        command: domain::add_task(&task),
        semantic_request: None,
    };
    let add_ref = store.managed_capture_intent(&handle, add).unwrap();
    store.managed_apply_intent(&handle, &add_ref).unwrap();
    let snap = store.managed_snapshot(&handle, &input.target).unwrap();
    let state = zorid_records::State::restore(domain::schema(), snap.state.as_bytes()).unwrap();
    let expected: [u8; 32] =
        serde_json::from_value(serde_json::to_value(&snap.revision).unwrap()).unwrap();
    let semantic = WorkBlockCommand::RemoveRef {
        record: input.target.record.clone(),
        generation: input.target.generation.clone(),
        operation: id("remove"),
        expected_revision: WorkBlockRevision(expected),
        task: task.clone(),
    };
    let remove = ManagedIntentInput {
        target: input.target.clone(),
        operation: id("remove"),
        expected: snap.revision,
        command: service::command_for_new(&semantic, Some(&state)).unwrap(),
        semantic_request: Some(serde_json::to_vec(&semantic).unwrap()),
    };
    let remove_ref = store
        .managed_capture_intent(&handle, remove.clone())
        .unwrap();
    let removed = store.managed_apply_intent(&handle, &remove_ref).unwrap();
    let readd = ManagedIntentInput {
        target: input.target,
        operation: id("readd"),
        expected: removed.revision.clone(),
        command: domain::add_task(&task),
        semantic_request: None,
    };
    let readd_ref = store.managed_capture_intent(&handle, readd).unwrap();
    store.managed_apply_intent(&handle, &readd_ref).unwrap();
    assert_eq!(
        store.managed_capture_intent(&handle, remove).unwrap(),
        remove_ref
    );
    assert_eq!(
        store.managed_apply_intent(&handle, &remove_ref).unwrap(),
        removed
    );
}

#[test]
fn foreign_retirement_predecessor_cannot_fake_idempotent_settlement() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let a = create(&store, &handle, "a");
    let a = store.managed_capture_intent(&handle, a).unwrap();
    let b = create(&store, &handle, "b");
    let b = store.managed_capture_intent(&handle, b).unwrap();
    store
        .managed_settle_intent(
            &handle,
            &a,
            &a.capture_revision,
            Disposition::ReconciledUncommitted,
        )
        .unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE checkpoint_revisions SET expected_revision=?1 WHERE expected_revision=?2",
        rusqlite::params![b.capture_revision, a.capture_revision],
    )
    .unwrap();
    let forged = ManagedIntentRef {
        operation: a.operation,
        capture_revision: b.capture_revision,
    };
    assert!(store
        .managed_settle_intent(
            &handle,
            &forged,
            &forged.capture_revision,
            Disposition::ReconciledUncommitted
        )
        .is_err());
    assert!(store.managed_apply_intent(&handle, &forged).is_err());
    assert_eq!(counts(&path)[3], 0);
    assert_eq!(checkpoints(&path), 3);
}

#[test]
fn old_tuple_journal_explicitly_rejects_origin_reissue_without_changing_v1_adapter() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let input = create(&store, &handle, "old");
    let old = store
        .managed_apply(
            &handle,
            &input.target,
            input.operation.clone(),
            &input.expected,
            input.command.clone(),
        )
        .unwrap();
    assert_eq!(
        store
            .managed_apply(
                &handle,
                &input.target,
                input.operation.clone(),
                &input.expected,
                input.command.clone()
            )
            .unwrap(),
        old
    );
    let before = counts(&path);
    assert!(store.managed_capture_intent(&handle, input).is_err());
    assert_eq!(counts(&path), before);
    assert_eq!(checkpoints(&path), 0);
}

#[test]
fn retained_key_ceiling_rejects_new_capture_without_reusing_retired_keys() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("vault.db");
    let (mut store, handle) = open(&path);
    let scope = store
        .managed_snapshot(&handle, &create(&store, &handle, "template").target)
        .unwrap()
        .scope;
    let mut db = rusqlite::Connection::open(&path).unwrap();
    let tx = db.transaction().unwrap();
    // Construct only retired metadata, not domain records or forged live authority.
    // This reaches the historical bound without thousands of repetitive public writes.
    for n in 0..4096 {
        let key =
            zorid_records::local_intent::intent_checkpoint_key(&scope, &id(&format!("old-{n}")))
                .unwrap();
        let capture = uuid::Uuid::new_v4().to_string();
        let retire = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO checkpoint_revisions(client_id,checkpoint_key,revision,expected_revision,deleted,state_bytes) VALUES(?1,?2,?3,NULL,0,1)",rusqlite::params![zorid_records::local_intent::RESERVED_CHECKPOINT_CLIENT,key,capture]).unwrap();
        tx.execute("INSERT INTO checkpoint_revisions(client_id,checkpoint_key,revision,expected_revision,deleted,state_bytes) VALUES(?1,?2,?3,?4,1,0)",rusqlite::params![zorid_records::local_intent::RESERVED_CHECKPOINT_CLIENT,key,retire,capture]).unwrap();
        tx.execute("INSERT INTO checkpoint_heads(client_id,checkpoint_key,revision,encoded_state) VALUES(?1,?2,?3,NULL)",rusqlite::params![zorid_records::local_intent::RESERVED_CHECKPOINT_CLIENT,key,retire]).unwrap();
    }
    tx.commit().unwrap();
    let before = counts(&path);
    let input = create(&store, &handle, "new");
    assert!(store.managed_capture_intent(&handle, input).is_err());
    let old = create(&store, &handle, "old-0");
    assert!(store.managed_capture_intent(&handle, old).is_err());
    assert_eq!(counts(&path), before);
    assert_eq!(checkpoints(&path), 8192);
}
