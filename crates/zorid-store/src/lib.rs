//! Native database authority. File projection and encrypted networking are separate
//! adapters; a database commit must never be mistaken for either of those outcomes.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use entry_content::read_states;

mod binary_commit;
mod blob_read;
mod capture_authorization;
pub mod document_index;
mod document_cache;
mod document_parse_cache;
mod entry_content;
mod family_metadata_transactions;
mod immutable_payloads;
#[cfg(test)]
mod one_mib_text_tests;
mod operation_request;
pub use binary_commit::{
    BinaryStageCommit, BinaryStageRejection, BinaryStageRejectionCode, BinaryStageTerminal,
    BINARY_COMMIT_MAX_RECEIPT_BYTES,
};
pub use blob_read::{
    BinaryReadChunk, BinaryReadRef, BinaryReadSession, BINARY_READ_MAX_ACTIVE_PINS,
    BINARY_READ_MAX_RANGE_BYTES,
};
pub use document_index::{
    DocumentIndexError, DocumentIndexProgress, DocumentIndexStage, DocumentIndexStatus,
    DocumentIndexPumpResult, DocumentManifest, DocumentPreviewCaptureRequest, DocumentQueryPin,
    DocumentPreviewCapture, DocumentPreviewPresentation, DocumentPreviewDefinition,
    DocumentRegisteredPreviewPumpResult, DocumentSourceRead, DocumentStageProgress,
};
pub use entry_content::FAMILY_MAX_INLINE_BYTES;
pub use family_external_create::ExternalCreateIntent;
pub use operation_request::{
    BinaryOperationRequest, InlineCallCommitment, InlineCallTarget, OperationRequest,
    StoredOperation,
};
pub use zorid_file_sync::{Manifest as BinaryContentManifest, Sha256Digest};
pub use zorid_file_sync::mutation::{DestinationParent, FamilyCommand};
mod blob_index;
mod blob_stage;
mod checkpoints;
mod content;
pub use blob_stage::BinaryCaptureRequest as CaptureRequest;
pub use blob_stage::{
    BinaryCaptureRequest, BinaryStageManifest, BinaryStageRef, BinaryStageRequest,
    BinaryStageStatus, BinaryTarget, StageChunkReceipt, StagePhase, StagedBinaryRef,
    StreamingLimits, BINARY_STAGE_MAX_CHUNK_BYTES, BINARY_STAGE_MAX_FILE_BYTES,
    BINARY_STAGE_MAX_PATH_BYTES, BINARY_STAGE_MAX_PAYLOAD_BYTES,
};
pub use content::{
    BinarySourceRef, BinaryStageLocator, CapturedBinaryRef, ContentMetadata, PublishedBinaryRef,
    StoredContent, StoredEntryMetadata,
};
mod external_scan_progress;
mod family_commands;
pub use family_commands::{FamilyCommandKind, FamilyCommandProjection, FamilyCommandStatus, MAX_FAMILY_COMMAND_STATUS_BYTES};
mod family_external_create;
mod family_external_namespace;
pub use family_external_namespace::{
    ExternalNamespaceAction, ExternalNamespaceCommit, ExternalNamespaceMember,
    ExternalNamespaceObservation, ExternalScanProof,
};
mod family_ingress;
mod family_materialization;
mod family_observations;
pub use family_materialization::{FamilyContentWitness, FamilyMaterialization, FamilyPublication};
mod family_ledger;
mod family_store;
mod managed_records;
pub use managed_records::{
    ManagedChange, ManagedChangePage, ManagedCollection, ManagedCommit, ManagedExportPage,
    ManagedIntentDisposition, ManagedIntentInput, ManagedIntentPage, ManagedIntentRef,
    ManagedIntentSettlement, ManagedPendingIntent, ManagedRegistration, ManagedRetryPage,
    ManagedRevision, ManagedSnapshot, ManagedTarget, ManagedUnresolvedCursor,
    ManagedUnresolvedEvidence, ManagedUnresolvedSummary,
};
mod file_state;
pub use family_store::{
    FamilyAuthoredStatus, FamilyCreateMode, FamilyEnvelopeOrigin, FamilyEnvelopeStatus,
    FamilyLimits, FamilyPayloadKind, FamilyReceiveCommit, FamilyScope, FamilyStatus,
    FAMILY_MAX_FILE_BYTES,
};
mod directory;
pub use checkpoints::{
    Checkpoint, CheckpointError, CheckpointMetadata, CheckpointPage, CheckpointScope,
    CheckpointWrite, MAX_CHECKPOINT_BYTES,
};
mod namespace;
pub use namespace::{
    namespace_content_evidence_bytes, NamespaceAttempt, NamespaceAttemptMetadata,
    NamespaceEvidence, NamespaceMember, NamespaceMemberMetadata, NamespaceSuccessorPlan,
    MAX_NAMESPACE_EVIDENCE_BYTES, MAX_NAMESPACE_MEMBERS,
};
mod host_intents;
pub use host_intents::{
    HostIntentAcknowledgment, HostIntentPage, HostIntentRef, HostIntentState, HostIntentView,
    HostMutationKind, HostProjectionState, HostRejection, HostRejectionCode,
};
mod physical_bindings;
mod presentation;
mod projection;
pub use physical_bindings::{
    ObservationPhysical, PhysicalBinding, PhysicalIdentity, PublicationKind, PublicationProof,
};
mod projection_jobs;
pub use presentation::{
    ChangeOrigin, ChangePage, EntryPresentation, ListingSnapshot, LocalChange, PresentedEntry,
    PresentedState,
};
pub use projection_jobs::{ProjectionJob, ProjectionOrigin, ProjectionWork};
mod scan;
mod text_sync;
pub use directory::{DirectoryAttempt, DirectoryBaseline, DirectoryPhase};
pub use projection::{ExternalObservation, ProjectionAttempt, ProjectionBaseline, ProjectionPhase};
pub use scan::{DirectoryCoverage, ScanObservation, ScanObservationKind, ScanRun};
use serde::{Deserialize, Serialize};
use std::{fmt, path::Path};
use zorid_sqlite::{open_checked, OpenMode};
pub use text_sync::{AuthoredTextStatus, AuthorityIdentity, TextReceiveOutcome};
use zorid_core::{
    check_idempotency, plan_mutation, CommitResult, ContractError, EntryId, EntryKind, EntryState,
    Mutation, MutationRequest, RecordedOperation, Revision,
};

