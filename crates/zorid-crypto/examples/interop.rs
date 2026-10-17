//! Disposable native/browser crypto fixture bridge. JSON input/output uses pipes,
//! never pass keys in argv or print requests in diagnostics. Not a product CLI.
use serde_json::{json, Value};
use std::io::{self, Read};
use zeroize::Zeroizing;
use zorid_crypto::{SystemEntropy, VaultKey};
use zorid_sync_protocol::{
    Envelope, ExpectedContext, Header, RealmId, UpdateId, VaultId, MAX_CONTROL_BYTES,
    MAX_HEADER_BYTES, MAX_PLAINTEXT_BYTES, MAX_WIRE_BYTES,
};

fn bytes(value: &Value, maximum: usize) -> Result<Vec<u8>, &'static str> {
    let array = value.as_array().ok_or("expected bytes")?;
    if array.len() > maximum {
        return Err("byte limit exceeded");
    }
    array
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|v| u8::try_from(v).ok())
                .ok_or("invalid byte")
        })
        .collect()
}
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, &'static str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or("missing string")
}
fn expected(value: &Value) -> Result<ExpectedContext, &'static str> {
    let object = value.as_object().ok_or("invalid context")?;
    if object.len() != 4
        || object
            .keys()
            .any(|k| !["realm_id", "vault_id", "update_id", "key_epoch"].contains(&k.as_str()))
    {
        return Err("invalid context fields");
    }
    let epoch = value["key_epoch"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or("invalid epoch")?;
    Ok(ExpectedContext {
        realm_id: RealmId::new(text(value, "realm_id")?).map_err(|_| "invalid realm")?,
        vault_id: VaultId::new(text(value, "vault_id")?).map_err(|_| "invalid vault")?,
        update_id: UpdateId::new(text(value, "update_id")?).map_err(|_| "invalid update")?,
        key_epoch: epoch,
    })
}
fn execute(value: &Value) -> Result<Value, String> {
    let op = text(value, "op")?;
    let allowed: &[&str] = match op {
        "generate" => &["op"],
        "seal" => &["op", "key", "header", "plaintext"],
        "open" => &["op", "key", "context", "wire"],
        _ => return Err("unknown command".into()),
    };
    if value
        .as_object()
        .ok_or("invalid request")?
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
    {
        return Err("unknown request field".into());
    }
    if op == "generate" {
        let key = VaultKey::generate(&mut SystemEntropy).map_err(|e| e.to_string())?;
        return Ok(json!({"key":key.expose_secret()}));
    }
    let raw = Zeroizing::new(bytes(&value["key"], 32)?);
    let key = VaultKey::from_bytes(
        raw.as_slice()
            .try_into()
            .map_err(|_| "key must have 32 bytes")?,
    );
    match op {
        "seal" => {
            let header = text(value, "header")?;
            if header.len() > MAX_HEADER_BYTES {
                return Err("header too large".into());
            }
            let header = Header::decode(header.as_bytes()).map_err(|e| e.to_string())?;
            let plaintext = Zeroizing::new(bytes(&value["plaintext"], MAX_PLAINTEXT_BYTES)?);
            let envelope = zorid_crypto::seal(&header, &plaintext, &key, &mut SystemEntropy)
                .map_err(|e| e.to_string())?;
            Ok(json!({"wire":envelope.encode()}))
        }
        "open" => {
            let context = text(value, "context")?;
            if context.len() > MAX_CONTROL_BYTES {
                return Err("context too large".into());
            }
            let context: Value =
                serde_json::from_str(context).map_err(|_| "invalid context JSON")?;
            let envelope = Envelope::decode(&bytes(&value["wire"], MAX_WIRE_BYTES)?)
                .map_err(|e| e.to_string())?;
            let plaintext = zorid_crypto::open(&envelope, &expected(&context)?, &key)
                .map_err(|e| e.to_string())?;
            Ok(json!({"plaintext":plaintext.as_slice()}))
        }
        _ => unreachable!(),
    }
}
fn main() {
    // JSON byte arrays take at most four characters per byte plus delimiters.
    const MAX_INPUT: usize = 5 * MAX_WIRE_BYTES + 2 * MAX_HEADER_BYTES + 4096;
    let mut input = Zeroizing::new(Vec::new());
    let response = match io::stdin()
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut input)
    {
        Ok(_) if input.len() <= MAX_INPUT => match serde_json::from_slice::<Value>(&input) {
            Ok(request) => match execute(&request) {
                Ok(result) => json!({"ok":true,"result":result}),
                Err(error) => json!({"ok":false,"error":error}),
            },
            Err(_) => json!({"ok":false,"error":"invalid request JSON"}),
        },
        _ => json!({"ok":false,"error":"input read failed or exceeded fixture bound"}),
    };
    // This is intentional pipe output, not logging; the harness never prints keys.
    println!("{response}");
}
