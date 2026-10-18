# Browser WorkBlock private WASM — W source batch

Latest successor: focused native-target S11 and W13 tests now executed and pass,
with W replay-adapter correction `875275b8` and native-global error binding
successor `62e9691a`. The source-only/unexecuted statements below describe the
original dispatch; the successor evidence at the end supersedes them only for
these exact focused native-target checks. Generated WASM/runtime gates remain open.

Owner W, task `task_9e5cec876c15`, dispatch `ctx_9dc315f51bc7`, terminal
`term_b4d34271-abb5-4b73-b012-71753f74d00b`. Isolated branch
`tingkai-c/managed-browser-wb-wasm`, worktree
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-wasm`, base
`22fad1b3c6e082fd72c76e715dcf66f7ff40e19c`. Main was not edited. W source commit:
`5f16636c921bbfb446f0de115574df2b9f1fb40e` (four scoped Rust files).

## Authority and dependency

Exact source grant `msg_4ade4c4e7ada`, restored by coordinator `msg_b36df8d44a56`.
Read the execution checkpoint, frozen contract and independent contract review.
Contract `/tmp/zorid-browser-workblock-contract.md` SHA-256:
`adc287835bc5e05e649122c3375bc34f54e1f713b440d620421dc390a05bb082`.
Initial checkout already retained assigned workblocks/lib/records source edits;
this dispatch inspected, adopted and completed those edits. No other session's
files were reset, stashed, cleaned or committed.

Requires S shared helper source commits `88bf6c70`, then `79d5a775`, before W. All public command,
revision, read and window DTOs use `zorid_records::workblock_service`; W does not
create a second public DTO set. S's original window-budget error was
`InvalidRequest`, whereas native exposes `Limit`; S correction `79d5a775` resolves
this finding. W does not locally duplicate that predicate. Source-only validation restriction remained in effect until
an explicit concrete load grant. No dependency, lockfile, database/index/wire,
migration/lineage, storage JS, UI, native or mobile changes are included.

## Implementation

- Fixed compiled identity/registration and strict read sets, including the private
  Rust-computed original expectedRevision for exact host facts; caller cannot supply
  owner, collection, schema or restores through command DTOs. Requests max16KiB.
- Exact replay checks the original journal and result without accepted state,
  source, restore or quota facts. Both absent returns undefined; one absent is
  corruption. Canonical original remove tags come from the shared helper.
- New mutation preparation delegates to existing RecordsPlan, preserving its
  checkPreconditions, payload, bindings, state/projection, localRequest and
  existing finalization format. Create hashes original empty-state bytes, never
  current accepted state. Noncreate retains original witness. Remote source ID
  reuse without a local journal returns operation_collision before stale-state
  preparation; no new local receipt is authored for a remote operation.
- Narrow `records.rs` reuse exposes prepare_local_inner and
  validate_stored_replay_inner and extracts the existing recordsSnapshot body
  unchanged into snapshot_inner. Generic planner/storage behavior is unchanged.
- Rust serializes native-shaped ManagedSnapshot, reads, change tuples and window
  pages. Snapshots preserve all candidates and structural references and count
  unknown unresolved status keys with canonical decimal strings. Change identity
  is stored operationId; next is final sequence or input after for empty pages.
- Structured Error objects carry Rust-selected code/source/commitUncertain via
  a minimal wasm-bindgen inline JS exception constructor, with no new dependency.
  All pure rejections are definite noncommit. The host owns uncertainty after a
  transaction may have committed.
- Window session retains at most8 cursor entries tied to exact query/budgets,
  consumed IDB tuple key, watermark and lifetime. It delegates domain window
  validation/intersection, counts filtered/deleted row bytes, leaves oversized
  next rows unconsumed, rejects an oversized first row, preserves deterministic
  cursor reuse and evicts oldest entries. Session close fences outstanding scans.

Private additions for the concrete D/W storage seam: readSet returns
`expectedRevision` (opaque original 32-byte witness on mutations, null otherwise),
and `workBlockStorageKey(keyJson):string` validates exact canonical tuple JSON
and returns it unchanged. D copies this witness into existing facts.local and
uses the key codec for input and stored-row positions. Neither is a public
storage authority or wire/database version change.
Coordinator confirmed the exact D/W freeze in the second ask reply and forwarded
the same confirmation to D. Source was sent to independent reviewer dispatch
`ctx_f40cdd944691` in `msg_70fa27f34130`, with explicit S dependency and no-runtime
limitations; that source review is still outstanding at this handoff.

`begin` accepts native command JSON `{op:"window",fromMs,untilMs,limit,byteLimit,cursor}`.
Enrollment JSON is `{realm_id,vault_id}`. Unresolved metadata is
`[{updateId,status,revision}]`; changes rows are
`[{sequence,status,record,generation,operationId}]`. `afterKeyJson` is canonical
private `[record,generation]`, ordered by decoded IDB tuple components, never
native JSON-string lexical ordering. The host supplies a fresh opaque token only
when continuation needs one. Existing tokens can be reused without a new token.

Authoritative collection watermark checks before and after scanning remain the
host's responsibility: finish must only publish after the fresh post-fence.
The WASM signature has no authoritative storage access and cannot establish a
post-read fence itself. This batch makes no such runtime claim.

## Focused verification

`git diff --check`: exit0 during source preparation.

Bounded Node source check executed the actual inline exception constructor in
`node:vm` for invalid_request/operation_collision/storage_corrupt/limit, confirming
own code/source/commitUncertain fields and false uncertainty. The final run also checked ten
required private JS-name declarations and absence of storage/network code.
These source checks are not Rust typechecking or WASM execution.

Thirteen focused Rust tests are authored in `workblocks_tests.rs`: fixed authority
and read-set bounds; generic planner byte equivalence and original create witness;
exact replay and half/corrupt journal; remove/readd original tags; all range
conflicts and unknown statuses; absent/deleted/corrupt snapshots; native change
identity/monotonic next; byte rejection/nonconsumption; filtered/deleted row costs;
cursor query/watermark/lifetime/reuse/eviction; canonical key association/repeated
finish; remote-authored identity collision precedence; and decoded IDB tuple ordering when JSON escaping
reverses string lexical order. **None has been compiled or executed.**

Coordinator explicitly answered the validation question with source-only delivery
while native phone17 build is live. Only rustfmt on owned files was authorized;
Cargo/compiler/WASM/runtime gates remain deferred. Executed successfully:

```sh
rustfmt --edition 2021 --config skip_children=true crates/zorid-wasm/src/workblocks.rs crates/zorid-wasm/src/workblocks_tests.rs crates/zorid-wasm/src/records.rs
```

An unrelated baseline-only formatter hunk in records.rs was restored manually;
its final diff is only the three reuse hunks described above. No module children
outside ownership were formatted. No compiler, dependency install, app, new
target cache or deletion of another owner's artifact occurred.

Deferred exact focused command, requiring a fresh coordinated load turn after
composing the stated S dependencies:

```sh
CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-wasm workblocks::tests -- --test-threads=1
```

This command has **not** been executed by W.

## Remaining gates

Independent source review and focused Rust compilation/test execution are required
before source acceptance. Generated WASM and the normal admitted Worker with
fixed registry and strict IDB remain separately required; unit tests do not
establish browser activation. Actual durable exact-replay/no-extra-ledger-row,
release/drain/uncertainty and authoritative watermark fencing must be tested
through storage/host integration. Two independently persisted normal Workers must
then prove common encrypted sync convergence/restart, no echo and outbox/cursor
witnesses. Native, desktop, mobile, Calendar UI and reference parity are unproved
by this batch. No app/browser/build process was launched for those gates.

## Historical bounded source check at 5f16636c

Final formatted source check returned three PASS lines, exit0. The earlier
nine-name check preceded the private storage-key seam; the final check covers ten.

```sh
node <<'NODE'
const fs=require('node:fs');const assert=require('node:assert/strict');const vm=require('node:vm');
const source=fs.readFileSync('crates/zorid-wasm/src/workblocks.rs','utf8');
const match=source.match(/inline_js = ("(?:[^"\\]|\\.)*")/);assert(match);
const bridge=JSON.parse(match[1]).replace('export function','function');const context={};vm.createContext(context);vm.runInContext(bridge,context);
for(const code of ['invalid_request','operation_collision','storage_corrupt','limit']){
 const error=context.workBlockFailure(code,'workblocks',false);assert.equal(error.code,code);assert.equal(error.source,'workblocks');assert.equal(error.commitUncertain,false);assert(Object.hasOwn(error,'code'));assert(Object.hasOwn(error,'commitUncertain'));
}
console.log('PASS actual inline error bridge: structured own fields, four error codes');
for(const name of ['workBlockIdentity','workBlockRegistration','workBlockReadSet','workBlockReplay','prepareWorkBlockLocal','workBlockSnapshot','workBlockRead','workBlockChanges','workBlockStorageKey','afterKeyJson'])assert.match(source,new RegExp('js_name\\s*=\\s*'+name+'[)\\]]'));
console.log('PASS ten required private JS-name declarations');
assert(!/web_sys|indexedDB|localStorage|fetch\(/.test(source));console.log('PASS no storage/network implementation introduced in WASM');
NODE
rustfmt --check --edition 2021 --config skip_children=true crates/zorid-wasm/src/workblocks.rs crates/zorid-wasm/src/workblocks_tests.rs
git diff --check
```

The formatter check returned exit0 for both new Rust files. Rustfmt parsing is
not Rust typechecking, test execution, generated-binding validation or runtime proof.

## Focused compile successor — 2026-10-18 04:04 UTC

Task `task_40ce54fa2d7a`, dispatch `ctx_0279034d3d5f`, same terminal/worktree.
Coordinator grants only S11 and W13 focused native-target tests using existing
toolchain/target, single job, offline/locked, nonincremental and one test thread.
Independent exact source approval before compilation: `5557f3b7` for original
S88bf6c70+79d5a775/W5f16636c composition. No main edit occurred.

Reviewed S dependencies were cherry-picked without independently editing S:

- `88bf6c70` became `d3731660`.
- `79d5a775` became `794279e1`; its optional results document had a modify/delete
  conflict because report007d6246 was not selected. Retained the exact final S
  report from79d5a775 and continued; no S source adjustment was made.

Exact executed commands (all sequential):

```sh
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --test workblock_service -- --test-threads=1
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-wasm workblocks::tests -- --test-threads=1
```

| Run | Exact source outcome | Observed result |
| --- | --- | --- |
| S focused | reviewed S source, W branch composed | exit0,11 passed,0 failed,0 filtered; build5.68s/tests0.01s |
| W initial | original W5f16636c plus S | compile succeeded, exit101,11 passed/2 failed,67 filtered; build18.79s/tests0.02s |
| W after replay fix | W875275b8 plus S | exit0,13 passed,0 failed,67 filtered; build5.77s/tests0.02s |
| W final | W62e9691a plus S | exit0,13 passed,0 failed,67 filtered; build7.37s/tests0.02s |

The W command above was run three times with identical arguments/environment:
initial execution, necessary correction verification, and verification after the
coordinator's native-global error-binding successor. No S rerun was necessary
because S source did not change. Unrelated existing warnings were29 in
zorid-bases and one unused field in WASM streaming plan; no WorkBlock warning
or compiler error was emitted. No full suite was run.

### Actual replay failure and correction

The two initial failures were
`exact_replay_returns_retained_receipt_without_current_state_facts` and
`remove_replay_keeps_original_tags_after_readd`, both returning storage_corrupt.
W passed snake_case realm_id/vault_id to the reused generic records collection
validator, whose existing CollectionScope serde requires camelCase realmId/vaultId.
Enrollment input remains snake_case by its separate contract. Source correction
`875275b879a621eecce9a3500e3ea8fab04ddb4b` changes only that adapter's two keys
and adds an explanatory comment. Both existing meaningful replay tests then pass;
the fix does not bypass validation, alter the stored journal, recompute remove
tags or change the planner. Tests were not weakened or replaced.

### Packaging inspection and native-global successor

Source inspection found scripts/build-core-wasm.cjs artifactDigests/cache metadata
only hash zorid_wasm.js and zorid_wasm_bg.wasm; scripts/core-wasm-assets-plugin.cjs
only reads, emits and manifests those two assets. An inline_js snippet's separate
import would be omitted/unhashed. Reported in `msg_0771e69a0b7b`; coordinator
confirmed and granted the W-only native-global alternative in `msg_b4226f5060eb`.
No build script, manifest, dependency or runtime API was edited.

Source successor `62e9691a286ddafe0c716163f6c58517a775f282` removes inline_js and
binds native global Error constructor plus Reflect.set using existing
wasm-bindgen. Rust still selects code, source and false commitUncertain; the
imports only construct and populate the Error. This avoids W's separate snippet
dependency. Native-target typechecking accepts the binding declarations, and
all13 W tests pass on this exact successor.

Executed bounded Node source/global behavior check, exit0, two PASS lines:

```sh
node <<'NODE'
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('crates/zorid-wasm/src/workblocks.rs','utf8');
assert(!source.includes('inline_js'));
assert.match(source,/js_name = Error\)\]\s*type WorkBlockJsError/);
assert.match(source,/constructor, js_class = "Error"/);
assert.match(source,/js_namespace = Reflect, js_name = set/);
for(const code of ['invalid_request','operation_collision','storage_corrupt','limit']) {
 const error=new Error(code);
 for(const [name,value] of [['code',code],['source','workblocks'],['commitUncertain',false]]) {
  assert.equal(Reflect.set(error,name,value),true);assert.equal(error[name],value);
  const descriptor=Object.getOwnPropertyDescriptor(error,name);assert(descriptor);assert.equal(descriptor.enumerable,true);
 }
 assert(error instanceof Error);assert.equal(error.message,code);
}
console.log('PASS native Error/Reflect.set behavior: four codes, three own enumerable fields each');
console.log('PASS source binds only native globals with no inline_js snippet');
NODE
```

This verifies the actual native JS primitives used by the declarations, not the
unbuilt generated wasm-bindgen glue. Coordinator still owns serialized wasm32
joint assembly/build; inspect its generated imports and invoke a generated
WorkBlock rejection to confirm own structured fields before normal Worker proof.
No wasm32 build, bindgen generation, app, browser, Vite, install, new target/cache
or artifact deletion was run by this successor. Existing authorized target was
updated only by the focused tests. All compiler/test processes have exited;
launch/end were reported in msg_ffeb24e24b1f/msg_72f1808ca1ab and
msg_267764d404bf/msg_99e99c2d975a.

The small875275b8/62e9691a deltas require final independent review against the
original source approval. Normal admitted Worker/strict-IDB durable atomicity,
authoritative pre/post watermark fences, release/uncertainty, generated structured
errors, and independent encrypted convergence/restart remain unverified. Passing
24 focused native-target cases does not establish browser or network runtime proof.
