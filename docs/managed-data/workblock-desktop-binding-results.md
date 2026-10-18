# Desktop WorkBlock binding results

Owner: worker `term_dcd608f8-cbcf-41d1-930b-c098d80659ac`, task
`task_ed5557a983cd`, dispatch `ctx_98a6a0e68ddb`, isolated branch/worktree
`tingkai-c/managed-workblock-desktop-binding` / `managed-workblock-desktop-binding`.
Base `7d375ab4`; initial implementation/tests `248e097ffa2c770cf1c2c4d4b92749a3d1aa53b8`,
renderer capture correction `313e9964` (final source freeze).
Main integration stays with the shared-core/root coordinator.

## Ownership and contract

Root grant `msg_7dd7de9cf98e` names new desktop codec/core first-party interface,
private Rust process transport and desktop semantic capability hunks. Followup
root `msg_bbf5afccfb11`, relayed `msg_da1f842ce3ca`, adds narrow
`desktop/editor-core.cjs`, `desktop/client-admission.cjs`,
`src/platform/bridge.d.ts`, and `src/platform/index.ts` activation hooks.
`desktop/workblocks.d.cts` supplies the browser-safe codec's TS declaration.
No Workspace/NoteBuffer/UI/Rust/native/mobile/browser worker/root dependency
manifest or lockfile changed. The existing path-only `vault-dispatch.cjs`
remains unchanged because it does not carry a native client lease.

Native owner W (`ctx_ac001f12b4d9`) directly agreed the exact DTO in
`msg_7c6bb30b43fc`, clarified structured missing/deleted reads in
`msg_44bd37faccd4`, and confirmed the existing Store's `unresolved` map is
status-to-canonical-decimal-count (`msg_62c9bee8e1bd`). This implementation
preserves unknown status keys and opaque change identifiers. W owns all
native/host implementation on `managed-workblock-domain`; no native code was
duplicated here. Native source compilation/runtime results are separate evidence.

## Implemented boundary

- Native outer request uses existing framed process transport:
  `{method:"workblocks",client_id,request:{schemaVersion:1,command:{op,...}}}`,
  empty body and existing client lease envelope. Reply marker
  `{workblocks:true,schemaVersion:1,bytes}` describes UTF-8 body JSON
  `{schemaVersion:1,op,value}`. Fixed registration, owner, enrollment, schema,
  collection handles and raw state never cross the renderer boundary.
- Renderer `PlatformVault.workBlocks` provides create/read/windowPage/move/title/
  addRef/removeRef/delete/changes only when native capability `workblocks`
  produces admitted context flag `workBlocks:true`. Old hosts fail closed.
  Canonical strings and opaque revision byte arrays are copied unchanged.
- Main IPC authenticates the exact main-frame sender. Existing editor-core
  checks bind admission ID, root, window generation, URL and selected vault;
  client admission tracks pending work and release phase. `withClientLease`
  checks ownership both before enqueue and immediately before actual framed
  dispatch; native receives the original owned lease on each command.
- Requests reject unknown fields, accessors, `toJSON`, nonplain prototypes,
  malformed identities/revision arrays/times and excessive page/request budgets.
  Capture uses bounded descriptor-only detached data before validation, without
  invoking getters. Requests cap at 16 KiB; response bodies cap at 4 MiB before
  allocation. Existing 1 MiB frame header limit is unchanged.
- Windows retain native limits of 64 scanned records and 1 MiB snapshot budget.
  Results validate live materialized intersecting records, exact identities,
  candidate/reference limits, nonzero scanned-byte progress, cursor advancement,
  decimal watermark and continuation flags. Native owns the process/client/lease
  cursor and collection watermark fence; this binding adds no aggregate scan,
  sync loop, storage authority or independent cursor authority.
- Mutations require caller-owned explicit operation IDs. Concurrent identical
  renderer calls share one invocation; uncertain calls retain their exact input
  fingerprint and require an explicit identical retry. The bounded pending map
  never silently evicts unresolved operations. Rust owns durable idempotency;
  no retry creates a fresh ID. Release fences retained service references and
  drains pending work before existing native context release. A successful
  native response hidden by late window revocation remains mutation-uncertain.
- Preload converts lost WorkBlock IPC into a sanitized uncertain error without
  native path/details or automatic replay. Malformed mutation replies and lost
  transport retain uncertainty through the existing main error envelope.

## Verification

No full build, Rust compile, iOS slot/device/simulator pass or Electron launch was
performed by this worker. Local checks used the existing primary checkout's
installed node_modules via a temporary worktree symlink, removed after checking.

1. `node --test --test-concurrency=1 tests/desktop-workblocks.test.cjs tests/desktop-workblocks.test.ts`:
   **16 passed** (9 Node boundary/admission and 7 TS renderer/platform cases).
2. Bounded adjacent regression command, adding
   `tests/desktop-client-admission.test.cjs`,
   `tests/platform-desktop-durable.test.ts`,
   `tests/desktop-document-semantics.test.cjs`,
   `tests/desktop-document-semantics.test.ts`, and
   `tests/desktop-main.test.cjs`: **42 passed**, including the 16 above.
3. `./node_modules/.bin/tsc --noEmit`: **passed**, full configured frontend types.
4. `git diff --check`: **passed**.

An earlier adjacent run also included `tests/desktop-editor-core.test.cjs`:
40/45 passed; all five cases in that preexisting file fail before assertions with
`MODULE_NOT_FOUND: ./rust-vault-service.cjs`. Its VM fallback resolves relative
to tests rather than the loaded desktop source. HEAD already has that source
require; independent reviewer U reproduced the unchanged harness defect. This
file was not modified. New tests exercise the real WindowBroker + editor-core +
client admission together using correctly source-relative `createRequire`.

Coverage includes stale admission/root/generation/window/sender frame/URL,
revoked queued transport with zero emitted frames, native lease forwarding,
late revoked mutation response, release drain, capability absence, unknown field
and descriptor rejection with zero transport, signed pre-1970/post-2100 times,
Unicode titles, exact byte revisions, decimal values beyond JS safe integer,
malformed/oversized markers/results/prefixes, bounded pages/continuations,
unknown change status preservation, explicit identical replay with no automatic
retry, concurrent deduplication, pending capacity and sanitized lost IPC.

## Review and remaining gates

Independent reviewer U (`ctx_420ce8258f13`) identified the original descriptor
capture TOCTOU and observable window consistency gaps. Both were corrected with
regressions before implementation commit `248e097f`. U then found the renderer
spread still evaluated input getters before capture, allowing a getter-triggered
release before pending tracking; `313e9964` adds descriptor-only capture before
command construction and a no-getter/no-dispatch regression. Exact final source
review has been requested. Review report lives separately at
`/tmp/zorid-workblock-binding-review.md` pending U's final result.

The coordinator must compose the independently reviewed native service/host and
this binding, then run actual Electron schedule/read/reopen verification before
claiming native/UI acceptance. This source and mocked-native boundary evidence
does not establish actual Rust host execution, durable disk replay/reopen,
normal editor UI, encrypted multi-client convergence, browser activation, mobile
or reference parity. No test application was opened or left running.
