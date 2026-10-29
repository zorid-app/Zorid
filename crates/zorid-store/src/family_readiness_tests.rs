//! Readiness admits the current family scope, not every publication in it.
//! Positive publication/source readers and explicit status retain their own
//! strict validation. SQL work counts, rather than timing, enforce that seam.
use crate::*;
use std::{cell::Cell, ffi::CStr};
use zorid_core::{OperationId, VaultPath};
use zorid_sync_protocol::{RealmId, VaultId};

fn scope() -> FamilyScope {
    FamilyScope {
        realm_id: RealmId::new("readiness-realm").unwrap(),
        vault_id: VaultId::new("readiness-vault").unwrap(),
    }
}
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn create(store: &mut Store, value: &str) {
    store
        .family_apply(
            &MutationRequest {
                operation_id: OperationId::new(format!("create-{value}")).unwrap(),
                mutation: Mutation::Create {
                    id: id(value),
                    path: VaultPath::new(format!("{value}.md")).unwrap(),
                    kind: EntryKind::File,
                    content: Some(b"readiness fixture".to_vec()),
                },
            },
            Some(FamilyCreateMode::Text),
        )
        .unwrap();
}
fn fixture(entries: usize) -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    store.family_enroll(&scope()).unwrap();
    for index in 0..entries {
        create(&mut store, &format!("note-{index}"));
    }
    (directory, store)
}

// The tests-only c2ee79bb commit binds this seam to the old full predicate for
// the controlled RED. The production implementation admits scalar authority.
fn ready(store: &Store) -> Result<bool> {
    store.family_enrollment_ready()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ReadCounts {
    statements: usize,
    global_metrics: usize,
    publication_rows: usize,
}
struct ReadTrace<'a> {
    connection: &'a Connection,
    counts: Box<Cell<ReadCounts>>,
}
impl<'a> ReadTrace<'a> {
    fn new(store: &'a Store) -> Self {
        unsafe extern "C" fn observe(
            event: u32,
            context: *mut std::ffi::c_void,
            statement: *mut std::ffi::c_void,
            _: *mut std::ffi::c_void,
        ) -> i32 {
            if context.is_null()
                || statement.is_null()
                || !matches!(
                    event,
                    rusqlite::ffi::SQLITE_TRACE_STMT | rusqlite::ffi::SQLITE_TRACE_ROW
                )
            {
                return 0;
            }
            // sqlite owns this statement and SQL for the callback's duration.
            // The boxed Cell outlives tracing and is detached before its drop.
            let sql = unsafe { rusqlite::ffi::sqlite3_sql(statement.cast()) };
            if sql.is_null() {
                return 0;
            }
            let sql = unsafe { CStr::from_ptr(sql) }.to_bytes();
            let has = |part: &[u8]| sql.windows(part.len()).any(|window| window == part);
            let counts = unsafe { &*context.cast::<Cell<ReadCounts>>() };
            let mut next = counts.get();
            if event == rusqlite::ffi::SQLITE_TRACE_STMT {
                next.statements += 1;
                if has(b"FROM family_file_records m LEFT JOIN immutable_payloads")
                    || has(b"FROM family_text_activities m LEFT JOIN immutable_payloads")
                    || sql
                        .starts_with(b"SELECT EXISTS(SELECT 1 FROM family_materializations m WHERE")
                {
                    next.global_metrics += 1;
                }
            } else if sql.starts_with(b"SELECT CASE WHEN typeof(record)='text'")
                && has(b" FROM family_materializations")
            {
                next.publication_rows += 1;
            }
            counts.set(next);
            0
        }
        let trace = Self {
            connection: &store.connection,
            counts: Box::new(Cell::new(ReadCounts::default())),
        };
        assert_eq!(
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    trace.connection.handle(),
                    rusqlite::ffi::SQLITE_TRACE_STMT | rusqlite::ffi::SQLITE_TRACE_ROW,
                    Some(observe),
                    (&*trace.counts as *const Cell<ReadCounts>)
                        .cast_mut()
                        .cast(),
                )
            },
            rusqlite::ffi::SQLITE_OK
        );
        trace
    }
    fn reset(&self) {
        self.counts.set(ReadCounts::default());
    }
    fn counts(&self) -> ReadCounts {
        self.counts.get()
    }
}
impl Drop for ReadTrace<'_> {
    fn drop(&mut self) {
        assert_eq!(
            unsafe {
                rusqlite::ffi::sqlite3_trace_v2(
                    self.connection.handle(),
                    0,
                    None,
                    std::ptr::null_mut(),
                )
            },
            rusqlite::ffi::SQLITE_OK
        );
    }
}

