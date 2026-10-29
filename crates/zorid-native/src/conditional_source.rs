//! Conditional history's physical source guard. Callers hold the same native
//! lock through verification and logical authorship. Uncooperative external
//! writers can still write after verification; normal no-clobber publication
//! remains mandatory and retains those later changes.
use super::*;
use crate::fs_stream;
use zorid_store::HostSourceGuard;

fn changed() -> Error {
    Error::ConditionalSource(ConditionalSourceError::Changed)
}
fn lease_error(error: ClientAdmissionError) -> Error {
    match error {
        ClientAdmissionError::Native(error) => error,
        _ => Error::ConditionalSource(ConditionalSourceError::Owner),
    }
}
/// A known public-path mismatch is a definitive failed precondition. Unknown IO
/// remains retryable uncertainty; never settle a semantic rejection for it.
fn public_path_error(error: Error) -> Error {
    match &error {
        Error::UnsafePath(_) | Error::Busy(_) => changed(),
        Error::Io(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) || error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) =>
        {
            changed()
        }
        Error::Unsupported("stream source exceeds configured limit") => changed(),
        _ => error,
    }
}

impl NativeVault {
    /// Persist inert evidence before returning its identity. An exact same-client
    /// current lease can resume it after host loss; explicit release durably
    /// retires only the named lease's unattached captures before kernel unlock.
    pub fn capture_conditional_saved_source(
        &mut self,
        lease: &ClientLease,
        witness: &ConditionalSavedSourceWitness,
    ) -> Result<ConditionalSavedSourceCapture> {
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.verify_client_lease(lease).map_err(lease_error)?;
        self.paths.verify()?;
        let (count, used) = self.store.host_source_capture_usage()?;
        if witness.path.as_str().len() > MAX_CONDITIONAL_SOURCE_PATH_BYTES
            || count >= MAX_CONDITIONAL_SOURCE_CAPTURES as u64
        {
            return Err(Error::ConditionalSource(ConditionalSourceError::Limit));
        }
        let available = MAX_CONDITIONAL_SOURCE_TOTAL_BYTES.saturating_sub(used);
        let limit =
            (MAX_CONDITIONAL_SOURCE_BYTES.min(self.options.max_file_bytes) as u64).min(available);
        if limit == 0 {
            return Err(Error::ConditionalSource(ConditionalSourceError::Limit));
        }
        let entry = self
            .store
            .read_path_metadata(&witness.path)?
            .ok_or_else(changed)?;
        if entry.state.id != witness.entry_id
            || entry.state.revision != witness.revision
            || entry.state.deleted
            || entry.state.kind != EntryKind::File
        {
            return Err(changed());
        }
        if !self.store.family_enrollment_ready()?
            || self.store.family_text_state(&witness.entry_id)?.is_none()
        {
            return Err(Error::Unsupported(
                "conditional saved-source capture requires enrolled Text",
            ));
        }
        let binding = self
            .store
            .physical_binding(&witness.entry_id)?
            .ok_or_else(changed)?;
        if binding.state.id != witness.entry_id
            || binding.state.path != witness.path
            || binding.state.deleted
            || binding.state.kind != EntryKind::File
        {
            return Err(changed());
        }
        self.namespace_clear(&witness.path)?;
        let (parent, name) = self
            .paths
            .parent(&witness.path)
            .map_err(public_path_error)?;
        let mut source = Vec::new();
        let snapshot = fs_stream::stream_snapshot(&parent, &name, limit, |chunk| {
            source.extend_from_slice(chunk);
            Ok(())
        })
        .map_err(|error| match error {
            Error::Unsupported("stream source exceeds configured limit") => {
                Error::ConditionalSource(ConditionalSourceError::Limit)
            }
            other => public_path_error(other),
        })?
        .ok_or_else(changed)?;
        self.paths
            .verify_parent(&witness.path, &parent)
            .map_err(public_path_error)?;
        if snapshot.identity != binding.physical.inode
            || snapshot.parent_identity != binding.physical.parent_inode
        {
            return Err(changed());
        }
        if !snapshot.valid_utf8 || snapshot.has_nul {
            return Err(Error::Unsupported(
                "conditional saved-source capture requires UTF-8 Text",
            ));
        }
        // The bytes may differ from binding's saved baseline. That difference
        // is precisely what the conditional caller must inspect before editing.
        let capture_id = new_op();
        let guard = HostSourceGuard {
            version: 1,
            capture_id: capture_id.clone(),
            local_store_id: lease.reference().local_store_id.clone(),
            logical_state: entry.state,
            binding,
            length: snapshot.length,
            digest: zorid_store::Sha256Digest(snapshot.digest),
        };
        if !self.store.register_host_source_capture(
            &lease.reference().client_id, &lease.reference().token, &guard,
        )? { return Err(Error::ConditionalSource(ConditionalSourceError::Limit)); }
        Ok(ConditionalSavedSourceCapture {
            capture_id,
            logical_witness: witness.clone(),
            source,
        })
    }

