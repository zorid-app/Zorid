//! Attach received/authored family namespace obligations to proven local inodes.
//! The graph decides the desired targets; saved physical bindings alone identify
//! source occupants. This adapter never discovers members by walking a subtree.
use super::content_stream::{core_client, file_snapshot, snapshot_matches_content};
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use zorid_store::{
    namespace_content_evidence_bytes, DirectoryAttempt, NamespaceEvidence, ObservationPhysical,
    PhysicalBinding, ProjectionJob, MAX_NAMESPACE_EVIDENCE_BYTES, MAX_NAMESPACE_MEMBERS,
};

#[derive(Debug, Default)]
pub(super) struct FamilyNamespaceRecoveryCursor {
    directories: BTreeMap<OperationId, DirectoryAttempt>,
    failed_directories: BTreeSet<OperationId>,
    publications: BTreeSet<OperationId>,
    failed_publications: BTreeSet<OperationId>,
    groups: BTreeMap<Vec<OperationId>, FamilyNamespaceGroupStamp>,
    oversized: Option<Vec<ProjectionJob>>,
}

#[derive(Debug, PartialEq, Eq)]
struct FamilyNamespaceGroupStamp {
    jobs: Vec<ProjectionJob>,
    bindings: BTreeMap<EntryId, Option<PhysicalBinding>>,
}

