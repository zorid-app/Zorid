//! Local family commands. Core receipts are local idempotency records, never
//! encrypted wire payloads. All envelopes below come from the shared Rust mapper.
use super::family_ledger::{self, EnvelopeKey, EnvelopeMetadata, Family, TextBinding};
use super::*;
use zorid_client_sync::{ActorOwner, ActorRegistration};
use zorid_core::OperationId;
use zorid_file_sync::{mutation as command, Scope};
use zorid_sync_protocol::{DeviceId, UpdateId};

pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("family_commands","CREATE TABLE family_commands (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), command TEXT NOT NULL)"),
];
pub(super) fn mapped(error: command::Error) -> StoreError {
    match error {
        command::Error::Contract(e) => StoreError::Contract(e),
        command::Error::Files(e) => StoreError::FileSync(e),
        command::Error::Text(e) => StoreError::Sync(e),
        command::Error::UnsupportedCommandVersion => {
            StoreError::Sync(zorid_client_sync::SyncError::UnsupportedFormat)
        }
        _ => StoreError::Contract(ContractError::InvalidMutation {
            reason: format!("family command rejected: {error}"),
        }),
    }
}
pub(super) fn key(scope: &Scope, id: &UpdateId) -> EnvelopeKey {
    EnvelopeKey {
        realm_id: scope.realm_id.clone(),
        vault_id: scope.vault_id.clone(),
        update_id: id.clone(),
    }
}
pub(super) fn fresh_revision() -> Result<Revision> {
    Ok(Revision::new(uuid::Uuid::new_v4().to_string())?)
}
pub(super) fn fresh_update() -> Result<UpdateId> {
    Ok(UpdateId::new(uuid::Uuid::new_v4().to_string())?)
}
pub(super) fn actor(
    tx: &Connection,
    current: Option<&zorid_client_sync::TextState>,
) -> Result<ActorRegistration> {
    let authority = text_sync::identity(tx)?;
    for _ in 0..64 {
        let random = uuid::Uuid::new_v4();
        let b = random.as_bytes();
        let actor = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        if current.is_some_and(|s| s.actors.contains_key(&actor)) {
            continue;
        }
        return Ok(ActorRegistration {
            actor,
            owner: ActorOwner {
                replica_id: DeviceId::new(authority.local_store_id.as_str())?,
                incarnation_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
            },
        });
    }
    Err(zorid_client_sync::SyncError::ActorCollision.into())
}
impl Store {
    pub fn family_apply(
        &mut self,
        request: &MutationRequest,
        mode: Option<FamilyCreateMode>,
    ) -> Result<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let receipt = apply_transaction(&tx, request, mode)?;
        tx.commit()?;
        Ok(receipt)
    }
}

