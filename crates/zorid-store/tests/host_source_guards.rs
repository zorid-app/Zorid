use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{
    HostIntentAcknowledgment, HostIntentRef, HostIntentState, HostIntentView, HostRejectionCode,
    HostSourceGuard, PhysicalIdentity, ProjectionPhase, Sha256Digest, Store,
    MAX_HOST_SOURCE_BYTES, MAX_HOST_SOURCE_PATH_BYTES,
};

fn op(value: &str) -> OperationId { OperationId::new(value).unwrap() }
fn reference(view: &HostIntentView) -> HostIntentRef {
    HostIntentRef { client_id: view.client_id.clone(), token: view.token.clone() }
}
fn fixture(path: &std::path::Path) -> (Store, MutationRequest, HostSourceGuard) {
    let mut store = Store::open(path).unwrap();
    let id = EntryId::new("note").unwrap();
    store.apply(&MutationRequest {
        operation_id: op("create"),
        mutation: Mutation::Create {
            id: id.clone(), path: VaultPath::new("Note.md").unwrap(),
            kind: EntryKind::File, content: Some(b"original".to_vec()),
        },
    }).unwrap();
    let publication = store.begin_projection_bound(&id, "root-inode").unwrap();
    store.mark_projection(&publication.attempt_id, ProjectionPhase::Staged, Some("note-inode".into())).unwrap();
    store.finish_projection_bound(&publication.attempt_id, &PhysicalIdentity {
        inode: "note-inode".into(), parent_inode: "root-inode".into(),
    }).unwrap();
    let logical_state = store.read(&id).unwrap().unwrap().state;
    let command = MutationRequest { operation_id: op("conditional-write"), mutation: Mutation::Write {
        id: id.clone(), expected: logical_state.revision.clone(), content: b"replacement".to_vec(),
    } };
    let guard = HostSourceGuard {
        version: 1, capture_id: op("captured-source"),
        local_store_id: store.identity().unwrap().local_store_id,
        logical_state, binding: store.physical_binding(&id).unwrap().unwrap(),
        length: 8, digest: Sha256Digest::of(b"original"),
    };
    (store, command, guard)
}

#[test]
fn guarded_prepare_is_inert_and_exact_recovery_survives_restart_and_core_advance() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (mut store, command, guard) = fixture(&path);
    let before = store.list_snapshot().unwrap();
    assert_eq!(store.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).unwrap(), None);
    let prepared = store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap();
    let reference = reference(&prepared);
    assert_eq!(prepared.state, HostIntentState::Prepared);
    assert_eq!(store.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).unwrap(), Some(prepared.clone()));
    assert!(store.prepare_host_intent(&op("desktop"), &command).is_err());
    assert_eq!(store.host_intent_for_operation(&command.operation_id).unwrap(), Some(prepared.clone()));
    assert_eq!(store.host_intent_for_operation(&op("missing")).unwrap(), None);
    assert_eq!(store.list_snapshot().unwrap(), before);
    assert_eq!(store.host_intent_source_guard(&reference).unwrap(), Some(guard.clone()));
    assert_eq!(store.host_operation_source_guard(&command.operation_id).unwrap(), Some(guard.clone()));
    assert_eq!(store.host_intent_source_guard(&HostIntentRef {
        client_id: op("other-client"), token: reference.token.clone(),
    }).unwrap(), None);
    assert!(store.validate_host_execution(&command).is_err());
    assert!(store.apply(&command).is_err());
    assert!(!serde_json::to_string(&prepared).unwrap().contains("capture"));
    drop(store);

    let mut store = Store::open(&path).unwrap();
    // Lost prepare replies recover the same token and durable proof, rather
    // than requiring any capture in the new process's memory.
    assert_eq!(store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap(), prepared);
    assert_eq!(store.host_operation_source_guard(&command.operation_id).unwrap(), Some(guard.clone()));
    assert_eq!(store.request_host_commit(&reference).unwrap(), command);
    store.validate_host_execution(&command).unwrap();
    let receipt = store.apply(&command).unwrap();
    assert_ne!(store.read(command.mutation.id()).unwrap().unwrap().state, guard.logical_state);
    assert_eq!(store.host_intent_source_guard(&reference).unwrap(), Some(guard.clone()));
    let settled = store.query_host_intent(&reference).unwrap().unwrap();
    assert_eq!(settled.state, HostIntentState::Committed);
    assert_eq!(store.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).unwrap(), Some(settled.clone()));
    assert_eq!(settled.receipt, Some(receipt.clone()));
    assert_eq!(store.host_intent_for_operation(&command.operation_id).unwrap(), Some(settled.clone()));
    assert_eq!(store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap(), settled);
    assert!(store.prepare_host_intent(&op("desktop"), &command).is_err());
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.host_intent_source_guard(&reference).unwrap(), Some(guard));
    assert_eq!(reopened.apply(&command).unwrap(), receipt);
}

