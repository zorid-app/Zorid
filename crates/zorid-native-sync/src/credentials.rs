use super::{error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::{io::Read, path::Path};
use url::Url;
use zeroize::{Zeroize, Zeroizing};
use zorid_crypto::VaultKey;
use zorid_sync_protocol::{RealmId, ServerEpoch, VaultId};

const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileCredentials {
    version: u8,
    transport: String,
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
        if raw.version != 2
            || raw.transport != "grpc"
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::os::unix::fs::PermissionsExt;

    fn config() -> Value {
        json!({"version":2,"transport":"grpc","endpoint":"http://127.0.0.1:43210/",
            "realm_id":"realm","vault_id":"vault","server_epoch":"epoch","key_epoch":1,
            "key_base64":STANDARD.encode([7u8;32]),"bearer_token":"a".repeat(64)})
    }
    fn load(value: &Value) -> Result<Credentials> {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        std::fs::create_dir(&root).unwrap();
        let path = temp.path().join("credentials.json");
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        Credentials::load(&path, &root)
    }
    #[test]
    fn grpc_config_requires_an_explicit_new_version_and_transport() {
        assert!(load(&config()).is_ok());
        for version in [0, 1, 3] {
            let mut value = config();
            value["version"] = json!(version);
            assert_eq!(load(&value).err().unwrap().code(), "credentials_invalid");
        }
        for transport in ["http", "http1", "grpc-web", "GRPC", ""] {
            let mut value = config();
            value["transport"] = json!(transport);
            assert_eq!(load(&value).err().unwrap().code(), "credentials_invalid");
        }
        let mut value = config();
        value.as_object_mut().unwrap().remove("transport");
        assert_eq!(load(&value).err().unwrap().code(), "credentials_invalid");
    }
    #[test]
    fn endpoint_is_literal_loopback_with_no_forwarding_target_components() {
        for endpoint in ["http://[::1]:43210/", "http://127.0.0.2:43210/"] {
            let mut value = config();
            value["endpoint"] = json!(endpoint);
            assert!(load(&value).is_ok());
        }
        for endpoint in [
            "http://localhost:43210/",
            "https://127.0.0.1:43210/",
            "http://192.0.2.1:43210/",
            "http://127.0.0.1/",
            "http://127.0.0.1:43210/path",
            "http://user@127.0.0.1:43210/",
            "http://127.0.0.1:43210/?next=elsewhere",
            "http://127.0.0.1:43210/#fragment",
        ] {
            let mut value = config();
            value["endpoint"] = json!(endpoint);
            assert_eq!(
                load(&value).err().unwrap().code(),
                "fixture_endpoint_required"
            );
        }
    }
    #[test]
    fn failed_connect_inside_existing_runtime_drops_its_worker_safely() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let mut value = config();
        value["endpoint"] = json!(format!("http://{address}/"));
        let credentials = load(&value).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert_eq!(
                crate::transport::Relay::connect(&credentials)
                    .err()
                    .unwrap()
                    .code(),
                "sync_transport"
            );
        });
    }
}
