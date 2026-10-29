//! Filesystem provenance, stored in the SAME authority/transaction as mutations.
use super::*;
use crate::physical_bindings::{
    self, ObservationPhysical, PhysicalIdentity, PublicationKind, PublicationProof,
};
use zorid_core::{OperationId, VaultPath};
use zorid_file_sync::Sha256Digest;

pub(super) const EXTERNAL_UNRESOLVED_INDEX: (&str, &str) = (
    "external_observation_unresolved_path",
    "CREATE INDEX external_observation_unresolved_path ON external_observations(json_extract(record,'$.path')) WHERE json_extract(record,'$.resolution') IS NULL",
);
pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("projection_baselines", "CREATE TABLE projection_baselines (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id), record TEXT NOT NULL)"),
    ("projection_attempts", "CREATE TABLE projection_attempts (attempt_id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), record TEXT NOT NULL)"),
    ("active_projection", "CREATE UNIQUE INDEX active_projection ON projection_attempts(entry_id) WHERE completed = 0"),
    ("external_observations", "CREATE TABLE external_observations (observation_id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL)"),
    EXTERNAL_UNRESOLVED_INDEX,
];

/// Old accepted schemas did not require an expression index. Reject malformed
/// JSON before WAL changes rather than fail midway through index creation.
pub(super) fn check_observation_index_inputs(connection: &Connection) -> Result<()> {
    let malformed: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM external_observations WHERE NOT json_valid(record))",
        [],
        |row| row.get(0),
    )?;
    if malformed {
        return Err(StoreError::Corrupt(
            "external observation JSON cannot be indexed".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionBaseline {
    pub state: EntryState,
    pub content: StoredContent,
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
    /// Exact immutable job IDs represented by this target; legacy cutoff is audit only.
    #[serde(default)]
    pub covered_jobs: Vec<OperationId>,
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
    pub content: StoredContent,
    pub resolution: Option<OperationId>,
}
fn validate_baseline(value: &ProjectionBaseline, id: &str) -> Result<()> {
    if value.state.id.as_str() != id
        || value.state.deleted
        || value.state.kind != EntryKind::File
        || matches!(
            &value.content,
            StoredContent::BinaryRef(BinarySourceRef::Capture(_))
        )
        || matches!(&value.content, StoredContent::BinaryRef(BinarySourceRef::Graph(reference)) if reference.identity.entry_id != value.state.id)
    {
        return Err(StoreError::Corrupt(
            "invalid projection file identity/kind/liveness".into(),
        ));
    }
    Ok(())
}
pub(super) fn decode_attempt(
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
    let unique: std::collections::BTreeSet<_> = value.covered_jobs.iter().collect();
    if unique.len() != value.covered_jobs.len() {
        return Err(StoreError::Corrupt(
            "duplicate covered projection job".into(),
        ));
    }
    let sequence = value.through_sequence.parse::<i64>().ok();
    if value.attempt_id.as_str() != id
        || !matches!(completed, 0 | 1)
        || value.completed() != (completed == 1)
        || !sequence.is_some_and(|n| n >= 0 && n.to_string() == value.through_sequence)
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
pub(super) fn decode_observation(id: &str, json: &str) -> Result<ExternalObservation> {
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
pub(super) fn decode_baseline(id: &str, raw: &str) -> Result<ProjectionBaseline> {
    let value = serde_json::from_str(raw)?;
    validate_baseline(&value, id)?;
    Ok(value)
}
pub(super) fn baseline(tx: &Connection, id: &EntryId) -> Result<Option<ProjectionBaseline>> {
    tx.query_row(
        "SELECT record FROM projection_baselines WHERE entry_id=?1",
        [id.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|raw| decode_baseline(id.as_str(), &raw))
    .transpose()
}
pub(super) fn put_baseline(tx: &Connection, value: &ProjectionBaseline) -> Result<()> {
    validate_baseline(value, value.state.id.as_str())?;
    entry_content::validate_stored_content(tx, &value.content, false)?;
    family_materialization::check_publication_content(tx, &value.state, Some(&value.content))?;
    // An unbound baseline replacement must never retain stale inode authority.
    physical_bindings::remove_binding(tx, &value.state.id)?;
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
/// The authorization boundary lives in each caller. This common transaction
/// records only the immutable historical target and exact covered file jobs.
fn finish_attempt(
    tx: &Connection,
    mut value: ProjectionAttempt,
    published: bool,
    physical: Option<&PhysicalIdentity>,
) -> Result<()> {
    if published {
        family_materialization::check_publication_content(
            tx,
            &value.target.state,
            Some(&value.target.content),
        )?;
        if value.stage_identity.is_none() || baseline(tx, &value.target.state.id)? != value.baseline
        {
            return Err(StoreError::Corrupt("publication provenance changed".into()));
        }
        let proof = physical_bindings::publication_proof(tx, &value.attempt_id)?;
        match (&proof, physical) {
            (Some(proof), Some(physical))
                if proof.kind == PublicationKind::File
                    && proof.entry_id == value.target.state.id
                    && proof.parent_inode == physical.parent_inode
                    && value.stage_identity.as_ref() == Some(&physical.inode) =>
            {
                physical_bindings::check_binding(
                    tx,
                    &value.target.state.id,
                    proof.expected_binding.as_ref(),
                )?;
            }
            (None, None) => {}
            _ => {
                return Err(StoreError::Corrupt(
                    "file publication binding mismatch".into(),
                ))
            }
        }
        put_baseline(tx, &value.target)?;
        if let Some(physical) = physical {
            physical_bindings::put_binding(
                tx,
                &physical_bindings::PhysicalBinding {
                    state: value.target.state.clone(),
                    physical: physical.clone(),
                },
            )?;
        }
        projection_jobs::retire_file(tx, &value.target.state.id, &value.covered_jobs)?;
    }
    value.phase = if published {
        ProjectionPhase::Complete
    } else {
        ProjectionPhase::Cancelled
    };
    put_attempt(tx, &value)?;
    Ok(())
}

/// A hidden or relocated family entry may settle its earlier publication only
/// when an unclaimed namespace obligation still owns responsibility for it.
fn check_namespace_handoff(
    tx: &Connection,
    expected: &ProjectionAttempt,
) -> Result<ProjectionAttempt> {
    let value = attempt(tx, &expected.attempt_id)?;
    if value.completed() || value != *expected {
        return Err(StoreError::Corrupt(
            "namespace publication attempt changed".into(),
        ));
    }
    namespace::check_projection_handoff(tx, &value.target.state.id)?;
    let proof = physical_bindings::publication_proof(tx, &value.attempt_id)?
        .ok_or_else(|| StoreError::Corrupt("namespace publication has no physical proof".into()))?;
    if proof.kind != PublicationKind::File
        || proof.entry_id != value.target.state.id
        || baseline(tx, &value.target.state.id)? != value.baseline
    {
        return Err(StoreError::Corrupt(
            "namespace publication provenance changed".into(),
        ));
    }
    physical_bindings::check_binding(tx, &value.target.state.id, proof.expected_binding.as_ref())?;
    Ok(value)
}

/// Retire only file create/write requests actually represented by this baseline.
/// Ancestor revisions are metadata, so require no physical write; a folder create,
/// move or deletion remains queued, even if a descendant file was published.

impl Store {
    pub const PROJECTION_RECOVERY_MAX_STATES: usize = 64;

    /// Check an ordered, bounded file-state page through its first missing or
    /// stale baseline. Every visited record uses the complete baseline decoder
    /// and identity/content validation; this is not a projection authorization.
    /// Stopping before the first dirty entry preserves recovery's publication
    /// order when a later baseline is corrupt. Only one encoded/decoded baseline
    /// is retained at a time, rather than all of a vault's saved file contents.
    pub fn projection_clean_prefix(&self, states: &[EntryState]) -> Result<usize> {
        if states.len() > Self::PROJECTION_RECOVERY_MAX_STATES {
            return Err(StoreError::Contract(ContractError::InvalidMutation {
                reason: "Projection recovery page exceeds its state limit".into(),
            }));
        }
        if states.is_empty() {
            return Ok(0);
        }
        if states.iter().any(|state| state.kind != EntryKind::File || state.deleted) {
            return Err(StoreError::Corrupt("projection recovery requires live file states".into()));
        }
        let ids = serde_json::to_string(&states.iter().map(|state| state.id.as_str()).collect::<Vec<_>>())?;
        // json_each is the LEFT JOIN's outer input, so SQLite visits its array
        // rows before the indexed baseline lookup. Do not sort full baseline
        // records into a temporary table: one record may contain a large file.
        // Check the returned ordinal as well; unexpected ordering fails closed.
        let mut statement = self.connection.prepare(
            "SELECT requested.key,saved.record FROM json_each(?1) AS requested LEFT JOIN projection_baselines AS saved ON saved.entry_id=requested.value",
        )?;
        let mut rows = statement.query([ids])?;
        for (index, state) in states.iter().enumerate() {
            let row = rows.next()?.ok_or_else(|| StoreError::Corrupt("projection recovery row missing".into()))?;
            let ordinal: i64 = row.get(0)?;
            if ordinal != index as i64 {
                return Err(StoreError::Corrupt("projection recovery rows are out of order".into()));
            }
            let raw: Option<String> = row.get(1)?;
            let Some(raw) = raw else { return Ok(index); };
            let value = decode_baseline(state.id.as_str(), &raw)?;
            if value.state != *state {
                return Ok(index);
            }
        }
        if rows.next()?.is_some() {
            return Err(StoreError::Corrupt("projection recovery has extra rows".into()));
        }
        Ok(states.len())
    }

    pub fn projection_baseline(&self, id: &EntryId) -> Result<Option<ProjectionBaseline>> {
        baseline(&self.connection, id)
    }
    /// Read one validated historical attempt without scanning every saved job.
    pub fn projection_attempt(&self, id: &OperationId) -> Result<ProjectionAttempt> {
        attempt(&self.connection, id)
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
    /// Scheduling metadata only. Publication callers must point-read and fully
    /// validate an admitted attempt before acting on it; no retained body is
    /// decoded while selecting unrelated work.
    pub fn projection_attempt_ids(&self, include_completed: bool) -> Result<Vec<OperationId>> {
        let mut statement = self.connection.prepare(
            "SELECT attempt_id FROM projection_attempts WHERE ?1 OR completed=0 ORDER BY rowid",
        )?;
        let rows = statement
            .query_map([include_completed], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|id| {
                OperationId::new(id)
                    .map_err(|_| StoreError::Corrupt("invalid projection attempt identity".into()))
            })
            .collect()
    }
    /// Active-attempt scheduling for one entry, independently of the number or
    /// size of other entries' pending bodies. The selected attempt stays subject
    /// to the unchanged full `projection_attempt` decoder.
    pub fn projection_attempt_ids_for_entry(&self, id: &EntryId) -> Result<Vec<OperationId>> {
        let mut statement = self.connection.prepare("SELECT attempt_id FROM projection_attempts WHERE entry_id=?1 AND completed=0 ORDER BY rowid")?;
        let rows = statement
            .query_map([id.as_str()], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|id| {
                OperationId::new(id)
                    .map_err(|_| StoreError::Corrupt("invalid projection attempt identity".into()))
            })
            .collect()
    }
    pub fn begin_projection(&mut self, id: &EntryId) -> Result<ProjectionAttempt> {
        self.begin_projection_inner(id, None)
    }
    /// Native publication records its anchored parent and prior physical binding
    /// in the same transaction as the attempt, before any filesystem mutation.
    pub fn begin_projection_bound(
        &mut self,
        id: &EntryId,
        parent_inode: &str,
    ) -> Result<ProjectionAttempt> {
        self.begin_projection_inner(id, Some(parent_inode))
    }
    fn begin_projection_inner(
        &mut self,
        id: &EntryId,
        parent_inode: Option<&str>,
    ) -> Result<ProjectionAttempt> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Hidden retained entries keep their active attempt and private bytes.
        // Check before returning an existing attempt, not only at target lookup.
        if !is_visible(&tx, id)? {
            return Err(ContractError::InvalidMutation {
                reason: "hidden entry cannot begin physical publication".into(),
            }
            .into());
        }
        if let Some(s) = tx
            .query_row(
                "SELECT attempt_id FROM projection_attempts WHERE entry_id=?1 AND completed=0",
                [id.as_str()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            let value = attempt(&tx, &OperationId::new(s)?)?;
            if let Some(parent_inode) = parent_inode {
                let proof = physical_bindings::publication_proof(&tx, &value.attempt_id)?
                    .ok_or_else(|| {
                        StoreError::Corrupt("unproven active file publication".into())
                    })?;
                if proof.parent_inode != parent_inode {
                    return Err(StoreError::Corrupt("publication parent changed".into()));
                }
            }
            return Ok(value);
        }
        let (state, content) = entry_content::read_content_entry(&tx, id)?
            .ok_or_else(|| StoreError::Corrupt("projection target is missing".into()))?;
        if state.deleted {
            return Err(StoreError::Corrupt("projection target is deleted".into()));
        }
        let content = content.ok_or_else(|| {
            StoreError::Corrupt("only files can be projected by this adapter".into())
        })?;
        entry_content::validate_stored_content(&tx, &content, false)?;
        family_materialization::check_publication_content(&tx, &state, Some(&content))?;
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
            covered_jobs: projection_jobs::pending(&tx, id, ProjectionWork::MaterializeFile)?
                .into_iter()
                .map(|job| job.job_id)
                .collect(),
            phase: ProjectionPhase::Prepared,
            stage_identity: None,
        };
        put_attempt(&tx, &value)?;
        if let Some(parent_inode) = parent_inode {
            let expected_binding = physical_bindings::binding(&tx, id)?;
            if value.baseline.as_ref().map(|b| &b.state)
                != expected_binding.as_ref().map(|b| &b.state)
                || expected_binding
                    .as_ref()
                    .is_some_and(|b| b.physical.parent_inode != parent_inode)
            {
                return Err(StoreError::Corrupt(
                    "file baseline has no matching physical binding".into(),
                ));
            }
            physical_bindings::put_publication_proof(
                &tx,
                &PublicationProof {
                    attempt_id: value.attempt_id.clone(),
                    kind: PublicationKind::File,
                    entry_id: id.clone(),
                    expected_binding,
                    parent_inode: parent_inode.into(),
                },
            )?;
        }
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
        if !is_visible(&tx, &value.target.state.id)? {
            return Err(ContractError::InvalidMutation {
                reason: "hidden entry retains its pending publication".into(),
            }
            .into());
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
        self.finish_projection_inner(id, published, None)
    }
    pub fn finish_projection_bound(
        &mut self,
        id: &OperationId,
        physical: &PhysicalIdentity,
    ) -> Result<()> {
        self.finish_projection_inner(id, true, Some(physical))
    }
    fn finish_projection_inner(
        &mut self,
        id: &OperationId,
        published: bool,
        physical: Option<&PhysicalIdentity>,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = attempt(&tx, id)?;
        if value.completed() {
            return Ok(());
        }
        if !is_visible(&tx, &value.target.state.id)? {
            return Err(ContractError::InvalidMutation {
                reason: "hidden entry retains its pending publication".into(),
            }
            .into());
        }
        finish_attempt(&tx, value, published, physical)?;
        tx.commit()?;
        Ok(())
    }
    /// Read-only preflight before the native adapter restores an unpublished
    /// baseline or acknowledges a stage already published at the old path.
    pub fn check_projection_for_namespace(&self, expected: &ProjectionAttempt) -> Result<()> {
        let tx = self.connection.unchecked_transaction()?;
        check_namespace_handoff(&tx, expected)?;
        tx.commit()?;
        Ok(())
    }
    /// Settle an exact active file attempt so pending family namespace work can
    /// take over its source. Native proves the old-path occupant before calling:
    /// Some is the published stage; None means unpublished/restored baseline.
    /// Cancellation preserves every baseline, binding, and covered file job.
    pub fn finish_projection_for_namespace(
        &mut self,
        expected: &ProjectionAttempt,
        published: Option<&PhysicalIdentity>,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = check_namespace_handoff(&tx, expected)?;
        finish_attempt(&tx, value, published.is_some(), published)?;
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
        self.record_external_inner(path, base, content, None)
    }
    /// A safely opened public path observation. Retained private alternatives
    /// must use record_external, which conveys no public-path inode authority.
    pub fn record_external_bound(
        &mut self,
        path: &VaultPath,
        base: Option<ProjectionBaseline>,
        content: Vec<u8>,
        proof: &ObservationPhysical,
    ) -> Result<ExternalObservation> {
        self.record_external_inner(path, base, content, Some(proof))
    }
    fn record_external_inner(
        &mut self,
        path: &VaultPath,
        base: Option<ProjectionBaseline>,
        content: Vec<u8>,
        proof: Option<&ObservationPhysical>,
    ) -> Result<ExternalObservation> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = record_external_transaction(
            &tx,
            path,
            base,
            StoredContent::InlineBytes(content),
            proof,
        )?;
        tx.commit()?;
        Ok(value)
    }
    /// Find an unresolved original observation before allocating another capture.
    /// This is identity reuse, not byte verification or import authorization.
    /// Lookup work is finite: 4096 exact-path unresolved candidates, at most
    /// 64 MiB per encoded row and 128 MiB in aggregate. Overflow is explicit;
    /// these read limits neither prune retained records nor impose a write quota.
    pub fn find_matching_external_observation(
        &self,
        client: &OperationId,
        path: &VaultPath,
        baseline: Option<&ProjectionBaseline>,
        physical: Option<&ObservationPhysical>,
        content_length: u64,
        digest: &Sha256Digest,
    ) -> Result<Option<ExternalObservation>> {
        const MAX_CANDIDATES: i64 = 4096;
        const MAX_ROW_BYTES: i64 = 64 * 1024 * 1024;
        const MAX_LOOKUP_BYTES: i64 = 128 * 1024 * 1024;
        let snapshot = self.connection.unchecked_transaction()?;
        // Filter the original path and unresolved state before applying work
        // limits. Baselines and proofs are compared as decoded typed values.
        let (count, largest, total): (i64, i64, i64) = snapshot.query_row(
            "SELECT count(*),coalesce(max(length(CAST(record AS BLOB))),0),coalesce(sum(length(CAST(record AS BLOB))),0) FROM external_observations WHERE json_extract(record,'$.path')=?1 AND json_extract(record,'$.resolution') IS NULL",
            [path.as_str()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if count > MAX_CANDIDATES || largest > MAX_ROW_BYTES || total > MAX_LOOKUP_BYTES {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        let found = {
            let mut statement = snapshot.prepare(
                "SELECT observation_id,record FROM external_observations WHERE json_extract(record,'$.path')=?1 AND json_extract(record,'$.resolution') IS NULL ORDER BY rowid",
            )?;
            let mut rows = statement.query([path.as_str()])?;
            let mut found = None;
            while let Some(row) = rows.next()? {
                let id: String = row.get(0)?;
                let raw: String = row.get(1)?;
                let observation = decode_observation(&id, &raw)?;
                if observation.path != *path
                    || observation.resolution.is_some()
                    || observation.baseline.as_ref() != baseline
                    || observation.content.len() != content_length
                {
                    continue;
                }
                if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) =
                    &observation.content
                {
                    if &capture.stage.client_id != client {
                        continue;
                    }
                }
                if physical_bindings::observation_proof(&snapshot, &observation.observation_id)?
                    .as_ref()
                    != physical
                    || &observation.content.digest() != digest
                {
                    continue;
                }
                entry_content::validate_stored_content(&snapshot, &observation.content, true)?;
                found = Some(observation);
                break;
            }
            found
        };
        snapshot.commit()?;
        Ok(found)
    }
    /// Retain an inert source. Physical authority is supplied only for an exact
    /// safely opened public path; private alternatives pass None.
    pub fn retain_external_content(
        &mut self,
        client: &OperationId,
        path: &VaultPath,
        baseline: Option<&ProjectionBaseline>,
        content: &StoredContent,
        physical: Option<&ObservationPhysical>,
    ) -> Result<ExternalObservation> {
        fn check_capture(
            tx: &Connection,
            client: &OperationId,
            path: &VaultPath,
            content: &StoredContent,
        ) -> Result<()> {
            if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content {
                if &capture.stage.client_id != client {
                    return Err(ContractError::IdempotencyConflict {
                        operation_id: capture.stage.operation_id.clone(),
                    }
                    .into());
                }
                entry_content::validate_captured_at(tx, capture, path)?;
            }
            Ok(())
        }
        // Verify complete bytes under a read snapshot, before taking the writer
        // lock. The short journal transaction rechecks immutable source identity.
        let snapshot = self.connection.unchecked_transaction()?;
        if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content {
            if &capture.stage.client_id != client {
                return Err(ContractError::IdempotencyConflict {
                    operation_id: capture.stage.operation_id.clone(),
                }
                .into());
            }
        }
        if let Some(original) =
            replay_capture_observation(&snapshot, path, baseline, content, physical)?
        {
            snapshot.commit()?;
            return Ok(original);
        }
        check_capture(&snapshot, client, path, content)?;
        entry_content::verify_stored_content(&snapshot, content)?;
        snapshot.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(original) = replay_capture_observation(&tx, path, baseline, content, physical)?
        {
            tx.commit()?;
            return Ok(original);
        }
        check_capture(&tx, client, path, content)?;
        entry_content::validate_stored_content(&tx, content, true)?;
        if let Some(proof) = physical {
            if let Some(base) = baseline {
                if self::baseline(&tx, &base.state.id)?.as_ref() != Some(base) {
                    return Err(StoreError::Corrupt(
                        "retained observation baseline changed".into(),
                    ));
                }
                physical_bindings::check_binding(
                    &tx,
                    &base.state.id,
                    proof.expected_binding.as_ref(),
                )?;
            }
        }
        let value =
            record_external_transaction(&tx, path, baseline.cloned(), content.clone(), physical)?;
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
            ) => *path == obs.path && obs.content.inline_bytes() == Some(bytes.as_slice()),
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
                    && obs.content.inline_bytes() == Some(content.as_slice())
                    && obs.path == base.state.path
            }
            _ => false,
        };
        if !valid {
            return Err(StoreError::Corrupt(
                "import does not match observation provenance".into(),
            ));
        }
        let physical = if obs.resolution.is_none() {
            physical_bindings::check_observation(&tx, id, request.mutation.id())?
        } else {
            None
        };
        let result = Self::apply_transaction_observed(&tx, request, &obs)?;
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
                    state: state.clone(),
                    content: obs.content.clone(),
                },
            )?;
            physical_bindings::put_observed_binding(&tx, &state, physical.as_ref())?;
            let jobs = projection_jobs::pending(
                &tx,
                request.mutation.id(),
                ProjectionWork::MaterializeFile,
            )?
            .into_iter()
            .map(|job| job.job_id)
            .collect::<Vec<_>>();
            projection_jobs::retire_file(&tx, request.mutation.id(), &jobs)?;
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
        projection_jobs::retire_local(&tx, &request.operation_id)?;
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
        let result = prior
            .map(|(raw, result)| {
                operation_request::replay_inline_with_mode(request, None, &raw, &result)
            })
            .transpose()?;
        snapshot.commit()?;
        Ok(result)
    }
}

fn replay_capture_observation(
    tx: &Connection,
    path: &VaultPath,
    baseline: Option<&ProjectionBaseline>,
    content: &StoredContent,
    proof: Option<&ObservationPhysical>,
) -> Result<Option<ExternalObservation>> {
    let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content else {
        return Ok(None);
    };
    let id = &capture.stage.operation_id;
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM external_observations WHERE observation_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let original = decode_observation(id.as_str(), &raw)?;
    if &original.path != path
        || original.baseline.as_ref() != baseline
        || &original.content != content
        || physical_bindings::observation_proof(tx, id)?.as_ref() != proof
    {
        return Err(ContractError::IdempotencyConflict {
            operation_id: id.clone(),
        }
        .into());
    }
    Ok(Some(original))
}

/// Enclosing transaction owns the matching causal/physical commit.
pub(super) fn record_external_transaction(
    tx: &Connection,
    path: &VaultPath,
    base: Option<ProjectionBaseline>,
    content: StoredContent,
    proof: Option<&ObservationPhysical>,
) -> Result<ExternalObservation> {
    if let Some(original) = replay_capture_observation(tx, path, base.as_ref(), &content, proof)? {
        return Ok(original);
    }
    entry_content::validate_stored_content(tx, &content, true)?;
    if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = &content {
        entry_content::validate_captured_at(tx, capture, path)?;
    }
    if let Some(baseline) = &base {
        validate_baseline(baseline, baseline.state.id.as_str())?;
        entry_content::validate_stored_content(tx, &baseline.content, false)?;
    }
    if !matches!(
        &content,
        StoredContent::BinaryRef(BinarySourceRef::Capture(_))
    ) {
        // The index selects candidates only. Identity reuse still requires all
        // typed causal/byte/physical proofs. Stream one candidate at a time: an
        // unrelated or resolved retained history is neither a lookup nor a DB audit.
        let mut statement = tx.prepare(
            "SELECT observation_id,record FROM external_observations WHERE json_extract(record,'$.path')=?1 AND json_extract(record,'$.resolution') IS NULL ORDER BY rowid",
        )?;
        let mut rows = statement.query([path.as_str()])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let record: String = row.get(1)?;
            let old = decode_observation(&id, &record)?;
            if old.path == *path
                && old.resolution.is_none()
                && old.baseline == base
                && old.content == content
                && physical_bindings::observation_proof(tx, &old.observation_id)?.as_ref() == proof
            {
                return Ok(old);
            }
        }
    }
    let value = ExternalObservation {
        observation_id: match &content {
            StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) => {
                capture.stage.operation_id.clone()
            }
            _ => OperationId::new(uuid::Uuid::new_v4().to_string())?,
        },
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
    if let Some(proof) = proof {
        physical_bindings::put_observation_proof(tx, &value.observation_id, proof)?;
    }
    Ok(value)
}

#[cfg(test)]
mod typed_content_tests {
    use super::*;
    use crate::blob_stage::BinaryCaptureRequest;
    use zorid_file_sync::{EntryIdentity, Manifest, Scope, Sha256Digest};
    use zorid_sync_protocol::{RealmId, UpdateId, VaultId};
    fn op(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn scope() -> Scope {
        Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        }
    }
    fn state() -> EntryState {
        EntryState {
            id: EntryId::new("entry").unwrap(),
            path: VaultPath::new("empty.bin").unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("revision").unwrap(),
            deleted: false,
        }
    }
    #[test]
    fn empty_binary_baseline_retains_graph_identity() {
        let state = state();
        let baseline = ProjectionBaseline {
            content: StoredContent::BinaryRef(BinarySourceRef::Graph(PublishedBinaryRef {
                scope: scope(),
                identity: EntryIdentity {
                    entry_id: state.id.clone(),
                    bootstrap_id: UpdateId::new("bootstrap").unwrap(),
                },
                selected_event: UpdateId::new("content").unwrap(),
                manifest: Manifest {
                    bytes: 0,
                    digest: Sha256Digest::of(&[]),
                    pages: vec![],
                },
            })),
            state,
        };
        validate_baseline(&baseline, "entry").unwrap();
        assert_eq!(baseline.content.len(), 0);
        assert!(baseline.content.inline_bytes().is_none());
        assert_eq!(
            serde_json::from_str::<ProjectionBaseline>(&serde_json::to_string(&baseline).unwrap())
                .unwrap(),
            baseline
        );
    }
    #[test]
    fn sealed_capture_retention_stays_unbound_and_cannot_be_desired() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        let scope = scope();
        store
            .family_enroll(&FamilyScope {
                realm_id: scope.realm_id,
                vault_id: scope.vault_id,
            })
            .unwrap();
        let client = op("client");
        let path = VaultPath::new("empty.bin").unwrap();
        let stage = store
            .begin_binary_capture(
                &client,
                &op("capture"),
                &BinaryCaptureRequest {
                    path: path.clone(),
                    expected_length: 0,
                    expected_digest: Sha256Digest::of(&[]),
                },
                StreamingLimits {
                    max_active_stages: 2,
                    max_stage_records: 4,
                    max_staged_bytes: 1024 * 1024,
                    max_chunk_records: 8,
                    max_page_records: 4,
                },
            )
            .unwrap();
        store.seal_binary_stage(&stage, 0, None).unwrap();
        let content = StoredContent::BinaryRef(BinarySourceRef::Capture(
            store.captured_binary_ref(&stage).unwrap(),
        ));
        assert!(store
            .retain_external_content(&op("other"), &path, None, &content, None)
            .is_err());
        let observed = store
            .retain_external_content(&client, &path, None, &content, None)
            .unwrap();
        assert_eq!(observed.content, content);
        assert_eq!(observed.observation_id, *stage.operation_id());
        assert_eq!(
            store
                .find_matching_external_observation(
                    &client,
                    &path,
                    None,
                    None,
                    0,
                    &Sha256Digest::of(&[])
                )
                .unwrap(),
            Some(observed.clone())
        );
        assert!(store
            .find_matching_external_observation(
                &op("other"),
                &path,
                None,
                None,
                0,
                &Sha256Digest::of(&[])
            )
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .retain_external_content(&client, &path, None, &content, None)
                .unwrap(),
            observed
        );
        assert!(matches!(
            store.retain_external_content(
                &client,
                &VaultPath::new("different.bin").unwrap(),
                None,
                &content,
                None
            ),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
        let changed_proof = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "public".into(),
                parent_inode: "parent".into(),
            },
            expected_binding: None,
        };
        assert!(matches!(
            store.retain_external_content(&client, &path, None, &content, Some(&changed_proof)),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
        assert!(
            physical_bindings::observation_proof(&store.connection, &observed.observation_id)
                .unwrap()
                .is_none()
        );
        let target = ProjectionBaseline {
            state: state(),
            content,
        };
        assert!(validate_baseline(&target, "entry").is_err());
        assert!(put_baseline(&store.connection, &target).is_err());
        assert_eq!(store.external_observations().unwrap(), vec![observed]);
    }
    #[test]
    fn matching_inline_observation_reuses_original_context_and_identity() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        let path = VaultPath::new("new.txt").unwrap();
        let bytes = b"original";
        let original = store.record_external(&path, None, bytes.to_vec()).unwrap();
        let digest = Sha256Digest::of(bytes);
        assert_eq!(
            store
                .find_matching_external_observation(
                    &op("client"),
                    &path,
                    None,
                    None,
                    bytes.len() as u64,
                    &digest
                )
                .unwrap(),
            Some(original.clone())
        );
        let changed_proof = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "other".into(),
                parent_inode: "parent".into(),
            },
            expected_binding: None,
        };
        assert!(store
            .find_matching_external_observation(
                &op("client"),
                &path,
                None,
                Some(&changed_proof),
                bytes.len() as u64,
                &digest
            )
            .unwrap()
            .is_none());
        assert!(store
            .find_matching_external_observation(
                &op("client"),
                &path,
                None,
                None,
                bytes.len() as u64,
                &Sha256Digest::of(b"changed")
            )
            .unwrap()
            .is_none());
        let baseline = ProjectionBaseline {
            state: state(),
            content: StoredContent::InlineBytes(bytes.to_vec()),
        };
        assert!(store
            .find_matching_external_observation(
                &op("client"),
                &path,
                Some(&baseline),
                None,
                bytes.len() as u64,
                &digest
            )
            .unwrap()
            .is_none());
        assert_eq!(store.external_observations().unwrap(), vec![original]);
    }
    #[test]
    fn observation_lookup_overflow_is_explicit_instead_of_no_match() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        let path = VaultPath::new("overfull.txt").unwrap();
        let original = store.record_external(&path, None, vec![]).unwrap();
        // Structurally valid retained records exercise only read-work policy.
        let raw = serde_json::to_string(&original).unwrap();
        store.connection.execute(
            "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<4096) INSERT INTO external_observations(observation_id,record) SELECT 'retained-'||value,json_set(?1,'$.observation_id','retained-'||value) FROM n",
            [raw],
        ).unwrap();
        assert!(matches!(
            store.find_matching_external_observation(
                &op("client"),
                &path,
                None,
                None,
                0,
                &Sha256Digest::of(&[])
            ),
            Err(StoreError::FileSync(zorid_file_sync::Error::TooLarge))
        ));
        // Existing bounded read policy must not become a new write quota.
        assert_eq!(
            store.record_external(&path, None, vec![]).unwrap(),
            original
        );
        assert_ne!(
            store
                .record_external(&path, None, b"different".to_vec())
                .unwrap()
                .observation_id,
            original.observation_id
        );
    }
    #[test]
    fn record_lookup_skips_large_unrelated_and_resolved_history_without_decoding_it() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        // Valid JSON but intentionally not a typed observation: any decode of
        // these retained bodies would fail. They precede the new candidate.
        for resolved in [false, true] {
            store.connection.execute(
                "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<64) INSERT INTO external_observations(observation_id,record) SELECT ?1||value,json_object('path',CASE WHEN ?2 THEN 'selected.txt' ELSE 'unrelated-'||value END,'resolution',CASE WHEN ?2 THEN 'resolved' ELSE NULL END,'unrelated_payload',replace(hex(zeroblob(16384)),'00','x')) FROM n",
                params![if resolved {"resolved-"} else {"unrelated-"},resolved],
            ).unwrap();
        }
        let retained: Vec<(String, String)> = store
            .connection
            .prepare("SELECT observation_id,record FROM external_observations ORDER BY rowid")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(retained.len(), 128);
        let path = VaultPath::new("selected.txt").unwrap();
        let first = store
            .record_external(&path, None, b"selected bytes".to_vec())
            .unwrap();
        assert_eq!(
            store
                .record_external(&path, None, b"selected bytes".to_vec())
                .unwrap(),
            first
        );
        assert_eq!(
            store
                .find_matching_external_observation(
                    &op("client"),
                    &path,
                    None,
                    None,
                    14,
                    &Sha256Digest::of(b"selected bytes")
                )
                .unwrap(),
            Some(first)
        );
        for (id, raw) in retained {
            assert_eq!(
                store
                    .connection
                    .query_row(
                        "SELECT record FROM external_observations WHERE observation_id=?1",
                        [id],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                raw
            );
        }
        let plans: Vec<String> = store.connection.prepare("EXPLAIN QUERY PLAN SELECT observation_id,record FROM external_observations WHERE json_extract(record,'$.path')=?1 AND json_extract(record,'$.resolution') IS NULL ORDER BY rowid").unwrap().query_map([path.as_str()],|r|r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert!(
            plans
                .iter()
                .any(|plan| plan.contains("SEARCH") && plan.contains(EXTERNAL_UNRESOLVED_INDEX.0)),
            "{plans:?}"
        );
    }
    #[test]
    fn eligible_invalid_candidate_fails_closed_without_new_observation() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        store.connection.execute("INSERT INTO external_observations VALUES('malformed',json_object('path','selected.txt','resolution',NULL,'unexpected',1))",[]).unwrap();
        assert!(store
            .record_external(
                &VaultPath::new("selected.txt").unwrap(),
                None,
                b"body".to_vec()
            )
            .is_err());
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM external_observations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn unresolved_dedupe_keeps_earliest_rowid_and_typed_baseline_content_and_physical_proofs() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        let path = VaultPath::new("selected.txt").unwrap();
        let proof = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "original".into(),
                parent_inode: "parent".into(),
            },
            expected_binding: None,
        };
        let first = store
            .record_external_bound(&path, None, b"body".to_vec(), &proof)
            .unwrap();
        let mut duplicate = first.clone();
        duplicate.observation_id = op("duplicate");
        store
            .connection
            .execute(
                "INSERT INTO external_observations VALUES(?1,?2)",
                params![
                    duplicate.observation_id.as_str(),
                    serde_json::to_string(&duplicate).unwrap()
                ],
            )
            .unwrap();
        physical_bindings::put_observation_proof(
            &store.connection,
            &duplicate.observation_id,
            &proof,
        )
        .unwrap();
        assert_eq!(
            store
                .record_external_bound(&path, None, b"body".to_vec(), &proof)
                .unwrap(),
            first
        );
        let changed_proof = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "changed".into(),
                parent_inode: "parent".into(),
            },
            expected_binding: None,
        };
        assert_ne!(
            store
                .record_external_bound(&path, None, b"body".to_vec(), &changed_proof)
                .unwrap()
                .observation_id,
            first.observation_id
        );
        assert_ne!(
            store
                .record_external_bound(&path, None, b"other".to_vec(), &proof)
                .unwrap()
                .observation_id,
            first.observation_id
        );
        let mut baseline_state = state();
        baseline_state.path = path.clone();
        let baseline = ProjectionBaseline {
            state: baseline_state,
            content: StoredContent::InlineBytes(b"base".to_vec()),
        };
        assert_ne!(
            store
                .record_external(&path, Some(baseline), b"body".to_vec())
                .unwrap()
                .observation_id,
            first.observation_id
        );
        store.connection.execute("UPDATE external_observations SET record=json_set(record,'$.resolution','resolved') WHERE observation_id IN (?1,?2)",params![first.observation_id.as_str(),duplicate.observation_id.as_str()]).unwrap();
        let fresh = store
            .record_external_bound(&path, None, b"body".to_vec(), &proof)
            .unwrap();
        assert_ne!(fresh.observation_id, first.observation_id);
        assert_ne!(fresh.observation_id, duplicate.observation_id);
    }
    #[test]
    fn capture_ids_do_not_cross_dedupe_and_exact_resolved_capture_replay_keeps_proof_cas() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        let scope = scope();
        store
            .family_enroll(&FamilyScope {
                realm_id: scope.realm_id,
                vault_id: scope.vault_id,
            })
            .unwrap();
        let client = op("client");
        let path = VaultPath::new("empty.bin").unwrap();
        let mut contents = Vec::new();
        for name in ["capture-first", "capture-second"] {
            let stage = store
                .begin_binary_capture(
                    &client,
                    &op(name),
                    &BinaryCaptureRequest {
                        path: path.clone(),
                        expected_length: 0,
                        expected_digest: Sha256Digest::of(&[]),
                    },
                    StreamingLimits {
                        max_active_stages: 4,
                        max_stage_records: 8,
                        max_staged_bytes: 1024,
                        max_chunk_records: 8,
                        max_page_records: 8,
                    },
                )
                .unwrap();
            store.seal_binary_stage(&stage, 0, None).unwrap();
            contents.push(StoredContent::BinaryRef(BinarySourceRef::Capture(
                store.captured_binary_ref(&stage).unwrap(),
            )));
        }
        let first = store
            .retain_external_content(&client, &path, None, &contents[0], None)
            .unwrap();
        // A different capture ID never scans even eligible other observations.
        store.connection.execute("INSERT INTO external_observations VALUES('other-eligible',json_object('path','empty.bin','resolution',NULL,'unexpected',1))",[]).unwrap();
        let second = store
            .retain_external_content(&client, &path, None, &contents[1], None)
            .unwrap();
        assert_eq!(first.observation_id, op("capture-first"));
        assert_eq!(second.observation_id, op("capture-second"));
        store.connection.execute("UPDATE external_observations SET record=json_set(record,'$.resolution','resolved') WHERE observation_id=?1",[first.observation_id.as_str()]).unwrap();
        let replay = store
            .retain_external_content(&client, &path, None, &contents[0], None)
            .unwrap();
        assert_eq!(replay.observation_id, first.observation_id);
        assert_eq!(replay.resolution, Some(op("resolved")));
        let baseline = ProjectionBaseline {
            state: state(),
            content: StoredContent::InlineBytes(vec![]),
        };
        let physical = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "other".into(),
                parent_inode: "parent".into(),
            },
            expected_binding: None,
        };
        let mut changed = contents[0].clone();
        if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = &mut changed {
            capture.manifest.digest = Sha256Digest::of(b"different");
        }
        for result in [
            store.retain_external_content(
                &client,
                &VaultPath::new("different.bin").unwrap(),
                None,
                &contents[0],
                None,
            ),
            store.retain_external_content(&client, &path, Some(&baseline), &contents[0], None),
            store.retain_external_content(&client, &path, None, &contents[0], Some(&physical)),
            store.retain_external_content(&client, &path, None, &changed, None),
        ] {
            assert!(matches!(
                result,
                Err(StoreError::Contract(
                    ContractError::IdempotencyConflict { .. }
                ))
            ));
        }
    }
}

