use super::*;
use std::path::Path;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};

fn create(vault: &mut NativeVault, n: usize) {
    vault
        .apply(&MutationRequest {
            operation_id: OperationId::new(format!("create-{n}")).unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new(format!("note-{n}")).unwrap(),
                path: VaultPath::new(format!("Note{n}.md")).unwrap(),
                kind: EntryKind::File,
                content: Some(format!("# Heading{n}\nold needle\n").into_bytes()),
            },
        })
        .unwrap();
}
fn write(vault: &mut NativeVault, n: usize, operation: &str, text: &str) {
    let id = EntryId::new(format!("note-{n}")).unwrap();
    let expected = vault.read(&id).unwrap().unwrap().state.revision;
    vault
        .apply(&MutationRequest {
            operation_id: OperationId::new(operation).unwrap(),
            mutation: Mutation::Write {
                id,
                expected,
                content: text.as_bytes().to_vec(),
            },
        })
        .unwrap();
}
fn open(root: &Path, cache: &Path) -> NativeVault {
    let mut vault = NativeVault::open(root).unwrap();
    vault.enable_local_document_cache(cache).unwrap();
    vault
}
fn request(vault: &mut NativeVault, id: u64, pumps: u8) -> DocumentRuntimeReduction {
    vault
        .document_runtime_command(DocumentRuntimeCommand::Request(DocumentFreshnessRequest {
            id,
            max_pumps: pumps,
            max_restarts: 1,
            force_rebuild: false,
        }))
        .unwrap()
}
fn effect(vault: &NativeVault) -> Option<Effect> {
    vault
        .document_runtime
        .as_ref()
        .and_then(|owner| owner.core.in_flight())
        .map(|effect| effect.kind.clone())
}
fn step(vault: &mut NativeVault) -> NativeDocumentRuntimeResult<DocumentRuntimeReduction> {
    let token = vault
        .document_runtime
        .as_ref()
        .and_then(|owner| owner.core.in_flight())
        .map(|effect| (effect.lifetime.clone(), effect.id))
        .unwrap_or((OperationId::new("unknown").unwrap(), 0));
    vault.document_runtime_step(&token.0, token.1)
}
fn drive(
    vault: &mut NativeVault,
    mut reduction: DocumentRuntimeReduction,
) -> (DocumentRuntimeReduction, Vec<Effect>) {
    let mut effects = Vec::new();
    for _ in 0..100 {
        if !reduction.request_outcomes.is_empty()
            || reduction.execution == DocumentRuntimeExecution::Quiesced
        {
            return (reduction, effects);
        }
        reduction = match reduction.execution {
            DocumentRuntimeExecution::Dispatch => {
                effects.push(effect(vault).unwrap());
                step(vault).unwrap()
            }
            DocumentRuntimeExecution::Yield => vault
                .document_runtime_command(DocumentRuntimeCommand::Continue)
                .unwrap(),
            DocumentRuntimeExecution::WaitForWake => return (reduction, effects),
            DocumentRuntimeExecution::Quiesced => unreachable!(),
        };
    }
    panic!("bounded fixture did not terminate");
}
fn ready(vault: &mut NativeVault) {
    let start = request(vault, 1, 8);
    let (done, _) = drive(vault, start);
    assert!(matches!(
        done.request_outcomes.as_slice(),
        [DocumentRuntimeRequestOutcome::Finished {
            observation: Observation { current: true, .. },
            ..
        }]
    ));
}
fn until(vault: &mut NativeVault, kind: fn(&Effect) -> bool) {
    for _ in 0..100 {
        if effect(vault).as_ref().map_or(false, kind) {
            return;
        }
        if effect(vault).is_some() {
            step(vault).unwrap();
        } else {
            vault
                .document_runtime_command(DocumentRuntimeCommand::Continue)
                .unwrap();
        }
    }
    panic!("bounded fixture did not reach effect");
}

