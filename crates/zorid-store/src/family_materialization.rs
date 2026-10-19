//! Derived publication cache. Graph/text state remains authoritative; hidden
//! outcomes never replace retained bytes with empty or guessed content.
use super::content::{BinarySourceRef, PublishedBinaryRef, StoredContent};
use super::*;
use std::{cell::OnceCell, collections::BTreeMap};
use zorid_core::EntryChange;
use zorid_file_sync::binary_stream::VerifiedBinarySet;
use zorid_file_sync::materialization::{ContentWitness, PendingReason};
use zorid_file_sync::metadata::{MetadataState, MetadataView};
use zorid_file_sync::reference_materialization::{ContentRef, EntryMaterializationRef, OutcomeRef};
use zorid_file_sync::{EntryIdentity, Sha256Digest};
use zorid_sync_protocol::UpdateId;

pub(super) const SCHEMA: &[(&str, &str)] = &[
 ("family_materializations","CREATE TABLE family_materializations (entry_id TEXT PRIMARY KEY, record TEXT NOT NULL)"),
 ("family_materialization_history","CREATE TABLE family_materialization_history (entry_id TEXT NOT NULL, revision TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(entry_id,revision))"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum FamilyPublication {
    Normal {
        path: zorid_core::VaultPath,
        kind: EntryKind,
        namespace_heads: Vec<UpdateId>,
        location_event: UpdateId,
    },
    Pending {
        reason: PendingReason,
    },
    Recovery {
        reason: zorid_file_sync::RecoveryReason,
    },
    Tombstone,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyContentWitness {
    pub digest: Sha256Digest,
    pub witness: ContentWitness,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyMaterialization {
    pub identity: EntryIdentity,
    pub publication: FamilyPublication,
    /// Witness of bytes retained in entries, NOT proof of filesystem publication.
    pub retained_content: Option<FamilyContentWitness>,
}
pub(super) fn get(tx: &Connection, id: &EntryId) -> Result<Option<FamilyMaterialization>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM family_materializations WHERE entry_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| {
        let record: FamilyMaterialization = serde_json::from_str(&raw)?;
        if record.identity.entry_id != *id {
            return Err(StoreError::Corrupt(
                "materialization SQL/identity mismatch".into(),
            ));
        }
        Ok(record)
    })
    .transpose()
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct RetainedEntry {
    state: EntryState,
    content: Option<StoredContent>,
}
fn retained_entry(tx: &Connection, id: &EntryId) -> Result<Option<(RetainedEntry, bool)>> {
    let sizes: Option<(Option<i64>, Option<i64>, Option<i64>)> = tx
        .query_row(
            "SELECT length(content),length(CAST(content_ref AS BLOB)),length(CAST(content_digest AS BLOB)) FROM entries WHERE id=?1",
            [id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if sizes.is_some_and(|(inline, reference, digest)| {
        inline.is_some_and(|n| n < 0 || n > zorid_client_sync::MAX_TEXT_BYTES as i64)
            || reference.is_some_and(|n| {
                n <= 0 || n > zorid_file_sync::metadata::MAX_GRAPH_RECORD_BYTES as i64
            })
            || digest.is_some_and(|n| !(1..=256).contains(&n))
    }) {
        return Err(StoreError::Corrupt(
            "retained publication content exceeds metadata/text bound".into(),
        ));
    }
    let raw = tx
        .query_row(
            "SELECT path,deleted,state,content,visible,content_ref,content_digest FROM entries WHERE id=?1",
            [id.as_str()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<Vec<u8>>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?;
    raw.map(|(path, deleted, raw, inline, visible, reference, digest)| {
        let content = match (inline, reference) {
            (Some(bytes), None) => Some(StoredContent::InlineBytes(bytes)),
            (None, Some(raw)) => {
                let source: BinarySourceRef = serde_json::from_str(&raw)?;
                if !matches!(source, BinarySourceRef::Graph(_)) {
                    return Err(StoreError::Corrupt(
                        "captured source cannot be desired publication".into(),
                    ));
                }
                Some(StoredContent::BinaryRef(source))
            }
            (None, None) => None,
            (Some(_), Some(_)) => {
                return Err(StoreError::Corrupt(
                    "entry has two content authorities".into(),
                ))
            }
        };
        let stored_digest: Option<Sha256Digest> =
            digest.map(|raw| serde_json::from_str(&raw)).transpose()?;
        if stored_digest != content.as_ref().map(StoredContent::digest) {
            return Err(StoreError::Corrupt(
                "retained publication digest differs from typed content".into(),
            ));
        }
        if !matches!(visible, 0 | 1) {
            return Err(StoreError::Corrupt("invalid publication visibility".into()));
        }
        Ok((
            RetainedEntry {
                state: decode_state(id.as_str(), &path, deleted, &raw, content.is_some())?,
                content,
            },
            visible == 1,
        ))
    })
    .transpose()
}
fn load_metadata(tx: &Connection) -> Result<MetadataState> {
    let authority = text_sync::identity(tx)?;
    let (Some(realm_id), Some(vault_id)) = (authority.realm_id, authority.vault_id) else {
        return Err(StoreError::Corrupt("family scope missing".into()));
    };
    blob_index::load_metadata(tx, &FamilyScope { realm_id, vault_id })?
        .ok_or_else(|| StoreError::Corrupt("family metadata missing".into()))
}
/// One immutable graph per invocation. Only retained Text checks need its view;
/// binary-only/folder-only validation does not derive an additional graph view.
/// SQL content, snapshots and verification proofs are always checked afresh.
struct RetainedGraphView<'g> {
    graph: &'g MetadataState,
    view: OnceCell<zorid_file_sync::Result<MetadataView>>,
}
impl<'g> RetainedGraphView<'g> {
    fn new(graph: &'g MetadataState) -> Self {
        Self {
            graph,
            view: OnceCell::new(),
        }
    }
    fn view(&self) -> Result<&MetadataView> {
        self.view
            .get_or_init(|| self.graph.metadata_view())
            .as_ref()
            .map_err(|error| StoreError::from(error.clone()))
    }
}
fn check_retained_content(
    tx: &Connection,
    graph: &MetadataState,
    identity: &EntryIdentity,
    witness: &FamilyContentWitness,
    content: &StoredContent,
    verified: Option<&VerifiedBinarySet>,
) -> Result<()> {
    check_retained_content_with_view(
        tx,
        &RetainedGraphView::new(graph),
        identity,
        witness,
        content,
        verified,
    )
}
fn check_retained_content_with_view(
    tx: &Connection,
    context: &RetainedGraphView<'_>,
    identity: &EntryIdentity,
    witness: &FamilyContentWitness,
    content: &StoredContent,
    verified: Option<&VerifiedBinarySet>,
) -> Result<()> {
    let graph = context.graph;
    if content.digest() != witness.digest {
        return Err(StoreError::Corrupt(
            "retained content differs from witness digest".into(),
        ));
    }
    match (&witness.witness, content) {
        (
            ContentWitness::Text {
                identity: text_identity,
                revision,
                snapshot_digest,
            },
            StoredContent::InlineBytes(bytes),
        ) => {
            let view = context.view()?;
            if view
                .namespace()
                .entries
                .get(&identity.entry_id)
                .is_none_or(|entry| &entry.identity != identity)
                || !matches!(view.content_bindings().get(&identity.entry_id), Some(zorid_file_sync::v2::ContentBinding::Text { text_bootstrap_id, text_format }) if text_bootstrap_id == &text_identity.bootstrap_id && *text_format == zorid_client_sync::v2::TEXT_FORMAT_VERSION)
            {
                return Err(StoreError::Corrupt(
                    "retained text binding differs from metadata".into(),
                ));
            }
            let state = text_sync::revision(tx, &identity.entry_id, revision)?
                .ok_or_else(|| StoreError::Corrupt("retained text witness missing".into()))?;
            if &state.identity != text_identity
                || state.identity.entry_id != identity.entry_id
                || state.identity.realm_id != graph.scope().realm_id
                || state.identity.vault_id != graph.scope().vault_id
                || Sha256Digest::of(&state.snapshot) != *snapshot_digest
                || state.complete_materialized_utf8()?.as_deref() != Some(bytes.as_slice())
            {
                return Err(StoreError::Corrupt(
                    "retained text witness does not prove bytes".into(),
                ));
            }
        }
        (
            ContentWitness::Binary {
                selected_event,
                manifest,
            },
            StoredContent::BinaryRef(BinarySourceRef::Graph(reference)),
        ) => {
            if &reference.identity != identity
                || &reference.selected_event != selected_event
                || &reference.manifest != manifest
            {
                return Err(StoreError::Corrupt(
                    "retained binary locator differs from witness".into(),
                ));
            }
            let resolved = reference.resolve(graph)?;
            if let Some(verified) = verified {
                verified.check_preconditions(graph)?;
                verified
                    .get(resolved.manifest())?
                    .ok_or_else(|| {
                        StoreError::Corrupt(
                            "retained binary manifest lacks exact-state verification".into(),
                        )
                    })?
                    .check_preconditions(graph, resolved.manifest())?;
            }
        }
        _ => {
            return Err(StoreError::Corrupt(
                "retained content kind differs from witness".into(),
            ))
        }
    }
    Ok(())
}
/// Historical binary locators are checked against immutable event identity and
/// manifest metadata. This does not reread file bytes or manufacture a proof.
fn check_history_metadata(
    tx: &Connection,
    graph: &MetadataState,
    record: &FamilyMaterialization,
) -> Result<()> {
    if let Some(witness) = &record.retained_content {
        match &witness.witness {
            ContentWitness::Binary {
                selected_event,
                manifest,
            } => {
                if witness.digest != manifest.digest {
                    return Err(StoreError::Corrupt(
                        "historical manifest digest differs from witness".into(),
                    ));
                }
                PublishedBinaryRef {
                    scope: graph.scope().clone(),
                    identity: record.identity.clone(),
                    selected_event: selected_event.clone(),
                    manifest: manifest.clone(),
                }
                .resolve(graph)?;
            }
            ContentWitness::Text {
                identity,
                revision,
                snapshot_digest,
            } => {
                let view = graph.metadata_view()?;
                if identity.entry_id != record.identity.entry_id
                    || view
                        .namespace()
                        .entries
                        .get(&record.identity.entry_id)
                        .is_none_or(|entry| entry.identity != record.identity)
                    || !matches!(view.content_bindings().get(&record.identity.entry_id), Some(zorid_file_sync::v2::ContentBinding::Text { text_bootstrap_id, text_format }) if text_bootstrap_id == &identity.bootstrap_id && *text_format == zorid_client_sync::v2::TEXT_FORMAT_VERSION)
                {
                    return Err(StoreError::Corrupt(
                        "historical text binding differs from metadata".into(),
                    ));
                }
                let text = text_sync::revision(tx, &record.identity.entry_id, revision)?
                    .ok_or_else(|| StoreError::Corrupt("historical text witness missing".into()))?;
                if &text.identity != identity
                    || identity.realm_id != graph.scope().realm_id
                    || identity.vault_id != graph.scope().vault_id
                    || Sha256Digest::of(&text.snapshot) != *snapshot_digest
                    || text
                        .complete_materialized_utf8()?
                        .is_none_or(|bytes| Sha256Digest::of(&bytes) != witness.digest)
                {
                    return Err(StoreError::Corrupt(
                        "historical text witness differs from snapshot".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}
fn check_current_metadata(
    tx: &Connection,
    graph: &MetadataState,
    record: &FamilyMaterialization,
) -> Result<()> {
    check_history_metadata(tx, graph, record)?;
    let row = retained_entry(tx, &record.identity.entry_id)?;
    let normal = matches!(&record.publication, FamilyPublication::Normal { .. });
    if normal != row.as_ref().is_some_and(|(_, visible)| *visible) {
        return Err(StoreError::Corrupt(
            "publication visibility differs from metadata".into(),
        ));
    }
    if let Some((row, _)) = row {
        if history(tx, &row.state.id, &row.state.revision)?.as_ref() != Some(record) {
            return Err(StoreError::Corrupt(
                "current publication differs from immutable history".into(),
            ));
        }
        match (&row.content, &record.retained_content) {
            (Some(content), Some(witness)) => {
                check_retained_content(tx, graph, &record.identity, witness, content, None)?
            }
            (None, None) if row.state.kind == EntryKind::Folder => {}
            _ => {
                return Err(StoreError::Corrupt(
                    "retained publication content missing".into(),
                ))
            }
        }
        if let FamilyPublication::Normal {
            path,
            kind,
            namespace_heads,
            location_event,
        } = &record.publication
        {
            let view = graph.metadata_view()?;
            let entry = view.namespace().entries.get(&row.state.id).ok_or_else(|| {
                StoreError::Corrupt("Normal publication identity missing from metadata".into())
            })?;
            if row.state.deleted
                || &row.state.path != path
                || &row.state.kind != kind
                || entry.identity != record.identity
                || entry.kind != *kind
                || !matches!(&entry.projection, zorid_file_sync::Projection::Normal { path: actual } if actual == path)
                || &entry.heads != namespace_heads
                || entry.locations.last().map(|value| &value.event) != Some(location_event)
            {
                return Err(StoreError::Corrupt(
                    "Normal publication differs from current metadata".into(),
                ));
            }
            if let Some(FamilyContentWitness {
                witness: ContentWitness::Text { revision, .. },
                ..
            }) = &record.retained_content
            {
                let source =
                    text_sync::revision(tx, &row.state.id, revision)?.ok_or_else(|| {
                        StoreError::Corrupt("current text witness revision missing".into())
                    })?;
                if text_sync::retained(tx, &row.state.id)?.as_ref() != Some(&source) {
                    return Err(StoreError::Corrupt(
                        "Normal text witness differs from current retained snapshot".into(),
                    ));
                }
            }
            if let Some(FamilyContentWitness {
                witness:
                    ContentWitness::Binary {
                        selected_event,
                        manifest,
                    },
                ..
            }) = &record.retained_content
            {
                if entry.contents.last().is_none_or(|head| {
                    &head.event != selected_event
                        || &head.manifest != manifest
                        || !head.status.missing.is_empty()
                }) {
                    return Err(StoreError::Corrupt(
                        "Normal binary publication is not selected complete content".into(),
                    ));
                }
            }
        }
    } else {
        let had_row: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM family_materialization_history WHERE entry_id=?1)",
            [record.identity.entry_id.as_str()],
            |row| row.get(0),
        )?;
        if record.retained_content.is_some() || normal || had_row {
            return Err(StoreError::Corrupt(
                "retained publication row missing".into(),
            ));
        }
    }
    Ok(())
}
struct Change {
    record: FamilyMaterialization,
    before: Option<RetainedEntry>,
    after: Option<RetainedEntry>,
    was_visible: bool,
    visible: bool,
    changed: bool,
}
fn candidate_with_view(
    tx: &Connection,
    context: &RetainedGraphView<'_>,
    verified: &VerifiedBinarySet,
    classified: &EntryMaterializationRef,
) -> Result<Change> {
    let id = &classified.identity.entry_id;
    let prior = get(tx, id)?;
    let row = retained_entry(tx, id)?;
    match (&prior, &row) {
        (Some(prior), Some((row, _)))
            if history(tx, id, &row.state.revision)?.as_ref() != Some(prior) =>
        {
            return Err(StoreError::Corrupt(
                "retained publication differs from immutable history".into(),
            ));
        }
        (Some(prior), None) => {
            let had_row: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM family_materialization_history WHERE entry_id=?1)",
                [id.as_str()],
                |row| row.get(0),
            )?;
            if prior.retained_content.is_some() || had_row {
                return Err(StoreError::Corrupt(
                    "historically retained publication row missing".into(),
                ));
            }
        }
        _ => {}
    }
    if prior
        .as_ref()
        .is_some_and(|r| r.identity != classified.identity)
        || (prior.is_none() && row.is_some())
    {
        return Err(StoreError::Corrupt(
            "materialization binding has changed or is missing".into(),
        ));
    }
    if prior
        .as_ref()
        .is_some_and(|r| matches!(r.publication, FamilyPublication::Normal { .. }))
        != row.as_ref().is_some_and(|(_, v)| *v)
    {
        return Err(StoreError::Corrupt(
            "publication status and visible cache disagree".into(),
        ));
    }
    let (before, was_visible) = row.map(|(row, v)| (Some(row), v)).unwrap_or((None, false));
    let mut record = FamilyMaterialization {
        identity: classified.identity.clone(),
        publication: FamilyPublication::Tombstone,
        retained_content: prior.as_ref().and_then(|r| r.retained_content.clone()),
    };
    let mut after = before.clone();
    let visible = match &classified.outcome {
        OutcomeRef::Normal {
            path,
            kind,
            content,
            namespace_heads,
            location_event,
        } => {
            record.publication = FamilyPublication::Normal {
                path: path.clone(),
                kind: *kind,
                namespace_heads: namespace_heads.clone(),
                location_event: location_event.clone(),
            };
            record.retained_content = content.as_ref().map(|content| match content {
                ContentRef::Text(value) => FamilyContentWitness {
                    digest: value.digest,
                    witness: value.witness.clone(),
                },
                ContentRef::Binary(value) => FamilyContentWitness {
                    digest: value.manifest().digest,
                    witness: ContentWitness::Binary {
                        selected_event: value.selected_event().clone(),
                        manifest: value.manifest().clone(),
                    },
                },
            });
            after = Some(RetainedEntry {
                state: EntryState {
                    id: id.clone(),
                    path: path.clone(),
                    kind: *kind,
                    revision: before
                        .as_ref()
                        .map(|e| e.state.revision.clone())
                        .unwrap_or(Revision::new("unallocated")?),
                    deleted: false,
                },
                content: content.as_ref().map(|content| match content {
                    ContentRef::Text(value) => StoredContent::InlineBytes(value.bytes.clone()),
                    ContentRef::Binary(value) => StoredContent::BinaryRef(BinarySourceRef::Graph(
                        PublishedBinaryRef::from_verified_content(value),
                    )),
                }),
            });
            true
        }
        OutcomeRef::Pending { reason } => {
            record.publication = FamilyPublication::Pending {
                reason: reason.clone(),
            };
            false
        }
        OutcomeRef::Recovery { reason } => {
            record.publication = FamilyPublication::Recovery {
                reason: reason.clone(),
            };
            // A retained conflict is not a semantic tombstone, even if the
            // previous namespace observation was deleted. Visibility stays off.
            if let Some(row) = &mut after {
                row.state.deleted = false;
            }
            false
        }
        OutcomeRef::Tombstone => {
            if let Some(row) = &mut after {
                row.state.deleted = true;
            }
            false
        }
    };
    if let Some(before) = &before {
        if (before.state.kind == EntryKind::File)
            != prior.as_ref().is_some_and(|r| r.retained_content.is_some())
        {
            return Err(StoreError::Corrupt(
                "retained publication witness missing".into(),
            ));
        }
        if let Some(witness) = prior.as_ref().and_then(|r| r.retained_content.as_ref()) {
            let content = before
                .content
                .as_ref()
                .ok_or_else(|| StoreError::Corrupt("retained content missing".into()))?;
            check_retained_content_with_view(
                tx,
                context,
                &classified.identity,
                witness,
                content,
                Some(verified),
            )?;
        }
    }
    let changed = prior.as_ref() != Some(&record) || before != after || was_visible != visible;
    Ok(Change {
        record,
        before,
        after,
        was_visible,
        visible,
        changed,
    })
}
/// Validate the old cache before mutating causal state. Missing old rows are
/// corruption, not permission to manufacture a new cache on duplicate delivery.
pub(super) fn validate(
    tx: &Connection,
    graph: &MetadataState,
    verified: &VerifiedBinarySet,
) -> Result<()> {
    let classified = zorid_file_sync::reference_materialization::classify_metadata(
        graph,
        verified,
        &family_ingress::retained_texts(tx, graph.scope())?,
        zorid_file_sync::MAX_FILE_BYTES,
        zorid_file_sync::MAX_STATE_BYTES as u64,
    )?;
    let count: i64 = tx.query_row("SELECT count(*) FROM family_materializations", [], |r| {
        r.get(0)
    })?;
    if usize::try_from(count).ok() != Some(classified.len()) {
        return Err(StoreError::Corrupt(
            "publication cache identity coverage mismatch".into(),
        ));
    }
    let context = RetainedGraphView::new(graph);
    for value in &classified {
        if candidate_with_view(tx, &context, verified, value)?.changed {
            return Err(StoreError::Corrupt(
                "publication cache differs from causal authority".into(),
            ));
        }
    }
    Ok(())
}
pub(super) fn pending_count(tx: &Connection) -> Result<u32> {
    let raws: Vec<String> = tx
        .prepare("SELECT record FROM family_materializations")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let mut count = 0u32;
    for raw in raws {
        let value: FamilyMaterialization = serde_json::from_str(&raw)?;
        if matches!(value.publication, FamilyPublication::Pending { .. }) {
            count = count
                .checked_add(1)
                .ok_or_else(|| StoreError::Corrupt("pending count overflow".into()))?;
        }
    }
    Ok(count)
}
pub(super) fn recovery_count(tx: &Connection) -> Result<u32> {
    let records: Vec<String> = tx
        .prepare("SELECT record FROM family_materializations")?
        .query_map([], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let mut count = 0u32;
    for raw in records {
        let record: FamilyMaterialization = serde_json::from_str(&raw)?;
        if matches!(record.publication, FamilyPublication::Recovery { .. }) {
            count = count
                .checked_add(1)
                .ok_or_else(|| StoreError::Corrupt("recovery count overflow".into()))?;
        }
    }
    Ok(count)
}
/// Every changed metadata token is fresh across the whole vault, including
/// ancestors. Metadata-only changes keep immutable causal snapshots intact.
pub(super) fn apply(
    tx: &Connection,
    graph: &MetadataState,
    verified: &VerifiedBinarySet,
    origin: ProjectionOrigin,
    allocated_revision: Option<&Revision>,
) -> Result<Vec<EntryId>> {
    let texts = family_ingress::retained_texts(tx, graph.scope())?;
    let classified = zorid_file_sync::reference_materialization::classify_metadata(
        graph,
        verified,
        &texts,
        zorid_file_sync::MAX_FILE_BYTES,
        zorid_file_sync::MAX_STATE_BYTES as u64,
    )?;
    let classified: BTreeMap<_, _> = classified
        .into_iter()
        .map(|c| (c.identity.entry_id.clone(), c))
        .collect();
    let context = RetainedGraphView::new(graph);
    let mut changes: BTreeMap<EntryId, Change> = classified
        .iter()
        .map(|(id, c)| Ok((id.clone(), candidate_with_view(tx, &context, verified, c)?)))
        .collect::<Result<_>>()?;
    // Existing caches may never disappear from the immutable graph identity set.
    let cached: Vec<String> = tx
        .prepare("SELECT entry_id FROM family_materializations")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    if cached.iter().any(|id| {
        EntryId::new(id)
            .ok()
            .is_none_or(|id| !classified.contains_key(&id))
    }) {
        return Err(StoreError::Corrupt(
            "publication cache has no graph identity".into(),
        ));
    }
    let changed_paths: Vec<_> = changes
        .values()
        .filter(|c| c.changed)
        .flat_map(|c| {
            c.before
                .iter()
                .chain(c.after.iter())
                .map(|e| e.state.path.clone())
        })
        .collect();
    for change in changes.values_mut() {
        if change.visible
            && change.after.as_ref().is_some_and(|row| {
                row.state.kind == EntryKind::Folder
                    && changed_paths
                        .iter()
                        .any(|path| path.is_descendant_of(&row.state.path))
            })
        {
            change.changed = true;
        }
    }
    if !changes.values().any(|c| c.changed) {
        return Ok(Vec::new());
    }
    let revision = match allocated_revision {
        Some(value) => value.clone(),
        None => {
            let value = Revision::new(uuid::Uuid::new_v4().to_string())?;
            text_sync::reserve_revision(tx, &value)?;
            value
        }
    };
    // Release every changed visible path first, making subtree relocation atomic.
    for (id, change) in &changes {
        if change.changed {
            tx.execute("UPDATE entries SET visible=0 WHERE id=?1", [id.as_str()])?;
        }
    }
    let mut changed_ids = Vec::new();
    let mut metadata_changes = Vec::new();
    for (id, mut change) in changes {
        if !change.changed {
            continue;
        }
        changed_ids.push(id.clone());
        if let Some(after) = &mut change.after {
            after.state.revision = revision.clone();
            if let Some(content) = &mut change.record.retained_content {
                if let ContentWitness::Text {
                    identity,
                    revision: source_revision,
                    snapshot_digest,
                } = &mut content.witness
                {
                    let mut source =
                        text_sync::revision(tx, &id, source_revision)?.ok_or_else(|| {
                            StoreError::Corrupt("retained text publication revision missing".into())
                        })?;
                    if &source.identity != identity
                        || Sha256Digest::of(&source.snapshot) != *snapshot_digest
                        || source.materialized_utf8()?.as_slice()
                            != after
                                .content
                                .as_ref()
                                .and_then(StoredContent::inline_bytes)
                                .ok_or_else(|| {
                                    StoreError::Corrupt(
                                        "text publication has no inline content".into(),
                                    )
                                })?
                    {
                        return Err(StoreError::Corrupt(
                            "text publication provenance mismatch".into(),
                        ));
                    }
                    source.version = revision.clone();
                    if let Some(existing) = text_sync::revision(tx, &id, &revision)? {
                        // The trusted authored planner may already have persisted
                        // this exact state earlier in THIS commit. Never upsert a
                        // historical token or accept a different branch under it.
                        if existing != source
                            || (change.visible
                                && text_sync::retained(tx, &id)?.as_ref() != Some(&source))
                        {
                            return Err(zorid_client_sync::SyncError::VersionConflict.into());
                        }
                    } else if change.visible {
                        text_sync::put_current(tx, &source)?;
                    } else {
                        text_sync::put_revision(tx, &source)?;
                    }
                    *source_revision = revision.clone();
                }
            }
            let (inline, reference) = match after.content.as_ref() {
                Some(StoredContent::InlineBytes(bytes)) => (Some(bytes.as_slice()), None),
                Some(StoredContent::BinaryRef(value @ BinarySourceRef::Graph(_))) => {
                    (None, Some(serde_json::to_string(value)?))
                }
                Some(StoredContent::BinaryRef(BinarySourceRef::Capture(_))) => {
                    return Err(StoreError::Corrupt("capture cannot be published".into()))
                }
                None => (None, None),
            };
            let digest = after
                .content
                .as_ref()
                .map(|content| serde_json::to_string(&content.digest()))
                .transpose()?;
            tx.execute("INSERT INTO entries(id,path,deleted,state,content,visible,content_ref,content_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET path=excluded.path,deleted=excluded.deleted,state=excluded.state,content=excluded.content,visible=excluded.visible,content_ref=excluded.content_ref,content_digest=excluded.content_digest",params![id.as_str(),after.state.path.as_str(),after.state.deleted,serde_json::to_string(&after.state)?,inline,change.visible,reference,digest])?;
            let entry_change = EntryChange {
                before: change.before.as_ref().map(|e| e.state.clone()),
                after: after.state.clone(),
            };
            // Namespace work uses exact affected identities; attachment/provenance
            // remains a separate physical phase and may stay pending.
            if matches!(origin, ProjectionOrigin::LocalCommand { .. }) {
                // One exact local job is enqueued from the retained core receipt.
            } else if after.state.deleted {
                if change.before.as_ref().is_some_and(|b| !b.state.deleted) {
                    projection_jobs::enqueue_received_work(
                        tx,
                        origin.clone(),
                        ProjectionWork::Delete,
                        after.state.clone(),
                        vec![entry_change.clone()],
                    )?;
                }
            } else if change.visible {
                let moved = change
                    .before
                    .as_ref()
                    .is_some_and(|b| b.state.path != after.state.path);
                if moved {
                    projection_jobs::enqueue_received_work(
                        tx,
                        origin.clone(),
                        ProjectionWork::Move,
                        after.state.clone(),
                        vec![entry_change.clone()],
                    )?;
                }
                if after.state.kind == EntryKind::File {
                    projection_jobs::enqueue_received_work(
                        tx,
                        origin.clone(),
                        ProjectionWork::MaterializeFile,
                        after.state.clone(),
                        vec![entry_change.clone()],
                    )?;
                } else if !change.was_visible {
                    projection_jobs::enqueue_received_work(
                        tx,
                        origin.clone(),
                        ProjectionWork::CreateDirectory,
                        after.state.clone(),
                        vec![entry_change.clone()],
                    )?;
                }
            }
            metadata_changes.push(entry_change);
        }
        if let Some(after) = &change.after {
            let encoded = serde_json::to_string(&change.record)?;
            let prior:Option<String>=tx.query_row("SELECT record FROM family_materialization_history WHERE entry_id=?1 AND revision=?2",params![id.as_str(),after.state.revision.as_str()],|r|r.get(0)).optional()?;
            if prior.as_ref().is_some_and(|prior| prior != &encoded) {
                return Err(StoreError::Corrupt(
                    "immutable publication history changed".into(),
                ));
            }
            tx.execute(
                "INSERT OR IGNORE INTO family_materialization_history VALUES(?1,?2,?3)",
                params![id.as_str(), after.state.revision.as_str(), encoded],
            )?;
        }
        tx.execute("INSERT INTO family_materializations VALUES(?1,?2) ON CONFLICT(entry_id) DO UPDATE SET record=excluded.record",params![id.as_str(),serde_json::to_string(&change.record)?])?;
    }
    let states = read_states(tx, false)?;
    zorid_core::validate_snapshot(&states)?;
    presentation::record_family_reload(tx, origin, &metadata_changes, presentation::now_ms()?)?;
    Ok(changed_ids)
}

impl Store {
    pub fn family_materialization(&self, id: &EntryId) -> Result<Option<FamilyMaterialization>> {
        let tx = self.connection.unchecked_transaction()?;
        let authority = text_sync::identity(&tx)?;
        let (Some(realm_id), Some(vault_id)) = (authority.realm_id, authority.vault_id) else {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        };
        let graph = blob_index::load_metadata(&tx, &zorid_file_sync::Scope { realm_id, vault_id })?
            .ok_or_else(|| StoreError::Corrupt("enrolled graph missing".into()))?;
        let value = get(&tx, id)?;
        if let Some(record) = &value {
            check_current_metadata(&tx, &graph, record)?;
        } else {
            let known = graph.records().values().any(|record| match record.body() {
                zorid_file_sync::metadata::GraphRecordBody::Events { events }
                | zorid_file_sync::metadata::GraphRecordBody::ObservedDelete { events } => {
                    events.iter().any(|event| event.identity.entry_id == *id)
                }
                _ => false,
            }) || graph
                .activities()
                .values()
                .any(|activity| activity.identity().entry_id == *id);
            if known {
                return Err(StoreError::Corrupt(
                    "graph identity lacks publication cache".into(),
                ));
            }
        }
        tx.commit()?;
        Ok(value)
    }
}

impl Store {
    /// Exact historical desired-publication witness. A physical baseline selects
    /// this by the revision actually published, never by the latest graph head.
    pub fn family_publication(
        &self,
        id: &EntryId,
        revision: &Revision,
    ) -> Result<Option<FamilyMaterialization>> {
        let tx = self.connection.unchecked_transaction()?;
        let raw:Option<String>=tx.query_row("SELECT record FROM family_materialization_history WHERE entry_id=?1 AND revision=?2",params![id.as_str(),revision.as_str()],|r|r.get(0)).optional()?;
        let value = raw
            .map(|raw| -> Result<FamilyMaterialization> {
                let record: FamilyMaterialization = serde_json::from_str(&raw)?;
                if record.identity.entry_id != *id {
                    return Err(StoreError::Corrupt(
                        "publication history identity mismatch".into(),
                    ));
                }
                Ok(record)
            })
            .transpose()?;
        if let Some(record) = &value {
            check_history_metadata(&tx, &load_metadata(&tx)?, record)?;
        }
        tx.commit()?;
        Ok(value)
    }
}

pub(super) fn history(
    tx: &Connection,
    id: &EntryId,
    revision: &Revision,
) -> Result<Option<FamilyMaterialization>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT record FROM family_materialization_history WHERE entry_id=?1 AND revision=?2",
            params![id.as_str(), revision.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| -> Result<FamilyMaterialization> {
        let value: FamilyMaterialization = serde_json::from_str(&raw)?;
        if value.identity.entry_id != *id {
            return Err(StoreError::Corrupt(
                "publication history identity mismatch".into(),
            ));
        }
        Ok(value)
    })
    .transpose()
}
/// Called by the physical owner's finish transaction BEFORE changing baseline
/// or retiring jobs. A desired revision is never inferred from today's graph.
pub(super) fn check_publication(
    tx: &Connection,
    state: &EntryState,
    content: Option<&[u8]>,
) -> Result<()> {
    if let Some(bytes) = content {
        const INLINE_LIMIT: u64 = 16 * 1024 * 1024;
        if bytes.len() as u64 > INLINE_LIMIT {
            return Err(StoreError::StreamRequired {
                bytes: bytes.len() as u64,
                limit: INLINE_LIMIT,
            });
        }
    }
    let owned = content.map(|bytes| StoredContent::InlineBytes(bytes.to_vec()));
    check_publication_content(tx, state, owned.as_ref())
}
/// Metadata-only check of a typed physical target. Reading bytes later must use
/// a checked pin; a serialized locator is never itself a content proof.
pub(super) fn check_publication_content(
    tx: &Connection,
    state: &EntryState,
    content: Option<&StoredContent>,
) -> Result<()> {
    let enrolled: bool =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_heads)", [], |r| {
            r.get(0)
        })?;
    if !enrolled {
        return Ok(());
    }
    let record = history(tx, &state.id, &state.revision)?.ok_or_else(|| {
        StoreError::Corrupt("physical publication lacks immutable family witness".into())
    })?;
    if state.deleted
        || !matches!(&record.publication, FamilyPublication::Normal { path, kind, .. } if path == &state.path && kind == &state.kind)
    {
        return Err(StoreError::Corrupt(
            "physical publication is not its exact historical Normal target".into(),
        ));
    }
    let graph = load_metadata(tx)?;
    match (content, &record.retained_content) {
        (None, None) if state.kind == EntryKind::Folder => Ok(()),
        (Some(value), Some(witness)) if state.kind == EntryKind::File => {
            check_retained_content(tx, &graph, &record.identity, witness, value, None)?;
            if let ContentWitness::Text { revision, .. } = &witness.witness {
                if revision != &state.revision {
                    return Err(StoreError::Corrupt(
                        "physical text revision differs from history".into(),
                    ));
                }
            }
            Ok(())
        }
        _ => Err(StoreError::Corrupt(
            "physical content kind differs from history".into(),
        )),
    }
}

impl Store {
    pub fn family_assert_projected(&self, id: &EntryId) -> Result<()> {
        let tx = self.connection.unchecked_transaction()?;
        let record = get(&tx, id)?.ok_or_else(|| ContractError::InvalidMutation {
            reason: "entry has no family materialization".into(),
        })?;
        let Some((entry, true)) = retained_entry(&tx, id)? else {
            return Err(ContractError::InvalidMutation {
                reason: "entry is not visible for projection".into(),
            }
            .into());
        };
        if !matches!(&record.publication,FamilyPublication::Normal{path,kind,..} if path==&entry.state.path && kind==&entry.state.kind)
        {
            return Err(ContractError::InvalidMutation {
                reason: "entry is not Normal for projection".into(),
            }
            .into());
        }
        let saved = history(&tx, id, &entry.state.revision)?
            .ok_or_else(|| StoreError::Corrupt("current publication history missing".into()))?;
        if saved != record {
            return Err(StoreError::Corrupt(
                "current family witness differs from history".into(),
            ));
        }
        match entry.state.kind {
            EntryKind::File => {
                let baseline = projection::baseline(&tx, id)?.ok_or_else(|| {
                    ContractError::InvalidMutation {
                        reason: "file has not been physically projected".into(),
                    }
                })?;
                if baseline.state != entry.state
                    || Some(&baseline.content) != entry.content.as_ref()
                {
                    return Err(ContractError::InvalidMutation {
                        reason: "file projection remains pending".into(),
                    }
                    .into());
                }
                check_publication_content(&tx, &baseline.state, Some(&baseline.content))?;
            }
            EntryKind::Folder => {
                let baseline =
                    self.directory_baseline(id)?
                        .ok_or_else(|| ContractError::InvalidMutation {
                            reason: "directory has not been physically projected".into(),
                        })?;
                if baseline.state != entry.state {
                    return Err(ContractError::InvalidMutation {
                        reason: "directory projection remains pending".into(),
                    }
                    .into());
                }
                check_publication(&tx, &baseline.state, None)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

/// A folder's optimistic ancestor token may advance while its actual namespace
/// frontier stays identical. The physical owner separately proves inode/parent
/// identity and performs its baseline+binding CAS in this SAME transaction.
pub(super) fn same_directory_publication(
    tx: &Connection,
    before: &EntryState,
    after: &EntryState,
) -> Result<bool> {
    if before.id != after.id
        || before.path != after.path
        || before.kind != EntryKind::Folder
        || after.kind != EntryKind::Folder
        || before.deleted
        || after.deleted
    {
        return Ok(false);
    }
    let enrolled: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM family_graph_heads)",
        [],
        |row| row.get(0),
    )?;
    if !enrolled {
        return Ok(true);
    }
    let previous = history(tx, &before.id, &before.revision)?.ok_or_else(|| {
        StoreError::Corrupt("previous directory publication history missing".into())
    })?;
    let next = history(tx, &after.id, &after.revision)?.ok_or_else(|| {
        StoreError::Corrupt("current directory publication history missing".into())
    })?;
    let normal = |record: &FamilyMaterialization, state: &EntryState| {
        record.identity.entry_id == state.id
            && record.retained_content.is_none()
            && matches!(&record.publication,FamilyPublication::Normal{path,kind:EntryKind::Folder,..} if path==&state.path)
    };
    Ok(normal(&previous, before) && normal(&next, after) && previous == next)
}

#[cfg(test)]
mod directory_publication_tests {
    use super::*;
    use zorid_core::OperationId;
    #[test]
    fn revision_only_folder_publication_requires_identical_namespace_witness() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("vault.sqlite")).unwrap();
        store
            .family_enroll(&FamilyScope {
                realm_id: zorid_sync_protocol::RealmId::new("realm").unwrap(),
                vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
            })
            .unwrap();
        let folder = EntryId::new("folder").unwrap();
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("folder_create").unwrap(),
                    mutation: Mutation::Create {
                        id: folder.clone(),
                        path: zorid_core::VaultPath::new("folder").unwrap(),
                        kind: EntryKind::Folder,
                        content: None,
                    },
                },
                None,
            )
            .unwrap();
        let before = store.read(&folder).unwrap().unwrap().state;
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("child_create").unwrap(),
                    mutation: Mutation::Create {
                        id: EntryId::new("child").unwrap(),
                        path: zorid_core::VaultPath::new("folder/child.bin").unwrap(),
                        kind: EntryKind::File,
                        content: Some(vec![1]),
                    },
                },
                Some(FamilyCreateMode::Binary),
            )
            .unwrap();
        let after = store.read(&folder).unwrap().unwrap().state;
        assert_ne!(before.revision, after.revision);
        assert!(same_directory_publication(&store.connection, &before, &after).unwrap());
        let original = history(&store.connection, &folder, &after.revision)
            .unwrap()
            .unwrap();
        for change_location in [false, true] {
            let mut changed = original.clone();
            if let FamilyPublication::Normal {
                namespace_heads,
                location_event,
                ..
            } = &mut changed.publication
            {
                if change_location {
                    *location_event = UpdateId::new("different_location").unwrap();
                } else {
                    *namespace_heads = vec![UpdateId::new("different_frontier").unwrap()];
                }
            }
            store.connection.execute("UPDATE family_materialization_history SET record=?1 WHERE entry_id=?2 AND revision=?3", params![serde_json::to_string(&changed).unwrap(), folder.as_str(), after.revision.as_str()]).unwrap();
            assert!(!same_directory_publication(&store.connection, &before, &after).unwrap());
        }
    }
}

/// Prepare immutable provenance for bytes actually being moved. This allocates
/// history only: the namespace journal owns filesystem proof and final baseline CAS.
pub(super) fn prepare_physical_move(
    tx: &Connection,
    before: &EntryState,
    desired: &EntryState,
    members: &[EntryState],
) -> Result<EntryState> {
    let invalid = |reason: &str| StoreError::Corrupt(reason.into());
    if before.id != desired.id || before.kind != desired.kind || before.deleted || desired.deleted {
        return Err(invalid("physical move identity/kind mismatch"));
    }
    let (actual, visible) = retained_entry(tx, &desired.id)?
        .ok_or_else(|| invalid("physical move desired entry missing"))?;
    if !visible || actual.state != *desired || !members.contains(desired) {
        return Err(invalid("physical move desired state changed"));
    }
    let binding = physical_bindings::binding(tx, &before.id)?
        .ok_or_else(|| invalid("physical move binding missing"))?;
    if binding.state != *before {
        return Err(invalid("physical move binding changed"));
    }
    let bytes = match before.kind {
        EntryKind::File => {
            let baseline = projection::baseline(tx, &before.id)?
                .ok_or_else(|| invalid("physical move file baseline missing"))?;
            if baseline.state != *before {
                return Err(invalid("physical move file baseline changed"));
            }
            Some(baseline.content)
        }
        EntryKind::Folder => {
            let baseline = directory::baseline(tx, &before.id)?
                .ok_or_else(|| invalid("physical move folder baseline missing"))?;
            if baseline.state != *before {
                return Err(invalid("physical move folder baseline changed"));
            }
            None
        }
    };
    check_publication_content(tx, before, bytes.as_ref())?;
    let mut old = history(tx, &before.id, &before.revision)?
        .ok_or_else(|| invalid("physical move old history missing"))?;
    let current =
        get(tx, &desired.id)?.ok_or_else(|| invalid("physical move target history missing"))?;
    if history(tx, &desired.id, &desired.revision)?.as_ref() != Some(&current)
        || old.identity != current.identity
    {
        return Err(invalid("physical move immutable identity/history mismatch"));
    }
    let FamilyPublication::Normal {
        path: current_path,
        kind: current_kind,
        location_event: selected,
        ..
    } = &current.publication
    else {
        return Err(invalid("physical move target is not Normal"));
    };
    if current_path != &desired.path || current_kind != &desired.kind {
        return Err(invalid("physical move target path/kind mismatch"));
    }
    let authority = text_sync::identity(tx)?;
    let (Some(realm_id), Some(vault_id)) = (authority.realm_id, authority.vault_id) else {
        return Err(invalid("physical move family scope missing"));
    };
    let graph = blob_index::load_metadata(tx, &FamilyScope { realm_id, vault_id })?
        .ok_or_else(|| invalid("physical move graph missing"))?;
    let FamilyPublication::Normal {
        path,
        namespace_heads,
        location_event,
        ..
    } = &mut old.publication
    else {
        return Err(invalid("physical move old publication is not Normal"));
    };
    if location_event != selected {
        *namespace_heads =
            graph.join_physical_move_frontier(&old.identity, namespace_heads, selected)?;
        *location_event = selected.clone();
    } else if before.path != desired.path {
        let mut witnessed = false;
        for ancestor in members
            .iter()
            .filter(|m| m.kind == EntryKind::Folder && !m.deleted && m.id != before.id)
        {
            let Some(bound) = physical_bindings::binding(tx, &ancestor.id)? else {
                continue;
            };
            let prefix = format!("{}/", bound.state.path.as_str());
            let Some(suffix) = before.path.as_str().strip_prefix(&prefix) else {
                continue;
            };
            if desired.path.as_str() != format!("{}/{}", ancestor.path.as_str(), suffix) {
                continue;
            }
            let Some((row, true)) = retained_entry(tx, &ancestor.id)? else {
                continue;
            };
            if row.state != *ancestor {
                return Err(invalid("physical ancestor target changed"));
            }
            let prior = history(tx, &ancestor.id, &bound.state.revision)?
                .ok_or_else(|| invalid("physical ancestor history missing"))?;
            let next = get(tx, &ancestor.id)?
                .ok_or_else(|| invalid("physical ancestor target missing"))?;
            if prior.identity != next.identity {
                return Err(invalid("physical ancestor identity changed"));
            }
            if let (
                FamilyPublication::Normal {
                    path: old_path,
                    kind: EntryKind::Folder,
                    namespace_heads: heads,
                    location_event: old_event,
                },
                FamilyPublication::Normal {
                    path: new_path,
                    kind: EntryKind::Folder,
                    location_event: new_event,
                    ..
                },
            ) = (&prior.publication, &next.publication)
            {
                if old_path == &bound.state.path
                    && new_path == &ancestor.path
                    && old_event != new_event
                {
                    graph.join_physical_move_frontier(&prior.identity, heads, new_event)?;
                    witnessed = true;
                    break;
                }
            }
        }
        if !witnessed {
            return Err(invalid(
                "physical descendant move lacks explicit ancestor lineage",
            ));
        }
    }
    *path = desired.path.clone();
    let mut physical = before.clone();
    physical.path = desired.path.clone();
    physical.revision = Revision::new(uuid::Uuid::new_v4().to_string())?;
    text_sync::reserve_revision(tx, &physical.revision)?;
    if let Some(FamilyContentWitness {
        witness: ContentWitness::Text { revision, .. },
        ..
    }) = &mut old.retained_content
    {
        let mut text = text_sync::revision(tx, &before.id, revision)?
            .ok_or_else(|| invalid("physical text branch missing"))?;
        text.version = physical.revision.clone();
        text_sync::put_revision(tx, &text)?;
        *revision = physical.revision.clone();
    }
    tx.execute(
        "INSERT INTO family_materialization_history(entry_id,revision,record) VALUES(?1,?2,?3)",
        params![
            physical.id.as_str(),
            physical.revision.as_str(),
            serde_json::to_string(&old)?
        ],
    )?;
    check_publication_content(tx, &physical, bytes.as_ref())?;
    Ok(physical)
}

#[cfg(test)]
fn candidate(
    tx: &Connection,
    graph: &MetadataState,
    verified: &VerifiedBinarySet,
    classified: &EntryMaterializationRef,
) -> Result<Change> {
    candidate_with_view(tx, &RetainedGraphView::new(graph), verified, classified)
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    use zorid_file_sync::{
        binary_stream::{verify_complete_binary_manifests, ChunkSource},
        metadata::GraphRecord,
        v2, Manifest, Scope,
    };
    use zorid_sync_protocol::{RealmId, VaultId};

    struct NoChunks;
    impl ChunkSource for NoChunks {
        fn read_chunk(
            &mut self,
            _: &Scope,
            _: &UpdateId,
            _: &GraphRecord,
        ) -> zorid_file_sync::Result<Vec<u8>> {
            panic!("empty binary must never request a body")
        }
    }
    fn fixture() -> (
        Connection,
        MetadataState,
        VerifiedBinarySet,
        EntryMaterializationRef,
    ) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE entries(id TEXT PRIMARY KEY,path TEXT,deleted INTEGER,state TEXT,content BLOB,visible INTEGER,content_ref TEXT,content_digest TEXT)").unwrap();
        for (_, sql) in SCHEMA {
            db.execute_batch(sql).unwrap();
        }
        let scope = Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        };
        let event = UpdateId::new("create").unwrap();
        let identity = EntryIdentity {
            entry_id: EntryId::new("file").unwrap(),
            bootstrap_id: event.clone(),
        };
        let payload = v2::Payload {
            family: zorid_file_sync::Family::Files,
            format_version: 2,
            scope: scope.clone(),
            id: event.clone(),
            body: v2::Body::Events {
                events: vec![v2::EntryEvent {
                    id: event.clone(),
                    identity,
                    parents: vec![],
                    effect: v2::Effect::Create {
                        entry_kind: EntryKind::File,
                        location: zorid_file_sync::Location {
                            parent: None,
                            name: "empty.bin".into(),
                        },
                        content: Some(v2::ContentSeed::Binary {
                            manifest: Manifest {
                                bytes: 0,
                                digest: Sha256Digest::of(&[]),
                                pages: vec![],
                            },
                        }),
                    },
                }],
            },
        };
        let (_, id, descriptor) =
            GraphRecord::from_authored_exact(&payload.encode().unwrap()).unwrap();
        let graph = MetadataState::from_records(
            scope,
            Revision::new("graph").unwrap(),
            BTreeMap::from([(id, descriptor)]),
            BTreeMap::new(),
        )
        .unwrap();
        let verified = verify_complete_binary_manifests(&graph, &mut NoChunks).unwrap();
        let classified = zorid_file_sync::reference_materialization::classify_metadata(
            &graph,
            &verified,
            &[],
            zorid_file_sync::MAX_FILE_BYTES,
            zorid_file_sync::MAX_STATE_BYTES as u64,
        )
        .unwrap()
        .pop()
        .unwrap();
        (db, graph, verified, classified)
    }
    fn retain(db: &Connection, change: &Change) {
        let row = change.after.as_ref().unwrap();
        let source = row.content.as_ref().unwrap().binary_ref().unwrap();
        db.execute(
            "INSERT INTO entries VALUES(?1,?2,?3,?4,NULL,?5,?6,?7)",
            params![
                row.state.id.as_str(),
                row.state.path.as_str(),
                row.state.deleted,
                serde_json::to_string(&row.state).unwrap(),
                change.visible,
                serde_json::to_string(source).unwrap(),
                serde_json::to_string(&row.content.as_ref().unwrap().digest()).unwrap()
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO family_materialization_history VALUES(?1,?2,?3)",
            params![
                row.state.id.as_str(),
                row.state.revision.as_str(),
                serde_json::to_string(&change.record).unwrap()
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO family_materializations VALUES(?1,?2)",
            params![
                row.state.id.as_str(),
                serde_json::to_string(&change.record).unwrap()
            ],
        )
        .unwrap();
    }
    #[test]
    fn empty_binary_remains_present_as_a_graph_reference() {
        let (db, graph, verified, classified) = fixture();
        let context = RetainedGraphView::new(&graph);
        let change = candidate_with_view(&db, &context, &verified, &classified).unwrap();
        assert!(context.view.get().is_none());
        let row = change.after.as_ref().unwrap();
        assert_eq!(row.state.kind, EntryKind::File);
        assert!(
            matches!(&row.content, Some(StoredContent::BinaryRef(BinarySourceRef::Graph(reference))) if reference.manifest.bytes == 0)
        );
        retain(&db, &change);
        assert_eq!(retained_entry(&db, &row.state.id).unwrap().unwrap().0, *row);
        assert!(
            !candidate_with_view(&db, &context, &verified, &classified)
                .unwrap()
                .changed
        );
        assert!(context.view.get().is_none());
    }
    #[test]
    fn hidden_and_tombstoned_binary_preserve_exact_source_and_witness() {
        let (db, graph, verified, classified) = fixture();
        let normal = candidate(&db, &graph, &verified, &classified).unwrap();
        retain(&db, &normal);
        for outcome in [
            OutcomeRef::Pending {
                reason: PendingReason::MissingBootstrap,
            },
            OutcomeRef::Recovery {
                reason: zorid_file_sync::RecoveryReason::DeleteConflict,
            },
            OutcomeRef::Tombstone,
        ] {
            let next = EntryMaterializationRef {
                identity: classified.identity.clone(),
                outcome,
            };
            let changed = candidate(&db, &graph, &verified, &next).unwrap();
            assert!(!changed.visible);
            assert_eq!(
                changed.after.as_ref().unwrap().content,
                normal.after.as_ref().unwrap().content
            );
            assert_eq!(
                changed.record.retained_content,
                normal.record.retained_content
            );
            assert_eq!(
                changed.after.as_ref().unwrap().state.deleted,
                matches!(next.outcome, OutcomeRef::Tombstone)
            );
        }
    }
    #[test]
    fn binary_witness_rejects_changed_scope_event_or_manifest_even_without_reading_bytes() {
        let (db, graph, verified, classified) = fixture();
        let normal = candidate(&db, &graph, &verified, &classified).unwrap();
        let content = normal.after.as_ref().unwrap().content.as_ref().unwrap();
        let witness = normal.record.retained_content.as_ref().unwrap();
        check_retained_content(
            &db,
            &graph,
            &classified.identity,
            witness,
            content,
            Some(&verified),
        )
        .unwrap();
        let StoredContent::BinaryRef(BinarySourceRef::Graph(reference)) = content else {
            panic!()
        };
        for mutation in 0..3 {
            let mut changed = reference.clone();
            match mutation {
                0 => changed.scope.vault_id = VaultId::new("other").unwrap(),
                1 => changed.selected_event = UpdateId::new("other").unwrap(),
                _ => changed.manifest.digest = Sha256Digest::of(b"changed"),
            }
            assert!(check_retained_content(
                &db,
                &graph,
                &classified.identity,
                witness,
                &StoredContent::BinaryRef(BinarySourceRef::Graph(changed)),
                None
            )
            .is_err());
        }
        assert!(check_retained_content(
            &db,
            &graph,
            &classified.identity,
            witness,
            &StoredContent::InlineBytes(vec![]),
            None
        )
        .is_err());
    }
    #[test]
    fn retained_row_rejects_two_sources_and_oversized_inline_before_fetch() {
        let (db, graph, verified, classified) = fixture();
        let normal = candidate(&db, &graph, &verified, &classified).unwrap();
        retain(&db, &normal);
        db.execute("UPDATE entries SET content=X''", []).unwrap();
        assert!(retained_entry(&db, &classified.identity.entry_id).is_err());
        db.execute(
            "UPDATE entries SET content=zeroblob(?1),content_ref=NULL",
            [zorid_client_sync::MAX_TEXT_BYTES as i64 + 1],
        )
        .unwrap();
        assert!(retained_entry(&db, &classified.identity.entry_id).is_err());
    }
    #[test]
    fn retained_publication_cannot_lose_its_row_or_history() {
        let (db, graph, verified, classified) = fixture();
        let normal = candidate(&db, &graph, &verified, &classified).unwrap();
        retain(&db, &normal);
        db.execute("DELETE FROM family_materialization_history", [])
            .unwrap();
        assert!(candidate(&db, &graph, &verified, &classified).is_err());
        db.execute(
            "INSERT INTO family_materialization_history VALUES(?1,?2,?3)",
            params![
                classified.identity.entry_id.as_str(),
                normal.after.as_ref().unwrap().state.revision.as_str(),
                serde_json::to_string(&normal.record).unwrap()
            ],
        )
        .unwrap();
        db.execute("DELETE FROM entries", []).unwrap();
        assert!(candidate(&db, &graph, &verified, &classified).is_err());
    }
    #[test]
    fn retained_binary_requires_proof_for_the_exact_metadata_state() {
        let (db, graph, verified, classified) = fixture();
        let normal = candidate(&db, &graph, &verified, &classified).unwrap();
        retain(&db, &normal);
        let changed = MetadataState::from_records(
            graph.scope().clone(),
            Revision::new("different").unwrap(),
            graph.records().clone(),
            graph.activities().clone(),
        )
        .unwrap();
        assert!(candidate(&db, &changed, &verified, &classified).is_err());
    }
}

#[cfg(test)]
mod retained_view_tests {
    use super::*;
    use rusqlite::types::Value;
    use zorid_core::{OperationId, VaultPath};
    use zorid_sync_protocol::{RealmId, VaultId};

    const TEXTS: usize = 8;
    fn create(index: usize) -> MutationRequest {
        MutationRequest {
            operation_id: OperationId::new(format!("create_{index:02}")).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(format!("text_{index:02}")).unwrap(),
                path: VaultPath::new(format!("note-{index:02}.md")).unwrap(),
                kind: EntryKind::File,
                content: Some(format!("distinct body {index} 🦀\r\n").into_bytes()),
            },
        }
    }
    fn fixture() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("store")).unwrap();
        store
            .family_enroll(&FamilyScope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        for index in 0..TEXTS {
            store
                .family_apply(&create(index), Some(FamilyCreateMode::Text))
                .unwrap();
        }
        (dir, store)
    }
    // Exact private database comparison includes receipts, payloads, graph/text
    // history, materializations and jobs, rather than just the visible listing.
    fn database(db: &Connection) -> Vec<(String, Vec<Vec<Value>>)> {
        let names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").unwrap()
            .query_map([], |row| row.get::<_, String>(0)).unwrap()
            .collect::<std::result::Result<Vec<_>, _>>().unwrap();
        names
            .into_iter()
            .map(|name| {
                assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
                let mut statement = db
                    .prepare(&format!("SELECT * FROM {name} ORDER BY rowid"))
                    .unwrap();
                let columns = statement.column_count();
                let rows = statement
                    .query_map([], |row| {
                        (0..columns)
                            .map(|column| row.get(column))
                            .collect::<rusqlite::Result<Vec<Value>>>()
                    })
                    .unwrap()
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .unwrap();
                (name, rows)
            })
            .collect()
    }
    fn classified(
        db: &Connection,
        graph: &MetadataState,
        verified: &VerifiedBinarySet,
    ) -> Vec<EntryMaterializationRef> {
        zorid_file_sync::reference_materialization::classify_metadata(
            graph,
            verified,
            &family_ingress::retained_texts(db, graph.scope()).unwrap(),
            zorid_file_sync::MAX_FILE_BYTES,
            zorid_file_sync::MAX_STATE_BYTES as u64,
        )
        .unwrap()
    }
    fn parity(db: &Connection) {
        let graph = load_metadata(db).unwrap();
        let verified = blob_index::verify_metadata(db, &graph, &[]).unwrap();
        let values = classified(db, &graph, &verified);
        assert_eq!(values.len(), TEXTS);
        let context = RetainedGraphView::new(&graph);
        assert!(context.view.get().is_none());
        let mut address = None;
        for value in &values {
            let shared = candidate_with_view(db, &context, &verified, value).unwrap();
            let one_off = candidate(db, &graph, &verified, value).unwrap();
            assert_eq!(shared.record, one_off.record);
            assert_eq!(shared.before, one_off.before);
            assert_eq!(shared.after, one_off.after);
            assert_eq!(
                (shared.was_visible, shared.visible, shared.changed),
                (one_off.was_visible, one_off.visible, one_off.changed)
            );
            assert!(!shared.changed);
            // The candidate itself must initialize the shared cell. This fails
            // if retained Text checks regress to per-row graph derivation.
            assert!(context.view.get().is_some());
            let current = context.view().unwrap() as *const MetadataView;
            assert_eq!(*address.get_or_insert(current), current);
        }
        assert!(context.view.get().is_some());
        // A separate invocation owns a fresh empty cell, even for the same graph.
        assert!(RetainedGraphView::new(&graph).view.get().is_none());
        validate(db, &graph, &verified).unwrap();
    }
    #[test]
    fn many_retained_texts_share_one_view_and_match_one_off_candidates_through_commit_replay() {
        let (_dir, mut store) = fixture();
        parity(&store.connection);
        let id = EntryId::new("text_00").unwrap();
        let before = store.read(&id).unwrap().unwrap();
        let request = MutationRequest {
            operation_id: OperationId::new("write_many").unwrap(),
            mutation: Mutation::Write {
                id: id.clone(),
                expected: before.state.revision,
                content: b"new body".to_vec(),
            },
        };
        let original = database(&store.connection);
        let tx = store.connection.unchecked_transaction().unwrap();
        let prepared = family_commands::prepare_command(&tx, &request, None).unwrap();
        let expected_changes = prepared.changes().to_vec();
        tx.commit().unwrap();
        assert_eq!(database(&store.connection), original);
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let receipt = family_commands::commit_prepared(&tx, &prepared).unwrap();
        assert_eq!(receipt.changes, expected_changes);
        tx.commit().unwrap();
        assert_eq!(
            store.read(&id).unwrap().unwrap().content.as_deref(),
            Some(b"new body".as_slice())
        );
        parity(&store.connection);
        let committed = database(&store.connection);
        assert_eq!(store.family_apply(&request, None).unwrap(), receipt);
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert_eq!(
            family_commands::commit_prepared(&tx, &prepared).unwrap(),
            receipt
        );
        tx.commit().unwrap();
        assert_eq!(database(&store.connection), committed);
        let jobs = store.pending_projection_jobs(100).unwrap();
        assert_eq!(jobs.len(), TEXTS + 1);
        assert_eq!(jobs.last().unwrap().target, receipt.changes[0].after);
    }
    #[test]
    fn late_unrelated_retained_content_or_history_corruption_rejects_and_rolls_back_writer() {
        for corrupt_history in [false, true] {
            let (_dir, mut store) = fixture();
            let request = create(TEXTS);
            let tx = store.connection.unchecked_transaction().unwrap();
            let prepared =
                family_commands::prepare_command(&tx, &request, Some(FamilyCreateMode::Text))
                    .unwrap();
            tx.commit().unwrap();
            let last = EntryId::new(format!("text_{:02}", TEXTS - 1)).unwrap();
            if corrupt_history {
                let mut historical = get(&store.connection, &last).unwrap().unwrap();
                historical.identity.bootstrap_id =
                    UpdateId::new("other_history_bootstrap").unwrap();
                store
                    .connection
                    .execute(
                        "UPDATE family_materialization_history SET record=?1 WHERE entry_id=?2",
                        params![serde_json::to_string(&historical).unwrap(), last.as_str()],
                    )
                    .unwrap();
            } else {
                let bytes = b"different retained bytes";
                store
                    .connection
                    .execute(
                        "UPDATE entries SET content=?1,content_digest=?2 WHERE id=?3",
                        params![
                            bytes.as_slice(),
                            serde_json::to_string(&Sha256Digest::of(bytes)).unwrap(),
                            last.as_str()
                        ],
                    )
                    .unwrap();
            }
            let corrupted = database(&store.connection);
            // Preparation and commit each check their own current SQL state.
            let tx = store.connection.unchecked_transaction().unwrap();
            assert!(
                family_commands::prepare_command(&tx, &request, Some(FamilyCreateMode::Text))
                    .is_err()
            );
            tx.rollback().unwrap();
            let tx = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            assert!(family_commands::commit_prepared(&tx, &prepared).is_err());
            tx.rollback().unwrap();
            assert_eq!(database(&store.connection), corrupted);
            assert!(store.read(request.mutation.id()).unwrap().is_none());
        }
    }
    #[test]
    fn same_bytes_do_not_authorize_other_bootstraps_history_or_hidden_outcomes() {
        let (_dir, store) = fixture();
        let graph = load_metadata(&store.connection).unwrap();
        let verified = blob_index::verify_metadata(&store.connection, &graph, &[]).unwrap();
        let values = classified(&store.connection, &graph, &verified);
        let value = &values[TEXTS - 1];
        let context = RetainedGraphView::new(&graph);
        let original = candidate_with_view(&store.connection, &context, &verified, value).unwrap();
        let witness = original.record.retained_content.as_ref().unwrap();
        let content = original.before.as_ref().unwrap().content.as_ref().unwrap();
        let mut changed = witness.clone();
        let ContentWitness::Text { identity, .. } = &mut changed.witness else {
            panic!()
        };
        identity.bootstrap_id = UpdateId::new("other_text_bootstrap").unwrap();
        assert!(check_retained_content_with_view(
            &store.connection,
            &context,
            &value.identity,
            &changed,
            content,
            Some(&verified)
        )
        .is_err());
        let mut changed = witness.clone();
        let ContentWitness::Text {
            snapshot_digest, ..
        } = &mut changed.witness
        else {
            panic!()
        };
        *snapshot_digest = Sha256Digest::of(b"unrelated snapshot");
        assert!(check_retained_content_with_view(
            &store.connection,
            &context,
            &value.identity,
            &changed,
            content,
            Some(&verified)
        )
        .is_err());
        let mut other = value.clone();
        other.identity.bootstrap_id = UpdateId::new("other_file_bootstrap").unwrap();
        assert!(candidate_with_view(&store.connection, &context, &verified, &other).is_err());
        for outcome in [
            OutcomeRef::Pending {
                reason: PendingReason::MissingBootstrap,
            },
            OutcomeRef::Recovery {
                reason: zorid_file_sync::RecoveryReason::DeleteConflict,
            },
            OutcomeRef::Tombstone,
        ] {
            let hidden = EntryMaterializationRef {
                identity: value.identity.clone(),
                outcome,
            };
            let shared =
                candidate_with_view(&store.connection, &context, &verified, &hidden).unwrap();
            let one_off = candidate(&store.connection, &graph, &verified, &hidden).unwrap();
            assert!(!shared.visible);
            assert_eq!(shared.after, one_off.after);
            assert_eq!(
                shared.after.as_ref().unwrap().content,
                original.before.as_ref().unwrap().content
            );
            assert_eq!(
                shared.record.retained_content,
                original.record.retained_content
            );
        }
    }
    #[test]
    fn prepared_many_text_command_rejects_peer_change_without_any_writer_effects() {
        let (dir, mut store) = fixture();
        let request = create(TEXTS);
        let tx = store.connection.unchecked_transaction().unwrap();
        let prepared =
            family_commands::prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).unwrap();
        tx.commit().unwrap();
        let mut peer = Store::open(dir.path().join("store")).unwrap();
        peer.family_apply(&create(TEXTS + 1), Some(FamilyCreateMode::Text))
            .unwrap();
        let advanced = database(&store.connection);
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(family_commands::commit_prepared(&tx, &prepared).is_err());
        tx.rollback().unwrap();
        assert_eq!(database(&store.connection), advanced);
        assert!(store.read(request.mutation.id()).unwrap().is_none());
    }
}
