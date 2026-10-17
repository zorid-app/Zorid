use super::*;
use std::{collections::BTreeMap, os::unix::fs::MetadataExt, path::Path};
use zorid_store::{FamilyScope, PhysicalBinding};
use zorid_sync_protocol::{RealmId, VaultId};

#[derive(Clone)]
struct ExpectedEntry {
    kind: EntryKind,
    bytes: Option<Vec<u8>>,
    inode: String,
}
type Inventory = BTreeMap<VaultPath, ExpectedEntry>;
type SeenIds = BTreeMap<VaultPath, EntryId>;

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).unwrap()
}

fn batch_options() -> ScanOptions {
    ScanOptions {
        max_entries: 32,
        max_duration: std::time::Duration::from_secs(5),
        ..ScanOptions::default()
    }
}

fn record_expected(root: &Path, relative: &str, bytes: Option<Vec<u8>>, out: &mut Inventory) {
    let metadata = std::fs::metadata(root.join(relative)).unwrap();
    out.insert(
        path(relative),
        ExpectedEntry {
            kind: if metadata.is_dir() {
                EntryKind::Folder
            } else {
                EntryKind::File
            },
            bytes,
            inode: format!("{}:{}", metadata.dev(), metadata.ino()),
        },
    );
}

fn create_inventory(root: &Path, directories: usize) -> Inventory {
    let mut expected = Inventory::new();
    std::fs::create_dir(root.join("Inventory")).unwrap();
    record_expected(root, "Inventory", None, &mut expected);
    for index in 0..directories {
        let folder = format!("Inventory/d{index:03}");
        std::fs::create_dir(root.join(&folder)).unwrap();
        record_expected(root, &folder, None, &mut expected);
        // The wide fixture exercises the directory wall with representative
        // first/middle/last file imports, without multiplying CRDT setup cost.
        if directories > 256 && index != 0 && index != directories / 2 && index + 1 != directories {
            continue;
        }
        let name = format!("{folder}/note.custom");
        let bytes = format!("\u{feff}external note {index}\r\n").into_bytes();
        std::fs::write(root.join(&name), &bytes).unwrap();
        record_expected(root, &name, Some(bytes), &mut expected);
    }
    expected
}

fn add_note(root: &Path, relative: &str, bytes: &[u8], expected: &mut Inventory) {
    std::fs::write(root.join(relative), bytes).unwrap();
    record_expected(root, relative, Some(bytes.to_vec()), expected);
}

fn enrolled_with_missing_candidate(root: &Path) -> (NativeVault, PhysicalBinding) {
    let mut vault = NativeVault::open(root).unwrap();
    vault
        .family_enroll(&FamilyScope {
            realm_id: RealmId::new("progress-realm").unwrap(),
            vault_id: VaultId::new("progress-vault").unwrap(),
        })
        .unwrap();
    std::fs::write(
        root.join("missing.custom"),
        b"retained until complete inventory",
    )
    .unwrap();
    let report = vault
        .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
        .unwrap();
    assert!(report.complete, "{report:?}");
    let entry = vault
        .list()
        .unwrap()
        .into_iter()
        .find(|e| e.path == path("missing.custom"))
        .unwrap();
    let binding = vault.store.physical_binding(&entry.id).unwrap().unwrap();
    (vault, binding)
}

fn assert_retained_missing(vault: &mut NativeVault, before: &PhysicalBinding) {
    assert_eq!(
        vault
            .store
            .physical_binding(&before.state.id)
            .unwrap()
            .as_ref(),
        Some(before)
    );
    assert!(vault
        .list()
        .unwrap()
        .iter()
        .any(|e| e.id == before.state.id));
    let baseline = vault
        .store
        .projection_baseline(&before.state.id)
        .unwrap()
        .unwrap();
    assert_eq!(baseline.state, before.state);
    assert_eq!(
        vault
            .test_content_bytes(Some(&baseline.state), &baseline.content)
            .unwrap(),
        b"retained until complete inventory"
    );
}

