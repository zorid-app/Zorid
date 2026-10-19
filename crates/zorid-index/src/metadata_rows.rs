//! Body-free committed metadata projection. Generation handles are immutable
//! data, never pin admission: hosts validate the actual destination/baseline pin
//! registrations before and after a page and only then commit its checkpoint.
use crate::{Exclusion, Generation, IndexRecord, IndexSnapshotId, SourceSnapshotId};
use serde::ser::{SerializeSeq, SerializeStruct};
use serde::{Serialize, Serializer};
use std::io::{self, Write};
use std::sync::Arc;
use zorid_core::{EntryId, EntryKind, EntryState};
use zorid_document::{DocumentMetadata, PropertyValue};

pub const MAX_METADATA_ROWS: usize = 32;
/// Pure preparation only: comparisons, accounting and counting traversal.
/// Actual response encoding has a separate16MiB envelope byte bound and must
/// use the adapter's cancellation-aware bounded writer; this is not a combined
///2M host-work ceiling.
pub const MAX_METADATA_ROWS_WORK: usize = 2_000_000;
/// Reserve the existing64KiB control ceiling for the host's result/cursor
/// envelope. Hosts still check the complete encoded response against16MiB.
pub const MAX_METADATA_ROWS_BYTES: usize = 16 * 1024 * 1024 - 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetadataRowsError {
    InvalidLimit,
    ForeignScope,
    InvalidRecord,
    ResourceLimit,
    Cancelled,
    CheckpointMismatch,
}
impl std::fmt::Display for MetadataRowsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Metadata projection: {self:?}")
    }
}
impl std::error::Error for MetadataRowsError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataRowsMode {
    Reset,
    Delta,
}

