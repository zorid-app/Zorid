//! Metadata-only graph membership and bounded immutable chunk resolution.
//! Metadata restoration is not byte verification or publication authorization.
use super::family_ledger::{self, EnvelopeKey, EnvelopeMetadata, Family};
use super::*;
use std::collections::BTreeMap;
use zorid_file_sync::binary_stream::VerifiedBinarySet;
use zorid_file_sync::metadata::{GraphRecord, GraphRecordBody, MetadataState};
use zorid_file_sync::v2::{Body, Payload, StoredActivity};
use zorid_file_sync::{Scope, Sha256Digest};
use zorid_sync_protocol::UpdateId;

pub(super) const SCHEMA: &[(&str, &str)] = &[];
pub(super) use super::file_state::persist_plan;
const MAX_RECORDS: usize = 4096;
const MAX_EVENTS: usize = 4096;
const MAX_CHUNKS: usize = 2048;
const MAX_PAGES: usize = 256;
const MAX_METADATA_BYTES: usize = 128 * 1024 * 1024;
const MAX_RETAINED_BYTES: u64 = 512 * 1024 * 1024;

fn corrupt(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}
fn key(scope: &Scope, id: &UpdateId) -> EnvelopeKey {
    EnvelopeKey {
        realm_id: scope.realm_id.clone(),
        vault_id: scope.vault_id.clone(),
        update_id: id.clone(),
    }
}

fn file_record(tx: &Connection, scope: &Scope, id: &UpdateId) -> Result<GraphRecord> {
    let owned:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM family_file_records WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3)",params![scope.realm_id.as_str(),scope.vault_id.as_str(),id.as_str()],|r|r.get(0))?;
    if !owned {
        return Err(corrupt("file metadata is not a retained graph member"));
    }
    let metadata = family_ledger::metadata_only(tx, &key(scope, id))?
        .ok_or_else(|| corrupt("file graph member lacks ledger ownership"))?
        .metadata;
    file_record_from_metadata(tx, &metadata)
}

pub(super) fn file_record_from_metadata(
    tx: &Connection,
    metadata: &EnvelopeMetadata,
) -> Result<GraphRecord> {
    if metadata.family != Family::Files || metadata.text_binding.is_some() {
        return Err(corrupt("file source has wrong envelope family"));
    }
    let head = immutable_payloads::head(tx, &metadata.key)?
        .ok_or_else(|| corrupt("file descriptor backing source is missing"))?;
    if head.family != Family::Files
        || head.payload_bytes != metadata.payload_bytes
        || head.payload_digest != metadata.payload_digest
        || head.file_summary_digest != metadata.file_summary_digest
    {
        return Err(corrupt(
            "file source differs from independent ledger commitments",
        ));
    }
    GraphRecord::from_persisted_json(
        &head
            .descriptor
            .ok_or_else(|| corrupt("file source descriptor missing"))?,
        metadata.payload_bytes,
        metadata.payload_digest,
        metadata
            .file_summary_digest
            .ok_or_else(|| corrupt("file source summary missing"))?,
    )
    .map_err(|_| corrupt("file source descriptor commitment mismatch"))
}

pub(super) fn check_activity(
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
        return Err(corrupt("text activity identity differs from membership"));
    }
    let metadata = family_ledger::metadata_only(tx, &key(scope, id))?
        .ok_or_else(|| corrupt("text activity lacks ledger ownership"))?
        .metadata;
    let binding = metadata
        .text_binding
        .as_ref()
        .ok_or_else(|| corrupt("text activity lacks namespace binding"))?;
    if metadata.family != Family::Text
        || metadata.file_summary_digest.is_some()
        || binding.entry_id != identity.entry_id
        || binding.text_bootstrap_id != identity.bootstrap_id
        || &binding.namespace != activity.namespace()
        || &metadata.payload_digest != activity.payload_digest()
        || metadata.payload_bytes != activity.payload_bytes()
    {
        return Err(corrupt("text activity differs from ledger context"));
    }
    let head = immutable_payloads::head(tx, &metadata.key)?
        .ok_or_else(|| corrupt("text activity backing source missing"))?;
    if head.family != Family::Text
        || head.payload_bytes != metadata.payload_bytes
        || head.payload_digest != metadata.payload_digest
        || head.file_summary_digest.is_some()
        || head.descriptor.is_some()
    {
        return Err(corrupt("text activity backing source commitment mismatch"));
    }
    Ok(())
}

