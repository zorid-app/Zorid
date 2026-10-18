//! Native durable traces. Source-authored and not compiled in this worker.
//! Fresh disposable fixtures only; browser/mobile/runtime parity is separate.
use serde::Serialize;
use std::collections::BTreeMap;
use zorid_crypto::{OpenedEnvelope, SystemEntropy, VaultKey};
use zorid_records::wire::Payload;
use zorid_records::{
    Action, Cell, Command, Field, Id, Kind, Operation, Policy, Schema, Scope, State, Value,
};
use zorid_store::{
    FamilyCreateMode, FamilyScope, ManagedCollection, ManagedRegistration, ManagedSnapshot,
    ManagedTarget, Store,
};
use zorid_sync_protocol::{DeviceId, ExpectedContext, Header, RealmId, UpdateId, VaultId};

fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn family_scope() -> FamilyScope {
    FamilyScope {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
    }
}
fn registration(policy: Policy) -> ManagedRegistration {
    ManagedRegistration {
        realm: id("realm"),
        vault: id("vault"),
        owner: id("first-party"),
        schema: Schema {
            collection: id("synthetic"),
            version: 1,
            policy,
            fields: BTreeMap::from([
                (
                    id("title"),
                    Field {
                        kind: Kind::String,
                        required: false,
                        nullable: true,
                        default: None,
                    },
                ),
                (
                    id("members"),
                    Field {
                        kind: Kind::Set,
                        required: false,
                        nullable: false,
                        default: None,
                    },
                ),
            ]),
        },
    }
}
fn target() -> ManagedTarget {
    ManagedTarget {
        record: id("record"),
        generation: id("create"),
        restores: None,
    }
}
fn record_scope(target: &ManagedTarget) -> Scope {
    let r = registration(Policy::Synced);
    Scope {
        realm: r.realm,
        vault: r.vault,
        owner: r.owner,
        collection: r.schema.collection,
        record: target.record.clone(),
        generation: target.generation.clone(),
        restores: target.restores.clone(),
    }
}
fn write(text: &str) -> Vec<Action> {
    vec![Action::Write {
        field: id("title"),
        cell: Cell::Value(Value::String(text.into())),
    }]
}
fn setup(path: &std::path::Path, policy: Policy) -> (Store, ManagedCollection) {
    let mut store = Store::open(path).unwrap();
    store.family_enroll(&family_scope()).unwrap();
    let handle = store.managed_register(&registration(policy)).unwrap();
    (store, handle)
}
fn initial(store: &Store, handle: &ManagedCollection) -> ManagedSnapshot {
    store.managed_snapshot(handle, &target()).unwrap()
}
fn db(path: &std::path::Path) -> rusqlite::Connection {
    rusqlite::Connection::open(path).unwrap()
}
fn count(path: &std::path::Path, table: &str) -> i64 {
    // Only hardcoded test-owned table names call this helper.
    db(path)
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn status(path: &std::path::Path, update: &str) -> String {
    db(path)
        .query_row(
            "SELECT status FROM managed_receipts WHERE update_id=?1",
            [update],
            |r| r.get(0),
        )
        .unwrap()
}
#[derive(Serialize)]
struct Intent<'a> {
    format: u32,
    scope: &'a Scope,
    operations: &'a [Operation],
}
fn payload(update: &str, scope: &Scope, operations: &[Operation]) -> Payload {
    Payload::from_intent(
        id(update),
        &serde_json::to_vec(&Intent {
            format: 1,
            scope,
            operations,
        })
        .unwrap(),
    )
    .unwrap()
}
fn operation(name: &str, scope: &Scope, parents: &[&str], command: Command) -> Operation {
    Operation {
        id: id(name),
        scope: scope.clone(),
        parents: parents.iter().map(|s| id(s)).collect(),
        schema_version: 1,
        command,
    }
}
fn key() -> VaultKey {
    VaultKey::from_bytes([17; 32])
}
fn wire(payload: &Payload) -> (ExpectedContext, Vec<u8>) {
    let expected = ExpectedContext {
        realm_id: RealmId::new(payload.scope().realm.as_str()).unwrap(),
        vault_id: VaultId::new(payload.scope().vault.as_str()).unwrap(),
        update_id: UpdateId::new(payload.id().as_str()).unwrap(),
        key_epoch: 1,
    };
    let header = Header::new(
        expected.realm_id.clone(),
        expected.vault_id.clone(),
        expected.update_id.clone(),
        DeviceId::new("fixture-origin").unwrap(),
        1,
    )
    .unwrap();
    let bytes = zorid_crypto::seal(
        &header,
        &payload.encode().unwrap(),
        &key(),
        &mut SystemEntropy,
    )
    .unwrap()
    .encode();
    (expected, bytes)
}
fn receive(
    store: &mut Store,
    packet: &(ExpectedContext, Vec<u8>),
) -> zorid_store::FamilyReceiveCommit {
    store
        .family_receive(
            &OpenedEnvelope::open(&packet.1, &packet.0, &key()).unwrap(),
            None,
        )
        .unwrap()
}
fn history(snapshot: &ManagedSnapshot) -> State {
    State::restore(
        registration(Policy::Synced).schema,
        snapshot.state.as_bytes(),
    )
    .unwrap()
}