    pub fn release_conditional_saved_source(
        &mut self,
        lease: &ClientLease,
        capture_id: &OperationId,
    ) -> Result<()> {
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.verify_client_lease(lease).map_err(lease_error)?;
        if !self.store.release_host_source_capture(&lease.reference().client_id, capture_id)? {
            return Err(Error::ConditionalSource(ConditionalSourceError::Owner));
        }
        Ok(())
    }

    /// Persist exact-token revocation before dropping the authenticated kernel
    /// lease. Prepared guards belong to their durable intent and survive this.
    /// A failed storage write leaves ownership held so release may retry.
    pub fn retire_conditional_saved_sources(&mut self, lease: &ClientLease) -> Result<()> {
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.verify_client_lease(lease).map_err(lease_error)?;
        self.store.retire_host_source_captures(&lease.reference().client_id, &lease.reference().token)?;
        Ok(())
    }

    pub fn prepare_guarded_host_intent(
        &mut self,
        lease: &ClientLease,
        request: &MutationRequest,
        capture_id: &OperationId,
    ) -> Result<HostIntentView> {
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.verify_client_lease(lease).map_err(lease_error)?;
        self.paths.verify()?;
        // Existing prepared/committed/rejected outcomes take precedence over
        // transient capture lifetime, including a lost reply across restart.
        if let Some(existing) = self.store.replay_guarded_host_intent(
            &lease.reference().client_id,
            request,
            capture_id,
        )? {
            return Ok(existing);
        }
        if !matches!(&request.mutation, Mutation::Write { content, .. } if content.len() <= self.options.max_file_bytes)
        {
            return Err(Error::Unsupported(
                "guarded host intent requires a bounded Write",
            ));
        }
        let Some(capture) = self.store.host_source_capture(capture_id)? else {
            return Ok(self.store.prepare_rejected_guarded_host_intent(
                &lease.reference().client_id,
                request,
                capture_id,
                HostRejectionCode::SourceCaptureExpired,
            )?);
        };
        if capture.client_id != lease.reference().client_id {
            return Err(Error::ConditionalSource(ConditionalSourceError::Owner));
        }
        if !matches!(&request.mutation, Mutation::Write { id, expected, .. }
            if id == &capture.guard.logical_state.id && expected == &capture.guard.logical_state.revision)
        {
            return Err(zorid_core::ContractError::InvalidMutation {
                reason: "conditional capture does not match the requested Write".into(),
            }
            .into());
        }
        if let Err(error) = self.verify_conditional_source(&capture.guard) {
            if matches!(
                error,
                Error::ConditionalSource(ConditionalSourceError::Changed)
            ) {
                let rejected = self.store.prepare_rejected_captured_host_intent(
                    &lease.reference().client_id,
                    &capture.lease_token,
                    request,
                    &capture.guard,
                    HostRejectionCode::ConditionalSourceChanged,
                )?;
                return Ok(rejected);
            }
            return Err(error);
        }
        let result = self.store.prepare_captured_host_intent(
            &lease.reference().client_id,
            &capture.lease_token,
            request,
            &capture.guard,
        )?;
        self.point("conditional_intent_prepared");
        Ok(result)
    }

    fn verify_conditional_source(&self, guard: &HostSourceGuard) -> Result<()> {
        self.paths.verify()?;
        if self.store.identity()?.local_store_id != guard.local_store_id
            || self
                .store
                .read_path_metadata(&guard.logical_state.path)?
                .is_none_or(|entry| entry.state != guard.logical_state)
            || self
                .store
                .physical_binding(&guard.logical_state.id)?
                .as_ref()
                != Some(&guard.binding)
        {
            return Err(changed());
        }
        self.namespace_clear(&guard.logical_state.path)?;
        let (parent, name) = self
            .paths
            .parent(&guard.logical_state.path)
            .map_err(public_path_error)?;
        let snapshot = fs_stream::stream_snapshot(&parent, &name, guard.length, |_| Ok(()))
            .map_err(public_path_error)?
            .ok_or_else(changed)?;
        self.paths
            .verify_parent(&guard.logical_state.path, &parent)
            .map_err(public_path_error)?;
        if snapshot.identity != guard.binding.physical.inode
            || snapshot.parent_identity != guard.binding.physical.parent_inode
            || snapshot.length != guard.length
            || snapshot.digest != guard.digest.0
            || !snapshot.valid_utf8
            || snapshot.has_nul
        {
            return Err(changed());
        }
        self.point("conditional_source_verified");
        Ok(())
    }

    /// Every native entry point reaching this reserved operation uses the same
    /// proof. An existing committed receipt wins over all later filesystem edits.
    pub(super) fn validate_conditional_operation(&self, request: &MutationRequest) -> Result<()> {
        let Some(guard) = self
            .store
            .host_operation_source_guard(&request.operation_id)?
        else {
            return Ok(());
        };
        if self
            .store
            .host_intent_for_operation(&request.operation_id)?
            .is_some_and(|intent| intent.state == HostIntentState::Committed)
        {
            return Ok(());
        }
        self.verify_conditional_source(&guard)
    }
}