#[test]
fn every_guard_field_and_request_remains_bound_to_the_original_prepare() {
    let directory = tempfile::tempdir().unwrap();
    let (mut store, command, guard) = fixture(&directory.path().join("db"));
    let prepared = store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap();
    let mut variants = Vec::new();
    let mut next = guard.clone(); next.capture_id = op("different-capture"); variants.push(next);
    let mut next = guard.clone(); next.length += 1; variants.push(next);
    let mut next = guard.clone(); next.digest = Sha256Digest::of(b"different"); variants.push(next);
    let mut next = guard.clone(); next.binding.physical.inode = "different-inode".into(); variants.push(next);
    let mut next = guard.clone(); next.binding.physical.parent_inode = "different-parent".into(); variants.push(next);
    let mut next = guard.clone(); next.binding.state.revision = zorid_core::Revision::new("different-revision").unwrap(); variants.push(next);
    let mut next = guard.clone(); next.logical_state.path = VaultPath::new("Other.md").unwrap(); next.binding.state.path = next.logical_state.path.clone(); variants.push(next);
    for changed in variants {
        assert!(store.prepare_guarded_host_intent(&op("desktop"), &command, &changed).is_err(), "{changed:?}");
        assert_eq!(store.host_operation_source_guard(&command.operation_id).unwrap(), Some(guard.clone()));
    }
    assert!(store.prepare_guarded_host_intent(&op("other-client"), &command, &guard).is_err());
    let mut changed = command.clone();
    if let Mutation::Write { content, .. } = &mut changed.mutation { *content = b"different replacement".to_vec(); }
    assert!(store.prepare_guarded_host_intent(&op("desktop"), &changed, &guard).is_err());
    assert_eq!(store.query_host_intent(&reference(&prepared)).unwrap(), Some(prepared));
}

#[test]
fn saved_physical_binding_may_lag_the_guarded_logical_revision() {
    let directory = tempfile::tempdir().unwrap();
    let (mut store, mut command, mut guard) = fixture(&directory.path().join("db"));
    let original_binding = guard.binding.clone();
    let prior = MutationRequest { operation_id: op("logical-only-write"), mutation: command.mutation.clone() };
    store.apply(&prior).unwrap();
    guard.logical_state = store.read(command.mutation.id()).unwrap().unwrap().state;
    if let Mutation::Write { expected, .. } = &mut command.mutation { *expected = guard.logical_state.revision.clone(); }
    assert_ne!(guard.logical_state.revision, original_binding.state.revision);
    assert_eq!(store.physical_binding(command.mutation.id()).unwrap(), Some(original_binding));
    let prepared = store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap();
    assert_eq!(store.host_intent_source_guard(&reference(&prepared)).unwrap(), Some(guard));
    store.request_host_commit(&reference(&prepared)).unwrap();
    store.apply(&command).unwrap();
}

