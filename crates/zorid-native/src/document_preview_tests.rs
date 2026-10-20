use super::*;
use std::cell::Cell;
use zorid_core::{EntryKind, Mutation, MutationRequest, VaultPath};

const BASE: &str = "views:\n  - type: table\n    name: All\n";
fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn create(vault: &mut NativeVault, name: &str, path: &str, text: &[u8]) {
    vault
        .apply(&MutationRequest {
            operation_id: op(&format!("create-{name}")),
            mutation: Mutation::Create {
                id: id(name),
                path: VaultPath::new(path).unwrap(),
                kind: EntryKind::File,
                content: Some(text.to_vec()),
            },
        })
        .unwrap();
}
fn fixture(
    notes: usize,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    NativeVault,
    DocumentIndexStage,
) {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault
        .enable_local_document_cache(cache.path().join("cache.sqlite"))
        .unwrap();
    create(&mut vault, "base", "00.base", BASE.as_bytes());
    for n in 0..notes {
        create(
            &mut vault,
            &format!("note-{n:02}"),
            &format!("Note-{n:02}.md"),
            b"---\nscore: 2\n---\nhello\n",
        );
    }
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    (dir, cache, vault, stage)
}
fn capture(vault: &mut NativeVault, stage: &DocumentIndexStage) -> NativeBasePreview {
    assert!(vault.open_document_preview().unwrap().is_none());
    vault.pump_document_index(stage).unwrap();
    vault
        .open_document_preview()
        .unwrap()
        .expect("actual committed capture")
}
fn query(vault: &NativeVault, preview: &NativeBasePreview) -> NativeBasePreviewReply {
    vault
        .query_base_preview(
            preview,
            &id("base"),
            Some("All"),
            QueryOptions::default(),
            |_| Ok(()),
        )
        .unwrap()
}
fn encoded(reply: &NativeBasePreviewReply) -> serde_json::Value {
    // Test-only consumer owns this copy. Production never exposes an uncharged Vec.
    let mut out = Vec::new();
    reply
        .write_json(&op("1"), &mut out, 16 * 1024 * 1024, || Ok(()))
        .unwrap();
    serde_json::from_slice(&out).unwrap()
}
fn code<T>(result: NativeDocumentResult<T>, expected: &str) {
    match result {
        Err(e) => assert_eq!(e.code(), expected, "{e}"),
        Ok(_) => panic!("expected {expected}"),
    }
}

#[test]
fn preview_is_lazy_postcommit_partial_and_matches_the_pure_subset_oracle() {
    let (_dir, _cache, mut vault, stage) = fixture(35);
    assert!(vault.base_preview_owner.is_none());
    let preview = capture(&mut vault, &stage);
    let descriptor = preview.descriptor().unwrap();
    assert_eq!(descriptor.progress.prepared_files, 32);
    assert_eq!(descriptor.progress.pending_files, 4);
    assert!(vault.open_document_snapshot().is_err());
    let reply = query(&vault, &preview);
    let actual = encoded(&reply);
    assert_eq!(actual["schemaVersion"], 1);
    let value = &actual["value"]["result"];
    assert_eq!(value["complete"], false);
    assert_eq!(value["aggregatesComplete"], false);
    assert_eq!(value["countsScope"], "preparedSubset");
    assert_eq!(value["relationshipsAvailable"], false);
    assert!(value.get("snapshotId").is_none());
    let held = preview.capture().unwrap();
    let program = zorid_bases::compile_base_source(BASE).unwrap();
    let oracle = zorid_bases::query_preview(
        &program,
        held.data.snapshot(),
        &id("base"),
        &held.facts,
        &QueryOptions::default(),
        MAX_QUERY,
    )
    .unwrap();
    assert_eq!(*value, serde_json::to_value(oracle.value).unwrap());
    assert_eq!(actual["value"]["definition"]["id"], "base");
}

#[test]
fn replacing_capture_retires_weak_handles_but_releases_backing_only_after_query_drop() {
    let (_dir, _cache, mut vault, stage) = fixture(35);
    let first = capture(&mut vault, &stage);
    let reply = query(&vault, &first);
    let owner = vault.base_preview_owner.as_ref().unwrap().clone();
    let held = owner.budget.used.load(Ordering::Acquire);
    assert!(vault.pump_document_index(&stage).unwrap().ready);
    assert!(!first.is_live());
    assert!(owner.budget.used.load(Ordering::Acquire) >= held);
    code(
        vault.check_document_preview_reply(&reply),
        "index_preview_expired",
    );
    let second = vault.open_document_preview().unwrap().unwrap();
    assert!(first.descriptor().is_err());
    assert_eq!(second.descriptor().unwrap().progress.pending_files, 0);
    let before = owner.budget.used.load(Ordering::Acquire);
    drop(reply);
    assert!(owner.budget.used.load(Ordering::Acquire) < before);
    drop(first);
}

#[test]
fn source_peer_change_is_rejected_at_final_fence_without_substituting_live_definition() {
    let (dir, cache, mut vault, stage) = fixture(1);
    let preview = capture(&mut vault, &stage);
    let mut peer = NativeVault::open(dir.path()).unwrap();
    peer.enable_local_document_cache(cache.path().join("cache.sqlite"))
        .unwrap();
    let calls = Cell::new(0);
    let result =
        vault.query_base_preview(&preview, &id("base"), None, QueryOptions::default(), |_| {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                create(&mut peer, "late", "late.md", b"late");
            }
            Ok(())
        });
    assert_eq!(calls.get(), 3);
    assert!(result.is_err());
    assert!(vault.check_document_preview_handle(&preview).is_err());
}

