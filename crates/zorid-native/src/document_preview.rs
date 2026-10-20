//! First-build Base previews over a sealed postcommit Store capture.
//!
//! One concrete 32 MiB ledger owns captures and query/result guards, separately
//! from Search. No pin, publication capability, source write or answer cache.
use super::NativeVault;
use crate::document_api::*;
use serde::Serialize;
use std::io::{self, Write};
use std::mem::size_of;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex, Weak,
};
use zorid_bases::{BasePreviewResult, FilePresentationFacts, RecordWitness};
use zorid_core::{EntryId, OperationId};
use zorid_index::{IndexError, PreviewCaptureError};
use zorid_store::{DocumentPreviewCapture, DocumentPreviewCaptureRequest};
const MAX_OWNED: usize = 32 * 1024 * 1024;
const MAX_QUERY: usize = 8 * 1024 * 1024;
const MAX_HANDLES: usize = 128; //32 admitted clients *4 combined host read slots
const MAX_CAPTURE_WORK: usize = 2_000_000;
const ARC_ALLOWANCE: usize = 4 * size_of::<usize>();
// One reply/control frame has only fixed structs, three bounded 128-byte IDs,
// a decimal u64 serial and allocator headers. No serialized result buffer.
const QUERY_CONTROL_BYTES: usize = 4096;
// Conservatively covers the opaque handle, registration and bounded host map
// control allocation; payload/capture backing is charged separately.
const HANDLE_CONTROL_BYTES: usize = 4096;
fn resource() -> NativeDocumentError {
    NativeDocumentError::PreviewResource
}
struct Budget {
    used: AtomicUsize,
}
struct Reservation {
    budget: Arc<Budget>,
    bytes: usize,
}
impl Budget {
    fn reserve(self: &Arc<Self>, bytes: usize) -> NativeDocumentResult<Reservation> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |old| {
                old.checked_add(bytes).filter(|n| *n <= MAX_OWNED)
            })
            .map_err(|_| resource())?;
        Ok(Reservation {
            budget: self.clone(),
            bytes,
        })
    }
    fn available(&self) -> usize {
        MAX_OWNED.saturating_sub(self.used.load(Ordering::Acquire))
    }
}
impl Reservation {
    fn shrink(&mut self, bytes: usize) {
        assert!(bytes <= self.bytes);
        self.budget
            .used
            .fetch_sub(self.bytes - bytes, Ordering::AcqRel);
        self.bytes = bytes;
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
struct Captured {
    // Data drops before its reservation; weak handles cannot prolong backing.
    data: DocumentPreviewCapture,
    facts: Vec<FilePresentationFacts>,
    live: AtomicBool,
    _reservation: Reservation,
}
struct HandleRegistration {
    active: AtomicBool,
    _reservation: Reservation,
}
struct State {
    latest: Option<Arc<Captured>>,
    handles: Vec<Weak<HandleRegistration>>,
    requested: bool,
    failure: Option<NativeDocumentError>,
}
pub(super) struct NativePreviewOwner {
    state: Mutex<State>,
    budget: Arc<Budget>,
    _reservation: Reservation,
}
/// Read-only weak handle. It is not Clone/serde and cannot manufacture an
/// ordinary snapshot, retained source pin or mutation witness.
pub struct NativeBasePreview {
    owner: Weak<NativePreviewOwner>,
    capture: Weak<Captured>,
    registration: Arc<HandleRegistration>,
}
impl Drop for NativeBasePreview {
    fn drop(&mut self) {
        self.registration.active.store(false, Ordering::Release);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewStamp {
    owner_nonce: OperationId,
    stage_id: OperationId,
    serial: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewDescriptor {
    pub capture: NativePreviewStamp,
    pub source: SourceSnapshotId,
    pub progress: zorid_index::PreviewProgress,
}
impl NativeBasePreview {
    fn capture(&self) -> NativeDocumentResult<Arc<Captured>> {
        // A held reply may keep capture bytes alive after the actual vault
        // owner retires. Retained bytes alone cannot revive its weak descriptor.
        let _owner = self
            .owner
            .upgrade()
            .ok_or(NativeDocumentError::PreviewExpired)?;
        if !self.registration.active.load(Ordering::Acquire) {
            return Err(NativeDocumentError::PreviewExpired);
        }
        let capture = self
            .capture
            .upgrade()
            .ok_or(NativeDocumentError::PreviewExpired)?;
        if !capture.live.load(Ordering::Acquire) {
            return Err(NativeDocumentError::PreviewExpired);
        }
        Ok(capture)
    }
    pub fn is_live(&self) -> bool {
        self.owner.upgrade().is_some() && self.capture().is_ok()
    }
    pub fn descriptor(&self) -> NativeDocumentResult<NativePreviewDescriptor> {
        let capture = self.capture()?;
        Ok(descriptor(&capture))
    }
}
fn stamp(capture: &Captured) -> NativePreviewStamp {
    let id = capture.data.snapshot().id();
    NativePreviewStamp {
        owner_nonce: id.owner_nonce().clone(),
        stage_id: id.stage_id().clone(),
        serial: id.capture_serial().to_string(),
    }
}
fn descriptor(capture: &Captured) -> NativePreviewDescriptor {
    NativePreviewDescriptor {
        capture: stamp(capture),
        source: capture.data.source().clone(),
        progress: capture.data.snapshot().progress(),
    }
}
impl NativePreviewOwner {
    fn new() -> NativeDocumentResult<Arc<Self>> {
        let budget = Arc::new(Budget {
            used: AtomicUsize::new(0),
        });
        let bytes = size_of::<Self>()
            .checked_add(size_of::<Budget>())
            .and_then(|n| n.checked_add(2 * ARC_ALLOWANCE))
            .and_then(|n| n.checked_add(MAX_HANDLES * size_of::<Weak<HandleRegistration>>()))
            .ok_or_else(resource)?;
        let mut reservation = budget.reserve(bytes)?;
        let mut handles = Vec::new();
        handles
            .try_reserve_exact(MAX_HANDLES)
            .map_err(|_| resource())?;
        let actual = bytes
            .checked_sub(MAX_HANDLES * size_of::<Weak<HandleRegistration>>())
            .and_then(|n| n.checked_add(handles.capacity() * size_of::<Weak<HandleRegistration>>()))
            .ok_or_else(resource)?;
        if actual > reservation.bytes {
            return Err(resource());
        }
        reservation.shrink(actual);
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                latest: None,
                handles,
                requested: true,
                failure: None,
            }),
            budget,
            _reservation: reservation,
        }))
    }
    fn state(&self) -> NativeDocumentResult<std::sync::MutexGuard<'_, State>> {
        self.state
            .try_lock()
            .map_err(|_| NativeDocumentError::PreviewBusy)
    }
    fn retire(&self) -> NativeDocumentResult<()> {
        let mut state = self.state()?;
        if let Some(c) = state.latest.take() {
            c.live.store(false, Ordering::Release);
            drop(c);
        }
        Ok(())
    }
    fn plan_capture(&self) -> NativeDocumentResult<Option<Reservation>> {
        let mut state = self.state()?;
        state.handles.retain(|h| {
            h.upgrade()
                .is_some_and(|h| h.active.load(Ordering::Acquire))
        });
        if !state.requested && state.handles.is_empty() {
            return Ok(None);
        }
        state.requested = false;
        // Retire old actual data BEFORE reserving new backing. Active query
        // guards keep their reservation until their own actual payload drops.
        if let Some(c) = state.latest.take() {
            c.live.store(false, Ordering::Release);
            drop(c);
        }
        let bytes = self.budget.available();
        if bytes == 0 {
            return Err(resource());
        }
        Ok(Some(self.budget.reserve(bytes)?))
    }
}
fn expired(error: &NativeDocumentError) -> bool {
    matches!(
        error,
        NativeDocumentError::PreviewExpired
            | NativeDocumentError::Index(zorid_store::DocumentIndexError::Contract(
                IndexError::SnapshotExpired | IndexError::StaleSource | IndexError::StaleIndex
            ))
    )
}
fn capture_extra(data: &DocumentPreviewCapture, work: &mut usize) -> NativeDocumentResult<usize> {
    let mut cost = size_of::<Captured>()
        .checked_sub(size_of::<DocumentPreviewCapture>())
        .and_then(|n| n.checked_add(ARC_ALLOWANCE + 16))
        .ok_or_else(resource)?;
    cost = cost
        .checked_add(
            data.presentations()
                .len()
                .checked_mul(size_of::<FilePresentationFacts>())
                .ok_or_else(resource)?,
        )
        .ok_or_else(resource)?;
    for row in data.presentations() {
        capture_work(
            work,
            1 + row.entry().id.heap_capacity_bytes().div_ceil(64)
                + row.entry().revision.heap_capacity_bytes().div_ceil(64),
        )?;
        cost = cost
            .checked_add(row.entry().id.heap_capacity_bytes())
            .and_then(|n| n.checked_add(row.entry().revision.heap_capacity_bytes()))
            .and_then(|n| n.checked_add(32))
            .ok_or_else(resource)?;
    }
    Ok(cost)
}
fn capture_work(work: &mut usize, n: usize) -> NativeDocumentResult<()> {
    *work = work.checked_add(n).ok_or_else(resource)?;
    if *work > MAX_CAPTURE_WORK {
        return Err(resource());
    }
    Ok(())
}
impl NativeVault {
    pub fn open_document_preview(&mut self) -> NativeDocumentResult<Option<NativeBasePreview>> {
        self.paths.verify()?;
        if self.base_preview_owner.is_none() {
            self.base_preview_owner = Some(NativePreviewOwner::new()?);
        }
        let owner = self.base_preview_owner.as_ref().unwrap().clone();
        if let Some(error) = owner.state()?.failure.take() {
            return Err(error);
        }
        let capture = owner.state()?.latest.clone();
        let Some(capture) = capture else {
            owner.state()?.requested = true;
            return Ok(None);
        };
        if let Err(error) = self
            .store
            .check_document_preview_registration(&capture.data)
        {
            let error = NativeDocumentError::from(error);
            if expired(&error) {
                owner.retire()?;
                owner.state()?.requested = true;
                return Ok(None);
            }
            return Err(error);
        }
        let bytes = size_of::<HandleRegistration>()
            + size_of::<NativeBasePreview>()
            + ARC_ALLOWANCE
            + HANDLE_CONTROL_BYTES;
        let reservation = owner.budget.reserve(bytes)?;
        let mut state = owner.state()?;
        state.handles.retain(|h| {
            h.upgrade()
                .is_some_and(|h| h.active.load(Ordering::Acquire))
        });
        if state.handles.len() >= MAX_HANDLES {
            return Err(resource());
        }
        let registration = Arc::new(HandleRegistration {
            active: AtomicBool::new(true),
            _reservation: reservation,
        });
        state.handles.push(Arc::downgrade(&registration));
        drop(state);
        let preview = NativeBasePreview {
            owner: Arc::downgrade(&owner),
            capture: Arc::downgrade(&capture),
            registration,
        };
        self.admit_base_preview(&preview)?;
        Ok(Some(preview))
    }
    pub fn check_document_preview_handle(
        &self,
        preview: &NativeBasePreview,
    ) -> NativeDocumentResult<()> {
        self.admit_base_preview(preview).map(|_| ())
    }
    pub fn close_document_preview(&self, preview: NativeBasePreview) {
        drop(preview);
    }
    /// Trusted host last-client boundary. Retires this optional owner without
    /// touching draft disposal, committed work, source data or ordinary pins.
    /// Active replies retain their real byte charges until Drop, but expire.
    pub fn retire_document_preview_owner(&mut self) {
        self.retire_document_previews();
    }
    pub(super) fn retire_document_previews(&mut self) {
        // Actual successful provider/publication lifecycle owns &mut Vault.
        // Drop the owner itself; escaped handles are weak and expire at once.
        self.base_preview_owner.take();
    }
    fn admit_base_preview(
        &self,
        preview: &NativeBasePreview,
    ) -> NativeDocumentResult<Arc<Captured>> {
        self.paths.verify()?;
        let owner = self
            .base_preview_owner
            .as_ref()
            .ok_or(NativeDocumentError::PreviewExpired)?;
        if !Weak::ptr_eq(&preview.owner, &Arc::downgrade(owner)) {
            return Err(NativeDocumentError::PreviewExpired);
        }
        let capture = preview.capture()?;
        self.store
            .check_document_preview_registration(&capture.data)?;
        self.paths.verify()?;
        Ok(capture)
    }
    pub fn check_document_preview_reply(
        &self,
        reply: &NativeBasePreviewReply,
    ) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        let owner = self
            .base_preview_owner
            .as_ref()
            .ok_or(NativeDocumentError::PreviewExpired)?;
        if !Weak::ptr_eq(&reply.owner, &Arc::downgrade(owner)) || !reply.is_live() {
            return Err(NativeDocumentError::PreviewExpired);
        }
        self.store
            .check_document_preview_registration(&reply.capture.data)?;
        self.paths.verify()?;
        Ok(())
    }
    /// The query consumes its owned options so selecting a view does not clone
    /// arbitrary contextual values. Parser/evaluator component caps are unchanged.
    pub fn query_base_preview(
        &self,
        preview: &NativeBasePreview,
        definition: &EntryId,
        view: Option<&str>,
        mut options: QueryOptions,
        mut check: impl FnMut(usize) -> NativeDocumentResult<()>,
    ) -> NativeDocumentResult<NativeBasePreviewReply> {
        check(0)?;
        if options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|c| c.stop_reason().is_some())
        {
            return Err(NativeDocumentError::QueryCancelled);
        }
        let capture = self.admit_base_preview(preview)?;
        let owner = preview
            .owner
            .upgrade()
            .ok_or(NativeDocumentError::PreviewExpired)?;
        let limit = owner.budget.available().min(MAX_QUERY);
        if limit == 0 {
            return Err(resource());
        }
        let reservation = owner.budget.reserve(limit)?;
        // Tight bounded definition read; no live file or full stage restoration.
        let max_source = limit
            .saturating_sub(QUERY_CONTROL_BYTES)
            .min(zorid_bases::MAX_BASE_SOURCE_BYTES);
        let source =
            self.store
                .read_document_preview_definition(&capture.data, definition, max_source)?;
        let row = capture
            .data
            .presentations()
            .binary_search_by(|r| r.entry().id.cmp(definition))
            .map_err(|_| NativeDocumentError::PreviewExpired)?;
        check(1)?;
        let program = zorid_bases::compile_base_source(source.text())?;
        if let Some(name) = view {
            options.view_index = program.view_index_by_name(name).ok_or_else(|| {
                zorid_bases::ExpressionDiagnostic::new("view_not_found", "Base view was not found")
            })?;
        }
        let allowance = limit
            .checked_sub(source.text_heap_bytes())
            .and_then(|n| n.checked_sub(QUERY_CONTROL_BYTES))
            .ok_or_else(resource)?;
        let result = zorid_bases::query_preview(
            &program,
            capture.data.snapshot(),
            definition,
            &capture.facts,
            &options,
            allowance,
        )?;
        drop(program);
        drop(source);
        check(0)?;
        let final_capture = self.admit_base_preview(preview)?;
        if !Arc::ptr_eq(&capture, &final_capture) {
            return Err(NativeDocumentError::PreviewExpired);
        }
        Ok(NativeBasePreviewReply {
            capture,
            registration: preview.registration.clone(),
            owner: preview.owner.clone(),
            row,
            value: result.value,
            _reservation: reservation,
        })
    }
    pub(super) fn pump_document_index_preview(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> NativeDocumentResult<Option<DocumentIndexProgress>> {
        let Some(owner) = self.base_preview_owner.clone() else {
            return Ok(None);
        };
        let plan = match owner.plan_capture() {
            Ok(Some(p)) => p,
            // Optional owner contention/poison/resource never blocks the
            // ordinary durable pump. Opening the owner still reports Busy.
            Ok(None) | Err(_) => return Ok(None),
        };
        let mut reservation = plan;
        let request = DocumentPreviewCaptureRequest {
            owner_nonce: super::new_op(),
            stage_id: super::new_op(),
            retained_byte_limit: reservation.bytes,
        };
        let mut work = 0usize;
        let pumped =
            self.store
                .pump_document_index_with_registered_preview(stage, Some(request), |n| {
                    capture_work(&mut work, n)
                })?;
        // Nothing after a successful pump may turn its committed progress into
        // a retryable pump failure. Retain typed non-resource preview failures
        // separately for open(), instead of silently claiming a usable capture.
        let installed = (|| -> NativeDocumentResult<()> {
            let data = match pumped.preview {
                Some(Ok(data)) => data,
                Some(Err(PreviewCaptureError::Host(error))) => return Err(error),
                Some(Err(PreviewCaptureError::Index(error))) => return Err(error.into()),
                Some(Err(PreviewCaptureError::Resource(_))) | None => return Ok(()),
            };
            if !data.is_first_build() {
                return Ok(());
            }
            let extra = capture_extra(&data, &mut work)?;
            let total = data
                .retained_bytes()
                .checked_add(extra)
                .ok_or_else(resource)?;
            if total > reservation.bytes {
                return Err(resource());
            }
            let mut facts = Vec::new();
            facts
                .try_reserve_exact(data.presentations().len())
                .map_err(|_| resource())?;
            let actual = total
                .checked_add(
                    facts
                        .capacity()
                        .saturating_sub(data.presentations().len())
                        .checked_mul(size_of::<FilePresentationFacts>())
                        .ok_or_else(resource)?,
                )
                .ok_or_else(resource)?;
            if actual > reservation.bytes {
                return Err(resource());
            }
            for row in data.presentations() {
                capture_work(
                    &mut work,
                    1 + row.entry().id.heap_capacity_bytes().div_ceil(64)
                        + row.entry().revision.heap_capacity_bytes().div_ceil(64),
                )?;
                let p = row.presentation();
                facts.push(FilePresentationFacts {
                    witness: RecordWitness {
                        entry_id: row.entry().id.clone(),
                        revision: row.entry().revision.clone(),
                    },
                    size: Some(p.size_bytes),
                    ctime_ms: i64::try_from(p.ctime_ms).ok(),
                    mtime_ms: i64::try_from(p.mtime_ms).ok(),
                });
            }
            reservation.shrink(actual);
            let capture = Arc::new(Captured {
                data,
                facts,
                live: AtomicBool::new(true),
                _reservation: reservation,
            });
            let mut state = owner.state()?;
            state.latest = Some(capture);
            state.failure = None;
            Ok(())
        })();
        if let Err(error) = installed {
            if !matches!(
                error,
                NativeDocumentError::PreviewResource | NativeDocumentError::QueryCancelled
            ) {
                // An owner borrow cannot be held across the pump/closure above.
                if let Ok(mut state) = owner.state() {
                    state.failure = Some(error);
                }
            }
        }
        Ok(Some(pumped.progress))
    }
}
/// Result data and its real query/capture charges stay alive through physical
/// bounded writing. There is no into_value/encoded Vec ownership escape.
pub struct NativeBasePreviewReply {
    capture: Arc<Captured>,
    registration: Arc<HandleRegistration>,
    owner: Weak<NativePreviewOwner>,
    row: usize,
    value: BasePreviewResult,
    _reservation: Reservation,
}
impl NativeBasePreviewReply {
    fn is_live(&self) -> bool {
        self.owner.upgrade().is_some()
            && self.registration.active.load(Ordering::Acquire)
            && self.capture.live.load(Ordering::Acquire)
    }
    pub fn write_json(
        &self,
        preview_id: &OperationId,
        writer: &mut impl Write,
        maximum: usize,
        mut check: impl FnMut() -> NativeDocumentResult<()>,
    ) -> NativeDocumentResult<usize> {
        if maximum == 0 || maximum > 16 * 1024 * 1024 {
            return Err(resource());
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Value<'a> {
            preview_id: &'a OperationId,
            capture: NativePreviewStamp,
            source: &'a SourceSnapshotId,
            definition: &'a zorid_core::EntryState,
            result: &'a BasePreviewResult,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Envelope<'a> {
            schema_version: u32,
            op: &'a str,
            value: Value<'a>,
        }
        if !self.is_live() {
            return Err(NativeDocumentError::PreviewExpired);
        }
        check()?;
        let value = Envelope {
            schema_version: 1,
            op: "preview_base",
            value: Value {
                preview_id,
                capture: stamp(&self.capture),
                source: self.capture.data.source(),
                definition: self.capture.data.presentations()[self.row].entry(),
                result: &self.value,
            },
        };
        struct Bounded<'a, W, F> {
            writer: &'a mut W,
            remaining: usize,
            written: usize,
            check: &'a mut F,
            error: Option<NativeDocumentError>,
        }
        impl<W: Write, F: FnMut() -> NativeDocumentResult<()>> Write for Bounded<'_, W, F> {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                if let Err(error) = (self.check)() {
                    self.error = Some(error);
                    return Err(io::Error::other("preview cancelled"));
                }
                if b.len() > self.remaining {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "preview output limit",
                    ));
                }
                self.writer.write_all(b)?;
                self.remaining -= b.len();
                self.written += b.len();
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.writer.flush()
            }
        }
        let mut checked = || {
            if !self.is_live() {
                return Err(NativeDocumentError::PreviewExpired);
            }
            check()
        };
        let mut bounded = Bounded {
            writer,
            remaining: maximum,
            written: 0,
            check: &mut checked,
            error: None,
        };
        if serde_json::to_writer(&mut bounded, &value).is_err() {
            return Err(bounded.error.take().unwrap_or_else(resource));
        }
        let written = bounded.written;
        drop(bounded);
        checked()?;
        Ok(written)
    }
}

#[cfg(test)]
#[path = "document_preview_tests.rs"]
mod tests;
