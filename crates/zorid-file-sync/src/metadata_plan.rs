//! Additive metadata-only planning. Finalization requires an in-process proof of
//! every retained complete binary manifest. Hosts still own source-row pinning,
//! expected graph/wire CAS, text state checks, receipts, cursors and atomic commit.
use crate::binary_stream::VerifiedBinarySet;
use crate::metadata::{GraphRecord, GraphRecordBody, MetadataState, MetadataView};
use crate::{v2, Error, Result, Scope, Sha256Digest, WireRecord};
use std::collections::BTreeMap;
use zorid_client_sync::v2::TextActivity;
use zorid_core::Revision;
use zorid_sync_protocol::UpdateId;

/// Checked exact local plaintext identity; no retained payload body or commit
/// authority. The host must resolve and recheck its immutable backing row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoredPayloadRef {
    scope: Scope,
    id: UpdateId,
    record: GraphRecord,
    summary_digest: Sha256Digest,
}
impl AuthoredPayloadRef {
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn id(&self) -> &UpdateId {
        &self.id
    }
    pub fn record(&self) -> &GraphRecord {
        &self.record
    }
    pub fn payload_bytes(&self) -> u32 {
        self.record.payload_bytes()
    }
    pub fn payload_digest(&self) -> &Sha256Digest {
        self.record.payload_digest()
    }
    pub fn summary_digest(&self) -> &Sha256Digest {
        &self.summary_digest
    }
}

