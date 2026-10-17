//! Durable, invisible binary upload staging. These rows are not operation
//! receipts, graph records, authored envelopes or filesystem publications.
use super::*;
use zorid_core::{OperationId, VaultPath};
use zorid_file_sync::{Manifest, Scope, Sha256Digest};
use zorid_sync_protocol::UpdateId;

pub const BINARY_STAGE_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const BINARY_STAGE_MAX_CHUNK_BYTES: usize = 128 * 1024;
pub const BINARY_STAGE_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("binary_stages", "CREATE TABLE binary_stages (stage_id TEXT PRIMARY KEY NOT NULL,local_store_id TEXT NOT NULL,client_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,request TEXT NOT NULL,limits TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('receiving','sealed','commit_requested','committed','rejected','aborted')),accepted_length INTEGER NOT NULL CHECK(accepted_length BETWEEN 0 AND 67108864),next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 0 AND 512),seal_request TEXT,manifest TEXT,source_commitment TEXT,CHECK((manifest IS NULL)=(source_commitment IS NULL)))"),
    ("binary_stage_allocations", "CREATE TABLE binary_stage_allocations (realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,update_id TEXT NOT NULL,stage_id TEXT NOT NULL REFERENCES binary_stages(stage_id),kind TEXT NOT NULL CHECK(kind IN ('chunk','page')),sequence INTEGER NOT NULL CHECK(sequence>=0),PRIMARY KEY(realm_id,vault_id,update_id),UNIQUE(stage_id,kind,sequence))"),
    ("binary_stage_chunks", "CREATE TABLE binary_stage_chunks (stage_id TEXT NOT NULL REFERENCES binary_stages(stage_id),sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 511),offset INTEGER NOT NULL CHECK(offset BETWEEN 0 AND 67108864),bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 131072),digest TEXT NOT NULL,update_id TEXT NOT NULL,payload BLOB NOT NULL CHECK(length(payload) BETWEEN 1 AND 1048576),descriptor TEXT NOT NULL,PRIMARY KEY(stage_id,sequence),UNIQUE(stage_id,update_id))"),
    ("binary_stage_pages", "CREATE TABLE binary_stage_pages (stage_id TEXT NOT NULL REFERENCES binary_stages(stage_id),sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 3),update_id TEXT NOT NULL,payload BLOB NOT NULL CHECK(length(payload) BETWEEN 1 AND 1048576),descriptor TEXT NOT NULL,PRIMARY KEY(stage_id,sequence),UNIQUE(stage_id,update_id))"),
];

