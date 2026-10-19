use super::*;
use sha2::{Digest, Sha256};
const CLIENT: &str = "10000000-0000-4000-8000-000000000001";
const OTHER: &str = "10000000-0000-4000-8000-000000000002";
fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    NativeVault,
    ClientLeases,
) {
    let root = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .enable_local_document_cache(local.path().join("cache.sqlite"))
        .unwrap();
    (root, local, vault, ClientLeases::default())
}
fn claim(v: &mut NativeVault, l: &mut ClientLeases, client: &str) -> ClientLeaseRef {
    let (r, b) = super::super::execute(
        v,
        l,
        None,
        Command::ClaimClient {
            client_id: op(client),
        },
        vec![],
    )
    .unwrap();
    assert!(b.is_empty());
    serde_json::from_value(r["lease"].clone()).unwrap()
}
fn decode(frame: &[u8]) -> (Value, Vec<u8>) {
    assert!(frame.len() >= 8);
    let h = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    let b = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
    assert_eq!(frame.len(), 8 + h + b);
    assert!(h <= MAX_CONTROL);
    assert!(b <= MAX_CHUNK);
    (
        serde_json::from_slice(&frame[8..8 + h]).unwrap(),
        frame[8 + h..].to_vec(),
    )
}
fn frame(command: Value, lease: Option<&ClientLeaseRef>, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![];
    write_frame(
        &mut bytes,
        &json!({"version":1,"request_id":"1","command":command,"lease":lease}),
        body,
    )
    .unwrap();
    bytes
}
fn call(
    v: &mut NativeVault,
    l: &mut ClientLeases,
    command: Value,
    lease: Option<&ClientLeaseRef>,
    body: &[u8],
) -> (Value, Vec<u8>) {
    let bytes = frame(command, lease, body);
    let mut input = bytes.as_slice();
    let h = read_frame_head(&mut input).unwrap().unwrap();
    let mut output = vec![];
    execute_frame(v, l, h.request, h.body_len, &mut input, &mut output).unwrap();
    assert!(input.is_empty());
    decode(&output)
}
fn public(
    v: &mut NativeVault,
    l: &mut ClientLeases,
    lease: &ClientLeaseRef,
    request: Value,
    body: &[u8],
) -> (Value, Vec<u8>) {
    call(
        v,
        l,
        json!({"method":"document_drafts","client_id":lease.client_id,"request":request}),
        Some(lease),
        body,
    )
}
fn trusted(v: &mut NativeVault, l: &mut ClientLeases, request: Value) -> Value {
    let (r, b) = call(
        v,
        l,
        json!({"method":"document_work","request":request}),
        None,
        &[],
    );
    assert!(b.is_empty());
    assert_eq!(r["ok"], true, "{r}");
    r["result"].clone()
}
fn reserve(
    v: &mut NativeVault,
    l: &mut ClientLeases,
    lease: &ClientLeaseRef,
    buffer: &str,
    revision: u64,
    source: &str,
) -> Value {
    let source_hash = format!("{:x}", Sha256::digest(source.as_bytes()));
    let (r, b) = public(
        v,
        l,
        lease,
        json!({"op":"request","buffer_lifetime":buffer,"text_revision":revision.to_string(),"source":{"bytes":source.len(),"utf16":source.encode_utf16().count(),"sha256":source_hash}}),
        &[],
    );
    assert!(b.is_empty());
    assert_eq!(r["ok"], true, "{r}");
    r["result"]["state"]["admitted"].clone()
}
fn upload(
    v: &mut NativeVault,
    l: &mut ClientLeases,
    lease: &ClientLeaseRef,
    job: &Value,
    source: &str,
) {
    for request in [
        json!({"op":"upload_begin","job":job}),
        json!({"op":"upload_chunk","job":job,"offset":"0"}),
        json!({"op":"upload_seal","job":job}),
    ] {
        let body = if request["op"] == "upload_chunk" {
            source.as_bytes()
        } else {
            &[]
        };
        let (r, b) = public(v, l, lease, request, body);
        assert!(b.is_empty());
        assert_eq!(r["ok"], true, "{r}");
    }
}
fn drive(v: &mut NativeVault, l: &mut ClientLeases) {
    for _ in 0..100 {
        let turn = trusted(v, l, json!({"op":"next_turn"}));
        if turn["work"]["selected"].is_null() {
            return;
        }
        trusted(v, l, json!({"op":"step","ticket":turn["work"]["selected"]}));
    }
    panic!("bounded fixture did not stop");
}
#[test]
fn strict_controls_reject_complete_descriptors_unknown_fields_and_lossy_counters() {
    for request in [
        json!({"op":"complete","completion":{}}),
        json!({"op":"snapshot","phase":"tags"}),
        json!({"op":"upload_chunk","job":{"lifetime":"life","id":"1","buffer_lifetime":"b","text_revision":"0"},"offset":"01"}),
        json!({"op":"upload_chunk","job":{"lifetime":"life","id":1,"buffer_lifetime":"b","text_revision":"0"},"offset":"0"}),
        json!({"op":"upload_chunk","job":{"lifetime":"life","id":"18446744073709551616","buffer_lifetime":"b","text_revision":"0"},"offset":"0"}),
    ] {
        assert!(serde_json::from_value::<Request>(request).is_err());
    }
    assert!(serde_json::from_str::<Request>(r#"{"op":"snapshot","op":"snapshot"}"#).is_err());
    let large=serde_json::from_value::<Job>(json!({"lifetime":"life","id":"18446744073709551615","buffer_lifetime":"b","text_revision":"9007199254740993"})).unwrap();
    assert_eq!(large.id.0, u64::MAX);
    assert_eq!(large.text_revision.0, 9_007_199_254_740_993);
    let mut zero = large;
    zero.id = Counter(0);
    assert!(zero.resolve(&op(CLIENT)).is_err());
}
#[test]
fn frame_limits_reject_before_raw_body_read_and_header_stays_separate() {
    let job = json!({"lifetime":"life","id":"1","buffer_lifetime":"buffer","text_revision":"0"});
    for (request, length) in [
        (
            json!({"op":"upload_chunk","job":job,"offset":"0"}),
            MAX_CHUNK + 1,
        ),
        (json!({"op":"snapshot"}), 1),
    ] {
        let header=serde_json::to_vec(&json!({"version":1,"request_id":"1","command":{"method":"document_drafts","client_id":CLIENT,"request":request}})).unwrap();
        let mut bytes = vec![];
        bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&(length as u32).to_be_bytes());
        bytes.extend_from_slice(&header);
        // No raw body exists: InvalidData proves size admission precedes read.
        assert!(
            matches!(read_frame_head(&mut bytes.as_slice()),Err(e) if e.kind()==io::ErrorKind::InvalidData)
        );
    }
    let header=serde_json::to_vec(&json!({"version":1,"request_id":"1","command":{"method":"document_drafts","client_id":CLIENT,"request":{"op":"snapshot"}}})).unwrap();
    let mut bytes = vec![];
    bytes.extend_from_slice(&((MAX_CONTROL + 1) as u32).to_be_bytes());
    bytes.extend_from_slice(&0u32.to_be_bytes());
    bytes.extend_from_slice(&header);
    bytes.resize(8 + MAX_CONTROL + 1, b' ');
    assert!(
        matches!(read_frame_head(&mut bytes.as_slice()),Err(e) if e.kind()==io::ErrorKind::InvalidData)
    );
}
#[test]
fn raw_ingress_requires_actual_lease_and_work_is_not_a_renderer_command() {
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    let (r, _) = call(
        &mut v,
        &mut l,
        json!({"method":"document_drafts","client_id":CLIENT,"request":{"op":"snapshot"}}),
        None,
        &[],
    );
    assert_eq!(r["error"]["code"], "client_not_admitted");
    assert!(v.document_draft_snapshot().is_none());
    let (r, _) = call(
        &mut v,
        &mut l,
        json!({"method":"document_work","request":{"op":"next_turn"}}),
        Some(&lease),
        &[],
    );
    assert_eq!(r["error"]["code"], "client_operation_unsupported");
    assert!(v.document_draft_snapshot().is_none());
    let job = reserve(&mut v, &mut l, &lease, "buffer", 0, "x");
    let other = claim(&mut v, &mut l, OTHER);
    let (r, _) = public(
        &mut v,
        &mut l,
        &other,
        json!({"op":"upload_begin","job":job}),
        &[],
    );
    assert_eq!(r["ok"], false);
    assert_eq!(
        v.document_draft_snapshot().unwrap().transfer_scratch_bytes,
        0
    );
}
#[test]
fn unicode_upload_replays_exact_chunks_and_preserves_authoritative_note() {
    let (root, _c, mut v, mut l) = fixture();
    v.apply(&MutationRequest {
        operation_id: op("saved"),
        mutation: Mutation::Create {
            id: zorid_core::EntryId::new("note").unwrap(),
            path: zorid_core::VaultPath::new("Note.md").unwrap(),
            kind: EntryKind::File,
            content: Some(b"saved authority".to_vec()),
        },
    })
    .unwrap();
    let before = v.list().unwrap();
    let bytes = std::fs::read(root.path().join("Note.md")).unwrap();
    let lease = claim(&mut v, &mut l, CLIENT);
    let source = "# Draft 😀\r\n#tag";
    let j = reserve(&mut v, &mut l, &lease, "buffer", 0, source);
    assert_eq!(
        public(
            &mut v,
            &mut l,
            &lease,
            json!({"op":"upload_begin","job":j}),
            &[]
        )
        .0["ok"],
        true
    );
    let cut = 11; // intentionally inside the emoji's UTF-8 encoding
    for (offset, part) in [
        (0, &source.as_bytes()[..cut]),
        (0, &source.as_bytes()[..cut]),
        (cut, &source.as_bytes()[cut..]),
    ] {
        let (r, _) = public(
            &mut v,
            &mut l,
            &lease,
            json!({"op":"upload_chunk","job":j,"offset":offset.to_string()}),
            part,
        );
        assert_eq!(r["ok"], true, "{r}");
    }
    let (r, _) = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"upload_chunk","job":j,"offset":"0"}),
        b"different",
    );
    assert_eq!(r["error"]["code"], "draft_invalid_offset");
    assert_eq!(
        public(
            &mut v,
            &mut l,
            &lease,
            json!({"op":"upload_seal","job":j}),
            &[]
        )
        .0["ok"],
        true
    );
    drive(&mut v, &mut l);
    assert_eq!(v.list().unwrap(), before);
    assert_eq!(std::fs::read(root.path().join("Note.md")).unwrap(), bytes);
    let (r, _) = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"facts_prepare","job":j}),
        &[],
    );
    assert_eq!(r["ok"], true, "{r}");
    assert!(r["result"]["transfer"]["facts_bytes"].as_u64().unwrap() > 0);
}
#[test]
fn facts_reads_reuse_one_encoding_and_ack_revokes_before_drop() {
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    let j = reserve(&mut v, &mut l, &lease, "buffer", 1, "# Heading\n#tag");
    upload(&mut v, &mut l, &lease, &j, "# Heading\n#tag");
    drive(&mut v, &mut l);
    let p = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"facts_prepare","job":j}),
        &[],
    )
    .0;
    let usage = v.document_draft_snapshot().unwrap().transfer_scratch_bytes;
    let p2 = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"facts_prepare","job":j}),
        &[],
    )
    .0;
    assert_eq!(p, p2);
    let (a, a_body) = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"facts_read","job":j,"offset":"0","maximum":7}),
        &[],
    );
    let (b, b_body) = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"facts_read","job":j,"offset":"0","maximum":7}),
        &[],
    );
    assert_eq!((a, a_body.clone()), (b, b_body));
    assert_eq!(a_body.len(), 7);
    assert_eq!(
        v.document_draft_snapshot().unwrap().transfer_scratch_bytes,
        usage
    );
    assert_eq!(
        public(
            &mut v,
            &mut l,
            &lease,
            json!({"op":"acknowledge","job":j}),
            &[]
        )
        .0["ok"],
        true
    );
    assert!(v.document_draft_client_has_jobs(&op(CLIENT)));
    let (r, b) = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"facts_read","job":j,"offset":"0","maximum":7}),
        &[],
    );
    assert_eq!(r["ok"], false);
    assert!(b.is_empty());
    drive(&mut v, &mut l);
    assert!(!v.document_draft_client_has_jobs(&op(CLIENT)));
    assert_eq!(
        v.document_draft_snapshot().unwrap().transfer_scratch_bytes,
        0
    );
}
#[test]
fn truncated_upload_is_terminal_without_appending_partial_source() {
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    let j = reserve(&mut v, &mut l, &lease, "buffer", 1, "abcd");
    public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"upload_begin","job":j}),
        &[],
    );
    let raw = frame(
        json!({"method":"document_drafts","client_id":CLIENT,"request":{"op":"upload_chunk","job":j,"offset":"0"}}),
        Some(&lease),
        b"abcd",
    );
    let mut input = &raw[..raw.len() - 2];
    let h = read_frame_head(&mut input).unwrap().unwrap();
    let mut output = vec![];
    assert_eq!(
        execute_frame(
            &mut v,
            &mut l,
            h.request,
            h.body_len,
            &mut input,
            &mut output
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(output.is_empty());
    let (p, _) = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"progress","job":j}),
        &[],
    );
    assert_eq!(p["result"]["transfer"]["source_bytes_received"], 0);
}
#[test]
fn failed_facts_writer_keeps_ready_encoding_and_exact_retry() {
    struct Fail {
        remaining: usize,
    }
    impl Write for Fail {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "fixture"));
            }
            let n = b.len().min(self.remaining);
            self.remaining -= n;
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    let j = reserve(&mut v, &mut l, &lease, "buffer", 1, "# Heading");
    upload(&mut v, &mut l, &lease, &j, "# Heading");
    drive(&mut v, &mut l);
    let command = json!({"method":"document_drafts","client_id":CLIENT,"request":{"op":"facts_read","job":j,"offset":"0","maximum":128}});
    let bytes = frame(command.clone(), Some(&lease), &[]);
    let mut input = bytes.as_slice();
    let h = read_frame_head(&mut input).unwrap().unwrap();
    assert!(execute_frame(
        &mut v,
        &mut l,
        h.request,
        0,
        &mut input,
        &mut Fail { remaining: 10 }
    )
    .is_err());
    let (r, b) = call(&mut v, &mut l, command, Some(&lease), &[]);
    assert_eq!(r["ok"], true);
    assert!(!b.is_empty());
}
#[test]
fn superseded_and_wrong_lifetime_handles_never_deliver_old_ready_bytes() {
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    let old = reserve(&mut v, &mut l, &lease, "buffer", 1, "old");
    upload(&mut v, &mut l, &lease, &old, "old");
    drive(&mut v, &mut l);
    public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"facts_prepare","job":old}),
        &[],
    );
    let latest = reserve(&mut v, &mut l, &lease, "buffer", 2, "new");
    assert_ne!(old, latest);
    for mut token in [old.clone(), latest.clone()] {
        if token == latest {
            token["lifetime"] = json!("foreign");
        }
        let (r, b) = public(
            &mut v,
            &mut l,
            &lease,
            json!({"op":"facts_read","job":token,"offset":"0","maximum":16}),
            &[],
        );
        assert_eq!(r["ok"], false);
        assert!(b.is_empty());
    }
}
#[test]
fn release_retains_revoked_lease_until_actual_own_drop_and_preserves_other_client() {
    let (_r, _c, mut v, mut l) = fixture();
    let a = claim(&mut v, &mut l, CLIENT);
    let b = claim(&mut v, &mut l, OTHER);
    let j = reserve(&mut v, &mut l, &a, "a", 1, "one");
    upload(&mut v, &mut l, &a, &j, "one");
    let other = reserve(&mut v, &mut l, &b, "b", 1, "two");
    upload(&mut v, &mut l, &b, &other, "two");
    let error = super::super::execute(
        &mut v,
        &mut l,
        None,
        Command::ReleaseClient {
            reference: a.clone(),
        },
        vec![],
    )
    .unwrap_err();
    assert_eq!(error["code"], "document_drafts_draining");
    assert!(l.active.contains_key(a.token.as_str()));
    assert_eq!(
        public(&mut v, &mut l, &a, json!({"op":"snapshot"}), &[]).0["error"]["code"],
        "client_not_admitted"
    );
    assert!(v.document_draft_client_has_jobs(&op(OTHER)));
    drive(&mut v, &mut l);
    super::super::execute(
        &mut v,
        &mut l,
        None,
        Command::ReleaseClient {
            reference: a.clone(),
        },
        vec![],
    )
    .unwrap();
    assert!(!l.active.contains_key(a.token.as_str()));
    assert_eq!(
        public(
            &mut v,
            &mut l,
            &b,
            json!({"op":"facts_prepare","job":other}),
            &[]
        )
        .0["ok"],
        true
    );
    assert_eq!(
        super::super::execute(
            &mut v,
            &mut l,
            None,
            Command::ReleaseClient {
                reference: b.clone()
            },
            vec![]
        )
        .unwrap_err()["code"],
        "document_drafts_draining"
    );
    drive(&mut v, &mut l);
    assert!(v.document_work_close_ready());
    super::super::execute(
        &mut v,
        &mut l,
        None,
        Command::ReleaseClient {
            reference: b.clone(),
        },
        vec![],
    )
    .unwrap();
    assert!(l.active.is_empty());
    assert_eq!(v.document_draft_snapshot().unwrap().handles, 0);
}
#[test]
fn exact_work_ticket_replay_never_executes_second_phase_and_forgery_is_rejected() {
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    let j = reserve(&mut v, &mut l, &lease, "buffer", 1, "# Heading");
    upload(&mut v, &mut l, &lease, &j, "# Heading");
    let turn = trusted(&mut v, &mut l, json!({"op":"next_turn"}));
    let ticket = turn["work"]["selected"].clone();
    assert!(!ticket.is_null());
    trusted(&mut v, &mut l, json!({"op":"step","ticket":ticket}));
    let after = v.document_draft_snapshot().unwrap();
    trusted(&mut v, &mut l, json!({"op":"step","ticket":ticket}));
    assert_eq!(v.document_draft_snapshot().unwrap(), after);
    let mut forged = ticket;
    forged["id"] = json!("18446744073709551615");
    let (r, _) = call(
        &mut v,
        &mut l,
        json!({"method":"document_work","request":{"op":"step","ticket":forged}}),
        None,
        &[],
    );
    assert_eq!(r["error"]["code"], "draft_expired");
    assert_eq!(v.document_draft_snapshot().unwrap(), after);
}
#[test]
fn embedded_rejects_transient_routes_without_creating_owner() {
    let root = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let mut host = EmbeddedHost::open_local_with_data_root(root.path(), local.path()).unwrap();
    for command in [
        json!({"method":"document_drafts","client_id":CLIENT,"request":{"op":"snapshot"}}),
        json!({"method":"document_work","request":{"op":"next_turn"}}),
    ] {
        let encoded = frame(command, None, &[]);
        let (r, b) = decode(&host.dispatch(&encoded).unwrap());
        assert_eq!(r["error"]["code"], "client_operation_unsupported");
        assert!(b.is_empty());
    }
    assert!(host.vault.document_draft_snapshot().is_none());
}

