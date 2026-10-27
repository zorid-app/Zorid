//! Trusted native text entrypoints. Public callers supply commands or an
//! authenticated payload, never a caller-fabricated next-state plan.
use super::*;
use zorid_client_sync::{
    ActorOwner, ActorRegistration, AuthenticatedText, AuthorRequest, AuthoredPlan, AuthoredUpdate,
    ReceiveCursor, ReceiveRequest, ReceivedRecord, TextBaseline, TextIdentity, TextState,
};
use zorid_core::{EntryChange, OperationId};
use zorid_crypto::{SystemEntropy, VaultKey};
use zorid_sync_protocol::{
    DeviceId, Envelope, ExpectedContext, Header, RealmId, UpdateId, VaultId,
};
pub(super) const SCHEMA:&[(&str,&str)]=&[
    ("revision_fences","CREATE TABLE revision_fences (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, revision TEXT NOT NULL UNIQUE)"),
    ("authority_identity","CREATE TABLE authority_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), local_store_id TEXT NOT NULL, realm_id TEXT, vault_id TEXT, CHECK((realm_id IS NULL)=(vault_id IS NULL)))"),
    ("text_bindings","CREATE TABLE text_bindings (entry_id TEXT PRIMARY KEY, realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, bootstrap_id TEXT NOT NULL, revision TEXT NOT NULL)"),
    ("text_revisions","CREATE TABLE text_revisions (entry_id TEXT NOT NULL, revision TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(entry_id,revision))"),
    ("sync_updates","CREATE TABLE sync_updates (realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, update_id TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), bootstrap_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('authored','received')), wire BLOB NOT NULL, PRIMARY KEY(realm_id,vault_id,update_id))"),
    ("authored_text","CREATE TABLE authored_text (realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, update_id TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), record TEXT NOT NULL, sealed BLOB, accepted INTEGER NOT NULL CHECK(accepted IN (0,1)), PRIMARY KEY(realm_id,vault_id,update_id))"),
    ("receive_cursors","CREATE TABLE receive_cursors (realm_id TEXT NOT NULL, vault_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(realm_id,vault_id))"),
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityIdentity {
    pub local_store_id: OperationId,
    pub realm_id: Option<RealmId>,
    pub vault_id: Option<VaultId>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextReceiveOutcome {
    pub identity: TextIdentity,
    pub update_id: UpdateId,
    pub revision: Revision,
    pub changed: bool,
    pub cursor: Option<ReceiveCursor>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoredTextStatus {
    pub identity: TextIdentity,
    pub update_id: UpdateId,
    pub sealed: bool,
    pub accepted: bool,
}
pub(super) fn migrate(tx: &Connection) -> Result<()> {
    for (_, sql) in SCHEMA {
        tx.execute_batch(sql)?;
    }
    let mut used = std::collections::BTreeSet::new();
    for state in read_states(tx, true)? {
        used.insert(state.revision);
    }
    let receipts = tx
        .prepare("SELECT result FROM operations")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for json in receipts {
        let result: CommitResult = serde_json::from_str(&json)?;
        result.validate()?;
        for change in result.changes {
            used.insert(change.after.revision);
            if let Some(before) = change.before {
                used.insert(before.revision);
            }
        }
    }
    let events = tx
        .prepare("SELECT record FROM local_changes")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for json in events {
        let event: LocalChange = serde_json::from_str(&json)?;
        for entry in event.entries {
            used.insert(entry.state.revision);
        }
    }
    for revision in used {
        tx.execute(
            "INSERT INTO revision_fences(revision) VALUES(?1)",
            [revision.as_str()],
        )?;
    }
    tx.execute(
        "INSERT INTO authority_identity(singleton,local_store_id) VALUES(1,?1)",
        [uuid::Uuid::new_v4().to_string()],
    )?;
    Ok(())
}
pub(super) fn identity(tx: &Connection) -> Result<AuthorityIdentity> {
    let (local, realm, vault): (String, Option<String>, Option<String>) = tx.query_row(
        "SELECT local_store_id,realm_id,vault_id FROM authority_identity WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if uuid::Uuid::parse_str(&local)
        .ok()
        .is_none_or(|id| id.hyphenated().to_string() != local)
    {
        return Err(StoreError::Corrupt(
            "local authority is not a canonical UUID".into(),
        ));
    }
    if realm.is_some() != vault.is_some() {
        return Err(StoreError::Corrupt(
            "partial logical authority binding".into(),
        ));
    }
    Ok(AuthorityIdentity {
        local_store_id: OperationId::new(local)?,
        realm_id: realm.map(RealmId::new).transpose()?,
        vault_id: vault.map(VaultId::new).transpose()?,
    })
}
fn bind_scope(tx: &Connection, text: &TextIdentity) -> Result<()> {
    family_store::reject_legacy_mutation(tx)?;
    let current = identity(tx)?;
    match (&current.realm_id, &current.vault_id) {
        (None, None) => {
            tx.execute(
                "UPDATE authority_identity SET realm_id=?1,vault_id=?2 WHERE singleton=1",
                params![text.realm_id.as_str(), text.vault_id.as_str()],
            )?;
        }
        (Some(realm), Some(vault)) if realm == &text.realm_id && vault == &text.vault_id => {}
        _ => return Err(zorid_client_sync::SyncError::IdentityMismatch.into()),
    }
    Ok(())
}
/// Commit revisions are vault-wide tokens because file changes also advance
/// shared ancestors. Attaching causal provenance to old tokens does not allocate.
pub(super) fn reserve_revision(tx: &Connection, revision: &Revision) -> Result<()> {
    storage_accounting::check_revisions(tx)?;
    let used: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM revision_fences WHERE revision=?1)",
        [revision.as_str()],
        |r| r.get(0),
    )?;
    if used {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    tx.execute(
        "INSERT INTO revision_fences(revision) VALUES(?1)",
        [revision.as_str()],
    )?;
    Ok(())
}
fn stored_entry(tx: &Connection, id: &EntryId) -> Result<StoredEntry> {
    let entry = entry_content::read_legacy_entry(tx, id)?
        .ok_or_else(|| ContractError::EntryNotFound { id: id.clone() })?;
    if entry.state.kind != EntryKind::File {
        return Err(ContractError::InvalidMutation {
            reason: "managed text target must be a file".into(),
        }
        .into());
    }
    Ok(entry)
}

pub(super) fn revision(
    tx: &Connection,
    id: &EntryId,
    version: &Revision,
) -> Result<Option<TextState>> {
    tx.query_row(
        "SELECT record FROM text_revisions WHERE entry_id=?1 AND revision=?2",
        params![id.as_str(), version.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|json| {
        let state: TextState = serde_json::from_str(&json)?;
        if state.identity.entry_id != *id || state.version != *version {
            return Err(StoreError::Corrupt(
                "text revision identity mismatch".into(),
            ));
        }
        state.materialized_utf8()?;
        Ok(state)
    })
    .transpose()
}
/// The CRDT identity/head is retained independently of visible namespace state.
/// This is also the loader for authenticated text arriving before its Create.
pub(super) fn retained(tx: &Connection, id: &EntryId) -> Result<Option<TextState>> {
    let binding = tx
        .query_row(
            "SELECT realm_id,vault_id,bootstrap_id,revision FROM text_bindings WHERE entry_id=?1",
            [id.as_str()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    if binding.is_none() {
        let orphan:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM text_revisions WHERE entry_id=?1 UNION ALL SELECT 1 FROM authored_text WHERE entry_id=?1 UNION ALL SELECT 1 FROM sync_updates WHERE entry_id=?1)",[id.as_str()],|r|r.get(0))?;
        if orphan {
            return Err(StoreError::Corrupt(
                "managed text history has no current binding".into(),
            ));
        }
    }
    binding
        .map(|(realm, vault, bootstrap, version)| {
            let state = revision(tx, id, &Revision::new(version)?)?
                .ok_or_else(|| StoreError::Corrupt("managed text revision missing".into()))?;
            if state.identity.realm_id.as_str() != realm
                || state.identity.vault_id.as_str() != vault
                || state.identity.bootstrap_id.as_str() != bootstrap
            {
                return Err(StoreError::Corrupt(
                    "managed text and committed entry disagree".into(),
                ));
            }
            let authority = identity(tx)?;
            if authority.realm_id.as_ref() != Some(&state.identity.realm_id)
                || authority.vault_id.as_ref() != Some(&state.identity.vault_id)
            {
                return Err(StoreError::Corrupt(
                    "managed text authority mismatch".into(),
                ));
            }
            Ok(state)
        })
        .transpose()
}
pub(super) fn current(tx: &Connection, id: &EntryId) -> Result<Option<TextState>> {
    family_store::reject_legacy_mutation(tx)?;
    let state = retained(tx, id)?;
    if let Some(state) = &state {
        let entry = stored_entry(tx, id)?;
        if state.version != entry.state.revision
            || Some(state.materialized_utf8()?) != entry.content
        {
            return Err(StoreError::Corrupt(
                "managed text and committed entry disagree".into(),
            ));
        }
    }
    Ok(state)
}
pub(super) fn put_revision(tx: &Connection, state: &TextState) -> Result<()> {
    if revision(tx, &state.identity.entry_id, &state.version)?.is_some() {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    state.materialized_utf8()?;
    tx.execute(
        "INSERT INTO text_revisions VALUES(?1,?2,?3)",
        params![
            state.identity.entry_id.as_str(),
            state.version.as_str(),
            serde_json::to_string(state)?
        ],
    )?;
    Ok(())
}
pub(super) fn put_current(tx: &Connection, state: &TextState) -> Result<()> {
    let prior: Option<(String, String, String)> = tx
        .query_row(
            "SELECT realm_id,vault_id,bootstrap_id FROM text_bindings WHERE entry_id=?1",
            [state.identity.entry_id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((realm, vault, bootstrap)) = prior {
        if realm != state.identity.realm_id.as_str()
            || vault != state.identity.vault_id.as_str()
            || bootstrap != state.identity.bootstrap_id.as_str()
        {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
    }
    put_revision(tx, state)?;
    let i = &state.identity;
    tx.execute("INSERT INTO text_bindings VALUES(?1,?2,?3,?4,?5) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision",params![i.entry_id.as_str(),i.realm_id.as_str(),i.vault_id.as_str(),i.bootstrap_id.as_str(),state.version.as_str()])?;
    Ok(())
}
pub(super) fn baseline(
    tx: &Connection,
    physical: &ProjectionBaseline,
) -> Result<Option<TextBaseline>> {
    revision(tx, &physical.state.id, &physical.state.revision)?
        .map(|state| {
            let bytes = state.materialized_utf8()?;
            if physical.content.inline_bytes() != Some(bytes.as_slice()) {
                return Err(StoreError::Corrupt(
                    "physical baseline bytes and causal revision disagree".into(),
                ));
            }
            Ok(TextBaseline {
                state,
                materialized_utf8: bytes,
            })
        })
        .transpose()
}
fn update_record(
    tx: &Connection,
    realm: &RealmId,
    vault: &VaultId,
    update: &UpdateId,
) -> Result<Option<ReceivedRecord>> {
    tx.query_row("SELECT entry_id,bootstrap_id,wire FROM sync_updates WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",params![realm.as_str(),vault.as_str(),update.as_str()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Vec<u8>>(2)?))).optional()?.map(|(entry,bootstrap,wire)|{
        let envelope=Envelope::decode(&wire)?;if envelope.header().realm_id()!=realm||envelope.header().vault_id()!=vault||envelope.header().update_id()!=update{return Err(StoreError::Corrupt("stored envelope ledger header mismatch".into()));}
        Ok(ReceivedRecord{identity:TextIdentity{realm_id:realm.clone(),vault_id:vault.clone(),entry_id:EntryId::new(entry)?,bootstrap_id:UpdateId::new(bootstrap)?},update_id:update.clone(),exact_wire:wire})
    }).transpose()
}
fn unused(tx: &Connection, text: &TextIdentity, id: &UpdateId) -> Result<bool> {
    let n:i64=tx.query_row("SELECT (SELECT count(*) FROM sync_updates WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3)+(SELECT count(*) FROM authored_text WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3)",params![text.realm_id.as_str(),text.vault_id.as_str(),id.as_str()],|r|r.get(0))?;
    Ok(n == 0)
}
fn author_request(tx: &Connection, state: &TextState, next: &Revision) -> Result<AuthorRequest> {
    let authority = identity(tx)?;
    for _ in 0..64 {
        let random = uuid::Uuid::new_v4();
        let b = random.as_bytes();
        let actor = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        let update_id = UpdateId::new(uuid::Uuid::new_v4().to_string())?;
        if state.actors.contains_key(&actor) || !unused(tx, &state.identity, &update_id)? {
            continue;
        }
        return Ok(AuthorRequest {
            expected_version: state.version.clone(),
            next_version: next.clone(),
            update_id,
            actor: ActorRegistration {
                actor,
                owner: ActorOwner {
                    replica_id: DeviceId::new(authority.local_store_id.as_str())?,
                    incarnation_id: OperationId::new(uuid::Uuid::new_v4().to_string())?,
                },
            },
            edits: vec![],
        });
    }
    Err(zorid_client_sync::SyncError::ActorCollision.into())
}
pub(super) struct PreparedText {
    pub plan: AuthoredPlan,
    pub adoption_history: Option<TextState>,
}
pub(super) fn prepare_local(
    tx: &Connection,
    command: &MutationRequest,
    next: &Revision,
    adoption: Option<&TextIdentity>,
) -> Result<Option<PreparedText>> {
    let existing = current(tx, command.mutation.id())?;
    if existing.is_none() && adoption.is_none() {
        return Ok(None);
    }
    let Mutation::Write {
        id,
        expected,
        content,
    } = &command.mutation
    else {
        return Err(ContractError::InvalidMutation {
            reason: "managed text namespace mutation requires namespace integration".into(),
        }
        .into());
    };
    let entry = stored_entry(tx, id)?;
    if &entry.state.revision != expected {
        return Err(ContractError::RevisionConflict {
            id: id.clone(),
            expected: expected.clone(),
            actual: entry.state.revision,
        }
        .into());
    }
    let is_adoption = adoption.is_some();
    let state = if let Some(identity) = adoption {
        if existing.is_some() || identity.entry_id != *id || entry.content.as_ref() != Some(content)
        {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
        bind_scope(tx, identity)?;
        TextState::empty(identity.clone(), expected.clone())
    } else {
        existing.unwrap()
    };
    let request = author_request(tx, &state, next)?;
    let plan = zorid_client_sync::plan_replace_text(&state, content, &request)?;
    plan.check_preconditions(
        &state,
        None,
        unused(tx, &state.identity, &plan.authored.update_id)?,
    )?;
    let adoption_history = if is_adoption {
        let mut initial = plan.next_state.clone();
        initial.version = expected.clone();
        Some(initial)
    } else {
        None
    };
    Ok(Some(PreparedText {
        plan,
        adoption_history,
    }))
}
pub(super) fn finish_local(tx: &Connection, text: PreparedText) -> Result<()> {
    if let Some(initial) = text.adoption_history {
        put_revision(tx, &initial)?;
    }
    put_current(tx, &text.plan.next_state)?;
    let update = text.plan.authored;
    tx.execute("INSERT INTO authored_text(realm_id,vault_id,update_id,entry_id,record,accepted) VALUES(?1,?2,?3,?4,?5,0)",params![update.identity.realm_id.as_str(),update.identity.vault_id.as_str(),update.update_id.as_str(),update.identity.entry_id.as_str(),serde_json::to_string(&update)?])?;
    Ok(())
}
fn cursor(tx: &Connection, realm: &RealmId, vault: &VaultId) -> Result<Option<ReceiveCursor>> {
    tx.query_row(
        "SELECT record FROM receive_cursors WHERE realm_id=?1 AND vault_id=?2",
        params![realm.as_str(), vault.as_str()],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|json| {
        let value: ReceiveCursor = serde_json::from_str(&json)?;
        if &value.realm_id != realm || &value.vault_id != vault {
            return Err(StoreError::Corrupt("receive cursor scope mismatch".into()));
        }
        Ok(value)
    })
    .transpose()
}
fn put_record(tx: &Connection, record: &ReceivedRecord, direction: &str) -> Result<()> {
    let i = &record.identity;
    tx.execute(
        "INSERT INTO sync_updates VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            i.realm_id.as_str(),
            i.vault_id.as_str(),
            record.update_id.as_str(),
            i.entry_id.as_str(),
            i.bootstrap_id.as_str(),
            direction,
            &record.exact_wire
        ],
    )?;
    Ok(())
}
impl Store {
    pub fn identity(&self) -> Result<AuthorityIdentity> {
        identity(&self.connection)
    }
    pub fn text_state(&self, id: &EntryId) -> Result<Option<TextState>> {
        let tx = self.connection.unchecked_transaction()?;
        let state = current(&tx, id)?;
        tx.commit()?;
        Ok(state)
    }
    pub fn text_baseline(&self, physical: &ProjectionBaseline) -> Result<Option<TextBaseline>> {
        baseline(&self.connection, physical)
    }
    /// Explicitly bind an already-existing empty file to a trusted bootstrap.
    /// Incoming payloads never create a path or silently replace this identity.
    pub fn bind_empty_text(
        &mut self,
        text: &TextIdentity,
        expected: &Revision,
    ) -> Result<TextState> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(current) = current(&tx, &text.entry_id)? {
            if current.identity != *text {
                return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
            }
            tx.commit()?;
            return Ok(current);
        }
        let entry = stored_entry(&tx, &text.entry_id)?;
        if entry.state.revision != *expected {
            return Err(ContractError::RevisionConflict {
                id: text.entry_id.clone(),
                expected: expected.clone(),
                actual: entry.state.revision,
            }
            .into());
        }
        if entry.content.as_deref() != Some(&[]) {
            return Err(ContractError::InvalidMutation {
                reason: "nonempty file requires explicit authored adoption".into(),
            }
            .into());
        }
        bind_scope(&tx, text)?;
        let state = TextState::empty(text.clone(), expected.clone());
        put_current(&tx, &state)?;
        tx.commit()?;
        Ok(state)
    }
    pub fn adopt_text(
        &mut self,
        text: &TextIdentity,
        command: &MutationRequest,
    ) -> Result<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !matches!(&command.mutation,Mutation::Write{id,..} if id==&text.entry_id) {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
        let binding = current(&tx, &text.entry_id)?;
        if binding.is_none()
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id=?1)",
                [command.operation_id.as_str()],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(ContractError::IdempotencyConflict {
                operation_id: command.operation_id.clone(),
            }
            .into());
        }
        if let Some(old) = binding {
            if old.identity != *text {
                return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
            }
        }
        let result = Self::apply_transaction_text(&tx, command, None, Some(text), None, None)?;
        tx.commit()?;
        Ok(result)
    }
    /// Initialize/change an ordered delivery cursor explicitly; keep the global
    /// received ledger across server epoch recovery. No upload ACK calls this.
    pub fn text_receive_cursor(
        &self,
        realm: &RealmId,
        vault: &VaultId,
    ) -> Result<Option<ReceiveCursor>> {
        let tx = self.connection.unchecked_transaction()?;
        let authority = identity(&tx)?;
        if authority.realm_id.as_ref() != Some(realm) || authority.vault_id.as_ref() != Some(vault)
        {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
        let value = cursor(&tx, realm, vault)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn set_text_receive_cursor(
        &mut self,
        expected: Option<&ReceiveCursor>,
        next: &ReceiveCursor,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authority = identity(&tx)?;
        if authority.realm_id.as_ref() != Some(&next.realm_id)
            || authority.vault_id.as_ref() != Some(&next.vault_id)
        {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
        if cursor(&tx, &next.realm_id, &next.vault_id)?.as_ref() != expected {
            return Err(zorid_client_sync::SyncError::CursorConflict.into());
        }
        tx.execute("INSERT INTO receive_cursors VALUES(?1,?2,?3) ON CONFLICT(realm_id,vault_id) DO UPDATE SET record=excluded.record",params![next.realm_id.as_str(),next.vault_id.as_str(),serde_json::to_string(next)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn receive_text(
        &mut self,
        incoming: &AuthenticatedText,
        request: &ReceiveRequest,
    ) -> Result<TextReceiveOutcome> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let scope = incoming.identity();
        let current =
            current(&tx, &scope.entry_id)?.ok_or(zorid_client_sync::SyncError::IdentityMismatch)?;
        let prior = update_record(&tx, &scope.realm_id, &scope.vault_id, incoming.update_id())?;
        if prior.is_none() && !unused(&tx, scope, incoming.update_id())? {
            return Err(zorid_client_sync::SyncError::DedupeMismatch.into());
        }
        let before_cursor = cursor(&tx, &scope.realm_id, &scope.vault_id)?;
        let plan = zorid_client_sync::plan_received_text(
            &current,
            request,
            incoming,
            prior.as_ref(),
            before_cursor.as_ref(),
        )?;
        plan.check_preconditions(&current, prior.as_ref(), before_cursor.as_ref())?;
        if prior.is_none() {
            put_record(&tx, &plan.received_record, "received")?;
        }
        let changed = plan.next_state.is_some();
        let mut revision = current.version.clone();
        if let Some(next) = plan.next_state {
            reserve_revision(&tx, &next.version)?;
            let bytes = plan.materialized_utf8.ok_or_else(|| {
                StoreError::Corrupt("received plan lacks materialized bytes".into())
            })?;
            if next.materialized_utf8()? != bytes {
                return Err(StoreError::Corrupt(
                    "received materialization mismatch".into(),
                ));
            }
            let entries = read_states(&tx, true)?;
            let changes = zorid_core::plan_file_materialization(
                &scope.entry_id,
                &current.version,
                &next.version,
                &entries,
            )?;
            for change in &changes {
                presentation::presentation(
                    &tx,
                    change
                        .before
                        .as_ref()
                        .ok_or_else(|| StoreError::Corrupt("receive created namespace".into()))?,
                )?;
                let content = if change.after.id == scope.entry_id {
                    Some(bytes.clone())
                } else {
                    stored_entry_content(&tx, &change.after.id)?
                };
                tx.execute(
                    "UPDATE entries SET state=?1,content=?2,content_ref=NULL,content_digest=?4 WHERE id=?3",
                    params![
                        serde_json::to_string(&change.after)?,
                        content,
                        change.after.id.as_str(),
                        content.as_ref().map(|bytes| serde_json::to_string(&Sha256Digest::of(bytes))).transpose()?
                    ],
                )?;
            }
            put_current(&tx, &next)?;
            let origin = ChangeOrigin::ReceivedUpdate {
                realm_id: scope.realm_id.as_str().into(),
                vault_id: scope.vault_id.as_str().into(),
                update_id: incoming.update_id().as_str().into(),
            };
            presentation::record_changes(&tx, origin, &changes, presentation::now_ms()?)?;
            let target = changes
                .iter()
                .find(|c| c.after.id == scope.entry_id)
                .ok_or_else(|| StoreError::Corrupt("received file change missing".into()))?
                .clone();
            projection_jobs::enqueue_received(
                &tx,
                ProjectionOrigin::ReceivedUpdate {
                    realm_id: scope.realm_id.as_str().into(),
                    vault_id: scope.vault_id.as_str().into(),
                    update_id: incoming.update_id().as_str().into(),
                },
                target,
            )?;
            revision = next.version;
        }
        if let Some(advance) = plan.cursor_advance {
            tx.execute("INSERT INTO receive_cursors VALUES(?1,?2,?3) ON CONFLICT(realm_id,vault_id) DO UPDATE SET record=excluded.record",params![scope.realm_id.as_str(),scope.vault_id.as_str(),serde_json::to_string(&advance.next)?])?;
        }
        let outcome = TextReceiveOutcome {
            identity: scope.clone(),
            update_id: incoming.update_id().clone(),
            revision,
            changed,
            cursor: cursor(&tx, &scope.realm_id, &scope.vault_id)?,
        };
        tx.commit()?;
        Ok(outcome)
    }
}
fn stored_entry_content(tx: &Connection, id: &EntryId) -> Result<Option<Vec<u8>>> {
    let entry = entry_content::read_content_entry(tx, id)?
        .ok_or_else(|| StoreError::Corrupt("text sibling entry missing".into()))?;
    match entry.1 {
        None => Ok(None),
        Some(StoredContent::InlineBytes(bytes)) => Ok(Some(bytes)),
        Some(StoredContent::BinaryRef(_)) => Err(StoreError::Corrupt(
            "text receive cannot inline a binary sibling".into(),
        )),
    }
}

pub(super) fn check_namespace(
    tx: &Connection,
    request: &MutationRequest,
    changes: &[EntryChange],
) -> Result<()> {
    if matches!(
        request.mutation,
        Mutation::Move { .. } | Mutation::Delete { .. }
    ) {
        for change in changes {
            let managed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM text_bindings WHERE entry_id=?1)",
                [change.after.id.as_str()],
                |r| r.get(0),
            )?;
            if managed {
                return Err(ContractError::InvalidMutation {
                    reason: "managed text namespace mutation requires namespace integration".into(),
                }
                .into());
            }
        }
    }
    Ok(())
}

fn authored(
    tx: &Connection,
    realm: &RealmId,
    vault: &VaultId,
    update: &UpdateId,
) -> Result<(AuthoredUpdate, Option<Vec<u8>>, bool)> {
    let (entry,json,sealed,accepted):(String,String,Option<Vec<u8>>,i64)=tx.query_row("SELECT entry_id,record,sealed,accepted FROM authored_text WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",params![realm.as_str(),vault.as_str(),update.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let record: AuthoredUpdate = serde_json::from_str(&json)?;
    if record.identity.realm_id != *realm
        || record.identity.vault_id != *vault
        || record.identity.entry_id.as_str() != entry
        || record.update_id != *update
        || !matches!(accepted, 0 | 1)
        || accepted == 1 && sealed.is_none()
    {
        return Err(StoreError::Corrupt(
            "authored text identity/outcome mismatch".into(),
        ));
    }
    if let Some(wire) = &sealed {
        let ledger = update_record(tx, realm, vault, update)?.ok_or_else(|| {
            StoreError::Corrupt("sealed authored update lacks global ledger".into())
        })?;
        if ledger.identity != record.identity || ledger.exact_wire != *wire {
            return Err(StoreError::Corrupt(
                "sealed authored update differs from global ledger".into(),
            ));
        }
    }
    Ok((record, sealed, accepted == 1))
}
impl Store {
    /// Only this persisted winning wire may be transmitted. A racing process
    /// discards its provisional ciphertext and returns the canonical winner.
    /// Keys/authorized context belong to the caller; this store never persists keys.
    pub fn seal_authored_text(
        &mut self,
        expected: &ExpectedContext,
        key: &VaultKey,
    ) -> Result<Vec<u8>> {
        let tx = self.connection.unchecked_transaction()?;
        let (record, sealed, _) = authored(
            &tx,
            &expected.realm_id,
            &expected.vault_id,
            &expected.update_id,
        )?;
        let authority = identity(&tx)?;
        tx.commit()?;
        if let Some(wire) = sealed {
            expected.check(Envelope::decode(&wire)?.header())?;
            return Ok(wire);
        }
        if authority.realm_id.as_ref() != Some(&expected.realm_id)
            || authority.vault_id.as_ref() != Some(&expected.vault_id)
        {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
        let header = Header::new(
            expected.realm_id.clone(),
            expected.vault_id.clone(),
            expected.update_id.clone(),
            DeviceId::new(authority.local_store_id.as_str())?,
            expected.key_epoch,
        )?;
        let candidate =
            zorid_crypto::seal(&header, &record.payload_bytes, key, &mut SystemEntropy)?.encode();
        let opened = AuthenticatedText::open(&candidate, expected, key)?;
        if opened.identity() != &record.identity || opened.update_id() != &record.update_id {
            return Err(StoreError::Corrupt(
                "authored payload identity mismatch".into(),
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (actual, sealed, _) = authored(
            &tx,
            &expected.realm_id,
            &expected.vault_id,
            &expected.update_id,
        )?;
        if actual != record {
            return Err(StoreError::Corrupt(
                "immutable authored payload changed".into(),
            ));
        }
        if let Some(wire) = sealed {
            expected.check(Envelope::decode(&wire)?.header())?;
            tx.commit()?;
            return Ok(wire);
        }
        if update_record(
            &tx,
            &expected.realm_id,
            &expected.vault_id,
            &expected.update_id,
        )?
        .is_some()
        {
            return Err(zorid_client_sync::SyncError::DedupeMismatch.into());
        }
        put_record(
            &tx,
            &ReceivedRecord {
                identity: record.identity.clone(),
                update_id: record.update_id.clone(),
                exact_wire: candidate.clone(),
            },
            "authored",
        )?;
        tx.execute(
            "UPDATE authored_text SET sealed=?1 WHERE realm_id=?2 AND vault_id=?3 AND update_id=?4",
            params![
                &candidate,
                expected.realm_id.as_str(),
                expected.vault_id.as_str(),
                expected.update_id.as_str()
            ],
        )?;
        tx.commit()?;
        Ok(candidate)
    }
    pub fn authored_text_status(
        &self,
        realm: &RealmId,
        vault: &VaultId,
        update: &UpdateId,
    ) -> Result<AuthoredTextStatus> {
        let tx = self.connection.unchecked_transaction()?;
        let (record, sealed, accepted) = authored(&tx, realm, vault, update)?;
        tx.commit()?;
        Ok(AuthoredTextStatus {
            identity: record.identity,
            update_id: record.update_id,
            sealed: sealed.is_some(),
            accepted,
        })
    }
    /// Stable UpdateId paging; later insertions require a subsequent sweep. No
    /// plaintext body or key is exposed by discovery. Accepted history is retained.
    pub fn pending_authored_text(
        &self,
        after: Option<&UpdateId>,
        limit: u32,
    ) -> Result<Vec<AuthoredTextStatus>> {
        if !(1..=1000).contains(&limit) {
            return Err(ContractError::InvalidMutation {
                reason: "authored page limit must be 1..=1000".into(),
            }
            .into());
        }
        let tx = self.connection.unchecked_transaction()?;
        let keys=tx.prepare("SELECT realm_id,vault_id,update_id FROM authored_text WHERE accepted=0 AND (?1 IS NULL OR update_id>?1) ORDER BY update_id LIMIT ?2")?.query_map(params![after.map(UpdateId::as_str),limit],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut statuses = Vec::new();
        for (realm, vault, update) in keys {
            let (record, sealed, accepted) = authored(
                &tx,
                &RealmId::new(realm)?,
                &VaultId::new(vault)?,
                &UpdateId::new(update)?,
            )?;
            statuses.push(AuthoredTextStatus {
                identity: record.identity,
                update_id: record.update_id,
                sealed: sealed.is_some(),
                accepted,
            });
        }
        tx.commit()?;
        Ok(statuses)
    }
    /// Upload acknowledgement never advances ordered receive cursors. Caller must
    /// have verified the server's acknowledgement for this exact immutable wire.
    pub fn acknowledge_authored_text(
        &mut self,
        realm: &RealmId,
        vault: &VaultId,
        update: &UpdateId,
        exact_wire: &[u8],
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (_, sealed, _) = authored(&tx, realm, vault, update)?;
        if sealed.as_deref() != Some(exact_wire) {
            return Err(zorid_client_sync::SyncError::DedupeMismatch.into());
        }
        tx.execute("UPDATE authored_text SET accepted=1 WHERE realm_id=?1 AND vault_id=?2 AND update_id=?3",params![realm.as_str(),vault.as_str(),update.as_str()])?;
        tx.commit()?;
        Ok(())
    }
}
impl Store {
    /// Reconcile a real external branch against its persisted causal baseline,
    /// merging into current state without replacing concurrently received edits.
    pub fn import_text_observation(&mut self, id: &OperationId) -> Result<CommitResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let json: String = tx.query_row(
            "SELECT record FROM external_observations WHERE observation_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        let mut observation = projection::decode_observation(id.as_str(), &json)?;
        if let Some(operation) = &observation.resolution {
            if operation != id {
                return Err(StoreError::Corrupt(
                    "text observation operation mismatch".into(),
                ));
            }
            let (request, result): (String, String) = tx.query_row(
                "SELECT request,result FROM operations WHERE operation_id=?1",
                [operation.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let record = operation_request::decode_inline_record(&request, &result, operation)?;
            check_idempotency(&record.request, Some(&record))?;
            if record.request.operation_id != *id
                || !matches!(&record.request.mutation,Mutation::Write{id:entry,..} if observation.baseline.as_ref().is_some_and(|b|b.state.id==*entry))
            {
                return Err(StoreError::Corrupt(
                    "resolved text observation receipt identity mismatch".into(),
                ));
            }
            tx.commit()?;
            return Ok(record.result);
        }
        let physical = observation
            .baseline
            .as_ref()
            .ok_or(zorid_client_sync::SyncError::InvalidState)?;
        if projection::baseline(&tx, &physical.state.id)?.as_ref() != Some(physical) {
            return Err(zorid_client_sync::SyncError::InvalidState.into());
        }
        let physical_proof = physical_bindings::check_observation(&tx, id, &physical.state.id)?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM projection_attempts WHERE entry_id=?1 AND completed=0)",
            [physical.state.id.as_str()],
            |r| r.get(0),
        )?;
        if active {
            return Err(zorid_client_sync::SyncError::InvalidState.into());
        }
        let baseline =
            baseline(&tx, physical)?.ok_or(zorid_client_sync::SyncError::InvalidState)?;
        let current = current(&tx, &physical.state.id)?
            .ok_or(zorid_client_sync::SyncError::IdentityMismatch)?;
        let entry = stored_entry(&tx, &physical.state.id)?;
        if entry.state.path != physical.state.path {
            return Err(zorid_client_sync::SyncError::InvalidState.into());
        }
        let merged_version = Revision::new(uuid::Uuid::new_v4().to_string())?;
        let observed_version = Revision::new(uuid::Uuid::new_v4().to_string())?;
        let request = author_request(&tx, &current, &merged_version)?;
        let plan = zorid_client_sync::plan_external_text_with_baseline(
            &current,
            &baseline,
            observation
                .content
                .inline_bytes()
                .ok_or(zorid_client_sync::SyncError::InvalidState)?,
            &request,
            &observed_version,
        )?;
        plan.authored.check_preconditions(
            &current,
            Some(&baseline),
            unused(&tx, &current.identity, &request.update_id)?,
        )?;
        let command = MutationRequest {
            operation_id: id.clone(),
            mutation: Mutation::Write {
                id: physical.state.id.clone(),
                expected: current.version.clone(),
                content: plan.authored.materialized_utf8.clone(),
            },
        };
        reserve_revision(&tx, &observed_version)?;
        let result = Self::apply_transaction_text(
            &tx,
            &command,
            None,
            None,
            Some(PreparedText {
                plan: plan.authored,
                adoption_history: None,
            }),
            Some(&observation),
        )?;
        put_revision(&tx, &plan.observed_baseline.state)?;
        let mut observed_state = physical.state.clone();
        observed_state.revision = observed_version;
        projection::put_baseline(
            &tx,
            &ProjectionBaseline {
                state: observed_state.clone(),
                content: observation.content.clone(),
            },
        )?;
        physical_bindings::put_observed_binding(&tx, &observed_state, physical_proof.as_ref())?;
        observation.resolution = Some(id.clone());
        tx.execute(
            "UPDATE external_observations SET record=?1 WHERE observation_id=?2",
            params![serde_json::to_string(&observation)?, id.as_str()],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
