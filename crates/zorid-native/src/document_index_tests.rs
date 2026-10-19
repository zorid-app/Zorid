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
    let cache = tempfile::tempdir().unwrap();
    let cache_path = cache.path().canonicalize().unwrap().join("cache.sqlite");
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault.enable_local_document_cache(&cache_path).unwrap();
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
        "views:\n  - type: table\n    name: All\n    order: [file.path, file.size, file.mtime]\n  - type: table\n    name: Linked\n    filters: 'file.hasLink(\"Target\")'\n    order: [file.path]\n",
    );
    vault.initialize_document_index().unwrap();
    let snapshot = build(&mut vault);
    let old = vault.open_document_snapshot().unwrap();
    let identity = vault.document_snapshot_identity(&old).unwrap();
    assert_eq!(identity.snapshot, snapshot);
    assert_eq!(identity.source, *old.generation().manifest().source());
    assert!(identity.coverage_complete);
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
    writer.enable_local_document_cache(&cache_path).unwrap();
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
    let linked = vault
        .query_base_document_view(&old, &id("base"), "Linked", &QueryOptions::default())
        .unwrap();
    assert_eq!(linked.value.result.rows.len(), 1);
    assert_eq!(linked.value.result.rows[0].path, "Source.md");
    assert_eq!(linked.value.result.rows[0].entry_id, id("source"));

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
    expect_code(vault.document_snapshot_identity(&old), "snapshot_expired");
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
    let cache = tempfile::tempdir().unwrap();
    let cache_path = cache.path().canonicalize().unwrap().join("cache.sqlite");
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault.enable_local_document_cache(&cache_path).unwrap();
    create(&mut vault, "note", "Note.md", "first\n");
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    let snapshot = stage.snapshot().clone();
    assert!(vault.pump_document_index(&stage).unwrap().ready);
    drop(vault);
    let mut vault = NativeVault::open_existing(dir.path()).unwrap();
    vault.enable_local_document_cache(&cache_path).unwrap();
    assert_eq!(vault.document_index_stages().unwrap().len(), 1);
    let resumed = vault.resume_document_index(&snapshot).unwrap();
    let mut writer = NativeVault::open_existing(dir.path()).unwrap();
    writer.enable_local_document_cache(&cache_path).unwrap();
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

