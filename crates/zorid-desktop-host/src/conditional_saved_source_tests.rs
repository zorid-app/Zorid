//! Exercise the authenticated desktop wire against real enrolled Text storage.
//! Saved physical bytes are an observation, never a replacement core baseline.
use super::*;
use zorid_native::{
    ConditionalSavedSourceWitness, HostIntentState, HostIntentView, HostRejectionCode,
};
use zorid_store::FamilyCreateMode;

const CLIENT: &str = "20000000-0000-4000-8000-000000000001";
const OTHER: &str = "20000000-0000-4000-8000-000000000002";
const BEFORE: &str = "---\nscore: 9\nuntouched: keep\n---\nBody 😀\n";
const AFTER: &str = "---\nscore: 1\nuntouched: keep\n---\nBody 😀\n";
const EXTERNAL: &str = "---\r\nscore: 7\r\nuntouched: external\r\n---\r\nSaved 😀\r\n";

fn fixture(
    root: &Path,
) -> (
    NativeVault,
    ClientLeases,
    ClientLeaseRef,
    ConditionalSavedSourceWitness,
) {
    let mut vault = NativeVault::open(root).unwrap();
    assert!(initialize_desktop_vault(&mut vault).unwrap().complete);
    let id = EntryId::new("conditional-host-note").unwrap();
    let path = VaultPath::new("A.md").unwrap();
    let created = vault
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("create-conditional-host-note").unwrap(),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: path.clone(),
                    kind: EntryKind::File,
                    content: Some(BEFORE.as_bytes().to_vec()),
                },
            },
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
    assert!(matches!(created.projection, ProjectionStatus::Projected));
    let revision = vault.read(&id).unwrap().unwrap().state.revision;
    let mut leases = ClientLeases::default();
    let reference = claim(&vault, &mut leases, CLIENT);
    (
        vault,
        leases,
        reference,
        ConditionalSavedSourceWitness {
            entry_id: id,
            revision,
            path,
        },
    )
}

fn claim(vault: &NativeVault, leases: &mut ClientLeases, client: &str) -> ClientLeaseRef {
    let lease = vault
        .claim_client(&OperationId::new(client).unwrap())
        .unwrap();
    let reference = lease.reference().clone();
    leases
        .active
        .insert(reference.token.as_str().to_owned(), lease);
    reference
}

fn request(
    vault: &mut NativeVault,
    leases: &mut ClientLeases,
    lease: Option<&ClientLeaseRef>,
    command: Command,
    body: Vec<u8>,
) -> Result<(Value, Vec<u8>), Value> {
    leases.authorize(vault, &command, lease)?;
    execute(vault, leases, None, command, body)
}

fn capture_command(lease: &ClientLeaseRef, witness: &ConditionalSavedSourceWitness) -> Command {
    Command::CaptureSavedSource {
        client_id: lease.client_id.clone(),
        entry_id: witness.entry_id.clone(),
        revision: witness.revision.clone(),
        path: witness.path.clone(),
    }
}

fn capture(
    vault: &mut NativeVault,
    leases: &mut ClientLeases,
    lease: &ClientLeaseRef,
    witness: &ConditionalSavedSourceWitness,
) -> OperationId {
    let (reply, body) = request(
        vault,
        leases,
        Some(lease),
        capture_command(lease, witness),
        vec![],
    )
    .unwrap();
    assert_eq!(body, BEFORE.as_bytes());
    serde_json::from_value(reply["capture"]["capture_id"].clone()).unwrap()
}

fn prepare_command(
    lease: &ClientLeaseRef,
    witness: &ConditionalSavedSourceWitness,
    operation: &str,
    capture: Option<&OperationId>,
) -> Command {
    Command::PrepareIntent {
        client_id: lease.client_id.clone(),
        operation_id: OperationId::new(operation).unwrap(),
        mutation: WireMutation::Write {
            id: witness.entry_id.clone(),
            expected: witness.revision.clone(),
        },
        source_capture: capture.cloned(),
    }
}

fn intent(reply: Value, body: Vec<u8>) -> HostIntentView {
    assert!(body.is_empty());
    serde_json::from_value(reply["intent"].clone()).unwrap()
}

fn intent_reference(view: &HostIntentView) -> HostIntentRef {
    HostIntentRef {
        client_id: view.client_id.clone(),
        token: view.token.clone(),
    }
}

fn assert_core_and_file(
    vault: &NativeVault,
    root: &Path,
    witness: &ConditionalSavedSourceWitness,
    physical: &str,
) {
    let current = vault.read(&witness.entry_id).unwrap().unwrap();
    assert_eq!(current.content.as_deref(), Some(BEFORE.as_bytes()));
    assert_eq!(current.state.revision, witness.revision);
    assert_eq!(
        std::fs::read(root.join("A.md")).unwrap(),
        physical.as_bytes()
    );
}

