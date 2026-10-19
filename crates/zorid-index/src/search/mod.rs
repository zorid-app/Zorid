//! Bounded, pure search over caller-admitted immutable document data.
//!
//! This module supplies no source/pin authority. Hosts must correlate metadata
//! and retained text, then attach their own snapshot/entry/revision witnesses.
//! Regex calls are synchronous: cancellation is observed before/after each
//! bounded call, not by preempting the regex engine mid-call.
//!
//! Dialect: pinned Rust Unicode scalar/simple-fold semantics, no normalization
//! or locale folding. Inline flags are explicitly supported engine syntax, not
//! JavaScript compatibility. Quotes retain Letter/Decimal_Number boundaries.
//! No suffix flags, lookaround, backreferences or runtime language fallback.
//!
//! Deliberate provenance corrections to the TS reference artifact: root EMPTY
//! can succeed with no source locations (the artifact invented [0,4] from null);
//! parser-produced headingless files form one whole-source section, independent
//! of the artifact's optional headings-field representation.
//! A frontmatter tag match locates the actual first case-insensitively selected
//! key; the artifact could select `Tags` but report another existing `tags` key.
//! Selection order/value remain unchanged; this is not duplicate-key parity.
//!
//! AST/token/source/output limits are hard ceilings. Regex size and lazy DFA
//! bounds are conservatively partitioned across a token upper bound and both
//! case variants, totaling at most 8MiB for each documented engine component;
//! these are not a claim about total process or allocator heap. Work is charged
//! in typed visits and 64-byte scan blocks. Fixed literals (including regex
//! without metacharacters/escapes/flags) prepay the field once plus bounded
//! pattern work per call; arbitrary regex prepays each remaining haystack. It is
//! not a CPU-instruction counter. A resource failure never returns partial hits.
mod evaluate;
mod order;
pub use order::*;
mod page;
mod parser;
mod proof;
mod snippet;
mod preview;
pub use preview::{
    CommittedPreviewSearchPage, PreparedPreviewSearchPage, PreviewPreparation, PreviewQueryId,
    PreviewRichSearchPage, PreviewSearchAction, PreviewSearchCursor, PreviewSearchDrive,
    PreviewSearchStatus, PreviewTextReadRequest,
};
mod runtime;
pub use page::*;
pub use runtime::*;

use serde::{Deserialize, Serialize};
use zorid_document::{DocumentMetadata, SourceRange};

pub const SEARCH_DIALECT: &str = "zorid-search-rust-unicode-1";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
}

