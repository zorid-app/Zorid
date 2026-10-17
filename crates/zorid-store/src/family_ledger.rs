//! One envelope identity/receipt authority for every sync family.
//!
//! All functions are crate-private transaction primitives. They deliberately do
//! not authenticate plaintext, advance domain state or commit a transaction.
//! The family dispatcher must do those together in its IMMEDIATE transaction.
use super::*;
use zorid_client_sync::ReceiveCursor;
use zorid_file_sync::Sha256Digest;
use zorid_sync_protocol::{Envelope, RealmId, UpdateId, VaultId};

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("sync_envelopes", "CREATE TABLE sync_envelopes (realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, update_id TEXT NOT NULL, metadata TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('authored','received')), wire BLOB NOT NULL, PRIMARY KEY(realm_id,vault_id,update_id))"),
    ("authored_envelopes", "CREATE TABLE authored_envelopes (realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, update_id TEXT NOT NULL, metadata TEXT NOT NULL, payload BLOB NOT NULL, sealed BLOB, accepted INTEGER NOT NULL CHECK(accepted IN (0,1)), PRIMARY KEY(realm_id,vault_id,update_id))"),
    ("family_prerequisites", "CREATE TABLE family_prerequisites (realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, update_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(realm_id,vault_id,update_id), FOREIGN KEY(realm_id,vault_id,update_id) REFERENCES sync_envelopes(realm_id,vault_id,update_id))"),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EnvelopeKey {
    pub realm_id: RealmId,
    pub vault_id: VaultId,
    pub update_id: UpdateId,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Family {
    Text,
    Files,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TextBinding {
    pub entry_id: EntryId,
    pub text_bootstrap_id: UpdateId,
    pub namespace: zorid_client_sync::v2::TextNamespaceContext,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EnvelopeMetadata {
    pub key: EnvelopeKey,
    pub family: Family,
    pub format_version: u32,
    pub payload_digest: Sha256Digest,
    pub payload_bytes: u32,
    /// Commitment to the typed descriptor derived from the exact accepted file
    /// plaintext. Text envelopes have no file descriptor.
    pub file_summary_digest: Option<Sha256Digest>,
    // File batches/chunks/pages need not name a single entry. A text binding is
    // logical identity only; no entries FK may prevent pre-bootstrap staging.
    pub text_binding: Option<TextBinding>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Direction {
    Authored,
    Received,
}
impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Authored => "authored",
            Self::Received => "received",
        }
    }
    fn decode(value: &str) -> Result<Self> {
        match value {
            "authored" => Ok(Self::Authored),
            "received" => Ok(Self::Received),
            _ => Err(corrupt("invalid envelope direction")),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WireRecord {
    pub metadata: EnvelopeMetadata,
    pub direction: Direction,
    pub exact_wire: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AuthoredRecord {
    pub metadata: EnvelopeMetadata,
    pub payload: Vec<u8>,
    pub sealed: Option<Vec<u8>>,
    pub accepted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Prerequisite {
    NamespaceBootstrap { id: UpdateId },
    NamespaceParent { id: UpdateId },
    BinaryPage { id: UpdateId },
    BinaryChunk { id: UpdateId },
}

fn corrupt(message: &str) -> StoreError {
    StoreError::Corrupt(message.into())
}
fn mismatch() -> StoreError {
    zorid_client_sync::SyncError::DedupeMismatch.into()
}
impl EnvelopeMetadata {
    fn validate(&self) -> Result<()> {
        if self.format_version != 2
            || self.payload_bytes == 0
            || self.payload_bytes as usize > zorid_sync_protocol::MAX_PLAINTEXT_BYTES
            || (self.family == Family::Text) != self.text_binding.is_some()
            || (self.family == Family::Files) != self.file_summary_digest.is_some()
        {
            return Err(corrupt("invalid envelope family metadata"));
        }
        if let Some(binding) = &self.text_binding {
            let parents = &binding.namespace.parents;
            if parents.is_empty()
                || parents.len() > zorid_file_sync::MAX_PARENTS
                || parents.windows(2).any(|p| p[0] >= p[1])
                || parents.contains(&self.key.update_id)
                || binding.namespace.bootstrap_id == self.key.update_id
                || binding.text_bootstrap_id == self.key.update_id
            {
                return Err(corrupt("invalid text activity context provenance"));
            }
        }
        Ok(())
    }
    pub(super) fn check_payload(&self, payload: &[u8]) -> Result<()> {
        self.validate()?;
        if self.payload_bytes as usize != payload.len()
            || self.payload_digest != Sha256Digest::of(payload)
        {
            return Err(corrupt("envelope payload/provenance mismatch"));
        }
        if self.family == Family::Files {
            let (scope, id, record) =
                zorid_file_sync::metadata::GraphRecord::from_authored_exact(payload)
                    .map_err(|_| corrupt("invalid file descriptor source plaintext"))?;
            if scope.realm_id != self.key.realm_id
                || scope.vault_id != self.key.vault_id
                || id != self.key.update_id
                || Some(record.summary_digest()?) != self.file_summary_digest
            {
                return Err(corrupt(
                    "file summary differs from exact envelope plaintext",
                ));
            }
        }
        Ok(())
    }
    fn check_key(&self, key: &EnvelopeKey) -> Result<()> {
        self.validate()?;
        if self.key != *key {
            return Err(corrupt("envelope SQL/record identity mismatch"));
        }
        Ok(())
    }
    fn check_wire(&self, bytes: &[u8]) -> Result<()> {
        self.validate()?;
        let envelope = Envelope::decode(bytes)?;
        let header = envelope.header();
        if header.realm_id() != &self.key.realm_id
            || header.vault_id() != &self.key.vault_id
            || header.update_id() != &self.key.update_id
        {
            return Err(corrupt("envelope wire/metadata identity mismatch"));
        }
        Ok(())
    }
}

/// Descriptor/status reads must not select retained payload/wire BLOBs. This
/// head validates identities, bounded lengths and ownership; a body is checked
/// again by the separate one-record accessor when it is actually consumed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MetadataRecord {
    pub metadata: EnvelopeMetadata,
    pub direction: Direction,
    pub sealed: bool,
    pub accepted: bool,
}
pub(super) fn metadata_only(tx: &Connection, key: &EnvelopeKey) -> Result<Option<MetadataRecord>> {
    let oversized: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3 AND length(CAST(metadata AS BLOB)) NOT BETWEEN 1 AND 1048576 UNION ALL SELECT 1 FROM sync_envelopes WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3 AND length(CAST(metadata AS BLOB)) NOT BETWEEN 1 AND 1048576)",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()], |r| r.get(0))?;
    if oversized {
        return Err(corrupt("envelope metadata head bound exceeded"));
    }
    let authored:Option<(String,i64,i64,i64,Option<i64>)>=tx.query_row(
        "SELECT metadata,sealed IS NOT NULL,accepted,length(payload),length(sealed) FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let wire:Option<(String,String,i64)>=tx.query_row(
        "SELECT metadata,direction,length(wire) FROM sync_envelopes WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let authored = authored
        .map(|(raw, sealed, accepted, len, sealed_len)| -> Result<_> {
            let metadata: EnvelopeMetadata = serde_json::from_str(&raw)?;
            metadata.check_key(key)?;
            if len != i64::from(metadata.payload_bytes)
                || !matches!(sealed, 0 | 1)
                || !matches!(accepted, 0 | 1)
                || accepted == 1 && sealed == 0
                || sealed_len
                    .is_some_and(|len| len <= 0 || len > zorid_sync_protocol::MAX_WIRE_BYTES as i64)
            {
                return Err(corrupt("invalid authored metadata head"));
            }
            Ok((metadata, sealed == 1, accepted == 1))
        })
        .transpose()?;
    let wire = wire
        .map(|(raw, direction, len)| -> Result<_> {
            let metadata: EnvelopeMetadata = serde_json::from_str(&raw)?;
            metadata.check_key(key)?;
            if len <= 0 || len > zorid_sync_protocol::MAX_WIRE_BYTES as i64 {
                return Err(corrupt("invalid wire metadata head"));
            }
            Ok((metadata, Direction::decode(&direction)?))
        })
        .transpose()?;
    match (authored, wire) {
        (None, None) => Ok(None),
        (Some((metadata, false, false)), None) => Ok(Some(MetadataRecord {
            metadata,
            direction: Direction::Authored,
            sealed: false,
            accepted: false,
        })),
        (Some(_), None) => Err(corrupt("sealed authored head lacks wire ledger")),
        (None, Some((metadata, Direction::Received))) => Ok(Some(MetadataRecord {
            metadata,
            direction: Direction::Received,
            sealed: true,
            accepted: false,
        })),
        (None, Some((_, Direction::Authored))) => {
            Err(corrupt("authored wire head lacks authored intent"))
        }
        (Some((metadata, sealed, accepted)), Some((wire, direction))) => {
            // SQLite compares one bounded pair; neither body enters a Rust
            // metadata collection or a whole-history payload allocation.
            let same:bool=tx.query_row("SELECT coalesce(a.sealed=w.wire,0) FROM authored_envelopes a JOIN sync_envelopes w USING(realm_id,vault_id,update_id) WHERE a.realm_id=?1 AND a.vault_id=?2 AND a.update_id=?3",params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],|r|r.get(0))?;
            if !sealed || direction != Direction::Authored || metadata != wire || !same {
                return Err(corrupt("authored head differs from immutable wire ledger"));
            }
            Ok(Some(MetadataRecord {
                metadata,
                direction,
                sealed,
                accepted,
            }))
        }
    }
}

pub(super) fn wire(tx: &Connection, key: &EnvelopeKey) -> Result<Option<WireRecord>> {
    tx.query_row("SELECT metadata,direction,wire FROM sync_envelopes WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],
        |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Vec<u8>>(2)?)))
        .optional()?.map(|(metadata,direction,exact_wire)| {
            let metadata:EnvelopeMetadata=serde_json::from_str(&metadata)?;
            metadata.check_key(key)?;
            metadata.check_wire(&exact_wire)?;
            Ok(WireRecord { metadata, direction:Direction::decode(&direction)?, exact_wire })
        }).transpose()
}

fn authored_raw(tx: &Connection, key: &EnvelopeKey) -> Result<Option<AuthoredRecord>> {
    tx.query_row("SELECT metadata,payload,sealed,accepted FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],
        |r| Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?,r.get::<_,Option<Vec<u8>>>(2)?,r.get::<_,i64>(3)?)))
        .optional()?.map(|(metadata,payload,sealed,accepted)| {
            let metadata:EnvelopeMetadata=serde_json::from_str(&metadata)?;
            metadata.check_key(key)?;
            metadata.check_payload(&payload)?;
            if payload.len() > zorid_sync_protocol::MAX_PLAINTEXT_BYTES || !matches!(accepted,0|1)
                || accepted == 1 && sealed.is_none()
            { return Err(corrupt("invalid authored envelope body/outcome")); }
            if let Some(bytes)=&sealed { metadata.check_wire(bytes)?; }
            Ok(AuthoredRecord { metadata,payload,sealed,accepted:accepted==1 })
        }).transpose()
}