/// Policy is injected by the caller; this foundation enables no default quota.
/// Byte and record quotas include retained aborted stages, because abort is not GC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamingLimits {
    pub max_active_stages: u32,
    pub max_stage_records: u32,
    #[serde(with = "decimal")]
    pub max_staged_bytes: u64,
    pub max_chunk_records: u32,
    pub max_page_records: u32,
}
impl StreamingLimits {
    fn validate(self) -> Result<()> {
        if self.max_active_stages == 0
            || self.max_stage_records == 0
            || self.max_staged_bytes == 0
            || self.max_staged_bytes > i64::MAX as u64
            || self.max_chunk_records == 0
            || self.max_page_records == 0
        {
            return Err(invalid("binary staging requires finite positive quotas"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BinaryTarget {
    Create {
        id: EntryId,
        path: VaultPath,
    },
    Write {
        id: EntryId,
        expected_revision: Revision,
        expected_content_event: UpdateId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BinaryStageRequest {
    pub target: BinaryTarget,
    #[serde(with = "optional_decimal")]
    pub expected_length: Option<u64>,
}
impl BinaryStageRequest {
    fn validate(&self) -> Result<()> {
        if matches!(&self.target, BinaryTarget::Create { path, .. } if path.as_str().len() > BINARY_STAGE_MAX_PAYLOAD_BYTES)
        {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        if self
            .expected_length
            .is_some_and(|n| n > BINARY_STAGE_MAX_FILE_BYTES)
        {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        if serde_json::to_vec(self)?.len() > BINARY_STAGE_MAX_PAYLOAD_BYTES {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        Ok(())
    }
}

/// Store-issued identity. Resume through client/operation, never deserialize a
/// renderer-supplied reference into authority. Every use resolves its store row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BinaryStageRef {
    local_store_id: OperationId,
    client_id: OperationId,
    operation_id: OperationId,
    stage_id: OperationId,
}
impl BinaryStageRef {
    pub fn local_store_id(&self) -> &OperationId {
        &self.local_store_id
    }
    pub fn client_id(&self) -> &OperationId {
        &self.client_id
    }
    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }
    pub fn stage_id(&self) -> &OperationId {
        &self.stage_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagePhase {
    Receiving,
    Sealed,
    CommitRequested,
    Committed,
    Rejected,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StageChunkReceipt {
    pub sequence: u32,
    #[serde(with = "decimal")]
    pub offset: u64,
    pub bytes: u32,
    pub digest: Sha256Digest,
    #[serde(with = "decimal")]
    pub accepted_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BinaryStageStatus {
    pub state: StagePhase,
    #[serde(with = "decimal")]
    pub accepted_length: u64,
    pub next_sequence: u32,
    pub seal_requested: bool,
    pub finalized: Option<StagedBinaryRef>,
}

/// Inert private capability, not a receipt. Only actual durable source
/// verification constructs it; no persisted verification boolean is trusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StagedBinaryRef {
    stage: BinaryStageRef,
    #[serde(serialize_with = "serialize_manifest")]
    manifest: Manifest,
    source_commitment: Sha256Digest,
}
impl StagedBinaryRef {
    pub fn stage(&self) -> &BinaryStageRef {
        &self.stage
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn source_commitment(&self) -> &Sha256Digest {
        &self.source_commitment
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SealRequest {
    #[serde(with = "decimal")]
    final_length: u64,
    expected_digest: Option<Sha256Digest>,
}

mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let value = raw.parse::<u64>().map_err(serde::de::Error::custom)?;
        if raw != value.to_string() {
            return Err(serde::de::Error::custom("noncanonical decimal count"));
        }
        Ok(value)
    }
}
mod optional_decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|raw| {
                let value = raw.parse::<u64>().map_err(serde::de::Error::custom)?;
                if raw != value.to_string() {
                    return Err(serde::de::Error::custom("noncanonical decimal count"));
                }
                Ok(value)
            })
            .transpose()
    }
}
fn serialize_manifest<S: serde::Serializer>(
    manifest: &Manifest,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    #[derive(Serialize)]
    struct Page<'a> {
        id: &'a UpdateId,
        #[serde(with = "decimal")]
        bytes: u64,
        digest: &'a Sha256Digest,
    }
    #[derive(Serialize)]
    struct View<'a> {
        #[serde(with = "decimal")]
        bytes: u64,
        digest: &'a Sha256Digest,
        pages: Vec<Page<'a>>,
    }
    View {
        bytes: manifest.bytes,
        digest: &manifest.digest,
        pages: manifest
            .pages
            .iter()
            .map(|p| Page {
                id: &p.id,
                bytes: p.bytes,
                digest: &p.digest,
            })
            .collect(),
    }
    .serialize(serializer)
}

struct Stage {
    reference: BinaryStageRef,
    scope: Scope,
    request: BinaryStageRequest,
    limits: StreamingLimits,
    phase: StagePhase,
    accepted: u64,
    next: u32,
    seal_request: Option<SealRequest>,
    manifest: Option<Manifest>,
    commitment: Option<Sha256Digest>,
}

fn invalid(reason: &str) -> StoreError {
    ContractError::InvalidMutation {
        reason: reason.into(),
    }
    .into()
}
fn conflict(operation: &OperationId) -> StoreError {
    ContractError::IdempotencyConflict {
        operation_id: operation.clone(),
    }
    .into()
}
fn corrupt(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}
fn phase(value: &str) -> Result<StagePhase> {
    match value {
        "receiving" => Ok(StagePhase::Receiving),
        "sealed" => Ok(StagePhase::Sealed),
        "commit_requested" => Ok(StagePhase::CommitRequested),
        "committed" => Ok(StagePhase::Committed),
        "rejected" => Ok(StagePhase::Rejected),
        "aborted" => Ok(StagePhase::Aborted),
        _ => Err(corrupt("invalid binary stage phase")),
    }
}

fn authority(tx: &Connection) -> Result<(OperationId, Scope)> {
    let identity = text_sync::identity(tx)?;
    let (Some(realm_id), Some(vault_id)) = (identity.realm_id, identity.vault_id) else {
        return Err(invalid("binary stages require existing family enrollment"));
    };
    let scope = Scope { realm_id, vault_id };
    let enrolled: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM family_graph_heads WHERE realm_id=?1 AND vault_id=?2)",
        params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        |r| r.get(0),
    )?;
    if !enrolled {
        return Err(invalid("binary stages require an existing family graph"));
    }
    Ok((identity.local_store_id, scope))
}

fn load(tx: &Connection, reference: &BinaryStageRef) -> Result<Stage> {
    let bounded: bool = tx.query_row("SELECT length(CAST(request AS BLOB)) BETWEEN 1 AND 1048576 AND length(CAST(limits AS BLOB)) BETWEEN 1 AND 4096 AND (seal_request IS NULL OR length(CAST(seal_request AS BLOB)) BETWEEN 1 AND 4096) AND (manifest IS NULL OR length(CAST(manifest AS BLOB)) BETWEEN 1 AND 1048576) AND (source_commitment IS NULL OR length(CAST(source_commitment AS BLOB)) BETWEEN 1 AND 1024) FROM binary_stages WHERE stage_id=?1",[reference.stage_id.as_str()],|r|r.get(0)).optional()?.ok_or_else(||invalid("binary stage not found"))?;
    if !bounded {
        return Err(corrupt("binary stage metadata bound exceeded"));
    }
    let raw = tx.query_row(
        "SELECT local_store_id,client_id,operation_id,realm_id,vault_id,request,limits,phase,accepted_length,next_sequence,seal_request,manifest,source_commitment FROM binary_stages WHERE stage_id=?1",
        [reference.stage_id.as_str()], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?,r.get::<_,i64>(8)?,r.get::<_,i64>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,Option<String>>(11)?,r.get::<_,Option<String>>(12)?)),
    ).optional()?.ok_or_else(|| invalid("binary stage not found"))?;
    let (
        local,
        client,
        operation,
        realm,
        vault,
        request,
        limits,
        state,
        accepted,
        next,
        seal,
        manifest,
        commitment,
    ) = raw;
    let (current_local, current_scope) = authority(tx)?;
    let scope = Scope {
        realm_id: zorid_sync_protocol::RealmId::new(realm)?,
        vault_id: zorid_sync_protocol::VaultId::new(vault)?,
    };
    if local != reference.local_store_id.as_str()
        || client != reference.client_id.as_str()
        || operation != reference.operation_id.as_str()
        || current_local != reference.local_store_id
        || current_scope != scope
    {
        return Err(conflict(&reference.operation_id));
    }
    let request: BinaryStageRequest = serde_json::from_str(&request)?;
    request.validate()?;
    let limits: StreamingLimits = serde_json::from_str(&limits)?;
    limits.validate()?;
    let state = phase(&state)?;
    let accepted = u64::try_from(accepted).map_err(|_| corrupt("negative staged length"))?;
    let next = u32::try_from(next).map_err(|_| corrupt("invalid stage sequence"))?;
    if accepted > BINARY_STAGE_MAX_FILE_BYTES || next > 512 || (accepted == 0) != (next == 0) {
        return Err(corrupt("invalid binary stage progress"));
    }
    let seal_request: Option<SealRequest> = seal.map(|s| serde_json::from_str(&s)).transpose()?;
    let manifest: Option<Manifest> = manifest.map(|s| serde_json::from_str(&s)).transpose()?;
    let commitment = commitment.map(|s| serde_json::from_str(&s)).transpose()?;
    if manifest.is_some() != commitment.is_some()
        || (matches!(
            state,
            StagePhase::Sealed | StagePhase::CommitRequested | StagePhase::Committed
        ) && (manifest.is_none() || seal_request.is_none()))
        || (state == StagePhase::Receiving && manifest.is_some())
        || seal_request
            .as_ref()
            .is_some_and(|s| s.final_length != accepted)
    {
        return Err(corrupt("binary stage phase/metadata mismatch"));
    }
    let (chunks, total, highest, allocated):(u32,i64,Option<u32>,u32) = tx.query_row("SELECT count(*),coalesce(sum(bytes),0),max(sequence),(SELECT count(*) FROM binary_stage_allocations WHERE stage_id=?1 AND kind='chunk') FROM binary_stage_chunks WHERE stage_id=?1",[reference.stage_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let total = u64::try_from(total).map_err(|_| corrupt("negative staged chunk byte total"))?;
    if chunks != next || allocated != next || total != accepted || highest != next.checked_sub(1) {
        return Err(corrupt("binary stage progress differs from durable chunks"));
    }
    Ok(Stage {
        reference: reference.clone(),
        scope,
        request,
        limits,
        phase: state,
        accepted,
        next,
        seal_request,
        manifest,
        commitment,
    })
}

/// Also called by the common envelope allocator, so staged IDs cannot become
/// authored/received authority through another command before stage commit.
pub(super) fn update_reserved(tx: &Connection, key: &family_ledger::EnvelopeKey) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM binary_stage_allocations WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3)",params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],|r|r.get(0))?)
}

/// Ordinary command/intent paths must reject these IDs rather than decode a
/// stage as an inline operation or execute under its durable operation identity.
pub(super) fn operation_reserved(tx: &Connection, operation: &OperationId) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM binary_stages WHERE operation_id=?1)",
        [operation.as_str()],
        |r| r.get(0),
    )?)
}

