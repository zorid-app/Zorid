# RPC decoder measurement harnesses

Owner: `/root/protobuf_schema_sol/schema_review`. Branch
`tingkai-c/rpc-decode-budget`, Orca worktree
`/Users/ctk/orca/workspaces/Zorid/rpc-decode-budget`, stacked from `935b991`.
The examples depend on the coordinator's pending RPC IDL/generated messages and
`zorid-sync-protocol::rpc` module. No manifest or dependency changes are owned here.

Status: integrated into the schema-owner feature branch as `962459b`, then
formatted and measured in the authorized exclusive slot on 2026-10-17. Results
below describe standard runtime allocations; the initial development budget is accepted below; actual predecode concurrency
guards still require client/server verification.

After integration and generated-source checks, build the Rust example once in the
coordinator's heavy slot, then invoke its binary separately for each listed case:

```sh
CARGO_BUILD_JOBS=1 cargo build --locked -p zorid-sync-protocol --example rpc_decode_budget -j 1
target/debug/examples/rpc_decode_budget --list
target/debug/examples/rpc_decode_budget pull-items
node scripts/measure-rpc-decode-budget.mjs --list
node scripts/measure-rpc-decode-budget.mjs
node --expose-gc scripts/measure-rpc-decode-budget.mjs --case pull-items --iterations 3
```

The Node default runs one fresh child per case sequentially with a 30 second
per-case timeout; `--timeout-ms` adjusts that runner timeout. A directly selected
case requires `--expose-gc`. Rust takes exactly one case per process. Do not run
both harnesses together or eight malicious inputs concurrently without a separate
resource decision. Eight server admission/work permits and one client decoder
remain runtime obligations, not limits enforced by these standalone tools.

Fixtures use only standard generated messages and Prost/protobuf-es encoders.
Counts are fitted to the actual full method frame cap, including wrapper bytes.
Cases cover empty PullItems, empty optional extensions/features inside large
Append/Pull wrappers, packed zero versions, a truncated final field after a large
repeated prefix, and unknown-field repetition. Unknown repetition concatenates
standard encoded HelloReply messages whose tag 9 Control is unknown to PullReply;
it does not implement protobuf tags, decoding or reflection. protobuf-es runs the
unknown fixture with retention enabled and disabled. These malformed/invalid
messages must not reach RelayStore. The Rust companion asserts production domain
validation rejects them; Node reports raw codec behavior only.

Fixture construction/encoding finishes before each decode baseline. Rust's global
System allocator wrapper tracks requested allocation bytes, a conservative peak
that counts old and new blocks together on realloc, total allocation calls and
live bytes after decode and result drop. The live-byte counter assumes one thread
and no release of pre-existing allocations inside the measured region. Input
storage, allocator bookkeeping/fragmentation and resident-memory effects are
excluded; this is not an operating-system hard limit. Validation and result drop
are included after the separate decode timing. Numeric collection lengths and
capacities and actual generated struct sizes help explain allocation growth.

Node warms its generated reader and invokes GC before measuring while retaining
the encoded input. It reports heap/external/array-buffer/RSS snapshots and process
maxRSS in KiB, including pre-decode fixture high-water baseline. Snapshots are not
allocation peaks. maxRSS cannot reset and can be dominated by fixture generation;
a zero high-water delta does not establish zero allocation. Repeated measurements
report retained-memory deltas after GC without asserting a universal GC threshold.
The runtime uses its default 100 depth limit explicitly. It neither performs
production Rust semantic validation nor proves Chrome worker memory behavior.

Before the measurements, no pass/fail threshold was approved. Record compiler/runtime,
architecture, exact cap, case, measurement and failure outcome before selecting
budgets. A 1 MiB cap still allows roughly half a million empty repeated messages;
post-decode count validation does not prevent their allocation. Standard protobuf
merge/unknown policy does not itself enforce collection allocation limits.

## Measured gate — 2026-10-17

Schema-owner job 67681 passed after a measurement-only fix: the first malformed
case retained its Prost error object until function scope end, so 200 bytes were
still live when sampled. Explicitly dropping that error within the measured
region corrected the harness lifetime; all nine Rust cases then pass with zero
tracked live bytes after result/error drop. This was not a production leak fix.
Node's ten fresh-process cases also pass. All cases ran sequentially; no eight-way
malicious decode or actual Chrome heap measurement was performed.

Rust host measurements used the shell's Homebrew compiler (1.99.0); WASM checks
separately use explicit official Rust 1.95.0. JS runtime Node v26.10.0 with pinned
protobuf-es 2.16.0. Full raw observations are preserved in
[the JSON evidence](../verification/rpc-decoder-budget-2026-10-17.json).