#[test]
fn selected_valid_thousand_file_readiness_does_not_scan_status_corpus() {
    let (_directory, store) = fixture(1_000);
    let trace = ReadTrace::new(&store);
    assert!(store.family_is_enrolled().unwrap());
    let full = trace.counts();
    assert_eq!(
        full.global_metrics, 3,
        "explicit full predicate still computes status"
    );
    assert_eq!(
        full.publication_rows, 1_000,
        "real public Text fixture has 1000 publications"
    );
    trace.reset();
    assert!(ready(&store).unwrap());
    let scalar = trace.counts();
    eprintln!("readiness work counts: full={full:?}; selected={scalar:?}");
    assert_eq!(
        scalar.global_metrics, 0,
        "readiness must not collect global status metrics"
    );
    assert_eq!(
        scalar.publication_rows, 0,
        "readiness must not decode unrelated publication rows"
    );
}

#[test]
fn readiness_distinguishes_zero_and_one_valid_family_scope() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    assert!(!ready(&store).unwrap());
    store.family_enroll(&scope()).unwrap();
    assert!(ready(&store).unwrap());
    assert_eq!(store.family_status().unwrap().scope, Some(scope()));
}

#[test]
fn readiness_preserves_a_complete_legacy_text_binding_without_family_facts() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let identity = zorid_client_sync::TextIdentity {
        realm_id: scope().realm_id,
        vault_id: scope().vault_id,
        entry_id: id("legacy-text"),
        bootstrap_id: zorid_sync_protocol::UpdateId::new("legacy-bootstrap").unwrap(),
    };
    let created = store
        .apply(&MutationRequest {
            operation_id: OperationId::new("legacy-create").unwrap(),
            mutation: Mutation::Create {
                id: identity.entry_id.clone(),
                path: VaultPath::new("legacy.md").unwrap(),
                kind: EntryKind::File,
                content: Some(Vec::new()),
            },
        })
        .unwrap();
    let revision = &created
        .changes
        .iter()
        .find(|change| change.after.id == identity.entry_id)
        .unwrap()
        .after
        .revision;
    let text = store.bind_empty_text(&identity, revision).unwrap();
    assert!(!store.family_enrollment_ready().unwrap());
    assert_eq!(store.text_state(&identity.entry_id).unwrap(), Some(text));
    assert!(!store.family_is_enrolled().unwrap());
}

#[test]
fn readiness_rejects_every_orphan_graph_fact_without_an_enrollment_head() {
    // Deliberately model foreign corruption with valid table/column shapes but
    // absent references. Each fact table must independently prevent legacy mode.
    for sql in [
        "INSERT INTO family_graph_sources VALUES ('r','v','s','events','{}',0)",
        "INSERT INTO family_graph_events VALUES ('r','v','e','s',0,'entry','bootstrap','{}')",
        "INSERT INTO family_graph_claims VALUES ('r','v','s',0,'entry','{}')",
        "INSERT INTO family_graph_parents VALUES ('r','v','e','parent','entry')",
        "INSERT INTO family_graph_entries VALUES ('r','v','entry','{}',NULL,'root','note','live')",
        "INSERT INTO family_graph_entry_heads VALUES ('r','v','entry','namespace','e','{}')",
        "INSERT INTO family_graph_pending VALUES ('r','v','e','entry')",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().join("authority.sqlite")).unwrap();
        store
            .connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        store.connection.execute_batch(sql).unwrap();
        assert!(
            store.family_enrollment_ready().is_err(),
            "orphan must fail closed: {sql}"
        );
    }
}

#[test]
fn readiness_rechecks_identity_even_without_family_heads() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    assert!(!ready(&store).unwrap());
    store
        .connection
        .execute(
            "UPDATE authority_identity SET local_store_id='not-a-canonical-uuid' WHERE singleton=1",
            [],
        )
        .unwrap();
    assert!(
        ready(&store).is_err(),
        "unenrolled is not permission to skip identity validation"
    );
}

#[test]
fn readiness_rejects_partial_unbound_foreign_and_multiple_scope_heads() {
    for (reason, sql) in [
        ("partial identity", "PRAGMA ignore_check_constraints=ON; UPDATE authority_identity SET vault_id=NULL WHERE singleton=1; PRAGMA ignore_check_constraints=OFF;"),
        ("unbound identity with a family head", "UPDATE authority_identity SET realm_id=NULL,vault_id=NULL WHERE singleton=1;"),
        ("foreign scope", "UPDATE authority_identity SET vault_id='foreign-vault' WHERE singleton=1;"),
    ] {
        let (_directory, store) = fixture(0);
        store.connection.execute_batch(sql).unwrap();
        assert!(ready(&store).is_err(), "{reason} must fail closed");
    }
    let (_directory, store) = fixture(0);
    let tx = store.connection.unchecked_transaction().unwrap();
    file_state::initialize(
        &tx,
        &FamilyScope {
            vault_id: VaultId::new("foreign-vault").unwrap(),
            ..scope()
        },
        &Revision::new(uuid::Uuid::new_v4().to_string()).unwrap(),
    )
    .unwrap();
    tx.commit().unwrap();
    assert!(
        ready(&store).is_err(),
        "multiple individually valid heads cannot admit one authority"
    );
}

