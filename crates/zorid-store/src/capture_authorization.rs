//! Private physical import authorization. A retained capture locator is inert;
//! only an exact saved public-path observation and its historical physical cut
//! can issue this capability. It is never deserialized from caller input.
use super::*;
use crate::blob_stage::{BinaryStageRef, StagePurpose};
use crate::family_external_create::ExternalCreateIntent;
use zorid_core::OperationId;
use zorid_file_sync::materialization::ContentWitness;

pub(super) struct CaptureImportAuthorization {
    stage: BinaryStageRef,
    admitted_client: OperationId,
    request: BinaryStageRequest,
    observation: ExternalObservation,
    proof: ObservationPhysical,
    create: Option<ExternalCreateIntent>,
}
fn invalid(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}
fn observation(tx: &Connection, id: &OperationId) -> Result<ExternalObservation> {
    let raw: String = tx.query_row(
        "SELECT record FROM external_observations WHERE observation_id=?1",
        [id.as_str()],
        |r| r.get(0),
    )?;
    projection::decode_observation(id.as_str(), &raw)
}
/// Replay the original committed observation before consulting today's graph,
/// target or capture backing rows. The durable operation and observation are the
/// immutable authority for an unknown commit result.
pub(super) fn replay_resolved(
    tx: &Connection,
    observed: &ExternalObservation,
) -> Result<Option<CommitResult>> {
    let Some(resolution) = &observed.resolution else {
        return Ok(None);
    };
    if resolution != &observed.observation_id {
        return Err(invalid("external resolution identity differs"));
    }
    let (raw, result): (String, String) = tx.query_row(
        "SELECT request,result FROM operations WHERE operation_id=?1",
        [resolution.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let recorded = operation_request::decode_record(&raw, &result, resolution)?;
    match (&observed.content, &recorded.request) {
        (
            StoredContent::BinaryRef(BinarySourceRef::Capture(capture)),
            OperationRequest::BinaryRef(request),
        ) => {
            if request.stage != capture.stage
                || request.manifest != capture.manifest
                || request.source_commitment != capture.source_commitment
            {
                return Err(invalid(
                    "external binary receipt differs from original capture",
                ));
            }
            match (&observed.baseline, &request.request.target) {
                (Some(base), BinaryTarget::Write { id, .. }) if id == &base.state.id => {}
                (None, BinaryTarget::Create { id, path }) => {
                    let intent = family_external_create::intent(tx, resolution)?
                        .ok_or_else(|| invalid("resolved binary Create lacks intent"))?;
                    family_external_create::validate_intent(&intent, observed)?;
                    if !matches!(intent,ExternalCreateIntent::BinaryCapture{entry_id,path:original,..} if entry_id==*id && original==*path)
                    {
                        return Err(invalid("external binary receipt target differs"));
                    }
                }
                _ => return Err(invalid("external binary receipt target kind differs")),
            }
        }
        (StoredContent::InlineBytes(_), OperationRequest::Inline(request)) => {
            let composite: String = tx.query_row(
                "SELECT command FROM family_commands WHERE operation_id=?1",
                [resolution.as_str()],
                |r| r.get(0),
            )?;
            let command: zorid_file_sync::mutation::FamilyCommand =
                serde_json::from_str(&composite)?;
            if &command.request != request {
                return Err(invalid("external inline receipt composite differs"));
            }
            if let Some(base) = &observed.baseline {
                if command.create_mode.is_some()
                    || !matches!(&request.mutation,Mutation::Write{id,..} if id==&base.state.id)
                {
                    return Err(invalid("external inline receipt target differs"));
                }
            } else {
                let intent = family_external_create::intent(tx, resolution)?
                    .ok_or_else(|| invalid("resolved Create lacks intent"))?;
                family_external_create::validate_intent(&intent, observed)?;
                if intent != ExternalCreateIntent::Inline(command) {
                    return Err(invalid("external Create receipt intent differs"));
                }
            }
        }
        _ => return Err(invalid("external receipt content authority differs")),
    }
    Ok(Some(recorded.result))
}
impl CaptureImportAuthorization {
    pub(super) fn stage(&self) -> &BinaryStageRef {
        &self.stage
    }
    pub(super) fn request(&self) -> &BinaryStageRequest {
        &self.request
    }
    pub(super) fn for_create(
        tx: &Connection,
        client: &OperationId,
        id: &OperationId,
    ) -> Result<Self> {
        let observed = family_external_create::observation(tx, id)?;
        let intent = family_external_create::intent(tx, id)?
            .ok_or_else(|| invalid("binary Create was not prepared"))?;
        family_external_create::validate_intent(&intent, &observed)?;
        let ExternalCreateIntent::BinaryCapture { entry_id, path, .. } = &intent else {
            return Err(invalid("Create is not a binary capture"));
        };
        let request = BinaryStageRequest {
            target: BinaryTarget::Create {
                id: entry_id.clone(),
                path: path.clone(),
            },
            expected_length: Some(observed.content.len()),
        };
        Self::issue(tx, client, observed, request, Some(intent))
    }
    pub(super) fn for_observation(
        tx: &Connection,
        client: &OperationId,
        id: &OperationId,
    ) -> Result<Self> {
        let observed = observation(tx, id)?;
        let base = observed
            .baseline
            .as_ref()
            .ok_or_else(|| invalid("binary Write lacks physical baseline"))?;
        let entry = read_states(tx, true)?
            .into_iter()
            .find(|e| e.id == base.state.id)
            .ok_or_else(|| invalid("binary Write target is not visible"))?;
        let current = family_materialization::get(tx, &entry.id)?
            .ok_or_else(|| invalid("binary Write lacks materialization"))?;
        let historical = family_materialization::history(tx, &entry.id, &base.state.revision)?
            .ok_or_else(|| invalid("binary physical history missing"))?;
        // A remote binary head cannot be replaced by an unseen stale disk edit.
        // A pure physical Move revision may alias only the identical causal cut.
        if entry != base.state {
            let mut same = base.state.clone();
            same.revision = entry.revision.clone();
            if entry != same || current != historical {
                return Err(ContractError::RevisionConflict {
                    id: entry.id.clone(),
                    expected: base.state.revision.clone(),
                    actual: entry.revision.clone(),
                }
                .into());
            }
        }
        if entry.kind != EntryKind::File
            || entry.path != observed.path
            || entry.path != base.state.path
            || entry.deleted
        {
            return Err(invalid("binary physical target differs"));
        }
        let Some(FamilyContentWitness {
            witness: ContentWitness::Binary { selected_event, .. },
            ..
        }) = &current.retained_content
        else {
            return Err(invalid(
                "binary Write target has no selected binary content",
            ));
        };
        let request = BinaryStageRequest {
            target: BinaryTarget::Write {
                id: entry.id,
                expected_revision: entry.revision,
                expected_content_event: selected_event.clone(),
            },
            expected_length: Some(observed.content.len()),
        };
        Self::issue(tx, client, observed, request, None)
    }
    fn issue(
        tx: &Connection,
        client: &OperationId,
        observed: ExternalObservation,
        request: BinaryStageRequest,
        create: Option<ExternalCreateIntent>,
    ) -> Result<Self> {
        let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = &observed.content else {
            return Err(invalid("binary import requires inert capture"));
        };
        if &capture.stage.client_id != client
            || capture.stage.operation_id != observed.observation_id
            || observed.resolution.is_some()
        {
            return Err(invalid(
                "binary capture operation differs or already resolved",
            ));
        }
        let stage = blob_stage::resolve_locator(tx, &capture.stage)?;
        let info = blob_stage::stage_info(tx, &stage)?;
        if !matches!(&info.purpose,StagePurpose::Capture(purpose) if purpose.path==observed.path && purpose.expected_length==capture.manifest.bytes && purpose.expected_digest==capture.manifest.digest)
            || info.phase != StagePhase::Sealed
            || info.manifest.as_ref() != Some(&capture.manifest)
            || info.source_commitment.as_ref() != Some(&capture.source_commitment)
        {
            return Err(invalid(
                "binary capture source differs from saved observation",
            ));
        }
        entry_content::validate_captured_at(tx, capture, &observed.path)?;
        let proof = physical_bindings::observation_proof(tx, &observed.observation_id)?
            .ok_or_else(|| {
                invalid("private retained capture has no public-path import permission")
            })?;
        let value = Self {
            stage,
            admitted_client: client.clone(),
            request,
            observation: observed,
            proof,
            create,
        };
        value.validate(tx)?;
        Ok(value)
    }
    pub(super) fn validate(&self, tx: &Connection) -> Result<()> {
        if observation(tx, &self.observation.observation_id)? != self.observation
            || physical_bindings::observation_proof(tx, &self.observation.observation_id)?.as_ref()
                != Some(&self.proof)
        {
            return Err(invalid(
                "binary import observation or physical proof changed",
            ));
        }
        if self.stage.client_id() != &self.admitted_client {
            return Err(invalid("capture client admission differs"));
        }
        let info = blob_stage::stage_info(tx, &self.stage)?;
        let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = &self.observation.content
        else {
            unreachable!()
        };
        if !matches!(&info.purpose,StagePurpose::Capture(purpose) if purpose.path==self.observation.path && purpose.expected_length==capture.manifest.bytes && purpose.expected_digest==capture.manifest.digest)
            || info.phase != StagePhase::Sealed
            || info.manifest.as_ref() != Some(&capture.manifest)
            || info.source_commitment.as_ref() != Some(&capture.source_commitment)
        {
            return Err(invalid("binary import source changed"));
        }
        entry_content::validate_captured_at(tx, capture, &self.observation.path)?;
        match (&self.observation.baseline, &self.request.target) {
            (
                Some(base),
                BinaryTarget::Write {
                    id,
                    expected_revision,
                    expected_content_event,
                },
            ) => {
                if projection::baseline(tx, id)?.as_ref() != Some(base)
                    || physical_bindings::check_observation(
                        tx,
                        &self.observation.observation_id,
                        id,
                    )?
                    .as_ref()
                        != Some(&self.proof)
                {
                    return Err(invalid("binary import physical baseline changed"));
                }
                family_materialization::check_publication_content(
                    tx,
                    &base.state,
                    Some(&base.content),
                )?;
                let current = read_states(tx, true)?
                    .into_iter()
                    .find(|e| &e.id == id)
                    .ok_or_else(|| invalid("binary import target disappeared"))?;
                if &current.revision != expected_revision || current.path != self.observation.path {
                    return Err(zorid_client_sync::SyncError::VersionConflict.into());
                }
                let witness = family_materialization::get(tx, id)?
                    .ok_or_else(|| invalid("binary import target witness missing"))?;
                let history = family_materialization::history(tx, id, &base.state.revision)?
                    .ok_or_else(|| invalid("binary import historical witness missing"))?;
                let mut alias = base.state.clone();
                alias.revision = current.revision.clone();
                if current != base.state && (current != alias || witness != history) {
                    return Err(zorid_client_sync::SyncError::VersionConflict.into());
                }
                if !matches!(witness.retained_content,Some(FamilyContentWitness{witness:ContentWitness::Binary{selected_event,..},..}) if &selected_event==expected_content_event)
                {
                    return Err(zorid_client_sync::SyncError::VersionConflict.into());
                }
                if tx.query_row("SELECT EXISTS(SELECT 1 FROM projection_attempts WHERE entry_id=?1 AND completed=0)",[id.as_str()],|r|r.get::<_,bool>(0))? {return Err(zorid_client_sync::SyncError::InvalidState.into());}
            }
            (None, BinaryTarget::Create { id, path }) => {
                if family_external_create::intent(tx, &self.observation.observation_id)?.as_ref()
                    != self.create.as_ref()
                    || self.proof.expected_binding.is_some()
                {
                    return Err(invalid("binary Create intent or physical owner changed"));
                }
                physical_bindings::check_binding(tx, id, None)?;
                family_external_create::unowned_path(tx, path, &self.proof.physical)?;
                if tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM entries WHERE id=?1)",
                    [id.as_str()],
                    |r| r.get::<_, bool>(0),
                )? {
                    return Err(invalid("binary Create identity already exists"));
                }
            }
            _ => return Err(invalid("binary import fixed target differs")),
        }
        Ok(())
    }
    pub(super) fn record_committed(&self, tx: &Connection, receipt: &CommitResult) -> Result<()> {
        if receipt.operation_id != self.observation.observation_id {
            return Err(invalid("binary import receipt identity differs"));
        }
        let id = match &self.request.target {
            BinaryTarget::Create { id, .. } | BinaryTarget::Write { id, .. } => id,
        };
        let state = receipt
            .changes
            .iter()
            .find(|c| &c.after.id == id)
            .ok_or_else(|| invalid("binary import receipt lacks target"))?
            .after
            .clone();
        if state.kind != EntryKind::File || state.path != self.observation.path || state.deleted {
            return Err(invalid(
                "binary import receipt differs from physical target",
            ));
        }
        let raw: String = tx.query_row(
            "SELECT content_ref FROM entries WHERE id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        let source: BinarySourceRef = serde_json::from_str(&raw)?;
        if !matches!(&source, BinarySourceRef::Graph(_))
            || source.len() != self.observation.content.len()
            || source.digest() != &self.observation.content.digest()
        {
            return Err(invalid(
                "binary import publication differs from captured bytes",
            ));
        }
        let content = StoredContent::BinaryRef(source);
        family_materialization::check_publication_content(tx, &state, Some(&content))?;
        projection::put_baseline(
            tx,
            &ProjectionBaseline {
                state: state.clone(),
                content,
            },
        )?;
        physical_bindings::put_observed_binding(tx, &state, Some(&self.proof))?;
        projection_jobs::retire_local(tx, &receipt.operation_id)?;
        let mut observed = self.observation.clone();
        observed.resolution = Some(receipt.operation_id.clone());
        tx.execute(
            "UPDATE external_observations SET record=?1 WHERE observation_id=?2",
            params![
                serde_json::to_string(&observed)?,
                observed.observation_id.as_str()
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::VaultPath;
    use zorid_file_sync::Sha256Digest;
    use zorid_sync_protocol::{RealmId, VaultId};
    fn op(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn fixture(public: bool) -> (tempfile::TempDir, Store, OperationId, ExternalObservation) {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("store.sqlite")).unwrap();
        store
            .family_enroll(&FamilyScope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        let client = op("capture-client");
        let path = VaultPath::new("captured.bin").unwrap();
        let stage = store
            .begin_binary_capture(
                &client,
                &op("capture-operation"),
                &BinaryCaptureRequest {
                    path: path.clone(),
                    expected_length: 0,
                    expected_digest: Sha256Digest::of(&[]),
                },
                StreamingLimits {
                    max_active_stages: 2,
                    max_stage_records: 4,
                    max_staged_bytes: 1024 * 1024,
                    max_chunk_records: 8,
                    max_page_records: 4,
                },
            )
            .unwrap();
        store.seal_binary_stage(&stage, 0, None).unwrap();
        let content = StoredContent::BinaryRef(BinarySourceRef::Capture(
            store.captured_binary_ref(&stage).unwrap(),
        ));
        let proof = public.then_some(ObservationPhysical {
            physical: PhysicalIdentity {
                inode: "public-inode".into(),
                parent_inode: "root-inode".into(),
            },
            expected_binding: None,
        });
        let observed = store
            .retain_external_content(&client, &path, None, &content, proof.as_ref())
            .unwrap();
        (directory, store, client, observed)
    }
    #[test]
    fn private_capture_cannot_acquire_public_import_authority() {
        let (_directory, mut store, client, observed) = fixture(false);
        assert!(store
            .prepare_family_external_create_content(
                &client,
                &observed.observation_id,
                EntryKind::File,
                Some(FamilyCreateMode::Binary)
            )
            .is_err());
        assert!(CaptureImportAuthorization::for_create(
            &store.connection,
            &client,
            &observed.observation_id
        )
        .is_err());
        assert!(store.list().unwrap().is_empty());
        let receipts: i64 = store
            .connection
            .query_row("SELECT count(*) FROM operations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(receipts, 0);
    }
    #[test]
    fn capture_create_requires_independent_client_and_exact_public_proof() {
        let (_directory, mut store, client, observed) = fixture(true);
        assert!(store
            .prepare_family_external_create_content(
                &op("other-client"),
                &observed.observation_id,
                EntryKind::File,
                Some(FamilyCreateMode::Binary)
            )
            .is_err());
        let intent = store
            .prepare_family_external_create_content(
                &client,
                &observed.observation_id,
                EntryKind::File,
                Some(FamilyCreateMode::Binary),
            )
            .unwrap();
        assert!(matches!(intent, ExternalCreateIntent::BinaryCapture { .. }));
        assert!(CaptureImportAuthorization::for_create(
            &store.connection,
            &op("other-client"),
            &observed.observation_id
        )
        .is_err());
        let authorization = CaptureImportAuthorization::for_create(
            &store.connection,
            &client,
            &observed.observation_id,
        )
        .unwrap();
        authorization.validate(&store.connection).unwrap();
        // Mutating the saved physical authority cannot reuse an earlier proof.
        let mut proof =
            physical_bindings::observation_proof(&store.connection, &observed.observation_id)
                .unwrap()
                .unwrap();
        proof.physical.inode = "different-inode".into();
        store
            .connection
            .execute(
                "UPDATE observation_physical SET record=?1,inode='different-inode' WHERE observation_id=?2",
                params![
                    serde_json::to_string(&proof).unwrap(),
                    observed.observation_id.as_str()
                ],
            )
            .unwrap();
        assert!(authorization.validate(&store.connection).is_err());
        assert!(store.list().unwrap().is_empty());
    }
    #[test]
    fn committed_capture_create_replays_before_current_stage_validation() {
        let (_directory, mut store, client, observed) = fixture(true);
        let intent = store
            .prepare_family_external_create_content(
                &client,
                &observed.observation_id,
                EntryKind::File,
                Some(FamilyCreateMode::Binary),
            )
            .unwrap();
        let receipt = store
            .import_family_external_create_content(&client, &observed.observation_id)
            .unwrap();
        let StoredContent::BinaryRef(BinarySourceRef::Capture(capture)) = &observed.content else {
            unreachable!()
        };
        let stage = blob_stage::resolve_locator(&store.connection, &capture.stage).unwrap();
        assert_eq!(
            blob_stage::stage_info(&store.connection, &stage)
                .unwrap()
                .phase,
            StagePhase::Sealed
        );
        // Simulate current backing being unusable after a previously durable
        // response was lost. A retry must replay, rather than plan a new target.
        store
            .connection
            .execute(
                "UPDATE binary_stages SET phase='aborted' WHERE stage_id=?1",
                [stage.stage_id().as_str()],
            )
            .unwrap();
        assert_eq!(
            store
                .prepare_family_external_create_content(
                    &client,
                    &observed.observation_id,
                    EntryKind::File,
                    Some(FamilyCreateMode::Binary)
                )
                .unwrap(),
            intent
        );
        assert_eq!(
            store
                .import_family_external_create_content(&client, &observed.observation_id)
                .unwrap(),
            receipt
        );
        let records: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM operations WHERE operation_id=?1",
                [observed.observation_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(records, 1);
    }
}
