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
        let message = error.to_string();
        let definite_source_conflict = op == "compose"
            && matches!(
                error,
                zorid_native::Error::Contract(_)
                    | zorid_native::Error::Store(zorid_store::StoreError::Contract(_))
                    | zorid_native::Error::Busy(_)
                    | zorid_native::Error::Unsupported(_)
            );
        let mut result = if definite_source_conflict {
            fault("collection_source_conflict")
        } else {
            native_fault(error)
        };
        result["message"] = json!(message.chars().take(4096).collect::<String>());
        result
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
