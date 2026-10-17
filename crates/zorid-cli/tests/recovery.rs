#![cfg(unix)]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Child, Command, Output, Stdio},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
use zorid_crypto::{recovery::*, SystemEntropy, VaultKey};
use zorid_sync_protocol::{Cursor, DeviceId, RealmId, VaultId};
use zorid_sync_server::{BearerToken, RelayError, RelayStore};

const MAX_LOG_BYTES: usize = 1024 * 1024;
const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;

struct Capture {
    bytes: Vec<u8>,
    exceeded: bool,
}
fn capture(mut stream: impl Read + Send + 'static) -> JoinHandle<Capture> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut exceeded = false;
        let mut chunk = [0; 4096];
        loop {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            let retained = read.min(MAX_LOG_BYTES.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&chunk[..retained]);
            exceeded |= retained != read;
            // Continue draining after the cap so an unexpected noisy child cannot
            // deadlock on a full pipe. The caller fails the bounded capture.
        }
        Capture { bytes, exceeded }
    })
}

struct Server {
    address: std::net::SocketAddr,
    child: Option<Child>,
    stdout: Option<JoinHandle<Capture>>,
    stderr: Option<JoinHandle<Capture>>,
}
impl Server {
    fn start(database: &Path, ready: &Path) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "recovery_relay_process",
                "--nocapture",
            ])
            .env("ZORID_RECOVERY_RELAY_DB", database)
            .env("ZORID_RECOVERY_RELAY_READY", ready)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = capture(child.stdout.take().unwrap());
        let stderr = capture(child.stderr.take().unwrap());
        let mut server = Self {
            address: "127.0.0.1:0".parse().unwrap(),
            child: Some(child),
            stdout: Some(stdout),
            stderr: Some(stderr),
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(file) = fs::File::open(ready) {
                let mut bytes = Vec::new();
                file.take(129).read_to_end(&mut bytes).unwrap();
                assert!(bytes.len() <= 128, "oversized relay readiness record");
                if let Ok(address) = std::str::from_utf8(&bytes).unwrap().parse() {
                    server.address = address;
                    return server;
                }
            }
            assert!(
                server.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                "fixture relay exited before readiness"
            );
            assert!(Instant::now() < deadline, "fixture relay readiness timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn finish(&mut self) -> Vec<Capture> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            child.wait().unwrap();
        }
        [self.stdout.take(), self.stderr.take()]
            .into_iter()
            .flatten()
            .map(|thread| thread.join().unwrap())
            .collect()
    }
    fn stop(mut self) -> Vec<Capture> {
        self.finish()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

// Executes the real relay router in a separate process so stdout/stderr capture
// includes the service itself, without redirecting the test runner globally.
// No logging subscriber is installed by the fixture or current relay binary;
// captured output is supporting leak evidence, not proof about future logging.
#[test]
#[ignore = "subprocess helper, started explicitly by the recovery test"]
fn recovery_relay_process() {
    let database = std::env::var_os("ZORID_RECOVERY_RELAY_DB").unwrap();
    let ready = std::env::var_os("ZORID_RECOVERY_RELAY_READY").unwrap();
    let store = RelayStore::open(Path::new(&database), &RealmId::new("realm").unwrap()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ready = std::path::PathBuf::from(ready);
        let staging = ready.with_extension("pending");
        fs::write(&staging, listener.local_addr().unwrap().to_string()).unwrap();
        fs::rename(staging, ready).unwrap();
        axum::serve(
            listener,
            zorid_sync_server::rpc::router(store, &[]).unwrap(),
        )
        .await
        .unwrap();
    });
}

