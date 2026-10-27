//! Local collection commands share native validation and publication with the app.
//! Mutations accept explicit operation identities; the CLI never synthesizes a
//! replacement operation after an uncertain result or enrolls a vault in sync.
use super::{Failure, Result};
use clap::Subcommand;
use serde_json::{json, Map, Value};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;

#[derive(Subcommand)]
pub enum Command {
    /// List local collections, including recoverable deleted definitions.
    List,
    /// Read one collection by stable database ID.
    Get {
        #[arg(long)]
        id: String,
    },
    /// Create a collection. Input is a JSON command object with operationId.
    Create {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Update a collection with expectedRevision and operationId in JSON input.
    Update {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Create a new owned note; existing notes cannot be imported or moved.
    CreateEntry {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Duplicate an owned note within the same collection with a fresh identity.
    DuplicateEntry {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Set typed values using stable field IDs and an explicit revision guard.
    Set {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Trash a collection and its owned entries; no conversion to ordinary notes.
    Delete {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Restore a trashed collection and its entries.
    Restore {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
    /// Resume retained collection projections without creating a new mutation.
    Retry,
    /// Execute an exact native database request envelope. '-' reads stdin.
    Request {
        #[arg(long, value_name = "FILE")]
        input: PathBuf,
    },
}

fn invalid_input() -> Failure {
    Failure::new(
        "invalid_database_request",
        "Expected a supported local database JSON request; nothing was committed",
        2,
    )
}

fn read_json(reader: &mut impl Read) -> Result<Value> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::new("input_io", "Could not read database request", 1))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(Failure::new(
            "input_too_large",
            "Database request exceeds the 1048576 byte limit; nothing was committed",
            2,
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid_input())
}

fn input_json(path: &Path) -> Result<Value> {
    if path == Path::new("-") {
        read_json(&mut io::stdin().lock())
    } else {
        let mut file = std::fs::File::open(path)
            .map_err(|_| Failure::new("input_io", "Could not open database request file", 1))?;
        read_json(&mut file)
    }
}

fn envelope(op: &str, fields: Value) -> Result<Value> {
    let Value::Object(mut command) = fields else {
        return Err(invalid_input());
    };
    if command.get("op").is_some_and(|value| value != op) {
        return Err(invalid_input());
    }
    command.insert("op".into(), Value::String(op.into()));
    Ok(json!({"schemaVersion":1,"command":command}))
}

fn command_request(command: Command) -> Result<Value> {
    match command {
        Command::List => envelope("list", Value::Object(Map::new())),
        Command::Get { id } => envelope("get", json!({"collectionId":id})),
        Command::Retry => envelope("retry", Value::Object(Map::new())),
        Command::Create { input } => envelope("create", input_json(&input)?),
        Command::Update { input } => envelope("update", input_json(&input)?),
        Command::CreateEntry { input } => envelope("create_entry", input_json(&input)?),
        Command::DuplicateEntry { input } => envelope("duplicate_entry", input_json(&input)?),
        Command::Set { input } => envelope("set_entry", input_json(&input)?),
        Command::Delete { input } => envelope("delete", input_json(&input)?),
        Command::Restore { input } => envelope("restore", input_json(&input)?),
        Command::Request { input } => input_json(&input),
    }
}

pub fn run(vault: &mut zorid_native::NativeVault, command: Command) -> Result<Value> {
    let request: zorid_native::DatabaseRequest =
        serde_json::from_value(command_request(command)?).map_err(|_| invalid_input())?;
    let response = vault.database_request(&request)?;
    serde_json::to_value(response).map_err(|_| Failure::new("database_response", "Could not encode local database response; retry mutations only with the identical operation ID and request", 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_input_is_bounded_before_native_mutation() {
        let mut input = io::repeat(b' ').take((MAX_REQUEST_BYTES + 1) as u64);
        assert_eq!(read_json(&mut input).unwrap_err().code, "input_too_large");
    }

    #[test]
    fn command_cannot_disguise_a_different_operation() {
        assert_eq!(
            envelope("create", json!({"op":"delete"})).unwrap_err().code,
            "invalid_database_request"
        );
        assert_eq!(
            envelope("create", json!([])).unwrap_err().code,
            "invalid_database_request"
        );
    }

    #[test]
    fn exact_request_fields_survive_operation_envelope() {
        let fields =
            json!({"operationId":"retry-identity","expectedRevision":"r7","values":{"field":null}});
        let request = envelope("set", fields.clone()).unwrap();
        assert_eq!(request["schemaVersion"], 1);
        assert_eq!(request["command"]["operationId"], fields["operationId"]);
        assert_eq!(
            request["command"]["expectedRevision"],
            fields["expectedRevision"]
        );
        assert_eq!(request["command"]["values"], fields["values"]);
    }
}
