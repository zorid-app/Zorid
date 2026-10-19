//! Test-only projection onto the frozen schema-1 corpus. This does not migrate
//! runtime metadata or accept old facts under the new extraction version.
use serde::{Deserialize, Serialize};
use zorid_core::{EntryId, Revision};
use zorid_document::{
    Diagnostic, DocumentMetadata, Frontmatter, Heading, Link, Property, SourceLength, SourceRange,
    TagOccurrence,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMetadata {
    pub schema_version: u32,
    pub dialect_version: String,
    pub entry_id: EntryId,
    pub content_revision: Revision,
    pub source_length: SourceLength,
    pub frontmatter: Frontmatter,
    pub properties: Vec<Property>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub tag_occurrences: Vec<TagOccurrence>,
    pub headings: Vec<Heading>,
    pub links: Vec<Link>,
    pub tasks: Vec<LegacyTask>,
    pub diagnostics: Vec<Diagnostic>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyTask {
    pub status: String,
    pub checked: bool,
    pub completed: bool,
    pub text: String,
    pub line: u32,
    pub range: SourceRange,
    pub status_range: SourceRange,
    pub text_range: SourceRange,
}
pub fn schema_one_projection(current: &DocumentMetadata) -> LegacyMetadata {
    assert_eq!(current.schema_version, zorid_document::SCHEMA_VERSION);
    assert_eq!(current.schema_version, 2);
    LegacyMetadata {
        schema_version: 1,
        dialect_version: current.dialect_version.clone(),
        entry_id: current.entry_id.clone(),
        content_revision: current.content_revision.clone(),
        source_length: current.source_length.clone(),
        frontmatter: current.frontmatter.clone(),
        properties: current.properties.clone(),
        aliases: current.aliases.clone(),
        tags: current.tags.clone(),
        tag_occurrences: current.tag_occurrences.clone(),
        headings: current.headings.clone(),
        links: current.links.clone(),
        tasks: current
            .tasks
            .iter()
            .map(|task| LegacyTask {
                status: task.status.clone(),
                checked: task.checked,
                completed: task.completed,
                text: task.text.clone(),
                line: task.line,
                range: task.range.clone(),
                status_range: task.status_range.clone(),
                text_range: task.text_range.clone(),
            })
            .collect(),
        diagnostics: current.diagnostics.clone(),
    }
}
