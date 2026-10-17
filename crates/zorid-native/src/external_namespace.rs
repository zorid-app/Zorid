//! Ordinary discovery precedes recovery/publication, preserving moved or deleted
//! physical branches until their exact historical observation is committed.
use super::*;
use std::collections::BTreeSet;
use zorid_store::{ExternalNamespaceAction, ExternalNamespaceMember};

impl NativeVault {
    pub fn reconcile_external(
        &mut self,
        options: ScanOptions,
        mode: ExternalFileMode,
    ) -> Result<ExternalReconcileReport> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        if !self.store.family_is_enrolled()? {
            return Err(Error::Unsupported(
                "external family reconciliation requires enrollment",
            ));
        }
        let started = std::time::Instant::now();
        let duration = options.max_duration;
        let scan = self.external_scan_locked(options)?;
        let mut report = ExternalReconcileReport {
            complete: false,
            run: scan.run.clone(),
            issues: Vec::new(),
            imported: Vec::new(),
            namespace: Vec::new(),
        };
        if !scan.run.complete {
            report.issues = scan.issues;
            return Ok(report);
        }
        // A file may have moved into an independently created directory. Enroll
        // new parent directories first; retained inodes are never new identities.
        let mut folders: Vec<_> = scan
            .entries
            .iter()
            .filter(|(_, s)| s.kind == EntryKind::Folder)
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
            if self
                .store
                .physical_bindings()?
                .iter()
                .any(|b| b.physical.inode == snapshot.identity)
            {
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
                Ok(commit) => report.imported.push(commit),
                Err(error) => report.issues.push(ScanIssue {
                    path: Some(path),
                    reason: error.to_string(),
                }),
            }
        }
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
            if scan
                .entries
                .get(&before.state.path)
                .is_some_and(|s| s.identity == before.physical.inode && s.kind == before.state.kind)
            {
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
                .filter(|(_, s)| s.identity == before.physical.inode && s.kind == before.state.kind)
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
                        let found = scan
                            .entries
                            .get(&path)
                            .ok_or(Error::Busy("external move has missing tracked member"))?;
                        if found.identity != member.physical.inode
                            || found.kind != member.state.kind
                            || !scan.confirm_snapshot(self, &path)?
                        {
                            return Err(Error::Busy("external move member changed"));
                        }
                        (
                            Some((
                                path,
                                PhysicalIdentity {
                                    inode: found.identity.clone(),
                                    parent_inode: found.parent_identity.clone(),
                                },
                            )),
                            found.bytes.clone(),
                        )
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
                let action = match &target {
                    Some(path) => ExternalNamespaceAction::Move {
                        root: before.state.id.clone(),
                        path: path.clone(),
                    },
                    None => ExternalNamespaceAction::Delete {
                        root: before.state.id.clone(),
                    },
                };
                let observation = self.store.record_family_namespace_observation(
                    &scan.run.scan_id,
                    action,
                    evidence,
                )?;
                self.point("external_namespace_prepared");
                scan.revalidate(self)?;
                if !scan.confirm_absent(self, &before.state.path)? {
                    return Err(Error::Busy("external source reappeared before commit"));
                }
                for member in &observation.members {
                    if let Some((path, _)) = &member.after {
                        if !scan.confirm_snapshot(self, path)? {
                            return Err(Error::Busy("external destination changed before commit"));
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
                    reason: error.to_string(),
                }),
            }
        }
        let mut paths: Vec<_> = scan.entries.keys().cloned().collect();
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
                let all = self.store.physical_bindings()?;
                let owner = all.iter().find(|b| b.physical.inode == snapshot.identity);
                if owner.is_some_and(|b| b.state.path != path) {
                    return Err(Error::Busy("external inode retains another physical path"));
                }
                let (parent, name) = self.paths.parent(&path)?;
                if let Some(owner) = owner {
                    let visible = self
                        .store
                        .list()?
                        .into_iter()
                        .find(|e| e.id == owner.state.id && e.path == path);
                    if visible.is_none() {
                        return Err(Error::Busy(
                            "external physical branch retained for recovery",
                        ));
                    }
                    return if snapshot.kind == EntryKind::File {
                        self.observe_snapshot(
                            &path,
                            &parent,
                            Some(fs::Snapshot {
                                identity: snapshot.identity.clone(),
                                bytes: snapshot
                                    .bytes
                                    .clone()
                                    .ok_or(Error::Busy("file bytes missing"))?,
                            }),
                        )
                    } else {
                        Ok(None)
                    };
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
                    let bytes = snapshot
                        .bytes
                        .as_ref()
                        .ok_or(Error::Busy("file bytes missing"))?;
                    let selected = select_external_file_mode(&path, bytes, mode)?;
                    let disk = fs::snapshot(&parent, &name, self.options.max_file_bytes)?
                        .ok_or(Error::Busy("external file disappeared"))?;
                    if disk.identity != snapshot.identity || &disk.bytes != bytes {
                        return Err(Error::Busy("external file changed"));
                    }
                    self.observe_new_family_file(&path, &parent, &disk, selected)
                        .map(Some)
                }
            })();
            match attempt {
                Ok(Some(commit)) => report.imported.push(commit),
                Ok(None) => {}
                Err(error) => report.issues.push(ScanIssue {
                    path: Some(path),
                    reason: error.to_string(),
                }),
            }
        }
        report.complete = report.issues.is_empty();
        Ok(report)
    }
}
