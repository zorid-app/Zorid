//! A single captured file may delegate physical responsibility to one successor.
//! Old evidence, progress and causal claims remain immutable. Native code owns
//! retained-inode and parent proofs; this module owns their durable logical CAS.
use super::*;

pub(crate) const SCHEMA: &[(&str, &str)] = &[
    ("namespace_successions", "CREATE TABLE namespace_successions (predecessor_job_id TEXT PRIMARY KEY NOT NULL REFERENCES namespace_attempts(job_id), successor_job_id TEXT NOT NULL UNIQUE REFERENCES namespace_attempts(job_id), predecessor_metadata TEXT NOT NULL, record TEXT NOT NULL, CHECK(predecessor_job_id != successor_job_id))"),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedClaim {
    job: OperationId,
    entry: EntryId,
    claim: Claim,
}

/// A witnessed selection, not permission to retarget an existing attempt. Only
/// Fields remain private; preparation rechecks every snapshot atomically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceSuccessorPlan {
    predecessor: NamespaceAttempt,
    target: EntryState,
    publication: FamilyMaterialization,
    attachment: Attachment,
    claims: Vec<SavedClaim>,
    jobs: Vec<ProjectionJob>,
}
impl NamespaceSuccessorPlan {
    pub fn predecessor(&self) -> &NamespaceAttempt {
        &self.predecessor
    }
    /// Selected destination identity/path/kind. The returned attempt has its own
    /// historical physical revision; the logical desired revision stays intact.
    pub fn target(&self) -> &EntryState {
        &self.target
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Succession {
    plan: NamespaceSuccessorPlan,
    successor: NamespaceAttempt,
    attachment: Attachment,
}
fn saved(tx: &Connection, predecessor: &OperationId) -> Result<Option<Succession>> {
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT successor_job_id,record FROM namespace_successions WHERE predecessor_job_id=?1",
            [predecessor.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(successor, record)| {
        let value: Succession = serde_json::from_str(&record)?;
        let old = &value.plan.predecessor;
        if old.job.job_id != *predecessor || value.successor.job.job_id.as_str() != successor
            || old.job.job_id == value.successor.job.job_id
            || old.completed || old.delegated_to.is_some()
            || value.successor.completed || value.successor.delegated_to.is_some()
            || old.members.len() != 1 || value.successor.members.len() != 1
            || value.attachment.job_id != value.successor.job.job_id
            || value.plan.attachment.job_id != old.job.job_id
            || value.plan.target.id != old.members[0].change.after.id
        { return Err(invalid("invalid namespace succession record")); }
        validate(old)?; validate(&value.successor)?;
        if saved_metadata(tx, predecessor)?.as_ref() != Some(&(value.successor.job.job_id.clone(),metadata_of(old))) {
            return Err(invalid("namespace delegation metadata differs from full proof"));
        }
        let mut evidence = value.successor.members[0].evidence.clone();
        evidence.destination_parent_identity = old.members[0].evidence.destination_parent_identity.clone();
        if evidence != old.members[0].evidence || value.successor.members[0].change.after.id != value.plan.target.id
            || value.successor.members[0].change.after.path != value.plan.target.path
            || value.successor.members[0].change.after.kind != EntryKind::File
            || value.successor.members[0].change.after.deleted || value.successor.members[0].captured
            || value.successor.members[0].published || value.successor.members[0].finished
        { return Err(invalid("namespace successor does not preserve original physical evidence")); }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM namespace_successions WHERE predecessor_job_id=?1 OR successor_job_id=?2)", params![successor, predecessor.as_str()], |r| r.get::<_, bool>(0))? {
            return Err(invalid("namespace succession chains are unsupported"));
        }
        let actual = projection_jobs::get(tx, &value.successor.job.job_id)?;
        let mut immutable = actual.clone(); immutable.completed = false;
        if immutable != value.successor.job { return Err(invalid("namespace successor job changed")); }
        Ok(value)
    }).transpose()
}
fn by_successor(tx: &Connection, successor: &OperationId) -> Result<Option<Succession>> {
    let old: Option<String> = tx
        .query_row(
            "SELECT predecessor_job_id FROM namespace_successions WHERE successor_job_id=?1",
            [successor.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    old.map(|old| {
        saved(tx, &OperationId::new(old)?)?.ok_or_else(|| invalid("namespace predecessor missing"))
    })
    .transpose()
}
fn metadata_of(attempt: &NamespaceAttempt) -> NamespaceAttemptMetadata {
    NamespaceAttemptMetadata {
        job: attempt.job.clone(),
        completed: attempt.completed,
        delegated_to: attempt.delegated_to.clone(),
        members: attempt
            .members
            .iter()
            .enumerate()
            .map(|(index, member)| NamespaceMemberMetadata {
                index,
                change: member.change.clone(),
                source_identity: member.evidence.source_identity.clone(),
                directory_stage_identity: member.directory_stage_identity.clone(),
                captured: member.captured,
                published: member.published,
                finished: member.finished,
            })
            .collect(),
    }
}
fn saved_metadata(
    tx: &Connection,
    id: &OperationId,
) -> Result<Option<(OperationId, NamespaceAttemptMetadata)>> {
    let row: Option<(String,String)> = tx.query_row("SELECT successor_job_id,predecessor_metadata FROM namespace_successions WHERE predecessor_job_id=?1", [id.as_str()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(successor, json)| {
        let successor = OperationId::new(successor)?;
        let metadata: NamespaceAttemptMetadata = serde_json::from_str(&json)?;
        if successor == *id
            || metadata.job.job_id != *id
            || metadata.completed
            || metadata.delegated_to.is_some()
            || metadata.members.len() != 1
            || metadata.job.work != ProjectionWork::Move
            || metadata.members[0].change.after.kind != EntryKind::File
            || !metadata.members[0].captured
            || metadata.members[0].published
            || metadata.members[0].finished
        {
            return Err(invalid("invalid namespace delegation metadata"));
        }
        Ok((successor, metadata))
    })
    .transpose()
}
pub(in crate::namespace) fn delegated_to(
    tx: &Connection,
    id: &OperationId,
) -> Result<Option<OperationId>> {
    // Never select immutable byte evidence for ordinary status/progress metadata.
    Ok(saved_metadata(tx, id)?.map(|(successor, _)| successor))
}
fn normalize(mut attempt: NamespaceAttempt) -> NamespaceAttempt {
    attempt.completed = false;
    attempt.delegated_to = None;
    attempt
}
pub(in crate::namespace) fn check_delegated_attempt(
    tx: &Connection,
    attempt: &NamespaceAttempt,
) -> Result<()> {
    let Some(link) = saved(tx, &attempt.job.job_id)? else {
        if attempt.delegated_to.is_some() {
            return Err(invalid("namespace delegation missing"));
        }
        return Ok(());
    };
    if attempt.delegated_to.as_ref() != Some(&link.successor.job.job_id)
        || normalize(attempt.clone()) != link.plan.predecessor
    {
        return Err(invalid("delegated namespace evidence or progress changed"));
    }
    let successor_complete: bool = tx.query_row(
        "SELECT completed FROM namespace_attempts WHERE job_id=?1",
        [link.successor.job.job_id.as_str()],
        |r| r.get(0),
    )?;
    if attempt.completed != successor_complete {
        return Err(invalid("namespace delegation settlement differs"));
    }
    Ok(())
}
pub(in crate::namespace) fn check_delegated_metadata(
    tx: &Connection,
    attempt: &NamespaceAttemptMetadata,
) -> Result<()> {
    let Some((successor, old)) = saved_metadata(tx, &attempt.job.job_id)? else {
        return Ok(());
    };
    let mut normalized = attempt.clone();
    normalized.completed = false;
    normalized.delegated_to = None;
    if normalized != old || attempt.delegated_to.as_ref() != Some(&successor) {
        return Err(invalid("delegated namespace metadata or progress changed"));
    }
    let successor_complete: bool = tx.query_row(
        "SELECT completed FROM namespace_attempts WHERE job_id=?1",
        [successor.as_str()],
        |r| r.get(0),
    )?;
    if attempt.completed != successor_complete {
        return Err(invalid("namespace delegation settlement differs"));
    }
    Ok(())
}
fn affected_jobs(
    tx: &Connection,
    id: &EntryId,
    excluded: &[&OperationId],
) -> Result<Vec<ProjectionJob>> {
    Ok(jobs(tx, true)?
        .into_iter()
        .filter(|job| {
            !excluded.contains(&&job.job_id)
                && job.affected.iter().any(|change| change.after.id == *id)
        })
        .collect())
}
fn saved_claims(tx: &Connection, attachment: &Attachment) -> Result<Vec<SavedClaim>> {
    attachment
        .claims
        .iter()
        .map(|(job, entry)| {
            let claim = claim(tx, job, entry)?
                .ok_or_else(|| invalid("inherited namespace claim missing"))?;
            Ok(SavedClaim {
                job: job.clone(),
                entry: entry.clone(),
                claim,
            })
        })
        .collect()
}
fn plan_at(tx: &Connection, id: &OperationId) -> Result<Option<NamespaceSuccessorPlan>> {
    let predecessor = get(tx, id)?;
    if predecessor.completed
        || predecessor.delegated_to.is_some()
        || predecessor.job.work != ProjectionWork::Move
        || predecessor.members.len() != 1
        || by_successor(tx, id)?.is_some()
    {
        return Ok(None);
    }
    let member = &predecessor.members[0];
    if member.change.after.kind != EntryKind::File
        || !member.captured
        || member.published
        || member.finished
        || member.directory_stage_identity.is_some()
        || member.evidence.physical_binding.is_none()
    {
        return Ok(None);
    }
    let Some(attachment) = get_attachment(tx, id)? else {
        return Ok(None);
    };
    if attachment.desired.len() != 1
        || attachment.physical.len() != 1
        || !attachment.obsolete.is_empty()
        || attachment.physical[0] != member.change.after
    {
        return Ok(None);
    }
    let entry_id = &member.change.after.id;
    let mut targets = target_entries(tx, &BTreeSet::from([entry_id.clone()]))?;
    let target = targets.remove(0);
    if target.deleted
        || target.kind != EntryKind::File
        || target.path == member.change.after.path
        || target.path == member.evidence.before.path
    {
        return Ok(None);
    }
    let publication = family_materialization::get(tx, entry_id)?
        .ok_or_else(|| invalid("successor Normal target missing"))?;
    if !matches!(&publication.publication, FamilyPublication::Normal { path, kind: EntryKind::File, .. } if path == &target.path)
    {
        return Ok(None);
    }
    check_baselines(tx, &member.evidence)?;
    for table in ["projection_attempts", "directory_attempts"] {
        if tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE entry_id=?1 AND completed=0)"),
            [entry_id.as_str()],
            |r| r.get::<_, bool>(0),
        )? {
            return Ok(None);
        }
    }
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM namespace_members m JOIN namespace_attempts a ON a.job_id=m.job_id WHERE m.entry_id=?1 AND a.completed=0 AND a.job_id!=?2)", params![entry_id.as_str(), id.as_str()], |r| r.get::<_, bool>(0))? { return Ok(None); }
    let jobs = affected_jobs(tx, entry_id, &[id])?;
    if jobs.is_empty() || jobs.len() > MAX_NAMESPACE_MEMBERS {
        return Ok(None);
    }
    let claims = saved_claims(tx, &attachment)?;
    if claims.iter().any(|saved| {
        saved.entry != *entry_id || saved.claim.satisfied || saved.claim.plan.as_ref() != Some(id)
    }) {
        return Ok(None);
    }
    let mut unclaimed = false;
    for job in &jobs {
        if job.affected.len() != 1 || job.affected[0].after.id != *entry_id {
            return Ok(None);
        }
        // Synthetic physical plans cannot become causal obligations.
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM namespace_attempts WHERE job_id=?1)",
            [job.job_id.as_str()],
            |r| r.get::<_, bool>(0),
        )? {
            return Ok(None);
        }
        check_job(tx, job)?;
        match claim(tx, &job.job_id, entry_id)? {
            None => unclaimed = true,
            Some(actual)
                if claims
                    .iter()
                    .any(|saved| saved.job == job.job_id && saved.claim == actual) => {}
            Some(_) => return Ok(None),
        }
    }
    if !unclaimed || attachment.jobs.iter().any(|old| !jobs.contains(old)) {
        return Ok(None);
    }
    Ok(Some(NamespaceSuccessorPlan {
        predecessor,
        target,
        publication,
        attachment,
        claims,
        jobs,
    }))
}
pub(in crate::namespace) fn check_finish(
    tx: &Connection,
    attempt: &NamespaceAttempt,
) -> Result<()> {
    let Some(link) = by_successor(tx, &attempt.job.job_id)? else {
        return Ok(());
    };
    if attempt.job != link.successor.job
        || attempt.members.len() != 1
        || attempt.members[0].change != link.successor.members[0].change
        || attempt.members[0].evidence != link.successor.members[0].evidence
        || get_attachment(tx, &attempt.job.job_id)?.as_ref() != Some(&link.attachment)
    {
        return Err(invalid("namespace successor immutable proof changed"));
    }
    let predecessor = get(tx, &link.plan.predecessor.job.job_id)?;
    if predecessor.completed
        || normalize(predecessor) != link.plan.predecessor
        || get_attachment(tx, &link.plan.predecessor.job.job_id)?.as_ref()
            != Some(&link.plan.attachment)
        || saved_claims(tx, &link.plan.attachment)? != link.plan.claims
    {
        return Err(invalid("namespace inherited responsibility changed"));
    }
    check_baselines(tx, &link.plan.predecessor.members[0].evidence)?;
    if affected_jobs(
        tx,
        &link.plan.target.id,
        &[&link.plan.predecessor.job.job_id, &attempt.job.job_id],
    )? != link.plan.jobs
        || target_entries(tx, &BTreeSet::from([link.plan.target.id.clone()]))?
            != vec![link.plan.target.clone()]
        || family_materialization::get(tx, &link.plan.target.id)?.as_ref()
            != Some(&link.plan.publication)
    {
        return Err(invalid("namespace successor selected frontier changed"));
    }
    for job in &link.plan.jobs {
        check_job(tx, job)?;
    }
    Ok(())
}
pub(in crate::namespace) fn finish_delegated(
    tx: &Connection,
    attempt: &NamespaceAttempt,
) -> Result<()> {
    let Some(link) = by_successor(tx, &attempt.job.job_id)? else {
        return Ok(());
    };
    // check_finish already validated every snapshot before baseline installation.
    for saved in &link.plan.claims {
        let count = tx.execute("UPDATE family_namespace_covered SET satisfied=1 WHERE covered_job_id=?1 AND entry_id=?2 AND job_id=?3 AND satisfied=0", params![saved.job.as_str(), saved.entry.as_str(), link.plan.predecessor.job.job_id.as_str()])?;
        if count != 1 {
            return Err(invalid("inherited namespace claim CAS failed"));
        }
    }
    retire_ready(
        tx,
        &link.plan.attachment.jobs,
        Some(&link.plan.predecessor.job.job_id),
    )?;
    projection_jobs::finish(tx, &link.plan.predecessor.job)?;
    tx.execute(
        "UPDATE namespace_attempts SET completed=1 WHERE job_id=?1 AND completed=0",
        [link.plan.predecessor.job.job_id.as_str()],
    )?;
    Ok(())
}
impl Store {
    pub fn namespace_successor_plan(
        &self,
        predecessor: &OperationId,
    ) -> Result<Option<NamespaceSuccessorPlan>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = plan_at(&tx, predecessor)?;
        tx.commit()?;
        Ok(result)
    }
    /// Caller holds the native vault lock and has freshly verified the original
    /// retained inode/bytes, original parents and absent source/old/new targets.
    /// Persistence precedes transfer of either retained name. Unknown occupants
    /// never gain ownership from a matching digest or a logical target alone.
    pub fn prepare_namespace_successor(
        &mut self,
        plan: &NamespaceSuccessorPlan,
        destination_parent_identity: &str,
    ) -> Result<NamespaceAttempt> {
        if !identity(destination_parent_identity) {
            return Err(invalid("successor parent proof invalid"));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old_id = &plan.predecessor.job.job_id;
        if let Some(existing) = saved(&tx, old_id)? {
            if existing.plan != *plan
                || existing.successor.members[0]
                    .evidence
                    .destination_parent_identity
                    .as_deref()
                    != Some(destination_parent_identity)
            {
                return Err(invalid("namespace successor replay differs"));
            }
            let result = get(&tx, &existing.successor.job.job_id)?;
            tx.commit()?;
            return Ok(result);
        }
        if plan_at(&tx, old_id)?.as_ref() != Some(plan) {
            return Err(invalid("namespace successor selection CAS failed"));
        }
        let physical = family_materialization::prepare_physical_move(
            &tx,
            &plan.predecessor.members[0].evidence.before,
            &plan.target,
            std::slice::from_ref(&plan.target),
        )?;
        let mut evidence = plan.predecessor.members[0].evidence.clone();
        evidence.destination_parent_identity = Some(destination_parent_identity.to_owned());
        let member = NamespaceMember {
            change: EntryChange {
                before: Some(evidence.before.clone()),
                after: physical.clone(),
            },
            evidence,
            directory_stage_identity: None,
            captured: false,
            published: false,
            finished: false,
        };
        let mut claims = Vec::new();
        let mut claimed_jobs = Vec::new();
        for job in &plan.jobs {
            if claim(&tx, &job.job_id, &plan.target.id)?.is_none() {
                claims.push((job.job_id.clone(), plan.target.id.clone()));
                claimed_jobs.push(job.clone());
            }
        }
        if claimed_jobs.is_empty() {
            return Err(invalid(
                "namespace successor lacks new causal responsibility",
            ));
        }
        let job = projection_jobs::insert(
            &tx,
            ProjectionJob {
                job_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
                ordinal: "0".into(),
                origin: claimed_jobs.last().unwrap().origin.clone(),
                work: ProjectionWork::Move,
                target: physical.clone(),
                affected: vec![member.change.clone()],
                completed: false,
            },
            None,
        )?;
        let successor = NamespaceAttempt {
            job: job.clone(),
            members: vec![member],
            completed: false,
            delegated_to: None,
        };
        insert_attempt(&tx, &successor)?;
        let attachment = Attachment {
            job_id: job.job_id.clone(),
            jobs: claimed_jobs,
            claims,
            obsolete: vec![],
            desired: vec![plan.target.clone()],
            physical: vec![physical],
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
        let record = Succession {
            plan: plan.clone(),
            successor: successor.clone(),
            attachment,
        };
        tx.execute("INSERT INTO namespace_successions(predecessor_job_id,successor_job_id,predecessor_metadata,record) VALUES(?1,?2,?3,?4)", params![old_id.as_str(), job.job_id.as_str(), serde_json::to_string(&metadata_of(&plan.predecessor))?, serde_json::to_string(&record)?])?;
        tx.commit()?;
        Ok(successor)
    }
    /// Exact journal linkage only; native code derives its private retained name
    /// from this job/member identity, never from a caller-supplied path.
    pub fn namespace_predecessor(
        &self,
        successor: &OperationId,
    ) -> Result<Option<NamespaceAttempt>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = by_successor(&tx, successor)?
            .map(|link| get(&tx, &link.plan.predecessor.job.job_id))
            .transpose()?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::VaultPath;
    use zorid_sync_protocol::{RealmId, VaultId};
    fn op(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn id() -> EntryId {
        EntryId::new("file").unwrap()
    }
    fn request(operation: &str, mutation: Mutation) -> MutationRequest {
        MutationRequest {
            operation_id: op(operation),
            mutation,
        }
    }
    fn apply_move(store: &mut Store, operation: &str, path: &str) {
        let current = store.read(&id()).unwrap().unwrap().state;
        store
            .family_apply(
                &request(
                    operation,
                    Mutation::Move {
                        id: id(),
                        expected: current.revision,
                        path: VaultPath::new(path).unwrap(),
                    },
                ),
                None,
            )
            .unwrap();
    }
    fn apply_write(store: &mut Store, operation: &str, content: &[u8]) {
        let current = store.read(&id()).unwrap().unwrap().state;
        store
            .family_apply(
                &request(
                    operation,
                    Mutation::Write {
                        id: id(),
                        expected: current.revision,
                        content: content.to_vec(),
                    },
                ),
                None,
            )
            .unwrap();
    }
    fn setup(db: &std::path::Path) -> (Store, NamespaceAttempt) {
        let mut store = Store::open(db).unwrap();
        store
            .family_enroll(&FamilyScope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        store
            .family_apply(
                &request(
                    "create",
                    Mutation::Create {
                        id: id(),
                        path: VaultPath::new("original.md").unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"original bytes".to_vec()),
                    },
                ),
                Some(FamilyCreateMode::Text),
            )
            .unwrap();
        let publication = store.begin_projection_bound(&id(), "root-inode").unwrap();
        store
            .mark_projection(
                &publication.attempt_id,
                ProjectionPhase::Staged,
                Some("original-inode".into()),
            )
            .unwrap();
        store
            .finish_projection_bound(
                &publication.attempt_id,
                &PhysicalIdentity {
                    inode: "original-inode".into(),
                    parent_inode: "root-inode".into(),
                },
            )
            .unwrap();
        let baseline = store.projection_baseline(&id()).unwrap().unwrap();
        let evidence = NamespaceEvidence {
            before: baseline.state.clone(),
            source_identity: "original-inode".into(),
            source_parent_identity: "root-inode".into(),
            destination_parent_identity: Some("root-inode".into()),
            content: Some(baseline.content.clone()),
            file_baseline: Some(baseline),
            directory_baseline: None,
            physical_binding: store.physical_binding(&id()).unwrap(),
        };
        apply_move(&mut store, "first-move", "superseded.md");
        let jobs = store.pending_namespace_jobs().unwrap();
        let desired = store.family_namespace_targets(&jobs).unwrap();
        let mut attempt = store
            .family_namespace_prepare(&jobs, &desired, &[evidence])
            .unwrap()
            .unwrap();
        let mut captured = attempt.members[0].clone();
        captured.captured = true;
        attempt.members[0] = store
            .update_namespace_member(&attempt.job.job_id, &attempt.members[0], &captured)
            .unwrap();
        apply_write(&mut store, "new-content", b"latest committed content");
        apply_move(&mut store, "latest-move", "latest.md");
        (store, attempt)
    }
    fn finish(store: &mut Store, mut successor: NamespaceAttempt) -> NamespaceAttempt {
        let mut next = successor.members[0].clone();
        next.captured = true;
        next.published = true;
        next.finished = true;
        successor.members[0] = store
            .update_namespace_member(&successor.job.job_id, &successor.members[0], &next)
            .unwrap();
        store.finish_namespace(&successor.job.job_id).unwrap()
    }
    fn proof_rows(store: &Store, old: &OperationId) -> (String, String, bool, bool, bool) {
        store.connection.query_row("SELECT m.change,m.evidence,p.captured,p.published,p.finished FROM namespace_members m JOIN namespace_member_progress p USING(job_id,member_index) WHERE m.job_id=?1", [old.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
    }
    #[test]
    fn successor_reopen_settles_exact_claims_preserving_old_evidence_and_new_content_job() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db");
        let (mut store, old) = setup(&db);
        let original = proof_rows(&store, &old.job.job_id);
        let plan = store
            .namespace_successor_plan(&old.job.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(plan.predecessor(), &old);
        assert_eq!(plan.target().path.as_str(), "latest.md");
        let successor = store
            .prepare_namespace_successor(&plan, "latest-parent")
            .unwrap();
        assert_eq!(
            store
                .prepare_namespace_successor(&plan, "latest-parent")
                .unwrap(),
            successor
        );
        assert!(store
            .prepare_namespace_successor(&plan, "another-parent")
            .is_err());
        let delegated = store.namespace_attempt(&old.job.job_id).unwrap();
        assert_eq!(delegated.delegated_to.as_ref(), Some(&successor.job.job_id));
        assert!(!delegated.completed);
        assert_eq!(delegated.members, old.members);
        assert_eq!(proof_rows(&store, &old.job.job_id), original);
        assert!(store.namespace_validate_target(&old.job.job_id).is_err());
        assert!(store
            .update_namespace_member(&old.job.job_id, &old.members[0], &old.members[0])
            .is_err());
        assert!(store.finish_namespace(&old.job.job_id).is_err());
        assert!(store
            .namespace_successor_plan(&old.job.job_id)
            .unwrap()
            .is_none());
        assert!(store
            .namespace_successor_plan(&successor.job.job_id)
            .unwrap()
            .is_none());
        assert!(store.finish_namespace(&successor.job.job_id).is_err());
        assert_eq!(
            store.namespace_predecessor(&successor.job.job_id).unwrap(),
            Some(delegated)
        );
        drop(store);
        let mut store = Store::open(&db).unwrap();
        let successor = finish(&mut store, successor);
        assert!(successor.completed);
        let delegated = store
            .namespace_predecessor(&successor.job.job_id)
            .unwrap()
            .unwrap();
        assert!(delegated.completed);
        assert_eq!(delegated.members, old.members);
        assert_eq!(proof_rows(&store, &old.job.job_id), original);
        assert!(store.pending_namespace_jobs().unwrap().is_empty());
        let baseline = store.projection_baseline(&id()).unwrap().unwrap();
        assert_eq!(baseline.state.path.as_str(), "latest.md");
        assert_eq!(
            baseline.content,
            StoredContent::InlineBytes(b"original bytes".to_vec())
        );
        let binding = store.physical_binding(&id()).unwrap().unwrap();
        assert_eq!(binding.state, baseline.state);
        assert_eq!(binding.physical.inode, "original-inode");
        assert_eq!(binding.physical.parent_inode, "latest-parent");
        assert_eq!(
            store.read(&id()).unwrap().unwrap().content.unwrap(),
            b"latest committed content"
        );
        assert!(store
            .pending_projection_jobs(100)
            .unwrap()
            .iter()
            .any(|job| job.work == ProjectionWork::MaterializeFile));
        assert_eq!(
            store.finish_namespace(&successor.job.job_id).unwrap(),
            successor
        );
        drop(store);
        let store = Store::open(&db).unwrap();
        assert_eq!(
            store
                .namespace_predecessor(&successor.job.job_id)
                .unwrap()
                .unwrap()
                .members,
            old.members
        );
        assert!(store.namespace_attempts(false).unwrap().is_empty());
    }
    #[test]
    fn selected_successor_cas_rejects_changed_progress_target_frontier_binding_baseline_claim_or_job(
    ) {
        for mutation in [
            "progress", "target", "frontier", "binding", "baseline", "claim", "job",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join("db");
            let (mut store, old) = setup(&db);
            let plan = store
                .namespace_successor_plan(&old.job.job_id)
                .unwrap()
                .unwrap();
            match mutation {
                "progress" => {
                    let mut next = old.members[0].clone();
                    next.published = true;
                    store
                        .update_namespace_member(&old.job.job_id, &old.members[0], &next)
                        .unwrap();
                }
                "target" => apply_write(&mut store, "after-plan", b"advanced again"),
                "frontier" => {
                    store.connection.execute("UPDATE family_materializations SET record=json_set(record,'$.publication.namespace_heads',json('[\"other-frontier\"]')) WHERE entry_id='file'", []).unwrap();
                }
                "binding" => {
                    store.connection.execute("UPDATE physical_bindings SET inode='replacement',record=json_set(record,'$.physical.inode','replacement') WHERE entry_id='file'", []).unwrap();
                }
                "baseline" => {
                    store.connection.execute("UPDATE projection_baselines SET record=json_set(record,'$.content.content',json('[1]')) WHERE entry_id='file'", []).unwrap();
                }
                "claim" => {
                    store
                        .connection
                        .execute(
                            "UPDATE family_namespace_covered SET satisfied=1 WHERE job_id=?1",
                            [old.job.job_id.as_str()],
                        )
                        .unwrap();
                }
                "job" => {
                    store
                        .connection
                        .execute(
                            "UPDATE projection_jobs SET completed=1 WHERE job_id=?1",
                            [plan.jobs.last().unwrap().job_id.as_str()],
                        )
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                store.prepare_namespace_successor(&plan, "parent").is_err(),
                "{mutation}"
            );
            assert_eq!(
                store
                    .connection
                    .query_row("SELECT count(*) FROM namespace_successions", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{mutation}"
            );
        }
    }
    #[test]
    fn successor_finish_rejects_later_frontier_and_preserves_both_responsibilities() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, old) = setup(&dir.path().join("db"));
        let plan = store
            .namespace_successor_plan(&old.job.job_id)
            .unwrap()
            .unwrap();
        let successor = store.prepare_namespace_successor(&plan, "parent").unwrap();
        apply_write(&mut store, "later-write", b"later authoritative bytes");
        let mut next = successor.members[0].clone();
        next.captured = true;
        next.published = true;
        next.finished = true;
        store
            .update_namespace_member(&successor.job.job_id, &successor.members[0], &next)
            .unwrap();
        assert!(store.finish_namespace(&successor.job.job_id).is_err());
        assert!(!store.namespace_attempt(&old.job.job_id).unwrap().completed);
        assert!(
            !store
                .namespace_attempt(&successor.job.job_id)
                .unwrap()
                .completed
        );
        assert_eq!(
            store.projection_baseline(&id()).unwrap().unwrap(),
            old.members[0].evidence.file_baseline.clone().unwrap()
        );
        assert_eq!(
            store.read(&id()).unwrap().unwrap().content.unwrap(),
            b"later authoritative bytes"
        );
    }
    #[test]
    fn persisted_delegation_rejects_changed_inherited_progress_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db");
        let (mut store, old) = setup(&db);
        let plan = store
            .namespace_successor_plan(&old.job.job_id)
            .unwrap()
            .unwrap();
        let successor = store.prepare_namespace_successor(&plan, "parent").unwrap();
        store
            .connection
            .execute(
                "UPDATE namespace_member_progress SET published=1 WHERE job_id=?1",
                [old.job.job_id.as_str()],
            )
            .unwrap();
        drop(store);
        let store = Store::open(&db).unwrap();
        assert!(store.namespace_attempt(&old.job.job_id).is_err());
        assert!(store.namespace_predecessor(&successor.job.job_id).is_err());
        assert!(store
            .namespace_validate_target(&successor.job.job_id)
            .is_err());
    }
    #[test]
    fn delegated_status_never_selects_or_decodes_full_immutable_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, old) = setup(&dir.path().join("db"));
        let plan = store
            .namespace_successor_plan(&old.job.job_id)
            .unwrap()
            .unwrap();
        store.prepare_namespace_successor(&plan, "parent").unwrap();
        store
            .connection
            .execute(
                "UPDATE namespace_successions SET record='invalid immutable body'",
                [],
            )
            .unwrap();
        let rows = store.namespace_attempt_metadata(true).unwrap();
        assert!(rows
            .iter()
            .any(|row| row.job.job_id == old.job.job_id && row.delegated_to.is_some()));
        assert!(store.namespace_attempt(&old.job.job_id).is_err());
        store.connection.execute("UPDATE namespace_successions SET predecessor_metadata=json_set(predecessor_metadata,'$.members[0].captured',json('false'))", []).unwrap();
        assert!(store.namespace_attempt_metadata(true).is_err());
    }
    #[test]
    fn successor_finish_rechecks_inherited_claim_job_binding_and_baseline() {
        for change in ["claim", "job", "binding", "baseline"] {
            let dir = tempfile::tempdir().unwrap();
            let (mut store, old) = setup(&dir.path().join("db"));
            let plan = store
                .namespace_successor_plan(&old.job.job_id)
                .unwrap()
                .unwrap();
            let successor = store.prepare_namespace_successor(&plan, "parent").unwrap();
            let mut next = successor.members[0].clone();
            next.captured = true;
            next.published = true;
            next.finished = true;
            store
                .update_namespace_member(&successor.job.job_id, &successor.members[0], &next)
                .unwrap();
            match change {
                "claim" => {
                    store
                        .connection
                        .execute(
                            "UPDATE family_namespace_covered SET satisfied=1 WHERE job_id=?1",
                            [old.job.job_id.as_str()],
                        )
                        .unwrap();
                }
                "job" => {
                    store
                        .connection
                        .execute(
                            "UPDATE projection_jobs SET completed=1 WHERE job_id=?1",
                            [plan.attachment.jobs[0].job_id.as_str()],
                        )
                        .unwrap();
                }
                "binding" => {
                    store.connection.execute("UPDATE physical_bindings SET inode='replacement',record=json_set(record,'$.physical.inode','replacement') WHERE entry_id='file'", []).unwrap();
                }
                "baseline" => {
                    store.connection.execute("UPDATE projection_baselines SET record=json_set(record,'$.content.content',json('[1]')) WHERE entry_id='file'", []).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                store.finish_namespace(&successor.job.job_id).is_err(),
                "{change}"
            );
            assert!(!store.namespace_attempt(&old.job.job_id).unwrap().completed);
            assert!(
                !store
                    .namespace_attempt(&successor.job.job_id)
                    .unwrap()
                    .completed
            );
            assert_eq!(
                store.read(&id()).unwrap().unwrap().content.unwrap(),
                b"latest committed content"
            );
        }
    }
    #[test]
    fn exact_schema_twelve_migration_preserves_pending_capture_and_old_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db");
        let (store, old) = setup(&db);
        let original = proof_rows(&store, &old.job.job_id);
        drop(store);
        let connection = Connection::open(&db).unwrap();
        connection.execute_batch("DROP TABLE namespace_successions; PRAGMA user_version=12; PRAGMA journal_mode=DELETE;").unwrap();
        drop(connection);
        let store = Store::open(&db).unwrap();
        assert_eq!(
            store
                .connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            13
        );
        assert_eq!(store.namespace_attempt(&old.job.job_id).unwrap(), old);
        assert_eq!(proof_rows(&store, &old.job.job_id), original);
        assert!(store
            .namespace_successor_plan(&old.job.job_id)
            .unwrap()
            .is_some());
    }
    #[test]
    fn foreign_or_partial_schema_twelve_is_rejected_before_journal_or_bytes_change() {
        for change in [
            "CREATE TABLE unexpected(value)",
            "CREATE TRIGGER unexpected AFTER INSERT ON entries BEGIN SELECT 1; END",
            SCHEMA[0].1,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join("db");
            let store = Store::open(&db).unwrap();
            drop(store);
            let connection = Connection::open(&db).unwrap();
            connection.execute_batch("DROP TABLE namespace_successions; PRAGMA user_version=12; PRAGMA journal_mode=DELETE;").unwrap();
            connection.execute_batch(change).unwrap();
            drop(connection);
            let before = std::fs::read(&db).unwrap();
            assert!(Store::open(&db).is_err());
            assert_eq!(std::fs::read(&db).unwrap(), before);
            let connection = Connection::open(&db).unwrap();
            assert_eq!(
                connection
                    .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                12
            );
            assert_eq!(
                connection
                    .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                    .unwrap(),
                "delete"
            );
        }
    }
}
