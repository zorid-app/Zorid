//! Local family commands. Core receipts are local idempotency records, never
//! encrypted wire payloads. All envelopes below come from the shared Rust mapper.
use super::family_ledger::EnvelopeKey;
use super::*;
use zorid_client_sync::{ActorOwner, ActorRegistration};
use zorid_core::OperationId;
use zorid_file_sync::{mutation as command, Scope};
use zorid_sync_protocol::{DeviceId, UpdateId};

// Shared with proven external operations; preparation precedes the writer.
pub(super) use super::family_metadata_transactions::{
    commit_prepared, prepare_command, prepare_parts, replay,
};

pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("family_commands","CREATE TABLE family_commands (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), command TEXT NOT NULL)"),
];
pub(super) fn mapped(error: command::Error) -> StoreError {
    match error {
        command::Error::Contract(e) => StoreError::Contract(e),
        command::Error::Files(e) => StoreError::FileSync(e),
        command::Error::Text(e) => StoreError::Sync(e),
        command::Error::UnsupportedCommandVersion => {
            StoreError::Sync(zorid_client_sync::SyncError::UnsupportedFormat)
        }
        _ => StoreError::Contract(ContractError::InvalidMutation {
            reason: format!("family command rejected: {error}"),
        }),
    }
}
pub(super) fn key(scope: &Scope, id: &UpdateId) -> EnvelopeKey {
    EnvelopeKey {
        realm_id: scope.realm_id.clone(),
        vault_id: scope.vault_id.clone(),
        update_id: id.clone(),
    }
}
pub(super) fn fresh_revision() -> Result<Revision> {
    Ok(Revision::new(uuid::Uuid::new_v4().to_string())?)
}
pub(super) fn fresh_update() -> Result<UpdateId> {
    Ok(UpdateId::new(uuid::Uuid::new_v4().to_string())?)
}
pub(super) fn actor(
    tx: &Connection,
    current: Option<&zorid_client_sync::TextState>,
) -> Result<ActorRegistration> {
    let authority = text_sync::identity(tx)?;
    for _ in 0..64 {
        let random = uuid::Uuid::new_v4();
        let b = random.as_bytes();
        let actor = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        if current.is_some_and(|s| s.actors.contains_key(&actor)) {
            continue;
        }
        return Ok(ActorRegistration {
            actor,
            owner: ActorOwner {
                replica_id: DeviceId::new(authority.local_store_id.as_str())?,
                incarnation_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            },
        });
    }
    Err(zorid_client_sync::SyncError::ActorCollision.into())
}
impl Store {
    pub fn family_apply(
        &mut self,
        request: &MutationRequest,
        mode: Option<FamilyCreateMode>,
    ) -> Result<CommitResult> {
        let tx = self.connection.unchecked_transaction()?;
        if let Some(receipt) = replay(&tx, request, mode)? {
            tx.commit()?;
            return Ok(receipt);
        }
        if family_metadata_transactions::inline_binary(&tx, request, mode)? {
            tx.commit()?;
            return binary_commit::apply_inline_binary(self, request, mode);
        }
        let prepared = prepare_command(&tx, request, mode)?;
        tx.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let receipt = commit_prepared(&tx, &prepared)?;
        tx.commit()?;
        Ok(receipt)
    }
}
