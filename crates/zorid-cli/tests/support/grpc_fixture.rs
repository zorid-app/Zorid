//! Test-only faults applied after the actual RelayStore RPC adapter completes.
//! Standard Prost decodes the bounded generated DTO; encrypted wire bytes remain
//! unchanged. This is deliberately outside the production transport.
#![allow(dead_code)]
use axum::{
    body::{Body, Bytes},
    response::Response,
};
use http_body_util::{BodyExt, Full, Limited};
use prost::Message;
use zorid_sync_protocol::rpc::{self, pb};

pub fn site(path: &str) -> u8 {
    match path {
        "/zorid.sync.rpc.v1.RelayService/Hello" => 2,
        "/zorid.sync.rpc.v1.RelayService/Pull" => 3,
        "/zorid.sync.rpc.v1.RelayService/Append" => 4,
        _ => panic!("unexpected RPC fixture route"),
    }
}

pub async fn discard_response(response: Response) {
    let _ = Limited::new(response.into_body(), rpc::MAX_PULL_MESSAGE + 5)
        .collect()
        .await
        .unwrap();
}

pub async fn patch_control(response: Response, site: u8, mode: u8) -> Response {
    let (mut parts, body) = response.into_parts();
    let collected = Limited::new(body, rpc::MAX_PULL_MESSAGE + 5)
        .collect()
        .await
        .unwrap();
    let trailers = collected.trailers().cloned();
    assert_eq!(
        trailers
            .as_ref()
            .and_then(|t| t.get("grpc-status"))
            .unwrap(),
        "0"
    );
    let bytes = collected.to_bytes();
    assert!(bytes.len() >= 5);
    assert_eq!(bytes[0], 0, "fixture requires uncompressed unary response");
    let length = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
    assert_eq!(length, bytes.len() - 5);
    let control = pb::Control {
        required_features: if mode == 1 {
            vec![]
        } else {
            vec!["future-required-feature".into()]
        },
        optional_extensions: if mode == 1 {
            vec![pb::InformationalExtension {
                key: "future-hint".into(),
                value: b"ignored".to_vec(),
            }]
        } else {
            vec![]
        },
    };
    let payload = match site {
        2 => {
            let mut reply = pb::HelloReply::decode(&bytes[5..]).unwrap();
            reply.control = Some(control);
            reply.encode_to_vec()
        }
        3 => {
            let mut reply = pb::PullReply::decode(&bytes[5..]).unwrap();
            reply.control = Some(control);
            reply.encode_to_vec()
        }
        4 => {
            let mut reply = pb::AcceptedReply::decode(&bytes[5..]).unwrap();
            reply.control = Some(control);
            reply.encode_to_vec()
        }
        _ => unreachable!(),
    };
    let mut framed = Vec::with_capacity(payload.len() + 5);
    framed.push(0);
    framed.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
    framed.extend_from_slice(&payload);
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    let body = Full::new(Bytes::from(framed)).with_trailers(async move { trailers.map(Ok) });
    Response::from_parts(parts, Body::new(body))
}

/// A five-byte declared oversize frame with no body proves the client checks
/// the length before waiting for or allocating/decoding the advertised message.
pub async fn oversized_prefix(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    let _ = Limited::new(body, rpc::MAX_PULL_MESSAGE + 5)
        .collect()
        .await
        .unwrap();
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    let mut prefix = vec![0];
    prefix.extend_from_slice(&u32::MAX.to_be_bytes());
    Response::from_parts(parts, Body::from(prefix))
}
