//! Filesystem provenance, stored in the SAME authority/transaction as mutations.
use super::*;
use zorid_core::{OperationId, VaultPath};

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("projection_baselines", "CREATE TABLE projection_baselines (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id), record TEXT NOT NULL)"),
    ("projection_attempts", "CREATE TABLE projection_attempts (attempt_id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL)"),
    ("active_projection", "CREATE UNIQUE INDEX active_projection ON projection_attempts(entry_id) WHERE completed = 0"),
    ("external_observations", "CREATE TABLE external_observations (observation_id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL)"),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionBaseline {
    pub state: EntryState,
    pub content: Vec<u8>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionPhase {
    Prepared,
    Staged,
    Displaced,
    Published,
    Complete,
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionAttempt {
    pub attempt_id: OperationId,
    pub target: ProjectionBaseline,
    pub baseline: Option<ProjectionBaseline>,
    /// Decimal string, including at native JSON boundaries.
    pub through_sequence: String,
    pub phase: ProjectionPhase,
    /// Adapter inode identity, persisted before publication. Never a content hash.
    pub stage_identity: Option<String>,
}
impl ProjectionAttempt {
    pub fn completed(&self) -> bool {
        matches!(
            self.phase,
            ProjectionPhase::Complete | ProjectionPhase::Cancelled
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalObservation {
    pub observation_id: OperationId,
    pub path: VaultPath,
    pub baseline: Option<ProjectionBaseline>,
    pub content: Vec<u8>,
    pub resolution: Option<OperationId>,
}
fn validate_baseline(value: &ProjectionBaseline, id: &str) -> Result<()> {
    if value.state.id.as_str() != id || value.state.deleted || value.state.kind != EntryKind::File {
        return Err(StoreError::Corrupt(
            "invalid projection file identity/kind/liveness".into(),
        ));
    }
    Ok(())
}
fn decode_attempt(
    id: &str,
    entry_id: &str,
    completed: i64,
    json: &str,
) -> Result<ProjectionAttempt> {
    let value: ProjectionAttempt = serde_json::from_str(json)?;
    validate_baseline(&value.target, entry_id)?;
    if let Some(base) = &value.baseline {
        validate_baseline(base, entry_id)?;
    }
    let sequence = value.through_sequence.parse::<i64>().ok();
    if value.attempt_id.as_str() != id
        || !matches!(completed, 0 | 1)
        || value.completed() != (completed == 1)
        || !sequence.is_some_and(|n| n > 0 && n.to_string() == value.through_sequence)
        || value
            .stage_identity
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
        || (matches!(
            value.phase,
            ProjectionPhase::Staged
                | ProjectionPhase::Displaced
                | ProjectionPhase::Published
                | ProjectionPhase::Complete
        ) && value.stage_identity.is_none())
    {
        return Err(StoreError::Corrupt(
            "invalid projection attempt columns/provenance".into(),
        ));
    }
    Ok(value)
}
fn decode_observation(id: &str, json: &str) -> Result<ExternalObservation> {
    let value: ExternalObservation = serde_json::from_str(json)?;
    if value.observation_id.as_str() != id {
        return Err(StoreError::Corrupt("observation identity mismatch".into()));
    }
    if let Some(base) = &value.baseline {
        validate_baseline(base, base.state.id.as_str())?;
        if base.state.path != value.path {
            return Err(StoreError::Corrupt(
                "observation baseline path mismatch".into(),
            ));
        }
    }
    Ok(value)
}
fn baseline(tx: &Connection, id: &EntryId) -> Result<Option<ProjectionBaseline>> {
    tx.query_row(
        "SELECT record FROM projection_baselines WHERE entry_id=?1",
        [id.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|s| {
        let value = serde_json::from_str(&s)?;
        validate_baseline(&value, id.as_str())?;
        Ok(value)
    })
    .transpose()
}
fn put_baseline(tx: &Connection, value: &ProjectionBaseline) -> Result<()> {
    validate_baseline(value, value.state.id.as_str())?;
    tx.execute("INSERT INTO projection_baselines(entry_id,record) VALUES (?1,?2) ON CONFLICT(entry_id) DO UPDATE SET record=excluded.record",
        params![value.state.id.as_str(), serde_json::to_string(value)?])?;
    Ok(())
}
fn put_attempt(tx: &Connection, value: &ProjectionAttempt) -> Result<()> {
    let json = serde_json::to_string(value)?;
    decode_attempt(
        value.attempt_id.as_str(),
        value.target.state.id.as_str(),
        i64::from(value.completed()),
        &json,
    )?;
    tx.execute("INSERT INTO projection_attempts(attempt_id,entry_id,completed,record) VALUES (?1,?2,?3,?4) ON CONFLICT(attempt_id) DO UPDATE SET completed=excluded.completed,record=excluded.record",
        params![value.attempt_id.as_str(), value.target.state.id.as_str(), value.completed(), json])?;
    Ok(())
}
fn attempt(tx: &Connection, id: &OperationId) -> Result<ProjectionAttempt> {
    let (entry, complete, s): (String, i64, String) = tx.query_row(
        "SELECT entry_id,completed,record FROM projection_attempts WHERE attempt_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    decode_attempt(id.as_str(), &entry, complete, &s)
}
/// Retire only file create/write requests actually represented by this baseline.
/// Ancestor revisions are metadata, so require no physical write; a folder create,
/// move or deletion remains queued, even if a descendant file was published.
fn retire_file(tx: &Connection, id: &EntryId, through: i64) -> Result<()> {
    let mut stmt = tx.prepare("SELECT q.sequence,o.request FROM projection_queue q JOIN operations o USING(sequence) WHERE q.sequence<=?1")?;
    let rows = stmt
        .query_map([through], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (seq, request) in rows {
        let req: MutationRequest = serde_json::from_str(&request)?;
        if matches!(&req.mutation, Mutation::Create { id: target, kind: EntryKind::File, .. } | Mutation::Write { id: target, .. } if target == id)
        {
            tx.execute("DELETE FROM projection_queue WHERE sequence=?1", [seq])?;
        }
    }
    Ok(())
}
impl Store {
    pub fn projection_baseline(&self, id: &EntryId) -> Result<Option<ProjectionBaseline>> {
        baseline(&self.connection, id)
    }
    /// Retained completed attempts account for retained recovery files. No GC yet.
    pub fn projection_attempts(&self, include_completed: bool) -> Result<Vec<ProjectionAttempt>> {
        let mut stmt = self.connection.prepare("SELECT attempt_id,entry_id,completed,record FROM projection_attempts WHERE ?1 OR completed=0 ORDER BY rowid")?;
        let rows = stmt
            .query_map([include_completed], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, entry, completed, s)| decode_attempt(&id, &entry, completed, &s))
            .collect()
    }
    pub fn begin_projection(&mut self, id: &EntryId) -> Result<ProjectionAttempt> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(s) = tx
            .query_row(
                "SELECT attempt_id FROM projection_attempts WHERE entry_id=?1 AND completed=0",
                [id.as_str()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return attempt(&tx, &OperationId::new(s)?);
        }
        let (path, deleted, s, bytes): (String, i64, String, Option<Vec<u8>>) = tx.query_row(
            "SELECT path,deleted,state,content FROM entries WHERE id=?1 AND deleted=0",
            [id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let state = decode_state(id.as_str(), &path, deleted, &s, bytes.is_some())?;
        let content = bytes.ok_or_else(|| {
            StoreError::Corrupt("only files can be projected by this adapter".into())
        })?;
        let seq: i64 = tx.query_row(
            "SELECT coalesce(max(sequence),0) FROM operations",
            [],
            |r| r.get(0),
        )?;
        let value = ProjectionAttempt {
            attempt_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            baseline: baseline(&tx, id)?,
            target: ProjectionBaseline { state, content },
            through_sequence: seq.to_string(),
            phase: ProjectionPhase::Prepared,
            stage_identity: None,
        };
        put_attempt(&tx, &value)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn mark_projection(
        &mut self,
        id: &OperationId,
        phase: ProjectionPhase,
        identity: Option<String>,
    ) -> Result<ProjectionAttempt> {
        if matches!(
            phase,
            ProjectionPhase::Complete | ProjectionPhase::Cancelled
        ) {
            return Err(StoreError::Corrupt(
                "use finish_projection for terminal phases".into(),
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut value = attempt(&tx, id)?;
        if value.completed() {
            return Err(StoreError::Corrupt("attempt already complete".into()));
        }
        if let Some(identity) = identity {
            if value
                .stage_identity
                .as_ref()
                .is_some_and(|old| old != &identity)
            {
                return Err(StoreError::Corrupt("stage identity changed".into()));
            }
            value.stage_identity = Some(identity);
        }
        value.phase = phase;
        put_attempt(&tx, &value)?;
        tx.commit()?;
        Ok(value)
    }
    /// `published` requires proof of the staged inode at the destination. The
    /// desired DB revision may have advanced: record what actually reached disk,
    /// and leave later projection intents pending. Cancellation retires nothing.
    pub fn finish_projection(&mut self, id: &OperationId, published: bool) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut value = attempt(&tx, id)?;
        if value.completed() {
            return Ok(());
        }
        if published {
            if value.stage_identity.is_none()
                || baseline(&tx, &value.target.state.id)? != value.baseline
            {
                return Err(StoreError::Corrupt("publication provenance changed".into()));
            }
            put_baseline(&tx, &value.target)?;
            let seq: i64 = value
                .through_sequence
                .parse()
                .map_err(|_| StoreError::Corrupt("invalid projection sequence".into()))?;
            retire_file(&tx, &value.target.state.id, seq)?;
        }
        value.phase = if published {
            ProjectionPhase::Complete
        } else {
            ProjectionPhase::Cancelled
        };
        put_attempt(&tx, &value)?;
        tx.commit()?;
        Ok(())
    }
    pub fn external_observations(&self) -> Result<Vec<ExternalObservation>> {
        let mut stmt = self
            .connection
            .prepare("SELECT observation_id,record FROM external_observations ORDER BY rowid")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, s)| decode_observation(&id, &s))
            .collect()
    }
    pub fn record_external(
        &mut self,
        path: &VaultPath,
        base: Option<ProjectionBaseline>,
        content: Vec<u8>,
    ) -> Result<ExternalObservation> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let records: Vec<(String, String)> = tx
            .prepare("SELECT observation_id,record FROM external_observations")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        for (id, record) in records {
            let old = decode_observation(&id, &record)?;
            if old.path == *path
                && old.baseline == base
                && old.content == content
                && old.resolution.is_none()
            {
                return Ok(old);
            }
        }
        let value = ExternalObservation {
            observation_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            path: path.clone(),
            baseline: base,
            content,
            resolution: None,
        };
        decode_observation(
            value.observation_id.as_str(),
            &serde_json::to_string(&value)?,
        )?;
        tx.execute(
            "INSERT INTO external_observations(observation_id,record) VALUES (?1,?2)",
            params![
                value.observation_id.as_str(),
                serde_json::to_string(&value)?
            ],
        )?;
        tx.commit()?;
        Ok(value)
    }
    /// Atomically turns an observed file into a mutation and the new disk baseline.
    /// A competing DB revision causes normal optimistic conflict; observation stays.
    pub fn import_observation(
        &mut self,
        id: &OperationId,
        request: &MutationRequest,
    ) -> Result<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s: String = tx.query_row(
            "SELECT record FROM external_observations WHERE observation_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        let mut obs = decode_observation(id.as_str(), &s)?;
        if obs
            .resolution
            .as_ref()
            .is_some_and(|op| op != &request.operation_id)
        {
            return Err(StoreError::Corrupt("observation already resolved".into()));
        }
        let valid = match (&request.mutation, &obs.baseline) {
            (
                Mutation::Create {
                    path,
                    kind: EntryKind::File,
                    content: Some(bytes),
                    ..
                },
                None,
            ) => *path == obs.path && *bytes == obs.content,
            (
                Mutation::Write {
                    id,
                    expected,
                    content,
                },
                Some(base),
            ) => {
                *id == base.state.id
                    && *expected == base.state.revision
                    && *content == obs.content
                    && obs.path == base.state.path
            }
            _ => false,
        };
        if !valid {
            return Err(StoreError::Corrupt(
                "import does not match observation provenance".into(),
            ));
        }
        let result = Self::apply_transaction(&tx, request)?;
        if obs.resolution.is_none() {
            if baseline(&tx, request.mutation.id())? != obs.baseline {
                return Err(StoreError::Corrupt("import baseline changed".into()));
            }
            let state = result
                .changes
                .iter()
                .find(|c| c.after.id == *request.mutation.id())
                .ok_or_else(|| StoreError::Corrupt("missing import state".into()))?
                .after
                .clone();
            put_baseline(
                &tx,
                &ProjectionBaseline {
                    state,
                    content: obs.content.clone(),
                },
            )?;
            retire_file(&tx, request.mutation.id(), result.sequence as i64)?;
            obs.resolution = Some(request.operation_id.clone());
            tx.execute(
                "UPDATE external_observations SET record=?1 WHERE observation_id=?2",
                params![serde_json::to_string(&obs)?, id.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(result)
    }
    /// Called only after the native adapter opened this existing directory safely.
    /// It retires precisely this folder creation, never other subtree operations.
    pub fn import_directory(&mut self, request: &MutationRequest) -> Result<CommitResult> {
        if !matches!(
            request.mutation,
            Mutation::Create {
                kind: EntryKind::Folder,
                ..
            }
        ) {
            return Err(StoreError::Corrupt("expected folder creation".into()));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = Self::apply_transaction(&tx, request)?;
        tx.execute(
            "DELETE FROM projection_queue WHERE sequence=?1",
            [result.sequence as i64],
        )?;
        tx.commit()?;
        Ok(result)
    }
    pub fn replay(&self, request: &MutationRequest) -> Result<Option<CommitResult>> {
        let snapshot = self.connection.unchecked_transaction()?;
        let prior = snapshot
            .query_row(
                "SELECT request,result FROM operations WHERE operation_id=?1",
                [request.operation_id.as_str()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let prior: Option<RecordedOperation> = prior
            .map(|(request, result)| -> Result<_> {
                Ok(RecordedOperation {
                    request: serde_json::from_str(&request)?,
                    result: serde_json::from_str(&result)?,
                })
            })
            .transpose()?;
        let result = match check_idempotency(request, prior.as_ref())? {
            IdempotencyCheck::New => None,
            IdempotencyCheck::Replay(r) => Some(r.clone()),
        };
        snapshot.commit()?;
        Ok(result)
    }
}
