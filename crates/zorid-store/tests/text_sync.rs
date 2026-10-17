mod common;
use zorid_client_sync::{
    AuthenticatedText, CursorAdvance, ReceiveCursor, ReceiveRequest, TextIdentity,
};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, Revision, VaultPath};
use zorid_crypto::VaultKey;
use zorid_store::{ChangeOrigin, ProjectionOrigin, ProjectionPhase, Store};
use zorid_sync_protocol::{ExpectedContext, LogPosition, RealmId, ServerEpoch, UpdateId, VaultId};
fn identity() -> TextIdentity {
    TextIdentity {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        entry_id: EntryId::new("file").unwrap(),
        bootstrap_id: UpdateId::new("bootstrap").unwrap(),
    }
}
fn create(bytes: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("create").unwrap(),
        mutation: Mutation::Create {
            id: identity().entry_id,
            path: VaultPath::new("note.md").unwrap(),
            kind: EntryKind::File,
            content: Some(bytes.to_vec()),
        },
    }
}
fn write(store: &Store, op: &str, bytes: &[u8]) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(op).unwrap(),
        mutation: Mutation::Write {
            id: identity().entry_id,
            expected: store
                .read(&identity().entry_id)
                .unwrap()
                .unwrap()
                .state
                .revision,
            content: bytes.to_vec(),
        },
    }
}
fn empty(store: &mut Store) {
    store.apply(&create(b"")).unwrap();
    let revision = store
        .read(&identity().entry_id)
        .unwrap()
        .unwrap()
        .state
        .revision;
    store.bind_empty_text(&identity(), &revision).unwrap();
}
fn seal(store: &mut Store) -> (ExpectedContext, Vec<u8>) {
    let pending = store.pending_authored_text(None, 100).unwrap();
    let update = pending.iter().find(|s| !s.sealed).unwrap();
    let expected = ExpectedContext {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        update_id: update.update_id.clone(),
        key_epoch: 1,
    };
    let wire = store
        .seal_authored_text(&expected, &VaultKey::from_bytes([7; 32]))
        .unwrap();
    (expected, wire)
}
fn received(store: &Store, next: &str) -> ReceiveRequest {
    ReceiveRequest {
        expected_version: store
            .text_state(&identity().entry_id)
            .unwrap()
            .unwrap()
            .version,
        next_version: Revision::new(next).unwrap(),
        delivery: None,
    }
}
fn authenticated(expected: &ExpectedContext, wire: &[u8]) -> AuthenticatedText {
    AuthenticatedText::open(wire, expected, &VaultKey::from_bytes([7; 32])).unwrap()
}
#[test]
fn authenticated_receive_is_atomic_no_local_receipt_or_authored_outbox_and_duplicate_is_quiet() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Store::open(dir.path().join("a")).unwrap();
    let path = dir.path().join("b");
    let mut b = Store::open(&path).unwrap();
    empty(&mut a);
    empty(&mut b);
    let command = write(&a, "write", b"hello\r\n");
    a.apply(&command).unwrap();
    let (expected, wire) = seal(&mut a);
    let incoming = authenticated(&expected, &wire);
    let before = b.list_snapshot().unwrap();
    let receipts = b.operations_after(0, 100).unwrap();
    let pending = b.pending_counts().unwrap();
    let outcome = b.receive_text(&incoming, &received(&b, "remote1")).unwrap();
    assert!(outcome.changed);
    assert_eq!(
        b.read(&identity().entry_id).unwrap().unwrap().content,
        Some(b"hello\r\n".to_vec())
    );
    assert_eq!(b.operations_after(0, 100).unwrap(), receipts);
    assert!(b.pending_authored_text(None, 100).unwrap().is_empty());
    assert_eq!(b.pending_counts().unwrap(), (pending.0, pending.1 + 1));
    let changes = b.changes_after(&before.cursor, 100).unwrap();
    assert_eq!(changes.changes.len(), 1);
    assert!(matches!(
        changes.changes[0].origin,
        ChangeOrigin::ReceivedUpdate { .. }
    ));
    assert!(b
        .pending_projection_jobs(100)
        .unwrap()
        .iter()
        .any(|j| matches!(j.origin, ProjectionOrigin::ReceivedUpdate { .. })));
    let snapshot = b.list_snapshot().unwrap();
    assert!(
        !b.receive_text(&incoming, &received(&b, "ignored_duplicate_revision"))
            .unwrap()
            .changed
    );
    assert_eq!(snapshot, b.list_snapshot().unwrap());
    drop(b);
    let b = Store::open(&path).unwrap();
    assert_eq!(snapshot, b.list_snapshot().unwrap());
}
#[test]
fn failed_received_journal_rolls_back_dedupe_cursor_bytes_causal_state_and_projection() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Store::open(dir.path().join("a")).unwrap();
    let path = dir.path().join("b");
    let mut b = Store::open(&path).unwrap();
    empty(&mut a);
    empty(&mut b);
    a.apply(&write(&a, "write", b"new")).unwrap();
    let (context, wire) = seal(&mut a);
    let incoming = authenticated(&context, &wire);
    let cursor = ReceiveCursor {
        realm_id: identity().realm_id,
        vault_id: identity().vault_id,
        server_epoch: ServerEpoch::new("epoch").unwrap(),
        after: LogPosition::new(0),
    };
    b.set_text_receive_cursor(None, &cursor).unwrap();
    let mut next = cursor.clone();
    next.after = LogPosition::new(1);
    let mut request = received(&b, "remote");
    request.delivery = Some(CursorAdvance {
        expected: cursor.clone(),
        next: next.clone(),
    });
    let before = b.list_snapshot().unwrap();
    let state = b.text_state(&identity().entry_id).unwrap();
    let counts = b.pending_counts().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER fail_received BEFORE INSERT ON local_changes BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    assert!(b.receive_text(&incoming, &request).is_err());
    assert_eq!(before, b.list_snapshot().unwrap());
    assert_eq!(state, b.text_state(&identity().entry_id).unwrap());
    assert_eq!(counts, b.pending_counts().unwrap());
    let rows: i64 = db
        .query_row("SELECT count(*) FROM sync_updates", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
    db.execute_batch("DROP TRIGGER fail_received").unwrap();
    let outcome = b.receive_text(&incoming, &request).unwrap();
    assert_eq!(outcome.cursor, Some(next));
}
#[test]
fn adoption_cas_and_exact_replay_produce_one_persisted_envelope_and_self_echo_is_quiet() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create(b"\xef\xbb\xbfbase\r\n")).unwrap();
    let old = store.read(&identity().entry_id).unwrap().unwrap();
    let command = write(&store, "adopt", old.content.as_ref().unwrap());
    let receipt = store.adopt_text(&identity(), &command).unwrap();
    assert_eq!(store.adopt_text(&identity(), &command).unwrap(), receipt);
    assert_eq!(store.pending_authored_text(None, 100).unwrap().len(), 1);
    let historical = store
        .text_baseline(&zorid_store::ProjectionBaseline {
            state: old.state,
            content: old.content.unwrap(),
        })
        .unwrap()
        .unwrap();
    assert_eq!(historical.materialized_utf8, b"\xef\xbb\xbfbase\r\n");
    let (context, wire) = seal(&mut store);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        wire,
        store
            .seal_authored_text(&context, &VaultKey::from_bytes([7; 32]))
            .unwrap()
    );
    let before = store.list_snapshot().unwrap();
    let own = authenticated(&context, &wire);
    assert!(
        !store
            .receive_text(&own, &received(&store, "echo"))
            .unwrap()
            .changed
    );
    assert_eq!(before, store.list_snapshot().unwrap());
    store
        .acknowledge_authored_text(
            &context.realm_id,
            &context.vault_id,
            &context.update_id,
            &wire,
        )
        .unwrap();
    assert!(store.pending_authored_text(None, 100).unwrap().is_empty());
    let mut bad = wire.clone();
    bad[0] ^= 1;
    assert!(store
        .acknowledge_authored_text(
            &context.realm_id,
            &context.vault_id,
            &context.update_id,
            &bad
        )
        .is_err());
}
#[test]
fn prior_inflight_projection_cannot_retire_later_received_job() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Store::open(dir.path().join("a")).unwrap();
    let mut b = Store::open(dir.path().join("b")).unwrap();
    empty(&mut a);
    empty(&mut b);
    let attempt = b.begin_projection(&identity().entry_id).unwrap();
    b.mark_projection(
        &attempt.attempt_id,
        ProjectionPhase::Staged,
        Some("inode".into()),
    )
    .unwrap();
    a.apply(&write(&a, "write", b"remote")).unwrap();
    let (context, wire) = seal(&mut a);
    b.receive_text(&authenticated(&context, &wire), &received(&b, "remote"))
        .unwrap();
    b.finish_projection(&attempt.attempt_id, true).unwrap();
    let pending = b.pending_projection_jobs(100).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(matches!(
        pending[0].origin,
        ProjectionOrigin::ReceivedUpdate { .. }
    ));
    assert_eq!(
        b.projection_baseline(&identity().entry_id)
            .unwrap()
            .unwrap()
            .content,
        b""
    );
    let next = b.begin_projection(&identity().entry_id).unwrap();
    assert_eq!(next.target.content, b"remote");
}
#[test]
fn authority_survives_reopen_and_move_but_new_database_has_new_authority() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let id = Store::open(&first).unwrap().identity().unwrap();
    assert!(id.realm_id.is_none());
    assert_eq!(id, Store::open(&first).unwrap().identity().unwrap());
    std::fs::rename(&first, dir.path().join("moved")).unwrap();
    assert_eq!(
        id,
        Store::open(dir.path().join("moved"))
            .unwrap()
            .identity()
            .unwrap()
    );
    assert_ne!(
        id.local_store_id,
        Store::open(&first)
            .unwrap()
            .identity()
            .unwrap()
            .local_store_id
    );
}
#[test]
fn v5_migration_preserves_inflight_cutoff_and_exact_directory_job() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create(b"old")).unwrap();
    let file = store.begin_projection(&identity().entry_id).unwrap();
    store
        .mark_projection(
            &file.attempt_id,
            ProjectionPhase::Staged,
            Some("file_inode".into()),
        )
        .unwrap();
    store.apply(&write(&store, "later", b"later")).unwrap();
    let folder = MutationRequest {
        operation_id: OperationId::new("folder_op").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("folder").unwrap(),
            path: VaultPath::new("folder").unwrap(),
            kind: EntryKind::Folder,
            content: None,
        },
    };
    store.apply(&folder).unwrap();
    let directory = store
        .begin_directory_projection(folder.mutation.id())
        .unwrap();
    store
        .mark_directory_projection(
            &directory.attempt_id,
            zorid_store::DirectoryPhase::Staged,
            Some("dir_inode".into()),
        )
        .unwrap();
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    common::downgrade_v6_to_v5(&db);
    drop(db);
    let mut store = Store::open(&path).unwrap();
    store.finish_projection(&file.attempt_id, true).unwrap();
    store
        .finish_directory_projection(&directory.attempt_id)
        .unwrap();
    let pending = store.pending_projection_jobs(100).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(
        matches!(&pending[0].origin,ProjectionOrigin::LocalCommand{operation_id} if operation_id.as_str()=="later")
    );
    assert_eq!(
        store
            .projection_baseline(&identity().entry_id)
            .unwrap()
            .unwrap()
            .content,
        b"old"
    );
}
#[test]
fn same_path_move_remains_valid_and_legacy_history_does_not_block_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create(b"old")).unwrap();
    let old = store.read(&identity().entry_id).unwrap().unwrap();
    let command = MutationRequest {
        operation_id: OperationId::new("same_path").unwrap(),
        mutation: Mutation::Move {
            id: old.state.id,
            expected: old.state.revision,
            path: old.state.path,
        },
    };
    let receipt = store.apply(&command).unwrap();
    assert_eq!(receipt.changes.len(), 1);
    assert_eq!(store.pending_projection_jobs(100).unwrap().len(), 2);
    let attempt = store.begin_projection(&identity().entry_id).unwrap();
    store
        .mark_projection(
            &attempt.attempt_id,
            ProjectionPhase::Staged,
            Some("inode".into()),
        )
        .unwrap();
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    common::downgrade_v6_to_v5(&db);
    drop(db);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.apply(&command).unwrap(), receipt);
    assert_eq!(store.pending_projection_jobs(100).unwrap().len(), 2);
    store.finish_projection(&attempt.attempt_id, true).unwrap();
    let pending = store.pending_projection_jobs(100).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].work, zorid_store::ProjectionWork::Move);
}
#[test]
fn external_old_baseline_merges_remote_change_and_persists_observed_branch_then_replays() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Store::open(dir.path().join("a")).unwrap();
    let mut b = Store::open(dir.path().join("b")).unwrap();
    empty(&mut a);
    empty(&mut b);
    a.apply(&write(&a, "seed", b"base")).unwrap();
    let (context, wire) = seal(&mut a);
    b.receive_text(
        &authenticated(&context, &wire),
        &received(&b, "seed_received"),
    )
    .unwrap();
    let projection = b.begin_projection(&identity().entry_id).unwrap();
    b.mark_projection(
        &projection.attempt_id,
        ProjectionPhase::Staged,
        Some("physical_base".into()),
    )
    .unwrap();
    b.finish_projection(&projection.attempt_id, true).unwrap();
    let physical = b
        .projection_baseline(&identity().entry_id)
        .unwrap()
        .unwrap();
    a.apply(&write(&a, "remote", b"base remote")).unwrap();
    let (context, wire) = seal(&mut a);
    b.receive_text(
        &authenticated(&context, &wire),
        &received(&b, "remote_received"),
    )
    .unwrap();
    let observation = b
        .record_external(
            &physical.state.path,
            Some(physical.clone()),
            b"local base".to_vec(),
        )
        .unwrap();
    let before = b.pending_authored_text(None, 100).unwrap().len();
    let result = b
        .import_text_observation(&observation.observation_id)
        .unwrap();
    assert_eq!(
        b.pending_authored_text(None, 100).unwrap().len(),
        before + 1
    );
    let merged = b.read(&identity().entry_id).unwrap().unwrap();
    assert_eq!(merged.content, Some(b"local base remote".to_vec()));
    let observed = b
        .projection_baseline(&identity().entry_id)
        .unwrap()
        .unwrap();
    assert_eq!(observed.content, b"local base");
    assert_ne!(observed.state.revision, merged.state.revision);
    assert_eq!(
        b.text_baseline(&observed)
            .unwrap()
            .unwrap()
            .materialized_utf8,
        b"local base"
    );
    let snapshot = b.list_snapshot().unwrap();
    assert_eq!(
        b.import_text_observation(&observation.observation_id)
            .unwrap(),
        result
    );
    assert_eq!(b.list_snapshot().unwrap(), snapshot);
    let attempt = b.begin_projection(&identity().entry_id).unwrap();
    assert_eq!(attempt.baseline, Some(observed));
    assert_eq!(attempt.target.content, b"local base remote");
}
#[test]
fn stale_managed_write_has_no_authored_update_and_prepared_intent_cannot_be_bypassed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut a = Store::open(&path).unwrap();
    empty(&mut a);
    let stale = write(&a, "stale", b"old draft");
    let first = write(&a, "first", b"newer");
    a.apply(&first).unwrap();
    let snapshot = a.list_snapshot().unwrap();
    let pending = a.pending_authored_text(None, 100).unwrap();
    assert!(a.apply(&stale).is_err());
    assert_eq!(a.list_snapshot().unwrap(), snapshot);
    assert_eq!(a.pending_authored_text(None, 100).unwrap(), pending);
    let command = write(&a, "prepared", b"next");
    let view = a
        .prepare_host_intent(&OperationId::new("client").unwrap(), &command)
        .unwrap();
    assert_eq!(view.mutation_kind, zorid_store::HostMutationKind::Write);
    assert!(a.apply(&command).is_err());
    assert_eq!(a.pending_authored_text(None, 100).unwrap(), pending);
}

