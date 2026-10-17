use super::*;
use zorid_core::{Mutation, MutationRequest, OperationId, Revision, VaultPath};

fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn apply(vault: &mut NativeVault, operation: &str, mutation: Mutation) {
    vault
        .apply(&MutationRequest {
            operation_id: OperationId::new(operation).unwrap(),
            mutation,
        })
        .unwrap();
}
fn create(vault: &mut NativeVault, name: &str, path: &str, source: &str) {
    apply(
        vault,
        &format!("create-{name}"),
        Mutation::Create {
            id: id(name),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(source.as_bytes().to_vec()),
        },
    );
}
fn revision(vault: &NativeVault, name: &str) -> Revision {
    vault.read(&id(name)).unwrap().unwrap().state.revision
}
fn write(vault: &mut NativeVault, operation: &str, name: &str, source: &str) {
    let expected = revision(vault, name);
    apply(
        vault,
        operation,
        Mutation::Write {
            id: id(name),
            expected,
            content: source.as_bytes().to_vec(),
        },
    );
}
fn build(vault: &mut NativeVault) -> IndexSnapshotId {
    let stage = vault.begin_document_index().unwrap();
    for _ in 0..100 {
        if vault.pump_document_index(&stage).unwrap().ready {
            return vault.publish_document_index(&stage).unwrap();
        }
    }
    panic!("bounded fixture failed to finish");
}
fn expect_code<T>(result: NativeDocumentResult<T>, code: &str) {
    match result {
        Err(error) => assert_eq!(error.code(), code, "{error}"),
        Ok(_) => panic!("expected error {code}"),
    }
}

