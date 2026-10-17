use std::error::Error;
use zorid_sync_protocol::RealmId;
use zorid_sync_server::{http, rpc, RelayStore};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut args: Vec<_> = std::env::args().skip(1).collect();
    // A named reference mode supports transition fixtures; never auto-fallback.
    let reference = args.first().is_some_and(|arg| arg == "--http1-reference");
    if reference {
        args.remove(0);
    }
    if args.len() < 3 {
        return Err("usage: zorid-sync-server [--http1-reference] DATABASE REALM PORT [EXACT_HTTP_ORIGIN ...]; default transport is gRPC2; provision fixture accounts with the local library API".into());
    }
    let realm = RealmId::new(args[1].clone())?;
    let store = RelayStore::open(&args[0], &realm)?;
    let listener = tokio::net::TcpListener::bind(http::loopback_address(args[2].parse()?)).await?;
    eprintln!(
        "Local fixture relay ({}) listening on {}",
        if reference {
            "HTTP1 reference"
        } else {
            "gRPC2 / binary gRPC-Web"
        },
        listener.local_addr()?
    );
    if reference {
        http::serve_loopback(listener, store, &args[3..]).await?;
    } else {
        rpc::serve_loopback(listener, store, &args[3..]).await?;
    }
    Ok(())
}
