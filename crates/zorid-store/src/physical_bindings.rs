//! Native physical provenance. Historical proofs are immutable; active bindings
//! describe the saved physical baseline, which can lag logical/merged state.
use super::*;
use zorid_core::OperationId;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("physical_bindings", "CREATE TABLE physical_bindings (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id), path TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','directory')), inode TEXT NOT NULL, parent_inode TEXT NOT NULL, record TEXT NOT NULL)"),
    ("physical_binding_paths", "CREATE INDEX physical_binding_paths ON physical_bindings(path)"),
    ("publication_parent_proofs", "CREATE TABLE publication_parent_proofs (attempt_id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','directory')), entry_id TEXT NOT NULL REFERENCES entries(id), parent_inode TEXT NOT NULL, record TEXT NOT NULL)"),
    ("observation_physical", "CREATE TABLE observation_physical (observation_id TEXT PRIMARY KEY NOT NULL REFERENCES external_observations(observation_id), inode TEXT NOT NULL, parent_inode TEXT NOT NULL, record TEXT NOT NULL)"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalIdentity {
    pub inode: String,
    pub parent_inode: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalBinding {
    pub state: EntryState,
    pub physical: PhysicalIdentity,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationPhysical {
    pub physical: PhysicalIdentity,
    pub expected_binding: Option<PhysicalBinding>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationKind {
    File,
    Directory,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationProof {
    pub attempt_id: OperationId,
    pub kind: PublicationKind,
    pub entry_id: EntryId,
    pub expected_binding: Option<PhysicalBinding>,
    pub parent_inode: String,
}
fn invalid(message: &str) -> StoreError {
    StoreError::Corrupt(message.into())
}
fn valid_string(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}
fn kind_name(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::File => "file",
        EntryKind::Folder => "directory",
    }
}
impl PhysicalIdentity {
    pub(super) fn validate(&self) -> Result<()> {
        if !valid_string(&self.inode) || !valid_string(&self.parent_inode) {
            return Err(invalid("invalid physical inode identity"));
        }
        Ok(())
    }
}
fn validate_saved(value: &PhysicalBinding) -> Result<()> {
    value.physical.validate()?;
    if value.state.deleted
        || !valid_string(value.state.id.as_str())
        || !valid_string(value.state.revision.as_str())
    {
        return Err(invalid("invalid physical binding state"));
    }
    Ok(())
}
fn validate_baseline(tx: &Connection, value: &PhysicalBinding) -> Result<()> {
    validate_saved(value)?;
    match value.state.kind {
        EntryKind::File => {
            if projection::baseline(tx, &value.state.id)?
                .as_ref()
                .map(|b| &b.state)
                != Some(&value.state)
            {
                return Err(invalid("physical binding differs from file baseline"));
            }
        }
        EntryKind::Folder => {
            let json: Option<String> = tx
                .query_row(
                    "SELECT record FROM directory_baselines WHERE entry_id=?1",
                    [value.state.id.as_str()],
                    |r| r.get(0),
                )
                .optional()?;
            let base: DirectoryBaseline = serde_json::from_str(
                &json.ok_or_else(|| invalid("physical directory baseline missing"))?,
            )?;
            if base.state != value.state || base.identity != value.physical.inode {
                return Err(invalid("physical binding differs from directory baseline"));
            }
        }
    }
    Ok(())
}
fn decode_binding(
    id: &EntryId,
    row: (String, String, String, String, String, String),
) -> Result<PhysicalBinding> {
    let (path, revision, kind, inode, parent, json) = row;
    let value: PhysicalBinding = serde_json::from_str(&json)?;
    if value.state.id != *id
        || value.state.path.as_str() != path
        || value.state.revision.as_str() != revision
        || kind_name(value.state.kind) != kind
        || value.physical.inode != inode
        || value.physical.parent_inode != parent
    {
        return Err(invalid("physical binding columns mismatch"));
    }
    Ok(value)
}
/// Read the whole saved physical namespace in one statement. Matching baselines
/// still receive full decoding and validation; no content or corruption checks
/// are skipped just because this caller only returns binding metadata.
pub(super) fn bindings(tx: &Connection) -> Result<Vec<PhysicalBinding>> {
    let mut statement = tx.prepare("SELECT b.entry_id,b.path,b.revision,b.kind,b.inode,b.parent_inode,b.record,p.record,d.record FROM physical_bindings b LEFT JOIN projection_baselines p ON p.entry_id=b.entry_id AND b.kind='file' LEFT JOIN directory_baselines d ON d.entry_id=b.entry_id AND b.kind='directory' ORDER BY b.entry_id")?;
    let mut rows = statement.query([])?;
    let mut values = Vec::new();
    while let Some(row) = rows.next()? {
        let id = EntryId::new(row.get::<_, String>(0)?)?;
        let value = decode_binding(
            &id,
            (
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ),
        )?;
        validate_saved(&value)?;
        match value.state.kind {
            EntryKind::File => {
                let raw: Option<String> = row.get(7)?;
                let base = raw
                    .map(|raw| projection::decode_baseline(id.as_str(), &raw))
                    .transpose()?;
                if base.as_ref().map(|b| &b.state) != Some(&value.state) {
                    return Err(invalid("physical binding differs from file baseline"));
                }
            }
            EntryKind::Folder => {
                let raw: Option<String> = row.get(8)?;
                let base: DirectoryBaseline = serde_json::from_str(
                    &raw.ok_or_else(|| invalid("physical directory baseline missing"))?,
                )?;
                if base.state != value.state || base.identity != value.physical.inode {
                    return Err(invalid("physical binding differs from directory baseline"));
                }
            }
        }
        values.push(value);
    }
    Ok(values)
}
pub(super) fn binding(tx: &Connection, id: &EntryId) -> Result<Option<PhysicalBinding>> {
    let row: Option<(String, String, String, String, String, String)> = tx.query_row(
        "SELECT path,revision,kind,inode,parent_inode,record FROM physical_bindings WHERE entry_id=?1",
        [id.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)),
    ).optional()?;
    row.map(|row| {
        let value = decode_binding(id, row)?;
        validate_baseline(tx, &value)?;
        Ok(value)
    })
    .transpose()
}
pub(super) fn check_binding(
    tx: &Connection,
    id: &EntryId,
    expected: Option<&PhysicalBinding>,
) -> Result<()> {
    if let Some(expected) = expected {
        validate_saved(expected)?;
        if expected.state.id != *id {
            return Err(invalid("physical binding entry mismatch"));
        }
    }
    if binding(tx, id)?.as_ref() != expected {
        return Err(invalid("physical binding changed"));
    }
    Ok(())
}
pub(super) fn put_binding(tx: &Connection, value: &PhysicalBinding) -> Result<()> {
    validate_baseline(tx, value)?;
    tx.execute("INSERT INTO physical_bindings(entry_id,path,revision,kind,inode,parent_inode,record) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(entry_id) DO UPDATE SET path=excluded.path,revision=excluded.revision,kind=excluded.kind,inode=excluded.inode,parent_inode=excluded.parent_inode,record=excluded.record",
        params![value.state.id.as_str(),value.state.path.as_str(),value.state.revision.as_str(),kind_name(value.state.kind),value.physical.inode,value.physical.parent_inode,serde_json::to_string(value)?])?;
    Ok(())
}
pub(super) fn remove_binding(tx: &Connection, id: &EntryId) -> Result<()> {
    tx.execute(
        "DELETE FROM physical_bindings WHERE entry_id=?1",
        [id.as_str()],
    )?;
    Ok(())
}
fn validate_observation(
    tx: &Connection,
    id: &OperationId,
    proof: &ObservationPhysical,
) -> Result<ExternalObservation> {
    proof.physical.validate()?;
    let json: String = tx.query_row(
        "SELECT record FROM external_observations WHERE observation_id=?1",
        [id.as_str()],
        |r| r.get(0),
    )?;
    let observation = projection::decode_observation(id.as_str(), &json)?;
    if observation.baseline.is_some() != proof.expected_binding.is_some() {
        return Err(invalid(
            "existing observation baseline requires physical provenance",
        ));
    }
    if let Some(expected) = &proof.expected_binding {
        validate_saved(expected)?;
        if expected.state.kind != EntryKind::File
            || observation.baseline.as_ref().map(|b| &b.state) != Some(&expected.state)
            || expected.state.path != observation.path
            || expected.physical.parent_inode != proof.physical.parent_inode
        {
            return Err(invalid("observation physical baseline mismatch"));
        }
    }
    Ok(observation)
}
pub(super) fn observation_proof(
    tx: &Connection,
    id: &OperationId,
) -> Result<Option<ObservationPhysical>> {
    let row: Option<(String, String, String)> = tx
        .query_row(
            "SELECT inode,parent_inode,record FROM observation_physical WHERE observation_id=?1",
            [id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    row.map(|(inode, parent, json)| {
        let proof: ObservationPhysical = serde_json::from_str(&json)?;
        if proof.physical.inode != inode || proof.physical.parent_inode != parent {
            return Err(invalid("observation physical columns mismatch"));
        }
        validate_observation(tx, id, &proof)?;
        Ok(proof)
    })
    .transpose()
}
pub(super) fn put_observation_proof(
    tx: &Connection,
    id: &OperationId,
    proof: &ObservationPhysical,
) -> Result<()> {
    let observation = validate_observation(tx, id, proof)?;
    if let Some(old) = observation_proof(tx, id)? {
        if old != *proof {
            return Err(invalid("observation physical proof is immutable"));
        }
        return Ok(());
    }
    if observation.resolution.is_some() {
        return Err(invalid(
            "resolved observation cannot acquire physical proof",
        ));
    }
    tx.execute("INSERT INTO observation_physical(observation_id,inode,parent_inode,record) VALUES(?1,?2,?3,?4)", params![id.as_str(),proof.physical.inode,proof.physical.parent_inode,serde_json::to_string(proof)?])?;
    Ok(())
}
pub(super) fn check_observation(
    tx: &Connection,
    id: &OperationId,
    entry_id: &EntryId,
) -> Result<Option<ObservationPhysical>> {
    let proof = observation_proof(tx, id)?;
    if let Some(proof) = &proof {
        let observation = validate_observation(tx, id, proof)?;
        if observation
            .baseline
            .as_ref()
            .is_some_and(|b| b.state.id != *entry_id)
        {
            return Err(invalid("observation physical entry mismatch"));
        }
        check_binding(tx, entry_id, proof.expected_binding.as_ref())?;
    }
    Ok(proof)
}
/// Called after writing the new physical baseline, in that SAME transaction.
/// Legacy/unproven imports must not leave an older binding attached to new bytes.
pub(super) fn put_observed_binding(
    tx: &Connection,
    state: &EntryState,
    proof: Option<&ObservationPhysical>,
) -> Result<()> {
    match proof {
        Some(proof) => {
            if state.kind != EntryKind::File
                || proof
                    .expected_binding
                    .as_ref()
                    .is_some_and(|b| b.state.id != state.id || b.state.path != state.path)
            {
                return Err(invalid("observed physical binding target mismatch"));
            }
            put_binding(
                tx,
                &PhysicalBinding {
                    state: state.clone(),
                    physical: proof.physical.clone(),
                },
            )
        }
        None => remove_binding(tx, &state.id),
    }
}
fn validate_publication(tx: &Connection, proof: &PublicationProof) -> Result<()> {
    if !valid_string(proof.attempt_id.as_str())
        || !valid_string(proof.entry_id.as_str())
        || !valid_string(&proof.parent_inode)
    {
        return Err(invalid("invalid publication physical identity"));
    }
    let (target, baseline) = match proof.kind {
        PublicationKind::File => {
            let (entry, completed, json): (String, i64, String) = tx.query_row(
                "SELECT entry_id,completed,record FROM projection_attempts WHERE attempt_id=?1",
                [proof.attempt_id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            let a =
                projection::decode_attempt(proof.attempt_id.as_str(), &entry, completed, &json)?;
            (a.target.state, a.baseline.map(|b| b.state))
        }
        PublicationKind::Directory => {
            let a = directory::get(tx, &proof.attempt_id)?;
            (a.target, None)
        }
    };
    if target.id != proof.entry_id
        || baseline.is_some() != proof.expected_binding.is_some()
        || (proof.kind == PublicationKind::Directory && proof.expected_binding.is_some())
    {
        return Err(invalid(
            "publication physical baseline presence or entry mismatch",
        ));
    }
    if let Some(expected) = &proof.expected_binding {
        validate_saved(expected)?;
        if expected.state.id != proof.entry_id
            || expected.state.kind != target.kind
            || expected.state.path != target.path
            || expected.physical.parent_inode != proof.parent_inode
            || (proof.kind == PublicationKind::File && baseline.as_ref() != Some(&expected.state))
        {
            return Err(invalid("publication expected physical baseline mismatch"));
        }
    }
    Ok(())
}
fn publication_kind(kind: PublicationKind) -> &'static str {
    match kind {
        PublicationKind::File => "file",
        PublicationKind::Directory => "directory",
    }
}
pub(super) fn publication_proof(
    tx: &Connection,
    attempt: &OperationId,
) -> Result<Option<PublicationProof>> {
    let row:Option<(String,String,String,String)> = tx.query_row("SELECT kind,entry_id,parent_inode,record FROM publication_parent_proofs WHERE attempt_id=?1",[attempt.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    row.map(|(kind, entry, parent, json)| {
        let proof: PublicationProof = serde_json::from_str(&json)?;
        if proof.attempt_id != *attempt
            || publication_kind(proof.kind) != kind
            || proof.entry_id.as_str() != entry
            || proof.parent_inode != parent
        {
            return Err(invalid("publication physical columns mismatch"));
        }
        validate_publication(tx, &proof)?;
        Ok(proof)
    })
    .transpose()
}
pub(super) fn put_publication_proof(tx: &Connection, proof: &PublicationProof) -> Result<()> {
    validate_publication(tx, proof)?;
    if let Some(old) = publication_proof(tx, &proof.attempt_id)? {
        if old != *proof {
            return Err(invalid("publication parent proof is immutable"));
        }
        return Ok(());
    }
    let table = match proof.kind {
        PublicationKind::File => "projection_attempts",
        PublicationKind::Directory => "directory_attempts",
    };
    let completed: bool = tx.query_row(
        &format!("SELECT completed FROM {table} WHERE attempt_id=?1"),
        [proof.attempt_id.as_str()],
        |r| r.get(0),
    )?;
    if completed {
        return Err(invalid(
            "completed publication cannot acquire physical proof",
        ));
    }
    tx.execute("INSERT INTO publication_parent_proofs(attempt_id,kind,entry_id,parent_inode,record) VALUES(?1,?2,?3,?4,?5)",params![proof.attempt_id.as_str(),publication_kind(proof.kind),proof.entry_id.as_str(),proof.parent_inode,serde_json::to_string(proof)?])?;
    Ok(())
}
/// A connection-bound, read-validated rebaseline preparation. This is scheduling
/// state, not serializable authority; a restart requires all validation again.
pub struct IdleRebaselinePreparation {
    owner: std::sync::Arc<()>,
    epoch: IdleRebaselineEpoch,
    expected: Vec<PhysicalBinding>,
    current: Vec<Option<PhysicalIdentity>>,
}
#[derive(Debug, PartialEq, Eq)]
struct IdleRebaselineEpoch {
    relevant_changes: u64,
    foreign_changes: i64,
    schema: i64,
    temp_schema: i64,
    version: i64,
    application: i64,
}
impl IdleRebaselinePreparation {
    pub fn members(&self) -> &[PhysicalBinding] {
        &self.expected
    }
}
fn idle_rebaseline_epoch(
    connection: &Connection,
    credit: Option<u64>,
) -> Result<IdleRebaselineEpoch> {
    let relevant_changes = credit
        .and_then(|credit| connection.total_changes().checked_sub(credit))
        .ok_or_else(|| invalid("rebaseline write epoch is poisoned"))?;
    Ok(IdleRebaselineEpoch {
        relevant_changes,
        foreign_changes: connection.query_row("PRAGMA data_version", [], |row| row.get(0))?,
        schema: connection.query_row("PRAGMA main.schema_version", [], |row| row.get(0))?,
        temp_schema: connection.query_row("PRAGMA temp.schema_version", [], |row| row.get(0))?,
        version: connection.query_row("PRAGMA user_version", [], |row| row.get(0))?,
        application: connection.query_row("PRAGMA application_id", [], |row| row.get(0))?,
    })
}
fn idle_rebaseline(connection: &Connection) -> Result<bool> {
    for query in [
        "SELECT EXISTS(SELECT 1 FROM projection_jobs WHERE completed=0)",
        "SELECT EXISTS(SELECT 1 FROM projection_attempts WHERE completed=0)",
        "SELECT EXISTS(SELECT 1 FROM directory_attempts WHERE completed=0)",
        "SELECT EXISTS(SELECT 1 FROM namespace_attempts WHERE completed=0)",
        "SELECT EXISTS(SELECT 1 FROM family_namespace_covered WHERE satisfied=0)",
        "SELECT EXISTS(SELECT 1 FROM host_intents WHERE state IN ('prepared','commit_requested'))",
        "SELECT EXISTS(SELECT 1 FROM external_observations WHERE json_extract(record,'$.resolution') IS NULL)",
        "SELECT EXISTS(SELECT 1 FROM family_external_namespace WHERE result IS NULL)",
        "SELECT EXISTS(SELECT 1 FROM binary_stages WHERE (purpose='command' AND phase IN ('receiving','sealed','commit_requested')) OR (purpose='capture' AND phase='receiving'))",
    ] {
        if connection.query_row(query, [], |row| row.get::<_, bool>(0))? { return Ok(false); }
    }
    Ok(true)
}
fn binding_metadata(connection: &Connection) -> Result<Vec<PhysicalBinding>> {
    let mut statement = connection.prepare("SELECT entry_id,path,revision,kind,inode,parent_inode,record FROM physical_bindings ORDER BY entry_id")?;
    let mut rows = statement.query([])?;
    let mut values = Vec::new();
    while let Some(row) = rows.next()? {
        let id = EntryId::new(row.get::<_, String>(0)?)?;
        let value = decode_binding(
            &id,
            (
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ),
        )?;
        validate_saved(&value)?;
        values.push(value);
    }
    Ok(values)
}
#[cfg(test)]
thread_local! {
    static REBASELINE_AFTER_SCHEMA: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
impl Store {
    /// Scheduling metadata only; no baseline/body-validation authority. The
    /// prepared member validator below retains the full existing content checks.
    pub fn physical_binding_metadata(&self) -> Result<Vec<PhysicalBinding>> {
        binding_metadata(&self.connection)
    }
    pub fn begin_idle_rebaseline(
        &self,
        expected: Vec<PhysicalBinding>,
    ) -> Result<Option<IdleRebaselinePreparation>> {
        if expected.is_empty() || expected.len() > 100_000 || !self.connection.is_autocommit() {
            return Ok(None);
        }
        let epoch =
            idle_rebaseline_epoch(&self.connection, self.external_checkpoint_changes.get())?;
        // Exact main schema prevents hidden trigger writes inside the certified
        // checkpoint-only method. No application code installs temporary triggers.
        super::check_schema(&self.connection)?;
        #[cfg(test)]
        REBASELINE_AFTER_SCHEMA.with(|point| { if let Some(point) = point.borrow_mut().take() { point(); } });
        let triggers: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_temp_schema WHERE type='trigger')",
            [],
            |row| row.get(0),
        )?;
        if triggers {
            return Err(invalid("temporary triggers cannot authorize rebaseline"));
        }
        let tx = self.connection.unchecked_transaction()?;
        if !idle_rebaseline(&tx)? || binding_metadata(&tx)? != expected {
            return Ok(None);
        }
        let entries = entry_content::read_visible_metadata(&tx)?;
        if entries.len() != expected.len() {
            return Ok(None);
        }
        let entries: std::collections::BTreeMap<_, _> = entries
            .into_iter()
            .map(|entry| (entry.state.id.clone(), entry.state))
            .collect();
        let mut ids = std::collections::BTreeSet::new();
        for before in &expected {
            if !ids.insert(before.state.id.clone())
                || entries.get(&before.state.id) != Some(&before.state)
            {
                return Ok(None);
            }
        }
        tx.commit()?;
        if idle_rebaseline_epoch(&self.connection, self.external_checkpoint_changes.get())? != epoch
        {
            return Ok(None);
        }
        let count = expected.len();
        Ok(Some(IdleRebaselinePreparation {
            owner: self.external_work_owner.clone(),
            epoch,
            expected,
            current: vec![None; count],
        }))
    }
    pub fn idle_rebaseline_is_current(&self, prepared: &IdleRebaselinePreparation) -> Result<bool> {
        Ok(
            std::sync::Arc::ptr_eq(&self.external_work_owner, &prepared.owner)
                && idle_rebaseline_epoch(&self.connection, self.external_checkpoint_changes.get())?
                    == prepared.epoch,
        )
    }
    /// Validate exactly one complete member after native has hashed its current
    /// anchored physical bytes. No inline body is retained in the prepared token.
    pub fn validate_idle_rebaseline_member(
        &self,
        prepared: &mut IdleRebaselinePreparation,
        index: usize,
        physical: PhysicalIdentity,
        content: Option<(u64, zorid_file_sync::Sha256Digest)>,
    ) -> Result<bool> {
        if !self.idle_rebaseline_is_current(prepared)? {
            return Ok(false);
        }
        let before = prepared
            .expected
            .get(index)
            .ok_or_else(|| invalid("rebaseline member index is invalid"))?;
        physical.validate()?;
        let tx = self.connection.unchecked_transaction()?;
        if binding(&tx, &before.state.id)?.as_ref() != Some(before) {
            return Ok(false);
        }
        let entry = entry_content::read_metadata_row(&tx, &before.state.id)?;
        if !is_visible(&tx, &before.state.id)? {
            return Ok(false);
        }
        let Some(entry) = entry.filter(|entry| entry.state == before.state) else {
            return Ok(false);
        };
        let claimed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM physical_bindings WHERE inode=?1 AND entry_id<>?2)",
            params![physical.inode, before.state.id.as_str()],
            |row| row.get(0),
        )?;
        if claimed {
            return Ok(false);
        }
        let normal = family_materialization::get(&tx, &before.state.id)?;
        if !normal.as_ref().is_some_and(|value| matches!(&value.publication, FamilyPublication::Normal { path, kind, .. } if path == &before.state.path && kind == &before.state.kind)) { return Ok(false); }
        if before.state.kind == EntryKind::File {
            let Some(base) = projection::baseline(&tx, &before.state.id)?
                .filter(|base| base.state == before.state)
            else {
                return Ok(false);
            };
            if !entry.content.as_ref().is_some_and(|saved| {
                saved.len() == base.content.len() && *saved.digest() == base.content.digest()
            }) || content != Some((base.content.len(), base.content.digest()))
            {
                return Ok(false);
            }
            family_materialization::check_publication_content(
                &tx,
                &before.state,
                Some(&base.content),
            )?;
        } else {
            if content.is_some()
                || !directory::baseline(&tx, &before.state.id)?.is_some_and(|base| {
                    base.state == before.state && base.identity == before.physical.inode
                })
            {
                return Ok(false);
            }
            family_materialization::check_publication_content(&tx, &before.state, None)?;
        }
        tx.commit()?;
        if !self.idle_rebaseline_is_current(prepared)? {
            return Ok(false);
        }
        prepared.current[index] = Some(physical);
        Ok(true)
    }
    /// Atomic scalar apply. All body checks were performed under this unchanged
    /// opaque epoch. The final writer blocks foreign commits before checking it.
    /// Enumeration and the metadata transaction may overrun a soft native clock.
    pub fn finish_idle_rebaseline(&mut self, prepared: IdleRebaselinePreparation) -> Result<bool> {
        if !self.idle_rebaseline_is_current(&prepared)?
            || prepared.current.iter().any(Option::is_none)
        {
            return Ok(false);
        }
        let credit = self.external_checkpoint_changes.get();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if idle_rebaseline_epoch(&tx, credit)? != prepared.epoch {
            return Ok(false);
        }
        let current: Vec<_> = prepared.current.into_iter().map(Option::unwrap).collect();
        let mut inodes = std::collections::BTreeSet::new();
        let parents: std::collections::BTreeMap<_, _> = prepared
            .expected
            .iter()
            .zip(&current)
            .filter(|(before, _)| before.state.kind == EntryKind::Folder)
            .map(|(before, physical)| (&before.state.path, physical))
            .collect();
        for (before, physical) in prepared.expected.iter().zip(&current) {
            if !inodes.insert(&physical.inode)
                || before.state.path.parent().is_some_and(|parent| {
                    !parents
                        .get(&parent)
                        .is_some_and(|parent| parent.inode == physical.parent_inode)
                })
            {
                return Ok(false);
            }
        }
        for (before, physical) in prepared.expected.iter().zip(current) {
            if before.state.kind == EntryKind::Folder {
                let record = serde_json::to_string(&DirectoryBaseline {
                    state: before.state.clone(),
                    identity: physical.inode.clone(),
                })?;
                if tx.execute(
                    "UPDATE directory_baselines SET record=?1 WHERE entry_id=?2",
                    params![record, before.state.id.as_str()],
                )? != 1
                {
                    return Err(invalid("prepared directory baseline disappeared"));
                }
            }
            let record = serde_json::to_string(&PhysicalBinding {
                state: before.state.clone(),
                physical: physical.clone(),
            })?;
            if tx.execute("UPDATE physical_bindings SET inode=?1,parent_inode=?2,record=?3 WHERE entry_id=?4 AND path=?5 AND revision=?6 AND kind=?7 AND inode=?8 AND parent_inode=?9", params![physical.inode,physical.parent_inode,record,before.state.id.as_str(),before.state.path.as_str(),before.state.revision.as_str(),kind_name(before.state.kind),before.physical.inode,before.physical.parent_inode])? != 1 { return Err(invalid("prepared physical binding changed")); }
        }
        tx.commit()?;
        Ok(true)
    }
}
impl Store {
    /// Rebaseline a complete idle bound namespace after native has re-read exact
    /// same-path, same-kind, baseline-equivalent physical objects under its vault
    /// lock. This accepts fresh occupants; it does not infer historical identity.
    /// No logical revision, source content, receipt or historical proof changes.
    pub fn rebaseline_idle_physical_bindings(
        &mut self,
        expected: &[PhysicalBinding],
        current: &[PhysicalIdentity],
    ) -> Result<bool> {
        if expected.is_empty() || expected.len() != current.len() || expected.len() > 100_000 {
            return Ok(false);
        }
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Global idle is deliberately conservative: ancestor/descendant members
        // and pending source guards cannot escape a target-entry-only check.
        for query in [
            "SELECT EXISTS(SELECT 1 FROM projection_jobs WHERE completed=0)",
            "SELECT EXISTS(SELECT 1 FROM projection_attempts WHERE completed=0)",
            "SELECT EXISTS(SELECT 1 FROM directory_attempts WHERE completed=0)",
            "SELECT EXISTS(SELECT 1 FROM namespace_attempts WHERE completed=0)",
            "SELECT EXISTS(SELECT 1 FROM family_namespace_covered WHERE satisfied=0)",
            "SELECT EXISTS(SELECT 1 FROM host_intents WHERE state IN ('prepared','commit_requested'))",
            "SELECT EXISTS(SELECT 1 FROM external_observations WHERE json_extract(record,'$.resolution') IS NULL)",
            "SELECT EXISTS(SELECT 1 FROM family_external_namespace WHERE result IS NULL)",
            "SELECT EXISTS(SELECT 1 FROM binary_stages WHERE (purpose='command' AND phase IN ('receiving','sealed','commit_requested')) OR (purpose='capture' AND phase='receiving'))",
        ] {
            if tx.query_row(query, [], |row| row.get::<_, bool>(0))? { return Ok(false); }
        }
        let entries = entry_content::read_visible_metadata(&tx)?;
        let entries_by_id: std::collections::BTreeMap<_, _> = entries.iter().map(|entry| (&entry.state.id, entry)).collect();
        let count: i64 = tx.query_row("SELECT count(*) FROM physical_bindings", [], |row| row.get(0))?;
        if entries.len() != expected.len() || count != expected.len() as i64 { return Ok(false); }
        let mut ids = std::collections::BTreeSet::new();
        let mut inodes = std::collections::BTreeSet::new();
        let mut parents = std::collections::BTreeMap::new();
        for (before, physical) in expected.iter().zip(current) {
            validate_saved(before)?; physical.validate()?;
            if !ids.insert(&before.state.id) || !inodes.insert(&physical.inode)
                || binding(&tx, &before.state.id)?.as_ref() != Some(before)
                || entries_by_id.get(&before.state.id).is_none_or(|entry| entry.state != before.state)
            { return Ok(false); }
            let claimed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM physical_bindings WHERE inode=?1 AND entry_id<>?2)",
                params![physical.inode, before.state.id.as_str()], |row| row.get(0))?;
            if claimed { return Ok(false); }
            let normal = family_materialization::get(&tx, &before.state.id)?;
            if !normal.as_ref().is_some_and(|value| matches!(&value.publication,
                FamilyPublication::Normal { path, kind, .. } if path == &before.state.path && kind == &before.state.kind))
            { return Ok(false); }
            if before.state.kind == EntryKind::File {
                let base = projection::baseline(&tx, &before.state.id)?;
                let Some(base) = base.filter(|base| base.state == before.state) else { return Ok(false); };
                let entry = entries_by_id.get(&before.state.id).expect("checked entry");
                if !entry.content.as_ref().is_some_and(|content| content.len() == base.content.len() && *content.digest() == base.content.digest()) {
                    return Ok(false);
                }
                family_materialization::check_publication_content(&tx, &before.state, Some(&base.content))?;
            } else {
                let base = directory::baseline(&tx, &before.state.id)?;
                if !base.is_some_and(|base| base.state == before.state && base.identity == before.physical.inode) { return Ok(false); }
                family_materialization::check_publication_content(&tx, &before.state, None)?;
                parents.insert(&before.state.path, physical);
            }
        }
        for (before, physical) in expected.iter().zip(current) {
            if let Some(parent) = before.state.path.parent() {
                if !parents.get(&parent).is_some_and(|binding| binding.inode == physical.parent_inode) { return Ok(false); }
            }
        }
        let mut order: Vec<_> = (0..expected.len()).collect();
        order.sort_by_key(|&index| (expected[index].state.kind != EntryKind::Folder, expected[index].state.path.as_str().split('/').count()));
        for index in order {
            let before = &expected[index]; let physical = &current[index];
            if before.state.kind == EntryKind::Folder {
                directory::put_baseline(&tx, &DirectoryBaseline { state: before.state.clone(), identity: physical.inode.clone() })?;
            }
            put_binding(&tx, &PhysicalBinding { state: before.state.clone(), physical: physical.clone() })?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// Physical ownership survives logical moves/deletes until the corresponding
    /// physical baseline is retired. Never infer absence from live entries alone.
    pub fn physical_owner_at(
        &self,
        path: &zorid_core::VaultPath,
    ) -> Result<Option<PhysicalBinding>> {
        let tx = self.connection.unchecked_transaction()?;
        let ids = tx
            .prepare("SELECT entry_id FROM physical_bindings WHERE path=?1 LIMIT 2")?
            .query_map([path.as_str()], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if ids.len() > 1 {
            return Err(invalid("multiple physical owners at one path"));
        }
        let result = match ids.first() {
            Some(id) => binding(&tx, &EntryId::new(id.clone())?)?,
            None => None,
        };
        tx.commit()?;
        Ok(result)
    }
    /// Select physical ownership independently of current logical visibility.
    /// This is a fresh, targeted read, not a whole-catalogue integrity audit.
    pub fn physical_owner_by_inode(&self, inode: &str) -> Result<Option<PhysicalBinding>> {
        if !valid_string(inode) {
            return Err(invalid("invalid physical inode identity"));
        }
        let tx = self.connection.unchecked_transaction()?;
        let ids = tx
            .prepare("SELECT CASE WHEN length(CAST(entry_id AS BLOB)) BETWEEN 1 AND 128 THEN entry_id ELSE '' END FROM physical_bindings WHERE inode=?1 LIMIT 2")?
            .query_map([inode], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if ids.len() > 1 {
            return Err(invalid("multiple physical owners of one inode"));
        }
        let result = match ids.first() {
            Some(id) => {
                let value = binding(&tx, &EntryId::new(id.clone())?)?
                    .ok_or_else(|| invalid("selected physical binding missing"))?;
                if value.physical.inode != inode {
                    return Err(invalid("selected physical inode mismatch"));
                }
                Some(value)
            }
            None => None,
        };
        tx.commit()?;
        Ok(result)
    }
    pub fn physical_binding(&self, id: &EntryId) -> Result<Option<PhysicalBinding>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = binding(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn publication_proof(&self, attempt: &OperationId) -> Result<Option<PublicationProof>> {
        let tx = self.connection.unchecked_transaction()?;
        let result = publication_proof(&tx, attempt)?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::VaultPath;
    fn op(s: &str) -> OperationId {
        OperationId::new(s).unwrap()
    }
    fn physical() -> PhysicalIdentity {
        PhysicalIdentity {
            inode: "disk-inode".into(),
            parent_inode: "parent-inode".into(),
        }
    }
    fn setup(kind: EntryKind) -> (tempfile::TempDir, Store, PhysicalBinding) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        let id = EntryId::new("entry").unwrap();
        store
            .apply(&MutationRequest {
                operation_id: op("create"),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: VaultPath::new("item").unwrap(),
                    kind,
                    content: (kind == EntryKind::File).then(|| b"bytes".to_vec()),
                },
            })
            .unwrap();
        let state = store.read(&id).unwrap().unwrap().state;
        if kind == EntryKind::File {
            projection::put_baseline(
                &store.connection,
                &ProjectionBaseline {
                    state: state.clone(),
                    content: StoredContent::InlineBytes(b"bytes".to_vec()),
                },
            )
            .unwrap();
        } else {
            let base = DirectoryBaseline {
                state: state.clone(),
                identity: physical().inode,
            };
            store
                .connection
                .execute(
                    "INSERT INTO directory_baselines(entry_id,record) VALUES(?1,?2)",
                    params![id.as_str(), serde_json::to_string(&base).unwrap()],
                )
                .unwrap();
        }
        (
            dir,
            store,
            PhysicalBinding {
                state,
                physical: physical(),
            },
        )
    }
    fn observation(store: &mut Store, expected: &PhysicalBinding) -> OperationId {
        store
            .record_external(
                &expected.state.path,
                projection::baseline(&store.connection, &expected.state.id).unwrap(),
                b"observed".to_vec(),
            )
            .unwrap()
            .observation_id
    }
    #[test]
    fn binding_tracks_physical_baseline_not_newer_logical_revision() {
        let (_dir, mut store, b) = setup(EntryKind::File);
        put_binding(&store.connection, &b).unwrap();
        store
            .apply(&MutationRequest {
                operation_id: op("write"),
                mutation: Mutation::Write {
                    id: b.state.id.clone(),
                    expected: b.state.revision.clone(),
                    content: b"desired".to_vec(),
                },
            })
            .unwrap();
        assert_ne!(
            store.read(&b.state.id).unwrap().unwrap().state.revision,
            b.state.revision
        );
        assert_eq!(
            store.physical_binding(&b.state.id).unwrap(),
            Some(b.clone())
        );
        check_binding(&store.connection, &b.state.id, Some(&b)).unwrap();
        assert!(check_binding(&store.connection, &b.state.id, None).is_err());
        let mut stale = b.clone();
        stale.physical.parent_inode = "other".into();
        assert!(check_binding(&store.connection, &b.state.id, Some(&stale)).is_err());
        let latest = store.read(&b.state.id).unwrap().unwrap();
        projection::put_baseline(
            &store.connection,
            &ProjectionBaseline {
                state: latest.state,
                content: StoredContent::InlineBytes(latest.content.unwrap()),
            },
        )
        .unwrap();
        // A legacy/unbound baseline transition atomically drops old authority.
        assert!(store.physical_binding(&b.state.id).unwrap().is_none());
    }
    #[test]
    fn directory_binding_requires_saved_inode_and_exact_baseline_state() {
        let (_dir, store, b) = setup(EntryKind::Folder);
        let mut wrong = b.clone();
        wrong.physical.inode = "other".into();
        assert!(put_binding(&store.connection, &wrong).is_err());
        wrong = b.clone();
        wrong.state.revision = Revision::new("other-revision").unwrap();
        assert!(put_binding(&store.connection, &wrong).is_err());
        put_binding(&store.connection, &b).unwrap();
        assert_eq!(binding(&store.connection, &b.state.id).unwrap(), Some(b));
    }
    #[test]
    fn observation_proof_is_immutable_and_baseline_transition_is_atomic() {
        let (_dir, mut store, b) = setup(EntryKind::File);
        put_binding(&store.connection, &b).unwrap();
        let id = observation(&mut store, &b);
        let proof = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "replacement".into(),
                parent_inode: b.physical.parent_inode.clone(),
            },
            expected_binding: Some(b.clone()),
        };
        put_observation_proof(&store.connection, &id, &proof).unwrap();
        put_observation_proof(&store.connection, &id, &proof).unwrap();
        let mut wrong = proof.clone();
        wrong.physical.inode = "different".into();
        assert!(put_observation_proof(&store.connection, &id, &wrong).is_err());
        assert_eq!(
            check_observation(&store.connection, &id, &b.state.id).unwrap(),
            Some(proof.clone())
        );
        let mut observed = b.state.clone();
        observed.revision = Revision::new("observed-branch").unwrap();
        {
            let tx = store.connection.transaction().unwrap();
            let checked = check_observation(&tx, &id, &b.state.id).unwrap();
            projection::put_baseline(
                &tx,
                &ProjectionBaseline {
                    state: observed.clone(),
                    content: StoredContent::InlineBytes(b"observed".to_vec()),
                },
            )
            .unwrap();
            put_observed_binding(&tx, &observed, checked.as_ref()).unwrap();
            // Simulate interruption before commit: both baseline and binding roll back.
        }
        assert_eq!(
            binding(&store.connection, &b.state.id).unwrap(),
            Some(b.clone())
        );
        let tx = store.connection.transaction().unwrap();
        let checked = check_observation(&tx, &id, &b.state.id).unwrap();
        projection::put_baseline(
            &tx,
            &ProjectionBaseline {
                state: observed.clone(),
                content: StoredContent::InlineBytes(b"observed".to_vec()),
            },
        )
        .unwrap();
        put_observed_binding(&tx, &observed, checked.as_ref()).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            binding(&store.connection, &b.state.id).unwrap(),
            Some(PhysicalBinding {
                state: observed.clone(),
                physical: proof.physical.clone()
            })
        );
        // Historical proof remains readable, but cannot authorize another transition.
        assert_eq!(
            observation_proof(&store.connection, &id).unwrap(),
            Some(proof)
        );
        assert!(check_observation(&store.connection, &id, &b.state.id).is_err());
        put_observed_binding(&store.connection, &observed, None).unwrap();
        assert!(binding(&store.connection, &b.state.id).unwrap().is_none());
    }
    #[test]
    fn publication_parent_proof_cannot_be_rebound() {
        let (_dir, mut store, b) = setup(EntryKind::File);
        put_binding(&store.connection, &b).unwrap();
        let a = store.begin_projection(&b.state.id).unwrap();
        let proof = PublicationProof {
            attempt_id: a.attempt_id.clone(),
            kind: PublicationKind::File,
            entry_id: b.state.id.clone(),
            expected_binding: Some(b.clone()),
            parent_inode: b.physical.parent_inode.clone(),
        };
        put_publication_proof(&store.connection, &proof).unwrap();
        put_publication_proof(&store.connection, &proof).unwrap();
        assert_eq!(
            store.publication_proof(&a.attempt_id).unwrap(),
            Some(proof.clone())
        );
        let mut wrong = proof.clone();
        wrong.parent_inode = "replaced-parent".into();
        assert!(put_publication_proof(&store.connection, &wrong).is_err());
        wrong = proof.clone();
        wrong.kind = PublicationKind::Directory;
        assert!(put_publication_proof(&store.connection, &wrong).is_err());
        store
            .connection
            .execute(
                "UPDATE publication_parent_proofs SET parent_inode='column-only'",
                [],
            )
            .unwrap();
        assert!(store.publication_proof(&a.attempt_id).is_err());
    }
    #[test]
    fn malformed_and_cross_entry_proofs_fail_before_attachment() {
        let (_dir, mut store, b) = setup(EntryKind::File);
        for bad in [String::new(), "x".repeat(129)] {
            let mut wrong = b.clone();
            wrong.physical.inode = bad.clone();
            assert!(put_binding(&store.connection, &wrong).is_err());
            wrong = b.clone();
            wrong.physical.parent_inode = bad;
            assert!(put_binding(&store.connection, &wrong).is_err());
        }
        let id = observation(&mut store, &b);
        let mut wrong = b.clone();
        wrong.state.id = EntryId::new("different").unwrap();
        assert!(put_observation_proof(
            &store.connection,
            &id,
            &ObservationPhysical {
                physical: physical(),
                expected_binding: Some(wrong)
            }
        )
        .is_err());
        let proof = ObservationPhysical {
            physical: physical(),
            expected_binding: Some(b.clone()),
        };
        put_observation_proof(&store.connection, &id, &proof).unwrap();
        store
            .connection
            .execute("UPDATE observation_physical SET inode='column-only'", [])
            .unwrap();
        assert!(observation_proof(&store.connection, &id).is_err());
    }
    #[test]
    fn completed_obligations_cannot_acquire_new_historical_proof() {
        let (_dir, mut store, b) = setup(EntryKind::File);
        let observation_id = observation(&mut store, &b);
        store.connection.execute("UPDATE external_observations SET record=json_set(record,'$.resolution','resolved') WHERE observation_id=?1",[observation_id.as_str()]).unwrap();
        let observed = ObservationPhysical {
            physical: physical(),
            expected_binding: Some(b.clone()),
        };
        assert!(put_observation_proof(&store.connection, &observation_id, &observed).is_err());
        let attempt = store.begin_projection(&b.state.id).unwrap();
        store.connection.execute("UPDATE projection_attempts SET completed=1,record=json_set(record,'$.phase','complete','$.stage_identity','published-inode') WHERE attempt_id=?1",[attempt.attempt_id.as_str()]).unwrap();
        let proof = PublicationProof {
            attempt_id: attempt.attempt_id,
            kind: PublicationKind::File,
            entry_id: b.state.id.clone(),
            expected_binding: Some(b.clone()),
            parent_inode: b.physical.parent_inode.clone(),
        };
        assert!(put_publication_proof(&store.connection, &proof).is_err());
    }
    #[test]
    fn missing_legacy_binding_cannot_be_enrolled_as_an_observed_edit() {
        let (_dir, mut store, b) = setup(EntryKind::File);
        let existing = observation(&mut store, &b);
        let proof = ObservationPhysical {
            physical: physical(),
            expected_binding: None,
        };
        assert!(put_observation_proof(&store.connection, &existing, &proof).is_err());
        assert!(observation_proof(&store.connection, &existing)
            .unwrap()
            .is_none());
        let fresh = store
            .record_external(&VaultPath::new("fresh").unwrap(), None, b"fresh".to_vec())
            .unwrap();
        let wrong = ObservationPhysical {
            physical: physical(),
            expected_binding: Some(b),
        };
        assert!(put_observation_proof(&store.connection, &fresh.observation_id, &wrong).is_err());
        put_observation_proof(&store.connection, &fresh.observation_id, &proof).unwrap();
        assert_eq!(
            check_observation(
                &store.connection,
                &fresh.observation_id,
                &EntryId::new("new-entry").unwrap()
            )
            .unwrap(),
            Some(proof)
        );
    }
    #[test]
    fn restored_publication_proof_requires_exact_baseline_presence_and_parent() {
        for mutation in [
            "UPDATE publication_parent_proofs SET record=json_set(record,'$.expected_binding',NULL)",
            "UPDATE publication_parent_proofs SET parent_inode='replacement',record=json_set(record,'$.parent_inode','replacement')",
            "UPDATE publication_parent_proofs SET record=json_set(record,'$.expected_binding.physical.parent_inode','replacement')",
        ] {
            let (_dir,mut store,b)=setup(EntryKind::File);
            put_binding(&store.connection,&b).unwrap();
            let a=store.begin_projection(&b.state.id).unwrap();
            let proof=PublicationProof {attempt_id:a.attempt_id.clone(),kind:PublicationKind::File,entry_id:b.state.id.clone(),expected_binding:Some(b.clone()),parent_inode:b.physical.parent_inode.clone()};
            put_publication_proof(&store.connection,&proof).unwrap();
            store.connection.execute(mutation,[]).unwrap();
            assert!(store.publication_proof(&a.attempt_id).is_err(),"{mutation}");
        }
    }
    #[test]
    fn directory_publication_proof_uses_full_attempt_validation() {
        let (_dir, mut store, b) = setup(EntryKind::Folder);
        let a = store.begin_directory_projection(&b.state.id).unwrap();
        let mut proof = PublicationProof {
            attempt_id: a.attempt_id.clone(),
            kind: PublicationKind::Directory,
            entry_id: b.state.id.clone(),
            expected_binding: Some(b.clone()),
            parent_inode: b.physical.parent_inode.clone(),
        };
        assert!(put_publication_proof(&store.connection, &proof).is_err());
        proof.expected_binding = None;
        put_publication_proof(&store.connection, &proof).unwrap();
        store.connection.execute("UPDATE directory_attempts SET record=json_set(record,'$.phase','published') WHERE attempt_id=?1",[a.attempt_id.as_str()]).unwrap();
        assert!(store.publication_proof(&a.attempt_id).is_err());
    }
    #[test]
    fn observed_atomic_save_cannot_rebind_a_replaced_parent() {
        let (_dir, mut store, b) = setup(EntryKind::File);
        put_binding(&store.connection, &b).unwrap();
        let id = observation(&mut store, &b);
        let mut proof = ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "atomic-save-inode".into(),
                parent_inode: "replaced-parent".into(),
            },
            expected_binding: Some(b.clone()),
        };
        assert!(put_observation_proof(&store.connection, &id, &proof).is_err());
        assert!(observation_proof(&store.connection, &id).unwrap().is_none());
        proof.physical.parent_inode = b.physical.parent_inode.clone();
        put_observation_proof(&store.connection, &id, &proof).unwrap();
        assert_eq!(
            check_observation(&store.connection, &id, &b.state.id).unwrap(),
            Some(proof)
        );
    }
    fn add_bound_file(store: &mut Store, name: &str, inode: &str) -> PhysicalBinding {
        let id = EntryId::new(name).unwrap();
        store
            .apply(&MutationRequest {
                operation_id: op(&format!("create-{name}")),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: VaultPath::new(name).unwrap(),
                    kind: EntryKind::File,
                    content: Some(b"other bytes".to_vec()),
                },
            })
            .unwrap();
        let state = store.read(&id).unwrap().unwrap().state;
        projection::put_baseline(
            &store.connection,
            &ProjectionBaseline {
                state: state.clone(),
                content: StoredContent::InlineBytes(b"other bytes".to_vec()),
            },
        )
        .unwrap();
        let value = PhysicalBinding {
            state,
            physical: PhysicalIdentity {
                inode: inode.into(),
                parent_inode: "parent-inode".into(),
            },
        };
        put_binding(&store.connection, &value).unwrap();
        value
    }

    // Connection-local actual SQL reads, following the existing Store trace tests.
    struct InodeReads<'a> {
        connection: &'a Connection,
        counts: Box<std::cell::Cell<[usize; 3]>>,
    }
    impl<'a> InodeReads<'a> {
        fn new(connection: &'a Connection) -> Self {
            unsafe extern "C" fn observe(
                event: u32,
                context: *mut std::ffi::c_void,
                _: *mut std::ffi::c_void,
                sql: *mut std::ffi::c_void,
            ) -> i32 {
                if event == rusqlite::ffi::SQLITE_TRACE_STMT && !context.is_null() && !sql.is_null()
                {
                    let bytes = unsafe { std::ffi::CStr::from_ptr(sql.cast()) }.to_bytes();
                    let slot = if bytes
                        .starts_with(b"SELECT record FROM projection_baselines WHERE")
                    {
                        Some(0)
                    } else if bytes.starts_with(b"SELECT record FROM directory_baselines WHERE") {
                        Some(1)
                    } else if bytes.starts_with(b"SELECT entry_id FROM physical_bindings ORDER BY")
                        || bytes.starts_with(b"SELECT b.entry_id,b.path,b.revision,b.kind,b.inode,b.parent_inode,b.record")
                    {
                        Some(2)
                    } else {
                        None
                    };
                    if let Some(slot) = slot {
                        let counts = unsafe { &*context.cast::<std::cell::Cell<[usize; 3]>>() };
                        let mut value = counts.get();
                        value[slot] += 1;
                        counts.set(value);
                    }
                }
                0
            }
            let value = Self {
                connection,
                counts: Box::new(std::cell::Cell::new([0; 3])),
            };
            assert_eq!(
                unsafe {
                    rusqlite::ffi::sqlite3_trace_v2(
                        connection.handle(),
                        rusqlite::ffi::SQLITE_TRACE_STMT,
                        Some(observe),
                        (&*value.counts as *const std::cell::Cell<[usize; 3]>)
                            .cast_mut()
                            .cast(),
                    )
                },
                rusqlite::ffi::SQLITE_OK
            );
            value
        }
    }
    impl Drop for InodeReads<'_> {
        fn drop(&mut self) {
            assert_eq!(
                unsafe {
                    rusqlite::ffi::sqlite3_trace_v2(
                        self.connection.handle(),
                        0,
                        None,
                        std::ptr::null_mut(),
                    )
                },
                rusqlite::ffi::SQLITE_OK
            );
        }
    }

    #[test]
    fn binding_inventory_reads_one_ordered_validated_batch_without_point_queries() {
        let (_dir, mut store, directory) = setup(EntryKind::Folder);
        put_binding(&store.connection, &directory).unwrap();
        let first = add_bound_file(&mut store, "aaa-file", "first-inode");
        let last = add_bound_file(&mut store, "zzz-file", "last-inode");
        let before = store.connection.total_changes();
        let trace = InodeReads::new(&store.connection);
        assert_eq!(
            store.physical_bindings().unwrap(),
            vec![first, directory, last]
        );
        assert_eq!(trace.counts.get(), [0, 0, 1]);
        assert_eq!(store.connection.total_changes(), before);
    }

    #[test]
    fn binding_inventory_actual_query_plan_streams_without_sorting_baseline_payloads() {
        struct QueryCapture<'a> {
            connection: &'a Connection,
            sql: Box<std::cell::RefCell<Vec<String>>>,
        }
        impl Drop for QueryCapture<'_> {
            fn drop(&mut self) {
                assert_eq!(
                    unsafe {
                        rusqlite::ffi::sqlite3_trace_v2(
                            self.connection.handle(),
                            0,
                            None,
                            std::ptr::null_mut(),
                        )
                    },
                    rusqlite::ffi::SQLITE_OK
                );
            }
        }
        unsafe extern "C" fn capture_inventory(
            event: u32,
            context: *mut std::ffi::c_void,
            _: *mut std::ffi::c_void,
            sql: *mut std::ffi::c_void,
        ) -> i32 {
            if event == rusqlite::ffi::SQLITE_TRACE_STMT && !context.is_null() && !sql.is_null() {
                let sql = unsafe { std::ffi::CStr::from_ptr(sql.cast()) }.to_string_lossy();
                let lower = sql.to_ascii_lowercase();
                if lower.starts_with("select")
                    && lower.contains("from physical_bindings")
                    && lower.contains("projection_baselines")
                {
                    let captured = unsafe { &*context.cast::<std::cell::RefCell<Vec<String>>>() };
                    captured.borrow_mut().push(sql.into_owned());
                }
            }
            0
        }

        let (_dir, mut store, directory) = setup(EntryKind::Folder);
        put_binding(&store.connection, &directory).unwrap();
        add_bound_file(&mut store, "aaa-file", "first-inode");
        add_bound_file(&mut store, "zzz-file", "last-inode");
        let capture = QueryCapture {
            connection: &store.connection,
            sql: Box::new(std::cell::RefCell::new(Vec::new())),
        };
        assert_eq!(
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    store.connection.handle(),
                    rusqlite::ffi::SQLITE_TRACE_STMT,
                    Some(capture_inventory),
                    (&*capture.sql as *const std::cell::RefCell<Vec<String>>)
                        .cast_mut()
                        .cast(),
                )
            },
            rusqlite::ffi::SQLITE_OK
        );
        assert_eq!(store.physical_bindings().unwrap().len(), 3);
        assert_eq!(
            capture.sql.borrow().len(),
            1,
            "capture the executed inventory statement, not a copied query"
        );
        let sql = capture.sql.borrow()[0].clone();
        drop(capture);

        // Explain the exact captured statement using this build's bundled SQLite,
        // with both default estimates and statistics for the current inventory.
        for with_statistics in [false, true] {
            if with_statistics {
                store.connection.execute_batch("ANALYZE").unwrap();
            }
            let mut statement = store
                .connection
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap();
            let plan = statement
                .query_map([], |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert!(!plan.is_empty());
            assert!(plan.iter().all(|step| !step.to_ascii_uppercase().contains("TEMP B-TREE")),
                "inventory must not sort joined baseline content (statistics={with_statistics}): {plan:?}");
        }
    }

    #[test]
    fn binding_inventory_preserves_point_validation_for_every_bound_file() {
        for sql in [
            "UPDATE physical_bindings SET record='invalid-json'",
            "UPDATE physical_bindings SET path='different'",
            "UPDATE physical_bindings SET revision='different'",
            "UPDATE physical_bindings SET kind='directory'",
            "UPDATE physical_bindings SET inode='different'",
            "UPDATE physical_bindings SET parent_inode='different'",
            "UPDATE physical_bindings SET record=json_set(record,'$.physical.inode','different')",
            "UPDATE physical_bindings SET record=json_set(record,'$.physical.parent_inode','')",
            "UPDATE physical_bindings SET record=json_set(record,'$.state.deleted',json('true'))",
            "UPDATE physical_bindings SET record=json_set(record,'$.unknown',1)",
            "UPDATE projection_baselines SET record='invalid-json'",
            "DELETE FROM projection_baselines",
            "UPDATE projection_baselines SET record=json_set(record,'$.state.id','different')",
            "UPDATE projection_baselines SET record=json_set(record,'$.state.deleted',json('true'))",
            "UPDATE projection_baselines SET record=json_set(record,'$.state.kind','folder')",
            "UPDATE projection_baselines SET record=json_set(record,'$.content.content',json('[256]'))",
            "UPDATE projection_baselines SET record=json_set(record,'$.content.content',json('[-1]'))",
            "UPDATE projection_baselines SET record=json_set(record,'$.content.content',json('[1.5]'))",
            "UPDATE projection_baselines SET record=json_set(record,'$.content.kind','unknown')",
            "UPDATE projection_baselines SET record=json_set(record,'$.content.unknown',1)",
            "UPDATE projection_baselines SET record=json_set(record,'$.unknown',1)",
        ] {
            let (_dir, store, binding) = setup(EntryKind::File);
            put_binding(&store.connection, &binding).unwrap();
            store.connection.execute(sql, []).unwrap();
            let before = store.connection.total_changes();
            assert!(store.physical_binding(&binding.state.id).is_err(), "point: {sql}");
            assert!(store.physical_bindings().is_err(), "inventory: {sql}");
            assert_eq!(store.connection.total_changes(), before);
        }
    }

    #[test]
    fn binding_inventory_preserves_directory_baseline_identity_and_shape_checks() {
        for sql in [
            "UPDATE directory_baselines SET record='invalid-json'",
            "DELETE FROM directory_baselines",
            "UPDATE directory_baselines SET record=json_set(record,'$.identity','different')",
            "UPDATE directory_baselines SET record=json_set(record,'$.state.id','different')",
            "UPDATE directory_baselines SET record=json_set(record,'$.state.path','different')",
            "UPDATE directory_baselines SET record=json_set(record,'$.state.deleted',json('true'))",
            "UPDATE directory_baselines SET record=json_set(record,'$.unknown',1)",
        ] {
            let (_dir, store, binding) = setup(EntryKind::Folder);
            put_binding(&store.connection, &binding).unwrap();
            store.connection.execute(sql, []).unwrap();
            assert!(
                store.physical_binding(&binding.state.id).is_err(),
                "point: {sql}"
            );
            assert!(store.physical_bindings().is_err(), "inventory: {sql}");
        }
    }

    #[test]
    fn binding_inventory_rejects_unrelated_bound_corruption_but_ignores_unbound_baselines() {
        let (_dir, mut store, selected) = setup(EntryKind::File);
        put_binding(&store.connection, &selected).unwrap();
        let unrelated = add_bound_file(&mut store, "unrelated", "different-inode");
        store
            .connection
            .execute(
                "UPDATE projection_baselines SET record='invalid-json' WHERE entry_id='unrelated'",
                [],
            )
            .unwrap();
        assert_eq!(
            store.physical_binding(&selected.state.id).unwrap(),
            Some(selected.clone())
        );
        assert!(store.physical_bindings().is_err());
        remove_binding(&store.connection, &unrelated.state.id).unwrap();
        assert_eq!(store.physical_bindings().unwrap(), vec![selected]);
    }

    #[test]
    fn binding_inventory_ignores_other_kind_baselines_and_current_logical_liveness() {
        for kind in [EntryKind::File, EntryKind::Folder] {
            let (_dir, store, binding) = setup(kind);
            put_binding(&store.connection, &binding).unwrap();
            let other = if kind == EntryKind::File {
                "directory_baselines"
            } else {
                "projection_baselines"
            };
            store
                .connection
                .execute(
                    &format!("INSERT INTO {other}(entry_id,record) VALUES('entry','invalid-json')"),
                    [],
                )
                .unwrap();
            for sql in [
                "UPDATE entries SET visible=0 WHERE id='entry'",
                "UPDATE entries SET deleted=1 WHERE id='entry'",
            ] {
                store.connection.execute(sql, []).unwrap();
                assert_eq!(store.physical_bindings().unwrap(), vec![binding.clone()]);
            }
        }
    }

    #[test]
    fn inode_lookup_reads_only_selected_baseline_and_no_catalogue() {
        for kind in [EntryKind::File, EntryKind::Folder] {
            let (_dir, mut store, selected) = setup(kind);
            put_binding(&store.connection, &selected).unwrap();
            add_bound_file(&mut store, "unrelated", "different-inode");
            store.connection.execute("UPDATE projection_baselines SET record='invalid-json' WHERE entry_id='unrelated'", []).unwrap();
            assert!(store.physical_bindings().is_err()); // Previous native guard decodes this row.
            let before = store.connection.total_changes();
            let trace = InodeReads::new(&store.connection);
            assert_eq!(store.physical_owner_by_inode("absent").unwrap(), None);
            assert_eq!(trace.counts.get(), [0, 0, 0]);
            assert_eq!(
                store
                    .physical_owner_by_inode(&selected.physical.inode)
                    .unwrap(),
                Some(selected)
            );
            assert_eq!(
                trace.counts.get(),
                if kind == EntryKind::File {
                    [1, 0, 0]
                } else {
                    [0, 1, 0]
                }
            );
            assert_eq!(store.connection.total_changes(), before);
        }
    }

    #[test]
    fn inode_lookup_selected_corruption_and_ambiguity_fail_closed() {
        for sql in [
            "UPDATE physical_bindings SET record='invalid-json'",
            "UPDATE physical_bindings SET path='different'",
            "UPDATE physical_bindings SET revision='different'",
            "UPDATE physical_bindings SET kind='directory'",
            "UPDATE physical_bindings SET parent_inode='different'",
            "UPDATE physical_bindings SET record=json_set(record,'$.physical.inode','different')",
            "UPDATE projection_baselines SET record='invalid-json'",
        ] {
            let (_dir, store, value) = setup(EntryKind::File);
            put_binding(&store.connection, &value).unwrap();
            store.connection.execute(sql, []).unwrap();
            let before = store.connection.total_changes();
            assert!(
                store
                    .physical_owner_by_inode(&value.physical.inode)
                    .is_err(),
                "{sql}"
            );
            assert_eq!(store.connection.total_changes(), before);
        }
        let (_dir, mut store, value) = setup(EntryKind::File);
        put_binding(&store.connection, &value).unwrap();
        add_bound_file(&mut store, "duplicate", &value.physical.inode);
        assert!(
            matches!(store.physical_owner_by_inode(&value.physical.inode),
            Err(StoreError::Corrupt(message)) if message == "multiple physical owners of one inode")
        );
        for inode in ["", &"x".repeat(129)] {
            assert!(store.physical_owner_by_inode(inode).is_err());
        }
    }

    #[test]
    fn inode_lookup_retains_hidden_deleted_and_stale_logical_owners() {
        for change in [
            "UPDATE entries SET visible=0 WHERE id='entry'",
            "UPDATE entries SET deleted=1 WHERE id='entry'",
        ] {
            let (_dir, store, value) = setup(EntryKind::File);
            put_binding(&store.connection, &value).unwrap();
            store.connection.execute(change, []).unwrap();
            assert_eq!(
                store
                    .physical_owner_by_inode(&value.physical.inode)
                    .unwrap(),
                Some(value)
            );
        }
        let (_dir, mut store, value) = setup(EntryKind::File);
        put_binding(&store.connection, &value).unwrap();
        store
            .apply(&MutationRequest {
                operation_id: op("later-write"),
                mutation: Mutation::Write {
                    id: value.state.id.clone(),
                    expected: value.state.revision.clone(),
                    content: b"new logical bytes".to_vec(),
                },
            })
            .unwrap();
        assert_eq!(
            store
                .physical_owner_by_inode(&value.physical.inode)
                .unwrap(),
            Some(value)
        );
    }
}

