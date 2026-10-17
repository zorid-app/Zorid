//! Explicit fixture-only transport. Never sends local mutation receipts/outbox rows.
mod credentials;
mod transport;
use super::{Failure, Result};
use clap::Subcommand;
use credentials::Credentials;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use zorid_client_sync::{
    AuthenticatedText, CursorAdvance, ReceiveCursor, ReceiveRequest, TextIdentity,
};
use zorid_core::{EntryId, Mutation, MutationRequest, OperationId, Revision};
use zorid_native::NativeVault;
use zorid_sync_protocol::{ExpectedContext, LogPosition, UpdateId};

#[derive(Subcommand)]
pub enum Command {
    /// Bind an existing empty file to an explicitly shared fixture identity (offline).
    FixtureBindEmpty {
        #[arg(long)]
        id: String,
        #[arg(long)]
        bootstrap_id: String,
        #[arg(long)]
        expected_revision: String,
    },
    /// Explicitly author existing exact bytes once as a shared text bootstrap (offline).
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
    /// Report bounded text upload/cursor metadata without contacting the relay.
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
    Failure::new(code,"Fixture sync did not complete; preserve credentials and local state, then retry. No full-vault synchronization is claimed",1)
}
fn context(credentials: &Credentials, update_id: UpdateId) -> ExpectedContext {
    ExpectedContext {
        realm_id: credentials.realm.clone(),
        vault_id: credentials.vault.clone(),
        update_id,
        key_epoch: credentials.key_epoch,
    }
}
fn text_identity(credentials: &Credentials, id: String, bootstrap: String) -> Result<TextIdentity> {
    Ok(TextIdentity {
        realm_id: credentials.realm.clone(),
        vault_id: credentials.vault.clone(),
        entry_id: EntryId::new(id)?,
        bootstrap_id: UpdateId::new(bootstrap).map_err(|_| error("sync_invalid_identity"))?,
    })
}
fn check_binding(vault: &NativeVault, credentials: &Credentials) -> Result<()> {
    let identity = vault.identity()?;
    if identity.realm_id.as_ref() != Some(&credentials.realm)
        || identity.vault_id.as_ref() != Some(&credentials.vault)
    {
        return Err(error("sync_binding_mismatch"));
    }
    Ok(())
}
fn status(vault: &NativeVault, credentials: &Credentials) -> Result<Value> {
    check_binding(vault, credentials)?;
    let pending = vault.pending_authored_text(None, 1000)?;
    let cursor = vault.text_receive_cursor(&credentials.realm, &credentials.vault)?;
    let native = vault.status()?;
    Ok(
        json!({"scope":"fixture_text_only","all_file_sync_supported":false,"synced":false,
        "pending_text_sample":pending.len(),"pending_text_sample_complete":pending.len()<1000,
        "pending_text":pending,"receive_cursor":cursor,"pending_projection":native.pending_projection,
        "local_command_outbox_unclassified":native.pending_outbox,"unsupported_capabilities":["binary_sync","namespace_sync","production_enrollment"]}),
    )
}
pub fn run(vault: &mut NativeVault, root: &Path, file: &Path, command: Command) -> Result<Value> {
    let credentials = Credentials::load(file, root)?;
    match command {
        Command::FixtureBindEmpty {
            id,
            bootstrap_id,
            expected_revision,
        } => {
            let identity = text_identity(&credentials, id, bootstrap_id)?;
            let state = vault.bind_empty_text(&identity, &Revision::new(expected_revision)?)?;
            Ok(
                json!({"scope":"fixture_text_only","bound":state.identity,"revision":state.version,"synced":false}),
            )
        }
        Command::FixtureAdopt {
            id,
            bootstrap_id,
            expected_revision,
            operation_id,
            input,
        } => {
            let identity = text_identity(&credentials, id, bootstrap_id)?;
            let request = MutationRequest {
                operation_id: OperationId::new(operation_id)?,
                mutation: Mutation::Write {
                    id: identity.entry_id.clone(),
                    expected: Revision::new(expected_revision)?,
                    content: super::input_bytes(&input)?,
                },
            };
            let outcome = vault.adopt_text(&identity, &request)?;
            Ok(
                json!({"scope":"fixture_text_only","durable_local_commit":true,"commit":outcome.commit,
                "projection":super::projection_json(outcome.projection),"synced":false}),
            )
        }
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
    let mut cursor = match vault.text_receive_cursor(&credentials.realm, &credentials.vault)? {
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
            vault.set_text_receive_cursor(None, &start)?;
            start
        }
    };
    let mut uploaded = 0;
    if max_push > 0 {
        for pending in vault.pending_authored_text(None, max_push)? {
            if pending.identity.realm_id != credentials.realm
                || pending.identity.vault_id != credentials.vault
            {
                return Err(error("sync_binding_mismatch"));
            }
            let expected = context(credentials, pending.update_id.clone());
            let wire = vault.seal_authored_text(&expected, &credentials.key)?;
            relay.push(&expected.update_id, &wire)?;
            // No ACK before validated remote acceptance; a lost ACK leaves the
            // immutable winning ciphertext queued for a later independent run.
            vault.acknowledge_authored_text(
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
            let incoming = AuthenticatedText::open(&item.wire, &expected, &credentials.key)
                .map_err(|_| error("sync_authentication_failed"))?;
            opened.push((item.sequence, incoming));
        }
        for (position, incoming) in opened {
            let current = vault
                .text_state(&incoming.identity().entry_id)?
                .ok_or_else(|| error("sync_unbound_entry"))?;
            let next = ReceiveCursor {
                after: position,
                ..cursor.clone()
            };
            let request = ReceiveRequest {
                expected_version: current.version,
                next_version: Revision::new(uuid::Uuid::new_v4().to_string())?,
                delivery: Some(CursorAdvance {
                    expected: cursor.clone(),
                    next: next.clone(),
                }),
            };
            let outcome = vault.receive_text(&incoming, &request)?;
            // This cursor is safe after durable DB commit even when filesystem
            // publication remains pending. Failed receives never advance here.
            cursor = next;
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
    value.insert(
        "receive_projection_pending".into(),
        json!(projection_pending),
    );
    value.insert("pull_snapshot_complete".into(), json!(pull_complete));
    value.insert("pull_through".into(), json!(through));
    Ok(result)
}
