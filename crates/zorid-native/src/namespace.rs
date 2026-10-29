//! Explicit-member namespace projection. A local command binds its observed
//! source occupants before commit; replay never guesses ownership from bytes.
use super::content_stream::{file_snapshot, snapshot_matches_content};
use super::*;
use crate::fs_stream::StreamSnapshot;
use std::collections::BTreeMap;
use zorid_store::{
    namespace_content_evidence_bytes, NamespaceAttempt, NamespaceAttemptMetadata,
    NamespaceEvidence, NamespaceMember, NamespaceMemberMetadata, ProjectionJob, ProjectionOrigin,
    ProjectionWork,
};

/// Ephemeral progress for one publication sweep. Metadata, rather than retained
/// byte evidence, identifies work already attempted. The outer scan cursor must
/// discard this cursor when its source/foreign-publication epoch changes.
#[derive(Debug, Default)]
pub(super) struct NamespaceRecoveryCursor {
    successors: BTreeMap<OperationId, NamespaceAttemptMetadata>,
    families: super::family_namespace::FamilyNamespaceRecoveryCursor,
    diagnostics: BTreeMap<OperationId, ProjectionJob>,
    pending: BTreeMap<OperationId, NamespaceAttemptMetadata>,
    audited: BTreeMap<(OperationId, usize), (ProjectionWork, NamespaceMemberMetadata)>,
}

#[cfg(test)]
mod quantum_tests {
    use super::*;
    use std::{num::NonZeroU16, time::Duration};
    use zorid_core::Mutation;

    fn id(value: &str) -> EntryId {
        EntryId::new(value.replace('.', "-")).unwrap()
    }
    fn path(value: &str) -> VaultPath {
        VaultPath::new(value).unwrap()
    }
    fn operation(value: &str) -> OperationId {
        OperationId::new(value.replace('.', "-")).unwrap()
    }
    fn create(vault: &mut NativeVault, name: &str) {
        let result = vault
            .apply(&MutationRequest {
                operation_id: operation(&format!("create-{name}")),
                mutation: Mutation::Create {
                    id: id(name),
                    path: path(name),
                    kind: EntryKind::File,
                    content: Some(name.as_bytes().to_vec()),
                },
            })
            .unwrap();
        assert!(matches!(result.projection, ProjectionStatus::Projected));
    }
    fn delete(vault: &mut NativeVault, name: &str) {
        let expected = vault.store.read(&id(name)).unwrap().unwrap().state.revision;
        let result = vault
            .apply(&MutationRequest {
                operation_id: operation(&format!("delete-{name}")),
                mutation: Mutation::Delete {
                    id: id(name),
                    expected,
                    recursive: false,
                },
            })
            .unwrap();
        assert!(matches!(result.projection, ProjectionStatus::Projected));
    }
    fn step(
        vault: &mut NativeVault,
        cursor: &mut NamespaceRecoveryCursor,
        report: &mut ReconcileReport,
    ) -> (bool, u16) {
        let _guard = vault.paths.lock(vault.options.lock_timeout).unwrap();
        let mut budget = super::super::external_scan_quantum::ExternalWorkBudget::new(
            &ExternalReconcileOptions {
                scan: ScanOptions {
                    max_duration: Duration::from_secs(30),
                    ..Default::default()
                },
                max_work_units: NonZeroU16::new(1).unwrap(),
            },
        )
        .unwrap();
        let done = vault
            .recover_namespaces_quantum(cursor, &mut budget, report)
            .unwrap();
        (done, budget.used())
    }
    #[test]
    fn unchanged_namespace_quantum_has_no_work_units() {
        let root = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        create(&mut vault, "untouched.md");
        let mut cursor = NamespaceRecoveryCursor::default();
        let mut report = ReconcileReport::default();
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (true, 0));
        assert!(report.blocked.is_empty());
    }
    #[test]
    fn completed_deletion_audits_resume_one_member_per_quantum() {
        let root = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        for name in ["one.md", "two.md", "three.md"] {
            create(&mut vault, name);
            delete(&mut vault, name);
        }
        let mut cursor = NamespaceRecoveryCursor::default();
        let mut report = ReconcileReport::default();
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (false, 1));
        assert_eq!(cursor.audited.len(), 1);
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (false, 1));
        assert_eq!(cursor.audited.len(), 2);
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (true, 1));
        assert_eq!(cursor.audited.len(), 3);
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (true, 0));
        assert!(report.blocked.is_empty());
    }
    #[test]
    fn retained_deletion_blocker_survives_yield_without_duplicate_audit() {
        let root = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        for name in ["one.md", "two.md"] {
            create(&mut vault, name);
            delete(&mut vault, name);
        }
        let attempts = vault.store.namespace_attempt_metadata(true).unwrap();
        let retained = root
            .path()
            .join(".zorid")
            .join(format!("{}.0.namespace", attempts[0].job.job_id.as_str()));
        std::fs::write(&retained, b"external recovery edit").unwrap();
        let mut cursor = NamespaceRecoveryCursor::default();
        let mut report = ReconcileReport::default();
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (false, 1));
        assert_eq!(report.blocked.len(), 1);
        assert!(report.blocked[0]
            .1
            .contains("retained deleted file changed"));
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (true, 1));
        assert_eq!(report.blocked.len(), 1);
        assert_eq!(std::fs::read(retained).unwrap(), b"external recovery edit");
    }
    #[test]
    fn independent_family_moves_yield_between_complete_components() {
        use zorid_store::{FamilyCreateMode, FamilyScope};
        use zorid_sync_protocol::{RealmId, VaultId};
        let root = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(root.path()).unwrap();
        vault
            .family_enroll(&FamilyScope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        for name in ["one.md", "two.md"] {
            let result = vault
                .family_apply(
                    &MutationRequest {
                        operation_id: operation(&format!("create-{name}")),
                        mutation: Mutation::Create {
                            id: id(name),
                            path: path(name),
                            kind: EntryKind::File,
                            content: Some(name.as_bytes().to_vec()),
                        },
                    },
                    Some(FamilyCreateMode::Text),
                )
                .unwrap();
            assert!(matches!(result.projection, ProjectionStatus::Projected));
        }
        // Queue both logical moves only after ordinary create recovery ends.
        for name in ["one.md", "two.md"] {
            let expected = vault.store.read(&id(name)).unwrap().unwrap().state.revision;
            vault
                .store
                .family_apply(
                    &MutationRequest {
                        operation_id: operation(&format!("move-{name}")),
                        mutation: Mutation::Move {
                            id: id(name),
                            expected,
                            path: path(&format!("renamed-{name}")),
                        },
                    },
                    None,
                )
                .unwrap();
        }
        let mut cursor = NamespaceRecoveryCursor::default();
        let mut report = ReconcileReport::default();
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (false, 1));
        let moved = ["one.md", "two.md"]
            .into_iter()
            .filter(|name| root.path().join(format!("renamed-{name}")).exists())
            .count();
        assert_eq!(moved, 1);
        assert_eq!(step(&mut vault, &mut cursor, &mut report), (true, 1));
        for name in ["one.md", "two.md"] {
            assert!(!root.path().join(name).exists());
            assert_eq!(
                std::fs::read(root.path().join(format!("renamed-{name}"))).unwrap(),
                name.as_bytes()
            );
        }
        assert!(report.blocked.is_empty());
    }
}

