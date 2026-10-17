use super::*;
use crate::binary_stream::{verify_complete_binary_manifests, BinaryManifestBuilder, ChunkSource};
use crate::metadata::{GraphRecord, MetadataState};
use crate::metadata_plan::*;
use std::collections::BTreeMap;
use zorid_crypto::{CryptoError, EntropySource, VaultKey};
use zorid_sync_protocol::{DeviceId, ExpectedContext, Header, RealmId, UpdateId, VaultId};
fn scope() -> Scope {
    Scope {
        realm_id: RealmId::new("r").unwrap(),
        vault_id: VaultId::new("v").unwrap(),
    }
}
fn id(s: &str) -> UpdateId {
    UpdateId::new(s).unwrap()
}
fn rev(s: &str) -> Revision {
    Revision::new(s).unwrap()
}
fn empty() -> MetadataState {
    MetadataState::empty(scope(), rev("zero"))
}
fn payload(name: &str, parents: &[&str], manifest: Manifest) -> v2::Payload {
    v2::Payload {
        family: Family::Files,
        format_version: 2,
        scope: scope(),
        id: id(name),
        body: v2::Body::Events {
            events: vec![v2::EntryEvent {
                id: id(name),
                identity: EntryIdentity {
                    entry_id: EntryId::new("file").unwrap(),
                    bootstrap_id: id("create"),
                },
                parents: parents.iter().map(|v| id(v)).collect(),
                effect: if name == "create" {
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
                },
            }],
        },
    }
}
fn blank() -> Manifest {
    Manifest {
        bytes: 0,
        digest: Sha256Digest::of(&[]),
        pages: vec![],
    }
}
struct Entropy(u8);
impl EntropySource for Entropy {
    fn fill(&mut self, b: &mut [u8]) -> std::result::Result<(), CryptoError> {
        b.fill(self.0);
        Ok(())
    }
}
fn incoming(payload: &v2::Payload, nonce: u8) -> v2::AuthenticatedPayload {
    let header = Header::new(
        scope().realm_id,
        scope().vault_id,
        payload.id.clone(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let key = VaultKey::from_bytes([1; 32]);
    let wire = zorid_crypto::seal(
        &header,
        &payload.encode().unwrap(),
        &key,
        &mut Entropy(nonce),
    )
    .unwrap()
    .encode();
    v2::AuthenticatedPayload::open(
        &wire,
        &ExpectedContext {
            realm_id: scope().realm_id,
            vault_id: scope().vault_id,
            update_id: payload.id.clone(),
            key_epoch: 1,
        },
        &key,
    )
    .unwrap()
}
#[derive(Default)]
struct Source(BTreeMap<UpdateId, Vec<u8>>);
impl ChunkSource for Source {
    fn read_chunk(&mut self, _: &Scope, id: &UpdateId, _: &GraphRecord) -> Result<Vec<u8>> {
        self.0.get(id).cloned().ok_or(Error::InvalidState)
    }
}
#[test]
fn exact_batch_retries_do_not_retain_or_duplicate_emissions() {
    let raw = payload("create", &[], blank()).encode().unwrap();
    let mut batch = AuthoredMetadataBatch::new(scope());
    let a = batch.push_exact(&raw).unwrap();
    assert_eq!(batch.push_exact(&raw).unwrap(), a);
    assert_eq!(batch.payload_refs().len(), 1);
    assert_eq!(a.payload_digest(), &Sha256Digest::of(&raw));
    let mut changed = vec![b' '];
    changed.extend_from_slice(&raw);
    assert_eq!(
        batch.push_exact(&changed).unwrap_err(),
        Error::DuplicateMismatch
    );
    let candidate = prepare_authored_batch(&empty(), batch, rev("one")).unwrap();
    assert_eq!(candidate.authored_payload_refs().len(), 1);
    let proof =
        verify_complete_binary_manifests(candidate.verification_state(), &mut Source::default())
            .unwrap();
    let plan = candidate.finalize(proof).unwrap();
    plan.check_preconditions(&empty(), None).unwrap();
    assert_eq!(
        plan.check_preconditions(&MetadataState::empty(scope(), rev("other")), None)
            .unwrap_err(),
        Error::VersionConflict
    );
}
#[test]
fn authored_pending_rejects_but_received_pending_can_finalize() {
    let p = payload("later", &["create"], blank());
    let mut batch = AuthoredMetadataBatch::new(scope());
    batch.push_exact(&p.encode().unwrap()).unwrap();
    assert_eq!(
        prepare_authored_batch(&empty(), batch, rev("one")).unwrap_err(),
        Error::InvalidCausality
    );
    let received = incoming(&p, 3);
    let candidate = prepare_received(&empty(), &received, None, rev("one")).unwrap();
    assert!(candidate
        .metadata_view()
        .namespace()
        .pending
        .contains(&id("later")));
    let proof =
        verify_complete_binary_manifests(candidate.verification_state(), &mut Source::default())
            .unwrap();
    candidate.finalize(proof).unwrap();
}
#[test]
fn exact_wire_replay_and_descriptor_authority_are_both_required() {
    let p = payload("create", &[], blank());
    let a = incoming(&p, 4);
    let c = prepare_received(&empty(), &a, None, rev("one")).unwrap();
    let next = c.next_state().unwrap().clone();
    let duplicate = prepare_received(&next, &a, Some(a.record()), rev("ignored")).unwrap();
    assert!(duplicate.next_state().is_none());
    let proof =
        verify_complete_binary_manifests(duplicate.verification_state(), &mut Source::default())
            .unwrap();
    let plan = duplicate.finalize(proof).unwrap();
    assert_eq!(
        plan.check_preconditions(&next, None).unwrap_err(),
        Error::DuplicateMismatch
    );
    plan.check_preconditions(&next, Some(a.record())).unwrap();
    let changed_nonce = incoming(&p, 5);
    assert_eq!(
        prepare_received(&next, &changed_nonce, Some(a.record()), rev("two")).unwrap_err(),
        Error::DuplicateMismatch
    );
    assert_eq!(
        prepare_received(&empty(), &a, Some(a.record()), rev("two")).unwrap_err(),
        Error::InvalidState
    );
}
#[test]
fn finalize_rejects_proof_for_same_heads_with_different_exact_descriptor() {
    let raw = payload("create", &[], blank()).encode().unwrap();
    let mut a = AuthoredMetadataBatch::new(scope());
    a.push_exact(&raw).unwrap();
    let candidate = prepare_authored_batch(&empty(), a, rev("one")).unwrap();
    let mut spaced = vec![b' '];
    spaced.extend_from_slice(&raw);
    let mut b = AuthoredMetadataBatch::new(scope());
    b.push_exact(&spaced).unwrap();
    let other = prepare_authored_batch(&empty(), b, rev("one")).unwrap();
    let proof =
        verify_complete_binary_manifests(other.verification_state(), &mut Source::default())
            .unwrap();
    assert_eq!(
        candidate.finalize(proof).unwrap_err(),
        Error::VersionConflict
    );
}
#[test]
fn staged_batch_dependencies_are_atomic_and_backing_loss_is_corruption() {
    let mut builder = BinaryManifestBuilder::new(scope());
    let chunk = builder.push_chunk(id("chunk"), b"abc").unwrap();
    let page = builder.flush_page(id("page")).unwrap();
    let manifest = builder.finish().unwrap().manifest().clone();
    let mut batch = AuthoredMetadataBatch::new(scope());
    batch.push_exact(chunk.payload_bytes()).unwrap();
    batch.push_exact(page.payload_bytes()).unwrap();
    batch
        .push_exact(&payload("create", &[], manifest).encode().unwrap())
        .unwrap();
    let candidate = prepare_authored_batch(&empty(), batch, rev("one")).unwrap();
    assert_eq!(candidate.authored_payload_refs().len(), 3);
    assert_eq!(
        verify_complete_binary_manifests(candidate.verification_state(), &mut Source::default())
            .unwrap_err(),
        Error::InvalidState
    );
    let mut source = Source::default();
    source.0.insert(id("chunk"), b"abc".to_vec());
    let proof =
        verify_complete_binary_manifests(candidate.verification_state(), &mut source).unwrap();
    candidate.finalize(proof).unwrap();
}

#[test]
fn authored_missing_content_rejects_while_received_waits_for_dependencies() {
    let mut builder = BinaryManifestBuilder::new(scope());
    builder.push_chunk(id("missing-chunk"), b"abc").unwrap();
    builder.flush_page(id("missing-page")).unwrap();
    let manifest = builder.finish().unwrap().manifest().clone();
    let p = payload("create", &[], manifest);
    let mut batch = AuthoredMetadataBatch::new(scope());
    batch.push_exact(&p.encode().unwrap()).unwrap();
    assert_eq!(
        prepare_authored_batch(&empty(), batch, rev("one")).unwrap_err(),
        Error::InvalidContent
    );
    let received = incoming(&p, 8);
    let candidate = prepare_received(&empty(), &received, None, rev("one")).unwrap();
    let proof =
        verify_complete_binary_manifests(candidate.verification_state(), &mut Source::default())
            .unwrap();
    assert!(proof.is_empty());
    candidate.finalize(proof).unwrap();
}
