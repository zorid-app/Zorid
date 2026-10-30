//! Finite, untrusted work hints after an owned file publication. These RAM-only
//! names grant no namespace authority and never modify immutable scan proofs.
use super::*;
use crate::fs_stream::{stream_snapshot, MAX_STREAM_BYTES};
use std::collections::BTreeSet;

pub(super) const MAX_POSITIVE_HINTS: usize = 4096;
const MAX_HINT_PATH_BYTES: usize = 1024 * 1024;

pub(super) struct HintDirectory {
    pub path: Option<VaultPath>,
    pub identity: String,
    pub marker: external_scan_progress::Marker,
}
pub(super) struct PositiveSeed {
    pub scan_id: OperationId,
    pub revision: Option<String>,
    pub directories: Vec<HintDirectory>,
    pub paths: Vec<VaultPath>,
    pub processed: BTreeSet<VaultPath>,
    pub mode: ExternalFileMode,
    pub authority: Option<AuthorityIdentity>,
}
impl PositiveSeed {
    pub(super) fn new(
        scan_id: OperationId,
        directories: Vec<HintDirectory>,
        paths: Vec<VaultPath>,
    ) -> Option<Self> {
        if paths.len() > MAX_POSITIVE_HINTS
            || directories.is_empty()
            || paths.iter().map(|path| path.as_str().len()).sum::<usize>() > MAX_HINT_PATH_BYTES
        {
            return None;
        }
        Some(Self {
            scan_id,
            revision: None,
            directories,
            paths,
            processed: BTreeSet::new(),
            mode: ExternalFileMode::Auto,
            authority: None,
        })
    }
    pub(super) fn scope(&self) -> Option<VaultPath> {
        self.directories
            .last()
            .and_then(|directory| directory.path.clone())
    }
    fn parent(&self, vault: &NativeVault, check_markers: bool) -> Result<File> {
        vault.paths.verify()?;
        if self.authority.as_ref() != Some(&vault.store.identity()?) {
            return Err(Error::Busy("positive hint authority changed"));
        }
        let mut parent = vault.paths.root.try_clone()?;
        for directory in &self.directories {
            parent = match directory.path.as_ref() {
                None => vault.paths.root.try_clone()?,
                Some(path) => vault.paths.directory(path)?,
            };
            if fs::identity(&parent)? != directory.identity
                || check_markers && external_scan_progress::marker(&parent)? != directory.marker
            {
                return Err(Error::Busy("positive hint ancestor changed"));
            }
        }
        Ok(parent)
    }
}
pub(super) struct PositiveHints {
    seed: PositiveSeed,
    run: ScanRun,
    next: usize,
}