| Case | Wire bytes | Rust conservative requested peak | Rust decode ms | Node sampled heap increase | Node decode ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| pull-items | 2,138,207 | 120.00 MiB | 68.24 | 96.32 MiB | 81.09 |
| append-extensions | 1,056,816 | 72.00 MiB | 35.04 | 44.24 MiB | 50.31 |
| pull-extensions | 2,138,208 | 144.00 MiB | 72.41 | 96.37 MiB | 107.50 |
| append-features | 1,056,816 | 36.00 MiB | 38.90 | 23.44 MiB | 33.33 |
| pull-features | 2,138,208 | 72.00 MiB | 79.61 | 28.91 MiB | 79.80 |
| hello-packed | 4,096 | 0.02 MiB | 0.09 | 0.13 MiB | 0.25 |
| reply-packed | 4,096 | 0.02 MiB | 0.09 | 0.17 MiB | 0.32 |
| pull-truncated | 2,138,206 | 120.00 MiB | 77.54 | 96.35 MiB | 75.05 |
| pull-unknown-retain | 2,138,208 | see Rust pull-unknown: 0 | 37.53 | 177.97 MiB | 89.62 |
| pull-unknown-discard | 2,138,208 | see Rust pull-unknown: 0 | 37.53 | 2.70 MiB | 39.03 |

The largest measured conservative Rust allocator peak is about 144 MiB for one
Pull response with empty optional extension messages. Empty PullItems/truncation
reach 120 MiB. An Append's empty extensions reach 72 MiB; multiplying that by eight
predecode permits gives a **576 MiB extrapolation**, excluding framing/input,
allocator overhead and other work. This is not a measured concurrent process peak.
All invalid decoded Rust messages reject through production RPC validators.

Node's largest sampled heap increase is about 178 MiB when retaining repeated
unknown fields; standard unknown discard reduces this fixture to about 2.7 MiB.
Its largest process maxRSS is about 455 MiB and includes pre-measurement fixture
construction, so it is not the decoder's peak RSS. Known empty repeated items and
extensions show about 96 MiB sampled increases. These values exclude the cost of
holding both a Connect-decoded JS object and Rust/WASM validation concurrently.
No Connect decoder option change or production memory budget is implemented here.

Root has now accepted the initial development thresholds below and requires the
supported standard browser unknown-field nonretention option before activation. The harness
proves neither a hard JS allocation bound nor the service's admission enforcement.
Depth/group adversarial tests and concurrent client/server behavior remain joint
activation checks; schema-known message nesting itself is finite and nonrecursive.

## Root-accepted initial development policy

After reviewing these observations on 2026-10-17, root accepts this finite QA
budget for the current new RPC slice:

| Observation/guard | Accepted initial policy |
| --- | --- |
| Browser sampled JS heap increase | <=128 MiB with standard unknown-field nonretention |
| Rust conservative allocator peak per malicious max-sized reply | <=160 MiB |
| Rust conservative allocator peak per malicious max-sized Append | <=80 MiB |
| Decode duration per measured case | <=250 ms |
| Client decoding | One in-flight RPC per browser/CLI client |
| Server admission/work | Eight predecode and eight blocking-work permits |
| Framing | Strict method body/frame caps, no compression |

Root verified the supported Connect-Web 2.2 API
`binaryOptions: { readUnknownFields: false }` and requires the browser owner to use
it. This uses standard protobuf unknown-field ignoring/nonretention, without a
custom parser; the exact raw RPC payload remains available for independent Rust
validation and original ZSE1 bytes remain unchanged. The named retention-enabled
unknown fixture is a comparison, not accepted production browser configuration.
The known-field cases contain no unknown tags, so retention did not contribute to
those measured allocations. Raw evidence accurately retains each actual option.

Observed maxima fit the accepted development thresholds: Rust144 MiB/reply and
72 MiB/Append; known-field JS sampled increase about96 MiB; unknown-discard2.7 MiB;
all decode cases below108 ms. These are measurement acceptance criteria, not a
hard runtime allocator/JS-heap cap or proof of every possible message. The576 MiB
eight-request extrapolation remains unmeasured. Actual admission/one-inflight
enforcement, browser/CLI/server integration and depth/concurrency checks stay
activation gates. No production/mobile resource guarantee follows.

The requested small standard-depth boundary was subsequently checked in 60697:
one Rust and one ES test accept a valid 37-byte shallow unknown-group Hello and
reject a balanced 517-byte,128-group version under the standard 100-depth policy.
See rpc-schema-foundation.md. This closes that initial parser check, without
expanding the resource measurements into a fuzz/security audit or concurrency proof.
