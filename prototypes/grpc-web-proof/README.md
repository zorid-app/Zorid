# Rust + browser gRPC-Web compatibility proof

Owner `/root/default_lifecycle_review_sol`; isolated Orca grpc-web-proof,
branch tingkai-c/grpc-web-proof, base main2ad1712. This is a disposable prototype,
not a production transport selection or a change to the authenticated v2 sync
wire. Current status: independently reviewed source compiled successfully and
actual Chrome/native compatibility checks passed on2026-10-17. Production
activation, durable-ledger integration and other-browser acceptance remain open.

Tonic0.14.6 + tonic-web0.14.6 serve native HTTP/2 gRPC and binary gRPC-Web in the
same Rust process on127.0.0.1:8792. A small static page on127.0.0.1:8793 uses
Connect-ES2.2.0 createGrpcWebTransport and generated Protobuf-ES2.16.0 descriptors.
No Envoy/proxy, grpc-web-text/base64, JSON transport, gRPC browser bidi, auth,
TLS deployment or existing CLI/local IPC change is involved.

The schema and generated TS belong only to this directory. Pins/conventions
match the protobuf foundation: Prost0.14.4, Protobuf-ES/protoc-gen-es2.16.0,
protoc-bin-vendored3.3.0 (protoc36.2), TS uint64 bigint, raw bytes Uint8Array.
Rust service/client code is generated into Cargo OUT_DIR by tonic-prost-build;
no generated foundation tree or root dependency manifest is edited. Standalone
Cargo.lock and package-lock.json capture dependencies.

## Run when the shared heavy slot is granted

Use Node>=22. The system Homebrew protoc is currently broken; use the vendored
compiler path below or another verified protoc36.2. There is no tool install in
these commands. All npm/Cargo commands are run in this directory.

```sh
npm ci
export PROTOC=/Users/ctk/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/protoc-bin-vendored-macos-aarch_64-3.3.0/bin/protoc
npm run build
CARGO_BUILD_JOBS=1 RUSTC=/Users/ctk/.cargo/bin/rustc /Users/ctk/.cargo/bin/cargo build --locked --bins
```

Start target/debug/zorid-grpc-web-proof, then npm run serve. Open
http://127.0.0.1:8793/ in an actual browser and click Run compatibility checks.
With the same server live, target/debug/native-check exercises the generated
native HTTP/2 gRPC client with a128KiB exact round trip and same-operation retry.
Do not overlap browser/OS focus with another owner's CUA pass. Stop both servers
after verification. No tests touch a real vault or send synthetic bytes elsewhere.

## Acceptance checks implemented by the page

- Exact131072-byte synthetic patterned ciphertext upload/download, independently
  hashed browser SHA256 compared with server receipt and returned bytes. These
  bytes are a deterministic fixture, not real encrypted user data.
- Same exact semantic operation retry retains sequence/applied_count=1. Changed
  content with the same operation returns AlreadyExists. Invalid digest returns
  InvalidArgument. Missing operation returns NotFound.
-131073-byte input returns ResourceExhausted before any mutation; Query confirms
  its operation remains absent. Generated server codec also caps whole decoded/
  encoded messages at128KiB+1024 bytes, independently of the application cap.
- Test suppress_first_receipt accepts once, then returns Unavailable without a
  receipt. Query and an identical request recover the same stored receipt.
  This is an intentionally suppressed application receipt, not a measured
  network disconnect. Request fault fields participate in semantic replay checks.
- AbortSignal cancels a waiting call and yields Connect Code.Canceled. Another
  Put commits then delays its first response: Query must observe acceptance before
  the browser aborts; exact retry must recover that accepted receipt. Cancellation
  stops interest/transport, not rollback. Query timing has a finite30-attempt
  bound; RPC deadlines are also bounded.

The ledger holds at most32 operations and disappears when the server exits.
It is not a durable operation ledger, core receipt, vault authorization, upload
stage, encrypted relay, quota policy or restart-recovery implementation. Tonic
cancellation propagation/server handler drop is not inferred merely from a client
Canceled status. No optional server-streaming test is included in this small proof;
browser client-streaming/bidi are outside its scope.

## Official API sources consulted