#[test]
fn invalid_sources_and_non_write_commands_never_create_an_intent() {
    let directory = tempfile::tempdir().unwrap();
    let (mut store, command, guard) = fixture(&directory.path().join("db"));
    let mut invalid = Vec::new();
    let mut next = guard.clone(); next.version = 2; invalid.push(next);
    let mut next = guard.clone(); next.length = MAX_HOST_SOURCE_BYTES + 1; invalid.push(next);
    let mut next = guard.clone(); next.logical_state.path = VaultPath::new("x".repeat(MAX_HOST_SOURCE_PATH_BYTES + 1)).unwrap(); next.binding.state.path = next.logical_state.path.clone(); invalid.push(next);
    let mut next = guard.clone(); next.local_store_id = op("foreign-store"); invalid.push(next);
    let mut next = guard.clone(); next.logical_state.deleted = true; invalid.push(next);
    let mut next = guard.clone(); next.binding.state.deleted = true; invalid.push(next);
    let mut next = guard.clone(); next.logical_state.kind = EntryKind::Folder; invalid.push(next);
    let mut next = guard.clone(); next.binding.state.kind = EntryKind::Folder; invalid.push(next);
    let mut next = guard.clone(); next.binding.state.id = EntryId::new("different-entry").unwrap(); invalid.push(next);
    let mut next = guard.clone(); next.binding.state.path = VaultPath::new("Different.md").unwrap(); invalid.push(next);
    let mut next = guard.clone(); next.logical_state.revision = zorid_core::Revision::new("different-revision").unwrap(); invalid.push(next);
    let mut next = guard.clone(); next.binding.physical.inode.clear(); invalid.push(next);
    for source in invalid {
        assert!(store.prepare_guarded_host_intent(&op("desktop"), &command, &source).is_err());
    }
    let mutation = Mutation::Delete { id: guard.logical_state.id.clone(), expected: guard.logical_state.revision.clone(), recursive: false };
    assert!(store.prepare_guarded_host_intent(&op("desktop"), &MutationRequest { operation_id: command.operation_id.clone(), mutation }, &guard).is_err());
    assert!(store.list_host_intents(&op("desktop"), "0", 100).unwrap().intents.is_empty());
    assert_eq!(store.host_operation_source_guard(&command.operation_id).unwrap(), None);
}

#[test]
fn guard_cannot_be_attached_to_an_ordinary_intent_or_prior_unguarded_receipt() {
    for commit in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (mut store, command, guard) = fixture(&directory.path().join("db"));
        if commit { store.apply(&command).unwrap(); }
        else { store.prepare_host_intent(&op("desktop"), &command).unwrap(); }
        assert!(store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).is_err());
        assert!(store.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).is_err());
        assert!(store.prepare_rejected_guarded_host_intent(&op("desktop"), &command, &guard.capture_id, HostRejectionCode::SourceCaptureExpired).is_err());
        assert_eq!(store.host_operation_source_guard(&command.operation_id).unwrap(), None);
        // The ordinary receipt/intent retains its original retry behavior.
        assert!(store.prepare_host_intent(&op("desktop"), &command).is_ok());
    }
}

#[test]
fn capture_reuse_and_guard_insert_failure_roll_back_the_new_intent() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (mut store, command, guard) = fixture(&path);
    store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap();
    let mut second = command.clone(); second.operation_id = op("second-write");
    assert!(store.prepare_guarded_host_intent(&op("desktop"), &second, &guard).is_err());
    assert_eq!(store.host_operation_source_guard(&second.operation_id).unwrap(), None);
    assert_eq!(store.list_host_intents(&op("desktop"), "0", 100).unwrap().intents.len(), 1);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER block_guard BEFORE INSERT ON host_intent_sources BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    let mut fresh = guard; fresh.capture_id = op("new-capture");
    assert!(store.prepare_guarded_host_intent(&op("desktop"), &second, &fresh).is_err());
    assert_eq!(store.list_host_intents(&op("desktop"), "0", 100).unwrap().intents.len(), 1);
    assert_eq!(store.host_operation_source_guard(&second.operation_id).unwrap(), None);
    assert!(store.replay(&second).unwrap().is_none());
}