pub(super) fn authored(tx: &Connection, key: &EnvelopeKey) -> Result<Option<AuthoredRecord>> {
    let record = authored_raw(tx, key)?;
    match (&record, wire(tx, key)?) {
        (Some(record), Some(wire)) => {
            if record.sealed.as_ref() != Some(&wire.exact_wire)
                || wire.metadata != record.metadata
                || wire.direction != Direction::Authored
            {
                return Err(corrupt(
                    "authored envelope disagrees with global wire ledger",
                ));
            }
        }
        (Some(record), None) if record.sealed.is_some() => {
            return Err(corrupt("sealed authored envelope lacks ledger"))
        }
        (None, Some(wire)) if wire.direction == Direction::Authored => {
            return Err(corrupt("authored envelope head is missing"))
        }
        _ => {}
    }
    Ok(record)
}

pub(super) fn unused(tx: &Connection, key: &EnvelopeKey) -> Result<bool> {
    // Validate retained ownership before returning a boolean; a deleted authored
    // head must not make its already sealed operation identity reusable.
    Ok(metadata_only(tx, key)?.is_none() && !super::blob_stage::update_reserved(tx, key)?)
}

pub(super) fn insert_authored(
    tx: &Connection,
    metadata: &EnvelopeMetadata,
    payload: &[u8],
) -> Result<()> {
    metadata.check_payload(payload)?;
    if payload.len() > zorid_sync_protocol::MAX_PLAINTEXT_BYTES {
        return Err(zorid_client_sync::SyncError::TooLarge.into());
    }
    if !unused(tx, &metadata.key)? {
        return Err(mismatch());
    }
    tx.execute("INSERT INTO authored_envelopes(realm_id,vault_id,update_id,metadata,payload,accepted) VALUES(?1,?2,?3,?4,?5,0)",
        params![metadata.key.realm_id.as_str(),metadata.key.vault_id.as_str(),metadata.key.update_id.as_str(),serde_json::to_string(metadata)?,payload])?;
    Ok(())
}

