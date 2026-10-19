//! Read-only queries over a sealed committed subset. These tokens cannot be
//! converted to ordinary snapshot, publication, pin or mutation capabilities.
use super::*;
use crate::{
    Generation, IndexRecord, Manifest, PreviewProgress, PreviewSnapshot, PreviewSnapshotId,
    SourceSnapshotId,
};
use serde::Serialize;
use std::sync::Arc;
use zorid_core::{EntryId, EntryState};

#[derive(Clone, Debug)]
pub(super) enum SearchBacking {
    Published(Arc<Generation>),
    Preview(PreviewSnapshot),
}
impl SearchBacking {
    pub(super) fn published(&self) -> Option<&Arc<Generation>> {
        match self {
            Self::Published(g) => Some(g),
            Self::Preview(_) => None,
        }
    }
    pub(super) fn manifest(&self) -> &Manifest {
        match self {
            Self::Published(g) => g.manifest(),
            Self::Preview(p) => p.manifest(),
        }
    }
    pub(super) fn record(&self, id: &EntryId) -> Option<&IndexRecord> {
        match self {
            Self::Published(g) => g.record(id),
            Self::Preview(p) => p.record(id),
        }
    }
    pub(super) fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Published(a), Self::Published(b)) => Arc::ptr_eq(a, b),
            (Self::Preview(a), Self::Preview(b)) => a.same_capture(b),
            _ => false,
        }
    }
    pub(super) fn retained_bytes(&self) -> usize {
        match self {
            Self::Published(_) => 0,
            Self::Preview(p) => p.retained_bytes(),
        }
    }
    pub(super) fn lookup_work(&self) -> usize {
        match self {
            Self::Published(_) => 0,
            Self::Preview(p) => p.lookup_work(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewQueryId {
    pub(super) inner: RichQueryId,
    pub(super) capture: PreviewSnapshotId,
}
impl PreviewQueryId {
    pub fn capture(&self) -> &PreviewSnapshotId {
        &self.capture
    }
    pub fn retire(&self) {
        self.inner.retire();
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewSearchCursor {
    pub(super) inner: RichSearchCursor,
    pub(super) query: PreviewQueryId,
}
impl PreviewSearchCursor {
    pub fn query(&self) -> &PreviewQueryId {
        &self.query
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewPreparation {
    Preparing,
    Ready(PreviewSearchCursor),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewTextReadRequest(pub(super) RichTextReadRequest);
impl PreviewTextReadRequest {
    pub fn capture(&self) -> &PreviewSnapshotId {
        self.0.preview_capture()
    }
    pub fn source(&self) -> &SourceSnapshotId {
        self.0.source()
    }
    pub fn entry(&self) -> &EntryState {
        self.0.entry()
    }
    pub fn digest(&self) -> &[u8; 32] {
        self.0.digest()
    }
    pub fn bytes(&self) -> usize {
        self.0.bytes()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewSearchAction {
    ReadText(PreviewTextReadRequest),
    Yield,
    Done,
}

/// `Indexing` is unconditional, including captures with no pending rows. Only
/// ordinary publication can establish complete generation coverage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewSearchStatus {
    Indexing,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRichSearchPage {
    pub status: PreviewSearchStatus,
    pub progress: PreviewProgress,
    pub prepared_scan_complete: bool,
    pub complete: bool,
    pub dialect: String,
    pub spec: SearchSpec,
    pub explanation: Option<CoreSearchExplanation>,
    pub files: Vec<SearchFileChunk>,
    pub totals: SearchTotals,
    /// Coverage here refers exclusively to the sealed prepared membership.
    pub coverage: SearchQueryCoverage,
    pub output_complete: bool,
    pub work: SearchPageWork,
}
/// Capture/source identity stays typed and non-deserializable beside the DTO.
pub struct CommittedPreviewSearchPage {
    pub capture: PreviewSnapshotId,
    pub source: SourceSnapshotId,
    pub page: PreviewRichSearchPage,
    pub next: Option<PreviewSearchCursor>,
}
pub struct PreparedPreviewSearchPage {
    pub(super) inner: PreparedRichSearchPage,
    pub(super) query: PreviewQueryId,
}
pub struct PreviewSearchDrive(pub(super) RichSearchDrive, pub(super) PreviewQueryId);
impl PreviewSearchDrive {
    pub fn work_breakdown(&self) -> &RichSearchWorkBreakdown {
        self.0.work_breakdown()
    }
    pub fn next_action<E>(
        &mut self,
        check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<PreviewSearchAction, RichSearchError<E>> {
        self.0.next_action(check).map(|a| match a {
            RichSearchAction::ReadText(r) => {
                PreviewSearchAction::ReadText(PreviewTextReadRequest(r))
            }
            RichSearchAction::Yield => PreviewSearchAction::Yield,
            RichSearchAction::Done => PreviewSearchAction::Done,
        })
    }
    pub fn accept_text<E>(
        &mut self,
        request: &PreviewTextReadRequest,
        bytes: &[u8],
        check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), RichSearchError<E>> {
        self.0.accept_text(&request.0, bytes, check)
    }
    pub fn finish<E>(self) -> Result<PreparedPreviewSearchPage, RichSearchError<E>> {
        Ok(PreparedPreviewSearchPage {
            inner: self.0.finish()?,
            query: self.1,
        })
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum SearchPage {
    Published(DocumentRichSearchPage),
    Preview(PreviewRichSearchPage),
}
impl SearchPage {
    pub(super) fn complete(&self) -> bool {
        match self {
            Self::Published(p) => p.complete,
            Self::Preview(_) => false,
        }
    }
}

#[cfg(test)]
#[path = "preview_query_tests.rs"]
mod tests;
