//! Folder-create projection, deliberately separate from unimplemented move/delete.
use super::*;
use zorid_core::OperationId;

pub(super) const SCHEMA: &[(&str,&str)] = &[
    ("directory_baselines","CREATE TABLE directory_baselines (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id), record TEXT NOT NULL)"),
    ("directory_attempts","CREATE TABLE directory_attempts (attempt_id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), operation_id TEXT NOT NULL REFERENCES operations(operation_id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL)"),
    ("active_directory_projection","CREATE UNIQUE INDEX active_directory_projection ON directory_attempts(entry_id) WHERE completed = 0"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryBaseline {
    pub state: EntryState,
    pub identity: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryPhase {
    Prepared,
    Staged,
    Published,
    Complete,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryAttempt {
    pub attempt_id: OperationId,
    pub operation_id: OperationId,
    pub sequence: String,
    pub target: EntryState,
    pub phase: DirectoryPhase,
    pub stage_identity: Option<String>,
}
fn valid_directory(state: &EntryState, id: &str) -> Result<()> {
    if state.id.as_str() != id || state.deleted || state.kind != EntryKind::Folder {
        return Err(StoreError::Corrupt("invalid directory provenance".into()));
    }
    Ok(())
}
fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}
fn decode(
    id: &str,
    entry: &str,
    operation: &str,
    completed: i64,
    json: &str,
) -> Result<DirectoryAttempt> {
    let a: DirectoryAttempt = serde_json::from_str(json)?;
    valid_directory(&a.target, entry)?;
    if a.attempt_id.as_str() != id
        || a.operation_id.as_str() != operation
        || !matches!(completed, 0 | 1)
        || (a.phase == DirectoryPhase::Complete) != (completed == 1)
        || !a
            .sequence
            .parse::<i64>()
            .ok()
            .is_some_and(|n| n > 0 && n.to_string() == a.sequence)
        || a.stage_identity
            .as_ref()
            .is_some_and(|s| !valid_identity(s))
        || (a.phase != DirectoryPhase::Prepared && a.stage_identity.is_none())
    {
        return Err(StoreError::Corrupt(
            "invalid directory attempt columns".into(),
        ));
    }
    Ok(a)
}
fn get(tx: &Connection, id: &OperationId) -> Result<DirectoryAttempt> {
    let (entry, op, done, s): (String, String, i64, String) = tx.query_row(
        "SELECT entry_id,operation_id,completed,record FROM directory_attempts WHERE attempt_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    decode(id.as_str(), &entry, &op, done, &s)
}
fn put(tx: &Connection, a: &DirectoryAttempt) -> Result<()> {
    let s = serde_json::to_string(a)?;
    decode(
        a.attempt_id.as_str(),
        a.target.id.as_str(),
        a.operation_id.as_str(),
        i64::from(a.phase == DirectoryPhase::Complete),
        &s,
    )?;
    tx.execute("INSERT INTO directory_attempts(attempt_id,entry_id,operation_id,completed,record) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(attempt_id) DO UPDATE SET completed=excluded.completed,record=excluded.record",params![a.attempt_id.as_str(),a.target.id.as_str(),a.operation_id.as_str(),a.phase==DirectoryPhase::Complete,s])?;
    Ok(())
}
fn current(tx: &Connection, id: &EntryId) -> Result<EntryState> {
    let (path, deleted, json, content): (String, i64, String, bool) = tx.query_row(
        "SELECT path,deleted,state,content IS NOT NULL FROM entries WHERE id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let state = decode_state(id.as_str(), &path, deleted, &json, content)?;
    valid_directory(&state, id.as_str())?;
    Ok(state)
}
fn baseline(tx: &Connection, id: &EntryId) -> Result<Option<DirectoryBaseline>> {
    tx.query_row(
        "SELECT record FROM directory_baselines WHERE entry_id=?1",
        [id.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|s| {
        let b: DirectoryBaseline = serde_json::from_str(&s)?;
        valid_directory(&b.state, id.as_str())?;
        if !valid_identity(&b.identity) {
            return Err(StoreError::Corrupt("invalid directory identity".into()));
        }
        Ok(b)
    })
    .transpose()
}
fn put_baseline(tx: &Connection, b: &DirectoryBaseline) -> Result<()> {
    valid_directory(&b.state, b.state.id.as_str())?;
    if !valid_identity(&b.identity) {
        return Err(StoreError::Corrupt("invalid directory identity".into()));
    }
    tx.execute("INSERT INTO directory_baselines(entry_id,record) VALUES (?1,?2) ON CONFLICT(entry_id) DO UPDATE SET record=excluded.record",params![b.state.id.as_str(),serde_json::to_string(b)?])?;
    Ok(())
}
impl Store {
    pub fn pending_directory_create(&self, id: &EntryId) -> Result<bool> {
        let rows = self
            .connection
            .prepare("SELECT o.request FROM operations o JOIN projection_queue q USING(sequence)")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for s in rows {
            let req: MutationRequest = serde_json::from_str(&s)?;
            if matches!(req.mutation,Mutation::Create{id:target,kind:EntryKind::Folder,..} if target==*id)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn directory_baseline(&self, id: &EntryId) -> Result<Option<DirectoryBaseline>> {
        baseline(&self.connection, id)
    }
    pub fn directory_attempts(&self, include_completed: bool) -> Result<Vec<DirectoryAttempt>> {
        let mut stmt=self.connection.prepare("SELECT attempt_id,entry_id,operation_id,completed,record FROM directory_attempts ORDER BY rowid")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let all: Vec<_> = rows
            .into_iter()
            .map(|(id, entry, op, done, s)| decode(&id, &entry, &op, done, &s))
            .collect::<Result<_>>()?;
        Ok(all
            .into_iter()
            .filter(|a| include_completed || a.phase != DirectoryPhase::Complete)
            .collect())
    }
    /// Establishes provenance for an observed existing folder. Identity changes
    /// require later namespace reconciliation; never silently rebind an old one.
    pub fn bind_directory(&mut self, expected: &EntryState, identity: &str) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = current(&tx, &expected.id)?;
        if state != *expected {
            return Err(StoreError::Corrupt(
                "directory changed before observation commit".into(),
            ));
        }
        if let Some(old) = baseline(&tx, &state.id)? {
            if old.state.path != state.path || old.identity != identity {
                return Err(StoreError::Corrupt(
                    "directory replaced; original provenance retained".into(),
                ));
            }
        }
        put_baseline(
            &tx,
            &DirectoryBaseline {
                state,
                identity: identity.into(),
            },
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn begin_directory_projection(&mut self, id: &EntryId) -> Result<DirectoryAttempt> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = current(&tx, id)?;
        if let Some(prior) = tx
            .query_row(
                "SELECT attempt_id FROM directory_attempts WHERE entry_id=?1 AND completed=0",
                [id.as_str()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return get(&tx, &OperationId::new(prior)?);
        }
        let rows=tx.prepare("SELECT o.sequence,o.operation_id,o.request,o.result FROM operations o JOIN projection_queue q USING(sequence) ORDER BY o.sequence")?.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut selected = None;
        for (sequence, op, request, result) in rows {
            let record = RecordedOperation {
                request: serde_json::from_str(&request)?,
                result: serde_json::from_str(&result)?,
            };
            check_idempotency(&record.request, Some(&record))?;
            if record.request.operation_id.as_str() != op
                || record.result.sequence != sequence as u64
            {
                return Err(StoreError::Corrupt(
                    "queued operation columns disagree".into(),
                ));
            }
            if matches!(&record.request.mutation,Mutation::Create{id:target,path,kind:EntryKind::Folder,..} if target==id&&path==&state.path)
            {
                selected = Some((op, sequence));
                break;
            }
        }
        let (operation, sequence) = selected.ok_or_else(|| {
            StoreError::Corrupt("no pending folder-create operation for this path".into())
        })?;
        let a = DirectoryAttempt {
            attempt_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            operation_id: OperationId::new(operation)?,
            sequence: sequence.to_string(),
            target: state,
            phase: DirectoryPhase::Prepared,
            stage_identity: None,
        };
        put(&tx, &a)?;
        tx.commit()?;
        Ok(a)
    }
    pub fn mark_directory_projection(
        &mut self,
        id: &OperationId,
        phase: DirectoryPhase,
        identity: Option<String>,
    ) -> Result<DirectoryAttempt> {
        if phase == DirectoryPhase::Complete {
            return Err(StoreError::Corrupt(
                "use finish_directory_projection".into(),
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut a = get(&tx, id)?;
        if a.phase == DirectoryPhase::Complete {
            return Err(StoreError::Corrupt("directory attempt complete".into()));
        }
        if let Some(identity) = identity {
            if a.stage_identity
                .as_ref()
                .is_some_and(|old| old != &identity)
            {
                return Err(StoreError::Corrupt(
                    "directory stage identity changed".into(),
                ));
            }
            a.stage_identity = Some(identity);
        }
        a.phase = phase;
        put(&tx, &a)?;
        tx.commit()?;
        Ok(a)
    }
    pub fn finish_directory_projection(&mut self, id: &OperationId) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut a = get(&tx, id)?;
        if a.phase == DirectoryPhase::Complete {
            return Ok(());
        }
        let state = current(&tx, &a.target.id)?;
        if state.path != a.target.path {
            return Err(StoreError::Corrupt(
                "folder moved before publication completion".into(),
            ));
        }
        let identity = a
            .stage_identity
            .clone()
            .ok_or_else(|| StoreError::Corrupt("missing published directory identity".into()))?;
        if let Some(old) = baseline(&tx, &state.id)? {
            if old.identity != identity || old.state.path != state.path {
                return Err(StoreError::Corrupt("directory provenance changed".into()));
            }
        }
        let (sequence, request, result): (i64, String, String) = tx.query_row(
            "SELECT sequence,request,result FROM operations WHERE operation_id=?1",
            [a.operation_id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let record = RecordedOperation {
            request: serde_json::from_str(&request)?,
            result: serde_json::from_str(&result)?,
        };
        check_idempotency(&record.request, Some(&record))?;
        if record.request.operation_id != a.operation_id
            || sequence.to_string() != a.sequence
            || record.result.sequence != sequence as u64
            || !matches!(&record.request.mutation,Mutation::Create{id,path,kind:EntryKind::Folder,..} if id==&state.id&&path==&state.path)
        {
            return Err(StoreError::Corrupt(
                "folder attempt does not represent queued create".into(),
            ));
        }
        put_baseline(&tx, &DirectoryBaseline { state, identity })?;
        tx.execute("DELETE FROM projection_queue WHERE sequence=?1", [sequence])?;
        a.phase = DirectoryPhase::Complete;
        put(&tx, &a)?;
        tx.commit()?;
        Ok(())
    }
}
