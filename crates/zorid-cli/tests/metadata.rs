#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Independent command processes exercise committed authority, not a parser mock.
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output, Stdio},
};
use zorid_native::{FamilyScope, NativeVault};
use zorid_sync_protocol::{RealmId, VaultId};

fn invoke(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_zorid"))
        .arg("--vault")
        .arg(root)
        .args(args)
        .env_remove("DISPLAY")
        .env_remove("ZORID_IPC_ENDPOINT")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["ok"], true);
    json["result"].clone()
}
fn failure(output: Output, code: &str, exit: i32) {
    assert_eq!(
        output.status.code(),
        Some(exit),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let json: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["code"], code);
}
fn create(root: &Path, path: &str, id: &str, bytes: &[u8], mode: Option<&str>) -> Value {
    let input = tempfile::NamedTempFile::new().unwrap();
    fs::write(input.path(), bytes).unwrap();
    let operation = format!("create-{id}");
    let mut args = vec![
        "create",
        path,
        "--id",
        id,
        "--operation-id",
        &operation,
        "--input",
        input.path().to_str().unwrap(),
    ];
    if let Some(mode) = mode {
        args.push(mode);
    }
    success(invoke(root, &args))
}
fn initialized(enrolled: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    success(invoke(dir.path(), &["init"]));
    if enrolled {
        let mut vault = NativeVault::open_existing(dir.path()).unwrap();
        vault
            .family_enroll(&FamilyScope {
                realm_id: RealmId::new("metadata-realm").unwrap(),
                vault_id: VaultId::new("metadata-vault").unwrap(),
            })
            .unwrap();
    }
    dir
}
fn committed_state(created: &Value, id: &str) -> Value {
    created["commit"]["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["after"]["id"] == id)
        .unwrap()["after"]
        .clone()
}

#[test]
fn committed_unicode_metadata_has_exact_identity_ranges_and_never_imports_disk() {
    let dir = initialized(true);
    // Explicit metadata interpretation accepts Text with an unknown extension.
    let source = "\u{feff}# 😀 Café\r\n[go](Other%20Note.md)\r\n";
    let created = create(
        dir.path(),
        "Note.custom",
        "unicode",
        source.as_bytes(),
        Some("--text"),
    );
    let state = committed_state(&created, "unicode");
    let status_before = success(invoke(dir.path(), &["status"]));
    let list_before = success(invoke(dir.path(), &["list"]));
    // Physical projection differs deliberately: metadata must not scan, import or repair it.
    fs::write(
        dir.path().join("Note.custom"),
        b"external content, not committed",
    )
    .unwrap();
    let result = success(invoke(dir.path(), &["metadata", "--id", "unicode"]));
    assert_eq!(result["entry"], state);
    assert_eq!(result["consistency"], "committed_per_entry");
    assert_eq!(result["synced"], false);
    let metadata = &result["metadata"];
    assert_eq!(metadata["entryId"], "unicode");
    assert_eq!(metadata["contentRevision"], state["revision"]);
    assert_eq!(metadata["sourceLength"]["bytes"], source.len());
    assert_eq!(
        metadata["sourceLength"]["utf16"],
        source.encode_utf16().count()
    );
    assert_eq!(metadata["headings"][0]["text"], "😀 Café");
    assert_eq!(
        metadata["headings"][0]["range"]["bytes"],
        serde_json::json!([3, 15])
    );
    assert_eq!(
        metadata["headings"][0]["range"]["utf16"],
        serde_json::json!([1, 10])
    );
    assert_eq!(metadata["links"][0]["destination"], "Other%20Note.md");
    assert_eq!(result["provenance"]["source_bytes"], source.len());
    assert_eq!(result["provenance"]["source_kind"], "inline_bytes");
    assert_eq!(result["provenance"]["interpretation"], "explicit_markdown");
    assert_eq!(
        result["provenance"]["source_sha256"],
        serde_json::to_value(zorid_native::Sha256Digest::of(source.as_bytes())).unwrap()
    );
    assert_eq!(success(invoke(dir.path(), &["status"])), status_before);
    assert_eq!(success(invoke(dir.path(), &["list"])), list_before);
    assert_eq!(
        invoke(dir.path(), &["read", "--id", "unicode", "--raw"]).stdout,
        source.as_bytes()
    );
    assert_eq!(
        fs::read(dir.path().join("Note.custom")).unwrap(),
        b"external content, not committed"
    );
}

#[test]
fn malformed_yaml_returns_current_diagnostics_without_changing_source() {
    let dir = initialized(false);
    let source = "---\nvalue: [unterminated\n---\n# Current 😀\n";
    let created = create(
        dir.path(),
        "Malformed.md",
        "invalid-yaml",
        source.as_bytes(),
        None,
    );
    let state = committed_state(&created, "invalid-yaml");
    let before = success(invoke(dir.path(), &["status"]));
    let result = success(invoke(dir.path(), &["metadata", "--id", "invalid-yaml"]));
    assert_eq!(result["entry"], state);
    assert_eq!(result["metadata"]["contentRevision"], state["revision"]);
    assert_eq!(result["metadata"]["frontmatter"]["state"], "invalid");
    assert!(!result["metadata"]["diagnostics"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(result["metadata"]["headings"][0]["text"], "Current 😀");
    assert_eq!(success(invoke(dir.path(), &["status"])), before);
    assert_eq!(
        fs::read(dir.path().join("Malformed.md")).unwrap(),
        source.as_bytes()
    );
    assert_eq!(
        invoke(dir.path(), &["read", "--id", "invalid-yaml", "--raw"]).stdout,
        source.as_bytes()
    );
}

#[test]
fn property_mapping_order_survives_cli_serialization() {
    let dir = initialized(false);
    let source = b"---\nz: {zebra: first, alpha: second}\na: 3\n---\n";
    create(dir.path(), "Order.md", "ordered", source, None);
    let output = invoke(dir.path(), &["metadata", "--id", "ordered"]);
    let _ = success(Output {
        status: output.status,
        stdout: output.stdout.clone(),
        stderr: output.stderr,
    });
    let encoded = String::from_utf8(output.stdout).unwrap();
    assert!(
        encoded.contains("\"value\":{\"zebra\":\"first\",\"alpha\":\"second\"}"),
        "{encoded}"
    );
    assert!(encoded.find("\"key\":\"z\"").unwrap() < encoded.find("\"key\":\"a\"").unwrap());
}

#[test]
fn explicit_source_errors_preserve_existing_json_contract() {
    let dir = initialized(false);
    create(dir.path(), "Nul.md", "nul", b"a\0b", None);
    create(dir.path(), "Invalid.md", "bad-utf8", &[255], None);
    failure(
        invoke(dir.path(), &["metadata", "--id", "nul"]),
        "metadata_nul_source",
        2,
    );
    failure(
        invoke(dir.path(), &["metadata", "--id", "bad-utf8"]),
        "metadata_invalid_utf8",
        2,
    );
    failure(
        invoke(dir.path(), &["metadata", "--id", "missing"]),
        "not_found",
        4,
    );
    success(invoke(
        dir.path(),
        &[
            "mkdir",
            "Folder",
            "--id",
            "folder",
            "--operation-id",
            "create-folder",
        ],
    ));
    failure(
        invoke(dir.path(), &["metadata", "--id", "folder"]),
        "not_file",
        2,
    );
    failure(
        invoke(dir.path(), &["metadata", "--id", "invalid/id"]),
        "invalid_identifier",
        2,
    );
    let enrolled = initialized(true);
    create(
        enrolled.path(),
        "LooksLikeText.md",
        "binary",
        b"# Valid UTF-8, but Binary",
        Some("--binary"),
    );
    failure(
        invoke(enrolled.path(), &["metadata", "--id", "binary"]),
        "metadata_binary_source",
        2,
    );
    let empty = tempfile::tempdir().unwrap();
    failure(
        invoke(empty.path(), &["metadata", "--id", "none"]),
        "vault_not_initialized",
        4,
    );
    assert!(!empty.path().join(".zorid").exists());
}