const SCHEMA_VERSION: i64 = 15;
const TEXT_PREDECESSOR_SCHEMA_VERSION: i64 = 14;
const NAMESPACE_SCHEMA_VERSION: i64 = 13;
const PREDECESSOR_SCHEMA_VERSION: i64 = 12;
pub const DEFAULT_STREAMING_LIMITS: StreamingLimits = StreamingLimits {
    max_active_stages: 8,
    max_stage_records: 4096,
    max_staged_bytes: 512 * 1024 * 1024,
    max_chunk_records: 4096,
    max_page_records: 256,
};
const APPLICATION_ID: i64 = 0x5a4f5244; // ZORD
const SCHEMA: &[(&str, &str)] = &[
    ("entries", "CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), state TEXT NOT NULL, content BLOB, visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)), content_ref TEXT, content_digest TEXT)"),
    ("live_paths", "CREATE UNIQUE INDEX live_paths ON entries(path) WHERE deleted = 0 AND visible = 1"),
    ("operations", "CREATE TABLE operations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, result TEXT)"),
    ("outbox", "CREATE TABLE outbox (sequence INTEGER PRIMARY KEY REFERENCES operations(sequence))"),
];

fn schema_objects() -> Vec<(&'static str, &'static str)> {
    SCHEMA
        .iter()
        .chain(projection::SCHEMA)
        .chain(directory::SCHEMA_V6)
        .chain(scan::SCHEMA)
        .chain(presentation::SCHEMA)
        .chain(host_intents::SCHEMA)
        .chain(projection_jobs::SCHEMA)
        .chain(namespace::SCHEMA)
        .chain(text_sync::SCHEMA)
        .chain(checkpoints::SCHEMA)
        .chain(physical_bindings::SCHEMA)
        .chain(family_commands::SCHEMA)
        .chain(family_external_create::SCHEMA)
        .chain(family_external_namespace::SCHEMA)
        .chain(immutable_payloads::SCHEMA)
        .chain(family_ledger::SCHEMA)
        .chain(managed_records::SCHEMA)
        .chain(file_state::SCHEMA)
        .chain(blob_index::SCHEMA)
        .chain(blob_stage::SCHEMA)
        .chain(blob_read::SCHEMA)
        .chain(binary_commit::SCHEMA)
        .chain(family_materialization::SCHEMA)
        .copied()
        .collect()
}
fn check_schema(connection: &Connection) -> Result<i64> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let application: i64 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
    // Unreleased formats: reject before changing WAL or database bytes.
    if !matches!(
        version,
        0 | PREDECESSOR_SCHEMA_VERSION | NAMESPACE_SCHEMA_VERSION | TEXT_PREDECESSOR_SCHEMA_VERSION | SCHEMA_VERSION
    ) {
        return Err(StoreError::UnsupportedSchema(version));
    }
    let names: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    if version == 0 {
        if application != 0 || !names.is_empty() {
            return Err(StoreError::Corrupt(
                "unversioned nonempty or foreign database".into(),
            ));
        }
    } else {
        if application != APPLICATION_ID {
            return Err(StoreError::Corrupt("wrong application ID".into()));
        }
        let expected: Vec<_> = schema_objects()
            .into_iter()
            .filter(|(name, _)| {
                (version != PREDECESSOR_SCHEMA_VERSION || *name != "namespace_successions")
                    && (version >= TEXT_PREDECESSOR_SCHEMA_VERSION || *name != projection::EXTERNAL_UNRESOLVED_INDEX.0)
            })
            .map(|(name, sql)| if name == "immutable_payloads" && version < SCHEMA_VERSION {
                (name, immutable_payloads::LEGACY_TABLE_SQL)
            } else { (name, sql) })
            .collect();
        // SQLite trigger names occupy a separate namespace. A duplicate name
        // must not hide an extra trigger behind a registered table's SQL.
        if names
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != names.len()
            || expected
                .iter()
                .any(|(name, _)| !names.iter().any(|actual| actual.as_str() == *name))
            || names.iter().any(|name| {
                !expected
                    .iter()
                    .chain(document_index::SCHEMA)
                    .any(|(expected, _)| *expected == name)
            })
        {
            return Err(StoreError::Corrupt("unexpected schema objects".into()));
        }
        let normalize = |sql: &str| {
            sql.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase()
        };
        for (name, sql) in expected.into_iter().chain(
            document_index::SCHEMA
                .iter()
                .copied()
                .filter(|(name, _)| names.iter().any(|actual| actual.as_str() == *name)),
        ) {
            let actual: String = connection.query_row(
                "SELECT sql FROM sqlite_master WHERE name=?1",
                [name],
                |r| r.get(0),
            )?;
            if normalize(&actual) != normalize(sql) {
                return Err(StoreError::Corrupt(format!("invalid schema object {name}")));
            }
        }
        if matches!(
            version,
            PREDECESSOR_SCHEMA_VERSION | NAMESPACE_SCHEMA_VERSION
        ) {
            projection::check_observation_index_inputs(connection)?;
        }
    }
    Ok(version)
}
pub(crate) fn is_visible(tx: &Connection, id: &EntryId) -> Result<bool> {
    let value: Option<i64> = tx
        .query_row(
            "SELECT visible FROM entries WHERE id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    match value {
        Some(1) => Ok(true),
        Some(0) | None => Ok(false),
        _ => Err(StoreError::Corrupt("invalid entry visibility".into())),
    }
}

