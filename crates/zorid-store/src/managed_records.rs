//! Host-only managed records using the common immutable family ledger.
//!
//! Integration: register SCHEMA in BOTH Store schema iterators; export public
//! types below; add zorid-records dependency. Family::Records is format 1, with
//! no file summary/text binding. The common dispatcher invokes from_opened then
//! receive_in_transaction in its IMMEDIATE transaction BEFORE file graph work,
//! and performs its existing check_delivery/compare_cursor in that transaction.
//! No function here commits a receive transaction or advances a second cursor.
use super::family_ledger::{self, EnvelopeKey, EnvelopeMetadata, Family};
use super::*;
use zorid_records::wire::Payload;
use zorid_records::{Command, Id, Operation, Policy, Schema, Scope, State};
use zorid_sync_protocol::{RealmId, UpdateId, VaultId};

const MAX_PAGE: u32 = 64;
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECEIPTS: i64 = 4096;
const MAX_RECEIPT_BYTES: i64 = 16 * 1024 * 1024;
const MAX_RECORDS: i64 = 1024;
const MAX_STATE_BYTES: i64 = 32 * 1024 * 1024;
const MAX_CHANGES: i64 = 65536;
const MAX_RETRY_COUNT: u32 = 16;
const MAX_RETRY_BYTES: usize = 1024 * 1024;

/// Exact proposed SQL. No parallel outbox, wire copy, or cursor table.
pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("managed_collections", "CREATE TABLE managed_collections (collection_key TEXT PRIMARY KEY, revision TEXT NOT NULL, registration BLOB NOT NULL CHECK(length(registration) BETWEEN 1 AND 1048576), retry_after TEXT)"),
    ("managed_records", "CREATE TABLE managed_records (collection_key TEXT NOT NULL, record_key TEXT NOT NULL, state BLOB NOT NULL CHECK(length(state) BETWEEN 1 AND 1048576), projection BLOB NOT NULL CHECK(length(projection) BETWEEN 1 AND 1048576), PRIMARY KEY(collection_key,record_key), FOREIGN KEY(collection_key) REFERENCES managed_collections(collection_key))"),
    ("managed_changes", "CREATE TABLE managed_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, collection_key TEXT NOT NULL, record_key TEXT NOT NULL, update_id TEXT NOT NULL, status TEXT NOT NULL)"),
    ("managed_receipts", "CREATE TABLE managed_receipts (realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, update_id TEXT NOT NULL, collection_key TEXT NOT NULL, record_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','waiting_dependencies','waiting_restore_source','missing_registration','incompatible_schema','policy_mismatch','invalid_operation','capacity','integrity_conflict')), payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 1048576), PRIMARY KEY(realm_id,vault_id,update_id), FOREIGN KEY(realm_id,vault_id,update_id) REFERENCES sync_envelopes(realm_id,vault_id,update_id))"),
    ("managed_operation_sources", "CREATE TABLE managed_operation_sources (collection_key TEXT NOT NULL, record_key TEXT NOT NULL, operation_id TEXT NOT NULL, content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 1048576), realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, update_id TEXT NOT NULL, PRIMARY KEY(collection_key,record_key,operation_id,realm_id,vault_id,update_id))"),
    // Host operation IDs are deliberately collection-scoped for retry-target misuse detection.
    ("managed_local_operations", "CREATE TABLE managed_local_operations (collection_key TEXT NOT NULL, operation_id TEXT NOT NULL, request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 2097152), result BLOB NOT NULL CHECK(length(result) BETWEEN 1 AND 2097152), PRIMARY KEY(collection_key,operation_id))"),
    ("managed_receipts_retry", "CREATE INDEX managed_receipts_retry ON managed_receipts(collection_key,update_id,status)"),
    ("managed_records_listing", "CREATE INDEX managed_records_listing ON managed_records(collection_key,record_key)"),
    ("managed_changes_listing", "CREATE INDEX managed_changes_listing ON managed_changes(collection_key,sequence)"),
];

