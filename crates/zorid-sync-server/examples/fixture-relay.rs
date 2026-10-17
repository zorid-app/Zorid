//! Disposable local integration fixture only. Never production enrollment.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{error::Error, fs::OpenOptions, io::Write, path::Path};
use zeroize::Zeroizing;
use zorid_sync_protocol::{DeviceId, RealmId, VaultId};
use zorid_sync_server::{
    http::{loopback_address, serve_loopback},
    RelayStore,
};

#[derive(Serialize)]
struct Credentials<'a> {
    version: u8,
    endpoint: &'a str,
    realm_id: &'a RealmId,
    vault_id: &'a VaultId,
    server_epoch: &'a zorid_sync_protocol::ServerEpoch,
    key_epoch: u32,
    key_base64: &'a str,
    bearer_token: &'a str,
}
#[cfg(unix)]
fn private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path)
}
#[cfg(not(unix))]
fn private_directory(_: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "fixture credential permissions require Unix",
    ))
}
fn private_json(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // Borrow secrets into serialization; wipe the temporary encoded allocation.
    let bytes = Zeroizing::new(serde_json::to_vec_pretty(value)?);
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if run().await.is_err() {
        // Never interpolate credentials or library diagnostics into output.
        eprintln!("Fixture startup failed. Use: fixture-relay ABSOLUTE_NEW_DIRECTORY PORT EXACT_HTTP_ORIGIN. Existing paths are never replaced; partial fixture directories are retained for inspection.");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("invalid arguments".into());
    }
    let directory = Path::new(&args[0]);
    if !directory.is_absolute() {
        return Err("absolute path required".into());
    }
    let port: u16 = args[1].parse()?;
    let origins = vec![args[2].clone()];
    // create() is nonrecursive and fails for any existing final component,
    // including symlinks. No rollback removes directories or user files.
    private_directory(directory)?;
    let realm = RealmId::new("fixture-realm")?;
    let mut store = RelayStore::open(directory.join("relay.sqlite"), &realm)?;
    let listener = tokio::net::TcpListener::bind(loopback_address(port)).await?;
    let endpoint = format!("http://{}/", listener.local_addr()?);
    let identity = store.identity()?;
    let mut clients = Vec::new();
    for (account, vault_name, devices) in [
        ("account-a", "vault-a", vec!["web", "cli", "desktop"]),
        ("account-b", "vault-b", vec!["cli"]),
    ] {
        let vault = VaultId::new(vault_name)?;
        store.create_account(account)?;
        store.create_vault(&vault)?;
        store.grant_access(account, &vault, true)?;
        let mut key = Zeroizing::new([0u8; 32]);
        getrandom::fill(key.as_mut()).map_err(|_| "entropy unavailable")?;
        let encoded = Zeroizing::new(STANDARD.encode(key.as_ref()));
        for device in devices {
            let device_id = DeviceId::new(format!("{account}-{device}"))?;
            let token = store.issue_device(account, &device_id)?;
            let filename = format!("{account}-{device}.json");
            private_json(
                &directory.join(&filename),
                &Credentials {
                    version: 1,
                    endpoint: &endpoint,
                    realm_id: &realm,
                    vault_id: &vault,
                    server_epoch: &identity.server_epoch,
                    key_epoch: 1,
                    key_base64: &encoded,
                    bearer_token: token.expose_secret(),
                },
            )?;
            clients.push(serde_json::json!({"account":account,"vault_id":vault,
                "device_id":device_id,"credentials_file":filename}));
        }
    }
    // Validate the exact CORS allowlist before publishing the ready manifest.
    // The normal server constructor checks this same configuration when serving.
    // Open a second library handle only for validation; no alternate HTTP server.
    let validation = RelayStore::open(directory.join("relay.sqlite"), &realm)?;
    drop(zorid_sync_server::http::router(validation, &origins)?);
    private_json(
        &directory.join("manifest.json"),
        &serde_json::json!({
            "version":1,"fixture_only":true,"endpoint":endpoint,"realm_id":realm,
            "server_epoch":identity.server_epoch,"origin":origins[0],
            "database_file":"relay.sqlite","clients":clients
        }),
    )?;
    std::fs::File::open(directory)?.sync_all()?;
    println!(
        "Fixture ready: {}",
        directory.join("manifest.json").display()
    );
    serve_loopback(listener, store, &origins).await?;
    Ok(())
}
