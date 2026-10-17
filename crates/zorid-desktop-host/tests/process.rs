use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use zorid_native::NativeVault;

struct Host {
    child: Arc<Mutex<Child>>,
    input: Option<ChildStdin>,
    output: ChildStdout,
    stderr: ChildStderr,
    stop: Option<mpsc::Sender<()>>,
    watchdog: Option<std::thread::JoinHandle<()>>,
}
impl Host {
    fn spawn(root: &std::path::Path) -> Self {
        Self::spawn_config(root, None)
    }
    fn spawn_config(root: &std::path::Path, config: Option<&std::path::Path>) -> Self {
        Self::spawn_options(root, config, false)
    }
    fn spawn_options(
        root: &std::path::Path,
        config: Option<&std::path::Path>,
        initialize: bool,
    ) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_zorid-desktop-host"));
        command.args([std::ffi::OsStr::new("--vault"), root.as_os_str()]);
        if let Some(config) = config {
            command.arg("--fixture-sync-config").arg(config);
        }
        if initialize {
            command.arg("--initialize-local");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let watched = Arc::clone(&child);
        let (stop, timer) = mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            if matches!(
                timer.recv_timeout(std::time::Duration::from_secs(15)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                let mut child = watched.lock().unwrap();
                if child.try_wait().unwrap().is_none() {
                    let _ = child.kill();
                }
            }
        });
        Self {
            child,
            input,
            output,
            stderr,
            stop: Some(stop),
            watchdog: Some(watchdog),
        }
    }
    fn start(root: &std::path::Path) -> Self {
        let mut host = Self::spawn(root);
        let (header, body) = host.recv();
        assert_eq!(header["ok"], true, "{header}");
        assert!(body.is_empty());
        host
    }
    fn kill(&self) {
        self.child.lock().unwrap().kill().unwrap();
    }
    fn wait(&self) -> ExitStatus {
        // Never hold the Child mutex across a blocking wait: the watchdog must
        // remain able to terminate a stalled read/write/EOF regression.
        loop {
            if let Some(status) = self.child.lock().unwrap().try_wait().unwrap() {
                return status;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    fn send(&mut self, command: Value, body: &[u8]) {
        self.send_header(
            json!({"version":1,"request_id":"1","command":command}),
            body,
        );
    }
    fn send_header(&mut self, header: Value, body: &[u8]) {
        let header = serde_json::to_vec(&header).unwrap();
        let input = self.input.as_mut().unwrap();
        input
            .write_all(&(header.len() as u32).to_be_bytes())
            .unwrap();
        input.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        input.write_all(&header).unwrap();
        input.write_all(body).unwrap();
        input.flush().unwrap();
    }
    fn recv(&mut self) -> (Value, Vec<u8>) {
        let output = &mut self.output;
        let mut prefix = [0; 8];
        output.read_exact(&mut prefix).unwrap();
        let header_len = u32::from_be_bytes(prefix[..4].try_into().unwrap()) as usize;
        let body_len = u32::from_be_bytes(prefix[4..].try_into().unwrap()) as usize;
        assert!(header_len > 0 && header_len <= 1024 * 1024);
        assert!(body_len <= 16 * 1024 * 1024);
        let mut header = vec![0; header_len];
        let mut body = vec![0; body_len];
        output.read_exact(&mut header).unwrap();
        output.read_exact(&mut body).unwrap();
        (serde_json::from_slice(&header).unwrap(), body)
    }
    fn request(&mut self, command: Value, body: &[u8]) -> (Value, Vec<u8>) {
        self.send(command, body);
        self.recv()
    }
    fn close(&mut self) {
        drop(self.input.take());
        assert!(self.wait().success());
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.watchdog.take() {
            let _ = thread.join();
        }
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}
fn create(op: &str) -> Value {
    json!({"method":"apply","operation_id":op,"mutation":{"type":"create","id":"file","path":"note.md","kind":"file"}})
}
fn write(op: &str, revision: &Value) -> Value {
    json!({"method":"apply","operation_id":op,"mutation":{"type":"write","id":"file","expected":revision}})
}
fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    drop(NativeVault::open(root.path()).unwrap());
    root
}

#[test]
fn real_host_preserves_binary_and_replays_across_processes() {
    let root = fixture();
    let bytes = [0, 255, 13, 10, 0, 128];
    let mut first = Host::start(root.path());
    let (created, _) = first.request(create("create"), &bytes);
    assert_eq!(created["ok"], true);
    assert_eq!(created["result"]["projection"]["state"], "projected");
    assert!(created["result"]["commit"]["sequence"].is_string());
    first.close();
    let mut second = Host::start(root.path());
    let (retry, _) = second.request(create("create"), &bytes);
    assert_eq!(created, retry);
    let (read, returned) = second.request(json!({"method":"read","id":"file"}), &[]);
    assert_eq!(read["result"]["entry"]["id"], "file");
    assert_eq!(returned, bytes);
    let (collision, _) = second.request(create("create"), b"different");
    assert_eq!(collision["error"]["code"], "idempotency_conflict");
    assert_eq!(std::fs::read(root.path().join("note.md")).unwrap(), bytes);
    second.close();
}

#[test]
fn independent_hosts_compare_revisions_without_overwrite() {
    let root = fixture();
    let mut a = Host::start(root.path());
    let mut b = Host::start(root.path());
    assert_eq!(a.request(create("create"), b"base").0["ok"], true);
    let (read, _) = a.request(json!({"method":"read","id":"file"}), &[]);
    let revision = &read["result"]["entry"]["revision"];
    a.send(write("a", revision), b"from-a");
    b.send(write("b", revision), b"from-b");
    let aa = a.recv().0;
    let bb = b.recv().0;
    assert_ne!(aa["ok"], bb["ok"]);
    let loser = if aa["ok"] == true { bb } else { aa };
    assert_eq!(loser["error"]["code"], "revision_conflict");
    a.close();
    b.close();
}

#[test]
fn lost_response_does_not_duplicate_commit() {
    let root = fixture();
    let mut a = Host::start(root.path());
    a.send(create("lost"), b"durable");
    // Observe authoritative storage from another independent core, without
    // consuming the response. This bounds the wait and proves commit occurred.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut committed = None;
    while std::time::Instant::now() < deadline {
        let vault = NativeVault::open_existing(root.path()).unwrap();
        committed = vault
            .read(&zorid_core::EntryId::new("file").unwrap())
            .unwrap();
        if committed.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(committed.is_some());
    a.kill();
    a.wait();
    let mut b = Host::start(root.path());
    let (retry, _) = b.request(create("lost"), b"durable");
    assert_eq!(retry["ok"], true);
    assert_eq!(retry["result"]["commit"]["sequence"], "1");
    let (state, _) = b.request(json!({"method":"status"}), &[]);
    assert_eq!(state["result"]["pending_outbox"], "1");
    b.close();
}

#[test]
fn malformed_transport_exits_without_echoing_secrets_or_creating_files() {
    let root = fixture();
    let mut host = Host::start(root.path());
    let header =
        br#"{"version":1,"request_id":"1","root":"secret-root","command":{"method":"list"}}"#;
    let input = host.input.as_mut().unwrap();
    input
        .write_all(&(header.len() as u32).to_be_bytes())
        .unwrap();
    input.write_all(&0u32.to_be_bytes()).unwrap();
    input.write_all(header).unwrap();
    drop(host.input.take());
    assert!(!host.wait().success());
    let mut stderr = String::new();
    host.stderr.read_to_string(&mut stderr).unwrap();
    assert!(!stderr.contains("secret-root"));
    assert!(NativeVault::open_existing(root.path())
        .unwrap()
        .list()
        .unwrap()
        .is_empty());
}

#[test]
fn oversized_or_truncated_frame_fails_closed() {
    let root = fixture();
    for prefix in [[0xff; 8].to_vec(), vec![0, 0, 0]] {
        let mut host = Host::start(root.path());
        host.input.as_mut().unwrap().write_all(&prefix).unwrap();
        drop(host.input.take());
        assert!(!host.wait().success());
    }
    let mut next = Host::start(root.path());
    next.close();
}

#[test]
fn opening_unknown_vault_does_not_initialize_it() {
    let root = tempfile::tempdir().unwrap();
    let mut host = Host::spawn(root.path());
    let (header, bytes) = host.recv();
    assert_eq!(header["ok"], false);
    assert!(bytes.is_empty());
    host.close();
    assert!(!root.path().join(".zorid").exists());
    let mut stderr = String::new();
    host.stderr.read_to_string(&mut stderr).unwrap();
    assert!(stderr.is_empty());
}

#[test]
fn unsupported_version_and_unexpected_body_are_per_request_failures() {
    let root = fixture();
    let mut host = Host::start(root.path());
    host.send_header(
        json!({"version":2,"request_id":"2","command":{"method":"status"}}),
        &[],
    );
    let (reply, _) = host.recv();
    assert_eq!(reply["error"]["code"], "unsupported_protocol");
    let (reply, _) = host.request(json!({"method":"list"}), b"unwanted-secret");
    assert_eq!(reply["error"]["code"], "unexpected_body");
    let (reply, body) = host.request(json!({"method":"list"}), &[]);
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["result"]["entries"], json!([]));
    assert!(body.is_empty());
    host.close();
}

#[test]
fn coherent_path_metadata_and_journal_are_exposed_without_binary_json() {
    let root = fixture();
    let mut host = Host::start(root.path());
    let (before, _) = host.request(json!({"method":"list_snapshot"}), &[]);
    let cursor = before["result"]["cursor"].clone();
    let bytes = [0, 255, 13, 10];
    assert_eq!(host.request(create("metadata"), &bytes).0["ok"], true);
    let (read, body) = host.request(json!({"method":"read_path","path":"note.md"}), &[]);
    assert_eq!(read["result"]["entry"]["id"], "file");
    assert_eq!(read["result"]["presentation"]["id"], "file");
    assert_eq!(read["result"]["presentation"]["size_bytes"], 4);
    assert!(read["result"]["presentation"]["mtime_ms"].as_u64().unwrap() <= 9_007_199_254_740_991);
    assert_eq!(body, bytes);
    let (page, _) = host.request(
        json!({"method":"changes_after","cursor":cursor,"limit":10}),
        &[],
    );
    assert_eq!(page["ok"], true);
    assert_eq!(
        page["result"]["changes"][0]["origin"]["kind"],
        "local_command"
    );
    assert_eq!(
        page["result"]["changes"][0]["origin"]["operation_id"],
        "metadata"
    );
    assert_eq!(
        page["result"]["changes"][0]["entries"][0]["state"]["id"],
        "file"
    );
    let (missing, body) = host.request(json!({"method":"read_path","path":"absent.md"}), &[]);
    assert!(missing["result"]["entry"].is_null());
    assert!(body.is_empty());
    std::fs::write(root.path().join(".hidden"), [9, 0, 255]).unwrap();
    let (scan, _) = host.request(json!({"method":"rescan"}), &[]);
    assert_eq!(scan["result"]["complete"], true);
    let (hidden, body) = host.request(json!({"method":"read_path","path":".hidden"}), &[]);
    assert_eq!(hidden["ok"], true);
    assert_eq!(body, [9, 0, 255]);
    host.close();
}

#[cfg(unix)]
#[test]
fn family_commands_embed_native_core_and_retry_exact_mode_without_http() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture();
    let private = tempfile::tempdir().unwrap();
    let config = private.path().join("sync.json");
    std::fs::write(&config, serde_json::to_vec(&json!({
        "version":1,"endpoint":"http://127.0.0.1:9/","realm_id":"realm","vault_id":"vault",
        "server_epoch":"epoch","key_epoch":1,"key_base64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "bearer_token":"a".repeat(64)
    })).unwrap()).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut host = Host::spawn_config(root.path(), Some(&config));
    assert_eq!(host.recv().0["ok"], true);
    let enrolled = host
        .request(json!({"method":"fixture_family_enroll"}), &[])
        .0;
    assert_eq!(enrolled["ok"], true, "{enrolled}");
    assert_eq!(enrolled["result"]["family"]["scope"]["realm_id"], "realm");
    let command = json!({"method":"fixture_family_apply","family":{
        "version":1,"create_mode":"text","request":{"operation_id":"family-create",
        "mutation":{"type":"create","id":"file","path":"note.md","kind":"file"}}}});
    let first = host.request(command.clone(), b"family text").0;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["result"]["commit"]["operation_id"], "family-create");
    assert_eq!(
        host.request(command.clone(), b"family text").0["result"]["commit"],
        first["result"]["commit"]
    );
    let mut different = command.clone();
    different["family"]["create_mode"] = json!("binary");
    assert_eq!(
        host.request(different, b"family text").0["error"]["code"],
        "idempotency_conflict"
    );
    assert_eq!(
        host.request(command, b"different").0["error"]["code"],
        "idempotency_conflict"
    );
    let status = host
        .request(json!({"method":"fixture_family_status"}), &[])
        .0;
    assert_eq!(status["ok"], true, "{status}");
    assert_eq!(status["result"]["sync"]["synced"], false);
    assert!(
        status["result"]["sync"]["pending_envelope_sample"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(
        host.request(json!({"method":"read","id":"file"}), &[]).1,
        b"family text"
    );
    host.close();
}

#[test]
fn family_commands_require_explicit_startup_configuration() {
    let root = fixture();
    let mut host = Host::start(root.path());
    for method in ["fixture_family_enroll", "fixture_family_status"] {
        let reply = host.request(json!({"method":method}), &[]).0;
        assert_eq!(reply["error"]["code"], "fixture_sync_not_configured");
        assert_eq!(reply["error"]["commit_uncertain"], false);
    }
    assert_eq!(
        host.request(json!({"method":"identity"}), &[]).0["ok"],
        true
    );
    host.close();
}

#[test]
fn leased_editor_scope_cannot_invoke_generic_family_mutations() {
    let root = fixture();
    let mut host = Host::start(root.path());
    let lease = host
        .request(
            json!({"method":"claim_client","client_id":"10000000-0000-4000-8000-000000000001"}),
            &[],
        )
        .0["result"]["lease"]
        .clone();
    assert!(lease.is_object());
    for command in [
        json!({"method":"fixture_family_enroll"}),
        json!({"method":"fixture_family_once","max_push":0,"max_pages":0}),
        json!({"method":"fixture_family_apply","family":{"version":1,"create_mode":"binary","request":{
            "operation_id":"bypass","mutation":{"type":"create","id":"file","path":"file","kind":"file"}}}}),
    ] {
        host.send_header(
            json!({"version":1,"request_id":"1","command":command,"lease":lease}),
            &[],
        );
        assert_eq!(
            host.recv().0["error"]["code"],
            "client_operation_unsupported"
        );
    }
    host.close();
}

#[test]
fn default_local_startup_imports_bytes_and_mutates_without_relay_credentials() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("Empty")).unwrap();
    let text = b"\xef\xbb\xbfExisting note\n";
    let binary = [0, 255, 128, 1];
    std::fs::write(root.path().join("existing.md"), text).unwrap();
    std::fs::write(root.path().join("data.bin"), binary).unwrap();
    let mut host = Host::spawn_options(root.path(), None, true);
    assert_eq!(host.recv().0["ok"], true);
    let status = host.request(json!({"method":"local_family_status"}), &[]).0;
    assert_eq!(status["ok"], true, "{status}");
    let scope = status["result"]["family"]["scope"].clone();
    for (path, expected) in [
        ("existing.md", text.as_slice()),
        ("data.bin", binary.as_slice()),
    ] {
        let (reply, bytes) = host.request(json!({"method":"read_path","path":path}), &[]);
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(bytes, expected);
    }
    std::fs::write(root.path().join("external.txt"), b"Created outside Zorid").unwrap();
    let scan = host.request(json!({"method":"rescan"}), &[]).0;
    assert_eq!(scan["ok"], true, "{scan}");
    assert_eq!(scan["result"]["complete"], true, "{scan}");
    assert_eq!(scan["result"]["imported"], 1, "{scan}");
    assert_eq!(scan["result"]["reconciliation"]["imported"], 1);
    assert_eq!(
        host.request(json!({"method":"read_path","path":"external.txt"}), &[])
            .1,
        b"Created outside Zorid"
    );
    let client = "10000000-0000-4000-8000-000000000001";
    let lease = host
        .request(json!({"method":"claim_client","client_id":client}), &[])
        .0["result"]["lease"]
        .clone();
    let command = json!({"method":"file_command","client_id":client,"family":{"version":1,"create_mode":"text","request":{
        "operation_id":"local-create","mutation":{"type":"create","id":"local-file","path":"new.md","kind":"file"}}}});
    host.send_header(
        json!({"version":1,"request_id":"1","command":command,"lease":lease}),
        b"Local save",
    );
    let receipt = host.recv().0;
    assert_eq!(receipt["ok"], true, "{receipt}");
    host.close();
    assert_eq!(
        std::fs::read(root.path().join("new.md")).unwrap(),
        b"Local save"
    );
    assert!(root.path().join("Empty").is_dir());
    let mut reopened = Host::spawn_options(root.path(), None, true);
    assert_eq!(reopened.recv().0["ok"], true);
    assert_eq!(
        reopened
            .request(json!({"method":"local_family_status"}), &[])
            .0["result"]["family"]["scope"],
        scope
    );
    assert_eq!(
        reopened
            .request(json!({"method":"read_path","path":"new.md"}), &[])
            .1,
        b"Local save"
    );
    reopened.close();
}

