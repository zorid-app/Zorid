//! Native facade for the shared document engines. Source reads use the retained
//! Store projection; no filesystem scan, projection write or vault lock occurs.
use super::NativeVault;
use crate::document_api::*;
use zorid_core::{EntryId, EntryKind};
use zorid_index::{IndexError, IndexSnapshotId, ResolutionView, MAX_GENERATION_METADATA_BYTES};
use zorid_store::DocumentManifest;

impl NativeVault {
    /// Persist derived data in a host-owned app-local database. Ordinary vault
    /// opens remain usable with a temporary cache if this optional setup fails.
    pub fn enable_local_document_cache(
        &mut self,
        path: impl AsRef<std::path::Path>,
    ) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        let path = path.as_ref();
        let parent = path
            .parent()
            .ok_or_else(|| crate::Error::UnsafePath("cache parent missing".into()))?
            .canonicalize()
            .map_err(crate::Error::from)?;
        if parent.starts_with(&self.paths.absolute) {
            return Err(
                crate::Error::UnsafePath("local cache must be outside the vault".into()).into(),
            );
        }
        let name = path
            .file_name()
            .ok_or_else(|| crate::Error::UnsafePath("cache filename missing".into()))?;
        self.store.enable_document_cache(parent.join(name))?;
        self.retire_document_previews();
        self.base_preparation_cache.borrow_mut().clear();
        self.clear_rich_document_queries();
        self.retire_document_runtime_for_cache_change();
        Ok(())
    }
    pub fn document_index_status(&self) -> NativeDocumentResult<DocumentIndexStatus> {
        self.paths.verify()?;
        Ok(self.store.document_index_status()?)
    }
    /// Pin cache before observing authority, including uninitialized/building/
    /// rebuild-required states. Cache may lag source; this is not cross-DB atomicity.
    pub fn document_index_status_with_source(
        &self,
    ) -> NativeDocumentResult<(SourceSnapshotId, DocumentIndexStatus)> {
        self.paths.verify()?;
        Ok(self.store.document_index_status_with_source()?)
    }
    pub fn initialize_document_index(&mut self) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        Ok(self.store.initialize_document_index()?)
    }
    /// Explicitly discards only derived state and expires old pins/stages.
    pub fn rebuild_document_index(&mut self) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        self.store.rebuild_document_index()?;
        self.retire_document_previews();
        self.base_preparation_cache.borrow_mut().clear();
        self.clear_rich_document_queries();
        Ok(())
    }
    pub fn begin_document_index(&mut self) -> NativeDocumentResult<DocumentIndexStage> {
        self.paths.verify()?;
        Ok(self.store.begin_document_index()?)
    }
    /// Discard only the addressed unpublished derived stage, including stale
    /// work. Published snapshots and authoritative source remain intact.
    pub fn discard_document_index_stage(
        &mut self,
        snapshot: &IndexSnapshotId,
    ) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        self.store.discard_document_index_stage(snapshot)?;
        self.retire_document_previews();
        Ok(())
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
    /// Bounded newest-first durable recovery; the Store retains all source/head/
    /// epoch fences and propagates corruption instead of treating it as a miss.
    pub fn recover_document_index_stage(
        &self,
    ) -> NativeDocumentResult<Option<(DocumentIndexStage, zorid_store::DocumentStageProgress)>> {
        self.paths.verify()?;
        let recovered = self.store.recover_document_index_stage()?;
        self.paths.verify()?;
        Ok(recovered)
    }
    /// One bounded Store pump; parsing happens outside the Store write transaction.
    pub fn pump_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> NativeDocumentResult<DocumentIndexProgress> {
        self.paths.verify()?;
        let progress = match self.pump_document_index_preview(stage)? {
            Some(progress) => progress,
            None => self.store.pump_document_index(stage)?,
        };
        self.paths.verify()?;
        Ok(progress)
    }
    pub fn publish_document_index(
        &mut self,
        stage: &DocumentIndexStage,
    ) -> NativeDocumentResult<IndexSnapshotId> {
        self.paths.verify()?;
        let published = self.store.publish_document_index(stage)?;
        self.retire_document_previews();
        Ok(published)
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
    pub(crate) fn document_manifest(
        &self,
        pin: &DocumentQueryPin,
    ) -> NativeDocumentResult<DocumentManifest> {
        self.paths.verify()?;
        Ok(self.store.document_snapshot_manifest(pin)?)
    }
    pub(crate) fn document_result<T>(
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
    /// Bodyless registration check for already admitted immutable metadata.
    /// Never substitutes a current head or reconstructs a retained manifest.
    pub fn check_document_metadata_pin_registration(
        &self,
        pin: &DocumentQueryPin,
    ) -> NativeDocumentResult<()> {
        self.paths.verify()?;
        self.store.check_document_metadata_pin_registration(pin)?;
        self.paths.verify()?;
        Ok(())
    }
    pub fn begin_document_metadata_rows(
        &self,
        pin: &DocumentQueryPin,
        baseline: Option<&DocumentQueryPin>,
        limit: usize,
        check: &mut impl FnMut() -> bool,
    ) -> NativeDocumentResult<NativeMetadataRows> {
        self.check_document_metadata_pin_registration(pin)?;
        if let Some(old) = baseline {
            self.check_document_metadata_pin_registration(old)?;
        }
        let destination = pin.shared_generation();
        let mut baseline_data = baseline.map(DocumentQueryPin::shared_generation);
        let scan = zorid_index::MetadataRowsScan::new_checked(
            destination.clone(),
            baseline_data.clone(),
            limit,
            check,
        )
        .map_err(metadata_error)?;
        if scan.mode() == zorid_index::MetadataRowsMode::Reset {
            baseline_data = None;
        }
        let cursor = NativeMetadataRows {
            scan,
            destination,
            baseline: baseline_data,
            checkpoint: std::sync::Arc::new(()),
            next_checkpoint: std::sync::Arc::new(()),
        };
        self.check_metadata_cursor(
            pin,
            if cursor.uses_baseline() {
                baseline
            } else {
                None
            },
            &cursor,
        )?;
        Ok(cursor)
    }
    fn check_metadata_cursor(
        &self,
        pin: &DocumentQueryPin,
        baseline: Option<&DocumentQueryPin>,
        cursor: &NativeMetadataRows,
    ) -> NativeDocumentResult<()> {
        if !std::sync::Arc::ptr_eq(&pin.shared_generation(), &cursor.destination)
            || match (baseline, cursor.baseline.as_ref()) {
                (None, None) => false,
                (Some(pin), Some(data)) => !std::sync::Arc::ptr_eq(&pin.shared_generation(), data),
                _ => true,
            }
        {
            return Err(IndexError::QueryMismatch.into());
        }
        self.check_document_metadata_pin_registration(pin)?;
        if let Some(old) = baseline {
            self.check_document_metadata_pin_registration(old)?;
        }
        Ok(())
    }
    pub fn document_metadata_rows(
        &self,
        pin: &DocumentQueryPin,
        baseline: Option<&DocumentQueryPin>,
        cursor: &NativeMetadataRows,
        check: &mut impl FnMut() -> bool,
    ) -> NativeDocumentResult<DocumentQueryResult<PreparedMetadataRowsPage>> {
        self.check_metadata_cursor(pin, baseline, cursor)?;
        let page = cursor.scan.page_checked(check).map_err(metadata_error)?;
        self.check_metadata_cursor(pin, baseline, cursor)?;
        if !check() {
            return Err(NativeDocumentError::QueryCancelled);
        }
        Ok(DocumentQueryResult {
            snapshot: page.snapshot().clone(),
            source: page.source().clone(),
            coverage_complete: page.coverage_complete(),
            value: page,
        })
    }
    /// The host encodes the complete response and rechecks its actual client
    /// registrations BEFORE this final native fence and local checkpoint commit.
    pub fn commit_document_metadata_rows(
        &self,
        pin: &DocumentQueryPin,
        baseline: Option<&DocumentQueryPin>,
        cursor: &mut NativeMetadataRows,
        page: PreparedMetadataRowsPage,
        check: &mut impl FnMut() -> bool,
    ) -> NativeDocumentResult<()> {
        self.check_metadata_cursor(pin, baseline, cursor)?;
        if !check() {
            return Err(NativeDocumentError::QueryCancelled);
        }
        cursor.scan.commit_page(page).map_err(metadata_error)?;
        cursor.checkpoint = cursor.next_checkpoint.clone();
        cursor.next_checkpoint = std::sync::Arc::new(());
        Ok(())
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
    /// `options.current_entry_id` selects only a canonical row in this pin;
    /// its current revision on disk or caller-supplied fields are never read.
    pub fn query_base_document(
        &self,
        pin: &DocumentQueryPin,
        definition: &EntryId,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentBaseResult>> {
        self.query_base_document_inner(pin, definition, None, None, None, options)
    }
    /// Resolve a named view through the compiled shared Base program.
    pub fn query_base_document_view(
        &self,
        pin: &DocumentQueryPin,
        definition: &EntryId,
        view_name: &str,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentBaseResult>> {
        self.query_base_document_inner(pin, definition, Some(view_name), None, None, options)
    }
    /// Query a real fenced Base in the exact retained containing Markdown file.
    /// The selector cannot replace saved source or choose another `this` note.
    pub fn query_inline_base_document(
        &self,
        pin: &DocumentQueryPin,
        containing: &EntryId,
        inline: &zorid_document::InlineBaseSource,
        view_name: Option<&str>,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentBaseResult>> {
        self.query_base_document_inner(pin, containing, view_name, Some(inline), None, options)
    }
    /// Cross-host wire seam. Attachments are source selectors, not definitions;
    /// the native host always reads and checks its own retained root settings.
    pub fn query_base_document_sources(
        &self,
        pin: &DocumentQueryPin,
        definition: &EntryId,
        inline: Option<&zorid_document::InlineBaseSource>,
        properties: Option<&DocumentPropertyDefinitionsSource>,
        view_name: Option<&str>,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentBaseResult>> {
        self.query_base_document_inner(pin, definition, view_name, inline, properties, options)
    }
    /// Candidate choices for ordinary note property editors use the same sealed
    /// definitions/resolver/target filters as Bases, without opening a Base file.
    pub fn query_property_targets_document(
        &self,
        pin: &DocumentQueryPin,
        properties: Option<&DocumentPropertyDefinitionsSource>,
        options: &QueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentPropertyTargetsResult>> {
        let manifest = self.document_manifest(pin)?;
        let (definition, definitions) = self.read_base_property_definitions(pin, properties)?;
        let definitions = match definitions {
            Some(definitions) => definitions,
            None => zorid_bases::properties::PropertyDefinitions::absent(pin.generation())?,
        };
        let facts = manifest.entries().iter().zip(manifest.presentations())
            .filter(|(entry, _)| entry.state.kind == EntryKind::File)
            .map(|(entry, presentation)| zorid_bases::FilePresentationFacts {
                witness: zorid_bases::RecordWitness { entry_id: entry.state.id.clone(), revision: entry.state.revision.clone() },
                size: Some(presentation.size_bytes), ctime_ms: i64::try_from(presentation.ctime_ms).ok(), mtime_ms: i64::try_from(presentation.mtime_ms).ok(),
            }).collect::<Vec<_>>();
        let result = zorid_bases::query_generation_property_targets(pin.generation(), &facts, &definitions, options)?;
        self.document_result(pin, DocumentPropertyTargetsResult {
            definition, relation_targets: result.relation_targets.unwrap_or_default(),
            property_definition_diagnostics: result.property_definition_diagnostics,
            refresh_hint: result.refresh_hint,
        })
    }
    fn read_base_property_definitions(
        &self,
        pin: &DocumentQueryPin,
        properties: Option<&DocumentPropertyDefinitionsSource>,
    ) -> NativeDocumentResult<(Option<zorid_core::EntryState>, Option<zorid_bases::properties::PropertyDefinitions>)> {
        let manifest = self.document_manifest(pin)?;
        let property_entry = manifest.entries().iter().find(|entry|
            entry.state.kind == EntryKind::File && entry.state.path.as_str() == "Properties.yaml"
        );
        if let Some(property_entry) = property_entry {
            let id = &property_entry.state.id;
            let projected = self.store.read_document_projection(pin, id)?;
            let bytes = projected.content.ok_or_else(|| NativeDocumentError::SourceUnavailable(id.clone()))?;
            let text = std::str::from_utf8(&bytes).map_err(|_| NativeDocumentError::SourceUnavailable(id.clone()))?;
            if properties.is_some_and(|supplied| &supplied.id != id || supplied.source != text) {
                return Err(zorid_bases::ExpressionDiagnostic::new("property_source_mismatch", "Property settings do not match the saved root file").into());
            }
            Ok((Some(projected.witness.entry().clone()), Some(zorid_bases::properties::PropertyDefinitions::from_generation_source(pin.generation(), id, text)?)))
        } else {
            if properties.is_some() {
                return Err(zorid_bases::ExpressionDiagnostic::new("property_source_mismatch", "No saved root property settings exist").into());
            }
            Ok((None, None))
        }
    }
    /// Selectors locate actual source bytes in this pin; no caller AST is trusted.
    /// Invalid YAML is diagnostic data, while missing/non-text sources fail closed.
    pub fn query_task_documents(
        &self,
        pin: &DocumentQueryPin,
        type_ids: &[EntryId],
        options: &TaskQueryOptions,
    ) -> NativeDocumentResult<DocumentQueryResult<DocumentTasksResult>> {
        use zorid_bases::types::{
            compile_type_yaml, task_type_summaries, TypeYamlSource, MAX_TYPE_BYTES,
            MAX_TYPE_SOURCES, MAX_TYPE_SOURCE_BYTES,
        };
        use zorid_bases::{ExpressionDiagnostic, RecordWitness};
        self.document_manifest(pin)?;
        if type_ids.len() > MAX_TYPE_SOURCES {
            return Err(ExpressionDiagnostic::new("budget", "Too many type selectors").into());
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut sources = Vec::with_capacity(type_ids.len());
        let mut definitions = Vec::with_capacity(type_ids.len());
        let mut total = 0usize;
        for id in type_ids {
            if !seen.insert(id) {
                return Err(
                    ExpressionDiagnostic::new("type-source", "Duplicate type selector").into(),
                );
            }
            let projected = self.store.read_document_projection(pin, id)?;
            let entry = projected.witness.entry().clone();
            let bytes = projected
                .content
                .ok_or_else(|| NativeDocumentError::SourceUnavailable(id.clone()))?;
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| ExpressionDiagnostic::new("budget", "Type byte budget exceeded"))?;
            if bytes.len() > MAX_TYPE_SOURCE_BYTES || total > MAX_TYPE_BYTES {
                return Err(
                    ExpressionDiagnostic::new("budget", "Type byte budget exceeded").into(),
                );
            }
            let source = String::from_utf8(bytes)
                .map_err(|_| NativeDocumentError::SourceUnavailable(id.clone()))?;
            sources.push(TypeYamlSource {
                witness: RecordWitness {
                    entry_id: entry.id.clone(),
                    revision: entry.revision.clone(),
                },
                path: entry.path.to_string(),
                source,
            });
            definitions.push(entry);
        }
        let registry = compile_type_yaml(sources)?;
        let result = zorid_bases::tasks::query_tasks(pin.generation(), &registry, options)?;
        let types = task_type_summaries(&registry)?;
        // Recheck path safety and exact pin retention after all reads/evaluation.
        self.document_result(
            pin,
            DocumentTasksResult {
                definitions,
                types,
                result,
            },
        )
    }
    fn query_base_document_inner(
        &self,
        pin: &DocumentQueryPin,
        definition: &EntryId,
        view_name: Option<&str>,
        inline: Option<&zorid_document::InlineBaseSource>,
        properties: Option<&DocumentPropertyDefinitionsSource>,
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
        let mut selected = options.clone();
        let source = if let Some(inline) = inline {
            if !entry.path.as_str().to_ascii_lowercase().ends_with(".md")
                || !zorid_document::verify_inline_base_source(source, inline)
                || selected.current_entry_id.as_ref().is_some_and(|id| id != definition)
            {
                return Err(zorid_bases::ExpressionDiagnostic::new(
                    "inline_source_mismatch", "Inline Base does not match its saved containing note",
                ).into());
            }
            selected.current_entry_id = Some(definition.clone());
            inline.source.as_str()
        } else { source };
        // Store verified this retained projection against the pin's exact
        // record commitment above. Program/data reuse cannot authorize a pin.
        // Expiry uses process-monotonic elapsed time, never the evaluation clock.
        let monotonic_ms =
            u64::try_from(self.base_preparation_clock.elapsed().as_millis()).unwrap_or(u64::MAX);
        let program = self
            .base_preparation_cache
            .borrow_mut()
            .compile_source(source, monotonic_ms)?;
        if let Some(name) = view_name {
            selected.view_index = program.value().view_index_by_name(name).ok_or_else(|| {
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
        let (_, definitions) = self.read_base_property_definitions(pin, properties)?;
        let result = if let Some(definitions) = definitions {
            // Config-derived relation maps are generation-local. Do not reuse
            // an answer/preparation whose sealed key lacks this source identity.
            zorid_bases::query_generation_with_properties(program.value(), pin.generation(), &facts, &definitions, &selected)?
        } else {
            let mut cache = self.base_preparation_cache.borrow_mut();
            let prepared =
                cache.prepare_generation(pin.generation(), &facts, &selected, monotonic_ms)?;
            // Both sealed lookups retain their checked dependency/work identity.
            // Answer reuse still validates this invocation's context and limits.
            let answer = cache.query_prepared_cached(&program, &prepared, &selected, monotonic_ms)?;
            drop(cache);
            #[cfg(test)]
            if answer.outcome() == zorid_bases::PreparationCacheOutcome::Hit {
                self.point("base_query_answer_hit");
            }
            answer.into_value()
        };
        // Release the cache borrow before hooks or the final retained-pin fence.
        // No storage transaction or pin capability is held by the pure cache.
        #[cfg(test)]
        self.point("base_query_evaluated");
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

fn metadata_error(error: zorid_index::MetadataRowsError) -> NativeDocumentError {
    use zorid_index::MetadataRowsError as M;
    match error {
        M::Cancelled => NativeDocumentError::QueryCancelled,
        M::InvalidLimit => IndexError::InvalidBudget.into(),
        M::ForeignScope | M::CheckpointMismatch => IndexError::QueryMismatch.into(),
        M::InvalidRecord => IndexError::InvalidRecord.into(),
        M::ResourceLimit => IndexError::GenerationLimit.into(),
    }
}
