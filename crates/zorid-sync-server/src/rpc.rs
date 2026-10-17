//! Bounded unary native gRPC and binary gRPC-Web over the existing durable relay.
//! Protobuf changes only control transport; exact ZSE1 bytes remain unchanged.
use crate::{
    admission::{allowed_origins, run_admitted, RelayState},
    BearerToken, RelayError, RelayStore, Result,
};
use axum::{
    body::{Body, Bytes},
    extract::{Request as HttpRequest, State},
    http::{header, HeaderMap, HeaderValue, Method},
    middleware::{self, Next},
    response::Response as HttpResponse,
    Router,
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use http_body_util::BodyExt;
use prost::Message;
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::OwnedSemaphorePermit;
use tonic::{Code, Request, Response, Status};
use tower_http::cors::CorsLayer;
use zorid_sync_protocol::{
    rpc::{self, pb},
    ProtocolError, MAX_CONTROL_BYTES,
};
use zorid_sync_rpc::relay_service_server::{RelayService, RelayServiceServer};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_HEADER_FIELDS: usize = 64;
const BODY_TIMEOUT: Duration = Duration::from_secs(10);
const PREFIX: &str = "/zorid.sync.rpc.v1.RelayService/";

/// The permit is acquired before frame/protobuf decoding. Cloneable extensions
/// share exactly one permit; only the database worker may take ownership of it.
#[derive(Clone)]
struct AdmittedWork(Arc<Mutex<Option<OwnedSemaphorePermit>>>);
impl AdmittedWork {
    fn take(&self) -> std::result::Result<OwnedSemaphorePermit, Status> {
        self.0
            .lock()
            .map_err(|_| failure(pb::ErrorCode::Internal))?
            .take()
            .ok_or_else(|| failure(pb::ErrorCode::Internal))
    }
}

#[derive(Clone)]
struct RelayRpc(RelayState);
impl RelayRpc {
    async fn run<T: Send + 'static>(
        &self,
        admitted: AdmittedWork,
        operation: impl FnOnce(&mut RelayStore) -> Result<T> + Send + 'static,
    ) -> std::result::Result<T, Status> {
        run_admitted(self.0.clone(), admitted.take()?, operation)
            .await
            .map_err(relay_status)
    }
}

fn admitted<T>(request: &Request<T>) -> std::result::Result<AdmittedWork, Status> {
    request
        .extensions()
        .get::<AdmittedWork>()
        .cloned()
        .ok_or_else(|| failure(pb::ErrorCode::Internal))
}
fn bearer<T>(request: &Request<T>) -> std::result::Result<BearerToken, Status> {
    let values = request.metadata().get_all("authorization");
    let mut values = values.iter();
    let value = values
        .next()
        .ok_or_else(|| failure(pb::ErrorCode::Unauthorized))?;
    if values.next().is_some() {
        return Err(failure(pb::ErrorCode::Unauthorized));
    }
    let token = value
        .to_str()
        .ok()
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or_else(|| failure(pb::ErrorCode::Unauthorized))?;
    BearerToken::parse(token).map_err(relay_status)
}

#[tonic::async_trait]
impl RelayService for RelayRpc {
    async fn hello(
        &self,
        request: Request<pb::HelloRequest>,
    ) -> std::result::Result<Response<pb::HelloReply>, Status> {
        let permit = admitted(&request)?;
        rpc::validate_hello_request(request.get_ref()).map_err(protocol_status)?;
        let identity = self.run(permit, |store| store.identity()).await?;
        Ok(Response::new(rpc::hello_reply(
            &identity.realm_id,
            &identity.server_epoch,
        )))
    }
    async fn append(
        &self,
        request: Request<pb::AppendRequest>,
    ) -> std::result::Result<Response<pb::AcceptedReply>, Status> {
        let permit = admitted(&request)?;
        let token = bearer(&request)?;
        let input = rpc::validate_append_request(request.into_inner()).map_err(protocol_status)?;
        let accepted = self
            .run(permit, move |store| {
                store.append(&token, &input.vault_id, &input.update_id, &input.exact_wire)
            })
            .await?;
        Ok(Response::new(rpc::accepted_reply(&accepted)))
    }
    async fn pull(
        &self,
        request: Request<pb::PullRequest>,
    ) -> std::result::Result<Response<pb::PullReply>, Status> {
        let permit = admitted(&request)?;
        let token = bearer(&request)?;
        let input = rpc::validate_pull_request(request.into_inner()).map_err(protocol_status)?;
        let page = self
            .run(permit, move |store| {
                store.pull(
                    &token,
                    &input.vault_id,
                    &input.cursor,
                    input.through,
                    input.limit,
                )
            })
            .await?;
        let items = page
            .items
            .into_iter()
            .map(|item| (item.sequence, item.envelope.encode()))
            .collect();
        let reply = rpc::pull_reply(items, &page.next, page.through, page.complete)
            .map_err(|_| failure(pb::ErrorCode::Internal))?;
        Ok(Response::new(reply))
    }
}

