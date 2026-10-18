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

Pending explicit matched-build readiness; no actual Electron claim yet.

## Remaining gates

Actual rendered Calendar scheduling/editing flow and renderer service factory
runtime, multi-client encrypted convergence, and native mobile/browser behavior
remain outside this bridge/storage-only followup. Passing this subset cannot
establish those gates or complete the overall product milestone.
