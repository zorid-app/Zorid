//! Normalized current-format namespace records. These are private transaction
//! primitives, never an API for accepting caller-provided graph states.
use super::family_ledger::{self, EnvelopeKey, EnvelopeMetadata, Family};
use super::*;
use std::collections::BTreeMap;
use zorid_file_sync::v2::{FilePlan, Payload, State, StoredActivity};
use zorid_file_sync::{Scope, MAX_RECORDS, MAX_STATE_BYTES};
use zorid_sync_protocol::UpdateId;

pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("family_graph_heads","CREATE TABLE family_graph_heads (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,revision TEXT NOT NULL,record_count INTEGER NOT NULL CHECK(record_count>=0),activity_count INTEGER NOT NULL CHECK(activity_count>=0),PRIMARY KEY(realm_id,vault_id))"),
    ("family_file_records","CREATE TABLE family_file_records (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,update_id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(realm_id,vault_id,update_id),FOREIGN KEY(realm_id,vault_id) REFERENCES family_graph_heads(realm_id,vault_id))"),
    ("family_text_activities","CREATE TABLE family_text_activities (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,update_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,update_id),FOREIGN KEY(realm_id,vault_id) REFERENCES family_graph_heads(realm_id,vault_id))"),
];
fn corrupt(message: &str) -> StoreError {
    StoreError::Corrupt(message.into())
}
fn key(scope: &Scope, id: &UpdateId) -> EnvelopeKey {
    EnvelopeKey {
        realm_id: scope.realm_id.clone(),
        vault_id: scope.vault_id.clone(),
        update_id: id.clone(),
    }
}

/// Every graph record has an authenticated received ledger row or an immutable
/// validated authored intent. The head must never introduce a second authority.
fn metadata(tx: &Connection, key: &EnvelopeKey) -> Result<EnvelopeMetadata> {
    let authored = family_ledger::authored(tx, key)?;
    if let Some(wire) = family_ledger::wire(tx, key)? {
        return Ok(wire.metadata);
    }
    authored
        .map(|a| a.metadata)
        .ok_or_else(|| corrupt("graph record has no envelope authority"))
}
fn check_file(tx: &Connection, scope: &Scope, id: &UpdateId, raw: &[u8]) -> Result<Payload> {
    let payload = Payload::decode(raw).map_err(|_| corrupt("invalid persisted file payload"))?;
    if payload.scope != *scope || payload.id != *id {
        return Err(corrupt("file record SQL/payload identity mismatch"));
    }
    let meta = metadata(tx, &key(scope, id))?;
    if meta.family != Family::Files || meta.text_binding.is_some() {
        return Err(corrupt("file record envelope family mismatch"));
    }
    meta.check_payload(raw)?;
    Ok(payload)
}
fn check_activity(
    tx: &Connection,
    scope: &Scope,
    id: &UpdateId,
    activity: &StoredActivity,
) -> Result<()> {
    let identity = activity.identity();
    if &identity.realm_id != &scope.realm_id
        || &identity.vault_id != &scope.vault_id
        || activity.update_id() != id
    {
        return Err(corrupt("text activity SQL/record identity mismatch"));
    }
    let meta = metadata(tx, &key(scope, id))?;
    let Some(binding) = meta.text_binding.as_ref() else {
        return Err(corrupt("text activity lacks text envelope binding"));
    };
    if meta.family != Family::Text
        || binding.entry_id != identity.entry_id
        || binding.text_bootstrap_id != identity.bootstrap_id
        || &binding.namespace != activity.namespace()
        || &meta.payload_digest != activity.payload_digest()
        || meta.payload_bytes != activity.payload_bytes()
    {
        return Err(corrupt(
            "text activity differs from authenticated envelope provenance",
        ));
    }
    Ok(())
}

