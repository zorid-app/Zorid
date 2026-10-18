# Actual Electron WorkBlock bridge/storage verification

Owner: worker `term_dcd608f8-cbcf-41d1-930b-c098d80659ac`, task
`task_0439dfd1fbe6`, dispatch `ctx_689388f73d04`. Initial scope was only new
`tests/workblock-electron-integration/**` and this report on isolated binding
branch `tingkai-c/managed-workblock-desktop-binding`.

The preceding accepted desktop binding source remains frozen at `313e9964`
with report through `65a2dfdb`. The initial harness preparation changed no product source. The actual failure
below then triggered an explicitly granted narrow WorkBlock envelope correction.
Workspace, native code, root manifest and dependency lockfiles remain untouched. Root alone
integrates main and the coordinator assembles/builds the native+desktop batch.

## Preparation checkpoint

Executable harness `3dda43d2` plus exact full-process-argv observation correction
`103fd5209607610bed4009f935cfaab753056e4a`:

- `node --check tests/workblock-electron-integration/run.mjs`: passed.
- `node --check tests/workblock-electron-integration/cdp.mjs`: passed.
- `git diff --check`: passed.

These preparation checks launched no Electron process and establish no runtime
acceptance. Coordinator reported assembly `745470fbdb776864794d6a17e13b2d63ea1b9192`
while matched native/frontend build work was still pending. The harness must not
launch until explicit final frozen HEAD and matching artifacts are supplied.

R caught an initial fixture contract error before execution: a native Create's
operation ID must equal its generation ID. Harness now uses one immutable ID
for both, a separate record ID, and Calendar worker was notified directly.
No binding source was changed to enforce this extra domain relation.

## Run contract and claim boundary

See `tests/workblock-electron-integration/README.md` for the executable command.
All root/HEAD/native/Electron/output/readiness flags are explicit. The runner
uses the normal real `desktop/main.cjs`, actual Workspace startup, owned profile
and vault, actual preload admission/semantic IPC, native stdio and SQLite.
It bypasses the renderer `createDesktopWorkBlocks` factory and does not exercise
Calendar UI. It mocks neither service nor persistence and introduces no backend.

Planned observations: create/read/move/title/add-reference/remove-reference,
exact original receipt replay after subsequent edits, no duplicate durable
change, stale root/admission and malformed request rejection, explicit release
and stale-context rejection, real app/native restart preserving state and original
receipt, then abandoned controller observation of a real renderer mutation and
exact retained-input replay after another process restart. The latter is an
observer-interruption test, not a claim to have dropped native stdio bytes.

Before/after witnesses hash source HEAD/tracked inputs, native-mode dist,
native executable, Electron executable and harness files. Exact child PID,
parent PID, full native executable+owned-vault argv, exit state, app output and
renderer runtime errors are retained. Only owned processes/fixture resources
may be closed or deleted. Surviving native children are force-cleaned and fail
the proof. Process SIGTERM/SIGKILL mode is reported separately from graceful UI
close acceptance. Screenshots of an empty generic Workspace add no semantic
storage evidence and are not fabricated.

## Actual results

Initial actual pass **FAILED** before mutations at the real error boundary.
Coordinator supplied frozen assembled `0163d2329fc720e52e6991d364f0052d8f80351e`
in `msg_8cdef6336453` with matched native rebuild and native-mode frontend build
witness (frontend built at `745470fb`, intervening changes only harness/docs/stage
allowlist). Worker verified these executable SHA256 values before launch:

- Native `/private/tmp/zorid-workblock-native-0163d232/zorid-desktop-host`:
  `6f792bf430846387a61b30bf36ad91899c27f3a6abd8e67f614012f99cc70875`.
- Electron 44.8.0 `/private/tmp/zorid-managed-electron-44.8.0/Electron.app/Contents/MacOS/Electron`:
  `12aa325561098c5dc5b175e465225b1b61e8f4090ce6d5dade89887e0eec8ab7`.

