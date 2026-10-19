//! Portable JSON-boundary checks run with explicit clocks. Native-hosted tests
//! do not establish execution in a browser or wasm32 error-envelope behavior.
use super::*;
use serde_json::{json, Value};

const DEFINITION: &[u8] = b"filters: file.path == \"Note.md\"\nformulas:\n  clock: now()\n  day: today().format(\"YYYY-MM-DD\")\nviews:\n  - type: table\n    name: Clock\n    order: [file.path, formula.clock, formula.day]\n";
const TORONTO_DAYS: &[(i64, &str)] = &[
    (1_710_046_799_999, "2024-03-09"), // 2024-03-10T04:59:59.999Z
    (1_710_046_800_000, "2024-03-10"), // UTC-05 midnight
    (1_710_129_600_000, "2024-03-11"), // UTC-04 next midnight,23h later
    (1_730_606_399_999, "2024-11-02"), // 2024-11-03T03:59:59.999Z
    (1_730_606_400_000, "2024-11-03"), // UTC-04 midnight
    (1_730_696_400_000, "2024-11-04"), // UTC-05 next midnight,25h later
];
fn generation() -> WasmDocumentIndexGeneration {
    let versions: Value = serde_json::from_str(&document_index_versions_json().unwrap()).unwrap();
    let header = json!({
        "source":{"localStoreId":"clock-store","watermark":"1"},
        "entries":[
            {"id":"note","path":"Note.md","kind":"file","revision":"r1","deleted":false},
            {"id":"base","path":"Clock.base","kind":"file","revision":"r2","deleted":false}
        ],
        "expectedIndex":null,
        "nextIndex":{"localStoreId":"clock-store","generationEpoch":"clock-epoch","generation":"1","versions":versions}
    }).to_string();
    let mut builder = WasmDocumentIndexBuilder::new(&header).unwrap();
    builder.add_text("note", b"Saved body\n").unwrap();
    builder.add_text("base", DEFINITION).unwrap();
    builder.finish().unwrap()
}
fn options(clock_ms: i64, timezone: &str) -> String {
    json!({"clockMs":clock_ms,"timezone":timezone,"currentEntryId":"base"}).to_string()
}
fn assert_values(report: &Value, clock_ms: i64, day: &str) {
    assert_eq!(report["coverageComplete"], true);
    assert_eq!(report["snapshot"], report["value"]["result"]["snapshotId"]);
    let result = &report["value"]["result"];
    assert_eq!(result["diagnostics"], json!([]));
    assert_eq!(result["rows"].as_array().unwrap().len(), 1);
    let row = &result["rows"][0];
    assert_eq!(row["path"], "Note.md");
    assert_eq!(
        row["values"]["formula.clock"],
        json!({"type":"date","timestamp":clock_ms,"hasTime":true})
    );
    assert_eq!(
        row["values"]["formula.day"],
        json!({"type":"string","value":day})
    );
}
#[test]
fn json_cache_calls_keep_selected_timezone_and_exact_invocation_clock() {
    let generation = generation();
    let mut cache = WasmDocumentIndexPreparationCache::new();
    for (index, (clock_ms, timezone, day)) in [
        (1_792_290_600_000, "UTC", "2026-10-18"),
        (1_792_290_600_000, "America/Toronto", "2026-10-17"),
        (0, "UTC", "1970-01-01"),
        (0, "America/Toronto", "1969-12-31"),
    ]
    .into_iter()
    .enumerate()
    {
        for repeat in 0..2 {
            let raw = cache
                .base_json(
                    &generation,
                    "base",
                    DEFINITION,
                    "[]",
                    &options(clock_ms, timezone),
                    (index * 2 + repeat) as f64,
                    Some("Clock".into()),
                )
                .unwrap();
            assert_values(&serde_json::from_str(&raw).unwrap(), clock_ms, day);
        }
    }
}
#[test]
fn json_calls_follow_selected_midnight_on_short_and_long_dst_days() {
    let generation = generation();
    let mut cache = WasmDocumentIndexPreparationCache::new();
    assert_eq!(TORONTO_DAYS[2].0 - TORONTO_DAYS[1].0, 23 * 60 * 60 * 1000);
    assert_eq!(TORONTO_DAYS[5].0 - TORONTO_DAYS[4].0, 25 * 60 * 60 * 1000);
    for (index, &(clock_ms, day)) in TORONTO_DAYS.iter().enumerate() {
        let raw = cache
            .base_json(
                &generation,
                "base",
                DEFINITION,
                "[]",
                &options(clock_ms, "America/Toronto"),
                index as f64,
                None,
            )
            .unwrap();
        assert_values(&serde_json::from_str(&raw).unwrap(), clock_ms, day);
    }
}
#[test]
fn unsupported_year_from_json_is_structured_before_js_error_encoding() {
    let generation = generation();
    let id = EntryId::new("base").unwrap();
    let mut cache = WasmDocumentIndexPreparationCache::new();
    let raw = cache
        .base_json(
            &generation,
            "base",
            DEFINITION,
            "[]",
            &options(0, "UTC"),
            0.0,
            None,
        )
        .unwrap();
    assert_values(&serde_json::from_str(&raw).unwrap(), 0, "1970-01-01");
    for (index, clock_ms) in [-62_167_219_200_001, 253_402_300_800_000, i64::MIN, i64::MAX]
        .into_iter()
        .enumerate()
    {
        let input: BaseReadOptions = serde_json::from_str(&options(clock_ms, "UTC")).unwrap();
        // Native-hosted wasm_bindgen cannot construct a JsValue error. Exercise
        // the exact typed boundary called by base_report, before its JS mapping.
        let error = match evaluate_base(
            &generation.generation,
            &id,
            DEFINITION,
            &[],
            input,
            None,
            Some((&mut cache.inner, index as u64 + 1)),
        ) {
            Ok(_) => panic!("unsupported invocation year unexpectedly succeeded"),
            Err(error) => error,
        };
        match error {
            BaseReadError::Evaluation(diagnostic) => {
                assert_eq!(diagnostic.code, "input");
                assert_eq!(diagnostic.message, "Clock or timestamp is out of range");
            }
            other => panic!("expected structured clock diagnostic, got {other:?}"),
        }
    }
    let raw = cache
        .base_json(
            &generation,
            "base",
            DEFINITION,
            "[]",
            &options(0, "UTC"),
            10.0,
            None,
        )
        .unwrap();
    assert_values(&serde_json::from_str(&raw).unwrap(), 0, "1970-01-01");
}