#[test]
fn owner_provider_publish_discard_and_rebuild_expire_real_handles_and_preserve_rendered_dto() {
    for change in ["publish", "discard", "rebuild", "provider", "owner"] {
        let (_dir, cache, mut vault, stage) = fixture(1);
        let preview = capture(&mut vault, &stage);
        let reply = query(&vault, &preview);
        let rendered = encoded(&reply);
        match change {
            "publish" => {
                vault.publish_document_index(&stage).unwrap();
            }
            "discard" => {
                vault
                    .discard_document_index_stage(stage.snapshot())
                    .unwrap();
            }
            "rebuild" => vault.rebuild_document_index().unwrap(),
            "owner" => vault.retire_document_preview_owner(),
            "provider" => vault
                .enable_local_document_cache(cache.path().join("other.sqlite"))
                .unwrap(),
            _ => unreachable!(),
        }
        assert!(!preview.is_live());
        code(preview.descriptor(), "index_preview_expired");
        code(
            vault.check_document_preview_handle(&preview),
            "index_preview_expired",
        );
        code(
            vault.check_document_preview_reply(&reply),
            "index_preview_expired",
        );
        assert_eq!(rendered["value"]["result"]["status"], "indexing");
    }
    let (_a, _ca, mut a, stage) = fixture(1);
    let preview = capture(&mut a, &stage);
    let (_b, _cb, b, _) = fixture(1);
    code(
        b.check_document_preview_handle(&preview),
        "index_preview_expired",
    );
}

#[test]
fn pending_definition_unknown_view_and_cancel_are_explicit_and_do_not_publish() {
    let (_dir, _cache, mut vault, stage) = fixture(35);
    let preview = capture(&mut vault, &stage);
    assert!(
        vault
            .query_base_preview(
                &preview,
                &id("note-34"),
                None,
                QueryOptions::default(),
                |_| Ok(())
            )
            .is_err()
    );
    code(
        vault.query_base_preview(
            &preview,
            &id("base"),
            Some("missing"),
            QueryOptions::default(),
            |_| Ok(()),
        ),
        "view_not_found",
    );
    code(
        vault.query_base_preview(&preview, &id("base"), None, QueryOptions::default(), |_| {
            Err(NativeDocumentError::QueryCancelled)
        }),
        "cancelled",
    );
    assert!(vault.open_document_snapshot().is_err());
    assert!(vault.check_document_preview_handle(&preview).is_ok());
}

#[test]
fn precancelled_token_rejects_before_definition_lookup_without_charging_the_owner() {
    let (_dir, _cache, mut vault, stage) = fixture(1);
    let preview = capture(&mut vault, &stage);
    let owner = vault.base_preview_owner.as_ref().unwrap().clone();
    let charged = owner.budget.used.load(Ordering::Acquire);
    let cancellation = zorid_bases::OperationCancellation::default();
    cancellation.cancel();
    let mut options = QueryOptions::default();
    options.evaluation.cancellation = Some(cancellation);
    code(
        vault.query_base_preview(&preview, &id("missing"), Some("missing"), options, |_| {
            Ok(())
        }),
        "cancelled",
    );
    assert_eq!(owner.budget.used.load(Ordering::Acquire), charged);
    assert!(vault.check_document_preview_handle(&preview).is_ok());
    assert!(query(&vault, &preview).is_live());
}

#[test]
fn writer_limit_cancellation_and_partial_io_keep_real_query_charge_until_drop() {
    let (_dir, _cache, mut vault, stage) = fixture(1);
    let preview = capture(&mut vault, &stage);
    let reply = query(&vault, &preview);
    let owner = vault.base_preview_owner.as_ref().unwrap().clone();
    let charged = owner.budget.used.load(Ordering::Acquire);
    code(
        reply.write_json(&op("1"), &mut io::sink(), 1, || Ok(())),
        "index_preview_resource",
    );
    code(
        reply.write_json(&op("1"), &mut io::sink(), 1024, || {
            Err(NativeDocumentError::QueryCancelled)
        }),
        "cancelled",
    );
    struct Broken {
        bytes: usize,
    }
    impl Write for Broken {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if self.bytes >= 17 {
                return Err(io::Error::other("owned test truncation"));
            }
            let n = b.len().min(17 - self.bytes);
            self.bytes += n;
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut broken = Broken { bytes: 0 };
    assert!(
        reply
            .write_json(&op("1"), &mut broken, 16 * 1024 * 1024, || Ok(()))
            .is_err()
    );
    assert_eq!(broken.bytes, 17);
    assert_eq!(owner.budget.used.load(Ordering::Acquire), charged);
    drop(reply);
    assert!(owner.budget.used.load(Ordering::Acquire) < charged);
}

#[test]
fn ledger_checked_boundary_and_failed_capture_admission_preserve_successful_pump() {
    let budget = Arc::new(Budget {
        used: AtomicUsize::new(0),
    });
    assert!(budget.reserve(usize::MAX).is_err());
    let full = budget.reserve(MAX_OWNED).unwrap();
    assert_eq!(budget.available(), 0);
    assert!(budget.reserve(1).is_err());
    drop(full);
    assert_eq!(budget.available(), MAX_OWNED);
    let (_dir, _cache, mut vault, stage) = fixture(1);
    assert!(vault.open_document_preview().unwrap().is_none());
    let owner = vault.base_preview_owner.as_ref().unwrap().clone();
    let pressure = owner.budget.reserve(owner.budget.available()).unwrap();
    let progress = vault.pump_document_index(&stage).unwrap();
    assert!(progress.ready);
    assert!(owner.state().unwrap().latest.is_none());
    drop(pressure);
    assert!(vault.open_document_preview().unwrap().is_none());
    assert!(vault.pump_document_index(&stage).unwrap().ready);
    assert!(vault.open_document_preview().unwrap().is_some());
}