fn allocation(tx: &Connection, stage: &Stage, kind: &str, sequence: u32) -> Result<UpdateId> {
    if let Some(id) = tx.query_row("SELECT update_id FROM binary_stage_allocations WHERE stage_id=?1 AND kind=?2 AND sequence=?3",params![stage.reference.stage_id.as_str(),kind,sequence],|r|r.get::<_,String>(0)).optional()? {
        return Ok(UpdateId::new(id)?);
    }
    for _ in 0..64 {
        let id = UpdateId::new(uuid::Uuid::new_v4().to_string())?;
        let key = family_ledger::EnvelopeKey {
            realm_id: stage.scope.realm_id.clone(),
            vault_id: stage.scope.vault_id.clone(),
            update_id: id.clone(),
        };
        if !family_ledger::unused(tx, &key)? || update_reserved(tx, &key)? {
            continue;
        }
        tx.execute(
            "INSERT INTO binary_stage_allocations VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                stage.scope.realm_id.as_str(),
                stage.scope.vault_id.as_str(),
                id.as_str(),
                stage.reference.stage_id.as_str(),
                kind,
                sequence
            ],
        )?;
        return Ok(id);
    }
    Err(corrupt("could not allocate a fresh binary stage update ID"))
}

fn usage(tx: &Connection) -> Result<(u64, u64, u64, u64, u64)> {
    let (active, bytes, chunks, pages, stages):(i64,i64,i64,i64,i64) = tx.query_row("SELECT (SELECT count(*) FROM binary_stages WHERE phase IN ('receiving','sealed','commit_requested')),(SELECT coalesce(sum(length(payload)),0) FROM binary_stage_chunks)+(SELECT coalesce(sum(length(payload)),0) FROM binary_stage_pages),(SELECT count(*) FROM binary_stage_allocations WHERE kind='chunk'),(SELECT count(*) FROM binary_stage_allocations WHERE kind='page'),(SELECT count(*) FROM binary_stages)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    Ok((
        u64::try_from(active).map_err(|_| corrupt("invalid stage usage"))?,
        u64::try_from(bytes).map_err(|_| corrupt("invalid stage usage"))?,
        u64::try_from(chunks).map_err(|_| corrupt("invalid stage usage"))?,
        u64::try_from(pages).map_err(|_| corrupt("invalid stage usage"))?,
        u64::try_from(stages).map_err(|_| corrupt("invalid stage usage"))?,
    ))
}

fn check_payload_quota(tx: &Connection, stage: &Stage, additional: usize) -> Result<()> {
    let (_, used, _, _, _) = usage(tx)?;
    if used
        .checked_add(additional as u64)
        .is_none_or(|n| n > stage.limits.max_staged_bytes)
    {
        return Err(zorid_file_sync::Error::TooLarge.into());
    }
    Ok(())
}