#[test]
fn local_exact_replay_survives_reopen_and_does_not_repeat_change_or_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let before = initial(&store, &handle);
    let result = store
        .managed_apply(
            &handle,
            &target(),
            id("create"),
            &before.revision,
            Command::Create(write("one")),
        )
        .unwrap();
    assert_eq!(
        store
            .managed_apply(
                &handle,
                &target(),
                id("create"),
                &before.revision,
                Command::Create(write("one"))
            )
            .unwrap(),
        result
    );
    assert!(store
        .managed_apply(
            &handle,
            &target(),
            id("create"),
            &before.revision,
            Command::Create(write("two"))
        )
        .is_err());
    drop(store);
    let (mut store, handle) = setup(&path, Policy::Synced);
    assert_eq!(
        store
            .managed_apply(
                &handle,
                &target(),
                id("create"),
                &before.revision,
                Command::Create(write("one"))
            )
            .unwrap(),
        result
    );
    assert_eq!(count(&path, "managed_changes"), 1);
    assert_eq!(count(&path, "authored_envelopes"), 1);
    assert_eq!(count(&path, "immutable_payloads"), 1);
    assert_eq!(history(&initial(&store, &handle)).history().len(), 1);
}
#[test]
fn local_and_cache_never_create_immutable_sync_sources_or_authored_work() {
    for policy in [Policy::Local, Policy::Cache] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store");
        let (mut store, handle) = setup(&path, policy);
        let before = initial(&store, &handle);
        store
            .managed_apply(
                &handle,
                &target(),
                id("create"),
                &before.revision,
                Command::Create(write("private")),
            )
            .unwrap();
        assert_eq!(count(&path, "authored_envelopes"), 0);
        assert_eq!(count(&path, "immutable_payloads"), 0);
        assert_eq!(count(&path, "sync_envelopes"), 0);
        assert!(store.family_pending_authored(None, 64).unwrap().is_empty());
        assert_eq!(
            store
                .managed_changes(&handle, "0", 1)
                .unwrap()
                .changes
                .len(),
            1
        );
    }
}
#[test]
fn handles_bind_store_instance_and_exact_registration_revision() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a");
    let (mut a, handle) = setup(&path, Policy::Synced);
    let (b, _) = setup(&dir.path().join("b"), Policy::Synced);
    assert!(b.managed_snapshot(&handle, &target()).is_err());
    let mut next = registration(Policy::Synced);
    next.schema.version = 2;
    a.managed_register(&next).unwrap();
    assert!(a.managed_snapshot(&handle, &target()).is_err());
    drop(a);
    let a = Store::open(&path).unwrap();
    assert!(a.managed_snapshot(&handle, &target()).is_err());
}
#[test]
fn local_change_failpoint_rolls_back_state_projection_sources_and_outbox_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let before = initial(&store, &handle);
    db(&path).execute_batch("CREATE TRIGGER managed_test_abort BEFORE INSERT ON managed_changes BEGIN SELECT RAISE(ABORT,'fixture interrupted commit'); END").unwrap();
    assert!(store
        .managed_apply(
            &handle,
            &target(),
            id("create"),
            &before.revision,
            Command::Create(write("retained caller draft"))
        )
        .is_err());
    drop(store);
    db(&path)
        .execute_batch("DROP TRIGGER managed_test_abort")
        .unwrap();
    let (mut store, handle) = setup(&path, Policy::Synced);
    assert_eq!(initial(&store, &handle), before);
    for table in [
        "managed_records",
        "managed_operation_sources",
        "managed_local_operations",
        "authored_envelopes",
        "immutable_payloads",
    ] {
        assert_eq!(count(&path, table), 0, "{table}");
    }
    store
        .managed_apply(
            &handle,
            &target(),
            id("create"),
            &before.revision,
            Command::Create(write("retained caller draft")),
        )
        .unwrap();
}
#[test]
fn dependency_before_create_is_unresolved_and_restart_retry_keeps_accepted_state_complete() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let child = operation("child", &scope, &["create"], Command::Patch(write("child")));
    receive(
        &mut store,
        &wire(&payload("child-envelope", &scope, &[child])),
    );
    assert_eq!(status(&path, "child-envelope"), "waiting_dependencies");
    assert!(history(&initial(&store, &handle)).history().is_empty());
    let parent = operation("create", &scope, &[], Command::Create(write("parent")));
    receive(
        &mut store,
        &wire(&payload("parent-envelope", &scope, &[parent])),
    );
    drop(store);
    let (mut store, handle) = setup(&path, Policy::Synced);
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(status(&path, "child-envelope"), "accepted");
    let state = history(&initial(&store, &handle));
    assert_eq!(state.history().len(), 2);
    assert!(state.projection().unwrap().pending.is_empty());
    assert_eq!(count(&path, "authored_envelopes"), 0);
}
#[test]
fn invalid_waiting_child_cannot_poison_valid_parent_and_status_changes_are_once_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let invalid = operation(
        "child",
        &scope,
        &["create"],
        Command::Patch(vec![Action::Remove {
            field: id("members"),
            member: id("a"),
            tags: vec![id("nonexistent-add")],
        }]),
    );
    receive(
        &mut store,
        &wire(&payload("child-envelope", &scope, &[invalid])),
    );
    let parent = operation(
        "create",
        &scope,
        &[],
        Command::Create(write("valid parent")),
    );
    receive(
        &mut store,
        &wire(&payload("parent-envelope", &scope, &[parent])),
    );
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(status(&path, "child-envelope"), "invalid_operation");
    assert_eq!(history(&initial(&store, &handle)).history().len(), 1);
    let before = count(&path, "managed_changes");
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(count(&path, "managed_changes"), before);
}
#[test]
fn operation_equivocation_quarantines_both_waiting_forks_and_retains_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    for (envelope, value) in [("fork-a", "a"), ("fork-b", "b")] {
        let child = operation(
            "same-child",
            &scope,
            &["create"],
            Command::Patch(write(value)),
        );
        receive(&mut store, &wire(&payload(envelope, &scope, &[child])));
    }
    assert_eq!(status(&path, "fork-a"), "integrity_conflict");
    assert_eq!(status(&path, "fork-b"), "integrity_conflict");
    let parent = operation("create", &scope, &[], Command::Create(write("parent")));
    receive(&mut store, &wire(&payload("parent", &scope, &[parent])));
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    let snapshot = initial(&store, &handle);
    assert_eq!(snapshot.unresolved.get("integrity_conflict").unwrap(), "2");
    assert_eq!(history(&snapshot).history().len(), 1);
    assert_eq!(count(&path, "managed_operation_sources"), 3);
}
#[test]
fn exact_wire_duplicate_is_silent_and_same_envelope_different_ciphertext_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, _) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let p = payload(
        "envelope",
        &scope,
        &[operation(
            "create",
            &scope,
            &[],
            Command::Create(write("one")),
        )],
    );
    let first = wire(&p);
    assert!(!receive(&mut store, &first).duplicate);
    let changes = count(&path, "managed_changes");
    assert!(receive(&mut store, &first).duplicate);
    assert_eq!(count(&path, "managed_changes"), changes);
    let other = wire(&p);
    assert_ne!(first.1, other.1);
    let opened = OpenedEnvelope::open(&other.1, &other.0, &key()).unwrap();
    assert!(store.family_receive(&opened, None).is_err());
    assert_eq!(count(&path, "sync_envelopes"), 1);
    assert_eq!(count(&path, "managed_changes"), changes);
}
#[test]
fn missing_registration_and_future_schema_recover_from_exact_retained_payload() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let mut store = Store::open(&path).unwrap();
    store.family_enroll(&family_scope()).unwrap();
    let scope = record_scope(&target());
    let mut op = operation("create", &scope, &[], Command::Create(write("future")));
    op.schema_version = 2;
    receive(&mut store, &wire(&payload("future", &scope, &[op])));
    assert_eq!(status(&path, "future"), "missing_registration");
    let handle = store
        .managed_register(&registration(Policy::Synced))
        .unwrap();
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(status(&path, "future"), "incompatible_schema");
    assert!(initial(&store, &handle).state.contains("\"operations\":[]"));
    let mut r = registration(Policy::Synced);
    r.schema.version = 2;
    let handle = store.managed_register(&r).unwrap();
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(status(&path, "future"), "accepted");
    assert_eq!(count(&path, "immutable_payloads"), 1);
}
#[test]
fn incoming_synced_payload_cannot_convert_a_local_collection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Local);
    let scope = record_scope(&target());
    let parent = operation("create", &scope, &[], Command::Create(write("remote")));
    receive(&mut store, &wire(&payload("remote", &scope, &[parent])));
    assert_eq!(status(&path, "remote"), "policy_mismatch");
    assert!(history(&initial(&store, &handle)).history().is_empty());
    assert!(store
        .managed_register(&registration(Policy::Synced))
        .is_err());
    assert_eq!(count(&path, "authored_envelopes"), 0);
}
#[test]
fn local_restore_requires_same_record_committed_tombstone_and_unique_generation_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let restored = ManagedTarget {
        generation: id("restored"),
        restores: Some(id("create")),
        ..target()
    };
    let before = store.managed_snapshot(&handle, &restored).unwrap();
    assert!(store
        .managed_apply(
            &handle,
            &restored,
            id("restored"),
            &before.revision,
            Command::Create(write("restored"))
        )
        .is_err());
    let initial = initial(&store, &handle);
    store
        .managed_apply(
            &handle,
            &target(),
            id("create"),
            &initial.revision,
            Command::Create(write("original")),
        )
        .unwrap();
    let live = store.managed_snapshot(&handle, &target()).unwrap();
    store
        .managed_apply(
            &handle,
            &target(),
            id("delete"),
            &live.revision,
            Command::Delete,
        )
        .unwrap();
    store
        .managed_apply(
            &handle,
            &restored,
            id("restored"),
            &before.revision,
            Command::Create(write("restored")),
        )
        .unwrap();
    let altered = ManagedTarget {
        restores: None,
        ..restored
    };
    assert!(store.managed_snapshot(&handle, &altered).is_err());
    assert_eq!(count(&path, "managed_records"), 2);
}
#[test]
fn remote_restore_waits_for_prior_tombstone_then_retries_without_early_publication() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let restored = ManagedTarget {
        generation: id("restored"),
        restores: Some(id("create")),
        ..target()
    };
    let scope = record_scope(&restored);
    let op = operation("restored", &scope, &[], Command::Create(write("restored")));
    receive(
        &mut store,
        &wire(&payload("restored-envelope", &scope, &[op])),
    );
    assert_eq!(status(&path, "restored-envelope"), "waiting_restore_source");
    assert_eq!(count(&path, "managed_records"), 0);
    let old_scope = record_scope(&target());
    let create = operation("create", &old_scope, &[], Command::Create(write("old")));
    let delete = operation("delete", &old_scope, &["create"], Command::Delete);
    receive(
        &mut store,
        &wire(&payload("old-deleted", &old_scope, &[create, delete])),
    );
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(status(&path, "restored-envelope"), "accepted");
    assert!(store
        .managed_snapshot(&handle, &restored)
        .unwrap()
        .projection["created"]
        .as_bool()
        .unwrap());
}
#[test]
fn received_receipt_failpoint_preserves_shared_cursor_and_all_state_on_reopen() {
    use zorid_client_sync::{CursorAdvance, ReceiveCursor};
    use zorid_sync_protocol::{LogPosition, ServerEpoch};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, _) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let packet = wire(&payload(
        "remote",
        &scope,
        &[operation(
            "create",
            &scope,
            &[],
            Command::Create(write("one")),
        )],
    ));
    let start = ReceiveCursor {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        server_epoch: ServerEpoch::new("epoch").unwrap(),
        after: LogPosition::new(0),
    };
    store.family_set_receive_cursor(None, &start).unwrap();
    let advance = CursorAdvance {
        expected: start.clone(),
        next: ReceiveCursor {
            after: LogPosition::new(1),
            ..start.clone()
        },
    };
    db(&path).execute_batch("CREATE TRIGGER managed_test_abort BEFORE INSERT ON managed_receipts BEGIN SELECT RAISE(ABORT,'fixture interrupted receive'); END").unwrap();
    let opened = OpenedEnvelope::open(&packet.1, &packet.0, &key()).unwrap();
    assert!(store.family_receive(&opened, Some(&advance)).is_err());
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store
            .family_receive_cursor(&start.realm_id, &start.vault_id)
            .unwrap(),
        Some(start)
    );
    for table in [
        "sync_envelopes",
        "immutable_payloads",
        "managed_records",
        "managed_changes",
        "managed_operation_sources",
        "managed_receipts",
    ] {
        assert_eq!(count(&path, table), 0, "{table}");
    }
    db(&path)
        .execute_batch("DROP TRIGGER managed_test_abort")
        .unwrap();
    store.family_receive(&opened, Some(&advance)).unwrap();
    assert_eq!(
        store
            .family_receive_cursor(&advance.next.realm_id, &advance.next.vault_id)
            .unwrap(),
        Some(advance.next)
    );
}
#[test]
fn encrypted_file_and_record_traffic_share_one_cursor_and_no_authored_echo() {
    use zorid_client_sync::{CursorAdvance, ReceiveCursor};
    use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
    use zorid_sync_protocol::{LogPosition, ServerEpoch};
    let dir = tempfile::tempdir().unwrap();
    let (mut a, ah) = setup(&dir.path().join("a"), Policy::Synced);
    let bpath = dir.path().join("b");
    let (mut b, bh) = setup(&bpath, Policy::Synced);
    let before = initial(&a, &ah);
    a.managed_apply(
        &ah,
        &target(),
        id("create"),
        &before.revision,
        Command::Create(write("record")),
    )
    .unwrap();
    a.family_apply(
        &MutationRequest {
            operation_id: OperationId::new("file-create").unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new("file").unwrap(),
                path: VaultPath::new("note.md").unwrap(),
                kind: EntryKind::File,
                content: Some(b"file".to_vec()),
            },
        },
        Some(FamilyCreateMode::Text),
    )
    .unwrap();
    let mut cursor = ReceiveCursor {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        server_epoch: ServerEpoch::new("epoch").unwrap(),
        after: LogPosition::new(0),
    };
    b.family_set_receive_cursor(None, &cursor).unwrap();
    for (index, item) in a
        .family_pending_authored(None, 64)
        .unwrap()
        .into_iter()
        .enumerate()
    {
        let expected = ExpectedContext {
            realm_id: item.scope.realm_id,
            vault_id: item.scope.vault_id,
            update_id: item.update_id,
            key_epoch: 1,
        };
        let bytes = a.family_seal(&expected, &key()).unwrap();
        let opened = OpenedEnvelope::open(&bytes, &expected, &key()).unwrap();
        let next = ReceiveCursor {
            after: LogPosition::new(index as u64 + 1),
            ..cursor.clone()
        };
        b.family_receive(
            &opened,
            Some(&CursorAdvance {
                expected: cursor,
                next: next.clone(),
            }),
        )
        .unwrap();
        cursor = next;
    }
    assert_eq!(
        a.managed_snapshot(&ah, &target()).unwrap().state,
        b.managed_snapshot(&bh, &target()).unwrap().state
    );
    assert_eq!(
        b.read(&EntryId::new("file").unwrap())
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        b"file"
    );
    assert_eq!(
        b.family_receive_cursor(&cursor.realm_id, &cursor.vault_id)
            .unwrap(),
        Some(cursor)
    );
    assert_eq!(count(&bpath, "authored_envelopes"), 0);
}
#[test]
fn bounded_pages_reject_noncanonical_sequences_and_changes_catch_up_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let before = initial(&store, &handle);
    store
        .managed_apply(
            &handle,
            &target(),
            id("create"),
            &before.revision,
            Command::Create(write("one")),
        )
        .unwrap();
    let now = initial(&store, &handle);
    store
        .managed_apply(
            &handle,
            &target(),
            id("patch"),
            &now.revision,
            Command::Patch(write("two")),
        )
        .unwrap();
    drop(store);
    let (store, handle) = setup(&path, Policy::Synced);
    for after in ["-1", "01", "+1", "1.0", "18446744073709551616"] {
        assert!(store.managed_changes(&handle, after, 1).is_err());
    }
    assert!(store.managed_changes(&handle, "0", 0).is_err());
    assert!(store.managed_export(&handle, None, 65).is_err());
    let first = store.managed_changes(&handle, "0", 1).unwrap();
    let second = store.managed_changes(&handle, &first.next, 1).unwrap();
    assert_eq!(first.changes.len(), 1);
    assert_eq!(second.changes.len(), 1);
    assert_ne!(first.next, second.next);
    assert_eq!(
        store.managed_export(&handle, None, 1).unwrap().records[0].state,
        initial(&store, &handle).state
    );
}
#[test]
fn exhausted_change_quota_aborts_new_receipt_instead_of_acknowledging_lost_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, _) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    // Populate the finite notification history without constructing 65k crypto
    // envelopes. These are valid retained status rows in a disposable fixture.
    db(&path).execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<65536) INSERT INTO managed_changes(collection_key,record_key,update_id,status) SELECT 'quota-fixture','record','retained-'||x,'accepted' FROM n").unwrap();
    let packet = wire(&payload(
        "new",
        &scope,
        &[operation(
            "create",
            &scope,
            &[],
            Command::Create(write("one")),
        )],
    ));
    let opened = OpenedEnvelope::open(&packet.1, &packet.0, &key()).unwrap();
    assert!(store.family_receive(&opened, None).is_err());
    drop(store);
    let _store = Store::open(&path).unwrap();
    assert_eq!(count(&path, "managed_changes"), 65536);
    for table in [
        "sync_envelopes",
        "immutable_payloads",
        "managed_records",
        "managed_receipts",
        "managed_operation_sources",
    ] {
        assert_eq!(count(&path, table), 0, "{table}");
    }
}

