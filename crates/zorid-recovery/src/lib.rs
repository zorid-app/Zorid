//! Local retained versions. This database is neither the pending-save journal nor
//! a sync source. Callers supply time and a trusted app-local database path.

use rusqlite::{params, Connection, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{fmt, path::Path};
use zorid_sqlite::{open_checked, OpenMode};

const SCHEMA_VERSION: i64 = 1;
// ZREC, distinct from the authoritative vault database.
const APPLICATION_ID: i64 = 0x5a524543;
// One registry drives initialization and exact validation. Recovery never adopts
// a lookalike database or repairs unsupported SQL before retention cleanup.
const SCHEMA: &[(&str, &str, &str)] = &[
    (
        "table",
        "recovery_scope",
        "CREATE TABLE recovery_scope (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        schema_version INTEGER NOT NULL,
        vault_id TEXT NOT NULL,
        replica_id TEXT NOT NULL
    )",
    ),
    (
        "table",
        "snapshots",
        "CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 1024),
        historical_path TEXT NOT NULL CHECK(length(historical_path) BETWEEN 1 AND 4096),
        captured_at_ms INTEGER NOT NULL CHECK(captured_at_ms >= 0),
        provenance TEXT NOT NULL CHECK(provenance IN ('periodic', 'save_failure')),
        content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
        content BLOB NOT NULL
    )",
    ),
    (
        "index",
        "snapshots_entry_time",
        "CREATE INDEX snapshots_entry_time ON snapshots(entry_id, captured_at_ms DESC, id DESC)",
    ),
    (
        "index",
        "snapshots_expiry",
        "CREATE INDEX snapshots_expiry ON snapshots(captured_at_ms)",
    ),
];
pub const DEFAULT_INTERVAL_MS: i64 = 5 * 60 * 1_000;
pub const DEFAULT_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
pub const MAX_LIST_LIMIT: usize = 100;

/// A physical database must never silently change its logical vault or replica.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryScope {
    pub vault_id: String,
    pub replica_id: String,
}

#[derive(Clone, Copy, Debug)]
pub struct RecoveryPolicy {
    pub interval_ms: i64,
    pub retention_ms: i64,
    pub max_snapshot_bytes: usize,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            interval_ms: DEFAULT_INTERVAL_MS,
            retention_ms: DEFAULT_RETENTION_MS,
            max_snapshot_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotProvenance {
    Periodic,
    SaveFailure,
}

impl SnapshotProvenance {
    fn as_str(self) -> &'static str {
        match self {
            Self::Periodic => "periodic",
            Self::SaveFailure => "save_failure",
        }
    }

    fn parse(value: &str) -> Result<Self, RecoveryError> {
        match value {
            "periodic" => Ok(Self::Periodic),
            "save_failure" => Ok(Self::SaveFailure),
            _ => Err(RecoveryError::CorruptRecord),
        }
    }
}

pub struct SnapshotInput<'a> {
    /// Stable entry identity; a rename must not allocate a new entry identity.
    pub entry_id: &'a str,
    /// Vault-relative path at capture time, retained even after rename/deletion.
    pub historical_path: &'a str,
    pub content: &'a [u8],
    pub provenance: SnapshotProvenance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotInfo {
    pub id: i64,
    pub entry_id: String,
    pub historical_path: String,
    pub captured_at_ms: i64,
    pub byte_length: usize,
    pub provenance: SnapshotProvenance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub info: SnapshotInfo,
    pub content: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureOutcome {
    Captured(SnapshotInfo),
    Unchanged,
    IntervalNotElapsed,
}

/// Cursor from the last item in the preceding page; stable under new inserts.
#[derive(Clone, Copy, Debug)]
pub struct SnapshotCursor {
    pub captured_at_ms: i64,
    pub id: i64,
}

#[derive(Debug)]
pub enum RecoveryError {
    Database(rusqlite::Error),
    InvalidInput(&'static str),
    WrongScope,
    UnsupportedSchema,
    CorruptRecord,
    SnapshotTooLarge,
}

impl From<rusqlite::Error> for RecoveryError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Stable diagnostics for hosts; these are not user-facing copy.
        match self {
            Self::Database(error) => write!(f, "recovery database: {error}"),
            Self::InvalidInput(field) => write!(f, "invalid recovery {field}"),
            Self::WrongScope => f.write_str("recovery database scope mismatch"),
            Self::UnsupportedSchema => f.write_str("unsupported recovery schema"),
            Self::CorruptRecord => f.write_str("invalid recovery snapshot"),
            Self::SnapshotTooLarge => f.write_str("recovery snapshot exceeds limit"),
        }
    }
}