/// Returns false for an exact already-durable receipt, including a self echo.
/// Caller still applies the trusted delivery cursor CAS in the same transaction.
pub(super) fn insert_received(
    tx: &Connection,
    metadata: &EnvelopeMetadata,
    exact_wire: &[u8],
) -> Result<bool> {
    metadata.check_wire(exact_wire)?;
    if super::blob_stage::update_reserved(tx, &metadata.key)? {
        return Err(mismatch());
    }
    if let Some(existing) = wire(tx, &metadata.key)? {
        if existing.metadata != *metadata || existing.exact_wire != exact_wire {
            return Err(mismatch());
        }
        // Validate ownership for both directions: a received row coexisting
        // with an authored intent is observable corruption, not a quiet replay.
        authored(tx, &metadata.key)?;
        return Ok(false);
    }
    if authored_raw(tx, &metadata.key)?.is_some() {
        return Err(mismatch());
    }
    insert_wire(tx, metadata, Direction::Received, exact_wire)?;
    Ok(true)
}
fn insert_wire(
    tx: &Connection,
    metadata: &EnvelopeMetadata,
    direction: Direction,
    exact_wire: &[u8],
) -> Result<()> {
    metadata.check_wire(exact_wire)?;
    tx.execute("INSERT INTO sync_envelopes(realm_id,vault_id,update_id,metadata,direction,wire) VALUES(?1,?2,?3,?4,?5,?6)",
        params![metadata.key.realm_id.as_str(),metadata.key.vault_id.as_str(),metadata.key.update_id.as_str(),serde_json::to_string(metadata)?,direction.as_str(),exact_wire])?;
    Ok(())
}