#[cfg(test)]
mod rebaseline_epoch_tests {
    use super::*;
    use zorid_core::VaultPath;
    fn epoch(store: &Store) -> IdleRebaselineEpoch {
        idle_rebaseline_epoch(&store.connection, store.external_checkpoint_changes.get()).unwrap()
    }
    fn checkpoint(
        store: &mut Store,
        next: &str,
        expected: Option<&str>,
    ) -> std::result::Result<crate::Checkpoint, crate::CheckpointError> {
        let scope = crate::CheckpointScope {
            vault_id: store.identity().unwrap().local_store_id,
            client_id: OperationId::new("c4ffd451-ce1c-4d98-a839-e91974dfd7d8").unwrap(),
        };
        store.checkpoint_compare_and_swap(
            &scope,
            crate::CheckpointWrite {
                key: "draft",
                expected_revision: expected,
                next_revision: next,
                encoded_state: Some("{\"draft\":true}"),
            },
        )
    }
    #[test]
    fn checkpoint_actual_delta_credit_preserves_epoch_across_retry_conflict_abort_and_rollback() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path().join("vault.sqlite")).unwrap();
        let initial = epoch(&store);
        checkpoint(&mut store, "d94e7514-3be0-45d5-8093-000000000001", None).unwrap();
        assert_eq!(epoch(&store), initial);
        checkpoint(&mut store, "d94e7514-3be0-45d5-8093-000000000001", None).unwrap();
        assert_eq!(
            epoch(&store),
            initial,
            "idempotent same-key retry credits zero changes"
        );
        assert!(checkpoint(&mut store, "d94e7514-3be0-45d5-8093-000000000002", None).is_err());
        assert_eq!(epoch(&store), initial);
        store.connection.execute_batch("CREATE TEMP TRIGGER checkpoint_abort BEFORE UPDATE ON main.checkpoint_heads BEGIN SELECT RAISE(ABORT,'checkpoint test abort'); END;").unwrap();
        let before_abort = epoch(&store);
        assert!(checkpoint(&mut store, "d94e7514-3be0-45d5-8093-000000000003", Some("d94e7514-3be0-45d5-8093-000000000001")).is_err());
        assert_eq!(
            epoch(&store),
            before_abort,
            "credit completed total delta only after rollback"
        );
        store
            .connection
            .execute_batch("DROP TRIGGER checkpoint_abort;")
            .unwrap();
        let before_write = epoch(&store);
        store
            .apply(&MutationRequest {
                operation_id: OperationId::new("after-aborted-checkpoint").unwrap(),
                mutation: Mutation::Create {
                    id: EntryId::new("authority-entry").unwrap(),
                    path: VaultPath::new("Authority.md").unwrap(),
                    kind: EntryKind::File,
                    content: Some(b"authoritative".to_vec()),
                },
            })
            .unwrap();
        assert!(
            epoch(&store).relevant_changes > before_write.relevant_changes,
            "later authority writes cannot cancel an ignored failure"
        );
        assert_ne!(epoch(&store), initial);
    }
    #[test]
    fn epoch_is_pinned_before_schema_validation_can_race_with_foreign_trigger_creation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("vault.sqlite");
        let mut store = Store::open(&path).unwrap();
        let id = EntryId::new("schema-race-file").unwrap();
        store.apply(&MutationRequest { operation_id: OperationId::new("schema-race-create").unwrap(), mutation: Mutation::Create { id: id.clone(), path: VaultPath::new("Race.md").unwrap(), kind: EntryKind::File, content: Some(b"stable".to_vec()) } }).unwrap();
        let state = store.read(&id).unwrap().unwrap().state;
        projection::put_baseline(&store.connection, &ProjectionBaseline { state: state.clone(), content: StoredContent::InlineBytes(b"stable".to_vec()) }).unwrap();
        put_binding(&store.connection, &PhysicalBinding { state, physical: PhysicalIdentity { inode: "1:2".into(), parent_inode: "1:3".into() } }).unwrap();
        for job in crate::projection_jobs::pending(&store.connection, &id, ProjectionWork::MaterializeFile).unwrap() { crate::projection_jobs::finish(&store.connection, &job).unwrap(); }
        REBASELINE_AFTER_SCHEMA.with(|point| *point.borrow_mut() = Some(Box::new(move || {
            let foreign = Connection::open(path).unwrap();
            foreign.execute_batch("CREATE TRIGGER foreign_checkpoint_write AFTER INSERT ON checkpoint_heads BEGIN UPDATE entries SET path=path; END;").unwrap();
        })));
        let prepared = store.begin_idle_rebaseline(store.physical_binding_metadata().unwrap()).unwrap();
        assert!(prepared.is_none(), "a schema checked before a foreign commit cannot authorize the new epoch");
    }
    #[test]
    fn unknown_writes_ddl_and_credit_overflow_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path().join("vault.sqlite")).unwrap();
        let first = epoch(&store);
        store.connection.execute_batch("CREATE TEMP TABLE unknown_work(value INTEGER); INSERT INTO unknown_work VALUES(1);").unwrap();
        assert_ne!(epoch(&store), first);
        let second = epoch(&store);
        store
            .connection
            .execute_batch("DELETE FROM unknown_work;")
            .unwrap();
        assert!(
            epoch(&store).relevant_changes > second.relevant_changes,
            "truncate optimization remains an unknown write"
        );
        store.external_checkpoint_changes.set(Some(u64::MAX));
        checkpoint(&mut store, "d94e7514-3be0-45d5-8093-000000000004", None).unwrap();
        assert!(store.external_checkpoint_changes.get().is_none());
        assert!(
            idle_rebaseline_epoch(&store.connection, store.external_checkpoint_changes.get())
                .is_err()
        );
    }
}
