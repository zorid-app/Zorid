# Protobuf interop fixtures

These small binary vectors are shared by Rust and TypeScript tests. Refresh only
intentionally with `node scripts/generate-proto-fixtures.mjs`, using the standard
pinned protobuf-es encoder after source generation. Both runtime tests decode and
re-encode the same vectors, establishing compatibility for this encoder output.
This does not establish canonical protobuf encoding or permission to reconstruct
accepted authenticated bytes by re-encoding.

- `append.bin`: zero/high-bit raw bytes, owner/operation locator, offset 2^53+1.
  The oversized offset intentionally exercises the codec; domain consumers must
  reject offsets exceeding the file cap before executing a command.
- `begin-empty.bin`: Create oneof and present zero expected length.
- `required-future.bin`: raw decoder exposes unknown required semantics for a
  separate domain validation boundary; the absent command is also invalid there.

These tests do not activate adapters or validate ownership, stages, authenticated
sync ingress, filesystem publication, native UI, or mobile behavior.

RPC vectors additionally cover positive uint64 accepted sequences above 2^53,
present-zero empty snapshots, explicit incomplete false, mandatory empty Control
messages and exact opaque envelope byte carriage. Tiny illustrative wire bodies
in semantic codec fixtures are not authenticated ZSE1 frames or sync ingress proof.

`rpc-hello-groups-8.bin` and `rpc-hello-groups-128.bin` add balanced unknown tag 100
groups to a valid HelloRequest with Control. The standard protobuf-es BinaryWriter
generates them; both stay under 4096 bytes. Shallow groups must decode;128 nested
groups must fail the standard 100-depth decoder policy in Rust/ES. This is a small
parser-boundary check, not exhaustive fuzzing or a security audit.