impl NativeVault {
    /// O(depth) eligibility only. No foreground directory enumeration or body
    /// walk: the normal bounded discovery turn already retained the names.
    pub(super) fn can_continue_after_own_publication(
        &self,
        attempt: &ProjectionAttempt,
        proof: &zorid_store::PublicationProof,
    ) -> Result<bool> {
        if self.external_positive_armed.is_some() || self.external_positive_hints.is_some() {
            return Ok(false);
        }
        let Some(seed) = self.external_positive_seed.as_ref() else {
            return Ok(false);
        };
        let path = &attempt.target.state.path;
        if seed.revision.is_none()
            || path.parent() != seed.scope()
            || !seed.processed.contains(path)
            || attempt
                .baseline
                .as_ref()
                .is_none_or(|base| base.state.path != *path || base.state.kind != EntryKind::File)
            || proof.expected_binding.as_ref().is_none_or(|binding| {
                binding.state.path != *path || binding.state.kind != EntryKind::File
            })
        {
            return Ok(false);
        }
        // A pre-existing unknown namespace change cannot be attributed to the
        // upcoming save. The normal inventory will reject its old markers.
        match seed.parent(self, true) {
            Ok(_) => Ok(true),
            Err(Error::Busy(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(super) fn continue_positive_hints(
        &mut self,
        options: &ExternalReconcileOptions,
        mode: ExternalFileMode,
        enrolled: &external_namespace::EnrolledScan<'_>,
        budget: &mut external_scan_quantum::ExternalWorkBudget,
    ) -> Result<Option<ExternalReconcileQuantum>> {
        if self.external_positive_hints.is_none() {
            if let Some(seed) = self.external_positive_armed.take() {
                if seed.mode == mode {
                    let retired = match self.retire_inventory_for_positive_hints(&seed) {
                        Ok(retired) => retired,
                        Err(error) => {
                            self.external_positive_armed = Some(seed);
                            return Err(error);
                        }
                    };
                    if let Some(run) = retired {
                        self.external_positive_hints = Some(PositiveHints { seed, run, next: 0 });
                    } else {
                        // Do not fall through and mutate a different writer's
                        // checkpoint in the same failed handoff.
                        return Err(Error::Busy("positive continuation inventory changed"));
                    }
                }
            }
        }
        let Some(mut hints) = self.external_positive_hints.take() else {
            return Ok(None);
        };
        // Drain exactly once. Later writes do not reset or append names. The
        // following turn must start an entirely fresh normal inventory.
        if hints.next == hints.seed.paths.len()
            || hints.seed.mode != mode
            || hints.seed.authority.as_ref() != Some(&self.store.identity()?)
        {
            return Ok(None);
        }
        let mut imported = Vec::new();
        let mut bytes = 0u64;
        let result = (|| -> Result<()> {
            while hints.next < hints.seed.paths.len() {
                let path = &hints.seed.paths[hints.next];
                if budget.used() as u32 >= options.scan.max_entries
                    || !budget.capture_positive(path)
                {
                    break;
                }
                let attempt = (|| -> Result<Option<CommitResult>> {
                    enrolled.check(self)?;
                    let parent = hints.seed.parent(self, false)?;
                    if fs::node_type(&parent, path.file_name())?
                        != Some(rustix::fs::FileType::RegularFile)
                    {
                        return Ok(None); // Missing/directory/linked hints grant no negative decision.
                    }
                    let file = fs::regular(&parent, path.file_name())?
                        .ok_or(Error::Busy("positive hint disappeared"))?;
                    let length = file.metadata()?.len();
                    drop(file);
                    let remaining = options
                        .scan
                        .max_total_bytes
                        .saturating_sub(bytes)
                        .min(MAX_STREAM_BYTES);
                    if length > remaining {
                        return Err(Error::Unsupported("positive hint exceeds scan byte budget"));
                    }
                    let expected =
                        stream_snapshot(&parent, path.file_name(), remaining, |_| Ok(()))?
                            .ok_or(Error::Busy("positive hint disappeared"))?;
                    bytes += expected.length;
                    hints.seed.parent(self, false)?;
                    self.paths.verify_parent(path, &parent)?;
                    self.point("external_positive_snapshot_captured");
                    let snapshot = external_scan::ExternalSnapshot {
                        kind: EntryKind::File,
                        identity: expected.identity.clone(),
                        parent_identity: expected.parent_identity.clone(),
                        bytes: None,
                    };
                    self.import_external_positive(path, &snapshot, Some(&expected), mode, enrolled)
                })();
                match attempt {
                    Ok(Some(commit)) => imported.push(commit),
                    Ok(None) => {}
                    // These are deferred positives, not authority to repair a
                    // namespace or rebind a replacement. A fresh scan follows.
                    Err(Error::Busy(_) | Error::UnsafePath(_) | Error::Unsupported(_)) => {
                        self.paths.verify()?;
                    }
                    Err(Error::Io(error))
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                        ) =>
                    {
                        self.paths.verify()?;
                    }
                    Err(error) => return Err(error),
                }
                hints.next += 1;
            }
            enrolled.check(self)?;
            Ok(())
        })();
        let quantum = ExternalReconcileQuantum {
            reconciliation: ExternalReconcileReport {
                complete: false,
                run: hints.run.clone(),
                issues: Vec::new(),
                imported,
                namespace: Vec::new(),
            },
            publication: ReconcileReport::default(),
            phase: ExternalWorkPhase::Discovery,
            pending: true,
            work_units: budget.used(),
        };
        self.external_positive_hints = Some(hints);
        result?;
        Ok(Some(quantum))
    }
}
