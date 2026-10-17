mod sync;

use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
    process::ExitCode,
};

const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Parser)]
#[command(
    name = "zorid",
    version,
    about = "Standalone Zorid vault access and explicit encrypted fixture sync"
)]
struct Args {
    /// Existing vault directory. Only init may initialize its private storage.
    #[arg(long, value_name = "DIRECTORY")]
    vault: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Initialize private storage in an existing directory; does not import files.
    Init,
    /// Report local pending work, without printing file contents.
    Status,
    /// List live entries known to the core (no implicit filesystem scan).
    List,
    /// Read committed bytes by entry ID, as base64 JSON or exact raw bytes.
    Read {
        #[arg(long)]
        id: String,
        /// Emit only file bytes on stdout; errors remain JSON on stderr.
        #[arg(long)]
        raw: bool,
    },
    /// Create a file without overwriting an existing file (16 MiB maximum).
    Create {
        path: String,
        #[arg(long)]
        id: String,
        /// Caller-generated unique operation ID; reuse only for exact retry.
        #[arg(long)]
        operation_id: String,
        /// Read bytes from FILE, or '-' for stdin. No text conversion.
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
        /// Explicit immutable text mode for a fresh enrolled family vault.
        #[arg(long, conflicts_with = "binary")]
        text: bool,
        /// Explicit immutable binary mode for a fresh enrolled family vault.
        #[arg(long, conflicts_with = "text")]
        binary: bool,
    },
    /// Create one folder without replacing an existing path; parents must exist.
    Mkdir {
        path: String,
        #[arg(long)]
        id: String,
        /// Caller-generated operation ID, reused only for an identical retry.
        #[arg(long)]
        operation_id: String,
    },
    /// Replace committed file bytes with an explicit revision precondition.
    Write {
        #[arg(long)]
        id: String,
        #[arg(long)]
        expected_revision: String,
        /// Reuse this ID and the identical request if acknowledgment is lost.
        #[arg(long)]
        operation_id: String,
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Recheck explicit vault-relative paths and import supported external edits.
    Reconcile {
        #[arg(required = true, num_args = 1..)]
        paths: Vec<String>,
    },
    /// Discover external files/folders; enrolled vaults also reconcile proven moves/deletions.
    Rescan {
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..=100_000))]
        max_entries: Option<u32>,
        #[arg(long)]
        max_total_bytes: Option<u64>,
        #[arg(long)]
        max_depth: Option<u16>,
        /// Soft work duration limit, checked between operations (not a hard timeout).
        #[arg(long)]
        max_duration_ms: Option<u64>,
        /// Import newly discovered enrolled files as UTF-8 text instead of auto-detecting.
        #[arg(long, conflicts_with = "binary")]
        text: bool,
        /// Import newly discovered enrolled files as binary instead of auto-detecting.
        #[arg(long, conflicts_with = "text")]
        binary: bool,
    },
    /// Resume pending filesystem publications without scanning the whole vault.
    Recover,
    /// Move an entry and its observed subtree without overwriting other entries.
    Move {
        path: String,
        #[arg(long)]
        id: String,
        #[arg(long)]
        expected_revision: String,
        #[arg(long)]
        operation_id: String,
    },
    /// Retain a logical tombstone and recoverable bytes; never purge files.
    Delete {
        #[arg(long)]
        id: String,
        #[arg(long)]
        expected_revision: String,
        #[arg(long)]
        operation_id: String,
        /// Delete exactly the core-observed subtree; required for nonempty folders.
        #[arg(long)]
        recursive: bool,
    },
    /// Not implemented in this slice.
    Search,
    /// Explicit current-v2 loopback fixture sync; file limits remain bounded.
    Sync {
        /// Owner-only credential JSON outside the vault; never pass secrets as flags.
        #[arg(long, value_name = "FILE")]
        credentials: PathBuf,
        #[command(subcommand)]
        command: sync::Command,
    },
}

