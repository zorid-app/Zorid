//! JSON-only document transport. Hosts stringify request objects before passing
//! them through wasm-bindgen: JSON escapes lone JS surrogates, which serde rejects
//! instead of accepting TextEncoder's replacement characters as note content.
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zorid_document::{parse_markdown, MetadataRequest, MAX_SOURCE_BYTES};

// A valid 16 MiB source may expand sixfold when every byte needs a JSON \u00XX
// escape. Keep the transport ceiling separate from the decoded source ceiling.
const MAX_DOCUMENT_REQUEST_JSON_BYTES: usize = MAX_SOURCE_BYTES * 6 + 4096;

#[derive(Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
enum DocumentBindingError {
    RequestTooLarge { maximum_bytes: usize },
    InvalidRequest,
    ResultEncoding,
}

fn error_json(error: &impl Serialize) -> String {
    serde_json::to_string(error).unwrap_or_else(|_| "{\"code\":\"result_encoding\"}".into())
}

fn parse_document_json(input: &str) -> Result<String, String> {
    if input.len() > MAX_DOCUMENT_REQUEST_JSON_BYTES {
        return Err(error_json(&DocumentBindingError::RequestTooLarge {
            maximum_bytes: MAX_DOCUMENT_REQUEST_JSON_BYTES,
        }));
    }
    // Deserialize directly into the strong shared IDs and Unicode strings. An
    // intermediate serde_json::Value would discard recursive map source order.
    let request: MetadataRequest = serde_json::from_str(input)
        .map_err(|_| error_json(&DocumentBindingError::InvalidRequest))?;
    let result = parse_markdown(&request).map_err(|error| error_json(&error))?;
    serde_json::to_string(&result).map_err(|_| error_json(&DocumentBindingError::ResultEncoding))
}

/// Returns DocumentMetadata JSON; throws a JSON-encoded stable error code. This
/// parses caller-supplied content only: no host IO, source edits or index publish.
#[wasm_bindgen(js_name = parseDocumentMetadata)]
pub fn parse_document_metadata(input_json: &str) -> Result<String, JsValue> {
    parse_document_json(input_json).map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod tests {
    use super::parse_document_json;

    #[test]
    fn invalid_identity_and_escaped_lone_surrogates_fail_before_extraction() {
        for source in [
            r#"{"entryId":"bad:id","contentRevision":"revision-1","source":""}"#,
            r#"{"entryId":"entry-1","contentRevision":"bad:revision","source":""}"#,
            r#"{"entryId":"entry-1","contentRevision":"revision-1","source":"\ud800"}"#,
            r#"{"entryId":"entry-1","contentRevision":"revision-1","source":"\udc00"}"#,
        ] {
            assert_eq!(
                parse_document_json(source).unwrap_err(),
                r#"{"code":"invalid_request"}"#
            );
        }
    }
}