// Same explicit enrollment and authenticated family delivery as the native
// family_observation_tests fixtures. No Store internals or synthetic receipts.
fn enrolled(root: &std::path::Path) -> NativeVault {
    let mut vault = NativeVault::open(root).unwrap();
    vault
        .family_enroll(&crate::FamilyScope {
            realm_id: zorid_sync_protocol::RealmId::new("document-fixture-realm").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("document-fixture-vault").unwrap(),
        })
        .unwrap();
    vault
}
fn family_create(vault: &mut NativeVault, name: &str, path: &str, source: &str) {
    let created = vault
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new(format!("create-{name}")).unwrap(),
                mutation: Mutation::Create {
                    id: id(name),
                    path: VaultPath::new(path).unwrap(),
                    kind: EntryKind::File,
                    content: Some(source.as_bytes().to_vec()),
                },
            },
            Some(crate::FamilyCreateMode::Text),
        )
        .unwrap();
    assert!(matches!(
        created.projection,
        crate::ProjectionStatus::Projected
    ));
}
fn send_family(source: &mut NativeVault, target: &mut NativeVault) -> usize {
    let key = zorid_crypto::VaultKey::from_bytes([37; 32]);
    let updates = source.family_pending_authored(None, 100).unwrap();
    let count = updates.len();
    assert!(count < 100, "fixture must not truncate pending updates");
    for update in updates {
        let context = zorid_sync_protocol::ExpectedContext {
            realm_id: update.scope.realm_id,
            vault_id: update.scope.vault_id,
            update_id: update.update_id,
            key_epoch: 1,
        };
        let wire = source.family_seal(&context, &key).unwrap();
        let opened = zorid_crypto::OpenedEnvelope::open(&wire, &context, &key).unwrap();
        let received = target.family_receive(&opened, None).unwrap();
        assert!(!received.commit.duplicate);
        source
            .family_ack(
                &context.realm_id,
                &context.vault_id,
                &context.update_id,
                &wire,
            )
            .unwrap();
    }
    let status = target.family_status().unwrap();
    assert_eq!(status.pending_dependencies, "0");
    assert_eq!(status.pending_projection, "0");
    count
}
/// Compare semantic payloads independently of the generation token. Each result
/// still has to carry the same pinned source and exact committed entry revision.
fn document_view(
    vault: &NativeVault,
    pin: &DocumentQueryPin,
    expected: &Revision,
    literal: &str,
    tag: &str,
    target: &str,
) -> serde_json::Value {
    let metadata = vault.document_metadata(pin, &id("note")).unwrap();
    assert_eq!(&metadata.value.entry.revision, expected);
    assert_eq!(metadata.value.metadata.as_ref().unwrap().tags, [tag]);
    let search = vault
        .search_documents(pin, LiteralQuery::new(literal).unwrap(), None, 10)
        .unwrap();
    assert!(search.value.complete);
    assert_eq!(search.value.hits.len(), 1);
    assert_eq!(search.value.hits[0].entry.id, id("note"));
    assert_eq!(&search.value.hits[0].entry.revision, expected);
    let backlinks = vault
        .document_backlinks(pin, &id(target), None, 10)
        .unwrap();
    assert!(backlinks.value.complete);
    assert_eq!(backlinks.value.edges.len(), 1);
    assert_eq!(backlinks.value.edges[0].source().id, id("note"));
    assert_eq!(&backlinks.value.edges[0].source().revision, expected);
    assert_eq!(metadata.snapshot, search.snapshot);
    assert_eq!(metadata.snapshot, backlinks.snapshot);
    assert_eq!(metadata.source, search.source);
    assert_eq!(metadata.source, backlinks.source);
    serde_json::json!({
        "metadata": metadata.value,
        "hits": search.value.hits,
        "backlinks": backlinks.value.edges,
    })
}
fn old_semantics_absent(vault: &NativeVault, pin: &DocumentQueryPin) {
    assert!(vault
        .search_documents(pin, LiteralQuery::new("committed").unwrap(), None, 10)
        .unwrap()
        .value
        .hits
        .is_empty());
    assert!(vault
        .document_backlinks(pin, &id("before"), None, 10)
        .unwrap()
        .value
        .edges
        .is_empty());
}
const BEFORE_IMPORT: &str = "#before\r\ncommitted [[Before]]\r\n";
const AFTER_IMPORT: &str = "#after\r\nexternal [[After]] café\r\n";

