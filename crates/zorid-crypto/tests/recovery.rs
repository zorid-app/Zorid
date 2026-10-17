use zorid_crypto::{recovery::*, *};
use zorid_sync_protocol::*;

// Deterministic entropy is exclusively a test fixture.
struct Entropy(u8);
impl EntropySource for Entropy {
    fn fill(&mut self, out: &mut [u8]) -> zorid_crypto::Result<()> {
        out.fill(self.0);
        self.0 += 1;
        Ok(())
    }
}
struct FailedEntropy;
impl EntropySource for FailedEntropy {
    fn fill(&mut self, out: &mut [u8]) -> zorid_crypto::Result<()> {
        out.fill(42); // Even partially filled failure must never yield a key/bundle.
        Err(CryptoError::EntropyUnavailable)
    }
}
fn context(realm: &str, vault: &str, epoch: u32) -> RecoveryContext {
    RecoveryContext::new(
        RealmId::new(realm).unwrap(),
        VaultId::new(vault).unwrap(),
        epoch,
    )
    .unwrap()
}
fn fixture() -> (RecoveryContext, RecoveryKey, Vec<u8>) {
    let context = context("realm", "vault", 1);
    let key = RecoveryKey::from_bytes([7; 32]);
    let wire = seal_recovery_bundle(
        &context,
        &VaultKey::from_bytes([19; 32]),
        &key,
        &mut Entropy(2),
    )
    .unwrap();
    (context, key, wire)
}
#[test]
fn roundtrip_maximum_ids_and_external_secret() {
    let context = context(&"r".repeat(128), &"v".repeat(128), u32::MAX);
    let mut entropy = Entropy(1);
    let recovery = RecoveryKey::generate(&mut entropy).unwrap();
    let key = VaultKey::generate(&mut entropy).unwrap();
    let wire = seal_recovery_bundle(&context, &key, &recovery, &mut entropy).unwrap();
    assert_eq!(wire.len(), MAX_RECOVERY_BUNDLE_BYTES);
    assert!(
        open_recovery_bundle(&wire, &context, &recovery)
            .unwrap()
            .expose_secret()
            == key.expose_secret()
    );
    let second = seal_recovery_bundle(&context, &key, &recovery, &mut entropy).unwrap();
    assert_ne!(wire, second); // Retry retains first bytes; resealing is a new bundle.
    let smallest = context_short();
    assert_eq!(
        seal_recovery_bundle(&smallest, &key, &recovery, &mut entropy)
            .unwrap()
            .len(),
        86
    );
}
fn context_short() -> RecoveryContext {
    context("r", "v", 1)
}
#[test]
fn wrong_secret_and_each_independent_context_reject() {
    let (expected, key, wire) = fixture();
    assert!(matches!(
        open_recovery_bundle(&wire, &expected, &RecoveryKey::from_bytes([8; 32])),
        Err(CryptoError::AuthenticationFailed)
    ));
    for wrong in [
        context("other", "vault", 1),
        context("realm", "other", 1),
        context("realm", "vault", 2),
    ] {
        assert!(matches!(
            open_recovery_bundle(&wire, &wrong, &key),
            Err(CryptoError::Protocol(ProtocolError::ContextMismatch))
        ));
    }
    assert!(
        RecoveryContext::new(RealmId::new("r").unwrap(), VaultId::new("v").unwrap(), 0).is_err()
    );
}
#[test]
fn every_byte_tamper_and_every_truncation_reject() {
    let (expected, key, wire) = fixture();
    for position in 0..wire.len() {
        let mut changed = wire.clone();
        changed[position] ^= 1;
        assert!(
            open_recovery_bundle(&changed, &expected, &key).is_err(),
            "accepted changed byte {position}"
        );
    }
    for length in 0..wire.len() {
        assert!(open_recovery_bundle(&wire[..length], &expected, &key).is_err());
    }
    let mut trailing = wire.clone();
    trailing.push(0);
    assert!(open_recovery_bundle(&trailing, &expected, &key).is_err());
    assert!(matches!(
        open_recovery_bundle(&vec![0; MAX_RECOVERY_BUNDLE_BYTES + 1], &expected, &key),
        Err(CryptoError::Protocol(ProtocolError::TooLarge))
    ));
}
#[test]
fn changed_context_cannot_authenticate_even_when_expected_matches_change() {
    let (_, key, wire) = fixture();
    for (position, value, expected) in [
        (7, b'R', context("Realm", "vault", 1)),
        (13, b'V', context("realm", "Vault", 1)),
        (21, 2, context("realm", "vault", 2)),
    ] {
        let mut changed = wire.clone();
        changed[position] = value;
        assert!(matches!(
            open_recovery_bundle(&changed, &expected, &key),
            Err(CryptoError::AuthenticationFailed)
        ));
    }
}
#[test]
fn unsupported_versions_invalid_ids_and_epoch_fail_closed() {
    let (expected, key, wire) = fixture();
    for position in [4, 5] {
        let mut changed = wire.clone();
        changed[position] = 2;
        assert!(matches!(
            open_recovery_bundle(&changed, &expected, &key),
            Err(CryptoError::Protocol(ProtocolError::UnsupportedEnvelope))
        ));
    }
    for (position, value) in [(6, 0), (6, 129), (7, b'/'), (12, 0), (13, 0xff), (21, 0)] {
        let mut changed = wire.clone();
        changed[position] = value;
        assert!(open_recovery_bundle(&changed, &expected, &key).is_err());
    }
}
#[test]
fn entropy_failure_and_cross_purpose_envelopes_are_rejected() {
    let (expected, key, wire) = fixture();
    assert!(matches!(
        RecoveryKey::generate(&mut FailedEntropy),
        Err(CryptoError::EntropyUnavailable)
    ));
    let vault_key = VaultKey::from_bytes([19; 32]);
    assert!(matches!(
        seal_recovery_bundle(&expected, &vault_key, &key, &mut FailedEntropy),
        Err(CryptoError::EntropyUnavailable)
    ));
    assert!(Envelope::decode(&wire).is_err());
    let header = Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        UpdateId::new("update").unwrap(),
        DeviceId::new("device").unwrap(),
        1,
    )
    .unwrap();
    let envelope = seal(
        &header,
        vault_key.expose_secret(),
        &vault_key,
        &mut Entropy(2),
    )
    .unwrap();
    assert!(open_recovery_bundle(&envelope.encode(), &expected, &key).is_err());
}
#[cfg(feature = "system-entropy")]
#[test]
fn system_entropy_roundtrip() {
    let expected = context_short();
    let key = VaultKey::generate(&mut SystemEntropy).unwrap();
    let recovery = RecoveryKey::generate(&mut SystemEntropy).unwrap();
    let wire = seal_recovery_bundle(&expected, &key, &recovery, &mut SystemEntropy).unwrap();
    assert!(
        open_recovery_bundle(&wire, &expected, &recovery)
            .unwrap()
            .expose_secret()
            == key.expose_secret()
    );
}
