//! Trusted native-only fixture calls. Renderer dispatch never selects these APIs.
//! The caller serializes calls with dispatch/refresh/close on the same host.
use super::{admission_fault, family, fault, initialize_desktop_vault, native_fault};
use super::{ClientLeases, EmbeddedHost, NativeVault, OperationId, Value};
use serde::Serialize;
use std::path::{Path, PathBuf};
use zorid_native_sync::{FixtureSync, SyncReport, SyncStatus};

pub use zorid_native_sync::SyncLimits as EmbeddedFixtureSyncLimits;

/// Maximum complete native result envelope; DTO checks reserve envelope overhead.
pub const MAX_EMBEDDED_FIXTURE_RESULT_BYTES: usize = 64 * 1024;
const ENVELOPE_RESERVE: usize = 1024;

/// Startup authority from a native fixture selector, never renderer JSON.
/// Deliberately neither deserializable nor debug-printable. Fields stay private.
pub struct TrustedFixtureSyncOptions {
    client_id: OperationId,
    credentials_path: PathBuf,
}
impl TrustedFixtureSyncOptions {
    pub fn new(client_id: &str, credentials_path: PathBuf) -> Result<Self, Value> {
        // Same canonical lowercase UUID spelling accepted by native admission.
        let canonical = client_id.len() == 36
            && client_id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                }
            });
        if !canonical {
            return Err(fault("invalid_client_id"));
        }
        if !credentials_path.is_absolute()
            || credentials_path.as_os_str().len() > 4096
            || credentials_path.as_os_str().as_encoded_bytes().contains(&0)
        {
            return Err(fault("credentials_permissions"));
        }
        Ok(Self {
            client_id: OperationId::new(client_id).map_err(|_| fault("invalid_client_id"))?,
            credentials_path,
        })
    }
}

pub(super) struct EmbeddedFixtureSync {
    client_id: OperationId,
    runner: FixtureSync,
}

/// Presentation-only projection. No scopes, cursors, update IDs, paths or wires.
/// Private fields prevent callers from substituting unbounded or secret strings.
#[derive(Serialize)]
pub struct MobileFixtureStatus {
    scope: &'static str,
    family_sync_supported: bool,
    all_file_sync_supported: bool,
    synced: bool,
    pending_authored: String,
    pending_dependencies: String,
    pending_projection: String,
    recovery_entries: String,
    pending_envelope_sample: u32,
    pending_envelope_sample_complete: bool,
}
impl From<SyncStatus> for MobileFixtureStatus {
    fn from(status: SyncStatus) -> Self {
        Self {
            scope: status.scope,
            family_sync_supported: status.family_sync_supported,
            all_file_sync_supported: status.all_file_sync_supported,
            synced: status.synced,
            pending_authored: status.family.pending_authored,
            pending_dependencies: status.family.pending_dependencies,
            pending_projection: status.family.pending_projection,
            recovery_entries: status.family.recovery_entries,
            pending_envelope_sample: status.pending_envelope_sample,
            pending_envelope_sample_complete: status.pending_envelope_sample_complete,
        }
    }
}
#[derive(Serialize)]
pub struct MobileFixtureReport {
    status: MobileFixtureStatus,
    server_accepted: u32,
    locally_received: u32,
    locally_applied_updates: u32,
    duplicate_receipts: u32,
    dependency_pending_receipts: u32,
    receive_projection_pending: u32,
    pull_snapshot_complete: bool,
}
impl From<SyncReport> for MobileFixtureReport {
    fn from(report: SyncReport) -> Self {
        Self {
            status: report.status.into(),
            server_accepted: report.server_accepted,
            locally_received: report.locally_received,
            locally_applied_updates: report.locally_applied_updates,
            duplicate_receipts: report.duplicate_receipts,
            dependency_pending_receipts: report.dependency_pending_receipts,
            receive_projection_pending: report.receive_projection_pending,
            pull_snapshot_complete: report.pull_snapshot_complete,
        }
    }
}
fn bounded<T: Serialize>(value: T, uncertain: bool) -> Result<T, Value> {
    let size = serde_json::to_vec(&value)
        .map_err(|_| response_fault(uncertain))?
        .len();
    if size > MAX_EMBEDDED_FIXTURE_RESULT_BYTES - ENVELOPE_RESERVE {
        return Err(response_fault(uncertain));
    }
    Ok(value)
}
fn response_fault(uncertain: bool) -> Value {
    serde_json::json!({
        "code":"sync_response_limit", "commit_uncertain":uncertain,
        "message":"Fixture result unavailable; preserve durable retry state"
    })
}

impl EmbeddedHost {
    /// Opt-in for an already enrolled disposable fixture. No enrollment/rebind,
    /// new store, local-only fallback, secret copying or network happens here.
    pub fn open_local_with_fixture(
        root: &Path,
        options: TrustedFixtureSyncOptions,
    ) -> Result<Self, Value> {
        let mut vault = NativeVault::open_existing(root).map_err(native_fault)?;
        let runner = FixtureSync::load(&options.credentials_path, root)
            .map_err(|error| family::sync_fault(error, false))?;
        // Check this SAME handle before initialization can scan or create scope.
        runner.check_binding(&vault)
            .map_err(|error| family::sync_fault(error, false))?;
        let reconciliation = initialize_desktop_vault(&mut vault)?;
        Ok(Self {
            vault,
            leases: ClientLeases::default(),
            reconciliation,
            fixture_sync: Some(EmbeddedFixtureSync { client_id: options.client_id, runner }),
        })
    }

    /// Requires exactly one existing generation owned by this host; never claims
    /// a second consumer, accepts a web token, or reuses another host's lease.
    fn authorize_fixture_sync(&self) -> Result<(), Value> {
        let fixture = self.fixture_sync.as_ref()
            .ok_or_else(|| fault("fixture_sync_not_configured"))?;
        let mut matching = self.leases.active.values()
            .filter(|lease| lease.reference().client_id == fixture.client_id);
        let lease = matching.next().ok_or_else(|| fault("client_not_admitted"))?;
        if matching.next().is_some() {
            return Err(fault("client_not_admitted"));
        }
        self.vault.verify_client_lease(lease).map_err(admission_fault)
    }

    /// Native-only read; dispatch's renderer fixture guard remains unchanged.
    pub fn fixture_sync_status(&mut self) -> Result<MobileFixtureStatus, Value> {
        self.authorize_fixture_sync()?;
        let fixture = self.fixture_sync.as_ref()
            .ok_or_else(|| fault("fixture_sync_not_configured"))?;
        let status = fixture.runner.status(&self.vault)
            .map_err(|error| family::sync_fault(error, false))?;
        bounded(status.into(), false)
    }

    /// Foreground fixture sweep only. The caller drains accepted calls before
    /// close; this synchronous operation cannot be interrupted or rolled back.
    pub fn fixture_sync_once(
        &mut self,
        limits: EmbeddedFixtureSyncLimits,
    ) -> Result<MobileFixtureReport, Value> {
        self.authorize_fixture_sync()?;
        if limits.max_push > 1 || limits.max_pages > 1 {
            return Err(fault("sync_limit"));
        }
        let fixture = self.fixture_sync.as_ref()
            .ok_or_else(|| fault("fixture_sync_not_configured"))?;
        fixture.runner.check_binding(&self.vault)
            .map_err(|error| family::sync_fault(error, false))?;
        // From entry to once onward, failure may follow durable/network progress.
        let report = fixture.runner.once(&mut self.vault, limits)
            .map_err(|error| family::sync_fault(error, true))?;
        bounded(report.into(), true)
    }
}
