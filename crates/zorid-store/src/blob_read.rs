//! Durable, explicit binary read pins. Locators and persisted snapshots are
//! identities only; open/resume verify actual bytes to construct private proof.
use super::blob_index::{ChunkResolver, MetadataSnapshot};
use super::content::{BinarySourceRef, CapturedBinaryRef, PublishedBinaryRef};
use super::*;
use zorid_core::OperationId;
use zorid_file_sync::binary_stream::{verify_manifest, ChunkSource, VerifiedManifest};
use zorid_file_sync::materialization::ContentWitness;
use zorid_file_sync::metadata::{GraphRecordBody, MetadataState};
use zorid_file_sync::Sha256Digest;

pub const BINARY_READ_MAX_ACTIVE_PINS: usize = 4;
pub const BINARY_READ_MAX_RANGE_BYTES: u32 = 128 * 1024;
const MAX_PIN_ROW_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;
pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("binary_read_pins", "CREATE TABLE binary_read_pins (pin_id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(pin_id AS BLOB)) BETWEEN 1 AND 128),local_store_id TEXT NOT NULL CHECK(length(CAST(local_store_id AS BLOB)) BETWEEN 1 AND 128),client_id TEXT NOT NULL CHECK(length(CAST(client_id AS BLOB)) BETWEEN 1 AND 128),read_id TEXT NOT NULL CHECK(length(CAST(read_id AS BLOB)) BETWEEN 1 AND 128),record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) BETWEEN 1 AND 2162688),UNIQUE(client_id,read_id))"),
];
fn invalid(message: &str) -> StoreError {
    ContractError::InvalidMutation {
        reason: message.into(),
    }
    .into()
}
fn corrupt(message: &str) -> StoreError {
    StoreError::Corrupt(message.into())
}

/// Store-issued pin identity. Boundary adapters must resume via the owning
/// client and pin ID rather than deserialize a locator into proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BinaryReadRef {
    local_store_id: OperationId,
    client_id: OperationId,
    pin_id: OperationId,
    read_id: OperationId,
}
impl BinaryReadRef {
    pub fn local_store_id(&self) -> &OperationId {
        &self.local_store_id
    }
    pub fn client_id(&self) -> &OperationId {
        &self.client_id
    }
    pub fn pin_id(&self) -> &OperationId {
        &self.pin_id
    }
    pub fn read_id(&self) -> &OperationId {
        &self.read_id
    }
}

/// Only an actual complete verification constructs this in-process session.
/// It has no deserializer and persists neither a proof nor a verified boolean.
#[derive(Debug)]
pub struct BinaryReadSession {
    reference: BinaryReadRef,
    source: BinarySourceRef,
    state: Option<EntryState>,
    metadata: MetadataState,
    verified: VerifiedManifest,
    exact_pin_record: String,
}
impl BinaryReadSession {
    pub fn reference(&self) -> &BinaryReadRef {
        &self.reference
    }
    pub fn source(&self) -> &BinarySourceRef {
        &self.source
    }
    pub fn state(&self) -> Option<&EntryState> {
        self.state.as_ref()
    }
    pub fn len(&self) -> u64 {
        self.source.len()
    }
    pub fn is_empty(&self) -> bool {
        self.source.is_empty()
    }
    pub fn digest(&self) -> &Sha256Digest {
        self.source.digest()
    }
}

