//! Immutable reports over an adapter-admitted committed subset of one builder.
//! This module cannot certify durability. Hosts call capture only AFTER a
//! successful serialized pump transaction and persisted-membership validation.
//! Omitted rows stay pending, including rows already added to the Rust builder.
//! No source body, publication fence, ordinary query pin or mutation witness is
//! stored or exposed. Published Generation completeness remains unchanged.
use crate::{
    GenerationBuilder, IndexError, IndexRecord, Manifest, SourceSnapshotId, MAX_SEARCH_OWNED_BYTES,
};
use std::{
    fmt,
    mem::size_of,
    sync::{Arc, Weak},
};
use zorid_core::{EntryId, EntryKind, OperationId, Revision, VaultPath};

#[derive(Debug)]
pub enum PreviewCaptureError<E> {
    Host(E),
    Index(IndexError),
    Resource(&'static str),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProgress {
    pub prepared_files: u32,
    pub total_files: u32,
    pub pending_files: u32,
}
struct CaptureIdentity {
    owner_nonce: OperationId,
    stage_id: OperationId,
}
/// Conservative full retained charge for one capture handle, including shared
/// immutable stage facts that can outlive their builder. Shared allocations are
/// charged in full for each handle; this is not a process allocator census.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewRetention {
    capture_owned_bytes: usize,
    shared_backing_bytes: usize,
}
impl PreviewRetention {
    pub fn capture_owned_bytes(&self) -> usize {
        self.capture_owned_bytes
    }
    pub fn shared_backing_bytes(&self) -> usize {
        self.shared_backing_bytes
    }
    pub fn total_bytes(&self) -> usize {
        self.capture_owned_bytes
            .saturating_add(self.shared_backing_bytes)
    }
}
struct PreviewBacking {
    manifest: Arc<Manifest>,
    // Exact ID order, without cloned IDs, metadata or source text.
    rows: Vec<Arc<IndexRecord>>,
    progress: PreviewProgress,
    retention: PreviewRetention,
}

/// Not deserializable or caller-constructible. A weak identity retains only the
/// backing control allocation after its snapshot dies, never the rows/facts.
#[derive(Clone)]
pub struct PreviewSnapshotId {
    owner: Arc<CaptureIdentity>,
    serial: u64,
    backing: Weak<PreviewBacking>,
}
impl PreviewSnapshotId {
    pub fn owner_nonce(&self) -> &OperationId {
        &self.owner.owner_nonce
    }
    pub fn stage_id(&self) -> &OperationId {
        &self.owner.stage_id
    }
    pub fn capture_serial(&self) -> u64 {
        self.serial
    }
}
impl PartialEq for PreviewSnapshotId {
    fn eq(&self, other: &Self) -> bool {
        self.owner.owner_nonce == other.owner.owner_nonce
            && self.owner.stage_id == other.owner.stage_id
            && self.serial == other.serial
            && Weak::ptr_eq(&self.backing, &other.backing)
    }
}
impl Eq for PreviewSnapshotId {}
impl fmt::Debug for PreviewSnapshotId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreviewSnapshotId")
            .field("owner_nonce", self.owner_nonce())
            .field("stage_id", self.stage_id())
            .field("capture_serial", &self.serial)
            .finish()
    }
}

