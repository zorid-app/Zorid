use super::*;
use zorid_store::{DirectoryAttempt, DirectoryPhase};
impl NativeVault {
    /// Imports an observed existing folder, or binds legacy imported metadata to
    /// its first physical identity. An existing baseline cannot be rebound.
    pub(super) fn observe_directory(&mut self, path: &VaultPath) -> Result<Option<CommitResult>> {
        self.namespace_clear(path)?;
        let (parent, name) = self.paths.parent(path)?;
        let folder =
            fs::optional_directory(&parent, &name)?.ok_or(Error::Busy("directory disappeared"))?;
        let identity = fs::identity(&folder)?;
        self.paths.verify_parent(path, &parent)?;
        let existing = self.store.list()?.into_iter().find(|s| s.path == *path);
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
            let result = self.store.import_directory(&request)?;
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
        self.store.bind_directory(&state, &identity)?;
        Ok(imported)
    }
    pub(super) fn project_directory(&mut self, id: &EntryId) -> Result<()> {
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
            if fs::identity(&disk)? != base.identity {
                return Err(Error::Busy("directory identity changed"));
            }
            self.paths.verify_parent(&current.state.path, &parent)?;
            return Ok(());
        }
        let a = self.store.begin_directory_projection(id)?;
        self.point("directory_prepared");
        self.resume_directory(&a)
    }
    pub(super) fn resume_directory(&mut self, a: &DirectoryAttempt) -> Result<()> {
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
        let staged_name = format!("{}.directory", a.attempt_id.as_str());
        if let Some(dest) = fs::optional_directory(&parent, &name)? {
            if a.stage_identity.as_ref() != Some(&fs::identity(&dest)?) {
                return Err(Error::Busy(
                    "directory destination exists; never adopted as staged inode",
                ));
            }
            dest.sync_all()?;
            parent.sync_all()?;
            self.paths.verify_parent(&state.path, &parent)?;
            self.store.finish_directory_projection(&a.attempt_id)?;
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
        self.store.finish_directory_projection(&a.attempt_id)?;
        Ok(())
    }
}
