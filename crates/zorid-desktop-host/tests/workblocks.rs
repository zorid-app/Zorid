#![cfg(any(target_os = "macos", target_os = "linux"))]
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use zorid_desktop_host::EmbeddedHost;
struct ProcessCleanup {
    child: Arc<Mutex<std::process::Child>>,
    stop: Option<mpsc::Sender<()>>,
    watchdog: Option<std::thread::JoinHandle<()>>,
}
impl Drop for ProcessCleanup {
    fn drop(&mut self) {
        {
            let mut child = self.child.lock().unwrap();
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
    }
}
fn frame(command: Value, lease: Option<Value>, body: &[u8]) -> Vec<u8> {
    let h =
        serde_json::to_vec(&json!({"version":1,"request_id":"1","command":command,"lease":lease}))
            .unwrap();
    let mut b = Vec::new();
    b.extend_from_slice(&(h.len() as u32).to_be_bytes());
    b.extend_from_slice(&(body.len() as u32).to_be_bytes());
    b.extend_from_slice(&h);
    b.extend_from_slice(body);
    b
}
fn recv(output: &mut impl Read) -> (Value, Vec<u8>) {
    let mut len = [0u8; 8];
    output.read_exact(&mut len).unwrap();
    let hn = u32::from_be_bytes(len[..4].try_into().unwrap()) as usize;
    let bn = u32::from_be_bytes(len[4..].try_into().unwrap()) as usize;
    assert!(hn <= 1024 * 1024 && bn <= 4 * 1024 * 1024);
    let mut h = vec![0; hn];
    let mut b = vec![0; bn];
    output.read_exact(&mut h).unwrap();
    output.read_exact(&mut b).unwrap();
    (serde_json::from_slice(&h).unwrap(), b)
}
fn request(
    host: &mut EmbeddedHost,
    command: Value,
    lease: Option<Value>,
    body: &[u8],
) -> (Value, Vec<u8>) {
    recv(
        &mut host
            .dispatch(&frame(command, lease, body))
            .unwrap()
            .as_slice(),
    )
}
const CLIENT: &str = "20000000-0000-4000-8000-000000000001";
fn outer(command: Value) -> Value {
    json!({"method":"workblocks","client_id":CLIENT,"request":{"schemaVersion":1,"command":command}})
}
fn read() -> Value {
    json!({"op":"read","record":"one","generation":"generation"})
}
fn create() -> Value {
    json!({"op":"create","record":"one","generation":"generation","operation":"generation","range":{"start_ms":"-2208988800000","end_ms":"7258118400000","timezone":"UTC"},"title":"Focus"})
}
fn value(response: (Value, Vec<u8>)) -> Value {
    assert_eq!(response.0["ok"], true, "{}", response.0);
    assert_eq!(response.0["result"]["workblocks"], true);
    let b: Value = serde_json::from_slice(&response.1).unwrap();
    assert_eq!(b["schemaVersion"], 1);
    b["value"].clone()
}
#[test]
fn admitted_semantic_host_replay_release_reopen_and_strict_envelope() {
    let dir = tempfile::tempdir().unwrap();
    let mut h = EmbeddedHost::open_local(dir.path()).unwrap();
    let nolease = request(&mut h, outer(read()), None, &[]);
    assert_eq!(nolease.0["error"]["code"], "client_not_admitted");
    let claim = request(
        &mut h,
        json!({"method":"claim_client","client_id":CLIENT}),
        None,
        &[],
    )
    .0;
    let lease = claim["result"]["lease"].clone();
    let created = value(request(&mut h, outer(create()), Some(lease.clone()), &[]));
    let title = json!({"op":"title","record":"one","generation":"generation","operation":"title1","expectedRevision":created["revision"],"title":"Changed"});
    value(request(&mut h, outer(title), Some(lease.clone()), &[]));
    assert_eq!(
        value(request(&mut h, outer(create()), Some(lease.clone()), &[])),
        created
    );
    let mut forged = read();
    forged["owner"] = json!("other");
    assert!(h
        .dispatch(&frame(outer(forged), Some(lease.clone()), &[]))
        .is_err());
    let body = request(&mut h, outer(read()), Some(lease.clone()), b"forbidden");
    assert_eq!(body.0["error"]["code"], "unexpected_body");
    let query = json!({"op":"window","fromMs":"0","untilMs":"1000","limit":1,"byteLimit":1048576});
    let first = value(request(
        &mut h,
        outer(query.clone()),
        Some(lease.clone()),
        &[],
    ));
    assert!(first["cursor"].is_string());
    let released = request(
        &mut h,
        json!({"method":"release_client","reference":lease}),
        None,
        &[],
    );
    assert_eq!(released.0["ok"], true);
    let stale = request(&mut h, outer(read()), Some(lease), &[]);
    assert_eq!(stale.0["error"]["code"], "client_not_admitted");
    let claim = request(
        &mut h,
        json!({"method":"claim_client","client_id":CLIENT}),
        None,
        &[],
    )
    .0;
    let lease = claim["result"]["lease"].clone();
    let mut continuation = query;
    continuation["cursor"] = first["cursor"].clone();
    let expired = request(&mut h, outer(continuation), Some(lease), &[]);
    assert_eq!(expired.0["error"]["code"], "cursor_expired");
    drop(h);
    let mut h = EmbeddedHost::open_local(dir.path()).unwrap();
    let claim = request(
        &mut h,
        json!({"method":"claim_client","client_id":CLIENT}),
        None,
        &[],
    )
    .0;
    let lease = claim["result"]["lease"].clone();
    assert_eq!(
        value(request(&mut h, outer(create()), Some(lease.clone()), &[])),
        created
    );
    let read = value(request(&mut h, outer(read()), Some(lease), &[]));
    assert_eq!(read["block"]["titles"][0]["title"], "Changed");
}
#[test]
fn actual_stdio_process_creates_and_reopens_without_network() {
    let dir = tempfile::tempdir().unwrap();
    let mut original = None;
    for pass in 0..2 {
        let mut child = Command::new(env!("CARGO_BIN_EXE_zorid-desktop-host"))
            .arg("--vault")
            .arg(dir.path())
            .arg("--initialize-local")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let watched = child.clone();
        let (stop, timer) = mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            if timer
                .recv_timeout(std::time::Duration::from_secs(20))
                .is_err()
            {
                let _ = watched.lock().unwrap().kill();
            }
        });
        let cleanup = ProcessCleanup {
            child: child.clone(),
            stop: Some(stop),
            watchdog: Some(watchdog),
        };
        let (hello, _) = recv(&mut output);
        assert_eq!(hello["ok"], true);
        assert!(hello["result"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "workblocks"));
        input
            .write_all(&frame(
                json!({"method":"claim_client","client_id":CLIENT}),
                None,
                &[],
            ))
            .unwrap();
        input.flush().unwrap();
        let (claim, _) = recv(&mut output);
        let lease = claim["result"]["lease"].clone();
        input
            .write_all(&frame(outer(create()), Some(lease.clone()), &[]))
            .unwrap();
        input.flush().unwrap();
        let receipt = value(recv(&mut output));
        if pass == 0 {
            original = Some(receipt)
        } else {
            assert_eq!(Some(receipt), original)
        }
        input
            .write_all(&frame(outer(read()), Some(lease), &[]))
            .unwrap();
        input.flush().unwrap();
        let read = value(recv(&mut output));
        assert_eq!(read["block"]["titles"][0]["title"], "Focus");
        drop(input);
        drop(output);
        let status = loop {
            if let Some(status) = child.lock().unwrap().try_wait().unwrap() {
                break status;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        assert!(status.success());
        drop(cleanup);
    }
}