/// Sealed read-only capture. Clones share the same immutable backing. Reports
/// from a preview remain Indexing/incomplete until ordinary publication; this
/// type deliberately supplies no Generation, record, manifest or witness getter.
#[derive(Clone)]
pub struct PreviewSnapshot {
    id: PreviewSnapshotId,
    backing: Arc<PreviewBacking>,
}
impl PreviewSnapshot {
    pub fn id(&self) -> &PreviewSnapshotId {
        &self.id
    }
    pub fn source(&self) -> &SourceSnapshotId {
        self.backing.manifest.source()
    }
    pub fn progress(&self) -> PreviewProgress {
        self.backing.progress
    }
    /// Legacy new-payload allocation charge: inline snapshot/backing/control and
    /// actual row-vector capacity only. This excludes shared stage facts and the
    /// identity/token allocations. Existing explicit-membership capture callers
    /// keep this admission contract; use retention() for full retained memory.
    pub fn retained_bytes(&self) -> usize {
        size_of::<Self>()
            .saturating_add(arc_bytes::<PreviewBacking>())
            .saturating_add(
                self.backing
                    .rows
                    .capacity()
                    .saturating_mul(size_of::<Arc<IndexRecord>>()),
            )
    }
    /// Cached full retained charge measured during capture, never by a query or
    /// serialization pass. No source bodies are included.
    pub fn retention(&self) -> PreviewRetention {
        self.backing.retention
    }
    /// Borrow prepared semantic facts without copying metadata, acquiring Arc
    /// handles or scanning the captured namespace. Only the callback can fail;
    /// its cancellation/error value is preserved unchanged. Logical row facts
    /// carry no pin, publication or mutation authority.
    pub fn facts_view_checked<E>(
        &self,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<PreviewFactsView<'_>, E> {
        check(0)?;
        check(1)?;
        Ok(PreviewFactsView { snapshot: self })
    }
    /// Check exact retained text bytes for a committed member of this capture.
    /// Pending/unknown IDs return MissingSource; excluded records reject text.
    /// This is an integrity comparison, not source-read or publication authority.
    /// The host bounds/charges the supplied bytes before this synchronous digest
    /// calculation. Membership uses the sealed rows' existing binary lookup.
    pub fn check_text(&self, entry_id: &EntryId, bytes: &[u8]) -> Result<(), IndexError> {
        let record = self.record(entry_id).ok_or(IndexError::MissingSource)?;
        // Impossible length/mode matches need no source scan or digest work.
        if record.text_digest().is_none() || record.text_bytes() != bytes.len() {
            return Err(IndexError::ContentMismatch);
        }
        record.check_text(bytes)
    }
    pub(crate) fn manifest(&self) -> &Manifest {
        &self.backing.manifest
    }
    pub(crate) fn record(&self, id: &EntryId) -> Option<&IndexRecord> {
        self.backing
            .rows
            .binary_search_by(|row| row.witness().entry().id.cmp(id))
            .ok()
            .map(|at| self.backing.rows[at].as_ref())
    }
    pub(crate) fn records_by_id(&self) -> &[Arc<IndexRecord>] {
        &self.backing.rows
    }
    pub(crate) fn lookup_work(&self) -> usize {
        log_work(self.backing.rows.len())
            .saturating_add(1)
            .saturating_mul(5)
    }
    pub fn same_capture(&self, other: &Self) -> bool {
        self.id == other.id && Arc::ptr_eq(&self.backing, &other.backing)
    }
}
impl fmt::Debug for PreviewSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreviewSnapshot")
            .field("id", &self.id)
            .field("progress", &self.progress())
            .field("retained_bytes", &self.retained_bytes())
            .finish()
    }
}

/// Allocation-free semantic read view over this exact immutable capture.
/// Rows are only its committed file membership, in exact EntryId order; pending
/// files never appear as empty/unavailable records. The caller charges row
/// visits and any property/tag/value copies before work, checks its own existing
/// query limits, and keeps derived buffers in that same query's byte ledger.
/// No namespace, resolver, source body or owned record handle escapes this view.
pub struct PreviewFactsView<'capture> {
    snapshot: &'capture PreviewSnapshot,
}
impl PreviewFactsView<'_> {
    pub fn id(&self) -> &PreviewSnapshotId {
        self.snapshot.id()
    }
    pub fn source(&self) -> &SourceSnapshotId {
        self.snapshot.source()
    }
    pub fn progress(&self) -> PreviewProgress {
        self.snapshot.progress()
    }
    /// Iteration borrows existing sealed rows. Callers charge each typed visit
    /// before advancing, and pre-admit any derived copies separately. Creating
    /// the iterator and reading its exact length perform no namespace scan.
    pub fn rows(&self) -> impl ExactSizeIterator<Item = PreviewRowFacts<'_>> + '_ {
        self.snapshot
            .backing
            .rows
            .iter()
            .map(|record| PreviewRowFacts {
                record: record.as_ref(),
            })
    }
}