fn protocol_status(error: rpc::Error) -> Status {
    failure(match error.code() {
        "sync_unsupported_protocol" => pb::ErrorCode::UnsupportedProtocol,
        "sync_response_limit" => pb::ErrorCode::TooLarge,
        "sync_epoch_or_realm_mismatch" => pb::ErrorCode::EpochMismatch,
        _ => pb::ErrorCode::InvalidRequest,
    })
}
fn relay_status(error: RelayError) -> Status {
    failure(match error {
        RelayError::Unauthorized => pb::ErrorCode::Unauthorized,
        RelayError::Forbidden => pb::ErrorCode::Forbidden,
        RelayError::Conflict => pb::ErrorCode::ImmutableUpdateConflict,
        RelayError::Busy => pb::ErrorCode::RelayBusy,
        RelayError::Protocol(ProtocolError::EpochMismatch) => pb::ErrorCode::EpochMismatch,
        RelayError::Protocol(ProtocolError::TooLarge) => pb::ErrorCode::TooLarge,
        RelayError::Protocol(
            ProtocolError::UnsupportedTransport
            | ProtocolError::UnsupportedRequiredFeature
            | ProtocolError::UnsupportedEnvelope,
        ) => pb::ErrorCode::UnsupportedProtocol,
        RelayError::Protocol(_) | RelayError::InvalidRequest => pb::ErrorCode::InvalidRequest,
        _ => pb::ErrorCode::Internal,
    })
}
fn failure(error: pb::ErrorCode) -> Status {
    let (code, message) = match error {
        pb::ErrorCode::Unauthorized => (Code::Unauthenticated, "unauthorized"),
        pb::ErrorCode::Forbidden => (Code::PermissionDenied, "forbidden"),
        pb::ErrorCode::ImmutableUpdateConflict => {
            (Code::AlreadyExists, "immutable_update_conflict")
        }
        pb::ErrorCode::RelayBusy => (Code::Unavailable, "relay_busy"),
        pb::ErrorCode::EpochMismatch => (Code::FailedPrecondition, "epoch_mismatch"),
        pb::ErrorCode::UnsupportedProtocol => (Code::FailedPrecondition, "unsupported_protocol"),
        pb::ErrorCode::TooLarge => (Code::ResourceExhausted, "too_large"),
        pb::ErrorCode::InvalidRequest => (Code::InvalidArgument, "invalid_request"),
        _ => (Code::Internal, "relay_failure"),
    };
    Status::with_details(
        code,
        message,
        Bytes::from(pb::ErrorDetail { code: error as i32 }.encode_to_vec()),
    )
}

/// Exact CORS origins, no cookies, no wildcard, no public provisioning endpoints.
/// An embedding host must bind loopback; `serve_loopback` enforces that boundary.
pub fn router(store: RelayStore, origins: &[String]) -> Result<Router> {
    router_with_state(RelayState::new(store), origins)
}

