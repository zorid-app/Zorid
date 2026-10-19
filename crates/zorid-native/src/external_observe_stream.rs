//! Family observations retain actual streamed bytes before causal import. A
//! content reference never substitutes for the saved public inode/parent proof.
use super::*;
use crate::fs_stream::StreamSnapshot;
use zorid_store::{ExternalObservation, ProjectionBaseline, Sha256Digest};

impl NativeVault {
    fn retain_streamed_observation(
        &mut self,
        path: &VaultPath,
        parent: &File,
        expected: &StreamSnapshot,
        origin: &OperationId,
        baseline: Option<&ProjectionBaseline>,
        proof: Option<&ObservationPhysical>,
        text: bool,
    ) -> Result<ExternalObservation> {
        self.paths.verify_parent(path, parent)?;
        let physical = PhysicalIdentity {
            inode: expected.identity.clone(),
            parent_inode: expected.parent_identity.clone(),
        };
        if let Some(observation) = self.store.find_matching_external_observation(
            &content_stream::core_client()?,
            path,
            baseline,
            proof,
            expected.length,
            &Sha256Digest(expected.digest),
        )? {
            // Keep the original observation ID and retained source, including
            // namespace pending-content captures. A locator match alone does
            // not prove that these bytes still occupy the observed public path.
            self.verify_observed_content(path, parent, &physical, &observation.content)?;
            return Ok(observation);
        }
        let content = self.capture_observed_file(
            path,
            parent,
            path.file_name(),
            origin,
            baseline,
            proof,
            expected,
            text,
        )?;
        self.verify_observed_content(path, parent, &physical, &content)?;
        self.retain_observed_content(path, baseline, &content, proof)
    }

    pub(super) fn observe_streamed_file(
        &mut self,
        path: &VaultPath,
        parent: &File,
        expected: &StreamSnapshot,
        origin: &OperationId,
    ) -> Result<Option<CommitResult>> {
        self.paths.verify_parent(path, parent)?;
        if !self.store.family_is_enrolled()? {
            return Err(Error::Unsupported(
                "streamed file observation requires family enrollment",
            ));
        }
        let state = self
            .store
            .read_path_metadata(path)?
            .map(|entry| entry.state);
        let owner = self.store.physical_owner_at(path)?;
        let physical = PhysicalIdentity {
            inode: expected.identity.clone(),
            parent_inode: expected.parent_identity.clone(),
        };
        match self.namespace_clear(path) {
            Ok(()) => {}
            Err(error @ Error::Busy(_)) => {
                // The namespace fence still wins. Only its exact visible,
                // historical public branch may journal an edit while blocked;
                // no attempt or covered job is settled by this retention.
                if let Some(owner) = owner.as_ref().filter(|owner| {
                    owner.state.kind == EntryKind::File
                        && owner.physical == physical
                        && state.as_ref().is_some_and(|state| {
                            state.id == owner.state.id
                                && state.path == owner.state.path
                                && state.kind == EntryKind::File
                                && !state.deleted
                        })
                }) {
                    if let Some(base) = self
                        .store
                        .projection_baseline(&owner.state.id)?
                        .filter(|base| base.state == owner.state)
                    {
                        if !snapshot_matches_content(expected, &base.content) {
                            let text = self.store.family_text_state(&owner.state.id)?.is_some();
                            self.retain_streamed_observation(
                                path,
                                parent,
                                expected,
                                origin,
                                Some(&base),
                                Some(&ObservationPhysical {
                                    physical: physical.clone(),
                                    expected_binding: Some(owner.clone()),
                                }),
                                text,
                            )?;
                        }
                    }
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        }
        if let Some(owner) = &owner {
            if state
                .as_ref()
                .is_none_or(|state| state.id != owner.state.id)
            {
                return Err(Error::Busy(
                    "retained physical owner is hidden or awaits namespace reconciliation",
                ));
            }
        }
        if state
            .as_ref()
            .is_some_and(|state| state.kind != EntryKind::File)
        {
            return Err(Error::UnsafePath(
                "filesystem file collides with logical folder".into(),
            ));
        }
        let baseline = match &state {
            Some(state) => self.store.projection_baseline(&state.id)?,
            None => None,
        };
        let binding = match &state {
            Some(state) => self.store.physical_binding(&state.id)?,
            None => None,
        };
        let text = match &state {
            Some(state) => self.store.family_text_state(&state.id)?.is_some(),
            None => false,
        };
        if binding
            .as_ref()
            .is_some_and(|binding| binding.physical.parent_inode != physical.parent_inode)
        {
            self.retain_streamed_observation(
                path,
                parent,
                expected,
                origin,
                baseline.as_ref(),
                None,
                text,
            )?;
            return Err(Error::Busy(
                "observation parent replaced; original binding retained",
            ));
        }
        if baseline.is_some() && binding.is_none() {
            self.retain_streamed_observation(
                path,
                parent,
                expected,
                origin,
                baseline.as_ref(),
                None,
                text,
            )?;
            return Err(Error::Busy(
                "unproven physical baseline requires explicit enrollment",
            ));
        }
        if let Some(base) = baseline.as_ref().filter(|base| {
            base.state.path == *path && snapshot_matches_content(expected, &base.content)
        }) {
            if binding
                .as_ref()
                .is_some_and(|binding| binding.physical == physical)
            {
                self.verify_observed_content(path, parent, &physical, &base.content)?;
                return Ok(None);
            }
            self.retain_streamed_observation(
                path,
                parent,
                expected,
                origin,
                Some(base),
                None,
                text,
            )?;
            return Err(Error::Busy(
                "equal-byte replacement has no original inode authority",
            ));
        }
        let active = self
            .store
            .projection_attempts(false)?
            .into_iter()
            .find(|attempt| attempt.target.state.path == *path);
        let proof = ObservationPhysical {
            physical: physical.clone(),
            expected_binding: binding,
        };
        let observation = self.retain_streamed_observation(
            path,
            parent,
            expected,
            origin,
            baseline.as_ref(),
            Some(&proof),
            text,
        )?;
        // An oversized Text alternative is retained through an inert capture.
        // Its immutable mode does not become Binary, and no stage is cancelled
        // merely to attempt an unsupported Text import.
        if text && observation.content.inline_bytes().is_none() {
            return Err(Error::Unsupported(
                "external text exceeds supported inline limit",
            ));
        }
        if let Some(active) = active {
            let previous = format!("{}.previous", active.attempt_id.as_str());
            let undisplaced = matches!(
                active.phase,
                ProjectionPhase::Prepared | ProjectionPhase::Staged
            ) && active.stage_identity.as_ref() != Some(&expected.identity)
                && fs::node_type(&self.paths.private, &previous)?.is_none();
            if text && undisplaced {
                self.paths.verify_parent(path, parent)?;
                self.store.finish_projection(&active.attempt_id, false)?;
            } else {
                return Err(Error::Busy(
                    "unresolved projection; external observation retained",
                ));
            }
        }
        if state.is_none() || baseline.is_none() {
            return Err(Error::Unsupported(
                "new external files require explicit family mode enrollment",
            ));
        }
        self.verify_observed_content(path, parent, &physical, &observation.content)?;
        self.paths.verify_parent(path, parent)?;
        Ok(Some(self.store.import_family_observation_content(
            &content_stream::core_client()?,
            &observation.observation_id,
        )?))
    }
}
