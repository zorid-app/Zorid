//! Folder-create projection, deliberately separate from unimplemented move/delete.
use super::*;
use zorid_core::OperationId;

pub(super) const SCHEMA: &[(&str,&str)] = &[
    ("directory_baselines","CREATE TABLE directory_baselines (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id), record TEXT NOT NULL)"),
    ("directory_attempts","CREATE TABLE directory_attempts (attempt_id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), operation_id TEXT NOT NULL REFERENCES operations(operation_id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL)"),
    ("active_directory_projection","CREATE UNIQUE INDEX active_directory_projection ON directory_attempts(entry_id) WHERE completed = 0"),
];
pub(super) const SCHEMA_V6: &[(&str,&str)] = &[
    ("directory_baselines","CREATE TABLE directory_baselines (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id), record TEXT NOT NULL)"),
    ("directory_attempts","CREATE TABLE directory_attempts (attempt_id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), job_id TEXT NOT NULL REFERENCES projection_jobs(job_id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL)"),
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
    pub job_id: OperationId,
    pub origin: ProjectionOrigin,
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
    job: &str,
    completed: i64,
    json: &str,
) -> Result<DirectoryAttempt> {
    let a: DirectoryAttempt = serde_json::from_str(json)?;
    valid_directory(&a.target, entry)?;
    if a.attempt_id.as_str() != id
        || a.job_id.as_str() != job
        || !matches!(completed, 0 | 1)
        || (a.phase == DirectoryPhase::Complete) != (completed == 1)
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
        "SELECT entry_id,job_id,completed,record FROM directory_attempts WHERE attempt_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let value = decode(id.as_str(), &entry, &op, done, &s)?;
    validate_job(tx, &value)?;
    Ok(value)
}
fn put(tx: &Connection, a: &DirectoryAttempt) -> Result<()> {
    let s = serde_json::to_string(a)?;
    decode(
        a.attempt_id.as_str(),
        a.target.id.as_str(),
        a.job_id.as_str(),
        i64::from(a.phase == DirectoryPhase::Complete),
        &s,
    )?;
    validate_job(tx, a)?;
    tx.execute("INSERT INTO directory_attempts(attempt_id,entry_id,job_id,completed,record) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(attempt_id) DO UPDATE SET completed=excluded.completed,record=excluded.record",params![a.attempt_id.as_str(),a.target.id.as_str(),a.job_id.as_str(),a.phase==DirectoryPhase::Complete,s])?;
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
        Ok(
            !projection_jobs::pending(&self.connection, id, ProjectionWork::CreateDirectory)?
                .is_empty(),
        )
    }

    pub fn directory_baseline(&self, id: &EntryId) -> Result<Option<DirectoryBaseline>> {
        baseline(&self.connection, id)
    }
    pub fn directory_attempts(&self, include_completed: bool) -> Result<Vec<DirectoryAttempt>> {
        let mut stmt=self.connection.prepare("SELECT attempt_id,entry_id,job_id,completed,record FROM directory_attempts ORDER BY rowid")?;
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
            .map(|(id, entry, op, done, s)| {
                let a = decode(&id, &entry, &op, done, &s)?;
                validate_job(&self.connection, &a)?;
                Ok(a)
            })
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
        let job = projection_jobs::pending(&tx, id, ProjectionWork::CreateDirectory)?
            .into_iter()
            .find(|job| job.target.path == state.path)
            .ok_or_else(|| {
                StoreError::Corrupt("no pending folder-create job for this path".into())
            })?;
        let a = DirectoryAttempt {
            attempt_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            job_id: job.job_id,
            origin: job.origin,
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
        let job = validate_job(&tx, &a)?;
        put_baseline(&tx, &DirectoryBaseline { state, identity })?;
        projection_jobs::finish(&tx, &job)?;
        a.phase = DirectoryPhase::Complete;
        put(&tx, &a)?;
        tx.commit()?;
        Ok(())
    }
}

fn validate_job(tx: &Connection, attempt: &DirectoryAttempt) -> Result<ProjectionJob> {
    let job = projection_jobs::get(tx, &attempt.job_id)?;
    if job.origin != attempt.origin
        || job.work != ProjectionWork::CreateDirectory
        || job.target.id != attempt.target.id
        || job.target.path != attempt.target.path
        || job.target.kind != EntryKind::Folder
    {
        return Err(StoreError::Corrupt(
            "directory attempt does not represent its exact create job".into(),
        ));
    }
    Ok(job)
}
pub(super) fn migrate_job_schema(tx: &Connection) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Legacy {
        attempt_id: OperationId,
        operation_id: OperationId,
        sequence: String,
        target: EntryState,
        phase: DirectoryPhase,
        stage_identity: Option<String>,
    }
    let rows = tx
        .prepare(
            "SELECT attempt_id,entry_id,operation_id,completed,record FROM directory_attempts",
        )?
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
    tx.execute_batch("DROP INDEX active_directory_projection; ALTER TABLE directory_attempts RENAME TO legacy_directory_attempts;")?;
    tx.execute_batch(SCHEMA_V6[1].1)?;
    tx.execute_batch(SCHEMA_V6[2].1)?;
    for (id, entry, operation, completed, json) in rows {
        let old: Legacy = serde_json::from_str(&json)?;
        if old.attempt_id.as_str() != id
            || old.target.id.as_str() != entry
            || old.operation_id.as_str() != operation
            || !matches!(completed, 0 | 1)
            || (old.phase == DirectoryPhase::Complete) != (completed == 1)
            || !old
                .sequence
                .parse::<i64>()
                .ok()
                .is_some_and(|n| n > 0 && n.to_string() == old.sequence)
        {
            return Err(StoreError::Corrupt(
                "legacy directory attempt identity mismatch".into(),
            ));
        }
        let job_id = OperationId::new(format!("legacy_projection_{}", old.sequence))?;
        let job = projection_jobs::get(tx, &job_id)?;
        if job.origin
            != (ProjectionOrigin::LocalCommand {
                operation_id: old.operation_id,
            })
        {
            return Err(StoreError::Corrupt(
                "legacy directory attempt operation mismatch".into(),
            ));
        }
        put(
            tx,
            &DirectoryAttempt {
                attempt_id: old.attempt_id,
                job_id,
                origin: job.origin,
                target: old.target,
                phase: old.phase,
                stage_identity: old.stage_identity,
            },
        )?;
    }
    tx.execute_batch("DROP TABLE legacy_directory_attempts")?;
    Ok(())
}