/// Hosts may tighten these limits, but cannot exceed the shared hard ceilings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchLimits {
    pub query_bytes: usize,
    pub tokens: usize,
    pub nodes: usize,
    pub depth: usize,
    pub source_bytes: usize,
    pub regex_bytes: usize,
    pub regex_variant_bytes: usize,
    pub work: usize,
    pub spans: usize,
    pub output_bytes: usize,
}
impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            query_bytes: 4096,
            tokens: 512,
            nodes: 512,
            depth: 64,
            source_bytes: 16 * 1024 * 1024,
            regex_bytes: 8 * 1024 * 1024,
            regex_variant_bytes: 1024 * 1024,
            work: 2_000_000,
            spans: 10_000,
            output_bytes: 1024 * 1024,
        }
    }
}
impl SearchLimits {
    fn valid(&self) -> bool {
        let hard = Self::default();
        self.query_bytes <= hard.query_bytes
            && self.tokens <= hard.tokens
            && self.nodes <= hard.nodes
            && self.depth <= hard.depth
            && self.source_bytes <= hard.source_bytes
            && self.regex_bytes <= hard.regex_bytes
            && self.regex_variant_bytes <= hard.regex_variant_bytes
            && self.work <= hard.work
            && self.spans <= hard.spans
            && self.output_bytes <= hard.output_bytes
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchDiagnosticCode {
    UnknownOperator,
    InvalidNesting,
    InvalidOperand,
    InvalidRegex,
    UnsupportedRegex,
    Resource,
    InvalidDocument,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchDiagnostic {
    pub code: SearchDiagnosticCode,
    /// Coordinates in the exact query, not in a searched document.
    pub query_range: SourceRange,
    pub message: String,
}
impl std::fmt::Display for SearchDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for SearchDiagnostic {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequirements {
    pub content: bool,
    pub metadata: bool,
}

/// Known non-text and unavailable extraction are deliberately different.
#[derive(Clone, Copy)]
pub enum SearchSource<'a> {
    Text(&'a str),
    NotText,
    Unavailable,
}
#[derive(Clone, Copy)]
/// Present metadata must come from the host's validated extraction result for
/// this exact retained source. Evaluation checks schema/length/used-range bounds,
/// not metadata authenticity or identity. It cannot replace the host's digest,
/// extraction-key, strong-range-validation and final publication fences.
pub enum SearchMetadataInput<'a> {
    Present(&'a DocumentMetadata),
    NotApplicable,
    Unavailable,
}
/// All strings/facts are borrowed for one invocation, without committed authority.
pub struct SearchDocument<'a> {
    pub path: &'a str,
    pub source: SearchSource<'a>,
    pub metadata: SearchMetadataInput<'a>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchContentKind {
    Occurrence,
    Anchor,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchContentMatch {
    pub kind: SearchContentKind,
    pub range: SourceRange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchFieldMatches {
    /// Exact basename or path; ranges below are in this value, not source text.
    pub value: String,
    pub ranges: Vec<SourceRange>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchPropertyValueMatch {
    /// Search's scalar rendering. Coordinates below belong to this value.
    pub text: String,
    pub ranges: Vec<SourceRange>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchPropertyMatch {
    pub key: String,
    /// Exact key-relative proof for key-only queries; value selectors are omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_match: Option<SearchKeyMatch>,
    /// Array element locator, never source offsets or recursive object traversal.
    pub array_path: Vec<u32>,
    pub value: Option<SearchPropertyValueMatch>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchTagMatch {
    pub name: String,
    /// Present only for an actual parser-produced inline tag occurrence.
    pub source_range: Option<SourceRange>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchMatches {
    /// Strict-overlap occurrence proof, independent of touch-merged highlights.
    pub occurrence_count: u32,
    #[serde(skip)]
    locations: Vec<proof::LocationProof>,
    pub content: Vec<SearchContentMatch>,
    pub filename: Option<SearchFieldMatches>,
    pub filepath: Option<SearchFieldMatches>,
    pub properties: Vec<SearchPropertyMatch>,
    pub tags: Vec<SearchTagMatch>,
}
impl SearchMatches {
    /// Number of sealed locations; strings are materialized only on request.
    pub fn locations_len(&self) -> usize {
        self.locations.len()
    }
    /// Stable per-file ordinal. A cloned wire locator conveys no source authority.
    pub fn location(&self, index: usize) -> Option<SearchLocation> {
        self.locations
            .get(index)
            .and_then(|p| p.location(index as u32, self))
    }
    /// Owned retained allocation, including spare capacities and private proofs.
    pub fn retained_bytes(&self) -> usize {
        use std::mem::size_of;
        let field = |f: &Option<SearchFieldMatches>| {
            f.as_ref().map_or(0, |f| {
                f.value.capacity() + f.ranges.capacity() * size_of::<SourceRange>()
            })
        };
        size_of::<Self>()
            + self.content.capacity() * size_of::<SearchContentMatch>()
            + field(&self.filename)
            + field(&self.filepath)
            + self.properties.capacity() * size_of::<SearchPropertyMatch>()
            + self
                .properties
                .iter()
                .map(|p| {
                    p.key.capacity()
                        + p.array_path.capacity() * size_of::<u32>()
                        + match &p.key_match {
                            Some(SearchKeyMatch::Ranges { ranges }) => {
                                ranges.capacity() * size_of::<SourceRange>()
                            }
                            _ => 0,
                        }
                        + p.value.as_ref().map_or(0, |v| {
                            v.text.capacity() + v.ranges.capacity() * size_of::<SourceRange>()
                        })
                })
                .sum::<usize>()
            + self.tags.capacity() * size_of::<SearchTagMatch>()
            + self.tags.iter().map(|t| t.name.capacity()).sum::<usize>()
            + self.locations.capacity() * size_of::<proof::LocationProof>()
            + self
                .locations
                .iter()
                .map(proof::LocationProof::heap_bytes)
                .sum::<usize>()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchEvaluation {
    /// A file may match with no locations (for example exclusion-only queries).
    Match(SearchMatches),
    NoMatch,
    Unavailable(SearchRequirements),
}
#[derive(Debug)]
pub enum SearchError<E> {
    Host(E),
    Resource(&'static str),
    InvalidDocument(&'static str),
}

pub struct CompiledSearchQuery {
    query: String,
    options: SearchOptions,
    limits: SearchLimits,
    ast: Option<parser::Node>,
    requirements: SearchRequirements,
    explanation: Option<ExplanationNode>,
    regex_component_bytes: usize,
    word: &'static regex::Regex,
}
impl CompiledSearchQuery {
    pub fn compile(
        query: &str,
        options: SearchOptions,
        limits: SearchLimits,
    ) -> Result<Self, SearchDiagnostic> {
        let (ast, explanation, regex_component_bytes) =
            parser::compile(query, &limits, options.case_sensitive)?;
        let requirements = ast
            .as_ref()
            .map_or(SearchRequirements::default(), parser::requirements);
        static WORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let word = WORD.get_or_init(|| {
            regex::Regex::new(r"^[\p{L}\p{Nd}]$").expect("fixed bounded word pattern")
        });
        Ok(Self {
            query: query.into(),
            options,
            limits,
            ast,
            requirements,
            explanation,
            regex_component_bytes,
            word,
        })
    }
    pub fn query(&self) -> &str {
        &self.query
    }
    pub fn options(&self) -> &SearchOptions {
        &self.options
    }
    pub fn requirements(&self) -> SearchRequirements {
        self.requirements
    }
    /// Explanation of the exact compiled AST. No query reparsing or regex
    /// compilation occurs here; ranges refer to the original query spelling.
    /// The returned clone is caller-owned, outside this query's retained bytes.
    pub fn explanation(&self) -> CoreSearchExplanation {
        CoreSearchExplanation {
            dialect: SEARCH_DIALECT.into(),
            root: self.explanation.clone(),
        }
    }
    /// Owned struct/string/AST/explanation capacities plus conservative admitted
    /// regex compiled-program and lazy-DFA reservations for both case variants.
    /// Regex does not expose actual internal heap capacities; these component
    /// reservations are not a process/allocator heap bound. The shared static
    /// Unicode word classifier is process-owned and excluded from query state.
    pub fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(self.query.capacity())
            .saturating_add(
                self.ast
                    .as_ref()
                    .map_or(0, |n| parser::retained_bytes(n, self.regex_component_bytes)),
            )
            .saturating_add(
                self.explanation
                    .as_ref()
                    .map_or(0, parser::explanation_retained_bytes),
            )
    }
    pub fn evaluate_checked<E>(
        &self,
        document: SearchDocument<'_>,
        check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<SearchEvaluation, SearchError<E>> {
        evaluate::evaluate(self, document, check)
    }
}
