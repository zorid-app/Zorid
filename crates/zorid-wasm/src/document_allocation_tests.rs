//! Hosted tests use the same typed helper before the JsValue error envelope.
//! They do not establish actual generated-wasm32 or IDB transaction acceptance.
use super::*;

fn request(counter: &str) -> GenerationAllocationRequest {
    serde_json::from_value(serde_json::json!({
        "localStoreId":"store", "generationEpoch":"cache-epoch", "allocated":counter
    })).unwrap()
}

#[test]
fn first_and_successive_reservations_keep_the_persisted_epoch() {
    let first = allocate_generation(request("0")).unwrap();
    let second = allocate_generation(request("1")).unwrap();
    assert_eq!(first.generation(), 1);
    assert_eq!(second.generation(), 2);
    assert_eq!(first.local_store_id(), second.local_store_id());
    assert_eq!(first.generation_epoch().as_str(), "cache-epoch");
    assert_eq!(first.generation_epoch(), second.generation_epoch());
    assert_eq!(first.versions(), second.versions());
}

#[test]
fn allocation_is_exact_above_javascript_integer_precision() {
    let value = allocate_generation(request("9007199254740992")).unwrap();
    let wire = serde_json::to_value(value).unwrap();
    assert_eq!(wire["generation"], "9007199254740993");
    let last = allocate_generation(request("18446744073709551614")).unwrap();
    assert_eq!(last.generation(), u64::MAX);
}

#[test]
fn exhausted_clock_never_wraps_or_changes_epoch() {
    assert_eq!(allocate_generation(request("18446744073709551615")), Err(IndexError::InvalidGeneration));
}

#[test]
fn allocation_input_requires_canonical_strings_and_exact_fields() {
    for bad in [serde_json::json!({"localStoreId":"store","generationEpoch":"epoch","allocated":1}),
        serde_json::json!({"localStoreId":"store","generationEpoch":"epoch","allocated":"01"}),
        serde_json::json!({"localStoreId":"store","generationEpoch":"epoch","allocated":"18446744073709551616"}),
        serde_json::json!({"localStoreId":"store","generationEpoch":"epoch","allocated":"0","head":"untrusted"})] {
        assert!(match serde_json::from_value::<GenerationAllocationRequest>(bad) {
            Err(_) => true,
            Ok(value) => allocate_generation(value).is_err(),
        });
    }
}
