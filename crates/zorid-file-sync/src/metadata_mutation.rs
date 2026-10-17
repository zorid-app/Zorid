//! Metadata-only mapping of bounded Text and namespace commands. Binary content
//! Create/Write uses the separate operation-bound staged mapper. This module
//! neither loads chunk payloads nor synthesizes byte-bearing legacy requests.
use crate::metadata::MetadataState;
use crate::metadata_plan::{prepare_authored_batch, AuthoredMetadataBatch, MetadataCandidate};
use crate::mutation::{
    self, Allocation, AllocationRequirements, AuthoredFile, CreateMode, Error, Result, TextChange,
};
use crate::v2;
use zorid_client_sync::TextState;
use zorid_core::{EntryChange, EntryKind, EntryState, Mutation, MutationRequest};
use zorid_sync_protocol::UpdateId;

/// All retained binary data is referenced through candidate metadata. Authored
/// rows here contain only namespace events; Text remains separately bounded.
#[derive(Debug)]
pub struct PreparedMetadataMutation {
    expected_entries: Vec<EntryState>,
    changes: Vec<EntryChange>,
    allocated_update_ids: Vec<UpdateId>,
    authored_files: Vec<AuthoredFile>,
    text: Option<TextChange>,
    candidate: MetadataCandidate,
}
impl PreparedMetadataMutation {
    pub fn expected_entries(&self) -> &[EntryState] {
        &self.expected_entries
    }
    pub fn changes(&self) -> &[EntryChange] {
        &self.changes
    }
    pub fn allocated_update_ids(&self) -> &[UpdateId] {
        &self.allocated_update_ids
    }
    pub fn authored_files(&self) -> &[AuthoredFile] {
        &self.authored_files
    }
    pub fn text(&self) -> Option<&TextChange> {
        self.text.as_ref()
    }
    pub fn candidate(&self) -> &MetadataCandidate {
        &self.candidate
    }
    pub fn check_preconditions(
        &self,
        entries: &[EntryState],
        graph: &MetadataState,
        text: Option<&TextState>,
        allocated_ids_unused: bool,
    ) -> Result<()> {
        if !allocated_ids_unused {
            return Err(Error::InvalidAllocation);
        }
        let mut actual = entries.to_vec();
        actual.sort_by(|a, b| a.id.cmp(&b.id));
        if actual != self.expected_entries || graph != self.candidate.expected_state() {
            return Err(Error::SnapshotMismatch);
        }
        match (&self.text, text) {
            (Some(TextChange::Create(_)), None) | (None, None) => Ok(()),
            (Some(TextChange::Write(plan)), Some(actual)) if &plan.expected_state == actual => {
                Ok(())
            }
            _ => Err(Error::SnapshotMismatch),
        }
    }
    pub fn into_parts(
        self,
    ) -> (
        Vec<EntryState>,
        Vec<EntryChange>,
        Vec<UpdateId>,
        Vec<AuthoredFile>,
        Option<TextChange>,
        MetadataCandidate,
    ) {
        (
            self.expected_entries,
            self.changes,
            self.allocated_update_ids,
            self.authored_files,
            self.text,
            self.candidate,
        )
    }
}
fn checked_view(
    request: &MutationRequest,
    entries: &[EntryState],
    graph: &MetadataState,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> Result<v2::VaultView> {
    let view = mutation::checked_view(request, entries, graph, mode, text)?;
    // A bounded inline Text request is the original command. Large binary writes
    // must retain their staged request identity instead of substituting bytes.
    match &request.mutation {
        Mutation::Create {
            kind: EntryKind::File,
            ..
        } if mode != Some(CreateMode::Text) => return Err(Error::InvalidMode),
        Mutation::Write { id, .. }
            if !matches!(
                view.content_bindings.get(id),
                Some(v2::ContentBinding::Text { .. })
            ) =>
        {
            return Err(Error::InvalidMode)
        }
        _ => (),
    }
    Ok(view)
}
/// Sizing shares the legacy command policy and allocation order, without reading
/// any retained binary body. It does not authorize the eventual atomic commit.
pub fn requirements(
    request: &MutationRequest,
    entries: &[EntryState],
    graph: &MetadataState,
    mode: Option<CreateMode>,
    text: Option<&TextState>,
) -> Result<AllocationRequirements> {
    let view = checked_view(request, entries, graph, mode, text)?;
    mutation::requirements_with_view(request, entries, &view, mode)
}
/// Prepare a real bounded inline command with the same core changes, event order
/// and TextNamespaceContext as the legacy planner. A private all-history proof
/// still must finalize the candidate before a host checks and commits all effects.
pub fn prepare_mutation(
    request: &MutationRequest,
    entries: &[EntryState],
    graph: &MetadataState,
    mode: Option<CreateMode>,
    text_state: Option<&TextState>,
    allocation: &Allocation,
) -> Result<PreparedMetadataMutation> {
    let view = checked_view(request, entries, graph, mode, text_state)?;
    let need = mutation::requirements_with_view(request, entries, &view, mode)?;
    mutation::validate_allocation(allocation, &need, entries, graph, text_state)?;
    let changes = zorid_core::plan_mutation(request, entries, &allocation.metadata_revision)?;
    let mut ids = allocation.update_ids.iter();
    let (events, context) = mutation::namespace_events(
        request,
        entries,
        &view,
        mode,
        &need,
        allocation,
        None,
        || ids.next().cloned().ok_or(Error::InvalidAllocation),
    )?;
    let mut batch = AuthoredMetadataBatch::new(graph.scope().clone());
    let mut authored_files = Vec::with_capacity(events.len());
    for (event, delete) in events {
        let update_id = event.id.clone();
        let body = if delete {
            v2::Body::ObservedDelete {
                events: vec![event],
            }
        } else {
            v2::Body::Events {
                events: vec![event],
            }
        };
        let payload = v2::Payload {
            family: crate::Family::Files,
            format_version: v2::FORMAT_VERSION,
            scope: graph.scope().clone(),
            id: update_id.clone(),
            body,
        };
        let payload_bytes = payload.encode()?;
        batch.push_exact(&payload_bytes)?;
        authored_files.push(AuthoredFile {
            update_id,
            payload_bytes,
        });
    }
    let text = if let Some(context) = context {
        let update_id = ids.next().cloned().ok_or(Error::InvalidAllocation)?;
        let authored = mutation::author_text(
            graph.scope(),
            request,
            text_state,
            allocation,
            &context,
            update_id,
        )?;
        batch.push_text_activity(authored.activity())?;
        Some(
            if allocation
                .text
                .as_ref()
                .and_then(|text| text.new_text.as_ref())
                .is_some()
            {
                TextChange::Create(authored.into_plan())
            } else {
                TextChange::Write(authored.into_plan())
            },
        )
    } else {
        None
    };
    if ids.next().is_some() {
        return Err(Error::InvalidAllocation);
    }
    let candidate = prepare_authored_batch(graph, batch, allocation.graph_revision.clone())?;
    mutation::validate_namespace_result(
        candidate.metadata_view().as_v2(),
        authored_files.iter().map(|file| &file.update_id),
        &changes,
    )?;
    let mut expected_entries = entries.to_vec();
    expected_entries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut allocated_update_ids = allocation.update_ids.clone();
    if let Some(new) = allocation
        .text
        .as_ref()
        .and_then(|text| text.new_text.as_ref())
    {
        allocated_update_ids.push(new.bootstrap_id.clone());
    }
    Ok(PreparedMetadataMutation {
        expected_entries,
        changes,
        allocated_update_ids,
        authored_files,
        text,
        candidate,
    })
}

#[cfg(test)]
#[path = "metadata_mutation_tests.rs"]
mod tests;
