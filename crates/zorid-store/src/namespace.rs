//! Exact, retained physical namespace attempts. Only the native adapter supplies
//! filesystem evidence; this journal never discovers members or performs IO.
use super::*;
use std::collections::BTreeSet;
use zorid_core::{EntryChange, OperationId};

#[path = "family_namespace.rs"]
mod family;
pub(super) use family::successor::SCHEMA as SUCCESSOR_SCHEMA;
pub use family::NamespaceSuccessorPlan;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("namespace_attempts", "CREATE TABLE namespace_attempts (job_id TEXT PRIMARY KEY NOT NULL REFERENCES projection_jobs(job_id), completed INTEGER NOT NULL CHECK(completed IN (0,1)), work TEXT NOT NULL CHECK(work IN ('move','delete')), member_count INTEGER NOT NULL CHECK(member_count > 0), evidence_bytes INTEGER NOT NULL CHECK(evidence_bytes >= 0), record TEXT NOT NULL)"),
    ("namespace_members", "CREATE TABLE namespace_members (job_id TEXT NOT NULL REFERENCES namespace_attempts(job_id), member_index INTEGER NOT NULL CHECK(member_index >= 0), entry_id TEXT NOT NULL REFERENCES entries(id), source_identity TEXT NOT NULL, target_path TEXT NOT NULL, entry_kind TEXT NOT NULL CHECK(entry_kind IN ('file','folder')), evidence_bytes INTEGER NOT NULL CHECK(evidence_bytes >= 0), change TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(job_id,member_index), UNIQUE(job_id,entry_id))"),
    ("namespace_member_targets", "CREATE INDEX namespace_member_targets ON namespace_members(job_id,target_path,entry_kind)"),
    ("namespace_member_progress", "CREATE TABLE namespace_member_progress (job_id TEXT NOT NULL, member_index INTEGER NOT NULL, directory_stage_identity TEXT, captured INTEGER NOT NULL CHECK(captured IN (0,1)), published INTEGER NOT NULL CHECK(published IN (0,1)), finished INTEGER NOT NULL CHECK(finished IN (0,1)), PRIMARY KEY(job_id,member_index), FOREIGN KEY(job_id,member_index) REFERENCES namespace_members(job_id,member_index))"),
    family::SCHEMA[0],
    family::SCHEMA[1],
    family::SCHEMA[2],
    SUCCESSOR_SCHEMA[0],
];
pub const MAX_NAMESPACE_MEMBERS: usize = 10_000;
pub const MAX_NAMESPACE_EVIDENCE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceEvidence {
    pub before: EntryState,
    pub source_identity: String,
    pub source_parent_identity: String,
    pub destination_parent_identity: Option<String>,
    pub content: Option<StoredContent>,
    pub file_baseline: Option<ProjectionBaseline>,
    pub directory_baseline: Option<DirectoryBaseline>,
    /// Immutable prior physical authority, independent of logical revision.
    pub physical_binding: Option<PhysicalBinding>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceMember {
    pub change: EntryChange,
    pub evidence: NamespaceEvidence,
    pub directory_stage_identity: Option<String>,
    pub captured: bool,
    pub published: bool,
    pub finished: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceAttempt {
    /// Immutable job snapshot, including completed=false even after retirement.
    pub job: ProjectionJob,
    pub members: Vec<NamespaceMember>,
    pub completed: bool,
    /// Responsibility was explicitly delegated; original physical progress stays exact.
    pub delegated_to: Option<OperationId>,
}
/// Read-only status metadata. Evidence bytes are deliberately not selected or
/// decoded by this view; physical operations must read the full member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceMemberMetadata {
    pub index: usize,
    pub change: EntryChange,
    pub source_identity: String,
    pub directory_stage_identity: Option<String>,
    pub captured: bool,
    pub published: bool,
    pub finished: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamespaceAttemptMetadata {
    pub job: ProjectionJob,
    pub members: Vec<NamespaceMemberMetadata>,
    pub completed: bool,
    pub delegated_to: Option<OperationId>,
}
fn invalid(message: &str) -> StoreError {
    StoreError::Corrupt(message.into())
}
fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}
fn same_path(work: ProjectionWork, member: &NamespaceMember) -> bool {
    work == ProjectionWork::Move && member.evidence.before.path == member.change.after.path
}
fn validate_member(work: ProjectionWork, internal_parent: bool, m: &NamespaceMember) -> Result<()> {
    let e = &m.evidence;
    if m.change.before.as_ref() != Some(&e.before)
        || e.before.deleted
        || e.before.id != m.change.after.id
        || e.before.kind != m.change.after.kind
        || !identity(&e.source_identity)
        || !identity(&e.source_parent_identity)
        || (e.before.kind == EntryKind::File) != e.content.is_some()
        || (work == ProjectionWork::Move && m.change.after.deleted)
        || (work == ProjectionWork::Delete
            && (!m.change.after.deleted || e.before.path != m.change.after.path))
    {
        return Err(invalid("invalid namespace member evidence"));
    }
    if let Some(binding) = &e.physical_binding {
        binding.physical.validate()?;
        let baseline_state = match e.before.kind {
            EntryKind::File => e.file_baseline.as_ref().map(|b| &b.state),
            EntryKind::Folder => e.directory_baseline.as_ref().map(|b| &b.state),
        };
        if baseline_state != Some(&binding.state)
            || binding.physical.inode != e.source_identity
            || binding.physical.parent_inode != e.source_parent_identity
        {
            return Err(invalid(
                "namespace physical binding differs from source evidence",
            ));
        }
    }
    match e.before.kind {
        EntryKind::File => {
            if e.directory_baseline.is_some() || m.directory_stage_identity.is_some() {
                return Err(invalid("file has directory evidence"));
            }
            if matches!(
                &e.content,
                Some(StoredContent::BinaryRef(BinarySourceRef::Capture(_)))
            ) && (e.file_baseline.is_none() || e.physical_binding.is_none())
            {
                return Err(invalid("captured namespace bytes require an original graph baseline and physical binding"));
            }
            if let Some(base) = &e.file_baseline {
                if matches!(
                    &base.content,
                    StoredContent::BinaryRef(BinarySourceRef::Capture(_))
                ) {
                    return Err(invalid("captured bytes cannot be a namespace baseline"));
                }
                if base.state.id != e.before.id
                    || base.state.path != e.before.path
                    || base.state.kind != EntryKind::File
                    || base.state.deleted
                    || !e.content.as_ref().is_some_and(|content| {
                        if matches!(
                            content,
                            StoredContent::BinaryRef(BinarySourceRef::Capture(_))
                        ) {
                            matches!(
                                &base.content,
                                StoredContent::BinaryRef(BinarySourceRef::Graph(_))
                            ) && e.physical_binding.is_some()
                                && content.len() == base.content.len()
                                && content.digest() == base.content.digest()
                        } else {
                            content == &base.content
                        }
                    })
                {
                    return Err(invalid("file namespace baseline mismatch"));
                }
            }
        }
        EntryKind::Folder => {
            let base = e
                .directory_baseline
                .as_ref()
                .ok_or_else(|| invalid("directory requires existing inode provenance"))?;
            if e.file_baseline.is_some()
                || base.state.id != e.before.id
                || base.state.path != e.before.path
                || base.state.kind != EntryKind::Folder
                || base.state.deleted
                || base.identity != e.source_identity
            {
                return Err(invalid("directory namespace baseline mismatch"));
            }
            if m.directory_stage_identity
                .as_ref()
                .is_some_and(|id| !identity(id))
                || (m.directory_stage_identity.is_some()
                    && (work != ProjectionWork::Move || same_path(work, m)))
                || (m.published && !same_path(work, m) && m.directory_stage_identity.is_none())
            {
                return Err(invalid("invalid namespace directory stage"));
            }
        }
    }
    if e.destination_parent_identity
        .as_ref()
        .is_some_and(|id| !identity(id))
        || (work == ProjectionWork::Delete && e.destination_parent_identity.is_some())
    {
        return Err(invalid("invalid namespace destination parent proof"));
    }
    if work == ProjectionWork::Move && e.destination_parent_identity.is_none() {
        if !internal_parent {
            return Err(invalid("namespace destination parent proof missing"));
        }
    }
    if same_path(work, m) && (m.captured || m.published) {
        return Err(invalid("same-path move must not displace source"));
    }
    if work == ProjectionWork::Delete && m.published {
        return Err(invalid("delete cannot publish a destination"));
    }
    if m.published && !same_path(work, m) && !m.captured {
        return Err(invalid("namespace publication precedes capture"));
    }
    if m.finished
        && !same_path(work, m)
        && (!m.captured || (work == ProjectionWork::Move && !m.published))
    {
        return Err(invalid(
            "namespace member finished without physical progress",
        ));
    }
    Ok(())
}
fn validate(a: &NamespaceAttempt) -> Result<()> {
    if !matches!(a.job.work, ProjectionWork::Move | ProjectionWork::Delete)
        || a.job.completed
        || a.members.is_empty()
        || a.members.len() > MAX_NAMESPACE_MEMBERS
        || a.members.len() != a.job.affected.len()
        || (a.completed && a.delegated_to.is_none() && a.members.iter().any(|m| !m.finished))
    {
        return Err(invalid("invalid namespace attempt"));
    }
    let mut ids = BTreeSet::new();
    let folder_paths: BTreeSet<_> = a
        .job
        .affected
        .iter()
        .filter(|c| c.after.kind == EntryKind::Folder)
        .map(|c| &c.after.path)
        .collect();
    let mut bytes = 0usize;
    for (m, change) in a.members.iter().zip(&a.job.affected) {
        if &m.change != change || !ids.insert(&m.evidence.before.id) {
            return Err(invalid("namespace members differ from exact job"));
        }
        let parent = m.change.after.path.parent();
        let internal = parent.as_ref().is_some_and(|p| folder_paths.contains(p));
        validate_member(a.job.work, internal, m)?;
        for content in [
            m.evidence.content.as_ref(),
            m.evidence.file_baseline.as_ref().map(|b| &b.content),
        ]
        .into_iter()
        .flatten()
        {
            bytes = bytes
                .checked_add(namespace_content_evidence_bytes(content)?)
                .ok_or_else(|| invalid("namespace evidence overflow"))?;
        }
        if bytes > MAX_NAMESPACE_EVIDENCE_BYTES {
            return Err(invalid("namespace evidence exceeds limit"));
        }
    }
    Ok(())
}
#[derive(Clone)]
struct Header {
    work: ProjectionWork,
    completed: bool,
    member_count: usize,
    evidence_bytes: usize,
    delegated_to: Option<OperationId>,
}
fn work_name(work: ProjectionWork) -> Result<&'static str> {
    match work {
        ProjectionWork::Move => Ok("move"),
        ProjectionWork::Delete => Ok("delete"),
        _ => Err(invalid("not namespace work")),
    }
}
fn kind_name(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::File => "file",
        EntryKind::Folder => "folder",
    }
}
fn flag(value: i64) -> Result<bool> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(invalid("invalid namespace progress flag")),
    }
}
// Reference metadata is charged here; retained immutable body bytes have their
// own storage quota. A 64 MiB reference is not 64 MiB of namespace journal data.
pub fn namespace_content_evidence_bytes(content: &StoredContent) -> Result<usize> {
    match content {
        StoredContent::InlineBytes(bytes) => Ok(bytes.len()),
        StoredContent::BinaryRef(reference) => {
            let size = serde_json::to_vec(reference)?.len();
            if size > BINARY_STAGE_MAX_PAYLOAD_BYTES {
                return Err(invalid("namespace reference metadata exceeds limit"));
            }
            Ok(size)
        }
    }
}
fn evidence_size(e: &NamespaceEvidence) -> Result<usize> {
    let a = e
        .content
        .as_ref()
        .map(namespace_content_evidence_bytes)
        .transpose()?
        .unwrap_or(0);
    let b = e
        .file_baseline
        .as_ref()
        .map(|b| namespace_content_evidence_bytes(&b.content))
        .transpose()?
        .unwrap_or(0);
    let size = a
        .checked_add(b)
        .ok_or_else(|| invalid("namespace evidence overflow"))?;
    if size > MAX_NAMESPACE_EVIDENCE_BYTES {
        return Err(invalid("namespace evidence exceeds limit"));
    }
    Ok(size)
}
fn header(tx: &Connection, id: &OperationId) -> Result<Header> {
    let (done,work,count,bytes,job_done):(i64,String,i64,i64,i64)=tx.query_row(
        "SELECT a.completed,a.work,a.member_count,a.evidence_bytes,j.completed FROM namespace_attempts a JOIN projection_jobs j ON j.job_id=a.job_id WHERE a.job_id=?1",[id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let work = match work.as_str() {
        "move" => ProjectionWork::Move,
        "delete" => ProjectionWork::Delete,
        _ => return Err(invalid("invalid namespace work column")),
    };
    let completed = flag(done)?;
    if completed != flag(job_done)?
        || count <= 0
        || count as u64 > MAX_NAMESPACE_MEMBERS as u64
        || bytes < 0
        || bytes as u64 > MAX_NAMESPACE_EVIDENCE_BYTES as u64
    {
        return Err(invalid("invalid namespace header bounds or completion"));
    }
    Ok(Header {
        work,
        completed,
        member_count: count as usize,
        evidence_bytes: bytes as usize,
        delegated_to: family::successor::delegated_to(tx, id)?,
    })
}
struct MemberRow {
    index: i64,
    entry: String,
    source: String,
    target: String,
    kind: String,
    bytes: i64,
    change: String,
    stage: Option<String>,
    captured: i64,
    published: i64,
    finished: i64,
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MemberRow> {
    Ok(MemberRow {
        index: r.get(0)?,
        entry: r.get(1)?,
        source: r.get(2)?,
        target: r.get(3)?,
        kind: r.get(4)?,
        bytes: r.get(5)?,
        change: r.get(6)?,
        stage: r.get(7)?,
        captured: r.get(8)?,
        published: r.get(9)?,
        finished: r.get(10)?,
    })
}
const MEMBER_METADATA_COLUMNS: &str = "m.member_index,m.entry_id,m.source_identity,m.target_path,m.entry_kind,m.evidence_bytes,m.change,p.directory_stage_identity,p.captured,p.published,p.finished";
fn member_row(tx: &Connection, id: &OperationId, index: usize) -> Result<MemberRow> {
    let sql=format!("SELECT {MEMBER_METADATA_COLUMNS} FROM namespace_members m LEFT JOIN namespace_member_progress p ON p.job_id=m.job_id AND p.member_index=m.member_index WHERE m.job_id=?1 AND m.member_index=?2");
    Ok(tx.query_row(&sql, params![id.as_str(), index as i64], row)?)
}
fn member_metadata(h: &Header, r: &MemberRow) -> Result<NamespaceMemberMetadata> {
    let change: EntryChange = serde_json::from_str(&r.change)?;
    if r.index < 0
        || r.index as u64 >= h.member_count as u64
        || change.after.id.as_str() != r.entry
        || change.after.path.as_str() != r.target
        || kind_name(change.after.kind) != r.kind
        || !identity(&r.source)
        || r.bytes < 0
        || r.bytes as u64 > h.evidence_bytes as u64
    {
        return Err(invalid("namespace member metadata columns mismatch"));
    }
    let m = NamespaceMemberMetadata {
        index: r.index as usize,
        change,
        source_identity: r.source.clone(),
        directory_stage_identity: r.stage.clone(),
        captured: flag(r.captured)?,
        published: flag(r.published)?,
        finished: flag(r.finished)?,
    };
    let before = m
        .change
        .before
        .as_ref()
        .ok_or_else(|| invalid("namespace before state missing"))?;
    let after = &m.change.after;
    let same = h.work == ProjectionWork::Move && before.path == after.path;
    if before.deleted
        || before.id != after.id
        || before.kind != after.kind
        || (h.work == ProjectionWork::Move && after.deleted)
        || (h.work == ProjectionWork::Delete && (!after.deleted || before.path != after.path))
        || (m.directory_stage_identity.is_some()
            && (after.kind != EntryKind::Folder || h.work != ProjectionWork::Move || same))
        || m.directory_stage_identity
            .as_ref()
            .is_some_and(|s| !identity(s))
        || (m.published
            && after.kind == EntryKind::Folder
            && !same
            && m.directory_stage_identity.is_none())
        || (same && (m.captured || m.published))
        || (h.work == ProjectionWork::Delete && m.published)
        || (m.published && !m.captured)
        || (m.finished
            && !same
            && (!m.captured || (h.work == ProjectionWork::Move && !m.published)))
        || (h.completed && h.delegated_to.is_none() && !m.finished)
    {
        return Err(invalid("invalid namespace member metadata progress"));
    }
    Ok(m)
}
fn metadata(tx: &Connection, id: &OperationId) -> Result<NamespaceAttemptMetadata> {
    let h = header(tx, id)?;
    let json: String = tx.query_row(
        "SELECT record FROM namespace_attempts WHERE job_id=?1",
        [id.as_str()],
        |r| r.get(0),
    )?;
    let job: ProjectionJob = serde_json::from_str(&json)?;
    let mut actual = projection_jobs::get(tx, id)?;
    actual.completed = false;
    if job != actual || job.completed || job.work != h.work || job.affected.len() != h.member_count
    {
        return Err(invalid("namespace immutable job snapshot mismatch"));
    }
    // No evidence column appears in this query. The separate progress table
    // ensures status and progress updates never rewrite immutable byte records.
    let sql=format!("SELECT {MEMBER_METADATA_COLUMNS} FROM namespace_members m LEFT JOIN namespace_member_progress p ON p.job_id=m.job_id AND p.member_index=m.member_index WHERE m.job_id=?1 ORDER BY m.member_index");
    let rows = tx
        .prepare(&sql)?
        .query_map([id.as_str()], row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let progress_count: i64 = tx.query_row(
        "SELECT count(*) FROM namespace_member_progress WHERE job_id=?1",
        [id.as_str()],
        |r| r.get(0),
    )?;
    if rows.len() != h.member_count || progress_count != h.member_count as i64 {
        return Err(invalid("namespace member/progress set incomplete"));
    }
    let mut members = Vec::with_capacity(rows.len());
    let mut bytes = 0usize;
    let mut ids = BTreeSet::new();
    for (index, r) in rows.iter().enumerate() {
        let m = member_metadata(&h, r)?;
        if m.index != index
            || m.change != job.affected[index]
            || !ids.insert(m.change.after.id.clone())
        {
            return Err(invalid("namespace exact member order/identity mismatch"));
        }
        bytes = bytes
            .checked_add(r.bytes as usize)
            .ok_or_else(|| invalid("namespace evidence overflow"))?;
        members.push(m);
    }
    if bytes != h.evidence_bytes {
        return Err(invalid("namespace evidence budget columns mismatch"));
    }
    let result = NamespaceAttemptMetadata {
        job,
        members,
        completed: h.completed,
        delegated_to: h.delegated_to,
    };
    family::successor::check_delegated_metadata(tx, &result)?;
    Ok(result)
}
fn internal_parent(tx: &Connection, id: &OperationId, m: &NamespaceMember) -> Result<bool> {
    let Some(parent) = m.change.after.path.parent() else {
        return Ok(false);
    };
    let json:Option<String>=tx.query_row("SELECT change FROM namespace_members WHERE job_id=?1 AND target_path=?2 AND entry_kind='folder'",params![id.as_str(),parent.as_str()],|r|r.get(0)).optional()?;
    match json {
        None => Ok(false),
        Some(json) => {
            let change: EntryChange = serde_json::from_str(&json)?;
            if change.after.kind != EntryKind::Folder || change.after.path != parent {
                return Err(invalid("namespace parent metadata mismatch"));
            }
            Ok(true)
        }
    }
}
fn member(tx: &Connection, id: &OperationId, index: usize, h: &Header) -> Result<NamespaceMember> {
    if index >= h.member_count {
        return Err(invalid("namespace member index out of range"));
    }
    let r = member_row(tx, id, index)?;
    let meta = member_metadata(h, &r)?;
    let json: String = tx.query_row(
        "SELECT evidence FROM namespace_members WHERE job_id=?1 AND member_index=?2",
        params![id.as_str(), index as i64],
        |r| r.get(0),
    )?;
    let evidence: NamespaceEvidence = serde_json::from_str(&json)?;
    if evidence.source_identity != meta.source_identity
        || evidence_size(&evidence)? != r.bytes as usize
    {
        return Err(invalid("namespace evidence differs from metadata columns"));
    }
    let m = NamespaceMember {
        change: meta.change,
        evidence,
        directory_stage_identity: meta.directory_stage_identity,
        captured: meta.captured,
        published: meta.published,
        finished: meta.finished,
    };
    let internal =
        if h.work == ProjectionWork::Move && m.evidence.destination_parent_identity.is_none() {
            internal_parent(tx, id, &m)?
        } else {
            false
        };
    validate_member(h.work, internal, &m)?;
    Ok(m)
}
fn get(tx: &Connection, id: &OperationId) -> Result<NamespaceAttempt> {
    let meta = metadata(tx, id)?;
    let h = header(tx, id)?;
    let members = (0..h.member_count)
        .map(|i| member(tx, id, i, &h))
        .collect::<Result<Vec<_>>>()?;
    let a = NamespaceAttempt {
        job: meta.job,
        members,
        completed: meta.completed,
        delegated_to: meta.delegated_to,
    };
    validate(&a)?;
    family::successor::check_delegated_attempt(tx, &a)?;
    Ok(a)
}
fn insert_attempt(tx: &Connection, a: &NamespaceAttempt) -> Result<()> {
    validate(a)?;
    if a.delegated_to.is_some() {
        return Err(invalid("new attempt cannot begin delegated"));
    }
    let bytes = a.members.iter().try_fold(0usize, |total, m| {
        total
            .checked_add(evidence_size(&m.evidence)?)
            .ok_or_else(|| invalid("namespace evidence overflow"))
    })?;
    tx.execute("INSERT INTO namespace_attempts(job_id,completed,work,member_count,evidence_bytes,record) VALUES(?1,?2,?3,?4,?5,?6)",params![a.job.job_id.as_str(),a.completed,work_name(a.job.work)?,a.members.len() as i64,bytes as i64,serde_json::to_string(&a.job)?])?;
    for (index, m) in a.members.iter().enumerate() {
        tx.execute("INSERT INTO namespace_members(job_id,member_index,entry_id,source_identity,target_path,entry_kind,evidence_bytes,change,evidence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![a.job.job_id.as_str(),index as i64,m.change.after.id.as_str(),m.evidence.source_identity,m.change.after.path.as_str(),kind_name(m.change.after.kind),evidence_size(&m.evidence)? as i64,serde_json::to_string(&m.change)?,serde_json::to_string(&m.evidence)?])?;
        tx.execute("INSERT INTO namespace_member_progress(job_id,member_index,directory_stage_identity,captured,published,finished) VALUES(?1,?2,?3,?4,?5,?6)",params![a.job.job_id.as_str(),index as i64,m.directory_stage_identity,m.captured,m.published,m.finished])?;
    }
    Ok(())
}
fn attempt_ids(tx: &Connection, include_completed: bool) -> Result<Vec<OperationId>> {
    let ids = tx
        .prepare("SELECT job_id FROM namespace_attempts WHERE ?1 OR completed=0 ORDER BY rowid")?
        .query_map([include_completed], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|s| OperationId::new(s).map_err(Into::into))
        .collect()
}
fn attempts(tx: &Connection, include_completed: bool) -> Result<Vec<NamespaceAttempt>> {
    attempt_ids(tx, include_completed)?
        .into_iter()
        .map(|id| get(tx, &id))
        .collect()
}
fn operation_attempt_id(tx: &Connection, operation: &OperationId) -> Result<Option<OperationId>> {
    // record is the small immutable job snapshot, never member evidence.
    let ids=tx.prepare("SELECT job_id FROM namespace_attempts WHERE json_extract(record,'$.origin.kind')='local_command' AND json_extract(record,'$.origin.operation_id')=?1")?.query_map([operation.as_str()],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if ids.len() > 1 {
        return Err(invalid("multiple namespace attempts for one operation"));
    }
    ids.into_iter()
        .next()
        .map(|s| OperationId::new(s).map_err(Into::into))
        .transpose()
}
fn jobs(tx: &Connection, pending_only: bool) -> Result<Vec<ProjectionJob>> {
    let sql = if pending_only {
        "SELECT job_id FROM projection_jobs WHERE completed=0 ORDER BY ordinal"
    } else {
        "SELECT job_id FROM projection_jobs ORDER BY ordinal"
    };
    let ids = tx
        .prepare(sql)?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let jobs = ids
        .into_iter()
        .map(|id| projection_jobs::get(tx, &OperationId::new(id)?))
        .collect::<Result<Vec<_>>>()?;
    Ok(jobs
        .into_iter()
        .filter(|j| matches!(j.work, ProjectionWork::Move | ProjectionWork::Delete))
        .collect())
}
fn directory_baseline(tx: &Connection, id: &EntryId) -> Result<Option<DirectoryBaseline>> {
    let json: Option<String> = tx
        .query_row(
            "SELECT record FROM directory_baselines WHERE entry_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    json.map(|s| {
        let b: DirectoryBaseline = serde_json::from_str(&s)?;
        if b.state.id != *id
            || b.state.kind != EntryKind::Folder
            || b.state.deleted
            || !identity(&b.identity)
        {
            return Err(invalid("invalid directory baseline"));
        }
        Ok(b)
    })
    .transpose()
}
fn entry(tx: &Connection, id: &EntryId) -> Result<(EntryState, Option<StoredContent>)> {
    entry_content::read_content_entry(tx, id)?.ok_or_else(|| invalid("namespace entry is missing"))
}
fn publication_content(evidence: &NamespaceEvidence) -> Result<&StoredContent> {
    let content = evidence
        .content
        .as_ref()
        .ok_or_else(|| invalid("file evidence missing"))?;
    if matches!(
        content,
        StoredContent::BinaryRef(BinarySourceRef::Capture(_))
    ) {
        let original = evidence
            .file_baseline
            .as_ref()
            .ok_or_else(|| invalid("captured namespace evidence has no graph baseline"))?;
        if !matches!(
            &original.content,
            StoredContent::BinaryRef(BinarySourceRef::Graph(_))
        ) || evidence.physical_binding.is_none()
            || content.len() != original.content.len()
            || content.digest() != original.content.digest()
        {
            return Err(invalid(
                "captured namespace evidence differs from original graph baseline",
            ));
        }
        Ok(&original.content)
    } else {
        Ok(content)
    }
}
pub(super) fn verify_evidence_sources(
    snapshot: &Connection,
    client: Option<&OperationId>,
    evidence: &[NamespaceEvidence],
) -> Result<()> {
    if evidence.len() > MAX_NAMESPACE_MEMBERS {
        return Err(invalid("invalid namespace evidence count"));
    }
    let mut journal_bytes = 0usize;
    for e in evidence {
        journal_bytes = journal_bytes
            .checked_add(evidence_size(e)?)
            .ok_or_else(|| invalid("namespace evidence overflow"))?;
        if journal_bytes > MAX_NAMESPACE_EVIDENCE_BYTES {
            return Err(invalid("namespace evidence exceeds limit"));
        }
    }
    let mut verified = BTreeSet::new();
    let mut verification_bytes = 0u64;
    for e in evidence {
        if let Some(content) = &e.content {
            if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content {
                if client != Some(&capture.stage.client_id) {
                    return Err(ContractError::IdempotencyConflict {
                        operation_id: capture.stage.operation_id.clone(),
                    }
                    .into());
                }
                entry_content::validate_captured_at(snapshot, capture, &e.before.path)?;
                publication_content(e)?;
            }
        }
        if let Some(baseline) = &e.file_baseline {
            entry_content::validate_stored_content(snapshot, &baseline.content, false)?;
        }
        for content in [
            e.content.as_ref(),
            e.file_baseline.as_ref().map(|b| &b.content),
        ]
        .into_iter()
        .flatten()
        {
            if let StoredContent::BinaryRef(reference) = content {
                // Exact locators in the same snapshot may share one hash pass.
                if !verified.insert(serde_json::to_vec(reference)?) {
                    continue;
                }
                verification_bytes = verification_bytes
                    .checked_add(content.len())
                    .ok_or(zorid_file_sync::Error::TooLarge)?;
                if verification_bytes > zorid_file_sync::MAX_MANIFEST_VERIFY_BYTES {
                    return Err(zorid_file_sync::Error::TooLarge.into());
                }
            }
            entry_content::verify_stored_content(snapshot, content)?;
        }
    }
    Ok(())
}
fn replay_namespace(tx: &Connection, request: &MutationRequest) -> Result<Option<CommitResult>> {
    let prior: Option<(String, String)> = tx
        .query_row(
            "SELECT request,result FROM operations WHERE operation_id=?1",
            [request.operation_id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((command, result)) = prior {
        let recorded =
            operation_request::decode_inline_record(&command, &result, &request.operation_id)?;
        check_idempotency(request, Some(&recorded))?;
        let attempt_id = operation_attempt_id(tx, &request.operation_id)?
            .ok_or_else(|| invalid("legacy namespace command lacks physical evidence"))?;
        metadata(tx, &attempt_id)?;
        Ok(Some(recorded.result))
    } else {
        Ok(None)
    }
}
fn check_baselines(tx: &Connection, e: &NamespaceEvidence) -> Result<()> {
    if let Some(content) = &e.content {
        entry_content::validate_stored_content(tx, content, true)?;
        if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = content {
            entry_content::validate_captured_at(tx, capture, &e.before.path)?;
            // Metadata is not byte proof. The admitted native caller verifies
            // this immutable capture before entering the write transaction.
            publication_content(e)?;
        }
    }
    if let Some(baseline) = &e.file_baseline {
        entry_content::validate_stored_content(tx, &baseline.content, false)?;
    }
    physical_bindings::check_binding(tx, &e.before.id, e.physical_binding.as_ref())?;
    if projection::baseline(tx, &e.before.id)? != e.file_baseline
        || directory_baseline(tx, &e.before.id)? != e.directory_baseline
    {
        return Err(invalid("namespace baseline changed"));
    }
    Ok(())
}
pub(super) fn check_projection_handoff(tx: &Connection, id: &EntryId) -> Result<()> {
    family::check_projection_handoff(tx, id)
}

impl Store {
    /// Recheck semantic targets before filesystem replay. A hidden Recovery row
    /// is never interchangeable with a semantic tombstone.
    pub fn namespace_validate_target(&self, job_id: &OperationId) -> Result<()> {
        let tx = self.connection.unchecked_transaction()?;
        let a = get(&tx, job_id)?;
        if a.delegated_to.is_some() {
            return Err(invalid("namespace responsibility is delegated"));
        }
        if !a.completed && !family::check_finish(&tx, &a)? {
            for member in &a.members {
                let (current, _) = entry(&tx, &member.change.after.id)?;
                let target = &member.change.after;
                if current.path != target.path
                    || current.kind != target.kind
                    || current.deleted != target.deleted
                    || (!target.deleted && !is_visible(&tx, &target.id)?)
                {
                    return Err(invalid("namespace desired target changed"));
                }
            }
        }
        tx.commit()?;
        Ok(())
    }
    /// Read one exact attempt, validating its whole immutable membership set.
    pub fn namespace_attempt(&self, job_id: &OperationId) -> Result<NamespaceAttempt> {
        let tx = self.connection.unchecked_transaction()?;
        let a = get(&tx, job_id)?;
        tx.commit()?;
        Ok(a)
    }
    /// Read one member's evidence without loading other members' byte records.
    pub fn namespace_member(&self, job_id: &OperationId, index: usize) -> Result<NamespaceMember> {
        let tx = self.connection.unchecked_transaction()?;
        let h = header(&tx, job_id)?;
        let m = member(&tx, job_id, index, &h)?;
        tx.commit()?;
        Ok(m)
    }
    pub fn namespace_attempt_metadata(
        &self,
        include_completed: bool,
    ) -> Result<Vec<NamespaceAttemptMetadata>> {
        let tx = self.connection.unchecked_transaction()?;
        let a = attempt_ids(&tx, include_completed)?
            .into_iter()
            .map(|id| metadata(&tx, &id))
            .collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(a)
    }
    /// Pending-only SQL selection avoids decoding completed file-write history
    /// on every native path guard. Every selected job is still strictly decoded.
    pub fn pending_namespace_jobs(&self) -> Result<Vec<ProjectionJob>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = jobs(&tx, true)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn namespace_attempts(&self, include_completed: bool) -> Result<Vec<NamespaceAttempt>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = attempts(&tx, include_completed)?;
        tx.commit()?;
        Ok(result)
    }
    /// Includes completed and legacy jobs. A missing attempt is never permission
    /// to invent pre-commit evidence from the current filesystem.
    pub fn namespace_jobs(&self) -> Result<Vec<ProjectionJob>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = jobs(&tx, false)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn namespace_for_operation(
        &self,
        operation: &OperationId,
    ) -> Result<Option<NamespaceAttempt>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = operation_attempt_id(&tx, operation)?
            .map(|id| get(&tx, &id))
            .transpose()?;
        tx.commit()?;
        Ok(result)
    }
    /// Native-only commit boundary: caller holds the vault filesystem lock and
    /// freshly observes these exact occupants before entering this transaction.
    /// Historical jobs cannot acquire new authority through this method.
    pub fn apply_namespace(
        &mut self,
        request: &MutationRequest,
        evidence: &[NamespaceEvidence],
    ) -> Result<CommitResult> {
        self.apply_namespace_inner(None, request, evidence)
    }
    /// Typed native counterpart; the client is independently admitted by the
    /// adapter, never copied from a supplied capture locator.
    pub fn apply_namespace_content(
        &mut self,
        client: &OperationId,
        request: &MutationRequest,
        evidence: &[NamespaceEvidence],
    ) -> Result<CommitResult> {
        self.apply_namespace_inner(Some(client), request, evidence)
    }
    fn apply_namespace_inner(
        &mut self,
        client: Option<&OperationId>,
        request: &MutationRequest,
        evidence: &[NamespaceEvidence],
    ) -> Result<CommitResult> {
        if !matches!(
            request.mutation,
            Mutation::Move { .. } | Mutation::Delete { .. }
        ) {
            return Err(invalid("expected namespace mutation"));
        }
        let snapshot = self.connection.unchecked_transaction()?;
        if let Some(receipt) = replay_namespace(&snapshot, request)? {
            snapshot.commit()?;
            return Ok(receipt);
        }
        if evidence.is_empty() || evidence.len() > MAX_NAMESPACE_MEMBERS {
            return Err(invalid("invalid namespace evidence count"));
        }
        verify_evidence_sources(&snapshot, client, evidence)?;
        snapshot.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) = replay_namespace(&tx, request)? {
            tx.commit()?;
            return Ok(receipt);
        }
        if evidence.is_empty() || evidence.len() > MAX_NAMESPACE_MEMBERS {
            return Err(invalid("invalid namespace evidence count"));
        }
        let mut evidence_bytes = 0usize;
        for e in evidence {
            for bytes in [
                e.content.as_ref(),
                e.file_baseline.as_ref().map(|b| &b.content),
            ]
            .into_iter()
            .flatten()
            {
                evidence_bytes = evidence_bytes
                    .checked_add(namespace_content_evidence_bytes(bytes)?)
                    .ok_or_else(|| invalid("namespace evidence overflow"))?;
                if evidence_bytes > MAX_NAMESPACE_EVIDENCE_BYTES {
                    return Err(invalid("namespace evidence exceeds limit"));
                }
            }
        }
        let mut ids = BTreeSet::new();
        let mut by_id = std::collections::BTreeMap::new();
        for e in evidence {
            by_id.insert(e.before.id.clone(), e);
            if !ids.insert(e.before.id.clone()) {
                return Err(invalid("duplicate namespace evidence"));
            }
            let (state, content) = entry(&tx, &e.before.id)?;
            let expected_content = match e.before.kind {
                EntryKind::File => Some(publication_content(e)?),
                EntryKind::Folder => None,
            };
            if state != e.before || content.as_ref() != expected_content {
                return Err(invalid("namespace preflight state/content changed"));
            }
            check_baselines(&tx, e)?;
            for table in ["projection_attempts", "directory_attempts"] {
                let query = format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE entry_id=?1 AND completed=0)"
                );
                if tx.query_row(&query, [e.before.id.as_str()], |r| r.get::<_, bool>(0))? {
                    return Err(invalid("member has active projection attempt"));
                }
            }
        }
        // Jobs are the authority even when a legacy job has no safe physical
        // attempt. Do not let new evidence silently supersede such responsibility.
        if jobs(&tx, true)?
            .iter()
            .filter(|j| !j.completed)
            .any(|j| j.affected.iter().any(|c| ids.contains(&c.after.id)))
        {
            return Err(invalid("overlapping pending namespace job"));
        }
        for id in &ids {
            for work in [
                ProjectionWork::MaterializeFile,
                ProjectionWork::CreateDirectory,
            ] {
                if !projection_jobs::pending(&tx, id, work)?.is_empty() {
                    return Err(invalid("member has pending publication job"));
                }
            }
        }
        let result = Self::apply_transaction(&tx, request)?;
        let job = jobs(&tx, true)?.into_iter().find(|j|matches!(&j.origin,ProjectionOrigin::LocalCommand {operation_id} if operation_id == &request.operation_id)).ok_or_else(||invalid("namespace job missing"))?;
        if job.affected.len() != evidence.len() {
            return Err(invalid("namespace evidence does not cover exact members"));
        }
        let members = job
            .affected
            .iter()
            .map(|change| {
                let e = *by_id
                    .get(&change.after.id)
                    .ok_or_else(|| invalid("namespace member evidence missing"))?;
                Ok(NamespaceMember {
                    change: change.clone(),
                    evidence: e.clone(),
                    directory_stage_identity: None,
                    captured: false,
                    published: false,
                    finished: false,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        insert_attempt(
            &tx,
            &NamespaceAttempt {
                job,
                members,
                completed: false,
                delegated_to: None,
            },
        )?;
        tx.commit()?;
        Ok(result)
    }
    /// Compare-and-swap one member's progress; immutable evidence and job members
    /// cannot be reconstructed or rebound through this API.
    pub fn update_namespace_member(
        &mut self,
        job_id: &OperationId,
        expected: &NamespaceMember,
        next: &NamespaceMember,
    ) -> Result<NamespaceMember> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let h = header(&tx, job_id)?;
        if h.completed || h.delegated_to.is_some() {
            return Err(invalid("namespace attempt complete or delegated"));
        }
        let index: i64 = tx.query_row(
            "SELECT member_index FROM namespace_members WHERE job_id=?1 AND entry_id=?2",
            params![job_id.as_str(), expected.change.after.id.as_str()],
            |r| r.get(0),
        )?;
        if index < 0 {
            return Err(invalid("invalid namespace member index"));
        }
        let actual = member(&tx, job_id, index as usize, &h)?;
        if actual != *expected
            || expected.change != next.change
            || expected.evidence != next.evidence
            || (expected.captured && !next.captured)
            || (expected.published && !next.published)
            || (expected.finished && !next.finished)
            || expected
                .directory_stage_identity
                .as_ref()
                .is_some_and(|id| Some(id) != next.directory_stage_identity.as_ref())
        {
            return Err(invalid("namespace member progress/proof changed"));
        }
        let internal = if h.work == ProjectionWork::Move
            && next.evidence.destination_parent_identity.is_none()
        {
            internal_parent(&tx, job_id, next)?
        } else {
            false
        };
        validate_member(h.work, internal, next)?;
        let changed=tx.execute("UPDATE namespace_member_progress SET directory_stage_identity=?3,captured=?4,published=?5,finished=?6 WHERE job_id=?1 AND member_index=?2",params![job_id.as_str(),index,next.directory_stage_identity,next.captured,next.published,next.finished])?;
        if changed != 1 {
            return Err(invalid("namespace progress row missing"));
        }
        tx.commit()?;
        Ok(next.clone())
    }
    pub fn finish_namespace(&mut self, job_id: &OperationId) -> Result<NamespaceAttempt> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut a = get(&tx, job_id)?;
        if a.completed {
            tx.commit()?;
            return Ok(a);
        }
        if a.delegated_to.is_some() {
            return Err(invalid("namespace responsibility is delegated"));
        }
        if a.members.iter().any(|m| !m.finished) {
            return Err(invalid("namespace members unfinished"));
        }
        let family = family::check_finish(&tx, &a)?;
        for m in &a.members {
            check_baselines(&tx, &m.evidence)?;
            if family {
                continue;
            }
            let (current, _) = entry(&tx, &m.change.after.id)?;
            let after = &m.change.after;
            if current.path != after.path
                || current.kind != after.kind
                || current.deleted != after.deleted
            {
                return Err(invalid("namespace desired location changed"));
            }
        }
        for m in &a.members {
            let after = &m.change.after;
            if a.job.work == ProjectionWork::Delete {
                physical_bindings::remove_binding(&tx, &after.id)?;
                tx.execute(
                    "DELETE FROM projection_baselines WHERE entry_id=?1",
                    [after.id.as_str()],
                )?;
                tx.execute(
                    "DELETE FROM directory_baselines WHERE entry_id=?1",
                    [after.id.as_str()],
                )?;
            } else if after.kind == EntryKind::File {
                projection::put_baseline(
                    &tx,
                    &ProjectionBaseline {
                        state: after.clone(),
                        content: publication_content(&m.evidence)?.clone(),
                    },
                )?;
            } else {
                let physical = if same_path(a.job.work, m) {
                    m.evidence.source_identity.clone()
                } else {
                    m.directory_stage_identity
                        .clone()
                        .ok_or_else(|| invalid("directory stage missing"))?
                };
                let base = DirectoryBaseline {
                    state: after.clone(),
                    identity: physical,
                };
                directory::put_baseline(&tx, &base)?;
            }
            if a.job.work == ProjectionWork::Move {
                let inode = if after.kind == EntryKind::File || same_path(a.job.work, m) {
                    m.evidence.source_identity.clone()
                } else {
                    m.directory_stage_identity
                        .clone()
                        .ok_or_else(|| invalid("namespace stage identity missing"))?
                };
                let parent_inode = if same_path(a.job.work, m) {
                    m.evidence.source_parent_identity.clone()
                } else if let Some(parent) = &m.evidence.destination_parent_identity {
                    parent.clone()
                } else {
                    let parent = a
                        .members
                        .iter()
                        .find(|p| {
                            p.change.after.kind == EntryKind::Folder
                                && after.path.parent().as_ref() == Some(&p.change.after.path)
                        })
                        .ok_or_else(|| invalid("namespace internal destination parent missing"))?;
                    if same_path(a.job.work, parent) {
                        parent.evidence.source_identity.clone()
                    } else {
                        parent
                            .directory_stage_identity
                            .clone()
                            .ok_or_else(|| invalid("namespace parent stage missing"))?
                    }
                };
                physical_bindings::put_binding(
                    &tx,
                    &PhysicalBinding {
                        state: after.clone(),
                        physical: PhysicalIdentity {
                            inode,
                            parent_inode,
                        },
                    },
                )?;
            }
        }
        family::finish_covered(&tx, &a)?;
        projection_jobs::finish(&tx, &a.job)?;
        a.completed = true;
        tx.execute(
            "UPDATE namespace_attempts SET completed=1 WHERE job_id=?1",
            [job_id.as_str()],
        )?;
        tx.commit()?;
        Ok(a)
    }
}

#[cfg(test)]
mod typed_evidence_tests {
    use super::*;
    use zorid_file_sync::{EntryIdentity, Manifest, PageRef, Scope, Sha256Digest};
    use zorid_sync_protocol::{RealmId, UpdateId, VaultId};
    fn graph(bytes: u64, selected: &str) -> StoredContent {
        StoredContent::BinaryRef(BinarySourceRef::Graph(PublishedBinaryRef {
            scope: Scope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            },
            identity: EntryIdentity {
                entry_id: EntryId::new("file").unwrap(),
                bootstrap_id: UpdateId::new("bootstrap").unwrap(),
            },
            selected_event: UpdateId::new(selected).unwrap(),
            manifest: Manifest {
                bytes,
                digest: Sha256Digest::of(&[]),
                pages: if bytes == 0 {
                    vec![]
                } else {
                    (0..4)
                        .map(|n| PageRef {
                            id: UpdateId::new(format!("page-{n}")).unwrap(),
                            bytes: bytes / 4,
                            digest: Sha256Digest::of(b"page"),
                        })
                        .collect()
                },
            },
        }))
    }
    fn evidence(content: StoredContent) -> NamespaceEvidence {
        let before = EntryState {
            id: EntryId::new("file").unwrap(),
            path: zorid_core::VaultPath::new("file.bin").unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("before").unwrap(),
            deleted: false,
        };
        let binding = PhysicalBinding {
            state: before.clone(),
            physical: PhysicalIdentity {
                inode: "source".into(),
                parent_inode: "parent".into(),
            },
        };
        NamespaceEvidence {
            before: before.clone(),
            source_identity: "source".into(),
            source_parent_identity: "parent".into(),
            destination_parent_identity: Some("destination-parent".into()),
            file_baseline: Some(ProjectionBaseline {
                state: before,
                content: content.clone(),
            }),
            content: Some(content),
            directory_baseline: None,
            physical_binding: Some(binding),
        }
    }
    #[test]
    fn namespace_reference_budget_does_not_charge_retained_binary_bodies() {
        let e = evidence(graph(BINARY_STAGE_MAX_FILE_BYTES, "selected"));
        assert!(evidence_size(&e).unwrap() < 64 * 1024);
        assert_eq!(
            e.content.as_ref().unwrap().len(),
            BINARY_STAGE_MAX_FILE_BYTES
        );
    }
    #[test]
    fn capture_uses_original_graph_and_requires_physical_binding() {
        let mut e = evidence(graph(0, "selected"));
        let reference = match e.content.as_ref().unwrap() {
            StoredContent::BinaryRef(BinarySourceRef::Graph(reference)) => reference,
            _ => unreachable!(),
        };
        e.content = Some(StoredContent::BinaryRef(BinarySourceRef::Capture(
            CapturedBinaryRef {
                stage: BinaryStageLocator {
                    local_store_id: OperationId::new("store").unwrap(),
                    client_id: OperationId::new("client").unwrap(),
                    operation_id: OperationId::new("capture").unwrap(),
                    stage_id: OperationId::new("stage").unwrap(),
                },
                manifest: reference.manifest.clone(),
                source_commitment: Sha256Digest::of(b"source"),
            },
        )));
        assert_eq!(
            publication_content(&e).unwrap(),
            &e.file_baseline.as_ref().unwrap().content
        );
        let mut after = e.before.clone();
        after.revision = Revision::new("after").unwrap();
        after.path = zorid_core::VaultPath::new("renamed.bin").unwrap();
        let member = NamespaceMember {
            change: EntryChange {
                before: Some(e.before.clone()),
                after,
            },
            evidence: e.clone(),
            directory_stage_identity: None,
            captured: false,
            published: false,
            finished: false,
        };
        validate_member(ProjectionWork::Move, false, &member).unwrap();
        e.physical_binding = None;
        assert!(publication_content(&e).is_err());
        let mut missing_proof = member.clone();
        missing_proof.evidence = e;
        assert!(validate_member(ProjectionWork::Move, false, &missing_proof).is_err());
        let mut changed_graph = member;
        changed_graph.evidence.content = Some(graph(0, "different-selected"));
        assert!(validate_member(ProjectionWork::Move, false, &changed_graph).is_err());
    }
}