#[test]
fn incomplete_discovery_keeps_host_live_without_claiming_first_import_ready_on_restart() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("retained.md");
    std::fs::write(&outside_file, b"Retain exact outside bytes").unwrap();
    let blocked_link = root.path().join("blocked-link.md");
    // An unsupported link deterministically keeps discovery incomplete without
    // relying on a directory-count ceiling or how quickly a scan can finish.
    std::os::unix::fs::symlink(&outside_file, &blocked_link).unwrap();
    let mut scope = Value::Null;
    for _ in 0..2 {
        let mut host = Host::spawn_options(root.path(), None, true);
        let startup = host.recv().0;
        assert_eq!(startup["ok"], true, "{startup}");
        let diagnostic = &startup["result"]["reconciliation"];
        assert_eq!(diagnostic["complete"], false, "{diagnostic}");
        assert_eq!(diagnostic["scanComplete"], false);
        assert!(diagnostic["issueCount"].as_u64().unwrap() > 0);
        let issues = diagnostic["issues"].as_array().unwrap();
        assert!(issues.len() <= 32);
        assert!(issues
            .iter()
            .any(|issue| issue["path"] == "blocked-link.md"));
        assert_eq!(diagnostic["imported"], 0);
        let current = host.request(json!({"method":"local_family_status"}), &[]).0["result"]
            ["family"]["scope"]
            .clone();
        assert!(
            !current.is_null(),
            "local authority must exist despite incomplete import"
        );
        if scope.is_null() {
            scope = current;
        } else {
            assert_eq!(scope, current);
        }
        let listed = host.request(json!({"method":"list_snapshot"}), &[]).0;
        assert_eq!(listed["ok"], true);
        assert!(listed["result"]["entries"].as_array().unwrap().is_empty());
        host.close();
    }
    assert_eq!(
        std::fs::read(&outside_file).unwrap(),
        b"Retain exact outside bytes"
    );
    assert!(std::fs::symlink_metadata(&blocked_link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_link(&blocked_link).unwrap(), outside_file);
}

