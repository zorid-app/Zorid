use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{DirectoryCoverage, DirectoryPhase, ScanObservation, ScanObservationKind, Store};
fn folder() -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("folder").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("folder").unwrap(),
            path: VaultPath::new("folder").unwrap(),
            kind: EntryKind::Folder,
            content: None,
        },
    }
}
const REMOVE_V3:&str="DROP TABLE directory_baselines; DROP TABLE directory_attempts; DROP TABLE scan_observations; DROP TABLE scan_directories; DROP TABLE scan_runs; PRAGMA user_version=2; PRAGMA journal_mode=DELETE;";
#[test]
fn canonical_v2_migrates_and_bad_v2_does_not_change_journal() {
    for corrupt in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let receipt = Store::open(&path).unwrap().apply(&folder()).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(REMOVE_V3).unwrap();
        if corrupt {
            db.execute_batch("DROP INDEX active_projection").unwrap();
        }
        drop(db);
        if corrupt {
            assert!(Store::open(&path).is_err());
            let db = rusqlite::Connection::open(&path).unwrap();
            assert_eq!(
                db.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                    .unwrap(),
                "delete"
            );
        } else {
            let mut store = Store::open(&path).unwrap();
            assert_eq!(store.apply(&folder()).unwrap(), receipt);
            assert_eq!(store.pending_counts().unwrap(), (1, 1));
            assert!(store.latest_scan().unwrap().is_none());
        }
    }
}
#[test]
fn directory_completion_retires_only_exact_create_not_child_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&folder()).unwrap();
    let id = EntryId::new("folder").unwrap();
    let a = store.begin_directory_projection(&id).unwrap();
    store
        .mark_directory_projection(&a.attempt_id, DirectoryPhase::Staged, Some("inode".into()))
        .unwrap();
    store
        .apply(&MutationRequest {
            operation_id: OperationId::new("child").unwrap(),
            mutation: Mutation::Create {
                id: EntryId::new("child").unwrap(),
                path: VaultPath::new("folder/child").unwrap(),
                kind: EntryKind::File,
                content: Some(b"bytes".to_vec()),
            },
        })
        .unwrap();
    store.finish_directory_projection(&a.attempt_id).unwrap();
    assert_eq!(store.pending_counts().unwrap(), (2, 1));
    assert_eq!(
        store
            .directory_baseline(&id)
            .unwrap()
            .unwrap()
            .state
            .revision,
        store.read(&id).unwrap().unwrap().state.revision
    );
}
#[test]
fn corrupt_directory_attempt_cannot_complete_or_retire_queue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    store.apply(&folder()).unwrap();
    let a = store
        .begin_directory_projection(&EntryId::new("folder").unwrap())
        .unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE directory_attempts SET record=json_set(record,'$.target.id','wrong')",
        [],
    )
    .unwrap();
    assert!(store.directory_attempts(true).is_err());
    assert!(store.finish_directory_projection(&a.attempt_id).is_err());
    assert_eq!(store.pending_counts().unwrap(), (1, 1));
}
#[test]
fn scan_budget_and_coverage_guard_absence_and_interrupted_runs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let receipt = store.apply(&folder()).unwrap();
    let entry = receipt.changes[0].after.clone();
    let scan = store.begin_scan(1).unwrap();
    store
        .record_directory_coverage(
            &scan.scan_id,
            &DirectoryCoverage {
                path: None,
                identity: Some("root".into()),
                complete: false,
                issue: Some("not scanned".into()),
            },
        )
        .unwrap();
    let absence = ScanObservation {
        path: entry.path.clone(),
        kind: ScanObservationKind::Absent,
        entry: Some(entry.clone()),
        baseline_revision: Some(entry.revision),
        identity: None,
        imported: false,
        issue: Some("pending".into()),
    };
    assert!(store
        .record_scan_observation(&scan.scan_id, &absence)
        .is_err());
    store
        .record_directory_coverage(
            &scan.scan_id,
            &DirectoryCoverage {
                path: None,
                identity: Some("root".into()),
                complete: true,
                issue: None,
            },
        )
        .unwrap();
    assert!(store
        .record_scan_observation(&scan.scan_id, &absence)
        .is_err());
    let positive = ScanObservation {
        path: VaultPath::new("observed").unwrap(),
        kind: ScanObservationKind::File,
        entry: None,
        baseline_revision: None,
        identity: Some("inode".into()),
        imported: false,
        issue: None,
    };
    store
        .record_scan_observation(&scan.scan_id, &positive)
        .unwrap();
    let other = ScanObservation {
        path: VaultPath::new("other").unwrap(),
        kind: ScanObservationKind::Blocked,
        entry: None,
        baseline_revision: None,
        identity: None,
        imported: false,
        issue: None,
    };
    assert!(store
        .record_scan_observation(&scan.scan_id, &other)
        .is_err());
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert!(!store.scan_run(&scan.scan_id).unwrap().finished);
    let finished = store
        .finish_scan(&scan.scan_id, false, Some("interrupted".into()))
        .unwrap();
    assert!(!finished.complete);
    assert!(store
        .scan_observations(&scan.scan_id)
        .unwrap()
        .iter()
        .all(|o| o.kind != ScanObservationKind::Absent));
    assert!(store
        .read(&EntryId::new("folder").unwrap())
        .unwrap()
        .is_some());
}
#[test]
fn v3_schema_constraints_are_canonical() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    drop(Store::open(&path).unwrap());
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP INDEX active_directory_projection; CREATE INDEX active_directory_projection ON directory_attempts(entry_id) WHERE completed=0").unwrap();
    assert!(Store::open(&path).is_err());
}