fn retained(a: &NamespaceAttempt, index: usize) -> String {
    format!("{}.{}.namespace", a.job.job_id.as_str(), index)
}
fn stage(a: &NamespaceAttempt, index: usize) -> String {
    format!("{}.{}.directory", a.job.job_id.as_str(), index)
}
fn noop(a: &NamespaceAttempt, index: usize) -> bool {
    a.job.work == ProjectionWork::Move
        && a.members[index].evidence.before.path == a.members[index].change.after.path
}
fn intersects(path: &VaultPath, state: &EntryState) -> bool {
    *path == state.path || (state.kind == EntryKind::Folder && path.is_descendant_of(&state.path))
}
impl NativeVault {
    pub(super) fn namespace_attempt_statuses(&self) -> Result<Vec<NamespaceAttemptStatus>> {
        let mut result = Vec::new();
        for a in self.store.namespace_attempt_metadata(true)? {
            let mut members = Vec::with_capacity(a.members.len());
            for m in &a.members {
                let before = m
                    .change
                    .before
                    .as_ref()
                    .ok_or(Error::Busy("namespace metadata before state missing"))?;
                let unchanged =
                    a.job.work == ProjectionWork::Move && before.path == m.change.after.path;
                members.push(NamespaceMemberStatus {
                    entry_id: m.change.after.id.clone(),
                    source: before.path.clone(),
                    target: m.change.after.path.clone(),
                    recovery_path: format!(
                        ".zorid/{}.{}.namespace",
                        a.job.job_id.as_str(),
                        m.index
                    ),
                    directory_stage_path: (m.change.after.kind == EntryKind::Folder
                        && a.job.work == ProjectionWork::Move
                        && !unchanged)
                        .then(|| format!(".zorid/{}.{}.directory", a.job.job_id.as_str(), m.index)),
                    captured: m.captured,
                    published: m.published,
                    finished: m.finished,
                });
            }
            result.push(NamespaceAttemptStatus {
                job_id: a.job.job_id,
                completed: a.completed,
                delegated_to: a.delegated_to,
                members,
            });
        }
        Ok(result)
    }
    pub(super) fn namespace_obscures(&self, path: &VaultPath) -> Result<bool> {
        Ok(self.store.pending_namespace_jobs()?.iter().any(|job| {
            job.affected.iter().any(|c| {
                intersects(path, &c.after) || c.before.as_ref().is_some_and(|s| intersects(path, s))
            })
        }))
    }
    pub(super) fn namespace_clear(&self, path: &VaultPath) -> Result<()> {
        if self.namespace_obscures(path)? {
            return Err(Error::Busy("pending namespace job obscures this path"));
        }
        Ok(())
    }
    pub(super) fn namespace_status(&mut self, operation: &OperationId) -> ProjectionStatus {
        let result = (|| {
            // Replay is keyed by its original job, even after deletion or a later
            // move. Completed retries need only metadata, never retained bytes.
            let metadata = self.store.namespace_attempt_metadata(true)?.into_iter().find(|a| {
                matches!(&a.job.origin, ProjectionOrigin::LocalCommand { operation_id } if operation_id == operation)
            }).ok_or(Error::Busy("legacy namespace job lacks pre-commit physical provenance"))?;
            if metadata.completed {
                return Ok(());
            }
            self.resume_namespace(self.store.namespace_attempt(&metadata.job.job_id)?)
        })();
        match result {
            Ok(()) => ProjectionStatus::Projected,
            Err(e) => ProjectionStatus::Pending(e.to_string()),
        }
    }
    pub(super) fn apply_namespace_locked(
        &mut self,
        request: &MutationRequest,
    ) -> Result<ApplyOutcome> {
        // Complete existing publications first; never strand their displaced inode
        // by committing a path change before recovery has settled.
        let _ = self.recover_locked()?;
        if let Mutation::Move { path, .. } = &request.mutation {
            self.parent_imports(path)?;
        }
        let planned = zorid_core::plan_mutation(
            request,
            &self.store.list()?,
            &zorid_core::Revision::new(uuid::Uuid::new_v4().to_string())?,
        )?;
        let affected = |c: &&zorid_core::EntryChange| match request.mutation {
            Mutation::Move { .. } => {
                c.after.id == *request.mutation.id()
                    || c.before.as_ref().is_some_and(|b| b.path != c.after.path)
            }
            Mutation::Delete { .. } => c.after.deleted,
            _ => false,
        };
        for change in planned.iter().filter(affected) {
            let before = change
                .before
                .as_ref()
                .ok_or(Error::Busy("namespace source has no before state"))?;
            self.namespace_clear(&before.path)?;
            match before.kind {
                EntryKind::File => {
                    self.observe(&before.path)?;
                    self.project(&before.id)?;
                }
                EntryKind::Folder => {
                    self.project_directory(&before.id)?;
                    self.observe_directory(&before.path)?;
                }
            }
        }
        // External imports above may advance the caller's expected revision.
        // Preserve its CAS; never silently authorize a newer subtree.
        let planned = zorid_core::plan_mutation(
            request,
            &self.store.list()?,
            &zorid_core::Revision::new(uuid::Uuid::new_v4().to_string())?,
        )?;
        let members: Vec<_> = planned.iter().filter(affected).collect();
        if members.len() > 10_000 {
            return Err(Error::Unsupported("namespace member bound exceeded"));
        }
        let mut evidence = Vec::with_capacity(members.len());
        let mut bytes = 0usize;
        for change in &members {
            let before = change
                .before
                .as_ref()
                .ok_or(Error::Busy("namespace source has no before state"))?;
            let (parent, name) = self.paths.parent(&before.path)?;
            let source_parent_identity = fs::identity(&parent)?;
            let (source_identity, content) = match before.kind {
                EntryKind::File => {
                    let disk = file_snapshot(&parent, &name)?
                        .ok_or(Error::Busy("namespace source disappeared"))?;
                    let stored = self
                        .store
                        .read_metadata(&before.id)?
                        .ok_or(Error::Busy("namespace source deleted"))?;
                    let baseline = self
                        .store
                        .projection_baseline(&before.id)?
                        .ok_or(Error::Busy("namespace file has no physical baseline"))?;
                    if stored.state != *before
                        || baseline.state != *before
                        || stored.content.as_ref().is_none_or(|content| {
                            content.len() != baseline.content.len()
                                || content.digest() != &baseline.content.digest()
                        })
                        || !snapshot_matches_content(&disk, &baseline.content)
                    {
                        return Err(Error::Busy("namespace source changed during preflight"));
                    }
                    // Payload storage has its own quota. Namespace evidence
                    // charges inline bytes or exact serialized reference metadata.
                    let charge = namespace_content_evidence_bytes(&baseline.content)?;
                    bytes = bytes
                        .checked_add(charge)
                        .and_then(|n| n.checked_add(charge))
                        .ok_or(Error::Unsupported("namespace evidence bound exceeded"))?;
                    if bytes > zorid_store::MAX_NAMESPACE_EVIDENCE_BYTES {
                        return Err(Error::Unsupported("namespace evidence bound exceeded"));
                    }
                    (disk.identity, Some(baseline.content))
                }
                EntryKind::Folder => {
                    let disk = fs::optional_directory(&parent, &name)?
                        .ok_or(Error::Busy("namespace directory disappeared"))?;
                    let identity = fs::identity(&disk)?;
                    if self
                        .store
                        .directory_baseline(&before.id)?
                        .as_ref()
                        .is_none_or(|b| b.identity != identity || b.state.path != before.path)
                    {
                        return Err(Error::Busy("namespace directory identity changed"));
                    }
                    (identity, None)
                }
            };
            self.paths.verify_parent(&before.path, &parent)?;
            let destination_parent_identity = if matches!(request.mutation, Mutation::Move { .. }) {
                let internal = members.iter().any(|m| {
                    m.after.kind == EntryKind::Folder
                        && change.after.path.parent().as_ref() == Some(&m.after.path)
                        && m.before.as_ref().is_some_and(|b| b.path != m.after.path)
                });
                if internal {
                    None
                } else {
                    let (dest_parent, _) = self.paths.parent_scope(&change.after.path)?;
                    self.paths
                        .verify_parent_scope(&change.after.path, &dest_parent)?;
                    Some(fs::identity(&dest_parent)?)
                }
            } else {
                None
            };
            evidence.push(NamespaceEvidence {
                before: before.clone(),
                source_identity,
                source_parent_identity,
                destination_parent_identity,
                content,
                file_baseline: self.store.projection_baseline(&before.id)?,
                directory_baseline: self.store.directory_baseline(&before.id)?,
                physical_binding: self.store.physical_binding(&before.id)?,
            });
        }
        self.paths.verify()?;
        let commit = self.store.apply_namespace(request, &evidence)?;
        self.point("namespace_committed");
        let projection = self.namespace_status(&request.operation_id);
        Ok(ApplyOutcome { commit, projection })
    }
    fn save_namespace_member(
        &mut self,
        a: &mut NamespaceAttempt,
        index: usize,
        next: NamespaceMember,
    ) -> Result<()> {
        let next = self
            .store
            .update_namespace_member(&a.job.job_id, &a.members[index], &next)?;
        a.members[index] = next;
        Ok(())
    }
    fn namespace_source(&self, m: &NamespaceMember) -> Result<(File, String)> {
        let (parent, name) = self.paths.parent(&m.evidence.before.path)?;
        self.paths.verify_parent(&m.evidence.before.path, &parent)?;
        if fs::identity(&parent)? != m.evidence.source_parent_identity {
            return Err(Error::Busy("namespace source parent replaced"));
        }
        Ok((parent, name))
    }
    fn namespace_destination(&self, a: &NamespaceAttempt, index: usize) -> Result<(File, String)> {
        let m = &a.members[index];
        let path = &m.change.after.path;
        let expected = m
            .evidence
            .destination_parent_identity
            .clone()
            .or_else(|| {
                a.members
                    .iter()
                    .find(|p| {
                        p.change.after.kind == EntryKind::Folder
                            && path.parent().as_ref() == Some(&p.change.after.path)
                    })
                    .and_then(|p| p.directory_stage_identity.clone())
            })
            .ok_or(Error::Busy(
                "namespace destination parent has no provenance",
            ))?;
        let (parent, name) = self.paths.parent(path)?;
        self.paths.verify_parent(path, &parent)?;
        if fs::identity(&parent)? != expected {
            return Err(Error::Busy("namespace destination parent replaced"));
        }
        Ok((parent, name))
    }
    fn namespace_node(&self, parent: &File, name: &str, kind: EntryKind) -> Result<Option<File>> {
        match kind {
            EntryKind::File => fs::regular(parent, name),
            EntryKind::Folder => fs::optional_directory(parent, name),
        }
    }
    fn namespace_divergence(
        &mut self,
        origin: &OperationId,
        m: &NamespaceMember,
        parent: &File,
        name: &str,
        snapshot: &StreamSnapshot,
    ) -> Result<()> {
        let baseline = m.evidence.file_baseline.as_ref();
        let content = self.capture_observed_file(
            &m.evidence.before.path,
            parent,
            name,
            origin,
            baseline,
            None,
            snapshot,
            m.evidence
                .content
                .as_ref()
                .is_some_and(|c| c.inline_bytes().is_some()),
        )?;
        // A retained/private or relocated branch is recoverable content, not a
        // new public-inode binding. Never transfer authority through this capture.
        self.retain_observed_content(&m.evidence.before.path, baseline, &content, None)?;
        Ok(())
    }
    /// Restore only into the original absent pathname. If a replacement occupies
    /// it, keep the captured object at its deterministic recovery name.
    fn restore_unexpected(&self, m: &NamespaceMember, name: &str) {
        if let Ok((parent, source)) = self.namespace_source(m) {
            let _ = fs::rename_new(&self.paths.private, name, &parent, &source);
        }
    }
    /// Transfer only the captured inode named by an immutable Store handoff.
    /// The link commits before any rename. Either retained locator, or the exact
    /// admitted published destination, proves restart progress; never scan for it.
    fn relocate_namespace_predecessor(
        &mut self,
        a: &mut NamespaceAttempt,
        index: usize,
    ) -> Result<()> {
        let Some(predecessor) = self.store.namespace_predecessor(&a.job.job_id)? else {
            return Ok(());
        };
        if index != 0
            || a.members.len() != 1
            || predecessor.members.len() != 1
            || predecessor.delegated_to.as_ref() != Some(&a.job.job_id)
            || predecessor.job.work != ProjectionWork::Move
            || a.job.work != ProjectionWork::Move
        {
            return Err(Error::Busy("namespace predecessor link differs"));
        }
        let prior = &predecessor.members[0];
        let member = a.members[0].clone();
        if !prior.captured
            || prior.published
            || prior.finished
            || prior.evidence.before.kind != EntryKind::File
            || member.evidence.before != prior.evidence.before
            || member.evidence.source_identity != prior.evidence.source_identity
            || member.evidence.source_parent_identity != prior.evidence.source_parent_identity
            || member.evidence.content != prior.evidence.content
            || member.evidence.file_baseline != prior.evidence.file_baseline
            || member.evidence.directory_baseline != prior.evidence.directory_baseline
            || member.evidence.physical_binding != prior.evidence.physical_binding
        {
            return Err(Error::Busy("namespace predecessor capture differs"));
        }
        self.paths.verify()?;
        // A captured file does not authorize a substituted historical parent.
        self.namespace_source(prior)?;
        let (destination_parent, destination_name) = self.namespace_destination(a, 0)?;
        let private = self.paths.private.try_clone()?;
        let old_name = retained(&predecessor, 0);
        let new_name = retained(a, 0);
        let old = file_snapshot(&private, &old_name)?;
        let new = file_snapshot(&private, &new_name)?;
        let destination = file_snapshot(&destination_parent, &destination_name)?;
        let count = usize::from(old.is_some())
            + usize::from(new.is_some())
            + usize::from(destination.is_some());
        if count != 1 {
            return Err(Error::Busy(
                "namespace handoff has ambiguous physical locations",
            ));
        }
        let (snapshot, parent, name) = if let Some(snapshot) = old.as_ref() {
            (snapshot, &private, old_name.as_str())
        } else if let Some(snapshot) = new.as_ref() {
            (snapshot, &private, new_name.as_str())
        } else {
            (
                destination.as_ref().unwrap(),
                &destination_parent,
                destination_name.as_str(),
            )
        };
        if snapshot.identity != prior.evidence.source_identity {
            return Err(Error::Busy("namespace handoff inode differs"));
        }
        if prior
            .evidence
            .content
            .as_ref()
            .is_none_or(|content| !snapshot_matches_content(snapshot, content))
        {
            self.namespace_divergence(&predecessor.job.job_id, prior, parent, name, snapshot)?;
            return Err(Error::Busy("changed namespace handoff content retained"));
        }
        if old.is_some() {
            self.point("namespace_successor_before_relocate");
            self.paths.verify()?;
            self.namespace_source(prior)?;
            self.namespace_destination(a, 0)?;
            if file_snapshot(&private, &old_name)?.as_ref() != old.as_ref()
                || fs::node_type(&private, &new_name)?.is_some()
                || fs::node_type(&destination_parent, &destination_name)?.is_some()
            {
                return Err(Error::Busy("namespace handoff changed before relocation"));
            }
            fs::rename_new(&private, &old_name, &private, &new_name)?;
            self.paths.verify()?;
            self.point("namespace_successor_relocated_before_record");
        } else if destination.is_some() && !member.captured {
            // Publication can outlive its progress marker. Admit only the saved
            // inode/content under its independently saved destination parent.
            fs::regular(&destination_parent, &destination_name)?
                .ok_or(Error::Busy("namespace handoff destination disappeared"))?
                .sync_all()?;
            destination_parent.sync_all()?;
            self.paths
                .verify_parent(&member.change.after.path, &destination_parent)?;
            if file_snapshot(&destination_parent, &destination_name)?.as_ref()
                != destination.as_ref()
            {
                return Err(Error::Busy("namespace handoff destination changed"));
            }
            let mut next = member;
            next.captured = true;
            self.save_namespace_member(a, 0, next)?;
        }
        Ok(())
    }