Command used the README's explicit arguments, root
`/Users/ctk/orca/workspaces/Zorid/managed-desktop-integration`, exact HEAD above,
and output `/private/tmp/zorid-workblock-electron-0163d232`. Harness source was
`8a74f176`; actual interval 2026-10-18 02:55:58–02:56:11 UTC.

Normal actual Workspace startup, recent-vault selection, completed reconciliation,
preload bridge, admitted context with `workBlocks:true`, and one real native
child all succeeded. Three deliberately rejected requests (wrong root, wrong
admission ID, forbidden DTO owner field) rejected, but renderer-caught Errors
had **undefined `code` and `commitUncertain`** instead of the typed sanitized
values. This is consistent with Electron contextBridge copying thrown Errors
without their custom properties; it invalidates the actual semantic
error/uncertainty contract despite passing Node/TS boundary mocks. No mutation,
reopen or replay acceptance was claimed after this failure. Coordinator was
promptly escalated via `msg_4f57fe259d5f`; product source was not changed.

Retained raw evidence:
`/private/tmp/zorid-workblock-electron-0163d232/result.json`,
`provenance-before.json`, and `provenance-after-failure-verification.json`.
Post-cleanup independent recomputation verified the same HEAD and every recorded
source/dist/native/Electron/harness digest: `verified:true`, `mismatches:[]`.
No runtime exceptions or error logs were observed before the failure.
Owned Electron PID 26074 exited zero via SIGTERM, and its exactly observed
native child PID 26315 exited without forced child cleanup. Fixture profile and
vault were deleted. Calendar worker was told no B Electron process remained.

Harness followup `99795c82` (new test files only) now retains rejected error
messages/own property names before assertions and records after-provenance even
on a failing pass; syntax check passed. A product error-envelope correction and
new exact frozen artifact readiness are required before repeating runtime.

## Narrow real-bridge correction

Coordinator `msg_763b4800edb0` expanded this dispatch to exact WorkBlock hunks in
preload, admitted renderer invocation, bridge declaration and shared codec,
plus focused regressions. R agreed the exact design in `msg_47fecbd53fb0` and
`msg_4a4f1f9754df` before edits. Source commit
`43cb6fa511011767872b170c9f40b2fba8223eaa` implements:

- WorkBlock-only preload always resolves cloneable plain data:
  `{workblocks:true,schemaVersion:1,ok:true,value}` or
  `{workblocks:true,schemaVersion:1,ok:false,error:{code,source:"host",commitUncertain}}`.
  No custom Error crosses this bridge. Other durable APIs are unchanged.
- Shared strict `decodeWorkBlockEnvelope` validates exact tags/version/fields,
  error code bounds, boolean certainty and existing semantic value/size limits.
  The admitted renderer closure calls it after the bridge and reconstructs its
  own sanitized typed Error. Valid explicit rejection certainty is preserved;
  missing/malformed/lost data never becomes a definite mutation rejection.
- Actual harness asserts the raw preload envelope and normalizes using the same
  production decoder loaded from the tested assembly. It continues to bypass
  the renderer factory and makes no factory/Calendar UI runtime claim.

Bounded seven-file Node/TS regression command now passes **45/45**, including
**19 WorkBlock cases**. Full configured frontend `tsc --noEmit`, harness syntax
and diff checks pass. New tests cover cloning, explicit false/true error metadata,
lost IPC, malformed tags/version/error codes/uncertainty, renderer-side decoding,
unknown outcome input retention and unchanged other durable error behavior.
R approved exact `43cb6fa5` in `msg_9a72d94c7ae1` (relayed by coordinator
`msg_46d7d7fed4e2`), after which the coordinator supplied fresh frozen artifacts.
These mocked bridge checks alone do not supersede the actual failed proof above;
the real retry below provides the separate boundary evidence.

## Actual retry — passed bridge/storage subset

