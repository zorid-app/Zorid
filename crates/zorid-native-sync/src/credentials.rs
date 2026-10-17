use super::{error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Url;
use serde::Deserialize;
use std::{io::Read, path::Path};
use zeroize::{Zeroize, Zeroizing};
use zorid_crypto::VaultKey;
use zorid_sync_protocol::{RealmId, ServerEpoch, VaultId};

const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileCredentials {
    version: u8,
    endpoint: String,
    realm_id: RealmId,
    vault_id: VaultId,
    server_epoch: ServerEpoch,
    key_epoch: u32,
    key_base64: String,
    bearer_token: String,
}
impl Drop for FileCredentials {
    fn drop(&mut self) {
        self.key_base64.zeroize();
        self.bearer_token.zeroize();
    }
}
pub(super) struct Credentials {
    pub endpoint: Url,
    pub realm: RealmId,
    pub vault: VaultId,
    pub server_epoch: ServerEpoch,
    pub key_epoch: u32,
    pub key: VaultKey,
    pub token: Zeroizing<String>,
}
impl Credentials {
    pub fn load(path: &Path, vault_root: &Path) -> Result<Self> {
        let bytes = protected_bytes(path, vault_root)?;
        let mut raw: FileCredentials =
            serde_json::from_slice(&bytes).map_err(|_| error("credentials_invalid"))?;
        if raw.version != 1
            || raw.key_epoch == 0
            || raw.bearer_token.len() != 64
            || !raw
                .bearer_token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(error("credentials_invalid"));
        }
        let endpoint = Url::parse(&raw.endpoint).map_err(|_| error("credentials_invalid"))?;
        // Only literal loopback addresses: no DNS rebinding, proxy, redirect or
        // arbitrary endpoint credential forwarding in this fixture capability.
        let loopback = endpoint
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|ip| ip.is_loopback());
        if endpoint.scheme() != "http"
            || !loopback
            || endpoint.port().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err(error("fixture_endpoint_required"));
        }
        if raw.key_base64.len() != 44 {
            return Err(error("credentials_invalid"));
        }
        let decoded = Zeroizing::new(
            STANDARD
                .decode(&raw.key_base64)
                .map_err(|_| error("credentials_invalid"))?,
        );
        if decoded.len() != 32 || STANDARD.encode(&*decoded) != raw.key_base64 {
            return Err(error("credentials_invalid"));
        }
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&decoded);
        Ok(Self {
            endpoint,
            realm: raw.realm_id.clone(),
            vault: raw.vault_id.clone(),
            server_epoch: raw.server_epoch.clone(),
            key_epoch: raw.key_epoch,
            key: VaultKey::from_bytes(*key),
            token: Zeroizing::new(std::mem::take(&mut raw.bearer_token)),
        })
    }
}
#[cfg(unix)]
fn protected_bytes(path: &Path, vault_root: &Path) -> Result<Zeroizing<Vec<u8>>> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if !path.is_absolute() {
        return Err(error("credentials_permissions"));
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| error("credentials_permissions"))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("credentials_permissions"))?;
    // SAFETY: geteuid has no pointers or preconditions and only reads process ID.
    let owner = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.uid() != owner
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(error("credentials_permissions"));
    }
    if metadata.len() > MAX_CREDENTIAL_BYTES as u64 {
        return Err(error("credentials_limit"));
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| error("credentials_permissions"))?;
    let root = std::fs::canonicalize(vault_root).map_err(|_| error("credentials_permissions"))?;
    if canonical.starts_with(root) {
        return Err(error("credentials_inside_vault"));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_CREDENTIAL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("credentials_io"))?;
    if bytes.len() > MAX_CREDENTIAL_BYTES {
        return Err(error("credentials_limit"));
    }
    Ok(bytes)
}
#[cfg(not(unix))]
fn protected_bytes(_: &Path, _: &Path) -> Result<Zeroizing<Vec<u8>>> {
    Err(error("unsupported_platform"))
}
