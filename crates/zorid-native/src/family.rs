//! Current-format family transactions. Local locks cover persistence and attempted
//! projection only; callers perform network I/O after these methods return.
use super::*;
use zorid_client_sync::{CursorAdvance, ReceiveCursor};
use zorid_crypto::{OpenedEnvelope, VaultKey};
use zorid_store::{FamilyPublication, FamilyScope};
use zorid_sync_protocol::{ExpectedContext, RealmId, UpdateId, VaultId};

impl NativeVault {
    pub fn family_enroll(&mut self, scope: &FamilyScope) -> Result<FamilyStatus> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_enroll(scope)?)
    }
    /// Scalar authority readiness only; full diagnostics remain family_status.
    pub fn family_enrollment_ready(&self) -> Result<bool> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_enrollment_ready()?)
    }
    pub fn family_status(&self) -> Result<FamilyStatus> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_status()?)
    }
    pub fn family_pending_authored(
        &self,
        after: Option<&UpdateId>,
        limit: u32,
    ) -> Result<Vec<FamilyAuthoredStatus>> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_pending_authored(after, limit)?)
    }
    pub fn family_seal(&mut self, expected: &ExpectedContext, key: &VaultKey) -> Result<Vec<u8>> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_seal(expected, key)?)
    }
    pub fn family_ack(
        &mut self,
        realm: &RealmId,
        vault: &VaultId,
        update: &UpdateId,
        wire: &[u8],
    ) -> Result<()> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_ack(realm, vault, update, wire)?)
    }
    pub fn family_receive_cursor(
        &self,
        realm: &RealmId,
        vault: &VaultId,
    ) -> Result<Option<ReceiveCursor>> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_receive_cursor(realm, vault)?)
    }
    /// Initialize the zero cursor or retry the exact current value. Store rejects
    /// forward skips and epoch replacement; only atomic receive advances progress.
    pub fn family_set_receive_cursor(
        &mut self,
        expected: Option<&ReceiveCursor>,
        next: &ReceiveCursor,
    ) -> Result<()> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_set_receive_cursor(expected, next)?)
    }
    pub fn family_envelope_status(
        &self,
        update: &UpdateId,
    ) -> Result<Option<FamilyEnvelopeStatus>> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_envelope_status(update)?)
    }
    /// Commit the logical operation first. Physical errors retain the exact
    /// receipt; a Pending result never authorizes retry under another operation ID.
    pub fn family_apply(
        &mut self,
        request: &MutationRequest,
        mode: Option<FamilyCreateMode>,
    ) -> Result<ApplyOutcome> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.family_apply_locked(request, mode)
    }
    /// Caller holds the native vault lock. Legacy request/mode dispatch keeps
    /// its ordinary Store error mapping and delegates to the same composite core.
    pub(super) fn family_apply_locked(&mut self, request: &MutationRequest,
        mode: Option<FamilyCreateMode>) -> Result<ApplyOutcome> {
        self.paths.verify()?;
        self.validate_conditional_operation(request)?;
        let commit = self.store.family_apply(request, mode)?;
        Ok(self.family_apply_projection(commit, request.mutation.id()))
    }
    pub fn family_apply_command(&mut self, command: &FamilyCommand) -> Result<ApplyOutcome> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.family_apply_command_locked(command)
    }
    fn family_apply_command_locked(&mut self, command: &FamilyCommand) -> Result<ApplyOutcome> {
        self.paths.verify()?;
        self.validate_conditional_operation(&command.request)?;
        let commit = self.store.family_apply_command(command)?;
        Ok(self.family_apply_projection(commit, command.request.mutation.id()))
    }
    fn family_apply_projection(&mut self, commit: CommitResult, id: &EntryId) -> ApplyOutcome {
        self.point("family_committed");
        let projection = match self.recover_locked() {
            Ok(report) if report.blocked.is_empty() => {
                self.family_project_status(id)
            }
            Ok(report) => {
                let _ = self.capture_local_recovery(id, super::local_recovery::now_ms(), zorid_recovery::SnapshotProvenance::SaveFailure);
                ProjectionStatus::Pending(report.blocked[0].1.clone())
            }
            Err(error) => {
                let _ = self.capture_local_recovery(id, super::local_recovery::now_ms(), zorid_recovery::SnapshotProvenance::SaveFailure);
                ProjectionStatus::Pending(error.to_string())
            }
        };
        ApplyOutcome { commit, projection }
    }
    /// Fresh compact Move/Delete preflights a bounded root summary. The entire
    /// composite survives Store preparation/receipt replay. Recovery may leave
    /// original physical responsibility pending; status reads its durable job.
    pub fn family_apply_command_compact(&mut self, command: &FamilyCommand) -> Result<FamilyCommandStatus> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        self.validate_conditional_operation(&command.request)?;
        self.store.family_apply_command_compact(command)?;
        self.point("family_committed");
        let _ = self.recover_locked();
        Ok(self.store.family_command_status(command)?)
    }
    /// Pure original-operation status; never projects or substitutes today's entry.
    pub fn family_command_status(&self, command: &FamilyCommand) -> Result<FamilyCommandStatus> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.family_command_status(command)?)
    }
    /// Authentication is supplied as an opaque capability. Store atomically
    /// commits wire, graph, prerequisites, jobs and cursor before projection.
    pub fn family_receive(
        &mut self,
        opened: &OpenedEnvelope,
        delivery: Option<&CursorAdvance>,
    ) -> Result<FamilyReceiveOutcome> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let commit = self.store.family_receive(opened, delivery)?;
        self.point("family_received_committed");
        // Receipts stay durable even if attachment or filesystem recovery fails.
        // Duplicate delivery must also retry retained physical responsibility.
        let mut projection = match self.recover_locked() {
            Ok(report) if report.blocked.is_empty() => ProjectionStatus::Projected,
            Ok(report) => ProjectionStatus::Pending(report.blocked[0].1.clone()),
            Err(error) => ProjectionStatus::Pending(error.to_string()),
        };
        for id in &commit.changed_entry_ids {
            let status = self.family_project_status(id);
            if matches!(status, ProjectionStatus::Pending(_)) {
                projection = status;
            }
        }
        // Duplicate delivery can have no changed IDs while its original durable
        // physical job remains pending. Do not turn that retry into a false ACK.
        match self.store.family_status() {
            Ok(status)
                if status.pending_projection != "0"
                    || status.pending_dependencies != "0"
                    || status.recovery_entries != "0" =>
            {
                projection = ProjectionStatus::Pending(
                    "durable family dependencies, recovery entries, or physical work remain pending".into(),
                );
            }
            Err(error) => projection = ProjectionStatus::Pending(error.to_string()),
            _ => {}
        }
        Ok(FamilyReceiveOutcome { commit, projection })
    }
    pub(super) fn family_project_status(&mut self, id: &EntryId) -> ProjectionStatus {
        let result = (|| -> Result<()> {
            let materialization = self
                .store
                .family_materialization(id)?
                .ok_or(Error::Busy("family publication witness missing"))?;
            for job in self.store.pending_namespace_jobs()? {
                if job.affected.iter().any(|change| {
                    change.after.id == *id
                        || change
                            .before
                            .as_ref()
                            .is_some_and(|before| before.id == *id)
                }) {
                    return Err(Error::Busy(
                        "family namespace publication lacks physical provenance attachment",
                    ));
                }
            }
            let path = match materialization.publication {
                FamilyPublication::Normal { path, .. } => path,
                FamilyPublication::Tombstone => {
                    if self.store.physical_binding(id)?.is_some()
                        || self.store.projection_baseline(id)?.is_some()
                        || self.store.directory_baseline(id)?.is_some()
                    {
                        return Err(Error::Busy(
                            "family deletion retains active physical ownership",
                        ));
                    }
                    return Ok(());
                }
                _ => return Err(Error::Busy("family entry awaits dependencies or recovery")),
            };
            self.namespace_clear(&path)?;
            // Requires the schema8 store publication-history hook: completion
            // records the exact revision/frontier/content witness actually
            // published, even if the current desired graph has advanced.
            // Existing no-clobber projection records divergence; never invoke
            // legacy observation/import, which would author the wrong family.
            self.project(id)?;
            // Includes project()'s already-current fast path. Success requires
            // the actual baseline and its immutable family publication witness,
            // not merely desired graph state or matching file bytes.
            self.store.family_assert_projected(id)?;
            Ok(())
        })();
        let provenance = if result.is_ok() { zorid_recovery::SnapshotProvenance::Periodic } else { zorid_recovery::SnapshotProvenance::SaveFailure };
        let _ = self.capture_local_recovery(id, super::local_recovery::now_ms(), provenance);
        match result {
            Ok(()) => ProjectionStatus::Projected,
            Err(error) => ProjectionStatus::Pending(error.to_string()),
        }
    }
}