Coordinator `msg_46d7d7fed4e2` authorized frozen assembled HEAD
`6e915a3d87fedb404d19ea1ddd1711be054ea46c`, including the reviewed envelope fix,
accepted F queries and Calendar source. Coordinator rebuilt full frontend types
and native-mode Vite successfully at that HEAD. Native query source had a matched
build before the frontend-only envelope correction. Before launch the worker
verified exact HEAD and executable witnesses:

- Native `/private/tmp/zorid-calendar-native-2d1d93dc/zorid-desktop-host` SHA256
  `62c6fc58b742a23c52b75919a9d8ef94474f81232a51b2ce3775a9d6957ba405`.
- Same Electron 44.8.0 executable/hash as the initial pass above.

Actual interval: **2026-10-18 03:00:26–03:01:08 UTC**. Three actual Electron /
native launches, **26 recorded semantic commands**, and three bounded groups
passed through normal Workspace startup, existing actual preload IPC, current
window/vault/client lease checks, real native stdio and SQLite:

1. Create/read/move/title/add-reference/remove-reference and bounded window;
   original Create replay after later edits returns the original exact receipt,
   preserves current state and produces no additional durable change.
2. Explicit context release rejects the old admission; process/native restart
   and same-vault reopening preserve the complete state and original receipt.
   Replaying that original Create after restart adds no change.
3. Real renderer dispatch with deliberately abandoned controller observation,
   process restart, exact original immutable title request retry and a repeated
   retry produce **one** durable write. This remains an observer-interruption
   test, not a dropped-stdio fault-injection claim.

All three initial negatives now survive the actual bridge as raw plain-data
failure envelopes and normalize with the production decoder to exact
`durable_scope_changed`, `durable_scope_changed`, `invalid_workblock_request`,
each `source:"host"`, `commitUncertain:false`. The released-context negative
also preserves exact typed metadata. Error assertions were not relaxed.

Synthetic record `electron-block-74d4568e-3f2c-4282-9112-cfa0546de154`, generation /
Create operation `generation-d8f67465-7e97-498f-8b9b-b281a77c4c4e`; original
receipt sequence `"1"` and recovered observer operation receipt sequence `"6"`.
Exact immutable requests, all byte-array revisions and decimal millisecond
strings (`253402300800000` through `253402300803000`) remain in raw evidence.
No renderer runtime exceptions/error events were observed in any launch.

Raw proof directory: `/private/tmp/zorid-workblock-electron-6e915a3d`.

| Artifact | SHA256 |
| --- | --- |
| `result.json` | `620630a183a37ef3fe18a5a65b5ce110547769bc941056b62ae1b0116f89b267` |
| `provenance-before.json` | `bfc1157d081e507228cd7cc180f07cbb2ec98241559385ac5388374ebefae8ba` |
| `provenance-after.json` | `bfc1157d081e507228cd7cc180f07cbb2ec98241559385ac5388374ebefae8ba` |

Before/after provenance is byte-identical and `provenanceVerified:true`, covering
source HEAD/tracked inputs, dist, native, Electron and actual harness source.
All three exact native children exited without forced native cleanup, and the
fixture profile/vault were deleted. First and third owned Electron processes
required the recorded **SIGKILL fallback after deliberate context release**;
second exited zero via SIGTERM. This proves durable storage across those process
restarts and explicit stale-context rejection, **not graceful UI close**.
Coordinator and Calendar worker were told all B app/native ownership was clear.

R independent raw-proof review was requested with exact artifact hashes in
`msg_82d3b43799a2`; no additional runtime run is required merely to repeat the
same bounded acceptance. Original failed proof remains retained alongside retry.

## Remaining gates

Actual rendered Calendar scheduling/editing flow, renderer service factory
runtime and graceful UI close, multi-client encrypted convergence, and native mobile/browser behavior
remain outside this bridge/storage-only followup. Passing this subset cannot
establish those gates or complete the overall product milestone.