#[test]
fn real_native_driver_builds_and_clean_pumps_do_not_resume_or_observe_again() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut vault = open(root.path(), &cache.path().join("cache.sqlite"));
    for n in 0..35 {
        create(&mut vault, n);
    }
    let start = request(&mut vault, 1, 8);
    let (done, effects) = drive(&mut vault, start);
    assert_eq!(done.update.freshness, DocumentRuntimeFreshness::Current);
    assert_eq!(
        effects
            .iter()
            .filter(|e| matches!(e, Effect::Pump { .. }))
            .count(),
        2
    );
    assert_eq!(
        effects
            .iter()
            .filter(|e| matches!(e, Effect::Observe))
            .count(),
        2
    );
    assert_eq!(
        effects
            .iter()
            .filter(|e| matches!(e, Effect::RecoverStage))
            .count(),
        1
    );
    let first = effects
        .iter()
        .position(|e| matches!(e, Effect::Pump { .. }))
        .unwrap();
    assert!(matches!(effects[first + 1], Effect::Pump { .. }));
    let update = vault.document_runtime_update().unwrap();
    assert_eq!(update, vault.document_runtime_update().unwrap());
    assert_eq!(
        step(&mut vault).unwrap_err().code(),
        "document_runtime_idle"
    );
}

#[test]
fn each_step_stops_at_one_effect_and_never_pumps_inside_command() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    let start = request(&mut vault, 1, 8);
    assert_eq!(start.effect.unwrap().kind, Effect::Observe);
    assert!(vault.document_runtime.as_ref().unwrap().stage.is_none());
    let one = step(&mut vault).unwrap();
    assert!(matches!(
        one.effect.unwrap().kind,
        Effect::Initialize | Effect::RecoverStage
    ));
    assert!(vault.document_runtime.as_ref().unwrap().stage.is_none());
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    assert!(vault
        .document_runtime
        .as_ref()
        .unwrap()
        .core
        .stage()
        .unwrap()
        .progress
        .is_none());
    let pumped = step(&mut vault).unwrap();
    assert_eq!(pumped.execution, DocumentRuntimeExecution::Yield);
    assert!(effect(&vault).is_none());
}

#[test]
fn reopen_recovers_partial_durable_stage_and_preserves_its_captured_source() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let path = cache.path().join("cache.sqlite");
    let mut vault = open(root.path(), &path);
    for n in 0..35 {
        create(&mut vault, n);
    }
    let start = request(&mut vault, 1, 1);
    let (done, _) = drive(&mut vault, start);
    assert_eq!(done.update.freshness, DocumentRuntimeFreshness::Lagging);
    let partial = vault
        .document_runtime
        .as_ref()
        .unwrap()
        .core
        .stage()
        .unwrap()
        .clone();
    assert_eq!(partial.progress.as_ref().unwrap().prepared, 32);
    let old_lifetime = done.update.lifetime;
    drop(vault);
    let mut reopened = open(root.path(), &path);
    let start = request(&mut reopened, 2, 8);
    let (done, effects) = drive(&mut reopened, start);
    assert_eq!(done.update.freshness, DocumentRuntimeFreshness::Current);
    assert_ne!(done.update.lifetime, old_lifetime);
    assert!(!effects.iter().any(|e| matches!(e, Effect::Begin)));
    assert_eq!(
        effects
            .iter()
            .filter(|e| matches!(e, Effect::Pump { .. }))
            .count(),
        1
    );
    assert_eq!(done.update.published, Some(partial.snapshot));
}

#[test]
fn recovery_of_ready_stage_publishes_without_an_extra_pump() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let path = cache.path().join("cache.sqlite");
    let mut vault = open(root.path(), &path);
    create(&mut vault, 0);
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    assert!(vault.pump_document_index(&stage).unwrap().ready);
    let captured = stage.source().clone();
    drop(vault);
    let mut reopened = open(root.path(), &path);
    let start = request(&mut reopened, 1, 8);
    let (done, effects) = drive(&mut reopened, start);
    assert_eq!(done.update.source, Some(captured));
    assert_eq!(done.update.published, Some(stage.snapshot().clone()));
    assert!(!effects
        .iter()
        .any(|e| matches!(e, Effect::Pump { .. } | Effect::Begin)));
}