#[test]
fn migration_rejects_orphan_legacy_queue_without_dropping_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    drop(Store::open(&path).unwrap());
    let db = rusqlite::Connection::open(&path).unwrap();
    common::downgrade_v6_to_v5(&db);
    db.pragma_update(None, "foreign_keys", false).unwrap();
    db.execute("INSERT INTO projection_queue(sequence) VALUES(999)", [])
        .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM projection_queue WHERE sequence=999",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn missing_managed_head_cannot_fall_back_to_plaintext_local_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    empty(&mut store);
    store.apply(&write(&store, "managed", b"managed")).unwrap();
    let request = write(&store, "attempt", b"replacement");
    let before = store.list_snapshot().unwrap();
    let counts = store.pending_counts().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("DELETE FROM text_bindings", []).unwrap();
    assert!(matches!(
        store.text_state(&identity().entry_id),
        Err(zorid_store::StoreError::Corrupt(_))
    ));
    assert!(store.apply(&request).is_err());
    assert_eq!(store.list_snapshot().unwrap(), before);
    assert_eq!(store.pending_counts().unwrap(), counts);
}
#[test]
fn sealed_retry_checks_authorized_epoch_and_retains_canonical_wire() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    empty(&mut store);
    store.apply(&write(&store, "write", b"text")).unwrap();
    let (context, wire) = seal(&mut store);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let changed = ExpectedContext {
        key_epoch: 2,
        ..context.clone()
    };
    assert!(store
        .seal_authored_text(&changed, &VaultKey::from_bytes([7; 32]))
        .is_err());
    assert_eq!(
        store
            .seal_authored_text(&context, &VaultKey::from_bytes([7; 32]))
            .unwrap(),
        wire
    );
}
#[test]
fn fresh_envelope_with_integrated_payload_cannot_reuse_historical_causal_revision() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Store::open(dir.path().join("a")).unwrap();
    let mut b = Store::open(dir.path().join("b")).unwrap();
    empty(&mut a);
    empty(&mut b);
    a.apply(&write(&a, "seed", b"same")).unwrap();
    let (context, wire) = seal(&mut a);
    b.receive_text(&authenticated(&context, &wire), &received(&b, "historical"))
        .unwrap();
    let key = VaultKey::from_bytes([7; 32]);
    let opened = zorid_crypto::OpenedEnvelope::open(&wire, &context, &key).unwrap();
    for (update, next, allowed) in [("alias1", "newer", true), ("alias2", "historical", false)] {
        let header = zorid_sync_protocol::Header::new(
            context.realm_id.clone(),
            context.vault_id.clone(),
            UpdateId::new(update).unwrap(),
            zorid_sync_protocol::DeviceId::new("sender").unwrap(),
            1,
        )
        .unwrap();
        let wire = zorid_crypto::seal(
            &header,
            opened.plaintext(),
            &key,
            &mut zorid_crypto::SystemEntropy,
        )
        .unwrap()
        .encode();
        let context = ExpectedContext {
            update_id: UpdateId::new(update).unwrap(),
            ..context.clone()
        };
        let before = b.list_snapshot().unwrap();
        let outcome = b.receive_text(&authenticated(&context, &wire), &received(&b, next));
        assert_eq!(outcome.is_ok(), allowed);
        if !allowed {
            assert_eq!(b.list_snapshot().unwrap(), before);
        }
    }
}
#[test]
fn pending_dependency_survives_restart_then_predecessor_materializes_without_echo() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Store::open(dir.path().join("a")).unwrap();
    let path = dir.path().join("b");
    let mut b = Store::open(&path).unwrap();
    empty(&mut a);
    empty(&mut b);
    a.apply(&write(&a, "first", b"base")).unwrap();
    let (first_context, first_wire) = seal(&mut a);
    a.apply(&write(&a, "second", b"base later")).unwrap();
    let (second_context, second_wire) = seal(&mut a);
    let outcome = b
        .receive_text(
            &authenticated(&second_context, &second_wire),
            &received(&b, "dependency_pending"),
        )
        .unwrap();
    assert!(outcome.changed);
    assert_eq!(
        b.read(&identity().entry_id).unwrap().unwrap().content,
        Some(vec![])
    );
    let pending = b.text_state(&identity().entry_id).unwrap().unwrap();
    drop(b);
    let mut b = Store::open(&path).unwrap();
    assert_eq!(b.text_state(&identity().entry_id).unwrap(), Some(pending));
    b.receive_text(
        &authenticated(&first_context, &first_wire),
        &received(&b, "dependency_resolved"),
    )
    .unwrap();
    assert_eq!(
        b.read(&identity().entry_id).unwrap().unwrap().content,
        Some(b"base later".to_vec())
    );
    assert!(b.pending_authored_text(None, 100).unwrap().is_empty());
}
#[test]
fn received_sibling_update_cannot_reset_ancestor_to_any_historical_local_revision_including_migration(
) {
    for migrate in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut sender = Store::open(dir.path().join("sender")).unwrap();
        empty(&mut sender);
        sender.apply(&write(&sender, "remote", b"remote")).unwrap();
        let (context, wire) = seal(&mut sender);
        let path = dir.path().join("receiver");
        let mut receiver = Store::open(&path).unwrap();
        let folder = EntryId::new("folder").unwrap();
        receiver
            .apply(&MutationRequest {
                operation_id: OperationId::new("folder").unwrap(),
                mutation: Mutation::Create {
                    id: folder.clone(),
                    path: VaultPath::new("folder").unwrap(),
                    kind: EntryKind::Folder,
                    content: None,
                },
            })
            .unwrap();
        let mut target = create(b"");
        if let Mutation::Create { path, .. } = &mut target.mutation {
            *path = VaultPath::new("folder/note.md").unwrap();
        }
        receiver.apply(&target).unwrap();
        let sibling = EntryId::new("sibling").unwrap();
        receiver
            .apply(&MutationRequest {
                operation_id: OperationId::new("sibling").unwrap(),
                mutation: Mutation::Create {
                    id: sibling.clone(),
                    path: VaultPath::new("folder/sibling").unwrap(),
                    kind: EntryKind::File,
                    content: Some(b"one".to_vec()),
                },
            })
            .unwrap();
        let historical = receiver.read(&sibling).unwrap().unwrap().state.revision;
        receiver
            .apply(&MutationRequest {
                operation_id: OperationId::new("sibling_later").unwrap(),
                mutation: Mutation::Write {
                    id: sibling,
                    expected: historical.clone(),
                    content: b"two".to_vec(),
                },
            })
            .unwrap();
        if migrate {
            drop(receiver);
            let db = rusqlite::Connection::open(&path).unwrap();
            common::downgrade_v6_to_v5(&db);
            drop(db);
            receiver = Store::open(&path).unwrap();
        }
        let revision = receiver
            .read(&identity().entry_id)
            .unwrap()
            .unwrap()
            .state
            .revision;
        receiver.bind_empty_text(&identity(), &revision).unwrap();
        let before = receiver.list_snapshot().unwrap();
        let request = ReceiveRequest {
            expected_version: revision,
            next_version: historical.clone(),
            delivery: None,
        };
        assert!(receiver
            .receive_text(&authenticated(&context, &wire), &request)
            .is_err());
        assert_eq!(receiver.list_snapshot().unwrap(), before);
        let stale = MutationRequest {
            operation_id: OperationId::new("stale_folder").unwrap(),
            mutation: Mutation::Move {
                id: folder,
                expected: historical,
                path: VaultPath::new("folder").unwrap(),
            },
        };
        assert!(receiver.apply(&stale).is_err());
    }
}
#[test]
fn deleted_revision_fence_cannot_reenable_historical_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&create(b"one")).unwrap();
    store.apply(&write(&store, "second", b"two")).unwrap();
    let request = write(&store, "third", b"three");
    let before = store.list_snapshot().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("DELETE FROM revision_fences WHERE ordinal=1", [])
        .unwrap();
    assert!(matches!(
        store.apply(&request),
        Err(zorid_store::StoreError::Corrupt(_))
    ));
    assert_eq!(store.list_snapshot().unwrap(), before);
}
