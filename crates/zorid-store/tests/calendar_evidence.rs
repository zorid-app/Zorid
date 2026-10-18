//! Receipt-only collection evidence regressions using authenticated real SQLite receipts.
//! Authored source; execution requires the coordinator's bounded validation slot.
use serde::Serialize;
use std::collections::BTreeMap;
use zorid_crypto::{OpenedEnvelope, SystemEntropy, VaultKey};
use zorid_records::wire::Payload;
use zorid_records::{
    Action, Cell, Command, Field, Id, Kind, Operation, Policy, Schema, Scope, Value,
};
use zorid_store::{
    FamilyScope, ManagedCollection, ManagedRegistration, ManagedTarget, ManagedUnresolvedEvidence,
    Store,
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

const STEP_BYTES: u32 = 1024 * 1024;

fn accepted(store: &mut Store, name: &str) {
    let target = ManagedTarget {
        record: id(name),
        generation: id(&format!("create-{name}")),
        restores: None,
    };
    let scope = record_scope(&target);
    let op = operation(
        target.generation.as_str(),
        &scope,
        &[],
        Command::Create(write(name)),
    );
    receive(
        store,
        &wire(&payload(&format!("envelope-{name}"), &scope, &[op])),
    );
}

#[test]
fn receipt_only_waiting_and_incompatible_before_first_state_are_unknown_at_stable_fence() {
    for incompatible in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store");
        let (mut store, handle) = setup(&path, Policy::Synced);
        let scope = record_scope(&target());
        let mut op = if incompatible {
            operation("create", &scope, &[], Command::Create(write("future")))
        } else {
            operation("child", &scope, &["create"], Command::Patch(write("child")))
        };
        if incompatible {
            op.schema_version = 2;
        }
        receive(&mut store, &wire(&payload("receipt-only", &scope, &[op])));
        assert_eq!(
            status(&path, "receipt-only"),
            if incompatible {
                "incompatible_schema"
            } else {
                "waiting_dependencies"
            }
        );
        assert_eq!(count(&path, "managed_records"), 0);
        let watermark = store.managed_watermark(&handle).unwrap();
        assert!(store
            .managed_export(&handle, None, 64)
            .unwrap()
            .records
            .is_empty());
        let result = store
            .managed_unresolved_summary(&handle, &watermark, None, 64, STEP_BYTES)
            .unwrap();
        assert_eq!(result.evidence, ManagedUnresolvedEvidence::Unknown);
        assert!(result.complete);
        assert_eq!(result.examined, 1);
        assert!(result.bytes > 0);
        assert!(result.next.is_none());
        assert_eq!(store.managed_watermark(&handle).unwrap(), watermark);
    }
}

#[test]
fn mixed_records_cannot_prove_absence_and_settlement_requires_explicit_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    accepted(&mut store, "visible");
    let scope = record_scope(&target());
    let child = operation("child", &scope, &["create"], Command::Patch(write("child")));
    receive(&mut store, &wire(&payload("zz-child", &scope, &[child])));
    let exported = store.managed_export(&handle, None, 64).unwrap();
    assert_eq!(exported.records.len(), 1);
    assert!(exported.records[0].unresolved.is_empty());
    let watermark = store.managed_watermark(&handle).unwrap();
    let first = store
        .managed_unresolved_summary(&handle, &watermark, None, 1, STEP_BYTES)
        .unwrap();
    assert_eq!(first.evidence, ManagedUnresolvedEvidence::Unknown);
    assert!(!first.complete);
    let cursor = first.next.unwrap();
    let rest = store
        .managed_unresolved_summary(&handle, &watermark, Some(&cursor), 64, STEP_BYTES)
        .unwrap();
    assert!(rest.complete);
    assert_eq!(rest.evidence, ManagedUnresolvedEvidence::Unknown);
    let parent = operation("create", &scope, &[], Command::Create(write("parent")));
    receive(&mut store, &wire(&payload("parent", &scope, &[parent])));
    store.managed_retry_unresolved(&handle, None, 16).unwrap();
    assert_eq!(status(&path, "zz-child"), "accepted");
    assert!(store
        .managed_unresolved_summary(&handle, &watermark, Some(&cursor), 64, STEP_BYTES)
        .is_err());
    let fresh = store.managed_watermark(&handle).unwrap();
    assert_ne!(fresh, watermark);
    let settled = store
        .managed_unresolved_summary(&handle, &fresh, None, 64, STEP_BYTES)
        .unwrap();
    assert!(settled.complete);
    assert_eq!(settled.evidence, ManagedUnresolvedEvidence::None);
}

