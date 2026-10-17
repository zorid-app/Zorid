use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use tonic::{Request, Response, Status, transport::Server};
use tower_http::cors::{Any, CorsLayer};

mod pb {
    tonic::include_proto!("zorid.prototype.grpcproof.v1");
}
use pb::proof_service_server::{ProofService, ProofServiceServer};
use pb::{Chunk, OperationRequest, PutRequest, Receipt, WaitRequest, WaitResponse};
const MAX_CHUNK: usize = 128 * 1024;
const MAX_MESSAGE: usize = MAX_CHUNK + 1024;
const MAX_OPERATIONS: usize = 32;
#[derive(Clone)]
struct Stored {
    request: PutRequest,
    receipt: Receipt,
}
#[derive(Default)]
struct Ledger {
    rows: BTreeMap<String, Stored>,
    next: u64,
}
#[derive(Clone, Default)]
struct Proof {
    ledger: Arc<Mutex<Ledger>>,
}
fn operation_id(id: &str) -> Result<(), Status> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Status::invalid_argument(
            "operation_id must be 1–96 ASCII letters, digits, dash or underscore",
        ));
    }
    Ok(())
}
#[tonic::async_trait]
impl ProofService for Proof {
    async fn put(&self, request: Request<PutRequest>) -> Result<Response<Receipt>, Status> {
        let input = request.into_inner();
        operation_id(&input.operation_id)?;
        if input.ciphertext.len() > MAX_CHUNK {
            return Err(Status::resource_exhausted(
                "ciphertext exceeds 128 KiB proof chunk limit",
            ));
        }
        if input.first_response_delay_ms > 5000 {
            return Err(Status::invalid_argument(
                "test response delay exceeds 5000 ms",
            ));
        }
        let digest = Sha256::digest(&input.ciphertext);
        if input.sha256.as_slice() != digest.as_slice() {
            return Err(Status::invalid_argument(
                "sha256 must match exact ciphertext bytes",
            ));
        }
        let receipt = {
            let mut ledger = self.ledger.lock().await;
            if let Some(stored) = ledger.rows.get(&input.operation_id) {
                if stored.request != input {
                    return Err(Status::already_exists(
                        "operation_id belongs to a different exact semantic request",
                    ));
                }
                return Ok(Response::new(stored.receipt.clone()));
            }
            if ledger.rows.len() >= MAX_OPERATIONS {
                return Err(Status::resource_exhausted(
                    "in-memory proof ledger holds at most 32 operations",
                ));
            }
            ledger.next += 1;
            let receipt = Receipt {
                operation_id: input.operation_id.clone(),
                sequence: ledger.next,
                length: input.ciphertext.len() as u64,
                sha256: digest.to_vec(),
                applied_count: 1,
            };
            ledger.rows.insert(
                input.operation_id.clone(),
                Stored {
                    request: input.clone(),
                    receipt: receipt.clone(),
                },
            );
            receipt
        }; // The in-memory mutation precedes delay/cancellation; never hold the lock across sleep.
        if input.first_response_delay_ms != 0 {
            tokio::time::sleep(Duration::from_millis(input.first_response_delay_ms as u64)).await;
        }
        if input.suppress_first_receipt {
            return Err(Status::unavailable(
                "test injected: operation accepted, first receipt intentionally suppressed; query/retry exact operation",
            ));
        }
        Ok(Response::new(receipt))
    }
    async fn get(&self, request: Request<OperationRequest>) -> Result<Response<Chunk>, Status> {
        let id = request.into_inner().operation_id;
        operation_id(&id)?;
        let ledger = self.ledger.lock().await;
        let stored = ledger
            .rows
            .get(&id)
            .ok_or_else(|| Status::not_found("operation not accepted in this process"))?;
        Ok(Response::new(Chunk {
            receipt: Some(stored.receipt.clone()),
            ciphertext: stored.request.ciphertext.clone(),
        }))
    }
    async fn query(&self, request: Request<OperationRequest>) -> Result<Response<Receipt>, Status> {
        let id = request.into_inner().operation_id;
        operation_id(&id)?;
        let ledger = self.ledger.lock().await;
        Ok(Response::new(
            ledger
                .rows
                .get(&id)
                .ok_or_else(|| Status::not_found("operation not accepted in this process"))?
                .receipt
                .clone(),
        ))
    }
    async fn wait(&self, request: Request<WaitRequest>) -> Result<Response<WaitResponse>, Status> {
        let delay = request.into_inner().delay_ms;
        if delay > 5000 {
            return Err(Status::invalid_argument("test delay exceeds 5000 ms"));
        }
        tokio::time::sleep(Duration::from_millis(delay as u64)).await;
        Ok(Response::new(WaitResponse { finished: true }))
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:8792".parse()?;
    let cors = CorsLayer::new()
        .allow_origin("http://127.0.0.1:8793".parse::<tonic::codegen::http::HeaderValue>()?)
        .allow_methods([tonic::codegen::http::Method::POST])
        .allow_headers(Any)
        .expose_headers([
            "grpc-status".parse::<tonic::codegen::http::HeaderName>()?,
            "grpc-message".parse()?,
            "grpc-status-details-bin".parse()?,
        ]);
    let service = ProofServiceServer::new(Proof::default())
        .max_decoding_message_size(MAX_MESSAGE)
        .max_encoding_message_size(MAX_MESSAGE);
    println!(
        "PROTOTYPE ONLY: native gRPC + gRPC-Web on {addr}; in-memory, no authentication or durable ledger"
    );
    Server::builder()
        .accept_http1(true)
        .layer(cors)
        .layer(tonic_web::GrpcWebLayer::new())
        .add_service(service)
        .serve_with_shutdown(addr, async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