fn decode_state(
    id: &str,
    path: &str,
    deleted: i64,
    json: &str,
    has_content: bool,
) -> Result<EntryState> {
    let state: EntryState = serde_json::from_str(json)?;
    if state.id.as_str() != id
        || state.path.as_str() != path
        || !matches!(deleted, 0 | 1)
        || state.deleted != (deleted == 1)
        || (state.kind == EntryKind::File) != has_content
    {
        return Err(StoreError::Corrupt(
            "entry columns disagree with logical state".into(),
        ));
    }
    Ok(state)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReloadReason {
    CursorAhead,
    JournalGap,
    EventTooLarge,
}

#[derive(Debug)]
pub enum StoreError {
    StreamRequired { bytes: u64, limit: u64 },
    ReloadRequired(ReloadReason),
    Sql(rusqlite::Error),
    Sync(zorid_client_sync::SyncError),
    FileSync(zorid_file_sync::Error),
    Crypto(zorid_crypto::CryptoError),
    Protocol(zorid_sync_protocol::ProtocolError),
    Json(serde_json::Error),
    Contract(ContractError),
    UnsupportedSchema(i64),
    Corrupt(String),
}
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StreamRequired { bytes, limit } => write!(
                f,
                "content requires streaming ({bytes} bytes; inline limit {limit})"
            ),
            Self::ReloadRequired(reason) => {
                write!(f, "Coherent snapshot reload required: {reason:?}")
            }
            Self::Sync(e) => write!(f, "Text synchronization error: {e}"),
            Self::FileSync(e) => write!(f, "File synchronization error: {e}"),
            Self::Crypto(e) => write!(f, "Envelope encryption error: {e}"),
            Self::Protocol(e) => write!(f, "Envelope protocol error: {e}"),
            Self::Sql(e) => write!(f, "Storage error: {e}"),
            Self::Json(e) => write!(f, "Invalid stored record: {e}"),
            Self::Contract(e) => e.fmt(f),
            Self::UnsupportedSchema(v) => write!(f, "Unsupported database schema {v}"),
            Self::Corrupt(message) => write!(f, "Inconsistent database: {message}"),
        }
    }
}
impl std::error::Error for StoreError {}
impl StoreError {
    /// Expected per-entry divergence or bounded work. Corruption, decoding,
    /// schema, SQL, identity and authentication failures are never diagnostics.
    pub fn is_external_reconciliation_issue(&self) -> bool {
        matches!(
            self,
            Self::Sync(
                zorid_client_sync::SyncError::VersionConflict
                    | zorid_client_sync::SyncError::TooLarge
            ) | Self::FileSync(
                zorid_file_sync::Error::VersionConflict
                    | zorid_file_sync::Error::TooLarge
                    | zorid_file_sync::Error::InvalidLocation
            ) | Self::Contract(
                ContractError::RevisionConflict { .. }
                    | ContractError::EntryNotFound { .. }
                    | ContractError::EntryDeleted { .. }
                    | ContractError::InvalidMutation { .. }
            )
        )
    }
}
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<ContractError> for StoreError {
    fn from(e: ContractError) -> Self {
        Self::Contract(e)
    }
}
impl From<zorid_client_sync::SyncError> for StoreError {
    fn from(e: zorid_client_sync::SyncError) -> Self {
        Self::Sync(e)
    }
}
impl From<zorid_file_sync::Error> for StoreError {
    fn from(e: zorid_file_sync::Error) -> Self {
        Self::FileSync(e)
    }
}
impl From<zorid_crypto::CryptoError> for StoreError {
    fn from(e: zorid_crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}
impl From<zorid_sync_protocol::ProtocolError> for StoreError {
    fn from(e: zorid_sync_protocol::ProtocolError) -> Self {
        Self::Protocol(e)
    }
}
pub type Result<T> = std::result::Result<T, StoreError>;

/// A committed local entry and its bytes, read from the same database snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredEntry {
    pub state: EntryState,
    pub content: Option<Vec<u8>>,
}

