//! Bounded ordering of an exact retained namespace, before any file evaluation.
//! Unicode lowercase/UTF16 ordering is deliberate Zorid behavior, independent of
//! locale and live stats. The 64M allowance is separate from evaluator work.
use super::preview::SearchBacking;
use super::{SearchSort, MAX_SEARCH_CANDIDATES, MAX_SEARCH_ORDER_BYTES};
use crate::Generation;
use std::{cmp::Ordering, mem::size_of, sync::Arc};
use zorid_core::{EntryKind, EntryState};

pub const MAX_SEARCH_ORDER_WORK: usize = 64_000_000;
pub const MAX_SEARCH_ORDER_PUMP_WORK: usize = 2_000_000;
/// Synchronous exact-facts admission is bounded separately, and counts toward
/// the64M total. This phase rejects oversized admission instead of yielding.
pub const MAX_SEARCH_ORDER_ADMISSION_WORK: usize = MAX_SEARCH_ORDER_PUMP_WORK;
const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const UNKNOWN: i64 = i64::MIN;

/// Facts in exactly the manifest's file-entry order. The host separately admits
/// snapshot/source identity. No body, pin, reader or live-stat callback is kept.
pub struct SearchPresentationFacts<'a> {
    pub entry: &'a EntryState,
    pub created_ms: Option<i64>,
    pub modified_ms: Option<i64>,
}
#[derive(Debug)]
pub enum SearchOrderError<E> {
    Host(E),
    InvalidFacts(&'static str),
    Resource(&'static str),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchOrderProgress {
    Preparing,
    Complete,
}

// Exactly 32 bytes on supported native/wasm targets. No copied path/ID strings.
#[derive(Clone, Copy)]
struct Row {
    lower_start: u32,
    lower_len: u32,
    basename: u32,
    manifest: u32,
    time: i64,
    scalars: u32,
    lower_bytes: u32,
}
const _: [(); 32] = [(); size_of::<Row>()];
#[derive(Clone, Copy, Default)]
struct Utf16Position {
    byte: usize,
    pending: Option<u16>,
}
impl Utf16Position {
    fn next(&mut self, value: &str) -> Option<u16> {
        if let Some(unit) = self.pending.take() {
            return Some(unit);
        }
        let ch = value[self.byte..].chars().next()?;
        self.byte += ch.len_utf8();
        let mut units = [0; 2];
        let encoded = ch.encode_utf16(&mut units);
        if encoded.len() == 2 {
            self.pending = Some(encoded[1]);
        }
        Some(encoded[0])
    }
}
#[derive(Default)]
struct Projection {
    row: usize,
    byte: usize,
    units: [u16; 6],
    pending: usize,
    len: usize,
    transient: Option<String>,
    utf16: Utf16Position,
}
impl Projection {
    fn queue(&mut self, ch: char) -> usize {
        self.pending = 0;
        self.len = 0;
        let mut bytes = 0;
        for lower in ch.to_lowercase() {
            bytes += lower.len_utf8();
            let mut units = [0; 2];
            for &unit in lower.encode_utf16(&mut units).iter() {
                self.units[self.len] = unit;
                self.len += 1;
            }
        }
        bytes
    }
}
#[derive(Clone, Copy)]
struct Comparison {
    left: usize,
    right: usize,
    // 0=time, 1=lower, 2=exact basename, 3=exact path, 4=ID.
    field: u8,
    offset: usize,
    a: Utf16Position,
    b: Utf16Position,
}
#[derive(Clone, Copy, Default)]
struct Merge {
    width: usize,
    start: usize,
    middle: usize,
    end: usize,
    left: usize,
    right: usize,
    out: usize,
    compare: Option<Comparison>,
    selected: Option<bool>,
}
#[derive(Clone, Copy)]
enum Phase {
    Measure,
    Allocate,
    Project,
    Sort,
    Finalize(usize),
    Complete,
}

pub struct SearchOrderPreparation {
    generation: SearchBacking,
    sort: SearchSort,
    count: usize,
    rows: Vec<Row>,
    lower: Vec<u16>,
    order: Vec<u32>,
    scratch: Vec<u32>,
    measured: usize,
    projection: Projection,
    merge: Merge,
    phase: Phase,
    work: usize,
}
pub struct SearchOrderPlan {
    generation: SearchBacking,
    rows: Vec<u32>,
    work: usize,
}
impl SearchOrderPlan {
    pub fn generation(&self) -> &Arc<Generation> {
        self.generation
            .published()
            .expect("published order wrapper")
    }
    /// Ordinals into generation.manifest().entries(), including folder gaps.
    pub fn rows(&self) -> &[u32] {
        &self.rows
    }
    pub fn work_used(&self) -> usize {
        self.work
    }
    pub fn retained_bytes(&self) -> usize {
        size_of::<Self>() + self.rows.capacity() * size_of::<u32>()
    }
}
fn charge<E>(
    work: &mut usize,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(), SearchOrderError<E>> {
    charge_units(work, 1, check)
}
fn charge_units<E>(
    work: &mut usize,
    units: usize,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(), SearchOrderError<E>> {
    let next = work
        .checked_add(units)
        .filter(|&n| n <= MAX_SEARCH_ORDER_WORK)
        .ok_or(SearchOrderError::Resource("search order work"))?;
    check(units).map_err(SearchOrderError::Host)?;
    *work = next;
    Ok(())
}
fn charge_admission<E>(
    work: &mut usize,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(), SearchOrderError<E>> {
    if *work >= MAX_SEARCH_ORDER_ADMISSION_WORK {
        return Err(SearchOrderError::Resource("search order admission work"));
    }
    charge(work, check)
}
fn charge_admission_units<E>(
    work: &mut usize,
    units: usize,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(), SearchOrderError<E>> {
    if work
        .checked_add(units)
        .map_or(true, |n| n > MAX_SEARCH_ORDER_ADMISSION_WORK)
    {
        return Err(SearchOrderError::Resource("search order admission work"));
    }
    charge_units(work, units, check)
}
fn same_bytes<E>(
    a: &str,
    b: &str,
    work: &mut usize,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(), SearchOrderError<E>> {
    if a.len() != b.len() {
        return Err(SearchOrderError::InvalidFacts("entry identity"));
    }
    for (a, b) in a.as_bytes().chunks(64).zip(b.as_bytes().chunks(64)) {
        charge_admission(work, check)?;
        if a != b {
            return Err(SearchOrderError::InvalidFacts("entry identity"));
        }
    }
    Ok(())
}
fn reserve<T, E>(v: &mut Vec<T>, count: usize) -> Result<(), SearchOrderError<E>> {
    v.try_reserve_exact(count)
        .map_err(|_| SearchOrderError::Resource("search order allocation"))
}
impl SearchOrderPreparation {
    /// Exact facts are borrowed only for this synchronous call. Every typed
    /// namespace visit and64-byte identity/basename block is charged before
    /// access, with a2M admission subcap inside the64M preparation allowance.
    /// Rejection publishes no partial preparation. Later projection/sorting
    /// are pumped; admission itself does not claim resumability.
    pub fn new<E>(
        generation: Arc<Generation>,
        facts: &[SearchPresentationFacts<'_>],
        sort: SearchSort,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Self, SearchOrderError<E>> {
        Self::new_backing(SearchBacking::Published(generation), facts, sort, check)
    }
    pub(super) fn new_backing<E>(
        generation: SearchBacking,
        facts: &[SearchPresentationFacts<'_>],
        sort: SearchSort,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Self, SearchOrderError<E>> {
        check(0).map_err(SearchOrderError::Host)?;
        if facts.len() > MAX_SEARCH_CANDIDATES {
            return Err(SearchOrderError::Resource("search candidate count"));
        }
        let count = facts.len();
        let base_bytes = size_of::<Self>()
            .checked_add(
                count
                    .checked_mul(size_of::<Row>() + 8)
                    .ok_or(SearchOrderError::Resource("search order bytes"))?,
            )
            .ok_or(SearchOrderError::Resource("search order bytes"))?;
        if base_bytes > MAX_SEARCH_ORDER_BYTES {
            return Err(SearchOrderError::Resource("search order bytes"));
        }
        let mut rows = Vec::new();
        let mut order = Vec::new();
        let mut scratch = Vec::new();
        reserve(&mut rows, count)?;
        reserve(&mut order, count)?;
        reserve(&mut scratch, count)?;
        if size_of::<Self>()
            + rows.capacity() * size_of::<Row>()
            + (order.capacity() + scratch.capacity()) * 4
            > MAX_SEARCH_ORDER_BYTES
        {
            return Err(SearchOrderError::Resource(
                "search order allocation capacity",
            ));
        }
        let mut work = 0;
        // Namespace rows are path ordered, while captured membership is exact-ID
        // ordered. Merge both existing ID orders once into a transient bitmap;
        // admission then keeps its original path/facts order. No strings or
        // parser facts are copied, and sparse previews never pay N*log(P).
        let membership = if let SearchBacking::Preview(preview) = &generation {
            let entries = generation.manifest().entries();
            let scratch_limit = size_of::<Self>()
                + rows.capacity() * size_of::<Row>()
                + (order.capacity() + scratch.capacity()) * 4;
            if scratch_limit
                .checked_add(entries.len())
                .map_or(true, |n| n > MAX_SEARCH_ORDER_BYTES)
            {
                return Err(SearchOrderError::Resource("search order membership bytes"));
            }
            charge_admission_units(
                &mut work,
                entries.len().div_ceil(64).saturating_add(1),
                check,
            )?;
            let mut membership: Vec<u8> = Vec::new();
            reserve(&mut membership, entries.len())?;
            if scratch_limit
                .checked_add(membership.capacity())
                .map_or(true, |n| n > MAX_SEARCH_ORDER_BYTES)
            {
                return Err(SearchOrderError::Resource(
                    "search order membership capacity",
                ));
            }
            membership.resize(entries.len(), 0);
            let prepared = preview.records_by_id();
            let mut at = 0;
            for &ordinal in generation.manifest().entry_ordinals_by_id() {
                charge_admission(&mut work, check)?;
                if at == prepared.len() {
                    break;
                }
                // Typed visit plus both ID operands' <=128-byte comparisons.
                charge_admission_units(&mut work, 5, check)?;
                match entries[ordinal].id.cmp(&prepared[at].witness().entry().id) {
                    Ordering::Less => {}
                    Ordering::Equal => {
                        charge_admission(&mut work, check)?;
                        membership[ordinal] = 1;
                        at += 1;
                    }
                    Ordering::Greater => {
                        return Err(SearchOrderError::InvalidFacts("preview membership"))
                    }
                }
            }
            if at != prepared.len() {
                return Err(SearchOrderError::InvalidFacts("preview membership"));
            }
            Some(membership)
        } else {
            None
        };
        for (ordinal, entry) in generation.manifest().entries().iter().enumerate() {
            charge_admission(&mut work, check)?;
            if entry.kind != EntryKind::File || membership.as_ref().is_some_and(|m| m[ordinal] == 0)
            {
                continue;
            }
            let fact = facts
                .get(rows.len())
                .ok_or(SearchOrderError::InvalidFacts("missing file facts"))?;
            if fact.entry.kind != entry.kind || fact.entry.deleted != entry.deleted {
                return Err(SearchOrderError::InvalidFacts("entry kind/deleted"));
            }
            same_bytes(entry.id.as_str(), fact.entry.id.as_str(), &mut work, check)?;
            same_bytes(
                entry.revision.as_str(),
                fact.entry.revision.as_str(),
                &mut work,
                check,
            )?;
            same_bytes(
                entry.path.as_str(),
                fact.entry.path.as_str(),
                &mut work,
                check,
            )?;
            let mut basename = 0;
            // ASCII '/' cannot be a UTF8 continuation; block boundaries are safe.
            for (block, bytes) in entry.path.as_str().as_bytes().chunks(64).enumerate() {
                charge_admission(&mut work, check)?;
                if let Some(at) = bytes.iter().rposition(|&b| b == b'/') {
                    basename = block * 64 + at + 1;
                }
            }
            let time = |t: Option<i64>| match t {
                Some(t) if (-SAFE_INTEGER..=SAFE_INTEGER).contains(&t) => Ok(t),
                None => Ok(UNKNOWN),
                _ => Err(SearchOrderError::InvalidFacts("unsafe timestamp")),
            };
            rows.push(Row {
                lower_start: 0,
                lower_len: 0,
                basename: u32::try_from(basename)
                    .map_err(|_| SearchOrderError::Resource("search path offset"))?,
                manifest: u32::try_from(ordinal)
                    .map_err(|_| SearchOrderError::Resource("search manifest ordinal"))?,
                time: {
                    let created = time(fact.created_ms)?;
                    let modified = time(fact.modified_ms)?;
                    match sort {
                        SearchSort::ModifiedAsc | SearchSort::ModifiedDesc => modified,
                        _ => created,
                    }
                },
                scalars: 0,
                lower_bytes: 0,
            });
        }
        if rows.len() != count {
            return Err(SearchOrderError::InvalidFacts("extra file facts"));
        }
        Ok(Self {
            generation,
            sort,
            count,
            rows,
            lower: Vec::new(),
            order,
            scratch,
            measured: 0,
            projection: Projection::default(),
            merge: Merge::default(),
            phase: Phase::Measure,
            work,
        })
    }
    pub fn candidate_count(&self) -> usize {
        self.count
    }
    pub fn work_used(&self) -> usize {
        self.work
    }
    /// Includes owned capacities, the one transient lowercase name, and inline
    /// state. Immutable Generation data belongs to its existing host budget.
    pub fn retained_bytes(&self) -> usize {
        size_of::<Self>()
            + self.rows.capacity() * size_of::<Row>()
            + self.lower.capacity() * 2
            + (self.order.capacity() + self.scratch.capacity()) * 4
            + self
                .projection
                .transient
                .as_ref()
                .map_or(0, String::capacity)
    }
    pub fn into_plan(self) -> Result<SearchOrderPlan, Self> {
        if !matches!(self.phase, Phase::Complete) {
            return Err(self);
        }
        Ok(SearchOrderPlan {
            generation: self.generation,
            rows: self.order,
            work: self.work,
        })
    }
    /// Sorting and UTF16 copying resume after every charged unit. Full Unicode
    /// lowercase projection finishes one pre-admitted name atomically; that
    /// call may overshoot the soft budget by at most2M charged units. It has no
    /// IO and cancellation is checked before and after the standard-library call;
    /// it does not claim instantaneous preemption inside that bounded call.
    pub fn pump<E>(
        &mut self,
        soft_work: usize,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<SearchOrderProgress, SearchOrderError<E>> {
        if soft_work == 0 || soft_work > MAX_SEARCH_ORDER_PUMP_WORK {
            return Err(SearchOrderError::Resource("search order pump work"));
        }
        check(0).map_err(SearchOrderError::Host)?;
        let started = self.work;
        while self.work - started < soft_work {
            if matches!(self.phase, Phase::Complete) {
                return Ok(SearchOrderProgress::Complete);
            }
            let atomic_name = matches!(self.phase, Phase::Project)
                && self.projection.transient.is_none()
                && self.projection.row < self.count;
            let units = if atomic_name {
                let row = self.rows[self.projection.row];
                let name_len = self.generation.manifest().entries()[row.manifest as usize]
                    .path
                    .as_str()
                    .len()
                    - row.basename as usize;
                let units = row.scalars as usize + name_len.div_ceil(64) + 1;
                if units > MAX_SEARCH_ORDER_PUMP_WORK {
                    return Err(SearchOrderError::Resource("search lowercase name work"));
                }
                units
            } else {
                1
            };
            charge_units(&mut self.work, units, check)?;
            match self.phase {
                Phase::Measure => self.measure_step()?,
                Phase::Allocate => {
                    let bytes = self
                        .measured
                        .checked_mul(2)
                        .and_then(|n| self.retained_bytes().checked_add(n))
                        .ok_or(SearchOrderError::Resource("search order bytes"))?;
                    if bytes > MAX_SEARCH_ORDER_BYTES {
                        return Err(SearchOrderError::Resource("search order bytes"));
                    }
                    reserve(&mut self.lower, self.measured)?;
                    if self.retained_bytes() > MAX_SEARCH_ORDER_BYTES {
                        return Err(SearchOrderError::Resource(
                            "search order allocation capacity",
                        ));
                    }
                    self.projection = Projection::default();
                    self.phase = Phase::Project;
                }
                Phase::Project => self.copy_step()?,
                Phase::Sort => self.sort_step(),
                Phase::Finalize(at) => {
                    if at == self.count {
                        self.rows = Vec::new();
                        self.lower = Vec::new();
                        self.scratch = Vec::new();
                        self.phase = Phase::Complete;
                    } else {
                        self.order[at] = self.rows[self.order[at] as usize].manifest;
                        self.phase = Phase::Finalize(at + 1);
                    }
                }
                Phase::Complete => unreachable!(),
            }
            if atomic_name {
                check(0).map_err(SearchOrderError::Host)?;
            }
        }
        Ok(if matches!(self.phase, Phase::Complete) {
            SearchOrderProgress::Complete
        } else {
            SearchOrderProgress::Preparing
        })
    }
    fn measure_step<E>(&mut self) -> Result<(), SearchOrderError<E>> {
        let available_units = (MAX_SEARCH_ORDER_BYTES - self.retained_bytes()) / 2;
        let p = &mut self.projection;
        if p.row == self.count {
            self.phase = Phase::Allocate;
            return Ok(());
        }
        let row = &mut self.rows[p.row];
        if p.pending < p.len {
            p.pending += 1;
            row.lower_len += 1;
            self.measured = self
                .measured
                .checked_add(1)
                .ok_or(SearchOrderError::Resource("search order bytes"))?;
            if self.measured > available_units {
                return Err(SearchOrderError::Resource("search order bytes"));
            }
            return Ok(());
        }
        let path = self.generation.manifest().entries()[row.manifest as usize]
            .path
            .as_str();
        let name = &path[row.basename as usize..];
        if let Some(ch) = name[p.byte..].chars().next() {
            p.byte += ch.len_utf8();
            row.scalars += 1;
            // Full lowercase only adds contextual FinalSigma, whose UTF8 and
            // UTF16 lengths equal ordinary sigma. This pass measures lengths,
            // never chooses the projected spelling used by the comparator.
            row.lower_bytes = row
                .lower_bytes
                .checked_add(p.queue(ch) as u32)
                .ok_or(SearchOrderError::Resource("search lower bytes"))?;
        } else {
            p.row += 1;
            p.byte = 0;
            p.pending = 0;
            p.len = 0;
            if p.row < self.count {
                self.rows[p.row].lower_start = self.measured as u32;
            }
        }
        Ok(())
    }
    fn copy_step<E>(&mut self) -> Result<(), SearchOrderError<E>> {
        let at = self.projection.row;
        if at == self.count {
            if self.lower.len() != self.measured {
                return Err(SearchOrderError::Resource("search lower length"));
            }
            self.merge = Merge {
                width: 1,
                ..Merge::default()
            };
            self.phase = Phase::Sort;
            return Ok(());
        }
        let row = self.rows[at];
        if let Some(name) = self.projection.transient.as_ref() {
            if let Some(unit) = self.projection.utf16.next(name) {
                if self.lower.len() == self.lower.capacity() {
                    return Err(SearchOrderError::Resource("search lower capacity"));
                }
                self.lower.push(unit);
            } else {
                self.projection.transient = None;
                self.projection.utf16 = Utf16Position::default();
                self.projection.row += 1;
                // One typed row-initialization visit. Each later merge write
                // and final manifest-ordinal copy has its own charged unit.
                self.order.push(at as u32);
                self.scratch.push(0);
            }
        } else {
            let path = self.generation.manifest().entries()[row.manifest as usize]
                .path
                .as_str();
            let name = &path[row.basename as usize..];
            // Unicode full lowercase expands UTF8 by at most3x. Reserve twice
            // that allowance for String's geometric growth before allocation.
            // Check actual capacity too; no transient survives beyond one name.
            let capacity = name
                .len()
                .checked_mul(6)
                .ok_or(SearchOrderError::Resource("search lower capacity"))?;
            if self
                .retained_bytes()
                .checked_add(capacity)
                .map_or(true, |n| n > MAX_SEARCH_ORDER_BYTES)
            {
                return Err(SearchOrderError::Resource(
                    "search lowercase transient bytes",
                ));
            }
            let lower = name.to_lowercase();
            if lower.len() != row.lower_bytes as usize || lower.capacity() > capacity {
                return Err(SearchOrderError::Resource(
                    "search lowercase transient capacity",
                ));
            }
            self.projection.transient = Some(lower);
        }
        Ok(())
    }
    fn compare_step(&self, c: &mut Comparison) -> Option<Ordering> {
        let a = self.rows[c.left];
        let b = self.rows[c.right];
        if c.field == 0 {
            let (a, b) = (a.time, b.time);
            let order = match (a == UNKNOWN, b == UNKNOWN) {
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                _ if a == b => Ordering::Equal,
                _ if matches!(
                    self.sort,
                    SearchSort::ModifiedDesc | SearchSort::CreatedDesc
                ) =>
                {
                    b.cmp(&a)
                }
                _ => a.cmp(&b),
            };
            if order != Ordering::Equal {
                return Some(order);
            }
            c.field = 1;
            return None;
        }
        let (au, bu) = if c.field == 1 {
            (
                self.lower
                    .get(a.lower_start as usize + c.offset)
                    .copied()
                    .filter(|_| c.offset < a.lower_len as usize),
                self.lower
                    .get(b.lower_start as usize + c.offset)
                    .copied()
                    .filter(|_| c.offset < b.lower_len as usize),
            )
        } else {
            let ae = &self.generation.manifest().entries()[a.manifest as usize];
            let be = &self.generation.manifest().entries()[b.manifest as usize];
            let (av, bv) = match c.field {
                2 => (
                    &ae.path.as_str()[a.basename as usize..],
                    &be.path.as_str()[b.basename as usize..],
                ),
                3 => (ae.path.as_str(), be.path.as_str()),
                _ => (ae.id.as_str(), be.id.as_str()),
            };
            (c.a.next(av), c.b.next(bv))
        };
        let order = au.cmp(&bu);
        if order != Ordering::Equal {
            return Some(if c.field == 1 && self.sort == SearchSort::NameDesc {
                order.reverse()
            } else {
                order
            });
        }
        if au.is_some() {
            c.offset += 1;
            return None;
        }
        if c.field == 4 {
            return Some(Ordering::Equal);
        }
        c.field += 1;
        c.offset = 0;
        c.a = Utf16Position::default();
        c.b = Utf16Position::default();
        None
    }
    fn sort_step(&mut self) {
        let mut m = self.merge;
        if let Some(mut c) = m.compare {
            match self.compare_step(&mut c) {
                Some(order) => {
                    m.compare = None;
                    m.selected = Some(order != Ordering::Greater);
                }
                None => m.compare = Some(c),
            }
            self.merge = m;
            return;
        }
        if let Some(left) = m.selected.take() {
            let at = if left {
                let at = m.left;
                m.left += 1;
                at
            } else {
                let at = m.right;
                m.right += 1;
                at
            };
            self.scratch[m.out] = self.order[at];
            m.out += 1;
            self.merge = m;
            return;
        }
        if m.out == m.end {
            if m.end == self.count {
                if m.end != 0 {
                    std::mem::swap(&mut self.order, &mut self.scratch);
                    m.width *= 2;
                }
                m.start = 0;
                if m.width >= self.count {
                    self.phase = Phase::Finalize(0);
                    self.merge = m;
                    return;
                }
            } else {
                m.start = m.end;
            }
            m.middle = (m.start + m.width).min(self.count);
            m.end = (m.start + m.width * 2).min(self.count);
            m.left = m.start;
            m.right = m.middle;
            m.out = m.start;
        }
        if m.left < m.middle && m.right < m.end {
            m.compare = Some(Comparison {
                left: self.order[m.left] as usize,
                right: self.order[m.right] as usize,
                field: if matches!(self.sort, SearchSort::NameAsc | SearchSort::NameDesc) {
                    1
                } else {
                    0
                },
                offset: 0,
                a: Utf16Position::default(),
                b: Utf16Position::default(),
            });
        } else {
            let at = if m.left < m.middle {
                let at = m.left;
                m.left += 1;
                at
            } else {
                let at = m.right;
                m.right += 1;
                at
            };
            self.scratch[m.out] = self.order[at];
            m.out += 1;
        }
        self.merge = m;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        document_extraction_version, Exclusion, GenerationBuilder, IndexRecord, IndexSnapshotId,
        Manifest, PublicationFence, SemanticVersions, SourceSnapshotId, SourceWatermark,
        INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION, RESOLVER_VERSION,
    };
    use zorid_core::{EntryId, OperationId, Revision, VaultPath};

    fn generation(paths: &[&str]) -> Arc<Generation> {
        let source = SourceSnapshotId::new(
            OperationId::new("order-store").unwrap(),
            SourceWatermark::new("1").unwrap(),
        );
        let entries = paths
            .iter()
            .enumerate()
            .map(|(i, path)| EntryState {
                id: EntryId::new(format!("order-{i}")).unwrap(),
                path: VaultPath::new(*path).unwrap(),
                kind: if path.ends_with("folder") {
                    EntryKind::Folder
                } else {
                    EntryKind::File
                },
                revision: Revision::new("revision").unwrap(),
                deleted: false,
            })
            .collect();
        let manifest = Manifest::new(source.clone(), entries).unwrap();
        let versions = SemanticVersions::new(
            INDEX_SCHEMA_VERSION,
            document_extraction_version(),
            RESOLVER_VERSION,
            LITERAL_QUERY_VERSION,
        )
        .unwrap();
        let id = IndexSnapshotId::new(
            OperationId::new("order-store").unwrap(),
            OperationId::new("order-epoch").unwrap(),
            1,
            versions,
        )
        .unwrap();
        let fence = PublicationFence::new(source, None, id).unwrap();
        let mut builder = GenerationBuilder::new(manifest.clone(), fence).unwrap();
        for entry in manifest
            .entries()
            .iter()
            .filter(|e| e.kind == EntryKind::File)
        {
            let record =
                IndexRecord::excluded(manifest.witness(&entry.id).unwrap(), Exclusion::Binary);
            builder.add(record).unwrap();
        }
        Arc::new(builder.finish().unwrap().into_parts().1)
    }
    fn prepare(g: Arc<Generation>, sort: SearchSort) -> SearchOrderPreparation {
        let facts: Vec<_> = g
            .manifest()
            .entries()
            .iter()
            .filter(|e| e.kind == EntryKind::File)
            .map(|entry| SearchPresentationFacts {
                entry,
                created_ms: None,
                modified_ms: None,
            })
            .collect();
        SearchOrderPreparation::new(g.clone(), &facts, sort, &mut |_| Ok::<_, ()>(())).unwrap()
    }
    fn finish(mut prep: SearchOrderPreparation, soft: usize) -> SearchOrderPlan {
        loop {
            let before = prep.work_used();
            let mut charged = 0;
            let state = prep
                .pump(soft, &mut |n| {
                    charged += n;
                    Ok::<_, ()>(())
                })
                .unwrap();
            assert_eq!(charged, prep.work_used() - before);
            assert!(charged <= soft + MAX_SEARCH_ORDER_PUMP_WORK);
            assert!(prep.retained_bytes() <= MAX_SEARCH_ORDER_BYTES);
            if state == SearchOrderProgress::Complete {
                return prep.into_plan().ok().unwrap();
            }
        }
    }
    fn paths(plan: &SearchOrderPlan) -> Vec<&str> {
        plan.rows()
            .iter()
            .map(|&r| {
                plan.generation().manifest().entries()[r as usize]
                    .path
                    .as_str()
            })
            .collect()
    }
    #[test]
    fn order_six_sorts_unknown_last_and_primary_only_descending() {
        let g = generation(&["z/alpha.md", "a/Alpha.md", "b/alpha.md", "B.md", "a-folder"]);
        for (sort, expected) in [
            (
                SearchSort::NameAsc,
                vec!["a/Alpha.md", "b/alpha.md", "z/alpha.md", "B.md"],
            ),
            (
                SearchSort::NameDesc,
                vec!["B.md", "a/Alpha.md", "b/alpha.md", "z/alpha.md"],
            ),
            (
                SearchSort::ModifiedAsc,
                vec!["b/alpha.md", "B.md", "a/Alpha.md", "z/alpha.md"],
            ),
            (
                SearchSort::ModifiedDesc,
                vec!["a/Alpha.md", "b/alpha.md", "B.md", "z/alpha.md"],
            ),
            (
                SearchSort::CreatedAsc,
                vec!["a/Alpha.md", "b/alpha.md", "z/alpha.md", "B.md"],
            ),
            (
                SearchSort::CreatedDesc,
                vec!["z/alpha.md", "a/Alpha.md", "b/alpha.md", "B.md"],
            ),
        ] {
            let facts: Vec<_> = g
                .manifest()
                .entries()
                .iter()
                .filter(|e| e.kind == EntryKind::File)
                .map(|entry| {
                    let (created_ms, modified_ms) = match entry.path.as_str() {
                        "a/Alpha.md" => (Some(0), Some(10)),
                        "b/alpha.md" => (Some(0), Some(-1)),
                        "z/alpha.md" => (Some(1), None),
                        _ => (None, Some(-1)),
                    };
                    SearchPresentationFacts {
                        entry,
                        created_ms,
                        modified_ms,
                    }
                })
                .collect();
            let prep =
                SearchOrderPreparation::new(g.clone(), &facts, sort, &mut |_| Ok::<_, ()>(()))
                    .unwrap();
            assert_eq!(prep.candidate_count(), 4);
            assert_eq!(paths(&finish(prep, 1)), expected, "{sort:?}");
        }
    }
    #[test]
    fn order_utf16_lowercase_full_context_and_scalar_safe_pumps() {
        let names = [
            "ΟΣ.md",
            "Οσ.md",
            "Ος.md",
            "Σ.md",
            "AΣ\u{301}.md",
            "AΣ\u{301}B.md",
            "İ.md",
            "i\u{307}.md",
            "\u{10000}.md",
            "\u{e000}.md",
            "ǅΣ.md",
            "A\u{0345}Σ.md",
            "ΟΣ",
            "AΣ\u{301}",
            "AΣ\u{301}-tail",
        ];
        let g = generation(&names);
        let mut expected = names.to_vec();
        // Independent standard-library full-string lowercase/UTF16 oracle.
        expected.sort_by(|a, b| {
            a.to_lowercase()
                .encode_utf16()
                .cmp(b.to_lowercase().encode_utf16())
                .then_with(|| a.encode_utf16().cmp(b.encode_utf16()))
        });
        let plan = finish(prepare(g.clone(), SearchSort::NameAsc), 1);
        assert_eq!(paths(&plan), expected);
        let mut measuring = prepare(g, SearchSort::NameAsc);
        while !matches!(measuring.phase, Phase::Sort) {
            measuring.pump(1, &mut |_| Ok::<_, ()>(())).unwrap();
        }
        for row in &measuring.rows {
            let entry = &measuring.generation.manifest().entries()[row.manifest as usize];
            let lower = &measuring.lower
                [row.lower_start as usize..(row.lower_start + row.lower_len) as usize];
            assert_eq!(
                lower,
                entry
                    .path
                    .file_name()
                    .to_lowercase()
                    .encode_utf16()
                    .collect::<Vec<_>>()
            );
        }
    }
    #[test]
    fn order_exact_path_ties_use_utf16_in_both_directions() {
        let g = generation(&["\u{e000}/same.md", "\u{10000}/same.md", "a/same.md"]);
        for sort in [
            SearchSort::NameAsc,
            SearchSort::NameDesc,
            SearchSort::ModifiedDesc,
        ] {
            assert_eq!(
                paths(&finish(prepare(g.clone(), sort), 3)),
                ["a/same.md", "\u{10000}/same.md", "\u{e000}/same.md"]
            );
        }
    }
    #[test]
    fn order_empty_single_folders_and_immutable_retained_time() {
        for input in [vec![], vec!["folder"], vec!["only.md", "folder"]] {
            let g = generation(&input);
            let expected = input.iter().filter(|p| !p.ends_with("folder")).count();
            let prep = prepare(g.clone(), SearchSort::NameAsc);
            assert!(prep.into_plan().is_err());
            let plan = finish(prepare(g, SearchSort::NameAsc), 1);
            assert_eq!(plan.rows().len(), expected);
            assert!(plan.retained_bytes() < 1024);
        }
        let g = generation(&["A.md", "B.md"]);
        let entries = g.manifest().entries();
        let mut facts = [
            SearchPresentationFacts {
                entry: &entries[0],
                created_ms: Some(10),
                modified_ms: Some(10),
            },
            SearchPresentationFacts {
                entry: &entries[1],
                created_ms: Some(20),
                modified_ms: Some(20),
            },
        ];
        let prep =
            SearchOrderPreparation::new(g.clone(), &facts, SearchSort::ModifiedDesc, &mut |_| {
                Ok::<_, ()>(())
            })
            .unwrap();
        facts[0].modified_ms = Some(1000);
        assert_eq!(paths(&finish(prep, 2)), ["B.md", "A.md"]);
    }
    #[test]
    fn order_malformed_correspondence_safe_time_and_limits_fail_explicitly() {
        let g = generation(&["A.md", "B.md"]);
        let entries = g.manifest().entries();
        fn base(entry: &EntryState) -> SearchPresentationFacts<'_> {
            SearchPresentationFacts {
                entry,
                created_ms: None,
                modified_ms: None,
            }
        }
        for facts in [
            vec![],
            vec![base(&entries[1]), base(&entries[0])],
            vec![base(&entries[0])],
            vec![base(&entries[0]), base(&entries[1]), base(&entries[1])],
        ] {
            assert!(matches!(
                SearchOrderPreparation::new(g.clone(), &facts, SearchSort::NameAsc, &mut |_| Ok::<
                    _,
                    (),
                >(
                    ()
                )),
                Err(SearchOrderError::InvalidFacts(_))
            ));
        }
        for mutation in 0..5 {
            let mut bad = entries[0].clone();
            match mutation {
                0 => bad.id = EntryId::new("different").unwrap(),
                1 => bad.path = VaultPath::new("Other.md").unwrap(),
                2 => bad.revision = Revision::new("other").unwrap(),
                3 => bad.kind = EntryKind::Folder,
                _ => bad.deleted = true,
            }
            assert!(matches!(
                SearchOrderPreparation::new(
                    g.clone(),
                    &[base(&bad), base(&entries[1])],
                    SearchSort::NameAsc,
                    &mut |_| Ok::<_, ()>(())
                ),
                Err(SearchOrderError::InvalidFacts(_))
            ));
        }
        for time in [i64::MIN, -SAFE_INTEGER - 1, SAFE_INTEGER + 1, i64::MAX] {
            let facts = [
                SearchPresentationFacts {
                    entry: &entries[0],
                    created_ms: Some(time),
                    modified_ms: None,
                },
                base(&entries[1]),
            ];
            assert!(matches!(
                SearchOrderPreparation::new(
                    g.clone(),
                    &facts,
                    SearchSort::CreatedAsc,
                    &mut |_| Ok::<_, ()>(())
                ),
                Err(SearchOrderError::InvalidFacts(_))
            ));
        }
        let facts: Vec<_> = (0..=MAX_SEARCH_CANDIDATES)
            .map(|_| base(&entries[0]))
            .collect();
        assert!(matches!(
            SearchOrderPreparation::new(
                g.clone(),
                &facts,
                SearchSort::NameAsc,
                &mut |_| Ok::<_, ()>(())
            ),
            Err(SearchOrderError::Resource(_))
        ));
        let mut prep = prepare(g, SearchSort::NameAsc);
        for soft in [0, MAX_SEARCH_ORDER_PUMP_WORK + 1] {
            assert!(matches!(
                prep.pump(soft, &mut |_| Ok::<_, ()>(())),
                Err(SearchOrderError::Resource(_))
            ));
        }
        prep.work = MAX_SEARCH_ORDER_WORK;
        assert!(matches!(
            prep.pump(1, &mut |_| Ok::<_, ()>(())),
            Err(SearchOrderError::Resource(_))
        ));
    }
    #[test]
    fn order_cancellation_is_checked_before_operation_and_resume_does_not_rescan() {
        let g = generation(&[
            "aa/Long-identical-prefix-😀-A.md",
            "bb/Long-identical-prefix-😀-B.md",
        ]);
        let facts: Vec<_> = g
            .manifest()
            .entries()
            .iter()
            .map(|entry| SearchPresentationFacts {
                entry,
                created_ms: None,
                modified_ms: None,
            })
            .collect();
        assert!(matches!(
            SearchOrderPreparation::new(g.clone(), &facts, SearchSort::NameAsc, &mut |_| Err(
                "cancel"
            )),
            Err(SearchOrderError::Host("cancel"))
        ));
        let reference = finish(prepare(g.clone(), SearchSort::NameAsc), 2);
        let mut prep = prepare(g, SearchSort::NameAsc);
        let mut saw_projection = false;
        let mut saw_comparison = false;
        loop {
            saw_projection |= matches!(prep.phase, Phase::Project);
            saw_comparison |= prep.merge.compare.is_some();
            let before = prep.work_used();
            assert!(matches!(
                prep.pump(1, &mut |n| if n == 0 { Ok(()) } else { Err("cancel") }),
                Err(SearchOrderError::Host("cancel"))
            ));
            assert_eq!(before, prep.work_used());
            if prep.pump(1, &mut |_| Ok::<_, ()>(())).unwrap() == SearchOrderProgress::Complete {
                break;
            }
        }
        let plan = prep.into_plan().ok().unwrap();
        assert!(saw_projection && saw_comparison);
        assert_eq!(plan.rows(), reference.rows());
        assert_eq!(plan.work_used(), reference.work_used());
    }
    #[test]
    fn order_full_lowercase_has_post_call_cancel_and_transient_admission() {
        let g = generation(&["ΟΣ", "İ.md"]);
        let reference = finish(prepare(g.clone(), SearchSort::NameAsc), 1);
        let mut prep = prepare(g, SearchSort::NameAsc);
        while !matches!(prep.phase, Phase::Project) {
            prep.pump(1, &mut |_| Ok::<_, ()>(())).unwrap();
        }
        let mut boundaries = 0;
        let cancelled = prep.pump(1, &mut |n| {
            if n == 0 {
                boundaries += 1;
            }
            if boundaries == 2 {
                Err("after lowercase")
            } else {
                Ok(())
            }
        });
        assert!(matches!(
            cancelled,
            Err(SearchOrderError::Host("after lowercase"))
        ));
        assert!(prep.projection.transient.is_some());
        assert!(prep.retained_bytes() <= MAX_SEARCH_ORDER_BYTES);
        let resumed = finish(prep, 1);
        assert_eq!(resumed.rows(), reference.rows());
        assert_eq!(resumed.work_used(), reference.work_used());

        // The packed key alone fits; its pre-admitted transient does not.
        let name = "A".repeat(MAX_SEARCH_ORDER_BYTES / 7);
        let g = generation(&[&name]);
        let mut prep = prepare(g, SearchSort::NameAsc);
        loop {
            match prep.pump(MAX_SEARCH_ORDER_PUMP_WORK, &mut |_| Ok::<_, ()>(())) {
                Err(SearchOrderError::Resource("search lowercase transient bytes")) => break,
                Ok(SearchOrderProgress::Preparing) => {}
                other => panic!("unexpected transient admission {other:?}"),
            }
        }
        assert!(prep.lower.capacity() > 0);
        assert!(prep.projection.transient.is_none());
        assert!(prep.retained_bytes() <= MAX_SEARCH_ORDER_BYTES);
    }
    #[test]
    fn order_constructor_admission_long_path_blocks_and_folder_visits_are_bounded() {
        // Test the exact boundary without allocating a64MB logical path or
        // millions of folders. Both call sites use this admission counter.
        let path = "p".repeat(130);
        let mut work = MAX_SEARCH_ORDER_ADMISSION_WORK - 2;
        let mut charged = 0;
        assert!(matches!(
            same_bytes(&path, &path, &mut work, &mut |n| {
                charged += n;
                Ok::<_, ()>(())
            }),
            Err(SearchOrderError::Resource("search order admission work"))
        ));
        assert_eq!(charged, 2);
        assert_eq!(work, MAX_SEARCH_ORDER_ADMISSION_WORK);
        let mut folder_work = MAX_SEARCH_ORDER_ADMISSION_WORK - 1;
        charge_admission(&mut folder_work, &mut |_| Ok::<_, ()>(())).unwrap();
        assert!(matches!(
            charge_admission(&mut folder_work, &mut |_| panic!(
                "must reject before the next folder visit"
            )),
            Err(SearchOrderError::<()>::Resource(
                "search order admission work"
            ))
        ));

        // Actual factory correspondence includes a folder gap and many path
        // blocks; host cancellation occurs before the next admitted block.
        let long = format!("z/{}.md", "p".repeat(2048));
        let g = generation(&["a-folder", &long]);
        let facts: Vec<_> = g
            .manifest()
            .entries()
            .iter()
            .filter(|e| e.kind == EntryKind::File)
            .map(|entry| SearchPresentationFacts {
                entry,
                created_ms: None,
                modified_ms: None,
            })
            .collect();
        let mut visits = 0;
        assert!(matches!(
            SearchOrderPreparation::new(g.clone(), &facts, SearchSort::NameAsc, &mut |n| {
                if n == 0 {
                    return Ok(());
                }
                if visits == 8 {
                    return Err("admission cancelled");
                }
                visits += n;
                Ok(())
            }),
            Err(SearchOrderError::Host("admission cancelled"))
        ));
        assert_eq!(visits, 8);
        let prep = prepare(g, SearchSort::NameAsc);
        assert!(prep.work_used() <= MAX_SEARCH_ORDER_ADMISSION_WORK);
        assert_eq!(prep.lower.capacity(), 0);
        assert!(matches!(prep.phase, Phase::Measure));
    }
    #[test]
    fn order_oversize_key_admission_precedes_key_allocation() {
        let huge = format!("{}.md", "A".repeat(MAX_SEARCH_ORDER_BYTES / 2));
        let g = generation(&[&huge]);
        let mut prep = prepare(g, SearchSort::NameAsc);
        loop {
            match prep.pump(MAX_SEARCH_ORDER_PUMP_WORK, &mut |_| Ok::<_, ()>(())) {
                Err(SearchOrderError::Resource(_)) => break,
                Ok(SearchOrderProgress::Preparing) => {}
                other => panic!("unexpected oversized preparation {other:?}"),
            }
        }
        assert_eq!(prep.lower.capacity(), 0);
        assert!(prep.retained_bytes() <= MAX_SEARCH_ORDER_BYTES);
    }
    /// Algorithm control only: the 100k rows/keys are injected into private
    /// state against one tiny valid Generation. This is NOT 100k factory,
    /// retained-namespace admission or client/performance acceptance.
    fn algorithm_control(sort: SearchSort, time_ties: bool, all_ties: bool) {
        const N: usize = 100_000;
        let g = generation(&["Note.md"]);
        let mut p = prepare(g, sort);
        p.rows.clear();
        p.lower.clear();
        p.order.clear();
        p.scratch.clear();
        p.count = N;
        p.rows.reserve_exact(N);
        p.lower.reserve_exact(if all_ties { 7 } else { N * 14 });
        p.order.reserve_exact(N);
        p.scratch.reserve_exact(N);
        for i in 0..N {
            let (start, len) = if all_ties {
                if i == 0 {
                    p.lower.extend("note.md".encode_utf16());
                }
                (0, 7)
            } else {
                let start = p.lower.len() as u32;
                p.lower.extend(format!("note-{i:06}.md").encode_utf16());
                (start, 14)
            };
            p.rows.push(Row {
                lower_start: start,
                lower_len: len,
                basename: 0,
                manifest: 0,
                time: if time_ties {
                    0
                } else if matches!(sort, SearchSort::ModifiedAsc | SearchSort::ModifiedDesc) {
                    (N - i) as i64
                } else {
                    i as i64
                },
                scalars: 0,
                lower_bytes: 0,
            });
            p.order.push(i as u32);
            p.scratch.push(0);
        }
        let mut seed = 0x5eed5123u32;
        for i in (1..N).rev() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            p.order.swap(i, seed as usize % (i + 1));
        }
        let stable_expected = if all_ties {
            Some(p.order.clone())
        } else {
            None
        };
        p.phase = Phase::Sort;
        p.merge = Merge {
            width: 1,
            ..Merge::default()
        };
        p.work = 0;
        assert!(p.retained_bytes() <= MAX_SEARCH_ORDER_BYTES);
        // Drive the same single-unit production sorter and stop before manifest
        // remapping. Small factory tests above cover the public pump boundary.
        while matches!(p.phase, Phase::Sort) {
            charge(&mut p.work, &mut |_| Ok::<_, ()>(())).unwrap();
            p.sort_step();
        }
        assert!(matches!(p.phase, Phase::Finalize(0)));
        if let Some(expected) = stable_expected {
            assert_eq!(p.order, expected);
        } else {
            let descending = if time_ties {
                sort == SearchSort::NameDesc
            } else {
                matches!(
                    sort,
                    SearchSort::NameDesc | SearchSort::ModifiedAsc | SearchSort::CreatedDesc
                )
            };
            for i in 0..N {
                assert_eq!(p.order[i] as usize, if descending { N - 1 - i } else { i });
            }
        }
        assert!(p.work_used() < MAX_SEARCH_ORDER_WORK);
    }
    #[test]
    fn order_100k_independent_index_arithmetic_all_sorts_random_and_time_ties() {
        for sort in [
            SearchSort::NameAsc,
            SearchSort::NameDesc,
            SearchSort::ModifiedAsc,
            SearchSort::ModifiedDesc,
            SearchSort::CreatedAsc,
            SearchSort::CreatedDesc,
        ] {
            algorithm_control(sort, false, false);
            algorithm_control(sort, true, false);
        }
        algorithm_control(SearchSort::NameAsc, true, true);
    }
}
