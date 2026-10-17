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
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let raw: String = tx.query_row(
            "SELECT record FROM external_observations WHERE observation_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        let mut observation = projection::decode_observation(id.as_str(), &raw)?;
        let physical = observation
            .baseline
            .as_ref()
            .ok_or_else(|| invalid("family import requires an existing physical baseline"))?
            .clone();
        if let Some(operation) = &observation.resolution {
            if operation != id {
                return Err(invalid("family observation resolution identity mismatch"));
            }
            let (raw, result, composite): (String,String,String) = tx.query_row("SELECT operations.request,operations.result,family_commands.command FROM operations JOIN family_commands USING(operation_id) WHERE operation_id=?1",[id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            let request: MutationRequest = serde_json::from_str(&raw)?;
            let command: command::FamilyCommand = serde_json::from_str(&composite)?;
            if command.request != request
                || command.create_mode.is_some()
                || request.operation_id != *id
                || !matches!(&request.mutation,Mutation::Write{id:entry,..} if entry==&physical.state.id)
            {
                return Err(invalid(
                    "resolved family observation has no matching write receipt",
                ));
            }
            let record = RecordedOperation {
                request: request.clone(),
                result: serde_json::from_str(&result)?,
            };
            check_idempotency(&request, Some(&record))?;
            tx.commit()?;
            return Ok(record.result);
        }
        if observation.content.len() as u64 > FAMILY_MAX_FILE_BYTES {
            return Err(zorid_client_sync::SyncError::TooLarge.into());
        }
        if projection::baseline(&tx, &physical.state.id)?.as_ref() != Some(&physical) {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
        let proof = physical_bindings::check_observation(&tx, id, &physical.state.id)?
            .ok_or_else(|| invalid("family observation lacks public-path physical proof"))?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM projection_attempts WHERE entry_id=?1 AND completed=0)",
            [physical.state.id.as_str()],
            |r| r.get(0),
        )?;
        if active {
            return Err(zorid_client_sync::SyncError::InvalidState.into());
        }
        let authority = text_sync::identity(&tx)?;
        let scope = Scope {
            realm_id: authority
                .realm_id
                .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
            vault_id: authority
                .vault_id
                .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?,
        };
        let graph = file_state::load(&tx, &scope)?
            .ok_or_else(|| invalid("family observation has no enrolled graph"))?;
        family_materialization::validate(&tx, &graph)?;
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
        family_materialization::check_publication(&tx, &physical.state, Some(&physical.content))?;
        let (receipt, observed_state) = if let Some(current) = text_sync::retained(&tx, &entry.id)?
        {
            if current.version != entry.revision {
                return Err(invalid(
                    "family text revision differs from visible metadata",
                ));
            }
            let historical =
                family_materialization::history(&tx, &entry.id, &physical.state.revision)?
                    .ok_or_else(|| invalid("physical text publication history missing"))?;
            let (namespace_heads, location_event) = match &historical.publication {
                FamilyPublication::Normal {
                    path,
                    kind: EntryKind::File,
                    namespace_heads,
                    location_event,
                } if path == &physical.state.path => {
                    (namespace_heads.clone(), location_event.clone())
                }
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
                &observation.content,
                &author,
                &observed_revision,
            )?;
            external.check_preconditions(
                &current,
                &baseline,
                family_ledger::unused(&tx, &family_commands::key(&scope, &author.update_id))?,
            )?;
            let graph_plan = zorid_file_sync::v2::plan_authored_text_activity(
                &graph,
                external.authored().activity(),
                allocation.graph_revision.clone(),
            )?;
            if external.authored().plan().materialized_utf8.len() as u64 > FAMILY_MAX_FILE_BYTES {
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
            let command = command::FamilyCommand::new(request.clone(), None)
                .map_err(family_commands::mapped)?;
            let changes =
                zorid_core::plan_mutation(&request, &entries, &allocation.metadata_revision)?;
            let plan = command::MutationPlan {
                expected_entries: entries,
                expected_graph: graph.clone(),
                changes,
                next_graph: graph_plan
                    .next_state
                    .ok_or_else(|| invalid("new external text activity was not retained"))?,
                allocated_update_ids: vec![author.update_id.clone()],
                authored_files: Vec::new(),
                text: Some(command::TextChange::Write(
                    external.authored().plan().clone(),
                )),
            };
            let receipt = family_commands::commit_plan(
                &tx,
                &command,
                &scope,
                &graph,
                Some(&current),
                &allocation,
                plan,
            )?;
            let observed = external.observed_baseline();
            if observed.text.materialized_utf8 != observation.content {
                return Err(invalid(
                    "external physical branch does not reproduce observed bytes",
                ));
            }
            text_sync::reserve_revision(&tx, &observed_revision)?;
            text_sync::put_revision(&tx, &observed.text.state)?;
            let mut observed_state = physical.state.clone();
            observed_state.revision = observed_revision;
            record_observed_text_history(&tx, &observed_state, &historical, observed)?;
            (receipt, observed_state)
        } else {
            // Binary edits have no causal text merge. A newer remote revision is
            // retained as a conflict, never replaced by the stale disk branch.
            if entry != physical.state {
                // A proven external Move records its own immutable physical
                // revision. Rebind that opaque token only when every causal
                // namespace/content witness is exactly the current publication.
                // Equal bytes alone never authorize unseen binary activity.
                let mut same_state = physical.state.clone();
                same_state.revision = entry.revision.clone();
                let current = family_materialization::get(&tx, &entry.id)?;
                let historical =
                    family_materialization::history(&tx, &entry.id, &physical.state.revision)?;
                if entry != same_state
                    || !matches!((&current,&historical),(Some(current),Some(historical)) if current==historical)
                {
                    return Err(ContractError::RevisionConflict {
                        id: entry.id.clone(),
                        expected: physical.state.revision.clone(),
                        actual: entry.revision.clone(),
                    }
                    .into());
                }
            }
            let request = MutationRequest {
                operation_id: id.clone(),
                mutation: Mutation::Write {
                    id: entry.id.clone(),
                    expected: entry.revision.clone(),
                    content: observation.content.clone(),
                },
            };
            let receipt = family_commands::apply_transaction(&tx, &request, None)?;
            let state = receipt
                .changes
                .iter()
                .find(|change| change.after.id == entry.id)
                .ok_or_else(|| invalid("binary import receipt lost target"))?
                .after
                .clone();
            family_materialization::check_publication(&tx, &state, Some(&observation.content))?;
            projection_jobs::retire_local(&tx, id)?;
            (receipt, state)
        };
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
    family_materialization::check_publication(tx, state, Some(&observed.text.materialized_utf8))
}