impl std::error::Error for RecoveryError {}

pub struct RecoveryStore {
    connection: Connection,
    policy: RecoveryPolicy,
}

impl RecoveryStore {
    pub fn open(
        path: impl AsRef<Path>,
        scope: &RecoveryScope,
        now_ms: i64,
    ) -> Result<Self, RecoveryError> {
        Self::open_with_policy(path, scope, RecoveryPolicy::default(), now_ms)
    }

    pub fn open_with_policy(
        path: impl AsRef<Path>,
        scope: &RecoveryScope,
        policy: RecoveryPolicy,
        now_ms: i64,
    ) -> Result<Self, RecoveryError> {
        validate_identity(&scope.vault_id, "vault identity")?;
        validate_identity(&scope.replica_id, "replica identity")?;
        validate_time(now_ms)?;
        if policy.interval_ms < 0 || policy.retention_ms <= 0 || policy.max_snapshot_bytes == 0 {
            return Err(RecoveryError::InvalidInput("policy"));
        }
        let mut connection = open_checked(path, OpenMode::CreateNoFollow, |connection| {
            check_schema(connection, scope).map(|_| ())
        })?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !check_schema(&transaction, scope)? {
            for (_, _, sql) in SCHEMA {
                transaction.execute_batch(sql)?;
            }
            transaction.execute(
                "INSERT INTO recovery_scope VALUES (1, ?1, ?2, ?3)",
                params![SCHEMA_VERSION, scope.vault_id, scope.replica_id],
            )?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        transaction.execute(
            "DELETE FROM snapshots WHERE captured_at_ms < ?1",
            [now_ms.saturating_sub(policy.retention_ms)],
        )?;
        transaction.commit()?;
        Ok(Self { connection, policy })
    }

    /// Captures are transactional with expiry cleanup. Save-failure captures
    /// bypass cadence, but identical latest content never creates another row.
    pub fn capture(
        &mut self,
        input: SnapshotInput<'_>,
        now_ms: i64,
    ) -> Result<CaptureOutcome, RecoveryError> {
        validate_identity(input.entry_id, "entry identity")?;
        validate_path(input.historical_path)?;
        validate_time(now_ms)?;
        if input.content.len() > self.policy.max_snapshot_bytes {
            return Err(RecoveryError::SnapshotTooLarge);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM snapshots WHERE captured_at_ms < ?1",
            [now_ms.saturating_sub(self.policy.retention_ms)],
        )?;
        let previous = read_latest(&transaction, input.entry_id, self.policy.max_snapshot_bytes)?;
        if let Some(previous) = previous {
            if previous.content == input.content {
                transaction.commit()?;
                return Ok(CaptureOutcome::Unchanged);
            }
            if input.provenance == SnapshotProvenance::Periodic
                && now_ms.saturating_sub(previous.info.captured_at_ms) < self.policy.interval_ms
            {
                transaction.commit()?;
                return Ok(CaptureOutcome::IntervalNotElapsed);
            }
        }
        let hash = Sha256::digest(input.content);
        transaction.execute(
            "INSERT INTO snapshots
             (entry_id, historical_path, captured_at_ms, provenance, content_hash, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.entry_id,
                input.historical_path,
                now_ms,
                input.provenance.as_str(),
                hash.as_slice(),
                input.content
            ],
        )?;
        let info = SnapshotInfo {
            id: transaction.last_insert_rowid(),
            entry_id: input.entry_id.to_owned(),
            historical_path: input.historical_path.to_owned(),
            captured_at_ms: now_ms,
            byte_length: input.content.len(),
            provenance: input.provenance,
        };
        transaction.commit()?;
        Ok(CaptureOutcome::Captured(info))
    }

    /// Lists bounded metadata only; read verifies the stored content hash.
    pub fn list(
        &self,
        entry_id: &str,
        before: Option<SnapshotCursor>,
        limit: usize,
    ) -> Result<Vec<SnapshotInfo>, RecoveryError> {
        validate_identity(entry_id, "entry identity")?;
        if limit == 0 || limit > MAX_LIST_LIMIT {
            return Err(RecoveryError::InvalidInput("list limit"));
        }
        if before.is_some_and(|cursor| cursor.id <= 0 || cursor.captured_at_ms < 0) {
            return Err(RecoveryError::InvalidInput("list cursor"));
        }
        let mut statement = self.connection.prepare(
            "SELECT id, entry_id, historical_path, captured_at_ms, provenance, length(content)
             FROM snapshots WHERE entry_id = ?1
               AND (?2 IS NULL OR captured_at_ms < ?2 OR (captured_at_ms = ?2 AND id < ?3))
             ORDER BY captured_at_ms DESC, id DESC LIMIT ?4",
        )?;
        let mut rows = statement.query(params![
            entry_id,
            before.map(|c| c.captured_at_ms),
            before.map(|c| c.id),
            limit as i64
        ])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(read_info(row, self.policy.max_snapshot_bytes)?);
        }
        Ok(result)
    }