#[test]
fn conditional_mismatch_rejection_is_durable_and_does_not_authorize_execution() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (mut store, command, guard) = fixture(&path);
    let prepared = store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap();
    let reference = reference(&prepared);
    store.request_host_commit(&reference).unwrap();
    let code = HostRejectionCode::ConditionalSourceChanged;
    assert_eq!(serde_json::to_string(&code).unwrap(), "\"conditional_source_changed\"");
    assert_eq!(store.reject_host_intent(&reference, code).unwrap().state, HostIntentState::Rejected);
    assert!(store.apply(&command).is_err());
    assert!(store.request_host_commit(&reference).is_err());
    let ack = HostIntentAcknowledgment::Rejected { operation_id: command.operation_id.clone(), code };
    assert!(store.acknowledge_host_intent(&reference, &ack).unwrap().acknowledged);
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.host_intent_source_guard(&reference).unwrap(), Some(guard));
    assert!(reopened.query_host_intent(&reference).unwrap().unwrap().acknowledged);
    assert!(reopened.apply(&command).is_err());
}

#[test]
fn persisted_guard_corruption_fails_closed() {
    for sql in [
        "UPDATE host_intent_sources SET capture_id='other'",
        "UPDATE host_intent_sources SET record='invalid-json'",
        "UPDATE host_intent_sources SET record=json_set(record,'$.source.version',2)",
        "UPDATE host_intent_sources SET record=json_set(record,'$.source.length',8388609)",
        "UPDATE host_intent_sources SET record=json_set(record,'$.source.logical_state.id','other')",
        "UPDATE host_intent_sources SET record=json_set(record,'$.source.local_store_id','other')",
        "UPDATE host_intents SET request=json_set(request,'$.operation_id','other')",
        "UPDATE host_intents SET entry_id='other'",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        let (mut store, command, guard) = fixture(&path);
        let prepared = store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(sql).unwrap();
        assert!(store.host_intent_source_guard(&reference(&prepared)).is_err(), "{sql}");
        assert!(store.host_operation_source_guard(&command.operation_id).is_err(), "{sql}");
    }
}

#[test]
fn malformed_source_schema_is_rejected_before_database_or_journal_changes() {
    for (version, change) in [
        (16, "CREATE TABLE unexpected(value)"),
        (17, "DROP TABLE host_intent_sources"),
        (17, "DROP TABLE host_intent_sources; CREATE TABLE host_intent_sources(operation_id TEXT PRIMARY KEY, capture_id TEXT, record TEXT)"),
        (20, "SELECT 1"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        drop(Store::open(&path).unwrap());
        let db = rusqlite::Connection::open(&path).unwrap();
        if version < 19 { db.execute_batch("DROP TABLE host_source_captures").unwrap(); }
        if version < 18 { drop_database_schema(&db); }
        if version == 16 { db.execute_batch("DROP TABLE host_intent_sources").unwrap(); }
        db.pragma_update(None, "user_version", version).unwrap();
        db.execute_batch(change).unwrap();
        db.pragma_update(None, "journal_mode", "DELETE").unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        assert!(Store::open(&path).is_err(), "version {version}: {change}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), version);
        assert_eq!(db.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0)).unwrap(), "delete");
    }
}

fn drop_database_schema(db:&rusqlite::Connection){
    let objects=db.prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'local_database_%' OR name LIKE 'local_collection%' ORDER BY type").unwrap().query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    for(kind,name)in objects{db.execute_batch(&format!("DROP {kind} \"{name}\";")).unwrap();}
}

