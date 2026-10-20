//! Native-only imports. The caller copies provider data into immutable app-owned
//! staging, persists its native selection, and serializes this host with dispatch.
//! Checkpoints retain recovery plans; only existing family/stage APIs publish.
use super::{admission_fault, EmbeddedHost};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_file_sync::{mutation::CreateMode, Sha256Digest};
#[cfg(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "ios",
    target_os = "android"
))]
use zorid_native::{select_external_file_mode, ExternalFileMode};
use zorid_native::{NativeVault, ProjectionStatus};
use zorid_store::{
    BinaryStageRef, BinaryStageRejectionCode, BinaryStageRequest, BinaryStageTerminal,
    BinaryTarget, CheckpointScope, CheckpointWrite, StagePhase, StreamingLimits,
    BINARY_STAGE_MAX_CHUNK_BYTES, BINARY_STAGE_MAX_FILE_BYTES,
};

pub const MAX_IMPORT_RESULT_BYTES: usize = 64 * 1024;
const MAX_SELECTION: usize = 8192;
// Existing zorid-client-sync MAX_TEXT_BYTES, enforced again by family_apply.
const MAX_TEXT: u64 = 1024 * 1024;
const MAX_PLAN: usize = 8 * 1024 * 1024; // Up to six JSON bytes per text byte, plus framing.
const MAX_NAMES: usize = 100;
type Result<T> = std::result::Result<T, Value>;
fn error(code: &'static str, uncertain: bool) -> Value {
    json!({"code":code,"commit_uncertain":uncertain})
}
fn storage(_: zorid_native::Error) -> Value {
    error("import_storage", true)
}
fn checkpoint(_: zorid_store::CheckpointError) -> Value {
    error("import_checkpoint", true)
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Auto,
    Text,
    Binary,
}
/// Native ABI decoder only. No Debug, source path, or renderer command variant.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedImportSelection {
    version: u32,
    client_id: String,
    local_store_id: String,
    // Ephemeral native admission witness, intentionally omitted from recovery
    // plans. A reopened host supplies its NEW exact lease, same durable identity.
    #[serde(skip_serializing, default)]
    lease_token: String,
    operation_id: String,
    entry_id: String,
    destination_folder: String,
    file_name: String,
    kind: Kind,
    expected_length: String,
    sha256: String,
}
impl TrustedImportSelection {
    pub fn from_native_json(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MAX_SELECTION {
            return Err(error("import_invalid_selection", false));
        }
        let value: Self =
            serde_json::from_slice(bytes).map_err(|_| error("import_invalid_selection", false))?;
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || !uuid(&self.client_id)
            || !uuid(&self.local_store_id)
            || !uuid(&self.lease_token)
            || !uuid(&self.operation_id)
            || !uuid(&self.entry_id)
            || self.file_name.is_empty()
            || self.file_name.len() > 255
            || self
                .file_name
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
            || matches!(self.file_name.as_str(), "." | "..")
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(error("import_invalid_selection", false));
        }
        if !self.destination_folder.is_empty() {
            VaultPath::new(self.destination_folder.clone())
                .map_err(|_| error("import_invalid_destination", false))?;
        }
        self.path(&self.file_name)?;
        let size = self.length()?;
        if size > BINARY_STAGE_MAX_FILE_BYTES || (self.kind == Kind::Text && size > MAX_TEXT) {
            return Err(error("import_too_large", false));
        }
        Ok(())
    }
    fn length(&self) -> Result<u64> {
        let n = &self.expected_length;
        if n.is_empty()
            || n.len() > 20
            || (n.len() > 1 && n.starts_with('0'))
            || !n.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(error("import_invalid_selection", false));
        }
        n.parse()
            .map_err(|_| error("import_invalid_selection", false))
    }
    fn digest(&self) -> Sha256Digest {
        let mut out = [0; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&self.sha256[i * 2..i * 2 + 2], 16).expect("validated hex");
        }
        Sha256Digest(out)
    }
    fn path(&self, name: &str) -> Result<VaultPath> {
        let path = if self.destination_folder.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{name}", self.destination_folder)
        };
        if path.len() > 4096 {
            return Err(error("import_invalid_destination", false));
        }
        VaultPath::new(path).map_err(|_| error("import_invalid_destination", false))
    }
    fn candidate(&self, index: usize) -> Result<VaultPath> {
        let name = if index == 0 {
            self.file_name.clone()
        } else {
            match self.file_name.rfind('.').filter(|i| *i > 0) {
                Some(i) => format!("{} ({index}){}", &self.file_name[..i], &self.file_name[i..]),
                None => format!("{} ({index})", self.file_name),
            }
        };
        if name.len() > 255 {
            return Err(error("import_invalid_destination", false));
        }
        self.path(&name)
    }
    fn choose_path(&self, vault: &NativeVault) -> Result<VaultPath> {
        if !self.destination_folder.is_empty() {
            let parent = VaultPath::new(self.destination_folder.clone())
                .map_err(|_| error("import_invalid_destination", false))?;
            if !vault
                .read_path_metadata(&parent)
                .map_err(storage)?
                .is_some_and(|e| !e.state.deleted && e.state.kind == EntryKind::Folder)
            {
                return Err(error("import_invalid_destination", false));
            }
        }
        for i in 0..MAX_NAMES {
            let p = self.candidate(i)?;
            if !vault
                .read_path_metadata(&p)
                .map_err(storage)?
                .is_some_and(|e| !e.state.deleted)
            {
                return Ok(p);
            }
        }
        Err(error("import_name_limit", false))
    }
}
/// Owned descriptor, never opened from a renderer/native JSON path. Native caller
/// guarantees app-owned immutable copy; regular-file/length/digest are verified.
pub struct TrustedStagedImportSource {
    file: File,
}
impl TrustedStagedImportSource {
    pub fn new(file: File) -> Result<Self> {
        let m = file
            .metadata()
            .map_err(|_| error("import_invalid_source", false))?;
        if !m.is_file() {
            return Err(error("import_invalid_source", false));
        }
        if m.len() > BINARY_STAGE_MAX_FILE_BYTES {
            return Err(error("import_too_large", false));
        }
        Ok(Self { file })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    operation_id: String,
    state: &'static str,
    processed_bytes: String,
    total_bytes: String,
    selected_path: String,
    commit_state: &'static str,
    projection_state: &'static str,
    can_retry_collision: bool,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Prepared,
    CommitRequested,
    Committed,
    Aborted,
    Collision,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    selection: TrustedImportSelection,
    path: VaultPath,
    phase: Phase,
    mode: Option<Kind>,
    content: Option<String>,
}
fn scope(s: &TrustedImportSelection) -> CheckpointScope {
    CheckpointScope {
        vault_id: OperationId::new(s.local_store_id.clone()).expect("validated store"),
        client_id: OperationId::new(s.client_id.clone()).expect("validated client"),
    }
}
fn key(s: &TrustedImportSelection) -> String {
    format!("native-staged-import-{}", s.operation_id)
}
fn load_plan(vault: &mut NativeVault, s: &TrustedImportSelection) -> Result<Option<Plan>> {
    let Some(cp) = vault
        .checkpoint_load(&scope(s), &key(s))
        .map_err(checkpoint)?
    else {
        return Ok(None);
    };
    let raw = cp
        .encoded_state
        .as_deref()
        .filter(|r| r.len() <= MAX_PLAN)
        .ok_or_else(|| error("import_checkpoint", true))?;
    let plan: Plan = serde_json::from_str(raw).map_err(|_| error("import_checkpoint", true))?;
    if plan.selection != *s
        || !(0..MAX_NAMES).any(|i| s.candidate(i).is_ok_and(|p| p == plan.path))
        || plan.mode == Some(Kind::Auto)
        || plan
            .content
            .as_ref()
            .is_some_and(|v| v.len() as u64 > MAX_TEXT)
        || (plan.mode == Some(Kind::Binary) && plan.content.is_some())
    {
        return Err(error("import_idempotency_conflict", true));
    }
    Ok(Some(plan))
}
fn save_plan(vault: &mut NativeVault, previous: Option<&Plan>, next: &Plan) -> Result<()> {
    let scope = scope(&next.selection);
    let key = key(&next.selection);
    let old = vault.checkpoint_load(&scope, &key).map_err(checkpoint)?;
    let encoded = serde_json::to_string(next).map_err(|_| error("import_checkpoint", true))?;
    if encoded.len() > MAX_PLAN {
        return Err(error("import_checkpoint", true));
    }
    if old.as_ref().and_then(|c| c.encoded_state.as_deref()) == Some(encoded.as_str()) {
        return Ok(());
    }
    match (&old, previous) {
        (None, None) => {}
        (Some(cp), Some(p))
            if cp.encoded_state.as_deref()
                == Some(
                    serde_json::to_string(p)
                        .map_err(|_| error("import_checkpoint", true))?
                        .as_str(),
                ) => {}
        _ => return Err(error("import_idempotency_conflict", true)),
    }
    // Body is already committed by selection.sha256. Revision allocation hashes
    // bounded metadata, never a second whole-file/text hash during this step.
    let revision_input = serde_json::to_vec(&json!({
        "selection":next.selection,"path":next.path,"phase":next.phase,"mode":next.mode,
    }))
    .map_err(|_| error("import_checkpoint", true))?;
    let d = Sha256::digest(&revision_input);
    let hex: String = d[..16].iter().map(|b| format!("{b:02x}")).collect();
    let revision = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    vault
        .checkpoint_compare_and_swap(
            &scope,
            CheckpointWrite {
                key: &key,
                expected_revision: old.as_ref().map(|v| v.revision.as_str()),
                next_revision: &revision,
                encoded_state: Some(&encoded),
            },
        )
        .map_err(checkpoint)?;
    Ok(())
}
// Strict incremental UTF-8 facts; only an incomplete final scalar crosses a
// chunk boundary. The existing native classifier owns all extension/NUL policy.
#[derive(Default)]
struct Utf8Facts {
    tail: Vec<u8>,
    invalid: bool,
    nul: bool,
}
impl Utf8Facts {
    fn push(&mut self, bytes: &[u8]) {
        self.nul |= bytes.contains(&0);
        if self.invalid {
            return;
        }
        let mut joined = std::mem::take(&mut self.tail);
        joined.extend_from_slice(bytes);
        if let Err(e) = std::str::from_utf8(&joined) {
            if e.error_len().is_some() {
                self.invalid = true;
            } else {
                self.tail.extend_from_slice(&joined[e.valid_up_to()..]);
            }
        }
    }
    fn mode(&self, path: &VaultPath, kind: Kind) -> Result<Kind> {
        let valid = !self.invalid && self.tail.is_empty();
        // Small witness encodes only facts, not content. This calls the EXISTING
        // public classifier rather than duplicating its extension/NUL rules.
        let witness: &[u8] = if !valid {
            &[255]
        } else if self.nul {
            &[0]
        } else {
            b"a"
        };
        #[cfg(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "ios",
            target_os = "android"
        ))]
        let policy = match kind {
            Kind::Auto => ExternalFileMode::Auto,
            Kind::Text => ExternalFileMode::Text,
            Kind::Binary => ExternalFileMode::Binary,
        };
        #[cfg(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "ios",
            target_os = "android"
        ))]
        let mode = select_external_file_mode(path, witness, policy)
            .map_err(|_| error("import_invalid_text", false))?;
        #[cfg(not(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "ios",
            target_os = "android"
        )))]
        let mode: CreateMode = {
            let _ = (path, witness, kind);
            return Err(error("import_unsupported", false));
        };
        Ok(if mode == CreateMode::Text {
            Kind::Text
        } else {
            Kind::Binary
        })
    }
}
pub(super) struct StagedImport {
    plan: Plan,
    lease_token: String,
    source: Option<File>,
    stage: Option<BinaryStageRef>,
    hash: Sha256,
    facts: Utf8Facts,
    hashed: u64,
    uploaded: u64,
    text: Vec<u8>,
    state: &'static str,
    projected: bool,
    uncertain: bool,
}
impl StagedImport {
    fn terminal(&self) -> bool {
        matches!(self.state, "committed" | "collision" | "aborted")
    }
    fn progress(&self) -> ImportProgress {
        ImportProgress {
            operation_id: self.plan.selection.operation_id.clone(),
            state: self.state,
            processed_bytes: if self.state == "hashing" {
                self.hashed
            } else {
                self.uploaded
            }
            .to_string(),
            total_bytes: self.plan.selection.expected_length.clone(),
            selected_path: self.plan.path.as_str().into(),
            commit_state: match self.state {
                "committed" => "committed",
                "collision" => "rejected",
                "aborted" => "aborted",
                _ if self.uncertain => "requested",
                _ => "not_requested",
            },
            projection_state: if self.projected {
                "projected"
            } else if self.state == "committed" {
                "pending"
            } else {
                "not_started"
            },
            can_retry_collision: self.state == "collision",
        }
    }
    fn transition(&mut self, vault: &mut NativeVault, next: Plan) -> Result<()> {
        match save_plan(vault, Some(&self.plan), &next) {
            Ok(()) => {
                self.plan = next;
                Ok(())
            }
            Err(e) => {
                // Resolve a lost CAS acknowledgement to the same exact record.
                if load_plan(vault, &next.selection).ok().flatten().as_ref() == Some(&next) {
                    self.plan = next;
                }
                Err(e)
            }
        }
    }
    fn read_chunk(&self, offset: u64) -> Result<Vec<u8>> {
        let size = self.plan.selection.length()?;
        let n = size
            .checked_sub(offset)
            .ok_or_else(|| error("import_source_changed", self.uncertain))?
            .min(BINARY_STAGE_MAX_CHUNK_BYTES as u64) as usize;
        if let Some(file) = &self.source {
            if file
                .metadata()
                .map_err(|_| error("import_source_changed", self.uncertain))?
                .len()
                != size
            {
                return Err(error("import_source_changed", self.uncertain));
            }
            let mut bytes = vec![0; n];
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileExt;
                let mut used = 0;
                while used < n {
                    match file.read_at(&mut bytes[used..], offset + used as u64) {
                        Ok(0) => return Err(error("import_source_changed", self.uncertain)),
                        Ok(m) => used += m,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => return Err(error("import_source_changed", self.uncertain)),
                    }
                }
            }
            #[cfg(not(unix))]
            {
                return Err(error("import_unsupported", false));
            }
            Ok(bytes)
        } else {
            let bytes = self
                .plan
                .content
                .as_ref()
                .ok_or_else(|| error("import_invalid_source", self.uncertain))?
                .as_bytes();
            if bytes.len() as u64 != size {
                return Err(error("import_source_changed", self.uncertain));
            }
            Ok(bytes[offset as usize..offset as usize + n].to_vec())
        }
    }
    fn refresh_binary(&mut self, vault: &NativeVault) -> Result<StagePhase> {
        let stage = self.stage.as_ref().expect("binary stage");
        let status = vault.query_binary_stage(stage).map_err(storage)?;
        if matches!(
            status.state,
            StagePhase::Sealed | StagePhase::CommitRequested | StagePhase::Committed
        ) && status.finalized.is_none()
        {
            return Err(error("import_idempotency_conflict", true));
        }
        if let Some(m) = &status.finalized {
            if m.manifest().bytes != self.plan.selection.length()?
                || m.manifest().digest != self.plan.selection.digest()
            {
                return Err(error("import_idempotency_conflict", true));
            }
        }
        match (&status.state, &status.terminal) {
            (StagePhase::Committed, Some(BinaryStageTerminal::Committed(_))) => {
                self.state = "committed";
                self.uncertain = false;
                self.uploaded = self.plan.selection.length()?;
                // The durable receipt has already proved commit. Failure to
                // inspect publication may only downgrade to pending projection.
                self.projected = matches!(
                    vault.binary_stage_projection_status(stage),
                    Ok(ProjectionStatus::Projected)
                );
            }
            (StagePhase::Rejected, Some(BinaryStageTerminal::Rejected(r))) => {
                self.uncertain = false;
                if r.code == BinaryStageRejectionCode::PathConflict {
                    self.state = "collision";
                } else {
                    return Err(error("import_target_rejected", false));
                }
            }
            (StagePhase::Aborted, _) => {
                self.state = "aborted";
                self.uncertain = false;
            }
            (StagePhase::CommitRequested, _) => {
                self.uncertain = true;
            }
            _ => {}
        }
        Ok(status.state)
    }
    fn begin_binary(&mut self, vault: &mut NativeVault) -> Result<()> {
        let s = &self.plan.selection;
        let client = OperationId::new(s.client_id.clone()).expect("validated client");
        let operation = OperationId::new(s.operation_id.clone()).expect("validated operation");
        self.stage = Some(
            vault
                .begin_binary_stage(
                    &client,
                    &operation,
                    &BinaryStageRequest {
                        target: BinaryTarget::Create {
                            id: EntryId::new(s.entry_id.clone()).expect("validated entry"),
                            path: self.plan.path.clone(),
                        },
                        expected_length: Some(s.length()?),
                    },
                    StreamingLimits {
                        max_active_stages: 8,
                        max_stage_records: 4096,
                        max_staged_bytes: 512 * 1024 * 1024,
                        max_chunk_records: 4096,
                        max_page_records: 256,
                    },
                )
                .map_err(storage)?,
        );
        Ok(())
    }
    fn step(&mut self, vault: &mut NativeVault) -> Result<ImportProgress> {
        if self.stage.is_some() {
            self.refresh_binary(vault)?;
        }
        if self.terminal() {
            return Ok(self.progress());
        }
        if self.state == "hashing" {
            let bytes = self.read_chunk(self.hashed)?;
            self.hash.update(&bytes);
            self.facts.push(&bytes);
            if self.plan.selection.length()? <= MAX_TEXT {
                self.text.extend_from_slice(&bytes);
            }
            self.hashed += bytes.len() as u64;
            if self.hashed == self.plan.selection.length()? {
                let digest: [u8; 32] = self.hash.clone().finalize().into();
                if digest != self.plan.selection.digest().0 {
                    return Err(error("import_source_changed", self.uncertain));
                }
                let mode = self.facts.mode(&self.plan.path, self.plan.selection.kind)?;
                if mode == Kind::Text && self.hashed > MAX_TEXT {
                    return Err(error("import_too_large", self.uncertain));
                }
                if self.plan.mode.is_some_and(|m| m != mode) {
                    return Err(error("import_idempotency_conflict", self.uncertain));
                }
                let mut next = self.plan.clone();
                next.mode = Some(mode);
                if mode == Kind::Text {
                    next.content = Some(
                        std::str::from_utf8(&self.text)
                            .map_err(|_| error("import_invalid_text", self.uncertain))?
                            .to_owned(),
                    );
                }
                self.transition(vault, next)?;
                if mode == Kind::Binary && self.stage.is_none() {
                    self.begin_binary(vault)?;
                }
                self.state = "receiving";
            }
            return Ok(self.progress());
        }
        if self.plan.mode == Some(Kind::Text) {
            if self.plan.phase == Phase::Prepared {
                let mut next = self.plan.clone();
                next.phase = Phase::CommitRequested;
                self.uncertain = true;
                self.transition(vault, next)?;
                self.state = "commit_requested";
                return Ok(self.progress());
            }
            self.state = "commit_requested";
            self.uncertain = true;
            let content = self
                .plan
                .content
                .as_ref()
                .expect("verified text")
                .as_bytes()
                .to_vec();
            let result = vault.family_apply(
                &MutationRequest {
                    operation_id: OperationId::new(self.plan.selection.operation_id.clone())
                        .expect("validated operation"),
                    mutation: Mutation::Create {
                        id: EntryId::new(self.plan.selection.entry_id.clone())
                            .expect("validated entry"),
                        path: self.plan.path.clone(),
                        kind: EntryKind::File,
                        content: Some(content),
                    },
                },
                Some(CreateMode::Text),
            );
            match result {
                Ok(outcome) => {
                    // Receipt outranks checkpoint/projection acknowledgement. A
                    // failed plan write cannot turn this committed file into failure.
                    self.projected = matches!(outcome.projection, ProjectionStatus::Projected);
                    self.state = "committed";
                    self.uncertain = false;
                    self.uploaded = self.plan.selection.length()?;
                    let mut next = self.plan.clone();
                    next.phase = Phase::Committed;
                    let _ = self.transition(vault, next);
                }
                Err(e) => {
                    // This specific synchronous contract rejection occurs before
                    // any family commit. No I/O/unknown error authorizes a new ID.
                    let conflict = match &e {
                        zorid_native::Error::Contract(
                            zorid_core::ContractError::InvalidMutation { reason },
                        )
                        | zorid_native::Error::Store(zorid_store::StoreError::Contract(
                            zorid_core::ContractError::InvalidMutation { reason },
                        )) => reason == "destination path is occupied",
                        _ => false,
                    };
                    if !conflict {
                        return Err(storage(e));
                    }
                    let mut next = self.plan.clone();
                    next.phase = Phase::Collision;
                    self.transition(vault, next)?;
                    self.state = "collision";
                    self.uncertain = false;
                }
            }
            return Ok(self.progress());
        }
        if self.stage.is_none() {
            self.begin_binary(vault)?;
        }
        let phase = self.refresh_binary(vault)?;
        let stage = self.stage.as_ref().expect("binary stage");
        match phase {
            StagePhase::Receiving => {
                let status = vault.query_binary_stage(stage).map_err(storage)?;
                if self.uploaded < self.plan.selection.length()? && !status.seal_requested {
                    let bytes = self.read_chunk(self.uploaded)?;
                    vault
                        .append_binary_chunk(
                            stage,
                            (self.uploaded / BINARY_STAGE_MAX_CHUNK_BYTES as u64) as u32,
                            self.uploaded,
                            &bytes,
                        )
                        .map_err(storage)?;
                    self.uploaded += bytes.len() as u64;
                } else {
                    vault
                        .seal_binary_stage(
                            stage,
                            self.plan.selection.length()?,
                            Some(self.plan.selection.digest()),
                        )
                        .map_err(storage)?;
                    self.state = "sealed";
                }
            }
            StagePhase::Sealed => {
                self.uncertain = true;
                // Authorization can persist a definitive rejection and then
                // return Err. Resolve THIS original stage before interpreting
                // that error, just as at the later commit boundary. Only the
                // Store-issued terminal PathConflict permits a keep-both retry.
                let result = vault.request_commit_binary_stage(stage);
                let refreshed = self.refresh_binary(vault);
                if self.terminal() {
                    refreshed?;
                } else {
                    result.map_err(storage)?;
                    refreshed?;
                    self.state = "commit_requested";
                }
            }
            StagePhase::CommitRequested => {
                self.uncertain = true;
                let result = vault.commit_binary_stage(stage);
                let refreshed = self.refresh_binary(vault);
                if self.terminal() {
                    refreshed?;
                } else {
                    result.map_err(storage)?;
                    refreshed?;
                }
            }
            _ => {}
        }
        Ok(self.progress())
    }
    fn cancel(&mut self, vault: &mut NativeVault) -> Result<ImportProgress> {
        if self.stage.is_some() {
            let phase = self.refresh_binary(vault)?;
            if !self.terminal() && phase != StagePhase::CommitRequested {
                vault
                    .abort_binary_stage(self.stage.as_ref().expect("binary stage"))
                    .map_err(storage)?;
                self.refresh_binary(vault)?;
            } else if phase == StagePhase::CommitRequested {
                self.state = "commit_requested";
            }
        } else if !self.terminal() {
            if self.plan.phase == Phase::Prepared && !self.uncertain {
                let mut next = self.plan.clone();
                next.phase = Phase::Aborted;
                self.transition(vault, next)?;
                self.state = "aborted";
            } else {
                // Recovery may still be validating retained text. Cancellation
                // cannot skip that hash/UTF-8 gate and enter family_apply.
                if self.state != "hashing" {
                    self.state = "commit_requested";
                }
                self.uncertain = true;
            }
        }
        Ok(self.progress())
    }
}
impl EmbeddedHost {
    fn import_admission(&self, client: &str, store: &str) -> Result<String> {
        if self.leases.active.len() != 1 {
            return Err(error("client_not_admitted", false));
        }
        let lease = self.leases.active.values().next().expect("one lease");
        let r = lease.reference();
        if r.client_id.as_str() != client || r.local_store_id.as_str() != store {
            return Err(error("client_scope_mismatch", false));
        }
        self.vault
            .verify_client_lease(lease)
            .map_err(admission_fault)?;
        Ok(r.token.as_str().into())
    }
    /// Native-only. None is permitted for source-free recovery of sealed binary
    /// stages or retained text intents; a fresh/receiving item requires a file.
    pub fn staged_import_begin(
        &mut self,
        source: Option<TrustedStagedImportSource>,
        mut selection: TrustedImportSelection,
    ) -> Result<ImportProgress> {
        selection.validate()?;
        let token = self.import_admission(&selection.client_id, &selection.local_store_id)?;
        if token != selection.lease_token {
            return Err(error("client_not_admitted", false));
        }
        selection.lease_token.clear();
        if let Some(job) = &self.leases.staged_import {
            if job.plan.selection.operation_id == selection.operation_id {
                if job.plan.selection != selection || job.lease_token != token {
                    return Err(error("import_idempotency_conflict", job.uncertain));
                }
                return self.staged_import_status(&selection.operation_id);
            }
            if !job.terminal() {
                return Err(error("import_busy", job.uncertain));
            }
        }
        let saved = load_plan(&mut self.vault, &selection)?;
        // Validate caller file only AFTER locating existing recovery state.
        let plan = match saved {
            Some(p) => p,
            None => {
                let f = source
                    .as_ref()
                    .ok_or_else(|| error("import_invalid_source", false))?;
                if f.file
                    .metadata()
                    .map_err(|_| error("import_invalid_source", false))?
                    .len()
                    != selection.length()?
                {
                    return Err(error("import_source_changed", false));
                }
                let p = Plan {
                    path: selection.choose_path(&self.vault)?,
                    selection: selection.clone(),
                    phase: Phase::Prepared,
                    mode: None,
                    content: None,
                };
                save_plan(&mut self.vault, None, &p)?;
                p
            }
        };
        let mut job = StagedImport {
            plan,
            lease_token: token,
            source: source.map(|s| s.file),
            stage: None,
            hash: Sha256::new(),
            facts: Utf8Facts::default(),
            hashed: 0,
            uploaded: 0,
            text: Vec::new(),
            state: "hashing",
            projected: false,
            uncertain: false,
        };
        if job.plan.mode == Some(Kind::Binary) {
            let client = OperationId::new(selection.client_id.clone()).expect("validated client");
            let operation =
                OperationId::new(selection.operation_id.clone()).expect("validated operation");
            if let Some(stage) = self
                .vault
                .resume_binary_stage(&client, &operation)
                .map_err(storage)?
            {
                let request = self.vault.binary_stage_request(&stage).map_err(storage)?;
                if request
                    != (BinaryStageRequest {
                        target: BinaryTarget::Create {
                            id: EntryId::new(selection.entry_id.clone()).expect("validated entry"),
                            path: job.plan.path.clone(),
                        },
                        expected_length: Some(selection.length()?),
                    })
                {
                    return Err(error("import_idempotency_conflict", true));
                }
                job.stage = Some(stage);
                let phase = job.refresh_binary(&self.vault)?;
                if matches!(phase, StagePhase::Sealed | StagePhase::CommitRequested) {
                    job.hashed = selection.length()?;
                    job.uploaded = selection.length()?;
                    job.state = if phase == StagePhase::Sealed {
                        "sealed"
                    } else {
                        "commit_requested"
                    };
                }
            }
        }
        if job.stage.is_none() {
            if job.plan.phase == Phase::Aborted {
                job.state = "aborted";
            }
            if job.plan.phase == Phase::Collision {
                // Definitive rejection already permitted a new keep-both
                // attempt. Never resurrect this old Create if its path later
                // becomes free, even to try to discover a receipt by mutation.
                job.state = "collision";
            }
            if matches!(job.plan.phase, Phase::CommitRequested | Phase::Committed) {
                job.uncertain = true;
            }
            // Only uncertain/committed text intents replay their exact retained
            // request. Aborted/rejected plans are sticky terminal outcomes.
        }
        if !job.terminal()
            && job.state == "hashing"
            && job.source.is_none()
            && job.plan.content.is_none()
        {
            return Err(error("import_invalid_source", job.uncertain));
        }
        if !job.terminal() && job.state == "hashing" {
            if let Some(file) = &job.source {
                if file
                    .metadata()
                    .map_err(|_| error("import_invalid_source", job.uncertain))?
                    .len()
                    != selection.length()?
                {
                    return Err(error("import_source_changed", job.uncertain));
                }
            }
        }
        let answer = job.progress();
        self.leases.staged_import = Some(job);
        Ok(answer)
    }
    fn import_job(
        &mut self,
        operation: &str,
        action: impl FnOnce(&mut StagedImport, &mut NativeVault) -> Result<ImportProgress>,
    ) -> Result<ImportProgress> {
        let job = self
            .leases
            .staged_import
            .as_ref()
            .ok_or_else(|| error("import_not_found", false))?;
        if job.plan.selection.operation_id != operation {
            return Err(error("import_not_found", false));
        }
        let token = self.import_admission(
            &job.plan.selection.client_id,
            &job.plan.selection.local_store_id,
        )?;
        if token != job.lease_token {
            return Err(error("client_not_admitted", job.uncertain));
        }
        let mut job = self.leases.staged_import.take().expect("checked job");
        let result = action(&mut job, &mut self.vault);
        self.leases.staged_import = Some(job);
        result
    }
    pub fn staged_import_step(&mut self, operation: &str) -> Result<ImportProgress> {
        self.import_job(operation, |j, v| j.step(v))
    }
    pub fn staged_import_status(&mut self, operation: &str) -> Result<ImportProgress> {
        self.import_job(operation, |j, v| {
            if j.stage.is_some() {
                j.refresh_binary(v)?;
            }
            Ok(j.progress())
        })
    }
    pub fn staged_import_cancel(&mut self, operation: &str) -> Result<ImportProgress> {
        self.import_job(operation, |j, v| j.cancel(v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    const CLIENT: &str = "abcdefab-0000-4000-8000-000000000001";
    const OP: &str = "abcdefab-0000-4000-8000-000000000002";
    const ENTRY: &str = "abcdefab-0000-4000-8000-000000000003";
    fn admit(host: &mut EmbeddedHost) {
        let lease = host
            .vault
            .claim_client(&OperationId::new(CLIENT).unwrap())
            .unwrap();
        host.leases
            .active
            .insert(lease.reference().token.as_str().into(), lease);
    }
    fn setup() -> (tempfile::TempDir, EmbeddedHost) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("vault")).unwrap();
        let mut host = EmbeddedHost::open_local(&dir.path().join("vault")).unwrap();
        admit(&mut host);
        (dir, host)
    }
    fn selection(
        host: &EmbeddedHost,
        bytes: &[u8],
        name: &str,
        kind: &str,
        op: &str,
        entry: &str,
    ) -> TrustedImportSelection {
        let sha: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        TrustedImportSelection::from_native_json(
            &serde_json::to_vec(&json!({"version":1,
            "clientId":CLIENT,"localStoreId":host.vault.identity().unwrap().local_store_id.as_str(),
            "leaseToken":host.leases.active.values().next().unwrap().reference().token.as_str(),
            "operationId":op,"entryId":entry,"destinationFolder":"","fileName":name,"kind":kind,
            "expectedLength":bytes.len().to_string(),"sha256":sha}))
            .unwrap(),
        )
        .unwrap()
    }
    fn source(dir: &std::path::Path, bytes: &[u8]) -> TrustedStagedImportSource {
        let mut file = File::create(dir.join("source")).unwrap();
        file.write_all(bytes).unwrap();
        drop(file);
        TrustedStagedImportSource::new(File::open(dir.join("source")).unwrap()).unwrap()
    }
    fn finish(host: &mut EmbeddedHost, op: &str) -> ImportProgress {
        for _ in 0..40 {
            let p = host.staged_import_step(op).unwrap();
            if matches!(p.state, "committed" | "collision" | "aborted") {
                return p;
            }
        }
        panic!("bounded fixture did not settle")
    }
    #[test]
    fn binary_chunk_boundaries_preserve_exact_bytes() {
        for n in [
            0,
            1,
            BINARY_STAGE_MAX_CHUNK_BYTES - 1,
            BINARY_STAGE_MAX_CHUNK_BYTES,
            BINARY_STAGE_MAX_CHUNK_BYTES + 1,
        ] {
            let (dir, mut host) = setup();
            let bytes = vec![0x91; n];
            let s = selection(&host, &bytes, "photo.bin", "auto", OP, ENTRY);
            host.staged_import_begin(Some(source(dir.path(), &bytes)), s)
                .unwrap();
            let done = finish(&mut host, OP);
            assert_eq!(done.state, "committed");
            assert!(!done.can_retry_collision);
            assert_eq!(
                std::fs::read(dir.path().join("vault/photo.bin")).unwrap(),
                bytes
            );
        }
    }
    #[test]
    fn source_mutation_rejected_before_publication_and_can_abort() {
        let (dir, mut host) = setup();
        let s = selection(&host, b"original", "x.bin", "binary", OP, ENTRY);
        host.staged_import_begin(Some(source(dir.path(), b"original")), s)
            .unwrap();
        std::fs::write(dir.path().join("source"), b"changed!").unwrap();
        assert_eq!(
            host.staged_import_step(OP).err().unwrap()["code"],
            "import_source_changed"
        );
        assert!(!dir.path().join("vault/x.bin").exists());
        assert_eq!(host.staged_import_cancel(OP).unwrap().state, "aborted");
    }
    #[test]
    fn released_and_replaced_lease_cannot_continue_old_job() {
        let (dir, mut host) = setup();
        let s = selection(&host, b"a", "x.bin", "binary", OP, ENTRY);
        host.staged_import_begin(Some(source(dir.path(), b"a")), s.clone())
            .unwrap();
        host.leases.active.clear();
        assert_eq!(
            host.staged_import_status(OP).err().unwrap()["code"],
            "client_not_admitted"
        );
        admit(&mut host);
        assert_eq!(
            host.staged_import_step(OP).err().unwrap()["code"],
            "client_not_admitted"
        );
        assert_eq!(
            host.staged_import_begin(None, s).err().unwrap()["code"],
            "client_not_admitted"
        );
    }
    #[test]
    fn append_restart_replays_old_receipt_and_committed_restart_needs_no_source() {
        let (dir, mut host) = setup();
        let bytes = vec![19; BINARY_STAGE_MAX_CHUNK_BYTES + 3];
        let mut s = selection(&host, &bytes, "x.bin", "binary", OP, ENTRY);
        host.staged_import_begin(Some(source(dir.path(), &bytes)), s.clone())
            .unwrap();
        while host.staged_import_step(OP).unwrap().state == "hashing" {}
        host.staged_import_step(OP).unwrap(); // Durable first chunk; forget response/generation.
        drop(host);
        let mut host = EmbeddedHost::open_local(&dir.path().join("vault")).unwrap();
        admit(&mut host);
        s.lease_token = host
            .leases
            .active
            .values()
            .next()
            .unwrap()
            .reference()
            .token
            .as_str()
            .into();
        host.staged_import_begin(
            Some(
                TrustedStagedImportSource::new(File::open(dir.path().join("source")).unwrap())
                    .unwrap(),
            ),
            s.clone(),
        )
        .unwrap();
        assert_eq!(finish(&mut host, OP).state, "committed");
        drop(host);
        std::fs::remove_file(dir.path().join("source")).unwrap();
        let mut host = EmbeddedHost::open_local(&dir.path().join("vault")).unwrap();
        admit(&mut host);
        s.lease_token = host
            .leases
            .active
            .values()
            .next()
            .unwrap()
            .reference()
            .token
            .as_str()
            .into();
        assert_eq!(
            host.staged_import_begin(None, s).unwrap().state,
            "committed"
        );
        assert_eq!(
            std::fs::read(dir.path().join("vault/x.bin")).unwrap(),
            bytes
        );
        assert_eq!(host.vault.list_snapshot().unwrap().entries.len(), 1);
    }
    #[test]
    fn text_intent_survives_missing_source_and_cancel_does_not_skip_validation() {
        let (dir, mut host) = setup();
        let bytes = b"\xef\xbb\xbfUnicode \xe9\x9b\xaa\r\n";
        let mut s = selection(&host, bytes, "note.md", "auto", OP, ENTRY);
        host.staged_import_begin(Some(source(dir.path(), bytes)), s.clone())
            .unwrap();
        assert_eq!(host.staged_import_step(OP).unwrap().state, "receiving");
        assert_eq!(
            host.staged_import_step(OP).unwrap().state,
            "commit_requested"
        );
        drop(host);
        std::fs::remove_file(dir.path().join("source")).unwrap();
        let mut host = EmbeddedHost::open_local(&dir.path().join("vault")).unwrap();
        admit(&mut host);
        s.lease_token = host
            .leases
            .active
            .values()
            .next()
            .unwrap()
            .reference()
            .token
            .as_str()
            .into();
        assert_eq!(host.staged_import_begin(None, s).unwrap().state, "hashing");
        let cancelled = host.staged_import_cancel(OP).unwrap();
        assert_eq!(cancelled.state, "hashing");
        assert_eq!(cancelled.commit_state, "requested");
        assert_eq!(finish(&mut host, OP).state, "committed");
        assert_eq!(
            std::fs::read(dir.path().join("vault/note.md")).unwrap(),
            bytes
        );
    }
    #[test]
    fn known_name_collision_keeps_both_and_commit_race_requires_explicit_new_ids() {
        let (dir, mut host) = setup();
        let s = selection(&host, b"first", "photo.bin", "binary", OP, ENTRY);
        host.staged_import_begin(Some(source(dir.path(), b"first")), s)
            .unwrap();
        finish(&mut host, OP);
        let op = "abcdefab-0000-4000-8000-000000000004";
        let entry = "abcdefab-0000-4000-8000-000000000005";
        let s = selection(&host, b"second", "photo.bin", "binary", op, entry);
        let started = host
            .staged_import_begin(Some(source(dir.path(), b"second")), s.clone())
            .unwrap();
        assert_eq!(started.selected_path, "photo (1).bin");
        host.vault
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("competing_operation").unwrap(),
                    mutation: Mutation::Create {
                        id: EntryId::new("competing_entry").unwrap(),
                        path: VaultPath::new("photo (1).bin").unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"racer".to_vec()),
                    },
                },
                Some(CreateMode::Binary),
            )
            .unwrap();
        // Drive to sealed, then race at commit AUTHORIZATION, not just final
        // commit. Store records terminal rejection before returning its error.
        for _ in 0..10 {
            if host.staged_import_step(op).unwrap().state == "sealed" {
                break;
            }
        }
        assert_eq!(host.staged_import_status(op).unwrap().state, "sealed");
        let done = host.staged_import_step(op).unwrap();
        assert_eq!(done.state, "collision");
        assert!(done.can_retry_collision);
        assert_eq!(done.commit_state, "rejected");
        let original_stage = host
            .leases
            .staged_import
            .as_ref()
            .unwrap()
            .stage
            .as_ref()
            .unwrap();
        let terminal = host.vault.query_binary_stage(original_stage).unwrap();
        assert_eq!(terminal.state, StagePhase::Rejected);
        assert!(matches!(terminal.terminal,
            Some(BinaryStageTerminal::Rejected(reason))
                if reason.code == BinaryStageRejectionCode::PathConflict));
        assert_eq!(
            host.staged_import_begin(None, s).unwrap().state,
            "collision"
        );
        let s = selection(
            &host,
            b"second",
            "photo.bin",
            "binary",
            "abcdefab-0000-4000-8000-000000000006",
            "abcdefab-0000-4000-8000-000000000007",
        );
        assert_eq!(
            host.staged_import_begin(Some(source(dir.path(), b"second")), s)
                .unwrap()
                .selected_path,
            "photo (2).bin"
        );
        assert_eq!(
            std::fs::read(dir.path().join("vault/photo.bin")).unwrap(),
            b"first"
        );
        assert_eq!(
            std::fs::read(dir.path().join("vault/photo (1).bin")).unwrap(),
            b"racer"
        );
    }
    #[test]
    fn one_mib_text_escaped_import_checkpoint_survives_reopen() {
        let (dir, mut host) = setup();
        let content = "\u{1}".repeat(MAX_TEXT as usize);
        let mut selected = selection(&host, content.as_bytes(), "large.md", "text", OP, ENTRY);
        selected.lease_token.clear();
        let plan = Plan { selection: selected.clone(), path: VaultPath::new("large.md").unwrap(),
            phase: Phase::CommitRequested, mode: Some(Kind::Text), content: Some(content) };
        let bytes = serde_json::to_vec(&plan).unwrap();
        assert!(bytes.len() > 6 * MAX_TEXT as usize && bytes.len() < MAX_PLAN);
        save_plan(&mut host.vault, None, &plan).unwrap();
        drop(host);
        let mut reopened = EmbeddedHost::open_local(&dir.path().join("vault")).unwrap();
        assert!(load_plan(&mut reopened.vault, &selected).unwrap().as_ref() == Some(&plan));
    }
    #[test]
    fn text_limits_auto_policy_and_utf8_boundaries_use_existing_core() {
        let (dir, mut host) = setup();
        let bytes = vec![b'a'; MAX_TEXT as usize + 1];
        let mut raw =
            serde_json::to_value(selection(&host, b"a", "note.md", "auto", OP, ENTRY)).unwrap();
        raw["leaseToken"] = json!(host
            .leases
            .active
            .values()
            .next()
            .unwrap()
            .reference()
            .token
            .as_str());
        raw["expectedLength"] = json!(bytes.len().to_string());
        let sha: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        raw["sha256"] = json!(sha);
        let s =
            TrustedImportSelection::from_native_json(&serde_json::to_vec(&raw).unwrap()).unwrap();
        host.staged_import_begin(Some(source(dir.path(), &bytes)), s)
            .unwrap();
        while host.leases.staged_import.as_ref().unwrap().hashed
            + (BINARY_STAGE_MAX_CHUNK_BYTES as u64)
            < bytes.len() as u64
        {
            host.staged_import_step(OP).unwrap();
        }
        assert_eq!(
            host.staged_import_step(OP).err().unwrap()["code"],
            "import_too_large"
        );
        let mut facts = Utf8Facts::default();
        facts.push(&[0xe9, 0x9b]);
        facts.push(&[0xaa]);
        assert!(
            facts
                .mode(&VaultPath::new("custom.data").unwrap(), Kind::Auto)
                .unwrap()
                == Kind::Text
        );
        facts.push(&[0]);
        assert!(
            facts
                .mode(&VaultPath::new("custom.data").unwrap(), Kind::Auto)
                .unwrap()
                == Kind::Binary
        );
        raw["kind"] = json!("text");
        assert_eq!(
            TrustedImportSelection::from_native_json(&serde_json::to_vec(&raw).unwrap())
                .err()
                .unwrap()["code"],
            "import_too_large"
        );
        raw["kind"] = json!("binary");
        raw["expectedLength"] = json!((BINARY_STAGE_MAX_FILE_BYTES + 1).to_string());
        assert_eq!(
            TrustedImportSelection::from_native_json(&serde_json::to_vec(&raw).unwrap())
                .err()
                .unwrap()["code"],
            "import_too_large"
        );
    }
    #[test]
    fn invalid_source_or_destination_and_changed_retry_metadata_do_not_publish() {
        let (dir, mut host) = setup();
        assert_eq!(
            TrustedStagedImportSource::new(File::open(dir.path()).unwrap())
                .err()
                .unwrap()["code"],
            "import_invalid_source"
        );
        let s = selection(&host, b"a", "x.bin", "binary", OP, ENTRY);
        let mut wrong = s.clone();
        wrong.local_store_id = "abcdefab-0000-4000-8000-000000000009".into();
        assert_eq!(
            host.staged_import_begin(None, wrong).err().unwrap()["code"],
            "client_scope_mismatch"
        );
        host.staged_import_begin(Some(source(dir.path(), b"a")), s.clone())
            .unwrap();
        let mut changed = s;
        changed.file_name = "other.bin".into();
        assert_eq!(
            host.staged_import_begin(None, changed).err().unwrap()["code"],
            "import_idempotency_conflict"
        );
    }
    #[test]
    fn regular_source_size_budget_includes_exact_binary_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = File::create(dir.path().join("sparse")).unwrap();
        file.set_len(BINARY_STAGE_MAX_FILE_BYTES).unwrap();
        assert!(TrustedStagedImportSource::new(file.try_clone().unwrap()).is_ok());
        file.set_len(BINARY_STAGE_MAX_FILE_BYTES + 1).unwrap();
        assert_eq!(
            TrustedStagedImportSource::new(file).err().unwrap()["code"],
            "import_too_large"
        );
    }
    #[test]
    fn rejected_text_stays_terminal_after_replacement_commits_and_competitor_leaves() {
        let (dir, mut host) = setup();
        let bytes = b"imported text";
        let mut original = selection(&host, bytes, "note.md", "auto", OP, ENTRY);
        host.staged_import_begin(Some(source(dir.path(), bytes)), original.clone())
            .unwrap();
        let competitor = EntryId::new("competing_text_entry").unwrap();
        host.vault
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("competing_text_create").unwrap(),
                    mutation: Mutation::Create {
                        id: competitor.clone(),
                        path: VaultPath::new("note.md").unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"competitor".to_vec()),
                    },
                },
                Some(CreateMode::Text),
            )
            .unwrap();
        let rejected = finish(&mut host, OP);
        assert_eq!(rejected.state, "collision");
        assert!(rejected.can_retry_collision);
        let next_op = "abcdefab-0000-4000-8000-000000000004";
        let next_entry = "abcdefab-0000-4000-8000-000000000005";
        let replacement = selection(&host, bytes, "note.md", "auto", next_op, next_entry);
        assert_eq!(
            host.staged_import_begin(Some(source(dir.path(), bytes)), replacement)
                .unwrap()
                .selected_path,
            "note (1).md"
        );
        assert_eq!(finish(&mut host, next_op).state, "committed");
        let revision = host
            .vault
            .read_metadata(&competitor)
            .unwrap()
            .unwrap()
            .state
            .revision;
        host.vault
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("competing_text_delete").unwrap(),
                    mutation: Mutation::Delete {
                        id: competitor,
                        expected: revision,
                        recursive: false,
                    },
                },
                None,
            )
            .unwrap();
        drop(host);
        std::fs::remove_file(dir.path().join("source")).unwrap();
        let mut host = EmbeddedHost::open_local(&dir.path().join("vault")).unwrap();
        admit(&mut host);
        original.lease_token = host
            .leases
            .active
            .values()
            .next()
            .unwrap()
            .reference()
            .token
            .as_str()
            .into();
        for operation in 0..3 {
            let result = match operation {
                0 => host.staged_import_begin(None, original.clone()).unwrap(),
                1 => host.staged_import_cancel(OP).unwrap(),
                _ => host.staged_import_step(OP).unwrap(),
            };
            assert_eq!(result.state, "collision");
            assert!(result.can_retry_collision);
            assert_eq!(result.commit_state, "rejected");
        }
        assert!(host
            .vault
            .read_metadata(&EntryId::new(ENTRY).unwrap())
            .unwrap()
            .is_none());
        assert!(!dir.path().join("vault/note.md").exists());
        assert_eq!(
            std::fs::read(dir.path().join("vault/note (1).md")).unwrap(),
            bytes
        );
        assert_eq!(
            host.vault
                .list_snapshot()
                .unwrap()
                .entries
                .iter()
                .filter(|e| !e.state.deleted)
                .count(),
            1
        );
    }
}