#[test]
fn persisted_retry_continuation_reaches_ready_work_beyond_sixteen_blocked_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, _handle) = setup(&path, Policy::Synced);
    for index in 0..20 {
        let mut scope = record_scope(&target());
        scope.record = id(&format!("blocked-record-{index}"));
        scope.generation = id(&format!("missing-root-{index}"));
        let op = operation(
            &format!("blocked-op-{index}"),
            &scope,
            &[scope.generation.as_str()],
            Command::Patch(write("blocked")),
        );
        receive(
            &mut store,
            &wire(&payload(&format!("blocked-{index:02}"), &scope, &[op])),
        );
    }
    let scope = record_scope(&target());
    let ready = operation(
        "ready-child",
        &scope,
        &["create"],
        Command::Patch(write("ready")),
    );
    receive(&mut store, &wire(&payload("zz-ready", &scope, &[ready])));
    let parent = operation("create", &scope, &[], Command::Create(write("parent")));
    receive(&mut store, &wire(&payload("parent", &scope, &[parent])));
    // Parent arrival consumes one bounded pass over the blocked prefix. Its
    // durable continuation survives restart instead of restarting at blocked-00.
    assert_eq!(status(&path, "zz-ready"), "waiting_dependencies");
    drop(store);
    let mut store = Store::open(&path).unwrap();
    // Exact registration must preserve the persisted continuation. Registration
    // itself resumes a pass; a further startup pass is safe and bounded.
    let handle = store
        .managed_register(&registration(Policy::Synced))
        .unwrap();
    let page = store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert!(page.examined <= 16);
    assert!(page.bytes <= 1024 * 1024);
    assert_eq!(status(&path, "zz-ready"), "accepted");
    assert_eq!(history(&initial(&store, &handle)).history().len(), 2);
}

