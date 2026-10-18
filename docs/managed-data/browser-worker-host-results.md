# Normal browser Worker managed-record lifecycle

Owner H: task `task_cee4ca1bf275`, dispatch `ctx_49b0b814cd6a`, terminal
`term_287b7e5c-2b5f-468c-beca-6a17d797a3d0`; branch
`tingkai-c/managed-records-worker-host`, isolated checkout
`/Users/ctk/orca/workspaces/Zorid/managed-records-worker-host`.
Base `9b9f6479` contains canonical integrated browser storage `b5d9d510`.
Coordinator agreed exact private contract in `msg_0e9c2693b230`; sole main
integration remains with its existing owner. H did not mutate main.

## Delivered boundary

Existing `browser-core-worker.ts` and `browser-sync-worker.ts` connect the
reviewed records adapter to normal Worker lifetime. New internal host and registry
modules own compile-time first-party registration, coalesced maintenance and
durable metadata delivery. No message-supplied owner/schema installs authority.
The **product registry is empty**. A test-build Vite substitution installs one
fixed synthetic collection; the normal Worker entry and host machinery are real.
This proves the machinery, not product UI, Types/Tasks schemas or plugin APIs.

- Registration occurs under the client lease and enrolled realm/vault, before
  managed retry. Collection handles remain private to this lifetime.
- Startup, successful sync configuration, normal receive/change refresh,
  BroadcastChannel hints and existing foreground refresh trigger maintenance on
  the existing `local` queue. There is no new timer, network loop, outbox, cursor
  or database. Existing sync upload/pull/session-generation topology is preserved.
- Each trigger has at most four rounds across at most four compiled consumers;
  each collection round uses one existing 16-receipt/1 MiB adapter page and one
  64-row change page. No-progress exhausted work stops until another trigger.
  Unfinished continuation remains durable in the adapter. A coalesced external
  hint during rejection gets one bounded follow-up; errors do not cause a loop.
- `recordsSession()` supplies the exact guarded key and stable session identity
  only after queued configuration validation succeeds. Revocation invalidates
  captured guards and frees the owned key; tokens/keys are never worker messages.
- Durable changes catch up using decimal-string watermarks. Callback and parent
  change hints run only after adapter durable return and a fresh active guard.
  Fatal maintenance errors use the existing observable `storage-error` channel
  and fence storage. Expected session/key/CAS contention waits for a new trigger.
- Release fences admission synchronously, revokes sync, drains admitted managed
  work and existing detached binary work, then runs existing cleanup and releases
  the lease. Closing is checked inside storage callbacks; only serialized cleanup
  after drain receives the narrow closing exception. A transaction already past
  its last abortable guarded callback can commit after closing: stale notification
  is suppressed and reacquisition proves its durable outcome.

Source commits: `fb517b2d`, `a0f510d3`, `fd9b642a`, `804c9fd5`.
Final **source/tests freeze**:
`804c9fd53a7417414f8d5fe688f7fd67cb8fd061`.
No runtime/backend/public-client, editor, desktop/mobile, Rust/crypto/relay,
root manifest or lock changes were made. Generated assets were copied locally
from the existing verified assembly without rebuilding or changing source.

## Verification

Commands at the final source:

```sh
node --test --test-concurrency=1 tests/browser-managed-records-host.test.ts tests/browser-sync-worker.test.ts
node node_modules/typescript/bin/tsc --noEmit
node tests/browser-managed-records-worker/run.mjs --expect-head 804c9fd53a7417414f8d5fe688f7fd67cb8fd061 --out /private/tmp/zorid-managed-host-final
git diff --check
```

**17/17 focused Node checks**, full-project TypeScript and whitespace checks
pass. Node tests cover coalescing, no-progress/finite budget, rejected-pass hint
recovery, missing-key catch-up, in-flight close drain, post-return owner loss,
pre-ready provider absence, stable key/token identity and post-revoke fencing,
plus the ten existing sync Worker tests. Node doubles are orchestration evidence.

**Actual Chrome 155: five groups PASS**, normal dedicated Worker + actual shared
WASM + encrypted input + strict IndexedDB. Preserved raw evidence:
[`report.json`](../../tests/browser-managed-records-worker/artifacts/804c9fd5/report.json),
SHA256 `616b4bd9740c649d870b3182eb38a5e51c9caaae913ab7adf4eb3d109947076d`.

1. Startup registers exactly one fixed collection and recovers a retained
   `missing_registration` parent to accepted; retained child becomes waiting.
2. Normal HTTP reference transport receives encrypted parent, then host retry
   accepts retained child. Shared cursor remains exactly `1`; no authored echo.
3. A real external writer emits no BroadcastChannel hint; existing foreground
   refresh delivers its durable change exactly once, including repeat refresh.
4. Release fences queued maintenance; no later writes/notifications occur; the
   exact same client ID reacquires its lease on Worker restart and catches up.
5. Test-only scheduling instrumentation holds a **real strict transaction**
   during accepted-state publication. Closing occurs while it is in flight;
   transaction completes, release waits for completion, no stale accepted callback
   is delivered, and reacquisition observes accepted state. This is durable commit
   with response suppression, not an asserted rollback.

Both disposable databases were actually deleted. Owned Workers, Vite server and
Chrome process exited; the owned profile was removed. No compiler, test browser
or server remains live. Earlier fixture-only failures were corrected: Vite
rejected an external generated-asset symlink (exact assets copied locally), and
synthetic Create IDs initially differed from their generations (fixed before
host acceptance). Independent review found ignored error-channel and rejected
coalesced-trigger issues; both received source fixes and regression coverage.

The runner verified source/artifact witnesses before and after execution:
source digest `015cda136021541c30fefc6cee1b0200732ecdbcadf5344e8ed6b81072cafe49`;
WASM fingerprint `a4027f128c91099071a2744f90a599b9151ee623599f3e4b7c4846283a16e0f8`;
glue `1145a203bda8c72a6e017e87f0adda6df4b5c9d992d802c56ece864538ffae31`;
WASM `b8e316e2a8d4e8a498c0e8f2d48b844d3b3db4ca51513bbd000674f26283ae2e`.

## Remaining gates

No active product consumer, public registration/client API, application UI or
whole Phase 1 acceptance is claimed. The actual fixture uses a trusted external
seeder and one normal Worker at a time, including replacement/reacquisition;
**two independent normal Worker databases authoring offline edits and exchanging
them to convergence remain unverified**. HTTP fixture transport is real but the
fixture relay is synthetic, not a deployed service. The complete browser matrices,
native/mobile integration, and later managed-data plan milestones remain separate.
