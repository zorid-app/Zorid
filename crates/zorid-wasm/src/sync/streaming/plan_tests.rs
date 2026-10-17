use super::super::tests::{fixture, scope, verify};
use super::*;
#[test]
fn private_finalization_rejects_other_metadata_proof_and_final_plan_checks_exact_state() {
    let (state, payloads) = fixture();
    let empty = meta::MetadataState::empty(scope(), revision("empty").unwrap());
    let make = || {
        let mut batch = planner::AuthoredMetadataBatch::new(scope());
        for exact in payloads.values() {
            batch.push_exact(exact).unwrap();
        }
        WasmMetadataCandidate::plain(
            planner::prepare_authored_batch(&empty, batch, revision("next").unwrap()).unwrap(),
        )
    };
    let candidate = make();
    let empty_proof = binary::AllBinaryVerificationSession::new(empty.clone())
        .unwrap()
        .finish()
        .unwrap();
    assert!(candidate
        .finalize_inner(WasmVerifiedBinarySet {
            verified: empty_proof
        })
        .is_err());
    let candidate = make();
    let proof = verify(candidate.candidate.verification_state(), &payloads);
    let plan = candidate
        .finalize_inner(WasmVerifiedBinarySet { verified: proof })
        .unwrap();
    plan.check(
        &WasmMetadataState {
            state: empty.clone(),
        },
        "{}",
        &[],
    )
    .unwrap();
    assert!(plan.check(&WasmMetadataState { state }, "{}", &[]).is_err());
}
#[test]
fn classification_contains_binary_refs_not_materialized_body() {
    let (state, payloads) = fixture();
    let proof = verify(&state, &payloads);
    let result = classify(&state, &proof, "[]").unwrap();
    assert_eq!(result.entries.len(), 1);
    let raw = serde_json::to_string(&classified_entry(&result.entries[0]).unwrap()).unwrap();
    assert!(raw.contains("selected_event"));
    assert!(raw.contains("\"bytes\":\"29\""));
    assert!(!raw.contains("binary bytes stay"));
    assert!(result.text_bytes(0.0).unwrap().is_none());
}
#[test]
fn generic_namespace_mutation_beside_binary_uses_metadata_and_checks_entries() {
    let (state, payloads) = fixture();
    let wrapper = WasmMetadataState {
        state: state.clone(),
    };
    let existing = EntryState {
        id: EntryId::new("file").unwrap(),
        path: VaultPath::new("file.bin").unwrap(),
        kind: zorid_core::EntryKind::File,
        revision: revision("file-rev").unwrap(),
        deleted: false,
    };
    let input = value!({"command":{"version":1,"request":{"operation_id":"folder-op","mutation":{"type":"create","id":"folder","path":"folder","kind":"folder","content":null}},"create_mode":null},"entries":[existing],"text":null,"allocation":{"metadata_revision":"meta-next","graph_revision":"graph-next","update_ids":["folder-event"],"text":null}});
    let candidate = wrapper.prepare_mutation_inner(&input.to_string()).unwrap();
    let proof = verify(candidate.candidate.verification_state(), &payloads);
    let plan = candidate
        .finalize_inner(WasmVerifiedBinarySet { verified: proof })
        .unwrap();
    assert_eq!(plan.emissions.len(), 1);
    assert!(plan
        .emissions
        .iter()
        .all(|p| p.len() < zorid_sync_protocol::MAX_PLAINTEXT_BYTES));
    plan.check(
        &wrapper,
        &value!({"entries":[existing],"text":null,"allocated_ids_unused":true}).to_string(),
        &[],
    )
    .unwrap();
    assert!(plan
        .check(
            &wrapper,
            &value!({"entries":[],"text":null,"allocated_ids_unused":true}).to_string(),
            &[]
        )
        .is_err());
}
#[test]
fn generic_text_create_keeps_bytes_out_of_classification_json() {
    let wrapper = WasmMetadataState {
        state: meta::MetadataState::empty(scope(), revision("empty").unwrap()),
    };
    let input = value!({"command":{"version":1,"request":{"operation_id":"text-op","mutation":{"type":"create","id":"note","path":"note.md","kind":"file","content":[104,105]}},"create_mode":"text"},"entries":[],"text":null,"allocation":{"metadata_revision":"text-meta","graph_revision":"text-graph","update_ids":["text-create","text-edit"],"text":{"actor":{"actor":7,"owner":{"replica_id":"device","incarnation_id":"incarnation"}},"new_text":{"bootstrap_id":"text-seed","empty_revision":"text-empty"}}}});
    let candidate = wrapper.prepare_mutation_inner(&input.to_string()).unwrap();
    let proof = candidate.candidate.verification_state().clone();
    let proof = binary::AllBinaryVerificationSession::new(proof)
        .unwrap()
        .finish()
        .unwrap();
    let plan = candidate
        .finalize_inner(WasmVerifiedBinarySet { verified: proof })
        .unwrap();
    let next = plan.guard.text_state().unwrap();
    assert_eq!(next.materialized_utf8().unwrap(), b"hi");
    let result = classify(
        plan.plan.verification_state(),
        plan.plan.verified_binaries(),
        &serde_json::to_string(&[next]).unwrap(),
    )
    .unwrap();
    let metadata = classified_entry(&result.entries[0]).unwrap();
    assert_eq!(
        metadata["outcome"]["content"]["content"]["byte_length"],
        "2"
    );
    assert!(!metadata.to_string().contains("[104,105]"));
    assert_eq!(result.text_bytes(0.0).unwrap().unwrap(), b"hi");
}

