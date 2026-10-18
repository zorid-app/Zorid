use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_native::NativeVault;
struct Host {
    child: Arc<Mutex<Child>>,
    input: Option<ChildStdin>,
    output: ChildStdout,
    stop: Option<mpsc::Sender<()>>,
    watch: Option<std::thread::JoinHandle<()>>,
}
impl Host {
    fn start(root: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_zorid-desktop-host"))
            .args([std::ffi::OsStr::new("--vault"), root.as_os_str()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let watched = child.clone();
        let (stop, timer) = mpsc::channel();
        let watch = std::thread::spawn(move || {
            if timer
                .recv_timeout(std::time::Duration::from_secs(25))
                .is_err()
            {
                let _ = watched.lock().unwrap().kill();
            }
        });
        let mut host = Self {
            child,
            input,
            output,
            stop: Some(stop),
            watch: Some(watch),
        };
        assert_eq!(host.recv().0["ok"], true);
        host
    }
    fn recv(&mut self) -> (Value, Vec<u8>) {
        let mut prefix = [0; 8];
        self.output.read_exact(&mut prefix).unwrap();
        let h = u32::from_be_bytes(prefix[..4].try_into().unwrap()) as usize;
        let b = u32::from_be_bytes(prefix[4..].try_into().unwrap()) as usize;
        assert!(h <= 1024 * 1024 && b <= 16 * 1024 * 1024);
        let mut header = vec![0; h];
        let mut body = vec![0; b];
        self.output.read_exact(&mut header).unwrap();
        self.output.read_exact(&mut body).unwrap();
        (serde_json::from_slice(&header).unwrap(), body)
    }
    fn send(&mut self, command: Value, lease: Option<&Value>) {
        let header = serde_json::to_vec(
            &json!({"version":1,"request_id":"1","command":command,"lease":lease}),
        )
        .unwrap();
        let input = self.input.as_mut().unwrap();
        input
            .write_all(&(header.len() as u32).to_be_bytes())
            .unwrap();
        input.write_all(&0u32.to_be_bytes()).unwrap();
        input.write_all(&header).unwrap();
        input.flush().unwrap();
    }
    fn call(&mut self, command: Value, lease: Option<&Value>) -> (Value, Vec<u8>) {
        self.send(command, lease);
        self.recv()
    }
    fn documents(&mut self, client: &str, lease: &Value, command: Value) -> Result<Value, Value> {
        let(h,b)=self.call(json!({"method":"documents","client_id":client,"request":{"schemaVersion":1,"command":command}}),Some(lease));
        if h["ok"] != true {
            return Err(h["error"].clone());
        }
        assert_eq!(h["result"]["documents"], true);
        let reply: Value = serde_json::from_slice(&b).unwrap();
        Ok(reply["value"].clone())
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        drop(self.input.take());
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(watch) = self.watch.take() {
            let _ = watch.join();
        }
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}
fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn create(v: &mut NativeVault, name: &str, path: &str, text: &str) {
    v.apply(&MutationRequest {
        operation_id: OperationId::new(format!("create-{name}")).unwrap(),
        mutation: Mutation::Create {
            id: id(name),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(text.as_bytes().to_vec()),
        },
    })
    .unwrap();
}
fn build(v: &mut NativeVault) {
    let stage = v.begin_document_index().unwrap();
    for _ in 0..20 {
        if v.pump_document_index(&stage).unwrap().ready {
            v.publish_document_index(&stage).unwrap();
            return;
        }
    }
    panic!("fixture pumps exhausted")
}
#[test]
fn real_stdio_tasks_use_retained_sources_and_reject_forged_ast_and_foreign_or_expired_pins() {
    let root = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(root.path()).unwrap();
    let config = include_str!("../../../tests/fixtures/tasks/task-type.json");
    create(&mut vault, "type-file", "Task.yaml", config);
    create(
        &mut vault,
        "note",
        "Task.md",
        "---\ntype: type-task\nstate: active\n---\n",
    );
    vault.initialize_document_index().unwrap();
    build(&mut vault);
    drop(vault);
    let mut host = Host::start(root.path());
    let client = "10000000-0000-4000-8000-000000000001";
    let other = "10000000-0000-4000-8000-000000000002";
    let lease = host
        .call(json!({"method":"claim_client","client_id":client}), None)
        .0["result"]["lease"]
        .clone();
    let other_lease = host
        .call(json!({"method":"claim_client","client_id":other}), None)
        .0["result"]["lease"]
        .clone();
    let opened = host
        .documents(client, &lease, json!({"op":"open","pinId":"1"}))
        .unwrap();
    let query = json!({"op":"tasks","pinId":"1","typeIds":["type-file"],"options":{"clockMs":0,"timezone":"UTC","filter":"all"}});
    let result = host.documents(client, &lease, query.clone()).unwrap();
    assert_eq!(result["snapshot"], opened["snapshot"]);
    assert_eq!(result["value"]["types"][0]["status"]["key"], "state");
    assert_eq!(result["value"]["result"]["rows"][0]["statusId"], "active");
    assert_eq!(
        host.documents(other, &other_lease, query.clone())
            .unwrap_err()["code"],
        "snapshot_expired"
    );
    let mut writer = NativeVault::open(root.path()).unwrap();
    let expected = writer
        .read(&id("type-file"))
        .unwrap()
        .unwrap()
        .state
        .revision;
    writer
        .apply(&MutationRequest {
            operation_id: OperationId::new("edit-type").unwrap(),
            mutation: Mutation::Write {
                id: id("type-file"),
                expected,
                content: config.replace("\"Task\"", "\"Assignment\"").into_bytes(),
            },
        })
        .unwrap();
    build(&mut writer);
    drop(writer);
    let retained = host.documents(client, &lease, query.clone()).unwrap();
    assert_eq!(retained, result);
    host.documents(client, &lease, json!({"op":"close","pinId":"1"}))
        .unwrap();
    assert_eq!(
        host.documents(client, &lease, query.clone()).unwrap_err()["code"],
        "snapshot_expired"
    );
    host.documents(client, &lease, json!({"op":"open","pinId":"2"}))
        .unwrap();
    let mut next = query;
    next["pinId"] = json!("2");
    assert_eq!(
        host.documents(client, &lease, next.clone()).unwrap()["value"]["types"][0]["label"],
        "Assignment"
    );
    host.documents(client, &lease, json!({"op":"rebuild"}))
        .unwrap();
    assert_eq!(
        host.documents(client, &lease, next).unwrap_err()["code"],
        "snapshot_expired"
    );
    let release = host
        .call(json!({"method":"release_client","reference":lease}), None)
        .0;
    assert_eq!(release["ok"], true);
    // Raw malformed frames fail closed by terminating the existing host protocol.
    // Normal renderer requests are rejected earlier by the CJS strict codec.
    host.send(json!({"method":"documents","client_id":client,"request":{"schemaVersion":1,"command":{"op":"tasks","pinId":"2","typeIds":["type-file"],"configuration":{"id":"forged"}}}}),Some(&lease));
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = host.child.lock().unwrap().try_wait().unwrap() {
            assert_eq!(status.code(), Some(1));
            break;
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "malformed frame did not terminate host"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
