//! Browser bindings to the same Rust contracts and text CRDT used natively.
//! This crate never saves data. A host adapter must commit state, bytes, outbox
//! and receipts atomically before reporting a durable save.
mod bases;
mod crypto;
mod document;
mod document_index;
mod document_preview;
mod document_runtime;
mod document_drafts;
mod rpc;
mod records;
mod workblocks;
mod sync;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zorid_core::{
    check_idempotency, plan_mutation, CommitResult, EntryState, IdempotencyCheck, MutationRequest,
    RecordedOperation, Revision, VaultPath,
};
use zorid_crdt::TextReplica;

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

// Taking f64 prevents wasm-bindgen's ordinary u32 coercion from silently wrapping
// negative, fractional or oversized JavaScript numbers into valid positions.
fn checked_u32(value: f64, label: &str) -> Result<u32, String> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > u32::MAX as f64 {
        return Err(format!(
            "{label} must be an integer from 0 through 4294967295"
        ));
    }
    Ok(value as u32)
}

#[wasm_bindgen]
pub struct WasmTextReplica {
    inner: TextReplica,
}

#[wasm_bindgen]
impl WasmTextReplica {
    /// Deterministic actor argument for fixtures. Concurrent writers must never
    /// share an actor; production actor allocation remains a separate contract.
    #[wasm_bindgen(constructor)]
    pub fn new(actor: f64) -> Result<WasmTextReplica, JsValue> {
        Ok(Self {
            inner: TextReplica::new(checked_u32(actor, "actor").map_err(js_error)?),
        })
    }

    pub fn text(&self) -> String {
        self.inner.text()
    }

    pub fn insert(&self, index: f64, text: &str) -> Result<(), JsValue> {
        let index = checked_u32(index, "index").map_err(js_error)?;
        self.inner.insert(index, text).map_err(js_error)
    }

    pub fn delete(&self, index: f64, length: f64) -> Result<(), JsValue> {
        let index = checked_u32(index, "index").map_err(js_error)?;
        let length = checked_u32(length, "length").map_err(js_error)?;
        self.inner.delete(index, length).map_err(js_error)
    }

    pub fn apply(&self, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner.apply(bytes).map_err(js_error)
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.inner.snapshot()
    }

    #[wasm_bindgen(js_name = stateVector)]
    pub fn state_vector(&self) -> Vec<u8> {
        self.inner.state_vector()
    }

    #[wasm_bindgen(js_name = changesSince)]
    pub fn changes_since(&self, vector: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner.changes_since(vector).map_err(js_error)
    }
}

