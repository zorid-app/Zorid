//! Disposable native document cache. Source commits never consult these tables.
//! Parsing and generation preparation run outside SQLite write transactions.
use super::*;
use zorid_core::OperationId;
use zorid_index::{
    document_extraction_version, EntryWitness, Exclusion, Generation, GenerationBuilder,
    IndexError, IndexRecord, IndexSnapshotId, LiteralPage, LiteralPageBuilder, LiteralQuery,
    LiteralToken, Manifest, MetadataProjection, MetadataRequest, PublicationFence,
    SemanticVersions, SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION,
    LITERAL_QUERY_VERSION, MAX_GENERATION_METADATA_BYTES, MAX_PUMP_BYTES, RESOLVER_VERSION,
};

pub const DOCUMENT_INDEX_MAX_QUERY_PINS: usize = 4;
pub const DOCUMENT_INDEX_RETAINED_GENERATIONS: usize = 3;
pub const DOCUMENT_INDEX_RETAINED_STAGES: usize = 4;

// Registered individually by exact SQL. No triggers, foreign keys, or authority indexes.
pub(crate) const SCHEMA: &[(&str, &str)] = &[
    ("document_index_control", "CREATE TABLE document_index_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), record TEXT NOT NULL)"),
    ("document_index_generations", "CREATE TABLE document_index_generations (snapshot_key TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL)"),
    ("document_index_rows", "CREATE TABLE document_index_rows (snapshot_key TEXT NOT NULL, entry_id TEXT NOT NULL, record TEXT NOT NULL, text BLOB, PRIMARY KEY(snapshot_key,entry_id))"),
];

