//! Entry metadata never selects a file body. Legacy reads explicitly preflight
//! their allocation bound and verify streamed sources inside the same snapshot.
use super::*;
use zorid_core::VaultPath;
use zorid_file_sync::binary_stream::{
    stream_binary, verify_manifest, ContentSink, VerifiedManifest,
};

pub const FAMILY_MAX_INLINE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REFERENCE_BYTES: i64 = 1024 * 1024;
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
    if inline_length.is_some_and(|n| n < 0)
        || reference_length.is_some_and(|n| !(1..=MAX_REFERENCE_BYTES).contains(&n))
        || digest_length.is_some_and(|n| !(1..=256).contains(&n))
        || (inline_length.is_some() && reference_length.is_some())
    {
        return Err(corrupt(
            "invalid entry content authority or metadata bounds",
        ));
    }
    let (path, deleted, json, reference, digest): (
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
    ) = tx.query_row(
        "SELECT path,deleted,state,content_ref,content_digest FROM entries WHERE id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
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
    Ok(Some(StoredEntryMetadata { state, content }))
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
impl Store {
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
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM entries WHERE path=?1 AND deleted=0 AND visible=1",
                [path.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let result = id
            .map(|id| read_metadata_row(&tx, &EntryId::new(id)?))
            .transpose()?
            .flatten();
        tx.commit()?;
        Ok(result)
    }
}

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
    fn graph_backed_reader_fixture(chunk_count: u32) {
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
        graph_backed_reader_fixture(2);
    }
    /// Explicit large gate:
    /// cargo test -p zorid-store --lib entry_content::tests::graph_metadata_64_mib -- --ignored --exact --test-threads=1
    #[test]
    #[ignore = "64MiB durable fixture; run explicitly with the serialized resource slot"]
    fn graph_metadata_64_mib() {
        graph_backed_reader_fixture(512);
    }
}
