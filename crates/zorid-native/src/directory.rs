use super::*;
use zorid_store::{DirectoryAttempt, DirectoryPhase};
impl NativeVault {
    /// Fresh directory import is atomic with its physical binding. Existing
    /// metadata without provenance requires explicit enrollment.
    pub(super) fn observe_directory(&mut self, path: &VaultPath) -> Result<Option<CommitResult>> {
        self.namespace_clear(path)?;
        let (parent, name) = self.paths.parent(path)?;
        let folder =
            fs::optional_directory(&parent, &name)?.ok_or(Error::Busy("directory disappeared"))?;
        let identity = fs::identity(&folder)?;
        let physical = PhysicalIdentity {
            inode: identity.clone(),
            parent_inode: fs::identity(&parent)?,
        };
        self.paths.verify_parent(path, &parent)?;
        let existing = self.store.read_path_metadata(path)?.map(|entry| entry.state);
        if let Some(owner) = self.store.physical_owner_at(path)? {
            if existing
                .as_ref()
                .is_none_or(|state| state.id != owner.state.id)
            {
                return Err(Error::Busy(
                    "retained directory owner awaits namespace reconciliation",
                ));
            }
        }
        let mut imported = None;
        let state = if let Some(state) = existing {
            if state.kind != EntryKind::Folder {
                return Err(Error::UnsafePath(
                    "directory collides with logical file".into(),
                ));
            }
            if let Some(base) = self.store.directory_baseline(&state.id)? {
                if base.identity != identity || base.state.path != state.path {
                    return Err(Error::Busy(
                        "external directory replacement; provenance retained",
                    ));
                }
            }
            let binding = self.store.physical_binding(&state.id)?.ok_or(Error::Busy(
                "existing directory requires explicit physical enrollment",
            ))?;
            if binding.physical != physical || binding.state.path != *path {
                return Err(Error::Busy("directory binding or parent changed"));
            }
            if self.store.pending_directory_create(&state.id)? {
                return Err(Error::Busy(
                    "pending directory publication cannot be adopted as an import",
                ));
            }
            state
        } else {
            self.parent_imports(path)?;
            let request = MutationRequest {
                operation_id: new_op(),
                mutation: Mutation::Create {
                    id: new_id(),
                    path: path.clone(),
                    kind: EntryKind::Folder,
                    content: None,
                },
            };
            self.paths.verify_parent(path, &parent)?;
            if fs::identity(&self.paths.directory(path)?)? != identity {
                return Err(Error::Busy("directory replaced before import"));
            }
            let result = self.store.import_directory_bound(&request, &physical)?;
            let state = result
                .changes
                .iter()
                .find(|c| c.after.id == *request.mutation.id())
                .unwrap()
                .after
                .clone();
            imported = Some(result);
            state
        };
        self.paths.verify_parent(path, &parent)?;
        let current = self.paths.directory(path)?;
        if fs::identity(&current)? != identity {
            return Err(Error::Busy("directory replaced before import"));
        }
        self.store.bind_directory_bound(&state, &physical)?;
        Ok(imported)
    }
    pub(super) fn project_directory(&mut self, id: &EntryId) -> Result<()> {
        if !self.store.is_visible_entry(id)? {
            return Err(Error::Busy(
                "hidden directory retains its physical publication",
            ));
        }
        if let Some(entry) = self.store.read(id)? {
            self.namespace_clear(&entry.state.path)?;
        }
        if let Some(a) = self
            .store
            .directory_attempts(false)?
            .into_iter()
            .find(|a| a.target.id == *id)
        {
            return self.resume_directory(&a);
        }
        let current = self
            .store
            .read(id)?
            .ok_or(Error::Unsupported("directory deleted"))?;
        if current.state.kind != EntryKind::Folder {
            return Err(Error::Unsupported("not a folder"));
        }
        let (parent, name) = self.paths.parent(&current.state.path)?;
        if let Some(base) = self.store.directory_baseline(id)? {
            if base.state.path != current.state.path {
                return Err(Error::Unsupported("directory move"));
            }
            let disk = fs::optional_directory(&parent, &name)?
                .ok_or(Error::Unsupported("external directory deletion"))?;
            let binding = self
                .store
                .physical_binding(id)?
                .ok_or(Error::Busy("directory baseline is unproven"))?;
            if fs::identity(&disk)? != base.identity
                || binding.physical.inode != base.identity
                || binding.physical.parent_inode != fs::identity(&parent)?
            {
                return Err(Error::Busy("directory identity changed"));
            }
            self.paths.verify_parent(&current.state.path, &parent)?;
            // Child metadata can advance a folder's revision without changing
            // its publication witness. Store compares the immutable old/new
            // family records and advances only this proven same-inode binding.
            self.store
                .bind_directory_bound(&current.state, &binding.physical)?;
            return Ok(());
        }
        self.paths.verify_parent(&current.state.path, &parent)?;
        let a = self
            .store
            .begin_directory_projection_bound(id, &fs::identity(&parent)?)?;
        self.point("directory_prepared");
        self.resume_directory(&a)
    }
    pub(super) fn resume_directory(&mut self, a: &DirectoryAttempt) -> Result<()> {
        if !self.store.is_visible_entry(&a.target.id)? {
            return Err(Error::Busy(
                "hidden directory retains its physical publication",
            ));
        }
        self.paths.verify()?;
        let state = self
            .store
            .read(&a.target.id)?
            .ok_or(Error::Unsupported("directory deleted during publication"))?
            .state;
        if state.kind != EntryKind::Folder || state.path != a.target.path {
            return Err(Error::Unsupported("directory moved during publication"));
        }
        let (parent, name) = self.paths.parent(&state.path)?;
        let proof = self
            .store
            .publication_proof(&a.attempt_id)?
            .ok_or(Error::Busy(
                "unproven directory publication requires recovery",
            ))?;
        if proof.kind != PublicationKind::Directory
            || proof.entry_id != a.target.id
            || proof.parent_inode != fs::identity(&parent)?
            || self.store.physical_binding(&a.target.id)? != proof.expected_binding
        {
            return Err(Error::Busy(
                "directory publication binding or parent changed",
            ));
        }
        let staged_name = format!("{}.directory", a.attempt_id.as_str());
        if let Some(dest) = fs::optional_directory(&parent, &name)? {
            if a.stage_identity.as_ref() != Some(&fs::identity(&dest)?) {
                return Err(Error::Busy(
                    "directory destination exists; never adopted as staged inode",
                ));
            }
            dest.sync_all()?;
            parent.sync_all()?;
            self.point("directory_before_baseline");
            self.paths.verify_parent(&state.path, &parent)?;
            let acknowledged = fs::optional_directory(&parent, &name)?.ok_or(Error::Busy(
                "directory disappeared before recovery acknowledgement",
            ))?;
            if a.stage_identity.as_ref() != Some(&fs::identity(&acknowledged)?) {
                return Err(Error::Busy(
                    "directory replaced before recovery acknowledgement",
                ));
            }
            self.store.finish_directory_projection_bound(
                &a.attempt_id,
                &PhysicalIdentity {
                    inode: fs::identity(&dest)?,
                    parent_inode: proof.parent_inode.clone(),
                },
            )?;
            return Ok(());
        }
        let identity =
            if let Some(stage) = fs::optional_directory(&self.paths.private, &staged_name)? {
                let identity = fs::identity(&stage)?;
                if a.stage_identity
                    .as_ref()
                    .is_some_and(|old| *old != identity)
                {
                    return Err(Error::UnsafePath("directory stage replaced".into()));
                }
                if !fs::directory_names(&stage, 1, false)?.is_empty() {
                    return Err(Error::Busy("unexpected entries in private directory stage"));
                }
                stage.sync_all()?;
                self.paths.private.sync_all()?;
                identity
            } else {
                if a.stage_identity.is_some() {
                    return Err(Error::Busy(
                        "directory stage disappeared without publication proof",
                    ));
                }
                let identity = fs::stage_directory(&self.paths.private, &staged_name)?;
                self.point("directory_stage_written");
                identity
            };
        self.store.mark_directory_projection(
            &a.attempt_id,
            DirectoryPhase::Staged,
            Some(identity.clone()),
        )?;
        self.point("directory_staged");
        self.paths.verify_parent(&state.path, &parent)?;
        fs::rename_new(&self.paths.private, &staged_name, &parent, &name)?;
        self.paths.verify_parent(&state.path, &parent)?;
        self.point("directory_published_before_record");
        self.store
            .mark_directory_projection(&a.attempt_id, DirectoryPhase::Published, None)?;
        let dest = fs::optional_directory(&parent, &name)?
            .ok_or(Error::Busy("published directory disappeared"))?;
        if fs::identity(&dest)? != identity {
            return Err(Error::Busy("published directory replaced"));
        }
        dest.sync_all()?;
        parent.sync_all()?;
        self.paths.verify_parent(&state.path, &parent)?;
        self.point("directory_before_baseline");
        self.paths.verify_parent(&state.path, &parent)?;
        let still_named = fs::optional_directory(&parent, &name)?
            .ok_or(Error::Busy("directory disappeared before acknowledgement"))?;
        if fs::identity(&still_named)? != identity {
            return Err(Error::Busy("directory replaced before acknowledgement"));
        }
        self.store.finish_directory_projection_bound(
            &a.attempt_id,
            &PhysicalIdentity {
                inode: identity,
                parent_inode: proof.parent_inode,
            },
        )?;
        Ok(())
    }
}