    fn capture_namespace_member(&mut self, a: &mut NamespaceAttempt, index: usize) -> Result<()> {
        self.relocate_namespace_predecessor(a, index)?;
        let m = a.members[index].clone();
        if noop(a, index) || m.captured {
            return Ok(());
        }
        let private = retained(a, index);
        let kind = m.evidence.before.kind;
        if fs::node_type(&self.paths.private, &private)?.is_none() {
            let (parent, source) = self.namespace_source(&m)?;
            let disk = self
                .namespace_node(&parent, &source, kind)?
                .ok_or(Error::Busy(
                    "namespace source missing without capture proof",
                ))?;
            if fs::identity(&disk)? != m.evidence.source_identity {
                return Err(Error::Busy(
                    "namespace source was recreated; left untouched",
                ));
            }
            if kind == EntryKind::Folder && !fs::directory_empty(&disk)? {
                return Err(Error::Busy("unlisted child remains in source directory"));
            }
            // Source replacement can race the check. NOREPLACE protects the
            // destination only, so verify the captured object below before use.
            self.point("namespace_before_capture");
            self.paths.verify_parent(&m.evidence.before.path, &parent)?;
            fs::rename_new(&parent, &source, &self.paths.private, &private)?;
            self.point("namespace_captured_before_record");
        }
        let captured = self.namespace_node(&self.paths.private, &private, kind);
        let valid = match captured {
            Ok(Some(ref file)) => fs::identity(file)? == m.evidence.source_identity,
            _ => false,
        };
        if !valid {
            self.restore_unexpected(&m, &private);
            return Err(Error::Busy(
                "captured source identity changed; restored or retained for recovery",
            ));
        }
        let captured = captured?.ok_or(Error::Busy("namespace capture disappeared"))?;
        if kind == EntryKind::Folder && !fs::directory_empty(&captured)? {
            self.restore_unexpected(&m, &private);
            return Err(Error::Busy(
                "late child retained; source directory restored where possible",
            ));
        }
        if kind == EntryKind::File {
            let recovery_parent = self.paths.private.try_clone()?;
            let snapshot = file_snapshot(&recovery_parent, &private)?
                .ok_or(Error::Busy("namespace capture disappeared"))?;
            if snapshot.identity != m.evidence.source_identity {
                return Err(Error::Busy("namespace captured file was replaced"));
            }
            if m.evidence
                .content
                .as_ref()
                .is_none_or(|content| !snapshot_matches_content(&snapshot, content))
            {
                self.namespace_divergence(
                    &a.job.job_id,
                    &m,
                    &recovery_parent,
                    &private,
                    &snapshot,
                )?;
                return Err(Error::Busy("external edit retained in namespace capture"));
            }
        }
        captured.sync_all()?;
        let mut next = m;
        next.captured = true;
        self.save_namespace_member(a, index, next)?;
        self.point("namespace_captured");
        Ok(())
    }
    fn publish_namespace_directory(
        &mut self,
        a: &mut NamespaceAttempt,
        index: usize,
    ) -> Result<()> {
        let m = a.members[index].clone();
        if noop(a, index) {
            return Ok(());
        }
        let private = stage(a, index);
        let identity = if let Some(identity) = &m.directory_stage_identity {
            identity.clone()
        } else {
            let identity = if let Some(dir) = fs::optional_directory(&self.paths.private, &private)?
            {
                if !fs::directory_empty(&dir)? {
                    return Err(Error::Busy("unexpected namespace directory stage contents"));
                }
                dir.sync_all()?;
                self.paths.private.sync_all()?;
                fs::identity(&dir)?
            } else {
                fs::stage_directory(&self.paths.private, &private)?
            };
            self.point("namespace_directory_stage_written");
            let mut next = m.clone();
            next.directory_stage_identity = Some(identity.clone());
            self.save_namespace_member(a, index, next)?;
            self.point("namespace_directory_staged");
            identity
        };
        let (parent, name) = self.namespace_destination(a, index)?;
        if let Some(dest) = fs::optional_directory(&parent, &name)? {
            if fs::identity(&dest)? != identity {
                return Err(Error::Busy("namespace directory destination occupied"));
            }
            dest.sync_all()?;
        } else {
            let staged = fs::optional_directory(&self.paths.private, &private)?
                .ok_or(Error::Busy("namespace directory stage disappeared"))?;
            if fs::identity(&staged)? != identity || !fs::directory_empty(&staged)? {
                return Err(Error::Busy("namespace directory stage changed"));
            }
            fs::rename_new(&self.paths.private, &private, &parent, &name)?;
            self.point("namespace_directory_published_before_record");
        }
        self.paths.verify_parent(&m.change.after.path, &parent)?;
        let dest = fs::optional_directory(&parent, &name)?
            .ok_or(Error::Busy("namespace directory destination disappeared"))?;
        if fs::identity(&dest)? != identity {
            return Err(Error::Busy("namespace directory destination replaced"));
        }
        parent.sync_all()?;
        if !a.members[index].published {
            let mut next = a.members[index].clone();
            next.published = true;
            self.save_namespace_member(a, index, next)?;
        }
        Ok(())
    }
    fn publish_namespace_file(&mut self, a: &mut NamespaceAttempt, index: usize) -> Result<()> {
        if noop(a, index) {
            return Ok(());
        }
        let m = a.members[index].clone();
        let private = retained(a, index);
        let (parent, name) = self.namespace_destination(a, index)?;
        if let Some(dest) = fs::regular(&parent, &name)? {
            if fs::identity(&dest)? != m.evidence.source_identity {
                return Err(Error::Busy(
                    "namespace destination was occupied or recreated",
                ));
            }
        } else {
            let recovery_parent = self.paths.private.try_clone()?;
            let source = file_snapshot(&recovery_parent, &private)?
                .ok_or(Error::Busy("namespace retained source disappeared"))?;
            if source.identity != m.evidence.source_identity {
                return Err(Error::Busy("namespace retained source replaced"));
            }
            if m.evidence
                .content
                .as_ref()
                .is_none_or(|content| !snapshot_matches_content(&source, content))
            {
                self.namespace_divergence(&a.job.job_id, &m, &recovery_parent, &private, &source)?;
                return Err(Error::Busy(
                    "external edit retained before namespace publication",
                ));
            }
            fs::rename_new(&self.paths.private, &private, &parent, &name)?;
            self.point("namespace_published_before_record");
        }
        self.paths.verify_parent(&m.change.after.path, &parent)?;
        let dest = file_snapshot(&parent, &name)?
            .ok_or(Error::Busy("namespace destination disappeared"))?;
        if dest.identity != m.evidence.source_identity {
            return Err(Error::Busy("namespace destination replaced"));
        }
        if m.evidence
            .content
            .as_ref()
            .is_none_or(|content| !snapshot_matches_content(&dest, content))
        {
            self.namespace_divergence(&a.job.job_id, &m, &parent, &name, &dest)?;
            return Err(Error::Busy(
                "external edit retained at namespace destination",
            ));
        }
        parent.sync_all()?;
        if !a.members[index].published {
            let mut next = m;
            next.published = true;
            self.save_namespace_member(a, index, next)?;
        }
        self.point("namespace_published");
        Ok(())
    }
    pub(super) fn resume_namespace(&mut self, mut a: NamespaceAttempt) -> Result<()> {
        if let Some(successor) = a.delegated_to.as_ref() {
            let predecessor = self
                .store
                .namespace_predecessor(successor)?
                .ok_or(Error::Busy(
                    "namespace delegation has no predecessor witness",
                ))?;
            let next = self.store.namespace_attempt(successor)?;
            if predecessor != a || next.delegated_to.is_some() {
                return Err(Error::Busy("namespace delegation differs or forms a chain"));
            }
            return self.resume_namespace(next);
        }
        if a.completed {
            return Ok(());
        }
        self.paths.verify()?;
        self.store.namespace_validate_target(&a.job.job_id)?;
        // Never publish an earlier move into a path now owned by a later logical
        // operation. Retained objects and both jobs remain available for recovery.
        for m in &a.members {
            let current = self.store.read_metadata(&m.change.after.id)?;
            if m.change.after.deleted {
                if current.is_some() {
                    return Err(Error::Busy("namespace deletion superseded"));
                }
            } else if current.as_ref().is_none_or(|e| {
                e.state.path != m.change.after.path || e.state.kind != m.change.after.kind
            }) {
                return Err(Error::Busy("namespace target moved or deleted again"));
            }
        }
        let files: Vec<_> = (0..a.members.len())
            .filter(|i| a.members[*i].change.after.kind == EntryKind::File)
            .collect();
        let mut dirs: Vec<_> = (0..a.members.len())
            .filter(|i| a.members[*i].change.after.kind == EntryKind::Folder)
            .collect();
        dirs.sort_by_key(|i| {
            std::cmp::Reverse(
                a.members[*i]
                    .evidence
                    .before
                    .path
                    .as_str()
                    .split('/')
                    .count(),
            )
        });
        for index in files.iter().chain(dirs.iter()).copied() {
            self.capture_namespace_member(&mut a, index)?;
        }
        if a.job.work == ProjectionWork::Move {
            dirs.reverse();
            for index in dirs {
                self.publish_namespace_directory(&mut a, index)?;
            }
            for index in files {
                self.publish_namespace_file(&mut a, index)?;
            }
        }
        for index in 0..a.members.len() {
            self.verify_namespace_member(&a, index)?;
            if !a.members[index].finished {
                let mut next = a.members[index].clone();
                next.finished = true;
                self.save_namespace_member(&mut a, index, next)?;
                self.point("namespace_member_finished");
            }
        }
        self.point("namespace_before_finish");
        for index in 0..a.members.len() {
            self.verify_namespace_member(&a, index)?;
        }
        self.paths.verify()?;
        self.store.finish_namespace(&a.job.job_id)?;
        self.point("namespace_finished");
        Ok(())
    }
    fn verify_namespace_member(&mut self, a: &NamespaceAttempt, index: usize) -> Result<()> {
        let m = &a.members[index];
        if noop(a, index) {
            let (parent, name) = self.namespace_source(m)?;
            let disk = self
                .namespace_node(&parent, &name, m.change.after.kind)?
                .ok_or(Error::Busy("same-path namespace source missing"))?;
            if fs::identity(&disk)? != m.evidence.source_identity {
                return Err(Error::Busy("same-path namespace source replaced"));
            }
        }
        if m.change.after.kind == EntryKind::File {
            let (parent, name) = if a.job.work == ProjectionWork::Move {
                self.namespace_destination(a, index)?
            } else {
                (self.paths.private.try_clone()?, retained(a, index))
            };
            let disk = file_snapshot(&parent, &name)?
                .ok_or(Error::Busy("namespace file missing before completion"))?;
            if disk.identity != m.evidence.source_identity {
                return Err(Error::Busy("namespace file replaced before completion"));
            }
            if m.evidence
                .content
                .as_ref()
                .is_none_or(|content| !snapshot_matches_content(&disk, content))
            {
                self.namespace_divergence(&a.job.job_id, m, &parent, &name, &disk)?;
                return Err(Error::Busy(
                    "namespace external edit retained before completion",
                ));
            }
        } else if !noop(a, index) {
            let old = fs::optional_directory(&self.paths.private, &retained(a, index))?
                .ok_or(Error::Busy("retained namespace directory disappeared"))?;
            if fs::identity(&old)? != m.evidence.source_identity || !fs::directory_empty(&old)? {
                return Err(Error::Busy(
                    "late directory child retained for namespace recovery",
                ));
            }
            if a.job.work == ProjectionWork::Move {
                let (parent, name) = self.namespace_destination(a, index)?;
                let dest = fs::optional_directory(&parent, &name)?
                    .ok_or(Error::Busy("namespace destination directory missing"))?;
                if m.directory_stage_identity.as_ref() != Some(&fs::identity(&dest)?) {
                    return Err(Error::Busy("namespace destination directory replaced"));
                }
            }
        }
        Ok(())
    }
    pub(super) fn recover_namespaces(&mut self, report: &mut ReconcileReport) -> Result<()> {
        self.prepare_namespace_successors(report)?;
        self.attach_family_namespaces(report)?;
        let covered = self.store.family_namespace_covered_jobs()?;
        // Listing and status never load retained byte evidence. A pending job is
        // loaded once; completed deletion audit loads one member at a time.
        let attempts = self.store.namespace_attempt_metadata(true)?;
        for job in self.store.pending_namespace_jobs()? {
            if !attempts.iter().any(|a| a.job.job_id == job.job_id)
                && !covered.contains(&job.job_id)
            {
                report.blocked.push((
                    job.target.path,
                    "legacy namespace job has no physical provenance; source left untouched".into(),
                ));
            }
        }
        for a in attempts {
            if a.delegated_to.is_some() {
                // Its immutable capture/progress remains audit evidence. The
                // linked successor alone owns relocation and final settlement.
                continue;
            }
            if !a.completed {
                let target = a.job.target.clone();
                let attempt = self.store.namespace_attempt(&a.job.job_id)?;
                match self.resume_namespace(attempt) {
                    // A physical Move can preserve old content; the ordinary
                    // file pass must still publish the current desired bytes.
                    Ok(()) => {}
                    Err(error) => report.blocked.push((target.path, error.to_string())),
                }
            } else {
                for m in &a.members {
                    self.audit_namespace_member(&a, m, report)?;
                }
            }
        }
        Ok(())
    }

