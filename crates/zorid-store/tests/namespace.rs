use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_store::{
    DirectoryPhase, NamespaceAttempt, NamespaceEvidence, ProjectionPhase, ProjectionWork, Store,
};

fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn op(s: &str) -> OperationId {
    OperationId::new(s).unwrap()
}
fn path(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}
fn seed(store: &mut Store, name: &str, p: &str, kind: EntryKind) {
    store
        .apply(&MutationRequest {
            operation_id: op(&format!("create-{name}")),
            mutation: Mutation::Create {
                id: id(name),
                path: path(p),
                kind,
                content: (kind == EntryKind::File).then(|| b"original".to_vec()),
            },
        })
        .unwrap();
    if kind == EntryKind::File {
        let a = store.begin_projection(&id(name)).unwrap();
        store
            .mark_projection(
                &a.attempt_id,
                ProjectionPhase::Staged,
                Some(format!("inode-{name}")),
            )
            .unwrap();
        store.finish_projection(&a.attempt_id, true).unwrap();
    } else {
        let a = store.begin_directory_projection(&id(name)).unwrap();
        store
            .mark_directory_projection(
                &a.attempt_id,
                DirectoryPhase::Staged,
                Some(format!("inode-{name}")),
            )
            .unwrap();
        store.finish_directory_projection(&a.attempt_id).unwrap();
    }
}
fn evidence(store: &Store, name: &str, moving: bool) -> NamespaceEvidence {
    let value = store.read(&id(name)).unwrap().unwrap();
    NamespaceEvidence {
        before: value.state,
        source_identity: format!("inode-{name}"),
        source_parent_identity: "root-inode".into(),
        destination_parent_identity: moving.then(|| "root-inode".into()),
        content: value.content,
        file_baseline: store.projection_baseline(&id(name)).unwrap(),
        directory_baseline: store.directory_baseline(&id(name)).unwrap(),
        physical_binding: store.physical_binding(&id(name)).unwrap(),
    }
}
fn moving(store: &Store, name: &str, p: &str, operation: &str) -> MutationRequest {
    MutationRequest {
        operation_id: op(operation),
        mutation: Mutation::Move {
            id: id(name),
            expected: store.read(&id(name)).unwrap().unwrap().state.revision,
            path: path(p),
        },
    }
}
fn deleting(store: &Store, name: &str, operation: &str) -> MutationRequest {
    MutationRequest {
        operation_id: op(operation),
        mutation: Mutation::Delete {
            id: id(name),
            expected: store.read(&id(name)).unwrap().unwrap().state.revision,
            recursive: true,
        },
    }
}
fn complete_members(store: &mut Store, mut a: NamespaceAttempt) -> NamespaceAttempt {
    for index in 0..a.members.len() {
        let old = a.members[index].clone();
        let mut next = old.clone();
        let same = a.job.work == ProjectionWork::Move
            && next.evidence.before.path == next.change.after.path;
        next.captured = !same;
        next.published = !same && a.job.work == ProjectionWork::Move;
        next.finished = true;
        if next.published && next.change.after.kind == EntryKind::Folder {
            next.directory_stage_identity = Some(format!("new-{}", next.change.after.id.as_str()));
        }
        a.members[index] = store
            .update_namespace_member(&a.job.job_id, &old, &next)
            .unwrap();
    }
    a
}
#[test]
fn move_restart_exact_retirement_keeps_later_write_pending() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    seed(&mut s, "file", "old", EntryKind::File);
    let req = moving(&s, "file", "new", "move");
    let proof = evidence(&s, "file", true);
    let receipt = s.apply_namespace(&req, &[proof.clone()]).unwrap();
    assert_eq!(s.apply_namespace(&req, &[]).unwrap(), receipt);
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(a.members[0].evidence, proof);
    drop(s);
    let mut s = Store::open(&db).unwrap();
    assert_eq!(s.namespace_attempts(false).unwrap(), vec![a.clone()]);
    let write = MutationRequest {
        operation_id: op("later-write"),
        mutation: Mutation::Write {
            id: id("file"),
            expected: s.read(&id("file")).unwrap().unwrap().state.revision,
            content: b"later".to_vec(),
        },
    };
    s.apply(&write).unwrap();
    let a = complete_members(&mut s, a);
    let finished = s.finish_namespace(&a.job.job_id).unwrap();
    assert!(finished.completed);
    assert_eq!(s.finish_namespace(&a.job.job_id).unwrap(), finished);
    let baseline = s.projection_baseline(&id("file")).unwrap().unwrap();
    assert_eq!(baseline.state.path, path("new"));
    assert_eq!(baseline.content, b"original");
    let binding = s.physical_binding(&id("file")).unwrap().unwrap();
    assert_eq!(binding.state, baseline.state);
    assert_eq!(binding.physical.inode, "inode-file");
    assert_eq!(binding.physical.parent_inode, "root-inode");
    assert_eq!(
        s.read(&id("file")).unwrap().unwrap().content.unwrap(),
        b"later"
    );
    let pending = s.pending_projection_jobs(100).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].work, ProjectionWork::MaterializeFile);
    assert!(s.namespace_attempts(false).unwrap().is_empty());
    assert_eq!(s.namespace_attempts(true).unwrap(), vec![finished]);
}
#[test]
fn deletion_retains_immutable_baseline_and_requires_capture() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    seed(&mut s, "file", "file", EntryKind::File);
    let req = deleting(&s, "file", "delete");
    let proof = evidence(&s, "file", false);
    s.apply_namespace(&req, &[proof.clone()]).unwrap();
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    assert!(s.finish_namespace(&a.job.job_id).is_err());
    let old = &a.members[0];
    let mut bad = old.clone();
    bad.finished = true;
    assert!(s.update_namespace_member(&a.job.job_id, old, &bad).is_err());
    let a = complete_members(&mut s, a);
    s.finish_namespace(&a.job.job_id).unwrap();
    assert!(s.projection_baseline(&id("file")).unwrap().is_none());
    let kept = s.namespace_attempts(true).unwrap();
    assert_eq!(kept[0].members[0].evidence, proof);
    assert!(s.projection_job(&a.job.job_id).unwrap().completed);
}
#[test]
fn exact_subtree_members_and_destination_parent_proofs_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    seed(&mut s, "folder", "old", EntryKind::Folder);
    seed(&mut s, "child", "old/child", EntryKind::File);
    let req = moving(&s, "folder", "new", "folder-move");
    let folder = evidence(&s, "folder", true);
    let mut child = evidence(&s, "child", true);
    child.destination_parent_identity = None;
    assert!(s.apply_namespace(&req, &[folder.clone()]).is_err());
    assert_eq!(
        s.read(&id("folder")).unwrap().unwrap().state.path,
        path("old")
    );
    assert!(s.replay(&req).unwrap().is_none());
    s.apply_namespace(&req, &[child, folder]).unwrap();
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(a.members.len(), 2);
    let a = complete_members(&mut s, a);
    s.finish_namespace(&a.job.job_id).unwrap();
    assert_eq!(
        s.directory_baseline(&id("folder"))
            .unwrap()
            .unwrap()
            .identity,
        "new-folder"
    );
    assert_eq!(
        s.projection_baseline(&id("child"))
            .unwrap()
            .unwrap()
            .state
            .path,
        path("new/child")
    );
}
#[test]
fn progress_cas_rejects_rebinding_rewinds_and_missing_destination_proof() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    seed(&mut s, "file", "old", EntryKind::File);
    let req = moving(&s, "file", "new", "move");
    let mut proof = evidence(&s, "file", true);
    proof.destination_parent_identity = None;
    assert!(s.apply_namespace(&req, &[proof]).is_err());
    let proof = evidence(&s, "file", true);
    s.apply_namespace(&req, &[proof]).unwrap();
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    let old = &a.members[0];
    let mut changed = old.clone();
    changed.evidence.source_identity = "replacement".into();
    assert!(s
        .update_namespace_member(&a.job.job_id, old, &changed)
        .is_err());
    let mut captured = old.clone();
    captured.captured = true;
    s.update_namespace_member(&a.job.job_id, old, &captured)
        .unwrap();
    assert!(s
        .update_namespace_member(&a.job.job_id, old, &captured)
        .is_err());
    assert!(s
        .update_namespace_member(&a.job.job_id, &captured, old)
        .is_err());
}
#[test]
fn active_attempts_and_overlapping_namespace_work_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    seed(&mut s, "file", "old", EntryKind::File);
    let req = moving(&s, "file", "new", "move");
    let proof = evidence(&s, "file", true);
    let active = s.begin_projection(&id("file")).unwrap();
    assert!(s.apply_namespace(&req, &[proof.clone()]).is_err());
    s.finish_projection(&active.attempt_id, false).unwrap();
    s.apply_namespace(&req, &[proof]).unwrap();
    let second = moving(&s, "file", "third", "move-again");
    let proof = evidence(&s, "file", true);
    assert!(s.apply_namespace(&second, &[proof]).is_err());
    assert!(s.replay(&second).unwrap().is_none());
}
#[test]
fn baseline_cas_failure_does_not_retire_job_or_discard_proof() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    seed(&mut s, "file", "old", EntryKind::File);
    let req = moving(&s, "file", "new", "move");
    let proof = evidence(&s, "file", true);
    s.apply_namespace(&req, &[proof]).unwrap();
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    let a = complete_members(&mut s, a);
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute(
        "UPDATE projection_baselines SET record=json_set(record,'$.content',json('[1]'))",
        [],
    )
    .unwrap();
    assert!(s.finish_namespace(&a.job.job_id).is_err());
    assert!(!s.projection_job(&a.job.job_id).unwrap().completed);
    assert!(!s.namespace_attempts(false).unwrap()[0].completed);
}
#[test]
fn schema_six_legacy_namespace_job_migrates_without_fabricated_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    seed(&mut s, "file", "old", EntryKind::File);
    let req = moving(&s, "file", "new", "legacy");
    s.apply(&req).unwrap();
    drop(s);
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch("DROP TABLE namespace_member_progress; DROP TABLE namespace_members; DROP TABLE namespace_attempts; PRAGMA user_version=6;")
        .unwrap();
    drop(c);
    let mut s = Store::open(&db).unwrap();
    assert!(s.namespace_attempts(true).unwrap().is_empty());
    assert_eq!(s.namespace_jobs().unwrap().len(), 1);
    assert!(s.apply_namespace(&req, &[]).is_err());
    assert!(!s.namespace_jobs().unwrap()[0].completed);
}
#[test]
fn same_path_move_finishes_without_displacing_inode() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    seed(&mut s, "file", "same", EntryKind::File);
    let req = moving(&s, "file", "same", "same-path");
    let proof = evidence(&s, "file", true);
    s.apply_namespace(&req, &[proof]).unwrap();
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    let mut wrong = a.members[0].clone();
    wrong.captured = true;
    assert!(s
        .update_namespace_member(&a.job.job_id, &a.members[0], &wrong)
        .is_err());
    let a = complete_members(&mut s, a);
    assert!(s.finish_namespace(&a.job.job_id).unwrap().completed);
}

