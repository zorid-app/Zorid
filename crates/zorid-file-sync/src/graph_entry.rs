//! A complete single-entry causal reduction. Namespace placement is deliberately
//! supplied separately by the indexed namespace resolver, never inferred from
//! an incomplete vault. Candidates confer no persistence authority.
use crate::{
    graph_facts::{Event, SourceEvent},
    *,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CausalEntry {
    pub identity: EntryIdentity,
    pub kind: EntryKind,
    pub heads: Vec<UpdateId>,
    pub contents: Vec<ContentHead>,
    pub locations: Vec<LocationHead>,
    pub liveness: Liveness,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EntryReduction {
    entry: Option<CausalEntry>,
    binding: Option<v2::ContentBinding>,
    pending: BTreeSet<UpdateId>,
}
impl EntryReduction {
    pub fn entry(&self) -> Option<&CausalEntry> {
        self.entry.as_ref()
    }
    pub fn binding(&self) -> Option<&v2::ContentBinding> {
        self.binding.as_ref()
    }
    pub fn pending(&self) -> &BTreeSet<UpdateId> {
        &self.pending
    }
    pub fn project(self, projection: Projection) -> Option<EntryView> {
        let entry = self.entry?;
        Some(EntryView {
            identity: entry.identity,
            kind: entry.kind,
            heads: entry.heads,
            contents: entry.contents,
            locations: entry.locations,
            liveness: entry.liveness,
            projection,
        })
    }
}
/// The caller proves complete source-backed selection and cross-entry ID-role
/// compatibility. Limits apply to this entry's history, not the vault size.
/// Binary status is resolved independently from exact manifest sources.
pub fn reduce(
    scope: &Scope,
    id: &EntryId,
    source: &[SourceEvent],
    resolve_content: impl FnMut(&Manifest) -> Result<ContentStatus>,
) -> Result<EntryReduction> {
    if source.len() > MAX_EVENTS {
        return Err(Error::TooLarge);
    }
    let mut events = BTreeMap::new();
    let mut binding = None;
    for event in source {
        if &event.identity().entry_id != id {
            return Err(Error::IdentityMismatch);
        }
        if let Some(value) = event.content_binding() {
            if binding.as_ref().is_some_and(|old| old != &value) {
                return Err(Error::IdentityMismatch);
            }
            binding = Some(value);
        }
        let graph = match event.event() {
            Event::File(value) => value.graph()?,
            Event::Text(value) => {
                let value_binding = v2::ContentBinding::Text {
                    text_bootstrap_id: value.identity().bootstrap_id.clone(),
                    text_format: zorid_client_sync::v2::TEXT_FORMAT_VERSION,
                };
                if binding.as_ref().is_some_and(|old| old != &value_binding) {
                    return Err(Error::IdentityMismatch);
                }
                binding = Some(value_binding);
                value.graph(scope)?
            }
        };
        if events.insert(event.id().clone(), graph).is_some() {
            return Err(Error::DuplicateMismatch);
        }
    }
    let (mut view, _) = derive_graph_with_status(events, resolve_content)?;
    let entry = view.entries.remove(id).map(|entry| CausalEntry {
        identity: entry.identity,
        kind: entry.kind,
        heads: entry.heads,
        contents: entry.contents,
        locations: entry.locations,
        liveness: entry.liveness,
    });
    Ok(EntryReduction {
        entry,
        binding,
        pending: view.pending,
    })
}
