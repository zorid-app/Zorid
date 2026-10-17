use crate::{Generation, IndexError, IndexSnapshotId, MAX_PUMP_BYTES, MAX_PUMP_DOCUMENTS};
use serde::Serialize;
use std::sync::Arc;
use zorid_core::{EntryKind, EntryState};
use zorid_document::{SourceRange, MAX_SOURCE_BYTES};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteralQuery {
    value: String,
}
impl LiteralQuery {
    pub fn new(value: impl Into<String>) -> Result<Self, IndexError> {
        let value = value.into();
        if value.is_empty() || value.len() > 4096 || value.contains(['\r', '\n']) {
            return Err(IndexError::InvalidQuery);
        }
        Ok(Self { value })
    }
    pub fn as_str(&self) -> &str {
        &self.value
    }
}
/// Token pins full store/epoch/generation/version identity and the exact query.
/// Hosts reject absent/expired generations; never substitute the active one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteralToken {
    snapshot: IndexSnapshotId,
    query: LiteralQuery,
    row: usize,
    line_start: usize,
}
impl LiteralToken {
    pub fn snapshot(&self) -> &IndexSnapshotId {
        &self.snapshot
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextReadRequest {
    snapshot: IndexSnapshotId,
    entry: EntryState,
    row: usize,
    start: usize,
    digest: [u8; 32],
    bytes: usize,
}
impl TextReadRequest {
    pub fn snapshot(&self) -> &IndexSnapshotId {
        &self.snapshot
    }
    pub fn entry(&self) -> &EntryState {
        &self.entry
    }
    pub fn digest(&self) -> &[u8; 32] {
        &self.digest
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub entry: EntryState,
    pub line: u32,
    pub range: SourceRange,
    pub snippet: String,
    pub snippet_truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteralPage {
    pub snapshot: IndexSnapshotId,
    pub hits: Vec<SearchHit>,
    pub next: Option<LiteralToken>,
    pub scan_complete: bool,
    pub coverage_complete: bool,
    pub complete: bool,
    pub source_bytes: usize,
    pub documents: usize,
}
/// Bounded one-row-at-a-time evaluator. An async IDB host awaits each retained
/// generation row outside this pure engine and supplies its exact bytes. No
/// current-source read, whole-vault body collection or network dependency exists.
enum GenerationHandle<'a> {
    Borrowed(&'a Generation),
    Shared(Arc<Generation>),
}
impl std::ops::Deref for GenerationHandle<'_> {
    type Target = Generation;
    fn deref(&self) -> &Generation {
        match self {
            Self::Borrowed(generation) => generation,
            Self::Shared(generation) => generation,
        }
    }
}
pub struct LiteralPageBuilder<'a> {
    generation: GenerationHandle<'a>,
    query: LiteralQuery,
    row: usize,
    start: usize,
    initial_row: usize,
    initial_start: usize,
    hits: Vec<SearchHit>,
    limit: usize,
    source_bytes: usize,
    documents: usize,
    output_bytes: usize,
    blocked: bool,
}
impl<'a> LiteralPageBuilder<'a> {
    pub fn new(
        generation: &'a Generation,
        query: LiteralQuery,
        token: Option<&LiteralToken>,
        limit: usize,
    ) -> Result<Self, IndexError> {
        Self::from_handle(GenerationHandle::Borrowed(generation), query, token, limit)
    }
    /// Safe owned async-host state. Arc pins an immutable generation across
    /// awaited projection reads; no self-referential borrow or body replay.
    pub fn new_shared(
        generation: Arc<Generation>,
        query: LiteralQuery,
        token: Option<&LiteralToken>,
        limit: usize,
    ) -> Result<Self, IndexError> {
        Self::from_handle(GenerationHandle::Shared(generation), query, token, limit)
    }
    fn from_handle(
        generation: GenerationHandle<'a>,
        query: LiteralQuery,
        token: Option<&LiteralToken>,
        limit: usize,
    ) -> Result<Self, IndexError> {
        if !(1..=1000).contains(&limit) {
            return Err(IndexError::InvalidBudget);
        }
        if let Some(token) = token {
            if token.snapshot != *generation.id() {
                return Err(IndexError::SnapshotExpired);
            }
            if token.query != query {
                return Err(IndexError::QueryMismatch);
            }
            if token.row >= generation.manifest().entries().len() {
                return Err(IndexError::SnapshotExpired);
            }
        }
        let (row, start) = token.map_or((0, 0), |token| (token.row, token.line_start));
        Ok(Self {
            generation,
            query,
            row,
            start,
            initial_row: row,
            initial_start: start,
            hits: Vec::new(),
            limit,
            source_bytes: 0,
            documents: 0,
            // Each of 4096 UTF8 query bytes can expand to six JSON bytes.
            // Remaining fixed identity/version/token fields have bounded ASCII
            // tags; reserve another8KiB for them and the page envelope.
            output_bytes: 8192 + 6 * 4096,
            blocked: false,
        })
    }
    pub fn next_read(&mut self) -> Option<TextReadRequest> {
        if self.blocked || self.hits.len() == self.limit {
            return None;
        }
        let entries = self.generation.manifest().entries();
        while self.row < entries.len() {
            if self.documents == MAX_PUMP_DOCUMENTS {
                return None;
            }
            let entry = &entries[self.row];
            let record = self.generation.record(&entry.id);
            let Some(record) = record.filter(|_| entry.kind == EntryKind::File) else {
                self.row += 1;
                self.start = 0;
                self.documents += 1;
                continue;
            };
            let Some(digest) = record.text_digest() else {
                self.row += 1;
                self.start = 0;
                self.documents += 1;
                continue;
            };
            // 1MiB is a soft batch budget: permit one exact bounded row up to
            // the existing document limit when this page otherwise has no work.
            if self.documents > 0 && self.source_bytes + record.text_bytes() > MAX_PUMP_BYTES {
                return None;
            }
            return Some(TextReadRequest {
                snapshot: self.generation.id().clone(),
                entry: entry.clone(),
                row: self.row,
                start: self.start,
                digest: *digest,
                bytes: record.text_bytes(),
            });
        }
        None
    }
    pub fn accept(&mut self, request: &TextReadRequest, bytes: &[u8]) -> Result<(), IndexError> {
        if self.next_read().as_ref() != Some(request) {
            return Err(IndexError::StaleSource);
        }
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err(IndexError::ContentMismatch);
        }
        let record = self
            .generation
            .record(&request.entry.id)
            .ok_or(IndexError::InvalidRecord)?;
        record.check_text(bytes)?;
        let text = std::str::from_utf8(bytes).map_err(|_| IndexError::ContentMismatch)?;
        if text.contains('\0') {
            return Err(IndexError::ContentMismatch);
        }
        if self.start > text.len()
            || !text.is_char_boundary(self.start)
            || (self.start > 0 && text.as_bytes()[self.start - 1] != b'\n')
        {
            return Err(IndexError::InvalidRecord);
        }
        self.documents += 1;
        self.source_bytes += bytes.len();
        let mut line = text[..self.start].bytes().filter(|b| *b == b'\n').count() as u32;
        let mut utf16 = text[..self.start].encode_utf16().count();
        while self.start < text.len() {
            let beginning = self.start;
            let after = text[beginning..]
                .find('\n')
                .map_or(text.len(), |n| beginning + n + 1);
            let raw = &text[beginning..after];
            let content = raw.strip_suffix('\n').unwrap_or(raw);
            let content = if raw.ends_with('\n') {
                content.strip_suffix('\r').unwrap_or(content)
            } else {
                content
            };
            if let Some(offset) = content.find(self.query.as_str()) {
                let prefix = content[..offset].encode_utf16().count();
                let before = content[..offset]
                    .char_indices()
                    .rev()
                    .nth(80)
                    .map_or(0, |(n, _)| n);
                let snippet: String = content[before..].chars().take(512).collect();
                // Account for escaping, opaque IDs/revisions and fixed hit keys;
                // reserve page/token identity overhead before adding any hits.
                let json_size = |value: &str| {
                    serde_json::to_string(value)
                        .map(|value| value.len())
                        .map_err(|_| IndexError::InvalidRecord)
                };
                let cost = json_size(&snippet)?
                    + json_size(request.entry.path.as_str())?
                    + json_size(request.entry.id.as_str())?
                    + json_size(request.entry.revision.as_str())?
                    + 256;
                if self.output_bytes + cost > MAX_PUMP_BYTES {
                    if self.hits.is_empty() {
                        return Err(IndexError::GenerationLimit);
                    }
                    self.blocked = true;
                    break;
                }
                self.hits.push(SearchHit {
                    entry: request.entry.clone(),
                    line,
                    range: SourceRange {
                        bytes: [
                            (beginning + offset) as u32,
                            (beginning + offset + self.query.value.len()) as u32,
                        ],
                        utf16: [
                            (utf16 + prefix) as u32,
                            (utf16 + prefix + self.query.value.encode_utf16().count()) as u32,
                        ],
                    },
                    snippet_truncated: before > 0 || snippet.len() < content.len(),
                    snippet,
                });
                self.output_bytes += cost;
            }
            self.start = after;
            utf16 += raw.encode_utf16().count();
            line += 1;
            if self.hits.len() == self.limit {
                break;
            }
        }
        if self.start == text.len() {
            self.row += 1;
            self.start = 0;
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<LiteralPage, IndexError> {
        // Skip metadata-only rows if budget allows; never invent a body read.
        let _ = self.next_read();
        let scan_complete = self.row == self.generation.manifest().entries().len();
        if !scan_complete
            && self.hits.is_empty()
            && self.row == self.initial_row
            && self.start == self.initial_start
        {
            return Err(IndexError::NoProgress);
        }
        let coverage_complete = self.generation.coverage_complete();
        let next = (!scan_complete).then(|| LiteralToken {
            snapshot: self.generation.id().clone(),
            query: self.query,
            row: self.row,
            line_start: self.start,
        });
        Ok(LiteralPage {
            snapshot: self.generation.id().clone(),
            hits: self.hits,
            next,
            scan_complete,
            coverage_complete,
            complete: scan_complete && coverage_complete,
            source_bytes: self.source_bytes,
            documents: self.documents,
        })
    }
}
