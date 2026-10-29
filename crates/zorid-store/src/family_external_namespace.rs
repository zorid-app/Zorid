//! Already-observed filesystem namespace changes. Historical physical frontiers
//! authorize causal events; current logical heads never authorize an unseen edit.
use super::*;
use std::collections::BTreeSet;
use zorid_core::{OperationId, VaultPath};
use zorid_file_sync::{
    external_namespace as external, materialization::ContentWitness, Location, Scope,
};
use zorid_sync_protocol::UpdateId;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("family_external_namespace", "CREATE TABLE family_external_namespace (observation_id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL, result TEXT)"),
    ("family_external_scan_proofs", "CREATE TABLE family_external_scan_proofs (scan_id TEXT NOT NULL REFERENCES scan_runs(scan_id), path TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scan_id,path))"),
];
/// Immutable per-scan physical evidence. Absence is tied to a historical binding,
/// independently of the current logical materialization path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalScanProof {
    Present {
        path: VaultPath,
        entry_kind: EntryKind,
        physical: PhysicalIdentity,
        content_digest: Option<zorid_file_sync::Sha256Digest>,
        content_bytes: u64,
    },
    Absent {
        before: PhysicalBinding,
    },
    /// Original child binding absent beneath its relocated, same-inode parent.
    RelocatedAbsent {
        before: PhysicalBinding,
        path: VaultPath,
    },
}
impl ExternalScanProof {
    pub fn present(
        path: VaultPath,
        entry_kind: EntryKind,
        physical: PhysicalIdentity,
        bytes: Option<&[u8]>,
    ) -> Self {
        Self::Present {
            path,
            entry_kind,
            physical,
            content_digest: bytes.map(zorid_file_sync::Sha256Digest::of),
            content_bytes: bytes.map_or(0, |bytes| bytes.len() as u64),
        }
    }
    /// Native scanners supply the digest of their bounded streaming capture.
    /// This remains physical evidence and never authenticates causal content.
    pub fn present_from_digest(
        path: VaultPath,
        entry_kind: EntryKind,
        physical: PhysicalIdentity,
        content_bytes: u64,
        content_digest: Option<zorid_file_sync::Sha256Digest>,
    ) -> Self {
        Self::Present {
            path,
            entry_kind,
            physical,
            content_digest,
            content_bytes,
        }
    }
    fn path(&self) -> &VaultPath {
        match self {
            Self::Present { path, .. } | Self::RelocatedAbsent { path, .. } => path,
            Self::Absent { before } => &before.state.path,
        }
    }
}
fn scan_proof(
    tx: &Connection,
    scan_id: &OperationId,
    path: &VaultPath,
) -> Result<ExternalScanProof> {
    let raw: String = tx.query_row(
        "SELECT record FROM family_external_scan_proofs WHERE scan_id=?1 AND path=?2",
        params![scan_id.as_str(), path.as_str()],
        |r| r.get(0),
    )?;
    let value: ExternalScanProof = serde_json::from_str(&raw)?;
    if value.path() != path {
        return Err(invalid("external scan proof path mismatch"));
    }
    Ok(value)
}
fn check_absent_snapshot(tx: &Connection, id: &OperationId, path: &VaultPath) -> Result<()> {
    let present: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM scan_observations WHERE scan_id=?1 AND path=?2)",
        params![id.as_str(), path.as_str()],
        |r| r.get(0),
    )?;
    if present {
        return Err(conflict());
    }
    Ok(())
}
fn scan_coverage(
    tx: &Connection,
    id: &OperationId,
    path: Option<&VaultPath>,
) -> Result<DirectoryCoverage> {
    let key = path.map_or("", VaultPath::as_str);
    let (complete, raw): (i64, String) = tx.query_row(
        "SELECT complete,record FROM scan_directories WHERE scan_id=?1 AND path=?2",
        params![id.as_str(), key],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    scan::coverage(key, complete, &raw)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalNamespaceAction {
    Move {
        root: EntryId,
        path: VaultPath,
    },
    MoveWithDeletions {
        root: EntryId,
        path: VaultPath,
        deleted_roots: Vec<EntryId>,
    },
    Delete {
        root: EntryId,
    },
}
impl ExternalNamespaceAction {
    fn root(&self) -> &EntryId {
        match self {
            Self::Move { root, .. }
            | Self::MoveWithDeletions { root, .. }
            | Self::Delete { root } => root,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalNamespaceMember {
    pub before: PhysicalBinding,
    /// Already-observed destination; absent for a proven deletion.
    pub after: Option<(VaultPath, PhysicalIdentity)>,
    /// Exact newly captured bytes, retained if a move also changed content.
    pub observed_content: Option<StoredContent>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalNamespaceObservation {
    pub observation_id: OperationId,
    pub scan_id: OperationId,
    pub action: ExternalNamespaceAction,
    pub members: Vec<ExternalNamespaceMember>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalNamespaceCommit {
    pub observation_id: OperationId,
    /// Local presentation journal cursor, not a core mutation or relay sequence.
    pub cursor: String,
    pub changed: Vec<EntryId>,
    pub authored: Vec<UpdateId>,
    pub pending_content: Vec<OperationId>,
}
fn invalid(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}
fn conflict() -> StoreError {
    zorid_client_sync::SyncError::VersionConflict.into()
}
fn scope(tx: &Connection) -> Result<Scope> {
    let a = text_sync::identity(tx)?;
    Ok(Scope {
        realm_id: a
            .realm_id
            .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
        vault_id: a
            .vault_id
            .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
    })
}
fn read(
    tx: &Connection,
    id: &OperationId,
) -> Result<(
    ExternalNamespaceObservation,
    Option<ExternalNamespaceCommit>,
)> {
    let (record, result): (String, Option<String>) = tx.query_row(
        "SELECT record,result FROM family_external_namespace WHERE observation_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let value: ExternalNamespaceObservation = serde_json::from_str(&record)?;
    if value.observation_id != *id {
        return Err(invalid("external namespace identity mismatch"));
    }
    let receipt: Option<ExternalNamespaceCommit> =
        result.map(|raw| serde_json::from_str(&raw)).transpose()?;
    if receipt.as_ref().is_some_and(|r| {
        r.observation_id != *id
            || r.cursor
                .parse::<u64>()
                .ok()
                .is_none_or(|v| v.to_string() != r.cursor)
            || r.authored.is_empty()
    }) {
        return Err(invalid("external namespace receipt mismatch"));
    }
    Ok((value, receipt))
}
fn bindings(tx: &Connection) -> Result<Vec<PhysicalBinding>> {
    physical_bindings::bindings(tx)
}
fn baseline(tx: &Connection, b: &PhysicalBinding) -> Result<external::PhysicalNamespaceBaseline> {
    physical_bindings::check_binding(tx, &b.state.id, Some(b))?;
    let bytes = projection::baseline(tx, &b.state.id)?.map(|b| b.content);
    family_materialization::check_publication_content(tx, &b.state, bytes.as_ref())?;
    let h = family_materialization::history(tx, &b.state.id, &b.state.revision)?
        .ok_or_else(|| invalid("external physical history missing"))?;
    let FamilyPublication::Normal {
        path,
        kind,
        namespace_heads,
        location_event,
    } = h.publication
    else {
        return Err(invalid("external physical history is not normal"));
    };
    if path != b.state.path || kind != b.state.kind {
        return Err(invalid("external physical history differs from binding"));
    }
    Ok(external::PhysicalNamespaceBaseline {
        identity: h.identity,
        physical_revision: b.state.revision.clone(),
        path,
        kind,
        heads: namespace_heads,
        location_event,
    })
}
fn relocated_path(
    root: &PhysicalBinding,
    target: &VaultPath,
    member: &PhysicalBinding,
) -> Result<VaultPath> {
    if member.state.id == root.state.id {
        return Ok(target.clone());
    }
    let suffix = member
        .state
        .path
        .as_str()
        .strip_prefix(&format!("{}/", root.state.path.as_str()))
        .ok_or_else(|| invalid("external move member outside root"))?;
    Ok(VaultPath::new(format!("{}/{}", target.as_str(), suffix))?)
}
/// Return canonical minimal missing subtree roots. Membership comes exclusively
/// from the captured physical subtree, never from today's logical descendants.
fn deleted_roots(o: &ExternalNamespaceObservation) -> Result<Vec<&ExternalNamespaceMember>> {
    let ExternalNamespaceAction::MoveWithDeletions {
        root,
        deleted_roots,
        ..
    } = &o.action
    else {
        return Ok(Vec::new());
    };
    let overall = o
        .members
        .iter()
        .find(|m| m.before.state.id == *root)
        .ok_or_else(|| invalid("compound observation root missing"))?;
    if overall.before.state.kind != EntryKind::Folder
        || deleted_roots.is_empty()
        || deleted_roots.windows(2).any(|p| p[0] >= p[1])
        || deleted_roots.contains(root)
    {
        return Err(invalid("compound deletion roots are not canonical"));
    }
    let roots = deleted_roots
        .iter()
        .map(|id| {
            o.members
                .iter()
                .find(|m| m.before.state.id == *id)
                .ok_or_else(|| invalid("compound deleted root missing"))
        })
        .collect::<Result<Vec<_>>>()?;
    if roots.iter().any(|r| {
        r.after.is_some()
            || roots.iter().any(|other| {
                r.before.state.id != other.before.state.id
                    && r.before
                        .state
                        .path
                        .is_descendant_of(&other.before.state.path)
            })
    }) {
        return Err(invalid("compound deletion roots are not minimal"));
    }
    for m in &o.members {
        let deleted = roots.iter().any(|r| {
            r.before.state.id == m.before.state.id
                || r.before.state.kind == EntryKind::Folder
                    && m.before.state.path.is_descendant_of(&r.before.state.path)
        });
        if m.after.is_none() != deleted {
            return Err(invalid(
                "compound deletion membership differs from captured subtree",
            ));
        }
    }
    Ok(roots)
}
fn check_scan(tx: &Connection, o: &ExternalNamespaceObservation) -> Result<()> {
    let run = scan::run(tx, &o.scan_id)?;
    if !run.finished || !run.complete || run.issue.is_some() {
        return Err(conflict());
    }
    let root = o
        .members
        .iter()
        .find(|m| m.before.state.id == *o.action.root())
        .ok_or_else(|| invalid("external observation root missing"))?;
    let coverage = scan_coverage(tx, &o.scan_id, root.before.state.path.parent().as_ref())?;
    if !coverage.complete
        || coverage.issue.is_some()
        || coverage.identity.as_ref() != Some(&root.before.physical.parent_inode)
    {
        return Err(conflict());
    }
    if scan_proof(tx, &o.scan_id, &root.before.state.path)?
        != (ExternalScanProof::Absent {
            before: root.before.clone(),
        })
    {
        return Err(conflict());
    }
    check_absent_snapshot(tx, &o.scan_id, &root.before.state.path)?;
    let deleted = deleted_roots(o)?;
    if let ExternalNamespaceAction::MoveWithDeletions { path, .. } = &o.action {
        for member in &deleted {
            let target = relocated_path(&root.before, path, &member.before)?;
            let coverage = scan_coverage(tx, &o.scan_id, target.parent().as_ref())?;
            if !coverage.complete
                || coverage.issue.is_some()
                || coverage.identity.as_ref() != Some(&member.before.physical.parent_inode)
            {
                return Err(conflict());
            }
            if scan_proof(tx, &o.scan_id, &target)?
                != (ExternalScanProof::RelocatedAbsent {
                    before: member.before.clone(),
                    path: target.clone(),
                })
            {
                return Err(conflict());
            }
            check_absent_snapshot(tx, &o.scan_id, &target)?;
        }
    }
    if o.members.iter().any(|m| m.after.is_none()) {
        let rows = tx
            .prepare("SELECT path,record FROM scan_observations WHERE scan_id=?1")?
            .query_map([o.scan_id.as_str()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (path, raw) in rows {
            let seen = scan::observation(&path, &raw)?;
            if seen.identity.as_ref().is_some_and(|i| {
                o.members
                    .iter()
                    .any(|m| m.after.is_none() && &m.before.physical.inode == i)
            }) {
                return Err(conflict());
            }
        }
    }
    for m in &o.members {
        if let Some((path, physical)) = &m.after {
            let raw: String = tx.query_row(
                "SELECT record FROM scan_observations WHERE scan_id=?1 AND path=?2",
                params![o.scan_id.as_str(), path.as_str()],
                |r| r.get(0),
            )?;
            let seen = scan::observation(path.as_str(), &raw)?;
            let kind = if m.before.state.kind == EntryKind::File {
                ScanObservationKind::File
            } else {
                ScanObservationKind::Directory
            };
            let coverage = scan_coverage(tx, &o.scan_id, path.parent().as_ref())?;
            if seen.kind != kind
                || seen.identity.as_ref() != Some(&physical.inode)
                || seen.issue.is_some()
                || !coverage.complete
                || coverage.issue.is_some()
                || coverage.identity.as_ref() != Some(&physical.parent_inode)
            {
                return Err(conflict());
            }
            let expected = ExternalScanProof::Present {
                path: path.clone(),
                entry_kind: m.before.state.kind,
                physical: physical.clone(),
                content_digest: m.observed_content.as_ref().map(StoredContent::digest),
                content_bytes: m.observed_content.as_ref().map_or(0, StoredContent::len),
            };
            if scan_proof(tx, &o.scan_id, path)? != expected {
                return Err(conflict());
            }
        }
    }
    Ok(())
}
/// Bound both retained journal metadata and the aggregate streamed hash work.
/// Repeated exact source locators share a verification pass in this snapshot.
fn verify_observed_sources(tx: &Connection, members: &[ExternalNamespaceMember]) -> Result<()> {
    if members.is_empty() || members.len() > MAX_NAMESPACE_MEMBERS {
        return Err(zorid_file_sync::Error::TooLarge.into());
    }
    let mut source_ids = BTreeSet::new();
    let mut journal_bytes = 0usize;
    let mut hash_bytes = 0u64;
    for content in members.iter().filter_map(|m| m.observed_content.as_ref()) {
        let journal_size = match content {
            StoredContent::InlineBytes(bytes) => bytes.len(),
            StoredContent::BinaryRef(source) => {
                let encoded = serde_json::to_vec(source)?;
                if encoded.len() > BINARY_STAGE_MAX_PAYLOAD_BYTES {
                    return Err(zorid_file_sync::Error::TooLarge.into());
                }
                encoded.len()
            }
        };
        journal_bytes = journal_bytes
            .checked_add(journal_size)
            .ok_or(zorid_file_sync::Error::TooLarge)?;
        if journal_bytes > MAX_NAMESPACE_EVIDENCE_BYTES {
            return Err(zorid_file_sync::Error::TooLarge.into());
        }
        if let StoredContent::BinaryRef(source) = content {
            if !source_ids.insert(serde_json::to_vec(source)?) {
                continue;
            }
            hash_bytes = hash_bytes
                .checked_add(source.len())
                .ok_or(zorid_file_sync::Error::TooLarge)?;
            if hash_bytes > zorid_file_sync::MAX_MANIFEST_VERIFY_BYTES {
                return Err(zorid_file_sync::Error::TooLarge.into());
            }
        }
        entry_content::verify_stored_content(tx, content)?;
    }
    Ok(())
}
fn check_members(
    tx: &Connection,
    o: &ExternalNamespaceObservation,
) -> Result<Vec<external::PhysicalNamespaceBaseline>> {
    if o.members.is_empty() || o.members.len() > MAX_NAMESPACE_MEMBERS {
        return Err(zorid_client_sync::SyncError::TooLarge.into());
    }
    let root = o
        .members
        .iter()
        .find(|m| m.before.state.id == *o.action.root())
        .ok_or_else(|| invalid("external observation root missing"))?;
    let all = bindings(tx)?;
    let expected: BTreeSet<_> = all
        .iter()
        .filter(|b| {
            b.state.id == root.before.state.id
                || (root.before.state.kind == EntryKind::Folder
                    && b.state.path.is_descendant_of(&root.before.state.path))
        })
        .map(|b| b.state.id.clone())
        .collect();
    let supplied: BTreeSet<_> = o
        .members
        .iter()
        .map(|m| m.before.state.id.clone())
        .collect();
    if expected != supplied || supplied.len() != o.members.len() {
        return Err(conflict());
    }
    let total = o
        .members
        .iter()
        .try_fold(0usize, |sum, m| {
            sum.checked_add(match &m.observed_content {
                None => 0,
                Some(StoredContent::InlineBytes(bytes)) => bytes.len(),
                Some(StoredContent::BinaryRef(reference)) => {
                    serde_json::to_vec(reference).ok()?.len()
                }
            })
        })
        .ok_or(zorid_client_sync::SyncError::TooLarge)?;
    if total > MAX_NAMESPACE_EVIDENCE_BYTES {
        return Err(zorid_client_sync::SyncError::TooLarge.into());
    }
    deleted_roots(o)?;
    let mut result = Vec::new();
    for m in &o.members {
        let historical = baseline(tx, &m.before)?;
        if !is_visible(tx, &m.before.state.id)? {
            // This records an already-observed physical branch, never a hidden
            // desired publication. Only authenticated Recovery/Tombstone caches
            // may retain physical authority from their exact historical Normal.
            let current = family_materialization::get(tx, &m.before.state.id)?
                .ok_or_else(|| invalid("hidden external branch has no materialization"))?;
            if current.identity != historical.identity
                || !matches!(
                    current.publication,
                    FamilyPublication::Recovery { .. } | FamilyPublication::Tombstone
                )
            {
                return Err(conflict());
            }
            // The historical and current typed witnesses are checked above.
            // Full retained manifest verification belongs to preparation, never
            // to this final physical comparison inside an IMMEDIATE writer.
        }
        if m.after.is_some()
            && (m.observed_content.is_some() != (m.before.state.kind == EntryKind::File))
            || m.after.is_none() && m.observed_content.is_some()
        {
            return Err(invalid("external namespace observed bytes kind mismatch"));
        }
        if m.observed_content.as_ref().is_some_and(|b| match b {
            StoredContent::InlineBytes(bytes) => bytes.len() as u64 > FAMILY_MAX_INLINE_BYTES,
            StoredContent::BinaryRef(reference) => reference.len() > FAMILY_MAX_FILE_BYTES,
        }) {
            return Err(zorid_client_sync::SyncError::TooLarge.into());
        }
        for table in ["projection_attempts", "directory_attempts"] {
            if tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE entry_id=?1 AND completed=0)"),
                [m.before.state.id.as_str()],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(conflict());
            }
        }
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM namespace_members m JOIN namespace_attempts a ON a.job_id=m.job_id WHERE m.entry_id=?1 AND a.completed=0) OR EXISTS(SELECT 1 FROM family_namespace_covered WHERE entry_id=?1 AND satisfied=0)",[m.before.state.id.as_str()],|r|r.get(0))?;
        if active {
            return Err(conflict());
        }
        match (&o.action, &m.after) {
            (ExternalNamespaceAction::Delete { .. }, None)
            | (ExternalNamespaceAction::MoveWithDeletions { .. }, None) => {}
            (
                ExternalNamespaceAction::Move { path, .. }
                | ExternalNamespaceAction::MoveWithDeletions { path, .. },
                Some((target, physical)),
            ) => {
                let expected = if m.before.state.id == root.before.state.id {
                    path.clone()
                } else {
                    VaultPath::new(format!(
                        "{}/{}",
                        path.as_str(),
                        m.before
                            .state
                            .path
                            .as_str()
                            .strip_prefix(&format!("{}/", root.before.state.path.as_str()))
                            .ok_or_else(|| invalid("external move member outside root"))?
                    ))?
                };
                if target != &expected
                    || physical.inode != m.before.physical.inode
                    || target == &m.before.state.path
                {
                    return Err(conflict());
                }
                physical.validate()?;
                if all
                    .iter()
                    .any(|b| b.state.path == *target && !supplied.contains(&b.state.id))
                {
                    return Err(conflict());
                }
            }
            _ => return Err(invalid("external namespace member action mismatch")),
        }
        result.push(historical);
    }
    let graph = blob_index::load_metadata(tx, &scope(tx)?)?
        .ok_or_else(|| invalid("external namespace graph missing"))?;
    external::validate_metadata_baselines(&graph, &result)?;
    Ok(result)
}
impl Store {
    /// Opaque connection-local observation of commits made by other authority
    /// connections. Own checkpoint writes do not invalidate interactive native
    /// publication cursors; foreign publication-only commits still do.
    pub fn external_work_data_version(&self) -> Result<i64> {
        Ok(self.connection.query_row("PRAGMA data_version", [], |row| row.get(0))?)
    }
    /// Immutable metadata for a bounded unfinished/completed physical inventory.
    /// Content bytes remain on disk; resumed native scans recheck them lazily.
    pub fn external_scan_proofs(&self, id: &OperationId) -> Result<Vec<ExternalScanProof>> {
        let run = scan::run(&self.connection, id)?;
        let count: i64 = self.connection.query_row(
            "SELECT count(*) FROM family_external_scan_proofs WHERE scan_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        if count < 0 || count > i64::from(run.max_entries) {
            return Err(invalid("external scan proof count exceeds inventory bound"));
        }
        let rows=self.connection.prepare("SELECT path,record FROM family_external_scan_proofs WHERE scan_id=?1 ORDER BY path")?.query_map([id.as_str()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        rows.into_iter()
            .map(|(path, raw)| {
                let value: ExternalScanProof = serde_json::from_str(&raw)?;
                if value.path().as_str() != path {
                    return Err(invalid("external scan proof path mismatch"));
                }
                match &value {
                    ExternalScanProof::Present {
                        entry_kind,
                        physical,
                        content_digest,
                        content_bytes,
                        ..
                    } => {
                        physical.validate()?;
                        if (*entry_kind == EntryKind::File) != content_digest.is_some()
                            || *entry_kind == EntryKind::Folder && *content_bytes != 0
                            || *content_bytes > FAMILY_MAX_FILE_BYTES
                        {
                            return Err(invalid("external scan proof content kind or limit"));
                        }
                    }
                    ExternalScanProof::Absent { before } => {
                        before.physical.validate()?;
                        if before.state.deleted {
                            return Err(invalid("external absence has deleted physical binding"));
                        }
                    }
                    ExternalScanProof::RelocatedAbsent { before, path } => {
                        before.physical.validate()?;
                        if before.state.deleted
                            || path == &before.state.path
                            || path.file_name() != before.state.path.file_name()
                        {
                            return Err(invalid("invalid relocated external absence"));
                        }
                    }
                }
                Ok(value)
            })
            .collect()
    }
    /// Record the exact capture before finishing the scan. Finished scans and
    /// conflicting retries cannot acquire new physical evidence.
    pub fn record_external_scan_proof(
        &mut self,
        id: &OperationId,
        proof: &ExternalScanProof,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run = scan::run(&tx, id)?;
        if run.finished {
            return Err(invalid("external scan proof after finish"));
        }
        match proof {
            ExternalScanProof::Present {
                path,
                entry_kind,
                physical,
                content_digest,
                content_bytes,
            } => {
                physical.validate()?;
                if (*entry_kind == EntryKind::File) != content_digest.is_some()
                    || (*entry_kind == EntryKind::Folder && *content_bytes != 0)
                    || *content_bytes > FAMILY_MAX_FILE_BYTES
                {
                    return Err(invalid("external scan proof content kind or limit"));
                }
                let raw: String = tx.query_row(
                    "SELECT record FROM scan_observations WHERE scan_id=?1 AND path=?2",
                    params![id.as_str(), path.as_str()],
                    |r| r.get(0),
                )?;
                let seen = scan::observation(path.as_str(), &raw)?;
                if seen.kind
                    != if *entry_kind == EntryKind::File {
                        ScanObservationKind::File
                    } else {
                        ScanObservationKind::Directory
                    }
                    || seen.identity.as_ref() != Some(&physical.inode)
                    || seen.issue.is_some()
                {
                    return Err(conflict());
                }
            }
            ExternalScanProof::Absent { before } => {
                physical_bindings::check_binding(&tx, &before.state.id, Some(before))?;
                check_absent_snapshot(&tx, id, &before.state.path)?;
            }
            ExternalScanProof::RelocatedAbsent { before, path } => {
                physical_bindings::check_binding(&tx, &before.state.id, Some(before))?;
                if path == &before.state.path || path.file_name() != before.state.path.file_name() {
                    return Err(invalid("relocated absence must retain the original leaf"));
                }
                check_absent_snapshot(&tx, id, path)?;
            }
        }
        let coverage = scan_coverage(&tx, id, proof.path().parent().as_ref())?;
        let parent = match proof {
            ExternalScanProof::Present { physical, .. } => &physical.parent_inode,
            ExternalScanProof::Absent { before }
            | ExternalScanProof::RelocatedAbsent { before, .. } => &before.physical.parent_inode,
        };
        if coverage.identity.as_ref() != Some(parent) {
            return Err(conflict());
        }
        let old: Option<String> = tx
            .query_row(
                "SELECT record FROM family_external_scan_proofs WHERE scan_id=?1 AND path=?2",
                params![id.as_str(), proof.path().as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let json = serde_json::to_string(proof)?;
        if let Some(old) = old {
            if old != json {
                return Err(conflict());
            }
            tx.commit()?;
            return Ok(());
        }
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM family_external_scan_proofs WHERE scan_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        if count >= i64::from(run.max_entries) {
            return Err(zorid_client_sync::SyncError::TooLarge.into());
        }
        tx.execute(
            "INSERT INTO family_external_scan_proofs VALUES(?1,?2,?3)",
            params![id.as_str(), proof.path().as_str(), json],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn physical_bindings(&self) -> Result<Vec<PhysicalBinding>> {
        let tx = self.connection.unchecked_transaction()?;
        let values = bindings(&tx)?;
        tx.commit()?;
        Ok(values)
    }
    /// Persist the exact proof before authoring. Native must still hold the vault
    /// lock and revalidate its live descriptors immediately before commit.
    pub fn record_family_namespace_observation(
        &mut self,
        scan_id: &OperationId,
        action: ExternalNamespaceAction,
        members: Vec<ExternalNamespaceMember>,
    ) -> Result<ExternalNamespaceObservation> {
        self.record_family_namespace_observation_inner(None, scan_id, action, members)
    }
    pub fn record_family_namespace_observation_content(
        &mut self,
        client: &OperationId,
        scan_id: &OperationId,
        action: ExternalNamespaceAction,
        members: Vec<ExternalNamespaceMember>,
    ) -> Result<ExternalNamespaceObservation> {
        self.record_family_namespace_observation_inner(Some(client), scan_id, action, members)
    }
    fn record_family_namespace_observation_inner(
        &mut self,
        client: Option<&OperationId>,
        scan_id: &OperationId,
        action: ExternalNamespaceAction,
        mut members: Vec<ExternalNamespaceMember>,
    ) -> Result<ExternalNamespaceObservation> {
        members.sort_by(|a, b| a.before.state.id.cmp(&b.before.state.id));
        let snapshot = self.connection.unchecked_transaction()?;
        for member in &members {
            if let Some(content) = &member.observed_content {
                if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content {
                    if client != Some(&capture.stage.client_id) {
                        return Err(invalid(
                            "namespace capture lacks independent client admission",
                        ));
                    }
                    let (path, _) = member
                        .after
                        .as_ref()
                        .ok_or_else(|| invalid("capture has no observed public path"))?;
                    entry_content::validate_captured_at(&snapshot, capture, path)?;
                }
            }
        }
        verify_observed_sources(&snapshot, &members)?;
        snapshot.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut o = ExternalNamespaceObservation {
            observation_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            scan_id: scan_id.clone(),
            action,
            members,
        };
        check_members(&tx, &o)?;
        check_scan(&tx, &o)?;
        for member in &o.members {
            if let Some(content) = &member.observed_content {
                entry_content::validate_stored_content(&tx, content, true)?;
                if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content {
                    let (path, _) = member
                        .after
                        .as_ref()
                        .ok_or_else(|| invalid("capture has no observed public path"))?;
                    entry_content::validate_captured_at(&tx, capture, path)?;
                }
            }
        }
        let ids = tx
            .prepare("SELECT observation_id FROM family_external_namespace WHERE result IS NULL")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for id in ids {
            let (prior, _) = read(&tx, &OperationId::new(id)?)?;
            if prior.action == o.action && prior.members == o.members {
                o = prior;
                tx.commit()?;
                return Ok(o);
            }
        }
        tx.execute(
            "INSERT INTO family_external_namespace(observation_id,record) VALUES(?1,?2)",
            params![o.observation_id.as_str(), serde_json::to_string(&o)?],
        )?;
        tx.commit()?;
        Ok(o)
    }
    pub fn family_namespace_observation_result(
        &self,
        id: &OperationId,
    ) -> Result<Option<ExternalNamespaceCommit>> {
        let (_, r) = read(&self.connection, id)?;
        Ok(r)
    }
    pub fn import_family_namespace_observation(
        &mut self,
        id: &OperationId,
    ) -> Result<ExternalNamespaceCommit> {
        // Hash every retained complete manifest under a pinned read snapshot.
        // Only exact metadata and physical comparisons run in the final writer.
        let tx = self.connection.unchecked_transaction()?;
        let (o, prior) = read(&tx, id)?;
        if let Some(r) = prior {
            tx.commit()?;
            return Ok(r);
        }
        let baselines = check_members(&tx, &o)?;
        check_scan(&tx, &o)?;
        let scope = scope(&tx)?;
        let graph = blob_index::load_metadata(&tx, &scope)?
            .ok_or_else(|| invalid("external namespace graph missing"))?;
        let verified_old = blob_index::verify_metadata(&tx, &graph, &[])?;
        family_materialization::validate(&tx, &graph, &verified_old)?;
        let mut expected_entries = read_states(&tx, true)?;
        expected_entries.sort_by(|a, b| a.id.cmp(&b.id));
        let expected_texts = family_ingress::retained_texts(&tx, &scope)?;
        let action = match &o.action {
            ExternalNamespaceAction::Delete { root } => {
                external::ExternalNamespaceAction::Delete { root: root.clone() }
            }
            ExternalNamespaceAction::Move { root, path }
            | ExternalNamespaceAction::MoveWithDeletions { root, path, .. } => {
                let parent = match path.parent() {
                    None => None,
                    Some(parent) => Some(
                        read_states(&tx, false)?
                            .into_iter()
                            .find(|s| s.path == parent && s.kind == EntryKind::Folder)
                            .ok_or(ContractError::InvalidMutation {
                                reason: "external move destination parent is not visible".into(),
                            })?
                            .id,
                    ),
                };
                external::ExternalNamespaceAction::Move {
                    root: root.clone(),
                    target: Location {
                        parent,
                        name: path.file_name().into(),
                    },
                }
            }
        };
        let count = if matches!(
            o.action,
            ExternalNamespaceAction::Move { .. }
                | ExternalNamespaceAction::MoveWithDeletions { .. }
        ) {
            1
        } else {
            baselines.len()
        };
        let allocation = external::Allocation {
            next_revision: family_commands::fresh_revision()?,
            update_ids: (0..count)
                .map(|_| family_commands::fresh_update())
                .collect::<Result<Vec<_>>>()?,
        };
        let first = external::prepare_metadata_namespace(&graph, &baselines, &action, &allocation)?;
        let mut next_graph = first.candidate().verification_state().clone();
        let mut authored = first.authored().to_vec();
        let mut allocated_update_ids = first.allocated_update_ids().to_vec();
        let mut revisions = vec![allocation.next_revision.clone()];
        // Transient candidates guide subsequent deletion planning, but only one
        // accumulated batch is authorized against the ORIGINAL metadata state.
        for deleted in deleted_roots(&o)? {
            let subset = baselines
                .iter()
                .filter(|b| {
                    b.identity.entry_id == deleted.before.state.id
                        || deleted.before.state.kind == EntryKind::Folder
                            && b.path.is_descendant_of(&deleted.before.state.path)
                })
                .cloned()
                .collect::<Vec<_>>();
            let allocation = external::Allocation {
                next_revision: family_commands::fresh_revision()?,
                update_ids: (0..subset.len())
                    .map(|_| family_commands::fresh_update())
                    .collect::<Result<Vec<_>>>()?,
            };
            let deletion = external::prepare_metadata_namespace(
                &next_graph,
                &subset,
                &external::ExternalNamespaceAction::Delete {
                    root: deleted.before.state.id.clone(),
                },
                &allocation,
            )?;
            next_graph = deletion.candidate().verification_state().clone();
            authored.extend_from_slice(deletion.authored());
            allocated_update_ids.extend_from_slice(deletion.allocated_update_ids());
            revisions.push(allocation.next_revision);
        }
        let mut batch = zorid_file_sync::metadata_plan::AuthoredMetadataBatch::new(scope.clone());
        for authored in &authored {
            batch.push_exact(&authored.payload_bytes)?;
        }
        let candidate = zorid_file_sync::metadata_plan::prepare_authored_batch(
            &graph,
            batch,
            next_graph.version().clone(),
        )?;
        let overlay: Vec<_> = authored
            .iter()
            .map(|a| (a.update_id.clone(), a.payload_bytes.clone()))
            .collect();
        let verified = blob_index::verify_metadata(&tx, candidate.verification_state(), &overlay)?;
        let plan = candidate.finalize(verified)?;
        verify_observed_sources(&tx, &o.members)?;
        tx.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (actual_observation, prior) = read(&tx, id)?;
        if let Some(receipt) = prior {
            tx.commit()?;
            return Ok(receipt);
        }
        if actual_observation != o || check_members(&tx, &o)? != baselines {
            return Err(conflict());
        }
        check_scan(&tx, &o)?;
        let actual_graph = blob_index::load_metadata(&tx, &scope)?
            .ok_or_else(|| invalid("external namespace graph missing"))?;
        plan.check_preconditions(&actual_graph, None)?;
        blob_index::check_sources(&tx, &actual_graph)?;
        let mut actual_entries = read_states(&tx, true)?;
        actual_entries.sort_by(|a, b| a.id.cmp(&b.id));
        if actual_entries != expected_entries
            || family_ingress::retained_texts(&tx, &scope)? != expected_texts
        {
            return Err(conflict());
        }
        for revision in &revisions {
            text_sync::reserve_revision(&tx, revision)?;
        }
        for update in &allocated_update_ids {
            if !family_ledger::unused(&tx, &family_commands::key(&scope, update))? {
                return Err(conflict());
            }
        }
        for member in &o.members {
            if let Some(content) = &member.observed_content {
                entry_content::validate_stored_content(&tx, content, true)?;
            }
        }
        for a in &authored {
            let metadata = family_ledger::EnvelopeMetadata {
                key: family_commands::key(&scope, &a.update_id),
                family: family_ledger::Family::Files,
                format_version: 2,
                payload_digest: zorid_file_sync::Sha256Digest::of(&a.payload_bytes),
                payload_bytes: u32::try_from(a.payload_bytes.len())
                    .map_err(|_| zorid_client_sync::SyncError::TooLarge)?,
                file_summary_digest: Some(
                    zorid_file_sync::metadata::GraphRecord::from_authored_exact(&a.payload_bytes)?
                        .2
                        .summary_digest()?,
                ),
                text_binding: None,
            };
            family_ledger::insert_authored(&tx, &metadata, &a.payload_bytes)?;
        }
        blob_index::persist_plan(&tx, &plan)?;
        let next_graph = plan.verification_state();
        blob_index::check_sources(&tx, next_graph)?;
        let changed = family_materialization::apply(
            &tx,
            next_graph,
            plan.verified_binaries(),
            ProjectionOrigin::ExternalObservation {
                observation_id: id.clone(),
            },
            None,
        )?;
        let mut pending_content = Vec::new();
        for m in &o.members {
            if let Some((path, physical)) = &m.after {
                move_physical(
                    &tx,
                    next_graph,
                    &m.before,
                    path,
                    physical,
                    o.action.root(),
                    &allocated_update_ids[0],
                )?;
                if let Some(bytes) = &m.observed_content {
                    let base = projection::baseline(&tx, &m.before.state.id)?
                        .ok_or_else(|| invalid("moved file baseline missing"))?;
                    if base.content.len() != bytes.len() || base.content.digest() != bytes.digest()
                    {
                        let binding = physical_bindings::binding(&tx, &m.before.state.id)?
                            .ok_or_else(|| invalid("moved binding missing"))?;
                        let observed = projection::record_external_transaction(
                            &tx,
                            path,
                            Some(base),
                            bytes.clone(),
                            Some(&ObservationPhysical {
                                physical: physical.clone(),
                                expected_binding: Some(binding),
                            }),
                        )?;
                        pending_content.push(observed.observation_id);
                    }
                }
            } else {
                physical_bindings::remove_binding(&tx, &m.before.state.id)?;
                tx.execute(
                    "DELETE FROM projection_baselines WHERE entry_id=?1",
                    [m.before.state.id.as_str()],
                )?;
                tx.execute(
                    "DELETE FROM directory_baselines WHERE entry_id=?1",
                    [m.before.state.id.as_str()],
                )?;
            }
        }
        // Retire only this observation's namespace jobs already satisfied by the
        // proven disk relocation/removal. Content publication remains separate.
        let jobs = tx
            .prepare("SELECT job_id FROM projection_jobs WHERE completed=0")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for job in jobs {
            let job = projection_jobs::get(&tx, &OperationId::new(job)?)?;
            if job.origin
                != (ProjectionOrigin::ExternalObservation {
                    observation_id: id.clone(),
                })
                || !matches!(job.work, ProjectionWork::Move | ProjectionWork::Delete)
            {
                continue;
            }
            let mut satisfied = true;
            for c in &job.affected {
                let b = physical_bindings::binding(&tx, &c.after.id)?;
                satisfied &= match job.work {
                    ProjectionWork::Move => {
                        b.as_ref().is_some_and(|b| b.state.path == c.after.path)
                    }
                    ProjectionWork::Delete => {
                        b.is_none() && o.members.iter().any(|m| m.before.state.id == c.after.id)
                    }
                    _ => false,
                };
            }
            if satisfied {
                projection_jobs::finish(&tx, &job)?;
            }
        }
        let cursor: i64 = tx.query_row(
            "SELECT coalesce(max(cursor),0) FROM local_changes",
            [],
            |r| r.get(0),
        )?;
        let receipt = ExternalNamespaceCommit {
            observation_id: id.clone(),
            cursor: cursor.to_string(),
            changed,
            authored: allocated_update_ids,
            pending_content,
        };
        tx.execute(
            "UPDATE family_external_namespace SET result=?1 WHERE observation_id=?2",
            params![serde_json::to_string(&receipt)?, id.as_str()],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}
fn move_physical(
    tx: &Connection,
    graph: &zorid_file_sync::metadata::MetadataState,
    before: &PhysicalBinding,
    path: &VaultPath,
    physical: &PhysicalIdentity,
    root: &EntryId,
    event: &UpdateId,
) -> Result<()> {
    let mut history =
        family_materialization::history(tx, &before.state.id, &before.state.revision)?
            .ok_or_else(|| invalid("external move history missing"))?;
    let FamilyPublication::Normal {
        path: old_path,
        namespace_heads,
        location_event,
        ..
    } = &mut history.publication
    else {
        return Err(invalid("external move history is not normal"));
    };
    if before.state.id == *root {
        *namespace_heads =
            graph.join_physical_move_frontier(&history.identity, namespace_heads, event)?;
        *location_event = event.clone();
    }
    *old_path = path.clone();
    let mut state = before.state.clone();
    state.path = path.clone();
    state.revision = family_commands::fresh_revision()?;
    text_sync::reserve_revision(tx, &state.revision)?;
    if let Some(FamilyContentWitness {
        witness: ContentWitness::Text { revision, .. },
        ..
    }) = &mut history.retained_content
    {
        let mut text = text_sync::revision(tx, &state.id, revision)?
            .ok_or_else(|| invalid("external move text history missing"))?;
        text.version = state.revision.clone();
        text_sync::put_revision(tx, &text)?;
        *revision = state.revision.clone();
    }
    tx.execute(
        "INSERT INTO family_materialization_history VALUES(?1,?2,?3)",
        params![
            state.id.as_str(),
            state.revision.as_str(),
            serde_json::to_string(&history)?
        ],
    )?;
    match state.kind {
        EntryKind::File => {
            let old = projection::baseline(tx, &state.id)?
                .ok_or_else(|| invalid("external move file baseline missing"))?;
            family_materialization::check_publication_content(tx, &state, Some(&old.content))?;
            projection::put_baseline(
                tx,
                &ProjectionBaseline {
                    state: state.clone(),
                    content: old.content,
                },
            )?;
        }
        EntryKind::Folder => {
            family_materialization::check_publication(tx, &state, None)?;
            directory::put_baseline(
                tx,
                &DirectoryBaseline {
                    state: state.clone(),
                    identity: physical.inode.clone(),
                },
            )?;
        }
    }
    physical_bindings::put_binding(
        tx,
        &PhysicalBinding {
            state,
            physical: physical.clone(),
        },
    )
}

#[cfg(test)]
mod external_work_version_tests {
    use super::*;
    #[test]
    fn foreign_publication_only_commit_invalidates_ephemeral_work_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().canonicalize().unwrap().join("vault.sqlite");
        let mut owner = Store::open(&database).unwrap();
        let id = EntryId::new("external-work-file").unwrap();
        owner.apply(&zorid_core::MutationRequest { operation_id: OperationId::new("external-work-create").unwrap(), mutation: zorid_core::Mutation::Create { id: id.clone(), path: VaultPath::new("Note.md").unwrap(), kind: EntryKind::File, content: Some(b"body".to_vec()) } }).unwrap();
        let attempt = owner.begin_projection(&id).unwrap();
        let source = owner.changes_after("0", 1).unwrap().head_cursor;
        let before = owner.external_work_data_version().unwrap();
        let mut other = Store::open_existing_no_follow(&database).unwrap();
        other.mark_projection(&attempt.attempt_id, crate::ProjectionPhase::Staged, Some("1:2".into())).unwrap();
        assert_eq!(owner.changes_after("0", 1).unwrap().head_cursor, source);
        assert_ne!(owner.external_work_data_version().unwrap(), before);
        let after = owner.external_work_data_version().unwrap();
        owner.mark_projection(&attempt.attempt_id, crate::ProjectionPhase::Staged, Some("1:2".into())).unwrap();
        assert_eq!(owner.external_work_data_version().unwrap(), after, "own publication work must not invalidate its own cursor");
    }
}
