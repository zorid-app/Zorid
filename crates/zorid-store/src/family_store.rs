//! Atomic current-format family ingress and authorship.
//!
//! SQLite is the local authority. A receive receipt acknowledges exact wire and
//! durable prerequisites; physical publication and relay acceptance are separate.
use super::*;
use zorid_client_sync::ReceiveCursor;
use zorid_file_sync::Scope;
use zorid_sync_protocol::UpdateId;

pub const FAMILY_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

pub use zorid_file_sync::mutation::CreateMode as FamilyCreateMode;
pub type FamilyScope = zorid_file_sync::Scope;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FamilyPayloadKind {
    Text,
    Files,
    Records,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyLimits {
    pub max_file_bytes: u64,
    /// Byte-bearing convenience reads and writes use the shared inline limit.
    pub max_inline_file_bytes: u64,
    pub max_graph_encoded_bytes: u64,
    pub max_records: u32,
}
impl Default for FamilyLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: FAMILY_MAX_FILE_BYTES,
            max_inline_file_bytes: FAMILY_MAX_INLINE_BYTES,
            max_graph_encoded_bytes: zorid_file_sync::MAX_STATE_BYTES as u64,
            max_records: zorid_file_sync::MAX_RECORDS as u32,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyStatus {
    pub scope: Option<Scope>,
    pub cursor: Option<ReceiveCursor>,
    pub limits: FamilyLimits,
    pub graph_records: u32,
    pub graph_encoded_bytes: u64,
    /// Counts are canonical decimal strings, never lossy JS u64 values.
    pub pending_authored: String,
    /// File/text pending publications plus unresolved managed record receipts.
    pub pending_dependencies: String,
    pub pending_projection: String,
    pub recovery_entries: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyAuthoredStatus {
    pub scope: Scope,
    pub update_id: UpdateId,
    pub family: FamilyPayloadKind,
    pub sealed: bool,
    pub accepted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyReceiveCommit {
    pub scope: Scope,
    pub update_id: UpdateId,
    pub duplicate: bool,
    pub changed_entry_ids: Vec<EntryId>,
    /// Same combined outstanding count as FamilyStatus::pending_dependencies.
    pub pending_prerequisites: u32,
    pub cursor: Option<ReceiveCursor>,
}

use super::family_ledger::{self, EnvelopeKey, EnvelopeMetadata, Family, TextBinding};
use zorid_crypto::{OpenedEnvelope, SystemEntropy, VaultKey};
use zorid_sync_protocol::{DeviceId, Envelope, ExpectedContext, Header, RealmId, VaultId};

pub(super) enum AuthenticatedFamily {
    Records(super::managed_records::AuthenticatedRecords),
    Text(zorid_client_sync::v2::AuthenticatedText),
    Files(zorid_file_sync::v2::AuthenticatedPayload),
}
/// Authentication already occurred exactly once. Routing fields merely select
/// the strict current-format capability decoder; they confer no authority.
pub(super) fn decode(opened: &OpenedEnvelope) -> Result<(EnvelopeMetadata, AuthenticatedFamily)> {
    #[derive(Deserialize)]
    struct Routing {
        family: String,
        format_version: u32,
    }
    let routing: Routing = serde_json::from_slice(opened.plaintext())
        .map_err(|_| zorid_client_sync::SyncError::InvalidPayload)?;
    if !matches!(
        (routing.family.as_str(), routing.format_version),
        ("records", 1) | ("text", 2) | ("files", 2)
    ) {
        return Err(zorid_client_sync::SyncError::UnsupportedFormat.into());
    }
    let header = opened.header();
    let key = EnvelopeKey {
        realm_id: header.realm_id().clone(),
        vault_id: header.vault_id().clone(),
        update_id: header.update_id().clone(),
    };
    let (family, text_binding, capability) = match routing.family.as_str() {
        "records" => {
            let value = super::managed_records::AuthenticatedRecords::from_opened(opened)?;
            (Family::Records, None, AuthenticatedFamily::Records(value))
        }
        "text" => {
            let value = zorid_client_sync::v2::AuthenticatedText::from_opened(opened)?;
            let identity = value.identity();
            let binding = TextBinding {
                entry_id: identity.entry_id.clone(),
                text_bootstrap_id: identity.bootstrap_id.clone(),
                namespace: value.activity().namespace().clone(),
            };
            (
                Family::Text,
                Some(binding),
                AuthenticatedFamily::Text(value),
            )
        }
        "files" => {
            let value = zorid_file_sync::v2::AuthenticatedPayload::from_opened(opened)?;
            (Family::Files, None, AuthenticatedFamily::Files(value))
        }
        _ => return Err(zorid_client_sync::SyncError::UnsupportedFormat.into()),
    };
    let metadata = EnvelopeMetadata {
        key,
        family,
        format_version: routing.format_version,
        payload_digest: zorid_file_sync::Sha256Digest::of(opened.plaintext()),
        payload_bytes: u32::try_from(opened.plaintext().len())
            .map_err(|_| zorid_client_sync::SyncError::TooLarge)?,
        file_summary_digest: match &capability {
            AuthenticatedFamily::Files(value) => Some(
                zorid_file_sync::metadata::GraphRecord::from_authenticated(value)?
                    .summary_digest()?,
            ),
            AuthenticatedFamily::Text(_) | AuthenticatedFamily::Records(_) => None,
        },
        text_binding,
    };
    metadata.check_payload(opened.plaintext())?;
    Ok((metadata, capability))
}
fn require_scope(tx: &Connection, realm: &RealmId, vault: &VaultId) -> Result<()> {
    let authority = text_sync::identity(tx)?;
    if authority.realm_id.as_ref() != Some(realm) || authority.vault_id.as_ref() != Some(vault) {
        return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
    }
    let scope = Scope {
        realm_id: realm.clone(),
        vault_id: vault.clone(),
    };
    if blob_index::load_metadata(tx, &scope)?.is_none() {
        return Err(ContractError::InvalidMutation {
            reason: "vault is not enrolled for current family synchronization".into(),
        }
        .into());
    }
    Ok(())
}
fn public_kind(family: Family) -> FamilyPayloadKind {
    match family {
        Family::Text => FamilyPayloadKind::Text,
        Family::Files => FamilyPayloadKind::Files,
        Family::Records => FamilyPayloadKind::Records,
    }
}
impl Store {
    pub fn family_pending_authored(
        &self,
        after: Option<&UpdateId>,
        limit: u32,
    ) -> Result<Vec<FamilyAuthoredStatus>> {
        if !(1..=1000).contains(&limit) {
            return Err(ContractError::InvalidMutation {
                reason: "authored page limit must be 1..=1000".into(),
            }
            .into());
        }
        let tx = self.connection.unchecked_transaction()?;
        let authority = text_sync::identity(&tx)?;
        let (Some(realm), Some(vault)) = (authority.realm_id, authority.vault_id) else {
            return Err(ContractError::InvalidMutation {
                reason: "vault is not enrolled for current family synchronization".into(),
            }
            .into());
        };
        require_scope(&tx, &realm, &vault)?;
        let ids:Vec<String>=tx.prepare("SELECT update_id FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2 AND accepted=0 AND (?3 IS NULL OR update_id>?3) ORDER BY update_id LIMIT ?4")?.query_map(params![realm.as_str(),vault.as_str(),after.map(UpdateId::as_str),limit],|r|r.get(0))?.collect::<std::result::Result<_,_>>()?;
        let mut output = Vec::with_capacity(ids.len());
        for id in ids {
            let key = EnvelopeKey {
                realm_id: realm.clone(),
                vault_id: vault.clone(),
                update_id: UpdateId::new(id)?,
            };
            let record = family_ledger::metadata_only(&tx, &key)?.ok_or_else(|| {
                StoreError::Corrupt("listed authored family envelope disappeared".into())
            })?;
            output.push(FamilyAuthoredStatus {
                scope: Scope {
                    realm_id: realm.clone(),
                    vault_id: vault.clone(),
                },
                update_id: key.update_id,
                family: public_kind(record.metadata.family),
                sealed: record.sealed,
                accepted: record.accepted,
            });
        }
        tx.commit()?;
        Ok(output)
    }
    /// Return only the one immutable winning envelope. The returned bytes are
    /// ready for a retry; a provisional losing ciphertext must never upload.
    pub fn family_seal(&mut self, expected: &ExpectedContext, key: &VaultKey) -> Result<Vec<u8>> {
        let identity = EnvelopeKey {
            realm_id: expected.realm_id.clone(),
            vault_id: expected.vault_id.clone(),
            update_id: expected.update_id.clone(),
        };
        let tx = self.connection.unchecked_transaction()?;
        require_scope(&tx, &identity.realm_id, &identity.vault_id)?;
        let record = family_ledger::authored(&tx, &identity)?.ok_or_else(|| {
            ContractError::InvalidMutation {
                reason: "unknown authored family envelope".into(),
            }
        })?;
        let authority = text_sync::identity(&tx)?;
        tx.commit()?;
        if let Some(wire) = record.sealed.as_ref() {
            expected.check(Envelope::decode(wire)?.header())?;
            return Ok(wire.clone());
        }
        let header = Header::new(
            identity.realm_id.clone(),
            identity.vault_id.clone(),
            identity.update_id.clone(),
            DeviceId::new(authority.local_store_id.as_str())?,
            expected.key_epoch,
        )?;
        let candidate =
            zorid_crypto::seal(&header, &record.payload, key, &mut SystemEntropy)?.encode();
        let opened = OpenedEnvelope::open(&candidate, expected, key)?;
        let (metadata, _) = decode(&opened)?;
        if metadata != record.metadata || opened.plaintext() != record.payload {
            return Err(StoreError::Corrupt(
                "authored family payload/provenance mismatch".into(),
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_scope(&tx, &identity.realm_id, &identity.vault_id)?;
        let canonical = family_ledger::install_sealed(&tx, &record, &candidate)?;
        // Applies to the race winner as well as our candidate. Rekeying cannot
        // silently change an already-authored immutable envelope's epoch.
        expected.check(Envelope::decode(&canonical)?.header())?;
        tx.commit()?;
        Ok(canonical)
    }
    pub fn family_ack(
        &mut self,
        realm: &RealmId,
        vault: &VaultId,
        update: &UpdateId,
        exact_wire: &[u8],
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_scope(&tx, realm, vault)?;
        family_ledger::acknowledge(
            &tx,
            &EnvelopeKey {
                realm_id: realm.clone(),
                vault_id: vault.clone(),
                update_id: update.clone(),
            },
            exact_wire,
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn family_receive_cursor(
        &self,
        realm: &RealmId,
        vault: &VaultId,
    ) -> Result<Option<ReceiveCursor>> {
        let tx = self.connection.unchecked_transaction()?;
        require_scope(&tx, realm, vault)?;
        let value = family_ledger::cursor(&tx, realm, vault)?;
        tx.commit()?;
        Ok(value)
    }
    /// Initialize an enrolled relay cursor at zero, or repeat the exact current
    /// value. Epoch replacement/rejoin is deliberately a separate future action;
    /// this endpoint cannot skip unapplied records or reset an existing cursor.
    pub fn family_set_receive_cursor(
        &mut self,
        expected: Option<&ReceiveCursor>,
        next: &ReceiveCursor,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_scope(&tx, &next.realm_id, &next.vault_id)?;
        let actual = family_ledger::cursor(&tx, &next.realm_id, &next.vault_id)?;
        if actual.as_ref() == Some(next) {
            tx.commit()?;
            return Ok(());
        }
        if actual.is_some()
            || expected.is_some()
            || next.after != zorid_sync_protocol::LogPosition::new(0)
        {
            return Err(zorid_client_sync::SyncError::CursorConflict.into());
        }
        family_ledger::compare_cursor(&tx, None, next)?;
        tx.commit()?;
        Ok(())
    }
}

/// Count every family's outstanding work in the caller's transaction snapshot.
/// File graph metrics remain file-only; managed snapshots retain record reasons.
fn pending_count(tx: &Connection) -> Result<u32> {
    family_materialization::pending_count(tx)?
        .checked_add(super::managed_records::pending_count(tx)?)
        .ok_or_else(|| StoreError::Corrupt("combined family pending count overflow".into()))
}

fn status_in(tx: &Connection) -> Result<FamilyStatus> {
    let authority = text_sync::identity(tx)?;
    let scope = match (authority.realm_id, authority.vault_id) {
        (Some(realm_id), Some(vault_id)) => Some(Scope { realm_id, vault_id }),
        (None, None) => None,
        _ => return Err(StoreError::Corrupt("partial family scope binding".into())),
    };
    let mut output = FamilyStatus {
        scope: scope.clone(),
        cursor: None,
        limits: FamilyLimits::default(),
        graph_records: 0,
        graph_encoded_bytes: 0,
        pending_authored: "0".into(),
        pending_dependencies: "0".into(),
        pending_projection: "0".into(),
        recovery_entries: "0".into(),
    };
    if let Some(scope) = &scope {
        let state = blob_index::load_metadata(tx, scope)?
            .ok_or_else(|| StoreError::Corrupt("enrolled family graph head missing".into()))?;
        // Status restores committed descriptors; publication validation requires
        // an in-process content proof and runs on mutation/receive snapshots.
        state.metadata_view()?;
        output.graph_records = u32::try_from(state.records().len() + state.activities().len())
            .map_err(|_| zorid_client_sync::SyncError::TooLarge)?;
        output.graph_encoded_bytes = serde_json::to_vec(&state)?.len() as u64;
        output.cursor = family_ledger::cursor(tx, &scope.realm_id, &scope.vault_id)?;
        let (authored,projection):(i64,i64)=tx.query_row("SELECT (SELECT count(*) FROM authored_envelopes WHERE realm_id=?1 AND vault_id=?2 AND accepted=0),(SELECT count(*) FROM projection_jobs WHERE completed=0)",params![scope.realm_id.as_str(),scope.vault_id.as_str()],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let pending = pending_count(tx)?;
        output.pending_authored = authored.to_string();
        // Pending file/text publications and unresolved record receipts. Summary
        // counts include record errors; managed snapshots expose their reasons.
        output.pending_dependencies = pending.to_string();
        output.recovery_entries = family_materialization::recovery_count(tx)?.to_string();
        output.pending_projection = projection.to_string();
    }
    Ok(output)
}
impl Store {
    pub fn family_status(&self) -> Result<FamilyStatus> {
        let tx = self.connection.unchecked_transaction()?;
        let status = status_in(&tx)?;
        tx.commit()?;
        Ok(status)
    }
    /// Enroll a new empty fixture authority. No existing path/content or old
    /// protocol identity is adopted heuristically. An exact retry is read-only.
    pub fn family_enroll(&mut self, scope: &Scope) -> Result<FamilyStatus> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let identity = text_sync::identity(&tx)?;
        if identity.realm_id.is_some() || identity.vault_id.is_some() {
            if identity.realm_id.as_ref() == Some(&scope.realm_id)
                && identity.vault_id.as_ref() == Some(&scope.vault_id)
                && blob_index::load_metadata(&tx, scope)?.is_some()
            {
                let status = status_in(&tx)?;
                tx.commit()?;
                return Ok(status);
            }
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        }
        let nonempty:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entries UNION ALL SELECT 1 FROM operations UNION ALL SELECT 1 FROM host_intents UNION ALL SELECT 1 FROM text_bindings UNION ALL SELECT 1 FROM text_revisions UNION ALL SELECT 1 FROM authored_text UNION ALL SELECT 1 FROM sync_updates UNION ALL SELECT 1 FROM sync_envelopes UNION ALL SELECT 1 FROM authored_envelopes UNION ALL SELECT 1 FROM family_graph_heads)",[],|r|r.get(0))?;
        if nonempty {
            return Err(ContractError::InvalidMutation {
                reason:
                    "current family enrollment requires a new empty vault with no pending commands"
                        .into(),
            }
            .into());
        }
        tx.execute(
            "UPDATE authority_identity SET realm_id=?1,vault_id=?2 WHERE singleton=1",
            params![scope.realm_id.as_str(), scope.vault_id.as_str()],
        )?;
        let revision = Revision::new(uuid::Uuid::new_v4().to_string())?;
        text_sync::reserve_revision(&tx, &revision)?;
        file_state::initialize(&tx, scope, &revision)?;
        let status = status_in(&tx)?;
        tx.commit()?;
        Ok(status)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FamilyEnvelopeOrigin {
    Authored,
    Received,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyEnvelopeStatus {
    pub scope: Scope,
    pub update_id: UpdateId,
    pub family: FamilyPayloadKind,
    pub origin: FamilyEnvelopeOrigin,
}
impl Store {
    /// Immutable metadata lookup; no ciphertext or file body is returned.
    pub fn family_envelope_status(
        &self,
        update: &UpdateId,
    ) -> Result<Option<FamilyEnvelopeStatus>> {
        let tx = self.connection.unchecked_transaction()?;
        let authority = text_sync::identity(&tx)?;
        let (Some(realm_id), Some(vault_id)) = (authority.realm_id, authority.vault_id) else {
            return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
        };
        require_scope(&tx, &realm_id, &vault_id)?;
        let key = EnvelopeKey {
            realm_id: realm_id.clone(),
            vault_id: vault_id.clone(),
            update_id: update.clone(),
        };
        let value = family_ledger::metadata_only(&tx, &key)?
            .and_then(|record| record.sealed.then_some(record))
            .map(|record| FamilyEnvelopeStatus {
                scope: Scope { realm_id, vault_id },
                update_id: update.clone(),
                family: public_kind(record.metadata.family),
                origin: match record.direction {
                    family_ledger::Direction::Authored => FamilyEnvelopeOrigin::Authored,
                    family_ledger::Direction::Received => FamilyEnvelopeOrigin::Received,
                },
            });
        tx.commit()?;
        Ok(value)
    }
    /// One durable receipt covers exact wire, retained causal state, publication
    /// classification, local UI event, physical jobs and ordered relay cursor.
    /// It does not claim files are projected or create an authored echo intent.
    pub fn family_receive(
        &mut self,
        opened: &OpenedEnvelope,
        delivery: Option<&zorid_client_sync::CursorAdvance>,
    ) -> Result<FamilyReceiveCommit> {
        let scope = Scope {
            realm_id: opened.header().realm_id().clone(),
            vault_id: opened.header().vault_id().clone(),
        };
        // Reject obsolete formats before even opening a write transaction.
        let (metadata, incoming) = decode(opened)?;
        if let AuthenticatedFamily::Records(incoming) = incoming {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            require_scope(&tx, &scope.realm_id, &scope.vault_id)?;
            family_ingress::check_delivery(&tx, &scope, delivery)?;
            let (duplicate, _) = super::managed_records::receive_in_transaction(
                &tx,
                &incoming,
                &metadata,
                &opened.envelope().encode(),
            )?;
            if let Some(delivery) = delivery {
                family_ledger::compare_cursor(&tx, Some(&delivery.expected), &delivery.next)?;
            }
            let cursor = family_ledger::cursor(&tx, &scope.realm_id, &scope.vault_id)?;
            let result = FamilyReceiveCommit {
                scope,
                update_id: metadata.key.update_id,
                duplicate,
                changed_entry_ids: Vec::new(),
                pending_prerequisites: pending_count(&tx)?,
                cursor,
            };
            tx.commit()?;
            return Ok(result);
        }
        let tx = self.connection.unchecked_transaction()?;
        require_scope(&tx, &scope.realm_id, &scope.vault_id)?;
        let current = blob_index::load_metadata(&tx, &scope)?
            .ok_or_else(|| StoreError::Corrupt("enrolled graph missing".into()))?;
        let prepared = family_ingress::prepare_metadata(&tx, &current, opened, delivery)?;
        tx.commit()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_scope(&tx, &scope.realm_id, &scope.vault_id)?;
        family_ingress::check_delivery(&tx, &scope, delivery)?;
        family_ingress::persist_metadata(&tx, &prepared)?;
        let graph = prepared.graph.verification_state();
        let origin = ProjectionOrigin::ReceivedUpdate {
            realm_id: scope.realm_id.as_str().to_owned(),
            vault_id: scope.vault_id.as_str().to_owned(),
            update_id: prepared.metadata.key.update_id.as_str().to_owned(),
        };
        let changed_entry_ids = family_materialization::apply(
            &tx,
            graph,
            prepared.graph.verified_binaries(),
            origin,
            None,
        )?;
        if prepared.duplicate && !changed_entry_ids.is_empty() {
            return Err(StoreError::Corrupt(
                "duplicate changed publication cache".into(),
            ));
        }
        // Pending classification contains the exact graph dependency obligations;
        // graph records and Yrs pending dependencies are retained in this tx too.
        let pending_prerequisites = pending_count(&tx)?;
        if let Some(delivery) = delivery {
            family_ingress::check_delivery(&tx, &scope, Some(delivery))?;
            family_ledger::compare_cursor(&tx, Some(&delivery.expected), &delivery.next)?;
        }
        let cursor = family_ledger::cursor(&tx, &scope.realm_id, &scope.vault_id)?;
        let result = FamilyReceiveCommit {
            scope,
            update_id: prepared.metadata.key.update_id,
            duplicate: prepared.duplicate,
            changed_entry_ids,
            pending_prerequisites,
            cursor,
        };
        tx.commit()?;
        Ok(result)
    }
}

/// Legacy paths cannot bypass combined enrolled-family authority.
pub(super) fn reject_legacy_mutation(tx: &Connection) -> Result<()> {
    let enrolled: bool =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM family_graph_heads)", [], |r| {
            r.get(0)
        })?;
    if enrolled {
        return Err(ContractError::InvalidMutation {
            reason: "enrolled vault requires combined family command".into(),
        }
        .into());
    }
    Ok(())
}

impl Store {
    /// Whether the local authority has the current combined-family binding.
    pub fn family_is_enrolled(&self) -> Result<bool> {
        let tx = self.connection.unchecked_transaction()?;
        let count: i64 = tx.query_row("SELECT count(*) FROM family_graph_heads", [], |row| {
            row.get(0)
        })?;
        if count > 1 {
            return Err(StoreError::Corrupt(
                "multiple family scopes in one local authority".into(),
            ));
        }
        if count == 1 {
            status_in(&tx)?;
        }
        tx.commit()?;
        Ok(count == 1)
    }
}