#[wasm_bindgen(js_name = validatePath)]
pub fn validate_path(path: &str) -> Result<String, JsValue> {
    VaultPath::new(path).map(String::from).map_err(|error| {
        js_error(serde_json::to_string(&error).expect("serializable contract error"))
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    request: MutationRequest,
    entries: Vec<EntryState>,
    next_revision: Revision,
}

fn plan_json(input: &str) -> Result<String, String> {
    let input: PlanInput =
        serde_json::from_str(input).map_err(|error| format!("invalid plan input: {error}"))?;
    let changes = plan_mutation(&input.request, &input.entries, &input.next_revision)
        .map_err(|error| serde_json::to_string(&error).expect("serializable contract error"))?;
    serde_json::to_string(&changes).map_err(|error| format!("plan encoding failed: {error}"))
}

/// Returns EntryChange[] JSON. This is a plan, not a commit, revision allocation,
/// idempotency lookup, filesystem projection or network sync operation.
#[wasm_bindgen(js_name = planMutation)]
pub fn plan_mutation_json(input: &str) -> Result<String, JsValue> {
    plan_json(input).map_err(js_error)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdempotencyInput {
    request: MutationRequest,
    record: Option<RecordedOperation>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum IdempotencyOutput<'a> {
    New,
    Replay { result: &'a CommitResult },
}

fn idempotency_json(input: &str) -> Result<String, String> {
    let input: IdempotencyInput = serde_json::from_str(input)
        .map_err(|error| format!("invalid idempotency input: {error}"))?;
    let decision = check_idempotency(&input.request, input.record.as_ref())
        .map_err(|error| serde_json::to_string(&error).expect("serializable contract error"))?;
    let output = match decision {
        IdempotencyCheck::New => IdempotencyOutput::New,
        IdempotencyCheck::Replay(result) => IdempotencyOutput::Replay { result },
    };
    serde_json::to_string(&output).map_err(|error| format!("idempotency encoding failed: {error}"))
}

/// Run against the receipt read in the same write transaction, before target
/// revision checking. A replay returns the original receipt, even if the target
/// has subsequently changed. This does not perform a lookup or save a receipt.
#[wasm_bindgen(js_name = checkIdempotency)]
pub fn check_idempotency_json(input: &str) -> Result<String, JsValue> {
    idempotency_json(input).map_err(js_error)
}

fn snapshot_json(input: &str) -> Result<(), String> {
    let entries: Vec<EntryState> =
        serde_json::from_str(input).map_err(|error| format!("invalid snapshot input: {error}"))?;
    zorid_core::validate_snapshot(&entries)
        .map_err(|error| serde_json::to_string(&error).expect("contract error serializes"))
}

/// Validate persisted domain metadata independently of any mutation request.
#[wasm_bindgen(js_name = validateSnapshot)]
pub fn validate_snapshot_json(input: &str) -> Result<(), JsValue> {
    snapshot_json(input).map_err(js_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reads_reject_invalid_identity_duplicate_path_and_missing_parent() {
        assert!(snapshot_json("[]").is_ok());
        let entry = serde_json::json!({"id":"file-1","path":"one.bin","kind":"file","revision":"rev-1","deleted":false});
        assert!(snapshot_json(&serde_json::json!([entry]).to_string()).is_ok());
        let mut other = entry.clone();
        other["id"] = serde_json::json!("file-2");
        assert!(snapshot_json(&serde_json::json!([entry, other]).to_string()).is_err());
        for (field, value) in [
            ("path", "Missing/one.bin"),
            ("path", "../outside"),
            ("id", "bad id"),
            ("revision", "bad revision"),
        ] {
            let mut invalid = entry.clone();
            invalid[field] = serde_json::json!(value);
            assert!(snapshot_json(&serde_json::json!([invalid]).to_string()).is_err());
        }
    }

    #[test]
    fn rejects_js_numbers_that_u32_bindings_would_silently_coerce() {
        for value in [-1.0, 0.5, f64::NAN, f64::INFINITY, 4294967296.0] {
            assert!(checked_u32(value, "index").is_err());
        }
        assert_eq!(checked_u32(4294967295.0, "actor"), Ok(u32::MAX));
    }

    #[test]
    fn invalid_json_and_wrong_binary_bytes_do_not_produce_plans() {
        assert!(plan_json("{bad").is_err());
        let input = r#"{"request":{"operation_id":"op-1","mutation":{"type":"create","id":"file-1","path":"image.bin","kind":"file","content":[256]}},"entries":[],"next_revision":"rev-1"}"#;
        assert!(plan_json(input).is_err());
    }

    #[test]
    fn returns_real_core_metadata_plan_for_binary_file() {
        let input = r#"{"request":{"operation_id":"op-1","mutation":{"type":"create","id":"file-1","path":"image.bin","kind":"file","content":[0,255,128]}},"entries":[],"next_revision":"rev-1"}"#;
        let result: serde_json::Value = serde_json::from_str(&plan_json(input).unwrap()).unwrap();
        assert_eq!(result[0]["after"]["path"], "image.bin");
        assert_eq!(result[0]["after"]["revision"], "rev-1");
        assert!(result[0]["before"].is_null());
        // Bytes remain the host's obligation: a plan only returns metadata.
        assert!(result[0]["after"].get("content").is_none());
    }

    fn recorded_input() -> serde_json::Value {
        let request = serde_json::json!({
            "operation_id": "op-1",
            "mutation": {
                "type": "create", "id": "file-1", "path": "image.bin",
                "kind": "file", "content": [0, 255, 128]
            }
        });
        let plan = serde_json::json!({"request": request, "entries": [], "next_revision": "rev-1"});
        let changes: serde_json::Value =
            serde_json::from_str(&plan_json(&plan.to_string()).unwrap()).unwrap();
        serde_json::json!({
            "request": request,
            "record": {
                "request": request,
                "result": {"operation_id": "op-1", "sequence": "9007199254740993", "changes": changes}
            }
        })
    }

    fn decision(input: &serde_json::Value) -> serde_json::Value {
        serde_json::from_str(&idempotency_json(&input.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn exact_replay_preserves_old_receipt_and_large_sequence_after_later_change() {
        let input = recorded_input();
        let old = input["record"]["result"]["changes"][0]["after"].clone();
        let later_plan = serde_json::json!({
            "request": {"operation_id": "op-2", "mutation": {
                "type": "write", "id": "file-1", "expected": "rev-1", "content": [42]
            }}, "entries": [old], "next_revision": "rev-2"
        });
        let later: serde_json::Value =
            serde_json::from_str(&plan_json(&later_plan.to_string()).unwrap()).unwrap();
        assert_eq!(later[0]["after"]["revision"], "rev-2");
        // Lookup is by operation ID, not current entry revision; old operation
        // returns its original result without re-running create/preconditions.
        let replay = decision(&input);
        assert_eq!(replay["status"], "replay");
        assert_eq!(replay["result"], input["record"]["result"]);
        assert_eq!(replay["result"]["sequence"], "9007199254740993");
        assert_eq!(replay["result"]["changes"][0]["after"]["revision"], "rev-1");
        let mut fresh = input;
        fresh["record"] = serde_json::Value::Null;
        assert_eq!(decision(&fresh), serde_json::json!({"status": "new"}));
    }

    #[test]
    fn mismatched_bytes_id_and_corrupt_receipt_are_rejected() {
        let mut input = recorded_input();
        input["request"]["mutation"]["content"] = serde_json::json!([0, 254, 128]);
        let failure: serde_json::Value =
            serde_json::from_str(&idempotency_json(&input.to_string()).unwrap_err()).unwrap();
        assert_eq!(failure["code"], "idempotency_conflict");
        let mut input = recorded_input();
        input["request"]["operation_id"] = serde_json::json!("other-operation");
        let failure: serde_json::Value =
            serde_json::from_str(&idempotency_json(&input.to_string()).unwrap_err()).unwrap();
        assert_eq!(failure["code"], "invalid_operation_record");
        let mut input = recorded_input();
        input["record"]["result"]["changes"] = serde_json::json!([]);
        let failure: serde_json::Value =
            serde_json::from_str(&idempotency_json(&input.to_string()).unwrap_err()).unwrap();
        assert_eq!(failure["code"], "invalid_operation_record");
    }

    #[test]
    fn idempotency_input_rejects_unknown_fields_and_numeric_sequence() {
        let mut input = recorded_input();
        input["ignored"] = serde_json::json!(true);
        assert!(idempotency_json(&input.to_string())
            .unwrap_err()
            .starts_with("invalid idempotency input:"));
        let mut input = recorded_input();
        input["record"]["result"]["sequence"] = serde_json::json!(9007199254740993_u64);
        assert!(idempotency_json(&input.to_string())
            .unwrap_err()
            .starts_with("invalid idempotency input:"));
    }
}
