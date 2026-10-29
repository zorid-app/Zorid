//! Entry metadata never selects a file body. Legacy reads explicitly preflight
//! their allocation bound and verify streamed sources inside the same snapshot.
use super::*;
use zorid_core::VaultPath;
use zorid_file_sync::binary_stream::{
    stream_binary, verify_manifest, ContentSink, VerifiedManifest,
};

pub const FAMILY_MAX_INLINE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REFERENCE_BYTES: i64 = 1024 * 1024;
const MAX_DIGEST_BYTES: i64 = 256;

// A rowid scan cannot spool bounded references into a path-order SQL sorter.
// Lengths remain separate from CASE-projected values so invalid authority is
// rejected before any Rust String getter; CASE preserves the original SQL type.
const READ_STATES_SQL: &str = "SELECT
    length(content),length(CAST(content_ref AS BLOB)),length(CAST(content_digest AS BLOB)),
    id,path,deleted,state,
    CASE WHEN length(CAST(content_ref AS BLOB)) BETWEEN 1 AND ?2 THEN content_ref END,
    CASE WHEN length(CAST(content_digest AS BLOB)) BETWEEN 1 AND ?3 THEN content_digest END
    FROM entries NOT INDEXED WHERE visible=1 AND (?1 OR deleted=0) ORDER BY rowid";

