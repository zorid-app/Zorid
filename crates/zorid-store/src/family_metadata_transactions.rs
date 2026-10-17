//! Read-snapshot preparation and short atomic metadata publication. Binary
//! Create/Write uses the common staged pipeline; this mapper emits namespace
//! frames and bounded Text updates only.
use super::family_commands::{self as commands, fresh_revision, fresh_update, key, mapped};
use super::family_ledger::{self, EnvelopeMetadata, Family, TextBinding};
use super::*;
use zorid_client_sync::TextState;
use zorid_file_sync::{
    metadata::MetadataState,
    metadata_plan::{MetadataCandidate, MetadataPlan},
    mutation as command, Scope,
};
use zorid_sync_protocol::UpdateId;

/// Private in-process preparation, never caller-deserializable authorization.
pub(super) struct PreparedFamilyCommand {
    command: command::FamilyCommand,
    allocation: command::Allocation,
    expected_entries: Vec<EntryState>,
    expected_texts: Vec<TextState>,
    changes: Vec<zorid_core::EntryChange>,
    allocated_update_ids: Vec<UpdateId>,
    authored_files: Vec<command::AuthoredFile>,
    text: Option<command::TextChange>,
    graph: MetadataPlan,
}
impl PreparedFamilyCommand {
    pub(super) fn request(&self) -> &MutationRequest {
        &self.command.request
    }
}

