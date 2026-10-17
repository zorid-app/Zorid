//! Native semantic results are derived from one retained, immutable generation.
//! These APIs never make cache success a condition of saving authoritative files.
use serde::Serialize;
use std::fmt;
use zorid_core::{EntryId, EntryState};
use zorid_index::{Exclusion, MetadataProjection};

pub use zorid_bases::{BaseQueryResult, EvaluationOptions, OperationCancellation, QueryOptions};
pub use zorid_index::{
    IndexSnapshotId, LiteralPage, LiteralQuery, LiteralToken, RelationshipDirection,
    RelationshipPage, RelationshipToken, ResolutionSnapshot, SourceSnapshotId,
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
}
impl fmt::Display for NativeDocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Native(error) => error.fmt(f),
            Self::Index(error) => error.fmt(f),
            Self::BaseCompile(error) => write!(f, "Invalid Base definition: {error:?}"),
            Self::BaseEvaluation(error) => error.fmt(f),
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
    /// Exact Base identity/revision/path whose retained bytes were compiled.
    pub definition: EntryState,
    pub result: BaseQueryResult,
}

impl NativeDocumentError {
    /// Stable transport category; diagnostics retain their shared engine code.
    pub fn code(&self) -> &str {
        use zorid_index::IndexError as I;
        use zorid_store::DocumentIndexError as D;
        match self {
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