/// Native trusted host input, not a sandbox or remote registration protocol.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedRegistration {
    pub realm: Id,
    pub vault: Id,
    pub owner: Id,
    pub schema: Schema,
}
/// Private fields prevent serde/caller strings from manufacturing authority.
/// Handles expire on reopen and registration change, including in another process.
#[derive(Clone, Debug)]
pub struct ManagedCollection {
    store: OperationId,
    process: OperationId,
    key: String,
    revision: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedRevision(Sha256Digest);
/// Target identity is explicit; collection authority always derives from handle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedTarget {
    pub record: Id,
    pub generation: Id,
    pub restores: Option<Id>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManagedSnapshot {
    pub scope: Scope,
    pub revision: ManagedRevision,
    /// Complete canonical operation history, not winner-only export.
    pub state: String,
    pub projection: serde_json::Value,
    pub unresolved: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManagedCommit {
    pub operation: Id,
    pub revision: ManagedRevision,
    pub sequence: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedChange {
    pub sequence: String,
    pub record_key: String,
    pub update_id: String,
    pub status: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManagedChangePage {
    pub changes: Vec<ManagedChange>,
    pub next: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManagedExportPage {
    pub records: Vec<ManagedSnapshot>,
    pub next: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedRetryPage {
    pub examined: u32,
    pub bytes: u32,
    pub next: Option<String>,
    pub statuses: Vec<(String, String)>,
    /// Last examined is `next`, including blocked rows. At EOF the durable
    /// continuation resets so the next pass revisits earlier dependencies.
    pub exhausted: bool,
}
fn invalid(reason: &str) -> StoreError {
    ContractError::InvalidMutation {
        reason: reason.into(),
    }
    .into()
}
fn engine(error: zorid_records::Error) -> StoreError {
    invalid(&format!("managed records: {error:?}"))
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}
fn collection_key(realm: &Id, vault: &Id, owner: &Id, collection: &Id) -> Result<String> {
    Ok(serde_json::to_string(&(realm, vault, owner, collection))?)
}
// Restores is immutable scope metadata, NEVER an alternate primary key.
fn scope_key(scope: &Scope) -> Result<String> {
    Ok(serde_json::to_string(&(&scope.record, &scope.generation))?)
}
fn target_scope(registration: &ManagedRegistration, target: &ManagedTarget) -> Scope {
    Scope {
        realm: registration.realm.clone(),
        vault: registration.vault.clone(),
        owner: registration.owner.clone(),
        collection: registration.schema.collection.clone(),
        record: target.record.clone(),
        generation: target.generation.clone(),
        restores: target.restores.clone(),
    }
}
fn registered(tx: &Connection, key: &str) -> Result<Option<(String, ManagedRegistration)>> {
    let raw: Option<(String, Vec<u8>)> = tx
        .query_row(
            "SELECT revision,registration FROM managed_collections WHERE collection_key=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    raw.map(|(revision, bytes)| Ok((revision, serde_json::from_slice(&bytes)?)))
        .transpose()
}
fn require_enrolled(tx: &Connection, realm: &Id, vault: &Id) -> Result<()> {
    let authority = text_sync::identity(tx)?;
    if authority.realm_id.as_ref().map(RealmId::as_str) != Some(realm.as_str())
        || authority.vault_id.as_ref().map(VaultId::as_str) != Some(vault.as_str())
    {
        return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
    }
    if blob_index::load_metadata(
        tx,
        &zorid_file_sync::Scope {
            realm_id: RealmId::new(realm.as_str())?,
            vault_id: VaultId::new(vault.as_str())?,
        },
    )?
    .is_none()
    {
        return Err(invalid("managed vault is not enrolled"));
    }
    Ok(())
}
fn authorize(
    tx: &Connection,
    process: &OperationId,
    handle: &ManagedCollection,
) -> Result<ManagedRegistration> {
    if &handle.process != process || text_sync::identity(tx)?.local_store_id != handle.store {
        return Err(invalid("managed handle belongs to another Store instance"));
    }
    let (revision, registration) =
        registered(tx, &handle.key)?.ok_or_else(|| invalid("managed registration missing"))?;
    if revision != handle.revision {
        return Err(invalid("stale managed registration"));
    }
    require_enrolled(tx, &registration.realm, &registration.vault)?;
    Ok(registration)
}
fn check_scope(registration: &ManagedRegistration, scope: &Scope) -> Result<()> {
    if registration.realm != scope.realm
        || registration.vault != scope.vault
        || registration.owner != scope.owner
        || registration.schema.collection != scope.collection
    {
        return Err(invalid("managed collection scope mismatch"));
    }
    // Revalidate deserializable IDs and restore/generation invariants via core.
    State::new(registration.schema.clone(), scope.clone()).map_err(engine)?;
    Ok(())
}
fn load(
    tx: &Connection,
    key: &str,
    registration: &ManagedRegistration,
    scope: &Scope,
) -> Result<State> {
    check_scope(registration, scope)?;
    let bytes: Option<Vec<u8>> = tx
        .query_row(
            "SELECT state FROM managed_records WHERE collection_key=?1 AND record_key=?2",
            params![key, scope_key(scope)?],
            |r| r.get(0),
        )
        .optional()?;
    let state = match bytes {
        Some(bytes) => State::restore(registration.schema.clone(), &bytes).map_err(engine)?,
        None => State::new(registration.schema.clone(), scope.clone()).map_err(engine)?,
    };
    if scope_key(state.scope())? != scope_key(scope)? {
        return Err(StoreError::Corrupt(
            "managed accepted state key mismatch".into(),
        ));
    }
    if state.scope() != scope {
        return Err(invalid(
            "managed generation has different immutable scope metadata",
        ));
    }
    if !state.projection().map_err(engine)?.pending.is_empty() {
        return Err(StoreError::Corrupt(
            "incomplete managed accepted state".into(),
        ));
    }
    Ok(state)
}
fn projection(state: &State) -> Result<serde_json::Value> {
    let p = state.projection().map_err(engine)?;
    let fields: std::collections::BTreeMap<_, _> = p
        .fields
        .iter()
        .map(|(id, candidates)| {
            (
                id.as_str(),
                candidates
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "operation": c.operation, "cell": c.cell,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    Ok(serde_json::json!({"created":p.created,"deleted":p.deleted,"fields":fields,"sets":p.sets}))
}
fn snapshot(
    tx: &Connection,
    key: &str,
    registration: &ManagedRegistration,
    scope: &Scope,
) -> Result<ManagedSnapshot> {
    let state = load(tx, key, registration, scope)?;
    let bytes = state.snapshot().map_err(engine)?;
    let unresolved = tx.prepare("SELECT status,count(*) FROM managed_receipts WHERE collection_key=?1 AND record_key=?2 AND status!='accepted' GROUP BY status")?
        .query_map(params![key, scope_key(scope)?], |r| Ok((r.get::<_,String>(0)?, r.get::<_,i64>(1)?.to_string())))?
        .collect::<std::result::Result<_,_>>()?;
    Ok(ManagedSnapshot {
        scope: scope.clone(),
        revision: ManagedRevision(Sha256Digest::of(&bytes)),
        state: String::from_utf8(bytes)
            .map_err(|_| StoreError::Corrupt("managed snapshot is not UTF8".into()))?,
        projection: projection(&state)?,
        unresolved,
    })
}
fn limit_page(limit: u32) -> Result<()> {
    if !(1..=MAX_PAGE).contains(&limit) {
        return Err(invalid("managed page limit must be 1..=64"));
    }
    Ok(())
}
fn decimal(value: &str) -> Result<i64> {
    let parsed = value
        .parse::<i64>()
        .map_err(|_| invalid("invalid managed decimal sequence"))?;
    if parsed < 0 || parsed.to_string() != value {
        return Err(invalid("invalid managed decimal sequence"));
    }
    Ok(parsed)
}
fn change(tx: &Connection, key: &str, record: &str, update: &str, status: &str) -> Result<String> {
    let count: i64 = tx.query_row("SELECT count(*) FROM managed_changes", [], |r| r.get(0))?;
    if count >= MAX_CHANGES {
        return Err(invalid("managed change quota exhausted"));
    }
    tx.execute("INSERT INTO managed_changes(collection_key,record_key,update_id,status) VALUES(?1,?2,?3,?4)", params![key, record, update, status])?;
    Ok(tx.last_insert_rowid().to_string())
}
fn write_state(tx: &Connection, key: &str, record: &str, state: &State) -> Result<()> {
    if !state.projection().map_err(engine)?.pending.is_empty() {
        return Err(invalid("cannot publish incomplete record"));
    }
    let bytes = state.snapshot().map_err(engine)?;
    let derived = encode(&projection(state)?)?;
    if derived.len() > zorid_records::MAX_BYTES {
        return Err(invalid("managed projection too large"));
    }
    let (count, used, old): (i64, i64, i64) = tx.query_row(
        "SELECT count(*),coalesce(sum(length(state)+length(projection)),0),coalesce((SELECT length(state)+length(projection) FROM managed_records WHERE collection_key=?1 AND record_key=?2),0) FROM managed_records",
        params![key, record], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    if (old == 0 && count >= MAX_RECORDS)
        || used - old + bytes.len() as i64 + derived.len() as i64 > MAX_STATE_BYTES
    {
        return Err(invalid("managed state quota exhausted"));
    }
    tx.execute("INSERT INTO managed_records(collection_key,record_key,state,projection) VALUES(?1,?2,?3,?4) ON CONFLICT(collection_key,record_key) DO UPDATE SET state=excluded.state,projection=excluded.projection", params![key, record, bytes, derived])?;
    Ok(())
}
fn check_restore(
    tx: &Connection,
    key: &str,
    registration: &ManagedRegistration,
    scope: &Scope,
) -> Result<bool> {
    let Some(old) = &scope.restores else {
        return Ok(true);
    };
    let record = serde_json::to_string(&(&scope.record, old))?;
    let bytes: Option<Vec<u8>> = tx
        .query_row(
            "SELECT state FROM managed_records WHERE collection_key=?1 AND record_key=?2",
            params![key, record],
            |r| r.get(0),
        )
        .optional()?;
    let Some(bytes) = bytes else {
        return Ok(false);
    };
    let state = State::restore(registration.schema.clone(), &bytes).map_err(engine)?;
    let prior = state.scope();
    if prior.realm != scope.realm
        || prior.vault != scope.vault
        || prior.owner != scope.owner
        || prior.collection != scope.collection
        || prior.record != scope.record
        || &prior.generation != old
    {
        return Err(StoreError::Corrupt(
            "managed restore source identity mismatch".into(),
        ));
    }
    let projection = state.projection().map_err(engine)?;
    if !projection.pending.is_empty() {
        return Err(StoreError::Corrupt(
            "incomplete managed restore source".into(),
        ));
    }
    Ok(projection.created && projection.deleted)
}
fn metadata(payload: &Payload, bytes: &[u8]) -> Result<EnvelopeMetadata> {
    Ok(EnvelopeMetadata {
        key: EnvelopeKey {
            realm_id: RealmId::new(payload.scope().realm.as_str())?,
            vault_id: VaultId::new(payload.scope().vault.as_str())?,
            update_id: UpdateId::new(payload.id().as_str())?,
        },
        family: Family::Records,
        format_version: 1,
        payload_digest: Sha256Digest::of(bytes),
        payload_bytes: u32::try_from(bytes.len())
            .map_err(|_| invalid("managed payload too large"))?,
        file_summary_digest: None,
        text_binding: None,
    })
}

impl Store {
    pub fn managed_register(
        &mut self,
        registration: &ManagedRegistration,
    ) -> Result<ManagedCollection> {
        registration.schema.validate().map_err(engine)?;
        // Validate all host-supplied scope IDs before storing a trusted registration.
        check_scope(
            registration,
            &Scope {
                realm: registration.realm.clone(),
                vault: registration.vault.clone(),
                owner: registration.owner.clone(),
                collection: registration.schema.collection.clone(),
                record: Id::new("registration-validation").map_err(engine)?,
                generation: Id::new("registration-validation").map_err(engine)?,
                restores: None,
            },
        )?;
        let bytes = encode(registration)?;
        if bytes.len() > zorid_records::MAX_BYTES {
            return Err(invalid("managed registration too large"));
        }
        let key = collection_key(
            &registration.realm,
            &registration.vault,
            &registration.owner,
            &registration.schema.collection,
        )?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_enrolled(&tx, &registration.realm, &registration.vault)?;
        let revision = if let Some((revision, old)) = registered(&tx, &key)? {
            if encode(&old)? == bytes {
                revision
            } else {
                if old.schema.policy != registration.schema.policy {
                    return Err(invalid("managed policy cannot be converted"));
                }
                // A schema replacement must revalidate EVERY accepted state. It
                // may not relabel old operations or change an existing field type.
                if registration.schema.version <= old.schema.version
                    || old
                        .schema
                        .fields
                        .iter()
                        .any(|(id, field)| registration.schema.fields.get(id) != Some(field))
                {
                    return Err(invalid("managed schema update must be additive"));
                }
                {
                    let mut statement = tx.prepare(
                        "SELECT state FROM managed_records WHERE collection_key=?1 LIMIT 1025",
                    )?;
                    let states = statement.query_map([&key], |r| r.get::<_, Vec<u8>>(0))?;
                    for bytes in states {
                        State::restore(registration.schema.clone(), &bytes?).map_err(engine)?;
                    }
                }
                let revision = uuid::Uuid::new_v4().to_string();
                tx.execute("UPDATE managed_collections SET revision=?2,registration=?3 WHERE collection_key=?1", params![key, revision, bytes])?;
                revision
            }
        } else {
            let count: i64 =
                tx.query_row("SELECT count(*) FROM managed_collections", [], |r| r.get(0))?;
            if count >= 128 {
                return Err(invalid("managed registration quota exhausted"));
            }
            let revision = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO managed_collections(collection_key,revision,registration) VALUES(?1,?2,?3)", params![key, revision, bytes])?;
            revision
        };
        retry_in_transaction(&tx, &key, registration, None, MAX_RETRY_COUNT)?;
        let store = text_sync::identity(&tx)?.local_store_id;
        tx.commit()?;
        Ok(ManagedCollection {
            store,
            process: self.document_query_owner.clone(),
            key,
            revision,
        })
    }
    pub fn managed_snapshot(
        &self,
        handle: &ManagedCollection,
        target: &ManagedTarget,
    ) -> Result<ManagedSnapshot> {
        let tx = self.connection.unchecked_transaction()?;
        let registration = authorize(&tx, &self.document_query_owner, handle)?;
        let value = snapshot(
            &tx,
            &handle.key,
            &registration,
            &target_scope(&registration, target),
        )?;
        tx.commit()?;
        Ok(value)
    }
    pub fn managed_apply(
        &mut self,
        handle: &ManagedCollection,
        target: &ManagedTarget,
        operation: Id,
        expected: &ManagedRevision,
        command: Command,
    ) -> Result<ManagedCommit> {
        let process = self.document_query_owner.clone();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let registration = authorize(&tx, &process, handle)?;
        let resolved_scope = target_scope(&registration, target);
        let scope = &resolved_scope;
        check_scope(&registration, scope)?;
        let request = encode(&(scope, expected, &command))?;
        if request.len() > MAX_PAGE_BYTES {
            return Err(invalid("managed request too large"));
        }
        let prior: Option<(Vec<u8>, Vec<u8>)> = tx.query_row("SELECT request,result FROM managed_local_operations WHERE collection_key=?1 AND operation_id=?2", params![handle.key, operation.as_str()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((old, result)) = prior {
            if old != request {
                return Err(invalid("managed local operation identity collision"));
            }
            let result = serde_json::from_slice(&result)?;
            tx.commit()?;
            return Ok(result);
        }
        let state = load(&tx, &handle.key, &registration, scope)?;
        if Sha256Digest::of(&state.snapshot().map_err(engine)?) != expected.0 {
            return Err(invalid("stale managed revision"));
        }
        if !check_restore(&tx, &handle.key, &registration, scope)? {
            return Err(invalid("managed restore lacks accepted prior tombstone"));
        }
        let prepared = state.prepare(operation.clone(), command).map_err(engine)?;
        let payload =
            Payload::from_intent(operation.clone(), prepared.payload()).map_err(engine)?;
        let plaintext = payload.encode().map_err(engine)?;
        if plaintext.len() > zorid_sync_protocol::MAX_PLAINTEXT_BYTES {
            return Err(invalid("managed wrapped payload exceeds transport bound"));
        }
        // A remote-authored ID cannot be reused as a new local receipt.
        if state.history().contains_key(&operation)
            || has_source(&tx, &handle.key, scope, &operation)?
        {
            return Err(invalid("managed operation already has another source"));
        }
        let source_count: i64 =
            tx.query_row("SELECT count(*) FROM managed_local_operations", [], |r| {
                r.get(0)
            })?;
        let source_bytes: i64 = tx.query_row(
            "SELECT coalesce(sum(length(request)+length(result)),0) FROM managed_local_operations",
            [],
            |r| r.get(0),
        )?;
        if source_count >= MAX_RECEIPTS
            || source_bytes + request.len() as i64 + 4096 > MAX_RECEIPT_BYTES
        {
            return Err(invalid("managed local replay quota exhausted"));
        }
        write_state(&tx, &handle.key, &scope_key(scope)?, prepared.next())?;
        bind_sources(&tx, &handle.key, &payload)?;
        let sequence = change(
            &tx,
            &handle.key,
            &scope_key(scope)?,
            operation.as_str(),
            "accepted",
        )?;
        if registration.schema.policy == Policy::Synced {
            family_ledger::insert_authored(&tx, &metadata(&payload, &plaintext)?, &plaintext)?;
        }
        let result = ManagedCommit {
            operation: operation.clone(),
            revision: ManagedRevision(Sha256Digest::of(
                &prepared.next().snapshot().map_err(engine)?,
            )),
            sequence,
        };
        tx.execute("INSERT INTO managed_local_operations(collection_key,operation_id,request,result) VALUES(?1,?2,?3,?4)", params![handle.key, operation.as_str(), request, encode(&result)?])?;
        retry_in_transaction(&tx, &handle.key, &registration, None, MAX_RETRY_COUNT)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn managed_changes(
        &self,
        handle: &ManagedCollection,
        after: &str,
        limit: u32,
    ) -> Result<ManagedChangePage> {
        limit_page(limit)?;
        let after = decimal(after)?;
        let tx = self.connection.unchecked_transaction()?;
        authorize(&tx, &self.document_query_owner, handle)?;
        let changes: Vec<ManagedChange> = tx.prepare("SELECT sequence,record_key,update_id,status FROM managed_changes WHERE collection_key=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?
            .query_map(params![handle.key, after, limit], |r| Ok(ManagedChange { sequence: r.get::<_,i64>(0)?.to_string(), record_key:r.get(1)?, update_id:r.get(2)?, status:r.get(3)? }))?
            .collect::<std::result::Result<_,_>>()?;
        let next = changes
            .last()
            .map(|c| c.sequence.clone())
            .unwrap_or_else(|| after.to_string());
        tx.commit()?;
        Ok(ManagedChangePage { changes, next })
    }
    /// Bounded stable-scope listing is the initial host-owned query. No SQL or
    /// task/calendar predicate language crosses this internal API.
    pub fn managed_export(
        &self,
        handle: &ManagedCollection,
        after: Option<&str>,
        limit: u32,
    ) -> Result<ManagedExportPage> {
        limit_page(limit)?;
        if after.is_some_and(|s| s.len() > 2048) {
            return Err(invalid("managed export cursor too large"));
        }
        let tx = self.connection.unchecked_transaction()?;
        let registration = authorize(&tx, &self.document_query_owner, handle)?;
        let keys: Vec<String> = tx.prepare("SELECT record_key FROM managed_records WHERE collection_key=?1 AND (?2 IS NULL OR record_key>?2) ORDER BY record_key LIMIT ?3")?
            .query_map(params![handle.key, after, limit], |r|r.get(0))?.collect::<std::result::Result<_,_>>()?;
        let mut records = Vec::new();
        let mut bytes = 0;
        let mut next = None;
        for key in keys {
            let state: Vec<u8> = tx.query_row(
                "SELECT state FROM managed_records WHERE collection_key=?1 AND record_key=?2",
                params![handle.key, key],
                |r| r.get(0),
            )?;
            let restored = State::restore(registration.schema.clone(), &state).map_err(engine)?;
            if scope_key(restored.scope())? != key {
                return Err(StoreError::Corrupt("managed export key mismatch".into()));
            }
            let scope = restored.scope();
            let item = snapshot(&tx, &handle.key, &registration, scope)?;
            let size = encode(&item)?.len();
            if bytes + size > MAX_PAGE_BYTES {
                if records.is_empty() {
                    return Err(invalid("managed export item exceeds page budget"));
                }
                break;
            }
            bytes += size;
            records.push(item);
            next = Some(key);
        }
        tx.commit()?;
        Ok(ManagedExportPage { records, next })
    }
    pub fn managed_retry_unresolved(
        &mut self,
        handle: &ManagedCollection,
        after: Option<&str>,
        limit: u32,
    ) -> Result<ManagedRetryPage> {
        if !(1..=MAX_RETRY_COUNT).contains(&limit)
            || after.is_some_and(|s| s.len() > zorid_records::MAX_ID)
        {
            return Err(invalid("managed retry limit/cursor invalid"));
        }
        let process = self.document_query_owner.clone();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let registration = authorize(&tx, &process, handle)?;
        let page = retry_in_transaction(&tx, &handle.key, &registration, after, limit)?;
        tx.commit()?;
        Ok(page)
    }
}

/// Invoked after registration, accepted parent/local commits, and by the host on
/// startup/foreground. A persisted round-robin continuation prevents a blocked
/// prefix from monopolizing every bounded pass. No notification is required.
fn retry_in_transaction(
    tx: &Connection,
    collection: &str,
    registration: &ManagedRegistration,
    explicit_after: Option<&str>,
    limit: u32,
) -> Result<ManagedRetryPage> {
    let retained: Option<String> = tx.query_row(
        "SELECT retry_after FROM managed_collections WHERE collection_key=?1",
        [collection],
        |r| r.get(0),
    )?;
    let after = explicit_after.or(retained.as_deref());
    let heads: Vec<(String, i64)> = tx.prepare("SELECT update_id,payload_bytes FROM managed_receipts WHERE collection_key=?1 AND status NOT IN ('accepted','integrity_conflict','invalid_operation') AND (?2 IS NULL OR update_id>?2) ORDER BY update_id LIMIT ?3")?
            .query_map(params![collection, after, limit + 1], |r|Ok((r.get(0)?,r.get(1)?)))?.collect::<std::result::Result<_,_>>()?;
    let mut page = ManagedRetryPage {
        examined: 0,
        bytes: 0,
        next: None,
        statuses: Vec::new(),
        exhausted: true,
    };
    for (id, size) in heads {
        if page.examined == limit {
            page.exhausted = false;
            break;
        }
        if size <= 0 || size as usize > MAX_RETRY_BYTES {
            return Err(StoreError::Corrupt("managed receipt length invalid".into()));
        }
        if page.bytes as usize + size as usize > MAX_RETRY_BYTES {
            page.exhausted = false;
            break;
        }
        let key = EnvelopeKey {
            realm_id: RealmId::new(registration.realm.as_str())?,
            vault_id: VaultId::new(registration.vault.as_str())?,
            update_id: UpdateId::new(&id)?,
        };
        let source = family_ledger::metadata_only(&tx, &key)?
            .ok_or_else(|| StoreError::Corrupt("managed receipt lacks ledger".into()))?;
        let bytes = immutable_payloads::read_exact(&tx, &source.metadata)?;
        if bytes.len() != size as usize {
            return Err(StoreError::Corrupt(
                "managed receipt size differs from source".into(),
            ));
        }
        let payload = Payload::decode(&bytes).map_err(engine)?;
        // Recheck retained source identity, not only the receipt's collection.
        if metadata(&payload, &bytes)? != source.metadata {
            return Err(StoreError::Corrupt(
                "managed retry source identity mismatch".into(),
            ));
        }
        let status = activate(&tx, collection, &payload)?;
        transition(&tx, &key, collection, &scope_key(payload.scope())?, &status)?;
        page.examined += 1;
        page.bytes += size as u32;
        page.next = Some(id.clone());
        page.statuses.push((id, status));
    }

    tx.execute(
        "UPDATE managed_collections SET retry_after=?2 WHERE collection_key=?1",
        params![
            collection,
            if page.exhausted {
                None
            } else {
                page.next.as_deref()
            }
        ],
    )?;
    Ok(page)
}
pub(super) fn pending_count(tx: &Connection) -> Result<u32> {
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM managed_receipts WHERE status!='accepted'",
        [],
        |r| r.get(0),
    )?;
    u32::try_from(count).map_err(|_| StoreError::Corrupt("managed receipt count overflow".into()))
}

/// Only the Store dispatcher can construct this capability, and only from an
/// authenticated OpenedEnvelope. Wire parsing alone grants no authority.
pub(super) struct AuthenticatedRecords {
    payload: Payload,
    exact: Vec<u8>,
    exact_wire: Vec<u8>,
}
impl AuthenticatedRecords {
    pub(super) fn from_opened(opened: &zorid_crypto::OpenedEnvelope) -> Result<Self> {
        let payload = Payload::decode(opened.plaintext()).map_err(engine)?;
        payload
            .check_context(
                opened.header().realm_id().as_str(),
                opened.header().vault_id().as_str(),
                opened.header().update_id().as_str(),
            )
            .map_err(engine)?;
        Ok(Self {
            payload,
            exact: opened.plaintext().to_vec(),
            exact_wire: opened.envelope().encode(),
        })
    }
    pub(super) fn metadata(&self) -> Result<EnvelopeMetadata> {
        metadata(&self.payload, &self.exact)
    }
}
fn has_source(tx: &Connection, key: &str, scope: &Scope, id: &Id) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM managed_operation_sources WHERE collection_key=?1 AND record_key=?2 AND operation_id=?3)",params![key,scope_key(scope)?,id.as_str()],|r|r.get(0))?)
}
fn bind_sources(tx: &Connection, key: &str, payload: &Payload) -> Result<()> {
    let used: i64 = tx.query_row(
        "SELECT coalesce(sum(length(content)),0) FROM managed_operation_sources",
        [],
        |r| r.get(0),
    )?;
    let added = payload
        .operations()
        .iter()
        .map(encode)
        .collect::<Result<Vec<_>>>()?
        .iter()
        .map(Vec::len)
        .sum::<usize>();
    if used + added as i64 > MAX_RECEIPT_BYTES {
        return Err(invalid("managed operation source quota exhausted"));
    }
    for operation in payload.operations() {
        tx.execute("INSERT INTO managed_operation_sources(collection_key,record_key,operation_id,content,realm_id,vault_id,update_id) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![key, scope_key(payload.scope())?, operation.id.as_str(), encode(operation)?, payload.scope().realm.as_str(), payload.scope().vault.as_str(), payload.id().as_str()])?;
    }
    Ok(())
}
fn equivocated(tx: &Connection, key: &str, operations: &[Operation]) -> Result<bool> {
    for operation in operations {
        let differs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM managed_operation_sources WHERE collection_key=?1 AND record_key=?2 AND operation_id=?3 AND content!=?4)", params![key, scope_key(&operation.scope)?, operation.id.as_str(), encode(operation)?], |r|r.get(0))?;
        if differs {
            return Ok(true);
        }
    }
    Ok(false)
}
fn transition(
    tx: &Connection,
    key: &EnvelopeKey,
    collection: &str,
    record: &str,
    status: &str,
) -> Result<()> {
    let old: String = tx.query_row(
        "SELECT status FROM managed_receipts WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![
            key.realm_id.as_str(),
            key.vault_id.as_str(),
            key.update_id.as_str()
        ],
        |r| r.get(0),
    )?;
    if old != status {
        tx.execute("UPDATE managed_receipts SET status=?4 WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3", params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str(),status])?;
        change(tx, collection, record, key.update_id.as_str(), status)?;
    }
    Ok(())
}
fn activate(tx: &Connection, key: &str, payload: &Payload) -> Result<String> {
    if equivocated(tx, key, payload.operations())? {
        return Ok("integrity_conflict".into());
    }
    let Some((_, registration)) = registered(tx, key)? else {
        return Ok("missing_registration".into());
    };
    if registration.schema.policy != Policy::Synced {
        return Ok("policy_mismatch".into());
    }
    if payload
        .operations()
        .iter()
        .any(|op| op.schema_version != registration.schema.version)
    {
        return Ok("incompatible_schema".into());
    }
    // Same generation cannot be split by conflicting restores metadata.
    let prior: Option<Vec<u8>> = tx
        .query_row(
            "SELECT state FROM managed_records WHERE collection_key=?1 AND record_key=?2",
            params![key, scope_key(payload.scope())?],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(bytes) = prior {
        let state = State::restore(registration.schema.clone(), &bytes).map_err(engine)?;
        if state.scope() != payload.scope() {
            return Ok("integrity_conflict".into());
        }
    }
    let mut state = load(tx, key, &registration, payload.scope())?;
    // Structural/semantic invalidity is retained without touching accepted state.
    if !check_restore(tx, key, &registration, payload.scope())? {
        return Ok("waiting_restore_source".into());
    }
    match state.union(payload.operations()) {
        Err(zorid_records::Error::Limit) => return Ok("capacity".into()),
        Err(_) => return Ok("invalid_operation".into()),
        Ok(()) => (),
    }
    if !state.projection().map_err(engine)?.pending.is_empty() {
        return Ok("waiting_dependencies".into());
    }
    // A finite state quota becomes a durable unresolved reason; SQL/IO errors
    // still abort the enclosing exact receipt+cursor commit.
    let bytes = state.snapshot().map_err(engine)?;
    let derived = encode(&projection(&state)?)?;
    let (count, used, old):(i64,i64,i64) = tx.query_row("SELECT count(*),coalesce(sum(length(state)+length(projection)),0),coalesce((SELECT length(state)+length(projection) FROM managed_records WHERE collection_key=?1 AND record_key=?2),0) FROM managed_records", params![key,scope_key(payload.scope())?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if derived.len() > zorid_records::MAX_BYTES
        || (old == 0 && count >= MAX_RECORDS)
        || used - old + bytes.len() as i64 + derived.len() as i64 > MAX_STATE_BYTES
    {
        return Ok("capacity".into());
    }
    write_state(tx, key, &scope_key(payload.scope())?, &state)?;
    Ok("accepted".into())
}
/// Returns (exact_duplicate, durable_status). Caller MUST check delivery, invoke
/// this helper, CAS the shared cursor and commit in ONE IMMEDIATE transaction.
pub(super) fn receive_in_transaction(
    tx: &Connection,
    incoming: &AuthenticatedRecords,
    authenticated_metadata: &EnvelopeMetadata,
    exact_wire: &[u8],
) -> Result<(bool, String)> {
    let payload = &incoming.payload;
    require_enrolled(tx, &payload.scope().realm, &payload.scope().vault)?;
    let metadata = incoming.metadata()?;
    if exact_wire != incoming.exact_wire {
        return Err(invalid(
            "managed wire is not authenticated capability source",
        ));
    }
    if &metadata != authenticated_metadata {
        return Err(invalid("managed authenticated metadata mismatch"));
    }
    let collection = collection_key(
        &payload.scope().realm,
        &payload.scope().vault,
        &payload.scope().owner,
        &payload.scope().collection,
    )?;
    let record = scope_key(payload.scope())?;
    if let Some(wire) = family_ledger::wire(tx, &metadata.key)? {
        if wire.metadata != metadata || wire.exact_wire != exact_wire {
            return Err(zorid_client_sync::SyncError::DedupeMismatch.into());
        }
        // Self echo has no received receipt; authored state/change already exist.
        let receipt: Option<(String,String,String,i64)> = tx.query_row("SELECT status,collection_key,record_key,payload_bytes FROM managed_receipts WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3", params![metadata.key.realm_id.as_str(),metadata.key.vault_id.as_str(),metadata.key.update_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if receipt.as_ref().is_some_and(|(_, c, r, n)| {
            c != &collection || r != &record || *n != incoming.exact.len() as i64
        }) {
            return Err(StoreError::Corrupt(
                "managed duplicate receipt binding differs from plaintext".into(),
            ));
        }
        if immutable_payloads::read_exact(tx, &metadata)? != incoming.exact {
            return Err(StoreError::Corrupt(
                "managed duplicate source differs from authenticated plaintext".into(),
            ));
        }
        let status = receipt.map(|(status, _, _, _)| status);
        if status.is_none() && wire.direction != family_ledger::Direction::Authored {
            return Err(StoreError::Corrupt(
                "managed wire lacks durable receipt".into(),
            ));
        }
        family_ledger::authored(tx, &metadata.key)?;
        return Ok((true, status.unwrap_or_else(|| "accepted".into())));
    }
    let (count, bytes): (i64, i64) = tx.query_row(
        "SELECT count(*),coalesce(sum(payload_bytes),0) FROM managed_receipts",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let source_bytes: i64 = tx.query_row(
        "SELECT coalesce(sum(length(content)),0) FROM managed_operation_sources",
        [],
        |r| r.get(0),
    )?;
    let added_source = payload
        .operations()
        .iter()
        .map(encode)
        .collect::<Result<Vec<_>>>()?
        .iter()
        .map(Vec::len)
        .sum::<usize>();
    if count >= MAX_RECEIPTS
        || bytes + incoming.exact.len() as i64 > MAX_RECEIPT_BYTES
        || source_bytes + added_source as i64 > MAX_RECEIPT_BYTES
    {
        return Err(invalid("managed receipt/source quota exhausted"));
    }
    family_ledger::insert_received_exact(tx, &metadata, exact_wire, &incoming.exact)?;
    bind_sources(tx, &collection, payload)?;
    // Once conflicting content exists, every still-waiting fork is permanently
    // quarantined. Accepted state remains retained as observable integrity evidence.
    let conflicts: Vec<(String,String,String,String)> = tx.prepare("SELECT DISTINCT r.realm_id,r.vault_id,r.update_id,r.record_key FROM managed_receipts r JOIN managed_operation_sources s ON s.realm_id=r.realm_id AND s.vault_id=r.vault_id AND s.update_id=r.update_id AND s.record_key=r.record_key AND s.collection_key=r.collection_key WHERE s.collection_key=?1 AND r.status NOT IN ('accepted','integrity_conflict') AND EXISTS(SELECT 1 FROM managed_operation_sources other WHERE other.collection_key=s.collection_key AND other.record_key=s.record_key AND other.operation_id=s.operation_id AND other.content!=s.content)")?
        .query_map([&collection],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect::<std::result::Result<_,_>>()?;
    for (realm, vault, id, record) in conflicts {
        transition(
            tx,
            &EnvelopeKey {
                realm_id: RealmId::new(realm)?,
                vault_id: VaultId::new(vault)?,
                update_id: UpdateId::new(id)?,
            },
            &collection,
            &record,
            "integrity_conflict",
        )?;
    }
    let status = activate(tx, &collection, payload)?;
    tx.execute("INSERT INTO managed_receipts(realm_id,vault_id,update_id,collection_key,record_key,status,payload_bytes) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![metadata.key.realm_id.as_str(),metadata.key.vault_id.as_str(),metadata.key.update_id.as_str(),collection,record,status,incoming.exact.len() as i64])?;
    change(tx, &collection, &record, payload.id().as_str(), &status)?;
    if status == "accepted" {
        if let Some((_, registration)) = registered(tx, &collection)? {
            retry_in_transaction(tx, &collection, &registration, None, MAX_RETRY_COUNT)?;
        }
    }
    Ok((false, status))
}