fn activity(tx: &Connection, scope: &Scope, id: &UpdateId) -> Result<StoredActivity> {
    let len:Option<i64>=tx.query_row("SELECT length(CAST(record AS BLOB)) FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",params![scope.realm_id.as_str(),scope.vault_id.as_str(),id.as_str()],|r|r.get(0)).optional()?;
    if len.is_none_or(|n| n <= 0 || n > zorid_sync_protocol::MAX_PLAINTEXT_BYTES as i64) {
        return Err(corrupt("text activity missing or oversized"));
    }
    let raw:String=tx.query_row("SELECT record FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",params![scope.realm_id.as_str(),scope.vault_id.as_str(),id.as_str()],|r|r.get(0))?;
    let activity: StoredActivity = serde_json::from_str(&raw)?;
    check_activity(tx, scope, id, &activity)?;
    Ok(activity)
}

pub(super) fn check_limits(state: &MetadataState) -> Result<()> {
    if state
        .records()
        .len()
        .checked_add(state.activities().len())
        .is_none_or(|n| n > MAX_RECORDS)
    {
        return Err(corrupt("metadata combined record bound exceeded"));
    }
    let (mut bytes, mut chunks, mut pages, mut events) =
        (0_usize, 0_usize, 0_usize, state.activities().len());
    for record in state.records().values() {
        bytes = bytes
            .checked_add(serde_json::to_vec(record)?.len())
            .ok_or_else(|| corrupt("metadata byte overflow"))?;
        match record.body() {
            GraphRecordBody::Chunk { .. } => chunks += 1,
            GraphRecordBody::Page { .. } => pages += 1,
            GraphRecordBody::Events { events: batch }
            | GraphRecordBody::ObservedDelete { events: batch } => {
                events = events
                    .checked_add(batch.len())
                    .ok_or_else(|| corrupt("metadata event overflow"))?
            }
        }
    }
    for activity in state.activities().values() {
        bytes = bytes
            .checked_add(serde_json::to_vec(activity)?.len())
            .ok_or_else(|| corrupt("metadata byte overflow"))?;
    }
    if bytes > MAX_METADATA_BYTES || chunks > MAX_CHUNKS || pages > MAX_PAGES || events > MAX_EVENTS
    {
        return Err(corrupt("metadata declared quota exceeded"));
    }
    state.metadata_view()?;
    Ok(())
}

fn ids(tx: &Connection, scope: &Scope, table: &str) -> Result<Vec<UpdateId>> {
    let sql=format!("SELECT count(*),coalesce(sum(length(CAST(update_id AS BLOB)) NOT BETWEEN 1 AND 128),0) FROM {table} WHERE realm_id=?1 AND vault_id=?2");
    let (count, invalid): (i64, i64) = tx.query_row(
        &sql,
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if count < 0 || count > MAX_RECORDS as i64 || invalid != 0 {
        return Err(corrupt("metadata membership IDs exceed bound"));
    }
    let sql=format!("SELECT update_id FROM {table} WHERE realm_id=?1 AND vault_id=?2 ORDER BY update_id LIMIT 4097");
    tx.prepare(&sql)?
        .query_map(
            params![scope.realm_id.as_str(), scope.vault_id.as_str()],
            |r| r.get::<_, String>(0),
        )?
        .map(|item| {
            Ok(UpdateId::new(item?)
                .map_err(|_| corrupt("persisted metadata member ID is invalid"))?)
        })
        .collect()
}

fn restore_members(
    tx: &Connection,
    scope: &Scope,
    revision: &Revision,
    records: &[UpdateId],
    activities: &[UpdateId],
) -> Result<MetadataState> {
    validate_ids(records, activities)?;
    check_storage_bounds(tx, scope)?;
    let mut files = BTreeMap::new();
    let mut text = BTreeMap::new();
    for id in records {
        files.insert(id.clone(), file_record(tx, scope, id)?);
    }
    for id in activities {
        text.insert(id.clone(), activity(tx, scope, id)?);
    }
    let state = MetadataState::from_records(scope.clone(), revision.clone(), files, text)?;
    check_limits(&state)?;
    check_retained_quota(tx)?;
    Ok(state)
}

fn check_storage_bounds(tx: &Connection, scope: &Scope) -> Result<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM family_graph_heads WHERE realm_id=?1 AND vault_id=?2)",
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(corrupt("snapshot graph authority is missing"));
    }
    let (total,largest,bad):(i64,i64,i64)=tx.query_row("SELECT coalesce(sum(size),0),coalesce(max(size),0),coalesce(sum(bad),0) FROM (SELECT length(CAST(p.descriptor AS BLOB)) size,(p.update_id IS NULL OR p.descriptor IS NULL) bad FROM family_file_records f LEFT JOIN immutable_payloads p USING(realm_id,vault_id,update_id) WHERE f.realm_id=?1 AND f.vault_id=?2 UNION ALL SELECT length(CAST(record AS BLOB)) size,0 bad FROM family_text_activities WHERE realm_id=?1 AND vault_id=?2)",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if total < 0
        || total > MAX_METADATA_BYTES as i64
        || largest > zorid_file_sync::metadata::MAX_GRAPH_RECORD_BYTES as i64
        || bad != 0
    {
        return Err(corrupt(
            "metadata storage preflight bound or backing source failed",
        ));
    }
    check_retained_quota(tx)
}

