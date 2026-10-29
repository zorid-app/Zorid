use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use zorid_native::NativeVault;

struct Host {
    _local_data: tempfile::TempDir,
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
        Self::spawn_options_timeout(root, config, initialize, 15)
    }
    fn spawn_options_timeout(
        root: &std::path::Path,
        config: Option<&std::path::Path>,
        initialize: bool,
        timeout_secs: u64,
    ) -> Self {
        let local_data = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_zorid-desktop-host"));
        command.env("ZORID_LOCAL_DATA_DIR", local_data.path());
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
                timer.recv_timeout(std::time::Duration::from_secs(timeout_secs)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                let mut child = watched.lock().unwrap();
                if child.try_wait().unwrap().is_none() {
                    let _ = child.kill();
                }
            }
        });
        Self {
            _local_data: local_data,
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
fn interactive_rescan_yields_before_remaining_imports_so_reads_and_checkpoint_cas_interleave() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("already-open.md"), b"existing editor bytes\n").unwrap();
    let mut host = Host::spawn_options(root.path(), None, true);
    assert_eq!(host.recv().0["ok"], true);
    let client = "10000000-0000-4000-8000-000000000001";
    let lease = host.request(json!({"method":"claim_client","client_id":client}), &[]).0["result"]["lease"].clone();
    assert!(lease.is_object());
    for index in 0..32 {
        std::fs::write(root.path().join(format!("new-{index:02}.md")), format!("new UTF-8 note {index}: é 🐈\n")).unwrap();
    }
    let first = host.request(json!({"method":"rescan"}), &[]).0;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["result"]["reconciliation"]["complete"], false,
        "one interactive continuation must return before consuming the whole new vault: {first}");
    assert!(first["result"]["imported"].as_u64().unwrap() <= 16, "{first}");
    let scope = json!({"vaultId":lease["local_store_id"],"clientId":client});
    let next = "20000000-0000-4000-8000-000000000001";
    host.send_header(json!({"version":1,"request_id":"1","lease":lease,"command":{"method":"read_path","path":"already-open.md"}}), &[]);
    let (read, bytes) = host.recv();
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(bytes, b"existing editor bytes\n");
    host.send_header(json!({"version":1,"request_id":"1","lease":lease,"command":{"method":"checkpoint_cas","scope":scope,"key":"between-import-quanta","expected_revision":null,"next_revision":next,"has_state":true}}), b"retained foreground draft");
    let (saved, _) = host.recv();
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(saved["result"]["checkpoint"]["revision"], next);
    let mut completed = false;
    for _ in 0..128 {
        let scan = host.request(json!({"method":"rescan"}), &[]).0;
        assert_eq!(scan["ok"], true, "{scan}");
        if scan["result"]["reconciliation"]["complete"] == true { completed = true; break; }
    }
    assert!(completed, "bounded continuations must eventually finish");
    host.send_header(json!({"version":1,"request_id":"1","lease":lease,"command":{"method":"checkpoint_load","scope":scope,"key":"between-import-quanta"}}), &[]);
    let (loaded, retained) = host.recv();
    assert_eq!(loaded["ok"], true, "{loaded}");
    assert_eq!(loaded["result"]["checkpoint"]["revision"], next);
    assert_eq!(retained, b"retained foreground draft");
    let listed = host.request(json!({"method":"list_snapshot"}), &[]).0;
    assert_eq!(listed["result"]["entries"].as_array().unwrap().len(), 33);
    host.close();
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
        "version":2,"transport":"grpc","endpoint":"http://127.0.0.1:9/","realm_id":"realm","vault_id":"vault",
        "server_epoch":"epoch","key_epoch":1,"key_base64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "bearer_token":"a".repeat(64)
    })).unwrap()).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut host = Host::spawn_config(root.path(), Some(&config));
    let startup = host.recv().0;
    assert_eq!(startup["ok"], true, "{startup}");
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
    // The explicit environment root keeps the actual process's recovery history
    // out of both this vault and the developer's real application profile.
    let local_vaults = host._local_data.path().join("vaults");
    let histories: Vec<_> = std::fs::read_dir(&local_vaults).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(histories.len(), 1);
    assert!(histories[0].join("recovery.sqlite").is_file());
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