fn observe_visible(vault: &mut NativeVault, expected: &Inventory, seen: &mut SeenIds) {
    let bindings: BTreeMap<_, _> = vault
        .store
        .physical_bindings()
        .unwrap()
        .into_iter()
        .map(|b| (b.state.id.clone(), b))
        .collect();
    for entry in vault.list().unwrap() {
        if entry.path == path("missing.custom") {
            continue;
        }
        let expected_entry = expected
            .get(&entry.path)
            .unwrap_or_else(|| panic!("unexpected visible path {}", entry.path.as_str()));
        assert_eq!(entry.kind, expected_entry.kind);
        if let Some(previous) = seen.insert(entry.path.clone(), entry.id.clone()) {
            assert_eq!(
                entry.id, previous,
                "an already imported identity changed between batches"
            );
        }
        let physical = bindings.get(&entry.id).unwrap();
        assert_eq!(physical.state.path, entry.path);
        assert_eq!(physical.physical.inode, expected_entry.inode);
        if let Some(bytes) = &expected_entry.bytes {
            assert_eq!(
                vault.read(&entry.id).unwrap().unwrap().content.as_ref(),
                Some(bytes)
            );
            let baseline = vault.store.projection_baseline(&entry.id).unwrap().unwrap();
            assert_eq!(
                vault
                    .test_content_bytes(Some(&baseline.state), &baseline.content)
                    .unwrap(),
                *bytes
            );
        }
    }
}

// Every pass opens an independent NativeVault, so this cannot pass through an
// in-memory queue that is accidentally lost between applications or processes.
fn finish_inventory(
    root: &Path,
    expected: &Inventory,
    seen: &mut SeenIds,
    missing: &PhysicalBinding,
    initial_scan: Option<OperationId>,
    invalidated_scan: Option<&OperationId>,
) -> (ExternalReconcileReport, usize) {
    let mut active = initial_scan;
    for pass in 0..128 {
        let mut vault = NativeVault::open_existing(root).unwrap();
        let report = vault
            .reconcile_external(batch_options(), ExternalFileMode::Auto)
            .unwrap();
        assert!(
            report.imported.len() <= 32,
            "positive enrollment exceeded a batch: {report:?}"
        );
        if let Some(invalidated) = invalidated_scan {
            assert_ne!(
                &report.run.scan_id, invalidated,
                "an invalidated cursor was resumed"
            );
        }
        if let Some(previous) = &active {
            assert_eq!(
                &report.run.scan_id, previous,
                "reopening lost the pending scan cursor"
            );
        } else {
            active = Some(report.run.scan_id.clone());
        }
        observe_visible(&mut vault, expected, seen);
        if report.run.finished {
            assert!(
                report.run.complete,
                "a stable bounded inventory was abandoned: {report:?}"
            );
            assert!(report.complete, "{report:?}");
            assert_eq!(seen.len(), expected.len());
            assert_eq!(vault.list().unwrap().len(), expected.len());
            assert_eq!(
                report.namespace.len(),
                1,
                "only the captured missing file is deleted"
            );
            assert!(vault
                .store
                .physical_binding(&missing.state.id)
                .unwrap()
                .is_none());
            assert!(vault
                .store
                .projection_baseline(&missing.state.id)
                .unwrap()
                .is_none());
            for (relative, entry) in expected {
                if let Some(bytes) = &entry.bytes {
                    assert_eq!(std::fs::read(root.join(relative.as_str())).unwrap(), *bytes);
                }
            }
            return (report, pass + 1);
        }
        assert!(!report.complete);
        assert!(!report.run.complete);
        assert!(
            report.namespace.is_empty(),
            "partial inventory authorized namespace changes"
        );
        assert_retained_missing(&mut vault, missing);
    }
    panic!("bounded inventory did not finish within 128 independent reopen passes");
}

fn first_pending(
    root: &Path,
    expected: &Inventory,
    seen: &mut SeenIds,
    missing: &PhysicalBinding,
) -> OperationId {
    let mut vault = NativeVault::open_existing(root).unwrap();
    let report = vault
        .reconcile_external(batch_options(), ExternalFileMode::Auto)
        .unwrap();
    assert!(
        !report.run.finished,
        "fixture must span multiple batches: {report:?}"
    );
    assert!(!report.run.complete);
    assert!(!report.complete);
    assert!(report.namespace.is_empty());
    assert!(report.imported.len() <= 32);
    observe_visible(&mut vault, expected, seen);
    assert_retained_missing(&mut vault, missing);
    report.run.scan_id
}