#[test]
fn overflowing_offset_json_reaches_structured_failure_before_js_error_encoding() {
    let generation = generation();
    let id = EntryId::new("base").unwrap();
    let mut cache = WasmDocumentIndexPreparationCache::new();
    for (index, (timezone, day)) in [
        ("+02:00", "1970-01-01"),
        ("-02:00", "1969-12-31"),
        ("+1:30", "1970-01-01"),
    ]
    .into_iter()
    .enumerate()
    {
        let raw = cache
            .base_json(
                &generation,
                "base",
                DEFINITION,
                "[]",
                &options(0, timezone),
                index as f64,
                None,
            )
            .unwrap();
        assert_values(&serde_json::from_str(&raw).unwrap(), 0, day);
    }
    for (index, timezone) in [
        "+2147483647:00",
        "-2147483648:00",
        "+00:2147483647",
        "+2147483647:2147483647",
        "+596523:15", // each product fits i32; their sum exceeds i32::MAX
    ]
    .into_iter()
    .enumerate()
    {
        let input: BaseReadOptions = serde_json::from_str(&options(0, timezone)).unwrap();
        let error = match evaluate_base(
            &generation.generation,
            &id,
            DEFINITION,
            &[],
            input,
            None,
            Some((&mut cache.inner, index as u64 + 4)),
        ) {
            Ok(_) => panic!("overflowing offset unexpectedly succeeded: {timezone}"),
            Err(error) => error,
        };
        match error {
            BaseReadError::Evaluation(diagnostic) => {
                assert_eq!(diagnostic.code, "input");
                assert_eq!(
                    diagnostic.message,
                    format!("Invalid fixed timezone offset '{timezone}'")
                );
            }
            other => panic!("expected structured offset diagnostic, got {other:?}"),
        }
    }
}
