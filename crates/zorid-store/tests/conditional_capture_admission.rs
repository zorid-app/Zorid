use rusqlite::{params, Connection};
use std::path::Path;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{
    HostIntentRef, HostIntentState, HostIntentView, HostRejectionCode, HostSourceCapture,
    HostSourceGuard, PhysicalIdentity, ProjectionPhase, Sha256Digest, Store,
    MAX_HOST_SOURCE_BYTES, MAX_HOST_SOURCE_CAPTURES, MAX_HOST_SOURCE_TOTAL_BYTES,
};

fn op(value: &str) -> OperationId { OperationId::new(value).unwrap() }
fn uuid(value: u64) -> OperationId { op(&format!("00000000-0000-4000-8000-{value:012x}")) }
fn reference(view: &HostIntentView) -> HostIntentRef {
    HostIntentRef { client_id: view.client_id.clone(), token: view.token.clone() }
}
// The Store consumes native-owned metadata, not source filesystem authority.
// Only the SQLite database is created; no note file is read or fabricated here.
fn fixture(path: &Path) -> (Store, MutationRequest, HostSourceGuard) {
    let mut store = Store::open(path).unwrap();
    let id = EntryId::new("note").unwrap();
    store.apply(&MutationRequest {
        operation_id: op("create"),
        mutation: Mutation::Create { id: id.clone(), path: VaultPath::new("Note.md").unwrap(),
            kind: EntryKind::File, content: Some(b"original".to_vec()) },
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
    let guard = HostSourceGuard { version: 1, capture_id: uuid(100),
        local_store_id: store.identity().unwrap().local_store_id,
        logical_state, binding: store.physical_binding(&id).unwrap().unwrap(),
        length: 8, digest: Sha256Digest::of(b"original"),
    };
    (store, command, guard)
}
fn sized(template: &HostSourceGuard, number: u64, length: u64) -> HostSourceGuard {
    HostSourceGuard { capture_id: uuid(number), length, ..template.clone() }
}

#[test]
fn pending_capture_count_is_global_idempotent_and_durable_across_restart() {
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
    let (mut store, _, template) = fixture(&path); let before = store.list_snapshot().unwrap();
    assert_eq!(MAX_HOST_SOURCE_CAPTURES, 8);
    for number in 0..8 {
        let guard = sized(&template, 100 + number, 8);
        let (client, lease) = (uuid(1 + number % 2), uuid(10 + number));
        assert!(store.register_host_source_capture(&client, &lease, &guard).unwrap());
        assert!(store.register_host_source_capture(&client, &lease, &guard).unwrap());
    }
    assert_eq!(store.host_source_capture_usage().unwrap(), (8, 64));
    let ninth = sized(&template, 108, 8);
    assert!(!store.register_host_source_capture(&uuid(3), &uuid(30), &ninth).unwrap());
    assert_eq!(store.host_source_capture(&ninth.capture_id).unwrap(), None);
    assert_eq!(store.list_snapshot().unwrap(), before);
    assert!(store.list_host_intents(&uuid(1), "0", 100).unwrap().intents.is_empty());
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.host_source_capture_usage().unwrap(), (8, 64));
    assert_eq!(reopened.host_source_capture(&template.capture_id).unwrap(), Some(HostSourceCapture {
        client_id: uuid(1), lease_token: uuid(10), guard: template.clone(),
    }));
    assert!(!reopened.register_host_source_capture(&uuid(3), &uuid(30), &ninth).unwrap());
    assert!(reopened.release_host_source_capture(&uuid(2), &template.capture_id).unwrap());
    assert_eq!(reopened.host_source_capture_usage().unwrap(), (8, 64));
    assert!(reopened.release_host_source_capture(&uuid(1), &template.capture_id).unwrap());
    assert!(reopened.register_host_source_capture(&uuid(3), &uuid(30), &ninth).unwrap());
    assert_eq!(reopened.host_source_capture_usage().unwrap(), (8, 64));
}

#[test]
fn thirty_two_mib_pending_budget_is_shared_by_clients_and_preserves_exact_boundary() {
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
    let (mut store, _, template) = fixture(&path);
    assert_eq!(MAX_HOST_SOURCE_TOTAL_BYTES, 32 * 1024 * 1024);
    for number in 0..4 {
        assert!(store.register_host_source_capture(&uuid(1 + number), &uuid(10 + number),
            &sized(&template, 100 + number, MAX_HOST_SOURCE_BYTES)).unwrap());
    }
    assert_eq!(store.host_source_capture_usage().unwrap(), (4, MAX_HOST_SOURCE_TOTAL_BYTES));
    assert!(!store.register_host_source_capture(&uuid(5), &uuid(15), &sized(&template, 105, 1)).unwrap());
    assert!(store.register_host_source_capture(&uuid(5), &uuid(15), &sized(&template, 104, 0)).unwrap());
    assert_eq!(store.host_source_capture_usage().unwrap(), (5, MAX_HOST_SOURCE_TOTAL_BYTES));
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert!(!reopened.register_host_source_capture(&uuid(6), &uuid(16), &sized(&template, 105, 1)).unwrap());
    assert!(reopened.release_host_source_capture(&uuid(1), &uuid(100)).unwrap());
    assert!(reopened.register_host_source_capture(&uuid(6), &uuid(16), &sized(&template, 105, 1)).unwrap());
    assert_eq!(reopened.host_source_capture_usage().unwrap(), (5, MAX_HOST_SOURCE_TOTAL_BYTES - MAX_HOST_SOURCE_BYTES + 1));
}

#[test]
fn exact_pending_ownership_reuse_release_and_lease_retirement_are_separate() {
    let directory = tempfile::tempdir().unwrap(); let (mut store, _, guard) = fixture(&directory.path().join("db"));
    let client = uuid(1); let old = uuid(10); let successor = uuid(11);
    assert!(store.register_host_source_capture(&client, &old, &guard).unwrap());
    assert!(store.register_host_source_capture(&client, &old, &guard).unwrap());
    let mut changed = guard.clone(); changed.digest = Sha256Digest::of(b"different evidence");
    assert!(store.register_host_source_capture(&client, &old, &changed).is_err());
    assert!(store.register_host_source_capture(&client, &successor, &guard).is_err());
    assert!(store.register_host_source_capture(&uuid(2), &old, &guard).is_err());
    assert!(store.register_host_source_capture(&op("not-a-canonical-uuid"), &old, &sized(&guard, 105, 8)).is_err());
    assert!(store.register_host_source_capture(&client, &op("not-a-canonical-uuid"), &sized(&guard, 105, 8)).is_err());
    assert!(store.register_host_source_capture(&client, &successor, &sized(&guard, 101, 8)).unwrap());
    assert!(store.register_host_source_capture(&uuid(2), &old, &sized(&guard, 102, 8)).unwrap());
    store.retire_host_source_captures(&client, &uuid(999)).unwrap();
    assert_eq!(store.host_source_capture_usage().unwrap(), (3, 24));
    store.retire_host_source_captures(&client, &old).unwrap();
    assert_eq!(store.host_source_capture(&guard.capture_id).unwrap(), None);
    assert!(store.host_source_capture(&uuid(101)).unwrap().is_some());
    assert!(store.host_source_capture(&uuid(102)).unwrap().is_some());
    // Individual release is authorized by the current same client, not its old lease.
    assert!(store.release_host_source_capture(&client, &uuid(101)).unwrap());
    assert!(store.release_host_source_capture(&client, &uuid(102)).unwrap());
    assert!(store.release_host_source_capture(&client, &uuid(999)).unwrap());
    assert_eq!(store.host_source_capture_usage().unwrap(), (1, 8));
}

#[test]
fn captured_prepare_consumes_admission_atomically_and_replays_after_restart_and_commit() {
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
    let (mut store, command, guard) = fixture(&path); let (client, lease) = (uuid(1), uuid(10));
    let before = store.list_snapshot().unwrap();
    assert!(store.prepare_captured_host_intent(&client, &lease, &command, &guard).is_err());
    assert!(store.register_host_source_capture(&client, &lease, &guard).unwrap());
    assert!(store.prepare_captured_host_intent(&uuid(2), &lease, &command, &guard).is_err());
    assert!(store.prepare_captured_host_intent(&client, &uuid(11), &command, &guard).is_err());
    let mut changed = guard.clone(); changed.digest = Sha256Digest::of(b"different evidence");
    assert!(store.prepare_captured_host_intent(&client, &lease, &command, &changed).is_err());
    assert_eq!(store.host_source_capture_usage().unwrap(), (1, 8));
    let prepared = store.prepare_captured_host_intent(&client, &lease, &command, &guard).unwrap();
    let reference = reference(&prepared);
    assert_eq!(prepared.state, HostIntentState::Prepared);
    assert_eq!(store.host_source_capture(&guard.capture_id).unwrap(), None);
    assert_eq!(store.host_source_capture_usage().unwrap(), (0, 0));
    assert_eq!(store.host_intent_source_guard(&reference).unwrap(), Some(guard.clone()));
    assert!(store.register_host_source_capture(&client, &lease, &guard).is_err());
    assert!(store.validate_host_execution(&command).is_err());
    assert!(store.apply(&command).is_err());
    assert_eq!(store.list_snapshot().unwrap(), before);
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    // After attachment the exact durable intent is authority; the prior capture
    // lease is not renewed or required to survive in an ephemeral process map.
    assert_eq!(reopened.prepare_captured_host_intent(&client, &uuid(11), &command, &guard).unwrap(), prepared);
    reopened.request_host_commit(&reference).unwrap();
    let receipt = reopened.apply(&command).unwrap();
    let committed = reopened.query_host_intent(&reference).unwrap().unwrap();
    assert_eq!(committed.state, HostIntentState::Committed);
    assert_eq!(committed.receipt, Some(receipt));
    drop(reopened);
    let mut restarted = Store::open(&path).unwrap();
    assert_eq!(restarted.prepare_captured_host_intent(&client, &uuid(12), &command, &guard).unwrap(), committed);
    assert_eq!(restarted.host_source_capture_usage().unwrap(), (0, 0));
    let mut altered_command = command.clone();
    if let Mutation::Write { content, .. } = &mut altered_command.mutation { *content = b"altered replacement".to_vec(); }
    assert!(restarted.prepare_captured_host_intent(&client, &lease, &altered_command, &guard).is_err());
}

#[test]
fn revoked_capture_cannot_be_reattached_from_stale_native_memory() {
    let directory = tempfile::tempdir().unwrap(); let (mut store, command, guard) = fixture(&directory.path().join("db"));
    let (client, old_lease, successor) = (uuid(1), uuid(10), uuid(11));
    store.register_host_source_capture(&client, &old_lease, &guard).unwrap();
    let loaded = store.host_source_capture(&guard.capture_id).unwrap().unwrap();
    let before = store.list_snapshot().unwrap();
    store.retire_host_source_captures(&client, &old_lease).unwrap();
    assert!(store.prepare_captured_host_intent(&loaded.client_id, &loaded.lease_token, &command, &loaded.guard).is_err());
    assert!(store.prepare_rejected_captured_host_intent(&loaded.client_id, &loaded.lease_token, &command, &loaded.guard, HostRejectionCode::SourceCaptureExpired).is_err());
    assert_eq!(store.host_intent_for_operation(&command.operation_id).unwrap(), None);
    assert_eq!(store.host_source_capture_usage().unwrap(), (0, 0));
    assert_eq!(store.list_snapshot().unwrap(), before);
    let fresh = sized(&guard, 101, 8);
    assert!(store.register_host_source_capture(&client, &successor, &fresh).unwrap());
    let prepared = store.prepare_captured_host_intent(&client, &successor, &command, &fresh).unwrap();
    assert_eq!(store.host_intent_source_guard(&reference(&prepared)).unwrap(), Some(fresh));
}

#[test]
fn attached_source_proof_does_not_consume_pending_count_or_byte_budget() {
    let directory = tempfile::tempdir().unwrap(); let (mut store, command, template) = fixture(&directory.path().join("db"));
    let first = sized(&template, 100, MAX_HOST_SOURCE_BYTES);
    for number in 0..4 { assert!(store.register_host_source_capture(&uuid(1), &uuid(10), &sized(&template, 100 + number, MAX_HOST_SOURCE_BYTES)).unwrap()); }
    let prepared = store.prepare_captured_host_intent(&uuid(1), &uuid(10), &command, &first).unwrap();
    assert_eq!(store.host_source_capture_usage().unwrap(), (3, MAX_HOST_SOURCE_TOTAL_BYTES - MAX_HOST_SOURCE_BYTES));
    assert!(store.register_host_source_capture(&uuid(2), &uuid(20), &sized(&template, 104, MAX_HOST_SOURCE_BYTES)).unwrap());
    assert_eq!(store.host_source_capture_usage().unwrap(), (4, MAX_HOST_SOURCE_TOTAL_BYTES));
    assert_eq!(store.host_intent_source_guard(&reference(&prepared)).unwrap(), Some(first));
}

#[test]
fn guard_insert_or_capture_consumption_failure_rolls_back_both_sides_of_prepare() {
    for rejected in [false, true] { for trigger in [
        "CREATE TRIGGER fail_attach BEFORE INSERT ON host_intent_sources BEGIN SELECT RAISE(ABORT,'fixture'); END",
        "CREATE TRIGGER fail_attach BEFORE DELETE ON host_source_captures BEGIN SELECT RAISE(ABORT,'fixture'); END",
    ] {
        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
        let (mut store, command, guard) = fixture(&path); let (client, lease) = (uuid(1), uuid(10));
        store.register_host_source_capture(&client, &lease, &guard).unwrap();
        let before = store.list_snapshot().unwrap(); let db = Connection::open(&path).unwrap(); db.execute_batch(trigger).unwrap();
        let result = if rejected { store.prepare_rejected_captured_host_intent(&client, &lease, &command, &guard, HostRejectionCode::ConditionalSourceChanged) }
            else { store.prepare_captured_host_intent(&client, &lease, &command, &guard) };
        assert!(result.is_err(), "{trigger}, rejected={rejected}");
        assert_eq!(store.host_source_capture_usage().unwrap(), (1, 8));
        assert_eq!(store.host_source_capture(&guard.capture_id).unwrap(), Some(HostSourceCapture { client_id: client.clone(), lease_token: lease.clone(), guard: guard.clone() }));
        assert_eq!(store.host_intent_for_operation(&command.operation_id).unwrap(), None);
        assert_eq!(store.host_operation_source_guard(&command.operation_id).unwrap(), None);
        assert_eq!(store.list_snapshot().unwrap(), before);
        assert!(store.replay(&command).unwrap().is_none());
    } }
}

#[test]
fn rejected_captured_prepare_consumes_only_its_original_admission_and_remains_terminal() {
    for code in [HostRejectionCode::SourceCaptureExpired, HostRejectionCode::ConditionalSourceChanged] {
        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
        let (mut store, command, guard) = fixture(&path); let (client, lease) = (uuid(1), uuid(10));
        let before = store.list_snapshot().unwrap();
        assert!(store.prepare_rejected_captured_host_intent(&client, &lease, &command, &guard, code).is_err());
        store.register_host_source_capture(&client, &lease, &guard).unwrap();
        let rejected = store.prepare_rejected_captured_host_intent(&client, &lease, &command, &guard, code).unwrap();
        assert_eq!(rejected.state, HostIntentState::Rejected);
        assert_eq!(rejected.error.as_ref().unwrap().code, code);
        assert_eq!(store.host_source_capture_usage().unwrap(), (0, 0));
        assert!(store.request_host_commit(&reference(&rejected)).is_err());
        assert!(store.apply(&command).is_err());
        assert_eq!(store.list_snapshot().unwrap(), before);
        drop(store);
        let mut reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.prepare_rejected_captured_host_intent(&client, &uuid(11), &command, &guard, code).unwrap(), rejected);
        assert_eq!(reopened.host_operation_source_guard(&command.operation_id).unwrap(), None);
    }
}

