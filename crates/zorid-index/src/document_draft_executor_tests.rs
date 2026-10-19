use super::*;
use crate::{document_runtime as c, document_work_runtime as w, draft_runtime as d};
use crate::{IndexSnapshotId, SemanticVersions, SourceSnapshotId, SourceWatermark};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::{ParseFactsPhase, ParseFactsStepBudget};

fn id(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn versions() -> SemanticVersions {
    SemanticVersions::new(2, "extract", "resolver", "query").unwrap()
}
fn request(buffer: &str, revision: u64, text: &str) -> d::DraftRequest {
    d::DraftRequest {
        tag: d::DraftTag {
            buffer: d::BufferKey {
                client: id("client"),
                buffer_lifetime: id(buffer),
            },
            text_revision: revision,
        },
        source: d::SourceDescriptor {
            bytes: text.len(),
            utf16: text.encode_utf16().count(),
            sha256: Sha256::digest(text.as_bytes()).into(),
        },
    }
}
struct Host {
    executor: DocumentDraftExecutor,
    committed: c::DocumentRuntime,
    execution: c::Execution,
}
impl Host {
    fn new() -> Self {
        Self {
            executor: DocumentDraftExecutor::new(id("draft"), id("work")),
            committed: c::DocumentRuntime::new(c::RuntimeIdentity {
                lifetime: id("committed"),
                local_store: id("store"),
                versions: versions(),
            }),
            execution: c::Execution::WaitForWake,
        }
    }
    fn reserve(&mut self, request: d::DraftRequest) -> d::JobToken {
        self.executor
            .command(DraftCommand::Request(request))
            .unwrap()
            .admitted
            .unwrap()
    }
    fn attach(&mut self, buffer: &str, revision: u64, source: &Arc<str>) -> d::JobToken {
        let job = self.reserve(request(buffer, revision, source));
        self.executor
            .attach_source(&job, Arc::clone(source))
            .unwrap();
        job
    }
    fn next(&mut self) -> w::Ticket {
        self.executor
            .next_turn(&mut self.committed, &mut self.execution)
            .unwrap()
            .ticket
            .expect("fixture has actual selected work")
    }
    fn step(&mut self, ticket: &w::Ticket) -> DraftStepRecord {
        self.executor
            .step_draft(ticket, &mut self.committed, &mut self.execution)
            .unwrap()
    }
    fn phase(&mut self, job: &d::JobToken, completed: u8) {
        let ticket = self.next();
        let w::ChildEffect::Draft(effect) = &ticket.effect else {
            panic!("draft phase required")
        };
        assert_eq!(&effect.job, job);
        assert!(
            matches!(effect.kind, d::Effect::ParsePhase { phases_completed, .. } if phases_completed == completed)
        );
        let actual = self.step(&ticket);
        let d::Completion::Parsed(progress) = actual.completion else {
            panic!("actual parser phase required")
        };
        assert_eq!(progress.phases_completed, completed + 1);
    }
    fn drive(&mut self) -> Vec<DraftStepRecord> {
        let mut records = Vec::new();
        for _ in 0..64 {
            let turn = self
                .executor
                .next_turn(&mut self.committed, &mut self.execution)
                .unwrap();
            let Some(ticket) = turn.ticket else {
                return records;
            };
            records.push(self.step(&ticket));
        }
        panic!("portable fixture exceeded 64 actual turns");
    }
}
fn assert_unchanged(host: &Host, before: &DraftSnapshot) {
    let after = host.executor.snapshot();
    assert_eq!(after.runtime, before.runtime);
    assert_eq!(after.work, before.work);
    assert_eq!(after.handles, before.handles);
}

#[test]
fn portable_constructor_and_reservation_do_not_parse_or_copy_source() {
    let mut host = Host::new();
    let empty = host.executor.snapshot();
    assert_eq!(empty.handles, 0);
    assert_eq!(
        empty.runtime.usage,
        zorid_document::ParseFactsUsage::default()
    );
    let source: Arc<str> = Arc::from("# Draft 😀\r\n[[Target]]");
    let job = host.reserve(request("buffer", 1, &source));
    assert_eq!(Arc::strong_count(&source), 1);
    let reserved = host.executor.snapshot();
    assert_eq!(reserved.handles, 1);
    assert_eq!(reserved.runtime.usage.source_bytes, source.len());
    assert_eq!(
        reserved.runtime.usage.facts_bytes + reserved.runtime.usage.scratch_bytes,
        0
    );
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    assert_eq!(Arc::strong_count(&source), 2);
    let attached = host.executor.snapshot();
    assert_eq!(
        attached.runtime.usage.facts_bytes + attached.runtime.usage.scratch_bytes,
        0
    );
    assert!(matches!(
        attached.runtime.in_flight.unwrap().kind,
        d::Effect::ParsePhase {
            phase: ParseFactsPhase::Positions,
            phases_completed: 0,
            ..
        }
    ));
}

#[test]
fn portable_duplicate_admission_reuses_actual_arc_and_parser_progress() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Heading\n[[Target]]");
    let request = request("buffer", 1, &source);
    let job = host.reserve(request.clone());
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    host.phase(&job, 0);
    let before = host.executor.snapshot();
    let replay = host
        .executor
        .command(DraftCommand::Request(request))
        .unwrap();
    assert!(replay.replay);
    assert_eq!(replay.admitted, Some(job.clone()));
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    assert_eq!(Arc::strong_count(&source), 2);
    assert_unchanged(&host, &before);
    host.phase(&job, 1);
}

