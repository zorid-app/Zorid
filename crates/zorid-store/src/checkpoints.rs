//! Recovery-critical local state, deliberately separate from operations/outbox.
//! Caller scopes are trusted-host identities, not an authorization mechanism.
use super::{Store, StoreError};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fmt;
use zorid_core::OperationId;

pub const MAX_CHECKPOINT_BYTES: usize = 32 * 1024 * 1024;
const MAX_KEY_BYTES: usize = 1024;
const MAX_PAGE: u32 = 1000;
const MAX_CURSOR_BYTES: usize = 2048;
pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("checkpoint_revisions", "CREATE TABLE checkpoint_revisions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, checkpoint_key TEXT NOT NULL, revision TEXT NOT NULL, expected_revision TEXT, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), state_bytes INTEGER NOT NULL CHECK(state_bytes>=0 AND state_bytes<=33554432), UNIQUE(client_id,revision))"),
    ("checkpoint_key_history", "CREATE INDEX checkpoint_key_history ON checkpoint_revisions(client_id,checkpoint_key,sequence)"),
    ("checkpoint_client_history", "CREATE INDEX checkpoint_client_history ON checkpoint_revisions(client_id,sequence)"),
    ("checkpoint_heads", "CREATE TABLE checkpoint_heads (client_id TEXT NOT NULL, checkpoint_key TEXT NOT NULL, revision TEXT NOT NULL, encoded_state TEXT, PRIMARY KEY(client_id,checkpoint_key), FOREIGN KEY(client_id,revision) REFERENCES checkpoint_revisions(client_id,revision))"),
];
pub(super) fn migrate(tx: &Connection) -> super::Result<()> {
    for (_, sql) in SCHEMA {
        tx.execute_batch(sql)?;
    }
    Ok(())
}

