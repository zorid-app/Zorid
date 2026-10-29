//! Ordinary discovery precedes recovery/publication, preserving moved or deleted
//! physical branches until their exact historical observation is committed.
use super::*;
use std::collections::BTreeSet;
use zorid_store::{ExternalNamespaceAction, ExternalNamespaceMember};

/// Membership admission for one exclusive reconciliation pass. The borrowed
/// lock prevents this witness outliving the lock; scalar identity checks prevent
/// borrowing it for another vault. Validated Store writers may advance graph
/// revisions during the pass, but never change its enrollment scope.
/// Construction freshly validates scalar authority/scope/head invariants. It
/// never claims that unrelated publications were globally scrubbed; each selected
/// source import and publication retains its independent strict Store guards.
pub(super) struct EnrolledScan<'lock> {
    _lock: &'lock File,
    identity: AuthorityIdentity,
    root: String,
}
impl<'lock> EnrolledScan<'lock> {
    fn admit(vault: &NativeVault, lock: &'lock File) -> Result<Self> {
        if !vault.store.family_enrollment_ready()? {
            return Err(Error::Unsupported(
                "external family reconciliation requires enrollment",
            ));
        }
        Ok(Self {
            _lock: lock,
            identity: vault.store.identity()?,
            root: fs::identity(&vault.paths.root)?,
        })
    }
    pub(super) fn check(&self, vault: &NativeVault) -> Result<()> {
        if fs::identity(&vault.paths.root)? != self.root || vault.store.identity()? != self.identity
        {
            return Err(Error::Busy("external scan enrollment changed"));
        }
        Ok(())
    }
    fn finish(&self, vault: &NativeVault) -> Result<()> {
        self.check(vault)?;
        if !vault.store.family_enrollment_ready()? {
            return Err(Error::Busy("external scan enrollment changed"));
        }
        Ok(())
    }
}

