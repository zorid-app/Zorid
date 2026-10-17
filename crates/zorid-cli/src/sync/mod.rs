//! CLI parsing and JSON presentation for the shared native fixture runner.
use super::{Failure, Result};
use clap::Subcommand;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use zorid_native::NativeVault;
use zorid_native_sync::{FixtureSync, SyncLimits};
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
impl From<zorid_native_sync::Error> for Failure {
    fn from(error: zorid_native_sync::Error) -> Self {
        Failure::new(error.code(), "Fixture sync did not complete; preserve credentials and local state, then retry. No complete synchronization is claimed", error.exit_code())
    }
}
pub fn run(vault: &mut NativeVault, root: &Path, file: &Path, command: Command) -> Result<Value> {
    let sync = FixtureSync::load(file, root)?;
    let result = match command {
        Command::FixtureEnroll => json!({"scope":"fixture_families_v2","enrolled":sync.enroll(vault)?,"synced":false}),
        Command::FixtureBindEmpty { .. } | Command::FixtureAdopt { .. } => return Err(Failure::new("unsupported_format","Obsolete text-v1 enrollment is unsupported; use a fresh empty fixture vault and fixture-enroll",5)),
        Command::Status => serde_json::to_value(sync.status(vault)?).map_err(|_| Failure::new("output_io", "Could not encode sync status", 1))?,
        Command::Once { max_push, max_pages } => serde_json::to_value(sync.once(vault, SyncLimits { max_push, max_pages })?).map_err(|_| Failure::new("output_io", "Could not encode sync result; earlier work may be committed", 1))?,
    };
    Ok(result)
}
