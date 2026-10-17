//! Thin bounded JSON bindings; all publication/recovery semantics remain in the
//! shared Rust classifier. These caps describe the fixture binding, not product
//! file-size support. No partial classification is returned on aggregate failure.
use super::{domain, error, json, parse, reusable_state, Result, MAX_STATE_JSON_BYTES};
use wasm_bindgen::prelude::*;
use zorid_client_sync::TextState;
use zorid_file_sync::{materialization, v2};

const MAX_CONTENT_BYTES: u64 = 8 * 1024 * 1024;
fn inputs(state_json: &str, texts_json: &str) -> Result<(v2::State, Vec<TextState>)> {
    // The aggregate text input cap preserves duplicate identities until the
    // portable classifier explicitly rejects them; do not collapse into a map.
    if state_json.len() > MAX_STATE_JSON_BYTES || texts_json.len() > MAX_STATE_JSON_BYTES {
        return Err("classification input exceeds fixture budget".into());
    }
    let state: v2::State = parse(state_json)?;
    reusable_state(&state)?;
    let texts: Vec<TextState> = parse(texts_json)?;
    if texts.len() > zorid_file_sync::MAX_RECORDS {
        return Err("too many classification text states".into());
    }
    Ok((state, texts))
}
pub(super) fn classify_json(state_json: &str, texts_json: &str) -> Result<String> {
    let (state, texts) = inputs(state_json, texts_json)?;
    let result = domain(materialization::classify_bounded(
        &state,
        &texts,
        MAX_CONTENT_BYTES,
        MAX_CONTENT_BYTES,
    ))?;
    json(&result)
}
#[wasm_bindgen(js_name = classifyFileMaterializations)]
pub fn classify_file_materializations(
    state_json: &str,
    texts_json: &str,
) -> std::result::Result<String, JsValue> {
    classify_json(state_json, texts_json).map_err(error)
}
pub(super) fn recovery_json(state_json: &str, texts_json: &str, entry_id: &str) -> Result<String> {
    let (state, texts) = inputs(state_json, texts_json)?;
    if entry_id.len() > zorid_sync_protocol::MAX_CONTROL_BYTES {
        return Err("entry identity too large".into());
    }
    let entry_id = domain(zorid_core::EntryId::new(entry_id))?;
    let result = domain(materialization::recovery_content(
        &state,
        &texts,
        &entry_id,
        MAX_CONTENT_BYTES,
    ))?;
    json(&result)
}
#[wasm_bindgen(js_name = recoveryFileContent)]
pub fn recovery_file_content(
    state_json: &str,
    texts_json: &str,
    entry_id: &str,
) -> std::result::Result<String, JsValue> {
    recovery_json(state_json, texts_json, entry_id).map_err(error)
}
