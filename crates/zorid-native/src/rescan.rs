use super::*;
use std::{collections::BTreeSet, os::unix::fs::MetadataExt, time::Instant};
use zorid_store::{DirectoryCoverage, ScanObservation, ScanObservationKind};
fn marker(dir: &File) -> Result<(u64, u64, i64, i64, i64, i64)> {
    let m = dir.metadata()?;
    Ok((
        m.dev(),
        m.ino(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
impl NativeVault {
    pub fn rescan(&mut self) -> Result<RescanReport> {
        self.rescan_with_options(ScanOptions::default())
    }
    /// Finite local pass. Limits stop coverage, never imply deletion. Files are
    /// captured once, up to both per-file and per-scan byte limits. Time is a soft
    /// budget checked between filesystem calls, not an IO cancellation guarantee.
    pub fn rescan_with_options(&mut self, options: ScanOptions) -> Result<RescanReport> {
        if options.max_entries == 0 || options.max_entries > 100_000 {
            return Err(Error::Unsupported("scan max_entries must be 1..=100000"));
        }
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let run = self.store.begin_scan(options.max_entries)?;
        let id = run.scan_id.clone();
        self.point("scan_started");
        if options.max_duration.is_zero() {
            self.store.record_directory_coverage(
                &id,
                &DirectoryCoverage {
                    path: None,
                    identity: Some(fs::identity(&self.paths.root)?),
                    complete: false,
                    issue: Some("scan duration budget exhausted".into()),
                },
            )?;
            let run = self.store.finish_scan(
                &id,
                false,
                Some("scan duration budget exhausted".into()),
            )?;
            return Ok(RescanReport {
                run,
                issues: Vec::new(),
                missing: Vec::new(),
            });
        }
        // Projection recovery precedes observation, so our own capture/publication
        // gaps are not interpreted as externally absent paths. Blocked attempts
        // are explicitly excluded below rather than mistaken for disk authority.
        let recovery = self.recover_locked()?;
        let active_files: BTreeSet<_> = self
            .store
            .projection_attempts(false)?
            .into_iter()
            .map(|a| a.target.state.path)
            .collect();
        let active_dirs: BTreeSet<_> = self
            .store
            .directory_attempts(false)?
            .into_iter()
            .map(|a| a.target.path)
            .collect();
        let started = Instant::now();
        let mut total_bytes = 0u64;
        let mut observed = 0u32;
        let mut issues: Vec<ScanIssue> = recovery
            .blocked
            .into_iter()
            .map(|(path, reason)| ScanIssue {
                path: Some(path),
                reason,
            })
            .collect();
        let mut missing = Vec::new();
        let mut absences = Vec::new();
        let mut stop = None;
        let mut stack = vec![(None::<VaultPath>, None::<String>, 0u16)];
        self.store.record_directory_coverage(
            &id,
            &DirectoryCoverage {
                path: None,
                identity: Some(fs::identity(&self.paths.root)?),
                complete: false,
                issue: Some("scan not finished".into()),
            },
        )?;
        while let Some((scope, expected, depth)) = stack.pop() {
            if started.elapsed() >= options.max_duration {
                stop = Some("scan duration budget exhausted".to_owned());
                break;
            }
            let opened = match &scope {
                Some(path) => self.paths.directory(path),
                None => self.paths.root.try_clone().map_err(Into::into),
            };
            let directory = match opened {
                Ok(dir) => dir,
                Err(e) => {
                    let reason = e.to_string();
                    self.store.record_directory_coverage(
                        &id,
                        &DirectoryCoverage {
                            path: scope.clone(),
                            identity: None,
                            complete: false,
                            issue: Some(reason.clone()),
                        },
                    )?;
                    issues.push(ScanIssue {
                        path: scope,
                        reason,
                    });
                    continue;
                }
            };
            let identity = fs::identity(&directory)?;
            if expected.as_ref().is_some_and(|value| *value != identity) {
                let reason = "directory replaced before scan".to_owned();
                self.store.record_directory_coverage(
                    &id,
                    &DirectoryCoverage {
                        path: scope.clone(),
                        identity: Some(identity),
                        complete: false,
                        issue: Some(reason.clone()),
                    },
                )?;
                issues.push(ScanIssue {
                    path: scope,
                    reason,
                });
                continue;
            }
            self.store.record_directory_coverage(
                &id,
                &DirectoryCoverage {
                    path: scope.clone(),
                    identity: Some(identity.clone()),
                    complete: false,
                    issue: Some("scan not finished".into()),
                },
            )?;
            let before = marker(&directory)?;
            self.point("scan_directory_opened");
            let names = match fs::directory_names(
                &directory,
                (options.max_entries - observed) as usize,
                scope.is_none(),
            ) {
                Ok(names) => names,
                Err(e) => {
                    let reason = e.to_string();
                    self.store.record_directory_coverage(
                        &id,
                        &DirectoryCoverage {
                            path: scope.clone(),
                            identity: Some(identity),
                            complete: false,
                            issue: Some(reason.clone()),
                        },
                    )?;
                    issues.push(ScanIssue {
                        path: scope,
                        reason,
                    });
                    continue;
                }
            };
            let seen: BTreeSet<String> = names.iter().cloned().collect();
            let mut complete = true;
            for name in names {
                if observed >= options.max_entries || started.elapsed() >= options.max_duration {
                    stop = Some("scan entry or duration budget exhausted".into());
                    complete = false;
                    break;
                }
                let relative = match &scope {
                    Some(p) => format!("{}/{name}", p.as_str()),
                    None => name.clone(),
                };
                let path = match VaultPath::new(relative) {
                    Ok(path) => path,
                    Err(e) => {
                        complete = false;
                        issues.push(ScanIssue {
                            path: scope.clone(),
                            reason: e.to_string(),
                        });
                        continue;
                    }
                };
                let result: Result<(ScanObservation, Option<String>)> = (|| {
                    if active_files.contains(&path)
                        || active_dirs
                            .iter()
                            .any(|p| p == &path || path.is_descendant_of(p))
                    {
                        return Err(Error::Busy(
                            "pending projection obscures physical observation",
                        ));
                    }
                    self.verify_scan_directory(scope.as_ref(), &directory)?;
                    match fs::node_type(&directory, &name)? {
                        Some(rustix::fs::FileType::RegularFile) => {
                            let remaining = options.max_total_bytes.saturating_sub(total_bytes);
                            let limit = self
                                .options
                                .max_file_bytes
                                .min(usize::try_from(remaining).unwrap_or(usize::MAX));
                            let snapshot = fs::snapshot(&directory, &name, limit)?
                                .ok_or(Error::Busy("file disappeared during scan"))?;
                            total_bytes = total_bytes
                                .checked_add(snapshot.bytes.len() as u64)
                                .ok_or(Error::Unsupported("scan byte count overflow"))?;
                            let file_identity = snapshot.identity.clone();
                            let imported = self
                                .observe_snapshot(&path, &directory, Some(snapshot))?
                                .is_some();
                            let state = self.store.list()?.into_iter().find(|s| s.path == path);
                            let baseline = match &state {
                                Some(s) => self
                                    .store
                                    .projection_baseline(&s.id)?
                                    .map(|b| b.state.revision),
                                None => None,
                            };
                            Ok((
                                ScanObservation {
                                    path: path.clone(),
                                    kind: ScanObservationKind::File,
                                    entry: state,
                                    baseline_revision: baseline,
                                    identity: Some(file_identity),
                                    imported,
                                    issue: None,
                                },
                                None,
                            ))
                        }
                        Some(rustix::fs::FileType::Directory) => {
                            let imported = self.observe_directory(&path)?.is_some();
                            let folder = self.paths.directory(&path)?;
                            let folder_identity = fs::identity(&folder)?;
                            let state = self.store.list()?.into_iter().find(|s| s.path == path);
                            let baseline = match &state {
                                Some(s) => self
                                    .store
                                    .directory_baseline(&s.id)?
                                    .map(|b| b.state.revision),
                                None => None,
                            };
                            Ok((
                                ScanObservation {
                                    path: path.clone(),
                                    kind: ScanObservationKind::Directory,
                                    entry: state,
                                    baseline_revision: baseline,
                                    identity: Some(folder_identity.clone()),
                                    imported,
                                    issue: None,
                                },
                                Some(folder_identity),
                            ))
                        }
                        None => Err(Error::Busy("entry disappeared during enumeration")),
                        Some(_) => Err(Error::UnsafePath(
                            "symlinks and special files are not traversed".into(),
                        )),
                    }
                })();
                match result {
                    Ok((observation, child)) => {
                        self.store.record_scan_observation(&id, &observation)?;
                        observed += 1;
                        self.point("scan_observation_committed");
                        if let Some(child) = child {
                            let reason = if depth >= options.max_depth {
                                "scan depth budget exhausted"
                            } else {
                                "scan not finished"
                            };
                            self.store.record_directory_coverage(
                                &id,
                                &DirectoryCoverage {
                                    path: Some(path.clone()),
                                    identity: Some(child.clone()),
                                    complete: false,
                                    issue: Some(reason.into()),
                                },
                            )?;
                            if depth >= options.max_depth {
                                issues.push(ScanIssue {
                                    path: Some(path),
                                    reason: reason.into(),
                                });
                            } else {
                                stack.push((Some(path), Some(child), depth + 1));
                            }
                        }
                    }
                    Err(e) => {
                        complete = false;
                        let reason = e.to_string();
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
                        observed += 1;
                        issues.push(ScanIssue {
                            path: Some(path),
                            reason,
                        });
                    }
                }
            }
            if marker(&directory)? != before
                || self
                    .verify_scan_directory(scope.as_ref(), &directory)
                    .is_err()
            {
                complete = false;
                issues.push(ScanIssue {
                    path: scope.clone(),
                    reason: "directory changed during scan".into(),
                });
            }
            if complete {
                // Only formerly materialized immediate children are absence
                // candidates. Neither a read error nor an unseen subtree counts.
                for entry in self
                    .store
                    .list()?
                    .into_iter()
                    .filter(|s| s.path.parent() == scope)
                {
                    if seen.contains(entry.path.file_name()) {
                        continue;
                    }
                    if observed >= options.max_entries || started.elapsed() >= options.max_duration
                    {
                        complete = false;
                        stop = Some("scan entry or duration budget exhausted".into());
                        break;
                    }
                    let baseline = if entry.kind == EntryKind::File {
                        self.store
                            .projection_baseline(&entry.id)?
                            .map(|b| b.state.revision)
                    } else {
                        self.store
                            .directory_baseline(&entry.id)?
                            .map(|b| b.state.revision)
                    };
                    let Some(baseline) = baseline else {
                        continue;
                    };
                    if active_files.contains(&entry.path) || active_dirs.contains(&entry.path) {
                        complete = false;
                        issues.push(ScanIssue {
                            path: Some(entry.path),
                            reason: "pending projection prevents absence confirmation".into(),
                        });
                        continue;
                    }
                    self.verify_scan_directory(scope.as_ref(), &directory)?;
                    match fs::node_type(&directory, entry.path.file_name()) {
                        Ok(None) => {
                            let path = entry.path.clone();
                            absences.push(ScanObservation {
                                path: path.clone(),
                                kind: ScanObservationKind::Absent,
                                entry: Some(entry),
                                baseline_revision: Some(baseline),
                                identity: None,
                                imported: false,
                                issue: Some(
                                    "pending absence; deletion reconciliation not implemented"
                                        .into(),
                                ),
                            });
                            observed += 1;
                            let _ = path;
                        }
                        _ => {
                            complete = false;
                            issues.push(ScanIssue {
                                path: Some(entry.path),
                                reason: "absence could not be confirmed".into(),
                            });
                        }
                    }
                }
            }
            if marker(&directory)? != before
                || self
                    .verify_scan_directory(scope.as_ref(), &directory)
                    .is_err()
            {
                complete = false;
            }
            self.store.record_directory_coverage(
                &id,
                &DirectoryCoverage {
                    path: scope.clone(),
                    identity: Some(identity),
                    complete,
                    issue: (!complete).then(|| "directory coverage incomplete".into()),
                },
            )?;
            if stop.is_some() {
                break;
            }
        }
        if !stack.is_empty() && stop.is_none() {
            stop = Some("scan has unvisited directories".into());
        }
        // Revalidate against the ORIGINAL completed coverage identity, not just
        // whichever directory happens to occupy that path at finalization time.
        let coverages = self.store.scan_coverage(&id)?;
        let mut verified_absences = Vec::new();
        self.point("scan_before_absence_validation");
        if stop.is_none() && issues.is_empty() && coverages.iter().all(|c| c.complete) {
            for absence in absences {
                let expected = coverages
                    .iter()
                    .find(|c| c.path == absence.path.parent())
                    .and_then(|c| c.identity.as_ref());
                let parent_result = self.paths.parent(&absence.path);
                let valid = match &parent_result {
                    Ok((parent, name)) => {
                        expected == Some(&fs::identity(parent)?)
                            && fs::node_type(parent, name)?.is_none()
                    }
                    Err(_) => false,
                };
                if !valid {
                    issues.push(ScanIssue {
                        path: Some(absence.path.clone()),
                        reason: "completed parent changed or path reappeared before absence commit"
                            .into(),
                    });
                    let scope = absence.path.parent();
                    self.store.record_directory_coverage(
                        &id,
                        &DirectoryCoverage {
                            path: scope,
                            identity: expected.cloned(),
                            complete: false,
                            issue: Some("absence finalization lost directory binding".into()),
                        },
                    )?;
                    continue;
                }
                let (parent, _) = parent_result?;
                self.paths.verify_parent(&absence.path, &parent)?;
                verified_absences.push(absence);
            }
        }
        self.point("scan_before_finish");
        let run = self.store.finish_scan_with_absences(
            &id,
            stop.is_none() && issues.is_empty(),
            stop,
            &verified_absences,
        )?;
        if run.complete {
            missing = verified_absences.into_iter().map(|a| a.path).collect();
        }
        if !run.complete {
            missing.clear();
        }
        self.paths.verify()?;
        Ok(RescanReport {
            run,
            issues,
            missing,
        })
    }
    fn verify_scan_directory(&self, path: Option<&VaultPath>, directory: &File) -> Result<()> {
        self.paths.verify()?;
        let current = match path {
            Some(path) => self.paths.directory(path)?,
            None => self.paths.root.try_clone()?,
        };
        if fs::identity(&current)? != fs::identity(directory)? {
            return Err(Error::Busy("directory binding changed during scan"));
        }
        Ok(())
    }
}
