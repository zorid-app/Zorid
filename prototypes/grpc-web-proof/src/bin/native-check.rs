use sha2::{Digest, Sha256};
mod pb {
    tonic::include_proto!("zorid.prototype.grpcproof.v1");
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client =
        pb::proof_service_client::ProofServiceClient::connect("http://127.0.0.1:8792").await?;
    let bytes: Vec<u8> = (0..128 * 1024)
        .map(|i| ((i * 31 + 17) % 256) as u8)
        .collect();
    let digest = Sha256::digest(&bytes).to_vec();
    let input = pb::PutRequest {
        operation_id: "native-grpc-proof".into(),
        ciphertext: bytes.clone(),
        sha256: digest.clone(),
        suppress_first_receipt: false,
        first_response_delay_ms: 0,
    };
    let first = client.put(input.clone()).await?.into_inner();
    let retry = client.put(input).await?.into_inner();
    assert_eq!(first, retry);
    assert_eq!(first.applied_count, 1);
    let read = client
        .get(pb::OperationRequest {
            operation_id: first.operation_id,
        })
        .await?
        .into_inner();
    assert_eq!(read.ciphertext, bytes);
    assert_eq!(read.receipt.unwrap().sha256, digest);
    println!(
        "PASS native HTTP/2 gRPC exact 128 KiB upload/download + exact retry sequence {}",
        retry.sequence
    );
    Ok(())
}