struct MetadataColumns {
    path: String,
    deleted: i64,
    state: String,
    reference: Option<String>,
    digest: Option<String>,
}
impl MetadataColumns {
    fn read(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Self> {
        Ok(Self {
            path: row.get(offset)?,
            deleted: row.get(offset + 1)?,
            state: row.get(offset + 2)?,
            reference: row.get(offset + 3)?,
            digest: row.get(offset + 4)?,
        })
    }
}
fn check_metadata_lengths(
    inline_length: Option<i64>,
    reference_length: Option<i64>,
    digest_length: Option<i64>,
) -> Result<()> {
    if inline_length.is_some_and(|n| n < 0)
        || reference_length.is_some_and(|n| !(1..=MAX_REFERENCE_BYTES).contains(&n))
        || digest_length.is_some_and(|n| !(1..=MAX_DIGEST_BYTES).contains(&n))
        || (inline_length.is_some() && reference_length.is_some())
    {
        return Err(corrupt("invalid entry content authority or metadata bounds"));
    }
    Ok(())
}

// Each visitor receives only metadata decoded and backing-validated in this
// transaction. State-only callers discard content metadata before the next row.
fn visit_metadata(
    tx: &Connection,
    include_deleted: bool,
    mut accept: impl FnMut(StoredEntryMetadata),
) -> Result<()> {
    let mut statement = tx.prepare(READ_STATES_SQL)?;
    let mut rows = statement.query(params![
        include_deleted,
        MAX_REFERENCE_BYTES,
        MAX_DIGEST_BYTES,
    ])?;
    while let Some(row) = rows.next()? {
        let inline_length = row.get(0)?;
        check_metadata_lengths(inline_length, row.get(1)?, row.get(2)?)?;
        let id = EntryId::new(row.get::<_, String>(3)?)?;
        let columns = MetadataColumns::read(row, 4)?;
        accept(decode_metadata(tx, &id, inline_length, columns)?);
    }
    Ok(())
}

/// Complete transaction-current visible metadata, including tombstones when
/// requested. Never select bodies or substitute a partial planner snapshot.
/// Physical overflow pages can still be read by SQLite for later columns.
pub(super) fn read_states(tx: &Connection, include_deleted: bool) -> Result<Vec<EntryState>> {
    let mut entries = Vec::new();
    visit_metadata(tx, include_deleted, |entry| entries.push(entry.state))?;
    // Stable sorting retains rowid order for equal paths (retained tombstones),
    // matching the original path sort's rowid-ordered table-scan input.
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Capture the same complete live selection without decoding its metadata a
/// second time. This private read still validates every row in its current tx.
pub(super) fn read_visible_metadata(tx: &Connection) -> Result<Vec<StoredEntryMetadata>> {
    let mut entries = Vec::new();
    visit_metadata(tx, false, |entry| entries.push(entry))?;
    entries.sort_by(|a, b| a.state.path.cmp(&b.state.path));
    Ok(entries)
}

fn corrupt(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}

pub(super) fn validate_stored_content(
    tx: &Connection,
    content: &StoredContent,
    allow_capture: bool,
) -> Result<()> {
    match content {
        StoredContent::InlineBytes(bytes) => {
            if bytes.len() as u64 > FAMILY_MAX_INLINE_BYTES {
                return Err(StoreError::StreamRequired {
                    bytes: bytes.len() as u64,
                    limit: FAMILY_MAX_INLINE_BYTES,
                });
            }
        }
        StoredContent::BinaryRef(BinarySourceRef::Graph(reference)) => {
            let metadata = blob_index::load_metadata(tx, &reference.scope)?
                .ok_or_else(|| corrupt("published source graph is missing"))?;
            blob_index::check_sources(tx, &metadata)?;
            reference.resolve(&metadata)?;
        }
        StoredContent::BinaryRef(BinarySourceRef::Capture(reference)) if allow_capture => {
            capture_heads(tx, reference, None)?;
        }
        StoredContent::BinaryRef(BinarySourceRef::Capture(_)) => {
            return Err(corrupt("capture cannot be desired entry content"))
        }
    }
    Ok(())
}
fn capture_heads(
    tx: &Connection,
    captured: &CapturedBinaryRef,
    path: Option<&VaultPath>,
) -> Result<()> {
    let stage = blob_stage::resolve_locator(tx, &captured.stage)?;
    let info = blob_stage::stage_info(tx, &stage)?;
    let blob_stage::StagePurpose::Capture(request) = &info.purpose else {
        return Err(corrupt("captured source has command purpose"));
    };
    if info.phase != blob_stage::StagePhase::Sealed
        || info.manifest.as_ref() != Some(&captured.manifest)
        || info.source_commitment != Some(captured.source_commitment)
        || request.expected_length != captured.manifest.bytes
        || request.expected_digest != captured.manifest.digest
        || path.is_some_and(|path| path != &request.path)
    {
        return Err(corrupt("capture differs from sealed original request"));
    }
    for source in blob_stage::staged_sources(tx, &stage)? {
        let head = immutable_payloads::head(tx, &source.key)?
            .ok_or_else(|| corrupt("captured source backing is missing"))?;
        if head.family != source.family
            || head.payload_bytes != source.payload_bytes
            || head.payload_digest != source.payload_digest
            || head.file_summary_digest != source.file_summary_digest
        {
            return Err(corrupt("captured source differs from stage commitments"));
        }
        zorid_file_sync::metadata::GraphRecord::from_persisted_json(
            &head
                .descriptor
                .ok_or_else(|| corrupt("captured descriptor missing"))?,
            source.payload_bytes,
            source.payload_digest,
            source
                .file_summary_digest
                .ok_or_else(|| corrupt("captured summary missing"))?,
        )?;
    }
    Ok(())
}
pub(super) fn validate_captured_at(
    tx: &Connection,
    captured: &CapturedBinaryRef,
    path: &VaultPath,
) -> Result<()> {
    capture_heads(tx, captured, Some(path))
}
pub(super) fn verify_stored_content(tx: &Connection, content: &StoredContent) -> Result<()> {
    validate_stored_content(tx, content, true)?;
    match content {
        StoredContent::InlineBytes(_) => Ok(()),
        StoredContent::BinaryRef(source) => {
            let metadata = match source {
                BinarySourceRef::Graph(reference) => {
                    blob_index::load_metadata(tx, &reference.scope)?
                        .ok_or_else(|| corrupt("source graph missing"))?
                }
                BinarySourceRef::Capture(reference) => blob_stage::capture_metadata(tx, reference)?,
            };
            let mut resolver = match source {
                BinarySourceRef::Graph(_) => blob_index::ChunkResolver::new(tx),
                BinarySourceRef::Capture(reference) => {
                    blob_index::ChunkResolver::for_capture(tx, reference)?
                }
            };
            let result = verify_manifest(&metadata, source.manifest(), &mut resolver);
            resolver.finish(result).map(|_| ())
        }
    }
}

/// Retained rows, including tombstones and hidden family members; no body load.
pub(super) fn read_metadata_row(
    tx: &Connection,
    id: &EntryId,
) -> Result<Option<StoredEntryMetadata>> {
    let lengths: Option<(Option<i64>, Option<i64>, Option<i64>)> = tx.query_row(
        "SELECT length(content),length(CAST(content_ref AS BLOB)),length(CAST(content_digest AS BLOB)) FROM entries WHERE id=?1", [id.as_str()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((inline_length, reference_length, digest_length)) = lengths else {
        return Ok(None);
    };
    check_metadata_lengths(inline_length, reference_length, digest_length)?;
    let columns = tx.query_row(
        "SELECT path,deleted,state,content_ref,content_digest FROM entries WHERE id=?1",
        [id.as_str()],
        |row| MetadataColumns::read(row, 0),
    )?;
    decode_metadata(tx, id, inline_length, columns).map(Some)
}

fn decode_metadata(
    tx: &Connection,
    id: &EntryId,
    inline_length: Option<i64>,
    columns: MetadataColumns,
) -> Result<StoredEntryMetadata> {
    let MetadataColumns {
        path,
        deleted,
        state: json,
        reference,
        digest,
    } = columns;
    let has_content = inline_length.is_some() || reference.is_some();
    let state = decode_state(id.as_str(), &path, deleted, &json, has_content)?;
    if has_content != digest.is_some() {
        return Err(corrupt("entry content digest presence mismatch"));
    }
    let digest = digest
        .map(|json| {
            serde_json::from_str::<Sha256Digest>(&json)
                .map_err(|_| corrupt("invalid entry content digest"))
        })
        .transpose()?;
    let content = match (inline_length, reference, digest) {
        (Some(bytes), None, Some(digest)) => Some(ContentMetadata::InlineBytes {
            bytes: bytes as u64,
            digest,
        }),
        (None, Some(json), Some(digest)) => {
            let source: BinarySourceRef = serde_json::from_str(&json)
                .map_err(|_| corrupt("invalid entry content reference"))?;
            if *source.digest() != digest {
                return Err(corrupt("entry digest differs from binary manifest"));
            }
            if !matches!(&source, BinarySourceRef::Graph(reference) if reference.identity.entry_id == state.id)
            {
                return Err(corrupt(
                    "entry reference has wrong owner or capture purpose",
                ));
            }
            validate_stored_content(tx, &StoredContent::BinaryRef(source.clone()), false)?;
            Some(ContentMetadata::BinaryRef { reference: source })
        }
        (None, None, None) => None,
        _ => return Err(corrupt("entry content columns disagree")),
    };
    Ok(StoredEntryMetadata { state, content })
}

/// Retained content; references remain references and inline bodies are bounded.
pub(super) fn read_content_entry(
    tx: &Connection,
    id: &EntryId,
) -> Result<Option<(EntryState, Option<StoredContent>)>> {
    let Some(metadata) = read_metadata_row(tx, id)? else {
        return Ok(None);
    };
    let content = match metadata.content {
        None => None,
        Some(ContentMetadata::BinaryRef { reference }) => Some(StoredContent::BinaryRef(reference)),
        Some(ContentMetadata::InlineBytes { bytes, digest }) => {
            if bytes > FAMILY_MAX_INLINE_BYTES {
                return Err(StoreError::StreamRequired {
                    bytes,
                    limit: FAMILY_MAX_INLINE_BYTES,
                });
            }
            let body: Vec<u8> = tx.query_row(
                "SELECT content FROM entries WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )?;
            if body.len() as u64 != bytes || Sha256Digest::of(&body) != digest {
                return Err(corrupt("inline content digest mismatch"));
            }
            Some(StoredContent::InlineBytes(body))
        }
    };
    Ok(Some((metadata.state, content)))
}
struct BoundedSink {
    bytes: Vec<u8>,
    expected: u64,
}
impl ContentSink for BoundedSink {
    fn write_chunk(&mut self, bytes: &[u8]) -> zorid_file_sync::Result<()> {
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .is_none_or(|n| n as u64 > self.expected || n as u64 > FAMILY_MAX_INLINE_BYTES)
        {
            return Err(zorid_file_sync::Error::TooLarge);
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn finish(&mut self, verified: &VerifiedManifest) -> zorid_file_sync::Result<()> {
        if self.bytes.len() as u64 != self.expected || verified.manifest().bytes != self.expected {
            return Err(zorid_file_sync::Error::InvalidContent);
        }
        Ok(())
    }
}
pub(super) fn read_legacy_entry(tx: &Connection, id: &EntryId) -> Result<Option<StoredEntry>> {
    let Some(metadata) = read_metadata_row(tx, id)? else {
        return Ok(None);
    };
    if !is_visible(tx, id)? || metadata.state.deleted {
        return Ok(None);
    }
    if let Some(content) = &metadata.content {
        if content.len() > FAMILY_MAX_INLINE_BYTES {
            return Err(StoreError::StreamRequired {
                bytes: content.len(),
                limit: FAMILY_MAX_INLINE_BYTES,
            });
        }
    }
    let (_, content) =
        read_content_entry(tx, id)?.ok_or_else(|| corrupt("entry disappeared in read snapshot"))?;
    let bytes = match content {
        None => None,
        Some(StoredContent::InlineBytes(bytes)) => Some(bytes),
        Some(StoredContent::BinaryRef(BinarySourceRef::Graph(reference))) => {
            let state = blob_index::load_metadata(tx, &reference.scope)?
                .ok_or_else(|| corrupt("published graph missing"))?;
            let content = reference.resolve(&state)?;
            let mut sink = BoundedSink {
                bytes: Vec::with_capacity(reference.manifest.bytes as usize),
                expected: reference.manifest.bytes,
            };
            let mut resolver = blob_index::ChunkResolver::new(tx);
            let result = stream_binary(&state, &content, &mut resolver, &mut sink);
            resolver.finish(result)?;
            Some(sink.bytes)
        }
        Some(StoredContent::BinaryRef(BinarySourceRef::Capture(_))) => {
            return Err(corrupt("entry cannot publish capture"))
        }
    };
    Ok(Some(StoredEntry {
        state: metadata.state,
        content: bytes,
    }))
}
pub(super) fn read_path_metadata_row(
    tx: &Connection,
    path: &VaultPath,
) -> Result<Option<StoredEntryMetadata>> {
    let id: Option<String> = tx.query_row(
        "SELECT id FROM entries WHERE path=?1 AND deleted=0 AND visible=1",
        [path.as_str()],
        |row| row.get(0),
    ).optional()?;
    id.map(|id| read_metadata_row(tx, &EntryId::new(id)?))
        .transpose().map(Option::flatten)
}

impl Store {
    /// One physical inventory row per read-only history-maintenance unit. The
    /// rowid cursor is private scheduling state, never entry or write authority.
    /// New rows behind a live cursor are revisited on the next periodic cycle.
    pub fn recovery_candidate_page(
        &self,
        after_rowid: Option<i64>,
    ) -> Result<(Option<i64>, Option<StoredEntryMetadata>, bool)> {
        let tx = self.connection.unchecked_transaction()?;
        let selected: Option<(i64, Option<String>, i64, i64)> = if let Some(after) = after_rowid {
            tx.query_row(
                "SELECT rowid,CASE WHEN visible=1 AND deleted=0 THEN id END,visible,deleted FROM entries WHERE rowid>?1 ORDER BY rowid LIMIT 1",
                [after],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
        } else {
            tx.query_row(
                "SELECT rowid,CASE WHEN visible=1 AND deleted=0 THEN id END,visible,deleted FROM entries ORDER BY rowid LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
        };
        let Some((rowid, id, visible, deleted)) = selected else {
            tx.commit()?;
            return Ok((after_rowid, None, true));
        };
        if !matches!(visible, 0 | 1) || !matches!(deleted, 0 | 1) {
            return Err(corrupt("invalid entry visibility"));
        }
        let candidate = if visible == 1 && deleted == 0 {
            read_metadata_row(
                &tx,
                &EntryId::new(id.ok_or_else(|| corrupt("live entry identity missing"))?)?,
            )?
        } else {
            None
        };
        let more: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE rowid>?1 LIMIT 1)",
            [rowid],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok((Some(rowid), candidate, !more))
    }

    pub fn read_metadata(&self, id: &EntryId) -> Result<Option<StoredEntryMetadata>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = read_metadata_row(&tx, id)?.filter(|entry| !entry.state.deleted);
        let result = if is_visible(&tx, id)? { result } else { None };
        tx.commit()?;
        Ok(result)
    }
    pub fn read_current_file(&self, id: &EntryId) -> Result<Option<StoredEntryMetadata>> {
        self.read_metadata(id)
    }
    pub fn read_path_metadata(&self, path: &VaultPath) -> Result<Option<StoredEntryMetadata>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = read_path_metadata_row(&tx, path)?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
#[path = "entry_content_bulk_tests.rs"]
mod bulk_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::OperationId;
    fn id() -> EntryId {
        EntryId::new("file").unwrap()
    }
    fn path() -> VaultPath {
        VaultPath::new("file.bin").unwrap()
    }
    fn create(bytes: Vec<u8>) -> MutationRequest {
        MutationRequest {
            operation_id: OperationId::new("create").unwrap(),
            mutation: Mutation::Create {
                id: id(),
                path: path(),
                kind: EntryKind::File,
                content: Some(bytes),
            },
        }
    }
    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("store.sqlite")).unwrap();
        (dir, store)
    }
    #[test]
    fn recovery_candidate_pages_visit_one_row_without_decoding_later_corruption() {
        let (_dir, mut store) = store();
        for name in ["one", "two", "three"] {
            store
                .apply(&MutationRequest {
                    operation_id: OperationId::new(format!("create-{name}")).unwrap(),
                    mutation: Mutation::Create {
                        id: EntryId::new(name).unwrap(),
                        path: VaultPath::new(format!("{name}.md")).unwrap(),
                        kind: EntryKind::File,
                        content: Some(name.as_bytes().to_vec()),
                    },
                })
                .unwrap();
        }
        store
            .connection
            .execute(
                "UPDATE entries SET visible=0,state='invalid hidden' WHERE id='two'",
                [],
            )
            .unwrap();
        store
            .connection
            .execute("UPDATE entries SET state='invalid' WHERE id='three'", [])
            .unwrap();
        let (first, entry, finished) = store.recovery_candidate_page(None).unwrap();
        assert_eq!(entry.unwrap().state.id.as_str(), "one");
        assert!(!finished);
        let (second, entry, finished) = store.recovery_candidate_page(first).unwrap();
        assert!(entry.is_none());
        assert!(!finished);
        assert!(second > first);
        assert!(store.recovery_candidate_page(second).is_err());
    }
    #[test]
    fn recovery_candidate_pages_preserve_empty_and_deleted_row_progress() {
        let (_dir, mut store) = store();
        assert_eq!(
            store.recovery_candidate_page(None).unwrap(),
            (None, None, true)
        );
        store.apply(&create(b"body".to_vec())).unwrap();
        let state = store.read_metadata(&id()).unwrap().unwrap().state;
        store
            .apply(&MutationRequest {
                operation_id: OperationId::new("delete").unwrap(),
                mutation: Mutation::Delete {
                    id: id(),
                    expected: state.revision,
                    recursive: false,
                },
            })
            .unwrap();
        let (cursor, entry, finished) = store.recovery_candidate_page(None).unwrap();
        assert!(cursor.is_some());
        assert!(entry.is_none());
        assert!(finished);
        assert_eq!(
            store.recovery_candidate_page(cursor).unwrap(),
            (cursor, None, true)
        );
    }
    #[test]
    fn stat_path_is_targeted_fresh_and_filters_missing_hidden_deleted_entries() {
        let (dir, mut store) = store();
        store.apply(&create(vec![])).unwrap();
        let empty = store.stat_path(&path()).unwrap().unwrap();
        assert_eq!(empty.state.kind, EntryKind::File);
        assert_eq!(empty.presentation.size_bytes, 0);
        let mut folder = create(vec![]);
        folder.operation_id = OperationId::new("folder-create").unwrap();
        if let Mutation::Create {
            id,
            path,
            kind,
            content,
        } = &mut folder.mutation
        {
            *id = EntryId::new("folder").unwrap();
            *path = VaultPath::new("folder").unwrap();
            *kind = EntryKind::Folder;
            *content = None;
        }
        store.apply(&folder).unwrap();
        let folder_path = VaultPath::new("folder").unwrap();
        assert_eq!(
            store.stat_path(&folder_path).unwrap().unwrap().state.kind,
            EntryKind::Folder
        );
        assert!(store
            .stat_path(&VaultPath::new("missing").unwrap())
            .unwrap()
            .is_none());
        let mut peer = Store::open(dir.path().join("store.sqlite")).unwrap();
        peer.apply(&MutationRequest {
            operation_id: OperationId::new("peer-write").unwrap(),
            mutation: Mutation::Write {
                id: id(),
                expected: empty.state.revision,
                content: b"peer".to_vec(),
            },
        })
        .unwrap();
        let fresh = store.stat_path(&path()).unwrap().unwrap();
        assert_eq!(fresh.presentation.size_bytes, 4);
        assert_eq!(
            fresh.state,
            peer.read_metadata(&id()).unwrap().unwrap().state
        );
        // Invalid unrelated display/state data cannot turn an exact path stat
        // into a full-vault decode; the selected target remains fully checked.
        store
            .connection
            .execute("DELETE FROM entry_presentation WHERE entry_id='folder'", [])
            .unwrap();
        store
            .connection
            .execute("UPDATE entries SET state='bad' WHERE id='folder'", [])
            .unwrap();
        assert_eq!(store.stat_path(&path()).unwrap(), Some(fresh));
        assert!(store.stat_path(&folder_path).is_err());
        store
            .connection
            .execute("UPDATE entries SET visible=0 WHERE id='folder'", [])
            .unwrap();
        assert!(store.stat_path(&folder_path).unwrap().is_none());
        store
            .connection
            .execute("UPDATE entries SET deleted=1 WHERE id='file'", [])
            .unwrap();
        assert!(store.stat_path(&path()).unwrap().is_none());
    }
    #[test]
    fn stat_path_rejects_selected_metadata_and_presentation_corruption() {
        for sql in [
            "UPDATE entries SET content_digest=NULL WHERE id='file'",
            "UPDATE entries SET state=json_set(state,'$.path','other') WHERE id='file'",
            "UPDATE entry_presentation SET size_bytes=1 WHERE entry_id='file'",
            "DELETE FROM entry_presentation WHERE entry_id='file'",
        ] {
            let (_dir, mut store) = store();
            store.apply(&create(vec![])).unwrap();
            store.connection.execute(sql, []).unwrap();
            assert!(
                matches!(store.stat_path(&path()), Err(StoreError::Corrupt(_))),
                "{sql}"
            );
        }
    }

    #[test]
    fn inline_body_digest_and_double_authority_are_rejected() {
        let (_dir, mut store) = store();
        store.apply(&create(vec![1, 2, 3])).unwrap();
        assert_eq!(
            store.read(&id()).unwrap().unwrap().content,
            Some(vec![1, 2, 3])
        );
        store
            .connection
            .execute("UPDATE entries SET content=?1", [vec![3_u8, 2, 1]])
            .unwrap();
        assert!(matches!(store.read(&id()), Err(StoreError::Corrupt(_))));
        // Metadata does not claim a hash of unread bytes; the body reader does.
        assert_eq!(
            store
                .read_metadata(&id())
                .unwrap()
                .unwrap()
                .content
                .unwrap()
                .len(),
            3
        );
        store
            .connection
            .execute("UPDATE entries SET content_ref='{}'", [])
            .unwrap();
        assert!(matches!(
            store.read_metadata(&id()),
            Err(StoreError::Corrupt(_))
        ));
        assert!(matches!(store.list(), Err(StoreError::Corrupt(_))));
    }
    #[test]
    fn legacy_length_preflight_precedes_blob_allocation_in_all_reader_paths() {
        let (_dir, mut store) = store();
        store.apply(&create(vec![])).unwrap();
        let length = FAMILY_MAX_INLINE_BYTES + 1;
        // SQLite constructs the oversized fixture; no whole-file Rust buffer.
        store
            .connection
            .execute("UPDATE entries SET content=zeroblob(?1)", [length as i64])
            .unwrap();
        assert_eq!(
            store
                .read_metadata(&id())
                .unwrap()
                .unwrap()
                .content
                .unwrap()
                .len(),
            length
        );
        store.connection.execute("UPDATE entry_presentation SET size_bytes=?1 WHERE entry_id='file'", [length as i64]).unwrap();
        assert_eq!(store.stat_path(&path()).unwrap().unwrap().presentation.size_bytes, length);
        for result in [
            store.read(&id()).map(|_| ()),
            store.read_path(&path()).map(|_| ()),
            store.read_presented(&id()).map(|_| ()),
        ] {
            assert!(
                matches!(result, Err(StoreError::StreamRequired { bytes, limit }) if bytes==length && limit==FAMILY_MAX_INLINE_BYTES)
            );
        }
        store
            .connection
            .execute("UPDATE entries SET content_digest=NULL", [])
            .unwrap();
        assert!(matches!(
            store.read_metadata(&id()),
            Err(StoreError::Corrupt(_))
        ));
    }
    #[test]
    fn empty_enrolled_binary_remains_a_file_reference_and_presentation_is_zero() {
        let (_dir, mut store) = store();
        store
            .family_enroll(&blob_index::test_support::scope())
            .unwrap();
        store
            .family_apply(&create(vec![]), Some(FamilyCreateMode::Binary))
            .unwrap();
        let metadata = store.read_path_metadata(&path()).unwrap().unwrap();
        assert_eq!(metadata.state.kind, EntryKind::File);
        assert!(
            matches!(metadata.content, Some(ContentMetadata::BinaryRef { reference }) if reference.is_empty())
        );
        let legacy = store.read_path(&path()).unwrap().unwrap();
        assert_eq!(legacy.content, Some(vec![]));
        assert_eq!(legacy.presentation.size_bytes, 0);
        assert_eq!(
            store.list_snapshot().unwrap().entries[0]
                .presentation
                .size_bytes,
            0
        );
    }
    /// Stores each exact chunk independently. The only input byte buffer is one
    /// 128KiB reusable chunk, even for the explicit 64MiB regression.
    fn graph_backed_reader_fixture(chunk_count: u32, stat_only: bool) {
        let (dir, mut store) = store();
        store
            .family_enroll(&blob_index::test_support::scope())
            .unwrap();
        let client = OperationId::new("stream-client").unwrap();
        let operation = OperationId::new("stream-create").unwrap();
        let chunk: Vec<u8> = (0..BINARY_STAGE_MAX_CHUNK_BYTES)
            .map(|n| (n % 251) as u8)
            .collect();
        let length = chunk.len() as u64 * u64::from(chunk_count);
        let stage = store
            .begin_binary_stage(
                &client,
                &operation,
                &BinaryStageRequest {
                    target: BinaryTarget::Create {
                        id: id(),
                        path: path(),
                    },
                    expected_length: Some(length),
                },
                DEFAULT_STREAMING_LIMITS,
            )
            .unwrap();
        for sequence in 0..chunk_count {
            store
                .append_binary_chunk(
                    &stage,
                    sequence,
                    u64::from(sequence) * chunk.len() as u64,
                    &chunk,
                )
                .unwrap();
        }
        let sealed = store.seal_binary_stage(&stage, length, None).unwrap();
        let digest = sealed.manifest().digest;
        store.request_commit_binary_stage(&stage).unwrap();
        let commit = store.commit_binary_stage(&stage).unwrap();
        assert_eq!(commit.target_id(), &id());
        let (inline, reference_len): (bool, i64) = store.connection.query_row(
            "SELECT content IS NOT NULL,length(CAST(content_ref AS BLOB)) FROM entries WHERE id=?1", [id().as_str()], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert!(!inline);
        assert!((1..=MAX_REFERENCE_BYTES).contains(&reference_len));
        drop(store);
        // macOS tempfile paths may use /var's system alias. Resolve only our
        // already-created fixture before testing the no-follow reopen path.
        let database = std::fs::canonicalize(dir.path().join("store.sqlite")).unwrap();
        let mut store = Store::open_existing_no_follow(database).unwrap();
        let metadata = store.read_metadata(&id()).unwrap().unwrap();
        assert_eq!(metadata.content.as_ref().unwrap().len(), length);
        assert_eq!(metadata.content.as_ref().unwrap().digest(), &digest);
        assert_eq!(
            store.read_path_metadata(&path()).unwrap(),
            Some(metadata.clone())
        );
        assert_eq!(
            store.read_current_file(&id()).unwrap(),
            Some(metadata.clone())
        );
        let listing = store.list_snapshot().unwrap();
        let stat = store.stat_path(&path()).unwrap().unwrap();
        assert_eq!(stat, listing.entries[0]);
        if stat_only {
            assert!(length > FAMILY_MAX_INLINE_BYTES);
            assert!(matches!(store.read_path(&path()), Err(StoreError::StreamRequired { .. })));
            return;
        }
        assert_eq!(listing.entries[0].state, metadata.state);
        assert_eq!(listing.entries[0].presentation.size_bytes, length);
        let Some(ContentMetadata::BinaryRef {
            reference: BinarySourceRef::Graph(reference),
        }) = &metadata.content
        else {
            panic!("binary must retain a graph reference");
        };
        let session = store
            .open_binary_read(&client, &metadata.state, reference)
            .unwrap();
        assert_eq!(session.len(), length);
        let offset = chunk.len() as u64 - 19;
        let range = store.read_binary_range(&session, offset, 63).unwrap();
        assert_eq!(range.offset, offset);
        assert_eq!(range.bytes.len(), 63);
        assert!(!range.eof);
        for (index, byte) in range.bytes.iter().enumerate() {
            assert_eq!(*byte, chunk[(offset as usize + index) % chunk.len()]);
        }
        let tail = store.read_binary_range(&session, length - 7, 63).unwrap();
        assert!(tail.eof);
        assert_eq!(tail.bytes, chunk[chunk.len() - 7..]);
        store.close_binary_read(session.reference()).unwrap();
        assert!(store.list_binary_reads(&client).unwrap().is_empty());
        if length > FAMILY_MAX_INLINE_BYTES {
            for result in [
                store.read(&id()).map(|_| ()),
                store.read_path(&path()).map(|_| ()),
                store.read_presented(&id()).map(|_| ()),
            ] {
                assert!(
                    matches!(result, Err(StoreError::StreamRequired { bytes, limit }) if bytes==length && limit==FAMILY_MAX_INLINE_BYTES)
                );
            }
        } else {
            let legacy = store.read_presented(&id()).unwrap().unwrap();
            assert_eq!(legacy.presentation.size_bytes, length);
            let body = legacy.content.unwrap();
            assert_eq!(body.len() as u64, length);
            assert_eq!(Sha256Digest::of(&body), digest);
        }
    }
    #[test]
    fn graph_metadata_and_bounded_cross_chunk_reads_survive_restart() {
        graph_backed_reader_fixture(2, false);
    }
    #[test]
    fn stat_path_large_graph_metadata_does_not_require_whole_file_read() {
        graph_backed_reader_fixture(129, true);
    }
    /// Explicit large gate:
    /// cargo test -p zorid-store --lib entry_content::tests::graph_metadata_64_mib -- --ignored --exact --test-threads=1
    #[test]
    #[ignore = "64MiB durable fixture; run explicitly with the serialized resource slot"]
    fn graph_metadata_64_mib() {
        graph_backed_reader_fixture(512, false);
    }
}
