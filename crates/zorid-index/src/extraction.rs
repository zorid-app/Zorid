//! Content-derived extraction only: no path, entry, revision, publication or IO.
use crate::{
    document_extraction_version, EntryWitness, Exclusion, IndexError, IndexRecord,
    MAX_GENERATION_METADATA_BYTES, MAX_PUMP_DOCUMENTS,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use zorid_core::OperationId;
use zorid_document::{
    parse_markdown_facts, ParseFacts, SourceLength, DIALECT_VERSION, MAX_SOURCE_BYTES,
    SCHEMA_VERSION,
};

/// Encoding of the identity-free cache envelope, not a semantic/output version.
pub const FACTS_ENCODING_VERSION: u32 = 1;
pub const MAX_PARSE_CACHE_ROW_BYTES: usize = 1024 * 1024;
pub const MAX_PARSE_CACHE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PARSE_CACHE_ROWS: usize = 100_000;
/// Optional admission is abandoned if another eviction would exceed this work.
pub const MAX_PARSE_CACHE_EVICTIONS_PER_WRITE: usize = MAX_PUMP_DOCUMENTS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtractionDomain {
    DocumentIndex,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractionScope {
    domain: ExtractionDomain,
    local_store_id: OperationId,
}
impl ExtractionScope {
    pub fn new(domain: ExtractionDomain, local_store_id: OperationId) -> Self {
        Self {
            domain,
            local_store_id,
        }
    }
    pub fn local_store_id(&self) -> &OperationId {
        &self.local_store_id
    }
    pub fn domain(&self) -> ExtractionDomain {
        self.domain
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtractionMode {
    Markdown,
    PlainText,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentExtractionKey {
    scope: ExtractionScope,
    digest: [u8; 32],
    source_length: SourceLength,
    mode: ExtractionMode,
    document_schema_version: u32,
    dialect_version: String,
    extraction_version: String,
    facts_encoding_version: u32,
}
impl ContentExtractionKey {
    /// Only supported bounded, non-NUL UTF8 text is eligible. The caller still
    /// validates source authority; this digest never grants mutation authority.
    pub fn for_source(
        scope: ExtractionScope,
        mode: ExtractionMode,
        source: &str,
    ) -> Result<Self, IndexError> {
        if source.len() > MAX_SOURCE_BYTES || source.contains('\0') {
            return Err(IndexError::InvalidRecord);
        }
        Ok(Self {
            scope,
            digest: Sha256::digest(source.as_bytes()).into(),
            source_length: SourceLength {
                bytes: source.len() as u32,
                utf16: source.encode_utf16().count() as u32,
            },
            mode,
            document_schema_version: SCHEMA_VERSION,
            dialect_version: DIALECT_VERSION.into(),
            extraction_version: document_extraction_version(),
            facts_encoding_version: FACTS_ENCODING_VERSION,
        })
    }
    pub fn scope(&self) -> &ExtractionScope {
        &self.scope
    }
    pub fn digest(&self) -> &[u8; 32] {
        &self.digest
    }
    pub fn source_bytes(&self) -> usize {
        self.source_length.bytes as usize
    }
    pub fn source_length(&self) -> &SourceLength {
        &self.source_length
    }
    pub fn mode(&self) -> ExtractionMode {
        self.mode
    }
    /// Canonical fingerprint includes scope, mode and every current version,
    /// not just source SHA. Typed serialization order is shared on all hosts.
    pub fn storage_key(&self) -> Result<String, IndexError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| IndexError::InvalidRecord)?;
        Ok(Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }
    fn validate(&self) -> Result<(), IndexError> {
        if self.document_schema_version != SCHEMA_VERSION
            || self.dialect_version != DIALECT_VERSION
            || self.extraction_version != document_extraction_version()
            || self.facts_encoding_version != FACTS_ENCODING_VERSION
        {
            return Err(IndexError::InvalidVersion);
        }
        let n = &self.source_length;
        if n.bytes as usize > MAX_SOURCE_BYTES
            || n.utf16 > n.bytes
            || u64::from(n.bytes) > 3 * u64::from(n.utf16)
        {
            return Err(IndexError::InvalidRecord);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    content = "facts",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum ExtractionFacts {
    Markdown(ParseFacts),
    PlainText(SourceLength),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentExtractionResult {
    key: ContentExtractionKey,
    facts: ExtractionFacts,
    facts_digest: [u8; 32],
}
/// Only successful content facts are cacheable. Terminal source/parser exclusions
/// stay explicit and never become an empty successful cached projection.
#[derive(Clone, Debug, PartialEq)]
pub enum ContentExtractionOutcome {
    Extracted(ContentExtractionResult),
    Excluded(Exclusion),
}
/// Normal source admission: preserve the existing size -> NUL -> parser-exclusion
/// precedence. Hosts preflight pump budgets before calling this pure function.
pub fn extract_content(
    scope: ExtractionScope,
    mode: ExtractionMode,
    source: &str,
) -> Result<ContentExtractionOutcome, IndexError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Ok(ContentExtractionOutcome::Excluded(Exclusion::SourceLimit));
    }
    if source.contains('\0') {
        return Ok(ContentExtractionOutcome::Excluded(Exclusion::Binary));
    }
    let key = ContentExtractionKey::for_source(scope, mode, source)?;
    extract_supported(key, source)
}
fn extract_supported(
    key: ContentExtractionKey,
    source: &str,
) -> Result<ContentExtractionOutcome, IndexError> {
    let facts = match key.mode {
        ExtractionMode::Markdown => match parse_markdown_facts(source) {
            Ok(facts) => ExtractionFacts::Markdown(facts),
            Err(_) => {
                return Ok(ContentExtractionOutcome::Excluded(
                    Exclusion::ExtractionLimit,
                ))
            }
        },
        ExtractionMode::PlainText => ExtractionFacts::PlainText(key.source_length.clone()),
    };
    let facts_digest = bounded_checksum(&(&key, &facts), MAX_GENERATION_METADATA_BYTES)?;
    let result = ContentExtractionResult {
        key,
        facts,
        facts_digest,
    };
    // Constructor just computed the checksum from trusted parser facts. Bound
    // the envelope once; public bind still rechecks all untrusted inputs.
    result.encoded_size()?;
    Ok(ContentExtractionOutcome::Extracted(result))
}
impl ContentExtractionResult {
    /// Strict keyed work for already eligible text. Ordinary source admission
    /// uses extract_content so exclusions retain their existing classification.
    pub fn extract(key: ContentExtractionKey, source: &str) -> Result<Self, IndexError> {
        key.validate()?;
        let actual = ContentExtractionKey::for_source(key.scope.clone(), key.mode, source)?;
        if key != actual {
            return Err(IndexError::ContentMismatch);
        }
        match extract_supported(key, source)? {
            ContentExtractionOutcome::Extracted(result) => Ok(result),
            ContentExtractionOutcome::Excluded(_) => Err(IndexError::InvalidRecord),
        }
    }
    pub fn key(&self) -> &ContentExtractionKey {
        &self.key
    }
    /// The expected key must be computed from THIS captured source and mode.
    /// Cache/result correlation never replaces final manifest/publication CAS.
    /// Encoded input must be bounded by the host before deserializing this type.
    pub fn bind(
        self,
        expected: &ContentExtractionKey,
        witness: EntryWitness,
        current_mode: ExtractionMode,
    ) -> Result<IndexRecord, IndexError> {
        expected.validate()?;
        self.key.validate()?;
        if &self.key != expected || current_mode != expected.mode {
            return Err(IndexError::ContentMismatch);
        }
        if expected.scope.local_store_id() != witness.source().local_store_id() {
            return Err(IndexError::StaleSource);
        }
        self.check_envelope()?;
        let metadata = match self.facts {
            ExtractionFacts::Markdown(facts) if current_mode == ExtractionMode::Markdown => {
                if facts.schema_version != SCHEMA_VERSION
                    || facts.dialect_version != DIALECT_VERSION
                {
                    return Err(IndexError::InvalidVersion);
                }
                if facts.source_length != expected.source_length {
                    return Err(IndexError::InvalidRecord);
                }
                Some(facts.bind(witness.entry().id.clone(), witness.entry().revision.clone()))
            }
            ExtractionFacts::PlainText(length)
                if current_mode == ExtractionMode::PlainText
                    && length == expected.source_length =>
            {
                None
            }
            _ => return Err(IndexError::InvalidRecord),
        };
        // This is the existing strong structural/range/YAML/UTF16 validator,
        // supplied with actual current IDs rather than rewritten or dummy IDs.
        IndexRecord::from_persisted(
            witness,
            metadata,
            Some(expected.digest),
            expected.source_bytes(),
            None,
        )
    }
    pub fn encoded_size(&self) -> Result<usize, IndexError> {
        bounded_encoding(self, MAX_GENERATION_METADATA_BYTES, false).map(|(bytes, _)| bytes)
    }
    fn check_envelope(&self) -> Result<(), IndexError> {
        self.encoded_size()?;
        let actual = bounded_checksum(&(&self.key, &self.facts), MAX_GENERATION_METADATA_BYTES)?;
        if actual != self.facts_digest {
            return Err(IndexError::ContentMismatch);
        }
        Ok(())
    }
}

fn bounded_checksum(value: &impl Serialize, maximum: usize) -> Result<[u8; 32], IndexError> {
    bounded_encoding(value, maximum, true)?
        .1
        .ok_or(IndexError::InvalidRecord)
}

fn bounded_encoding(
    value: &impl Serialize,
    maximum: usize,
    checksum: bool,
) -> Result<(usize, Option<[u8; 32]>), IndexError> {
    struct Counter {
        bytes: usize,
        maximum: usize,
        exceeded: bool,
        digest: Option<Sha256>,
    }
    impl Write for Counter {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            if data.len() > self.maximum - self.bytes {
                self.exceeded = true;
                return Err(io::Error::other("extraction envelope limit"));
            }
            self.bytes += data.len();
            if let Some(digest) = &mut self.digest {
                digest.update(data);
            }
            Ok(data.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        maximum,
        exceeded: false,
        digest: checksum.then(Sha256::new),
    };
    if serde_json::to_writer(&mut counter, value).is_err() {
        return Err(if counter.exceeded {
            IndexError::GenerationLimit
        } else {
            IndexError::InvalidRecord
        });
    }
    Ok((
        counter.bytes,
        counter.digest.map(|digest| digest.finalize().into()),
    ))
}

/// Usage covers only this scoped disposable family's full encoded payloads.
/// Hosts maintain it transactionally and query indexed FIFO rows as needed;
/// authority, receipts, retained generation rows and pins are never candidates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParseCacheUsage {
    pub rows: usize,
    pub bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParseCacheAdmission {
    SkipOversized,
    SkipEvictionLimit,
    Write,
    EvictOldest,
}
/// Re-evaluate after removing ONE oldest eligible row (excluding replacement).
/// Hits and replacements retain FIFO order; new keys append at admission.
/// No whole-catalogue scan or per-platform policy is needed.
pub fn parse_cache_admission(
    usage: ParseCacheUsage,
    replaced_payload_bytes: Option<usize>,
    incoming_payload_bytes: usize,
    evicted_rows: usize,
) -> Result<ParseCacheAdmission, IndexError> {
    let valid_usage = |rows: usize, bytes: usize| {
        rows <= MAX_PARSE_CACHE_ROWS
            && bytes <= MAX_PARSE_CACHE_BYTES
            && (rows == 0) == (bytes == 0)
            && rows <= bytes
            && bytes as u64 <= (rows as u64) * MAX_PARSE_CACHE_ROW_BYTES as u64
    };
    if !valid_usage(usage.rows, usage.bytes)
        || evicted_rows > MAX_PARSE_CACHE_EVICTIONS_PER_WRITE
        || incoming_payload_bytes == 0
    {
        return Err(IndexError::InvalidRecord);
    }
    if replaced_payload_bytes.is_some_and(|n| {
        n == 0 || n > MAX_PARSE_CACHE_ROW_BYTES || n > usage.bytes || usage.rows == 0
    }) {
        return Err(IndexError::InvalidRecord);
    }
    let residual_rows = usage.rows - usize::from(replaced_payload_bytes.is_some());
    let residual_bytes = usage.bytes - replaced_payload_bytes.unwrap_or(0);
    if !valid_usage(residual_rows, residual_bytes) {
        return Err(IndexError::InvalidRecord);
    }
    if incoming_payload_bytes > MAX_PARSE_CACHE_ROW_BYTES {
        return Ok(ParseCacheAdmission::SkipOversized);
    }
    let rows = residual_rows
        .checked_add(1)
        .ok_or(IndexError::InvalidRecord)?;
    let bytes = residual_bytes
        .checked_add(incoming_payload_bytes)
        .ok_or(IndexError::InvalidRecord)?;
    Ok(
        if rows <= MAX_PARSE_CACHE_ROWS && bytes <= MAX_PARSE_CACHE_BYTES {
            ParseCacheAdmission::Write
        } else if evicted_rows == MAX_PARSE_CACHE_EVICTIONS_PER_WRITE {
            ParseCacheAdmission::SkipEvictionLimit
        } else {
            ParseCacheAdmission::EvictOldest
        },
    )
}
/// One disjoint outcome per eligible lookup; fallback parsing after corrupt,
/// unsupported or unavailable does not additionally count as Miss. Pump refusal
/// and source exclusions precede a lookup. Same-entry reuse is independent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParseCacheOutcome {
    Hit,
    Miss,
    Unavailable,
    Corrupt,
    Unsupported,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Manifest, SourceSnapshotId, SourceWatermark};
    use zorid_core::{EntryId, EntryKind, EntryState, Revision, VaultPath};
    #[test]
    fn structurally_invalid_ranges_fail_even_with_recomputed_non_authenticating_checksum() {
        let entry = EntryState {
            id: EntryId::new("a").unwrap(),
            revision: Revision::new("r").unwrap(),
            path: VaultPath::new("A.md").unwrap(),
            kind: EntryKind::File,
            deleted: false,
        };
        let source = SourceSnapshotId::new(
            OperationId::new("store").unwrap(),
            SourceWatermark::new("1").unwrap(),
        );
        let witness = Manifest::new(source, vec![entry.clone()])
            .unwrap()
            .witness(&entry.id)
            .unwrap();
        let key = ContentExtractionKey::for_source(
            ExtractionScope::new(
                ExtractionDomain::DocumentIndex,
                OperationId::new("store").unwrap(),
            ),
            ExtractionMode::Markdown,
            "# heading",
        )
        .unwrap();
        let mut result = ContentExtractionResult::extract(key.clone(), "# heading").unwrap();
        let ExtractionFacts::Markdown(facts) = &mut result.facts else {
            panic!()
        };
        facts.headings[0].range.bytes[1] = 99;
        result.facts_digest =
            bounded_checksum(&(&result.key, &result.facts), MAX_GENERATION_METADATA_BYTES).unwrap();
        assert_eq!(
            result.bind(&key, witness, ExtractionMode::Markdown),
            Err(IndexError::InvalidRecord)
        );
    }
    #[test]
    fn encoding_budget_stops_output_without_allocating_an_unbounded_buffer() {
        assert_eq!(
            bounded_encoding(&"large", 2, false),
            Err(IndexError::GenerationLimit)
        );
    }
}
