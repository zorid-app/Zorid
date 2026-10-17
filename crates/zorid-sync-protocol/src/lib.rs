//! Bounded ciphertext framing, not an authenticated server or document merger.
//! Decode before AEAD only establishes structure; header claims remain untrusted.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

pub const TRANSPORT_MAJOR: u16 = 1;
pub const ENVELOPE_VERSION: u16 = 1;
pub const DOCUMENT_FORMAT_VERSION: u32 = 1;
pub const MAX_HEADER_BYTES: usize = 4096;
pub const MAX_CONTROL_BYTES: usize = 4096;
pub const MAX_PLAINTEXT_BYTES: usize = 1024 * 1024;
pub const NONCE_BYTES: usize = 24;
pub const TAG_BYTES: usize = 16;
pub const MAX_WIRE_BYTES: usize =
    8 + MAX_HEADER_BYTES + NONCE_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES;
const MAGIC: &[u8; 4] = b"ZSE1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidId,
    InvalidSequence,
    TooLarge,
    InvalidFrame,
    InvalidHeader,
    UnsupportedTransport,
    UnsupportedEnvelope,
    UnsupportedDocumentFormat,
    UnsupportedRequiredFeature,
    ContextMismatch,
    IdempotencyConflict,
    EpochMismatch,
}
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProtocolError {}
pub type Result<T> = std::result::Result<T, ProtocolError>;

macro_rules! id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > 128
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                {
                    return Err(ProtocolError::InvalidId);
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = ProtocolError;
            fn try_from(s: String) -> Result<Self> {
                Self::new(s)
            }
        }
        impl From<$name> for String {
            fn from(id: $name) -> Self {
                id.0
            }
        }
    };
}
id!(RealmId);
id!(VaultId);
id!(UpdateId);
id!(DeviceId);
id!(ServerEpoch);

/// Decimal on the wire. Zero is the initial cursor, never an accepted receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct LogPosition(u64);
impl LogPosition {
    pub fn new(value: u64) -> Self {
        Self(value)
    }
    pub fn get(self) -> u64 {
        self.0
    }
}
impl TryFrom<String> for LogPosition {
    type Error = ProtocolError;
    fn try_from(value: String) -> Result<Self> {
        if value.is_empty()
            || value.len() > 20
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(ProtocolError::InvalidSequence);
        }
        value
            .parse()
            .map(Self)
            .map_err(|_| ProtocolError::InvalidSequence)
    }
}
impl From<LogPosition> for String {
    fn from(value: LogPosition) -> Self {
        value.0.to_string()
    }
}

/// The only additive control-message lane. Optional values are informational;
/// required semantics must be understood before acting on a message.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ControlExtensions {
    required_features: Vec<String>,
    optional_extensions: BTreeMap<String, serde_json::Value>,
}
impl ControlExtensions {
    /// Decode a standalone extensions object under the shared control policy.
    /// Bounds input before parsing. A containing message must independently bound
    /// its entire transport body before allocation and validate its own fields.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_CONTROL_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        let raw: RawControlExtensions =
            serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidHeader)?;
        Self::try_from(raw)
    }
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawControlExtensions {
    #[serde(default)]
    required_features: Vec<String>,
    #[serde(default)]
    optional_extensions: BTreeMap<String, serde_json::Value>,
}
impl TryFrom<RawControlExtensions> for ControlExtensions {
    type Error = ProtocolError;
    fn try_from(raw: RawControlExtensions) -> Result<Self> {
        validate_extensions(&raw.required_features, &raw.optional_extensions)?;
        Ok(Self {
            required_features: raw.required_features,
            optional_extensions: raw.optional_extensions,
        })
    }
}
fn validate_extensions(
    required: &[String],
    optional: &BTreeMap<String, serde_json::Value>,
) -> Result<()> {
    if !required.is_empty() {
        return Err(ProtocolError::UnsupportedRequiredFeature);
    }
    if optional.len() > 16 || optional.keys().any(|key| key.is_empty() || key.len() > 64) {
        return Err(ProtocolError::InvalidHeader);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cursor {
    pub server_epoch: ServerEpoch,
    pub after: LogPosition,
    extensions: ControlExtensions,
}
impl Cursor {
    pub fn start(server_epoch: ServerEpoch) -> Self {
        Self::new(server_epoch, LogPosition(0))
    }
    pub fn new(server_epoch: ServerEpoch, after: LogPosition) -> Self {
        Self {
            server_epoch,
            after,
            extensions: ControlExtensions::default(),
        }
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            server_epoch: ServerEpoch,
            after: LogPosition,
            #[serde(default)]
            extensions: RawControlExtensions,
        }
        if bytes.len() > MAX_CONTROL_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        let raw: Raw = serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidFrame)?;
        Ok(Self {
            server_epoch: raw.server_epoch,
            after: raw.after,
            extensions: ControlExtensions::try_from(raw.extensions)?,
        })
    }
    pub fn check_epoch(&self, actual: &ServerEpoch) -> Result<()> {
        if &self.server_epoch == actual {
            Ok(())
        } else {
            Err(ProtocolError::EpochMismatch)
        }
    }
}

