# Remote RPC schema and portable validation foundation

Owner `/root/protobuf_schema_sol`, branch `tingkai-c/protobuf-schema-foundation`,
worktree `/Users/ctk/orca/workspaces/Zorid/protobuf-schema-foundation`. Root is sole
main integrator. Root approved exact service/DTO/API names before coupled server,
native and browser owners began implementation. This source changes no runtime
adapter, existing encryption or plaintext codec.

## Frozen transport contract

- New transport major **2**, package `zorid.sync.rpc.v1`, `RelayService` unary
  Hello/Append/Pull. Transport 1 is not silently reinterpreted or used as fallback.
- Existing ZSE1/envelope1, original JSON header AAD and files/Text plaintext remain
  unchanged. Exact envelope bytes are carried in `bytes exact_wire`, never a
  Header re-encoding, ProtoJSON/base64 bridge, or new encryption on uncertain retry.
- Pure `zorid-proto` contains generated portable messages only. Native
  `zorid-sync-rpc` contains checked-in generated Tonic client/server code referencing
  those external portable types. It has no build.rs or ordinary protoc dependency.
  Tonic/tonic-prost/tonic-prost-build pin 0.14.6; Prost/build pin 0.14.4.
- TS module `src/generated/zorid/sync/rpc/v1/relay_pb.ts` exports message schemas and
  the RelayService descriptor. u64 maps to bigint; absence differs from zero/false.
- Mandatory Control messages on every context/reply/cursor; explicit optional
  presence for majors, cursor after, sequence, through, complete and advertised
  caps. Optional info has <=16 distinct nonempty keys, <=128-byte key and <=512-byte
  value, <=4096 decoded known-field control bytes. Features are <=16 distinct
  nonempty ASCII alphanumeric/hyphen/underscore/dot names <=128 bytes; the initial
  understood required-feature set is empty, so every nonempty set rejects.
- Standard protobuf unknown/singular merge rules are intentional for this new
  transport. All future required meaning needs a recognized version/feature.
  A later empty Control cannot erase earlier accumulated required features.

Portable module `zorid_sync_protocol::rpc` owns builders, typed validators and
bounded raw decoding helpers. It returns existing Accepted and transport::Page
values after ordinary domain checks, without claiming authentication/durability.
Hello identity/limits, Accepted target checks and page chain rules share typed
helpers with the legacy JSON decoders. Legacy JSON error precedence/classification
is preserved, including a specific mixed-invalid regression check.

API freeze delivered to all consumer owners:

```text
rpc::hello_request() -> pb::HelloRequest
rpc::validate_hello_request(&pb::HelloRequest) -> Result<()>
rpc::hello_reply(&RealmId,&ServerEpoch) -> pb::HelloReply
rpc::validate_hello_reply(&pb::HelloReply,&RealmId,&ServerEpoch) -> Result<()>
rpc::append_request(&VaultId,&UpdateId,Vec<u8>) -> Result<pb::AppendRequest>
rpc::validate_append_request(pb::AppendRequest) -> Result<Append>
rpc::accepted_reply(&Accepted) -> pb::AcceptedReply
rpc::validate_accepted_reply(pb::AcceptedReply,&VaultId,&UpdateId,&ServerEpoch) -> Result<Accepted>
rpc::pull_request(&VaultId,&Cursor,Option<LogPosition>,usize) -> Result<pb::PullRequest>
rpc::validate_pull_request(pb::PullRequest) -> Result<Pull>
rpc::pull_reply(Vec<(LogPosition,Vec<u8>)>,&Cursor,LogPosition,bool) -> Result<pb::PullReply>
rpc::validate_pull_reply(pb::PullReply,&Cursor,Option<LogPosition>) -> Result<transport::Page>
rpc::decode_hello_reply(&[u8],&RealmId,&ServerEpoch) -> Result<()>
rpc::decode_accepted_reply(&[u8],&VaultId,&UpdateId,&ServerEpoch) -> Result<Accepted>
rpc::decode_pull_reply(&[u8],&Cursor,Option<LogPosition>) -> Result<transport::Page>
rpc::decode_error_detail(&[u8]) -> Result<pb::ErrorDetail>
```

`rpc::Error` aliases existing TransportError with sanitized `.code()`;
ErrorDetail has a bounded finite enum, no human-text decisions. Inbound RPC sequence
positions reject values exceeding SQLite's positive i64 range while retaining
valid zero cursor/through and u64 values above JavaScript's safe-number range.

## Resource policy and observed checks

Raw control methods/error detail cap4096; Append cap1,056,816; Pull reply cap
2,138,208. Native service/browser frame guards must enforce declared method caps
before generated decoding, no compression, and eight server predecode/eight work
permits plus one client decoder in flight. Those runtime guards are owned by the
server/client workers and are not supplied by these portable DTO validators.
Postdecode counts/encoded_len checks do not prevent decoder peak allocations.
See [decoder measurements](rpc-decode-budget.md) for measured amplification and
unresolved production budget/depth/concurrency gates. No custom protobuf scanner
or reflection parser was added to impose the old JSON duplicate policy.

Exclusive slot checks (jobs1; all handles terminal and slot released):

- Generator81259 exit0; checked-in native service references only external pure
  DTOs; standard codegen with pinned Tonic enables markdown cleanup, explaining
  one generated stream doc-comment escape change without semantic changes.
- Protocol3692: **18/18**, including11 RPC and7 legacy JSON checks.
- Pure DTO Rust goldens **5/5**, Node goldens **8/8**, generated native service
  compile, full tsc and exact regeneration all pass (chain30593).
- Official explicit Rust1.95 compiler/installed wasm32 target: pure DTO and
  sync-protocol both compile for WASM in8.88 seconds (3692). Native Tonic service
  is outside that portable graph.
- Decoder67681:9 Rust cases pass with production rejection and zero live tracked
  bytes after drop;10 sequential Node cases pass. See raw evidence and limitations.

Independent source/consumer/lock review passes after restoring legacy error
behavior. Every existing lock package/version/checksum and normalized edge remains;
root adds the13-package native service closure (including workspace crate), and
standalone devtool adds8 packages. New edges on existing packages are only Tonic's
required feature activation and standard generator features. No root-main lock was
edited by this worker; isolated root lock editing was explicitly authorized for
these checks and remains subject to coordinator integration.

Not claimed: integrated server/native/browser runtime, TLS/CORS deployment,
concurrent stress acceptance, actual browser heap peak, mobile, new plaintext
format, or retirement of legacy fixtures/defaults. Future document-codec2/files3/
Text3 remains only the separate mapping proposal.
