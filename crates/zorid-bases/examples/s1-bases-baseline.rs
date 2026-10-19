//! Bounded existing-corpus Base baseline. No new language or cache semantics.
use serde::Deserialize;
use serde_json::json;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use zorid_bases::{
    compile_base, query_base, query_generation, BaseSnapshot, FilePresentationFacts, PropertyValue,
    QueryOptions,
};
use zorid_core::EntryState;
use zorid_index::{Generation, GenerationSource, IndexSnapshotId, SourceSnapshotId};

const MAX_CORPUS_BYTES: u64 = 2 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus<T> {
    schema_version: u32,
    cases: Vec<Case<T>>,
}
#[derive(Deserialize)]
struct Case<T> {
    id: String,
    request: T,
}
#[derive(Deserialize)]
struct DetachedRequest {
    configuration: PropertyValue,
    snapshot: BaseSnapshot,
    options: QueryOptions,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationRequest {
    source: SourceSnapshotId,
    snapshot_id: IndexSnapshotId,
    entries: Vec<EntryState>,
    sources: Vec<GenerationSource>,
    facts: Vec<FilePresentationFacts>,
    configuration: PropertyValue,
    options: QueryOptions,
}
#[derive(Debug)]
struct Failure {
    phase: &'static str,
    detail: String,
}
type Result<T> = std::result::Result<T, Failure>;
fn fail(phase: &'static str, detail: impl ToString) -> Failure {
    Failure {
        phase,
        detail: detail.to_string(),
    }
}
fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn emit(value: serde_json::Value) -> Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &value).map_err(|e| fail("output", e))?;
    out.write_all(b"\n").map_err(|e| fail("output", e))?;
    out.flush().map_err(|e| fail("output", e))
}
fn read(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|e| fail("setup", e))?;
    if !file.metadata().map_err(|e| fail("setup", e))?.is_file() {
        return Err(fail("setup", "corpus must be a file"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_CORPUS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail("setup", e))?;
    if bytes.len() as u64 > MAX_CORPUS_BYTES {
        return Err(fail("setup", "corpus byte bound"));
    }
    Ok(bytes)
}
fn run(directory: PathBuf, samples: usize) -> Result<()> {
    let start = Instant::now();
    let read_start = Instant::now();
    let detached_bytes = read(&directory.join("accepted-queries.json"))?;
    let generation_bytes = read(&directory.join("accepted-generation-queries.json"))?;
    let read_ms = ms(read_start);
    let decode_start = Instant::now();
    // Deserialize directly into ordered PropertyValue/record types. A Value
    // round trip would sort maps and change source-order-dependent semantics.
    let detached: Corpus<DetachedRequest> =
        serde_json::from_slice(&detached_bytes).map_err(|e| fail("decode", e))?;
    let generations: Corpus<GenerationRequest> =
        serde_json::from_slice(&generation_bytes).map_err(|e| fail("decode", e))?;
    let decode_ms = ms(decode_start);
    if detached.schema_version != 1
        || generations.schema_version != 1
        || detached.cases.len() != 10
        || generations.cases.len() != 7
    {
        return Err(fail("setup", "unsupported frozen corpus envelope"));
    }
    emit(
        json!({"type":"setup","detachedCases":detached.cases.len(),"generationCases":generations.cases.len(),"samples":samples,"debugAssertions":cfg!(debug_assertions),
        "files":[{"name":"accepted-queries.json","bytes":detached_bytes.len()},{"name":"accepted-generation-queries.json","bytes":generation_bytes.len()}],"setupMs":ms(start),"readMs":read_ms,"typedDecodeMs":decode_ms}),
    )?;
    for case in detached.cases {
        let started = Instant::now();
        let program = compile_base(case.request.configuration)
            .map_err(|e| fail("configuration-compile", format!("{}: {e}", case.id)))?;
        let compile_ms = ms(started);
        emit(
            json!({"type":"prepared","family":"detached","caseId":case.id,"source":null,"snapshot":case.request.snapshot.snapshot_id(),"configurationCompileMs":compile_ms,"generationBuildMs":null}),
        )?;
        for sample in 0..samples {
            let started = Instant::now();
            let result = query_base(&program, &case.request.snapshot, &case.request.options)
                .map_err(|e| fail("query", format!("{}: {e}", case.id)))?;
            let query_ms = ms(started);
            let started = Instant::now();
            emit(
                json!({"type":"result","family":"detached","caseId":case.id,"sample":sample,"queryMs":query_ms,"result":result}),
            )?;
            emit(
                json!({"type":"measurement","family":"detached","caseId":case.id,"sample":sample,"resultOutputMs":ms(started)}),
            )?;
        }
    }
    for case in generations.cases {
        let request = case.request;
        let started = Instant::now();
        let generation = Generation::from_sources(
            request.source.clone(),
            request.snapshot_id,
            request.entries,
            request.sources,
        )
        .map_err(|e| fail("generation", format!("{}: {e}", case.id)))?;
        let generation_ms = ms(started);
        let started = Instant::now();
        let program = compile_base(request.configuration)
            .map_err(|e| fail("configuration-compile", format!("{}: {e}", case.id)))?;
        let compile_ms = ms(started);
        emit(
            json!({"type":"prepared","family":"generation","caseId":case.id,"source":request.source,"snapshot":generation.id(),"configurationCompileMs":compile_ms,"generationBuildMs":generation_ms}),
        )?;
        for sample in 0..samples {
            let started = Instant::now();
            let result = query_generation(&program, &generation, &request.facts, &request.options)
                .map_err(|e| fail("query", format!("{}: {e}", case.id)))?;
            let query_ms = ms(started);
            let started = Instant::now();
            emit(
                json!({"type":"result","family":"generation","caseId":case.id,"sample":sample,"queryMs":query_ms,"result":result}),
            )?;
            emit(
                json!({"type":"measurement","family":"generation","caseId":case.id,"sample":sample,"resultOutputMs":ms(started)}),
            )?;
        }
    }
    emit(json!({"type":"done","cases":17,"results":17*samples}))
}
fn main() {
    let mut args = std::env::args().skip(1);
    let mut directory = None;
    let mut samples = 1usize;
    let result = (|| -> Result<()> {
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--corpus-dir" => {
                    directory =
                        Some(PathBuf::from(args.next().ok_or_else(|| {
                            fail("arguments", "missing corpus directory")
                        })?))
                }
                "--samples" => {
                    samples = args
                        .next()
                        .ok_or_else(|| fail("arguments", "missing sample count"))?
                        .parse()
                        .map_err(|_| fail("arguments", "invalid samples"))?
                }
                _ => {
                    return Err(fail(
                        "arguments",
                        "expected --corpus-dir PATH [--samples 1..20]",
                    ))
                }
            }
        }
        if !(1..=20).contains(&samples) {
            return Err(fail("arguments", "sample count bound"));
        }
        run(
            directory.ok_or_else(|| fail("arguments", "corpus directory required"))?,
            samples,
        )
    })();
    if let Err(error) = result {
        let _ = emit(json!({"type":"error","phase":error.phase,"detail":error.detail}));
        std::process::exit(1);
    }
}
