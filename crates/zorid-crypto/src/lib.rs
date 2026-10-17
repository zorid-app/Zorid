//! AEAD for immutable vault-update envelopes. No key enrollment, storage or server.
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use std::fmt;
use zeroize::Zeroizing;
use zorid_sync_protocol::{
    Envelope, ExpectedContext, Header, ProtocolError, MAX_PLAINTEXT_BYTES, NONCE_BYTES,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    EntropyUnavailable,
    Protocol(ProtocolError),
    AuthenticationFailed,
    EncryptionFailed,
}
impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CryptoError {}
impl From<ProtocolError> for CryptoError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}
pub type Result<T> = std::result::Result<T, CryptoError>;

/// Host capability: implementations MUST fill every byte with fresh CSPRNG output,
/// or return failure. Never implement a deterministic production fallback.
/// Injection supports platform hosts and explicit test-only reproducible fixtures.
pub trait EntropySource {
    fn fill(&mut self, output: &mut [u8]) -> Result<()>;
}

#[cfg(feature = "system-entropy")]
pub struct SystemEntropy;
#[cfg(feature = "system-entropy")]
impl EntropySource for SystemEntropy {
    fn fill(&mut self, output: &mut [u8]) -> Result<()> {
        getrandom::fill(output).map_err(|_| CryptoError::EntropyUnavailable)
    }
}

/// Intentionally neither Debug, Clone nor Serialize. Zeroization is best effort:
/// callers, compiler temporaries and plaintext host buffers remain their own duty.
pub struct VaultKey(Zeroizing<[u8; 32]>);
impl VaultKey {
    pub fn generate(entropy: &mut impl EntropySource) -> Result<Self> {
        let mut bytes = Zeroizing::new([0; 32]);
        entropy.fill(bytes.as_mut())?;
        Ok(Self(bytes))
    }
    /// For trusted enrollment/recovery input; never derive this from an account ID.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    /// Explicit secret export for protected storage/recovery. Never log the result.
    pub fn expose_secret(&self) -> &[u8; 32] {
        &self.0
    }
}

/// An envelope authenticated once against an independently selected context.
///
/// Private construction keeps the original envelope and its authenticated bytes
/// associated as one capability while multiple typed payload decoders borrow it.
/// This does NOT validate an encrypted payload's required family/version/schema,
/// server authorization, freshness, or an individual device signature. Consumers
/// must dispatch using required fields INSIDE `plaintext()` and reject unknown or
/// missing required semantics before changing local state or a sync cursor.
///
/// Intentionally no Debug, Clone, Deserialize, mutable access or raw-plaintext
/// constructor. The owned plaintext is zeroized on drop; explicit caller copies,
/// host transfer buffers and compiler/decryption temporaries are not guaranteed
/// erased. Ciphertext and public envelope metadata are not secret storage.
///
/// ```compile_fail
/// use zorid_crypto::OpenedEnvelope;
/// use zorid_sync_protocol::Envelope;
/// fn forge(envelope: Envelope) -> OpenedEnvelope {
///     OpenedEnvelope { envelope, plaintext: Default::default() }
/// }
/// ```
pub struct OpenedEnvelope {
    envelope: Envelope,
    plaintext: Zeroizing<Vec<u8>>,
}
impl OpenedEnvelope {
    /// Bounded framing decode followed by exactly one AEAD open. `expected` must
    /// come from the authorized endpoint and independently selected local key/
    /// vault context, not be copied wholesale from the incoming untrusted header.
    /// No capability is returned on unsupported outer format, context mismatch,
    /// malformed/oversized input or authentication failure.
    pub fn open(wire: &[u8], expected: &ExpectedContext, key: &VaultKey) -> Result<Self> {
        let envelope = Envelope::decode(wire)?;
        let plaintext = crate::open(&envelope, expected, key)?;
        Ok(Self {
            envelope,
            plaintext,
        })
    }

    /// Header authenticated by the successful AEAD open and context check.
    pub fn header(&self) -> &Header {
        self.envelope.header()
    }

    /// The exact authenticated envelope. `encode()` reconstructs the original
    /// wire bytes, including the original header byte spelling, for durable dedup.
    pub fn envelope(&self) -> &Envelope {
        &self.envelope
    }

    /// Authenticated bytes, not yet a validated document or namespace operation.
    /// Typed consumers can inspect these repeatedly without decrypting again.
    pub fn plaintext(&self) -> &[u8] {
        &self.plaintext
    }
}

/// Call once per new UpdateId and durably save the returned envelope before any
/// transmission. Retry the saved envelope; calling seal again is NOT a retry.
pub fn seal(
    header: &Header,
    plaintext: &[u8],
    key: &VaultKey,
    entropy: &mut impl EntropySource,
) -> Result<Envelope> {
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(ProtocolError::TooLarge.into());
    }
    header.require_supported_document_format()?;
    let aad = header.encode()?;
    let mut nonce = [0; NONCE_BYTES];
    entropy.fill(&mut nonce)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose_secret())
        .map_err(|_| CryptoError::EncryptionFailed)?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::EncryptionFailed)?;
    Ok(Envelope::from_parts(&aad, nonce, &ciphertext)?)
}

/// Header claims become authenticated only on success. Key possession does not
/// prove a particular device signature. This authenticates bytes, not document
/// schema validity, server authorization, freshness, or absence of rollback.
/// Prefer `OpenedEnvelope` when passing authenticated data between payload
/// decoders: it binds the original envelope and plaintext without reauthentication.
pub fn open(
    envelope: &Envelope,
    expected: &ExpectedContext,
    key: &VaultKey,
) -> Result<Zeroizing<Vec<u8>>> {
    envelope.header().require_supported_document_format()?;
    expected.check(envelope.header())?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose_secret())
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    let plaintext = cipher
        .decrypt(
            &XNonce::from(*envelope.nonce()),
            Payload {
                msg: envelope.ciphertext(),
                aad: envelope.header_bytes(),
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    Ok(Zeroizing::new(plaintext))
}
