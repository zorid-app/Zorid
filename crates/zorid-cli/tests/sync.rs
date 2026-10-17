#![cfg(unix)]
use axum::{
    extract::Request,
    http::{Method, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use zorid_sync_protocol::{Cursor, DeviceId, RealmId, VaultId};
use zorid_sync_server::{BearerToken, RelayStore};

struct Server {
    address: std::net::SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(store: RelayStore, lose_first_ack: bool) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, receiver) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let lost = Arc::new(AtomicBool::new(lose_first_ack));
                let app = zorid_sync_server::http::router(store, &[]).unwrap().layer(
                    middleware::from_fn(move |request: Request, next: Next| {
                        let lost = lost.clone();
                        async move {
                            let put = request.method() == Method::PUT;
                            let response = next.run(request).await;
                            if put
                                && response.status() == StatusCode::OK
                                && lost.swap(false, Ordering::SeqCst)
                            {
                                // The real relay committed, but the client never receives its ACK.
                                StatusCode::SERVICE_UNAVAILABLE.into_response()
                            } else {
                                response
                            }
                        }
                    }),
                );
                axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), app)
                    .with_graceful_shutdown(async move {
                        let _ = receiver.await;
                    })
                    .await
                    .unwrap();
            });
        });
        Self {
            address,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.take().unwrap().send(());
        self.thread.take().unwrap().join().unwrap();
    }
}
fn cli(vault: &Path, args: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_zorid"))
        .arg("--vault")
        .arg(vault)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("fixture CLI deadline exceeded");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["result"].clone()
}
fn sync(vault: &Path, credentials: &Path, command: &[&str]) -> Output {
    let mut args = vec!["sync", "--credentials", credentials.to_str().unwrap()];
    args.extend(command);
    cli(vault, &args)
}
fn create(vault: &Path, input: &Path) {
    fs::create_dir(vault).unwrap();
    success(cli(vault, &["init"]));
    fs::write(input, []).unwrap();
    success(cli(
        vault,
        &[
            "create",
            "note.md",
            "--id",
            "note",
            "--operation-id",
            "create",
            "--input",
            input.to_str().unwrap(),
        ],
    ));
}
fn revision(vault: &Path) -> String {
    success(cli(vault, &["read", "--id", "note"]))["entry"]["revision"]
        .as_str()
        .unwrap()
        .into()
}
fn bind(vault: &Path, credentials: &Path) {
    success(sync(
        vault,
        credentials,
        &[
            "fixture-bind-empty",
            "--id",
            "note",
            "--bootstrap-id",
            "shared-bootstrap",
            "--expected-revision",
            &revision(vault),
        ],
    ));
}
fn write(vault: &Path, input: &Path, operation: &str, content: &str) {
    fs::write(input, content).unwrap();
    success(cli(
        vault,
        &[
            "write",
            "--id",
            "note",
            "--expected-revision",
            &revision(vault),
            "--operation-id",
            operation,
            "--input",
            input.to_str().unwrap(),
        ],
    ));
}
fn read(vault: &Path) -> Vec<u8> {
    let output = cli(vault, &["read", "--id", "note", "--raw"]);
    assert!(output.status.success());
    output.stdout
}
fn credentials(
    path: &Path,
    server: &Server,
    epoch: &zorid_sync_protocol::ServerEpoch,
    token: &BearerToken,
) {
    fs::write(
        path,
        serde_json::to_vec(
            &json!({"version":1,"endpoint":format!("http://{}/",server.address),
        "realm_id":"realm","vault_id":"vault","server_epoch":epoch,"key_epoch":1,
        "key_base64":STANDARD.encode([7u8;32]),"bearer_token":token.expose_secret()}),
        )
        .unwrap(),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
struct Fixture {
    server: Server,
    admin: RelayStore,
    token: BearerToken,
    epoch: zorid_sync_protocol::ServerEpoch,
    a: PathBuf,
    b: PathBuf,
    ca: PathBuf,
    cb: PathBuf,
    input: PathBuf,
    _temp: tempfile::TempDir,
}
impl Fixture {
    fn new(lose_ack: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("relay.db");
        let realm = RealmId::new("realm").unwrap();
        let vault = VaultId::new("vault").unwrap();
        let mut store = RelayStore::open(&db, &realm).unwrap();
        store.create_account("fixture").unwrap();
        store.create_vault(&vault).unwrap();
        store.grant_access("fixture", &vault, true).unwrap();
        let token = store
            .issue_device("fixture", &DeviceId::new("device-a").unwrap())
            .unwrap();
        let token_b = store
            .issue_device("fixture", &DeviceId::new("device-b").unwrap())
            .unwrap();
        let epoch = store.identity().unwrap().server_epoch;
        let admin = RelayStore::open(&db, &realm).unwrap();
        let server = Server::start(store, lose_ack);
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        let ca = temp.path().join("a-secret.json");
        let cb = temp.path().join("b-secret.json");
        let input = temp.path().join("input");
        credentials(&ca, &server, &epoch, &token);
        credentials(&cb, &server, &epoch, &token_b);
        create(&a, &input);
        create(&b, &input);
        bind(&a, &ca);
        bind(&b, &cb);
        Self {
            _temp: temp,
            server,
            admin,
            token,
            epoch,
            a,
            b,
            ca,
            cb,
            input,
        }
    }
    fn wires(&mut self) -> Vec<Vec<u8>> {
        self.admin
            .pull(
                &self.token,
                &VaultId::new("vault").unwrap(),
                &Cursor::start(self.epoch.clone()),
                None,
                64,
            )
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.envelope.encode())
            .collect()
    }
}

#[test]
fn independent_cli_processes_converge_offline_edits_without_receive_echo() {
    let mut f = Fixture::new(false);
    write(&f.a, &f.input, "seed", "\u{feff}seed\r\n");
    let pushed = success(sync(&f.a, &f.ca, &["once"]));
    assert_eq!(pushed["server_accepted"], 1);
    assert_eq!(pushed["synced"], false);
    let received = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(received["server_accepted"], 0);
    assert_eq!(received["locally_received"], 1);
    assert_eq!(received["pending_text_sample"], 0);
    assert_eq!(read(&f.a), read(&f.b));
    assert_eq!(f.wires().len(), 1);
    // Both independent invocations mutate while neither invokes any transport.
    write(&f.a, &f.input, "offline-a", "\u{feff}seed A\r\n");
    write(&f.b, &f.input, "offline-b", "\u{feff}seed B\r\n");
    success(sync(&f.a, &f.ca, &["once"]));
    success(sync(&f.b, &f.cb, &["once"]));
    let caught_up = success(sync(&f.a, &f.ca, &["once"]));
    let a = String::from_utf8(read(&f.a)).unwrap();
    assert_eq!(a.as_bytes(), read(&f.b));
    assert!(a.contains('A') && a.contains('B'));
    assert_eq!(caught_up["server_accepted"], 0);
    assert_eq!(caught_up["pending_text_sample"], 0);
    let wires = f.wires();
    assert_eq!(wires.len(), 3);
    for wire in wires {
        assert!(!wire.windows(4).any(|w| w == b"seed"));
    }
}

#[test]
fn lost_remote_ack_retries_persisted_ciphertext_after_cli_restart() {
    let mut f = Fixture::new(true);
    write(&f.a, &f.input, "seed", "private seed");
    let failed = sync(&f.a, &f.ca, &["once"]);
    assert!(!failed.status.success());
    assert!(failed.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&failed.stderr).contains(f.token.expose_secret()));
    let first = f.wires();
    assert_eq!(first.len(), 1);
    let pending = success(sync(&f.a, &f.ca, &["status"]));
    assert_eq!(pending["pending_text_sample"], 1);
    assert_eq!(pending["pending_text"][0]["sealed"], true);
    let retried = success(sync(&f.a, &f.ca, &["once"]));
    assert_eq!(retried["server_accepted"], 1);
    assert_eq!(retried["pending_text_sample"], 0);
    assert_eq!(
        f.wires(),
        first,
        "retry retained identical ciphertext and immutable log position"
    );
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(read(&f.b), b"private seed");
}

