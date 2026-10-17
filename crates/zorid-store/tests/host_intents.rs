mod common;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{
    HostIntentAcknowledgment, HostIntentRef, HostIntentState, HostRejectionCode, Store,
};
fn client() -> OperationId {
    OperationId::new("desktop").unwrap()
}
fn command() -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("operation").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("file").unwrap(),
            path: VaultPath::new("file.bin").unwrap(),
            kind: EntryKind::File,
            content: Some(vec![0, 255, 1]),
        },
    }
}
fn reference(view: &zorid_store::HostIntentView) -> HostIntentRef {
    HostIntentRef {
        client_id: view.client_id.clone(),
        token: view.token.clone(),
    }
}
#[test]
fn prepare_is_inert_owned_and_exactly_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let req = command();
    let before = store.list_snapshot().unwrap();
    let prepared = store.prepare_host_intent(&client(), &req).unwrap();
    let r = reference(&prepared);
    assert_eq!(prepared.state, HostIntentState::Prepared);
    assert_eq!(
        store.prepare_host_intent(&client(), &req).unwrap(),
        prepared
    );
    assert_eq!(store.list_snapshot().unwrap(), before);
    assert_eq!(store.pending_counts().unwrap(), (0, 0));
    assert!(store.apply(&req).is_err());
    let other = OperationId::new("other-client").unwrap();
    assert!(store.prepare_host_intent(&other, &req).is_err());
    assert!(store
        .query_host_intent(&HostIntentRef {
            client_id: other.clone(),
            token: r.token.clone()
        })
        .unwrap()
        .is_none());
    let wrong = HostIntentRef {
        client_id: other,
        token: r.token.clone(),
    };
    assert!(store.request_host_commit(&wrong).is_err());
    assert!(store
        .acknowledge_host_intent(
            &wrong,
            &HostIntentAcknowledgment::Rejected {
                operation_id: req.operation_id.clone(),
                code: HostRejectionCode::InvalidMutation
            }
        )
        .is_err());
    assert_eq!(store.query_host_intent(&r).unwrap().unwrap(), prepared);
    let mut altered = req.clone();
    if let Mutation::Create { content, .. } = &mut altered.mutation {
        *content = Some(vec![9]);
    }
    assert!(store.prepare_host_intent(&client(), &altered).is_err());
    assert!(store.apply(&altered).is_err());
    assert!(!serde_json::to_string(&prepared)
        .unwrap()
        .contains("content"));
    assert!(
        !serde_json::to_string(&store.list_host_intents(&client(), "0", 10).unwrap())
            .unwrap()
            .contains("request")
    );
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.query_host_intent(&r).unwrap().unwrap(), prepared);
    assert!(store.list().unwrap().is_empty());
}
#[test]
fn commit_requested_restart_attaches_receipt_atomically_and_ack_preserves_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let req = command();
    let r = reference(&store.prepare_host_intent(&client(), &req).unwrap());
    assert_eq!(store.request_host_commit(&r).unwrap(), req);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let persisted = store.request_host_commit(&r).unwrap();
    let receipt = store.apply(&persisted).unwrap();
    let outcome = store.query_host_intent(&r).unwrap().unwrap();
    assert_eq!(outcome.state, HostIntentState::Committed);
    assert_eq!(outcome.receipt, Some(receipt.clone()));
    let snapshot = store.list_snapshot().unwrap();
    assert_eq!(store.apply(&req).unwrap(), receipt);
    assert_eq!(store.list_snapshot().unwrap(), snapshot);
    assert!(store
        .acknowledge_host_intent(
            &r,
            &HostIntentAcknowledgment::Committed {
                operation_id: req.operation_id.clone(),
                sequence: "999".into()
            }
        )
        .is_err());
    let expected = HostIntentAcknowledgment::Committed {
        operation_id: req.operation_id.clone(),
        sequence: receipt.sequence.to_string(),
    };
    let ack = store.acknowledge_host_intent(&r, &expected).unwrap();
    assert!(ack.acknowledged);
    assert_eq!(ack.receipt, Some(receipt.clone()));
    assert_eq!(store.acknowledge_host_intent(&r, &expected).unwrap(), ack);
    assert_eq!(store.apply(&req).unwrap(), receipt);
}
#[test]
fn intent_receipt_failure_rolls_back_every_authority() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let req = command();
    let r = reference(&store.prepare_host_intent(&client(), &req).unwrap());
    store.request_host_commit(&r).unwrap();
    let before = store.list_snapshot().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER block_outcome BEFORE UPDATE OF state ON host_intents WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    assert!(store.apply(&req).is_err());
    assert_eq!(store.list_snapshot().unwrap(), before);
    assert!(store.replay(&req).unwrap().is_none());
    assert_eq!(
        store.query_host_intent(&r).unwrap().unwrap().state,
        HostIntentState::CommitRequested
    );
    assert_eq!(store.pending_counts().unwrap(), (0, 0));
}
#[test]
fn rejected_operation_fence_and_exact_ack_are_durable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let req = command();
    let r = reference(&store.prepare_host_intent(&client(), &req).unwrap());
    assert!(store
        .reject_host_intent(&r, HostRejectionCode::RevisionConflict)
        .is_err());
    assert!(store
        .acknowledge_host_intent(
            &r,
            &HostIntentAcknowledgment::Rejected {
                operation_id: req.operation_id.clone(),
                code: HostRejectionCode::RevisionConflict
            }
        )
        .is_err());
    store.request_host_commit(&r).unwrap();
    let rejected = store
        .reject_host_intent(&r, HostRejectionCode::RevisionConflict)
        .unwrap();
    assert_eq!(rejected.state, HostIntentState::Rejected);
    assert!(store.apply(&req).is_err());
    assert!(store.request_host_commit(&r).is_err());
    assert!(store
        .reject_host_intent(&r, HostRejectionCode::InvalidMutation)
        .is_err());
    let ack = HostIntentAcknowledgment::Rejected {
        operation_id: req.operation_id,
        code: HostRejectionCode::RevisionConflict,
    };
    assert!(
        store
            .acknowledge_host_intent(&r, &ack)
            .unwrap()
            .acknowledged
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert!(store.query_host_intent(&r).unwrap().unwrap().acknowledged);
    assert!(store.apply(&command()).is_err());
    assert!(store.list().unwrap().is_empty());
}
#[test]
fn old_exact_receipt_is_attached_only_on_commit_authorization() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("db")).unwrap();
    let req = command();
    let receipt = store.apply(&req).unwrap();
    let snapshot = store.list_snapshot().unwrap();
    let prepared = store.prepare_host_intent(&client(), &req).unwrap();
    assert!(prepared.receipt.is_none());
    let r = reference(&prepared);
    store.request_host_commit(&r).unwrap();
    assert_eq!(
        store.query_host_intent(&r).unwrap().unwrap().receipt,
        Some(receipt)
    );
    assert_eq!(store.list_snapshot().unwrap(), snapshot);
}
#[test]
fn v4_migration_and_corrupt_owned_request_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    Store::open(&path).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    common::downgrade_v6_to_v5(&db);
    db.execute_batch("DROP TABLE host_intents; PRAGMA user_version=4; PRAGMA journal_mode=DELETE;")
        .unwrap();
    drop(db);
    let mut store = Store::open(&path).unwrap();
    let r = reference(&store.prepare_host_intent(&client(), &command()).unwrap());
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE host_intents SET request=json_set(request,'$.mutation.id','other')",
        [],
    )
    .unwrap();
    assert!(store.request_host_commit(&r).is_err());
    assert!(store.list().unwrap().is_empty());
}

#[test]
fn competing_clients_cannot_both_own_global_operation_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    Store::open(&path).unwrap();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut workers = Vec::new();
    for client in ["desktop", "cli"] {
        let path = path.clone();
        let gate = gate.clone();
        workers.push(std::thread::spawn(move || {
            let mut store = Store::open(path).unwrap();
            gate.wait();
            store
                .prepare_host_intent(&OperationId::new(client).unwrap(), &command())
                .is_ok()
        }));
    }
    assert_eq!(
        workers
            .into_iter()
            .map(|w| usize::from(w.join().unwrap()))
            .sum::<usize>(),
        1
    );
}
#[test]
fn malformed_v4_rejected_before_journal_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    Store::open(&path).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    common::downgrade_v6_to_v5(&db);
    db.execute_batch("DROP TABLE host_intents; DROP INDEX live_paths; PRAGMA user_version=4; PRAGMA journal_mode=DELETE;").unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
}