    /// A unit is an indivisible namespace attempt or retained-member audit.
    /// `true` means the current catalog was visited, including any blocked work;
    /// the caller must retain `report.blocked` across yields. It does not mean
    /// every physical publication succeeded.
    pub(super) fn recover_namespaces_quantum(
        &mut self,
        cursor: &mut NamespaceRecoveryCursor,
        budget: &mut super::external_scan_quantum::ExternalWorkBudget,
        report: &mut ReconcileReport,
    ) -> Result<bool> {
        loop {
            let initial_attempts = self.store.namespace_attempt_metadata(true)?;
            let initial_jobs = self.store.pending_namespace_jobs()?;
            if self.store.family_is_enrolled()? {
                for metadata in initial_attempts
                    .iter()
                    .filter(|a| !a.completed && a.delegated_to.is_none())
                {
                    let id = &metadata.job.job_id;
                    if cursor.successors.get(id) == Some(metadata) {
                        continue;
                    }
                    if !budget.try_unit(format!("namespace:successor:{}", id.as_str())) {
                        return Ok(false);
                    }
                    // The point planner rereads and validates the exact durable
                    // predecessor before loading its retained byte evidence.
                    if let Err(error) = self.prepare_namespace_successor(id) {
                        report
                            .blocked
                            .push((metadata.job.target.path.clone(), error.to_string()));
                    }
                    cursor.successors.insert(id.clone(), metadata.clone());
                }
            }
            if !self.attach_family_namespaces_quantum(&mut cursor.families, budget, report)? {
                return Ok(false);
            }

            let attempts = self.store.namespace_attempt_metadata(true)?;
            let covered = self.store.family_namespace_covered_jobs()?;
            for job in self.store.pending_namespace_jobs()? {
                if attempts.iter().any(|a| a.job.job_id == job.job_id)
                    || covered.contains(&job.job_id)
                    || cursor.diagnostics.get(&job.job_id) == Some(&job)
                {
                    continue;
                }
                if !budget.try_unit(format!("namespace:diagnostic:{}", job.job_id.as_str())) {
                    return Ok(false);
                }
                report.blocked.push((
                    job.target.path.clone(),
                    "legacy namespace job has no physical provenance; source left untouched".into(),
                ));
                cursor.diagnostics.insert(job.job_id.clone(), job);
            }
            for metadata in attempts {
                if metadata.delegated_to.is_some() {
                    continue;
                }
                let id = &metadata.job.job_id;
                if !metadata.completed {
                    if cursor.pending.get(id) == Some(&metadata) {
                        continue;
                    }
                    if !budget.try_unit(format!("namespace:resume:{}", id.as_str())) {
                        return Ok(false);
                    }
                    // No retained body is read until the complete atomic job
                    // has been admitted. Resume retains all existing fences.
                    let attempt = self.store.namespace_attempt(id)?;
                    if let Err(error) = self.resume_namespace(attempt) {
                        report
                            .blocked
                            .push((metadata.job.target.path.clone(), error.to_string()));
                    }
                    cursor.pending.insert(id.clone(), metadata);
                } else {
                    for member in &metadata.members {
                        let before = member
                            .change
                            .before
                            .as_ref()
                            .ok_or(Error::Busy("namespace metadata before state missing"))?;
                        // Unchanged moves and moved files have no retained
                        // recovery artifact to audit, just as in legacy recovery.
                        if metadata.job.work == ProjectionWork::Move
                            && (before.path == member.change.after.path
                                || member.change.after.kind != EntryKind::Folder)
                        {
                            continue;
                        }
                        let key = (id.clone(), member.index);
                        let stamp = (metadata.job.work, member.clone());
                        if cursor.audited.get(&key) == Some(&stamp) {
                            continue;
                        }
                        if !budget.try_unit(format!(
                            "namespace:audit:{}:{}",
                            id.as_str(),
                            member.index,
                        )) {
                            return Ok(false);
                        }
                        self.audit_namespace_member(&metadata, member, report)?;
                        cursor.audited.insert(key, stamp);
                    }
                }
            }
            // Preparation/attachment/resume can create successor obligations or
            // turn pending attempts into completed member audits. Do not report
            // completion based on a catalog captured before those writes.
            if self.store.namespace_attempt_metadata(true)? == initial_attempts
                && self.store.pending_namespace_jobs()? == initial_jobs
            {
                return Ok(true);
            }
        }
    }

