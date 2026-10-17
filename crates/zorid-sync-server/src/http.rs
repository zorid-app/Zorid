//! Bounded local fixture transport. Authentication and authorization live in the
//! storage transaction, not in a stale HTTP middleware cache.
use crate::{BearerToken, RelayError, RelayStore, Result, MAX_PAGE_BYTES, MAX_PAGE_ITEMS};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::json;
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;
use tower_http::cors::CorsLayer;
use zorid_sync_protocol::{Cursor, LogPosition, ProtocolError, UpdateId, VaultId, MAX_WIRE_BYTES};

#[derive(Clone)]
struct HttpState {
    store: Arc<Mutex<RelayStore>>,
    inflight: Arc<Semaphore>,
    work: Arc<Semaphore>,
}

/// Exact HTTP(S) origin allowlist; no wildcard, null origin or credentials cookie.
/// Callers embedding this Router are responsible for loopback-only binding.
pub fn router(store: RelayStore, origins: &[String]) -> Result<Router> {
    if origins.len() > 16 {
        return Err(RelayError::InvalidRequest);
    }
    let mut allowed = Vec::new();
    for origin in origins {
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
        allowed.push(HeaderValue::from_str(origin).map_err(|_| RelayError::InvalidRequest)?);
    }
    let state = HttpState {
        store: Arc::new(Mutex::new(store)),
        inflight: Arc::new(Semaphore::new(8)),
        work: Arc::new(Semaphore::new(8)),
    };
    let cors = CorsLayer::new()
        .allow_origin(allowed)
        .allow_methods([Method::GET, Method::PUT])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    Ok(Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/vaults/{vault}/updates/{update}", put(append))
        .route("/v1/vaults/{vault}/updates", get(pull))
        .layer(DefaultBodyLimit::max(MAX_WIRE_BYTES))
        .layer(cors)
        .layer(middleware::from_fn_with_state(state.clone(), bounds))
        .layer(middleware::from_fn(no_store))
        .with_state(state))
}

/// Does not provision accounts, print secrets, or expose a production TLS server.
pub async fn serve_loopback(
    listener: tokio::net::TcpListener,
    store: RelayStore,
    origins: &[String],
) -> std::io::Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "fixture relay requires a loopback listener",
        ));
    }
    let app = router(store, origins).map_err(std::io::Error::other)?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}

async fn bounds(State(state): State<HttpState>, request: Request, next: Next) -> Response {
    // Bounds before Query serde allocates; cursor percent encoding can be 3x.
    if request.uri().to_string().len() > 16 * 1024 {
        return StatusCode::URI_TOO_LONG.into_response();
    }
    if request
        .headers()
        .iter()
        .map(|(k, v)| k.as_str().len() + v.len())
        .sum::<usize>()
        > 16 * 1024
    {
        return StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE.into_response();
    }
    let Ok(_permit) = state.inflight.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    next.run(request).await
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn run<T: Send + 'static>(
    state: HttpState,
    operation: impl FnOnce(&mut RelayStore) -> Result<T> + Send + 'static,
) -> Result<T> {
    // A blocking SQLite operation survives cancellation of its HTTP future.
    // Its own permit must move into that closure and remain held until it exits.
    let permit = state
        .work
        .clone()
        .try_acquire_owned()
        .map_err(|_| RelayError::Busy)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut store = state.store.lock().map_err(|_| RelayError::Corrupt)?;
        operation(&mut store)
    })
    .await
    .map_err(|_| RelayError::Corrupt)?
}

async fn hello(State(state): State<HttpState>) -> Result<Json<serde_json::Value>> {
    let id = run(state, |store| store.identity()).await?;
    Ok(Json(
        json!({"realm_id": id.realm_id, "server_epoch": id.server_epoch,
        "transport_versions": [1], "envelope_versions": [1], "suite": "xchacha20poly1305",
        "max_wire_bytes": MAX_WIRE_BYTES, "max_page_bytes": MAX_PAGE_BYTES,
        "max_page_items": MAX_PAGE_ITEMS,
        "extensions": {"required_features": [], "optional_extensions": {}}}),
    ))
}

fn bearer(headers: &HeaderMap) -> Result<BearerToken> {
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return Err(RelayError::Unauthorized);
    }
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(RelayError::Unauthorized)?;
    BearerToken::parse(value)
}