fn assert_invalidated(root: &Path, scan: &OperationId, missing: &PhysicalBinding) {
    for _ in 0..128 {
        let mut vault = NativeVault::open_existing(root).unwrap();
        let report = vault
            .reconcile_external(batch_options(), ExternalFileMode::Auto)
            .unwrap();
        assert_eq!(&report.run.scan_id, scan);
        assert!(
            !report.run.complete,
            "a changed inventory must never finish as complete"
        );
        assert!(!report.complete);
        assert!(report.namespace.is_empty());
        assert_retained_missing(&mut vault, missing);
        if report.run.finished {
            assert!(!report.issues.is_empty());
            let durable = vault.store.scan_run(scan).unwrap();
            assert_eq!(durable, report.run);
            return;
        }
    }
    panic!("changed inventory did not invalidate within 128 bounded reopen passes");
}

#[test]
fn external_scan_progress_more_than_257_directories_survives_bounded_reopens() {
    let root = tempfile::tempdir().unwrap();
    let (vault, missing) = enrolled_with_missing_candidate(root.path());
    drop(vault);
    let expected = create_inventory(root.path(), 257);
    assert_eq!(
        expected
            .values()
            .filter(|e| e.kind == EntryKind::Folder)
            .count(),
        258
    );
    std::fs::remove_file(root.path().join("missing.custom")).unwrap();
    let mut seen = SeenIds::new();
    let scan = first_pending(root.path(), &expected, &mut seen, &missing);
    let (report, passes) = finish_inventory(
        root.path(),
        &expected,
        &mut seen,
        &missing,
        Some(scan.clone()),
        None,
    );
    assert_eq!(report.run.scan_id, scan);
    assert!(passes > 1);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let repeat = vault
        .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
        .unwrap();
    assert!(repeat.complete, "{repeat:?}");
    assert!(repeat.imported.is_empty());
    assert!(repeat.namespace.is_empty());
    observe_visible(&mut vault, &expected, &mut seen);
}

#[test]
fn external_scan_progress_root_marker_change_discards_global_inventory_before_deletion() {
    let root = tempfile::tempdir().unwrap();
    let (vault, missing) = enrolled_with_missing_candidate(root.path());
    drop(vault);
    let mut expected = create_inventory(root.path(), 80);
    std::fs::remove_file(root.path().join("missing.custom")).unwrap();
    let mut seen = SeenIds::new();
    let stale = first_pending(root.path(), &expected, &mut seen, &missing);
    add_note(
        root.path(),
        "new-root.custom",
        b"created after the first batch\r\n",
        &mut expected,
    );
    assert_invalidated(root.path(), &stale, &missing);
    let (report, _) = finish_inventory(
        root.path(),
        &expected,
        &mut seen,
        &missing,
        None,
        Some(&stale),
    );
    assert_ne!(report.run.scan_id, stale);
    assert!(seen.contains_key(&path("new-root.custom")));
}

// Choose a directory whose note was already positively imported. Its directory
// marker has necessarily been captured and its listing has been enumerated.
fn pending_with_enumerated_child(
    root: &Path,
    expected: &Inventory,
    seen: &mut SeenIds,
    missing: &PhysicalBinding,
) -> (OperationId, VaultPath) {
    let mut active = None;
    for _ in 0..20 {
        let mut vault = NativeVault::open_existing(root).unwrap();
        let report = vault
            .reconcile_external(batch_options(), ExternalFileMode::Auto)
            .unwrap();
        assert!(
            !report.run.finished,
            "fixture completed before choosing an enumerated parent"
        );
        assert!(!report.complete);
        assert!(report.namespace.is_empty());
        if let Some(previous) = &active {
            assert_eq!(&report.run.scan_id, previous);
        }
        active = Some(report.run.scan_id.clone());
        observe_visible(&mut vault, expected, seen);
        assert_retained_missing(&mut vault, missing);
        if let Some(note) = vault
            .list()
            .unwrap()
            .into_iter()
            .find(|e| e.kind == EntryKind::File && e.path.as_str().starts_with("Inventory/"))
        {
            return (report.run.scan_id, note.path.parent().unwrap());
        }
    }
    panic!("no positive child import within 20 bounded passes");
}

#[test]
fn external_scan_progress_enumerated_parent_content_change_invalidates_before_deletion() {
    let root = tempfile::tempdir().unwrap();
    let (vault, missing) = enrolled_with_missing_candidate(root.path());
    drop(vault);
    let mut expected = create_inventory(root.path(), 80);
    std::fs::remove_file(root.path().join("missing.custom")).unwrap();
    let mut seen = SeenIds::new();
    let (stale, parent) =
        pending_with_enumerated_child(root.path(), &expected, &mut seen, &missing);
    let added = format!("{}/new-after-listing.custom", parent.as_str());
    add_note(
        root.path(),
        &added,
        b"new note inside an already scanned parent",
        &mut expected,
    );
    assert_invalidated(root.path(), &stale, &missing);
    finish_inventory(
        root.path(),
        &expected,
        &mut seen,
        &missing,
        None,
        Some(&stale),
    );
    assert!(seen.contains_key(&path(&added)));
}

