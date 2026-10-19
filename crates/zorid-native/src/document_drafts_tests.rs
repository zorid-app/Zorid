use super::*;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_document::ParseFactsPhase;
use zorid_index::{document_runtime as c, document_work_runtime as w, draft_runtime as d};

fn op(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn descriptor(source: &str) -> d::SourceDescriptor {
    d::SourceDescriptor {
        bytes: source.len(),
        utf16: source.encode_utf16().count(),
        sha256: Sha256::digest(source.as_bytes()).into(),
    }
}
fn request_for(client: &str, buffer: &str, revision: u64, source: &str) -> d::DraftRequest {
    d::DraftRequest {
        tag: d::DraftTag {
            buffer: d::BufferKey {
                client: op(client),
                buffer_lifetime: op(buffer),
            },
            text_revision: revision,
        },
        source: descriptor(source),
    }
}
fn open() -> (tempfile::TempDir, tempfile::TempDir, NativeVault) {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    vault
        .enable_local_document_cache(cache.path().join("documents.sqlite"))
        .unwrap();
    (root, cache, vault)
}
fn reserve(vault: &mut NativeVault, request: d::DraftRequest) -> d::JobToken {
    vault
        .document_draft_command(NativeDraftCommand::Request(request))
        .unwrap()
        .admitted
        .unwrap()
}
fn attach(vault: &mut NativeVault, buffer: &str, revision: u64, source: &Arc<str>) -> d::JobToken {
    let job = reserve(vault, request_for("client", buffer, revision, source));
    vault
        .document_draft_attach_source(&job, Arc::clone(source))
        .unwrap();
    job
}
fn assert_snapshot_eq(vault: &NativeVault, before: &NativeDraftSnapshot) {
    let after = vault.document_draft_snapshot().unwrap();
    assert_eq!(after.runtime, before.runtime);
    assert_eq!(after.work, before.work);
    assert_eq!(after.handles, before.handles);
}
fn next(vault: &mut NativeVault) -> w::Ticket {
    vault
        .document_work_next_turn()
        .unwrap()
        .ticket
        .expect("fixture has an admitted real effect")
}
fn drive(vault: &mut NativeVault) -> Vec<NativeWorkStepRecord> {
    let mut records = Vec::new();
    for _ in 0..100 {
        let turn = vault.document_work_next_turn().unwrap();
        let Some(ticket) = turn.ticket else {
            return records;
        };
        records.push(vault.document_work_step(&ticket).unwrap());
    }
    panic!("bounded real native work fixture exceeded 100 turns");
}
fn phase(vault: &mut NativeVault, job: &d::JobToken, completed: u8) {
    let ticket = next(vault);
    let w::ChildEffect::Draft(effect) = &ticket.effect else {
        panic!("expected one actual draft phase");
    };
    assert_eq!(&effect.job, job);
    assert!(
        matches!(effect.kind, d::Effect::ParsePhase { phases_completed, .. } if phases_completed == completed)
    );
    let record = vault.document_work_step(&ticket).unwrap();
    let NativeWorkReceipt::Draft(record) = record.receipt else {
        panic!("actual draft receipt required");
    };
    let d::Completion::Parsed(progress) = record.completion else {
        panic!("actual successful parser phase required");
    };
    assert_eq!(progress.phases_completed, completed + 1);
}
fn ready(vault: &mut NativeVault, job: &d::JobToken) {
    drive(vault);
    assert!(vault
        .document_draft_snapshot()
        .unwrap()
        .runtime
        .outcomes
        .iter()
        .any(|outcome| outcome.job == *job && outcome.kind == d::OutcomeKind::Ready));
}
fn create(vault: &mut NativeVault, number: usize) {
    vault
        .apply(&MutationRequest {
            operation_id: op(&format!("create-{number}")),
            mutation: Mutation::Create {
                id: EntryId::new(format!("note-{number}")).unwrap(),
                path: VaultPath::new(format!("Note{number}.md")).unwrap(),
                kind: EntryKind::File,
                content: Some(format!("# Saved {number}\nneedle\n").into_bytes()),
            },
        })
        .unwrap();
}
fn committed(vault: &mut NativeVault, id: u64, force_rebuild: bool) {
    vault
        .document_runtime_command(DocumentRuntimeCommand::Request(DocumentFreshnessRequest {
            id,
            max_pumps: 8,
            max_restarts: 1,
            force_rebuild,
        }))
        .unwrap();
}

#[test]
fn request_reserves_before_source_retention_and_attachment_runs_no_phase() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Draft 😀\r\n[[Target]]");
    let job = reserve(&mut vault, request_for("client", "buffer", 1, &source));
    let reserved = vault.document_draft_snapshot().unwrap();
    assert_eq!(reserved.handles, 1);
    assert_eq!(reserved.runtime.usage.source_bytes, source.len());
    assert_eq!(Arc::strong_count(&source), 1);
    assert!(vault.document_draft_facts(&job).is_err());
    vault
        .document_draft_attach_source(&job, Arc::clone(&source))
        .unwrap();
    let attached = vault.document_draft_snapshot().unwrap();
    assert_eq!(attached.handles, 1);
    assert_eq!(attached.runtime.usage.scratch_bytes, 0);
    assert_eq!(attached.runtime.usage.facts_bytes, 0);
    assert_eq!(Arc::strong_count(&source), 2);
    let effect = attached.runtime.in_flight.unwrap();
    assert!(matches!(
        effect.kind,
        d::Effect::ParsePhase {
            phase: ParseFactsPhase::Positions,
            phases_completed: 0,
            ..
        }
    ));
}

