//! Proven external edits to existing family-managed files. Observation, causal
//! authoring, receipt and the actual physical branch advance in one transaction.
//! New files and external namespace changes deliberately remain separate work.
use super::*;
use zorid_client_sync::{v2, AuthorRequest, TextState};
use zorid_core::OperationId;
use zorid_file_sync::{materialization::ContentWitness, mutation as command, Scope, Sha256Digest};

fn invalid(reason: &str) -> StoreError {
    StoreError::Corrupt(reason.into())
}

impl Store {
    /// Read-only mode probe for the native observation dispatcher. Unlike the
    /// legacy text_state API this does not enter a legacy mutation authority.
    pub fn family_text_state(&self, id: &EntryId) -> Result<Option<TextState>> {
        let tx = self.connection.unchecked_transaction()?;
        let state = text_sync::retained(&tx, id)?;
        tx.commit()?;
        Ok(state)
    }

    pub fn import_family_observation(&mut self, id: &OperationId) -> Result<CommitResult> {
        self.import_family_observation_inner(None, id)
    }
    pub fn import_family_observation_content(
        &mut self,
        client: &OperationId,
        id: &OperationId,
    ) -> Result<CommitResult> {
        self.import_family_observation_inner(Some(client), id)
    }
    fn import_family_observation_inner(
        &mut self,
        client: Option<&OperationId>,
        id: &OperationId,
    ) -> Result<CommitResult> {
        let tx = self.connection.unchecked_transaction()?;
        let raw: String = tx.query_row(
            "SELECT record FROM external_observations WHERE observation_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        let mut observation = projection::decode_observation(id.as_str(), &raw)?;
        if let Some(receipt) = capture_authorization::replay_resolved(&tx, &observation)? {
            tx.commit()?;
            return Ok(receipt);
        }
        let physical = observation
            .baseline
            .as_ref()
            .ok_or_else(|| invalid("family import requires an existing physical baseline"))?
            .clone();
        if matches!(
            observation.content,
            StoredContent::BinaryRef(BinarySourceRef::Capture(_))
        ) {
            let client = client.ok_or_else(|| {
                invalid("captured binary import lacks independent client admission")
            })?;
            let authorization = capture_authorization::CaptureImportAuthorization::for_observation(
                &tx, client, id,
            )?;
            tx.commit()?;
            return Ok(binary_commit::commit_external_binary(self, authorization)?.receipt);
        }
        let observed_bytes = observation
            .content
            .inline_bytes()
            .ok_or_else(|| invalid("physical Text edit requires bounded inline content"))?;
        if observed_bytes.len() as u64 > FAMILY_MAX_INLINE_BYTES {
            return Err(zorid_client_sync::SyncError::TooLarge.into());
        }
        if projection::baseline(&tx, &physical.state.id)?.as_ref() != Some(&physical) {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
        let proof = physical_bindings::check_observation(&tx, id, &physical.state.id)?
            .ok_or_else(|| invalid("family observation lacks public-path physical proof"))?;
        check_active(&tx, &physical.state.id)?;
        let authority = text_sync::identity(&tx)?;
        let scope = Scope {
            realm_id: authority
                .realm_id
                .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
            vault_id: authority
                .vault_id
                .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
        };
        let graph = blob_index::load_metadata(&tx, &scope)?
            .ok_or_else(|| invalid("family observation has no enrolled graph"))?;
        let mut entries = read_states(&tx, true)?;
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        let entry = entries
            .iter()
            .find(|entry| entry.id == physical.state.id)
            .ok_or_else(|| invalid("family observation target is not visible"))?
            .clone();
        if entry.kind != EntryKind::File
            || entry.path != physical.state.path
            || entry.path != observation.path
        {
            return Err(zorid_client_sync::SyncError::InvalidState.into());
        }
        family_materialization::check_publication_content(
            &tx,
            &physical.state,
            Some(&physical.content),
        )?;
        let current = text_sync::retained(&tx, &entry.id)?
            .ok_or_else(|| invalid("inline binary observation requires streamed capture"))?;
        if current.version != entry.revision {
            return Err(invalid(
                "family Text revision differs from visible metadata",
            ));
        }
        let historical = family_materialization::history(&tx, &entry.id, &physical.state.revision)?
            .ok_or_else(|| invalid("physical text publication history missing"))?;
        let (namespace_heads, location_event) = match &historical.publication {
            FamilyPublication::Normal {
                path,
                kind: EntryKind::File,
                namespace_heads,
                location_event,
            } if path == &physical.state.path => (namespace_heads.clone(), location_event.clone()),
            _ => {
                return Err(invalid(
                    "physical text baseline lacks normal historical location",
                ))
            }
        };
        let baseline = v2::TextPhysicalBaseline {
            text: text_sync::baseline(&tx, &physical)?
                .ok_or_else(|| invalid("physical text causal snapshot missing"))?,
            namespace: v2::TextNamespaceContext {
                bootstrap_id: historical.identity.bootstrap_id.clone(),
                parents: namespace_heads,
            },
            location: v2::TextPhysicalLocation {
                path: physical.state.path.clone(),
                location_event,
            },
        };
        let allocation = command::Allocation {
            metadata_revision: family_commands::fresh_revision()?,
            graph_revision: family_commands::fresh_revision()?,
            update_ids: vec![family_commands::fresh_update()?],
            text: Some(command::TextAllocation {
                actor: family_commands::actor(&tx, Some(&current))?,
                new_text: None,
            }),
        };
        let observed_revision = family_commands::fresh_revision()?;
        let author = AuthorRequest {
            expected_version: current.version.clone(),
            next_version: allocation.metadata_revision.clone(),
            update_id: allocation.update_ids[0].clone(),
            actor: allocation.text.as_ref().unwrap().actor.clone(),
            edits: Vec::new(),
        };
        let external = v2::plan_external_text_with_baseline(
            &current,
            &baseline,
            observed_bytes,
            &author,
            &observed_revision,
        )?;
        external.check_preconditions(
            &current,
            &baseline,
            family_ledger::unused(&tx, &family_commands::key(&scope, &author.update_id))?,
        )?;
        let candidate = zorid_file_sync::metadata_plan::prepare_authored_text_activity(
            &graph,
            external.authored().activity(),
            allocation.graph_revision.clone(),
        )?;
        if external.authored().plan().materialized_utf8.len() as u64 > FAMILY_MAX_INLINE_BYTES {
            return Err(zorid_client_sync::SyncError::TooLarge.into());
        }
        let request = MutationRequest {
            operation_id: id.clone(),
            mutation: Mutation::Write {
                id: entry.id.clone(),
                expected: entry.revision.clone(),
                content: external.authored().plan().materialized_utf8.clone(),
            },
        };
        host_intents::check_execution(&tx, &request)?;
        let command =
            command::FamilyCommand::new(request.clone(), None).map_err(family_commands::mapped)?;
        let changes = zorid_core::plan_mutation(&request, &entries, &allocation.metadata_revision)?;
        let prepared = family_commands::prepare_parts(
            &tx,
            command,
            allocation,
            entries,
            changes,
            vec![author.update_id.clone()],
            Vec::new(),
            Some(command::TextChange::Write(
                external.authored().plan().clone(),
            )),
            candidate,
        )?;
        let observed = external.observed_baseline();
        if observed.text.materialized_utf8.as_slice() != observed_bytes {
            return Err(invalid(
                "external physical branch does not reproduce observed bytes",
            ));
        }
        tx.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let raw: String = tx.query_row(
            "SELECT record FROM external_observations WHERE observation_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        let actual = projection::decode_observation(id.as_str(), &raw)?;
        if let Some(receipt) = capture_authorization::replay_resolved(&tx, &actual)? {
            tx.commit()?;
            return Ok(receipt);
        }
        if actual != observation
            || projection::baseline(&tx, &physical.state.id)?.as_ref() != Some(&physical)
            || physical_bindings::check_observation(&tx, id, &physical.state.id)?.as_ref()
                != Some(&proof)
        {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
        check_active(&tx, &physical.state.id)?;
        family_materialization::check_publication_content(
            &tx,
            &physical.state,
            Some(&physical.content),
        )?;
        let receipt = family_metadata_transactions::commit_prepared_observed(&tx, &prepared, &actual)?;
        text_sync::reserve_revision(&tx, &observed_revision)?;
        text_sync::put_revision(&tx, &observed.text.state)?;
        let mut observed_state = physical.state.clone();
        observed_state.revision = observed_revision;
        record_observed_text_history(&tx, &observed_state, &historical, observed)?;
        projection::put_baseline(
            &tx,
            &ProjectionBaseline {
                state: observed_state.clone(),
                content: observation.content.clone(),
            },
        )?;
        physical_bindings::put_observed_binding(&tx, &observed_state, Some(&proof))?;
        observation.resolution = Some(id.clone());
        tx.execute(
            "UPDATE external_observations SET record=?1 WHERE observation_id=?2",
            params![serde_json::to_string(&observation)?, id.as_str()],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}

/// The observed file is a causal branch, not necessarily the merged desired
/// publication. Retain its exact snapshot and old location as immutable history;
/// never replace the current classifier cache with this physical witness.
fn record_observed_text_history(
    tx: &Connection,
    state: &EntryState,
    previous: &FamilyMaterialization,
    observed: &v2::TextPhysicalBaseline,
) -> Result<()> {
    if observed.text.state.identity.entry_id != state.id
        || observed.text.state.version != state.revision
        || observed.location.path != state.path
        || previous.identity.entry_id != state.id
        || previous.identity.bootstrap_id != observed.namespace.bootstrap_id
    {
        return Err(invalid("observed text historical identity mismatch"));
    }
    let mut record = previous.clone();
    record.publication = FamilyPublication::Normal {
        path: observed.location.path.clone(),
        kind: EntryKind::File,
        namespace_heads: observed.namespace.parents.clone(),
        location_event: observed.location.location_event.clone(),
    };
    record.retained_content = Some(FamilyContentWitness {
        digest: Sha256Digest::of(&observed.text.materialized_utf8),
        witness: ContentWitness::Text {
            identity: observed.text.state.identity.clone(),
            revision: state.revision.clone(),
            snapshot_digest: Sha256Digest::of(&observed.text.state.snapshot),
        },
    });
    tx.execute(
        "INSERT INTO family_materialization_history(entry_id,revision,record) VALUES(?1,?2,?3)",
        params![
            state.id.as_str(),
            state.revision.as_str(),
            serde_json::to_string(&record)?
        ],
    )?;
    family_materialization::check_publication_content(
        tx,
        state,
        Some(&StoredContent::InlineBytes(
            observed.text.materialized_utf8.clone(),
        )),
    )
}

fn check_active(tx: &Connection, id: &EntryId) -> Result<()> {
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projection_attempts WHERE entry_id=?1 AND completed=0)",
        [id.as_str()],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(zorid_client_sync::SyncError::InvalidState.into());
    }
    Ok(())
}
