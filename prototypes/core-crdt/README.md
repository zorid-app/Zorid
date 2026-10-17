# CRDT interoperability feasibility fixture

This isolated spike checks one plain-text `Y.Text("content")` shared type through
real Yjs and native Yrs implementations. It does not replace the app editor or
establish persistence, network security, or production actor allocation.

## Pinned choices

- `yjs = 13.6.27`, from the stable v13 release line; no v14 dependency.
  [Official manifest](https://github.com/yjs/yjs/blob/v13.6.27/package.json).
- `yrs = 0.28.0`, with `small-client`. The
  [official Yrs documentation](https://docs.rs/yrs/0.28.0/yrs/)
  explicitly describes that feature as required for pre-v14 Yjs compatibility.
- Binary update encoding v1 and v1 state vectors. These are payloads, not our
  future transport, authorization, encryption or durable acknowledgement protocol.
- UTF-16 text offsets explicitly selected in Rust. Yrs defaults to byte offsets;
  JS positions count UTF-16 units. The local wrapper rejects splitting surrogate
  pairs. It does not promise grapheme-cluster-aware editing.

## Run

From the workspace root (coordinate a build slot on the shared machine):

```sh
cargo test -p zorid-crdt -j 1
cargo build -p zorid-crdt --example interop -j 1
npm --prefix prototypes/core-crdt ci --ignore-scripts
npm --prefix prototypes/core-crdt test
```

Set `ZORID_CRDT_INTEROP_BIN` to the built example executable if using a different
Cargo target directory. JavaScript runs the compiled native process repeatedly,
reconstructing replicas from their actual encoded update bytes. No mocked merge
or Rust subprocess running a JS implementation is involved. Number arrays are
fixture serialization only; actual sync should carry binary payloads.

## What must not be inferred

- State-vector equality does **not** mean equal content or no unsent changes:
  deletion-only transactions can leave the insertion state vector unchanged.
  Tests send delete sets even when vectors match. A durable revision/commit ID is
  a separate storage concept.
- Concurrent writers need distinct actor IDs, including desktop and CLI on the
  same device. Hard-coded fixture IDs are not production actor allocation.
- Native and Node convergence does not establish browser/WASM, real editor undo,
  IME, selection, remote-change transaction origins or large-document latency.
- Snapshot replay here is memory reconstruction, not crash-safe storage evidence.
- The wrapper is a feasibility interface. Full snapshots must not replace missing
  pending updates without a defined checkpoint/retention/rejoin policy.
- Malformed-input smoke checks do not prove resistance to adversarial payloads.
  Authentication, bounds, root-type validation and resource limits remain required.

## Observed spike evidence (2026-10-16)

In `spike/core-crdt-interop`, before a root Cargo workspace exists:

```sh
cargo test --offline --manifest-path crates/zorid-crdt/Cargo.toml -j 1 -- --test-threads=1
cargo build --offline --manifest-path crates/zorid-crdt/Cargo.toml --example interop -j 1
ZORID_CRDT_INTEROP_BIN="$PWD/crates/zorid-crdt/target/debug/examples/interop" npm --prefix prototypes/core-crdt test
```

Results: four Rust tests passed, and the live Yjs/native cross-language matrix
passed. Toolchain: Homebrew Rust 1.99.0, Node 26.10.0, npm 12.2.0, macOS arm64.
Initial sandboxed registry access failed DNS; approved network access installed
dependencies, then Rust checks ran offline. No real browser or editor was opened.
Node printed an experimental localStorage warning; the check exited successfully.

`yjs13-fixture.json` is a checked-in v13 compatibility fixture, independently read
by the Rust test. Its producer is `record-fixture.mjs`; normal tests never rewrite
it. Keep old fixtures when upgrading dependencies rather than regenerating away
an incompatibility.