#[test]
fn queries_never_implicitly_reconcile_external_files_and_reject_foreign_pins() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = enrolled(dir.path());
    family_create(&mut vault, "before", "Before.md", "# Before\n");
    family_create(&mut vault, "after", "After.md", "# After\n");
    family_create(&mut vault, "note", "Note.md", BEFORE_IMPORT);
    let original_revision = revision(&vault, "note");
    vault.initialize_document_index().unwrap();
    build(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    let original_view = document_view(
        &vault,
        &pin,
        &original_revision,
        "committed",
        "before",
        "before",
    );
    let original_source = vault.document_index_status_with_source().unwrap().0;
    std::fs::write(dir.path().join("Note.md"), AFTER_IMPORT).unwrap();
    // Neither queries nor an explicit derived build import physical bytes.
    assert_eq!(
        document_view(
            &vault,
            &pin,
            &original_revision,
            "committed",
            "before",
            "before"
        ),
        original_view
    );
    assert!(vault
        .search_documents(&pin, LiteralQuery::new("external").unwrap(), None, 10)
        .unwrap()
        .value
        .hits
        .is_empty());
    build(&mut vault);
    let fresh = vault.open_document_snapshot().unwrap();
    assert_eq!(
        document_view(
            &vault,
            &fresh,
            &original_revision,
            "committed",
            "before",
            "before"
        ),
        original_view
    );
    assert_eq!(
        vault.document_index_status_with_source().unwrap().0,
        original_source
    );
    assert_eq!(
        vault.read(&id("note")).unwrap().unwrap().content.unwrap(),
        BEFORE_IMPORT.as_bytes()
    );
    assert_eq!(
        std::fs::read(dir.path().join("Note.md")).unwrap(),
        AFTER_IMPORT.as_bytes()
    );
    let other_dir = tempfile::tempdir().unwrap();
    let other = NativeVault::open(other_dir.path()).unwrap();
    expect_code(other.document_snapshot_identity(&pin), "snapshot_expired");
    expect_code(
        other.document_metadata(&pin, &id("note")),
        "snapshot_expired",
    );

    // Explicit source reconciliation is the only import gate.
    let imported_source = vault
        .reconcile_external(crate::ScanOptions::default(), crate::ExternalFileMode::Auto)
        .unwrap();
    assert!(imported_source.complete, "{imported_source:?}");
    assert_eq!(imported_source.imported.len(), 1, "{imported_source:?}");
    let imported_revision = revision(&vault, "note");
    assert_ne!(imported_revision, original_revision);
    let source_after = vault.document_index_status_with_source().unwrap().0;
    assert_ne!(source_after, original_source);
    assert_eq!(
        vault.read(&id("note")).unwrap().unwrap().content.unwrap(),
        AFTER_IMPORT.as_bytes()
    );
    // The old generation remains coherent even after the authority import.
    assert_eq!(
        document_view(
            &vault,
            &pin,
            &original_revision,
            "committed",
            "before",
            "before"
        ),
        original_view
    );
    build(&mut vault);
    let imported = vault.open_document_snapshot().unwrap();
    assert_eq!(
        vault.document_snapshot_identity(&imported).unwrap().source,
        source_after
    );
    let refreshed = document_view(
        &vault,
        &imported,
        &imported_revision,
        "external",
        "after",
        "after",
    );
    old_semantics_absent(&vault, &imported);
    let family_before_rebuild = vault.family_status().unwrap();
    vault.rebuild_document_index().unwrap();
    build(&mut vault);
    let rebuilt = vault.open_document_snapshot().unwrap();
    assert_eq!(
        document_view(
            &vault,
            &rebuilt,
            &imported_revision,
            "external",
            "after",
            "after"
        ),
        refreshed
    );
    old_semantics_absent(&vault, &rebuilt);
    assert_eq!(
        vault.document_index_status_with_source().unwrap().0,
        source_after
    );
    assert_eq!(vault.family_status().unwrap(), family_before_rebuild);
    assert_eq!(revision(&vault, "note"), imported_revision);
    assert_eq!(
        vault.read(&id("note")).unwrap().unwrap().content.unwrap(),
        AFTER_IMPORT.as_bytes()
    );
    assert_eq!(
        std::fs::read(dir.path().join("Note.md")).unwrap(),
        AFTER_IMPORT.as_bytes()
    );
}

#[test]
fn authenticated_received_update_refreshes_metadata_search_and_backlinks_and_rebuilds_equally() {
    let sender_dir = tempfile::tempdir().unwrap();
    let receiver_dir = tempfile::tempdir().unwrap();
    let mut sender = enrolled(sender_dir.path());
    let mut receiver = enrolled(receiver_dir.path());
    family_create(&mut sender, "before", "Before.md", "# Before\n");
    family_create(&mut sender, "after", "After.md", "# After\n");
    family_create(&mut sender, "note", "Note.md", BEFORE_IMPORT);
    assert!(send_family(&mut sender, &mut receiver) >= 3);
    assert!(receiver
        .family_pending_authored(None, 100)
        .unwrap()
        .is_empty());
    assert_eq!(
        receiver
            .read(&id("note"))
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        BEFORE_IMPORT.as_bytes()
    );
    receiver.initialize_document_index().unwrap();
    build(&mut receiver);
    let old = receiver.open_document_snapshot().unwrap();
    let original_revision = revision(&receiver, "note");
    let original_source = receiver.document_index_status_with_source().unwrap().0;
    let original_view = document_view(
        &receiver,
        &old,
        &original_revision,
        "committed",
        "before",
        "before",
    );

    // Real authored family update, encrypted and authenticated before ingress.
    let written = sender
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new("remote-write").unwrap(),
                mutation: Mutation::Write {
                    id: id("note"),
                    expected: revision(&sender, "note"),
                    content: AFTER_IMPORT.as_bytes().to_vec(),
                },
            },
            None,
        )
        .unwrap();
    assert!(matches!(
        written.projection,
        crate::ProjectionStatus::Projected
    ));
    assert_eq!(send_family(&mut sender, &mut receiver), 1);
    assert!(
        receiver
            .family_pending_authored(None, 100)
            .unwrap()
            .is_empty(),
        "receive must not echo an authored update"
    );
    let received_revision = revision(&receiver, "note");
    assert_ne!(received_revision, original_revision);
    let received_source = receiver.document_index_status_with_source().unwrap().0;
    assert_ne!(received_source, original_source);
    assert_eq!(
        receiver
            .read(&id("note"))
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        AFTER_IMPORT.as_bytes()
    );
    assert_eq!(
        std::fs::read(receiver_dir.path().join("Note.md")).unwrap(),
        AFTER_IMPORT.as_bytes()
    );
    assert_eq!(
        document_view(
            &receiver,
            &old,
            &original_revision,
            "committed",
            "before",
            "before"
        ),
        original_view
    );
    build(&mut receiver);
    let current = receiver.open_document_snapshot().unwrap();
    assert_eq!(
        receiver
            .document_snapshot_identity(&current)
            .unwrap()
            .source,
        received_source
    );
    let refreshed = document_view(
        &receiver,
        &current,
        &received_revision,
        "external",
        "after",
        "after",
    );
    old_semantics_absent(&receiver, &current);
    let family_before_rebuild = receiver.family_status().unwrap();
    receiver.rebuild_document_index().unwrap();
    build(&mut receiver);
    let rebuilt = receiver.open_document_snapshot().unwrap();
    assert_eq!(
        document_view(
            &receiver,
            &rebuilt,
            &received_revision,
            "external",
            "after",
            "after"
        ),
        refreshed
    );
    old_semantics_absent(&receiver, &rebuilt);
    assert_eq!(
        receiver.document_index_status_with_source().unwrap().0,
        received_source
    );
    assert_eq!(receiver.family_status().unwrap(), family_before_rebuild);
    assert_eq!(revision(&receiver, "note"), received_revision);
    assert_eq!(
        receiver
            .read(&id("note"))
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        AFTER_IMPORT.as_bytes()
    );
    assert_eq!(
        std::fs::read(receiver_dir.path().join("Note.md")).unwrap(),
        AFTER_IMPORT.as_bytes()
    );
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
    expect_code(vault.document_snapshot_identity(&pin), "unsafe_path");
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

