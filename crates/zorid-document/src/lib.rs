//! Portable derived Markdown semantics. Raw vault files remain authoritative;
//! parsing never reads the filesystem or rewrites content.
mod frontmatter;
mod markdown;
mod positions;
mod phases;
pub use phases::{ParseFactsJob, ParseFactsJobError, ParseFactsPhase, ParseFactsResourceKind, ParseFactsStep, ParseFactsStepBudget, ParseFactsUsage};
mod types;
mod value;

pub use frontmatter::parse_yaml_mapping;
pub use types::*;
pub use value::PropertyValue;

/// Extract metadata for exactly one entry/content revision. Callers own stale
/// publication checks and optional path/vault context. Invalid YAML is metadata
/// with diagnostics; it is never a refusal to persist or sync the source.
pub fn parse_markdown(request: &MetadataRequest) -> Result<DocumentMetadata, ExtractionError> {
    Ok(parse_markdown_facts(&request.source)?
        .bind(request.entry_id.clone(), request.content_revision.clone()))
}

/// Extract bounded, identity-free facts from exact source text. Invalid YAML
/// remains successful extraction with diagnostics. No path, store or publication
/// witness is inferred; callers correlate facts with their source before binding.
pub fn parse_markdown_facts(source: &str) -> Result<ParseFacts, ExtractionError> {
    phases::parse_borrowed(source)
}
