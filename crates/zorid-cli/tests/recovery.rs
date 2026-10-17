#![cfg(unix)]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
use zorid_crypto::{recovery::*, SystemEntropy, VaultKey};
use zorid_sync_protocol::{Cursor, DeviceId, RealmId, VaultId};
use zorid_sync_server::{BearerToken, RelayError, RelayStore};

struct Server {
    address: std::net::SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(store: RelayStore) -> Self {
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
                let app = zorid_sync_server::http::router(store, &[]).unwrap();
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
    key: &VaultKey,
) {
    fs::write(
        path,
        serde_json::to_vec(
            &json!({"version":1,"endpoint":format!("http://{}/",server.address),
        "realm_id":"realm","vault_id":"vault","server_epoch":epoch,"key_epoch":1,
        "key_base64":STANDARD.encode(key.expose_secret()),"bearer_token":token.expose_secret()}),
        )
        .unwrap(),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

// This proves known-note recovery into a fresh local store. The fixture declares
// its note path/ID/bootstrap independently; text-v1 is not a namespace backup.
#[test]
fn external_recovery_secret_restores_known_note_from_managed_relay_backup() {
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
    drop(recovery);

    let db = original.path().join("relay.db");
    let mut store = RelayStore::open(&db, &realm).unwrap();
    store.create_account("fixture").unwrap();
    store.create_vault(&vault).unwrap();
    store.grant_access("fixture", &vault, true).unwrap();
    let old_token = store.issue_device("fixture", &device).unwrap();
    let old_epoch = store.identity().unwrap().server_epoch;
    let mut admin = RelayStore::open(&db, &realm).unwrap();
    let server = Server::start(store);
    let local = original.path().join("local-vault");
    let old_credentials = original.path().join("credentials.json");
    let input = original.path().join("input");
    credentials(&old_credentials, &server, &old_epoch, &old_token, &key);
    create(&local, &input);
    bind(&local, &old_credentials);
    let expected = "Recovered known note: \u{feff}Unicode 🦀\r\n";
    write(&local, &input, "seed-recovery", expected);
    assert_eq!(
        success(sync(&local, &old_credentials, &["once"]))["server_accepted"],
        1
    );
    let backup_db = backup.path().join("relay-backup.db");
    admin.backup_to(&backup_db).unwrap();
    // A post-backup revocation must not be undone by restoring an older snapshot.
    admin.revoke_device(&device).unwrap();
    drop(server);
    drop(admin);
    drop(key);
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
        1
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
    drop(recovery);
    let server = Server::start(restored);
    let clean_vault = clean.path().join("fresh-local-vault");
    let clean_credentials = clean.path().join("new-credentials.json");
    credentials(
        &clean_credentials,
        &server,
        &identity.server_epoch,
        &fresh_token,
        &recovered_key,
    );
    drop(recovered_key);
    let clean_input = clean.path().join("new-input");
    create(&clean_vault, &clean_input);
    bind(&clean_vault, &clean_credentials);
    let result = success(sync(&clean_vault, &clean_credentials, &["once"]));
    assert_eq!(result["locally_received"], 1);
    assert_eq!(result["server_accepted"], 0);
    assert_eq!(read(&clean_vault), expected.as_bytes());
    // A fresh CLI process resumes its durable receipt without echoing the update.
    let replay = success(sync(&clean_vault, &clean_credentials, &["once"]));
    assert_eq!(replay["locally_received"], 0);
    assert_eq!(replay["server_accepted"], 0);
    assert_eq!(read(&clean_vault), expected.as_bytes());
}
