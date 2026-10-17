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
pub(super) fn observation(tx: &Connection, id: &OperationId) -> Result<ExternalObservation> {
    let raw: String = tx.query_row(
        "SELECT record FROM external_observations WHERE observation_id=?1",
        [id.as_str()],
        |r| r.get(0),
    )?;
    let value = projection::decode_observation(id.as_str(), &raw)?;
    if value.baseline.is_some() || value.content.len() > FAMILY_MAX_FILE_BYTES {
        return Err(invalid(
            "new family observation has a baseline or exceeds limit",
        ));
    }
    Ok(value)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "intent",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ExternalCreateIntent {
    Inline(FamilyCommand),
    BinaryCapture {
        observation_id: OperationId,
        entry_id: EntryId,
        path: VaultPath,
        capture: CapturedBinaryRef,
    },
}
pub(super) fn validate_intent(
    intent: &ExternalCreateIntent,
    observation: &ExternalObservation,
) -> Result<()> {
    match intent {
        ExternalCreateIntent::Inline(command) => {
            let Mutation::Create {
                path,
                kind,
                content,
                ..
            } = &command.request.mutation
            else {
                return Err(invalid("external create intent is not Create"));
            };
            let bytes = observation
                .content
                .inline_bytes()
                .ok_or_else(|| invalid("inline create has referenced observation"))?;
            if command.request.operation_id != observation.observation_id
                || path != &observation.path
                || match kind {
                    EntryKind::File => {
                        content.as_deref() != Some(bytes)
                            || command.create_mode != Some(FamilyCreateMode::Text)
                    }
                    EntryKind::Folder => {
                        content.is_some() || !bytes.is_empty() || command.create_mode.is_some()
                    }
                }
            {
                return Err(invalid("external create intent differs from observation"));
            }
        }
        ExternalCreateIntent::BinaryCapture {
            observation_id,
            path,
            capture,
            ..
        } => {
            if observation_id != &observation.observation_id
                || path != &observation.path
                || &capture.stage.operation_id != observation_id
                || observation.content
                    != StoredContent::BinaryRef(BinarySourceRef::Capture(capture.clone()))
            {
                return Err(invalid("binary create intent differs from observation"));
            }
        }
    }
    Ok(())
}
pub(super) fn intent(tx: &Connection, id: &OperationId) -> Result<Option<ExternalCreateIntent>> {
    tx.query_row(
        "SELECT command FROM family_external_creates WHERE observation_id=?1",
        [id.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
    .transpose()
}
pub(super) fn proof(tx: &Connection, id: &OperationId) -> Result<ObservationPhysical> {
    let proof = physical_bindings::observation_proof(tx, id)?
        .ok_or_else(|| invalid("new family entry lacks observation proof"))?;
    if proof.expected_binding.is_some() {
        return Err(invalid("new family entry already has physical authority"));
    }
    Ok(proof)
}
pub(super) fn unowned_path(
    tx: &Connection,
    path: &VaultPath,
    physical: &PhysicalIdentity,
) -> Result<()> {
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
    /// Persist the original identity and explicit mode once, before import.
    pub fn prepare_family_external_create(
        &mut self,
        id: &OperationId,
        kind: EntryKind,
        mode: Option<FamilyCreateMode>,
    ) -> Result<ExternalCreateIntent> {
        self.prepare_family_external_create_inner(None, id, kind, mode)
    }
    pub fn prepare_family_external_create_content(
        &mut self,
        client: &OperationId,
        id: &OperationId,
        kind: EntryKind,
        mode: Option<FamilyCreateMode>,
    ) -> Result<ExternalCreateIntent> {
        self.prepare_family_external_create_inner(Some(client), id, kind, mode)
    }
    fn prepare_family_external_create_inner(
        &mut self,
        client: Option<&OperationId>,
        id: &OperationId,
        kind: EntryKind,
        mode: Option<FamilyCreateMode>,
    ) -> Result<ExternalCreateIntent> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let observation = observation(&tx, id)?;
        let prior_intent = intent(&tx, id)?;
        if let Some(intent) = &prior_intent {
            validate_intent(intent, &observation)?;
            let same = match intent {
                ExternalCreateIntent::Inline(command) => {
                    command.create_mode == mode
                        && matches!(&command.request.mutation,Mutation::Create{kind:saved,..} if *saved==kind)
                }
                ExternalCreateIntent::BinaryCapture { .. } => {
                    kind == EntryKind::File && mode == Some(FamilyCreateMode::Binary)
                }
            };
            if !same {
                return Err(invalid("external create retry changed kind or mode"));
            }
            // Native retries prepare then import. Once resolved, replay the
            // immutable intent before touching today's source or physical rows.
            if capture_authorization::replay_resolved(&tx, &observation)?.is_some() {
                let intent = intent.clone();
                tx.commit()?;
                return Ok(intent);
            }
        }
        proof(&tx, id)?;
        if let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = &observation.content {
            if client != Some(&capture.stage.client_id) {
                return Err(invalid("binary Create lacks independent client admission"));
            }
            entry_content::validate_captured_at(&tx, capture, &observation.path)?;
        }
        if let Some(intent) = prior_intent {
            tx.commit()?;
            return Ok(intent);
        }
        let count: i64 =
            tx.query_row("SELECT count(*) FROM family_graph_heads", [], |r| r.get(0))?;
        if count != 1 || observation.resolution.is_some() {
            return Err(invalid(
                "new family create requires unresolved enrolled observation",
            ));
        }
        let entry_id = EntryId::new(uuid::Uuid::new_v4().to_string())?;
        let intent = if kind == EntryKind::File && mode == Some(FamilyCreateMode::Binary) {
            let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = &observation.content
            else {
                return Err(invalid("binary external create requires a sealed capture"));
            };
            ExternalCreateIntent::BinaryCapture {
                observation_id: id.clone(),
                entry_id,
                path: observation.path.clone(),
                capture: capture.clone(),
            }
        } else {
            let bytes = observation
                .content
                .inline_bytes()
                .ok_or_else(|| invalid("text/folder create requires bounded inline observation"))?;
            if bytes.len() as u64 > FAMILY_MAX_INLINE_BYTES {
                return Err(zorid_client_sync::SyncError::TooLarge.into());
            }
            ExternalCreateIntent::Inline(
                FamilyCommand::new(
                    MutationRequest {
                        operation_id: id.clone(),
                        mutation: Mutation::Create {
                            id: entry_id,
                            path: observation.path.clone(),
                            kind,
                            content: if kind == EntryKind::File {
                                Some(bytes.to_vec())
                            } else {
                                None
                            },
                        },
                    },
                    mode,
                )
                .map_err(family_commands::mapped)?,
            )
        };
        validate_intent(&intent, &observation)?;
        tx.execute(
            "INSERT INTO family_external_creates(observation_id,command) VALUES(?1,?2)",
            params![id.as_str(), serde_json::to_string(&intent)?],
        )?;
        tx.commit()?;
        Ok(intent)
    }
    pub fn import_family_external_create(&mut self, id: &OperationId) -> Result<CommitResult> {
        self.import_family_external_create_inner(None, id)
    }
    pub fn import_family_external_create_content(
        &mut self,
        client: &OperationId,
        id: &OperationId,
    ) -> Result<CommitResult> {
        self.import_family_external_create_inner(Some(client), id)
    }
    fn import_family_external_create_inner(
        &mut self,
        client: Option<&OperationId>,
        id: &OperationId,
    ) -> Result<CommitResult> {
        let tx = self.connection.unchecked_transaction()?;
        let mut observed = observation(&tx, id)?;
        let intent = intent(&tx, id)?.ok_or_else(|| invalid("external create was not prepared"))?;
        validate_intent(&intent, &observed)?;
        if let Some(receipt) = super::capture_authorization::replay_resolved(&tx, &observed)? {
            tx.commit()?;
            return Ok(receipt);
        }
        if matches!(intent, ExternalCreateIntent::BinaryCapture { .. }) {
            let authorization =
                super::capture_authorization::CaptureImportAuthorization::for_create(
                    &tx,
                    client.ok_or_else(|| {
                        invalid("binary Create import lacks independent client admission")
                    })?,
                    id,
                )?;
            tx.commit()?;
            return Ok(binary_commit::commit_external_binary(self, authorization)?.receipt);
        }
        let ExternalCreateIntent::Inline(command) = &intent else {
            unreachable!()
        };
        let Mutation::Create {
            id: entry_id, kind, ..
        } = &command.request.mutation
        else {
            unreachable!()
        };
        let proof = proof(&tx, id)?;
        unowned_path(&tx, &observed.path, &proof.physical)?;
        physical_bindings::check_binding(&tx, entry_id, None)?;
        let prepared =
            family_commands::prepare_command(&tx, &command.request, command.create_mode)?;
        tx.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) =
            super::capture_authorization::replay_resolved(&tx, &observation(&tx, id)?)?
        {
            tx.commit()?;
            return Ok(receipt);
        }
        if observation(&tx, id)? != observed
            || self::intent(&tx, id)?.as_ref() != Some(&intent)
            || self::proof(&tx, id)? != proof
        {
            return Err(invalid("external Create physical or intent CAS changed"));
        }
        physical_bindings::check_binding(&tx, entry_id, None)?;
        unowned_path(&tx, &observed.path, &proof.physical)?;
        let receipt = family_commands::commit_prepared(&tx, &prepared)?;
        let state = receipt
            .changes
            .iter()
            .find(|c| c.after.id == *entry_id)
            .ok_or_else(|| invalid("external Create receipt lacks target"))?
            .after
            .clone();
        if state.path != observed.path || state.kind != *kind || state.deleted {
            return Err(invalid("external Create receipt target differs"));
        }
        family_materialization::check_publication_content(
            &tx,
            &state,
            (*kind == EntryKind::File).then_some(&observed.content),
        )?;
        match kind {
            EntryKind::File => projection::put_baseline(
                &tx,
                &ProjectionBaseline {
                    state: state.clone(),
                    content: observed.content.clone(),
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
                state,
                physical: proof.physical,
            },
        )?;
        projection_jobs::retire_local(&tx, id)?;
        observed.resolution = Some(id.clone());
        tx.execute(
            "UPDATE external_observations SET record=?1 WHERE observation_id=?2",
            params![serde_json::to_string(&observed)?, id.as_str()],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}
