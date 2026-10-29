use super::*;
#[cfg(test)]
mod retry_fault_tests {
    use super::*;
    #[test]
    fn retry_fault_checkpoint_retains_native_error_type_instead_of_display_text() {
        let CheckpointError::ExternalStorage(error) = uncertain(Error::LockTimeout) else { panic!("external boundary expected") };
        assert!(matches!(error.get_ref().and_then(|inner| inner.downcast_ref::<Error>()), Some(Error::LockTimeout)));
    }
}
fn uncertain(error: Error) -> CheckpointError {
    CheckpointError::ExternalStorage(std::io::Error::other(error.to_string()))
}
impl NativeVault {
    pub fn checkpoint_load(
        &mut self,
        scope: &CheckpointScope,
        key: &str,
    ) -> std::result::Result<Option<Checkpoint>, CheckpointError> {
        let _guard = self
            .paths
            .lock(self.options.lock_timeout)
            .map_err(uncertain)?;
        self.paths.verify().map_err(uncertain)?;
        self.store.checkpoint_load(scope, key)
    }
    pub fn checkpoint_compare_and_swap(
        &mut self,
        scope: &CheckpointScope,
        request: CheckpointWrite<'_>,
    ) -> std::result::Result<Checkpoint, CheckpointError> {
        let _guard = self
            .paths
            .lock(self.options.lock_timeout)
            .map_err(uncertain)?;
        self.paths.verify().map_err(uncertain)?;
        self.store.checkpoint_compare_and_swap(scope, request)
    }
    pub fn checkpoint_list(
        &mut self,
        scope: &CheckpointScope,
        limit: u32,
        cursor: Option<&str>,
    ) -> std::result::Result<CheckpointPage, CheckpointError> {
        let _guard = self
            .paths
            .lock(self.options.lock_timeout)
            .map_err(uncertain)?;
        self.paths.verify().map_err(uncertain)?;
        self.store.checkpoint_list(scope, limit, cursor)
    }
    pub fn checkpoint_changes(
        &mut self,
        scope: &CheckpointScope,
        after: &str,
        limit: u32,
        cursor: Option<&str>,
    ) -> std::result::Result<CheckpointPage, CheckpointError> {
        let _guard = self
            .paths
            .lock(self.options.lock_timeout)
            .map_err(uncertain)?;
        self.paths.verify().map_err(uncertain)?;
        self.store.checkpoint_changes(scope, after, limit, cursor)
    }
}