#[test]
fn namespace_record_corruption_fails_before_progress_or_retirement() {
    for change in [
        "UPDATE namespace_members SET evidence=json_set(evidence,'$.source_identity','')",
        "UPDATE namespace_attempts SET record=json_set(record,'$.job_id','other')",
        "UPDATE namespace_members SET change=json_set(change,'$.after.path','unrelated')",
        "UPDATE namespace_member_progress SET finished=1",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db");
        let mut s = Store::open(&db).unwrap();
        seed(&mut s, "file", "old", EntryKind::File);
        let req = moving(&s, "file", "new", "move");
        let proof = evidence(&s, "file", true);
        s.apply_namespace(&req, &[proof]).unwrap();
        let a = s
            .namespace_for_operation(&req.operation_id)
            .unwrap()
            .unwrap();
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute(change, []).unwrap();
        assert!(s.namespace_attempts(true).is_err());
        assert!(s.finish_namespace(&a.job.job_id).is_err());
        assert!(!s.projection_job(&a.job.job_id).unwrap().completed);
        assert_eq!(
            s.projection_baseline(&id("file"))
                .unwrap()
                .unwrap()
                .state
                .path,
            path("old")
        );
    }
}

#[test]
fn stale_content_or_directory_identity_cannot_commit_namespace_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    seed(&mut s, "file", "file", EntryKind::File);
    let req = deleting(&s, "file", "delete-file");
    let mut proof = evidence(&s, "file", false);
    proof.content = Some(b"different".to_vec());
    assert!(s.apply_namespace(&req, &[proof]).is_err());
    assert!(s.replay(&req).unwrap().is_none());
    seed(&mut s, "folder", "folder", EntryKind::Folder);
    let req = deleting(&s, "folder", "delete-folder");
    let mut proof = evidence(&s, "folder", false);
    proof.source_identity = "recreated-directory".into();
    assert!(s.apply_namespace(&req, &[proof]).is_err());
    assert!(s.replay(&req).unwrap().is_none());
}