struct Failure {
    code: &'static str,
    message: &'static str,
    detail: Option<Value>,
    exit: u8,
}
impl Failure {
    fn new(code: &'static str, message: &'static str, exit: u8) -> Self {
        Self {
            code,
            message,
            detail: None,
            exit,
        }
    }
    fn json(&self) -> Value {
        json!({"version":1,"ok":false,"error":{"code":self.code,"message":self.message,"detail":self.detail}})
    }
}
type Result<T> = std::result::Result<T, Failure>;
enum Output {
    Json(Value),
    Raw(Vec<u8>),
}

fn projection_json(status: zorid_native::ProjectionStatus) -> Value {
    match status {
        zorid_native::ProjectionStatus::Projected => json!({"state":"projected"}),
        zorid_native::ProjectionStatus::Pending(_) => {
            json!({"state":"pending","code":"projection_pending","message":"Local commit succeeded; filesystem publication remains pending"})
        }
    }
}

fn report_json(report: zorid_native::ReconcileReport) -> Value {
    let blocked: Vec<_> = report.blocked.into_iter().map(|(path, _)| {
        json!({"path":path,"code":"reconciliation_blocked","message":"Filesystem reconciliation remains blocked; preserved data needs recovery"})
    }).collect();
    json!({"complete":blocked.is_empty(),"report":{"imported":report.imported,"projected":report.projected,"blocked":blocked},"synced":false})
}

fn write_json(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn main() -> ExitCode {
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            return if error.print().is_ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            };
        }
        Err(_) => {
            // Parser diagnostics can quote arbitrary values (including secrets).
            // Keep machine errors stable and direct humans to explicit help.
            let error = Failure::new(
                "usage",
                "Invalid arguments; use --help or COMMAND --help",
                2,
            );
            let _ = write_json(&mut io::stderr().lock(), &error.json());
            return ExitCode::from(error.exit);
        }
    };
    match run(args) {
        Ok(output) => {
            let result = match output {
                Output::Json(value) => write_json(
                    &mut io::stdout().lock(),
                    &json!({"version":1,"ok":true,"result":value}),
                ),
                Output::Raw(bytes) => {
                    let mut out = io::stdout().lock();
                    out.write_all(&bytes).and_then(|_| out.flush())
                }
            };
            if result.is_err() {
                let error = Failure::new("output_io", "Could not deliver output; a mutation may already be committed. Retry only the identical operation ID and request", 1);
                let _ = write_json(&mut io::stderr().lock(), &error.json());
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(error) => {
            let _ = write_json(&mut io::stderr().lock(), &error.json());
            ExitCode::from(error.exit)
        }
    }
}

fn input_bytes(path: &std::path::Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut input: Box<dyn Read> = if path == std::path::Path::new("-") {
        Box::new(io::stdin())
    } else {
        Box::new(
            std::fs::File::open(path)
                .map_err(|_| Failure::new("input_io", "Could not open input file", 1))?,
        )
    };
    input
        .by_ref()
        .take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::new("input_io", "Could not read input bytes", 1))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(Failure::new(
            "input_too_large",
            "Input exceeds the 16777216 byte limit; nothing was committed",
            2,
        ));
    }
    Ok(bytes)
}

impl From<zorid_core::ContractError> for Failure {
    fn from(error: zorid_core::ContractError) -> Self {
        use zorid_core::ContractError::*;
        let (code, exit) = match &error {
            RevisionConflict { .. } => ("revision_conflict", 3),
            IdempotencyConflict { .. } => ("idempotency_conflict", 3),
            EntryNotFound { .. } | EntryDeleted { .. } => ("not_found", 4),
            InvalidPath { .. } => ("invalid_path", 2),
            InvalidIdentifier { .. } => ("invalid_identifier", 2),
            InvalidMutation { .. } => ("invalid_mutation", 2),
            InvalidOperationRecord => ("corrupt_storage", 1),
        };
        Self {
            code,
            exit,
            message: "Core operation rejected",
            detail: serde_json::to_value(error).ok(),
        }
    }
}