#[test]
fn aggregate_input_refusal_retains_no_source_handle_and_does_not_change_owner() {
    let (_root, _cache, mut vault) = open();
    for buffer in ["one", "two"] {
        let mut request = request_for("client", buffer, 1, "x");
        request.source.bytes = d::MAX_DRAFT_SOURCE_BYTES;
        request.source.utf16 = d::MAX_DRAFT_SOURCE_BYTES;
        reserve(&mut vault, request);
    }
    let before = vault.document_draft_snapshot().unwrap();
    assert_eq!(before.runtime.usage.source_bytes, d::MAX_DRAFT_INPUT_BYTES);
    assert_eq!(before.handles, 2);
    assert!(vault
        .document_draft_command(NativeDraftCommand::Request(request_for(
            "client", "three", 1, "x"
        )))
        .is_err());
    assert_snapshot_eq(&vault, &before);
}

#[test]
fn mismatched_source_fingerprint_or_unicode_length_cannot_seal_reservation() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("😀x");
    let job = reserve(&mut vault, request_for("client", "buffer", 1, &source));
    let before = vault.document_draft_snapshot().unwrap();
    // Same UTF8 byte length but different bytes and UTF16 length.
    assert!(vault
        .document_draft_attach_source(&job, Arc::from("abcde"))
        .is_err());
    assert_snapshot_eq(&vault, &before);
    assert!(vault
        .document_draft_attach_source(&job, Arc::from("😀y"))
        .is_err());
    assert_snapshot_eq(&vault, &before);
    vault.document_draft_attach_source(&job, source).unwrap();
}

#[test]
fn duplicate_request_and_seal_share_actual_arc_and_preserve_parser_progress() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Draft\n[[Target]]");
    let request = request_for("client", "buffer", 1, &source);
    let job = reserve(&mut vault, request.clone());
    vault
        .document_draft_attach_source(&job, Arc::clone(&source))
        .unwrap();
    phase(&mut vault, &job, 0);
    let before = vault.document_draft_snapshot().unwrap();
    let replay = vault
        .document_draft_command(NativeDraftCommand::Request(request))
        .unwrap();
    assert!(replay.replay);
    assert_eq!(replay.admitted, Some(job.clone()));
    vault
        .document_draft_attach_source(&job, Arc::clone(&source))
        .unwrap();
    assert_eq!(Arc::strong_count(&source), 2);
    assert_snapshot_eq(&vault, &before);
    phase(&mut vault, &job, 1);
}