#[test]
fn current_entry_context_uses_retained_properties_and_base_file_facts() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create(
        &mut vault,
        "context-note",
        "Current.md",
        "---\ntitle: Before\n---\n",
    );
    let source = "filters: file.path == this.file.path\nformulas:\n  context: this.file.path\n  title: this.title\nviews:\n  - type: table\n    name: Context\n    order: [file.path, formula.context, formula.title]\n";
    create(&mut vault, "context-base", "Context.base", source);
    vault.initialize_document_index().unwrap();
    build(&mut vault);
    let retained = vault.open_document_snapshot().unwrap();
    let mut options = QueryOptions::default();
    options.current_entry_id = Some(id("context-note"));
    write(
        &mut vault,
        "replace-current-context",
        "context-note",
        "---\ntitle: After\n---\n",
    );
    let result = vault
        .query_base_document(&retained, &id("context-base"), &options)
        .unwrap();
    assert_eq!(result.value.result.rows.len(), 1);
    assert_eq!(
        result.value.result.rows[0].values["formula.title"],
        zorid_bases::BaseValue::String {
            value: "Before".into()
        }
    );
    options.current_entry_id = Some(id("context-base"));
    let base = vault
        .query_base_document(&retained, &id("context-base"), &options)
        .unwrap();
    assert_eq!(base.value.result.rows[0].path, "Context.base");
    assert_eq!(
        base.value.result.rows[0].values["formula.title"],
        zorid_bases::BaseValue::Null
    );
    options.current_entry_id = Some(id("missing-context"));
    expect_code(
        vault.query_base_document(&retained, &id("context-base"), &options),
        "stale-source",
    );
    options.current_entry_id = Some(id("context-note"));
    options.max_steps = 1;
    expect_code(
        vault.query_base_document(&retained, &id("context-base"), &options),
        "budget",
    );
    assert_eq!(
        vault
            .read(&id("context-base"))
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        source.as_bytes()
    );
}

