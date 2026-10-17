//! Authenticated combined causal ingress. These helpers never commit: the caller
//! must persist classification, visible metadata, exact projection jobs and the
//! shared cursor in this same SQLite transaction before returning a receipt.
use super::family_ledger::{self, EnvelopeMetadata};
use super::family_store::AuthenticatedFamily;
use super::*;
use zorid_client_sync::{CursorAdvance, ReceiveRequest, ReceivedRecord, TextState};
use zorid_crypto::OpenedEnvelope;
use zorid_file_sync::Scope;

fn fresh() -> Result<Revision> {
    Ok(Revision::new(uuid::Uuid::new_v4().to_string())?)
}
/// Ordered delivery must be checked for BOTH families. A direct peer delivery
/// without a relay cursor leaves an existing relay cursor entirely unchanged.
pub(super) fn check_delivery(
    tx: &Connection,
    scope: &Scope,
    delivery: Option<&CursorAdvance>,
) -> Result<()> {
    let Some(delivery) = delivery else {
        return Ok(());
    };
    if delivery.expected.realm_id != scope.realm_id
        || delivery.expected.vault_id != scope.vault_id
        || delivery.next.realm_id != scope.realm_id
        || delivery.next.vault_id != scope.vault_id
        || delivery.expected.server_epoch != delivery.next.server_epoch
        || delivery.next.after <= delivery.expected.after
        || family_ledger::cursor(tx, &scope.realm_id, &scope.vault_id)?.as_ref()
            != Some(&delivery.expected)
    {
        return Err(zorid_client_sync::SyncError::CursorConflict.into());
    }
    Ok(())
}
pub(super) fn retained_texts(tx: &Connection, scope: &Scope) -> Result<Vec<TextState>> {
    let ids: Vec<String> = tx.prepare("SELECT entry_id FROM text_bindings WHERE realm_id=?1 AND vault_id=?2 ORDER BY entry_id")?
        .query_map(params![scope.realm_id.as_str(), scope.vault_id.as_str()], |row| row.get(0))?
        .collect::<std::result::Result<_,_>>()?;
    ids.into_iter()
        .map(|id| {
            text_sync::retained(tx, &EntryId::new(id)?)?
                .ok_or_else(|| StoreError::Corrupt("listed text head disappeared".into()))
        })
        .collect()
}

