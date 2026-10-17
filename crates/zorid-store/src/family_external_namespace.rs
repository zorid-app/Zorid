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
            content_bytes: bytes.map_or(0, |b| b.len() as u64),
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
    pub observed_content: Option<Vec<u8>>,
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
    let ids = tx
        .prepare("SELECT entry_id FROM physical_bindings ORDER BY entry_id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            physical_bindings::binding(tx, &EntryId::new(id)?)?
                .ok_or_else(|| invalid("listed physical binding missing"))
        })
        .collect()
}
fn baseline(tx: &Connection, b: &PhysicalBinding) -> Result<external::PhysicalNamespaceBaseline> {
    physical_bindings::check_binding(tx, &b.state.id, Some(b))?;
    let bytes = projection::baseline(tx, &b.state.id)?.map(|b| b.content);
    family_materialization::check_publication(tx, &b.state, bytes.as_deref())?;
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
                content_digest: m
                    .observed_content
                    .as_ref()
                    .map(|b| zorid_file_sync::Sha256Digest::of(b)),
                content_bytes: m.observed_content.as_ref().map_or(0, |b| b.len() as u64),
            };
            if scan_proof(tx, &o.scan_id, path)? != expected {
                return Err(conflict());
            }
        }
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
            sum.checked_add(m.observed_content.as_ref().map_or(0, Vec::len))
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
            let graph = file_state::load(tx, &scope(tx)?)?
                .ok_or_else(|| invalid("hidden external branch has no graph"))?;
            family_materialization::validate(tx, &graph)?;
        }
        if m.after.is_some()
            && (m.observed_content.is_some() != (m.before.state.kind == EntryKind::File))
            || m.after.is_none() && m.observed_content.is_some()
        {
            return Err(invalid("external namespace observed bytes kind mismatch"));
        }
        if m.observed_content
            .as_ref()
            .is_some_and(|b| b.len() as u64 > FAMILY_MAX_FILE_BYTES)
        {
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
    Ok(result)
}
impl Store {
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
        mut members: Vec<ExternalNamespaceMember>,
    ) -> Result<ExternalNamespaceObservation> {
        members.sort_by(|a, b| a.before.state.id.cmp(&b.before.state.id));
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
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (o, prior) = read(&tx, id)?;
        if let Some(r) = prior {
            tx.commit()?;
            return Ok(r);
        }
        let baselines = check_members(&tx, &o)?;
        check_scan(&tx, &o)?;
        let scope = scope(&tx)?;
        let graph = file_state::load(&tx, &scope)?
            .ok_or_else(|| invalid("external namespace graph missing"))?;
        family_materialization::validate(&tx, &graph)?;
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
        let mut plan = external::plan_external_namespace(&graph, &baselines, &action, &allocation)?;
        text_sync::reserve_revision(&tx, &allocation.next_revision)?;
        // Compose on transient graphs only. Intermediate Move state must never
        // create publication history or jobs for bytes known to be absent.
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
            let deletion = external::plan_external_namespace(
                &plan.next_graph,
                &subset,
                &external::ExternalNamespaceAction::Delete {
                    root: deleted.before.state.id.clone(),
                },
                &allocation,
            )?;
            let unused = deletion
                .allocated_update_ids
                .iter()
                .map(|id| family_ledger::unused(&tx, &family_commands::key(&scope, id)))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .all(|v| v);
            deletion.check_preconditions(&plan.next_graph, &subset, unused)?;
            text_sync::reserve_revision(&tx, &allocation.next_revision)?;
            plan.next_graph = deletion.next_graph;
            plan.authored.extend(deletion.authored);
            plan.allocated_update_ids
                .extend(deletion.allocated_update_ids);
        }
        let unused = plan
            .allocated_update_ids
            .iter()
            .map(|id| family_ledger::unused(&tx, &family_commands::key(&scope, id)))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .all(|v| v);
        plan.check_preconditions(&graph, &baselines, unused)?;
        for a in &plan.authored {
            let metadata = family_ledger::EnvelopeMetadata {
                key: family_commands::key(&scope, &a.update_id),
                family: family_ledger::Family::Files,
                format_version: 2,
                payload_digest: zorid_file_sync::Sha256Digest::of(&a.payload_bytes),
                payload_bytes: u32::try_from(a.payload_bytes.len())
                    .map_err(|_| zorid_client_sync::SyncError::TooLarge)?,
                text_binding: None,
            };
            family_ledger::insert_authored(&tx, &metadata, &a.payload_bytes)?;
        }
        let fp = zorid_file_sync::v2::FilePlan {
            expected_state: graph,
            next_state: Some(plan.next_graph.clone()),
            view: plan.next_graph.view()?,
        };
        let files: Vec<_> = plan
            .authored
            .iter()
            .map(|a| (&a.update_id, a.payload_bytes.as_slice()))
            .collect();
        file_state::persist_many(&tx, &fp, &files)?;
        let changed = family_materialization::apply(
            &tx,
            &plan.next_graph,
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
                    &plan.next_graph,
                    &m.before,
                    path,
                    physical,
                    o.action.root(),
                    &plan.allocated_update_ids[0],
                )?;
                if let Some(bytes) = &m.observed_content {
                    let base = projection::baseline(&tx, &m.before.state.id)?
                        .ok_or_else(|| invalid("moved file baseline missing"))?;
                    if base.content != *bytes {
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
            authored: plan.allocated_update_ids,
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
    graph: &zorid_file_sync::v2::State,
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
            family_materialization::check_publication(tx, &state, Some(&old.content))?;
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
