//! Family namespace attachment keeps logical jobs distinct from physical work.
//! The original jobs and desired states are immutable CAS inputs; only persisted
//! physical bindings authorize source occupants. The existing namespace journal
//! executes a separate physical job without weakening its member invariants.
use super::*;
use std::collections::BTreeMap;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("family_namespace_attachments", "CREATE TABLE family_namespace_attachments (job_id TEXT PRIMARY KEY NOT NULL REFERENCES namespace_attempts(job_id), record TEXT NOT NULL)"),
    ("family_namespace_covered", "CREATE TABLE family_namespace_covered (covered_job_id TEXT NOT NULL REFERENCES projection_jobs(job_id), entry_id TEXT NOT NULL REFERENCES entries(id), job_id TEXT REFERENCES family_namespace_attachments(job_id), satisfied INTEGER NOT NULL CHECK(satisfied IN (0,1)), record TEXT NOT NULL, PRIMARY KEY(covered_job_id,entry_id))"),
    ("family_namespace_plan_claims", "CREATE INDEX family_namespace_plan_claims ON family_namespace_covered(job_id,covered_job_id,entry_id)"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Attachment {
    job_id: OperationId,
    jobs: Vec<ProjectionJob>,
    claims: Vec<(OperationId, EntryId)>,
    obsolete: Vec<ProjectionJob>,
    desired: Vec<EntryState>,
    physical: Vec<EntryState>,
}
fn enrolled(tx: &Connection) -> Result<()> {
    if !tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_heads)", [], |r| {
        r.get::<_, bool>(0)
    })? {
        return Err(invalid("namespace attachment requires family enrollment"));
    }
    Ok(())
}
fn check_job(tx: &Connection, job: &ProjectionJob) -> Result<()> {
    if job.completed
        || projection_jobs::get(tx, &job.job_id)? != *job
        || !matches!(job.work, ProjectionWork::Move | ProjectionWork::Delete)
    {
        return Err(invalid("family namespace job changed"));
    }
    if let ProjectionOrigin::ReceivedUpdate {
        realm_id, vault_id, ..
    } = &job.origin
    {
        let authority = text_sync::identity(tx)?;
        if authority.realm_id.as_ref().map(|id| id.as_str()) != Some(realm_id.as_str())
            || authority.vault_id.as_ref().map(|id| id.as_str()) != Some(vault_id.as_str())
        {
            return Err(invalid("family namespace job scope mismatch"));
        }
    }
    // A local command must have the typed family intent as well as its receipt.
    if let ProjectionOrigin::LocalCommand { operation_id } = &job.origin {
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM family_commands WHERE operation_id=?1)",
            [operation_id.as_str()],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(invalid(
                "legacy namespace job cannot acquire family authority",
            ));
        }
    }
    Ok(())
}
#[derive(Debug)]
struct Claim {
    plan: Option<OperationId>,
    satisfied: bool,
    desired: EntryState,
}
fn claim(tx: &Connection, job: &OperationId, id: &EntryId) -> Result<Option<Claim>> {
    let row: Option<(Option<String>,i64,String)> = tx.query_row(
        "SELECT job_id,satisfied,record FROM family_namespace_covered WHERE covered_job_id=?1 AND entry_id=?2",
        params![job.as_str(),id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(plan, satisfied, record)| {
        let desired: EntryState = serde_json::from_str(&record)?;
        let plan = plan.map(OperationId::new).transpose()?;
        if desired.id != *id || !matches!(satisfied, 0 | 1) || (plan.is_none() && satisfied != 1) {
            return Err(invalid("invalid namespace member claim"));
        }
        Ok(Claim {
            plan,
            satisfied: satisfied == 1,
            desired,
        })
    })
    .transpose()
}
fn target_entries(tx: &Connection, ids: &BTreeSet<EntryId>) -> Result<Vec<EntryState>> {
    let mut result = Vec::with_capacity(ids.len());
    for id in ids {
        let (state, _) = entry(tx, id)?;
        let record = family_materialization::get(tx, id)?
            .ok_or_else(|| invalid("family namespace target missing"))?;
        match record.publication {
            FamilyPublication::Normal { ref path, kind, .. }
                if !state.deleted
                    && is_visible(tx, id)?
                    && path == &state.path
                    && kind == state.kind => {}
            FamilyPublication::Tombstone if state.deleted && !is_visible(tx, id)? => {}
            _ => return Err(invalid("family namespace target is unresolved")),
        }
        result.push(state);
    }
    Ok(result)
}
fn targets(tx: &Connection, covered: &[ProjectionJob]) -> Result<Vec<EntryState>> {
    enrolled(tx)?;
    if covered.is_empty() || covered.len() > MAX_NAMESPACE_MEMBERS {
        return Err(invalid("invalid family namespace job count"));
    }
    let mut ids = BTreeSet::new();
    let mut job_ids = BTreeSet::new();
    for job in covered {
        check_job(tx, job)?;
        if !job_ids.insert(job.job_id.clone()) {
            return Err(invalid("duplicate family namespace job"));
        }
        for change in &job.affected {
            if claim(tx, &job.job_id, &change.after.id)?.is_none() {
                ids.insert(change.after.id.clone());
            }
        }
    }
    if ids.len() > MAX_NAMESPACE_MEMBERS {
        return Err(invalid("family namespace member limit"));
    }
    target_entries(tx, &ids)
}
fn put_claims(
    tx: &Connection,
    claims: &[(OperationId, EntryId)],
    desired: &[EntryState],
    plan: Option<&OperationId>,
) -> Result<()> {
    for (job, id) in claims {
        let state = desired
            .iter()
            .find(|s| &s.id == id)
            .ok_or_else(|| invalid("claim desired state missing"))?;
        tx.execute("INSERT INTO family_namespace_covered(covered_job_id,entry_id,job_id,satisfied,record) VALUES(?1,?2,?3,?4,?5)",
            params![job.as_str(),id.as_str(),plan.map(|id|id.as_str()),plan.is_none(),serde_json::to_string(state)?])?;
    }
    Ok(())
}
fn retire_ready(
    tx: &Connection,
    jobs: &[ProjectionJob],
    finishing: Option<&OperationId>,
) -> Result<()> {
    for job in jobs {
        let mut ready = true;
        for change in &job.affected {
            let Some(claim) = claim(tx, &job.job_id, &change.after.id)? else {
                ready = false;
                break;
            };
            if !claim.satisfied {
                ready = false;
                break;
            }
            if let Some(plan) = &claim.plan {
                let completed: bool = tx.query_row(
                    "SELECT completed FROM namespace_attempts WHERE job_id=?1",
                    [plan.as_str()],
                    |r| r.get(0),
                )?;
                if !completed && Some(plan) != finishing {
                    return Err(invalid("namespace claim precedes physical completion"));
                }
            }
        }
        if ready {
            projection_jobs::finish(tx, job)?;
        }
    }
    Ok(())
}
fn get_attachment(tx: &Connection, id: &OperationId) -> Result<Option<Attachment>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM family_namespace_attachments WHERE job_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| {
        let a: Attachment = serde_json::from_str(&raw)?;
        if a.job_id != *id
            || a.jobs.is_empty()
            || a.jobs.len() > MAX_NAMESPACE_MEMBERS
            || a.desired.is_empty()
            || a.desired.len() > MAX_NAMESPACE_MEMBERS
            || a.physical.is_empty()
            || a.physical.len() > a.desired.len()
        {
            return Err(invalid("invalid family namespace attachment"));
        }
        let ids: BTreeSet<_> = a.desired.iter().map(|s| s.id.clone()).collect();
        if ids.len() != a.desired.len() {
            return Err(invalid("duplicate namespace desired member"));
        }
        let expected: BTreeSet<_> = a
            .claims
            .iter()
            .map(|(job, id)| (job.as_str().to_owned(), id.as_str().to_owned()))
            .collect();
        if expected.len() != a.claims.len()
            || a.claims.is_empty()
            || a.claims.iter().any(|(job, id)| {
                !ids.contains(id)
                    || !a
                        .jobs
                        .iter()
                        .any(|j| j.job_id == *job && j.affected.iter().any(|c| c.after.id == *id))
            })
            || a.jobs
                .iter()
                .any(|j| !a.claims.iter().any(|(job, _)| job == &j.job_id))
            || ids
                .iter()
                .any(|id| !a.claims.iter().any(|(_, entry)| entry == id))
        {
            return Err(invalid("invalid namespace attachment claim membership"));
        }
        let mapped: BTreeSet<(String, String)> = tx
            .prepare(
                "SELECT covered_job_id,entry_id FROM family_namespace_covered WHERE job_id=?1",
            )?
            .query_map([id.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        if mapped != expected {
            return Err(invalid("family namespace claim set differs"));
        }
        for (job, id) in &a.claims {
            let desired = a
                .desired
                .iter()
                .find(|s| &s.id == id)
                .ok_or_else(|| invalid("claim desired missing"))?;
            let claim =
                claim(tx, job, id)?.ok_or_else(|| invalid("namespace member claim missing"))?;
            if claim.plan.as_ref() != Some(&a.job_id) || claim.desired != *desired {
                return Err(invalid("namespace member claim changed"));
            }
        }
        Ok(a)
    })
    .transpose()
}
pub(super) fn check_finish(tx: &Connection, attempt: &NamespaceAttempt) -> Result<bool> {
    let Some(a) = get_attachment(tx, &attempt.job.job_id)? else {
        return Ok(false);
    };
    for job in &a.jobs {
        check_job(tx, job)?;
    }
    for (job, id) in &a.claims {
        if claim(tx, job, id)?.is_none_or(|c| c.satisfied) {
            return Err(invalid("active namespace claim already satisfied"));
        }
    }
    let ids: BTreeSet<_> = a.desired.iter().map(|s| s.id.clone()).collect();
    if target_entries(tx, &ids)? != a.desired {
        return Err(invalid("family namespace desired state changed"));
    }
    let mut obsolete_ids = BTreeSet::new();
    for job in &a.obsolete {
        if attempt.job.work != ProjectionWork::Delete
            || !obsolete_ids.insert(job.job_id.clone())
            || !matches!(
                job.work,
                ProjectionWork::MaterializeFile | ProjectionWork::CreateDirectory
            )
            || !job.affected.iter().all(|c| ids.contains(&c.after.id))
            || job.completed
            || projection_jobs::get(tx, &job.job_id)? != *job
        {
            return Err(invalid("family namespace obsolete job changed"));
        }
    }
    if a.physical
        != attempt
            .members
            .iter()
            .map(|m| m.change.after.clone())
            .collect::<Vec<_>>()
    {
        return Err(invalid("family namespace physical targets changed"));
    }
    Ok(true)
}
pub(super) fn finish_covered(tx: &Connection, attempt: &NamespaceAttempt) -> Result<()> {
    let Some(a) = get_attachment(tx, &attempt.job.job_id)? else {
        return Ok(());
    };
    tx.execute(
        "UPDATE family_namespace_covered SET satisfied=1 WHERE job_id=?1",
        [attempt.job.job_id.as_str()],
    )?;
    retire_ready(tx, &a.jobs, Some(&attempt.job.job_id))?;
    // Exactly the earlier content/create obligations captured by preparation.
    for job in &a.obsolete {
        projection_jobs::finish(tx, job)?;
    }

    Ok(())
}
impl Store {
    pub fn family_namespace_targets(&self, covered: &[ProjectionJob]) -> Result<Vec<EntryState>> {
        let tx = self.connection.unchecked_transaction()?;
        let desired = targets(&tx, covered)?;
        tx.commit()?;
        Ok(desired)
    }
    pub fn family_namespace_covered_jobs(&self) -> Result<Vec<OperationId>> {
        self.connection
            .prepare("SELECT DISTINCT covered_job_id FROM family_namespace_covered ORDER BY covered_job_id")?
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| OperationId::new(r?).map_err(Into::into))
            .collect()
    }
    /// Attach freshly checked filesystem evidence to already-durable logical jobs.
    /// No source path is derived from receiver subtree membership or byte equality.
    pub fn family_namespace_prepare(
        &mut self,
        covered: &[ProjectionJob],
        expected: &[EntryState],
        evidence: &[NamespaceEvidence],
    ) -> Result<Option<NamespaceAttempt>> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidates = targets(&tx, covered)?;
        let deleted = expected
            .first()
            .ok_or_else(|| invalid("empty namespace member selection"))?
            .deleted;
        let desired: Vec<_> = candidates
            .into_iter()
            .filter(|s| s.deleted == deleted)
            .collect();
        if desired != expected {
            return Err(invalid("family namespace desired subset CAS failed"));
        }
        let ids: BTreeSet<_> = desired.iter().map(|s| s.id.clone()).collect();
        let mut claims = Vec::new();
        for job in covered {
            for change in &job.affected {
                if ids.contains(&change.after.id)
                    && claim(&tx, &job.job_id, &change.after.id)?.is_none()
                {
                    claims.push((job.job_id.clone(), change.after.id.clone()));
                }
            }
        }
        let claimed_jobs: Vec<_> = covered
            .iter()
            .filter(|j| claims.iter().any(|(job, _)| job == &j.job_id))
            .cloned()
            .collect();
        let selected: BTreeSet<_> = covered.iter().map(|j| j.job_id.clone()).collect();
        for job in jobs(&tx, true)? {
            if !selected.contains(&job.job_id)
                && job.affected.iter().any(|c| ids.contains(&c.after.id))
            {
                return Err(invalid("family namespace selection omits overlapping job"));
            }
        }
        let by_id: BTreeMap<_, _> = evidence.iter().map(|e| (e.before.id.clone(), e)).collect();
        if by_id.len() != evidence.len() || by_id.keys().any(|id| !ids.contains(id)) {
            return Err(invalid("family namespace evidence set invalid"));
        }
        let work = if desired[0].deleted {
            ProjectionWork::Delete
        } else {
            ProjectionWork::Move
        };
        let mut obsolete = Vec::new();
        if work == ProjectionWork::Delete {
            for id in &ids {
                for work in [
                    ProjectionWork::MaterializeFile,
                    ProjectionWork::CreateDirectory,
                ] {
                    for job in projection_jobs::pending(&tx, id, work)? {
                        if !job.affected.iter().all(|c| ids.contains(&c.after.id)) {
                            return Err(invalid(
                                "deleted publication job includes uncovered member",
                            ));
                        }
                        obsolete.push(job);
                    }
                }
            }
        }
        let mut members = Vec::new();
        for target in &desired {
            let active_namespace: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM namespace_members m JOIN namespace_attempts a ON a.job_id=m.job_id WHERE m.entry_id=?1 AND a.completed=0) OR EXISTS(SELECT 1 FROM family_namespace_covered WHERE entry_id=?1 AND satisfied=0)",
                [target.id.as_str()],
                |r| r.get(0),
            )?;
            if active_namespace {
                return Err(invalid(
                    "family namespace member has active namespace responsibility",
                ));
            }
            for table in ["projection_attempts", "directory_attempts"] {
                let sql = format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE entry_id=?1 AND completed=0)"
                );
                if tx.query_row(&sql, [target.id.as_str()], |r| r.get::<_, bool>(0))? {
                    return Err(invalid("family namespace member has active publication"));
                }
            }
            let binding = physical_bindings::binding(&tx, &target.id)?;
            let Some(binding) = binding else {
                if by_id.contains_key(&target.id)
                    || projection::baseline(&tx, &target.id)?.is_some()
                    || directory_baseline(&tx, &target.id)?.is_some()
                {
                    return Err(invalid(
                        "family namespace source has no proven physical binding",
                    ));
                }
                continue; // No authority to relocate an unknown filesystem occupant.
            };
            let e = *by_id
                .get(&target.id)
                .ok_or_else(|| invalid("bound family namespace member lacks evidence"))?;
            if e.before != binding.state || e.physical_binding.as_ref() != Some(&binding) {
                return Err(invalid("family namespace physical source CAS failed"));
            }
            check_baselines(&tx, e)?;
            let after = if work == ProjectionWork::Move {
                family_materialization::prepare_physical_move(
                    &tx,
                    &binding.state,
                    target,
                    &desired,
                )?
            } else {
                let mut deleted = binding.state.clone();
                deleted.deleted = true;
                deleted
            };
            members.push(NamespaceMember {
                change: EntryChange {
                    before: Some(e.before.clone()),
                    after,
                },
                evidence: e.clone(),
                directory_stage_identity: None,
                captured: false,
                published: false,
                finished: false,
            });
        }
        if members.is_empty() {
            put_claims(&tx, &claims, &desired, None)?;
            retire_ready(&tx, &claimed_jobs, None)?;
            for job in &obsolete {
                projection_jobs::finish(&tx, job)?;
            }
            tx.commit()?;
            return Ok(None);
        }
        let physical = members.iter().map(|m| m.change.after.clone()).collect();
        let job = projection_jobs::insert(
            &tx,
            ProjectionJob {
                job_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
                ordinal: "0".into(),
                origin: covered[0].origin.clone(),
                work,
                target: members[0].change.after.clone(),
                affected: members.iter().map(|m| m.change.clone()).collect(),
                completed: false,
            },
            None,
        )?;
        let attempt = NamespaceAttempt {
            job: job.clone(),
            members,
            completed: false,
        };
        insert_attempt(&tx, &attempt)?;
        let attachment = Attachment {
            job_id: job.job_id.clone(),
            jobs: claimed_jobs,
            claims,
            obsolete,
            desired,
            physical,
        };
        tx.execute(
            "INSERT INTO family_namespace_attachments(job_id,record) VALUES(?1,?2)",
            params![job.job_id.as_str(), serde_json::to_string(&attachment)?],
        )?;
        put_claims(
            &tx,
            &attachment.claims,
            &attachment.desired,
            Some(&job.job_id),
        )?;
        tx.commit()?;
        Ok(Some(attempt))
    }
}
