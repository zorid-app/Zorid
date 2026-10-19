//! Fixed-clock native boundary checks; no process timezone or wall clock oracle.
use zorid_bases::BaseValue;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, OperationId, VaultPath};
use zorid_native::{NativeDocumentError, NativeVault, QueryOptions};

const DEFINITION: &str = "filters: file.path == \"Note.md\"\nformulas:\n  clock: now()\n  day: today().format(\"YYYY-MM-DD\")\nviews:\n  - type: table\n    name: Clock\n    order: [file.path, formula.clock, formula.day]\n";
// UTC instants and local calendar labels are independent fixture literals.
// Toronto's spring day is23h and autumn day25h, rather than24h timers.
const TORONTO_DAYS: &[(i64, &str)] = &[
    (1_710_046_799_999, "2024-03-09"), // 2024-03-10T04:59:59.999Z
    (1_710_046_800_000, "2024-03-10"), // Toronto midnight, UTC-05
    (1_710_129_600_000, "2024-03-11"), // next midnight, UTC-04
    (1_730_606_399_999, "2024-11-02"), // 2024-11-03T03:59:59.999Z
    (1_730_606_400_000, "2024-11-03"), // Toronto midnight, UTC-04
    (1_730_696_400_000, "2024-11-04"), // next midnight, UTC-05
];
fn id(value: &str) -> EntryId {
    EntryId::new(value).unwrap()
}
fn create(vault: &mut NativeVault, name: &str, path: &str, source: &str) {
    vault
        .apply(&MutationRequest {
            operation_id: OperationId::new(format!("create-{name}")).unwrap(),
            mutation: Mutation::Create {
                id: id(name),
                path: VaultPath::new(path).unwrap(),
                kind: EntryKind::File,
                content: Some(source.as_bytes().to_vec()),
            },
        })
        .unwrap();
}
fn fixture() -> (tempfile::TempDir, NativeVault) {
    let directory = tempfile::tempdir().unwrap();
    let mut vault = NativeVault::open(directory.path()).unwrap();
    create(&mut vault, "note", "Note.md", "Saved body\n");
    create(&mut vault, "base", "Clock.base", DEFINITION);
    vault.initialize_document_index().unwrap();
    let stage = vault.begin_document_index().unwrap();
    for _ in 0..4 {
        if vault.pump_document_index(&stage).unwrap().ready {
            vault.publish_document_index(&stage).unwrap();
            return (directory, vault);
        }
    }
    panic!("two-file clock fixture exceeded bounded pumps");
}
fn options(clock_ms: i64, timezone: &str) -> QueryOptions {
    let mut value = QueryOptions::default();
    value.evaluation.clock_ms = clock_ms;
    value.evaluation.timezone = timezone.into();
    value
}
fn assert_values(result: &zorid_native::BaseQueryResult, clock_ms: i64, day: &str) {
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(result.rows.len(), 1);
    let row = &result.rows[0];
    assert_eq!(row.path, "Note.md");
    assert_eq!(
        row.values.get("formula.clock"),
        Some(&BaseValue::Date {
            timestamp: clock_ms,
            has_time: true
        })
    );
    assert_eq!(
        row.values.get("formula.day"),
        Some(&BaseValue::String { value: day.into() })
    );
}
#[test]
fn explicit_clock_and_selected_timezone_survive_same_owner_cache_and_new_pins() {
    let (_directory, vault) = fixture();
    let pin = vault.open_document_snapshot().unwrap();
    let cases = [
        (1_792_290_600_000, "UTC", "2026-10-18"),
        (1_792_290_600_000, "America/Toronto", "2026-10-17"),
        (0, "UTC", "1970-01-01"),
        (0, "America/Toronto", "1969-12-31"),
    ];
    for (clock_ms, timezone, day) in cases {
        for _ in 0..2 {
            let report = vault
                .query_base_document(&pin, &id("base"), &options(clock_ms, timezone))
                .unwrap();
            assert_eq!(report.snapshot, report.value.result.snapshot_id);
            assert!(report.coverage_complete);
            assert_values(&report.value.result, clock_ms, day);
        }
    }
    vault.close_document_snapshot(pin);
    let fresh = vault.open_document_snapshot().unwrap();
    let report = vault
        .query_base_document_view(
            &fresh,
            &id("base"),
            "Clock",
            &options(1_792_290_600_000, "America/Toronto"),
        )
        .unwrap();
    assert_values(&report.value.result, 1_792_290_600_000, "2026-10-17");
    vault.close_document_snapshot(fresh);
}
#[test]
fn selected_midnight_changes_follow_dst_calendar_days_on_one_retained_generation() {
    let (_directory, vault) = fixture();
    let pin = vault.open_document_snapshot().unwrap();
    assert_eq!(TORONTO_DAYS[2].0 - TORONTO_DAYS[1].0, 23 * 60 * 60 * 1000);
    assert_eq!(TORONTO_DAYS[5].0 - TORONTO_DAYS[4].0, 25 * 60 * 60 * 1000);
    for &(clock_ms, day) in TORONTO_DAYS {
        let report = vault
            .query_base_document(&pin, &id("base"), &options(clock_ms, "America/Toronto"))
            .unwrap();
        assert_values(&report.value.result, clock_ms, day);
    }
    vault.close_document_snapshot(pin);
}
#[test]
fn unsupported_invocation_year_is_a_structured_native_failure_after_valid_answers() {
    let (_directory, vault) = fixture();
    let pin = vault.open_document_snapshot().unwrap();
    assert_values(
        &vault
            .query_base_document(&pin, &id("base"), &options(0, "UTC"))
            .unwrap()
            .value
            .result,
        0,
        "1970-01-01",
    );
    for clock_ms in [-62_167_219_200_001, 253_402_300_800_000, i64::MIN, i64::MAX] {
        let error = match vault.query_base_document(&pin, &id("base"), &options(clock_ms, "UTC")) {
            Ok(_) => panic!("unsupported invocation year unexpectedly succeeded"),
            Err(error) => error,
        };
        match error {
            NativeDocumentError::BaseEvaluation(diagnostic) => {
                assert_eq!(diagnostic.code, "input");
                assert_eq!(diagnostic.message, "Clock or timestamp is out of range");
            }
            other => panic!("expected structured clock diagnostic, got {other:?}"),
        }
    }
    assert_values(
        &vault
            .query_base_document(&pin, &id("base"), &options(0, "UTC"))
            .unwrap()
            .value
            .result,
        0,
        "1970-01-01",
    );
    vault.close_document_snapshot(pin);
}

