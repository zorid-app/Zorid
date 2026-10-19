//! Execute one selected committed-maintenance effect, outside the pure owner.
//! This module has no loop, timer, callbacks, worker, feature listeners or pins.
//! Host-owned wakes and event-loop turns provide liveness/fair admission.
use super::NativeVault;
use crate::document_api::*;
use zorid_core::OperationId;
use zorid_index::document_runtime::{
    DocumentRuntime, Effect, EffectResult, Failure, Input, IssuedEffect, Observation,
    RuntimeIdentity, StageObservation, StageProgress,
};
use zorid_index::{
    document_extraction_version, SemanticVersions, INDEX_SCHEMA_VERSION, LITERAL_QUERY_VERSION,
    RESOLVER_VERSION,
};

pub(super) struct NativeDocumentRuntime {
    core: DocumentRuntime,
    stage: Option<DocumentIndexStage>,
    // One bounded acknowledgment report, never a body, pin or authority proof.
    last_step: Option<StepReplay>,
}
struct StepReplay {
    lifetime: OperationId,
    effect_id: u64,
    reduction: DocumentRuntimeReduction,
}
impl NativeDocumentRuntime {
    fn reduce(&mut self, input: Input) -> NativeDocumentRuntimeResult<DocumentRuntimeReduction> {
        let result = self.core.reduce(input)?;
        if self.core.stage().is_none() {
            self.stage = None;
        }
        Ok(result)
    }
}

