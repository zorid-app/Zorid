//! Cooperative extraction checkpoints. A step completes one whole phase; pinned
//! Markdown/YAML parser calls inside a phase are synchronous and non-preemptible.
//! The budgets cover our requested collection/string capacities, not allocator
//! overhead or dependency-internal storage, and are not an RSS/OOM guarantee.
use crate::{frontmatter, markdown, positions, *};
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::mem::size_of;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseFactsPhase {
    Positions, Frontmatter, InitialMaskAndComments, WikiRepairs,
    ProtectedExclusions, Semantics, Tags, Ready, Cancelled,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ParseFactsUsage {
    pub source_bytes: usize,
    pub scratch_bytes: usize,
    pub facts_bytes: usize,
}
/// Per-job ceilings inclusive of its currently retained allocations. A scheduler
/// subtracts other jobs' usage before supplying its aggregate remaining budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseFactsStepBudget {
    pub max_scratch_bytes: usize,
    pub max_facts_bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseFactsResourceKind { Scratch, Facts }
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseFactsJobError {
    Resource { kind: ParseFactsResourceKind }, Cancelled, Finished,
}
impl std::fmt::Display for ParseFactsJobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
}
impl std::error::Error for ParseFactsJobError {}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseFactsStep {
    pub completed_phase: ParseFactsPhase,
    pub phases_completed: u8,
    pub ready: bool,
    pub usage: ParseFactsUsage,
}

enum Source<'a> { Shared(Arc<str>), Borrowed(&'a str) }
impl Source<'_> { fn text(&self) -> &str { match self { Self::Shared(s) => s, Self::Borrowed(s) => s } } }

