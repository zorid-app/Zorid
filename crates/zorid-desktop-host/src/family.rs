//! Trusted-main fixture commands. Credential selection is startup-only; this
//! transport owns no HTTP, cryptography, sync storage or reconciliation policy.
use super::*;
use zorid_file_sync::mutation::{CreateMode, DestinationParent, FamilyCommand};
use zorid_native_sync::{FixtureSync, SyncLimits};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WireFamilyCommand {
    version: u32,
    request: WireFamilyRequest,
    // Option without this decoder would silently accept a missing field.
    #[serde(deserialize_with = "required_mode")]
    create_mode: Option<CreateMode>,
    #[serde(default)]
    destination_parent: Option<DestinationParent>,
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
            destination_parent: self.destination_parent,
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
    let result = match command {
        Command::FixtureFamilyEnroll => {
            empty(&body)?;
            let sync = sync.ok_or_else(|| fault("fixture_sync_not_configured"))?;
            json!({"family":sync.enroll(vault).map_err(|error| sync_fault(error, true))?})
        }
        Command::FixtureFamilyStatus => {
            empty(&body)?;
            let sync = sync.ok_or_else(|| fault("fixture_sync_not_configured"))?;
            json!({"sync":sync.status(vault).map_err(|error| sync_fault(error, false))?})
        }
        Command::FixtureFamilyOnce {
            max_push,
            max_pages,
        } => {
            empty(&body)?;
            let sync = sync.ok_or_else(|| fault("fixture_sync_not_configured"))?;
            if max_push > 1000 || max_pages > 100 {
                return Err(fault("request_limit"));
            }
            // Network I/O is wholly in the common native runner. NativeVault's
            // short locks end before each network wait. Partial progress remains
            // durable on failure/host timeout; never call it a rolled-back batch.
            json!({"sync":sync.once(vault, SyncLimits { max_push, max_pages })
                .map_err(|error| sync_fault(error, true))?})
        }
        Command::CreateText {
            operation_id,
            id,
            path,
            ..
        } => {
            std::str::from_utf8(&body).map_err(|_| fault("invalid_text"))?;
            let command = FamilyCommand {
                version: 1,
                request: MutationRequest {
                    operation_id,
                    mutation: Mutation::Create {
                        id,
                        path,
                        kind: EntryKind::File,
                        content: Some(body),
                    },
                },
                create_mode: Some(CreateMode::Text),
                destination_parent: None,
            };
            command
                .validate()
                .map_err(|_| fault("invalid_family_command"))?;
            if let Some(sync) = sync {
                sync.check_binding(vault)
                    .map_err(|error| sync_fault(error, false))?;
            }
            apply_reply(
                vault
                    .family_apply_command(&command)
                    .map_err(native_fault)?,
            )
        }
        Command::FileCommandCompact { family, .. } => {
            empty(&body)?;
            let command = family.decode(body)?;
            if let Some(sync) = sync {
                sync.check_binding(vault)
                    .map_err(|error| sync_fault(error, false))?;
            }
            // Store preflights fresh root reports below MAX_HEADER - 16 KiB.
            // Never convert the recursive ApplyOutcome receipt into a wire value.
            json!(vault.family_apply_command_compact(&command).map_err(native_fault)?)
        }
        Command::FileCommandStatus { family, .. } => {
            empty(&body)?;
            let command = family.decode(body)?;
            if let Some(sync) = sync {
                sync.check_binding(vault)
                    .map_err(|error| sync_fault(error, false))?;
            }
            json!(vault.family_command_status(&command).map_err(|error| {
                let mut failure = native_fault(error);
                // This endpoint never commits or attempts physical projection.
                failure["commit_uncertain"] = json!(false);
                failure
            })?)
        }
        Command::FixtureFamilyApply { family } | Command::FileCommand { family, .. } => {
            let command = family.decode(body)?;
            // Validate the already-enrolled authority against this startup-only
            // configuration through the common runner before touching the vault.
            if let Some(sync) = sync {
                sync.check_binding(vault)
                    .map_err(|error| sync_fault(error, false))?;
            }
            let outcome = vault
                .family_apply_command(&command)
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

#[cfg(test)]
mod compact_wire_tests {
    use super::*;
    use zorid_core::EntryState;

    const CLIENT: &str = "10000000-0000-4000-8000-000000000001";
    const OTHER: &str = "10000000-0000-4000-8000-000000000002";

    fn send(host: &mut EmbeddedHost, command: Value, lease: Option<&Value>, body: &[u8]) -> Value {
        let mut frame = Vec::new();
        write_frame(&mut frame, &json!({"version":1,"request_id":"1","command":command,"lease":lease}), body).unwrap();
        let response = host.dispatch(&frame).unwrap();
        let header_len = u32::from_be_bytes(response[..4].try_into().unwrap()) as usize;
        let body_len = u32::from_be_bytes(response[4..8].try_into().unwrap()) as usize;
        assert!((1..=MAX_HEADER).contains(&header_len));
        assert_eq!(body_len, 0);
        assert_eq!(response.len(), 8 + header_len);
        serde_json::from_slice(&response[8..]).unwrap()
    }
    fn claim(host: &mut EmbeddedHost) -> Value {
        let result = send(host, json!({"method":"claim_client","client_id":CLIENT}), None, &[]);
        assert_eq!(result["ok"], true, "{result}");
        result["result"]["lease"].clone()
    }
    fn invoke(host: &mut EmbeddedHost, method: &str, family: &Value, lease: Option<&Value>, body: &[u8]) -> Value {
        send(host, json!({"method":method,"client_id":CLIENT,"family":family}), lease, body)
    }
    fn state(host: &EmbeddedHost, id: &str) -> EntryState {
        host.vault.list().unwrap().into_iter().find(|entry| entry.id.as_str() == id).unwrap()
    }
    fn create_folder(host: &mut EmbeddedHost, id: &str, path: &str) -> EntryState {
        host.vault.family_apply(&MutationRequest {
            operation_id: OperationId::new(format!("create_{id}")).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(id).unwrap(), path: VaultPath::new(path).unwrap(),
                kind: EntryKind::Folder, content: None,
            },
        }, None).unwrap();
        state(host, id)
    }
    fn move_family(operation: &str, source: &EntryState, path: &str, parent: Value) -> Value {
        json!({"version":1,"request":{"operation_id":operation,"mutation":{
            "type":"move","id":source.id,"expected":source.revision,"path":path}},
            "create_mode":null,"destination_parent":parent})
    }
    fn parent(folder: &EntryState) -> Value {
        json!({"kind":"folder","id":folder.id,"revision":folder.revision,"path":folder.path})
    }
    fn native_move(host: &mut EmbeddedHost, operation: &str, source: &EntryState, path: &str) {
        host.vault.family_apply(&MutationRequest {
            operation_id: OperationId::new(operation).unwrap(),
            mutation: Mutation::Move {
                id: source.id.clone(), expected: source.revision.clone(), path: VaultPath::new(path).unwrap(),
            },
        }, None).unwrap();
    }

    #[test]
    fn compact_and_status_bind_leases_and_require_empty_bodies() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        let source = create_folder(&mut host, "source", "Source");
        let family = move_family("lease_move", &source, "Target", json!({"kind":"root"}));
        let lease = claim(&mut host);
        for method in ["file_command_compact", "file_command_status"] {
            let denied = invoke(&mut host, method, &family, None, &[]);
            assert_eq!(denied["error"]["code"], "client_not_admitted");
            let wrong_client = send(&mut host, json!({"method":method,"client_id":OTHER,"family":family}), Some(&lease), &[]);
            assert_eq!(wrong_client["error"]["code"], "client_scope_mismatch");
            let mut wrong_store = lease.clone();
            wrong_store["local_store_id"] = json!("foreign_store");
            let denied = invoke(&mut host, method, &family, Some(&wrong_store), &[]);
            assert_eq!(denied["error"]["code"], "client_not_admitted");
            let mut wrong_token = lease.clone();
            wrong_token["token"] = json!("unknown_token");
            let denied = invoke(&mut host, method, &family, Some(&wrong_token), &[]);
            assert_eq!(denied["error"]["code"], "client_not_admitted");
            let body = invoke(&mut host, method, &family, Some(&lease), b"unexpected");
            assert_eq!(body["error"]["code"], "unexpected_body");
        }
        assert_eq!(state(&host, "source"), source);
        let status = invoke(&mut host, "file_command_status", &family, Some(&lease), &[]);
        assert_eq!(status["result"]["status"], "not_committed");
    }

    #[test]
    fn status_and_compact_replay_original_root_after_selected_parent_moves() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        let selected = create_folder(&mut host, "parent", "Parent");
        let source = create_folder(&mut host, "source", "Source");
        let lease = claim(&mut host);
        let family = move_family("original_move", &source, "Parent/Source", parent(&selected));
        let before = host.vault.family_status().unwrap();
        let absent = invoke(&mut host, "file_command_status", &family, Some(&lease), &[]);
        assert_eq!(absent["result"]["status"], "not_committed");
        assert_eq!(absent["result"]["operation_id"], "original_move");
        assert_eq!(serde_json::to_value(host.vault.family_status().unwrap()).unwrap(), serde_json::to_value(before).unwrap());
        let applied = invoke(&mut host, "file_command_compact", &family, Some(&lease), &[]);
        assert_eq!(applied["ok"], true, "{applied}");
        let original = applied["result"].clone();
        assert_eq!(original["status"], "committed");
        assert_eq!(original["local_store_id"], lease["local_store_id"]);
        assert_eq!(original["kind"], "move");
        assert_eq!(original["source"], json!(source));
        assert_eq!(original["target"]["id"], "source");
        assert_eq!(original["target"]["path"], "Parent/Source");
        assert!(original.get("changes").is_none());
        let current_parent = state(&host, "parent");
        native_move(&mut host, "later_parent_move", &current_parent, "Later");
        assert_eq!(state(&host, "source").path.as_str(), "Later/Source");
        for method in ["file_command_status", "file_command_compact"] {
            let retried = invoke(&mut host, method, &family, Some(&lease), &[]);
            assert_eq!(retried["ok"], true, "{retried}");
            for field in ["local_store_id", "operation_id", "kind", "sequence", "source", "target", "change_count"] {
                assert_eq!(retried["result"][field], original[field], "{field}");
            }
            assert!(["settled", "pending"].contains(&retried["result"]["projection"].as_str().unwrap()));
        }
        let mut changed_parent = family;
        changed_parent["destination_parent"]["revision"] = json!("different_revision");
        let conflict = invoke(&mut host, "file_command_status", &changed_parent, Some(&lease), &[]);
        assert_eq!(conflict["error"]["code"], "idempotency_conflict");
        assert_eq!(conflict["error"]["commit_uncertain"], false);
        assert_eq!(state(&host, "source").path.as_str(), "Later/Source");
    }

    #[test]
    fn full_and_compact_wire_do_not_rebind_a_replaced_destination_folder() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        let selected = create_folder(&mut host, "selected", "Parent");
        let source = create_folder(&mut host, "source", "Source");
        let lease = claim(&mut host);
        host.vault.family_apply(&MutationRequest {
            operation_id: OperationId::new("delete_selected").unwrap(),
            mutation: Mutation::Delete { id: selected.id.clone(), expected: selected.revision.clone(), recursive: false },
        }, None).unwrap();
        let replacement = create_folder(&mut host, "replacement", "Parent");
        for (method, operation) in [("file_command", "full_stale"), ("file_command_compact", "compact_stale")] {
            let family = move_family(operation, &source, "Parent/Source", parent(&selected));
            let rejected = invoke(&mut host, method, &family, Some(&lease), &[]);
            assert_eq!(rejected["error"]["code"], "not_found", "{rejected}");
            assert_eq!(rejected["error"]["commit_uncertain"], false);
            let status = invoke(&mut host, "file_command_status", &family, Some(&lease), &[]);
            assert_eq!(status["result"]["status"], "not_committed");
        }
        assert_eq!(state(&host, "source"), source);
        assert_eq!(state(&host, "replacement"), replacement);
        let mut unguarded = move_family("unguarded", &source, "Target", json!({"kind":"root"}));
        unguarded.as_object_mut().unwrap().remove("destination_parent");
        let rejected = invoke(&mut host, "file_command_compact", &unguarded, Some(&lease), &[]);
        assert_eq!(rejected["error"]["code"], "invalid_request");
    }

    #[test]
    fn retained_unguarded_move_and_fresh_delete_use_original_compact_reports() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        let source = create_folder(&mut host, "source", "Source");
        let lease = claim(&mut host);
        let mut legacy = move_family("legacy_move", &source, "Target", json!({"kind":"root"}));
        legacy.as_object_mut().unwrap().remove("destination_parent");
        let full = invoke(&mut host, "file_command", &legacy, Some(&lease), &[]);
        assert_eq!(full["ok"], true, "{full}");
        assert!(full["result"]["commit"]["changes"].is_array());
        for method in ["file_command_status", "file_command_compact"] {
            let original = invoke(&mut host, method, &legacy, Some(&lease), &[]);
            assert_eq!(original["ok"], true, "{original}");
            assert_eq!(original["result"]["sequence"], full["result"]["commit"]["sequence"]);
            assert_eq!(original["result"]["source"], json!(source));
            assert_eq!(original["result"]["target"]["path"], "Target");
        }
        let target = state(&host, "source");
        let deletion = json!({"version":1,"request":{"operation_id":"compact_delete","mutation":{
            "type":"delete","id":target.id,"expected":target.revision,"recursive":false}},"create_mode":null});
        let deleted = invoke(&mut host, "file_command_compact", &deletion, Some(&lease), &[]);
        assert_eq!(deleted["ok"], true, "{deleted}");
        assert_eq!(deleted["result"]["kind"], "delete");
        assert_eq!(deleted["result"]["source"], json!(target));
        assert_eq!(deleted["result"]["target"]["deleted"], true);
        assert_eq!(deleted["result"]["target"]["path"], "Target");
        drop(host);
        let mut reopened = EmbeddedHost::open_local(root.path()).unwrap();
        let lease = claim(&mut reopened);
        let restored = invoke(&mut reopened, "file_command_status", &deletion, Some(&lease), &[]);
        assert_eq!(restored["ok"], true, "{restored}");
        assert_eq!(restored["result"]["sequence"], deleted["result"]["sequence"]);
        assert_eq!(restored["result"]["source"], deleted["result"]["source"]);
        assert_eq!(restored["result"]["target"], deleted["result"]["target"]);
    }

    #[test]
    fn oversized_recursive_full_reply_recovers_through_original_status_and_compact_retry() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        create_folder(&mut host, "source", "Source");
        // Seed authority through public Store commands on one setup connection,
        // without attempting physical recovery after each logical create. There
        // are no concurrent host calls; close setup before the leased endpoints.
        // Valid bounded names form enough original before/after paths to exceed
        // 1 MiB without thousands of files. Projection state comes from the
        // original durable job, not an assumed outcome for these deep paths.
        let mut setup = zorid_store::Store::open(root.path().join(".zorid/vault.sqlite")).unwrap();
        let suffix = "x".repeat(230);
        let mut path = String::from("Source");
        for index in 0..70 {
            path.push_str(&format!("/{index}_{suffix}"));
            setup.family_apply(&MutationRequest {
                operation_id: OperationId::new(format!("create_child_{index}")).unwrap(),
                mutation: Mutation::Create {
                    id: EntryId::new(format!("child_{index}")).unwrap(), path: VaultPath::new(&path).unwrap(),
                    kind: EntryKind::Folder, content: None,
                },
            }, None).unwrap();
        }
        drop(setup);
        let source = state(&host, "source");
        let lease = claim(&mut host);
        let family = move_family("large_move", &source, "Target", json!({"kind":"root"}));
        let full = invoke(&mut host, "file_command", &family, Some(&lease), &[]);
        assert_eq!(full["error"]["code"], "response_limit", "{full}");
        assert_eq!(full["error"]["commit_uncertain"], true);
        assert_eq!(state(&host, "source").path.as_str(), "Target");
        let status = invoke(&mut host, "file_command_status", &family, Some(&lease), &[]);
        assert_eq!(status["ok"], true, "{status}");
        assert_eq!(status["result"]["source"], json!(source));
        assert_eq!(status["result"]["target"]["path"], "Target");
        assert_eq!(status["result"]["change_count"], "71");
        assert!(["settled", "pending"].contains(&status["result"]["projection"].as_str().unwrap()));
        assert!(serde_json::to_vec(&status).unwrap().len() < 2048);
        assert!(status["result"].get("commit").is_none());
        assert!(status["result"].get("changes").is_none());
        let retried = invoke(&mut host, "file_command_compact", &family, Some(&lease), &[]);
        assert_eq!(retried["ok"], true, "{retried}");
        assert_eq!(retried["result"]["sequence"], status["result"]["sequence"]);
        assert_eq!(retried["result"]["target"], status["result"]["target"]);
    }

    #[test]
    fn compact_status_input_is_strict_and_commit_classification_is_shared() {
        let source = EntryState { id: EntryId::new("source").unwrap(), path: VaultPath::new("Source").unwrap(),
            kind: EntryKind::Folder, revision: Revision::new("revision").unwrap(), deleted: false };
        let family = move_family("strict", &source, "Target", json!({"kind":"root"}));
        for (method, mutating) in [("file_command_compact", true), ("file_command_status", false)] {
            let command: Command = serde_json::from_value(json!({"method":method,"client_id":CLIENT,"family":family})).unwrap();
            assert_eq!(command_may_commit(&command), mutating);
            let mut unknown = family.clone();
            unknown["unexpected"] = json!(true);
            assert!(serde_json::from_value::<Command>(json!({"method":method,"client_id":CLIENT,"family":unknown})).is_err());
            let mut unknown_parent = family.clone();
            unknown_parent["destination_parent"]["unexpected"] = json!(true);
            assert!(serde_json::from_value::<Command>(json!({"method":method,"client_id":CLIENT,"family":unknown_parent})).is_err());
        }
        let duplicate = r#"{"version":1,"request":{"operation_id":"strict","mutation":{"type":"move","id":"source","expected":"revision","path":"Target"}},"create_mode":null,"destination_parent":{"kind":"root"},"destination_parent":{"kind":"root"}}"#;
        assert!(serde_json::from_str::<WireFamilyCommand>(duplicate).is_err());
        assert!(MAX_HEADER - 16 * 1024 >= zorid_store::MAX_FAMILY_COMMAND_STATUS_BYTES);
        for (method, mutating) in [("file_command_compact", true), ("file_command_status", false)] {
            let command: Command = serde_json::from_value(json!({"method":method,"client_id":CLIENT,"family":family})).unwrap();
            let mut response = Vec::new();
            reply(&mut response, "1", Ok((json!({"too_large":"x".repeat(MAX_HEADER)}), vec![])), command_may_commit(&command)).unwrap();
            let header: Value = serde_json::from_slice(&response[8..]).unwrap();
            assert_eq!(header["error"]["code"], "response_limit");
            assert_eq!(header["error"]["commit_uncertain"], mutating);
        }
    }
}
