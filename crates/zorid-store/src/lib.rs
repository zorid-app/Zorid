//! Native database authority. File projection and encrypted networking are separate
//! adapters; a database commit must never be mistaken for either of those outcomes.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};

mod checkpoints;
mod directory;
pub use checkpoints::{
    Checkpoint, CheckpointError, CheckpointMetadata, CheckpointPage, CheckpointScope,
    CheckpointWrite, MAX_CHECKPOINT_BYTES,
};
mod namespace;
pub use namespace::{
    NamespaceAttempt, NamespaceEvidence, NamespaceMember, MAX_NAMESPACE_EVIDENCE_BYTES,
    MAX_NAMESPACE_MEMBERS,
};
mod host_intents;
pub use host_intents::{
    HostIntentAcknowledgment, HostIntentPage, HostIntentRef, HostIntentState, HostIntentView,
    HostMutationKind, HostProjectionState, HostRejection, HostRejectionCode,
};
mod presentation;
mod projection;
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
use std::{fmt, path::Path, time::Duration};
pub use text_sync::{AuthoredTextStatus, AuthorityIdentity, TextReceiveOutcome};
use zorid_core::{
    check_idempotency, plan_mutation, CommitResult, ContractError, EntryId, EntryKind, EntryState,
    IdempotencyCheck, Mutation, MutationRequest, RecordedOperation, Revision,
};

const SCHEMA_VERSION: i64 = 7;
const APPLICATION_ID: i64 = 0x5a4f5244; // ZORD
const SCHEMA: &[(&str, &str)] = &[
    ("entries", "CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), state TEXT NOT NULL, content BLOB)"),
    ("live_paths", "CREATE UNIQUE INDEX live_paths ON entries(path) WHERE deleted = 0"),
    ("operations", "CREATE TABLE operations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, result TEXT)"),
    ("outbox", "CREATE TABLE outbox (sequence INTEGER PRIMARY KEY REFERENCES operations(sequence))"),
    ("projection_queue", "CREATE TABLE projection_queue (sequence INTEGER PRIMARY KEY REFERENCES operations(sequence))"),
];

