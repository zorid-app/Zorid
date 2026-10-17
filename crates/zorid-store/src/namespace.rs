//! Exact, retained physical namespace attempts. Only the native adapter supplies
//! filesystem evidence; this journal never discovers members or performs IO.
use super::*;
use std::collections::BTreeSet;
use zorid_core::{EntryChange, OperationId};

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("namespace_attempts", "CREATE TABLE namespace_attempts (job_id TEXT PRIMARY KEY NOT NULL REFERENCES projection_jobs(job_id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL)"),
];
pub const MAX_NAMESPACE_MEMBERS: usize = 10_000;
pub const MAX_NAMESPACE_EVIDENCE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceEvidence {
    pub before: EntryState,
    pub source_identity: String,
    pub source_parent_identity: String,
    pub destination_parent_identity: Option<String>,
    pub content: Option<Vec<u8>>,
    pub file_baseline: Option<ProjectionBaseline>,
    pub directory_baseline: Option<DirectoryBaseline>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceMember {
    pub change: EntryChange,
    pub evidence: NamespaceEvidence,
    pub directory_stage_identity: Option<String>,
    pub captured: bool,
    pub published: bool,
    pub finished: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceAttempt {
    /// Immutable job snapshot, including completed=false even after retirement.
    pub job: ProjectionJob,
    pub members: Vec<NamespaceMember>,
    pub completed: bool,
}
fn invalid(message: &str) -> StoreError {
    StoreError::Corrupt(message.into())
}
fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}
fn same_path(job: &ProjectionJob, member: &NamespaceMember) -> bool {
    job.work == ProjectionWork::Move && member.evidence.before.path == member.change.after.path
}
fn validate_member(job: &ProjectionJob, m: &NamespaceMember) -> Result<()> {
    let e = &m.evidence;
    if m.change.before.as_ref() != Some(&e.before)
        || e.before.deleted
        || e.before.id != m.change.after.id
        || e.before.kind != m.change.after.kind
        || !identity(&e.source_identity)
        || !identity(&e.source_parent_identity)
        || (e.before.kind == EntryKind::File) != e.content.is_some()
        || (job.work == ProjectionWork::Move && m.change.after.deleted)
        || (job.work == ProjectionWork::Delete
            && (!m.change.after.deleted || e.before.path != m.change.after.path))
    {
        return Err(invalid("invalid namespace member evidence"));
    }
    match e.before.kind {
        EntryKind::File => {
            if e.directory_baseline.is_some() || m.directory_stage_identity.is_some() {
                return Err(invalid("file has directory evidence"));
            }
            if let Some(base) = &e.file_baseline {
                if base.state.id != e.before.id
                    || base.state.path != e.before.path
                    || base.state.kind != EntryKind::File
                    || base.state.deleted
                    || Some(&base.content) != e.content.as_ref()
                {
                    return Err(invalid("file namespace baseline mismatch"));
                }
            }
        }
        EntryKind::Folder => {
            let base = e
                .directory_baseline
                .as_ref()
                .ok_or_else(|| invalid("directory requires existing inode provenance"))?;
            if e.file_baseline.is_some()
                || base.state.id != e.before.id
                || base.state.path != e.before.path
                || base.state.kind != EntryKind::Folder
                || base.state.deleted
                || base.identity != e.source_identity
            {
                return Err(invalid("directory namespace baseline mismatch"));
            }
            if m.directory_stage_identity
                .as_ref()
                .is_some_and(|id| !identity(id))
                || (m.directory_stage_identity.is_some()
                    && (job.work != ProjectionWork::Move || same_path(job, m)))
                || (m.published && !same_path(job, m) && m.directory_stage_identity.is_none())
            {
                return Err(invalid("invalid namespace directory stage"));
            }
        }
    }
    if e.destination_parent_identity
        .as_ref()
        .is_some_and(|id| !identity(id))
        || (job.work == ProjectionWork::Delete && e.destination_parent_identity.is_some())
    {
        return Err(invalid("invalid namespace destination parent proof"));
    }
    if job.work == ProjectionWork::Move && e.destination_parent_identity.is_none() {
        let parent = m.change.after.path.parent();
        if !job
            .affected
            .iter()
            .any(|c| c.after.kind == EntryKind::Folder && Some(&c.after.path) == parent.as_ref())
        {
            return Err(invalid("namespace destination parent proof missing"));
        }
    }
    if same_path(job, m) && (m.captured || m.published) {
        return Err(invalid("same-path move must not displace source"));
    }
    if job.work == ProjectionWork::Delete && m.published {
        return Err(invalid("delete cannot publish a destination"));
    }
    if m.published && !same_path(job, m) && !m.captured {
        return Err(invalid("namespace publication precedes capture"));
    }
    if m.finished
        && !same_path(job, m)
        && (!m.captured || (job.work == ProjectionWork::Move && !m.published))
    {
        return Err(invalid(
            "namespace member finished without physical progress",
        ));
    }
    Ok(())
}
fn validate(a: &NamespaceAttempt) -> Result<()> {
    if !matches!(a.job.work, ProjectionWork::Move | ProjectionWork::Delete)
        || a.job.completed
        || a.members.is_empty()
        || a.members.len() > MAX_NAMESPACE_MEMBERS
        || a.members.len() != a.job.affected.len()
        || (a.completed && a.members.iter().any(|m| !m.finished))
    {
        return Err(invalid("invalid namespace attempt"));
    }
    let mut ids = BTreeSet::new();
    let mut bytes = 0usize;
    for (m, change) in a.members.iter().zip(&a.job.affected) {
        if &m.change != change || !ids.insert(&m.evidence.before.id) {
            return Err(invalid("namespace members differ from exact job"));
        }
        validate_member(&a.job, m)?;
        for content in [
            m.evidence.content.as_ref(),
            m.evidence.file_baseline.as_ref().map(|b| &b.content),
        ]
        .into_iter()
        .flatten()
        {
            bytes = bytes
                .checked_add(content.len())
                .ok_or_else(|| invalid("namespace evidence overflow"))?;
        }
        if bytes > MAX_NAMESPACE_EVIDENCE_BYTES {
            return Err(invalid("namespace evidence exceeds limit"));
        }
    }
    Ok(())
}
fn get(tx: &Connection, id: &OperationId) -> Result<NamespaceAttempt> {
    let (done, json): (i64, String) = tx.query_row(
        "SELECT completed,record FROM namespace_attempts WHERE job_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let a: NamespaceAttempt = serde_json::from_str(&json)?;
    validate(&a)?;
    let mut job = projection_jobs::get(tx, id)?;
    if job.completed != a.completed {
        return Err(invalid("namespace job completion mismatch"));
    }
    job.completed = false;
    if a.job.job_id != *id || !matches!(done, 0 | 1) || a.completed != (done == 1) || job != a.job {
        return Err(invalid("namespace attempt columns or job mismatch"));
    }
    Ok(a)
}
fn put(tx: &Connection, a: &NamespaceAttempt) -> Result<()> {
    validate(a)?;
    tx.execute("INSERT INTO namespace_attempts(job_id,completed,record) VALUES(?1,?2,?3) ON CONFLICT(job_id) DO UPDATE SET completed=excluded.completed,record=excluded.record", params![a.job.job_id.as_str(),a.completed,serde_json::to_string(a)?])?;
    Ok(())
}
fn attempts(tx: &Connection, include_completed: bool) -> Result<Vec<NamespaceAttempt>> {
    let ids = tx
        .prepare("SELECT job_id FROM namespace_attempts WHERE ?1 OR completed=0 ORDER BY rowid")?
        .query_map([include_completed], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| get(tx, &OperationId::new(id)?))
        .collect()
}
fn jobs(tx: &Connection) -> Result<Vec<ProjectionJob>> {
    let ids = tx
        .prepare("SELECT job_id FROM projection_jobs ORDER BY ordinal")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let jobs = ids
        .into_iter()
        .map(|id| projection_jobs::get(tx, &OperationId::new(id)?))
        .collect::<Result<Vec<_>>>()?;
    Ok(jobs
        .into_iter()
        .filter(|j| matches!(j.work, ProjectionWork::Move | ProjectionWork::Delete))
        .collect())
}
fn directory_baseline(tx: &Connection, id: &EntryId) -> Result<Option<DirectoryBaseline>> {
    let json: Option<String> = tx
        .query_row(
            "SELECT record FROM directory_baselines WHERE entry_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    json.map(|s| {
        let b: DirectoryBaseline = serde_json::from_str(&s)?;
        if b.state.id != *id
            || b.state.kind != EntryKind::Folder
            || b.state.deleted
            || !identity(&b.identity)
        {
            return Err(invalid("invalid directory baseline"));
        }
        Ok(b)
    })
    .transpose()
}
fn entry(tx: &Connection, id: &EntryId) -> Result<(EntryState, Option<Vec<u8>>)> {
    let (path, deleted, json, content): (String, i64, String, Option<Vec<u8>>) = tx.query_row(
        "SELECT path,deleted,state,content FROM entries WHERE id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok((
        decode_state(id.as_str(), &path, deleted, &json, content.is_some())?,
        content,
    ))
}
fn check_baselines(tx: &Connection, e: &NamespaceEvidence) -> Result<()> {
    if projection::baseline(tx, &e.before.id)? != e.file_baseline
        || directory_baseline(tx, &e.before.id)? != e.directory_baseline
    {
        return Err(invalid("namespace baseline changed"));
    }
    Ok(())
}
impl Store {
    pub fn namespace_attempts(&self, include_completed: bool) -> Result<Vec<NamespaceAttempt>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = attempts(&tx, include_completed)?;
        tx.commit()?;
        Ok(result)
    }
    /// Includes completed and legacy jobs. A missing attempt is never permission
    /// to invent pre-commit evidence from the current filesystem.
    pub fn namespace_jobs(&self) -> Result<Vec<ProjectionJob>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = jobs(&tx)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn namespace_for_operation(
        &self,
        operation: &OperationId,
    ) -> Result<Option<NamespaceAttempt>> {
        Ok(self.namespace_attempts(true)?.into_iter().find(|a| matches!(&a.job.origin, ProjectionOrigin::LocalCommand { operation_id } if operation_id == operation)))
    }
    /// Native-only commit boundary: caller holds the vault filesystem lock and
    /// freshly observes these exact occupants before entering this transaction.
    /// Historical jobs cannot acquire new authority through this method.
    pub fn apply_namespace(
        &mut self,
        request: &MutationRequest,
        evidence: &[NamespaceEvidence],
    ) -> Result<CommitResult> {
        if !matches!(
            request.mutation,
            Mutation::Move { .. } | Mutation::Delete { .. }
        ) {
            return Err(invalid("expected namespace mutation"));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT request,result FROM operations WHERE operation_id=?1",
                [request.operation_id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((command, result)) = prior {
            let recorded = RecordedOperation {
                request: serde_json::from_str(&command)?,
                result: serde_json::from_str(&result)?,
            };
            check_idempotency(request, Some(&recorded))?;
            if !attempts(&tx,true)?.iter().any(|a| matches!(&a.job.origin,ProjectionOrigin::LocalCommand {operation_id} if operation_id == &request.operation_id)) { return Err(invalid("legacy namespace command lacks physical evidence")); }
            tx.commit()?;
            return Ok(recorded.result);
        }
        if evidence.is_empty() || evidence.len() > MAX_NAMESPACE_MEMBERS {
            return Err(invalid("invalid namespace evidence count"));
        }
        let mut evidence_bytes = 0usize;
        for e in evidence {
            for bytes in [
                e.content.as_ref(),
                e.file_baseline.as_ref().map(|b| &b.content),
            ]
            .into_iter()
            .flatten()
            {
                evidence_bytes = evidence_bytes
                    .checked_add(bytes.len())
                    .ok_or_else(|| invalid("namespace evidence overflow"))?;
                if evidence_bytes > MAX_NAMESPACE_EVIDENCE_BYTES {
                    return Err(invalid("namespace evidence exceeds limit"));
                }
            }
        }
        let mut ids = BTreeSet::new();
        let mut by_id = std::collections::BTreeMap::new();
        for e in evidence {
            by_id.insert(e.before.id.clone(), e);
            if !ids.insert(e.before.id.clone()) {
                return Err(invalid("duplicate namespace evidence"));
            }
            let (state, content) = entry(&tx, &e.before.id)?;
            if state != e.before || content != e.content {
                return Err(invalid("namespace preflight state/content changed"));
            }
            check_baselines(&tx, e)?;
            for table in ["projection_attempts", "directory_attempts"] {
                let query = format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE entry_id=?1 AND completed=0)"
                );
                if tx.query_row(&query, [e.before.id.as_str()], |r| r.get::<_, bool>(0))? {
                    return Err(invalid("member has active projection attempt"));
                }
            }
        }
        // Jobs are the authority even when a legacy job has no safe physical
        // attempt. Do not let new evidence silently supersede such responsibility.
        if jobs(&tx)?
            .iter()
            .filter(|j| !j.completed)
            .any(|j| j.affected.iter().any(|c| ids.contains(&c.after.id)))
        {
            return Err(invalid("overlapping pending namespace job"));
        }
        for id in &ids {
            for work in [
                ProjectionWork::MaterializeFile,
                ProjectionWork::CreateDirectory,
            ] {
                if !projection_jobs::pending(&tx, id, work)?.is_empty() {
                    return Err(invalid("member has pending publication job"));
                }
            }
        }
        let result = Self::apply_transaction(&tx, request)?;
        let job = jobs(&tx)?.into_iter().find(|j|matches!(&j.origin,ProjectionOrigin::LocalCommand {operation_id} if operation_id == &request.operation_id)).ok_or_else(||invalid("namespace job missing"))?;
        if job.affected.len() != evidence.len() {
            return Err(invalid("namespace evidence does not cover exact members"));
        }
        let members = job
            .affected
            .iter()
            .map(|change| {
                let e = *by_id
                    .get(&change.after.id)
                    .ok_or_else(|| invalid("namespace member evidence missing"))?;
                Ok(NamespaceMember {
                    change: change.clone(),
                    evidence: e.clone(),
                    directory_stage_identity: None,
                    captured: false,
                    published: false,
                    finished: false,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        put(
            &tx,
            &NamespaceAttempt {
                job,
                members,
                completed: false,
            },
        )?;
        tx.commit()?;
        Ok(result)
    }
    /// Compare-and-swap one member's progress; immutable evidence and job members
    /// cannot be reconstructed or rebound through this API.
    pub fn update_namespace_member(
        &mut self,
        job_id: &OperationId,
        expected: &NamespaceMember,
        next: &NamespaceMember,
    ) -> Result<NamespaceAttempt> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut a = get(&tx, job_id)?;
        if a.completed {
            return Err(invalid("namespace attempt complete"));
        }
        let index = a
            .members
            .iter()
            .position(|m| m.change.after.id == expected.change.after.id)
            .ok_or_else(|| invalid("namespace member absent"))?;
        if a.members[index] != *expected
            || expected.change != next.change
            || expected.evidence != next.evidence
            || (expected.captured && !next.captured)
            || (expected.published && !next.published)
            || (expected.finished && !next.finished)
            || expected
                .directory_stage_identity
                .as_ref()
                .is_some_and(|id| Some(id) != next.directory_stage_identity.as_ref())
        {
            return Err(invalid("namespace member progress/proof changed"));
        }
        a.members[index] = next.clone();
        put(&tx, &a)?;
        tx.commit()?;
        Ok(a)
    }
    pub fn finish_namespace(&mut self, job_id: &OperationId) -> Result<NamespaceAttempt> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut a = get(&tx, job_id)?;
        if a.completed {
            tx.commit()?;
            return Ok(a);
        }
        if a.members.iter().any(|m| !m.finished) {
            return Err(invalid("namespace members unfinished"));
        }
        for m in &a.members {
            check_baselines(&tx, &m.evidence)?;
            let (current, _) = entry(&tx, &m.change.after.id)?;
            let after = &m.change.after;
            if current.path != after.path
                || current.kind != after.kind
                || current.deleted != after.deleted
            {
                return Err(invalid("namespace desired location changed"));
            }
        }
        for m in &a.members {
            let after = &m.change.after;
            if a.job.work == ProjectionWork::Delete {
                tx.execute(
                    "DELETE FROM projection_baselines WHERE entry_id=?1",
                    [after.id.as_str()],
                )?;
                tx.execute(
                    "DELETE FROM directory_baselines WHERE entry_id=?1",
                    [after.id.as_str()],
                )?;
            } else if after.kind == EntryKind::File {
                projection::put_baseline(
                    &tx,
                    &ProjectionBaseline {
                        state: after.clone(),
                        content: m
                            .evidence
                            .content
                            .clone()
                            .ok_or_else(|| invalid("file evidence missing"))?,
                    },
                )?;
            } else {
                let physical = if same_path(&a.job, m) {
                    m.evidence.source_identity.clone()
                } else {
                    m.directory_stage_identity
                        .clone()
                        .ok_or_else(|| invalid("directory stage missing"))?
                };
                let base = DirectoryBaseline {
                    state: after.clone(),
                    identity: physical,
                };
                tx.execute("INSERT INTO directory_baselines(entry_id,record) VALUES(?1,?2) ON CONFLICT(entry_id) DO UPDATE SET record=excluded.record",params![after.id.as_str(),serde_json::to_string(&base)?])?;
            }
        }
        projection_jobs::finish(&tx, &a.job)?;
        a.completed = true;
        put(&tx, &a)?;
        tx.commit()?;
        Ok(a)
    }
}
