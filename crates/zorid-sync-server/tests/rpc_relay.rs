//! Real SQLite relay + native HTTP/2; binary gRPC-Web uses the same router.
//! These disposable fixtures do not provision public accounts or vault keys.
use axum::{
    body::{to_bytes, Body},
    http::{Request as HttpRequest, StatusCode},
    middleware::{self, Next},
    response::Response as HttpResponse,
};
use prost::Message;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tonic::{Code, Request};
use tower::ServiceExt;
use zorid_crypto::{seal, SystemEntropy, VaultKey};
use zorid_sync_protocol::{
    rpc::{self, pb},
    DeviceId, Header, RealmId, UpdateId, VaultId, MAX_PLAINTEXT_BYTES,
};
use zorid_sync_rpc::relay_service_client::RelayServiceClient;
use zorid_sync_server::{rpc::router, BearerToken, RelayStore};

struct Fixture {
    _dir: tempfile::TempDir,
    admin: RelayStore,
    app: axum::Router,
    a: BearerToken,
    b: BearerToken,
    reader: BearerToken,
    epoch: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let realm = RealmId::new("realm").unwrap();
        let path = dir.path().join("relay.db");
        let mut store = RelayStore::open(&path, &realm).unwrap();
        for account in ["a", "b", "reader"] {
            store.create_account(account).unwrap();
        }
        for vault in ["va", "vb"] {
            store.create_vault(&VaultId::new(vault).unwrap()).unwrap();
        }
        store
            .grant_access("a", &VaultId::new("va").unwrap(), true)
            .unwrap();
        store
            .grant_access("b", &VaultId::new("vb").unwrap(), true)
            .unwrap();
        store
            .grant_access("reader", &VaultId::new("va").unwrap(), false)
            .unwrap();
        let a = store
            .issue_device("a", &DeviceId::new("da").unwrap())
            .unwrap();
        let b = store
            .issue_device("b", &DeviceId::new("db").unwrap())
            .unwrap();
        let reader = store
            .issue_device("reader", &DeviceId::new("dr").unwrap())
            .unwrap();
        let epoch = store.identity().unwrap().server_epoch.as_str().to_owned();
        let admin = RelayStore::open(&path, &realm).unwrap();
        let app = router(store, &["http://localhost:7777".into()]).unwrap();
        Self {
            _dir: dir,
            admin,
            app,
            a,
            b,
            reader,
            epoch,
        }
    }
    async fn start(
        &self,
    ) -> (
        RelayServiceClient<tonic::transport::Channel>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = self.app.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let channel = tonic::transport::Endpoint::from_shared(format!("http://{address}"))
            .unwrap()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .connect()
            .await
            .unwrap();
        (
            RelayServiceClient::new(channel)
                .max_decoding_message_size(rpc::MAX_PULL_MESSAGE)
                .max_encoding_message_size(rpc::MAX_APPEND_MESSAGE),
            task,
        )
    }
}
fn auth<T>(body: T, token: &BearerToken) -> Request<T> {
    let mut request = Request::new(body);
    request.metadata_mut().insert(
        "authorization",
        format!("Bearer {}", token.expose_secret()).parse().unwrap(),
    );
    request
}
fn context() -> Option<pb::RequestContext> {
    Some(pb::RequestContext {
        transport_major: Some(2),
        control: Some(pb::Control::default()),
    })
}
fn append(update: &str, wire: Vec<u8>) -> pb::AppendRequest {
    pb::AppendRequest {
        context: context(),
        vault_id: "va".into(),
        update_id: update.into(),
        exact_wire: wire,
    }
}
fn pull(epoch: &str, after: u64, through: Option<u64>) -> pb::PullRequest {
    pb::PullRequest {
        context: context(),
        vault_id: "va".into(),
        cursor: Some(pb::Cursor {
            server_epoch: epoch.into(),
            after: Some(after),
            control: Some(pb::Control::default()),
        }),
        through,
        limit: Some(64),
    }
}
fn wire(update: &str, full: bool) -> Vec<u8> {
    let header = Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("va").unwrap(),
        UpdateId::new(update).unwrap(),
        DeviceId::new("origin").unwrap(),
        1,
    )
    .unwrap();
    let plaintext = vec![0x93; if full { MAX_PLAINTEXT_BYTES } else { 8 }];
    seal(
        &header,
        &plaintext,
        &VaultKey::generate(&mut SystemEntropy).unwrap(),
        &mut SystemEntropy,
    )
    .unwrap()
    .encode()
}
fn detail(error: &tonic::Status) -> pb::ErrorCode {
    pb::ErrorCode::try_from(pb::ErrorDetail::decode(error.details()).unwrap().code).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn native_http2_full_ciphertext_retry_bounded_snapshot_and_durable_reopen() {
    let mut f = Fixture::new();
    let (mut client, task) = f.start().await;
    let hello = client
        .hello(pb::HelloRequest {
            offered_transport_majors: vec![2],
            control: Some(pb::Control::default()),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(hello.selected_transport_major, Some(2));
    assert_eq!(hello.server_epoch, f.epoch);
    let mut originals = Vec::new();
    for update in ["u1", "u2", "u3"] {
        let raw = wire(update, true);
        let first = client
            .append(auth(append(update, raw.clone()), &f.a))
            .await
            .unwrap()
            .into_inner();
        let retry = client
            .append(auth(append(update, raw.clone()), &f.a))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(first, retry);
        originals.push(raw);
    }
    let first = client
        .pull(auth(pull(&f.epoch, 0, None), &f.reader))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.through, Some(3));
    assert_eq!(first.complete, Some(false));
    assert_eq!(first.items[0].exact_wire, originals[0]);
    assert_eq!(first.items[1].exact_wire, originals[1]);
    // Later writes are not smuggled into this snapshot continuation.
    client
        .append(auth(append("u4", wire("u4", false)), &f.a))
        .await
        .unwrap();
    let next = client
        .pull(auth(pull(&f.epoch, 2, first.through), &f.reader))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(next.items.len(), 1);
    assert_eq!(next.items[0].exact_wire, originals[2]);
    assert_eq!(next.next.unwrap().after, Some(3));
    assert_eq!(next.complete, Some(true));
    let empty = client
        .pull(auth(pull(&f.epoch, 0, Some(0)), &f.reader))
        .await
        .unwrap()
        .into_inner();
    assert!(empty.items.is_empty());
    assert_eq!(empty.through, Some(0));
    assert_eq!(empty.complete, Some(true));
    // A separate SQLite connection observes durable data, not an RPC ledger.
    let page = f
        .admin
        .pull(
            &f.reader,
            &VaultId::new("va").unwrap(),
            &zorid_sync_protocol::Cursor::start(
                zorid_sync_protocol::ServerEpoch::new(&f.epoch).unwrap(),
            ),
            None,
            64,
        )
        .unwrap();
    assert_eq!(page.through.get(), 4);
    assert_eq!(page.items[0].envelope.encode(), originals[0]);
    task.abort();
    let _ = task.await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_auth_before_duplicate_ack_and_stable_protocol_errors() {
    let mut f = Fixture::new();
    let (mut client, task) = f.start().await;
    let raw = wire("u1", false);
    client
        .append(auth(append("u1", raw.clone()), &f.a))
        .await
        .unwrap();
    for token in [&f.b, &f.reader] {
        let error = client
            .append(auth(append("u1", raw.clone()), token))
            .await
            .unwrap_err();
        assert_eq!(error.code(), Code::PermissionDenied);
        assert_eq!(detail(&error), pb::ErrorCode::Forbidden);
    }
    assert_eq!(
        client
            .pull(auth(pull(&f.epoch, 0, None), &f.b))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let error = client
        .append(auth(append("u1", wire("u1", false)), &f.a))
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::AlreadyExists);
    assert_eq!(detail(&error), pb::ErrorCode::ImmutableUpdateConflict);
    f.admin
        .revoke_device(&DeviceId::new("da").unwrap())
        .unwrap();
    let error = client
        .append(auth(append("u1", raw), &f.a))
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::Unauthenticated);
    assert_eq!(detail(&error), pb::ErrorCode::Unauthorized);
    let error = client
        .pull(auth(pull("wrong_epoch", 0, None), &f.reader))
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::FailedPrecondition);
    assert_eq!(detail(&error), pb::ErrorCode::EpochMismatch);
    let mut request = pull(&f.epoch, 0, None);
    request
        .context
        .as_mut()
        .unwrap()
        .control
        .as_mut()
        .unwrap()
        .required_features
        .push("unknown".into());
    let error = client.pull(auth(request, &f.reader)).await.unwrap_err();
    assert_eq!(error.code(), Code::FailedPrecondition);
    assert_eq!(detail(&error), pb::ErrorCode::UnsupportedProtocol);
    let mut request = pull(&f.epoch, 0, None);
    request.context = None;
    assert_eq!(
        client
            .pull(auth(request, &f.reader))
            .await
            .unwrap_err()
            .code(),
        Code::InvalidArgument
    );
    task.abort();
    let _ = task.await;
}

#[tokio::test(flavor = "current_thread")]
async fn uncertain_rpc_response_retains_existing_relay_retry_identity() {
    let mut f = Fixture::new();
    let first = Arc::new(AtomicBool::new(true));
    f.app = f.app.clone().layer(middleware::from_fn(
        move |request: axum::extract::Request, next: Next| {
            let first = first.clone();
            async move {
                let append = request.uri().path().ends_with("/Append");
                let response = next.run(request).await;
                if append && first.swap(false, Ordering::SeqCst) {
                    // Actual durable append has completed; discard the first reply.
                    tonic::Status::unavailable("fixture_lost_reply").into_http::<Body>()
                } else {
                    response
                }
            }
        },
    ));
    let (mut client, task) = f.start().await;
    let raw = wire("uncertain", false);
    assert_eq!(
        client
            .append(auth(append("uncertain", raw.clone()), &f.a))
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    let retry = client
        .append(auth(append("uncertain", raw.clone()), &f.a))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(retry.sequence, Some(1));
    let page = client
        .pull(auth(pull(&f.epoch, 0, None), &f.reader))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].exact_wire, raw);
    task.abort();
    let _ = task.await;
}

