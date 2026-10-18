use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_native::{NativeVault, TaskQueryOptions};
fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn create(v: &mut NativeVault, name: &str, path: &str, text: &str) {
    v.apply(&MutationRequest {
        operation_id: OperationId::new(format!("create-{name}")).unwrap(),
        mutation: Mutation::Create {
            id: id(name),
            path: VaultPath::new(path).unwrap(),
            kind: EntryKind::File,
            content: Some(text.as_bytes().to_vec()),
        },
    })
    .unwrap();
}
fn write(v: &mut NativeVault, name: &str, text: &str) {
    let expected = v.read(&id(name)).unwrap().unwrap().state.revision;
    v.apply(&MutationRequest {
        operation_id: OperationId::new(format!("write-{name}")).unwrap(),
        mutation: Mutation::Write {
            id: id(name),
            expected,
            content: text.as_bytes().to_vec(),
        },
    })
    .unwrap();
}
fn build(v: &mut NativeVault) {
    let stage = v.begin_document_index().unwrap();
    for _ in 0..20 {
        if v.pump_document_index(&stage).unwrap().ready {
            v.publish_document_index(&stage).unwrap();
            return;
        }
    }
    panic!("fixture exceeded pumps");
}
fn setup() -> (tempfile::TempDir, NativeVault) {
    let dir = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(dir.path()).unwrap();
    create(
        &mut v,
        "type-file",
        "Task.yaml",
        include_str!("../../../tests/fixtures/tasks/task-type.json"),
    );
    create(
        &mut v,
        "note",
        "Task.md",
        "---\ntype: type-task\nstate: active\n---\nBody\n",
    );
    v.initialize_document_index().unwrap();
    build(&mut v);
    (dir, v)
}
#[test]
fn pinned_actual_type_bytes_and_notes_survive_live_changes_without_ast_substitution() {
    let (_dir, mut v) = setup();
    let old = v.open_document_snapshot().unwrap();
    let first = v
        .query_task_documents(&old, &[id("type-file")], &TaskQueryOptions::default())
        .unwrap();
    assert_eq!(
        first.value.result.rows[0].status_id.as_deref(),
        Some("active")
    );
    assert_eq!(first.value.types[0].status.key, "state");
    let actual = v.read(&id("type-file")).unwrap().unwrap().state;
    assert_eq!(first.value.definitions[0], actual);
    let changed = include_str!("../../../tests/fixtures/tasks/task-type.json")
        .replace("\"Task\"", "\"Assignment\"");
    write(&mut v, "type-file", &changed);
    write(
        &mut v,
        "note",
        "---\ntype: type-task\nstate: done\n---\nNew body\n",
    );
    build(&mut v);
    let retained = v
        .query_task_documents(&old, &[id("type-file")], &TaskQueryOptions::default())
        .unwrap();
    assert_eq!(retained.snapshot, first.snapshot);
    assert_eq!(retained.value.definitions[0], first.value.definitions[0]);
    assert_eq!(retained.value.types[0].label, "Task");
    assert_eq!(
        retained.value.result.rows[0].status_id.as_deref(),
        Some("active")
    );
    let current = v.open_document_snapshot().unwrap();
    let new = v
        .query_task_documents(&current, &[id("type-file")], &TaskQueryOptions::default())
        .unwrap();
    assert!(new.value.result.rows.is_empty());
    assert_eq!(new.value.types[0].label, "Assignment");
}
#[test]
fn malformed_yaml_is_diagnostic_but_missing_selector_and_expired_pin_fail_closed() {
    let (_dir, mut v) = setup();
    create(
        &mut v,
        "invalid",
        "Invalid.yaml",
        "version: [unterminated\n",
    );
    build(&mut v);
    let pin = v.open_document_snapshot().unwrap();
    let result = v
        .query_task_documents(&pin, &[id("invalid")], &TaskQueryOptions::default())
        .unwrap();
    assert!(result.value.types.is_empty());
    assert_eq!(
        result.value.result.type_diagnostics[0].code,
        "invalid_type_yaml"
    );
    assert!(!result.value.result.coverage_complete);
    assert!(result.value.result.rows.is_empty());
    assert!(v
        .query_task_documents(&pin, &[id("missing")], &TaskQueryOptions::default())
        .is_err());
    assert!(v
        .query_task_documents(
            &pin,
            &[id("type-file"), id("type-file")],
            &TaskQueryOptions::default()
        )
        .is_err());
    v.rebuild_document_index().unwrap();
    let error = v
        .query_task_documents(&pin, &[id("type-file")], &TaskQueryOptions::default())
        .err()
        .unwrap();
    assert_eq!(error.code(), "snapshot_expired");
}
#[test]
fn foreign_store_pin_cannot_authorize_type_source_reads() {
    let (_dir, v) = setup();
    let pin = v.open_document_snapshot().unwrap();
    let other = tempfile::tempdir().unwrap();
    let foreign = NativeVault::open(other.path()).unwrap();
    assert!(foreign
        .query_task_documents(&pin, &[id("type-file")], &TaskQueryOptions::default())
        .is_err());
}

#[test]
fn type_source_limits_are_enforced_without_mutating_selected_files() {
    let (_dir, mut vault) = setup();
    let large = " ".repeat(256 * 1024 + 1);
    create(&mut vault, "large", "Large.yaml", &large);
    build(&mut vault);
    let pin = vault.open_document_snapshot().unwrap();
    let error = vault
        .query_task_documents(&pin, &[id("large")], &TaskQueryOptions::default())
        .err()
        .unwrap();
    assert_eq!(error.code(), "budget");
    assert_eq!(
        vault.read(&id("large")).unwrap().unwrap().content.unwrap(),
        large.as_bytes()
    );
    let error = vault
        .query_task_documents(
            &pin,
            &vec![id("type-file"); 129],
            &TaskQueryOptions::default(),
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), "budget");
}
