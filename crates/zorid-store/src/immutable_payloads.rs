//! One immutable exact plaintext source shared by stages, authorship and graph
//! references. These rows are not authentication or publication capabilities.
//! Callers bind their independent stage/ledger metadata and own the enclosing
//! IMMEDIATE transaction, including quota checks and all reference mutations.
use super::family_ledger::{EnvelopeKey, EnvelopeMetadata, Family};
use super::{Result, StoreError};
use rusqlite::{params, Connection, OptionalExtension};
use zorid_file_sync::{
    metadata::{GraphRecord, MAX_GRAPH_RECORD_BYTES},
    Sha256Digest,
};

const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_DIGEST_JSON_BYTES: usize = 256;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("immutable_payloads", "CREATE TABLE immutable_payloads (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,update_id TEXT NOT NULL,family TEXT NOT NULL CHECK(family IN ('files','text')),payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 1048576),payload_digest TEXT NOT NULL,file_summary_digest TEXT,descriptor TEXT,payload BLOB NOT NULL CHECK(length(payload)=payload_bytes),CHECK((family='files' AND file_summary_digest IS NOT NULL AND descriptor IS NOT NULL) OR (family='text' AND file_summary_digest IS NULL AND descriptor IS NULL)),PRIMARY KEY(realm_id,vault_id,update_id))"),
    ("immutable_payloads_insert_only", "CREATE TRIGGER immutable_payloads_insert_only BEFORE INSERT ON immutable_payloads WHEN EXISTS(SELECT 1 FROM immutable_payloads WHERE realm_id=NEW.realm_id AND vault_id=NEW.vault_id AND update_id=NEW.update_id) BEGIN SELECT RAISE(ABORT,'immutable payload key is already retained'); END"),
    ("immutable_payloads_no_update", "CREATE TRIGGER immutable_payloads_no_update BEFORE UPDATE ON immutable_payloads BEGIN SELECT RAISE(ABORT,'immutable payload rows cannot be updated'); END"),
    ("immutable_payloads_no_delete", "CREATE TRIGGER immutable_payloads_no_delete BEFORE DELETE ON immutable_payloads BEGIN SELECT RAISE(ABORT,'immutable payload rows cannot be deleted'); END"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PayloadHead {
    pub family: Family,
    pub payload_bytes: u32,
    pub payload_digest: Sha256Digest,
    pub file_summary_digest: Option<Sha256Digest>,
    pub descriptor: Option<String>,
}

fn corrupt(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}
fn mismatch() -> StoreError {
    zorid_client_sync::SyncError::DedupeMismatch.into()
}
fn family_name(family: Family) -> &'static str {
    match family {
        Family::Files => "files",
        Family::Text => "text",
    }
}

