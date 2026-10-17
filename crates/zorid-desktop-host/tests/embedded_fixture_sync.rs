//! Disposable, literal-loopback host fixtures. No mobile/remote-sync proof.
#![cfg(unix)]
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use zorid_desktop_host::{
    EmbeddedFixtureSyncLimits, EmbeddedHost, TrustedFixtureSyncOptions,
    MAX_EMBEDDED_FIXTURE_RESULT_BYTES,
};
use zorid_native::NativeVault;

const CLIENT: &str = "10000000-0000-4000-8000-000000000001";
const OTHER: &str = "10000000-0000-4000-8000-000000000002";
const REALM: &str = "realm-secret-sentinel";
const VAULT: &str = "vault-secret-sentinel";

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
}
impl Fixture {
    fn new(enrolled: bool, endpoint: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        std::fs::create_dir(&root).unwrap();
        let mut vault = NativeVault::open(&root).unwrap();
        if enrolled {
            let scope = serde_json::from_value(json!({"realm_id":REALM,"vault_id":VAULT})).unwrap();
            vault.family_enroll(&scope).unwrap();
        }
        drop(vault);
        let config = temp.path().join("credentials-secret-sentinel.json");
        let fixture = Self { _temp: temp, root, config };
        fixture.write_config(endpoint, REALM);
        fixture
    }
    fn write_config(&self, endpoint: &str, realm: &str) {
        std::fs::write(&self.config, serde_json::to_vec(&json!({
            "version":2,"transport":"grpc","endpoint":endpoint,
            "realm_id":realm,"vault_id":VAULT,"server_epoch":"epoch-secret-sentinel",
            "key_epoch":1,"key_base64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "bearer_token":"a".repeat(64)
        })).unwrap()).unwrap();
        std::fs::set_permissions(&self.config, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn options(&self, client: &str) -> TrustedFixtureSyncOptions {
        TrustedFixtureSyncOptions::new(client, self.config.clone()).unwrap()
    }
    fn open(&self) -> EmbeddedHost {
        EmbeddedHost::open_local_with_fixture(&self.root, self.options(CLIENT)).unwrap()
    }
}
fn request(host: &mut EmbeddedHost, command: Value, lease: Option<&Value>, body: &[u8]) -> (Value, Vec<u8>) {
    let header = serde_json::to_vec(&json!({
        "version":1,"request_id":"1","command":command,"lease":lease
    })).unwrap();
    let mut frame = Vec::new();
    frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(body);
    let answer = host.dispatch(&frame).unwrap();
    let header_len = u32::from_be_bytes(answer[..4].try_into().unwrap()) as usize;
    let body_len = u32::from_be_bytes(answer[4..8].try_into().unwrap()) as usize;
    assert_eq!(answer.len(), 8 + header_len + body_len);
    (serde_json::from_slice(&answer[8..8 + header_len]).unwrap(), answer[8 + header_len..].to_vec())
}
fn claim(host: &mut EmbeddedHost, client: &str) -> Value {
    let answer = request(host, json!({"method":"claim_client","client_id":client}), None, &[]).0;
    assert_eq!(answer["ok"], true);
    answer["result"]["lease"].clone()
}
fn error_code(error: &Value, code: &str, uncertain: bool) {
    assert_eq!(error["code"], code);
    assert_eq!(error["commit_uncertain"], uncertain);
}
fn assert_redacted(value: &Value, fixture: &Fixture) {
    let text = serde_json::to_string(value).unwrap();
    for sentinel in [CLIENT, REALM, VAULT, "secret-sentinel", &"a".repeat(64),
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", fixture.root.to_str().unwrap(),
        fixture.config.to_str().unwrap()] {
        assert!(!text.contains(sentinel), "native fixture response was not redacted");
    }
    assert!(text.len() + 1024 <= MAX_EMBEDDED_FIXTURE_RESULT_BYTES);
}

#[test]
fn trusted_options_require_canonical_client_and_absolute_config() {
    for client in ["", "client", "10000000-0000-4000-8000-00000000000A", "10000000000040008000000000000001"] {
        let error = TrustedFixtureSyncOptions::new(client, PathBuf::from("/private/fixture.json")).err().unwrap();
        error_code(&error, "invalid_client_id", false);
    }
    let error = TrustedFixtureSyncOptions::new(CLIENT, PathBuf::from("relative.json")).err().unwrap();
    error_code(&error, "credentials_permissions", false);
}

#[test]
fn startup_never_initializes_missing_store_or_enrolls_unbound_root() {
    let fixture = Fixture::new(false, "http://127.0.0.1:9/");
    std::fs::write(fixture.root.join("Unimported.md"), "retained source").unwrap();
    let error = EmbeddedHost::open_local_with_fixture(&fixture.root, fixture.options(CLIENT)).err().unwrap();
    error_code(&error, "sync_binding_mismatch", false);
    let vault = NativeVault::open_existing(&fixture.root).unwrap();
    assert!(vault.family_status().unwrap().scope.is_none());
    assert!(vault.list().unwrap().is_empty());
    drop(vault);
    let missing = fixture._temp.path().join("missing");
    assert!(EmbeddedHost::open_local_with_fixture(&missing, fixture.options(CLIENT)).is_err());
    assert!(!missing.join(".zorid").exists());
}

#[test]
fn wrong_binding_and_unsafe_config_fail_before_scan_without_fallback() {
    let fixture = Fixture::new(true, "http://127.0.0.1:9/");
    std::fs::write(fixture.root.join("Unimported.md"), "retained source").unwrap();
    fixture.write_config("http://127.0.0.1:9/", "wrong-realm");
    let error = EmbeddedHost::open_local_with_fixture(&fixture.root, fixture.options(CLIENT)).err().unwrap();
    error_code(&error, "sync_binding_mismatch", false);
    let vault = NativeVault::open_existing(&fixture.root).unwrap();
    assert!(vault.list().unwrap().is_empty());
    assert_eq!(serde_json::to_value(vault.family_status().unwrap()).unwrap()["scope"]["realm_id"], REALM);
    drop(vault);
    fixture.write_config("http://127.0.0.1:9/", REALM);
    std::fs::set_permissions(&fixture.config, std::fs::Permissions::from_mode(0o644)).unwrap();
    let error = EmbeddedHost::open_local_with_fixture(&fixture.root, fixture.options(CLIENT)).err().unwrap();
    error_code(&error, "credentials_permissions", false);
    assert_redacted(&error, &fixture);
}

#[test]
fn remote_dns_symlink_and_inside_vault_credentials_remain_rejected() {
    let fixture = Fixture::new(true, "http://127.0.0.1:9/");
    for endpoint in ["http://192.0.2.1:9000/", "http://localhost:9000/", "https://127.0.0.1:9000/"] {
        fixture.write_config(endpoint, REALM);
        let error = EmbeddedHost::open_local_with_fixture(&fixture.root, fixture.options(CLIENT)).err().unwrap();
        error_code(&error, "fixture_endpoint_required", false);
        assert_redacted(&error, &fixture);
    }
    fixture.write_config("http://127.0.0.1:9/", REALM);
    let alias = fixture._temp.path().join("alias.json");
    std::os::unix::fs::symlink(&fixture.config, &alias).unwrap();
    let options = TrustedFixtureSyncOptions::new(CLIENT, alias).unwrap();
    let error = EmbeddedHost::open_local_with_fixture(&fixture.root, options).err().unwrap();
    error_code(&error, "credentials_permissions", false);
    let inside = fixture.root.join("credentials.json");
    std::fs::copy(&fixture.config, &inside).unwrap();
    let options = TrustedFixtureSyncOptions::new(CLIENT, inside).unwrap();
    let error = EmbeddedHost::open_local_with_fixture(&fixture.root, options).err().unwrap();
    error_code(&error, "credentials_inside_vault", false);
}

#[test]
fn native_status_requires_own_admission_is_redacted_and_does_not_connect() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let fixture = Fixture::new(true, &format!("http://{}/", listener.local_addr().unwrap()));
    let mut host = fixture.open();
    error_code(&host.fixture_sync_status().err().unwrap(), "client_not_admitted", false);
    error_code(&host.fixture_sync_once(EmbeddedFixtureSyncLimits { max_push: 1, max_pages: 1 }).err().unwrap(), "client_not_admitted", false);
    let _other = claim(&mut host, OTHER);
    error_code(&host.fixture_sync_status().err().unwrap(), "client_not_admitted", false);
    let lease = claim(&mut host, CLIENT);
    let (created, _) = request(&mut host, json!({"method":"create_text","client_id":CLIENT,
        "operation_id":"local-create","id":"entry-secret-sentinel","path":"Secret.md"}), Some(&lease), b"private note content");
    assert_eq!(created["ok"], true);
    let status = serde_json::to_value(host.fixture_sync_status().unwrap()).unwrap();
    assert_eq!(status["scope"], "fixture_families_v2");
    assert_ne!(status["pending_authored"], "0");
    assert_eq!(status["synced"], false);
    assert!(status.get("family").is_none());
    assert!(status.get("pending_envelopes").is_none());
    assert_redacted(&status, &fixture);
    for limits in [EmbeddedFixtureSyncLimits { max_push: 2, max_pages: 0 },
        EmbeddedFixtureSyncLimits { max_push: 0, max_pages: 2 }] {
        error_code(&host.fixture_sync_once(limits).err().unwrap(), "sync_limit", false);
    }
    let (read, body) = request(&mut host, json!({"method":"read","id":"entry-secret-sentinel"}), Some(&lease), &[]);
    assert_eq!(read["ok"], true);
    assert_eq!(body, b"private note content");
    let documents = request(&mut host, json!({"method":"documents","client_id":CLIENT,
        "request":{"schemaVersion":1,"command":{"op":"status"}}}), Some(&lease), &[]).0;
    // Preserve the Stage 4 dispatcher: an admitted semantic request is routed.
    assert_eq!(documents["ok"], true);
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
}

#[test]
fn renderer_fixture_and_raw_mutations_stay_blocked_with_or_without_lease() {
    let fixture = Fixture::new(true, "http://127.0.0.1:9/");
    let mut host = fixture.open();
    let lease = claim(&mut host, CLIENT);
    for reference in [None, Some(&lease)] {
        for command in [json!({"method":"fixture_family_status"}),
            json!({"method":"fixture_family_enroll"}),
            json!({"method":"fixture_family_once","max_push":1,"max_pages":1}),
            json!({"method":"apply","operation_id":"forbidden","mutation":{
                "type":"create","id":"forbidden","path":"Forbidden.md","kind":"file"}})] {
            let error = request(&mut host, command, reference, &[]).0;
            assert_eq!(error["ok"], false);
            error_code(&error["error"], "client_operation_unsupported", false);
        }
    }
    let mut ordinary = EmbeddedHost::open_local(&fixture.root).unwrap();
    error_code(&ordinary.fixture_sync_status().err().unwrap(), "fixture_sync_not_configured", false);
}

#[test]
fn lease_generation_belongs_to_exact_host_and_is_rechecked_after_release() {
    let fixture = Fixture::new(true, "http://127.0.0.1:9/");
    let mut first = fixture.open();
    let mut second = fixture.open();
    let first_lease = claim(&mut first, CLIENT);
    let competing = request(&mut second, json!({"method":"claim_client","client_id":CLIENT}), None, &[]).0;
    assert_eq!(competing["error"]["code"], "client_in_use");
    error_code(&second.fixture_sync_status().err().unwrap(), "client_not_admitted", false);
    let released = request(&mut first, json!({"method":"release_client","reference":first_lease.clone()}), None, &[]).0;
    assert_eq!(released["ok"], true);
    error_code(&first.fixture_sync_status().err().unwrap(), "client_not_admitted", false);
    let next_lease = claim(&mut second, CLIENT);
    assert_ne!(first_lease["token"], next_lease["token"]);
    assert!(second.fixture_sync_status().is_ok());
    let stale = request(&mut second, json!({"method":"identity"}), Some(&first_lease), &[]).0;
    assert_eq!(stale["error"]["code"], "client_not_admitted");
}

#[test]
fn replaced_consumer_lock_invalidates_native_status() {
    let fixture = Fixture::new(true, "http://127.0.0.1:9/");
    let mut host = fixture.open();
    let _lease = claim(&mut host, CLIENT);
    let lock = fixture.root.join(".zorid").join(format!("client-{CLIENT}.lock"));
    std::fs::rename(&lock, lock.with_extension("retained")).unwrap();
    std::fs::write(&lock, []).unwrap();
    std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o600)).unwrap();
    error_code(&host.fixture_sync_status().err().unwrap(), "unsafe_path", false);
}

#[test]
fn offline_once_is_uncertain_and_retains_same_host_and_authored_state() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", port.local_addr().unwrap());
    drop(port);
    let fixture = Fixture::new(true, &endpoint);
    let mut host = fixture.open();
    let lease = claim(&mut host, CLIENT);
    assert_eq!(request(&mut host, json!({"method":"create_text","client_id":CLIENT,
        "operation_id":"offline-create","id":"offline-entry","path":"Offline.md"}), Some(&lease), b"retained").0["ok"], true);
    let before = serde_json::to_value(host.fixture_sync_status().unwrap()).unwrap();
    let error = host.fixture_sync_once(EmbeddedFixtureSyncLimits { max_push: 1, max_pages: 1 }).err().unwrap();
    error_code(&error, "sync_transport", true);
    assert_redacted(&error, &fixture);
    assert_eq!(serde_json::to_value(host.fixture_sync_status().unwrap()).unwrap(), before);
    assert_eq!(request(&mut host, json!({"method":"read","id":"offline-entry"}), Some(&lease), &[]).1, b"retained");
}
