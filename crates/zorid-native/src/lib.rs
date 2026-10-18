//! Native filesystem adapter. SQLite is authority; a commit receipt is NOT a
//! filesystem acknowledgement. See README for crash and security boundaries.
use serde::{Deserialize, Serialize};
pub use zorid_recovery::{
    Snapshot as LocalRecoverySnapshot, SnapshotCursor as LocalRecoveryCursor,
    SnapshotInfo as LocalRecoveryVersion,
};
use std::{fmt, time::Duration};
use zorid_core::{
    CommitResult, EntryId, EntryState, MutationRequest, OperationId, Revision, VaultPath,
};
mod client_admission;
mod document_api;
mod local_storage;
pub use local_storage::LocalStoragePaths;
pub use document_api::*;
pub use client_admission::{ClientAdmissionError, ClientLease, ClientLeaseRef};
pub use zorid_store::{
    AuthoredTextStatus, AuthorityIdentity, ChangeOrigin, ChangePage, Checkpoint, CheckpointError,
    CheckpointMetadata, CheckpointPage, CheckpointScope, CheckpointWrite, EntryPresentation,
    HostIntentAcknowledgment, HostIntentPage, HostIntentRef, HostIntentState, HostIntentView,
    HostMutationKind, HostProjectionState, HostRejection, HostRejectionCode, ListingSnapshot,
    LocalChange, PresentedEntry, PresentedState, TextReceiveOutcome, MAX_CHECKPOINT_BYTES,
};
pub use zorid_store::{
    BinaryCaptureRequest, BinaryContentManifest, BinaryReadChunk, BinaryReadRef, BinaryReadSession,
    BinarySourceRef, BinaryStageCommit, BinaryStageLocator, BinaryStageRef, BinaryStageRejection,
    BinaryStageRejectionCode, BinaryStageRequest, BinaryStageStatus, BinaryStageTerminal,
    BinaryTarget, CapturedBinaryRef, ContentMetadata, PublishedBinaryRef, Sha256Digest,
    StageChunkReceipt, StagePhase, StagedBinaryRef, StoredContent, StoredEntryMetadata,
    StreamingLimits, BINARY_COMMIT_MAX_RECEIPT_BYTES, BINARY_STAGE_MAX_CHUNK_BYTES,
    BINARY_STAGE_MAX_FILE_BYTES, BINARY_STAGE_MAX_PATH_BYTES, DEFAULT_STREAMING_LIMITS,
};
pub use zorid_store::{
    FamilyAuthoredStatus, FamilyCreateMode, FamilyEnvelopeStatus, FamilyReceiveCommit, FamilyScope,
    FamilyStatus, FamilyCommandKind, FamilyCommandProjection, FamilyCommandStatus,
    MAX_FAMILY_COMMAND_STATUS_BYTES,
};
pub use zorid_store::{DestinationParent, FamilyCommand};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamilyReceiveOutcome {
    pub commit: FamilyReceiveCommit,
    pub projection: ProjectionStatus,
}
use zorid_store::{DirectoryPhase, ProjectionPhase, ScanRun, StoredEntry};

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Recovery(zorid_recovery::RecoveryError),
    Store(zorid_store::StoreError),
    Contract(zorid_core::ContractError),
    UnsafePath(String),
    Busy(&'static str),
    Unsupported(&'static str),
    LockTimeout,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => e.fmt(f),
            Self::Recovery(e) => e.fmt(f),
            Self::Store(e) => e.fmt(f),
            Self::Contract(e) => e.fmt(f),
            Self::UnsafePath(s) => write!(f, "Unsafe filesystem path: {s}"),
            Self::Busy(s) => write!(f, "Filesystem changed: {s}"),
            Self::Unsupported(s) => write!(f, "Not supported in this native slice: {s}"),
            Self::LockTimeout => write!(f, "Timed out acquiring native vault lock"),
        }
    }
}
impl std::error::Error for Error {}
impl From<zorid_recovery::RecoveryError> for Error {
    fn from(e: zorid_recovery::RecoveryError) -> Self { Self::Recovery(e) }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<zorid_store::StoreError> for Error {
    fn from(e: zorid_store::StoreError) -> Self {
        Self::Store(e)
    }
}
impl From<zorid_core::ContractError> for Error {
    fn from(e: zorid_core::ContractError) -> Self {
        Self::Contract(e)
    }
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
impl From<rustix::io::Errno> for Error {
    fn from(e: rustix::io::Errno) -> Self {
        Self::Io(e.into())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiveOutcome {
    pub commit: TextReceiveOutcome,
    pub projection: ProjectionStatus,
}
/// Device-local secondary history maintenance; never a save acknowledgement.
#[derive(Debug, Default)]
pub struct RecoveryMaintenance {
    pub pending: bool,
    pub failed_notes: u16,
}
#[derive(Debug, Clone)]
pub struct Options {
    pub lock_timeout: Duration,
    pub max_file_bytes: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            lock_timeout: Duration::from_secs(5),
            max_file_bytes: 16 * 1024 * 1024,
        }
    }
}
#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub max_entries: u32,
    pub max_total_bytes: u64,
    pub max_depth: u16,
    pub max_duration: Duration,
}
impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_entries: 10_000,
            max_total_bytes: 64 * 1024 * 1024,
            max_depth: 128,
            max_duration: Duration::from_secs(5),
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ScanIssue {
    pub path: Option<VaultPath>,
    pub reason: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct RescanReport {
    pub run: ScanRun,
    pub issues: Vec<ScanIssue>,
    pub missing: Vec<VaultPath>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ExternalReconcileReport {
    pub complete: bool,
    pub run: ScanRun,
    pub issues: Vec<ScanIssue>,
    pub imported: Vec<CommitResult>,
    pub namespace: Vec<zorid_store::ExternalNamespaceCommit>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct FolderAttemptStatus {
    pub attempt_id: OperationId,
    pub entry_id: EntryId,
    pub path: VaultPath,
    pub phase: DirectoryPhase,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", content = "reason", rename_all = "snake_case")]
pub enum ProjectionStatus {
    Projected,
    Pending(String),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyOutcome {
    pub commit: CommitResult,
    pub projection: ProjectionStatus,
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ReconcileReport {
    pub imported: Vec<CommitResult>,
    pub projected: Vec<EntryId>,
    pub blocked: Vec<(VaultPath, String)>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Status {
    pub pending_outbox: String,
    pub pending_projection: String,
    pub attempts: Vec<AttemptStatus>,
    pub observations: Vec<ObservationStatus>,
    pub directory_attempts: Vec<FolderAttemptStatus>,
    pub scan: Option<ScanRun>,
    /// Durable namespace journal metadata; paths are relative to the vault root.
    pub namespace_attempts: Vec<NamespaceAttemptStatus>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NamespaceAttemptStatus {
    pub job_id: OperationId,
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegated_to: Option<OperationId>,
    pub members: Vec<NamespaceMemberStatus>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NamespaceMemberStatus {
    pub entry_id: EntryId,
    pub source: VaultPath,
    pub target: VaultPath,
    /// This is a reserved recovery location; it may be empty after publication.
    pub recovery_path: String,
    pub directory_stage_path: Option<String>,
    pub captured: bool,
    pub published: bool,
    pub finished: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct AttemptStatus {
    pub attempt_id: OperationId,
    pub entry_id: EntryId,
    pub path: VaultPath,
    pub target_revision: Revision,
    pub phase: ProjectionPhase,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ObservationStatus {
    pub observation_id: OperationId,
    pub path: VaultPath,
    pub byte_length: String,
    pub resolved: bool,
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
mod fs;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
mod fs_stream;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
mod native;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
pub use native::{select_external_file_mode, ExternalFileMode, NativeVault};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
pub use native::{CalendarRead, CalendarScope, CalendarContext, CalendarJoinState,
    CalendarReadValue, CalendarEvidence, CalendarSelection, CalendarTask,
    CalendarBlock, CalendarLinkLabel, CalendarMembership, CalendarTarget};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
pub use native::{WorkBlockCommand, WorkBlockError, WorkBlockRange, WorkBlockRangeCandidate,
    WorkBlockTitleCandidate, WorkBlockValue, WorkBlockRead, WorkBlockWindowPage,
    WorkBlockReply, WorkBlockResult, WorkBlockSession};
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")))]
pub struct NativeVault;
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")))]
#[path = "workblocks.rs"]
mod unsupported_workblocks;
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")))]
pub use unsupported_workblocks::*;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalFileMode {
    Auto,
    Text,
    Binary,
}
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")))]
impl NativeVault {
    pub fn list_local_recovery(&self, _: &EntryId, _: Option<LocalRecoveryCursor>, _: usize) -> Result<Vec<LocalRecoveryVersion>> { unsupported() }
    pub fn read_local_recovery(&self, _: &EntryId, _: i64) -> Result<Option<LocalRecoverySnapshot>> { unsupported() }
    pub fn enable_local_recovery(&mut self, _: impl AsRef<std::path::Path>, _: i64) -> Result<()> { unsupported() }
    pub fn snapshot_local_recovery(&mut self, _: i64) -> Result<()> { unsupported() }
    pub fn maintain_local_recovery(&mut self, _: i64, _: u16) -> Result<RecoveryMaintenance> { unsupported() }
    pub fn open(_: impl AsRef<std::path::Path>) -> Result<Self> {
        unsupported()
    }
    pub fn open_with_options(_: impl AsRef<std::path::Path>, _: Options) -> Result<Self> {
        unsupported()
    }
    pub fn open_existing(_: impl AsRef<std::path::Path>) -> Result<Self> {
        unsupported()
    }
    pub fn open_existing_with_options(_: impl AsRef<std::path::Path>, _: Options) -> Result<Self> {
        unsupported()
    }
    pub fn checkpoint_load(
        &mut self,
        _: &CheckpointScope,
        _: &str,
    ) -> std::result::Result<Option<Checkpoint>, CheckpointError> {
        Err(CheckpointError::ExternalStorage(std::io::Error::other(
            "unsupported platform",
        )))
    }
    pub fn checkpoint_compare_and_swap(
        &mut self,
        _: &CheckpointScope,
        _: CheckpointWrite<'_>,
    ) -> std::result::Result<Checkpoint, CheckpointError> {
        Err(CheckpointError::ExternalStorage(std::io::Error::other(
            "unsupported platform",
        )))
    }
    pub fn checkpoint_list(
        &mut self,
        _: &CheckpointScope,
        _: u32,
        _: Option<&str>,
    ) -> std::result::Result<CheckpointPage, CheckpointError> {
        Err(CheckpointError::ExternalStorage(std::io::Error::other(
            "unsupported platform",
        )))
    }
    pub fn checkpoint_changes(
        &mut self,
        _: &CheckpointScope,
        _: &str,
        _: u32,
        _: Option<&str>,
    ) -> std::result::Result<CheckpointPage, CheckpointError> {
        Err(CheckpointError::ExternalStorage(std::io::Error::other(
            "unsupported platform",
        )))
    }
    pub fn text_state(&self, _: &EntryId) -> Result<Option<zorid_client_sync::TextState>> {
        unsupported()
    }
    pub fn bind_empty_text(
        &mut self,
        _: &zorid_client_sync::TextIdentity,
        _: &Revision,
    ) -> Result<zorid_client_sync::TextState> {
        unsupported()
    }
    pub fn adopt_text(
        &mut self,
        _: &zorid_client_sync::TextIdentity,
        _: &MutationRequest,
    ) -> Result<ApplyOutcome> {
        unsupported()
    }
    pub fn receive_text(
        &mut self,
        _: &zorid_client_sync::AuthenticatedText,
        _: &zorid_client_sync::ReceiveRequest,
    ) -> Result<ReceiveOutcome> {
        unsupported()
    }
    pub fn text_receive_cursor(
        &self,
        _: &zorid_sync_protocol::RealmId,
        _: &zorid_sync_protocol::VaultId,
    ) -> Result<Option<zorid_client_sync::ReceiveCursor>> {
        unsupported()
    }
    pub fn set_text_receive_cursor(
        &mut self,
        _: Option<&zorid_client_sync::ReceiveCursor>,
        _: &zorid_client_sync::ReceiveCursor,
    ) -> Result<()> {
        unsupported()
    }
    pub fn seal_authored_text(
        &mut self,
        _: &zorid_sync_protocol::ExpectedContext,
        _: &zorid_crypto::VaultKey,
    ) -> Result<Vec<u8>> {
        unsupported()
    }
    pub fn pending_authored_text(
        &self,
        _: Option<&zorid_sync_protocol::UpdateId>,
        _: u32,
    ) -> Result<Vec<AuthoredTextStatus>> {
        unsupported()
    }
    pub fn acknowledge_authored_text(
        &mut self,
        _: &zorid_sync_protocol::RealmId,
        _: &zorid_sync_protocol::VaultId,
        _: &zorid_sync_protocol::UpdateId,
        _: &[u8],
    ) -> Result<()> {
        unsupported()
    }
    pub fn claim_client(
        &self,
        _: &OperationId,
    ) -> std::result::Result<ClientLease, ClientAdmissionError> {
        Err(ClientAdmissionError::Native(Error::Unsupported("platform")))
    }
    pub fn verify_client_lease(
        &self,
        _: &ClientLease,
    ) -> std::result::Result<(), ClientAdmissionError> {
        Err(ClientAdmissionError::Native(Error::Unsupported("platform")))
    }
    pub fn identity(&self) -> Result<AuthorityIdentity> {
        Err(Error::Unsupported("platform"))
    }
    pub fn list(&self) -> Result<Vec<EntryState>> {
        unsupported()
    }
    pub fn read(&self, _: &EntryId) -> Result<Option<StoredEntry>> {
        unsupported()
    }
    pub fn read_path(&self, _: &VaultPath) -> Result<Option<PresentedEntry>> {
        unsupported()
    }
    pub fn read_presented(&self, _: &EntryId) -> Result<Option<PresentedEntry>> {
        Err(Error::Unsupported("platform"))
    }
    pub fn list_snapshot(&self) -> Result<ListingSnapshot> {
        unsupported()
    }
    pub fn changes_after(&self, _: &str, _: u32) -> Result<ChangePage> {
        unsupported()
    }
    pub fn prepare_host_intent(
        &mut self,
        _: &OperationId,
        _: &MutationRequest,
    ) -> Result<HostIntentView> {
        unsupported()
    }
    pub fn commit_host_intent(&mut self, _: &HostIntentRef) -> Result<HostIntentView> {
        unsupported()
    }
    pub fn query_host_intent(&self, _: &HostIntentRef) -> Result<Option<HostIntentView>> {
        unsupported()
    }
    pub fn list_host_intents(&self, _: &OperationId, _: &str, _: u32) -> Result<HostIntentPage> {
        unsupported()
    }
    pub fn acknowledge_host_intent(
        &mut self,
        _: &HostIntentRef,
        _: &HostIntentAcknowledgment,
    ) -> Result<HostIntentView> {
        unsupported()
    }
    pub fn status(&self) -> Result<Status> {
        unsupported()
    }
    pub fn apply(&mut self, _: &MutationRequest) -> Result<ApplyOutcome> {
        unsupported()
    }
    pub fn reconcile(&mut self, _: &[VaultPath]) -> Result<ReconcileReport> {
        unsupported()
    }
    pub fn rescan(&mut self) -> Result<RescanReport> {
        unsupported()
    }
    pub fn reconcile_external(
        &mut self,
        _: ScanOptions,
        _: ExternalFileMode,
    ) -> Result<ExternalReconcileReport> {
        unsupported()
    }
    pub fn rescan_with_options(&mut self, _: ScanOptions) -> Result<RescanReport> {
        unsupported()
    }
    pub fn recover(&mut self) -> Result<ReconcileReport> {
        unsupported()
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")))]
impl NativeVault {
    pub fn family_enroll(&mut self, _: &FamilyScope) -> Result<FamilyStatus> {
        unsupported()
    }
    pub fn family_status(&self) -> Result<FamilyStatus> {
        unsupported()
    }
    pub fn family_pending_authored(
        &self,
        _: Option<&zorid_sync_protocol::UpdateId>,
        _: u32,
    ) -> Result<Vec<FamilyAuthoredStatus>> {
        unsupported()
    }
    pub fn family_seal(
        &mut self,
        _: &zorid_sync_protocol::ExpectedContext,
        _: &zorid_crypto::VaultKey,
    ) -> Result<Vec<u8>> {
        unsupported()
    }
    pub fn family_ack(
        &mut self,
        _: &zorid_sync_protocol::RealmId,
        _: &zorid_sync_protocol::VaultId,
        _: &zorid_sync_protocol::UpdateId,
        _: &[u8],
    ) -> Result<()> {
        unsupported()
    }
    pub fn family_receive_cursor(
        &self,
        _: &zorid_sync_protocol::RealmId,
        _: &zorid_sync_protocol::VaultId,
    ) -> Result<Option<zorid_client_sync::ReceiveCursor>> {
        unsupported()
    }
    pub fn family_set_receive_cursor(
        &mut self,
        _: Option<&zorid_client_sync::ReceiveCursor>,
        _: &zorid_client_sync::ReceiveCursor,
    ) -> Result<()> {
        unsupported()
    }
    pub fn family_envelope_status(
        &self,
        _: &zorid_sync_protocol::UpdateId,
    ) -> Result<Option<FamilyEnvelopeStatus>> {
        unsupported()
    }
    pub fn family_apply(
        &mut self,
        _: &MutationRequest,
        _: Option<FamilyCreateMode>,
    ) -> Result<ApplyOutcome> {
        unsupported()
    }
    pub fn family_apply_command(&mut self, _: &FamilyCommand) -> Result<ApplyOutcome> { unsupported() }
    pub fn family_apply_command_compact(&mut self, _: &FamilyCommand) -> Result<FamilyCommandStatus> { unsupported() }
    pub fn family_command_status(&self, _: &FamilyCommand) -> Result<FamilyCommandStatus> { unsupported() }
    pub fn family_receive(
        &mut self,
        _: &zorid_crypto::OpenedEnvelope,
        _: Option<&zorid_client_sync::CursorAdvance>,
    ) -> Result<FamilyReceiveOutcome> {
        unsupported()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android")))]
fn unsupported<T>() -> Result<T> {
    Err(Error::Unsupported(
        "platform needs no-clobber descriptor-relative filesystem adapter",
    ))
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests;

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod sync_tests;

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod namespace_tests;

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod sqlite_lock_tests;