#[test]
fn wrong_client_tag_and_ticket_are_rejected_before_parser_or_memory_mutation() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Draft");
    let job = attach(&mut vault, "buffer", 1, &source);
    let ticket = next(&mut vault);
    let before = vault.document_draft_snapshot().unwrap();
    assert!(vault
        .document_draft_command(NativeDraftCommand::Cancel {
            client: op("other"),
            job: job.clone()
        })
        .is_err());
    assert!(vault
        .document_draft_command(NativeDraftCommand::Acknowledge {
            client: op("other"),
            job: job.clone()
        })
        .is_err());
    let mut wrong_tag = job.clone();
    wrong_tag.tag.text_revision += 1;
    assert!(vault
        .document_draft_attach_source(&wrong_tag, Arc::clone(&source))
        .is_err());
    assert!(vault.document_draft_facts(&wrong_tag).is_err());
    let mut wrong_ticket = ticket.clone();
    wrong_ticket.incarnation = op("foreign-incarnation");
    assert!(vault.document_work_step(&wrong_ticket).is_err());
    let mut wrong_effect = ticket.clone();
    let w::ChildEffect::Draft(effect) = &mut wrong_effect.effect else {
        panic!("draft ticket required")
    };
    effect.job.tag.text_revision += 1;
    assert!(vault.document_work_step(&wrong_effect).is_err());
    assert_snapshot_eq(&vault, &before);
    vault.document_work_step(&ticket).unwrap();
}

#[test]
fn exact_step_replay_does_not_execute_next_phase_and_older_receipt_expires() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Draft");
    let job = attach(&mut vault, "buffer", 1, &source);
    let ticket = next(&mut vault);
    let first = vault.document_work_step(&ticket).unwrap();
    let before = vault.document_draft_snapshot().unwrap();
    let replay = vault.document_work_step(&ticket).unwrap();
    assert_eq!(first.ticket, replay.ticket);
    let (NativeWorkReceipt::Draft(first), NativeWorkReceipt::Draft(replay)) =
        (first.receipt, replay.receipt)
    else {
        panic!("draft receipts required")
    };
    assert_eq!(first.issued, replay.issued);
    assert_eq!(first.completion, replay.completion);
    assert_eq!(first.reduction, replay.reduction);
    assert_snapshot_eq(&vault, &before);
    phase(&mut vault, &job, 1);
    let newer = vault.document_draft_snapshot().unwrap();
    assert!(vault.document_work_step(&ticket).is_err());
    assert_snapshot_eq(&vault, &newer);
}

#[test]
fn cancellation_at_every_actual_phase_prevents_remaining_parser_passes() {
    for completed in 0..=7 {
        let (_root, _cache, mut vault) = open();
        let source: Arc<str> =
            Arc::from("---\naliases: [One, Two]\n---\n# Draft 😀\n[[Target]] #tag\n- [x] done");
        let job = attach(&mut vault, "buffer", 1, &source);
        for phase_number in 0..completed {
            phase(&mut vault, &job, phase_number);
        }
        vault
            .document_draft_command(NativeDraftCommand::Cancel {
                client: op("client"),
                job: job.clone(),
            })
            .unwrap();
        assert!(vault.document_draft_facts(&job).is_err());
        let records = drive(&mut vault);
        for record in records {
            if let NativeWorkReceipt::Draft(record) = record.receipt {
                assert_eq!(record.issued.job, job);
                match record.completion {
                    d::Completion::Stopped {
                        phases_completed,
                        usage,
                    } => {
                        assert_eq!(phases_completed, completed);
                        assert_eq!(
                            usage.source_bytes + usage.scratch_bytes + usage.facts_bytes,
                            0
                        );
                    }
                    d::Completion::Dropped => {}
                    other => panic!("cancelled job executed further work: {other:?}"),
                }
            }
        }
        let after = vault.document_draft_snapshot().unwrap();
        assert_eq!(after.handles, 0);
        assert_eq!(
            after.runtime.usage.source_bytes
                + after.runtime.usage.scratch_bytes
                + after.runtime.usage.facts_bytes,
            0
        );
        assert_eq!(Arc::strong_count(&source), 1);
        assert!(after
            .runtime
            .outcomes
            .iter()
            .any(|outcome| outcome.job == job && outcome.kind == d::OutcomeKind::Cancelled));
    }
}