#[test]
fn portable_source_owner_and_ticket_rejections_preserve_selected_work() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("😀x");
    let job = host.reserve(request("buffer", 1, &source));
    let reserved = host.executor.snapshot();
    assert!(host
        .executor
        .attach_source(&job, Arc::from("abcde"))
        .is_err());
    assert!(host.executor.attach_source(&job, Arc::from("😀y")).is_err());
    assert_unchanged(&host, &reserved);
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    let ticket = host.next();
    let before = host.executor.snapshot();
    assert!(host
        .executor
        .command(DraftCommand::Cancel {
            client: id("foreign"),
            job: job.clone()
        })
        .is_err());
    let mut forged = ticket.clone();
    forged.incarnation = id("foreign-work");
    assert!(host
        .executor
        .step_draft(&forged, &mut host.committed, &mut host.execution)
        .is_err());
    assert_unchanged(&host, &before);
    host.step(&ticket);
}

#[test]
fn portable_receipt_replay_never_runs_next_phase_and_old_receipt_expires() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Heading");
    let job = host.attach("buffer", 1, &source);
    let ticket = host.next();
    let actual = host.step(&ticket);
    let before = host.executor.snapshot();
    let replay = host.step(&ticket);
    assert_eq!(actual.issued, replay.issued);
    assert_eq!(actual.completion, replay.completion);
    assert_eq!(actual.reduction, replay.reduction);
    assert_unchanged(&host, &before);
    host.phase(&job, 1);
    let newer = host.executor.snapshot();
    assert!(host
        .executor
        .step_draft(&ticket, &mut host.committed, &mut host.execution)
        .is_err());
    assert_unchanged(&host, &newer);
}

#[test]
fn portable_cancel_releases_actual_input_and_prevents_remaining_passes() {
    for completed in [0, 3, 7] {
        let mut host = Host::new();
        let source: Arc<str> = Arc::from("---\naliases: [One, Two]\n---\n# Draft\n[[Target]] #tag");
        let job = host.attach("buffer", 1, &source);
        for phase in 0..completed {
            host.phase(&job, phase);
        }
        host.executor
            .command(DraftCommand::Cancel {
                client: id("client"),
                job: job.clone(),
            })
            .unwrap();
        assert!(host.executor.facts(&job).is_err());
        for receipt in host.drive() {
            match receipt.completion {
                d::Completion::Stopped {
                    phases_completed,
                    usage,
                } => {
                    assert_eq!(phases_completed, completed);
                    assert_eq!(usage, zorid_document::ParseFactsUsage::default());
                }
                d::Completion::Dropped => {}
                other => panic!("cancelled portable job performed further work: {other:?}"),
            }
        }
        assert_eq!(Arc::strong_count(&source), 1);
        let after = host.executor.snapshot();
        assert_eq!(after.handles, 0);
        assert_eq!(
            after.runtime.usage,
            zorid_document::ParseFactsUsage::default()
        );
        assert!(after
            .runtime
            .outcomes
            .iter()
            .any(|outcome| outcome.job == job && outcome.kind == d::OutcomeKind::Cancelled));
    }
}

