//! A bounded single-vault, single-key-epoch recovery wrapper. See
//! `docs/recovery-key-bundle.md` for trust boundaries and exact framing.
use crate::{CryptoError, EntropySource, Result, VaultKey};
use chacha20poly1305::{
    aead::{AeadInOut, KeyInit},
    Tag, XChaCha20Poly1305, XNonce,
};
use zeroize::Zeroizing;
use zorid_sync_protocol::{ProtocolError, RealmId, VaultId};

const MAGIC: &[u8; 4] = b"ZRBK";
const DOMAIN: &[u8] = b"Zorid/recovery/vault-key/v1\0";
const VERSION: u8 = 1;
const SUITE: u8 = 1;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 32;
const TAG_BYTES: usize = 16;
pub const MAX_RECOVERY_BUNDLE_BYTES: usize = 340;
const MIN_BUNDLE_BYTES: usize = 86;

/// A random external wrapping secret, distinct from the content-encryption key.
/// Neither Debug, Clone nor Serialize. Keep it outside the ciphertext backup.
/// Explicit exports, compiler temporaries and host buffers remain the caller's
/// responsibility; zeroization here is best effort, not a memory-erasure promise.
pub struct RecoveryKey(Zeroizing<[u8; KEY_BYTES]>);
impl RecoveryKey {
    pub fn generate(entropy: &mut impl EntropySource) -> Result<Self> {
        let mut bytes = Zeroizing::new([0; KEY_BYTES]);
        entropy.fill(bytes.as_mut())?;
        Ok(Self(bytes))
    }
    /// Import a protected random 32-byte secret, not a password or account ID.
    pub fn from_bytes(bytes: [u8; KEY_BYTES]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    /// Secret export for separate protected storage. Never log this value.
    pub fn expose_secret(&self) -> &[u8; KEY_BYTES] {
        &self.0
    }
}

/// Expected context must be selected independently of the incoming bundle.
/// Authentic old bundles remain replayable: this does not establish freshness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryContext {
    realm_id: RealmId,
    vault_id: VaultId,
    key_epoch: u32,
}
impl RecoveryContext {
    pub fn new(realm_id: RealmId, vault_id: VaultId, key_epoch: u32) -> Result<Self> {
        if key_epoch == 0 {
            return Err(ProtocolError::InvalidHeader.into());
        }
        Ok(Self {
            realm_id,
            vault_id,
            key_epoch,
        })
    }
}

/// Wrap once, then durably retain the resulting bytes for retries. The random
/// recovery secret is an external capability and never belongs in relay backup.
pub fn seal_recovery_bundle(
    context: &RecoveryContext,
    vault_key: &VaultKey,
    recovery_key: &RecoveryKey,
    entropy: &mut impl EntropySource,
) -> Result<Vec<u8>> {
    let mut header = Vec::with_capacity(268);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&[VERSION, SUITE]);
    for id in [context.realm_id.as_str(), context.vault_id.as_str()] {
        header.push(id.len() as u8);
        header.extend_from_slice(id.as_bytes());
    }
    header.extend_from_slice(&context.key_epoch.to_be_bytes());
    let mut nonce = [0; NONCE_BYTES];
    entropy.fill(&mut nonce)?;
    let cipher = XChaCha20Poly1305::new_from_slice(recovery_key.expose_secret())
        .map_err(|_| CryptoError::EncryptionFailed)?;
    // In-place detached API ensures even failed operations retain their secret
    // temporary in a zeroizing owner, rather than an unowned allocating decrypt.
    let mut body = Zeroizing::new(*vault_key.expose_secret());
    let aad = aad(&header);
    let tag = cipher
        .encrypt_inout_detached(&XNonce::from(nonce), &aad, body.as_mut_slice().into())
        .map_err(|_| CryptoError::EncryptionFailed)?;
    header.extend_from_slice(&nonce);
    header.extend_from_slice(body.as_ref());
    header.extend_from_slice(tag.as_slice());
    Ok(header)
}

/// Strict bounded framing, independent context verification, then AEAD open.
/// Authentication failure deliberately does not distinguish a wrong secret from
/// corruption. No plaintext key is returned until every check succeeds.
pub fn open_recovery_bundle(
    wire: &[u8],
    expected: &RecoveryContext,
    recovery_key: &RecoveryKey,
) -> Result<VaultKey> {
    if wire.len() > MAX_RECOVERY_BUNDLE_BYTES {
        return Err(ProtocolError::TooLarge.into());
    }
    if wire.len() < MIN_BUNDLE_BYTES || &wire[..4] != MAGIC {
        return Err(ProtocolError::InvalidFrame.into());
    }
    if wire[4] != VERSION || wire[5] != SUITE {
        return Err(ProtocolError::UnsupportedEnvelope.into());
    }
    let mut pos = 6;
    // Constructors enforce the existing canonical identifier grammar. The raw
    // cap precedes all allocations, and each string is bounded before copying.
    let realm_id = RealmId::new(read_id(wire, &mut pos)?)?;
    let vault_id = VaultId::new(read_id(wire, &mut pos)?)?;
    if wire.len() != pos + 4 + NONCE_BYTES + KEY_BYTES + TAG_BYTES {
        return Err(ProtocolError::InvalidFrame.into());
    }
    let key_epoch = u32::from_be_bytes(wire[pos..pos + 4].try_into().unwrap());
    pos += 4;
    let actual = RecoveryContext::new(realm_id, vault_id, key_epoch)?;
    if actual != *expected {
        return Err(ProtocolError::ContextMismatch.into());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(recovery_key.expose_secret())
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    let mut body = Zeroizing::new([0; KEY_BYTES]);
    body.copy_from_slice(&wire[pos + NONCE_BYTES..pos + NONCE_BYTES + KEY_BYTES]);
    let nonce: [u8; NONCE_BYTES] = wire[pos..pos + NONCE_BYTES]
        .try_into()
        .map_err(|_| ProtocolError::InvalidFrame)?;
    let tag: [u8; TAG_BYTES] = wire[pos + NONCE_BYTES + KEY_BYTES..]
        .try_into()
        .map_err(|_| ProtocolError::InvalidFrame)?;
    cipher
        .decrypt_inout_detached(
            &XNonce::from(nonce),
            &aad(&wire[..pos]),
            body.as_mut_slice().into(),
            &Tag::from(tag),
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    // Move the zeroizing owner into VaultKey without making another plaintext copy.
    Ok(VaultKey(body))
}

fn aad(header: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(DOMAIN.len() + header.len());
    bytes.extend_from_slice(DOMAIN);
    bytes.extend_from_slice(header);
    bytes
}
fn read_id<'a>(wire: &'a [u8], pos: &mut usize) -> Result<&'a str> {
    let len = *wire.get(*pos).ok_or(ProtocolError::InvalidFrame)? as usize;
    *pos += 1;
    if !(1..=128).contains(&len) {
        return Err(ProtocolError::InvalidId.into());
    }
    let end = *pos + len;
    let bytes = wire.get(*pos..end).ok_or(ProtocolError::InvalidFrame)?;
    let value = std::str::from_utf8(bytes).map_err(|_| ProtocolError::InvalidId)?;
    *pos = end;
    Ok(value)
}
