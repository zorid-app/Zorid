use super::{credentials::Credentials, error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{
    blocking::{Client, RequestBuilder},
    header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    StatusCode,
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::{io::Read, time::Duration};
use zorid_client_sync::ReceiveCursor;
use zorid_sync_protocol::{
    Accepted, ControlExtensions, Cursor, LogPosition, RealmId, ServerEpoch, UpdateId,
    MAX_CONTROL_BYTES, MAX_WIRE_BYTES,
};
const MAX_ITEMS: usize = 64;
const MAX_PAGE_WIRE: usize = 2 * MAX_WIRE_BYTES;
const MAX_PAGE_JSON: usize = 4 * MAX_PAGE_WIRE.div_ceil(3) + 32 * 1024;
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
pub(super) struct Item {
    pub sequence: LogPosition,
    pub wire: Vec<u8>,
}
pub(super) struct Page {
    pub items: Vec<Item>,
    pub through: LogPosition,
    pub complete: bool,
}
pub(super) struct Relay<'a> {
    client: Client,
    credentials: &'a Credentials,
}
impl<'a> Relay<'a> {
    pub fn connect(credentials: &'a Credentials) -> Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .http1_only()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .build()
            .map_err(|_| error("sync_transport"))?;
        let relay = Self {
            client,
            credentials,
        };
        let bytes = relay.request(relay.client.get(relay.url("/v1/hello")?), MAX_CONTROL_BYTES)?;
        let hello: Hello =
            serde_json::from_slice(&bytes).map_err(|_| error("sync_invalid_response"))?;
        extensions(&hello.extensions)?;
        if hello.realm_id != credentials.realm || hello.server_epoch != credentials.server_epoch {
            return Err(error("sync_epoch_or_realm_mismatch"));
        }
        if zorid_sync_protocol::negotiate_transport(&hello.transport_versions).is_err()
            || hello.envelope_versions.len() > 16
            || !hello.envelope_versions.contains(&1)
            || hello.suite != "xchacha20poly1305"
            || hello.max_wire_bytes != MAX_WIRE_BYTES
            || hello.max_page_bytes != MAX_PAGE_WIRE
            || hello.max_page_items != MAX_ITEMS
        {
            return Err(error("sync_unsupported_protocol"));
        }
        Ok(relay)
    }
    fn url(&self, path: &str) -> Result<reqwest::Url> {
        self.credentials
            .endpoint
            .join(path)
            .map_err(|_| error("sync_transport"))
    }
    fn authorized(&self, request: RequestBuilder) -> Result<RequestBuilder> {
        let mut value = HeaderValue::from_str(&format!("Bearer {}", &*self.credentials.token))
            .map_err(|_| error("credentials_invalid"))?;
        value.set_sensitive(true);
        Ok(request.header(AUTHORIZATION, value))
    }
    fn request(&self, request: RequestBuilder, limit: usize) -> Result<Vec<u8>> {
        let response = request.send().map_err(|_| error("sync_transport"))?;
        if response.status() != StatusCode::OK {
            return Err(error(match response.status().as_u16() {
                401 | 403 => "sync_authorization_failed",
                409 => "sync_relay_conflict",
                413 => "sync_limit",
                _ => "sync_transport",
            }));
        }
        if response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v.split(';').next() != Some("application/json"))
        {
            return Err(error("sync_invalid_response"));
        }
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err(error("sync_response_limit"));
        }
        // Never use Response::json()/bytes(): Content-Length may be absent or
        // incorrect. Bound decoded transport bytes before JSON/base64 allocation.
        let mut bytes = Vec::new();
        response
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("sync_transport"))?;
        if bytes.len() > limit {
            return Err(error("sync_response_limit"));
        }
        Ok(bytes)
    }
    pub fn push(&self, update: &UpdateId, wire: &[u8]) -> Result<()> {
        if wire.len() > MAX_WIRE_BYTES {
            return Err(error("sync_limit"));
        }
        let url = self.url(&format!(
            "/v1/vaults/{}/updates/{}",
            self.credentials.vault.as_str(),
            update.as_str()
        ))?;
        let request = self.authorized(
            self.client
                .put(url)
                .header(CONTENT_TYPE, "application/octet-stream")
                .body(wire.to_vec()),
        )?;
        let accepted = Accepted::decode(&self.request(request, MAX_CONTROL_BYTES)?)
            .map_err(|_| error("sync_invalid_ack"))?;
        accepted
            .check_target(
                &self.credentials.vault,
                update,
                &self.credentials.server_epoch,
            )
            .map_err(|_| error("sync_invalid_ack"))?;
        Ok(())
    }
    pub fn pull(&self, cursor: &ReceiveCursor, through: Option<LogPosition>) -> Result<Page> {
        let wire_cursor = Cursor::new(cursor.server_epoch.clone(), cursor.after);
        let encoded =
            serde_json::to_string(&wire_cursor).map_err(|_| error("sync_invalid_cursor"))?;
        let mut url = self.url(&format!(
            "/v1/vaults/{}/updates",
            self.credentials.vault.as_str()
        ))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("cursor", &encoded)
                .append_pair("limit", &MAX_ITEMS.to_string());
            if let Some(through) = through {
                query.append_pair("through", &through.get().to_string());
            }
        }
        let bytes = self.request(self.authorized(self.client.get(url))?, MAX_PAGE_JSON)?;
        decode_page(&bytes, cursor, through)
    }
}
fn decode_page(bytes: &[u8], cursor: &ReceiveCursor, through: Option<LogPosition>) -> Result<Page> {
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
    fn cursor() -> ReceiveCursor {
        ReceiveCursor {
            realm_id: RealmId::new("realm").unwrap(),
            vault_id: zorid_sync_protocol::VaultId::new("vault").unwrap(),
            server_epoch: ServerEpoch::new("epoch").unwrap(),
            after: LogPosition::new(0),
        }
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
}
