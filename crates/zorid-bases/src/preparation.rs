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
const MAX_PREPARED_ANSWERS: usize = 16;
const MAX_PREPARED_ANSWER_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREPARED_ANSWER_ENTRY_BYTES: usize = 1024 * 1024;
// Arc allocation identity is private and live as long as any stale lookup can
// exist. Clear/owner recreation therefore cannot reuse a claimed numeric ID.
#[derive(Clone)]
struct LookupIdentity {
    owner: Arc<()>,
    dependency: Arc<()>,
}
const TOKEN_BYTES: usize = 64;

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
    identity: Option<LookupIdentity>,
}
impl<T> PreparationLookup<T> {
    pub fn into_value(self) -> T {
        self.value
    }
    pub fn value(&self) -> &T {
        &self.value
    }
    pub fn outcome(&self) -> PreparationCacheOutcome {
        self.outcome
    }
    /// Semantic charge against max_steps. An answer hit retains the seed's
    /// evaluation-only charge plus the fresh preparation charge; it does not
    /// claim that the avoided evaluator actually ran. Optional probe/copy
    /// units remain separate in cache_work_used (also not a CPU-time measure).
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
    token: Arc<()>,
    proof: GenerationProof,
    value: Arc<PreparedBaseGeneration>,
    bytes: usize,
    touched: u64,
}
struct ProgramEntry {
    token: Arc<()>,
    clock_independent: bool,
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
struct AnswerEntry {
    program: Arc<()>,
    generation: Arc<()>,
    options: QueryOptions,
    clock_independent: bool,
    result: BaseQueryResult,
    encoded_base_bytes: usize,
    evaluation_work: usize,
    avoided_work: usize,
    key_work: usize,
    copy_work: usize,
    bytes: usize,
    touched: u64,
}
pub struct BasePreparationCache {
    owner: Arc<()>,
    answers: VecDeque<AnswerEntry>,
    generations: VecDeque<GenerationEntry>,
    programs: VecDeque<ProgramEntry>,
    last_clock: Option<u64>,
}
impl Default for BasePreparationCache {
    fn default() -> Self {
        Self {
            owner: Arc::new(()),
            answers: VecDeque::with_capacity(MAX_PREPARED_ANSWERS),
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
        self.owner = Arc::new(());
        self.answers.clear();
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
        self.answers
            .retain(|e| now.saturating_sub(e.touched) < PREPARATION_IDLE_MS);
        self.prune_answers();
    }
    fn prune_answers(&mut self) {
        let programs = &self.programs;
        let generations = &self.generations;
        self.answers.retain(|answer| {
            programs
                .iter()
                .any(|p| Arc::ptr_eq(&p.token, &answer.program))
                && generations
                    .iter()
                    .any(|g| Arc::ptr_eq(&g.token, &answer.generation))
        });
    }
    fn identity(&self, dependency: &Arc<()>) -> LookupIdentity {
        LookupIdentity {
            owner: Arc::clone(&self.owner),
            dependency: Arc::clone(dependency),
        }
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
        if let Some(index) = self.programs.iter().rposition(|e| {
            maintenance.bytes(e.source.len()).is_some()
                && e.version == program::BASE_COMPILER_VERSION
                && e.source == source
        }) {
            let mut entry = self.programs.remove(index).expect("found");
            entry.touched = monotonic_ms;
            let value = Arc::clone(&entry.value);
            let identity = Some(self.identity(&entry.token));
            self.programs.push_back(entry);
            return Ok(PreparationLookup {
                value,
                outcome: PreparationCacheOutcome::Hit,
                work_used: 0,
                cache_work: maintenance.used,
                identity,
            });
        }
        let value = Arc::new(crate::compile_base_source(source)?);
        let bytes = maintenance
            .bytes(source.len())
            .and_then(|_| program_bytes(&value, &mut maintenance))
            .and_then(|n| n.checked_add(source.len()))
            .and_then(|n| n.checked_add(TOKEN_BYTES));
        let overhead = size_of::<Self>()
            .saturating_add(TOKEN_BYTES)
            .saturating_add(
                self.programs
                    .capacity()
                    .saturating_mul(size_of::<ProgramEntry>()),
            );
        let mut identity = None;
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
            let token = Arc::new(());
            identity = Some(self.identity(&token));
            let clock_independent =
                program::clock_independent(&value, &mut |work| maintenance.take(work));
            self.programs.push_back(ProgramEntry {
                token,
                clock_independent,
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
        self.prune_answers();
        Ok(PreparationLookup {
            value,
            outcome,
            identity,
            work_used: 0,
            cache_work: maintenance.used,
        })
    }
    /// Optional complete-answer reuse over the same independently admitted
    /// immutable inputs. This never admits a pin/source or caches a response
    /// wrapper. Hosts must perform their existing final freshness check.
    pub fn query_prepared_cached(
        &mut self,
        program: &PreparationLookup<Arc<BaseProgram>>,
        preparation: &PreparationLookup<Arc<PreparedBaseGeneration>>,
        options: &QueryOptions,
        monotonic_ms: u64,
    ) -> Result<PreparationLookup<BaseQueryResult>, ExpressionDiagnostic> {
        limits(options)?;
        self.expire(monotonic_ms);
        let mut invocation = options.clone();
        invocation.max_steps = invocation
            .max_steps
            .checked_sub(preparation.work_used)
            .ok_or_else(|| {
                ExpressionDiagnostic::new("budget", "Preparation exceeds current query work budget")
            })?;
        let validated = query::validate_invocation(
            &program.value,
            &preparation.value.snapshot,
            &invocation,
            Some(&preparation.value.query),
        )?;
        let mut maintenance = Maintenance::new(Some(options));
        maintenance.used = preparation.cache_work.min(MAX_PREPARATION_CACHE_WORK);
        let answer_start = maintenance.used;
        let dependencies = (|| {
            maintenance.take(1)?;
            let p = program.identity.as_ref()?;
            let g = preparation.identity.as_ref()?;
            if !Arc::ptr_eq(&p.owner, &self.owner) || !Arc::ptr_eq(&g.owner, &self.owner) {
                return None;
            }
            let mut compiled = None;
            for entry in self.programs.iter().rev() {
                maintenance.take(1)?;
                if Arc::ptr_eq(&entry.token, &p.dependency)
                    && Arc::ptr_eq(&entry.value, &program.value)
                {
                    compiled = Some(entry);
                    break;
                }
            }
            let compiled = compiled?;
            let mut generation_live = false;
            for entry in self.generations.iter().rev() {
                maintenance.take(1)?;
                if Arc::ptr_eq(&entry.token, &g.dependency)
                    && Arc::ptr_eq(&entry.value, &preparation.value)
                {
                    generation_live = true;
                    break;
                }
            }
            generation_live.then(|| {
                (
                    Arc::clone(&p.dependency),
                    Arc::clone(&g.dependency),
                    compiled.clock_independent,
                )
            })
        })();
        stopped(options)?;
        // Invalid clocks/timezones still flow through the evaluator (including
        // its established empty/ignored-row behavior and diagnostic ordering).
        let time_valid = dependencies.is_some()
            && maintenance
                .take(1usize.saturating_add(options.evaluation.timezone.len() / 64))
                .is_some()
            && answer_clock_representable(options.evaluation.clock_ms)
            && crate::expression::BasesTimezone::from_setting(Some(&options.evaluation.timezone))
                .is_ok();
        stopped(options)?;
        if let Some((p, g, _)) = &dependencies {
            if time_valid {
                for index in (0..self.answers.len()).rev() {
                    if maintenance.take(1).is_none() {
                        break;
                    }
                    let answer = &self.answers[index];
                    if !Arc::ptr_eq(&answer.program, p) || !Arc::ptr_eq(&answer.generation, g) {
                        continue;
                    }
                    let planned = maintenance
                        .used
                        .saturating_sub(answer_start)
                        .checked_add(answer.key_work)
                        .and_then(|n| n.checked_add(answer.copy_work));
                    let Some(_hit_work) = planned.filter(|n| *n <= answer.avoided_work) else {
                        continue;
                    };
                    if answer
                        .evaluation_work
                        .checked_add(preparation.work_used)
                        .is_none_or(|n| n > options.max_steps)
                        || !maintenance.can_take(answer.key_work.saturating_add(answer.copy_work))
                    {
                        continue;
                    }
                    if maintenance.take(answer.key_work).is_none() {
                        stopped(options)?;
                        break;
                    }
                    stopped(options)?;
                    if !options_exact(&answer.options, options, answer.clock_independent) {
                        continue;
                    }
                    // Scheduling advice is recomputed from this invocation,
                    // independently of the conservative answer-reuse proof.
                    // The sealed cold dependency includes runtime duration sort.
                    let dependency = answer.result.refresh_hint.as_ref().map_or_else(
                        || program.value.refresh_dependency(options.view_index),
                        |hint| hint.dependency,
                    );
                    let fresh_hint =
                        match query::refresh_hint_checked(dependency, &options.evaluation, |work| {
                            stopped(options)?;
                            maintenance.take(work).ok_or_else(|| {
                                ExpressionDiagnostic::new(
                                    "budget",
                                    "Refresh hint cache work budget",
                                )
                            })
                        }) {
                            Ok(hint) => hint,
                            Err(error) if error.code == "cancelled" => return Err(error),
                            Err(_) => break,
                        };
                    let compare_bytes = fresh_hint
                        .as_ref()
                        .map_or(0, |h| h.timezone.len())
                        .saturating_add(
                            answer
                                .result
                                .refresh_hint
                                .as_ref()
                                .map_or(0, |h| h.timezone.len()),
                        );
                    if maintenance
                        .take(1usize.saturating_add(compare_bytes / 64))
                        .is_none()
                    {
                        break;
                    }
                    if fresh_hint != answer.result.refresh_hint {
                        // The cached byte-size proof includes the old hint.
                        // A changed hint falls back to a complete cold query;
                        // never reuse an unproved encoded output bound.
                        continue;
                    }
                    drop(fresh_hint); // Equal current advice; avoid a duplicate during result copy.
                    let actual_probe = maintenance.used.saturating_sub(answer_start);
                    if actual_probe
                        .checked_add(answer.copy_work)
                        .is_none_or(|work| work > answer.avoided_work)
                        || !maintenance.can_take(answer.copy_work)
                    {
                        continue;
                    }
                    // Keep the cold evaluation-only semantic charge for ceiling
                    // admission. Actual optional hit work is separate below;
                    // steps_used is not a claim of executed CPU work.
                    let steps = preparation
                        .work_used
                        .checked_add(answer.evaluation_work)
                        .ok_or_else(|| {
                            ExpressionDiagnostic::new(
                                "budget",
                                "Answer hit exceeds query work budget",
                            )
                        })?;
                    let encoded = answer
                        .encoded_base_bytes
                        .checked_add(decimal_bytes(steps))
                        .filter(|n| *n <= options.max_output_bytes)
                        .ok_or_else(|| {
                            ExpressionDiagnostic::new("budget", "Base encoded byte budget exceeded")
                        })?;
                    let _ = encoded;
                    if maintenance.take(answer.copy_work).is_none() {
                        stopped(options)?;
                        break;
                    }
                    let mut result = copy_result(&answer.result, options)?;
                    result.steps_used = steps;
                    stopped(options)?;
                    let mut answer = self.answers.remove(index).expect("found");
                    answer.touched = monotonic_ms;
                    self.answers.push_back(answer);
                    return Ok(PreparationLookup {
                        value: result,
                        outcome: PreparationCacheOutcome::Hit,
                        work_used: steps,
                        cache_work: maintenance.used,
                        identity: None,
                    });
                }
            }
        }
        stopped(options)?;
        // Failed optional probes never spend the cold semantic work budget.
        let mut clock_sensitive_sort = false;
        let mut result = query::query_base_validated(
            &program.value,
            &preparation.value.snapshot,
            &invocation,
            Some(&preparation.value.query),
            &validated,
            &mut clock_sensitive_sort,
        )?;
        let evaluation_work = result.steps_used;
        result.steps_used = result.steps_used.saturating_add(preparation.work_used);
        let encoded = crate::encoded_size(&result, options.max_output_bytes)?;
        stopped(options)?;
        let retained = (|| {
            let (p, g, static_program) = dependencies?;
            if !time_valid {
                return None;
            }
            let independent = static_program
                && !clock_sensitive_sort
                && options.evaluation.formulas.iter().all(|(_, source)| {
                    crate::expression::clock_independent(source, &mut |work| maintenance.take(work))
                });
            let before = maintenance.used;
            let key_bytes = options_heap(options, &mut maintenance)?;
            let key_work = maintenance.used - before;
            let before = maintenance.used;
            let slack_before = maintenance.slack_work;
            let result_bytes = result_heap(&result, &mut maintenance)?;
            let copy_work = maintenance.used - before;
            // The cold evaluator must construct the same initialized output.
            // Exclude every measured unused-capacity block from this lower
            // bound; no unoccupied source capacity is credited as avoided work.
            let construction_work =
                copy_work.checked_sub(maintenance.slack_work.checked_sub(slack_before)?)?;
            let avoided_work = evaluation_work.checked_add(construction_work)?;
            let bytes = key_bytes
                .checked_add(result_bytes)?
                .checked_add(size_of::<AnswerEntry>())?
                .checked_add(TOKEN_BYTES.checked_mul(2)?)?;
            if bytes > MAX_PREPARED_ANSWER_ENTRY_BYTES
                || key_work.checked_add(copy_work)?.checked_add(1)? > avoided_work
            {
                return None;
            }
            let copy = key_work.checked_add(copy_work)?;
            maintenance.take(copy)?; // Whole key+answer memory/work admitted first.
            Some((p, g, independent, bytes, key_work, copy_work, avoided_work))
        })();
        stopped(options)?;
        let outcome =
            if let Some((p, g, independent, bytes, key_work, copy_work, avoided_work)) = retained {
                let key = copy_options(options, independent)?;
                let mut stored = copy_result(&result, options)?;
                stored.steps_used = 0;
                let overhead = size_of::<Self>()
                    .saturating_add(
                        self.answers
                            .capacity()
                            .saturating_mul(size_of::<AnswerEntry>()),
                    )
                    .saturating_add(TOKEN_BYTES);
                while self.answers.len() >= MAX_PREPARED_ANSWERS
                    || self
                        .answers
                        .iter()
                        .map(|a| a.bytes)
                        .fold(0usize, usize::saturating_add)
                        .saturating_add(bytes)
                        .saturating_add(overhead)
                        > MAX_PREPARED_ANSWER_BYTES
                {
                    self.answers.pop_front();
                }
                stopped(options)?;
                self.answers.push_back(AnswerEntry {
                    program: p,
                    generation: g,
                    options: key,
                    clock_independent: independent,
                    result: stored,
                    evaluation_work,
                    avoided_work,
                    key_work,
                    copy_work,
                    bytes,
                    touched: monotonic_ms,
                    encoded_base_bytes: encoded.saturating_sub(decimal_bytes(result.steps_used)),
                });
                PreparationCacheOutcome::Miss
            } else {
                PreparationCacheOutcome::Uncached
            };
        if let Err(error) = stopped(options) {
            // A cancellation observed after optional insertion cannot leave an
            // answer seeded by an invocation that returned an error.
            if outcome == PreparationCacheOutcome::Miss {
                self.answers.pop_back();
            }
            return Err(error);
        }
        let work_used = result.steps_used;
        Ok(PreparationLookup {
            value: result,
            outcome,
            work_used,
            cache_work: maintenance.used,
            identity: None,
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
                    if !actual
                        .next()
                        .is_some_and(|actual| record_exact(actual, saved, options))
                    {
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
                let identity = Some(self.identity(&entry.token));
                self.generations.push_back(entry);
                return Ok(PreparationLookup {
                    value,
                    outcome: PreparationCacheOutcome::Hit,
                    work_used,
                    cache_work: maintenance.used,
                    identity,
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
        let overhead = size_of::<Self>()
            .saturating_add(TOKEN_BYTES)
            .saturating_add(
                self.generations
                    .capacity()
                    .saturating_mul(size_of::<GenerationEntry>()),
            );
        let minimum = preparation_minimum_bytes(&value, generation, facts, overhead);
        let retained = minimum
            .filter(|n| *n <= MAX_PREPARED_GENERATION_BYTES)
            .and_then(|_| prepared_bytes(&value, &mut maintenance))
            .and_then(|bytes| {
                let allowance = MAX_PREPARED_GENERATION_BYTES
                    .checked_sub(bytes.checked_add(overhead)?.checked_add(TOKEN_BYTES)?)?;
                let proof = GenerationProof::new(
                    generation,
                    facts,
                    value.snapshot.records.len(),
                    &mut maintenance,
                    allowance,
                )?;
                Some((
                    bytes
                        .checked_add(proof.retained_bytes())?
                        .checked_add(TOKEN_BYTES)?,
                    proof,
                ))
            });
        stopped(options)?;
        let mut identity = None;
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
            let token = Arc::new(());
            identity = Some(self.identity(&token));
            self.generations.push_back(GenerationEntry {
                token,
                proof,
                value: Arc::clone(&value),
                bytes,
                touched: monotonic_ms,
            });
            PreparationCacheOutcome::Miss
        } else {
            PreparationCacheOutcome::Uncached
        };
        self.prune_answers();
        Ok(PreparationLookup {
            value,
            outcome,
            identity,
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
    fn fixed_bytes(
        generation: &Generation,
        facts: &[FilePresentationFacts],
        record_count: usize,
    ) -> Option<usize> {
        let count = generation.manifest().entries().len();
        costs([
            size_of::<Self>(),
            count.checked_mul(size_of::<EntryState>())?,
            record_count.checked_mul(size_of::<IndexRecord>())?,
            facts
                .len()
                .checked_mul(size_of::<FilePresentationFacts>())?,
            // Preserve the existing manifest-sized bookkeeping allocation.
            count.checked_mul(size_of::<usize>())?,
            snapshot_id_heap(generation.id()),
            generation
                .manifest()
                .source()
                .local_store_id()
                .as_str()
                .len(),
            generation.manifest().source().watermark().as_str().len(),
        ])
    }
    fn new(
        generation: &Generation,
        facts: &[FilePresentationFacts],
        record_count: usize,
        maintenance: &mut Maintenance<'_>,
        allowance: usize,
    ) -> Option<Self> {
        // Only a bounded bookkeeping vector is allocated during measurement.
        // No authority-derived entries, facts or metadata are cloned until the
        // complete structure/copy costs and all retained bytes are admitted.
        let count = generation.manifest().entries().len();
        maintenance.take(1)?;
        // The sealed snapshot already knows its exact record count. Admit all
        // fixed proof buffers before allocating bookkeeping or walking metadata;
        // manifest entries may additionally contain folders without records.
        let fixed_bytes = Self::fixed_bytes(generation, facts, record_count)?;
        let heap_allowance = allowance.checked_sub(fixed_bytes)?;
        slots::<usize>(count, maintenance)?;
        let mut record_work = Vec::with_capacity(count);
        let mut heap_bytes = 0usize;
        for record in generation.records() {
            if record_work.len() >= record_count {
                return None;
            }
            let before = maintenance.used;
            let heap = record_heap(record, maintenance)?;
            heap_bytes = costs([heap_bytes, heap])?;
            if heap_bytes > heap_allowance {
                return None;
            }
            record_work.push(maintenance.used - before);
        }
        if record_work.len() != record_count {
            return None;
        }
        let mut compare_work = record_work
            .iter()
            .copied()
            .fold(0usize, usize::saturating_add);
        for entry in generation.manifest().entries() {
            maintenance.take(state_work(entry))?;
            heap_bytes = costs([heap_bytes, state_heap(entry)])?;
            if heap_bytes > heap_allowance {
                return None;
            }
            compare_work = compare_work.checked_add(state_work(entry))?;
        }
        for fact in facts {
            maintenance.take(fact_work(fact))?;
            heap_bytes = costs([heap_bytes, fact_heap(fact)])?;
            if heap_bytes > heap_allowance {
                return None;
            }
            compare_work = compare_work.checked_add(fact_work(fact))?;
        }
        // Count each fixed allocation once, retaining the final actual-capacity
        // check before any proof entries/records/facts are copied.
        let fixed = costs([
            fixed_bytes.checked_sub(count.checked_mul(size_of::<usize>())?)?,
            record_work.capacity().checked_mul(size_of::<usize>())?,
            heap_bytes,
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
    slack_work: usize,
}
impl<'a> Maintenance<'a> {
    fn new(options: Option<&'a QueryOptions>) -> Self {
        Self {
            options,
            used: 0,
            slack_work: 0,
        }
    }
    fn retained(&mut self, capacity: usize, initialized: usize) -> Option<usize> {
        capacity.checked_sub(initialized)?;
        let bytes = self.bytes(capacity)?;
        self.slack_work = self
            .slack_work
            .checked_add(capacity / 64 - initialized / 64)?;
        Some(bytes)
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
    let mut bytes = m.retained(
        v.capacity().checked_mul(size_of::<T>())?,
        v.len().checked_mul(size_of::<T>())?,
    )?;
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
        PropertyValue::String(s) => m.retained(s.capacity(), s.len()),
        PropertyValue::Array(v) => vector_cost(v, m, property_heap),
        PropertyValue::Object(v) => vector_cost(v, m, |(k, v), m| {
            costs([m.retained(k.capacity(), k.len())?, property_heap(v, m)?])
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
        slots::<zorid_document::MarkdownBlock>(d.blocks.capacity(), m)?,
        vector_cost(&d.list_items, m, |item, m| {
            m.bytes(item.task_status.as_ref().map_or(0, String::capacity))
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
fn preparation_minimum_bytes(
    p: &PreparedBaseGeneration,
    generation: &Generation,
    facts: &[FilePresentationFacts],
    overhead: usize,
) -> Option<usize> {
    // Includes the namespace once through the graph and real independent row /
    // proof buffers. This lower-bounds the full conservative admission charge,
    // not process RSS; omit unknown heap costs and still perform full admission.
    [
        overhead,
        TOKEN_BYTES,
        p.snapshot
            .relationships
            .as_ref()
            .map_or(0, |g| g.retained_bytes()),
        p.snapshot
            .records
            .capacity()
            .checked_mul(size_of::<DetachedRecord>())?,
        generation
            .manifest()
            .entries()
            .len()
            .checked_mul(size_of::<EntryState>())?,
        p.snapshot
            .records
            .len()
            .checked_mul(size_of::<IndexRecord>())?,
        generation
            .manifest()
            .entries()
            .len()
            .checked_mul(size_of::<usize>())?,
        facts
            .len()
            .checked_mul(size_of::<FilePresentationFacts>())?,
    ]
    .into_iter()
    .try_fold(0usize, usize::checked_add)
}
fn prepared_bytes(p: &PreparedBaseGeneration, m: &mut Maintenance<'_>) -> Option<usize> {
    let mut bytes = 0usize;
    // Check the running admitted size after each section, instead of eagerly
    // evaluating all heap walks in an array even after a preceding section fails.
    macro_rules! add {
        ($value:expr) => {
            bytes = costs([bytes, $value])?;
        };
    }
    add!(m.bytes(
        size_of::<PreparedBaseGeneration>()
            .saturating_add(2usize.saturating_mul(size_of::<usize>()))
    )?);
    add!(m.bytes(
        p.snapshot
            .relationships
            .as_ref()
            .map_or(0, |g| g.retained_bytes())
    )?);
    add!(vector_cost(&p.snapshot.records, m, record_row_heap)?);
    add!(vector_cost(&p.snapshot.metadata_issues, m, |i, m| costs(
        [
            m.bytes(
                i.witness
                    .entry_id
                    .as_str()
                    .len()
                    .saturating_add(i.witness.revision.as_str().len())
            )?,
            slots::<zorid_document::Diagnostic>(i.diagnostics.capacity(), m)?,
        ]
    ))?);
    add!(p.query.relationships.as_ref().map_or(Some(0), |g| {
        g.retained_additional_bytes(&mut |work| m.take(work))
    })?);
    add!(vector_cost(&p.query.available, m, |s, m| m.bytes(s.capacity()))?);
    add!(m.bytes(snapshot_id_heap(&p.snapshot.snapshot_id))?);
    Some(bytes)
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
        value_heap(v, m)
    }
    costs([
        m.bytes(
            size_of::<BaseProgram>().saturating_add(2usize.saturating_mul(size_of::<usize>())),
        )?,
        property_heap(&p.configuration, m)?,
        vector_cost(&p.formulas, m, |(k, v), m| {
            m.bytes(k.capacity().saturating_add(v.capacity()))
        })?,
        vector_cost(&p.summaries, m, |(key, source), m| {
            m.bytes(key.capacity().saturating_add(source.capacity()))
        })?,
        p.filter.as_ref().map_or(Some(0), |f| filter(f, m))?,
        vector_cost(&p.views, m, |v, m| {
            costs([
                property_heap(&v.configuration, m)?,
                v.filter.as_ref().map_or(Some(0), |f| filter(f, m))?,
                vector_cost(&v.order, m, |s, m| m.bytes(s.capacity()))?,
                vector_cost(&v.summaries, m, |(property, name), m| {
                    m.bytes(property.capacity().saturating_add(name.capacity()))
                })?,
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

// PropertyValue's derived equality uses Number equality, which deliberately
// equates floating -0/+0. Cache identities must preserve that distinction and
// integer/float representation; neither JSON coercion nor a claimed hash is a
// substitute for the exact ordered typed input.
fn property_exact_checked(
    a: &PropertyValue,
    b: &PropertyValue,
    check: &mut impl FnMut() -> bool,
) -> bool {
    if !check() {
        return false;
    }
    match (a, b) {
        (PropertyValue::Null, PropertyValue::Null) => true,
        (PropertyValue::Bool(a), PropertyValue::Bool(b)) => a == b,
        (PropertyValue::Number(a), PropertyValue::Number(b)) => {
            if a.is_f64() || b.is_f64() {
                a.is_f64() == b.is_f64()
                    && a.as_f64().map(f64::to_bits) == b.as_f64().map(f64::to_bits)
            } else {
                a == b
            }
        }
        (PropertyValue::String(a), PropertyValue::String(b)) => a == b,
        (PropertyValue::Array(a), PropertyValue::Array(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|(a, b)| property_exact_checked(a, b, check))
        }
        (PropertyValue::Object(a), PropertyValue::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((ak, a), (bk, b))| ak == bk && property_exact_checked(a, b, check))
        }
        _ => false,
    }
}
fn record_exact(a: &IndexRecord, b: &IndexRecord, options: &QueryOptions) -> bool {
    if a.witness() != b.witness()
        || a.text_digest() != b.text_digest()
        || a.text_bytes() != b.text_bytes()
        || a.exclusion() != b.exclusion()
    {
        return false;
    }
    match (a.metadata(), b.metadata()) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.schema_version == b.schema_version
                && a.dialect_version == b.dialect_version
                && a.entry_id == b.entry_id
                && a.content_revision == b.content_revision
                && a.source_length == b.source_length
                && a.frontmatter == b.frontmatter
                && a.properties.len() == b.properties.len()
                && a.properties.iter().zip(&b.properties).all(|(a, b)| {
                    a.key == b.key
                        && a.property_type == b.property_type
                        && a.key_range == b.key_range
                        && property_exact_checked(&a.value, &b.value, &mut || {
                            stopped(options).is_ok()
                        })
                })
                && a.aliases == b.aliases
                && a.tags == b.tags
                && a.tag_occurrences == b.tag_occurrences
                && a.headings == b.headings
                && a.links == b.links
                && a.tasks == b.tasks
                && a.blocks == b.blocks
                && a.list_items == b.list_items
                && a.diagnostics == b.diagnostics
        }
        _ => false,
    }
}
fn detached_exact(a: &DetachedRecord, b: &DetachedRecord, options: &QueryOptions) -> bool {
    a.witness == b.witness
        && a.path == b.path
        && a.properties.len() == b.properties.len()
        && a.properties
            .iter()
            .zip(&b.properties)
            .all(|((ak, a), (bk, b))| {
                ak == bk && property_exact_checked(a, b, &mut || stopped(options).is_ok())
            })
        && a.property_types == b.property_types
        && a.tags == b.tags
        && a.size == b.size
        && a.ctime_ms == b.ctime_ms
        && a.mtime_ms == b.mtime_ms
}
fn options_exact(a: &QueryOptions, b: &QueryOptions, independent: bool) -> bool {
    let options = b;
    a.view_index == b.view_index
        && a.search_terms == b.search_terms
        && a.ignore_paths == b.ignore_paths
        && a.current_entry_id == b.current_entry_id
        && a.summary_preview_property == b.summary_preview_property
        && a.summary_preview_group_key_id == b.summary_preview_group_key_id
        && a.max_steps == b.max_steps
        && a.max_scanned == b.max_scanned
        && a.max_rows == b.max_rows
        && a.max_groups == b.max_groups
        && a.max_output_bytes == b.max_output_bytes
        && (independent || a.evaluation.clock_ms == b.evaluation.clock_ms)
        && a.evaluation.random_seed == b.evaluation.random_seed
        && a.evaluation.timezone == b.evaluation.timezone
        && a.evaluation.max_steps == b.evaluation.max_steps
        && a.evaluation.formulas == b.evaluation.formulas
        && match (&a.evaluation.current_record, &b.evaluation.current_record) {
            (None, None) => true,
            (Some(a), Some(b)) => detached_exact(a, b, options),
            _ => false,
        }
}
fn options_heap(o: &QueryOptions, m: &mut Maintenance<'_>) -> Option<usize> {
    costs([
        m.bytes(size_of::<QueryOptions>())?,
        vector_cost(&o.search_terms, m, |s, m| m.bytes(s.capacity()))?,
        vector_cost(&o.ignore_paths, m, |s, m| m.bytes(s.capacity()))?,
        m.bytes(
            o.current_entry_id
                .as_ref()
                .map_or(0, |id| id.as_str().len()),
        )?,
        m.bytes(
            o.summary_preview_property
                .as_ref()
                .map_or(0, String::capacity),
        )?,
        m.bytes(
            o.summary_preview_group_key_id
                .as_ref()
                .map_or(0, String::capacity),
        )?,
        m.bytes(o.evaluation.timezone.capacity())?,
        vector_cost(&o.evaluation.formulas, m, |(k, v), m| {
            m.bytes(k.capacity().saturating_add(v.capacity()))
        })?,
        o.evaluation
            .current_record
            .as_ref()
            .map_or(Some(0), |r| record_row_heap(r, m))?,
    ])
}
fn value_heap(v: &crate::BaseValue, m: &mut Maintenance<'_>) -> Option<usize> {
    use crate::BaseValue as V;
    match v {
        V::Error { .. } => None,
        V::Number { value } if !value.is_finite() => None,
        V::Duration {
            years,
            months,
            weeks,
            days,
            hours,
            minutes,
            seconds,
            milliseconds,
        } if ![
            years,
            months,
            weeks,
            days,
            hours,
            minutes,
            seconds,
            milliseconds,
        ]
        .into_iter()
        .all(|v| v.is_finite()) =>
        {
            None
        }
        V::String { value }
        | V::Html { value }
        | V::Image { value }
        | V::Icon { value }
        | V::File { path: value } => m.retained(value.capacity(), value.len()),
        V::List { value } => vector_cost(value, m, value_heap),
        V::Object { value } => vector_cost(value, m, |(k, v), m| {
            costs([m.retained(k.capacity(), k.len())?, value_heap(v, m)?])
        }),
        V::Link {
            path,
            target,
            display,
            display_value,
            ..
        } => {
            let own = m.retained(
                costs([
                    path.capacity(),
                    target.as_ref().map_or(0, |w| {
                        w.entry_id
                            .as_str()
                            .len()
                            .saturating_add(w.revision.as_str().len())
                    }),
                    display.as_ref().map_or(0, String::capacity),
                ])?,
                costs([
                    path.len(),
                    target.as_ref().map_or(0, |w| {
                        w.entry_id
                            .as_str()
                            .len()
                            .saturating_add(w.revision.as_str().len())
                    }),
                    display.as_ref().map_or(0, String::len),
                ])?,
            )?;
            let nested = display_value.as_ref().map_or(Some(0), |value| {
                costs([
                    m.bytes(size_of::<crate::BaseValue>())?,
                    value_heap(value, m)?,
                ])
            })?;
            costs([own, nested])
        }
        _ => m.bytes(0),
    }
}
fn summary_heap(
    values: &std::collections::BTreeMap<String, crate::BaseValue>,
    m: &mut Maintenance<'_>,
) -> Option<usize> {
    if values.is_empty() {
        return Some(0);
    }
    let cell = size_of::<(String, crate::BaseValue)>().checked_add(size_of::<usize>())?;
    let mut bytes = values
        .len()
        .checked_mul(16)?
        .checked_mul(cell)?
        .checked_add(64)?;
    m.bytes(values.len().checked_mul(cell)?)?;
    for (key, value) in values {
        bytes = costs([
            bytes,
            m.retained(key.capacity(), key.len())?,
            value_heap(value, m)?,
        ])?;
    }
    Some(bytes)
}
fn result_heap(r: &BaseQueryResult, m: &mut Maintenance<'_>) -> Option<usize> {
    // Derived values intentionally bypass answers until settings/derived maps
    // have their own exact cache key proof.
    if !r.metadata_complete
        || !r.relationships_available
        || !r.diagnostics.is_empty()
        || r.relation_targets.is_some()
        || !r.property_definition_diagnostics.is_empty()
    {
        return None;
    }
    costs([
        m.bytes(size_of::<BaseQueryResult>())?,
        m.bytes(snapshot_id_heap(&r.snapshot_id))?,
        r.refresh_hint.as_ref().map_or(Some(0), |hint| {
            m.retained(hint.timezone.capacity(), hint.timezone.len())
        })?,
        property_heap(&r.view, m)?,
        summary_heap(&r.summaries, m)?,
        r.summary_previews
            .as_ref()
            .map_or(Some(0), |values| summary_heap(values, m))?,
        vector_cost(&r.rows, m, |r, m| {
            // std's current BTreeMap uses <=16 cells per node. Charge one full
            // node per entry conservatively rather than pretending len is its
            // allocation capacity. Work counts initialized entries, not unused
            // node slots. Cache policy is disposable, never authority evidence.
            let cell = size_of::<(String, crate::BaseValue)>().checked_add(size_of::<usize>())?;
            let nodes = r
                .values
                .len()
                .checked_mul(16)?
                .checked_mul(cell)?
                .checked_add(64)?;
            m.bytes(r.values.len().checked_mul(cell)?)?;
            let mut bytes = costs([
                nodes,
                summary_heap(&r.edit_values, m)?,
                m.retained(
                    r.entry_id
                        .as_str()
                        .len()
                        .saturating_add(r.revision.as_str().len())
                        .saturating_add(r.path.capacity()),
                    r.entry_id
                        .as_str()
                        .len()
                        .saturating_add(r.revision.as_str().len())
                        .saturating_add(r.path.len()),
                )?,
            ])?;
            for (key, value) in &r.values {
                bytes = costs([
                    bytes,
                    m.retained(key.capacity(), key.len())?,
                    value_heap(value, m)?,
                ])?;
            }
            Some(bytes)
        })?,
        vector_cost(&r.groups, m, |g, m| {
            costs([
                m.retained(
                    g.key_id.as_ref().map_or(0, String::capacity),
                    g.key_id.as_ref().map_or(0, String::len),
                )?,
                g.key.as_ref().map_or(Some(0), |v| value_heap(v, m))?,
                summary_heap(&g.summaries, m)?,
                vector_cost(&g.entry_ids, m, |id, m| m.bytes(id.as_str().len()))?,
            ])
        })?,
        vector_cost(&r.group_options, m, |g, m| {
            costs([
                m.retained(g.key_id.capacity(), g.key_id.len())?,
                value_heap(&g.key, m)?,
            ])
        })?,
        vector_cost(&r.properties, m, |s, m| m.retained(s.capacity(), s.len()))?,
        vector_cost(&r.available_properties, m, |s, m| {
            m.retained(s.capacity(), s.len())
        })?,
        m.retained(
            r.diagnostics
                .capacity()
                .checked_mul(size_of::<crate::QueryDiagnostic>())?,
            r.diagnostics
                .len()
                .checked_mul(size_of::<crate::QueryDiagnostic>())?,
        )?,
        vector_cost(&r.metadata_issues, m, |issue, m| {
            m.take(1)?;
            if !matches!(issue.exclusion, Some(zorid_index::Exclusion::Binary))
                || issue.properties_unavailable
                || !issue.diagnostics.is_empty()
            {
                return None;
            }
            costs([
                m.bytes(
                    issue
                        .witness
                        .entry_id
                        .as_str()
                        .len()
                        .saturating_add(issue.witness.revision.as_str().len()),
                )?,
                m.retained(
                    issue
                        .diagnostics
                        .capacity()
                        .checked_mul(size_of::<zorid_document::Diagnostic>())?,
                    issue
                        .diagnostics
                        .len()
                        .checked_mul(size_of::<zorid_document::Diagnostic>())?,
                )?,
            ])
        })?,
    ])
}

// Result's fallible iterator adapter has a zero lower size_hint on Rust1.99;
// collect can grow cap1 to cap4. Allocate the preadmitted exact destination
// length instead, so every retained Vec capacity stays <= its measured source.
fn copy_vec<T, U>(
    source: &[T],
    options: &QueryOptions,
    mut copy: impl FnMut(&T) -> Result<U, ExpressionDiagnostic>,
) -> Result<Vec<U>, ExpressionDiagnostic> {
    stopped(options)?;
    let mut out = Vec::with_capacity(source.len());
    for value in source {
        stopped(options)?;
        out.push(copy(value)?);
    }
    Ok(out)
}
fn copy_property(
    v: &PropertyValue,
    options: &QueryOptions,
) -> Result<PropertyValue, ExpressionDiagnostic> {
    stopped(options)?;
    Ok(match v {
        PropertyValue::Array(v) => {
            PropertyValue::Array(copy_vec(v, options, |v| copy_property(v, options))?)
        }
        PropertyValue::Object(v) => PropertyValue::Object(copy_vec(v, options, |(k, v)| {
            Ok((k.clone(), copy_property(v, options)?))
        })?),
        _ => v.clone(),
    })
}
fn copy_value(
    v: &crate::BaseValue,
    options: &QueryOptions,
) -> Result<crate::BaseValue, ExpressionDiagnostic> {
    stopped(options)?;
    Ok(match v {
        crate::BaseValue::List { value } => crate::BaseValue::List {
            value: copy_vec(value, options, |v| copy_value(v, options))?,
        },
        crate::BaseValue::Object { value } => crate::BaseValue::Object {
            value: copy_vec(value, options, |(k, v)| {
                Ok((k.clone(), copy_value(v, options)?))
            })?,
        },
        crate::BaseValue::Link {
            path,
            target,
            display,
            display_value,
            external,
        } => crate::BaseValue::Link {
            path: path.clone(),
            target: target.clone(),
            display: display.clone(),
            external: *external,
            display_value: display_value
                .as_ref()
                .map(|value| copy_value(value, options).map(Box::new))
                .transpose()?,
        },
        _ => v.clone(),
    })
}
fn copy_strings(v: &[String], options: &QueryOptions) -> Result<Vec<String>, ExpressionDiagnostic> {
    copy_vec(v, options, |v| Ok(v.clone()))
}
fn copy_record(
    r: &DetachedRecord,
    options: &QueryOptions,
) -> Result<DetachedRecord, ExpressionDiagnostic> {
    stopped(options)?;
    Ok(DetachedRecord {
        witness: r.witness.clone(),
        path: r.path.clone(),
        properties: copy_vec(&r.properties, options, |(k, v)| {
            Ok((k.clone(), copy_property(v, options)?))
        })?,
        property_types: copy_vec(&r.property_types, options, |v| Ok(v.clone()))?,
        tags: copy_strings(&r.tags, options)?,
        size: r.size,
        ctime_ms: r.ctime_ms,
        mtime_ms: r.mtime_ms,
    })
}
fn copy_options(o: &QueryOptions, independent: bool) -> Result<QueryOptions, ExpressionDiagnostic> {
    stopped(o)?;
    Ok(QueryOptions {
        view_index: o.view_index,
        search_terms: copy_strings(&o.search_terms, o)?,
        ignore_paths: copy_strings(&o.ignore_paths, o)?,
        current_entry_id: o.current_entry_id.clone(),
        summary_preview_property: o.summary_preview_property.clone(),
        summary_preview_group_key_id: o.summary_preview_group_key_id.clone(),
        max_steps: o.max_steps,
        max_scanned: o.max_scanned,
        max_rows: o.max_rows,
        max_groups: o.max_groups,
        max_output_bytes: o.max_output_bytes,
        evaluation: crate::EvaluationOptions {
            clock_ms: if independent {
                0
            } else {
                o.evaluation.clock_ms
            },
            random_seed: o.evaluation.random_seed,
            timezone: o.evaluation.timezone.clone(),
            max_steps: o.evaluation.max_steps,
            formulas: copy_vec(&o.evaluation.formulas, o, |v| Ok(v.clone()))?,
            current_record: o
                .evaluation
                .current_record
                .as_ref()
                .map(|r| copy_record(r, o))
                .transpose()?,
            cancellation: None,
        },
    })
}
fn copy_result(
    r: &BaseQueryResult,
    o: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    stopped(o)?;
    Ok(BaseQueryResult {
        snapshot_id: r.snapshot_id.clone(),
        view: copy_property(&r.view, o)?,
        summary_previews: r
            .summary_previews
            .as_ref()
            .map(|values| {
                values
                    .iter()
                    .map(|(key, value)| Ok((key.clone(), copy_value(value, o)?)))
                    .collect::<Result<_, ExpressionDiagnostic>>()
            })
            .transpose()?,
        relation_targets: r.relation_targets.clone(),
        property_definition_diagnostics: r.property_definition_diagnostics.clone(),
        summaries: r
            .summaries
            .iter()
            .map(|(k, v)| Ok((k.clone(), copy_value(v, o)?)))
            .collect::<Result<_, ExpressionDiagnostic>>()?,
        rows: copy_vec(&r.rows, o, |r| {
            Ok(crate::BaseRow {
                entry_id: r.entry_id.clone(),
                revision: r.revision.clone(),
                path: r.path.clone(),
                values: r
                    .values
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), copy_value(v, o)?)))
                    .collect::<Result<_, ExpressionDiagnostic>>()?,
                edit_values: r
                    .edit_values
                    .iter()
                    .map(|(key, value)| Ok((key.clone(), copy_value(value, o)?)))
                    .collect::<Result<_, ExpressionDiagnostic>>()?,
            })
        })?,
        groups: copy_vec(&r.groups, o, |g| {
            Ok(crate::BaseGroup {
                summaries: g
                    .summaries
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), copy_value(v, o)?)))
                    .collect::<Result<_, ExpressionDiagnostic>>()?,
                key_id: g.key_id.clone(),
                key: g.key.as_ref().map(|v| copy_value(v, o)).transpose()?,
                entry_ids: copy_vec(&g.entry_ids, o, |id| Ok(id.clone()))?,
            })
        })?,
        group_options: copy_vec(&r.group_options, o, |g| {
            Ok(crate::GroupOption {
                key_id: g.key_id.clone(),
                key: copy_value(&g.key, o)?,
                count: g.count,
                listed: g.listed,
            })
        })?,
        properties: copy_strings(&r.properties, o)?,
        available_properties: copy_strings(&r.available_properties, o)?,
        counts: r.counts.clone(),
        diagnostics: Vec::new(),
        metadata_issues: copy_vec(&r.metadata_issues, o, |issue| {
            Ok(crate::MetadataIssue {
                witness: issue.witness.clone(),
                exclusion: issue.exclusion.clone(),
                diagnostics: Vec::new(),
                properties_unavailable: issue.properties_unavailable,
            })
        })?,
        steps_used: r.steps_used,
        relationships_available: r.relationships_available,
        metadata_complete: r.metadata_complete,
        refresh_hint: r.refresh_hint.clone(),
    })
}

// Optional answers use exactly the same invocation-clock domain as cold
// evaluation; they cannot bless a clock which the evaluator would reject.
fn answer_clock_representable(clock_ms: i64) -> bool {
    crate::expression::invocation_clock(clock_ms).is_some()
}

fn decimal_bytes(n: usize) -> usize {
    if n == 0 {
        1
    } else {
        n.ilog10() as usize + 1
    }
}

#[cfg(test)]
#[path = "preparation_tests.rs"]
mod tests;
