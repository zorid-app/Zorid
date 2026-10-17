#![cfg(unix)]
#[path = "support/grpc_fixture.rs"]
mod grpc_fixture;
use axum::{
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::IntoResponse,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
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
                let app =
                    zorid_sync_server::rpc::router(store, &[])
                        .unwrap()
                        .layer(middleware::from_fn(move |request: Request, next: Next| {
                            let lost = lost.clone();
                            async move {
                                let put = grpc_fixture::site(request.uri().path()) == 4;
                                let response = next.run(request).await;
                                if put
                                    && response.status() == StatusCode::OK
                                    && lost.swap(false, Ordering::SeqCst)
                                {
                                    // The real relay committed, but the client never receives its ACK.
                                    grpc_fixture::discard_response(response).await;
                                    StatusCode::SERVICE_UNAVAILABLE.into_response()
                                } else {
                                    response
                                }
                            }
                        }));
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
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(25);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out.join();
            let _ = err.join();
            panic!("fixture CLI deadline exceeded");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = out.join().unwrap();
    let stderr = err.join().unwrap();
    assert!(
        stdout.len() <= 32 * 1024 * 1024 && stderr.len() <= 1024 * 1024,
        "fixture output exceeded bounds"
    );
    Output {
        status,
        stdout,
        stderr,
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
fn create(vault: &Path, _input: &Path) {
    fs::create_dir(vault).unwrap();
    success(cli(vault, &["init"]));
}
fn create_text(vault: &Path, input: &Path, id: &str, path: &str, bytes: &[u8]) {
    fs::write(input, bytes).unwrap();
    success(cli(
        vault,
        &[
            "create",
            path,
            "--id",
            id,
            "--operation-id",
            &format!("create-{id}"),
            "--text",
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
    success(sync(vault, credentials, &["fixture-enroll"]));
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
            &json!({"version":2,"transport":"grpc","endpoint":format!("http://{}/",server.address),
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
        create_text(&a, &input, "note", "note.md", b"");
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
    let initial_count = pushed["server_accepted"].as_u64().unwrap() as usize;
    assert!(initial_count >= 2);
    assert_eq!(pushed["synced"], false);
    let received = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(received["server_accepted"], 0);
    assert_eq!(received["locally_received"], initial_count);
    assert_eq!(received["pending_envelope_sample"], 0);
    assert_eq!(read(&f.a), read(&f.b));
    assert_eq!(f.wires().len(), initial_count);
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
    assert_eq!(caught_up["pending_envelope_sample"], 0);
    let wires = f.wires();
    assert_eq!(wires.len(), initial_count + 2);
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
    let pending_count = pending["pending_envelope_sample"].as_u64().unwrap();
    assert!(pending_count >= 2);
    assert_eq!(pending["pending_envelopes"][0]["sealed"], true);
    let retried = success(sync(&f.a, &f.ca, &["once"]));
    assert_eq!(retried["server_accepted"], pending_count);
    assert_eq!(retried["pending_envelope_sample"], 0);
    assert_eq!(
        &f.wires()[..1],
        first.as_slice(),
        "retry retained identical ciphertext and immutable log position"
    );
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(read(&f.b), b"private seed");
}

fn cursor_position(status: &Value) -> &str {
    let cursor = &status["family"]["cursor"];
    if cursor.is_null() {
        "0"
    } else {
        cursor["after"].as_str().unwrap()
    }
}

fn assert_bound_start_cursor(status: &Value, epoch: &zorid_sync_protocol::ServerEpoch) {
    let cursor = &status["family"]["cursor"];
    assert_eq!(cursor["after"], "0");
    assert_eq!(cursor["realm_id"], "realm");
    assert_eq!(cursor["vault_id"], "vault");
    assert_eq!(cursor["server_epoch"], json!(epoch));
}

#[test]
fn watch_retries_persisted_ciphertext_after_lost_ack_and_process_restart() {
    let mut f = Fixture::new(true);
    write(&f.a, &f.input, "watch-seed", "private watch seed\r\n");
    let before = success(sync(&f.a, &f.ca, &["status"]));
    let failed_cycle = cli(
        &f.a,
        &[
            "watch",
            "--credentials",
            f.ca.to_str().unwrap(),
            "--interval-ms",
            "100",
            "--max-cycles",
            "1",
        ],
    );
    assert!(failed_cycle.status.success());
    assert!(failed_cycle.stderr.is_empty());
    let frames: Vec<Value> = std::str::from_utf8(&failed_cycle.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["version"], 1);
    assert_eq!(frames[0]["ok"], false);
    assert_eq!(frames[0]["event"], "watch_cycle");
    assert_eq!(frames[0]["cycle"], 1);
    assert_eq!(frames[0]["retrying"], true);
    assert_eq!(frames[0]["error"]["code"], "sync_transport");
    assert_eq!(frames[1]["ok"], true);
    assert_eq!(frames[1]["result"]["event"], "watch_stopped");
    assert_eq!(frames[1]["result"]["cycles"], 1);
    assert_eq!(frames[1]["result"]["reason"], "max_cycles");
    assert_eq!(frames[1]["result"]["last_cycle_complete"], false);

    let first_wire = f.wires();
    assert_eq!(first_wire.len(), 1, "relay committed before losing its ACK");
    let pending = success(sync(&f.a, &f.ca, &["status"]));
    let pending_count = pending["pending_envelope_sample"].as_u64().unwrap();
    assert!(pending_count >= 2);
    assert_eq!(pending["pending_envelopes"][0]["sealed"], true);
    assert_eq!(cursor_position(&pending), cursor_position(&before));
    assert_bound_start_cursor(&pending, &f.epoch);

    // This is a fresh foreground process over the same durable local state.
    let restarted = cli(
        &f.a,
        &[
            "watch",
            "--credentials",
            f.ca.to_str().unwrap(),
            "--interval-ms",
            "100",
            "--max-cycles",
            "2",
        ],
    );
    assert!(restarted.status.success());
    assert!(restarted.stderr.is_empty());
    let frames: Vec<Value> = std::str::from_utf8(&restarted.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames.len(), 3);
    for (index, frame) in frames[..2].iter().enumerate() {
        assert_eq!(frame["version"], 1);
        assert_eq!(frame["ok"], true, "{frame}");
        assert_eq!(frame["result"]["event"], "watch_cycle");
        assert_eq!(frame["result"]["cycle"], index + 1);
        assert_eq!(frame["result"]["scan"]["complete"], true);
        assert_eq!(frame["result"]["sync"]["pending_envelope_sample"], 0);
    }
    assert_eq!(
        frames[0]["result"]["sync"]["server_accepted"],
        pending_count
    );
    assert_eq!(frames[1]["result"]["sync"]["server_accepted"], 0);
    assert_eq!(frames[2]["ok"], true);
    assert_eq!(frames[2]["result"]["event"], "watch_stopped");
    assert_eq!(frames[2]["result"]["cycles"], 2);
    assert_eq!(frames[2]["result"]["reason"], "max_cycles");
    let after = success(sync(&f.a, &f.ca, &["status"]));
    assert_eq!(after["pending_envelope_sample"], 0);
    assert_ne!(cursor_position(&after), cursor_position(&before));
    let wires = f.wires();
    assert_eq!(wires.len(), pending_count as usize);
    assert_eq!(
        &wires[..1],
        first_wire.as_slice(),
        "watch restart retries identical ciphertext at its original log position"
    );
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(read(&f.b), b"private watch seed\r\n");
    for output in [&failed_cycle.stdout, &restarted.stdout] {
        let output = std::str::from_utf8(output).unwrap();
        assert!(!output.contains(f.token.expose_secret()));
        assert!(!output.contains("private watch seed"));
        assert!(!output.contains(&STANDARD.encode([7u8; 32])));
    }
}

#[test]
fn watch_revoked_credentials_fail_without_retry_or_secret_output() {
    let mut f = Fixture::new(false);
    write(&f.a, &f.input, "watch-seed", "private remote watch seed");
    success(sync(&f.a, &f.ca, &["once"]));
    let before = success(sync(&f.b, &f.cb, &["status"]));
    let credentials: Value = serde_json::from_slice(&fs::read(&f.cb).unwrap()).unwrap();
    f.admin
        .revoke_device(&DeviceId::new("device-b").unwrap())
        .unwrap();
    let denied = cli(
        &f.b,
        &[
            "watch",
            "--credentials",
            f.cb.to_str().unwrap(),
            "--interval-ms",
            "100",
            "--max-cycles",
            "2",
        ],
    );
    assert!(!denied.status.success());
    assert!(denied.stdout.is_empty(), "fatal rejection must not retry");
    let failure: Value = serde_json::from_slice(&denied.stderr).unwrap();
    assert_eq!(failure["ok"], false);
    assert_eq!(failure["error"]["code"], "sync_authorization_failed");
    assert_ne!(failure["retrying"], true);
    let diagnostics = std::str::from_utf8(&denied.stderr).unwrap();
    for secret in [
        credentials["bearer_token"].as_str().unwrap(),
        credentials["key_base64"].as_str().unwrap(),
        "private remote watch seed",
    ] {
        assert!(!diagnostics.contains(secret));
    }
    let after = success(sync(&f.b, &f.cb, &["status"]));
    assert_eq!(cursor_position(&after), cursor_position(&before));
    assert_bound_start_cursor(&after, &f.epoch);
    assert_eq!(after["pending_envelope_sample"], 0);
    assert!(!cli(&f.b, &["read", "--id", "note"]).status.success());
}

#[test]
fn watch_defers_sync_and_recovery_when_enrolled_directory_scan_is_incomplete() {
    let mut f = Fixture::new(false);
    for index in 0..257 {
        fs::create_dir(f.a.join(format!("directory-{index:03}"))).unwrap();
    }
    assert!(f.wires().is_empty());
    let watched = cli(
        &f.a,
        &[
            "watch",
            "--credentials",
            f.ca.to_str().unwrap(),
            "--interval-ms",
            "100",
            "--max-cycles",
            "1",
        ],
    );
    assert!(
        watched.status.success(),
        "{}",
        String::from_utf8_lossy(&watched.stderr)
    );
    assert!(watched.stderr.is_empty());
    let frames: Vec<Value> = std::str::from_utf8(&watched.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["ok"], true);
    let cycle = &frames[0]["result"];
    assert_eq!(cycle["event"], "watch_cycle");
    assert_eq!(cycle["cycle"], 1);
    assert_eq!(cycle["complete"], false);
    assert_eq!(cycle["scan"]["complete"], false);
    assert_eq!(cycle["scan"]["recovery_run"], false);
    assert!(cycle["sync"].is_null());
    assert_eq!(cycle["sync_deferred"], "scan_incomplete");
    assert_eq!(frames[1]["ok"], true);
    assert_eq!(frames[1]["result"]["event"], "watch_stopped");
    assert_eq!(frames[1]["result"]["cycles"], 1);
    assert_eq!(frames[1]["result"]["reason"], "max_cycles");
    assert_eq!(frames[1]["result"]["last_cycle_complete"], false);
    assert!(f.wires().is_empty(), "incomplete scan must defer transport");
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
    assert_eq!(status["family"]["cursor"]["after"], "0");
    assert!(!cli(&f.b, &["read", "--id", "note"]).status.success());
    let mut value: Value = serde_json::from_slice(&fs::read(&f.cb).unwrap()).unwrap();
    value["server_epoch"] = json!("wrong-epoch");
    fs::write(&f.cb, serde_json::to_vec(&value).unwrap()).unwrap();
    let failed = sync(&f.b, &f.cb, &["once"]);
    assert!(!failed.status.success());
    let failure: Value = serde_json::from_slice(&failed.stderr).unwrap();
    // Public Hello must reject the pinned epoch before revoked authorization
    // can mask an incorrect discovery check.
    assert_eq!(failure["error"]["code"], "sync_epoch_or_realm_mismatch");
    assert_eq!(
        success(sync(&f.b, &f.cb, &["status"]))["family"]["cursor"]["after"],
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
    assert_eq!(state["family"]["cursor"]["after"], "0");
    assert_eq!(state["pending_envelope_sample"], 0);
    assert!(!cli(&f.b, &["read", "--id", "note"]).status.success());
}

#[test]
fn namespace_create_receives_new_text_without_manual_local_binding() {
    let mut f = Fixture::new(false);
    create_text(&f.a, &f.input, "extra", "extra.md", b"unique remote text");
    success(sync(&f.a, &f.ca, &["once"]));
    let count = f.wires().len();
    let received = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(received["server_accepted"], 0);
    assert_eq!(received["pending_envelope_sample"], 0);
    assert_eq!(received["family"]["pending_dependencies"], "0");
    let read = cli(&f.b, &["read", "--id", "extra", "--raw"]);
    assert!(read.status.success());
    assert_eq!(read.stdout, b"unique remote text");
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(f.wires().len(), count);
}

#[test]
fn binary_larger_than_one_envelope_moves_and_deletes_with_exact_bytes() {
    let mut f = Fixture::new(false);
    let bytes: Vec<u8> = (0..(2 * 1024 * 1024 + 17))
        .map(|i| (i % 256) as u8)
        .collect();
    fs::write(&f.input, &bytes).unwrap();
    success(cli(
        &f.a,
        &[
            "create",
            "unknown.xyz",
            "--id",
            "binary",
            "--operation-id",
            "create-binary",
            "--binary",
            "--input",
            f.input.to_str().unwrap(),
        ],
    ));
    success(sync(&f.a, &f.ca, &["once"]));
    success(sync(&f.b, &f.cb, &["once", "--max-pages", "40"]));
    let read = cli(&f.b, &["read", "--id", "binary", "--raw"]);
    assert!(read.status.success());
    assert_eq!(read.stdout, bytes);
    let old = success(cli(&f.a, &["read", "--id", "binary"]));
    let revision = old["entry"]["revision"].as_str().unwrap();
    success(cli(
        &f.a,
        &[
            "move",
            "moved.xyz",
            "--id",
            "binary",
            "--expected-revision",
            revision,
            "--operation-id",
            "move-binary",
        ],
    ));
    success(sync(&f.a, &f.ca, &["once"]));
    success(sync(&f.b, &f.cb, &["once", "--max-pages", "40"]));
    assert_eq!(fs::read(f.b.join("moved.xyz")).unwrap(), bytes);
    assert!(!f.b.join("unknown.xyz").exists());
    let moved = success(cli(&f.a, &["read", "--id", "binary"]));
    let revision = moved["entry"]["revision"].as_str().unwrap();
    success(cli(
        &f.a,
        &[
            "delete",
            "--id",
            "binary",
            "--expected-revision",
            revision,
            "--operation-id",
            "delete-binary",
        ],
    ));
    success(sync(&f.a, &f.ca, &["once"]));
    success(sync(&f.b, &f.cb, &["once", "--max-pages", "40"]));
    assert!(!f.b.join("moved.xyz").exists());
    let listed = success(cli(&f.b, &["list"]));
    assert!(!listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == "binary"));
    assert_eq!(
        success(sync(&f.b, &f.cb, &["status"]))["pending_envelope_sample"],
        0
    );
}

#[test]
fn enrollment_is_explicit_and_mode_is_part_of_exact_operation_retry() {
    let f = Fixture::new(false);
    success(sync(&f.a, &f.ca, &["fixture-enroll"])); // exact idempotent binding
    fs::write(&f.input, b"same bytes").unwrap();
    let args = [
        "create",
        "mode.dat",
        "--id",
        "mode",
        "--operation-id",
        "mode-create",
        "--input",
        f.input.to_str().unwrap(),
    ];
    assert!(!cli(&f.a, &args).status.success());
    let mut binary = args.to_vec();
    binary.push("--binary");
    let committed = success(cli(&f.a, &binary));
    let before = success(sync(&f.a, &f.ca, &["status"]));
    let before_read = success(cli(&f.a, &["read", "--id", "mode"]));
    // This is a separate process AFTER the explicit-mode command committed.
    // Generic apply must not bypass the composite identity fence by returning
    // an old plain-MutationRequest receipt when mode is omitted on retry.
    let omitted = cli(&f.a, &args);
    assert!(!omitted.status.success());
    assert!(omitted.stdout.is_empty());
    let error: Value = serde_json::from_slice(&omitted.stderr).unwrap();
    assert!(matches!(
        error["error"]["code"].as_str(),
        Some("invalid_mutation" | "idempotency_conflict")
    ));
    assert_eq!(success(sync(&f.a, &f.ca, &["status"])), before);
    assert_eq!(success(cli(&f.a, &["read", "--id", "mode"])), before_read);
    assert_eq!(fs::read(f.a.join("mode.dat")).unwrap(), b"same bytes");
    let retried = success(cli(&f.a, &binary));
    assert_eq!(retried["commit"], committed["commit"]);
    assert_eq!(success(sync(&f.a, &f.ca, &["status"])), before);
    let mut text = args.to_vec();
    text.push("--text");
    assert!(!cli(&f.a, &text).status.success());
    assert!(!cli(
        &f.a,
        &[
            "create",
            "both",
            "--id",
            "both",
            "--operation-id",
            "both",
            "--input",
            f.input.to_str().unwrap(),
            "--text",
            "--binary"
        ]
    )
    .status
    .success());
    assert!(!sync(
        &f.a,
        &f.ca,
        &[
            "fixture-bind-empty",
            "--id",
            "note",
            "--bootstrap-id",
            "old",
            "--expected-revision",
            "old"
        ]
    )
    .status
    .success());
}

#[test]
fn incomplete_binary_dependencies_are_durable_without_partial_publication_or_echo() {
    use zorid_core::{EntryId, EntryKind};
    use zorid_file_sync::v2::{Body, ContentSeed, Effect, EntryEvent, Payload};
    use zorid_file_sync::{
        ChunkPage, ChunkRef, EntryIdentity, Family, Location, Manifest, Scope, Sha256Digest,
    };
    use zorid_sync_protocol::{Header, UpdateId};
    let mut f = Fixture::new(false);
    let id = |s: &str| UpdateId::new(s).unwrap();
    let bytes = vec![0, 255, 1, 254];
    let page = ChunkPage {
        chunks: vec![ChunkRef {
            id: id("remote-chunk"),
            bytes: bytes.len() as u32,
            digest: Sha256Digest::of(&bytes),
        }],
    };
    let manifest = Manifest {
        bytes: bytes.len() as u64,
        digest: Sha256Digest::of(&bytes),
        pages: vec![page.reference(id("remote-page")).unwrap()],
    };
    let create = Body::Events {
        events: vec![EntryEvent {
            id: id("remote-create"),
            identity: EntryIdentity {
                entry_id: EntryId::new("remote").unwrap(),
                bootstrap_id: id("remote-create"),
            },
            parents: vec![],
            effect: Effect::Create {
                entry_kind: EntryKind::File,
                location: Location {
                    parent: None,
                    name: "remote.dat".into(),
                },
                content: Some(ContentSeed::Binary { manifest }),
            },
        }],
    };
    let publish = |f: &mut Fixture, name: &str, body: Body| {
        let update = id(name);
        let realm = RealmId::new("realm").unwrap();
        let vault = VaultId::new("vault").unwrap();
        let payload = Payload {
            family: Family::Files,
            format_version: 2,
            scope: Scope {
                realm_id: realm.clone(),
                vault_id: vault.clone(),
            },
            id: update.clone(),
            body,
        };
        let header = Header::new(
            realm,
            vault.clone(),
            update.clone(),
            DeviceId::new("fixture-sender").unwrap(),
            1,
        )
        .unwrap();
        let wire = zorid_crypto::seal(
            &header,
            &payload.encode().unwrap(),
            &zorid_crypto::VaultKey::from_bytes([7; 32]),
            &mut zorid_crypto::SystemEntropy,
        )
        .unwrap()
        .encode();
        f.admin.append(&f.token, &vault, &update, &wire).unwrap();
    };
    publish(&mut f, "remote-create", create);
    let pending = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(pending["family"]["cursor"]["after"], "1");
    assert_ne!(pending["family"]["pending_dependencies"], "0");
    assert!(!f.b.join("remote.dat").exists());
    assert_eq!(pending["pending_envelope_sample"], 0);
    // A separate CLI process resumes the already durable dependency obligation.
    publish(&mut f, "remote-page", Body::Page { page });
    let still_pending = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(still_pending["family"]["cursor"]["after"], "2");
    assert!(!f.b.join("remote.dat").exists());
    publish(
        &mut f,
        "remote-chunk",
        Body::Chunk {
            bytes: bytes.clone(),
        },
    );
    let complete = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(complete["family"]["cursor"]["after"], "3");
    assert_eq!(complete["family"]["pending_dependencies"], "0");
    assert_eq!(complete["server_accepted"], 0);
    let read = cli(&f.b, &["read", "--id", "remote", "--raw"]);
    assert!(read.status.success());
    assert_eq!(read.stdout, bytes);
    assert_eq!(fs::read(f.b.join("remote.dat")).unwrap(), bytes);
    assert_eq!(f.wires().len(), 3);
}

#[test]
fn another_accounts_device_cannot_receive_vault_updates_or_advance_cursor() {
    let mut f = Fixture::new(false);
    success(sync(&f.b, &f.cb, &["once"]));
    let before = success(sync(&f.b, &f.cb, &["status"]));
    write(&f.a, &f.input, "private-seed", "account-private content");
    success(sync(&f.a, &f.ca, &["once"]));
    let wires = f.wires();
    f.admin.create_account("outsider").unwrap();
    let outsider = f
        .admin
        .issue_device("outsider", &DeviceId::new("outsider-device").unwrap())
        .unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.cb).unwrap()).unwrap();
    config["bearer_token"] = json!(outsider.expose_secret());
    fs::write(&f.cb, serde_json::to_vec(&config).unwrap()).unwrap();
    for _ in 0..2 {
        let failed = sync(&f.b, &f.cb, &["once"]);
        assert!(!failed.status.success());
        let diagnostic = String::from_utf8_lossy(&failed.stderr);
        assert!(!diagnostic.contains(outsider.expose_secret()));
        let failure: Value = serde_json::from_slice(&failed.stderr).unwrap();
        assert_eq!(failure["error"]["code"], "sync_authorization_failed");
        let after = success(sync(&f.b, &f.cb, &["status"]));
        assert_eq!(after["family"]["cursor"], before["family"]["cursor"]);
        assert!(!f.b.join("note.md").exists());
        assert_eq!(f.wires(), wires);
    }
}
