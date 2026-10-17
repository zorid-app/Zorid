// Real-process compatibility fixtures; no runtime or protocol implementation is replaced.
#![cfg(unix)]
#[path = "support/grpc_fixture.rs"]
mod grpc_fixture;
use axum::{
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
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
        atomic::{AtomicU8, Ordering},
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
    fault: Arc<AtomicU8>,
}
impl Server {
    fn start(store: RelayStore) -> Self {
        let fault = Arc::new(AtomicU8::new(0));
        let middleware_fault = fault.clone();
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
                let app =
                    zorid_sync_server::rpc::router(store, &[])
                        .unwrap()
                        .layer(middleware::from_fn(move |request: Request, next: Next| {
                            let fault = middleware_fault.clone();
                            async move {
                                let site = grpc_fixture::site(request.uri().path());
                                let response = next.run(request).await;
                                let mode = fault.load(Ordering::SeqCst);
                                if mode == 5 && site == 2 {
                                    return grpc_fixture::oversized_prefix(response).await;
                                }
                                if response.status() != StatusCode::OK
                                    || (mode != 1 && mode != site)
                                {
                                    return response;
                                }
                                // Patch the real generated RPC response after any durable Append.
                                grpc_fixture::patch_control(response, site, mode).await
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
            fault,
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
    fn new() -> Self {
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
        let server = Server::start(store);
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

fn status(vault: &Path, credentials: &Path) -> Value {
    success(sync(vault, credentials, &["status"]))
}
fn rejected(vault: &Path, credentials: &Path, token: &BearerToken, expected: &str) {
    let output = sync(vault, credentials, &["once"]);
    assert!(
        !output.status.success(),
        "incompatible input must not succeed"
    );
    assert!(output.stdout.is_empty());
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(!diagnostic.contains(token.expose_secret()));
    let failure: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(failure["error"]["code"], expected);
}
fn absent(vault: &Path) {
    assert!(!vault.join("note.md").exists());
    assert!(!cli(vault, &["read", "--id", "note"]).status.success());
}

#[test]
fn optional_hello_page_and_ack_extensions_allow_real_cli_convergence() {
    let mut f = Fixture::new();
    f.server.fault.store(1, Ordering::SeqCst);
    write(&f.a, &f.input, "seed", "optional extension content");
    let sent = success(sync(&f.a, &f.ca, &["once"]));
    assert_eq!(sent["pending_envelope_sample"], 0);
    let wires = f.wires();
    assert!(wires.len() >= 2);
    let received = success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(received["pending_envelope_sample"], 0);
    assert_eq!(received["server_accepted"], 0);
    assert_eq!(read(&f.b), b"optional extension content");
    assert_eq!(fs::read(f.b.join("note.md")).unwrap(), read(&f.b));
    // A second process consumes the same optional controls without generating echo.
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(f.wires(), wires);
}

#[test]
fn declared_oversized_hello_rejects_before_decode_upload_or_cursor_change() {
    let mut f = Fixture::new();
    write(&f.a, &f.input, "seed", "retained unsent content");
    let before = status(&f.a, &f.ca);
    f.server.fault.store(5, Ordering::SeqCst);
    for _ in 0..2 {
        rejected(&f.a, &f.ca, &f.token, "sync_response_limit");
        let after = status(&f.a, &f.ca);
        assert_eq!(after["pending_envelopes"], before["pending_envelopes"]);
        assert_eq!(after["family"]["cursor"], before["family"]["cursor"]);
        assert!(f.wires().is_empty());
        assert_eq!(read(&f.a), b"retained unsent content");
    }
    f.server.fault.store(0, Ordering::SeqCst);
    success(sync(&f.a, &f.ca, &["once"]));
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(read(&f.b), b"retained unsent content");
}

#[test]
fn required_hello_rejects_before_upload_and_preserves_pending_across_restart() {
    let mut f = Fixture::new();
    write(&f.a, &f.input, "seed", "unsent content");
    let before = status(&f.a, &f.ca);
    assert!(before["pending_envelope_sample"].as_u64().unwrap() >= 2);
    f.server.fault.store(2, Ordering::SeqCst);
    for _ in 0..2 {
        rejected(&f.a, &f.ca, &f.token, "sync_unsupported_protocol");
        let after = status(&f.a, &f.ca);
        assert_eq!(after["pending_envelopes"], before["pending_envelopes"]);
        assert_eq!(after["family"]["cursor"], before["family"]["cursor"]);
        assert!(f.wires().is_empty());
        assert_eq!(read(&f.a), b"unsent content");
        absent(&f.b);
    }
    f.server.fault.store(0, Ordering::SeqCst);
    success(sync(&f.a, &f.ca, &["once"]));
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(read(&f.b), b"unsent content");
}

#[test]
fn required_page_rejects_before_cursor_or_publication_and_retries_after_restart() {
    let mut f = Fixture::new();
    // Establish the empty durable cursor before introducing any remote updates.
    success(sync(&f.b, &f.cb, &["once"]));
    write(&f.a, &f.input, "seed", "page content");
    success(sync(&f.a, &f.ca, &["once"]));
    let wires = f.wires();
    let before = status(&f.b, &f.cb);
    f.server.fault.store(3, Ordering::SeqCst);
    for _ in 0..2 {
        rejected(&f.b, &f.cb, &f.token, "sync_unsupported_protocol");
        let after = status(&f.b, &f.cb);
        assert_eq!(after["family"]["cursor"], before["family"]["cursor"]);
        assert_eq!(after["family"]["cursor"]["after"], "0");
        assert_eq!(after["pending_envelope_sample"], 0);
        absent(&f.b);
        assert_eq!(f.wires(), wires);
    }
    f.server.fault.store(0, Ordering::SeqCst);
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(read(&f.b), b"page content");
    assert_eq!(f.wires(), wires);
}

#[test]
fn required_ack_retains_sealed_pending_and_retries_exact_wire_after_restart() {
    let mut f = Fixture::new();
    write(&f.a, &f.input, "seed", "ack content");
    f.server.fault.store(4, Ordering::SeqCst);
    rejected(&f.a, &f.ca, &f.token, "sync_unsupported_protocol");
    let first = f.wires();
    assert_eq!(first.len(), 1, "relay committed before incompatible ACK");
    let pending = status(&f.a, &f.ca);
    let count = pending["pending_envelope_sample"].as_u64().unwrap();
    assert!(count >= 2);
    assert_eq!(pending["pending_envelopes"][0]["sealed"], true);
    rejected(&f.a, &f.ca, &f.token, "sync_unsupported_protocol");
    let retry = status(&f.a, &f.ca);
    assert_eq!(retry["pending_envelopes"], pending["pending_envelopes"]);
    assert_eq!(retry["family"]["cursor"], pending["family"]["cursor"]);
    assert_eq!(
        f.wires(),
        first,
        "rejected ACK must preserve canonical envelope"
    );
    f.server.fault.store(0, Ordering::SeqCst);
    let completed = success(sync(&f.a, &f.ca, &["once"]));
    assert_eq!(completed["server_accepted"], count);
    assert_eq!(completed["pending_envelope_sample"], 0);
    assert_eq!(&f.wires()[..1], first.as_slice());
    success(sync(&f.b, &f.cb, &["once"]));
    assert_eq!(read(&f.b), b"ack content");
}

// Reopen the committed database between CLI processes; use the validated public
// ledger lookup rather than private SQL tables or outward status as a proxy.
fn ledger_snapshot(
    vault: &Path,
    updates: &[zorid_sync_protocol::UpdateId],
) -> Vec<Option<zorid_store::FamilyEnvelopeStatus>> {
    let store = zorid_store::Store::open(vault.join(".zorid/vault.sqlite")).unwrap();
    updates
        .iter()
        .map(|id| store.family_envelope_status(id).unwrap())
        .collect()
}

fn incompatible_payload_preserves_cursor_and_file(version: u32) {
    let mut f = Fixture::new();
    write(&f.a, &f.input, "seed", "preserve this content");
    success(sync(&f.a, &f.ca, &["once"]));
    success(sync(&f.b, &f.cb, &["once"]));
    let before = status(&f.b, &f.cb);
    let prior_file = fs::read(f.b.join("note.md")).unwrap();
    // Start with a real valid authored text payload. Only its version is unsupported.
    let mut future = None;
    for wire in f.wires() {
        let envelope = zorid_sync_protocol::Envelope::decode(&wire).unwrap();
        let header = envelope.header();
        let opened = zorid_crypto::OpenedEnvelope::open(
            &wire,
            &zorid_sync_protocol::ExpectedContext {
                realm_id: header.realm_id().clone(),
                vault_id: header.vault_id().clone(),
                update_id: header.update_id().clone(),
                key_epoch: 1,
            },
            &zorid_crypto::VaultKey::from_bytes([7; 32]),
        )
        .unwrap();
        let mut payload: Value = serde_json::from_slice(opened.plaintext()).unwrap();
        if payload["family"] == "text" {
            payload["format_version"] = json!(version);
            if version == 1 {
                payload.as_object_mut().unwrap().remove("namespace");
            }
            future = Some(serde_json::to_vec(&payload).unwrap());
            break;
        }
    }
    let update = zorid_sync_protocol::UpdateId::new("future-text-version").unwrap();
    let header = zorid_sync_protocol::Header::new(
        RealmId::new("realm").unwrap(),
        VaultId::new("vault").unwrap(),
        update.clone(),
        DeviceId::new("device-a").unwrap(),
        1,
    )
    .unwrap();
    let wire = zorid_crypto::seal(
        &header,
        &future.expect("authored text fixture"),
        &zorid_crypto::VaultKey::from_bytes([7; 32]),
        &mut zorid_crypto::SystemEntropy,
    )
    .unwrap()
    .encode();
    if version == 1 {
        // Prove this is a valid authenticated legacy text update, not merely malformed v2.
        zorid_client_sync::AuthenticatedText::open(
            &wire,
            &zorid_sync_protocol::ExpectedContext {
                realm_id: RealmId::new("realm").unwrap(),
                vault_id: VaultId::new("vault").unwrap(),
                update_id: update.clone(),
                key_epoch: 1,
            },
            &zorid_crypto::VaultKey::from_bytes([7; 32]),
        )
        .unwrap();
    }
    f.admin
        .append(&f.token, &VaultId::new("vault").unwrap(), &update, &wire)
        .unwrap();
    let relay_wires = f.wires();
    let ledger_ids: Vec<_> = relay_wires
        .iter()
        .map(|bytes| {
            zorid_sync_protocol::Envelope::decode(bytes)
                .unwrap()
                .header()
                .update_id()
                .clone()
        })
        .collect();
    let ledger_before = ledger_snapshot(&f.b, &ledger_ids);
    assert_eq!(ledger_ids.last(), Some(&update));
    assert!(ledger_before[..ledger_before.len() - 1]
        .iter()
        .all(Option::is_some));
    assert!(
        ledger_before.last().unwrap().is_none(),
        "rejected update starts absent"
    );
    for _ in 0..2 {
        rejected(&f.b, &f.cb, &f.token, "sync_unsupported_format");
        let after = status(&f.b, &f.cb);
        assert_eq!(after["family"]["cursor"], before["family"]["cursor"]);
        assert_eq!(after["pending_envelope_sample"], 0);
        assert_eq!(fs::read(f.b.join("note.md")).unwrap(), prior_file);
        assert_eq!(read(&f.b), prior_file);
        assert_eq!(
            ledger_snapshot(&f.b, &ledger_ids),
            ledger_before,
            "unsupported payload must not enter the shared ledger or alter prior receipts"
        );
        assert_eq!(
            f.wires(),
            relay_wires,
            "unsupported receive must not author echo"
        );
    }
}

#[test]
fn authenticated_future_payload_version_preserves_cursor_and_existing_file_on_restart() {
    incompatible_payload_preserves_cursor_and_file(u32::MAX);
}

#[test]
fn authenticated_legacy_v1_is_not_relabelled_as_current_namespace_activity() {
    incompatible_payload_preserves_cursor_and_file(1);
}