const CACHED_BASE: &str = "filters: file.ext == \"md\"\nformulas:\n  context: this.rank\n  today: today().toString()\nviews:\n  - type: table\n    name: Ascending\n    order: [file.name, rank, formula.context, formula.today]\n    sort:\n      - property: rank\n        direction: ASC\n  - type: table\n    name: Descending\n    order: [file.name, rank, formula.context, formula.today]\n    sort:\n      - property: rank\n        direction: DESC\n";
fn create_cached_base_fixture(vault: &mut NativeVault) {
    for n in 0..8 {
        create(
            vault,
            &format!("cached-note-{n}"),
            &format!("Note-{n}.md"),
            &format!("---\nrank: {n}\n---\n[[Note-0]]\n"),
        );
    }
    create(vault, "cached-base", "All.base", CACHED_BASE);
    vault.initialize_document_index().unwrap();
    build(vault);
}
fn cached_options() -> QueryOptions {
    let mut options = QueryOptions::default();
    options.current_entry_id = Some(id("cached-note-0"));
    options.evaluation.clock_ms = 1_705_314_030_000;
    options
}
fn number(value: f64) -> zorid_bases::BaseValue {
    zorid_bases::BaseValue::Number { value }
}
fn text(value: &str) -> zorid_bases::BaseValue {
    zorid_bases::BaseValue::String {
        value: value.into(),
    }
}

thread_local! {
    static BASE_ANSWER_EVENTS: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}
fn record_base_answer_event(point: &str) {
    BASE_ANSWER_EVENTS.with(|events| {
        let (hits, evaluations) = events.get();
        events.set(match point {
            "base_query_answer_hit" => (hits + 1, evaluations),
            "base_query_evaluated" => (hits, evaluations + 1),
            _ => (hits, evaluations),
        });
    });
}
fn answer_events() -> (usize, usize) {
    BASE_ANSWER_EVENTS.with(std::cell::Cell::get)
}

#[test]
fn base_answers_reuse_across_new_pins_and_validate_context_view_clock_and_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create_cached_base_fixture(&mut vault);
    let source_before = std::fs::read(dir.path().join("All.base")).unwrap();
    let options = cached_options();
    BASE_ANSWER_EVENTS.with(|events| events.set((0, 0)));
    vault.fault = Some(record_base_answer_event);
    let first_pin = vault.open_document_snapshot().unwrap();
    let first = vault
        .query_base_document_view(&first_pin, &id("cached-base"), "Ascending", &options)
        .unwrap();
    assert_eq!(first.value.result.rows.len(), 8);
    assert_eq!(answer_events(), (0, 1));
    vault.close_document_snapshot(first_pin);
    let second_pin = vault.open_document_snapshot().unwrap();
    let second = vault
        .query_base_document_view(&second_pin, &id("cached-base"), "Ascending", &options)
        .unwrap();
    assert_eq!(
        answer_events(),
        (1, 2),
        "the actual cross-pin query must hit"
    );
    assert_eq!(second.snapshot, first.snapshot);
    assert_eq!(second.source, first.source);
    assert_eq!(second.value.definition, first.value.definition);
    assert_eq!(second.value.result.rows, first.value.result.rows);
    assert!(
        second.value.result.steps_used < first.value.result.steps_used,
        "a separate pin should reuse pure preparation with checked hit work"
    );
    let now = u64::try_from(vault.base_preparation_clock.elapsed().as_millis()).unwrap();
    assert_eq!(
        vault
            .base_preparation_cache
            .borrow_mut()
            .compile_source(CACHED_BASE, now)
            .unwrap()
            .outcome(),
        zorid_bases::PreparationCacheOutcome::Hit,
        "the actual native query must also retain its compiled exact source"
    );
    let mut changed = options.clone();
    changed.current_entry_id = Some(id("cached-note-7"));
    let context = vault
        .query_base_document_view(&second_pin, &id("cached-base"), "Ascending", &changed)
        .unwrap();
    assert_eq!(
        answer_events(),
        (1, 3),
        "current entry must invalidate the answer"
    );
    assert_eq!(context.value.result.rows[0].entry_id, id("cached-note-0"));
    for row in &context.value.result.rows {
        assert_eq!(row.values["formula.context"], number(7.0));
        assert_eq!(row.values["formula.today"], text("2024-01-15"));
    }
    let view = vault
        .query_base_document_view(&second_pin, &id("cached-base"), "Descending", &changed)
        .unwrap();
    assert_eq!(
        answer_events(),
        (1, 4),
        "selected view must invalidate the answer"
    );
    assert_eq!(view.value.result.rows[0].entry_id, id("cached-note-7"));
    assert_eq!(
        view.value.result.rows[0].values["formula.today"],
        text("2024-01-15")
    );
    changed.evaluation.clock_ms += 86_400_000;
    let different = vault
        .query_base_document_view(&second_pin, &id("cached-base"), "Descending", &changed)
        .unwrap();
    assert_eq!(
        answer_events(),
        (1, 5),
        "evaluation clock must invalidate this clock-sensitive answer"
    );
    assert_eq!(different.value.result.rows[0].entry_id, id("cached-note-7"));
    for row in &different.value.result.rows {
        assert_eq!(row.values["formula.context"], number(7.0));
        assert_eq!(row.values["formula.today"], text("2024-01-16"));
    }
    assert_eq!(
        second.value.result.rows[0].values["formula.context"],
        number(0.0)
    );
    assert_eq!(
        second.value.result.rows[0].values["formula.today"],
        text("2024-01-15")
    );
    let repeated = vault
        .query_base_document_view(&second_pin, &id("cached-base"), "Descending", &changed)
        .unwrap();
    assert_eq!(repeated.value.result.rows, different.value.result.rows);
    assert_eq!(answer_events(), (2, 6));
    expect_code(
        vault.query_base_document_view(&second_pin, &id("cached-base"), "absent", &changed),
        "view_not_found",
    );
    changed.max_steps = 1;
    expect_code(
        vault.query_base_document(&second_pin, &id("cached-base"), &changed),
        "budget",
    );
    let cancelled = zorid_bases::OperationCancellation::default();
    cancelled.cancel();
    changed = options;
    changed.evaluation.cancellation = Some(cancelled);
    expect_code(
        vault.query_base_document(&second_pin, &id("cached-base"), &changed),
        "cancelled",
    );
    assert_eq!(
        answer_events(),
        (2, 6),
        "invalid or cancelled calls cannot reuse an answer"
    );
    assert_eq!(
        std::fs::read(dir.path().join("All.base")).unwrap(),
        source_before
    );
    vault.fault = None;
    vault.close_document_snapshot(second_pin);
}

