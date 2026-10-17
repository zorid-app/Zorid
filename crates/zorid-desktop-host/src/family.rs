//! Trusted-main fixture commands. Credential selection is startup-only; this
//! transport owns no HTTP, cryptography, sync storage or reconciliation policy.
use super::*;
use zorid_file_sync::mutation::{CreateMode, FamilyCommand};
use zorid_native_sync::{FixtureSync, SyncLimits};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WireFamilyCommand {
    version: u32,
    request: WireFamilyRequest,
    // Option without this decoder would silently accept a missing field.
    #[serde(deserialize_with = "required_mode")]
    create_mode: Option<CreateMode>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireFamilyRequest {
    operation_id: OperationId,
    mutation: WireMutation,
}
fn required_mode<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<CreateMode>, D::Error> {
    Option::<CreateMode>::deserialize(decoder)
}
impl WireFamilyCommand {
    pub(super) fn decode(self, body: Vec<u8>) -> Result<FamilyCommand, Value> {
        let command = FamilyCommand {
            version: self.version,
            request: MutationRequest {
                operation_id: self.request.operation_id,
                mutation: wire_mutation(self.request.mutation, body)?,
            },
            create_mode: self.create_mode,
        };
        command.validate().map_err(|error| match error {
            zorid_file_sync::mutation::Error::Contract(error) => fault(core_code(&error)),
            _ => fault("invalid_family_command"),
        })?;
        Ok(command)
    }
}
pub(super) fn sync_fault(error: zorid_native_sync::Error, uncertain: bool) -> Value {
    // Error codes are sanitized by the shared runner. Never serialize its
    // credentials, transport errors, file paths or native projection reasons.
    json!({"code":error.code(),"commit_uncertain":uncertain,
        "message":"Fixture family sync did not complete; preserve local state and retry"})
}
pub(super) fn execute(
    vault: &mut NativeVault,
    sync: Option<&FixtureSync>,
    command: Command,
    body: Vec<u8>,
) -> Result<(Value, Vec<u8>), Value> {
    let sync = sync.ok_or_else(|| fault("fixture_sync_not_configured"))?;
    let result = match command {
        Command::FixtureFamilyEnroll => {
            empty(&body)?;
            json!({"family":sync.enroll(vault).map_err(|error| sync_fault(error, true))?})
        }
        Command::FixtureFamilyStatus => {
            empty(&body)?;
            json!({"sync":sync.status(vault).map_err(|error| sync_fault(error, false))?})
        }
        Command::FixtureFamilyOnce {
            max_push,
            max_pages,
        } => {
            empty(&body)?;
            if max_push > 1000 || max_pages > 100 {
                return Err(fault("request_limit"));
            }
            // Network I/O is wholly in the common native runner. NativeVault's
            // short locks end before each network wait. Partial progress remains
            // durable on failure/host timeout; never call it a rolled-back batch.
            json!({"sync":sync.once(vault, SyncLimits { max_push, max_pages })
                .map_err(|error| sync_fault(error, true))?})
        }
        Command::FixtureFamilyApply { family } => {
            let command = family.decode(body)?;
            // Validate the already-enrolled authority against this startup-only
            // configuration through the common runner before touching the vault.
            sync.check_binding(vault)
                .map_err(|error| sync_fault(error, false))?;
            let outcome = vault
                .family_apply(&command.request, command.create_mode)
                .map_err(native_fault)?;
            apply_reply(outcome)
        }
        _ => unreachable!("family dispatch is selected by the typed command"),
    };
    Ok((result, vec![]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_retains_explicit_mode_and_checks_common_contract() {
        let raw = json!({"version":1,"request":{"operation_id":"op","mutation":{
            "type":"create","id":"entry","path":"note.md","kind":"file"}},"create_mode":"binary"});
        let parsed: WireFamilyCommand = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(
            parsed.decode(vec![0, 255]).unwrap().create_mode,
            Some(CreateMode::Binary)
        );
        let mut missing = raw.clone();
        missing.as_object_mut().unwrap().remove("create_mode");
        assert!(serde_json::from_value::<WireFamilyCommand>(missing).is_err());
        let mut wrong = raw.clone();
        wrong["create_mode"] = Value::Null;
        assert!(serde_json::from_value::<WireFamilyCommand>(wrong)
            .unwrap()
            .decode(vec![])
            .is_err());
        let mut version = raw;
        version["version"] = json!(2);
        assert!(serde_json::from_value::<WireFamilyCommand>(version)
            .unwrap()
            .decode(vec![])
            .is_err());
        let write: WireFamilyCommand = serde_json::from_value(json!({"version":1,
            "request":{"operation_id":"write","mutation":{"type":"write","id":"entry","expected":"rev"}},
            "create_mode":null})).unwrap();
        assert_eq!(write.decode(vec![239, 187, 191]).unwrap().create_mode, None);
    }
}