/// Prepared in a read snapshot, finalized only with a private all-history binary
/// proof. The final writer still compares all causal/publication/source inputs.
pub(super) struct PreparedMetadataReceive {
    pub metadata: EnvelopeMetadata,
    pub graph: zorid_file_sync::metadata_plan::MetadataPlan,
    pub text: Option<zorid_client_sync::ReceivedPlan>,
    pub new_text: bool,
    pub duplicate: bool,
    exact_wire: Vec<u8>,
    exact_plaintext: Vec<u8>,
    expected_prior: Option<family_ledger::WireRecord>,
    expected_head: Option<family_ledger::MetadataRecord>,
    expected_entries: Vec<EntryState>,
    expected_texts: Vec<TextState>,
    file_family: bool,
}
pub(super) fn prepare_metadata(
    tx: &Connection,
    graph: &zorid_file_sync::metadata::MetadataState,
    opened: &OpenedEnvelope,
    delivery: Option<&CursorAdvance>,
) -> Result<PreparedMetadataReceive> {
    let (metadata, incoming) = family_store::decode(opened)?;
    if metadata.key.realm_id != graph.scope().realm_id
        || metadata.key.vault_id != graph.scope().vault_id
    {
        return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
    }
    check_delivery(tx, graph.scope(), delivery)?;
    let expected_head = family_ledger::metadata_only(tx, &metadata.key)?;
    let prior = family_ledger::wire(tx, &metadata.key)?;
    let exact_wire = opened.envelope().encode();
    if prior
        .as_ref()
        .is_some_and(|p| p.metadata != metadata || p.exact_wire != exact_wire)
        || (prior.is_none() && expected_head.is_some())
    {
        return Err(zorid_client_sync::SyncError::DedupeMismatch.into());
    }
    let verified_old = blob_index::verify_metadata(tx, graph, &[])?;
    family_materialization::validate(tx, graph, &verified_old)?;
    let duplicate = prior.is_some();
    let expected_entries = read_states(tx, true)?;
    let expected_texts = retained_texts(tx, graph.scope())?;
    let file_family = matches!(&incoming, AuthenticatedFamily::Files(_));
    let (candidate, text, new_text, overlay) = match incoming {
        AuthenticatedFamily::Files(incoming) => {
            let wire = prior.as_ref().map(|p| zorid_file_sync::WireRecord {
                scope: graph.scope().clone(),
                id: metadata.key.update_id.clone(),
                exact_wire: p.exact_wire.clone(),
            });
            let candidate = zorid_file_sync::metadata_plan::prepare_received(
                graph,
                &incoming,
                wire.as_ref(),
                fresh()?,
            )?;
            let overlay = if duplicate {
                Vec::new()
            } else {
                vec![(
                    metadata.key.update_id.clone(),
                    incoming.payload_bytes().to_vec(),
                )]
            };
            (candidate, None, false, overlay)
        }
        AuthenticatedFamily::Text(incoming) => {
            let existing = text_sync::retained(tx, &incoming.identity().entry_id)?;
            if duplicate && existing.is_none() {
                return Err(StoreError::Corrupt(
                    "received text has no retained causal head".into(),
                ));
            }
            let new_text = existing.is_none();
            let current = match existing {
                Some(state) => state,
                None => TextState::empty(incoming.identity().clone(), fresh()?),
            };
            if &current.identity != incoming.identity() {
                return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
            }
            let wire = prior.as_ref().map(|p| ReceivedRecord {
                identity: current.identity.clone(),
                update_id: metadata.key.update_id.clone(),
                exact_wire: p.exact_wire.clone(),
            });
            let cursor = delivery.map(|d| &d.expected);
            let request = ReceiveRequest {
                expected_version: current.version.clone(),
                next_version: fresh()?,
                delivery: delivery.cloned(),
            };
            let text = zorid_client_sync::v2::plan_received_text(
                &current,
                &request,
                &incoming,
                wire.as_ref(),
                cursor,
            )?;
            text.check_preconditions(&current, wire.as_ref(), cursor)?;
            let candidate = zorid_file_sync::metadata_plan::prepare_text_activity(
                graph,
                incoming.activity(),
                fresh()?,
            )?;
            if candidate.next_state().is_some() == duplicate {
                return Err(StoreError::Corrupt(
                    "text ledger and namespace activity disagree".into(),
                ));
            }
            (candidate, Some(text), new_text, Vec::new())
        }
    };
    let verified = if candidate.verification_state() == graph {
        verified_old
    } else {
        blob_index::verify_metadata(tx, candidate.verification_state(), &overlay)?
    };
    let graph = candidate.finalize(verified)?;
    Ok(PreparedMetadataReceive {
        metadata,
        graph,
        text,
        new_text,
        duplicate,
        exact_wire,
        exact_plaintext: opened.plaintext().to_vec(),
        expected_prior: prior,
        expected_head,
        expected_entries,
        expected_texts,
        file_family,
    })
}