fn frame(message: &impl Message) -> Vec<u8> {
    let body = message.encode_to_vec();
    let mut framed = vec![0];
    framed.extend_from_slice(&(body.len() as u32).to_be_bytes());
    framed.extend(body);
    framed
}
async fn web(
    app: axum::Router,
    method: &str,
    body: Vec<u8>,
    extra: &[(&str, &str)],
) -> HttpResponse {
    let mut request = HttpRequest::builder()
        .method("POST")
        .uri(format!("/zorid.sync.rpc.v1.RelayService/{method}"))
        .header("content-type", "application/grpc-web+proto")
        .header("origin", "http://localhost:7777");
    for (name, value) in extra {
        request = request.header(*name, *value);
    }
    app.oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn binary_web_exact_bytes_cors_and_frame_bounds_precede_decoder() {
    let f = Fixture::new();
    let raw = wire("web", false);
    let authorization = format!("Bearer {}", f.a.expose_secret());
    let response = web(
        f.app.clone(),
        "Append",
        frame(&append("web", raw.clone())),
        &[("authorization", &authorization)],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "http://localhost:7777"
    );
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = to_bytes(response.into_body(), rpc::MAX_PULL_MESSAGE + 1024)
        .await
        .unwrap();
    assert_eq!(body[0], 0);
    let length = u32::from_be_bytes(body[1..5].try_into().unwrap()) as usize;
    let accepted = pb::AcceptedReply::decode(&body[5..5 + length]).unwrap();
    assert_eq!(accepted.sequence, Some(1));
    let request = pull(&f.epoch, 0, None);
    let response = web(
        f.app.clone(),
        "Pull",
        frame(&request),
        &[("authorization", &authorization)],
    )
    .await;
    let body = to_bytes(response.into_body(), rpc::MAX_PULL_MESSAGE + 1024)
        .await
        .unwrap();
    let length = u32::from_be_bytes(body[1..5].try_into().unwrap()) as usize;
    let page = pb::PullReply::decode(&body[5..5 + length]).unwrap();
    assert_eq!(page.items[0].exact_wire, raw);
    let hello = pb::HelloRequest {
        offered_transport_majors: vec![2],
        control: Some(pb::Control::default()),
    };
    let mut two = frame(&hello);
    two.extend(frame(&hello));
    let mut compressed = frame(&hello);
    compressed[0] = 1;
    for (body, expected) in [
        (vec![0, 255, 255, 255, 255], "8"),
        (two, "3"),
        (compressed, "3"),
        (vec![0, 0], "3"),
    ] {
        let response = web(f.app.clone(), "Hello", body, &[]).await;
        assert_eq!(response.headers()["grpc-status"], expected);
        assert!(response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/grpc-web"));
    }
    let response = web(
        f.app.clone(),
        "Hello",
        frame(&hello),
        &[("grpc-encoding", "gzip")],
    )
    .await;
    assert_eq!(response.headers()["grpc-status"], "3");
    let response = web(
        f.app.clone(),
        "Pull",
        frame(&request),
        &[
            ("authorization", &authorization),
            ("authorization", &authorization),
        ],
    )
    .await;
    assert_eq!(response.headers()["grpc-status"], "16");
    let response = f
        .app
        .clone()
        .oneshot(
            HttpRequest::builder()
                .method("OPTIONS")
                .uri("/zorid.sync.rpc.v1.RelayService/Hello")
                .header("origin", "http://localhost:7777")
                .header("access-control-request-method", "POST")
                .header(
                    "access-control-request-headers",
                    "authorization,content-type,x-grpc-web,grpc-accept-encoding",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "http://localhost:7777"
    );
    for origin in [
        "*",
        "null",
        "https://user@good.example",
        "http://localhost:7777/",
        "http://localhost:7777/path",
    ] {
        let store = RelayStore::open(
            f._dir.path().join("relay.db"),
            &RealmId::new("realm").unwrap(),
        )
        .unwrap();
        assert!(router(store, &[origin.into()]).is_err());
    }
}