#[test]
fn legacy_pending_job_blocks_new_namespace_authority_on_same_member() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("db")).unwrap();
    seed(&mut s, "file", "same", EntryKind::File);
    let legacy = moving(&s, "file", "same", "legacy-same");
    s.apply(&legacy).unwrap();
    let next = deleting(&s, "file", "delete-after-legacy");
    let proof = evidence(&s, "file", false);
    assert!(s.apply_namespace(&next, &[proof]).is_err());
    assert!(s.replay(&next).unwrap().is_none());
    assert!(s.namespace_attempts(true).unwrap().is_empty());
    assert!(!s.namespace_jobs().unwrap()[0].completed);
}

#[test]
fn prior_publication_jobs_require_settlement_even_without_active_attempts() {
    for kind in [EntryKind::File, EntryKind::Folder] {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path().join("db")).unwrap();
        s.apply(&MutationRequest {
            operation_id: op("create"),
            mutation: Mutation::Create {
                id: id("entry"),
                path: path("entry"),
                kind,
                content: (kind == EntryKind::File).then(|| b"original".to_vec()),
            },
        })
        .unwrap();
        if kind == EntryKind::Folder {
            let state = s.read(&id("entry")).unwrap().unwrap().state;
            s.bind_directory(&state, "inode-entry").unwrap();
        }
        let req = deleting(&s, "entry", "delete-pending");
        let proof = evidence(&s, "entry", false);
        assert!(s.apply_namespace(&req, &[proof]).is_err());
        assert!(s.replay(&req).unwrap().is_none());
        assert!(s.namespace_attempts(true).unwrap().is_empty());
        assert_eq!(s.pending_projection_jobs(100).unwrap().len(), 1);
    }
}