#[test]
fn schema_sixteen_migration_preserves_ordinary_intent_and_receipt_without_source_authority() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (mut store, command, _) = fixture(&path);
    let prepared = store.prepare_host_intent(&op("desktop"), &command).unwrap();
    let reference = reference(&prepared);
    let before = store.list_snapshot().unwrap();
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    drop_database_schema(&db);
    db.execute_batch("DROP TABLE host_source_captures; DROP TABLE host_intent_sources; PRAGMA user_version=16; PRAGMA journal_mode=DELETE;").unwrap();
    let old_intents: String = db.query_row("SELECT request FROM host_intents", [], |row| row.get(0)).unwrap();
    let old_receipts: String = db.query_row("SELECT result FROM operations", [], |row| row.get(0)).unwrap();
    drop(db);
    let mut migrated = Store::open(&path).unwrap();
    assert_eq!(migrated.list_snapshot().unwrap(), before);
    assert_eq!(migrated.query_host_intent(&reference).unwrap(), Some(prepared));
    assert_eq!(migrated.host_intent_source_guard(&reference).unwrap(), None);
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 19);
    assert_eq!(db.query_row("SELECT request FROM host_intents", [], |row| row.get::<_, String>(0)).unwrap(), old_intents);
    assert_eq!(db.query_row("SELECT result FROM operations", [], |row| row.get::<_, String>(0)).unwrap(), old_receipts);
    migrated.request_host_commit(&reference).unwrap();
    migrated.apply(&command).unwrap();
    drop(migrated);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.host_intent_source_guard(&reference).unwrap(), None);
    assert_eq!(reopened.query_host_intent(&reference).unwrap().unwrap().state, HostIntentState::Committed);
}

#[test]
fn prepare_time_rejections_are_durable_without_fabricated_proof_or_authorship() {
    for code in [HostRejectionCode::SourceCaptureExpired, HostRejectionCode::ConditionalSourceChanged] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        let (mut store, command, guard) = fixture(&path);
        let before = store.list_snapshot().unwrap();
        let pending = store.pending_counts().unwrap();
        let rejected = store.prepare_rejected_guarded_host_intent(&op("desktop"), &command, &guard.capture_id, code).unwrap();
        let reference = reference(&rejected);
        assert_eq!(rejected.state, HostIntentState::Rejected);
        assert!(!rejected.acknowledged);
        assert_eq!(rejected.error.as_ref().unwrap().code, code);
        assert_eq!(rejected.receipt, None);
        assert_eq!(store.host_intent_source_guard(&reference).unwrap(), None);
        assert_eq!(store.host_operation_source_guard(&command.operation_id).unwrap(), None);
        assert_eq!(store.list_snapshot().unwrap(), before);
        assert_eq!(store.pending_counts().unwrap(), pending);
        assert!(store.replay(&command).unwrap().is_none());
        assert!(store.validate_host_execution(&command).is_err());
        assert!(store.apply(&command).is_err());
        assert!(store.request_host_commit(&reference).is_err());
        assert!(store.prepare_host_intent(&op("desktop"), &command).is_err());
        assert!(store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).is_err());
        let db = rusqlite::Connection::open(&path).unwrap();
        let record: String = db.query_row("SELECT record FROM host_intent_sources", [], |row| row.get(0)).unwrap();
        assert!(!record.contains("digest"));
        assert!(!record.contains("logical_state"));
        drop(db);
        drop(store);

        let mut restarted = Store::open(&path).unwrap();
        // Recovery consults the durable capture binding before any ephemeral
        // lookup. A later failure reason cannot replace the original outcome.
        assert_eq!(restarted.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).unwrap(), Some(rejected.clone()));
        let other_code = if code == HostRejectionCode::SourceCaptureExpired { HostRejectionCode::ConditionalSourceChanged } else { HostRejectionCode::SourceCaptureExpired };
        assert_eq!(restarted.prepare_rejected_guarded_host_intent(&op("desktop"), &command, &guard.capture_id, other_code).unwrap(), rejected);
        let acknowledged = restarted.acknowledge_host_intent(&reference, &HostIntentAcknowledgment::Rejected {
            operation_id: command.operation_id.clone(), code,
        }).unwrap();
        assert!(acknowledged.acknowledged);
        assert_eq!(restarted.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).unwrap(), Some(acknowledged));
        assert!(restarted.apply(&command).is_err());
        assert_eq!(restarted.list_snapshot().unwrap(), before);
    }
    assert_eq!(serde_json::to_string(&HostRejectionCode::SourceCaptureExpired).unwrap(), "\"source_capture_expired\"");
}

