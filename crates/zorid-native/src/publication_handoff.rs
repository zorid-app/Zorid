//! Settle an interrupted file publication before attaching namespace work.
//! Only saved inode/parent evidence authorizes the old public path. Stages and
//! alternatives stay retained; a newer logical path never supplies ownership.
use super::content_stream::{file_snapshot, snapshot_matches_content};
use super::*;

impl NativeVault {
    pub(super) fn settle_namespace_publication(&mut self, a: &ProjectionAttempt) -> Result<()> {
        self.store.check_projection_for_namespace(a)?;
        self.paths.verify()?;
        let proof = self
            .store
            .publication_proof(&a.attempt_id)?
            .ok_or(Error::Busy(
                "namespace publication has no saved physical proof",
            ))?;
        if proof.kind != PublicationKind::File || proof.entry_id != a.target.state.id {
            return Err(Error::Busy("namespace publication proof differs"));
        }
        let path = &a.target.state.path;
        let (parent, name) = self.paths.parent(path)?;
        if fs::identity(&parent)? != proof.parent_inode
            || self.store.physical_binding(&a.target.state.id)? != proof.expected_binding
            || self.store.projection_baseline(&a.target.state.id)? != a.baseline
        {
            return Err(Error::Busy(
                "namespace publication parent or baseline changed",
            ));
        }
        let previous = format!("{}.previous", a.attempt_id.as_str());
        let stage = format!("{}.stage", a.attempt_id.as_str());
        let private = self.paths.private.try_clone()?;
        let mut dest = file_snapshot(&parent, &name)?;
        let backup = file_snapshot(&private, &previous)?;
        if let Some(old) = &backup {
            if proof
                .expected_binding
                .as_ref()
                .is_none_or(|b| b.physical.inode != old.identity)
                || a.baseline
                    .as_ref()
                    .is_none_or(|b| !snapshot_matches_content(old, &b.content))
            {
                self.capture_projection_file(a, &private, &previous)?;
                return Err(Error::Busy("displaced namespace source changed; retained"));
            }
        }
        // Publication may have completed before its durable phase marker. Adopt
        // precisely that historical target before the namespace journal moves it.
        if dest
            .as_ref()
            .is_some_and(|d| Some(&d.identity) == a.stage_identity.as_ref())
        {
            let disk = dest.as_ref().unwrap();
            if !snapshot_matches_content(disk, &a.target.content) {
                self.capture_projection_file(a, &parent, &name)?;
                return Err(Error::Busy("published namespace source changed; retained"));
            }
            self.paths.verify_parent(path, &parent)?;
            parent.sync_all()?;
            let final_disk = file_snapshot(&parent, &name)?
                .ok_or(Error::Busy("published namespace source disappeared"))?;
            if final_disk.identity != disk.identity
                || !snapshot_matches_content(&final_disk, &a.target.content)
            {
                self.capture_projection_file(a, &parent, &name)?;
                return Err(Error::Busy(
                    "published namespace source changed during handoff",
                ));
            }
            return Ok(self.store.finish_projection_for_namespace(
                a,
                Some(&PhysicalIdentity {
                    inode: disk.identity.clone(),
                    parent_inode: proof.parent_inode,
                }),
            )?);
        }
        // A recorded stage must still exist privately before cancellation. Its
        // disappearance could mean publication followed by an external replace.
        if let Some(identity) = &a.stage_identity {
            let staged = file_snapshot(&private, &stage)?
                .ok_or(Error::Busy("namespace publication stage disappeared"))?;
            if &staged.identity != identity
                || !snapshot_matches_content(&staged, &a.target.content)
                || a.phase == ProjectionPhase::Published
            {
                return Err(Error::Busy("namespace publication stage changed; retained"));
            }
        } else if a.phase != ProjectionPhase::Prepared || backup.is_some() {
            return Err(Error::Busy(
                "namespace publication lacks staging provenance",
            ));
        }
        if let Some(disk) = &dest {
            if backup.is_some()
                || proof
                    .expected_binding
                    .as_ref()
                    .is_none_or(|b| b.physical.inode != disk.identity)
                || a.baseline
                    .as_ref()
                    .is_none_or(|b| !snapshot_matches_content(disk, &b.content))
            {
                self.capture_projection_file(a, &parent, &name)?;
                return Err(Error::Busy("namespace source occupant changed; retained"));
            }
        } else if let Some(old) = &backup {
            // Undo only the proven displacement, into an absent destination.
            // NOREPLACE preserves a concurrently created external occupant.
            self.paths.verify_parent(path, &parent)?;
            fs::rename_new(&self.paths.private, &previous, &parent, &name)?;
            self.paths.verify_parent(path, &parent)?;
            let restored = file_snapshot(&parent, &name)?
                .ok_or(Error::Busy("restored namespace source disappeared"))?;
            if restored.identity != old.identity
                || restored.length != old.length
                || restored.digest != old.digest
            {
                self.capture_projection_file(a, &parent, &name)?;
                return Err(Error::Busy("restored namespace source changed"));
            }
            dest = Some(restored);
        } else if a.baseline.is_some() || proof.expected_binding.is_some() {
            return Err(Error::Busy(
                "namespace source absent without displacement proof",
            ));
        }
        self.paths.verify_parent(path, &parent)?;
        let final_disk = file_snapshot(&parent, &name)?;
        if final_disk
            .as_ref()
            .map(|d| (&d.identity, d.length, d.digest))
            != dest.as_ref().map(|d| (&d.identity, d.length, d.digest))
        {
            return Err(Error::Busy("namespace source changed before cancellation"));
        }
        self.store.finish_projection_for_namespace(a, None)?;
        Ok(())
    }
}