fn check_retained_quota(tx: &Connection) -> Result<()> {
    if immutable_payloads::total_bytes(tx)? > MAX_RETAINED_BYTES {
        return Err(corrupt("immutable payload retained-byte quota exceeded"));
    }
    Ok(())
}

pub(super) fn load_metadata(tx: &Connection, scope: &Scope) -> Result<Option<MetadataState>> {
    let head:Option<(String,i64,i64)>=tx.query_row("SELECT CASE WHEN length(CAST(revision AS BLOB)) BETWEEN 1 AND 128 THEN revision ELSE '' END,record_count,activity_count FROM family_graph_heads WHERE realm_id=?1 AND vault_id=?2",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let files = ids(tx, scope, "family_file_records")?;
    let activities = ids(tx, scope, "family_text_activities")?;
    let Some((revision, expected_files, expected_activities)) = head else {
        let retained:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_envelopes WHERE realm_id=?1 AND vault_id=?2 UNION ALL SELECT 1 FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2)",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|r.get(0))?;
        if !files.is_empty() || !activities.is_empty() || retained {
            return Err(corrupt("metadata head missing with retained authority"));
        }
        return Ok(None);
    };
    if expected_files != files.len() as i64 || expected_activities != activities.len() as i64 {
        return Err(corrupt("metadata head count differs from membership"));
    }
    Ok(Some(restore_members(
        tx,
        scope,
        &Revision::new(revision).map_err(|_| corrupt("persisted graph revision is invalid"))?,
        &files,
        &activities,
    )?))
}

