use super::*;
use zorid_core::{EntryKind, Mutation, MutationRequest, VaultPath};
const CLIENT: &str = "10000000-0000-4000-8000-000000000001";
const OTHER: &str = "10000000-0000-4000-8000-000000000002";
fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    NativeVault,
    zorid_native::DocumentIndexStage,
) {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .enable_local_document_cache(cache.path().join("cache.sqlite"))
        .unwrap();
    for (name, path, text) in [
        (
            "base",
            "00.base",
            "views:\n  - type: table\n    name: All\n",
        ),
        ("note", "note.md", "hello"),
    ] {
        vault
            .apply(&MutationRequest {
                operation_id: op(&format!("create-{name}")),
                mutation: Mutation::Create {
                    id: id(name),
                    path: VaultPath::new(path).unwrap(),
                    kind: EntryKind::File,
                    content: Some(text.as_bytes().to_vec()),
                },
            })
            .unwrap();
    }
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    (root, cache, vault, stage)
}
fn call(
    vault: &mut NativeVault,
    sessions: &mut Sessions,
    client: &str,
    command: Value,
) -> Result<Value, Value> {
    let request = serde_json::from_value(json!({"schemaVersion":1,"command":command})).unwrap();
    let (_, body) = execute(vault, sessions, &op(client), &op("lease"), request)?;
    Ok(serde_json::from_slice::<Value>(&body).unwrap()["value"].clone())
}
fn capture(
    vault: &mut NativeVault,
    sessions: &mut Sessions,
    stage: &zorid_native::DocumentIndexStage,
) {
    assert!(
        call(
            vault,
            sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"1"})
        )
        .unwrap()
        .is_null()
    );
    assert!(vault.pump_document_index(stage).unwrap().ready);
    assert!(
        !call(
            vault,
            sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"2"})
        )
        .unwrap()
        .is_null()
    );
}
fn query_request(preview: &str) -> Request {
    serde_json::from_value(json!({"schemaVersion":1,"command":{"op":"preview_base","previewId":preview,"id":"base","options":{"clockMs":0}}})).unwrap()
}

#[test]
fn null_consumes_only_its_sequence_and_live_retry_returns_the_same_capture() {
    let (_root, _cache, mut vault, stage) = fixture();
    let mut sessions = Sessions::default();
    capture(&mut vault, &mut sessions, &stage);
    assert_eq!(sessions.clients[&op(CLIENT)].previews.len(), 1);
    assert_eq!(
        call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"1"})
        )
        .err()
        .unwrap()["code"],
        "index_preview_expired"
    );
    let first = call(
        &mut vault,
        &mut sessions,
        CLIENT,
        json!({"op":"preview_open","previewId":"2"}),
    )
    .unwrap();
    let retry = call(
        &mut vault,
        &mut sessions,
        CLIENT,
        json!({"op":"preview_open","previewId":"2"}),
    )
    .unwrap();
    assert_eq!(first, retry);
    assert_eq!(
        call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_close","previewId":"2"})
        )
        .unwrap(),
        json!({"closed":true})
    );
    assert_eq!(
        call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_close","previewId":"2"})
        )
        .unwrap(),
        json!({"closed":true})
    );
    assert_eq!(
        call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"2"})
        )
        .err()
        .unwrap()["code"],
        "index_preview_expired"
    );
}

#[test]
fn future_unknown_close_rejects_without_advancing_client_history() {
    let (_root, _cache, mut vault, stage) = fixture();
    let mut sessions = Sessions::default();
    capture(&mut vault, &mut sessions, &stage);
    assert_eq!(
        call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_close","previewId":"10"})
        )
        .err()
        .unwrap()["code"],
        "index_preview_expired"
    );
    assert_eq!(sessions.clients[&op(CLIENT)].last_preview_open, 2);
    // A rejected future close makes no history claim. Admission still owns
    // that sequence; only after actual open can close acknowledge it.
    assert!(
        !call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"10"})
        )
        .unwrap()
        .is_null()
    );
    for _ in 0..2 {
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                CLIENT,
                json!({"op":"preview_close","previewId":"10"})
            )
            .unwrap(),
            json!({"closed":true})
        );
    }
    for closed in ["9", "10"] {
        assert_eq!(
            call(
                &mut vault,
                &mut sessions,
                CLIENT,
                json!({"op":"preview_open","previewId":closed})
            )
            .err()
            .unwrap()["code"],
            "index_preview_expired"
        );
    }
    // Existing lower live IDs retain their original capture; the floor never
    // substitutes another capture or invalidates another authenticated client.
    assert!(
        !call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"2"})
        )
        .unwrap()
        .is_null()
    );
    assert!(
        !call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"11"})
        )
        .unwrap()
        .is_null()
    );
    assert!(
        !call(
            &mut vault,
            &mut sessions,
            OTHER,
            json!({"op":"preview_open","previewId":"10"})
        )
        .unwrap()
        .is_null()
    );
    assert_eq!(sessions.clients[&op(CLIENT)].last_preview_open, 11);
    assert_eq!(sessions.clients[&op(OTHER)].last_preview_open, 10);
}