#[test]
fn portable_ready_ack_keeps_facts_charged_until_exact_actual_drop() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Ready\n[[Target]]");
    let job = host.attach("buffer", 1, &source);
    let receipts = host.drive();
    assert_eq!(receipts.len(), 7);
    assert_eq!(host.executor.facts(&job).unwrap().headings[0].text, "Ready");
    let ready = host.executor.snapshot();
    assert_eq!(
        ready.runtime.usage.source_bytes + ready.runtime.usage.scratch_bytes,
        0
    );
    assert!(ready.runtime.usage.facts_bytes > 0);
    assert_eq!(Arc::strong_count(&source), 1);
    host.executor
        .command(DraftCommand::Acknowledge {
            client: id("client"),
            job: job.clone(),
        })
        .unwrap();
    let acknowledged = host.executor.snapshot();
    assert_eq!(
        acknowledged.runtime.usage.facts_bytes,
        ready.runtime.usage.facts_bytes
    );
    assert_eq!(acknowledged.handles, 1);
    assert!(host.executor.facts(&job).is_err());
    let drops = host.drive();
    assert_eq!(drops.len(), 1);
    assert_eq!(drops[0].issued.job, job);
    assert_eq!(drops[0].issued.kind, d::Effect::DropJob);
    assert_eq!(drops[0].completion, d::Completion::Dropped);
    assert_eq!(host.executor.snapshot().handles, 0);
    assert_eq!(
        host.executor.snapshot().runtime.usage,
        zorid_document::ParseFactsUsage::default()
    );
}

#[test]
fn portable_new_revision_invalidates_ready_facts_before_old_payload_drop() {
    let mut host = Host::new();
    let old: Arc<str> = Arc::from("# Old\n[[Before]]");
    let old_job = host.attach("buffer", 1, &old);
    host.drive();
    let old_facts_bytes = host.executor.snapshot().runtime.usage.facts_bytes;
    let new: Arc<str> = Arc::from("# New\n[[After]]");
    let new_job = host.attach("buffer", 2, &new);
    assert!(host.executor.facts(&old_job).is_err());
    assert_eq!(
        host.executor.snapshot().runtime.usage.facts_bytes,
        old_facts_bytes
    );
    let receipts = host.drive();
    assert!(receipts
        .iter()
        .any(|r| r.issued.job == old_job && r.completion == d::Completion::Dropped));
    let facts = host.executor.facts(&new_job).unwrap();
    assert_eq!(facts.headings[0].text, "New");
    assert_eq!(facts.links[0].target, "After");
}

#[test]
fn portable_close_retires_both_children_and_waits_for_actual_payload_release() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Draft");
    let job = host.attach("buffer", 1, &source);
    let selected = host.next();
    host.executor
        .begin_close(&mut host.committed, &mut host.execution)
        .unwrap();
    assert!(!host.executor.close_ready(&host.committed, host.execution));
    assert!(host.executor.facts(&job).is_err());
    assert!(host
        .executor
        .command(DraftCommand::Request(request("new-buffer", 1, "x")))
        .is_err());
    assert_eq!(host.next(), selected);
    host.drive();
    assert!(host.executor.close_ready(&host.committed, host.execution));
    assert_eq!(host.executor.snapshot().handles, 0);
    assert_eq!(
        host.executor
            .next_turn(&mut host.committed, &mut host.execution)
            .unwrap()
            .state,
        w::WorkState::Quiesced
    );
    assert_eq!(Arc::strong_count(&source), 1);
}

#[test]
fn portable_committed_selection_cannot_be_executed_as_a_draft_phase() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Draft");
    let job = host.attach("buffer", 1, &source);
    let demand = host
        .committed
        .reduce(c::Input::Request(c::FreshnessRequest::new(1)))
        .unwrap();
    host.execution = demand.execution;
    let committed = host.next();
    assert!(matches!(committed.effect, w::ChildEffect::Committed(_)));
    assert_eq!(
        host.executor.admit(&committed, &host.committed).unwrap(),
        w::Admission::Execute
    );
    let before = host.executor.snapshot();
    assert!(host
        .executor
        .step_draft(&committed, &mut host.committed, &mut host.execution)
        .is_err());
    assert_unchanged(&host, &before);
    host.executor
        .settle_committed(
            &committed,
            c::EffectResult::Observed(c::Observation {
                source: SourceSnapshotId::new(id("store"), SourceWatermark::new("1").unwrap()),
                published: Some(
                    IndexSnapshotId::new(id("store"), id("epoch"), 1, versions()).unwrap(),
                ),
                current: true,
                rebuild_required: false,
                coverage_complete: Some(true),
            }),
            &mut host.committed,
            &mut host.execution,
        )
        .unwrap();
    host.phase(&job, 0);
}