fn router_with_state(state: RelayState, origins: &[String]) -> Result<Router> {
    let service = RelayServiceServer::new(RelayRpc(state.clone()))
        .max_decoding_message_size(rpc::MAX_APPEND_MESSAGE)
        .max_encoding_message_size(rpc::MAX_PULL_MESSAGE);
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins(origins)?)
        .allow_methods([Method::POST])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-grpc-web"),
            header::HeaderName::from_static("x-user-agent"),
            header::HeaderName::from_static("grpc-timeout"),
            header::HeaderName::from_static("grpc-accept-encoding"),
            header::HeaderName::from_static("connect-protocol-version"),
        ])
        .expose_headers([
            header::HeaderName::from_static("grpc-status"),
            header::HeaderName::from_static("grpc-message"),
            header::HeaderName::from_static("grpc-status-details-bin"),
        ]);
    Ok(Router::new()
        .fallback_service(tonic_web::enable(service))
        .layer(middleware::from_fn_with_state(state, bounds))
        .layer(cors))
}

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
    axum::serve(
        listener,
        router(store, origins).map_err(std::io::Error::other)?,
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

fn header_limits(headers: &HeaderMap) -> bool {
    headers.len() <= MAX_HEADER_FIELDS
        && headers
            .iter()
            .map(|(name, value)| name.as_str().len() + value.len())
            .sum::<usize>()
            <= MAX_HEADER_BYTES
}
fn binary_web(headers: &HeaderMap) -> bool {
    matches!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/grpc-web" | "application/grpc-web+proto")
    )
}
fn rejection(status: Status, web: bool) -> HttpResponse {
    let mut response = status.into_http::<Body>();
    if web {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/grpc-web+proto"),
        );
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn bounds(
    State(state): State<RelayState>,
    mut request: HttpRequest,
    next: Next,
) -> HttpResponse {
    let web = binary_web(request.headers());
    let method = request.uri().path().strip_prefix(PREFIX);
    let max = match method {
        Some("Append") => rpc::MAX_APPEND_MESSAGE,
        Some("Hello" | "Pull") => MAX_CONTROL_BYTES,
        _ => return rejection(failure(pb::ErrorCode::InvalidRequest), web),
    };
    if !header_limits(request.headers()) || request.uri().to_string().len() > 512 {
        return rejection(failure(pb::ErrorCode::TooLarge), web);
    }
    let headers = request.headers();
    if request.method() != Method::POST
        || request.uri().query().is_some()
        || headers.get_all(header::CONTENT_TYPE).iter().count() != 1
        || !matches!(
            headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some(
                "application/grpc"
                    | "application/grpc+proto"
                    | "application/grpc-web"
                    | "application/grpc-web+proto"
            )
        )
        || headers
            .get_all("grpc-encoding")
            .iter()
            .any(|v| v != "identity")
        || headers
            .get_all(header::ACCEPT)
            .iter()
            .any(|v| v.to_str().is_err() || v.to_str().is_ok_and(|v| v.contains("grpc-web-text")))
    {
        return rejection(failure(pb::ErrorCode::InvalidRequest), web);
    }
    if let Some(length) = headers.get(header::CONTENT_LENGTH) {
        if length
            .to_str()
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .is_none_or(|n| n > max + 5)
        {
            return rejection(failure(pb::ErrorCode::TooLarge), web);
        }
    }
    let Ok(inflight) = state.inflight.clone().try_acquire_owned() else {
        return rejection(failure(pb::ErrorCode::RelayBusy), web);
    };
    let Ok(work) = state.work.clone().try_acquire_owned() else {
        return rejection(failure(pb::ErrorCode::RelayBusy), web);
    };
    let body = std::mem::replace(request.body_mut(), Body::empty());
    let framed = match tokio::time::timeout(BODY_TIMEOUT, unary_frame(body, max)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => return rejection(failure(error), web),
        Err(_) => return rejection(Status::deadline_exceeded("request_timeout"), web),
    };
    *request.body_mut() = Body::from(framed);
    request
        .extensions_mut()
        .insert(AdmittedWork(Arc::new(Mutex::new(Some(work)))));
    let response = next.run(request).await;
    let (mut parts, body) = response.into_parts();
    parts
        .headers
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    HttpResponse::from_parts(
        parts,
        Body::new(HeldBody {
            inner: Box::pin(body),
            permit: Some(inflight),
        }),
    )
}

/// Never reserve from the peer's declared length. Parse the five-byte prefix
/// incrementally, before buffering payload or allowing Prost to allocate.
async fn unary_frame(mut body: Body, max: usize) -> std::result::Result<Vec<u8>, pb::ErrorCode> {
    let mut framed = Vec::new();
    let mut expected = None;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| pb::ErrorCode::InvalidRequest)?;
        let mut chunk = frame
            .into_data()
            .map_err(|_| pb::ErrorCode::InvalidRequest)?;
        if chunk.len() > max + 5 - framed.len() {
            return Err(pb::ErrorCode::TooLarge);
        }
        if framed.len() < 5 {
            let count = (5 - framed.len()).min(chunk.len());
            framed.extend_from_slice(&chunk.split_to(count));
            if framed.len() == 5 {
                if framed[0] != 0 {
                    return Err(pb::ErrorCode::InvalidRequest);
                }
                let length =
                    u32::from_be_bytes(framed[1..5].try_into().expect("five-byte prefix")) as usize;
                if length > max {
                    return Err(pb::ErrorCode::TooLarge);
                }
                expected = Some(length + 5);
            }
        }
        if let Some(expected) = expected {
            if framed.len() + chunk.len() > expected {
                return Err(pb::ErrorCode::InvalidRequest);
            }
        }
        framed.extend_from_slice(&chunk);
    }
    if expected != Some(framed.len()) {
        return Err(pb::ErrorCode::InvalidRequest);
    }
    Ok(framed)
}