#[test]
fn credentials_are_private_outside_vault_and_errors_do_not_echo_secrets() {
    let f = Fixture::new(false);
    fs::set_permissions(&f.ca, fs::Permissions::from_mode(0o644)).unwrap();
    let output = sync(&f.a, &f.ca, &["status"]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains(f.token.expose_secret()));
    fs::set_permissions(&f.ca, fs::Permissions::from_mode(0o600)).unwrap();
    let link = f._temp.path().join("symlink-secret");
    std::os::unix::fs::symlink(&f.ca, &link).unwrap();
    assert!(!sync(&f.a, &link, &["status"]).status.success());
    let inside = f.a.join("secret.json");
    fs::copy(&f.ca, &inside).unwrap();
    assert!(!sync(&f.a, &inside, &["status"]).status.success());
    let mut value: Value = serde_json::from_slice(&fs::read(&f.ca).unwrap()).unwrap();
    value["endpoint"] = json!("http://192.0.2.1:1234/");
    fs::write(&f.ca, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(!sync(&f.a, &f.ca, &["once"]).status.success());
}

#[test]
fn revoked_device_and_wrong_epoch_do_not_advance_receive_cursor() {
    let mut f = Fixture::new(false);
    write(&f.a, &f.input, "seed", "seed");
    success(sync(&f.a, &f.ca, &["once"]));
    f.admin
        .revoke_device(&DeviceId::new("device-b").unwrap())
        .unwrap();
    assert!(!sync(&f.b, &f.cb, &["once"]).status.success());
    let status = success(sync(&f.b, &f.cb, &["status"]));
    assert_eq!(status["receive_cursor"]["after"], "0");
    assert_eq!(read(&f.b), b"");
    let mut value: Value = serde_json::from_slice(&fs::read(&f.cb).unwrap()).unwrap();
    value["server_epoch"] = json!("wrong-epoch");
    fs::write(&f.cb, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(!sync(&f.b, &f.cb, &["once"]).status.success());
    assert_eq!(
        success(sync(&f.b, &f.cb, &["status"]))["receive_cursor"]["after"],
        "0"
    );
}

#[test]
fn unauthenticated_ciphertext_never_advances_cursor_or_creates_echo() {
    let mut f = Fixture::new(false);
    let update = zorid_sync_protocol::UpdateId::new("bad-update").unwrap();
    let header = zorid_sync_protocol::Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        update.clone(),
        DeviceId::new("sender").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        b"not authenticated by fixture key",
        &zorid_crypto::VaultKey::from_bytes([8; 32]),
        &mut zorid_crypto::SystemEntropy,
    )
    .unwrap()
    .encode();
    f.admin
        .append(&f.token, &VaultId::new("vault").unwrap(), &update, &wire)
        .unwrap();
    assert!(!sync(&f.b, &f.cb, &["once"]).status.success());
    let state = success(sync(&f.b, &f.cb, &["status"]));
    assert_eq!(state["receive_cursor"]["after"], "0");
    assert_eq!(state["pending_text_sample"], 0);
    assert_eq!(read(&f.b), b"");
}

#[test]
fn unknown_authenticated_entry_stops_at_that_item_and_resumes_after_explicit_binding() {
    let mut f = Fixture::new(false);
    write(&f.a, &f.input, "seed", "known note");
    success(sync(&f.a, &f.ca, &["once"]));
    fs::write(&f.input, []).unwrap();
    success(cli(
        &f.a,
        &[
            "create",
            "extra.md",
            "--id",
            "extra",
            "--operation-id",
            "create-extra",
            "--input",
            f.input.to_str().unwrap(),
        ],
    ));
    let extra_revision = success(cli(&f.a, &["read", "--id", "extra"]))["entry"]["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    success(sync(
        &f.a,
        &f.ca,
        &[
            "fixture-bind-empty",
            "--id",
            "extra",
            "--bootstrap-id",
            "extra-bootstrap",
            "--expected-revision",
            &extra_revision,
        ],
    ));
    fs::write(&f.input, "unknown document").unwrap();
    success(cli(
        &f.a,
        &[
            "write",
            "--id",
            "extra",
            "--operation-id",
            "write-extra",
            "--expected-revision",
            &extra_revision,
            "--input",
            f.input.to_str().unwrap(),
        ],
    ));
    success(sync(&f.a, &f.ca, &["once"]));
    assert_eq!(f.wires().len(), 2);
    let failed = sync(&f.b, &f.cb, &["once"]);
    assert!(!failed.status.success());
    let failure: Value = serde_json::from_slice(&failed.stderr).unwrap();
    assert_eq!(failure["error"]["code"], "sync_unbound_entry");
    assert_eq!(read(&f.b), b"known note");
    let status = success(sync(&f.b, &f.cb, &["status"]));
    assert_eq!(status["receive_cursor"]["after"], "1");
    assert_eq!(status["pending_text_sample"], 0);
    fs::write(&f.input, []).unwrap();
    success(cli(
        &f.b,
        &[
            "create",
            "extra.md",
            "--id",
            "extra",
            "--operation-id",
            "create-extra",
            "--input",
            f.input.to_str().unwrap(),
        ],
    ));
    let local_revision = success(cli(&f.b, &["read", "--id", "extra"]))["entry"]["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    success(sync(
        &f.b,
        &f.cb,
        &[
            "fixture-bind-empty",
            "--id",
            "extra",
            "--bootstrap-id",
            "extra-bootstrap",
            "--expected-revision",
            &local_revision,
        ],
    ));
    let resumed = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(resumed["server_accepted"], 0);
    assert_eq!(resumed["receive_cursor"]["after"], "2");
    let extra = cli(&f.b, &["read", "--id", "extra", "--raw"]);
    assert!(extra.status.success());
    assert_eq!(extra.stdout, b"unknown document");
    assert_eq!(f.wires().len(), 2);
}