#[test]
fn metadata_does_not_decode_evidence_and_progress_reads_only_selected_member() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    seed(&mut s, "folder", "old", EntryKind::Folder);
    seed(&mut s, "a", "old/a", EntryKind::File);
    seed(&mut s, "b", "old/b", EntryKind::File);
    let req = moving(&s, "folder", "new", "move-many");
    let mut proofs = vec![
        evidence(&s, "folder", true),
        evidence(&s, "a", true),
        evidence(&s, "b", true),
    ];
    for p in &mut proofs {
        if p.before.kind == EntryKind::File {
            p.destination_parent_identity = None;
        }
    }
    s.apply_namespace(&req, &proofs).unwrap();
    let original = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    let a_index = original
        .members
        .iter()
        .position(|m| m.change.after.id == id("a"))
        .unwrap();
    let b_index = original
        .members
        .iter()
        .position(|m| m.change.after.id == id("b"))
        .unwrap();
    let c = rusqlite::Connection::open(&db).unwrap();
    let unchanged: String = c
        .query_row(
            "SELECT evidence FROM namespace_members WHERE entry_id='a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    c.execute(
        "UPDATE namespace_members SET evidence='not JSON' WHERE entry_id='b'",
        [],
    )
    .unwrap();
    // Equality alone would permit rewriting identical evidence. Forbid every
    // immutable-member UPDATE while exercising the small progress journal.
    c.execute_batch(
        "CREATE TRIGGER forbid_namespace_member_rewrite BEFORE UPDATE ON namespace_members BEGIN SELECT RAISE(ABORT,'immutable evidence rewrite'); END;",
    )
    .unwrap();
    let metadata = s.namespace_attempt_metadata(true).unwrap();
    assert_eq!(metadata[0].members.len(), 3);
    assert_eq!(metadata[0].members[a_index].index, a_index);
    assert_eq!(metadata[0].members[a_index].source_identity, "inode-a");
    assert_eq!(metadata[0].job, original.job);
    assert!(s.namespace_attempt(&original.job.job_id).is_err());
    assert!(s.namespace_member(&original.job.job_id, b_index).is_err());
    let old = &original.members[a_index];
    let mut next = old.clone();
    next.captured = true;
    let updated = s
        .update_namespace_member(&original.job.job_id, old, &next)
        .unwrap();
    assert_eq!(updated, next);
    assert_eq!(
        s.namespace_member(&original.job.job_id, a_index).unwrap(),
        next
    );
    let after: String = c
        .query_row(
            "SELECT evidence FROM namespace_members WHERE entry_id='a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unchanged, after);
    assert!(!s.namespace_attempt_metadata(true).unwrap()[0].members[b_index].captured);
    assert!(s.finish_namespace(&original.job.job_id).is_err());
}

