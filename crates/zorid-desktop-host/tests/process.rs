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
        let mut child = Command::new(env!("CARGO_BIN_EXE_zorid-desktop-host"))
            .args([std::ffi::OsStr::new("--vault"), root.as_os_str()])
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
