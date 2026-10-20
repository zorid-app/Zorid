use super::binary_stream::*;
use super::metadata::{GraphRecord, MetadataState};
use super::*;
use std::collections::BTreeMap;

fn scope() -> Scope {
    Scope {
        realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
        vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
    }
}
fn id(value: &str) -> zorid_sync_protocol::UpdateId {
    zorid_sync_protocol::UpdateId::new(value).unwrap()
}
#[derive(Default)]
struct Source {
    chunks: BTreeMap<zorid_sync_protocol::UpdateId, Vec<u8>>,
    reads: usize,
    corrupt_at: Option<usize>,
}
impl ChunkSource for Source {
    fn read_chunk(
        &mut self,
        actual_scope: &Scope,
        chunk: &zorid_sync_protocol::UpdateId,
        _expected: &GraphRecord,
    ) -> Result<Vec<u8>> {
        assert_eq!(actual_scope, &scope());
        self.reads += 1;
        let mut bytes = self.chunks.get(chunk).ok_or(Error::InvalidState)?.clone();
        if self.corrupt_at == Some(self.reads) {
            bytes[0] ^= 1;
        }
        assert!(bytes.len() <= MAX_CHUNK_BYTES);
        Ok(bytes)
    }
}
fn record(
    records: &mut BTreeMap<zorid_sync_protocol::UpdateId, GraphRecord>,
    value: AuthoredRecord,
) {
    records.insert(value.id().clone(), value.record().clone());
}
fn event(
    records: &mut BTreeMap<zorid_sync_protocol::UpdateId, GraphRecord>,
    event: &str,
    parents: Vec<zorid_sync_protocol::UpdateId>,
    manifest: Manifest,
) {
    let identity = EntryIdentity {
        entry_id: zorid_core::EntryId::new("file").unwrap(),
        bootstrap_id: id("create"),
    };
    let effect = if event == "create" {
        v2::Effect::Create {
            entry_kind: EntryKind::File,
            location: Location {
                parent: None,
                name: "file.bin".into(),
            },
            content: Some(v2::ContentSeed::Binary { manifest }),
        }
    } else {
        v2::Effect::SetContent { content: manifest }
    };
    let payload = v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id(event),
        body: v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: id(event),
                identity,
                parents,
                effect,
            }],
        },
    };
    let (_, key, value) = GraphRecord::from_authored_exact(&payload.encode().unwrap()).unwrap();
    records.insert(key, value);
}
fn fixture() -> (MetadataState, Manifest, Source) {
    let mut builder = BinaryManifestBuilder::new(scope());
    let mut records = BTreeMap::new();
    let mut source = Source::default();
    for (name, bytes) in [
        ("chunk-a", vec![3; MAX_CHUNK_BYTES]),
        ("chunk-b", vec![4, 5, 6]),
    ] {
        source.chunks.insert(id(name), bytes.clone());
        record(&mut records, builder.push_chunk(id(name), &bytes).unwrap());
    }
    record(&mut records, builder.flush_page(id("page")).unwrap());
    let manifest = builder.finish().unwrap().manifest().clone();
    event(&mut records, "create", vec![], manifest.clone());
    let state = MetadataState::from_records(
        scope(),
        zorid_core::Revision::new("v1").unwrap(),
        records,
        BTreeMap::new(),
    )
    .unwrap();
    (state, manifest, source)
}
#[derive(Default)]
struct Sink {
    bytes: usize,
    finished: bool,
}
impl ContentSink for Sink {
    fn write_chunk(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes += bytes.len();
        Ok(())
    }
    fn finish(&mut self, _proof: &VerifiedManifest) -> Result<()> {
        self.finished = true;
        Ok(())
    }
}
#[test]
fn metadata_retains_exact_plaintext_and_restores_only_against_checked_commitments() {
    let payload = v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("chunk"),
        body: v2::Body::Chunk {
            bytes: vec![1, 2, 3],
        },
    };
    let raw = payload.encode().unwrap();
    let mut spaced = vec![b' '];
    spaced.extend_from_slice(&raw);
    let (_, _, a) = GraphRecord::from_authored_exact(&raw).unwrap();
    let (_, _, b) = GraphRecord::from_authored_exact(&spaced).unwrap();
    assert_eq!(a.body(), b.body());
    assert_ne!(a.payload_digest(), b.payload_digest());
    let encoded = serde_json::to_string(&b).unwrap();
    assert_eq!(
        GraphRecord::from_persisted_json(
            &encoded,
            b.payload_bytes(),
            b.payload_digest().clone(),
            b.summary_digest().unwrap()
        )
        .unwrap(),
        b
    );
    assert_eq!(
        GraphRecord::from_persisted_json(
            &encoded,
            b.payload_bytes(),
            a.payload_digest().clone(),
            b.summary_digest().unwrap()
        )
        .unwrap_err(),
        Error::InvalidState
    );
    let descriptor: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(
        descriptor["body"]["bytes"], 3,
        "metadata retains only a chunk length, not a body array"
    );
}
#[test]
fn builder_is_bounded_and_failed_append_does_not_advance() {
    let mut builder = BinaryManifestBuilder::new(scope());
    builder
        .push_chunk(id("a"), &vec![0; MAX_CHUNK_BYTES])
        .unwrap();
    assert_eq!(
        builder
            .push_chunk(id("a"), &vec![1; MAX_CHUNK_BYTES])
            .unwrap_err(),
        Error::DuplicateMismatch
    );
    assert_eq!(builder.accepted_length(), MAX_CHUNK_BYTES as u64);
    builder.push_chunk(id("last"), &[1]).unwrap();
    assert!(builder.push_chunk(id("after-last"), &[2]).is_err());
    builder.flush_page(id("page")).unwrap();
    assert_eq!(builder.pending_chunks(), 0);
    assert_eq!(
        builder.finish().unwrap().manifest().bytes,
        MAX_CHUNK_BYTES as u64 + 1
    );
}
#[test]
fn sync_and_resumable_verifiers_agree_and_bind_exact_metadata() {
    let (state, manifest, mut source) = fixture();
    let proof = verify_manifest(&state, &manifest, &mut source).unwrap();
    let mut driver = ManifestVerificationSession::new(&state, &manifest).unwrap();
    while let Some(request) = driver.next_chunk().cloned() {
        assert!(driver
            .provide_chunk(request.sequence() + 1, &source.chunks[request.id()])
            .is_err());
        driver
            .provide_chunk(request.sequence(), &source.chunks[request.id()])
            .unwrap();
    }
    driver
        .finish()
        .unwrap()
        .check_preconditions(&state, &manifest)
        .unwrap();
    proof.check_preconditions(&state, &manifest).unwrap();
    let changed = MetadataState::from_records(
        scope(),
        zorid_core::Revision::new("v2").unwrap(),
        state.records().clone(),
        state.activities().clone(),
    )
    .unwrap();
    assert_eq!(
        proof.check_preconditions(&changed, &manifest),
        Err(Error::VersionConflict)
    );
}
#[test]
fn metadata_complete_does_not_authorize_wrong_whole_hash_or_sink_publication() {
    let (state, mut manifest, mut source) = fixture();
    manifest.digest = Sha256Digest::of(b"wrong");
    let mut records = state.records().clone();
    event(&mut records, "create", vec![], manifest.clone());
    let state =
        MetadataState::from_records(scope(), state.version().clone(), records, BTreeMap::new())
            .unwrap();
    assert!(state.metadata_view().unwrap().namespace().entries
        [&zorid_core::EntryId::new("file").unwrap()]
        .contents[0]
        .status
        .missing
        .is_empty());
    assert!(verify_manifest(&state, &manifest, &mut source).is_err());
    let identity = EntryIdentity {
        entry_id: zorid_core::EntryId::new("file").unwrap(),
        bootstrap_id: id("create"),
    };
    let content = state.binary_content_ref(&identity, &id("create")).unwrap();
    let mut sink = Sink::default();
    assert!(stream_binary(&state, &content, &mut source, &mut sink).is_err());
    assert_eq!(sink.bytes, 0);
    assert!(!sink.finished);
}
#[test]
fn absent_graph_dependency_is_pending_but_missing_backing_bytes_is_error() {
    let (state, manifest, mut source) = fixture();
    source.chunks.remove(&id("chunk-a"));
    assert_eq!(
        verify_manifest(&state, &manifest, &mut source).unwrap_err(),
        Error::InvalidState
    );
    let mut records = state.records().clone();
    records.remove(&id("chunk-a"));
    let pending =
        MetadataState::from_records(scope(), state.version().clone(), records, BTreeMap::new())
            .unwrap();
    let all = verify_complete_binary_manifests(&pending, &mut source).unwrap();
    assert!(all.is_empty());
    assert!(all.get(&manifest).unwrap().is_none());
}
#[test]
fn all_history_verification_rejects_corrupt_dominated_content() {
    let (state, manifest, mut source) = fixture();
    let mut records = state.records().clone();
    let mut bad = manifest.clone();
    bad.digest = Sha256Digest::of(b"bad history");
    event(&mut records, "create", vec![], bad);
    event(
        &mut records,
        "new-content",
        vec![id("create")],
        manifest.clone(),
    );
    let state =
        MetadataState::from_records(scope(), state.version().clone(), records, BTreeMap::new())
            .unwrap();
    assert_eq!(
        state.metadata_view().unwrap().namespace().entries
            [&zorid_core::EntryId::new("file").unwrap()]
            .contents[0]
            .event,
        id("new-content")
    );
    assert!(verify_manifest(&state, &manifest, &mut source).is_ok());
    assert!(verify_complete_binary_manifests(&state, &mut source).is_err());
}
#[test]
fn changed_source_during_output_never_finishes_private_sink() {
    let (state, _manifest, mut source) = fixture();
    source.corrupt_at = Some(4);
    let identity = EntryIdentity {
        entry_id: zorid_core::EntryId::new("file").unwrap(),
        bootstrap_id: id("create"),
    };
    let content = state.binary_content_ref(&identity, &id("create")).unwrap();
    let mut sink = Sink::default();
    assert!(stream_binary(&state, &content, &mut source, &mut sink).is_err());
    assert_eq!(sink.bytes, MAX_CHUNK_BYTES);
    assert!(!sink.finished);
}
#[test]
fn empty_manifest_verifies_without_reading_any_chunk() {
    let builder = BinaryManifestBuilder::new(scope());
    let manifest = builder.finish().unwrap().manifest().clone();
    let mut records = BTreeMap::new();
    event(&mut records, "create", vec![], manifest.clone());
    let state = MetadataState::from_records(
        scope(),
        zorid_core::Revision::new("v").unwrap(),
        records,
        BTreeMap::new(),
    )
    .unwrap();
    let mut source = Source::default();
    let all = verify_complete_binary_manifests(&state, &mut source).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(source.reads, 0);
}

