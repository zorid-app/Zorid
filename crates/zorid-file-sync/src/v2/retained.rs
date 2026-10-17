use super::*;

impl State {
    /// Validate and materialize an immutable historical binary-content witness.
    /// The manifest is derived from the retained event; callers cannot substitute
    /// an arbitrary manifest backed by unrelated chunks in the same vault.
    ///
    /// A dominated content event, Recovery entry or Tombstone may still be read.
    /// This does not authorize normal-path projection or claim the chosen event
    /// is current. `None` means required binary dependencies are unavailable,
    /// whereas `Some(Vec::new())` is a validated empty file. If a host previously
    /// committed these bytes as retained, missing dependencies indicate damaged
    /// storage and must not be interpreted as an empty replacement.
    pub fn materialize_retained_binary(
        &self,
        identity: &EntryIdentity,
        content_event: &UpdateId,
    ) -> Result<Option<Vec<u8>>> {
        let (view, graph) = self.view_and_ancestry()?;
        let event = graph.resolved_event(content_event)?;
        if event.identity != *identity {
            return Err(Error::IdentityMismatch);
        }
        if view.content_bindings.get(&identity.entry_id) != Some(&ContentBinding::Binary) {
            return Err(Error::InvalidContent);
        }
        let manifest = match &event.effect {
            GraphEffect::Create {
                content: Some(manifest),
                entry_kind: EntryKind::File,
                ..
            }
            | GraphEffect::SetContent { content: manifest } => manifest,
            _ => return Err(Error::InvalidContent),
        };
        self.binary_records().materialize(manifest)
    }
}
