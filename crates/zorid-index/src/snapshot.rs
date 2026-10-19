use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use zorid_core::{EntryId, EntryKind, EntryState, OperationId};

pub const MAX_PUMP_DOCUMENTS: usize = 32;
pub const MAX_PUMP_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexError {
    InvalidWatermark,
    InvalidVersion,
    InvalidGeneration,
    InvalidManifest,
    MissingSource,
    StaleSource,
    StaleIndex,
    InvalidTarget,
    InvalidRecord,
    GenerationLimit,
    PumpLimit,
    InvalidQuery,
    InvalidBudget,
    SnapshotExpired,
    QueryMismatch,
    ContentMismatch,
    NoProgress,
}
impl std::fmt::Display for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Derived index contract error: {self:?}")
    }
}
impl std::error::Error for IndexError {}

/// Local authority sequence; never a remote cursor or content revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SourceWatermark(String);
impl SourceWatermark {
    pub fn new(value: impl Into<String>) -> Result<Self, IndexError> {
        let value = value.into();
        match value.parse::<u64>() {
            Ok(n) if n.to_string() == value => Ok(Self(value)),
            _ => Err(IndexError::InvalidWatermark),
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSnapshotId {
    local_store_id: OperationId,
    watermark: SourceWatermark,
}
impl SourceSnapshotId {
    pub fn new(local_store_id: OperationId, watermark: SourceWatermark) -> Self {
        Self {
            local_store_id,
            watermark,
        }
    }
    pub fn local_store_id(&self) -> &OperationId {
        &self.local_store_id
    }
    pub fn watermark(&self) -> &SourceWatermark {
        &self.watermark
    }
}
/// Opaque case-sensitive semantic tags. Equality determines compatibility.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "VersionsWire", into = "VersionsWire")]
pub struct SemanticVersions {
    schema: u32,
    extraction: String,
    resolver: String,
    query: String,
}
impl SemanticVersions {
    pub fn new(
        schema: u32,
        extraction: impl Into<String>,
        resolver: impl Into<String>,
        query: impl Into<String>,
    ) -> Result<Self, IndexError> {
        let (extraction, resolver, query) = (extraction.into(), resolver.into(), query.into());
        if schema == 0
            || [&extraction, &resolver, &query].iter().any(|s| {
                s.is_empty()
                    || s.len() > 128
                    || !s.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':')
                    })
            })
        {
            return Err(IndexError::InvalidVersion);
        }
        Ok(Self {
            schema,
            extraction,
            resolver,
            query,
        })
    }
    pub fn schema(&self) -> u32 {
        self.schema
    }
    pub fn extraction(&self) -> &str {
        &self.extraction
    }
    pub fn resolver(&self) -> &str {
        &self.resolver
    }
    pub fn query(&self) -> &str {
        &self.query
    }
}
/// Immutable derived row-set identity; serialize generation as decimal at JS boundaries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "IndexSnapshotWire", into = "IndexSnapshotWire")]
pub struct IndexSnapshotId {
    local_store_id: OperationId,
    generation_epoch: OperationId,
    generation: u64,
    versions: SemanticVersions,
}
impl IndexSnapshotId {
    pub fn new(
        local_store_id: OperationId,
        generation_epoch: OperationId,
        generation: u64,
        versions: SemanticVersions,
    ) -> Result<Self, IndexError> {
        if generation == 0 {
            return Err(IndexError::InvalidGeneration);
        }
        Ok(Self {
            local_store_id,
            generation_epoch,
            generation,
            versions,
        })
    }
    pub fn local_store_id(&self) -> &OperationId {
        &self.local_store_id
    }
    /// Fresh host-CSPRNG token after cache discard/rebuild; never reuse an epoch.
    pub fn generation_epoch(&self) -> &OperationId {
        &self.generation_epoch
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn versions(&self) -> &SemanticVersions {
        &self.versions
    }
}
/// Reserve the next identity from a host's durable allocation watermark.
/// The host persists the returned generation; published head state is unrelated.
pub fn allocate_index_snapshot(
    local_store_id: OperationId,
    generation_epoch: OperationId,
    allocated: u64,
    versions: SemanticVersions,
) -> Result<IndexSnapshotId, IndexError> {
    let generation = allocated
        .checked_add(1)
        .ok_or(IndexError::InvalidGeneration)?;
    IndexSnapshotId::new(local_store_id, generation_epoch, generation, versions)
}

/// Complete committed namespace, without document bodies. Construction validates
/// shape, not that the host actually captured its inventory/head transactionally.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    source: SourceSnapshotId,
    entries: Vec<EntryState>,
    // Offsets into the immutable path-ordered rows, sorted by exact EntryId.
    // No identity/path strings or authority state are duplicated.
    entries_by_id: Vec<usize>,
}
impl Manifest {
    pub fn new(source: SourceSnapshotId, mut entries: Vec<EntryState>) -> Result<Self, IndexError> {
        let (mut ids, mut paths) = (BTreeSet::new(), BTreeSet::new());
        for entry in &entries {
            if entry.deleted || !ids.insert(entry.id.clone()) || !paths.insert(entry.path.clone()) {
                return Err(IndexError::InvalidManifest);
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
        let mut entries_by_id = Vec::new();
        entries_by_id
            .try_reserve_exact(entries.len())
            .map_err(|_| IndexError::GenerationLimit)?;
        entries_by_id.extend(0..entries.len());
        entries_by_id.sort_unstable_by(|&a, &b| entries[a].id.cmp(&entries[b].id));
        Ok(Self {
            source,
            entries,
            entries_by_id,
        })
    }
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
    pub fn entries(&self) -> &[EntryState] {
        &self.entries
    }
    /// Borrow the existing exact-ID ordering; entries themselves remain in
    /// presentation/path order. No index or authority is constructed here.
    pub(crate) fn entry_ordinals_by_id(&self) -> &[usize] {
        &self.entries_by_id
    }
    pub(crate) fn derived_index_heap_bytes(&self) -> usize {
        self.entries_by_id
            .capacity()
            .saturating_mul(std::mem::size_of::<usize>())
    }
    pub fn entry(&self, id: &EntryId) -> Option<&EntryState> {
        self.entries_by_id
            .binary_search_by(|&index| {
                #[cfg(test)]
                manifest_lookup_tests::record_comparison();
                self.entries[index].id.cmp(id)
            })
            .ok()
            .map(|index| &self.entries[self.entries_by_id[index]])
    }
    pub fn witness(&self, id: &EntryId) -> Result<EntryWitness, IndexError> {
        let entry = self
            .entry(id)
            .filter(|e| e.kind == EntryKind::File)
            .ok_or(IndexError::MissingSource)?;
        Ok(EntryWitness {
            source: self.source.clone(),
            entry: entry.clone(),
        })
    }
    /// Namespace precondition only. Later metadata plans additionally verify
    /// exact content mode/digest/parser provenance; this is not a byte proof.
    pub fn check_witness(&self, witness: &EntryWitness) -> Result<(), IndexError> {
        if self.source != witness.source || self.entry(&witness.entry.id) != Some(&witness.entry) {
            return Err(IndexError::StaleSource);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryWitness {
    source: SourceSnapshotId,
    entry: EntryState,
}
impl EntryWitness {
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
    pub fn entry(&self) -> &EntryState {
        &self.entry
    }
}
/// Host must recheck this fence inside its atomic source/index publish transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationFence {
    source: SourceSnapshotId,
    expected_index: Option<IndexSnapshotId>,
    next_index: IndexSnapshotId,
}
impl PublicationFence {
    pub fn new(
        source: SourceSnapshotId,
        expected_index: Option<IndexSnapshotId>,
        next_index: IndexSnapshotId,
    ) -> Result<Self, IndexError> {
        if source.local_store_id != next_index.local_store_id
            || expected_index.as_ref().is_some_and(|old| {
                old.local_store_id != source.local_store_id
                    || (old.generation_epoch == next_index.generation_epoch
                        && old.generation >= next_index.generation)
            })
        {
            return Err(IndexError::InvalidGeneration);
        }
        Ok(Self {
            source,
            expected_index,
            next_index,
        })
    }
    pub fn source(&self) -> &SourceSnapshotId {
        &self.source
    }
    pub fn expected_index(&self) -> Option<&IndexSnapshotId> {
        self.expected_index.as_ref()
    }
    pub fn next_index(&self) -> &IndexSnapshotId {
        &self.next_index
    }
    pub fn check(
        &self,
        observed_source: &SourceSnapshotId,
        observed_index: Option<&IndexSnapshotId>,
    ) -> Result<(), IndexError> {
        if observed_source != &self.source {
            return Err(IndexError::StaleSource);
        }
        if observed_index != self.expected_index.as_ref() {
            return Err(IndexError::StaleIndex);
        }
        Ok(())
    }
}

impl TryFrom<String> for SourceWatermark {
    type Error = IndexError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
impl From<SourceWatermark> for String {
    fn from(value: SourceWatermark) -> Self {
        value.0
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionsWire {
    schema: u32,
    extraction: String,
    resolver: String,
    query: String,
}
impl TryFrom<VersionsWire> for SemanticVersions {
    type Error = IndexError;
    fn try_from(value: VersionsWire) -> Result<Self, Self::Error> {
        Self::new(value.schema, value.extraction, value.resolver, value.query)
    }
}
impl From<SemanticVersions> for VersionsWire {
    fn from(value: SemanticVersions) -> Self {
        Self {
            schema: value.schema,
            extraction: value.extraction,
            resolver: value.resolver,
            query: value.query,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexSnapshotWire {
    local_store_id: OperationId,
    generation_epoch: OperationId,
    generation: String,
    versions: SemanticVersions,
}
impl TryFrom<IndexSnapshotWire> for IndexSnapshotId {
    type Error = IndexError;
    fn try_from(value: IndexSnapshotWire) -> Result<Self, Self::Error> {
        let generation = value
            .generation
            .parse::<u64>()
            .ok()
            .filter(|n| n.to_string() == value.generation)
            .ok_or(IndexError::InvalidGeneration)?;
        Self::new(
            value.local_store_id,
            value.generation_epoch,
            generation,
            value.versions,
        )
    }
}
impl From<IndexSnapshotId> for IndexSnapshotWire {
    fn from(value: IndexSnapshotId) -> Self {
        Self {
            local_store_id: value.local_store_id,
            generation_epoch: value.generation_epoch,
            generation: value.generation.to_string(),
            versions: value.versions,
        }
    }
}

#[cfg(test)]
mod manifest_lookup_tests {
    use super::*;
    use std::cell::Cell;
    use zorid_core::{Revision, VaultPath};

    thread_local! {
        static COMPARISONS: Cell<usize> = const { Cell::new(0) };
    }
    pub(super) fn record_comparison() {
        COMPARISONS.with(|value| value.set(value.get() + 1));
    }
    fn source(store: &str, watermark: &str) -> SourceSnapshotId {
        SourceSnapshotId::new(
            OperationId::new(store).unwrap(),
            SourceWatermark::new(watermark).unwrap(),
        )
    }
    fn row(index: usize, path_index: usize) -> EntryState {
        EntryState {
            id: EntryId::new(format!("entry-{index:05}")).unwrap(),
            revision: Revision::new(format!("revision-{index}")).unwrap(),
            path: VaultPath::new(format!("Notes/Path-{path_index:05}.md")).unwrap(),
            kind: if index % 7 == 0 {
                EntryKind::Folder
            } else {
                EntryKind::File
            },
            deleted: false,
        }
    }
    fn assert_linear_parity(manifest: &Manifest, ids: &[EntryId]) {
        for id in ids {
            assert_eq!(
                manifest.entry(id),
                manifest.entries().iter().find(|entry| &entry.id == id),
                "exact whole state for {}",
                id.as_str()
            );
        }
    }

    #[test]
    fn id_lookup_preserves_path_order_and_full_state_across_adversarial_permutations() {
        // 73 permutes all residues modulo257; ID and path order disagree.
        let mut rows: Vec<_> = (0..257).map(|i| row(i, (i * 73) % 257)).collect();
        rows[0].path = VaultPath::new("a/é.md").unwrap();
        rows[1].path = VaultPath::new("A/😀.md").unwrap();
        rows[2].path = VaultPath::new("a/É.md").unwrap();
        rows[3].id = EntryId::new("ENTRY-00003").unwrap();
        let expected = Manifest::new(source("store", "7"), rows.clone()).unwrap();
        let mut ordered = rows.clone();
        ordered.sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
        assert_eq!(expected.entries(), ordered);
        let mut ids: Vec<_> = rows.iter().map(|row| row.id.clone()).collect();
        ids.extend(
            ["entry-00003", "ENTRY-00004", "missing", "entry-99999"]
                .map(|s| EntryId::new(s).unwrap()),
        );
        for mode in 0..5 {
            let mut input = rows.clone();
            match mode {
                0 => {}
                1 => input.reverse(),
                2 => input.rotate_left(113),
                3 => input.sort_by(|a, b| b.id.cmp(&a.id)),
                4 => input.sort_by_key(|entry| entry.revision.as_str().len()),
                _ => unreachable!(),
            }
            let manifest = Manifest::new(source("store", "7"), input).unwrap();
            assert_eq!(manifest, expected);
            assert_eq!(manifest.clone(), manifest);
            assert_linear_parity(&manifest, &ids);
            assert_eq!(manifest.entries_by_id.len(), rows.len());
            assert!(manifest
                .entries_by_id
                .windows(2)
                .all(|pair| manifest.entries[pair[0]].id < manifest.entries[pair[1]].id));
            assert_eq!(
                manifest.derived_index_heap_bytes(),
                manifest.entries_by_id.capacity() * std::mem::size_of::<usize>()
            );
        }
    }

    #[test]
    fn lookup_comparison_count_is_logarithmic_for_present_and_missing_ids() {
        for count in [0usize, 1, 2, 3, 31, 4096] {
            let rows = (0..count).map(|i| row(i * 2, count - i)).collect();
            let manifest = Manifest::new(source("store", "7"), rows).unwrap();
            let mut ids: Vec<_> = (0..count)
                .map(|i| EntryId::new(format!("entry-{:05}", i * 2)).unwrap())
                .collect();
            ids.extend(["ENTRY", "entry-00001", "entry-99999"].map(|s| EntryId::new(s).unwrap()));
            let bound = if count == 0 {
                0
            } else {
                usize::BITS as usize - count.leading_zeros() as usize + 1
            };
            for id in ids {
                COMPARISONS.with(|value| value.set(0));
                let actual = manifest.entry(&id);
                let comparisons = COMPARISONS.with(Cell::get);
                assert_eq!(
                    actual,
                    manifest.entries().iter().find(|entry| entry.id == id)
                );
                assert!(
                    comparisons <= bound,
                    "{count} rows: {comparisons} comparisons exceed {bound}"
                );
                assert_eq!(comparisons == 0, count == 0);
            }
        }
    }

    #[test]
    fn selected_rows_keep_file_requirement_and_full_namespace_witness_preconditions() {
        let original = Manifest::new(source("store", "7"), vec![row(1, 2), row(0, 1)]).unwrap();
        let id = original
            .entries()
            .iter()
            .find(|row| row.kind == EntryKind::File)
            .unwrap()
            .id
            .clone();
        let witness = original.witness(&id).unwrap();
        assert_eq!(original.check_witness(&witness), Ok(()));
        assert_eq!(
            original.witness(&EntryId::new("entry-00000").unwrap()),
            Err(IndexError::MissingSource)
        );
        assert_eq!(
            original.witness(&EntryId::new("missing").unwrap()),
            Err(IndexError::MissingSource)
        );
        for change in 0..7 {
            let mut rows = original.entries().to_vec();
            let selected = rows.iter_mut().find(|row| row.id == id).unwrap();
            let mut head = source("store", "7");
            match change {
                0 => selected.path = VaultPath::new("Moved.md").unwrap(),
                1 => selected.revision = Revision::new("changed").unwrap(),
                2 => selected.kind = EntryKind::Folder,
                3 => selected.id = EntryId::new("replacement").unwrap(),
                4 => rows.retain(|row| row.id != id),
                5 => head = source("store", "8"),
                6 => head = source("other-store", "7"),
                _ => unreachable!(),
            }
            let current = Manifest::new(head, rows).unwrap();
            assert_eq!(
                current.check_witness(&witness),
                Err(IndexError::StaleSource),
                "case {change}"
            );
        }
    }

    #[test]
    fn invalid_duplicates_or_deleted_rows_never_gain_a_derived_index() {
        let first = row(1, 1);
        let mut duplicate_id = row(1, 2);
        duplicate_id.kind = EntryKind::Folder;
        let duplicate_path = row(2, 1);
        let mut deleted = row(3, 3);
        deleted.deleted = true;
        for rows in [
            vec![first.clone(), duplicate_id],
            vec![first, duplicate_path],
            vec![deleted],
        ] {
            assert_eq!(
                Manifest::new(source("store", "7"), rows),
                Err(IndexError::InvalidManifest)
            );
        }
        let empty = Manifest::new(source("store", "7"), Vec::new()).unwrap();
        assert!(empty.entries().is_empty());
        assert_eq!(empty.derived_index_heap_bytes(), 0);
        assert_eq!(empty.entry(&EntryId::new("missing").unwrap()), None);
    }
}

#[cfg(test)]
mod allocation_tests {
    use super::*;

    fn allocate(allocated: u64) -> Result<IndexSnapshotId, IndexError> {
        allocate_index_snapshot(
            OperationId::new("local-store").unwrap(),
            OperationId::new("generation-epoch").unwrap(),
            allocated,
            SemanticVersions::new(2, "extraction:v2", "resolver:v3", "query:v4").unwrap(),
        )
    }

    #[test]
    fn first_allocation_retains_the_exact_scope_epoch_and_semantic_versions() {
        let snapshot = allocate(0).unwrap();
        assert_eq!(snapshot.generation(), 1);
        assert_eq!(snapshot.local_store_id().as_str(), "local-store");
        assert_eq!(snapshot.generation_epoch().as_str(), "generation-epoch");
        assert_eq!(
            snapshot.versions(),
            &SemanticVersions::new(2, "extraction:v2", "resolver:v3", "query:v4").unwrap()
        );
    }

    #[test]
    fn allocation_above_javascript_integer_precision_is_exact_and_serializes_as_decimal() {
        let snapshot = allocate(9_007_199_254_740_992).unwrap();
        assert_eq!(snapshot.generation(), 9_007_199_254_740_993);
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["generation"], "9007199254740993");
        assert_eq!(
            serde_json::from_value::<IndexSnapshotId>(wire).unwrap(),
            snapshot
        );
    }

    #[test]
    fn last_u64_generation_is_valid_without_wrapping() {
        let snapshot = allocate(u64::MAX - 1).unwrap();
        assert_eq!(snapshot.generation(), u64::MAX);
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["generation"], u64::MAX.to_string());
    }

    #[test]
    fn exhausted_allocation_rejects_instead_of_reusing_zero_or_head() {
        assert_eq!(allocate(u64::MAX), Err(IndexError::InvalidGeneration));
    }
}