#[test]
fn maximal_wire_payload_descriptor_round_trips_with_bounded_wrapper_overhead() {
    let mut events = Vec::new();
    for index in 0..32 {
        let manifest = Manifest {
            bytes: 128,
            digest: Sha256Digest([7; 32]),
            pages: (0..128)
                .map(|_| PageRef {
                    id: id("p"),
                    bytes: 1,
                    digest: Sha256Digest([255; 32]),
                })
                .collect(),
        };
        events.push(v2::EntryEvent {
            id: id(&format!("event-{index}")),
            identity: EntryIdentity {
                entry_id: zorid_core::EntryId::new("file").unwrap(),
                bootstrap_id: id("create"),
            },
            parents: vec![id("create")],
            effect: v2::Effect::SetContent { content: manifest },
        });
    }
    let mut payload = v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("events"),
        body: v2::Body::Events { events },
    };
    let limit = crate::MAX_PAYLOAD_BYTES;
    let mut length = serde_json::to_vec(&payload).unwrap().len();
    assert!(length < limit);
    if let v2::Body::Events { events } = &mut payload.body {
        for event in events {
            if let v2::Effect::SetContent { content } = &mut event.effect {
                for page in &mut content.pages {
                    let extra = (limit - length).min(127);
                    page.id = id(&"p".repeat(1 + extra));
                    length += extra;
                }
            }
        }
    }
    let exact = payload.encode().unwrap();
    assert_eq!(exact.len(), limit);
    let (_, _, record) = GraphRecord::from_authored_exact(&exact).unwrap();
    let json = serde_json::to_string(&record).unwrap();
    assert!(json.len() > limit);
    assert!(json.len() <= metadata::MAX_GRAPH_RECORD_BYTES);
    let restored = GraphRecord::from_persisted_json(
        &json,
        record.payload_bytes(),
        record.payload_digest().clone(),
        record.summary_digest().unwrap(),
    )
    .unwrap();
    assert_eq!(restored, record);
}
