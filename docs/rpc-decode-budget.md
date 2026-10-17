# RPC decoder measurement harnesses

Owner: `/root/protobuf_schema_sol/schema_review`. Branch
`tingkai-c/rpc-decode-budget`, Orca worktree
`/Users/ctk/orca/workspaces/Zorid/rpc-decode-budget`, stacked from `935b991`.
The examples depend on the coordinator's pending RPC IDL/generated messages and
`zorid-sync-protocol::rpc` module. No manifest or dependency changes are owned here.

Status: source only. No build, install, harness execution or resource measurement
has been performed. These tools do not establish safe production resource bounds.
The coordinator must authorize and serialize execution on the 8 GB machine.

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

No pass/fail memory or timing threshold is approved here. Record compiler/runtime,
architecture, exact cap, case, measurement and failure outcome before selecting
budgets. A 1 MiB cap still allows roughly half a million empty repeated messages;
post-decode count validation does not prevent their allocation. Standard protobuf
merge/unknown policy does not itself enforce collection allocation limits.