    fn prepare_namespace_successors(&mut self, report: &mut ReconcileReport) -> Result<()> {
        if !self.store.family_is_enrolled()? {
            return Ok(());
        }
        for metadata in self.store.namespace_attempt_metadata(false)? {
            if metadata.delegated_to.is_some() {
                continue;
            }
            let result = self.prepare_namespace_successor(&metadata.job.job_id);
            if let Err(error) = result {
                report
                    .blocked
                    .push((metadata.job.target.path, error.to_string()));
            }
        }
        Ok(())
    }
    /// Read retained evidence only for this admitted member, never the entire
    /// completed namespace history.
    fn audit_namespace_member(
        &mut self,
        a: &NamespaceAttemptMetadata,
        m: &NamespaceMemberMetadata,
        report: &mut ReconcileReport,
    ) -> Result<()> {
        let before = m
            .change
            .before
            .as_ref()
            .ok_or(Error::Busy("namespace metadata before state missing"))?;
        if a.job.work == ProjectionWork::Move && before.path == m.change.after.path {
            return Ok(());
        }
        let private = format!("{}.{}.namespace", a.job.job_id.as_str(), m.index);
        // Missing captures are not successful GC: this slice never
        // purges them. Report the exact expected recovery location.
        let audit: Result<Option<String>> = (|| {
            if m.change.after.kind == EntryKind::Folder {
                match fs::optional_directory(&self.paths.private, &private)? {
                    Some(dir)
                        if fs::identity(&dir)? == m.source_identity
                            && fs::directory_empty(&dir)? =>
                    {
                        Ok(None)
                    }
                    Some(_) => Ok(Some(format!(
                        "retained directory needs recovery: .zorid/{private}"
                    ))),
                    None => Ok(Some(format!(
                        "retained directory is missing: .zorid/{private}"
                    ))),
                }
            } else if a.job.work == ProjectionWork::Delete {
                let recovery_parent = self.paths.private.try_clone()?;
                match file_snapshot(&recovery_parent, &private)? {
                    Some(file) => {
                        let member = self.store.namespace_member(&a.job.job_id, m.index)?;
                        if file.identity != m.source_identity
                            || member
                                .evidence
                                .content
                                .as_ref()
                                .is_none_or(|content| !snapshot_matches_content(&file, content))
                        {
                            self.namespace_divergence(
                                &a.job.job_id,
                                &member,
                                &recovery_parent,
                                &private,
                                &file,
                            )?;
                            Ok(Some(format!(
                                "retained deleted file changed: .zorid/{private}"
                            )))
                        } else {
                            Ok(None)
                        }
                    }
                    None => Ok(Some(format!(
                        "retained deleted file is missing: .zorid/{private}"
                    ))),
                }
            } else {
                Ok(None)
            }
        })();
        match audit {
            Ok(Some(reason)) => report.blocked.push((before.path.clone(), reason)),
            Err(error) => report.blocked.push((
                before.path.clone(),
                format!("retained namespace recovery at .zorid/{private}: {error}"),
            )),
            Ok(None) => {}
        }
        Ok(())
    }