#[test]
fn final_absences_and_finished_marker_commit_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut store = Store::open(&path).unwrap();
    let mut absences = Vec::new();
    for name in ["a", "b"] {
        let id = EntryId::new(name).unwrap();
        store
            .apply(&MutationRequest {
                operation_id: OperationId::new(name).unwrap(),
                mutation: Mutation::Create {
                    id: id.clone(),
                    path: VaultPath::new(name).unwrap(),
                    kind: EntryKind::Folder,
                    content: None,
                },
            })
            .unwrap();
        let attempt = store.begin_directory_projection(&id).unwrap();
        store
            .mark_directory_projection(
                &attempt.attempt_id,
                DirectoryPhase::Staged,
                Some(format!("inode-{name}")),
            )
            .unwrap();
        store
            .finish_directory_projection(&attempt.attempt_id)
            .unwrap();
        let state = store.read(&id).unwrap().unwrap().state;
        absences.push(ScanObservation {
            path: state.path.clone(),
            kind: ScanObservationKind::Absent,
            entry: Some(state.clone()),
            baseline_revision: Some(state.revision),
            identity: None,
            imported: false,
            issue: Some("pending".into()),
        });
    }
    let scan = store.begin_scan(10).unwrap();
    store
        .record_directory_coverage(
            &scan.scan_id,
            &DirectoryCoverage {
                path: None,
                identity: Some("root".into()),
                complete: true,
                issue: None,
            },
        )
        .unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER fail_second_absence BEFORE INSERT ON scan_observations WHEN NEW.path='b' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(store
        .finish_scan_with_absences(&scan.scan_id, true, None, &absences)
        .is_err());
    assert!(store.scan_observations(&scan.scan_id).unwrap().is_empty());
    assert!(!store.scan_run(&scan.scan_id).unwrap().finished);
    db.execute_batch("DROP TRIGGER fail_second_absence;")
        .unwrap();
    let done = store
        .finish_scan_with_absences(&scan.scan_id, true, None, &absences)
        .unwrap();
    assert!(done.complete && done.finished);
    assert_eq!(done.observed, 2);
    assert_eq!(store.scan_observations(&scan.scan_id).unwrap().len(), 2);
    assert_eq!(store.list().unwrap().len(), 2);
}