#[test]
fn retry_byte_budget_stops_before_unexamined_row_and_resumes_without_status_spam() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    for index in 0..3 {
        let mut scope = record_scope(&target());
        scope.record = id(&format!("large-record-{index}"));
        scope.generation = id(&format!("large-root-{index}"));
        let actions = (0..40)
            .map(|n| Action::Write {
                field: id(&format!("field-{n}")),
                cell: Cell::Value(Value::String("v".repeat(12000))),
            })
            .collect();
        let op = operation(
            &format!("large-child-{index}"),
            &scope,
            &[scope.generation.as_str()],
            Command::Patch(actions),
        );
        receive(
            &mut store,
            &wire(&payload(&format!("large-{index}"), &scope, &[op])),
        );
    }
    let changes = count(&path, "managed_changes");
    let first = store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(first.examined, 2);
    assert!(!first.exhausted);
    assert_eq!(first.next.as_deref(), Some("large-1"));
    assert!(first.bytes <= 1024 * 1024);
    let second = store
        .managed_retry_unresolved(&handle, first.next.as_deref(), 16)
        .unwrap();
    assert_eq!(second.examined, 1);
    assert!(second.exhausted);
    assert_eq!(second.next.as_deref(), Some("large-2"));
    assert_eq!(count(&path, "managed_changes"), changes);
    assert_eq!(count(&path, "managed_records"), 0);
}

