use serde_json::{json, Value};
use zorid_bases::calendar::*;
use zorid_bases::types::{compile_types, TypeSource};
use zorid_bases::{compile_base, PropertyValue, QueryOptions, RecordWitness};
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

fn context() -> CalendarContext {
    CalendarContext {
        clock_ms: chrono::DateTime::parse_from_rfc3339("2026-10-18T01:00:00Z")
            .unwrap()
            .timestamp_millis(),
        timezone: "America/Toronto".into(),
    }
}
fn program(value: Value) -> zorid_bases::BaseProgram {
    compile_base(serde_json::from_value(value).unwrap()).unwrap()
}
fn select(g: &Generation, config: Value, opts: &QueryOptions) -> CalendarTaskSelection {
    let registry = compile_types(vec![source(definition())]).unwrap();
    let p = program(config);
    select_calendar_tasks(
        g,
        &registry,
        Some(CalendarBaseSelection {
            program: &p,
            presentation: &[],
            options: opts,
            view_name: Some("Schedule"),
        }),
        &context(),
    )
    .unwrap()
}
#[test]
fn saved_named_selection_precedes_cap_and_preserves_completed_membership() {
    let mut notes = (0..1001)
        .map(|n| {
            (
                format!("unrelated-{n}"),
                format!("A{n:04}.md"),
                "---\ntype: type-task\n---\n".to_owned(),
            )
        })
        .collect::<Vec<_>>();
    notes.push((
        "selected".into(),
        "ZSelected.md".into(),
        "---\ntype: type-task\nstate: done\n---\n".into(),
    ));
    let refs = notes
        .iter()
        .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
        .collect::<Vec<_>>();
    let g = generation(&refs);
    let result = select(
        &g,
        json!({"filters":"file.ext == \"md\"", "views":[
            {"type":"table","name":"Other"},
            {"type":"calendar","name":"Schedule","filters":"file.name == \"ZSelected\"","limit":1}
        ]}),
        &QueryOptions::default(),
    );
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].witness.entry_id, id("selected"));
    assert_eq!(result.selected_files, 1);
    assert_eq!(result.selected_tasks, 1);
    assert_eq!(result.picker_rows(false).count(), 0);
    assert_eq!(result.picker_rows(true).count(), 1);
    let registry = compile_types(vec![source(definition())]).unwrap();
    assert_eq!(
        select_calendar_tasks(&g, &registry, None, &context())
            .unwrap_err()
            .code,
        "budget"
    );
    let limited = select(
        &g,
        json!({"filters":"file.ext == \"md\"", "views":[{"type":"calendar","name":"Schedule","limit":1000}]}),
        &QueryOptions::default(),
    );
    assert_eq!(limited.selected_tasks, 1000);
}
#[test]
fn exact_root_view_group_search_order_limit_this_and_ignores() {
    let g = generation(&[
        ("context", "Context.md", "---\nteam: blue\n---\n"),
        (
            "a",
            "A.md",
            "---\ntype: type-task\nteam: blue\nstate: active\ndetail: needle\n---\n",
        ),
        (
            "b",
            "B.md",
            "---\ntype: type-task\nteam: blue\nstate: active\ndetail: needle\n---\n",
        ),
        (
            "non",
            "C.md",
            "---\nteam: blue\nstate: active\ndetail: needle\n---\n",
        ),
        (
            "ignored",
            "Ignored.md",
            "---\ntype: type-task\nteam: blue\nstate: active\ndetail: needle\n---\n",
        ),
        (
            "group-excluded",
            "Excluded.md",
            "---\ntype: type-task\nteam: blue\nstate: done\ndetail: needle\n---\n",
        ),
        (
            "root-excluded",
            "Red.md",
            "---\ntype: type-task\nteam: red\nstate: active\ndetail: needle\n---\n",
        ),
        (
            "view-excluded",
            "View.md",
            "---\ntype: type-task\nteam: blue\nstate: active\ndetail: needle\n---\n",
        ),
        (
            "search-excluded",
            "Search.md",
            "---\ntype: type-task\nteam: blue\nstate: active\ndetail: other\n---\n",
        ),
    ]);
    let opts = QueryOptions {
        current_entry_id: Some(id("context")),
        ignore_paths: vec!["Ignored.md".into()],
        search_terms: vec!["needle".into(), "active".into()],
        ..Default::default()
    };
    let result = select(
        &g,
        json!({"filters":"team == this.team", "views":[{"type":"calendar","name":"Schedule", "filters":"file.name != \"View\"", "order":["file.name","detail","state"],"groupBy":{"property":"state","direction":"ASC"},"groupOrder":["active"],"sort":[{"property":"file.name","direction":"DESC"}],"limit":2}]}),
        &opts,
    );
    assert_eq!(
        result
            .base_result
            .as_ref()
            .unwrap()
            .rows
            .iter()
            .map(|r| r.entry_id.as_str())
            .collect::<Vec<_>>(),
        vec!["non", "b"]
    );
    assert_eq!(
        result
            .rows
            .iter()
            .map(|r| r.witness.entry_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b"]
    );
    assert_eq!(
        (
            result.selected_files,
            result.selected_tasks,
            result.excluded_non_tasks
        ),
        (2, 1, 1)
    );
    assert!(result.coverage_complete);
}
#[test]
fn saved_context_overrides_utc_defaults_and_matches_task_today() {
    let g = generation(&[
        (
            "today",
            "Today.md",
            "---\ntype: type-task\nplan: '2026-10-17'\n---\n",
        ),
        (
            "tomorrow",
            "Tomorrow.md",
            "---\ntype: type-task\nplan: '2026-10-18'\n---\n",
        ),
    ]);
    let cfg = json!({"filters":"file.ext == \"md\" && date(plan) == today()", "views":[{"type":"calendar","name":"Schedule"}]});
    let result = select(&g, cfg.clone(), &QueryOptions::default());
    assert_eq!(
        result
            .rows
            .iter()
            .map(|r| r.witness.entry_id.as_str())
            .collect::<Vec<_>>(),
        vec!["today"]
    );
    let registry = compile_types(vec![source(definition())]).unwrap();
    let tasks = zorid_bases::tasks::query_tasks(
        &g,
        &registry,
        &zorid_bases::tasks::TaskQueryOptions {
            filter: zorid_bases::tasks::TaskFilter::Today,
            clock_ms: context().clock_ms,
            timezone: context().timezone,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(tasks.rows[0].witness, result.rows[0].witness);
    let p = program(cfg);
    let utc = CalendarContext {
        timezone: "UTC".into(),
        ..context()
    };
    let opts = QueryOptions::default();
    let result = select_calendar_tasks(
        &g,
        &registry,
        Some(CalendarBaseSelection {
            program: &p,
            presentation: &[],
            options: &opts,
            view_name: None,
        }),
        &utc,
    )
    .unwrap();
    assert_eq!(result.rows[0].witness.entry_id, id("tomorrow"));
    assert!(select_calendar_tasks(
        &g,
        &registry,
        None,
        &CalendarContext {
            timezone: "local".into(),
            ..context()
        }
    )
    .is_err());
}
#[test]
fn links_are_same_pin_identity_and_independent_of_selected_prefix() {
    let g = generation(&[
        (
            "renamed",
            "New.md",
            "---\ntype: type-task\nstate: done\n---\n",
        ),
        ("replacement", "Old.md", "body"),
        ("unknown", "Unknown.md", "---\ntype: unknown\n---\n"),
        ("invalid", "Invalid.md", "---\ntype: [1]\n---\n"),
        ("bad", "Bad.md", "---\ntype: [unterminated\n---\n"),
    ]);
    let registry = compile_types(vec![source(definition())]).unwrap();
    let result = resolve_calendar_links(
        &g,
        &registry,
        &[
            id("renamed"),
            id("gone"),
            id("replacement"),
            id("unknown"),
            id("invalid"),
            id("bad"),
        ],
    )
    .unwrap();
    assert!(matches!(&result.links[0],CalendarLink::Task {row,..} if row.path=="New.md"));
    assert!(matches!(
        &result.links[1],
        CalendarLink::Missing { path: None, .. }
    ));
    assert!(matches!(&result.links[2], CalendarLink::NotTask { .. }));
    assert!(result.links[3..]
        .iter()
        .all(|l| matches!(l, CalendarLink::Unavailable { .. })));
    assert!(result
        .diagnostics
        .iter()
        .any(|d| d.code == "unknown_note_type"));
    assert!(result
        .diagnostics
        .iter()
        .any(|d| d.code == "invalid_note_type"));
    assert!(result
        .metadata_issues
        .iter()
        .any(|i| i.witness.entry_id == id("bad") && i.properties_unavailable));
    assert!(resolve_calendar_links(&g, &registry, &vec![id("gone"); 65]).is_err());
}
#[test]
fn invalid_missing_type_knowledge_never_asserts_not_task() {
    let g = generation(&[
        ("task", "Task.md", "---\ntype: type-task\n---\n"),
        ("plain", "Plain.md", "body"),
    ]);
    let empty = compile_types(vec![]).unwrap();
    let result = resolve_calendar_links(&g, &empty, &[id("task")]).unwrap();
    assert!(matches!(result.links[0], CalendarLink::Unavailable { .. }));
    let mut value = definition();
    value["version"] = json!(99);
    let invalid = compile_types(vec![source(value)]).unwrap();
    let result = resolve_calendar_links(&g, &invalid, &[id("task"), id("plain")]).unwrap();
    assert!(result
        .links
        .iter()
        .all(|l| matches!(l, CalendarLink::Unavailable { .. })));
    assert!(!result.type_diagnostics.is_empty());
    let selected = select_calendar_tasks(&g, &invalid, None, &context()).unwrap();
    assert!(!selected.coverage_complete);
    assert_eq!(selected.selected_tasks, 0);
    let mut stale = source(definition());
    stale.witness.revision = Revision::new("r2").unwrap();
    let registry = compile_types(vec![stale]).unwrap();
    assert_eq!(
        select_calendar_tasks(&g, &registry, None, &context())
            .unwrap_err()
            .code,
        "stale-source"
    );
}
#[test]
fn missing_or_ambiguous_saved_view_and_query_budget_are_errors() {
    let g = generation(&[("task", "Task.md", "---\ntype: type-task\n---\n")]);
    let registry = compile_types(vec![source(definition())]).unwrap();
    let opts = QueryOptions::default();
    for views in [
        json!([{"type":"calendar","name":"Other"}]),
        json!([{"type":"calendar","name":"Schedule"},{"type":"calendar","name":"Schedule"}]),
    ] {
        let p = program(json!({"views":views}));
        assert_eq!(
            select_calendar_tasks(
                &g,
                &registry,
                Some(CalendarBaseSelection {
                    program: &p,
                    presentation: &[],
                    options: &opts,
                    view_name: Some("Schedule")
                }),
                &context()
            )
            .unwrap_err()
            .code,
            "configuration"
        );
    }
    let p = program(json!({"views":[{"type":"calendar","name":"Schedule"}]}));
    let opts = QueryOptions {
        max_rows: 1,
        ..Default::default()
    };
    assert_eq!(
        select_calendar_tasks(
            &g,
            &registry,
            Some(CalendarBaseSelection {
                program: &p,
                presentation: &[],
                options: &opts,
                view_name: None
            }),
            &context()
        )
        .unwrap_err()
        .code,
        "budget"
    );
}