#[test]
fn leased_protobuf_streams_publish_and_pin_more_than_inline_body_limit() {
    use sha2::{Digest, Sha256};
    use wire::{binary_command::Command as C, binary_result::Result as R};
    use zorid_proto::{zorid::stream::v1 as wire, Message};
    const CHUNK: usize = 128 * 1024;
    const COUNT: usize = 129;
    const FRAME: usize = CHUNK + 16 * 1024;
    fn exchange(host: &mut Host, client: &str, lease: &Value, version: u32, command: C) -> R {
        let bytes = wire::BinaryCommand {
            schema_version: version,
            required_features: vec![],
            command: Some(command),
        }
        .encode_to_vec();
        assert!(bytes.len() <= FRAME);
        host.send_header(
            json!({"version":1,"request_id":"1","lease":lease,
            "command":{"method":"binary","client_id":client}}),
            &bytes,
        );
        let (header, body) = host.recv();
        assert_eq!(header["ok"], true, "{header}");
        assert_eq!(header["result"]["binary"], true);
        assert!(!body.is_empty() && body.len() <= FRAME);
        let result = wire::BinaryResult::decode(body.as_slice()).unwrap();
        assert_eq!(result.schema_version, 1);
        assert!(result.required_features.is_empty());
        result.result.unwrap()
    }
    fn failure(value: R, code: wire::ErrorCode) {
        match value {
            R::Failure(error) => assert_eq!(error.code, code as i32),
            other => panic!("unexpected result {other:?}"),
        }
    }
    fn fill(bytes: &mut [u8], sequence: usize) {
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((sequence * 17 + index * 31) % 251) as u8;
        }
    }
    let root = tempfile::tempdir().unwrap();
    let mut host = Host::spawn_options_timeout(root.path(), None, true, 60);
    let startup = host.recv().0;
    assert_eq!(startup["ok"], true, "{startup}");
    assert_eq!(startup["result"]["max_binary_frame"], FRAME);
    let client = "10000000-0000-4000-8000-000000000001";
    let lease = host
        .request(json!({"method":"claim_client","client_id":client}), &[])
        .0["result"]["lease"]
        .clone();
    let identity = host.request(json!({"method":"identity"}), &[]).0;
    let owner = wire::StageOwner {
        local_store_id: identity["result"]["identity"]["local_store_id"]
            .as_str()
            .unwrap()
            .into(),
        client_id: client.into(),
    };
    let resume = || {
        C::Resume(wire::ResumeStage {
            owner: Some(owner.clone()),
            operation_id: "unknown-stream-operation".into(),
        })
    };
    failure(
        exchange(&mut host, client, &lease, 2, resume()),
        wire::ErrorCode::UnsupportedVersion,
    );
    failure(
        exchange(&mut host, client, &lease, 1, resume()),
        wire::ErrorCode::NotFound,
    );
    failure(
        exchange(
            &mut host,
            client,
            &lease,
            1,
            C::Resume(wire::ResumeStage {
                owner: Some(wire::StageOwner {
                    client_id: "another-client".into(),
                    ..owner.clone()
                }),
                operation_id: "unknown-stream-operation".into(),
            }),
        ),
        wire::ErrorCode::OwnerMismatch,
    );
    let total = (COUNT * CHUNK) as u64;
    let stage = match exchange(
        &mut host,
        client,
        &lease,
        1,
        C::Begin(wire::BeginStage {
            owner: Some(owner.clone()),
            operation_id: "large-stream-create".into(),
            expected_length: Some(total),
            target: Some(wire::BinaryTarget {
                target: Some(wire::binary_target::Target::Create(wire::BinaryCreate {
                    id: "large-stream-file".into(),
                    path: "large.bin".into(),
                })),
            }),
        }),
    ) {
        R::Begun(value) => value.stage.unwrap(),
        other => panic!("{other:?}"),
    };
    let mut bytes = vec![0; CHUNK];
    let mut expected = Sha256::new();
    for sequence in 0..COUNT {
        fill(&mut bytes, sequence);
        expected.update(&bytes);
        let receipt = exchange(
            &mut host,
            client,
            &lease,
            1,
            C::Append(wire::AppendChunk {
                stage: Some(stage.clone()),
                sequence: sequence as u32,
                offset: (sequence * CHUNK) as u64,
                data: bytes.clone(),
            }),
        );
        match receipt {
            R::Appended(value) => {
                assert_eq!(value.sequence, sequence as u32);
                assert_eq!(value.accepted_length, ((sequence + 1) * CHUNK) as u64);
            }
            other => panic!("{other:?}"),
        }
    }
    let expected = expected.finalize();
    assert!(matches!(
        exchange(
            &mut host,
            client,
            &lease,
            1,
            C::Seal(wire::SealStage {
                stage: Some(stage.clone()),
                final_length: total,
                expected_digest: Some(expected.to_vec())
            })
        ),
        R::Sealed(_)
    ));
    let committed = match exchange(
        &mut host,
        client,
        &lease,
        1,
        C::Commit(wire::CommitStage {
            stage: Some(stage.clone()),
        }),
    ) {
        R::Committed(value) => value,
        other => panic!("{other:?}"),
    };
    assert!(matches!(
        committed.projection.unwrap().status,
        Some(wire::projection_status::Status::Projected(_))
    ));
    let receipt = committed.receipt.unwrap();
    assert_eq!(receipt.operation_id, "large-stream-create");
    let revision = receipt
        .changes
        .iter()
        .find(|change| {
            change
                .after
                .as_ref()
                .is_some_and(|entry| entry.id == "large-stream-file")
        })
        .unwrap()
        .after
        .as_ref()
        .unwrap()
        .revision
        .clone();
    // Exact retry returns the original operation receipt, without republishing.
    match exchange(
        &mut host,
        client,
        &lease,
        1,
        C::Commit(wire::CommitStage { stage: Some(stage) }),
    ) {
        R::Committed(value) => assert_eq!(value.receipt.unwrap(), receipt),
        other => panic!("{other:?}"),
    }
    let (snapshot, body) = host.request(json!({"method":"list_snapshot"}), &[]);
    assert!(body.is_empty());
    assert_eq!(snapshot["result"]["entries"].as_array().unwrap().len(), 1);
    let row = snapshot["result"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["state"]["id"] == "large-stream-file")
        .unwrap();
    assert_eq!(row["state"]["revision"], revision);
    assert_eq!(row["presentation"]["size_bytes"], total);
    let (inline, body) = host.request(json!({"method":"read_path","path":"large.bin"}), &[]);
    assert_eq!(inline["error"]["code"], "stream_required");
    assert!(body.is_empty());
    let open = || {
        C::OpenRead(wire::OpenRead {
            owner: Some(owner.clone()),
            id: "large-stream-file".into(),
            expected_revision: Some(revision.clone()),
            read_id: "stable-open-request".into(),
        })
    };
    let pin = match exchange(&mut host, client, &lease, 1, open()) {
        R::ReadOpened(value) => {
            assert_eq!(value.content.unwrap().manifest.unwrap().bytes, total);
            value.read.unwrap()
        }
        other => panic!("{other:?}"),
    };
    assert_ne!(pin.read_id, "stable-open-request");
    match exchange(&mut host, client, &lease, 1, open()) {
        R::ReadOpened(value) => assert_eq!(value.read.unwrap(), pin),
        other => panic!("{other:?}"),
    }
    let mut actual = Sha256::new();
    for sequence in 0..COUNT {
        match exchange(
            &mut host,
            client,
            &lease,
            1,
            C::ReadChunk(wire::ReadChunk {
                read: Some(pin.clone()),
                offset: (sequence * CHUNK) as u64,
                max_bytes: CHUNK as u32,
            }),
        ) {
            R::ReadChunk(value) => {
                fill(&mut bytes, sequence);
                assert_eq!(value.data, bytes);
                assert_eq!(value.eof, sequence + 1 == COUNT);
                actual.update(&value.data);
            }
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(actual.finalize(), expected);
    let mut physical = std::fs::File::open(root.path().join("large.bin")).unwrap();
    let mut physical_hash = Sha256::new();
    let mut physical_length = 0u64;
    loop {
        let count = physical.read(&mut bytes).unwrap();
        if count == 0 {
            break;
        }
        physical_hash.update(&bytes[..count]);
        physical_length += count as u64;
    }
    assert_eq!(physical_length, total);
    assert_eq!(physical_hash.finalize(), expected);
    for _ in 0..2 {
        assert!(matches!(
            exchange(
                &mut host,
                client,
                &lease,
                1,
                C::CloseRead(wire::CloseRead {
                    read: Some(pin.clone())
                })
            ),
            R::ReadClosed(_)
        ));
    }
    let replacement = match exchange(&mut host, client, &lease, 1, open()) {
        R::ReadOpened(value) => value.read.unwrap(),
        other => panic!("{other:?}"),
    };
    assert_ne!(replacement.read_id, pin.read_id);
    failure(
        exchange(
            &mut host,
            client,
            &lease,
            1,
            C::ReadChunk(wire::ReadChunk {
                read: Some(pin),
                offset: 0,
                max_bytes: 1,
            }),
        ),
        wire::ErrorCode::NotFound,
    );
    assert!(matches!(
        exchange(
            &mut host,
            client,
            &lease,
            1,
            C::CloseRead(wire::CloseRead {
                read: Some(replacement)
            })
        ),
        R::ReadClosed(_)
    ));
    host.close();
}