#[test]
fn another_native_writer_invalidates_old_stage_and_retry_never_publishes_stale_bytes() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let path = cache.path().join("cache.sqlite");
    let mut vault = open(root.path(), &path);
    create(&mut vault, 0);
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    let old = vault
        .document_runtime
        .as_ref()
        .unwrap()
        .core
        .stage()
        .unwrap()
        .clone();
    let mut writer = NativeVault::open_existing(root.path()).unwrap();
    write(&mut writer, 0, "external-write", "# New\nnew needle\n");
    let failed = step(&mut vault).unwrap();
    assert_eq!(failed.execution, DocumentRuntimeExecution::Yield);
    let (done, effects) = drive(&mut vault, failed);
    assert_eq!(done.update.freshness, DocumentRuntimeFreshness::Current);
    assert_ne!(done.update.published, Some(old.snapshot.clone()));
    assert!(effects
        .iter()
        .any(|e| matches!(e, Effect::Discard { snapshot } if snapshot == &old.snapshot)));
    let pin = vault.open_document_snapshot().unwrap();
    let metadata = vault
        .document_metadata(&pin, &EntryId::new("note-0").unwrap())
        .unwrap();
    assert_eq!(metadata.value.metadata.unwrap().headings[0].text, "New");
}

#[test]
fn independent_publication_is_observed_without_claiming_our_stage_was_published() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let path = cache.path().join("cache.sqlite");
    let mut vault = open(root.path(), &path);
    create(&mut vault, 0);
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    let ours = vault
        .document_runtime
        .as_ref()
        .unwrap()
        .core
        .stage()
        .unwrap()
        .snapshot
        .clone();
    let mut other = open(root.path(), &path);
    let stage = other.begin_document_index().unwrap();
    assert!(other.pump_document_index(&stage).unwrap().ready);
    let theirs = other.publish_document_index(&stage).unwrap();
    let first = step(&mut vault).unwrap();
    let (done, effects) = drive(&mut vault, first);
    assert_eq!(done.update.published, Some(theirs.clone()));
    assert_ne!(ours, theirs);
    assert!(!effects
        .iter()
        .any(|e| matches!(e, Effect::Publish { snapshot } if snapshot == &ours)));
}

#[test]
fn missed_source_hint_repairs_on_wake_without_feature_demands_or_another_commit() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    ready(&mut vault);
    let old = vault.document_runtime_update().unwrap();
    let mut writer = NativeVault::open_existing(root.path()).unwrap();
    write(&mut writer, 0, "missed-event", "new text\n");
    let start = vault
        .document_runtime_command(DocumentRuntimeCommand::Wake { monotonic_ms: 10 })
        .unwrap();
    let (done, _) = drive(&mut vault, start);
    assert_eq!(done.update.freshness, DocumentRuntimeFreshness::Current);
    assert_ne!(done.update.source, old.source);
    assert!(!done.update.has_foreground_demand);
}

#[test]
fn cancel_one_demand_preserves_the_other_and_retirement_settles_pump_progress() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    for n in 0..35 {
        create(&mut vault, n);
    }
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    request(&mut vault, 2, 1);
    let cancelled = vault
        .document_runtime_command(DocumentRuntimeCommand::CancelRequest { id: 1 })
        .unwrap();
    assert_eq!(
        cancelled.request_outcomes,
        vec![DocumentRuntimeRequestOutcome::Cancelled { id: 1 }]
    );
    assert!(
        vault
            .document_runtime_update()
            .unwrap()
            .has_foreground_demand
    );
    let retired = vault
        .document_runtime_command(DocumentRuntimeCommand::Retire)
        .unwrap();
    assert_eq!(
        retired.request_outcomes,
        vec![DocumentRuntimeRequestOutcome::Retired { id: 2 }]
    );
    let settled = step(&mut vault).unwrap();
    assert_eq!(settled.execution, DocumentRuntimeExecution::Quiesced);
    let (stage, progress) = vault.recover_document_index_stage().unwrap().unwrap();
    assert_eq!(progress.prepared_documents, 32);
    assert_eq!(
        stage.snapshot(),
        &vault
            .document_runtime
            .as_ref()
            .unwrap()
            .core
            .stage()
            .unwrap()
            .snapshot
    );
    assert_eq!(vault.list().unwrap().len(), 35);
}

