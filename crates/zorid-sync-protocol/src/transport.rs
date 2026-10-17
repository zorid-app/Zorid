//! Portable response validation shared by native and WASM transports.
//! Callers enforce HTTP status/origin/body streaming caps; these functions accept
//! raw bounded JSON, preserving duplicate-field rejection. No network or crypto.
use crate::{
    Accepted, ControlExtensions, Cursor, LogPosition, RealmId, ServerEpoch, UpdateId, VaultId,
    MAX_CONTROL_BYTES, MAX_WIRE_BYTES,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::value::RawValue;

/// Stable sanitized classifications retained from the CLI transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportError {
    code: &'static str,
}
impl TransportError {
    pub fn code(&self) -> &'static str {
        self.code
    }
}
impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for TransportError {}
type Result<T> = std::result::Result<T, TransportError>;
fn error(code: &'static str) -> TransportError {
    TransportError { code }
}
pub const MAX_ITEMS: usize = 64;
pub const MAX_PAGE_WIRE: usize = 2 * MAX_WIRE_BYTES;
pub const MAX_PAGE_JSON: usize = 4 * MAX_PAGE_WIRE.div_ceil(3) + 32 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    realm_id: RealmId,
    server_epoch: ServerEpoch,
    transport_versions: Vec<u16>,
    envelope_versions: Vec<u16>,
    suite: String,
    max_wire_bytes: usize,
    max_page_bytes: usize,
    max_page_items: usize,
    #[serde(default = "empty_extensions")]
    extensions: Box<RawValue>,
}
fn empty_extensions() -> Box<RawValue> {
    RawValue::from_string("{}".into()).expect("constant empty JSON object")
}
fn extensions(value: &RawValue) -> Result<()> {
    ControlExtensions::decode(value.get().as_bytes())
        .map_err(|_| error("sync_unsupported_protocol"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireItem {
    sequence: LogPosition,
    envelope_base64: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePage {
    items: Vec<WireItem>,
    next: Box<RawValue>,
    through: LogPosition,
    complete: bool,
    #[serde(default = "empty_extensions")]
    extensions: Box<RawValue>,
}
#[derive(Debug, serde::Serialize)]
pub struct Item {
    pub sequence: LogPosition,
    pub wire: Vec<u8>,
}
#[derive(Debug, serde::Serialize)]
pub struct Page {
    pub items: Vec<Item>,
    pub through: LogPosition,
    pub complete: bool,
}
/// Validate discovery against independently selected realm and server epoch.
pub fn decode_hello(bytes: &[u8], realm: &RealmId, epoch: &ServerEpoch) -> Result<()> {
    if bytes.len() > MAX_CONTROL_BYTES {
        return Err(error("sync_response_limit"));
    }
    let hello: Hello =
        serde_json::from_slice(&bytes).map_err(|_| error("sync_invalid_response"))?;
    extensions(&hello.extensions)?;
    if hello.realm_id != *realm || hello.server_epoch != *epoch {
        return Err(error("sync_epoch_or_realm_mismatch"));
    }
    if crate::negotiate_transport(&hello.transport_versions).is_err()
        || hello.envelope_versions.len() > 16
        || !hello.envelope_versions.contains(&1)
        || hello.suite != "xchacha20poly1305"
        || hello.max_wire_bytes != MAX_WIRE_BYTES
        || hello.max_page_bytes != MAX_PAGE_WIRE
        || hello.max_page_items != MAX_ITEMS
    {
        return Err(error("sync_unsupported_protocol"));
    }
    Ok(())
}
/// Validate an upload acknowledgment against the exact requested target.
pub fn decode_accepted(
    bytes: &[u8],
    vault: &VaultId,
    update: &UpdateId,
    epoch: &ServerEpoch,
) -> Result<Accepted> {
    let accepted = Accepted::decode(bytes).map_err(|_| error("sync_invalid_ack"))?;
    accepted
        .check_target(vault, update, epoch)
        .map_err(|_| error("sync_invalid_ack"))?;
    Ok(accepted)
}
pub fn decode_page(bytes: &[u8], cursor: &Cursor, through: Option<LogPosition>) -> Result<Page> {
    if bytes.len() > MAX_PAGE_JSON {
        return Err(error("sync_response_limit"));
    }
    let page: WirePage =
        serde_json::from_slice(bytes).map_err(|_| error("sync_invalid_response"))?;
    extensions(&page.extensions)?;
    let next =
        Cursor::decode(page.next.get().as_bytes()).map_err(|_| error("sync_invalid_response"))?;
    if next.server_epoch != cursor.server_epoch
        || page.through < cursor.after
        || through.is_some_and(|bound| bound != page.through)
        || page.items.len() > MAX_ITEMS
        || next.after > page.through
        || next.after < cursor.after
        || page.complete != (next.after == page.through)
        || (!page.complete && page.items.is_empty())
    {
        return Err(error("sync_invalid_page"));
    }
    let mut after = cursor.after.get();
    let mut total = 0usize;
    let mut items = Vec::with_capacity(page.items.len());
    for item in page.items {
        let expected = after
            .checked_add(1)
            .ok_or_else(|| error("sync_invalid_page"))?;
        if item.sequence.get() != expected
            || item.sequence > page.through
            || item.envelope_base64.len() > 4 * MAX_WIRE_BYTES.div_ceil(3)
        {
            return Err(error("sync_invalid_page"));
        }
        let wire = STANDARD
            .decode(&item.envelope_base64)
            .map_err(|_| error("sync_invalid_envelope"))?;
        if wire.len() > MAX_WIRE_BYTES || STANDARD.encode(&wire) != item.envelope_base64 {
            return Err(error("sync_invalid_envelope"));
        }
        total = total
            .checked_add(wire.len())
            .ok_or_else(|| error("sync_limit"))?;
        if total > MAX_PAGE_WIRE {
            return Err(error("sync_limit"));
        }
        after = expected;
        items.push(Item {
            sequence: item.sequence,
            wire,
        });
    }
    if after != next.after.get() {
        return Err(error("sync_invalid_page"));
    }
    Ok(Page {
        items,
        through: page.through,
        complete: page.complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn cursor() -> Cursor {
        Cursor::new(ServerEpoch::new("epoch").unwrap(), LogPosition::new(0))
    }
    fn page(sequence: &str, next: &str, through: &str, complete: bool) -> Value {
        json!({"items":[{"sequence":sequence,"envelope_base64":STANDARD.encode([1u8,2,3])}],
            "next":Cursor::new(ServerEpoch::new("epoch").unwrap(),LogPosition::new(next.parse().unwrap())),
            "through":through,"complete":complete,"extensions":{}})
    }
    #[test]
    fn page_chain_rejects_gaps_wrong_boundary_epoch_and_required_extensions() {
        let good = page("1", "1", "1", true);
        assert!(decode_page(&serde_json::to_vec(&good).unwrap(), &cursor(), None).is_ok());
        let mut epoch = good.clone();
        epoch["next"]["server_epoch"] = json!("other");
        let mut required = good.clone();
        required["extensions"] = json!({"required_features":["future"]});
        let mut huge = good.clone();
        huge["items"][0]["envelope_base64"] = json!("a".repeat(4 * MAX_WIRE_BYTES.div_ceil(3) + 1));
        for bad in [
            page("2", "2", "2", true),
            page("1", "0", "1", false),
            page("1", "1", "2", true),
            epoch,
            required,
            huge,
        ] {
            assert!(decode_page(&serde_json::to_vec(&bad).unwrap(), &cursor(), None).is_err());
        }
        assert!(decode_page(
            &serde_json::to_vec(&good).unwrap(),
            &cursor(),
            Some(LogPosition::new(2))
        )
        .is_err());
    }
    #[test]
    fn extension_duplicates_and_explicit_null_reach_shared_decoder_unchanged() {
        let good = serde_json::to_string(&page("1", "1", "1", true)).unwrap();
        for extensions in [
            r#"{"required_features":["future"],"required_features":[]}"#,
            "null",
        ] {
            let bad = good.replace("\"extensions\":{}", &format!("\"extensions\":{extensions}"));
            assert_ne!(bad, good);
            assert!(decode_page(bad.as_bytes(), &cursor(), None).is_err());
        }
    }
    #[test]
    fn body_cap_is_checked_before_json_parse() {
        assert!(decode_page(&vec![b' '; MAX_PAGE_JSON + 1], &cursor(), None).is_err());
    }
    #[test]
    fn hello_is_bounded_strict_and_bound_to_selected_server() {
        let realm = RealmId::new("realm").unwrap();
        let epoch = ServerEpoch::new("epoch").unwrap();
        let good = json!({"realm_id":"realm","server_epoch":"epoch",
            "transport_versions":[1],"envelope_versions":[1],"suite":"xchacha20poly1305",
            "max_wire_bytes":MAX_WIRE_BYTES,"max_page_bytes":MAX_PAGE_WIRE,
            "max_page_items":MAX_ITEMS,"extensions":{}});
        let raw = serde_json::to_string(&good).unwrap();
        assert!(decode_hello(raw.as_bytes(), &realm, &epoch).is_ok());
        for bad in [
            raw.replace("\"realm\"", "\"other\""),
            raw.replace("\"epoch\"", "\"other\""),
            raw.replace("[1]", "[2]"),
            raw.replace("xchacha20poly1305", "unknown"),
            raw.replace("\"extensions\":{}", "\"extensions\":null"),
            raw.replacen("{", "{\"realm_id\":\"realm\",", 1),
            " ".repeat(MAX_CONTROL_BYTES + 1),
        ] {
            assert!(decode_hello(bad.as_bytes(), &realm, &epoch).is_err());
        }
    }
    #[test]
    fn acknowledgment_must_match_exact_upload_target() {
        let vault = VaultId::new("vault").unwrap();
        let update = UpdateId::new("update").unwrap();
        let epoch = ServerEpoch::new("epoch").unwrap();
        let good = serde_json::to_vec(
            &Accepted::new(
                vault.clone(),
                update.clone(),
                epoch.clone(),
                LogPosition::new(1),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(decode_accepted(&good, &vault, &update, &epoch).is_ok());
        assert!(decode_accepted(&good, &VaultId::new("other").unwrap(), &update, &epoch).is_err());
        assert!(decode_accepted(&good, &vault, &UpdateId::new("other").unwrap(), &epoch).is_err());
        assert!(
            decode_accepted(&good, &vault, &update, &ServerEpoch::new("other").unwrap()).is_err()
        );
    }
    #[test]
    fn page_rejects_duplicate_fields_noncanonical_sequences_and_base64() {
        let raw = serde_json::to_string(&page("1", "1", "1", true)).unwrap();
        for bad in [
            raw.replace("\"through\":\"1\"", "\"through\":\"01\""),
            raw.replace("\"through\":\"1\"", "\"through\":1"),
            raw.replace(
                "\"sequence\":\"1\"",
                "\"sequence\":\"1\",\"sequence\":\"1\"",
            ),
            raw.replace(
                "\"server_epoch\":\"epoch\"",
                "\"server_epoch\":\"epoch\",\"server_epoch\":\"epoch\"",
            ),
            raw.replace("AQID", "AQID="),
            raw.replace("AQID", "AQID\\n"),
        ] {
            assert_ne!(bad, raw);
            assert!(decode_page(bad.as_bytes(), &cursor(), None).is_err());
        }
        let cursor = Cursor::new(
            ServerEpoch::new("epoch").unwrap(),
            LogPosition::new(u64::MAX),
        );
        let empty =
            json!({"items":[],"next":cursor,"through":u64::MAX.to_string(),"complete":true});
        assert!(decode_page(&serde_json::to_vec(&empty).unwrap(), &cursor, None).is_ok());
    }
}
