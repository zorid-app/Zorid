//! Native semantic results are derived from one retained, immutable generation.
//! These APIs never make cache success a condition of saving authoritative files.
use serde::{Deserialize, Serialize};
use std::fmt;
use zorid_core::{EntryId, EntryState};
use zorid_index::{Exclusion, MetadataProjection};

pub use zorid_bases::tasks::{TaskFilter, TaskQueryOptions, TaskQueryResult};
pub use zorid_bases::types::TaskTypeSummary;
pub use zorid_bases::{BaseQueryResult, EvaluationOptions, OperationCancellation, QueryOptions};
pub use zorid_document::InlineBaseSource;
/// Optional browser/native wire attachment; never trusted without the retained
/// generation's source commitment and exact root property-settings path.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentPropertyDefinitionsSource {
    pub id: EntryId,
    pub source: String,
}
pub use zorid_index::{
    IndexSnapshotId, LiteralPage, LiteralQuery, LiteralToken, RelationshipDirection,
    RelationshipPage, RelationshipToken, ResolutionSnapshot, SourceSnapshotId,
    DocumentRichSearchPage, RichPageProfile, SearchContext, SearchCount, SearchDiagnostic,
    SearchDiagnosticCode, SearchQueryCoverage, SearchSort, SearchSpec, SearchTotals,
};
pub use zorid_store::{
    DocumentIndexError, DocumentIndexProgress, DocumentIndexStage, DocumentIndexStatus,
    DocumentQueryPin,
};

/// Deliberately separate from the native storage Error: existing storage/ABI
/// callers do not acquire new exhaustive error variants for disposable queries.
#[derive(Debug)]
pub enum NativeDocumentError {
    Native(crate::Error),
    Index(zorid_store::DocumentIndexError),
    BaseCompile(zorid_bases::BaseCompileError),
    BaseEvaluation(zorid_bases::ExpressionDiagnostic),
    SourceUnavailable(EntryId),
    SearchCompile(SearchDiagnostic),
    SearchResource(&'static str),
    SearchInvalid(&'static str),
    SearchExpired,
    SearchBusy,
    QueryCancelled,
    PreviewExpired,
    PreviewResource,
    PreviewBusy,
    Calendar(crate::WorkBlockError),
}
impl fmt::Display for NativeDocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Calendar(error) => write!(f, "Calendar: {}", error.code()),
            Self::Native(error) => error.fmt(f),
            Self::Index(error) => error.fmt(f),
            Self::BaseCompile(error) => write!(f, "Invalid Base definition: {error:?}"),
            Self::BaseEvaluation(error) => error.fmt(f),
            Self::SearchCompile(error) => error.fmt(f),
            Self::SearchResource(detail) => write!(f, "Search resource limit: {detail}"),
            Self::SearchInvalid(detail) => write!(f, "Invalid search request: {detail}"),
            Self::SearchExpired => f.write_str("Search query or cursor expired"),
            Self::SearchBusy => f.write_str("Search query is already being driven"),
            Self::QueryCancelled => f.write_str("Query cancelled"),
            Self::PreviewExpired => f.write_str("Preview capture expired"),
            Self::PreviewResource => f.write_str("Preview resource limit"),
            Self::PreviewBusy => f.write_str("Preview is already borrowed"),
            Self::SourceUnavailable(id) => {
                write!(f, "No eligible text projection for entry {}", id.as_str())
            }
        }
    }
}
impl std::error::Error for NativeDocumentError {}
impl From<crate::Error> for NativeDocumentError {
    fn from(error: crate::Error) -> Self {
        Self::Native(error)
    }
}
impl From<zorid_store::DocumentIndexError> for NativeDocumentError {
    fn from(error: zorid_store::DocumentIndexError) -> Self {
        Self::Index(error)
    }
}
impl From<zorid_index::IndexError> for NativeDocumentError {
    fn from(error: zorid_index::IndexError) -> Self {
        Self::Index(error.into())
    }
}
impl From<zorid_bases::ExpressionDiagnostic> for NativeDocumentError {
    fn from(error: zorid_bases::ExpressionDiagnostic) -> Self {
        Self::BaseEvaluation(error)
    }
}
impl From<zorid_bases::BaseCompileError> for NativeDocumentError {
    fn from(error: zorid_bases::BaseCompileError) -> Self {
        Self::BaseCompile(error)
    }
}
pub type NativeDocumentResult<T> = std::result::Result<T, NativeDocumentError>;

