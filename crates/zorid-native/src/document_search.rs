//! Native rich-search execution over an exact host-owned retained pin. The
//! pure owner never receives a pin, source reader, transaction or host cursor.
use super::NativeVault;
use crate::document_api::*;
use std::sync::{Arc, MutexGuard, TryLockError};
use zorid_core::EntryKind;
use zorid_index::{
    RichPreparation, RichSearchAction, RichSearchError, RichSearchOwner, SearchPresentationFacts,
    MAX_SEARCH_CANDIDATES,
};

fn rich_error(error: RichSearchError<NativeDocumentError>) -> NativeDocumentError {
    match error {
        RichSearchError::Host(error) => error,
        RichSearchError::Compile(error) => NativeDocumentError::SearchCompile(error),
        RichSearchError::Index(error) => error.into(),
        RichSearchError::Resource(detail) => NativeDocumentError::SearchResource(detail),
        RichSearchError::Invalid(detail) => NativeDocumentError::SearchInvalid(detail),
        RichSearchError::Expired => NativeDocumentError::SearchExpired,
        RichSearchError::Busy => NativeDocumentError::SearchBusy,
    }
}
fn safe_time(value: u64) -> Option<i64> {
    (value <= 9_007_199_254_740_991).then_some(value as i64)
}
impl Drop for NativeRichQuery {
    fn drop(&mut self) {
        // The shared core flag expires even outstanding drives immediately.
        // A cancellation callback can drop another guard while this owner is
        // borrowed: retire first, and let bounded core pruning reclaim it.
        self.id.retire();
        if let Some(owner) = self.owner.upgrade() {
            match owner.try_lock() {
                Ok(mut owner) => {
                    owner.close_query(&self.id);
                }
                Err(TryLockError::Poisoned(error)) => {
                    error.into_inner().close_query(&self.id);
                }
                Err(TryLockError::WouldBlock) => {}
            }
        }
    }
}
impl NativeVault {
    fn rich_owner(&self) -> NativeDocumentResult<MutexGuard<'_, RichSearchOwner>> {
        self.rich_search_owner
            .try_lock()
            .map_err(|error| match error {
                TryLockError::WouldBlock => NativeDocumentError::SearchBusy,
                TryLockError::Poisoned(_) => NativeDocumentError::SearchExpired,
            })
    }
    pub(super) fn clear_rich_document_queries(&self) {
        self.rich_search_owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        // Rebuild/provider replacement discarded every pure state above. A
        // callback panic cannot permanently poison a subsequently fresh owner.
        self.rich_search_owner.clear_poison();
    }
    fn admit_rich_query(&self, query: &NativeRichQuery) -> NativeDocumentResult<()> {
        if !std::sync::Weak::ptr_eq(&query.owner, &Arc::downgrade(&self.rich_search_owner)) {
            return Err(NativeDocumentError::SearchExpired);
        }
        self.document_manifest(&query.pin)?;
        Ok(())
    }
    fn expire_rich_query(&self, query: &NativeRichQuery) {
        query.id.retire();
        match self.rich_search_owner.try_lock() {
            Ok(mut owner) => {
                owner.close_query(&query.id);
            }
            Err(TryLockError::Poisoned(error)) => {
                error.into_inner().close_query(&query.id);
            }
            Err(TryLockError::WouldBlock) => {}
        }
    }
    /// Compile and admit one query over this exact retained pin. Arc clones do
    /// not open additional Store pins; the caller closes all guards at retirement.
    pub fn start_rich_document_query(
        &self,
        pin: Arc<DocumentQueryPin>,
        spec: SearchSpec,
        profile: RichPageProfile,
        mut check: impl FnMut(usize) -> NativeDocumentResult<()>,
    ) -> NativeDocumentResult<NativeRichQuery> {
        let manifest = self.document_manifest(&pin)?;
        check(0)?;
        let count = manifest
            .entries()
            .iter()
            .filter(|entry| entry.state.kind == EntryKind::File)
            .count();
        if count > MAX_SEARCH_CANDIDATES {
            return Err(NativeDocumentError::SearchResource(
                "search candidate count",
            ));
        }
        let mut facts = Vec::new();
        facts
            .try_reserve_exact(count)
            .map_err(|_| NativeDocumentError::SearchResource("search facts allocation"))?;
        for (entry, presentation) in manifest.entries().iter().zip(manifest.presentations()) {
            check(1)?;
            if entry.state.kind == EntryKind::File {
                facts.push(SearchPresentationFacts {
                    entry: &entry.state,
                    created_ms: safe_time(presentation.ctime_ms),
                    modified_ms: safe_time(presentation.mtime_ms),
                });
            }
        }
        let id = self
            .rich_owner()?
            .start_query(pin.shared_generation(), spec, &facts, profile, &mut check)
            .map_err(rich_error)?;
        let query = NativeRichQuery {
            pin,
            owner: Arc::downgrade(&self.rich_search_owner),
            id,
        };
        // Failure drops the guard and its newly admitted pure query as well.
        check(0)?;
        self.admit_rich_query(&query)?;
        Ok(query)
    }
    /// Pump ordering without IO; reentrant owner work returns SearchBusy.
    pub fn prepare_rich_document_query(
        &self,
        query: &NativeRichQuery,
        soft_work: usize,
        mut check: impl FnMut(usize) -> NativeDocumentResult<()>,
    ) -> NativeDocumentResult<NativeRichPreparation> {
        self.admit_rich_query(query)?;
        check(0)?;
        let preparation = self
            .rich_owner()?
            .prepare_query(&query.id, soft_work, &mut check)
            .map_err(rich_error)?;
        check(0)?;
        self.admit_rich_query(query)?;
        Ok(match preparation {
            RichPreparation::Preparing => NativeRichPreparation::Preparing,
            RichPreparation::Ready(value) => NativeRichPreparation::Ready(NativeRichCursor {
                owner: query.owner.clone(),
                value,
            }),
        })
    }
    /// Drive exactly one bounded page. No owner lock or Store transaction spans
    /// source IO/evaluation. An adapter can yield between these synchronous calls.
    pub fn rich_document_page(
        &self,
        query: &NativeRichQuery,
        cursor: &NativeRichCursor,
        mut check: impl FnMut(usize) -> NativeDocumentResult<()>,
    ) -> NativeDocumentResult<NativeRichPage> {
        self.admit_rich_query(query)?;
        if !std::sync::Weak::ptr_eq(&cursor.owner, &query.owner)
            || cursor.value.query() != &query.id
        {
            return Err(NativeDocumentError::SearchInvalid("search cursor query"));
        }
        check(0)?;
        let mut drive = self
            .rich_owner()?
            .open_drive::<NativeDocumentError>(&cursor.value)
            .map_err(rich_error)?;
        loop {
            match drive.next_action(&mut check).map_err(rich_error)? {
                RichSearchAction::ReadText(request) => {
                    self.admit_rich_query(query)?;
                    if request.snapshot() != query.pin.generation().id() {
                        return Err(NativeDocumentError::SearchInvalid("search read snapshot"));
                    }
                    self.point("rich_search_before_read");
                    check(0)?;
                    let projection = self
                        .store
                        .read_document_projection(&query.pin, &request.entry().id)?;
                    if projection.witness.entry() != request.entry() {
                        return Err(zorid_index::IndexError::ContentMismatch.into());
                    }
                    let bytes = projection
                        .content
                        .ok_or(DocumentIndexError::RebuildRequired)?;
                    if bytes.len() != request.bytes() {
                        return Err(zorid_index::IndexError::ContentMismatch.into());
                    }
                    self.point("rich_search_after_read");
                    check(0)?;
                    self.admit_rich_query(query)?;
                    drive
                        .accept_text(&request, &bytes, &mut check)
                        .map_err(rich_error)?;
                }
                RichSearchAction::Yield | RichSearchAction::Done => break,
            }
        }
        let prepared = drive.finish::<NativeDocumentError>().map_err(rich_error)?;
        self.point("rich_search_before_commit");
        check(0)?;
        self.admit_rich_query(query)?;
        let committed = self
            .rich_owner()?
            .commit::<NativeDocumentError>(prepared)
            .map_err(rich_error)?;
        // The temporary owner guard has been dropped before either hook/fence.
        self.point("rich_search_committed");
        let result = (|| {
            check(0)?;
            if committed.page.snapshot != *query.pin.generation().id() {
                return Err(NativeDocumentError::SearchInvalid("search result snapshot"));
            }
            self.document_result(&query.pin, committed.page)
        })();
        match result {
            Ok(result) => Ok(NativeRichPage {
                result,
                next: committed.next.map(|value| NativeRichCursor {
                    owner: query.owner.clone(),
                    value,
                }),
            }),
            Err(error) => {
                // A late cancellation/rebuild cannot leave an advanced usable
                // continuation behind an invocation which returned an error.
                self.expire_rich_query(query);
                Err(error)
            }
        }
    }
    /// Explicit cleanup is safe even after the root or retained epoch expires.
    pub fn close_rich_document_query(&self, query: NativeRichQuery) {
        drop(query);
    }
}

#[cfg(test)]
#[path = "document_search_tests.rs"]
mod tests;