#[test]
fn successful_cache_swap_expires_unexecuted_old_token_without_mutating_old_stage() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let one = cache.path().join("one.sqlite");
    let two = cache.path().join("two.sqlite");
    let mut vault = open(root.path(), &one);
    create(&mut vault, 0);
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    let old = vault.document_runtime_update().unwrap();
    let stage = vault
        .document_runtime
        .as_ref()
        .unwrap()
        .stage
        .as_ref()
        .unwrap()
        .clone();
    vault.enable_local_document_cache(&two).unwrap();
    assert!(vault.document_runtime_update().is_none());
    assert_eq!(
        step(&mut vault).unwrap_err().code(),
        "document_runtime_not_started"
    );
    let fresh = request(&mut vault, 2, 8);
    assert_ne!(fresh.update.lifetime, old.lifetime);
    let original = open(root.path(), &one);
    let (recovered, progress) = original.recover_document_index_stage().unwrap().unwrap();
    assert_eq!(recovered.snapshot(), stage.snapshot());
    assert_eq!(progress.prepared_documents, 0);
}

#[test]
fn failed_cache_swap_keeps_existing_runtime_and_its_pending_effect() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    request(&mut vault, 1, 8);
    let before = vault.document_runtime_update().unwrap();
    let issued = effect(&vault);
    assert!(vault
        .enable_local_document_cache(root.path().join("inside.sqlite"))
        .is_err());
    assert_eq!(vault.document_runtime_update(), Some(before));
    assert_eq!(effect(&vault), issued);
}

#[test]
fn unsafe_root_fails_effect_without_rebuild_and_preserves_committed_bytes() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    std::fs::create_dir(&root).unwrap();
    let mut vault = NativeVault::open(&root).unwrap();
    create(&mut vault, 0);
    request(&mut vault, 1, 8);
    std::fs::rename(&root, &moved).unwrap();
    std::fs::create_dir(&root).unwrap(); // a different root identity, not missing IO
    let failed = step(&mut vault);
    std::fs::remove_dir(&root).unwrap();
    std::fs::rename(&moved, &root).unwrap();
    let failed = failed.unwrap();
    assert_eq!(failed.update.error, Some(Failure::Fatal));
    assert!(failed.effect.is_none());
    assert_eq!(
        vault
            .read(&EntryId::new("note-0").unwrap())
            .unwrap()
            .unwrap()
            .content,
        Some(b"# Heading0\nold needle\n".to_vec())
    );
}

#[test]
fn typed_error_mapping_never_treats_authoritative_corruption_as_cache_rebuild() {
    use zorid_store::{DocumentIndexError as D, StoreError as S};
    assert_eq!(
        effect_failure(&NativeDocumentError::Index(D::RebuildRequired)),
        Failure::RebuildRequired
    );
    assert_eq!(
        effect_failure(&NativeDocumentError::Index(D::Contract(
            zorid_index::IndexError::SnapshotExpired
        ))),
        Failure::SnapshotExpired
    );
    assert_eq!(
        effect_failure(&NativeDocumentError::Index(D::Authority(S::Corrupt(
            "fixture".into()
        )))),
        Failure::InvalidData
    );
    assert_eq!(
        effect_failure(&NativeDocumentError::Native(crate::Error::UnsafePath(
            "fixture".into()
        ))),
        Failure::Fatal
    );
    assert_eq!(progress_projection(2, 1, false), Err(Failure::InvalidData));
    assert_eq!(progress_projection(0, 1, true), Err(Failure::InvalidData));
    let error = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(11), None);
    assert_eq!(
        effect_failure(&NativeDocumentError::Index(D::Authority(S::Sql(error)))),
        Failure::InvalidData
    );
}

