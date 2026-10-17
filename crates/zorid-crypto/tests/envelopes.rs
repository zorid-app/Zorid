use zorid_crypto::*;
use zorid_sync_protocol::*;

// Deliberately deterministic TEST fixture, never exported from the crypto crate.
struct FixtureEntropy(u8);
impl EntropySource for FixtureEntropy {
    fn fill(&mut self, output: &mut [u8]) -> zorid_crypto::Result<()> {
        output.fill(self.0);
        self.0 += 1;
        Ok(())
    }
}
struct FailedEntropy;
impl EntropySource for FailedEntropy {
    fn fill(&mut self, _output: &mut [u8]) -> zorid_crypto::Result<()> {
        Err(CryptoError::EntropyUnavailable)
    }
}
fn header() -> Header {
    Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        UpdateId::new("update").unwrap(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap()
}
fn expected() -> ExpectedContext {
    ExpectedContext {
        realm_id: RealmId::new("realm").unwrap(),
        vault_id: VaultId::new("vault").unwrap(),
        update_id: UpdateId::new("update").unwrap(),
        key_epoch: 1,
    }
}
#[test]
fn binary_roundtrip_and_immutable_serialized_retry() {
    let mut entropy = FixtureEntropy(1);
    let key = VaultKey::generate(&mut entropy).unwrap();
    let plaintext: Vec<u8> = (0..=255).cycle().take(65536).collect();
    let envelope = seal(&header(), &plaintext, &key, &mut entropy).unwrap();
    let restored = Envelope::decode(&envelope.encode()).unwrap();
    envelope.check_retry(&restored).unwrap();
    assert_eq!(
        open(&restored, &expected(), &key).unwrap().as_slice(),
        plaintext
    );
    let resealed = seal(&header(), &plaintext, &key, &mut entropy).unwrap();
    assert_eq!(
        envelope.check_retry(&resealed),
        Err(ProtocolError::IdempotencyConflict)
    );
}
#[test]
fn ciphertext_nonce_tag_and_exact_aad_tampering_are_rejected() {
    let key = VaultKey::from_bytes([5; 32]);
    let envelope = seal(&header(), b"private note", &key, &mut FixtureEntropy(9)).unwrap();
    for index in [0, envelope.ciphertext().len() - 1] {
        let mut ciphertext = envelope.ciphertext().to_vec();
        ciphertext[index] ^= 1;
        let changed =
            Envelope::from_parts(envelope.header_bytes(), *envelope.nonce(), &ciphertext).unwrap();
        assert!(matches!(
            open(&changed, &expected(), &key),
            Err(CryptoError::AuthenticationFailed)
        ));
    }
    let mut nonce = *envelope.nonce();
    nonce[0] ^= 1;
    let changed =
        Envelope::from_parts(envelope.header_bytes(), nonce, envelope.ciphertext()).unwrap();
    assert!(matches!(
        open(&changed, &expected(), &key),
        Err(CryptoError::AuthenticationFailed)
    ));
    let mut spaced = envelope.header_bytes().to_vec();
    spaced.push(b' ');
    let changed = Envelope::from_parts(&spaced, *envelope.nonce(), envelope.ciphertext()).unwrap();
    assert!(matches!(
        open(&changed, &expected(), &key),
        Err(CryptoError::AuthenticationFailed)
    ));
    // Origin is authenticated even though it is not an independently signed identity.
    let mut raw: serde_json::Value = serde_json::from_slice(envelope.header_bytes()).unwrap();
    raw["origin_device_id"] = "other-device".into();
    let changed = Envelope::from_parts(
        &serde_json::to_vec(&raw).unwrap(),
        *envelope.nonce(),
        envelope.ciphertext(),
    )
    .unwrap();
    assert!(matches!(
        open(&changed, &expected(), &key),
        Err(CryptoError::AuthenticationFailed)
    ));
    assert!(matches!(
        open(&envelope, &expected(), &VaultKey::from_bytes([6; 32])),
        Err(CryptoError::AuthenticationFailed)
    ));
}
#[test]
fn endpoint_and_local_key_context_are_independently_required() {
    let key = VaultKey::from_bytes([5; 32]);
    let envelope = seal(&header(), b"secret", &key, &mut FixtureEntropy(9)).unwrap();
    let original = expected();
    let variants = [
        ExpectedContext {
            realm_id: RealmId::new("foreign").unwrap(),
            ..original.clone()
        },
        ExpectedContext {
            vault_id: VaultId::new("foreign").unwrap(),
            ..original.clone()
        },
        ExpectedContext {
            update_id: UpdateId::new("foreign").unwrap(),
            ..original.clone()
        },
        ExpectedContext {
            key_epoch: 2,
            ..original
        },
    ];
    for context in variants {
        assert!(matches!(
            open(&envelope, &context, &key),
            Err(CryptoError::Protocol(ProtocolError::ContextMismatch))
        ));
    }
}
#[test]
fn entropy_failure_and_oversize_fail_without_an_envelope() {
    assert!(matches!(
        VaultKey::generate(&mut FailedEntropy),
        Err(CryptoError::EntropyUnavailable)
    ));
    let key = VaultKey::from_bytes([5; 32]);
    assert!(matches!(
        seal(&header(), b"secret", &key, &mut FailedEntropy),
        Err(CryptoError::EntropyUnavailable)
    ));
    assert!(matches!(
        seal(
            &header(),
            &vec![0; MAX_PLAINTEXT_BYTES + 1],
            &key,
            &mut FailedEntropy
        ),
        Err(CryptoError::Protocol(ProtocolError::TooLarge))
    ));
}

#[test]
fn opaque_future_format_can_be_relayed_but_not_consumed_or_authored_by_this_client() {
    let key = VaultKey::from_bytes([5; 32]);
    let envelope = seal(&header(), b"secret", &key, &mut FixtureEntropy(9)).unwrap();
    let mut raw: serde_json::Value = serde_json::from_slice(envelope.header_bytes()).unwrap();
    raw["document_format_version"] = 2.into();
    let bytes = serde_json::to_vec(&raw).unwrap();
    let relay = Envelope::from_parts(&bytes, *envelope.nonce(), envelope.ciphertext()).unwrap();
    let relay = Envelope::decode(&relay.encode()).unwrap();
    assert!(matches!(
        open(&relay, &expected(), &key),
        Err(CryptoError::Protocol(
            ProtocolError::UnsupportedDocumentFormat
        ))
    ));
    assert!(matches!(
        seal(relay.header(), b"secret", &key, &mut FixtureEntropy(9)),
        Err(CryptoError::Protocol(
            ProtocolError::UnsupportedDocumentFormat
        ))
    ));
}

#[cfg(feature = "system-entropy")]
#[test]
fn platform_entropy_and_boundary_payload_sizes_work() {
    let mut entropy = SystemEntropy;
    let key = VaultKey::generate(&mut entropy).unwrap();
    for bytes in [vec![], vec![0x83; MAX_PLAINTEXT_BYTES]] {
        let sealed = seal(&header(), &bytes, &key, &mut entropy).unwrap();
        let restored = Envelope::decode(&sealed.encode()).unwrap();
        assert_eq!(
            open(&restored, &expected(), &key).unwrap().as_slice(),
            bytes
        );
    }
}

#[test]
fn opened_capability_retains_exact_authenticated_envelope_and_borrowed_plaintext() {
    use chacha20poly1305::{
        aead::{Aead, Payload},
        KeyInit, XChaCha20Poly1305, XNonce,
    };
    let key = VaultKey::from_bytes([5; 32]);
    // Valid noncanonical AAD spelling exercises exact-byte retention rather than
    // reconstructing a semantically equal header before authentication/persistence.
    let mut aad = header().encode().unwrap();
    aad.extend_from_slice(b" \n");
    let nonce = [11; NONCE_BYTES];
    let plaintext = b"authenticated bytes are not automatically a valid schema\0";
    let ciphertext = XChaCha20Poly1305::new_from_slice(key.expose_secret())
        .unwrap()
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .unwrap();
    let wire = Envelope::from_parts(&aad, nonce, &ciphertext)
        .unwrap()
        .encode();
    let opened = OpenedEnvelope::open(&wire, &expected(), &key).unwrap();
    assert_eq!(opened.envelope().encode(), wire);
    assert_eq!(opened.envelope().header_bytes(), aad);
    assert_eq!(opened.header().vault_id(), &expected().vault_id);
    assert_eq!(opened.plaintext(), plaintext);
}

#[test]
fn opened_capability_cannot_be_obtained_for_unauthenticated_or_wrong_context_bytes() {
    let key = VaultKey::from_bytes([5; 32]);
    let wire = seal(&header(), b"private", &key, &mut FixtureEntropy(9))
        .unwrap()
        .encode();
    let mut changed = wire.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert!(matches!(
        OpenedEnvelope::open(&changed, &expected(), &key),
        Err(CryptoError::AuthenticationFailed)
    ));
    assert!(matches!(
        OpenedEnvelope::open(&wire, &expected(), &VaultKey::from_bytes([8; 32])),
        Err(CryptoError::AuthenticationFailed)
    ));
    let mut context = expected();
    context.vault_id = VaultId::new("foreign").unwrap();
    assert!(matches!(
        OpenedEnvelope::open(&wire, &context, &key),
        Err(CryptoError::Protocol(ProtocolError::ContextMismatch))
    ));
    assert!(matches!(
        OpenedEnvelope::open(&vec![0; MAX_WIRE_BYTES + 1], &expected(), &key),
        Err(CryptoError::Protocol(ProtocolError::TooLarge))
    ));
    assert!(OpenedEnvelope::open(b"malformed", &expected(), &key).is_err());
}
