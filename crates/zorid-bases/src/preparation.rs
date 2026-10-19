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
    cache_work: usize,
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
    /// Actual separately bounded optional maintenance/probe units. A hit's proof
    /// work is also charged to semantic evaluation; misses never spend its budget.
    pub fn cache_work_used(&self) -> usize {
        self.cache_work
    }
}
/// Sealed owned rows, complete graph/adjacency and generation-only discovery.
/// No serialization, source writes, transaction, pin or host liveness proof.
pub struct PreparedBaseGeneration {
    snapshot: BaseSnapshot,
    query: query::QueryPreparation,
    cold_work: usize,
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
    compare_work: usize,
    record_work: Vec<usize>,
    retained_bytes: usize,
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
        let mut maintenance = Maintenance::new(None);
        if let Some(index) = self.programs.iter().position(|e| {
            maintenance.bytes(e.source.len()).is_some()
                && e.version == program::BASE_COMPILER_VERSION
                && e.source == source
        }) {
            let mut entry = self.programs.remove(index).expect("found");
            entry.touched = monotonic_ms;
            let value = Arc::clone(&entry.value);
            self.programs.push_back(entry);
            return Ok(PreparationLookup {
                value,
                outcome: PreparationCacheOutcome::Hit,
                work_used: 0,
                cache_work: maintenance.used,
            });
        }
        let value = Arc::new(crate::compile_base_source(source)?);
        let bytes = maintenance
            .bytes(source.len())
            .and_then(|_| program_bytes(&value, &mut maintenance))
            .and_then(|n| n.checked_add(source.len()));
        let overhead = size_of::<Self>().saturating_add(
            self.programs
                .capacity()
                .saturating_mul(size_of::<ProgramEntry>()),
        );
        let outcome = if let Some(bytes) =
            bytes.filter(|n| n.saturating_add(overhead) <= MAX_COMPILED_PROGRAM_BYTES)
        {
            while self.programs.len() >= MAX_COMPILED_PROGRAMS
                || self
                    .programs
                    .iter()
                    .map(|e| e.bytes)
                    .fold(0usize, usize::saturating_add)
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
            cache_work: maintenance.used,
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
        let mut maintenance = Maintenance::new(Some(options));
        for index in (0..self.generations.len()).rev() {
            if maintenance.take(1).is_none() {
                break;
            }
            let entry = &self.generations[index];
            if maintenance
                .bytes(
                    snapshot_id_heap(&entry.proof.id)
                        .saturating_add(entry.proof.source.local_store_id().as_str().len())
                        .saturating_add(entry.proof.source.watermark().as_str().len()),
                )
                .is_none()
            {
                break;
            }
            if entry.proof.id != *generation.id()
                || entry.proof.source != *generation.manifest().source()
                || entry.proof.facts.len() != facts.len()
            {
                continue;
            }
            // Admit the complete comparison before any deep visit. Even a hit
            // cannot charge more semantic work than the exact cold preparation.
            if entry.proof.compare_work > entry.value.cold_work
                || entry.proof.compare_work > options.max_steps
                || !maintenance.can_take(entry.proof.compare_work)
            {
                continue;
            }
            let mut equal = entry.proof.entries.len() == generation.manifest().entries().len();
            for (a, b) in entry.proof.facts.iter().zip(facts) {
                if maintenance.take(fact_work(a)).is_none() {
                    stopped(options)?;
                    unreachable!("comparison allowance pre-admitted");
                }
                stopped(options)?;
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
                    if maintenance.take(state_work(a)).is_none() {
                        stopped(options)?;
                        unreachable!("comparison allowance pre-admitted");
                    }
                    stopped(options)?;
                    if a != b {
                        equal = false;
                        break;
                    }
                }
            }
            if equal {
                let mut actual = generation.records();
                for (saved, work) in entry.proof.records.iter().zip(&entry.proof.record_work) {
                    if maintenance.take(*work).is_none() {
                        stopped(options)?;
                        unreachable!("comparison allowance pre-admitted");
                    }
                    stopped(options)?;
                    if actual.next() != Some(saved) {
                        equal = false;
                        break;
                    }
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
                let work_used = entry.proof.compare_work;
                let value = Arc::clone(&entry.value);
                self.generations.push_back(entry);
                return Ok(PreparationLookup {
                    value,
                    outcome: PreparationCacheOutcome::Hit,
                    work_used,
                    cache_work: maintenance.used,
                });
            }
        }
        stopped(options)?;
        // Failed optional probes do not consume the mandatory cold budget.
        let mut remaining = options.max_steps;
        graph::preflight_generation(generation, options)?;
        let snapshot = BaseSnapshot::from_generation_checked(generation, facts, &mut |work| {
            charge(&mut remaining, options, work)
        })?;
        let mut invocation = options.clone();
        invocation.max_steps = remaining;
        let mut prepared_query = query::prepare_snapshot(&snapshot, &invocation)?;
        prepared_query.snapshot_bytes = Some(crate::encoded_size(
            &snapshot,
            crate::MAX_BASE_REQUEST_BYTES,
        )?);
        query::validate_snapshot_rows(&snapshot)?;
        charge(&mut remaining, options, prepared_query.work_used)?;
        let value = Arc::new(PreparedBaseGeneration {
            snapshot,
            query: prepared_query,
            cold_work: options.max_steps - remaining,
        });
        let overhead = size_of::<Self>().saturating_add(
            self.generations
                .capacity()
                .saturating_mul(size_of::<GenerationEntry>()),
        );
        let retained = prepared_bytes(&value, &mut maintenance).and_then(|bytes| {
            let allowance =
                MAX_PREPARED_GENERATION_BYTES.checked_sub(bytes.checked_add(overhead)?)?;
            let proof = GenerationProof::new(generation, facts, &mut maintenance, allowance)?;
            Some((bytes.checked_add(proof.retained_bytes())?, proof))
        });
        stopped(options)?;
        let outcome = if let Some((bytes, proof)) = retained {
            while self.generations.len() >= MAX_PREPARED_GENERATIONS
                || self
                    .generations
                    .iter()
                    .map(|e| e.bytes)
                    .fold(0usize, usize::saturating_add)
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
            cache_work: maintenance.used,
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
        maintenance: &mut Maintenance<'_>,
        allowance: usize,
    ) -> Option<Self> {
        // Only a bounded bookkeeping vector is allocated during measurement.
        // No authority-derived entries, facts or metadata are cloned until the
        // complete structure/copy costs and all retained bytes are admitted.
        let count = generation.manifest().entries().len();
        let work_slots = slots::<usize>(count, maintenance)?;
        if work_slots > allowance {
            return None;
        }
        let mut record_work = Vec::with_capacity(count);
        let mut record_heap_bytes = 0usize;
        for record in generation.records() {
            let before = maintenance.used;
            let heap = record_heap(record, maintenance)?;
            record_work.push(maintenance.used - before);
            record_heap_bytes = costs([record_heap_bytes, heap])?;
            if record_heap_bytes > allowance {
                return None;
            }
        }
        let mut entry_heap = 0usize;
        let mut compare_work = record_work
            .iter()
            .copied()
            .fold(0usize, usize::saturating_add);
        for entry in generation.manifest().entries() {
            maintenance.take(state_work(entry))?;
            entry_heap = costs([entry_heap, state_heap(entry)])?;
            compare_work = compare_work.checked_add(state_work(entry))?;
        }
        let mut facts_heap = 0usize;
        for fact in facts {
            maintenance.take(fact_work(fact))?;
            facts_heap = costs([facts_heap, fact_heap(fact)])?;
            compare_work = compare_work.checked_add(fact_work(fact))?;
        }
        let fixed = costs([
            size_of::<Self>(),
            count.checked_mul(size_of::<EntryState>())?,
            entry_heap,
            record_work.len().checked_mul(size_of::<IndexRecord>())?,
            record_heap_bytes,
            facts
                .len()
                .checked_mul(size_of::<FilePresentationFacts>())?,
            facts_heap,
            record_work.capacity().checked_mul(size_of::<usize>())?,
            snapshot_id_heap(generation.id()),
            generation
                .manifest()
                .source()
                .local_store_id()
                .as_str()
                .len(),
            generation.manifest().source().watermark().as_str().len(),
        ])?;
        if fixed > allowance {
            return None;
        }
        maintenance.take(compare_work)?; // Reserve the whole copy before cloning.
        maintenance.bytes(
            snapshot_id_heap(generation.id())
                .saturating_add(
                    generation
                        .manifest()
                        .source()
                        .local_store_id()
                        .as_str()
                        .len(),
                )
                .saturating_add(generation.manifest().source().watermark().as_str().len()),
        )?;
        let mut records = Vec::with_capacity(record_work.len());
        for record in generation.records() {
            if maintenance.options.is_some_and(|o| stopped(o).is_err()) {
                return None;
            }
            records.push(record.clone());
        }
        let mut entries = Vec::with_capacity(count);
        for entry in generation.manifest().entries() {
            if maintenance.options.is_some_and(|o| stopped(o).is_err()) {
                return None;
            }
            entries.push(entry.clone());
        }
        let mut copied_facts = Vec::with_capacity(facts.len());
        for fact in facts {
            if maintenance.options.is_some_and(|o| stopped(o).is_err()) {
                return None;
            }
            copied_facts.push(fact.clone());
        }
        let facts = copied_facts;
        Some(Self {
            id: generation.id().clone(),
            source: generation.manifest().source().clone(),
            entries,
            records,
            facts,
            compare_work,
            record_work,
            retained_bytes: fixed,
        })
    }
    fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }
}