#[test]
fn corrupt_or_foreign_capture_records_fail_closed_instead_of_becoming_absent_or_free_capacity() {
    for sql in [
        "UPDATE host_source_captures SET record='invalid json'",
        "UPDATE host_source_captures SET client_id='00000000-0000-4000-8000-000000000099'",
        "UPDATE host_source_captures SET lease_token='00000000-0000-4000-8000-000000000099'",
        "UPDATE host_source_captures SET source_length=7",
        "UPDATE host_source_captures SET record=json_set(record,'$.guard.version',2)",
        "UPDATE host_source_captures SET record=json_set(record,'$.guard.local_store_id','foreign-store')",
        "UPDATE host_source_captures SET record=json_set(record,'$.guard.binding.state.id','different-entry')",
        "UPDATE host_source_captures SET record=json_set(record,'$.client_id','not-a-canonical-uuid')",
    ] {
        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
        let (mut store, command, guard) = fixture(&path); let (client, lease) = (uuid(1), uuid(10));
        store.register_host_source_capture(&client, &lease, &guard).unwrap();
        let db = Connection::open(&path).unwrap(); db.execute_batch(sql).unwrap();
        assert!(store.host_source_capture(&guard.capture_id).is_err(), "{sql}");
        assert!(store.host_source_capture_usage().is_err(), "{sql}");
        assert!(store.register_host_source_capture(&client, &lease, &sized(&guard, 101, 8)).is_err(), "{sql}");
        assert!(store.release_host_source_capture(&client, &guard.capture_id).is_err(), "{sql}");
        assert!(store.retire_host_source_captures(&client, &lease).is_err(), "{sql}");
        assert!(store.prepare_captured_host_intent(&client, &lease, &command, &guard).is_err(), "{sql}");
        assert_eq!(store.host_intent_for_operation(&command.operation_id).unwrap(), None);
    }
}