#[test]
fn newer_revision_at_every_phase_stops_old_job_and_only_new_facts_are_current() {
    for completed in 0..=7 {
        let (_root, _cache, mut vault) = open();
        let old: Arc<str> = Arc::from("# Old 😀\n[[Before]] #old");
        let new: Arc<str> = Arc::from("# New 😀\n[[After]] #new");
        let old_job = attach(&mut vault, "buffer", 1, &old);
        for phase_number in 0..completed {
            phase(&mut vault, &old_job, phase_number);
        }
        let new_job = attach(&mut vault, "buffer", 2, &new);
        assert_ne!(old_job, new_job);
        assert!(vault.document_draft_facts(&old_job).is_err());
        let records = drive(&mut vault);
        for record in records {
            if let NativeWorkReceipt::Draft(record) = record.receipt {
                if record.issued.job == old_job {
                    match record.completion {
                        d::Completion::Dropped => {}
                        d::Completion::Stopped {
                            phases_completed, ..
                        } => assert_eq!(phases_completed, completed),
                        other => panic!("superseded job executed further work: {other:?}"),
                    }
                }
            }
        }
        let facts = vault.document_draft_facts(&new_job).unwrap();
        assert_eq!(facts.headings[0].text, "New 😀");
        assert_eq!(facts.links[0].target, "After");
        assert_eq!(Arc::strong_count(&old), 1);
        let after = vault.document_draft_snapshot().unwrap();
        assert!(after
            .runtime
            .outcomes
            .iter()
            .any(|outcome| outcome.job == old_job && outcome.kind == d::OutcomeKind::Superseded));
        assert!(after
            .runtime
            .outcomes
            .iter()
            .any(|outcome| outcome.job == new_job && outcome.kind == d::OutcomeKind::Ready));
    }
}

#[test]
fn ready_facts_remain_charged_until_acknowledgement_and_actual_drop() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Ready\n[[Target]]");
    let job = attach(&mut vault, "buffer", 1, &source);
    ready(&mut vault, &job);
    let before = vault.document_draft_snapshot().unwrap();
    assert_eq!(before.runtime.usage.source_bytes, 0);
    assert_eq!(before.runtime.usage.scratch_bytes, 0);
    assert!(before.runtime.usage.facts_bytes > 0);
    assert_eq!(before.handles, 1);
    assert_eq!(
        vault.document_draft_facts(&job).unwrap().headings[0].text,
        "Ready"
    );
    vault
        .document_draft_command(NativeDraftCommand::Acknowledge {
            client: op("client"),
            job: job.clone(),
        })
        .unwrap();
    let acknowledged = vault.document_draft_snapshot().unwrap();
    assert_eq!(
        acknowledged.runtime.usage.facts_bytes,
        before.runtime.usage.facts_bytes
    );
    assert_eq!(acknowledged.handles, 1);
    assert!(vault.document_draft_facts(&job).is_err());
    let records = drive(&mut vault);
    assert_eq!(records.len(), 1);
    assert!(matches!(
        &records[0].receipt,
        NativeWorkReceipt::Draft(NativeDraftStepRecord {
            issued: d::IssuedEffect {
                kind: d::Effect::DropJob,
                ..
            },
            completion: d::Completion::Dropped,
            ..
        })
    ));
    let dropped = vault.document_draft_snapshot().unwrap();
    assert_eq!(dropped.handles, 0);
    assert_eq!(dropped.runtime.usage.facts_bytes, 0);
    assert!(dropped.runtime.outcomes.is_empty());
}

#[test]
fn buffer_and_client_release_drop_only_owned_transient_handles() {
    let (_root, _cache, mut vault) = open();
    let first: Arc<str> = Arc::from("# First");
    let second: Arc<str> = Arc::from("# Second");
    let one = attach(&mut vault, "one", 1, &first);
    let two = attach(&mut vault, "two", 1, &second);
    ready(&mut vault, &one);
    assert!(vault.document_draft_facts(&two).is_ok());
    vault
        .document_draft_command(NativeDraftCommand::ReleaseBuffer(one.tag.buffer.clone()))
        .unwrap();
    assert!(vault.document_draft_facts(&one).is_err());
    drive(&mut vault);
    assert_eq!(vault.document_draft_snapshot().unwrap().handles, 1);
    assert_eq!(
        vault.document_draft_facts(&two).unwrap().headings[0].text,
        "Second"
    );
    vault
        .document_draft_command(NativeDraftCommand::ReleaseClient(op("client")))
        .unwrap();
    drive(&mut vault);
    let after = vault.document_draft_snapshot().unwrap();
    assert_eq!(after.handles, 0);
    assert!(after.runtime.outcomes.is_empty());
    assert_eq!(
        after.runtime.usage.source_bytes
            + after.runtime.usage.scratch_bytes
            + after.runtime.usage.facts_bytes,
        0
    );
}

