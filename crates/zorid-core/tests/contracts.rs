use serde_json::{json, Value};
use zorid_core::{
    check_idempotency, validate_target, CommitResult, ContractError, EntryChange, EntryId,
    EntryKind, EntryState, IdempotencyCheck, Mutation, MutationRequest, OperationId,
    RecordedOperation, Revision, VaultPath,
};

fn state(id: &str, path: &str, revision: &str, kind: EntryKind) -> EntryState {
    EntryState {
        id: EntryId::new(id).unwrap(),
        path: VaultPath::new(path).unwrap(),
        kind,
        revision: Revision::new(revision).unwrap(),
        deleted: false,
    }
}

fn write() -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new("op-1").unwrap(),
        mutation: Mutation::Write {
            id: EntryId::new("file-1").unwrap(),
            expected: Revision::new("rev-1").unwrap(),
            content: vec![0, 255, 128, 13, 10],
        },
    }
}

fn record() -> RecordedOperation {
    RecordedOperation {
        request: write(),
        result: CommitResult {
            operation_id: OperationId::new("op-1").unwrap(),
            sequence: 42,
            changes: vec![EntryChange {
                before: Some(state(
                    "file-1",
                    "assets/custom.unknown",
                    "rev-1",
                    EntryKind::File,
                )),
                after: state("file-1", "assets/custom.unknown", "rev-2", EntryKind::File),
            }],
        },
    }
}

#[test]
fn preserve_unicode_case_and_hidden_user_content() {
    for path in [
        "日記/🦀.md",
        ".obsidian/plugins/example/data.json",
        ".gitignore",
        ".hidden/.file",
        "folder/.zorid/user-file",
        ".zorid-export/data",
        "é.md",
        "e\u{301}.md",
    ] {
        let value = VaultPath::new(path).unwrap();
        assert_eq!(value.as_str(), path);
        let serialized = serde_json::to_string(&value).unwrap();
        assert_eq!(
            serde_json::from_str::<VaultPath>(&serialized).unwrap(),
            value
        );
    }
    assert_ne!(
        VaultPath::new("É.md").unwrap(),
        VaultPath::new("é.md").unwrap()
    );
    assert_ne!(
        VaultPath::new("é.md").unwrap(),
        VaultPath::new("e\u{301}.md").unwrap()
    );
}

#[test]
fn untrusted_paths_cannot_bypass_validation_through_json() {
    for path in [
        "",
        "/absolute",
        "//server/share",
        "a\\b",
        "C:/vault",
        "c:relative",
        ".",
        "..",
        "a/../b",
        "a/./b",
        "a//b",
        "a/",
        ".zorid",
        ".ZORID/core.db",
        "note\0.md",
        "note\n.md",
        "note\u{7f}.md",
    ] {
        let encoded = serde_json::to_string(path).unwrap();
        assert!(
            VaultPath::new(path).is_err(),
            "constructor accepted {path:?}"
        );
        assert!(
            serde_json::from_str::<VaultPath>(&encoded).is_err(),
            "JSON accepted {path:?}"
        );
    }
}

#[test]
fn folder_rebase_observes_segment_boundaries() {
    let from = VaultPath::new("notes").unwrap();
    let to = VaultPath::new("archive/ノート").unwrap();
    let nested = VaultPath::new("notes/子/a.md").unwrap();
    assert_eq!(nested.parent().unwrap().as_str(), "notes/子");
    assert_eq!(nested.file_name(), "a.md");
    assert_eq!(
        nested.rebase(&from, &to).unwrap().as_str(),
        "archive/ノート/子/a.md"
    );
    assert_eq!(from.parent(), None);
    assert_eq!(from.rebase(&from, &to), None);
    assert_eq!(
        VaultPath::new("notes-copy/a.md")
            .unwrap()
            .rebase(&from, &to),
        None
    );
}