#[test]
fn external_scan_progress_parent_inode_replacement_invalidates_and_restored_inode_restarts() {
    let root = tempfile::tempdir().unwrap();
    let saved = tempfile::tempdir().unwrap();
    let (vault, missing) = enrolled_with_missing_candidate(root.path());
    drop(vault);
    let mut expected = create_inventory(root.path(), 80);
    std::fs::remove_file(root.path().join("missing.custom")).unwrap();
    let mut seen = SeenIds::new();
    let (stale, parent) =
        pending_with_enumerated_child(root.path(), &expected, &mut seen, &missing);
    let parent_path = root.path().join(parent.as_str());
    let held_parent = std::fs::File::open(&parent_path).unwrap();
    let original_inode = fs::identity(&held_parent).unwrap();
    std::fs::rename(&parent_path, saved.path().join("original-parent")).unwrap();
    std::fs::create_dir(&parent_path).unwrap();
    let replacement = std::fs::File::open(&parent_path).unwrap();
    assert_ne!(fs::identity(&replacement).unwrap(), original_inode);
    assert_invalidated(root.path(), &stale, &missing);
    // A persistent replacement correctly remains a physical ownership conflict.
    // Restore the same original inode before asking a fresh inventory to finish.
    drop(replacement);
    std::fs::remove_dir(&parent_path).unwrap();
    std::fs::rename(saved.path().join("original-parent"), &parent_path).unwrap();
    assert_eq!(
        fs::identity(&std::fs::File::open(&parent_path).unwrap()).unwrap(),
        original_inode
    );
    let added = format!("{}/new-after-restore.custom", parent.as_str());
    add_note(
        root.path(),
        &added,
        b"new note after restoring the original parent",
        &mut expected,
    );
    finish_inventory(
        root.path(),
        &expected,
        &mut seen,
        &missing,
        None,
        Some(&stale),
    );
    assert!(seen.contains_key(&path(&added)));
}