#[test]
fn late_exact_local_replay_returns_original_receipt_after_other_authorship() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let before = initial(&store, &handle);
    let original = store
        .managed_apply(
            &handle,
            &target(),
            id("create"),
            &before.revision,
            Command::Create(write("one")),
        )
        .unwrap();
    let current = initial(&store, &handle);
    store
        .managed_apply(
            &handle,
            &target(),
            id("patch"),
            &current.revision,
            Command::Patch(write("two")),
        )
        .unwrap();
    drop(store);
    let (mut store, handle) = setup(&path, Policy::Synced);
    let before_replay = initial(&store, &handle);
    let changes = count(&path, "managed_changes");
    assert_eq!(
        store
            .managed_apply(
                &handle,
                &target(),
                id("create"),
                &before.revision,
                Command::Create(write("one"))
            )
            .unwrap(),
        original
    );
    assert_eq!(initial(&store, &handle), before_replay);
    assert_eq!(count(&path, "managed_changes"), changes);
}

#[test]
fn wrong_authenticated_plaintext_identity_and_unknown_wire_version_make_no_progress() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, _) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let p = payload(
        "payload-id",
        &scope,
        &[operation(
            "create",
            &scope,
            &[],
            Command::Create(write("one")),
        )],
    );
    let expected = ExpectedContext {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        update_id: UpdateId::new("header-id").unwrap(),
        key_epoch: 1,
    };
    let header = Header::new(
        expected.realm_id.clone(),
        expected.vault_id.clone(),
        expected.update_id.clone(),
        DeviceId::new("fixture").unwrap(),
        1,
    )
    .unwrap();
    let bytes = zorid_crypto::seal(&header, &p.encode().unwrap(), &key(), &mut SystemEntropy)
        .unwrap()
        .encode();
    let opened = OpenedEnvelope::open(&bytes, &expected, &key()).unwrap();
    assert!(store.family_receive(&opened, None).is_err());
    // A known family with an unknown semantic format is rejected before receipt.
    let mut unknown = String::from_utf8(p.encode().unwrap()).unwrap();
    unknown = unknown.replacen("\"format_version\":1", "\"format_version\":99", 1);
    let bytes = zorid_crypto::seal(&header, unknown.as_bytes(), &key(), &mut SystemEntropy)
        .unwrap()
        .encode();
    let opened = OpenedEnvelope::open(&bytes, &expected, &key()).unwrap();
    assert!(store.family_receive(&opened, None).is_err());
    for table in [
        "sync_envelopes",
        "managed_receipts",
        "managed_changes",
        "immutable_payloads",
    ] {
        assert_eq!(count(&path, table), 0, "{table}");
    }
}

