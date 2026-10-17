use crate::PropertyValue;
use serde::{Deserialize, Serialize};
use zorid_core::{EntryId, Revision};

pub const SCHEMA_VERSION: u32 = 1;
pub const DIALECT_VERSION: &str = "zorid-markdown-1";
pub const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_FRONTMATTER_BYTES: usize = 1024 * 1024;
pub const MAX_YAML_DEPTH: usize = 64;
pub const MAX_VALUE_NODES: usize = 100_000;
pub const MAX_ALIAS_NODES: usize = 1_000;
pub const MAX_EXPANDED_YAML_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataRequest {
    pub entry_id: EntryId,
    pub content_revision: Revision,
    pub source: String,
}

/// Half-open coordinates in the exact original input, never normalized text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRange {
    pub bytes: [u32; 2],
    pub utf16: [u32; 2],
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceLength {
    pub bytes: u32,
    pub utf16: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePoint {
    pub byte: u32,
    pub utf16: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontmatterState {
    Absent,
    Valid,
    Invalid,
    Unclosed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frontmatter {
    pub state: FrontmatterState,
    pub range: Option<SourceRange>,
    pub body_start: SourcePoint,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PropertyType {
    Text,
    List,
    Number,
    Checkbox,
    Date,
    Datetime,
    Tags,
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Property {
    pub key: String,
    pub value: PropertyValue,
    #[serde(rename = "type")]
    pub property_type: PropertyType,
    pub key_range: SourceRange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TagOccurrence {
    pub name: String,
    pub range: SourceRange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heading {
    pub text: String,
    pub level: u8,
    pub line: u32,
    pub range: SourceRange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Wiki,
    Markdown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Link {
    pub kind: LinkKind,
    pub embed: bool,
    /// Exact raw path spelling, prior to Markdown/entity/percent decoding.
    pub target: String,
    /// Exact raw fragment, including '#' when present.
    pub fragment: String,
    /// Established parser's semantic URL; wiki destinations retain raw spelling.
    pub destination: String,
    pub range: SourceRange,
    pub target_range: SourceRange,
    pub definition_range: Option<SourceRange>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub status: String,
    pub checked: bool,
    pub completed: bool,
    pub text: String,
    pub line: u32,
    pub range: SourceRange,
    pub status_range: SourceRange,
    pub text_range: SourceRange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    FrontmatterUnclosed,
    FrontmatterSyntax,
    FrontmatterDuplicateKey,
    FrontmatterMapping,
    FrontmatterTag,
    FrontmatterAlias,
    FrontmatterValue,
    FrontmatterResource,
    ProjectionNonString,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub severity: Severity,
    pub range: SourceRange,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentMetadata {
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
    pub tasks: Vec<Task>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ExtractionError {
    SourceTooLarge { maximum_bytes: usize },
}
impl std::fmt::Display for ExtractionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceTooLarge { maximum_bytes } => {
                write!(formatter, "Markdown source exceeds {maximum_bytes} bytes")
            }
        }
    }
}
impl std::error::Error for ExtractionError {}
