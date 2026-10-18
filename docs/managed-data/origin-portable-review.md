# Exact portable original-intent source review

Current status: source plus focused13-test execution accepted for the portable
helper slice; see the appended execution review. The initial source-only freeze
below is retained as historical evidence, not the current test status.

Review owner `term_c574699d-e5b7-4c9d-ab3d-66b4688d4e68`, task
`task_f8cb5e1d01da`, dispatch `ctx_600a176f4a90`; isolated branch/worktree
`managed-intent-contract-review`. Only this new report is owned. Coordinator
retains integration; portable implementation owner is
`term_b4d34271-abb5-4b73-b012-71753f74d00b`, original dispatch
`ctx_0bc5a56f4e26`, successor task `task_29b5239d0e87` / dispatch
`ctx_9b1009465858` (coordinator update `msg_26d19328f82b`).

## Verdict and evidence freeze

**Source acceptable as a bounded pure-helper foundation. No blocking source
counterexample found in the assigned three-file change.** This is not compiler,
test, storage, runtime, migration, or product acceptance. All 13 newly authored
tests (5 private unit fixtures plus 8 integration tests) remain unexecuted in this
review. No Cargo, compiler, build, generated WASM, database, browser or app ran;
native NewNote18 held the heavy verification turn. A separately assigned focused
result review is still required before treating those tests as passed.

Exact target `2c18532e630194c1d4eb8222c989ae80ee15beb4` in
`/Users/ctk/orca/workspaces/Zorid/managed-browser-wb-wasm` adds only the two
new files below and `pub mod local_intent;` at `src/lib.rs:6`. Review used committed
Git blobs, not mutable implementation worktree bytes. SHA256:

| Path | SHA256 |
| --- | --- |
| `crates/zorid-records/src/local_intent.rs` | `1248ca6a04f6116d4beda892c3088829b92a9ef43afb9a98349825b2de505b24` |
| `crates/zorid-records/tests/local_intent.rs` | `549fdabd3cf2e0e7d847a0c4dab494b11bd8cca6878be17f61c794632f8d53c6` |
| `crates/zorid-records/src/lib.rs` | `693d7916b5e327c6c44fd429788d098e1fffda1ea85b934da604021e2087dda5` |

Read decision `df204f9a:docs/managed-data/origin-intent-decision.md` and verified
its bytes equal the canonical `/Users/ctk/Projects/Zorid` document. Read recovered
contract `5a176c0e28655f495f645d7323988abb0c64973d` and exact review
`64d0a7925328c18f1df6a5bc2a3374413c879149`, plus canonical roadmap execution
checkpoint through 2026-10-18 04:14 UTC. Supporting reads at the target include
State structural validation, first-party v1 validation, WorkBlock semantic
replay and crate dependency features. Source inspection and report whitespace/
scope verification are the only checks performed.

## Source assessment

Line references below refer to the exact target's `src/local_intent.rs` unless
another path is named.