pub(super) struct RebaselineCursor {
    scan_id: OperationId,
    prepared: zorid_store::IdleRebaselinePreparation,
    phase: u8,
    offset: usize,
    attempts: Vec<OperationId>,
    directories: Vec<zorid_store::DirectoryAttempt>,
    namespace_members: Vec<(OperationId, usize)>,
    witnesses: Vec<Option<RebaselineWitness>>,
}
enum RebaselineWitness {
    File(crate::fs_stream::ReadonlyFileWitness),
    Directory,
}
enum RebaselineProgress {
    NotEquivalent,
    Pending,
    Applied,
}
impl NativeVault {
    /// The copied-namespace exception also cooperates: one exact historical
    /// artifact audit or one fully hashed member per unit. Only scalar witnesses
    /// survive a yield. Final reachability/stamp checks and the atomic metadata
    /// transaction may overrun the soft clock, never the whole-vault body reads.
    fn rebaseline_equivalent_quantum(
        &mut self,
        scan: &mut external_scan_progress::ProgressScan,
        budget: &mut external_scan_quantum::ExternalWorkBudget,
    ) -> Result<RebaselineProgress> {
        if !scan.run.complete || !scan.issues.is_empty() {
            self.external_rebaseline = None;
            return Ok(RebaselineProgress::NotEquivalent);
        }
        let mut cursor = self.external_rebaseline.take();
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.scan_id != scan.run.scan_id)
        {
            cursor = None;
        }
        if let Some(existing) = cursor.as_ref() {
            if !self.store.idle_rebaseline_is_current(&existing.prepared)? {
                cursor = None;
            }
        }
        let mut cursor = if let Some(cursor) = cursor {
            cursor
        } else {
            let bindings = self.store.physical_binding_metadata()?;
            if !bindings.iter().any(|binding| {
                scan.entries.get(&binding.state.path).is_some_and(|entry| {
                    entry.identity != binding.physical.inode
                        || entry.parent_identity != binding.physical.parent_inode
                })
            }) {
                return Ok(RebaselineProgress::NotEquivalent);
            }
            let locations: std::collections::BTreeMap<_, _> = scan
                .entries
                .iter()
                .map(|(path, entry)| (&entry.identity, path))
                .collect();
            let mut inodes = BTreeSet::new();
            for binding in &bindings {
                let Some(entry) = scan.entries.get(&binding.state.path) else {
                    return Ok(RebaselineProgress::NotEquivalent);
                };
                if entry.kind != binding.state.kind
                    || !inodes.insert(&entry.identity)
                    || locations
                        .get(&binding.physical.inode)
                        .is_some_and(|path| **path != binding.state.path)
                {
                    return Ok(RebaselineProgress::NotEquivalent);
                }
            }
            let Some(prepared) = self.store.begin_idle_rebaseline(bindings)? else {
                return Ok(RebaselineProgress::NotEquivalent);
            };
            let count = prepared.members().len();
            RebaselineCursor {
                scan_id: scan.run.scan_id.clone(),
                prepared,
                phase: 0,
                offset: 0,
                attempts: self.store.projection_attempt_ids(true)?,
                directories: self.store.directory_attempts(true)?,
                namespace_members: self
                    .store
                    .namespace_attempt_metadata(true)?
                    .into_iter()
                    .flat_map(|attempt| {
                        attempt
                            .members
                            .into_iter()
                            .map(move |member| (attempt.job.job_id.clone(), member.index))
                    })
                    .collect(),
                witnesses: (0..count).map(|_| None).collect(),
            }
        };
        // A failed equivalence speculation is not retry work. Remember it for
        // this exact inventory/database epoch so a one-unit turn can advance
        // ordinary conflict handling instead of repeating the same hash forever.
        if cursor.phase == 5 {
            self.external_rebaseline = Some(cursor);
            return Ok(RebaselineProgress::NotEquivalent);
        }
        loop {
            match cursor.phase {
                0 => {
                    while cursor.offset < cursor.attempts.len() {
                        let id = &cursor.attempts[cursor.offset];
                        if !budget.try_unit(format!("rebaseline:file-artifact:{}", id.as_str())) {
                            self.external_rebaseline = Some(cursor);
                            return Ok(RebaselineProgress::Pending);
                        }
                        self.store.projection_attempt(id)?;
                        for suffix in ["stage", "previous"] {
                            if fs::node_type(
                                &self.paths.private,
                                &format!("{}.{suffix}", id.as_str()),
                            )?
                            .is_some()
                            {
                                return self.reject_external_rebaseline(cursor);
                            }
                        }
                        cursor.offset += 1;
                    }
                    cursor.phase = 1;
                    cursor.offset = 0;
                }
                1 => {
                    while cursor.offset < cursor.directories.len() {
                        let id = &cursor.directories[cursor.offset].attempt_id;
                        if !budget
                            .try_unit(format!("rebaseline:directory-artifact:{}", id.as_str()))
                        {
                            self.external_rebaseline = Some(cursor);
                            return Ok(RebaselineProgress::Pending);
                        }
                        if fs::node_type(
                            &self.paths.private,
                            &format!("{}.directory", id.as_str()),
                        )?
                        .is_some()
                        {
                            return self.reject_external_rebaseline(cursor);
                        }
                        cursor.offset += 1;
                    }
                    cursor.phase = 2;
                    cursor.offset = 0;
                }
                2 => {
                    while cursor.offset < cursor.namespace_members.len() {
                        let (id, index) = &cursor.namespace_members[cursor.offset];
                        if !budget.try_unit(format!(
                            "rebaseline:namespace-artifact:{}:{index}",
                            id.as_str()
                        )) {
                            self.external_rebaseline = Some(cursor);
                            return Ok(RebaselineProgress::Pending);
                        }
                        for suffix in ["namespace", "directory"] {
                            if fs::node_type(
                                &self.paths.private,
                                &format!("{}.{index}.{suffix}", id.as_str()),
                            )?
                            .is_some()
                            {
                                return self.reject_external_rebaseline(cursor);
                            }
                        }
                        cursor.offset += 1;
                    }
                    cursor.phase = 3;
                    cursor.offset = 0;
                }
                3 => {
                    while cursor.offset < cursor.prepared.members().len() {
                        let before = cursor.prepared.members()[cursor.offset].clone();
                        if !budget
                            .try_unit(format!("rebaseline:member:{}", before.state.id.as_str()))
                        {
                            self.external_rebaseline = Some(cursor);
                            return Ok(RebaselineProgress::Pending);
                        }
                        let snapshot = &scan.entries[&before.state.path];
                        let physical = PhysicalIdentity {
                            inode: snapshot.identity.clone(),
                            parent_inode: snapshot.parent_identity.clone(),
                        };
                        let (parent, name) = self.paths.parent(&before.state.path)?;
                        let (content, witness) = if before.state.kind == EntryKind::File {
                            let witness = crate::fs_stream::readonly_file_witness(&parent, &name)?;
                            let Some(file) = scan.file_snapshot(self, &before.state.path)? else {
                                return self.reject_external_rebaseline(cursor);
                            };
                            crate::fs_stream::verify_readonly_file_witness(
                                &parent, &name, &witness,
                            )?;
                            (
                                Some((file.length, zorid_store::Sha256Digest(file.digest))),
                                RebaselineWitness::File(witness),
                            )
                        } else {
                            if !scan.confirm_snapshot(self, &before.state.path)? {
                                return self.reject_external_rebaseline(cursor);
                            }
                            (None, RebaselineWitness::Directory)
                        };
                        if !self.store.validate_idle_rebaseline_member(
                            &mut cursor.prepared,
                            cursor.offset,
                            physical,
                            content,
                        )? {
                            if self.store.idle_rebaseline_is_current(&cursor.prepared)? {
                                return self.reject_external_rebaseline(cursor);
                            }
                            return Ok(RebaselineProgress::Pending);
                        }
                        cursor.witnesses[cursor.offset] = Some(witness);
                        cursor.offset += 1;
                        self.point("external_quantum_rebaseline_member_validated");
                    }
                    cursor.phase = 4;
                }
                _ => {
                    if !budget.try_unit("rebaseline:finalize".into()) {
                        self.external_rebaseline = Some(cursor);
                        return Ok(RebaselineProgress::Pending);
                    }
                    self.point("external_quantum_rebaseline_before_verify");
                    scan.revalidate(self)?;
                    for (before, witness) in cursor.prepared.members().iter().zip(&cursor.witnesses)
                    {
                        match witness
                            .as_ref()
                            .ok_or(Error::Busy("rebaseline witness missing"))?
                        {
                            RebaselineWitness::File(witness) => {
                                let (parent, name) = self.paths.parent(&before.state.path)?;
                                crate::fs_stream::verify_readonly_file_witness(
                                    &parent, &name, witness,
                                )?;
                            }
                            RebaselineWitness::Directory => {
                                if !scan.confirm_snapshot(self, &before.state.path)? {
                                    return Err(Error::Busy("rebaseline directory changed"));
                                }
                            }
                        }
                    }
                    if !self.store.idle_rebaseline_is_current(&cursor.prepared)? {
                        return Ok(RebaselineProgress::Pending);
                    }
                    // Retire old absence authority before changing any binding.
                    scan.discard_for_rebaseline(self)?;
                    self.point("external_quantum_rebaseline_before_apply");
                    self.paths.verify()?;
                    return Ok(if self.store.finish_idle_rebaseline(cursor.prepared)? {
                        RebaselineProgress::Applied
                    } else {
                        RebaselineProgress::Pending
                    });
                }
            }
        }
    }
}
impl NativeVault {
    fn reject_external_rebaseline(&mut self, mut cursor: RebaselineCursor) -> Result<RebaselineProgress> {
        cursor.phase = 5;
        self.external_rebaseline = Some(cursor);
        Ok(RebaselineProgress::NotEquivalent)
    }
    /// Accept only fresh same-path projections of the COMPLETE bound namespace.
    /// Extra untracked physical files remain ordinary imports. One changed or
    /// missing bound file conservatively prevents the entire rebaseline batch.
    /// Returns whether the derived inventory was retired and must be restarted.
    fn rebaseline_equivalent_inventory(
        &mut self,
        scan: &mut external_scan_progress::ProgressScan,
        started: std::time::Instant,
        duration: std::time::Duration,
    ) -> Result<bool> {
        if !scan.run.finished || !scan.run.complete || !scan.issues.is_empty() { return Ok(false); }
        let bindings = self.store.physical_bindings()?;
        if !bindings.iter().any(|binding| scan.entries.get(&binding.state.path).is_some_and(|entry|
            entry.identity != binding.physical.inode || entry.parent_identity != binding.physical.parent_inode))
        { return Ok(false); }
        // Retained recovery occupants must remain tied to their original proofs.
        for attempt in self.store.projection_attempts(true)? {
            for suffix in ["stage", "previous"] {
                if started.elapsed() >= duration || fs::node_type(&self.paths.private, &format!("{}.{suffix}", attempt.attempt_id.as_str()))?.is_some() { return Ok(false); }
            }
        }
        for attempt in self.store.directory_attempts(true)? {
            if started.elapsed() >= duration || fs::node_type(&self.paths.private, &format!("{}.directory", attempt.attempt_id.as_str()))?.is_some() { return Ok(false); }
        }
        for attempt in self.store.namespace_attempt_metadata(true)? {
            for member in attempt.members {
                for suffix in ["namespace", "directory"] {
                    if started.elapsed() >= duration || fs::node_type(&self.paths.private, &format!("{}.{}.{suffix}", attempt.job.job_id.as_str(), member.index))?.is_some() { return Ok(false); }
                }
            }
        }
        let locations: std::collections::BTreeMap<_, _> = scan.entries.iter().map(|(path, entry)| (&entry.identity, path)).collect();
        let mut current = Vec::with_capacity(bindings.len());
        let mut seen = BTreeSet::new();
        for binding in &bindings {
            if started.elapsed() >= duration { return Ok(false); }
            let Some(entry) = scan.entries.get(&binding.state.path) else { return Ok(false); };
            if entry.kind != binding.state.kind || !seen.insert(&entry.identity)
                || locations.get(&binding.physical.inode).is_some_and(|path| **path != binding.state.path)
                || self.store.read_metadata(&binding.state.id)?.is_none_or(|entry| entry.state != binding.state)
                || !scan.confirm_snapshot(self, &binding.state.path)?
            { return Ok(false); }
            if entry.kind == EntryKind::File {
                let Some(base) = self.store.projection_baseline(&binding.state.id)?.filter(|base| base.state == binding.state) else { return Ok(false); };
                let Some(disk) = scan.file_snapshot(self, &binding.state.path)? else { return Ok(false); };
                if !snapshot_matches_content(&disk, &base.content) { return Ok(false); }
            } else if self.store.directory_baseline(&binding.state.id)?.is_none_or(|base|
                base.state != binding.state || base.identity != binding.physical.inode)
            { return Ok(false); }
            current.push(PhysicalIdentity { inode: entry.identity.clone(), parent_inode: entry.parent_identity.clone() });
        }
        scan.revalidate(self)?;
        // Cursor retirement precedes the atomic Store writer. Even a stale CAS
        // or interruption can therefore only restart discovery, not reuse old
        // absence proofs with the newly accepted physical occupants.
        scan.discard_for_rebaseline(self)?;
        self.point("equivalent_rebaseline_before_verify");
        for binding in &bindings {
            if !scan.confirm_snapshot(self, &binding.state.path)? { return Err(Error::Busy("equivalent projection changed before rebaseline")); }
        }
        self.paths.verify()?;
        self.store.rebaseline_idle_physical_bindings(&bindings, &current)?;
        Ok(true)
    }