fn doc(v: &mut NativeVault, l: &mut ClientLeases, lease: &ClientLeaseRef, command: Value) -> Value {
    let request = serde_json::from_value(json!({"schemaVersion":1,"command":command})).unwrap();
    let (_, body) =
        documents::execute(v, &mut l.documents, &lease.client_id, &lease.token, request).unwrap();
    serde_json::from_slice::<Value>(&body).unwrap()["value"].clone()
}
#[test]
fn composite_receipts_keep_committed_client_ids_and_actual_rebuild_pin_disposal() {
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    v.apply(&MutationRequest {
        operation_id: op("saved"),
        mutation: Mutation::Create {
            id: zorid_core::EntryId::new("note").unwrap(),
            path: zorid_core::VaultPath::new("Note.md").unwrap(),
            kind: EntryKind::File,
            content: Some(b"# Saved".to_vec()),
        },
    })
    .unwrap();
    doc(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"runtime_owner","sequence":"1","command":{"kind":"wake","monotonicMs":"1"}}),
    );
    doc(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"runtime_owner_ack","sequence":"1"}),
    );
    let life = v.document_runtime_update().unwrap().lifetime;
    doc(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"runtime_control","sequence":"1","command":{"kind":"request","lifetime":life,"id":"500","maxPumps":8,"maxRestarts":1,"forceRebuild":false}}),
    );
    doc(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"runtime_ack","sequence":"1"}),
    );
    let j = reserve(&mut v, &mut l, &lease, "draft", 1, "# Unsaved");
    upload(&mut v, &mut l, &lease, &j, "# Unsaved");
    drive(&mut v, &mut l);
    let observed = doc(&mut v, &mut l, &lease, json!({"op":"runtime_observe"}));
    assert!(
        observed["outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["outcome"]["id"] == "500" && o["outcome"]["kind"] == "finished"),
        "{observed}"
    );
    doc(&mut v, &mut l, &lease, json!({"op":"open","pinId":"1"}));
    assert_eq!(l.documents.retained_pin_count(), 1);
    doc(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"runtime_control","sequence":"2","command":{"kind":"request","lifetime":life,"id":"501","maxPumps":8,"maxRestarts":1,"forceRebuild":true}}),
    );
    doc(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"runtime_ack","sequence":"2"}),
    );
    drive(&mut v, &mut l);
    assert_eq!(l.documents.retained_pin_count(), 0);
    let observed = doc(&mut v, &mut l, &lease, json!({"op":"runtime_observe"}));
    assert!(
        observed["outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["outcome"]["id"] == "501" && o["outcome"]["kind"] == "finished"),
        "{observed}"
    );
}
#[test]
fn completed_seal_retry_observes_same_ready_without_recreating_upload() {
    let (_r, _c, mut v, mut l) = fixture();
    let lease = claim(&mut v, &mut l, CLIENT);
    let j = reserve(&mut v, &mut l, &lease, "buffer", 1, "# Heading");
    upload(&mut v, &mut l, &lease, &j, "# Heading");
    drive(&mut v, &mut l);
    let before = v.document_draft_snapshot().unwrap();
    let (r, b) = public(
        &mut v,
        &mut l,
        &lease,
        json!({"op":"upload_seal","job":j}),
        &[],
    );
    assert_eq!(r["ok"], true);
    assert!(b.is_empty());
    assert_eq!(v.document_draft_snapshot().unwrap(), before);
    assert!(r["result"]["state"]["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["job"] == j && o["kind"] == "ready"));
}