// Optional work has its own fixed allowance. It cannot consume the language's
// query budget or turn a valid cold query into a failure. All structural visits
// and byte comparisons/copies are charged before the work; cancellation remains
// authoritative. Exhaustion simply declines optional reuse/retention.
const MAX_PREPARATION_CACHE_WORK: usize = crate::MAX_QUERY_STEPS;
struct Maintenance<'a> {
    options: Option<&'a QueryOptions>,
    used: usize,
}
impl<'a> Maintenance<'a> {
    fn new(options: Option<&'a QueryOptions>) -> Self {
        Self { options, used: 0 }
    }
    fn can_take(&self, work: usize) -> bool {
        self.used
            .checked_add(work)
            .is_some_and(|n| n <= MAX_PREPARATION_CACHE_WORK)
    }
    fn take(&mut self, work: usize) -> Option<()> {
        if self.options.is_some_and(|o| stopped(o).is_err()) {
            return None;
        }
        let next = self.used.checked_add(work)?;
        if next > MAX_PREPARATION_CACHE_WORK {
            return None;
        }
        self.used = next;
        Some(())
    }
    fn bytes(&mut self, bytes: usize) -> Option<usize> {
        if bytes > MAX_PREPARED_GENERATION_BYTES {
            return None;
        }
        self.take(1usize.checked_add(bytes / 64)?)?;
        Some(bytes)
    }
}
fn costs(values: impl IntoIterator<Item = usize>) -> Option<usize> {
    values.into_iter().try_fold(0usize, |total, n| {
        total
            .checked_add(n)
            .filter(|n| *n <= MAX_PREPARED_GENERATION_BYTES)
    })
}
fn slots<T>(capacity: usize, m: &mut Maintenance<'_>) -> Option<usize> {
    m.bytes(capacity.checked_mul(size_of::<T>())?)
}
fn vector_cost<T>(
    v: &Vec<T>,
    m: &mut Maintenance<'_>,
    mut item: impl FnMut(&T, &mut Maintenance<'_>) -> Option<usize>,
) -> Option<usize> {
    let mut bytes = slots::<T>(v.capacity(), m)?;
    for value in v {
        bytes = costs([bytes, item(value, m)?])?;
    }
    Some(bytes)
}
fn state_heap(e: &EntryState) -> usize {
    e.id.as_str()
        .len()
        .saturating_add(e.path.as_str().len())
        .saturating_add(e.revision.as_str().len())
}
fn state_work(e: &EntryState) -> usize {
    1usize.saturating_add(state_heap(e) / 64)
}
fn fact_heap(f: &FilePresentationFacts) -> usize {
    f.witness
        .entry_id
        .as_str()
        .len()
        .saturating_add(f.witness.revision.as_str().len())
}
fn fact_work(f: &FilePresentationFacts) -> usize {
    1usize.saturating_add(fact_heap(f) / 64)
}
fn property_heap(v: &PropertyValue, m: &mut Maintenance<'_>) -> Option<usize> {
    match v {
        PropertyValue::String(s) => m.bytes(s.capacity()),
        PropertyValue::Array(v) => vector_cost(v, m, property_heap),
        PropertyValue::Object(v) => vector_cost(v, m, |(k, v), m| {
            costs([m.bytes(k.capacity())?, property_heap(v, m)?])
        }),
        _ => m.bytes(0),
    }
}
fn record_heap(r: &IndexRecord, m: &mut Maintenance<'_>) -> Option<usize> {
    let bytes = m.bytes(costs([
        state_heap(r.witness().entry()),
        r.witness().source().local_store_id().as_str().len(),
        r.witness().source().watermark().as_str().len(),
    ])?)?;
    let Some(d) = r.metadata() else {
        return Some(bytes);
    };
    costs([
        bytes,
        m.bytes(d.dialect_version.capacity())?,
        m.bytes(
            d.entry_id
                .as_str()
                .len()
                .saturating_add(d.content_revision.as_str().len()),
        )?,
        vector_cost(&d.properties, m, |p, m| {
            costs([m.bytes(p.key.capacity())?, property_heap(&p.value, m)?])
        })?,
        vector_cost(&d.aliases, m, |s, m| m.bytes(s.capacity()))?,
        vector_cost(&d.tags, m, |s, m| m.bytes(s.capacity()))?,
        vector_cost(&d.tag_occurrences, m, |t, m| m.bytes(t.name.capacity()))?,
        vector_cost(&d.headings, m, |h, m| m.bytes(h.text.capacity()))?,
        vector_cost(&d.links, m, |l, m| {
            m.bytes(costs([
                l.target.capacity(),
                l.fragment.capacity(),
                l.destination.capacity(),
            ])?)
        })?,
        vector_cost(&d.tasks, m, |t, m| {
            m.bytes(t.status.capacity().saturating_add(t.text.capacity()))
        })?,
        slots::<zorid_document::Diagnostic>(d.diagnostics.capacity(), m)?,
    ])
}
fn record_row_heap(r: &DetachedRecord, m: &mut Maintenance<'_>) -> Option<usize> {
    costs([
        m.bytes(r.path.capacity())?,
        m.bytes(r.witness.as_ref().map_or(0, |w| {
            w.entry_id
                .as_str()
                .len()
                .saturating_add(w.revision.as_str().len())
        }))?,
        vector_cost(&r.properties, m, |(k, v), m| {
            costs([m.bytes(k.capacity())?, property_heap(v, m)?])
        })?,
        vector_cost(&r.property_types, m, |(k, _), m| m.bytes(k.capacity()))?,
        vector_cost(&r.tags, m, |s, m| m.bytes(s.capacity()))?,
    ])
}
fn prepared_bytes(p: &PreparedBaseGeneration, m: &mut Maintenance<'_>) -> Option<usize> {
    costs([
        m.bytes(
            size_of::<PreparedBaseGeneration>()
                .saturating_add(2usize.saturating_mul(size_of::<usize>())),
        )?,
        vector_cost(&p.snapshot.records, m, record_row_heap)?,
        m.bytes(
            p.snapshot
                .relationships
                .as_ref()
                .map_or(0, |g| g.retained_bytes()),
        )?,
        vector_cost(&p.snapshot.metadata_issues, m, |i, m| {
            costs([
                m.bytes(
                    i.witness
                        .entry_id
                        .as_str()
                        .len()
                        .saturating_add(i.witness.revision.as_str().len()),
                )?,
                slots::<zorid_document::Diagnostic>(i.diagnostics.capacity(), m)?,
            ])
        })?,
        p.query
            .relationships
            .as_ref()
            .map_or(Some(0), |g| g.retained_bytes(&mut |work| m.take(work)))?,
        vector_cost(&p.query.available, m, |s, m| m.bytes(s.capacity()))?,
        m.bytes(snapshot_id_heap(&p.snapshot.snapshot_id))?,
    ])
}
fn snapshot_id_heap(id: &IndexSnapshotId) -> usize {
    [
        id.local_store_id().as_str().len(),
        id.generation_epoch().as_str().len(),
        id.versions().extraction().len(),
        id.versions().resolver().len(),
        id.versions().query().len(),
    ]
    .into_iter()
    .fold(0, usize::saturating_add)
}
fn program_bytes(p: &BaseProgram, m: &mut Maintenance<'_>) -> Option<usize> {
    fn filter(f: &program::Filter, m: &mut Maintenance<'_>) -> Option<usize> {
        match f {
            program::Filter::Expression(s) => m.bytes(s.capacity()),
            program::Filter::And(v) | program::Filter::Or(v) | program::Filter::Not(v) => {
                vector_cost(v, m, filter)
            }
        }
    }
    fn value(v: &crate::BaseValue, m: &mut Maintenance<'_>) -> Option<usize> {
        match v {
            crate::BaseValue::String { value } | crate::BaseValue::File { path: value } => {
                m.bytes(value.capacity())
            }
            crate::BaseValue::List { value: v } => vector_cost(v, m, value),
            crate::BaseValue::Object { value: v } => vector_cost(v, m, |(k, v), m| {
                costs([m.bytes(k.capacity())?, value(v, m)?])
            }),
            crate::BaseValue::Link {
                path,
                target,
                display,
                ..
            } => m.bytes(costs([
                path.capacity(),
                target.as_ref().map_or(0, |w| {
                    w.entry_id
                        .as_str()
                        .len()
                        .saturating_add(w.revision.as_str().len())
                }),
                display.as_ref().map_or(0, String::capacity),
            ])?),
            crate::BaseValue::Error { code, message } => {
                m.bytes(code.capacity().saturating_add(message.capacity()))
            }
            _ => m.bytes(0),
        }
    }
    costs([
        m.bytes(
            size_of::<BaseProgram>().saturating_add(2usize.saturating_mul(size_of::<usize>())),
        )?,
        property_heap(&p.configuration, m)?,
        vector_cost(&p.formulas, m, |(k, v), m| {
            m.bytes(k.capacity().saturating_add(v.capacity()))
        })?,
        p.filter.as_ref().map_or(Some(0), |f| filter(f, m))?,
        vector_cost(&p.views, m, |v, m| {
            costs([
                property_heap(&v.configuration, m)?,
                v.filter.as_ref().map_or(Some(0), |f| filter(f, m))?,
                vector_cost(&v.order, m, |s, m| m.bytes(s.capacity()))?,
                vector_cost(&v.sort, m, |s, m| m.bytes(s.property.capacity()))?,
                v.group
                    .as_ref()
                    .map_or(Some(0), |s| m.bytes(s.property.capacity()))?,
                v.group_order
                    .as_ref()
                    .map_or(Some(0), |v| vector_cost(v, m, value))?,
            ])
        })?,
    ])
}

#[cfg(test)]
#[path = "preparation_tests.rs"]
mod tests;
