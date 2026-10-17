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
    about = "Standalone Zorid vault access (initial native slice)"
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
    /// Resume pending filesystem publications without scanning the whole vault.
    Recover,
    /// Not implemented in this slice.
    Move,
    /// Not implemented in this slice.
    Delete,
    /// Not implemented in this slice.
    Search,
    /// Not implemented in this slice; pending outbox does not mean uploaded.
    Sync,
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
            Store(_) => Self::new("storage_io", "Database operation failed; retry mutations only with the identical operation ID and request", 1),
            Io(_) => Self::new("filesystem_io", "Filesystem operation failed", 1),
        }
    }
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

    if matches!(
        args.command,
        Command::Move | Command::Delete | Command::Search | Command::Sync
    ) {
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
        _ => None,
    };
    let mut vault = NativeVault::open(&args.vault)?;
    let value = match args.command {
        Command::Init => {
            json!({"initialized":true,"imported_existing_files":false,"max_file_bytes":MAX_FILE_BYTES,"sync_available":false})
        }
        Command::Status => {
            let status = vault.status()?;
            // Native status contains recovery bytes. Status must not disclose them.
            json!({"pending_outbox":status.pending_outbox,"pending_projection":status.pending_projection,"projection_attempts":status.attempts.len(),"external_observations":status.observations.len(),"max_file_bytes":MAX_FILE_BYTES,"sync_available":false})
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
        Command::Create { .. } | Command::Write { .. } => {
            let outcome = vault.apply(request.as_ref().expect("mutation request prepared"))?;
            json!({"durable_local_commit":true,"synced":false,"commit":outcome.commit,"projection":outcome.projection})
        }
        Command::Reconcile { paths } => {
            let paths = paths
                .into_iter()
                .map(VaultPath::new)
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let report = vault.reconcile(&paths)?;
            json!({"complete":report.blocked.is_empty(),"report":report,"synced":false})
        }
        Command::Recover => {
            let report = vault.recover()?;
            json!({"complete":report.blocked.is_empty(),"report":report,"synced":false})
        }
        Command::Move | Command::Delete | Command::Search | Command::Sync => unreachable!(),
    };
    Ok(Output::Json(value))
}
