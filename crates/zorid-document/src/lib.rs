//! Portable derived Markdown semantics. Raw vault files remain authoritative;
//! parsing never reads the filesystem or rewrites content.
mod frontmatter;
mod markdown;
mod positions;
mod types;
mod value;

pub use types::*;
pub use value::PropertyValue;

/// Extract metadata for exactly one entry/content revision. Callers own stale
/// publication checks and optional path/vault context. Invalid YAML is metadata
/// with diagnostics; it is never a refusal to persist or sync the source.
pub fn parse_markdown(request: &MetadataRequest) -> Result<DocumentMetadata, ExtractionError> {
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(ExtractionError::SourceTooLarge {
            maximum_bytes: MAX_SOURCE_BYTES,
        });
    }
    let positions = positions::Positions::new(&request.source);
    let mut result = DocumentMetadata {
        schema_version: SCHEMA_VERSION,
        dialect_version: DIALECT_VERSION.into(),
        entry_id: request.entry_id.clone(),
        content_revision: request.content_revision.clone(),
        source_length: positions.length(),
        frontmatter: Frontmatter {
            state: FrontmatterState::Absent,
            range: None,
            body_start: positions.point(0),
        },
        properties: Vec::new(),
        aliases: Vec::new(),
        tags: Vec::new(),
        tag_occurrences: Vec::new(),
        headings: Vec::new(),
        links: Vec::new(),
        tasks: Vec::new(),
        diagnostics: Vec::new(),
    };
    frontmatter::extract(&request.source, &positions, &mut result);
    markdown::extract(&request.source, &positions, &mut result);
    Ok(result)
}
