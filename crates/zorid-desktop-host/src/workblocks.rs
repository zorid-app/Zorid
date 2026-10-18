//! Semantic admitted host endpoint. No registration, realm or handle from the caller.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use zorid_core::OperationId;
use zorid_native::{ClientLease, NativeVault, WorkBlockCommand, WorkBlockSession};
const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    schema_version: u32,
    command: WorkBlockCommand,
}
impl Request {
    pub(crate) fn may_commit(&self) -> bool {
        self.command.may_commit()
    }
}
#[derive(Default)]
pub(crate) struct Sessions {
    clients: BTreeMap<OperationId, WorkBlockSession>,
}
impl Sessions {
    pub(crate) fn release(&mut self, client: &OperationId) {
        self.clients.remove(client);
    }
}
fn failure(code: &str, uncertain: bool) -> Value {
    json!({"code":code,"commit_uncertain":uncertain,"message":"WorkBlock request failed; retain the original operation and revision for retry"})
}
pub(crate) fn execute(
    vault: &mut NativeVault,
    sessions: &mut Sessions,
    lease: &ClientLease,
    request: Request,
) -> Result<(Value, Vec<u8>), Value> {
    if request.schema_version != 1 {
        return Err(failure("unsupported_protocol", false));
    }
    if serde_json::to_vec(&request)
        .map_err(|_| failure("invalid_request", false))?
        .len()
        > MAX_REQUEST
    {
        return Err(failure("request_limit", false));
    }
    let op = request.command.op();
    let may_commit = request.command.may_commit();
    let client = &lease.reference().client_id;
    if !sessions.clients.contains_key(client) {
        let session = vault
            .open_workblocks(lease)
            .map_err(|e| failure(e.code(), false))?;
        sessions.clients.insert(client.clone(), session);
    }
    let result = vault
        .execute_workblocks(
            lease,
            sessions.clients.get_mut(client).expect("live session"),
            request.command,
        )
        .map_err(|e| failure(e.code(), may_commit && e.commit_uncertain()))?;
    let bytes = serde_json::to_vec(&json!({"schemaVersion":1,"op":op,"value":result}))
        .map_err(|_| failure("response_limit", may_commit))?;
    if bytes.len() > MAX_RESPONSE {
        return Err(failure("response_limit", may_commit));
    }
    Ok((
        json!({"workblocks":true,"schemaVersion":1,"bytes":bytes.len()}),
        bytes,
    ))
}
