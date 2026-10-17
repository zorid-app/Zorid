use std::error::Error;
use zorid_sync_protocol::RealmId;
use zorid_sync_server::{
    http::{loopback_address, serve_loopback},
    RelayStore,
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        return Err("usage: zorid-sync-server DATABASE REALM PORT [EXACT_HTTP_ORIGIN ...]; provision fixture accounts with the local library API".into());
    }
    let realm = RealmId::new(args[1].clone())?;
    let store = RelayStore::open(&args[0], &realm)?;
    let listener = tokio::net::TcpListener::bind(loopback_address(args[2].parse()?)).await?;
    eprintln!(
        "Local fixture relay listening on {}",
        listener.local_addr()?
    );
    serve_loopback(listener, store, &args[3..]).await?;
    Ok(())
}