#[test]
fn overflowing_offsets_fail_structurally_and_existing_valid_offsets_stay_usable() {
    let (_directory, vault) = fixture();
    let pin = vault.open_document_snapshot().unwrap();
    // Preserve current offset spelling; grammar tightening is separate work.
    for (timezone, day) in [
        ("+02:00", "1970-01-01"),
        ("-02:00", "1969-12-31"),
        ("+1:30", "1970-01-01"),
    ] {
        let report = vault
            .query_base_document(&pin, &id("base"), &options(0, timezone))
            .unwrap();
        assert_values(&report.value.result, 0, day);
    }
    for timezone in [
        "+2147483647:00",
        "-2147483648:00",
        "+00:2147483647",
        "+2147483647:2147483647",
        "+596523:15", // each product fits i32; their sum exceeds i32::MAX
    ] {
        let error = match vault.query_base_document(&pin, &id("base"), &options(0, timezone)) {
            Ok(_) => panic!("overflowing offset unexpectedly succeeded: {timezone}"),
            Err(error) => error,
        };
        match error {
            NativeDocumentError::BaseEvaluation(diagnostic) => {
                assert_eq!(diagnostic.code, "input");
                assert_eq!(
                    diagnostic.message,
                    format!("Invalid fixed timezone offset '{timezone}'")
                );
            }
            other => panic!("expected structured offset diagnostic, got {other:?}"),
        }
    }
    vault.close_document_snapshot(pin);
}