#[test]
fn incomplete_later_discovery_keeps_previously_imported_notes_readable() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("usable.md"),
        b"Existing authority remains usable",
    )
    .unwrap();
    let mut host = Host::spawn_options(root.path(), None, true);
    assert_eq!(host.recv().0["result"]["reconciliation"]["complete"], true);
    host.close();
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("retained.md");
    std::fs::write(
        &outside_file,
        b"Outside bytes must never be imported or changed",
    )
    .unwrap();
    let blocked_link = root.path().join("blocked-link.md");
    std::os::unix::fs::symlink(&outside_file, &blocked_link).unwrap();
    let mut host = Host::spawn_options(root.path(), None, true);
    let startup = host.recv().0;
    assert_eq!(startup["ok"], true, "{startup}");
    let diagnostic = &startup["result"]["reconciliation"];
    assert_eq!(diagnostic["complete"], false);
    assert!(diagnostic["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|issue| issue["path"] == "blocked-link.md"));
    let (read, bytes) = host.request(json!({"method":"read_path","path":"usable.md"}), &[]);
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(bytes, b"Existing authority remains usable");
    let listed = host.request(json!({"method":"list_snapshot"}), &[]).0;
    assert_eq!(listed["ok"], true, "{listed}");
    let entries = listed["result"]["entries"].as_array().unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry["state"]["path"] == "usable.md"));
    assert!(!entries
        .iter()
        .any(|entry| entry["state"]["path"] == "blocked-link.md"));
    host.close();
    assert_eq!(
        std::fs::read(&outside_file).unwrap(),
        b"Outside bytes must never be imported or changed"
    );
    assert!(std::fs::symlink_metadata(&blocked_link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_link(&blocked_link).unwrap(), outside_file);
}
