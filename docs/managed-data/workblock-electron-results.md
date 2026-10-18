# Actual Electron WorkBlock bridge/storage verification

Owner: worker `term_dcd608f8-cbcf-41d1-930b-c098d80659ac`, task
`task_0439dfd1fbe6`, dispatch `ctx_689388f73d04`. Scope is only new
`tests/workblock-electron-integration/**` and this report on isolated binding
branch `tingkai-c/managed-workblock-desktop-binding`.

The preceding accepted desktop binding source remains frozen at `313e9964`
with report through `65a2dfdb`. This followup changes no product source,
Workspace, bridge, native code, root manifest or dependency lockfile. Root alone
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

## Remaining gates

Actual rendered Calendar scheduling/editing flow and renderer service factory
runtime, multi-client encrypted convergence, and native mobile/browser behavior
remain outside this bridge/storage-only followup. Passing this subset cannot
establish those gates or complete the overall product milestone.
