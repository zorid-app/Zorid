#![cfg(any(target_os = "macos", target_os = "linux"))]

use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::Path,
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::mpsc::{self, Receiver, Sender},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const CHILD_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LOG_BYTES: usize = 1024 * 1024;

struct Capture {
    bytes: Vec<u8>,
    exceeded: bool,
}

fn capture(
    mut pipe: impl Read + Send + 'static,
    lines: Option<Sender<Vec<u8>>>,
) -> JoinHandle<Capture> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut line = Vec::new();
        let mut exceeded = false;
        let mut chunk = [0; 4096];
        loop {
            let count = pipe.read(&mut chunk).unwrap();
            if count == 0 {
                break;
            }
            let keep = count.min(MAX_LOG_BYTES.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&chunk[..keep]);
            if let Some(lines) = &lines {
                for byte in &chunk[..keep] {
                    if *byte == b'\n' {
                        let _ = lines.send(std::mem::take(&mut line));
                    } else {
                        line.push(*byte);
                    }
                }
            }
            exceeded |= keep != count;
            // Drain after the cap to prevent a noisy child blocking on its pipe.
        }
        Capture { bytes, exceeded }
    })
}

// Own every child and both pipe drainers, including when an assertion panics.
struct Running {
    child: Option<Child>,
    stdout: Option<JoinHandle<Capture>>,
    stderr: Option<JoinHandle<Capture>>,
    lines: Receiver<Vec<u8>>,
}

impl Running {
    fn spawn(root: &Path, args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_zorid"))
            .arg("--vault")
            .arg(root)
            .args(args)
            .env_remove("DISPLAY")
            .env_remove("ZORID_IPC_ENDPOINT")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (sender, lines) = mpsc::channel();
        let stdout = capture(child.stdout.take().unwrap(), Some(sender));
        let stderr = capture(child.stderr.take().unwrap(), None);
        Self {
            child: Some(child),
            stdout: Some(stdout),
            stderr: Some(stderr),
            lines,
        }
    }

    fn next_frame(&self) -> Value {
        let bytes = self
            .lines
            .recv_timeout(CHILD_TIMEOUT)
            .expect("CLI did not flush a JSONL watch frame before the deadline");
        serde_json::from_slice(&bytes).expect("watch frame must be a JSON object")
    }

    fn finish(mut self) -> Output {
        let deadline = Instant::now() + CHILD_TIMEOUT;
        let status = loop {
            if let Some(status) = self.child.as_mut().unwrap().try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "CLI subprocess exceeded deadline"
            );
            thread::sleep(Duration::from_millis(10));
        };
        self.child.take();
        self.output(status)
    }

    fn output(&mut self, status: ExitStatus) -> Output {
        let stdout = self.stdout.take().unwrap().join().unwrap();
        let stderr = self.stderr.take().unwrap().join().unwrap();
        assert!(!stdout.exceeded, "CLI exceeded stdout capture bound");
        assert!(!stderr.exceeded, "CLI exceeded stderr capture bound");
        Output {
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        for reader in [self.stdout.take(), self.stderr.take()]
            .into_iter()
            .flatten()
        {
            let _ = reader.join();
        }
    }
}

fn invoke(root: &Path, args: &[&str]) -> Output {
    Running::spawn(root, args).finish()
}

fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let frame: Value = serde_json::from_slice(&output.stdout).unwrap();
    result(&frame).clone()
}

fn result(frame: &Value) -> &Value {
    assert_eq!(frame["version"], 1);
    assert_eq!(frame["ok"], true, "{frame}");
    assert!(frame["result"].is_object(), "{frame}");
    &frame["result"]
}

fn init(root: &Path) {
    success(invoke(root, &["init"]));
}

