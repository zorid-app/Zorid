//! Pure shared-core baseline. No Store, native import, renderer or persistence.
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::MetadataRequest;
use zorid_index::*;

const MAX_MANIFEST: u64 = 64 * 1024 * 1024;
const MAX_SOURCES: u64 = 512 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputManifest {
    schema_version: u32,
    generator: String,
    note_count: usize,
    entries: Vec<InputEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputEntry {
    path: String,
    logical_id: String,
    kind: String,
    bytes: u64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputQueries {
    schema_version: u32,
    semantics: String,
    queries: Vec<InputQuery>,
}
#[derive(Deserialize)]
struct InputQuery {
    id: String,
    query: String,
}
struct Loaded {
    entry: EntryState,
    request: Option<MetadataRequest>,
}
#[derive(Debug)]
struct Failure {
    phase: &'static str,
    detail: String,
}
type Result<T> = std::result::Result<T, Failure>;
fn failure(phase: &'static str, detail: impl ToString) -> Failure {
    Failure {
        phase,
        detail: detail.to_string(),
    }
}
fn millis(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn emit(value: serde_json::Value) -> Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &value).map_err(|e| failure("output", e))?;
    out.write_all(b"\n").map_err(|e| failure("output", e))?;
    out.flush().map_err(|e| failure("output", e))
}
fn read_bounded(path: &Path, limit: u64, phase: &'static str) -> Result<Vec<u8>> {
    let meta = fs::metadata(path).map_err(|e| failure(phase, e))?;
    if !meta.is_file() || meta.len() > limit {
        return Err(failure(phase, "input file exceeds declared bound"));
    }
    // The wrapper owns immutable fixture input. Still bound allocations if a
    // standalone caller changes it between metadata and read.
    use std::io::Read;
    let file = fs::File::open(path).map_err(|e| failure(phase, e))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| failure(phase, e))?;
    if bytes.len() as u64 > limit {
        return Err(failure(phase, "input grew beyond bound"));
    }
    Ok(bytes)
}
fn run(fixture: PathBuf, samples: usize) -> Result<()> {
    let setup_start = Instant::now();
    let manifest_bytes = read_bounded(&fixture.join("manifest.json"), MAX_MANIFEST, "setup")?;
    let fixture_hash = digest(&manifest_bytes);
    let manifest: InputManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|e| failure("setup", e))?;
    let query_bytes = read_bounded(&fixture.join("queries.json"), 65536, "setup")?;
    let queries: InputQueries =
        serde_json::from_slice(&query_bytes).map_err(|e| failure("setup", e))?;
    if manifest.schema_version != 1
        || manifest.generator != "zorid-s1-workload-v1"
        || !(1..=100000).contains(&manifest.note_count)
        || manifest.entries.len() != manifest.note_count + 3
        || queries.schema_version != 1
        || queries.semantics != LITERAL_QUERY_VERSION
        || queries.queries.len() != 8
    {
        return Err(failure(
            "setup",
            "unsupported deterministic fixture envelope",
        ));
    }
    let vault = fs::canonicalize(fixture.join("vault")).map_err(|e| failure("setup", e))?;
    let mut loaded = Vec::new();
    let mut input_bytes = 0u64;
    let mut text_bytes = 0u64;
    let mut read_ms = 0.0;
    let mut hash_ms = 0.0;
    let mut decode_ms = 0.0;
    for input in &manifest.entries {
        let safe = VaultPath::new(&input.path).map_err(|e| failure("setup", e))?;
        let path = fs::canonicalize(vault.join(safe.as_str())).map_err(|e| failure("setup", e))?;
        if !path.starts_with(&vault) || input.bytes > zorid_document::MAX_SOURCE_BYTES as u64 {
            return Err(failure(
                "setup",
                "source escapes fixture or exceeds single-source bound",
            ));
        }
        input_bytes = input_bytes
            .checked_add(input.bytes)
            .filter(|n| *n <= MAX_SOURCES)
            .ok_or_else(|| failure("setup", "aggregate source bound"))?;
        let started = Instant::now();
        let bytes = read_bounded(&path, input.bytes, "setup")?;
        read_ms += millis(started);
        let started = Instant::now();
        let actual = digest(&bytes);
        hash_ms += millis(started);
        if bytes.len() as u64 != input.bytes || actual != input.sha256 {
            return Err(failure(
                "setup",
                "source length/digest differs from frozen manifest",
            ));
        }
        let entry = EntryState {
            id: EntryId::new(&input.logical_id).map_err(|e| failure("setup", e))?,
            revision: Revision::new(format!("source-{}", input.sha256))
                .map_err(|e| failure("setup", e))?,
            path: safe,
            kind: EntryKind::File,
            deleted: false,
        };
        let started = Instant::now();
        let request = match input.kind.as_str() {
            "text" => {
                text_bytes += bytes.len() as u64;
                Some(MetadataRequest {
                    entry_id: entry.id.clone(),
                    content_revision: entry.revision.clone(),
                    source: String::from_utf8(bytes).map_err(|e| failure("setup", e))?,
                })
            }
            "binary" => None,
            _ => return Err(failure("setup", "unknown source kind")),
        };
        decode_ms += millis(started);
        loaded.push(Loaded { entry, request });
    }
    let setup_ms = millis(setup_start);
    emit(
        json!({"type":"setup","fixtureHash":fixture_hash,"noteCount":manifest.note_count,"entries":loaded.len(),"inputBytes":input_bytes,"textBytes":text_bytes,
        "setupMs":setup_ms,"sourceReadMs":read_ms,"sourceHashMs":hash_ms,"utf8DecodeMs":decode_ms,"debugAssertions":cfg!(debug_assertions),
        "scope":"pure Rust shared document/index/literal query; preloaded fixture sources; no persistence/import/renderer"}),
    )?;

    let started = Instant::now();
    let local = OperationId::new("s1-core-store").map_err(|e| failure("generation", e))?;
    let source = SourceSnapshotId::new(
        local.clone(),
        SourceWatermark::new("1").map_err(|e| failure("generation", e))?,
    );
    let snapshot = IndexSnapshotId::new(
        local,
        OperationId::new("s1-core-epoch").map_err(|e| failure("generation", e))?,
        1,
        SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .map_err(|e| failure("generation", e))?,
    )
    .map_err(|e| failure("generation", e))?;
    let inventory = Manifest::new(
        source.clone(),
        loaded.iter().map(|i| i.entry.clone()).collect(),
    )
    .map_err(|e| failure("generation", e))?;
    let mut builder = GenerationBuilder::new(
        inventory,
        PublicationFence::new(source.clone(), None, snapshot.clone())
            .map_err(|e| failure("generation", e))?,
    )
    .map_err(|e| failure("generation", e))?;
    let manifest_ms = millis(started);
    let mut binding_ms = 0.0;
    let mut extraction_ms = 0.0;
    let mut insertion_ms = 0.0;
    let mut parse_invocations = 0usize;
    let mut parse_input_bytes = 0usize;
    let mut pump_resets = 0usize;
    for input in &loaded {
        let started = Instant::now();
        let witness = builder
            .manifest()
            .witness(&input.entry.id)
            .map_err(|e| failure("binding", e))?;
        binding_ms += millis(started);
        let started = Instant::now();
        let record = if let Some(request) = &input.request {
            let markdown = input.entry.path.as_str().ends_with(".md");
            parse_invocations += usize::from(markdown);
            if markdown {
                parse_input_bytes += request.source.len();
            }
            IndexRecord::text(witness, request, markdown).map_err(|e| failure("extraction", e))?
        } else {
            IndexRecord::excluded(witness, Exclusion::Binary)
        };
        extraction_ms += millis(started);
        // add consumes its input even on PumpLimit. Preserve one bounded row for
        // retry and count its clone as insertion overhead, never parse it twice.
        let started = Instant::now();
        match builder.add(record.clone()) {
            Ok(()) => {}
            Err(IndexError::PumpLimit) => {
                builder.begin_pump();
                pump_resets += 1;
                builder.add(record).map_err(|e| failure("generation", e))?;
            }
            Err(error) => return Err(failure("generation", error)),
        }
        insertion_ms += millis(started);
    }
    let metadata_bytes = builder.metadata_bytes();
    let started = Instant::now();
    let generation = builder
        .finish()
        .map_err(|e| failure("generation", e))?
        .into_parts()
        .1;
    let finish_ms = millis(started);
    let exclusions: Vec<_> = generation
        .records()
        .filter_map(|r| {
            r.exclusion()
                .map(|reason| json!({"entry":r.witness().entry(),"reason":reason}))
        })
        .collect();
    emit(
        json!({"type":"generation","snapshot":snapshot,"source":source,"entries":generation.manifest().entries().len(),"records":generation.records().count(),
        "coverageComplete":generation.coverage_complete(),"metadataBytes":metadata_bytes,"manifestMs":manifest_ms,"bindingMs":binding_ms,"extractionMs":extraction_ms,
        "insertionMs":insertion_ms,"finishMs":finish_ms,"parseInvocations":parse_invocations,"parseInputBytes":parse_input_bytes,"pumpResets":pump_resets,"exclusions":exclusions,
        "extractionScope":"IndexRecord::text includes Markdown parsing, metadata projection/validation, UTF-16 accounting, metadata serialization and source digest; not parser-only CPU time"}),
    )?;

    let texts: HashMap<_, _> = loaded
        .iter()
        .filter_map(|i| {
            i.request
                .as_ref()
                .map(|r| (i.entry.id.clone(), r.source.as_bytes()))
        })
        .collect();
    for sample in 0..samples {
        for query in &queries.queries {
            let parsed = LiteralQuery::new(&query.query).map_err(|e| failure("query", e))?;
            let mut token = None;
            let mut pages = 0usize;
            let mut hits = 0usize;
            let mut documents = 0usize;
            let mut source_bytes = 0usize;
            let mut query_ms = 0.0;
            let mut output_ms = 0.0;
            loop {
                if pages >= 1000000 {
                    return Err(failure("query", "page count bound"));
                }
                let started = Instant::now();
                let mut builder =
                    LiteralPageBuilder::new(&generation, parsed.clone(), token.as_ref(), 100)
                        .map_err(|e| failure("query", e))?;
                while let Some(request) = builder.next_read() {
                    let text = texts
                        .get(&request.entry().id)
                        .ok_or_else(|| failure("query", "exact retained source unavailable"))?;
                    builder
                        .accept(&request, text)
                        .map_err(|e| failure("query", e))?;
                }
                let page = builder.finish().map_err(|e| failure("query", e))?;
                query_ms += millis(started);
                pages += 1;
                hits += page.hits.len();
                documents += page.documents;
                source_bytes += page.source_bytes;
                let final_page = page.scan_complete;
                token = page.next.clone();
                let started = Instant::now();
                emit(
                    json!({"type":"page","queryId":query.id,"sample":sample,"page":pages,"snapshot":page.snapshot,"source":source,"coverageComplete":page.coverage_complete,
                    "scanComplete":page.scan_complete,"complete":page.complete,"hasNext":token.is_some(),"documents":page.documents,"sourceBytes":page.source_bytes,"hits":page.hits}),
                )?;
                output_ms += millis(started);
                if final_page {
                    break;
                }
            }
            emit(
                json!({"type":"query","queryId":query.id,"query":query.query,"sample":sample,"snapshot":snapshot,"source":source,"pages":pages,"hits":hits,
                "documents":documents,"sourceBytes":source_bytes,"queryMs":query_ms,"pageOutputMs":output_ms,"scanComplete":true,"coverageComplete":generation.coverage_complete(),"complete":generation.coverage_complete()}),
            )?;
        }
    }
    emit(
        json!({"type":"done","queries":queries.queries.len()*samples,"snapshot":snapshot,"source":source,"coverageComplete":generation.coverage_complete()}),
    )
}
fn main() {
    let mut args = std::env::args().skip(1);
    let mut fixture = None;
    let mut samples = 1usize;
    let result = (|| -> Result<()> {
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--fixture" => {
                    fixture = Some(PathBuf::from(
                        args.next()
                            .ok_or_else(|| failure("arguments", "missing fixture"))?,
                    ))
                }
                "--samples" => {
                    samples = args
                        .next()
                        .ok_or_else(|| failure("arguments", "missing samples"))?
                        .parse()
                        .map_err(|_| failure("arguments", "invalid samples"))?
                }
                _ => {
                    return Err(failure(
                        "arguments",
                        "expected --fixture PATH [--samples 1..20]",
                    ))
                }
            }
        }
        if !(1..=20).contains(&samples) {
            return Err(failure("arguments", "samples outside 1..20"));
        }
        run(
            fixture.ok_or_else(|| failure("arguments", "fixture required"))?,
            samples,
        )
    })();
    if let Err(error) = result {
        let _ = emit(json!({"type":"error","phase":error.phase,"detail":error.detail}));
        std::process::exit(1);
    }
}