#[test]
fn cancelled_or_finished_actual_parser_is_not_fabricated_as_resource_exhaustion() {
    for unexpectedly_finished in [false, true] {
        let mut host = Host::new();
        let source: Arc<str> = Arc::from("# Draft");
        let job = host.attach("buffer", 1, &source);
        let ticket = host.next();
        // Relocated native fault fixture. Disturb only the real parser while
        // leaving its core descriptor untouched; execution must fail closed.
        let parser = host
            .executor
            .jobs
            .get_mut(&job.id)
            .unwrap()
            .parser
            .as_mut()
            .unwrap();
        if unexpectedly_finished {
            for _ in 0..7 {
                parser
                    .step(ParseFactsStepBudget {
                        max_scratch_bytes: d::MAX_DRAFT_SCRATCH_BYTES,
                        max_facts_bytes: d::MAX_DRAFT_FACTS_BYTES,
                    })
                    .unwrap();
            }
        } else {
            parser.cancel();
        }
        let before = host.executor.snapshot();
        assert!(matches!(
            host.executor
                .step_draft(&ticket, &mut host.committed, &mut host.execution),
            Err(DraftExecutorError::UnexpectedParserState)
        ));
        assert_unchanged(&host, &before);
        assert!(!before.runtime.outcomes.iter().any(|outcome| matches!(
            outcome.kind,
            d::OutcomeKind::Unavailable(d::UnavailableCode::Resource)
        )));
        host.executor
            .begin_close(&mut host.committed, &mut host.execution)
            .unwrap();
        // Disposal of this deliberately inconsistent actual parser occurs on
        // owner drop; never invent a successful phase/drop counter to drain it.
    }
}