- [Tonic gRPC-Web README](https://github.com/grpc/grpc-rust/blob/master/tonic-web/README.md):
  direct translation layer and accept_http1 server setup.
- [Tonic gRPC-Web example](https://github.com/grpc/grpc-rust/blob/master/examples/src/grpc-web/server.rs):
  composing CORS with tonic-web and native Tonic service.
- [tonic-prost-build](https://docs.rs/tonic-prost-build/0.14.6/tonic_prost_build/):
  service/message generation using Prost.
- [Connect browser getting started](https://connectrpc.com/docs/web/getting-started/)
  and [gRPC-Web transport source](https://github.com/connectrpc/connect-es/blob/main/packages/connect-web/src/grpc-web-transport.ts):
  generated service descriptor/createClient, binary gRPC-Web, fetch transport.
- [Connect cancellation/timeouts](https://connectrpc.com/docs/web/cancellation-and-timeouts/):
  AbortSignal and typed Canceled/DeadlineExceeded client outcomes.
- [Connect generation](https://connectrpc.com/docs/web/generating-code/):
  Protobuf-ES service/message descriptor generation.

## Verification record

Source83d47e6 plus review followup69c9fa2. Independent source review found no
bounds/retry/cancellation/isolation blockers. Schema-owner compiler correction
was verified directly: vendored protoc-bin-vendored3.3.0 is libprotoc36.2.

Root granted one exclusive heavy/browser slot. Build exec16543 exited0:
TypeScript strict noEmit passed, esbuild251.2KB in153ms, and standalone locked
Rust1.95 two-binary dev build with CARGO_BUILD_JOBS=1 completed in1m43s. No root
or native build ran in parallel. npm install used pinned standalone package-lock;
no pnpm bootstrap or root dependency manifest was changed.

Native endpoint exec85548 on127.0.0.1:8792 and static page exec74725 on8793.
Generated native client exited0, reporting native HTTP/2 gRPC exact128KiB
upload/download and identical receipt retry sequence1.

Actual Chrome tab1268037631 at http://127.0.0.1:8793/ was driven solely through
CUA: opened the page, clicked Run compatibility checks, and observed
`PASS — all compatibility checks` with these result lines:

```text
PASS binary protobuf 131072 bytes upload/download exact SHA256 a11fe18f963518803fbebdaebf4d408609e3a323c70194b3b507d47a392a2496
PASS identical operation retry retains sequence 2 and applied_count=1
PASS wrong ciphertext hash → InvalidArgument
PASS malformed digest → InvalidArgument
PASS same operation with changed bytes → AlreadyExists
PASS 128KiB+1 size rejection → ResourceExhausted
PASS oversized operation remains absent → NotFound
PASS missing operation → NotFound
PASS intentionally suppressed first receipt → Unavailable
PASS suppressed receipt query + exact retry same sequence 3
PASS AbortSignal cancellation → Canceled
PASS cancel after observed acceptance → Canceled, exact retry sequence 4
```

The browser independently SHA256-hashed the returned bytes, compared every byte
with its131072-byte input, and compared full operation ID/sequence/length/hash/
applied-count receipts on retries. The hash also matched an independent Node
crypto calculation. Browser error-log read returned no errors. No browser state
injection or alternate HTTP/JSON client substituted for the generated client.
The injected Unavailable is an application-level suppressed receipt, not a real
socket-drop experiment; the cancellation result does not assert server rollback
or that a handler was dropped.

Built artifact SHA256 values (ignored build outputs, not checked-in binaries):

- dist/main.js:6f8788d1b2367fcb535eeedd9126112efadb25c857b890a632ba0e0636e66b3f
- target/debug/zorid-grpc-web-proof:76f72ae0c0e2db5eb783c98725ae59c5869b5124979764239d34cb7bd2690423
- target/debug/native-check:2f02f5a7659f36e1a00eb9b3d6b916463b69b2e0924bf3b47e452e67be6b99fa

Closed the agent-created Chrome tab. Endpoint85548 gracefully exited0 on Ctrl+C;
static server74725 exited130 on Ctrl+C. No proof servers remain running. The
in-memory ledger was discarded by normal shutdown. This demonstrates one Chrome
binary-gRPC-Web/Tonic/native-gRPC combination, without establishing Safari/Firefox,
TLS/reverse-proxy deployment, production sync wire negotiation, authentication,
E2EE, durable operation replay, process-crash recovery or streamed large files.