#[derive(Debug)]
pub enum CheckpointError {
    Store(StoreError),
    ExternalStorage(std::io::Error),
    Conflict,
    Invalid,
    Limit,
    ScopeMismatch,
}
impl fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Store(_) | Self::ExternalStorage(_) => "Checkpoint storage failed",
            Self::Conflict => "Checkpoint revision conflict",
            Self::Invalid => "Invalid checkpoint request",
            Self::Limit => "Checkpoint bound exceeded",
            Self::ScopeMismatch => "Checkpoint authority mismatch",
        })
    }
}
impl std::error::Error for CheckpointError {}
impl From<StoreError> for CheckpointError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}
impl From<rusqlite::Error> for CheckpointError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Store(value.into())
    }
}
type Result<T> = std::result::Result<T, CheckpointError>;
fn corrupt() -> CheckpointError {
    StoreError::Corrupt("inconsistent checkpoint storage".into()).into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointScope {
    pub vault_id: OperationId,
    pub client_id: OperationId,
}
/// Borrowed payload: transports must check their raw byte framing limit before
/// allocation, then validate UTF-8. Rust str excludes malformed UTF-8/UTF-16.
pub struct CheckpointWrite<'a> {
    pub key: &'a str,
    pub expected_revision: Option<&'a str>,
    pub next_revision: &'a str,
    pub encoded_state: Option<&'a str>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub version: u8,
    pub vault_id: OperationId,
    pub client_id: OperationId,
    pub key: String,
    pub revision: String,
    pub sequence: String,
    pub deleted: bool,
    pub byte_length: u32,
    pub encoded_state: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointMetadata {
    pub version: u8,
    pub vault_id: OperationId,
    pub client_id: OperationId,
    pub key: String,
    pub revision: String,
    pub sequence: String,
    pub deleted: bool,
    pub byte_length: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointPage {
    pub items: Vec<CheckpointMetadata>,
    pub cursor: Option<String>,
    pub high_water: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PageKind {
    List,
    Changes,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: CheckpointScope,
    kind: PageKind,
    after: String,
    high_water: String,
    position: String,
}
fn valid_key(key: &str) -> Result<()> {
    if key.len() > MAX_KEY_BYTES {
        return Err(CheckpointError::Limit);
    }
    if key.is_empty() || key.contains('\0') {
        return Err(CheckpointError::Invalid);
    }
    Ok(())
}
fn valid_revision(revision: &str) -> Result<()> {
    // Canonical spelling prevents alternate spellings bypassing retained fences.
    if revision.len() != 36
        || uuid::Uuid::parse_str(revision)
            .ok()
            .is_none_or(|id| id.hyphenated().to_string() != revision)
    {
        return Err(CheckpointError::Invalid);
    }
    Ok(())
}
fn number(value: &str) -> Result<i64> {
    if value.is_empty()
        || value.len() > 19
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(CheckpointError::Invalid);
    }
    value.parse().map_err(|_| CheckpointError::Invalid)
}
fn physical_scope(tx: &Connection, requested: &CheckpointScope) -> Result<()> {
    if super::text_sync::identity(tx)?.local_store_id != requested.vault_id {
        return Err(CheckpointError::ScopeMismatch);
    }
    Ok(())
}
fn scope(tx: &Connection, requested: &CheckpointScope) -> Result<()> {
    if zorid_records::local_intent::is_reserved_checkpoint_client(requested.client_id.as_str()) {
        return Err(CheckpointError::ScopeMismatch);
    }
    physical_scope(tx, requested)
}
/// Reserved-only helpers; caller owns the IMMEDIATE/FULL transaction and commit.
pub(super) fn intent_load(tx: &Connection, s: &CheckpointScope, key: &str) -> Result<Option<Head>> {
    intent_scope(tx, s)?;
    valid_key(key)?;
    high_water(tx)?;
    let bytes: Option<i64> = tx.query_row("SELECT length(CAST(encoded_state AS BLOB)) FROM checkpoint_heads WHERE client_id=?1 AND checkpoint_key=?2",
        params![s.client_id.as_str(),key], |r| r.get::<_,Option<i64>>(0)).optional()?.flatten();
    if bytes.is_some_and(|size| size > zorid_records::local_intent::MAX_INTENT_BYTES as i64) {
        return Err(CheckpointError::Limit);
    }
    let head = load(tx, s, key)?;
    if let Some(head) = &head {
        // Reserved keys are immutable capture + optional single retirement only.
        let history: Vec<(String,Option<String>,i64,i64)> = tx.prepare("SELECT revision,expected_revision,deleted,state_bytes FROM checkpoint_revisions WHERE client_id=?1 AND checkpoint_key=?2 ORDER BY sequence LIMIT 3")?
            .query_map(params![s.client_id.as_str(),key], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?
            .collect::<std::result::Result<_,_>>()?;
        let first = history.first().ok_or_else(corrupt)?;
        valid_revision(&first.0).map_err(|_| corrupt())?;
        if first.1.is_some()
            || first.2 != 0
            || !(1..=zorid_records::local_intent::MAX_INTENT_BYTES as i64).contains(&first.3)
            || (!head.checkpoint.deleted
                && (history.len() != 1 || first.0 != head.checkpoint.revision))
            || (head.checkpoint.deleted
                && (history.len() != 2 || head.expected.as_deref() != Some(first.0.as_str())))
        {
            return Err(corrupt());
        }
    }
    Ok(head)
}
fn intent_scope(tx: &Connection, s: &CheckpointScope) -> Result<()> {
    if s.client_id.as_str() != zorid_records::local_intent::RESERVED_CHECKPOINT_CLIENT {
        return Err(CheckpointError::ScopeMismatch);
    }
    physical_scope(tx, s)?;
    let synchronous: i64 = tx.pragma_query_value(None, "synchronous", |r| r.get(0))?;
    if synchronous != 2 {
        return Err(corrupt());
    }
    Ok(())
}
pub(super) fn intent_cas(
    tx: &Connection,
    s: &CheckpointScope,
    request: CheckpointWrite<'_>,
) -> Result<Checkpoint> {
    intent_scope(tx, s)?;
    cas(tx, s, request)
}
fn high_water(tx: &Connection) -> Result<i64> {
    let (head, allocated, count, first): (i64, i64, i64, i64) = tx.query_row(
        "SELECT COALESCE((SELECT max(sequence) FROM checkpoint_revisions),0), COALESCE((SELECT seq FROM sqlite_sequence WHERE name='checkpoint_revisions'),0), (SELECT count(*) FROM checkpoint_revisions), COALESCE((SELECT min(sequence) FROM checkpoint_revisions),0)",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    // No intentional deletion/GC or skipped allocation exists in this ledger.
    // Checking the retained count also catches an interior removed ABA fence.
    if head < 0 || head != allocated || count != head || first != i64::from(head > 0) {
        return Err(corrupt());
    }
    Ok(head)
}
pub(super) struct Head {
    pub(super) checkpoint: Checkpoint,
    pub(super) expected: Option<String>,
}
fn load(tx: &Connection, s: &CheckpointScope, key: &str) -> Result<Option<Head>> {
    // Test the byte length in SQLite before copying a potentially damaged body.
    let raw = tx.query_row(
        "SELECT h.revision,r.checkpoint_key,r.expected_revision,r.deleted,r.state_bytes,
         length(CAST(h.encoded_state AS BLOB)),
         CASE WHEN length(CAST(h.encoded_state AS BLOB))<=?3 THEN h.encoded_state ELSE NULL END,
         r.sequence,(SELECT max(sequence) FROM checkpoint_revisions WHERE client_id=?1 AND checkpoint_key=?2)
         FROM checkpoint_heads h LEFT JOIN checkpoint_revisions r ON r.client_id=h.client_id AND r.revision=h.revision
         WHERE h.client_id=?1 AND h.checkpoint_key=?2",
        params![s.client_id.as_str(), key, MAX_CHECKPOINT_BYTES as i64],
        |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,
                 r.get::<_,Option<i64>>(3)?,r.get::<_,Option<i64>>(4)?,r.get::<_,Option<i64>>(5)?,r.get::<_,Option<String>>(6)?,
                 r.get::<_,Option<i64>>(7)?,r.get::<_,Option<i64>>(8)?)))
        .optional()?;
    if raw.is_none() {
        let retained: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM checkpoint_revisions WHERE client_id=?1 AND checkpoint_key=?2)",
            params![s.client_id.as_str(),key], |r| r.get(0))?;
        if retained {
            return Err(corrupt());
        }
    }
    raw.map(
        |(revision, stored_key, expected, deleted, stored_len, length, body, sequence, latest)| {
            valid_revision(&revision).map_err(|_| corrupt())?;
            if let Some(previous) = &expected {
                valid_revision(previous).map_err(|_| corrupt())?;
            }
            if stored_key.as_deref() != Some(key)
                || !matches!(deleted, Some(0 | 1))
                || stored_len != Some(length.unwrap_or(0))
                || length.is_some_and(|len| !(0..=MAX_CHECKPOINT_BYTES as i64).contains(&len))
                || (deleted == Some(1)) != body.is_none()
                || length != body.as_ref().map(|value| value.len() as i64)
                || sequence.is_none_or(|value| value <= 0)
                || sequence != latest
            {
                return Err(corrupt());
            }
            Ok(Head {
                checkpoint: Checkpoint {
                    version: 1,
                    vault_id: s.vault_id.clone(),
                    client_id: s.client_id.clone(),
                    key: key.into(),
                    revision,
                    sequence: sequence.unwrap().to_string(),
                    deleted: deleted == Some(1),
                    byte_length: stored_len.unwrap() as u32,
                    encoded_state: body,
                },
                expected,
            })
        },
    )
    .transpose()
}