/// Source identity is explicit even when the live authority has advanced.
/// Coverage describes extraction, independently of a paged query's scan state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentQueryResult<T> {
    pub snapshot: IndexSnapshotId,
    pub source: SourceSnapshotId,
    pub coverage_complete: bool,
    pub value: T,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadataResult {
    pub entry: EntryState,
    pub metadata: Option<MetadataProjection>,
    pub exclusion: Option<Exclusion>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBaseResult {
    /// Exact saved Base file or fenced-Base containing note whose retained bytes
    /// authorized the compiled source.
    pub definition: EntryState,
    pub result: BaseQueryResult,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPropertyTargetsResult {
    pub definition: Option<EntryState>,
    pub relation_targets: std::collections::BTreeMap<String, Vec<zorid_bases::relations::RelationTarget>>,
    pub property_definition_diagnostics: Vec<zorid_bases::properties::PropertyDefinitionDiagnostic>,
    pub refresh_hint: Option<zorid_bases::BaseRefreshHint>,
}

/// Definitions and task capabilities compiled from actual retained YAML bytes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTasksResult {
    pub definitions: Vec<EntryState>,
    pub types: Vec<TaskTypeSummary>,
    pub result: TaskQueryResult,
}

impl NativeDocumentError {
    /// Stable transport category; diagnostics retain their shared engine code.
    pub fn code(&self) -> &str {
        use zorid_index::IndexError as I;
        use zorid_store::DocumentIndexError as D;
        match self {
            Self::Calendar(error) => error.code(),
            Self::SearchCompile(_) => "search_compile",
            Self::SearchResource(_) => "search_resource",
            Self::SearchInvalid(_) => "invalid_request",
            Self::SearchExpired => "search_expired",
            Self::SearchBusy => "search_busy",
            Self::QueryCancelled => "cancelled",
            Self::PreviewExpired => "index_preview_expired",
            Self::PreviewResource => "index_preview_resource",
            Self::PreviewBusy => "index_preview_busy",
            Self::Native(crate::Error::UnsafePath(_)) => "unsafe_path",
            Self::Native(_) => "native_error",
            Self::Index(D::RebuildRequired) => "rebuild_required",
            Self::Index(D::NotReady) => "index_not_ready",
            Self::Index(D::Authority(_)) => "authority_error",
            Self::Index(D::Contract(error)) => match error {
                I::SnapshotExpired => "snapshot_expired",
                I::StaleSource => "stale_source",
                I::StaleIndex => "stale_index",
                I::MissingSource => "missing_source",
                I::InvalidQuery => "invalid_query",
                I::QueryMismatch => "query_mismatch",
                I::InvalidBudget => "invalid_budget",
                I::GenerationLimit => "generation_limit",
                I::PumpLimit => "pump_limit",
                I::NoProgress => "no_progress",
                _ => "index_contract_error",
            },
            Self::BaseCompile(_) => "base_compile",
            Self::BaseEvaluation(error) => &error.code,
            Self::SourceUnavailable(_) => "source_unavailable",
        }
    }
}

impl From<crate::WorkBlockError> for NativeDocumentError {
    fn from(error: crate::WorkBlockError) -> Self { Self::Calendar(error) }
}

/// Host-owned query lifetime. The exact admitted pin never enters the pure
/// search owner. This guard is deliberately non-Clone and non-serializable.
pub struct NativeRichQuery {
    pub(crate) pin: std::sync::Arc<DocumentQueryPin>,
    pub(crate) owner: std::sync::Weak<std::sync::Mutex<zorid_index::RichSearchOwner>>,
    pub(crate) id: zorid_index::RichQueryId,
}
/// An actual core checkpoint, not a caller-authored JSON offset or source proof.
#[derive(Clone)]
pub struct NativeRichCursor {
    pub(crate) owner: std::sync::Weak<std::sync::Mutex<zorid_index::RichSearchOwner>>,
    pub(crate) value: zorid_index::RichSearchCursor,
}
impl PartialEq for NativeRichCursor {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Weak::ptr_eq(&self.owner, &other.owner) && self.value == other.value
    }
}
impl Eq for NativeRichCursor {}
pub enum NativeRichPreparation {
    Preparing,
    Ready(NativeRichCursor),
}
/// Adapters serialize only result and map next to a scoped opaque handle.
pub struct NativeRichPage {
    pub result: DocumentQueryResult<DocumentRichSearchPage>,
    pub next: Option<NativeRichCursor>,
}