#[test]
fn retained_generation_binds_metadata_search_backlinks_base_source_and_facts() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create(&mut vault, "target", "Target.md", "# Old\n#before\n");
    create(
        &mut vault,
        "source",
        "Source.md",
        "[[Target]]\nneedle\nneedle again\n",
    );
    create(
        &mut vault,
        "base",
        "All.base",
        "views:\n  - type: table\n    name: All\n    order: [file.path, file.size, file.mtime]\n",
    );
    vault.initialize_document_index().unwrap();
    let snapshot = build(&mut vault);
    let old = vault.open_document_snapshot().unwrap();
    let old_base = vault
        .query_base_document_view(&old, &id("base"), "All", &QueryOptions::default())
        .unwrap();
    assert_eq!(old_base.value.result.counts.scanned, 3);
    expect_code(
        vault.query_base_document_view(&old, &id("base"), "missing", &QueryOptions::default()),
        "view_not_found",
    );
    let base_revision = old_base.value.definition.revision.clone();
    let old_rows = old_base.value.result.rows;
    let old_source = old_base.source;

    // A second authority handle changes source, namespace, deletion and Base
    // bytes while the first handle retains the old coherent query generation.
    let mut writer = NativeVault::open_existing(dir.path()).unwrap();
    write(
        &mut writer,
        "write-target",
        "target",
        "# New and much larger\n#after\n",
    );
    let expected = revision(&writer, "source");
    apply(
        &mut writer,
        "move-source",
        Mutation::Move {
            id: id("source"),
            expected,
            path: VaultPath::new("Moved.md").unwrap(),
        },
    );
    let expected = revision(&writer, "target");
    apply(
        &mut writer,
        "delete-target",
        Mutation::Delete {
            id: id("target"),
            expected,
            recursive: false,
        },
    );
    write(&mut writer, "invalid-base", "base", "views: [broken\n");
    build(&mut writer);
    let current = writer.open_document_snapshot().unwrap();

    let metadata = vault.document_metadata(&old, &id("target")).unwrap();
    assert_eq!(metadata.snapshot, snapshot);
    assert_eq!(metadata.source, old_source);
    assert_eq!(metadata.value.entry.path.as_str(), "Target.md");
    assert_eq!(metadata.value.metadata.unwrap().tags, ["before"]);
    let search = vault
        .search_documents(&old, LiteralQuery::new("needle").unwrap(), None, 10)
        .unwrap();
    assert_eq!(search.value.hits[0].entry.path.as_str(), "Source.md");
    let first_page = vault
        .search_documents(&old, LiteralQuery::new("needle").unwrap(), None, 1)
        .unwrap();
    let token = first_page.value.next.as_ref().unwrap();
    let continued = vault
        .search_documents(&old, LiteralQuery::new("needle").unwrap(), Some(token), 1)
        .unwrap();
    assert_eq!(continued.value.hits[0].line, 2);
    expect_code(
        writer.search_documents(
            &current,
            LiteralQuery::new("needle").unwrap(),
            Some(token),
            1,
        ),
        "snapshot_expired",
    );
    let backlinks = vault
        .document_backlinks(&old, &id("target"), None, 10)
        .unwrap();
    assert_eq!(backlinks.value.edges.len(), 1);
    assert_eq!(backlinks.value.edges[0].source().path.as_str(), "Source.md");
    let base = vault
        .query_base_document(&old, &id("base"), &QueryOptions::default())
        .unwrap();
    assert_eq!(base.snapshot, snapshot);
    assert_eq!(base.value.definition.revision, base_revision);
    assert_eq!(base.value.result.rows, old_rows); // includes original sizes/times
    assert_eq!(base.value.result.snapshot_id, snapshot);
    let encoded = serde_json::to_value(&base).unwrap();
    assert!(encoded.get("source").is_some());
    assert!(encoded.get("snapshot").is_some());

    expect_code(
        writer.document_metadata(&current, &id("target")),
        "missing_source",
    );
    expect_code(
        writer.query_base_document(&current, &id("base"), &QueryOptions::default()),
        "base_compile",
    );
    assert_eq!(
        writer.read(&id("base")).unwrap().unwrap().content.unwrap(),
        b"views: [broken\n"
    );
    let current_search = writer
        .search_documents(&current, LiteralQuery::new("needle").unwrap(), None, 10)
        .unwrap();
    assert_eq!(current_search.value.hits[0].entry.path.as_str(), "Moved.md");
    let graph = writer
        .document_relationships(&current, 10, 64 * 1024)
        .unwrap();
    assert!(graph.value.edges()[0].target().is_none());

    writer.rebuild_document_index().unwrap();
    expect_code(
        vault.document_metadata(&old, &id("target")),
        "snapshot_expired",
    );
    expect_code(
        writer.search_documents(&current, LiteralQuery::new("needle").unwrap(), None, 10),
        "snapshot_expired",
    );
    // Explicit rebuild does not change source bytes or tombstones.
    build(&mut writer);
    assert_eq!(
        writer.read(&id("base")).unwrap().unwrap().content.unwrap(),
        b"views: [broken\n"
    );
}

#[test]
fn staged_work_fences_concurrent_source_changes_and_can_resume_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create(&mut vault, "note", "Note.md", "first\n");
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    let snapshot = stage.snapshot().clone();
    assert!(vault.pump_document_index(&stage).unwrap().ready);
    drop(vault);
    let mut vault = NativeVault::open_existing(dir.path()).unwrap();
    assert_eq!(vault.document_index_stages().unwrap().len(), 1);
    let resumed = vault.resume_document_index(&snapshot).unwrap();
    let mut writer = NativeVault::open_existing(dir.path()).unwrap();
    write(&mut writer, "concurrent-write", "note", "second\n");
    expect_code(vault.publish_document_index(&resumed), "stale_source");
    let winner = build(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    assert_eq!(pin.generation().id(), &winner);
    let page = vault
        .search_documents(&pin, LiteralQuery::new("second").unwrap(), None, 10)
        .unwrap();
    assert_eq!(page.value.hits.len(), 1);
}