/// Inspect lengths in SQLite before loading any persisted string or body.
/// The descriptor is internally checked but still needs independent authority.
pub(super) fn head(tx: &Connection, key: &EnvelopeKey) -> Result<Option<PayloadHead>> {
    let descriptor_bound = i64::try_from(MAX_GRAPH_RECORD_BYTES)
        .map_err(|_| corrupt("portable descriptor bound exceeds SQLite integer range"))?;
    let bounded: Option<bool> = tx.query_row(
        "SELECT family IN ('files','text') AND payload_bytes BETWEEN 1 AND 1048576 AND length(payload)=payload_bytes AND length(CAST(payload_digest AS BLOB)) BETWEEN 1 AND 256 AND ((family='files' AND file_summary_digest IS NOT NULL AND length(CAST(file_summary_digest AS BLOB)) BETWEEN 1 AND 256 AND descriptor IS NOT NULL AND length(CAST(descriptor AS BLOB)) BETWEEN 1 AND ?4) OR (family='text' AND file_summary_digest IS NULL AND descriptor IS NULL)) FROM immutable_payloads WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str(),descriptor_bound], |r|r.get(0),
    ).optional()?;
    match bounded {
        None => return Ok(None),
        Some(false) => return Err(corrupt("immutable payload metadata/body bound mismatch")),
        Some(true) => {}
    }
    let (family, bytes, digest, summary, descriptor):(String,i64,String,Option<String>,Option<String>) = tx.query_row(
        "SELECT family,payload_bytes,payload_digest,file_summary_digest,descriptor FROM immutable_payloads WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    )?;
    let family = match family.as_str() {
        "files" => Family::Files,
        "text" => Family::Text,
        _ => return Err(corrupt("immutable payload family mismatch")),
    };
    let payload_bytes =
        u32::try_from(bytes).map_err(|_| corrupt("immutable payload byte count is invalid"))?;
    let payload_digest = serde_json::from_str(&digest)
        .map_err(|_| corrupt("immutable payload digest is invalid"))?;
    let file_summary_digest = summary
        .map(|s| {
            serde_json::from_str(&s)
                .map_err(|_| corrupt("immutable payload summary digest is invalid"))
        })
        .transpose()?;
    if let (Some(raw), Some(summary)) = (&descriptor, file_summary_digest) {
        GraphRecord::from_persisted_json(raw, payload_bytes, payload_digest, summary)
            .map_err(|_| corrupt("immutable payload descriptor commitment mismatch"))?;
    }
    Ok(Some(PayloadHead {
        family,
        payload_bytes,
        payload_digest,
        file_summary_digest,
        descriptor,
    }))
}

fn checked_descriptor(metadata: &EnvelopeMetadata, exact: &[u8]) -> Result<Option<String>> {
    if exact.is_empty() || exact.len() > MAX_PAYLOAD_BYTES {
        return Err(corrupt("immutable payload body exceeds bound"));
    }
    metadata.check_payload(exact)?;
    if metadata.family == Family::Text {
        return Ok(None);
    }
    let (scope, id, record) = GraphRecord::from_authored_exact(exact)
        .map_err(|_| corrupt("immutable file payload failed strict decoding"))?;
    if scope.realm_id != metadata.key.realm_id
        || scope.vault_id != metadata.key.vault_id
        || id != metadata.key.update_id
        || Some(record.summary_digest()?) != metadata.file_summary_digest
    {
        return Err(corrupt("immutable file payload identity/summary mismatch"));
    }
    let descriptor = serde_json::to_string(&record)?;
    if descriptor.len() > MAX_GRAPH_RECORD_BYTES {
        return Err(corrupt("immutable file descriptor exceeds bound"));
    }
    Ok(Some(descriptor))
}

fn matches(head: &PayloadHead, metadata: &EnvelopeMetadata) -> bool {
    head.family == metadata.family
        && head.payload_bytes == metadata.payload_bytes
        && head.payload_digest == metadata.payload_digest
        && head.file_summary_digest == metadata.file_summary_digest
}

/// Retain one exact accepted spelling. A same-key retry never rewrites rows or
/// consumes extra quota. Caller must serialize this with its other mutations.
pub(super) fn put_exact(
    tx: &Connection,
    metadata: &EnvelopeMetadata,
    exact: &[u8],
    max_total_bytes: u64,
) -> Result<()> {
    if max_total_bytes == 0 || max_total_bytes > i64::MAX as u64 {
        return Err(corrupt(
            "immutable payload quota must be finite and positive",
        ));
    }
    let descriptor = checked_descriptor(metadata, exact)?;
    if let Some(prior) = head(tx, &metadata.key)? {
        if !matches(&prior, metadata) || prior.descriptor != descriptor {
            return Err(mismatch());
        }
        let retained = read_exact(tx, metadata)?;
        if retained != exact {
            return Err(mismatch());
        }
        return Ok(());
    }
    if total_bytes(tx)?
        .checked_add(exact.len() as u64)
        .is_none_or(|n| n > max_total_bytes)
    {
        return Err(zorid_file_sync::Error::TooLarge.into());
    }
    let digest = serde_json::to_string(&metadata.payload_digest)?;
    let summary = metadata
        .file_summary_digest
        .map(|d| serde_json::to_string(&d))
        .transpose()?;
    if digest.len() > MAX_DIGEST_JSON_BYTES
        || summary
            .as_ref()
            .is_some_and(|s| s.len() > MAX_DIGEST_JSON_BYTES)
    {
        return Err(corrupt("immutable payload digest encoding exceeds bound"));
    }
    tx.execute(
        "INSERT INTO immutable_payloads VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            metadata.key.realm_id.as_str(),
            metadata.key.vault_id.as_str(),
            metadata.key.update_id.as_str(),
            family_name(metadata.family),
            i64::from(metadata.payload_bytes),
            digest,
            summary,
            descriptor,
            exact
        ],
    )?;
    Ok(())
}

