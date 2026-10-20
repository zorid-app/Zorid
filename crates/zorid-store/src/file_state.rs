//! Metadata graph membership transaction primitives. Exact immutable plaintext
//! lives once in immutable_payloads, never in this graph or its plan.
use super::*;
use zorid_file_sync::{metadata::MetadataState, metadata_plan::MetadataPlan, Scope};

pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("family_graph_heads","CREATE TABLE family_graph_heads (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,revision TEXT NOT NULL,record_count INTEGER NOT NULL CHECK(record_count>=0),activity_count INTEGER NOT NULL CHECK(activity_count>=0),PRIMARY KEY(realm_id,vault_id))"),
    ("family_file_records","CREATE TABLE family_file_records (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,update_id TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,update_id),FOREIGN KEY(realm_id,vault_id) REFERENCES family_graph_heads(realm_id,vault_id),FOREIGN KEY(realm_id,vault_id,update_id) REFERENCES immutable_payloads(realm_id,vault_id,update_id))"),
    ("family_text_activities","CREATE TABLE family_text_activities (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,update_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,update_id),FOREIGN KEY(realm_id,vault_id) REFERENCES family_graph_heads(realm_id,vault_id))"),
];
fn corrupt(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}

pub(super) fn initialize(
    tx: &Connection,
    scope: &Scope,
    revision: &Revision,
) -> Result<MetadataState> {
    if blob_index::load_metadata(tx, scope)?.is_some() {
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
    family_graph::initialize(tx, scope, revision)?;
    Ok(MetadataState::empty(scope.clone(), revision.clone()))
}

/// The dispatcher owns an enclosing IMMEDIATE transaction, wire/receipt CAS,
/// revisions and source insertion. This primitive checks exact metadata state,
/// the portable all-history proof, immutable membership and independent sources.
pub(super) fn persist_plan(tx: &Connection, plan: &MetadataPlan) -> Result<()> {
    let expected = plan.expected_state();
    let actual = blob_index::load_metadata(tx, expected.scope())?
        .ok_or_else(|| corrupt("metadata plan lacks initialized graph authority"))?;
    if &actual != expected {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    plan.verified_binaries()
        .check_preconditions(plan.verification_state())?;
    let Some(next) = plan.next_state() else {
        blob_index::check_sources(tx, &actual)?;
        return family_graph::maintain_legacy_plan(tx, plan);
    };
    if next.scope() != expected.scope() || next.version() == expected.version() {
        return Err(corrupt("invalid metadata plan scope/revision transition"));
    }
    blob_index::check_limits(next)?;
    for (id, record) in expected.records() {
        if next.records().get(id) != Some(record) {
            return Err(corrupt("metadata plan rewrote retained file history"));
        }
    }
    for (id, activity) in expected.activities() {
        if next.activities().get(id) != Some(activity) {
            return Err(corrupt("metadata plan rewrote retained text history"));
        }
    }
    for (id, record) in next
        .records()
        .iter()
        .filter(|(id, _)| !expected.records().contains_key(*id))
    {
        let key = family_ledger::EnvelopeKey {
            realm_id: next.scope().realm_id.clone(),
            vault_id: next.scope().vault_id.clone(),
            update_id: id.clone(),
        };
        let metadata = family_ledger::metadata_only(tx, &key)?
            .ok_or_else(|| corrupt("new graph member lacks envelope ownership"))?
            .metadata;
        if blob_index::file_record_from_metadata(tx, &metadata)? != *record {
            return Err(corrupt(
                "new graph member differs from exact immutable source",
            ));
        }
        tx.execute(
            "INSERT INTO family_file_records VALUES(?1,?2,?3)",
            params![
                next.scope().realm_id.as_str(),
                next.scope().vault_id.as_str(),
                id.as_str()
            ],
        )?;
    }
    for (id, activity) in next
        .activities()
        .iter()
        .filter(|(id, _)| !expected.activities().contains_key(*id))
    {
        blob_index::check_activity(tx, next.scope(), id, activity)?;
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
    blob_index::check_sources(tx, next)?;
    family_graph::maintain_legacy_plan(tx, plan)?;
    let changed=tx.execute("UPDATE family_graph_heads SET revision=?1,record_count=?2,activity_count=?3 WHERE realm_id=?4 AND vault_id=?5 AND revision=?6",params![next.version().as_str(),i64::try_from(next.records().len()).map_err(|_|corrupt("metadata file count overflow"))?,i64::try_from(next.activities().len()).map_err(|_|corrupt("metadata activity count overflow"))?,next.scope().realm_id.as_str(),next.scope().vault_id.as_str(),expected.version().as_str()])?;
    if changed != 1 {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_index::test_support::{chunk, db, fixture, retain, revision, scope};
    use crate::family_ledger::{EnvelopeKey, EnvelopeMetadata, Family, TextBinding};
    use zorid_client_sync::{v2::TextNamespaceContext, TextIdentity};
    use zorid_file_sync::{
        metadata_plan::{prepare_authored_batch, AuthoredMetadataBatch},
        v2::StoredActivity,
        Sha256Digest,
    };
    use zorid_sync_protocol::UpdateId;

    fn text_metadata() -> EnvelopeMetadata {
        EnvelopeMetadata {
            key: EnvelopeKey {
                realm_id: scope().realm_id,
                vault_id: scope().vault_id,
                update_id: UpdateId::new("text-update").unwrap(),
            },
            family: Family::Text,
            format_version: 2,
            payload_digest: Sha256Digest::of(b"{}"),
            payload_bytes: 2,
            file_summary_digest: None,
            text_binding: Some(TextBinding {
                entry_id: EntryId::new("entry").unwrap(),
                text_bootstrap_id: UpdateId::new("text-bootstrap").unwrap(),
                namespace: TextNamespaceContext {
                    bootstrap_id: UpdateId::new("namespace").unwrap(),
                    parents: vec![UpdateId::new("namespace").unwrap()],
                },
            }),
        }
    }
    fn activity(metadata: &EnvelopeMetadata) -> StoredActivity {
        let binding = metadata.text_binding.as_ref().unwrap();
        serde_json::from_value(serde_json::json!({"identity":TextIdentity { realm_id:metadata.key.realm_id.clone(),vault_id:metadata.key.vault_id.clone(),entry_id:binding.entry_id.clone(),bootstrap_id:binding.text_bootstrap_id.clone() },"update_id":metadata.key.update_id,"namespace":binding.namespace,"payload_digest":metadata.payload_digest,"payload_bytes":metadata.payload_bytes})).unwrap()
    }

    #[test]
    fn activity_causal_context_is_bound_to_immutable_ledger_metadata() {
        let db = db();
        let metadata = text_metadata();
        initialize(&db, &scope(), &revision("initial")).unwrap();
        family_ledger::insert_authored(&db, &metadata, b"{}").unwrap();
        immutable_payloads::put_exact(&db, &metadata, b"{}", 512 * 1024 * 1024).unwrap();
        let original = serde_json::to_value(activity(&metadata)).unwrap();
        db.execute(
            "INSERT INTO family_text_activities VALUES(?1,?2,?3,?4)",
            params![
                scope().realm_id.as_str(),
                scope().vault_id.as_str(),
                metadata.key.update_id.as_str(),
                serde_json::to_string(&original).unwrap()
            ],
        )
        .unwrap();
        db.execute("UPDATE family_graph_heads SET activity_count=1", [])
            .unwrap();
        assert_eq!(
            blob_index::load_metadata(&db, &scope())
                .unwrap()
                .unwrap()
                .activities()
                .len(),
            1
        );
        for (field, value) in [
            ("parents", serde_json::json!(["different-parent"])),
            ("bootstrap_id", serde_json::json!("different-namespace")),
        ] {
            let mut changed = original.clone();
            changed["namespace"][field] = value;
            db.execute(
                "UPDATE family_text_activities SET record=?1",
                [serde_json::to_string(&changed).unwrap()],
            )
            .unwrap();
            assert!(matches!(
                blob_index::load_metadata(&db, &scope()),
                Err(StoreError::Corrupt(_))
            ));
        }
    }

    #[test]
    fn stale_metadata_cas_cannot_overwrite_a_committed_record() {
        let mut db = db();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let initial = initialize(&tx, &scope(), &revision("initial")).unwrap();
        let (id, record, raw) = chunk("chunk", b"retained");
        let mut batch = AuthoredMetadataBatch::new(scope());
        batch.push_exact(&raw).unwrap();
        let candidate = prepare_authored_batch(&initial, batch, revision("next")).unwrap();
        let proof = blob_index::verify_metadata(
            &tx,
            candidate.verification_state(),
            &[(id.clone(), raw.clone())],
        )
        .unwrap();
        let plan = candidate.finalize(proof).unwrap();
        retain(&tx, &id, &record, &raw);
        persist_plan(&tx, &plan).unwrap();
        tx.commit().unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(persist_plan(&tx, &plan).is_err());
        drop(tx);
        assert_eq!(
            blob_index::load_metadata(&db, &scope()).unwrap().as_ref(),
            plan.next_state()
        );
        let columns = db
            .prepare("PRAGMA table_info(family_file_records)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(columns, ["realm_id", "vault_id", "update_id"]);
    }

    #[test]
    fn retained_record_count_and_missing_head_corruption_fail_closed() {
        let (db, scope, _, _, _) = fixture();
        db.execute("DELETE FROM family_file_records", []).unwrap();
        assert!(matches!(
            blob_index::load_metadata(&db, &scope),
            Err(StoreError::Corrupt(_))
        ));
        db.execute("DELETE FROM family_graph_heads", []).unwrap();
        assert!(matches!(
            blob_index::load_metadata(&db, &scope),
            Err(StoreError::Corrupt(_))
        ));
    }
}
