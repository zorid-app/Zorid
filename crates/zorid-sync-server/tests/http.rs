use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;
use zorid_crypto::{open, seal, SystemEntropy, VaultKey};
use zorid_sync_protocol::{
    Cursor, DeviceId, Envelope, ExpectedContext, Header, RealmId, UpdateId, VaultId, MAX_WIRE_BYTES,
};
use zorid_sync_server::{http::router, RelayStore};

fn encoded(value: &str) -> String {
    value.bytes().map(|b| format!("%{b:02X}")).collect()
}
async fn request(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: &[u8],
) -> (String, Vec<u8>) {
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let headers = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\nAuthorization: Bearer {token}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nOrigin: http://localhost:7777\r\n\r\n",body.len());
    stream.write_all(headers.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut response = Vec::new();
    stream
        .take(4 * 1024 * 1024)
        .read_to_end(&mut response)
        .await
        .unwrap();
    let boundary = response.windows(4).position(|x| x == b"\r\n\r\n").unwrap() + 4;
    (
        String::from_utf8(response[..boundary].to_vec()).unwrap(),
        response[boundary..].to_vec(),
    )
}

#[tokio::test(flavor = "current_thread")]
async fn actual_loopback_http_ciphertext_exchange_retry_and_revocation() {
    let directory = tempfile::tempdir().unwrap();
    let realm = RealmId::new("realm").unwrap();
    let vault = VaultId::new("vault").unwrap();
    let update = UpdateId::new("update").unwrap();
    let mut store = RelayStore::open(directory.path().join("relay.db"), &realm).unwrap();
    store.create_account("account").unwrap();
    store.create_vault(&vault).unwrap();
    store.grant_access("account", &vault, true).unwrap();
    let a = store
        .issue_device("account", &DeviceId::new("device-a").unwrap())
        .unwrap();
    let b = store
        .issue_device("account", &DeviceId::new("device-b").unwrap())
        .unwrap();
    let cursor = Cursor::start(store.identity().unwrap().server_epoch);
    let mut admin = RelayStore::open(directory.path().join("relay.db"), &realm).unwrap();
    let app = router(store, &["http://localhost:7777".into()]).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let key = VaultKey::generate(&mut SystemEntropy).unwrap();
    let header = Header::new(
        realm.clone(),
        vault.clone(),
        update.clone(),
        DeviceId::new("device-a").unwrap(),
        1,
    )
    .unwrap();
    let plaintext = [0, 255, 1, 200, 0, 17];
    let raw = seal(&header, &plaintext, &key, &mut SystemEntropy)
        .unwrap()
        .encode();
    let target = "/v1/vaults/vault/updates/update";
    let (headers, first) = request(address, "PUT", target, a.expose_secret(), &raw).await;
    assert!(headers.starts_with("HTTP/1.1 200"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("access-control-allow-origin: http://localhost:7777"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("cache-control: no-store"));
    // The client loses the first ACK and retries identical persisted ciphertext.
    let (_, retry) = request(address, "PUT", target, a.expose_secret(), &raw).await;
    assert_eq!(first, retry);
    let path = format!(
        "/v1/vaults/vault/updates?cursor={}&limit=1",
        encoded(&serde_json::to_string(&cursor).unwrap())
    );
    let (headers, body) = request(address, "GET", &path, b.expose_secret(), &[]).await;
    assert!(headers.starts_with("HTTP/1.1 200"));
    let page: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["next"]["after"], "1");
    assert_eq!(page["complete"], true);
    let received = STANDARD
        .decode(page["items"][0]["envelope_base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(received, raw);
    let context = ExpectedContext {
        realm_id: realm,
        vault_id: vault,
        update_id: update,
        key_epoch: 1,
    };
    assert_eq!(
        &*open(&Envelope::decode(&received).unwrap(), &context, &key).unwrap(),
        &plaintext
    );
    admin
        .revoke_device(&DeviceId::new("device-a").unwrap())
        .unwrap();
    assert!(request(address, "PUT", target, a.expose_secret(), &raw)
        .await
        .0
        .starts_with("HTTP/1.1 401"));
    task.abort();
    let _ = task.await;
}

#[tokio::test(flavor = "current_thread")]
async fn transport_bounds_auth_and_explicit_cors() {
    let directory = tempfile::tempdir().unwrap();
    let realm = RealmId::new("r").unwrap();
    for origin in [
        "*",
        "null",
        "https://good.example/extra",
        "https://user@good.example",
        "http://localhost:1/",
    ] {
        let store = RelayStore::open(directory.path().join("relay.db"), &realm).unwrap();
        assert!(router(store, &[origin.into()]).is_err());
    }
    let store = RelayStore::open(directory.path().join("relay.db"), &realm).unwrap();
    let app = router(store, &["http://localhost:7".into()]).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/hello")
                .header("origin", "https://other.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get("access-control-allow-origin")
        .is_none());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v1/vaults/v/updates/u")
                .body(Body::from(vec![0; MAX_WIRE_BYTES + 1]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v1/vaults/v/updates/u")
                .body(Body::from(vec![0; 48]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "unauthorized"
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/hello?{}", "x".repeat(17000)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::URI_TOO_LONG);
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
}