/// Compare immutable plaintext/metadata, then persist one winning candidate.
/// The dispatcher must authenticate the candidate and compare its plaintext,
/// family and binding to the immutable expected payload before this call. It
/// must check the returned canonical wire against its current ExpectedContext
/// (including key epoch), even when a racing winner was already sealed.
/// A losing caller may upload only the returned canonical wire.
pub(super) fn install_sealed(
    tx: &Connection,
    expected: &AuthoredRecord,
    candidate: &[u8],
) -> Result<Vec<u8>> {
    let key = &expected.metadata.key;
    let actual = authored(tx, key)?.ok_or_else(|| corrupt("authored envelope disappeared"))?;
    if actual.metadata != expected.metadata || actual.payload != expected.payload {
        return Err(corrupt("immutable authored envelope changed"));
    }
    if let Some(wire) = actual.sealed {
        return Ok(wire);
    }
    actual.metadata.check_wire(candidate)?;
    if wire(tx, key)?.is_some() {
        return Err(mismatch());
    }
    insert_wire(tx, &actual.metadata, Direction::Authored, candidate)?;
    tx.execute("UPDATE authored_envelopes SET sealed=?1 WHERE realm_id=?2 AND vault_id=?3 AND update_id=?4",
        params![candidate,key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()])?;
    Ok(candidate.to_vec())
}