fn check_schema(connection: &Connection) -> Result<i64> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let application: i64 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if !matches!(version, 0 | 1 | 2 | 3 | 4 | 5 | 6 | SCHEMA_VERSION) {
        return Err(StoreError::UnsupportedSchema(version));
    }
    if version == 0 {
        let objects: i64 = connection.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
            [],
            |r| r.get(0),
        )?;
        if application != 0 || objects != 0 {
            return Err(StoreError::Corrupt(
                "unversioned nonempty or foreign database".into(),
            ));
        }
    } else {
        if application != APPLICATION_ID {
            return Err(StoreError::Corrupt("wrong application ID".into()));
        }
        // Every supported version has one canonical layout. Extra objects can
        // shadow a migration or change write behavior, so reject before WAL too.
        let names: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let expected_names: Vec<&str> = SCHEMA
            .iter()
            .filter(|(name, _)| version < 6 || *name != "projection_queue")
            .chain(if version >= 2 {
                projection::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 6 {
                directory::SCHEMA_V6
            } else if version >= 3 {
                directory::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 3 { scan::SCHEMA } else { &[] })
            .chain(if version >= 4 {
                presentation::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 5 {
                host_intents::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 6 {
                projection_jobs::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 7 { namespace::SCHEMA } else { &[] })
            .chain(if version >= 6 { text_sync::SCHEMA } else { &[] })
            .chain(if version >= 6 {
                checkpoints::SCHEMA
            } else {
                &[]
            })
            .map(|(name, _)| *name)
            .collect();
        if names.len() != expected_names.len()
            || names
                .iter()
                .any(|name| !expected_names.contains(&name.as_str()))
        {
            return Err(StoreError::Corrupt("unexpected schema objects".into()));
        }
        let normalize = |sql: &str| {
            sql.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase()
        };
        for (name, expected) in SCHEMA
            .iter()
            .filter(|(name, _)| version < 6 || *name != "projection_queue")
            .chain(if version >= 2 {
                projection::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 6 {
                directory::SCHEMA_V6
            } else if version >= 3 {
                directory::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 3 { scan::SCHEMA } else { &[] })
            .chain(if version >= 4 {
                presentation::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 5 {
                host_intents::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 6 {
                projection_jobs::SCHEMA
            } else {
                &[]
            })
            .chain(if version >= 7 { namespace::SCHEMA } else { &[] })
            .chain(if version >= 6 { text_sync::SCHEMA } else { &[] })
            .chain(if version >= 6 {
                checkpoints::SCHEMA
            } else {
                &[]
            })
        {
            let actual = connection
                .query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?;
            if actual.as_deref().map(normalize).as_deref() != Some(normalize(expected).as_str()) {
                return Err(StoreError::Corrupt(format!("invalid schema object {name}")));
            }
        }
    }
    Ok(version)
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

fn read_states(connection: &Connection, include_deleted: bool) -> Result<Vec<EntryState>> {
    let mut stmt = connection.prepare(
        "SELECT id,path,deleted,state,content IS NOT NULL FROM entries WHERE ?1 OR deleted=0 ORDER BY path"
    )?;
    let records = stmt
        .query_map([include_deleted], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    records
        .into_iter()
        .map(|(id, path, deleted, json, has_content)| {
            decode_state(&id, &path, deleted, &json, has_content)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReloadReason {
    CursorAhead,
    JournalGap,
    EventTooLarge,
}

#[derive(Debug)]
pub enum StoreError {
    ReloadRequired(ReloadReason),
    Sql(rusqlite::Error),
    Sync(zorid_client_sync::SyncError),
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
            Self::ReloadRequired(reason) => {
                write!(f, "Coherent snapshot reload required: {reason:?}")
            }
            Self::Sync(e) => write!(f, "Text synchronization error: {e}"),
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
}

impl Store {
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
        let mut flags = OpenFlags::default();
        if no_follow {
            flags |= OpenFlags::SQLITE_OPEN_NOFOLLOW;
        }
        if existing {
            flags.remove(OpenFlags::SQLITE_OPEN_CREATE);
        }
        let mut connection = Connection::open_with_flags(path, flags)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        // Inspect before changing journal mode: do not mutate unknown newer stores.
        {
            let snapshot = connection.transaction()?;
            let version = check_schema(&snapshot)?;
            if existing && version == 0 {
                return Err(StoreError::Corrupt("vault is not initialized".into()));
            }
            snapshot.commit()?;
        }
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version = check_schema(&tx)?;
        if existing && version == 0 {
            return Err(StoreError::Corrupt("vault is not initialized".into()));
        }
        if version == 0 {
            // A fresh initialization is atomic and serialized across processes.
            for (_, sql) in SCHEMA {
                tx.execute_batch(sql)?;
            }
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
        }
        if version < 2 {
            for (_, sql) in projection::SCHEMA {
                tx.execute_batch(sql)?;
            }
        }
        if version < 3 {
            for (_, sql) in directory::SCHEMA.iter().chain(scan::SCHEMA) {
                tx.execute_batch(sql)?;
            }
        }
        if version < 4 {
            presentation::migrate(&tx)?;
        }
        if version < 5 {
            for (_, sql) in host_intents::SCHEMA {
                tx.execute_batch(sql)?;
            }
        }
        if version < 6 {
            projection_jobs::migrate(&tx)?;
            directory::migrate_job_schema(&tx)?;
            text_sync::migrate(&tx)?;
            checkpoints::migrate(&tx)?;
        }
        if version < 7 {
            for (_, sql) in namespace::SCHEMA {
                tx.execute_batch(sql)?;
            }
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        tx.commit()?;
        Ok(Self { connection })
    }

    pub fn list(&self) -> Result<Vec<EntryState>> {
        read_states(&self.connection, false)
    }

    pub fn read(&self, id: &EntryId) -> Result<Option<StoredEntry>> {
        self.connection
            .query_row(
                "SELECT path,deleted,state,content FROM entries WHERE id=?1",
                [id.as_str()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                },
            )
            .optional()?
            .map(|(path, deleted, json, content)| {
                let state = decode_state(id.as_str(), &path, deleted, &json, content.is_some())?;
                Ok(StoredEntry { state, content })
            })
            .transpose()
            .map(|entry: Option<StoredEntry>| entry.filter(|entry| !entry.state.deleted))
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
        let prior = tx
            .query_row(
                "SELECT request,result FROM operations WHERE operation_id=?1",
                [request.operation_id.as_str()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
            .map(|(req, result)| -> Result<RecordedOperation> {
                Ok(RecordedOperation {
                    request: serde_json::from_str(&req)?,
                    result: serde_json::from_str(&result)?,
                })
            })
            .transpose()?;
        if let IdempotencyCheck::Replay(receipt) = check_idempotency(request, prior.as_ref())? {
            return Ok(receipt.clone());
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
                serde_json::to_string(request)?
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
            let content = match replaced {
                Some(content) => content,
                None => tx
                    .query_row(
                        "SELECT content FROM entries WHERE id=?1",
                        [state.id.as_str()],
                        |r| r.get::<_, Option<Vec<u8>>>(0),
                    )
                    .optional()?
                    .flatten(),
            };
            if (state.kind == EntryKind::File) != content.is_some() {
                return Err(StoreError::Corrupt("file/folder content mismatch".into()));
            }
            tx.execute(
                "INSERT INTO entries(id,path,deleted,state,content) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(id) DO UPDATE SET path=excluded.path,deleted=excluded.deleted,state=excluded.state,content=excluded.content",
                params![state.id.as_str(), state.path.as_str(), state.deleted, serde_json::to_string(state)?, content],
            )?;
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
    pub fn operations_after(&self, sequence: u64, limit: u32) -> Result<Vec<RecordedOperation>> {
        if sequence > i64::MAX as u64 {
            return Ok(Vec::new());
        }
        let mut stmt = self.connection.prepare(
            "SELECT request,result FROM operations WHERE sequence>?1 ORDER BY sequence LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![sequence as i64, limit.min(1000)], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(request, result)| {
                let operation = RecordedOperation {
                    request: serde_json::from_str(&request)?,
                    result: serde_json::from_str(&result)?,
                };
                operation.result.validate()?;
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