/// Admission lasts until the response is sent or abandoned, including encoding.
struct HeldBody {
    inner: Pin<Box<Body>>,
    permit: Option<OwnedSemaphorePermit>,
}
impl HttpBody for HeldBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, Self::Error>>> {
        let frame = self.inner.as_mut().poll_frame(cx);
        if matches!(frame, Poll::Ready(None | Some(Err(_)))) {
            self.permit.take();
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tower::ServiceExt;
    use zorid_sync_protocol::RealmId;

    struct PendingBody;
    impl HttpBody for PendingBody {
        type Data = Bytes;
        type Error = std::convert::Infallible;
        fn poll_frame(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<std::result::Result<Frame<Bytes>, Self::Error>>> {
            Poll::Pending
        }
    }
    fn hello(body: Body) -> HttpRequest {
        HttpRequest::builder()
            .method("POST")
            .uri(format!("{PREFIX}Hello"))
            .header("content-type", "application/grpc-web+proto")
            .body(body)
            .unwrap()
    }
    fn hello_frame() -> Body {
        let bytes = pb::HelloRequest {
            offered_transport_majors: vec![2],
            control: Some(pb::Control::default()),
        }
        .encode_to_vec();
        let mut framed = vec![0];
        framed.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        framed.extend(bytes);
        Body::from(framed)
    }
    fn fixture() -> (tempfile::TempDir, RelayState) {
        let dir = tempfile::tempdir().unwrap();
        let store =
            RelayStore::open(dir.path().join("relay.db"), &RealmId::new("realm").unwrap()).unwrap();
        (dir, RelayState::new(store))
    }
    async fn wait_permits(permits: &tokio::sync::Semaphore, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while permits.available_permits() != expected {
            assert!(
                Instant::now() < deadline,
                "admission permit transition timed out"
            );
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn incomplete_frames_are_bounded_before_decode_or_work() {
        let (_dir, state) = fixture();
        let app = router_with_state(state.clone(), &[]).unwrap();
        let mut requests = Vec::new();
        for _ in 0..8 {
            let app = app.clone();
            requests.push(tokio::spawn(async move {
                app.oneshot(hello(Body::new(PendingBody))).await
            }));
        }
        wait_permits(&state.inflight, 0).await;
        assert_eq!(state.work.available_permits(), 0);
        let response = app.clone().oneshot(hello(hello_frame())).await.unwrap();
        assert_eq!(response.headers()["grpc-status"], "14");
        for request in requests {
            request.abort();
            let _ = request.await;
        }
        assert_eq!(state.inflight.available_permits(), 8);
        assert_eq!(state.work.available_permits(), 8);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn canceled_rpc_keeps_admitted_database_work_bounded() {
        let (_dir, state) = fixture();
        let app = router_with_state(state.clone(), &[]).unwrap();
        let held = state.store.lock().unwrap();
        let mut requests = Vec::new();
        for _ in 0..8 {
            let app = app.clone();
            requests.push(tokio::spawn(async move {
                app.oneshot(hello(hello_frame())).await
            }));
        }
        wait_permits(&state.work, 0).await;
        // Let all admitted requests dispatch their blocking closures before abort.
        tokio::task::yield_now().await;
        for request in requests {
            request.abort();
            let _ = request.await;
        }
        assert_eq!(state.work.available_permits(), 0);
        let response = app.clone().oneshot(hello(hello_frame())).await.unwrap();
        assert_eq!(response.headers()["grpc-status"], "14");
        drop(held);
        wait_permits(&state.work, 8).await;
        let response = app.oneshot(hello(hello_frame())).await.unwrap();
        assert!(!response.headers().contains_key("grpc-status"));
    }
}