#[test]
fn exact_operation_lookup_does_not_load_another_attempts_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    for name in ["a", "b"] {
        seed(&mut s, name, name, EntryKind::File);
        let req = deleting(&s, name, &format!("delete-{name}"));
        let proof = evidence(&s, name, false);
        s.apply_namespace(&req, &[proof]).unwrap();
    }
    let b = s.namespace_for_operation(&op("delete-b")).unwrap().unwrap();
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute(
        "UPDATE namespace_members SET evidence='not JSON' WHERE entry_id='a'",
        [],
    )
    .unwrap();
    assert_eq!(s.namespace_for_operation(&op("delete-b")).unwrap(), Some(b));
    assert!(s.namespace_for_operation(&op("delete-a")).is_err());
}

#[test]
fn metadata_rejects_missing_progress_reordered_members_and_budget_mismatch() {
    for sql in [
        "DELETE FROM namespace_member_progress",
        "UPDATE namespace_members SET member_index=99",
        "UPDATE namespace_attempts SET evidence_bytes=evidence_bytes+1",
        "UPDATE namespace_members SET change=json_set(change,'$.after.path','wrong'),target_path='wrong'",
        "UPDATE namespace_members SET source_identity=''",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db");
        let mut s = Store::open(&db).unwrap();
        seed(&mut s, "file", "old", EntryKind::File);
        let req = moving(&s, "file", "new", "move");
        let proof = evidence(&s, "file", true);
        s.apply_namespace(&req, &[proof]).unwrap();
        let c = rusqlite::Connection::open(&db).unwrap();
        // Deliberately bypass SQL referential integrity to exercise validation
        // of damaged persisted member indexes, not SQLite's write constraint.
        c.pragma_update(None, "foreign_keys", false).unwrap();
        c.execute(sql, []).unwrap();
        assert!(s.namespace_attempt_metadata(true).is_err(), "{sql}");
    }
}

