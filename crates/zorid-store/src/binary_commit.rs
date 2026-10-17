//! Durable authorization and atomic reference-only binary commands. Staging,
//! physical publication and network acknowledgement remain distinct outcomes.
use super::*;
use crate::blob_index::MetadataSnapshot;
use crate::blob_stage::{BinaryStageRef, StagePurpose};
use crate::capture_authorization::CaptureImportAuthorization;
use crate::family_ledger::{EnvelopeKey, EnvelopeMetadata, Family};
use crate::operation_request::{BinaryOperationRequest, InlineCallCommitment, OperationRequest};
use zorid_core::{FileContentTarget, OperationId};
use zorid_file_sync::{
    binary_stream::VerifiedBinarySet,
    metadata::MetadataState,
    metadata_plan::{AuthoredMetadataBatch, MetadataPlan},
    Scope, Sha256Digest,
};
use zorid_sync_protocol::UpdateId;

const MAX_PLAN_BYTES: i64 = 128 * 1024 * 1024;
const MAX_IMMUTABLE_BYTES: u64 = 512 * 1024 * 1024;
const ATTEMPTS: usize = 2;
/// Leaves room for escaped-once renderer checkpoint framing below 64 KiB.
pub const BINARY_COMMIT_MAX_RECEIPT_BYTES: usize = 24 * 1024;
pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("binary_commit_plans","CREATE TABLE binary_commit_plans (stage_id TEXT PRIMARY KEY NOT NULL REFERENCES binary_stages(stage_id),operation_id TEXT NOT NULL UNIQUE,realm_id TEXT NOT NULL,vault_id TEXT NOT NULL,final_event_id TEXT,record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) BETWEEN 1 AND 134217728),receipt_sequence INTEGER REFERENCES operations(sequence),rejection TEXT,CHECK(receipt_sequence IS NULL OR rejection IS NULL),UNIQUE(realm_id,vault_id,final_event_id))"),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BinaryStageCommit {
    pub receipt: CommitResult,
    pub target_id: EntryId,
    pub projection_job_ids: Vec<OperationId>,
}
impl BinaryStageCommit {
    pub fn receipt(&self) -> &CommitResult {
        &self.receipt
    }
    pub fn target_id(&self) -> &EntryId {
        &self.target_id
    }
    pub fn projection_job_ids(&self) -> &[OperationId] {
        &self.projection_job_ids
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryStageRejectionCode {
    TargetMissing,
    TargetDeleted,
    RevisionConflict,
    PathConflict,
    ContentChanged,
    TooLarge,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BinaryStageRejection {
    pub code: BinaryStageRejectionCode,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "result", rename_all = "snake_case")]
pub enum BinaryStageTerminal {
    Committed(BinaryStageCommit),
    Rejected(BinaryStageRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlanKind {
    Command,
    Capture,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextCut {
    entry_id: EntryId,
    revision: Revision,
    digest: Sha256Digest,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DurablePlan {
    request: BinaryOperationRequest,
    kind: PlanKind,
    scope: Scope,
    original_expected: MetadataSnapshot,
    expected: MetadataSnapshot,
    expected_entries: Vec<EntryState>,
    expected_texts: Vec<TextCut>,
    metadata_revision: Revision,
    graph_revision: Revision,
    final_event_id: UpdateId,
    final_event: EnvelopeMetadata,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "state",
    content = "record",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum PlanRecord {
    InlinePrepared {
        request: BinaryStageRequest,
        original_inline: InlineCallCommitment,
    },
    Authorized(DurablePlan),
    Rejected {
        request: BinaryOperationRequest,
        kind: PlanKind,
    },
}
struct Prepared {
    durable: DurablePlan,
    graph: MetadataPlan,
    old_verified: VerifiedBinarySet,
}
enum Finished {
    Committed(BinaryStageCommit),
    ReceiptTooLarge,
}
struct Draft {
    durable: DurablePlan,
    event: Vec<u8>,
}
fn entries(tx: &Connection) -> Result<Vec<EntryState>> {
    let mut rows = read_states(tx, true)?;
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(rows)
}
fn texts(tx: &Connection, scope: &Scope) -> Result<Vec<TextCut>> {
    family_ingress::retained_texts(tx, scope)?
        .into_iter()
        .map(|state| {
            Ok(TextCut {
                entry_id: state.identity.entry_id.clone(),
                revision: state.version.clone(),
                digest: Sha256Digest::of(&serde_json::to_vec(&state)?),
            })
        })
        .collect()
}
fn metadata(tx: &Connection, scope: &Scope) -> Result<MetadataState> {
    blob_index::load_metadata(tx, scope)?
        .ok_or_else(|| invalid("vault is not enrolled for family synchronization"))
}
fn portable_target(request: &BinaryStageRequest) -> zorid_file_sync::binary_mutation::BinaryTarget {
    match &request.target {
        BinaryTarget::Create { id, path } => {
            zorid_file_sync::binary_mutation::BinaryTarget::Create {
                id: id.clone(),
                path: path.clone(),
            }
        }
        BinaryTarget::Write {
            id,
            expected_revision,
            expected_content_event,
        } => zorid_file_sync::binary_mutation::BinaryTarget::Write {
            id: id.clone(),
            expected_revision: expected_revision.clone(),
            expected_content_event: expected_content_event.clone(),
        },
    }
}
fn core_target(request: &BinaryStageRequest) -> FileContentTarget {
    match &request.target {
        BinaryTarget::Create { id, path } => FileContentTarget::Create {
            id: id.clone(),
            path: path.clone(),
        },
        BinaryTarget::Write {
            id,
            expected_revision,
            ..
        } => FileContentTarget::Write {
            id: id.clone(),
            expected: expected_revision.clone(),
        },
    }
}
fn target_rejection(
    state: &MetadataState,
    rows: &[EntryState],
    request: &BinaryStageRequest,
) -> Result<Option<BinaryStageRejectionCode>> {
    use BinaryStageRejectionCode::*;
    let view = state.metadata_view()?;
    Ok(match &request.target {
        BinaryTarget::Create { id, path } => {
            if let Some(entry) = rows.iter().find(|entry| &entry.id == id) {
                Some(if entry.deleted {
                    TargetDeleted
                } else {
                    PathConflict
                })
            } else if view.namespace().entries.contains_key(id) {
                Some(PathConflict)
            } else if rows
                .iter()
                .any(|entry| !entry.deleted && entry.path == *path)
                || view.namespace().entries.values().any(|entry| {
                    entry.projection == zorid_file_sync::Projection::Normal { path: path.clone() }
                })
            {
                Some(PathConflict)
            } else if path.parent().is_some_and(|parent| {
                !rows.iter().any(|entry| {
                    !entry.deleted && entry.kind == EntryKind::Folder && entry.path == parent
                })
            }) {
                Some(TargetMissing)
            } else {
                None
            }
        }
        BinaryTarget::Write {
            id,
            expected_revision,
            expected_content_event,
        } => match rows.iter().find(|entry| &entry.id == id) {
            None => Some(TargetMissing),
            Some(entry) if entry.deleted => Some(TargetDeleted),
            Some(entry) if &entry.revision != expected_revision => Some(RevisionConflict),
            Some(entry) if entry.kind != EntryKind::File => Some(ContentChanged),
            Some(_) => {
                if view.content_bindings().get(id)
                    != Some(&zorid_file_sync::v2::ContentBinding::Binary)
                    || view
                        .namespace()
                        .entries
                        .get(id)
                        .and_then(|entry| entry.contents.last())
                        .map(|head| &head.event)
                        != Some(expected_content_event)
                {
                    Some(ContentChanged)
                } else {
                    None
                }
            }
        },
    })
}
fn batch(tx: &Connection, stage: &BinaryStageRef, scope: &Scope) -> Result<AuthoredMetadataBatch> {
    let mut batch = AuthoredMetadataBatch::new(scope.clone());
    for source in blob_stage::staged_sources(tx, stage)? {
        let raw = immutable_payloads::read_exact(tx, &source)?;
        batch.push_exact(&raw)?;
    }
    Ok(batch)
}
fn event_metadata(
    scope: &Scope,
    event: &zorid_file_sync::binary_stream::AuthoredRecord,
) -> Result<EnvelopeMetadata> {
    Ok(EnvelopeMetadata {
        key: key(scope, event.id()),
        family: Family::Files,
        format_version: 2,
        payload_digest: Sha256Digest::of(event.payload_bytes()),
        payload_bytes: u32::try_from(event.payload_bytes().len())
            .map_err(|_| zorid_file_sync::Error::TooLarge)?,
        file_summary_digest: Some(event.record().summary_digest()?),
        text_binding: None,
    })
}
fn operation_bound(
    tx: &Connection,
    stage: &BinaryStageRef,
    request: &BinaryStageRequest,
    kind: PlanKind,
    original_inline: Option<InlineCallCommitment>,
) -> Result<BinaryOperationRequest> {
    let info = blob_stage::stage_info(tx, stage)?;
    match (&info.purpose, kind) {
        (StagePurpose::Command(stored), PlanKind::Command) if stored == request => {}
        (StagePurpose::Capture(_), PlanKind::Capture) => {}
        _ => return Err(conflict(stage.operation_id())),
    }
    if !matches!(info.phase, StagePhase::Sealed | StagePhase::CommitRequested) {
        return Err(invalid(
            "binary stage must be sealed before commit is requested",
        ));
    }
    // This binds metadata, never a verification capability. The original final
    // event and revisions must be durable before all-history byte verification.
    let manifest = info
        .manifest
        .ok_or_else(|| corrupt("sealed stage lacks manifest"))?;
    let source_commitment = info
        .source_commitment
        .ok_or_else(|| corrupt("sealed stage lacks source commitment"))?;
    if request
        .expected_length
        .is_some_and(|len| len != manifest.bytes)
    {
        return Err(corrupt("sealed source differs from request length"));
    }
    if original_inline
        .as_ref()
        .is_some_and(|call| call.bytes != manifest.bytes || call.digest != manifest.digest)
    {
        return Err(conflict(stage.operation_id()));
    }
    Ok(BinaryOperationRequest {
        stage: stage.locator(),
        request: request.clone(),
        manifest,
        source_commitment,
        original_inline,
    })
}
fn draft(
    tx: &Connection,
    stage: &BinaryStageRef,
    request: BinaryOperationRequest,
    kind: PlanKind,
    prior: Option<&DurablePlan>,
) -> Result<Draft> {
    let scope = identity(tx, stage)?;
    let state = metadata(tx, &scope)?;
    let rows = entries(tx)?;
    let expected = MetadataSnapshot::capture(&state)?;
    let (metadata_revision, graph_revision, final_event_id) = match prior {
        Some(plan) => (
            plan.metadata_revision.clone(),
            plan.graph_revision.clone(),
            plan.final_event_id.clone(),
        ),
        None => (
            family_commands::fresh_revision()?,
            family_commands::fresh_revision()?,
            family_commands::fresh_update()?,
        ),
    };
    let mapped = zorid_file_sync::binary_mutation::prepare_binary_mutation(
        &state,
        &rows,
        portable_target(&request.request),
        batch(tx, stage, &scope)?,
        &request.manifest,
        final_event_id.clone(),
        graph_revision.clone(),
    )
    .map_err(family_commands::mapped)?;
    let event = mapped.final_event().payload_bytes().to_vec();
    let final_event = event_metadata(&scope, mapped.final_event())?;
    if let Some(prior) = prior {
        if prior.request != request
            || prior.kind != kind
            || prior.scope != scope
            || prior.final_event != final_event
            || immutable_payloads::read_exact(tx, &prior.final_event)? != event
        {
            return Err(retry());
        }
    }
    Ok(Draft {
        durable: DurablePlan {
            request,
            kind,
            scope,
            original_expected: prior
                .map_or_else(|| expected.clone(), |plan| plan.original_expected.clone()),
            expected,
            expected_entries: rows,
            expected_texts: texts(tx, state.scope())?,
            metadata_revision,
            graph_revision,
            final_event_id,
            final_event,
        },
        event,
    })
}
fn check_cut(tx: &Connection, plan: &DurablePlan) -> Result<MetadataState> {
    let state = metadata(tx, &plan.scope)?;
    plan.expected.check(&state).map_err(|_| retry())?;
    if entries(tx)? != plan.expected_entries || texts(tx, &plan.scope)? != plan.expected_texts {
        return Err(retry());
    }
    Ok(state)
}
fn check_stage(tx: &Connection, stage: &BinaryStageRef, plan: &DurablePlan) -> Result<()> {
    let scope = identity(tx, stage)?;
    let info = blob_stage::stage_info(tx, stage)?;
    let valid = match (&info.purpose, plan.kind) {
        (StagePurpose::Command(request), PlanKind::Command) => {
            request == &plan.request.request
                && matches!(info.phase, StagePhase::Sealed | StagePhase::CommitRequested)
        }
        (StagePurpose::Capture(_), PlanKind::Capture) => info.phase == StagePhase::Sealed,
        _ => false,
    };
    if !valid
        || scope != plan.scope
        || info.scope != scope
        || info.manifest.as_ref() != Some(&plan.request.manifest)
        || info.source_commitment != Some(plan.request.source_commitment)
        || plan.request.stage != stage.locator()
    {
        return Err(conflict(stage.operation_id()));
    }
    for source in blob_stage::staged_sources(tx, stage)? {
        let head = immutable_payloads::head(tx, &source.key)?
            .ok_or_else(|| corrupt("sealed source missing"))?;
        if head.family != source.family
            || head.payload_bytes != source.payload_bytes
            || head.payload_digest != source.payload_digest
            || head.file_summary_digest != source.file_summary_digest
        {
            return Err(corrupt("sealed source commitment changed"));
        }
    }
    Ok(())
}
fn save_authorization(
    tx: &Connection,
    stage: &BinaryStageRef,
    draft: &Draft,
    existing: bool,
) -> Result<()> {
    let plan = &draft.durable;
    check_cut(tx, plan)?;
    check_stage(tx, stage, plan)?;
    if operation(tx, stage.operation_id())?.is_some() {
        return Err(retry());
    }
    if !existing {
        if !family_ledger::unused(tx, &plan.final_event.key)? {
            return Err(retry());
        }
        text_sync::reserve_revision(tx, &plan.metadata_revision)?;
        text_sync::reserve_revision(tx, &plan.graph_revision)?;
    }
    immutable_payloads::put_exact(tx, &plan.final_event, &draft.event, MAX_IMMUTABLE_BYTES)?;
    let raw = serde_json::to_string(&PlanRecord::Authorized(plan.clone()))?;
    if raw.len() as u64 > MAX_PLAN_BYTES as u64 {
        return Err(zorid_file_sync::Error::TooLarge.into());
    }
    if existing {
        if tx.execute("UPDATE binary_commit_plans SET record=?1 WHERE stage_id=?2 AND operation_id=?3 AND receipt_sequence IS NULL AND rejection IS NULL",params![raw,stage.stage_id().as_str(),stage.operation_id().as_str()])?!=1 {return Err(retry())}
    } else {
        // An inline draft owns this same operation row before bytes are appended.
        tx.execute("INSERT INTO binary_commit_plans(stage_id,operation_id,realm_id,vault_id,final_event_id,record) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(stage_id) DO UPDATE SET final_event_id=excluded.final_event_id,record=excluded.record WHERE binary_commit_plans.receipt_sequence IS NULL AND binary_commit_plans.rejection IS NULL AND binary_commit_plans.final_event_id IS NULL",params![stage.stage_id().as_str(),stage.operation_id().as_str(),plan.scope.realm_id.as_str(),plan.scope.vault_id.as_str(),plan.final_event_id.as_str(),raw])?;
    }
    if plan.kind==PlanKind::Command&&tx.execute("UPDATE binary_stages SET phase='commit_requested' WHERE stage_id=?1 AND phase IN ('sealed','commit_requested')",[stage.stage_id().as_str()])?!=1 {return Err(retry())}
    Ok(())
}
fn record_cut(tx: &Connection, stage: &BinaryStageRef) -> Result<Option<String>> {
    record(tx, stage)?
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(Into::into)
}
fn check_record_cut(
    tx: &Connection,
    stage: &BinaryStageRef,
    expected: &Option<String>,
) -> Result<()> {
    if &record_cut(tx, stage)? != expected {
        return Err(retry());
    }
    Ok(())
}
fn is_retry(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::Sync(zorid_client_sync::SyncError::VersionConflict)
    )
}
fn authorize(
    store: &mut Store,
    stage: &BinaryStageRef,
    request: &BinaryStageRequest,
    kind: PlanKind,
    inline: Option<InlineCallCommitment>,
    guard: Option<&CaptureImportAuthorization>,
    reprepare: bool,
) -> Result<()> {
    for attempt in 0..ATTEMPTS {
        let result = (|| {
            let tx = store.connection.unchecked_transaction()?;
            if let Some(terminal) = terminal_status(&tx, stage)? {
                return match terminal {
                    BinaryStageTerminal::Committed(_) => Ok(()),
                    BinaryStageTerminal::Rejected(reason) => Err(rejected(reason.code)),
                };
            }
            if let Some(guard) = guard {
                guard.validate(&tx)?;
            }
            let prior_record = record(&tx, stage)?;
            let expected_record = record_cut(&tx, stage)?;
            let prior = match &prior_record {
                Some(PlanRecord::Authorized(plan)) => {
                    if plan.kind != kind
                        || plan.request.request != *request
                        || inline.as_ref().is_some_and(|original| {
                            plan.request.original_inline.as_ref() != Some(original)
                        })
                    {
                        return Err(conflict(stage.operation_id()));
                    }
                    if !reprepare {
                        return Ok(());
                    }
                    Some(plan)
                }
                Some(PlanRecord::InlinePrepared {
                    request: bound,
                    original_inline,
                }) => {
                    if kind != PlanKind::Command
                        || bound != request
                        || inline.as_ref() != Some(original_inline)
                    {
                        return Err(conflict(stage.operation_id()));
                    }
                    None
                }
                Some(PlanRecord::Rejected { .. }) => {
                    return Err(corrupt("binary rejection lacks its terminal reason"))
                }
                None => None,
            };
            let inline = prior
                .and_then(|plan| plan.request.original_inline.clone())
                .or(inline.clone());
            let bound = operation_bound(&tx, stage, request, kind, inline.clone())?;
            let scope = identity(&tx, stage)?;
            let state = metadata(&tx, &scope)?;
            let rows = entries(&tx)?;
            if let Some(code) = target_rejection(&state, &rows, request)? {
                let cut = MetadataSnapshot::capture(&state)?;
                let text_cut = texts(&tx, &scope)?;
                tx.commit()?;
                let tx = store
                    .connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)?;
                if committed(&tx, stage)?.is_some() {
                    tx.commit()?;
                    return Ok(());
                }
                check_record_cut(&tx, stage, &expected_record)?;
                cut.check(&metadata(&tx, &scope)?).map_err(|_| retry())?;
                if entries(&tx)? != rows || texts(&tx, &scope)? != text_cut {
                    return Err(retry());
                }
                if let Some(guard) = guard {
                    guard.validate(&tx)?;
                }
                // Re-pin metadata only; actual source hashing stays outside the
                // writer, and the original request is reused without rebinding.
                if operation_bound(&tx, stage, request, kind, inline)? != bound {
                    return Err(retry());
                }
                let record = match prior_record {
                    Some(PlanRecord::Authorized(plan)) => PlanRecord::Authorized(plan),
                    _ => PlanRecord::Rejected {
                        request: bound,
                        kind,
                    },
                };
                tx.execute("INSERT INTO binary_commit_plans(stage_id,operation_id,realm_id,vault_id,record,rejection) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(stage_id) DO UPDATE SET rejection=excluded.rejection,record=excluded.record WHERE binary_commit_plans.receipt_sequence IS NULL",params![stage.stage_id().as_str(),stage.operation_id().as_str(),scope.realm_id.as_str(),scope.vault_id.as_str(),serde_json::to_string(&record)?,serde_json::to_string(&BinaryStageRejection{code})?])?;
                if kind == PlanKind::Command {
                    tx.execute("UPDATE binary_stages SET phase='rejected' WHERE stage_id=?1 AND phase IN ('sealed','commit_requested')",[stage.stage_id().as_str()])?;
                }
                tx.commit()?;
                return Err(rejected(code));
            }
            let draft = draft(&tx, stage, bound, kind, prior)?;
            let existing = prior.is_some();
            tx.commit()?;
            let tx = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            if committed(&tx, stage)?.is_some() {
                tx.commit()?;
                return Ok(());
            }
            check_record_cut(&tx, stage, &expected_record)?;
            if let Some(guard) = guard {
                guard.validate(&tx)?;
            }
            save_authorization(&tx, stage, &draft, existing)?;
            tx.commit()?;
            Ok(())
        })();
        match result {
            Err(error) if is_retry(&error) && attempt + 1 < ATTEMPTS => continue,
            result => return result,
        }
    }
    Err(retry())
}
fn prepare(
    tx: &Connection,
    stage: &BinaryStageRef,
    guard: Option<&CaptureImportAuthorization>,
) -> Result<Prepared> {
    let Some(PlanRecord::Authorized(plan)) = record(tx, stage)? else {
        return Err(invalid("binary stage commit must be explicitly requested"));
    };
    let info = blob_stage::stage_info(tx, stage)?;
    match plan.kind {
        PlanKind::Command if info.phase == StagePhase::CommitRequested && guard.is_none() => {}
        PlanKind::Capture if info.phase == StagePhase::Sealed && guard.is_some() => {}
        _ => return Err(invalid("binary stage has no matching commit authority")),
    }
    if let Some(guard) = guard {
        if guard.stage() != stage || guard.request() != &plan.request.request {
            return Err(conflict(stage.operation_id()));
        }
        guard.validate(tx)?;
    }
    check_stage(tx, stage, &plan)?;
    let state = check_cut(tx, &plan)?;
    // Full source verification remains separate from metadata/authorization.
    let sealed = blob_stage::validate_sealed(tx, stage)?;
    if sealed.manifest() != &plan.request.manifest
        || sealed.source_commitment() != &plan.request.source_commitment
    {
        return Err(corrupt("authorized stage content differs"));
    }
    let mapped = zorid_file_sync::binary_mutation::prepare_binary_mutation(
        &state,
        &plan.expected_entries,
        portable_target(&plan.request.request),
        batch(tx, stage, &plan.scope)?,
        &plan.request.manifest,
        plan.final_event_id.clone(),
        plan.graph_revision.clone(),
    )
    .map_err(family_commands::mapped)?;
    if event_metadata(&plan.scope, mapped.final_event())? != plan.final_event
        || immutable_payloads::read_exact(tx, &plan.final_event)?
            != mapped.final_event().payload_bytes()
    {
        return Err(retry());
    }
    let (_, _, event, candidate) = mapped.into_parts();
    let old_verified = blob_index::verify_metadata(tx, &state, &[])?;
    family_materialization::validate(tx, &state, &old_verified)?;
    let overlay = [(event.id().clone(), event.payload_bytes().to_vec())];
    let verified =
        blob_index::verify_staged_metadata(tx, candidate.verification_state(), stage, &overlay)?;
    let graph = candidate.finalize(verified)?;
    Ok(Prepared {
        durable: plan,
        graph,
        old_verified,
    })
}
fn finish(
    tx: &Connection,
    stage: &BinaryStageRef,
    prepared: &Prepared,
    guard: Option<&CaptureImportAuthorization>,
) -> Result<Finished> {
    if let Some((commit, _)) = committed(tx, stage)? {
        return Ok(Finished::Committed(commit));
    }
    if let Some(BinaryStageTerminal::Rejected(reason)) = terminal_status(tx, stage)? {
        return Err(rejected(reason.code));
    }
    let plan = &prepared.durable;
    if record_cut(tx, stage)?
        != Some(serde_json::to_string(&PlanRecord::Authorized(
            plan.clone(),
        ))?)
    {
        return Err(retry());
    }
    let state = check_cut(tx, plan)?;
    prepared.graph.check_preconditions(&state, None)?;
    check_stage(tx, stage, plan)?;
    blob_index::check_sources(tx, &state)?;
    family_materialization::validate(tx, &state, &prepared.old_verified)?;
    if let Some(guard) = guard {
        if guard.stage() != stage
            || guard.request() != &plan.request.request
            || plan.kind != PlanKind::Capture
        {
            return Err(conflict(stage.operation_id()));
        }
        guard.validate(tx)?;
    } else if plan.kind != PlanKind::Command {
        return Err(invalid("capture requires physical import authorization"));
    }
    let changes = zorid_core::plan_file_content_mutation(
        &core_target(&plan.request.request),
        &plan.expected_entries,
        &plan.metadata_revision,
    )?;
    // Promotion copies no source bytes. The ledger checks this exact plan and
    // each independent stage commitment before inserting authored references.
    for source in blob_stage::staged_sources(tx, stage)? {
        family_ledger::promote_staged(tx, stage, &source, guard)?;
    }
    family_ledger::promote_staged(tx, stage, &plan.final_event, guard)?;
    blob_index::persist_plan(tx, &prepared.graph)?;
    let graph = prepared.graph.verification_state();
    blob_index::check_sources(tx, graph)?;
    tx.execute(
        "INSERT INTO operations(operation_id,request) VALUES(?1,?2)",
        params![
            stage.operation_id().as_str(),
            serde_json::to_string(&OperationRequest::BinaryRef(plan.request.clone()))?
        ],
    )?;
    let receipt = CommitResult {
        operation_id: stage.operation_id().clone(),
        sequence: u64::try_from(tx.last_insert_rowid())
            .map_err(|_| corrupt("binary receipt sequence overflow"))?,
        changes,
    };
    receipt.validate()?;
    if serde_json::to_vec(&receipt)?.len() > BINARY_COMMIT_MAX_RECEIPT_BYTES {
        return Ok(Finished::ReceiptTooLarge);
    }
    let changed = family_materialization::apply(
        tx,
        graph,
        prepared.graph.verified_binaries(),
        ProjectionOrigin::LocalCommand {
            operation_id: stage.operation_id().clone(),
        },
        Some(&plan.metadata_revision),
    )?;
    let expected: std::collections::BTreeSet<_> = receipt
        .changes
        .iter()
        .map(|change| change.after.id.clone())
        .collect();
    if changed
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        != expected
    {
        return Err(corrupt(
            "binary planner and publication classifier changed different identities",
        ));
    }
    for change in &receipt.changes {
        let raw: String = tx.query_row(
            "SELECT state FROM entries WHERE id=?1",
            [change.after.id.as_str()],
            |row| row.get(0),
        )?;
        if serde_json::from_str::<EntryState>(&raw)? != change.after {
            return Err(corrupt(
                "binary receipt differs from committed materialization",
            ));
        }
    }
    tx.execute(
        "UPDATE operations SET result=?1 WHERE operation_id=?2",
        params![
            serde_json::to_string(&receipt)?,
            stage.operation_id().as_str()
        ],
    )?;
    let id = target_id(&plan.request.request).clone();
    let target = receipt
        .changes
        .iter()
        .find(|change| change.after.id == id)
        .ok_or_else(|| corrupt("binary receipt has no target"))?
        .after
        .clone();
    let job = projection_jobs::insert(
        tx,
        ProjectionJob {
            job_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            ordinal: String::new(),
            origin: ProjectionOrigin::LocalCommand {
                operation_id: stage.operation_id().clone(),
            },
            work: ProjectionWork::MaterializeFile,
            target,
            affected: receipt.changes.clone(),
            completed: false,
        },
        None,
    )?;
    if plan.kind==PlanKind::Command&&tx.execute("UPDATE binary_stages SET phase='committed' WHERE stage_id=?1 AND phase='commit_requested'",[stage.stage_id().as_str()])?!=1 {return Err(retry())}
    if tx.execute("UPDATE binary_commit_plans SET receipt_sequence=?1 WHERE stage_id=?2 AND receipt_sequence IS NULL AND rejection IS NULL",params![i64::try_from(receipt.sequence).map_err(|_|corrupt("binary receipt sequence overflow"))?,stage.stage_id().as_str()])?!=1 {return Err(retry())}
    if let Some(guard) = guard {
        guard.record_committed(tx, &receipt)?;
    }
    Ok(Finished::Committed(BinaryStageCommit {
        receipt,
        target_id: id,
        projection_job_ids: vec![job.job_id],
    }))
}
fn reject_oversized(
    store: &mut Store,
    stage: &BinaryStageRef,
    expected: &DurablePlan,
) -> Result<BinaryStageCommit> {
    let tx = store
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some((receipt, _)) = committed(&tx, stage)? {
        tx.commit()?;
        return Ok(receipt);
    }
    if let Some(BinaryStageTerminal::Rejected(reason)) = terminal_status(&tx, stage)? {
        return Err(rejected(reason.code));
    }
    let Some(PlanRecord::Authorized(plan)) = record(&tx, stage)? else {
        return Err(corrupt("oversized receipt lost its original authorization"));
    };
    // The mutable graph cut may have advanced; rejection still binds only the
    // same immutable authorized operation, event and allocation revisions.
    if plan.request != expected.request
        || plan.kind != expected.kind
        || plan.scope != expected.scope
        || plan.final_event != expected.final_event
        || plan.metadata_revision != expected.metadata_revision
        || plan.graph_revision != expected.graph_revision
    {
        return Err(retry());
    }
    let reason = BinaryStageRejection {
        code: BinaryStageRejectionCode::TooLarge,
    };
    if tx.execute("UPDATE binary_commit_plans SET rejection=?1 WHERE stage_id=?2 AND operation_id=?3 AND receipt_sequence IS NULL AND rejection IS NULL",params![serde_json::to_string(&reason)?,stage.stage_id().as_str(),stage.operation_id().as_str()])?!=1 {return Err(retry())}
    if plan.kind==PlanKind::Command&&tx.execute("UPDATE binary_stages SET phase='rejected' WHERE stage_id=?1 AND phase='commit_requested'",[stage.stage_id().as_str()])?!=1 {return Err(retry())}
    tx.commit()?;
    Err(rejected(reason.code))
}
fn commit(
    store: &mut Store,
    stage: &BinaryStageRef,
    guard: Option<&CaptureImportAuthorization>,
) -> Result<BinaryStageCommit> {
    for attempt in 0..ATTEMPTS {
        let tx = store.connection.unchecked_transaction()?;
        if let Some((receipt, _)) = committed(&tx, stage)? {
            tx.commit()?;
            return Ok(receipt);
        }
        if let Some(BinaryStageTerminal::Rejected(reason)) = terminal_status(&tx, stage)? {
            return Err(rejected(reason.code));
        }
        let Some(PlanRecord::Authorized(plan)) = record(&tx, stage)? else {
            return Err(invalid("binary stage commit must be explicitly requested"));
        };
        if (plan.kind == PlanKind::Capture) != guard.is_some() {
            return Err(invalid("binary stage commit authority differs"));
        }
        let actual = metadata(&tx, &plan.scope)?;
        let rows = entries(&tx)?;
        let stale = target_rejection(&actual, &rows, &plan.request.request)?.is_some();
        let changed = plan.expected.check(&actual).is_err()
            || rows != plan.expected_entries
            || texts(&tx, &plan.scope)? != plan.expected_texts;
        tx.commit()?;
        if stale || changed {
            authorize(
                store,
                stage,
                &plan.request.request,
                plan.kind,
                plan.request.original_inline.clone(),
                guard,
                true,
            )?;
        }
        let result = (|| {
            let tx = store.connection.unchecked_transaction()?;
            if let Some((receipt, _)) = committed(&tx, stage)? {
                tx.commit()?;
                return Ok(receipt);
            }
            let prepared = prepare(&tx, stage, guard)?;
            tx.commit()?;
            let tx = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            match finish(&tx, stage, &prepared, guard)? {
                Finished::Committed(receipt) => {
                    tx.commit()?;
                    Ok(receipt)
                }
                Finished::ReceiptTooLarge => {
                    tx.rollback()?;
                    reject_oversized(store, stage, &prepared.durable)
                }
            }
        })();
        match result {
            Err(error) if is_retry(&error) && attempt + 1 < ATTEMPTS => continue,
            result => return result,
        }
    }
    Err(retry())
}
impl Store {
    /// Original sealed commitment metadata, not a verified read capability.
    /// Terminal lookup never consults the current graph or backing source bytes.
    pub fn binary_stage_content_manifest(
        &self,
        stage: &BinaryStageRef,
    ) -> Result<Option<zorid_file_sync::Manifest>> {
        let tx = self.connection.unchecked_transaction()?;
        let manifest = match terminal_manifest(&tx, stage)? {
            Some(manifest) => Some(manifest),
            None => blob_stage::stage_info(&tx, stage)?.manifest,
        };
        tx.commit()?;
        Ok(manifest)
    }

    pub fn binary_stage_request(&self, stage: &BinaryStageRef) -> Result<BinaryStageRequest> {
        if let Some((_, request)) = committed(&self.connection, stage)? {
            return Ok(request.request);
        }
        match record(&self.connection, stage)? {
            Some(PlanRecord::Authorized(plan)) => Ok(plan.request.request),
            Some(PlanRecord::Rejected { request, .. }) => Ok(request.request),
            _ => match blob_stage::stage_info(&self.connection, stage)?.purpose {
                StagePurpose::Command(request) => Ok(request),
                StagePurpose::Capture(_) => Err(invalid("capture is not a public binary command")),
            },
        }
    }
    pub fn request_commit_binary_stage(
        &mut self,
        stage: &BinaryStageRef,
    ) -> Result<BinaryStageStatus> {
        if terminal_status(&self.connection, stage)?.is_some() {
            return self.query_binary_stage(stage);
        }
        let StagePurpose::Command(request) =
            blob_stage::stage_info(&self.connection, stage)?.purpose
        else {
            return Err(invalid("capture is not a public binary command"));
        };
        authorize(self, stage, &request, PlanKind::Command, None, None, false)?;
        self.query_binary_stage(stage)
    }
    pub fn commit_binary_stage(&mut self, stage: &BinaryStageRef) -> Result<BinaryStageCommit> {
        commit(self, stage, None)
    }
}
pub(super) fn commit_external_binary(
    store: &mut Store,
    authorization: CaptureImportAuthorization,
) -> Result<BinaryStageCommit> {
    let stage = authorization.stage().clone();
    if let Some((receipt, _)) = committed(&store.connection, &stage)? {
        return Ok(receipt);
    }
    authorize(
        store,
        &stage,
        authorization.request(),
        PlanKind::Capture,
        None,
        Some(&authorization),
        false,
    )?;
    commit(store, &stage, Some(&authorization))
}
fn inline_target(
    tx: &Connection,
    request: &MutationRequest,
    len: u64,
) -> Result<BinaryStageRequest> {
    let target = match &request.mutation {
        Mutation::Create {
            id,
            path,
            kind: EntryKind::File,
            ..
        } => BinaryTarget::Create {
            id: id.clone(),
            path: path.clone(),
        },
        Mutation::Write { id, expected, .. } => {
            let authority = text_sync::identity(tx)?;
            let scope = Scope {
                realm_id: authority
                    .realm_id
                    .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
                vault_id: authority
                    .vault_id
                    .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
            };
            let rows = entries(tx)?;
            zorid_core::validate_target(rows.iter().find(|entry| entry.id == *id), id, expected)?;
            let state = metadata(tx, &scope)?;
            let view = state.metadata_view()?;
            if view.content_bindings().get(id) != Some(&zorid_file_sync::v2::ContentBinding::Binary)
            {
                return Err(invalid(
                    "inline binary write requires existing binary content",
                ));
            }
            let selected = view
                .namespace()
                .entries
                .get(id)
                .and_then(|entry| entry.contents.last())
                .ok_or_else(|| invalid("inline binary write has no selected event"))?;
            BinaryTarget::Write {
                id: id.clone(),
                expected_revision: expected.clone(),
                expected_content_event: selected.event.clone(),
            }
        }
        _ => return Err(invalid("inline binary requires file Create or Write")),
    };
    Ok(BinaryStageRequest {
        target,
        expected_length: Some(len),
    })
}
fn bind_inline(
    store: &mut Store,
    stage: &BinaryStageRef,
    request: &BinaryStageRequest,
    original: &InlineCallCommitment,
) -> Result<()> {
    let tx = store
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    match record(&tx, stage)? {
        Some(PlanRecord::InlinePrepared {
            request: prior,
            original_inline,
        }) if prior == *request && original_inline == *original => {}
        Some(PlanRecord::Authorized(plan))
            if plan.kind == PlanKind::Command
                && plan.request.request == *request
                && plan.request.original_inline.as_ref() == Some(original) => {}
        Some(PlanRecord::Rejected { request: prior, .. })
            if prior.request == *request && prior.original_inline.as_ref() == Some(original) => {}
        Some(_) => return Err(conflict(stage.operation_id())),
        None => {
            let scope = identity(&tx, stage)?;
            let info = blob_stage::stage_info(&tx, stage)?;
            let accepted: i64 = tx.query_row(
                "SELECT accepted_length FROM binary_stages WHERE stage_id=?1",
                [stage.stage_id().as_str()],
                |row| row.get(0),
            )?;
            // A nonempty explicit stream cannot be adopted by an inline caller.
            // The only crash gap allowed before this record contains zero bytes.
            if info.purpose != StagePurpose::Command(request.clone())
                || info.phase != StagePhase::Receiving
                || accepted != 0
            {
                return Err(conflict(stage.operation_id()));
            }
            tx.execute("INSERT INTO binary_commit_plans(stage_id,operation_id,realm_id,vault_id,record) VALUES(?1,?2,?3,?4,?5)",params![stage.stage_id().as_str(),stage.operation_id().as_str(),scope.realm_id.as_str(),scope.vault_id.as_str(),serde_json::to_string(&PlanRecord::InlinePrepared{request:request.clone(),original_inline:original.clone()})?])?;
        }
    }
    tx.commit()?;
    Ok(())
}
pub(super) fn apply_inline_binary(
    store: &mut Store,
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
) -> Result<CommitResult> {
    // Replay before checking the current entry, stage state or backing bytes.
    let tx = store.connection.unchecked_transaction()?;
    if let Some(receipt) = family_metadata_transactions::replay(&tx, request, mode)? {
        tx.commit()?;
        return Ok(receipt);
    }
    tx.commit()?;
    let content = match &request.mutation {
        Mutation::Create {
            content: Some(bytes),
            ..
        }
        | Mutation::Write { content: bytes, .. } => bytes,
        _ => return Err(invalid("inline binary call has no file bytes")),
    };
    if content.len() as u64 > FAMILY_MAX_INLINE_BYTES {
        return Err(StoreError::StreamRequired {
            bytes: content.len() as u64,
            limit: FAMILY_MAX_INLINE_BYTES,
        });
    }
    let original = InlineCallCommitment::from_request(request, mode)?;
    let client = text_sync::identity(&store.connection)?.local_store_id;
    let resumed = store.resume_binary_stage(&client, &request.operation_id)?;
    let (stage, target) = if let Some(stage) = resumed {
        // Resolve the complete original call before consulting today's selected
        // event. A retry may never rebind a Write to its newer causal head.
        let target = match record(&store.connection, &stage)? {
            Some(PlanRecord::InlinePrepared {
                request,
                original_inline,
            }) if original_inline == original => request,
            Some(PlanRecord::Authorized(plan))
                if plan.request.original_inline.as_ref() == Some(&original) =>
            {
                plan.request.request
            }
            Some(PlanRecord::Rejected { request, .. })
                if request.original_inline.as_ref() == Some(&original) =>
            {
                request.request
            }
            Some(_) => return Err(conflict(&request.operation_id)),
            None => inline_target(&store.connection, request, content.len() as u64)?,
        };
        (stage, target)
    } else {
        let target = inline_target(&store.connection, request, content.len() as u64)?;
        let stage = store.begin_binary_stage(
            &client,
            &request.operation_id,
            &target,
            DEFAULT_STREAMING_LIMITS,
        )?;
        (stage, target)
    };
    bind_inline(store, &stage, &target, &original)?;
    if let Some(BinaryStageTerminal::Rejected(reason)) = terminal_status(&store.connection, &stage)?
    {
        return Err(rejected(reason.code));
    }
    let phase = blob_stage::stage_info(&store.connection, &stage)?.phase;
    if phase == StagePhase::Receiving {
        for (sequence, chunk) in content.chunks(BINARY_STAGE_MAX_CHUNK_BYTES).enumerate() {
            store.append_binary_chunk(
                &stage,
                u32::try_from(sequence).map_err(|_| zorid_file_sync::Error::TooLarge)?,
                (sequence as u64) * BINARY_STAGE_MAX_CHUNK_BYTES as u64,
                chunk,
            )?;
        }
    } else if !matches!(phase, StagePhase::Sealed | StagePhase::CommitRequested) {
        return Err(invalid("inline binary stage cannot be resumed"));
    }
    if matches!(phase, StagePhase::Receiving | StagePhase::Sealed) {
        store.seal_binary_stage(&stage, original.bytes, Some(original.digest))?;
    }
    authorize(
        store,
        &stage,
        &target,
        PlanKind::Command,
        Some(original),
        None,
        false,
    )?;
    Ok(commit(store, &stage, None)?.receipt)
}
fn corrupt(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
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
fn retry() -> StoreError {
    zorid_client_sync::SyncError::VersionConflict.into()
}
fn rejected(code: BinaryStageRejectionCode) -> StoreError {
    invalid(&format!("binary stage rejected: {code:?}"))
}
fn target_id(request: &BinaryStageRequest) -> &EntryId {
    match &request.target {
        BinaryTarget::Create { id, .. } | BinaryTarget::Write { id, .. } => id,
    }
}
fn key(scope: &Scope, id: &UpdateId) -> EnvelopeKey {
    EnvelopeKey {
        realm_id: scope.realm_id.clone(),
        vault_id: scope.vault_id.clone(),
        update_id: id.clone(),
    }
}

/// Replay checks only immutable operation identity and the minimal store owner.
/// No current stage phase, target row, payload or classifier is consulted.
fn identity(tx: &Connection, stage: &BinaryStageRef) -> Result<Scope> {
    let row:Option<(String,String,String,String,String)>=tx.query_row("SELECT CASE WHEN length(local_store_id)<=128 THEN local_store_id ELSE '' END,CASE WHEN length(client_id)<=128 THEN client_id ELSE '' END,CASE WHEN length(operation_id)<=128 THEN operation_id ELSE '' END,CASE WHEN length(realm_id)<=128 THEN realm_id ELSE '' END,CASE WHEN length(vault_id)<=128 THEN vault_id ELSE '' END FROM binary_stages WHERE stage_id=?1",[stage.stage_id().as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let (local, client, operation, realm, vault) =
        row.ok_or_else(|| invalid("binary stage not found"))?;
    let actual = text_sync::identity(tx)?;
    if local != stage.local_store_id().as_str()
        || client != stage.client_id().as_str()
        || operation != stage.operation_id().as_str()
        || actual.local_store_id != *stage.local_store_id()
        || actual.realm_id.as_ref().map(|id| id.as_str()) != Some(realm.as_str())
        || actual.vault_id.as_ref().map(|id| id.as_str()) != Some(vault.as_str())
    {
        return Err(conflict(stage.operation_id()));
    }
    Ok(Scope {
        realm_id: zorid_sync_protocol::RealmId::new(realm)?,
        vault_id: zorid_sync_protocol::VaultId::new(vault)?,
    })
}
fn operation(
    tx: &Connection,
    id: &OperationId,
) -> Result<Option<operation_request::StoredOperation>> {
    let lengths:Option<(i64,Option<i64>)>=tx.query_row("SELECT length(CAST(request AS BLOB)),length(CAST(result AS BLOB)) FROM operations WHERE operation_id=?1",[id.as_str()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((request, result)) = lengths else {
        return Ok(None);
    };
    if request <= 0
        || request > MAX_PLAN_BYTES
        || result.is_none_or(|n| n <= 0 || n > MAX_PLAN_BYTES)
    {
        return Err(corrupt("binary operation receipt missing or oversized"));
    }
    let (raw, result): (String, String) = tx.query_row(
        "SELECT request,result FROM operations WHERE operation_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Some(operation_request::decode_record(&raw, &result, id)?))
}
fn original_jobs(
    tx: &Connection,
    receipt: &CommitResult,
    id: &EntryId,
) -> Result<Vec<OperationId>> {
    let rows=tx.prepare("SELECT job_id FROM projection_jobs WHERE json_extract(record,'$.origin.kind')='local_command' AND json_extract(record,'$.origin.operation_id')=?1 ORDER BY ordinal LIMIT 2")?.query_map([receipt.operation_id.as_str()],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if rows.len() != 1 {
        return Err(corrupt(
            "binary receipt lacks its one original projection job",
        ));
    }
    let mut jobs = Vec::new();
    for raw in rows {
        let job_id = OperationId::new(raw)?;
        let job = projection_jobs::get(tx, &job_id)?;
        if job.work != ProjectionWork::MaterializeFile
            || job.target.id != *id
            || job.affected != receipt.changes
            || !receipt
                .changes
                .iter()
                .any(|change| change.after == job.target)
        {
            return Err(corrupt(
                "binary receipt projection job differs from original changes",
            ));
        }
        jobs.push(job_id);
    }
    Ok(jobs)
}
fn committed(
    tx: &Connection,
    stage: &BinaryStageRef,
) -> Result<Option<(BinaryStageCommit, BinaryOperationRequest)>> {
    let Some(stored) = operation(tx, stage.operation_id())? else {
        return Ok(None);
    };
    let OperationRequest::BinaryRef(request) = stored.request else {
        return Err(conflict(stage.operation_id()));
    };
    if request.stage != stage.locator() {
        return Err(conflict(stage.operation_id()));
    }
    identity(tx, stage)?;
    let id = target_id(&request.request).clone();
    let jobs = original_jobs(tx, &stored.result, &id)?;
    Ok(Some((
        BinaryStageCommit {
            receipt: stored.result,
            target_id: id,
            projection_job_ids: jobs,
        },
        request,
    )))
}
fn record(tx: &Connection, stage: &BinaryStageRef) -> Result<Option<PlanRecord>> {
    let len:Option<i64>=tx.query_row("SELECT length(CAST(record AS BLOB)) FROM binary_commit_plans WHERE stage_id=?1 AND operation_id=?2",params![stage.stage_id().as_str(),stage.operation_id().as_str()],|r|r.get(0)).optional()?;
    let Some(len) = len else { return Ok(None) };
    if len <= 0 || len > MAX_PLAN_BYTES {
        return Err(corrupt("binary authorization record exceeds bound"));
    }
    let scope = identity(tx, stage)?;
    let (realm, vault, raw): (String, String, String) = tx.query_row(
        "SELECT realm_id,vault_id,record FROM binary_commit_plans WHERE stage_id=?1",
        [stage.stage_id().as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if realm != scope.realm_id.as_str() || vault != scope.vault_id.as_str() {
        return Err(corrupt("binary authorization scope differs"));
    }
    let record: PlanRecord = serde_json::from_str(&raw)?;
    match &record {
        PlanRecord::Authorized(plan)
            if plan.request.stage != stage.locator() || plan.scope != scope =>
        {
            return Err(corrupt("binary authorized request identity differs"))
        }
        PlanRecord::Rejected { request, .. } if request.stage != stage.locator() => {
            return Err(corrupt("binary rejection request identity differs"))
        }
        _ => {}
    }
    Ok(Some(record))
}
pub(super) fn terminal_status(
    tx: &Connection,
    stage: &BinaryStageRef,
) -> Result<Option<BinaryStageTerminal>> {
    if let Some((receipt, _)) = committed(tx, stage)? {
        return Ok(Some(BinaryStageTerminal::Committed(receipt)));
    }
    let rejection:Option<Option<String>>=tx.query_row("SELECT CASE WHEN rejection IS NULL THEN NULL WHEN length(CAST(rejection AS BLOB)) BETWEEN 1 AND 1024 THEN rejection ELSE '' END FROM binary_commit_plans WHERE stage_id=?1 AND operation_id=?2",params![stage.stage_id().as_str(),stage.operation_id().as_str()],|r|r.get(0)).optional()?;
    let Some(Some(raw)) = rejection else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Err(corrupt("binary terminal rejection is empty or oversized"));
    }
    if record(tx, stage)?.is_none() {
        return Err(corrupt("binary rejection has no original request"));
    }
    Ok(Some(BinaryStageTerminal::Rejected(serde_json::from_str(
        &raw,
    )?)))
}
pub(super) fn terminal_manifest(
    tx: &Connection,
    stage: &BinaryStageRef,
) -> Result<Option<zorid_file_sync::Manifest>> {
    let request = if let Some((_, request)) = committed(tx, stage)? {
        Some(request)
    } else if matches!(
        terminal_status(tx, stage)?,
        Some(BinaryStageTerminal::Rejected(_))
    ) {
        match record(tx, stage)? {
            Some(PlanRecord::Authorized(plan)) => Some(plan.request),
            Some(PlanRecord::Rejected { request, .. }) => Some(request),
            _ => return Err(corrupt("binary terminal request missing")),
        }
    } else {
        None
    };
    Ok(request.map(|request| request.manifest))
}

pub(super) fn update_reserved(tx: &Connection, key: &EnvelopeKey) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM binary_commit_plans WHERE realm_id=?1 AND vault_id=?2 AND final_event_id=?3)",params![key.realm_id.as_str(),key.vault_id.as_str(),key.update_id.as_str()],|r|r.get(0))?)
}
pub(super) fn authorized_source_metadata(
    tx: &Connection,
    stage: &BinaryStageRef,
    id: &UpdateId,
) -> Result<EnvelopeMetadata> {
    let Some(PlanRecord::Authorized(plan)) = record(tx, stage)? else {
        return Err(invalid("binary source has no durable authorization"));
    };
    let info = blob_stage::stage_info(tx, stage)?;
    let phase = match (&info.purpose, plan.kind) {
        (StagePurpose::Command(request), PlanKind::Command) if request == &plan.request.request => {
            info.phase == StagePhase::CommitRequested
        }
        (StagePurpose::Capture(_), PlanKind::Capture) => info.phase == StagePhase::Sealed,
        _ => false,
    };
    if !phase
        || info.scope != plan.scope
        || info.manifest.as_ref() != Some(&plan.request.manifest)
        || info.source_commitment != Some(plan.request.source_commitment)
    {
        return Err(corrupt("binary source differs from authorized stage"));
    }
    if id == &plan.final_event_id {
        return Ok(plan.final_event);
    }
    blob_stage::expected_source_metadata(tx, stage, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::VaultPath;
    use zorid_sync_protocol::{RealmId, VaultId};

    fn op(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn fixture() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
        store
            .family_enroll(&Scope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        (dir, store)
    }
    fn create(id: &str, path: &str, len: u64) -> BinaryStageRequest {
        BinaryStageRequest {
            target: BinaryTarget::Create {
                id: EntryId::new(id).unwrap(),
                path: VaultPath::new(path).unwrap(),
            },
            expected_length: Some(len),
        }
    }
    fn sealed(
        store: &mut Store,
        operation: &str,
        request: &BinaryStageRequest,
        bytes: &[u8],
    ) -> BinaryStageRef {
        let stage = store
            .begin_binary_stage(
                &op("client"),
                &op(operation),
                request,
                DEFAULT_STREAMING_LIMITS,
            )
            .unwrap();
        for (sequence, chunk) in bytes.chunks(BINARY_STAGE_MAX_CHUNK_BYTES).enumerate() {
            store
                .append_binary_chunk(
                    &stage,
                    sequence as u32,
                    (sequence * BINARY_STAGE_MAX_CHUNK_BYTES) as u64,
                    chunk,
                )
                .unwrap();
        }
        store
            .seal_binary_stage(&stage, bytes.len() as u64, Some(Sha256Digest::of(bytes)))
            .unwrap();
        stage
    }
    fn inline(operation: &str, id: &str, path: &str, bytes: Vec<u8>) -> MutationRequest {
        MutationRequest {
            operation_id: op(operation),
            mutation: Mutation::Create {
                id: EntryId::new(id).unwrap(),
                path: VaultPath::new(path).unwrap(),
                kind: EntryKind::File,
                content: Some(bytes),
            },
        }
    }
    fn write(store: &Store, operation: &str, id: &str, bytes: Vec<u8>) -> MutationRequest {
        let id = EntryId::new(id).unwrap();
        let expected = entries(&store.connection)
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == id)
            .unwrap()
            .revision;
        MutationRequest {
            operation_id: op(operation),
            mutation: Mutation::Write {
                id,
                expected,
                content: bytes,
            },
        }
    }
    fn effects(store: &Store) -> (i64, i64, i64, i64, i64) {
        store.connection.query_row("SELECT (SELECT count(*) FROM operations),(SELECT count(*) FROM authored_envelopes),(SELECT count(*) FROM family_file_records),(SELECT count(*) FROM entries),(SELECT count(*) FROM projection_jobs)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
    }
    fn plan(store: &Store, stage: &BinaryStageRef) -> DurablePlan {
        let Some(PlanRecord::Authorized(plan)) = record(&store.connection, stage).unwrap() else {
            panic!("expected durable authorization")
        };
        plan
    }

    #[test]
    fn sealed_stage_needs_explicit_authorization_and_commits_references_once() {
        let (_dir, mut store) = fixture();
        let bytes = vec![0x91; BINARY_STAGE_MAX_CHUNK_BYTES + 7];
        let stage = sealed(
            &mut store,
            "create",
            &create("file", "file.bin", bytes.len() as u64),
            &bytes,
        );
        let before = effects(&store);
        assert_eq!(before, (0, 0, 0, 0, 0));
        assert!(store.commit_binary_stage(&stage).is_err());
        assert_eq!(effects(&store), before);
        assert_eq!(
            store.request_commit_binary_stage(&stage).unwrap().state,
            StagePhase::CommitRequested
        );
        assert_eq!(effects(&store), before);
        let source_count: i64 = store
            .connection
            .query_row("SELECT count(*) FROM immutable_payloads", [], |r| r.get(0))
            .unwrap();
        let commit = store.commit_binary_stage(&stage).unwrap();
        assert_eq!(commit.projection_job_ids.len(), 1);
        assert_eq!(effects(&store), (1, 4, 4, 1, 1)); // two chunks, page, final event
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM immutable_payloads", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            source_count
        );
        let (body, reference): (Option<Vec<u8>>, Option<String>) = store
            .connection
            .query_row(
                "SELECT content,content_ref FROM entries WHERE id='file'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(body.is_none());
        assert!(reference.is_some());
        assert_eq!(store.commit_binary_stage(&stage).unwrap(), commit);
        assert_eq!(effects(&store), (1, 4, 4, 1, 1));
    }

    #[test]
    fn draft_and_authorized_null_rejections_are_nonterminal() {
        let (_dir, mut store) = fixture();
        let call = inline("null-rejection", "file", "empty.bin", vec![]);
        let original =
            InlineCallCommitment::from_request(&call, Some(FamilyCreateMode::Binary)).unwrap();
        let target = inline_target(&store.connection, &call, 0).unwrap();
        let client = text_sync::identity(&store.connection)
            .unwrap()
            .local_store_id;
        let stage = store
            .begin_binary_stage(
                &client,
                &call.operation_id,
                &target,
                DEFAULT_STREAMING_LIMITS,
            )
            .unwrap();
        bind_inline(&mut store, &stage, &target, &original).unwrap();
        assert!(terminal_status(&store.connection, &stage)
            .unwrap()
            .is_none());
        let draft = store.query_binary_stage(&stage).unwrap();
        assert_eq!(draft.state, StagePhase::Receiving);
        assert!(draft.terminal.is_none());
        store
            .seal_binary_stage(&stage, 0, Some(original.digest))
            .unwrap();
        authorize(
            &mut store,
            &stage,
            &target,
            PlanKind::Command,
            Some(original),
            None,
            false,
        )
        .unwrap();
        assert!(terminal_status(&store.connection, &stage)
            .unwrap()
            .is_none());
        let authorized = store.query_binary_stage(&stage).unwrap();
        assert_eq!(authorized.state, StagePhase::CommitRequested);
        assert!(authorized.terminal.is_none());
        assert_eq!(effects(&store), (0, 0, 0, 0, 0));
    }

    #[test]
    fn unknown_result_replays_after_restart_new_revision_and_source_corruption() {
        let (dir, mut store) = fixture();
        let stage = sealed(
            &mut store,
            "original",
            &create("file", "file.bin", 3),
            b"old",
        );
        let manifest = store
            .binary_stage_content_manifest(&stage)
            .unwrap()
            .unwrap();
        assert_eq!(manifest.bytes, 3);
        assert_eq!(manifest.digest, Sha256Digest::of(b"old"));
        store.request_commit_binary_stage(&stage).unwrap();
        let original = store.commit_binary_stage(&stage).unwrap();
        let next = write(&store, "new-write", "file", b"new".to_vec());
        store.family_apply(&next, None).unwrap();
        let source = blob_stage::staged_sources(&store.connection, &stage)
            .unwrap()
            .remove(0);
        let before = effects(&store);
        // Fault injection explicitly removes the immutable-source guard.
        store
            .connection
            .execute_batch("DROP TRIGGER immutable_payloads_no_update")
            .unwrap();
        store.connection.execute("UPDATE immutable_payloads SET payload=zeroblob(payload_bytes) WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",params![source.key.realm_id.as_str(),source.key.vault_id.as_str(),source.key.update_id.as_str()]).unwrap();
        // Restore the required schema guard after injecting body corruption;
        // reopening must still validate the unchanged schema itself.
        let (_, guard) = immutable_payloads::SCHEMA
            .iter()
            .find(|(name, _)| *name == "immutable_payloads_no_update")
            .unwrap();
        store.connection.execute_batch(guard).unwrap();
        drop(store);
        let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
        assert_eq!(
            store.request_commit_binary_stage(&stage).unwrap().terminal,
            Some(BinaryStageTerminal::Committed(original.clone()))
        );
        assert_eq!(store.commit_binary_stage(&stage).unwrap(), original);
        assert_eq!(
            store
                .query_binary_stage(&stage)
                .unwrap()
                .finalized
                .as_ref()
                .map(BinaryStageManifest::manifest),
            Some(&manifest)
        );
        assert_eq!(
            store.binary_stage_content_manifest(&stage).unwrap(),
            Some(manifest)
        );
        assert_eq!(effects(&store), before);
        assert!(immutable_payloads::read_exact(&store.connection, &source).is_err());
    }

    #[test]
    fn stale_write_rejects_without_receipt_outbox_or_publication() {
        let (_dir, mut store) = fixture();
        store
            .family_apply(
                &inline("seed", "file", "file.bin", b"seed".to_vec()),
                Some(FamilyCreateMode::Binary),
            )
            .unwrap();
        let original_call = write(&store, "stale-write", "file", b"stale".to_vec());
        let request = inline_target(&store.connection, &original_call, 5).unwrap();
        let stage = sealed(&mut store, "stale-write", &request, b"stale");
        store.request_commit_binary_stage(&stage).unwrap();
        let next = write(&store, "winning-write", "file", b"winner".to_vec());
        store.family_apply(&next, None).unwrap();
        let before = effects(&store);
        assert!(store.commit_binary_stage(&stage).is_err());
        assert_eq!(effects(&store), before);
        let terminal = Some(BinaryStageTerminal::Rejected(BinaryStageRejection {
            code: BinaryStageRejectionCode::RevisionConflict,
        }));
        assert_eq!(store.query_binary_stage(&stage).unwrap().terminal, terminal);
        assert_eq!(
            store.request_commit_binary_stage(&stage).unwrap().terminal,
            terminal
        );
        assert_eq!(store.binary_stage_request(&stage).unwrap(), request);
    }

    #[test]
    fn inline_partial_restart_binds_original_digest_before_any_more_bytes() {
        let (dir, mut store) = fixture();
        let bytes = vec![19; BINARY_STAGE_MAX_CHUNK_BYTES + 9];
        let call = inline("inline", "file", "file.bin", bytes.clone());
        let original =
            InlineCallCommitment::from_request(&call, Some(FamilyCreateMode::Binary)).unwrap();
        let target = inline_target(&store.connection, &call, bytes.len() as u64).unwrap();
        let client = text_sync::identity(&store.connection)
            .unwrap()
            .local_store_id;
        let stage = store
            .begin_binary_stage(
                &client,
                &call.operation_id,
                &target,
                DEFAULT_STREAMING_LIMITS,
            )
            .unwrap();
        bind_inline(&mut store, &stage, &target, &original).unwrap();
        store
            .append_binary_chunk(&stage, 0, 0, &bytes[..BINARY_STAGE_MAX_CHUNK_BYTES])
            .unwrap();
        assert!(store.commit_binary_stage(&stage).is_err());
        drop(store);
        let mut store = Store::open(dir.path().join("store.sqlite")).unwrap();
        let mut changed = bytes.clone();
        *changed.last_mut().unwrap() = 20;
        let changed = inline("inline", "file", "file.bin", changed);
        assert!(matches!(
            store.family_apply(&changed, Some(FamilyCreateMode::Binary)),
            Err(StoreError::Contract(
                ContractError::IdempotencyConflict { .. }
            ))
        ));
        assert_eq!(
            store.query_binary_stage(&stage).unwrap().accepted_length,
            BINARY_STAGE_MAX_CHUNK_BYTES as u64
        );
        assert_eq!(effects(&store), (0, 0, 0, 0, 0));
        let original = store
            .family_apply(&call, Some(FamilyCreateMode::Binary))
            .unwrap();
        assert_eq!(
            store
                .family_apply(&call, Some(FamilyCreateMode::Binary))
                .unwrap(),
            original
        );
        assert_eq!(effects(&store), (1, 4, 4, 1, 1));
    }

    #[test]
    fn final_writer_failure_rolls_back_every_visible_effect_then_retries_original_plan() {
        let (_dir, mut store) = fixture();
        let stage = sealed(&mut store, "create", &create("file", "file.bin", 3), b"abc");
        store.request_commit_binary_stage(&stage).unwrap();
        let authorized = plan(&store, &stage);
        let before = effects(&store);
        store.connection.execute_batch("CREATE TRIGGER reject_test_projection BEFORE INSERT ON projection_jobs BEGIN SELECT RAISE(ABORT,'injected projection failure'); END").unwrap();
        assert!(matches!(
            store.commit_binary_stage(&stage),
            Err(StoreError::Sql(_))
        ));
        assert_eq!(effects(&store), before);
        assert_eq!(
            store.query_binary_stage(&stage).unwrap().state,
            StagePhase::CommitRequested
        );
        assert!(terminal_status(&store.connection, &stage)
            .unwrap()
            .is_none());
        store
            .connection
            .execute_batch("DROP TRIGGER reject_test_projection")
            .unwrap();
        store.commit_binary_stage(&stage).unwrap();
        let retried = plan(&store, &stage);
        assert_eq!(authorized.final_event, retried.final_event);
        assert_eq!(authorized.graph_revision, retried.graph_revision);
        assert_eq!(authorized.metadata_revision, retried.metadata_revision);
        assert_eq!(effects(&store), (1, 3, 3, 1, 1));
    }

    #[test]
    fn unrelated_graph_change_reprepares_same_event_and_empty_equal_writes_are_distinct() {
        let (_dir, mut store) = fixture();
        let stage = sealed(&mut store, "empty", &create("file", "empty.bin", 0), &[]);
        store.request_commit_binary_stage(&stage).unwrap();
        let original = plan(&store, &stage);
        store
            .family_apply(
                &inline("text", "text", "text.md", b"unrelated".to_vec()),
                Some(FamilyCreateMode::Text),
            )
            .unwrap();
        let first = store.commit_binary_stage(&stage).unwrap();
        let retried = plan(&store, &stage);
        assert_eq!(original.final_event, retried.final_event);
        assert_eq!(original.metadata_revision, retried.metadata_revision);
        let next = write(&store, "empty-again", "file", vec![]);
        let second = store.family_apply(&next, None).unwrap();
        assert_ne!(first.receipt.sequence, second.sequence);
        assert_ne!(
            first.receipt.changes[0].after.revision,
            second.changes[0].after.revision
        );
        assert_eq!(store.family_apply(&next, None).unwrap(), second);
        assert_eq!(store.commit_binary_stage(&stage).unwrap(), first);
    }

    #[test]
    fn oversized_receipt_rolls_back_publication_and_replays_typed_rejection() {
        let (_dir, mut store) = fixture();
        let mut path = String::new();
        for index in 0..16 {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(&"d".repeat(200));
            store
                .family_apply(
                    &MutationRequest {
                        operation_id: op(&format!("folder_{index}")),
                        mutation: Mutation::Create {
                            id: EntryId::new(format!("folder_{index}")).unwrap(),
                            path: VaultPath::new(&path).unwrap(),
                            kind: EntryKind::Folder,
                            content: None,
                        },
                    },
                    None,
                )
                .unwrap();
        }
        path.push_str("/file.bin");
        assert!(path.len() <= 4096);
        let stage = sealed(&mut store, "oversize", &create("file", &path, 0), &[]);
        store.request_commit_binary_stage(&stage).unwrap();
        let before = effects(&store);
        assert!(store.commit_binary_stage(&stage).is_err());
        assert_eq!(effects(&store), before);
        let terminal = Some(BinaryStageTerminal::Rejected(BinaryStageRejection {
            code: BinaryStageRejectionCode::TooLarge,
        }));
        assert_eq!(store.query_binary_stage(&stage).unwrap().terminal, terminal);
        assert_eq!(
            store.request_commit_binary_stage(&stage).unwrap().terminal,
            terminal
        );
        assert!(store.commit_binary_stage(&stage).is_err());
        assert_eq!(effects(&store), before);
        assert!(!entries(&store.connection)
            .unwrap()
            .iter()
            .any(|entry| entry.id.as_str() == "file"));
    }

    #[test]
    fn capture_requires_private_physical_authority_and_stays_readable_after_import() {
        let (_dir, mut store) = fixture();
        let client = op("capture-client");
        let path = VaultPath::new("capture.bin").unwrap();
        let stage = store
            .begin_binary_capture(
                &client,
                &op("capture"),
                &BinaryCaptureRequest {
                    path: path.clone(),
                    expected_length: 0,
                    expected_digest: Sha256Digest::of(&[]),
                },
                DEFAULT_STREAMING_LIMITS,
            )
            .unwrap();
        store.seal_binary_stage(&stage, 0, None).unwrap();
        assert!(store.request_commit_binary_stage(&stage).is_err());
        assert!(store.commit_binary_stage(&stage).is_err());
        let captured = store.captured_binary_ref(&stage).unwrap();
        let content = StoredContent::BinaryRef(BinarySourceRef::Capture(captured.clone()));
        let proof = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "public-inode".into(),
                parent_inode: "root-inode".into(),
            },
            expected_binding: None,
        };
        let observed = store
            .retain_external_content(&client, &path, None, &content, Some(&proof))
            .unwrap();
        store
            .prepare_family_external_create_content(
                &client,
                &observed.observation_id,
                EntryKind::File,
                Some(FamilyCreateMode::Binary),
            )
            .unwrap();
        let authorization = CaptureImportAuthorization::for_create(
            &store.connection,
            &client,
            &observed.observation_id,
        )
        .unwrap();
        let committed = commit_external_binary(&mut store, authorization).unwrap();
        assert_eq!(
            blob_stage::stage_info(&store.connection, &stage)
                .unwrap()
                .phase,
            StagePhase::Sealed
        );
        assert_eq!(store.captured_binary_ref(&stage).unwrap(), captured);
        assert_eq!(store.commit_binary_stage(&stage).unwrap(), committed); // receipt replay performs no import
        assert_eq!(effects(&store), (1, 1, 1, 1, 1));
    }
}
