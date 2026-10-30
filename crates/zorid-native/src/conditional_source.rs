//! Conditional history's physical source guard. Callers hold the same native
//! lock through verification and logical authorship. Uncooperative external
//! writers can still write after verification; normal no-clobber publication
//! remains mandatory and retains those later changes.
use super::*;
use crate::fs_stream;
use zorid_store::{
    HostSourceCaptureRequest, HostSourceGuard, HostSourceRequestLookup, HostSourceWitness,
};

#[cfg(test)]
#[path = "conditional_source_request_tests.rs"]
mod request_tests;

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
        request: &ConditionalSavedSourceRequest,
    ) -> Result<ConditionalSavedSourceCapture> {
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.verify_client_lease(lease).map_err(lease_error)?;
        self.paths.verify()?;
        if uuid::Uuid::parse_str(request.capture_id.as_str())
            .ok()
            .is_none_or(|id| id.hyphenated().to_string() != request.capture_id.as_str())
        {
            return Err(Error::Unsupported(
                "capture request ID must be a canonical UUID",
            ));
        }
        if request.logical_witness.path.as_str().len() > MAX_CONDITIONAL_SOURCE_PATH_BYTES {
            return Err(Error::ConditionalSource(ConditionalSourceError::Limit));
        }
        let stored = HostSourceCaptureRequest {
            capture_id: request.capture_id.clone(),
            logical_witness: HostSourceWitness {
                entry_id: request.logical_witness.entry_id.clone(),
                revision: request.logical_witness.revision.clone(),
                path: request.logical_witness.path.clone(),
            },
        };
        // Exact pending replay precedes every fresh count/byte admission check.
        // It keeps the original guard and original lease token unchanged.
        let outcome = match self
            .store
            .host_source_request(&lease.reference().client_id, &stored)?
        {
            HostSourceRequestLookup::Missing => self.capture_new_conditional_source(lease, request),
            HostSourceRequestLookup::Pending(capture) => {
                let mut source = Vec::new();
                self.verify_conditional_source_with(&capture.guard, |chunk| {
                    source.extend_from_slice(chunk);
                    Ok(())
                })
                .map(|()| ConditionalSavedSourceCapture {
                    capture_id: request.capture_id.clone(),
                    logical_witness: request.logical_witness.clone(),
                    source,
                })
            }
            HostSourceRequestLookup::Changed => return Err(changed()),
            HostSourceRequestLookup::Attached { .. } | HostSourceRequestLookup::Released => {
                return Err(Error::ConditionalSource(ConditionalSourceError::Closed))
            }
        };
        if matches!(
            &outcome,
            Err(Error::ConditionalSource(ConditionalSourceError::Changed))
        ) {
            self.verify_client_lease(lease).map_err(lease_error)?;
            self.paths.verify()?;
            return match self
                .store
                .record_host_source_request_changed(&lease.reference().client_id, &stored)?
            {
                HostSourceRequestLookup::Changed => Err(changed()),
                HostSourceRequestLookup::Attached { .. } | HostSourceRequestLookup::Released => {
                    Err(Error::ConditionalSource(ConditionalSourceError::Closed))
                }
                _ => Err(zorid_store::StoreError::Corrupt(
                    "changed capture request did not settle terminally".into(),
                )
                .into()),
            };
        }
        outcome
    }

    fn capture_new_conditional_source(
        &mut self,
        lease: &ClientLease,
        request: &ConditionalSavedSourceRequest,
    ) -> Result<ConditionalSavedSourceCapture> {
        let witness = &request.logical_witness;
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
        let limit = MAX_CONDITIONAL_SOURCE_BYTES.min(self.options.max_file_bytes) as u64;
        let file = fs::regular(&parent, &name)
            .map_err(public_path_error)?
            .ok_or_else(changed)?;
        let length = file.metadata()?.len();
        drop(file);
        if limit == 0 || length > limit {
            return Err(Error::ConditionalSource(ConditionalSourceError::Limit));
        }
        let (count, used) = self.store.host_source_capture_usage()?;
        let available = MAX_CONDITIONAL_SOURCE_TOTAL_BYTES.saturating_sub(used);
        if count >= MAX_CONDITIONAL_SOURCE_CAPTURES as u64 || length > available {
            return Err(Error::ConditionalSource(ConditionalSourceError::Capacity));
        }
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
            return Err(changed());
        }
        if snapshot.length > available {
            return Err(Error::ConditionalSource(ConditionalSourceError::Capacity));
        }
        // The bytes may differ from binding's saved baseline. That difference
        // is precisely what the conditional caller must inspect before editing.
        let capture_id = request.capture_id.clone();
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
            &lease.reference().client_id,
            &lease.reference().token,
            &guard,
        )? {
            return Err(Error::ConditionalSource(ConditionalSourceError::Capacity));
        }
        Ok(ConditionalSavedSourceCapture {
            capture_id,
            logical_witness: witness.clone(),
            source,
        })
    }

    pub fn list_conditional_saved_source_requests(
        &mut self,
        lease: &ClientLease,
    ) -> Result<Vec<PendingSavedSourceRequest>> {
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.verify_client_lease(lease).map_err(lease_error)?;
        self.paths.verify()?;
        let rows = self
            .store
            .host_source_pending_requests(&lease.reference().client_id)?;
        if rows.len() > MAX_CONDITIONAL_SOURCE_CAPTURES {
            return Err(zorid_store::StoreError::Corrupt(
                "pending capture request bound exceeded".into(),
            )
            .into());
        }
        Ok(rows
            .into_iter()
            .map(|row| PendingSavedSourceRequest {
                capture_id: row.capture_id,
                logical_witness: ConditionalSavedSourceWitness {
                    entry_id: row.logical_witness.entry_id,
                    revision: row.logical_witness.revision,
                    path: row.logical_witness.path,
                },
                legacy: row.legacy,
            })
            .collect())
    }

    pub fn release_conditional_saved_source(
        &mut self,
        lease: &ClientLease,
        capture_id: &OperationId,
    ) -> Result<()> {
        let _lock = self.paths.lock(self.options.lock_timeout)?;
        self.verify_client_lease(lease).map_err(lease_error)?;
        if !self
            .store
            .release_host_source_capture(&lease.reference().client_id, capture_id)?
        {
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
        self.store
            .retire_host_source_captures(&lease.reference().client_id, &lease.reference().token)?;
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
            match self
                .store
                .host_source_request_status(&lease.reference().client_id, capture_id)?
            {
                HostSourceRequestLookup::Changed => return Err(changed()),
                HostSourceRequestLookup::Released | HostSourceRequestLookup::Attached { .. } => {
                    return Err(Error::ConditionalSource(ConditionalSourceError::Closed))
                }
                HostSourceRequestLookup::Pending(_) => {
                    return Err(zorid_store::StoreError::Corrupt(
                        "pending request lost its capture guard".into(),
                    )
                    .into())
                }
                HostSourceRequestLookup::Missing => {}
            }
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
        self.verify_conditional_source_with(guard, |_| Ok(()))
    }
    fn verify_conditional_source_with(
        &self,
        guard: &HostSourceGuard,
        sink: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
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
        let snapshot = fs_stream::stream_snapshot(&parent, &name, guard.length, sink)
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