/// Each process opens its own Store. No process-local cached state is authoritative.
/// The enclosing native vault adapter must coordinate filesystem reconciliation
/// separately; SQLite transactions do not make filesystem writes atomic.
pub struct Store {
    connection: Connection,
    document_cache: document_cache::DocumentCache,
    // Process-local handles deliberately expire on reopen; persisted generations do not.
    document_query_owner: zorid_core::OperationId,
    document_query_pins: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl Store {
    pub fn is_visible_entry(&self, id: &EntryId) -> Result<bool> {
        is_visible(&self.connection, id)
    }
    /// Opens an explicitly selected database; it does not scan or modify vault files.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_mode(path.as_ref(), false, false)
    }
    /// Strict native adapter entrypoint: caller supplies a checked canonical path.
    pub fn open_no_follow(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_mode(path.as_ref(), true, false)
    }
    /// Requires an existing initialized database; cannot create a missing/empty DB.
    pub fn open_existing_no_follow(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_mode(path.as_ref(), true, true)
    }
    fn open_mode(path: &Path, no_follow: bool, existing: bool) -> Result<Self> {
        let mode = match (no_follow, existing) {
            (_, true) => OpenMode::ExistingNoFollow,
            (true, false) => OpenMode::CreateNoFollow,
            (false, false) => OpenMode::Create,
        };
        let mut connection = open_checked(path, mode, |snapshot| -> Result<()> {
            let version = check_schema(snapshot)?;
            if existing && version == 0 {
                return Err(StoreError::Corrupt("vault is not initialized".into()));
            }
            Ok(())
        })?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version = check_schema(&tx)?;
        if existing && version == 0 {
            return Err(StoreError::Corrupt("vault is not initialized".into()));
        }
        if version == 0 {
            // Current-format empty initialization only, in one transaction.
            for (_, sql) in SCHEMA
                .iter()
                .chain(projection::SCHEMA)
                .chain(directory::SCHEMA_V6)
                .chain(scan::SCHEMA)
                .chain(host_intents::SCHEMA)
                .chain(projection_jobs::SCHEMA)
                .chain(namespace::SCHEMA)
                .chain(physical_bindings::SCHEMA)
                .chain(family_commands::SCHEMA)
                .chain(family_external_create::SCHEMA)
                .chain(family_external_namespace::SCHEMA)
                .chain(immutable_payloads::SCHEMA)
                .chain(family_ledger::SCHEMA)
                .chain(managed_records::SCHEMA)
                .chain(file_state::SCHEMA)
                .chain(blob_index::SCHEMA)
                .chain(blob_stage::SCHEMA)
                .chain(blob_read::SCHEMA)
                .chain(binary_commit::SCHEMA)
                .chain(family_materialization::SCHEMA)
            {
                tx.execute_batch(sql)?;
            }
            presentation::migrate(&tx)?;
            text_sync::migrate(&tx)?;
            checkpoints::migrate(&tx)?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        if matches!(version, PREDECESSOR_SCHEMA_VERSION | NAMESPACE_SCHEMA_VERSION | TEXT_PREDECESSOR_SCHEMA_VERSION) {
            immutable_payloads::migrate_text_bound(&tx)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        if version == PREDECESSOR_SCHEMA_VERSION {
            // Add only the explicit delegation journal after exact old-format
            // validation, repeated under this writer. Existing evidence is inert.
            for (_, sql) in namespace::SUCCESSOR_SCHEMA {
                tx.execute_batch(sql)?;
            }
        }
        if matches!(
            version,
            PREDECESSOR_SCHEMA_VERSION | NAMESPACE_SCHEMA_VERSION
        ) {
            tx.execute_batch(projection::EXTERNAL_UNRESOLVED_INDEX.1)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        tx.commit()?;
        let document_cache = document_cache::DocumentCache::memory()?;
        Ok(Self {
            connection,
            document_cache,
            document_query_owner: zorid_core::OperationId::new(uuid::Uuid::new_v4().to_string())?,
            document_query_pins: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        })
    }

    pub fn list(&self) -> Result<Vec<EntryState>> {
        let tx = self.connection.unchecked_transaction()?;
        let states = read_states(&tx, false)?;
        tx.commit()?;
        Ok(states)
    }

    pub fn read(&self, id: &EntryId) -> Result<Option<StoredEntry>> {
        let tx = self.connection.unchecked_transaction()?;
        let entry = entry_content::read_legacy_entry(&tx, id)?;
        tx.commit()?;
        Ok(entry)
    }

    /// Atomically commits metadata, file bytes, operation receipt, outgoing intent
    /// and projection intent. Replay returns the original receipt without new work.
    /// The caller must not upload raw outbox records: they contain local plaintext.
    pub fn apply(&mut self, request: &MutationRequest) -> Result<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = Self::apply_transaction(&tx, request)?;
        tx.commit()?;
        Ok(result)
    }

    /// Injected wall-clock milliseconds affect display metadata only, never revision/CAS.
    pub fn apply_at(&mut self, request: &MutationRequest, now_ms: u64) -> Result<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = Self::apply_transaction_at(&tx, request, Some(now_ms))?;
        tx.commit()?;
        Ok(result)
    }

    fn apply_transaction(tx: &Connection, request: &MutationRequest) -> Result<CommitResult> {
        Self::apply_transaction_at(tx, request, None)
    }

    fn apply_transaction_at(
        tx: &Connection,
        request: &MutationRequest,
        now_ms: Option<u64>,
    ) -> Result<CommitResult> {
        Self::apply_transaction_text(tx, request, now_ms, None, None)
    }
    fn apply_transaction_text(
        tx: &Connection,
        request: &MutationRequest,
        now_ms: Option<u64>,
        adoption: Option<&zorid_client_sync::TextIdentity>,
        prepared: Option<text_sync::PreparedText>,
    ) -> Result<CommitResult> {
        request.validate()?;
        family_store::reject_legacy_mutation(tx)?;
        let prior = tx
            .query_row(
                "SELECT request,result FROM operations WHERE operation_id=?1",
                [request.operation_id.as_str()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
            .map(|(raw, result)| {
                operation_request::replay_inline_with_mode(request, None, &raw, &result)
            })
            .transpose()?;
        if let Some(receipt) = prior {
            return Ok(receipt);
        }
        host_intents::check_execution(tx, request)?;
        let now_ms = match now_ms {
            Some(value) => value,
            None => presentation::now_ms()?,
        };
        presentation::validate_number(now_ms)?;

        // Reload under the write transaction: another process may have committed
        // after this Store was opened or after the caller last read the file.
        // Initial planner loads metadata only, never whole-vault content blobs.
        let entries = read_states(&tx, true)?;
        let revision = match &prepared {
            Some(text) => text.plan.next_state.version.clone(),
            None => Revision::new(uuid::Uuid::new_v4().to_string())?,
        };
        let changes = plan_mutation(request, &entries, &revision)?;
        text_sync::reserve_revision(tx, &revision)?;
        text_sync::check_namespace(tx, request, &changes)?;
        let text = match prepared {
            Some(text) => Some(text),
            None => text_sync::prepare_local(tx, request, &revision, adoption)?,
        };
        for change in &changes {
            if let Some(before) = &change.before {
                presentation::presentation(tx, before)?;
            }
        }
        tx.execute(
            "INSERT INTO operations(operation_id,request) VALUES (?1,?2)",
            params![
                request.operation_id.as_str(),
                operation_request::encode_inline(request)?
            ],
        )?;
        let sql_sequence = tx.last_insert_rowid();
        let sequence = u64::try_from(sql_sequence)
            .map_err(|_| StoreError::Corrupt("invalid sequence".into()))?;
        let result = CommitResult {
            operation_id: request.operation_id.clone(),
            sequence,
            changes,
        };
        result.validate()?;

        // Remove affected live-path index entries first, so a subtree move is one
        // atomic change even when old/new path sets overlap. The transaction rolls
        // this back on any validation, unique-index, serialization or I/O failure.
        for change in &result.changes {
            tx.execute(
                "UPDATE entries SET deleted=1 WHERE id=?1",
                [change.after.id.as_str()],
            )?;
        }
        for change in &result.changes {
            let state = &change.after;
            let replaced = match &request.mutation {
                Mutation::Create { id, content, .. } if id == &state.id => Some(content.clone()),
                Mutation::Write { id, content, .. } if id == &state.id => {
                    Some(Some(content.clone()))
                }
                _ => None,
            };
            if let Some(content) = replaced {
                if (state.kind == EntryKind::File) != content.is_some() {
                    return Err(StoreError::Corrupt("file/folder content mismatch".into()));
                }
                let digest = content
                    .as_ref()
                    .map(|bytes| serde_json::to_string(&Sha256Digest::of(bytes)))
                    .transpose()?;
                tx.execute(
                    "INSERT INTO entries(id,path,deleted,state,content,content_digest) VALUES (?1,?2,?3,?4,?5,?6)
                     ON CONFLICT(id) DO UPDATE SET path=excluded.path,deleted=excluded.deleted,state=excluded.state,content=excluded.content,content_ref=NULL,content_digest=excluded.content_digest",
                    params![state.id.as_str(), state.path.as_str(), state.deleted, serde_json::to_string(state)?, content, digest],
                )?;
            } else {
                // Namespace changes preserve the existing content authority in SQL;
                // never load every descendant's bytes to rename its parent.
                let count = tx.execute(
                    "UPDATE entries SET path=?1,deleted=?2,state=?3 WHERE id=?4",
                    params![
                        state.path.as_str(),
                        state.deleted,
                        serde_json::to_string(state)?,
                        state.id.as_str()
                    ],
                )?;
                if count != 1 {
                    return Err(StoreError::Corrupt("namespace target is missing".into()));
                }
            }
        }
        tx.execute(
            "UPDATE operations SET result=?1 WHERE sequence=?2",
            params![serde_json::to_string(&result)?, sql_sequence],
        )?;
        if let Some(text) = text {
            text_sync::finish_local(tx, text)?;
        } else {
            tx.execute("INSERT INTO outbox(sequence) VALUES (?1)", [sql_sequence])?;
        }
        projection_jobs::enqueue_local(tx, request, &result)?;
        presentation::record_local(tx, &result, now_ms)?;
        host_intents::record_commit(tx, request)?;
        Ok(result)
    }

    /// Durable local change stream; cursor is an integer locally and decimal string
    /// at JSON boundaries. This is not a remote-server acknowledgement stream.
    pub fn operations_after(
        &self,
        sequence: u64,
        limit: u32,
    ) -> Result<Vec<operation_request::StoredOperation>> {
        if sequence > i64::MAX as u64 {
            return Ok(Vec::new());
        }
        let mut stmt = self.connection.prepare(
            "SELECT operation_id,sequence,request,result FROM operations WHERE sequence>?1 ORDER BY sequence LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![sequence as i64, limit.min(1000)], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, sequence, request, result)| {
                let operation_id = zorid_core::OperationId::new(id)?;
                let operation = operation_request::decode_record(&request, &result, &operation_id)?;
                if u64::try_from(sequence).ok() != Some(operation.result.sequence) {
                    return Err(StoreError::Corrupt(
                        "operation journal sequence mismatch".into(),
                    ));
                }
                Ok(operation)
            })
            .collect()
    }

    pub fn pending_counts(&self) -> Result<(u64, u64)> {
        let (outbox, projections) = self.connection.query_row(
            "SELECT ((SELECT count(*) FROM outbox)+(SELECT count(*) FROM authored_text WHERE accepted=0)),(SELECT count(*) FROM projection_jobs WHERE completed=0)",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )?;
        Ok((
            u64::try_from(outbox)
                .map_err(|_| StoreError::Corrupt("negative outbox count".into()))?,
            u64::try_from(projections)
                .map_err(|_| StoreError::Corrupt("negative projection count".into()))?,
        ))
    }
}
