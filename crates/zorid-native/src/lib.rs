//! Native filesystem adapter. SQLite is authority; a commit receipt is NOT a
//! filesystem acknowledgement. See README for crash and security boundaries.
use serde::{Deserialize, Serialize};
use std::{fmt, time::Duration};
use zorid_core::{
    CommitResult, EntryId, EntryState, MutationRequest, OperationId, Revision, VaultPath,
};
use zorid_store::{ProjectionPhase, StoredEntry};

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
    pub fn list(&self) -> Result<Vec<EntryState>> {
        unsupported()
    }
    pub fn read(&self, _: &EntryId) -> Result<Option<StoredEntry>> {
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
