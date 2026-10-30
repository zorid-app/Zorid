//! Finite, untrusted work hints after an owned file publication. These RAM-only
//! names grant no namespace authority and never modify immutable scan proofs.
use super::*;
use crate::fs_stream::{stream_snapshot, MAX_STREAM_BYTES};
use std::collections::BTreeSet;

pub(super) const MAX_POSITIVE_HINTS: usize = 4096;
const MAX_HINT_PATH_BYTES: usize = 1024 * 1024;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
struct SeedWork {
    builds: usize,
    path_constructions: usize,
    processed_visits: usize,
    retain_visits: usize,
}
#[cfg(test)]
thread_local! { static SEED_WORK: std::cell::Cell<SeedWork> = const { std::cell::Cell::new(SeedWork { builds: 0, path_constructions: 0, processed_visits: 0, retain_visits: 0 }) }; }
#[cfg(test)]
pub(super) fn record_seed_build(paths: usize) {
    SEED_WORK.with(|work| {
        let mut next = work.get();
        next.builds += 1;
        next.path_constructions += paths;
        work.set(next);
    });
}
#[cfg(test)]
pub(super) fn record_seed_refresh(processed: usize, retained: usize) {
    SEED_WORK.with(|work| {
        let mut next = work.get();
        next.processed_visits += processed;
        next.retain_visits += retained;
        work.set(next);
    });
}

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
    pub options: Option<ScanOptions>,
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
            options: None,
        })
    }
    pub(super) fn scope(&self) -> Option<VaultPath> {
        self.directories
            .last()
            .and_then(|directory| directory.path.clone())
    }
    fn same_options(&self, options: &ScanOptions) -> bool {
        self.options.as_ref().is_some_and(|original| {
            original.max_entries == options.max_entries
                && original.max_total_bytes == options.max_total_bytes
                && original.max_depth == options.max_depth
                && original.max_duration == options.max_duration
        })
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
                Some(path) => fs::optional_directory(&parent, path.file_name())?
                    .ok_or(Error::Busy("positive hint ancestor disappeared"))?,
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
        if !(1..=external_scan_progress::MAX_INVENTORY).contains(&options.scan.max_entries) {
            self.external_positive_armed = None;
            self.external_positive_hints = None;
            return Ok(None); // The ordinary scan returns its existing typed rejection.
        }
        if self.external_positive_hints.is_none() {
            if let Some(seed) = self.external_positive_armed.take() {
                if seed.mode == mode && seed.same_options(&options.scan) {
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
        let authority = match self.store.identity() {
            Ok(authority) => authority,
            Err(error) => {
                self.external_positive_hints = Some(hints);
                return Err(error.into());
            }
        };
        // Drain exactly once. Later writes do not reset or append names. The
        // following turn must start an entirely fresh normal inventory.
        if hints.next == hints.seed.paths.len()
            || hints.seed.mode != mode
            || !hints.seed.same_options(&options.scan)
            || hints.seed.authority.as_ref() != Some(&authority)
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
            enrolled.finish(self)?;
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

#[cfg(test)]
mod perf_tests {
    use super::*;
    use std::{num::NonZeroU16, time::Duration};

    #[test]
    fn positive_seed_work_reuses_one_directory_without_rewalking_candidates() {
        let root = tempfile::tempdir().unwrap();
        const COUNT: usize = 32;
        for index in 0..COUNT {
            std::fs::write(
                root.path().join(format!("note-{index:03}.md")),
                format!("note {index}\n"),
            )
            .unwrap();
        }
        let mut vault = NativeVault::open(root.path()).unwrap();
        vault
            .family_enroll(&FamilyScope {
                realm_id: zorid_sync_protocol::RealmId::new("seed-work-realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("seed-work-vault").unwrap(),
            })
            .unwrap();
        SEED_WORK.with(|work| work.set(SeedWork::default()));
        let options = ExternalReconcileOptions {
            scan: ScanOptions {
                max_duration: Duration::from_secs(5),
                ..Default::default()
            },
            max_work_units: NonZeroU16::new(1).unwrap(),
        };
        let mut scan = None;
        for _ in 0..8 {
            let turn = vault
                .reconcile_external_quantum(options.clone(), ExternalFileMode::Auto)
                .unwrap();
            assert!(turn.pending && !turn.reconciliation.run.complete);
            assert!(turn.work_units <= 1);
            if let Some(original) = &scan {
                assert_eq!(original, &turn.reconciliation.run.scan_id);
            }
            scan = Some(turn.reconciliation.run.scan_id);
        }
        let work = SEED_WORK.with(std::cell::Cell::get);
        assert_eq!(
            work.builds, 1,
            "same checked directory must reuse one candidate vector: {work:?}"
        );
        assert_eq!(
            work.path_constructions, COUNT,
            "each cached candidate path is constructed once: {work:?}"
        );
        assert_eq!(
            work.processed_visits, 0,
            "normal turns must move validated metadata instead of rescanning eligibility: {work:?}"
        );
        assert_eq!(
            work.retain_visits, 0,
            "normal turns must not repeatedly filter the candidate vector: {work:?}"
        );
    }
}
