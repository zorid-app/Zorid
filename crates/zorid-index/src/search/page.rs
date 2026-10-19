//! Shared rich-search projections. These types are data, not query/pin/source
//! authority. Host cursors stay opaque and the inner next is always null.
use super::SearchContentKind;
use crate::IndexSnapshotId;
use serde::{Deserialize, Serialize};
use zorid_core::EntryState;
use zorid_document::SourceRange;

pub const MAX_SEARCH_CANDIDATES: usize = 100_000;
pub const MAX_SEARCH_ORDER_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SEARCH_QUERIES: usize = 4;
pub const MAX_SEARCH_OWNED_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_SEARCH_CHECKPOINTS: usize = 8;
pub const MAX_SEARCH_PAGE_CHUNKS: usize = 100;
pub const MAX_SEARCH_PAGE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchSort {
    #[default]
    NameAsc,
    NameDesc,
    ModifiedDesc,
    ModifiedAsc,
    CreatedDesc,
    CreatedAsc,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchContext {
    #[default]
    Line,
    Section,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchSpec {
    pub query: String,
    pub case_sensitive: bool,
    pub sort: SearchSort,
    pub context: SearchContext,
    pub explain: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchScope {
    File,
    Path,
    Content,
    Line,
    Block,
    Section,
    Task,
    TaskTodo,
    TaskDone,
    Tag,
    MatchCase,
    IgnoreCase,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "relation", rename_all = "camelCase")]
pub enum SearchCount {
    Exact { value: u64 },
    AtLeast { value: u64 },
    Unknown { value: () },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SearchKeyMatch {
    Ranges { ranges: Vec<SourceRange> },
    Exists,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "origin",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchLocator {
    Source {
        range: SourceRange,
        kind: SearchContentKind,
    },
    Filename {
        range: SourceRange,
    },
    Path {
        range: SourceRange,
    },
    PropertyKey {
        key: String,
        #[serde(rename = "match")]
        key_match: SearchKeyMatch,
    },
    PropertyValue {
        key: String,
        array_path: Vec<u32>,
        value_text: String,
        range: SourceRange,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchLocationRole {
    Occurrence,
    Existence,
    Predicate,
    Anchor,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchLocation {
    /// Stable per-file ordinal, independent of the current output chunk.
    pub index: u32,
    pub locator: SearchLocator,
    pub role: SearchLocationRole,
    /// Core-proved contribution. Touch-merged highlights can contain more than
    /// one occurrence. Consumers display file counts instead of summing chunks.
    pub occurrences: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchSnippetOrigin {
    Source,
    Filename,
    Path,
    PropertyKey,
    PropertyValue,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSnippetHighlight {
    pub utf16: [u32; 2],
    pub location_indices: Vec<u32>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSnippet {
    pub origin: SearchSnippetOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub array_path: Option<Vec<u32>>,
    /// Exact contiguous field slice. Ellipses are outside this text.
    pub text: String,
    pub origin_range: SourceRange,
    pub primary_location_index: u32,
    /// Sorted, nonoverlapping, nonempty local UTF16 display intervals. Core
    /// supplies all associated locations; views do not merge or rediscover them.
    pub highlights: Vec<SearchSnippetHighlight>,
    pub clipped_before: bool,
    pub clipped_after: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileChunk {
    pub entry: EntryState,
    pub chunk: u32,
    pub last_chunk: bool,
    /// Exact full-file summary repeated unchanged on every chunk; not additive.
    pub occurrence_count: u32,
    pub locations: Vec<SearchLocation>,
    pub snippets: Vec<SearchSnippet>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchExplanationKind {
    Text,
    Quoted,
    Regex,
    Constant,
    And,
    Or,
    Not,
    Compare,
    Scope,
    Property,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplanationNode {
    pub kind: SearchExplanationKind,
    pub query_range: SourceRange,
    pub case_sensitive: bool,
    pub scope: Option<SearchScope>,
    pub operand: Option<String>,
    pub children: Vec<ExplanationNode>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSearchExplanation {
    pub dialect: String,
    pub root: Option<ExplanationNode>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTotals {
    pub files: SearchCount,
    pub occurrences: SearchCount,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryCoverage {
    pub candidate_files: u32,
    pub evaluated_files: u32,
    pub unavailable_files: u32,
    pub scan_complete: bool,
    pub query_coverage_complete: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageWork {
    pub documents: u32,
    pub source_bytes: u64,
    pub units: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRichSearchPage {
    pub snapshot: IndexSnapshotId,
    pub next: (),
    pub scan_complete: bool,
    pub coverage_complete: bool,
    pub complete: bool,
    pub dialect: String,
    pub spec: SearchSpec,
    pub explanation: Option<CoreSearchExplanation>,
    pub files: Vec<SearchFileChunk>,
    pub totals: SearchTotals,
    pub coverage: SearchQueryCoverage,
    pub output_complete: bool,
    pub work: SearchPageWork,
}