#[test]
fn persisted_count_or_byte_overcommit_is_corruption_not_a_fresh_admission_budget() {
    for (count, length) in [(9, 8), (5, MAX_HOST_SOURCE_BYTES)] {
        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
        let (mut store, _, template) = fixture(&path); let db = Connection::open(&path).unwrap();
        for number in 0..count {
            let value = HostSourceCapture { client_id: uuid(1), lease_token: uuid(10), guard: sized(&template, 100 + number, length) };
            db.execute("INSERT INTO host_source_captures(capture_id,client_id,lease_token,source_length,record) VALUES(?1,?2,?3,?4,?5)",
                params![value.guard.capture_id.as_str(), value.client_id.as_str(), value.lease_token.as_str(), i64::try_from(value.guard.length).unwrap(), serde_json::to_string(&value).unwrap()]).unwrap();
        }
        assert!(store.host_source_capture_usage().is_err());
        assert!(store.register_host_source_capture(&uuid(2), &uuid(20), &sized(&template, 999, 0)).is_err());
        assert!(store.retire_host_source_captures(&uuid(1), &uuid(10)).is_err());
    }
}

fn schema_without_captures(db: &Connection) -> Vec<(String, String, String)> {
    db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('host_source_captures','host_source_requests','host_source_requests_pending') ORDER BY type,name").unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}
fn retained_records(db: &Connection) -> Vec<(String, String)> {
    let mut records = Vec::new();
    for (table, column) in [("host_intents", "request"), ("host_intent_sources", "record"), ("operations", "result"), ("entries", "state"), ("physical_bindings", "record")] {
        let rows = db.prepare(&format!("SELECT {column} FROM {table} ORDER BY rowid")).unwrap().query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        records.extend(rows.into_iter().map(|record| (table.to_owned(), record)));
    }
    records
}

#[test]
fn exact_schema_eighteen_migrates_only_capture_schema_and_preserves_old_intents_and_receipts() {
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
    let (mut store, command, guard) = fixture(&path);
    let prepared = store.prepare_guarded_host_intent(&uuid(1), &command, &guard).unwrap();
    let before = store.list_snapshot().unwrap(); drop(store);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE host_source_requests; DROP TABLE host_source_captures; PRAGMA user_version=18; PRAGMA journal_mode=DELETE;").unwrap();
    let old_schema = schema_without_captures(&db); let old_records = retained_records(&db); drop(db);
    let migrated = Store::open(&path).unwrap();
    assert_eq!(migrated.list_snapshot().unwrap(), before);
    assert_eq!(migrated.query_host_intent(&reference(&prepared)).unwrap(), Some(prepared));
    assert_eq!(migrated.host_operation_source_guard(&command.operation_id).unwrap(), Some(guard));
    assert_eq!(migrated.host_source_capture_usage().unwrap(), (0, 0)); drop(migrated);
    let db = Connection::open(&path).unwrap();
    assert_eq!(db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 20);
    assert_eq!(schema_without_captures(&db), old_schema);
    assert_eq!(retained_records(&db), old_records);
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='host_source_captures'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn missing_malformed_or_foreign_capture_schema_fails_before_version_or_wal_changes() {
    for (version, change) in [
        (19, "DROP TABLE host_source_captures"),
        (19, "DROP TABLE host_source_captures; CREATE TABLE host_source_captures(capture_id TEXT PRIMARY KEY,record TEXT)"),
        (18, "CREATE TABLE host_source_captures(foreign_record)"),
        (18, "CREATE TRIGGER foreign_capture_trigger AFTER INSERT ON entries BEGIN SELECT 1; END"),
        (21, "SELECT 1"),
    ] {
        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("db");
        drop(Store::open(&path).unwrap()); let db = Connection::open(&path).unwrap();
        db.execute_batch("DROP TABLE host_source_requests").unwrap();
        if version == 18 { db.execute_batch("DROP TABLE host_source_captures").unwrap(); }
        db.pragma_update(None, "user_version", version).unwrap(); db.execute_batch(change).unwrap();
        db.pragma_update(None, "journal_mode", "DELETE").unwrap(); drop(db);
        let before = std::fs::read(&path).unwrap(); assert!(Store::open(&path).is_err(), "version {version}: {change}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "version {version}: {change}");
        let db = Connection::open(&path).unwrap();
        assert_eq!(db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), version);
        assert_eq!(db.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0)).unwrap(), "delete");
    }
}