// Lifecycle controls never accept adapter completions or caller-authored
// observations. Effects and immutable updates are reports, not capabilities.
pub use zorid_index::document_runtime::{
    Execution as DocumentRuntimeExecution, Failure as DocumentRuntimeFailure,
    Freshness as DocumentRuntimeFreshness, FreshnessRequest as DocumentFreshnessRequest,
    Phase as DocumentRuntimePhase, Reduction as DocumentRuntimeReduction,
    RequestOutcome as DocumentRuntimeRequestOutcome, RuntimeError as DocumentRuntimeContractError,
    RuntimeUpdate as DocumentRuntimeUpdate,
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocumentRuntimeCommand {
    Wake { monotonic_ms: u64 },
    Continue,
    SourceHint,
    Request(DocumentFreshnessRequest),
    CancelRequest { id: u64 },
    Retire,
}
#[derive(Debug)]
pub enum NativeDocumentRuntimeError {
    Document(NativeDocumentError),
    Contract(DocumentRuntimeContractError),
    NotStarted,
    NoEffect,
}
impl fmt::Display for NativeDocumentRuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Document(error) => error.fmt(f),
            Self::Contract(error) => error.fmt(f),
            Self::NotStarted => f.write_str("Document runtime has not started"),
            Self::NoEffect => f.write_str("Document runtime has no issued effect"),
        }
    }
}
impl std::error::Error for NativeDocumentRuntimeError {}
impl From<NativeDocumentError> for NativeDocumentRuntimeError {
    fn from(error: NativeDocumentError) -> Self { Self::Document(error) }
}
impl From<DocumentRuntimeContractError> for NativeDocumentRuntimeError {
    fn from(error: DocumentRuntimeContractError) -> Self { Self::Contract(error) }
}
impl NativeDocumentRuntimeError {
    pub fn code(&self) -> &str {
        match self {
            Self::Document(error) => error.code(),
            Self::Contract(DocumentRuntimeContractError::Capacity) => "document_runtime_capacity",
            Self::Contract(DocumentRuntimeContractError::Retired) => "document_runtime_retired",
            Self::Contract(_) => "document_runtime_contract",
            Self::NotStarted => "document_runtime_not_started",
            Self::NoEffect => "document_runtime_idle",
        }
    }
}
pub type NativeDocumentRuntimeResult<T> = Result<T, NativeDocumentRuntimeError>;