#[test]
fn base_cache_idle_expiry_uses_native_monotonic_time_not_the_evaluation_date() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create_cached_base_fixture(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    let mut options = cached_options();
    let cold = vault
        .query_base_document(&pin, &id("cached-base"), &options)
        .unwrap();
    let warm = vault
        .query_base_document(&pin, &id("cached-base"), &options)
        .unwrap();
    assert!(warm.value.result.steps_used < cold.value.result.steps_used);
    options.evaluation.clock_ms += 365 * 86_400_000;
    let next_year = vault
        .query_base_document(&pin, &id("cached-base"), &options)
        .unwrap();
    assert_eq!(
        next_year.value.result.steps_used, warm.value.result.steps_used,
        "an evaluation-date change must not expire native monotonic caches"
    );
    vault.base_preparation_clock = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_millis(
            zorid_bases::PREPARATION_IDLE_MS + 1000,
        ))
        .unwrap();
    let expired = vault
        .query_base_document(&pin, &id("cached-base"), &options)
        .unwrap();
    assert!(
        expired.value.result.steps_used > next_year.value.result.steps_used,
        "advancing the explicit native monotonic origin must expire the shared cache"
    );
    assert_eq!(expired.value.result.rows, next_year.value.result.rows);
    vault.close_document_snapshot(pin);
}

#[test]
fn warmed_program_still_requires_current_retained_definition_and_pin_admission() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(dir.path()).unwrap();
    create_cached_base_fixture(&mut vault);
    let options = cached_options();
    let old = vault.open_document_snapshot().unwrap();
    let original = vault
        .query_base_document(&old, &id("cached-base"), &options)
        .unwrap();
    vault
        .query_base_document(&old, &id("cached-base"), &options)
        .unwrap();
    write(
        &mut vault,
        "change-cached-definition",
        "cached-base",
        "views: [invalid\n",
    );
    build(&mut vault);
    let current = vault.open_document_snapshot().unwrap();
    expect_code(
        vault.query_base_document(&current, &id("cached-base"), &options),
        "base_compile",
    );
    let retained = vault
        .query_base_document(&old, &id("cached-base"), &options)
        .unwrap();
    assert_eq!(retained.value.definition, original.value.definition);
    assert_eq!(retained.value.result.rows, original.value.result.rows);
    vault.rebuild_document_index().unwrap();
    expect_code(
        vault.query_base_document(&old, &id("cached-base"), &options),
        "snapshot_expired",
    );
    expect_code(
        vault.query_base_document(&current, &id("cached-base"), &options),
        "snapshot_expired",
    );
    let now = u64::try_from(vault.base_preparation_clock.elapsed().as_millis()).unwrap();
    assert_eq!(
        vault
            .base_preparation_cache
            .borrow_mut()
            .compile_source(CACHED_BASE, now)
            .unwrap()
            .outcome(),
        zorid_bases::PreparationCacheOutcome::Miss,
        "successful generation rebuild clears this owner's program/preparation cache"
    );
    vault.close_document_snapshot(old);
    vault.close_document_snapshot(current);
}