/// Constructed by a server only AFTER ciphertext commit. Parsing this type alone
/// proves no durability; clients must receive it over their authenticated channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Accepted {
    vault_id: VaultId,
    update_id: UpdateId,
    server_epoch: ServerEpoch,
    sequence: LogPosition,
    extensions: ControlExtensions,
}
impl Accepted {
    pub fn new(
        vault_id: VaultId,
        update_id: UpdateId,
        server_epoch: ServerEpoch,
        sequence: LogPosition,
    ) -> Result<Self> {
        if sequence.get() == 0 {
            return Err(ProtocolError::InvalidSequence);
        }
        Ok(Self {
            vault_id,
            update_id,
            server_epoch,
            sequence,
            extensions: ControlExtensions::default(),
        })
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            vault_id: VaultId,
            update_id: UpdateId,
            server_epoch: ServerEpoch,
            sequence: LogPosition,
            #[serde(default)]
            extensions: RawControlExtensions,
        }
        if bytes.len() > MAX_CONTROL_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        let raw: Raw = serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidFrame)?;
        let mut result = Self::new(raw.vault_id, raw.update_id, raw.server_epoch, raw.sequence)?;
        result.extensions = ControlExtensions::try_from(raw.extensions)?;
        Ok(result)
    }
    pub fn check_target(
        &self,
        vault_id: &VaultId,
        update_id: &UpdateId,
        epoch: &ServerEpoch,
    ) -> Result<()> {
        if &self.vault_id != vault_id || &self.update_id != update_id {
            return Err(ProtocolError::ContextMismatch);
        }
        if &self.server_epoch != epoch {
            return Err(ProtocolError::EpochMismatch);
        }
        Ok(())
    }
    pub fn sequence(&self) -> LogPosition {
        self.sequence
    }
}