    pub fn read(&self, snapshot_id: i64) -> Result<Option<Snapshot>, RecoveryError> {
        if snapshot_id <= 0 {
            return Err(RecoveryError::InvalidInput("snapshot identity"));
        }
        read_snapshot(
            &self.connection,
            "id = ?1",
            snapshot_id,
            self.policy.max_snapshot_bytes,
        )
    }

    pub fn prune(&mut self, now_ms: i64) -> Result<usize, RecoveryError> {
        validate_time(now_ms)?;
        Ok(self.connection.execute(
            "DELETE FROM snapshots WHERE captured_at_ms < ?1",
            [now_ms.saturating_sub(self.policy.retention_ms)],
        )?)
    }
}

/// False means pristine empty SQLite storage; true means exact current format.
fn check_schema(connection: &Connection, scope: &RecoveryScope) -> Result<bool, RecoveryError> {
    let application: i64 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let objects = connection
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if application == 0 && version == 0 && objects.is_empty() {
        return Ok(false);
    }
    if application != APPLICATION_ID || version != SCHEMA_VERSION || objects.len() != SCHEMA.len() {
        return Err(RecoveryError::UnsupportedSchema);
    }
    let normalize = |sql: &str| sql.split_whitespace().collect::<Vec<_>>().join(" ");
    // Checking type as well as name rejects a trigger sharing a table's name.
    if SCHEMA.iter().any(|(kind, name, sql)| {
        !objects
            .iter()
            .any(|(actual_kind, actual_name, actual_sql)| {
                actual_kind.as_str() == *kind
                    && actual_name.as_str() == *name
                    && normalize(actual_sql) == normalize(sql)
            })
    }) {
        return Err(RecoveryError::UnsupportedSchema);
    }
    let count: i64 =
        connection.query_row("SELECT count(*) FROM recovery_scope", [], |r| r.get(0))?;
    if count != 1 {
        return Err(RecoveryError::UnsupportedSchema);
    }
    let (version, vault, replica): (i64, String, String) = connection.query_row(
        "SELECT schema_version, vault_id, replica_id FROM recovery_scope WHERE singleton = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if version != SCHEMA_VERSION {
        return Err(RecoveryError::UnsupportedSchema);
    }
    if vault != scope.vault_id || replica != scope.replica_id {
        return Err(RecoveryError::WrongScope);
    }
    Ok(true)
}

