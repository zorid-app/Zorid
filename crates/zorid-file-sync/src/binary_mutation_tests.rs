use super::*;
use crate::binary_stream::{verify_complete_binary_manifests, BinaryManifestBuilder, ChunkSource};
use crate::metadata::GraphRecord;
use crate::{Result as FileResult, Scope, Sha256Digest};
use std::collections::BTreeMap;
use zorid_sync_protocol::{RealmId, VaultId};
fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn entry(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn path(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}
fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("r").unwrap(),
        vault_id: VaultId::new("v").unwrap(),
    }
}
fn empty() -> MetadataState {
    MetadataState::empty(scope(), rev("empty"))
}
#[derive(Default)]
struct Source(BTreeMap<UpdateId, Vec<u8>>);
impl ChunkSource for Source {
    fn read_chunk(&mut self, _: &Scope, id: &UpdateId, _: &GraphRecord) -> FileResult<Vec<u8>> {
        self.0.get(id).cloned().ok_or(crate::Error::InvalidState)
    }
}
fn stage(tag: &str, bytes: &[u8]) -> (AuthoredMetadataBatch, Manifest, Source) {
    let mut builder = BinaryManifestBuilder::new(scope());
    let mut batch = AuthoredMetadataBatch::new(scope());
    let mut source = Source::default();
    if !bytes.is_empty() {
        let chunk_id = id(&format!("chunk-{tag}"));
        let chunk = builder.push_chunk(chunk_id.clone(), bytes).unwrap();
        batch.push_exact(chunk.payload_bytes()).unwrap();
        source.0.insert(chunk_id, bytes.to_vec());
        let page = builder.flush_page(id(&format!("page-{tag}"))).unwrap();
        batch.push_exact(page.payload_bytes()).unwrap();
    }
    (batch, builder.finish().unwrap().manifest().clone(), source)
}
fn create_target() -> BinaryTarget {
    BinaryTarget::Create {
        id: entry("file"),
        path: path("file.bin"),
    }
}
fn write_target(event: &str) -> BinaryTarget {
    BinaryTarget::Write {
        id: entry("file"),
        expected_revision: rev("metadata-one"),
        expected_content_event: id(event),
    }
}
fn fixture() -> (MetadataState, Vec<EntryState>, Source) {
    let (batch, manifest, source) = stage("first", b"same");
    let prepared = prepare_binary_mutation(
        &empty(),
        &[],
        create_target(),
        batch,
        &manifest,
        id("create"),
        rev("graph-one"),
    )
    .unwrap();
    (
        prepared.candidate().verification_state().clone(),
        vec![EntryState {
            id: entry("file"),
            path: path("file.bin"),
            kind: EntryKind::File,
            revision: rev("metadata-one"),
            deleted: false,
        }],
        source,
    )
}
#[test]
fn atomic_stage_mapping_retains_target_and_one_bounded_event() {
    let (batch, manifest, mut source) = stage("first", b"same");
    let prepared = prepare_binary_mutation(
        &empty(),
        &[],
        create_target(),
        batch,
        &manifest,
        id("create"),
        rev("graph-one"),
    )
    .unwrap();
    assert_eq!(prepared.target(), &create_target());
    assert_eq!(prepared.candidate().authored_payload_refs().len(), 3);
    assert!(
        prepared.final_event().payload_bytes().len() <= zorid_sync_protocol::MAX_PLAINTEXT_BYTES
    );
    assert!(
        matches!(prepared.final_event().record().body(), GraphRecordBody::Events { events } if events.len() == 1)
    );
    prepared.check_preconditions(&empty(), &[]).unwrap();
    assert_eq!(
        prepared
            .check_preconditions(&MetadataState::empty(scope(), rev("changed")), &[])
            .unwrap_err(),
        Error::SnapshotMismatch
    );
    let (_, _, event, candidate) = prepared.into_parts();
    assert_eq!(event.id(), &id("create"));
    let proof =
        verify_complete_binary_manifests(candidate.verification_state(), &mut source).unwrap();
    candidate.finalize(proof).unwrap();
}
#[test]
fn same_bytes_do_not_satisfy_different_selected_event_or_revision() {
    let (state, entries, _) = fixture();
    let (batch, manifest, _) = stage("second", b"same");
    let wrong = BinaryTarget::Write {
        id: entry("file"),
        expected_revision: rev("stale"),
        expected_content_event: id("create"),
    };
    assert!(matches!(
        prepare_binary_mutation(
            &state,
            &entries,
            wrong,
            batch,
            &manifest,
            id("write"),
            rev("graph-two")
        ),
        Err(Error::Contract(
            zorid_core::ContractError::RevisionConflict { .. }
        ))
    ));
    let (batch, manifest, _) = stage("second", b"same");
    let prepared = prepare_binary_mutation(
        &state,
        &entries,
        write_target("create"),
        batch,
        &manifest,
        id("write"),
        rev("graph-two"),
    )
    .unwrap();
    let next = prepared.candidate().verification_state();
    let (batch, manifest, _) = stage("third", b"same");
    assert_eq!(
        prepare_binary_mutation(
            next,
            &entries,
            write_target("create"),
            batch,
            &manifest,
            id("write-again"),
            rev("graph-three")
        )
        .unwrap_err(),
        Error::SnapshotMismatch
    );
}
#[test]
fn extra_or_missing_stage_records_never_piggyback_on_commit() {
    let (mut batch, manifest, _) = stage("first", b"same");
    let extra = v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("extra"),
        body: v2::Body::Chunk { bytes: vec![1] },
    };
    batch.push_exact(&extra.encode().unwrap()).unwrap();
    assert_eq!(
        prepare_binary_mutation(
            &empty(),
            &[],
            create_target(),
            batch,
            &manifest,
            id("create"),
            rev("graph-one")
        )
        .unwrap_err(),
        Error::InvalidAllocation
    );
    let empty_batch = AuthoredMetadataBatch::new(scope());
    assert_eq!(
        prepare_binary_mutation(
            &empty(),
            &[],
            create_target(),
            empty_batch,
            &manifest,
            id("create"),
            rev("graph-one")
        )
        .unwrap_err(),
        Error::InvalidAllocation
    );
}
#[test]
fn missing_remote_references_remain_reserved_for_original_author() {
    let event = v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id("pending"),
        body: v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: id("pending"),
                identity: EntryIdentity {
                    entry_id: entry("remote"),
                    bootstrap_id: id("future-create"),
                },
                parents: vec![id("future-create")],
                effect: v2::Effect::Move {
                    location: Location {
                        parent: None,
                        name: "remote.bin".into(),
                    },
                },
            }],
        },
    };
    let (_, key, record) = GraphRecord::from_authored_exact(&event.encode().unwrap()).unwrap();
    let state = MetadataState::from_records(
        scope(),
        rev("initial"),
        BTreeMap::from([(key, record)]),
        BTreeMap::new(),
    )
    .unwrap();
    let (batch, manifest, _) = stage("local", b"local");
    assert_eq!(
        prepare_binary_mutation(
            &state,
            &[],
            create_target(),
            batch,
            &manifest,
            id("future-create"),
            rev("next")
        )
        .unwrap_err(),
        Error::InvalidAllocation
    );
}
#[test]
fn unmaterialized_logical_occupancy_and_historical_ids_are_not_free() {
    let (state, _, _) = fixture();
    let (batch, manifest, _) = stage("local", b"local");
    let target = BinaryTarget::Create {
        id: entry("different"),
        path: path("file.bin"),
    };
    assert_eq!(
        prepare_binary_mutation(
            &state,
            &[],
            target,
            batch,
            &manifest,
            id("other-create"),
            rev("next")
        )
        .unwrap_err(),
        Error::SnapshotMismatch
    );
    let (batch, manifest, _) = stage("local", b"local");
    let target = BinaryTarget::Create {
        id: entry("file"),
        path: path("elsewhere.bin"),
    };
    assert_eq!(
        prepare_binary_mutation(
            &state,
            &[],
            target,
            batch,
            &manifest,
            id("other-create"),
            rev("next")
        )
        .unwrap_err(),
        Error::SnapshotMismatch
    );
}
#[test]
fn empty_binary_creation_and_snapshot_kind_path_fences_are_explicit() {
    let (batch, manifest, mut source) = stage("empty", b"");
    assert_eq!(manifest.digest, Sha256Digest::of(&[]));
    let prepared = prepare_binary_mutation(
        &empty(),
        &[],
        create_target(),
        batch,
        &manifest,
        id("create"),
        rev("one"),
    )
    .unwrap();
    assert_eq!(prepared.candidate().authored_payload_refs().len(), 1);
    let (_, _, _, candidate) = prepared.into_parts();
    let proof =
        verify_complete_binary_manifests(candidate.verification_state(), &mut source).unwrap();
    candidate.finalize(proof).unwrap();
    let (state, mut entries, _) = fixture();
    entries[0].path = path("wrong.bin");
    let (batch, manifest, _) = stage("next", b"other");
    assert_eq!(
        prepare_binary_mutation(
            &state,
            &entries,
            write_target("create"),
            batch,
            &manifest,
            id("write"),
            rev("two")
        )
        .unwrap_err(),
        Error::SnapshotMismatch
    );
}