#[test]
fn opaque_tokens_validate_at_deserialization_boundary() {
    let valid = "cc675e16-a0ec-4673-8ecb-1e362c797482";
    assert_eq!(EntryId::new(valid).unwrap().as_str(), valid);
    for value in ["", "../file", "id with space", "\n", "🦀"] {
        let encoded = serde_json::to_string(value).unwrap();
        assert!(serde_json::from_str::<EntryId>(&encoded).is_err());
        assert!(serde_json::from_str::<Revision>(&encoded).is_err());
        assert!(serde_json::from_str::<OperationId>(&encoded).is_err());
    }
    assert!(EntryId::new("x".repeat(129)).is_err());
    assert!(EntryId::new("x".repeat(128)).is_ok());
}

#[test]
fn unknown_file_content_is_round_tripped_as_exact_bytes() {
    let request = MutationRequest {
        operation_id: OperationId::new("create-unknown").unwrap(),
        mutation: Mutation::Create {
            id: EntryId::new("file-unknown").unwrap(),
            path: VaultPath::new(".custom/instrument.unrecognized").unwrap(),
            kind: EntryKind::File,
            content: Some((0..=255).collect()),
        },
    };
    let encoded = serde_json::to_vec(&request).unwrap();
    assert_eq!(
        serde_json::from_slice::<MutationRequest>(&encoded).unwrap(),
        request
    );
}

#[test]
fn request_boundary_rejects_consequential_unknown_fields_and_commands() {
    let valid = serde_json::to_value(write()).unwrap();
    let mut changed = valid.clone();
    changed["mutation"]["force"] = json!(true);
    assert!(serde_json::from_value::<MutationRequest>(changed).is_err());
    let mut changed = valid.clone();
    changed["ignore_revision"] = json!(true);
    assert!(serde_json::from_value::<MutationRequest>(changed).is_err());
    let mut changed = valid.clone();
    changed["mutation"]["type"] = json!("purge");
    assert!(serde_json::from_value::<MutationRequest>(changed).is_err());
    let mut changed = valid;
    changed["mutation"]
        .as_object_mut()
        .unwrap()
        .remove("expected");
    assert!(serde_json::from_value::<MutationRequest>(changed).is_err());
}

#[test]
fn request_boundary_rejects_folder_bytes_and_missing_file_bytes() {
    let create = json!({"operation_id":"new", "mutation":{
        "type":"create", "id":"entry", "path":"a", "kind":"folder", "content":[0]
    }});
    assert!(serde_json::from_value::<MutationRequest>(create.clone()).is_err());
    let mut file = create.clone();
    file["mutation"]["kind"] = json!("file");
    file["mutation"]["content"] = Value::Null;
    assert!(serde_json::from_value::<MutationRequest>(file.clone()).is_err());
    file["mutation"]["content"] = json!([]);
    assert!(serde_json::from_value::<MutationRequest>(file).is_ok());
    let mut folder = create;
    folder["mutation"]["content"] = Value::Null;
    assert!(serde_json::from_value::<MutationRequest>(folder).is_ok());
}

#[test]
fn stale_revision_is_rejected_against_current_transaction_snapshot() {
    let stale = state("file-1", "a.md", "rev-1", EntryKind::File);
    let fresh = state("file-1", "renamed.md", "rev-2", EntryKind::File);
    // A cached snapshot would incorrectly pass, so adapters must refresh first.
    assert!(validate_target(Some(&stale), &stale.id, &stale.revision).is_ok());
    assert_eq!(
        validate_target(Some(&fresh), &stale.id, &stale.revision),
        Err(ContractError::RevisionConflict {
            id: stale.id,
            expected: stale.revision,
            actual: fresh.revision.clone(),
        })
    );
}

