//! Actual TCP authorization boundaries; disposable fixtures only.
use rusqlite::Connection;
use serde_json::Value;
use std::{
    io::{Read, Write},
    time::{Duration, Instant},
};
use zorid_crypto::{seal, SystemEntropy, VaultKey};
use zorid_sync_protocol::{Cursor, DeviceId, Header, RealmId, UpdateId, VaultId};
use zorid_sync_server::{http::router, BearerToken, RelayStore};

struct Fixture {
    _dir: tempfile::TempDir,
    admin: RelayStore,
    address: std::net::SocketAddr,
    task: tokio::task::JoinHandle<()>,
    a: BearerToken,
    b: BearerToken,
    reader: BearerToken,
    cursor: Cursor,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.db");
        let realm = RealmId::new("realm").unwrap();
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
        let cursor = Cursor::start(store.identity().unwrap().server_epoch);
        let admin = RelayStore::open(&path, &realm).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(store, &[]).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            _dir: dir,
            admin,
            address,
            task,
            a,
            b,
            reader,
            cursor,
        }
    }
    fn pull_path(&self, vault: &str) -> String {
        let cursor: String = serde_json::to_string(&self.cursor)
            .unwrap()
            .bytes()
            .map(|b| format!("%{b:02X}"))
            .collect();
        format!("/v1/vaults/{vault}/updates?cursor={cursor}&limit=64")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn wire(vault: &str, update: &str) -> Vec<u8> {
    let header = Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new(vault).unwrap(),
        UpdateId::new(update).unwrap(),
        DeviceId::new("origin").unwrap(),
        1,
    )
    .unwrap();
    seal(
        &header,
        b"private fixture bytes",
        &VaultKey::generate(&mut SystemEntropy).unwrap(),
        &mut SystemEntropy,
    )
    .unwrap()
    .encode()
}
async fn request(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: &[u8],
) -> (u16, Value) {
    let method = method.to_owned();
    let path = path.to_owned();
    let token = token.to_owned();
    let body = body.to_owned();
    tokio::task::spawn_blocking(move || {
        let limit = Duration::from_secs(5);
        let deadline = Instant::now() + limit;
        let mut stream = std::net::TcpStream::connect_timeout(&address, limit).unwrap();
        let remaining = || deadline.checked_duration_since(Instant::now()).expect("HTTP fixture deadline exceeded");
        stream.set_write_timeout(Some(remaining())).unwrap();
        let header = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\nAuthorization: Bearer {token}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n", body.len());
        stream.write_all(header.as_bytes()).expect("HTTP fixture header write failed");
        stream.set_write_timeout(Some(remaining())).unwrap();
        stream.write_all(&body).expect("HTTP fixture body write failed");
        let mut response = Vec::new();
        loop {
            stream.set_read_timeout(Some(remaining())).unwrap();
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).expect("HTTP fixture read failed or timed out");
            if count == 0 { break; }
            assert!(response.len() + count <= 1024 * 1024, "HTTP fixture response exceeded bound");
            response.extend_from_slice(&chunk[..count]);
        }
        let end = response.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
        let status = std::str::from_utf8(&response[..end]).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_slice(&response[end..]).unwrap())
    }).await.unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn accounts_vaults_readers_and_permission_changes_are_enforced_over_http() {
    let mut f = Fixture::new().await;
    let raw = wire("va", "u1");
    let put = "/v1/vaults/va/updates/u1";
    assert_eq!(
        request(f.address, "PUT", put, f.a.expose_secret(), &raw)
            .await
            .0,
        200
    );
    // A valid account for another vault cannot read, author, or deduplicate here.
    for (method, path, body) in [
        ("GET", f.pull_path("va"), Vec::new()),
        ("PUT", put.into(), raw.clone()),
        ("PUT", "/v1/vaults/va/updates/new".into(), wire("va", "new")),
    ] {
        assert_eq!(
            request(f.address, method, &path, f.b.expose_secret(), &body)
                .await
                .0,
            403
        );
    }
    assert_eq!(
        request(
            f.address,
            "GET",
            &f.pull_path("vb"),
            f.a.expose_secret(),
            &[]
        )
        .await
        .0,
        403
    );
    let read = request(
        f.address,
        "GET",
        &f.pull_path("va"),
        f.reader.expose_secret(),
        &[],
    )
    .await;
    assert_eq!(read.0, 200);
    assert_eq!(read.1["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        request(f.address, "PUT", put, f.reader.expose_secret(), &raw)
            .await
            .0,
        403
    );
    // Even an authorized destination writer cannot substitute an envelope for another vault.
    assert_eq!(
        request(
            f.address,
            "PUT",
            "/v1/vaults/vb/updates/u1",
            f.b.expose_secret(),
            &raw
        )
        .await
        .0,
        400
    );
    assert_eq!(
        request(
            f.address,
            "GET",
            &f.pull_path("vb"),
            f.b.expose_secret(),
            &[]
        )
        .await
        .1["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    f.admin
        .grant_access("a", &VaultId::new("va").unwrap(), false)
        .unwrap();
    assert_eq!(
        request(
            f.address,
            "GET",
            &f.pull_path("va"),
            f.a.expose_secret(),
            &[]
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(f.address, "PUT", put, f.a.expose_secret(), &raw)
            .await
            .0,
        403
    );
    assert_eq!(
        request(
            f.address,
            "PUT",
            "/v1/vaults/va/updates/new",
            f.a.expose_secret(),
            &wire("va", "new")
        )
        .await
        .0,
        403
    );
    f.admin
        .revoke_access("a", &VaultId::new("va").unwrap())
        .unwrap();
    assert_eq!(
        request(
            f.address,
            "GET",
            &f.pull_path("va"),
            f.a.expose_secret(),
            &[]
        )
        .await
        .0,
        403
    );
    f.admin
        .revoke_device(&DeviceId::new("dr").unwrap())
        .unwrap();
    assert_eq!(
        request(
            f.address,
            "GET",
            &f.pull_path("va"),
            f.reader.expose_secret(),
            &[]
        )
        .await
        .0,
        401
    );
    assert_eq!(
        request(f.address, "PUT", put, f.reader.expose_secret(), &raw)
            .await
            .0,
        401
    );
}

#[tokio::test(flavor = "current_thread")]
async fn fresh_http_append_overlapping_revocation_is_denied() {
    let f = Fixture::new().await;
    let db = Connection::open(f._dir.path().join("relay.db")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE; UPDATE devices SET revoked=1 WHERE id='da';")
        .unwrap();
    let address = f.address;
    let token = f.a.expose_secret().to_owned();
    let pending = tokio::spawn(async move {
        request(
            address,
            "PUT",
            "/v1/vaults/va/updates/fresh",
            &token,
            &wire("va", "fresh"),
        )
        .await
    });
    // Overlap smoke test only: the request is pending while another connection
    // holds the write fence. Scheduling does not prove the HTTP handler reached
    // SQLite before COMMIT; deterministic transaction-boundary coverage requires
    // a separate observable lock-attempt seam.
    tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(150)))
        .await
        .unwrap();
    assert!(!pending.is_finished());
    db.execute_batch("COMMIT").unwrap();
    assert_eq!(pending.await.unwrap().0, 401);
    let read = request(
        f.address,
        "GET",
        &f.pull_path("va"),
        f.reader.expose_secret(),
        &[],
    )
    .await;
    assert_eq!(read.0, 200);
    assert!(read.1["items"].as_array().unwrap().is_empty());
}
