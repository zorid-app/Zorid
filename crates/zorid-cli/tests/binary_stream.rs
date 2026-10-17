#![cfg(any(target_os = "macos", target_os = "linux"))]
//! One independent-process >16 MiB path; fixtures generate/compare chunks and
//! redirect output to files instead of retaining file bodies in test memory.
use base64::{engine::general_purpose::STANDARD, read::DecoderReader};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{self, BufReader, Read, Write},
    path::Path,
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
use zorid_core::{EntryId, OperationId};
use zorid_file_sync::Scope;
use zorid_native::NativeVault;
use zorid_sync_protocol::{RealmId, VaultId};

const CHUNK: usize = 128 * 1024;
const LENGTH: usize = 16 * 1024 * 1024 + 17;
const MAX_CONTROL: usize = 128 * 1024;
const READ_CLIENT: &str = "903d6a52-2b38-43e3-9ffb-d582bcf6c954";
fn pattern(bytes: &mut [u8], offset: usize, seed: usize) {
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = ((offset + index + seed) % 251) as u8;
    }
}
fn generate(mut out: impl Write, seed: usize) -> io::Result<()> {
    let mut buffer = vec![0; CHUNK];
    let mut offset = 0;
    while offset < LENGTH {
        let count = buffer.len().min(LENGTH - offset);
        pattern(&mut buffer[..count], offset, seed);
        out.write_all(&buffer[..count])?;
        offset += count;
    }
    out.flush()
}
fn compare(mut input: impl Read, seed: usize) {
    let mut buffer = vec![0; CHUNK];
    let mut expected = vec![0; CHUNK];
    let mut offset = 0;
    while offset < LENGTH {
        let count = buffer.len().min(LENGTH - offset);
        input.read_exact(&mut buffer[..count]).unwrap();
        pattern(&mut expected[..count], offset, seed);
        assert_eq!(&buffer[..count], &expected[..count]);
        offset += count;
    }
    assert_eq!(input.read(&mut buffer[..1]).unwrap(), 0);
}
fn invoke(
    root: &Path,
    args: &[&str],
    stdin_seed: Option<usize>,
    output: &Path,
) -> (ExitStatus, Vec<u8>) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_zorid"));
    command
        .arg("--vault")
        .arg(root)
        .args(args)
        .env_remove("DISPLAY")
        .env_remove("ZORID_IPC_ENDPOINT")
        .stdin(if stdin_seed.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::from(File::create(output).unwrap()))
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let input = stdin_seed.map(|seed| {
        let stdin = child.stdin.take().unwrap();
        thread::spawn(move || generate(stdin, seed))
    });
    let mut stderr = child.stderr.take().unwrap();
    let errors = thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buffer = [0; 4096];
        let mut exceeded = false;
        loop {
            let count = stderr.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            let take = count.min(MAX_CONTROL.saturating_sub(kept.len()));
            kept.extend_from_slice(&buffer[..take]);
            exceeded |= take != count;
        }
        (kept, exceeded)
    });
    let deadline = Instant::now() + Duration::from_secs(180);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = input.map(|thread| thread.join());
            let _ = errors.join();
            panic!("streamed CLI process exceeded finite fixture deadline");
        }
        thread::sleep(Duration::from_millis(10));
    };
    if let Some(input) = input {
        let result = input.join().unwrap();
        if status.success() {
            result.unwrap();
        }
    }
    let (errors, exceeded) = errors.join().unwrap();
    assert!(!exceeded, "CLI diagnostic exceeded fixture bound");
    (status, errors)
}
fn success(root: &Path, args: &[&str], stdin_seed: Option<usize>, output: &Path) -> Value {
    let (status, errors) = invoke(root, args, stdin_seed, output);
    assert!(status.success(), "{}", String::from_utf8_lossy(&errors));
    assert!(errors.is_empty());
    assert!(fs::metadata(output).unwrap().len() <= MAX_CONTROL as u64);
    let value: Value = serde_json::from_reader(File::open(output).unwrap()).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["ok"], true);
    value["result"].clone()
}
fn revision(value: &Value) -> &str {
    value["commit"]["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["after"]["id"] == "large-binary")
        .unwrap()["after"]["revision"]
        .as_str()
        .unwrap()
}
fn compare_json(path: &Path, seed: usize) {
    let mut reader = BufReader::new(File::open(path).unwrap());
    let mut prefix = Vec::new();
    while !prefix.ends_with(b"\"bytes\":\"") {
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        prefix.push(byte[0]);
        assert!(prefix.len() <= MAX_CONTROL);
    }
    // The unchanged public wrapper parses as ordinary JSON with an empty body.
    let mut metadata = prefix.clone();
    metadata.extend_from_slice(b"\"}}");
    let value: Value = serde_json::from_slice(&metadata).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["ok"], true);
    assert_eq!(value["result"]["entry"]["id"], "large-binary");
    assert_eq!(value["result"]["encoding"], "base64");
    let encoded = LENGTH.div_ceil(3) * 4;
    compare(
        DecoderReader::new((&mut reader).take(encoded as u64), &STANDARD),
        seed,
    );
    let mut tail = [0; 4];
    reader.read_exact(&mut tail).unwrap();
    assert_eq!(&tail, b"\"}}\n");
    assert_eq!(reader.read(&mut [0]).unwrap(), 0);
}