/// Resolve only against independently supplied ledger/stage metadata. Missing
/// backing bytes are corruption; this never reports another missing download.
pub(super) fn read_exact(tx: &Connection, metadata: &EnvelopeMetadata) -> Result<Vec<u8>> {
    if metadata.payload_bytes == 0 || metadata.payload_bytes as usize > MAX_PAYLOAD_BYTES {
        return Err(corrupt(
            "immutable payload expected byte count exceeds bound",
        ));
    }
    let stored = head(tx, &metadata.key)?
        .ok_or_else(|| corrupt("immutable payload backing row is missing"))?;
    if !matches(&stored, metadata) {
        return Err(corrupt(
            "immutable payload head differs from independent authority",
        ));
    }
    let exact: Vec<u8> = tx.query_row(
        "SELECT payload FROM immutable_payloads WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",
        params![
            metadata.key.realm_id.as_str(),
            metadata.key.vault_id.as_str(),
            metadata.key.update_id.as_str()
        ],
        |r| r.get(0),
    )?;
    if checked_descriptor(metadata, &exact)? != stored.descriptor {
        return Err(corrupt(
            "immutable payload exact bytes differ from descriptor",
        ));
    }
    Ok(exact)
}

/// Counts all retained sources, including rows referenced only by aborted stages.
/// There is deliberately no deletion, reclamation or default quota here.
pub(super) fn total_bytes(tx: &Connection) -> Result<u64> {
    let total: i64 = tx.query_row(
        "SELECT coalesce(sum(length(payload)),0) FROM immutable_payloads",
        [],
        |r| r.get(0),
    )?;
    u64::try_from(total).map_err(|_| corrupt("immutable payload byte total is negative"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_file_sync::{v2, Scope};
    use zorid_sync_protocol::{RealmId, UpdateId, VaultId};

    const QUOTA: u64 = 8 * 1024 * 1024;
    fn db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        for (_, sql) in SCHEMA {
            connection.execute_batch(sql).unwrap();
        }
        connection
    }
    fn file(id: &str, bytes: &[u8]) -> (EnvelopeMetadata, Vec<u8>) {
        let raw = v2::Payload {
            family: zorid_file_sync::Family::Files,
            format_version: v2::FORMAT_VERSION,
            scope: Scope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            },
            id: UpdateId::new(id).unwrap(),
            body: v2::Body::Chunk {
                bytes: bytes.to_vec(),
            },
        }
        .encode()
        .unwrap();
        (file_metadata(&raw), raw)
    }
    fn file_metadata(raw: &[u8]) -> EnvelopeMetadata {
        let (scope, id, record) = GraphRecord::from_authored_exact(raw).unwrap();
        EnvelopeMetadata {
            key: EnvelopeKey {
                realm_id: scope.realm_id,
                vault_id: scope.vault_id,
                update_id: id,
            },
            family: Family::Files,
            format_version: 2,
            payload_bytes: raw.len() as u32,
            payload_digest: Sha256Digest::of(raw),
            file_summary_digest: Some(record.summary_digest().unwrap()),
            text_binding: None,
        }
    }

    #[test]
    fn exact_retry_uses_one_row_and_changed_same_key_is_rejected() {
        let tx = db();
        let (metadata, exact) = file("chunk", b"retained");
        put_exact(&tx, &metadata, &exact, QUOTA).unwrap();
        put_exact(&tx, &metadata, &exact, 1).unwrap();
        assert_eq!(total_bytes(&tx).unwrap(), exact.len() as u64);
        assert_eq!(read_exact(&tx, &metadata).unwrap(), exact);
        let (changed, bytes) = file("chunk", b"modified");
        assert!(put_exact(&tx, &changed, &bytes, QUOTA).is_err());
        assert!(tx
            .execute("UPDATE immutable_payloads SET payload=payload", [])
            .is_err());
        assert!(tx.execute("DELETE FROM immutable_payloads", []).is_err());
        assert!(tx
            .execute(
                "INSERT OR REPLACE INTO immutable_payloads SELECT * FROM immutable_payloads",
                []
            )
            .is_err());
        assert_eq!(read_exact(&tx, &metadata).unwrap(), exact);
        let count: i64 = tx
            .query_row("SELECT count(*) FROM immutable_payloads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn exact_whitespace_commitment_is_not_replaced_by_reencoding() {
        let tx = db();
        let (_, canonical) = file("chunk", b"accepted spelling");
        let parsed: serde_json::Value = serde_json::from_slice(&canonical).unwrap();
        let pretty = serde_json::to_vec_pretty(&parsed).unwrap();
        assert_ne!(pretty, canonical);
        let metadata = file_metadata(&pretty);
        put_exact(&tx, &metadata, &pretty, QUOTA).unwrap();
        let head = head(&tx, &metadata.key).unwrap().unwrap();
        assert_eq!(head.payload_bytes, pretty.len() as u32);
        assert_eq!(head.payload_digest, Sha256Digest::of(&pretty));
        assert_ne!(head.payload_digest, Sha256Digest::of(&canonical));
        assert_eq!(read_exact(&tx, &metadata).unwrap(), pretty);
        assert!(put_exact(&tx, &file_metadata(&canonical), &canonical, QUOTA).is_err());
    }

    #[test]
    fn missing_rows_and_changed_sources_are_corruption_not_pending() {
        let tx = db();
        let (metadata, exact) = file("chunk", b"original");
        assert!(head(&tx, &metadata.key).unwrap().is_none());
        assert!(matches!(
            read_exact(&tx, &metadata),
            Err(StoreError::Corrupt(_))
        ));
        put_exact(&tx, &metadata, &exact, QUOTA).unwrap();
        tx.execute_batch("DROP TRIGGER immutable_payloads_no_update")
            .unwrap();
        let (_, changed) = file("chunk", b"tampered");
        assert_eq!(exact.len(), changed.len());
        tx.execute("UPDATE immutable_payloads SET payload=?1", [changed])
            .unwrap();
        assert!(matches!(
            read_exact(&tx, &metadata),
            Err(StoreError::Corrupt(_))
        ));
        tx.execute("UPDATE immutable_payloads SET payload=?1", [exact])
            .unwrap();
        tx.execute("UPDATE immutable_payloads SET descriptor='{}'", [])
            .unwrap();
        assert!(matches!(
            head(&tx, &metadata.key),
            Err(StoreError::Corrupt(_))
        ));
    }

    #[test]
    fn payload_descriptor_and_quota_bounds_fail_without_inserting() {
        let tx = db();
        let (metadata, exact) = file("chunk", b"first");
        assert!(put_exact(&tx, &metadata, &exact, 0).is_err());
        assert!(put_exact(&tx, &metadata, &exact, u64::MAX).is_err());
        assert!(put_exact(&tx, &metadata, &exact, exact.len() as u64 - 1).is_err());
        assert_eq!(total_bytes(&tx).unwrap(), 0);
        put_exact(&tx, &metadata, &exact, exact.len() as u64).unwrap();
        let (second, body) = file("second", b"second");
        assert!(put_exact(&tx, &second, &body, exact.len() as u64).is_err());
        assert!(head(&tx, &second.key).unwrap().is_none());
        let mut oversized = second.clone();
        oversized.payload_bytes = MAX_PAYLOAD_BYTES as u32 + 1;
        assert!(read_exact(&tx, &oversized).is_err());
        assert!(put_exact(&tx, &oversized, &vec![0; MAX_PAYLOAD_BYTES + 1], QUOTA).is_err());
        // A corrupt persisted descriptor must fail preflight before allocation.
        tx.execute_batch("DROP TRIGGER immutable_payloads_no_update")
            .unwrap();
        tx.execute(
            "UPDATE immutable_payloads SET descriptor=?1",
            ["x".repeat(MAX_GRAPH_RECORD_BYTES + 1)],
        )
        .unwrap();
        assert!(matches!(
            head(&tx, &metadata.key),
            Err(StoreError::Corrupt(_))
        ));
        assert!(read_exact(&tx, &metadata).is_err());
        tx.execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        tx.execute(
            "UPDATE immutable_payloads SET descriptor='{}',payload=?1,payload_bytes=?2",
            params![
                vec![0; MAX_PAYLOAD_BYTES + 1],
                (MAX_PAYLOAD_BYTES + 1) as i64
            ],
        )
        .unwrap();
        assert!(matches!(
            head(&tx, &metadata.key),
            Err(StoreError::Corrupt(_))
        ));
        assert!(read_exact(&tx, &metadata).is_err());
    }

    #[test]
    fn file_scope_and_summary_must_match_independent_metadata() {
        let tx = db();
        let (metadata, exact) = file("chunk", b"data");
        let mut wrong_scope = metadata.clone();
        wrong_scope.key.vault_id = VaultId::new("wrong").unwrap();
        assert!(put_exact(&tx, &wrong_scope, &exact, QUOTA).is_err());
        let mut wrong_summary = metadata.clone();
        wrong_summary.file_summary_digest = Some(Sha256Digest::of(b"invented"));
        assert!(put_exact(&tx, &wrong_summary, &exact, QUOTA).is_err());
        assert_eq!(total_bytes(&tx).unwrap(), 0);
        put_exact(&tx, &metadata, &exact, QUOTA).unwrap();
        assert!(read_exact(&tx, &wrong_summary).is_err());
    }

    #[test]
    fn text_sources_keep_ledger_binding_without_a_file_descriptor() {
        use crate::family_ledger::TextBinding;
        let tx = db();
        // Text decoding/authentication belongs to the caller's existing family
        // ingestion path; this module retains its exact independently bound bytes.
        let exact = b"opaque text family plaintext";
        let metadata = EnvelopeMetadata {
            key: EnvelopeKey {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
                update_id: UpdateId::new("text-update").unwrap(),
            },
            family: Family::Text,
            format_version: 2,
            payload_bytes: exact.len() as u32,
            payload_digest: Sha256Digest::of(exact),
            file_summary_digest: None,
            text_binding: Some(TextBinding {
                entry_id: zorid_core::EntryId::new("entry").unwrap(),
                text_bootstrap_id: UpdateId::new("text-bootstrap").unwrap(),
                namespace: zorid_client_sync::v2::TextNamespaceContext {
                    bootstrap_id: UpdateId::new("namespace-bootstrap").unwrap(),
                    parents: vec![UpdateId::new("namespace-parent").unwrap()],
                },
            }),
        };
        put_exact(&tx, &metadata, exact, QUOTA).unwrap();
        put_exact(&tx, &metadata, exact, QUOTA).unwrap();
        let stored = head(&tx, &metadata.key).unwrap().unwrap();
        assert_eq!(stored.family, Family::Text);
        assert!(stored.file_summary_digest.is_none());
        assert!(stored.descriptor.is_none());
        assert_eq!(read_exact(&tx, &metadata).unwrap(), exact);
        assert_eq!(total_bytes(&tx).unwrap(), exact.len() as u64);
        let name: String = tx
            .query_row("SELECT family FROM immutable_payloads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "text");
    }
}