/// Borrowed logical read facts, never an admitted write witness or source-read
/// request. This wrapper exposes neither IndexRecord nor its underlying Arcs.
pub struct PreviewRowFacts<'view> {
    record: &'view IndexRecord,
}
impl PreviewRowFacts<'_> {
    pub fn entry_id(&self) -> &EntryId {
        &self.record.witness().entry().id
    }
    pub fn revision(&self) -> &Revision {
        &self.record.witness().entry().revision
    }
    pub fn path(&self) -> &VaultPath {
        &self.record.witness().entry().path
    }
    /// Missing metadata is not automatically an absent property. Known binary
    /// and successfully extracted plain text are not metadata-bearing;
    /// SourceLimit, ExtractionLimit and Unreadable exclusions make properties
    /// unavailable. Consumers retain this distinction using exclusion().
    pub fn metadata(&self) -> Option<&zorid_document::DocumentMetadata> {
        self.record.metadata()
    }
    pub fn exclusion(&self) -> Option<&crate::Exclusion> {
        self.record.exclusion()
    }
    /// Present exactly when this row has a retained text digest, including
    /// Some(0) for an extracted empty text. Excluded rows return None; a zero
    /// byte count alone never proves readable text. No body is retained here.
    pub fn source_text_bytes(&self) -> Option<usize> {
        self.record.text_digest().map(|_| self.record.text_bytes())
    }
}

