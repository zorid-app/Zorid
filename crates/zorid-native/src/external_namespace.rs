//! Ordinary discovery precedes recovery/publication, preserving moved or deleted
//! physical branches until their exact historical observation is committed.
use super::*;
use std::collections::BTreeSet;
use zorid_store::{ExternalNamespaceAction, ExternalNamespaceMember};

impl NativeVault {
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
        if !self.store.family_is_enrolled()? {
            return Err(Error::Unsupported(
                "external family reconciliation requires enrollment",
            ));
        }
        let namespace_origin = OperationId::new("native_external_namespace")?;
        let observe_origin = OperationId::new("native_external_observe")?;
        let create_origin = OperationId::new("native_external_create")?;
        let started = std::time::Instant::now();
        let duration = options.max_duration;
        let mut scan = self.external_progress_scan_locked(options)?;
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
            if started.elapsed() >= duration {
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
                    match scan.confirm_snapshot(self, &path) {
                        Ok(true) => {
                            processed.insert(path.clone());
                        }
                        Ok(false) => {}
                        Err(error) => report.issues.push(ScanIssue {
                            path: Some(path.clone()),
                            reason: self.external_reconciliation_issue(error)?,
                        }),
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
                Err(error) => report.issues.push(ScanIssue {
                    path: Some(path),
                    reason: self.external_reconciliation_issue(error)?,
                }),
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
                if started.elapsed() >= duration {
                    report.issues.push(ScanIssue {
                        path: Some(before.state.path.clone()),
                        reason: "external reconciliation duration budget exhausted".into(),
                    });
                    break;
                }
                if handled.contains(&before.state.id) {
                    continue;
                }
                if scan.entries.get(&before.state.path).is_some_and(|s| {
                    s.identity == before.physical.inode && s.kind == before.state.kind
                }) {
                    continue;
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
                                    Some(self.capture_observed_file(
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
            if started.elapsed() >= duration {
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
                        self.observe_streamed_file(&path, &parent, &expected, &observe_origin)
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
                    self.observe_new_family_stream(
                        &path,
                        &parent,
                        &expected,
                        selected,
                        &create_origin,
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
        scan.record_processed(self, &processed.into_iter().collect::<Vec<_>>())?;
        self.paths.verify()?;
        report.complete =
            scan.run.complete && report.issues.is_empty() && scan.pending_paths().is_empty();
        Ok(report)
    }
}
