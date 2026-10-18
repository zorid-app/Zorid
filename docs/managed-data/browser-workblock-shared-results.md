# Browser WorkBlock shared semantics — S source batch

Owner: S, task `task_13dff920a565`, dispatch `ctx_6db88cd21778`, terminal
`term_e356912f-71d3-485f-87f3-bc5012bbb112`.
Branch `tingkai-c/managed-browser-wb-shared`, worktree
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-shared`.
Base `22fad1b3c6e082fd72c76e715dcf66f7ff40e19c`.
Source commit: `88bf6c70` (three scoped Rust files).

## Authority and dependencies

Source grant `msg_4ade4c4e7ada`; restored ownership confirmed by coordinator
`msg_d71a567056ad`. Read the roadmap execution checkpoint, frozen contract and
independent review. Both `/tmp/zorid-browser-workblock-contract.md` and canonical
`/Users/ctk/Projects/Zorid/docs/managed-data/browser-workblock-implementation-contract.md`
hash to `adc287835bc5e05e649122c3375bc34f54e1f713b440d620421dc390a05bb082`.
The initial checkout already retained the three assigned source files dirty;
this dispatch adopted/reviewed them and added three focused regression cases.

W consumes this commit; interface freeze sent directly in `msg_3c78cc1aad25`,
commit sent in `msg_b5abfdc56cc7`, with coordinator copies `msg_3858229edfb4`
and `msg_a5644780aa99`. No native adoption is included. Existing first_party
validators, admission encoding and records state are the only semantic dependencies.

## Frozen API

Module `zorid_records::workblock_service` exports strict native-compatible
`WorkBlockCommand` (including `op`/`may_commit`), `WorkBlockRevision(pub [u8;32])`,
`WorkBlockRange` alias, range/title candidates, value, read and window page DTOs.
`WindowQuery` has public `from`, `until`, `limit`, `bytes` fields.

```rust
fixed_scope(Id, Id, Id, Id) -> records::Result<Scope>
empty_state_bytes(&Scope) -> records::Result<Vec<u8>>
command_for_new(&WorkBlockCommand, Option<&State>) -> ServiceResult<Command>
command_for_replay(&WorkBlockCommand, &Scope, &[u8;32], &[u8]) -> ServiceResult<Command>
read_value(&State) -> records::Result<Option<WorkBlockValue>>
validate_window(&WindowQuery) -> ServiceResult<first_party::Window>
```

`ServiceError` variants: `Domain(records::Error)`, `InvalidRequest`,
`OperationCollision`, `CorruptJournal`, `Limit`. These are pure helper errors;
W owns structured boundary translation. The helper does not hash: W must hash
the original `empty_state_bytes` using the existing digest implementation for
create. Create requires operation=generation. Noncreate replay binds the supplied
original expected witness and the public expectedRevision without rebasing.

Replay canonical-decodes/re-encodes `admission::local_request` and checks the
complete scope, expected witness and semantic command. Remove replay recovers
exactly one matching task_refs Remove and retains its original tags, without
access to accepted state. New removes alone observe accepted history. Read values
preserve every range/title candidate and structural task reference. Window budgets
delegate domain range/intersection validation and enforce 64 rows/1 MiB bounds.

## Verification observed

SOURCE ONLY: no Cargo, Rust compiler, WASM, Vite, browser, native app, dependency
installation or new target cache was run/created. Main was not edited.

- `shasum -a 256 /tmp/zorid-browser-workblock-contract.md`: expected hash above.
- `shasum -a 256 /Users/ctk/Projects/Zorid/docs/managed-data/browser-workblock-implementation-contract.md`:
  same expected hash.
- `git diff --check` and `git diff --cached --check`: exit 0 before source commit.
- Bounded Node source comparison below: exit 0; six native declaration comparisons
  and one required-nullable-title source assertion passed. This is source comparison,
  not Rust serde execution or runtime proof.

```sh
node <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const native = fs.readFileSync('crates/zorid-native/src/workblocks.rs','utf8');
const shared = fs.readFileSync('crates/zorid-records/src/workblock_service.rs','utf8');
function declaration(source, name) {
  const start = source.indexOf(`pub ${name}`);
  assert(start >= 0, name);
  const open = source.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  assert.equal(depth, 0);
  return source.slice(start,end).replaceAll('ManagedRevision','WorkBlockRevision').replace(/\s+/g,'');
}
for (const name of ['enum WorkBlockCommand','struct WorkBlockRangeCandidate','struct WorkBlockTitleCandidate','struct WorkBlockValue','struct WorkBlockRead','struct WorkBlockWindowPage']) {
  assert.equal(declaration(shared,name),declaration(native,name),name);
  console.log(`PASS native source DTO equivalence: ${name}`);
}
assert(shared.includes('title: Option<String>'));
assert.equal((shared.match(/deserialize_with = "required_nullable_title"/g)||[]).length,1);
console.log('PASS one required nullable title deserializer');
NODE
```

Eleven focused Rust tests are authored in `crates/zorid-records/tests/workblock_service.rs`:
strict/native DTOs and title nullability; original empty-state bytes; every
mutation replay; remove/readd/restart tag retention; corruption versus collision;
all conflict candidates/nulls/status counts; window budgets/intersection; domain
delegation/nonmutation rejection; complete-scope/public-witness binding; changed
semantic replay; absent-read/empty-page native serialization.
**They have not been compiled or executed.**

## Remaining gates

Coordinator must grant a concrete load turn and existing target directory before
running `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --test workblock_service -- --test-threads=1`
with an explicitly authorized `CARGO_TARGET_DIR`. No target directory exists in
this worktree; do not use the default command here and create a new cache.
Independent source review and integrated W compatibility remain required.
Normal generated WASM Worker/strict IDB/admitted-service replay and encrypted
two-replica convergence/restart are separate unverified gates. Browser registry
was empty at dispatch; these pure helpers do not establish product activation,
native adoption, migration, mobile, UI or network readiness.

## Narrow budget-error successor

Task `task_7dd803fbd4b9`, dispatch `ctx_4802ee563b4a`, same S owner/worktree.
W identified a concrete error parity mismatch in the source batch: invalid row
or byte budgets returned InvalidRequest. Native
`crates/zorid-native/src/workblocks.rs:482` rejects rows outside 1..64, bytes=0
or bytes above 1024*1024 with `WorkBlockError::Limit` (line483).
Changed only the shared helper return to `ServiceError::Limit` and the existing
focused test's four invalid-budget expectations (0/65 rows; 0/1048577 bytes).
The domain time-range validation and its error remain unchanged.

Verification: `git diff --check` passed; bounded Node source assertions confirmed
the native budget guard/Limit return, shared equivalent guard/Limit return, and
the four focused budget cases' Limit expectation. The Node command read the
three Rust paths with `node:fs` and asserted those exact source snippets with
`node:assert/strict`; it executed no Rust. All eleven Rust tests remain uncompiled
and unexecuted under the active phone17 build restriction. Independent S/W
composition review and the previously recorded runtime gates remain outstanding.
