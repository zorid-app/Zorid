//! Remote RPC2 transport controls. Full ZSE1 envelope bytes stay opaque here;
//! these checks neither authenticate payloads nor commit receipts or cursors.
use wasm_bindgen::prelude::*;
use zorid_sync_protocol::{rpc, Cursor, LogPosition, RealmId, ServerEpoch, UpdateId, VaultId};

fn js_error(message: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&message.to_string())
}
fn position(value: &str) -> Result<LogPosition, &'static str> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err("sync_invalid_cursor");
    }
    value
        .parse::<u64>()
        .map(LogPosition::new)
        .map_err(|_| "sync_invalid_cursor")
}
#[wasm_bindgen(js_name = validateRpcHello)]
pub fn validate_rpc_hello(raw: &[u8], realm: &str, epoch: &str) -> Result<(), JsValue> {
    let realm = RealmId::new(realm).map_err(js_error)?;
    let epoch = ServerEpoch::new(epoch).map_err(js_error)?;
    rpc::decode_hello_reply(raw, &realm, &epoch).map_err(js_error)
}
#[wasm_bindgen(js_name = validateRpcAccepted)]
pub fn validate_rpc_accepted(
    raw: &[u8],
    vault: &str,
    update: &str,
    epoch: &str,
) -> Result<(), JsValue> {
    let vault = VaultId::new(vault).map_err(js_error)?;
    let update = UpdateId::new(update).map_err(js_error)?;
    let epoch = ServerEpoch::new(epoch).map_err(js_error)?;
    rpc::decode_accepted_reply(raw, &vault, &update, &epoch)
        .map(|_| ())
        .map_err(js_error)
}
#[wasm_bindgen]
pub struct WasmRpcPage {
    page: zorid_sync_protocol::transport::Page,
}
#[wasm_bindgen(js_name = openRpcPage)]
pub fn open_rpc_page(
    raw: &[u8],
    epoch: &str,
    after: &str,
    through: Option<String>,
) -> Result<WasmRpcPage, JsValue> {
    let cursor = Cursor::new(
        ServerEpoch::new(epoch).map_err(js_error)?,
        position(after).map_err(js_error)?,
    );
    let through = through
        .as_deref()
        .map(position)
        .transpose()
        .map_err(js_error)?;
    let page = rpc::decode_pull_reply(raw, &cursor, through).map_err(js_error)?;
    Ok(WasmRpcPage { page })
}
#[wasm_bindgen]
impl WasmRpcPage {
    pub fn through(&self) -> String {
        self.page.through.get().to_string()
    }
    pub fn complete(&self) -> bool {
        self.page.complete
    }
    pub fn length(&self) -> u32 {
        self.page.items.len() as u32
    }
    pub fn sequence(&self, index: f64) -> Result<String, JsValue> {
        let index = crate::checked_u32(index, "page index").map_err(js_error)? as usize;
        self.page
            .items
            .get(index)
            .map(|item| item.sequence.get().to_string())
            .ok_or_else(|| js_error("sync_invalid_page_index"))
    }
    pub fn wire(&self, index: f64) -> Result<Vec<u8>, JsValue> {
        let index = crate::checked_u32(index, "page index").map_err(js_error)? as usize;
        self.page
            .items
            .get(index)
            .map(|item| item.wire.clone())
            .ok_or_else(|| js_error("sync_invalid_page_index"))
    }
}
#[cfg(test)]
mod tests {
    use super::position;
    #[test]
    fn rpc_positions_preserve_full_u64_without_number_coercion() {
        for value in ["0", "9007199254740993", "18446744073709551615"] {
            assert_eq!(position(value).unwrap().get().to_string(), value);
        }
        for value in [
            "",
            "00",
            "01",
            "-1",
            "1.0",
            "1e3",
            " 1",
            "1\n",
            "18446744073709551616",
        ] {
            assert!(position(value).is_err(), "{value:?}");
        }
    }
}
