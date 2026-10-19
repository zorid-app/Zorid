//! Portable actual draft parser ownership and committed/draft execution gate.
//!
//! Hosts retain committed IO and its receipt. This owner retains the actual
//! source/parser/facts and one draft receipt, and settles each selected effect
//! exactly once through the existing arbiter. Call next_turn only after reentering
//! the host operation queue. Arc attachment does not account for earlier copies.
use crate::{document_runtime as c, document_work_runtime as w, draft_runtime as d};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::sync::Arc;
use zorid_core::OperationId;
use zorid_document::{ParseFacts, ParseFactsJob, ParseFactsJobError};

#[derive(Clone, Debug)]
pub enum DraftCommand {
    Request(d::DraftRequest),
    Cancel {
        client: OperationId,
        job: d::JobToken,
    },
    Acknowledge {
        client: OperationId,
        job: d::JobToken,
    },
    ReleaseBuffer(d::BufferKey),
    ReleaseClient(OperationId),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftSnapshot {
    pub runtime: d::Reduction,
    pub work: w::Snapshot,
    pub handles: usize,
    /// Actual transfer capacities in addition to runtime parser scratch.
    pub transfer_scratch_bytes: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftStepRecord {
    pub issued: d::IssuedEffect,
    pub completion: d::Completion,
    pub reduction: d::Reduction,
}
#[derive(Debug)]
pub enum DraftExecutorError {
    Draft(d::RuntimeError),
    Work(w::WorkError),
    Transfer(DraftTransferError),
    SourceMismatch,
    Expired,
    NotReady,
    Closed,
    UnexpectedParserState,
}
impl std::fmt::Display for DraftExecutorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DraftExecutorError {}
impl From<d::RuntimeError> for DraftExecutorError {
    fn from(error: d::RuntimeError) -> Self {
        Self::Draft(error)
    }
}
impl From<w::WorkError> for DraftExecutorError {
    fn from(error: w::WorkError) -> Self {
        Self::Work(error)
    }
}
/// Dedicated data-plane chunks never enlarge the 64 KiB control limit.
pub const MAX_DRAFT_TRANSFER_CHUNK_BYTES: usize = 128 * 1024;
/// The existing encoded facts ceiling, distinct from retained facts capacities.
pub const MAX_DRAFT_ENCODED_FACTS_BYTES: usize = 64 * 1024 * 1024;
#[derive(Debug)]
pub enum DraftTransferError {
    Resource,
    InvalidOffset,
    InvalidChunk,
    Incomplete,
    Read(io::Error),
    Write(io::Error),
    Encoding(serde_json::Error),
}
impl std::fmt::Display for DraftTransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DraftTransferError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(error) | Self::Write(error) => Some(error),
            Self::Encoding(error) => Some(error),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftTransferProgress {
    pub source_bytes_received: usize,
    pub source_bytes_expected: usize,
    pub source_sealed: bool,
    pub facts_bytes: Option<usize>,
    pub scratch_bytes: usize,
}
impl From<DraftTransferError> for DraftExecutorError {
    fn from(error: DraftTransferError) -> Self {
        Self::Transfer(error)
    }
}
struct OwnedJob {
    token: d::JobToken,
    source: d::SourceDescriptor,
    parser: Option<ParseFactsJob>,
    // Moved out of the Ready parser, never cloned into a receipt or snapshot.
    // The core's pre-transfer phase usage stays charged until actual Drop.
    facts: Option<ParseFacts>,
    upload: Option<Vec<u8>>,
    // Raw input frame bytes are also owner-owned; no separate host buffer pool.
    ingress: Vec<u8>,
    encoded_facts: Option<Vec<u8>>,
}
impl OwnedJob {
    fn transfer_scratch_bytes(&self) -> usize {
        self.upload.as_ref().map_or(0, |bytes| {
            bytes.capacity().saturating_sub(self.source.bytes)
        }) + self.ingress.capacity()
            + self.encoded_facts.as_ref().map_or(0, Vec::capacity)
    }
}
pub struct DocumentDraftExecutor {
    core: d::DraftRuntime,
    work: w::DocumentWorkRuntime,
    jobs: BTreeMap<u64, OwnedJob>,
    // One bounded actual draft receipt; no source or facts payload.
    last_step: Option<DraftStepRecord>,
}
impl DocumentDraftExecutor {
    pub fn new(draft_lifetime: OperationId, work_incarnation: OperationId) -> Self {
        Self {
            core: d::DraftRuntime::new(draft_lifetime),
            work: w::DocumentWorkRuntime::new(work_incarnation),
            jobs: BTreeMap::new(),
            last_step: None,
        }
    }
    /// Reserve canonical input before retention; commands do not run parser phases.
    pub fn command(&mut self, command: DraftCommand) -> Result<d::Reduction, DraftExecutorError> {
        let owner = self;
        if matches!(&command, DraftCommand::Request(_)) && owner.work.snapshot().closing {
            return Err(DraftExecutorError::Closed);
        }
        let request = match &command {
            DraftCommand::Request(request) => Some(request.clone()),
            _ => None,
        };
        let input = match command {
            DraftCommand::Request(request) => d::Input::Request(request),
            DraftCommand::Cancel { client, job } => d::Input::Cancel { client, job },
            DraftCommand::Acknowledge { client, job } => d::Input::Acknowledge { client, job },
            DraftCommand::ReleaseBuffer(buffer) => d::Input::ReleaseBuffer(buffer),
            DraftCommand::ReleaseClient(client) => d::Input::ReleaseClient(client),
        };
        let result = owner.core.reduce(input)?;
        if let Some(request) = request {
            let token = result.admitted.as_ref().expect("request admitted");
            // Exact same-revision replay reuses the actual parser/Arc/facts.
            // Do not recreate an empty job after its actual payload was dropped.
            if !result.replay {
                owner.jobs.insert(
                    token.id,
                    OwnedJob {
                        token: token.clone(),
                        source: request.source,
                        parser: None,
                        facts: None,
                        upload: None,
                        ingress: Vec::new(),
                        encoded_facts: None,
                    },
                );
            }
        }
        Ok(result)
    }
    /// Move a previously reserved immutable source into its one actual parser.
    /// UTF-16 length and SHA checks are bounded source scans; earlier conversion
    /// and caller allocations remain a separate adapter responsibility.
    pub fn attach_source(
        &mut self,
        token: &d::JobToken,
        source: Arc<str>,
    ) -> Result<d::Reduction, DraftExecutorError> {
        let owner = self;
        if owner.work.snapshot().closing {
            return Err(DraftExecutorError::Closed);
        }
        let owned = owner
            .jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .ok_or(DraftExecutorError::Expired)?;
        if source.len() != owned.source.bytes
            || source.len() > d::MAX_DRAFT_SOURCE_BYTES
            || source.encode_utf16().count() != owned.source.utf16
            || <[u8; 32]>::from(Sha256::digest(source.as_bytes())) != owned.source.sha256
        {
            return Err(DraftExecutorError::SourceMismatch);
        }
        if owned.parser.is_some() {
            // Replay validates the actual source but never replaces the real
            // parser, resets its counter, or adds another retained source Arc.
            return Ok(owner.core.reduce(d::Input::Seal {
                job: token.clone(),
                actual: owned.source.clone(),
            })?);
        }
        if owned.upload.is_some() {
            let overlap = source
                .len()
                .checked_add(3 * std::mem::size_of::<usize>())
                .ok_or(DraftTransferError::Resource)?;
            if overlap > owner.scratch_headroom()? {
                return Err(DraftTransferError::Resource.into());
            }
        }
        owner.attach_checked_source(token, source)
    }
    // Both callers already validated the source once. Keep upload validation
    // before Arc conversion without rescanning the complete source afterward.
    fn attach_checked_source(
        &mut self,
        token: &d::JobToken,
        source: Arc<str>,
    ) -> Result<d::Reduction, DraftExecutorError> {
        let actual = self.jobs[&token.id].source.clone();
        let parser = ParseFactsJob::new(source).map_err(|_| DraftExecutorError::SourceMismatch)?;
        let result = self.core.reduce(d::Input::Seal {
            job: token.clone(),
            actual,
        })?;
        let owned = self.jobs.get_mut(&token.id).unwrap();
        owned.parser = Some(parser);
        // Disposal precedes releasing the overlapping conversion charge.
        owned.upload = None;
        owned.ingress = Vec::new();
        Ok(result)
    }
    /// Borrow exact current unacknowledged Ready facts without copying them.
    pub fn facts(&self, token: &d::JobToken) -> Result<&ParseFacts, DraftExecutorError> {
        let owner = self;
        if owner.work.snapshot().closing {
            return Err(DraftExecutorError::Closed);
        }
        let current = owner
            .core
            .snapshot()
            .outcomes
            .iter()
            .any(|outcome| outcome.job == *token && outcome.kind == d::OutcomeKind::Ready);
        if !current {
            return Err(DraftExecutorError::NotReady);
        }
        owner
            .jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .and_then(|job| job.facts.as_ref())
            .ok_or(DraftExecutorError::Expired)
    }

    fn transfer_scratch_bytes(&self) -> usize {
        self.jobs
            .values()
            .map(OwnedJob::transfer_scratch_bytes)
            .sum()
    }
    fn scratch_headroom(&self) -> Result<usize, DraftExecutorError> {
        d::MAX_DRAFT_SCRATCH_BYTES
            .checked_sub(self.core.usage().scratch_bytes)
            .and_then(|headroom| headroom.checked_sub(self.transfer_scratch_bytes()))
            .ok_or_else(|| DraftTransferError::Resource.into())
    }
    fn current_input(&self, token: &d::JobToken) -> Result<&OwnedJob, DraftExecutorError> {
        if self.work.snapshot().closing {
            return Err(DraftExecutorError::Closed);
        }
        if !self.core.job_is_current(token)? {
            return Err(DraftExecutorError::Expired);
        }
        self.jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .ok_or(DraftExecutorError::Expired)
    }
    /// Metadata only. Returned sizes never authorize a different job or buffer.
    pub fn transfer_progress(
        &self,
        token: &d::JobToken,
    ) -> Result<DraftTransferProgress, DraftExecutorError> {
        let job = self
            .jobs
            .get(&token.id)
            .filter(|job| job.token == *token)
            .ok_or(DraftExecutorError::Expired)?;
        Ok(DraftTransferProgress {
            source_bytes_received: job.upload.as_ref().map_or_else(
                || {
                    if job.parser.is_some() {
                        job.source.bytes
                    } else {
                        0
                    }
                },
                Vec::len,
            ),
            source_bytes_expected: job.source.bytes,
            source_sealed: job.parser.is_some(),
            facts_bytes: job.encoded_facts.as_ref().map(Vec::len),
            scratch_bytes: job.transfer_scratch_bytes(),
        })
    }
    /// Canonical input was reserved by Request. Extra allocator capacity is
    /// reconciled against scratch before retaining the actual upload buffer.
    pub fn begin_source_upload(
        &mut self,
        token: &d::JobToken,
    ) -> Result<DraftTransferProgress, DraftExecutorError> {
        let job = self.current_input(token)?;
        if job.upload.is_some() || job.parser.is_some() {
            return self.transfer_progress(token);
        }
        let expected = job.source.bytes;
        let headroom = self.scratch_headroom()?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(expected)
            .map_err(|_| DraftTransferError::Resource)?;
        if bytes.capacity().saturating_sub(expected) > headroom {
            return Err(DraftTransferError::Resource.into());
        }
        self.jobs.get_mut(&token.id).unwrap().upload = Some(bytes);
        self.transfer_progress(token)
    }
    /// Borrowed caller bytes must already be accounted by the platform before
    /// conversion. Native framed IO should use read_source_upload_chunk instead.
    pub fn append_source_upload(
        &mut self,
        token: &d::JobToken,
        offset: usize,
        bytes: &[u8],
    ) -> Result<DraftTransferProgress, DraftExecutorError> {
        let job = self.current_input(token)?;
        validate_chunk(job, offset, bytes.len())?;
        let upload = job.upload.as_ref().ok_or(DraftTransferError::Incomplete)?;
        let end = offset + bytes.len();
        if offset < upload.len() {
            if end > upload.len() || upload[offset..end] != *bytes {
                return Err(DraftTransferError::InvalidOffset.into());
            }
            return self.transfer_progress(token);
        }
        // begin_source_upload preallocates the complete reserved source. No
        // growth or temporary source copy is allowed during append.
        if upload.capacity() < end {
            return Err(DraftTransferError::Resource.into());
        }
        self.jobs
            .get_mut(&token.id)
            .unwrap()
            .upload
            .as_mut()
            .unwrap()
            .extend_from_slice(bytes);
        self.transfer_progress(token)
    }
    /// Read one length-delimited raw frame into owner-owned scratch. The caller
    /// must check the frame length before this call and must not decode a second
    /// payload Vec. A failed read leaves upload offset unchanged.
    pub fn read_source_upload_chunk(
        &mut self,
        token: &d::JobToken,
        offset: usize,
        length: usize,
        reader: &mut impl Read,
    ) -> Result<DraftTransferProgress, DraftExecutorError> {
        let job = self.current_input(token)?;
        validate_chunk(job, offset, length)?;
        if job.upload.is_none() {
            return Err(DraftTransferError::Incomplete.into());
        }
        let headroom = self.scratch_headroom()?;
        if job.ingress.capacity() < length {
            // Allocate the replacement while the old frame remains charged.
            if length > headroom {
                return Err(DraftTransferError::Resource.into());
            }
            let mut frame = Vec::new();
            frame
                .try_reserve_exact(length)
                .map_err(|_| DraftTransferError::Resource)?;
            if frame.capacity() > headroom {
                return Err(DraftTransferError::Resource.into());
            }
            self.jobs.get_mut(&token.id).unwrap().ingress = frame;
        }
        let job = self.jobs.get_mut(&token.id).unwrap();
        job.ingress.resize(length, 0);
        reader
            .read_exact(&mut job.ingress)
            .map_err(DraftTransferError::Read)?;
        let upload = job.upload.as_mut().unwrap();
        let end = offset + length;
        if offset < upload.len() {
            if end > upload.len() || upload[offset..end] != job.ingress[..] {
                return Err(DraftTransferError::InvalidOffset.into());
            }
        } else {
            if upload.capacity() < end {
                return Err(DraftTransferError::Resource.into());
            }
            upload.extend_from_slice(&job.ingress);
        }
        self.transfer_progress(token)
    }
    /// Reserve conversion overlap before allocating Arc source; successful seal
    /// actually disposes upload/frame bytes before releasing their charges.
    pub fn seal_source_upload(
        &mut self,
        token: &d::JobToken,
    ) -> Result<d::Reduction, DraftExecutorError> {
        let job = self.current_input(token)?;
        if job.parser.is_some() {
            let actual = job.source.clone();
            return Ok(self.core.reduce(d::Input::Seal {
                job: token.clone(),
                actual,
            })?);
        }
        let bytes = job.upload.as_ref().ok_or(DraftTransferError::Incomplete)?;
        if bytes.len() != job.source.bytes {
            return Err(DraftTransferError::Incomplete.into());
        }
        let text = std::str::from_utf8(bytes).map_err(|_| DraftExecutorError::SourceMismatch)?;
        if text.encode_utf16().count() != job.source.utf16
            || <[u8; 32]>::from(Sha256::digest(bytes)) != job.source.sha256
        {
            return Err(DraftExecutorError::SourceMismatch);
        }
        // Include Arc counters and alignment in the overlap allowance. The
        // canonical input reservation continues covering the upload allocation.
        let overlap = bytes
            .len()
            .checked_add(3 * std::mem::size_of::<usize>())
            .ok_or(DraftTransferError::Resource)?;
        if overlap > self.scratch_headroom()? {
            return Err(DraftTransferError::Resource.into());
        }
        let source: Arc<str> = Arc::from(text);
        self.attach_checked_source(token, source)
    }
    /// Stream facts into one bounded owner-owned encoding. Allocation refusal
    /// preserves valid Ready facts; no partial result is published or retained.
    pub fn prepare_facts_bytes(
        &mut self,
        token: &d::JobToken,
    ) -> Result<DraftTransferProgress, DraftExecutorError> {
        self.facts(token)?;
        if self.jobs[&token.id].encoded_facts.is_some() {
            return self.transfer_progress(token);
        }
        let headroom = self.scratch_headroom()?;
        let facts = self.facts(token)?;
        let mut writer = FactsWriter {
            bytes: Vec::new(),
            headroom,
            resource: false,
        };
        if let Err(error) = serde_json::to_writer(&mut writer, facts) {
            return Err(if writer.resource {
                DraftTransferError::Resource
            } else {
                DraftTransferError::Encoding(error)
            }
            .into());
        }
        self.jobs.get_mut(&token.id).unwrap().encoded_facts = Some(writer.bytes);
        self.transfer_progress(token)
    }
    /// Write a bounded borrowed slice synchronously. The writer must not retain
    /// or clone payload bytes. This borrow prevents ACK/Drop until IO returns.
    pub fn write_facts_bytes(
        &self,
        token: &d::JobToken,
        offset: usize,
        maximum: usize,
        writer: &mut impl Write,
    ) -> Result<usize, DraftExecutorError> {
        self.facts(token)?;
        if maximum == 0 || maximum > MAX_DRAFT_TRANSFER_CHUNK_BYTES {
            return Err(DraftTransferError::InvalidChunk.into());
        }
        let bytes = self.jobs[&token.id]
            .encoded_facts
            .as_ref()
            .ok_or(DraftTransferError::Incomplete)?;
        if offset > bytes.len() {
            return Err(DraftTransferError::InvalidOffset.into());
        }
        let end = offset.saturating_add(maximum).min(bytes.len());
        writer
            .write_all(&bytes[offset..end])
            .map_err(DraftTransferError::Write)?;
        Ok(end - offset)
    }
    pub fn snapshot(&self) -> DraftSnapshot {
        DraftSnapshot {
            runtime: self.core.snapshot(),
            work: self.work.snapshot(),
            handles: self.jobs.len(),
            transfer_scratch_bytes: self.transfer_scratch_bytes(),
        }
    }
    /// Actual registry ownership, including ACK-hidden jobs awaiting real Drop.
    /// This is disposal evidence only; trusted hosts still settle accepted work
    /// and require whole-owner close readiness for the last lease.
    pub fn client_has_jobs(&self, client: &OperationId) -> bool {
        self.jobs
            .values()
            .any(|job| job.token.tag.buffer.client == *client)
    }
    pub fn work_snapshot(&self) -> w::Snapshot {
        self.work.snapshot()
    }
    /// One newly admitted host turn; deliver returned Continue outcomes.
    pub fn next_turn(
        &mut self,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<w::Turn, DraftExecutorError> {
        Ok(self
            .work
            .select_next_turn(committed, execution, &self.core)?)
    }
    /// Validate the complete actual ticket before any committed IO.
    pub fn admit(
        &self,
        ticket: &w::Ticket,
        committed: &c::DocumentRuntime,
    ) -> Result<w::Admission, DraftExecutorError> {
        Ok(self.work.admit(ticket, committed, &self.core)?)
    }
    /// Settle an actual committed IO result once. Hosts resolve Replay to their
    /// own actual retained receipt before IO and before calling this method.
    pub fn settle_committed(
        &mut self,
        ticket: &w::Ticket,
        completion: c::EffectResult,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<c::Reduction, DraftExecutorError> {
        match self.work.settle(
            ticket,
            w::Completion::Committed(completion),
            committed,
            execution,
            &mut self.core,
        )? {
            w::Settlement::Committed(reduction) => Ok(reduction),
            _ => Err(DraftExecutorError::UnexpectedParserState),
        }
    }
    /// Execute at most one actual phase/cancel/drop. Replay returns the exact
    /// existing receipt without running the parser or completing either child.
    pub fn step_draft(
        &mut self,
        ticket: &w::Ticket,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<DraftStepRecord, DraftExecutorError> {
        let w::ChildEffect::Draft(effect) = &ticket.effect else {
            return Err(DraftExecutorError::Expired);
        };
        if let w::Admission::Replay(lane) = self.admit(ticket, committed)? {
            if lane != w::Lane::Draft {
                return Err(DraftExecutorError::Expired);
            }
            return self
                .last_step
                .as_ref()
                .filter(|record| record.issued == *effect)
                .cloned()
                .ok_or(DraftExecutorError::Expired);
        }
        let actual = execute_draft_effect(self, effect)?;
        let settlement = self.work.settle(
            ticket,
            w::Completion::Draft(actual.clone()),
            committed,
            execution,
            &mut self.core,
        )?;
        let w::Settlement::Draft(reduction) = settlement else {
            return Err(DraftExecutorError::UnexpectedParserState);
        };
        let record = DraftStepRecord {
            issued: effect.clone(),
            completion: actual,
            reduction,
        };
        if record.reduction.execution != d::Execution::Quiesced {
            self.last_step = Some(record.clone());
        }
        Ok(record)
    }
    /// Irreversible whole-owner retirement. No actual payload drop or parse is
    /// hidden here; the retained selection must still be drained explicitly.
    pub fn begin_close(
        &mut self,
        committed: &mut c::DocumentRuntime,
        execution: &mut c::Execution,
    ) -> Result<w::Close, DraftExecutorError> {
        self.last_step = None;
        Ok(self
            .work
            .begin_close(committed, execution, &mut self.core)?)
    }
    pub fn close_ready(&self, committed: &c::DocumentRuntime, execution: c::Execution) -> bool {
        self.work.snapshot().closing
            && self.work.snapshot().selected.is_none()
            && execution == c::Execution::Quiesced
            && committed.update().phase == c::Phase::Releasing
            && committed.in_flight().is_none()
            && self.core.snapshot().execution == d::Execution::Quiesced
            && self.core.in_flight().is_none()
            && self.jobs.is_empty()
    }
}
fn validate_chunk(job: &OwnedJob, offset: usize, length: usize) -> Result<(), DraftExecutorError> {
    if length == 0 || length > MAX_DRAFT_TRANSFER_CHUNK_BYTES {
        return Err(DraftTransferError::InvalidChunk.into());
    }
    let upload = job.upload.as_ref().ok_or(DraftTransferError::Incomplete)?;
    if job.parser.is_some()
        || offset > upload.len()
        || offset
            .checked_add(length)
            .is_none_or(|end| end > job.source.bytes || offset < upload.len() && end > upload.len())
    {
        return Err(DraftTransferError::InvalidOffset.into());
    }
    Ok(())
}
struct FactsWriter {
    bytes: Vec<u8>,
    // Includes both old and replacement Vec capacity during explicit growth.
    headroom: usize,
    resource: bool,
}
impl Write for FactsWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let needed = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|n| *n <= MAX_DRAFT_ENCODED_FACTS_BYTES);
        let fail = || io::Error::other("draft transfer resource limit");
        let Some(needed) = needed else {
            self.resource = true;
            return Err(fail());
        };
        if needed > self.bytes.capacity() {
            let available = self.headroom.saturating_sub(self.bytes.capacity());
            if needed > available {
                self.resource = true;
                return Err(fail());
            }
            let desired = needed
                .max(self.bytes.capacity().saturating_mul(2))
                .max(1024)
                .min(MAX_DRAFT_ENCODED_FACTS_BYTES)
                .min(available);
            let mut replacement = Vec::new();
            if replacement.try_reserve_exact(desired).is_err() || replacement.capacity() > available
            {
                self.resource = true;
                return Err(fail());
            }
            replacement.extend_from_slice(&self.bytes);
            self.bytes = replacement;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn execute_draft_effect(
    owner: &mut DocumentDraftExecutor,
    effect: &d::IssuedEffect,
) -> Result<d::Completion, DraftExecutorError> {
    match &effect.kind {
        d::Effect::DropJob => {
            if let Some(job) = owner.jobs.get(&effect.job.id) {
                if job.token != effect.job {
                    return Err(DraftExecutorError::Expired);
                }
            }
            // Removal really drops the parser/source/facts before quota release.
            owner.jobs.remove(&effect.job.id);
            Ok(d::Completion::Dropped)
        }
        d::Effect::ParsePhase {
            phase,
            budget,
            phases_completed,
        } => {
            let current = owner.core.phase_is_current(effect)?;
            let actual_budget = zorid_document::ParseFactsStepBudget {
                max_scratch_bytes: budget
                    .max_scratch_bytes
                    .saturating_sub(owner.transfer_scratch_bytes()),
                max_facts_bytes: budget.max_facts_bytes,
            };
            let job = owner
                .jobs
                .get_mut(&effect.job.id)
                .filter(|job| job.token == effect.job)
                .ok_or(DraftExecutorError::Expired)?;
            if !current {
                let actual = if let Some(parser) = job.parser.as_mut() {
                    parser.cancel();
                    (parser.usage(), parser.phases_completed())
                } else {
                    (zorid_document::ParseFactsUsage::default(), 0)
                };
                job.facts = None;
                return Ok(d::Completion::Stopped {
                    usage: actual.0,
                    phases_completed: actual.1,
                });
            }
            let parser = job
                .parser
                .as_mut()
                .ok_or(DraftExecutorError::UnexpectedParserState)?;
            if parser.phase() != *phase || parser.phases_completed() != *phases_completed {
                return Err(DraftExecutorError::UnexpectedParserState);
            }
            match parser.step(actual_budget) {
                Ok(step) => {
                    if step.ready {
                        job.facts = Some(
                            parser
                                .take_facts()
                                .ok_or(DraftExecutorError::UnexpectedParserState)?,
                        );
                    }
                    // Keep the PRE-transfer actual step usage in core even
                    // though take_facts emptied the parser's own usage field.
                    Ok(d::Completion::Parsed(step))
                }
                Err(ParseFactsJobError::Resource { .. }) => Ok(d::Completion::Resource {
                    usage: parser.usage(),
                    phases_completed: parser.phases_completed(),
                }),
                Err(ParseFactsJobError::Cancelled | ParseFactsJobError::Finished) => {
                    Err(DraftExecutorError::UnexpectedParserState)
                }
            }
        }
    }
}
#[cfg(test)]
#[path = "document_draft_executor_tests.rs"]
mod tests;