| Contract concern | Observed source and assessment |
| --- | --- |
| Opaque trusted construction | `ValidatedRegistration` has private declaration/bytes/catalog, no Deserialize and no public arbitrary-catalog constructor. `validate_with_catalog` is private (192); public validation (237) supplies only compiled `first_party::schema()` and owner. Borrowed accessors cannot mutate the stored declaration. `LocalIntentV1` likewise has private fields and no Deserialize; capture/retained validation are its construction paths. These validate structure, not issuance or authority. |
| Full trusted prefix and bounds | Canonical typed decode/re-encode (112) precedes registration use. Registration IDs, lineage format1, nonempty <=16 declarations, <=1MiB total registration bytes, exact catalog prefix, and exact active==last bytes are checked at 192–234. `validate_extension` (258) checks realm/vault/owner/collection and every old declaration byte against the new prefix; downgrade and fork fail. Active versions need not be contiguous: only explicitly certified versions are admitted (283–313), never numeric <=active. |
| Optional-only evolution | `optional_step` (166) validates both declarations, keeps collection/policy, requires increasing versions, compares every old field's full canonical bytes and disallows every newly required field, including Set. Removal, default/nullability/type changes and negative-zero default changes therefore fail. Optional additions may have defaults; they author no migration operations here. |
| Production v1 and private v2 | Only `first_party::schema()` v1 enters public construction. Generic optional-v2/v3/default catalogs occur only within `#[cfg(test)] mod tests` (645 onward), using owner `fixture`. No product v2 field, caller catalog, dependency, manifest, lock, wire, database or index change is added. Existing first-party semantic validation still rejects actual WorkBlock versions other than1. |
| Complete original identity | Private format1 document (335 onward) contains physical authority, capture revision, operation, full Scope (including restores), full canonical original registration string, 32-byte witness, raw Command and optional exact semantic string. Full request bytes are retained. `validate_retained_intent` (560) binds expected authority/scope/ref operation/ref revision, validates historical origin using the trusted catalog, verifies it is a current prefix, then validates the document. A reference alone confers no authority. |
| Raw and semantic binding | Capture (516) validates without `State::prepare`; it preserves original raw command instead of expanding defaults. `validate_raw` (385) uses structural plus existing first-party checks and rejects unknown fields for fresh raw input. Semantic validation (422) requires fixed nonrestore WorkBlock scope, mutation record/generation/operation identity, canonical DTO bytes and existing Rust semantic-to-command/witness equivalence. The transient old tuple passed to `command_for_replay` is not accepted as the new retained format. |
| Retry and removal tags | `require_matching_input` (609) compares scope, operation, original witness, canonical raw command bytes and exact optional semantic bytes, excluding newly read origin. For RemoveRef, existing `command_for_replay` binds task/field and witness while returning retained raw tags rather than rereading state. A different original tag command collides in repeated input/full request comparison. Actual observed-state provenance remains the capture adapter's responsibility. |
| Canonical bytes | Fixed struct serialization and exact re-encoding reject whitespace, reordered document keys, duplicate/unknown fields and alternate retained encodings. BTreeMap fields/object values and current serde_json features (`float_roundtrip`, no target change to features) support recursive sorted keys and signed-zero retention. `optional_step` and repeated-command comparison deliberately use bytes rather than f64 PartialEq. Cross-target golden bytes remain unproved. |
| Old tuple rejection | `IntentDocument` requires format1 and complete origin; canonical decoder targets that struct with deny_unknown_fields. Old scope/witness/command tuples cannot decode through `validate_retained_intent`. **Existing `admission::local_request` and old adapter paths are unchanged**; rejection in this new helper does not remove the old apply bypass. Mandatory coordinated cutover remains required. |
| Replay/fresh ordering | `require_fresh_origin` (598) compares complete current/original registration bytes and returns origin mismatch. Its comment correctly requires exact committed-journal lookup first, and the function performs no preparation. There is no journal lookup or combined ordering-enforcing API in this slice. Adapters must validate current authorization/history, replay exact full committed request first, and invoke freshness only on no-row before state/default/quota preparation. |
| Reserved namespace and key | Guard (139–149) rejects the selected UUID case-insensitively; ordinary UUID validation stays separate. Key (627) is exact bounded realm/vault/owner/collection/operation tuple, deliberately excluding record/generation so changed target cannot evade operation uniqueness. No existing admission/checkpoint API calls this new guard in this commit. Namespace isolation is still future work at every generic claim/load/CAS/list/changes path. |
| Limits and settlement | Constants expose32 live,16MiB live,2MiB request,4096 historical keys and16MiB metadata. Only local registration/request/key/semantic shape limits are enforced here. No issuance, accounting, capacity reservation, checkpoint persistence, tagged settlement, receipt verification, tombstone proof or publication live-head fence exists in this slice. Constants alone establish none of those behaviors. |

## Concrete counterexamples and boundaries