#[test]
fn capture_request_unknown_release_durably_fences_a_late_first_capture() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
    let (mut store,_,guard)=fixture(&path);let client=uuid(1);
    assert!(store.release_host_source_capture(&client,&guard.capture_id).unwrap());
    drop(store);let mut store=Store::open(&path).unwrap();
    assert!(store.register_host_source_capture(&client,&uuid(10),&guard).is_err());
    assert_eq!(store.host_source_capture_usage().unwrap(),(0,0));
}
#[test]
fn capture_request_release_and_exact_lease_retirement_never_resurrect_an_id() {
    for retire in [false,true] {
        let directory=tempfile::tempdir().unwrap();let (mut store,_,guard)=fixture(&directory.path().join("db"));
        let (client,token)=(uuid(1),uuid(10));store.register_host_source_capture(&client,&token,&guard).unwrap();
        if retire {store.retire_host_source_captures(&client,&token).unwrap();}else{store.release_host_source_capture(&client,&guard.capture_id).unwrap();}
        assert!(store.register_host_source_capture(&client,&token,&guard).is_err());
        assert_eq!(store.host_source_capture_usage().unwrap(),(0,0));
    }
}
#[test]
fn capture_request_release_does_not_disclose_or_mutate_foreign_ownership() {
    let directory=tempfile::tempdir().unwrap();let (mut store,_,guard)=fixture(&directory.path().join("db"));
    store.register_host_source_capture(&uuid(1),&uuid(10),&guard).unwrap();
    assert!(store.release_host_source_capture(&uuid(2),&guard.capture_id).unwrap());
    assert!(store.release_host_source_capture(&uuid(2),&uuid(999)).unwrap());
    assert_eq!(store.host_source_capture_usage().unwrap(),(1,8));
}