impl Store {
    pub fn begin_binary_stage(
        &mut self,
        client: &OperationId,
        operation: &OperationId,
        request: &BinaryStageRequest,
        limits: StreamingLimits,
    ) -> Result<BinaryStageRef> {
        request.validate()?;
        limits.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (local_store_id, scope) = authority(&tx)?;
        let prior = tx
            .query_row(
                "SELECT stage_id,client_id,local_store_id FROM binary_stages WHERE operation_id=?1",
                [operation.as_str()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let reference = if let Some((id, owner, local)) = prior {
            if owner != client.as_str() || local != local_store_id.as_str() {
                return Err(conflict(operation));
            }
            let reference = BinaryStageRef {
                local_store_id,
                client_id: client.clone(),
                operation_id: operation.clone(),
                stage_id: OperationId::new(id)?,
            };
            if load(&tx, &reference)?.request != *request {
                return Err(conflict(operation));
            }
            reference
        } else {
            let occupied: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id=?1 UNION ALL SELECT 1 FROM host_intents WHERE operation_id=?1)",[operation.as_str()],|r|r.get(0))?;
            if occupied {
                return Err(conflict(operation));
            }
            let (active, bytes, chunks, pages, stages) = usage(&tx)?;
            if active >= u64::from(limits.max_active_stages)
                || stages >= u64::from(limits.max_stage_records)
                || bytes > limits.max_staged_bytes
                || chunks > u64::from(limits.max_chunk_records)
                || pages > u64::from(limits.max_page_records)
            {
                return Err(zorid_file_sync::Error::TooLarge.into());
            }
            let reference = BinaryStageRef {
                local_store_id,
                client_id: client.clone(),
                operation_id: operation.clone(),
                stage_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            };
            tx.execute("INSERT INTO binary_stages(stage_id,local_store_id,client_id,operation_id,realm_id,vault_id,request,limits,phase,accepted_length,next_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'receiving',0,0)",params![reference.stage_id.as_str(),reference.local_store_id.as_str(),client.as_str(),operation.as_str(),scope.realm_id.as_str(),scope.vault_id.as_str(),serde_json::to_string(request)?,serde_json::to_string(&limits)?])?;
            reference
        };
        tx.commit()?;
        Ok(reference)
    }

    pub fn resume_binary_stage(
        &self,
        client: &OperationId,
        operation: &OperationId,
    ) -> Result<Option<BinaryStageRef>> {
        let tx = self.connection.unchecked_transaction()?;
        let (local_store_id, _) = authority(&tx)?;
        let prior = tx
            .query_row(
                "SELECT stage_id,client_id FROM binary_stages WHERE operation_id=?1",
                [operation.as_str()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let reference = prior
            .map(|(id, owner)| -> Result<_> {
                if owner != client.as_str() {
                    return Err(conflict(operation));
                }
                let reference = BinaryStageRef {
                    local_store_id,
                    client_id: client.clone(),
                    operation_id: operation.clone(),
                    stage_id: OperationId::new(id)?,
                };
                load(&tx, &reference)?;
                Ok(reference)
            })
            .transpose()?;
        tx.commit()?;
        Ok(reference)
    }

    pub fn append_binary_chunk(
        &mut self,
        reference: &BinaryStageRef,
        sequence: u32,
        offset: u64,
        bytes: &[u8],
    ) -> Result<StageChunkReceipt> {
        if bytes.is_empty() || bytes.len() > BINARY_STAGE_MAX_CHUNK_BYTES {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stage = load(&tx, reference)?;
        if stage.phase != StagePhase::Receiving || stage.seal_request.is_some() {
            return Err(invalid("binary stage no longer accepts chunks"));
        }
        if sequence < stage.next {
            let chunk = read_chunk(&tx, &stage, sequence)?;
            if chunk.offset != offset || chunk.bytes != bytes {
                return Err(conflict(&reference.operation_id));
            }
            let receipt = StageChunkReceipt {
                sequence,
                offset,
                bytes: bytes.len() as u32,
                digest: Sha256Digest::of(bytes),
                accepted_length: offset + bytes.len() as u64,
            };
            tx.commit()?;
            return Ok(receipt);
        }
        if sequence != stage.next
            || offset != stage.accepted
            || offset != u64::from(sequence) * BINARY_STAGE_MAX_CHUNK_BYTES as u64
        {
            return Err(invalid("binary chunks must be contiguous canonical chunks"));
        }
        let accepted = offset
            .checked_add(bytes.len() as u64)
            .ok_or(zorid_file_sync::Error::TooLarge)?;
        if accepted > BINARY_STAGE_MAX_FILE_BYTES
            || stage.request.expected_length.is_some_and(|n| accepted > n)
        {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        let (_, _, chunks, _, _) = usage(&tx)?;
        if chunks >= u64::from(stage.limits.max_chunk_records) {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        let id = allocation(&tx, &stage, "chunk", sequence)?;
        let raw = zorid_file_sync::v2::Payload {
            family: zorid_file_sync::Family::Files,
            format_version: zorid_file_sync::v2::FORMAT_VERSION,
            scope: stage.scope.clone(),
            id: id.clone(),
            body: zorid_file_sync::v2::Body::Chunk {
                bytes: bytes.to_vec(),
            },
        }
        .encode()?;
        if raw.len() > BINARY_STAGE_MAX_PAYLOAD_BYTES {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        check_payload_quota(&tx, &stage, raw.len())?;
        let descriptor = descriptor(&raw, &stage.scope, &id)?;
        let digest = Sha256Digest::of(bytes);
        let sql_offset = i64::try_from(offset)
            .map_err(|_| corrupt("staged offset exceeds SQLite integer range"))?;
        let sql_accepted = i64::try_from(accepted)
            .map_err(|_| corrupt("staged length exceeds SQLite integer range"))?;
        tx.execute(
            "INSERT INTO binary_stage_chunks VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                reference.stage_id.as_str(),
                sequence,
                sql_offset,
                bytes.len() as u32,
                serde_json::to_string(&digest)?,
                id.as_str(),
                raw,
                descriptor
            ],
        )?;
        tx.execute(
            "UPDATE binary_stages SET accepted_length=?1,next_sequence=?2 WHERE stage_id=?3",
            params![sql_accepted, sequence + 1, reference.stage_id.as_str()],
        )?;
        tx.commit()?;
        Ok(StageChunkReceipt {
            sequence,
            offset,
            bytes: bytes.len() as u32,
            digest,
            accepted_length: accepted,
        })
    }

    pub fn abort_binary_stage(&mut self, reference: &BinaryStageRef) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stage = load(&tx, reference)?;
        if !matches!(
            stage.phase,
            StagePhase::Receiving | StagePhase::Sealed | StagePhase::Aborted
        ) {
            return Err(invalid("authorized binary stage cannot be aborted"));
        }
        tx.execute(
            "UPDATE binary_stages SET phase='aborted' WHERE stage_id=?1",
            [reference.stage_id.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn query_binary_stage(&self, reference: &BinaryStageRef) -> Result<BinaryStageStatus> {
        let tx = self.connection.unchecked_transaction()?;
        let stage = load(&tx, reference)?;
        let finalized = if matches!(
            stage.phase,
            StagePhase::Sealed | StagePhase::CommitRequested | StagePhase::Committed
        ) {
            let verified = verify_stage(&tx, &stage)?;
            Some(verified.reference)
        } else {
            None
        };
        let result = BinaryStageStatus {
            state: stage.phase,
            accepted_length: stage.accepted,
            next_sequence: stage.next,
            seal_requested: stage.seal_request.is_some(),
            finalized,
        };
        tx.commit()?;
        Ok(result)
    }

    pub fn seal_binary_stage(
        &mut self,
        reference: &BinaryStageRef,
        final_length: u64,
        expected_digest: Option<Sha256Digest>,
    ) -> Result<StagedBinaryRef> {
        let request = SealRequest {
            final_length,
            expected_digest,
        };
        // Freeze EOF and page identities first. A crash during later hashing
        // leaves this exact request resumable without allocating another plan.
        {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let stage = load(&tx, reference)?;
            if !matches!(stage.phase, StagePhase::Receiving | StagePhase::Sealed) {
                return Err(invalid("binary stage cannot be sealed in this phase"));
            }
            if let Some(prior) = &stage.seal_request {
                if prior != &request {
                    return Err(conflict(&reference.operation_id));
                }
            } else {
                if final_length != stage.accepted
                    || stage
                        .request
                        .expected_length
                        .is_some_and(|n| n != final_length)
                {
                    return Err(invalid(
                        "binary stage EOF length differs from durable chunks",
                    ));
                }
                let pages = stage.next.div_ceil(zorid_file_sync::MAX_PAGE_CHUNKS as u32);
                let (_, _, _, used_pages, _) = usage(&tx)?;
                if used_pages
                    .checked_add(u64::from(pages))
                    .is_none_or(|n| n > u64::from(stage.limits.max_page_records))
                {
                    return Err(zorid_file_sync::Error::TooLarge.into());
                }
                for sequence in 0..pages {
                    allocation(&tx, &stage, "page", sequence)?;
                }
                tx.execute(
                    "UPDATE binary_stages SET seal_request=?1 WHERE stage_id=?2",
                    params![
                        serde_json::to_string(&request)?,
                        reference.stage_id.as_str()
                    ],
                )?;
            }
            tx.commit()?;
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stage = load(&tx, reference)?;
        if !matches!(stage.phase, StagePhase::Receiving | StagePhase::Sealed)
            || stage.seal_request.as_ref() != Some(&request)
        {
            return Err(invalid("binary stage changed during seal"));
        }
        let verified = verify_stage(&tx, &stage)?;
        if stage.phase == StagePhase::Receiving {
            let extra = verified.pages.iter().try_fold(0_usize, |total, page| {
                total
                    .checked_add(page.raw.len())
                    .ok_or(zorid_file_sync::Error::TooLarge)
            })?;
            check_payload_quota(&tx, &stage, extra)?;
            for page in &verified.pages {
                tx.execute(
                    "INSERT INTO binary_stage_pages VALUES(?1,?2,?3,?4,?5)",
                    params![
                        reference.stage_id.as_str(),
                        page.sequence,
                        page.id.as_str(),
                        page.raw,
                        page.descriptor
                    ],
                )?;
            }
            tx.execute("UPDATE binary_stages SET phase='sealed',manifest=?1,source_commitment=?2 WHERE stage_id=?3 AND phase='receiving'",params![serde_json::to_string(&verified.reference.manifest)?,serde_json::to_string(&verified.reference.source_commitment)?,reference.stage_id.as_str()])?;
        }
        tx.commit()?;
        Ok(verified.reference)
    }
}

fn descriptor(raw: &[u8], scope: &Scope, id: &UpdateId) -> Result<String> {
    let (actual_scope, actual_id, descriptor) =
        zorid_file_sync::metadata::GraphRecord::from_authored_exact(raw)?;
    if &actual_scope != scope || &actual_id != id {
        return Err(corrupt("binary stage payload routing mismatch"));
    }
    Ok(serde_json::to_string(&descriptor)?)
}

struct Chunk {
    id: UpdateId,
    offset: u64,
    bytes: Vec<u8>,
    descriptor: String,
    payload_digest: Sha256Digest,
}
fn read_chunk(tx: &Connection, stage: &Stage, sequence: u32) -> Result<Chunk> {
    let bounded: bool = tx.query_row("SELECT length(payload) BETWEEN 1 AND 1048576 AND length(CAST(descriptor AS BLOB)) BETWEEN 1 AND 1048576 FROM binary_stage_chunks WHERE stage_id=?1 AND sequence=?2",params![stage.reference.stage_id.as_str(),sequence],|r|r.get(0)).optional()?.ok_or_else(||corrupt("binary stage chunk missing"))?;
    if !bounded {
        return Err(corrupt(
            "binary stage stored payload/descriptor bound exceeded",
        ));
    }
    let (offset, bytes, digest, id, raw, stored):(i64,u32,String,String,Vec<u8>,String) = tx.query_row("SELECT offset,bytes,digest,update_id,payload,descriptor FROM binary_stage_chunks WHERE stage_id=?1 AND sequence=?2",params![stage.reference.stage_id.as_str(),sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    if raw.is_empty() || raw.len() > BINARY_STAGE_MAX_PAYLOAD_BYTES {
        return Err(corrupt("binary stage payload bound exceeded"));
    }
    let id = UpdateId::new(id)?;
    let expected_id:Option<String> = tx.query_row("SELECT update_id FROM binary_stage_allocations WHERE realm_id=?1 AND vault_id=?2 AND stage_id=?3 AND kind='chunk' AND sequence=?4",params![stage.scope.realm_id.as_str(),stage.scope.vault_id.as_str(),stage.reference.stage_id.as_str(),sequence],|r|r.get(0)).optional()?;
    if expected_id.as_deref() != Some(id.as_str()) || descriptor(&raw, &stage.scope, &id)? != stored
    {
        return Err(corrupt("binary stage descriptor/allocation mismatch"));
    }
    let payload = zorid_file_sync::v2::Payload::decode(&raw)?;
    let zorid_file_sync::v2::Body::Chunk { bytes: body } = payload.body else {
        return Err(corrupt("binary stage chunk has wrong payload kind"));
    };
    let offset = u64::try_from(offset).map_err(|_| corrupt("invalid binary chunk offset"))?;
    let digest: Sha256Digest = serde_json::from_str(&digest)?;
    if offset != u64::from(sequence) * BINARY_STAGE_MAX_CHUNK_BYTES as u64
        || body.len() != bytes as usize
        || digest != Sha256Digest::of(&body)
        || (sequence + 1 < stage.next && body.len() != BINARY_STAGE_MAX_CHUNK_BYTES)
    {
        return Err(corrupt("binary stage chunk progress/digest mismatch"));
    }
    Ok(Chunk {
        id,
        offset,
        bytes: body,
        descriptor: stored,
        payload_digest: Sha256Digest::of(&raw),
    })
}

struct Page {
    sequence: u32,
    id: UpdateId,
    raw: Vec<u8>,
    descriptor: String,
}
struct VerifiedStage {
    reference: StagedBinaryRef,
    pages: Vec<Page>,
}

#[derive(Serialize)]
struct SourceRecord {
    kind: &'static str,
    sequence: u32,
    offset: u64,
    id: UpdateId,
    payload_digest: Sha256Digest,
    summary_digest: Sha256Digest,
}

fn verify_stage(tx: &Connection, stage: &Stage) -> Result<VerifiedStage> {
    let seal = stage
        .seal_request
        .as_ref()
        .ok_or_else(|| corrupt("binary stage lacks durable seal request"))?;
    let needed_pages = stage.next.div_ceil(zorid_file_sync::MAX_PAGE_CHUNKS as u32);
    let page_rows = tx.prepare("SELECT sequence,update_id FROM binary_stage_allocations WHERE realm_id=?1 AND vault_id=?2 AND stage_id=?3 AND kind='page' ORDER BY sequence LIMIT 5")?.query_map(params![stage.scope.realm_id.as_str(),stage.scope.vault_id.as_str(),stage.reference.stage_id.as_str()],|r|Ok((r.get::<_,u32>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if page_rows.len() != needed_pages as usize
        || page_rows
            .iter()
            .enumerate()
            .any(|(index, (sequence, _))| *sequence as usize != index)
    {
        return Err(corrupt("binary stage page allocations are incomplete"));
    }
    let mut builder =
        zorid_file_sync::binary_stream::BinaryManifestBuilder::new(stage.scope.clone());
    let mut pages = Vec::new();
    let mut sources = Vec::new();
    for sequence in 0..stage.next {
        let chunk = read_chunk(tx, stage, sequence)?;
        let authored = builder.push_chunk(chunk.id.clone(), &chunk.bytes)?;
        if authored.scope() != &stage.scope
            || authored.id() != &chunk.id
            || authored.record().payload_digest() != &chunk.payload_digest
            || serde_json::to_string(authored.record())? != chunk.descriptor
        {
            return Err(corrupt(
                "binary stage differs from exact local payload emission",
            ));
        }
        if sequence + 1 == stage.next && chunk.offset + chunk.bytes.len() as u64 != stage.accepted {
            return Err(corrupt("binary stage final chunk length mismatch"));
        }
        sources.push(SourceRecord {
            kind: "chunk",
            sequence,
            offset: chunk.offset,
            id: chunk.id,
            payload_digest: chunk.payload_digest,
            summary_digest: authored.record().summary_digest()?,
        });
        if builder.pending_chunks() == zorid_file_sync::MAX_PAGE_CHUNKS
            || sequence + 1 == stage.next
        {
            let page_sequence = pages.len() as u32;
            let id = UpdateId::new(page_rows[page_sequence as usize].1.clone())?;
            let authored = builder.flush_page(id.clone())?;
            let raw = authored.payload_bytes().to_vec();
            if raw.is_empty() || raw.len() > BINARY_STAGE_MAX_PAYLOAD_BYTES {
                return Err(zorid_file_sync::Error::TooLarge.into());
            }
            let descriptor = serde_json::to_string(authored.record())?;
            sources.push(SourceRecord {
                kind: "page",
                sequence: page_sequence,
                offset: 0,
                id: id.clone(),
                payload_digest: *authored.record().payload_digest(),
                summary_digest: authored.record().summary_digest()?,
            });
            pages.push(Page {
                sequence: page_sequence,
                id,
                raw,
                descriptor,
            });
        }
    }
    let built = builder.finish()?;
    let manifest = built.manifest().clone();
    if manifest.bytes != stage.accepted
        || manifest.bytes != seal.final_length
        || stage
            .request
            .expected_length
            .is_some_and(|n| n != manifest.bytes)
        || seal
            .expected_digest
            .is_some_and(|digest| digest != manifest.digest)
    {
        return Err(zorid_file_sync::Error::InvalidContent.into());
    }
    #[derive(Serialize)]
    struct Commitment<'a> {
        version: u32,
        stage: &'a BinaryStageRef,
        scope: &'a Scope,
        request: &'a BinaryStageRequest,
        seal: &'a SealRequest,
        manifest: &'a Manifest,
        sources: &'a [SourceRecord],
    }
    let canonical = serde_json::to_vec(&Commitment {
        version: 1,
        stage: &stage.reference,
        scope: &stage.scope,
        request: &stage.request,
        seal,
        manifest: &manifest,
        sources: &sources,
    })?;
    if canonical.len() > BINARY_STAGE_MAX_PAYLOAD_BYTES {
        return Err(zorid_file_sync::Error::TooLarge.into());
    }
    let commitment = Sha256Digest::of(&canonical);
    let persisted_pages: u32 = tx.query_row(
        "SELECT count(*) FROM binary_stage_pages WHERE stage_id=?1",
        [stage.reference.stage_id.as_str()],
        |r| r.get(0),
    )?;
    if stage.phase == StagePhase::Receiving {
        if persisted_pages != 0 || stage.manifest.is_some() || stage.commitment.is_some() {
            return Err(corrupt("unsealed binary stage has finalized sources"));
        }
    } else {
        if stage.manifest.as_ref() != Some(&manifest)
            || stage.commitment != Some(commitment)
            || persisted_pages != pages.len() as u32
        {
            return Err(corrupt(
                "sealed binary stage commitment differs from durable sources",
            ));
        }
        for page in &pages {
            let bounded: bool = tx.query_row("SELECT length(payload) BETWEEN 1 AND 1048576 AND length(CAST(descriptor AS BLOB)) BETWEEN 1 AND 1048576 FROM binary_stage_pages WHERE stage_id=?1 AND sequence=?2",params![stage.reference.stage_id.as_str(),page.sequence],|r|r.get(0)).optional()?.ok_or_else(||corrupt("sealed binary page missing"))?;
            if !bounded {
                return Err(corrupt("sealed binary page bound exceeded"));
            }
            let (id, raw, descriptor):(String,Vec<u8>,String) = tx.query_row("SELECT update_id,payload,descriptor FROM binary_stage_pages WHERE stage_id=?1 AND sequence=?2",params![stage.reference.stage_id.as_str(),page.sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            if id != page.id.as_str() || raw != page.raw || descriptor != page.descriptor {
                return Err(corrupt(
                    "sealed binary page differs from exact durable source",
                ));
            }
        }
    }
    Ok(VerifiedStage {
        reference: StagedBinaryRef {
            stage: stage.reference.clone(),
            manifest,
            source_commitment: commitment,
        },
        pages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn limits() -> StreamingLimits {
        StreamingLimits {
            max_active_stages: 4,
            max_stage_records: 8,
            max_staged_bytes: 8 * 1024 * 1024,
            max_chunk_records: 16,
            max_page_records: 4,
        }
    }
    fn request(id: &str, length: Option<u64>) -> BinaryStageRequest {
        BinaryStageRequest {
            target: BinaryTarget::Create {
                id: EntryId::new(id).unwrap(),
                path: VaultPath::new(format!("{id}.bin")).unwrap(),
            },
            expected_length: length,
        }
    }
    fn enrolled(path: &Path) -> Store {
        let mut store = Store::open(path).unwrap();
        store
            .family_enroll(&Scope {
                realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
            })
            .unwrap();
        store
    }
    fn invisible(store: &Store) {
        for table in [
            "entries",
            "operations",
            "outbox",
            "authored_envelopes",
            "family_file_records",
        ] {
            let count: i64 = store
                .connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "staging changed {table}");
        }
    }

    #[test]
    fn stage_begin_resume_retries_keep_ownership_and_remain_invisible() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.sqlite");
        let client = op("client");
        let operation = op("operation");
        let mut store = enrolled(&path);
        let reference = store
            .begin_binary_stage(&client, &operation, &request("binary", None), limits())
            .unwrap();
        assert_eq!(
            store
                .begin_binary_stage(&client, &operation, &request("binary", None), limits())
                .unwrap(),
            reference
        );
        assert!(store
            .begin_binary_stage(&op("other"), &operation, &request("binary", None), limits())
            .is_err());
        assert!(store
            .begin_binary_stage(&client, &operation, &request("changed", None), limits())
            .is_err());
        assert!(store.resume_binary_stage(&op("other"), &operation).is_err());
        invisible(&store);
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.resume_binary_stage(&client, &operation).unwrap(),
            Some(reference.clone())
        );
        let other = enrolled(&dir.path().join("other.sqlite"));
        assert!(other.query_binary_stage(&reference).is_err());
        assert_eq!(
            store
                .query_binary_stage(&reference)
                .unwrap()
                .accepted_length,
            0
        );
        invisible(&store);
    }

    #[test]
    fn stage_append_is_bounded_contiguous_and_exactly_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = enrolled(&dir.path().join("vault.sqlite"));
        let reference = store
            .begin_binary_stage(
                &op("client"),
                &op("operation"),
                &request("binary", None),
                limits(),
            )
            .unwrap();
        assert!(store.append_binary_chunk(&reference, 0, 0, &[]).is_err());
        assert!(store
            .append_binary_chunk(&reference, 0, 0, &vec![1; BINARY_STAGE_MAX_CHUNK_BYTES + 1])
            .is_err());
        assert!(store.append_binary_chunk(&reference, 1, 0, b"gap").is_err());
        let chunk = vec![7; BINARY_STAGE_MAX_CHUNK_BYTES];
        let first = store.append_binary_chunk(&reference, 0, 0, &chunk).unwrap();
        assert_eq!(
            store.append_binary_chunk(&reference, 0, 0, &chunk).unwrap(),
            first
        );
        assert!(store
            .append_binary_chunk(&reference, 0, 0, b"changed")
            .is_err());
        assert!(store
            .append_binary_chunk(&reference, 1, 1, b"overlap")
            .is_err());
        let tail = store
            .append_binary_chunk(&reference, 1, chunk.len() as u64, b"tail")
            .unwrap();
        assert_eq!(tail.accepted_length, chunk.len() as u64 + 4);
        assert!(store
            .append_binary_chunk(&reference, 2, tail.accepted_length, b"after-tail")
            .is_err());
        assert_eq!(
            store.append_binary_chunk(&reference, 0, 0, &chunk).unwrap(),
            first
        );
        let json = serde_json::to_value(&tail).unwrap();
        assert_eq!(json["offset"], chunk.len().to_string());
        assert_eq!(json["accepted_length"], (chunk.len() + 4).to_string());
        assert_eq!(json["sequence"], 1);
        assert_eq!(
            store.query_binary_stage(&reference).unwrap().next_sequence,
            2
        );
        invisible(&store);
    }

    #[test]
    fn stage_quotas_include_aborted_bytes_and_reserve_update_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = enrolled(&dir.path().join("vault.sqlite"));
        let quota = StreamingLimits {
            max_active_stages: 1,
            max_chunk_records: 1,
            ..limits()
        };
        let first = store
            .begin_binary_stage(&op("client"), &op("first"), &request("first", None), quota)
            .unwrap();
        assert!(store
            .begin_binary_stage(
                &op("client"),
                &op("second"),
                &request("second", None),
                quota
            )
            .is_err());
        store
            .append_binary_chunk(&first, 0, 0, b"retained")
            .unwrap();
        let id: String = store
            .connection
            .query_row(
                "SELECT update_id FROM binary_stage_chunks WHERE stage_id=?1",
                [first.stage_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(update_reserved(
            &store.connection,
            &family_ledger::EnvelopeKey {
                realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
                update_id: UpdateId::new(id).unwrap()
            }
        )
        .unwrap());
        store.abort_binary_stage(&first).unwrap();
        store.abort_binary_stage(&first).unwrap();
        assert_eq!(
            store.query_binary_stage(&first).unwrap().state,
            StagePhase::Aborted
        );
        assert!(store
            .append_binary_chunk(&first, 0, 0, b"retained")
            .is_err());
        let second = store
            .begin_binary_stage(
                &op("client"),
                &op("second"),
                &request("second", None),
                quota,
            )
            .unwrap();
        assert!(store.append_binary_chunk(&second, 0, 0, b"quota").is_err());
        assert_eq!(usage(&store.connection).unwrap().2, 1);
        let tiny = StreamingLimits {
            max_staged_bytes: 1,
            ..limits()
        };
        assert!(store
            .begin_binary_stage(&op("client"), &op("third"), &request("third", None), tiny)
            .is_err());
        invisible(&store);
    }

    #[test]
    fn retained_stage_quota_bounds_empty_abort_loops_without_blocking_resume() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = enrolled(&dir.path().join("vault.sqlite"));
        let quota = StreamingLimits {
            max_active_stages: 1,
            max_stage_records: 2,
            ..limits()
        };
        let mut retained = Vec::new();
        for index in 0..2 {
            let operation = op(&format!("empty-{index}"));
            let request = request(&format!("empty-{index}"), Some(0));
            let stage = store
                .begin_binary_stage(&op("client"), &operation, &request, quota)
                .unwrap();
            store.abort_binary_stage(&stage).unwrap();
            retained.push((operation, request, stage));
        }
        let (active, bytes, chunks, pages, stages) = usage(&store.connection).unwrap();
        assert_eq!((active, bytes, chunks, pages, stages), (0, 0, 0, 0, 2));
        assert!(store
            .begin_binary_stage(
                &op("client"),
                &op("extra"),
                &request("extra", Some(0)),
                quota
            )
            .is_err());
        for (operation, request, stage) in &retained {
            assert_eq!(
                store
                    .begin_binary_stage(&op("client"), operation, request, quota)
                    .unwrap(),
                *stage
            );
            assert_eq!(
                store
                    .resume_binary_stage(&op("client"), operation)
                    .unwrap()
                    .as_ref(),
                Some(stage)
            );
            assert_eq!(
                store.query_binary_stage(stage).unwrap().state,
                StagePhase::Aborted
            );
        }
        let invalid = StreamingLimits {
            max_stage_records: 0,
            ..quota
        };
        assert!(store
            .begin_binary_stage(
                &op("client"),
                &op("invalid"),
                &request("invalid", None),
                invalid
            )
            .is_err());
        store
            .connection
            .execute(
                "UPDATE binary_stages SET limits=?1 WHERE stage_id=?2",
                params![
                    serde_json::to_string(&invalid).unwrap(),
                    retained[0].2.stage_id.as_str()
                ],
            )
            .unwrap();
        assert!(store
            .resume_binary_stage(&op("client"), &retained[0].0)
            .is_err());
        invisible(&store);
    }

    #[test]
    fn stage_requires_enrollment_and_rejects_existing_host_operation() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("vault.sqlite")).unwrap();
        assert!(store
            .begin_binary_stage(
                &op("client"),
                &op("stage"),
                &request("binary", None),
                limits()
            )
            .is_err());
        store
            .family_enroll(&Scope {
                realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
            })
            .unwrap();
        let command = MutationRequest {
            operation_id: op("existing"),
            mutation: Mutation::Create {
                id: EntryId::new("small").unwrap(),
                path: VaultPath::new("small.bin").unwrap(),
                kind: EntryKind::File,
                content: Some(vec![1]),
            },
        };
        store.prepare_host_intent(&op("client"), &command).unwrap();
        assert!(store
            .begin_binary_stage(
                &op("client"),
                &op("existing"),
                &request("binary", None),
                limits()
            )
            .is_err());
        assert!(store
            .begin_binary_stage(
                &op("client"),
                &op("too-large"),
                &request("binary", Some(BINARY_STAGE_MAX_FILE_BYTES + 1)),
                limits()
            )
            .is_err());
        let raw = serde_json::to_value(request("binary", Some(12))).unwrap();
        assert_eq!(raw["expected_length"], "12");
        let mut invalid = raw.clone();
        invalid["expected_length"] = serde_json::json!("012");
        assert!(serde_json::from_value::<BinaryStageRequest>(invalid).is_err());
        let mut invalid = raw;
        invalid["expected_length"] = serde_json::json!(12);
        assert!(serde_json::from_value::<BinaryStageRequest>(invalid).is_err());
        invisible(&store);
    }

    #[test]
    fn stage_seal_handles_empty_exact_chunks_and_restart_without_visibility() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.sqlite");
        let mut store = enrolled(&path);
        let empty = store
            .begin_binary_stage(
                &op("client"),
                &op("empty"),
                &request("empty", Some(0)),
                limits(),
            )
            .unwrap();
        let sealed_empty = store
            .seal_binary_stage(&empty, 0, Some(Sha256Digest::of(&[])))
            .unwrap();
        assert!(sealed_empty.manifest.pages.is_empty());
        assert_eq!(sealed_empty.manifest.bytes, 0);
        let full = store
            .begin_binary_stage(
                &op("client"),
                &op("full"),
                &request("full", Some(BINARY_STAGE_MAX_CHUNK_BYTES as u64)),
                limits(),
            )
            .unwrap();
        let body = vec![255; BINARY_STAGE_MAX_CHUNK_BYTES];
        store.append_binary_chunk(&full, 0, 0, &body).unwrap();
        let sealed = store
            .seal_binary_stage(&full, body.len() as u64, Some(Sha256Digest::of(&body)))
            .unwrap();
        assert_eq!(sealed.manifest.bytes, body.len() as u64);
        assert_eq!(sealed.manifest.digest, Sha256Digest::of(&body));
        assert_eq!(sealed.manifest.pages.len(), 1);
        assert!(store.append_binary_chunk(&full, 0, 0, &body).is_err());
        invisible(&store);
        drop(store);
        let mut store = Store::open(&path).unwrap();
        let resumed = store
            .resume_binary_stage(&op("client"), &op("full"))
            .unwrap()
            .unwrap();
        assert_eq!(
            store
                .seal_binary_stage(&resumed, body.len() as u64, Some(Sha256Digest::of(&body)))
                .unwrap(),
            sealed
        );
        assert_eq!(
            store.query_binary_stage(&resumed).unwrap().finalized,
            Some(sealed)
        );
        store.abort_binary_stage(&resumed).unwrap();
        assert_eq!(
            store.query_binary_stage(&resumed).unwrap().state,
            StagePhase::Aborted
        );
        invisible(&store);
    }

    #[test]
    fn stage_seal_request_is_durable_and_actual_bytes_are_reverified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.sqlite");
        let mut store = enrolled(&path);
        let bad = store
            .begin_binary_stage(&op("client"), &op("bad"), &request("bad", None), limits())
            .unwrap();
        store
            .append_binary_chunk(&bad, 0, 0, b"durable tail")
            .unwrap();
        let wrong = Sha256Digest::of(b"wrong");
        assert!(store.seal_binary_stage(&bad, 12, Some(wrong)).is_err());
        let page: String = store
            .connection
            .query_row(
                "SELECT update_id FROM binary_stage_allocations WHERE stage_id=?1 AND kind='page'",
                [bad.stage_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(store.query_binary_stage(&bad).unwrap().seal_requested);
        assert!(store
            .append_binary_chunk(&bad, 0, 0, b"durable tail")
            .is_err());
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert!(store.seal_binary_stage(&bad, 12, Some(wrong)).is_err());
        assert!(store.seal_binary_stage(&bad, 12, None).is_err());
        let page_after: String = store
            .connection
            .query_row(
                "SELECT update_id FROM binary_stage_allocations WHERE stage_id=?1 AND kind='page'",
                [bad.stage_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(page, page_after);
        store.abort_binary_stage(&bad).unwrap();

        let good = store
            .begin_binary_stage(&op("client"), &op("good"), &request("good", None), limits())
            .unwrap();
        store.append_binary_chunk(&good, 0, 0, b"original").unwrap();
        store.seal_binary_stage(&good, 8, None).unwrap();
        // Keep valid JSON and lengths, but alter the exact durable source.
        let raw: Vec<u8> = store
            .connection
            .query_row(
                "SELECT payload FROM binary_stage_chunks WHERE stage_id=?1",
                [good.stage_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        let mut payload = zorid_file_sync::v2::Payload::decode(&raw).unwrap();
        payload.body = zorid_file_sync::v2::Body::Chunk {
            bytes: b"tampered".to_vec(),
        };
        store
            .connection
            .execute(
                "UPDATE binary_stage_chunks SET payload=?1 WHERE stage_id=?2",
                params![payload.encode().unwrap(), good.stage_id.as_str()],
            )
            .unwrap();
        assert!(store.query_binary_stage(&good).is_err());
        assert!(store.seal_binary_stage(&good, 8, None).is_err());
        invisible(&store);
    }
}
