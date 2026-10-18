# Structured Yrs feasibility result

2026-10-17 America/Toronto. Exact tested commit:
`aadda86712e6ee39924d82de4899fe8ccc5e368b` (includes `a2702e5f`).

The single synthetic test target passed **12/12** fixtures with Yrs 0.28.0.
This is bounded in-memory representation evidence, not a managed-record product,
wire format, security boundary or persistence implementation.

```sh
RUSTC=/Users/ctk/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc \
RUSTDOC=/Users/ctk/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustdoc \
CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified \
/Users/ctk/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo test \
  --offline --locked -j1 -p zorid-crdt --test managed_record_feasibility \
  -- --test-threads=1
```

Core coordinator granted one exclusive bounded slot in `msg_62205822e454`.
Session50530 exited0; log `/private/tmp/zorid-managed-record-feasibility.log`.
Compilation5.23s, fixture execution0.02s; these are test timings, not product
performance measurements. Slot returned immediately; no native compiler,
application, simulator or real calendar was used.

Observed:

- Field patches preserve independent concurrent edits. Whole atomic object
  replacement and competing nested parent-map creation lose independent values;
  the negative controls demonstrate why those are unsuitable default patches.
- Same-field scalar arbitration follows actor ordering, then causal overwrite;
  this does not establish wall-clock latest, conflict UX or losing-value history.
- One atomic schedule tuple avoids component mixing; independent start/end
  patches can converge to an invalid range. Fixture validation is synthetic,
  without timezone/DST correctness claims.
- Unique add tags and retained observed-removal tags support candidate add-wins
  membership. Stable member identity deduplicates concurrent additions.
- Retained generation tombstones hide deleted records while retaining concurrent
  payload. Distinct restore generation remains separate from late old edits.
- Older allowlisted patches preserve unknown scalar/tuple/set data. Pending
  dependencies survive snapshot reconstruction and resolve on predecessor arrival.
- Structured snapshots remain rejected by the existing plain-text validator.

All permutations of up to four messages, duplicate delivery and snapshot replay
are exercised by private trusted-fixture helpers. They do not enforce admission
against arbitrary raw Yrs writes, safe actor/tag allocation, schema versions,
namespace access, resource bounds, tombstone compaction or conflict archives.
There is no general migration fixture. Durable commit/outbox, exact ciphertext,
shared incoming cursor, native/browser equivalence, subscriptions, restart/crash
and desktop/mobile UI acceptance remain unimplemented by this probe.

Next: review a narrow internal production contract, including field/set/delete
policies and retained conflict history, before assigning production crate and
Store/protocol/browser seams. Keep note/file authority unchanged.