impl NativeVault {
    /// Start lazily after local-cache selection. Controls cannot manufacture an
    /// observation or complete an effect. No IO effect runs inside this call.
    pub fn document_runtime_command(
        &mut self,
        command: DocumentRuntimeCommand,
    ) -> NativeDocumentRuntimeResult<DocumentRuntimeReduction> {
        if self.document_runtime.is_none() {
            let identity = self.identity().map_err(NativeDocumentError::from)?;
            let versions = SemanticVersions::new(
                INDEX_SCHEMA_VERSION,
                document_extraction_version(),
                RESOLVER_VERSION,
                LITERAL_QUERY_VERSION,
            )
            .expect("fixed document semantic versions");
            self.document_runtime = Some(NativeDocumentRuntime {
                core: DocumentRuntime::new(RuntimeIdentity {
                    lifetime: super::new_op(),
                    local_store: identity.local_store_id,
                    versions,
                }),
                stage: None,
                last_step: None,
            });
        }
        let retiring = matches!(&command, DocumentRuntimeCommand::Retire);
        let input = match command {
            DocumentRuntimeCommand::Wake { monotonic_ms } => Input::Wake { monotonic_ms },
            DocumentRuntimeCommand::Continue => Input::Continue,
            DocumentRuntimeCommand::SourceHint => Input::SourceHint,
            DocumentRuntimeCommand::Request(request) => Input::Request(request),
            DocumentRuntimeCommand::CancelRequest { id } => Input::CancelRequest { id },
            DocumentRuntimeCommand::Retire => Input::Retire,
        };
        let owner = self.document_runtime.as_mut().expect("created owner");
        let reduction = owner.reduce(input)?;
        if retiring {
            owner.last_step = None;
        }
        Ok(reduction)
    }
    /// Pure copied observation; callers register against this lifetime/revision.
    /// This neither reads authority nor starts/drives an index cycle.
    pub fn document_runtime_update(&self) -> Option<DocumentRuntimeUpdate> {
        self.document_runtime
            .as_ref()
            .map(|owner| owner.core.update())
    }
    /// Execute exactly one issued effect. A next Dispatch is returned to the
    /// host queue; a Yield schedules Continue on a later admitted host turn.
    pub fn document_runtime_step(
        &mut self,
        lifetime: &OperationId,
        effect_id: u64,
    ) -> NativeDocumentRuntimeResult<DocumentRuntimeReduction> {
        let owner = self
            .document_runtime
            .as_ref()
            .ok_or(NativeDocumentRuntimeError::NotStarted)?;
        if let Some(replay) = &owner.last_step {
            if &replay.lifetime == lifetime && replay.effect_id == effect_id {
                return Ok(replay.reduction.clone());
            }
        }
        let issued = owner
            .core
            .in_flight()
            .cloned()
            .ok_or(NativeDocumentRuntimeError::NoEffect)?;
        if &issued.lifetime != lifetime || issued.id != effect_id {
            return Err(DocumentRuntimeContractError::UnexpectedCompletion.into());
        }
        // No runtime borrow survives IO. Existing NativeVault methods retain
        // root verification and Store source/head/epoch/publication fencing.
        let result = self
            .execute_document_runtime_effect(&issued)
            .unwrap_or_else(|error| EffectResult::Failed(effect_failure(&error)));
        let owner = self
            .document_runtime
            .as_mut()
            .expect("effect cannot remove owner");
        let reduction = owner.reduce(Input::Complete {
            lifetime: issued.lifetime.clone(),
            effect_id: issued.id,
            result,
        })?;
        // Retirement expires earlier ACK ownership. The one already-issued
        // effect may drain, but a retired lifetime does not retain new reports.
        if reduction.execution != DocumentRuntimeExecution::Quiesced {
            owner.last_step = Some(StepReplay {
                lifetime: issued.lifetime,
                effect_id: issued.id,
                reduction: reduction.clone(),
            });
        }
        Ok(reduction)
    }
    fn execute_document_runtime_effect(
        &mut self,
        issued: &IssuedEffect,
    ) -> NativeDocumentResult<EffectResult> {
        match &issued.kind {
            Effect::Observe => {
                let (source, status) = self.document_index_status_with_source()?;
                let (published, current, rebuild_required, coverage_complete) = match status {
                    DocumentIndexStatus::Uninitialized | DocumentIndexStatus::Building => {
                        (None, false, false, None)
                    }
                    DocumentIndexStatus::RebuildRequired => (None, false, true, None),
                    DocumentIndexStatus::Ready {
                        snapshot,
                        covered_watermark,
                        observed_source_head,
                        coverage_complete,
                    } => {
                        if observed_source_head != source.watermark().as_str()
                            || snapshot.local_store_id() != source.local_store_id()
                        {
                            return Ok(EffectResult::Failed(Failure::InvalidData));
                        }
                        let current = covered_watermark == source.watermark().as_str();
                        (Some(snapshot), current, false, Some(coverage_complete))
                    }
                };
                Ok(EffectResult::Observed(Observation {
                    source,
                    published,
                    current,
                    rebuild_required,
                    coverage_complete,
                }))
            }
            Effect::RecoverStage => match self.recover_document_index_stage()? {
                Some((stage, progress)) => {
                    let progress = match progress_projection(
                        progress.prepared_documents,
                        progress.total_documents,
                        progress.ready,
                    ) {
                        Ok(progress) => progress,
                        Err(error) => return Ok(EffectResult::Failed(error)),
                    };
                    let observed = stage_observation(&stage, Some(progress));
                    self.document_runtime.as_mut().expect("owner").stage = Some(stage);
                    Ok(EffectResult::Recovered(Some(observed)))
                }
                None => {
                    self.document_runtime.as_mut().expect("owner").stage = None;
                    Ok(EffectResult::Recovered(None))
                }
            },
            Effect::Initialize => {
                self.initialize_document_index()?;
                Ok(EffectResult::Done)
            }
            Effect::Begin => {
                let stage = self.begin_document_index()?;
                let observed = stage_observation(&stage, None);
                self.document_runtime.as_mut().expect("owner").stage = Some(stage);
                Ok(EffectResult::Stage(observed))
            }
            Effect::Pump { snapshot } => {
                let stage = self.runtime_stage(issued, snapshot)?;
                let progress = self.pump_document_index(&stage)?;
                if progress.snapshot != *snapshot {
                    return Ok(EffectResult::Failed(Failure::InvalidData));
                }
                let projected = match progress_projection(
                    progress.prepared_documents,
                    progress.total_documents,
                    progress.ready,
                ) {
                    Ok(progress) => progress,
                    Err(error) => return Ok(EffectResult::Failed(error)),
                };
                Ok(EffectResult::Stage(stage_observation(
                    &stage,
                    Some(projected),
                )))
            }
            Effect::Publish { snapshot } => {
                let stage = self.runtime_stage(issued, snapshot)?;
                let published = self.publish_document_index(&stage)?;
                if published != *snapshot {
                    return Ok(EffectResult::Failed(Failure::InvalidData));
                }
                self.document_runtime.as_mut().expect("owner").stage = None;
                Ok(EffectResult::Published(published))
            }
            Effect::Discard { snapshot } => {
                self.discard_document_index_stage(snapshot)?;
                self.document_runtime.as_mut().expect("owner").stage = None;
                Ok(EffectResult::Done)
            }
            Effect::Rebuild => {
                self.rebuild_document_index()?;
                self.document_runtime.as_mut().expect("owner").stage = None;
                Ok(EffectResult::Done)
            }
        }
    }
    fn runtime_stage(
        &self,
        issued: &IssuedEffect,
        snapshot: &IndexSnapshotId,
    ) -> NativeDocumentResult<DocumentIndexStage> {
        let stage = self
            .document_runtime
            .as_ref()
            .and_then(|owner| owner.stage.as_ref())
            .ok_or(zorid_index::IndexError::SnapshotExpired)?;
        if stage.snapshot() != snapshot || issued.target_source.as_ref() != Some(stage.source()) {
            return Err(zorid_index::IndexError::StaleIndex.into());
        }
        Ok(stage.clone())
    }
    /// Cache replacement takes &mut NativeVault, so no actual IO can be running.
    /// Retire the old pure token (not yet executed) without touching its durable
    /// stage/source. A later owner gets a fresh lifetime and cannot complete it.
    pub(super) fn retire_document_runtime_for_cache_change(&mut self) {
        if let Some(mut owner) = self.document_runtime.take() {
            let _ = owner.reduce(Input::Retire);
            if let Some(issued) = owner.core.in_flight().cloned() {
                let _ = owner.reduce(Input::Complete {
                    lifetime: issued.lifetime,
                    effect_id: issued.id,
                    result: EffectResult::Failed(Failure::SnapshotExpired),
                });
            }
        }
    }
}
fn stage_observation(
    stage: &DocumentIndexStage,
    progress: Option<StageProgress>,
) -> StageObservation {
    StageObservation {
        source: stage.source().clone(),
        snapshot: stage.snapshot().clone(),
        progress,
    }
}
fn progress_projection(
    prepared: usize,
    total: usize,
    ready: bool,
) -> Result<StageProgress, Failure> {
    if prepared > total || ready && prepared != total {
        return Err(Failure::InvalidData);
    }
    Ok(StageProgress {
        prepared: u32::try_from(prepared).map_err(|_| Failure::InvalidData)?,
        total: u32::try_from(total).map_err(|_| Failure::InvalidData)?,
        ready,
    })
}
/// Only explicit disposable-cache corruption requests rebuild. Authoritative
/// corruption, schema/JSON failures and unsafe paths never become a cache miss.
fn effect_failure(error: &NativeDocumentError) -> Failure {
    use zorid_index::IndexError as I;
    use zorid_store::{DocumentIndexError as D, StoreError as S};
    match error {
        NativeDocumentError::Index(D::RebuildRequired) => Failure::RebuildRequired,
        NativeDocumentError::Index(D::Contract(I::StaleSource)) => Failure::StaleSource,
        NativeDocumentError::Index(D::Contract(I::StaleIndex)) => Failure::StaleIndex,
        NativeDocumentError::Index(D::Contract(I::SnapshotExpired)) => Failure::SnapshotExpired,
        NativeDocumentError::Index(D::Contract(I::GenerationLimit | I::PumpLimit)) => {
            Failure::Unavailable
        }
        NativeDocumentError::Index(D::Authority(
            S::Corrupt(_) | S::Json(_) | S::UnsupportedSchema(_),
        ))
        | NativeDocumentError::Native(crate::Error::Store(
            S::Corrupt(_) | S::Json(_) | S::UnsupportedSchema(_),
        )) => Failure::InvalidData,
        NativeDocumentError::Native(crate::Error::UnsafePath(_)) => Failure::Fatal,
        NativeDocumentError::Native(
            crate::Error::Io(_) | crate::Error::LockTimeout | crate::Error::Busy(_),
        )
        | NativeDocumentError::Index(D::NotReady) => Failure::Unavailable,
        NativeDocumentError::Index(D::Authority(S::Sql(error)))
        | NativeDocumentError::Native(crate::Error::Store(S::Sql(error))) => {
            // SQLite primary codes CORRUPT(11)/NOTADB(26), from the typed
            // error's numeric extended code; never parse diagnostic strings.
            match error.sqlite_error().map(|error| error.extended_code & 0xff) {
                Some(11 | 26) => Failure::InvalidData,
                _ => Failure::Unavailable,
            }
        }
        _ => Failure::Fatal,
    }
}
#[cfg(test)]
#[path = "document_runtime_tests.rs"]
mod tests;
