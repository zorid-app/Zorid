//! Settle an interrupted file publication before attaching namespace work.
//! Only saved inode/parent evidence authorizes the old public path. Stages and
//! alternatives stay retained; a newer logical path never supplies ownership.
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
        let mut dest = fs::snapshot(&parent, &name, self.options.max_file_bytes)?;
        let backup = fs::snapshot(&self.paths.private, &previous, self.options.max_file_bytes)?;
        if let Some(old) = &backup {
            if proof
                .expected_binding
                .as_ref()
                .is_none_or(|b| b.physical.inode != old.identity)
                || a.baseline.as_ref().is_none_or(|b| b.content != old.bytes)
            {
                self.capture(a, old.bytes.clone())?;
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
            if disk.bytes != a.target.content {
                self.capture(a, disk.bytes.clone())?;
                return Err(Error::Busy("published namespace source changed; retained"));
            }
            self.paths.verify_parent(path, &parent)?;
            parent.sync_all()?;
            let final_disk = fs::snapshot(&parent, &name, self.options.max_file_bytes)?
                .ok_or(Error::Busy("published namespace source disappeared"))?;
            if final_disk.identity != disk.identity || final_disk.bytes != a.target.content {
                self.capture(a, final_disk.bytes)?;
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
            let staged = fs::snapshot(&self.paths.private, &stage, self.options.max_file_bytes)?
                .ok_or(Error::Busy("namespace publication stage disappeared"))?;
            if &staged.identity != identity
                || staged.bytes != a.target.content
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
                || a.baseline.as_ref().is_none_or(|b| b.content != disk.bytes)
            {
                self.capture(a, disk.bytes.clone())?;
                return Err(Error::Busy("namespace source occupant changed; retained"));
            }
        } else if let Some(old) = &backup {
            // Undo only the proven displacement, into an absent destination.
            // NOREPLACE preserves a concurrently created external occupant.
            self.paths.verify_parent(path, &parent)?;
            fs::rename_new(&self.paths.private, &previous, &parent, &name)?;
            self.paths.verify_parent(path, &parent)?;
            let restored = fs::snapshot(&parent, &name, self.options.max_file_bytes)?
                .ok_or(Error::Busy("restored namespace source disappeared"))?;
            if restored.identity != old.identity || restored.bytes != old.bytes {
                self.capture(a, restored.bytes)?;
                return Err(Error::Busy("restored namespace source changed"));
            }
            dest = Some(restored);
        } else if a.baseline.is_some() || proof.expected_binding.is_some() {
            return Err(Error::Busy(
                "namespace source absent without displacement proof",
            ));
        }
        self.paths.verify_parent(path, &parent)?;
        let final_disk = fs::snapshot(&parent, &name, self.options.max_file_bytes)?;
        if final_disk.as_ref().map(|d| (&d.identity, &d.bytes))
            != dest.as_ref().map(|d| (&d.identity, &d.bytes))
        {
            return Err(Error::Busy("namespace source changed before cancellation"));
        }
        self.store.finish_projection_for_namespace(a, None)?;
        Ok(())
    }
}