#[test]
fn saved_source_wire_returns_exact_physical_utf8_body_with_separate_logical_witness() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (mut vault, mut leases, lease, witness) = fixture(&root);
    let cursor = vault.list_snapshot().unwrap().cursor;
    std::fs::write(root.join("A.md"), EXTERNAL.as_bytes()).unwrap();
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&lease),
        capture_command(&lease, &witness),
        vec![],
    )
    .unwrap();
    assert_eq!(
        body,
        EXTERNAL.as_bytes(),
        "UTF-8 and CRLF bytes travel unmodified in the body"
    );
    assert_eq!(reply.as_object().unwrap().len(), 1);
    assert_eq!(reply["capture"].as_object().unwrap().len(), 3);
    assert_eq!(reply["capture"]["logical_witness"], json!(witness));
    assert_eq!(reply["capture"]["byte_length"], EXTERNAL.len());
    let capture_id: OperationId =
        serde_json::from_value(reply["capture"]["capture_id"].clone()).unwrap();
    assert_core_and_file(&vault, &root, &witness, EXTERNAL);
    assert_eq!(
        vault.list_snapshot().unwrap().cursor,
        cursor,
        "capture must not import the physical branch"
    );
    for _ in 0..2 {
        let (released, body) = request(
            &mut vault,
            &mut leases,
            Some(&lease),
            Command::ReleaseSavedSource {
                client_id: lease.client_id.clone(),
                capture_id: capture_id.clone(),
            },
            vec![],
        )
        .unwrap();
        assert_eq!(released, json!({"released":true}));
        assert!(body.is_empty());
    }
}

#[test]
fn saved_source_wire_requires_current_lease_rejects_foreign_capture_and_cleans_up_release() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (mut vault, mut leases, lease, witness) = fixture(&root);
    let error = request(
        &mut vault,
        &mut leases,
        None,
        capture_command(&lease, &witness),
        vec![],
    )
    .unwrap_err();
    assert_eq!(error["code"], "client_not_admitted");
    let other = claim(&vault, &mut leases, OTHER);
    let error = request(
        &mut vault,
        &mut leases,
        Some(&other),
        capture_command(&lease, &witness),
        vec![],
    )
    .unwrap_err();
    assert_eq!(error["code"], "client_scope_mismatch");
    let capture_id = capture(&mut vault, &mut leases, &lease, &witness);
    let error = request(
        &mut vault,
        &mut leases,
        Some(&other),
        Command::ReleaseSavedSource {
            client_id: other.client_id.clone(),
            capture_id: capture_id.clone(),
        },
        vec![],
    )
    .unwrap_err();
    assert_eq!(error["code"], "source_capture_owner");
    let error = request(
        &mut vault,
        &mut leases,
        Some(&other),
        prepare_command(&other, &witness, "foreign-capture", Some(&capture_id)),
        AFTER.as_bytes().to_vec(),
    )
    .unwrap_err();
    assert_eq!(error["code"], "source_capture_owner");
    request(
        &mut vault,
        &mut leases,
        None,
        Command::ReleaseClient {
            reference: lease.clone(),
        },
        vec![],
    )
    .unwrap();
    let error = request(
        &mut vault,
        &mut leases,
        Some(&lease),
        capture_command(&lease, &witness),
        vec![],
    )
    .unwrap_err();
    assert_eq!(error["code"], "client_not_admitted");
    let renewed = claim(&vault, &mut leases, CLIENT);
    assert_ne!(renewed.token, lease.token);
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&renewed),
        prepare_command(&renewed, &witness, "released-capture", Some(&capture_id)),
        AFTER.as_bytes().to_vec(),
    )
    .unwrap();
    let rejected = intent(reply, body);
    assert_eq!(rejected.state, HostIntentState::Rejected);
    assert_eq!(
        rejected.error.unwrap().code,
        HostRejectionCode::SourceCaptureExpired
    );
    assert!(rejected.receipt.is_none());
    assert_core_and_file(&vault, &root, &witness, BEFORE);
}

#[test]
fn source_capture_wire_is_strictly_optional_and_omission_preserves_generic_prepare() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (mut vault, mut leases, lease, witness) = fixture(&root);
    let generic = json!({
        "method":"prepare_intent", "client_id":lease.client_id,
        "operation_id":"generic-without-capture",
        "mutation":{"type":"write","id":witness.entry_id,"expected":witness.revision}
    });
    // Build from the real wire DTO, rather than constructing a permissive test substitute.
    let command: Command = serde_json::from_value(generic.clone()).unwrap();
    assert!(matches!(
        &command,
        Command::PrepareIntent {
            source_capture: None,
            ..
        }
    ));
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&lease),
        command,
        AFTER.as_bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(intent(reply, body).state, HostIntentState::Prepared);
    for value in [Value::Null, json!(7), json!({"capture_id":"forged"})] {
        let mut malformed = generic.clone();
        malformed["source_capture"] = value;
        assert!(serde_json::from_value::<Command>(malformed).is_err());
    }
    let mut unknown = generic.clone();
    unknown["unknown_capture_field"] = json!(true);
    assert!(serde_json::from_value::<Command>(unknown).is_err());
    let mut unknown_mutation = generic;
    unknown_mutation["mutation"]["source_capture"] = json!("forged");
    assert!(serde_json::from_value::<Command>(unknown_mutation).is_err());
    let mut unknown_capture = json!({"method":"capture_saved_source","client_id":lease.client_id,"entry_id":witness.entry_id,"revision":witness.revision,"path":witness.path});
    unknown_capture["source"] = json!(BEFORE);
    assert!(serde_json::from_value::<Command>(unknown_capture).is_err());
    assert_core_and_file(&vault, &root, &witness, BEFORE);
}

