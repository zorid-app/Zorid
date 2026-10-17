//! Descriptor-only access to the existing immutable file-record authority.
//! No verification capability is persisted. Exact plaintext remains in the
//! single family_file_records row and is fetched only for a requested chunk.
use super::family_ledger::{self, EnvelopeKey, Family};
use super::*;
use std::collections::BTreeMap;
use zorid_file_sync::metadata::{GraphRecord, MetadataState};
use zorid_file_sync::v2::{Body, Payload, StoredActivity};
use zorid_file_sync::{Scope, MAX_RECORDS, MAX_STATE_BYTES};
use zorid_sync_protocol::UpdateId;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("family_file_descriptors", "CREATE TABLE family_file_descriptors (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,update_id TEXT NOT NULL,descriptor TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id,update_id),FOREIGN KEY(realm_id,vault_id,update_id) REFERENCES family_file_records(realm_id,vault_id,update_id))"),
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
fn restore(tx: &Connection, scope: &Scope, id: &UpdateId, raw: &str) -> Result<GraphRecord> {
    let meta = family_ledger::metadata_only(tx, &key(scope, id))?
        .ok_or_else(|| corrupt("file descriptor lacks envelope authority"))?
        .metadata;
    if meta.family != Family::Files || meta.text_binding.is_some() {
        return Err(corrupt("descriptor envelope family mismatch"));
    }
    GraphRecord::from_persisted_json(
        raw,
        meta.payload_bytes,
        meta.payload_digest,
        meta.file_summary_digest
            .ok_or_else(|| corrupt("descriptor commitment missing"))?,
    )
    .map_err(|_| corrupt("file descriptor differs from envelope commitment"))
}
/// Called beside the insertion of the sole exact plaintext row, after its
/// authenticated/authored ledger metadata has been bound in this transaction.
pub(super) fn insert_exact(
    tx: &Connection,
    scope: &Scope,
    id: &UpdateId,
    exact: &[u8],
) -> Result<()> {
    let meta = family_ledger::metadata_only(tx, &key(scope, id))?
        .ok_or_else(|| corrupt("descriptor source lacks envelope authority"))?
        .metadata;
    meta.check_payload(exact)?;
    let (actual_scope, actual_id, record) = GraphRecord::from_authored_exact(exact)
        .map_err(|_| corrupt("invalid descriptor source plaintext"))?;
    if actual_scope != *scope || actual_id != *id {
        return Err(corrupt("descriptor source SQL identity mismatch"));
    }
    let raw = serde_json::to_string(&record)?;
    restore(tx, scope, id, &raw)?;
    tx.execute(
        "INSERT INTO family_file_descriptors VALUES(?1,?2,?3,?4)",
        params![
            scope.realm_id.as_str(),
            scope.vault_id.as_str(),
            id.as_str(),
            raw
        ],
    )?;
    Ok(())
}
/// This does not authenticate or verify binary content. It restores bounded
/// commitments without selecting any payload or wire BLOB into the process.
pub(super) fn load_metadata(tx: &Connection, scope: &Scope) -> Result<Option<MetadataState>> {
    let head: Option<(String,i64,i64)> = tx.query_row(
        "SELECT revision,record_count,activity_count FROM family_graph_heads WHERE realm_id=?1 AND vault_id=?2",
        params![scope.realm_id.as_str(),scope.vault_id.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (files, descriptors, activities): (i64,i64,i64) = tx.query_row(
        "SELECT (SELECT count(*) FROM family_file_records WHERE realm_id=?1 AND vault_id=?2),(SELECT count(*) FROM family_file_descriptors WHERE realm_id=?1 AND vault_id=?2),(SELECT count(*) FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2)",
        params![scope.realm_id.as_str(),scope.vault_id.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let Some((revision, expected_files, expected_activities)) = head else {
        let retained: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_envelopes WHERE realm_id=?1 AND vault_id=?2 UNION ALL SELECT 1 FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2)", params![scope.realm_id.as_str(),scope.vault_id.as_str()], |r| r.get(0))?;
        if (files, descriptors, activities) != (0, 0, 0) || retained {
            return Err(corrupt("metadata head missing with retained authority"));
        }
        return Ok(None);
    };
    if files != expected_files
        || descriptors != files
        || activities != expected_activities
        || files < 0
        || activities < 0
        || files
            .checked_add(activities)
            .is_none_or(|n| n > MAX_RECORDS as i64)
    {
        return Err(corrupt("metadata record count mismatch or bound exceeded"));
    }
    let (total, largest): (i64,i64) = tx.query_row(
        "SELECT coalesce(sum(size),0),coalesce(max(size),0) FROM (SELECT length(CAST(descriptor AS BLOB)) AS size FROM family_file_descriptors WHERE realm_id=?1 AND vault_id=?2 UNION ALL SELECT length(CAST(record AS BLOB)) AS size FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2)",
        params![scope.realm_id.as_str(),scope.vault_id.as_str()], |r| Ok((r.get(0)?,r.get(1)?)))?;
    if total < 0
        || total > MAX_STATE_BYTES as i64
        || largest > zorid_file_sync::metadata::MAX_GRAPH_RECORD_BYTES as i64
    {
        return Err(corrupt("metadata descriptor bound exceeded"));
    }
    file_state::check_body_bounds(tx, scope)?;
    let (raw_bytes, largest_payload, unmatched): (i64,i64,i64) = tx.query_row(
        "SELECT coalesce(sum(length(f.payload)),0),coalesce(max(length(f.payload)),0),coalesce(sum(f.update_id IS NULL),0) FROM family_file_descriptors d LEFT JOIN family_file_records f USING(realm_id,vault_id,update_id) WHERE d.realm_id=?1 AND d.vault_id=?2",
        params![scope.realm_id.as_str(),scope.vault_id.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if raw_bytes < 0
        || raw_bytes > MAX_STATE_BYTES as i64
        || largest_payload > zorid_sync_protocol::MAX_PLAINTEXT_BYTES as i64
        || unmatched != 0
    {
        return Err(corrupt(
            "metadata backing source missing or existing raw-body bound exceeded",
        ));
    }
    let mut records = BTreeMap::new();
    let mut statement = tx.prepare("SELECT update_id,descriptor FROM family_file_descriptors WHERE realm_id=?1 AND vault_id=?2 ORDER BY update_id")?;
    let mut rows = statement.query(params![scope.realm_id.as_str(), scope.vault_id.as_str()])?;
    while let Some(row) = rows.next()? {
        let id = UpdateId::new(row.get::<_, String>(0)?)?;
        let record = restore(tx, scope, &id, &row.get::<_, String>(1)?)?;
        records.insert(id, record);
    }
    let mut activity_records = BTreeMap::new();
    let mut statement = tx.prepare("SELECT update_id,record FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2 ORDER BY update_id")?;
    let mut rows = statement.query(params![scope.realm_id.as_str(), scope.vault_id.as_str()])?;
    while let Some(row) = rows.next()? {
        let id = UpdateId::new(row.get::<_, String>(0)?)?;
        let activity: StoredActivity = serde_json::from_str(&row.get::<_, String>(1)?)?;
        file_state::check_activity(tx, scope, &id, &activity)?;
        activity_records.insert(id, activity);
    }
    MetadataState::from_records(
        scope.clone(),
        Revision::new(revision)?,
        records,
        activity_records,
    )
    .map(Some)
    .map_err(|_| corrupt("invalid persisted metadata graph"))
}
/// Resolve one retained descriptor from its sole exact plaintext row. A present
/// descriptor with missing bytes is corruption, never a request to redownload.
pub(super) fn read_chunk(
    tx: &Connection,
    scope: &Scope,
    id: &UpdateId,
    expected: &GraphRecord,
) -> Result<Vec<u8>> {
    let descriptor_bytes: Option<i64> = tx.query_row(
        "SELECT length(CAST(descriptor AS BLOB)) FROM family_file_descriptors WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![scope.realm_id.as_str(),scope.vault_id.as_str(),id.as_str()], |r| r.get(0)).optional()?;
    if descriptor_bytes.is_none_or(|bytes| {
        bytes <= 0 || bytes > zorid_file_sync::metadata::MAX_GRAPH_RECORD_BYTES as i64
    }) {
        return Err(corrupt("requested chunk descriptor missing or oversized"));
    }
    let row: Option<(String,Option<i64>)> = tx.query_row(
        "SELECT d.descriptor,length(f.payload) FROM family_file_descriptors d LEFT JOIN family_file_records f USING(realm_id,vault_id,update_id) WHERE d.realm_id=?1 AND d.vault_id=?2 AND d.update_id=?3",
        params![scope.realm_id.as_str(),scope.vault_id.as_str(),id.as_str()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (raw_descriptor, bytes) =
        row.ok_or_else(|| corrupt("requested chunk descriptor missing"))?;
    let bytes = bytes.ok_or_else(|| corrupt("requested chunk backing plaintext missing"))?;
    let actual = restore(tx, scope, id, &raw_descriptor)?;
    if bytes <= 0
        || bytes > zorid_sync_protocol::MAX_PLAINTEXT_BYTES as i64
        || actual.payload_bytes() != expected.payload_bytes()
        || actual.payload_digest() != expected.payload_digest()
        || actual.summary_digest()? != expected.summary_digest()?
    {
        return Err(corrupt("requested chunk source commitment mismatch"));
    }
    let raw: Vec<u8> = tx.query_row("SELECT payload FROM family_file_records WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![scope.realm_id.as_str(),scope.vault_id.as_str(),id.as_str()], |r| r.get(0))?;
    let meta = family_ledger::metadata_only(tx, &key(scope, id))?
        .ok_or_else(|| corrupt("chunk authority missing"))?
        .metadata;
    meta.check_payload(&raw)?;
    let payload = Payload::decode(&raw).map_err(|_| corrupt("invalid retained chunk plaintext"))?;
    if payload.scope != *scope || payload.id != *id {
        return Err(corrupt("chunk source SQL identity mismatch"));
    }
    match payload.body {
        Body::Chunk { bytes }
            if !bytes.is_empty() && bytes.len() <= zorid_file_sync::MAX_CHUNK_BYTES =>
        {
            Ok(bytes)
        }
        _ => Err(corrupt("requested source is not a bounded chunk")),
    }
}

/// Preserve native corruption/SQL errors across the portable bounded source
/// trait. Portable verification alone must never downgrade damaged storage to
/// an ordinary unresolved dependency.
pub(super) struct ChunkResolver<'a> {
    tx: &'a Connection,
    error: Option<StoreError>,
}
impl<'a> ChunkResolver<'a> {
    pub(super) fn new(tx: &'a Connection) -> Self {
        Self { tx, error: None }
    }
    pub(super) fn finish<T>(self, result: zorid_file_sync::Result<T>) -> Result<T> {
        if let Some(error) = self.error {
            return Err(error);
        }
        result.map_err(StoreError::from)
    }
}
impl zorid_file_sync::binary_stream::ChunkSource for ChunkResolver<'_> {
    fn read_chunk(
        &mut self,
        scope: &Scope,
        id: &UpdateId,
        expected: &GraphRecord,
    ) -> zorid_file_sync::Result<Vec<u8>> {
        if self.error.is_some() {
            return Err(zorid_file_sync::Error::InvalidState);
        }
        match read_chunk(self.tx, scope, id, expected) {
            Ok(bytes) => Ok(bytes),
            Err(error) => {
                self.error = Some(error);
                Err(zorid_file_sync::Error::InvalidState)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_file_sync::Sha256Digest;
    use zorid_sync_protocol::{RealmId, VaultId};
    fn fixture() -> (Connection, Scope, UpdateId, GraphRecord, Vec<u8>) {
        let db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        for (_, sql) in family_ledger::SCHEMA
            .iter()
            .chain(file_state::SCHEMA)
            .chain(SCHEMA)
            .chain(super::super::blob_stage::SCHEMA)
        {
            db.execute_batch(sql).unwrap();
        }
        let scope = Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        };
        let id = UpdateId::new("chunk").unwrap();
        let payload = Payload {
            family: zorid_file_sync::Family::Files,
            format_version: 2,
            scope: scope.clone(),
            id: id.clone(),
            body: Body::Chunk {
                bytes: vec![7, 8, 9],
            },
        };
        // Retain exact accepted whitespace, not a re-encoding of the payload.
        let mut exact = vec![b' '];
        exact.extend(payload.encode().unwrap());
        let (_, _, record) = GraphRecord::from_authored_exact(&exact).unwrap();
        let metadata = family_ledger::EnvelopeMetadata {
            key: key(&scope, &id),
            family: Family::Files,
            format_version: 2,
            payload_digest: Sha256Digest::of(&exact),
            payload_bytes: exact.len() as u32,
            file_summary_digest: Some(record.summary_digest().unwrap()),
            text_binding: None,
        };
        family_ledger::insert_authored(&db, &metadata, &exact).unwrap();
        db.execute(
            "INSERT INTO family_graph_heads VALUES(?1,?2,'revision',1,0)",
            params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO family_file_records VALUES(?1,?2,?3,?4)",
            params![
                scope.realm_id.as_str(),
                scope.vault_id.as_str(),
                id.as_str(),
                &exact
            ],
        )
        .unwrap();
        insert_exact(&db, &scope, &id, &exact).unwrap();
        (db, scope, id, record, exact)
    }
    #[test]
    fn descriptors_retain_exact_source_and_chunk_bytes_are_checked_on_demand() {
        let (db, scope, id, record, mut exact) = fixture();
        let state = load_metadata(&db, &scope).unwrap().unwrap();
        assert_eq!(
            state.records().get(&id).unwrap().payload_digest(),
            &Sha256Digest::of(&exact)
        );
        assert_eq!(
            read_chunk(&db, &scope, &id, &record).unwrap(),
            vec![7, 8, 9]
        );
        let pos = exact.iter().rposition(|b| *b == b'9').unwrap();
        exact[pos] = b'6';
        db.execute("UPDATE family_file_records SET payload=?1", [exact])
            .unwrap();
        // Metadata restoration does not fetch or decode body bytes.
        assert!(load_metadata(&db, &scope).unwrap().is_some());
        assert!(matches!(
            read_chunk(&db, &scope, &id, &record),
            Err(StoreError::Corrupt(_))
        ));
        let mut resolver = ChunkResolver::new(&db);
        assert!(zorid_file_sync::binary_stream::ChunkSource::read_chunk(
            &mut resolver,
            &scope,
            &id,
            &record
        )
        .is_err());
        // Even a caller that mistakenly passes portable success cannot erase
        // the native backing-source corruption captured by the resolver.
        assert!(matches!(
            resolver.finish(Ok(())),
            Err(StoreError::Corrupt(_))
        ));
    }
    #[test]
    fn descriptor_tamper_and_missing_backing_fail_closed() {
        let (db, scope, _id, _record, _) = fixture();
        db.execute("UPDATE family_file_descriptors SET descriptor='{}'", [])
            .unwrap();
        assert!(matches!(
            load_metadata(&db, &scope),
            Err(StoreError::Corrupt(_))
        ));
        let (db, scope, id, record, _) = fixture();
        db.pragma_update(None, "foreign_keys", false).unwrap();
        db.execute("DELETE FROM family_file_records", []).unwrap();
        assert!(matches!(
            load_metadata(&db, &scope),
            Err(StoreError::Corrupt(_))
        ));
        assert!(matches!(
            read_chunk(&db, &scope, &id, &record),
            Err(StoreError::Corrupt(_))
        ));
    }
}
