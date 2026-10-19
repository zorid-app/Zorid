//! Separate disposable database. No authoritative write depends on this connection.
use crate::document_index::{DocumentIndexError, IndexResult, SCHEMA};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::{ops::Deref, path::Path};
use zorid_core::OperationId;
use zorid_sqlite::{open_checked, OpenMode};

const APPLICATION_ID: i64 = 0x5a434143; // ZCAC
const VERSION: i64 = 1;
const SCOPE_SQL: &str = "CREATE TABLE document_cache_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), local_store_id TEXT NOT NULL)";

pub(crate) struct DocumentCache {
    pub(super) connection: Connection,
}

impl DocumentCache {
    pub(crate) fn memory() -> rusqlite::Result<Self> {
        let connection = open_checked(":memory:", OpenMode::Create, |_| {
            Ok::<_, rusqlite::Error>(())
        })?;
        Ok(Self { connection })
    }

    pub(crate) fn open(path: &Path, local: &OperationId) -> IndexResult<Self> {
        let mut connection = open_checked(path, OpenMode::CreateNoFollow, |connection| {
            validate(connection, local).map(|_| ())
        })?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !validate(&tx, local)? {
            initialize_scope(&tx, local)?;
        }
        tx.commit()?;
        Ok(Self { connection })
    }
}

pub(crate) fn initialize_scope(
    connection: &Connection,
    local: &OperationId,
) -> rusqlite::Result<()> {
    connection.execute_batch(SCOPE_SQL)?;
    connection.execute(
        "INSERT INTO document_cache_scope VALUES(1,?1)",
        [local.as_str()],
    )?;
    connection.pragma_update(None, "application_id", APPLICATION_ID)?;
    connection.pragma_update(None, "user_version", VERSION)?;
    Ok(())
}

/// Validate exact registered SQL before changing journal mode or clearing cache.
/// Partial known cache tables may be explicitly rebuilt; unknown SQL is rejected.
pub(crate) fn validate(connection: &Connection, local: &OperationId) -> IndexResult<bool> {
    let application: i64 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let objects = connection
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if application == 0 && version == 0 && objects.is_empty() {
        return Ok(false);
    }
    let normalize = |sql: &str| sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if application != APPLICATION_ID
        || version != VERSION
        || objects.len() > SCHEMA.len() + crate::document_parse_cache::SCHEMA.len() + 1
        || !objects.iter().any(|(kind, name, sql)| {
            kind == "table"
                && name == "document_cache_scope"
                && normalize(sql) == normalize(SCOPE_SQL)
        })
        || objects.iter().any(|(kind, name, sql)| {
            kind != "table"
                || !std::iter::once(("document_cache_scope", SCOPE_SQL))
                    .chain(SCHEMA.iter().copied())
                    .chain(crate::document_parse_cache::SCHEMA.iter().copied())
                    .any(|(expected, registered)| {
                        name == expected && normalize(sql) == normalize(registered)
                    })
        })
    {
        return Err(DocumentIndexError::RebuildRequired);
    }
    let count: i64 =
        connection.query_row("SELECT count(*) FROM document_cache_scope", [], |r| {
            r.get(0)
        })?;
    let scope: Option<String> = connection
        .query_row(
            "SELECT local_store_id FROM document_cache_scope WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if count != 1 || scope.as_deref() != Some(local.as_str()) {
        return Err(DocumentIndexError::RebuildRequired);
    }
    Ok(true)
}

/// Fixed lock order: cache first, authority second. Cache contention must never
/// reserve authority while waiting. IMMEDIATE then reserves authority without
/// writing it, so source/head checks remain true through cache commit.
/// Crash atomicity across files is unnecessary: only the cache is ever changed.
pub(crate) struct DocumentTransaction<'a> {
    pub(crate) authority: Transaction<'a>,
    cache: Transaction<'a>,
}
impl<'a> DocumentTransaction<'a> {
    pub(crate) fn new(
        authority: &'a Connection,
        cache: &'a DocumentCache,
        behavior: TransactionBehavior,
    ) -> IndexResult<Self> {
        let cache = Transaction::new_unchecked(&cache.connection, behavior)?;
        // BEGIN DEFERRED is lazy: establish the cache snapshot before any
        // authority read. A coherent cache may lag observed source, never lead it.
        cache.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })?;
        let authority = Transaction::new_unchecked(authority, behavior)?;
        Ok(Self { authority, cache })
    }
    pub(crate) fn commit(self) -> IndexResult<()> {
        self.cache.commit()?;
        self.authority.commit()?;
        Ok(())
    }
}
impl Deref for DocumentTransaction<'_> {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        &self.cache
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::{Duration, Instant},
    };
    use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, VaultPath};

    static CACHE_WAITING: AtomicBool = AtomicBool::new(false);
    fn report_cache_wait(attempt: i32) -> bool {
        CACHE_WAITING.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(5));
        attempt < 1000
    }
    fn create(name: &str) -> MutationRequest {
        MutationRequest {
            operation_id: OperationId::new(name).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(name).unwrap(),
                path: VaultPath::new(format!("{name}.md")).unwrap(),
                kind: EntryKind::File,
                content: Some(b"saved".to_vec()),
            },
        }
    }

    #[test]
    fn indexing_waiting_for_cache_never_reserves_authority_against_saves() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("vault.sqlite");
        let cache = root.join("cache.sqlite");
        let mut saver = Store::open(&path).unwrap();
        saver.enable_document_cache(&cache).unwrap();
        saver.initialize_document_index().unwrap();
        let mut indexer = Store::open(&path).unwrap();
        indexer.enable_document_cache(&cache).unwrap();
        indexer
            .document_cache
            .connection
            .busy_handler(Some(report_cache_wait))
            .unwrap();
        saver
            .connection
            .busy_timeout(Duration::from_millis(100))
            .unwrap();
        let blocker = Connection::open(&cache).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        CACHE_WAITING.store(false, Ordering::SeqCst);
        let indexing = std::thread::spawn(move || indexer.begin_document_index());
        let started = Instant::now();
        while !CACHE_WAITING.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let observed_wait = CACHE_WAITING.load(Ordering::SeqCst);
        let saved = saver.apply(&create("save-during-cache-contention"));
        blocker.execute_batch("ROLLBACK").unwrap();
        indexing.join().unwrap().unwrap();
        assert!(
            observed_wait,
            "indexer must actually be waiting for the cache reservation"
        );
        assert!(
            saved.is_ok(),
            "cache contention blocked an authoritative save: {saved:?}"
        );
    }
}
