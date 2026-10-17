//! Authenticated combined causal ingress. These helpers never commit: the caller
//! must persist classification, visible metadata, exact projection jobs and the
//! shared cursor in this same SQLite transaction before returning a receipt.
use super::family_ledger::{self, EnvelopeMetadata};
use super::family_store::AuthenticatedFamily;
use super::*;
use zorid_client_sync::{CursorAdvance, ReceiveRequest, ReceivedRecord, TextState};
use zorid_crypto::OpenedEnvelope;
use zorid_file_sync::{v2::FilePlan, Scope};

pub(super) struct PreparedReceive {
    pub metadata: EnvelopeMetadata,
    pub graph: FilePlan,
    pub text: Option<zorid_client_sync::ReceivedPlan>,
    pub new_text: bool,
    pub duplicate: bool,
    pub exact_wire: Vec<u8>,
    pub file_payload: Option<Vec<u8>>,
}
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
pub(super) fn prepare(
    tx: &Connection,
    graph: &zorid_file_sync::v2::State,
    opened: &OpenedEnvelope,
    delivery: Option<&CursorAdvance>,
) -> Result<PreparedReceive> {
    let (metadata, incoming) = family_store::decode(opened)?;
    if metadata.key.realm_id != graph.scope().realm_id
        || metadata.key.vault_id != graph.scope().vault_id
    {
        return Err(zorid_client_sync::SyncError::IdentityMismatch.into());
    }
    check_delivery(tx, graph.scope(), delivery)?;
    // Validate the authored/received ownership invariant even for exact replay.
    let authored = family_ledger::authored(tx, &metadata.key)?;
    let prior = family_ledger::wire(tx, &metadata.key)?;
    let exact_wire = opened.envelope().encode();
    if prior
        .as_ref()
        .is_some_and(|p| p.metadata != metadata || p.exact_wire != exact_wire)
        || (prior.is_none() && authored.is_some())
    {
        return Err(zorid_client_sync::SyncError::DedupeMismatch.into());
    }
    let duplicate = prior.is_some();
    let graph_revision = fresh()?;
    let (graph, text, new_text, file_payload) = match incoming {
        AuthenticatedFamily::Files(incoming) => {
            let prior = prior.as_ref().map(|p| zorid_file_sync::WireRecord {
                scope: graph.scope().clone(),
                id: metadata.key.update_id.clone(),
                exact_wire: p.exact_wire.clone(),
            });
            let plan = zorid_file_sync::v2::plan_received(
                graph,
                &incoming,
                prior.as_ref(),
                graph_revision,
            )?;
            plan.check_preconditions(graph, prior.as_ref())?;
            (
                plan.graph,
                None,
                false,
                (!duplicate).then(|| incoming.payload_bytes().to_vec()),
            )
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
            let prior = prior.as_ref().map(|p| ReceivedRecord {
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
                prior.as_ref(),
                cursor,
            )?;
            text.check_preconditions(&current, prior.as_ref(), cursor)?;
            let graph_plan = zorid_file_sync::v2::plan_received_text_activity(
                graph,
                incoming.activity(),
                graph_revision,
            )?;
            graph_plan.check_preconditions(graph)?;
            if graph_plan.next_state.is_some() == duplicate {
                return Err(StoreError::Corrupt(
                    "text ledger and namespace activity disagree".into(),
                ));
            }
            (graph_plan, Some(text), new_text, None)
        }
    };
    Ok(PreparedReceive {
        metadata,
        graph,
        text,
        new_text,
        duplicate,
        exact_wire,
        file_payload,
    })
}
/// Applies only causal authorities. The enclosing caller must still classify
/// and persist visibility/projection/prerequisites before COMMIT.
pub(super) fn persist(tx: &Connection, plan: &PreparedReceive) -> Result<()> {
    let scope = plan.graph.expected_state.scope();
    let actual = file_state::load(tx, scope)?
        .ok_or_else(|| StoreError::Corrupt("enrolled graph disappeared".into()))?;
    plan.graph.check_preconditions(&actual)?;
    if let Some(text) = &plan.text {
        let actual_text = text_sync::retained(tx, &text.expected_state.identity.entry_id)?;
        if (plan.new_text && actual_text.is_some())
            || (!plan.new_text && actual_text.as_ref() != Some(&text.expected_state))
        {
            return Err(zorid_client_sync::SyncError::VersionConflict.into());
        }
    }
    if let Some(next) = &plan.graph.next_state {
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
    if family_ledger::insert_received(tx, &plan.metadata, &plan.exact_wire)? == plan.duplicate {
        return Err(StoreError::Corrupt(
            "received ledger changed during transaction".into(),
        ));
    }
    file_state::persist(
        tx,
        &plan.graph,
        plan.file_payload
            .as_ref()
            .map(|bytes| (&plan.metadata.key.update_id, bytes.as_slice())),
    )?;
    if let Some(next) = plan.text.as_ref().and_then(|text| text.next_state.as_ref()) {
        text_sync::put_current(tx, next)?;
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
