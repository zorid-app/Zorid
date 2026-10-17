//! Native ownership checks around Store-issued binary stage and read handles.
//! Serialized locators never construct stage authority or verified read sessions.
//! A post-operation filesystem failure may follow a durable Store commit; callers
//! must resume the same client/operation or pin rather than invent replacement IDs.
use super::*;
use zorid_store::{
    BinaryReadChunk, BinaryReadRef, BinaryReadSession, BinarySourceRef, BinaryStageRef,
    BinaryStageRequest, BinaryStageStatus, CapturedBinaryRef, ContentMetadata, Sha256Digest,
    StageChunkReceipt, StagedBinaryRef, StoredEntryMetadata, StreamingLimits,
    BINARY_STAGE_MAX_CHUNK_BYTES,
};

impl NativeVault {
    pub fn read_metadata(&self, id: &EntryId) -> Result<Option<StoredEntryMetadata>> {
        self.paths.verify()?;
        let outcome = self.store.read_metadata(id);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn read_path_metadata(&self, path: &VaultPath) -> Result<Option<StoredEntryMetadata>> {
        self.paths.verify()?;
        let outcome = self.store.read_path_metadata(path);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn binary_stage_request(&self, reference: &BinaryStageRef) -> Result<BinaryStageRequest> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.binary_stage_request(reference);
        self.paths.verify()?;
        Ok(outcome?)
    }

    /// Authorization is durable before planning. Retry the same stage after an
    /// uncertain response; authorization alone does not mean publication.
    pub fn request_commit_binary_stage(
        &mut self,
        reference: &BinaryStageRef,
    ) -> Result<BinaryStageStatus> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.request_commit_binary_stage(reference);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn commit_binary_stage(&mut self, reference: &BinaryStageRef) -> Result<ApplyOutcome> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let authorized = self.store.request_commit_binary_stage(reference);
        self.paths.verify()?;
        authorized?;
        let outcome = self.store.commit_binary_stage(reference);
        self.paths.verify()?;
        let committed = outcome?;
        self.point("family_committed");
        let mut projection = match self.recover_locked() {
            Ok(report) if report.blocked.is_empty() => {
                self.family_project_status(&committed.target_id)
            }
            Ok(report) => ProjectionStatus::Pending(report.blocked[0].1.clone()),
            Err(error) => ProjectionStatus::Pending(error.to_string()),
        };
        if matches!(projection, ProjectionStatus::Projected) {
            for id in &committed.projection_job_ids {
                match self.store.projection_job(id) {
                    Ok(job) if job.completed => {}
                    Ok(_) => {
                        projection = ProjectionStatus::Pending(
                            "original binary publication job remains pending".into(),
                        );
                        break;
                    }
                    Err(error) => {
                        projection = ProjectionStatus::Pending(error.to_string());
                        break;
                    }
                }
            }
        }
        Ok(ApplyOutcome {
            commit: committed.receipt,
            projection,
        })
    }