/// Result bytes are bounded to one range, which may cross a chunk boundary.
/// This is not itself a publication capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryReadChunk {
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub eof: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PinRecord {
    source: BinarySourceRef,
    state: Option<EntryState>,
    snapshot: MetadataSnapshot,
}
fn check_local(tx: &Connection, reference: &BinaryReadRef) -> Result<()> {
    if text_sync::identity(tx)?.local_store_id != reference.local_store_id {
        return Err(zorid_file_sync::Error::IdentityMismatch.into());
    }
    Ok(())
}
fn check_scope(tx: &Connection, metadata: &MetadataState) -> Result<()> {
    let identity = text_sync::identity(tx)?;
    if identity.realm_id.as_ref() != Some(&metadata.scope().realm_id)
        || identity.vault_id.as_ref() != Some(&metadata.scope().vault_id)
    {
        return Err(zorid_file_sync::Error::IdentityMismatch.into());
    }
    Ok(())
}
fn new_reference(
    tx: &Connection,
    client: &OperationId,
    read_id: &OperationId,
) -> Result<BinaryReadRef> {
    Ok(BinaryReadRef {
        local_store_id: text_sync::identity(tx)?.local_store_id,
        client_id: client.clone(),
        pin_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
        read_id: read_id.clone(),
    })
}
fn check_graph_publication(
    tx: &Connection,
    state: &EntryState,
    source: &PublishedBinaryRef,
    metadata: &MetadataState,
) -> Result<()> {
    if state.deleted || state.kind != EntryKind::File || state.id != source.identity.entry_id {
        return Err(invalid(
            "binary pin requires its exact historical file publication",
        ));
    }
    let history = family_materialization::history(tx, &state.id, &state.revision)?
        .ok_or_else(|| corrupt("binary pin publication history missing"))?;
    if history.identity != source.identity
        || !matches!(&history.publication, FamilyPublication::Normal { path, kind, .. }
            if path == &state.path && *kind == state.kind)
        || !matches!(&history.retained_content, Some(FamilyContentWitness {
            digest,
            witness: ContentWitness::Binary { selected_event, manifest },
        }) if digest == &source.manifest.digest
            && selected_event == &source.selected_event && manifest == &source.manifest)
    {
        return Err(corrupt(
            "binary pin differs from exact historical publication",
        ));
    }
    source.resolve(metadata)?;
    Ok(())
}
fn verify_source(
    tx: &Connection,
    source: &BinarySourceRef,
    metadata: &MetadataState,
) -> Result<VerifiedManifest> {
    let mut resolver = match source {
        BinarySourceRef::Graph(_) => ChunkResolver::new(tx),
        BinarySourceRef::Capture(value) => ChunkResolver::for_capture(tx, value)?,
    };
    let result = verify_manifest(metadata, source.manifest(), &mut resolver);
    resolver.finish(result)
}
fn issue(
    tx: &Connection,
    reference: BinaryReadRef,
    source: BinarySourceRef,
    state: Option<EntryState>,
    metadata: MetadataState,
) -> Result<BinaryReadSession> {
    let count: i64 = tx.query_row("SELECT count(*) FROM binary_read_pins", [], |r| r.get(0))?;
    if count >= BINARY_READ_MAX_ACTIVE_PINS as i64 {
        return Err(zorid_file_sync::Error::TooLarge.into());
    }
    let verified = verify_source(tx, &source, &metadata)?;
    let record = PinRecord {
        source: source.clone(),
        state: state.clone(),
        snapshot: MetadataSnapshot::capture(&metadata)?,
    };
    let exact_pin_record = serde_json::to_string(&record)?;
    if exact_pin_record.len() > MAX_PIN_ROW_BYTES {
        return Err(zorid_file_sync::Error::TooLarge.into());
    }
    tx.execute(
        "INSERT INTO binary_read_pins(pin_id,local_store_id,client_id,read_id,record) VALUES(?1,?2,?3,?4,?5)",
        params![
            reference.pin_id.as_str(),
            reference.local_store_id.as_str(),
            reference.client_id.as_str(),
            reference.read_id.as_str(),
            &exact_pin_record
        ],
    )?;
    Ok(BinaryReadSession {
        reference,
        source,
        state,
        metadata,
        verified,
        exact_pin_record,
    })
}
fn load_record(tx: &Connection, reference: &BinaryReadRef) -> Result<(PinRecord, String)> {
    check_local(tx, reference)?;
    let (local, client, read_id, size): (String, String, String, i64) = tx.query_row(
        "SELECT local_store_id,client_id,read_id,length(CAST(record AS BLOB)) FROM binary_read_pins WHERE pin_id=?1",
        [reference.pin_id.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
        .optional()?.ok_or_else(|| invalid("binary read pin is closed or absent"))?;
    if local != reference.local_store_id.as_str()
        || client != reference.client_id.as_str()
        || read_id != reference.read_id.as_str()
    {
        return Err(zorid_file_sync::Error::IdentityMismatch.into());
    }
    if size <= 0 || size > MAX_PIN_ROW_BYTES as i64 {
        return Err(corrupt("binary read pin metadata exceeds its bound"));
    }
    let raw: String = tx.query_row(
        "SELECT record FROM binary_read_pins WHERE pin_id=?1",
        [reference.pin_id.as_str()],
        |r| r.get(0),
    )?;
    Ok((serde_json::from_str(&raw)?, raw))
}
fn check_session(tx: &Connection, session: &BinaryReadSession) -> Result<()> {
    check_local(tx, &session.reference)?;
    check_scope(tx, &session.metadata)?;
    // Compare the retained row in SQLite without allocating/parsing another copy
    // of the snapshot on each range. Closing/replacing a pin invalidates proof.
    let row: Option<(String, String, bool)> = tx
        .query_row(
            "SELECT local_store_id,client_id,record=?2 AND read_id=?3 FROM binary_read_pins WHERE pin_id=?1",
            params![session.reference.pin_id.as_str(), &session.exact_pin_record,session.reference.read_id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((local, client, exact)) = row else {
        return Err(invalid("binary read pin is closed or absent"));
    };
    if local != session.reference.local_store_id.as_str()
        || client != session.reference.client_id.as_str()
    {
        return Err(zorid_file_sync::Error::IdentityMismatch.into());
    }
    if !exact {
        return Err(corrupt("binary read pin snapshot changed"));
    }
    session
        .verified
        .check_preconditions(&session.metadata, session.source.manifest())?;
    Ok(())
}

fn restore_session(
    tx: &Connection,
    reference: BinaryReadRef,
    record: PinRecord,
    exact_pin_record: String,
) -> Result<BinaryReadSession> {
    let metadata = match (&record.source, &record.state) {
        (BinarySourceRef::Graph(source), Some(state)) => {
            let metadata = record.snapshot.restore(tx)?;
            check_graph_publication(tx, state, source, &metadata)?;
            metadata
        }
        (BinarySourceRef::Capture(source), None) => {
            if source.stage.client_id != reference.client_id
                || source.stage.local_store_id != reference.local_store_id
            {
                return Err(zorid_file_sync::Error::IdentityMismatch.into());
            }
            let metadata = blob_stage::capture_metadata(tx, source)?;
            record.snapshot.check(&metadata)?;
            metadata
        }
        _ => return Err(corrupt("binary pin source and publication state disagree")),
    };
    check_scope(tx, &metadata)?;
    let verified = verify_source(tx, &record.source, &metadata)?;
    Ok(BinaryReadSession {
        reference,
        source: record.source,
        state: record.state,
        metadata,
        verified,
        exact_pin_record,
    })
}
/// Read-ID retries resolve only the original row; they do not replan against a
/// current target or allocate a second pin when the original ACK was lost.
fn retry_open(
    tx: &Connection,
    reference: &BinaryReadRef,
    source: &BinarySourceRef,
    state: Option<&EntryState>,
) -> Result<Option<BinaryReadSession>> {
    let pin_id: Option<String> = tx
        .query_row(
            "SELECT pin_id FROM binary_read_pins WHERE client_id=?1 AND read_id=?2",
            params![reference.client_id.as_str(), reference.read_id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    let Some(pin_id) = pin_id else {
        return Ok(None);
    };
    let mut reference = reference.clone();
    reference.pin_id = OperationId::new(pin_id)?;
    let (record, exact) = load_record(tx, &reference)?;
    if &record.source != source || record.state.as_ref() != state {
        return Err(invalid(
            "binary read ID is already bound to a different source or publication state",
        ));
    }
    restore_session(tx, reference, record, exact).map(Some)
}

impl Store {
    /// Random-ID convenience for callers that do not need lost-ACK recovery.
    pub fn open_binary_read(
        &mut self,
        client: &OperationId,
        state: &EntryState,
        source: &PublishedBinaryRef,
    ) -> Result<BinaryReadSession> {
        let read_id = OperationId::new(uuid::Uuid::new_v4().to_string())?;
        self.open_binary_read_with_id(client, &read_id, state, source)
    }
    /// The caller checkpoints read_id before issuing this request. The ID is
    /// lookup identity only; exact retries still restore and verify actual bytes.
    pub fn open_binary_read_with_id(
        &mut self,
        client: &OperationId,
        read_id: &OperationId,
        state: &EntryState,
        source: &PublishedBinaryRef,
    ) -> Result<BinaryReadSession> {
        let tx = self.connection.transaction()?;
        let reference = new_reference(&tx, client, read_id)?;
        let source_ref = BinarySourceRef::Graph(source.clone());
        if let Some(session) = retry_open(&tx, &reference, &source_ref, Some(state))? {
            tx.commit()?;
            return Ok(session);
        }
        let authority = text_sync::identity(&tx)?;
        if authority.realm_id.as_ref() != Some(&source.scope.realm_id)
            || authority.vault_id.as_ref() != Some(&source.scope.vault_id)
        {
            return Err(zorid_file_sync::Error::IdentityMismatch.into());
        }
        let metadata = blob_index::load_metadata(&tx, &source.scope)?
            .ok_or_else(|| corrupt("binary read graph missing"))?;
        check_graph_publication(&tx, state, source, &metadata)?;
        let session = issue(&tx, reference, source_ref, Some(state.clone()), metadata)?;
        tx.commit()?;
        Ok(session)
    }
    /// Random-ID convenience. Durable callers use open_capture_read_with_id.
    pub fn open_capture_read(
        &mut self,
        client: &OperationId,
        source: &CapturedBinaryRef,
    ) -> Result<BinaryReadSession> {
        let read_id = OperationId::new(uuid::Uuid::new_v4().to_string())?;
        self.open_capture_read_with_id(client, &read_id, source)
    }
    pub fn open_capture_read_with_id(
        &mut self,
        client: &OperationId,
        read_id: &OperationId,
        source: &CapturedBinaryRef,
    ) -> Result<BinaryReadSession> {
        let tx = self.connection.transaction()?;
        let reference = new_reference(&tx, client, read_id)?;
        let source_ref = BinarySourceRef::Capture(source.clone());
        if let Some(session) = retry_open(&tx, &reference, &source_ref, None)? {
            tx.commit()?;
            return Ok(session);
        }
        if source.stage.client_id != *client
            || source.stage.local_store_id != reference.local_store_id
        {
            return Err(zorid_file_sync::Error::IdentityMismatch.into());
        }
        let metadata = blob_stage::capture_metadata(&tx, source)?;
        let session = issue(&tx, reference, source_ref, None, metadata)?;
        tx.commit()?;
        Ok(session)
    }
    pub fn resume_binary_read(
        &self,
        client: &OperationId,
        pin_id: &OperationId,
    ) -> Result<BinaryReadSession> {
        let tx = self.connection.unchecked_transaction()?;
        let read_id: Option<String> = tx
            .query_row(
                "SELECT read_id FROM binary_read_pins WHERE pin_id=?1",
                [pin_id.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let read_id = read_id.ok_or_else(|| invalid("binary read pin is closed or absent"))?;
        let reference = BinaryReadRef {
            local_store_id: text_sync::identity(&tx)?.local_store_id,
            client_id: client.clone(),
            pin_id: pin_id.clone(),
            read_id: OperationId::new(read_id)?,
        };
        let (record, exact_pin_record) = load_record(&tx, &reference)?;
        let session = restore_session(&tx, reference, record, exact_pin_record)?;
        tx.commit()?;
        Ok(session)
    }
    /// Bounded owner-scoped discovery for explicit restart cleanup. These are
    /// locators, never verified sessions; every resume revalidates source bytes.
    pub fn list_binary_reads(&self, client: &OperationId) -> Result<Vec<BinaryReadRef>> {
        let tx = self.connection.unchecked_transaction()?;
        let local_store_id = text_sync::identity(&tx)?.local_store_id;
        let count: i64 = tx.query_row("SELECT count(*) FROM binary_read_pins", [], |r| r.get(0))?;
        if count > BINARY_READ_MAX_ACTIVE_PINS as i64 {
            return Err(corrupt("binary read pin count exceeds its bound"));
        }
        let references = {
            let mut statement = tx.prepare("SELECT pin_id,read_id FROM binary_read_pins WHERE local_store_id=?1 AND client_id=?2 ORDER BY pin_id LIMIT 5")?;
            let mut rows = statement.query(params![local_store_id.as_str(), client.as_str()])?;
            let mut references = Vec::new();
            while let Some(row) = rows.next()? {
                references.push(BinaryReadRef {
                    local_store_id: local_store_id.clone(),
                    client_id: client.clone(),
                    pin_id: OperationId::new(row.get::<_, String>(0)?)?,
                    read_id: OperationId::new(row.get::<_, String>(1)?)?,
                });
            }
            references
        };
        if references.len() > BINARY_READ_MAX_ACTIVE_PINS {
            return Err(corrupt("owner binary read pin count exceeds its bound"));
        }
        tx.commit()?;
        Ok(references)
    }
    pub fn read_binary_range(
        &self,
        session: &BinaryReadSession,
        offset: u64,
        max_len: u32,
    ) -> Result<BinaryReadChunk> {
        if max_len > BINARY_READ_MAX_RANGE_BYTES || offset > session.len() {
            return Err(invalid("binary read range exceeds its bounds"));
        }
        let end = offset
            .checked_add(u64::from(max_len))
            .ok_or_else(|| invalid("binary read range overflow"))?
            .min(session.len());
        let tx = self.connection.unchecked_transaction()?;
        check_session(&tx, session)?;
        let mut resolver = match &session.source {
            BinarySourceRef::Graph(_) => ChunkResolver::new(&tx),
            BinarySourceRef::Capture(source) => ChunkResolver::for_capture(&tx, source)?,
        };
        let result = read_range(
            &session.metadata,
            session.source.manifest(),
            offset,
            end,
            &mut resolver,
        );
        let bytes = resolver.finish(result)?;
        tx.commit()?;
        Ok(BinaryReadChunk {
            offset,
            bytes,
            eof: end == session.len(),
        })
    }
    /// Explicit release; repeated closes of this issued locator are harmless.
    /// Immutable payloads/stages are retained independently and are never GC'd.
    pub fn close_binary_read(&mut self, reference: &BinaryReadRef) -> Result<()> {
        let tx = self.connection.transaction()?;
        check_local(&tx, reference)?;
        let owner: Option<(String, String, String)> = tx
            .query_row(
                "SELECT local_store_id,client_id,read_id FROM binary_read_pins WHERE pin_id=?1",
                [reference.pin_id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((local, client, read_id)) = owner {
            if local != reference.local_store_id.as_str()
                || client != reference.client_id.as_str()
                || read_id != reference.read_id.as_str()
            {
                return Err(zorid_file_sync::Error::IdentityMismatch.into());
            }
            tx.execute(
                "DELETE FROM binary_read_pins WHERE pin_id=?1",
                [reference.pin_id.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

fn read_range(
    metadata: &MetadataState,
    manifest: &zorid_file_sync::Manifest,
    start: u64,
    end: u64,
    source: &mut impl ChunkSource,
) -> zorid_file_sync::Result<Vec<u8>> {
    use zorid_file_sync::Error;
    if start == end {
        return Ok(Vec::new());
    }
    let mut result = Vec::with_capacity((end - start) as usize);
    let mut page_start = 0u64;
    for page_ref in &manifest.pages {
        let page_end = page_start
            .checked_add(page_ref.bytes)
            .ok_or(Error::InvalidContent)?;
        if page_start >= end {
            break;
        }
        if page_end <= start {
            page_start = page_end;
            continue;
        }
        let page_record = metadata
            .records()
            .get(&page_ref.id)
            .ok_or(Error::InvalidState)?;
        let GraphRecordBody::Page { page } = page_record.body() else {
            return Err(Error::InvalidContent);
        };
        if page.reference(page_ref.id.clone())? != *page_ref {
            return Err(Error::InvalidContent);
        }
        let mut chunk_start = page_start;
        for chunk in &page.chunks {
            let chunk_end = chunk_start
                .checked_add(u64::from(chunk.bytes))
                .ok_or(Error::InvalidContent)?;
            if chunk_start >= end {
                break;
            }
            if chunk_end > start {
                let expected = metadata
                    .records()
                    .get(&chunk.id)
                    .ok_or(Error::InvalidState)?;
                if !matches!(expected.body(), GraphRecordBody::Chunk {bytes,digest}
                    if *bytes == chunk.bytes && digest == &chunk.digest)
                {
                    return Err(Error::InvalidContent);
                }
                let bytes = source.read_chunk(metadata.scope(), &chunk.id, expected)?;
                if bytes.len() != chunk.bytes as usize || Sha256Digest::of(&bytes) != chunk.digest {
                    return Err(Error::InvalidContent);
                }
                let from = start.saturating_sub(chunk_start) as usize;
                let to = (end.min(chunk_end) - chunk_start) as usize;
                result.extend_from_slice(&bytes[from..to]);
            }
            chunk_start = chunk_end;
        }
        page_start = page_end;
    }
    if result.len() != (end - start) as usize {
        return Err(Error::InvalidContent);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zorid_core::VaultPath;
    use zorid_file_sync::binary_stream::BinaryManifestBuilder;
    use zorid_file_sync::metadata::GraphRecord;
    use zorid_file_sync::{Manifest, Scope};
    use zorid_sync_protocol::{RealmId, UpdateId, VaultId};

    fn op(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn scope() -> Scope {
        Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        }
    }
    fn enrolled(path: &Path) -> Store {
        let mut store = Store::open(path).unwrap();
        store.family_enroll(&scope()).unwrap();
        store
    }
    fn capture(store: &mut Store, body: &[u8]) -> CapturedBinaryRef {
        let reference = store
            .begin_binary_capture(
                &op("client"),
                &op("capture"),
                &blob_stage::BinaryCaptureRequest {
                    path: VaultPath::new("source.bin").unwrap(),
                    expected_length: body.len() as u64,
                    expected_digest: Sha256Digest::of(body),
                },
                StreamingLimits {
                    max_active_stages: 4,
                    max_stage_records: 8,
                    max_staged_bytes: 8 * 1024 * 1024,
                    max_chunk_records: 16,
                    max_page_records: 4,
                },
            )
            .unwrap();
        for (sequence, bytes) in body
            .chunks(BINARY_READ_MAX_RANGE_BYTES as usize)
            .enumerate()
        {
            store
                .append_binary_chunk(
                    &reference,
                    sequence as u32,
                    (sequence * BINARY_READ_MAX_RANGE_BYTES as usize) as u64,
                    bytes,
                )
                .unwrap();
        }
        store
            .seal_binary_stage(&reference, body.len() as u64, Some(Sha256Digest::of(body)))
            .unwrap();
        store.captured_binary_ref(&reference).unwrap()
    }

    #[test]
    fn capture_pin_quota_owner_restart_and_explicit_close() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = enrolled(&path);
        let body = [
            vec![3; BINARY_READ_MAX_RANGE_BYTES as usize],
            b"last".to_vec(),
        ]
        .concat();
        let captured = capture(&mut store, &body);
        assert!(store.open_capture_read(&op("other"), &captured).is_err());
        let mut pins = Vec::new();
        for _ in 0..BINARY_READ_MAX_ACTIVE_PINS {
            pins.push(store.open_capture_read(&op("client"), &captured).unwrap());
        }
        assert!(store.open_capture_read(&op("client"), &captured).is_err());
        assert!(store
            .resume_binary_read(&op("other"), pins[0].reference().pin_id())
            .is_err());
        let mut forged = pins[0].reference().clone();
        forged.client_id = op("other");
        assert!(store.close_binary_read(&forged).is_err());
        let original = pins.remove(0);
        let reference = original.reference().clone();
        drop(store);
        let mut store = Store::open(&path).unwrap();
        let resumed = store
            .resume_binary_read(&op("client"), reference.pin_id())
            .unwrap();
        assert_eq!(resumed.source(), original.source());
        assert!(resumed.state().is_none());
        let tail = store
            .read_binary_range(&resumed, body.len() as u64 - 6, 100)
            .unwrap();
        assert_eq!(tail.bytes, body[body.len() - 6..]);
        assert!(tail.eof);
        assert!(store
            .read_binary_range(&resumed, 0, BINARY_READ_MAX_RANGE_BYTES + 1)
            .is_err());
        assert!(store.read_binary_range(&resumed, u64::MAX, 1).is_err());
        let eof = store
            .read_binary_range(&resumed, body.len() as u64, 1)
            .unwrap();
        assert!(eof.bytes.is_empty() && eof.eof);
        let zero = store.read_binary_range(&resumed, 1, 0).unwrap();
        assert!(zero.bytes.is_empty() && !zero.eof);
        let mut other = enrolled(&dir.path().join("other.sqlite"));
        assert!(other.read_binary_range(&resumed, 0, 1).is_err());
        assert!(other.close_binary_read(&reference).is_err());
        store.close_binary_read(&reference).unwrap();
        store.close_binary_read(&reference).unwrap();
        assert!(store
            .resume_binary_read(&op("client"), reference.pin_id())
            .is_err());
        assert!(store.read_binary_range(&original, 0, 1).is_err());
        store.open_capture_read(&op("client"), &captured).unwrap();
    }

    #[test]
    fn owner_can_discover_orphaned_pins_after_restart_and_release_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = enrolled(&path);
        let captured = capture(&mut store, b"orphan source");
        for _ in 0..BINARY_READ_MAX_ACTIVE_PINS {
            // Crash before the open response/pin ID was checkpointed.
            store.open_capture_read(&op("client"), &captured).unwrap();
        }
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert!(store
            .list_binary_reads(&op("foreign_client"))
            .unwrap()
            .is_empty());
        let listed = store.list_binary_reads(&op("client")).unwrap();
        assert_eq!(listed.len(), BINARY_READ_MAX_ACTIVE_PINS);
        for reference in &listed {
            assert_eq!(reference.client_id(), &op("client"));
            assert_eq!(
                reference.local_store_id(),
                &text_sync::identity(&store.connection)
                    .unwrap()
                    .local_store_id
            );
        }
        assert!(store.open_capture_read(&op("client"), &captured).is_err());
        let resumed = store
            .resume_binary_read(&op("client"), listed[0].pin_id())
            .unwrap();
        assert_eq!(
            store.read_binary_range(&resumed, 0, 100).unwrap().bytes,
            b"orphan source"
        );
        store.close_binary_read(&listed[0]).unwrap();
        store.open_capture_read(&op("client"), &captured).unwrap();
        assert_eq!(
            store.list_binary_reads(&op("client")).unwrap().len(),
            BINARY_READ_MAX_ACTIVE_PINS
        );
    }

    #[test]
    fn caller_read_id_recovers_lost_open_at_capacity_and_rejects_changed_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = enrolled(&path);
        let source = capture(&mut store, b"retry source");
        let read_id = op("checkpointed_read");
        let first = store
            .open_capture_read_with_id(&op("client"), &read_id, &source)
            .unwrap();
        let original_pin = first.reference().clone();
        assert_eq!(first.reference().read_id(), &read_id);
        assert_ne!(first.reference().pin_id(), &read_id);
        for i in 1..BINARY_READ_MAX_ACTIVE_PINS {
            store
                .open_capture_read_with_id(&op("client"), &op(&format!("other_read_{i}")), &source)
                .unwrap();
        }
        drop(store);
        let mut store = Store::open(&path).unwrap();
        let retry = store
            .open_capture_read_with_id(&op("client"), &read_id, &source)
            .unwrap();
        assert_eq!(retry.reference(), &original_pin);
        assert_eq!(retry.exact_pin_record, first.exact_pin_record);
        assert_eq!(
            store.list_binary_reads(&op("client")).unwrap().len(),
            BINARY_READ_MAX_ACTIVE_PINS
        );
        let mut changed = source.clone();
        changed.manifest.digest = Sha256Digest::of(b"different");
        assert!(store
            .open_capture_read_with_id(&op("client"), &read_id, &changed)
            .is_err());
        assert!(store
            .open_capture_read_with_id(&op("other"), &read_id, &source)
            .is_err());
        assert!(store
            .open_capture_read_with_id(&op("client"), &op("new_read"), &source)
            .is_err());
        assert_eq!(
            store.read_binary_range(&retry, 0, 100).unwrap().bytes,
            b"retry source"
        );
        let separate = store
            .list_binary_reads(&op("client"))
            .unwrap()
            .into_iter()
            .find(|reference| reference.read_id() == &op("other_read_1"))
            .unwrap();
        let separate = store
            .resume_binary_read(&op("client"), separate.pin_id())
            .unwrap();
        store.close_binary_read(&original_pin).unwrap();
        assert!(store.read_binary_range(&retry, 0, 1).is_err());
        assert_eq!(
            store.read_binary_range(&separate, 0, 100).unwrap().bytes,
            b"retry source"
        );
        // Caller read IDs can be reused after explicit close, but old store-
        // issued pin locators and sessions can never bind to that new pin.
        let reopened = store
            .open_capture_read_with_id(&op("client"), &read_id, &source)
            .unwrap();
        assert_eq!(reopened.reference().read_id(), &read_id);
        assert_ne!(reopened.reference().pin_id(), original_pin.pin_id());
        assert!(store
            .resume_binary_read(&op("client"), original_pin.pin_id())
            .is_err());
        assert!(store.read_binary_range(&retry, 0, 1).is_err());
        store.close_binary_read(&original_pin).unwrap();
        assert_eq!(
            store.read_binary_range(&reopened, 0, 100).unwrap().bytes,
            b"retry source"
        );
    }

    #[test]
    fn pin_reads_and_resume_reject_damaged_exact_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = enrolled(&path);
        let captured = capture(&mut store, b"retained bytes");
        let session = store.open_capture_read(&op("client"), &captured).unwrap();
        // Simulate damaged storage beneath immutable-authority triggers.
        store
            .connection
            .execute_batch("DROP TRIGGER immutable_payloads_no_update")
            .unwrap();
        store.connection.execute("UPDATE immutable_payloads SET payload=zeroblob(payload_bytes) WHERE update_id=(SELECT update_id FROM binary_stage_chunks LIMIT 1)", []).unwrap();
        assert!(store.read_binary_range(&session, 2, 3).is_err());
        assert!(store
            .resume_binary_read(&op("client"), session.reference().pin_id())
            .is_err());
        assert!(store.open_capture_read(&op("client"), &captured).is_err());
        // Failure does not free a pin behind its owner's back.
        let count: i64 = store
            .connection
            .query_row("SELECT count(*) FROM binary_read_pins", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn empty_capture_has_a_verified_empty_read_and_durable_pin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = enrolled(&path);
        let source = capture(&mut store, &[]);
        let session = store.open_capture_read(&op("client"), &source).unwrap();
        assert!(session.is_empty());
        let chunk = store
            .read_binary_range(&session, 0, BINARY_READ_MAX_RANGE_BYTES)
            .unwrap();
        assert!(chunk.bytes.is_empty() && chunk.eof);
        let resumed = store
            .resume_binary_read(&op("client"), session.reference().pin_id())
            .unwrap();
        assert_eq!(resumed.digest(), &Sha256Digest::of(&[]));
    }

    #[test]
    fn graph_pin_keeps_exact_old_snapshot_after_new_write_move_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = enrolled(&path);
        let id = EntryId::new("file").unwrap();
        store
            .family_apply(
                &MutationRequest {
                    operation_id: op("create"),
                    mutation: Mutation::Create {
                        id: id.clone(),
                        path: VaultPath::new("old.bin").unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"old bytes".to_vec()),
                    },
                },
                Some(FamilyCreateMode::Binary),
            )
            .unwrap();
        let (state, source): (String, String) = store
            .connection
            .query_row(
                "SELECT state,content_ref FROM entries WHERE id=?1",
                [id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let state: EntryState = serde_json::from_str(&state).unwrap();
        let BinarySourceRef::Graph(source) = serde_json::from_str(&source).unwrap() else {
            panic!("graph source required")
        };
        let read_id = op("graph_read");
        let session = store
            .open_binary_read_with_id(&op("client"), &read_id, &state, &source)
            .unwrap();
        for i in 1..BINARY_READ_MAX_ACTIVE_PINS {
            store
                .open_binary_read_with_id(
                    &op("client"),
                    &op(&format!("graph_read_{i}")),
                    &state,
                    &source,
                )
                .unwrap();
        }
        let mut changed = state.clone();
        changed.path = VaultPath::new("forged.bin").unwrap();
        assert!(store
            .open_binary_read_with_id(&op("client"), &read_id, &changed, &source)
            .is_err());
        store
            .family_apply(
                &MutationRequest {
                    operation_id: op("write"),
                    mutation: Mutation::Write {
                        id: id.clone(),
                        expected: state.revision.clone(),
                        content: b"new bytes".to_vec(),
                    },
                },
                None,
            )
            .unwrap();
        let revision = |store: &Store| -> Revision {
            let raw: String = store
                .connection
                .query_row(
                    "SELECT state FROM entries WHERE id=?1",
                    [id.as_str()],
                    |r| r.get(0),
                )
                .unwrap();
            serde_json::from_str::<EntryState>(&raw).unwrap().revision
        };
        store
            .family_apply(
                &MutationRequest {
                    operation_id: op("move"),
                    mutation: Mutation::Move {
                        id: id.clone(),
                        expected: revision(&store),
                        path: VaultPath::new("new.bin").unwrap(),
                    },
                },
                None,
            )
            .unwrap();
        store
            .family_apply(
                &MutationRequest {
                    operation_id: op("delete"),
                    mutation: Mutation::Delete {
                        id: id.clone(),
                        expected: revision(&store),
                        recursive: false,
                    },
                },
                None,
            )
            .unwrap();
        // Retry the exact old request at capacity before considering the
        // latest deleted target. This returns the original retained snapshot.
        let retry = store
            .open_binary_read_with_id(&op("client"), &read_id, &state, &source)
            .unwrap();
        assert_eq!(retry.reference(), session.reference());
        assert_eq!(retry.exact_pin_record, session.exact_pin_record);
        assert_eq!(
            store.list_binary_reads(&op("client")).unwrap().len(),
            BINARY_READ_MAX_ACTIVE_PINS
        );
        assert_eq!(
            store.read_binary_range(&session, 0, 100).unwrap().bytes,
            b"old bytes"
        );
        let reference = session.reference().clone();
        drop(store);
        let store = Store::open(&path).unwrap();
        let resumed = store
            .resume_binary_read(&op("client"), reference.pin_id())
            .unwrap();
        assert_eq!(resumed.state(), Some(&state));
        assert_eq!(
            store.read_binary_range(&resumed, 4, 100).unwrap().bytes,
            b"bytes"
        );
    }

    struct MemorySource {
        bodies: BTreeMap<UpdateId, Vec<u8>>,
        reads: Vec<UpdateId>,
        corrupt: bool,
    }
    impl ChunkSource for MemorySource {
        fn read_chunk(
            &mut self,
            _: &Scope,
            id: &UpdateId,
            _: &GraphRecord,
        ) -> zorid_file_sync::Result<Vec<u8>> {
            self.reads.push(id.clone());
            let mut result = self.bodies.get(id).unwrap().clone();
            if self.corrupt {
                result[0] ^= 1;
            }
            Ok(result)
        }
    }
    fn metadata_fixture() -> (MetadataState, Manifest, MemorySource) {
        let mut builder = BinaryManifestBuilder::new(scope());
        let mut records = BTreeMap::new();
        let mut bodies = BTreeMap::new();
        for i in 0..3 {
            let id = UpdateId::new(format!("chunk_{i}")).unwrap();
            let body = vec![i as u8; BINARY_READ_MAX_RANGE_BYTES as usize];
            let emitted = builder.push_chunk(id.clone(), &body).unwrap();
            records.insert(id.clone(), emitted.record().clone());
            bodies.insert(id, body);
        }
        let page = builder.flush_page(UpdateId::new("page").unwrap()).unwrap();
        records.insert(page.id().clone(), page.record().clone());
        let manifest = builder.finish().unwrap().manifest().clone();
        let metadata = MetadataState::from_records(
            scope(),
            Revision::new("snapshot").unwrap(),
            records,
            BTreeMap::new(),
        )
        .unwrap();
        (
            metadata,
            manifest,
            MemorySource {
                bodies,
                reads: vec![],
                corrupt: false,
            },
        )
    }
    #[test]
    fn offset_ranges_read_only_overlapping_chunks_and_recheck_bytes() {
        let (metadata, manifest, mut source) = metadata_fixture();
        let chunk = BINARY_READ_MAX_RANGE_BYTES as u64;
        let bytes = read_range(
            &metadata,
            &manifest,
            2 * chunk + 7,
            2 * chunk + 12,
            &mut source,
        )
        .unwrap();
        assert_eq!(bytes, vec![2; 5]);
        assert_eq!(source.reads, vec![UpdateId::new("chunk_2").unwrap()]);
        source.reads.clear();
        let bytes = read_range(&metadata, &manifest, chunk - 2, chunk + 2, &mut source).unwrap();
        assert_eq!(bytes, [0, 0, 1, 1]);
        assert_eq!(source.reads.len(), 2);
        source.reads.clear();
        assert!(
            read_range(&metadata, &manifest, chunk + 7, chunk + 7, &mut source)
                .unwrap()
                .is_empty()
        );
        assert!(source.reads.is_empty());
        source.corrupt = true;
        assert!(read_range(
            &metadata,
            &manifest,
            2 * chunk + 7,
            2 * chunk + 12,
            &mut source
        )
        .is_err());
        source.reads.clear();
        assert!(read_range(
            &metadata,
            &manifest,
            manifest.bytes,
            manifest.bytes,
            &mut source
        )
        .unwrap()
        .is_empty());
        assert!(source.reads.is_empty());
    }
}