#[test]
fn independent_cli_streams_large_binary_stdin_file_read_write_and_exact_retries() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    fs::create_dir(&root).unwrap();
    let output = temp.path().join("control.json");
    success(&root, &["init"], None, &output);
    {
        let mut vault = NativeVault::open_existing(&root).unwrap();
        vault
            .family_enroll(&Scope {
                realm_id: RealmId::new("stream-realm").unwrap(),
                vault_id: VaultId::new("stream-vault").unwrap(),
            })
            .unwrap();
    }
    let create = [
        "create",
        "large.bin",
        "--id",
        "large-binary",
        "--operation-id",
        "large-create",
        "--binary",
        "--input",
        "-",
    ];
    let created = success(&root, &create, Some(7), &output);
    assert_eq!(created["durable_local_commit"], true);
    assert_eq!(created["projection"]["state"], "projected");
    compare(File::open(root.join("large.bin")).unwrap(), 7);
    // Simulate an earlier reader dying without Close. No lease remains; the
    // next independent CLI owner can reap only its dedicated owner's pins.
    {
        let mut vault = NativeVault::open_existing(&root).unwrap();
        vault
            .open_binary_read(
                &OperationId::new(READ_CLIENT).unwrap(),
                &OperationId::new("abandoned-read").unwrap(),
                &EntryId::new("large-binary").unwrap(),
                None,
            )
            .unwrap();
    }
    let raw = temp.path().join("read.raw");
    let (status, errors) = invoke(
        &root,
        &[
            "read",
            "--id",
            "large-binary",
            "--raw",
            "--read-id",
            "large-read",
        ],
        None,
        &raw,
    );
    assert!(status.success(), "{}", String::from_utf8_lossy(&errors));
    assert!(errors.is_empty());
    compare(File::open(&raw).unwrap(), 7);
    {
        let mut vault = NativeVault::open_existing(&root).unwrap();
        let owner = OperationId::new(READ_CLIENT).unwrap();
        assert!(vault.list_binary_reads(&owner).unwrap().is_empty());
        // Retain an explicit old view before the next Write. Its caller ID
        // selects that original pin before newer publication metadata.
        vault
            .open_binary_read(
                &owner,
                &OperationId::new("original-read").unwrap(),
                &EntryId::new("large-binary").unwrap(),
                None,
            )
            .unwrap();
    }
    let input = temp.path().join("replacement.bin");
    generate(File::create(&input).unwrap(), 37).unwrap();
    let write = [
        "write",
        "--id",
        "large-binary",
        "--expected-revision",
        revision(&created),
        "--operation-id",
        "large-write",
        "--input",
        input.to_str().unwrap(),
    ];
    let written = success(&root, &write, None, &output);
    assert_eq!(written["durable_local_commit"], true);
    compare(File::open(root.join("large.bin")).unwrap(), 37);
    let (status, errors) = invoke(
        &root,
        &[
            "read",
            "--id",
            "large-binary",
            "--raw",
            "--read-id",
            "original-read",
        ],
        None,
        &raw,
    );
    assert!(status.success(), "{}", String::from_utf8_lossy(&errors));
    assert!(errors.is_empty());
    compare(File::open(&raw).unwrap(), 7);
    assert_eq!(
        success(&root, &write, None, &output)["commit"],
        written["commit"]
    );
    // The original Create receipt survives a later Write and another process;
    // its supplied input is validated against the original sealed metadata.
    assert_eq!(
        success(&root, &create, Some(7), &output)["commit"],
        created["commit"]
    );
    compare(File::open(root.join("large.bin")).unwrap(), 37);
    let (status, errors) = invoke(&root, &create, Some(37), &output);
    assert!(!status.success());
    assert_eq!(fs::metadata(&output).unwrap().len(), 0);
    let error: Value = serde_json::from_slice(&errors).unwrap();
    assert_eq!(error["error"]["code"], "idempotency_conflict");
    let encoded = temp.path().join("read.json");
    let (status, errors) = invoke(&root, &["read", "--id", "large-binary"], None, &encoded);
    assert!(status.success(), "{}", String::from_utf8_lossy(&errors));
    assert!(errors.is_empty());
    compare_json(&encoded, 37);
    let vault = NativeVault::open_existing(&root).unwrap();
    let pending = vault.family_pending_authored(None, 1000).unwrap();
    assert!(
        pending.len() > 2 * LENGTH.div_ceil(CHUNK),
        "both binary commits retain sync-eligible chunk/page/event envelopes"
    );
    assert!(matches!(
        vault.read(&EntryId::new("large-binary").unwrap()),
        Err(zorid_native::Error::Store(
            zorid_store::StoreError::StreamRequired { .. }
        ))
    ));
}