fn bounded_artifact(path: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .unwrap()
        .take((MAX_ARTIFACT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(
        bytes.len() <= MAX_ARTIFACT_BYTES,
        "artifact fixture exceeded scan bound"
    );
    bytes
}
fn assert_no_sentinels(bytes: &[u8], sentinels: &[&[u8]]) {
    for sentinel in sentinels {
        assert!(!sentinel.is_empty());
        let base64 = Zeroizing::new(STANDARD.encode(sentinel));
        let hex = Zeroizing::new(
            sentinel
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
        );
        for spelling in [*sentinel, base64.as_bytes(), hex.as_bytes()] {
            assert!(
                !bytes
                    .windows(spelling.len())
                    .any(|window| window == spelling),
                "fixture secret/plaintext sentinel found in relay artifact or captured output"
            );
        }
    }
}
fn inspect_artifacts_and_logs(paths: &[&Path], logs: &[Capture], sentinels: &[&[u8]]) {
    for path in paths {
        assert_no_sentinels(&bounded_artifact(path), sentinels);
    }
    for log in logs {
        assert!(!log.exceeded, "relay output exceeded capture bound");
        assert_no_sentinels(&log.bytes, sentinels);
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
    assert!(output.status.success(), "fixture CLI command failed");
    assert!(output.stderr.is_empty());
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["result"].clone()
}
fn sync(vault: &Path, credentials: &Path, command: &[&str]) -> Output {
    let mut args = vec!["sync", "--credentials", credentials.to_str().unwrap()];
    args.extend(command);
    cli(vault, &args)
}
fn initialize(vault: &Path, credentials: &Path) {
    fs::create_dir(vault).unwrap();
    success(cli(vault, &["init"]));
    success(sync(vault, credentials, &["fixture-enroll"]));
}
fn create_text(vault: &Path, input: &Path, content: &str) {
    fs::write(input, content).unwrap();
    success(cli(
        vault,
        &[
            "create",
            "note.md",
            "--id",
            "note",
            "--operation-id",
            "create",
            "--text",
            "--input",
            input.to_str().unwrap(),
        ],
    ));
}
fn create_binary(vault: &Path, input: &Path, bytes: &[u8]) {
    fs::write(input, bytes).unwrap();
    success(cli(
        vault,
        &[
            "create",
            "attachment.bin",
            "--id",
            "attachment",
            "--operation-id",
            "create-attachment",
            "--binary",
            "--input",
            input.to_str().unwrap(),
        ],
    ));
}
fn assert_binary(vault: &Path, expected: &[u8]) {
    let output = cli(vault, &["read", "--id", "attachment", "--raw"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let disk = fs::read(vault.join("attachment.bin")).unwrap();
    assert!(
        output.stdout == expected,
        "restored CLI attachment bytes differ"
    );
    assert!(
        disk == expected,
        "restored physical attachment bytes differ"
    );
    assert!(
        zorid_file_sync::Sha256Digest::of(&output.stdout)
            == zorid_file_sync::Sha256Digest::of(expected),
        "restored attachment digest differs"
    );
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
    key: &VaultKey,
) {
    fs::write(
        path,
        serde_json::to_vec(
            &json!({"version":2,"transport":"grpc","endpoint":format!("http://{}/",server.address),
        "realm_id":"realm","vault_id":"vault","server_epoch":epoch,"key_epoch":1,
        "key_base64":STANDARD.encode(key.expose_secret()),"bearer_token":token.expose_secret()}),
        )
        .unwrap(),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

// The receiver starts with no namespace entries or note/bootstrap bindings.
// It reconstructs text and a multi-chunk binary attachment from authenticated
// family envelopes. This does not cover all namespace history, key epochs or
// production setup.
#[test]
fn external_recovery_secret_restores_namespace_text_and_binary_from_managed_backup() {
    let original = tempfile::tempdir().unwrap();
    let backup = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let clean = tempfile::tempdir().unwrap();
    let realm = RealmId::new("realm").unwrap();
    let vault = VaultId::new("vault").unwrap();
    let device = DeviceId::new("original-device").unwrap();
    let context = RecoveryContext::new(realm.clone(), vault.clone(), 1).unwrap();
    let key = VaultKey::generate(&mut SystemEntropy).unwrap();
    let recovery = RecoveryKey::generate(&mut SystemEntropy).unwrap();
    let bundle = seal_recovery_bundle(&context, &key, &recovery, &mut SystemEntropy).unwrap();
    let bundle_path = backup.path().join("vault-key.zrbk");
    fs::write(&bundle_path, &bundle).unwrap();
    // External recovery secret is physically separate from the server backup.
    let secret_path = external.path().join("recovery-secret");
    fs::write(&secret_path, recovery.expose_secret()).unwrap();
    fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o600)).unwrap();

    let db = original.path().join("relay.db");
    let mut store = RelayStore::open(&db, &realm).unwrap();
    store.create_account("fixture").unwrap();
    store.create_vault(&vault).unwrap();
    store.grant_access("fixture", &vault, true).unwrap();
    let old_token = store.issue_device("fixture", &device).unwrap();
    let old_epoch = store.identity().unwrap().server_epoch;
    let mut admin = RelayStore::open(&db, &realm).unwrap();
    drop(store);
    let server = Server::start(&db, &original.path().join("relay-ready"));
    let local = original.path().join("local-vault");
    let old_credentials = original.path().join("credentials.json");
    let input = original.path().join("input");
    credentials(&old_credentials, &server, &old_epoch, &old_token, &key);
    initialize(&local, &old_credentials);
    let expected = "recovery-private-sentinel-6b7d97a4: \u{feff}Unicode 🦀\r\n";
    create_text(&local, &input, expected);
    // Three chunks, all byte values (including NUL/invalid UTF-8), and an uneven
    // final chunk exercise attachment reconstruction rather than text coercion.
    let binary: Vec<u8> = (0..zorid_file_sync::MAX_CHUNK_BYTES * 2 + 19)
        .map(|i| (i as u8).wrapping_add((i / zorid_file_sync::MAX_CHUNK_BYTES) as u8))
        .collect();
    create_binary(&local, &input, &binary);
    let uploaded = success(sync(&local, &old_credentials, &["once"]))["server_accepted"]
        .as_u64()
        .unwrap();
    assert!(
        uploaded >= 7,
        "expected text namespace/update and binary namespace/page/three chunks"
    );
    let backup_db = backup.path().join("relay-backup.db");
    admin.backup_to(&backup_db).unwrap();
    // A post-backup revocation must not be undone by restoring an older snapshot.
    admin.revoke_device(&device).unwrap();
    let logs = server.stop();
    inspect_artifacts_and_logs(
        &[&backup_db, &bundle_path],
        &logs,
        &[
            b"recovery-private-sentinel-6b7d97a4",
            key.expose_secret(),
            recovery.expose_secret(),
            old_token.expose_secret().as_bytes(),
        ],
    );
    drop(admin);
    drop(key);
    drop(recovery);
    let original_path = original.path().to_owned();
    original.close().unwrap();
    assert!(!original_path.exists()); // No original DB, credential, key or input access.
    assert_eq!(fs::read_dir(backup.path()).unwrap().count(), 2);

    let restored_db = clean.path().join("restored-relay.db");
    let identity = RelayStore::restore_new(&backup_db, &restored_db, &realm).unwrap();
    assert_ne!(identity.server_epoch, old_epoch);
    let mut restored = RelayStore::open(&restored_db, &realm).unwrap();
    let cursor = Cursor::start(identity.server_epoch.clone());
    assert!(matches!(
        restored.pull(&old_token, &vault, &cursor, None, 64),
        Err(RelayError::Unauthorized)
    ));
    // Privileged fixture provisioning models independent operator authorization;
    // the restored account/membership record is not accepted as proof of identity.
    let fresh_token = restored
        .issue_device("fixture", &DeviceId::new("recovered-device").unwrap())
        .unwrap();
    assert!(restored
        .pull(&fresh_token, &vault, &Cursor::start(old_epoch), None, 64)
        .is_err());
    assert_eq!(
        restored
            .pull(&fresh_token, &vault, &cursor, None, 64)
            .unwrap()
            .items
            .len(),
        uploaded as usize
    );

    let secret_bytes = Zeroizing::new(fs::read(&secret_path).unwrap());
    let recovery = RecoveryKey::from_bytes(secret_bytes.as_slice().try_into().unwrap());
    let wire = fs::read(&bundle_path).unwrap();
    assert!(open_recovery_bundle(
        &wire,
        &context,
        &RecoveryKey::generate(&mut SystemEntropy).unwrap()
    )
    .is_err());
    let recovered_key = open_recovery_bundle(&wire, &context, &recovery).unwrap();
    drop(secret_bytes);
    drop(restored);
    let server = Server::start(&restored_db, &clean.path().join("restored-ready"));
    let clean_vault = clean.path().join("fresh-local-vault");
    let clean_credentials = clean.path().join("new-credentials.json");
    credentials(
        &clean_credentials,
        &server,
        &identity.server_epoch,
        &fresh_token,
        &recovered_key,
    );
    initialize(&clean_vault, &clean_credentials);
    assert!(!clean_vault.join("note.md").exists());
    assert!(!clean_vault.join("attachment.bin").exists());
    let result = success(sync(&clean_vault, &clean_credentials, &["once"]));
    assert_eq!(result["locally_received"], uploaded);
    assert_eq!(result["server_accepted"], 0);
    assert_eq!(read(&clean_vault), expected.as_bytes());
    assert_binary(&clean_vault, &binary);
    // A fresh CLI process resumes its durable receipt without echoing the update.
    let replay = success(sync(&clean_vault, &clean_credentials, &["once"]));
    assert_eq!(replay["locally_received"], 0);
    assert_eq!(replay["server_accepted"], 0);
    assert_eq!(read(&clean_vault), expected.as_bytes());
    assert_binary(&clean_vault, &binary);
    assert_eq!(
        fs::read(clean_vault.join("note.md")).unwrap(),
        expected.as_bytes()
    );
    let logs = server.stop();
    inspect_artifacts_and_logs(
        &[&backup_db, &bundle_path],
        &logs,
        &[
            b"recovery-private-sentinel-6b7d97a4",
            recovered_key.expose_secret(),
            recovery.expose_secret(),
            old_token.expose_secret().as_bytes(),
            fresh_token.expose_secret().as_bytes(),
        ],
    );
}