/// Persist causal authorities after exact snapshot CAS. Publication/jobs and
/// cursor must be committed by the caller before acknowledging receipt.
pub(super) fn persist_metadata(tx: &Connection, plan: &PreparedMetadataReceive) -> Result<()> {
    let scope = plan.graph.expected_state().scope();
    let actual = blob_index::load_metadata(tx, scope)?
        .ok_or_else(|| StoreError::Corrupt("enrolled graph disappeared".into()))?;
    let prior = family_ledger::wire(tx, &plan.metadata.key)?;
    if prior != plan.expected_prior
        || family_ledger::metadata_only(tx, &plan.metadata.key)? != plan.expected_head
    {
        return Err(zorid_client_sync::SyncError::DedupeMismatch.into());
    }
    let file_wire = if plan.file_family {
        prior.as_ref().map(|p| zorid_file_sync::WireRecord {
            scope: scope.clone(),
            id: plan.metadata.key.update_id.clone(),
            exact_wire: p.exact_wire.clone(),
        })
    } else {
        None
    };
    plan.graph
        .check_preconditions(&actual, file_wire.as_ref())?;
    if read_states(tx, true)? != plan.expected_entries
        || retained_texts(tx, scope)? != plan.expected_texts
    {
        return Err(zorid_client_sync::SyncError::VersionConflict.into());
    }
    blob_index::check_sources(tx, &actual)?;
    if let Some(text) = &plan.text {
        let actual_text = text_sync::retained(tx, &text.expected_state.identity.entry_id)?;
        if (plan.new_text && actual_text.is_some())
            || (!plan.new_text && actual_text.as_ref() != Some(&text.expected_state))
        {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
    }
    if let Some(next) = plan.graph.next_state() {
        text_sync::reserve_revision(tx, next.version())?;
    }
    if let Some(text) = &plan.text {
        if plan.new_text {
            text_sync::reserve_revision(tx, &text.expected_state.version)?;
        }
        if let Some(next) = &text.next_state {
            text_sync::reserve_revision(tx, &next.version)?;
        }
    }
    if family_ledger::insert_received_exact(
        tx,
        &plan.metadata,
        &plan.exact_wire,
        &plan.exact_plaintext,
    )? == plan.duplicate
    {
        return Err(StoreError::Corrupt(
            "received ledger changed during transaction".into(),
        ));
    }
    blob_index::persist_plan(tx, &plan.graph)?;
    blob_index::check_sources(tx, plan.graph.verification_state())?;
    if let Some(next) = plan.text.as_ref().and_then(|text| text.next_state.as_ref()) {
        text_sync::put_current(tx, next)?;
    }
    Ok(())
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use zorid_crypto::{SystemEntropy, VaultKey};
    use zorid_file_sync::v2::{Body, ContentSeed, Effect, Payload};
    use zorid_sync_protocol::{ExpectedContext, LogPosition, RealmId, ServerEpoch, VaultId};

    #[test]
    fn completed_manifest_hash_failure_never_commits_wire_visibility_or_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let scope = Scope {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: VaultId::new("vault").unwrap(),
        };
        let mut author = Store::open(dir.path().join("author")).unwrap();
        let mut receiver = Store::open(dir.path().join("receiver")).unwrap();
        author.family_enroll(&scope).unwrap();
        receiver.family_enroll(&scope).unwrap();
        let request = MutationRequest {
            operation_id: zorid_core::OperationId::new("create_binary").unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new("binary").unwrap(),
                path: zorid_core::VaultPath::new("blob.unknown").unwrap(),
                kind: EntryKind::File,
                content: Some(vec![7; zorid_file_sync::MAX_CHUNK_BYTES + 3]),
            },
        };
        author
            .family_apply(&request, Some(FamilyCreateMode::Binary))
            .unwrap();
        let key = VaultKey::from_bytes([7; 32]);
        let mut final_event = None;
        for pending in author.family_pending_authored(None, 1000).unwrap() {
            let expected = ExpectedContext {
                realm_id: scope.realm_id.clone(),
                vault_id: scope.vault_id.clone(),
                update_id: pending.update_id,
                key_epoch: 1,
            };
            let wire = author.family_seal(&expected, &key).unwrap();
            let opened = OpenedEnvelope::open(&wire, &expected, &key).unwrap();
            let payload = Payload::decode(opened.plaintext()).unwrap();
            if matches!(payload.body, Body::Events { .. }) {
                assert!(final_event.replace((expected, wire)).is_none());
            } else {
                receiver.family_receive(&opened, None).unwrap();
            }
        }
        assert!(receiver.list().unwrap().is_empty());
        let (expected, valid_wire) = final_event.unwrap();
        let valid = OpenedEnvelope::open(&valid_wire, &expected, &key).unwrap();
        let mut payload = Payload::decode(valid.plaintext()).unwrap();
        let Body::Events { events } = &mut payload.body else {
            panic!("expected Create event")
        };
        let Effect::Create {
            content: Some(ContentSeed::Binary { manifest }),
            ..
        } = &mut events[0].effect
        else {
            panic!("expected binary Create")
        };
        // All chunk references remain valid. Only whole-file hashing detects this.
        manifest.digest = zorid_file_sync::Sha256Digest::of(b"different whole-file hash");
        let invalid_wire = zorid_crypto::seal(
            valid.header(),
            &payload.encode().unwrap(),
            &key,
            &mut SystemEntropy,
        )
        .unwrap()
        .encode();
        let invalid = OpenedEnvelope::open(&invalid_wire, &expected, &key).unwrap();
        let cursor = zorid_client_sync::ReceiveCursor {
            realm_id: scope.realm_id.clone(),
            vault_id: scope.vault_id.clone(),
            server_epoch: ServerEpoch::new("epoch").unwrap(),
            after: LogPosition::new(0),
        };
        receiver.family_set_receive_cursor(None, &cursor).unwrap();
        let mut next = cursor.clone();
        next.after = LogPosition::new(1);
        let delivery = CursorAdvance {
            expected: cursor,
            next: next.clone(),
        };
        let before = receiver.family_status().unwrap();
        assert!(receiver.family_receive(&invalid, Some(&delivery)).is_err());
        assert_eq!(receiver.family_status().unwrap(), before);
        assert!(receiver
            .family_envelope_status(&expected.update_id)
            .unwrap()
            .is_none());
        assert!(receiver.list().unwrap().is_empty());
        receiver.family_receive(&valid, Some(&delivery)).unwrap();
        assert_eq!(
            receiver
                .family_receive_cursor(&scope.realm_id, &scope.vault_id)
                .unwrap(),
            Some(next)
        );
        assert_eq!(receiver.list().unwrap().len(), 1);
    }
}
