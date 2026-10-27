//! Bounded local collection command lane. JSON bodies keep note composition out
//! of the small control header; the native service owns all semantics and IO.
use super::{fault, native_fault};
use serde::Deserialize;
use serde_json::{json, Value};
use zorid_native::{
    DatabaseRequest, NativeVault, DATABASE_SCHEMA_VERSION, MAX_DATABASE_REQUEST_BYTES,
    MAX_DATABASE_RESPONSE_BYTES,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    schema_version: u32,
    bytes: usize,
}

fn domain_code(error: &zorid_native::Error) -> Option<&'static str> {
    let reason = match error {
        zorid_native::Error::Contract(zorid_core::ContractError::InvalidMutation { reason })
        | zorid_native::Error::Store(zorid_store::StoreError::Contract(
            zorid_core::ContractError::InvalidMutation { reason },
        )) => reason.as_str(),
        _ => return None,
    };
    Some(match reason {
        "A collection with this name already exists, including Trash" => "collection_name_taken",
        "Names must be nonempty single-line text of at most 256 bytes"
        | "Collection name must be a portable filename"
        | "Collection name is reserved on supported filesystems" => "collection_invalid_name",
        "Collection changed; reload before saving"
        | "Collection entry changed; reload before saving" => "collection_stale",
        "Collection does not exist" | "Entry is not a collection member" => "collection_not_found",
        "Collection is deleted"
        | "Entry is deleted"
        | "Cannot write a deleted collection entry" => "collection_deleted",
        "Property names must be unique and cannot use _id or _type" => {
            "collection_property_name_taken"
        }
        "Option labels must be unique within a property" => "collection_option_name_taken",
        "Too many collection properties"
        | "Too many property options"
        | "Local collection limit reached"
        | "Local collection entry limit reached"
        | "Local collection data exceeds its byte limit"
        | "Entry body exceeds byte limit" => "collection_limit",
        _ if reason.strip_prefix("Invalid value for property ").is_some() => {
            "collection_invalid_value"
        }
        _ if reason
            .strip_prefix("Confirm removal of values in ")
            .and_then(|value| value.strip_suffix(" affected collection entries"))
            .and_then(|value| value.parse::<u32>().ok())
            .is_some_and(|count| (1..=4096).contains(&count)) =>
        {
            "collection_destructive_confirmation"
        }
        _ => return None,
    })
}

pub(crate) fn execute(
    vault: &mut NativeVault,
    marker: Request,
    body: &[u8],
) -> Result<(Value, Vec<u8>), Value> {
    if marker.schema_version != DATABASE_SCHEMA_VERSION
        || marker.bytes != body.len()
        || body.len() > MAX_DATABASE_REQUEST_BYTES
    {
        return Err(fault("invalid_request"));
    }
    let request: DatabaseRequest =
        serde_json::from_slice(body).map_err(|_| fault("invalid_request"))?;
    let op = request
        .operation()
        .ok_or_else(|| fault("invalid_request"))?
        .to_owned();
    let may_commit = request.may_commit();
    let reply = vault.database_request(&request).map_err(|error| {
        let definite_source_conflict = op == "compose"
            && matches!(
                error,
                zorid_native::Error::Contract(_)
                    | zorid_native::Error::Store(zorid_store::StoreError::Contract(_))
                    | zorid_native::Error::Busy(_)
                    | zorid_native::Error::Unsupported(_)
            );
        if definite_source_conflict {
            fault("collection_source_conflict")
        } else if let Some(code) = domain_code(&error) {
            fault(code)
        } else {
            native_fault(error)
        }
    })?;
    let body = serde_json::to_vec(&json!({"schemaVersion":DATABASE_SCHEMA_VERSION,"op":op,"value":reply}))
        .map_err(|_| json!({"code":"response_codec","commit_uncertain":may_commit,"message":"Keep the identical local collection request"}))?;
    if body.len() > MAX_DATABASE_RESPONSE_BYTES {
        return Err(
            json!({"code":"response_limit","commit_uncertain":may_commit,"message":"Collection response exceeds its byte limit; keep the identical request"}),
        );
    }
    Ok((
        json!({"databases":true,"schemaVersion":DATABASE_SCHEMA_VERSION,"bytes":body.len()}),
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_marker_mismatch_cannot_commit_a_collection() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        let body = serde_json::to_vec(&json!({"schemaVersion":1,"command":{"op":"create","operationId":"create","name":"Work"}})).unwrap();
        let result = execute(
            &mut vault,
            Request {
                schema_version: 1,
                bytes: body.len() + 1,
            },
            &body,
        )
        .unwrap_err();
        assert_eq!(result["code"], "invalid_request");
        let listed = vault
            .database_request(&DatabaseRequest {
                schema_version: 1,
                command: json!({"op":"list"}),
            })
            .unwrap();
        assert!(listed.snapshot.collections.is_empty());
    }

    #[test]
    fn reply_marker_and_json_body_identify_exact_local_command() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        let body = serde_json::to_vec(&json!({"schemaVersion":1,"command":{"op":"create","operationId":"create","name":"Work"}})).unwrap();
        let (marker, bytes) = execute(
            &mut vault,
            Request {
                schema_version: 1,
                bytes: body.len(),
            },
            &body,
        )
        .unwrap();
        assert_eq!(
            marker,
            json!({"databases":true,"schemaVersion":1,"bytes":bytes.len()})
        );
        let report: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["op"], "create");
        assert_eq!(report["value"]["collections"][0]["name"], "Work");
        assert_eq!(report["value"]["projection"]["pending"], 0);
    }

    #[test]
    fn domain_errors_use_static_codes_without_native_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = NativeVault::open(dir.path()).unwrap();
        let body = serde_json::to_vec(&json!({"schemaVersion":1,"command":{"op":"create","operationId":"create","name":"bad/name"}})).unwrap();
        let error = execute(
            &mut vault,
            Request {
                schema_version: 1,
                bytes: body.len(),
            },
            &body,
        )
        .unwrap_err();
        assert_eq!(error["code"], "collection_invalid_name");
        assert_eq!(error["commit_uncertain"], false);
        assert!(!error.to_string().contains("bad/name"));
        let body = serde_json::to_vec(&json!({"schemaVersion":1,"command":{"op":"compose","entryId":"unknown","expectedRevision":"v1","baseline":"","proposed":""}})).unwrap();
        // An ordinary unknown note does not manufacture collection membership.
        let (_, report) = execute(
            &mut vault,
            Request {
                schema_version: 1,
                bytes: body.len(),
            },
            &body,
        )
        .unwrap();
        let report: Value = serde_json::from_slice(&report).unwrap();
        assert!(report["value"].get("composition").is_none());
    }
}