#[test]
fn real_client_maps_scope_equal_numeric_ids_and_release_drops_only_that_client() {
    let (_root, _cache, mut vault, stage) = fixture();
    let mut sessions = Sessions::default();
    capture(&mut vault, &mut sessions, &stage);
    assert_eq!(
        preview_base_reply(&vault, &sessions, &op(OTHER), &mut query_request("2"))
            .err()
            .unwrap()["code"],
        "index_preview_expired"
    );
    call(
        &mut vault,
        &mut sessions,
        OTHER,
        json!({"op":"preview_open","previewId":"2"}),
    )
    .unwrap();
    let (_, reply) =
        preview_base_reply(&vault, &sessions, &op(OTHER), &mut query_request("2")).unwrap();
    sessions.release(&op(CLIENT));
    assert!(vault.check_document_preview_reply(&reply).is_ok());
    sessions.release(&op(OTHER));
    assert_eq!(
        vault
            .check_document_preview_reply(&reply)
            .err()
            .unwrap()
            .code(),
        "index_preview_expired"
    );
}

#[test]
fn four_combined_read_slots_are_pruned_after_publication_before_real_pin_admission() {
    let (_root, _cache, mut vault, stage) = fixture();
    let mut sessions = Sessions::default();
    capture(&mut vault, &mut sessions, &stage);
    for n in 3..=5 {
        call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":n.to_string()}),
        )
        .unwrap();
    }
    assert_eq!(
        call(
            &mut vault,
            &mut sessions,
            CLIENT,
            json!({"op":"preview_open","previewId":"6"})
        )
        .err()
        .unwrap()["code"],
        "pin_capacity"
    );
    vault.publish_document_index(&stage).unwrap();
    let opened = call(
        &mut vault,
        &mut sessions,
        CLIENT,
        json!({"op":"open","pinId":"2"}),
    )
    .unwrap();
    assert_eq!(opened["pinId"], "2");
    assert!(sessions.clients[&op(CLIENT)].previews.is_empty());
    assert_eq!(sessions.clients[&op(CLIENT)].pins.len(), 1);
}

#[test]
fn strict_preview_requests_have_no_body_and_cannot_escape_the_vec_dispatch_path() {
    for command in [
        json!({"op":"preview_open","previewId":"1","completion":{}}),
        json!({"op":"preview_base","previewId":"1","id":"base","snapshot":{}}),
        json!({"op":"preview_close","previewId":"1","source":{}}),
    ] {
        assert!(
            serde_json::from_value::<Request>(json!({"schemaVersion":1,"command":command}))
                .is_err()
        );
    }
    let (_root, _cache, mut vault, stage) = fixture();
    let mut sessions = Sessions::default();
    capture(&mut vault, &mut sessions, &stage);
    assert_eq!(
        execute(
            &mut vault,
            &mut sessions,
            &op(CLIENT),
            &op("lease"),
            query_request("2")
        )
        .err()
        .unwrap()["code"],
        "preview_requires_stdio"
    );
    let header = json!({"version":1,"request_id":"1","command":{"method":"documents","client_id":CLIENT,"request":{"schemaVersion":1,"command":{"op":"preview_base","previewId":"2","id":"base"}}}});
    let mut frame = Vec::new();
    crate::write_frame(&mut frame, &header, b"x").unwrap();
    assert!(crate::read_frame_head(&mut frame.as_slice()).is_err());
    let mut frame = Vec::new();
    crate::write_frame(&mut frame, &header, &[]).unwrap();
    assert!(
        crate::read_frame_head(&mut frame.as_slice())
            .unwrap()
            .unwrap()
            .body_len
            == 0
    );
    // Embedded startup enrolls a fresh local family; the legacy preview fixture
    // above already contains mutations and cannot be enrolled retroactively.
    let embedded_root = tempfile::tempdir().unwrap();
    let mut embedded = crate::EmbeddedHost::open_local(embedded_root.path()).unwrap();
    let refused = embedded.dispatch(&frame).unwrap();
    let n = u32::from_be_bytes(refused[..4].try_into().unwrap()) as usize;
    let head: Value = serde_json::from_slice(&refused[8..8 + n]).unwrap();
    assert_eq!(head["error"]["code"], "client_operation_unsupported");
    assert_eq!(u32::from_be_bytes(refused[4..8].try_into().unwrap()), 0);
}

