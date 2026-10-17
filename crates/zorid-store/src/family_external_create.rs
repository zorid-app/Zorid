//! New external entries reuse persisted observations and physical proofs. A small
//! linked intent freezes Create identity/mode before causal authoring begins.
use super::*;
use zorid_core::{OperationId, VaultPath};
use zorid_file_sync::mutation::FamilyCommand;

pub(super) const SCHEMA: &[(&str, &str)] = &[
    ("family_external_creates", "CREATE TABLE family_external_creates (observation_id TEXT PRIMARY KEY NOT NULL REFERENCES external_observations(observation_id), command TEXT NOT NULL)"),
];
fn invalid(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}
fn observation(tx: &Connection, id: &OperationId) -> Result<ExternalObservation> {
    let raw: String = tx.query_row(
        "SELECT record FROM external_observations WHERE observation_id=?1",
        [id.as_str()],
        |r| r.get(0),
    )?;
    let value = projection::decode_observation(id.as_str(), &raw)?;
    if value.baseline.is_some() || value.content.len() as u64 > FAMILY_MAX_FILE_BYTES {
        return Err(invalid(
            "new family observation has a baseline or exceeds limit",
        ));
    }
    Ok(value)
}
fn validate_command(command: &FamilyCommand, observation: &ExternalObservation) -> Result<()> {
    let Mutation::Create {
        path,
        kind,
        content,
        ..
    } = &command.request.mutation
    else {
        return Err(invalid("external create intent is not Create"));
    };
    if command.request.operation_id != observation.observation_id
        || path != &observation.path
        || match kind {
            EntryKind::File => {
                content.as_ref() != Some(&observation.content) || command.create_mode.is_none()
            }
            EntryKind::Folder => {
                content.is_some()
                    || !observation.content.is_empty()
                    || command.create_mode.is_some()
            }
        }
    {
        return Err(invalid("external create intent differs from observation"));
    }
    Ok(())
}
fn intent(tx: &Connection, id: &OperationId) -> Result<Option<FamilyCommand>> {
    tx.query_row(
        "SELECT command FROM family_external_creates WHERE observation_id=?1",
        [id.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
    .transpose()
}
fn proof(tx: &Connection, id: &OperationId) -> Result<ObservationPhysical> {
    let proof = physical_bindings::observation_proof(tx, id)?
        .ok_or_else(|| invalid("new family entry lacks observation proof"))?;
    if proof.expected_binding.is_some() {
        return Err(invalid("new family entry already has physical authority"));
    }
    Ok(proof)
}
fn unowned_path(tx: &Connection, path: &VaultPath, physical: &PhysicalIdentity) -> Result<()> {
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM physical_bindings WHERE path=?1 OR inode=?2)",
        params![path.as_str(), physical.inode],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(invalid(
            "external create path or inode has retained physical owner",
        ));
    }
    if let Some(parent) = path.parent() {
        let row: Option<String> = tx
            .query_row(
                "SELECT entry_id FROM physical_bindings WHERE path=?1",
                [parent.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let binding = row
            .map(EntryId::new)
            .transpose()?
            .map(|id| physical_bindings::binding(tx, &id))
            .transpose()?
            .flatten()
            .ok_or_else(|| invalid("external create parent lacks physical authority"))?;
        if binding.state.kind != EntryKind::Folder
            || binding.physical.inode != physical.parent_inode
            || !is_visible(tx, &binding.state.id)?
        {
            return Err(invalid("external create parent binding changed"));
        }
    }
    Ok(())
}
impl Store {
    /// Prepare once before import. Retries must retain the exact explicit mode;
    /// changing it is rejected without reallocating the saved entry identity.
    pub fn prepare_family_external_create(
        &mut self,
        id: &OperationId,
        kind: EntryKind,
        mode: Option<FamilyCreateMode>,
    ) -> Result<FamilyCommand> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let observation = observation(&tx, id)?;
        proof(&tx, id)?;
        if let Some(command) = intent(&tx, id)? {
            validate_command(&command, &observation)?;
            if command.create_mode != mode
                || !matches!(&command.request.mutation,Mutation::Create{kind:saved,..} if *saved==kind)
            {
                return Err(invalid("external create retry changed kind or mode"));
            }
            tx.commit()?;
            return Ok(command);
        }
        let count: i64 =
            tx.query_row("SELECT count(*) FROM family_graph_heads", [], |r| r.get(0))?;
        if count != 1 || observation.resolution.is_some() {
            return Err(invalid(
                "new family create requires unresolved enrolled observation",
            ));
        }
        let command = FamilyCommand::new(
            MutationRequest {
                operation_id: id.clone(),
                mutation: Mutation::Create {
                    id: EntryId::new(uuid::Uuid::new_v4().to_string())?,
                    path: observation.path.clone(),
                    kind,
                    content: if kind == EntryKind::File {
                        Some(observation.content.clone())
                    } else {
                        None
                    },
                },
            },
            mode,
        )
        .map_err(family_commands::mapped)?;
        validate_command(&command, &observation)?;
        tx.execute(
            "INSERT INTO family_external_creates(observation_id,command) VALUES(?1,?2)",
            params![id.as_str(), serde_json::to_string(&command)?],
        )?;
        tx.commit()?;
        Ok(command)
    }
    /// Commit causal Create, exact physical publication, receipt and observation
    /// resolution together. Native must recheck the saved inode/parent/content.
    pub fn import_family_external_create(&mut self, id: &OperationId) -> Result<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut observation = observation(&tx, id)?;
        let command =
            intent(&tx, id)?.ok_or_else(|| invalid("external create was not prepared"))?;
        validate_command(&command, &observation)?;
        let Mutation::Create {
            id: entry_id, kind, ..
        } = &command.request.mutation
        else {
            unreachable!()
        };
        if let Some(resolution) = &observation.resolution {
            if resolution != id {
                return Err(invalid("external create resolution differs"));
            }
            let recorded: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM operations JOIN family_commands USING(operation_id) WHERE operation_id=?1)",
                [id.as_str()], |r|r.get(0),
            )?;
            if !recorded {
                return Err(invalid(
                    "resolved external Create has no exact family receipt",
                ));
            }
            let receipt =
                family_commands::apply_transaction(&tx, &command.request, command.create_mode)?;
            tx.commit()?;
            return Ok(receipt);
        }
        let proof = proof(&tx, id)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1) OR EXISTS(SELECT 1 FROM operations WHERE operation_id=?2)", params![entry_id.as_str(),id.as_str()], |r|r.get::<_,bool>(0))? {
            return Err(invalid("unresolved external Create already has logical identity"));
        }
        physical_bindings::check_binding(&tx, entry_id, None)?;
        unowned_path(&tx, &observation.path, &proof.physical)?;
        let receipt =
            family_commands::apply_transaction(&tx, &command.request, command.create_mode)?;
        let state = receipt
            .changes
            .iter()
            .find(|c| c.after.id == *entry_id)
            .ok_or_else(|| invalid("external Create receipt lacks entry"))?
            .after
            .clone();
        if state.path != observation.path || state.kind != *kind || state.deleted {
            return Err(invalid("external Create receipt target differs"));
        }
        let content = (*kind == EntryKind::File).then_some(observation.content.as_slice());
        family_materialization::check_publication(&tx, &state, content)?;
        match kind {
            EntryKind::File => projection::put_baseline(
                &tx,
                &ProjectionBaseline {
                    state: state.clone(),
                    content: observation.content.clone(),
                },
            )?,
            EntryKind::Folder => directory::put_baseline(
                &tx,
                &DirectoryBaseline {
                    state: state.clone(),
                    identity: proof.physical.inode.clone(),
                },
            )?,
        }
        physical_bindings::put_binding(
            &tx,
            &PhysicalBinding {
                state: state.clone(),
                physical: proof.physical,
            },
        )?;
        let work = if *kind == EntryKind::File {
            ProjectionWork::MaterializeFile
        } else {
            ProjectionWork::CreateDirectory
        };
        let jobs = projection_jobs::pending(&tx, entry_id, work)?;
        if jobs.len() != 1 {
            return Err(invalid(
                "external Create lacks its exact publication obligation",
            ));
        }
        for job in jobs {
            if !matches!(&job.origin,ProjectionOrigin::LocalCommand{operation_id} if operation_id==id)
                || job.target != state
                || job.affected.len() != 1
                || job.affected[0].after != state
            {
                return Err(invalid("external Create publication obligation differs"));
            }
            projection_jobs::finish(&tx, &job)?;
        }
        observation.resolution = Some(id.clone());
        tx.execute(
            "UPDATE external_observations SET record=?1 WHERE observation_id=?2",
            params![serde_json::to_string(&observation)?, id.as_str()],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}