fn validate_identity(value: &str, field: &'static str) -> Result<(), RecoveryError> {
    if value.is_empty() || value.len() > 1024 || value.contains('\0') {
        Err(RecoveryError::InvalidInput(field))
    } else {
        Ok(())
    }
}

fn validate_path(value: &str) -> Result<(), RecoveryError> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || value.contains('\\')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        Err(RecoveryError::InvalidInput("historical path"))
    } else {
        Ok(())
    }
}

fn validate_time(now_ms: i64) -> Result<(), RecoveryError> {
    if now_ms < 0 {
        Err(RecoveryError::InvalidInput("timestamp"))
    } else {
        Ok(())
    }
}

fn read_info(row: &rusqlite::Row<'_>, max_bytes: usize) -> Result<SnapshotInfo, RecoveryError> {
    let byte_length: i64 = row.get(5)?;
    let info = SnapshotInfo {
        id: row.get(0)?,
        entry_id: row.get(1)?,
        historical_path: row.get(2)?,
        captured_at_ms: row.get(3)?,
        byte_length: usize::try_from(byte_length).map_err(|_| RecoveryError::CorruptRecord)?,
        provenance: SnapshotProvenance::parse(&row.get::<_, String>(4)?)?,
    };
    if info.id <= 0
        || info.captured_at_ms < 0
        || info.byte_length > max_bytes
        || validate_identity(&info.entry_id, "entry identity").is_err()
        || validate_path(&info.historical_path).is_err()
    {
        return Err(RecoveryError::CorruptRecord);
    }
    Ok(info)
}

fn read_latest(
    connection: &Connection,
    entry_id: &str,
    max_bytes: usize,
) -> Result<Option<Snapshot>, RecoveryError> {
    read_snapshot(connection, "entry_id = ?1", entry_id, max_bytes)
}