/// Metadata-only checks against membership, independent ledger and immutable
/// heads. Never selects payload or wire BLOBs into a metadata graph.
pub(super) fn check_sources(tx: &Connection, state: &MetadataState) -> Result<()> {
    check_limits(state)?;
    check_retained_quota(tx)?;
    for (id, expected) in state.records() {
        if file_record(tx, state.scope(), id)? != *expected {
            return Err(corrupt("metadata source differs from checked graph record"));
        }
    }
    for (id, expected) in state.activities() {
        if activity(tx, state.scope(), id)? != *expected {
            return Err(corrupt(
                "metadata source differs from checked text activity",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MetadataSnapshot {
    pub scope: Scope,
    pub revision: Revision,
    pub records: Vec<UpdateId>,
    pub activities: Vec<UpdateId>,
    pub fingerprint: Sha256Digest,
}
fn validate_ids(records: &[UpdateId], activities: &[UpdateId]) -> Result<()> {
    if records
        .len()
        .checked_add(activities.len())
        .is_none_or(|n| n > MAX_RECORDS)
        || !records.windows(2).all(|p| p[0] < p[1])
        || !activities.windows(2).all(|p| p[0] < p[1])
        || records
            .iter()
            .any(|id| activities.binary_search(id).is_ok())
    {
        return Err(corrupt(
            "snapshot membership is oversized, duplicate or unsorted",
        ));
    }
    Ok(())
}
impl MetadataSnapshot {
    pub(super) fn capture(state: &MetadataState) -> Result<Self> {
        check_limits(state)?;
        Ok(Self {
            scope: state.scope().clone(),
            revision: state.version().clone(),
            records: state.records().keys().cloned().collect(),
            activities: state.activities().keys().cloned().collect(),
            fingerprint: state.fingerprint()?,
        })
    }
    pub(super) fn restore(&self, tx: &Connection) -> Result<MetadataState> {
        validate_ids(&self.records, &self.activities)?;
        let state = restore_members(
            tx,
            &self.scope,
            &self.revision,
            &self.records,
            &self.activities,
        )?;
        self.check(&state)?;
        Ok(state)
    }
    pub(super) fn check(&self, state: &MetadataState) -> Result<()> {
        validate_ids(&self.records, &self.activities)?;
        check_limits(state)?;
        if self.scope != *state.scope()
            || self.revision != *state.version()
            || self.records.iter().ne(state.records().keys())
            || self.activities.iter().ne(state.activities().keys())
            || self.fingerprint != state.fingerprint()?
        {
            return Err(corrupt("snapshot differs from exact metadata authority"));
        }
        Ok(())
    }
}

pub(super) fn read_chunk(
    tx: &Connection,
    scope: &Scope,
    id: &UpdateId,
    expected: &GraphRecord,
) -> Result<Vec<u8>> {
    let actual = file_record(tx, scope, id)?;
    if actual != *expected {
        return Err(corrupt(
            "requested chunk descriptor differs from graph authority",
        ));
    }
    let metadata = family_ledger::metadata_only(tx, &key(scope, id))?
        .ok_or_else(|| corrupt("requested chunk ledger missing"))?
        .metadata;
    checked_chunk(
        &immutable_payloads::read_exact(tx, &metadata)?,
        scope,
        id,
        expected,
    )
}
fn checked_chunk(
    exact: &[u8],
    scope: &Scope,
    id: &UpdateId,
    expected: &GraphRecord,
) -> Result<Vec<u8>> {
    let (actual_scope, actual_id, actual) = GraphRecord::from_authored_exact(exact)?;
    if actual_scope != *scope || actual_id != *id || actual != *expected {
        return Err(corrupt(
            "chunk exact source differs from expected descriptor",
        ));
    }
    match Payload::decode(exact)?.body {
        Body::Chunk { bytes }
            if !bytes.is_empty() && bytes.len() <= zorid_file_sync::MAX_CHUNK_BYTES =>
        {
            Ok(bytes)
        }
        _ => Err(corrupt("requested source is not a bounded chunk")),
    }
}

pub(super) struct ChunkResolver<'a> {
    tx: &'a Connection,
    error: Option<StoreError>,
    stage: Option<(Scope, super::blob_stage::BinaryStageRef, bool)>,
    overlay: Option<(Scope, &'a [(UpdateId, Vec<u8>)])>,
}
impl<'a> ChunkResolver<'a> {
    pub(super) fn new(tx: &'a Connection) -> Self {
        Self {
            tx,
            error: None,
            stage: None,
            overlay: None,
        }
    }
    pub(super) fn for_capture(tx: &'a Connection, captured: &CapturedBinaryRef) -> Result<Self> {
        let reference = super::blob_stage::resolve_locator(tx, &captured.stage)?;
        let info = super::blob_stage::stage_info(tx, &reference)?;
        if !matches!(info.purpose, super::blob_stage::StagePurpose::Capture(_))
            || info.phase != super::blob_stage::StagePhase::Sealed
            || info.manifest.as_ref() != Some(&captured.manifest)
            || info.source_commitment != Some(captured.source_commitment)
        {
            return Err(corrupt(
                "capture range resolver differs from sealed stage authority",
            ));
        }
        Ok(Self {
            tx,
            error: None,
            stage: Some((info.scope, reference, false)),
            overlay: None,
        })
    }
    pub(super) fn for_stage(
        tx: &'a Connection,
        stage: &super::blob_stage::BinaryStageRef,
        overlay: &'a [(UpdateId, Vec<u8>)],
    ) -> Result<Self> {
        let info = super::blob_stage::stage_info(tx, stage)?;
        let allowed = matches!(
            (&info.purpose, info.phase),
            (
                super::blob_stage::StagePurpose::Command(_),
                super::blob_stage::StagePhase::Sealed
                    | super::blob_stage::StagePhase::CommitRequested
            ) | (
                super::blob_stage::StagePurpose::Capture(_),
                super::blob_stage::StagePhase::Sealed
            )
        );
        if !allowed {
            return Err(corrupt(
                "planned binary source is not an eligible sealed stage",
            ));
        }
        if overlay.len() > 1 {
            return Err(corrupt(
                "staged command overlay must contain at most one final frame",
            ));
        }
        let mut resolver = Self::with_overlay(tx, &info.scope, overlay)?;
        for (_, raw) in overlay {
            let (_, _, record) = GraphRecord::from_authored_exact(raw)?;
            if !matches!(
                record.body(),
                GraphRecordBody::Events { .. } | GraphRecordBody::ObservedDelete { .. }
            ) {
                return Err(corrupt("staged overlay must be a final event frame"));
            }
        }
        resolver.stage = Some((info.scope, stage.clone(), true));
        Ok(resolver)
    }
    pub(super) fn with_overlay(
        tx: &'a Connection,
        scope: &Scope,
        overlay: &'a [(UpdateId, Vec<u8>)],
    ) -> Result<Self> {
        if overlay.len() > MAX_RECORDS {
            return Err(corrupt("chunk overlay record bound exceeded"));
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut bytes = 0_usize;
        for (id, raw) in overlay {
            if raw.is_empty()
                || raw.len() > zorid_sync_protocol::MAX_PLAINTEXT_BYTES
                || !seen.insert(id)
            {
                return Err(corrupt("chunk overlay duplicate or frame bound exceeded"));
            }
            bytes = bytes
                .checked_add(raw.len())
                .ok_or_else(|| corrupt("chunk overlay byte overflow"))?;
            if bytes as u64 > MAX_RETAINED_BYTES {
                return Err(corrupt("chunk overlay aggregate bound exceeded"));
            }
            let (actual_scope, actual_id, _) = GraphRecord::from_authored_exact(raw)?;
            if actual_scope != *scope || actual_id != *id {
                return Err(corrupt("chunk overlay scope/update mismatch"));
            }
        }
        Ok(Self {
            tx,
            error: None,
            stage: None,
            overlay: Some((scope.clone(), overlay)),
        })
    }
    pub(super) fn finish<T>(self, result: zorid_file_sync::Result<T>) -> Result<T> {
        if let Some(error) = self.error {
            return Err(error);
        }
        result.map_err(StoreError::from)
    }
    fn resolve(&self, scope: &Scope, id: &UpdateId, expected: &GraphRecord) -> Result<Vec<u8>> {
        if let Some((overlay_scope, overlay)) = &self.overlay {
            if overlay_scope != scope {
                return Err(corrupt("chunk overlay used across scopes"));
            }
            if let Some((_, raw)) = overlay.iter().find(|(key, _)| key == id) {
                return checked_chunk(raw, scope, id, expected);
            }
        }
        if let Some((stage_scope, reference, graph_first)) = &self.stage {
            if stage_scope != scope {
                return Err(corrupt("stage resolver used across scopes"));
            }
            if *graph_first {
                let member:bool=self.tx.query_row("SELECT EXISTS(SELECT 1 FROM family_file_records WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3)",params![scope.realm_id.as_str(),scope.vault_id.as_str(),id.as_str()],|r|r.get(0))?;
                if member {
                    return read_chunk(self.tx, scope, id, expected);
                }
            }
            let metadata = super::blob_stage::expected_source_metadata(self.tx, reference, id)?;
            let exact = immutable_payloads::read_exact(self.tx, &metadata)?;
            return checked_chunk(&exact, scope, id, expected);
        }
        read_chunk(self.tx, scope, id, expected)
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
        match self.resolve(scope, id, expected) {
            Ok(bytes) => Ok(bytes),
            Err(error) => {
                self.error = Some(error);
                Err(zorid_file_sync::Error::InvalidState)
            }
        }
    }
}
pub(super) fn verify_metadata(
    tx: &Connection,
    state: &MetadataState,
    overlay: &[(UpdateId, Vec<u8>)],
) -> Result<VerifiedBinarySet> {
    check_limits(state)?;
    let mut resolver = ChunkResolver::with_overlay(tx, state.scope(), overlay)?;
    let verified =
        zorid_file_sync::binary_stream::verify_complete_binary_manifests(state, &mut resolver);
    resolver.finish(verified)
}

pub(super) fn verify_staged_metadata(
    tx: &Connection,
    state: &MetadataState,
    stage: &super::blob_stage::BinaryStageRef,
    overlay: &[(UpdateId, Vec<u8>)],
) -> Result<VerifiedBinarySet> {
    check_limits(state)?;
    let mut resolver = ChunkResolver::for_stage(tx, stage, overlay)?;
    if resolver
        .stage
        .as_ref()
        .is_none_or(|(scope, _, _)| scope != state.scope())
    {
        return Err(corrupt("staged verification scope differs from candidate"));
    }
    let verified =
        zorid_file_sync::binary_stream::verify_complete_binary_manifests(state, &mut resolver);
    resolver.finish(verified)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub(crate) fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        for (_, sql) in immutable_payloads::SCHEMA
            .iter()
            .chain(family_ledger::SCHEMA)
            .chain(file_state::SCHEMA)
            .chain(blob_stage::SCHEMA)
            .chain(binary_commit::SCHEMA)
        {
            db.execute_batch(sql).unwrap();
        }
        db
    }
    pub(crate) fn scope() -> Scope {
        Scope {
            realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
        }
    }
    pub(crate) fn revision(value: &str) -> Revision {
        Revision::new(value).unwrap()
    }
    pub(crate) fn chunk(id: &str, bytes: &[u8]) -> (UpdateId, GraphRecord, Vec<u8>) {
        let id = UpdateId::new(id).unwrap();
        let payload = Payload {
            family: zorid_file_sync::Family::Files,
            format_version: 2,
            scope: scope(),
            id: id.clone(),
            body: Body::Chunk {
                bytes: bytes.to_vec(),
            },
        };
        let mut exact = vec![b' '];
        exact.extend(payload.encode().unwrap());
        let (_, _, record) = GraphRecord::from_authored_exact(&exact).unwrap();
        (id, record, exact)
    }
    pub(crate) fn retain(db: &Connection, id: &UpdateId, record: &GraphRecord, exact: &[u8]) {
        let metadata = EnvelopeMetadata {
            key: key(&scope(), id),
            family: Family::Files,
            format_version: 2,
            payload_bytes: exact.len() as u32,
            payload_digest: Sha256Digest::of(exact),
            file_summary_digest: Some(record.summary_digest().unwrap()),
            text_binding: None,
        };
        family_ledger::insert_authored(db, &metadata, exact).unwrap();
        immutable_payloads::put_exact(db, &metadata, exact, MAX_RETAINED_BYTES).unwrap();
    }
    pub(crate) fn append(
        db: &Connection,
        expected: &MetadataState,
        id: &str,
        version: &str,
    ) -> MetadataState {
        let (id, record, exact) = chunk(id, b"fixture bytes");
        let mut batch = zorid_file_sync::metadata_plan::AuthoredMetadataBatch::new(scope());
        batch.push_exact(&exact).unwrap();
        let candidate = zorid_file_sync::metadata_plan::prepare_authored_batch(
            expected,
            batch,
            revision(version),
        )
        .unwrap();
        let verified = verify_metadata(
            db,
            candidate.verification_state(),
            &[(id.clone(), exact.clone())],
        )
        .unwrap();
        let plan = candidate.finalize(verified).unwrap();
        retain(db, &id, &record, &exact);
        persist_plan(db, &plan).unwrap();
        plan.next_state().unwrap().clone()
    }
    pub(crate) fn fixture() -> (Connection, Scope, UpdateId, GraphRecord, Vec<u8>) {
        let db = db();
        let scope = scope();
        let (id, record, exact) = chunk("chunk", &[7, 8, 9]);
        file_state::initialize(&db, &scope, &revision("revision")).unwrap();
        retain(&db, &id, &record, &exact);
        db.execute(
            "INSERT INTO family_file_records VALUES(?1,?2,?3)",
            params![
                scope.realm_id.as_str(),
                scope.vault_id.as_str(),
                id.as_str()
            ],
        )
        .unwrap();
        db.execute("UPDATE family_graph_heads SET record_count=1", [])
            .unwrap();
        (db, scope, id, record, exact)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use zorid_file_sync::binary_stream::ChunkSource;

    #[test]
    fn descriptors_retain_exact_source_and_chunk_bytes_are_checked_on_demand() {
        let (db, scope, id, record, mut exact) = fixture();
        let state = load_metadata(&db, &scope).unwrap().unwrap();
        assert_eq!(
            state.records()[&id].payload_digest(),
            &Sha256Digest::of(&exact)
        );
        assert_eq!(
            read_chunk(&db, &scope, &id, &record).unwrap(),
            vec![7, 8, 9]
        );
        let pos = exact.iter().rposition(|b| *b == b'9').unwrap();
        exact[pos] = b'6';
        db.execute_batch("DROP TRIGGER immutable_payloads_no_update")
            .unwrap();
        db.execute("UPDATE immutable_payloads SET payload=?1", [exact])
            .unwrap();
        assert!(load_metadata(&db, &scope).unwrap().is_some());
        assert!(check_sources(&db, &state).is_ok());
        assert!(matches!(
            read_chunk(&db, &scope, &id, &record),
            Err(StoreError::Corrupt(_))
        ));
        let mut resolver = ChunkResolver::new(&db);
        assert!(resolver.read_chunk(&scope, &id, &record).is_err());
        assert!(matches!(
            resolver.finish(Ok(())),
            Err(StoreError::Corrupt(_))
        ));
    }

    #[test]
    fn descriptor_tamper_and_missing_backing_fail_closed() {
        let (db, scope, _, _, _) = fixture();
        db.execute_batch("DROP TRIGGER immutable_payloads_no_update")
            .unwrap();
        db.execute("UPDATE immutable_payloads SET descriptor='{}'", [])
            .unwrap();
        assert!(matches!(
            load_metadata(&db, &scope),
            Err(StoreError::Corrupt(_))
        ));
        let (db, scope, id, record, _) = fixture();
        db.pragma_update(None, "foreign_keys", false).unwrap();
        db.execute_batch("DROP TRIGGER immutable_payloads_no_delete")
            .unwrap();
        db.execute("DELETE FROM immutable_payloads", []).unwrap();
        assert!(matches!(
            load_metadata(&db, &scope),
            Err(StoreError::Corrupt(_))
        ));
        assert!(matches!(
            read_chunk(&db, &scope, &id, &record),
            Err(StoreError::Corrupt(_))
        ));
    }

    #[test]
    fn snapshots_restore_exact_old_membership_and_validate_ids_before_queries() {
        let db = db();
        let scope = scope();
        let initial = file_state::initialize(&db, &scope, &revision("initial")).unwrap();
        let first = append(&db, &initial, "first", "first-revision");
        let snapshot = MetadataSnapshot::capture(&first).unwrap();
        let next = append(&db, &first, "second", "second-revision");
        assert_eq!(snapshot.restore(&db).unwrap(), first);
        assert!(snapshot.check(&next).is_err());
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("payload") && !json.contains("descriptor"));
        let mut forged = snapshot.clone();
        forged.fingerprint = Sha256Digest::of(b"wrong");
        assert!(forged.restore(&db).is_err());
        let no_schema = Connection::open_in_memory().unwrap();
        let mut duplicate = snapshot.clone();
        duplicate.records.push(duplicate.records[0].clone());
        assert!(matches!(
            duplicate.restore(&no_schema),
            Err(StoreError::Corrupt(_))
        ));
        let mut oversized = snapshot.clone();
        oversized.records = vec![UpdateId::new("same").unwrap(); 4097];
        assert!(matches!(
            oversized.restore(&no_schema),
            Err(StoreError::Corrupt(_))
        ));
        db.execute(
            "DELETE FROM family_file_records WHERE update_id='first'",
            [],
        )
        .unwrap();
        assert!(snapshot.restore(&db).is_err());
    }

    #[test]
    fn overlay_matches_exact_scope_id_and_descriptor_without_bad_fallback() {
        let (db, scope, id, record, exact) = fixture();
        let frames = vec![(id.clone(), exact.clone())];
        let mut resolver = ChunkResolver::with_overlay(&db, &scope, &frames).unwrap();
        assert_eq!(
            resolver.read_chunk(&scope, &id, &record).unwrap(),
            vec![7, 8, 9]
        );
        let (_, _, changed) = chunk("chunk", &[7, 8, 6]);
        let bad = vec![(id.clone(), changed)];
        let mut resolver = ChunkResolver::with_overlay(&db, &scope, &bad).unwrap();
        assert!(resolver.read_chunk(&scope, &id, &record).is_err());
        assert!(resolver.finish(Ok(())).is_err());
        assert!(ChunkResolver::with_overlay(
            &db,
            &scope,
            &[(id.clone(), exact.clone()), (id, exact)]
        )
        .is_err());
    }

    #[test]
    fn capture_range_resolver_does_not_rehash_the_full_capture_at_construction() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("vault.sqlite")).unwrap();
        store.family_enroll(&scope()).unwrap();
        let request = blob_stage::BinaryCaptureRequest {
            path: zorid_core::VaultPath::new("capture.bin").unwrap(),
            expected_length: 3,
            expected_digest: Sha256Digest::of(&[7, 8, 9]),
        };
        let limits = StreamingLimits {
            max_active_stages: 1,
            max_stage_records: 4,
            max_staged_bytes: 1024 * 1024,
            max_chunk_records: 4,
            max_page_records: 4,
        };
        let stage = store
            .begin_binary_capture(
                &zorid_core::OperationId::new("client").unwrap(),
                &zorid_core::OperationId::new("capture").unwrap(),
                &request,
                limits,
            )
            .unwrap();
        store.append_binary_chunk(&stage, 0, 0, &[7, 8, 9]).unwrap();
        store.seal_binary_stage(&stage, 3, None).unwrap();
        let captured = store.captured_binary_ref(&stage).unwrap();
        let metadata = blob_stage::capture_metadata(&store.connection, &captured).unwrap();
        let (id, record) = metadata
            .records()
            .iter()
            .find(|(_, record)| matches!(record.body(), GraphRecordBody::Chunk { .. }))
            .unwrap();
        // A pre-promotion source is not yet an ordinary graph member. Only the
        // explicitly scoped stage resolver can use its independent commitments.
        let mut ordinary = ChunkResolver::new(&store.connection);
        assert!(ordinary.read_chunk(metadata.scope(), id, record).is_err());
        let mut staged = ChunkResolver::for_stage(&store.connection, &stage, &[]).unwrap();
        assert_eq!(
            staged.read_chunk(metadata.scope(), id, record).unwrap(),
            vec![7, 8, 9]
        );
        let proof = verify_staged_metadata(&store.connection, &metadata, &stage, &[]).unwrap();
        proof.check_preconditions(&metadata).unwrap();
        let raw: Vec<u8> = store
            .connection
            .query_row(
                "SELECT payload FROM immutable_payloads WHERE update_id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        let mut changed = Payload::decode(&raw).unwrap();
        changed.body = Body::Chunk {
            bytes: vec![7, 8, 6],
        };
        store
            .connection
            .execute_batch("DROP TRIGGER immutable_payloads_no_update")
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE immutable_payloads SET payload=?1 WHERE update_id=?2",
                params![changed.encode().unwrap(), id.as_str()],
            )
            .unwrap();
        // Construction resolves only owner, purpose, manifest and commitment.
        let mut resolver = ChunkResolver::for_capture(&store.connection, &captured).unwrap();
        assert!(resolver.read_chunk(metadata.scope(), id, record).is_err());
        assert!(matches!(
            resolver.finish(Ok(())),
            Err(StoreError::Corrupt(_))
        ));
    }
}