pub(super) fn apply_transaction(
    tx: &Connection,
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
) -> Result<CommitResult> {
    let command = command::FamilyCommand::new(request.clone(), mode).map_err(mapped)?;
    host_intents::check_execution(tx, request)?;
    let prior:Option<(String,String,Option<String>)>=tx.query_row("SELECT operations.request,operations.result,family_commands.command FROM operations LEFT JOIN family_commands USING(operation_id) WHERE operations.operation_id=?1",[request.operation_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((raw, receipt, composite)) = prior {
        let prior_command: command::FamilyCommand =
            serde_json::from_str(&composite.ok_or_else(|| {
                StoreError::Corrupt(
                    "family operation receipt has no exact composite command".into(),
                )
            })?)?;
        command.check_replay(&prior_command).map_err(mapped)?;
        let recorded = RecordedOperation {
            request: serde_json::from_str(&raw)?,
            result: serde_json::from_str(&receipt)?,
        };
        if let IdempotencyCheck::Replay(receipt) = check_idempotency(request, Some(&recorded))? {
            let receipt = receipt.clone();
            return Ok(receipt);
        }
        return Err(StoreError::Corrupt(
            "retained family receipt did not replay".into(),
        ));
    }
    let authority = text_sync::identity(tx)?;
    let (Some(realm_id), Some(vault_id)) = (authority.realm_id, authority.vault_id) else {
        return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
    };
    let scope = Scope { realm_id, vault_id };
    let graph = file_state::load(tx, &scope)?.ok_or_else(|| ContractError::InvalidMutation {
        reason: "vault is not enrolled for family synchronization".into(),
    })?;
    family_materialization::validate(tx, &graph)?;
    // Existing generic prepared intents carry no explicit CreateMode. Never
    // guess their binary/text identity at commit time.
    if mode.is_some() {
        let owned: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM host_intents WHERE operation_id=?1)",
            [request.operation_id.as_str()],
            |r| r.get(0),
        )?;
        if owned {
            return Err(ContractError::InvalidMutation {
                reason: "file creation requires a mode-bound family intent".into(),
            }
            .into());
        }
    }
    let bytes = match &request.mutation {
        Mutation::Create {
            content: Some(bytes),
            ..
        }
        | Mutation::Write { content: bytes, .. } => Some(bytes),
        _ => None,
    };
    if bytes.is_some_and(|b| b.len() as u64 > FAMILY_MAX_FILE_BYTES) {
        return Err(zorid_client_sync::SyncError::TooLarge.into());
    }
    let entries = read_states(tx, true)?;
    let text = if matches!(request.mutation, Mutation::Write { .. }) {
        text_sync::retained(tx, request.mutation.id())?
    } else {
        None
    };
    let need =
        command::requirements(request, &entries, &graph, mode, text.as_ref()).map_err(mapped)?;
    let allocation = command::Allocation {
        metadata_revision: fresh_revision()?,
        graph_revision: fresh_revision()?,
        update_ids: (0..need.update_count)
            .map(|_| fresh_update())
            .collect::<Result<_>>()?,
        text: match need.text {
            command::TextRequirement::None => None,
            requirement => Some(command::TextAllocation {
                actor: actor(tx, text.as_ref())?,
                new_text: if matches!(requirement, command::TextRequirement::Create) {
                    Some(command::NewText {
                        bootstrap_id: fresh_update()?,
                        empty_revision: fresh_revision()?,
                    })
                } else {
                    None
                },
            }),
        },
    };
    let plan = command::plan_mutation(request, &entries, &graph, mode, text.as_ref(), &allocation)
        .map_err(mapped)?;
    commit_plan(
        tx,
        &command,
        &scope,
        &graph,
        text.as_ref(),
        &allocation,
        plan,
    )
}

