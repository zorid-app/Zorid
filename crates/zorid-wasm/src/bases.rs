//! Thin JSON transport over the shared, host-fed Base engine. This module never
//! evaluates formulas in JavaScript, reads storage or serializes over raw files.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zorid_bases::{
    compile_base, compile_base_source, evaluate_expression, query_base, BaseSnapshot,
    DetachedRecord, EvaluationOptions, PropertyValue, QueryOptions,
};

// Initial bounded transport, separate from the engine's source/work/row guards.
const MAX_REQUEST_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULT_JSON_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
enum BindingError {
    RequestTooLarge { maximum_bytes: usize },
    InvalidRequest,
    ResultTooLarge { maximum_bytes: usize },
    ResultEncoding,
}
fn wire_error(error: &impl Serialize) -> String {
    serde_json::to_string(error).unwrap_or_else(|_| "{\"code\":\"result_encoding\"}".into())
}
fn decode<T: DeserializeOwned>(input: &str) -> Result<T, String> {
    if input.len() > MAX_REQUEST_JSON_BYTES {
        return Err(wire_error(&BindingError::RequestTooLarge {
            maximum_bytes: MAX_REQUEST_JSON_BYTES,
        }));
    }
    serde_json::from_str(input).map_err(|_| wire_error(&BindingError::InvalidRequest))
}
fn encode(value: &impl Serialize) -> Result<String, String> {
    let json =
        serde_json::to_string(value).map_err(|_| wire_error(&BindingError::ResultEncoding))?;
    if json.len() > MAX_RESULT_JSON_BYTES {
        return Err(wire_error(&BindingError::ResultTooLarge {
            maximum_bytes: MAX_RESULT_JSON_BYTES,
        }));
    }
    Ok(json)
}
fn js_error(error: String) -> JsValue {
    JsValue::from_str(&error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpressionRequest {
    expression: String,
    record: DetachedRecord,
    #[serde(default)]
    options: EvaluationOptions,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryRequest {
    configuration: PropertyValue,
    // The shared engine owns snapshot identity and its validation. Never replace
    // this with a local String token or weaker duplicate DTO at the binding.
    snapshot: BaseSnapshot,
    #[serde(default)]
    options: QueryOptions,
}
fn clamp_evaluation(options: &mut EvaluationOptions) {
    options.max_steps = options
        .max_steps
        .min(EvaluationOptions::default().max_steps);
}
fn clamp_query(options: &mut QueryOptions) {
    let maximum = QueryOptions::default();
    options.max_steps = options.max_steps.min(maximum.max_steps);
    options.max_scanned = options.max_scanned.min(maximum.max_scanned);
    options.max_rows = options.max_rows.min(maximum.max_rows);
    options.max_groups = options.max_groups.min(maximum.max_groups);
    options.max_output_bytes = options.max_output_bytes.min(maximum.max_output_bytes);
    clamp_evaluation(&mut options.evaluation);
}
fn expression_json(input: &str) -> Result<String, String> {
    let mut request: ExpressionRequest = decode(input)?;
    clamp_evaluation(&mut request.options);
    let result = evaluate_expression(&request.expression, &request.record, &request.options)
        .map_err(|error| wire_error(&error))?;
    encode(&result)
}
fn query_json(input: &str) -> Result<String, String> {
    let mut request: QueryRequest = decode(input)?;
    clamp_query(&mut request.options);
    let program = compile_base(request.configuration).map_err(|error| wire_error(&error))?;
    let result = query_base(&program, &request.snapshot, &request.options)
        .map_err(|error| wire_error(&error))?;
    encode(&result)
}
fn compile_json(input: &str) -> Result<String, String> {
    let source: String = decode(input)?;
    let program = compile_base_source(&source).map_err(|error| wire_error(&error))?;
    // Read-only semantic configuration, including unknown fields. This is not
    // source-preserving serialization and must never replace the input .base.
    encode(&program.configuration)
}

/// Input is {expression, record: DetachedRecord, options: EvaluationOptions} JSON.
/// Throws the shared typed diagnostic as JSON; caller limits can only be lowered.
#[wasm_bindgen(js_name = evaluateBaseExpression)]
pub fn evaluate_base_expression(input_json: &str) -> Result<String, JsValue> {
    expression_json(input_json).map_err(js_error)
}
/// Input is {configuration: PropertyValue, snapshot: BaseSnapshot,
/// options: QueryOptions} JSON. Result is the shared BaseQueryResult JSON.
#[wasm_bindgen(js_name = queryBase)]
pub fn query_base_json(input_json: &str) -> Result<String, JsValue> {
    query_json(input_json).map_err(js_error)
}
/// Input is a JSON-encoded exact .base source string. Returns decoded semantic
/// configuration only; it neither owns a file nor grants a source rewrite path.
#[wasm_bindgen(js_name = compileBaseSource)]
pub fn compile_base_source_json(input_json: &str) -> Result<String, JsValue> {
    compile_json(input_json).map_err(js_error)
}

#[cfg(test)]
mod tests {
    use super::{compile_json, decode};

    #[test]
    fn malformed_unicode_is_rejected_before_shared_source_compilation() {
        for raw in [r#""\ud800""#, r#""\udc00""#] {
            assert_eq!(
                compile_json(raw).unwrap_err(),
                r#"{"code":"invalid_request"}"#
            );
        }
        assert_eq!(
            decode::<String>("{}").unwrap_err(),
            r#"{"code":"invalid_request"}"#
        );
    }
}