/// Same file projection as the existing point metadata API. A text-indexed
/// non-Markdown file can have neither metadata nor an exclusion.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataRowsFile<'a> {
    pub entry: &'a EntryState,
    pub metadata: Option<&'a DocumentMetadata>,
    pub exclusion: Option<&'a Exclusion>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MetadataRowsItem<'a> {
    File { value: MetadataRowsFile<'a> },
    Folder { entry: &'a EntryState },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Destination,
    Removals,
    Done,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Position {
    phase: Phase,
    offset: usize,
}
impl Position {
    fn start() -> Self {
        Self {
            phase: Phase::Destination,
            offset: 0,
        }
    }
}

/// O(1) cursor state plus shared existing generation allocations. No pin, source
/// capability, all-row list, copied facts, body or serialized catalog is retained.
/// Clones are independent retry checkpoints in this same pure scan lifetime.
#[derive(Clone)]
pub struct MetadataRowsScan {
    owner: Arc<()>,
    destination: Arc<Generation>,
    baseline: Option<Arc<Generation>>,
    position: Position,
    limit: usize,
    coverage_complete: bool,
    admission_work: usize,
}
impl MetadataRowsScan {
    /// The caller supplies actual admitted immutable generations, not snapshots
    /// reconstructed from claimed labels. Missing/incompatible retained history
    /// starts a reset. A foreign local store is an invalid request, not a reset.
    /// Coverage is checked ONCE here; no whole-generation coverage scan per page.
    pub fn new_checked(
        destination: Arc<Generation>,
        baseline: Option<Arc<Generation>>,
        limit: usize,
        check: &mut impl FnMut() -> bool,
    ) -> Result<Self, MetadataRowsError> {
        if !(1..=MAX_METADATA_ROWS).contains(&limit) {
            return Err(MetadataRowsError::InvalidLimit);
        }
        let mut work = Work::new(check);
        work.take(1)?;
        if baseline
            .as_ref()
            .is_some_and(|old| old.id().local_store_id() != destination.id().local_store_id())
        {
            return Err(MetadataRowsError::ForeignScope);
        }
        let baseline = baseline.filter(|old| {
            old.id().versions() == destination.id().versions()
                && old.id().generation_epoch() == destination.id().generation_epoch()
        });
        let mut coverage_complete = true;
        for entry in destination.manifest().entries() {
            work.take(1)?;
            if entry.kind == EntryKind::File {
                let record = destination
                    .record(&entry.id)
                    .ok_or(MetadataRowsError::InvalidRecord)?;
                if record.exclusion().is_some_and(Exclusion::limits_coverage) {
                    coverage_complete = false;
                }
            }
        }
        work.check()?;
        Ok(Self {
            owner: Arc::new(()),
            destination,
            baseline,
            position: Position::start(),
            limit,
            coverage_complete,
            admission_work: work.used,
        })
    }
    pub fn mode(&self) -> MetadataRowsMode {
        if self.baseline.is_some() {
            MetadataRowsMode::Delta
        } else {
            MetadataRowsMode::Reset
        }
    }
    pub fn snapshot(&self) -> &IndexSnapshotId {
        self.destination.id()
    }
    pub fn source(&self) -> &SourceSnapshotId {
        self.destination.manifest().source()
    }
    pub fn from(&self) -> Option<&IndexSnapshotId> {
        self.baseline.as_ref().map(|g| g.id())
    }
    pub fn admission_work_used(&self) -> usize {
        self.admission_work
    }

    /// Prepares only index offsets into shared immutable facts. It does not
    /// advance this scan. Cancellation, response encoding or final pin failure
    /// therefore leaves the exact old checkpoint available for retry.
    pub fn page_checked(
        &self,
        check: &mut impl FnMut() -> bool,
    ) -> Result<PreparedMetadataRowsPage, MetadataRowsError> {
        let mut work = Work::new(check);
        work.take(1)?;
        let mut page = PreparedMetadataRowsPage {
            owner: self.owner.clone(),
            destination: self.destination.clone(),
            baseline: self.baseline.clone(),
            start: self.position,
            // False status strings are the largest possible header encoding.
            end: Position::start(),
            rows: Vec::new(),
            removed: Vec::new(),
            coverage_complete: self.coverage_complete,
            work_used: 0,
            scanned_entries: 0,
            encoded_bytes_bound: 0,
        };
        page.rows
            .try_reserve_exact(self.limit)
            .map_err(|_| MetadataRowsError::ResourceLimit)?;
        page.removed
            .try_reserve_exact(self.limit)
            .map_err(|_| MetadataRowsError::ResourceLimit)?;
        let mut bytes = encoded_size(&page, MAX_METADATA_ROWS_BYTES, &mut work)?;
        let mut position = self.position;
        self.normalize(&mut position);
        while position.phase != Phase::Done
            && page.scanned_entries < MAX_METADATA_ROWS
            && page.rows.len() + page.removed.len() < self.limit
        {
            page.scanned_entries += 1;
            let candidate = (|| {
                work.take(1)?;
                match position.phase {
                    Phase::Destination => {
                        let entry = &self.destination.manifest().entries()[position.offset];
                        let changed = match &self.baseline {
                            None => true,
                            Some(old) => match lookup(old, &entry.id, &mut work)? {
                                None => true,
                                Some(before) => {
                                    !entry_exact(before, entry, &mut work)?
                                        || !record_exact(
                                            old.record(&entry.id),
                                            self.destination.record(&entry.id),
                                            &mut work,
                                        )?
                                }
                            },
                        };
                        if changed {
                            // VaultPath serialization owns a temporary String. Bound
                            // that allocation before invoking its serde conversion.
                            if entry.path.as_str().len() > MAX_METADATA_ROWS_BYTES {
                                return Err(MetadataRowsError::ResourceLimit);
                            }
                            let row = row_at(&self.destination, position.offset)?;
                            let remaining = MAX_METADATA_ROWS_BYTES
                                .checked_sub(bytes)
                                .and_then(|n| n.checked_sub(usize::from(!page.rows.is_empty())))
                                .ok_or(MetadataRowsError::ResourceLimit)?;
                            let length = encoded_size(&row, remaining, &mut work)?;
                            bytes += length + usize::from(!page.rows.is_empty());
                            page.rows.push(position.offset);
                        }
                    }
                    Phase::Removals => {
                        let old = self
                            .baseline
                            .as_ref()
                            .ok_or(MetadataRowsError::InvalidRecord)?;
                        let entry = &old.manifest().entries()[position.offset];
                        if lookup(&self.destination, &entry.id, &mut work)?.is_none() {
                            let remaining = MAX_METADATA_ROWS_BYTES
                                .checked_sub(bytes)
                                .and_then(|n| n.checked_sub(usize::from(!page.removed.is_empty())))
                                .ok_or(MetadataRowsError::ResourceLimit)?;
                            let length = encoded_size(&entry.id, remaining, &mut work)?;
                            bytes += length + usize::from(!page.removed.is_empty());
                            page.removed.push(position.offset);
                        }
                    }
                    Phase::Done => unreachable!(),
                }
                Ok(())
            })();
            match candidate {
                Ok(()) => {
                    position.offset += 1;
                    self.normalize(&mut position);
                }
                Err(MetadataRowsError::ResourceLimit) if position != self.position => break,
                Err(error) => return Err(error),
            }
        }
        work.check()?;
        page.end = position;
        page.work_used = work.used;
        page.encoded_bytes_bound = bytes;
        Ok(page)
    }
    /// Call only AFTER complete response encoding and fresh host pin validation.
    /// Prepared pages from another scan or an already advanced checkpoint reject.
    pub fn commit_page(&mut self, page: PreparedMetadataRowsPage) -> Result<(), MetadataRowsError> {
        if !Arc::ptr_eq(&self.owner, &page.owner) || self.position != page.start {
            return Err(MetadataRowsError::CheckpointMismatch);
        }
        self.position = page.end;
        Ok(())
    }
    fn normalize(&self, position: &mut Position) {
        if position.phase == Phase::Destination
            && position.offset == self.destination.manifest().entries().len()
        {
            *position = Position {
                phase: if self.baseline.is_some() {
                    Phase::Removals
                } else {
                    Phase::Done
                },
                offset: 0,
            };
        }
        if position.phase == Phase::Removals
            && position.offset
                == self
                    .baseline
                    .as_ref()
                    .map_or(0, |g| g.manifest().entries().len())
        {
            *position = Position {
                phase: Phase::Done,
                offset: 0,
            };
        }
    }
}

/// Bounded page selection, not a clone of its potentially large metadata rows.
/// Serialize borrows the exact facts held by the immutable generation Arcs.
/// Dropping this value does not advance the scan or acquire/release a query pin.
pub struct PreparedMetadataRowsPage {
    owner: Arc<()>,
    destination: Arc<Generation>,
    baseline: Option<Arc<Generation>>,
    start: Position,
    end: Position,
    rows: Vec<usize>,
    removed: Vec<usize>,
    coverage_complete: bool,
    work_used: usize,
    scanned_entries: usize,
    encoded_bytes_bound: usize,
}
impl PreparedMetadataRowsPage {
    pub fn snapshot(&self) -> &IndexSnapshotId {
        self.destination.id()
    }
    pub fn source(&self) -> &SourceSnapshotId {
        self.destination.manifest().source()
    }
    pub fn from(&self) -> Option<&IndexSnapshotId> {
        self.baseline.as_ref().map(|g| g.id())
    }
    pub fn mode(&self) -> MetadataRowsMode {
        if self.baseline.is_some() {
            MetadataRowsMode::Delta
        } else {
            MetadataRowsMode::Reset
        }
    }
    pub fn scan_complete(&self) -> bool {
        self.end.phase == Phase::Done
    }
    pub fn coverage_complete(&self) -> bool {
        self.coverage_complete
    }
    pub fn complete(&self) -> bool {
        self.scan_complete() && self.coverage_complete
    }
    /// Work charged by pure preparation, including the counting traversal.
    /// Does not include the adapter's separately bounded actual encoding pass.
    pub fn preparation_work_used(&self) -> usize {
        self.work_used
    }
    pub fn scanned_entries(&self) -> usize {
        self.scanned_entries
    }
    /// Conservative by at most two status bytes (false becomes true).
    pub fn encoded_bytes_bound(&self) -> usize {
        self.encoded_bytes_bound
    }
    pub fn rows(&self) -> impl Iterator<Item = MetadataRowsItem<'_>> {
        self.rows.iter().map(|&index| {
            row_at(&self.destination, index).expect("indices checked against immutable generation")
        })
    }
    pub fn removed_entry_ids(&self) -> impl Iterator<Item = &EntryId> {
        self.removed.iter().map(|&index| {
            &self
                .baseline
                .as_ref()
                .expect("removals require baseline")
                .manifest()
                .entries()[index]
                .id
        })
    }
}
/// Transport requirement: serialize this bounded selection directly through a
/// cancellation-aware writer capped at16MiB for the COMPLETE host envelope.
/// Do not materialize it with unbounded `to_value`, serialize the generation, or
/// commit its checkpoint before encoding and final pin validation succeed.
/// This traversal is separate from the2M pure-preparation ledger above.
impl Serialize for PreparedMetadataRowsPage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        struct Rows<'a>(&'a PreparedMetadataRowsPage);
        impl Serialize for Rows<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut sequence = serializer.serialize_seq(Some(self.0.rows.len()))?;
                for row in self.0.rows() {
                    sequence.serialize_element(&row)?;
                }
                sequence.end()
            }
        }
        struct Removed<'a>(&'a PreparedMetadataRowsPage);
        impl Serialize for Removed<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut sequence = serializer.serialize_seq(Some(self.0.removed.len()))?;
                for id in self.0.removed_entry_ids() {
                    sequence.serialize_element(id)?;
                }
                sequence.end()
            }
        }
        let mut object = serializer.serialize_struct("DocumentMetadataRowsPage", 9)?;
        object.serialize_field("snapshot", self.snapshot())?;
        object.serialize_field("next", &Option::<()>::None)?;
        object.serialize_field("scanComplete", &self.scan_complete())?;
        object.serialize_field("coverageComplete", &self.coverage_complete)?;
        object.serialize_field("complete", &self.complete())?;
        object.serialize_field("mode", &self.mode())?;
        object.serialize_field("from", &self.from())?;
        object.serialize_field("rows", &Rows(self))?;
        object.serialize_field("removedEntryIds", &Removed(self))?;
        object.end()
    }
}

