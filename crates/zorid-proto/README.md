# zorid-proto

Pure `no_std` generated protobuf messages from `proto/zorid`. This crate depends
only on the pinned Prost runtime and has no dependency on Zorid domain crates,
filesystem, crypto, database, transport, async runtime, or gRPC.

Ordinary builds consume checked-in generated Rust and TypeScript. To intentionally
regenerate after an IDL change, install the locked JS dependencies and run:

```sh
pnpm proto:generate
pnpm proto:check
```

The explicit development tool in `tools/proto-codegen` has its own committed Cargo
lockfile and pinned compiler. It invokes standard `prost-build` and
`protoc-gen-es` from the same schemas. The generator replaces only its owned
`crates/zorid-proto/src/generated` and `src/generated/zorid` subtrees after both
outputs succeed. This tool is not a dependency of ordinary app builds.

Focused checks:

```sh
cargo test --locked -p zorid-proto
node --test tests/protobuf-interop.test.mjs
```

Generated public structs are untrusted wire data. Bound framed input before
calling a decoder, then check supported schema version/required features and
convert through existing domain validation. In particular, an absent oneof,
missing message, unspecified/unknown enum, invalid ID, non-32-byte digest,
unauthorized locator, oversized chunk, or excessive count is not made valid by a
successful protobuf decode. uint64 values are Rust `u64` and TypeScript `bigint`;
never round them through JS `number`. Current JSON adapters retain decimal strings.

No private verification, sealed-stage or filesystem witness type appears in the
IDL. Stage and read locators must be resolved by the owning admitted store. A
manifest in a response is diagnostic metadata, not proof or commit authority.
Protobuf cannot recreate exact authenticated bytes by semantic re-encoding.
See `docs/protobuf-adoption-plan.md` for rollout and exact-byte commitment gates.