/// Shared only by locally constructed family commands and proven external observations.
/// The caller owns the enclosing IMMEDIATE transaction and commits physical proof with it.
pub(super) fn commit_plan(
    tx: &Connection,
    command: &command::FamilyCommand,
    scope: &Scope,
    graph: &zorid_file_sync::v2::State,
    text: Option<&zorid_client_sync::TextState>,
    allocation: &command::Allocation,
    plan: command::MutationPlan,
) -> Result<CommitResult> {
    let request = &command.request;
    let entries = read_states(tx, true)?;
    let mut unused = true;
    for id in &plan.allocated_update_ids {
        unused &= family_ledger::unused(tx, &key(&scope, id))?;
    }
    plan.check_preconditions(&entries, graph, text, unused)
        .map_err(mapped)?;
    text_sync::reserve_revision(tx, &allocation.metadata_revision)?;
    text_sync::reserve_revision(tx, &allocation.graph_revision)?;
    if let Some(new) = allocation.text.as_ref().and_then(|a| a.new_text.as_ref()) {
        text_sync::reserve_revision(tx, &new.empty_revision)?;
    }
    for authored in &plan.authored_files {
        let metadata = EnvelopeMetadata {
            key: key(&scope, &authored.update_id),
            family: Family::Files,
            format_version: 2,
            payload_digest: zorid_file_sync::Sha256Digest::of(&authored.payload_bytes),
            payload_bytes: u32::try_from(authored.payload_bytes.len())
                .map_err(|_| zorid_client_sync::SyncError::TooLarge)?,
            text_binding: None,
        };
        family_ledger::insert_authored(tx, &metadata, &authored.payload_bytes)?;
    }
    // Text metadata/persistence is handled directly from the validated mapper.
    if let Some(change) = &plan.text {
        let text = change.plan();
        let activity = plan
            .next_graph
            .activities()
            .get(&text.authored.update_id)
            .ok_or_else(|| StoreError::Corrupt("authored text has no namespace activity".into()))?;
        let metadata = EnvelopeMetadata {
            key: key(&scope, &text.authored.update_id),
            family: Family::Text,
            format_version: 2,
            payload_digest: zorid_file_sync::Sha256Digest::of(&text.authored.payload_bytes),
            payload_bytes: u32::try_from(text.authored.payload_bytes.len())
                .map_err(|_| zorid_client_sync::SyncError::TooLarge)?,
            text_binding: Some(TextBinding {
                entry_id: text.next_state.identity.entry_id.clone(),
                text_bootstrap_id: text.next_state.identity.bootstrap_id.clone(),
                namespace: activity.namespace().clone(),
            }),
        };
        family_ledger::insert_authored(tx, &metadata, &text.authored.payload_bytes)?;
        text_sync::put_current(tx, &text.next_state)?;
    }
    // Namespace-only operations keep each text CRDT intact, merely rebinding
    // the optimistic metadata token. This creates no CRDT envelope.
    if matches!(
        request.mutation,
        Mutation::Move { .. } | Mutation::Delete { .. }
    ) {
        for change in &plan.changes {
            if let Some(mut state) = text_sync::retained(tx, &change.after.id)? {
                state.version = allocation.metadata_revision.clone();
                text_sync::put_current(tx, &state)?;
            }
        }
    }
    let graph_plan = zorid_file_sync::v2::FilePlan {
        expected_state: graph.clone(),
        next_state: Some(plan.next_graph.clone()),
        view: plan.next_graph.view()?,
    };
    let files: Vec<_> = plan
        .authored_files
        .iter()
        .map(|f| (&f.update_id, f.payload_bytes.as_slice()))
        .collect();
    file_state::persist_many(tx, &graph_plan, &files)?;
    tx.execute(
        "INSERT INTO operations(operation_id,request) VALUES(?1,?2)",
        params![
            request.operation_id.as_str(),
            serde_json::to_string(request)?
        ],
    )?;
    let sequence = u64::try_from(tx.last_insert_rowid())
        .map_err(|_| StoreError::Corrupt("operation sequence overflow".into()))?;
    let receipt = CommitResult {
        operation_id: request.operation_id.clone(),
        sequence,
        changes: plan.changes,
    };
    receipt.validate()?;
    let changed = family_materialization::apply(
        tx,
        &plan.next_graph,
        ProjectionOrigin::LocalCommand {
            operation_id: request.operation_id.clone(),
        },
        Some(&allocation.metadata_revision),
    )?;
    let expected: std::collections::BTreeSet<_> =
        receipt.changes.iter().map(|c| c.after.id.clone()).collect();
    if changed
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        != expected
    {
        return Err(StoreError::Corrupt(
            "command planner and publication classifier changed different identities".into(),
        ));
    }
    for change in &receipt.changes {
        let raw: String = tx.query_row(
            "SELECT state FROM entries WHERE id=?1",
            [change.after.id.as_str()],
            |r| r.get(0),
        )?;
        if serde_json::from_str::<EntryState>(&raw)? != change.after {
            return Err(StoreError::Corrupt(
                "command receipt differs from committed materialization".into(),
            ));
        }
    }
    tx.execute(
        "UPDATE operations SET result=?1 WHERE operation_id=?2",
        params![
            serde_json::to_string(&receipt)?,
            request.operation_id.as_str()
        ],
    )?;
    tx.execute(
        "INSERT INTO family_commands VALUES(?1,?2)",
        params![
            request.operation_id.as_str(),
            serde_json::to_string(&command)?
        ],
    )?;
    projection_jobs::enqueue_local(tx, request, &receipt)?;
    host_intents::record_commit(tx, request)?;
    Ok(receipt)
}
