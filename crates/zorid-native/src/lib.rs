//! Native filesystem adapter. SQLite is authority; a commit receipt is NOT a
//! filesystem acknowledgement. See README for crash and security boundaries.
use serde::{Deserialize, Serialize};
use std::{fmt, time::Duration};
use zorid_core::{
    CommitResult, EntryId, EntryState, MutationRequest, OperationId, Revision, VaultPath,
};
mod client_admission;
pub use client_admission::{ClientAdmissionError, ClientLease, ClientLeaseRef};
pub use zorid_store::{
    AuthoredTextStatus, AuthorityIdentity, ChangeOrigin, ChangePage, Checkpoint, CheckpointError,
    CheckpointMetadata, CheckpointPage, CheckpointScope, CheckpointWrite, EntryPresentation,
    HostIntentAcknowledgment, HostIntentPage, HostIntentRef, HostIntentState, HostIntentView,
    HostMutationKind, HostProjectionState, HostRejection, HostRejectionCode, ListingSnapshot,
    LocalChange, PresentedEntry, PresentedState, TextReceiveOutcome, MAX_CHECKPOINT_BYTES,
};
use zorid_store::{DirectoryPhase, ProjectionPhase, ScanRun, StoredEntry};

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
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
#[cfg(any(target_os = "macos", target_os = "linux"))]
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
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod fs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod native;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use native::NativeVault;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub struct NativeVault;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl NativeVault {
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
    pub fn rescan_with_options(&mut self, _: ScanOptions) -> Result<RescanReport> {
        unsupported()
    }
    pub fn recover(&mut self) -> Result<ReconcileReport> {
        unsupported()
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