pub(super) fn acknowledge(tx: &Connection, key: &EnvelopeKey, exact_wire: &[u8]) -> Result<()> {
    let record =
        authored(tx, key)?.ok_or_else(|| corrupt("acknowledgment lacks authored envelope"))?;
    if record.sealed.as_deref() != Some(exact_wire) {
        return Err(mismatch());
    }
    tx.execute("UPDATE authored_envelopes SET accepted=1 WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()])?;
    Ok(())
}

pub(super) fn prerequisites(tx: &Connection, key: &EnvelopeKey) -> Result<Vec<Prerequisite>> {
    let json:Option<String>=tx.query_row("SELECT record FROM family_prerequisites WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],|r|r.get(0)).optional()?;
    let Some(json) = json else {
        return Ok(vec![]);
    };
    if wire(tx, key)?.is_none() {
        return Err(corrupt("prerequisite has no durable exact wire"));
    }
    let values: Vec<Prerequisite> = serde_json::from_str(&json)?;
    validate_prerequisites(&values)?;
    if values.is_empty() {
        return Err(corrupt("empty persisted prerequisite set"));
    }
    Ok(values)
}
fn validate_prerequisites(values: &[Prerequisite]) -> Result<()> {
    if values.len() > 4096 || values.windows(2).any(|v| v[0] >= v[1]) {
        return Err(corrupt("noncanonical or oversized prerequisite set"));
    }
    Ok(())
}
pub(super) fn replace_prerequisites(
    tx: &Connection,
    key: &EnvelopeKey,
    values: &[Prerequisite],
) -> Result<()> {
    validate_prerequisites(values)?;
    if wire(tx, key)?.is_none() {
        return Err(corrupt("cannot stage prerequisites without exact wire"));
    }
    // Verify old metadata before replacing it rather than silently repairing a
    // malformed pending obligation during unrelated dependency delivery.
    prerequisites(tx, key)?;
    if values.is_empty() {
        tx.execute(
            "DELETE FROM family_prerequisites WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
            params![
                key.realm_id.as_str(),
                key.vault_id.as_str(),
                key.update_id.as_str()
            ],
        )?;
    } else {
        tx.execute("INSERT INTO family_prerequisites VALUES(?1,?2,?3,?4) ON CONFLICT(realm_id,vault_id,update_id) DO UPDATE SET record=excluded.record",
            params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str(),serde_json::to_string(values)?])?;
    }
    Ok(())
}

// Reuse the original scope-wide cursor table. Neither an upload acknowledgment
// nor family-local state is allowed to introduce a second cursor authority.
pub(super) fn cursor(
    tx: &Connection,
    realm: &RealmId,
    vault: &VaultId,
) -> Result<Option<ReceiveCursor>> {
    tx.query_row(
        "SELECT record FROM receive_cursors WHERE realm_id=?1 AND vault_id=?2",
        params![realm.as_str(), vault.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|json| {
        let cursor: ReceiveCursor = serde_json::from_str(&json)?;
        if &cursor.realm_id != realm || &cursor.vault_id != vault {
            return Err(corrupt("receive cursor scope mismatch"));
        }
        Ok(cursor)
    })
    .transpose()
}
/// CAS primitive shared by trusted delivery advancement and explicit epoch reset.
/// Callers enforce the appropriate ordered-page or reset policy before this call.
pub(super) fn compare_cursor(
    tx: &Connection,
    expected: Option<&ReceiveCursor>,
    next: &ReceiveCursor,
) -> Result<()> {
    if expected.is_some_and(|e| e.realm_id != next.realm_id || e.vault_id != next.vault_id)
        || cursor(tx, &next.realm_id, &next.vault_id)?.as_ref() != expected
    {
        return Err(zorid_client_sync::SyncError::CursorConflict.into());
    }
    tx.execute("INSERT INTO receive_cursors VALUES(?1,?2,?3) ON CONFLICT(realm_id,vault_id) DO UPDATE SET record=excluded.record",
        params![next.realm_id.as_str(),next.vault_id.as_str(),serde_json::to_string(next)?])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_sync_protocol::{DeviceId, Header, LogPosition, ServerEpoch};

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        for (_, sql) in SCHEMA.iter().chain(super::super::blob_stage::SCHEMA) {
            db.execute_batch(sql).unwrap();
        }
        db.execute_batch("CREATE TABLE receive_cursors (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(realm_id,vault_id))").unwrap();
        db
    }
    fn metadata(id: &str) -> EnvelopeMetadata {
        EnvelopeMetadata {
            key: EnvelopeKey {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
                update_id: UpdateId::new(id).unwrap(),
            },
            family: Family::Text,
            format_version: 2,
            payload_digest: Sha256Digest::of(b"{}"),
            payload_bytes: 2,
            file_summary_digest: None,
            text_binding: Some(TextBinding {
                entry_id: EntryId::new("entry").unwrap(),
                text_bootstrap_id: UpdateId::new("text_bootstrap").unwrap(),
                namespace: zorid_client_sync::v2::TextNamespaceContext {
                    bootstrap_id: UpdateId::new("namespace").unwrap(),
                    parents: vec![UpdateId::new("namespace").unwrap()],
                },
            }),
        }
    }
    // These fixtures test the database primitives only. Authentication is the
    // dispatcher's prerequisite; a framed envelope is intentionally sufficient
    // here, and is never claimed to be an authenticated input capability.
    fn framed(meta: &EnvelopeMetadata, nonce: u8) -> Vec<u8> {
        let key = &meta.key;
        let header = Header::new(
            key.realm_id.clone(),
            key.vault_id.clone(),
            key.update_id.clone(),
            DeviceId::new("device").unwrap(),
            1,
        )
        .unwrap();
        Envelope::from_parts(&header.encode().unwrap(), [nonce; 24], &[0; 16])
            .unwrap()
            .encode()
    }
    fn position(meta: &EnvelopeMetadata, after: u64) -> ReceiveCursor {
        ReceiveCursor {
            realm_id: meta.key.realm_id.clone(),
            vault_id: meta.key.vault_id.clone(),
            server_epoch: ServerEpoch::new("epoch").unwrap(),
            after: LogPosition::new(after),
        }
    }

    #[test]
    fn received_global_identity_rejects_cross_family_and_changed_wire() {
        let mut db = db();
        let m = metadata("one");
        let bytes = framed(&m, 1);
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(insert_received(&tx, &m, &bytes).unwrap());
        assert!(!insert_received(&tx, &m, &bytes).unwrap());
        assert!(insert_received(&tx, &m, &framed(&m, 2)).is_err());
        let mut other = m.clone();
        other.family = Family::Files;
        other.text_binding = None;
        assert!(insert_received(&tx, &other, &bytes).is_err());
        assert!(insert_authored(&tx, &m, b"{}").is_err());
        tx.commit().unwrap();
        assert_eq!(wire(&db, &m.key).unwrap().unwrap().exact_wire, bytes);
    }
    #[test]
    fn sealed_race_returns_one_wire_self_echo_is_quiet_and_ack_retains_history() {
        let mut db = db();
        let m = metadata("one");
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        insert_authored(&tx, &m, b"{}").unwrap();
        tx.commit().unwrap();
        let expected = authored(&db, &m.key).unwrap().unwrap();
        let first = framed(&m, 1);
        let loser = framed(&m, 2);
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert_eq!(install_sealed(&tx, &expected, &first).unwrap(), first);
        tx.commit().unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert_eq!(install_sealed(&tx, &expected, &loser).unwrap(), first);
        assert!(!insert_received(&tx, &m, &first).unwrap());
        assert!(acknowledge(&tx, &m.key, &loser).is_err());
        acknowledge(&tx, &m.key, &first).unwrap();
        tx.commit().unwrap();
        assert!(authored(&db, &m.key).unwrap().unwrap().accepted);
        assert_eq!(wire(&db, &m.key).unwrap().unwrap().exact_wire, first);
        assert!(!unused(&db, &m.key).unwrap());
    }
    #[test]
    fn exact_received_replay_fails_closed_on_conflicting_authored_ownership() {
        let db = db();
        let m = metadata("one");
        let bytes = framed(&m, 1);
        insert_received(&db, &m, &bytes).unwrap();
        // Deliberate corruption bypassing the private insertion fence.
        db.execute(
            "INSERT INTO authored_envelopes VALUES(?1,?2,?3,?4,?5,NULL,0)",
            params![
                m.key.realm_id.as_str(),
                m.key.vault_id.as_str(),
                m.key.update_id.as_str(),
                serde_json::to_string(&m).unwrap(),
                b"{}".as_slice()
            ],
        )
        .unwrap();
        assert!(matches!(
            insert_received(&db, &m, &bytes),
            Err(StoreError::Corrupt(_))
        ));
        assert!(cursor(&db, &m.key.realm_id, &m.key.vault_id)
            .unwrap()
            .is_none());
    }
    #[test]
    fn cursor_failure_rolls_back_wire_and_prerequisite_atomically() {
        let mut db = db();
        let m = metadata("one");
        let next = position(&m, 1);
        db.execute_batch("CREATE TRIGGER fail_cursor BEFORE INSERT ON receive_cursors BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            insert_received(&tx, &m, &framed(&m, 1)).unwrap();
            replace_prerequisites(
                &tx,
                &m.key,
                &[Prerequisite::NamespaceBootstrap {
                    id: UpdateId::new("namespace").unwrap(),
                }],
            )
            .unwrap();
            assert!(compare_cursor(&tx, None, &next).is_err());
            // No caller commit after any failed transaction stage.
        }
        assert!(wire(&db, &m.key).unwrap().is_none());
        assert!(prerequisites(&db, &m.key).unwrap().is_empty());
        assert!(cursor(&db, &m.key.realm_id, &m.key.vault_id)
            .unwrap()
            .is_none());
        db.execute_batch("DROP TRIGGER fail_cursor").unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        insert_received(&tx, &m, &framed(&m, 1)).unwrap();
        replace_prerequisites(
            &tx,
            &m.key,
            &[Prerequisite::NamespaceBootstrap {
                id: UpdateId::new("namespace").unwrap(),
            }],
        )
        .unwrap();
        compare_cursor(&tx, None, &next).unwrap();
        tx.commit().unwrap();
        assert_eq!(prerequisites(&db, &m.key).unwrap().len(), 1);
        assert_eq!(
            cursor(&db, &m.key.realm_id, &m.key.vault_id).unwrap(),
            Some(next)
        );
    }
    #[test]
    fn pending_requires_wire_and_canonical_dependencies_and_detects_metadata_corruption() {
        let db = db();
        let m = metadata("one");
        let pending = Prerequisite::BinaryChunk {
            id: UpdateId::new("chunk").unwrap(),
        };
        assert!(replace_prerequisites(&db, &m.key, &[pending.clone()]).is_err());
        insert_received(&db, &m, &framed(&m, 1)).unwrap();
        assert!(replace_prerequisites(&db, &m.key, &[pending.clone(), pending]).is_err());
        db.execute(
            "UPDATE sync_envelopes SET metadata=?1",
            [serde_json::to_string(&metadata("different")).unwrap()],
        )
        .unwrap();
        assert!(matches!(wire(&db, &m.key), Err(StoreError::Corrupt(_))));
    }
    #[test]
    fn old_format_is_not_reinterpreted_as_current_metadata() {
        let db = db();
        let mut m = metadata("one");
        m.format_version = 1;
        assert!(insert_received(&db, &m, &framed(&m, 1)).is_err());
        let count: i64 = db
            .query_row("SELECT count(*) FROM sync_envelopes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
