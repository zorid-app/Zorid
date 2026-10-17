//! UI metadata and a database-local journal. Neither wall clocks nor this cursor
//! identify a remote revision. The journal does not contain file bodies.
use super::*;
use zorid_core::{OperationId, VaultPath};

pub(crate) const SCHEMA: &[(&str, &str)] = &[
    ("entry_presentation", "CREATE TABLE entry_presentation (entry_id TEXT PRIMARY KEY REFERENCES entries(id), ctime_ms INTEGER NOT NULL CHECK(ctime_ms BETWEEN 0 AND 9007199254740991), mtime_ms INTEGER NOT NULL CHECK(mtime_ms BETWEEN 0 AND 9007199254740991), size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 9007199254740991))"),
    ("local_changes", "CREATE TABLE local_changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)"),
];
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PAGE_BYTES: usize = 1024 * 1024;

pub(crate) fn validate_number(value: u64) -> Result<()> {
    if value > SAFE_INTEGER {
        return Err(StoreError::Contract(ContractError::InvalidMutation {
            reason: "presentation value exceeds JavaScript safe integer".into(),
        }));
    }
    Ok(())
}
fn stored_number(value: i64) -> Result<u64> {
    let number = u64::try_from(value)
        .map_err(|_| StoreError::Corrupt("negative presentation value".into()))?;
    if number > SAFE_INTEGER {
        return Err(StoreError::Corrupt(
            "stored presentation exceeds safe integer".into(),
        ));
    }
    Ok(number)
}
fn safe_number<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    validate_number(value).map_err(serde::de::Error::custom)?;
    Ok(value)
}
pub(crate) fn now_ms() -> Result<u64> {
    let value = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StoreError::Corrupt("system clock predates Unix epoch".into()))?
        .as_millis();
    let value =
        u64::try_from(value).map_err(|_| StoreError::Corrupt("system clock overflow".into()))?;
    validate_number(value)?;
    Ok(value)
}
fn parse_cursor(value: &str) -> Result<i64> {
    let parsed = value
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 0 && n.to_string() == value);
    parsed.ok_or_else(|| {
        StoreError::Contract(ContractError::InvalidMutation {
            reason: "local cursor must be a canonical nonnegative signed-64 decimal string".into(),
        })
    })
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryPresentation {
    pub id: EntryId,
    #[serde(deserialize_with = "safe_number")]
    pub ctime_ms: u64,
    #[serde(deserialize_with = "safe_number")]
    pub mtime_ms: u64,
    #[serde(deserialize_with = "safe_number")]
    pub size_bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresentedState {
    pub state: EntryState,
    pub presentation: EntryPresentation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresentedEntry {
    pub state: EntryState,
    pub content: Option<Vec<u8>>,
    pub presentation: EntryPresentation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListingSnapshot {
    pub entries: Vec<PresentedState>,
    pub cursor: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChangeOrigin {
    Bootstrap,
    LocalCommand {
        operation_id: OperationId,
    },
    /// Reserved journal origin. There is intentionally no received-write API yet.
    ReceivedUpdate {
        realm_id: String,
        vault_id: String,
        update_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalChange {
    pub cursor: String,
    pub origin: ChangeOrigin,
    pub requires_full_reload: bool,
    /// Includes tombstones; consumers remove deleted entries by stable ID.
    pub entries: Vec<PresentedState>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangePage {
    pub changes: Vec<LocalChange>,
    pub next_cursor: String,
    pub head_cursor: String,
    pub has_more: bool,
}

pub(crate) fn migrate(tx: &Connection) -> Result<()> {
    for (_, sql) in SCHEMA {
        tx.execute_batch(sql)?;
    }
    // Zero is an explicit unknown legacy time, never a guessed filesystem time.
    for state in read_states(tx, true)? {
        let size: i64 = tx.query_row(
            "SELECT coalesce(length(content),0) FROM entries WHERE id=?1",
            [state.id.as_str()],
            |r| r.get(0),
        )?;
        validate_number(
            u64::try_from(size).map_err(|_| StoreError::Corrupt("negative byte size".into()))?,
        )?;
        tx.execute(
            "INSERT INTO entry_presentation VALUES (?1,0,0,?2)",
            params![state.id.as_str(), size],
        )?;
    }
    append(tx, ChangeOrigin::Bootstrap, true, Vec::new())?;
    Ok(())
}
pub(crate) fn presentation(tx: &Connection, state: &EntryState) -> Result<EntryPresentation> {
    let row = tx.query_row("SELECT p.ctime_ms,p.mtime_ms,p.size_bytes,coalesce(length(e.content),0) FROM entry_presentation p JOIN entries e ON e.id=p.entry_id WHERE p.entry_id=?1", [state.id.as_str()], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?))).optional()?;
    let (ctime_ms, mtime_ms, size_bytes, actual) =
        row.ok_or_else(|| StoreError::Corrupt("missing presentation".into()))?;
    let ctime_ms = stored_number(ctime_ms)?;
    let mtime_ms = stored_number(mtime_ms)?;
    let size_bytes = stored_number(size_bytes)?;
    let actual = stored_number(actual)?;
    if size_bytes != actual || (state.kind == EntryKind::Folder && size_bytes != 0) {
        return Err(StoreError::Corrupt(
            "presentation size differs from committed bytes".into(),
        ));
    }
    Ok(EntryPresentation {
        id: state.id.clone(),
        ctime_ms,
        mtime_ms,
        size_bytes,
    })
}
pub(crate) fn record_local(tx: &Connection, result: &CommitResult, now: u64) -> Result<()> {
    record_changes(
        tx,
        ChangeOrigin::LocalCommand {
            operation_id: result.operation_id.clone(),
        },
        &result.changes,
        now,
    )
}
pub(crate) fn record_changes(
    tx: &Connection,
    origin: ChangeOrigin,
    changes: &[zorid_core::EntryChange],
    now: u64,
) -> Result<()> {
    validate_number(now)?;
    let now_sql = i64::try_from(now)
        .map_err(|_| StoreError::Corrupt("display clock conversion overflow".into()))?;
    let mut entries = Vec::new();
    for change in changes {
        let state = &change.after;
        let size: i64 = tx.query_row(
            "SELECT coalesce(length(content),0) FROM entries WHERE id=?1",
            [state.id.as_str()],
            |r| r.get(0),
        )?;
        stored_number(size)?;
        // Preserve creation time, including legacy unknown=0. Clock rollback does
        // not roll display mtime backwards; revisions remain the only CAS token.
        tx.execute("INSERT INTO entry_presentation VALUES (?1,?2,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET mtime_ms=max(entry_presentation.mtime_ms,excluded.mtime_ms),size_bytes=excluded.size_bytes", params![state.id.as_str(),now_sql,size])?;
        entries.push(PresentedState {
            state: state.clone(),
            presentation: presentation(tx, state)?,
        });
    }
    append(tx, origin, false, entries)?;
    Ok(())
}
/// A visibility transition cannot be represented as a fake tombstone. Update
/// presentation metadata and append one explicit full-reload event atomically.
pub(crate) fn record_family_reload(
    tx: &Connection,
    origin: ProjectionOrigin,
    changes: &[zorid_core::EntryChange],
    now: u64,
) -> Result<()> {
    validate_number(now)?;
    let now =
        i64::try_from(now).map_err(|_| StoreError::Corrupt("display clock overflow".into()))?;
    for change in changes {
        let size: i64 = tx.query_row(
            "SELECT coalesce(length(content),0) FROM entries WHERE id=?1",
            [change.after.id.as_str()],
            |r| r.get(0),
        )?;
        stored_number(size)?;
        tx.execute("INSERT INTO entry_presentation VALUES(?1,?2,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET mtime_ms=max(entry_presentation.mtime_ms,excluded.mtime_ms),size_bytes=excluded.size_bytes",params![change.after.id.as_str(),now,size])?;
    }
    let origin = match origin {
        ProjectionOrigin::ReceivedUpdate {
            realm_id,
            vault_id,
            update_id,
        } => ChangeOrigin::ReceivedUpdate {
            realm_id,
            vault_id,
            update_id,
        },
        ProjectionOrigin::LocalCommand { operation_id } => {
            ChangeOrigin::LocalCommand { operation_id }
        }
    };
    append(tx, origin, true, Vec::new())
}
fn append(
    tx: &Connection,
    origin: ChangeOrigin,
    requires_full_reload: bool,
    entries: Vec<PresentedState>,
) -> Result<()> {
    if !matches!(origin, ChangeOrigin::Bootstrap) {
        head(tx)?;
    }
    // SQLite AUTOINCREMENT fails rather than wrapping at signed64 exhaustion.
    tx.execute("INSERT INTO local_changes(record) VALUES ('')", [])?;
    let cursor = tx.last_insert_rowid();
    if cursor <= 0 {
        return Err(StoreError::Corrupt("journal cursor overflow".into()));
    }
    let event = LocalChange {
        cursor: cursor.to_string(),
        origin,
        requires_full_reload,
        entries,
    };
    tx.execute(
        "UPDATE local_changes SET record=?1 WHERE cursor=?2",
        params![serde_json::to_string(&event)?, cursor],
    )?;
    Ok(())
}
fn head(tx: &Connection) -> Result<i64> {
    let (head, allocated): (i64, i64) = tx.query_row(
        "SELECT (SELECT coalesce(max(cursor),0) FROM local_changes),(SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='local_changes'),0))", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
    if head <= 0 || head != allocated {
        return Err(StoreError::Corrupt(
            "journal head missing or inconsistent; reload required".into(),
        ));
    }
    Ok(head)
}

impl Store {
    /// Path identity, revision, bytes and presentation share one read snapshot.
    pub fn read_path(&self, path: &VaultPath) -> Result<Option<PresentedEntry>> {
        let tx = self.connection.unchecked_transaction()?;
        let raw = tx
            .query_row(
                "SELECT id,deleted,state,content FROM entries WHERE path=?1 AND deleted=0 AND visible=1",
                [path.as_str()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                },
            )
            .optional()?;
        let result = raw
            .map(|(id, deleted, json, content)| -> Result<PresentedEntry> {
                let state = decode_state(&id, path.as_str(), deleted, &json, content.is_some())?;
                let presentation = presentation(&tx, &state)?;
                Ok(PresentedEntry {
                    state,
                    content,
                    presentation,
                })
            })
            .transpose()?;
        tx.commit()?;
        Ok(result)
    }
    /// Entry identity is the recovery key; renamed paths remain display locators.
    pub fn read_presented(&self, id: &EntryId) -> Result<Option<PresentedEntry>> {
        let tx = self.connection.unchecked_transaction()?;
        let raw = tx
            .query_row(
                "SELECT path,deleted,state,content FROM entries WHERE id=?1 AND deleted=0 AND visible=1",
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
            .optional()?;
        let result = raw
            .map(|(path, deleted, json, content)| -> Result<PresentedEntry> {
                let state = decode_state(id.as_str(), &path, deleted, &json, content.is_some())?;
                let presentation = presentation(&tx, &state)?;
                Ok(PresentedEntry {
                    state,
                    content,
                    presentation,
                })
            })
            .transpose()?;
        tx.commit()?;
        Ok(result)
    }
    pub fn list_snapshot(&self) -> Result<ListingSnapshot> {
        let tx = self.connection.unchecked_transaction()?;
        let entries = read_states(&tx, false)?
            .into_iter()
            .map(|state| {
                let presentation = presentation(&tx, &state)?;
                Ok(PresentedState {
                    state,
                    presentation,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let cursor = head(&tx)?.to_string();
        tx.commit()?;
        Ok(ListingSnapshot { entries, cursor })
    }
    /// At most 1000 events and 1MiB encoded records. An individually oversized
    /// event errors; callers may obtain a coherent full snapshot instead.
    pub fn changes_after(&self, cursor: &str, limit: u32) -> Result<ChangePage> {
        let start = parse_cursor(cursor)?;
        if !(1..=1000).contains(&limit) {
            return Err(StoreError::Contract(ContractError::InvalidMutation {
                reason: "journal limit must be 1..=1000".into(),
            }));
        }
        let tx = self.connection.unchecked_transaction()?;
        let head = head(&tx)?;
        if start > head {
            return Err(StoreError::ReloadRequired(ReloadReason::CursorAhead));
        }
        let sizes = tx.prepare("SELECT cursor,length(CAST(record AS BLOB)) FROM local_changes WHERE cursor>?1 ORDER BY cursor LIMIT ?2")?.query_map(params![start,limit],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut changes = Vec::new();
        let mut next = start;
        let mut total = 0usize;
        for (sequence, size) in sizes {
            let size = usize::try_from(size)
                .map_err(|_| StoreError::Corrupt("invalid journal record length".into()))?;
            if sequence
                != next
                    .checked_add(1)
                    .ok_or_else(|| StoreError::Corrupt("cursor overflow".into()))?
            {
                return Err(StoreError::ReloadRequired(ReloadReason::JournalGap));
            }
            if size > MAX_PAGE_BYTES {
                return Err(StoreError::ReloadRequired(ReloadReason::EventTooLarge));
            }
            if total + size > MAX_PAGE_BYTES {
                break;
            }
            let json: String = tx.query_row(
                "SELECT record FROM local_changes WHERE cursor=?1",
                [sequence],
                |r| r.get(0),
            )?;
            let change: LocalChange = serde_json::from_str(&json)?;
            if parse_cursor(&change.cursor)? != sequence
                || (matches!(change.origin, ChangeOrigin::Bootstrap)
                    && !change.requires_full_reload)
                || (change.requires_full_reload && !change.entries.is_empty())
                || (!change.requires_full_reload && change.entries.is_empty())
            {
                return Err(StoreError::Corrupt(
                    "journal record identity mismatch".into(),
                ));
            }
            for entry in &change.entries {
                if entry.state.id != entry.presentation.id
                    || (entry.state.kind == EntryKind::Folder && entry.presentation.size_bytes != 0)
                {
                    return Err(StoreError::Corrupt(
                        "journal entry presentation mismatch".into(),
                    ));
                }
            }
            total += size;
            next = sequence;
            changes.push(change);
        }
        if next < head && changes.is_empty() {
            return Err(StoreError::ReloadRequired(ReloadReason::JournalGap));
        }
        tx.commit()?;
        Ok(ChangePage {
            changes,
            next_cursor: next.to_string(),
            head_cursor: head.to_string(),
            has_more: next < head,
        })
    }
}
