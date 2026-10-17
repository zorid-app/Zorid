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
        self.materialize_retained_binary_bounded(identity, content_event, crate::MAX_FILE_BYTES)
    }
    /// Apply a caller's output-byte budget before allocating the expanded file.
    /// A compact manifest may repeat chunk references, so serialized state size
    /// is not a bound on materialized bytes. Graph/reference validation remains
    /// mandatory and bounded by the core's normal limits.
    pub fn materialize_retained_binary_bounded(
        &self,
        identity: &EntryIdentity,
        content_event: &UpdateId,
        max_bytes: u64,
    ) -> Result<Option<Vec<u8>>> {
        let manifest = self.retained_binary_manifest(identity, content_event, max_bytes)?;
        self.binary_records().materialize(&manifest)
    }
    /// Check a persisted binary value against its exact immutable content event.
    /// This also binds the saved manifest and selected-event witness; equal bytes
    /// or a valid unrelated manifest in the same vault are insufficient.
    /// Missing dependencies are invalid for a previously retained complete value.
    pub fn validate_retained_binary_content(
        &self,
        identity: &EntryIdentity,
        content_event: &UpdateId,
        verified: &crate::materialization::VerifiedContent,
        max_bytes: u64,
    ) -> Result<()> {
        if verified.bytes.len() as u64 > max_bytes
            || verified.bytes.len() as u64 > crate::MAX_FILE_BYTES
        {
            return Err(Error::TooLarge);
        }
        let crate::materialization::ContentWitness::Binary {
            selected_event,
            manifest: saved_manifest,
        } = &verified.witness
        else {
            return Err(Error::InvalidContent);
        };
        if selected_event != content_event {
            return Err(Error::InvalidContent);
        }
        let manifest = self.retained_binary_manifest(identity, content_event, max_bytes)?;
        if *saved_manifest != manifest
            || verified.digest != manifest.digest
            || verified.bytes.len() as u64 != manifest.bytes
            || Sha256Digest::of(&verified.bytes) != verified.digest
        {
            return Err(Error::InvalidContent);
        }
        let bytes = self.binary_records().materialize(&manifest)?;
        if bytes.as_ref() != Some(&verified.bytes) {
            return Err(Error::InvalidContent);
        }
        Ok(())
    }
    fn retained_binary_manifest(
        &self,
        identity: &EntryIdentity,
        content_event: &UpdateId,
        max_bytes: u64,
    ) -> Result<Manifest> {
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
        if manifest.bytes > max_bytes {
            return Err(Error::TooLarge);
        }
        Ok(manifest.clone())
    }
}
