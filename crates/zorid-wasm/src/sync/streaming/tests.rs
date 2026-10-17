use super::*;
use zorid_core::{EntryId, EntryKind};
use zorid_file_sync::{EntryIdentity, Family, Location};
pub(super) fn scope() -> Scope {
    Scope {
        realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
        vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
    }
}
pub(super) fn fixture() -> (meta::MetadataState, BTreeMap<UpdateId, Vec<u8>>) {
    let mut builder = binary::BinaryManifestBuilder::new(scope());
    let chunk = builder
        .push_chunk(id("chunk").unwrap(), b"binary bytes stay out of JSON")
        .unwrap();
    let page = builder.flush_page(id("page").unwrap()).unwrap();
    let built = builder.finish().unwrap();
    let event = files::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("create").unwrap(),
        body: files::Body::Events {
            events: vec![files::EntryEvent {
                id: id("create").unwrap(),
                identity: EntryIdentity {
                    entry_id: EntryId::new("file").unwrap(),
                    bootstrap_id: id("create").unwrap(),
                },
                parents: vec![],
                effect: files::Effect::Create {
                    entry_kind: EntryKind::File,
                    location: Location {
                        parent: None,
                        name: "file.bin".into(),
                    },
                    content: Some(files::ContentSeed::Binary {
                        manifest: built.manifest().clone(),
                    }),
                },
            }],
        },
    }
    .encode()
    .unwrap();
    let mut records = BTreeMap::new();
    let mut payloads = BTreeMap::new();
    for exact in [chunk.payload_bytes(), page.payload_bytes(), &event] {
        let (_, id, record) = meta::GraphRecord::from_authored_exact(exact).unwrap();
        records.insert(id.clone(), record);
        payloads.insert(id, exact.to_vec());
    }
    (
        meta::MetadataState::from_records(
            scope(),
            revision("graph").unwrap(),
            records,
            BTreeMap::new(),
        )
        .unwrap(),
        payloads,
    )
}
pub(super) fn verify(
    state: &meta::MetadataState,
    payloads: &BTreeMap<UpdateId, Vec<u8>>,
) -> binary::VerifiedBinarySet {
    let mut session = WasmBinaryVerificationSession::from_state(state).unwrap();
    while let Some(request) = session.session.next_chunk().unwrap().cloned() {
        session
            .provide(
                request.manifest_index() as f64,
                request.sequence() as f64,
                &payloads[request.id()],
            )
            .unwrap();
    }
    session.session.finish().unwrap()
}
#[test]
fn rowwise_restore_checks_independent_commitments_and_decimal_manifest_lengths() {
    let (state, _) = fixture();
    let mut builder = WasmMetadataStateBuilder {
        scope: scope(),
        version: revision("graph").unwrap(),
        records: BTreeMap::new(),
        activities: BTreeMap::new(),
        bytes: 0,
    };
    for (id, record) in state.records() {
        let raw = descriptor(record).unwrap();
        assert!(builder
            .restore_record(
                id.as_str(),
                &raw,
                record.payload_bytes() as f64,
                &[0; 32],
                &record.summary_digest().unwrap().0
            )
            .is_err());
        assert!(builder
            .restore_record(
                id.as_str(),
                &raw,
                -1.0,
                &record.payload_digest().0,
                &record.summary_digest().unwrap().0
            )
            .is_err());
        builder
            .restore_record(
                id.as_str(),
                &raw,
                record.payload_bytes() as f64,
                &record.payload_digest().0,
                &record.summary_digest().unwrap().0,
            )
            .unwrap();
        assert!(builder
            .restore_record(
                id.as_str(),
                &raw,
                record.payload_bytes() as f64,
                &record.payload_digest().0,
                &record.summary_digest().unwrap().0
            )
            .is_err());
        if id.as_str() == "create" {
            assert!(raw.contains("\"bytes\":\"29\""));
        }
    }
    assert_eq!(builder.finish_inner().unwrap().state, state);
}
#[test]
fn session_rejects_same_decoded_chunk_with_different_exact_plaintext_before_advancing() {
    let (state, payloads) = fixture();
    let mut session = WasmBinaryVerificationSession::from_state(&state).unwrap();
    let request = session.session.next_chunk().unwrap().unwrap().clone();
    let exact = &payloads[request.id()];
    let mut changed = b" \n".to_vec();
    changed.extend(exact);
    assert!(session.provide(0.0, 0.0, &changed).is_err());
    assert_eq!(session.session.next_chunk().unwrap().unwrap().sequence(), 0);
    assert!(session.provide(0.0, 0.5, exact).is_err());
    assert!(session.provide(4294967296.0, 0.0, exact).is_err());
    session.provide(0.0, 0.0, exact).unwrap();
    assert!(session.provide(0.0, 0.0, exact).is_err());
    session
        .session
        .finish()
        .unwrap()
        .check_preconditions(&state)
        .unwrap();
}
#[test]
fn incomplete_session_cannot_manufacture_a_proof_and_corrupt_chunks_fail() {
    let (state, payloads) = fixture();
    assert!(WasmBinaryVerificationSession::from_state(&state)
        .unwrap()
        .session
        .finish()
        .is_err());
    let mut session = WasmBinaryVerificationSession::from_state(&state).unwrap();
    let request = session.session.next_chunk().unwrap().unwrap().clone();
    let mut payload: files::Payload = files::Payload::decode(&payloads[request.id()]).unwrap();
    if let files::Body::Chunk { bytes } = &mut payload.body {
        bytes[0] ^= 1;
    }
    assert!(session
        .provide(0.0, 0.0, &payload.encode().unwrap())
        .is_err());
}
#[test]
fn source_metadata_and_binary_bytes_have_separate_bounds() {
    let mut builder = binary::BinaryManifestBuilder::new(scope());
    assert!(builder
        .push_chunk(
            id("oversize").unwrap(),
            &vec![0; zorid_file_sync::MAX_CHUNK_BYTES + 1]
        )
        .is_err());
    let (state, payloads) = fixture();
    let proof = verify(&state, &payloads);
    let mut changed = state.records().clone();
    changed.remove(&id("chunk").unwrap());
    let changed = meta::MetadataState::from_records(
        scope(),
        revision("graph").unwrap(),
        changed,
        state.activities().clone(),
    )
    .unwrap();
    assert!(proof.check_preconditions(&changed).is_err());
}
