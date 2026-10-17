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
pub(super) fn binding(tx: &Connection, id: &EntryId) -> Result<Option<PhysicalBinding>> {
    let row: Option<(String, String, String, String, String, String)> = tx.query_row(
        "SELECT path,revision,kind,inode,parent_inode,record FROM physical_bindings WHERE entry_id=?1",
        [id.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)),
    ).optional()?;
    row.map(|(path, revision, kind, inode, parent, json)| {
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
impl Store {
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
}