#[test]
fn recreated_paths_and_tombstones_do_not_retarget_old_handles() {
    let old = state("old-id", "same.md", "rev-1", EntryKind::File);
    let replacement = state("new-id", "same.md", "rev-1", EntryKind::File);
    assert!(matches!(
        validate_target(Some(&replacement), &old.id, &old.revision),
        Err(ContractError::EntryNotFound { .. })
    ));
    let mut deleted = old.clone();
    deleted.deleted = true;
    assert!(matches!(
        validate_target(Some(&deleted), &old.id, &old.revision),
        Err(ContractError::EntryDeleted { .. })
    ));
    assert!(matches!(
        validate_target(None, &old.id, &old.revision),
        Err(ContractError::EntryNotFound { .. })
    ));
}

#[test]
fn folder_subtree_token_rejects_stale_recursive_delete() {
    // The adapter must bump the folder token when a descendant changes. This
    // fixture verifies consuming that aggregate token, not generating it.
    let folder = state("folder", "notes", "subtree-2", EntryKind::Folder);
    let stale_revision = Revision::new("subtree-1").unwrap();
    assert!(matches!(
        validate_target(Some(&folder), &folder.id, &stale_revision),
        Err(ContractError::RevisionConflict { .. })
    ));
}

#[test]
fn idempotent_retry_replays_original_commit_even_after_revision_advances() {
    let recorded = record();
    assert_eq!(
        check_idempotency(&write(), None).unwrap(),
        IdempotencyCheck::New
    );
    assert_eq!(
        check_idempotency(&write(), Some(&recorded)).unwrap(),
        IdempotencyCheck::Replay(&recorded.result)
    );
    let later = state("file-1", "a.md", "rev-3", EntryKind::File);
    assert!(validate_target(
        Some(&later),
        write().mutation.id(),
        write().mutation.expected().unwrap()
    )
    .is_err());
    // The replay path does not re-run this stale precondition or create events.
    assert_eq!(recorded.result.sequence, 42);
}

#[test]
fn idempotency_key_cannot_be_reused_for_different_bytes_or_preconditions() {
    let recorded = record();
    let mut changed = write();
    if let Mutation::Write { content, .. } = &mut changed.mutation {
        content.push(7);
    }
    assert!(matches!(
        check_idempotency(&changed, Some(&recorded)),
        Err(ContractError::IdempotencyConflict { .. })
    ));
    let mut changed = write();
    if let Mutation::Write { expected, .. } = &mut changed.mutation {
        *expected = Revision::new("rev-2").unwrap();
    }
    assert!(matches!(
        check_idempotency(&changed, Some(&recorded)),
        Err(ContractError::IdempotencyConflict { .. })
    ));
}

#[test]
fn corrupt_idempotency_records_fail_closed() {
    let mut recorded = record();
    recorded.result.operation_id = OperationId::new("other-operation").unwrap();
    assert_eq!(
        check_idempotency(&write(), Some(&recorded)),
        Err(ContractError::InvalidOperationRecord)
    );
    let mut recorded = record();
    recorded
        .result
        .changes
        .push(recorded.result.changes[0].clone());
    assert_eq!(
        check_idempotency(&write(), Some(&recorded)),
        Err(ContractError::InvalidOperationRecord)
    );
    let mut recorded = record();
    recorded.result.changes[0].after.revision = Revision::new("rev-1").unwrap();
    assert_eq!(
        check_idempotency(&write(), Some(&recorded)),
        Err(ContractError::InvalidOperationRecord)
    );
}

#[test]
fn commit_sequence_never_rounds_at_javascript_boundary() {
    let mut result = record().result;
    result.sequence = u64::MAX;
    let encoded = serde_json::to_value(&result).unwrap();
    assert_eq!(encoded["sequence"], json!("18446744073709551615"));
    assert_eq!(
        serde_json::from_value::<CommitResult>(encoded.clone()).unwrap(),
        result
    );
    for invalid in [
        json!(42),
        json!("0"),
        json!("01"),
        json!("+1"),
        json!(" 1"),
        json!("18446744073709551616"),
    ] {
        let mut changed = encoded.clone();
        changed["sequence"] = invalid;
        assert!(serde_json::from_value::<CommitResult>(changed).is_err());
    }
}