#[test]
fn rejected_binding_replay_is_exact_and_cannot_replace_a_verified_prepare() {
    let directory = tempfile::tempdir().unwrap();
    let (mut store, command, guard) = fixture(&directory.path().join("db"));
    let verified = store.prepare_guarded_host_intent(&op("desktop"), &command, &guard).unwrap();
    assert_eq!(store.prepare_rejected_guarded_host_intent(&op("desktop"), &command, &guard.capture_id, HostRejectionCode::SourceCaptureExpired).unwrap(), verified);
    assert_eq!(store.host_intent_source_guard(&reference(&verified)).unwrap(), Some(guard.clone()));
    assert!(store.replay_guarded_host_intent(&op("other-client"), &command, &guard.capture_id).is_err());
    assert!(store.replay_guarded_host_intent(&op("desktop"), &command, &op("other-capture")).is_err());
    let mut changed = command.clone();
    if let Mutation::Write { content, .. } = &mut changed.mutation { *content = b"different".to_vec(); }
    assert!(store.replay_guarded_host_intent(&op("desktop"), &changed, &guard.capture_id).is_err());
    let mut second = command.clone(); second.operation_id = op("second");
    assert!(store.replay_guarded_host_intent(&op("desktop"), &second, &guard.capture_id).is_err());
    assert!(store.prepare_rejected_guarded_host_intent(&op("desktop"), &second, &guard.capture_id, HostRejectionCode::SourceCaptureExpired).is_err());
    assert!(store.prepare_rejected_guarded_host_intent(&op("desktop"), &second, &op("fresh"), HostRejectionCode::RevisionConflict).is_err());
    assert_eq!(store.list_host_intents(&op("desktop"), "0", 100).unwrap().intents, vec![verified]);
}

#[test]
fn rejected_binding_insert_failure_rolls_back_intent_and_source_together() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let (mut store, command, guard) = fixture(&path);
    let before = store.list_snapshot().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER block_guard BEFORE INSERT ON host_intent_sources BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    assert!(store.prepare_rejected_guarded_host_intent(&op("desktop"), &command, &guard.capture_id, HostRejectionCode::SourceCaptureExpired).is_err());
    assert!(store.list_host_intents(&op("desktop"), "0", 100).unwrap().intents.is_empty());
    assert_eq!(store.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).unwrap(), None);
    assert_eq!(store.list_snapshot().unwrap(), before);
    assert!(store.replay(&command).unwrap().is_none());
}

#[test]
fn corrupt_rejected_binding_never_replays_as_a_valid_absent_guard() {
    for sql in [
        "UPDATE host_intent_sources SET capture_id='other'",
        "UPDATE host_intent_sources SET record=json_set(record,'$.source.local_store_id','other')",
        "UPDATE host_intent_sources SET record=json_set(record,'$.source.code','revision_conflict')",
        "UPDATE host_intent_sources SET record=json_set(record,'$.source.code','conditional_source_changed')",
        "UPDATE host_intents SET state='prepared',rejection=NULL",
        "UPDATE host_intents SET rejection='{\"code\":\"conditional_source_changed\"}'",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        let (mut store, command, guard) = fixture(&path);
        let rejected = store.prepare_rejected_guarded_host_intent(&op("desktop"), &command, &guard.capture_id, HostRejectionCode::SourceCaptureExpired).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap(); db.execute_batch(sql).unwrap();
        assert!(store.host_intent_source_guard(&reference(&rejected)).is_err(), "{sql}");
        assert!(store.host_operation_source_guard(&command.operation_id).is_err(), "{sql}");
        assert!(store.replay_guarded_host_intent(&op("desktop"), &command, &guard.capture_id).is_err(), "{sql}");
        assert!(store.apply(&command).is_err(), "{sql}");
    }
}