/// This function negotiates only transport, not document format or database schema.
pub fn negotiate_transport(offered: &[u16]) -> Result<u16> {
    if offered.len() > 16 {
        return Err(ProtocolError::TooLarge);
    }
    if offered.contains(&TRANSPORT_MAJOR) {
        Ok(TRANSPORT_MAJOR)
    } else {
        Err(ProtocolError::UnsupportedTransport)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeaderFields {
    envelope_version: u16,
    purpose: String,
    suite: String,
    realm_id: RealmId,
    vault_id: VaultId,
    update_id: UpdateId,
    origin_device_id: DeviceId,
    key_epoch: u32,
    document_format_version: u32,
    required_features: Vec<String>,
    #[serde(default)]
    optional_extensions: BTreeMap<String, serde_json::Value>,
}

/// Immutable validated structure. No derived Deserialize: use bounded `decode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header(HeaderFields);
impl Header {
    pub fn new(
        realm_id: RealmId,
        vault_id: VaultId,
        update_id: UpdateId,
        origin_device_id: DeviceId,
        key_epoch: u32,
    ) -> Result<Self> {
        let header = Self(HeaderFields {
            envelope_version: ENVELOPE_VERSION,
            purpose: "vault_update".into(),
            suite: "xchacha20poly1305".into(),
            realm_id,
            vault_id,
            update_id,
            origin_device_id,
            key_epoch,
            document_format_version: DOCUMENT_FORMAT_VERSION,
            required_features: vec![],
            optional_extensions: BTreeMap::new(),
        });
        header.validate()?;
        Ok(header)
    }
    fn validate(&self) -> Result<()> {
        if self.0.envelope_version != ENVELOPE_VERSION {
            return Err(ProtocolError::UnsupportedEnvelope);
        }
        if self.0.document_format_version == 0 {
            return Err(ProtocolError::InvalidHeader);
        }
        if self.0.purpose != "vault_update"
            || self.0.suite != "xchacha20poly1305"
            || self.0.key_epoch == 0
        {
            return Err(ProtocolError::InvalidHeader);
        }
        // Version 1 has no required feature extensions. Unknown optional extensions
        // are preserved/authenticated but cannot alter correctness or authorization.
        if !self.0.required_features.is_empty() {
            return Err(ProtocolError::UnsupportedRequiredFeature);
        }
        if self.0.optional_extensions.len() > 16
            || self
                .0
                .optional_extensions
                .keys()
                .any(|key| key.is_empty() || key.len() > 64)
        {
            return Err(ProtocolError::InvalidHeader);
        }
        Ok(())
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        let header = Self(serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidHeader)?);
        header.validate()?;
        Ok(header)
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(&self.0).map_err(|_| ProtocolError::InvalidHeader)?;
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        Ok(bytes)
    }
    /// The relay can store a positive opaque future document format. A client
    /// must check support before decryption/application/cursor advancement.
    pub fn require_supported_document_format(&self) -> Result<()> {
        if self.0.document_format_version != DOCUMENT_FORMAT_VERSION {
            return Err(ProtocolError::UnsupportedDocumentFormat);
        }
        Ok(())
    }
    pub fn document_format_version(&self) -> u32 {
        self.0.document_format_version
    }
    pub fn realm_id(&self) -> &RealmId {
        &self.0.realm_id
    }
    pub fn vault_id(&self) -> &VaultId {
        &self.0.vault_id
    }
    pub fn update_id(&self) -> &UpdateId {
        &self.0.update_id
    }
    pub fn origin_device_id(&self) -> &DeviceId {
        &self.0.origin_device_id
    }
    pub fn key_epoch(&self) -> u32 {
        self.0.key_epoch
    }
}

/// Context must come from the authorized endpoint/local vault, never be copied
/// wholesale from an incoming header and presented as an independent check.
#[derive(Debug, Clone)]
pub struct ExpectedContext {
    pub realm_id: RealmId,
    pub vault_id: VaultId,
    pub update_id: UpdateId,
    pub key_epoch: u32,
}
impl ExpectedContext {
    pub fn check(&self, header: &Header) -> Result<()> {
        if &self.realm_id != header.realm_id()
            || &self.vault_id != header.vault_id()
            || &self.update_id != header.update_id()
            || self.key_epoch != header.key_epoch()
        {
            return Err(ProtocolError::ContextMismatch);
        }
        Ok(())
    }
}

/// Parsed but NOT authenticated. The exact original header bytes are AEAD AAD.
/// No mutators or serde decoding; network callers must bound body reads first,
/// then use `decode`, which bounds lengths before allocating/parsing any header.
#[derive(Clone, PartialEq, Eq)]
pub struct Envelope {
    header: Header,
    header_bytes: Vec<u8>,
    nonce: [u8; NONCE_BYTES],
    ciphertext: Vec<u8>,
}
impl Envelope {
    pub fn from_parts(
        header_bytes: &[u8],
        nonce: [u8; NONCE_BYTES],
        ciphertext: &[u8],
    ) -> Result<Self> {
        if ciphertext.len() > MAX_PLAINTEXT_BYTES + TAG_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        if ciphertext.len() < TAG_BYTES {
            return Err(ProtocolError::InvalidFrame);
        }
        let header = Header::decode(header_bytes)?;
        Ok(Self {
            header,
            header_bytes: header_bytes.to_vec(),
            nonce,
            ciphertext: ciphertext.to_vec(),
        })
    }
    pub fn decode(wire: &[u8]) -> Result<Self> {
        if wire.len() > MAX_WIRE_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        if wire.len() < 8 + NONCE_BYTES + TAG_BYTES || &wire[..4] != MAGIC {
            return Err(ProtocolError::InvalidFrame);
        }
        let header_len = u32::from_be_bytes(
            wire[4..8]
                .try_into()
                .map_err(|_| ProtocolError::InvalidFrame)?,
        ) as usize;
        if header_len > MAX_HEADER_BYTES {
            return Err(ProtocolError::TooLarge);
        }
        let nonce_start = 8 + header_len;
        let body_start = nonce_start + NONCE_BYTES;
        if wire.len() < body_start + TAG_BYTES {
            return Err(ProtocolError::InvalidFrame);
        }
        Self::from_parts(
            &wire[8..nonce_start],
            wire[nonce_start..body_start]
                .try_into()
                .map_err(|_| ProtocolError::InvalidFrame)?,
            &wire[body_start..],
        )
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut wire =
            Vec::with_capacity(8 + self.header_bytes.len() + NONCE_BYTES + self.ciphertext.len());
        wire.extend_from_slice(MAGIC);
        wire.extend_from_slice(&(self.header_bytes.len() as u32).to_be_bytes());
        wire.extend_from_slice(&self.header_bytes);
        wire.extend_from_slice(&self.nonce);
        wire.extend_from_slice(&self.ciphertext);
        wire
    }
    pub fn header(&self) -> &Header {
        &self.header
    }
    pub fn header_bytes(&self) -> &[u8] {
        &self.header_bytes
    }
    pub fn nonce(&self) -> &[u8; NONCE_BYTES] {
        &self.nonce
    }
    pub fn ciphertext(&self) -> &[u8] {
        &self.ciphertext
    }
    /// Exact immutable retransmission; not a cryptographic authenticity check.
    pub fn check_retry(&self, candidate: &Self) -> Result<()> {
        if self.header.realm_id() != candidate.header.realm_id()
            || self.header.vault_id() != candidate.header.vault_id()
            || self.header.update_id() != candidate.header.update_id()
        {
            return Err(ProtocolError::ContextMismatch);
        }
        if self != candidate {
            return Err(ProtocolError::IdempotencyConflict);
        }
        Ok(())
    }
}