fn root(parents: &mut [usize], mut index: usize) -> usize {
    while parents[index] != index {
        parents[index] = parents[parents[index]];
        index = parents[index];
    }
    index
}
fn connect(parents: &mut [usize], left: usize, right: usize) {
    let left = root(parents, left);
    let right = root(parents, right);
    if left != right {
        parents[right] = left;
    }
}
/// Connect explicit identity/path footprints, including the original physical
/// path when several logical moves have accumulated before local publication.
fn connected_jobs(
    jobs: &[ProjectionJob],
    bindings: &BTreeMap<EntryId, Option<PhysicalBinding>>,
) -> Vec<Vec<usize>> {
    let mut parents: Vec<_> = (0..jobs.len()).collect();
    let mut entries = BTreeMap::new();
    let mut paths: BTreeMap<VaultPath, (usize, bool)> = BTreeMap::new();
    for (index, job) in jobs.iter().enumerate() {
        for change in &job.affected {
            if let Some(prior) = entries.insert(change.after.id.clone(), index) {
                connect(&mut parents, prior, index);
            }
            for state in change
                .before
                .iter()
                .chain(std::iter::once(&change.after))
                .chain(
                    bindings
                        .get(&change.after.id)
                        .and_then(Option::as_ref)
                        .map(|b| &b.state),
                )
            {
                let folder = state.kind == EntryKind::Folder;
                match paths.get_mut(&state.path) {
                    Some((prior, was_folder)) => {
                        connect(&mut parents, *prior, index);
                        *was_folder |= folder;
                    }
                    None => {
                        paths.insert(state.path.clone(), (index, folder));
                    }
                }
            }
        }
    }
    for (path, (index, _)) in &paths {
        let mut ancestor = path.parent();
        while let Some(path) = ancestor {
            if let Some((parent, true)) = paths.get(&path) {
                connect(&mut parents, *index, *parent);
            }
            ancestor = path.parent();
        }
    }
    let mut groups = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..jobs.len() {
        groups
            .entry(root(&mut parents, index))
            .or_default()
            .push(index);
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by_key(|group| group[0]);
    groups
}

impl NativeVault {
    /// Preserve settlement-before-grouping ordering: a settled historical
    /// publication can change the physical path used to connect namespace jobs.
    /// Each settlement and each complete connected component is one atomic unit.
    pub(super) fn attach_family_namespaces_quantum(
        &mut self,
        cursor: &mut FamilyNamespaceRecoveryCursor,
        budget: &mut super::external_scan_quantum::ExternalWorkBudget,
        report: &mut ReconcileReport,
    ) -> Result<bool> {
        if !self.store.family_is_enrolled()? {
            return Ok(true);
        }
        let attempts: BTreeSet<_> = self
            .store
            .namespace_attempt_metadata(true)?
            .into_iter()
            .map(|a| a.job.job_id)
            .collect();
        let jobs: Vec<_> = self
            .store
            .pending_namespace_jobs()?
            .into_iter()
            .filter(|job| !attempts.contains(&job.job_id))
            .collect();
        if jobs.is_empty() {
            return Ok(true);
        }
        let references = jobs
            .iter()
            .try_fold(0usize, |count, job| count.checked_add(job.affected.len()));
        if jobs.len() > MAX_NAMESPACE_MEMBERS
            || references.is_none_or(|n| n > MAX_NAMESPACE_MEMBERS)
        {
            if cursor.oversized.as_ref() != Some(&jobs) {
                if !budget.try_unit("namespace:family:oversized".into()) {
                    return Ok(false);
                }
                report.blocked.push((
                    jobs[0].target.path.clone(),
                    "family namespace attachment bound exceeded; all jobs retained".into(),
                ));
                cursor.oversized = Some(jobs);
            }
            return Ok(true);
        }
        let member_ids: BTreeSet<_> = jobs
            .iter()
            .flat_map(|job| job.affected.iter().map(|c| c.after.id.clone()))
            .collect();
        let mut unsettled = BTreeSet::new();
        for metadata in self.store.directory_attempts(false)? {
            if !member_ids.contains(&metadata.target.id) {
                continue;
            }
            let id = &metadata.attempt_id;
            if cursor.directories.get(id) != Some(&metadata) {
                if !budget.try_unit(format!("namespace:directory-settle:{}", id.as_str())) {
                    return Ok(false);
                }
                // Directory attempts contain only metadata. Reread after
                // admission so settlement never acts on a cached attempt.
                if let Some(attempt) = self
                    .store
                    .directory_attempts(false)?
                    .into_iter()
                    .find(|a| a.attempt_id == *id)
                {
                    if let Err(error) = self.settle_namespace_directory(&attempt) {
                        cursor.failed_directories.insert(id.clone());
                        report
                            .blocked
                            .push((attempt.target.path, error.to_string()));
                    } else {
                        cursor.failed_directories.remove(id);
                    }
                } else {
                    cursor.failed_directories.remove(id);
                }
                cursor.directories.insert(id.clone(), metadata.clone());
            }
            if cursor.failed_directories.contains(id) {
                unsettled.insert(metadata.target.id);
            }
        }
        for entry in &member_ids {
            // Metadata-only selection. In particular, ordinary file history
            // unrelated to a namespace component is never decoded here.
            for id in self.store.projection_attempt_ids_for_entry(entry)? {
                if !cursor.publications.contains(&id) {
                    if !budget.try_unit(format!("namespace:file-settle:{}", id.as_str())) {
                        return Ok(false);
                    }
                    let attempt = self.store.projection_attempt(&id)?;
                    if attempt.target.state.id != *entry {
                        return Err(zorid_store::StoreError::Corrupt(
                            "namespace publication entry selection differs".into(),
                        )
                        .into());
                    }
                    if !attempt.completed() {
                        if let Err(error) = self.settle_namespace_publication(&attempt) {
                            cursor.failed_publications.insert(id.clone());
                            report
                                .blocked
                                .push((attempt.target.state.path, error.to_string()));
                        } else {
                            cursor.failed_publications.remove(&id);
                        }
                    } else {
                        cursor.failed_publications.remove(&id);
                    }
                    cursor.publications.insert(id.clone());
                }
                if cursor.failed_publications.contains(&id) {
                    unsettled.insert(entry.clone());
                }
            }
        }
        let mut bindings = BTreeMap::new();
        for id in &member_ids {
            bindings.insert(id.clone(), self.store.physical_binding(id)?);
        }
        for indexes in connected_jobs(&jobs, &bindings) {
            let group: Vec<_> = indexes.iter().map(|index| jobs[*index].clone()).collect();
            let ids: Vec<_> = group.iter().map(|job| job.job_id.clone()).collect();
            let group_ids: BTreeSet<_> = group
                .iter()
                .flat_map(|job| job.affected.iter().map(|c| c.after.id.clone()))
                .collect();
            if group_ids.iter().any(|id| unsettled.contains(id)) {
                // Its failed settlement already contributed a blocked result.
                continue;
            }
            let mut stamp = FamilyNamespaceGroupStamp {
                jobs: group.clone(),
                bindings: group_ids
                    .iter()
                    .map(|id| (id.clone(), bindings.get(id).cloned().flatten()))
                    .collect(),
            };
            if cursor.groups.get(&ids) == Some(&stamp) {
                continue;
            }
            if !budget.try_unit(format!("namespace:family-group:{ids:?}")) {
                return Ok(false);
            }
            match self.attach_family_namespace_group(&group) {
                Err(error) => report
                    .blocked
                    .push((group[0].target.path.clone(), error.to_string())),
                Ok(()) => {
                    // A successful group exhausted its exact unclaimed members.
                    // Remember its post-publication bindings to avoid admitting
                    // a second no-op unit just because our own work moved them.
                    for id in &group_ids {
                        stamp
                            .bindings
                            .insert(id.clone(), self.store.physical_binding(id)?);
                    }
                }
            }
            cursor.groups.insert(ids, stamp);
        }
        Ok(true)
    }

    /// Caller holds the vault lock. Call before legacy namespace diagnostics and
    /// normal materialization; existing attempts are resumed by recover_namespaces.
    pub(super) fn attach_family_namespaces(&mut self, report: &mut ReconcileReport) -> Result<()> {
        if !self.store.family_is_enrolled()? {
            return Ok(());
        }
        let attempts: BTreeSet<_> = self
            .store
            .namespace_attempt_metadata(true)?
            .into_iter()
            .map(|a| a.job.job_id)
            .collect();
        let jobs: Vec<_> = self
            .store
            .pending_namespace_jobs()?
            .into_iter()
            .filter(|job| !attempts.contains(&job.job_id))
            .collect();
        if jobs.is_empty() {
            return Ok(());
        }
        // Do not truncate a connected operation. An oversized backlog remains
        // intact for explicit recovery instead of attaching an arbitrary prefix.
        let references = jobs
            .iter()
            .try_fold(0usize, |count, job| count.checked_add(job.affected.len()));
        if jobs.len() > MAX_NAMESPACE_MEMBERS
            || references.is_none_or(|n| n > MAX_NAMESPACE_MEMBERS)
        {
            report.blocked.push((
                jobs[0].target.path.clone(),
                "family namespace attachment bound exceeded; all jobs retained".into(),
            ));
            return Ok(());
        }
        let member_ids: BTreeSet<_> = jobs
            .iter()
            .flat_map(|job| job.affected.iter().map(|c| c.after.id.clone()))
            .collect();
        let mut unsettled = BTreeSet::new();
        for attempt in self.store.directory_attempts(false)? {
            if member_ids.contains(&attempt.target.id) {
                if let Err(error) = self.settle_namespace_directory(&attempt) {
                    unsettled.insert(attempt.target.id.clone());
                    report
                        .blocked
                        .push((attempt.target.path, error.to_string()));
                }
            }
        }
        for attempt in self.store.projection_attempts(false)? {
            if member_ids.contains(&attempt.target.state.id) {
                if let Err(error) = self.settle_namespace_publication(&attempt) {
                    unsettled.insert(attempt.target.state.id.clone());
                    report
                        .blocked
                        .push((attempt.target.state.path, error.to_string()));
                }
            }
        }
        let mut bindings = BTreeMap::new();
        for job in &jobs {
            for change in &job.affected {
                if !bindings.contains_key(&change.after.id) {
                    bindings.insert(
                        change.after.id.clone(),
                        self.store.physical_binding(&change.after.id)?,
                    );
                }
            }
        }
        let groups = connected_jobs(&jobs, &bindings);
        for indexes in groups {
            let group: Vec<_> = indexes.iter().map(|index| jobs[*index].clone()).collect();
            if group
                .iter()
                .any(|job| job.affected.iter().any(|c| unsettled.contains(&c.after.id)))
            {
                continue;
            }
            let diagnostic = group[0].target.path.clone();
            let outcome = self.attach_family_namespace_group(&group);
            if let Err(error) = outcome {
                report.blocked.push((diagnostic, error.to_string()));
            }
            // A physical move may retain an older content frontier. Do not mark
            // its IDs projected: ordinary publication must still process them.
        }
        Ok(())
    }

    fn attach_family_namespace_group(&mut self, original: &[ProjectionJob]) -> Result<()> {
        // Each successful preparation claims at least one explicit member. The
        // final extra iteration observes that all remaining work was claimed.
        let references: usize = original.iter().map(|job| job.affected.len()).sum();
        for _ in 0..=references {
            let group = original
                .iter()
                .map(|job| self.store.projection_job(&job.job_id))
                .collect::<zorid_store::Result<Vec<_>>>()?
                .into_iter()
                .filter(|job| !job.completed)
                .collect::<Vec<_>>();
            if group.is_empty() {
                return Ok(());
            }
            // Store checks exact pending jobs and returns only members not yet
            // claimed by an active or completed physical attempt.
            let mut targets = self.store.family_namespace_targets(&group)?;
            if targets.is_empty() {
                return Ok(());
            }
            // Remove explicitly deleted children before moving their surviving
            // folder. This does not expand membership from the receiver tree.
            let deleted = targets.iter().any(|target| target.deleted);
            targets.retain(|target| target.deleted == deleted);
            let bindings = targets
                .iter()
                .map(|target| Ok((target.id.clone(), self.store.physical_binding(&target.id)?)))
                .collect::<Result<BTreeMap<_, _>>>()?;
            let evidence = self.family_namespace_evidence(&group, &targets, &bindings)?;
            self.paths.verify()?;
            if let Some(attempt) = self.store.family_namespace_prepare_content(
                &core_client()?,
                &group,
                &targets,
                &evidence,
            )? {
                self.point("family_namespace_prepared");
                self.resume_namespace(attempt)?;
            }
            // None means never-materialized members were satisfied without
            // touching disk. Reload jobs, claims, and bindings before proceeding.
        }
        Err(Error::Busy(
            "family namespace attachment did not make bounded progress",
        ))
    }

    fn family_namespace_evidence(
        &mut self,
        jobs: &[ProjectionJob],
        targets: &[EntryState],
        bindings: &BTreeMap<EntryId, Option<PhysicalBinding>>,
    ) -> Result<Vec<NamespaceEvidence>> {
        let expected: BTreeSet<_> = jobs
            .iter()
            .flat_map(|j| j.affected.iter().map(|c| c.after.id.clone()))
            .collect();
        let actual: BTreeSet<_> = targets.iter().map(|s| s.id.clone()).collect();
        if targets.is_empty() || targets.len() != actual.len() || !actual.is_subset(&expected) {
            return Err(Error::Busy(
                "family namespace targets are not explicit job members",
            ));
        }
        // The preparation transaction additionally requires exactly every still
        // unclaimed member with this disposition; this adapter cannot omit one.
        let deleted = targets[0].deleted;
        if targets.iter().any(|target| target.deleted != deleted) {
            return Err(Error::Busy(
                "mixed family namespace outcomes remain pending",
            ));
        }
        let future_directories: BTreeSet<_> = targets
            .iter()
            .filter(|target| {
                !target.deleted
                    && target.kind == EntryKind::Folder
                    && bindings
                        .get(&target.id)
                        .and_then(Option::as_ref)
                        .is_some_and(|b| b.state.path != target.path)
            })
            .map(|target| target.path.clone())
            .collect();
        let visible: BTreeMap<_, _> = self
            .store
            .list()?
            .into_iter()
            .map(|state| (state.path.clone(), state))
            .collect();
        let mut evidence = Vec::new();
        let mut retained_bytes = 0usize;
        for target in targets {
            let Some(binding) = bindings.get(&target.id).and_then(Option::as_ref) else {
                // Store's preparation transaction additionally requires absence
                // of file/directory baselines and active publication attempts.
                continue;
            };
            if binding.state.id != target.id
                || binding.state.kind != target.kind
                || binding.state.deleted
            {
                return Err(Error::Busy(
                    "family namespace source binding identity mismatch",
                ));
            }
            let before = &binding.state;
            let file_baseline = self.store.projection_baseline(&target.id)?;
            let directory_baseline = self.store.directory_baseline(&target.id)?;
            let (source_parent, source_name) = self.paths.parent(&before.path)?;
            if fs::identity(&source_parent)? != binding.physical.parent_inode {
                return Err(Error::Busy("family namespace source parent was replaced"));
            }
            let content = match before.kind {
                EntryKind::File => {
                    let baseline = file_baseline
                        .as_ref()
                        .ok_or(Error::Busy("bound family source has no file baseline"))?;
                    if baseline.state != *before || directory_baseline.is_some() {
                        return Err(Error::Busy("family source file baseline changed"));
                    }
                    let disk = file_snapshot(&source_parent, &source_name)?
                        .ok_or(Error::Busy("family namespace source file disappeared"))?;
                    if disk.identity != binding.physical.inode
                        || !snapshot_matches_content(&disk, &baseline.content)
                    {
                        return Err(Error::Busy(
                            "family namespace source inode or bytes changed; occupant retained",
                        ));
                    }
                    let physical = ObservationPhysical {
                        physical: binding.physical.clone(),
                        expected_binding: Some(binding.clone()),
                    };
                    let content = self.capture_observed_file(
                        &before.path,
                        &source_parent,
                        &source_name,
                        &jobs[0].job_id,
                        Some(baseline),
                        Some(&physical),
                        &disk,
                        baseline.content.inline_bytes().is_some(),
                    )?;
                    let observed_charge = namespace_content_evidence_bytes(&content)?;
                    let baseline_charge = namespace_content_evidence_bytes(&baseline.content)?;
                    retained_bytes = retained_bytes
                        .checked_add(observed_charge)
                        .and_then(|n| n.checked_add(baseline_charge))
                        .ok_or(Error::Unsupported(
                            "family namespace evidence bound exceeded",
                        ))?;
                    if retained_bytes > MAX_NAMESPACE_EVIDENCE_BYTES {
                        return Err(Error::Unsupported(
                            "family namespace evidence bound exceeded",
                        ));
                    }
                    self.verify_observed_content(
                        &before.path,
                        &source_parent,
                        &binding.physical,
                        &content,
                    )?;
                    Some(content)
                }
                EntryKind::Folder => {
                    let baseline = directory_baseline
                        .as_ref()
                        .ok_or(Error::Busy("bound family source has no directory baseline"))?;
                    if baseline.state != *before
                        || baseline.identity != binding.physical.inode
                        || file_baseline.is_some()
                    {
                        return Err(Error::Busy("family source directory baseline changed"));
                    }
                    let directory = fs::optional_directory(&source_parent, &source_name)?
                        .ok_or(Error::Busy("family namespace source directory disappeared"))?;
                    if fs::identity(&directory)? != binding.physical.inode {
                        return Err(Error::Busy(
                            "family namespace source directory was replaced",
                        ));
                    }
                    // Unknown/late children are retained by the explicit-member
                    // engine after capturing known files, never swept here.
                    None
                }
            };
            self.paths.verify_parent(&before.path, &source_parent)?;
            let destination_parent_identity = if deleted {
                None
            } else if target
                .path
                .parent()
                .as_ref()
                .is_some_and(|p| future_directories.contains(p))
            {
                None
            } else {
                let (parent, _) = self.paths.parent_scope(&target.path)?;
                self.paths.verify_parent_scope(&target.path, &parent)?;
                let inode = fs::identity(&parent)?;
                if let Some(path) = target.path.parent() {
                    let state = visible
                        .get(&path)
                        .filter(|s| s.kind == EntryKind::Folder)
                        .ok_or(Error::Busy(
                            "family destination parent is not a visible directory",
                        ))?;
                    let parent_binding = self.store.physical_binding(&state.id)?.ok_or(
                        Error::Busy("family destination parent lacks physical provenance"),
                    )?;
                    let (grandparent, _) = self.paths.parent_scope(&path)?;
                    self.paths.verify_parent_scope(&path, &grandparent)?;
                    if parent_binding.state.path != path
                        || parent_binding.physical.inode != inode
                        || parent_binding.physical.parent_inode != fs::identity(&grandparent)?
                    {
                        return Err(Error::Busy("family destination parent was replaced"));
                    }
                } else if inode != fs::identity(&self.paths.root)? {
                    return Err(Error::Busy("family destination root changed"));
                }
                Some(inode)
            };
            evidence.push(NamespaceEvidence {
                before: before.clone(),
                source_identity: binding.physical.inode.clone(),
                source_parent_identity: binding.physical.parent_inode.clone(),
                destination_parent_identity,
                content,
                file_baseline,
                directory_baseline,
                physical_binding: Some(binding.clone()),
            });
        }
        Ok(evidence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::EntryChange;
    use zorid_store::{PhysicalIdentity, ProjectionOrigin, ProjectionWork};

    fn state(id: &str, path: &str, kind: EntryKind) -> EntryState {
        EntryState {
            id: EntryId::new(id).unwrap(),
            path: VaultPath::new(path).unwrap(),
            kind,
            revision: Revision::new("revision").unwrap(),
            deleted: false,
        }
    }
    fn job(id: &str, before: EntryState, after: EntryState) -> ProjectionJob {
        let id = OperationId::new(id).unwrap();
        ProjectionJob {
            job_id: id.clone(),
            ordinal: "1".into(),
            origin: ProjectionOrigin::LocalCommand { operation_id: id },
            work: if after.deleted {
                ProjectionWork::Delete
            } else {
                ProjectionWork::Move
            },
            target: after.clone(),
            affected: vec![EntryChange {
                before: Some(before),
                after,
            }],
            completed: false,
        }
    }
    #[test]
    fn explicit_folder_and_child_moves_group_without_sweeping_siblings() {
        let jobs = vec![
            job(
                "folder",
                state("dir", "Old", EntryKind::Folder),
                state("dir", "New", EntryKind::Folder),
            ),
            job(
                "child",
                state("child", "Old/note", EntryKind::File),
                state("child", "New/note", EntryKind::File),
            ),
            job(
                "other",
                state("other", "Oldish/note", EntryKind::File),
                state("other", "Else/note", EntryKind::File),
            ),
        ];
        assert_eq!(
            connected_jobs(&jobs, &BTreeMap::new()),
            vec![vec![0, 1], vec![2]]
        );
    }
    #[test]
    fn move_delete_chain_joins_original_physical_folder_path() {
        let original = state("file", "Old/note", EntryKind::File);
        let logical = state("file", "Else/note", EntryKind::File);
        let moved = state("file", "renamed", EntryKind::File);
        let mut deleted = moved.clone();
        deleted.deleted = true;
        let jobs = vec![
            job(
                "folder",
                state("dir", "Old", EntryKind::Folder),
                state("dir", "New", EntryKind::Folder),
            ),
            job("move", logical, moved.clone()),
            job("delete", moved, deleted),
        ];
        assert_eq!(
            connected_jobs(&jobs, &BTreeMap::new()),
            vec![vec![0], vec![1, 2]]
        );
        let bindings = BTreeMap::from([(
            original.id.clone(),
            Some(PhysicalBinding {
                state: original,
                physical: PhysicalIdentity {
                    inode: "inode".into(),
                    parent_inode: "parent".into(),
                },
            }),
        )]);
        assert_eq!(connected_jobs(&jobs, &bindings), vec![vec![0, 1, 2]]);
    }
}
