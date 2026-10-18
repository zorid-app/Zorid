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
/// Bounded root-only original operation report, never a reconstructed receipt.
/// Internal lookup currently decodes the full original receipt/job. This bounds
/// serialized output, not transient internal memory for recursive operations.
pub const MAX_FAMILY_COMMAND_STATUS_BYTES: usize = 1024 * 1024 - 16 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FamilyCommandKind { Create, Write, Move, Delete }
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FamilyCommandProjection { Settled, Pending }
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FamilyCommandStatus {
    NotCommitted { local_store_id: OperationId, operation_id: OperationId },
    Committed { local_store_id: OperationId, operation_id: OperationId,
        kind: FamilyCommandKind, sequence: String, source: Option<EntryState>,
        target: EntryState, change_count: String, projection: FamilyCommandProjection },
}
fn invalid(reason: &'static str) -> StoreError { ContractError::InvalidMutation { reason: reason.into() }.into() }
fn compact_kind(command: &command::FamilyCommand) -> Result<()> {
    match &command.request.mutation {
        Mutation::Move { .. } if command.destination_parent.is_some() => Ok(()),
        Mutation::Move { .. } => Err(invalid("compact Move requires explicit destination parent")),
        Mutation::Delete { .. } => Ok(()),
        _ => Err(invalid("compact command requires Move or Delete")),
    }
}
fn summary(local_store_id: OperationId, request: &MutationRequest, receipt: &CommitResult,
    projection: FamilyCommandProjection) -> Result<FamilyCommandStatus> {
    receipt.validate()?;
    let root = receipt.changes.iter().find(|change| &change.after.id == request.mutation.id())
        .ok_or_else(|| StoreError::Corrupt("original family root receipt change missing".into()))?;
    let before = root.before.as_ref();
    let valid_before = |expected: &Revision| before.is_some_and(|state| !state.deleted && &state.revision == expected);
    let (kind, matches) = match &request.mutation {
        Mutation::Create { path, kind, .. } => (FamilyCommandKind::Create, before.is_none() && !root.after.deleted && root.after.path == *path && root.after.kind == *kind),
        Mutation::Write { expected, .. } => (FamilyCommandKind::Write, valid_before(expected) && !root.after.deleted && before.is_some_and(|state| state.path == root.after.path)),
        Mutation::Move { expected, path, .. } => (FamilyCommandKind::Move, valid_before(expected) && !root.after.deleted && root.after.path == *path),
        Mutation::Delete { expected, .. } => (FamilyCommandKind::Delete, valid_before(expected) && root.after.deleted && before.is_some_and(|state| state.path == root.after.path)),
    };
    if receipt.operation_id != request.operation_id || !matches {
        return Err(StoreError::Corrupt("original family root receipt differs from request".into()));
    }
    Ok(FamilyCommandStatus::Committed { local_store_id, operation_id: request.operation_id.clone(), kind,
        sequence: receipt.sequence.to_string(), source: root.before.clone(), target: root.after.clone(),
        change_count: receipt.changes.len().to_string(), projection })
}
fn check_summary_size(status: &FamilyCommandStatus) -> Result<()> {
    struct Counter { bytes: usize }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.bytes.saturating_add(bytes.len()) > MAX_FAMILY_COMMAND_STATUS_BYTES {
                return Err(std::io::Error::other("family command summary limit"));
            }
            self.bytes += bytes.len(); Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    serde_json::to_writer(Counter { bytes: 0 }, status)
        .map_err(|_| invalid("family command status exceeds response limit"))
}
impl Store {
    /// Existing request/mode API is an unguarded thin adapter. None is not Root.
    pub fn family_apply(&mut self, request: &MutationRequest, mode: Option<FamilyCreateMode>) -> Result<CommitResult> {
        let command = command::FamilyCommand::new(request.clone(), mode).map_err(mapped)?;
        self.family_apply_command(&command)
    }
    pub fn family_apply_command(&mut self, command: &command::FamilyCommand) -> Result<CommitResult> {
        self.family_apply_command_inner(command, false)
    }
    /// Same atomic command execution with a root-summary preflight before a fresh
    /// commit. Replay remains first, including legacy unguarded committed Move.
    pub fn family_apply_command_compact(&mut self, command: &command::FamilyCommand) -> Result<CommitResult> {
        self.family_apply_command_inner(command, true)
    }
    fn family_apply_command_inner(&mut self, command: &command::FamilyCommand, compact: bool) -> Result<CommitResult> {
        command.validate().map_err(mapped)?;
        let request = &command.request;
        let mode = command.create_mode;
        let tx = self.connection.unchecked_transaction()?;
        if let Some(receipt) = family_metadata_transactions::replay_command(&tx, command)? {
            tx.commit()?; return Ok(receipt);
        }
        if compact { compact_kind(command)?; }
        if family_metadata_transactions::inline_binary(&tx, request, mode)? {
            tx.commit()?;
            return binary_commit::apply_inline_binary(self, request, mode);
        }
        let prepared = family_metadata_transactions::prepare_family_command(&tx, command)?;
        if compact {
            let receipt = CommitResult { operation_id: request.operation_id.clone(), sequence: u64::MAX, changes: prepared.changes().to_vec() };
            let mut status = summary(text_sync::identity(&tx)?.local_store_id, request, &receipt, FamilyCommandProjection::Pending)?;
            // Count can be no wider than u64::MAX. Reserve that fixed width,
            // independent of native word size and actual recursive member count.
            if let FamilyCommandStatus::Committed { change_count, .. } = &mut status { *change_count = u64::MAX.to_string(); }
            check_summary_size(&status)?;
        }
        tx.commit()?;
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let receipt = commit_prepared(&tx, &prepared)?;
        tx.commit()?;
        Ok(receipt)
    }
    /// A single read snapshot of the ORIGINAL persisted command/receipt/job.
    /// NotCommitted is absence now, not a rejection ledger or permission to
    /// replace the operation ID. No current entry listing or projection runs.
    pub fn family_command_status(&self, command: &command::FamilyCommand) -> Result<FamilyCommandStatus> {
        command.validate().map_err(mapped)?;
        let tx = self.connection.unchecked_transaction()?;
        let local_store_id = text_sync::identity(&tx)?.local_store_id;
        let receipt = family_metadata_transactions::replay_command(&tx, command)?;
        let status = if let Some(receipt) = receipt {
            let composite: Option<String> = tx.query_row("SELECT command FROM family_commands WHERE operation_id=?1", [command.request.operation_id.as_str()], |row| row.get(0)).optional()?;
            let prior: command::FamilyCommand = serde_json::from_str(&composite.ok_or_else(|| invalid("status requires retained exact family command"))?)?;
            command.check_replay(&prior).map_err(mapped)?;
            let settled = projection_jobs::original_local_completed(&tx, &command.request, &receipt)?;
            summary(local_store_id, &command.request, &receipt, if settled { FamilyCommandProjection::Settled } else { FamilyCommandProjection::Pending })?
        } else {
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM family_commands WHERE operation_id=?1)", [command.request.operation_id.as_str()], |row| row.get::<_, bool>(0))? {
                return Err(StoreError::Corrupt("family command has no operation receipt".into()));
            }
            FamilyCommandStatus::NotCommitted { local_store_id, operation_id: command.request.operation_id.clone() }
        };
        check_summary_size(&status)?;
        tx.commit()?;
        Ok(status)
    }
}