fn request(guard:&HostSourceGuard)->zorid_store::HostSourceCaptureRequest {
    zorid_store::HostSourceCaptureRequest{capture_id:guard.capture_id.clone(),logical_witness:zorid_store::HostSourceWitness{
        entry_id:guard.logical_state.id.clone(),revision:guard.logical_state.revision.clone(),path:guard.logical_state.path.clone()}}
}
#[test]
fn capture_request_original_pending_precedes_capacity_and_has_owned_bounded_metadata() {
    use zorid_store::HostSourceRequestLookup::*;
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
    let (mut store,_,guard)=fixture(&path);let (client,lease)=(uuid(1),uuid(10));
    for i in 0..8 {store.register_host_source_capture(&client,&lease,&sized(&guard,100+i,8)).unwrap();}
    let original=store.host_source_request(&client,&request(&guard)).unwrap();
    assert!(matches!(&original,Pending(c) if c.guard==guard&&c.lease_token==lease));
    let list=store.host_source_pending_requests(&client).unwrap();assert_eq!(list.len(),8);
    assert!(list.iter().all(|row|!row.legacy&&row.lease_token==lease));
    assert!(store.host_source_pending_requests(&uuid(2)).unwrap().is_empty());
    let mut mismatch=request(&guard);mismatch.logical_witness.path=VaultPath::new("Other.md").unwrap();
    assert!(store.host_source_request(&client,&mismatch).is_err());
    assert!(store.host_source_request(&uuid(2),&request(&guard)).is_err());
    drop(store);let store=Store::open(&path).unwrap();assert_eq!(store.host_source_request(&client,&request(&guard)).unwrap(),original);
}
#[test]
fn capture_request_initial_and_pending_changed_are_durable_without_reobserving_guard() {
    use zorid_store::HostSourceRequestLookup::*;
    for pending in [false,true] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
        let (mut store,_,guard)=fixture(&path);let client=uuid(1);
        if pending {store.register_host_source_capture(&client,&uuid(10),&guard).unwrap();}
        assert_eq!(store.record_host_source_request_changed(&client,&request(&guard)).unwrap(),Changed);
        assert_eq!(store.host_source_capture_usage().unwrap(),(0,0));
        drop(store);let mut store=Store::open(&path).unwrap();
        assert_eq!(store.host_source_request(&client,&request(&guard)).unwrap(),Changed);
        assert!(store.register_host_source_capture(&client,&uuid(11),&guard).is_err());
        store.release_host_source_capture(&client,&guard.capture_id).unwrap();
        assert_eq!(store.host_source_request(&client,&request(&guard)).unwrap(),Changed);
    }
}
#[test]
fn capture_request_attached_including_rejected_keeps_exact_intent_through_release() {
    use zorid_store::HostSourceRequestLookup::*;
    for rejected in [false,true] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
        let (mut store,command,guard)=fixture(&path);let (client,lease)=(uuid(1),uuid(10));
        store.register_host_source_capture(&client,&lease,&guard).unwrap();
        let prepared=if rejected {store.prepare_rejected_captured_host_intent(&client,&lease,&command,&guard,HostRejectionCode::ConditionalSourceChanged).unwrap()}
            else {store.prepare_captured_host_intent(&client,&lease,&command,&guard).unwrap()};
        let expected=Attached{operation_id:command.operation_id.clone()};
        assert_eq!(store.host_source_request(&client,&request(&guard)).unwrap(),expected);
        store.release_host_source_capture(&client,&guard.capture_id).unwrap();store.retire_host_source_captures(&client,&lease).unwrap();
        assert_eq!(store.record_host_source_request_changed(&client,&request(&guard)).unwrap(),expected);
        assert_eq!(store.replay_guarded_host_intent(&client,&command,&guard.capture_id).unwrap(),Some(prepared));
        assert!(store.register_host_source_capture(&client,&lease,&guard).is_err());
    }
}
#[test]
fn capture_request_guard_and_receipt_transitions_roll_back_together() {
    use zorid_store::HostSourceRequestLookup::*;
    for action in ["changed","release","attach"] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
        let (mut store,command,guard)=fixture(&path);let (client,lease)=(uuid(1),uuid(10));
        store.register_host_source_capture(&client,&lease,&guard).unwrap();
        let db=Connection::open(&path).unwrap();db.execute_batch("CREATE TRIGGER fail_request_update BEFORE UPDATE ON host_source_requests BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
        let failed=match action {"changed"=>store.record_host_source_request_changed(&client,&request(&guard)).is_err(),"release"=>store.release_host_source_capture(&client,&guard.capture_id).is_err(),_=>store.prepare_captured_host_intent(&client,&lease,&command,&guard).is_err()};
        assert!(failed);assert_eq!(store.host_source_capture_usage().unwrap(),(1,8));
        assert!(matches!(store.host_source_request(&client,&request(&guard)).unwrap(),Pending(_)));
        assert_eq!(store.host_intent_for_operation(&command.operation_id).unwrap(),None);
    }
}
#[test]
fn capture_request_schema_nineteen_backfills_only_pending_and_uses_indexed_legacy_union() {
    use zorid_store::HostSourceRequestLookup::*;
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
    let (mut store,command,guard)=fixture(&path);let (client,lease)=(uuid(1),uuid(10));
    for i in 0..16 {let mut cmd=command.clone();cmd.operation_id=uuid(300+i);store.prepare_guarded_host_intent(&client,&cmd,&sized(&guard,200+i,8)).unwrap();}
    let legacy=sized(&guard,200,8);let mut legacy_command=command.clone();legacy_command.operation_id=uuid(300);
    store.register_host_source_capture(&client,&lease,&guard).unwrap();drop(store);
    let db=Connection::open(&path).unwrap();let before=retained_records(&db);
    db.execute_batch("DROP TABLE host_source_requests; PRAGMA user_version=19; PRAGMA journal_mode=DELETE;").unwrap();drop(db);
    let mut store=Store::open(&path).unwrap();let list=store.host_source_pending_requests(&client).unwrap();
    assert_eq!(list.len(),1);assert_eq!(list[0].capture_id,guard.capture_id);assert!(list[0].legacy);assert_eq!(list[0].lease_token,lease);
    assert_eq!(store.host_source_request(&client,&request(&legacy)).unwrap(),Attached{operation_id:legacy_command.operation_id});
    store.release_host_source_capture(&client,&legacy.capture_id).unwrap();assert!(store.register_host_source_capture(&client,&lease,&legacy).is_err());
    let db=Connection::open(&path).unwrap();assert_eq!(retained_records(&db),before);
    assert_eq!(db.query_row("SELECT count(*) FROM host_source_requests",[],|row|row.get::<_,i64>(0)).unwrap(),1);
    let plan:String=db.query_row("EXPLAIN QUERY PLAN SELECT operation_id FROM host_intent_sources WHERE capture_id=?1",[legacy.capture_id.as_str()],|row|row.get(3)).unwrap();assert!(plan.contains("SEARCH")&&plan.contains("capture_id"),"{plan}");
}
#[test]
fn capture_request_migration_does_not_decode_unselected_legacy_history() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
    let (mut store,command,guard)=fixture(&path);let client=uuid(1);
    store.prepare_guarded_host_intent(&client,&command,&guard).unwrap();drop(store);
    let db=Connection::open(&path).unwrap();db.execute_batch("UPDATE host_intent_sources SET record='malformed old history'; DROP TABLE host_source_requests; PRAGMA user_version=19; PRAGMA journal_mode=DELETE;").unwrap();drop(db);
    let store=Store::open(&path).unwrap();assert_eq!(store.host_source_capture_usage().unwrap(),(0,0));
    assert!(store.host_source_request(&client,&request(&guard)).is_err());
}
#[test]
fn capture_request_corrupt_receipt_and_missing_guard_fail_closed() {
    for change in ["UPDATE host_source_requests SET record='malformed'","DELETE FROM host_source_captures","DELETE FROM host_source_requests",
        "UPDATE host_source_requests SET state='released'","UPDATE host_source_requests SET record=json_set(record,'$.local_store_id','foreign')"] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
        let (mut store,_,guard)=fixture(&path);let client=uuid(1);store.register_host_source_capture(&client,&uuid(10),&guard).unwrap();
        Connection::open(&path).unwrap().execute_batch(change).unwrap();
        assert!(store.host_source_request(&client,&request(&guard)).is_err(),"{change}");
        assert!(store.host_source_pending_requests(&client).is_err(),"{change}");
        assert!(store.release_host_source_capture(&client,&guard.capture_id).is_err(),"{change}");
    }
}