/// Exact original command replay precedes mode validation and state planning.
pub(super) fn replay(
    tx: &Connection,
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
) -> Result<Option<CommitResult>> {
    let prior: Option<(String,String,Option<String>)> = tx.query_row("SELECT operations.request,operations.result,family_commands.command FROM operations LEFT JOIN family_commands USING(operation_id) WHERE operations.operation_id=?1",[request.operation_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((raw, receipt, composite)) = prior else {
        return Ok(None);
    };
    let recorded = operation_request::decode_record(&raw, &receipt, &request.operation_id)?;
    if matches!(
        &recorded.request,
        operation_request::OperationRequest::Inline(_)
    ) {
        let command = command::FamilyCommand::new(request.clone(), mode).map_err(|_| {
            ContractError::IdempotencyConflict {
                operation_id: request.operation_id.clone(),
            }
        })?;
        let prior_command: command::FamilyCommand =
            serde_json::from_str(&composite.ok_or_else(|| {
                StoreError::Corrupt(
                    "family operation receipt has no exact composite command".into(),
                )
            })?)?;
        command.check_replay(&prior_command).map_err(mapped)?;
    }
    operation_request::replay_inline_with_mode(request, mode, &raw, &receipt).map(Some)
}
fn scope(tx: &Connection) -> Result<Scope> {
    let authority = text_sync::identity(tx)?;
    match (authority.realm_id, authority.vault_id) {
        (Some(realm_id), Some(vault_id)) => Ok(Scope { realm_id, vault_id }),
        _ => Err(zorid_client_sync::SyncError::IdentityMismatch.into()),
    }
}
fn entries(tx: &Connection) -> Result<Vec<EntryState>> {
    let mut entries = read_states(tx, true)?;
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(entries)
}
fn graph(tx: &Connection, scope: &Scope) -> Result<MetadataState> {
    blob_index::load_metadata(tx, scope)?.ok_or_else(|| {
        ContractError::InvalidMutation {
            reason: "vault is not enrolled for family synchronization".into(),
        }
        .into()
    })
}
pub(super) fn inline_binary(
    tx: &Connection,
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
) -> Result<bool> {
    match &request.mutation {
        Mutation::Create {
            kind: EntryKind::File,
            ..
        } => Ok(mode == Some(FamilyCreateMode::Binary)),
        Mutation::Write { id, .. } => Ok(matches!(
            graph(tx, &scope(tx)?)?
                .metadata_view()?
                .content_bindings()
                .get(id),
            Some(zorid_file_sync::v2::ContentBinding::Binary)
        )),
        _ => Ok(false),
    }
}
/// Generic intents do not bind file creation mode. Check this both before
/// preparation and inside the final writer, after receipt replay.
fn check_mode_bound_intent(
    tx: &Connection,
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
) -> Result<()> {
    if mode.is_some()
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM host_intents WHERE operation_id=?1)",
            [request.operation_id.as_str()],
            |r| r.get::<_, bool>(0),
        )?
    {
        return Err(ContractError::InvalidMutation {
            reason: "file creation requires a mode-bound family intent".into(),
        }
        .into());
    }
    Ok(())
}
/// Call in a pinned read transaction, close it, then use commit_prepared in the
/// final writer alongside any external physical proof checks.
pub(super) fn prepare_command(
    tx: &Connection,
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
) -> Result<PreparedFamilyCommand> {
    request.validate()?;
    let command = command::FamilyCommand::new(request.clone(), mode).map_err(mapped)?;
    host_intents::check_execution(tx, request)?;
    if blob_stage::operation_reserved(tx, &request.operation_id)? {
        return Err(ContractError::IdempotencyConflict {
            operation_id: request.operation_id.clone(),
        }
        .into());
    }
    check_mode_bound_intent(tx, request, mode)?;
    let scope = scope(tx)?;
    let graph = graph(tx, &scope)?;
    let entries = entries(tx)?;
    let text = if matches!(request.mutation, Mutation::Write { .. }) {
        text_sync::retained(tx, request.mutation.id())?
    } else {
        None
    };
    let need = zorid_file_sync::metadata_mutation::requirements(
        request,
        &entries,
        &graph,
        mode,
        text.as_ref(),
    )
    .map_err(mapped)?;
    let allocation = command::Allocation {
        metadata_revision: fresh_revision()?,
        graph_revision: fresh_revision()?,
        update_ids: (0..need.update_count)
            .map(|_| fresh_update())
            .collect::<Result<_>>()?,
        text: match need.text {
            command::TextRequirement::None => None,
            requirement => Some(command::TextAllocation {
                actor: commands::actor(tx, text.as_ref())?,
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
    let prepared = zorid_file_sync::metadata_mutation::prepare_mutation(
        request,
        &entries,
        &graph,
        mode,
        text.as_ref(),
        &allocation,
    )
    .map_err(mapped)?;
    let (expected_entries, changes, allocated, authored, text, candidate) = prepared.into_parts();
    prepare_parts(
        tx,
        command,
        allocation,
        expected_entries,
        changes,
        allocated,
        authored,
        text,
        candidate,
    )
}
/// Shared with the portable physical Text mapper. Arguments must come from
/// portable planners inside this snapshot, never a deserialized host plan.
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_parts(
    tx: &Connection,
    command: command::FamilyCommand,
    allocation: command::Allocation,
    mut expected_entries: Vec<EntryState>,
    changes: Vec<zorid_core::EntryChange>,
    allocated_update_ids: Vec<UpdateId>,
    authored_files: Vec<command::AuthoredFile>,
    text: Option<command::TextChange>,
    candidate: MetadataCandidate,
) -> Result<PreparedFamilyCommand> {
    expected_entries.sort_by(|a, b| a.id.cmp(&b.id));
    if entries(tx)? != expected_entries {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    let verified_old = blob_index::verify_metadata(tx, candidate.expected_state(), &[])?;
    family_materialization::validate(tx, candidate.expected_state(), &verified_old)?;
    let expected_texts = family_ingress::retained_texts(tx, candidate.expected_state().scope())?;
    let overlay: Vec<_> = authored_files
        .iter()
        .map(|a| (a.update_id.clone(), a.payload_bytes.clone()))
        .collect();
    let verified = blob_index::verify_metadata(tx, candidate.verification_state(), &overlay)?;
    let graph = candidate.finalize(verified)?;
    Ok(PreparedFamilyCommand {
        command,
        allocation,
        expected_entries,
        expected_texts,
        changes,
        allocated_update_ids,
        authored_files,
        text,
        graph,
    })
}

/// Receipt replay, exact metadata/entries/Text/source CAS, durable authority and
/// publication all share the caller's final IMMEDIATE transaction. Hashing stays
/// in the preparation snapshot; immutable backing sources are pinned again here.
pub(super) fn commit_prepared(
    tx: &Connection,
    plan: &PreparedFamilyCommand,
) -> Result<CommitResult> {
    let request = &plan.command.request;
    if let Some(receipt) = replay(tx, request, plan.command.create_mode)? {
        return Ok(receipt);
    }
    check_mode_bound_intent(tx, request, plan.command.create_mode)?;
    host_intents::check_execution(tx, request)?;
    if blob_stage::operation_reserved(tx, &request.operation_id)? {
        return Err(ContractError::IdempotencyConflict {
            operation_id: request.operation_id.clone(),
        }
        .into());
    }
    let scope = scope(tx)?;
    let actual = graph(tx, &scope)?;
    plan.graph.check_preconditions(&actual, None)?;
    if entries(tx)? != plan.expected_entries
        || family_ingress::retained_texts(tx, &scope)? != plan.expected_texts
    {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    blob_index::check_sources(tx, &actual)?;
    for id in &plan.allocated_update_ids {
        if !family_ledger::unused(tx, &key(&scope, id))? {
            return Err(mapped(command::Error::InvalidAllocation));
        }
    }
    text_sync::reserve_revision(tx, &plan.allocation.metadata_revision)?;
    text_sync::reserve_revision(tx, &plan.allocation.graph_revision)?;
    if let Some(new) = plan
        .allocation
        .text
        .as_ref()
        .and_then(|a| a.new_text.as_ref())
    {
        text_sync::reserve_revision(tx, &new.empty_revision)?;
    }
    for authored in &plan.authored_files {
        let record =
            zorid_file_sync::metadata::GraphRecord::from_authored_exact(&authored.payload_bytes)?.2;
        let metadata = EnvelopeMetadata {
            key: key(&scope, &authored.update_id),
            family: Family::Files,
            format_version: 2,
            payload_digest: zorid_file_sync::Sha256Digest::of(&authored.payload_bytes),
            payload_bytes: u32::try_from(authored.payload_bytes.len())
                .map_err(|_| zorid_client_sync::SyncError::TooLarge)?,
            file_summary_digest: Some(record.summary_digest()?),
            text_binding: None,
        };
        family_ledger::insert_authored(tx, &metadata, &authored.payload_bytes)?;
    }
    let graph = plan.graph.verification_state();
    if let Some(change) = &plan.text {
        let text = change.plan();
        let activity = graph
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
            file_summary_digest: None,
            text_binding: Some(TextBinding {
                entry_id: text.next_state.identity.entry_id.clone(),
                text_bootstrap_id: text.next_state.identity.bootstrap_id.clone(),
                namespace: activity.namespace().clone(),
            }),
        };
        family_ledger::insert_authored(tx, &metadata, &text.authored.payload_bytes)?;
        text_sync::put_current(tx, &text.next_state)?;
    }
    // Moves/deletes rebind retained Text metadata without authoring a CRDT update.
    if matches!(
        request.mutation,
        Mutation::Move { .. } | Mutation::Delete { .. }
    ) {
        for change in &plan.changes {
            if let Some(mut state) = text_sync::retained(tx, &change.after.id)? {
                state.version = plan.allocation.metadata_revision.clone();
                text_sync::put_current(tx, &state)?;
            }
        }
    }
    blob_index::persist_plan(tx, &plan.graph)?;
    blob_index::check_sources(tx, graph)?;
    tx.execute(
        "INSERT INTO operations(operation_id,request) VALUES(?1,?2)",
        params![
            request.operation_id.as_str(),
            operation_request::encode_inline(request)?
        ],
    )?;
    let sequence = u64::try_from(tx.last_insert_rowid())
        .map_err(|_| StoreError::Corrupt("operation sequence overflow".into()))?;
    let receipt = CommitResult {
        operation_id: request.operation_id.clone(),
        sequence,
        changes: plan.changes.clone(),
    };
    receipt.validate()?;
    let changed = family_materialization::apply(
        tx,
        graph,
        plan.graph.verified_binaries(),
        ProjectionOrigin::LocalCommand {
            operation_id: request.operation_id.clone(),
        },
        Some(&plan.allocation.metadata_revision),
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
            serde_json::to_string(&plan.command)?
        ],
    )?;
    projection_jobs::enqueue_local(tx, request, &receipt)?;
    host_intents::record_commit(tx, request)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zorid_core::{OperationId, VaultPath};
    use zorid_sync_protocol::{RealmId, VaultId};

    fn enrolled(path: &std::path::Path) -> Store {
        let mut store = Store::open(path).unwrap();
        store
            .family_enroll(&Scope {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
            })
            .unwrap();
        store
    }
    fn text(id: &str, path: &str) -> MutationRequest {
        MutationRequest {
            operation_id: OperationId::new(format!("create_{id}")).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(id).unwrap(),
                path: VaultPath::new(path).unwrap(),
                kind: EntryKind::File,
                content: Some(b"original".to_vec()),
            },
        }
    }
    #[test]
    fn prepared_command_rejects_a_new_graph_without_persisting_any_effects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store");
        let mut store = enrolled(&path);
        let request = text("z_entry", "a.md");
        let tx = store.connection.unchecked_transaction().unwrap();
        let prepared = prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).unwrap();
        tx.commit().unwrap();
        // A concurrent committed command changes entries, all-Text and metadata.
        store
            .family_apply(&text("a_entry", "z.md"), Some(FamilyCreateMode::Text))
            .unwrap();
        let before = store.family_status().unwrap();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(commit_prepared(&tx, &prepared).is_err());
        tx.rollback().unwrap();
        assert_eq!(store.family_status().unwrap(), before);
        assert!(store
            .read(&EntryId::new("z_entry").unwrap())
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT count(*) FROM operations WHERE operation_id=?1",
                    [request.operation_id.as_str()],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    #[test]
    fn final_writer_rejects_a_generic_create_intent_inserted_after_preparation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store");
        let mut store = enrolled(&path);
        let request = text("entry", "note.md");
        let tx = store.connection.unchecked_transaction().unwrap();
        let prepared = prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).unwrap();
        tx.commit().unwrap();
        // Public preparation now rejects enrolled File Create. Insert the same
        // valid generic row through a separate connection to cover stale/internal
        // writers that have no mode-bound family authority.
        let other = Connection::open(&path).unwrap();
        other.execute(
            "INSERT INTO host_intents(client_id,token,operation_id,entry_id,request,state,acknowledged) VALUES('generic_client','generic_token',?1,?2,?3,'commit_requested',0)",
            params![request.operation_id.as_str(), request.mutation.id().as_str(), serde_json::to_string(&request).unwrap()],
        ).unwrap();
        // The generic execution check alone accepts this exact authorized row.
        host_intents::check_execution(&store.connection, &request).unwrap();
        let before = store.family_status().unwrap();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(matches!(
            commit_prepared(&tx, &prepared),
            Err(StoreError::Contract(ContractError::InvalidMutation { .. }))
        ));
        tx.rollback().unwrap();
        assert_eq!(store.family_status().unwrap(), before);
        assert!(store.list().unwrap().is_empty());
        assert_eq!(
            other
                .query_row(
                    "SELECT state FROM host_intents WHERE operation_id=?1",
                    [request.operation_id.as_str()],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "commit_requested"
        );
        assert_eq!(
            other
                .query_row(
                    "SELECT count(*) FROM operations WHERE operation_id=?1",
                    [request.operation_id.as_str()],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            other
                .query_row("SELECT count(*) FROM immutable_payloads", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn prepared_command_replays_its_receipt_after_unrelated_state_advances() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = enrolled(&dir.path().join("store"));
        let request = text("z_entry", "a.md");
        let tx = store.connection.unchecked_transaction().unwrap();
        let prepared = prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).unwrap();
        tx.commit().unwrap();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let receipt = commit_prepared(&tx, &prepared).unwrap();
        tx.commit().unwrap();
        store
            .family_apply(&text("a_entry", "z.md"), Some(FamilyCreateMode::Text))
            .unwrap();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert_eq!(commit_prepared(&tx, &prepared).unwrap(), receipt);
        tx.commit().unwrap();
    }
    #[test]
    fn metadata_move_and_text_write_preserve_reference_backed_binary_content() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = enrolled(&dir.path().join("store"));
        let binary_id = EntryId::new("binary").unwrap();
        let binary = MutationRequest {
            operation_id: OperationId::new("binary_create").unwrap(),
            mutation: Mutation::Create {
                id: binary_id.clone(),
                path: VaultPath::new("blob.unknown").unwrap(),
                kind: EntryKind::File,
                content: Some(vec![13; zorid_file_sync::MAX_CHUNK_BYTES + 3]),
            },
        };
        store
            .family_apply(&binary, Some(FamilyCreateMode::Binary))
            .unwrap();
        store
            .family_apply(&text("text", "note.md"), Some(FamilyCreateMode::Text))
            .unwrap();
        let source: String = store
            .connection
            .query_row(
                "SELECT content_ref FROM entries WHERE id='binary' AND content IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let before = read_states(&store.connection, true)
            .unwrap()
            .into_iter()
            .find(|s| s.id == binary_id)
            .unwrap();
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("move_binary").unwrap(),
                    mutation: Mutation::Move {
                        id: binary_id.clone(),
                        expected: before.revision,
                        path: VaultPath::new("renamed.unknown").unwrap(),
                    },
                },
                None,
            )
            .unwrap();
        let text_id = EntryId::new("text").unwrap();
        let text = store.read(&text_id).unwrap().unwrap().state;
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("write_text").unwrap(),
                    mutation: Mutation::Write {
                        id: text_id,
                        expected: text.revision,
                        content: b"updated".to_vec(),
                    },
                },
                None,
            )
            .unwrap();
        let after: String = store
            .connection
            .query_row(
                "SELECT content_ref FROM entries WHERE id='binary' AND content IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, source);
        assert_eq!(
            read_states(&store.connection, true)
                .unwrap()
                .into_iter()
                .find(|s| s.id == binary_id)
                .unwrap()
                .path
                .as_str(),
            "renamed.unknown"
        );
        assert!(store.family_status().unwrap().graph_records > 0);
    }
}