#[test]
fn pending_job_guard_does_not_decode_completed_publication_history() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    seed(&mut s, "file", "old", EntryKind::File);
    let req = moving(&s, "file", "new", "move");
    let proof = evidence(&s, "file", true);
    s.apply_namespace(&req, &[proof]).unwrap();
    let expected = s.pending_namespace_jobs().unwrap();
    assert_eq!(expected.len(), 1);
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute(
        "UPDATE projection_jobs SET record='not JSON' WHERE completed=1",
        [],
    )
    .unwrap();
    assert_eq!(s.pending_namespace_jobs().unwrap(), expected);
    assert!(s.namespace_jobs().is_err());
}

#[test]
fn schema_six_migration_creates_exact_normalized_namespace_layout() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    drop(Store::open(&db).unwrap());
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch("DROP TABLE namespace_member_progress; DROP TABLE namespace_members; DROP TABLE namespace_attempts; PRAGMA user_version=6;").unwrap();
    drop(c);
    drop(Store::open(&db).unwrap());
    let c = rusqlite::Connection::open(&db).unwrap();
    assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('namespace_attempts','namespace_members','namespace_member_progress','namespace_member_targets')",[],|r|r.get::<_,i64>(0)).unwrap(),4);
    c.execute_batch("DROP INDEX namespace_member_targets; CREATE INDEX namespace_member_targets ON namespace_members(job_id);").unwrap();
    assert!(Store::open(&db).is_err());
}

#[test]
fn namespace_binding_cas_survives_move_and_delete_removes_only_active_binding() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let mut s = Store::open(&db).unwrap();
    seed(&mut s, "file", "old", EntryKind::File);
    let req = moving(&s, "file", "new", "first-move");
    let proof = evidence(&s, "file", true);
    s.apply_namespace(&req, &[proof]).unwrap();
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    let a = complete_members(&mut s, a);
    s.finish_namespace(&a.job.job_id).unwrap();
    let bound = s.physical_binding(&id("file")).unwrap().unwrap();
    let req = deleting(&s, "file", "delete-bound");
    let proof = evidence(&s, "file", false);
    assert_eq!(proof.physical_binding, Some(bound.clone()));
    s.apply_namespace(&req, &[proof]).unwrap();
    let a = s
        .namespace_for_operation(&req.operation_id)
        .unwrap()
        .unwrap();
    let a = complete_members(&mut s, a);
    let c = rusqlite::Connection::open(&db).unwrap();
    let mut replaced = bound.clone();
    replaced.physical.inode = "replacement".into();
    c.execute(
        "UPDATE physical_bindings SET inode=?1,record=?2 WHERE entry_id='file'",
        rusqlite::params![
            replaced.physical.inode,
            serde_json::to_string(&replaced).unwrap()
        ],
    )
    .unwrap();
    assert!(s.finish_namespace(&a.job.job_id).is_err());
    assert_eq!(
        s.projection_baseline(&id("file"))
            .unwrap()
            .unwrap()
            .state
            .path,
        path("new")
    );
    assert!(!s.namespace_attempt(&a.job.job_id).unwrap().completed);
    c.execute(
        "UPDATE physical_bindings SET inode=?1,record=?2 WHERE entry_id='file'",
        rusqlite::params![bound.physical.inode, serde_json::to_string(&bound).unwrap()],
    )
    .unwrap();
    let completed = s.finish_namespace(&a.job.job_id).unwrap();
    assert!(s.physical_binding(&id("file")).unwrap().is_none());
    assert_eq!(completed.members[0].evidence.physical_binding, Some(bound));
}
