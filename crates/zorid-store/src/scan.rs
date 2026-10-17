//! Bounded scan metadata; file bytes remain in entries/external_observations.
use super::*;
use zorid_core::{OperationId, VaultPath};
pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("scan_runs","CREATE TABLE scan_runs (scan_id TEXT PRIMARY KEY NOT NULL, finished INTEGER NOT NULL CHECK(finished IN (0,1)), record TEXT NOT NULL)"),
    ("scan_directories","CREATE TABLE scan_directories (scan_id TEXT NOT NULL REFERENCES scan_runs(scan_id), path TEXT NOT NULL, complete INTEGER NOT NULL CHECK(complete IN (0,1)), record TEXT NOT NULL, PRIMARY KEY(scan_id,path))"),
    ("scan_observations","CREATE TABLE scan_observations (scan_id TEXT NOT NULL REFERENCES scan_runs(scan_id), path TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scan_id,path))"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanRun {
    pub scan_id: OperationId,
    pub max_entries: u32,
    pub finished: bool,
    pub complete: bool,
    pub observed: u32,
    pub imported: u32,
    pub issue: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryCoverage {
    /// None is the vault root, never an empty/invalid VaultPath.
    pub path: Option<VaultPath>,
    pub identity: Option<String>,
    pub complete: bool,
    pub issue: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanObservationKind {
    File,
    Directory,
    Absent,
    Blocked,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanObservation {
    pub path: VaultPath,
    pub kind: ScanObservationKind,
    pub entry: Option<EntryState>,
    pub baseline_revision: Option<Revision>,
    pub identity: Option<String>,
    pub imported: bool,
    pub issue: Option<String>,
}
fn run(tx: &Connection, id: &OperationId) -> Result<ScanRun> {
    let (finished, json): (i64, String) = tx.query_row(
        "SELECT finished,record FROM scan_runs WHERE scan_id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let value: ScanRun = serde_json::from_str(&json)?;
    if value.scan_id != *id
        || !matches!(finished, 0 | 1)
        || value.finished != (finished == 1)
        || value.complete && !value.finished
        || value.max_entries == 0
        || value.max_entries > 100_000
        || value.observed > value.max_entries
        || value.imported > value.observed
    {
        return Err(StoreError::Corrupt(
            "invalid scan run columns/limits".into(),
        ));
    }
    Ok(value)
}
fn put_run(tx: &Connection, value: &ScanRun) -> Result<()> {
    tx.execute("INSERT INTO scan_runs(scan_id,finished,record) VALUES (?1,?2,?3) ON CONFLICT(scan_id) DO UPDATE SET finished=excluded.finished,record=excluded.record",params![value.scan_id.as_str(),value.finished,serde_json::to_string(value)?])?;
    Ok(())
}
fn coverage(path: &str, complete: i64, json: &str) -> Result<DirectoryCoverage> {
    let value: DirectoryCoverage = serde_json::from_str(json)?;
    if value.path.as_ref().map_or("", VaultPath::as_str) != path
        || !matches!(complete, 0 | 1)
        || value.complete != (complete == 1)
        || value
            .identity
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
        || value.complete && (value.identity.is_none() || value.issue.is_some())
    {
        return Err(StoreError::Corrupt("invalid scan coverage columns".into()));
    }
    Ok(value)
}
fn observation(path: &str, json: &str) -> Result<ScanObservation> {
    let value: ScanObservation = serde_json::from_str(json)?;
    if value.path.as_str() != path
        || value
            .entry
            .as_ref()
            .is_some_and(|s| s.path != value.path || s.deleted)
        || value.kind == ScanObservationKind::File
            && value
                .entry
                .as_ref()
                .is_some_and(|e| e.kind != EntryKind::File)
        || value.kind == ScanObservationKind::Directory
            && value
                .entry
                .as_ref()
                .is_some_and(|e| e.kind != EntryKind::Folder)
        || value.kind == ScanObservationKind::Absent
            && (value.entry.is_none()
                || value.baseline_revision.is_none()
                || value.identity.is_some())
        || value.imported
            && !matches!(
                value.kind,
                ScanObservationKind::File | ScanObservationKind::Directory
            )
    {
        return Err(StoreError::Corrupt(
            "invalid scan observation columns".into(),
        ));
    }
    Ok(value)
}
impl Store {
    pub fn begin_scan(&mut self, max_entries: u32) -> Result<ScanRun> {
        if max_entries == 0 || max_entries > 100_000 {
            return Err(StoreError::Corrupt("scan limit must be 1..=100000".into()));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = ScanRun {
            scan_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            max_entries,
            finished: false,
            complete: false,
            observed: 0,
            imported: 0,
            issue: None,
        };
        put_run(&tx, &value)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn scan_run(&self, id: &OperationId) -> Result<ScanRun> {
        run(&self.connection, id)
    }
    pub fn latest_scan(&self) -> Result<Option<ScanRun>> {
        self.connection
            .query_row(
                "SELECT scan_id FROM scan_runs ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|id| run(&self.connection, &OperationId::new(id)?))
            .transpose()
    }
    pub fn record_directory_coverage(
        &mut self,
        id: &OperationId,
        value: &DirectoryCoverage,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let scan = run(&tx, id)?;
        if scan.finished {
            return Err(StoreError::Corrupt("scan already finished".into()));
        }
        let path = value.path.as_ref().map_or("", VaultPath::as_str);
        let json = serde_json::to_string(value)?;
        coverage(path, i64::from(value.complete), &json)?;
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM scan_directories WHERE scan_id=?1 AND path<>?2",
            params![id.as_str(), path],
            |r| r.get(0),
        )?;
        if count > i64::from(scan.max_entries) {
            return Err(StoreError::Corrupt(
                "directory coverage budget exhausted".into(),
            ));
        }
        tx.execute("INSERT INTO scan_directories(scan_id,path,complete,record) VALUES (?1,?2,?3,?4) ON CONFLICT(scan_id,path) DO UPDATE SET complete=excluded.complete,record=excluded.record",params![id.as_str(),path,value.complete,json])?;
        tx.commit()?;
        Ok(())
    }
    pub fn record_scan_observation(
        &mut self,
        id: &OperationId,
        value: &ScanObservation,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut scan = run(&tx, id)?;
        if scan.finished {
            return Err(StoreError::Corrupt("scan already finished".into()));
        }
        let json = serde_json::to_string(value)?;
        observation(value.path.as_str(), &json)?;
        if value.kind == ScanObservationKind::Absent {
            return Err(StoreError::Corrupt(
                "absence must commit atomically with finished scan".into(),
            ));
        }
        let old = tx
            .query_row(
                "SELECT record FROM scan_observations WHERE scan_id=?1 AND path=?2",
                params![id.as_str(), value.path.as_str()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|s| observation(value.path.as_str(), &s))
            .transpose()?;
        if old.is_none() && scan.observed >= scan.max_entries {
            return Err(StoreError::Corrupt(
                "scan observation budget exhausted".into(),
            ));
        }
        if old.is_none() {
            scan.observed += 1;
        }
        if old.as_ref().is_some_and(|o| o.imported) {
            scan.imported = scan
                .imported
                .checked_sub(1)
                .ok_or_else(|| StoreError::Corrupt("scan import count mismatch".into()))?;
        }
        if value.imported {
            scan.imported += 1;
        }
        tx.execute("INSERT INTO scan_observations(scan_id,path,record) VALUES (?1,?2,?3) ON CONFLICT(scan_id,path) DO UPDATE SET record=excluded.record",params![id.as_str(),value.path.as_str(),json])?;
        put_run(&tx, &scan)?;
        tx.commit()?;
        Ok(())
    }
    pub fn scan_coverage(&self, id: &OperationId) -> Result<Vec<DirectoryCoverage>> {
        run(&self.connection, id)?;
        let rows = self
            .connection
            .prepare(
                "SELECT path,complete,record FROM scan_directories WHERE scan_id=?1 ORDER BY path",
            )?
            .query_map([id.as_str()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(path, complete, json)| coverage(&path, complete, &json))
            .collect()
    }
    pub fn scan_observations(&self, id: &OperationId) -> Result<Vec<ScanObservation>> {
        run(&self.connection, id)?;
        let rows = self
            .connection
            .prepare("SELECT path,record FROM scan_observations WHERE scan_id=?1 ORDER BY path")?
            .query_map([id.as_str()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(path, json)| observation(&path, &json))
            .collect()
    }
    pub fn finish_scan(
        &mut self,
        id: &OperationId,
        complete: bool,
        issue: Option<String>,
    ) -> Result<ScanRun> {
        self.finish_scan_with_absences(id, complete, issue, &[])
    }
    /// Absence facts and complete coverage become visible in one transaction.
    /// An interrupted scan can expose imported positives, never draft absences.
    pub fn finish_scan_with_absences(
        &mut self,
        id: &OperationId,
        complete: bool,
        issue: Option<String>,
        absences: &[ScanObservation],
    ) -> Result<ScanRun> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut scan = run(&tx, id)?;
        if scan.finished {
            return Ok(scan);
        }
        let rows = tx
            .prepare("SELECT path,complete,record FROM scan_directories WHERE scan_id=?1")?
            .query_map([id.as_str()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let coverages: Vec<_> = rows
            .into_iter()
            .map(|(path, done, json)| coverage(&path, done, &json))
            .collect::<Result<_>>()?;
        scan.complete = complete
            && issue.is_none()
            && coverages.iter().any(|c| c.path.is_none())
            && coverages.iter().all(|c| c.complete);
        if scan.complete {
            for value in absences {
                let json = serde_json::to_string(value)?;
                observation(value.path.as_str(), &json)?;
                if value.kind != ScanObservationKind::Absent
                    || scan.observed >= scan.max_entries
                    || !coverages
                        .iter()
                        .any(|c| c.complete && c.path == value.path.parent())
                {
                    return Err(StoreError::Corrupt(
                        "invalid or unbounded final absence".into(),
                    ));
                }
                let expected = value
                    .entry
                    .as_ref()
                    .ok_or_else(|| StoreError::Corrupt("absence missing entry".into()))?;
                let (path, deleted, state, has_content): (String, i64, String, bool) = tx
                    .query_row(
                        "SELECT path,deleted,state,content IS NOT NULL FROM entries WHERE id=?1",
                        [expected.id.as_str()],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )?;
                if decode_state(expected.id.as_str(), &path, deleted, &state, has_content)?
                    != *expected
                {
                    return Err(StoreError::Corrupt(
                        "entry changed before absence commit".into(),
                    ));
                }
                let baseline_revision = if expected.kind == EntryKind::File {
                    let json: String = tx.query_row(
                        "SELECT record FROM projection_baselines WHERE entry_id=?1",
                        [expected.id.as_str()],
                        |r| r.get(0),
                    )?;
                    let baseline: ProjectionBaseline = serde_json::from_str(&json)?;
                    if baseline.state.id != expected.id
                        || baseline.state.path != expected.path
                        || baseline.state.kind != EntryKind::File
                        || baseline.state.deleted
                    {
                        return Err(StoreError::Corrupt("absence baseline mismatch".into()));
                    }
                    baseline.state.revision
                } else {
                    let json: String = tx.query_row(
                        "SELECT record FROM directory_baselines WHERE entry_id=?1",
                        [expected.id.as_str()],
                        |r| r.get(0),
                    )?;
                    let baseline: DirectoryBaseline = serde_json::from_str(&json)?;
                    if baseline.state.id != expected.id
                        || baseline.state.path != expected.path
                        || baseline.state.kind != EntryKind::Folder
                        || baseline.state.deleted
                    {
                        return Err(StoreError::Corrupt(
                            "absence directory baseline mismatch".into(),
                        ));
                    }
                    baseline.state.revision
                };
                if value.baseline_revision.as_ref() != Some(&baseline_revision) {
                    return Err(StoreError::Corrupt("absence baseline advanced".into()));
                }
                tx.execute(
                    "INSERT INTO scan_observations(scan_id,path,record) VALUES (?1,?2,?3)",
                    params![id.as_str(), value.path.as_str(), json],
                )?;
                scan.observed += 1;
            }
        }
        if !scan.complete {
            let records = tx
                .prepare("SELECT path,record FROM scan_observations WHERE scan_id=?1")?
                .query_map([id.as_str()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (path, json) in records {
                if observation(&path, &json)?.kind == ScanObservationKind::Absent {
                    tx.execute(
                        "DELETE FROM scan_observations WHERE scan_id=?1 AND path=?2",
                        params![id.as_str(), path],
                    )?;
                    scan.observed = scan.observed.checked_sub(1).ok_or_else(|| {
                        StoreError::Corrupt("scan observation count mismatch".into())
                    })?;
                }
            }
        }
        scan.issue = issue;
        scan.finished = true;
        put_run(&tx, &scan)?;
        tx.commit()?;
        Ok(scan)
    }
}
