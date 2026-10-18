use crate::{
    fs::{self, Paths},
    *,
};
use content_stream::{file_snapshot, metadata_matches_content, snapshot_matches_content};
use std::{fs::File, path::Path};
use zorid_core::{EntryKind, Mutation, OperationId};
use zorid_store::{
    ObservationPhysical, PhysicalIdentity, ProjectionAttempt, ProjectionPhase, PublicationKind,
    Store, StoredContent,
};
#[path = "binary_api.rs"]
mod binary_api;
#[cfg(test)]
#[path = "binary_stream_tests.rs"]
mod binary_stream_tests;
#[path = "checkpoints.rs"]
mod checkpoints;
#[path = "content_stream.rs"]
mod content_stream;
#[path = "external_create.rs"]
mod external_create;
pub use external_create::{select_external_file_mode, ExternalFileMode};
#[path = "directory.rs"]
mod directory;
#[cfg(test)]
#[path = "external_create_tests.rs"]
mod external_create_tests;
#[path = "external_namespace.rs"]
mod external_namespace;
#[cfg(test)]
#[path = "external_namespace_tests.rs"]
mod external_namespace_tests;
#[path = "external_observe_stream.rs"]
mod external_observe_stream;
#[path = "external_scan.rs"]
mod external_scan;
#[path = "external_scan_progress.rs"]
mod external_scan_progress;
#[cfg(test)]
#[path = "external_scan_progress_tests.rs"]
mod external_scan_progress_tests;
#[path = "family.rs"]
mod family;
#[path = "family_namespace.rs"]
mod family_namespace;
#[cfg(test)]
#[path = "family_namespace_tests.rs"]
mod family_namespace_tests;
#[cfg(test)]
#[path = "family_observation_tests.rs"]
mod family_observation_tests;
#[path = "host_intents.rs"]
mod host_intents;
#[path = "namespace.rs"]
mod namespace;
#[cfg(test)]
#[path = "physical_binding_tests.rs"]
mod physical_binding_tests;
#[path = "publication_handoff.rs"]
mod publication_handoff;
#[path = "rescan.rs"]
mod rescan;
#[path = "text_sync.rs"]
mod text_sync;

#[path = "document_index.rs"]
mod document_index;

#[path = "workblocks.rs"]
mod workblocks;
pub use workblocks::*;

#[path = "local_recovery.rs"]
mod local_recovery;

