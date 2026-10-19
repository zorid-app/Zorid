//! Capability-free rich search execution. Hosts own pin/source admission before
//! and after every await and before committing a prepared page. Tokens below
//! have private constructors and are not deserializable caller-authored offsets.
use super::order::{
    SearchOrderError, SearchOrderPlan, SearchOrderPreparation, SearchOrderProgress,
    SearchPresentationFacts,
};
use super::*;
use crate::{
    Exclusion, Generation, IndexError, IndexSnapshotId, MAX_PUMP_BYTES, MAX_PUMP_DOCUMENTS,
};
use std::{
    collections::VecDeque,
    mem::size_of,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use zorid_core::{EntryState, OperationId};

const MAX_DRIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROJECTION_WORK: usize = 2_000_000;
const MAX_PAGE_WORK: usize = 2_000_000;
const MAX_INITIAL_LOCATIONS: usize = 64;

#[derive(Clone, Debug)]
pub struct RichQueryId {
    owner: OperationId,
    serial: u64,
    active: Arc<AtomicBool>,
}
impl PartialEq for RichQueryId {
    fn eq(&self, other: &Self) -> bool {
        self.owner == other.owner && self.serial == other.serial
    }
}
impl Eq for RichQueryId {}
impl RichQueryId {
    /// Callback-safe query retirement: no owner borrow, lock, pin or queue.
    /// Mutable owner operations prune at most4 inactive pure states. Externally
    /// retained drives keep their existing bounded reservation until dropped.
    pub fn retire(&self) {
        self.active.store(false, Ordering::Release);
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RichSearchCursor {
    query: RichQueryId,
    checkpoint: u64,
}
impl RichSearchCursor {
    pub fn query(&self) -> &RichQueryId {
        &self.query
    }
}
#[derive(Clone, Debug)]
pub struct RichTextReadRequest {
    query: RichQueryId,
    generation: Arc<Generation>,
    row: u32,
    digest: [u8; 32],
    bytes: usize,
}
impl PartialEq for RichTextReadRequest {
    fn eq(&self, other: &Self) -> bool {
        self.query == other.query
            && Arc::ptr_eq(&self.generation, &other.generation)
            && self.row == other.row
            && self.digest == other.digest
            && self.bytes == other.bytes
    }
}
impl Eq for RichTextReadRequest {}
impl RichTextReadRequest {
    pub fn snapshot(&self) -> &IndexSnapshotId {
        self.generation.id()
    }
    pub fn entry(&self) -> &EntryState {
        &self.generation.manifest().entries()[self.row as usize]
    }
    pub fn digest(&self) -> &[u8; 32] {
        &self.digest
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RichPageProfile {
    pub chunks: usize,
    pub bytes: usize,
    pub locations_per_chunk: usize,
    pub documents: usize,
    pub source_bytes: usize,
    pub work: usize,
}
impl Default for RichPageProfile {
    fn default() -> Self {
        Self {
            chunks: 100,
            bytes: MAX_SEARCH_PAGE_BYTES,
            locations_per_chunk: MAX_INITIAL_LOCATIONS,
            documents: MAX_PUMP_DOCUMENTS,
            source_bytes: MAX_PUMP_BYTES,
            work: MAX_PAGE_WORK,
        }
    }
}
impl RichPageProfile {
    fn valid(&self) -> bool {
        (1..=MAX_SEARCH_PAGE_CHUNKS).contains(&self.chunks)
            && (1024..=MAX_SEARCH_PAGE_BYTES).contains(&self.bytes)
            && (1..=MAX_INITIAL_LOCATIONS).contains(&self.locations_per_chunk)
            && (1..=MAX_PUMP_DOCUMENTS).contains(&self.documents)
            && (1..=MAX_PUMP_BYTES).contains(&self.source_bytes)
            && (1..=MAX_PAGE_WORK).contains(&self.work)
    }
}
#[derive(Debug)]
pub enum RichSearchError<E> {
    Host(E),
    Compile(SearchDiagnostic),
    Index(IndexError),
    Resource(&'static str),
    Invalid(&'static str),
    Expired,
    Busy,
}
fn order_error<E>(e: SearchOrderError<E>) -> RichSearchError<E> {
    match e {
        SearchOrderError::Host(e) => RichSearchError::Host(e),
        SearchOrderError::InvalidFacts(s) => RichSearchError::Invalid(s),
        SearchOrderError::Resource(s) => RichSearchError::Resource(s),
    }
}
fn search_error<E>(e: SearchError<E>) -> RichSearchError<E> {
    match e {
        SearchError::Host(e) => RichSearchError::Host(e),
        SearchError::Resource(s) => RichSearchError::Resource(s),
        SearchError::InvalidDocument(s) => RichSearchError::Invalid(s),
    }
}

// Reservations outlive owner removal while a drive retains the pure data. Arc
// sharing does not pretend an eviction immediately frees physical allocation.
struct Reservation {
    total: Arc<AtomicUsize>,
    bytes: AtomicUsize,
}
impl Reservation {
    fn new(total: Arc<AtomicUsize>, bytes: usize) -> Option<Self> {
        total
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(bytes)
                    .filter(|&n| n <= MAX_SEARCH_OWNED_BYTES)
            })
            .ok()?;
        Some(Self {
            total,
            bytes: AtomicUsize::new(bytes),
        })
    }
    fn shrink(&self, bytes: usize) {
        let old = self.bytes.load(Ordering::Acquire);
        debug_assert!(bytes <= old);
        if bytes < old {
            self.total.fetch_sub(old - bytes, Ordering::AcqRel);
            self.bytes.store(bytes, Ordering::Release);
        }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.total
            .fetch_sub(self.bytes.load(Ordering::Acquire), Ordering::AcqRel);
    }
}
struct QueryData {
    id: RichQueryId,
    generation: Arc<Generation>,
    compiled: CompiledSearchQuery,
    generation_coverage: bool,
    spec: SearchSpec,
    profile: RichPageProfile,
    live: Arc<AtomicBool>,
    busy: AtomicBool,
    reservation: Reservation,
}
struct DriveLease(Arc<QueryData>);
impl Drop for DriveLease {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Position {
    row: usize,
    location: usize,
    chunk: u32,
    counted: bool,
    files: u64,
    occurrences: u64,
    evaluated: u32,
    unavailable: u32,
}
struct Checkpoint {
    id: u64,
    parent: Option<u64>,
    position: Position,
}
enum OrderState {
    Preparing(SearchOrderPreparation),
    Ready(Arc<SearchOrderPlan>),
}
struct QueryState {
    data: Arc<QueryData>,
    order: Option<OrderState>,
    checkpoints: VecDeque<Checkpoint>,
    next_checkpoint: u64,
}
/// One vault/session owner. It contains no pins, transaction or source reader.
/// Host close/rebuild/provider replacement calls clear(); closing a query pin
/// separately expires its mapped query IDs, never authorizes another pin.
pub struct RichSearchOwner {
    nonce: OperationId,
    next_query: u64,
    states: Vec<QueryState>,
    total: Arc<AtomicUsize>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RichPreparation {
    Preparing,
    Ready(RichSearchCursor),
}
impl RichSearchOwner {
    pub fn new(fresh_owner_nonce: OperationId) -> Self {
        Self {
            nonce: fresh_owner_nonce,
            next_query: 1,
            states: Vec::new(),
            total: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub fn retained_bytes(&self) -> usize {
        self.total.load(Ordering::Acquire)
    }
    fn prune_retired(&mut self) {
        self.states
            .retain(|state| state.data.live.load(Ordering::Acquire));
    }
    pub fn clear(&mut self) {
        for q in &self.states {
            q.data.live.store(false, Ordering::Release);
        }
        self.states.clear();
    }
    pub fn close_query(&mut self, id: &RichQueryId) -> bool {
        if let Some(at) = self.states.iter().position(|q| q.data.id == *id) {
            let q = self.states.remove(at);
            q.data.live.store(false, Ordering::Release);
            self.prune_retired();
            true
        } else {
            self.prune_retired();
            false
        }
    }
    pub fn start_query<E>(
        &mut self,
        generation: Arc<Generation>,
        spec: SearchSpec,
        facts: &[SearchPresentationFacts<'_>],
        profile: RichPageProfile,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<RichQueryId, RichSearchError<E>> {
        self.prune_retired();
        let result = self.start_query_inner(generation, spec, facts, profile, &mut check);
        self.prune_retired();
        result
    }
    fn start_query_inner<E>(
        &mut self,
        generation: Arc<Generation>,
        spec: SearchSpec,
        facts: &[SearchPresentationFacts<'_>],
        profile: RichPageProfile,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<RichQueryId, RichSearchError<E>> {
        check(0).map_err(RichSearchError::Host)?;
        self.prune_retired();
        if !profile.valid() {
            return Err(RichSearchError::Invalid("search page profile"));
        }
        if self.states.len() >= MAX_SEARCH_QUERIES {
            return Err(RichSearchError::Resource("search query count"));
        }
        // Pre-admit the documented maximum regex components and order storage
        // before compilation/copy; expensive queries may reduce the count below4.
        let provisional = 16 * 1024 * 1024 + MAX_SEARCH_ORDER_BYTES + 512 * 1024;
        let reservation = Reservation::new(self.total.clone(), provisional)
            .ok_or(RichSearchError::Resource("search owner bytes"))?;
        let compiled = CompiledSearchQuery::compile(
            &spec.query,
            SearchOptions {
                case_sensitive: spec.case_sensitive,
            },
            SearchLimits::default(),
        )
        .map_err(RichSearchError::Compile)?;
        let order = SearchOrderPreparation::new(generation.clone(), facts, spec.sort, &mut check)
            .map_err(order_error)?;
        check(facts.len().saturating_add(1)).map_err(RichSearchError::Host)?;
        let generation_coverage = generation.coverage_complete();
        check(0).map_err(RichSearchError::Host)?;
        let fixed = size_of::<QueryData>()
            + size_of::<QueryState>()
            + size_of::<Checkpoint>() * MAX_SEARCH_CHECKPOINTS
            + spec.query.capacity()
            + compiled.retained_bytes()
            + self.nonce.as_str().len()
            // One shared retirement flag allocation, including Arc header and
            // conservative allocator alignment; token clones share this flag.
            + 8*size_of::<usize>()
            + 4096;
        let retained = fixed
            .checked_add(MAX_SEARCH_ORDER_BYTES)
            .ok_or(RichSearchError::Resource("search owner bytes"))?;
        if retained > provisional {
            return Err(RichSearchError::Resource("search query reservation"));
        }
        reservation.shrink(retained);
        let id = RichQueryId {
            owner: self.nonce.clone(),
            serial: self.next_query,
            active: Arc::new(AtomicBool::new(true)),
        };
        self.next_query = self
            .next_query
            .checked_add(1)
            .ok_or(RichSearchError::Resource("search query sequence"))?;
        self.states.push(QueryState {
            data: Arc::new(QueryData {
                id: id.clone(),
                generation,
                compiled,
                generation_coverage,
                spec,
                profile,
                live: id.active.clone(),
                busy: AtomicBool::new(false),
                reservation,
            }),
            order: Some(OrderState::Preparing(order)),
            checkpoints: VecDeque::with_capacity(MAX_SEARCH_CHECKPOINTS),
            next_checkpoint: 1,
        });
        Ok(id)
    }
    pub fn prepare_query<E>(
        &mut self,
        id: &RichQueryId,
        soft_work: usize,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<RichPreparation, RichSearchError<E>> {
        self.prune_retired();
        let result = self.prepare_query_inner(id, soft_work, &mut check);
        self.prune_retired();
        result
    }
    fn prepare_query_inner<E>(
        &mut self,
        id: &RichQueryId,
        soft_work: usize,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<RichPreparation, RichSearchError<E>> {
        let state = self
            .states
            .iter_mut()
            .find(|s| s.data.id == *id)
            .ok_or(RichSearchError::Expired)?;
        check(0).map_err(RichSearchError::Host)?;
        if !state.data.live.load(Ordering::Acquire) {
            return Err(RichSearchError::Expired);
        }
        if let Some(OrderState::Preparing(prep)) = &mut state.order {
            if prep.pump(soft_work, &mut check).map_err(order_error)?
                == SearchOrderProgress::Preparing
            {
                if !state.data.live.load(Ordering::Acquire) {
                    return Err(RichSearchError::Expired);
                }
                return Ok(RichPreparation::Preparing);
            }
            let Some(OrderState::Preparing(prep)) = state.order.take() else {
                unreachable!()
            };
            let plan = prep
                .into_plan()
                .map_err(|_| RichSearchError::Invalid("unfinished order"))?;
            let held = state.data.reservation.bytes.load(Ordering::Acquire);
            state
                .data
                .reservation
                .shrink(held - MAX_SEARCH_ORDER_BYTES + plan.retained_bytes());
            state.order = Some(OrderState::Ready(Arc::new(plan)));
            state.checkpoints.push_back(Checkpoint {
                id: 0,
                parent: None,
                position: Position::default(),
            });
        }
        if !state.data.live.load(Ordering::Acquire) {
            return Err(RichSearchError::Expired);
        }
        if !state.checkpoints.iter().any(|p| p.id == 0) {
            return Err(RichSearchError::Expired);
        }
        Ok(RichPreparation::Ready(RichSearchCursor {
            query: id.clone(),
            checkpoint: 0,
        }))
    }
    pub fn open_drive<E>(
        &self,
        cursor: &RichSearchCursor,
    ) -> Result<RichSearchDrive, RichSearchError<E>> {
        let state = self
            .states
            .iter()
            .find(|s| s.data.id == cursor.query)
            .ok_or(RichSearchError::Expired)?;
        if !state.data.live.load(Ordering::Acquire) {
            return Err(RichSearchError::Expired);
        }
        let position = state
            .checkpoints
            .iter()
            .find(|p| p.id == cursor.checkpoint)
            .ok_or(RichSearchError::Expired)?
            .position
            .clone();
        let Some(OrderState::Ready(order)) = &state.order else {
            return Err(RichSearchError::Invalid("search order preparing"));
        };
        let reservation = Reservation::new(self.total.clone(), MAX_DRIVE_BYTES)
            .ok_or(RichSearchError::Resource("search drive bytes"))?;
        state
            .data
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| RichSearchError::Busy)?;
        let lease = DriveLease(state.data.clone());
        let mut drive = RichSearchDrive {
            lease,
            order: order.clone(),
            input: cursor.clone(),
            initial: position.clone(),
            position,
            request: None,
            files: Vec::with_capacity(state.data.profile.chunks),
            owned_files: 0,
            work: SearchPageWork::default(),
            breakdown: RichSearchWorkBreakdown::default(),
            blocked: false,
            failed: false,
            terminal: None,
            sealed_page: None,
            envelope_ready: false,
            bytes: 0,
            reservation,
        };
        drive.owned_files = drive.files.capacity() * size_of::<SearchFileChunk>();
        Ok(drive)
    }
    pub fn commit<E>(
        &mut self,
        prepared: PreparedRichSearchPage,
    ) -> Result<CommittedRichSearchPage, RichSearchError<E>> {
        self.prune_retired();
        let state = self
            .states
            .iter_mut()
            .find(|s| s.data.id == prepared.input.query)
            .ok_or(RichSearchError::Expired)?;
        if !state.data.live.load(Ordering::Acquire)
            || !state
                .checkpoints
                .iter()
                .any(|p| p.id == prepared.input.checkpoint)
        {
            return Err(RichSearchError::Expired);
        }
        let next = if prepared.page.complete
            || prepared.position.row == prepared.candidates && !prepared.position.counted
        {
            None
        } else {
            let existing = state
                .checkpoints
                .iter()
                .find(|p| p.parent == Some(prepared.input.checkpoint));
            let id = if let Some(existing) = existing {
                if existing.position != prepared.position {
                    return Err(RichSearchError::Invalid("non-deterministic search retry"));
                }
                existing.id
            } else {
                let id = state.next_checkpoint;
                state.next_checkpoint = state
                    .next_checkpoint
                    .checked_add(1)
                    .ok_or(RichSearchError::Resource("search checkpoint sequence"))?;
                if state.checkpoints.len() == MAX_SEARCH_CHECKPOINTS {
                    state.checkpoints.pop_front();
                }
                state.checkpoints.push_back(Checkpoint {
                    id,
                    parent: Some(prepared.input.checkpoint),
                    position: prepared.position.clone(),
                });
                id
            };
            Some(RichSearchCursor {
                query: state.data.id.clone(),
                checkpoint: id,
            })
        };
        Ok(CommittedRichSearchPage {
            page: prepared.page,
            next,
        })
    }
}
impl Drop for RichSearchOwner {
    fn drop(&mut self) {
        self.clear();
    }
}
/// After commit these DTO allocations are caller-owned result/transport data.
/// Hosts must separately bound retained results and <=1MiB encoded inner pages.
pub struct CommittedRichSearchPage {
    pub page: DocumentRichSearchPage,
    pub next: Option<RichSearchCursor>,
}
/// Kept private until owner commit validates lifetime and checkpoint admission.
pub struct PreparedRichSearchPage {
    input: RichSearchCursor,
    position: Position,
    candidates: usize,
    page: DocumentRichSearchPage,
    _lease: DriveLease,
    _reservation: Reservation,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RichSearchAction {
    ReadText(RichTextReadRequest),
    Yield,
    Done,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RichSearchWorkBreakdown {
    pub engine_units: u64,
    pub presentation_units: u64,
    pub source_validation_units: u64,
}
pub struct RichSearchDrive {
    lease: DriveLease,
    order: Arc<SearchOrderPlan>,
    input: RichSearchCursor,
    initial: Position,
    position: Position,
    request: Option<RichTextReadRequest>,
    files: Vec<SearchFileChunk>,
    owned_files: usize,
    work: SearchPageWork,
    breakdown: RichSearchWorkBreakdown,
    blocked: bool,
    failed: bool,
    terminal: Option<bool>,
    sealed_page: Option<DocumentRichSearchPage>,
    envelope_ready: bool,
    bytes: usize,
    reservation: Reservation,
}
impl RichSearchDrive {
    pub fn work_breakdown(&self) -> &RichSearchWorkBreakdown {
        &self.breakdown
    }
    fn data(&self) -> &QueryData {
        &self.lease.0
    }
    fn live<E>(
        &self,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        check(0).map_err(RichSearchError::Host)?;
        if !self.data().live.load(Ordering::Acquire) {
            Err(RichSearchError::Expired)
        } else {
            Ok(())
        }
    }
    pub fn next_action<E>(
        &mut self,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<RichSearchAction, RichSearchError<E>> {
        if self.failed {
            return Err(RichSearchError::Invalid("failed search drive"));
        }
        let mut result = self.next_action_inner(&mut check);
        if self.terminal.is_none()
            && matches!(
                &result,
                Ok(RichSearchAction::Yield | RichSearchAction::Done)
            )
        {
            if let Err(error) = self.seal_terminal(&mut check) {
                result = Err(error);
            } else {
                self.terminal = Some(matches!(&result, Ok(RichSearchAction::Done)));
            }
        }
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn next_action_inner<E>(
        &mut self,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<RichSearchAction, RichSearchError<E>> {
        self.live(&mut check)?;
        if let Some(done) = self.terminal {
            return Ok(if done {
                RichSearchAction::Done
            } else {
                RichSearchAction::Yield
            });
        }
        if !self.envelope_ready {
            self.prepare_envelope(&mut check)?;
        }
        if let Some(request) = &self.request {
            return Ok(RichSearchAction::ReadText(request.clone()));
        }
        loop {
            if self.position.row == self.order.rows().len() {
                return Ok(RichSearchAction::Done);
            }
            let profile = &self.data().profile;
            if self.blocked
                || self.files.len() >= profile.chunks
                || self.work.documents as usize >= profile.documents
                || self.work.documents > 0 && self.work.units >= profile.work as u64
            {
                return Ok(RichSearchAction::Yield);
            }
            let row = self.order.rows()[self.position.row];
            let entry = &self.data().generation.manifest().entries()[row as usize];
            let record = self.data().generation.record(&entry.id);
            if self.data().compiled.requirements().content {
                if let Some(record) = record.filter(|r| r.text_digest().is_some()) {
                    if self.work.documents > 0
                        && self.work.source_bytes + record.text_bytes() as u64
                            > profile.source_bytes as u64
                    {
                        return Ok(RichSearchAction::Yield);
                    }
                    let request = RichTextReadRequest {
                        query: self.data().id.clone(),
                        generation: self.data().generation.clone(),
                        row,
                        digest: *record.text_digest().unwrap(),
                        bytes: record.text_bytes(),
                    };
                    self.request = Some(request.clone());
                    return Ok(RichSearchAction::ReadText(request));
                }
            }
            self.evaluate_row(None, &mut check)?;
        }
    }
    pub fn accept_text<E>(
        &mut self,
        request: &RichTextReadRequest,
        bytes: &[u8],
        check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        if self.failed {
            return Err(RichSearchError::Invalid("failed search drive"));
        }
        if self.terminal.is_some() {
            self.failed = true;
            return Err(RichSearchError::Invalid("terminal search drive"));
        }
        let result = self.accept_text_inner(request, bytes, check);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn accept_text_inner<E>(
        &mut self,
        request: &RichTextReadRequest,
        bytes: &[u8],
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        self.live(&mut check)?;
        if self.request.as_ref() != Some(request) {
            return Err(RichSearchError::Invalid("search read request"));
        }
        if bytes.len() > zorid_document::MAX_SOURCE_BYTES {
            return Err(RichSearchError::Index(IndexError::ContentMismatch));
        }
        let units = 3usize.saturating_mul(1 + bytes.len() / 64);
        check(units).map_err(RichSearchError::Host)?;
        let record = self
            .data()
            .generation
            .record(&request.entry().id)
            .ok_or(RichSearchError::Index(IndexError::InvalidRecord))?;
        record.check_text(bytes).map_err(RichSearchError::Index)?;
        let text = std::str::from_utf8(bytes)
            .map_err(|_| RichSearchError::Index(IndexError::ContentMismatch))?;
        if text.contains('\0') {
            return Err(RichSearchError::Index(IndexError::ContentMismatch));
        }
        check(0).map_err(RichSearchError::Host)?;
        self.work.units += units as u64;
        self.breakdown.source_validation_units += units as u64;
        self.work.source_bytes += bytes.len() as u64;
        self.evaluate_row(Some(text), &mut check)?;
        self.request = None;
        Ok(())
    }
    fn evaluate_row<E>(
        &mut self,
        text: Option<&str>,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        let row = self.order.rows()[self.position.row];
        // A short clone of the shared data avoids borrowing the mutable drive
        // across pure evaluation. It contains no capability or text body.
        let data = self.lease.0.clone();
        let entry = &data.generation.manifest().entries()[row as usize];
        let record = data.generation.record(&entry.id);
        let source = if let Some(text) = text {
            SearchSource::Text(text)
        } else if record.is_some_and(|r| r.exclusion() == Some(&Exclusion::Binary)) {
            SearchSource::NotText
        } else {
            SearchSource::Unavailable
        };
        let metadata = match record {
            Some(r) if r.metadata().is_some() => {
                SearchMetadataInput::Present(r.metadata().unwrap())
            }
            Some(r) if r.exclusion().is_none() || r.exclusion() == Some(&Exclusion::Binary) => {
                SearchMetadataInput::NotApplicable
            }
            _ => SearchMetadataInput::Unavailable,
        };
        let mut units = 0usize;
        let outcome = data
            .compiled
            .evaluate_checked(
                SearchDocument {
                    path: entry.path.as_str(),
                    source,
                    metadata,
                },
                |n| {
                    check(n)?;
                    units = units.saturating_add(n);
                    Ok(())
                },
            )
            .map_err(search_error)?;
        self.work.units = self.work.units.saturating_add(units as u64);
        self.breakdown.engine_units = self.breakdown.engine_units.saturating_add(units as u64);
        self.work.documents += 1;
        if !self.position.counted {
            self.position.evaluated += 1;
        }
        match outcome {
            SearchEvaluation::NoMatch => self.advance(),
            SearchEvaluation::Unavailable(_) => {
                if !self.position.counted {
                    self.position.unavailable += 1;
                }
                self.advance();
            }
            SearchEvaluation::Match(matches) => {
                if !self.position.counted {
                    self.position.files += 1;
                    self.position.occurrences = self
                        .position
                        .occurrences
                        .checked_add(matches.occurrence_count as u64)
                        .ok_or(RichSearchError::Resource("search occurrence total"))?;
                    self.position.counted = true;
                }
                self.emit_matches(
                    entry,
                    &matches,
                    SearchDocument {
                        path: entry.path.as_str(),
                        source,
                        metadata,
                    },
                    check,
                )?;
            }
        }
        Ok(())
    }
    fn advance(&mut self) {
        self.position.row += 1;
        self.position.location = 0;
        self.position.chunk = 0;
        self.position.counted = false;
    }
    fn emit_matches<E>(
        &mut self,
        entry: &EntryState,
        matches: &SearchMatches,
        document: SearchDocument<'_>,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        if self.position.location > matches.locations_len() {
            return Err(RichSearchError::Invalid("search continuation location"));
        }
        let mut projection = matches
            .locations_len()
            .saturating_add(matches.properties.len())
            .saturating_add(matches.tags.len())
            .saturating_add(1);
        if projection > MAX_PROJECTION_WORK {
            return Err(RichSearchError::Resource("search projection work"));
        }
        check(projection).map_err(RichSearchError::Host)?;
        self.work.units = self.work.units.saturating_add(projection as u64);
        self.breakdown.presentation_units = self
            .breakdown
            .presentation_units
            .saturating_add(projection as u64);
        let matches_bytes = matches.retained_bytes();
        if matches_bytes.saturating_add(self.owned_files) > MAX_DRIVE_BYTES - 2 * 1024 * 1024 {
            return Err(RichSearchError::Resource("search pending result bytes"));
        }
        let mut batch_limit = self.data().profile.locations_per_chunk;
        loop {
            if self.files.len() >= self.data().profile.chunks {
                self.blocked = true;
                return Ok(());
            }
            let end = (self.position.location + batch_limit).min(matches.locations_len());
            let visits = end - self.position.location;
            let last = end == matches.locations_len();
            let projection_before = projection;
            let candidate = (|| -> Result<(SearchFileChunk, usize, usize), RichSearchError<E>> {
                let mut charge = |n: usize| -> Result<(), SearchError<E>> {
                    let next = projection
                        .checked_add(n)
                        .filter(|&n| n <= MAX_PROJECTION_WORK)
                        .ok_or(SearchError::Resource("search projection work"))?;
                    check(n).map_err(SearchError::Host)?;
                    projection = next;
                    Ok(())
                };
                charge(visits).map_err(search_error)?;
                // Before lazy locator cloning, pre-admit exact bounded locator copies. Oversize derived rows are explicit resource failures.
                let copy_bound = (self.position.location..end)
                    .try_fold(0usize, |n, i| {
                        location_owned_bytes(matches, i).and_then(|b| n.checked_add(b))
                    })
                    .ok_or(RichSearchError::Resource("search locator allocation"))?;
                if matches_bytes
                    .saturating_add(self.owned_files)
                    .saturating_add(copy_bound)
                    > MAX_DRIVE_BYTES - 2 * 1024 * 1024
                {
                    return Err(RichSearchError::Resource("search locator chunk bytes"));
                }
                charge(copy_bound / 64).map_err(search_error)?;
                let locations = (self.position.location..end)
                    .map(|n| {
                        matches
                            .location(n)
                            .ok_or(RichSearchError::Invalid("search location proof"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let super::snippet::SnippetChunk {
                    locations,
                    snippets,
                } = super::snippet::snippets_checked(
                    matches,
                    locations,
                    SearchDocument {
                        path: document.path,
                        source: document.source,
                        metadata: document.metadata,
                    },
                    self.data().spec.context,
                    MAX_DRIVE_BYTES
                        .saturating_sub(matches_bytes)
                        .saturating_sub(self.owned_files)
                        .saturating_sub(copy_bound)
                        .saturating_sub(1024 * 1024),
                    |n| charge(n),
                )
                .map_err(|e| match e {
                    SearchError::Host(e) => search_error(e),
                    SearchError::Resource(s) => RichSearchError::Resource(s),
                    SearchError::InvalidDocument(s) => RichSearchError::Invalid(s),
                })?;
                charge(1 + entry.path.as_str().len() / 64).map_err(search_error)?;
                if entry.path.as_str().len() > self.data().profile.bytes {
                    return Err(RichSearchError::Resource("search output entry bytes"));
                }
                let chunk = SearchFileChunk {
                    entry: entry.clone(),
                    chunk: self.position.chunk,
                    last_chunk: last,
                    occurrence_count: matches.occurrence_count,
                    locations,
                    snippets,
                };
                charge(
                    chunk
                        .locations
                        .len()
                        .saturating_mul(2)
                        .saturating_add(chunk.snippets.len().saturating_mul(2)),
                )
                .map_err(search_error)?;
                for snippet in &chunk.snippets {
                    charge(snippet.highlights.len()).map_err(search_error)?;
                }
                let chunk_heap = chunk_retained(&chunk);
                if matches_bytes
                    .saturating_add(self.owned_files)
                    .saturating_add(chunk_heap)
                    > MAX_DRIVE_BYTES - 1024 * 1024
                {
                    return Err(RichSearchError::Resource("search projected retained bytes"));
                }
                charge(1 + chunk_heap.saturating_mul(6) / 64).map_err(search_error)?;
                let bytes = encoded_size(&chunk, MAX_SEARCH_PAGE_BYTES)
                    .unwrap_or(MAX_SEARCH_PAGE_BYTES + 1)
                    + 1;
                charge(1 + bytes / 64).map_err(search_error)?;
                Ok((chunk, bytes, chunk_heap))
            })();
            self.work.units = self
                .work
                .units
                .saturating_add((projection - projection_before) as u64);
            self.breakdown.presentation_units = self
                .breakdown
                .presentation_units
                .saturating_add((projection - projection_before) as u64);
            let (chunk, bytes, chunk_heap) = match candidate {
                Ok(candidate) => candidate,
                Err(RichSearchError::Resource(_)) if !self.files.is_empty() => {
                    self.blocked = true;
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            if self.bytes + bytes > self.data().profile.bytes {
                if self.files.is_empty() {
                    if visits > 1 {
                        batch_limit = (visits / 2).max(1);
                        continue;
                    }
                    return Err(RichSearchError::Resource("search output chunk bytes"));
                }
                self.blocked = true;
                return Ok(());
            }
            self.bytes += bytes;
            self.owned_files = self
                .owned_files
                .saturating_add(chunk_heap - size_of::<SearchFileChunk>());
            self.files.push(chunk);
            self.position.location = end;
            self.position.chunk = self
                .position
                .chunk
                .checked_add(1)
                .ok_or(RichSearchError::Resource("search chunk sequence"))?;
            if last {
                self.advance();
                return Ok(());
            }
        }
    }
    fn page_with(&self, files: Vec<SearchFileChunk>) -> DocumentRichSearchPage {
        // Whole-file evaluation/count coverage is independent of pending output.
        let scan_complete = self.position.evaluated as usize == self.order.rows().len();
        let query_complete = self.position.unavailable == 0;
        let output_complete = !self.position.counted;
        let exact = scan_complete && query_complete;
        let count = |value| {
            if exact {
                SearchCount::Exact { value }
            } else {
                SearchCount::AtLeast { value }
            }
        };
        DocumentRichSearchPage {
            snapshot: self.data().generation.id().clone(),
            next: (),
            scan_complete,
            coverage_complete: self.data().generation_coverage,
            complete: scan_complete && query_complete && output_complete,
            dialect: SEARCH_DIALECT.into(),
            spec: self.data().spec.clone(),
            explanation: self
                .data()
                .spec
                .explain
                .then(|| self.data().compiled.explanation()),
            files,
            totals: SearchTotals {
                files: count(self.position.files),
                occurrences: count(self.position.occurrences),
            },
            coverage: SearchQueryCoverage {
                candidate_files: self.order.rows().len() as u32,
                evaluated_files: self.position.evaluated,
                unavailable_files: self.position.unavailable,
                scan_complete,
                query_coverage_complete: query_complete,
            },
            output_complete,
            work: self.work.clone(),
        }
    }
    fn envelope_charge<E>(
        &mut self,
        check: &mut impl FnMut(usize) -> Result<(), E>,
        file_bytes: usize,
    ) -> Result<(), RichSearchError<E>> {
        // The explanatory tree is bounded by compiled node admission. Charge
        // visits before walking capacities, then bytes before cloning/encoding.
        let nodes = if self.data().spec.explain {
            self.data().compiled.limits.nodes
        } else {
            0
        };
        check(nodes).map_err(RichSearchError::Host)?;
        let explanation = if self.data().spec.explain {
            self.data()
                .compiled
                .explanation
                .as_ref()
                .map_or(0, super::parser::explanation_retained_bytes)
        } else {
            0
        };
        let units = nodes.saturating_add(64).saturating_add(
            file_bytes
                .saturating_mul(6)
                .saturating_add(explanation.saturating_mul(6))
                .saturating_add(self.data().spec.query.len().saturating_mul(6))
                / 64,
        );
        check(units - nodes).map_err(RichSearchError::Host)?;
        self.work.units = self.work.units.saturating_add(units as u64);
        self.breakdown.presentation_units = self
            .breakdown
            .presentation_units
            .saturating_add(units as u64);
        Ok(())
    }
    fn prepare_envelope<E>(
        &mut self,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        self.envelope_charge(check, 0)?;
        self.bytes = encoded_size(&self.page_with(Vec::new()), MAX_SEARCH_PAGE_BYTES)
            .ok_or(RichSearchError::Resource("search page envelope"))?
            .saturating_add(1024);
        check(0).map_err(RichSearchError::Host)?;
        if self.bytes > self.data().profile.bytes {
            return Err(RichSearchError::Resource("search page envelope"));
        }
        self.envelope_ready = true;
        Ok(())
    }
    fn seal_terminal<E>(
        &mut self,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        self.envelope_charge(check, self.owned_files)?;
        let files = std::mem::take(&mut self.files);
        let page = self.page_with(files);
        if encoded_size(&page, self.data().profile.bytes).is_none() {
            return Err(RichSearchError::Resource("search page bytes"));
        }
        check(0).map_err(RichSearchError::Host)?;
        self.sealed_page = Some(page);
        Ok(())
    }
    pub fn finish<E>(mut self) -> Result<PreparedRichSearchPage, RichSearchError<E>> {
        if self.failed {
            return Err(RichSearchError::Invalid("failed search drive"));
        }
        if !self.data().live.load(Ordering::Acquire) {
            return Err(RichSearchError::Expired);
        }
        if self.request.is_some() {
            return Err(RichSearchError::Invalid("unaccepted search read"));
        }
        if self.terminal.is_none() {
            return Err(RichSearchError::Invalid("unfinished search drive"));
        }
        if self.position == self.initial && self.position.row < self.order.rows().len() {
            return Err(RichSearchError::Invalid("search page made no progress"));
        }
        let page = self
            .sealed_page
            .take()
            .ok_or(RichSearchError::Invalid("unsealed search page"))?;
        Ok(PreparedRichSearchPage {
            input: self.input,
            position: self.position,
            candidates: self.order.rows().len(),
            page,
            _lease: self.lease,
            _reservation: self.reservation,
        })
    }
}

fn location_owned_bytes(matches: &SearchMatches, index: usize) -> Option<usize> {
    use super::proof::LocationProof;
    let proof = matches.locations.get(index)?;
    let mut bytes = size_of::<SearchLocation>();
    match proof {
        LocationProof::Key {
            property,
            key_match,
            ..
        } => {
            bytes = bytes.checked_add(matches.properties.get(*property)?.key.len())?;
            if let SearchKeyMatch::Ranges { ranges } = key_match {
                bytes = bytes.checked_add(
                    ranges
                        .len()
                        .checked_mul(size_of::<zorid_document::SourceRange>())?,
                )?;
            }
        }
        LocationProof::Value { property, .. } => {
            let p = matches.properties.get(*property)?;
            bytes = bytes
                .checked_add(p.key.len())?
                .checked_add(p.array_path.len().checked_mul(4)?)?
                .checked_add(p.value.as_ref()?.text.len())?;
        }
        _ => {}
    }
    Some(bytes)
}
fn location_retained(l: &SearchLocation) -> usize {
    size_of::<SearchLocation>()
        + match &l.locator {
            SearchLocator::PropertyKey { key, key_match } => {
                key.capacity()
                    + match key_match {
                        SearchKeyMatch::Ranges { ranges } => {
                            ranges.capacity() * size_of::<zorid_document::SourceRange>()
                        }
                        _ => 0,
                    }
            }
            SearchLocator::PropertyValue {
                key,
                array_path,
                value_text,
                ..
            } => key.capacity() + array_path.capacity() * 4 + value_text.capacity(),
            _ => 0,
        }
}
fn chunk_retained(c: &SearchFileChunk) -> usize {
    size_of::<SearchFileChunk>()
        + c.entry.id.as_str().len()
        + c.entry.revision.as_str().len()
        + c.entry.path.as_str().len()
        + c.locations.capacity() * size_of::<SearchLocation>()
        + c.locations
            .iter()
            .map(|l| location_retained(l) - size_of::<SearchLocation>())
            .sum::<usize>()
        + c.snippets.capacity() * size_of::<SearchSnippet>()
        + c.snippets
            .iter()
            .map(|s| {
                s.text.capacity()
                    + s.key.as_ref().map_or(0, String::capacity)
                    + s.array_path.as_ref().map_or(0, |v| v.capacity() * 4)
                    + s.highlights.capacity() * size_of::<SearchSnippetHighlight>()
                    + s.highlights
                        .iter()
                        .map(|h| h.location_indices.capacity() * 4)
                        .sum::<usize>()
            })
            .sum::<usize>()
}
/// Count exact JSON bytes without allocating an oversized transient encoding.
fn encoded_size<T: serde::Serialize>(value: &T, maximum: usize) -> Option<usize> {
    struct Counter {
        bytes: usize,
        maximum: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self
                .bytes
                .checked_add(bytes.len())
                .filter(|&n| n <= self.maximum)
                .ok_or_else(|| std::io::Error::other("search output bound"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0, maximum };
    serde_json::to_writer(&mut counter, value).ok()?;
    Some(counter.bytes)
}