#[test]
fn queries_never_implicitly_reconcile_external_files_and_reject_foreign_pins() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create(&mut vault, "note", "Note.md", "committed\n");
    vault.initialize_document_index().unwrap();
    build(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    std::fs::write(dir.path().join("Note.md"), "external\n").unwrap();
    let page = vault
        .search_documents(&pin, LiteralQuery::new("committed").unwrap(), None, 10)
        .unwrap();
    assert_eq!(page.value.hits.len(), 1);
    let page = vault
        .search_documents(&pin, LiteralQuery::new("external").unwrap(), None, 10)
        .unwrap();
    assert!(page.value.hits.is_empty());
    // An explicit derived build still reads authority rather than disk.
    build(&mut vault);
    let fresh = vault.open_document_snapshot().unwrap();
    let page = vault
        .search_documents(&fresh, LiteralQuery::new("committed").unwrap(), None, 10)
        .unwrap();
    assert_eq!(page.value.hits.len(), 1);
    let other_dir = tempfile::tempdir().unwrap();
    let other = NativeVault::open(other_dir.path()).unwrap();
    expect_code(
        other.document_metadata(&pin, &id("note")),
        "snapshot_expired",
    );
    // Explicit source reconciliation is the only import gate.
    vault
        .reconcile_external(crate::ScanOptions::default(), crate::ExternalFileMode::Auto)
        .unwrap();
    build(&mut vault);
    let imported = vault.open_document_snapshot().unwrap();
    let page = vault
        .search_documents(&imported, LiteralQuery::new("external").unwrap(), None, 10)
        .unwrap();
    assert_eq!(page.value.hits.len(), 1);
}

#[test]
fn facade_verifies_native_root_before_serving_cached_metadata() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("vault");
    std::fs::create_dir(&root).unwrap();
    let mut vault = NativeVault::open(&root).unwrap();
    create(&mut vault, "note", "Note.md", "body");
    vault.initialize_document_index().unwrap();
    build(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    std::fs::rename(&root, outer.path().join("moved")).unwrap();
    std::fs::create_dir(&root).unwrap();
    expect_code(vault.document_metadata(&pin, &id("note")), "unsafe_path");
    vault.close_document_snapshot(pin);
}

#[test]
fn all_file_rows_preserve_binary_unknown_and_invalid_markdown_authority() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create(&mut vault, "unknown", "opaque.custom", "literal needle\n");
    create(
        &mut vault,
        "invalid",
        "Invalid.md",
        "---\nbad: [\n---\n# Still a heading\n",
    );
    create(
        &mut vault,
        "base",
        "All.base",
        "views:\n  - type: table\n    name: All\n",
    );
    apply(
        &mut vault,
        "create-binary",
        Mutation::Create {
            id: id("binary"),
            path: VaultPath::new("image.png").unwrap(),
            kind: EntryKind::File,
            content: Some(vec![0, 255, 128, 10]),
        },
    );
    vault.initialize_document_index().unwrap();
    build(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    let binary = vault.document_metadata(&pin, &id("binary")).unwrap();
    assert!(matches!(
        binary.value.exclusion,
        Some(zorid_index::Exclusion::Unreadable | zorid_index::Exclusion::Binary)
    ));
    assert!(binary.value.metadata.is_none());
    let invalid = vault.document_metadata(&pin, &id("invalid")).unwrap();
    assert!(!invalid.value.metadata.unwrap().diagnostics.is_empty());
    let page = vault
        .search_documents(&pin, LiteralQuery::new("needle").unwrap(), None, 10)
        .unwrap();
    assert_eq!(page.value.hits[0].entry.path.as_str(), "opaque.custom");
    let query = vault
        .query_base_document(&pin, &id("base"), &QueryOptions::default())
        .unwrap();
    assert_eq!(query.value.result.counts.scanned, 4);
    assert!(query
        .value
        .result
        .rows
        .iter()
        .any(|row| row.entry_id == id("binary")));
    assert!(query
        .value
        .result
        .rows
        .iter()
        .any(|row| row.entry_id == id("unknown")));
    assert_eq!(
        vault.read(&id("binary")).unwrap().unwrap().content.unwrap(),
        [0, 255, 128, 10]
    );
    assert_eq!(
        vault
            .read(&id("invalid"))
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        b"---\nbad: [\n---\n# Still a heading\n"
    );
}