#[test]
fn changed_source_prepare_has_durable_rejected_reference_query_and_acknowledgement() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (mut vault, mut leases, lease, witness) = fixture(&root);
    let cursor = vault.list_snapshot().unwrap().cursor;
    let capture_id = capture(&mut vault, &mut leases, &lease, &witness);
    std::fs::write(root.join("A.md"), EXTERNAL.as_bytes()).unwrap();
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&lease),
        prepare_command(&lease, &witness, "changed-source-undo", Some(&capture_id)),
        AFTER.as_bytes().to_vec(),
    )
    .unwrap();
    let rejected = intent(reply, body);
    assert_eq!(rejected.state, HostIntentState::Rejected);
    assert_eq!(
        rejected.error.as_ref().unwrap().code,
        HostRejectionCode::ConditionalSourceChanged
    );
    assert!(rejected.receipt.is_none());
    let reference = intent_reference(&rejected);
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&lease),
        prepare_command(&lease, &witness, "changed-source-undo", Some(&capture_id)),
        AFTER.as_bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(
        intent(reply, body),
        rejected,
        "lost prepare replies replay the original rejection"
    );
    for command in [
        Command::QueryIntent {
            reference: reference.clone(),
        },
        Command::CommitIntent {
            reference: reference.clone(),
        },
    ] {
        let (reply, body) =
            request(&mut vault, &mut leases, Some(&lease), command, vec![]).unwrap();
        assert_eq!(intent(reply, body), rejected);
    }
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&lease),
        Command::AcknowledgeIntent {
            reference: reference.clone(),
            expected: HostIntentAcknowledgment::Rejected {
                operation_id: rejected.operation_id.clone(),
                code: HostRejectionCode::ConditionalSourceChanged,
            },
        },
        vec![],
    )
    .unwrap();
    let acknowledged = intent(reply, body);
    assert!(acknowledged.acknowledged);
    assert_eq!(acknowledged.token, reference.token);
    assert_core_and_file(&vault, &root, &witness, EXTERNAL);
    assert_eq!(vault.list_snapshot().unwrap().cursor, cursor);
    drop(leases);
    drop(vault);
    let mut vault = NativeVault::open_existing(&root).unwrap();
    let mut leases = ClientLeases::default();
    let renewed = claim(&vault, &mut leases, CLIENT);
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&renewed),
        Command::QueryIntent { reference },
        vec![],
    )
    .unwrap();
    assert_eq!(
        intent(reply, body),
        acknowledged,
        "rejection and ACK survive native restart"
    );
    assert_core_and_file(&vault, &root, &witness, EXTERNAL);
}

#[test]
fn prepared_source_guard_survives_lease_release_and_native_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (mut vault, mut leases, lease, witness) = fixture(&root);
    let capture_id = capture(&mut vault, &mut leases, &lease, &witness);
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&lease),
        prepare_command(&lease, &witness, "durable-source-guard", Some(&capture_id)),
        AFTER.as_bytes().to_vec(),
    )
    .unwrap();
    let prepared = intent(reply, body);
    assert_eq!(prepared.state, HostIntentState::Prepared);
    let reference = intent_reference(&prepared);
    request(
        &mut vault,
        &mut leases,
        None,
        Command::ReleaseClient { reference: lease },
        vec![],
    )
    .unwrap();
    drop(leases);
    drop(vault);
    std::fs::write(root.join("A.md"), EXTERNAL.as_bytes()).unwrap();
    let mut vault = NativeVault::open_existing(&root).unwrap();
    let mut leases = ClientLeases::default();
    let renewed = claim(&vault, &mut leases, CLIENT);
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&renewed),
        prepare_command(
            &renewed,
            &witness,
            "durable-source-guard",
            Some(&capture_id),
        ),
        AFTER.as_bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(
        intent(reply, body),
        prepared,
        "durable preparation outlives the unattached capture"
    );
    let (reply, body) = request(
        &mut vault,
        &mut leases,
        Some(&renewed),
        Command::CommitIntent { reference },
        vec![],
    )
    .unwrap();
    let rejected = intent(reply, body);
    assert_eq!(rejected.state, HostIntentState::Rejected);
    assert_eq!(
        rejected.error.unwrap().code,
        HostRejectionCode::ConditionalSourceChanged
    );
    assert!(rejected.receipt.is_none());
    assert_core_and_file(&vault, &root, &witness, EXTERNAL);
}