#[derive(Debug)]
pub enum DocumentIndexError {
    Authority(StoreError),
    Contract(IndexError),
    RebuildRequired,
    NotReady,
}
impl std::fmt::Display for DocumentIndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Authority(e) => e.fmt(f),
            Self::Contract(e) => e.fmt(f),
            Self::RebuildRequired => {
                f.write_str("Derived document cache requires explicit rebuild")
            }
            Self::NotReady => f.write_str("Document index is not ready"),
        }
    }
}
impl std::error::Error for DocumentIndexError {}
impl From<StoreError> for DocumentIndexError {
    fn from(e: StoreError) -> Self {
        Self::Authority(e)
    }
}
impl From<rusqlite::Error> for DocumentIndexError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::InvalidColumnType(..)
            | rusqlite::Error::FromSqlConversionFailure(..)
            | rusqlite::Error::IntegralValueOutOfRange(..) => Self::RebuildRequired,
            other => Self::Authority(other.into()),
        }
    }
}
impl From<IndexError> for DocumentIndexError {
    fn from(e: IndexError) -> Self {
        Self::Contract(e)
    }
}
pub type IndexResult<T> = std::result::Result<T, DocumentIndexError>;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Integrity<T> {
    value: T,
    digest: Sha256Digest,
}
fn encode<T: Serialize>(value: &T) -> IndexResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| DocumentIndexError::RebuildRequired)?;
    serde_json::to_string(&Integrity {
        value,
        digest: Sha256Digest::of(&bytes),
    })
    .map_err(|_| DocumentIndexError::RebuildRequired)
}
fn decode<T: serde::de::DeserializeOwned + Serialize>(raw: &str) -> IndexResult<T> {
    let value: Integrity<T> =
        serde_json::from_str(raw).map_err(|_| DocumentIndexError::RebuildRequired)?;
    let bytes =
        serde_json::to_vec(&value.value).map_err(|_| DocumentIndexError::RebuildRequired)?;
    if Sha256Digest::of(&bytes) != value.digest {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(value.value)
}
fn fresh() -> OperationId {
    OperationId::new(uuid::Uuid::new_v4().to_string()).expect("UUID is valid ID")
}
fn versions() -> SemanticVersions {
    SemanticVersions::new(
        INDEX_SCHEMA_VERSION,
        document_extraction_version(),
        RESOLVER_VERSION,
        LITERAL_QUERY_VERSION,
    )
    .expect("static versions")
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    local: OperationId,
    epoch: OperationId,
    generation: u64,
    schema: u32,
    extraction: String,
    resolver: String,
    query: String,
}
impl Snapshot {
    fn of(id: &IndexSnapshotId) -> Self {
        Self {
            local: id.local_store_id().clone(),
            epoch: id.generation_epoch().clone(),
            generation: id.generation(),
            schema: id.versions().schema(),
            extraction: id.versions().extraction().into(),
            resolver: id.versions().resolver().into(),
            query: id.versions().query().into(),
        }
    }
    fn id(&self) -> IndexResult<IndexSnapshotId> {
        Ok(IndexSnapshotId::new(
            self.local.clone(),
            self.epoch.clone(),
            self.generation,
            SemanticVersions::new(
                self.schema,
                self.extraction.clone(),
                self.resolver.clone(),
                self.query.clone(),
            )?,
        )?)
    }
    fn key(&self) -> String {
        format!("{}:{}", self.epoch.as_str(), self.generation)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    format: u32,
    epoch: OperationId,
    allocated: u64,
    head: Option<Snapshot>,
}
/// Committed namespace, source modes/digests and display facts; no source bodies.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentManifest {
    local_store_id: OperationId,
    watermark: String,
    entries: Vec<StoredEntryMetadata>,
    presentations: Vec<EntryPresentation>,
}
impl DocumentManifest {
    pub fn manifest(&self) -> IndexResult<Manifest> {
        let source = SourceSnapshotId::new(
            self.local_store_id.clone(),
            SourceWatermark::new(self.watermark.clone())?,
        );
        let manifest = Manifest::new(
            source,
            self.entries.iter().map(|e| e.state.clone()).collect(),
        )?;
        if self.entries.len() != self.presentations.len()
            || self.entries.iter().zip(&self.presentations).any(|(e, p)| {
                e.state.id != p.id
                    || e.content.as_ref().map_or(0, ContentMetadata::len) != p.size_bytes
            })
        {
            return Err(DocumentIndexError::RebuildRequired);
        }
        Ok(manifest)
    }
    pub fn entries(&self) -> &[StoredEntryMetadata] {
        &self.entries
    }
    pub fn presentations(&self) -> &[EntryPresentation] {
        &self.presentations
    }
}
/// One bounded exact committed read. Binary content remains excluded regardless
/// of its name or whether its bytes happen to be valid UTF-8.
pub struct DocumentSourceRead {
    pub witness: EntryWitness,
    pub content: Option<Vec<u8>>,
    pub exclusion: Option<Exclusion>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    snapshot: Snapshot,
    expected: Option<Snapshot>,
    manifest: DocumentManifest,
    published: bool,
}
impl Header {
    fn fence(&self) -> IndexResult<PublicationFence> {
        Ok(PublicationFence::new(
            self.manifest.manifest()?.source().clone(),
            self.expected.as_ref().map(Snapshot::id).transpose()?,
            self.snapshot.id()?,
        )?)
    }
}
/// Opaque durable staging locator. It confers no source or publication authority.
#[derive(Clone, Debug)]
pub struct DocumentIndexStage {
    snapshot: IndexSnapshotId,
}
impl DocumentIndexStage {
    pub fn snapshot(&self) -> &IndexSnapshotId {
        &self.snapshot
    }
}
#[derive(Debug)]
pub struct DocumentIndexProgress {
    pub snapshot: IndexSnapshotId,
    pub prepared_documents: usize,
    /// Unchanged parser records reused during this pump (bodies remain bounded).
    pub reused_documents: usize,
    pub total_documents: usize,
    pub ready: bool,
}
#[derive(Debug)]
pub enum DocumentIndexStatus {
    Uninitialized,
    RebuildRequired,
    Building,
    Ready {
        snapshot: IndexSnapshotId,
        covered_watermark: String,
        observed_source_head: String,
        coverage_complete: bool,
    },
}
/// This process-local pin retains immutable metadata; text stays in SQLite.
/// Three published generations are retained. Further publication or explicit
/// rebuild can expire this pin; a query then returns SnapshotExpired.
pub struct DocumentQueryPin {
    owner: OperationId,
    generation: Generation,
    pins: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl Drop for DocumentQueryPin {
    fn drop(&mut self) {
        self.pins.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}
impl DocumentQueryPin {
    pub fn generation(&self) -> &Generation {
        &self.generation
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    metadata: Option<MetadataProjection>,
    digest: Option<[u8; 32]>,
    bytes: usize,
    exclusion: Option<String>,
}
impl Record {
    fn of(row: &IndexRecord) -> Self {
        Self {
            metadata: row.metadata().cloned(),
            digest: row.text_digest().copied(),
            bytes: row.text_bytes(),
            exclusion: row.exclusion().map(|e| {
                match e {
                    Exclusion::Binary => "binary",
                    Exclusion::Unreadable => "unreadable",
                    Exclusion::SourceLimit => "source_limit",
                    Exclusion::ExtractionLimit => "extraction_limit",
                }
                .into()
            }),
        }
    }
    fn restore(self, witness: EntryWitness) -> IndexResult<IndexRecord> {
        let exclusion = match self.exclusion.as_deref() {
            None => None,
            Some("binary") => Some(Exclusion::Binary),
            Some("unreadable") => Some(Exclusion::Unreadable),
            Some("source_limit") => Some(Exclusion::SourceLimit),
            Some("extraction_limit") => Some(Exclusion::ExtractionLimit),
            _ => return Err(DocumentIndexError::RebuildRequired),
        };
        IndexRecord::from_persisted(witness, self.metadata, self.digest, self.bytes, exclusion)
            .map_err(|_| DocumentIndexError::RebuildRequired)
    }
}
fn cache_tables(tx: &Connection) -> IndexResult<usize> {
    // Also revalidate live SQL; explicit rebuild never drops malformed/unknown SQL.
    check_schema(tx)?;
    Ok(SCHEMA
        .iter()
        .map(|(name, _)| {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [name],
                |r| r.get::<_, bool>(0),
            )
        })
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|v| *v)
        .count())
}
fn control(tx: &Connection) -> IndexResult<Control> {
    if cache_tables(tx)? != SCHEMA.len() {
        return Err(DocumentIndexError::RebuildRequired);
    }
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM document_index_control WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let c: Control = decode(&raw.ok_or(DocumentIndexError::RebuildRequired)?)?;
    if c.format != 1
        || c.head
            .as_ref()
            .is_some_and(|h| h.epoch != c.epoch || h.generation > c.allocated)
    {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(c)
}
fn source(tx: &Connection) -> IndexResult<SourceSnapshotId> {
    let (head, allocated): (i64,i64) = tx.query_row("SELECT (SELECT coalesce(max(cursor),0) FROM local_changes),(SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='local_changes'),0))", [], |r|Ok((r.get(0)?,r.get(1)?)))?;
    if head <= 0 || head != allocated {
        return Err(StoreError::Corrupt("journal head missing or inconsistent".into()).into());
    }
    Ok(SourceSnapshotId::new(
        text_sync::identity(tx)?.local_store_id,
        SourceWatermark::new(head.to_string())?,
    ))
}
fn capture(tx: &Connection) -> IndexResult<DocumentManifest> {
    let source = source(tx)?;
    let entries = read_states(tx, false)?
        .into_iter()
        .map(|state| {
            entry_content::read_metadata_row(tx, &state.id)?
                .ok_or_else(|| StoreError::Corrupt("manifest entry missing".into()))
        })
        .collect::<Result<Vec<_>>>()?;
    let presentations = entries
        .iter()
        .map(|e| presentation::presentation(tx, &e.state))
        .collect::<Result<Vec<_>>>()?;
    let result = DocumentManifest {
        local_store_id: source.local_store_id().clone(),
        watermark: source.watermark().as_str().into(),
        entries,
        presentations,
    };
    result.manifest()?;
    Ok(result)
}
fn header(tx: &Connection, snapshot: &IndexSnapshotId) -> IndexResult<Header> {
    let c = control(tx)?;
    if c.epoch != *snapshot.generation_epoch() {
        return Err(IndexError::SnapshotExpired.into());
    }
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM document_index_generations WHERE snapshot_key=?1",
            [Snapshot::of(snapshot).key()],
            |r| r.get(0),
        )
        .optional()?;
    let h: Header = decode(&raw.ok_or(DocumentIndexError::RebuildRequired)?)?;
    if h.snapshot.id()? != *snapshot || h.manifest.local_store_id != *snapshot.local_store_id() {
        return Err(DocumentIndexError::RebuildRequired);
    }
    h.fence()?;
    Ok(h)
}
fn builder(tx: &Connection, h: &Header) -> IndexResult<GenerationBuilder> {
    let manifest = h.manifest.manifest()?;
    let mut b = GenerationBuilder::new(manifest.clone(), h.fence()?)
        .map_err(|_| DocumentIndexError::RebuildRequired)?;
    let encoded: i64 = tx.query_row("SELECT coalesce(sum(length(CAST(record AS BLOB))),0) FROM document_index_rows WHERE snapshot_key=?1", [h.snapshot.key()], |r|r.get(0))?;
    if encoded < 0 || encoded as u64 > MAX_GENERATION_METADATA_BYTES as u64 {
        return Err(DocumentIndexError::RebuildRequired);
    }
    let mut stmt = tx.prepare("SELECT entry_id,record,length(text) FROM document_index_rows WHERE snapshot_key=?1 ORDER BY entry_id")?;
    let mut rows = stmt.query([h.snapshot.key()])?;
    let mut bytes = 0usize;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let raw: String = row.get(1)?;
        bytes = bytes
            .checked_add(raw.len())
            .ok_or(DocumentIndexError::RebuildRequired)?;
        if bytes > MAX_GENERATION_METADATA_BYTES {
            return Err(DocumentIndexError::RebuildRequired);
        }
        let record = decode::<Record>(&raw)?
            .restore(manifest.witness(&EntryId::new(id).map_err(StoreError::from)?)?)?;
        let length: Option<i64> = row.get(2)?;
        if length != record.text_digest().map(|_| record.text_bytes() as i64) {
            return Err(DocumentIndexError::RebuildRequired);
        }
        b.begin_pump(); // Restore validates the total ceiling, not a new IO pump.
        b.add(record)
            .map_err(|_| DocumentIndexError::RebuildRequired)?;
    }
    b.begin_pump();
    Ok(b)
}
fn reusable_record(
    tx: &Connection,
    previous: Option<&(Header, Manifest)>,
    current: &Manifest,
    original: &StoredEntryMetadata,
) -> IndexResult<Option<IndexRecord>> {
    let Some((header, manifest)) = previous else {
        return Ok(None);
    };
    if header
        .manifest
        .entries
        .iter()
        .find(|e| e.state.id == original.state.id)
        != Some(original)
    {
        return Ok(None);
    }
    let raw:Option<String>=tx.query_row("SELECT record FROM document_index_rows WHERE snapshot_key=?1 AND entry_id=?2 AND length(CAST(record AS BLOB))<=?3",params![header.snapshot.key(),original.state.id.as_str(),MAX_GENERATION_METADATA_BYTES as i64],|r|r.get(0)).optional()?;
    let record = decode::<Record>(&raw.ok_or(DocumentIndexError::RebuildRequired)?)?
        .restore(manifest.witness(&original.state.id)?)?;
    Ok(Some(record.rebind_unchanged(current)?))
}

fn check_stage(tx: &Connection, h: &Header) -> IndexResult<()> {
    let c = control(tx)?;
    if c.epoch != h.snapshot.epoch {
        return Err(IndexError::SnapshotExpired.into());
    }
    h.fence()?.check(
        &source(tx)?,
        c.head.as_ref().map(Snapshot::id).transpose()?.as_ref(),
    )?;
    if capture(tx)? != h.manifest {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(())
}

fn prune(tx: &Connection, published: bool, retain: usize) -> IndexResult<()> {
    let rows = tx
        .prepare("SELECT snapshot_key,record FROM document_index_generations ORDER BY rowid DESC")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut seen = 0;
    for (key, raw) in rows {
        let h: Header = decode(&raw)?;
        if h.snapshot.key() != key {
            return Err(DocumentIndexError::RebuildRequired);
        }
        if h.published != published {
            continue;
        }
        seen += 1;
        if seen > retain {
            tx.execute(
                "DELETE FROM document_index_rows WHERE snapshot_key=?1",
                [&key],
            )?;
            tx.execute(
                "DELETE FROM document_index_generations WHERE snapshot_key=?1",
                [&key],
            )?;
        }
    }
    Ok(())
}

impl Store {
    pub fn capture_document_manifest(&self) -> IndexResult<DocumentManifest> {
        let tx = self.connection.unchecked_transaction()?;
        let manifest = capture(&tx)?;
        tx.commit()?;
        Ok(manifest)
    }
    pub fn read_document_source(
        &self,
        manifest: &DocumentManifest,
        id: &EntryId,
    ) -> IndexResult<DocumentSourceRead> {
        let portable = manifest.manifest()?;
        let witness = portable.witness(id)?;
        let original = manifest
            .entries
            .iter()
            .find(|e| &e.state.id == id)
            .ok_or(IndexError::MissingSource)?;
        let tx = self.connection.unchecked_transaction()?;
        if source(&tx)? != *portable.source() {
            return Err(IndexError::StaleSource.into());
        }
        if entry_content::read_metadata_row(&tx, id)?.as_ref() != Some(original)
            || !is_visible(&tx, id)?
        {
            return Err(IndexError::StaleSource.into());
        }
        let (content, exclusion) = match &original.content {
            Some(ContentMetadata::BinaryRef { .. }) => (None, Some(Exclusion::Binary)),
            Some(ContentMetadata::InlineBytes { bytes, .. })
                if *bytes > FAMILY_MAX_INLINE_BYTES =>
            {
                (None, Some(Exclusion::SourceLimit))
            }
            Some(ContentMetadata::InlineBytes { .. }) => {
                let entry =
                    entry_content::read_content_entry(&tx, id)?.ok_or(IndexError::MissingSource)?;
                match entry.1 {
                    Some(StoredContent::InlineBytes(bytes)) => (Some(bytes), None),
                    _ => return Err(IndexError::StaleSource.into()),
                }
            }
            None => return Err(IndexError::MissingSource.into()),
        };
        tx.commit()?;
        Ok(DocumentSourceRead {
            witness,
            content,
            exclusion,
        })
    }
    /// Create a missing cache explicitly; partial cache objects require rebuild.
    pub fn initialize_document_index(&mut self) -> IndexResult<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count = cache_tables(&tx)?;
        if count == SCHEMA.len() {
            control(&tx)?;
            tx.commit()?;
            return Ok(());
        }
        if count != 0 {
            return Err(DocumentIndexError::RebuildRequired);
        }
        for (_, sql) in SCHEMA {
            tx.execute_batch(sql)?;
        }
        tx.execute(
            "INSERT INTO document_index_control VALUES(1,?1)",
            [encode(&Control {
                format: 1,
                epoch: fresh(),
                allocated: 0,
                head: None,
            })?],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Only owned cache data is cleared. Registered SQL must still validate.
    /// Fresh epoch invalidates in-flight work and all previous query pins.
    pub fn rebuild_document_index(&mut self) -> IndexResult<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        cache_tables(&tx)?;
        for (name, sql) in SCHEMA {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [name],
                |r| r.get(0),
            )?;
            if !exists {
                tx.execute_batch(sql)?;
            }
        }
        tx.execute("DELETE FROM document_index_rows", [])?;
        tx.execute("DELETE FROM document_index_generations", [])?;
        tx.execute("DELETE FROM document_index_control", [])?;
        tx.execute(
            "INSERT INTO document_index_control VALUES(1,?1)",
            [encode(&Control {
                format: 1,
                epoch: fresh(),
                allocated: 0,
                head: None,
            })?],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn begin_document_index(&mut self) -> IndexResult<DocumentIndexStage> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut c = control(&tx)?;
        let manifest = capture(&tx)?;
        c.allocated = c
            .allocated
            .checked_add(1)
            .ok_or(IndexError::InvalidGeneration)?;
        let snapshot = IndexSnapshotId::new(
            manifest.local_store_id.clone(),
            c.epoch.clone(),
            c.allocated,
            versions(),
        )?;
        let h = Header {
            snapshot: Snapshot::of(&snapshot),
            expected: c.head.clone(),
            manifest,
            published: false,
        };
        tx.execute(
            "INSERT INTO document_index_generations VALUES(?1,?2)",
            params![h.snapshot.key(), encode(&h)?],
        )?;
        tx.execute(
            "UPDATE document_index_control SET record=?1 WHERE singleton=1",
            [encode(&c)?],
        )?;
        prune(&tx, false, DOCUMENT_INDEX_RETAINED_STAGES)?;
        tx.commit()?;
        Ok(DocumentIndexStage { snapshot })
    }
    /// Discover the most recent durable staging attempts after restart. Source
    /// changes can make an attempt stale; resume checks its publication fences.
    pub fn document_index_stages(&self) -> IndexResult<Vec<DocumentIndexStage>> {
        let tx = self.connection.unchecked_transaction()?;
        let c = control(&tx)?;
        let mut out = Vec::new();
        let raw = tx
            .prepare("SELECT record FROM document_index_generations ORDER BY rowid DESC LIMIT 32")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for raw in raw {
            let h: Header = decode(&raw)?;
            if h.snapshot.epoch != c.epoch {
                return Err(DocumentIndexError::RebuildRequired);
            }
            if !h.published {
                out.push(DocumentIndexStage {
                    snapshot: h.snapshot.id()?,
                });
            }
        }
        tx.commit()?;
        Ok(out)
    }
    /// Recover durable staging work after restart; published generations are not stages.
    pub fn resume_document_index(
        &self,
        snapshot: &IndexSnapshotId,
    ) -> IndexResult<DocumentIndexStage> {
        let tx = self.connection.unchecked_transaction()?;
        let h = header(&tx, snapshot)?;
        if h.published {
            return Err(IndexError::StaleIndex.into());
        }
        check_stage(&tx, &h)?;
        builder(&tx, &h)?;
        tx.commit()?;
        Ok(DocumentIndexStage {
            snapshot: snapshot.clone(),
        })
    }
    pub fn pump_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> IndexResult<DocumentIndexProgress> {
        let (h, mut b, previous) = {
            let tx = self.connection.unchecked_transaction()?;
            let h = header(&tx, &stage.snapshot)?;
            if h.published {
                return Err(IndexError::StaleIndex.into());
            }
            check_stage(&tx, &h)?;
            let b = builder(&tx, &h)?;
            let previous = if let Some(expected) = &h.expected {
                let id = expected.id()?;
                if id.versions() == stage.snapshot.versions() {
                    let previous = header(&tx, &id)?;
                    if !previous.published {
                        return Err(DocumentIndexError::RebuildRequired);
                    }
                    let manifest = previous.manifest.manifest()?;
                    Some((previous, manifest))
                } else {
                    None
                }
            } else {
                None
            };
            tx.commit()?;
            (h, b, previous)
        };
        let mut prepared = Vec::new();
        let mut source_bytes = 0usize;
        let mut reused_documents = 0;
        for witness in b.pending_entries() {
            let original = h
                .manifest
                .entries
                .iter()
                .find(|e| e.state.id == witness.entry().id)
                .ok_or(DocumentIndexError::RebuildRequired)?;
            let bytes = original.content.as_ref().map_or(0, ContentMetadata::len);
            if !prepared.is_empty() && source_bytes.saturating_add(bytes as usize) > MAX_PUMP_BYTES
            {
                break;
            }
            let mut reused_this_record = false;
            let (record, text) = {
                // Exact committed authority read; the filesystem is never consulted.
                let tx = self.connection.unchecked_transaction()?;
                if source(&tx)? != *witness.source() {
                    return Err(IndexError::StaleSource.into());
                }
                let actual = entry_content::read_metadata_row(&tx, &witness.entry().id)?;
                if actual.as_ref() != Some(original) || !is_visible(&tx, &witness.entry().id)? {
                    return Err(IndexError::StaleSource.into());
                }
                let reused = reusable_record(&tx, previous.as_ref(), b.manifest(), original)?;
                let text = match &original.content {
                    Some(ContentMetadata::BinaryRef { .. }) => None,
                    Some(ContentMetadata::InlineBytes { bytes, .. })
                        if *bytes <= FAMILY_MAX_INLINE_BYTES =>
                    {
                        entry_content::read_content_entry(&tx, &witness.entry().id)?
                            .and_then(|(_, c)| c)
                            .and_then(|c| match c {
                                StoredContent::InlineBytes(b) => Some(b),
                                _ => None,
                            })
                    }
                    _ => None,
                };
                tx.commit()?;
                // All parsing is after the source read transaction has ended.
                if let Some(record) = reused {
                    let text = if record.text_digest().is_some() {
                        let bytes = text.ok_or(DocumentIndexError::RebuildRequired)?;
                        record
                            .check_text(&bytes)
                            .map_err(|_| DocumentIndexError::RebuildRequired)?;
                        Some(bytes)
                    } else {
                        None
                    };
                    reused_this_record = true;
                    (record, text)
                } else {
                    match &original.content {
                        Some(ContentMetadata::BinaryRef { .. }) => {
                            (IndexRecord::excluded(witness, Exclusion::Binary), None)
                        }
                        Some(ContentMetadata::InlineBytes { bytes, .. })
                            if *bytes > FAMILY_MAX_INLINE_BYTES =>
                        {
                            (IndexRecord::excluded(witness, Exclusion::SourceLimit), None)
                        }
                        _ => match text.and_then(|b| String::from_utf8(b).ok()) {
                            Some(text) if !text.contains('\0') => {
                                let request = MetadataRequest {
                                    entry_id: witness.entry().id.clone(),
                                    content_revision: witness.entry().revision.clone(),
                                    source: text,
                                };
                                let markdown = witness
                                    .entry()
                                    .path
                                    .as_str()
                                    .to_ascii_lowercase()
                                    .ends_with(".md");
                                let row = IndexRecord::text(witness, &request, markdown)?;
                                let text = row
                                    .text_digest()
                                    .is_some()
                                    .then(|| request.source.into_bytes());
                                (row, text)
                            }
                            _ => (IndexRecord::excluded(witness, Exclusion::Unreadable), None),
                        },
                    }
                }
            };
            match b.add(record.clone()) {
                Ok(()) => {}
                Err(IndexError::PumpLimit) if !prepared.is_empty() => break,
                Err(e) => return Err(e.into()),
            }
            if reused_this_record {
                reused_documents += 1;
            }
            source_bytes += record.text_bytes();
            prepared.push((record, text));
        }
        let progress = DocumentIndexProgress {
            snapshot: stage.snapshot.clone(),
            prepared_documents: b.prepared_records(),
            reused_documents,
            total_documents: h
                .manifest
                .entries
                .iter()
                .filter(|e| e.state.kind == EntryKind::File)
                .count(),
            ready: b.ready(),
        };
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // The source and derived-head fences are rechecked in this same write Tx.
        check_stage(&tx, &h)?;
        for (record, text) in prepared {
            let exists: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM document_index_rows WHERE snapshot_key=?1 AND entry_id=?2)",params![h.snapshot.key(),record.witness().entry().id.as_str()],|r|r.get(0))?;
            if exists {
                return Err(IndexError::StaleIndex.into());
            }
            tx.execute(
                "INSERT INTO document_index_rows VALUES(?1,?2,?3,?4)",
                params![
                    h.snapshot.key(),
                    record.witness().entry().id.as_str(),
                    encode(&Record::of(&record))?,
                    text
                ],
            )?;
        }
        tx.commit()?;
        Ok(progress)
    }
    pub fn publish_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> IndexResult<IndexSnapshotId> {
        let mut h = {
            let tx = self.connection.unchecked_transaction()?;
            let h = header(&tx, &stage.snapshot)?;
            if h.published {
                return Err(IndexError::StaleIndex.into());
            }
            builder(&tx, &h)?.finish()?;
            tx.commit()?;
            h
        };
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        check_stage(&tx, &h)?;
        let mut c = control(&tx)?;
        h.published = true;
        tx.execute(
            "UPDATE document_index_generations SET record=?1 WHERE snapshot_key=?2",
            params![encode(&h)?, h.snapshot.key()],
        )?;
        c.head = Some(h.snapshot);
        tx.execute(
            "UPDATE document_index_control SET record=?1 WHERE singleton=1",
            [encode(&c)?],
        )?;
        prune(&tx, true, DOCUMENT_INDEX_RETAINED_GENERATIONS)?;
        tx.commit()?;
        Ok(stage.snapshot.clone())
    }
    pub fn document_index_status(&self) -> IndexResult<DocumentIndexStatus> {
        let tx = self.connection.unchecked_transaction()?;
        let count = cache_tables(&tx)?;
        if count == 0 {
            return Ok(DocumentIndexStatus::Uninitialized);
        }
        let result = (|| {
            let c = control(&tx)?;
            let Some(head) = c.head else {
                return Ok(DocumentIndexStatus::Building);
            };
            let id = head.id()?;
            let h = header(&tx, &id)?;
            if !h.published {
                return Err(DocumentIndexError::RebuildRequired);
            }
            let (_, g) = builder(&tx, &h)?
                .finish()
                .map_err(|_| DocumentIndexError::RebuildRequired)?
                .into_parts();
            Ok(DocumentIndexStatus::Ready {
                snapshot: id,
                covered_watermark: h.manifest.watermark,
                observed_source_head: source(&tx)?.watermark().as_str().into(),
                coverage_complete: g.coverage_complete(),
            })
        })();
        tx.commit()?;
        match result {
            Err(DocumentIndexError::RebuildRequired) => Ok(DocumentIndexStatus::RebuildRequired),
            other => other,
        }
    }
    pub fn open_document_snapshot(&self) -> IndexResult<DocumentQueryPin> {
        if self
            .document_query_pins
            .load(std::sync::atomic::Ordering::Relaxed)
            >= DOCUMENT_INDEX_MAX_QUERY_PINS
        {
            return Err(IndexError::GenerationLimit.into());
        }
        let tx = self.connection.unchecked_transaction()?;
        let c = control(&tx)?;
        let id = c.head.ok_or(DocumentIndexError::NotReady)?.id()?;
        let h = header(&tx, &id)?;
        if !h.published {
            return Err(DocumentIndexError::RebuildRequired);
        }
        let (_, generation) = builder(&tx, &h)?
            .finish()
            .map_err(|_| DocumentIndexError::RebuildRequired)?
            .into_parts();
        tx.commit()?;
        self.document_query_pins
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(DocumentQueryPin {
            owner: self.document_query_owner.clone(),
            generation,
            pins: self.document_query_pins.clone(),
        })
    }
    pub fn close_document_snapshot(&self, _pin: DocumentQueryPin) {}
    pub fn literal_document_page(
        &self,
        pin: &DocumentQueryPin,
        query: LiteralQuery,
        token: Option<&LiteralToken>,
        limit: usize,
    ) -> IndexResult<LiteralPage> {
        if pin.owner != self.document_query_owner {
            return Err(IndexError::SnapshotExpired.into());
        }
        let tx = self.connection.unchecked_transaction()?;
        let h = header(&tx, pin.generation.id()).map_err(|e| match e {
            DocumentIndexError::RebuildRequired => {
                DocumentIndexError::Contract(IndexError::SnapshotExpired)
            }
            other => other,
        })?;
        if !h.published {
            return Err(IndexError::SnapshotExpired.into());
        }
        let mut page = LiteralPageBuilder::new(&pin.generation, query, token, limit)?;
        while let Some(read) = page.next_read() {
            let row:Option<(i64,Vec<u8>)>=tx.query_row("SELECT length(text),text FROM document_index_rows WHERE snapshot_key=?1 AND entry_id=?2 AND length(text)<=?3",params![h.snapshot.key(),read.entry().id.as_str(),FAMILY_MAX_INLINE_BYTES as i64],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let (length, text) = row.ok_or(DocumentIndexError::RebuildRequired)?;
            if length != read.bytes() as i64 {
                return Err(DocumentIndexError::RebuildRequired);
            }
            page.accept(&read, &text)
                .map_err(|_| DocumentIndexError::RebuildRequired)?;
        }
        let result = page.finish()?;
        tx.commit()?;
        Ok(result)
    }
}
