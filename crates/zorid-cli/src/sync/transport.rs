use super::{credentials::Credentials, error, Result};
use reqwest::{
    blocking::{Client, RequestBuilder},
    header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    StatusCode,
};
use std::{io::Read, time::Duration};
use zorid_client_sync::ReceiveCursor;
use zorid_sync_protocol::transport::{
    decode_accepted, decode_hello, decode_page, Page, MAX_ITEMS, MAX_PAGE_JSON,
};
use zorid_sync_protocol::{Cursor, LogPosition, UpdateId, MAX_CONTROL_BYTES, MAX_WIRE_BYTES};
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
        decode_hello(&bytes, &credentials.realm, &credentials.server_epoch)
            .map_err(|e| error(e.code()))?;
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
        decode_accepted(
            &self.request(request, MAX_CONTROL_BYTES)?,
            &self.credentials.vault,
            update,
            &self.credentials.server_epoch,
        )
        .map_err(|e| error(e.code()))?;
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
        decode_page(&bytes, &wire_cursor, through).map_err(|e| error(e.code()))
    }
}
