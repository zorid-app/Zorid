//! CLI execution of the shared native lifecycle. Only adapter-wide successful
//! pump/attempt budgets live here; stage/retry/rebuild policy stays in the core.
use crate::{Failure, Result};
use zorid_native::{
    DocumentFreshnessRequest, DocumentIndexProgress, DocumentRuntimeCommand as Command,
    DocumentRuntimeEffect as Effect, DocumentRuntimeEffectResult as EffectResult,
    DocumentRuntimeExecution as Execution, DocumentRuntimeFailure as RuntimeFailure,
    DocumentRuntimeIssuedEffect as IssuedEffect, DocumentRuntimeObservation as Observation,
    DocumentRuntimeReduction as Reduction, DocumentRuntimeRequestOutcome as Outcome,
    IndexSnapshotId, NativeDocumentRuntimeError, NativeDocumentRuntimeReceipt, NativeVault,
};

pub(super) struct BuildRun {
    pub snapshot: Option<IndexSnapshotId>,
    pub progress: Option<DocumentIndexProgress>,
    pub pumps: u32,
    pub resumed: bool,
    pub publication: Option<IndexSnapshotId>,
    pub observation: Observation,
}
// A private two-call test seam, not a public runtime or policy extension point.
trait Backend {
    fn command(&mut self, command: Command) -> Result<Reduction>;
    fn step(&mut self, issued: &IssuedEffect) -> Result<(Reduction, NativeDocumentRuntimeReceipt)>;
}
struct NativeBackend<'a>(&'a mut NativeVault);
impl Backend for NativeBackend<'_> {
    fn command(&mut self, command: Command) -> Result<Reduction> {
        self.0
            .document_runtime_command(command)
            .map_err(native_failure)
    }
    fn step(&mut self, issued: &IssuedEffect) -> Result<(Reduction, NativeDocumentRuntimeReceipt)> {
        let reduction = self
            .0
            .document_runtime_step(&issued.lifetime, issued.id)
            .map_err(native_failure)?;
        let record = self
            .0
            .document_runtime_snapshot()
            .and_then(|snapshot| snapshot.last_step)
            .ok_or_else(protocol_failure)?;
        if record.lifetime != issued.lifetime
            || record.effect_id != issued.id
            || record.receipt.issued != *issued
            || record.reduction != reduction
        {
            return Err(protocol_failure());
        }
        Ok((reduction, record.receipt))
    }
}
#[derive(Default)]
struct Work {
    snapshot: Option<IndexSnapshotId>,
    progress: Option<DocumentIndexProgress>,
    pumps: u32,
    resumed: bool,
    publication: Option<IndexSnapshotId>,
}
impl Work {
    fn accept(
        &mut self,
        issued: &IssuedEffect,
        receipt: &NativeDocumentRuntimeReceipt,
    ) -> Result<()> {
        if receipt.issued != *issued {
            return Err(protocol_failure());
        }
        match (&issued.kind, &receipt.completion) {
            (Effect::Pump { snapshot }, EffectResult::Stage(stage)) => {
                let actual = receipt.pump.as_ref().ok_or_else(protocol_failure)?;
                if &actual.snapshot != snapshot || stage.snapshot != *snapshot {
                    return Err(protocol_failure());
                }
                self.pumps = self.pumps.checked_add(1).ok_or_else(protocol_failure)?;
                self.snapshot = Some(snapshot.clone());
                self.progress = Some(copy_progress(actual));
            }
            (_, _) if receipt.pump.is_some() => return Err(protocol_failure()),
            (Effect::RecoverStage, EffectResult::Recovered(Some(stage))) => {
                let progress = stage.progress.as_ref().ok_or_else(protocol_failure)?;
                self.resumed = true;
                self.snapshot = Some(stage.snapshot.clone());
                self.progress = Some(zero_progress(
                    stage.snapshot.clone(),
                    progress.prepared as usize,
                    progress.total as usize,
                    progress.ready,
                ));
            }
            (Effect::Begin, EffectResult::Stage(stage)) => {
                self.snapshot = Some(stage.snapshot.clone());
                self.progress = None;
            }
            (Effect::Publish { snapshot }, EffectResult::Published(actual)) => {
                if snapshot != actual {
                    return Err(protocol_failure());
                }
                self.publication = Some(actual.clone());
            }
            (Effect::Discard { .. } | Effect::Rebuild, EffectResult::Done) => {
                self.snapshot = None;
                self.progress = None;
            }
            _ => {}
        }
        Ok(())
    }
}
fn copy_progress(value: &DocumentIndexProgress) -> DocumentIndexProgress {
    DocumentIndexProgress {
        snapshot: value.snapshot.clone(),
        prepared_documents: value.prepared_documents,
        total_documents: value.total_documents,
        ready: value.ready,
        reused_documents: value.reused_documents,
        parse_cache: zorid_store::document_index::DocumentParseCacheProgress {
            hits: value.parse_cache.hits,
            misses: value.parse_cache.misses,
            unavailable: value.parse_cache.unavailable,
            corrupt: value.parse_cache.corrupt,
            unsupported: value.parse_cache.unsupported,
        },
    }
}
pub(super) fn zero_progress(
    snapshot: IndexSnapshotId,
    prepared_documents: usize,
    total_documents: usize,
    ready: bool,
) -> DocumentIndexProgress {
    DocumentIndexProgress {
        snapshot,
        prepared_documents,
        total_documents,
        ready,
        reused_documents: 0,
        parse_cache: Default::default(),
    }
}
pub(super) fn build(
    vault: &mut NativeVault,
    rebuild: bool,
    max_pumps: u32,
    cancelled: impl FnMut() -> bool,
) -> Result<BuildRun> {
    drive_build(&mut NativeBackend(vault), rebuild, max_pumps, cancelled)
}
fn drive_build(
    backend: &mut impl Backend,
    rebuild: bool,
    max_pumps: u32,
    mut cancelled: impl FnMut() -> bool,
) -> Result<BuildRun> {
    if !(1..=100_000).contains(&max_pumps) {
        return Err(Failure::new(
            "usage",
            "Index pump budget must be 1..=100000",
            2,
        ));
    }
    // Counts ALL attempted effects separately from actual successful pumps.
    // This bounds a faulty/unavailable backend without widening a core cycle.
    let attempt_limit = max_pumps
        .checked_mul(4)
        .and_then(|n| n.checked_add(64))
        .ok_or_else(protocol_failure)?;
    let mut attempted = 0;
    let mut work = Work::default();
    let mut request_id = 0_u64;
    loop {
        request_id = request_id.checked_add(1).ok_or_else(protocol_failure)?;
        let remaining = max_pumps
            .checked_sub(work.pumps)
            .ok_or_else(protocol_failure)?;
        if remaining == 0 {
            return Err(protocol_failure());
        }
        let request = DocumentFreshnessRequest {
            id: request_id,
            max_pumps: remaining.min(128) as u8,
            max_restarts: 1,
            force_rebuild: rebuild && request_id == 1,
        };
        let cycle_start_pumps = work.pumps;
        let mut reduction = backend.command(Command::Request(request))?;
        loop {
            for outcome in &reduction.request_outcomes {
                match outcome {
                    Outcome::Finished { id, observation } if *id == request_id => {
                        if observation.current
                            || work.publication.is_some()
                            || work.pumps >= max_pumps
                        {
                            return Ok(BuildRun {
                                snapshot: work.snapshot,
                                progress: work.progress,
                                pumps: work.pumps,
                                resumed: work.resumed,
                                publication: work.publication,
                                observation: observation.clone(),
                            });
                        }
                        break;
                    }
                    Outcome::Failed { id, failure } if *id == request_id => {
                        return Err(runtime_failure(*failure))
                    }
                    Outcome::Cancelled { id } if *id == request_id => {
                        return Err(cancelled_failure())
                    }
                    Outcome::Retired { id } if *id == request_id => {
                        return Err(Failure::new(
                            "document_runtime_retired",
                            "Document maintenance owner was retired",
                            3,
                        ))
                    }
                    _ => {}
                }
            }
            if reduction.request_outcomes.iter().any(|outcome| {
                matches!(outcome,
                Outcome::Finished { id, .. } if *id == request_id)
            }) {
                if work.pumps == cycle_start_pumps {
                    return Err(Failure::new(
                        "no_progress",
                        "Document cycle finished without current data or acknowledged work",
                        3,
                    ));
                }
                break;
            }
            if cancelled() {
                backend.command(Command::CancelRequest { id: request_id })?;
                return Err(cancelled_failure());
            }
            reduction = match reduction.execution {
                Execution::Dispatch => {
                    if attempted >= attempt_limit {
                        backend.command(Command::CancelRequest { id: request_id })?;
                        return Err(Failure::new("index_execution_budget",
                            "Document maintenance reached its attempted-effect budget; staging remains durable", 3));
                    }
                    let issued = reduction.effect.as_ref().ok_or_else(protocol_failure)?;
                    attempted += 1;
                    let (next, receipt) = backend.step(issued)?;
                    work.accept(issued, &receipt)?;
                    if work.pumps > max_pumps {
                        return Err(protocol_failure());
                    }
                    next
                }
                Execution::Yield => backend.command(Command::Continue)?,
                Execution::WaitForWake => {
                    return Err(Failure::new(
                        "no_progress",
                        "Document demand stopped before a final outcome; staging remains durable",
                        3,
                    ))
                }
                Execution::Quiesced => {
                    return Err(Failure::new(
                        "document_runtime_retired",
                        "Document maintenance owner was retired",
                        3,
                    ))
                }
            };
        }
    }
}
/// One background core cycle after the already-admitted scan/sync. Yield ends
/// this quantum; a later watch cycle repairs durable work in a fresh owner.
pub(crate) fn maintain(vault: &mut NativeVault, mut cancelled: impl FnMut() -> bool) -> Result<()> {
    let mut backend = NativeBackend(vault);
    let mut reduction = backend.command(Command::Wake { monotonic_ms: 0 })?;
    for _ in 0..32 {
        if cancelled() {
            backend.command(Command::Retire)?;
            return Ok(());
        }
        match reduction.execution {
            Execution::Dispatch => {
                let issued = reduction.effect.as_ref().ok_or_else(protocol_failure)?;
                reduction = backend.step(issued)?.0;
            }
            Execution::Yield | Execution::WaitForWake | Execution::Quiesced => {
                if let Some(error) = reduction.update.error {
                    return Err(runtime_failure(error));
                }
                return Ok(());
            }
        }
    }
    // No next effect is executed. Committed partial stages survive owner drop.
    if let Some(error) = reduction.update.error {
        return Err(runtime_failure(error));
    }
    Ok(())
}
fn protocol_failure() -> Failure {
    Failure::new(
        "document_runtime_contract",
        "Document runtime acknowledgment did not match issued work",
        2,
    )
}
fn cancelled_failure() -> Failure {
    Failure::new(
        "index_cancelled",
        "Document demand was cancelled; committed source and staging are preserved",
        3,
    )
}
fn native_failure(error: NativeDocumentRuntimeError) -> Failure {
    match error {
        NativeDocumentRuntimeError::Document(error) => super::failure(error),
        NativeDocumentRuntimeError::Contract(_) => Failure::new(
            "document_runtime_contract",
            "Document runtime rejected the control",
            2,
        ),
        NativeDocumentRuntimeError::NotStarted | NativeDocumentRuntimeError::NoEffect => {
            Failure::new("no_progress", "Document runtime has no admitted work", 3)
        }
    }
}
fn runtime_failure(error: RuntimeFailure) -> Failure {
    let (code, message, exit) = match error {
        RuntimeFailure::StaleSource => (
            "stale_source",
            "Committed source advanced during the bounded build",
            3,
        ),
        RuntimeFailure::StaleIndex => (
            "stale_index",
            "Another indexer advanced the derived head",
            3,
        ),
        RuntimeFailure::SnapshotExpired => (
            "snapshot_expired",
            "Document staging is no longer retained",
            3,
        ),
        RuntimeFailure::RebuildRequired => (
            "index_rebuild_required",
            "Derived index still requires explicit rebuild",
            5,
        ),
        RuntimeFailure::Uncertain | RuntimeFailure::Unavailable => (
            "index_unavailable",
            "Document maintenance is temporarily unavailable; durable work is preserved",
            3,
        ),
        RuntimeFailure::InvalidData => (
            "index_contract_error",
            "Document maintenance rejected invalid data",
            2,
        ),
        RuntimeFailure::Fatal => (
            "index_fatal",
            "Document maintenance encountered a fatal authority error",
            1,
        ),
    };
    Failure::new(code, message, exit)
}

#[cfg(test)]
#[path = "document_runtime_tests.rs"]
mod tests;