struct Entropy;
impl zorid_crypto::EntropySource for Entropy {
    fn fill(&mut self, bytes: &mut [u8]) -> std::result::Result<(), zorid_crypto::CryptoError> {
        bytes.fill(7);
        Ok(())
    }
}
#[test]
fn authenticated_chunk_retains_exact_plaintext_and_received_plan_fences_prior_wire() {
    let (_, payloads) = fixture();
    let exact = &payloads[&id("chunk").unwrap()];
    let mut noncanonical = b" \n".to_vec();
    noncanonical.extend(exact);
    let key = zorid_crypto::VaultKey::from_bytes([4; 32]);
    let header = zorid_sync_protocol::Header::new(
        scope().realm_id,
        scope().vault_id,
        id("chunk").unwrap(),
        zorid_sync_protocol::DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(&header, &noncanonical, &key, &mut Entropy)
        .unwrap()
        .encode();
    let update = crate::sync::open_update(
        &key,
        r#"{"realm_id":"realm","vault_id":"vault","update_id":"chunk","key_epoch":1}"#,
        &wire,
    )
    .unwrap();
    assert_eq!(update.exact_plaintext(), noncanonical);
    assert_eq!(
        update.file_chunk_bytes().unwrap(),
        b"binary bytes stay out of JSON"
    );
    let descriptor: serde_json::Value =
        serde_json::from_str(&update.authenticated_descriptor_json().unwrap()).unwrap();
    assert_eq!(
        descriptor["record"]["payload_digest"],
        value!(Sha256Digest::of(&noncanonical))
    );
    let empty = WasmMetadataState {
        state: meta::MetadataState::empty(scope(), revision("before").unwrap()),
    };
    let candidate = update
        .prepare_metadata_file(&empty, "received", &[])
        .unwrap();
    let proof =
        binary::AllBinaryVerificationSession::new(candidate.candidate.verification_state().clone())
            .unwrap()
            .finish()
            .unwrap();
    let plan = candidate
        .finalize_inner(WasmVerifiedBinarySet { verified: proof })
        .unwrap();
    plan.check(&empty, "{}", &[]).unwrap();
    assert_eq!(plan.received_wire_bytes(), wire);
    let next = plan.next_state().unwrap();
    let retry = update
        .prepare_metadata_file(&next, "retry-revision", &wire)
        .unwrap();
    let proof =
        binary::AllBinaryVerificationSession::new(retry.candidate.verification_state().clone())
            .unwrap()
            .finish()
            .unwrap();
    let retry = retry
        .finalize_inner(WasmVerifiedBinarySet { verified: proof })
        .unwrap();
    assert!(retry.next_state().is_none());
    retry.check(&next, "{}", &wire).unwrap();
    let mut changed = wire.clone();
    changed[0] ^= 1;
    assert!(retry.check(&next, "{}", &changed).is_err());
}
