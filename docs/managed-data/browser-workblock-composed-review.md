# Browser WorkBlock S/W independent source review

Reviewer: `term_6264f3ce-056a-456b-a675-61661e6aa004`, task
`task_8176a2d58682`, dispatch `ctx_f40cdd944691`.
Review branch/worktree: `managed-browser-wb-review`,
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-review`, base
`22fad1b3c6e082fd72c76e715dcf66f7ff40e19c`.
Only this new review document is owned or changed. No author files, main,
builds, applications, generated assets, or dependencies were modified.

## Authority and exact targets

Read the roadmap execution checkpoint and canonical main contract
`docs/managed-data/browser-workblock-implementation-contract.md` directly from
`/Users/ctk/Projects/Zorid` (the review base predates that document).
Contract SHA-256:
`adc287835bc5e05e649122c3375bc34f54e1f713b440d620421dc390a05bb082`.
Main sampled at `acb04a3cae85e1acee66bfb68026d5dd3a2c35dd`; no main mutation.

- **S source approved:** `79d5a7754171b41960b1667bd031a33ceb0fbe75`,
  the native Limit-parity successor of `88bf6c70307918ea37fddc5ddd7f2a291f7f2c4a`
  through documentation commit `007d6246`. Reviewed the complete new shared
  helper and focused test source against native DTOs and existing domain/admission
  code, then checked the narrow successor diff. No blocking counterexample found.
- **W initial draft witness (superseded by final approval below):** worktree `managed-browser-wb-wasm` was based
  on `22fad1b3c6e082fd72c76e715dcf66f7ff40e19c` with uncommitted W files at the
  initial inspection. Initial
  `workblocks.rs` SHA-256 is
  `e649a0a7a461ee2857abb94ffdfbf193cd5662c4a3de5db225103749c729c15e`;
  `workblocks_tests.rs` SHA-256 is
  `1b7bcd1c3d78b63b3b3cfe269be7f2375644b2fbef976c37292b56153c5cb23b`.
  W composes with S's Limit successor; a clean base without S does not
  supply the referenced `workblock_service` module.

## Source findings and composition checks

No blocking source finding in S or the initially sampled W draft. The following
are bounded source conclusions, not claims that tests or product operations pass.
Line references for W below refer to the sampled draft until the freeze is recorded.

1. **Native DTO/domain compatibility.** S `workblock_service.rs:26–153` retains
   native command serde names, unknown-field rejection, optional create title,
   required nullable title at lines57/92–95, opaque 32-byte revision arrays,
   `start_ms`/`end_ms`/timezone ranges, and the native value/read/page field names.
   The range is an alias to `first_party::Range`, not a second validator. Semantic
   preparation at lines208–230 and view conversion at lines279–289 delegate
   `first_party`, retaining all range/title candidates and structural EntryIds.
   No native source adoption is included. S lines291–295 now match native
   `workblocks.rs:481–485`: invalid row/byte budgets produce Limit, while time
   range validation stays domain-owned. Shared focused fixtures are authored,
   including nullability, remove/re-add tags, conflict candidates and budget cases;
   they have not been compiled or executed by this review.

2. **Original replay and corruption/collision separation.** S lines235–276
   decode/re-encode the retained tuple, validate complete scope and original
   witness, and recover only one matching task_refs Remove with its original
   tags. It never reads current State on replay. Public noncreate witness is
   explicitly associated at lines254–260. W lines42–44 derive create's witness
   from the original empty state and enforce operation=generation. W lines64–72
   require both retained journal fields, call the shared replay helper, then reuse
   `validate_stored_replay_inner` for static operation and canonical receipt
   checks; successful replay returns the original result bytes. Malformed or
   noncanonical retained bytes map to storage_corrupt; valid changed
   target/generation/witness/semantics map to operation_collision. W replay's
   signature has no accepted-state/source/quota facts, so that pure path cannot
   inspect them. This does not prove D calls it before fetching those facts.

3. **Fresh mutation ownership.** W lines76–105 use shared preparation and the
   existing `records::prepare_local_inner`, rather than cloning its authoring
   planner. Lines84–87 reject routing replay through preparation; lines91–92
   give an existing remote operation source collision precedence over stale or
   corrupt accepted state. Facts scope, operation and expected witness are
   associated at lines79–83, and fixed compiled registration is checked at
   lines93–96. Narrow records.rs changes expose existing preparation/replay
   helpers and extract the unchanged snapshot body. No JS semantic command,
   domain validator, new durable journal or alternate outbox is introduced here.
   Host authorization, source/precondition validation and atomic writes remain
   separate D/H obligations; pure W functions are not storage authority.

4. **Snapshot/view/change compatibility.** W lines112–129 use the existing
   registration/admission snapshot path, canonical state hash and projection;
   verify snapshot revision/projection before read conversion; preserve unknown
   unresolved status keys with canonical count strings; and retain absent/deleted
   null blocks. Snapshot field order and string state match native ManagedSnapshot
   (`store/managed_records.rs:68–75`), making the serialized snapshot the byte
   accounting unit. W lines138–141 encode native record_key tuples in Rust,
   preserve change statuses, map operationId to update_id, require increasing
   canonical sequences and keep input after on an empty page. Requested page
   limits and request association still require D/P checks.

5. **Window boundaries.** W lines158–164 bind a continuation to exact query,
   budgets and supplied collection watermark; foreign/reopened/evicted tokens
   expire. Lines176–183 bound rows and snapshot bytes, require advancing canonical
   tuple keys matching snapshot record/generation, charge filtered/deleted rows,
   and delegate all-candidate intersection to the domain. Oversized first row
   returns Limit; later rejected row leaves `after`/counters untouched and marks
   the scan byte-full. Lines185–200 support empty EOF scans, continuation reuse
   and eight-token FIFO eviction; finish is single-use. Lines172/175 fence scans
   synchronously on close. ASCII IDs make Rust tuple ordering agree with the
   private IDB string-tuple order; this does not claim native JSON-key ordering
   or cursor portability. Fresh authoritative watermark checks before and after
   reads are explicitly the host's responsibility (line187); W alone cannot
   prove them, drain ordering or late durable-commit uncertainty.

6. **Error boundary.** W lines13–28 construct structured Rust-selected
   `{code,source,commitUncertain:false}` failures; inline JS only creates the
   exception object. Existing generic planner string errors are translated in
   Rust at lines98–102, not classified by JS. Pure noncommit errors here do not
   establish correct uncertain outcomes for lost/malformed replies, release or
   transaction completion; those remain D/H/P integration gates.

## Evidence limits and remaining gates

This review used read-only source inspection, Git history/diffs and SHA-256
identification. No Rust compilation/tests, generated WASM, browser/IDB, native,
mobile or runtime check ran; authored test assertions are not execution evidence.
No exhaustive re-audit or repeated legacy test suite was performed.

Exact composed source acceptance is recorded below. Separately compile/run the focused S/W fixtures in the
coordinator's serialized resource slot. Actual generated-WASM normal product
Worker/admitted-service/strict-IDB authoring, original replay before current facts,
atomic failure, close/drain/uncertainty and cursor/watermark behavior remain open.
Independent encrypted two-replica offline/restart convergence is another gate;
neither source approval nor native-target WASM-crate tests establishes it. Calendar
rendering/accessibility, mobile and broader browser/network parity remain separate.

## Final W freeze and composed source verdict

**Source approved, no blocking counterexample found:** W
`5f16636c921bbfb446f0de115574df2b9f1fb40e` composed with S
`79d5a7754171b41960b1667bd031a33ceb0fbe75` (S implementation
`88bf6c70307918ea37fddc5ddd7f2a291f7f2c4a` plus Limit successor).
W's branch does not contain S; the integrator must supply those dependencies.
No combined checkout was built or tested by this review. W author supplied its
freeze directly in `msg_70fa27f34130`; coordinator's `msg_e4bfec22482f` explicitly
permits the private canonical key binding and original-witness read-set extension.

Inspected exact committed W source, module declaration, narrow records.rs diff
and focused fixture source after the initial draft. The final delta adds
`expectedRevision` to read-set output (original Rust-calculated mutation witness,
null for nonmutations), `workBlockStorageKey` canonical tuple validation, stronger
unresolved-count validation, storage-corruption classification for malformed
persisted IDs/sequences, and the IDB tuple-order fixture; formatting changes
account for most line movement. No new planner, JS domain clone, dependency or
schema/index/version change is introduced.

Final committed W `workblocks.rs` SHA-256:
`982506899e8dae4046d302b9ee25da0fd4f4906a52c19787452edbb6333c828e`.
Final committed `workblocks_tests.rs` SHA-256:
`5b9edd4eacf04fa8d7ba0ca16e33f4324098d5d1517e3d64a9b250f3411ddcc6`.
These hashes were computed from `git show 5f16636c:<path>`, not dirty files.

Exact final W source anchors replacing initial draft line references:

| Concern | `crates/zorid-wasm/src/workblocks.rs` at final W SHA |
| --- | --- |
| Structured definite-noncommit errors | 13–60 |
| Original create/mutation witness; read-set association | 145–175, 197–244 |
| Journal-only replay and canonical retained receipt validation | 246–280 |
| Facts identity checks, replay exclusion, remote-source collision before restore, shared/generic planner reuse | 282–367 |
| Snapshot/read compatibility and bounded unresolved aggregation | 369–480 |
| Native-shaped monotonic changes | 482–526 |
| Canonical private key validation | 556–569 |
| Exact query/watermark/session binding | 572–644 |
| Bounded scan, first-row Limit, rejected-row nonconsumption | 647–688 |
| Host post-fence responsibility, continuation reuse/eviction, single finish | 690–750 |

The key fixture explicitly uses record IDs `a\"` then `a-`: decoded tuple order
advances even though serialized JSON lexical order reverses. This is the correct
private IDB ordering boundary, not a native cursor equivalence claim. Thirteen
focused W tests are authored; none was compiled or run by this reviewer. All
runtime/generated-WASM/strict-IDB/convergence gates above remain open. The source
verdict is limited to these exact S/W targets and does not approve D/H/P assembly.

## Coordinator narrow tested-delta review (2026-10-18 04:05 UTC)

After original independent S79d5/W5f166 approval, coordinator independently
inspected exact W875275b8 (collection facts camelCase adapter) and62e9691a
(native global Error constructor plus Reflect.set). The first restores the
existing records validator schema without weakening replay equality. The latter
preserves Rust-selected own code/source/commitUncertain fields and removes the
unshipped inline-JS snippet import; it adds no dependency or build-script change.
S11 focused tests passed; W initially11/13 reproduced the adapter defect, then
13/13 passed after correction and again after native-global binding replacement.
These two narrow source deltas are accepted for composed generated-WASM testing;
native-target tests and standalone Node global behavior do not prove actual
wasm32 imports or normal Worker error transport. Those remain explicit gates.
Current assembly source equivalents4309ba7c/f42cc8e7 and result2156fd90 retain
original author SHAs; no broader source approval is inferred for D/H/P uncertainty.
