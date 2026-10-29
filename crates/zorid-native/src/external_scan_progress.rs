//! Resumable external inventory. Checkpoints retain metadata, never descriptors
//! or file bodies. Only a fully revalidated inventory can authorize namespace
//! changes; an unfinished batch can expose independently rechecked positives.
use super::external_scan::ExternalSnapshot;
use super::*;
use crate::fs_stream::{stream_snapshot, StreamSnapshot, MAX_STREAM_BYTES};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::MetadataExt,
    time::Instant,
};
use zorid_store::{
    DirectoryCoverage, ExternalScanProof, PhysicalBinding, ScanObservation, ScanObservationKind,
    Sha256Digest,
};

const MAX_INVENTORY: u32 = 100_000;
type Marker = (u64, u64, i64, i64, i64, i64);
fn marker(file: &File) -> Result<Marker> {
    let m = file.metadata()?;
    Ok((
        m.dev(),
        m.ino(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}

#[cfg(test)]
#[path = "external_scan_progress_noop_tests.rs"]
mod noop_tests;
fn corrupt(reason: &str) -> Error {
    zorid_store::StoreError::Corrupt(reason.into()).into()
}
fn proof_path(proof: &ExternalScanProof) -> &VaultPath {
    match proof {
        ExternalScanProof::Present { path, .. }
        | ExternalScanProof::RelocatedAbsent { path, .. } => path,
        ExternalScanProof::Absent { before } => &before.state.path,
    }
}
fn child_path(scope: Option<&VaultPath>, name: &str) -> Result<VaultPath> {
    Ok(VaultPath::new(match scope {
        Some(parent) => format!("{}/{name}", parent.as_str()),
        None => name.into(),
    })?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectoryCursor {
    path: Option<VaultPath>,
    identity: String,
    marker: Marker,
    depth: u16,
    last_name: Option<String>,
    complete: bool,
}
impl DirectoryCursor {
    fn capture(path: Option<VaultPath>, depth: u16, file: &File) -> Result<Self> {
        Ok(Self {
            path,
            identity: fs::identity(file)?,
            marker: marker(file)?,
            depth,
            last_name: None,
            complete: false,
        })
    }
    fn check(&self, file: &File) -> Result<()> {
        if fs::identity(file)? != self.identity || marker(file)? != self.marker {
            return Err(Error::Busy("external inventory directory changed"));
        }
        Ok(())
    }
    fn coverage(&self) -> DirectoryCoverage {
        DirectoryCoverage {
            path: self.path.clone(),
            identity: Some(self.identity.clone()),
            complete: self.complete,
            issue: (!self.complete).then(|| "external inventory directory unfinished".into()),
        }
    }
}

// Only bindings outside exact positive captures can authorize absence or
// relocation. Keep their complete original state, including revision and inode.
fn binding_fences(
    bindings: &[PhysicalBinding],
    proofs: &BTreeMap<VaultPath, ExternalScanProof>,
) -> Vec<PhysicalBinding> {
    let mut fences: Vec<_> = bindings
        .iter()
        .filter(|b| {
            !matches!(proofs.get(&b.state.path),
                Some(ExternalScanProof::Present { entry_kind, physical, .. })
                    if *entry_kind == b.state.kind && physical == &b.physical
            )
        })
        .cloned()
        .collect();
    fences.sort_by(|a, b| a.state.id.cmp(&b.state.id));
    fences
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inventory {
    version: u8,
    scan_id: OperationId,
    root_identity: String,
    private_identity: String,
    database_identity: Option<String>,
    max_depth: u16,
    directories: Vec<DirectoryCursor>,
    next_directory: usize,
    blocked: bool,
    ready: bool,
    #[serde(default)]
    publication_started: bool,
    #[serde(default)]
    reconciliation_issues: Vec<ScanIssue>,
    #[serde(default)]
    namespace_processed: BTreeSet<EntryId>,
    processed: BTreeSet<VaultPath>,
    absence_bindings: Option<Vec<PhysicalBinding>>,
    absence_after: Option<EntryId>,
}
impl Inventory {
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.directories.is_empty()
            || self.directories.len() > MAX_INVENTORY as usize + 1
            || self.next_directory > self.directories.len()
            || self.directories[0].path.is_some()
            || self.directories[0].identity != self.root_identity
            || self.private_identity.is_empty()
            || self.database_identity.as_ref().is_none_or(String::is_empty)
            || self.processed.len() > MAX_INVENTORY as usize
            || self.namespace_processed.len() > MAX_INVENTORY as usize
            || self.publication_started && !self.ready
            || self.reconciliation_issues.len() > MAX_INVENTORY as usize
            || self.ready
                && (self.next_directory != self.directories.len()
                    || self.absence_bindings.is_none())
            || self.absence_after.is_some() && self.absence_bindings.is_none()
            || self.absence_bindings.is_some() && self.next_directory != self.directories.len()
        {
            return Err(corrupt("invalid external inventory cursor"));
        }
        let mut paths = BTreeSet::new();
        let mut identities = BTreeSet::new();
        for (index, directory) in self.directories.iter().enumerate() {
            let depth = directory
                .path
                .as_ref()
                .map_or(0, |p| p.as_str().split('/').count());
            if depth != usize::from(directory.depth)
                || directory.depth > self.max_depth
                || directory.identity != format!("{}:{}", directory.marker.0, directory.marker.1)
                || !paths.insert(directory.path.clone())
                || !identities.insert(directory.identity.clone())
                || directory.complete && index >= self.next_directory
                || index >= self.next_directory
                    && directory.last_name.is_some()
                    && index != self.next_directory
            {
                return Err(corrupt("invalid external inventory directory cursor"));
            }
            if let Some(path) = &directory.path {
                // VaultPath deserialization rejects private root names and dot
                // traversal. Every directory also needs its captured parent.
                if !paths.contains(&path.parent()) {
                    return Err(corrupt("external inventory cursor has no original parent"));
                }
            }
            if let Some(name) = &directory.last_name {
                // This is an ordering fence, never a traversal path. Invalid
                // logical names can still be skipped after a blocked row.
                if name.is_empty()
                    || name.contains('/')
                    || name.contains('\0')
                    || matches!(name.as_str(), "." | "..")
                    || directory.path.is_none() && name.eq_ignore_ascii_case(".zorid")
                {
                    return Err(corrupt("invalid external inventory name cursor"));
                }
            }
        }
        if let Some(fences) = &self.absence_bindings {
            if fences.len() > MAX_INVENTORY as usize
                || fences
                    .windows(2)
                    .any(|pair| pair[0].state.id >= pair[1].state.id)
                || fences
                    .iter()
                    .any(|f| f.physical.inode.is_empty() || f.physical.parent_inode.is_empty())
            {
                return Err(corrupt("invalid external inventory binding fence"));
            }
        }
        Ok(())
    }
    fn authority_matches(&self, vault: &NativeVault) -> Result<bool> {
        vault.paths.verify()?;
        Ok(self.root_identity == fs::identity(&vault.paths.root)?
            && self.private_identity == vault.paths.private_id
            && self.database_identity == vault.paths.db_id)
    }
    fn directory_map(&self) -> BTreeMap<Option<VaultPath>, DirectoryCursor> {
        self.directories
            .iter()
            .map(|d| (d.path.clone(), d.clone()))
            .collect()
    }
}

/// Reopen one original chain with bounded live descriptors. Checking every
/// original ancestor prevents a retained descendant inode from lending authority
/// through a replaced parent. No descriptor survives between calls.
fn open_directory(
    vault: &NativeVault,
    directories: &BTreeMap<Option<VaultPath>, DirectoryCursor>,
    scope: Option<&VaultPath>,
) -> Result<File> {
    vault.paths.verify()?;
    let root = directories
        .get(&None)
        .ok_or_else(|| corrupt("external inventory root missing"))?;
    let mut current = vault.paths.root.try_clone()?;
    root.check(&current)?;
    if let Some(scope) = scope {
        let mut prefix = String::new();
        for part in scope.as_str().split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let path = VaultPath::new(prefix.clone())?;
            let saved = directories
                .get(&Some(path))
                .ok_or_else(|| corrupt("external inventory ancestor missing"))?;
            let child = fs::optional_directory(&current, part)?
                .ok_or(Error::Busy("external inventory directory disappeared"))?;
            saved.check(&child)?;
            current = child;
        }
    }
    root.check(&vault.paths.root)?;
    vault.paths.verify()?;
    Ok(current)
}
fn verify_directories(
    vault: &NativeVault,
    directories: &BTreeMap<Option<VaultPath>, DirectoryCursor>,
) -> Result<()> {
    for scope in directories.keys() {
        open_directory(vault, directories, scope.as_ref())?;
    }
    vault.paths.verify()
}

#[derive(Debug)]
pub(super) struct ProgressScan {
    pub run: ScanRun,
    pub issues: Vec<ScanIssue>,
    pub entries: BTreeMap<VaultPath, ExternalSnapshot>,
    inventory: Inventory,
    directories: BTreeMap<Option<VaultPath>, DirectoryCursor>,
    proofs: BTreeMap<VaultPath, ExternalScanProof>,
    checkpoint_revision: Option<String>,
    active: bool,
}
impl ProgressScan {
    /// A fresh physical baseline invalidates old absence-binding fences. Retire
    /// only this derived cursor BEFORE the binding CAS, so a crash cannot resume
    /// old namespace authority after successful rebinding. History stays intact.
    pub(super) fn discard_for_rebaseline(&mut self, vault: &mut NativeVault) -> Result<()> {
        vault.save_inventory(&mut self.checkpoint_revision, None)?;
        self.active = false;
        Ok(())
    }
    pub(super) fn pending_paths(&self) -> Vec<VaultPath> {
        if !self.active {
            return Vec::new();
        }
        self.proofs
            .iter()
            .filter(|(path, proof)| {
                matches!(proof, ExternalScanProof::Present { .. })
                    && !self.inventory.processed.contains(*path)
            })
            .map(|(path, _)| path.clone())
            .collect()
    }
    pub(super) fn record_processed(
        &mut self,
        vault: &mut NativeVault,
        paths: &[VaultPath],
    ) -> Result<()> {
        self.record_processed_retaining(vault, paths, false)
    }
    pub(super) fn record_processed_retaining(
        &mut self,
        vault: &mut NativeVault,
        paths: &[VaultPath],
        retain: bool,
    ) -> Result<()> {
        if !self.active {
            return if paths.is_empty() {
                Ok(())
            } else {
                Err(Error::Busy("external inventory cursor is no longer active"))
            };
        }
        for path in paths {
            if !matches!(
                self.proofs.get(path),
                Some(ExternalScanProof::Present { .. })
            ) {
                return Err(corrupt("processed external path has no present proof"));
            }
            self.inventory.processed.insert(path.clone());
        }
        if !retain && self.inventory.ready && self.pending_paths().is_empty() {
            vault.save_inventory(&mut self.checkpoint_revision, None)?;
            self.active = false;
        } else {
            vault.save_inventory(&mut self.checkpoint_revision, Some(&self.inventory))?;
        }
        Ok(())
    }
    pub(super) fn active(&self) -> bool {
        self.active
    }
    pub(super) fn publication_started(&self) -> bool {
        self.inventory.publication_started
    }
    pub(super) fn namespace_processed(&self) -> BTreeSet<EntryId> {
        self.inventory.namespace_processed.clone()
    }
    pub(super) fn record_namespace_processed(
        &mut self,
        vault: &mut NativeVault,
        ids: BTreeSet<EntryId>,
    ) -> Result<()> {
        self.inventory.namespace_processed = ids;
        vault.save_inventory(&mut self.checkpoint_revision, Some(&self.inventory))
    }
    pub(super) fn retained_issues(&self) -> &[ScanIssue] {
        &self.inventory.reconciliation_issues
    }
    pub(super) fn retain_issues(
        &mut self,
        vault: &mut NativeVault,
        issues: &[ScanIssue],
    ) -> Result<()> {
        for issue in issues {
            if !self
                .inventory
                .reconciliation_issues
                .iter()
                .any(|old| old.path == issue.path && old.reason == issue.reason)
            {
                self.inventory.reconciliation_issues.push(issue.clone());
            }
        }
        vault.save_inventory(&mut self.checkpoint_revision, Some(&self.inventory))
    }
    pub(super) fn begin_publication(&mut self, vault: &mut NativeVault) -> Result<()> {
        if !self.run.complete || !self.pending_paths().is_empty() {
            return Err(Error::Busy(
                "unfinished external inventory cannot enter publication",
            ));
        }
        self.inventory.publication_started = true;
        vault.save_inventory(&mut self.checkpoint_revision, Some(&self.inventory))
    }
    pub(super) fn retire(&mut self, vault: &mut NativeVault) -> Result<()> {
        vault.save_inventory(&mut self.checkpoint_revision, None)?;
        self.active = false;
        Ok(())
    }
    pub(super) fn revalidate(&self, vault: &NativeVault) -> Result<()> {
        if !self.run.finished || !self.run.complete {
            return Err(Error::Busy(
                "unfinished external inventory has no namespace authority",
            ));
        }
        if vault.store.scan_run(&self.run.scan_id)? != self.run
            || !self.inventory.authority_matches(vault)?
        {
            return Err(Error::Busy("external inventory authority changed"));
        }
        verify_directories(vault, &self.directories)
    }
    pub(super) fn confirm_absent(&self, vault: &NativeVault, path: &VaultPath) -> Result<bool> {
        self.revalidate(vault)?;
        if self.entries.contains_key(path) || !self.directories.contains_key(&path.parent()) {
            return Ok(false);
        }
        let parent = open_directory(vault, &self.directories, path.parent().as_ref())?;
        let absent = fs::node_type(&parent, path.file_name())?.is_none();
        open_directory(vault, &self.directories, path.parent().as_ref())?;
        Ok(absent)
    }
    /// Positive imports are local facts, so they can be checked while the full
    /// inventory remains unfinished. Both directory marker and exact immutable
    /// present proof must still match; no global absence is inferred.
    pub(super) fn confirm_snapshot(&self, vault: &NativeVault, path: &VaultPath) -> Result<bool> {
        if !self.inventory.authority_matches(vault)? {
            return Err(Error::Busy("external inventory authority changed"));
        }
        let Some(snapshot) = self.entries.get(path) else {
            return Ok(false);
        };
        let Some(proof) = self.proofs.get(path) else {
            return Err(corrupt("external inventory positive proof missing"));
        };
        let parent = open_directory(vault, &self.directories, path.parent().as_ref())?;
        let same = if snapshot.kind == EntryKind::File {
            self.file_snapshot(vault, path)?.is_some()
        } else {
            let Some(child) = fs::optional_directory(&parent, path.file_name())? else {
                return Ok(false);
            };
            let physical = PhysicalIdentity {
                inode: fs::identity(&child)?,
                parent_inode: fs::identity(&parent)?,
            };
            *proof == ExternalScanProof::present(path.clone(), EntryKind::Folder, physical, None)
        };
        open_directory(vault, &self.directories, path.parent().as_ref())?;
        Ok(same)
    }
    /// Return only immutable byte evidence and strict text facts. Import callers
    /// capture typed content separately; inventory discovery never stages it.
    pub(super) fn file_snapshot(
        &self,
        vault: &NativeVault,
        path: &VaultPath,
    ) -> Result<Option<StreamSnapshot>> {
        if !self.inventory.authority_matches(vault)? {
            return Err(Error::Busy("external inventory authority changed"));
        }
        let Some(ExternalScanProof::Present {
            entry_kind: EntryKind::File,
            content_bytes,
            ..
        }) = self.proofs.get(path)
        else {
            return Ok(None);
        };
        let parent = open_directory(vault, &self.directories, path.parent().as_ref())?;
        if *content_bytes > MAX_STREAM_BYTES {
            return Err(Error::Unsupported("external inventory file exceeds 64 MiB"));
        }
        // A changed size is an ordinary mismatch, not permission to recapture.
        let Some(file) = fs::regular(&parent, path.file_name())? else {
            return Ok(None);
        };
        if file.metadata()?.len() != *content_bytes {
            return Ok(None);
        }
        drop(file);
        let Some(disk) = stream_snapshot(&parent, path.file_name(), MAX_STREAM_BYTES, |_| Ok(()))?
        else {
            return Ok(None);
        };
        let proof = ExternalScanProof::present_from_digest(
            path.clone(),
            EntryKind::File,
            PhysicalIdentity {
                inode: disk.identity.clone(),
                parent_inode: disk.parent_identity.clone(),
            },
            disk.length,
            Some(Sha256Digest(disk.digest)),
        );
        open_directory(vault, &self.directories, path.parent().as_ref())?;
        if self.proofs.get(path) != Some(&proof) {
            return Ok(None);
        }
        Ok(Some(disk))
    }
}

impl NativeVault {
    fn save_inventory(
        &mut self,
        revision: &mut Option<String>,
        inventory: Option<&Inventory>,
    ) -> Result<()> {
        self.paths.verify()?;
        *revision = Some(
            self.store
                .save_external_scan_progress(revision.as_deref(), inventory)?,
        );
        self.paths.verify()
    }
    fn progress_result(
        &self,
        inventory: Inventory,
        issues: Vec<ScanIssue>,
        checkpoint_revision: Option<String>,
        active: bool,
    ) -> Result<ProgressScan> {
        let run = self.store.scan_run(&inventory.scan_id)?;
        let mut proofs = BTreeMap::new();
        for proof in self.store.external_scan_proofs(&inventory.scan_id)? {
            if proofs.insert(proof_path(&proof).clone(), proof).is_some() {
                return Err(corrupt("duplicate external inventory proof"));
            }
        }
        let rows: BTreeMap<_, _> = self
            .store
            .scan_observations(&inventory.scan_id)?
            .into_iter()
            .map(|row| (row.path.clone(), row))
            .collect();
        // Observation persistence precedes immutable proof persistence. A proof
        // without its exact positive row cannot be an interrupted valid capture.
        for (path, proof) in &proofs {
            if let ExternalScanProof::Present {
                entry_kind,
                physical,
                ..
            } = proof
            {
                let Some(row) = rows.get(path) else {
                    return Err(corrupt(
                        "external inventory present proof has no observation",
                    ));
                };
                let expected = if *entry_kind == EntryKind::File {
                    ScanObservationKind::File
                } else {
                    ScanObservationKind::Directory
                };
                if row.kind != expected
                    || row.identity.as_ref() != Some(&physical.inode)
                    || row.issue.is_some()
                {
                    return Err(corrupt(
                        "external inventory present proof differs from observation",
                    ));
                }
            }
        }
        let mut entries = BTreeMap::new();
        for row in rows.into_values() {
            if !active || !run.complete && inventory.processed.contains(&row.path) {
                continue;
            }
            if !matches!(
                row.kind,
                ScanObservationKind::File | ScanObservationKind::Directory
            ) {
                continue;
            }
            let Some(ExternalScanProof::Present {
                entry_kind,
                physical,
                ..
            }) = proofs.get(&row.path)
            else {
                if !run.finished {
                    continue;
                } // Crash between row and immutable-proof commit; replay repairs it.
                return Err(corrupt(
                    "external inventory observation has no present proof",
                ));
            };
            if row.identity.as_ref() != Some(&physical.inode)
                || (row.kind == ScanObservationKind::File) != (*entry_kind == EntryKind::File)
                || row.issue.is_some()
            {
                return Err(corrupt("external inventory observation differs from proof"));
            }
            entries.insert(
                row.path,
                ExternalSnapshot {
                    kind: *entry_kind,
                    identity: physical.inode.clone(),
                    parent_identity: physical.parent_inode.clone(),
                    bytes: None,
                },
            );
        }
        let directories = inventory.directory_map();
        if inventory
            .processed
            .iter()
            .any(|path| !matches!(proofs.get(path), Some(ExternalScanProof::Present { .. })))
        {
            return Err(corrupt(
                "external processed cursor has no immutable present proof",
            ));
        }
        Ok(ProgressScan {
            run,
            issues,
            entries,
            inventory,
            directories,
            proofs,
            checkpoint_revision,
            active,
        })
    }
    fn invalidate_inventory(
        &mut self,
        inventory: Inventory,
        revision: &mut Option<String>,
        reason: &str,
    ) -> Result<ProgressScan> {
        self.paths.verify()?;
        self.store
            .finish_scan(&inventory.scan_id, false, Some(reason.into()))?;
        self.save_inventory(revision, None)?;
        self.progress_result(
            inventory,
            vec![ScanIssue {
                path: None,
                reason: reason.into(),
            }],
            revision.clone(),
            false,
        )
    }
    fn new_inventory(
        &mut self,
        options: &ScanOptions,
        revision: &mut Option<String>,
    ) -> Result<Inventory> {
        let root = DirectoryCursor::capture(None, 0, &self.paths.root)?;
        let run = self.store.begin_scan(MAX_INVENTORY)?;
        self.store
            .record_directory_coverage(&run.scan_id, &root.coverage())?;
        let inventory = Inventory {
            version: 1,
            scan_id: run.scan_id,
            root_identity: root.identity.clone(),
            private_identity: self.paths.private_id.clone(),
            database_identity: self.paths.db_id.clone(),
            max_depth: options.max_depth,
            directories: vec![root],
            next_directory: 0,
            blocked: false,
            ready: false,
            publication_started: false,
            reconciliation_issues: Vec::new(),
            namespace_processed: BTreeSet::new(),
            processed: BTreeSet::new(),
            absence_bindings: None,
            absence_after: None,
        };
        self.save_inventory(revision, Some(&inventory))?;
        self.point("external_scan_started");
        Ok(inventory)
    }
    /// Caller holds the outer native lock. Entry, byte and duration limits bound
    /// this batch; the persistent inventory itself is capped at 100000 entries.
    /// Final global marker verification is one bounded safety step and may exceed
    /// the soft duration budget; this is not hard I/O cancellation.
    pub(super) fn external_progress_scan_locked(
        &mut self,
        options: ScanOptions,
    ) -> Result<ProgressScan> {
        self.external_progress_scan_with_budget(options, None)
    }
    pub(super) fn external_progress_scan_with_budget(
        &mut self,
        options: ScanOptions,
        mut budget: Option<&mut super::external_scan_quantum::ExternalWorkBudget>,
    ) -> Result<ProgressScan> {
        if options.max_entries == 0 || options.max_entries > MAX_INVENTORY {
            return Err(Error::Unsupported("scan max_entries must be 1..=100000"));
        }
        self.paths.verify()?;
        let started = Instant::now();
        let (mut revision, loaded) = self.store.external_scan_progress::<Inventory>()?;
        let mut inventory = if let Some(inventory) = loaded {
            inventory.validate()?;
            let run = self.store.scan_run(&inventory.scan_id)?;
            if run.max_entries != MAX_INVENTORY {
                return Err(corrupt("external inventory scan bound mismatch"));
            }
            if inventory.ready {
                if !run.finished || !run.complete {
                    return Err(corrupt("ready external inventory has no complete run"));
                }
                // Publication has exact per-attempt guards. Its own filesystem
                // changes invalidate directory markers, so this cursor grants
                // no further absence authority once publication has begun.
                if budget.is_none() && inventory.publication_started {
                    // A legacy caller cannot reuse the historical absence
                    // proof after publication has changed the filesystem.
                    self.external_publication = None;
                    self.save_inventory(&mut revision, None)?;
                    return self.external_progress_scan_locked(options);
                }
                if budget.is_some() && inventory.publication_started {
                    if !inventory.authority_matches(self)? {
                        return Err(Error::Busy("external publication authority changed"));
                    }
                    return self.progress_result(inventory, Vec::new(), revision, true);
                }
                let valid =
                    inventory.authority_matches(self)? && inventory.max_depth == options.max_depth;
                let checked = if valid {
                    verify_directories(self, &inventory.directory_map())
                } else {
                    Err(Error::Busy("ready external inventory authority changed"))
                };
                match checked {
                    Ok(()) => return self.progress_result(inventory, Vec::new(), revision, true),
                    Err(error) => {
                        self.paths.verify()?;
                        if !matches!(error, Error::Busy(_) | Error::UnsafePath(_) | Error::Io(_)) {
                            return Err(error);
                        }
                        self.save_inventory(&mut revision, None)?;
                        self.new_inventory(&options, &mut revision)?
                    }
                }
            } else if run.finished {
                // A crash after finish but before the Ready CAS has no reusable
                // authority. Start fresh instead of mixing captures and proofs.
                self.save_inventory(&mut revision, None)?;
                self.new_inventory(&options, &mut revision)?
            } else if !inventory.authority_matches(self)?
                || inventory.max_depth != options.max_depth
            {
                return self.invalidate_inventory(
                    inventory,
                    &mut revision,
                    "external inventory authority or depth changed",
                );
            } else {
                inventory
            }
        } else {
            self.new_inventory(&options, &mut revision)?
        };
        if let Err(error) = inventory.directories[0].check(&self.paths.root) {
            self.paths.verify()?;
            if !matches!(error, Error::Busy(_) | Error::Io(_)) {
                return Err(error);
            }
            return self.invalidate_inventory(
                inventory,
                &mut revision,
                "external inventory root marker changed",
            );
        }
        let mut directories = inventory.directory_map();
        let mut proofs: BTreeMap<_, _> = self
            .store
            .external_scan_proofs(&inventory.scan_id)?
            .into_iter()
            .map(|p| (proof_path(&p).clone(), p))
            .collect();
        if proofs.iter().any(|(path, proof)| {
            matches!(proof, ExternalScanProof::Present { .. })
                && !inventory.processed.contains(path)
        }) {
            return self.progress_result(
                inventory,
                vec![ScanIssue {
                    path: None,
                    reason: "external inventory has pending positive imports".into(),
                }],
                revision,
                true,
            );
        }
        let mut observed_paths: BTreeSet<_> = self
            .store
            .scan_observations(&inventory.scan_id)?
            .into_iter()
            .map(|row| row.path)
            .collect();
        let mut issues = Vec::new();
        let mut work = 0u32;
        let mut total_bytes = 0u64;
        let mut stopped = false;
        while inventory.next_directory < inventory.directories.len() {
            if work >= options.max_entries
                || budget.as_ref().map_or_else(
                    || started.elapsed() >= options.max_duration,
                    |b| !b.available(),
                )
            {
                stopped = true;
                break;
            }
            // Persist every newly admitted directory marker before enumerating
            // descendants. A crash cannot forget its original marker while
            // retaining descendant observations/proofs.
            self.save_inventory(&mut revision, Some(&inventory))?;
            let index = inventory.next_directory;
            let saved = inventory.directories[index].clone();
            let directory = match open_directory(self, &directories, saved.path.as_ref()) {
                Ok(directory) => directory,
                Err(error) => {
                    self.paths.verify()?;
                    if matches!(error, Error::Busy(_) | Error::UnsafePath(_) | Error::Io(_)) {
                        return self.invalidate_inventory(
                            inventory,
                            &mut revision,
                            "external inventory original directory changed",
                        );
                    }
                    return Err(error);
                }
            };
            self.point("external_scan_directory_opened");
            let names =
                match fs::directory_names(&directory, MAX_INVENTORY as usize, saved.path.is_none())
                {
                    Ok(names) => names,
                    Err(error) => {
                        self.paths.verify()?;
                        if !matches!(
                            error,
                            Error::Busy(_)
                                | Error::UnsafePath(_)
                                | Error::Unsupported(_)
                                | Error::Io(_)
                        ) {
                            return Err(error);
                        }
                        if budget
                            .as_mut()
                            .is_some_and(|b| !b.try_unit(format!("directory-error:{index}")))
                        {
                            stopped = true;
                            break;
                        }
                        inventory.blocked = true;
                        issues.push(ScanIssue {
                            path: saved.path.clone(),
                            reason: error.to_string(),
                        });
                        inventory.next_directory += 1;
                        continue;
                    }
                };
            let mut directory_complete = true;
            for name in names
                .into_iter()
                .filter(|name| saved.last_name.as_ref().is_none_or(|last| name > last))
            {
                if work >= options.max_entries
                    || budget.as_ref().map_or_else(
                        || started.elapsed() >= options.max_duration,
                        |b| !b.available(),
                    )
                {
                    directory_complete = false;
                    stopped = true;
                    break;
                }
                let path = match child_path(saved.path.as_ref(), &name) {
                    Ok(path) => path,
                    Err(error) => {
                        if budget
                            .as_mut()
                            .is_some_and(|b| !b.try_unit(format!("invalid-entry:{index}:{name}")))
                        {
                            directory_complete = false;
                            stopped = true;
                            break;
                        }
                        inventory.blocked = true;
                        work += 1;
                        issues.push(ScanIssue {
                            path: saved.path.clone(),
                            reason: error.to_string(),
                        });
                        inventory.directories[index].last_name = Some(name);
                        continue;
                    }
                };
                if budget.as_mut().is_some_and(|b| !b.capture_positive(&path)) {
                    directory_complete = false;
                    stopped = true;
                    break;
                }
                if self.store.scan_run(&inventory.scan_id)?.observed >= MAX_INVENTORY
                    && !observed_paths.contains(&path)
                {
                    return self.invalidate_inventory(
                        inventory,
                        &mut revision,
                        "external inventory entry bound exhausted",
                    );
                }
                let captured = (|| -> Result<Option<(ExternalSnapshot, ExternalScanProof, Option<DirectoryCursor>)>> {
                    saved.check(&directory)?;
                    let (kind, identity, content_bytes, content_digest, child) = match fs::node_type(&directory, &name)? {
                        Some(rustix::fs::FileType::RegularFile) => {
                            let file = fs::regular(&directory, &name)?.ok_or(Error::Busy("external inventory file disappeared"))?;
                            let length = file.metadata()?.len();
                            drop(file);
                            if length > MAX_STREAM_BYTES { return Err(Error::Unsupported("external inventory file exceeds 64 MiB")); }
                            let remaining = options.max_total_bytes.saturating_sub(total_bytes);
                            if length > remaining { return Ok(None); }
                            // Admit by metadata before reading, then finish this bounded
                            // file even if the soft duration expires during its capture.
                            let disk = stream_snapshot(&directory, &name, remaining.min(MAX_STREAM_BYTES), |_| Ok(()))?.ok_or(Error::Busy("external inventory file disappeared"))?;
                            if disk.parent_identity != saved.identity { return Err(Error::Busy("external inventory file parent changed")); }
                            (EntryKind::File, disk.identity, disk.length, Some(Sha256Digest(disk.digest)), None)
                        }
                        Some(rustix::fs::FileType::Directory) => {
                            if saved.depth >= inventory.max_depth { return Err(Error::Unsupported("external inventory depth bound exhausted")); }
                            let child = fs::optional_directory(&directory, &name)?.ok_or(Error::Busy("external inventory directory disappeared"))?;
                            let cursor = DirectoryCursor::capture(Some(path.clone()), saved.depth + 1, &child)?;
                            if directories.values().any(|known| known.identity == cursor.identity && known.path != cursor.path) {
                                return Err(Error::UnsafePath("external inventory directory inode is aliased".into()));
                            }
                            (EntryKind::Folder, cursor.identity.clone(), 0, None, Some(cursor))
                        }
                        _ => return Err(Error::UnsafePath("external inventory entry is missing, linked or unsupported".into())),
                    };
                    saved.check(&directory)?;
                    let proof = ExternalScanProof::present_from_digest(path.clone(), kind, PhysicalIdentity { inode: identity.clone(), parent_inode: saved.identity.clone() }, content_bytes, content_digest);
                    let snapshot = ExternalSnapshot { kind, identity, parent_identity: saved.identity.clone(), bytes: None };
                    total_bytes += content_bytes;
                    Ok(Some((snapshot, proof, child)))
                })();
                match captured {
                    Ok(None) => {
                        directory_complete = false;
                        stopped = true;
                        break;
                    }
                    Ok(Some((snapshot, proof, child))) => {
                        if proofs.get(&path).is_some_and(|previous| previous != &proof) {
                            return self.invalidate_inventory(
                                inventory,
                                &mut revision,
                                "external inventory replay differs from immutable proof",
                            );
                        }
                        self.store.record_scan_observation(
                            &inventory.scan_id,
                            &ScanObservation {
                                path: path.clone(),
                                kind: if snapshot.kind == EntryKind::File {
                                    ScanObservationKind::File
                                } else {
                                    ScanObservationKind::Directory
                                },
                                entry: None,
                                baseline_revision: None,
                                identity: Some(snapshot.identity),
                                imported: false,
                                issue: None,
                            },
                        )?;
                        self.store
                            .record_external_scan_proof(&inventory.scan_id, &proof)?;
                        observed_paths.insert(path.clone());
                        proofs.insert(path.clone(), proof);
                        if let Some(child) = child {
                            if !directories.contains_key(&Some(path.clone())) {
                                self.store.record_directory_coverage(
                                    &inventory.scan_id,
                                    &child.coverage(),
                                )?;
                                directories.insert(Some(path.clone()), child.clone());
                                inventory.directories.push(child);
                            }
                        }
                    }
                    Err(error) => {
                        self.paths.verify()?;
                        if proofs.contains_key(&path) {
                            return self.invalidate_inventory(
                                inventory,
                                &mut revision,
                                "external inventory replay no longer matches capture",
                            );
                        }
                        if !matches!(
                            error,
                            Error::Busy(_)
                                | Error::UnsafePath(_)
                                | Error::Unsupported(_)
                                | Error::Io(_)
                        ) {
                            return Err(error);
                        }
                        inventory.blocked = true;
                        let reason = error.to_string();
                        self.store.record_scan_observation(
                            &inventory.scan_id,
                            &ScanObservation {
                                path: path.clone(),
                                kind: ScanObservationKind::Blocked,
                                entry: None,
                                baseline_revision: None,
                                identity: None,
                                imported: false,
                                issue: Some(reason.clone()),
                            },
                        )?;
                        observed_paths.insert(path.clone());
                        issues.push(ScanIssue {
                            path: Some(path),
                            reason,
                        });
                    }
                }
                inventory.directories[index].last_name = Some(name);
                work += 1;
            }
            if let Err(error) = saved
                .check(&directory)
                .and_then(|()| open_directory(self, &directories, saved.path.as_ref()).map(|_| ()))
            {
                self.paths.verify()?;
                if !matches!(error, Error::Busy(_) | Error::UnsafePath(_) | Error::Io(_)) {
                    return Err(error);
                }
                return self.invalidate_inventory(
                    inventory,
                    &mut revision,
                    "external inventory directory changed during batch",
                );
            }
            if directory_complete {
                inventory.directories[index].complete = true;
                self.store.record_directory_coverage(
                    &inventory.scan_id,
                    &inventory.directories[index].coverage(),
                )?;
                inventory.next_directory += 1;
            }
            if stopped {
                break;
            }
        }
        if inventory.next_directory == inventory.directories.len() && !stopped {
            if inventory.blocked
                && proofs.iter().any(|(path, proof)| {
                    matches!(proof, ExternalScanProof::Present { .. })
                        && !inventory.processed.contains(path)
                })
            {
                self.save_inventory(&mut revision, Some(&inventory))?;
                issues.push(ScanIssue {
                    path: None,
                    reason: "external inventory has pending positive imports".into(),
                });
                return self.progress_result(inventory, issues, revision, true);
            }
            if inventory.blocked {
                self.store.finish_scan(
                    &inventory.scan_id,
                    false,
                    Some("external inventory contains blocked paths".into()),
                )?;
                self.save_inventory(&mut revision, None)?;
                if issues.is_empty() {
                    issues.push(ScanIssue {
                        path: None,
                        reason: "external inventory contains blocked paths".into(),
                    });
                }
                return self.progress_result(inventory, issues, revision, false);
            }
            let mut bindings = self.store.physical_bindings()?;
            bindings.sort_by(|a, b| a.state.id.cmp(&b.state.id));
            let fences = binding_fences(&bindings, &proofs);
            if inventory
                .absence_bindings
                .as_ref()
                .is_some_and(|original| original != &fences)
            {
                return self.invalidate_inventory(
                    inventory,
                    &mut revision,
                    "external inventory bindings changed during absence capture",
                );
            }
            if inventory.absence_bindings.is_none() {
                inventory.absence_bindings = Some(fences);
                self.save_inventory(&mut revision, Some(&inventory))?;
            }
            let after = inventory.absence_after.clone();
            for binding in bindings
                .into_iter()
                .filter(|b| after.as_ref().is_none_or(|id| &b.state.id > id))
            {
                if work >= options.max_entries
                    || budget.as_ref().map_or_else(
                        || started.elapsed() >= options.max_duration,
                        |b| !b.available(),
                    )
                {
                    stopped = true;
                    break;
                }
                if budget
                    .as_mut()
                    .is_some_and(|b| !b.try_unit(format!("absence:{}", binding.state.id.as_str())))
                {
                    stopped = true;
                    break;
                }
                let binding_id = binding.state.id.clone();
                if !proofs.contains_key(&binding.state.path) {
                    let original_scope = binding.state.path.parent();
                    let parent = directories
                        .get(&original_scope)
                        .filter(|d| d.identity == binding.physical.parent_inode)
                        .or_else(|| {
                            directories
                                .values()
                                .find(|d| d.identity == binding.physical.parent_inode)
                        });
                    if let Some(parent) = parent {
                        let observed =
                            child_path(parent.path.as_ref(), binding.state.path.file_name())?;
                        if !proofs.contains_key(&observed) {
                            let directory =
                                match open_directory(self, &directories, parent.path.as_ref()) {
                                    Ok(directory) => directory,
                                    Err(error) => {
                                        self.paths.verify()?;
                                        if !matches!(
                                            error,
                                            Error::Busy(_) | Error::UnsafePath(_) | Error::Io(_)
                                        ) {
                                            return Err(error);
                                        }
                                        return self.invalidate_inventory(
                                            inventory,
                                            &mut revision,
                                            "external inventory absence parent changed",
                                        );
                                    }
                                };
                            if fs::node_type(&directory, observed.file_name())?.is_some() {
                                return self.invalidate_inventory(
                                    inventory,
                                    &mut revision,
                                    "external inventory absence path changed",
                                );
                            }
                            if parent.check(&directory).is_err() {
                                return self.invalidate_inventory(
                                    inventory,
                                    &mut revision,
                                    "external inventory absence parent changed during capture",
                                );
                            }
                            if proofs.len() >= MAX_INVENTORY as usize {
                                return self.invalidate_inventory(
                                    inventory,
                                    &mut revision,
                                    "external inventory proof bound exhausted",
                                );
                            }
                            let proof = if observed == binding.state.path {
                                ExternalScanProof::Absent { before: binding }
                            } else {
                                ExternalScanProof::RelocatedAbsent {
                                    before: binding,
                                    path: observed.clone(),
                                }
                            };
                            self.store
                                .record_external_scan_proof(&inventory.scan_id, &proof)?;
                            proofs.insert(observed, proof);
                        }
                    }
                }
                inventory.absence_after = Some(binding_id);
                work += 1;
            }
            if !stopped {
                self.point("external_scan_before_finalize");
                self.point("external_scan_before_finish");
                // One admitted bounded step: splitting this across calls would
                // grant global authority without checking all original markers.
                if let Err(error) = verify_directories(self, &directories) {
                    self.paths.verify()?;
                    if !matches!(error, Error::Busy(_) | Error::UnsafePath(_) | Error::Io(_)) {
                        return Err(error);
                    }
                    return self.invalidate_inventory(
                        inventory,
                        &mut revision,
                        "external inventory changed before completion",
                    );
                }
                if binding_fences(&self.store.physical_bindings()?, &proofs)
                    != inventory.absence_bindings.clone().unwrap_or_default()
                {
                    return self.invalidate_inventory(
                        inventory,
                        &mut revision,
                        "external inventory bindings changed before completion",
                    );
                }
                self.store.finish_scan(&inventory.scan_id, true, None)?;
                self.paths.verify()?;
                // Retry every positive once with full namespace authority:
                // unfinished passes may have deferred moved-owner/parent work.
                // Ready resumes retain acknowledgments to ensure finite work.
                inventory.processed.clear();
                inventory.ready = true;
                self.save_inventory(&mut revision, Some(&inventory))?;
                return self.progress_result(inventory, issues, revision, true);
            }
        }
        self.paths.verify()?;
        self.save_inventory(&mut revision, Some(&inventory))?;
        issues.push(ScanIssue {
            path: None,
            reason: "external inventory batch limit reached; resume this scan on the next rescan"
                .into(),
        });
        self.progress_result(inventory, issues, revision, true)
    }
}