impl Store {
    /// Returns the current head, including a retained null-state tombstone.
    pub fn checkpoint_load(
        &mut self,
        s: &CheckpointScope,
        key: &str,
    ) -> Result<Option<Checkpoint>> {
        valid_key(key)?;
        let tx = self.connection.transaction()?;
        scope(&tx, s)?;
        high_water(&tx)?;
        let result = load(&tx, s, key)?.map(|head| head.checkpoint);
        tx.commit()?;
        Ok(result)
    }

    /// Succeeds only after SQLite's FULL transaction commits. Exact retry is
    /// accepted only while next_revision remains this key's current head.
    pub fn checkpoint_compare_and_swap(
        &mut self,
        s: &CheckpointScope,
        request: CheckpointWrite<'_>,
    ) -> Result<Checkpoint> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        scope(&tx, s)?;
        let result = cas(&tx, s, request)?;
        tx.commit()?;
        Ok(result)
    }

    /// Latest nondeleted metadata per key as of a fixed high-water boundary.
    /// Bodies are loaded separately from the current head and may have advanced.
    pub fn checkpoint_list(
        &mut self,
        s: &CheckpointScope,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<CheckpointPage> {
        self.checkpoint_page(s, PageKind::List, "0", limit, cursor)
    }
    /// Immutable revision metadata after `after`, including tombstones. A key
    /// may appear repeatedly; no historical full draft payloads are retained.
    pub fn checkpoint_changes(
        &mut self,
        s: &CheckpointScope,
        after: &str,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<CheckpointPage> {
        self.checkpoint_page(s, PageKind::Changes, after, limit, cursor)
    }
    fn checkpoint_page(
        &mut self,
        s: &CheckpointScope,
        kind: PageKind,
        after: &str,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<CheckpointPage> {
        if limit == 0 || limit > MAX_PAGE {
            return Err(CheckpointError::Limit);
        }
        let after_number = number(after)?;
        let tx = self.connection.transaction()?;
        scope(&tx, s)?;
        let current = high_water(&tx)?;
        let (water, position) = if let Some(encoded) = cursor {
            if encoded.len() > MAX_CURSOR_BYTES {
                return Err(CheckpointError::Limit);
            }
            let value: Cursor =
                serde_json::from_str(encoded).map_err(|_| CheckpointError::Invalid)?;
            if value.scope != *s {
                return Err(CheckpointError::ScopeMismatch);
            }
            if value.version != 1 || value.kind != kind || value.after != after {
                return Err(CheckpointError::Invalid);
            }
            (number(&value.high_water)?, number(&value.position)?)
        } else {
            (current, after_number)
        };
        if after_number > position || position > water || water > current {
            return Err(CheckpointError::Invalid);
        }
        let mut stmt = tx.prepare(
            "SELECT r.checkpoint_key,r.revision,r.sequence,r.deleted,r.state_bytes
             FROM checkpoint_revisions r WHERE r.client_id=?1 AND r.sequence>?2 AND r.sequence<=?3
             AND (?4=0 OR (r.deleted=0 AND NOT EXISTS(SELECT 1 FROM checkpoint_revisions newer
                  WHERE newer.client_id=r.client_id AND newer.checkpoint_key=r.checkpoint_key
                  AND newer.sequence>r.sequence AND newer.sequence<=?3)))
             ORDER BY r.sequence LIMIT ?5",
        )?;
        let raw = stmt
            .query_map(
                params![
                    s.client_id.as_str(),
                    position,
                    water,
                    kind == PageKind::List,
                    i64::from(limit) + 1
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        let more = raw.len() > limit as usize;
        let mut items = Vec::with_capacity(raw.len().min(limit as usize));
        for (key, revision, sequence, deleted, length) in raw.into_iter().take(limit as usize) {
            valid_key(&key).map_err(|_| corrupt())?;
            valid_revision(&revision).map_err(|_| corrupt())?;
            if sequence <= position
                || sequence > water
                || !matches!(deleted, 0 | 1)
                || !(0..=MAX_CHECKPOINT_BYTES as i64).contains(&length)
                || (deleted == 1 && length != 0)
            {
                return Err(corrupt());
            }
            items.push(CheckpointMetadata {
                version: 1,
                vault_id: s.vault_id.clone(),
                client_id: s.client_id.clone(),
                key,
                revision,
                sequence: sequence.to_string(),
                deleted: deleted == 1,
                byte_length: length as u32,
            });
        }
        let cursor = if more {
            Some(
                serde_json::to_string(&Cursor {
                    version: 1,
                    scope: s.clone(),
                    kind,
                    after: after.into(),
                    high_water: water.to_string(),
                    position: items.last().ok_or_else(corrupt)?.sequence.clone(),
                })
                .map_err(|_| corrupt())?,
            )
        } else {
            None
        };
        tx.commit()?;
        Ok(CheckpointPage {
            items,
            cursor,
            high_water: water.to_string(),
        })
    }
}

fn cas(tx: &Connection, s: &CheckpointScope, request: CheckpointWrite<'_>) -> Result<Checkpoint> {
    valid_key(request.key)?;
    valid_revision(request.next_revision)?;
    if let Some(previous) = request.expected_revision {
        valid_revision(previous)?;
    }
    if request
        .encoded_state
        .is_some_and(|body| body.len() > MAX_CHECKPOINT_BYTES)
    {
        return Err(CheckpointError::Limit);
    }
    // Store::open configures FULL; fail closed if a future caller changes it.
    let synchronous: i64 = tx.pragma_query_value(None, "synchronous", |r| r.get(0))?;
    if synchronous != 2 {
        return Err(corrupt());
    }
    high_water(tx)?;
    let current = load(tx, s, request.key)?;
    let used: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM checkpoint_revisions WHERE client_id=?1 AND revision=?2)",
        params![s.client_id.as_str(), request.next_revision],
        |r| r.get(0),
    )?;
    if used {
        if let Some(head) = current {
            if head.checkpoint.revision == request.next_revision
                && head.expected.as_deref() == request.expected_revision
                && head.checkpoint.encoded_state.as_deref() == request.encoded_state
            {
                return Ok(head.checkpoint);
            }
        }
        return Err(CheckpointError::Conflict);
    }
    if current
        .as_ref()
        .map(|head| head.checkpoint.revision.as_str())
        != request.expected_revision
    {
        return Err(CheckpointError::Conflict);
    }
    tx.execute("INSERT INTO checkpoint_revisions(client_id,checkpoint_key,revision,expected_revision,deleted,state_bytes) VALUES(?1,?2,?3,?4,?5,?6)",
            params![s.client_id.as_str(),request.key,request.next_revision,request.expected_revision,
                    request.encoded_state.is_none(),request.encoded_state.map_or(0, str::len) as i64])?;
    let sequence = tx.last_insert_rowid();
    tx.execute("INSERT INTO checkpoint_heads(client_id,checkpoint_key,revision,encoded_state) VALUES(?1,?2,?3,?4)
                    ON CONFLICT(client_id,checkpoint_key) DO UPDATE SET revision=excluded.revision,encoded_state=excluded.encoded_state",
            params![s.client_id.as_str(),request.key,request.next_revision,request.encoded_state])?;
    let result = Checkpoint {
        version: 1,
        vault_id: s.vault_id.clone(),
        client_id: s.client_id.clone(),
        key: request.key.into(),
        revision: request.next_revision.into(),
        sequence: sequence.to_string(),
        deleted: request.encoded_state.is_none(),
        byte_length: request.encoded_state.map_or(0, str::len) as u32,
        encoded_state: request.encoded_state.map(str::to_owned),
    };
    Ok(result)
}