/// Identity-free facts for one immutable source. New/cancel perform no parsing.
/// Cancellation drops partial work, so subsequent calls cannot execute phases.
/// A resource failure likewise releases the job instead of retaining a blocked
/// partial result. The work counter survives either terminal transition.
struct FactsJob<'a> {
    source: Option<Source<'a>>,
    checkpoints: Vec<positions::Checkpoint>,
    facts: Option<ParseFacts>,
    markdown: markdown::Phases,
    phase: ParseFactsPhase,
    phases_completed: u8,
    usage: ParseFactsUsage,
}
pub struct ParseFactsJob { inner: FactsJob<'static> }
impl ParseFactsJob {
    pub fn new(source: Arc<str>) -> Result<Self, ExtractionError> { Ok(Self { inner: FactsJob::from_source(Source::Shared(source))? }) }
    pub fn phase(&self) -> ParseFactsPhase { self.inner.phase() }
    pub fn phases_completed(&self) -> u8 { self.inner.phases_completed() }
    pub fn usage(&self) -> ParseFactsUsage { self.inner.usage() }
    pub fn step(&mut self, budget: ParseFactsStepBudget) -> Result<ParseFactsStep, ParseFactsJobError> { self.inner.step(budget) }
    pub fn cancel(&mut self) { self.inner.cancel(); }
    pub fn take_facts(&mut self) -> Option<ParseFacts> { self.inner.take_facts() }
}
impl<'a> FactsJob<'a> {
    fn from_source(source: Source<'a>) -> Result<Self, ExtractionError> {
        if source.text().len() > MAX_SOURCE_BYTES { return Err(ExtractionError::SourceTooLarge { maximum_bytes: MAX_SOURCE_BYTES }); }
        let usage = ParseFactsUsage { source_bytes: source.text().len(), scratch_bytes: 0, facts_bytes: 0 };
        Ok(Self { source: Some(source), usage, checkpoints: Vec::new(), facts: None, markdown: markdown::Phases::default(), phase: ParseFactsPhase::Positions, phases_completed: 0 })
    }
    pub fn phase(&self) -> ParseFactsPhase { self.phase }
    pub fn phases_completed(&self) -> u8 { self.phases_completed }
    pub fn usage(&self) -> ParseFactsUsage { self.usage }
    fn calculate_usage(&self) -> ParseFactsUsage {
        ParseFactsUsage {
            source_bytes: self.source.as_ref().map_or(0, |s| s.text().len()),
            scratch_bytes: self.checkpoints.capacity() * size_of::<positions::Checkpoint>() + self.markdown.owned_bytes(),
            facts_bytes: self.facts.as_ref().map_or(0, facts_bytes),
        }
    }
    pub fn cancel(&mut self) {
        self.source = None;
        self.checkpoints = Vec::new();
        self.facts = None;
        self.markdown = markdown::Phases::default();
        self.phase = ParseFactsPhase::Cancelled;
        self.usage = ParseFactsUsage::default();
    }
    pub fn take_facts(&mut self) -> Option<ParseFacts> {
        if self.phase != ParseFactsPhase::Ready { return None; }
        let facts = self.facts.take();
        self.usage.facts_bytes = 0;
        facts
    }
    pub fn step(&mut self, limits: ParseFactsStepBudget) -> Result<ParseFactsStep, ParseFactsJobError> { self.step_inner(Some(limits)) }
    fn step_inner(&mut self, limits: Option<ParseFactsStepBudget>) -> Result<ParseFactsStep, ParseFactsJobError> {
        if self.phase == ParseFactsPhase::Cancelled { return Err(ParseFactsJobError::Cancelled); }
        if self.phase == ParseFactsPhase::Ready { return Err(ParseFactsJobError::Finished); }
        let completed_phase = self.phase;
        let mut budget = AllocationBudget::new(limits, self.usage());
        let result = self.execute(&mut budget);
        if let Err(error) = result { self.cancel(); return Err(error); }
        self.phases_completed += 1;
        // Legacy synchronous extraction does not observe allocation usage.
        // Avoid repeatedly walking its already-extracted facts just to maintain
        // a ledger that only the admitted draft lane consumes.
        if limits.is_some() { self.usage = self.calculate_usage(); }
        Ok(ParseFactsStep { completed_phase, phases_completed: self.phases_completed, ready: self.phase == ParseFactsPhase::Ready, usage: self.usage() })
    }
    fn execute(&mut self, budget: &mut AllocationBudget) -> Result<(), ParseFactsJobError> {
        budget.validate()?;
        let source = self.source.as_ref().expect("nonterminal source").text();
        if self.phase == ParseFactsPhase::Positions {
            let positions = positions::Positions::build(source, budget)?;
            budget.charge(size_of::<ParseFacts>() + DIALECT_VERSION.len(), AllocationKind::Facts)?;
            self.facts = Some(empty_facts(positions.length()));
            self.checkpoints = positions.into_checkpoints();
            self.phase = ParseFactsPhase::Frontmatter;
            return Ok(());
        }
        let positions = positions::Positions::from_index(source, &self.checkpoints);
        let facts = self.facts.as_mut().expect("position phase initializes facts");
        self.phase = match self.phase {
            ParseFactsPhase::Frontmatter => { frontmatter::extract(source, &positions, facts, budget)?; ParseFactsPhase::InitialMaskAndComments }
            ParseFactsPhase::InitialMaskAndComments => { self.markdown.initial(source, facts, budget)?; ParseFactsPhase::WikiRepairs }
            ParseFactsPhase::WikiRepairs => { self.markdown.repairs(budget)?; ParseFactsPhase::ProtectedExclusions }
            ParseFactsPhase::ProtectedExclusions => { self.markdown.protect(source, &positions, facts, budget)?; ParseFactsPhase::Semantics }
            ParseFactsPhase::Semantics => { self.markdown.semantics(source, &positions, facts, budget)?; ParseFactsPhase::Tags }
            ParseFactsPhase::Tags => { self.markdown.tags(&positions, facts, budget)?; self.markdown = markdown::Phases::default(); self.checkpoints = Vec::new(); self.source = None; ParseFactsPhase::Ready }
            _ => unreachable!(),
        };
        Ok(())
    }
}

pub(crate) fn parse_borrowed(source: &str) -> Result<ParseFacts, ExtractionError> {
    let mut job = FactsJob::from_source(Source::Borrowed(source))?;
    while job.phase() != ParseFactsPhase::Ready { job.step_inner(None).expect("unbounded extraction"); }
    Ok(job.take_facts().expect("ready facts"))
}
fn empty_facts(source_length: SourceLength) -> ParseFacts {
    ParseFacts { schema_version: SCHEMA_VERSION, dialect_version: DIALECT_VERSION.into(), source_length,
        frontmatter: Frontmatter { state: FrontmatterState::Absent, range: None, body_start: SourcePoint { byte: 0, utf16: 0 } },
        properties: Vec::new(), aliases: Vec::new(), tags: Vec::new(), tag_occurrences: Vec::new(), headings: Vec::new(), links: Vec::new(), tasks: Vec::new(), blocks: Vec::new(), list_items: Vec::new(), diagnostics: Vec::new() }
}

#[derive(Clone, Copy)]
pub(crate) enum AllocationKind { Scratch, Facts }
pub(crate) struct AllocationBudget {
    limits: Option<ParseFactsStepBudget>, scratch: usize, facts: usize, failure: Option<ParseFactsJobError>,
}
impl AllocationBudget {
    fn new(limits: Option<ParseFactsStepBudget>, usage: ParseFactsUsage) -> Self { Self { limits, scratch: usage.scratch_bytes, facts: usage.facts_bytes, failure: None } }
    pub(crate) fn failure(&self) -> Option<ParseFactsJobError> { self.failure.clone() }
    pub(crate) fn unbounded() -> Self { Self::new(None, ParseFactsUsage::default()) }
    fn error(kind: AllocationKind) -> ParseFactsJobError { ParseFactsJobError::Resource { kind: match kind { AllocationKind::Scratch => ParseFactsResourceKind::Scratch, AllocationKind::Facts => ParseFactsResourceKind::Facts } } }
    fn validate(&self) -> Result<(), ParseFactsJobError> {
        if let Some(error) = &self.failure { return Err(error.clone()); }
        if let Some(l) = self.limits { if self.scratch > l.max_scratch_bytes { return Err(Self::error(AllocationKind::Scratch)); } if self.facts > l.max_facts_bytes { return Err(Self::error(AllocationKind::Facts)); } }
        Ok(())
    }
    pub(crate) fn charge(&mut self, bytes: usize, kind: AllocationKind) -> Result<(), ParseFactsJobError> {
        self.validate()?;
        if self.limits.is_none() { return Ok(()); }
        let target = match kind { AllocationKind::Scratch => &mut self.scratch, AllocationKind::Facts => &mut self.facts };
        let result = if let Some(total) = target.checked_add(bytes) { *target = total; self.validate() } else { Err(Self::error(kind)) };
        if let Err(error) = &result { self.failure = Some(error.clone()); }
        result
    }
    fn capacity(&self, current: usize, needed: usize, unit: usize, kind: AllocationKind) -> Result<usize, ParseFactsJobError> {
        self.validate()?;
        let preferred = needed.max(current.saturating_mul(2)).max(4);
        let Some(limits) = self.limits else { return Ok(preferred); };
        let (ceiling, used) = match kind { AllocationKind::Scratch => (limits.max_scratch_bytes, self.scratch), AllocationKind::Facts => (limits.max_facts_bytes, self.facts) };
        let maximum = current.saturating_add(ceiling.saturating_sub(used) / unit.max(1));
        if needed > maximum { return Err(Self::error(kind)); }
        Ok(preferred.min(maximum))
    }
    fn allocation_failed(&mut self, kind: AllocationKind) -> ParseFactsJobError {
        let error = Self::error(kind); self.failure = Some(error.clone()); error
    }
    pub(crate) fn reserve_vec<T>(&mut self, values: &mut Vec<T>, extra: usize, kind: AllocationKind) -> Result<(), ParseFactsJobError> {
        let needed = values.len().checked_add(extra).ok_or_else(|| Self::error(kind))?;
        if needed <= values.capacity() { return Ok(()); }
        let target = self.capacity(values.capacity(), needed, size_of::<T>(), kind).map_err(|_| self.allocation_failed(kind))?;
        self.charge((target - values.capacity()).checked_mul(size_of::<T>()).ok_or_else(|| Self::error(kind))?, kind)?;
        let previous = values.capacity();
        values.try_reserve_exact(target - values.len()).map_err(|_| self.allocation_failed(kind))?;
        if values.capacity() > target { self.charge((values.capacity() - target) * size_of::<T>(), kind)?; }
        debug_assert!(values.capacity() >= previous);
        Ok(())
    }
    pub(crate) fn push_str(&mut self, value: &mut String, text: &str, kind: AllocationKind) -> Result<(), ParseFactsJobError> {
        let needed = value.len().checked_add(text.len()).ok_or_else(|| Self::error(kind))?;
        if needed > value.capacity() {
            let target = self.capacity(value.capacity(), needed, 1, kind).map_err(|_| self.allocation_failed(kind))?;
            self.charge(target - value.capacity(), kind)?;
            value.try_reserve_exact(target - value.len()).map_err(|_| self.allocation_failed(kind))?;
            if value.capacity() > target { self.charge(value.capacity() - target, kind)?; }
        }
        value.push_str(text); Ok(())
    }
    pub(crate) fn string(&mut self, text: &str, kind: AllocationKind) -> Result<String, ParseFactsJobError> {
        let mut value = String::new(); self.push_str(&mut value, text, kind)?; Ok(value)
    }
    pub(crate) fn bytes(&mut self, text: &[u8], kind: AllocationKind) -> Result<Vec<u8>, ParseFactsJobError> {
        let mut value = Vec::new(); self.reserve_vec(&mut value, text.len(), kind)?; value.extend_from_slice(text); Ok(value)
    }
    // Hash collection storage has implementation-private buckets. Charge a
    // conservative requested bucket allowance before asking std to grow. It is
    // deliberately larger than the retained key/value capacity charge below.
    pub(crate) fn reserve_set<T: Eq + Hash>(&mut self, values: &mut HashSet<T>, extra: usize, kind: AllocationKind) -> Result<(), ParseFactsJobError> {
        if values.len() + extra <= values.capacity() { return Ok(()); }
        let target = self.capacity(values.capacity(), values.len() + extra, size_of::<T>() + 16, kind).map_err(|_| self.allocation_failed(kind))?;
        self.charge(hash_bytes::<T>(target).checked_mul(2).ok_or_else(|| Self::error(kind))?, kind)?;
        values.try_reserve(target - values.len()).map_err(|_| self.allocation_failed(kind))?; Ok(())
    }
    pub(crate) fn reserve_map<K: Eq + Hash, V>(&mut self, values: &mut HashMap<K,V>, extra: usize, kind: AllocationKind) -> Result<(), ParseFactsJobError> {
        if values.len() + extra <= values.capacity() { return Ok(()); }
        let target = self.capacity(values.capacity(), values.len() + extra, size_of::<(K,V)>() + 16, kind).map_err(|_| self.allocation_failed(kind))?;
        self.charge(hash_bytes::<(K,V)>(target).checked_mul(2).ok_or_else(|| Self::error(kind))?, kind)?;
        values.try_reserve(target - values.len()).map_err(|_| self.allocation_failed(kind))?; Ok(())
    }
}
fn hash_bytes<T>(capacity: usize) -> usize { capacity.saturating_mul(size_of::<T>() + 16) }
fn strings_bytes(values: &[String]) -> usize { values.iter().map(String::capacity).sum() }
fn property_value_bytes(v: &PropertyValue) -> usize { match v { PropertyValue::String(s) => s.capacity(), PropertyValue::Array(v) => v.capacity()*size_of::<PropertyValue>() + v.iter().map(property_value_bytes).sum::<usize>(), PropertyValue::Object(v) => v.capacity()*size_of::<(String,PropertyValue)>() + v.iter().map(|(k,v)| k.capacity()+property_value_bytes(v)).sum::<usize>(), _ => 0 } }
fn facts_bytes(f: &ParseFacts) -> usize {
    size_of::<ParseFacts>() + f.dialect_version.capacity()
    + f.properties.capacity()*size_of::<Property>() + f.properties.iter().map(|p| p.key.capacity()+property_value_bytes(&p.value)).sum::<usize>()
    + f.aliases.capacity()*size_of::<String>() + strings_bytes(&f.aliases)
    + f.tags.capacity()*size_of::<String>() + strings_bytes(&f.tags)
    + f.tag_occurrences.capacity()*size_of::<TagOccurrence>() + f.tag_occurrences.iter().map(|t| t.name.capacity()).sum::<usize>()
    + f.headings.capacity()*size_of::<Heading>() + f.headings.iter().map(|h| h.text.capacity()).sum::<usize>()
    + f.links.capacity()*size_of::<Link>() + f.links.iter().map(|l| l.target.capacity()+l.fragment.capacity()+l.destination.capacity()).sum::<usize>()
    + f.tasks.capacity()*size_of::<Task>() + f.tasks.iter().map(|t| t.status.capacity()+t.text.capacity()).sum::<usize>()
    + f.blocks.capacity()*size_of::<MarkdownBlock>() + f.list_items.capacity()*size_of::<ListItem>() + f.list_items.iter().map(|i|i.task_status.as_ref().map_or(0,String::capacity)).sum::<usize>()
    + f.diagnostics.capacity()*size_of::<Diagnostic>()
}