#[test]
fn exact_lost_publish_ack_is_reconciled_against_real_db_even_after_source_moves() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Publish { .. }));
    let issued = vault
        .document_runtime
        .as_ref()
        .unwrap()
        .core
        .in_flight()
        .unwrap()
        .clone();
    let stage = vault
        .document_runtime
        .as_ref()
        .unwrap()
        .stage
        .as_ref()
        .unwrap()
        .clone();
    let published = vault.publish_document_index(&stage).unwrap();
    let mut writer = NativeVault::open_existing(root.path()).unwrap();
    write(&mut writer, 0, "after-publish", "newer source\n");
    // Test-only adapter failure injection: no public API accepts completion data.
    vault
        .document_runtime
        .as_mut()
        .unwrap()
        .reduce(Input::Complete {
            lifetime: issued.lifetime,
            effect_id: issued.id,
            result: EffectResult::Failed(Failure::Uncertain),
        })
        .unwrap();
    let observed = step(&mut vault).unwrap();
    assert_eq!(observed.update.published, Some(published));
    assert_eq!(observed.update.freshness, DocumentRuntimeFreshness::Lagging);
    assert_eq!(observed.request_outcomes.len(), 1);
    assert!(observed.effect.is_none());
    assert!(vault.document_runtime.as_ref().unwrap().stage.is_none());
}

#[test]
fn cancelling_first_request_does_not_cancel_the_second_clients_actual_completion() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    for n in 0..35 {
        create(&mut vault, n);
    }
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    request(&mut vault, 2, 1);
    vault
        .document_runtime_command(DocumentRuntimeCommand::CancelRequest { id: 1 })
        .unwrap();
    let first = step(&mut vault).unwrap();
    let (done, _) = drive(&mut vault, first);
    assert!(matches!(
        done.request_outcomes.as_slice(),
        [DocumentRuntimeRequestOutcome::Finished {
            id: 2,
            observation: Observation { current: true, .. }
        }]
    ));
    assert_eq!(vault.list().unwrap().len(), 35);
}

#[test]
fn exact_step_ack_retry_is_identical_and_never_executes_the_next_effect() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    let start = request(&mut vault, 1, 8);
    let token = start.effect.unwrap();
    let first = vault
        .document_runtime_step(&token.lifetime, token.id)
        .unwrap();
    let pending = effect(&vault);
    let update = vault.document_runtime_update();
    for _ in 0..10 {
        assert_eq!(
            vault
                .document_runtime_step(&token.lifetime, token.id)
                .unwrap(),
            first
        );
    }
    assert_eq!(effect(&vault), pending);
    assert_eq!(vault.document_runtime_update(), update);
    let next = first.effect.unwrap();
    vault
        .document_runtime_step(&next.lifetime, next.id)
        .unwrap();
    let pending = effect(&vault);
    let update = vault.document_runtime_update();
    assert!(vault
        .document_runtime_step(&token.lifetime, token.id)
        .is_err());
    assert!(vault
        .document_runtime_step(&OperationId::new("wrong-lifetime").unwrap(), next.id)
        .is_err());
    assert_eq!(effect(&vault), pending);
    assert_eq!(vault.document_runtime_update(), update);
}

#[test]
fn replayed_pump_ack_keeps_exact_partial_progress_and_a_new_step_replaces_it() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    for n in 0..35 {
        create(&mut vault, n);
    }
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    let token = vault
        .document_runtime
        .as_ref()
        .unwrap()
        .core
        .in_flight()
        .unwrap()
        .clone();
    let first = vault
        .document_runtime_step(&token.lifetime, token.id)
        .unwrap();
    assert_eq!(first.update.progress.as_ref().unwrap().prepared, 32);
    assert_eq!(
        vault
            .document_runtime_step(&token.lifetime, token.id)
            .unwrap(),
        first
    );
    vault
        .document_runtime_command(DocumentRuntimeCommand::Continue)
        .unwrap();
    let next = step(&mut vault).unwrap();
    assert_eq!(next.update.progress.as_ref().unwrap().prepared, 35);
    let update = vault.document_runtime_update();
    assert!(vault
        .document_runtime_step(&token.lifetime, token.id)
        .is_err());
    assert_eq!(vault.document_runtime_update(), update);
}

