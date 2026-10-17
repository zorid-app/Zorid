//! Private resumable scan cursor, using the existing local checkpoint CAS.
//! This non-UUID client cannot be claimed through native renderer admission.
use super::*;
use serde::de::DeserializeOwned;

const CLIENT: &str = "zorid_core_external_scan";
const KEY: &str = "external-scan-progress-v1";

fn mapped(error: CheckpointError) -> StoreError {
    match error {
        CheckpointError::Store(error) => error,
        CheckpointError::Conflict => zorid_client_sync::SyncError::VersionConflict.into(),
        CheckpointError::Limit => zorid_client_sync::SyncError::TooLarge.into(),
        CheckpointError::Invalid | CheckpointError::ScopeMismatch => {
            StoreError::Corrupt("invalid internal external scan checkpoint authority".into())
        }
        CheckpointError::ExternalStorage(_) => {
            StoreError::Corrupt("unexpected external storage in internal scan checkpoint".into())
        }
    }
}

impl Store {
    fn external_scan_scope(&self) -> Result<CheckpointScope> {
        Ok(CheckpointScope {
            vault_id: self.identity()?.local_store_id,
            client_id: OperationId::new(CLIENT)?,
        })
    }

    /// Preserve the current revision even for a tombstone, preventing ABA on a
    /// later inventory. The concrete state is versioned/validated by native.
    pub fn external_scan_progress<T: DeserializeOwned>(
        &mut self,
    ) -> Result<(Option<String>, Option<T>)> {
        let scope = self.external_scan_scope()?;
        let value = self.checkpoint_load(&scope, KEY).map_err(mapped)?;
        match value {
            None => Ok((None, None)),
            Some(value) => {
                let state = value
                    .encoded_state
                    .map(|raw| serde_json::from_str(&raw))
                    .transpose()?;
                Ok((Some(value.revision), state))
            }
        }
    }

    pub fn save_external_scan_progress<T: Serialize>(
        &mut self,
        expected_revision: Option<&str>,
        state: Option<&T>,
    ) -> Result<String> {
        let scope = self.external_scan_scope()?;
        let encoded = state.map(serde_json::to_string).transpose()?;
        let next = uuid::Uuid::new_v4().to_string();
        let value = self
            .checkpoint_compare_and_swap(
                &scope,
                CheckpointWrite {
                    key: KEY,
                    expected_revision,
                    next_revision: &next,
                    encoded_state: encoded.as_deref(),
                },
            )
            .map_err(mapped)?;
        Ok(value.revision)
    }
}
