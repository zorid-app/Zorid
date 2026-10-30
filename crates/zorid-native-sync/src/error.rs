//! Sanitized stable codes only. Never retain or format HTTP bodies, credential
//! parse errors, URLs, filesystem paths, database diagnostics or crypto details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error {
    code: &'static str,
    exit: u8,
}
impl Error {
    pub(crate) fn new(code: &'static str, exit: u8) -> Self {
        Self { code, exit }
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    /// CLI presentation hint; hosts should use `code`, not infer rollback from it.
    pub fn exit_code(&self) -> u8 {
        self.exit
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for Error {}
impl From<zorid_core::ContractError> for Error {
    fn from(error: zorid_core::ContractError) -> Self {
        use zorid_core::ContractError::*;
        let (code, exit) = match error {
            RevisionConflict { .. } => ("revision_conflict", 3),
            IdempotencyConflict { .. } => ("idempotency_conflict", 3),
            EntryNotFound { .. } | EntryDeleted { .. } => ("not_found", 4),
            InvalidPath { .. } => ("invalid_path", 2),
            InvalidIdentifier { .. } => ("invalid_identifier", 2),
            InvalidMutation { .. } => ("invalid_mutation", 2),
            InvalidOperationRecord => ("corrupt_storage", 1),
        };
        Self::new(code, exit)
    }
}
impl From<zorid_sync_protocol::ProtocolError> for Error {
    fn from(error: zorid_sync_protocol::ProtocolError) -> Self {
        use zorid_sync_protocol::ProtocolError::*;
        let (code, exit) = match error {
            TooLarge => ("sync_limit", 2),
            EpochMismatch => ("sync_epoch_mismatch", 3),
            ContextMismatch | IdempotencyConflict => ("sync_identity_mismatch", 3),
            UnsupportedTransport
            | UnsupportedEnvelope
            | UnsupportedDocumentFormat
            | UnsupportedRequiredFeature => ("sync_unsupported_protocol", 5),
            _ => ("sync_invalid_protocol", 1),
        };
        Self::new(code, exit)
    }
}
impl From<zorid_native::Error> for Error {
    fn from(error: zorid_native::Error) -> Self {
        use zorid_native::Error::*;
        let (code, exit) = match error {
            DatabaseCommitted(_) => ("collection_publication_pending", 1),
            ConditionalSource(error) => match error {
                zorid_native::ConditionalSourceError::Changed => ("conditional_source_changed", 3),
                zorid_native::ConditionalSourceError::Owner => ("source_capture_owner", 3),
                zorid_native::ConditionalSourceError::Limit => ("source_capture_limit", 2),
                zorid_native::ConditionalSourceError::Capacity => ("source_capture_capacity", 3),
                zorid_native::ConditionalSourceError::Closed => ("source_capture_closed", 3),
            },
            Contract(e) | Store(zorid_store::StoreError::Contract(e)) => return e.into(),
            UnsafePath(_) => ("unsafe_path", 1),
            Busy(_) => ("filesystem_changed", 3),
            Unsupported(_) => ("unsupported", 5),
            LockTimeout => ("lock_timeout", 3),
            Store(zorid_store::StoreError::UnsupportedSchema(_)) => ("unsupported_schema", 5),
            Store(zorid_store::StoreError::Corrupt(_))
            | Store(zorid_store::StoreError::Json(_)) => ("corrupt_storage", 1),
            Store(zorid_store::StoreError::Sync(e)) => {
                use zorid_client_sync::SyncError::*;
                match e {
                    TooLarge => ("sync_limit", 2),
                    UnsupportedFormat => ("sync_unsupported_format", 5),
                    VersionConflict | CursorConflict => ("sync_conflict", 3),
                    IdentityMismatch => ("sync_identity_mismatch", 3),
                    InvalidEdit => ("sync_invalid_edit", 2),
                    AuthenticationFailed => ("sync_authentication_failed", 1),
                    _ => ("sync_validation_failed", 1),
                }
            }
            Store(zorid_store::StoreError::FileSync(e)) => {
                use zorid_file_sync::Error::*;
                match e {
                    TooLarge => ("sync_limit", 2),
                    UnsupportedFormat => ("sync_unsupported_format", 5),
                    IdentityMismatch | DuplicateMismatch => ("sync_identity_mismatch", 3),
                    VersionConflict => ("sync_conflict", 3),
                    AuthenticationFailed => ("sync_authentication_failed", 1),
                    _ => ("sync_validation_failed", 1),
                }
            }
            Store(zorid_store::StoreError::Protocol(e))
            | Store(zorid_store::StoreError::Crypto(zorid_crypto::CryptoError::Protocol(e))) => {
                return e.into()
            }
            Store(zorid_store::StoreError::Crypto(_)) => ("sync_crypto_failed", 1),
            Store(_) => ("storage_io", 1),
            Recovery(_) => ("local_recovery_unavailable", 1),
            Io(_) => ("filesystem_io", 1),
        };
        Self::new(code, exit)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn committed_collection_failure_retains_unknown_outcome_without_inner_diagnostics() {
        let error = Error::from(zorid_native::Error::DatabaseCommitted(Box::new(
            zorid_native::Error::Contract(zorid_core::ContractError::InvalidMutation {
                reason: "secret-sentinel".into(),
            }),
        )));
        assert_eq!(error.code(), "collection_publication_pending");
        assert_eq!(error.exit_code(), 1);
        assert!(!format!("{error:?} {error}").contains("secret-sentinel"));
        assert_ne!(error.code(), "invalid_mutation");
    }
    #[test]
    fn formatting_discards_native_diagnostic_and_contract_details() {
        let errors = [
            Error::from(zorid_native::Error::Io(std::io::Error::other(
                "secret-sentinel",
            ))),
            Error::from(zorid_core::ContractError::InvalidMutation {
                reason: "secret-sentinel".into(),
            }),
            Error::from(zorid_native::Error::Store(
                zorid_store::StoreError::Corrupt("secret-sentinel".into()),
            )),
        ];
        for error in errors {
            assert!(!format!("{error:?} {error}").contains("secret-sentinel"));
            assert_eq!(error.to_string(), error.code());
        }
    }
}
