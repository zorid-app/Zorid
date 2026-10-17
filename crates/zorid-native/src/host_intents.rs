use super::*;
fn rejection(error: &Error) -> Option<HostRejectionCode> {
    let contract = match error {
        Error::Contract(e) | Error::Store(zorid_store::StoreError::Contract(e)) => e,
        _ => return None,
    };
    use zorid_core::ContractError as C;
    Some(match contract {
        C::InvalidPath { .. } => HostRejectionCode::InvalidPath,
        C::InvalidIdentifier { .. } => HostRejectionCode::InvalidIdentifier,
        C::InvalidMutation { .. } => HostRejectionCode::InvalidMutation,
        C::EntryNotFound { .. } => HostRejectionCode::EntryNotFound,
        C::EntryDeleted { .. } => HostRejectionCode::EntryDeleted,
        C::RevisionConflict { .. } => HostRejectionCode::RevisionConflict,
        C::IdempotencyConflict { .. } => HostRejectionCode::IdempotencyConflict,
        C::InvalidOperationRecord => return None,
    })
}
impl NativeVault {
    /// Persist an inert handoff. The caller must checkpoint the returned token
    /// before invoking commit; merely preparing never authorizes execution.
    pub fn prepare_host_intent(
        &mut self,
        client: &OperationId,
        request: &MutationRequest,
    ) -> Result<HostIntentView> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let bytes = match &request.mutation {
            Mutation::Create {
                content: Some(bytes),
                ..
            }
            | Mutation::Write { content: bytes, .. } => bytes.len(),
            _ => 0,
        };
        if bytes > self.options.max_file_bytes {
            return Err(Error::Unsupported(
                "host intent exceeds configured whole-file limit",
            ));
        }
        let result = self.store.prepare_host_intent(client, request)?;
        self.point("host_intent_prepared");
        Ok(result)
    }
    pub fn query_host_intent(&self, reference: &HostIntentRef) -> Result<Option<HostIntentView>> {
        self.paths.verify()?;
        Ok(self.store.query_host_intent(reference)?)
    }
    pub fn list_host_intents(
        &self,
        client: &OperationId,
        cursor: &str,
        limit: u32,
    ) -> Result<HostIntentPage> {
        self.paths.verify()?;
        Ok(self.store.list_host_intents(client, cursor, limit)?)
    }
    /// Authorizes durable exact-request retry. An uncertain error leaves the
    /// intent commit_requested; query/replay this token instead of rebasing.
    pub fn commit_host_intent(&mut self, reference: &HostIntentRef) -> Result<HostIntentView> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let current = self.store.query_host_intent(reference)?.ok_or_else(|| {
            Error::Contract(zorid_core::ContractError::InvalidMutation {
                reason: "host intent not found".into(),
            })
        })?;
        if current.state == HostIntentState::Rejected {
            return Ok(current);
        }
        let request = self.store.request_host_commit(reference)?;
        self.point("host_intent_commit_requested");
        match self.apply_locked(&request) {
            Ok(outcome) => {
                self.point("host_intent_core_committed");
                let mut view = self.store.query_host_intent(reference)?.ok_or_else(|| {
                    Error::Store(zorid_store::StoreError::Corrupt(
                        "committed host intent missing".into(),
                    ))
                })?;
                if view.state != HostIntentState::Committed
                    || view.receipt.as_ref() != Some(&outcome.commit)
                {
                    return Err(Error::Store(zorid_store::StoreError::Corrupt(
                        "host intent receipt not atomically attached".into(),
                    )));
                }
                view.projection = Some(match outcome.projection {
                    ProjectionStatus::Projected => HostProjectionState::Projected,
                    ProjectionStatus::Pending(_) => HostProjectionState::Pending,
                });
                self.point("host_intent_settled");
                Ok(view)
            }
            Err(error) => {
                if let Some(code) = rejection(&error) {
                    let view = self.store.reject_host_intent(reference, code)?;
                    self.point("host_intent_settled");
                    Ok(view)
                } else {
                    Err(error)
                }
            }
        }
    }
    pub fn acknowledge_host_intent(
        &mut self,
        reference: &HostIntentRef,
        expected: &HostIntentAcknowledgment,
    ) -> Result<HostIntentView> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        let result = self.store.acknowledge_host_intent(reference, expected)?;
        self.point("host_intent_acknowledged");
        Ok(result)
    }
}
