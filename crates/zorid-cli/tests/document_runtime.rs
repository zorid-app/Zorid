#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Actual standalone processes over small normal native fixtures; no daemon or
//! private SQL mutation, and no generated 4097-file fixture for cycle budgeting.
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output, Stdio},
};
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_native::{LocalStoragePaths, NativeVault};

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
}
impl Fixture {
    fn new(notes: usize) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("vault");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let data = directory.path().canonicalize().unwrap().join("app-data");
        let fixture = Self {
            _directory: directory,
            root,
            data,
        };
        let mut vault = NativeVault::open(&fixture.root).unwrap();
        for n in 0..notes {
            vault
                .apply(&MutationRequest {
                    operation_id: OperationId::new(format!("create-note-{n}")).unwrap(),
                    mutation: Mutation::Create {
                        id: EntryId::new(format!("note-{n}")).unwrap(),
                        path: VaultPath::new(format!("note-{n}.md")).unwrap(),
                        kind: EntryKind::File,
                        content: Some(b"needle retained\n".to_vec()),
                    },
                })
                .unwrap();
        }
        fixture
    }
    fn vault(&self) -> NativeVault {
        let mut vault = NativeVault::open_existing(&self.root).unwrap();
        let paths = LocalStoragePaths::resolve(
            &self.root,
            &vault.identity().unwrap().local_store_id,
            &self.data,
        )
        .unwrap();
        fs::create_dir_all(paths.cache.parent().unwrap()).unwrap();
        vault.enable_local_document_cache(&paths.cache).unwrap();
        vault
    }
    fn invoke(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_zorid"))
            .env("ZORID_LOCAL_DATA_DIR", &self.data)
            .env_remove("DISPLAY")
            .env_remove("ZORID_IPC_ENDPOINT")
            .arg("--vault")
            .arg(&self.root)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }
    fn success(&self, args: &[&str]) -> Value {
        let output = self.invoke(args);
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
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["version"], 1);
        assert_eq!(response["ok"], true);
        response["result"].clone()
    }
    fn assert_sources(&self, notes: usize) {
        let mut vault = self.vault();
        for n in 0..notes {
            assert_eq!(
                fs::read(self.root.join(format!("note-{n}.md"))).unwrap(),
                b"needle retained\n"
            );
            assert_eq!(
                vault
                    .read(&EntryId::new(format!("note-{n}")).unwrap())
                    .unwrap()
                    .unwrap()
                    .content
                    .as_deref(),
                Some(b"needle retained\n".as_slice())
            );
        }
    }
}

#[test]
fn standalone_runtime_fresh_current_and_explicit_rebuild_preserve_attribution() {
    let fixture = Fixture::new(2);
    let fresh = fixture.success(&["document-index", "build"]);
    assert_eq!(fresh["pumps"], 1);
    assert_eq!(fresh["resumed"], false);
    assert_eq!(fresh["published"], true);
    assert_eq!(fresh["buildComplete"], true);
    assert_eq!(fresh["progress"]["preparedDocuments"], 2);
    let current = fixture.success(&["document-index", "build", "--max-pumps", "129"]);
    assert_eq!(current["snapshot"], fresh["snapshot"]);
    assert_eq!(current["pumps"], 0);
    assert_eq!(current["published"], false);
    assert_eq!(current["buildComplete"], true);
    assert_eq!(current["complete"], true);
    assert_eq!(current["progress"]["preparedDocuments"], 2);
    assert_eq!(current["progress"]["reusedDocuments"], 0);
    assert_eq!(current["progress"]["parseCache"]["hits"], 0);
    let rebuilt = fixture.success(&["document-index", "rebuild"]);
    assert_eq!(rebuilt["operation"], "document_index_rebuild");
    assert_eq!(rebuilt["published"], true);
    assert_eq!(rebuilt["pumps"], 1);
    assert_ne!(
        rebuilt["snapshot"]["generationEpoch"],
        fresh["snapshot"]["generationEpoch"]
    );
    fixture.assert_sources(2);
}

#[test]
fn standalone_runtime_preserves_bounded_partial_work_and_resumes_after_process_exit() {
    let fixture = Fixture::new(33);
    let partial = fixture.success(&["document-index", "build", "--max-pumps", "1"]);
    assert_eq!(partial["pumps"], 1);
    assert_eq!(partial["published"], false);
    assert_eq!(partial["buildComplete"], false);
    assert_eq!(partial["complete"], false);
    assert_eq!(partial["progress"]["preparedDocuments"], 32);
    assert_eq!(partial["progress"]["totalDocuments"], 33);
    let done = fixture.success(&["document-index", "build"]);
    assert_eq!(done["snapshot"], partial["snapshot"]);
    assert_eq!(done["resumed"], true);
    assert_eq!(done["pumps"], 1);
    assert_eq!(done["published"], true);
    assert_eq!(done["buildComplete"], true);
    fixture.assert_sources(33);
}

#[test]
fn standalone_runtime_ready_stage_publishes_without_a_redundant_pump() {
    let fixture = Fixture::new(2);
    let mut vault = fixture.vault();
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    assert!(vault.pump_document_index(&stage).unwrap().ready);
    let expected = serde_json::to_value(stage.snapshot()).unwrap();
    drop(vault);
    let done = fixture.success(&["document-index", "build", "--max-pumps", "1"]);
    assert_eq!(done["snapshot"], expected);
    assert_eq!(done["resumed"], true);
    assert_eq!(done["pumps"], 0);
    assert_eq!(done["published"], true);
    assert_eq!(done["buildComplete"], true);
    assert_eq!(done["progress"]["preparedDocuments"], 2);
    assert_eq!(done["progress"]["reusedDocuments"], 0);
    fixture.assert_sources(2);
}

#[test]
fn standalone_watch_maintains_index_across_owner_reopen_without_explicit_build() {
    let fixture = Fixture::new(1);
    let output = fixture.invoke(&["watch", "--interval-ms", "100", "--max-cycles", "2"]);
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
    let frames = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[2]["result"]["event"], "watch_stopped");
    let status = fixture.success(&["document-index", "status"]);
    assert_eq!(status["status"]["state"], "ready");
    let hits = fixture.success(&["indexed-search", "needle"]);
    assert_eq!(hits["value"]["hits"].as_array().unwrap().len(), 1);
    fixture.assert_sources(1);
}