// Dedicated transient transfer coverage. The original ten executor tests above
// remain unchanged; these exercise actual payload ownership beside the parser.
struct TransferReader<'a> {
    bytes: &'a [u8],
    calls: usize,
    fail: bool,
}
impl std::io::Read for TransferReader<'_> {
    fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
        self.calls += 1;
        if self.fail {
            return Err(std::io::Error::other("fixture read failure"));
        }
        let count = target.len().min(self.bytes.len());
        target[..count].copy_from_slice(&self.bytes[..count]);
        self.bytes = &self.bytes[count..];
        Ok(count)
    }
}
struct BorrowedFactsWriter {
    expected: *const u8,
    maximum: usize,
    calls: usize,
    bytes: Vec<u8>,
}
impl std::io::Write for BorrowedFactsWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        assert_eq!(
            bytes.as_ptr(),
            self.expected,
            "writer must receive actual borrowed encoded bytes"
        );
        assert!(bytes.len() <= self.maximum);
        self.calls += 1;
        self.bytes.extend_from_slice(bytes);
        self.expected = self.expected.wrapping_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct FailingFactsWriter {
    calls: usize,
}
impl std::io::Write for FailingFactsWriter {
    fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
        self.calls += 1;
        Err(std::io::Error::other("fixture write failure"))
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn uploaded(host: &mut Host, buffer: &str, source: &str) -> d::JobToken {
    let job = host.reserve(request(buffer, 1, source));
    host.executor.begin_source_upload(&job).unwrap();
    for (index, chunk) in source
        .as_bytes()
        .chunks(MAX_DRAFT_TRANSFER_CHUNK_BYTES)
        .enumerate()
    {
        host.executor
            .append_source_upload(&job, index * MAX_DRAFT_TRANSFER_CHUNK_BYTES, chunk)
            .unwrap();
    }
    host.executor.seal_source_upload(&job).unwrap();
    job
}

#[test]
fn raw_upload_accepts_split_utf8_scalars_and_replays_exact_contained_chunks() {
    let mut host = Host::new();
    let source = format!(
        "{}😀\r\n# Heading",
        "x".repeat(MAX_DRAFT_TRANSFER_CHUNK_BYTES - 1)
    );
    let job = host.reserve(request("buffer", 1, &source));
    let initial = host.executor.begin_source_upload(&job).unwrap();
    assert_eq!(initial.source_bytes_received, 0);
    assert_eq!(initial.source_bytes_expected, source.len());
    assert!(!initial.source_sealed);
    let first = &source.as_bytes()[..MAX_DRAFT_TRANSFER_CHUNK_BYTES];
    assert!(std::str::from_utf8(first).is_err());
    let part = host.executor.append_source_upload(&job, 0, first).unwrap();
    let replay = host.executor.append_source_upload(&job, 0, first).unwrap();
    assert_eq!(part, replay);
    host.executor
        .append_source_upload(&job, first.len(), &source.as_bytes()[first.len()..])
        .unwrap();
    assert!(host.executor.snapshot().runtime.in_flight.is_none());
    host.executor.seal_source_upload(&job).unwrap();
    let sealed = host.executor.transfer_progress(&job).unwrap();
    assert!(sealed.source_sealed);
    assert_eq!(sealed.source_bytes_received, source.len());
    assert_eq!(sealed.scratch_bytes, 0);
    host.drive();
    assert_eq!(
        host.executor.facts(&job).unwrap().source_length.utf16 as usize,
        source.encode_utf16().count()
    );
    assert_eq!(
        host.executor.facts(&job).unwrap().headings[0].text,
        "Heading"
    );
}

#[test]
fn upload_rejects_gaps_overlap_wrong_replay_and_oversized_chunks_before_growth() {
    let mut host = Host::new();
    let job = host.reserve(request("buffer", 1, "abcdef"));
    host.executor.begin_source_upload(&job).unwrap();
    host.executor.append_source_upload(&job, 0, b"abc").unwrap();
    let before = host.executor.snapshot();
    let progress = host.executor.transfer_progress(&job).unwrap();
    for (offset, bytes) in [
        (4, &b"d"[..]),
        (2, &b"cd"[..]),
        (0, &b"abd"[..]),
        (3, &b"defg"[..]),
        (3, &b""[..]),
    ] {
        assert!(host
            .executor
            .append_source_upload(&job, offset, bytes)
            .is_err());
        assert_eq!(host.executor.transfer_progress(&job).unwrap(), progress);
        assert_eq!(host.executor.snapshot(), before);
    }
    let oversized = vec![b'x'; MAX_DRAFT_TRANSFER_CHUNK_BYTES + 1];
    assert!(matches!(
        host.executor.append_source_upload(&job, 3, &oversized),
        Err(DraftExecutorError::Transfer(
            DraftTransferError::InvalidChunk
        ))
    ));
    assert_eq!(host.executor.snapshot(), before);
}

#[test]
fn raw_reader_failures_preserve_offset_and_invalid_ranges_never_read_or_allocate() {
    let mut host = Host::new();
    let job = host.reserve(request("buffer", 1, "abcdef"));
    host.executor.begin_source_upload(&job).unwrap();
    let mut failed = TransferReader {
        bytes: b"abcd",
        calls: 0,
        fail: true,
    };
    assert!(matches!(
        host.executor
            .read_source_upload_chunk(&job, 0, 4, &mut failed),
        Err(DraftExecutorError::Transfer(DraftTransferError::Read(_)))
    ));
    assert_eq!(failed.calls, 1);
    let after_failure = host.executor.transfer_progress(&job).unwrap();
    assert_eq!(after_failure.source_bytes_received, 0);
    assert!(after_failure.scratch_bytes >= 4);
    let mut reader = TransferReader {
        bytes: b"abcd",
        calls: 0,
        fail: false,
    };
    let read = host
        .executor
        .read_source_upload_chunk(&job, 0, 4, &mut reader)
        .unwrap();
    assert_eq!(read.source_bytes_received, 4);
    let before = host.executor.snapshot();
    for (offset, length) in [
        (3, 2),
        (5, 1),
        (4, MAX_DRAFT_TRANSFER_CHUNK_BYTES + 1),
        (4, 0),
    ] {
        let mut untouched = TransferReader {
            bytes: b"ef",
            calls: 0,
            fail: false,
        };
        assert!(host
            .executor
            .read_source_upload_chunk(&job, offset, length, &mut untouched)
            .is_err());
        assert_eq!(untouched.calls, 0);
        assert_eq!(host.executor.snapshot(), before);
        assert_eq!(host.executor.transfer_progress(&job).unwrap(), read);
    }
}

#[test]
fn incomplete_seal_cannot_parse_or_release_reserved_input() {
    let mut host = Host::new();
    let job = host.reserve(request("buffer", 1, "abcdef"));
    host.executor.begin_source_upload(&job).unwrap();
    host.executor.append_source_upload(&job, 0, b"abc").unwrap();
    let before = host.executor.snapshot();
    assert!(matches!(
        host.executor.seal_source_upload(&job),
        Err(DraftExecutorError::Transfer(DraftTransferError::Incomplete))
    ));
    assert_eq!(host.executor.snapshot(), before);
    assert_eq!(before.runtime.usage.source_bytes, 6);
    assert!(before.runtime.in_flight.is_none());
    assert!(!host.executor.transfer_progress(&job).unwrap().source_sealed);
}

#[test]
fn bad_fingerprint_or_utf8_seal_preserves_actual_upload_and_reservation_until_drop() {
    for invalid_utf8 in [false, true] {
        let mut host = Host::new();
        let job = host.reserve(request("buffer", 1, "abcd"));
        host.executor.begin_source_upload(&job).unwrap();
        let bytes: &[u8] = if invalid_utf8 {
            &[0xff, b'b', b'c', b'd']
        } else {
            b"abce"
        };
        host.executor.append_source_upload(&job, 0, bytes).unwrap();
        let before = host.executor.snapshot();
        let progress = host.executor.transfer_progress(&job).unwrap();
        assert!(matches!(
            host.executor.seal_source_upload(&job),
            Err(DraftExecutorError::SourceMismatch)
        ));
        assert_eq!(host.executor.snapshot(), before);
        assert_eq!(host.executor.transfer_progress(&job).unwrap(), progress);
        assert_eq!(before.runtime.usage.source_bytes, 4);
        assert!(before.runtime.in_flight.is_none());
        assert!(host.executor.facts(&job).is_err());
        host.executor
            .command(DraftCommand::Cancel {
                client: id("client"),
                job: job.clone(),
            })
            .unwrap();
        host.drive();
        assert_eq!(host.executor.snapshot().handles, 0);
        assert_eq!(host.executor.snapshot().transfer_scratch_bytes, 0);
        assert_eq!(host.executor.snapshot().runtime.usage.source_bytes, 0);
    }
}

#[test]
fn seal_replay_preserves_real_parser_progress_and_disposes_raw_frame_storage() {
    let mut host = Host::new();
    let source = "# Draft 😀";
    let job = host.reserve(request("buffer", 1, source));
    host.executor.begin_source_upload(&job).unwrap();
    let mut reader = TransferReader {
        bytes: source.as_bytes(),
        calls: 0,
        fail: false,
    };
    host.executor
        .read_source_upload_chunk(&job, 0, source.len(), &mut reader)
        .unwrap();
    assert!(host.executor.transfer_progress(&job).unwrap().scratch_bytes >= source.len());
    host.executor.seal_source_upload(&job).unwrap();
    assert_eq!(host.executor.snapshot().transfer_scratch_bytes, 0);
    host.phase(&job, 0);
    let before = host.executor.snapshot();
    let replay = host.executor.seal_source_upload(&job).unwrap();
    assert!(replay.replay);
    assert_eq!(host.executor.snapshot(), before);
    assert!(host.executor.transfer_progress(&job).unwrap().source_sealed);
    host.phase(&job, 1);
}

#[test]
fn facts_encoding_replay_is_retained_once_and_writer_receives_bounded_borrowed_slices() {
    let mut host = Host::new();
    let job = uploaded(&mut host, "buffer", "# Ready 😀\n[[Target]] #tag");
    host.drive();
    let prepared = host.executor.prepare_facts_bytes(&job).unwrap();
    let length = prepared.facts_bytes.unwrap();
    assert!(length > 0);
    let storage = host.executor.jobs[&job.id].encoded_facts.as_ref().unwrap();
    let pointer = storage.as_ptr();
    let capacity = storage.capacity();
    let before = host.executor.snapshot();
    assert_eq!(host.executor.prepare_facts_bytes(&job).unwrap(), prepared);
    let replayed_storage = host.executor.jobs[&job.id].encoded_facts.as_ref().unwrap();
    assert_eq!(replayed_storage.as_ptr(), pointer);
    assert_eq!(replayed_storage.capacity(), capacity);
    let mut writer = BorrowedFactsWriter {
        expected: pointer,
        maximum: 17,
        calls: 0,
        bytes: Vec::new(),
    };
    let mut offset = 0;
    while offset < length {
        let count = host
            .executor
            .write_facts_bytes(&job, offset, 17, &mut writer)
            .unwrap();
        assert_eq!(count, (length - offset).min(17));
        offset += count;
    }
    assert!(writer.calls > 1);
    assert_eq!(
        serde_json::from_slice::<zorid_document::ParseFacts>(&writer.bytes).unwrap(),
        *host.executor.facts(&job).unwrap()
    );
    assert_eq!(host.executor.snapshot(), before);
}

#[test]
fn bounded_facts_writer_failure_is_io_and_invalid_requests_do_not_call_writer() {
    let mut host = Host::new();
    let job = uploaded(&mut host, "buffer", "# Ready");
    host.drive();
    let prepared = host.executor.prepare_facts_bytes(&job).unwrap();
    let before = host.executor.snapshot();
    let mut writer = FailingFactsWriter { calls: 0 };
    assert!(matches!(
        host.executor.write_facts_bytes(&job, 0, 17, &mut writer),
        Err(DraftExecutorError::Transfer(DraftTransferError::Write(_)))
    ));
    assert_eq!(writer.calls, 1);
    for (offset, maximum) in [
        (prepared.facts_bytes.unwrap() + 1, 17),
        (0, 0),
        (0, MAX_DRAFT_TRANSFER_CHUNK_BYTES + 1),
    ] {
        assert!(host
            .executor
            .write_facts_bytes(&job, offset, maximum, &mut writer)
            .is_err());
        assert_eq!(writer.calls, 1);
    }
    assert_eq!(host.executor.transfer_progress(&job).unwrap(), prepared);
    assert_eq!(host.executor.snapshot(), before);
    assert_eq!(host.executor.facts(&job).unwrap().headings[0].text, "Ready");
}

#[test]
fn ack_or_supersession_fences_encoded_reads_before_actual_bytes_are_dropped() {
    for supersede in [false, true] {
        let mut host = Host::new();
        let old = uploaded(&mut host, "buffer", "# Old");
        host.drive();
        let prepared = host.executor.prepare_facts_bytes(&old).unwrap();
        assert!(prepared.facts_bytes.unwrap() > 0);
        if supersede {
            let source: Arc<str> = Arc::from("# New");
            host.attach("buffer", 2, &source);
        } else {
            host.executor
                .command(DraftCommand::Acknowledge {
                    client: id("client"),
                    job: old.clone(),
                })
                .unwrap();
        }
        // Actual encoding remains charged until the selected Drop runs, while
        // ownership/current-revision checks already forbid stale byte access.
        assert_eq!(
            host.executor.transfer_progress(&old).unwrap().facts_bytes,
            prepared.facts_bytes
        );
        let mut writer = FailingFactsWriter { calls: 0 };
        assert!(host
            .executor
            .write_facts_bytes(&old, 0, 17, &mut writer)
            .is_err());
        assert_eq!(writer.calls, 0);
        host.drive();
        assert!(!host.executor.jobs.contains_key(&old.id));
        assert_eq!(host.executor.snapshot().transfer_scratch_bytes, 0);
    }
}

#[test]
fn actual_transfer_saturation_tightens_issued_parser_budget_and_encoding_headroom() {
    let mut host = Host::new();
    let ready_job = uploaded(&mut host, "ready", "# Ready");
    host.drive();
    let source: Arc<str> = Arc::from("# Pending");
    let pending = host.attach("pending", 1, &source);
    let ticket = host.next();
    // One actual-capacity fault fixture fills the same shared scratch pool;
    // the already-issued phase must run with newly tightened headroom.
    host.executor.jobs.get_mut(&pending.id).unwrap().ingress =
        Vec::with_capacity(d::MAX_DRAFT_SCRATCH_BYTES);
    assert_eq!(
        host.executor.snapshot().transfer_scratch_bytes,
        d::MAX_DRAFT_SCRATCH_BYTES
    );
    assert!(matches!(
        host.executor.prepare_facts_bytes(&ready_job),
        Err(DraftExecutorError::Transfer(DraftTransferError::Resource))
    ));
    assert!(host
        .executor
        .transfer_progress(&ready_job)
        .unwrap()
        .facts_bytes
        .is_none());
    assert_eq!(
        host.executor.facts(&ready_job).unwrap().headings[0].text,
        "Ready"
    );
    let resource = host.step(&ticket);
    assert!(
        matches!(resource.completion, d::Completion::Resource { usage, phases_completed: 0 } if usage == zorid_document::ParseFactsUsage::default())
    );
    assert_eq!(Arc::strong_count(&source), 1);
    assert_eq!(
        host.executor.snapshot().transfer_scratch_bytes,
        d::MAX_DRAFT_SCRATCH_BYTES
    );
    let drop_ticket = host.next();
    let dropped = host.step(&drop_ticket);
    assert_eq!(dropped.issued.job, pending);
    assert_eq!(dropped.completion, d::Completion::Dropped);
    assert_eq!(host.executor.snapshot().transfer_scratch_bytes, 0);
    assert!(host
        .executor
        .prepare_facts_bytes(&ready_job)
        .unwrap()
        .facts_bytes
        .is_some());
}

#[test]
fn owner_release_disposes_upload_ingress_and_encoding_only_via_actual_drop() {
    let mut host = Host::new();
    let ready_job = uploaded(&mut host, "ready", "# Ready");
    host.drive();
    host.executor.prepare_facts_bytes(&ready_job).unwrap();
    let pending = host.reserve(request("pending", 1, "abcdefghij"));
    host.executor.begin_source_upload(&pending).unwrap();
    let mut reader = TransferReader {
        bytes: b"abcd",
        calls: 0,
        fail: false,
    };
    host.executor
        .read_source_upload_chunk(&pending, 0, 4, &mut reader)
        .unwrap();
    let retained = host.executor.snapshot().transfer_scratch_bytes;
    assert!(retained > 4);
    host.executor
        .command(DraftCommand::ReleaseClient(id("client")))
        .unwrap();
    assert_eq!(host.executor.snapshot().transfer_scratch_bytes, retained);
    let mut writer = FailingFactsWriter { calls: 0 };
    assert!(host
        .executor
        .write_facts_bytes(&ready_job, 0, 17, &mut writer)
        .is_err());
    let mut unread = TransferReader {
        bytes: b"ef",
        calls: 0,
        fail: false,
    };
    assert!(host
        .executor
        .read_source_upload_chunk(&pending, 4, 2, &mut unread)
        .is_err());
    assert_eq!(writer.calls + unread.calls, 0);
    let drops = host.drive();
    assert_eq!(drops.len(), 2);
    assert!(drops
        .iter()
        .all(|record| record.completion == d::Completion::Dropped));
    let released = host.executor.snapshot();
    assert_eq!(released.handles, 0);
    assert_eq!(released.transfer_scratch_bytes, 0);
    assert_eq!(
        released.runtime.usage,
        zorid_document::ParseFactsUsage::default()
    );
}

#[test]
fn direct_arc_attachment_replaces_partial_upload_and_releases_raw_capacity() {
    let mut host = Host::new();
    let source: Arc<str> = Arc::from("# Complete 😀");
    let job = host.reserve(request("buffer", 1, &source));
    host.executor.begin_source_upload(&job).unwrap();
    let mut reader = TransferReader {
        bytes: &source.as_bytes()[..3],
        calls: 0,
        fail: false,
    };
    host.executor
        .read_source_upload_chunk(&job, 0, 3, &mut reader)
        .unwrap();
    assert!(host.executor.transfer_progress(&job).unwrap().scratch_bytes >= 3);
    host.executor
        .attach_source(&job, Arc::clone(&source))
        .unwrap();
    let attached = host.executor.transfer_progress(&job).unwrap();
    assert!(attached.source_sealed);
    assert_eq!(attached.source_bytes_received, source.len());
    assert_eq!(attached.scratch_bytes, 0);
    assert_eq!(host.executor.snapshot().transfer_scratch_bytes, 0);
    assert_eq!(Arc::strong_count(&source), 2);
    host.phase(&job, 0);
}

#[test]
fn current_job_policy_fences_hidden_acknowledged_uploads_before_late_io() {
    let mut host = Host::new();
    let job = host.reserve(request("buffer", 1, "abcdefgh"));
    assert!(host.executor.core.job_is_current(&job).unwrap());
    let mut forged_tag = job.clone();
    forged_tag.tag.text_revision += 1;
    assert!(host.executor.core.job_is_current(&forged_tag).is_err());
    let mut forged_lifetime = job.clone();
    forged_lifetime.lifetime = id("foreign-draft");
    assert!(host.executor.core.job_is_current(&forged_lifetime).is_err());
    host.executor.begin_source_upload(&job).unwrap();
    let mut reader = TransferReader {
        bytes: b"abcd",
        calls: 0,
        fail: false,
    };
    host.executor
        .read_source_upload_chunk(&job, 0, 4, &mut reader)
        .unwrap();
    let actual_transfer_capacity: usize = host
        .executor
        .jobs
        .values()
        .map(|owned| {
            owned.upload.as_ref().map_or(0, |bytes| {
                bytes.capacity().saturating_sub(owned.source.bytes)
            }) + owned.ingress.capacity()
                + owned.encoded_facts.as_ref().map_or(0, Vec::capacity)
        })
        .sum();
    assert_eq!(
        host.executor.snapshot().transfer_scratch_bytes,
        actual_transfer_capacity
    );
    host.executor
        .command(DraftCommand::Cancel {
            client: id("client"),
            job: job.clone(),
        })
        .unwrap();
    host.executor
        .command(DraftCommand::Acknowledge {
            client: id("client"),
            job: job.clone(),
        })
        .unwrap();
    assert!(!host.executor.core.job_is_current(&job).unwrap());
    let before = host.executor.snapshot();
    assert!(
        before.runtime.outcomes.is_empty(),
        "ACK hides the outcome before actual Drop"
    );
    assert_eq!(before.runtime.usage.source_bytes, 8);
    assert!(
        host.executor
            .transfer_progress(&job)
            .unwrap()
            .source_bytes_received
            > 0
    );
    assert!(host.executor.begin_source_upload(&job).is_err());
    let mut unread = TransferReader {
        bytes: b"ef",
        calls: 0,
        fail: false,
    };
    assert!(host
        .executor
        .read_source_upload_chunk(&job, 4, 2, &mut unread)
        .is_err());
    assert_eq!(unread.calls, 0);
    assert_eq!(host.executor.snapshot(), before);
    host.drive();
    assert!(matches!(
        host.executor.core.job_is_current(&job),
        Err(d::RuntimeError::Expired)
    ));
    assert_eq!(host.executor.snapshot().handles, 0);
    assert_eq!(host.executor.snapshot().transfer_scratch_bytes, 0);
}
