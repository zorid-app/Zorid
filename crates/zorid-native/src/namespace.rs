//! Explicit-member namespace projection. A local command binds its observed
//! source occupants before commit; replay never guesses ownership from bytes.
use super::*;
use zorid_store::{
    NamespaceAttempt, NamespaceEvidence, NamespaceMember, ProjectionOrigin, ProjectionWork,
};

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
        Ok(self
            .store
            .namespace_attempts(true)?
            .into_iter()
            .map(|a| NamespaceAttemptStatus {
                job_id: a.job.job_id.clone(),
                completed: a.completed,
                members: a
                    .members
                    .iter()
                    .enumerate()
                    .map(|(index, m)| NamespaceMemberStatus {
                        entry_id: m.change.after.id.clone(),
                        source: m.evidence.before.path.clone(),
                        target: m.change.after.path.clone(),
                        recovery_path: format!(".zorid/{}", retained(&a, index)),
                        directory_stage_path: (m.change.after.kind == EntryKind::Folder
                            && a.job.work == ProjectionWork::Move
                            && !noop(&a, index))
                        .then(|| format!(".zorid/{}", stage(&a, index))),
                        captured: m.captured,
                        published: m.published,
                        finished: m.finished,
                    })
                    .collect(),
            })
            .collect())
    }

    pub(super) fn namespace_obscures(&self, path: &VaultPath) -> Result<bool> {
        Ok(self
            .store
            .namespace_jobs()?
            .iter()
            .filter(|j| !j.completed)
            .any(|job| {
                job.affected.iter().any(|c| {
                    intersects(path, &c.after)
                        || c.before.as_ref().is_some_and(|s| intersects(path, s))
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
            let job = self.store.namespace_jobs()?.into_iter().find(|j| {
                matches!(&j.origin, ProjectionOrigin::LocalCommand { operation_id } if operation_id == operation)
            }).ok_or(Error::Busy("namespace command has no projection job"))?;
            if job.completed {
                return Ok(());
            }
            let attempt = self
                .store
                .namespace_attempts(false)?
                .into_iter()
                .find(|a| a.job.job_id == job.job_id)
                .ok_or(Error::Busy(
                    "legacy namespace job lacks pre-commit physical provenance",
                ))?;
            self.resume_namespace(attempt)
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
                    let disk = fs::snapshot(&parent, &name, self.options.max_file_bytes)?
                        .ok_or(Error::Busy("namespace source disappeared"))?;
                    let stored = self
                        .store
                        .read(&before.id)?
                        .ok_or(Error::Busy("namespace source deleted"))?;
                    if stored.state != *before || stored.content.as_ref() != Some(&disk.bytes) {
                        return Err(Error::Busy("namespace source changed during preflight"));
                    }
                    bytes = bytes
                        .checked_add(disk.bytes.len())
                        .ok_or(Error::Unsupported("namespace byte bound exceeded"))?;
                    if bytes > 64 * 1024 * 1024 {
                        return Err(Error::Unsupported("namespace byte bound exceeded"));
                    }
                    (disk.identity, Some(disk.bytes))
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
        *a = self
            .store
            .update_namespace_member(&a.job.job_id, &a.members[index], &next)?;
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
    fn namespace_divergence(&mut self, m: &NamespaceMember, bytes: Vec<u8>) -> Result<()> {
        self.store.record_external(
            &m.evidence.before.path,
            m.evidence.file_baseline.clone(),
            bytes,
        )?;
        Ok(())
    }
    /// Restore only into the original absent pathname. If a replacement occupies
    /// it, keep the captured object at its deterministic recovery name.
    fn restore_unexpected(&self, m: &NamespaceMember, name: &str) {
        if let Ok((parent, source)) = self.namespace_source(m) {
            let _ = fs::rename_new(&self.paths.private, name, &parent, &source);
        }
    }
    fn capture_namespace_member(&mut self, a: &mut NamespaceAttempt, index: usize) -> Result<()> {
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
            let bytes = fs::snapshot(&self.paths.private, &private, self.options.max_file_bytes)?
                .ok_or(Error::Busy("namespace capture disappeared"))?
                .bytes;
            if m.evidence.content.as_ref() != Some(&bytes) {
                self.namespace_divergence(&m, bytes)?;
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
            let source = fs::snapshot(&self.paths.private, &private, self.options.max_file_bytes)?
                .ok_or(Error::Busy("namespace retained source disappeared"))?;
            if source.identity != m.evidence.source_identity {
                return Err(Error::Busy("namespace retained source replaced"));
            }
            if m.evidence.content.as_ref() != Some(&source.bytes) {
                self.namespace_divergence(&m, source.bytes)?;
                return Err(Error::Busy(
                    "external edit retained before namespace publication",
                ));
            }
            fs::rename_new(&self.paths.private, &private, &parent, &name)?;
            self.point("namespace_published_before_record");
        }
        self.paths.verify_parent(&m.change.after.path, &parent)?;
        let dest = fs::snapshot(&parent, &name, self.options.max_file_bytes)?
            .ok_or(Error::Busy("namespace destination disappeared"))?;
        if dest.identity != m.evidence.source_identity {
            return Err(Error::Busy("namespace destination replaced"));
        }
        if m.evidence.content.as_ref() != Some(&dest.bytes) {
            self.namespace_divergence(&m, dest.bytes)?;
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
        if a.completed {
            return Ok(());
        }
        self.paths.verify()?;
        // Never publish an earlier move into a path now owned by a later logical
        // operation. Retained objects and both jobs remain available for recovery.
        for m in &a.members {
            let current = self.store.read(&m.change.after.id)?;
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
            let disk = fs::snapshot(&parent, &name, self.options.max_file_bytes)?
                .ok_or(Error::Busy("namespace file missing before completion"))?;
            if disk.identity != m.evidence.source_identity {
                return Err(Error::Busy("namespace file replaced before completion"));
            }
            if m.evidence.content.as_ref() != Some(&disk.bytes) {
                self.namespace_divergence(m, disk.bytes)?;
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
        let attempts = self.store.namespace_attempts(true)?;
        for job in self
            .store
            .namespace_jobs()?
            .into_iter()
            .filter(|j| !j.completed)
        {
            if !attempts.iter().any(|a| a.job.job_id == job.job_id) {
                report.blocked.push((
                    job.target.path,
                    "legacy namespace job has no physical provenance; source left untouched".into(),
                ));
            }
        }
        for a in attempts {
            if !a.completed {
                let target = a.job.target.clone();
                match self.resume_namespace(a) {
                    Ok(()) => report.projected.push(target.id),
                    Err(error) => report.blocked.push((target.path, error.to_string())),
                }
            } else {
                // Retention has no automatic GC. Open handles can still write a
                // deleted file or add a child to a captured directory after ACK.
                for (index, m) in a.members.iter().enumerate() {
                    if noop(&a, index) {
                        continue;
                    }
                    let private = retained(&a, index);
                    if m.change.after.kind == EntryKind::Folder {
                        if let Some(dir) = fs::optional_directory(&self.paths.private, &private)? {
                            if fs::identity(&dir)? != m.evidence.source_identity
                                || !fs::directory_empty(&dir)?
                            {
                                report.blocked.push((
                                    m.evidence.before.path.clone(),
                                    format!("retained directory needs recovery: .zorid/{private}"),
                                ));
                            }
                        }
                    } else if a.job.work == ProjectionWork::Delete {
                        if let Some(file) = fs::snapshot(
                            &self.paths.private,
                            &private,
                            self.options.max_file_bytes,
                        )? {
                            if file.identity != m.evidence.source_identity
                                || m.evidence.content.as_ref() != Some(&file.bytes)
                            {
                                self.namespace_divergence(m, file.bytes)?;
                                report.blocked.push((
                                    m.evidence.before.path.clone(),
                                    format!("retained deleted file changed: .zorid/{private}"),
                                ));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