    /// Inspect only the original committed publication jobs. This query does
    /// not recover files or reinterpret a terminal receipt against newer state.
    pub fn binary_stage_projection_status(
        &self,
        reference: &BinaryStageRef,
    ) -> Result<ProjectionStatus> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = (|| {
            let status = self.store.query_binary_stage(reference)?;
            let Some(zorid_store::BinaryStageTerminal::Committed(committed)) = status.terminal
            else {
                return Ok(ProjectionStatus::Pending(
                    "binary stage has no committed publication".into(),
                ));
            };
            for id in &committed.projection_job_ids {
                if !self.store.projection_job(id)?.completed {
                    return Ok(ProjectionStatus::Pending(
                        "original binary publication job remains pending".into(),
                    ));
                }
            }
            Ok(ProjectionStatus::Projected)
        })();
        self.paths.verify()?;
        outcome
    }

    /// Exact Open retries return the original view before reading newer state.
    /// Caller read IDs and server-issued pin IDs have separate lifetimes.
    pub fn open_binary_read(
        &mut self,
        client: &OperationId,
        read_id: &OperationId,
        id: &EntryId,
        expected_revision: Option<&Revision>,
    ) -> Result<BinaryReadSession> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        if let Some(reference) = self
            .store
            .list_binary_reads(client)?
            .into_iter()
            .find(|reference| reference.read_id() == read_id)
        {
            let session = self.store.resume_binary_read(client, reference.pin_id())?;
            let state = session.state().ok_or_else(|| {
                Error::Contract(zorid_core::ContractError::IdempotencyConflict {
                    operation_id: read_id.clone(),
                })
            })?;
            if state.id != *id {
                return Err(zorid_core::ContractError::IdempotencyConflict {
                    operation_id: read_id.clone(),
                }
                .into());
            }
            if let Some(expected) =
                expected_revision.filter(|expected| *expected != &state.revision)
            {
                return Err(zorid_core::ContractError::RevisionConflict {
                    id: id.clone(),
                    expected: expected.clone(),
                    actual: state.revision.clone(),
                }
                .into());
            }
            self.paths.verify()?;
            return Ok(session);
        }
        let entry = self
            .store
            .read_metadata(id)?
            .ok_or_else(|| zorid_core::ContractError::EntryNotFound { id: id.clone() })?;
        if entry.state.deleted {
            return Err(zorid_core::ContractError::EntryDeleted { id: id.clone() }.into());
        }
        if !self.store.is_visible_entry(id)? {
            return Err(Error::Busy("hidden entry retains its physical publication"));
        }
        if let Some(expected) =
            expected_revision.filter(|expected| *expected != &entry.state.revision)
        {
            return Err(zorid_core::ContractError::RevisionConflict {
                id: id.clone(),
                expected: expected.clone(),
                actual: entry.state.revision.clone(),
            }
            .into());
        }
        let source = match &entry.content {
            Some(ContentMetadata::BinaryRef {
                reference: BinarySourceRef::Graph(source),
            }) => source,
            Some(ContentMetadata::BinaryRef { .. }) => {
                return Err(zorid_store::StoreError::Corrupt(
                    "current publication contains an inert capture".into(),
                )
                .into())
            }
            _ => return Err(Error::Unsupported("entry has no binary stream publication")),
        };
        let outcome = self
            .store
            .open_binary_read_with_id(client, read_id, &entry.state, source);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn begin_binary_stage(
        &mut self,
        client: &OperationId,
        operation: &OperationId,
        request: &BinaryStageRequest,
        limits: StreamingLimits,
    ) -> Result<BinaryStageRef> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self
            .store
            .begin_binary_stage(client, operation, request, limits);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn resume_binary_stage(
        &self,
        client: &OperationId,
        operation: &OperationId,
    ) -> Result<Option<BinaryStageRef>> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.resume_binary_stage(client, operation);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn append_binary_chunk(
        &mut self,
        reference: &BinaryStageRef,
        sequence: u32,
        offset: u64,
        bytes: &[u8],
    ) -> Result<StageChunkReceipt> {
        // Bound caller input before acquiring locks or entering Store.
        if bytes.len() > BINARY_STAGE_MAX_CHUNK_BYTES {
            return Err(Error::Unsupported("binary stage chunk exceeds 128 KiB"));
        }
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self
            .store
            .append_binary_chunk(reference, sequence, offset, bytes);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn query_binary_stage(&self, reference: &BinaryStageRef) -> Result<BinaryStageStatus> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.query_binary_stage(reference);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn seal_binary_stage(
        &mut self,
        reference: &BinaryStageRef,
        final_length: u64,
        expected_digest: Option<Sha256Digest>,
    ) -> Result<StagedBinaryRef> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self
            .store
            .seal_binary_stage(reference, final_length, expected_digest);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn abort_binary_stage(&mut self, reference: &BinaryStageRef) -> Result<()> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.abort_binary_stage(reference);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn open_capture_read(
        &mut self,
        client: &OperationId,
        source: &CapturedBinaryRef,
    ) -> Result<BinaryReadSession> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.open_capture_read(client, source);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn resume_binary_read(
        &self,
        client: &OperationId,
        pin_id: &OperationId,
    ) -> Result<BinaryReadSession> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.resume_binary_read(client, pin_id);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn read_binary_range(
        &self,
        session: &BinaryReadSession,
        offset: u64,
        max: u32,
    ) -> Result<BinaryReadChunk> {
        self.paths.verify()?;
        let outcome = self.store.read_binary_range(session, offset, max);
        self.paths.verify()?;
        Ok(outcome?)
    }

    pub fn close_binary_read(&mut self, reference: &BinaryReadRef) -> Result<()> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let outcome = self.store.close_binary_read(reference);
        self.paths.verify()?;
        Ok(outcome?)
    }
}