pub use zorid_index::document_runtime::{
    Effect as DocumentRuntimeEffect, EffectResult as DocumentRuntimeEffectResult,
    IssuedEffect as DocumentRuntimeIssuedEffect, Observation as DocumentRuntimeObservation,
    StageObservation as DocumentRuntimeStageObservation, StageProgress as DocumentRuntimeStageProgress,
    Priority as DocumentRuntimePriority,
};
/// Read-only actual execution data in the existing single step ACK slot.
/// It owns no body, pin, stage capability, transaction or write authority.
#[derive(Clone, Debug)]
pub struct NativeDocumentRuntimeReceipt {
    pub issued: DocumentRuntimeIssuedEffect,
    pub completion: DocumentRuntimeEffectResult,
    pub pump: Option<std::sync::Arc<DocumentIndexProgress>>,
}
#[derive(Clone, Debug)]
pub struct NativeDocumentRuntimeStepRecord {
    pub lifetime: zorid_core::OperationId,
    pub effect_id: u64,
    pub reduction: DocumentRuntimeReduction,
    pub receipt: NativeDocumentRuntimeReceipt,
}
#[derive(Clone, Debug)]
pub struct NativeDocumentRuntimeSnapshot {
    pub execution: DocumentRuntimeExecution,
    pub update: DocumentRuntimeUpdate,
    pub in_flight: Option<DocumentRuntimeIssuedEffect>,
    pub last_step: Option<NativeDocumentRuntimeStepRecord>,
}

/// Pure metadata cursor data, sealed to the exact admitted generation Arcs.
/// Actual pin registration and lifecycle remain with the host. Clones are cheap
/// retry checkpoints; no DocumentQueryPin capability is retained here.
#[derive(Clone)]
pub struct NativeMetadataRows {
    pub(crate) scan: zorid_index::MetadataRowsScan,
    pub(crate) destination: std::sync::Arc<zorid_index::Generation>,
    pub(crate) baseline: Option<std::sync::Arc<zorid_index::Generation>>,
    pub(crate) checkpoint: std::sync::Arc<()>,
    pub(crate) next_checkpoint: std::sync::Arc<()>,
}
impl PartialEq for NativeMetadataRows {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.checkpoint, &other.checkpoint)
    }
}
impl Eq for NativeMetadataRows {}
impl NativeMetadataRows {
    pub fn uses_baseline(&self) -> bool {
        self.baseline.is_some()
    }
    /// O(1) continuation deduplication before encoding. Every clone of this
    /// checkpoint commits to the same successor identity, without reading facts.
    pub fn has_successor(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.next_checkpoint, &other.checkpoint)
    }
}
pub use zorid_index::PreparedMetadataRowsPage;

/// Transient draft analysis and the shared core-selected native executor.
/// These types carry no committed entry witness or save authority.
pub use crate::native::document_drafts::{
    NativeDocumentWorkError, NativeDraftCommand, NativeDraftSnapshot,
    NativeDraftStepRecord, NativeWorkReceipt, NativeWorkStepRecord,
};

/// Metadata-only transient transfer progress and typed failures; payload stays core-owned.
pub use crate::native::document_drafts::{NativeDraftTransferError, NativeDraftTransferProgress};

/// Existing draft/work values for trusted platform adapters. Constructed values
/// are never completion proofs; execution resolves the actual selected ticket.
pub use zorid_index::draft_runtime::{
    BufferKey as DraftBufferKey, DraftTag, DraftRequest,
    SourceDescriptor as DraftSourceDescriptor, JobToken as DraftJobToken,
    Reduction as DraftReduction, Execution as DraftExecution,
    OutcomeKind as DraftOutcomeKind, RuntimeError as DraftRuntimeError,
    UnavailableCode as DraftUnavailableCode,
};
pub use zorid_index::document_work_runtime::{
    Ticket as DocumentWorkTicket, ChildEffect as DocumentWorkChildEffect,
    Lane as DocumentWorkLane, WorkState as DocumentWorkState,
};

/// Read-only first-build captures, deliberately distinct from ordinary pins.
pub use crate::native::document_preview::{
    NativeBasePreview, NativeBasePreviewReply, NativePreviewDescriptor, NativePreviewStamp,
};