fn leases(vault: &NativeVault) -> (crate::ClientLeases, zorid_native::ClientLeaseRef) {
    let lease = vault.claim_client(&op(CLIENT)).unwrap();
    let reference = lease.reference().clone();
    let mut leases = crate::ClientLeases::default();
    leases
        .active
        .insert(reference.token.as_str().to_owned(), lease);
    (leases, reference)
}
fn frame_request(reference: &zorid_native::ClientLeaseRef) -> crate::Request {
    serde_json::from_value(json!({"version":1,"request_id":"9","lease":reference,"command":{"method":"documents","client_id":CLIENT,"request":{"schemaVersion":1,"command":{"op":"preview_base","previewId":"2","id":"base","viewName":"All","options":{"clockMs":0}}}}})).unwrap()
}
#[test]
fn direct_stdio_reply_matches_envelope_and_rejects_revoked_lease_before_any_success_prefix() {
    let (_root, _cache, mut vault, stage) = fixture();
    let (mut leases, reference) = leases(&vault);
    capture(&mut vault, &mut leases.documents, &stage);
    let mut bytes = Vec::new();
    crate::preview_base_frame(&vault, &leases, frame_request(&reference), &mut bytes).unwrap();
    let header_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    let body_len = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    assert_eq!(bytes.len(), 8 + header_len + body_len);
    let head: Value = serde_json::from_slice(&bytes[8..8 + header_len]).unwrap();
    assert_eq!(head["ok"], true);
    assert_eq!(head["result"]["bytes"], body_len);
    let body: Value = serde_json::from_slice(&bytes[8 + header_len..]).unwrap();
    assert_eq!(body["op"], "preview_base");
    assert_eq!(body["value"]["previewId"], "2");
    assert_eq!(body["value"]["result"]["complete"], false);
    leases
        .revoking
        .insert(reference.token.as_str().to_owned(), ());
    let mut refused = Vec::new();
    crate::preview_base_frame(&vault, &leases, frame_request(&reference), &mut refused).unwrap();
    let n = u32::from_be_bytes(refused[..4].try_into().unwrap()) as usize;
    let head: Value = serde_json::from_slice(&refused[8..8 + n]).unwrap();
    assert_eq!(head["ok"], false);
    assert_eq!(u32::from_be_bytes(refused[4..8].try_into().unwrap()), 0);
}
#[test]
fn truncated_stdio_output_is_terminal_without_a_second_frame() {
    let (_root, _cache, mut vault, stage) = fixture();
    let (mut leases, reference) = leases(&vault);
    capture(&mut vault, &mut leases.documents, &stage);
    struct Broken(Vec<u8>);
    impl Write for Broken {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if self.0.len() >= 300 {
                return Err(io::Error::other("owned test truncation"));
            }
            let n = b.len().min(300 - self.0.len());
            self.0.extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut broken = Broken(Vec::new());
    assert!(
        crate::preview_base_frame(&vault, &leases, frame_request(&reference), &mut broken).is_err()
    );
    assert_eq!(broken.0.len(), 300);
    let n = u32::from_be_bytes(broken.0[..4].try_into().unwrap()) as usize;
    let head: Value = serde_json::from_slice(&broken.0[8..8 + n]).unwrap();
    assert_eq!(head["ok"], true);
    assert!(
        8 + n + u32::from_be_bytes(broken.0[4..8].try_into().unwrap()) as usize > broken.0.len()
    );
}

#[test]
fn only_actual_last_authenticated_client_release_retires_the_native_preview_owner() {
    let (_root, _cache, mut vault, stage) = fixture();
    let (mut leases, first) = leases(&vault);
    let other = vault.claim_client(&op(OTHER)).unwrap();
    let last = other.reference().clone();
    leases.active.insert(last.token.as_str().to_owned(), other);
    capture(&mut vault, &mut leases.documents, &stage);
    call(
        &mut vault,
        &mut leases.documents,
        OTHER,
        json!({"op":"preview_open","previewId":"2"}),
    )
    .unwrap();
    let (_, held) = preview_base_reply(
        &vault,
        &leases.documents,
        &op(OTHER),
        &mut query_request("2"),
    )
    .unwrap();
    crate::execute(
        &mut vault,
        &mut leases,
        None,
        crate::Command::ReleaseClient { reference: first },
        vec![],
    )
    .unwrap();
    assert_eq!(leases.active.len(), 1);
    assert!(vault.check_document_preview_reply(&held).is_ok());
    crate::execute(
        &mut vault,
        &mut leases,
        None,
        crate::Command::ReleaseClient {
            reference: last.clone(),
        },
        vec![],
    )
    .unwrap();
    assert!(leases.active.is_empty());
    assert_eq!(
        vault
            .check_document_preview_reply(&held)
            .err()
            .unwrap()
            .code(),
        "index_preview_expired"
    );
    // Exact release retry does not create a new owner or new capture request.
    crate::execute(
        &mut vault,
        &mut leases,
        None,
        crate::Command::ReleaseClient { reference: last },
        vec![],
    )
    .unwrap();
    assert!(leases.documents.clients.is_empty());
}
