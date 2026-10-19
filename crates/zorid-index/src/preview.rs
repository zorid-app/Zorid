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
use zorid_core::{EntryId, EntryKind, OperationId};

#[derive(Debug)]
pub enum PreviewCaptureError<E> {
    Host(E),
    Index(IndexError),
    Resource(&'static str),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewProgress {
    pub prepared_files: u32,
    pub total_files: u32,
    pub pending_files: u32,
}
struct CaptureIdentity {
    owner_nonce: OperationId,
    stage_id: OperationId,
}
struct PreviewBacking {
    manifest: Arc<Manifest>,
    // Exact ID order, without cloned IDs, metadata or source text.
    rows: Vec<Arc<IndexRecord>>,
    progress: PreviewProgress,
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
    /// New owned capture backing/row capacities, including conservative Arc
    /// control/alignment overhead and inline handle fields. Shared stage facts,
    /// manifest and capture-owner identity are already owned/accounted elsewhere;
    /// they are not cloned or charged as new capture allocations. Hosts reserve
    /// this allocation in the existing owner ledger, including retained old
    /// captures and weak IDs; no second query pool is created here.
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
        charge(&mut check, self.manifest.entries().len().saturating_add(1))?;
        let total = self
            .manifest
            .entries()
            .iter()
            .filter(|entry| entry.kind == EntryKind::File)
            .count();
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
            charge(&mut check, 1)?;
            rows.push(record.clone());
        }
        let prepared = u32::try_from(rows.len())
            .map_err(|_| PreviewCaptureError::Resource("preview file count"))?;
        charge(&mut check, 3)?;
        let backing = Arc::new(PreviewBacking {
            manifest: self.manifest.clone(),
            rows,
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