    fn prepare_namespace_successor(&mut self, job_id: &OperationId) -> Result<()> {
        let Some(plan) = self.store.namespace_successor_plan(job_id)? else {
            return Ok(());
        };
        let predecessor = plan.predecessor();
        if predecessor.members.len() != 1 {
            return Err(Error::Busy("namespace handoff member count differs"));
        }
        let member = &predecessor.members[0];
        self.paths.verify()?;
        let (source_parent, source_name) = self.namespace_source(member)?;
        let (old_target_parent, old_target_name) = self.namespace_destination(predecessor, 0)?;
        let (destination_parent, destination_name) = self.paths.parent(&plan.target().path)?;
        self.paths
            .verify_parent(&plan.target().path, &destination_parent)?;
        if fs::node_type(&source_parent, &source_name)?.is_some()
            || fs::node_type(&old_target_parent, &old_target_name)?.is_some()
            || fs::node_type(&destination_parent, &destination_name)?.is_some()
        {
            return Err(Error::Busy("namespace handoff public location is occupied"));
        }
        let private = self.paths.private.try_clone()?;
        let old_name = retained(predecessor, 0);
        let snapshot = file_snapshot(&private, &old_name)?
            .ok_or(Error::Busy("namespace handoff retained source missing"))?;
        if snapshot.identity != member.evidence.source_identity {
            return Err(Error::Busy("namespace handoff retained inode differs"));
        }
        if member
            .evidence
            .content
            .as_ref()
            .is_none_or(|content| !snapshot_matches_content(&snapshot, content))
        {
            self.namespace_divergence(
                &predecessor.job.job_id,
                member,
                &private,
                &old_name,
                &snapshot,
            )?;
            return Err(Error::Busy("namespace handoff changed content retained"));
        }
        self.point("namespace_successor_before_prepare");
        self.paths.verify()?;
        self.paths
            .verify_parent(&member.evidence.before.path, &source_parent)?;
        self.paths
            .verify_parent(&member.change.after.path, &old_target_parent)?;
        self.paths
            .verify_parent(&plan.target().path, &destination_parent)?;
        if file_snapshot(&private, &old_name)?.as_ref() != Some(&snapshot)
            || fs::node_type(&source_parent, &source_name)?.is_some()
            || fs::node_type(&old_target_parent, &old_target_name)?.is_some()
            || fs::node_type(&destination_parent, &destination_name)?.is_some()
        {
            return Err(Error::Busy("namespace handoff changed before preparation"));
        }
        self.store
            .prepare_namespace_successor(&plan, &fs::identity(&destination_parent)?)?;
        self.point("namespace_successor_prepared");
        Ok(())
    }
}
