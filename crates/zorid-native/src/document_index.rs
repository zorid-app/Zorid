//! Native facade for the shared document engines. Source reads use the retained
//! Store projection; no filesystem scan, projection write or vault lock occurs.
use super::NativeVault;
use crate::document_api::*;
use zorid_core::{EntryId, EntryKind};
use zorid_index::{IndexError, IndexSnapshotId, ResolutionView, MAX_GENERATION_METADATA_BYTES};
use zorid_store::DocumentManifest;

impl NativeVault {
    pub fn document_index_status(&self) -> NativeDocumentResult<DocumentIndexStatus> {
        self.paths.verify()?;
        Ok(self.store.document_index_status()?)
    }
    pub fn initialize_document_index(&mut self) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        Ok(self.store.initialize_document_index()?)
    }
    /// Explicitly discards only derived state and expires old pins/stages.
    pub fn rebuild_document_index(&mut self) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        Ok(self.store.rebuild_document_index()?)
    }
    pub fn begin_document_index(&mut self) -> NativeDocumentResult<DocumentIndexStage> {
        self.paths.verify()?;
        Ok(self.store.begin_document_index()?)
    }
    pub fn document_index_stages(&self) -> NativeDocumentResult<Vec<DocumentIndexStage>> {
        self.paths.verify()?;
        Ok(self.store.document_index_stages()?)
    }
    pub fn resume_document_index(
        &self,
        snapshot: &IndexSnapshotId,
    ) -> NativeDocumentResult<DocumentIndexStage> {
        self.paths.verify()?;
        Ok(self.store.resume_document_index(snapshot)?)
    }
    /// One bounded Store pump; parsing happens outside the Store write transaction.
    pub fn pump_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> NativeDocumentResult<DocumentIndexProgress> {
        self.paths.verify()?;
        let progress = self.store.pump_document_index(stage)?;
        self.paths.verify()?;
        Ok(progress)
    }
    pub fn publish_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> NativeDocumentResult<IndexSnapshotId> {
        self.paths.verify()?;
        Ok(self.store.publish_document_index(stage)?)
    }
    pub fn open_document_snapshot(&self) -> NativeDocumentResult<DocumentQueryPin> {
        self.paths.verify()?;
        Ok(self.store.open_document_snapshot()?)
    }
    /// Validate and describe this exact retained pin, including open retries.
    /// No current-head substitution or additional pin allocation takes place.
    pub fn document_snapshot_identity(
        &self,
        pin: &DocumentQueryPin,
    ) -> NativeDocumentResult<DocumentQueryResult<()>> {
        self.document_result(pin, ())
    }
    pub fn close_document_snapshot(&self, pin: DocumentQueryPin) {
        // Dropping a pin is always safe, including after the root becomes unsafe.
        self.store.close_document_snapshot(pin)
    }
    fn document_manifest(&self, pin: &DocumentQueryPin) -> NativeDocumentResult<DocumentManifest> {
        self.paths.verify()?;
        Ok(self.store.document_snapshot_manifest(pin)?)
    }
    fn document_result<T>(
        &self,
        pin: &DocumentQueryPin,
        value: T,
    ) -> NativeDocumentResult<DocumentQueryResult<T>> {
        // A concurrent cache rebuild/eviction during pure evaluation must not
        // make this look like a still-admitted retained generation.
        self.document_manifest(pin)?;
        Ok(DocumentQueryResult {
            snapshot: pin.generation().id().clone(),
            source: pin.generation().manifest().source().clone(),
            coverage_complete: pin.generation().coverage_complete(),
            value,
        })
    }
    pub fn document_metadata(
        &self,
        pin: &DocumentQueryPin,
        id: &EntryId,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentMetadataResult>> {
        self.document_manifest(pin)?;
        let record = pin
            .generation()
            .record(id)
            .ok_or(IndexError::MissingSource)?;
        self.document_result(
            pin,
            DocumentMetadataResult {
                entry: record.witness().entry().clone(),
                metadata: record.metadata().cloned(),
                exclusion: record.exclusion().cloned(),
            },
        )
    }
    /// Shared literal-line semantics over this pin's retained text. Continue with
    /// its token even when a page has no hits; scan and extraction coverage differ.
    pub fn search_documents(
        &self,
        pin: &DocumentQueryPin,
        query: LiteralQuery,
        token: Option<&LiteralToken>,
        limit: usize,
    ) -> NativeDocumentResult<DocumentQueryResult<LiteralPage>> {
        self.document_manifest(pin)?;
        let page = self.store.literal_document_page(pin, query, token, limit)?;
        self.document_result(pin, page)
    }
    pub fn document_relationships(
        &self,
        pin: &DocumentQueryPin,
        max_edges: usize,
        max_bytes: usize,
    ) -> NativeDocumentResult<DocumentQueryResult<ResolutionSnapshot>> {
        self.document_manifest(pin)?;
        let graph = ResolutionView::new(pin.generation()).snapshot(max_edges, max_bytes)?;
        self.document_result(pin, graph)
    }
    /// Incoming shared resolver occurrences, including embeds. The complete
    /// graph has explicit resource ceilings; oversized graphs fail, not truncate.
    pub fn document_backlinks(
        &self,
        pin: &DocumentQueryPin,
        id: &EntryId,
        token: Option<&RelationshipToken>,
        limit: usize,
    ) -> NativeDocumentResult<DocumentQueryResult<RelationshipPage>> {
        self.document_manifest(pin)?;
        let graph = ResolutionView::new(pin.generation())
            .snapshot(100_000, MAX_GENERATION_METADATA_BYTES)?;
        let page = graph.query(id, RelationshipDirection::Incoming, token, limit)?;
        self.document_result(pin, page)
    }
    /// Compile the Base bytes, presentation facts and relationships from exactly
    /// one retained generation. Live source/presentation is never substituted.
    pub fn query_base_document(
        &self,
        pin: &DocumentQueryPin,
        definition: &EntryId,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentBaseResult>> {
        self.query_base_document_inner(pin, definition, None, options)
    }
    /// Resolve a named view through the compiled shared Base program.
    pub fn query_base_document_view(
        &self,
        pin: &DocumentQueryPin,
        definition: &EntryId,
        view_name: &str,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentBaseResult>> {
        self.query_base_document_inner(pin, definition, Some(view_name), options)
    }
    fn query_base_document_inner(
        &self,
        pin: &DocumentQueryPin,
        definition: &EntryId,
        view_name: Option<&str>,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentBaseResult>> {
        let manifest = self.document_manifest(pin)?;
        let projected = self.store.read_document_projection(pin, definition)?;
        let entry = projected.witness.entry().clone();
        let source = projected
            .content
            .ok_or_else(|| NativeDocumentError::SourceUnavailable(definition.clone()))?;
        let source = std::str::from_utf8(&source)
            .map_err(|_| NativeDocumentError::SourceUnavailable(definition.clone()))?;
        let program = zorid_bases::compile_base_source(source)?;
        let mut selected = options.clone();
        if let Some(name) = view_name {
            selected.view_index = program.view_index_by_name(name).ok_or_else(|| {
                zorid_bases::ExpressionDiagnostic::new("view_not_found", "Base view was not found")
            })?;
        }
        let facts = manifest
            .entries()
            .iter()
            .zip(manifest.presentations())
            .filter(|(entry, _)| entry.state.kind == EntryKind::File)
            .map(|(entry, presentation)| zorid_bases::FilePresentationFacts {
                witness: zorid_bases::RecordWitness {
                    entry_id: entry.state.id.clone(),
                    revision: entry.state.revision.clone(),
                },
                size: Some(presentation.size_bytes),
                ctime_ms: i64::try_from(presentation.ctime_ms).ok(),
                mtime_ms: i64::try_from(presentation.mtime_ms).ok(),
            })
            .collect::<Vec<_>>();
        let result = zorid_bases::query_generation(&program, pin.generation(), &facts, &selected)?;
        self.document_result(
            pin,
            DocumentBaseResult {
                definition: entry,
                result,
            },
        )
    }
}

#[cfg(test)]
#[path = "document_index_tests.rs"]
mod tests;
