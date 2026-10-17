//! Explicit fixture-only transport. Never sends local mutation receipts/outbox rows.
mod credentials;
mod transport;
use super::{Failure, Result};
use clap::Subcommand;
use credentials::Credentials;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use zorid_client_sync::{CursorAdvance, ReceiveCursor};
use zorid_crypto::OpenedEnvelope;
use zorid_file_sync::Scope;
use zorid_native::NativeVault;
use zorid_sync_protocol::{ExpectedContext, LogPosition, UpdateId};

#[derive(Subcommand)]
pub enum Command {
    /// Enroll a fresh empty initialized vault in the current-v2 fixture scope.
    FixtureEnroll,
    /// Obsolete text-v1 command; rejects with unsupported_format.
    FixtureBindEmpty {
        #[arg(long)]
        id: String,
        #[arg(long)]
        bootstrap_id: String,
        #[arg(long)]
        expected_revision: String,
    },
    /// Obsolete text-v1 command; rejects with unsupported_format.
    FixtureAdopt {
        #[arg(long)]
        id: String,
        #[arg(long)]
        bootstrap_id: String,
        #[arg(long)]
        expected_revision: String,
        #[arg(long)]
        operation_id: String,
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Report bounded family upload/dependency/cursor metadata without networking.
    Status,
    /// One bounded E2EE push/pull sweep against the configured loopback fixture.
    Once {
        #[arg(long, default_value_t=64, value_parser=clap::value_parser!(u32).range(0..=1000))]
        max_push: u32,
        #[arg(long, default_value_t=4, value_parser=clap::value_parser!(u32).range(0..=100))]
        max_pages: u32,
    },
}
pub(super) fn error(code: &'static str) -> Failure {
    Failure::new(code,"Fixture sync did not complete; preserve credentials and local state, then retry. No complete synchronization is claimed",1)
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
fn status(vault: &NativeVault, credentials: &Credentials) -> Result<Value> {
    check_binding(vault, credentials)?;
    let status = vault.family_status()?;
    let pending = vault.family_pending_authored(None, 1000)?;
    Ok(
        json!({"scope":"fixture_families_v2","family_sync_supported":true,"all_file_sync_supported":false,"synced":false,
        "family":status,"pending_envelope_sample":pending.len(),"pending_envelope_sample_complete":pending.len()<1000,
        "pending_envelopes":pending,"unsupported_capabilities":["larger_file_streaming","production_enrollment"]}),
    )
}
pub fn run(vault: &mut NativeVault, root: &Path, file: &Path, command: Command) -> Result<Value> {
    let credentials = Credentials::load(file, root)?;
    match command {
        Command::FixtureEnroll => {
            let scope=Scope {realm_id:credentials.realm.clone(),vault_id:credentials.vault.clone()};
            let enrolled=vault.family_enroll(&scope)?;
            Ok(json!({"scope":"fixture_families_v2","enrolled":enrolled,"synced":false}))
        }
        Command::FixtureBindEmpty {..}|Command::FixtureAdopt {..}=>return Err(Failure::new("unsupported_format","Obsolete text-v1 enrollment is unsupported; use a fresh empty fixture vault and fixture-enroll",5)),
        Command::Status => status(vault, &credentials),
        Command::Once {
            max_push,
            max_pages,
        } => once(vault, &credentials, max_push, max_pages),
    }
}
fn once(
    vault: &mut NativeVault,
    credentials: &Credentials,
    max_push: u32,
    max_pages: u32,
) -> Result<Value> {
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
    let mut result = status(vault, credentials)?;
    let value = result.as_object_mut().expect("status object");
    value.insert("server_accepted".into(), json!(uploaded));
    value.insert("locally_received".into(), json!(received));
    value.insert("locally_applied_updates".into(), json!(applied_updates));
    value.insert("duplicate_receipts".into(), json!(duplicate_receipts));
    value.insert(
        "dependency_pending_receipts".into(),
        json!(dependency_pending_receipts),
    );
    value.insert(
        "receive_projection_pending".into(),
        json!(projection_pending),
    );
    value.insert("pull_snapshot_complete".into(), json!(pull_complete));
    value.insert("pull_through".into(), json!(through));
    Ok(result)
}