fn create(root: &Path, path: &str, id: &str, bytes: &[u8]) -> Value {
    let input = tempfile::NamedTempFile::new().unwrap();
    fs::write(input.path(), bytes).unwrap();
    let created = success(invoke(
        root,
        &[
            "create",
            path,
            "--id",
            id,
            "--operation-id",
            &format!("create-{id}"),
            "--input",
            input.path().to_str().unwrap(),
        ],
    ));
    created["commit"]["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["after"]["id"] == id)
        .unwrap()["after"]
        .clone()
}

fn assert_search_counts(search: &Value) {
    for name in [
        "searched_files",
        "skipped_binary",
        "skipped_changed",
        "scanned_bytes",
    ] {
        assert!(search[name].as_u64().is_some(), "{name}: {search}");
    }
    assert!(search["truncated"].is_boolean());
    assert!(search["matches"].is_array());
}

fn watch_frames(output: Output) -> Vec<Value> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn assert_local_cycle(frame: &Value, cycle: u64) {
    let cycle_result = result(frame);
    assert_eq!(cycle_result["event"], "watch_cycle");
    assert_eq!(cycle_result["cycle"], cycle);
    assert_eq!(cycle_result["complete"], true, "{frame}");
    assert_eq!(cycle_result["scan"]["complete"], true, "{frame}");
    assert!(cycle_result["sync"].is_null());
    assert!(cycle_result["local"].is_object());
}

fn assert_stopped(frame: &Value, cycles: u64, reason: &str) {
    let stopped = result(frame);
    assert_eq!(stopped["event"], "watch_stopped");
    assert_eq!(stopped["cycles"], cycles);
    assert_eq!(stopped["reason"], reason);
}

#[test]
fn search_uses_committed_utf8_contents_and_never_implicitly_imports_files() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    let text = "prefix Needle α\nlowercase needle\nNeedle again\n";
    let entry = create(dir.path(), "custom.unknown", "custom", text.as_bytes());
    create(dir.path(), "other.md", "other", b"needle only\n");
    create(dir.path(), "binary.bin", "binary", &[0, 255, 128, 10]);
    fs::write(
        dir.path().join("custom.unknown"),
        b"uncommitted replacement\n",
    )
    .unwrap();
    fs::write(dir.path().join("not-imported.md"), b"Needle external\n").unwrap();

    let search = success(invoke(dir.path(), &["search", "Needle"]));
    assert_search_counts(&search);
    assert_eq!(search["searched_files"], 2);
    assert_eq!(search["skipped_binary"], 1);
    assert_eq!(search["skipped_changed"], 0);
    assert_eq!(search["truncated"], false);
    let matches = search["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2);
    for (found, line, snippet) in [
        (&matches[0], 1, "prefix Needle α"),
        (&matches[1], 3, "Needle again"),
    ] {
        assert_eq!(found["entry_id"], "custom");
        assert_eq!(found["path"], "custom.unknown");
        assert_eq!(found["revision"], entry["revision"]);
        assert_eq!(found["line"], line);
        assert_eq!(found["snippet"], snippet);
    }
    let listed = success(invoke(dir.path(), &["list"]));
    assert_eq!(listed["entries"].as_array().unwrap().len(), 3);
    assert_eq!(
        fs::read(dir.path().join("custom.unknown")).unwrap(),
        b"uncommitted replacement\n"
    );
}

#[test]
fn search_obeys_match_and_total_byte_limits() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    create(
        dir.path(),
        "one.md",
        "one",
        b"Needle first\nNeedle second\n",
    );
    create(dir.path(), "two.md", "two", b"Needle third\n");

    let limited = success(invoke(dir.path(), &["search", "Needle", "--limit", "1"]));
    assert_search_counts(&limited);
    assert_eq!(limited["matches"].as_array().unwrap().len(), 1);
    assert_eq!(limited["truncated"], true);

    let bounded = success(invoke(
        dir.path(),
        &["search", "Needle", "--max-total-bytes", "1"],
    ));
    assert_search_counts(&bounded);
    assert!(bounded["matches"].as_array().unwrap().is_empty());
    assert_eq!(bounded["truncated"], true);
    assert!(bounded["scanned_bytes"].as_u64().unwrap() <= 1);

    let zero = success(invoke(
        dir.path(),
        &["search", "Needle", "--max-total-bytes", "0"],
    ));
    assert_search_counts(&zero);
    assert!(zero["matches"].as_array().unwrap().is_empty());
    assert_eq!(zero["truncated"], true);
    assert_eq!(zero["scanned_bytes"], 0);
}

