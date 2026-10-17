//! Additive local metadata representation for bounded binary content sources.
//! Wire Payload remains files-v2. Metadata is not an authentication or complete
//! content capability; hosts bind restored descriptors to immutable ledgers.
use crate::{
    v2, ChunkPage, ContentStatus, EntryIdentity, Error, Manifest, Result, Scope, Sha256Digest,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zorid_core::{EntryId, Revision};
use zorid_sync_protocol::{UpdateId, MAX_PLAINTEXT_BYTES};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GraphRecordBody {
    Events { events: Vec<v2::EntryEvent> },
    ObservedDelete { events: Vec<v2::EntryEvent> },
    Page { page: ChunkPage },
    Chunk { bytes: u32, digest: Sha256Digest },
}
impl GraphRecordBody {
    fn events(&self) -> &[v2::EntryEvent] {
        match self {
            Self::Events { events } | Self::ObservedDelete { events } => events,
            _ => &[],
        }
    }
    fn validate(&self) -> Result<()> {
        match self {
            Self::Events { events } => v2::Body::Events {
                events: events.clone(),
            }
            .validate(),
            Self::ObservedDelete { events } => v2::Body::ObservedDelete {
                events: events.clone(),
            }
            .validate(),
            Self::Page { page } => page.validate().map(|_| ()),
            Self::Chunk { bytes, .. }
                if *bytes > 0 && *bytes as usize <= crate::MAX_CHUNK_BYTES =>
            {
                Ok(())
            }
            Self::Chunk { .. } => Err(Error::TooLarge),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphRecord {
    payload_bytes: u32,
    payload_digest: Sha256Digest,
    body: GraphRecordBody,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedRecord {
    payload_bytes: u32,
    payload_digest: Sha256Digest,
    body: GraphRecordBody,
}
impl GraphRecord {
    /// Exact accepted plaintext is committed, never a canonical re-encoding.
    pub fn from_authenticated(incoming: &v2::AuthenticatedPayload) -> Result<Self> {
        Self::from_checked_payload(incoming.payload(), incoming.payload_bytes())
    }
    /// Strictly decoded local authorship data. This is NOT authentication.
    pub fn from_authored_exact(exact: &[u8]) -> Result<(Scope, UpdateId, Self)> {
        let payload = v2::Payload::decode(exact)?;
        let record = Self::from_checked_payload(&payload, exact)?;
        Ok((payload.scope, payload.id, record))
    }
    fn from_checked_payload(payload: &v2::Payload, exact: &[u8]) -> Result<Self> {
        if exact.is_empty() || exact.len() > MAX_PLAINTEXT_BYTES {
            return Err(Error::TooLarge);
        }
        let body = match &payload.body {
            v2::Body::Events { events } => GraphRecordBody::Events {
                events: events.clone(),
            },
            v2::Body::ObservedDelete { events } => GraphRecordBody::ObservedDelete {
                events: events.clone(),
            },
            v2::Body::Page { page } => GraphRecordBody::Page { page: page.clone() },
            v2::Body::Chunk { bytes } => GraphRecordBody::Chunk {
                bytes: bytes.len() as u32,
                digest: Sha256Digest::of(bytes),
            },
        };
        let record = Self {
            payload_bytes: exact.len() as u32,
            payload_digest: Sha256Digest::of(exact),
            body,
        };
        record.validate()?;
        Ok(record)
    }
    /// Metadata-only restoration. Expected commitments must come from the
    /// checked immutable ledger, not the same untrusted descriptor JSON.
    /// Returned metadata still does not prove actual backing content.
    pub fn from_persisted_json(
        raw: &str,
        expected_bytes: u32,
        expected_payload: Sha256Digest,
        expected_summary: Sha256Digest,
    ) -> Result<Self> {
        if raw.len() > MAX_GRAPH_RECORD_BYTES {
            return Err(Error::TooLarge);
        }
        let raw: PersistedRecord = serde_json::from_str(raw).map_err(|_| Error::InvalidState)?;
        let record = Self {
            payload_bytes: raw.payload_bytes,
            payload_digest: raw.payload_digest,
            body: raw.body,
        };
        record.validate()?;
        if record.payload_bytes != expected_bytes
            || record.payload_digest != expected_payload
            || record.summary_digest()? != expected_summary
        {
            return Err(Error::InvalidState);
        }
        Ok(record)
    }
    fn validate(&self) -> Result<()> {
        if self.payload_bytes == 0 || self.payload_bytes as usize > MAX_PLAINTEXT_BYTES {
            return Err(Error::TooLarge);
        }
        self.body.validate()?;
        if serde_json::to_vec(self)
            .map_err(|_| Error::InvalidState)?
            .len()
            > MAX_GRAPH_RECORD_BYTES
        {
            return Err(Error::TooLarge);
        }
        Ok(())
    }
    pub fn body(&self) -> &GraphRecordBody {
        &self.body
    }
    pub fn payload_bytes(&self) -> u32 {
        self.payload_bytes
    }
    pub fn payload_digest(&self) -> &Sha256Digest {
        &self.payload_digest
    }
    pub fn summary_digest(&self) -> Result<Sha256Digest> {
        Ok(Sha256Digest::of(
            &serde_json::to_vec(self).map_err(|_| Error::InvalidState)?,
        ))
    }
}
/// This is a local representation discriminator, not authenticated wire v2.
pub const METADATA_FORMAT_VERSION: u32 = 1;
/// A descriptor adds a digest/length wrapper to an otherwise bounded wire body.
/// This is a local wrapper allowance, never a larger wire/plaintext limit.
pub const MAX_GRAPH_RECORD_BYTES: usize = MAX_PLAINTEXT_BYTES + 4096;

/// All backing chunk bodies are external to this local state. No Deserialize:
/// hosts restore records with checked ledger commitments, then validate roles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MetadataState {
    format_version: u32,
    scope: Scope,
    version: Revision,
    records: BTreeMap<UpdateId, GraphRecord>,
    activities: BTreeMap<UpdateId, v2::StoredActivity>,
}
/// Namespace and dependency information ONLY. No complete-content capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataView {
    view: v2::VaultView,
}
impl MetadataView {
    pub fn namespace(&self) -> &crate::VaultView {
        &self.view.namespace
    }
    pub fn content_bindings(&self) -> &BTreeMap<EntryId, v2::ContentBinding> {
        &self.view.content_bindings
    }
}
/// A retained causal content identity, not a verified byte/physical-path proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BinaryContentRef {
    scope: Scope,
    entry: EntryIdentity,
    selected_event: UpdateId,
    manifest: Manifest,
}
impl BinaryContentRef {
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn entry(&self) -> &EntryIdentity {
        &self.entry
    }
    pub fn selected_event(&self) -> &UpdateId {
        &self.selected_event
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
}
impl MetadataState {
    pub fn empty(scope: Scope, version: Revision) -> Self {
        Self {
            format_version: METADATA_FORMAT_VERSION,
            scope,
            version,
            records: BTreeMap::new(),
            activities: BTreeMap::new(),
        }
    }
    pub fn from_records(
        scope: Scope,
        version: Revision,
        records: BTreeMap<UpdateId, GraphRecord>,
        activities: BTreeMap<UpdateId, v2::StoredActivity>,
    ) -> Result<Self> {
        let state = Self {
            format_version: METADATA_FORMAT_VERSION,
            scope,
            version,
            records,
            activities,
        };
        state.metadata_view()?;
        Ok(state)
    }
    // Legacy callers retain their historical exact encoded graph budget and
    // byte-verifying view. This conversion never grants ledger authentication.
    pub(crate) fn from_legacy(state: &v2::State) -> Result<Self> {
        if state.records().len() + state.activities().len() > crate::MAX_RECORDS {
            return Err(Error::TooLarge);
        }
        let mut records = BTreeMap::new();
        let mut size = 0usize;
        for (id, payload) in state.records() {
            if id != &payload.id || &payload.scope != state.scope() {
                return Err(Error::InvalidState);
            }
            let exact = payload.encode()?;
            size = size.checked_add(exact.len()).ok_or(Error::TooLarge)?;
            if size > crate::MAX_STATE_BYTES {
                return Err(Error::TooLarge);
            }
            records.insert(
                id.clone(),
                GraphRecord::from_checked_payload(payload, &exact)?,
            );
        }
        for activity in state.activities().values() {
            size = size
                .checked_add(
                    serde_json::to_vec(activity)
                        .map_err(|_| Error::InvalidState)?
                        .len(),
                )
                .ok_or(Error::TooLarge)?;
            if size > crate::MAX_STATE_BYTES {
                return Err(Error::TooLarge);
            }
        }
        Ok(Self {
            format_version: METADATA_FORMAT_VERSION,
            scope: state.scope().clone(),
            version: state.version().clone(),
            records,
            activities: state.activities().clone(),
        })
    }
    pub fn format_version(&self) -> u32 {
        self.format_version
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn version(&self) -> &Revision {
        &self.version
    }
    pub fn records(&self) -> &BTreeMap<UpdateId, GraphRecord> {
        &self.records
    }
    pub fn activities(&self) -> &BTreeMap<UpdateId, v2::StoredActivity> {
        &self.activities
    }
    pub fn fingerprint(&self) -> Result<Sha256Digest> {
        use sha2::{Digest, Sha256};
        struct HashWriter(Sha256);
        impl std::io::Write for HashWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.update(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = HashWriter(Sha256::new());
        serde_json::to_writer(&mut writer, self).map_err(|_| Error::InvalidState)?;
        Ok(Sha256Digest(writer.0.finalize().into()))
    }
    pub fn metadata_view(&self) -> Result<MetadataView> {
        let (events, mut content_bindings) = self.graph_inputs()?;
        let (namespace, _) =
            crate::derive_graph_with_status(events, |manifest| self.content_status(manifest))?;
        content_bindings.retain(|id, _| namespace.entries.contains_key(id));
        Ok(MetadataView {
            view: v2::VaultView {
                namespace,
                content_bindings,
            },
        })
    }
    pub fn binary_content_ref(
        &self,
        identity: &EntryIdentity,
        event: &UpdateId,
    ) -> Result<BinaryContentRef> {
        let (events, bindings) = self.graph_inputs()?;
        let (_, ancestry) =
            crate::derive_graph_with_status(events, |manifest| self.content_status(manifest))?;
        let found = ancestry.resolved_event(event)?;
        if &found.identity != identity {
            return Err(Error::IdentityMismatch);
        }
        if bindings.get(&identity.entry_id) != Some(&v2::ContentBinding::Binary) {
            return Err(Error::InvalidContent);
        }
        let manifest = match &found.effect {
            crate::GraphEffect::Create {
                entry_kind: zorid_core::EntryKind::File,
                content: Some(manifest),
                ..
            }
            | crate::GraphEffect::SetContent { content: manifest } => manifest,
            _ => return Err(Error::InvalidContent),
        };
        Ok(BinaryContentRef {
            scope: self.scope.clone(),
            entry: identity.clone(),
            selected_event: event.clone(),
            manifest: manifest.clone(),
        })
    }
    pub(crate) fn manifests(&self) -> impl Iterator<Item = &Manifest> {
        self.records
            .values()
            .flat_map(|record| record.body.events())
            .filter_map(|event| match &event.effect {
                v2::Effect::Create {
                    content: Some(v2::ContentSeed::Binary { manifest }),
                    ..
                }
                | v2::Effect::SetContent { content: manifest } => Some(manifest),
                _ => None,
            })
    }
    pub(crate) fn content_status(&self, manifest: &Manifest) -> Result<ContentStatus> {
        manifest.validate()?;
        let mut missing = BTreeSet::new();
        for reference in &manifest.pages {
            let Some(record) = self.records.get(&reference.id) else {
                missing.insert(reference.id.clone());
                continue;
            };
            let GraphRecordBody::Page { page } = &record.body else {
                return Err(Error::InvalidContent);
            };
            if page.reference(reference.id.clone())? != *reference {
                return Err(Error::InvalidContent);
            }
            for chunk in &page.chunks {
                let Some(record) = self.records.get(&chunk.id) else {
                    missing.insert(chunk.id.clone());
                    continue;
                };
                let GraphRecordBody::Chunk { bytes, digest } = &record.body else {
                    return Err(Error::InvalidContent);
                };
                if *bytes != chunk.bytes || *digest != chunk.digest {
                    return Err(Error::InvalidContent);
                }
            }
        }
        Ok(ContentStatus { missing })
    }
    pub(crate) fn graph_inputs(
        &self,
    ) -> Result<(
        BTreeMap<UpdateId, crate::GraphEvent>,
        BTreeMap<EntryId, v2::ContentBinding>,
    )> {
        self.graph_inputs_with_budget(true)
    }
    pub(crate) fn legacy_graph_inputs(
        &self,
    ) -> Result<(
        BTreeMap<UpdateId, crate::GraphEvent>,
        BTreeMap<EntryId, v2::ContentBinding>,
    )> {
        self.graph_inputs_with_budget(false)
    }
    fn graph_inputs_with_budget(
        &self,
        enforce_metadata_budget: bool,
    ) -> Result<(
        BTreeMap<UpdateId, crate::GraphEvent>,
        BTreeMap<EntryId, v2::ContentBinding>,
    )> {
        if self.records.len() + self.activities.len() > crate::MAX_RECORDS {
            return Err(Error::TooLarge);
        }
        let mut size = 0usize;
        let mut events = BTreeMap::new();
        let mut owners = BTreeMap::<UpdateId, EntryId>::new();
        let mut bind_owner = |bootstrap: &UpdateId, entry: &EntryId| -> Result<()> {
            if let Some(prior) = owners.insert(bootstrap.clone(), entry.clone()) {
                if prior != *entry {
                    return Err(Error::IdentityMismatch);
                }
            }
            Ok(())
        };
        let mut content_bindings = BTreeMap::new();
        let mut namespace_roots = BTreeSet::new();
        let mut text_roots = BTreeSet::new();
        for (id, p) in &self.records {
            p.validate()?;
            if enforce_metadata_budget {
                size = size
                    .checked_add(
                        serde_json::to_vec(p)
                            .map_err(|_| Error::InvalidState)?
                            .len(),
                    )
                    .ok_or(Error::TooLarge)?;
                if size > crate::MAX_STATE_BYTES {
                    return Err(Error::TooLarge);
                }
            }
            for e in p.body.events() {
                bind_owner(&e.identity.bootstrap_id, &e.identity.entry_id)?;
                namespace_roots.insert(e.identity.bootstrap_id.clone());
                // Event IDs cannot alias a different envelope/chunk ID, even if
                // the other record currently contains no causal events.
                if (self.records.contains_key(&e.id) && &e.id != id)
                    || self.activities.contains_key(&e.id)
                {
                    return Err(Error::DuplicateMismatch);
                }
                if events.insert(e.id.clone(), e.graph()?).is_some() {
                    return Err(Error::DuplicateMismatch);
                }
                if events.len() > crate::MAX_EVENTS {
                    return Err(Error::TooLarge);
                }
                if let v2::Effect::Create {
                    content: Some(seed),
                    ..
                } = &e.effect
                {
                    let binding = match seed {
                        v2::ContentSeed::Binary { .. } => v2::ContentBinding::Binary,
                        v2::ContentSeed::Text {
                            text_bootstrap_id,
                            text_format,
                        } => {
                            bind_owner(text_bootstrap_id, &e.identity.entry_id)?;
                            text_roots.insert(text_bootstrap_id.clone());
                            v2::ContentBinding::Text {
                                text_bootstrap_id: text_bootstrap_id.clone(),
                                text_format: *text_format,
                            }
                        }
                    };
                    content_bindings.insert(e.identity.entry_id.clone(), binding);
                }
            }
        }
        for (id, a) in &self.activities {
            if id != a.update_id() || self.records.contains_key(id) {
                return Err(Error::DuplicateMismatch);
            }
            bind_owner(&a.namespace().bootstrap_id, &a.identity().entry_id)?;
            bind_owner(&a.identity().bootstrap_id, &a.identity().entry_id)?;
            namespace_roots.insert(a.namespace().bootstrap_id.clone());
            text_roots.insert(a.identity().bootstrap_id.clone());
            size = size
                .checked_add(
                    serde_json::to_vec(a)
                        .map_err(|_| Error::InvalidState)?
                        .len(),
                )
                .ok_or(Error::TooLarge)?;
            if size > crate::MAX_STATE_BYTES {
                return Err(Error::TooLarge);
            }
            if events.insert(id.clone(), a.graph(&self.scope)?).is_some() {
                return Err(Error::DuplicateMismatch);
            }
        }
        // Bootstrap reservations have roles, not merely entry ownership. A
        // text root may equal its namespace Create, but never an ordinary event.
        for (bootstrap, entry) in &owners {
            if let Some(p) = self.records.get(bootstrap) {
                if !p.body.events().iter().any(|e| {
                    &e.id == bootstrap
                        && &e.identity.entry_id == entry
                        && matches!(e.effect, v2::Effect::Create { .. })
                }) {
                    return Err(Error::IdentityMismatch);
                }
            }
            if let Some(e) = events.get(bootstrap) {
                if &e.identity.entry_id != entry
                    || e.identity.bootstrap_id != *bootstrap
                    || !matches!(
                        e.effect,
                        crate::GraphEffect::Create { .. } | crate::GraphEffect::CreateText { .. }
                    )
                {
                    return Err(Error::IdentityMismatch);
                }
                if text_roots.contains(bootstrap)
                    && !matches!(&e.effect,crate::GraphEffect::CreateText {binding,..} if binding.text_bootstrap_id == *bootstrap)
                {
                    return Err(Error::IdentityMismatch);
                }
            }
        }
        for event in events.values() {
            for parent in &event.parents {
                if !events.contains_key(parent)
                    && (self.records.contains_key(parent)
                        || (text_roots.contains(parent) && !namespace_roots.contains(parent)))
                {
                    return Err(Error::InvalidCausality);
                }
            }
        }
        // Missing dependencies are pending; IDs already occupied by another kind
        // are contradictions, not missing binary downloads.
        for payload in self.records.values() {
            if let GraphRecordBody::Page { page } = &payload.body {
                for chunk in &page.chunks {
                    if events.contains_key(&chunk.id)
                        || owners.contains_key(&chunk.id)
                        || self
                            .records
                            .get(&chunk.id)
                            .is_some_and(|p| !matches!(p.body, GraphRecordBody::Chunk { .. }))
                    {
                        return Err(Error::InvalidContent);
                    }
                }
            }
            for event in payload.body.events() {
                let manifest = match &event.effect {
                    v2::Effect::Create {
                        content: Some(v2::ContentSeed::Binary { manifest }),
                        ..
                    } => Some(manifest),
                    v2::Effect::SetContent { content } => Some(content),
                    _ => None,
                };
                if let Some(manifest) = manifest {
                    for page in &manifest.pages {
                        if events.contains_key(&page.id)
                            || owners.contains_key(&page.id)
                            || self
                                .records
                                .get(&page.id)
                                .is_some_and(|p| !matches!(p.body, GraphRecordBody::Page { .. }))
                        {
                            return Err(Error::InvalidContent);
                        }
                    }
                }
            }
        }
        // Unresolved references reserve roles too: a missing ID cannot promise
        // both an event and a chunk/page, or events belonging to two entries.
        #[derive(PartialEq, Eq)]
        enum Role {
            Event(EntryIdentity),
            Page,
            Chunk,
            Envelope,
            TextBootstrap(EntryId),
        }
        let mut roles = BTreeMap::new();
        let mut expected_pages = BTreeMap::new();
        let mut expected_chunks = BTreeMap::new();
        let mut reserve = |id: &UpdateId, role: Role| -> Result<()> {
            if let Some(prior) = roles.insert(id.clone(), role) {
                let current = &roles[id];
                if prior != *current {
                    return Err(
                        if matches!((&prior, current), (Role::Event(_), Role::Event(_))) {
                            Error::IdentityMismatch
                        } else {
                            Error::InvalidContent
                        },
                    );
                }
            }
            Ok(())
        };
        for event in events.values() {
            reserve(&event.id, Role::Event(event.identity.clone()))?;
            reserve(
                &event.identity.bootstrap_id,
                Role::Event(event.identity.clone()),
            )?;
            for parent in &event.parents {
                reserve(parent, Role::Event(event.identity.clone()))?;
            }
        }
        for root in &text_roots {
            if !namespace_roots.contains(root) {
                reserve(root, Role::TextBootstrap(owners[root].clone()))?;
            }
        }
        for (record_id, payload) in &self.records {
            let role = match &payload.body {
                GraphRecordBody::Page { .. } => Role::Page,
                GraphRecordBody::Chunk { .. } => Role::Chunk,
                _ => events
                    .get(record_id)
                    .map(|e| Role::Event(e.identity.clone()))
                    .unwrap_or(Role::Envelope),
            };
            reserve(record_id, role)?;
            if let GraphRecordBody::Page { page } = &payload.body {
                for chunk in &page.chunks {
                    if expected_chunks
                        .insert(chunk.id.clone(), chunk)
                        .is_some_and(|prior| prior != chunk)
                    {
                        return Err(Error::InvalidContent);
                    }
                    reserve(&chunk.id, Role::Chunk)?;
                }
            }
            for event in payload.body.events() {
                let manifest = match &event.effect {
                    v2::Effect::Create {
                        content: Some(v2::ContentSeed::Binary { manifest }),
                        ..
                    } => Some(manifest),
                    v2::Effect::SetContent { content } => Some(content),
                    _ => None,
                };
                if let Some(manifest) = manifest {
                    for page in &manifest.pages {
                        if expected_pages
                            .insert(page.id.clone(), page)
                            .is_some_and(|prior| prior != page)
                        {
                            return Err(Error::InvalidContent);
                        }
                        reserve(&page.id, Role::Page)?;
                    }
                }
            }
        }
        // Validate references even for orphan pages not yet reachable from a
        // manifest. Otherwise known contradictory chunks could be committed.
        for (id, expected) in expected_pages {
            if let Some(payload) = self.records.get(&id) {
                let GraphRecordBody::Page { page } = &payload.body else {
                    return Err(Error::InvalidContent);
                };
                if page.reference(id)? != *expected {
                    return Err(Error::InvalidContent);
                }
            }
        }
        for (id, expected) in expected_chunks {
            if let Some(payload) = self.records.get(&id) {
                let GraphRecordBody::Chunk { bytes, digest } = &payload.body else {
                    return Err(Error::InvalidContent);
                };
                if *bytes != expected.bytes || *digest != expected.digest {
                    return Err(Error::InvalidContent);
                }
            }
        }
        Ok((events, content_bindings))
    }
}