fn check_body_bounds(tx: &Connection, scope: &Scope) -> Result<()> {
    let (total, largest):(i64,i64)=tx.query_row("SELECT coalesce(sum(size),0),coalesce(max(size),0) FROM (SELECT length(payload) AS size FROM family_file_records WHERE realm_id=?1 AND vault_id=?2 UNION ALL SELECT length(CAST(record AS BLOB)) AS size FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2)",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if total < 0
        || total > MAX_STATE_BYTES as i64
        || largest > zorid_sync_protocol::MAX_PLAINTEXT_BYTES as i64
    {
        return Err(corrupt("normalized graph body bound exceeded"));
    }
    Ok(())
}
pub(super) fn load(tx: &Connection, scope: &Scope) -> Result<Option<State>> {
    let head:Option<(String,i64,i64)>=tx.query_row("SELECT revision,record_count,activity_count FROM family_graph_heads WHERE realm_id=?1 AND vault_id=?2",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let counts:(i64,i64)=tx.query_row("SELECT (SELECT count(*) FROM family_file_records WHERE realm_id=?1 AND vault_id=?2),(SELECT count(*) FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2)",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let Some((revision, files, activities)) = head else {
        let retained:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_envelopes WHERE realm_id=?1 AND vault_id=?2 UNION ALL SELECT 1 FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2)",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|r.get(0))?;
        if counts != (0, 0) || retained {
            return Err(corrupt(
                "graph head missing with retained records or envelopes",
            ));
        }
        return Ok(None);
    };
    if files < 0
        || activities < 0
        || counts != (files, activities)
        || files
            .checked_add(activities)
            .is_none_or(|n| n > MAX_RECORDS as i64)
    {
        return Err(corrupt("graph record count mismatch or bound exceeded"));
    }
    check_body_bounds(tx, scope)?;
    let revision = Revision::new(revision)?;
    let mut records = BTreeMap::new();
    let mut statement=tx.prepare("SELECT update_id,payload FROM family_file_records WHERE realm_id=?1 AND vault_id=?2 ORDER BY update_id")?;
    let mut rows = statement.query(params![scope.realm_id.as_str(), scope.vault_id.as_str()])?;
    while let Some(row) = rows.next()? {
        let id = UpdateId::new(row.get::<_, String>(0)?)?;
        let raw = row.get::<_, Vec<u8>>(1)?;
        let payload = check_file(tx, scope, &id, &raw)?;
        if records.insert(id, payload).is_some() {
            return Err(corrupt("duplicate normalized file record"));
        }
    }
    let mut activity_records = BTreeMap::new();
    let mut statement=tx.prepare("SELECT update_id,record FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2 ORDER BY update_id")?;
    let mut rows = statement.query(params![scope.realm_id.as_str(), scope.vault_id.as_str()])?;
    while let Some(row) = rows.next()? {
        let id = UpdateId::new(row.get::<_, String>(0)?)?;
        let activity: StoredActivity = serde_json::from_str(&row.get::<_, String>(1)?)?;
        check_activity(tx, scope, &id, &activity)?;
        if activity_records.insert(id, activity).is_some() {
            return Err(corrupt("duplicate normalized activity"));
        }
    }
    State::from_records(scope.clone(), revision, records, activity_records)
        .map(Some)
        .map_err(|_| corrupt("invalid persisted cross-family graph"))
}

/// Explicit fresh enrollment only; no path or content identity is inferred.
/// The coordinator must reserve the globally fresh revision in this transaction.
pub(super) fn initialize(tx: &Connection, scope: &Scope, revision: &Revision) -> Result<State> {
    if load(tx, scope)?.is_some() {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    tx.execute(
        "INSERT INTO family_graph_heads VALUES(?1,?2,?3,0,0)",
        params![
            scope.realm_id.as_str(),
            scope.vault_id.as_str(),
            revision.as_str()
        ],
    )?;
    Ok(State::empty(scope.clone(), revision.clone()))
}

/// Persist a trusted planner result plus the exact authenticated/authored file
/// plaintext when it adds a file record. The dispatcher has already inserted its
/// ledger/intent, reserved the new revision and checked its other domain CASes.
/// Text activity plans add no duplicate plaintext body here.
pub(super) fn persist(
    tx: &Connection,
    plan: &FilePlan,
    new_file: Option<(&UpdateId, &[u8])>,
) -> Result<()> {
    let files: Vec<_> = new_file.into_iter().collect();
    persist_many(tx, plan, &files)
}
pub(super) fn persist_many(
    tx: &Connection,
    plan: &FilePlan,
    new_files: &[(&UpdateId, &[u8])],
) -> Result<()> {
    let expected = &plan.expected_state;
    let actual = load(tx, expected.scope())?
        .ok_or_else(|| corrupt("graph plan lacks initialized authority"))?;
    plan.check_preconditions(&actual)
        .map_err(|_| zorid_client_sync::SyncError::VersionConflict)?;
    let Some(next) = &plan.next_state else {
        if !new_files.is_empty() {
            return Err(corrupt("duplicate graph plan supplied new file bytes"));
        }
        return Ok(());
    };
    if next.scope() != expected.scope() || next.version() == expected.version() {
        return Err(corrupt("invalid graph transition identity/version"));
    }
    next.view()
        .map_err(|_| corrupt("invalid planned cross-family graph"))?;
    for (id, payload) in expected.records() {
        if next.records().get(id) != Some(payload) {
            return Err(corrupt("graph transition rewrote immutable file history"));
        }
    }
    for (id, activity) in expected.activities() {
        if next.activities().get(id) != Some(activity) {
            return Err(corrupt("graph transition rewrote immutable text activity"));
        }
    }
    let new_records: Vec<_> = next
        .records()
        .iter()
        .filter(|(id, _)| !expected.records().contains_key(*id))
        .collect();
    let files: BTreeMap<_, _> = new_files.iter().map(|(id, raw)| (*id, *raw)).collect();
    if files.len() != new_files.len() || files.len() != new_records.len() {
        return Err(corrupt("graph transition has unexpected file record set"));
    }
    for (id, payload) in new_records {
        let raw = files
            .get(id)
            .ok_or_else(|| corrupt("planned file body missing"))?;
        if &check_file(tx, next.scope(), id, raw)? != payload {
            return Err(corrupt("planned file record differs from exact plaintext"));
        }
        tx.execute(
            "INSERT INTO family_file_records VALUES(?1,?2,?3,?4)",
            params![
                next.scope().realm_id.as_str(),
                next.scope().vault_id.as_str(),
                id.as_str(),
                raw
            ],
        )?;
    }
    for (id, activity) in next
        .activities()
        .iter()
        .filter(|(id, _)| !expected.activities().contains_key(*id))
    {
        check_activity(tx, next.scope(), id, activity)?;
        tx.execute(
            "INSERT INTO family_text_activities VALUES(?1,?2,?3,?4)",
            params![
                next.scope().realm_id.as_str(),
                next.scope().vault_id.as_str(),
                id.as_str(),
                serde_json::to_string(activity)?
            ],
        )?;
    }
    check_body_bounds(tx, next.scope())?;
    tx.execute("UPDATE family_graph_heads SET revision=?1,record_count=?2,activity_count=?3 WHERE realm_id=?4 AND vault_id=?5",params![next.version().as_str(),i64::try_from(next.records().len()).map_err(|_|corrupt("file count overflow"))?,i64::try_from(next.activities().len()).map_err(|_|corrupt("activity count overflow"))?,next.scope().realm_id.as_str(),next.scope().vault_id.as_str()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::family_ledger::{self, TextBinding};
    use zorid_client_sync::{v2::TextNamespaceContext, TextIdentity};
    use zorid_file_sync::Sha256Digest;
    use zorid_sync_protocol::{DeviceId, Envelope, Header, RealmId, VaultId};
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        for (_, sql) in family_ledger::SCHEMA.iter().chain(SCHEMA) {
            db.execute_batch(sql).unwrap();
        }
        db
    }
    fn scope() -> Scope {
        Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        }
    }
    fn revision(id: &str) -> Revision {
        Revision::new(id).unwrap()
    }
    fn meta() -> EnvelopeMetadata {
        EnvelopeMetadata {
            key: key(&scope(), &UpdateId::new("update").unwrap()),
            family: Family::Text,
            format_version: 2,
            payload_digest: Sha256Digest::of(b"{}"),
            payload_bytes: 2,
            text_binding: Some(TextBinding {
                entry_id: EntryId::new("entry").unwrap(),
                text_bootstrap_id: UpdateId::new("text_bootstrap").unwrap(),
                namespace: TextNamespaceContext {
                    bootstrap_id: UpdateId::new("namespace").unwrap(),
                    parents: vec![UpdateId::new("namespace").unwrap()],
                },
            }),
        }
    }
    fn activity(metadata: &EnvelopeMetadata) -> StoredActivity {
        let binding = metadata.text_binding.as_ref().unwrap();
        // Trusted-persistence fixture; the public receive boundary never accepts
        // this JSON as an authentication capability.
        serde_json::from_value(serde_json::json!({"identity":TextIdentity{realm_id:metadata.key.realm_id.clone(),vault_id:metadata.key.vault_id.clone(),entry_id:binding.entry_id.clone(),bootstrap_id:binding.text_bootstrap_id.clone()},"update_id":metadata.key.update_id,"namespace":binding.namespace,"payload_digest":metadata.payload_digest,"payload_bytes":metadata.payload_bytes})).unwrap()
    }
    fn record(tx: &Connection, metadata: &EnvelopeMetadata) {
        let k = &metadata.key;
        let header = Header::new(
            k.realm_id.clone(),
            k.vault_id.clone(),
            k.update_id.clone(),
            DeviceId::new("device").unwrap(),
            1,
        )
        .unwrap();
        let wire = Envelope::from_parts(&header.encode().unwrap(), [1; 24], &[0; 16])
            .unwrap()
            .encode();
        family_ledger::insert_received(tx, metadata, &wire).unwrap();
    }
    fn activity_plan(expected: &State, metadata: &EnvelopeMetadata) -> FilePlan {
        let mut activities = expected.activities().clone();
        activities.insert(metadata.key.update_id.clone(), activity(metadata));
        let next = State::from_records(
            expected.scope().clone(),
            revision("next"),
            expected.records().clone(),
            activities,
        )
        .unwrap();
        FilePlan {
            expected_state: expected.clone(),
            view: next.view().unwrap(),
            next_state: Some(next),
        }
    }
    #[test]
    fn activity_causal_context_is_bound_to_immutable_ledger_metadata() {
        let mut db = db();
        let metadata = meta();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let initial = initialize(&tx, &scope(), &revision("initial")).unwrap();
        record(&tx, &metadata);
        persist(&tx, &activity_plan(&initial, &metadata), None).unwrap();
        tx.commit().unwrap();
        assert_eq!(load(&db, &scope()).unwrap().unwrap().activities().len(), 1);
        let original = serde_json::to_value(activity(&metadata)).unwrap();
        for (field, value) in [
            ("parents", serde_json::json!(["different_parent"])),
            ("bootstrap_id", serde_json::json!("different_namespace")),
        ] {
            let mut changed = original.clone();
            changed["namespace"][field] = value;
            db.execute(
                "UPDATE family_text_activities SET record=?1",
                [serde_json::to_string(&changed).unwrap()],
            )
            .unwrap();
            assert!(matches!(load(&db, &scope()), Err(StoreError::Corrupt(_))));
        }
    }
    #[test]
    fn stale_graph_cas_cannot_overwrite_a_committed_activity() {
        let mut db = db();
        let metadata = meta();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let initial = initialize(&tx, &scope(), &revision("initial")).unwrap();
        record(&tx, &metadata);
        let plan = activity_plan(&initial, &metadata);
        persist(&tx, &plan, None).unwrap();
        tx.commit().unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(persist(&tx, &plan, None).is_err());
        drop(tx);
        assert_eq!(load(&db, &scope()).unwrap(), plan.next_state);
    }
    #[test]
    fn retained_record_count_and_missing_head_corruption_fail_closed() {
        let mut db = db();
        let metadata = meta();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let initial = initialize(&tx, &scope(), &revision("initial")).unwrap();
        record(&tx, &metadata);
        persist(&tx, &activity_plan(&initial, &metadata), None).unwrap();
        tx.commit().unwrap();
        db.execute("DELETE FROM family_text_activities", [])
            .unwrap();
        assert!(matches!(load(&db, &scope()), Err(StoreError::Corrupt(_))));
        db.execute("DELETE FROM family_graph_heads", []).unwrap();
        assert!(matches!(load(&db, &scope()), Err(StoreError::Corrupt(_))));
    }
}