#[test]
fn readiness_rejects_missing_and_contradictory_selected_graph_state() {
    for (reason, sql) in [
        ("missing selected state", "DELETE FROM family_graph_state;"),
        ("head/state revision mismatch", "UPDATE family_graph_state SET revision='different-revision';"),
        ("invalid matched revision", "UPDATE family_graph_heads SET revision='invalid revision!'; UPDATE family_graph_state SET revision='invalid revision!';"),
        ("noninteger head count", "UPDATE family_graph_heads SET record_count='not-an-integer';"),
        ("head/state count mismatch", "UPDATE family_graph_heads SET activity_count=activity_count+1;"),
        ("invalid selected format", "PRAGMA ignore_check_constraints=ON; UPDATE family_graph_state SET format=2; PRAGMA ignore_check_constraints=OFF;"),
    ] {
        let (_directory, store) = fixture(0);
        store.connection.execute_batch(sql).unwrap();
        assert!(ready(&store).is_err(), "{reason} must fail closed");
    }
}

#[test]
fn readiness_rejects_missing_and_scalar_inconsistent_storage_accounting() {
    // These are scalar contradictions detectable without comparing every
    // immutable payload/fence. Full source-accounting comparison stays an audit.
    for (reason, sql) in [
        (
            "missing payload usage",
            "DELETE FROM family_graph_payload_usage;",
        ),
        (
            "missing revision usage",
            "DELETE FROM family_graph_revision_usage;",
        ),
        (
            "contradictory payload usage",
            "UPDATE family_graph_payload_usage SET records=2,bytes=1;",
        ),
        (
            "revision records/highest mismatch",
            "UPDATE family_graph_revision_usage SET highest=highest+1;",
        ),
        (
            "revision high-water mismatch",
            "UPDATE family_graph_revision_usage SET records=records+1,highest=highest+1;",
        ),
        (
            "revision allocation mismatch",
            "UPDATE sqlite_sequence SET seq=seq+1 WHERE name='revision_fences';",
        ),
    ] {
        let (_directory, store) = fixture(0);
        store.connection.execute_batch(sql).unwrap();
        assert!(ready(&store).is_err(), "{reason} must fail closed");
    }
}

#[test]
fn readiness_observes_a_foreign_connections_new_state_without_cached_admission() {
    let (directory, store) = fixture(1);
    assert!(ready(&store).unwrap());
    let original: String = store
        .connection
        .query_row("SELECT revision FROM family_graph_state", [], |row| {
            row.get(0)
        })
        .unwrap();
    let foreign = Connection::open(directory.path().join("authority.sqlite")).unwrap();
    foreign
        .execute(
            "UPDATE family_graph_state SET revision='foreign-revision'",
            [],
        )
        .unwrap();
    assert!(
        ready(&store).is_err(),
        "a prior positive readiness result is not a cached capability"
    );
    foreign
        .execute("UPDATE family_graph_state SET revision=?1", [original])
        .unwrap();
    assert!(
        ready(&store).unwrap(),
        "a repaired durable snapshot is freshly admitted"
    );
}

#[test]
fn readiness_does_not_bless_an_unrelated_malformed_publication() {
    let (_directory, store) = fixture(2);
    assert!(store
        .family_materialization(&id("note-0"))
        .unwrap()
        .is_some());
    assert!(store
        .family_materialization(&id("note-1"))
        .unwrap()
        .is_some());
    store
        .connection
        .execute(
            "UPDATE family_materializations SET record='{}' WHERE entry_id='note-1'",
            [],
        )
        .unwrap();
    // Scope readiness is intentionally not a scrub of every unrelated JSON
    // publication. Both the explicit full observation and the selected positive
    // reader must still reject that malformed publication independently.
    assert!(ready(&store).unwrap());
    assert!(store
        .family_materialization(&id("note-0"))
        .unwrap()
        .is_some());
    assert!(store.family_materialization(&id("note-1")).is_err());
    assert!(store.family_status().is_err());
    assert!(store.family_is_enrolled().is_err());
}