#[test]
fn operation_identity_is_scoped_to_record_generation_not_whole_collection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    for (record, value) in [("record-a", "a"), ("record-b", "b")] {
        let scope = record_scope(&ManagedTarget {
            record: id(record),
            ..target()
        });
        let op = operation("create", &scope, &[], Command::Create(write(value)));
        receive(
            &mut store,
            &wire(&payload(&format!("envelope-{record}"), &scope, &[op])),
        );
        assert_eq!(status(&path, &format!("envelope-{record}")), "accepted");
    }
    let page = store.managed_export(&handle, None, 64).unwrap();
    assert_eq!(page.records.len(), 2);
    assert!(page
        .records
        .iter()
        .all(|record| record.unresolved.is_empty()));
    assert_ne!(page.records[0].state, page.records[1].state);
    assert_eq!(count(&path, "managed_operation_sources"), 2);
}

#[test]
fn co_packaged_semantically_invalid_batch_retains_receipt_without_partial_parent_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let create = operation(
        "create",
        &scope,
        &[],
        Command::Create(write("valid parent")),
    );
    let child = operation(
        "bad-child",
        &scope,
        &["create"],
        Command::Patch(vec![Action::Remove {
            field: id("members"),
            member: id("a"),
            tags: vec![id("missing-add")],
        }]),
    );
    receive(
        &mut store,
        &wire(&payload("invalid-batch", &scope, &[create, child])),
    );
    assert_eq!(status(&path, "invalid-batch"), "invalid_operation");
    assert!(history(&initial(&store, &handle)).history().is_empty());
    assert_eq!(count(&path, "sync_envelopes"), 1);
    let before = count(&path, "managed_changes");
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(count(&path, "managed_changes"), before);
}

