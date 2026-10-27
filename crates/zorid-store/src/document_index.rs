//! Disposable native document cache. Source commits never consult these tables.
//! Parsing and generation preparation run outside SQLite write transactions.
use super::*;
use crate::document_cache::{DocumentCache, DocumentTransaction};
use crate::document_parse_cache;
use zorid_core::OperationId;
use zorid_index::{
    document_extraction_version, EntryWitness, Exclusion, ExtractionMode, Generation,
    GenerationBuilder, IndexError, IndexRecord, IndexSnapshotId, LiteralPage, LiteralPageBuilder,
    LiteralQuery, LiteralToken, Manifest, MetadataProjection, MetadataRequest, PublicationFence,
    ParseCacheOutcome, PreviewCaptureError, PreviewCaptureOwner, PreviewSnapshot, SemanticVersions,
    SourceSnapshotId, SourceWatermark, INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION,
    MAX_GENERATION_METADATA_BYTES, MAX_PUMP_BYTES, RESOLVER_VERSION,
};

/// Control is tiny; each generation's header/manifest plus encoded facts share
/// the portable 64MiB metadata ceiling. Source projection bytes are separate.
pub const DOCUMENT_INDEX_MAX_CONTROL_BYTES: usize = 16 * 1024;
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
    fn source(&self) -> IndexResult<SourceSnapshotId> {
        Ok(SourceSnapshotId::new(
            self.local_store_id.clone(),
            SourceWatermark::new(self.watermark.clone())?,
        ))
    }
    pub fn manifest(&self) -> IndexResult<Manifest> {
        let source = self.source()?;
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIndexStage {
    snapshot: IndexSnapshotId,
    #[serde(skip)]
    source: SourceSnapshotId,
}
impl DocumentIndexStage {
    pub fn snapshot(&self) -> &IndexSnapshotId {
        &self.snapshot
    }
    /// Actual captured source, not the latest source observed after staging.
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
}
/// Actual restored work counters; this carries no staging/write authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStageProgress {
    pub prepared_documents: usize,
    pub total_documents: usize,
    pub ready: bool,
}
/// Disjoint outcomes for eligible content-facts lookups in this pump only.
/// Same-entry generation reuse and skipped optional writes are independent.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentParseCacheProgress {
    pub hits: usize,
    pub misses: usize,
    pub unavailable: usize,
    pub corrupt: usize,
    pub unsupported: usize,
}
impl DocumentParseCacheProgress {
    fn record(&mut self, outcome: ParseCacheOutcome) {
        match outcome {
            ParseCacheOutcome::Hit => self.hits += 1,
            ParseCacheOutcome::Miss => self.misses += 1,
            ParseCacheOutcome::Unavailable => self.unavailable += 1,
            ParseCacheOutcome::Corrupt => self.corrupt += 1,
            ParseCacheOutcome::Unsupported => self.unsupported += 1,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIndexProgress {
    pub snapshot: IndexSnapshotId,
    pub prepared_documents: usize,
    /// Unchanged parser records reused during this pump (bodies remain bounded).
    pub reused_documents: usize,
    pub parse_cache: DocumentParseCacheProgress,
    pub total_documents: usize,
    pub ready: bool,
}
/// Optional caller-owned capture request. These labels supply no authority;
/// the capture binds the actual restored builder/manifest and private backing.
/// The host supplies a fresh incarnation nonce and charges retained captures in
/// its existing preview/query owner, tightening the shared retained TOTAL cap.
#[derive(Clone, Debug)]
pub struct DocumentPreviewCaptureRequest {
    pub owner_nonce: OperationId,
    pub stage_id: OperationId,
    pub retained_byte_limit: usize,
}
/// Durable pump progress cannot become ambiguous merely because optional
/// post-commit capture runs out of bytes/work or is cancelled. The outer error
/// concerns the existing pump; a requested capture has its separate outcome.
/// This data is not an ordinary pin or a current-source admission certificate.
#[derive(Debug)]
pub struct DocumentIndexPumpResult<E> {
    pub progress: DocumentIndexProgress,
    pub preview: Option<std::result::Result<PreviewSnapshot, PreviewCaptureError<E>>>,
}
/// Sealed postcommit data registration. No pin, mutation witness, source body
/// or second namespace is retained. Revalidate through Store before each read
/// and after evaluation; scalar labels are never a new admission proof.
#[derive(Debug)]
pub struct DocumentPreviewCapture {
    snapshot: PreviewSnapshot,
    store_owner: OperationId,
    // Weak identity only: no query pin/count or capability is retained.
    store_provider: std::sync::Weak<std::sync::atomic::AtomicUsize>,
    stage: Snapshot,
    expected_head: Option<Snapshot>,
    stage_key: String,
    presentations: Vec<DocumentPreviewPresentation>,
    retained_bytes: usize,
}
impl DocumentPreviewCapture {
    pub fn snapshot(&self) -> &PreviewSnapshot {
        &self.snapshot
    }
    pub fn source(&self) -> &SourceSnapshotId {
        self.snapshot.source()
    }
    pub fn is_first_build(&self) -> bool {
        self.expected_head.is_none()
    }
    pub fn presentations(&self) -> &[DocumentPreviewPresentation] {
        &self.presentations
    }
    /// Full cached capture+registration charge; consumers retain it until actual
    /// backing disposal, including in-flight queries after registry retirement.
    /// Native registry/query buffers are separate components in the same owner.
    pub fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }
}
#[derive(Debug)]
pub struct DocumentPreviewPresentation {
    entry: EntryState,
    presentation: EntryPresentation,
    source_text_bytes: Option<usize>,
}
impl DocumentPreviewPresentation {
    pub fn entry(&self) -> &EntryState {
        &self.entry
    }
    pub fn presentation(&self) -> &EntryPresentation {
        &self.presentation
    }
    pub fn source_text_bytes(&self) -> Option<usize> {
        self.source_text_bytes
    }
}
/// Borrowed captured identity plus one bounded retained-projection body. The
/// caller's invocation reservation must remain live through body disposal.
#[derive(Debug)]
pub struct DocumentPreviewDefinition<'capture> {
    row: &'capture DocumentPreviewPresentation,
    text: String,
}
impl DocumentPreviewDefinition<'_> {
    pub fn entry(&self) -> &EntryState {
        self.row.entry()
    }
    pub fn presentation(&self) -> &EntryPresentation {
        self.row.presentation()
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn text_heap_bytes(&self) -> usize {
        preview_allocation(self.text.capacity())
    }
    pub fn into_text(self) -> String {
        self.text
    }
}
#[derive(Debug)]
pub struct DocumentRegisteredPreviewPumpResult<E> {
    pub progress: DocumentIndexProgress,
    pub preview: Option<std::result::Result<DocumentPreviewCapture, PreviewCaptureError<E>>>,
}
const PREVIEW_MAX_DEFINITION_BYTES: usize = 262_144;
fn preview_allocation(capacity: usize) -> usize {
    if capacity == 0 {
        0
    } else {
        capacity.saturating_add(2 * std::mem::size_of::<usize>())
    }
}
fn preview_entry_heap(entry: &EntryState) -> usize {
    preview_allocation(entry.id.heap_capacity_bytes())
        .saturating_add(preview_allocation(entry.revision.heap_capacity_bytes()))
        .saturating_add(preview_allocation(entry.path.heap_capacity_bytes()))
}
fn preview_admit<E>(
    bytes: &mut usize,
    amount: usize,
    limit: usize,
) -> std::result::Result<(), PreviewCaptureError<E>> {
    *bytes =
        bytes
            .checked_add(amount)
            .filter(|n| *n <= limit)
            .ok_or(PreviewCaptureError::Resource(
                "preview registration retained byte limit",
            ))?;
    Ok(())
}
fn preview_snapshot_heap(snapshot: &Snapshot) -> usize {
    preview_allocation(snapshot.local.heap_capacity_bytes())
        .saturating_add(preview_allocation(snapshot.epoch.heap_capacity_bytes()))
        .saturating_add(preview_allocation(snapshot.extraction.capacity()))
        .saturating_add(preview_allocation(snapshot.resolver.capacity()))
        .saturating_add(preview_allocation(snapshot.query.capacity()))
}
#[derive(Debug, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
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
    generation: std::sync::Arc<Generation>,
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
    /// Share only immutable derived data, without extending this pin's source
    /// admission or global pin-count lifetime. Store reads still require the pin.
    pub fn shared_generation(&self) -> std::sync::Arc<Generation> {
        std::sync::Arc::clone(&self.generation)
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
fn cache_tables(tx: &DocumentTransaction<'_>) -> IndexResult<usize> {
    // Also revalidate live SQL; explicit rebuild never drops malformed/unknown SQL.
    check_schema(&tx.authority)?;
    let local = text_sync::identity(&tx.authority)?.local_store_id;
    if !crate::document_cache::validate(tx, &local)? {
        return Ok(0);
    }
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
fn generation_bounds(tx: &DocumentTransaction<'_>, transient_insert: bool) -> IndexResult<()> {
    let (count,key_min,key_max,record_min,record_max):(i64,i64,i64,i64,i64)=tx.query_row("SELECT count(*),coalesce(min(length(CAST(snapshot_key AS BLOB))),0),coalesce(max(length(CAST(snapshot_key AS BLOB))),0),coalesce(min(length(CAST(record AS BLOB))),0),coalesce(max(length(CAST(record AS BLOB))),0) FROM document_index_generations",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let limit = DOCUMENT_INDEX_RETAINED_GENERATIONS
        + DOCUMENT_INDEX_RETAINED_STAGES
        + usize::from(transient_insert);
    if count < 0
        || count as u64 > limit as u64
        || (count > 0
            && (key_min < 1
                || key_max > 160
                || record_min < 1
                || record_max > MAX_GENERATION_METADATA_BYTES as i64))
    {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(())
}
fn header_bytes(tx: &DocumentTransaction<'_>, key: &str) -> IndexResult<usize> {
    let bytes:Option<i64>=tx.query_row("SELECT length(CAST(record AS BLOB)) FROM document_index_generations WHERE snapshot_key=?1",[key],|r|r.get(0)).optional()?;
    let bytes = bytes.ok_or(DocumentIndexError::RebuildRequired)?;
    if !(1..=MAX_GENERATION_METADATA_BYTES as i64).contains(&bytes) {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(bytes as usize)
}

fn control(tx: &DocumentTransaction<'_>) -> IndexResult<Control> {
    if cache_tables(tx)? != SCHEMA.len() {
        return Err(DocumentIndexError::RebuildRequired);
    }
    generation_bounds(tx, false)?;
    control_record(tx)
}
// Already admitted schema/control callers can validate the bounded scalar
// record without reading any generation header lengths or namespace facts.
fn control_record(tx: &DocumentTransaction<'_>) -> IndexResult<Control> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM document_index_control WHERE singleton=1 AND length(CAST(record AS BLOB)) BETWEEN 1 AND ?1",
            [DOCUMENT_INDEX_MAX_CONTROL_BYTES as i64],
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
    // Do not mask authority identity read errors as cache diagnostics.
    let actual = text_sync::identity(&tx.authority)?.local_store_id;
    if c.head.as_ref().is_some_and(|h| h.local != actual) {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(c)
}
fn source_authority(tx: &Connection) -> IndexResult<SourceSnapshotId> {
    let (head, allocated): (i64,i64) = tx.query_row("SELECT (SELECT coalesce(max(cursor),0) FROM local_changes),(SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='local_changes'),0))", [], |r|Ok((r.get(0)?,r.get(1)?)))?;
    // Source11 initialization always appends Bootstrap at cursor1, including
    // empty vaults. Zero therefore means missing authority history, not a
    // legitimate virgin source watermark.
    if head <= 0 || head != allocated {
        return Err(StoreError::Corrupt("journal head missing or inconsistent".into()).into());
    }
    Ok(SourceSnapshotId::new(
        text_sync::identity(tx)?.local_store_id,
        SourceWatermark::new(head.to_string())?,
    ))
}
fn capture_authority(tx: &Connection) -> IndexResult<DocumentManifest> {
    let source = source_authority(tx)?;
    let minimum:i64=tx.query_row("SELECT coalesce(sum(length(CAST(state AS BLOB))+coalesce(length(CAST(content_ref AS BLOB)),0)+coalesce(length(CAST(content_digest AS BLOB)),0)+256),0) FROM entries WHERE visible=1 AND deleted=0",[],|r|r.get(0))?;
    if minimum < 0 || minimum as u64 > MAX_GENERATION_METADATA_BYTES as u64 {
        return Err(IndexError::GenerationLimit.into());
    }
    let mut entries = entry_content::read_visible_metadata(tx)?;
    // Retained dot-path files (including trash) remain authoritative, but are
    // outside the note namespace, just as in the desktop's normal inventory.
    // Exclude them before building resolver/relationship data, not just rows.
    entries.retain(|entry| !entry.state.path.as_str().split('/').any(|part| part.starts_with('.')));
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
fn source(tx: &DocumentTransaction<'_>) -> IndexResult<SourceSnapshotId> {
    source_authority(&tx.authority)
}
fn capture(tx: &DocumentTransaction<'_>) -> IndexResult<DocumentManifest> {
    capture_authority(&tx.authority)
}
fn header(tx: &DocumentTransaction<'_>, snapshot: &IndexSnapshotId) -> IndexResult<Header> {
    let c = control(tx)?;
    if c.epoch != *snapshot.generation_epoch() {
        return Err(IndexError::SnapshotExpired.into());
    }
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM document_index_generations WHERE snapshot_key=?1 AND length(CAST(record AS BLOB)) BETWEEN 1 AND ?2",
            params![Snapshot::of(snapshot).key(),MAX_GENERATION_METADATA_BYTES as i64],
            |r| r.get(0),
        )
        .optional()?;
    let h: Header = decode(&raw.ok_or(DocumentIndexError::RebuildRequired)?)?;
    validate_header(tx, &c, snapshot, &h)?;
    Ok(h)
}
fn validate_header(
    tx: &DocumentTransaction<'_>,
    control: &Control,
    snapshot: &IndexSnapshotId,
    h: &Header,
) -> IndexResult<()> {
    if h.snapshot.id()? != *snapshot
        || h.manifest.local_store_id != *snapshot.local_store_id()
        || h.manifest.local_store_id != text_sync::identity(&tx.authority)?.local_store_id
        || snapshot.generation() > control.allocated
    {
        return Err(DocumentIndexError::RebuildRequired);
    }
    h.fence()?;
    Ok(())
}
fn builder(tx: &DocumentTransaction<'_>, h: &Header) -> IndexResult<GenerationBuilder> {
    let manifest = h.manifest.manifest()?;
    let mut b = GenerationBuilder::new(manifest.clone(), h.fence()?)
        .map_err(|_| DocumentIndexError::RebuildRequired)?;
    let (encoded,id_min,id_max):(i64,i64,i64) = tx.query_row("SELECT coalesce(sum(length(CAST(record AS BLOB))+length(CAST(entry_id AS BLOB))),0),coalesce(min(length(CAST(entry_id AS BLOB))),1),coalesce(max(length(CAST(entry_id AS BLOB))),1) FROM document_index_rows WHERE snapshot_key=?1", [h.snapshot.key()], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if encoded < 0
        || id_min < 1
        || id_max > 128
        || (encoded as usize)
            .checked_add(header_bytes(tx, &h.snapshot.key())?)
            .is_none_or(|n| n > MAX_GENERATION_METADATA_BYTES)
    {
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
        let id = EntryId::new(id).map_err(|_| DocumentIndexError::RebuildRequired)?;
        let witness = manifest
            .witness(&id)
            .map_err(|_| DocumentIndexError::RebuildRequired)?;
        let record = decode::<Record>(&raw)?.restore(witness)?;
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
    tx: &DocumentTransaction<'_>,
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

fn check_stage(tx: &DocumentTransaction<'_>, h: &Header) -> IndexResult<()> {
    let c = control(tx)?;
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM document_index_generations WHERE snapshot_key=?1 AND length(CAST(record AS BLOB)) BETWEEN 1 AND ?2",
            params![h.snapshot.key(),MAX_GENERATION_METADATA_BYTES as i64],
            |r| r.get(0),
        )
        .optional()?;
    let active: Header = decode(&raw.ok_or(IndexError::SnapshotExpired)?)?;
    if active != *h || active.published {
        return Err(IndexError::StaleIndex.into());
    }
    check_current_stage(tx, &c, h)
}
/// The caller holds this transaction's validated control and actual unpublished
/// header: either freshly selected here, or reloaded and compared by check_stage.
/// External/stale header callers must retain check_stage's full reload/equality.
fn check_current_stage(
    tx: &DocumentTransaction<'_>,
    control: &Control,
    h: &Header,
) -> IndexResult<()> {
    if h.published {
        return Err(IndexError::StaleIndex.into());
    }
    if control.epoch != h.snapshot.epoch {
        return Err(IndexError::SnapshotExpired.into());
    }
    h.fence()?.check(
        &source(tx)?,
        control.head.as_ref().map(Snapshot::id).transpose()?.as_ref(),
    )?;
    if capture(tx)? != h.manifest {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(())
}

fn index_status(
    tx: &DocumentTransaction<'_>,
    observed_source: &SourceSnapshotId,
) -> IndexResult<DocumentIndexStatus> {
    let count = cache_tables(tx)?;
    if count == 0 {
        return Ok(DocumentIndexStatus::Uninitialized);
    }
    let result = (|| {
        let c = control(tx)?;
        let Some(head) = c.head else {
            return Ok(DocumentIndexStatus::Building);
        };
        let id = head.id()?;
        let h = header(tx, &id)?;
        if !h.published {
            return Err(DocumentIndexError::RebuildRequired);
        }
        let (_, generation) = builder(tx, &h)?
            .finish()
            .map_err(|_| DocumentIndexError::RebuildRequired)?
            .into_parts();
        Ok(DocumentIndexStatus::Ready {
            snapshot: id,
            covered_watermark: h.manifest.watermark,
            observed_source_head: observed_source.watermark().as_str().into(),
            coverage_complete: generation.coverage_complete(),
        })
    })();
    match result {
        Err(DocumentIndexError::RebuildRequired) => Ok(DocumentIndexStatus::RebuildRequired),
        other => other,
    }
}

// Registration only for immutable metadata already admitted by open_document_snapshot.
// In particular, control() must not be used here: generation_bounds() examines
// all retained header payload lengths even though this route consumes no header.
fn metadata_registration_control(tx: &DocumentTransaction<'_>) -> IndexResult<Control> {
    if cache_tables(tx)? != SCHEMA.len() {
        return Err(DocumentIndexError::RebuildRequired);
    }
    let raw: Option<String> = tx.query_row(
        "SELECT record FROM document_index_control WHERE singleton=1 AND length(CAST(record AS BLOB)) BETWEEN 1 AND ?1",
        [DOCUMENT_INDEX_MAX_CONTROL_BYTES as i64], |r| r.get(0),
    ).optional()?;
    let c: Control = decode(&raw.ok_or(DocumentIndexError::RebuildRequired)?)?;
    if c.format != 1
        || c.head.as_ref().is_some_and(|head| {
            head.epoch != c.epoch || head.generation > c.allocated || head.id().is_err()
        })
    {
        return Err(DocumentIndexError::RebuildRequired);
    }
    let actual = text_sync::identity(&tx.authority)?.local_store_id;
    if c.head.as_ref().is_some_and(|head| head.local != actual) {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(c)
}

fn pinned_header(
    tx: &DocumentTransaction<'_>,
    pin: &DocumentQueryPin,
    owner: &OperationId,
) -> IndexResult<Header> {
    if &pin.owner != owner {
        return Err(IndexError::SnapshotExpired.into());
    }
    let c = control(tx)?;
    if c.epoch != *pin.generation.id().generation_epoch() {
        return Err(IndexError::SnapshotExpired.into());
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM document_index_generations WHERE snapshot_key=?1)",
        [Snapshot::of(pin.generation.id()).key()],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(IndexError::SnapshotExpired.into());
    }
    let h = header(tx, pin.generation.id())?;
    if !h.published {
        return Err(IndexError::SnapshotExpired.into());
    }
    if h.manifest.manifest()? != *pin.generation.manifest() {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(h)
}
fn retained_projection(
    tx: &DocumentTransaction<'_>,
    h: &Header,
    generation: &Generation,
    id: &EntryId,
) -> IndexResult<DocumentSourceRead> {
    let record = generation.record(id).ok_or(IndexError::MissingSource)?;
    let row:Option<(String,Option<i64>,Option<Vec<u8>>)>=tx.query_row("SELECT record,length(text),text FROM document_index_rows WHERE snapshot_key=?1 AND entry_id=?2 AND length(CAST(record AS BLOB)) BETWEEN 1 AND ?3 AND (text IS NULL OR length(text)<=?4)",params![h.snapshot.key(),id.as_str(),MAX_GENERATION_METADATA_BYTES as i64,FAMILY_MAX_INLINE_BYTES as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (raw, length, text) = row.ok_or(DocumentIndexError::RebuildRequired)?;
    let stored = decode::<Record>(&raw)?.restore(record.witness().clone())?;
    if stored != *record || length != text.as_ref().map(|b| b.len() as i64) {
        return Err(DocumentIndexError::RebuildRequired);
    }
    match (&text, record.text_digest()) {
        (Some(bytes), Some(_)) => record
            .check_text(bytes)
            .map_err(|_| DocumentIndexError::RebuildRequired)?,
        (None, None) => {}
        _ => return Err(DocumentIndexError::RebuildRequired),
    }
    Ok(DocumentSourceRead {
        witness: record.witness().clone(),
        content: text,
        exclusion: record.exclusion().cloned(),
    })
}

fn prune(tx: &DocumentTransaction<'_>, published: bool, retain: usize) -> IndexResult<()> {
    generation_bounds(tx, true)?;
    let mut expired = Vec::new();
    {
        let mut statement = tx.prepare(
            "SELECT snapshot_key,record FROM document_index_generations ORDER BY rowid DESC",
        )?;
        let mut rows = statement.query([])?;
        let mut seen = 0;
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            let h: Header = decode(&row.get::<_, String>(1)?)?;
            if h.snapshot.key() != key {
                return Err(DocumentIndexError::RebuildRequired);
            }
            if h.published != published {
                continue;
            }
            seen += 1;
            if seen > retain {
                expired.push(key);
            }
        }
    }
    for key in expired {
        tx.execute(
            "DELETE FROM document_index_rows WHERE snapshot_key=?1",
            [&key],
        )?;
        tx.execute(
            "DELETE FROM document_index_generations WHERE snapshot_key=?1",
            [&key],
        )?;
    }
    generation_bounds(tx, false)?;
    Ok(())
}

impl Store {
    /// Select a host-owned app-local cache. Failure keeps the current cache and
    /// cannot change authoritative state. Existing pins expire after a swap.
    pub fn enable_document_cache(&mut self, path: impl AsRef<Path>) -> IndexResult<()> {
        let local = self.identity()?.local_store_id;
        let cache = DocumentCache::open(path.as_ref(), &local)?;
        self.document_cache = cache;
        self.document_query_owner = fresh();
        self.document_query_pins = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        Ok(())
    }
    fn document_transaction(
        &self,
        behavior: TransactionBehavior,
    ) -> IndexResult<DocumentTransaction<'_>> {
        DocumentTransaction::new(&self.connection, &self.document_cache, behavior)
    }
    pub fn capture_document_manifest(&self) -> IndexResult<DocumentManifest> {
        let tx = self.connection.unchecked_transaction()?;
        let manifest = capture_authority(&tx)?;
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
        if source_authority(&tx)? != *portable.source() {
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
        let tx = self.document_transaction(TransactionBehavior::Immediate)?;
        let count = cache_tables(&tx)?;
        if count == SCHEMA.len() {
            control(&tx)?;
            tx.commit()?;
            return Ok(());
        }
        if count != 0 {
            return Err(DocumentIndexError::RebuildRequired);
        }
        let local = text_sync::identity(&tx.authority)?.local_store_id;
        if !crate::document_cache::validate(&tx, &local)? {
            crate::document_cache::initialize_scope(&tx, &local)?;
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
        let tx = self.document_transaction(TransactionBehavior::Immediate)?;
        cache_tables(&tx)?;
        let local = text_sync::identity(&tx.authority)?.local_store_id;
        if !crate::document_cache::validate(&tx, &local)? {
            crate::document_cache::initialize_scope(&tx, &local)?;
        }
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
        let tx = self.document_transaction(TransactionBehavior::Immediate)?;
        let mut c = control(&tx)?;
        let manifest = capture(&tx)?;
        let snapshot = zorid_index::allocate_index_snapshot(
            manifest.local_store_id.clone(),
            c.epoch.clone(),
            c.allocated,
            versions(),
        )?;
        c.allocated = snapshot.generation();
        let h = Header {
            snapshot: Snapshot::of(&snapshot),
            expected: c.head.clone(),
            manifest,
            published: false,
        };
        let encoded = encode(&h)?;
        if encoded.len() > MAX_GENERATION_METADATA_BYTES {
            return Err(IndexError::GenerationLimit.into());
        }
        tx.execute(
            "INSERT INTO document_index_generations VALUES(?1,?2)",
            params![h.snapshot.key(), encoded],
        )?;
        tx.execute(
            "UPDATE document_index_control SET record=?1 WHERE singleton=1",
            [encode(&c)?],
        )?;
        prune(&tx, false, DOCUMENT_INDEX_RETAINED_STAGES)?;
        let source = h.manifest.source()?;
        tx.commit()?;
        Ok(DocumentIndexStage { snapshot, source })
    }
    /// Discard only this unpublished staging attempt, even after source/index
    /// heads advance. The locator's actual store identity must match. Exact
    /// validated published descriptors, missing attempts without retained rows,
    /// and expired epochs in a healthy same-store cache are no-ops. Published
    /// rows, heads and query pins are never removed by cleanup.
    pub fn discard_document_index_stage(&mut self, snapshot: &IndexSnapshotId) -> IndexResult<()> {
        let tx = self.document_transaction(TransactionBehavior::Immediate)?;
        if text_sync::identity(&tx.authority)?.local_store_id != *snapshot.local_store_id() {
            return Err(IndexError::StaleIndex.into());
        }
        let c = control(&tx)?;
        if c.epoch != *snapshot.generation_epoch() {
            tx.commit()?;
            return Ok(());
        }
        let is_head = c.head.as_ref() == Some(&Snapshot::of(snapshot));
        if snapshot.generation() > c.allocated {
            return Err(DocumentIndexError::RebuildRequired);
        }
        let key = Snapshot::of(snapshot).key();
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM document_index_generations WHERE snapshot_key=?1)",
            [&key],
            |r| r.get(0),
        )?;
        if !exists {
            if is_head {
                return Err(DocumentIndexError::RebuildRequired);
            }
            let orphan_rows: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM document_index_rows WHERE snapshot_key=?1)",
                [&key],
                |r| r.get(0),
            )?;
            if orphan_rows {
                return Err(DocumentIndexError::RebuildRequired);
            }
            tx.commit()?;
            return Ok(());
        }
        let h = header(&tx, snapshot)?;
        if h.published {
            // Publish may have committed before its RPC acknowledgment was lost.
            // The exact descriptor is validated; completed work needs no cleanup.
            tx.commit()?;
            return Ok(());
        }
        if is_head {
            return Err(DocumentIndexError::RebuildRequired);
        }
        // No source/head freshness fence: cleanup specifically accepts stale
        // attempts. Exact descriptor identity is validated under this write Tx.
        tx.execute(
            "DELETE FROM document_index_rows WHERE snapshot_key=?1",
            [&key],
        )?;
        if tx.execute(
            "DELETE FROM document_index_generations WHERE snapshot_key=?1",
            [&key],
        )? != 1
        {
            return Err(DocumentIndexError::RebuildRequired);
        }
        tx.commit()?;
        Ok(())
    }
    /// Discover the most recent durable staging attempts after restart. Source
    /// changes can make an attempt stale; resume checks its publication fences.
    pub fn document_index_stages(&self) -> IndexResult<Vec<DocumentIndexStage>> {
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        let c = control(&tx)?;
        let mut out = Vec::new();
        {
            let mut statement =
                tx.prepare("SELECT record FROM document_index_generations ORDER BY rowid DESC")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let h: Header = decode(&row.get::<_, String>(0)?)?;
                if h.snapshot.epoch != c.epoch {
                    return Err(DocumentIndexError::RebuildRequired);
                }
                if !h.published {
                    out.push(DocumentIndexStage {
                        snapshot: h.snapshot.id()?,
                        source: h.manifest.source()?,
                    });
                }
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
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        let h = header(&tx, snapshot)?;
        if h.published {
            return Err(IndexError::StaleIndex.into());
        }
        check_stage(&tx, &h)?;
        builder(&tx, &h)?;
        let source = h.manifest.source()?;
        tx.commit()?;
        Ok(DocumentIndexStage {
            snapshot: snapshot.clone(),
            source,
        })
    }
    /// Recover the newest usable unpublished attempt in one pinned read.
    /// Inspect one bounded header/builder at a time; corrupt cache or authority
    /// is never treated as a stale attempt and never silently cleared.
    pub fn recover_document_index_stage(
        &self,
    ) -> IndexResult<Option<(DocumentIndexStage, DocumentStageProgress)>> {
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        // Includes the existing aggregate count and per-header length bounds,
        // before any untrusted header/key is loaded into Rust.
        let c = control(&tx)?;
        let retained = DOCUMENT_INDEX_RETAINED_GENERATIONS + DOCUMENT_INDEX_RETAINED_STAGES;
        let recovered = {
            let mut statement = tx.prepare(
                "SELECT snapshot_key,record FROM document_index_generations NOT INDEXED ORDER BY rowid DESC LIMIT ?1",
            )?;
            let mut rows = statement.query([i64::try_from(retained + 1)
                .map_err(|_| DocumentIndexError::RebuildRequired)?])?;
            let mut inspected = 0;
            let mut recovered = None;
            while let Some(row) = rows.next()? {
                inspected += 1;
                if inspected > retained {
                    return Err(DocumentIndexError::RebuildRequired);
                }
                let key: String = row.get(0)?;
                let h: Header = decode(&row.get::<_, String>(1)?)?;
                if h.snapshot.key() != key || h.snapshot.epoch != c.epoch {
                    return Err(DocumentIndexError::RebuildRequired);
                }
                let snapshot = h.snapshot.id()?;
                validate_header(&tx, &c, &snapshot, &h)?;
                if h.published {
                    continue;
                }
                let candidate = (|| {
                    // This exact header and control came from the same pinned
                    // read above; no second header decode/resume is necessary.
                    check_current_stage(&tx, &c, &h)?;
                    let b = builder(&tx, &h)?;
                    let progress = DocumentStageProgress {
                        prepared_documents: b.prepared_records(),
                        total_documents: b
                            .manifest()
                            .entries()
                            .iter()
                            .filter(|entry| entry.kind == EntryKind::File)
                            .count(),
                        ready: b.ready(),
                    };
                    Ok((
                        DocumentIndexStage {
                            snapshot,
                            source: h.manifest.source()?,
                        },
                        progress,
                    ))
                })();
                match candidate {
                    Ok(value) => {
                        recovered = Some(value);
                        break;
                    }
                    Err(DocumentIndexError::Contract(
                        IndexError::StaleSource
                        | IndexError::StaleIndex
                        | IndexError::SnapshotExpired,
                    )) => {}
                    Err(error) => return Err(error),
                }
            }
            recovered
        };
        tx.commit()?;
        Ok(recovered)
    }
    pub fn pump_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> IndexResult<DocumentIndexProgress> {
        self.pump_document_index_with_preview(stage, None, |_| {
            Ok::<(), std::convert::Infallible>(())
        })
        .map(|result| result.progress)
    }
    /// Reuse this pump's already restored builder only after its durable cache
    /// transaction commits. No second restore/source read or query publication
    /// occurs. `check` controls ONLY optional post-commit capture work; existing
    /// pump IO/commit semantics are unchanged. None performs no capture work.
    /// The returned capture is immutable data; native/browser admission must
    /// still verify its live stage/source/client before and after every query.
    /// The retained-byte request covers this capture's declared TOTAL: capture
    /// allocations plus its full shared manifest/facts backing. Returning a
    /// capture retains that backing after this builder drops. The caller keeps
    /// its cached retention charge across old handles and new candidates in the
    /// same owner budget; there is no implicit sharing discount. This is not a
    /// global owner pool or a process RSS guarantee.
    pub fn pump_document_index_with_preview<E>(
        &mut self,
        stage: &DocumentIndexStage,
        capture: Option<DocumentPreviewCaptureRequest>,
        check: impl FnMut(usize) -> std::result::Result<(), E>,
    ) -> IndexResult<DocumentIndexPumpResult<E>> {
        let (progress, preview) =
            self.pump_document_index_capture(stage, capture, check, |_, snapshot, _, _, _| {
                Ok(snapshot)
            })?;
        Ok(DocumentIndexPumpResult { progress, preview })
    }
    /// Same single pump/commit as the legacy producer, followed by a sealed
    /// registration. Optional postcommit refusal never changes durable progress.
    pub fn pump_document_index_with_registered_preview<E>(
        &mut self,
        stage: &DocumentIndexStage,
        capture: Option<DocumentPreviewCaptureRequest>,
        check: impl FnMut(usize) -> std::result::Result<(), E>,
    ) -> IndexResult<DocumentRegisteredPreviewPumpResult<E>> {
        let (progress, preview) = self.pump_document_index_capture(
            stage,
            capture,
            check,
            |store, snapshot, header, limit, check| {
                store.register_document_preview(snapshot, header, limit, check)
            },
        )?;
        Ok(DocumentRegisteredPreviewPumpResult { progress, preview })
    }
    fn pump_document_index_capture<E, T>(
        &mut self,
        stage: &DocumentIndexStage,
        capture: Option<DocumentPreviewCaptureRequest>,
        check: impl FnMut(usize) -> std::result::Result<(), E>,
        finish: impl FnOnce(
            &Store,
            PreviewSnapshot,
            &Header,
            usize,
            &mut dyn FnMut(usize) -> std::result::Result<(), E>,
        ) -> std::result::Result<T, PreviewCaptureError<E>>,
    ) -> IndexResult<(
        DocumentIndexProgress,
        Option<std::result::Result<T, PreviewCaptureError<E>>>,
    )> {
        let (h, mut b, previous) = {
            let tx = self.document_transaction(TransactionBehavior::Deferred)?;
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
        let mut encoded_bytes = 0usize;
        let mut reused_documents = 0;
        let mut parse_cache = DocumentParseCacheProgress::default();
        'pending: for witness in b.pending_entries() {
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
                let tx = self.document_transaction(TransactionBehavior::Deferred)?;
                if source(&tx)? != *witness.source() {
                    return Err(IndexError::StaleSource.into());
                }
                let actual = entry_content::read_metadata_row(&tx.authority, &witness.entry().id)?;
                if actual.as_ref() != Some(original)
                    || !is_visible(&tx.authority, &witness.entry().id)?
                {
                    return Err(IndexError::StaleSource.into());
                }
                let reused = reusable_record(&tx, previous.as_ref(), b.manifest(), original)?;
                let text = match &original.content {
                    Some(ContentMetadata::BinaryRef { .. }) => None,
                    Some(ContentMetadata::InlineBytes { bytes, .. })
                        if *bytes <= FAMILY_MAX_INLINE_BYTES =>
                    {
                        entry_content::read_content_entry(&tx.authority, &witness.entry().id)?
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
                            Some(text) => {
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
                                match b.preflight_extraction(&witness, request.source.len()) {
                                    Ok(()) => {},
                                    Err(IndexError::PumpLimit) if !prepared.is_empty() => break 'pending,
                                    Err(error) => return Err(error.into()),
                                }
                                let mode = if markdown {
                                    ExtractionMode::Markdown
                                } else {
                                    ExtractionMode::PlainText
                                };
                                let (row, outcome) = document_parse_cache::extract(
                                    &self.document_cache, witness, &request, mode,
                                )?;
                                if let Some(outcome) = outcome {
                                    parse_cache.record(outcome);
                                }
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
            let encoded = encode(&Record::of(&record))?;
            if !prepared.is_empty()
                && encoded_bytes
                    .saturating_add(encoded.len() + record.witness().entry().id.as_str().len())
                    > MAX_PUMP_BYTES
            {
                break;
            }
            let id = record.witness().entry().id.clone();
            let bytes = record.text_bytes();
            match b.add(record) {
                Ok(()) => {}
                Err(IndexError::PumpLimit) if !prepared.is_empty() => break,
                Err(e) => return Err(e.into()),
            }
            if reused_this_record {
                reused_documents += 1;
            }
            source_bytes += bytes;
            encoded_bytes += encoded.len() + id.as_str().len();
            prepared.push((id, encoded, text));
        }
        let progress = DocumentIndexProgress {
            snapshot: stage.snapshot.clone(),
            prepared_documents: b.prepared_records(),
            reused_documents,
            parse_cache,
            total_documents: h
                .manifest
                .entries
                .iter()
                .filter(|e| e.state.kind == EntryKind::File)
                .count(),
            ready: b.ready(),
        };
        let tx = self.document_transaction(TransactionBehavior::Immediate)?;
        // The source and derived-head fences are rechecked in this same write Tx.
        check_stage(&tx, &h)?;
        let existing:i64=tx.query_row("SELECT coalesce(sum(length(CAST(record AS BLOB))+length(CAST(entry_id AS BLOB))),0) FROM document_index_rows WHERE snapshot_key=?1",[h.snapshot.key()],|r|r.get(0))?;
        let descriptor_bytes = header_bytes(&tx, &h.snapshot.key())?;
        if existing < 0
            || (existing as usize)
                .checked_add(encoded_bytes)
                .and_then(|n| n.checked_add(descriptor_bytes))
                .is_none_or(|n| n > MAX_GENERATION_METADATA_BYTES)
        {
            return Err(IndexError::GenerationLimit.into());
        }
        for (id, encoded, text) in prepared {
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM document_index_rows WHERE snapshot_key=?1 AND entry_id=?2)",params![h.snapshot.key(),id.as_str()],|r|r.get(0))?;
            if exists {
                return Err(IndexError::StaleIndex.into());
            }
            tx.execute(
                "INSERT INTO document_index_rows VALUES(?1,?2,?3,?4)",
                params![h.snapshot.key(), id.as_str(), encoded, text],
            )?;
        }
        tx.commit()?;
        // All rows in this exact restored builder are now persisted: old rows
        // were restored from the stage, and this pump's added rows committed
        // above. Failed commit exits before any capture callback/allocation.
        let preview = capture.map(|request| {
            let mut check = check;
            check(1).map_err(PreviewCaptureError::Host)?;
            // This producer creates a fresh capture incarnation rather than
            // borrowing a long-lived owner's already admitted identity. Reserve
            // its Arc/header and retained token payloads before allocation.
            let identity_bytes = std::mem::size_of::<DocumentPreviewCaptureRequest>()
                .saturating_add(8 * std::mem::size_of::<usize>())
                .saturating_add(request.owner_nonce.heap_capacity_bytes())
                .saturating_add(request.stage_id.heap_capacity_bytes());
            let retained_limit = request.retained_byte_limit;
            if retained_limit < identity_bytes || retained_limit > zorid_index::MAX_SEARCH_OWNED_BYTES {
                return Err(PreviewCaptureError::Resource("preview identity byte budget"));
            }
            // The core's cached total includes this identity once; this early
            // preflight is not a second deduction from the retained budget.
            let snapshot = PreviewCaptureOwner::new(request.owner_nonce, request.stage_id, &b)
                .capture_prepared_checked(&b, retained_limit, &mut check)?;
            finish(self, snapshot, &h, retained_limit, &mut check)
        });
        Ok((progress, preview))
    }
    fn register_document_preview<E>(
        &self,
        snapshot: PreviewSnapshot,
        header: &Header,
        retained_limit: usize,
        check: &mut dyn FnMut(usize) -> std::result::Result<(), E>,
    ) -> std::result::Result<DocumentPreviewCapture, PreviewCaptureError<E>> {
        let limit = retained_limit.min(zorid_index::MAX_SEARCH_OWNED_BYTES);
        let mut bytes = snapshot.retention().total_bytes();
        let fixed = std::mem::size_of::<DocumentPreviewCapture>()
            .saturating_add(4 * std::mem::size_of::<usize>())
            // Weak provider identity may retain the expired Arc's control block.
            .saturating_add(std::mem::size_of::<std::sync::atomic::AtomicUsize>())
            .saturating_add(4 * std::mem::size_of::<usize>());
        let predicted = fixed
            .saturating_add(preview_allocation(
                self.document_query_owner.heap_capacity_bytes(),
            ))
            .saturating_add(preview_snapshot_heap(&header.snapshot))
            .saturating_add(header.expected.as_ref().map_or(0, preview_snapshot_heap))
            .saturating_add(preview_allocation(
                header.snapshot.epoch.as_str().len() + 21,
            ));
        preview_admit(&mut bytes, predicted, limit)?;
        check(predicted.div_ceil(64).saturating_add(1)).map_err(PreviewCaptureError::Host)?;
        let store_owner = self.document_query_owner.clone();
        let stage = header.snapshot.clone();
        let expected_head = header.expected.clone();
        let stage_key = stage.key();
        let actual = fixed
            .saturating_add(preview_allocation(store_owner.heap_capacity_bytes()))
            .saturating_add(preview_snapshot_heap(&stage))
            .saturating_add(expected_head.as_ref().map_or(0, preview_snapshot_heap))
            .saturating_add(preview_allocation(stage_key.capacity()));
        bytes -= predicted;
        preview_admit(&mut bytes, actual, limit)?;
        let view = snapshot
            .facts_view_checked(&mut |n| check(n))
            .map_err(PreviewCaptureError::Host)?;
        let count = view.rows().len();
        let planned_slots = count
            .checked_mul(std::mem::size_of::<DocumentPreviewPresentation>())
            .map(preview_allocation)
            .ok_or(PreviewCaptureError::Resource("preview registration slots"))?;
        preview_admit(&mut bytes, planned_slots, limit)?;
        check(count.saturating_add(1)).map_err(PreviewCaptureError::Host)?;
        let mut presentations = Vec::new();
        presentations
            .try_reserve_exact(count)
            .map_err(|_| PreviewCaptureError::Resource("preview registration allocation"))?;
        let actual_slots = presentations
            .capacity()
            .checked_mul(std::mem::size_of::<DocumentPreviewPresentation>())
            .map(preview_allocation)
            .ok_or(PreviewCaptureError::Resource("preview registration slots"))?;
        bytes -= planned_slots;
        preview_admit(&mut bytes, actual_slots, limit)?;
        // Header namespace is already captured in canonical path order by this
        // successful pump's check_stage. Search it in place per prepared row;
        // no all-namespace sidecar, sort, restoration or query-time scan exists.
        for row in view.rows() {
            check(1).map_err(PreviewCaptureError::Host)?;
            let mut failed = None;
            let found = header.manifest.entries.binary_search_by(|entry| {
                if failed.is_some() {
                    return std::cmp::Ordering::Equal;
                }
                let work = entry
                    .state
                    .path
                    .as_str()
                    .len()
                    .saturating_add(row.path().as_str().len())
                    .div_ceil(64)
                    .saturating_add(1);
                if let Err(error) = check(work) {
                    failed = Some(error);
                    return std::cmp::Ordering::Equal;
                }
                entry.state.path.cmp(row.path())
            });
            if let Some(error) = failed {
                return Err(PreviewCaptureError::Host(error));
            }
            let at = found.map_err(|_| PreviewCaptureError::Index(IndexError::InvalidRecord))?;
            let original = &header.manifest.entries[at];
            let presentation = header
                .manifest
                .presentations
                .get(at)
                .ok_or(PreviewCaptureError::Index(IndexError::InvalidRecord))?;
            check(row.path().as_str().len().div_ceil(64).saturating_add(16))
                .map_err(PreviewCaptureError::Host)?;
            if original.state.id != *row.entry_id()
                || original.state.revision != *row.revision()
                || original.state.kind != EntryKind::File
                || presentation.id != original.state.id
            {
                return Err(PreviewCaptureError::Index(IndexError::InvalidRecord));
            }
            let predicted = preview_entry_heap(&original.state)
                .saturating_add(preview_allocation(presentation.id.heap_capacity_bytes()));
            preview_admit(&mut bytes, predicted, limit)?;
            check(predicted.div_ceil(64).saturating_add(1)).map_err(PreviewCaptureError::Host)?;
            let copied = DocumentPreviewPresentation {
                entry: original.state.clone(),
                presentation: presentation.clone(),
                source_text_bytes: row.source_text_bytes(),
            };
            let actual = preview_entry_heap(&copied.entry).saturating_add(preview_allocation(
                copied.presentation.id.heap_capacity_bytes(),
            ));
            bytes -= predicted;
            preview_admit(&mut bytes, actual, limit)?;
            presentations.push(copied);
        }
        drop(view);
        let registered = DocumentPreviewCapture {
            snapshot,
            store_owner,
            store_provider: std::sync::Arc::downgrade(&self.document_query_pins),
            stage,
            expected_head,
            stage_key,
            presentations,
            retained_bytes: bytes,
        };
        // The package reports this commit's exact captured facts, not a claim
        // that source cannot advance after commit. Every native use must call
        // the live registration guard; no authority/read error is disguised as
        // an optional capture failure here.
        check(0).map_err(PreviewCaptureError::Host)?;
        Ok(registered)
    }
    /// Constant-size registration checks, independent of namespace size. The
    /// sealed package came from a validated committed pump; only live scalar
    /// fences and stage-key existence are read, never a generation header/body.
    pub fn check_document_preview_registration(
        &self,
        capture: &DocumentPreviewCapture,
    ) -> IndexResult<()> {
        self.check_preview_provider(capture)?;
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        self.check_preview_registration_in(&tx, capture)?;
        tx.commit()?;
        Ok(())
    }
    fn check_preview_provider(&self, capture: &DocumentPreviewCapture) -> IndexResult<()> {
        if capture.store_owner != self.document_query_owner
            || !std::sync::Weak::ptr_eq(
                &capture.store_provider,
                &std::sync::Arc::downgrade(&self.document_query_pins),
            )
        {
            return Err(IndexError::SnapshotExpired.into());
        }
        Ok(())
    }
    // Both callers check actual provider identity before opening any SQL tx.
    fn check_preview_registration_in(
        &self,
        tx: &DocumentTransaction<'_>,
        capture: &DocumentPreviewCapture,
    ) -> IndexResult<()> {
        if cache_tables(tx)? != SCHEMA.len() {
            return Err(DocumentIndexError::RebuildRequired);
        }
        let current = control_record(tx)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM document_index_generations WHERE snapshot_key=?1)",
            [&capture.stage_key],
            |row| row.get(0),
        )?;
        if !exists
            || current.epoch != capture.stage.epoch
            || current.allocated < capture.stage.generation
            || current.head != capture.expected_head
            || source(tx)? != *capture.source()
            || capture.stage.local != *capture.source().local_store_id()
            || capture.stage.schema != INDEX_SCHEMA_VERSION
            || capture.stage.extraction != document_extraction_version()
            || capture.stage.resolver != RESOLVER_VERSION
            || capture.stage.query != LITERAL_QUERY_VERSION
        {
            return Err(IndexError::SnapshotExpired.into());
        }
        Ok(())
    }
    /// Read only this prepared member's immutable staged text. Caller reserves
    /// its invocation source buffer first; max_bytes tightens the256KiB source
    /// bound. Borrowed identity/presentation do not allocate or become writable.
    pub fn read_document_preview_definition<'capture>(
        &self,
        capture: &'capture DocumentPreviewCapture,
        id: &EntryId,
        max_bytes: usize,
    ) -> IndexResult<DocumentPreviewDefinition<'capture>> {
        if max_bytes > PREVIEW_MAX_DEFINITION_BYTES {
            return Err(IndexError::InvalidBudget.into());
        }
        self.check_preview_provider(capture)?;
        let at = capture
            .presentations
            .binary_search_by(|row| row.entry.id.cmp(id));
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        self.check_preview_registration_in(&tx, capture)?;
        let prepared = &capture.presentations[at.map_err(|_| DocumentIndexError::NotReady)?];
        let expected = prepared
            .source_text_bytes
            .ok_or(IndexError::InvalidTarget)?;
        if expected > max_bytes {
            return Err(IndexError::GenerationLimit.into());
        }
        let mut stmt = tx.prepare("SELECT CASE WHEN typeof(text)='blob' AND length(text)=?3 AND length(text)<=?4 THEN text ELSE NULL END FROM document_index_rows WHERE snapshot_key=?1 AND entry_id=?2")?;
        let mut rows = stmt.query(params![
            &capture.stage_key,
            id.as_str(),
            expected as i64,
            max_bytes as i64
        ])?;
        let row = rows.next()?.ok_or(IndexError::SnapshotExpired)?;
        let rusqlite::types::ValueRef::Blob(raw) = row.get_ref(0)? else {
            return Err(IndexError::ContentMismatch.into());
        };
        if raw.len() != expected {
            return Err(IndexError::ContentMismatch.into());
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(expected)
            .map_err(|_| IndexError::GenerationLimit)?;
        if bytes.capacity() > max_bytes {
            return Err(IndexError::GenerationLimit.into());
        }
        bytes.extend_from_slice(raw);
        drop(rows);
        drop(stmt);
        capture.snapshot.check_text(id, &bytes)?;
        let text = String::from_utf8(bytes).map_err(|_| IndexError::ContentMismatch)?;
        tx.commit()?;
        Ok(DocumentPreviewDefinition {
            row: prepared,
            text,
        })
    }
    pub fn publish_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> IndexResult<IndexSnapshotId> {
        let mut h = {
            let tx = self.document_transaction(TransactionBehavior::Deferred)?;
            let h = header(&tx, &stage.snapshot)?;
            if h.published {
                return Err(IndexError::StaleIndex.into());
            }
            builder(&tx, &h)?.finish()?;
            tx.commit()?;
            h
        };
        let tx = self.document_transaction(TransactionBehavior::Immediate)?;
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
    /// Capture the local authority identity/head and cache status in one read
    /// transaction. Cache absence/corruption never fabricates a source watermark.
    pub fn document_index_status_with_source(
        &self,
    ) -> IndexResult<(SourceSnapshotId, DocumentIndexStatus)> {
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        let source = source(&tx)?;
        let status = index_status(&tx, &source)?;
        tx.commit()?;
        Ok((source, status))
    }
    pub fn document_index_status(&self) -> IndexResult<DocumentIndexStatus> {
        self.document_index_status_with_source()
            .map(|(_, status)| status)
    }
    pub fn open_document_snapshot(&self) -> IndexResult<DocumentQueryPin> {
        if self
            .document_query_pins
            .load(std::sync::atomic::Ordering::Relaxed)
            >= DOCUMENT_INDEX_MAX_QUERY_PINS
        {
            return Err(IndexError::GenerationLimit.into());
        }
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
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
            generation: std::sync::Arc::new(generation),
            pins: self.document_query_pins.clone(),
        })
    }
    /// Revalidate only the registration of already-admitted immutable metadata.
    /// This does not read persisted generation headers, rows, source bodies or
    /// current source heads, and must not replace text/source/publication checks.
    /// Native hosts must also check their live root and client pin registrations
    /// before and after projecting a page from the pin's immutable generation.
    pub fn check_document_metadata_pin_registration(
        &self,
        pin: &DocumentQueryPin,
    ) -> IndexResult<()> {
        if pin.owner != self.document_query_owner
            || !std::sync::Arc::ptr_eq(&pin.pins, &self.document_query_pins)
        {
            return Err(IndexError::SnapshotExpired.into());
        }
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        let c = metadata_registration_control(&tx)?;
        let snapshot = pin.generation.id();
        if c.epoch != *snapshot.generation_epoch() {
            return Err(IndexError::SnapshotExpired.into());
        }
        if snapshot.local_store_id() != &text_sync::identity(&tx.authority)?.local_store_id
            || snapshot.generation() > c.allocated
        {
            return Err(DocumentIndexError::RebuildRequired);
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM document_index_generations WHERE snapshot_key=?1)",
            [Snapshot::of(snapshot).key()],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(IndexError::SnapshotExpired.into());
        }
        tx.commit()?;
        Ok(())
    }
    /// Frozen source-mode and presentation facts from this exact generation.
    /// Advancing source heads do not invalidate retained immutable snapshots.
    pub fn document_snapshot_manifest(
        &self,
        pin: &DocumentQueryPin,
    ) -> IndexResult<DocumentManifest> {
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        let h = pinned_header(&tx, pin, &self.document_query_owner)?;
        tx.commit()?;
        Ok(h.manifest)
    }
    /// One retained generation projection, never a current-authority body read.
    /// Eligible UTF-8 text is bounded to16MiB; excluded content retains its reason.
    pub fn read_document_projection(
        &self,
        pin: &DocumentQueryPin,
        id: &EntryId,
    ) -> IndexResult<DocumentSourceRead> {
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        let h = pinned_header(&tx, pin, &self.document_query_owner)?;
        let read = retained_projection(&tx, &h, &pin.generation, id)?;
        tx.commit()?;
        Ok(read)
    }
    pub fn close_document_snapshot(&self, _pin: DocumentQueryPin) {}
    pub fn literal_document_page(
        &self,
        pin: &DocumentQueryPin,
        query: LiteralQuery,
        token: Option<&LiteralToken>,
        limit: usize,
    ) -> IndexResult<LiteralPage> {
        let tx = self.document_transaction(TransactionBehavior::Deferred)?;
        let h = pinned_header(&tx, pin, &self.document_query_owner)?;
        let mut page = LiteralPageBuilder::new(&pin.generation, query, token, limit)?;
        while let Some(read) = page.next_read() {
            let projection = retained_projection(&tx, &h, &pin.generation, &read.entry().id)?;
            let text = projection
                .content
                .ok_or(DocumentIndexError::RebuildRequired)?;
            if text.len() != read.bytes() {
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

#[cfg(test)]
#[path = "document_preview_tests.rs"]
mod preview_capture_tests;

#[cfg(test)]
#[path = "document_preview_registration_tests.rs"]
mod preview_registration_tests;

#[cfg(test)]
mod cache_snapshot_tests {
    use super::*;
    fn create(name: &str) -> MutationRequest {
        MutationRequest {
            operation_id: OperationId::new(name).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(name).unwrap(),
                path: zorid_core::VaultPath::new(format!("{name}.md")).unwrap(),
                kind: EntryKind::File,
                content: Some(b"needle".to_vec()),
            },
        }
    }
    fn build(store: &mut Store) {
        let stage = store.begin_document_index().unwrap();
        while !store.pump_document_index(&stage).unwrap().ready {}
        store.publish_document_index(&stage).unwrap();
    }

    #[test]
    fn pre_dot_namespace_cache_requires_rebuild_at_the_same_authority_watermark() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
        store.apply(&create("note")).unwrap();
        let mut retained = create("retained");
        if let Mutation::Create { path, .. } = &mut retained.mutation {
            *path = zorid_core::VaultPath::new(".retained.md").unwrap();
        }
        store.apply(&retained).unwrap();
        store.initialize_document_index().unwrap();
        build(&mut store);
        let tx = store.document_transaction(TransactionBehavior::Immediate).unwrap();
        let mut c = control(&tx).unwrap();
        let mut h = header(&tx, &c.head.as_ref().unwrap().id().unwrap()).unwrap();
        let watermark = source(&tx).unwrap();
        // Reconstruct the previous policy's complete, valid hidden-bearing
        // generation. Only its semantic tag changes below, never authority.
        h.manifest.entries = entry_content::read_visible_metadata(&tx.authority).unwrap();
        h.manifest.presentations = h.manifest.entries.iter()
            .map(|entry| presentation::presentation(&tx.authority, &entry.state).unwrap()).collect();
        let witness = h.manifest.manifest().unwrap().witness(&EntryId::new("retained").unwrap()).unwrap();
        let row = IndexRecord::text(witness.clone(), &MetadataRequest {
            entry_id: witness.entry().id.clone(), content_revision: witness.entry().revision.clone(), source: "needle".into(),
        }, true).unwrap();
        tx.execute("INSERT OR REPLACE INTO document_index_rows VALUES(?1,?2,?3,?4)",
            params![h.snapshot.key(), "retained", encode(&Record::of(&row)).unwrap(), b"needle".as_slice()]).unwrap();
        tx.execute("UPDATE document_index_generations SET record=?1 WHERE snapshot_key=?2",
            params![encode(&h).unwrap(), h.snapshot.key()]).unwrap();
        let (_, legacy) = builder(&tx, &h).unwrap().finish().unwrap().into_parts();
        assert!(legacy.record(&EntryId::new("retained").unwrap()).is_some());
        assert!(h.published);
        h.snapshot.schema = 1;
        c.head = Some(h.snapshot.clone());
        tx.execute("UPDATE document_index_generations SET record=?1 WHERE snapshot_key=?2",
            params![encode(&h).unwrap(), h.snapshot.key()]).unwrap();
        tx.execute("UPDATE document_index_control SET record=?1 WHERE singleton=1", [encode(&c).unwrap()]).unwrap();
        tx.commit().unwrap();
        let (unchanged, status) = store.document_index_status_with_source().unwrap();
        assert_eq!(unchanged, watermark);
        assert!(matches!(status, DocumentIndexStatus::RebuildRequired));
        store.rebuild_document_index().unwrap(); build(&mut store);
        let fresh = store.open_document_snapshot().unwrap();
        assert!(fresh.generation().record(&EntryId::new("note").unwrap()).is_some());
        assert!(fresh.generation().record(&EntryId::new("retained").unwrap()).is_none());
        assert_eq!(store.read(&EntryId::new("retained").unwrap()).unwrap().unwrap().content.unwrap(), b"needle");
        store.close_document_snapshot(fresh);
    }

    #[test]
    fn allocated_generations_survive_discard_failed_work_and_cache_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().canonicalize().unwrap();
        let path = parent.join("store.sqlite");
        let cache_path = parent.join("cache.sqlite");
        let mut store = Store::open(&path).unwrap();
        store.enable_document_cache(&cache_path).unwrap();
        store.apply(&create("original-note")).unwrap();
        store.initialize_document_index().unwrap();
        build(&mut store);
        let published = store.open_document_snapshot().unwrap();
        let head = published.generation().id().clone();
        assert_eq!(head.generation(), 1);
        store.close_document_snapshot(published);

        let discarded = store.begin_document_index().unwrap();
        assert_eq!(discarded.snapshot().generation(), 2);
        store
            .discard_document_index_stage(discarded.snapshot())
            .unwrap();
        let failed = store.begin_document_index().unwrap();
        assert_eq!(failed.snapshot().generation(), 3);
        store.apply(&create("later-note")).unwrap();
        assert!(matches!(
            store.pump_document_index(&failed),
            Err(DocumentIndexError::Contract(IndexError::StaleSource))
        ));
        drop(store);

        let mut reopened = Store::open(&path).unwrap();
        reopened.enable_document_cache(&cache_path).unwrap();
        // Allocation follows durable reservations even when the published head
        // remains at one and earlier attempts were discarded or never completed.
        let next = reopened.begin_document_index().unwrap();
        assert_eq!(next.snapshot().generation(), 4);
        assert_eq!(next.snapshot().local_store_id(), head.local_store_id());
        assert_eq!(next.snapshot().generation_epoch(), head.generation_epoch());
        assert_eq!(next.snapshot().versions(), head.versions());
        let tx = reopened
            .document_transaction(TransactionBehavior::Deferred)
            .unwrap();
        let current = control(&tx).unwrap();
        assert_eq!(current.allocated, 4);
        assert_eq!(current.head.as_ref(), Some(&Snapshot::of(&head)));
        tx.commit().unwrap();
    }

    #[test]
    fn exhausted_generation_allocation_leaves_durable_control_and_headers_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().canonicalize().unwrap();
        let mut store = Store::open(parent.join("store.sqlite")).unwrap();
        store.initialize_document_index().unwrap();
        let tx = store
            .document_transaction(TransactionBehavior::Immediate)
            .unwrap();
        let mut current = control(&tx).unwrap();
        current.allocated = u64::MAX;
        let before = encode(&current).unwrap();
        tx.execute(
            "UPDATE document_index_control SET record=?1 WHERE singleton=1",
            [&before],
        )
        .unwrap();
        tx.commit().unwrap();

        assert!(matches!(
            store.begin_document_index(),
            Err(DocumentIndexError::Contract(IndexError::InvalidGeneration))
        ));
        let tx = store
            .document_transaction(TransactionBehavior::Deferred)
            .unwrap();
        let after: String = tx
            .query_row(
                "SELECT record FROM document_index_control WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let headers: i64 = tx
            .query_row("SELECT count(*) FROM document_index_generations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, before);
        assert_eq!(headers, 0);
        tx.commit().unwrap();
    }

    #[test]
    fn shared_generation_reuses_the_admitted_allocation_without_retaining_a_pin() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
        store.apply(&create("shared-note")).unwrap();
        store.initialize_document_index().unwrap();
        build(&mut store);
        let pin = store.open_document_snapshot().unwrap();
        let first = pin.shared_generation();
        let second = pin.shared_generation();
        assert!(std::sync::Arc::ptr_eq(&first, &second));
        assert!(std::ptr::eq(first.as_ref(), pin.generation()));
        assert_eq!(
            store
                .document_query_pins
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        let source = first.manifest().source().clone();
        let witness = first
            .manifest()
            .witness(&EntryId::new("shared-note").unwrap())
            .unwrap();
        store.close_document_snapshot(pin);
        assert_eq!(
            store
                .document_query_pins
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
        // Immutable data remain usable as data after admission has been dropped.
        assert_eq!(first.manifest().source(), &source);
        assert_eq!(second.manifest().check_witness(&witness), Ok(()));
    }

    #[test]
    fn shared_data_do_not_extend_pin_limits_or_authorize_foreign_or_rebuilt_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = Store::open(&path).unwrap();
        store.apply(&create("shared-note")).unwrap();
        store.initialize_document_index().unwrap();
        build(&mut store);
        let mut pins: Vec<_> = (0..DOCUMENT_INDEX_MAX_QUERY_PINS)
            .map(|_| store.open_document_snapshot().unwrap())
            .collect();
        let data: Vec<_> = (0..16).map(|_| pins[0].shared_generation()).collect();
        assert!(data
            .iter()
            .all(|value| std::sync::Arc::ptr_eq(value, &data[0])));
        assert_eq!(
            store
                .document_query_pins
                .load(std::sync::atomic::Ordering::Relaxed),
            DOCUMENT_INDEX_MAX_QUERY_PINS
        );
        assert!(matches!(
            store.open_document_snapshot(),
            Err(DocumentIndexError::Contract(IndexError::GenerationLimit))
        ));
        store.close_document_snapshot(pins.remove(0));
        let replacement = store.open_document_snapshot().unwrap();
        assert_eq!(
            store
                .document_query_pins
                .load(std::sync::atomic::Ordering::Relaxed),
            DOCUMENT_INDEX_MAX_QUERY_PINS
        );
        let foreign = Store::open(&path).unwrap();
        assert!(matches!(
            foreign.document_snapshot_manifest(&replacement),
            Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
        ));
        assert!(matches!(
            foreign.read_document_projection(&replacement, &EntryId::new("shared-note").unwrap()),
            Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
        ));
        drop(foreign);
        store.rebuild_document_index().unwrap();
        for pin in pins.iter().chain(std::iter::once(&replacement)) {
            assert!(matches!(
                store.document_snapshot_manifest(pin),
                Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
            ));
            assert!(matches!(
                store.read_document_projection(pin, &EntryId::new("shared-note").unwrap()),
                Err(DocumentIndexError::Contract(IndexError::SnapshotExpired))
            ));
        }
        assert!(data[0]
            .record(&EntryId::new("shared-note").unwrap())
            .is_some());
        drop(pins);
        store.close_document_snapshot(replacement);
        assert_eq!(
            store
                .document_query_pins
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
        assert_eq!(
            store
                .read(&EntryId::new("shared-note").unwrap())
                .unwrap()
                .unwrap()
                .content
                .unwrap(),
            b"needle"
        );
    }

    #[test]
    fn shared_generation_preserves_old_retained_projection_after_a_source_commit() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
        store.apply(&create("shared-note")).unwrap();
        store.initialize_document_index().unwrap();
        build(&mut store);
        let old = store.open_document_snapshot().unwrap();
        let shared = old.shared_generation();
        let id = EntryId::new("shared-note").unwrap();
        let previous = shared.manifest().entry(&id).unwrap().clone();
        store
            .apply(&MutationRequest {
                operation_id: OperationId::new("write-shared-note").unwrap(),
                mutation: Mutation::Write {
                    id: id.clone(),
                    expected: previous.revision.clone(),
                    content: b"new source".to_vec(),
                },
            })
            .unwrap();
        build(&mut store);
        let current = store.open_document_snapshot().unwrap();
        assert_ne!(current.generation().id(), shared.id());
        assert_ne!(
            current.generation().manifest().entry(&id).unwrap().revision,
            previous.revision
        );
        let retained = store.read_document_projection(&old, &id).unwrap();
        assert_eq!(retained.witness.entry(), &previous);
        assert_eq!(retained.content.unwrap(), b"needle");
        assert_eq!(
            store
                .read_document_projection(&current, &id)
                .unwrap()
                .content
                .unwrap(),
            b"new source"
        );
        assert_eq!(
            store
                .document_snapshot_manifest(&old)
                .unwrap()
                .manifest()
                .unwrap(),
            *shared.manifest()
        );
        store.close_document_snapshot(current);
        store.close_document_snapshot(old);
    }

    // Same connection-local trace pattern as the retained Text tests. The Box
    // stays live until Drop unregisters the callback, including assertion panic.
    struct CaptureReads<'a> {
        connection: &'a Connection,
        counts: Box<std::cell::Cell<(usize, usize)>>,
    }
    impl<'a> CaptureReads<'a> {
        fn new(connection: &'a Connection) -> Self {
            unsafe extern "C" fn observe(
                event: u32,
                context: *mut std::ffi::c_void,
                _statement: *mut std::ffi::c_void,
                sql: *mut std::ffi::c_void,
            ) -> i32 {
                if event == rusqlite::ffi::SQLITE_TRACE_STMT && !context.is_null() && !sql.is_null()
                {
                    // SQLite owns the synchronous NUL-terminated statement; the
                    // guard owns this stable Cell. No allocation/panic here.
                    let bytes = unsafe { std::ffi::CStr::from_ptr(sql.cast()) }.to_bytes();
                    let counts = unsafe { &*context.cast::<std::cell::Cell<(usize, usize)>>() };
                    let (bulk, point) = counts.get();
                    if bytes.starts_with(b"SELECT\n    length(content),") {
                        counts.set((bulk.saturating_add(1), point));
                    } else if bytes.starts_with(b"SELECT length(content),length(CAST(content_ref AS BLOB))")
                        || bytes.starts_with(b"SELECT path,deleted,state,content_ref,content_digest FROM entries WHERE id=") {
                        counts.set((bulk, point.saturating_add(1)));
                    }
                }
                0
            }
            let guard = Self {
                connection,
                counts: Box::new(std::cell::Cell::new((0, 0))),
            };
            let status = unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    connection.handle(),
                    rusqlite::ffi::SQLITE_TRACE_STMT,
                    Some(observe),
                    (&*guard.counts as *const std::cell::Cell<(usize, usize)>)
                        .cast_mut()
                        .cast(),
                )
            };
            assert_eq!(status, rusqlite::ffi::SQLITE_OK);
            guard
        }
    }
    impl Drop for CaptureReads<'_> {
        fn drop(&mut self) {
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    self.connection.handle(),
                    0,
                    None,
                    std::ptr::null_mut(),
                );
            }
        }
    }
    #[test]
    fn capture_keeps_one_checked_metadata_scan_and_exact_point_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
        for name in ["z", "A", "a", "hidden", "deleted", "folder"] {
            let mut request = create(name);
            if name == "folder" {
                if let Mutation::Create { kind, content, .. } = &mut request.mutation {
                    *kind = EntryKind::Folder;
                    *content = None;
                }
            }
            store.apply(&request).unwrap();
        }
        let deleted = store
            .read_metadata(&EntryId::new("deleted").unwrap())
            .unwrap()
            .unwrap()
            .state;
        store
            .apply(&MutationRequest {
                operation_id: OperationId::new("delete").unwrap(),
                mutation: Mutation::Delete {
                    id: deleted.id,
                    expected: deleted.revision,
                    recursive: false,
                },
            })
            .unwrap();
        store
            .connection
            .execute("UPDATE entries SET visible=0 WHERE id='hidden'", [])
            .unwrap();
        let tx = store.connection.unchecked_transaction().unwrap();
        let trace = CaptureReads::new(&tx);
        let actual = capture_authority(&tx).unwrap();
        assert_eq!(
            trace.counts.get(),
            (1, 8),
            "one bulk scan; only the unchanged presentation metadata reads remain"
        );
        drop(trace);
        // Independent original point reader over the same transaction, including
        // presentation facts and every metadata field in exact manifest order.
        let ids = tx
            .prepare("SELECT id FROM entries WHERE visible=1 AND deleted=0 ORDER BY path")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let entries = ids
            .into_iter()
            .map(|id| {
                entry_content::read_metadata_row(&tx, &EntryId::new(id).unwrap())
                    .unwrap()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let presentations = entries
            .iter()
            .map(|entry| presentation::presentation(&tx, &entry.state).unwrap())
            .collect();
        let source = source_authority(&tx).unwrap();
        let expected = DocumentManifest {
            local_store_id: source.local_store_id().clone(),
            watermark: source.watermark().as_str().into(),
            entries,
            presentations,
        };
        assert_eq!(actual, expected);
        assert_eq!(actual.entries.len(), 4);
        actual.manifest().unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn compound_status_never_reports_cache_newer_than_its_observed_source() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("vault.sqlite");
        let cache = root.join("cache.sqlite");
        let mut reader = Store::open(&path).unwrap();
        reader.enable_document_cache(&cache).unwrap();
        reader.initialize_document_index().unwrap();
        build(&mut reader);
        let mut writer = Store::open(&path).unwrap();
        writer.enable_document_cache(&cache).unwrap();
        let tx = reader
            .document_transaction(TransactionBehavior::Deferred)
            .unwrap();
        let observed = source(&tx).unwrap();
        writer.apply(&create("concurrent-note")).unwrap();
        build(&mut writer);
        let status = index_status(&tx, &observed).unwrap();
        tx.commit().unwrap();
        let DocumentIndexStatus::Ready {
            covered_watermark,
            observed_source_head,
            ..
        } = status
        else {
            panic!("expected retained ready generation");
        };
        assert_eq!(covered_watermark, observed.watermark().as_str());
        assert_eq!(observed_source_head, observed.watermark().as_str());
        assert_ne!(
            writer.document_index_status_with_source().unwrap().0,
            observed
        );
    }
}

#[cfg(test)]
#[path = "document_stage_recovery_tests.rs"]
mod stage_recovery_tests;

#[cfg(test)]
#[path = "document_metadata_registration_tests.rs"]
mod metadata_registration_tests;
