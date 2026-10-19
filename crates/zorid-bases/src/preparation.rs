//! Session-owned optional pure-data reuse. This never admits a host pin or a
//! source commitment. Hosts check both before lookup and after evaluation.
use crate::{
    graph, program, query, BaseCompileError, BaseProgram, BaseQueryResult, BaseSnapshot,
    DetachedRecord, ExpressionDiagnostic, FilePresentationFacts, IndexSnapshotId, PropertyValue,
    QueryOptions,
};
use std::{collections::VecDeque, mem::size_of, sync::Arc};
use zorid_core::EntryState;
use zorid_index::{Generation, IndexRecord, SourceSnapshotId};

pub const MAX_PREPARED_GENERATION_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_COMPILED_PROGRAM_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PREPARED_GENERATIONS: usize = 4;
pub const MAX_COMPILED_PROGRAMS: usize = 64;
pub const PREPARATION_IDLE_MS: u64 = 5 * 60 * 1000;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparationCacheOutcome {
    Hit,
    Miss,
    Uncached,
}
/// Work credit is private: a caller cannot claim that preparation was free.
pub struct PreparationLookup<T> {
    value: T,
    outcome: PreparationCacheOutcome,
    work_used: usize,
}
impl<T> PreparationLookup<T> {
    pub fn value(&self) -> &T {
        &self.value
    }
    pub fn outcome(&self) -> PreparationCacheOutcome {
        self.outcome
    }
    pub fn work_used(&self) -> usize {
        self.work_used
    }
}
/// Sealed owned rows, complete graph/adjacency and generation-only discovery.
/// No serialization, source writes, transaction, pin or host liveness proof.
pub struct PreparedBaseGeneration {
    snapshot: BaseSnapshot,
    query: query::QueryPreparation,
}
impl PreparedBaseGeneration {
    pub fn snapshot_id(&self) -> &IndexSnapshotId {
        self.snapshot.snapshot_id()
    }
}
struct GenerationProof {
    id: IndexSnapshotId,
    source: SourceSnapshotId,
    entries: Vec<EntryState>,
    records: Vec<IndexRecord>,
    facts: Vec<FilePresentationFacts>,
    record_work: Vec<usize>,
    compare_work: usize,
    record_heap_bytes: usize,
}
struct GenerationEntry {
    proof: GenerationProof,
    value: Arc<PreparedBaseGeneration>,
    bytes: usize,
    touched: u64,
}
struct ProgramEntry {
    version: &'static str,
    source: String,
    value: Arc<BaseProgram>,
    bytes: usize,
    touched: u64,
}
/// Caps cover allocations retained by this cache, conservatively including shared
/// namespace allocations. Returned Arcs are invocation-local host data: callers
/// retaining them can delay reclamation after eviction/clear/drop. They must not
/// be stored on pins or treated as bounded host-wide memory/admission authority.
pub struct BasePreparationCache {
    generations: VecDeque<GenerationEntry>,
    programs: VecDeque<ProgramEntry>,
    last_clock: Option<u64>,
}
impl Default for BasePreparationCache {
    fn default() -> Self {
        Self {
            generations: VecDeque::with_capacity(MAX_PREPARED_GENERATIONS),
            programs: VecDeque::with_capacity(MAX_COMPILED_PROGRAMS),
            last_clock: None,
        }
    }
}
fn stopped(options: &QueryOptions) -> Result<(), ExpressionDiagnostic> {
    if options
        .evaluation
        .cancellation
        .as_ref()
        .is_some_and(|c| c.stop_reason().is_some())
    {
        Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"))
    } else {
        Ok(())
    }
}
fn limits(options: &QueryOptions) -> Result<(), ExpressionDiagnostic> {
    stopped(options)?;
    if options.max_steps == 0
        || options.max_steps > crate::MAX_QUERY_STEPS
        || options.max_scanned > crate::MAX_QUERY_SCANNED
        || options.max_rows > crate::MAX_QUERY_ROWS
        || options.max_groups > crate::MAX_QUERY_GROUPS
        || options.max_output_bytes > crate::MAX_QUERY_OUTPUT_BYTES
        || options.evaluation.max_steps == 0
        || options.evaluation.max_steps > crate::MAX_EXPRESSION_STEPS
    {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Query ceilings exceed supported maximum",
        ));
    }
    Ok(())
}
fn charge(
    remaining: &mut usize,
    options: &QueryOptions,
    work: usize,
) -> Result<(), ExpressionDiagnostic> {
    stopped(options)?;
    *remaining = remaining.checked_sub(work).ok_or_else(|| {
        ExpressionDiagnostic::new("budget", "Generation preparation exceeds query work budget")
    })?;
    Ok(())
}
impl BasePreparationCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn clear(&mut self) {
        self.generations.clear();
        self.programs.clear();
    }
    fn expire(&mut self, now: u64) {
        if self.last_clock.is_some_and(|previous| now < previous) {
            self.clear();
        }
        self.last_clock = Some(now);
        self.generations
            .retain(|e| now.saturating_sub(e.touched) < PREPARATION_IDLE_MS);
        self.programs
            .retain(|e| now.saturating_sub(e.touched) < PREPARATION_IDLE_MS);
    }
    /// Exact UTF8 is supplied only after the host's retained definition check.
    /// Typed YAML/semantic errors are unchanged and are never cached.
    pub fn compile_source(
        &mut self,
        source: &str,
        monotonic_ms: u64,
    ) -> Result<PreparationLookup<Arc<BaseProgram>>, BaseCompileError> {
        self.expire(monotonic_ms);
        if let Some(index) = self
            .programs
            .iter()
            .position(|e| e.version == program::BASE_COMPILER_VERSION && e.source == source)
        {
            let mut entry = self.programs.remove(index).expect("found");
            entry.touched = monotonic_ms;
            let value = Arc::clone(&entry.value);
            self.programs.push_back(entry);
            return Ok(PreparationLookup {
                value,
                outcome: PreparationCacheOutcome::Hit,
                work_used: 0,
            });
        }
        let value = Arc::new(crate::compile_base_source(source)?);
        let bytes = source.len().saturating_add(program_bytes(&value));
        let overhead = size_of::<Self>() + self.programs.capacity() * size_of::<ProgramEntry>();
        let outcome = if bytes.saturating_add(overhead) <= MAX_COMPILED_PROGRAM_BYTES {
            while self.programs.len() >= MAX_COMPILED_PROGRAMS
                || self
                    .programs
                    .iter()
                    .map(|e| e.bytes)
                    .sum::<usize>()
                    .saturating_add(bytes)
                    .saturating_add(overhead)
                    > MAX_COMPILED_PROGRAM_BYTES
            {
                self.programs.pop_front();
            }
            self.programs.push_back(ProgramEntry {
                version: program::BASE_COMPILER_VERSION,
                source: source.into(),
                value: Arc::clone(&value),
                bytes,
                touched: monotonic_ms,
            });
            PreparationCacheOutcome::Miss
        } else {
            PreparationCacheOutcome::Uncached
        };
        Ok(PreparationLookup {
            value,
            outcome,
            work_used: 0,
        })
    }
    pub fn prepare_generation(
        &mut self,
        generation: &Generation,
        facts: &[FilePresentationFacts],
        options: &QueryOptions,
        monotonic_ms: u64,
    ) -> Result<PreparationLookup<Arc<PreparedBaseGeneration>>, ExpressionDiagnostic> {
        limits(options)?;
        self.expire(monotonic_ms);
        let mut remaining = options.max_steps;
        for index in (0..self.generations.len()).rev() {
            charge(&mut remaining, options, 1)?;
            let entry = &self.generations[index];
            if entry.proof.id != *generation.id()
                || entry.proof.source != *generation.manifest().source()
                || entry.proof.facts.len() != facts.len()
            {
                continue;
            }
            // O(1) admission before any deep walk. An optional cache probe may
            // not add a new limit to a valid cold operation.
            if entry.proof.compare_work > remaining {
                break;
            }
            let mut equal = entry.proof.entries.len() == generation.manifest().entries().len();
            for (a, b) in entry.proof.facts.iter().zip(facts) {
                charge(
                    &mut remaining,
                    options,
                    1 + (a.witness.entry_id.as_str().len() + a.witness.revision.as_str().len())
                        / 64,
                )?;
                if a != b {
                    equal = false;
                    break;
                }
            }
            if equal {
                for (a, b) in entry
                    .proof
                    .entries
                    .iter()
                    .zip(generation.manifest().entries())
                {
                    charge(&mut remaining, options, 1 + state_heap(a) / 64)?;
                    if a != b {
                        equal = false;
                        break;
                    }
                }
            }
            if equal {
                let mut actual = generation.records();
                for (saved, work) in entry.proof.records.iter().zip(&entry.proof.record_work) {
                    charge(&mut remaining, options, *work)?;
                    if actual.next() != Some(saved) {
                        equal = false;
                        break;
                    }
                    stopped(options)?;
                }
                if actual.next().is_some() {
                    equal = false;
                }
            }
            if equal {
                stopped(options)?;
                if entry.value.snapshot.records.len() > options.max_scanned {
                    return Err(ExpressionDiagnostic::new(
                        "budget",
                        "Snapshot exceeds scanned-record budget",
                    ));
                }
                let mut entry = self.generations.remove(index).expect("found");
                entry.touched = monotonic_ms;
                let value = Arc::clone(&entry.value);
                self.generations.push_back(entry);
                return Ok(PreparationLookup {
                    value,
                    outcome: PreparationCacheOutcome::Hit,
                    work_used: options.max_steps - remaining,
                });
            }
        }
        graph::preflight_generation(generation, options)?;
        let snapshot = BaseSnapshot::from_generation_checked(generation, facts, &mut |work| {
            charge(&mut remaining, options, work)
        })?;
        let mut invocation = options.clone();
        invocation.max_steps = remaining;
        let prepared_query = query::prepare_snapshot(&snapshot, &invocation)?;
        charge(&mut remaining, options, prepared_query.work_used)?;
        let value = Arc::new(PreparedBaseGeneration {
            snapshot,
            query: prepared_query,
        });
        let prepared_bytes = prepared_bytes(&value);
        let overhead =
            size_of::<Self>() + self.generations.capacity() * size_of::<GenerationEntry>();
        let proof = if let Some(allowance) =
            MAX_PREPARED_GENERATION_BYTES.checked_sub(prepared_bytes.saturating_add(overhead))
        {
            GenerationProof::new(generation, facts, options, &mut remaining, allowance)?
        } else {
            None
        };
        let outcome = if let Some(proof) = proof {
            let bytes = proof.retained_bytes().saturating_add(prepared_bytes);
            while self.generations.len() >= MAX_PREPARED_GENERATIONS
                || self
                    .generations
                    .iter()
                    .map(|e| e.bytes)
                    .sum::<usize>()
                    .saturating_add(bytes)
                    .saturating_add(overhead)
                    > MAX_PREPARED_GENERATION_BYTES
            {
                self.generations.pop_front();
            }
            self.generations.push_back(GenerationEntry {
                proof,
                value: Arc::clone(&value),
                bytes,
                touched: monotonic_ms,
            });
            PreparationCacheOutcome::Miss
        } else {
            PreparationCacheOutcome::Uncached
        };
        Ok(PreparationLookup {
            value,
            outcome,
            work_used: options.max_steps - remaining,
        })
    }
}
/// Evaluate afresh; this is deliberately not a pin-admission or answer cache.
/// Changed options cannot reset the checked preparation/proof work credit.
pub fn query_prepared(
    program: &BaseProgram,
    preparation: &PreparationLookup<Arc<PreparedBaseGeneration>>,
    options: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    limits(options)?;
    let mut invocation = options.clone();
    invocation.max_steps = invocation
        .max_steps
        .checked_sub(preparation.work_used)
        .ok_or_else(|| {
            ExpressionDiagnostic::new("budget", "Preparation exceeds current query work budget")
        })?;
    let mut result = query::query_base_prepared(
        program,
        &preparation.value.snapshot,
        &invocation,
        Some(&preparation.value.query),
    )?;
    result.steps_used = result.steps_used.saturating_add(preparation.work_used);
    crate::encoded_size(&result, options.max_output_bytes)?;
    stopped(options)?;
    Ok(result)
}
impl GenerationProof {
    fn new(
        generation: &Generation,
        facts: &[FilePresentationFacts],
        options: &QueryOptions,
        remaining: &mut usize,
        allowance: usize,
    ) -> Result<Option<Self>, ExpressionDiagnostic> {
        let mut records = Vec::new();
        let mut record_work = Vec::new();
        let mut record_heap_bytes = 0usize;
        for record in generation.records() {
            stopped(options)?;
            let heap = record_heap(record);
            let work = 1 + heap / 64;
            // Optional retention never adds a new source-size limit. Admit the
            // deep copy before allocating, and preserve work already performed.
            if work > *remaining
                || record_heap_bytes
                    .saturating_add(heap)
                    .saturating_add((records.len() + 1) * size_of::<IndexRecord>())
                    > allowance
            {
                return Ok(None);
            }
            charge(remaining, options, work)?;
            records.push(record.clone());
            record_work.push(work);
            record_heap_bytes = record_heap_bytes.saturating_add(heap);
        }
        let entries = generation.manifest().entries().to_vec();
        let compare_work = record_work
            .iter()
            .copied()
            .sum::<usize>()
            .saturating_add(
                entries
                    .iter()
                    .map(|e| 1 + state_heap(e) / 64)
                    .sum::<usize>(),
            )
            .saturating_add(
                facts
                    .iter()
                    .map(|f| {
                        1 + (f.witness.entry_id.as_str().len() + f.witness.revision.as_str().len())
                            / 64
                    })
                    .sum::<usize>(),
            );
        let proof = Self {
            id: generation.id().clone(),
            source: generation.manifest().source().clone(),
            entries,
            records,
            facts: facts.to_vec(),
            record_work,
            compare_work,
            record_heap_bytes,
        };
        stopped(options)?;
        Ok((proof.retained_bytes() <= allowance).then_some(proof))
    }
    fn retained_bytes(&self) -> usize {
        size_of::<Self>()
            + self.entries.capacity() * size_of::<EntryState>()
            + self.entries.iter().map(state_heap).sum::<usize>()
            + self.records.capacity() * size_of::<IndexRecord>()
            + self.record_heap_bytes
            + self.facts.capacity() * size_of::<FilePresentationFacts>()
            + self
                .facts
                .iter()
                .map(|f| f.witness.entry_id.as_str().len() + f.witness.revision.as_str().len())
                .sum::<usize>()
            + self.record_work.capacity() * size_of::<usize>()
            + self.id.local_store_id().as_str().len()
            + self.id.generation_epoch().as_str().len()
            + self.id.versions().extraction().len()
            + self.id.versions().resolver().len()
            + self.id.versions().query().len()
            + self.source.local_store_id().as_str().len()
            + self.source.watermark().as_str().len()
    }
}
// Core identity/path wrappers clone their private strings to exact-sized
// owned backing; public String/Vec fields below use their actual capacities.
pub(crate) fn state_heap(e: &EntryState) -> usize {
    e.id.as_str().len() + e.path.as_str().len() + e.revision.as_str().len()
}
pub(crate) fn property_heap(v: &PropertyValue) -> usize {
    match v {
        PropertyValue::String(s) => s.capacity(),
        PropertyValue::Array(v) => {
            v.capacity() * size_of::<PropertyValue>() + v.iter().map(property_heap).sum::<usize>()
        }
        PropertyValue::Object(v) => {
            v.capacity() * size_of::<(String, PropertyValue)>()
                + v.iter()
                    .map(|(k, v)| k.capacity() + property_heap(v))
                    .sum::<usize>()
        }
        _ => 0,
    }
}
fn record_heap(r: &IndexRecord) -> usize {
    let mut bytes = state_heap(r.witness().entry())
        + r.witness().source().local_store_id().as_str().len()
        + r.witness().source().watermark().as_str().len();
    if let Some(m) = r.metadata() {
        bytes += m.dialect_version.capacity()
            + m.entry_id.as_str().len()
            + m.content_revision.as_str().len()
            + m.properties.capacity() * size_of::<zorid_document::Property>()
            + m.properties
                .iter()
                .map(|p| p.key.capacity() + property_heap(&p.value))
                .sum::<usize>()
            + m.aliases.capacity() * size_of::<String>()
            + m.aliases.iter().map(String::capacity).sum::<usize>()
            + m.tags.capacity() * size_of::<String>()
            + m.tags.iter().map(String::capacity).sum::<usize>()
            + m.tag_occurrences.capacity() * size_of::<zorid_document::TagOccurrence>()
            + m.tag_occurrences
                .iter()
                .map(|t| t.name.capacity())
                .sum::<usize>()
            + m.headings.capacity() * size_of::<zorid_document::Heading>()
            + m.headings.iter().map(|h| h.text.capacity()).sum::<usize>()
            + m.links.capacity() * size_of::<zorid_document::Link>()
            + m.links
                .iter()
                .map(|l| l.target.capacity() + l.fragment.capacity() + l.destination.capacity())
                .sum::<usize>()
            + m.tasks.capacity() * size_of::<zorid_document::Task>()
            + m.tasks
                .iter()
                .map(|t| t.status.capacity() + t.text.capacity())
                .sum::<usize>()
            + m.diagnostics.capacity() * size_of::<zorid_document::Diagnostic>();
    }
    bytes
}
fn record_row_heap(r: &DetachedRecord) -> usize {
    r.path.capacity()
        + r.witness
            .as_ref()
            .map_or(0, |w| w.entry_id.as_str().len() + w.revision.as_str().len())
        + r.properties.capacity() * size_of::<(String, PropertyValue)>()
        + r.properties
            .iter()
            .map(|(k, v)| k.capacity() + property_heap(v))
            .sum::<usize>()
        + r.property_types.capacity() * size_of::<(String, zorid_document::PropertyType)>()
        + r.property_types
            .iter()
            .map(|(k, _)| k.capacity())
            .sum::<usize>()
        + r.tags.capacity() * size_of::<String>()
        + r.tags.iter().map(String::capacity).sum::<usize>()
}
fn prepared_bytes(p: &PreparedBaseGeneration) -> usize {
    size_of::<PreparedBaseGeneration>()
        + 2 * size_of::<usize>()
        + p.snapshot.records.capacity() * size_of::<DetachedRecord>()
        + p.snapshot
            .records
            .iter()
            .map(record_row_heap)
            .sum::<usize>()
        + p.snapshot
            .relationships
            .as_ref()
            .map_or(0, |g| g.retained_bytes())
        + p.snapshot.metadata_issues.capacity() * size_of::<crate::MetadataIssue>()
        + p.snapshot
            .metadata_issues
            .iter()
            .map(|i| {
                i.witness.entry_id.as_str().len()
                    + i.witness.revision.as_str().len()
                    + i.diagnostics.capacity() * size_of::<zorid_document::Diagnostic>()
            })
            .sum::<usize>()
        + p.query
            .relationships
            .as_ref()
            .map_or(0, |g| g.retained_bytes())
        + p.query.available.capacity() * size_of::<String>()
        + p.query
            .available
            .iter()
            .map(String::capacity)
            .sum::<usize>()
        + p.snapshot.snapshot_id.local_store_id().as_str().len()
        + p.snapshot.snapshot_id.generation_epoch().as_str().len()
        + p.snapshot.snapshot_id.versions().extraction().len()
        + p.snapshot.snapshot_id.versions().resolver().len()
        + p.snapshot.snapshot_id.versions().query().len()
}
fn program_bytes(p: &BaseProgram) -> usize {
    fn filter(f: &program::Filter) -> usize {
        match f {
            program::Filter::Expression(s) => s.capacity(),
            program::Filter::And(v) | program::Filter::Or(v) | program::Filter::Not(v) => {
                v.capacity() * size_of::<program::Filter>() + v.iter().map(filter).sum::<usize>()
            }
        }
    }
    fn value(v: &crate::BaseValue) -> usize {
        match v {
            crate::BaseValue::String { value } | crate::BaseValue::File { path: value } => {
                value.capacity()
            }
            crate::BaseValue::List { value: v } => {
                v.capacity() * size_of::<crate::BaseValue>() + v.iter().map(value).sum::<usize>()
            }
            crate::BaseValue::Object { value: v } => {
                v.capacity() * size_of::<(String, crate::BaseValue)>()
                    + v.iter()
                        .map(|(k, v)| k.capacity() + value(v))
                        .sum::<usize>()
            }
            crate::BaseValue::Link {
                path,
                target,
                display,
                ..
            } => {
                path.capacity()
                    + target
                        .as_ref()
                        .map_or(0, |w| w.entry_id.as_str().len() + w.revision.as_str().len())
                    + display.as_ref().map_or(0, String::capacity)
            }
            crate::BaseValue::Error { code, message } => code.capacity() + message.capacity(),
            _ => 0,
        }
    }
    size_of::<BaseProgram>()
        + 2 * size_of::<usize>()
        + property_heap(&p.configuration)
        + p.formulas.capacity() * size_of::<(String, String)>()
        + p.formulas
            .iter()
            .map(|(k, v)| k.capacity() + v.capacity())
            .sum::<usize>()
        + p.filter.as_ref().map_or(0, filter)
        + p.views.capacity() * size_of::<program::View>()
        + p.views
            .iter()
            .map(|v| {
                property_heap(&v.configuration)
                    + v.filter.as_ref().map_or(0, filter)
                    + v.order.capacity() * size_of::<String>()
                    + v.order.iter().map(String::capacity).sum::<usize>()
                    + v.sort.capacity() * size_of::<program::Criterion>()
                    + v.sort.iter().map(|s| s.property.capacity()).sum::<usize>()
                    + v.group.as_ref().map_or(0, |s| s.property.capacity())
                    + v.group_order.as_ref().map_or(0, |g| {
                        g.capacity() * size_of::<crate::BaseValue>()
                            + g.iter().map(value).sum::<usize>()
                    })
            })
            .sum::<usize>()
}

#[cfg(test)]
#[path = "preparation_tests.rs"]
mod tests;
