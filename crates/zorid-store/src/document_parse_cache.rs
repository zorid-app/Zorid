//! Optional identity-free facts in the app-local disposable database. Every IO
//! transaction ends before pure binding/extraction or generation publication.
use crate::{
    document_cache::{self, DocumentCache},
    Sha256Digest,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use zorid_index::{
    extract_content, parse_cache_admission, ContentExtractionKey, ContentExtractionOutcome,
    ContentExtractionResult, EntryWitness, ExtractionDomain, ExtractionMode, ExtractionScope,
    IndexError, IndexRecord, MetadataRequest, ParseCacheAdmission, ParseCacheOutcome,
    ParseCacheUsage, MAX_PARSE_CACHE_ROW_BYTES,
};

// Kept separate from document_index::SCHEMA: that registry also recognizes old
// optional tables in AUTHORITATIVE databases, where these tables never belong.
pub(crate) const SCHEMA: &[(&str, &str)] = &[
    ("document_parse_cache_rows", "CREATE TABLE document_parse_cache_rows (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, storage_key TEXT NOT NULL UNIQUE, payload_bytes INTEGER NOT NULL, record BLOB NOT NULL)"),
    ("document_parse_cache_usage", "CREATE TABLE document_parse_cache_usage (singleton INTEGER PRIMARY KEY CHECK(singleton=1), record TEXT NOT NULL)"),
];
const MAX_USAGE_BYTES: i64 = 1024;

#[derive(Clone, Copy, Debug)]
enum CacheError {
    Corrupt,
    Unavailable,
}
type CacheResult<T> = std::result::Result<T, CacheError>;
impl From<rusqlite::Error> for CacheError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::InvalidColumnType(..)
            | rusqlite::Error::FromSqlConversionFailure(..)
            | rusqlite::Error::IntegralValueOutOfRange(..) => Self::Corrupt,
            _ => Self::Unavailable,
        }
    }
}
fn corruption<T>(_: T) -> CacheError {
    CacheError::Corrupt
}

