//! One bounded execution path for both remote adapters. SQLite stays on a
//! blocking worker; cancellation never releases a permit held by running work.
use crate::{RelayError, RelayStore, Result};
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) const MAX_INFLIGHT: usize = 8;
#[derive(Clone)]
pub(crate) struct RelayState {
    pub(crate) store: Arc<Mutex<RelayStore>>,
    pub(crate) inflight: Arc<Semaphore>,
    pub(crate) work: Arc<Semaphore>,
}
impl RelayState {
    pub(crate) fn new(store: RelayStore) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            inflight: Arc::new(Semaphore::new(MAX_INFLIGHT)),
            work: Arc::new(Semaphore::new(MAX_INFLIGHT)),
        }
    }
}

pub(crate) async fn run<T: Send + 'static>(
    state: RelayState,
    operation: impl FnOnce(&mut RelayStore) -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = state
        .work
        .clone()
        .try_acquire_owned()
        .map_err(|_| RelayError::Busy)?;
    run_admitted(state, permit, operation).await
}

pub(crate) async fn run_admitted<T: Send + 'static>(
    state: RelayState,
    permit: OwnedSemaphorePermit,
    operation: impl FnOnce(&mut RelayStore) -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut store = state.store.lock().map_err(|_| RelayError::Corrupt)?;
        operation(&mut store)
    })
    .await
    .map_err(|_| RelayError::Corrupt)?
}

pub(crate) fn allowed_origins(origins: &[String]) -> Result<Vec<axum::http::HeaderValue>> {
    if origins.len() > 16 {
        return Err(RelayError::InvalidRequest);
    }
    origins
        .iter()
        .map(|origin| {
            if origin.len() > 512 {
                return Err(RelayError::InvalidRequest);
            }
            let uri: axum::http::Uri = origin.parse().map_err(|_| RelayError::InvalidRequest)?;
            if !matches!(uri.scheme_str(), Some("http" | "https"))
                || uri.authority().is_none()
                || uri.authority().is_some_and(|a| a.as_str().contains('@'))
                || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
                || origin.ends_with('/')
            {
                return Err(RelayError::InvalidRequest);
            }
            axum::http::HeaderValue::from_str(origin).map_err(|_| RelayError::InvalidRequest)
        })
        .collect()
}
