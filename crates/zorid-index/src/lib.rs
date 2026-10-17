//! Portable derived index contracts: no storage, IO, clock or network.
//! Pure publication checks are not durable commits. Hosts must recheck heads and
//! publish rows/head atomically in the same source/index storage transaction.
mod generation;
mod literal;
mod resolver;
mod snapshot;
pub use resolver::{normalize_link_key, Resolver, RESOLVER_VERSION};
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
pub use literal::{
    LiteralPage, LiteralPageBuilder, LiteralQuery, LiteralToken, SearchHit, TextReadRequest,
};