impl NativeVault {
    pub(super) fn settle_namespace_directory(
        &mut self,
        a: &zorid_store::DirectoryAttempt,
    ) -> Result<()> {
        use zorid_store::DirectoryPhase;
        self.store.check_directory_for_namespace(a)?;
        self.paths.verify()?;
        let proof = self
            .store
            .publication_proof(&a.attempt_id)?
            .ok_or(Error::Busy(
                "namespace directory publication has no saved proof",
            ))?;
        let (parent, name) = self.paths.parent(&a.target.path)?;
        if proof.kind != PublicationKind::Directory
            || proof.entry_id != a.target.id
            || proof.expected_binding.is_some()
            || fs::identity(&parent)? != proof.parent_inode
        {
            return Err(Error::Busy("namespace directory publication proof changed"));
        }
        if let Some(dest) = fs::optional_directory(&parent, &name)? {
            let inode = fs::identity(&dest)?;
            if a.stage_identity.as_ref() != Some(&inode) {
                return Err(Error::Busy(
                    "namespace directory destination is not its saved stage",
                ));
            }
            dest.sync_all()?;
            parent.sync_all()?;
            self.paths.verify_parent(&a.target.path, &parent)?;
            let final_dest = fs::optional_directory(&parent, &name)?
                .ok_or(Error::Busy("namespace directory publication disappeared"))?;
            if fs::identity(&final_dest)? != inode {
                return Err(Error::Busy("namespace directory publication was replaced"));
            }
            return Ok(self.store.finish_directory_for_namespace(
                a,
                Some(&PhysicalIdentity {
                    inode,
                    parent_inode: proof.parent_inode,
                }),
            )?);
        }
        let staged_name = format!("{}.directory", a.attempt_id.as_str());
        if let Some(identity) = &a.stage_identity {
            let stage = fs::optional_directory(&self.paths.private, &staged_name)?
                .ok_or(Error::Busy("namespace directory stage disappeared"))?;
            if fs::identity(&stage)? != *identity || a.phase == DirectoryPhase::Published {
                return Err(Error::Busy("namespace directory stage changed; retained"));
            }
        } else if a.phase != DirectoryPhase::Prepared {
            return Err(Error::Busy("namespace directory lacks staging provenance"));
        }
        if self.store.read(&a.target.id)?.is_some() {
            // A live Move must first fulfill the original create job at its
            // immutable path; its later namespace journal then owns relocation.
            // Cancelling here would strand a create obligation for the old path.
            let identity =
                if let Some(stage) = fs::optional_directory(&self.paths.private, &staged_name)? {
                    if !fs::directory_names(&stage, 1, false)?.is_empty() {
                        return Err(Error::Busy(
                            "unexpected entries in namespace directory stage",
                        ));
                    }
                    stage.sync_all()?;
                    self.paths.private.sync_all()?;
                    fs::identity(&stage)?
                } else {
                    fs::stage_directory(&self.paths.private, &staged_name)?
                };
            let staged = self.store.stage_directory_for_namespace(a, &identity)?;
            self.paths.verify_parent(&a.target.path, &parent)?;
            fs::rename_new(&self.paths.private, &staged_name, &parent, &name)?;
            self.paths.verify_parent(&a.target.path, &parent)?;
            let published = fs::optional_directory(&parent, &name)?
                .ok_or(Error::Busy("namespace directory publication disappeared"))?;
            if fs::identity(&published)? != identity {
                return Err(Error::Busy("namespace directory publication replaced"));
            }
            published.sync_all()?;
            parent.sync_all()?;
            self.paths.verify_parent(&a.target.path, &parent)?;
            let acknowledged = fs::optional_directory(&parent, &name)?.ok_or(Error::Busy(
                "namespace directory disappeared before handoff",
            ))?;
            if fs::identity(&acknowledged)? != identity {
                return Err(Error::Busy("namespace directory replaced before handoff"));
            }
            return Ok(self.store.finish_directory_for_namespace(
                &staged,
                Some(&PhysicalIdentity {
                    inode: identity,
                    parent_inode: proof.parent_inode,
                }),
            )?);
        }
        self.paths.verify_parent(&a.target.path, &parent)?;
        if fs::optional_directory(&parent, &name)?.is_some() {
            return Err(Error::Busy("namespace directory destination appeared"));
        }
        // The private stage, including any unexpected contents, remains retained.
        self.store.finish_directory_for_namespace(a, None)?;
        Ok(())
    }
}