#[test]
fn capture_request_legacy_rejected_attachment_stays_terminal_without_invented_path() {
    use zorid_store::HostSourceRequestLookup::*;
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
    let (mut store,command,guard)=fixture(&path);let client=uuid(1);
    let rejected=store.prepare_rejected_guarded_host_intent(&client,&command,&guard.capture_id,HostRejectionCode::SourceCaptureExpired).unwrap();
    assert_eq!(store.host_source_request(&client,&request(&guard)).unwrap(),Attached{operation_id:command.operation_id.clone()});
    let mut wrong=request(&guard);wrong.logical_witness.entry_id=EntryId::new("another").unwrap();
    assert!(store.host_source_request(&client,&wrong).is_err());
    store.release_host_source_capture(&client,&guard.capture_id).unwrap();
    assert_eq!(store.replay_guarded_host_intent(&client,&command,&guard.capture_id).unwrap(),Some(rejected));
    assert!(store.register_host_source_capture(&client,&uuid(10),&guard).is_err());
    assert_eq!(Connection::open(&path).unwrap().query_row("SELECT count(*) FROM host_source_requests",[],|row|row.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn capture_request_corrupt_legacy_attachment_is_not_unknown_even_without_a_receipt() {
    for change in ["UPDATE host_intent_sources SET record='malformed'","UPDATE host_intents SET acknowledged=1",
        "UPDATE host_intents SET request=json_set(request,'$.operation_id','different')"] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
        let (mut store,command,guard)=fixture(&path);let client=uuid(1);
        store.prepare_guarded_host_intent(&client,&command,&guard).unwrap();Connection::open(&path).unwrap().execute_batch(change).unwrap();
        assert!(store.host_source_request(&client,&request(&guard)).is_err(),"{change}");
        assert!(store.release_host_source_capture(&client,&guard.capture_id).is_err(),"{change}");
        assert!(store.register_host_source_capture(&client,&uuid(10),&guard).is_err(),"{change}");
        assert_eq!(Connection::open(&path).unwrap().query_row("SELECT count(*) FROM host_source_requests",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    }
}
#[test]
fn capture_request_failed_pending_migration_rolls_back_schema_and_version() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
    let (mut store,_,guard)=fixture(&path);store.register_host_source_capture(&uuid(1),&uuid(10),&guard).unwrap();drop(store);
    let db=Connection::open(&path).unwrap();db.execute_batch("DROP TABLE host_source_requests; UPDATE host_source_captures SET record='malformed'; PRAGMA user_version=19; PRAGMA journal_mode=DELETE;").unwrap();drop(db);
    assert!(Store::open(&path).is_err());let db=Connection::open(&path).unwrap();
    assert_eq!(db.pragma_query_value(None,"user_version",|row|row.get::<_,i64>(0)).unwrap(),19);
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE name='host_source_requests'",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(db.query_row("SELECT record FROM host_source_captures",[],|row|row.get::<_,String>(0)).unwrap(),"malformed");
}

#[test]
fn capture_request_legacy_prepare_cannot_bypass_pending_or_terminal_receipts() {
    for pending in [false,true] {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("db");
        let (mut store,command,guard)=fixture(&path);let (client,lease)=(uuid(1),uuid(10));
        if pending {store.register_host_source_capture(&client,&lease,&guard).unwrap();}
        else {store.release_host_source_capture(&client,&guard.capture_id).unwrap();}
        assert!(store.prepare_guarded_host_intent(&client,&command,&guard).is_err());
        assert!(store.prepare_rejected_guarded_host_intent(&client,&command,&guard.capture_id,HostRejectionCode::SourceCaptureExpired).is_err());
        assert_eq!(store.host_intent_for_operation(&command.operation_id).unwrap(),None);
        assert_eq!(store.host_source_capture_usage().unwrap(),if pending {(1,8)}else{(0,0)});
    }
}