fn read_snapshot<P: rusqlite::ToSql>(
    connection: &Connection,
    predicate: &str,
    value: P,
    max_bytes: usize,
) -> Result<Option<Snapshot>, RecoveryError> {
    // Predicate is exclusively one of the two private static strings above.
    let mut statement = connection.prepare(&format!(
        "SELECT id, entry_id, historical_path, captured_at_ms, provenance, length(content),
         content_hash, content FROM snapshots WHERE {predicate}
         ORDER BY captured_at_ms DESC, id DESC LIMIT 1"
    ))?;
    let mut rows = statement.query([value])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let info = read_info(row, max_bytes)?;
    let hash: Vec<u8> = row.get(6)?;
    let content: Vec<u8> = row.get(7)?;
    if hash.as_slice() != Sha256::digest(&content).as_slice() || content.len() != info.byte_length {
        return Err(RecoveryError::CorruptRecord);
    }
    Ok(Some(Snapshot { info, content }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "zorid-recovery-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&directory).unwrap();
            // macOS exposes its temporary directory through /var -> /private/var.
            // Preserve production NOFOLLOW guarantees; fixtures use real parents.
            Self(directory.canonicalize().unwrap())
        }
        fn path(&self) -> PathBuf {
            self.0.join("recovery.sqlite")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scope() -> RecoveryScope {
        RecoveryScope {
            vault_id: "vault-1".into(),
            replica_id: "desktop-1".into(),
        }
    }
    fn input(content: &[u8], provenance: SnapshotProvenance) -> SnapshotInput<'_> {
        SnapshotInput {
            entry_id: "entry-1",
            historical_path: "folder/note.md",
            content,
            provenance,
        }
    }
    fn captured(outcome: CaptureOutcome) -> SnapshotInfo {
        match outcome {
            CaptureOutcome::Captured(info) => info,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn exact_bytes_identity_path_and_provenance_survive_reopen() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        let info = captured(
            store
                .capture(input(b"a\0b\r\n", SnapshotProvenance::SaveFailure), 1)
                .unwrap(),
        );
        drop(store);
        let store = RecoveryStore::open(fixture.path(), &scope(), 2).unwrap();
        assert_eq!(
            store.read(info.id).unwrap(),
            Some(Snapshot {
                info: info.clone(),
                content: b"a\0b\r\n".to_vec()
            })
        );
        assert_eq!(store.list("entry-1", None, 10).unwrap(), [info]);
        assert_eq!(store.read(999).unwrap(), None);
    }

    #[test]
    fn cadence_force_and_latest_content_deduplication() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        captured(
            store
                .capture(input(b"a", SnapshotProvenance::Periodic), 0)
                .unwrap(),
        );
        assert_eq!(
            store
                .capture(input(b"b", SnapshotProvenance::Periodic), 1)
                .unwrap(),
            CaptureOutcome::IntervalNotElapsed
        );
        captured(
            store
                .capture(input(b"b", SnapshotProvenance::SaveFailure), 1)
                .unwrap(),
        );
        assert_eq!(
            store
                .capture(input(b"b", SnapshotProvenance::SaveFailure), 2)
                .unwrap(),
            CaptureOutcome::Unchanged
        );
        assert_eq!(
            store
                .capture(
                    input(b"b", SnapshotProvenance::Periodic),
                    DEFAULT_INTERVAL_MS + 1
                )
                .unwrap(),
            CaptureOutcome::Unchanged
        );
        captured(
            store
                .capture(
                    input(b"a", SnapshotProvenance::Periodic),
                    DEFAULT_INTERVAL_MS + 1,
                )
                .unwrap(),
        );
        assert_eq!(store.list("entry-1", None, 10).unwrap().len(), 3);
    }

    #[test]
    fn expiry_runs_on_open_and_writes_with_exact_retention_boundary() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        let old = captured(
            store
                .capture(input(b"old", SnapshotProvenance::Periodic), 0)
                .unwrap(),
        );
        let boundary = captured(
            store
                .capture(input(b"boundary", SnapshotProvenance::SaveFailure), 1)
                .unwrap(),
        );
        drop(store);
        let mut store =
            RecoveryStore::open(fixture.path(), &scope(), DEFAULT_RETENTION_MS + 1).unwrap();
        assert_eq!(store.read(old.id).unwrap(), None);
        assert!(store.read(boundary.id).unwrap().is_some());
        captured(
            store
                .capture(
                    input(b"new", SnapshotProvenance::Periodic),
                    DEFAULT_RETENTION_MS + 2,
                )
                .unwrap(),
        );
        assert_eq!(store.read(boundary.id).unwrap(), None);
        assert_eq!(store.prune(DEFAULT_RETENTION_MS * 2 + 3).unwrap(), 1);
    }

    #[test]
    fn failed_capture_rolls_back_expiry_and_preserves_existing_versions() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        let info = captured(
            store
                .capture(input(b"keep", SnapshotProvenance::Periodic), 0)
                .unwrap(),
        );
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_capture BEFORE INSERT ON snapshots
            BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            )
            .unwrap();
        assert!(store
            .capture(
                input(b"fail", SnapshotProvenance::Periodic),
                DEFAULT_RETENTION_MS + 1
            )
            .is_err());
        assert_eq!(store.read(info.id).unwrap().unwrap().content, b"keep");
    }

    #[test]
    fn wrong_vault_or_replica_cannot_open_or_prune_an_existing_store() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        let info = captured(
            store
                .capture(input(b"keep", SnapshotProvenance::Periodic), 0)
                .unwrap(),
        );
        drop(store);
        for wrong in [
            RecoveryScope {
                vault_id: "wrong".into(),
                ..scope()
            },
            RecoveryScope {
                replica_id: "wrong".into(),
                ..scope()
            },
        ] {
            assert!(matches!(
                RecoveryStore::open(fixture.path(), &wrong, DEFAULT_RETENTION_MS + 1),
                Err(RecoveryError::WrongScope)
            ));
        }
        let store = RecoveryStore::open(fixture.path(), &scope(), 1).unwrap();
        assert!(store.read(info.id).unwrap().is_some());
    }

    #[test]
    fn corruption_never_returns_unverified_content_or_replaces_history() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        let info = captured(
            store
                .capture(input(b"good", SnapshotProvenance::Periodic), 0)
                .unwrap(),
        );
        store
            .connection
            .execute(
                "UPDATE snapshots SET content = ?1 WHERE id = ?2",
                params![b"evil".as_slice(), info.id],
            )
            .unwrap();
        assert!(matches!(
            store.read(info.id),
            Err(RecoveryError::CorruptRecord)
        ));
        assert!(matches!(
            store.capture(input(b"next", SnapshotProvenance::SaveFailure), 1),
            Err(RecoveryError::CorruptRecord)
        ));
        assert_eq!(store.list("entry-1", None, 10).unwrap().len(), 1);
        store
            .connection
            .execute_batch(
                "PRAGMA ignore_check_constraints = ON;
            UPDATE snapshots SET historical_path = '../escape.md';",
            )
            .unwrap();
        assert!(matches!(
            store.list("entry-1", None, 10),
            Err(RecoveryError::CorruptRecord)
        ));
    }

    #[test]
    fn metadata_rejects_negative_timestamps_and_unknown_provenance() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        let info = captured(
            store
                .capture(input(b"good", SnapshotProvenance::Periodic), 0)
                .unwrap(),
        );
        store
            .connection
            .execute_batch(
                "PRAGMA ignore_check_constraints = ON;
            UPDATE snapshots SET provenance = 'unknown';",
            )
            .unwrap();
        assert!(matches!(
            store.read(info.id),
            Err(RecoveryError::CorruptRecord)
        ));
        store
            .connection
            .execute_batch("UPDATE snapshots SET provenance = 'periodic', captured_at_ms = -1;")
            .unwrap();
        assert!(matches!(
            store.list("entry-1", None, 10),
            Err(RecoveryError::CorruptRecord)
        ));
    }

    #[test]
    fn pagination_is_bounded_stable_and_separate_by_entry() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        let first = captured(
            store
                .capture(input(b"a", SnapshotProvenance::SaveFailure), 0)
                .unwrap(),
        );
        let second = captured(
            store
                .capture(input(b"b", SnapshotProvenance::SaveFailure), 0)
                .unwrap(),
        );
        captured(
            store
                .capture(
                    SnapshotInput {
                        entry_id: "entry-2",
                        ..input(b"other", SnapshotProvenance::Periodic)
                    },
                    1,
                )
                .unwrap(),
        );
        assert_eq!(store.list("entry-1", None, 1).unwrap(), [second.clone()]);
        assert_eq!(
            store
                .list(
                    "entry-1",
                    Some(SnapshotCursor {
                        captured_at_ms: second.captured_at_ms,
                        id: second.id
                    }),
                    1
                )
                .unwrap(),
            [first]
        );
        assert!(store.list("entry-1", None, 0).is_err());
        assert!(store.list("entry-1", None, MAX_LIST_LIMIT + 1).is_err());
    }

    #[test]
    fn invalid_input_and_oversized_content_do_not_modify_existing_data() {
        let fixture = Fixture::new();
        let mut store = RecoveryStore::open_with_policy(
            fixture.path(),
            &scope(),
            RecoveryPolicy {
                max_snapshot_bytes: 4,
                ..RecoveryPolicy::default()
            },
            0,
        )
        .unwrap();
        captured(
            store
                .capture(input(b"keep", SnapshotProvenance::Periodic), 0)
                .unwrap(),
        );
        assert!(matches!(
            store.capture(input(b"large", SnapshotProvenance::SaveFailure), 1),
            Err(RecoveryError::SnapshotTooLarge)
        ));
        assert!(store
            .capture(
                SnapshotInput {
                    historical_path: "/outside",
                    ..input(b"x", SnapshotProvenance::SaveFailure)
                },
                1
            )
            .is_err());
        assert!(store
            .capture(input(b"x", SnapshotProvenance::SaveFailure), -1)
            .is_err());
        assert_eq!(store.list("entry-1", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn unrecognized_database_is_never_initialized_or_reset() {
        let fixture = Fixture::new();
        let connection = Connection::open(fixture.path()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep');",
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            RecoveryStore::open(fixture.path(), &scope(), 0),
            Err(RecoveryError::UnsupportedSchema)
        ));
        let connection = Connection::open(fixture.path()).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT value FROM unrelated", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
    }

    fn assert_schema_rejected_without_mutation(fixture: &Fixture) {
        let connection = Connection::open(fixture.path()).unwrap();
        connection
            .pragma_update(None, "journal_mode", "DELETE")
            .unwrap();
        let before_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        drop(connection);
        let before = std::fs::read(fixture.path()).unwrap();
        assert!(matches!(
            RecoveryStore::open(fixture.path(), &scope(), DEFAULT_RETENTION_MS * 2),
            Err(RecoveryError::UnsupportedSchema)
        ));
        assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
        let connection = Connection::open(fixture.path()).unwrap();
        let after_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(before_mode, after_mode);
    }

    #[test]
    fn foreign_empty_headers_and_view_only_databases_are_not_adopted() {
        for sql in [
            "PRAGMA application_id=42;",
            "PRAGMA user_version=99;",
            "CREATE VIEW unrelated AS SELECT 42 AS value;",
        ] {
            let fixture = Fixture::new();
            let connection = Connection::open(fixture.path()).unwrap();
            connection.execute_batch(sql).unwrap();
            drop(connection);
            assert_schema_rejected_without_mutation(&fixture);
        }
    }

    #[test]
    fn malformed_or_augmented_registered_schema_is_rejected_before_pruning() {
        for sql in [
            "PRAGMA application_id=42;",
            "PRAGMA user_version=99;",
            // Preliminary unmarked development formats are explicitly unsupported.
            "PRAGMA application_id=0; PRAGMA user_version=0;",
            "DROP INDEX snapshots_expiry;",
            "DROP INDEX snapshots_expiry; CREATE INDEX snapshots_expiry ON snapshots(entry_id);",
            "ALTER TABLE snapshots ADD COLUMN unexpected TEXT;",
            "CREATE VIEW unrelated AS SELECT 42 AS value;",
            "CREATE TABLE sqliteXuser(value);",
            "CREATE TRIGGER unexpected BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'unexpected trigger'); END;",
            // Trigger names occupy a separate namespace from table/index names.
            "CREATE TRIGGER snapshots BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'duplicate name'); END;",
        ] {
            let fixture = Fixture::new();
            let mut store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
            let info = captured(store.capture(input(b"keep", SnapshotProvenance::Periodic), 0).unwrap());
            store.connection.execute_batch(sql).unwrap();
            drop(store);
            assert_schema_rejected_without_mutation(&fixture);
            // The expired row must survive rejection, even with a hostile trigger.
            let connection = Connection::open(fixture.path()).unwrap();
            assert_eq!(
                connection.query_row("SELECT content FROM snapshots WHERE id=?1", [info.id], |row| row.get::<_, Vec<u8>>(0)).unwrap(),
                b"keep"
            );
        }
    }

    #[test]
    fn corrupt_scope_or_future_schema_is_rejected() {
        let fixture = Fixture::new();
        let store = RecoveryStore::open(fixture.path(), &scope(), 0).unwrap();
        store
            .connection
            .execute("UPDATE recovery_scope SET schema_version = 99", [])
            .unwrap();
        drop(store);
        assert!(matches!(
            RecoveryStore::open(fixture.path(), &scope(), 0),
            Err(RecoveryError::UnsupportedSchema)
        ));
    }
}