#[cfg(test)]
mod compact_summary_tests {
    use super::*;
    use zorid_core::{EntryChange, VaultPath};
    fn change(id: &str, old: &str, new: &str, kind: EntryKind) -> EntryChange {
        let before = EntryState { id: EntryId::new(id).unwrap(), path: VaultPath::new(old).unwrap(), kind, revision: Revision::new("before").unwrap(), deleted: false };
        let mut after = before.clone(); after.path = VaultPath::new(new).unwrap(); after.revision = Revision::new("after").unwrap();
        EntryChange { before: Some(before), after }
    }
    #[test]
    fn recursive_receipt_larger_than_header_reduces_to_original_root() {
        let operation_id = OperationId::new("recursive-move").unwrap();
        let request = MutationRequest { operation_id: operation_id.clone(), mutation: Mutation::Move { id: EntryId::new("root").unwrap(), expected: Revision::new("before").unwrap(), path: VaultPath::new("Target").unwrap() } };
        let mut changes = vec![change("root", "Source", "Target", EntryKind::Folder)];
        let suffix = "x".repeat(600);
        for n in 0..1000 { changes.push(change(&format!("child_{n}"), &format!("Source/{n}_{suffix}"), &format!("Target/{n}_{suffix}"), EntryKind::File)); }
        let receipt = CommitResult { operation_id, sequence: 37, changes };
        assert!(serde_json::to_vec(&receipt).unwrap().len() > 1024 * 1024);
        let report = summary(OperationId::new("local-store").unwrap(), &request, &receipt, FamilyCommandProjection::Pending).unwrap();
        check_summary_size(&report).unwrap();
        assert!(serde_json::to_vec(&report).unwrap().len() < 2048);
        let FamilyCommandStatus::Committed { source, target, sequence, change_count, .. } = report else { panic!("committed") };
        assert_eq!(source.unwrap().path.as_str(), "Source"); assert_eq!(target.path.as_str(), "Target");
        assert_eq!(sequence, "37"); assert_eq!(change_count, "1001");
    }
    #[test]
    fn exceptional_oversized_original_root_reports_limit_not_corruption() {
        let operation_id = OperationId::new("large-root").unwrap();
        let request = MutationRequest { operation_id: operation_id.clone(), mutation: Mutation::Move { id: EntryId::new("root").unwrap(), expected: Revision::new("before").unwrap(), path: VaultPath::new("Target").unwrap() } };
        let receipt = CommitResult { operation_id, sequence: 1, changes: vec![change("root", &"x".repeat(MAX_FAMILY_COMMAND_STATUS_BYTES), "Target", EntryKind::Folder)] };
        let report = summary(OperationId::new("local-store").unwrap(), &request, &receipt, FamilyCommandProjection::Pending).unwrap();
        assert!(matches!(check_summary_size(&report), Err(StoreError::Contract(ContractError::InvalidMutation { .. }))));
    }
}
