//! Actual stdio boundary: foreground requests never select periodic history work.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use zorid_core::VaultPath;
use zorid_desktop_host::EmbeddedHost;
use zorid_native::NativeVault;

struct Host {
    child: Arc<Mutex<Child>>,
    input: Option<ChildStdin>,
    output: ChildStdout,
    sequence: u32,
    stop: Option<mpsc::Sender<()>>,
    watchdog: Option<std::thread::JoinHandle<()>>,
}
impl Host {
    fn start(root: &std::path::Path, data: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_zorid-desktop-host"))
            .env("ZORID_LOCAL_DATA_DIR", data)
            .arg("--vault")
            .arg(root)
            .arg("--initialize-local")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let watched = Arc::clone(&child);
        let (stop, timer) = mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            if matches!(
                timer.recv_timeout(std::time::Duration::from_secs(30)),
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
            sequence: 0,
            stop: Some(stop),
            watchdog: Some(watchdog),
        }
    }
    fn receive(&mut self) -> (Value, Vec<u8>) {
        let mut prefix = [0; 8];
        self.output.read_exact(&mut prefix).unwrap();
        let header_len = u32::from_be_bytes(prefix[..4].try_into().unwrap()) as usize;
        let body_len = u32::from_be_bytes(prefix[4..].try_into().unwrap()) as usize;
        assert!(header_len > 0 && header_len <= 1024 * 1024);
        assert!(body_len <= 32 * 1024 * 1024);
        let mut header = vec![0; header_len];
        let mut body = vec![0; body_len];
        self.output.read_exact(&mut header).unwrap();
        self.output.read_exact(&mut body).unwrap();
        (serde_json::from_slice(&header).unwrap(), body)
    }
    fn request(&mut self, command: Value, lease: Option<&Value>, body: &[u8]) -> (Value, Vec<u8>) {
        self.sequence += 1;
        let mut header =
            json!({"version":1,"request_id":self.sequence.to_string(),"command":command});
        if let Some(lease) = lease {
            header["lease"] = lease.clone();
        }
        let header = serde_json::to_vec(&header).unwrap();
        let input = self.input.as_mut().unwrap();
        input
            .write_all(&(header.len() as u32).to_be_bytes())
            .unwrap();
        input.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        input.write_all(&header).unwrap();
        input.write_all(body).unwrap();
        input.flush().unwrap();
        self.receive()
    }
    fn close(&mut self) {
        drop(self.input.take());
        loop {
            if let Some(status) = self.child.lock().unwrap().try_wait().unwrap() {
                assert!(status.success(), "{status}");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
        let mut child = self.child.lock().unwrap();
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

#[test]
fn real_hello_read_and_checkpoint_reply_leave_periodic_history_for_explicit_idle_command() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let bytes = b"existing foreground note\n";
    std::fs::write(root.path().join("Note.md"), bytes).unwrap();
    // Seed source authority without recovery so a later no-change open cannot be
    // mistaken for a touched-note save/reconciliation snapshot.
    drop(EmbeddedHost::open_local(root.path()).unwrap());
    let vault = NativeVault::open_existing(root.path()).unwrap();
    let entry = vault
        .read_path(&VaultPath::new("Note.md").unwrap())
        .unwrap()
        .unwrap()
        .state
        .id;
    drop(vault);
    let mut host = Host::start(root.path(), data.path());
    let (hello, body) = host.receive();
    assert_eq!(hello["ok"], true, "{hello}");
    assert!(body.is_empty());
    assert!(hello["result"]["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "local_recovery_maintenance"));
    let history_command =
        json!({"method":"recovery_list","entry_id":entry,"limit":10,"before":null});
    let history = host.request(history_command.clone(), None, &[]).0;
    assert_eq!(history["ok"], true, "{history}");
    assert_eq!(history["result"]["versions"].as_array().unwrap().len(), 0);
    let client = "10000000-0000-4000-8000-000000000003";
    let claimed = host
        .request(
            json!({"method":"claim_client","client_id":client}),
            None,
            &[],
        )
        .0;
    assert_eq!(claimed["ok"], true, "{claimed}");
    let lease = &claimed["result"]["lease"];
    let scope = json!({"vaultId":lease["local_store_id"],"clientId":client});
    let (read, returned) = host.request(
        json!({"method":"read_path","path":"Note.md"}),
        Some(lease),
        &[],
    );
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(returned, bytes);
    let saved=host.request(json!({"method":"checkpoint_cas","scope":scope,"key":"foreground-draft","expected_revision":null,"next_revision":"20000000-0000-4000-8000-000000000003","has_state":true}),Some(lease),b"independent draft").0;
    assert_eq!(saved["ok"], true, "{saved}");
    let (loaded, draft) = host.request(
        json!({"method":"checkpoint_load","scope":scope,"key":"foreground-draft"}),
        Some(lease),
        &[],
    );
    assert_eq!(loaded["ok"], true, "{loaded}");
    assert_eq!(draft, b"independent draft");
    let forbidden = host
        .request(
            json!({"method":"local_recovery_maintenance"}),
            Some(lease),
            &[],
        )
        .0;
    assert_eq!(forbidden["error"]["code"], "client_operation_unsupported");
    assert_eq!(forbidden["error"]["commit_uncertain"], false);
    let malformed = host
        .request(
            json!({"method":"local_recovery_maintenance"}),
            None,
            b"not a body command",
        )
        .0;
    assert_eq!(malformed["error"]["code"], "unexpected_body");
    let history = host.request(history_command.clone(), None, &[]).0;
    assert_eq!(history["result"]["versions"].as_array().unwrap().len(), 0);
    let tick = host
        .request(json!({"method":"local_recovery_maintenance"}), None, &[])
        .0;
    assert_eq!(tick["ok"], true, "{tick}");
    assert_eq!(tick["result"].as_object().unwrap().len(), 5);
    assert_eq!(
        tick["result"],
        json!({"available":true,"ran":true,"pending":true,"failed_notes":0,"retry_after_ms":1000})
    );
    let history = host.request(history_command, None, &[]).0;
    assert_eq!(history["result"]["versions"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read(root.path().join("Note.md")).unwrap(), bytes);
    host.close();
}