#[test]
fn warmed_program_cannot_mask_corrupt_retained_projection_or_change_source() {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let cache_path = cache.path().canonicalize().unwrap().join("cache.sqlite");
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault.enable_local_document_cache(&cache_path).unwrap();
    create_cached_base_fixture(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    let options = cached_options();
    vault
        .query_base_document(&pin, &id("cached-base"), &options)
        .unwrap();
    vault
        .query_base_document(&pin, &id("cached-base"), &options)
        .unwrap();
    let connection = rusqlite::Connection::open(&cache_path).unwrap();
    assert_eq!(
        connection
            .execute(
                "UPDATE document_index_rows SET text=?1 WHERE entry_id=?2",
                rusqlite::params![b"views: [tampered]\n".as_slice(), "cached-base"]
            )
            .unwrap(),
        1
    );
    expect_code(
        vault.query_base_document(&pin, &id("cached-base"), &options),
        "rebuild_required",
    );
    assert_eq!(
        std::fs::read(dir.path().join("All.base")).unwrap(),
        CACHED_BASE.as_bytes()
    );
    assert_eq!(
        vault
            .read(&id("cached-base"))
            .unwrap()
            .unwrap()
            .content
            .unwrap(),
        CACHED_BASE.as_bytes()
    );
    vault.close_document_snapshot(pin);
}

thread_local! {
    static BASE_POST_QUERY_REBUILD: std::cell::RefCell<Option<(std::path::PathBuf,std::path::PathBuf)>> = const { std::cell::RefCell::new(None) };
}
fn rebuild_after_base_evaluation(point: &str) {
    record_base_answer_event(point);
    if point == "base_query_evaluated" {
        let (root, cache) = BASE_POST_QUERY_REBUILD
            .with(|value| value.borrow_mut().take())
            .unwrap();
        let mut other = NativeVault::open_existing(root).unwrap();
        other.enable_local_document_cache(cache).unwrap();
        other.rebuild_document_index().unwrap();
    }
}
#[test]
fn warm_evaluation_rechecks_pin_after_a_real_independent_rebuild_and_owner_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let cache_path = cache.path().canonicalize().unwrap().join("cache.sqlite");
    let mut vault = NativeVault::open(dir.path()).unwrap();
    vault.enable_local_document_cache(&cache_path).unwrap();
    create_cached_base_fixture(&mut vault);
    let options = cached_options();
    let pin = vault.open_document_snapshot().unwrap();
    vault
        .query_base_document(&pin, &id("cached-base"), &options)
        .unwrap();
    BASE_POST_QUERY_REBUILD
        .with(|value| *value.borrow_mut() = Some((dir.path().to_owned(), cache_path.clone())));
    BASE_ANSWER_EVENTS.with(|events| events.set((0, 0)));
    vault.fault = Some(rebuild_after_base_evaluation);
    expect_code(
        vault.query_base_document(&pin, &id("cached-base"), &options),
        "snapshot_expired",
    );
    assert_eq!(
        answer_events(),
        (1, 1),
        "the hit must still reach the final pin fence"
    );
    vault.fault = None;
    build(&mut vault);
    let current = vault.open_document_snapshot().unwrap();
    vault
        .query_base_document(&current, &id("cached-base"), &options)
        .unwrap();
    drop(vault);
    let mut reopened = NativeVault::open_existing(dir.path()).unwrap();
    reopened.enable_local_document_cache(&cache_path).unwrap();
    expect_code(
        reopened.query_base_document(&current, &id("cached-base"), &options),
        "snapshot_expired",
    );
    let fresh = reopened.open_document_snapshot().unwrap();
    let cold = reopened
        .query_base_document(&fresh, &id("cached-base"), &options)
        .unwrap();
    let warm = reopened
        .query_base_document(&fresh, &id("cached-base"), &options)
        .unwrap();
    assert!(
        warm.value.result.steps_used < cold.value.result.steps_used,
        "a reopened owner starts an empty pure-data cache"
    );
    assert_eq!(warm.value.result.rows, cold.value.result.rows);
    reopened.close_document_snapshot(fresh);
    drop(current);
    drop(pin);
}
