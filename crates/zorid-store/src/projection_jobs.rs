//! One projection authority for local commands and received changes. Job identity
//! is never inferred from either the local-command or relay sequence domain.
use super::*;
use zorid_core::{EntryChange, OperationId};
pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("projection_jobs","CREATE TABLE projection_jobs (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL UNIQUE, entry_id TEXT NOT NULL REFERENCES entries(id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL)"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectionOrigin {
    LocalCommand {
        operation_id: OperationId,
    },
    ReceivedUpdate {
        realm_id: String,
        vault_id: String,
        update_id: String,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionWork {
    MaterializeFile,
    CreateDirectory,
    Move,
    Delete,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionJob {
    pub job_id: OperationId,
    pub ordinal: String,
    pub origin: ProjectionOrigin,
    pub work: ProjectionWork,
    pub target: EntryState,
    /// Explicit committed physical members. Never expand a received deletion
    /// against the current receiver subtree.
    pub affected: Vec<EntryChange>,
    pub completed: bool,
}
fn validate(job: &ProjectionJob) -> Result<()> {
    if let ProjectionOrigin::ReceivedUpdate {
        realm_id,
        vault_id,
        update_id,
    } = &job.origin
    {
        zorid_sync_protocol::RealmId::new(realm_id)?;
        zorid_sync_protocol::VaultId::new(vault_id)?;
        zorid_sync_protocol::UpdateId::new(update_id)?;
    }
    if !job
        .ordinal
        .parse::<i64>()
        .ok()
        .is_some_and(|n| n > 0 && n.to_string() == job.ordinal)
        || job.affected.is_empty()
        || !job.affected.iter().any(|c| c.after == job.target)
        || matches!(job.work, ProjectionWork::MaterializeFile)
            && (job.target.deleted || job.target.kind != EntryKind::File)
        || matches!(job.work, ProjectionWork::CreateDirectory)
            && (job.target.deleted || job.target.kind != EntryKind::Folder)
        || matches!(job.work, ProjectionWork::Delete) && !job.target.deleted
    {
        return Err(StoreError::Corrupt(
            "invalid projection job target/members".into(),
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    for change in &job.affected {
        if !ids.insert(change.after.id.as_str())
            || change
                .before
                .as_ref()
                .is_some_and(|b| b.id != change.after.id)
        {
            return Err(StoreError::Corrupt(
                "projection member identity mismatch".into(),
            ));
        }
    }
    Ok(())
}
fn decode(
    id: &str,
    ordinal: i64,
    entry: &str,
    completed: i64,
    json: &str,
) -> Result<ProjectionJob> {
    let job: ProjectionJob = serde_json::from_str(json)?;
    validate(&job)?;
    if job.job_id.as_str() != id
        || job.ordinal != ordinal.to_string()
        || job.target.id.as_str() != entry
        || !matches!(completed, 0 | 1)
        || job.completed != (completed == 1)
    {
        return Err(StoreError::Corrupt(
            "projection job columns mismatch".into(),
        ));
    }
    Ok(job)
}
pub(super) fn get(tx: &Connection, id: &OperationId) -> Result<ProjectionJob> {
    let (ordinal, entry, done, json): (i64, String, i64, String) = tx.query_row(
        "SELECT ordinal,entry_id,completed,record FROM projection_jobs WHERE job_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    decode(id.as_str(), ordinal, &entry, done, &json)
}
pub(super) fn pending(
    tx: &Connection,
    id: &EntryId,
    work: ProjectionWork,
) -> Result<Vec<ProjectionJob>> {
    let rows=tx.prepare("SELECT job_id,ordinal,entry_id,completed,record FROM projection_jobs WHERE entry_id=?1 AND completed=0 ORDER BY ordinal")?.query_map([id.as_str()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let jobs = rows
        .into_iter()
        .map(|(id, n, entry, done, json)| decode(&id, n, &entry, done, &json))
        .collect::<Result<Vec<_>>>()?;
    Ok(jobs.into_iter().filter(|j| j.work == work).collect())
}
pub(super) fn insert(
    tx: &Connection,
    mut job: ProjectionJob,
    ordinal: Option<i64>,
) -> Result<ProjectionJob> {
    if let Some(ordinal) = ordinal {
        tx.execute("INSERT INTO projection_jobs(ordinal,job_id,entry_id,completed,record) VALUES(?1,?2,?3,?4,'')",params![ordinal,job.job_id.as_str(),job.target.id.as_str(),job.completed])?;
    } else {
        tx.execute(
            "INSERT INTO projection_jobs(job_id,entry_id,completed,record) VALUES(?1,?2,?3,'')",
            params![job.job_id.as_str(), job.target.id.as_str(), job.completed],
        )?;
    }
    job.ordinal = tx.last_insert_rowid().to_string();
    validate(&job)?;
    tx.execute(
        "UPDATE projection_jobs SET record=?1 WHERE job_id=?2",
        params![serde_json::to_string(&job)?, job.job_id.as_str()],
    )?;
    Ok(job)
}
fn local_job(
    command: &MutationRequest,
    result: &CommitResult,
    completed: bool,
) -> Result<ProjectionJob> {
    result.validate()?;
    if result.operation_id != command.operation_id {
        return Err(StoreError::Corrupt(
            "projection command receipt mismatch".into(),
        ));
    }
    let target = result
        .changes
        .iter()
        .find(|c| c.after.id == *command.mutation.id())
        .ok_or_else(|| StoreError::Corrupt("projection target missing".into()))?
        .after
        .clone();
    let work = match &command.mutation {
        Mutation::Create {
            kind: EntryKind::Folder,
            ..
        } => ProjectionWork::CreateDirectory,
        Mutation::Create { .. } | Mutation::Write { .. } => ProjectionWork::MaterializeFile,
        Mutation::Move { .. } => ProjectionWork::Move,
        Mutation::Delete { .. } => ProjectionWork::Delete,
    };
    let affected = result
        .changes
        .iter()
        .filter(|c| match work {
            ProjectionWork::MaterializeFile | ProjectionWork::CreateDirectory => {
                c.after.id == target.id
            }
            ProjectionWork::Move => {
                c.after.id == target.id || c.before.as_ref().is_some_and(|b| b.path != c.after.path)
            }
            ProjectionWork::Delete => c.after.deleted,
        })
        .cloned()
        .collect();
    Ok(ProjectionJob {
        job_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
        ordinal: "0".into(),
        origin: ProjectionOrigin::LocalCommand {
            operation_id: command.operation_id.clone(),
        },
        work,
        target,
        affected,
        completed,
    })
}
pub(super) fn enqueue_local(
    tx: &Connection,
    command: &MutationRequest,
    result: &CommitResult,
) -> Result<ProjectionJob> {
    insert(tx, local_job(command, result, false)?, None)
}
pub(super) fn enqueue_received(
    tx: &Connection,
    origin: ProjectionOrigin,
    change: EntryChange,
) -> Result<ProjectionJob> {
    insert(
        tx,
        ProjectionJob {
            job_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            ordinal: "0".into(),
            origin,
            work: ProjectionWork::MaterializeFile,
            target: change.after.clone(),
            affected: vec![change],
            completed: false,
        },
        None,
    )
}
/// Enqueue exact received namespace/content work without a fabricated command
/// receipt. The physical adapter separately attaches durable source provenance.
pub(super) fn enqueue_received_work(
    tx: &Connection,
    origin: ProjectionOrigin,
    work: ProjectionWork,
    target: EntryState,
    affected: Vec<EntryChange>,
) -> Result<ProjectionJob> {
    if !matches!(origin, ProjectionOrigin::ReceivedUpdate { .. }) {
        return Err(StoreError::Corrupt(
            "received projection has local origin".into(),
        ));
    }
    insert(
        tx,
        ProjectionJob {
            job_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            ordinal: "0".into(),
            origin,
            work,
            target,
            affected,
            completed: false,
        },
        None,
    )
}
pub(super) fn finish(tx: &Connection, expected: &ProjectionJob) -> Result<()> {
    let current = get(tx, &expected.job_id)?;
    let mut normalized = current.clone();
    normalized.completed = expected.completed;
    if normalized != *expected {
        return Err(StoreError::Corrupt(
            "projection job changed before completion".into(),
        ));
    }
    if current.completed {
        return Ok(());
    }
    let mut complete = current;
    complete.completed = true;
    tx.execute(
        "UPDATE projection_jobs SET completed=1,record=?1 WHERE job_id=?2",
        params![serde_json::to_string(&complete)?, complete.job_id.as_str()],
    )?;
    Ok(())
}
pub(super) fn retire_file(tx: &Connection, id: &EntryId, jobs: &[OperationId]) -> Result<()> {
    for job_id in jobs {
        let job = get(tx, job_id)?;
        if job.target.id != *id || job.work != ProjectionWork::MaterializeFile {
            return Err(StoreError::Corrupt(
                "file attempt covers unrelated projection job".into(),
            ));
        }
        finish(tx, &job)?;
    }
    Ok(())
}
pub(super) fn retire_local(tx: &Connection, operation: &OperationId) -> Result<()> {
    let rows = tx
        .prepare("SELECT job_id FROM projection_jobs WHERE completed=0")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for id in rows {
        let job = get(tx, &OperationId::new(id)?)?;
        if matches!(&job.origin,ProjectionOrigin::LocalCommand{operation_id} if operation_id==operation)
        {
            finish(tx, &job)?;
        }
    }
    Ok(())
}
pub(super) fn migrate(tx: &Connection) -> Result<()> {
    let orphan:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM projection_queue q LEFT JOIN operations o USING(sequence) WHERE o.sequence IS NULL)",[],|r|r.get(0))?;
    if orphan {
        return Err(StoreError::Corrupt(
            "legacy projection queue references missing operation".into(),
        ));
    }
    for (_, sql) in SCHEMA {
        tx.execute_batch(sql)?;
    }
    // Explicit old-operation→new-job map, including completed history required by
    // retained directory attempts. No old cursor is reinterpreted as a new one.
    let mut statement=tx.prepare("SELECT o.sequence,o.operation_id,o.request,o.result,q.sequence IS NULL FROM operations o LEFT JOIN projection_queue q USING(sequence) ORDER BY o.sequence")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let sequence: i64 = row.get(0)?;
        let op: String = row.get(1)?;
        let request: MutationRequest = serde_json::from_str(&row.get::<_, String>(2)?)?;
        let result: CommitResult = serde_json::from_str(&row.get::<_, String>(3)?)?;
        let completed: bool = row.get(4)?;
        let recorded = RecordedOperation {
            request: request.clone(),
            result: result.clone(),
        };
        check_idempotency(&request, Some(&recorded))?;
        if sequence <= 0
            || result.sequence.to_string() != sequence.to_string()
            || request.operation_id.as_str() != op
        {
            return Err(StoreError::Corrupt(
                "legacy projection operation identity mismatch".into(),
            ));
        }
        let mut job = local_job(&request, &result, completed)?;
        job.job_id = OperationId::new(format!("legacy_projection_{sequence}"))?;
        insert(tx, job, Some(sequence))?;
    }
    drop(rows);
    drop(statement);
    // Rewrite cutoff into the exact still-pending jobs it originally covered.
    let attempts = tx
        .prepare("SELECT attempt_id,record,completed,entry_id FROM projection_attempts")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, json, completed, entry_sql) in attempts {
        projection::decode_attempt(&id, &entry_sql, completed, &json)?;
        let completed = completed == 1;
        let mut value: serde_json::Value = serde_json::from_str(&json)?;
        let cutoff = value["through_sequence"]
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or_else(|| StoreError::Corrupt("legacy attempt cutoff invalid".into()))?;
        let entry = EntryId::new(
            value["target"]["state"]["id"]
                .as_str()
                .ok_or_else(|| StoreError::Corrupt("legacy attempt entry missing".into()))?,
        )?;
        let covered = if completed {
            vec![]
        } else {
            pending(tx, &entry, ProjectionWork::MaterializeFile)?
                .into_iter()
                .filter(|j| j.ordinal.parse::<i64>().is_ok_and(|n| n <= cutoff))
                .map(|j| j.job_id)
                .collect()
        };
        value["covered_jobs"] = serde_json::to_value(covered)?;
        tx.execute(
            "UPDATE projection_attempts SET record=?1 WHERE attempt_id=?2",
            params![serde_json::to_string(&value)?, id],
        )?;
    }
    tx.execute_batch("DROP TABLE projection_queue")?;
    Ok(())
}
impl Store {
    pub fn projection_job(&self, id: &OperationId) -> Result<ProjectionJob> {
        get(&self.connection, id)
    }
    pub fn pending_projection_jobs(&self, limit: u32) -> Result<Vec<ProjectionJob>> {
        if !(1..=1000).contains(&limit) {
            return Err(ContractError::InvalidMutation {
                reason: "projection job limit must be 1..=1000".into(),
            }
            .into());
        }
        let tx = self.connection.unchecked_transaction()?;
        let ids = tx
            .prepare(
                "SELECT job_id FROM projection_jobs WHERE completed=0 ORDER BY ordinal LIMIT ?1",
            )?
            .query_map([limit], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let jobs = ids
            .into_iter()
            .map(|id| get(&tx, &OperationId::new(id)?))
            .collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(jobs)
    }
}