#[test]
fn provider_replacement_and_retirement_expire_earlier_step_ack_scope() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    let start = request(&mut vault, 1, 8);
    let token = start.effect.unwrap();
    vault
        .document_runtime_step(&token.lifetime, token.id)
        .unwrap();
    vault
        .enable_local_document_cache(cache.path().join("replacement.sqlite"))
        .unwrap();
    let new = request(&mut vault, 2, 8);
    assert_ne!(new.update.lifetime, token.lifetime);
    let before = vault.document_runtime_update();
    assert!(vault
        .document_runtime_step(&token.lifetime, token.id)
        .is_err());
    assert_eq!(vault.document_runtime_update(), before);
    let current = new.effect.unwrap();
    let current_ack = vault
        .document_runtime_step(&current.lifetime, current.id)
        .unwrap();
    vault
        .document_runtime_command(DocumentRuntimeCommand::Retire)
        .unwrap();
    assert!(vault
        .document_runtime_step(&current.lifetime, current.id)
        .is_err());
    let draining = current_ack.effect.unwrap();
    let drained = vault
        .document_runtime_step(&draining.lifetime, draining.id)
        .unwrap();
    assert_eq!(drained.execution, DocumentRuntimeExecution::Quiesced);
    assert!(vault
        .document_runtime_step(&draining.lifetime, draining.id)
        .is_err());
}

#[test]
fn snapshot_exposes_actual_pending_effect_and_actual_pump_metrics_in_one_ack() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    for n in 0..35 {
        create(&mut vault, n);
    }
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::Pump { .. }));
    let issued = vault
        .document_runtime_snapshot()
        .unwrap()
        .in_flight
        .unwrap();
    let report = vault
        .document_runtime_step(&issued.lifetime, issued.id)
        .unwrap();
    let actual = vault.document_runtime_snapshot().unwrap();
    assert_eq!(actual.execution, DocumentRuntimeExecution::Yield);
    assert!(actual.in_flight.is_none());
    let record = actual.last_step.unwrap();
    assert_eq!(record.lifetime, issued.lifetime);
    assert_eq!(record.effect_id, issued.id);
    assert_eq!(record.receipt.issued, issued);
    assert_eq!(record.reduction, report);
    let progress = record.receipt.pump.as_ref().unwrap();
    assert_eq!(progress.prepared_documents, 32);
    assert_eq!(progress.total_documents, 35);
    assert!(matches!(record.receipt.completion, EffectResult::Stage(_)));
    let replay = vault
        .document_runtime_step(&issued.lifetime, issued.id)
        .unwrap();
    assert_eq!(replay, report);
    let retained = vault
        .document_runtime_snapshot()
        .unwrap()
        .last_step
        .unwrap()
        .receipt
        .pump
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(progress, &retained));
    vault
        .document_runtime_command(DocumentRuntimeCommand::Continue)
        .unwrap();
    let actual = vault.document_runtime_snapshot().unwrap();
    assert_eq!(actual.execution, DocumentRuntimeExecution::Dispatch);
    assert_eq!(
        actual.last_step.unwrap().reduction.execution,
        DocumentRuntimeExecution::Yield
    );
}