    /// Only expected per-path conflicts become partial-report diagnostics. Root
    /// and private-storage authority must still be intact before reporting one.
    fn external_reconciliation_issue(&self, error: Error) -> Result<String> {
        self.paths.verify()?;
        let expected = match &error {
            Error::Busy(_) | Error::Unsupported(_) => true,
            Error::Store(error) => error.is_external_reconciliation_issue(),
            Error::Contract(
                zorid_core::ContractError::RevisionConflict { .. }
                | zorid_core::ContractError::EntryNotFound { .. }
                | zorid_core::ContractError::EntryDeleted { .. }
                | zorid_core::ContractError::InvalidMutation { .. },
            ) => true,
            _ => false,
        };
        if expected {
            Ok(error.to_string())
        } else {
            Err(error)
        }
    }

    pub fn reconcile_external(
        &mut self,
        options: ScanOptions,
        mode: ExternalFileMode,
    ) -> Result<ExternalReconcileReport> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let enrolled = EnrolledScan::admit(self, &_guard)?;
        Ok(self
            .reconcile_external_locked(options, mode, &enrolled, None)?
            .0)
    }
    /// Interactive discovery and publication share one monotonic, cooperative
    /// budget. Returning pending releases the vault lock; the next call resumes
    /// the same durable inventory rather than granting partial absence proof.
    pub fn reconcile_external_quantum(
        &mut self,
        options: ExternalReconcileOptions,
        mode: ExternalFileMode,
    ) -> Result<ExternalReconcileQuantum> {
        let mut budget = external_scan_quantum::ExternalWorkBudget::new(&options)?;
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let enrolled = EnrolledScan::admit(self, &_guard)?;
        let (mut reconciliation, mut scan) =
            self.reconcile_external_locked(options.scan, mode, &enrolled, Some(&mut budget))?;
        if !scan.active() {
            return Ok(ExternalReconcileQuantum {
                reconciliation,
                publication: ReconcileReport::default(),
                phase: ExternalWorkPhase::Blocked,
                pending: false,
                work_units: budget.used(),
            });
        }
        let source_pending = !scan.run.complete
            || !scan.pending_paths().is_empty()
            || reconciliation
                .issues
                .iter()
                .any(|issue| issue.reason.contains("duration budget exhausted"));
        if source_pending {
            return Ok(ExternalReconcileQuantum {
                phase: if scan.run.complete {
                    ExternalWorkPhase::Import
                } else {
                    ExternalWorkPhase::Discovery
                },
                pending: true,
                work_units: budget.used(),
                reconciliation,
                publication: ReconcileReport::default(),
            });
        }
        if !scan.publication_started() {
            // Complete discovery must precede publication, but a source conflict
            // must not suppress independent pending recovery. Each publication
            // unit retains its exact existing guards; conflicts remain in this
            // inventory and prevent terminal success after recovery is attempted.
            scan.begin_publication(self)?;
            self.external_rebaseline = None;
        }
        let (done, publication) =
            self.recover_external_quantum_locked(&scan.run.scan_id, &mut budget)?;
        enrolled.finish(self)?;
        reconciliation.complete = done && publication.blocked.is_empty() && reconciliation.issues.is_empty();
        let phase = if !done {
            ExternalWorkPhase::Publication
        } else if reconciliation.complete {
            ExternalWorkPhase::Complete
        } else {
            ExternalWorkPhase::Blocked
        };
        if done {
            scan.retire(self)?;
        }
        Ok(ExternalReconcileQuantum {
            reconciliation,
            publication,
            phase,
            pending: !done,
            work_units: budget.used(),
        })
    }
    fn reconcile_external_locked(
        &mut self,
        options: ScanOptions,
        mode: ExternalFileMode,
        enrolled: &EnrolledScan<'_>,
        mut budget: Option<&mut external_scan_quantum::ExternalWorkBudget>,
    ) -> Result<(
        ExternalReconcileReport,
        external_scan_progress::ProgressScan,
    )> {
        let namespace_origin = OperationId::new("native_external_namespace")?;
        let observe_origin = OperationId::new("native_external_observe")?;
        let create_origin = OperationId::new("native_external_create")?;
        let started = budget
            .as_ref()
            .map_or_else(std::time::Instant::now, |b| b.started());
        let duration = options.max_duration;
        let mut scan =
            self.external_progress_scan_with_budget(options.clone(), budget.as_deref_mut())?;
        if !scan.publication_started() {
            let rebased = if let Some(budget) = budget.as_deref_mut() {
                match self.rebaseline_equivalent_quantum(&mut scan, budget)? {
                    RebaselineProgress::Applied => true,
                    RebaselineProgress::NotEquivalent => false,
                    RebaselineProgress::Pending => {
                        // A final epoch mismatch can race after safe cursor
                        // retirement. Restart discovery, keeping this ordinary
                        // continuation pending rather than reporting a conflict.
                        if !scan.active() {
                            scan = self.external_progress_scan_with_budget(options.clone(), Some(budget))?;
                        }
                        self.paths.verify()?;
                        enrolled.finish(self)?;
                        let report = ExternalReconcileReport { complete: false, run: scan.run.clone(), imported: Vec::new(), namespace: Vec::new(), issues: vec![ScanIssue { path: None, reason: "external reconciliation duration budget exhausted during rebaseline preparation".into() }] };
                        return Ok((report, scan));
                    }
                }
            } else {
                self.rebaseline_equivalent_inventory(&mut scan, started, duration)?
            };
            if rebased {
                scan = self.external_progress_scan_with_budget(options, budget.as_deref_mut())?;
            }
        }
        let mut report = ExternalReconcileReport {
            complete: false,
            run: scan.run.clone(),
            issues: Vec::new(),
            imported: Vec::new(),
            namespace: Vec::new(),
        };
        report.issues = scan
            .issues
            .iter()
            .map(|issue| ScanIssue {
                path: issue.path.clone(),
                reason: issue.reason.clone(),
            })
            .collect();
        if !scan.active() {
            self.paths.verify()?;
            enrolled.finish(self)?;
            return Ok((report, scan));
        }
        if budget.is_some() {
            report.issues.extend_from_slice(scan.retained_issues());
            if scan.publication_started() {
                return Ok((report, scan));
            }
        }
        let retained_start = report.issues.len();
        let mut namespace_processed = scan.namespace_processed();
        let pending_paths = scan.pending_paths();
        let pending: BTreeSet<_> = pending_paths.iter().cloned().collect();
        let mut processed = BTreeSet::new();
        // A file may have moved into an independently created directory. Enroll
        // new parent directories first; retained inodes are never new identities.
        let mut folders: Vec<_> = scan
            .entries
            .iter()
            .filter(|(path, s)| s.kind == EntryKind::Folder && pending.contains(*path))
            .map(|(p, _)| p.clone())
            .collect();
        folders.sort_by_key(|p| p.as_str().split('/').count());
        for path in folders {
            if budget.is_none() && started.elapsed() >= duration {
                report.issues.push(ScanIssue {
                    path: Some(path),
                    reason: "external reconciliation duration budget exhausted".into(),
                });
                break;
            }
            let snapshot = &scan.entries[&path];
            if let Some(owner) = self.store.physical_owner_by_inode(&snapshot.identity)? {
                if owner.state.path == path
                    && owner.state.kind == snapshot.kind
                    && owner.physical.parent_inode == snapshot.parent_identity
                    && self
                        .store
                        .read(&owner.state.id)?
                        .is_some_and(|e| e.state.path == path && !e.state.deleted)
                {
                    if budget.as_mut().is_some_and(|b| !b.enroll_positive(&path)) {
                        report.issues.push(ScanIssue {
                            path: Some(path),
                            reason: "external reconciliation duration budget exhausted".into(),
                        });
                        break;
                    }
                    match scan.confirm_snapshot(self, &path) {
                        Ok(true) => {
                            processed.insert(path.clone());
                        }
                        Ok(false) => {
                            if budget.is_some() {
                                processed.insert(path.clone());
                                report.issues.push(ScanIssue {
                                    path: Some(path.clone()),
                                    reason: "external parent changed before enrollment".into(),
                                });
                            }
                        }
                        Err(error) => {
                            if budget.is_some() {
                                processed.insert(path.clone());
                            }
                            report.issues.push(ScanIssue {
                                path: Some(path.clone()),
                                reason: self.external_reconciliation_issue(error)?,
                            });
                        }
                    }
                }
                continue;
            }
            if let Some(parent) = path.parent() {
                // A newly added child inside a relocated tracked folder waits
                // for that folder's own observation. It is not an import error.
                if self.store.physical_owner_at(&parent)?.is_none_or(|b| {
                    b.state.kind != EntryKind::Folder
                        || b.physical.inode != snapshot.parent_identity
                }) {
                    continue;
                }
            }
            if budget.as_mut().is_some_and(|b| !b.enroll_positive(&path)) {
                report.issues.push(ScanIssue {
                    path: Some(path),
                    reason: "external reconciliation duration budget exhausted".into(),
                });
                break;
            }
            let attempt = (|| -> Result<_> {
                if !scan.confirm_snapshot(self, &path)? {
                    return Err(Error::Busy("external parent changed"));
                }
                let (parent, _) = self.paths.parent(&path)?;
                self.observe_new_family_directory(
                    &path,
                    &parent,
                    &PhysicalIdentity {
                        inode: snapshot.identity.clone(),
                        parent_inode: snapshot.parent_identity.clone(),
                    },
                )
            })();
            match attempt {
                Ok(commit) => {
                    report.imported.push(commit);
                    processed.insert(path.clone());
                }
                Err(error) => {
                    if budget.is_some() {
                        processed.insert(path.clone());
                    }
                    report.issues.push(ScanIssue {
                        path: Some(path),
                        reason: self.external_reconciliation_issue(error)?,
                    });
                }
            }
        }
        // Only a fully covered and revalidated inventory may interpret a
        // missing path. Positive enrollment below has its own local proofs.
        if scan.run.complete {
            let mut bindings = self.store.physical_bindings()?;
            bindings.sort_by(|a, b| {
                a.state
                    .path
                    .as_str()
                    .split('/')
                    .count()
                    .cmp(&b.state.path.as_str().split('/').count())
                    .then_with(|| a.state.path.cmp(&b.state.path))
            });
            let mut handled = BTreeSet::new();
            for before in &bindings {
                if budget.is_none() && started.elapsed() >= duration {
                    report.issues.push(ScanIssue {
                        path: Some(before.state.path.clone()),
                        reason: "external reconciliation duration budget exhausted".into(),
                    });
                    break;
                }
                if handled.contains(&before.state.id)
                    || budget.is_some() && namespace_processed.contains(&before.state.id)
                {
                    continue;
                }
                if scan.entries.get(&before.state.path).is_some_and(|s| {
                    s.identity == before.physical.inode && s.kind == before.state.kind
                }) {
                    continue;
                }
                if budget
                    .as_mut()
                    .is_some_and(|b| !b.try_unit(format!("namespace:{}", before.state.id.as_str())))
                {
                    report.issues.push(ScanIssue {
                        path: Some(before.state.path.clone()),
                        reason: "external reconciliation duration budget exhausted".into(),
                    });
                    break;
                }
                if budget.is_some() {
                    namespace_processed.insert(before.state.id.clone());
                }
                if scan.entries.contains_key(&before.state.path) {
                    report.issues.push(ScanIssue {
                        path: Some(before.state.path.clone()),
                        reason: "external replacement retains original physical ownership".into(),
                    });
                    continue;
                }
                let members: Vec<_> = bindings
                    .iter()
                    .filter(|b| {
                        b.state.id == before.state.id
                            || before.state.kind == EntryKind::Folder
                                && b.state.path.is_descendant_of(&before.state.path)
                    })
                    .cloned()
                    .collect();
                for member in &members {
                    handled.insert(member.state.id.clone());
                }
                let matches: Vec<_> = scan
                    .entries
                    .iter()
                    .filter(|(_, s)| {
                        s.identity == before.physical.inode && s.kind == before.state.kind
                    })
                    .collect();
                let target = match matches.as_slice() {
                    [] => None,
                    [(path, _)] => Some((*path).clone()),
                    _ => {
                        report.issues.push(ScanIssue {
                            path: Some(before.state.path.clone()),
                            reason: "external inode has ambiguous destinations".into(),
                        });
                        continue;
                    }
                };
                let attempt = (|| -> Result<_> {
                    scan.revalidate(self)?;
                    if !scan.confirm_absent(self, &before.state.path)? {
                        return Err(Error::Busy("original external path absence is unproven"));
                    }
                    let mut evidence = Vec::new();
                    // Capture all missing members first. Only minimal missing roots
                    // require immediate-parent absence proof; their descendants are
                    // covered by the exact original tracked subtree.
                    let mut missing = Vec::new();
                    for member in &members {
                        let (after, observed_content) = if let Some(target) = &target {
                            let path = if member.state.id == before.state.id {
                                target.clone()
                            } else {
                                VaultPath::new(format!(
                                    "{}/{}",
                                    target.as_str(),
                                    member
                                        .state
                                        .path
                                        .as_str()
                                        .strip_prefix(&format!("{}/", before.state.path.as_str()))
                                        .ok_or(Error::Busy("external move member escaped root"))?
                                ))?
                            };
                            if let Some(found) = scan.entries.get(&path) {
                                if found.identity != member.physical.inode
                                    || found.kind != member.state.kind
                                    || !scan.confirm_snapshot(self, &path)?
                                {
                                    return Err(Error::Busy("external move member changed"));
                                }
                                let physical = PhysicalIdentity {
                                    inode: found.identity.clone(),
                                    parent_inode: found.parent_identity.clone(),
                                };
                                let observed_content = if found.kind == EntryKind::File {
                                    let expected = scan
                                        .file_snapshot(self, &path)?
                                        .ok_or(Error::Busy("file snapshot missing"))?;
                                    let baseline =
                                        self.store.projection_baseline(&member.state.id)?;
                                    let proof = ObservationPhysical {
                                        physical: physical.clone(),
                                        expected_binding: Some(member.clone()),
                                    };
                                    let (parent, name) = self.paths.parent(&path)?;
                                    // Capture under the actual destination and historical
                                    // binding. Namespace import retains it only after moving
                                    // the baseline, so an ordinary observer can consume it.
                                    Some(self.capture_observed_file_with_scan(
                                        &path,
                                        &parent,
                                        &name,
                                        &namespace_origin,
                                        baseline.as_ref(),
                                        Some(&proof),
                                        &expected,
                                        baseline.as_ref().is_some_and(|baseline| {
                                            baseline.content.inline_bytes().is_some()
                                        }),
                                        Some(&enrolled),
                                    )?)
                                } else {
                                    None
                                };
                                (Some((path.clone(), physical)), observed_content)
                            } else {
                                if member.state.id == before.state.id
                                    || scan
                                        .entries
                                        .values()
                                        .any(|s| s.identity == member.physical.inode)
                                {
                                    return Err(Error::Busy(
                                        "external move has relocated tracked member",
                                    ));
                                }
                                missing.push((
                                    member.state.id.clone(),
                                    member.state.path.clone(),
                                    path,
                                ));
                                (None, None)
                            }
                        } else {
                            if scan
                                .entries
                                .values()
                                .any(|s| s.identity == member.physical.inode)
                            {
                                return Err(Error::Busy(
                                    "external deletion has relocated tracked member",
                                ));
                            }
                            (None, None)
                        };
                        evidence.push(ExternalNamespaceMember {
                            before: member.clone(),
                            after,
                            observed_content,
                        });
                    }
                    let minimal_missing: Vec<_> = missing
                        .iter()
                        .filter(|(_, old, _)| {
                            !missing
                                .iter()
                                .any(|(_, ancestor, _)| old.is_descendant_of(ancestor))
                        })
                        .collect();
                    let mut deleted_roots = BTreeSet::new();
                    let mut deleted_paths = Vec::new();
                    if target.is_some() {
                        for member in &evidence {
                            let covered = minimal_missing.iter().any(|(id, old, _)| {
                                member.before.state.id == *id
                                    || member.before.state.path.is_descendant_of(old)
                            });
                            if member.after.is_none() != covered {
                                return Err(Error::Busy(
                                    "external move deletion subtree is not exact",
                                ));
                            }
                        }
                        for (id, _, path) in minimal_missing {
                            if !scan.confirm_absent(self, path)? {
                                return Err(Error::Busy(
                                    "relocated external member absence is unproven",
                                ));
                            }
                            deleted_roots.insert(id.clone());
                            deleted_paths.push(path.clone());
                        }
                    }
                    let action = match &target {
                        Some(path) if !deleted_roots.is_empty() => {
                            ExternalNamespaceAction::MoveWithDeletions {
                                root: before.state.id.clone(),
                                path: path.clone(),
                                deleted_roots: deleted_roots.into_iter().collect(),
                            }
                        }
                        Some(path) => ExternalNamespaceAction::Move {
                            root: before.state.id.clone(),
                            path: path.clone(),
                        },
                        None => ExternalNamespaceAction::Delete {
                            root: before.state.id.clone(),
                        },
                    };
                    let observation = self.store.record_family_namespace_observation_content(
                        &content_stream::core_client()?,
                        &scan.run.scan_id,
                        action,
                        evidence,
                    )?;
                    self.point("external_namespace_prepared");
                    scan.revalidate(self)?;
                    if !scan.confirm_absent(self, &before.state.path)? {
                        return Err(Error::Busy("external source reappeared before commit"));
                    }
                    for path in &deleted_paths {
                        if !scan.confirm_absent(self, path)? {
                            return Err(Error::Busy(
                                "relocated external member reappeared before commit",
                            ));
                        }
                    }
                    for member in &observation.members {
                        if let Some((path, _)) = &member.after {
                            if !scan.confirm_snapshot(self, path)? {
                                return Err(Error::Busy(
                                    "external destination changed before commit",
                                ));
                            }
                        }
                    }
                    Ok(self
                        .store
                        .import_family_namespace_observation(&observation.observation_id)?)
                })();
                match attempt {
                    Ok(receipt) => report.namespace.push(receipt),
                    Err(error) => report.issues.push(ScanIssue {
                        path: Some(before.state.path.clone()),
                        reason: self.external_reconciliation_issue(error)?,
                    }),
                }
            }
        }
        let mut paths: Vec<_> = pending_paths
            .into_iter()
            .filter(|p| !processed.contains(p))
            .collect();
        paths.sort_by(|a, b| {
            a.as_str()
                .split('/')
                .count()
                .cmp(&b.as_str().split('/').count())
                .then_with(|| a.cmp(b))
        });
        for path in paths {
            if budget.as_mut().map_or_else(
                || started.elapsed() >= duration,
                |b| !b.enroll_positive(&path),
            ) {
                report.issues.push(ScanIssue {
                    path: Some(path),
                    reason: "external reconciliation duration budget exhausted".into(),
                });
                break;
            }
            let snapshot = &scan.entries[&path];
            let attempt = (|| -> Result<Option<CommitResult>> {
                if !scan.confirm_snapshot(self, &path)? {
                    return Err(Error::Busy("external capture changed before enrollment"));
                }
                let owner = self.store.physical_owner_by_inode(&snapshot.identity)?;
                if owner.as_ref().is_some_and(|b| b.state.path != path) {
                    return Err(Error::Busy("external inode retains another physical path"));
                }
                let (parent, _) = self.paths.parent(&path)?;
                if let Some(owner) = owner {
                    let visible = self.store.read_path_metadata(&path)?.filter(|entry| {
                        entry.state.id == owner.state.id && entry.state.path == path
                    });
                    if visible.is_none() {
                        return Err(Error::Busy(
                            "external physical branch retained for recovery",
                        ));
                    }
                    return if snapshot.kind == EntryKind::File {
                        let expected = scan
                            .file_snapshot(self, &path)?
                            .ok_or(Error::Busy("file snapshot missing"))?;
                        self.observe_streamed_file_with_scan(
                            &path,
                            &parent,
                            &expected,
                            &observe_origin,
                            Some(&enrolled),
                        )
                    } else {
                        Ok(None)
                    };
                }
                if let Some(parent_path) = path.parent() {
                    let valid_parent =
                        if let Some(binding) = self.store.physical_owner_at(&parent_path)? {
                            binding.state.kind == EntryKind::Folder
                                && binding.physical.inode == snapshot.parent_identity
                                && self.store.read_path_metadata(&parent_path)?.is_some_and(
                                    |entry| {
                                        entry.state.id == binding.state.id
                                            && entry.state.path == parent_path
                                    },
                                )
                        } else {
                            false
                        };
                    if !valid_parent {
                        return Err(Error::Busy(
                            "external parent has no matching visible physical owner",
                        ));
                    }
                }
                if snapshot.kind == EntryKind::Folder {
                    self.observe_new_family_directory(
                        &path,
                        &parent,
                        &PhysicalIdentity {
                            inode: snapshot.identity.clone(),
                            parent_inode: snapshot.parent_identity.clone(),
                        },
                    )
                    .map(Some)
                } else {
                    let expected = scan
                        .file_snapshot(self, &path)?
                        .ok_or(Error::Busy("file snapshot missing"))?;
                    let selected = external_create::select_external_file_mode_from_facts(
                        &path,
                        expected.valid_utf8,
                        expected.has_nul,
                        mode,
                    )?;
                    self.observe_new_family_stream_with_scan(
                        &path,
                        &parent,
                        &expected,
                        selected,
                        &create_origin,
                        Some(&enrolled),
                    )
                    .map(Some)
                }
            })();
            match attempt {
                Ok(Some(commit)) => report.imported.push(commit),
                Ok(None) => {}
                Err(error) => report.issues.push(ScanIssue {
                    path: Some(path.clone()),
                    reason: self.external_reconciliation_issue(error)?,
                }),
            }
            processed.insert(path);
        }
        if budget.is_some() {
            let durable: Vec<_> = report.issues[retained_start..]
                .iter()
                .filter(|issue| !issue.reason.contains("duration budget exhausted"))
                .cloned()
                .collect();
            // Unfinished positive observations may legitimately defer a moved
            // inode/parent. Complete inventory resets positive acknowledgements
            // and retries them with full namespace proof; only then retain an
            // unresolved conflict across publication-sized turns.
            if scan.run.complete {
                scan.retain_issues(self, &durable)?;
            }
            scan.record_namespace_processed(self, namespace_processed)?;
        }
        scan.record_processed_retaining(
            self,
            &processed.into_iter().collect::<Vec<_>>(),
            budget.is_some(),
        )?;
        self.paths.verify()?;
        enrolled.finish(self)?;
        report.complete =
            scan.run.complete && report.issues.is_empty() && scan.pending_paths().is_empty();
        Ok((report, scan))
    }
}

