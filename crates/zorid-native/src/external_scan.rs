//! Read-only physical discovery for external namespace reconciliation.
//! Scan ledger writes are the only durable effects. A completed scan is not an
//! import, a projection acknowledgment, or a deletion/move decision.
use super::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::MetadataExt,
    time::Instant,
};
use zorid_store::{DirectoryCoverage, ExternalScanProof, ScanObservation, ScanObservationKind};

// Retain original descriptors for final binding checks without exhausting the
// process descriptor budget on a deeply/widely nested vault.
const MAX_HELD_DIRECTORIES: usize = 256;
type Marker = (u64, u64, i64, i64, i64, i64);
fn marker(directory: &File) -> Result<Marker> {
    let m = directory.metadata()?;
    Ok((
        m.dev(),
        m.ino(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
#[derive(Debug)]
struct HeldDirectory {
    file: File,
    identity: String,
    marker: Marker,
}
impl HeldDirectory {
    fn capture(file: File) -> Result<Self> {
        Ok(Self {
            identity: fs::identity(&file)?,
            marker: marker(&file)?,
            file,
        })
    }
    fn verify(&self, vault: &NativeVault, path: Option<&VaultPath>) -> Result<()> {
        vault.paths.verify()?;
        let current = match path {
            Some(path) => vault.paths.directory(path)?,
            None => vault.paths.root.try_clone()?,
        };
        if fs::identity(&current)? != self.identity
            || marker(&self.file)? != self.marker
            || marker(&current)? != self.marker
        {
            return Err(Error::Busy("external scan directory changed"));
        }
        Ok(())
    }
}
#[derive(Debug)]
pub(super) struct ExternalSnapshot {
    pub kind: EntryKind,
    pub identity: String,
    pub parent_identity: String,
    /// None for directories, including a complete empty file as Some(vec![]).
    pub bytes: Option<Vec<u8>>,
}
#[derive(Debug)]
pub(super) struct ExternalScan {
    pub run: ScanRun,
    pub issues: Vec<ScanIssue>,
    pub entries: BTreeMap<VaultPath, ExternalSnapshot>,
    directories: BTreeMap<Option<VaultPath>, HeldDirectory>,
}
impl ExternalScan {
    /// Call before preparing namespace changes. In-place content changes do not
    /// change directory markers; confirm_snapshot must additionally check bytes.
    pub(super) fn revalidate(&self, vault: &NativeVault) -> Result<()> {
        if !self.run.finished || !self.run.complete {
            return Err(Error::Busy(
                "incomplete external scan has no namespace authority",
            ));
        }
        if vault.store.scan_run(&self.run.scan_id)? != self.run {
            return Err(Error::Busy(
                "external scan no longer matches its durable run",
            ));
        }
        self.verify_directories(vault)
    }
    fn verify_directories(&self, vault: &NativeVault) -> Result<()> {
        for (path, held) in &self.directories {
            held.verify(vault, path.as_ref())?;
        }
        Ok(())
    }
    /// Absence requires the original, completely enumerated immediate parent.
    /// A missing ancestor is never translated into a missing descendant.
    pub(super) fn confirm_absent(&self, vault: &NativeVault, path: &VaultPath) -> Result<bool> {
        self.revalidate(vault)?;
        if self.entries.contains_key(path) {
            return Ok(false);
        }
        let Some(parent) = self.directories.get(&path.parent()) else {
            return Ok(false);
        };
        let absent = fs::node_type(&parent.file, path.file_name())?.is_none();
        parent.verify(vault, path.parent().as_ref())?;
        Ok(absent)
    }
    /// Recheck the exact captured physical entry, without updating its baseline.
    pub(super) fn confirm_snapshot(&self, vault: &NativeVault, path: &VaultPath) -> Result<bool> {
        self.revalidate(vault)?;
        let Some(snapshot) = self.entries.get(path) else {
            return Ok(false);
        };
        let Some(parent) = self.directories.get(&path.parent()) else {
            return Ok(false);
        };
        if parent.identity != snapshot.parent_identity {
            return Ok(false);
        }
        let same = match snapshot.kind {
            EntryKind::File => match fs::snapshot(
                &parent.file,
                path.file_name(),
                snapshot.bytes.as_ref().map_or(0, Vec::len),
            )? {
                Some(current) => {
                    current.identity == snapshot.identity
                        && Some(&current.bytes) == snapshot.bytes.as_ref()
                }
                None => false,
            },
            EntryKind::Folder => match fs::optional_directory(&parent.file, path.file_name())? {
                Some(current) => fs::identity(&current)? == snapshot.identity,
                None => false,
            },
        };
        parent.verify(vault, path.parent().as_ref())?;
        Ok(same)
    }
}
impl NativeVault {
    /// Caller holds the native vault lock for this scan and subsequent matching.
    /// No recovery/import/projection runs here. Filesystem errors or exhausted
    /// budgets produce incomplete coverage; storage failures may leave an
    /// unfinished durable scan, which likewise cannot authorize namespace work.
    pub(super) fn external_scan_locked(&mut self, options: ScanOptions) -> Result<ExternalScan> {
        if options.max_entries == 0 || options.max_entries > 100_000 {
            return Err(Error::Unsupported("scan max_entries must be 1..=100000"));
        }
        self.paths.verify()?;
        let run = self.store.begin_scan(options.max_entries)?;
        let id = run.scan_id.clone();
        let started = Instant::now();
        let mut scan = ExternalScan {
            run,
            issues: Vec::new(),
            entries: BTreeMap::new(),
            directories: BTreeMap::new(),
        };
        self.store.record_directory_coverage(
            &id,
            &DirectoryCoverage {
                path: None,
                identity: None,
                complete: false,
                issue: Some("external scan not finished".into()),
            },
        )?;
        let root = HeldDirectory::capture(self.paths.root.try_clone()?)?;
        let mut identities = BTreeSet::from([root.identity.clone()]);
        scan.directories.insert(None, root);
        let mut stack = vec![(None::<VaultPath>, 0u16)];
        let mut observed = 0u32;
        let mut total_bytes = 0u64;
        let mut stopped = false;
        self.point("external_scan_started");
        while let Some((scope, depth)) = stack.pop() {
            if started.elapsed() >= options.max_duration {
                scan.issues.push(ScanIssue {
                    path: scope,
                    reason: "external scan duration budget exhausted".into(),
                });
                stopped = true;
                break;
            }
            // Temporarily remove this descriptor so children can be inserted
            // without aliasing the original directory snapshot.
            let directory = scan
                .directories
                .remove(&scope)
                .expect("queued scan directory");
            self.point("external_scan_directory_opened");
            let names = directory.verify(self, scope.as_ref()).and_then(|()| {
                fs::directory_names(
                    &directory.file,
                    (options.max_entries - observed) as usize,
                    scope.is_none(),
                )
            });
            let mut complete = true;
            match names {
                Err(error) => {
                    complete = false;
                    scan.issues.push(ScanIssue {
                        path: scope.clone(),
                        reason: error.to_string(),
                    });
                }
                Ok(names) => {
                    for name in names {
                        if observed >= options.max_entries
                            || started.elapsed() >= options.max_duration
                        {
                            complete = false;
                            stopped = true;
                            scan.issues.push(ScanIssue {
                                path: scope.clone(),
                                reason: "external scan entry or duration budget exhausted".into(),
                            });
                            break;
                        }
                        observed += 1;
                        let relative = match &scope {
                            Some(path) => format!("{}/{name}", path.as_str()),
                            None => name.clone(),
                        };
                        let path = match VaultPath::new(relative) {
                            Ok(path) => path,
                            Err(error) => {
                                complete = false;
                                scan.issues.push(ScanIssue {
                                    path: scope.clone(),
                                    reason: error.to_string(),
                                });
                                continue;
                            }
                        };
                        let captured = (|| -> Result<(ExternalSnapshot, Option<HeldDirectory>)> {
                            directory.verify(self, scope.as_ref())?;
                            match fs::node_type(&directory.file, &name)? {
                                Some(rustix::fs::FileType::RegularFile) => {
                                    let remaining =
                                        options.max_total_bytes.saturating_sub(total_bytes);
                                    let limit = self
                                        .options
                                        .max_file_bytes
                                        .min(usize::try_from(remaining).unwrap_or(usize::MAX));
                                    let file = fs::snapshot(&directory.file, &name, limit)?.ok_or(
                                        Error::Busy("external file disappeared during scan"),
                                    )?;
                                    total_bytes = total_bytes
                                        .checked_add(file.bytes.len() as u64)
                                        .ok_or(Error::Unsupported("scan byte count overflow"))?;
                                    Ok((
                                        ExternalSnapshot {
                                            kind: EntryKind::File,
                                            identity: file.identity,
                                            parent_identity: directory.identity.clone(),
                                            bytes: Some(file.bytes),
                                        },
                                        None,
                                    ))
                                }
                                Some(rustix::fs::FileType::Directory) => {
                                    if depth >= options.max_depth {
                                        return Err(Error::Unsupported(
                                            "external scan depth budget exhausted",
                                        ));
                                    }
                                    if scan.directories.len() + 1 >= MAX_HELD_DIRECTORIES {
                                        return Err(Error::Unsupported(
                                            "external scan directory descriptor budget exhausted",
                                        ));
                                    }
                                    let child = HeldDirectory::capture(
                                        fs::optional_directory(&directory.file, &name)?.ok_or(
                                            Error::Busy(
                                                "external directory disappeared during scan",
                                            ),
                                        )?,
                                    )?;
                                    if !identities.insert(child.identity.clone()) {
                                        return Err(Error::UnsafePath(
                                            "external directory aliases an observed directory"
                                                .into(),
                                        ));
                                    }
                                    Ok((
                                        ExternalSnapshot {
                                            kind: EntryKind::Folder,
                                            identity: child.identity.clone(),
                                            parent_identity: directory.identity.clone(),
                                            bytes: None,
                                        },
                                        Some(child),
                                    ))
                                }
                                _ => Err(Error::UnsafePath(
                                    "external entry is missing, linked, or unsupported".into(),
                                )),
                            }
                        })();
                        match captured {
                            Ok((snapshot, child)) => {
                                self.store.record_scan_observation(
                                    &id,
                                    &ScanObservation {
                                        path: path.clone(),
                                        kind: if snapshot.kind == EntryKind::File {
                                            ScanObservationKind::File
                                        } else {
                                            ScanObservationKind::Directory
                                        },
                                        entry: None,
                                        baseline_revision: None,
                                        identity: Some(snapshot.identity.clone()),
                                        imported: false,
                                        issue: None,
                                    },
                                )?;
                                if let Some(child) = child {
                                    self.store.record_directory_coverage(
                                        &id,
                                        &DirectoryCoverage {
                                            path: Some(path.clone()),
                                            identity: Some(child.identity.clone()),
                                            complete: false,
                                            issue: Some("external scan not finished".into()),
                                        },
                                    )?;
                                    scan.directories.insert(Some(path.clone()), child);
                                    stack.push((Some(path.clone()), depth + 1));
                                }
                                scan.entries.insert(path, snapshot);
                            }
                            Err(error) => {
                                complete = false;
                                let reason = error.to_string();
                                self.store.record_scan_observation(
                                    &id,
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
                                scan.issues.push(ScanIssue {
                                    path: Some(path),
                                    reason,
                                });
                            }
                        }
                    }
                }
            }
            if let Err(error) = directory.verify(self, scope.as_ref()) {
                complete = false;
                scan.issues.push(ScanIssue {
                    path: scope.clone(),
                    reason: error.to_string(),
                });
            }
            self.store.record_directory_coverage(
                &id,
                &DirectoryCoverage {
                    path: scope.clone(),
                    identity: Some(directory.identity.clone()),
                    complete,
                    issue: (!complete).then(|| "external directory coverage incomplete".into()),
                },
            )?;
            scan.directories.insert(scope, directory);
            if stopped {
                break;
            }
        }
        self.point("external_scan_before_finalize");
        self.point("external_scan_before_finish");
        if let Err(error) = scan.verify_directories(self) {
            scan.issues.push(ScanIssue {
                path: None,
                reason: error.to_string(),
            });
        }
        if started.elapsed() >= options.max_duration {
            scan.issues.push(ScanIssue {
                path: None,
                reason: "external scan duration budget exhausted".into(),
            });
        }
        // Save immutable capture proofs before the run becomes authoritative.
        // Missing descendants of a missing directory never acquire absence proof.
        let mut proof_count = scan.entries.len();
        for (path, snapshot) in &scan.entries {
            self.store.record_external_scan_proof(
                &id,
                &ExternalScanProof::present(
                    path.clone(),
                    snapshot.kind,
                    PhysicalIdentity {
                        inode: snapshot.identity.clone(),
                        parent_inode: snapshot.parent_identity.clone(),
                    },
                    snapshot.bytes.as_deref(),
                ),
            )?;
        }
        if !stopped && stack.is_empty() && scan.issues.is_empty() {
            for binding in self.store.physical_bindings()? {
                if scan.entries.contains_key(&binding.state.path) {
                    continue;
                }
                let Some(parent) = scan.directories.get(&binding.state.path.parent()) else {
                    continue;
                };
                if proof_count >= options.max_entries as usize
                    || started.elapsed() >= options.max_duration
                {
                    scan.issues.push(ScanIssue {
                        path: Some(binding.state.path),
                        reason: "external absence proof budget exhausted".into(),
                    });
                    break;
                }
                parent.verify(self, binding.state.path.parent().as_ref())?;
                if parent.identity != binding.physical.parent_inode
                    || fs::node_type(&parent.file, binding.state.path.file_name())?.is_some()
                {
                    scan.issues.push(ScanIssue {
                        path: Some(binding.state.path),
                        reason: "external absence parent changed".into(),
                    });
                    continue;
                }
                self.store.record_external_scan_proof(
                    &id,
                    &ExternalScanProof::Absent { before: binding },
                )?;
                proof_count += 1;
            }
            if let Err(error) = scan.verify_directories(self) {
                scan.issues.push(ScanIssue {
                    path: None,
                    reason: error.to_string(),
                });
            }
        }
        let complete = !stopped && stack.is_empty() && scan.issues.is_empty();
        scan.run = self.store.finish_scan(
            &id,
            complete,
            (!complete).then(|| "external scan incomplete; no namespace authority".into()),
        )?;
        Ok(scan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;
    fn path(value: &str) -> VaultPath {
        VaultPath::new(value).unwrap()
    }
    #[test]
    fn captures_all_bytes_without_importing_or_projecting() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        stdfs::create_dir(dir.path().join("Folder")).unwrap();
        stdfs::write(dir.path().join("Folder/blob"), [0, 255, 13, 128]).unwrap();
        let scan = vault.external_scan_locked(ScanOptions::default()).unwrap();
        assert!(scan.run.complete, "{:?}", scan.issues);
        assert_eq!(scan.run.imported, 0);
        assert_eq!(scan.entries.len(), 2);
        assert_eq!(
            scan.entries[&path("Folder/blob")].bytes.as_deref(),
            Some([0, 255, 13, 128].as_slice())
        );
        assert!(vault.store.list().unwrap().is_empty());
        assert!(scan.confirm_snapshot(&vault, &path("Folder/blob")).unwrap());
        assert!(scan.confirm_absent(&vault, &path("missing")).unwrap());
        assert!(vault
            .store
            .scan_observations(&scan.run.scan_id)
            .unwrap()
            .iter()
            .all(|row| !row.imported && row.kind != ScanObservationKind::Absent));
    }
    #[test]
    fn incomplete_budget_and_unsafe_nodes_never_authorize_absence() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        stdfs::write(dir.path().join("real"), b"content").unwrap();
        stdfs::hard_link(dir.path().join("real"), dir.path().join("hard")).unwrap();
        symlink("real", dir.path().join("symlink")).unwrap();
        let scan = vault.external_scan_locked(ScanOptions::default()).unwrap();
        assert!(!scan.run.complete);
        assert!(scan.confirm_absent(&vault, &path("missing")).is_err());
        assert!(vault.store.list().unwrap().is_empty());
        let scan = vault
            .external_scan_locked(ScanOptions {
                max_duration: std::time::Duration::ZERO,
                ..ScanOptions::default()
            })
            .unwrap();
        assert!(scan.run.finished && !scan.run.complete);
        assert!(scan.revalidate(&vault).is_err());
    }
    #[test]
    fn entry_byte_and_depth_limits_finish_incomplete() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        stdfs::create_dir(dir.path().join("Folder")).unwrap();
        stdfs::write(dir.path().join("Folder/file"), b"four").unwrap();
        for options in [
            ScanOptions {
                max_entries: 1,
                ..ScanOptions::default()
            },
            ScanOptions {
                max_total_bytes: 3,
                ..ScanOptions::default()
            },
            ScanOptions {
                max_depth: 0,
                ..ScanOptions::default()
            },
        ] {
            let scan = vault.external_scan_locked(options).unwrap();
            assert!(scan.run.finished && !scan.run.complete);
            assert!(scan.confirm_absent(&vault, &path("missing")).is_err());
        }
        assert!(vault.store.list().unwrap().is_empty());
    }
    std::thread_local! {
        static REPLACE_PARENT: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) };
    }
    #[test]
    fn replaced_parent_at_finalization_cannot_produce_complete_scan() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        stdfs::create_dir(dir.path().join("Folder")).unwrap();
        REPLACE_PARENT.with(|value| *value.borrow_mut() = Some(dir.path().to_path_buf()));
        vault.fault = Some(|point| {
            if point == "external_scan_before_finish" {
                REPLACE_PARENT.with(|value| {
                    let root = value.borrow_mut().take().unwrap();
                    stdfs::rename(root.join("Folder"), root.join("Old")).unwrap();
                    stdfs::create_dir(root.join("Folder")).unwrap();
                });
            }
        });
        let scan = vault.external_scan_locked(ScanOptions::default()).unwrap();
        assert!(scan.run.finished && !scan.run.complete);
        assert!(scan
            .confirm_absent(&vault, &path("Folder/missing"))
            .is_err());
    }
    #[test]
    fn direct_absence_does_not_infer_descendant_absence() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        let scan = vault.external_scan_locked(ScanOptions::default()).unwrap();
        assert!(scan.confirm_absent(&vault, &path("gone")).unwrap());
        assert!(!scan.confirm_absent(&vault, &path("gone/child")).unwrap());
    }
    #[test]
    fn final_original_parent_identity_and_later_bytes_are_rechecked() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        stdfs::create_dir(dir.path().join("Folder")).unwrap();
        stdfs::write(dir.path().join("Folder/file"), b"before").unwrap();
        let scan = vault.external_scan_locked(ScanOptions::default()).unwrap();
        stdfs::write(dir.path().join("Folder/file"), b"edited").unwrap();
        assert!(!scan.confirm_snapshot(&vault, &path("Folder/file")).unwrap());
        stdfs::rename(dir.path().join("Folder"), dir.path().join("Old")).unwrap();
        stdfs::create_dir(dir.path().join("Folder")).unwrap();
        assert!(scan.revalidate(&vault).is_err());
        assert!(scan
            .confirm_absent(&vault, &path("Folder/missing"))
            .is_err());
    }
    #[test]
    fn interruption_leaves_unfinished_scan_without_logical_changes() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        stdfs::write(dir.path().join("file"), b"retained").unwrap();
        vault.fault = Some(|point| {
            if point == "external_scan_before_finish" {
                panic!("interrupted scan");
            }
        });
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || vault.external_scan_locked(ScanOptions::default())
        ))
        .is_err());
        let run = vault.store.latest_scan().unwrap().unwrap();
        assert!(!run.finished && !run.complete);
        assert!(vault.store.list().unwrap().is_empty());
        assert_eq!(stdfs::read(dir.path().join("file")).unwrap(), b"retained");
    }
}