impl From<zorid_native::Error> for Failure {
    fn from(error: zorid_native::Error) -> Self {
        use zorid_native::Error::*;
        match error {
            Contract(error) | Store(zorid_store::StoreError::Contract(error)) => error.into(),
            UnsafePath(_) => Self::new("unsafe_path", "Filesystem safety checks rejected this path", 1),
            Busy(_) => Self::new("filesystem_changed", "Filesystem changed during the operation; reconcile before retrying", 3),
            Unsupported(_) => Self::new("unsupported", "Operation is unsupported by this native adapter slice", 5),
            LockTimeout => Self::new("lock_timeout", "Timed out acquiring the vault lock", 3),
            Store(zorid_store::StoreError::UnsupportedSchema(_)) => Self::new("unsupported_schema", "Database schema is unsupported", 5),
            Store(zorid_store::StoreError::Corrupt(_)) | Store(zorid_store::StoreError::Json(_)) => Self::new("corrupt_storage", "Stored data failed validation", 1),
            Store(zorid_store::StoreError::Sync(error)) => {
                use zorid_client_sync::SyncError::*;
                let (code, exit) = match error {
                    TooLarge => ("sync_limit", 2),
                    UnsupportedFormat => ("sync_unsupported_format", 5),
                    VersionConflict | CursorConflict => ("sync_conflict", 3),
                    IdentityMismatch => ("sync_identity_mismatch", 3),
                    InvalidEdit => ("sync_invalid_edit", 2),
                    AuthenticationFailed => ("sync_authentication_failed", 1),
                    _ => ("sync_validation_failed", 1),
                };
                Self::new(code, "Sync validation failed; preserve the existing state and exact pending work", exit)
            },
            Store(zorid_store::StoreError::FileSync(error)) => {
                use zorid_file_sync::Error::*;
                let (code,exit)=match error {
                    TooLarge=>("sync_limit",2),UnsupportedFormat=>("sync_unsupported_format",5),
                    IdentityMismatch|DuplicateMismatch=>("sync_identity_mismatch",3),VersionConflict=>("sync_conflict",3),
                    AuthenticationFailed=>("sync_authentication_failed",1),_ =>("sync_validation_failed",1),
                };
                Self::new(code,"Family sync validation failed; preserve existing state and exact pending work",exit)
            },
            Store(zorid_store::StoreError::Protocol(error)) => protocol_failure(error),
            Store(zorid_store::StoreError::Crypto(zorid_crypto::CryptoError::Protocol(error))) => protocol_failure(error),
            Store(zorid_store::StoreError::Crypto(_)) => Self::new("sync_crypto_failed", "Encryption or authentication failed; pending work is retained", 1),
            Store(_) => Self::new("storage_io", "Database operation failed; retry mutations only with the identical operation ID and request", 1),
            Io(_) => Self::new("filesystem_io", "Filesystem operation failed", 1),
        }
    }
}