pub struct NativeVault {
    paths: Paths,
    store: Store,
    options: Options,
    recovery: Option<zorid_recovery::RecoveryStore>,
    recovery_queue: Option<std::collections::VecDeque<EntryId>>,
    #[cfg(test)]
    pub(crate) fault: Option<fn(&str)>,
}
impl NativeVault {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_options(path, Options::default())
    }
    pub fn open_with_options(path: impl AsRef<Path>, options: Options) -> Result<Self> {
        Self::open_mode(path.as_ref(), options, true)
    }
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_existing_with_options(path, Options::default())
    }
    pub fn open_existing_with_options(path: impl AsRef<Path>, options: Options) -> Result<Self> {
        Self::open_mode(path.as_ref(), options, false)
    }
    fn open_mode(path: &Path, options: Options, create: bool) -> Result<Self> {
        let mut paths = Paths::open(path, create)?;
        let _guard = paths.lock(options.lock_timeout)?;
        paths.db_id = fs::regular_identity(&paths.private, "vault.sqlite")?;
        // Standard SQLite opens a pathname. This is private-owned storage, NOT a
        // custom descriptor-anchored VFS. Check aliases/identity before and after.
        let db_path = paths.absolute.join(".zorid/vault.sqlite");
        let store = if create {
            Store::open_no_follow(db_path)?
        } else {
            Store::open_existing_no_follow(db_path)?
        };
        paths.verify()?;
        paths.db_id = Some(
            fs::regular_identity(&paths.private, "vault.sqlite")?
                .ok_or_else(|| Error::UnsafePath("database missing after open".into()))?,
        );
        paths.private.sync_all()?;
        Ok(Self {
            paths,
            store,
            options,
            recovery: None,
            recovery_queue: None,
            #[cfg(test)]
            fault: None,
        })
    }
    fn point(&self, _name: &str) {
        #[cfg(test)]
        if let Some(f) = self.fault {
            f(_name);
        }
    }
    /// Trusted host fixture ownership, separate from the short vault write lock.
    pub fn claim_client(
        &self,
        client: &OperationId,
    ) -> std::result::Result<ClientLease, ClientAdmissionError> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let authority = self.identity()?.local_store_id;
        crate::client_admission::claim(&self.paths, authority, client)
    }
    pub fn verify_client_lease(
        &self,
        lease: &ClientLease,
    ) -> std::result::Result<(), ClientAdmissionError> {
        let authority = self.identity()?.local_store_id;
        crate::client_admission::verify(&self.paths, &authority, lease)
    }
    pub fn identity(&self) -> Result<AuthorityIdentity> {
        self.paths.verify()?;
        Ok(self.store.identity()?)
    }
    pub fn list(&self) -> Result<Vec<EntryState>> {
        self.paths.verify()?;
        Ok(self.store.list()?)
    }
    pub fn read(&self, id: &EntryId) -> Result<Option<StoredEntry>> {
        self.paths.verify()?;
        Ok(self.store.read(id)?)
    }
    pub fn read_path(&self, path: &VaultPath) -> Result<Option<PresentedEntry>> {
        self.paths.verify()?;
        Ok(self.store.read_path(path)?)
    }
    pub fn read_presented(&self, id: &EntryId) -> Result<Option<PresentedEntry>> {
        self.paths.verify()?;
        Ok(self.store.read_presented(id)?)
    }
    pub fn list_snapshot(&self) -> Result<ListingSnapshot> {
        self.paths.verify()?;
        Ok(self.store.list_snapshot()?)
    }
    pub fn changes_after(&self, cursor: &str, limit: u32) -> Result<ChangePage> {
        self.paths.verify()?;
        Ok(self.store.changes_after(cursor, limit)?)
    }
    pub fn status(&self) -> Result<Status> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let (outbox, projection) = self.store.pending_counts()?;
        Ok(Status {
            pending_outbox: outbox.to_string(),
            pending_projection: projection.to_string(),
            directory_attempts: self
                .store
                .directory_attempts(false)?
                .into_iter()
                .map(|a| FolderAttemptStatus {
                    attempt_id: a.attempt_id,
                    entry_id: a.target.id,
                    path: a.target.path,
                    phase: a.phase,
                })
                .collect(),
            scan: self.store.latest_scan()?,
            namespace_attempts: self.namespace_attempt_statuses()?,
            attempts: self
                .store
                .projection_attempts(false)?
                .into_iter()
                .map(|a| AttemptStatus {
                    attempt_id: a.attempt_id,
                    entry_id: a.target.state.id,
                    path: a.target.state.path,
                    target_revision: a.target.state.revision,
                    phase: a.phase,
                })
                .collect(),
            observations: self
                .store
                .external_observations()?
                .into_iter()
                .map(|o| ObservationStatus {
                    observation_id: o.observation_id,
                    path: o.path,
                    byte_length: o.content.len().to_string(),
                    resolved: o.resolution.is_some(),
                })
                .collect(),
        })
    }
    /// The lock is held only around local reconciliation/transactions/publication;
    /// no desktop process, daemon, IPC endpoint, network or background thread.
    pub fn apply(&mut self, request: &MutationRequest) -> Result<ApplyOutcome> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.apply_locked(request)
    }
    fn apply_locked(&mut self, request: &MutationRequest) -> Result<ApplyOutcome> {
        self.paths.verify()?;
        // Enrolled commands must check the complete family identity before a
        // legacy receipt or filesystem import can bypass its mode/outbox fence.
        // File Create with no explicit mode is rejected by FamilyCommand.
        if self.store.family_is_enrolled()? {
            return self.family_apply_locked(request, None);
        }
        if let Some(commit) = self.store.replay(request)? {
            let projection = if matches!(
                request.mutation,
                Mutation::Move { .. } | Mutation::Delete { .. }
            ) {
                self.namespace_status(&request.operation_id)
            } else {
                self.project_status(request.mutation.id())
            };
            return Ok(ApplyOutcome { commit, projection });
        }
        self.store.validate_host_execution(request)?;
        if matches!(
            request.mutation,
            Mutation::Move { .. } | Mutation::Delete { .. }
        ) {
            return self.apply_namespace_locked(request);
        }
        let (path, bytes): (VaultPath, &[u8]) = match &request.mutation {
            Mutation::Create {
                path,
                kind: EntryKind::Folder,
                content: None,
                ..
            } => (path.clone(), &[]),
            Mutation::Create {
                path,
                kind: EntryKind::File,
                content: Some(content),
                ..
            } => (path.clone(), content),
            Mutation::Write { id, content, .. } => (
                self.store
                    .read(id)?
                    .ok_or_else(|| {
                        Error::Contract(zorid_core::ContractError::EntryNotFound { id: id.clone() })
                    })?
                    .state
                    .path,
                content,
            ),
            _ => return Err(Error::Unsupported("physical moves and deletions")),
        };
        self.namespace_clear(&path)?;
        if bytes.len() > self.options.max_file_bytes {
            return Err(Error::Unsupported(
                "file exceeds configured whole-file limit",
            ));
        }
        // Recover a prior attempt first. Unresolved divergence may block physical
        // publication but need not discard a new optimistic database mutation.
        if let Some(a) = self
            .store
            .projection_attempts(false)?
            .into_iter()
            .find(|a| a.target.state.path == path)
        {
            let _ = self.resume(&a);
        }
        if matches!(
            request.mutation,
            Mutation::Create {
                kind: EntryKind::Folder,
                ..
            }
        ) {
            let (parent, name) = self.paths.parent(&path)?;
            if fs::node_type(&parent, &name)?.is_some() {
                return Err(Error::Busy(
                    "folder destination already exists; rescan to import",
                ));
            }
        } else {
            let _ = self.observe(&path)?;
        }
        if matches!(request.mutation, Mutation::Create { .. }) {
            self.parent_imports(&path)?;
        }
        self.paths.verify()?;
        let commit = self.store.apply(request)?;
        self.point("committed");
        // After this boundary errors are represented as Pending with the receipt;
        // callers must never retry under a new operation ID due to projection I/O.
        let projection = self.project_status(request.mutation.id());
        Ok(ApplyOutcome { commit, projection })
    }
    fn project_status(&mut self, id: &EntryId) -> ProjectionStatus {
        let result = self.project(id);
        // Retained history is secondary to the durable save receipt. Failure here
        // must never turn a committed save into an ambiguous retry.
        let provenance = if result.is_ok() {
            zorid_recovery::SnapshotProvenance::Periodic
        } else {
            zorid_recovery::SnapshotProvenance::SaveFailure
        };
        let _ = self.capture_local_recovery(id, local_recovery::now_ms(), provenance);
        match result {
            Ok(()) => ProjectionStatus::Projected,
            Err(e) => ProjectionStatus::Pending(e.to_string()),
        }
    }
    /// Explicit path hints are authoritative only after re-reading the filesystem.
    /// A watcher can call this API; explicit recursive traversal uses rescan().
    pub fn reconcile(&mut self, paths: &[VaultPath]) -> Result<ReconcileReport> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let mut report = self.recover_locked()?;
        for path in paths {
            match self.observe(path) {
                Ok(Some(commit)) => report.imported.push(commit),
                Ok(None) => {}
                Err(e) => {
                    report.blocked.push((path.clone(), e.to_string()));
                    continue;
                }
            }
            if let Some(state) = self.store.list()?.into_iter().find(|s| s.path == *path) {
                match self.project(&state.id) {
                    Ok(()) => report.projected.push(state.id),
                    Err(e) => report.blocked.push((path.clone(), e.to_string())),
                }
            }
        }
        self.paths.verify()?;
        Ok(report)
    }
    pub fn recover(&mut self) -> Result<ReconcileReport> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.recover_locked()
    }
    fn recover_locked(&mut self) -> Result<ReconcileReport> {
        let mut report = ReconcileReport::default();
        self.recover_namespaces(&mut report)?;
        for a in self.store.directory_attempts(false)? {
            match self.resume_directory(&a) {
                Ok(()) => report.projected.push(a.target.id),
                Err(e) => report.blocked.push((a.target.path, e.to_string())),
            }
        }
        for state in self
            .store
            .list()?
            .into_iter()
            .filter(|s| s.kind == EntryKind::Folder)
        {
            if report.blocked.iter().any(|(p, _)| *p == state.path)
                || report.projected.contains(&state.id)
            {
                continue;
            }
            // A moved folder's proven physical branch can have a different
            // optimistic revision. Recheck its inode and explicitly advance only
            // an identical family publication witness through project_directory.
            if self.store.directory_baseline(&state.id)?.is_some()
                || self.store.pending_directory_create(&state.id)?
            {
                match self.project_directory(&state.id) {
                    Ok(()) => report.projected.push(state.id),
                    Err(e) => report.blocked.push((state.path, e.to_string())),
                }
            }
        }
        // Retry only exact artifacts belonging to durable settled attempts.
        // Pending stages/displacements and unrelated private files are untouched.
        for a in self
            .store
            .projection_attempts(true)?
            .into_iter()
            .filter(|a| a.completed())
        {
            if let Err(error) = self.retire_settled_previous(&a.attempt_id) {
                report
                    .blocked
                    .push((a.target.state.path, error.to_string()));
            }
        }
        for a in self.store.projection_attempts(false)? {
            match self.resume(&a) {
                Ok(()) => match self.project(&a.target.state.id) {
                    Ok(()) => report.projected.push(a.target.state.id),
                    Err(e) => report.blocked.push((a.target.state.path, e.to_string())),
                },
                Err(e) => report.blocked.push((a.target.state.path, e.to_string())),
            }
        }
        for state in self
            .store
            .list()?
            .into_iter()
            .filter(|s| s.kind == EntryKind::File)
        {
            if report.blocked.iter().any(|(path, _)| *path == state.path)
                || report.projected.contains(&state.id)
            {
                continue;
            }
            if self
                .store
                .projection_baseline(&state.id)?
                .as_ref()
                .is_some_and(|b| b.state == state)
            {
                continue;
            }
            match self.project(&state.id) {
                Ok(()) => report.projected.push(state.id),
                Err(e) => report.blocked.push((state.path, e.to_string())),
            }
        }
        self.paths.verify()?;
        Ok(report)
    }
    fn parent_imports(&mut self, path: &VaultPath) -> Result<()> {
        let mut parents = Vec::new();
        let mut parent = path.parent();
        while let Some(path) = parent {
            parent = path.parent();
            parents.push(path);
        }
        parents.reverse();
        for parent in parents {
            self.observe_directory(&parent)?;
        }
        Ok(())
    }
    fn observe(&mut self, path: &VaultPath) -> Result<Option<CommitResult>> {
        self.namespace_clear(path)?;
        let (parent, name) = self.paths.parent(path)?;
        if fs::node_type(&parent, &name)? == Some(rustix::fs::FileType::Directory) {
            return self.observe_directory(path);
        }
        if self.store.family_is_enrolled()? {
            if let Some(snapshot) = file_snapshot(&parent, &name)? {
                return self.observe_streamed_file(
                    path,
                    &parent,
                    &snapshot,
                    &OperationId::new("native_external_observe")?,
                );
            }
        }
        let disk = fs::snapshot(&parent, &name, self.options.max_file_bytes)?;
        self.observe_snapshot(path, &parent, disk)
    }
    fn observe_snapshot(
        &mut self,
        path: &VaultPath,
        parent: &File,
        disk: Option<fs::Snapshot>,
    ) -> Result<Option<CommitResult>> {
        if self.store.family_is_enrolled()? {
            if let Some(disk) = &disk {
                let snapshot = file_snapshot(parent, path.file_name())?
                    .ok_or(Error::Busy("observed family file disappeared"))?;
                if snapshot.identity != disk.identity
                    || snapshot.length != disk.bytes.len() as u64
                    || snapshot.digest != Sha256Digest::of(&disk.bytes).0
                {
                    return Err(Error::Busy("observed family file changed"));
                }
                return self.observe_streamed_file(
                    path,
                    parent,
                    &snapshot,
                    &OperationId::new("native_external_observe")?,
                );
            }
        }
        self.namespace_clear(path)?;
        self.paths.verify_parent(path, &parent)?;
        let state = self.store.list()?.into_iter().find(|s| s.path == *path);
        if let Some(owner) = self.store.physical_owner_at(path)? {
            if state
                .as_ref()
                .is_none_or(|state| state.id != owner.state.id)
            {
                return Err(Error::Busy(
                    "retained physical owner is hidden or awaits namespace reconciliation",
                ));
            }
        }
        let Some(disk) = disk else {
            if let Some(state) = &state {
                let materialized = if state.kind == EntryKind::File {
                    self.store.projection_baseline(&state.id)?.is_some()
                } else {
                    self.store.directory_baseline(&state.id)?.is_some()
                };
                if materialized {
                    return Err(Error::Unsupported(
                        "external deletion retained; deletion reconciliation is not implemented",
                    ));
                }
            }
            return Ok(None);
        };
        if state.as_ref().is_some_and(|s| s.kind != EntryKind::File) {
            return Err(Error::UnsafePath(
                "filesystem file collides with logical folder".into(),
            ));
        }
        let base = match &state {
            Some(s) => self.store.projection_baseline(&s.id)?,
            None => None,
        };
        let expected_binding = match &state {
            Some(state) => self.store.physical_binding(&state.id)?,
            None => None,
        };
        let physical = PhysicalIdentity {
            inode: disk.identity.clone(),
            parent_inode: fs::identity(parent)?,
        };
        if expected_binding
            .as_ref()
            .is_some_and(|binding| binding.physical.parent_inode != physical.parent_inode)
        {
            self.store.record_external(path, base, disk.bytes)?;
            return Err(Error::Busy(
                "observation parent replaced; original binding retained",
            ));
        }
        if base.is_some() && expected_binding.is_none() {
            self.store.record_external(path, base, disk.bytes)?;
            return Err(Error::Busy(
                "unproven physical baseline requires explicit enrollment",
            ));
        }
        if base.as_ref().is_some_and(|base| {
            base.state.path == *path && base.content.inline_bytes() == Some(disk.bytes.as_slice())
        }) {
            if expected_binding
                .as_ref()
                .is_some_and(|b| b.physical == physical)
            {
                return Ok(None);
            }
            self.store.record_external(path, base, disk.bytes)?;
            return Err(Error::Busy(
                "equal-byte replacement has no original inode authority",
            ));
        }
        let active = self
            .store
            .projection_attempts(false)?
            .into_iter()
            .find(|a| a.target.state.path == *path);
        let observation = self.store.record_external_bound(
            path,
            base.clone(),
            disk.bytes.clone(),
            &ObservationPhysical {
                physical: physical.clone(),
                expected_binding,
            },
        )?;
        let observed_bytes = observation
            .content
            .inline_bytes()
            .ok_or(Error::Unsupported(
                "legacy observation requires bounded inline bytes",
            ))?;
        let enrolled = self.store.family_is_enrolled()?;
        let managed = match &state {
            Some(state) if enrolled => self.store.family_text_state(&state.id)?.is_some(),
            Some(state) => self.store.text_state(&state.id)?.is_some(),
            None => false,
        };
        if let Some(active) = active {
            // A receive can leave an unpublished intent blocked by external edits.
            // Cancelling only a provably undisplaced stage retains its bytes and
            // queue; the observed branch can then merge before a new publication.
            let previous = format!("{}.previous", active.attempt_id.as_str());
            let undisplaced = matches!(
                active.phase,
                ProjectionPhase::Prepared | ProjectionPhase::Staged
            ) && active.stage_identity.as_ref() != Some(&disk.identity)
                && fs::node_type(&self.paths.private, &previous)?.is_none();
            if managed && undisplaced {
                self.paths.verify_parent(path, parent)?;
                self.store.finish_projection(&active.attempt_id, false)?;
            } else {
                return Err(Error::Busy(
                    "unresolved projection; external observation retained",
                ));
            }
        }
        if enrolled {
            if state.is_none() || base.is_none() {
                return Err(Error::Unsupported(
                    "new external files require explicit family mode enrollment",
                ));
            }
            self.verify_observed_file(path, parent, &physical, observed_bytes)?;
            self.paths.verify_parent(path, parent)?;
            return Ok(Some(
                self.store
                    .import_family_observation(&observation.observation_id)?,
            ));
        }
        if managed {
            self.verify_observed_file(path, parent, &physical, observed_bytes)?;
            self.paths.verify_parent(path, parent)?;
            return Ok(Some(
                self.store
                    .import_text_observation(&observation.observation_id)?,
            ));
        }
        let mutation = match (state, base) {
            (None, None) => {
                self.parent_imports(path)?;
                Mutation::Create {
                    id: new_id(),
                    path: path.clone(),
                    kind: EntryKind::File,
                    content: Some(disk.bytes),
                }
            }
            (Some(state), Some(base))
                if state.revision == base.state.revision && state.path == base.state.path =>
            {
                Mutation::Write {
                    id: state.id,
                    expected: state.revision,
                    content: disk.bytes,
                }
            }
            _ => {
                return Err(Error::Busy(
                    "external and database versions diverged; external observation retained",
                ))
            }
        };
        self.paths.verify_parent(path, &parent)?;
        self.verify_observed_file(path, parent, &physical, observed_bytes)?;
        // Observation ID is the deterministic import operation key on retry.
        Ok(Some(self.store.import_observation(
            &observation.observation_id,
            &MutationRequest {
                operation_id: observation.observation_id.clone(),
                mutation,
            },
        )?))
    }
    fn project(&mut self, id: &EntryId) -> Result<()> {
        if !self.store.is_visible_entry(id)? {
            return Err(Error::Busy("hidden entry retains its physical publication"));
        }
        if let Some(entry) = self.store.read_metadata(id)? {
            self.namespace_clear(&entry.state.path)?;
        }
        self.paths.verify()?;
        if let Some(a) = self
            .store
            .projection_attempts(false)?
            .into_iter()
            .find(|a| a.target.state.id == *id)
        {
            self.resume(&a)?;
        }
        let Some(current) = self.store.read_metadata(id)? else {
            return Err(Error::Unsupported("physical deletion"));
        };
        if current.state.kind == EntryKind::Folder {
            return self.project_directory(id);
        }
        if self
            .store
            .projection_baseline(id)?
            .as_ref()
            .is_some_and(|b| {
                b.state == current.state
                    && current
                        .content
                        .as_ref()
                        .is_some_and(|metadata| metadata_matches_content(metadata, &b.content))
            })
        {
            // Do not claim success merely from a baseline: an external writer may
            // have replaced it since the previous publication/import.
            let (p, n) = self.paths.parent(&current.state.path)?;
            let binding = self.store.physical_binding(id)?;
            let parent_inode = fs::identity(&p)?;
            if file_snapshot(&p, &n)?.as_ref().is_some_and(|d| {
                current.content.as_ref().is_some_and(|metadata| {
                    d.length == metadata.len() && d.digest == metadata.digest().0
                }) && binding.as_ref().is_some_and(|binding| {
                    binding.physical.inode == d.identity
                        && parent_inode == binding.physical.parent_inode
                })
            }) {
                self.paths.verify_parent(&current.state.path, &p)?;
                return Ok(());
            }
            return Err(Error::Busy("physical content no longer matches baseline"));
        }
        let (parent, _) = self.paths.parent(&current.state.path)?;
        self.paths.verify_parent(&current.state.path, &parent)?;
        let attempt = self
            .store
            .begin_projection_bound(id, &fs::identity(&parent)?)?;
        self.point("prepared");
        self.resume(&attempt)
    }
    fn verify_observed_file(
        &self,
        path: &VaultPath,
        parent: &File,
        physical: &PhysicalIdentity,
        bytes: &[u8],
    ) -> Result<()> {
        self.paths.verify_parent(path, parent)?;
        if fs::identity(parent)? != physical.parent_inode {
            return Err(Error::Busy("observation parent changed"));
        }
        let (_, name) = self.paths.parent(path)?;
        let current = fs::snapshot(parent, &name, self.options.max_file_bytes)?;
        if current
            .as_ref()
            .is_none_or(|s| s.identity != physical.inode || s.bytes != bytes)
        {
            return Err(Error::Busy("observed file changed before import"));
        }
        Ok(())
    }
    /// This retires a temporary displaced inode, not historical recovery data.
    /// A durable completed attempt and its saved physical proof authorize the
    /// exact name/inode. Changed bytes become a durable inert observation first.
    /// Failure leaves the artifact for recover_locked to retry; it cannot undo
    /// the already committed publication or authorize a new save operation ID.
    pub(super) fn retire_settled_previous(&mut self, id: &OperationId) -> Result<()> {
        let attempt = self.store.projection_attempt(id)?;
        if !attempt.completed() {
            return Err(Error::Busy("pending projection retains its displaced file"));
        }
        self.paths.verify()?;
        let previous = format!("{}.previous", attempt.attempt_id.as_str());
        let private = self.paths.private.try_clone()?;
        let Some(old) = file_snapshot(&private, &previous)? else {
            return Ok(());
        };
        let proof = self.store.publication_proof(id)?.ok_or(Error::Busy(
            "settled displacement has no saved physical proof",
        ))?;
        if proof.kind != PublicationKind::File
            || proof.entry_id != attempt.target.state.id
            || proof
                .expected_binding
                .as_ref()
                .is_none_or(|binding| binding.physical.inode != old.identity)
        {
            return Err(Error::Busy(
                "settled displacement identity differs from saved proof",
            ));
        }
        if attempt
            .baseline
            .as_ref()
            .is_none_or(|baseline| !snapshot_matches_content(&old, &baseline.content))
        {
            self.point("before_previous_capture");
            self.capture_projection_snapshot(&attempt, &private, &previous, &old)?;
            self.point("previous_captured");
        }
        self.point("before_previous_unlink");
        self.paths.verify()?;
        let current = file_snapshot(&private, &previous)?.ok_or(Error::Busy(
            "settled displacement disappeared before retirement",
        ))?;
        if current != old {
            return Err(Error::Busy(
                "settled displacement changed before retirement",
            ));
        }
        fs::unlink_regular_identity(&private, &previous, &old.identity)?;
        self.paths.verify()?;
        Ok(())
    }

    fn resume(&mut self, original: &ProjectionAttempt) -> Result<()> {
        if !self.store.is_visible_entry(&original.target.state.id)? {
            return Err(Error::Busy("hidden entry retains its physical publication"));
        }
        self.paths.verify()?;
        let mut a = original.clone();
        let stage = format!("{}.stage", a.attempt_id.as_str());
        let previous = format!("{}.previous", a.attempt_id.as_str());
        let desired = self.store.read_metadata(&a.target.state.id)?;
        if desired
            .as_ref()
            .is_none_or(|d| d.state.path != a.target.state.path || d.state.kind != EntryKind::File)
        {
            return Err(Error::Unsupported(
                "projection target moved/deleted; retained for later reconciliation",
            ));
        }
        let (parent, name) = self.paths.parent(&a.target.state.path)?;
        let proof = self
            .store
            .publication_proof(&a.attempt_id)?
            .ok_or(Error::Busy(
                "unproven publication requires explicit recovery",
            ))?;
        if proof.kind != PublicationKind::File
            || proof.entry_id != a.target.state.id
            || proof.parent_inode != fs::identity(&parent)?
            || self.store.physical_binding(&a.target.state.id)? != proof.expected_binding
        {
            return Err(Error::Busy(
                "publication physical binding or parent changed",
            ));
        }
        let dest = file_snapshot(&parent, &name)?;
        let backup = file_snapshot(&self.paths.private, &previous)?;
        // A retained displaced inode may have received late writes through an
        // already-open external handle. Preserve and expose these changed bytes.
        if let Some(old) = &backup {
            if proof
                .expected_binding
                .as_ref()
                .is_none_or(|b| b.physical.inode != old.identity)
            {
                let private = self.paths.private.try_clone()?;
                self.capture_projection_file(&a, &private, &previous)?;
                return Err(Error::Busy("displaced inode does not match saved binding"));
            }
            if a.baseline
                .as_ref()
                .is_none_or(|b| !snapshot_matches_content(old, &b.content))
            {
                let private = self.paths.private.try_clone()?;
                self.capture_projection_file(&a, &private, &previous)?;
            }
        }
        if dest
            .as_ref()
            .is_some_and(|d| Some(&d.identity) == a.stage_identity.as_ref())
        {
            let mut changed = !snapshot_matches_content(dest.as_ref().unwrap(), &a.target.content);
            if changed {
                self.capture_projection_file(&a, &parent, &name)?;
            }
            parent.sync_all()?;
            self.point("before_baseline");
            self.paths.verify_parent(&a.target.state.path, &parent)?;
            let acknowledged = file_snapshot(&parent, &name)?.ok_or(Error::Busy(
                "published file disappeared before recovery acknowledgement",
            ))?;
            if Some(&acknowledged.identity) != a.stage_identity.as_ref() {
                self.capture_projection_file(&a, &parent, &name)?;
                return Err(Error::Busy(
                    "published inode replaced before recovery acknowledgement",
                ));
            }
            if !snapshot_matches_content(&acknowledged, &a.target.content) {
                self.capture_projection_file(&a, &parent, &name)?;
                changed = true;
            }
            self.store.finish_projection_bound(
                &a.attempt_id,
                &PhysicalIdentity {
                    inode: a
                        .stage_identity
                        .clone()
                        .ok_or(Error::Busy("missing stage identity"))?,
                    parent_inode: proof.parent_inode.clone(),
                },
            )?;
            self.point("projection_finished");
            let _ = self.retire_settled_previous(&a.attempt_id);
            return if changed {
                Err(Error::Busy("published content externally edited; retained"))
            } else {
                Ok(())
            };
        }
        let current_target = desired.as_ref().is_some_and(|v| {
            v.state == a.target.state
                && v.content
                    .as_ref()
                    .is_some_and(|metadata| metadata_matches_content(metadata, &a.target.content))
        });
        if !current_target {
            // Desired advanced while this attempt was offline. Never publish old
            // bytes. Restore displaced baseline only into an absent destination.
            if dest.is_none() && backup.is_some() {
                self.paths.verify_parent(&a.target.state.path, &parent)?;
                fs::rename_new(&self.paths.private, &previous, &parent, &name)?;
                self.paths.verify_parent(&a.target.state.path, &parent)?;
            }
            if let Some(dest) = dest {
                if a.baseline
                    .as_ref()
                    .is_none_or(|b| !snapshot_matches_content(&dest, &b.content))
                {
                    self.capture_projection_file(&a, &parent, &name)?;
                }
            }
            self.store.finish_projection(&a.attempt_id, false)?;
            let _ = self.retire_settled_previous(&a.attempt_id);
            return Ok(());
        }
        if let Some(old) = &backup {
            if a.baseline
                .as_ref()
                .is_none_or(|b| !snapshot_matches_content(old, &b.content))
            {
                if dest.is_none() {
                    self.paths.verify_parent(&a.target.state.path, &parent)?;
                    fs::rename_new(&self.paths.private, &previous, &parent, &name)?;
                    self.paths.verify_parent(&a.target.state.path, &parent)?;
                }
                return Err(Error::Busy(
                    "displaced file changed; preserved and publication stopped",
                ));
            }
            if let Some(disk) = &dest {
                self.capture_projection_file(&a, &parent, &name)?;
                return Err(Error::Busy(
                    "external file appeared after displacement; all versions retained",
                ));
            }
        } else {
            match (&a.baseline, &dest) {
                (None, None) => {}
                (Some(base), Some(disk))
                    if base.state.path == a.target.state.path
                        && snapshot_matches_content(disk, &base.content)
                        && proof
                            .expected_binding
                            .as_ref()
                            .is_some_and(|b| b.physical.inode == disk.identity) => {}
                (_, Some(disk)) => {
                    self.capture_projection_file(&a, &parent, &name)?;
                    return Err(Error::Busy(
                        "destination diverged from baseline; not overwritten",
                    ));
                }
                (Some(_), None) => {
                    return Err(Error::Unsupported("external deletion; not recreated"))
                }
            }
        }
        let staged = file_snapshot(&self.paths.private, &stage)?;
        let stage_id = if let Some(staged) = staged {
            if !snapshot_matches_content(&staged, &a.target.content) {
                if a.stage_identity.is_some() {
                    return Err(Error::UnsafePath(
                        "altered previously synced stage retained".into(),
                    ));
                }
                let partial = format!("{}.partial-{}", a.attempt_id.as_str(), uuid::Uuid::new_v4());
                fs::rename_new(&self.paths.private, &stage, &self.paths.private, &partial)?;
                self.stage_projection_content(&stage, &a.target.state, &a.target.content)?
            } else {
                fs::regular(&self.paths.private, &stage)?
                    .ok_or(Error::Busy("stage disappeared"))?
                    .sync_all()?;
                self.paths.private.sync_all()?;
                staged.identity
            }
        } else {
            if a.stage_identity.is_some() {
                return Err(Error::Busy(
                    "previous stage disappeared without publication proof",
                ));
            }
            let id = self.stage_projection_content(&stage, &a.target.state, &a.target.content)?;
            self.point("stage_written");
            id
        };
        a = self
            .store
            .mark_projection(&a.attempt_id, ProjectionPhase::Staged, Some(stage_id))?;
        self.point("staged");
        if backup.is_none() && dest.is_some() {
            self.paths.verify_parent(&a.target.state.path, &parent)?;
            fs::rename_new(&parent, &name, &self.paths.private, &previous)?;
            self.paths.verify_parent(&a.target.state.path, &parent)?;
            self.point("displaced_before_record");
            a = self
                .store
                .mark_projection(&a.attempt_id, ProjectionPhase::Displaced, None)?;
            let moved = file_snapshot(&self.paths.private, &previous)?
                .ok_or(Error::Busy("displaced file missing"))?;
            if a.baseline
                .as_ref()
                .is_none_or(|b| !snapshot_matches_content(&moved, &b.content))
                || proof
                    .expected_binding
                    .as_ref()
                    .is_none_or(|b| b.physical.inode != moved.identity)
            {
                let private = self.paths.private.try_clone()?;
                self.capture_projection_file(&a, &private, &previous)?;
                self.paths.verify_parent(&a.target.state.path, &parent)?;
                let _ = fs::rename_new(&self.paths.private, &previous, &parent, &name);
                self.paths.verify_parent(&a.target.state.path, &parent)?;
                return Err(Error::Busy("file changed during displacement; retained"));
            }
        }
        self.point("displaced");
        self.paths.verify_parent(&a.target.state.path, &parent)?;
        // NOREPLACE is atomic. A competing external create is never overwritten.
        if let Err(e) = fs::rename_new(&self.paths.private, &stage, &parent, &name) {
            if file_snapshot(&parent, &name)?.is_some() {
                self.capture_projection_file(&a, &parent, &name)?;
            }
            return Err(e);
        }
        self.paths.verify_parent(&a.target.state.path, &parent)?;
        self.point("published_before_record");
        self.store
            .mark_projection(&a.attempt_id, ProjectionPhase::Published, None)?;
        let final_file =
            file_snapshot(&parent, &name)?.ok_or(Error::Busy("published file disappeared"))?;
        if Some(&final_file.identity) != a.stage_identity.as_ref() {
            self.capture_projection_file(&a, &parent, &name)?;
            return Err(Error::Busy("published path replaced; versions retained"));
        }
        let mut changed = !snapshot_matches_content(&final_file, &a.target.content);
        if changed {
            self.capture_projection_file(&a, &parent, &name)?;
        }
        self.paths.verify()?;
        self.point("before_baseline");
        self.paths.verify_parent(&a.target.state.path, &parent)?;
        let acknowledged = file_snapshot(&parent, &name)?.ok_or(Error::Busy(
            "published file disappeared before acknowledgement",
        ))?;
        if Some(&acknowledged.identity) != a.stage_identity.as_ref() {
            self.capture_projection_file(&a, &parent, &name)?;
            return Err(Error::Busy(
                "published inode replaced before acknowledgement",
            ));
        }
        if !snapshot_matches_content(&acknowledged, &a.target.content) {
            self.capture_projection_file(&a, &parent, &name)?;
            changed = true;
        }
        self.store.finish_projection_bound(
            &a.attempt_id,
            &PhysicalIdentity {
                inode: a
                    .stage_identity
                    .clone()
                    .ok_or(Error::Busy("missing stage identity"))?,
                parent_inode: proof.parent_inode,
            },
        )?;
        self.point("projection_finished");
        let _ = self.retire_settled_previous(&a.attempt_id);
        if changed {
            return Err(Error::Busy("published content externally edited; retained"));
        }
        Ok(())
    }
}
fn new_op() -> OperationId {
    OperationId::new(uuid::Uuid::new_v4().to_string()).unwrap()
}
fn new_id() -> EntryId {
    EntryId::new(uuid::Uuid::new_v4().to_string()).unwrap()
}