#[cfg(test)]
mod enrolled_scan_tests {
    use super::*;

    fn enrolled(root: &std::path::Path) -> NativeVault {
        let mut vault = NativeVault::open(root).unwrap();
        vault
            .family_enroll(&FamilyScope {
                realm_id: zorid_sync_protocol::RealmId::new("scan-realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("scan-vault").unwrap(),
            })
            .unwrap();
        vault
    }

    #[test]
    fn enrolled_scan_retains_membership_across_validated_graph_writes() {
        let root = tempfile::tempdir().unwrap();
        let mut vault = enrolled(root.path());
        let lock = vault.paths.lock(vault.options.lock_timeout).unwrap();
        let scan = EnrolledScan::admit(&vault, &lock).unwrap();
        for (name, bytes) in [("a.md", b"first".as_slice()), ("b.bin", &[0, 255, 4])] {
            std::fs::write(root.path().join(name), bytes).unwrap();
            let path = VaultPath::new(name).unwrap();
            let (parent, leaf) = vault.paths.parent(&path).unwrap();
            let expected = content_stream::file_snapshot(&parent, &leaf)
                .unwrap()
                .unwrap();
            let mode = if name.ends_with(".md") {
                FamilyCreateMode::Text
            } else {
                FamilyCreateMode::Binary
            };
            vault
                .observe_new_family_stream_with_scan(
                    &path,
                    &parent,
                    &expected,
                    mode,
                    &OperationId::new("scan_test_create").unwrap(),
                    Some(&scan),
                )
                .unwrap();
            scan.check(&vault).unwrap();
            let entry = vault.store.read_path(&path).unwrap().unwrap();
            assert_eq!(entry.content.as_deref(), Some(bytes));
        }
        scan.finish(&vault).unwrap();
        assert_eq!(vault.store.list().unwrap().len(), 2);
    }

    #[test]
    fn enrolled_scan_rejects_another_physical_vault_with_same_logical_identity() {
        let root = tempfile::tempdir().unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let vault = enrolled(root.path());
        let other = enrolled(other_root.path());
        let sql =
            rusqlite::Connection::open(other_root.path().join(".zorid/vault.sqlite")).unwrap();
        sql.execute(
            "UPDATE authority_identity SET local_store_id=?1",
            [vault.store.identity().unwrap().local_store_id.as_str()],
        )
        .unwrap();
        assert_eq!(
            vault.store.identity().unwrap(),
            other.store.identity().unwrap()
        );
        let lock = vault.paths.lock(vault.options.lock_timeout).unwrap();
        let scan = EnrolledScan::admit(&vault, &lock).unwrap();
        assert!(matches!(scan.check(&other), Err(Error::Busy(_))));
    }

    #[test]
    fn enrolled_scan_readiness_keeps_explicit_and_selected_corruption_guards() {
        let root = tempfile::tempdir().unwrap();
        let mut vault = enrolled(root.path());
        std::fs::write(root.path().join("retained.md"), b"retained").unwrap();
        assert!(
            vault
                .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
                .unwrap()
                .complete
        );
        let path = VaultPath::new("retained.md").unwrap();
        let selected = vault
            .store
            .read_path_metadata(&path)
            .unwrap()
            .unwrap()
            .state
            .id;
        assert!(vault
            .store
            .family_materialization(&selected)
            .unwrap()
            .is_some());
        let lock = vault.paths.lock(vault.options.lock_timeout).unwrap();
        let scan = EnrolledScan::admit(&vault, &lock).unwrap();
        let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
        let authored: i64 = sql
            .query_row("SELECT count(*) FROM authored_envelopes", [], |row| {
                row.get(0)
            })
            .unwrap();
        sql.execute("DELETE FROM family_materializations", [])
            .unwrap();
        // Routing/readiness is a scalar authority check, not an implicit scrub
        // of unrelated publications. Explicit status and selected publication
        // admission must still reject the missing materialization independently.
        scan.check(&vault).unwrap();
        scan.finish(&vault).unwrap();
        EnrolledScan::admit(&vault, &lock).unwrap();
        assert!(matches!(
            vault.store.family_status(),
            Err(zorid_store::StoreError::Corrupt(_))
        ));
        assert!(matches!(
            vault.store.family_materialization(&selected),
            Err(zorid_store::StoreError::Corrupt(_))
        ));
        let (parent, name) = vault.paths.parent(&path).unwrap();
        let expected = content_stream::file_snapshot(&parent, &name)
            .unwrap()
            .unwrap();
        // An inert capture proves these actual bytes and parent; it does not
        // authorize authoring or publication from a damaged materialization.
        let captured = vault
            .capture_observed_file(
                &path,
                &parent,
                &name,
                &OperationId::new("unscoped_test").unwrap(),
                None,
                None,
                &expected,
                true,
            )
            .unwrap();
        assert_eq!(captured.inline_bytes(), Some(b"retained".as_slice()));
        assert_eq!(
            sql.query_row("SELECT count(*) FROM authored_envelopes", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            authored
        );
        assert_eq!(
            std::fs::read(root.path().join("retained.md")).unwrap(),
            b"retained"
        );
    }
}