async fn append(
    State(state): State<HttpState>,
    Path((vault, update)): Path<(String, String)>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Json<zorid_sync_protocol::Accepted>> {
    let token = bearer(&headers)?;
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(RelayError::InvalidRequest);
    }
    let vault = VaultId::new(vault)?;
    let update = UpdateId::new(update)?;
    Ok(Json(
        run(state, move |store| {
            store.append(&token, &vault, &update, &raw)
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PullQuery {
    /// URL-encoded bounded Cursor JSON, preserving protocol extension policy.
    cursor: String,
    through: Option<String>,
    limit: Option<usize>,
}
async fn pull(
    State(state): State<HttpState>,
    Path(vault): Path<String>,
    headers: HeaderMap,
    Query(query): Query<PullQuery>,
) -> Result<Json<serde_json::Value>> {
    let token = bearer(&headers)?;
    let vault = VaultId::new(vault)?;
    let cursor = Cursor::decode(query.cursor.as_bytes())?;
    let through = query.through.map(LogPosition::try_from).transpose()?;
    let page = run(state, move |store| {
        store.pull(
            &token,
            &vault,
            &cursor,
            through,
            query.limit.unwrap_or(MAX_PAGE_ITEMS),
        )
    })
    .await?;
    let items: Vec<_> = page.items.into_iter().map(|item| json!({"sequence":item.sequence,"envelope_base64":STANDARD.encode(item.envelope.encode())})).collect();
    Ok(Json(
        json!({"items":items,"next":page.next,"through":page.through,"complete":page.complete,
        "extensions":{"required_features":[],"optional_extensions":{}}}),
    ))
}

impl IntoResponse for RelayError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::Conflict => (StatusCode::CONFLICT, "immutable_update_conflict"),
            Self::Busy => (StatusCode::SERVICE_UNAVAILABLE, "relay_busy"),
            Self::Protocol(ProtocolError::EpochMismatch) => {
                (StatusCode::CONFLICT, "epoch_mismatch")
            }
            Self::Protocol(ProtocolError::TooLarge) => (StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
            Self::Protocol(_) | Self::InvalidRequest => {
                (StatusCode::BAD_REQUEST, "invalid_request")
            }
            Self::Corrupt
            | Self::Storage(_)
            | Self::EntropyUnavailable
            | Self::Io(_)
            | Self::DestinationExists
            | Self::PublicationUnconfirmed
            | Self::UnsupportedPlatform => (StatusCode::INTERNAL_SERVER_ERROR, "relay_failure"),
        };
        (
            status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"error":code})),
        )
            .into_response()
    }
}

/// Parsing entrypoint used by the executable; arbitrary public bind is forbidden.
pub fn loopback_address(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use zorid_sync_protocol::RealmId;

    #[tokio::test(flavor = "current_thread")]
    async fn canceled_request_futures_keep_blocking_work_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let store = RelayStore::open(
            directory.path().join("relay.db"),
            &RealmId::new("r").unwrap(),
        )
        .unwrap();
        let state = HttpState {
            store: Arc::new(Mutex::new(store)),
            inflight: Arc::new(Semaphore::new(8)),
            work: Arc::new(Semaphore::new(8)),
        };
        // Stall the exact mutex used by HTTP database work, then cancel each
        // request future after its blocking closure has acquired its own permit.
        let held = state.store.lock().unwrap();
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let state = state.clone();
            tasks.push(tokio::spawn(async move {
                run(state, |store| store.identity()).await
            }));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while state.work.available_permits() != 0 {
            assert!(Instant::now() < deadline, "blocking work was not admitted");
            tokio::task::yield_now().await;
        }
        for task in tasks {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        assert_eq!(state.work.available_permits(), 0);
        assert!(matches!(
            run(state.clone(), |store| store.identity()).await,
            Err(RelayError::Busy)
        ));
        drop(held);
        let deadline = Instant::now() + Duration::from_secs(5);
        while state.work.available_permits() != 8 {
            assert!(Instant::now() < deadline, "completed work leaked a permit");
            tokio::task::yield_now().await;
        }
        assert!(run(state, |store| store.identity()).await.is_ok());
    }
}