#[test]
fn search_rejects_invalid_arguments_and_does_not_initialize_storage() {
    let dir = tempfile::tempdir().unwrap();
    for (args, code, exit) in [
        (vec!["search", "Needle"], "vault_not_initialized", 4),
        (vec!["search"], "usage", 2),
        (vec!["search", ""], "usage", 2),
        (vec!["search", "Needle\nsecond line"], "usage", 2),
        (vec!["search", "Needle", "--limit", "0"], "usage", 2),
        (
            vec!["search", "Needle", "--max-total-bytes", "268435457"],
            "usage",
            2,
        ),
    ] {
        let output = invoke(dir.path(), &args);
        assert_eq!(output.status.code(), Some(exit));
        assert!(output.stdout.is_empty());
        let failure: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["error"]["code"], code);
        assert!(!dir.path().join(".zorid").exists());
    }
}

#[test]
fn local_watch_imports_offline_files_and_observes_edits_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    fs::write(
        dir.path().join("offline.custom"),
        b"first offline revision\n",
    )
    .unwrap();

    let first = Running::spawn(
        dir.path(),
        &["watch", "--interval-ms", "100", "--max-cycles", "2"],
    );
    assert_local_cycle(&first.next_frame(), 1);
    // Change the physical file while the foreground watcher is alive.
    fs::write(dir.path().join("live.md"), b"created between cycles\n").unwrap();
    let frames = watch_frames(first.finish());
    assert_eq!(frames.len(), 3);
    assert_local_cycle(&frames[0], 1);
    assert_local_cycle(&frames[1], 2);
    assert_stopped(&frames[2], 2, "max_cycles");

    let list = success(invoke(dir.path(), &["list"]));
    let entries = list["entries"].as_array().unwrap();
    let offline = entries
        .iter()
        .find(|entry| entry["path"] == "offline.custom")
        .unwrap();
    let offline_id = offline["id"].as_str().unwrap();
    let old_revision = offline["revision"].clone();
    assert!(entries.iter().any(|entry| entry["path"] == "live.md"));

    // No watcher, desktop, IPC endpoint or server is running for this edit.
    fs::write(
        dir.path().join("offline.custom"),
        b"second offline revision\n",
    )
    .unwrap();
    let frames = watch_frames(invoke(
        dir.path(),
        &["watch", "--interval-ms", "100", "--max-cycles", "1"],
    ));
    assert_eq!(frames.len(), 2);
    assert_local_cycle(&frames[0], 1);
    assert_stopped(&frames[1], 1, "max_cycles");
    let bytes = invoke(dir.path(), &["read", "--id", offline_id, "--raw"]);
    assert!(bytes.status.success());
    assert!(bytes.stderr.is_empty());
    assert_eq!(bytes.stdout, b"second offline revision\n");
    let list = success(invoke(dir.path(), &["list"]));
    let after = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == offline_id)
        .unwrap();
    assert_eq!(after["path"], "offline.custom");
    assert_ne!(after["revision"], old_revision);
}

#[test]
fn sigint_stops_watch_between_cycles_and_leaves_vault_usable() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());
    fs::write(dir.path().join("retained.md"), b"retained before signal\n").unwrap();
    let watch = Running::spawn(dir.path(), &["watch", "--interval-ms", "10000"]);
    assert_local_cycle(&watch.next_frame(), 1);
    let pid = watch.child.as_ref().unwrap().id();
    // The watch owns its signal handler by the time it flushes the first cycle.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT) }, 0);
    let frames = watch_frames(watch.finish());
    assert_eq!(frames.len(), 2);
    assert_local_cycle(&frames[0], 1);
    assert_stopped(&frames[1], 1, "signal");

    let search = success(invoke(dir.path(), &["search", "retained before signal"]));
    assert_eq!(search["matches"].as_array().unwrap().len(), 1);
    assert_eq!(search["matches"][0]["path"], "retained.md");
    assert_eq!(
        fs::read(dir.path().join("retained.md")).unwrap(),
        b"retained before signal\n"
    );
    // A later writer must acquire the released vault lock and commit normally.
    create(
        dir.path(),
        "after-signal.md",
        "after-signal",
        b"new durable content\n",
    );
}