fn row_at(
    generation: &Generation,
    offset: usize,
) -> Result<MetadataRowsItem<'_>, MetadataRowsError> {
    let entry = generation
        .manifest()
        .entries()
        .get(offset)
        .ok_or(MetadataRowsError::InvalidRecord)?;
    Ok(match entry.kind {
        EntryKind::Folder => MetadataRowsItem::Folder { entry },
        EntryKind::File => {
            let record = generation
                .record(&entry.id)
                .ok_or(MetadataRowsError::InvalidRecord)?;
            MetadataRowsItem::File {
                value: MetadataRowsFile {
                    entry,
                    metadata: record.metadata(),
                    exclusion: record.exclusion(),
                },
            }
        }
    })
}

struct Work<'a> {
    check: &'a mut dyn FnMut() -> bool,
    used: usize,
}
impl<'a> Work<'a> {
    fn new(check: &'a mut impl FnMut() -> bool) -> Self {
        Self { check, used: 0 }
    }
    fn check(&mut self) -> Result<(), MetadataRowsError> {
        if (self.check)() {
            Ok(())
        } else {
            Err(MetadataRowsError::Cancelled)
        }
    }
    fn take(&mut self, units: usize) -> Result<(), MetadataRowsError> {
        self.check()?;
        let next = self
            .used
            .checked_add(units)
            .filter(|n| *n <= MAX_METADATA_ROWS_WORK)
            .ok_or(MetadataRowsError::ResourceLimit)?;
        self.used = next;
        Ok(())
    }
}
fn lookup<'a>(
    g: &'a Generation,
    id: &EntryId,
    work: &mut Work<'_>,
) -> Result<Option<&'a EntryState>, MetadataRowsError> {
    // Conservative binary-search precharge: each probe has one typed visit and
    // at most two64-byte identifier blocks (core IDs are at most128 ASCII bytes).
    let probes = usize::BITS as usize - g.manifest().entries().len().leading_zeros() as usize + 1;
    work.take(probes * 3)?;
    Ok(g.manifest().entry(id))
}
fn string_exact(a: &str, b: &str, work: &mut Work<'_>) -> Result<bool, MetadataRowsError> {
    work.take(1)?;
    if a.len() != b.len() {
        return Ok(false);
    }
    for (a, b) in a.as_bytes().chunks(64).zip(b.as_bytes().chunks(64)) {
        work.take(1)?;
        if a != b {
            return Ok(false);
        }
    }
    Ok(true)
}
fn entry_exact(
    a: &EntryState,
    b: &EntryState,
    w: &mut Work<'_>,
) -> Result<bool, MetadataRowsError> {
    w.take(1)?;
    Ok(a.kind == b.kind
        && a.deleted == b.deleted
        && string_exact(a.id.as_str(), b.id.as_str(), w)?
        && string_exact(a.path.as_str(), b.path.as_str(), w)?
        && string_exact(a.revision.as_str(), b.revision.as_str(), w)?)
}
fn slice_exact<T>(
    a: &[T],
    b: &[T],
    w: &mut Work<'_>,
    mut equal: impl FnMut(&T, &T, &mut Work<'_>) -> Result<bool, MetadataRowsError>,
) -> Result<bool, MetadataRowsError> {
    w.take(1)?;
    if a.len() != b.len() {
        return Ok(false);
    }
    for (a, b) in a.iter().zip(b) {
        w.take(1)?;
        if !equal(a, b, w)? {
            return Ok(false);
        }
    }
    Ok(true)
}
fn property_exact(
    a: &PropertyValue,
    b: &PropertyValue,
    w: &mut Work<'_>,
) -> Result<bool, MetadataRowsError> {
    use PropertyValue as V;
    w.take(1)?;
    Ok(match (a, b) {
        (V::Null, V::Null) => true,
        (V::Bool(a), V::Bool(b)) => a == b,
        (V::Number(a), V::Number(b)) => {
            if a.is_f64() || b.is_f64() {
                a.is_f64() == b.is_f64()
                    && a.as_f64().map(f64::to_bits) == b.as_f64().map(f64::to_bits)
            } else {
                a == b
            }
        }
        (V::String(a), V::String(b)) => string_exact(a, b, w)?,
        (V::Array(a), V::Array(b)) => slice_exact(a, b, w, property_exact)?,
        (V::Object(a), V::Object(b)) => slice_exact(a, b, w, |(ak, av), (bk, bv), w| {
            Ok(string_exact(ak, bk, w)? && property_exact(av, bv, w)?)
        })?,
        _ => false,
    })
}
fn record_exact(
    a: Option<&IndexRecord>,
    b: Option<&IndexRecord>,
    w: &mut Work<'_>,
) -> Result<bool, MetadataRowsError> {
    w.take(1)?;
    match (a, b) {
        (None, None) => Ok(true), // structural folder
        (Some(a), Some(b)) => {
            if a.exclusion() != b.exclusion() {
                return Ok(false);
            }
            match (a.metadata(), b.metadata()) {
                (None, None) => Ok(true),
                (Some(a), Some(b)) => metadata_exact(a, b, w),
                _ => Ok(false),
            }
        }
        _ => Ok(false),
    }
}
fn metadata_exact(
    a: &DocumentMetadata,
    b: &DocumentMetadata,
    w: &mut Work<'_>,
) -> Result<bool, MetadataRowsError> {
    w.take(1)?;
    if a.schema_version != b.schema_version
        || a.source_length != b.source_length
        || a.frontmatter != b.frontmatter
        || !string_exact(&a.dialect_version, &b.dialect_version, w)?
        || !string_exact(a.entry_id.as_str(), b.entry_id.as_str(), w)?
        || !string_exact(a.content_revision.as_str(), b.content_revision.as_str(), w)?
    {
        return Ok(false);
    }
    Ok(slice_exact(&a.properties, &b.properties, w, |a, b, w| {
        Ok(a.property_type == b.property_type
            && a.key_range == b.key_range
            && string_exact(&a.key, &b.key, w)?
            && property_exact(&a.value, &b.value, w)?)
    })? && slice_exact(&a.aliases, &b.aliases, w, |a, b, w| string_exact(a, b, w))?
        && slice_exact(&a.tags, &b.tags, w, |a, b, w| string_exact(a, b, w))?
        && slice_exact(&a.tag_occurrences, &b.tag_occurrences, w, |a, b, w| {
            Ok(a.range == b.range && string_exact(&a.name, &b.name, w)?)
        })?
        && slice_exact(&a.headings, &b.headings, w, |a, b, w| {
            Ok(a.level == b.level
                && a.line == b.line
                && a.range == b.range
                && string_exact(&a.text, &b.text, w)?)
        })?
        && slice_exact(&a.links, &b.links, w, |a, b, w| {
            Ok(a.kind == b.kind
                && a.embed == b.embed
                && a.range == b.range
                && a.target_range == b.target_range
                && a.definition_range == b.definition_range
                && string_exact(&a.target, &b.target, w)?
                && string_exact(&a.fragment, &b.fragment, w)?
                && string_exact(&a.destination, &b.destination, w)?)
        })?
        && slice_exact(&a.tasks, &b.tasks, w, |a, b, w| {
            Ok(a.checked == b.checked
                && a.completed == b.completed
                && a.line == b.line
                && a.range == b.range
                && a.status_range == b.status_range
                && a.text_range == b.text_range
                && a.item_range == b.item_range
                && string_exact(&a.status, &b.status, w)?
                && string_exact(&a.text, &b.text, w)?)
        })?
        && slice_exact(&a.blocks, &b.blocks, w, |a, b, _| Ok(a == b))?
        && slice_exact(&a.list_items, &b.list_items, w, |a, b, w| {
            Ok(a.range == b.range
                && match (&a.task_status, &b.task_status) {
                    (None, None) => true,
                    (Some(a), Some(b)) => string_exact(a, b, w)?,
                    _ => false,
                })
        })?
        && slice_exact(&a.diagnostics, &b.diagnostics, w, |a, b, _| Ok(a == b))?)
}

/// Counts the actual JSON encoding without allocating a serialized duplicate.
/// These counting writes are cancellable and charged to pure preparation in
/// addition to typed comparisons. Actual transport encoding is a separate pass.
fn encoded_size(
    value: &impl Serialize,
    maximum: usize,
    work: &mut Work<'_>,
) -> Result<usize, MetadataRowsError> {
    struct Counter<'a, 'b> {
        bytes: usize,
        maximum: usize,
        work: &'a mut Work<'b>,
        failure: Option<MetadataRowsError>,
    }
    impl Write for Counter<'_, '_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let result = (|| {
                self.work.take(1 + bytes.len().div_ceil(64))?;
                self.bytes = self
                    .bytes
                    .checked_add(bytes.len())
                    .filter(|n| *n <= self.maximum)
                    .ok_or(MetadataRowsError::ResourceLimit)?;
                Ok(())
            })();
            if let Err(error) = result {
                self.failure = Some(error);
                return Err(io::Error::other("metadata page bound/cancellation"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        maximum,
        work,
        failure: None,
    };
    match serde_json::to_writer(&mut counter, value) {
        Ok(()) => Ok(counter.bytes),
        Err(_) => Err(counter.failure.unwrap_or(MetadataRowsError::InvalidRecord)),
    }
}