#[test]
fn receipt_byte_quota_rejects_without_advancing_shared_cursor_or_losing_prior_receipts() {
    use zorid_client_sync::{CursorAdvance, ReceiveCursor};
    use zorid_sync_protocol::{LogPosition, ServerEpoch};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, _) = setup(&path, Policy::Synced);
    let mut cursor = ReceiveCursor {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        server_epoch: ServerEpoch::new("epoch").unwrap(),
        after: LogPosition::new(0),
    };
    store.family_set_receive_cursor(None, &cursor).unwrap();
    let mut successes = 0;
    let mut exhausted = false;
    for index in 0..40 {
        let mut scope = record_scope(&target());
        scope.record = id(&format!("quota-record-{index}"));
        scope.generation = id(&format!("quota-root-{index}"));
        let actions = (0..40)
            .map(|n| Action::Write {
                field: id(&format!("field-{n}")),
                cell: Cell::Value(Value::String("v".repeat(12000))),
            })
            .collect();
        let op = operation(
            &format!("quota-child-{index}"),
            &scope,
            &[scope.generation.as_str()],
            Command::Patch(actions),
        );
        let packet = wire(&payload(&format!("quota-envelope-{index}"), &scope, &[op]));
        let opened = OpenedEnvelope::open(&packet.1, &packet.0, &key()).unwrap();
        let next = ReceiveCursor {
            after: LogPosition::new(index + 1),
            ..cursor.clone()
        };
        let before = count(&path, "managed_changes");
        if store
            .family_receive(
                &opened,
                Some(&CursorAdvance {
                    expected: cursor.clone(),
                    next: next.clone(),
                }),
            )
            .is_err()
        {
            assert_eq!(count(&path, "managed_changes"), before);
            exhausted = true;
            break;
        }
        cursor = next;
        successes += 1;
    }
    assert!(exhausted);
    assert!(successes > 16);
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store
            .family_receive_cursor(&cursor.realm_id, &cursor.vault_id)
            .unwrap(),
        Some(cursor)
    );
    assert_eq!(count(&path, "managed_receipts"), successes);
    assert_eq!(count(&path, "sync_envelopes"), successes);
    assert_eq!(count(&path, "immutable_payloads"), successes);
    assert_eq!(count(&path, "managed_records"), 0);
}
