//! Representative generated Base baseline; keeps the linked workload and engine budgets.
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use zorid_bases::{
    compile_base_source, query_generation, FilePresentationFacts, QueryOptions, RecordWitness,
};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::MetadataRequest;
use zorid_index::*;

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
    presentation: Presentation,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Presentation {
    ctime_ms: i64,
    mtime_ms: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    schema_version: u32,
    oracle_version: String,
    programs: Vec<ProgramInput>,
    invocations: Vec<Invocation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProgramInput {
    id: String,
    source: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Invocation {
    id: String,
    program_id: String,
    options: QueryOptions,
}
struct Loaded {
    entry: EntryState,
    request: Option<MetadataRequest>,
    expected_digest: String,
    bytes: u64,
    presentation: Presentation,
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
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn emit(value: serde_json::Value) -> Result<()> {
    let out = io::stdout();
    let mut out = out.lock();
    serde_json::to_writer(&mut out, &value).map_err(|e| fail("output", e))?;
    out.write_all(b"\n").map_err(|e| fail("output", e))?;
    out.flush().map_err(|e| fail("output", e))
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|e| fail("setup", e))?;
    if !file.metadata().map_err(|e| fail("setup", e))?.is_file() {
        return Err(fail("setup", "input must be a file"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail("setup", e))?;
    if bytes.len() as u64 > limit {
        return Err(fail("setup", "input byte bound"));
    }
    Ok(bytes)
}
fn run(fixture: PathBuf) -> Result<()> {
    let start = Instant::now();
    let manifest_bytes = read(&fixture.join("manifest.json"), 64 * 1024 * 1024)?;
    let plan_bytes = read(&fixture.join("generated-bases-plan.json"), 1024 * 1024)?;
    let manifest: InputManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|e| fail("decode", e))?;
    let plan: Plan = serde_json::from_slice(&plan_bytes).map_err(|e| fail("decode", e))?;
    if manifest.schema_version != 1
        || manifest.generator != "zorid-s1-workload-v1"
        || ![100, 10000].contains(&manifest.note_count)
        || manifest.entries.len() != manifest.note_count + 3
        || plan.schema_version != 1
        || plan.oracle_version != "zorid-generated-bases-v1"
        || plan.programs.len() != 5
        || plan.invocations.len() != 8
    {
        return Err(fail("setup", "unsupported frozen profile/plan"));
    }
    let vault = fs::canonicalize(fixture.join("vault")).map_err(|e| fail("setup", e))?;
    let mut loaded = Vec::new();
    let mut bytes_read = 0u64;
    let mut read_ms = 0.0;
    let mut decode_ms = 0.0;
    for input in manifest.entries {
        let path = VaultPath::new(&input.path).map_err(|e| fail("setup", e))?;
        let absolute = fs::canonicalize(vault.join(path.as_str())).map_err(|e| fail("setup", e))?;
        if !absolute.starts_with(&vault)
            || input.bytes > zorid_document::MAX_SOURCE_BYTES as u64
            || input.sha256.len() != 64
            || !input.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(fail("setup", "invalid source/path bound"));
        }
        bytes_read = bytes_read
            .checked_add(input.bytes)
            .filter(|n| *n <= 128 * 1024 * 1024)
            .ok_or_else(|| fail("setup", "aggregate source bound"))?;
        let started = Instant::now();
        let bytes = read(&absolute, input.bytes)?;
        read_ms += ms(started);
        if bytes.len() as u64 != input.bytes {
            return Err(fail("setup", "source length changed"));
        }
        let entry = EntryState {
            id: EntryId::new(&input.logical_id).map_err(|e| fail("setup", e))?,
            revision: Revision::new(format!("source-{}", input.sha256))
                .map_err(|e| fail("setup", e))?,
            path,
            kind: EntryKind::File,
            deleted: false,
        };
        let started = Instant::now();
        let request = match input.kind.as_str() {
            "text" => Some(MetadataRequest {
                entry_id: entry.id.clone(),
                content_revision: entry.revision.clone(),
                source: String::from_utf8(bytes).map_err(|e| fail("setup", e))?,
            }),
            "binary" => None,
            _ => return Err(fail("setup", "unknown source kind")),
        };
        decode_ms += ms(started);
        loaded.push(Loaded {
            entry,
            request,
            expected_digest: input.sha256,
            bytes: input.bytes,
            presentation: input.presentation,
        });
    }
    emit(
        json!({"type":"setup","noteCount":manifest.note_count,"entries":loaded.len(),"sourceBytes":bytes_read,"manifestBytes":manifest_bytes.len(),"planBytes":plan_bytes.len(),"setupMs":ms(start),"sourceReadMs":read_ms,"sourceDecodeMs":decode_ms,"debugAssertions":cfg!(debug_assertions)}),
    )?;
    let started = Instant::now();
    let local = OperationId::new("s1-generated-bases-store").map_err(|e| fail("generation", e))?;
    let source = SourceSnapshotId::new(
        local.clone(),
        SourceWatermark::new("1").map_err(|e| fail("generation", e))?,
    );
    let snapshot = IndexSnapshotId::new(
        local,
        OperationId::new("s1-generated-bases-epoch").map_err(|e| fail("generation", e))?,
        1,
        SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .map_err(|e| fail("generation", e))?,
    )
    .map_err(|e| fail("generation", e))?;
    let inventory = Manifest::new(
        source.clone(),
        loaded.iter().map(|l| l.entry.clone()).collect(),
    )
    .map_err(|e| fail("generation", e))?;
    let mut builder = GenerationBuilder::new(
        inventory,
        PublicationFence::new(source.clone(), None, snapshot.clone())
            .map_err(|e| fail("generation", e))?,
    )
    .map_err(|e| fail("generation", e))?;
    let mut parse_calls = 0usize;
    let mut pump_resets = 0usize;
    let mut facts = Vec::new();
    for input in &loaded {
        let witness = builder
            .manifest()
            .witness(&input.entry.id)
            .map_err(|e| fail("generation", e))?;
        let record = if let Some(request) = &input.request {
            let markdown = input.entry.path.as_str().ends_with(".md");
            parse_calls += usize::from(markdown);
            let record =
                IndexRecord::text(witness, request, markdown).map_err(|e| fail("generation", e))?;
            if record
                .text_digest()
                .is_none_or(|digest| hex(digest) != input.expected_digest)
            {
                return Err(fail(
                    "source-commitment",
                    "text digest differs or extraction excluded",
                ));
            }
            record
        } else {
            IndexRecord::excluded(witness, Exclusion::Binary)
        };
        match builder.add(record.clone()) {
            Ok(()) => {}
            Err(IndexError::PumpLimit) => {
                builder.begin_pump();
                pump_resets += 1;
                builder.add(record).map_err(|e| fail("generation", e))?;
            }
            Err(e) => return Err(fail("generation", e)),
        }
        facts.push(FilePresentationFacts {
            witness: RecordWitness {
                entry_id: input.entry.id.clone(),
                revision: input.entry.revision.clone(),
            },
            size: Some(input.bytes),
            ctime_ms: Some(input.presentation.ctime_ms),
            mtime_ms: Some(input.presentation.mtime_ms),
        });
    }
    let metadata_bytes = builder.metadata_bytes();
    let generation = builder
        .finish()
        .map_err(|e| fail("generation", e))?
        .into_parts()
        .1;
    emit(
        json!({"type":"generation","source":source,"snapshot":snapshot,"records":generation.records().count(),"coverageComplete":generation.coverage_complete(),"metadataBytes":metadata_bytes,"parseInvocations":parse_calls,"pumpResets":pump_resets,"generationBuildMs":ms(started),"fileFacts":facts.len()}),
    )?;
    let mut programs = BTreeMap::new();
    for input in plan.programs {
        if programs.contains_key(&input.id) {
            return Err(fail("configuration", "duplicate program"));
        }
        let started = Instant::now();
        let program = compile_base_source(&input.source)
            .map_err(|e| fail("configuration", format!("{}: {e:?}", input.id)))?;
        let elapsed = ms(started);
        emit(
            json!({"type":"program","programId":input.id,"sourceBytes":input.source.len(),"yamlAndConfigurationMs":elapsed}),
        )?;
        programs.insert(input.id, program);
    }
    let mut successes = 0usize;
    let mut rejections = 0usize;
    for invocation in plan.invocations {
        let program = programs
            .get(&invocation.program_id)
            .ok_or_else(|| fail("query", "unknown program"))?;
        let started = Instant::now();
        let result = query_generation(program, &generation, &facts, &invocation.options);
        let query_ms = ms(started);
        let started = Instant::now();
        match result {
            Ok(result) => {
                successes += 1;
                emit(
                    json!({"type":"result","caseId":invocation.id,"programId":invocation.program_id,"options":invocation.options,"source":source,"snapshot":snapshot,"queryMs":query_ms,"outcome":"ok","result":result}),
                )?;
            }
            Err(error) => {
                rejections += 1;
                emit(
                    json!({"type":"result","caseId":invocation.id,"programId":invocation.program_id,"options":invocation.options,"source":source,"snapshot":snapshot,"queryMs":query_ms,"outcome":"rejected","error":error}),
                )?;
            }
        }
        emit(json!({"type":"measurement","caseId":invocation.id,"resultOutputMs":ms(started)}))?;
    }
    emit(
        json!({"type":"done","invocations":8,"successes":successes,"rejections":rejections,"source":source,"snapshot":snapshot}),
    )
}
fn main() {
    let mut args = std::env::args().skip(1);
    let result = (|| -> Result<()> {
        if args.next().as_deref() != Some("--fixture") {
            return Err(fail("arguments", "expected --fixture PATH"));
        }
        let fixture = PathBuf::from(
            args.next()
                .ok_or_else(|| fail("arguments", "missing fixture"))?,
        );
        if args.next().is_some() {
            return Err(fail("arguments", "unexpected argument"));
        }
        run(fixture)
    })();
    if let Err(e) = result {
        let _ = emit(json!({"type":"error","phase":e.phase,"detail":e.detail}));
        std::process::exit(1);
    }
}
