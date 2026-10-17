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
    /// Caller holds the native vault lock. Shared by direct family commands and
    /// durable editor Write intents; never reacquire the lock during dispatch.
    pub(super) fn family_apply_locked(
        &mut self,
        request: &MutationRequest,
        mode: Option<FamilyCreateMode>,
    ) -> Result<ApplyOutcome> {
        self.paths.verify()?;
        let commit = self.store.family_apply(request, mode)?;
        self.point("family_committed");
        let projection = if matches!(
            request.mutation,
            Mutation::Move { .. } | Mutation::Delete { .. }
        ) {
            ProjectionStatus::Pending(
                "family namespace publication requires physical provenance attachment".into(),
            )
        } else {
            self.family_project_status(request.mutation.id())
        };
        Ok(ApplyOutcome { commit, projection })
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
        let mut projection = ProjectionStatus::Projected;
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
    fn family_project_status(&mut self, id: &EntryId) -> ProjectionStatus {
        let result = (|| -> Result<()> {
            let materialization = self
                .store
                .family_materialization(id)?
                .ok_or(Error::Busy("family publication witness missing"))?;
            let FamilyPublication::Normal { path, .. } = materialization.publication else {
                return Err(Error::Busy("family entry is hidden, pending, or deleted"));
            };
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
        match result {
            Ok(()) => ProjectionStatus::Projected,
            Err(error) => ProjectionStatus::Pending(error.to_string()),
        }
    }
}
