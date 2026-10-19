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
    pub(super) fn request(&self) -> &MutationRequest { &self.command.request }
    pub(super) fn changes(&self) -> &[zorid_core::EntryChange] { &self.changes }
}

/// Exact original command replay precedes mode validation and state planning.
pub(super) fn replay(
    tx: &Connection,
    request: &MutationRequest,
    mode: Option<FamilyCreateMode>,
) -> Result<Option<CommitResult>> {
    let command = command::FamilyCommand::new(request.clone(), mode).map_err(mapped)?;
    replay_command(tx, &command)
}
pub(super) fn replay_command(tx: &Connection, command: &command::FamilyCommand) -> Result<Option<CommitResult>> {
    command.validate().map_err(mapped)?;
    let request = &command.request;
    let mode = command.create_mode;
    let prior: Option<(String,String,Option<String>,i64)> = tx.query_row("SELECT operations.request,operations.result,family_commands.command,operations.sequence FROM operations LEFT JOIN family_commands USING(operation_id) WHERE operations.operation_id=?1",[request.operation_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((raw, receipt, composite, sequence)) = prior else {
        return Ok(None);
    };
    let recorded = operation_request::decode_record(&raw, &receipt, &request.operation_id)?;
    if sequence <= 0 || recorded.result.sequence != sequence as u64 {
        return Err(StoreError::Corrupt("family receipt SQL sequence mismatch".into()));
    }
    if matches!(
        &recorded.request,
        operation_request::OperationRequest::Inline(_)
    ) {
        let prior_command: command::FamilyCommand =
            serde_json::from_str(&composite.ok_or_else(|| {
                StoreError::Corrupt(
                    "family operation receipt has no exact composite command".into(),
                )
            })?)?;
        if recorded.request.inline() != Some(&prior_command.request) {
            return Err(StoreError::Corrupt("family composite and operation request differ".into()));
        }
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
    let command = command::FamilyCommand::new(request.clone(), mode).map_err(mapped)?;
    prepare_family_command(tx, &command)
}
pub(super) fn prepare_family_command(tx: &Connection, command: &command::FamilyCommand) -> Result<PreparedFamilyCommand> {
    command.validate().map_err(mapped)?;
    let request = &command.request;
    let mode = command.create_mode;
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
    command.validate_destination_parent(&entries).map_err(mapped)?;
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
        command.clone(),
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
    let expected_texts = family_materialization::validate_and_return_texts(
        tx,
        candidate.expected_state(),
        &verified_old,
    )?;
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
    if let Some(receipt) = replay_command(tx, &plan.command)? {
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
    let actual_entries = entries(tx)?;
    plan.command.validate_destination_parent(&actual_entries).map_err(mapped)?;
    if actual_entries != plan.expected_entries
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
    // Connection-local observation of real full Text snapshot SELECTs. The Box
    // keeps callback context stable if this guard moves; Drop unregisters before
    // freeing it, including on assertion panic. No production hook/global counter.
    struct TextSnapshotReads<'a> {
        connection: &'a Connection,
        count: Box<std::cell::Cell<usize>>,
    }
    impl<'a> TextSnapshotReads<'a> {
        fn new(connection: &'a Connection) -> Self {
            unsafe extern "C" fn observe(
                event: u32,
                context: *mut std::ffi::c_void,
                _statement: *mut std::ffi::c_void,
                sql: *mut std::ffi::c_void,
            ) -> i32 {
                if event == rusqlite::ffi::SQLITE_TRACE_STMT && !context.is_null() && !sql.is_null()
                {
                    // SQLite supplies a live NUL-terminated statement string for
                    // this event. The connection executes synchronously while
                    // the guard owns its Cell; no allocation/panic in callback.
                    let sql = unsafe { std::ffi::CStr::from_ptr(sql.cast()) };
                    if sql
                        .to_bytes()
                        .starts_with(b"SELECT entry_id FROM text_bindings WHERE realm_id=")
                    {
                        let count = unsafe { &*context.cast::<std::cell::Cell<usize>>() };
                        count.set(count.get().saturating_add(1));
                    }
                }
                0
            }
            let guard = Self {
                connection,
                count: Box::new(std::cell::Cell::new(0)),
            };
            // This fixture connection has no other trace callback. It outlives
            // the guard, and callback context points into the stable Box above.
            let status = unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    connection.handle(),
                    rusqlite::ffi::SQLITE_TRACE_STMT,
                    Some(observe),
                    (&*guard.count as *const std::cell::Cell<usize>)
                        .cast_mut()
                        .cast(),
                )
            };
            assert_eq!(status, rusqlite::ffi::SQLITE_OK);
            guard
        }
        fn reset(&self) {
            self.count.set(0);
        }
        fn get(&self) -> usize {
            self.count.get()
        }
    }
    impl Drop for TextSnapshotReads<'_> {
        fn drop(&mut self) {
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    self.connection.handle(),
                    0,
                    None,
                    std::ptr::null_mut(),
                );
            }
        }
    }
    fn snapshot_fixture() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = enrolled(&dir.path().join("store"));
        for id in ["b_entry", "a_entry", "c_entry"] {
            store
                .family_apply(&text(id, &format!("{id}.md")), Some(FamilyCreateMode::Text))
                .unwrap();
        }
        let last = store
            .read(&EntryId::new("c_entry").unwrap())
            .unwrap()
            .unwrap();
        store
            .family_apply(
                &MutationRequest {
                    operation_id: OperationId::new("delete_c").unwrap(),
                    mutation: Mutation::Delete {
                        id: last.state.id,
                        expected: last.state.revision,
                        recursive: false,
                    },
                },
                None,
            )
            .unwrap();
        (dir, store)
    }
    fn database(db: &Connection) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
        let names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").unwrap()
            .query_map([], |row| row.get::<_, String>(0)).unwrap()
            .collect::<std::result::Result<Vec<_>, _>>().unwrap();
        names
            .into_iter()
            .map(|name| {
                assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
                let mut query = db
                    .prepare(&format!("SELECT * FROM {name} ORDER BY rowid"))
                    .unwrap();
                let columns = query.column_count();
                let rows = query
                    .query_map([], |row| {
                        (0..columns)
                            .map(|column| row.get(column))
                            .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
                    })
                    .unwrap()
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .unwrap();
                (name, rows)
            })
            .collect()
    }
    #[test]
    fn preparation_reuses_one_complete_text_snapshot_including_tombstones() {
        let (_dir, mut store) = snapshot_fixture();
        let original = database(&store.connection);
        let sequence: i64 = store
            .connection
            .query_row("SELECT max(sequence) FROM operations", [], |r| r.get(0))
            .unwrap();
        let request = text("new_entry", "new.md");
        let tx = store.connection.unchecked_transaction().unwrap();
        let graph = graph(&tx, &scope(&tx).unwrap()).unwrap();
        let verified = blob_index::verify_metadata(&tx, &graph, &[]).unwrap();
        let reads = TextSnapshotReads::new(&tx);
        // The former production shape performs two actual snapshot queries.
        family_materialization::validate(&tx, &graph, &verified).unwrap();
        let expected = family_ingress::retained_texts(&tx, graph.scope()).unwrap();
        assert_eq!(reads.get(), 2);
        reads.reset();
        let prepared = prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).unwrap();
        assert_eq!(
            reads.get(),
            1,
            "preparation loaded the complete Text snapshot twice"
        );
        assert_eq!(prepared.expected_texts, expected);
        assert_eq!(
            expected
                .iter()
                .map(|s| s.identity.entry_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a_entry", "b_entry", "c_entry"]
        );
        let hidden = expected
            .iter()
            .find(|s| s.identity.entry_id.as_str() == "c_entry")
            .unwrap();
        assert_eq!(hidden.materialized_utf8().unwrap(), b"original");
        let visible: i64 = tx
            .query_row("SELECT visible FROM entries WHERE id='c_entry'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(visible, 0);
        assert!(matches!(
            family_materialization::get(&tx, &hidden.identity.entry_id)
                .unwrap()
                .unwrap()
                .publication,
            FamilyPublication::Tombstone
        ));
        drop(reads);
        tx.commit().unwrap();
        assert_eq!(database(&store.connection), original);
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let receipt = commit_prepared(&tx, &prepared).unwrap();
        assert_eq!(receipt.changes, prepared.changes);
        assert_eq!(receipt.sequence, sequence as u64 + 1);
        tx.commit().unwrap();
        let committed = database(&store.connection);
        assert_eq!(
            store
                .family_apply(&request, Some(FamilyCreateMode::Text))
                .unwrap(),
            receipt
        );
        assert_eq!(database(&store.connection), committed);
    }
    #[test]
    fn hidden_text_or_history_corruption_still_rejects_preparation_and_writer() {
        for corruption in [
            "entry",
            "scope",
            "bootstrap",
            "actors",
            "snapshot",
            "history",
        ] {
            let (_dir, mut store) = snapshot_fixture();
            let request = text("new_entry", "new.md");
            let tx = store.connection.unchecked_transaction().unwrap();
            let prepared = prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).unwrap();
            tx.commit().unwrap();
            let id = EntryId::new("c_entry").unwrap();
            if corruption == "history" {
                let mut record = family_materialization::get(&store.connection, &id)
                    .unwrap()
                    .unwrap();
                record.identity.bootstrap_id = UpdateId::new("different_history").unwrap();
                store
                    .connection
                    .execute(
                        "UPDATE family_materialization_history SET record=?1 WHERE entry_id=?2",
                        params![serde_json::to_string(&record).unwrap(), id.as_str()],
                    )
                    .unwrap();
            } else {
                let mut state = text_sync::retained(&store.connection, &id)
                    .unwrap()
                    .unwrap();
                let version = state.version.clone();
                match corruption {
                    "entry" => state.identity.entry_id = EntryId::new("different_entry").unwrap(),
                    "scope" => state.identity.realm_id = RealmId::new("different_realm").unwrap(),
                    "bootstrap" => {
                        state.identity.bootstrap_id = UpdateId::new("different_text").unwrap()
                    }
                    "actors" => {
                        assert!(!state.actors.is_empty());
                        state.actors.clear();
                    }
                    "snapshot" => state.snapshot = b"invalid snapshot".to_vec(),
                    _ => unreachable!(),
                }
                store
                    .connection
                    .execute(
                        "UPDATE text_revisions SET record=?1 WHERE entry_id=?2 AND revision=?3",
                        params![
                            serde_json::to_string(&state).unwrap(),
                            id.as_str(),
                            version.as_str()
                        ],
                    )
                    .unwrap();
            }
            let corrupted = database(&store.connection);
            let tx = store.connection.unchecked_transaction().unwrap();
            assert!(
                prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).is_err(),
                "{corruption}"
            );
            tx.rollback().unwrap();
            let tx = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            assert!(commit_prepared(&tx, &prepared).is_err(), "{corruption}");
            tx.rollback().unwrap();
            assert_eq!(database(&store.connection), corrupted, "{corruption}");
        }
    }
    #[test]
    fn text_head_only_change_after_preparation_keeps_fresh_writer_cas() {
        let (dir, mut store) = snapshot_fixture();
        let request = text("new_entry", "new.md");
        let tx = store.connection.unchecked_transaction().unwrap();
        let prepared = prepare_command(&tx, &request, Some(FamilyCreateMode::Text)).unwrap();
        tx.commit().unwrap();
        let before_entries = entries(&store.connection).unwrap();
        let mut peer = Store::open(dir.path().join("store")).unwrap();
        let tx = peer
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let old = text_sync::retained(&tx, &EntryId::new("c_entry").unwrap())
            .unwrap()
            .unwrap();
        let revision = Revision::new("peer_head_only_revision").unwrap();
        let next = old.rebind_revision(&old.version, &revision).unwrap();
        text_sync::reserve_revision(&tx, &revision).unwrap();
        text_sync::put_current(&tx, &next).unwrap();
        tx.commit().unwrap();
        let advanced = database(&store.connection);
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let actual_graph = graph(&tx, &scope(&tx).unwrap()).unwrap();
        prepared
            .graph
            .check_preconditions(&actual_graph, None)
            .unwrap();
        assert_eq!(entries(&tx).unwrap(), before_entries);
        assert_ne!(
            family_ingress::retained_texts(&tx, actual_graph.scope()).unwrap(),
            prepared.expected_texts
        );
        assert!(matches!(
            commit_prepared(&tx, &prepared),
            Err(StoreError::Sync(
                zorid_client_sync::SyncError::VersionConflict
            ))
        ));
        tx.rollback().unwrap();
        assert_eq!(database(&store.connection), advanced);
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

#[cfg(test)]
mod menu_authority_tests {
    use super::*;
    use zorid_core::{OperationId, VaultPath};
    use zorid_file_sync::mutation::{DestinationParent, FamilyCommand};
    use zorid_sync_protocol::{RealmId, VaultId};
    fn request(op: &str, mutation: Mutation) -> MutationRequest { MutationRequest { operation_id: OperationId::new(op).unwrap(), mutation } }
    fn setup() -> (tempfile::TempDir, Store, EntryState, EntryState) {
        let dir = tempfile::tempdir().unwrap(); let mut store = Store::open(dir.path().join("store")).unwrap();
        store.family_enroll(&Scope { realm_id: RealmId::new("realm").unwrap(), vault_id: VaultId::new("vault").unwrap() }).unwrap();
        let folder = store.family_apply(&request("folder-create", Mutation::Create { id: EntryId::new("folder").unwrap(), path: VaultPath::new("P").unwrap(), kind: EntryKind::Folder, content: None }), None).unwrap().changes.into_iter().find(|c| c.after.id.as_str() == "folder").unwrap().after;
        let source = store.family_apply(&request("source-create", Mutation::Create { id: EntryId::new("source").unwrap(), path: VaultPath::new("source.md").unwrap(), kind: EntryKind::File, content: Some(b"data".to_vec()) }), Some(FamilyCreateMode::Text)).unwrap().changes.into_iter().find(|c| c.after.id.as_str() == "source").unwrap().after;
        (dir, store, source, folder)
    }
    fn move_command(source: &EntryState, folder: &EntryState) -> FamilyCommand {
        FamilyCommand::new_with_parent(request("guarded-move", Mutation::Move { id: source.id.clone(), expected: source.revision.clone(), path: VaultPath::new("P/target.md").unwrap() }), None,
            Some(DestinationParent::Folder { id: folder.id.clone(), revision: folder.revision.clone(), path: folder.path.clone() })).unwrap()
    }
    fn move_parent(store: &mut Store, folder: &EntryState) {
        store.family_apply(&request("parent-move", Mutation::Move { id: folder.id.clone(), expected: folder.revision.clone(), path: VaultPath::new("Q").unwrap() }), None).unwrap();
    }
    #[test]
    fn parent_moved_before_preparation_rejects_without_operation() {
        let (_dir, mut store, source, folder) = setup(); let command = move_command(&source, &folder);
        move_parent(&mut store, &folder);
        assert!(store.family_apply_command_compact(&command).is_err());
        assert!(matches!(store.family_command_status(&command).unwrap(), FamilyCommandStatus::NotCommitted { .. }));
    }
    #[test]
    fn parent_changed_between_prepare_and_immediate_commit_cannot_publish() {
        let (_dir, mut store, source, folder) = setup(); let command = move_command(&source, &folder);
        let tx = store.connection.unchecked_transaction().unwrap();
        let prepared = prepare_family_command(&tx, &command).unwrap(); tx.commit().unwrap();
        move_parent(&mut store, &folder);
        let tx = store.connection.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        assert!(commit_prepared(&tx, &prepared).is_err()); tx.rollback().unwrap();
        assert!(matches!(store.family_command_status(&command).unwrap(), FamilyCommandStatus::NotCommitted { .. }));
    }
    #[test]
    fn original_replay_and_root_summary_survive_later_parent_move() {
        let (_dir, mut store, source, folder) = setup(); let command = move_command(&source, &folder);
        let receipt = store.family_apply_command_compact(&command).unwrap();
        let before = store.family_command_status(&command).unwrap();
        let FamilyCommandStatus::Committed { source: original, target, sequence, change_count, projection, .. } = &before else { panic!("committed") };
        assert_eq!(original.as_ref(), Some(&source)); assert_eq!(target.path.as_str(), "P/target.md");
        assert_eq!(sequence, &receipt.sequence.to_string()); assert_eq!(change_count, &receipt.changes.len().to_string());
        assert_eq!(*projection, FamilyCommandProjection::Pending);
        let folder_after = receipt.changes.iter().find(|c| c.after.id == folder.id).unwrap().after.clone();
        move_parent(&mut store, &folder_after);
        assert_eq!(store.family_apply_command_compact(&command).unwrap(), receipt);
        assert_eq!(store.family_command_status(&command).unwrap(), before);
        let mut changed = command.clone();
        changed.destination_parent = Some(DestinationParent::Folder { id: folder.id, revision: folder_after.revision, path: folder.path });
        assert!(matches!(store.family_command_status(&changed), Err(StoreError::Contract(ContractError::IdempotencyConflict { .. }))));
    }
    #[test]
    fn original_projection_requires_exact_logical_job_and_retained_completion() {
        let (_dir, mut store, source, folder) = setup(); let command = move_command(&source, &folder);
        let receipt = store.family_apply_command_compact(&command).unwrap();
        let tx = store.connection.unchecked_transaction().unwrap();
        assert!(!projection_jobs::original_local_completed(&tx, &command.request, &receipt).unwrap());
        let jobs: Vec<String> = tx.prepare("SELECT job_id FROM projection_jobs WHERE entry_id=?1").unwrap().query_map([source.id.as_str()], |r| r.get(0)).unwrap().collect::<std::result::Result<_,_>>().unwrap();
        let job = jobs.into_iter().map(|id| projection_jobs::get(&tx, &OperationId::new(id).unwrap()).unwrap()).find(|job| matches!(&job.origin, ProjectionOrigin::LocalCommand { operation_id } if operation_id == &command.request.operation_id)).unwrap();
        projection_jobs::finish(&tx, &job).unwrap(); tx.commit().unwrap();
        assert!(matches!(store.family_command_status(&command).unwrap(), FamilyCommandStatus::Committed { projection: FamilyCommandProjection::Settled, .. }));
        let tx = store.connection.unchecked_transaction().unwrap();
        tx.execute("DELETE FROM projection_jobs WHERE job_id=?1", [job.job_id.as_str()]).unwrap(); tx.commit().unwrap();
        assert!(matches!(store.family_command_status(&command), Err(StoreError::Corrupt(_))));
    }
    #[test]
    fn legacy_unguarded_command_keeps_exact_replay_but_cannot_fresh_compact_move() {
        let (_dir, mut store, source, folder) = setup(); let mut command = move_command(&source, &folder); command.destination_parent = None;
        assert!(store.family_apply_command_compact(&command).is_err());
        let receipt = store.family_apply(&command.request, command.create_mode).unwrap();
        assert_eq!(store.family_apply_command_compact(&command).unwrap(), receipt);
        assert!(matches!(store.family_command_status(&command).unwrap(), FamilyCommandStatus::Committed { .. }));
    }
    #[test]
    fn replacement_parent_at_same_path_does_not_rebind_selected_identity() {
        let (_dir, mut store, source, folder) = setup(); let command = move_command(&source, &folder);
        store.family_apply(&request("parent-delete", Mutation::Delete { id: folder.id, expected: folder.revision, recursive: false }), None).unwrap();
        store.family_apply(&request("parent-replacement", Mutation::Create { id: EntryId::new("replacement").unwrap(), path: VaultPath::new("P").unwrap(), kind: EntryKind::Folder, content: None }), None).unwrap();
        assert!(store.family_apply_command_compact(&command).is_err());
        assert!(matches!(store.family_command_status(&command).unwrap(), FamilyCommandStatus::NotCommitted { .. }));
    }
    #[test]
    fn status_rejects_mismatched_sequence_and_same_origin_wrong_job_shape() {
        let (_dir, mut store, source, folder) = setup(); let command = move_command(&source, &folder);
        let receipt = store.family_apply_command_compact(&command).unwrap();
        let tx = store.connection.unchecked_transaction().unwrap();
        let raw: String = tx.query_row("SELECT result FROM operations WHERE operation_id=?1", [command.request.operation_id.as_str()], |row| row.get(0)).unwrap();
        let mut broken = receipt.clone(); broken.sequence += 1;
        tx.execute("UPDATE operations SET result=?1 WHERE operation_id=?2", params![serde_json::to_string(&broken).unwrap(), command.request.operation_id.as_str()]).unwrap(); tx.commit().unwrap();
        assert!(matches!(store.family_command_status(&command), Err(StoreError::Corrupt(_))));
        let tx = store.connection.unchecked_transaction().unwrap();
        tx.execute("UPDATE operations SET result=?1 WHERE operation_id=?2", params![raw, command.request.operation_id.as_str()]).unwrap();
        let target = receipt.changes.iter().find(|change| change.after.id == source.id).unwrap().after.clone();
        let mut wrong = target.clone(); wrong.path = VaultPath::new("elsewhere.md").unwrap();
        projection_jobs::insert(&tx, ProjectionJob { job_id: OperationId::new("wrong-same-origin").unwrap(), ordinal: "0".into(), origin: ProjectionOrigin::LocalCommand { operation_id: command.request.operation_id.clone() }, work: ProjectionWork::Move, target: wrong.clone(), affected: vec![zorid_core::EntryChange { before: Some(source), after: wrong }], completed: true }, None).unwrap(); tx.commit().unwrap();
        assert!(matches!(store.family_command_status(&command), Err(StoreError::Corrupt(_))));
    }

}