/// One capture/builder incarnation, not a reusable runtime-owner identifier.
/// The host MUST allocate a fresh nonce for every new/reconstructed owner,
/// including reopening the same stage/source. Core performs no IO/randomness.
/// Binding to the exact shared manifest additionally rejects a different builder
/// with identical logical contents. This owner is not query/publication authority.
pub struct PreviewCaptureOwner {
    identity: Arc<CaptureIdentity>,
    manifest: Arc<Manifest>,
    next_serial: u64,
}
impl PreviewCaptureOwner {
    pub fn new(
        fresh_incarnation_nonce: OperationId,
        stage_id: OperationId,
        builder: &GenerationBuilder,
    ) -> Self {
        Self {
            // Clone only bounded identifier contents; do not retain spare
            // capacity that a caller may have supplied in the moved IDs.
            identity: Arc::new(CaptureIdentity {
                owner_nonce: fresh_incarnation_nonce.clone(),
                stage_id: stage_id.clone(),
            }),
            manifest: builder.preview_manifest().clone(),
            next_serial: 1,
        }
    }
    /// Capture-owner allocation only; shared manifest/facts belong to the stage.
    /// Identifier lengths are bounded by their typed128-byte constructors.
    pub fn retained_bytes(&self) -> usize {
        size_of::<Self>()
            + arc_bytes::<CaptureIdentity>()
            + self.identity.owner_nonce.as_str().len()
            + self.identity.stage_id.as_str().len()
    }
    /// Capture every prepared row without materializing or sorting ID copies.
    /// Hosts MUST call only after a successful durable pump commit has validated
    /// that every builder row belongs to persisted committed membership. If the
    /// builder also contains rows awaiting commit, use capture_checked with the
    /// exact committed subset instead. This API does not certify durability.
    /// Stage facts remain shared; only the bounded row-handle vector is copied.
    /// retained_byte_limit admits their FULL cached retained charge (including
    /// the manifest, selected records and identity), clamped to32MiB. Failure
    /// precedes final snapshot publication and never advances the serial.
    pub fn capture_prepared_checked<E>(
        &mut self,
        builder: &GenerationBuilder,
        retained_byte_limit: usize,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<PreviewSnapshot, PreviewCaptureError<E>> {
        charge(&mut check, 1)?;
        if !Arc::ptr_eq(&self.manifest, builder.preview_manifest()) {
            return Err(PreviewCaptureError::Index(IndexError::StaleSource));
        }
        let next_serial = self
            .next_serial
            .checked_add(1)
            .ok_or(PreviewCaptureError::Resource(
                "preview capture serial exhausted",
            ))?;
        let mut budget = CaptureBudget {
            used: 0,
            limit: retained_byte_limit.min(MAX_SEARCH_OWNED_BYTES),
        };
        let base = size_of::<PreviewSnapshot>()
            .checked_add(arc_bytes::<PreviewBacking>())
            .ok_or(PreviewCaptureError::Resource("preview capture bytes"))?;
        budget.admit::<E>(base)?;
        let records = builder.preview_records_by_id();
        let count = records.len();
        let planned_owned = capture_owned_bytes(&self.identity, count).ok_or(
            PreviewCaptureError::Resource("preview capture retained bytes"),
        )?;
        let maximum = retained_byte_limit
            .min(MAX_SEARCH_OWNED_BYTES)
            .checked_sub(planned_owned)
            .ok_or(PreviewCaptureError::Resource(
                "preview capture retained byte limit",
            ))?;
        let mut shared = RetentionHeap { bytes: 0, maximum };
        let total = self.measure_manifest_checked(&mut shared, &mut check)?;
        if count > total {
            return Err(PreviewCaptureError::Index(IndexError::InvalidRecord));
        }
        let total = u32::try_from(total)
            .map_err(|_| PreviewCaptureError::Resource("preview file count"))?;
        // Reserve typed iterator visits before row allocation/iteration. Each
        // actual Arc acquisition also has its own pre-copy cancellation check.
        charge(&mut check, count.saturating_add(1))?;
        let mut rows = budget.vector(count)?;
        let owned = capture_owned_bytes(&self.identity, rows.capacity()).ok_or(
            PreviewCaptureError::Resource("preview capture retained bytes"),
        )?;
        shared.tighten(retained_byte_limit.min(MAX_SEARCH_OWNED_BYTES), owned)?;
        let lookup_work = log_work(self.manifest.entries().len())
            .saturating_add(1)
            .saturating_mul(5);
        for record in records {
            charge(&mut check, lookup_work)?;
            let witness = record.witness();
            let entry = self
                .manifest
                .entry(&witness.entry().id)
                .ok_or(PreviewCaptureError::Index(IndexError::MissingSource))?;
            if entry.kind != EntryKind::File {
                return Err(PreviewCaptureError::Index(IndexError::InvalidTarget));
            }
            let comparison_bytes = entry
                .path
                .as_str()
                .len()
                .saturating_add(witness.entry().path.as_str().len())
                .saturating_add(2 * 128 * 3 + 2 * 20);
            charge(&mut check, comparison_bytes.div_ceil(64).saturating_add(8))?;
            if witness.source() != self.manifest.source() || witness.entry() != entry {
                return Err(PreviewCaptureError::Index(IndexError::StaleSource));
            }
            shared.record(record, &mut check)?;
            charge(&mut check, 1)?;
            rows.push(record.clone());
        }
        let prepared = u32::try_from(rows.len())
            .map_err(|_| PreviewCaptureError::Resource("preview file count"))?;
        charge(&mut check, 3)?;
        let backing = Arc::new(PreviewBacking {
            manifest: self.manifest.clone(),
            rows,
            retention: PreviewRetention {
                capture_owned_bytes: owned,
                shared_backing_bytes: shared.bytes,
            },
            progress: PreviewProgress {
                prepared_files: prepared,
                total_files: total,
                pending_files: total - prepared,
            },
        });
        let snapshot = PreviewSnapshot {
            id: PreviewSnapshotId {
                owner: self.identity.clone(),
                serial: self.next_serial,
                backing: Arc::downgrade(&backing),
            },
            backing,
        };
        charge(&mut check, 0)?;
        self.next_serial = next_serial;
        Ok(snapshot)
    }
    /// `committed_ids` is the exact membership validated by the trusted adapter
    /// against persisted staging rows AFTER its durable pump commit. It is not
    /// a caller-authored wire proof. Unknown/folder/duplicate/unprepared IDs fail;
    /// omitting an added-but-uncommitted builder row is intentional and safe.
    /// Caller work/cancellation and allocation admission precede all copies,
    /// comparisons, sorting and Arc acquisition. Serial advances only on success.
    pub fn capture_checked<E>(
        &mut self,
        builder: &GenerationBuilder,
        committed_ids: &[EntryId],
        owned_byte_limit: usize,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<PreviewSnapshot, PreviewCaptureError<E>> {
        charge(&mut check, 1)?;
        if !Arc::ptr_eq(&self.manifest, builder.preview_manifest()) {
            return Err(PreviewCaptureError::Index(IndexError::StaleSource));
        }
        let next_serial = self
            .next_serial
            .checked_add(1)
            .ok_or(PreviewCaptureError::Resource(
                "preview capture serial exhausted",
            ))?;
        let mut budget = CaptureBudget {
            used: 0,
            limit: owned_byte_limit.min(MAX_SEARCH_OWNED_BYTES),
        };
        let base = size_of::<PreviewSnapshot>()
            .checked_add(arc_bytes::<PreviewBacking>())
            .ok_or(PreviewCaptureError::Resource("preview capture bytes"))?;
        budget.admit::<E>(base)?;
        let planned_owned = capture_owned_bytes(&self.identity, committed_ids.len()).ok_or(
            PreviewCaptureError::Resource("preview capture retained bytes"),
        )?;
        let mut shared = RetentionHeap {
            bytes: 0,
            maximum: usize::MAX - planned_owned,
        };
        let total = self.measure_manifest_checked(&mut shared, &mut check)?;
        if committed_ids.len() > total {
            return Err(PreviewCaptureError::Index(IndexError::InvalidRecord));
        }
        let total = u32::try_from(total)
            .map_err(|_| PreviewCaptureError::Resource("preview file count"))?;
        charge(&mut check, committed_ids.len().saturating_add(1))?;
        let mut selected: Vec<&EntryId> = budget.vector(committed_ids.len())?;
        selected.extend(committed_ids.iter());
        // IDs contain at most128 bytes: typed visit plus up to two64-byte
        // blocks from each compared operand. No path/body comparison occurs.
        charge(&mut check, sort_work(selected.len()).saturating_mul(5))?;
        selected.sort_unstable();
        charge(&mut check, selected.len().saturating_mul(5))?;
        if selected.windows(2).any(|p| p[0] == p[1]) {
            return Err(PreviewCaptureError::Index(IndexError::InvalidRecord));
        }
        let mut rows = budget.vector(selected.len())?;
        let owned = capture_owned_bytes(&self.identity, rows.capacity()).ok_or(
            PreviewCaptureError::Resource("preview capture retained bytes"),
        )?;
        shared.tighten(usize::MAX, owned)?;
        let lookup_work = log_work(self.manifest.entries().len())
            .saturating_add(1)
            .saturating_mul(5);
        let record_work = log_work(builder.prepared_records())
            .saturating_add(1)
            .saturating_mul(16 * 5);
        for id in selected {
            charge(&mut check, lookup_work)?;
            let entry = self
                .manifest
                .entry(id)
                .ok_or(PreviewCaptureError::Index(IndexError::MissingSource))?;
            if entry.kind != EntryKind::File {
                return Err(PreviewCaptureError::Index(IndexError::InvalidTarget));
            }
            charge(&mut check, record_work)?;
            let record = builder
                .preview_record(id)
                .ok_or(PreviewCaptureError::Index(IndexError::MissingSource))?;
            let witness = record.witness();
            let comparison_bytes = entry
                .path
                .as_str()
                .len()
                .saturating_add(witness.entry().path.as_str().len())
                .saturating_add(2 * 128 * 3 + 2 * 20);
            charge(&mut check, comparison_bytes.div_ceil(64).saturating_add(8))?;
            if witness.source() != self.manifest.source() || witness.entry() != entry {
                return Err(PreviewCaptureError::Index(IndexError::StaleSource));
            }
            shared.record(record, &mut check)?;
            charge(&mut check, 1)?;
            rows.push(record.clone());
        }
        let prepared = u32::try_from(rows.len())
            .map_err(|_| PreviewCaptureError::Resource("preview file count"))?;
        charge(&mut check, 3)?;
        let backing = Arc::new(PreviewBacking {
            manifest: self.manifest.clone(),
            rows,
            retention: PreviewRetention {
                capture_owned_bytes: owned,
                shared_backing_bytes: shared.bytes,
            },
            progress: PreviewProgress {
                prepared_files: prepared,
                total_files: total,
                pending_files: total - prepared,
            },
        });
        let snapshot = PreviewSnapshot {
            id: PreviewSnapshotId {
                owner: self.identity.clone(),
                serial: self.next_serial,
                backing: Arc::downgrade(&backing),
            },
            backing,
        };
        charge(&mut check, 0)?;
        self.next_serial = next_serial;
        Ok(snapshot)
    }
    fn measure_manifest_checked<E>(
        &self,
        shared: &mut RetentionHeap,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<usize, PreviewCaptureError<E>> {
        charge(check, self.manifest.entries().len().saturating_add(1))?;
        shared.add(self.manifest.preview_base_heap_bytes(), check)?;
        let mut total = 0usize;
        for entry in self.manifest.entries() {
            shared.add(crate::snapshot::entry_heap_capacity_bytes(entry), check)?;
            if entry.kind == EntryKind::File {
                total = total
                    .checked_add(1)
                    .ok_or(PreviewCaptureError::Resource("preview file count"))?;
            }
        }
        Ok(total)
    }
}
// Conservative allocator bookkeeping in addition to actual payload capacities.
// Arc control/alignment is included separately by arc_bytes().
fn allocation_bytes(payload: usize) -> Option<usize> {
    if payload == 0 {
        Some(0)
    } else {
        payload.checked_add(2 * size_of::<usize>())
    }
}
fn capture_owned_bytes(identity: &CaptureIdentity, row_capacity: usize) -> Option<usize> {
    size_of::<PreviewSnapshot>()
        .checked_add(arc_bytes::<PreviewBacking>())?
        .checked_add(allocation_bytes(
            row_capacity.checked_mul(size_of::<Arc<IndexRecord>>())?,
        )?)?
        .checked_add(arc_bytes::<CaptureIdentity>())?
        .checked_add(allocation_bytes(
            identity.owner_nonce.heap_capacity_bytes(),
        )?)?
        .checked_add(allocation_bytes(identity.stage_id.heap_capacity_bytes())?)
}
struct RetentionHeap {
    bytes: usize,
    maximum: usize,
}
impl RetentionHeap {
    fn tighten<E>(&mut self, limit: usize, owned: usize) -> Result<(), PreviewCaptureError<E>> {
        self.maximum = limit
            .checked_sub(owned)
            .ok_or(PreviewCaptureError::Resource(
                "preview capture retained byte limit",
            ))?;
        if self.bytes > self.maximum {
            return Err(PreviewCaptureError::Resource(
                "preview capture retained byte limit",
            ));
        }
        Ok(())
    }
    fn add<E>(
        &mut self,
        bytes: usize,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), PreviewCaptureError<E>> {
        let total = self
            .bytes
            .checked_add(bytes)
            .filter(|&n| n <= self.maximum)
            .ok_or(PreviewCaptureError::Resource(
                "preview capture retained byte limit",
            ))?;
        charge(check, bytes.div_ceil(64).saturating_add(1))?;
        self.bytes = total;
        Ok(())
    }
    fn string_capacity<E>(
        &mut self,
        capacity: usize,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), PreviewCaptureError<E>> {
        let bytes = allocation_bytes(capacity).ok_or(PreviewCaptureError::Resource(
            "preview capture retained bytes",
        ))?;
        self.add(bytes, check)
    }
    fn slots<T, E>(
        &mut self,
        values: &Vec<T>,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), PreviewCaptureError<E>> {
        let bytes = values
            .capacity()
            .checked_mul(size_of::<T>())
            .and_then(allocation_bytes)
            .ok_or(PreviewCaptureError::Resource(
                "preview capture retained bytes",
            ))?;
        // Admit every fixed element slot, including spare capacity, BEFORE
        // following any child strings, object members or recursive values.
        self.add(bytes, check)
    }
    fn strings<E>(
        &mut self,
        values: &Vec<String>,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), PreviewCaptureError<E>> {
        self.slots(values, check)?;
        for value in values {
            charge(check, 1)?;
            self.string_capacity(value.capacity(), check)?;
        }
        Ok(())
    }
    fn property<E>(
        &mut self,
        value: &zorid_document::PropertyValue,
        depth: usize,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), PreviewCaptureError<E>> {
        if depth > 128 {
            return Err(PreviewCaptureError::Resource(
                "preview property retained depth",
            ));
        }
        charge(check, 1)?;
        match value {
            zorid_document::PropertyValue::String(text) => {
                self.string_capacity(text.capacity(), check)?
            }
            zorid_document::PropertyValue::Array(values) => {
                self.slots(values, check)?;
                for value in values {
                    self.property(value, depth + 1, check)?;
                }
            }
            zorid_document::PropertyValue::Object(values) => {
                self.slots(values, check)?;
                for (key, value) in values {
                    charge(check, 1)?;
                    self.string_capacity(key.capacity(), check)?;
                    self.property(value, depth + 1, check)?;
                }
            }
            // The pinned workspace does not enable serde_json's arbitrary_precision
            // feature: Number is an inline scalar, as are Null and Bool.
            zorid_document::PropertyValue::Null
            | zorid_document::PropertyValue::Bool(_)
            | zorid_document::PropertyValue::Number(_) => {}
        }
        Ok(())
    }
    fn record<E>(
        &mut self,
        record: &IndexRecord,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), PreviewCaptureError<E>> {
        charge(check, 1)?;
        self.add(arc_bytes::<IndexRecord>(), check)?;
        self.add(record.witness().preview_heap_bytes(), check)?;
        let Some(metadata) = record.metadata() else {
            return Ok(());
        };
        // Exhaustive schema2 decomposition makes new typed fields a compile-time
        // accounting decision. Its inline struct lives inside IndexRecord.
        let zorid_document::DocumentMetadata {
            schema_version: _,
            dialect_version,
            entry_id,
            content_revision,
            source_length: _,
            frontmatter: _,
            properties,
            aliases,
            tags,
            tag_occurrences,
            headings,
            links,
            tasks,
            blocks,
            list_items,
            diagnostics,
        } = metadata;
        self.string_capacity(dialect_version.capacity(), check)?;
        self.string_capacity(entry_id.heap_capacity_bytes(), check)?;
        self.string_capacity(content_revision.heap_capacity_bytes(), check)?;
        self.slots(properties, check)?;
        for property in properties {
            charge(check, 1)?;
            self.string_capacity(property.key.capacity(), check)?;
            self.property(&property.value, 0, check)?;
        }
        self.strings(aliases, check)?;
        self.strings(tags, check)?;
        self.slots(tag_occurrences, check)?;
        for tag in tag_occurrences {
            charge(check, 1)?;
            self.string_capacity(tag.name.capacity(), check)?;
        }
        self.slots(headings, check)?;
        for heading in headings {
            charge(check, 1)?;
            self.string_capacity(heading.text.capacity(), check)?;
        }
        self.slots(links, check)?;
        for link in links {
            charge(check, 1)?;
            self.string_capacity(link.target.capacity(), check)?;
            self.string_capacity(link.fragment.capacity(), check)?;
            self.string_capacity(link.destination.capacity(), check)?;
        }
        self.slots(tasks, check)?;
        for task in tasks {
            charge(check, 1)?;
            self.string_capacity(task.status.capacity(), check)?;
            self.string_capacity(task.text.capacity(), check)?;
        }
        self.slots(blocks, check)?;
        self.slots(list_items, check)?;
        for item in list_items {
            charge(check, 1)?;
            if let Some(status) = &item.task_status {
                self.string_capacity(status.capacity(), check)?;
            }
        }
        self.slots(diagnostics, check)?;
        Ok(())
    }
}
fn charge<E>(
    check: &mut impl FnMut(usize) -> Result<(), E>,
    units: usize,
) -> Result<(), PreviewCaptureError<E>> {
    check(units).map_err(PreviewCaptureError::Host)
}
fn log_work(n: usize) -> usize {
    if n <= 1 {
        0
    } else {
        usize::BITS as usize - (n - 1).leading_zeros() as usize
    }
}
fn sort_work(n: usize) -> usize {
    n.saturating_mul(log_work(n))
}
fn arc_bytes<T>() -> usize {
    size_of::<T>().saturating_add(4 * size_of::<usize>())
}
struct CaptureBudget {
    used: usize,
    limit: usize,
}
impl CaptureBudget {
    fn admit<E>(&mut self, bytes: usize) -> Result<(), PreviewCaptureError<E>> {
        self.used = self
            .used
            .checked_add(bytes)
            .ok_or(PreviewCaptureError::Resource("preview capture bytes"))?;
        if self.used > self.limit {
            return Err(PreviewCaptureError::Resource(
                "preview capture owned byte limit",
            ));
        }
        Ok(())
    }
    fn vector<E, T>(&mut self, count: usize) -> Result<Vec<T>, PreviewCaptureError<E>> {
        self.admit(
            count
                .checked_mul(size_of::<T>())
                .ok_or(PreviewCaptureError::Resource("preview vector bytes"))?,
        )?;
        let mut vector = Vec::new();
        vector
            .try_reserve_exact(count)
            .map_err(|_| PreviewCaptureError::Resource("preview vector allocation"))?;
        if vector.capacity() > count {
            self.admit(
                (vector.capacity() - count)
                    .checked_mul(size_of::<T>())
                    .ok_or(PreviewCaptureError::Resource("preview vector capacity"))?,
            )?;
        }
        Ok(vector)
    }
}

#[cfg(test)]
#[path = "preview_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "preview_facts_tests.rs"]
mod facts_tests;