#[test]
fn external_scan_progress_ready_retries_partial_moved_edit_and_new_child() {
    let root = tempfile::tempdir().unwrap();
    let (mut vault, _) = enrolled_with_missing_candidate(root.path());
    std::fs::create_dir(root.path().join("Original")).unwrap();
    std::fs::write(root.path().join("Original/note.custom"), b"original").unwrap();
    let initial = vault
        .reconcile_external(ScanOptions::default(), ExternalFileMode::Auto)
        .unwrap();
    assert!(initial.complete, "{initial:?}");
    let folder = vault
        .list()
        .unwrap()
        .into_iter()
        .find(|e| e.path == path("Original"))
        .unwrap();
    let note = vault
        .list()
        .unwrap()
        .into_iter()
        .find(|e| e.path == path("Original/note.custom"))
        .unwrap();
    let original_inode = vault
        .store
        .physical_binding(&note.id)
        .unwrap()
        .unwrap()
        .physical
        .inode;
    drop(vault);
    std::fs::rename(root.path().join("Original"), root.path().join("AMoved")).unwrap();
    let edited = b"\xef\xbb\xbfedited while moving\r\n";
    std::fs::write(root.path().join("AMoved/note.custom"), edited).unwrap();
    std::fs::write(
        root.path().join("AMoved/new.custom"),
        b"new child inside relocated folder",
    )
    .unwrap();
    // AMoved is enumerated before these padding subtrees. Their child files
    // keep global inventory unfinished while relocated paths are attempted.
    for index in 0..20 {
        let folder = format!("Padding{index:02}");
        std::fs::create_dir(root.path().join(&folder)).unwrap();
        std::fs::write(
            root.path().join(format!("{folder}/padding.custom")),
            b"padding",
        )
        .unwrap();
    }
    let options = ScanOptions {
        max_entries: 4,
        ..batch_options()
    };
    let mut active = None;
    let mut partial_move_issue = false;
    let mut finished = false;
    let mut namespace_receipts = 0;
    for _ in 0..128 {
        let mut vault = NativeVault::open_existing(root.path()).unwrap();
        let report = vault
            .reconcile_external(options.clone(), ExternalFileMode::Auto)
            .unwrap();
        if let Some(previous) = &active {
            assert_eq!(&report.run.scan_id, previous);
        }
        active = Some(report.run.scan_id.clone());
        namespace_receipts += report.namespace.len();
        if !report.run.complete {
            assert!(!report.complete);
            assert!(report.namespace.is_empty());
            partial_move_issue |= report.issues.iter().any(|issue| {
                issue.path.as_ref().is_some_and(|p| {
                    p == &path("AMoved/note.custom") || p == &path("AMoved/new.custom")
                })
            });
            continue;
        }
        if !report.complete {
            continue;
        }
        assert!(
            report.complete,
            "Ready must revisit positives blocked before namespace authority: {report:?}"
        );
        assert_eq!(namespace_receipts, 1);
        assert_eq!(
            vault
                .list()
                .unwrap()
                .into_iter()
                .find(|e| e.path == path("AMoved"))
                .unwrap()
                .id,
            folder.id
        );
        let retained = vault.read(&note.id).unwrap().unwrap();
        assert_eq!(retained.state.path, path("AMoved/note.custom"));
        assert_eq!(retained.content.as_deref(), Some(edited.as_slice()));
        let baseline = vault.store.projection_baseline(&note.id).unwrap().unwrap();
        assert_eq!(
            vault
                .test_content_bytes(Some(&baseline.state), &baseline.content)
                .unwrap(),
            edited
        );
        assert_eq!(
            vault
                .store
                .physical_binding(&note.id)
                .unwrap()
                .unwrap()
                .physical
                .inode,
            original_inode
        );
        let child = vault
            .list()
            .unwrap()
            .into_iter()
            .find(|e| e.path == path("AMoved/new.custom"))
            .unwrap();
        assert_ne!(child.id, note.id);
        assert_eq!(
            vault.read(&child.id).unwrap().unwrap().content.as_deref(),
            Some(b"new child inside relocated folder".as_slice())
        );
        assert_eq!(
            std::fs::read(root.path().join("AMoved/note.custom")).unwrap(),
            edited
        );
        assert!(!root.path().join("Original").exists());
        finished = true;
        break;
    }
    assert!(
        partial_move_issue,
        "fixture must attempt a relocated positive while inventory is unfinished"
    );
    assert!(
        finished,
        "moved edit and new child did not complete within 128 bounded reopen passes"
    );
}

#[test]
fn external_scan_progress_present_proof_without_observation_is_fatal_corruption() {
    let root = tempfile::tempdir().unwrap();
    let (vault, _) = enrolled_with_missing_candidate(root.path());
    drop(vault);
    create_inventory(root.path(), 80);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let report = vault
        .reconcile_external(batch_options(), ExternalFileMode::Auto)
        .unwrap();
    assert!(
        !report.run.finished,
        "fixture must leave a persisted partial inventory"
    );
    assert!(!report.complete);
    let before = vault.store.physical_bindings().unwrap();
    let status = vault.family_status().unwrap();
    let sql = rusqlite::Connection::open(root.path().join(".zorid/vault.sqlite")).unwrap();
    let captured: String = sql.query_row(
        "SELECT p.path FROM family_external_scan_proofs p JOIN scan_observations o ON o.scan_id=p.scan_id AND o.path=p.path WHERE p.scan_id=?1 AND json_extract(p.record,'$.kind')='present' ORDER BY p.path LIMIT 1",
        [report.run.scan_id.as_str()], |row| row.get(0),
    ).unwrap();
    assert_eq!(
        sql.execute(
            "DELETE FROM scan_observations WHERE scan_id=?1 AND path=?2",
            rusqlite::params![report.run.scan_id.as_str(), &captured]
        )
        .unwrap(),
        1
    );
    let proofs: i64 = sql
        .query_row(
            "SELECT count(*) FROM family_external_scan_proofs WHERE scan_id=?1 AND path=?2",
            rusqlite::params![report.run.scan_id.as_str(), &captured],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        proofs, 1,
        "retain the immutable proof while corrupting its observation row"
    );
    drop(sql);
    drop(vault);
    let mut vault = NativeVault::open_existing(root.path()).unwrap();
    let error = vault
        .reconcile_external(batch_options(), ExternalFileMode::Auto)
        .unwrap_err();
    assert!(
        matches!(error, Error::Store(zorid_store::StoreError::Corrupt(_))),
        "{error:?}"
    );
    assert_eq!(vault.store.physical_bindings().unwrap(), before);
    assert_eq!(vault.family_status().unwrap(), status);
}
