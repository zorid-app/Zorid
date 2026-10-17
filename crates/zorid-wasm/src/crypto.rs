//! Trusted-host capability, not a plugin API or key enrollment implementation.
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;
use zorid_crypto::{SystemEntropy, VaultKey};
use zorid_sync_protocol::{
    Envelope, ExpectedContext, Header, RealmId, UpdateId, VaultId, MAX_CONTROL_BYTES,
    MAX_PLAINTEXT_BYTES, MAX_WIRE_BYTES,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextInput {
    realm_id: RealmId,
    vault_id: VaultId,
    update_id: UpdateId,
    key_epoch: u32,
}
pub(crate) fn context(input: &str) -> Result<ExpectedContext, String> {
    if input.len() > MAX_CONTROL_BYTES {
        return Err("context too large".into());
    }
    let value: ContextInput = serde_json::from_str(input).map_err(|_| "invalid context")?;
    if value.key_epoch == 0 {
        return Err("invalid key epoch".into());
    }
    Ok(ExpectedContext {
        realm_id: value.realm_id,
        vault_id: value.vault_id,
        update_id: value.update_id,
        key_epoch: value.key_epoch,
    })
}
fn import_key(bytes: Vec<u8>) -> Result<VaultKey, String> {
    // Clear the binding's owned import allocation after copying into VaultKey.
    let bytes = Zeroizing::new(bytes);
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "key must contain exactly 32 bytes")?;
    Ok(VaultKey::from_bytes(key))
}
fn error(value: impl std::fmt::Display) -> JsValue {
    // Library errors contain enum names, never plaintext/key/request bytes.
    JsValue::from_str(&value.to_string())
}

#[wasm_bindgen]
pub struct WasmVaultKey {
    key: VaultKey,
}
#[wasm_bindgen(js_name = generateKey)]
pub fn generate_key() -> Result<WasmVaultKey, JsValue> {
    VaultKey::generate(&mut SystemEntropy)
        .map(|key| WasmVaultKey { key })
        .map_err(error)
}
#[wasm_bindgen]
impl WasmVaultKey {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<WasmVaultKey, JsValue> {
        import_key(bytes).map(|key| Self { key }).map_err(error)
    }
    /// Explicit trusted-host enrollment/recovery export. JS owns this secret copy;
    /// zeroing/freeing the Rust handle cannot erase that JS allocation.
    #[wasm_bindgen(js_name = exportSecret)]
    pub fn export_secret(&self) -> Vec<u8> {
        self.key.expose_secret().to_vec()
    }
    /// Authenticate and decode a current-format update without exposing an
    /// authenticated plaintext constructor to JavaScript.
    #[wasm_bindgen(js_name = openSyncUpdate)]
    pub fn open_sync_update(
        &self,
        context_json: &str,
        wire: &[u8],
    ) -> Result<super::sync::WasmSyncUpdate, JsValue> {
        super::sync::open_update(&self.key, context_json, wire).map_err(error)
    }
    /// Authenticates and plans text plus namespace activity synchronously in Rust.
    /// The host commits both domains and its common wire ledger/cursor atomically.
    #[wasm_bindgen(js_name = planReceivedText)]
    pub fn plan_received_text(
        &self,
        context_json: &str,
        input: &str,
        wire: &[u8],
    ) -> Result<super::sync::WasmReceivedTextPlan, JsValue> {
        super::sync::receive(&self.key, context_json, input, wire).map_err(error)
    }
    pub fn seal(&self, header_json: &str, plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
        if plaintext.len() > MAX_PLAINTEXT_BYTES {
            return Err(error("plaintext too large"));
        }
        let header = Header::decode(header_json.as_bytes()).map_err(error)?;
        zorid_crypto::seal(&header, plaintext, &self.key, &mut SystemEntropy)
            .map(|envelope| envelope.encode())
            .map_err(error)
    }
    /// Context is independently selected by the authorized host. Never copy all
    /// expected values out of the incoming untrusted header.
    pub fn open(&self, context_json: &str, wire: &[u8]) -> Result<Vec<u8>, JsValue> {
        if wire.len() > MAX_WIRE_BYTES {
            return Err(error("envelope too large"));
        }
        let expected = context(context_json).map_err(error)?;
        let envelope = Envelope::decode(wire).map_err(error)?;
        let plaintext = zorid_crypto::open(&envelope, &expected, &self.key).map_err(error)?;
        // Explicit copy to the JS host. Rust's zeroizing source drops here; the
        // returned JS data and binding transfer allocation are not guaranteed wiped.
        Ok(plaintext.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_import_and_context_are_bounded_and_strict() {
        for len in [0, 31, 33, 1024] {
            assert!(import_key(vec![0; len]).is_err());
        }
        assert!(import_key(vec![7; 32]).is_ok());
        let valid = r#"{"realm_id":"r","vault_id":"v","update_id":"u","key_epoch":1}"#;
        assert!(context(valid).is_ok());
        for bad in [
            valid.replace(":1", ":0"),
            valid.replace(":1", ":1.5"),
            valid.replace(":1", ":4294967296"),
            valid.replace("\"r\"", "\"../r\""),
            valid.replace("}", ",\"required_features\":[\"unknown\"]}"),
        ] {
            assert!(context(&bad).is_err());
        }
        assert!(context(&" ".repeat(MAX_CONTROL_BYTES + 1)).is_err());
    }
}
