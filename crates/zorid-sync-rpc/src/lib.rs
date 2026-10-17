//! Native-only generated service bindings. Portable messages live in zorid-proto.
//! This crate supplies no runtime adapter, authentication or domain validation.
#![cfg(not(target_arch = "wasm32"))]
include!("generated/zorid.sync.rpc.v1.rs");