#[cfg(test)]
mod recovery_prefix_tests {
    use super::*;

    fn fixture(count: usize) -> (tempfile::TempDir, Store, Vec<EntryState>) {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("db")).unwrap();
        let mut states = Vec::new();
        for index in 0..count {
            let id = EntryId::new(format!("file-{index:03}")).unwrap();
            let content = format!("Saved body {index}\n").into_bytes();
            store.apply(&MutationRequest {
                operation_id: OperationId::new(format!("create-{index}")).unwrap(),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: VaultPath::new(format!("Note {index:03}.md")).unwrap(),
                    kind: EntryKind::File,
                    content: Some(content.clone()),
                },
            }).unwrap();
            let state = store.read(&id).unwrap().unwrap().state;
            let value = ProjectionBaseline { state: state.clone(), content: StoredContent::InlineBytes(content) };
            store.connection.execute(
                "INSERT INTO projection_baselines(entry_id,record) VALUES(?1,?2)",
                params![id.as_str(), serde_json::to_string(&value).unwrap()],
            ).unwrap();
            states.push(state);
        }
        (directory, store, states)
    }

    struct BaselineReads<'a> {
        connection: &'a Connection,
        count: Box<std::cell::Cell<usize>>,
    }
    impl<'a> BaselineReads<'a> {
        fn new(connection: &'a Connection) -> Self {
            unsafe extern "C" fn observe(event: u32, context: *mut std::ffi::c_void, _: *mut std::ffi::c_void, sql: *mut std::ffi::c_void) -> i32 {
                if event == rusqlite::ffi::SQLITE_TRACE_STMT && !context.is_null() && !sql.is_null() {
                    let sql = unsafe { std::ffi::CStr::from_ptr(sql.cast()) }.to_bytes();
                    if sql.starts_with(b"SELECT") && sql.windows(b"projection_baselines".len()).any(|part| part == b"projection_baselines") {
                        let count = unsafe { &*context.cast::<std::cell::Cell<usize>>() };
                        count.set(count.get() + 1);
                    }
                }
                0
            }
            let value = Self { connection, count: Box::new(std::cell::Cell::new(0)) };
            assert_eq!(unsafe {
                rusqlite::ffi::sqlite3_trace_v2(connection.handle(), rusqlite::ffi::SQLITE_TRACE_STMT, Some(observe), (&*value.count as *const std::cell::Cell<usize>).cast_mut().cast())
            }, rusqlite::ffi::SQLITE_OK);
            value
        }
    }
    impl Drop for BaselineReads<'_> {
        fn drop(&mut self) {
            assert_eq!(unsafe {
                rusqlite::ffi::sqlite3_trace_v2(self.connection.handle(), 0, None, std::ptr::null_mut())
            }, rusqlite::ffi::SQLITE_OK);
        }
    }

    #[test]
    fn clean_recovery_page_uses_one_actual_sql_read_with_full_baseline_validation() {
        let (_directory, store, states) = fixture(Store::PROJECTION_RECOVERY_MAX_STATES);
        let reads = BaselineReads::new(&store.connection);
        for state in &states {
            assert_eq!(store.projection_baseline(&state.id).unwrap().unwrap().state, *state);
        }
        assert_eq!(reads.count.get(), states.len());
        reads.count.set(0);
        assert_eq!(store.projection_clean_prefix(&states).unwrap(), states.len());
        assert_eq!(reads.count.get(), 1);
    }

    #[test]
    fn recovery_prefix_stops_before_later_corruption_and_rechecks_after_dirty_file() {
        let (_directory, store, states) = fixture(4);
        let original: String = store.connection.query_row("SELECT record FROM projection_baselines WHERE entry_id=?1", [states[1].id.as_str()], |row| row.get(0)).unwrap();
        store.connection.execute("DELETE FROM projection_baselines WHERE entry_id=?1", [states[1].id.as_str()]).unwrap();
        store.connection.execute("UPDATE projection_baselines SET record='invalid-json' WHERE entry_id=?1", [states[2].id.as_str()]).unwrap();
        assert_eq!(store.projection_clean_prefix(&states).unwrap(), 1);
        store.connection.execute("INSERT INTO projection_baselines(entry_id,record) VALUES(?1,?2)", params![states[1].id.as_str(), original]).unwrap();
        assert!(store.projection_clean_prefix(&states).is_err());
    }

    #[test]
    fn stale_baseline_returns_the_exact_first_dirty_position() {
        let (_directory, store, states) = fixture(4);
        let mut saved = store.projection_baseline(&states[2].id).unwrap().unwrap();
        saved.state.revision = Revision::new("earlier").unwrap();
        store.connection.execute("UPDATE projection_baselines SET record=?1 WHERE entry_id=?2", params![serde_json::to_string(&saved).unwrap(), states[2].id.as_str()]).unwrap();
        assert_eq!(store.projection_clean_prefix(&states).unwrap(), 2);
        assert_eq!(store.projection_clean_prefix(&states[3..]).unwrap(), 1);
    }

    #[test]
    fn recovery_prefix_rejects_corrupt_content_and_baseline_identity_like_point_reads() {
        for corruption in ["content", "identity", "kind", "deleted", "unknown-field"] {
            let (_directory, store, states) = fixture(1);
            let mut raw = serde_json::to_value(store.projection_baseline(&states[0].id).unwrap().unwrap()).unwrap();
            match corruption {
                "content" => raw["content"]["content"] = serde_json::json!([256]),
                "identity" => raw["state"]["id"] = serde_json::json!("another-entry"),
                "kind" => raw["state"]["kind"] = serde_json::json!("folder"),
                "deleted" => raw["state"]["deleted"] = serde_json::json!(true),
                "unknown-field" => raw["unfamiliar"] = serde_json::json!(true),
                _ => unreachable!(),
            }
            store.connection.execute("UPDATE projection_baselines SET record=?1 WHERE entry_id=?2", params![serde_json::to_string(&raw).unwrap(), states[0].id.as_str()]).unwrap();
            assert!(store.projection_baseline(&states[0].id).is_err(), "{corruption}");
            assert!(store.projection_clean_prefix(&states).is_err(), "{corruption}");
        }
    }

    #[test]
    fn recovery_page_bound_is_explicit_and_empty_page_performs_no_baseline_read() {
        let (_directory, store, states) = fixture(1);
        let reads = BaselineReads::new(&store.connection);
        assert_eq!(store.projection_clean_prefix(&[]).unwrap(), 0);
        assert!(store.projection_clean_prefix(&vec![states[0].clone(); Store::PROJECTION_RECOVERY_MAX_STATES + 1]).is_err());
        assert_eq!(reads.count.get(), 0);
    }
}