1. **No journal, unchanged empty digest, changed defaults:** unit fixture at701
   constructs v1 empty schema and v2 with an optional default. Empty state bytes
   are equal; retained old intent validates as historical evidence, but
   `require_fresh_origin(current, retained)` rejects. Preparing `Create([])` under
   v2 would add an action; source includes that explicit counterexample. Thus
   origin equality is necessary even if digest matches. The fixture has not run,
   and cannot prove actual storage orders the rejection before preparation.
2. **Committed v1 under v2:** the same freshness helper must not run before exact
   journal replay, or it would incorrectly reject a valid committed retry. This
   commit has no executable journal-first replay test or coordinator helper;
   host ordering is a mandatory later acceptance gate, not a found helper defect.
3. **Remove/re-add:** integration fixture at286 derives original removal tags,
   applies removal then re-adds, and shows a newly derived removal command differs.
   Retained original tags must match and recomputed tags must collide. This tests
   identity intent in source; it does not prove production capture reads tags
   only once or prevents an adapter from recapturing an unresolved operation.
4. **Shape validation is not authentic issuance:** integration fixture at211
   deliberately changes the stored witness to another valid32-byte value and
   obtains a valid document; full request bytes differ and original-input matching
   collides. Likewise a caller can call public capture with a syntactically valid
   invented authority/revision. This is compatible only with the documented
   host-loaded trust boundary: never accept these bytes as renderer authority,
   never infer durable issuance from successful helper validation.
5. **Reserved helper alone is bypassable:** leaving existing generic checkpoint
   paths or generic managed apply available would still permit overwriting pending
   evidence or authoring without retained origin. This commit does not claim to
   solve that. Activation must wait for mandatory no-old-apply-bypass cutover and
   ordinary namespace denial across native/browser admitted paths.

No additional concrete blocker was found within the pure helpers themselves.

## Test gaps and required next evidence

The13 authored tests cover useful pure checks, but compilation and all results
are unknown. The unit test's equal empty bytes are not a host digest test; the
capture state-unchanged integration assertion inspects an unrelated State and
does not instrument absence of preparation. The old-tuple test name mentions
unknown fields but does not actually insert an extra document property. Further
focused coverage should explicitly exercise unknown/duplicate keys, duplicate
nested keys, signed-zero raw-command identity, policy/removal/type/nullability/
default mutations individually, full scope/ref tampering and semantic generation
changes, and exact limit boundaries. Existing annotations/byte checks support
these expectations by inspection; no test result is implied.

Required remaining gates are unchanged from the selected contract:

- Focused bounded Rust result review of the frozen source when assigned; compare
  tested SHA/source and actual output rather than converting authored tests into
  passed tests. Native/generated-WASM canonical golden equivalence separately.
- Real SQLite and generated Rust/WASM plus strict IDB: durable capture response
  loss/restart/reacquisition and immutable original ref, precommit no-journal
  upgrade rejection, separately postcommit lost-ACK historical replay, stale
  authorization rejection, and exact result/payload/sequence identity without
  extra source/state/authored/change/outbox writes.
- Both apply/retire orderings and final exact live-head/current-registration
  publication fence in the same transaction; tagged reconciled-uncommitted vs
  acknowledged-committed behavior; no-row receipt rejection; exact receipt/ref
  checks and lost-settlement-response retry with the same retirement revision,
  no repeated decrement and no extra history revision.
- Actual live-slot/body/historical-key/charged-metadata accounting and reserved
  retirement capacity; reopen validation, corrupt-counter rejection, quota/abort
  uncertainty, permanent tombstones/no ID reuse and no uncertain-intent eviction.
- Every generic namespace/admission/checkpoint path rejects reserved identity;
  ordinary clients still work; old generic managed apply is removed/internalized
  or explicitly restricted to approved new capture flow. No permissive old tuple
  fallback. Product Worker/desktop two-stage capture, stop/drain and recovery need
  composed proof, beyond storage helpers.

No main integration, normal product activation, independent encrypted convergence,
native/mobile interaction, rendered Calendar or unlimited retention claim follows.

## Assigned focused execution review — 2026-10-18 04:21 UTC