#[test]
fn current_fastpath_continuation_snapshot_does_not_repeat_old_yield_ack() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    ready(&mut vault);
    vault
        .document_runtime_command(DocumentRuntimeCommand::Wake { monotonic_ms: 10 })
        .unwrap();
    request(&mut vault, 2, 8);
    step(&mut vault).unwrap();
    let yielded = step(&mut vault).unwrap();
    assert_eq!(yielded.execution, DocumentRuntimeExecution::Yield);
    let finished = vault
        .document_runtime_command(DocumentRuntimeCommand::Continue)
        .unwrap();
    assert_eq!(finished.execution, DocumentRuntimeExecution::WaitForWake);
    let actual = vault.document_runtime_snapshot().unwrap();
    assert_eq!(actual.execution, DocumentRuntimeExecution::WaitForWake);
    assert!(actual.in_flight.is_none());
    assert_eq!(
        actual.last_step.unwrap().reduction.execution,
        DocumentRuntimeExecution::Yield
    );
    assert_eq!(finished.request_outcomes.len(), 1);
}

#[test]
fn recovery_receipt_preserves_actual_resumed_source_and_progress_without_a_pump() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let path = cache.path().join("cache.sqlite");
    let mut vault = open(root.path(), &path);
    create(&mut vault, 0);
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    vault.pump_document_index(&stage).unwrap();
    drop(vault);
    let mut vault = open(root.path(), &path);
    request(&mut vault, 1, 8);
    until(&mut vault, |e| matches!(e, Effect::RecoverStage));
    step(&mut vault).unwrap();
    let receipt = vault
        .document_runtime_snapshot()
        .unwrap()
        .last_step
        .unwrap()
        .receipt;
    assert!(receipt.pump.is_none());
    match receipt.completion {
        EffectResult::Recovered(Some(observed)) => {
            assert_eq!(observed.snapshot, *stage.snapshot());
            assert_eq!(observed.source, *stage.source());
            assert_eq!(observed.progress.unwrap().prepared, 1);
        }
        _ => panic!("actual recovered stage required"),
    }
}

#[test]
fn new_owner_can_restart_only_after_retirement_has_fully_drained() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    let started = request(&mut vault, 1, 8);
    let lifetime = started.update.lifetime;
    assert!(vault.restart_document_runtime().is_err());
    vault
        .document_runtime_command(DocumentRuntimeCommand::Retire)
        .unwrap();
    assert!(vault.restart_document_runtime().is_err());
    step(&mut vault).unwrap();
    vault.restart_document_runtime().unwrap();
    assert!(vault.document_runtime_snapshot().is_none());
    let fresh = vault
        .document_runtime_command(DocumentRuntimeCommand::Wake { monotonic_ms: 1 })
        .unwrap();
    assert_ne!(fresh.update.lifetime, lifetime);
    assert_eq!(vault.list().unwrap().len(), 1);
}

#[test]
fn retired_rebuild_returns_actual_call_owned_receipt_despite_prior_visible_error() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    create(&mut vault, 0);
    request(&mut vault, 1, 8);
    let issued = vault
        .document_runtime_snapshot()
        .unwrap()
        .in_flight
        .unwrap();
    vault
        .document_runtime
        .as_mut()
        .unwrap()
        .reduce(Input::Complete {
            lifetime: issued.lifetime,
            effect_id: issued.id,
            result: EffectResult::Failed(Failure::Unavailable),
        })
        .unwrap();
    let mut q = DocumentFreshnessRequest::new(2);
    q.force_rebuild = true;
    vault
        .document_runtime_command(DocumentRuntimeCommand::Request(q))
        .unwrap();
    let issued = vault
        .document_runtime_snapshot()
        .unwrap()
        .in_flight
        .unwrap();
    assert!(matches!(issued.kind, Effect::Rebuild));
    vault
        .document_runtime_command(DocumentRuntimeCommand::Retire)
        .unwrap();
    let record = vault
        .document_runtime_step_record(&issued.lifetime, issued.id)
        .unwrap();
    assert!(matches!(record.receipt.completion, EffectResult::Done));
    assert_eq!(record.reduction.update.error, Some(Failure::Unavailable));
    assert_eq!(
        record.reduction.execution,
        DocumentRuntimeExecution::Quiesced
    );
    assert!(vault
        .document_runtime_snapshot()
        .unwrap()
        .last_step
        .is_none());
}
