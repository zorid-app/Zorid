use serde_json::{json, Value};
use zorid_bases::tasks::{query_tasks, TaskFilter, TaskQueryOptions};
use zorid_bases::types::{compile_types, task_capture_defaults, TypeSource};
use zorid_bases::{compile_base, query_generation, PropertyValue, QueryOptions, RecordWitness};
use zorid_core::{EntryId, EntryKind, EntryState, OperationId, Revision, VaultPath};
use zorid_document::MetadataRequest;
use zorid_index::{
    Generation, GenerationSource, IndexSnapshotId, SemanticVersions, SourceSnapshotId,
    SourceWatermark,
};
fn id(s: &str) -> EntryId {
    EntryId::new(s).unwrap()
}
fn definition() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/tasks/task-type.json")).unwrap()
}
fn source(value: Value) -> TypeSource {
    TypeSource {
        witness: RecordWitness {
            entry_id: id("type-file"),
            revision: Revision::new("r1").unwrap(),
        },
        path: "Types/Task.yaml".into(),
        configuration: serde_json::from_value(value).unwrap(),
    }
}
fn generation(notes: &[(&str, &str, &str)]) -> Generation {
    let local = OperationId::new("store").unwrap();
    let source = SourceSnapshotId::new(local.clone(), SourceWatermark::new("1").unwrap());
    let snapshot = IndexSnapshotId::new(
        local,
        OperationId::new("epoch").unwrap(),
        1,
        SemanticVersions::new(
            1,
            zorid_index::document_extraction_version(),
            zorid_index::RESOLVER_VERSION,
            zorid_index::LITERAL_QUERY_VERSION,
        )
        .unwrap(),
    )
    .unwrap();
    let all = std::iter::once(("type-file", "Types/Task.yaml", "host parsed config"))
        .chain(notes.iter().copied())
        .collect::<Vec<_>>();
    let entries = all
        .iter()
        .map(|(name, path, _)| EntryState {
            id: id(name),
            path: VaultPath::new(*path).unwrap(),
            kind: EntryKind::File,
            revision: Revision::new("r1").unwrap(),
            deleted: false,
        })
        .collect();
    let sources = all
        .iter()
        .map(|(name, path, text)| GenerationSource::Text {
            request: MetadataRequest {
                entry_id: id(name),
                content_revision: Revision::new("r1").unwrap(),
                source: (*text).into(),
            },
            markdown: path.ends_with(".md"),
        })
        .collect();
    Generation::from_sources(source, snapshot, entries, sources).unwrap()
}
#[test]
fn defaults_use_exact_mapped_keys_and_retain_unknown_ast() {
    let raw = source(definition());
    let registry = compile_types(vec![raw.clone()]).unwrap();
    assert!(registry.diagnostics().is_empty());
    assert_eq!(registry.sources()[0].configuration, raw.configuration);
    let defaults = task_capture_defaults(&registry, "type-task").unwrap();
    assert!(defaults.contains(&("state".into(), PropertyValue::String("todo".into()))));
    assert!(defaults.contains(&("detail".into(), PropertyValue::Null)));
    assert!(!defaults.iter().any(|(key, _)| key == "status"));
}
#[test]
fn task_notes_are_capabilities_not_checkboxes_and_unknown_status_is_retained() {
    let generation = generation(&[
        ("task", "Renamed.md", "---\ntype: type-task\n---\nBody\n"),
        (
            "unknown",
            "Unknown.md",
            "---\ntype: type-task\nstate: future-status\n---\n",
        ),
        ("checkbox", "Checkbox.md", "- [ ] Not a task note\n"),
        (
            "done",
            "Done.md",
            "---\ntype: type-task\nstate: done\n---\n",
        ),
    ]);
    let registry = compile_types(vec![source(definition())]).unwrap();
    let result = query_tasks(&generation, &registry, &TaskQueryOptions::default()).unwrap();
    assert_eq!(result.rows.len(), 2);
    let task = result
        .rows
        .iter()
        .find(|r| r.witness.entry_id == id("task"))
        .unwrap();
    assert_eq!(task.path, "Renamed.md");
    assert_eq!(task.status_id.as_deref(), Some("todo"));
    assert!(task.status_defaulted);
    assert_eq!(
        result
            .rows
            .iter()
            .find(|r| r.witness.entry_id == id("unknown"))
            .unwrap()
            .status_id
            .as_deref(),
        Some("future-status")
    );
    assert!(result
        .diagnostics
        .iter()
        .any(|d| d.code == "unknown_task_status"));
    assert!(result.coverage_complete);
    assert_eq!(
        query_tasks(
            &generation,
            &registry,
            &TaskQueryOptions {
                show_done: true,
                ..Default::default()
            }
        )
        .unwrap()
        .rows
        .len(),
        3
    );
}
#[test]
fn today_captures_timezone_and_dates_are_not_instants_or_reservations() {
    let generation = generation(&[
        (
            "planned",
            "Planned.md",
            "---\ntype: type-task\nplan: '2026-10-17'\n---\n",
        ),
        (
            "late",
            "Late.md",
            "---\ntype: type-task\ndue: '2026-10-16'\n---\n",
        ),
        (
            "tomorrow",
            "Tomorrow.md",
            "---\ntype: type-task\nplan: '2026-10-18'\n---\n",
        ),
        (
            "bad",
            "Bad.md",
            "---\ntype: type-task\nplan: '2026-02-30'\n---\n",
        ),
    ]);
    let registry = compile_types(vec![source(definition())]).unwrap();
    let clock_ms = chrono::DateTime::parse_from_rfc3339("2026-10-18T01:00:00Z")
        .unwrap()
        .timestamp_millis();
    let opts = TaskQueryOptions {
        filter: TaskFilter::Today,
        clock_ms,
        timezone: "America/Toronto".into(),
        ..Default::default()
    };
    let result = query_tasks(&generation, &registry, &opts).unwrap();
    assert_eq!(
        result
            .rows
            .iter()
            .map(|r| r.witness.entry_id.as_str())
            .collect::<Vec<_>>(),
        vec!["late", "planned"]
    );
    assert!(result
        .diagnostics
        .iter()
        .any(|d| d.code == "invalid_task_date"));
    let unscheduled = query_tasks(
        &generation,
        &registry,
        &TaskQueryOptions {
            filter: TaskFilter::Unscheduled,
            ..opts
        },
    )
    .unwrap();
    assert_eq!(
        unscheduled
            .rows
            .iter()
            .map(|r| r.witness.entry_id.as_str())
            .collect::<Vec<_>>(),
        vec!["late"]
    );
}
#[test]
fn invalid_types_and_duplicate_identity_never_win_by_input_order() {
    for mutate in ["version", "mapping", "date-default", "option"] {
        let mut value = definition();
        match mutate {
            "version" => value["version"] = json!(2),
            "mapping" => value["capabilities"]["task"]["deadline"] = json!("missing"),
            "date-default" => value["properties"][1]["default"] = json!("2026-02-30"),
            _ => value["properties"][0]["options"][1]["id"] = json!("todo"),
        }
        let registry = compile_types(vec![source(value)]).unwrap();
        assert!(registry.get("type-task").is_none());
        assert_eq!(registry.diagnostics().len(), 1);
        assert!(task_capture_defaults(&registry, "type-task").is_err());
    }
    let first = source(definition());
    let mut second = first.clone();
    second.witness.entry_id = id("other-file");
    second.path = "Types/Other.yaml".into();
    for sources in [vec![first.clone(), second.clone()], vec![second, first]] {
        let registry = compile_types(sources).unwrap();
        assert!(registry.get("type-task").is_none());
        assert_eq!(registry.diagnostics().len(), 2);
    }
}
#[test]
fn stale_type_revision_fails_and_query_budgets_are_explicit() {
    let generation = generation(&[
        ("one", "One.md", "---\ntype: type-task\n---\n"),
        ("two", "Two.md", "---\ntype: type-task\n---\n"),
    ]);
    let mut stale = source(definition());
    stale.witness.revision = Revision::new("r2").unwrap();
    assert_eq!(
        query_tasks(
            &generation,
            &compile_types(vec![stale]).unwrap(),
            &TaskQueryOptions::default()
        )
        .unwrap_err()
        .code,
        "stale-source"
    );
    let registry = compile_types(vec![source(definition())]).unwrap();
    let result = query_tasks(
        &generation,
        &registry,
        &TaskQueryOptions {
            max_rows: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(result.truncated);
    assert_eq!(result.matched, 2);
    assert_eq!(result.rows.len(), 1);
    assert!(query_tasks(
        &generation,
        &registry,
        &TaskQueryOptions {
            max_rows: 0,
            ..Default::default()
        }
    )
    .is_err());
    assert!(query_tasks(
        &generation,
        &registry,
        &TaskQueryOptions {
            timezone: "local".into(),
            ..Default::default()
        }
    )
    .is_err());
}
#[test]
fn shared_base_evaluator_selects_same_saved_typed_notes() {
    let generation = generation(&[
        (
            "task",
            "Task.md",
            "---\ntype: type-task\nstate: active\n---\n",
        ),
        ("other", "Other.md", "---\ntype: other\n---\n"),
    ]);
    let config: PropertyValue = serde_json::from_value(json!({"filters":{"and":["file.ext == \"md\"","note.type == \"type-task\""]},"views":[{"type":"table","name":"Tasks","order":["file.name","state"]}]})).unwrap();
    let base = query_generation(
        &compile_base(config).unwrap(),
        &generation,
        &[],
        &QueryOptions::default(),
    )
    .unwrap();
    assert_eq!(
        base.rows
            .iter()
            .map(|r| r.entry_id.as_str())
            .collect::<Vec<_>>(),
        vec!["task"]
    );
    let tasks = query_tasks(
        &generation,
        &compile_types(vec![source(definition())]).unwrap(),
        &TaskQueryOptions::default(),
    )
    .unwrap();
    assert_eq!(base.rows[0].entry_id, tasks.rows[0].witness.entry_id);
}
#[test]
fn malformed_metadata_reports_incomplete_and_is_never_rewritten() {
    let generation = generation(&[("bad", "Bad.md", "---\ntype: [unterminated\n---\nbody\n")]);
    let result = query_tasks(
        &generation,
        &compile_types(vec![source(definition())]).unwrap(),
        &TaskQueryOptions::default(),
    )
    .unwrap();
    assert!(!result.coverage_complete);
    assert!(result.rows.is_empty());
}

#[test]
fn arbitrary_task_type_name_and_exact_mapping_work_without_reserved_type() {
    let mut definition = definition();
    definition["id"] = json!("assignment");
    definition["label"] = json!("Assignment");
    let generation = generation(&[
        (
            "mapped",
            "Assignment.md",
            "---\ntype: assignment\nstate: active\nStatus: done\nplan: '2024-02-29'\n---\n",
        ),
        (
            "wrong-case",
            "Wrong.md",
            "---\nType: assignment\nstate: active\n---\n",
        ),
    ]);
    let registry = compile_types(vec![source(definition)]).unwrap();
    let result = query_tasks(&generation, &registry, &TaskQueryOptions::default()).unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].status_id.as_deref(), Some("active"));
    assert_eq!(result.rows[0].planned_day.as_deref(), Some("2024-02-29"));
}
#[test]
fn invalid_same_id_file_cannot_leave_a_valid_definition_as_accidental_winner() {
    let valid = source(definition());
    let mut invalid = valid.clone();
    invalid.witness.entry_id = id("invalid-file");
    invalid.path = "Types/Future.yaml".into();
    let mut future = definition();
    future["version"] = json!(99);
    invalid.configuration = serde_json::from_value(future).unwrap();
    let registry = compile_types(vec![valid, invalid]).unwrap();
    assert!(registry.get("type-task").is_none());
    assert_eq!(registry.diagnostics().len(), 2);
}

#[test]
fn host_ast_structural_budget_is_checked_before_recursive_interpretation() {
    let mut raw = source(definition());
    raw.configuration = PropertyValue::Array(vec![PropertyValue::Null; 8193]);
    assert_eq!(compile_types(vec![raw]).unwrap_err().code, "budget");
}