Author message `msg_dd069169f8b4` supplies actual focused results after the
coordinator's explicit load checkpoint `msg_aee9c6c6c1c7`. This reviewer read
both actual logs without running Cargo, a compiler or any application.
**The portable source and focused execution evidence are accepted within this
helper scope:5 unit plus8 integration tests passed,13 total,0 failed/ignored/
measured/filtered.** No repair, warning or failed test appears in either log.
This supersedes the initial13-unexecuted status only for this focused slice.

Exact test-only successor
`e19ac3048ac8dd8cbd061ce871e6dac5e854473d` adds assertions within the existing
13 tests; production helper bytes before `#[cfg(test)]` equal2c18532 exactly,
and lib declaration is unchanged. Reviewer independently read the test diff and
compared all three live implementation source files with committed successor
blobs: exact match. Successor file SHA256:

| Path | SHA256 |
| --- | --- |
| `crates/zorid-records/src/local_intent.rs` | `d8f77c2ed11fc39c42626562512b217bf42d4013ed74adcf8b75c2286d8d4cf8` |
| `crates/zorid-records/tests/local_intent.rs` | `c55a9fd642d7427d809dfa957bf0ca2b5c6f376f461d3e8107ea858914cf6ed6` |

Added assertions explicitly cover unknown outer property, duplicate outer,
embedded registration/semantic and nested object keys, signed-zero raw command
identity despite f64 PartialEq, individual incompatible declaration changes,
inclusive byte decoder limits and an exactly1024-byte checkpoint key followed
by a one-byte-over rejection. No blocking test-source issue found. Malformed
input at the byte cap proves inclusive size gating, not successful valid-data
admission at that cap. These additions were nonblocking recommendations, not
new acceptance requirements or permission to broaden the runtime gate.

Author-reported commands (both exit0), executed serially from the implementation
worktree with the same bounded environment:

```sh
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --lib local_intent::tests -- --test-threads=1
PATH=/Users/ctk/Projects/Zorid/tmp/shared-rust-toolchain/toolchains/stable-aarch64-apple-darwin/bin:$PATH CARGO_TARGET_DIR=/Users/ctk/Projects/Zorid/target/stage4-verified CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked -p zorid-records --test local_intent -- --test-threads=1
```

Actual logs identify the expected implementation crate path and binaries;
compilation finished in3.12s/3.32s and test execution in0.03s/0.04s respectively.
Reviewer independently counted/read the named5/8 `ok` cases and final result
lines. Shell exit0 and first-run attribution come from the author's durable
message; this reviewer did not rerun or observe the shell processes live.

| Actual log | SHA256 |
| --- | --- |
| `/tmp/zorid-origin-portable-lib.log` | `6e6c4663dc2bd434b32f4ee521518cd1fb0b5f260530f37384e575a3736027ba` |
| `/tmp/zorid-origin-portable-integration.log` | `2ed1a86c939bd23301ef5bf7eaa20f8640f9c8dac4f95742ed5a175e573da034` |

Author report at34716eea was read as pre-result checkpoint: its historical
unexecuted statements precede the actual logs, so it is not itself current
execution evidence. Final actual-results report
`c248d03f616a63d04d0b72e34fd7d5b67b0f362e` (including a44d5934 execution
record) was then read and agrees with the reviewed source, commands, counts,
timings and hashes. The reviewer also read both persistent implementation
worktree copies under `tmp/origin-portable/local-intent-lib.log` and
`tmp/origin-portable/local-intent-integration.log`: each is byte-identical to
its corresponding original /tmp log and has the same digest above. Installed
toolchain metadata in the report is explicitly attributed to the installer
manifest, not an independently executed version command. Final implementation
worktree status was clean. No adapter source was changed or compiled as part of these
two commands. Every earlier mandatory real SQLite/generated-WASM/strict-IDB,
issuance/accounting/settlement/namespace/no-old-apply-bypass and product transport
gate remains open. Native host unit execution does not establish native storage,
WASM equivalence, integrated product activation or migration readiness.
