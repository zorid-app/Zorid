//! Portable derived index contracts: no storage, IO, clock or network.
//! Pure publication checks are not durable commits. Hosts must recheck heads and
//! publish rows/head atomically in the same source/index storage transaction.
pub mod document_draft_executor;
pub mod document_runtime;
pub mod document_work_runtime;
pub mod draft_runtime;
mod extraction;
mod generation;
mod import;
mod literal;
mod metadata_rows;
mod persisted;
mod preview;
mod relationships;
mod resolver;
mod restore;
mod snapshot;
mod search;
pub use resolver::{
    is_external_destination, normalize_link_key, PreparedNamespace, Resolver, RESOLVER_VERSION,
};
pub use snapshot::{
    EntryWitness, IndexError, IndexSnapshotId, Manifest, PublicationFence, SemanticVersions,
    SourceSnapshotId, SourceWatermark, MAX_PUMP_BYTES, MAX_PUMP_DOCUMENTS,
};

/// Canonical metadata projection; this crate does not define a second parser result.
pub type MetadataProjection = zorid_document::DocumentMetadata;

pub use generation::{
    document_extraction_version, Exclusion, Generation, GenerationBuilder, IndexRecord,
    PreparedGeneration, INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION, MAX_GENERATION_METADATA_BYTES,
};
/// Sealed first-build captures; these reports never certify publication.
pub use preview::{
    PreviewCaptureError, PreviewCaptureOwner, PreviewFactsView, PreviewProgress, PreviewRowFacts,
    PreviewSnapshot, PreviewSnapshotId,
};

pub use literal::{
    LiteralPage, LiteralPageBuilder, LiteralQuery, LiteralToken, SearchHit, TextReadRequest,
};

/// Shared extraction input for native adapters without a second document dependency.
pub use zorid_document::MetadataRequest;

pub use relationships::{
    RelationshipDirection, RelationshipPage, RelationshipToken, ResolutionSnapshot, ResolutionView,
    ResolvedEdge,
};

pub use import::{GenerationSource, MAX_IMPORT_ENTRIES, MAX_IMPORT_SOURCE_BYTES};

pub use persisted::PersistedIndexRecord;

pub use extraction::{
    extract_content, parse_cache_admission, ContentExtractionKey, ContentExtractionOutcome,
    ContentExtractionResult, ExtractionDomain, ExtractionMode, ExtractionScope,
    ParseCacheAdmission, ParseCacheOutcome, ParseCacheUsage, FACTS_ENCODING_VERSION,
    MAX_EXTRACTION_ENVELOPE_OVERHEAD_BYTES, MAX_EXTRACTION_RESULT_BYTES, MAX_PARSE_CACHE_BYTES,
    MAX_PARSE_CACHE_EVICTIONS_PER_WRITE, MAX_PARSE_CACHE_ROWS, MAX_PARSE_CACHE_ROW_BYTES,
};

pub use search::{
    CompiledSearchQuery, SearchContentKind, SearchContentMatch, SearchDiagnostic,
    SearchDiagnosticCode, SearchDocument, SearchError, SearchEvaluation, SearchFieldMatches,
    SearchLimits, SearchMatches, SearchMetadataInput, SearchOptions, SearchPropertyMatch,
    SearchPropertyValueMatch, SearchRequirements, SearchSource, SearchTagMatch, SEARCH_DIALECT,
};

pub use search::{
    CoreSearchExplanation, DocumentRichSearchPage, ExplanationNode, SearchContext,
    SearchCount, SearchExplanationKind, SearchFileChunk, SearchKeyMatch, SearchLocation,
    SearchLocationRole, SearchLocator, SearchPageWork, SearchQueryCoverage, SearchScope,
    SearchSnippet, SearchSnippetHighlight, SearchSnippetOrigin, SearchSort, SearchSpec,
    SearchTotals, MAX_SEARCH_CANDIDATES, MAX_SEARCH_CHECKPOINTS, MAX_SEARCH_ORDER_BYTES,
    MAX_SEARCH_OWNED_BYTES, MAX_SEARCH_PAGE_BYTES, MAX_SEARCH_PAGE_CHUNKS, MAX_SEARCH_QUERIES,
};

/// Capability-free retained rich-search ordering and its preparation bounds.
pub use search::{
    SearchOrderError, SearchOrderPlan, SearchOrderPreparation, SearchOrderProgress,
    SearchPresentationFacts, MAX_SEARCH_ORDER_ADMISSION_WORK, MAX_SEARCH_ORDER_PUMP_WORK,
    MAX_SEARCH_ORDER_WORK,
};

pub use search::{
    CommittedRichSearchPage, PreparedRichSearchPage, RichPageProfile, RichPreparation, RichQueryId,
    RichSearchAction, RichSearchCursor, RichSearchDrive, RichSearchError, RichSearchOwner,
    RichSearchWorkBreakdown, RichTextReadRequest,
};

/// First-build queries remain distinct from published search authority.
pub use search::{
    CommittedPreviewSearchPage, PreparedPreviewSearchPage, PreviewPreparation, PreviewQueryId,
    PreviewRichSearchPage, PreviewSearchAction, PreviewSearchCursor, PreviewSearchDrive,
    PreviewSearchStatus, PreviewTextReadRequest,
};

/// Body-free committed metadata reset/delta paging; host pin admission remains external.
pub use metadata_rows::{
    MetadataRowsError, MetadataRowsFile, MetadataRowsItem, MetadataRowsMode, MetadataRowsScan,
    PreparedMetadataRowsPage, MAX_METADATA_ROWS, MAX_METADATA_ROWS_BYTES, MAX_METADATA_ROWS_WORK,
};