fn protocol_failure(error: zorid_sync_protocol::ProtocolError) -> Failure {
    use zorid_sync_protocol::ProtocolError::*;
    let (code, exit) = match error {
        TooLarge => ("sync_limit", 2),
        EpochMismatch => ("sync_epoch_mismatch", 3),
        ContextMismatch | IdempotencyConflict => ("sync_identity_mismatch", 3),
        UnsupportedTransport
        | UnsupportedEnvelope
        | UnsupportedDocumentFormat
        | UnsupportedRequiredFeature => ("sync_unsupported_protocol", 5),
        _ => ("sync_invalid_protocol", 1),
    };
    Failure::new(
        code,
        "Sync protocol validation failed; no replacement operation or cursor is authorized",
        exit,
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn run(_: Args) -> Result<Output> {
    Err(Failure::new(
        "unsupported_platform",
        "Native filesystem adapter currently supports macOS and Linux",
        5,
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run(args: Args) -> Result<Output> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use zorid_core::{
        EntryId, EntryKind, Mutation, MutationRequest, OperationId, Revision, VaultPath,
    };
    use zorid_native::NativeVault;

    if matches!(args.command, Command::Search) {
        return Err(Failure::new(
            "unsupported",
            "This command is not implemented in the initial CLI slice",
            5,
        ));
    }
    if !matches!(args.command, Command::Init) {
        match std::fs::symlink_metadata(args.vault.join(".zorid/vault.sqlite")) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => {
                return Err(Failure::new(
                    "unsafe_path",
                    "Vault database must be a regular file",
                    1,
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(Failure::new(
                    "vault_not_initialized",
                    "No initialized vault at this directory; init is explicit",
                    4,
                ))
            }
            Err(_) => {
                return Err(Failure::new(
                    "filesystem_io",
                    "Could not inspect vault storage",
                    1,
                ))
            }
        }
    }

    // Prepare and bound mutation input before opening the vault or taking locks.
    let request = match &args.command {
        Command::Create {
            path,
            id,
            operation_id,
            input,
            ..
        } => Some(MutationRequest {
            operation_id: OperationId::new(operation_id.clone())?,
            mutation: Mutation::Create {
                id: EntryId::new(id.clone())?,
                path: VaultPath::new(path.clone())?,
                kind: EntryKind::File,
                content: Some(input_bytes(input)?),
            },
        }),
        Command::Write {
            id,
            expected_revision,
            operation_id,
            input,
        } => Some(MutationRequest {
            operation_id: OperationId::new(operation_id.clone())?,
            mutation: Mutation::Write {
                id: EntryId::new(id.clone())?,
                expected: Revision::new(expected_revision.clone())?,
                content: input_bytes(input)?,
            },
        }),
        Command::Mkdir {
            path,
            id,
            operation_id,
        } => Some(MutationRequest {
            operation_id: OperationId::new(operation_id.clone())?,
            mutation: Mutation::Create {
                id: EntryId::new(id.clone())?,
                path: VaultPath::new(path.clone())?,
                kind: EntryKind::Folder,
                content: None,
            },
        }),
        Command::Move {
            path,
            id,
            expected_revision,
            operation_id,
        } => Some(MutationRequest {
            operation_id: OperationId::new(operation_id.clone())?,
            mutation: Mutation::Move {
                id: EntryId::new(id.clone())?,
                expected: Revision::new(expected_revision.clone())?,
                path: VaultPath::new(path.clone())?,
            },
        }),
        Command::Delete {
            id,
            expected_revision,
            operation_id,
            recursive,
        } => Some(MutationRequest {
            operation_id: OperationId::new(operation_id.clone())?,
            mutation: Mutation::Delete {
                id: EntryId::new(id.clone())?,
                expected: Revision::new(expected_revision.clone())?,
                recursive: *recursive,
            },
        }),
        _ => None,
    };
    let create_mode = match &args.command {
        Command::Create { text: true, .. } => Some(zorid_native::FamilyCreateMode::Text),
        Command::Create { binary: true, .. } => Some(zorid_native::FamilyCreateMode::Binary),
        _ => None,
    };
    // The metadata preflight above provides a useful missing-vault error only.
    // The adapter enforces existing-only under its own lock and SQLite open flags.
    let mut vault = if matches!(args.command, Command::Init) {
        NativeVault::open(&args.vault)?
    } else {
        NativeVault::open_existing(&args.vault)?
    };
    let value = match args.command {
        Command::Sync {
            credentials,
            command,
        } => sync::run(&mut vault, &args.vault, &credentials, command)?,
        Command::Init => {
            json!({"initialized":true,"imported_existing_files":false,"max_file_bytes":MAX_FILE_BYTES,"sync_available":false,"fixture_family_sync_available":true})
        }
        Command::Status => {
            let status = vault.status()?;
            // Keep status limited to operational counts, without recovery bodies.
            json!({"pending_outbox":status.pending_outbox,"pending_projection":status.pending_projection,"projection_attempts":status.attempts.len(),"external_observations":status.observations.len(),"max_file_bytes":MAX_FILE_BYTES,"sync_available":false,"fixture_family_sync_available":true})
        }
        Command::List => json!({"entries":vault.list()?}),
        Command::Read { id, raw } => {
            let entry = vault
                .read(&EntryId::new(id)?)?
                .ok_or_else(|| Failure::new("not_found", "Entry was not found", 4))?;
            let bytes = entry
                .content
                .ok_or_else(|| Failure::new("not_file", "Entry is a folder, not a file", 2))?;
            if raw {
                return Ok(Output::Raw(bytes));
            }
            json!({"entry":entry.state,"encoding":"base64","bytes":STANDARD.encode(bytes)})
        }
        Command::Create { .. }
        | Command::Write { .. }
        | Command::Mkdir { .. }
        | Command::Move { .. }
        | Command::Delete { .. } => {
            let request = request.as_ref().expect("mutation request prepared");
            let outcome = if create_mode.is_some() {
                vault.family_apply(request, create_mode)?
            } else {
                vault.apply(request)?
            };
            json!({"durable_local_commit":true,"synced":false,"commit":outcome.commit,"projection":projection_json(outcome.projection)})
        }
        Command::Reconcile { paths } => {
            let paths = paths
                .into_iter()
                .map(VaultPath::new)
                .collect::<std::result::Result<Vec<_>, _>>()?;
            report_json(vault.reconcile(&paths)?)
        }
        Command::Recover => report_json(vault.recover()?),
        Command::Rescan {
            max_entries,
            max_total_bytes,
            max_depth,
            max_duration_ms,
            text,
            binary,
        } => {
            let mut options = zorid_native::ScanOptions::default();
            if let Some(value) = max_entries {
                options.max_entries = value;
            }
            if let Some(value) = max_total_bytes {
                options.max_total_bytes = value;
            }
            if let Some(value) = max_depth {
                options.max_depth = value;
            }
            if let Some(value) = max_duration_ms {
                options.max_duration = std::time::Duration::from_millis(value);
            }
            let limits = json!({"max_entries":options.max_entries,"max_total_bytes":options.max_total_bytes.to_string(),"max_depth":options.max_depth,"max_duration_ms":options.max_duration.as_millis().to_string()});
            if vault.family_status()?.scope.is_some() {
                let mode = if text {
                    zorid_native::ExternalFileMode::Text
                } else if binary {
                    zorid_native::ExternalFileMode::Binary
                } else {
                    zorid_native::ExternalFileMode::Auto
                };
                let report = vault.reconcile_external(options, mode)?;
                let issues: Vec<_> = report.issues.into_iter().map(|issue| json!({"path":issue.path,"code":"scan_issue","message":"This path could not be fully reconciled; data is preserved"})).collect();
                let namespace: Vec<_> = report.namespace.into_iter().map(|commit| json!({"observation_id":commit.observation_id,"cursor":commit.cursor,"changed":commit.changed,"authored":commit.authored,"pending_content":commit.pending_content})).collect();
                json!({"complete":report.complete,"run":{"scan_id":report.run.scan_id,"max_entries":report.run.max_entries,"finished":report.run.finished,"complete":report.run.complete,"observed":report.run.observed,"imported":report.run.imported,"issue":report.run.issue.map(|_| "scan_incomplete")},"issues":issues,"imported":report.imported.len(),"namespace":namespace,"missing_are_deletions":true,"limits":limits,"synced":false})
            } else {
                let report = vault.rescan_with_options(options)?;
                let issues: Vec<_> = report.issues.into_iter().map(|issue| json!({"path":issue.path,"code":"scan_issue","message":"This path could not be fully reconciled; data is preserved"})).collect();
                json!({"complete":report.run.complete,"run":{"scan_id":report.run.scan_id,"max_entries":report.run.max_entries,"finished":report.run.finished,"complete":report.run.complete,"observed":report.run.observed,"imported":report.run.imported,"issue":report.run.issue.map(|_| "scan_incomplete")},"issues":issues,"missing":report.missing,"missing_are_deletions":false,"limits":limits,"synced":false})
            }
        }
        Command::Search => unreachable!(),
    };
    Ok(Output::Json(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_success_never_prints_native_diagnostics() {
        let projection = projection_json(zorid_native::ProjectionStatus::Pending(
            "secret SQL diagnostic".into(),
        ));
        assert_eq!(projection["code"], "projection_pending");
        assert!(!projection.to_string().contains("secret"));
        let report = report_json(zorid_native::ReconcileReport {
            blocked: vec![(
                zorid_core::VaultPath::new("note.md").unwrap(),
                "secret database diagnostic".into(),
            )],
            ..Default::default()
        });
        assert_eq!(report["complete"], false);
        assert_eq!(
            report["report"]["blocked"][0]["code"],
            "reconciliation_blocked"
        );
        assert!(!report.to_string().contains("secret"));
    }
}
