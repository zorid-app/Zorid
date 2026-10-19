#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Actual standalone CLI protocol tests; no desktop, daemon, direct SQLite edits
//! or second query evaluator. The native layer owns all matching/paging facts.
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::fd::AsRawFd,
    path::PathBuf,
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant, SystemTime},
};
use zorid_native::NativeVault;

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("vault");
        fs::create_dir(&root).unwrap();
        let fixture = Self {
            _directory: directory,
            root,
        };
        success(fixture.invoke(&["init"]));
        fixture
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_zorid"));
        command
            .env(
                "ZORID_LOCAL_DATA_DIR",
                self.root.parent().unwrap().join("app-data"),
            )
            .env_remove("DISPLAY")
            .env_remove("ZORID_IPC_ENDPOINT")
            .arg("--vault")
            .arg(&self.root)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    fn invoke(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
    fn create(&self, id: &str, path: &str, bytes: &[u8]) {
        let mut input = tempfile::NamedTempFile::new().unwrap();
        input.write_all(bytes).unwrap();
        success(self.invoke(&[
            "create",
            path,
            "--id",
            id,
            "--operation-id",
            &format!("create-{id}"),
            "--input",
            input.path().to_str().unwrap(),
        ]));
    }
    fn build(&self) -> Value {
        let report = success(self.invoke(&["document-index", "build"]));
        assert_eq!(report["published"], true);
        report
    }
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(parsed["ok"], true);
    parsed["result"].clone()
}
fn stream(output: Output) -> Vec<Value> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    let lines: Vec<Value> = output
        .stdout
        .split(|&byte| byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            let parsed: Value = serde_json::from_slice(line).unwrap();
            assert_eq!(parsed["version"], 1);
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["result"]["operation"], "indexed_query");
            parsed["result"].clone()
        })
        .collect();
    assert!(lines.len() >= 2);
    assert!(lines[..lines.len() - 1]
        .iter()
        .all(|line| line["event"] == "page"));
    assert_eq!(lines.last().unwrap()["event"], "end");
    lines
}
fn failure(output: Output, code: &str) -> Value {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], code);
    error["error"].clone()
}
fn pages(lines: &[Value]) -> impl Iterator<Item = &Value> {
    lines.iter().filter(|line| line["event"] == "page")
}
fn paths(lines: &[Value]) -> Vec<String> {
    let mut result = Vec::new();
    for page in pages(lines) {
        for file in page["value"]["files"].as_array().unwrap() {
            let path = file["entry"]["path"].as_str().unwrap().to_owned();
            if !result.contains(&path) {
                result.push(path);
            }
        }
    }
    result
}
fn wait_bounded(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned CLI did not exit within its cancellation bound");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn new_command_preserves_literal_protocol_and_explicit_snapshot_admission() {
    let fixture = Fixture::new();
    failure(
        fixture.invoke(&["indexed-query", "needle"]),
        "index_not_ready",
    );
    assert_eq!(
        success(fixture.invoke(&["document-index", "status"]))["status"]["state"],
        "uninitialized"
    );
    fixture.create("a", "A.md", b"needle OR literal");
    fixture.create("b", "B.md", b"other");
    let built = fixture.build();
    let literal = success(fixture.invoke(&["indexed-search", "needle OR literal"]));
    assert_eq!(literal["value"]["hits"][0]["entry"]["path"], "A.md");
    assert!(literal.get("event").is_none());
    let unindexed = success(fixture.invoke(&["search", "needle OR literal"]));
    assert!(unindexed.get("event").is_none());
    let lines = stream(fixture.invoke(&[
        "indexed-query",
        "needle OR other",
        "--expected-snapshot",
        &built["snapshot"].to_string(),
    ]));
    assert_eq!(paths(&lines), ["A.md", "B.md"]);
    for page in pages(&lines) {
        assert_eq!(page["snapshot"], built["snapshot"]);
        assert_eq!(page["value"]["snapshot"], page["snapshot"]);
        assert_eq!(page["value"]["next"], Value::Null);
        assert!(!page.to_string().contains("cursor"));
    }
    let mut wrong = built["snapshot"].clone();
    wrong["localStoreId"] = json!("another-store");
    failure(
        fixture.invoke(&[
            "indexed-query",
            "needle",
            "--expected-snapshot",
            &wrong.to_string(),
        ]),
        "snapshot_expired",
    );
    assert_eq!(
        fs::read(fixture.root.join("A.md")).unwrap(),
        b"needle OR literal"
    );
}