/// Incremental collection of bounded exact emissions. Only descriptors survive
/// each push. Exact duplicates are idempotent and retain first emission order.
/// This is local authorship, never authentication of received plaintext.
#[derive(Debug)]
pub struct AuthoredMetadataBatch {
    scope: Scope,
    records: BTreeMap<UpdateId, GraphRecord>,
    activities: BTreeMap<UpdateId, v2::StoredActivity>,
    emissions: Vec<AuthoredPayloadRef>,
    descriptor_bytes: usize,
}
impl AuthoredMetadataBatch {
    pub fn new(scope: Scope) -> Self {
        Self {
            scope,
            records: BTreeMap::new(),
            activities: BTreeMap::new(),
            emissions: Vec::new(),
            descriptor_bytes: 0,
        }
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn payload_refs(&self) -> &[AuthoredPayloadRef] {
        &self.emissions
    }
    pub fn activity_ids(&self) -> impl Iterator<Item = &UpdateId> {
        self.activities.keys()
    }
    fn reserve(&self, bytes: usize) -> Result<usize> {
        if self.records.len() + self.activities.len() >= crate::MAX_RECORDS {
            return Err(Error::TooLarge);
        }
        let size = self
            .descriptor_bytes
            .checked_add(bytes)
            .ok_or(Error::TooLarge)?;
        if size > crate::MAX_STATE_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(size)
    }
    pub fn push_exact(&mut self, exact: &[u8]) -> Result<AuthoredPayloadRef> {
        let (scope, id, record) = GraphRecord::from_authored_exact(exact)?;
        if scope != self.scope {
            return Err(Error::IdentityMismatch);
        }
        if self.activities.contains_key(&id) {
            return Err(Error::DuplicateMismatch);
        }
        let reference = AuthoredPayloadRef {
            scope,
            id: id.clone(),
            summary_digest: record.summary_digest()?,
            record: record.clone(),
        };
        if let Some(prior) = self.records.get(&id) {
            return if prior == &record {
                Ok(reference)
            } else {
                Err(Error::DuplicateMismatch)
            };
        }
        // Existing local descriptor codec only; this introduces no wire format.
        let size = self.reserve(
            serde_json::to_vec(&record)
                .map_err(|_| Error::InvalidState)?
                .len(),
        )?;
        self.records.insert(id, record);
        self.emissions.push(reference.clone());
        self.descriptor_bytes = size;
        Ok(reference)
    }
    /// The matching bounded text plan and source ledger must commit in the same
    /// transaction. This descriptor alone never validates or commits text state.
    pub fn push_text_activity(&mut self, activity: &TextActivity) -> Result<()> {
        let stored = v2::StoredActivity::from_activity(activity)?;
        stored.graph(&self.scope)?;
        let id = stored.update_id();
        if self.records.contains_key(id) {
            return Err(Error::DuplicateMismatch);
        }
        if let Some(prior) = self.activities.get(id) {
            return if prior == &stored {
                Ok(())
            } else {
                Err(Error::DuplicateMismatch)
            };
        }
        let size = self.reserve(
            serde_json::to_vec(&stored)
                .map_err(|_| Error::InvalidState)?
                .len(),
        )?;
        self.activities.insert(id.clone(), stored);
        self.descriptor_bytes = size;
        Ok(())
    }
}

/// A candidate is not publishable content. Verify its verification_state through
/// the shared all-history session with immutable stored/staged source overlays.
#[derive(Debug)]
pub struct MetadataCandidate {
    expected: MetadataState,
    next: Option<MetadataState>,
    view: MetadataView,
    authored: Vec<AuthoredPayloadRef>,
    expected_wire: Option<WireRecord>,
    received_wire: Option<WireRecord>,
}
impl MetadataCandidate {
    pub fn expected_state(&self) -> &MetadataState {
        &self.expected
    }
    pub fn next_state(&self) -> Option<&MetadataState> {
        self.next.as_ref()
    }
    pub fn verification_state(&self) -> &MetadataState {
        self.next.as_ref().unwrap_or(&self.expected)
    }
    /// Dependency/namespace view only; the candidate grants no content proof.
    pub fn metadata_view(&self) -> &MetadataView {
        &self.view
    }
    pub fn authored_payload_refs(&self) -> &[AuthoredPayloadRef] {
        &self.authored
    }
    pub fn expected_wire(&self) -> Option<&WireRecord> {
        self.expected_wire.as_ref()
    }
    pub fn received_wire(&self) -> Option<&WireRecord> {
        self.received_wire.as_ref()
    }
    pub fn finalize(self, verified: VerifiedBinarySet) -> Result<MetadataPlan> {
        verified.check_preconditions(self.verification_state())?;
        Ok(MetadataPlan {
            candidate: self,
            verified,
        })
    }
}
/// In-process finalized plan, never deserializable commit permission. A host
/// commits only after rechecking all backing source pins inside its transaction.
#[derive(Debug)]
pub struct MetadataPlan {
    candidate: MetadataCandidate,
    verified: VerifiedBinarySet,
}
impl MetadataPlan {
    pub fn expected_state(&self) -> &MetadataState {
        self.candidate.expected_state()
    }
    pub fn next_state(&self) -> Option<&MetadataState> {
        self.candidate.next_state()
    }
    pub fn verification_state(&self) -> &MetadataState {
        self.candidate.verification_state()
    }
    pub fn metadata_view(&self) -> &MetadataView {
        self.candidate.metadata_view()
    }
    pub fn authored_payload_refs(&self) -> &[AuthoredPayloadRef] {
        self.candidate.authored_payload_refs()
    }
    pub fn expected_wire(&self) -> Option<&WireRecord> {
        self.candidate.expected_wire()
    }
    pub fn received_wire(&self) -> Option<&WireRecord> {
        self.candidate.received_wire()
    }
    pub fn verified_binaries(&self) -> &VerifiedBinarySet {
        &self.verified
    }
    pub fn check_preconditions(
        &self,
        actual: &MetadataState,
        actual_prior_wire: Option<&WireRecord>,
    ) -> Result<()> {
        if actual != self.expected_state() {
            return Err(Error::VersionConflict);
        }
        if actual_prior_wire != self.expected_wire() {
            return Err(Error::DuplicateMismatch);
        }
        self.verified.check_preconditions(self.verification_state())
    }
}

fn candidate(
    state: &MetadataState,
    next: Option<MetadataState>,
    authored: Vec<AuthoredPayloadRef>,
    expected_wire: Option<WireRecord>,
    received_wire: Option<WireRecord>,
) -> Result<MetadataCandidate> {
    let view = next.as_ref().unwrap_or(state).metadata_view()?;
    Ok(MetadataCandidate {
        expected: state.clone(),
        next,
        view,
        authored,
        expected_wire,
        received_wire,
    })
}

pub fn prepare_authored_batch(
    state: &MetadataState,
    batch: AuthoredMetadataBatch,
    next_version: Revision,
) -> Result<MetadataCandidate> {
    state.metadata_view()?;
    if state.scope() != &batch.scope {
        return Err(Error::IdentityMismatch);
    }
    if state.version() == &next_version {
        return Err(Error::VersionConflict);
    }
    if batch.records.is_empty() && batch.activities.is_empty() {
        return Err(Error::InvalidPayload);
    }
    let mut records = state.records().clone();
    let mut activities = state.activities().clone();
    for (id, record) in &batch.records {
        if records.contains_key(id) || activities.contains_key(id) {
            return Err(Error::DuplicateMismatch);
        }
        records.insert(id.clone(), record.clone());
    }
    for (id, activity) in &batch.activities {
        if records.contains_key(id) || activities.contains_key(id) {
            return Err(Error::DuplicateMismatch);
        }
        activities.insert(id.clone(), activity.clone());
    }
    let next = MetadataState::from_records(batch.scope, next_version, records, activities)?;
    let result = candidate(state, Some(next), batch.emissions, None, None)?;
    let pending = &result.view.namespace().pending;
    for record in batch.records.values() {
        let events = match record.body() {
            GraphRecordBody::Events { events } | GraphRecordBody::ObservedDelete { events } => {
                events
            }
            _ => continue,
        };
        if events.iter().any(|e| pending.contains(&e.id)) {
            return Err(Error::InvalidCausality);
        }
        for event in events {
            let manifest = match &event.effect {
                v2::Effect::Create {
                    content: Some(v2::ContentSeed::Binary { manifest }),
                    ..
                }
                | v2::Effect::SetContent { content: manifest } => manifest,
                _ => continue,
            };
            if !result
                .verification_state()
                .content_status(manifest)?
                .missing
                .is_empty()
            {
                return Err(Error::InvalidContent);
            }
        }
    }
    if batch.activities.keys().any(|id| pending.contains(id)) {
        return Err(Error::InvalidCausality);
    }
    Ok(result)
}

/// Authenticated incoming overlay is included before all-history verification.
/// A present descriptor with missing backing data must fail in the source; only
/// absent descriptors are legitimate pending dependencies. No outbox is made.
pub fn prepare_received(
    state: &MetadataState,
    incoming: &v2::AuthenticatedPayload,
    prior_wire: Option<&WireRecord>,
    next_version: Revision,
) -> Result<MetadataCandidate> {
    state.metadata_view()?;
    let payload = incoming.payload();
    if state.scope() != &payload.scope {
        return Err(Error::IdentityMismatch);
    }
    let record = GraphRecord::from_authenticated(incoming)?;
    if let Some(prior) = prior_wire {
        if prior != incoming.record() {
            return Err(Error::DuplicateMismatch);
        }
        if state.records().get(&payload.id) != Some(&record) {
            return Err(Error::InvalidState);
        }
        return candidate(
            state,
            None,
            vec![],
            Some(prior.clone()),
            Some(incoming.record().clone()),
        );
    }
    if state.version() == &next_version {
        return Err(Error::VersionConflict);
    }
    if state.records().contains_key(&payload.id) || state.activities().contains_key(&payload.id) {
        return Err(Error::DuplicateMismatch);
    }
    let mut records = state.records().clone();
    records.insert(payload.id.clone(), record);
    let next = MetadataState::from_records(
        state.scope().clone(),
        next_version,
        records,
        state.activities().clone(),
    )?;
    candidate(
        state,
        Some(next),
        vec![],
        None,
        Some(incoming.record().clone()),
    )
}

/// Graph half of a received Text plan. The original Text plan and shared exact
/// wire ledger checks remain required in the enclosing atomic transaction.
pub fn prepare_text_activity(
    state: &MetadataState,
    activity: &TextActivity,
    next_version: Revision,
) -> Result<MetadataCandidate> {
    state.metadata_view()?;
    let stored = v2::StoredActivity::from_activity(activity)?;
    stored.graph(state.scope())?;
    if state.records().contains_key(stored.update_id()) {
        return Err(Error::DuplicateMismatch);
    }
    if let Some(prior) = state.activities().get(stored.update_id()) {
        if prior != &stored {
            return Err(Error::DuplicateMismatch);
        }
        return candidate(state, None, vec![], None, None);
    }
    if state.version() == &next_version {
        return Err(Error::VersionConflict);
    }
    let mut activities = state.activities().clone();
    activities.insert(stored.update_id().clone(), stored);
    let next = MetadataState::from_records(
        state.scope().clone(),
        next_version,
        state.records().clone(),
        activities,
    )?;
    candidate(state, Some(next), vec![], None, None)
}
pub fn prepare_authored_text_activity(
    state: &MetadataState,
    activity: &TextActivity,
    next_version: Revision,
) -> Result<MetadataCandidate> {
    let mut batch = AuthoredMetadataBatch::new(state.scope().clone());
    batch.push_text_activity(activity)?;
    prepare_authored_batch(state, batch, next_version)
}