#[test]
fn draft_facts_do_not_mutate_saved_source_authority_or_index_database() {
    let (root, _cache, mut vault) = open();
    create(&mut vault, 0);
    let before_source = std::fs::read(root.path().join("Note0.md")).unwrap();
    let before_entries = serde_json::to_value(vault.list().unwrap()).unwrap();
    let before_status =
        serde_json::to_value(vault.document_index_status_with_source().unwrap()).unwrap();
    let source: Arc<str> = Arc::from("# Unsaved\n[[Different]] #draft");
    let job = attach(&mut vault, "buffer", 1, &source);
    ready(&mut vault, &job);
    assert_eq!(
        vault.document_draft_facts(&job).unwrap().headings[0].text,
        "Unsaved"
    );
    assert_eq!(
        std::fs::read(root.path().join("Note0.md")).unwrap(),
        before_source
    );
    assert_eq!(
        serde_json::to_value(vault.list().unwrap()).unwrap(),
        before_entries
    );
    assert_eq!(
        serde_json::to_value(vault.document_index_status_with_source().unwrap()).unwrap(),
        before_status
    );
}

#[test]
fn legacy_committed_executor_cannot_bypass_selected_draft_turn() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Draft");
    attach(&mut vault, "buffer", 1, &source);
    let wake = vault
        .document_runtime_command(DocumentRuntimeCommand::Wake { monotonic_ms: 1 })
        .unwrap();
    let committed = wake.effect.unwrap();
    let draft = next(&mut vault);
    assert!(matches!(draft.effect, w::ChildEffect::Draft(_)));
    let before = vault.document_draft_snapshot().unwrap();
    assert!(vault
        .document_runtime_step_record(&committed.lifetime, committed.id)
        .is_err());
    assert_snapshot_eq(&vault, &before);
    vault.document_work_step(&draft).unwrap();
}

#[test]
fn arbiter_alternates_actual_lanes_and_keeps_real_committed_pump_receipts() {
    let (_root, _cache, mut vault) = open();
    for number in 0..35 {
        create(&mut vault, number);
    }
    let source: Arc<str> = Arc::from("# Draft\n[[Target]]");
    attach(&mut vault, "buffer", 1, &source);
    committed(&mut vault, 1, false);
    let records = drive(&mut vault);
    let lanes: Vec<_> = records.iter().map(|r| r.ticket.effect.lane()).collect();
    assert_eq!(
        &lanes[..4],
        &[
            w::Lane::Committed,
            w::Lane::Draft,
            w::Lane::Committed,
            w::Lane::Draft
        ]
    );
    let pumps: Vec<_> = records
        .iter()
        .filter_map(|record| match &record.receipt {
            NativeWorkReceipt::Committed(record)
                if matches!(record.receipt.issued.kind, c::Effect::Pump { .. }) =>
            {
                Some(record)
            }
            _ => None,
        })
        .collect();
    assert_eq!(pumps.len(), 2);
    assert_eq!(
        pumps[0].receipt.pump.as_ref().unwrap().prepared_documents,
        32
    );
    assert_eq!(pumps[0].receipt.pump.as_ref().unwrap().total_documents, 35);
    assert_eq!(
        pumps[1].receipt.pump.as_ref().unwrap().prepared_documents,
        35
    );
    assert!(matches!(
        pumps[0].receipt.completion,
        c::EffectResult::Stage(_)
    ));
}

#[test]
fn shared_executor_preserves_actual_rebuild_completion_receipt() {
    let (_root, _cache, mut vault) = open();
    create(&mut vault, 0);
    let source: Arc<str> = Arc::from("# Draft");
    let job = attach(&mut vault, "buffer", 1, &source);
    committed(&mut vault, 1, false);
    drive(&mut vault);
    assert!(vault.document_draft_facts(&job).is_ok());
    committed(&mut vault, 2, true);
    let records = drive(&mut vault);
    let rebuilds: Vec<_> = records
        .iter()
        .filter_map(|record| match &record.receipt {
            NativeWorkReceipt::Committed(record)
                if matches!(record.receipt.issued.kind, c::Effect::Rebuild) =>
            {
                Some(record)
            }
            _ => None,
        })
        .collect();
    assert_eq!(rebuilds.len(), 1);
    assert_eq!(rebuilds[0].receipt.completion, c::EffectResult::Done);
    assert!(rebuilds[0].receipt.pump.is_none());
    assert!(vault.document_draft_facts(&job).is_ok());
}