#[cfg(test)]
mod attempt_scheduling_tests {
    use super::*;
    #[test]
    fn scheduling_ids_never_decode_unselected_bodies_and_selected_attempt_stays_strict() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path().join("vault.sqlite")).unwrap();
        let mut attempts = Vec::new();
        for name in ["selected", "unrelated"] {
            let id = EntryId::new(name).unwrap();
            store
                .apply(&MutationRequest {
                    operation_id: OperationId::new(format!("create-{name}")).unwrap(),
                    mutation: Mutation::Create {
                        id: id.clone(),
                        path: VaultPath::new(format!("{name}.md")).unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"retained".to_vec()),
                    },
                })
                .unwrap();
            attempts.push(store.begin_projection(&id).unwrap());
        }
        store
            .connection
            .execute(
                "UPDATE projection_attempts SET record='{' WHERE attempt_id=?1",
                [attempts[1].attempt_id.as_str()],
            )
            .unwrap();
        assert_eq!(
            store.projection_attempt_ids(false).unwrap(),
            attempts
                .iter()
                .map(|a| a.attempt_id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            store
                .projection_attempt_ids_for_entry(&attempts[0].target.state.id)
                .unwrap(),
            vec![attempts[0].attempt_id.clone()]
        );
        assert_eq!(
            store.projection_attempt(&attempts[0].attempt_id).unwrap(),
            attempts[0]
        );
        assert!(store.projection_attempt(&attempts[1].attempt_id).is_err());
        assert!(
            store.projection_attempts(false).is_err(),
            "the legacy full validator is preserved"
        );
        store
            .finish_projection(&attempts[0].attempt_id, false)
            .unwrap();
        assert!(store
            .projection_attempt_ids_for_entry(&attempts[0].target.state.id)
            .unwrap()
            .is_empty());
        assert_eq!(store.projection_attempt_ids(true).unwrap().len(), 2);
        assert_eq!(
            store.projection_attempt_ids(false).unwrap(),
            vec![attempts[1].attempt_id.clone()]
        );
    }
}
