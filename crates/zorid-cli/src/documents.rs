//! Standalone host for the shared native semantic facade. Tokens remain inside
//! one invocation and one process-local pin. JSON snapshot IDs are expectations,
//! not deserialized query capabilities. Index mutation is always explicit and
//! only changes disposable derived state; queries never build, rescan or sync.
use super::{Failure, Result};
use clap::{Args, Subcommand};
use serde::Serialize;
use std::{
    io::{self, Write},
    time::{SystemTime, UNIX_EPOCH},
};
use zorid_core::{EntryId, OperationId};
use zorid_native::{
    DocumentIndexError, DocumentIndexProgress, DocumentIndexStage, DocumentIndexStatus,
    DocumentQueryPin, IndexSnapshotId, LiteralQuery, NativeDocumentError, NativeVault,
    QueryOptions, SourceSnapshotId,
};

const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const IDENTITY_RESERVE: usize = 16 * 1024;
const MAX_SNAPSHOT_INPUT: usize = 16 * 1024;

#[derive(Subcommand)]
pub enum IndexCommand {
    /// Report published snapshot, source lag and extraction coverage.
    Status,
    /// Resume eligible staging or capture current committed authority; no disk scan.
    Build {
        #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u32).range(1..=100_000))]
        max_pumps: u32,
    },
    /// Explicitly discard only derived data, then build with a fresh epoch.
    Rebuild {
        #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u32).range(1..=100_000))]
        max_pumps: u32,
    },
}
#[derive(Args)]
pub struct PageOptions {
    /// Maximum returned matches; incomplete scans are explicitly truncated.
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=1000))]
    limit: u32,
    /// Internal pages on one pin. Tokens are not reusable CLI arguments.
    #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u32).range(1..=1000))]
    max_pages: u32,
    /// Full snapshot JSON from earlier output; reject a different active snapshot.
    #[arg(long, value_name = "JSON")]
    expected_snapshot: Option<String>,
}
#[derive(Args)]
pub struct BaseOptions {
    /// Exact shared Base view name. Omitted selects its default view.
    #[arg(long)]
    view: Option<String>,
    /// Full snapshot JSON from earlier output; reject a different active snapshot.
    #[arg(long, value_name = "JSON")]
    expected_snapshot: Option<String>,
    /// One invocation clock in Unix milliseconds; default captures the current instant.
    #[arg(long, allow_hyphen_values = true)]
    clock_ms: Option<i64>,
    #[arg(long, default_value = "UTC")]
    timezone: String,
    /// Shared query resource ceiling, not a replacement for the Base view limit.
    #[arg(long, default_value_t = 10_000, value_parser = clap::value_parser!(u32).range(1..=10_000))]
    max_rows: u32,
}
#[derive(Serialize)]
struct Envelope<T> {
    version: u32,
    ok: bool,
    result: T,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusOutput {
    operation: &'static str,
    local_store_id: OperationId,
    status: DocumentIndexStatus,
    synced: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildOutput {
    operation: &'static str,
    local_store_id: OperationId,
    snapshot: IndexSnapshotId,
    progress: DocumentIndexProgress,
    pumps: u32,
    resumed: bool,
    published: bool,
    build_complete: bool,
    coverage_complete: Option<bool>,
    complete: bool,
    observed_index: DocumentIndexStatus,
    synced: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryOutput<T> {
    operation: &'static str,
    consistency: &'static str,
    snapshot: IndexSnapshotId,
    source: SourceSnapshotId,
    observed_index: DocumentIndexStatus,
    coverage_complete: bool,
    scan_complete: bool,
    complete: bool,
    truncated: bool,
    value: T,
    synced: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchValue<T> {
    hits: Vec<T>,
    pages: u32,
    documents: usize,
    source_bytes: usize,
    has_next: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BacklinkValue<T> {
    target: EntryId,
    edges: Vec<T>,
    pages: u32,
    has_next: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BaseOutput<T> {
    #[serde(flatten)]
    query: QueryOutput<T>,
    clock_ms: i64,
    timezone: String,
    selected_view: Option<String>,
}

pub fn index(vault: &mut NativeVault, command: IndexCommand) -> Result<Vec<u8>> {
    if matches!(&command, IndexCommand::Status) {
        return encode(StatusOutput {
            operation: "document_index_status",
            local_store_id: vault.identity()?.local_store_id,
            status: vault.document_index_status().map_err(failure)?,
            synced: false,
        });
    }
    let (rebuild, max_pumps) = match command {
        IndexCommand::Build { max_pumps } => (false, max_pumps),
        IndexCommand::Rebuild { max_pumps } => (true, max_pumps),
        IndexCommand::Status => unreachable!(),
    };
    if rebuild {
        vault.rebuild_document_index().map_err(failure)?;
    } else {
        vault.initialize_document_index().map_err(failure)?;
    }
    let (stage, resumed) = stage(vault)?;
    let mut pumps = 1;
    let mut progress = vault.pump_document_index(&stage).map_err(failure)?;
    while !progress.ready && pumps < max_pumps {
        progress = vault.pump_document_index(&stage).map_err(failure)?;
        pumps += 1;
    }
    let published = progress.ready;
    if published {
        vault.publish_document_index(&stage).map_err(failure)?;
    }
    let observed_index = vault.document_index_status().map_err(failure)?;
    // Another indexer may publish after us. Never use its coverage to label our
    // stage complete: unknown is explicit while the successful publication stays true.
    let coverage_complete = match &observed_index {
        DocumentIndexStatus::Ready {
            snapshot,
            coverage_complete,
            ..
        } if published && snapshot == stage.snapshot() => Some(*coverage_complete),
        _ => None,
    };
    encode(BuildOutput {
        operation: if rebuild {
            "document_index_rebuild"
        } else {
            "document_index_build"
        },
        local_store_id: vault.identity()?.local_store_id,
        snapshot: stage.snapshot().clone(),
        progress,
        pumps,
        resumed,
        published,
        build_complete: published,
        coverage_complete,
        complete: published && coverage_complete == Some(true),
        observed_index,
        synced: false,
    })
}
fn stage(vault: &mut NativeVault) -> Result<(DocumentIndexStage, bool)> {
    for candidate in vault.document_index_stages().map_err(failure)? {
        match vault.resume_document_index(candidate.snapshot()) {
            Ok(stage) => return Ok((stage, true)),
            Err(error)
                if matches!(
                    error.code(),
                    "stale_source" | "stale_index" | "snapshot_expired"
                ) => {}
            Err(error) => return Err(failure(error)),
        }
    }
    Ok((vault.begin_document_index().map_err(failure)?, false))
}
pub(super) fn open(vault: &NativeVault, expected: Option<&str>) -> Result<DocumentQueryPin> {
    let expected = expected
        .map(|value| {
            if value.len() > MAX_SNAPSHOT_INPUT {
                return Err(Failure::new(
                    "invalid_snapshot",
                    "Snapshot JSON exceeds the input bound",
                    2,
                ));
            }
            serde_json::from_str::<IndexSnapshotId>(value).map_err(|_| {
                Failure::new(
                    "invalid_snapshot",
                    "Snapshot JSON is not a valid shared identity",
                    2,
                )
            })
        })
        .transpose()?;
    match vault.document_index_status().map_err(failure)? {
        DocumentIndexStatus::Uninitialized | DocumentIndexStatus::Building => {
            return Err(Failure::new(
                "index_not_ready",
                "Build the document index explicitly before querying",
                4,
            ));
        }
        DocumentIndexStatus::RebuildRequired => {
            return Err(Failure::new(
                "index_rebuild_required",
                "Derived index data requires explicit document-index rebuild",
                5,
            ));
        }
        DocumentIndexStatus::Ready { .. } => {}
    }
    let pin = vault.open_document_snapshot().map_err(failure)?;
    if expected
        .as_ref()
        .is_some_and(|expected| expected != pin.generation().id())
    {
        return Err(Failure::new(
            "snapshot_expired",
            "The active document snapshot differs from the expected identity",
            3,
        ));
    }
    Ok(pin)
}

pub fn search(vault: &NativeVault, query: String, options: PageOptions) -> Result<Vec<u8>> {
    let pin = open(vault, options.expected_snapshot.as_deref())?;
    let query = LiteralQuery::new(query).map_err(|_| {
        Failure::new(
            "invalid_query",
            "Expected a bounded single-line literal query",
            2,
        )
    })?;
    let mut hits = Vec::new();
    let mut token = None;
    let (mut pages, mut documents, mut source_bytes, mut output_bytes) =
        (0, 0, 0, IDENTITY_RESERVE);
    let (mut scan_complete, mut coverage_complete) = (false, pin.generation().coverage_complete());
    while pages < options.max_pages && hits.len() < options.limit as usize {
        let result = vault
            .search_documents(
                &pin,
                query.clone(),
                token.as_ref(),
                options.limit as usize - hits.len(),
            )
            .map_err(failure)?;
        pages += 1;
        let page = result.value;
        documents += page.documents;
        source_bytes += page.source_bytes;
        let cost = encoded_size(&page.hits)?;
        if output_bytes.saturating_add(cost) >= MAX_OUTPUT_BYTES {
            if hits.is_empty() {
                return Err(output_limit());
            }
            break;
        }
        output_bytes += cost;
        coverage_complete = result.coverage_complete && page.coverage_complete;
        scan_complete = page.scan_complete;
        hits.extend(page.hits);
        token = page.next;
        if scan_complete {
            break;
        }
    }
    let value = SearchValue {
        hits,
        pages,
        documents,
        source_bytes,
        has_next: !scan_complete,
    };
    report(
        vault,
        &pin,
        "indexed_search",
        scan_complete,
        coverage_complete,
        value,
    )
}
pub fn backlinks(vault: &NativeVault, id: EntryId, options: PageOptions) -> Result<Vec<u8>> {
    let pin = open(vault, options.expected_snapshot.as_deref())?;
    let mut edges = Vec::new();
    let mut token = None;
    let (mut pages, mut output_bytes) = (0, IDENTITY_RESERVE);
    let (mut scan_complete, mut coverage_complete) = (false, pin.generation().coverage_complete());
    while pages < options.max_pages && edges.len() < options.limit as usize {
        let result = vault
            .document_backlinks(
                &pin,
                &id,
                token.as_ref(),
                options.limit as usize - edges.len(),
            )
            .map_err(failure)?;
        pages += 1;
        let page = result.value;
        let cost = encoded_size(&page.edges)?;
        if output_bytes.saturating_add(cost) >= MAX_OUTPUT_BYTES {
            if edges.is_empty() {
                return Err(output_limit());
            }
            break;
        }
        output_bytes += cost;
        coverage_complete = result.coverage_complete && page.coverage_complete;
        scan_complete = page.scan_complete;
        edges.extend(page.edges);
        token = page.next;
        if scan_complete {
            break;
        }
    }
    let value = BacklinkValue {
        target: id,
        edges,
        pages,
        has_next: !scan_complete,
    };
    report(
        vault,
        &pin,
        "backlinks",
        scan_complete,
        coverage_complete,
        value,
    )
}
fn report<T: Serialize>(
    vault: &NativeVault,
    pin: &DocumentQueryPin,
    operation: &'static str,
    scan_complete: bool,
    coverage_complete: bool,
    value: T,
) -> Result<Vec<u8>> {
    encode(QueryOutput {
        operation,
        consistency: "indexed_committed_snapshot",
        snapshot: pin.generation().id().clone(),
        source: pin.generation().manifest().source().clone(),
        observed_index: vault.document_index_status().map_err(failure)?,
        coverage_complete,
        scan_complete,
        complete: scan_complete && coverage_complete,
        truncated: !scan_complete,
        value,
        synced: false,
    })
}
pub fn base(vault: &NativeVault, id: EntryId, options: BaseOptions) -> Result<Vec<u8>> {
    let pin = open(vault, options.expected_snapshot.as_deref())?;
    let clock_ms = match options.clock_ms {
        Some(value) => value,
        None => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|value| i64::try_from(value.as_millis()).ok())
            .ok_or_else(|| {
                Failure::new(
                    "invalid_clock",
                    "Could not capture a supported invocation clock",
                    2,
                )
            })?,
    };
    let mut query_options = QueryOptions::default();
    query_options.evaluation.clock_ms = clock_ms;
    query_options.evaluation.timezone = options.timezone.clone();
    query_options.max_rows = options.max_rows as usize;
    query_options.max_output_bytes = MAX_OUTPUT_BYTES - IDENTITY_RESERVE;
    let result = if let Some(view) = &options.view {
        if view.len() > 4096 {
            return Err(Failure::new(
                "invalid_view",
                "Base view name exceeds the input bound",
                2,
            ));
        }
        vault.query_base_document_view(&pin, &id, view, &query_options)
    } else {
        vault.query_base_document(&pin, &id, &query_options)
    }
    .map_err(failure)?;
    let coverage_complete = result.coverage_complete;
    encode(BaseOutput {
        query: QueryOutput {
            operation: "base_query",
            consistency: "indexed_committed_snapshot",
            snapshot: result.snapshot,
            source: result.source,
            observed_index: vault.document_index_status().map_err(failure)?,
            coverage_complete,
            scan_complete: true,
            complete: coverage_complete,
            truncated: false,
            value: result.value,
            synced: false,
        },
        clock_ms,
        timezone: options.timezone,
        selected_view: options.view,
    })
}
pub(super) fn failure(error: NativeDocumentError) -> Failure {
    match error {
        NativeDocumentError::Native(error) => error.into(),
        NativeDocumentError::Index(DocumentIndexError::Authority(error)) => {
            zorid_native::Error::Store(error).into()
        }
        NativeDocumentError::BaseEvaluation(error) => {
            let (code, exit) = match error.code.as_str() {
                "budget" => ("query_budget", 2),
                "cancelled" => ("query_cancelled", 3),
                "view_not_found" => ("base_view_not_found", 4),
                _ => ("base_evaluation", 2),
            };
            let mut failure =
                Failure::new(code, "Shared Base evaluation rejected this query", exit);
            failure.detail = Some(serde_json::json!({"diagnostic_code":error.code}));
            failure
        }
        error => {
            let (code, exit, message) = match error.code() {
                "rebuild_required" => (
                    "index_rebuild_required",
                    5,
                    "Derived index data requires explicit document-index rebuild",
                ),
                "index_not_ready" => (
                    "index_not_ready",
                    4,
                    "Build the document index explicitly before querying",
                ),
                "snapshot_expired" => (
                    "snapshot_expired",
                    3,
                    "Document snapshot is no longer retained or belongs to another query owner",
                ),
                "stale_source" => (
                    "stale_source",
                    3,
                    "Committed source advanced; retry the explicit index build",
                ),
                "stale_index" => (
                    "stale_index",
                    3,
                    "Derived index advanced; retry the explicit index build",
                ),
                "missing_source" => (
                    "not_found",
                    4,
                    "Entry is absent from this document snapshot",
                ),
                "invalid_query" => ("invalid_query", 2, "Shared query rejected its input"),
                "query_mismatch" => (
                    "query_mismatch",
                    2,
                    "Continuation does not match this query",
                ),
                "invalid_budget" => (
                    "invalid_budget",
                    2,
                    "Shared query rejected its resource budget",
                ),
                "generation_limit" => (
                    "generation_limit",
                    2,
                    "Derived facts or relationship graph exceed the shared resource ceiling",
                ),
                "pump_limit" => ("pump_limit", 2, "Index preparation exceeded a bounded pump"),
                "no_progress" => (
                    "no_progress",
                    3,
                    "Document operation could not make bounded progress",
                ),
                "base_compile" => (
                    "base_compile",
                    2,
                    "Committed Base definition is invalid; raw source is unchanged",
                ),
                "source_unavailable" => (
                    "source_unavailable",
                    2,
                    "No eligible retained text projection exists for this entry",
                ),
                _ => (
                    "index_contract_error",
                    2,
                    "Shared document engine rejected the operation",
                ),
            };
            Failure::new(code, message, exit)
        }
    }
}
fn encoded_size<T: Serialize>(value: &T) -> Result<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| {
            Failure::new(
                "semantic_encoding",
                "Could not encode shared semantic result",
                1,
            )
        })
}
struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}
impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .is_none_or(|length| length >= MAX_OUTPUT_BYTES)
        {
            self.exceeded = true;
            return Err(io::Error::other("semantic output bound"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode<T: Serialize>(result: T) -> Result<Vec<u8>> {
    let mut output = BoundedOutput {
        bytes: Vec::new(),
        exceeded: false,
    };
    let encoded = serde_json::to_writer(
        &mut output,
        &Envelope {
            version: 1,
            ok: true,
            result,
        },
    );
    if output.exceeded {
        return Err(output_limit());
    }
    encoded.map_err(|_| {
        Failure::new(
            "semantic_encoding",
            "Could not encode shared semantic result",
            1,
        )
    })?;
    output.bytes.push(b'\n');
    Ok(output.bytes)
}

fn output_limit() -> Failure {
    Failure::new(
        "semantic_output_limit",
        "Semantic result exceeds the bounded CLI output size",
        2,
    )
}