#[test]
fn close_drains_both_children_and_actual_registry_before_reporting_ready() {
    let (_root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Draft");
    let job = attach(&mut vault, "buffer", 1, &source);
    let selected = next(&mut vault);
    vault
        .document_runtime_command(DocumentRuntimeCommand::Wake { monotonic_ms: 1 })
        .unwrap();
    vault.document_work_begin_close().unwrap();
    assert!(!vault.document_work_close_ready());
    assert!(vault.document_draft_facts(&job).is_err());
    assert!(vault
        .document_draft_command(NativeDraftCommand::Request(request_for(
            "client",
            "new-buffer",
            1,
            "x"
        )))
        .is_err());
    // Closing preserves the exact already-selected descriptor for its drain.
    assert_eq!(next(&mut vault), selected);
    drive(&mut vault);
    assert!(vault.document_work_close_ready());
    assert_eq!(vault.document_draft_snapshot().unwrap().handles, 0);
    assert_eq!(
        vault.document_work_next_turn().unwrap().state,
        w::WorkState::Quiesced
    );
    assert_eq!(Arc::strong_count(&source), 1);
}

#[test]
fn cache_provider_replacement_expires_old_ticket_source_and_fact_scope() {
    let (_root, cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Old");
    let old_job = attach(&mut vault, "buffer", 1, &source);
    let old_ticket = next(&mut vault);
    vault
        .enable_local_document_cache(cache.path().join("replacement.sqlite"))
        .unwrap();
    assert_eq!(Arc::strong_count(&source), 1);
    assert!(vault.document_work_step(&old_ticket).is_err());
    assert!(vault.document_draft_facts(&old_job).is_err());
    let new_source: Arc<str> = Arc::from("# New");
    let new_job = attach(&mut vault, "buffer", 1, &new_source);
    assert_ne!(new_job.lifetime, old_job.lifetime);
    let before = vault.document_draft_snapshot().unwrap();
    assert!(vault.document_work_step(&old_ticket).is_err());
    assert_snapshot_eq(&vault, &before);
    ready(&mut vault, &new_job);
    assert_eq!(
        vault.document_draft_facts(&new_job).unwrap().headings[0].text,
        "New"
    );
}

#[test]
fn failed_cache_provider_selection_preserves_actual_parser_and_selected_ticket() {
    let (root, _cache, mut vault) = open();
    let source: Arc<str> = Arc::from("# Retained");
    let job = attach(&mut vault, "buffer", 1, &source);
    let ticket = next(&mut vault);
    let before = vault.document_draft_snapshot().unwrap();
    assert!(vault
        .enable_local_document_cache(root.path().join("forbidden.sqlite"))
        .is_err());
    assert_snapshot_eq(&vault, &before);
    assert_eq!(Arc::strong_count(&source), 2);
    vault.document_work_step(&ticket).unwrap();
    ready(&mut vault, &job);
    assert_eq!(
        vault.document_draft_facts(&job).unwrap().headings[0].text,
        "Retained"
    );
}

#[test]
fn portable_executor_errors_preserve_native_and_legacy_classification() {
    use zorid_index::document_draft_executor::DraftExecutorError as E;
    let cases = [
        (E::SourceMismatch, "SourceMismatch"),
        (E::Expired, "Expired"),
        (E::NotReady, "NotReady"),
        (E::Closed, "Closed"),
        (
            E::Transfer(NativeDraftTransferError::Resource),
            "Transfer(Resource)",
        ),
        (E::UnexpectedParserState, "UnexpectedParserState"),
        (E::Work(w::WorkError::WrongTicket), "Work(WrongTicket)"),
        (
            E::Draft(d::RuntimeError::InvalidCompletion),
            "Draft(InvalidCompletion)",
        ),
    ];
    for (portable, expected) in cases {
        let native = NativeDocumentWorkError::from(portable);
        assert_eq!(format!("{native:?}"), expected);
        assert!(matches!(
            legacy_error(native),
            NativeDocumentRuntimeError::Contract(
                DocumentRuntimeContractError::UnexpectedCompletion
            )
        ));
    }
    let native = NativeDocumentWorkError::from(E::Work(w::WorkError::Committed(
        c::RuntimeError::UnexpectedCompletion,
    )));
    assert!(matches!(
        native,
        NativeDocumentWorkError::Work(w::WorkError::Committed(
            c::RuntimeError::UnexpectedCompletion
        ))
    ));
    assert!(matches!(
        legacy_error(native),
        NativeDocumentRuntimeError::Contract(DocumentRuntimeContractError::UnexpectedCompletion)
    ));
}
