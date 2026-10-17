//! Derived publication cache. Graph/text state remains authoritative; hidden
//! outcomes never replace retained bytes with empty or guessed content.
use super::*;
use std::collections::BTreeMap;
use zorid_core::EntryChange;
use zorid_file_sync::materialization::{
    ContentWitness, EntryMaterialization, Outcome, PendingReason,
};
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
fn retained_entry(tx: &Connection, id: &EntryId) -> Result<Option<(StoredEntry, bool)>> {
    let raw = tx
        .query_row(
            "SELECT path,deleted,state,content,visible FROM entries WHERE id=?1",
            [id.as_str()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<Vec<u8>>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    raw.map(|(path, deleted, raw, content, visible)| {
        if !matches!(visible, 0 | 1) {
            return Err(StoreError::Corrupt("invalid publication visibility".into()));
        }
        Ok((
            StoredEntry {
                state: decode_state(id.as_str(), &path, deleted, &raw, content.is_some())?,
                content,
            },
            visible == 1,
        ))
    })
    .transpose()
}
struct Change {
    record: FamilyMaterialization,
    before: Option<StoredEntry>,
    after: Option<StoredEntry>,
    was_visible: bool,
    visible: bool,
    changed: bool,
}
fn candidate(
    tx: &Connection,
    graph: &zorid_file_sync::v2::State,
    classified: &EntryMaterialization,
) -> Result<Change> {
    let id = &classified.identity.entry_id;
    let prior = get(tx, id)?;
    let row = retained_entry(tx, id)?;
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
        Outcome::Normal {
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
            record.retained_content = content.as_ref().map(|c| FamilyContentWitness {
                digest: c.digest.clone(),
                witness: c.witness.clone(),
            });
            after = Some(StoredEntry {
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
                content: content.as_ref().map(|c| c.bytes.clone()),
            });
            true
        }
        Outcome::Pending { reason } => {
            record.publication = FamilyPublication::Pending {
                reason: reason.clone(),
            };
            false
        }
        Outcome::Recovery { reason } => {
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
        Outcome::Tombstone => {
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
            if let Some(bytes) = &before.content {
                match &witness.witness {
                    ContentWitness::Text {
                        identity,
                        revision,
                        snapshot_digest,
                    } => {
                        let state = text_sync::revision(tx, id, revision)?.ok_or_else(|| {
                            StoreError::Corrupt("retained text witness missing".into())
                        })?;
                        if &state.identity != identity
                            || Sha256Digest::of(&state.snapshot) != *snapshot_digest
                            || state.complete_materialized_utf8()?.as_ref() != Some(bytes)
                        {
                            return Err(StoreError::Corrupt(
                                "retained text witness does not prove bytes".into(),
                            ));
                        }
                    }
                    ContentWitness::Binary { selected_event, .. } => {
                        graph.validate_retained_binary_content(
                            &classified.identity,
                            selected_event,
                            &zorid_file_sync::materialization::VerifiedContent {
                                bytes: bytes.clone(),
                                digest: witness.digest.clone(),
                                witness: witness.witness.clone(),
                            },
                            family_store::FAMILY_MAX_FILE_BYTES,
                        )?;
                    }
                }
            }
            if before
                .content
                .as_ref()
                .is_none_or(|bytes| Sha256Digest::of(bytes) != witness.digest)
            {
                return Err(StoreError::Corrupt(
                    "retained bytes differ from publication witness".into(),
                ));
            }
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
pub(super) fn validate(tx: &Connection, graph: &zorid_file_sync::v2::State) -> Result<()> {
    let classified = zorid_file_sync::materialization::classify(
        graph,
        &family_ingress::retained_texts(tx, graph.scope())?,
        family_store::FAMILY_MAX_FILE_BYTES,
    )?;
    let count: i64 = tx.query_row("SELECT count(*) FROM family_materializations", [], |r| {
        r.get(0)
    })?;
    if usize::try_from(count).ok() != Some(classified.len()) {
        return Err(StoreError::Corrupt(
            "publication cache identity coverage mismatch".into(),
        ));
    }
    for value in classified.values() {
        if candidate(tx, graph, value)?.changed {
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
    graph: &zorid_file_sync::v2::State,
    origin: ProjectionOrigin,
    allocated_revision: Option<&Revision>,
) -> Result<Vec<EntryId>> {
    let texts = family_ingress::retained_texts(tx, graph.scope())?;
    let classified = zorid_file_sync::materialization::classify(
        graph,
        &texts,
        family_store::FAMILY_MAX_FILE_BYTES,
    )?;
    let mut changes: BTreeMap<EntryId, Change> = classified
        .iter()
        .map(|(id, c)| Ok((id.clone(), candidate(tx, graph, c)?)))
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
                            != after.content.as_deref().unwrap_or_default()
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
            tx.execute("INSERT INTO entries(id,path,deleted,state,content,visible) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET path=excluded.path,deleted=excluded.deleted,state=excluded.state,content=excluded.content,visible=excluded.visible",params![id.as_str(),after.state.path.as_str(),after.state.deleted,serde_json::to_string(&after.state)?,after.content,change.visible])?;
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
        let graph = file_state::load(&tx, &zorid_file_sync::Scope { realm_id, vault_id })?
            .ok_or_else(|| StoreError::Corrupt("enrolled graph missing".into()))?;
        validate(&tx, &graph)?;
        let value = get(&tx, id)?;
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
        || !matches!(&record.publication,FamilyPublication::Normal{path,kind,..} if path==&state.path && kind==&state.kind)
    {
        return Err(StoreError::Corrupt(
            "physical publication is not its exact historical Normal target".into(),
        ));
    }
    match (content, &record.retained_content) {
        (None, None) if state.kind == EntryKind::Folder => Ok(()),
        (Some(bytes), Some(provenance)) if state.kind == EntryKind::File => {
            if Sha256Digest::of(bytes) != provenance.digest {
                return Err(StoreError::Corrupt(
                    "physical target digest differs from history".into(),
                ));
            }
            match &provenance.witness {
                ContentWitness::Text {
                    identity,
                    revision,
                    snapshot_digest,
                } => {
                    let text = text_sync::revision(tx, &state.id, revision)?.ok_or_else(|| {
                        StoreError::Corrupt("physical text history missing".into())
                    })?;
                    if &text.identity != identity
                        || &text.version != &state.revision
                        || Sha256Digest::of(&text.snapshot) != *snapshot_digest
                        || text.complete_materialized_utf8()?.as_deref() != Some(bytes)
                    {
                        return Err(StoreError::Corrupt(
                            "physical text target differs from causal history".into(),
                        ));
                    }
                }
                ContentWitness::Binary { selected_event, .. } => {
                    let authority = text_sync::identity(tx)?;
                    let (Some(realm_id), Some(vault_id)) = (authority.realm_id, authority.vault_id)
                    else {
                        return Err(StoreError::Corrupt("physical family scope missing".into()));
                    };
                    let graph =
                        file_state::load(tx, &zorid_file_sync::Scope { realm_id, vault_id })?
                            .ok_or_else(|| {
                                StoreError::Corrupt("physical family graph missing".into())
                            })?;
                    graph.validate_retained_binary_content(
                        &record.identity,
                        selected_event,
                        &zorid_file_sync::materialization::VerifiedContent {
                            bytes: bytes.to_vec(),
                            digest: provenance.digest.clone(),
                            witness: provenance.witness.clone(),
                        },
                        family_store::FAMILY_MAX_FILE_BYTES,
                    )?;
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
                    || Some(baseline.content.as_slice()) != entry.content.as_deref()
                {
                    return Err(ContractError::InvalidMutation {
                        reason: "file projection remains pending".into(),
                    }
                    .into());
                }
                check_publication(&tx, &baseline.state, Some(&baseline.content))?;
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
    check_publication(tx, before, bytes.as_deref())?;
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
    let graph = file_state::load(tx, &FamilyScope { realm_id, vault_id })?
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
    check_publication(tx, &physical, bytes.as_deref())?;
    Ok(physical)
}