#[test]
fn partial_summary_is_unknown_and_receipt_and_byte_budgets_retain_progress() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    for n in 0..65 {
        accepted(&mut store, &format!("r{n:03}"));
    }
    let watermark = store.managed_watermark(&handle).unwrap();
    let first = store
        .managed_unresolved_summary(&handle, &watermark, None, 64, STEP_BYTES)
        .unwrap();
    assert_eq!(first.examined, 64);
    assert!(!first.complete);
    assert_eq!(first.evidence, ManagedUnresolvedEvidence::Unknown);
    let last = store
        .managed_unresolved_summary(&handle, &watermark, first.next.as_ref(), 64, STEP_BYTES)
        .unwrap();
    assert_eq!(last.examined, 1);
    assert!(last.complete);
    assert_eq!(last.evidence, ManagedUnresolvedEvidence::None);
    let one_size: u32 = db(&path)
        .query_row(
            "SELECT payload_bytes FROM managed_receipts ORDER BY update_id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let bounded = store
        .managed_unresolved_summary(&handle, &watermark, None, 64, one_size)
        .unwrap();
    assert_eq!(bounded.examined, 1);
    assert_eq!(bounded.bytes, one_size);
    assert!(!bounded.complete);
    let next = store
        .managed_unresolved_summary(&handle, &watermark, bounded.next.as_ref(), 64, STEP_BYTES)
        .unwrap();
    assert_eq!(next.examined, 64);
    // A full page needs a final empty step to establish EOF.
    let eof = store
        .managed_unresolved_summary(&handle, &watermark, next.next.as_ref(), 64, STEP_BYTES)
        .unwrap();
    assert_eq!(eof.examined, 0);
    assert!(eof.complete);
    assert_eq!(eof.evidence, ManagedUnresolvedEvidence::None);
    for (limit, bytes) in [
        (0, STEP_BYTES),
        (65, STEP_BYTES),
        (64, 0),
        (64, STEP_BYTES + 1),
        (64, one_size - 1),
    ] {
        assert!(store
            .managed_unresolved_summary(&handle, &watermark, None, limit, bytes)
            .is_err());
    }
}

#[test]
fn empty_collection_only_proves_none_in_its_own_authorized_scope() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let child = operation("child", &scope, &["create"], Command::Patch(write("child")));
    receive(&mut store, &wire(&payload("child", &scope, &[child])));
    let watermark = store.managed_watermark(&handle).unwrap();
    let partial = store
        .managed_unresolved_summary(&handle, &watermark, None, 1, STEP_BYTES)
        .unwrap();
    let cursor = partial.next.unwrap();
    let mut other_registration = registration(Policy::Synced);
    other_registration.schema.collection = id("other");
    let other = store.managed_register(&other_registration).unwrap();
    let other_fence = store.managed_watermark(&other).unwrap();
    assert_eq!(other_fence, "0");
    let empty = store
        .managed_unresolved_summary(&other, &other_fence, None, 64, STEP_BYTES)
        .unwrap();
    assert!(empty.complete);
    assert_eq!(empty.evidence, ManagedUnresolvedEvidence::None);
    assert!(store
        .managed_unresolved_summary(&other, &other_fence, Some(&cursor), 64, STEP_BYTES)
        .is_err());
    assert!(store
        .managed_unresolved_summary(&handle, "01", None, 64, STEP_BYTES)
        .is_err());
    assert!(store
        .managed_unresolved_summary(&handle, "0", Some(&cursor), 64, STEP_BYTES)
        .is_err());
    let reopened = Store::open(&path).unwrap();
    assert!(reopened
        .managed_unresolved_summary(&handle, &watermark, None, 64, STEP_BYTES)
        .is_err());
    let mut upgraded = registration(Policy::Synced);
    upgraded.schema.version = 2;
    let fresh = store.managed_register(&upgraded).unwrap();
    assert!(store
        .managed_unresolved_summary(&handle, &watermark, None, 64, STEP_BYTES)
        .is_err());
    let fresh_fence = store.managed_watermark(&fresh).unwrap();
    assert!(store
        .managed_unresolved_summary(&fresh, &fresh_fence, Some(&cursor), 64, STEP_BYTES)
        .is_err());
}

#[test]
fn unresolved_evidence_survives_a_later_all_accepted_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store");
    let (mut store, handle) = setup(&path, Policy::Synced);
    let scope = record_scope(&target());
    let child = operation("child", &scope, &["create"], Command::Patch(write("child")));
    receive(&mut store, &wire(&payload("aaa-child", &scope, &[child])));
    accepted(&mut store, "visible");
    let fence = store.managed_watermark(&handle).unwrap();
    let partial = store
        .managed_unresolved_summary(&handle, &fence, None, 1, STEP_BYTES)
        .unwrap();
    let end = store
        .managed_unresolved_summary(&handle, &fence, partial.next.as_ref(), 64, STEP_BYTES)
        .unwrap();
    assert!(end.complete);
    assert_eq!(end.examined, 1);
    assert_eq!(end.evidence, ManagedUnresolvedEvidence::Unknown);
}