// Only this private optional operation changes the timeout. Store owns the
// connection; no authority transaction or concurrent caller is held here.
struct RestoreTimeout<'a>(&'a Connection, u64);
impl Drop for RestoreTimeout<'_> {
    fn drop(&mut self) {
        let _ = self.0.busy_timeout(Duration::from_millis(self.1));
    }
}
fn short_access<T>(
    cache: &DocumentCache,
    action: impl FnOnce(&Connection) -> CacheResult<T>,
) -> CacheResult<T> {
    let connection = &cache.connection;
    let timeout: i64 = connection.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
    let timeout = u64::try_from(timeout).map_err(corruption)?;
    connection.busy_timeout(Duration::ZERO)?;
    let _restore = RestoreTimeout(connection, timeout);
    action(connection)
}
fn schema_count(tx: &Connection, scope: &ExtractionScope) -> CacheResult<usize> {
    match document_cache::validate(tx, scope.local_store_id()) {
        Ok(true) => {}
        Ok(false) => return Err(CacheError::Unavailable),
        Err(crate::DocumentIndexError::RebuildRequired) => return Err(CacheError::Corrupt),
        Err(_) => return Err(CacheError::Unavailable),
    }
    let count: i64 = tx.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('document_parse_cache_rows','document_parse_cache_usage')", [], |row| row.get(0))?;
    usize::try_from(count).map_err(corruption)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageRecord {
    scope: ExtractionScope,
    usage: ParseCacheUsage,
    digest: Sha256Digest,
}
fn encode_usage(scope: &ExtractionScope, usage: ParseCacheUsage) -> CacheResult<String> {
    let bytes = serde_json::to_vec(&(scope, usage)).map_err(corruption)?;
    serde_json::to_string(&UsageRecord {
        scope: scope.clone(),
        usage,
        digest: Sha256Digest::of(&bytes),
    })
    .map_err(corruption)
}
fn read_usage(tx: &Connection, scope: &ExtractionScope) -> CacheResult<ParseCacheUsage> {
    let length: Option<i64> = tx
        .query_row(
            "SELECT length(CAST(record AS BLOB)) FROM document_parse_cache_usage WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if !length.is_some_and(|n| (1..=MAX_USAGE_BYTES).contains(&n)) {
        return Err(CacheError::Corrupt);
    }
    let raw: String = tx.query_row(
        "SELECT record FROM document_parse_cache_usage WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    let record: UsageRecord = serde_json::from_str(&raw).map_err(corruption)?;
    let canonical = serde_json::to_vec(&(&record.scope, record.usage)).map_err(corruption)?;
    if &record.scope != scope || Sha256Digest::of(&canonical) != record.digest {
        return Err(CacheError::Corrupt);
    }
    parse_cache_admission(record.usage, None, 1, 0).map_err(corruption)?;
    Ok(record.usage)
}
fn row_size(tx: &Connection, locator: &str) -> CacheResult<Option<usize>> {
    let row: Option<(i64,i64,i64)> = tx.query_row("SELECT ordinal,payload_bytes,length(CAST(record AS BLOB)) FROM document_parse_cache_rows WHERE storage_key=?1", [locator], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
    row.map(|(ordinal, bytes, actual)| {
        if ordinal <= 0
            || !(1..=MAX_PARSE_CACHE_ROW_BYTES as i64).contains(&bytes)
            || bytes != actual
        {
            return Err(CacheError::Corrupt);
        }
        Ok(bytes as usize)
    })
    .transpose()
}
fn read_payload(
    cache: &DocumentCache,
    key: &ContentExtractionKey,
    locator: &str,
) -> CacheResult<Option<Vec<u8>>> {
    short_access(cache, |connection| {
        let tx = Transaction::new_unchecked(connection, TransactionBehavior::Deferred)?;
        match schema_count(&tx, key.scope())? {
            0 => {
                tx.commit()?;
                return Ok(None);
            }
            n if n == SCHEMA.len() => {}
            _ => return Err(CacheError::Corrupt),
        }
        let usage = read_usage(&tx, key.scope())?;
        let Some(bytes) = row_size(&tx, locator)? else {
            tx.commit()?;
            return Ok(None);
        };
        parse_cache_admission(usage, Some(bytes), 1, 0).map_err(corruption)?;
        // Preflight above bounds the allocation; record remains its original SQL
        // value/type, so corrupt values are never coerced into a valid payload.
        let raw: Vec<u8> = tx.query_row(
            "SELECT record FROM document_parse_cache_rows WHERE storage_key=?1",
            [locator],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(Some(raw))
    })
}
pub(crate) fn lookup(
    cache: &DocumentCache,
    key: &ContentExtractionKey,
    witness: EntryWitness,
    mode: ExtractionMode,
) -> (ParseCacheOutcome, Option<IndexRecord>) {
    let Ok(locator) = key.storage_key() else {
        return (ParseCacheOutcome::Unsupported, None);
    };
    let raw = match read_payload(cache, key, &locator) {
        Ok(Some(raw)) => raw,
        Ok(None) => return (ParseCacheOutcome::Miss, None),
        Err(CacheError::Corrupt) => return (ParseCacheOutcome::Corrupt, None),
        Err(CacheError::Unavailable) => return (ParseCacheOutcome::Unavailable, None),
    };
    // No SQLite transaction is held during untrusted decoding, checksum/range
    // checks, or binding to the independently captured current witness.
    let Ok(result) = serde_json::from_slice::<ContentExtractionResult>(&raw) else {
        return (ParseCacheOutcome::Corrupt, None);
    };
    if let Err(error) = result.key().storage_key() {
        return (
            if error == IndexError::InvalidVersion {
                ParseCacheOutcome::Unsupported
            } else {
                ParseCacheOutcome::Corrupt
            },
            None,
        );
    }
    match result.bind(key, witness, mode) {
        Ok(record) => (ParseCacheOutcome::Hit, Some(record)),
        Err(IndexError::InvalidVersion) => (ParseCacheOutcome::Unsupported, None),
        Err(_) => (ParseCacheOutcome::Corrupt, None),
    }
}
/// Native extraction/rebinding over independently captured committed source.
/// Cache failures fall back to the same pure engine; no authority connection is
/// accepted here and no final generation fence is replaced by a content hit.
pub(crate) fn extract(
    cache: &DocumentCache,
    witness: EntryWitness,
    request: &MetadataRequest,
    mode: ExtractionMode,
) -> Result<(IndexRecord, Option<ParseCacheOutcome>), IndexError> {
    if request.entry_id != witness.entry().id
        || request.content_revision != witness.entry().revision
    {
        return Err(IndexError::StaleSource);
    }
    let scope = ExtractionScope::new(
        ExtractionDomain::DocumentIndex,
        witness.source().local_store_id().clone(),
    );
    let key = match ContentExtractionKey::for_source(scope.clone(), mode, &request.source) {
        Ok(key) => key,
        Err(IndexError::InvalidRecord) => {
            return IndexRecord::text(witness, request, mode == ExtractionMode::Markdown)
                .map(|record| (record, None))
        }
        Err(error) => return Err(error),
    };
    let (outcome, cached) = lookup(cache, &key, witness.clone(), mode);
    if let Some(record) = cached {
        return Ok((record, Some(outcome)));
    }
    let record = match extract_content(scope, mode, &request.source)? {
        ContentExtractionOutcome::Extracted(result) => {
            let fact = prepare(&result);
            let record = result.bind(&key, witness, mode)?;
            if let Some(fact) = fact {
                write(cache, fact);
            }
            record
        }
        ContentExtractionOutcome::Excluded(reason) => IndexRecord::excluded(witness, reason),
    };
    Ok((record, Some(outcome)))
}

pub(crate) struct PreparedFact {
    scope: ExtractionScope,
    locator: String,
    payload: Vec<u8>,
}
pub(crate) fn prepare(result: &ContentExtractionResult) -> Option<PreparedFact> {
    // Count by streaming before allocating a Vec. Larger supported facts stay
    // ordinary index records; optional cache eligibility adds no semantic limit.
    let bytes = result.encoded_size().ok()?;
    if bytes == 0 || bytes > MAX_PARSE_CACHE_ROW_BYTES {
        return None;
    }
    let locator = result.key().storage_key().ok()?;
    let payload = serde_json::to_vec(result).ok()?;
    if payload.len() != bytes {
        return None;
    }
    Some(PreparedFact {
        scope: result.key().scope().clone(),
        locator,
        payload,
    })
}
/// Best effort only. Content facts have no entry/publication authority; retaining
/// them after source advances is safe. The caller still fences final generation
/// publication separately, after this standalone cache transaction has closed.
pub(crate) fn write(cache: &DocumentCache, fact: PreparedFact) {
    let _ = short_access(cache, |connection| {
        let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
        match schema_count(&tx, &fact.scope)? {
            0 => {
                for (_, sql) in SCHEMA {
                    tx.execute_batch(sql)?;
                }
                tx.execute(
                    "INSERT INTO document_parse_cache_usage VALUES(1,?1)",
                    [encode_usage(
                        &fact.scope,
                        ParseCacheUsage { rows: 0, bytes: 0 },
                    )?],
                )?;
            }
            n if n == SCHEMA.len() => {}
            _ => return Err(CacheError::Corrupt),
        }
        let mut usage = read_usage(&tx, &fact.scope)?;
        let replaced = row_size(&tx, &fact.locator)?;
        let mut evicted = 0;
        loop {
            match parse_cache_admission(usage, replaced, fact.payload.len(), evicted)
                .map_err(corruption)?
            {
                ParseCacheAdmission::SkipOversized | ParseCacheAdmission::SkipEvictionLimit => {
                    return Ok(())
                }
                ParseCacheAdmission::Write => break,
                ParseCacheAdmission::EvictOldest => {
                    // Do not fetch an untrusted locator as a Rust String. CASE
                    // bounds SQL shape validation; deletion uses only rowid.
                    let victim: Option<(i64, i64, i64, bool)> = tx.query_row(
                        "SELECT ordinal,payload_bytes,length(CAST(record AS BLOB)),CASE WHEN typeof(storage_key)='text' AND length(CAST(storage_key AS BLOB))=64 AND length(storage_key)=64 THEN storage_key NOT GLOB '*[^0-9a-f]*' ELSE 0 END FROM document_parse_cache_rows NOT INDEXED WHERE storage_key<>?1 ORDER BY ordinal LIMIT 1",
                        [&fact.locator],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    ).optional()?;
                    let Some((ordinal, bytes, actual, key_valid)) = victim else {
                        return Err(CacheError::Corrupt);
                    };
                    if ordinal <= 0
                        || !key_valid
                        || bytes != actual
                        || !(1..=MAX_PARSE_CACHE_ROW_BYTES as i64).contains(&bytes)
                    {
                        return Err(CacheError::Corrupt);
                    }
                    usage.rows = usage.rows.checked_sub(1).ok_or(CacheError::Corrupt)?;
                    usage.bytes = usage
                        .bytes
                        .checked_sub(bytes as usize)
                        .ok_or(CacheError::Corrupt)?;
                    let deleted = tx.execute(
                        "DELETE FROM document_parse_cache_rows WHERE ordinal=?1 AND storage_key<>?2",
                        params![ordinal, &fact.locator],
                    )?;
                    if deleted != 1 {
                        return Err(CacheError::Corrupt);
                    }
                    evicted += 1;
                }
            }
        }
        if replaced.is_some() {
            tx.execute("UPDATE document_parse_cache_rows SET payload_bytes=?1,record=?2 WHERE storage_key=?3", params![fact.payload.len() as i64, fact.payload, fact.locator])?;
        } else {
            tx.execute("INSERT INTO document_parse_cache_rows(storage_key,payload_bytes,record) VALUES(?1,?2,?3)", params![fact.locator, fact.payload.len() as i64, fact.payload])?;
        }
        usage.rows = usage
            .rows
            .checked_add(usize::from(replaced.is_none()))
            .ok_or(CacheError::Corrupt)?;
        usage.bytes = usage
            .bytes
            .checked_sub(replaced.unwrap_or(0))
            .and_then(|n| n.checked_add(fact.payload.len()))
            .ok_or(CacheError::Corrupt)?;
        tx.execute(
            "UPDATE document_parse_cache_usage SET record=?1 WHERE singleton=1",
            [encode_usage(&fact.scope, usage)?],
        )?;
        tx.commit()?;
        Ok(())
    });
}

#[cfg(test)]
#[path = "document_parse_cache_tests.rs"]
mod tests;