#[test]
fn core_counts_ranges_property_provenance_and_diagnostics_survive_streaming() {
    let fixture = Fixture::new();
    let source = "---\nstatus: todo\n---\naaaa 😀Needle\r\n";
    fixture.create("a", "A.md", source.as_bytes());
    fixture.build();
    let lines = stream(fixture.invoke(&["indexed-query", "content:aa", "--explain"]));
    let page = pages(&lines).next().unwrap();
    assert_eq!(
        page["value"]["totals"]["occurrences"],
        json!({"relation":"exact","value":2})
    );
    assert_eq!(page["value"]["files"][0]["occurrenceCount"], 2);
    assert_eq!(
        page["value"]["explanation"]["dialect"],
        "zorid-search-rust-unicode-1"
    );
    let locations = page["value"]["files"][0]["locations"].as_array().unwrap();
    assert_eq!(
        locations.len(),
        1,
        "touch-merged highlight is not the count"
    );
    assert_eq!(locations[0]["occurrences"], 2);
    let lines =
        stream(fixture.invoke(&["indexed-query", "content:Needle", "--context", "section"]));
    let file = &pages(&lines).next().unwrap()["value"]["files"][0];
    let range = &file["locations"][0]["locator"]["range"];
    let start = range["bytes"][0].as_u64().unwrap() as usize;
    let end = range["bytes"][1].as_u64().unwrap() as usize;
    assert_eq!(&source[start..end], "Needle");
    assert_eq!(range["utf16"][0], source[..start].encode_utf16().count());
    for snippet in file["snippets"].as_array().unwrap() {
        let text = snippet["text"].as_str().unwrap();
        let utf16: Vec<u16> = text.encode_utf16().collect();
        for highlight in snippet["highlights"].as_array().unwrap() {
            let start = highlight["utf16"][0].as_u64().unwrap() as usize;
            let end = highlight["utf16"][1].as_u64().unwrap() as usize;
            assert_eq!(String::from_utf16(&utf16[start..end]).unwrap(), "Needle");
        }
    }
    let lines = stream(fixture.invoke(&["indexed-query", "[status:todo]"]));
    let file = &pages(&lines).next().unwrap()["value"]["files"][0];
    assert!(file["locations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|location| location["locator"]["origin"] == "propertyValue"));
    let diagnostic = failure(
        fixture.invoke(&["indexed-query", "content:/(?=a)/"]),
        "search_compile",
    );
    assert_eq!(
        diagnostic["detail"]["diagnostic"]["code"],
        "unsupported-regex"
    );
    assert!(diagnostic["detail"]["diagnostic"]["queryRange"]["bytes"].is_array());
    failure(
        fixture.invoke(&["indexed-query", "file:path:x"]),
        "search_compile",
    );
    assert_eq!(
        fs::read(fixture.root.join("A.md")).unwrap(),
        source.as_bytes()
    );
}

#[test]
fn case_and_all_six_sort_options_use_retained_facts_not_live_stats() {
    let fixture = Fixture::new();
    fixture.create("b", "B.md", b"Needle");
    fixture.create("a", "A.md", b"needle");
    let facts = NativeVault::open_existing(&fixture.root)
        .unwrap()
        .list_snapshot()
        .unwrap()
        .entries;
    fixture.build();
    for (index, path) in ["A.md", "B.md"].iter().enumerate() {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(fixture.root.join(path))
            .unwrap();
        file.set_times(
            fs::FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(10 + index as u64)),
        )
        .unwrap();
    }
    assert_eq!(
        paths(&stream(fixture.invoke(&["indexed-query", "needle"]))),
        ["A.md", "B.md"]
    );
    assert_eq!(
        paths(&stream(fixture.invoke(&[
            "indexed-query",
            "needle",
            "--case-sensitive"
        ]))),
        ["A.md"]
    );
    for (flag, wire) in [
        ("name-asc", "nameAsc"),
        ("name-desc", "nameDesc"),
        ("modified-desc", "modifiedDesc"),
        ("modified-asc", "modifiedAsc"),
        ("created-desc", "createdDesc"),
        ("created-asc", "createdAsc"),
    ] {
        let lines = stream(fixture.invoke(&["indexed-query", "needle", "--sort", flag]));
        assert_eq!(pages(&lines).next().unwrap()["value"]["spec"]["sort"], wire);
        let mut expected = facts.clone();
        expected.sort_by(|a, b| {
            let time = if flag.starts_with("modified") {
                a.presentation.mtime_ms.cmp(&b.presentation.mtime_ms)
            } else if flag.starts_with("created") {
                a.presentation.ctime_ms.cmp(&b.presentation.ctime_ms)
            } else {
                std::cmp::Ordering::Equal
            };
            let time = if flag.ends_with("desc") {
                time.reverse()
            } else {
                time
            };
            let name = a.state.path.cmp(&b.state.path);
            time.then(if flag == "name-desc" {
                name.reverse()
            } else {
                name
            })
        });
        let expected: Vec<_> = expected
            .iter()
            .map(|row| row.state.path.as_str().to_owned())
            .collect();
        assert_eq!(paths(&lines), expected, "{flag}");
    }
}

#[test]
fn continuation_repeats_file_summary_without_doubling_totals_and_limit_is_partial() {
    let fixture = Fixture::new();
    let source = "needle\n".repeat(130);
    fixture.create("many", "Many.md", source.as_bytes());
    for number in 0..39 {
        fixture.create(
            &format!("small-{number}"),
            &format!("N{number:02}.md"),
            b"needle\nneedle\nneedle\nneedle\n",
        );
    }
    fixture.build();
    let partial = stream(fixture.invoke(&["indexed-query", "content:needle", "--max-pages", "1"]));
    let end = partial.last().unwrap();
    assert_eq!(end["stopReason"], "pageLimit");
    assert_eq!(end["hasNext"], true);
    assert_eq!(end["summary"]["complete"], false);
    let full = stream(fixture.invoke(&["indexed-query", "content:needle"]));
    assert!(pages(&full).count() > 1);
    let first = pages(&full).next().unwrap();
    let mut many_chunks = 0;
    for page in pages(&full) {
        assert_eq!(page["snapshot"], first["snapshot"]);
        assert_eq!(page["source"], first["source"]);
        for chunk in page["value"]["files"].as_array().unwrap() {
            if chunk["entry"]["id"] == "many" {
                many_chunks += 1;
                assert_eq!(chunk["occurrenceCount"], 130);
            } else {
                assert_eq!(chunk["occurrenceCount"], 4);
            }
        }
    }
    assert!(
        many_chunks >= 3,
        "the >64-location file has repeated summary chunks"
    );
    let end = full.last().unwrap();
    assert_eq!(end["hasNext"], false);
    assert_eq!(end["summary"]["complete"], true);
    assert_eq!(
        end["summary"]["totals"]["files"],
        json!({"relation":"exact","value":40})
    );
    assert_eq!(
        end["summary"]["totals"]["occurrences"],
        json!({"relation":"exact","value":286})
    );
    assert_eq!(
        fs::read(fixture.root.join("Many.md")).unwrap(),
        source.as_bytes()
    );
}

#[test]
fn binary_filename_query_does_not_confuse_generation_and_query_coverage() {
    let fixture = Fixture::new();
    fixture.create("photo", "photo.png", b"\x89PNG\0binary");
    fixture.build();
    let lines = stream(fixture.invoke(&["indexed-query", "file:photo"]));
    assert_eq!(paths(&lines), ["photo.png"]);
    let page = pages(&lines).next().unwrap();
    assert_eq!(page["coverageComplete"], false);
    assert_eq!(page["value"]["complete"], true);
    assert_eq!(page["value"]["work"]["sourceBytes"], 0);
    assert!(page["value"]["files"][0]["locations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|location| location["locator"]["origin"] == "filename"));
}

#[test]
fn owned_query_exits_on_sigint_and_sigterm_while_consumer_pipe_is_full() {
    let fixture = Fixture::new();
    let source = "needle\n".repeat(500);
    fixture.create("many", "Many.md", source.as_bytes());
    fixture.build();
    for signal in [libc::SIGINT, libc::SIGTERM] {
        let mut child = fixture
            .command(&["indexed-query", "content:needle"])
            .spawn()
            .unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut descriptor = libc::pollfd {
            fd: output.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut descriptor, 1, 30_000) };
        if ready <= 0 {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned rich CLI did not produce its first page within30s");
        }
        let mut first = [0; 1];
        if output.read_exact(&mut first).is_err() {
            wait_bounded(&mut child);
            let mut error = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut error)
                .unwrap();
            panic!("rich CLI ended before output: {error}");
        }
        assert_eq!(first[0], b'{');
        // Retain the unread pipe. No reader thread drains it to make cancellation pass.
        assert_eq!(unsafe { libc::kill(child.id() as libc::pid_t, signal) }, 0);
        wait_bounded(&mut child);
        let result = child.wait_with_output().unwrap();
        assert_eq!(result.status.code(), Some(3));
        let error: Value = serde_json::from_slice(&result.stderr).unwrap();
        assert_eq!(error["error"]["code"], "cancelled");
        drop(output);
    }
    assert_eq!(
        fs::read(fixture.root.join("Many.md")).unwrap(),
        source.as_bytes()
    );
}

#[test]
fn owned_query_reports_closed_output_as_read_only_failure() {
    let fixture = Fixture::new();
    let source = "needle\n".repeat(500);
    fixture.create("many", "Many.md", source.as_bytes());
    fixture.build();
    let mut child = fixture
        .command(&["indexed-query", "content:needle"])
        .spawn()
        .unwrap();
    let output = child.stdout.take().unwrap();
    drop(output);
    wait_bounded(&mut child);
    let result = child.wait_with_output().unwrap();
    assert_eq!(result.status.code(), Some(1));
    let error: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(error["error"]["code"], "output_io");
    assert!(!error.to_string().contains("mutation"));
    assert_eq!(
        fs::read(fixture.root.join("Many.md")).unwrap(),
        source.as_bytes()
    );
}
