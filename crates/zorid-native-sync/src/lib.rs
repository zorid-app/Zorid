//! Shared blocking native orchestration for explicit loopback sync fixtures.
//! Extracted from the standalone CLI; neither frontend owns transport/CRDT semantics.
//! A bounded per-sweep RPC worker owns its runtime; no daemon or IPC requirement.
//!
//! A failed sweep may have committed earlier uploads or receives. Reuse retained
//! state and exact ciphertext on retry; failure never authorizes a new update ID.
//! Filesystem Pending after a durable receive does not prevent cursor progress.
//! Call on a host worker thread: methods perform bounded blocking network I/O.
mod credentials;
mod error;
mod transport;
use credentials::Credentials;
pub use error::Error;
use serde::{Deserialize, Serialize};
use std::path::Path;
use zorid_client_sync::{CursorAdvance, ReceiveCursor};
use zorid_crypto::OpenedEnvelope;
use zorid_file_sync::Scope;
use zorid_native::{FamilyAuthoredStatus, FamilyStatus, NativeVault};
use zorid_sync_protocol::{ExpectedContext, LogPosition, UpdateId};
pub type Result<T> = std::result::Result<T, Error>;
pub(crate) fn error(code: &'static str) -> Error {
    Error::new(code, 1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncLimits {
    pub max_push: u32,
    pub max_pages: u32,
}
impl Default for SyncLimits {
    fn default() -> Self {
        Self {
            max_push: 64,
            max_pages: 4,
        }
    }
}
impl SyncLimits {
    pub fn validate(self) -> Result<()> {
        if self.max_push > 1000 || self.max_pages > 100 {
            Err(Error::new("sync_limit", 2))
        } else {
            Ok(())
        }
    }
}
#[derive(Serialize)]
pub struct SyncStatus {
    pub scope: &'static str,
    pub family_sync_supported: bool,
    pub all_file_sync_supported: bool,
    pub synced: bool,
    pub family: FamilyStatus,
    pub pending_envelope_sample: u32,
    pub pending_envelope_sample_complete: bool,
    pub pending_envelopes: Vec<FamilyAuthoredStatus>,
    pub unsupported_capabilities: [&'static str; 2],
}
#[derive(Serialize)]
pub struct SyncReport {
    #[serde(flatten)]
    pub status: SyncStatus,
    pub server_accepted: u32,
    pub locally_received: u32,
    pub locally_applied_updates: u32,
    pub duplicate_receipts: u32,
    pub dependency_pending_receipts: u32,
    pub receive_projection_pending: u32,
    pub pull_snapshot_complete: bool,
    pub pull_through: Option<LogPosition>,
}
/// Process-local protected credentials. Intentionally no Debug/Serialize/Clone;
/// hosts pass only a trusted config path, never secrets through a renderer/RPC.
pub struct FixtureSync {
    credentials: Credentials,
}
impl FixtureSync {
    /// `vault_root` is the same trusted root the caller uses to open NativeVault.
    /// It enforces credential placement outside the vault, not an OS path lease.
    /// Every operation separately validates logical authority/scope. Protection
    /// rejects final-component symlinks; parent-component symlinks remain allowed.
    pub fn load(config_path: &Path, vault_root: &Path) -> Result<Self> {
        Ok(Self {
            credentials: Credentials::load(config_path, vault_root)?,
        })
    }
    pub fn scope(&self) -> Scope {
        Scope {
            realm_id: self.credentials.realm.clone(),
            vault_id: self.credentials.vault.clone(),
        }
    }
    pub fn check_binding(&self, vault: &NativeVault) -> Result<()> {
        check_binding(vault, &self.credentials)
    }
    pub fn enroll(&self, vault: &mut NativeVault) -> Result<FamilyStatus> {
        Ok(vault.family_enroll(&self.scope())?)
    }
    pub fn status(&self, vault: &NativeVault) -> Result<SyncStatus> {
        status(vault, &self.credentials)
    }
    pub fn once(&self, vault: &mut NativeVault, limits: SyncLimits) -> Result<SyncReport> {
        limits.validate()?;
        once(vault, &self.credentials, limits.max_push, limits.max_pages)
    }
}
fn context(credentials: &Credentials, update_id: UpdateId) -> ExpectedContext {
    ExpectedContext {
        realm_id: credentials.realm.clone(),
        vault_id: credentials.vault.clone(),
        update_id,
        key_epoch: credentials.key_epoch,
    }
}
fn check_binding(vault: &NativeVault, credentials: &Credentials) -> Result<()> {
    let identity = vault.identity()?;
    if identity.realm_id.as_ref() != Some(&credentials.realm)
        || identity.vault_id.as_ref() != Some(&credentials.vault)
    {
        return Err(error("sync_binding_mismatch"));
    }
    let family = vault.family_status()?;
    if family.scope.as_ref()
        != Some(&Scope {
            realm_id: credentials.realm.clone(),
            vault_id: credentials.vault.clone(),
        })
    {
        return Err(error("sync_binding_mismatch"));
    }
    Ok(())
}
fn status(vault: &NativeVault, credentials: &Credentials) -> Result<SyncStatus> {
    check_binding(vault, credentials)?;
    let family = vault.family_status()?;
    let pending = vault.family_pending_authored(None, 1000)?;
    Ok(SyncStatus {
        scope: "fixture_families_v2",
        family_sync_supported: true,
        all_file_sync_supported: false,
        synced: false,
        family,
        pending_envelope_sample: pending.len() as u32,
        pending_envelope_sample_complete: pending.len() < 1000,
        pending_envelopes: pending,
        unsupported_capabilities: ["larger_file_streaming", "production_enrollment"],
    })
}
fn once(
    vault: &mut NativeVault,
    credentials: &Credentials,
    max_push: u32,
    max_pages: u32,
) -> Result<SyncReport> {
    check_binding(vault, credentials)?;
    let relay = transport::Relay::connect(credentials)?;
    let mut cursor = match vault.family_receive_cursor(&credentials.realm, &credentials.vault)? {
        Some(current) => {
            if current.server_epoch != credentials.server_epoch {
                return Err(error("sync_epoch_mismatch"));
            }
            current
        }
        None => {
            let start = ReceiveCursor {
                realm_id: credentials.realm.clone(),
                vault_id: credentials.vault.clone(),
                server_epoch: credentials.server_epoch.clone(),
                after: LogPosition::new(0),
            };
            vault.family_set_receive_cursor(None, &start)?;
            start
        }
    };
    let mut uploaded = 0;
    if max_push > 0 {
        for pending in vault.family_pending_authored(None, max_push)? {
            if pending.scope.realm_id != credentials.realm
                || pending.scope.vault_id != credentials.vault
            {
                return Err(error("sync_binding_mismatch"));
            }
            let expected = context(credentials, pending.update_id.clone());
            let wire = vault.family_seal(&expected, &credentials.key)?;
            relay.push(&expected.update_id, &wire)?;
            // No ACK before validated remote acceptance; a lost ACK leaves the
            // immutable winning ciphertext queued for a later independent run.
            vault.family_ack(
                &credentials.realm,
                &credentials.vault,
                &expected.update_id,
                &wire,
            )?;
            uploaded += 1;
        }
    }
    let mut through = None;
    let mut received = 0;
    let mut projection_pending = 0;
    let mut applied_updates = 0;
    let mut duplicate_receipts = 0;
    let mut dependency_pending_receipts = 0;
    let mut pull_complete = false;
    for _ in 0..max_pages {
        let page = relay.pull(&cursor, through)?;
        through = Some(page.through);
        // Authentication of all bounded page wires precedes any receive commit.
        let mut opened = Vec::with_capacity(page.items.len());
        for item in page.items {
            let envelope = zorid_sync_protocol::Envelope::decode(&item.wire)
                .map_err(|_| error("sync_invalid_envelope"))?;
            let expected = context(credentials, envelope.header().update_id().clone());
            let incoming = OpenedEnvelope::open(&item.wire, &expected, &credentials.key)
                .map_err(|_| error("sync_authentication_failed"))?;
            opened.push((item.sequence, incoming));
        }
        for (position, incoming) in opened {
            let next = ReceiveCursor {
                after: position,
                ..cursor.clone()
            };
            let delivery = CursorAdvance {
                expected: cursor.clone(),
                next: next.clone(),
            };
            let outcome = vault.family_receive(&incoming, Some(&delivery))?;
            if outcome.commit.cursor.as_ref() != Some(&next)
                || outcome.commit.scope.realm_id != credentials.realm
                || outcome.commit.scope.vault_id != credentials.vault
                || &outcome.commit.update_id != incoming.header().update_id()
            {
                return Err(error("sync_cursor_outcome_unknown"));
            }
            // This cursor is safe after durable DB commit even when filesystem
            // publication remains pending. Failed receives never advance here.
            cursor = next;
            if outcome.commit.duplicate {
                duplicate_receipts += 1;
            }
            if !outcome.commit.changed_entry_ids.is_empty() {
                applied_updates += 1;
            }
            if outcome.commit.pending_prerequisites > 0 {
                dependency_pending_receipts += 1;
            }
            if matches!(
                outcome.projection,
                zorid_native::ProjectionStatus::Pending(_)
            ) {
                projection_pending += 1;
            }
            received += 1;
        }
        if page.complete {
            pull_complete = true;
            break;
        }
    }
    Ok(SyncReport {
        status: status(vault, credentials)?,
        server_accepted: uploaded,
        locally_received: received,
        locally_applied_updates: applied_updates,
        duplicate_receipts,
        dependency_pending_receipts,
        receive_projection_pending: projection_pending,
        pull_snapshot_complete: pull_complete,
        pull_through: through,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direct_hosts_get_the_same_sweep_bounds_as_cli_parser() {
        SyncLimits::default().validate().unwrap();
        SyncLimits {
            max_push: 0,
            max_pages: 0,
        }
        .validate()
        .unwrap();
        SyncLimits {
            max_push: 1000,
            max_pages: 100,
        }
        .validate()
        .unwrap();
        for limits in [
            SyncLimits {
                max_push: 1001,
                max_pages: 0,
            },
            SyncLimits {
                max_push: 0,
                max_pages: 101,
            },
        ] {
            assert_eq!(limits.validate().unwrap_err().code(), "sync_limit");
        }
    }
}
