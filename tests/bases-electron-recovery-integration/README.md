# Actual native acknowledgement interruption campaign

This test-only campaign uses the normal Electron application, its normal bridge,
and the exact matched `zorid-desktop-host` binary. A regular executable relay is
selected through the existing trusted host-executable setting. It forwards every
request and unselected reply byte unchanged. It never substitutes a result,
acknowledgement, row set, capability or native error.

The coordinator must freeze matching source/frontend/native artifacts and grant
the runtime slot. Updated terminal-review paths additionally require the reviewed
hidden-menu Save fix and explicit summary-commit passivity fix in product pins
`3b49949f` → `2896086d`; those changes are separate from this test-only campaign. The common runner's reviewed relay/process-tree seam is required.
The campaign never builds or runs independently selected artifacts.

```sh
node tests/bases-electron-recovery-integration/run.mjs \
  --root /absolute/frozen/integration \
  --expected-head FULL_40_CHARACTER_COMMIT \
  --native /absolute/matched/zorid-desktop-host \
  --electron /absolute/Electron.app/Contents/MacOS/Electron \
  --out /private/tmp/zorid-bases-recovery-UNIQUE \
  --ready bases-native-and-frontend-frozen
```

The summary scenarios use a real collection-backed scene. Before any Electron
launch, the runner invokes the exact frozen Native binary through its public
collection API in a separate, owned Node process and isolated app-data directory.
It claims a real client, creates one collection with a numeric `score` field,
then creates A.md and B.md with exact caller-owned entry/operation IDs and values 2
and 3. Both schema identities come from genuine create receipts. The helper
requires zero pending projections, exact membership/file revisions, read-by-ID,
stat, path read and physical readback of independently authored complete note
bytes. It releases the client and observes normal Native exit before continuing.
No existing note is imported into a collection; no private database is written by
the harness. These are explicitly prelaunch fixtures, not GUI creation evidence.

The immutable scene contains actual schema IDs and verified source/readback facts,
with no lease tokens or service handles. Base fixtures select that collection and
use its actual stable property ID plus per-view `summaryDefinitions`. The runner
verifies the two Native-created notes against its independent fixture map and
never rewrites them, even with identical bytes. Ordinary fixtures, full vault
manifest, source/artifact provenance and process cleanup remain required. Failed
preparation is recorded before any app launch or fault-acceptance claim.

Before arming either summary interruption, a passive GUI oracle requires the
exact A/B numeric cells 2/3 and the visible Total 5 footer on a settled, error-free
collection view. The old Name-only vault scene cannot pass this precondition.
The ordinary New/lost-create scenario keeps its separate supported untyped view;
its complete template-byte and original-operation oracles remain required. The
broader safety campaign still needs its own collection-scene port and is not
made valid by this recovery-only setup.

| Scenario | Interruption and independent oracle |
| --- | --- |
| Terminal checkpoint ACK, ordinary Save, explicit raw B | Hold only the real inert `prepare_intent` reply for exact A bytes. Type B in the same mounted editor and let its 250ms debounce elapse while A is pending. Set only the owned disposable `.zorid/vault.lock` to mode0000 and release the unchanged prepared reply. Require a genuine `filesystem_failed`/`commit_uncertain:true` checkpoint CAS response correlated to the original method/key/command/body digest and Native process. B remains exact and editable in the original panel/editor with the truthful save error; no custom Review/Copy/Retry UI remains. Restore the exact inode's mode in `finally`; whole physical/bridge source must still be S0. A350ms quiet interval plus normal-bridge read must leave S0 and the observed mutation/checkpoint frames unchanged. Use ordinary Save current changes to settle only A; identical checkpoint CAS command/body succeeds before original A token commits. B remains passive through another350ms interval, then an explicit normal formula Tab commit saves B without retyping/replacing editor. Check whole B, unrelated fixtures, value12, normal close/quit and restart readback. This terminal permission case does not establish automatic host/admission recovery. |
| Accepted A, newer B, close | Arm exact saved Base entry/path and exact A bytes. Observe its real prepared token and committed native receipt, hold only that successful reply, type B through the mounted summary editor and request tab close. The panel retains B while disk contains A. Release the same encoded reply; exactly one A and one B write finish. Close safely, quit normally and verify exact B after restart. |
| Lost New reply, automatic same-mounted recovery | Arm the exact destination and complete template digest, then click New **once**. Suppress its first genuine successful create reply and gracefully stop that real host before presenting actual EOF. Main must automatically replace the host while the original application, CDP target/document, pane, tab and saved Base source/view remain bound. Every host generation must be independently authenticated by the runner. The replayed file command must have the original operation, command/body digests and receipt sequence; its real frame lease must match a fresh positive same-client/store claim. Normal Native stat and bridge readback must retain the dropped entry ID/revision and independently authored complete template bytes; exactly one file exists. A passive observer installed before New records visible alert/failure/manual-recovery flashes through settlement. No second New, Save, reopen, reload or forced restart may complete recovery. Only after these checks and a350ms quiet duplicate-authoring barrier does the campaign quit normally and perform a separate ordinary-restart persistence readback. |

`hold` defaults to the existing committed-receipt phase. Only the explicit
`phase: "prepared"` variant selects a successful inert preparation, bound to the
observed entry/path, exact body digest, client, operation and native token. It
cannot select a rejected/error reply or fall through to a later committed reply.
The phase changes delivery timing only: original requests, prepared replies and
subsequent native errors are forwarded byte-for-byte. `drop` has no phase option.
Existing accepted-write and lost-create scenarios retain their original defaults.

The checkpoint fixture changes only the owned `.zorid/vault.lock` regular file
(not its parent or public source folder). It verifies the vault is inside the
runner output, rejects symlinked private parents, and checks lock ownership,
link count and device/inode identity. Original permissions and that exact inode
are verified/restored in `finally`; an unexpected replacement fails the case.
After the prepared reply, `NoteDurableState.resume` must checkpoint `op.ref`
before querying or committing it. Native checkpoint CAS freshly opens the vault
lock read/write before Store CAS. Mode0000 denies that open and maps to genuine
`filesystem_failed` uncertainty. This is a failed checkpoint ACK, not a logical
commit with pending public-file publication. The accepted configuration already retains its original saved-source guard;
denying public-folder access would not isolate this checkpoint boundary. The public sources, private directory, database and actor files remain
accessible. No production guard or semantic fault API is added for the test.

The expected S0/A/B are authored whole strings preserving the comment, unknown
root sentinel and unrelated summary/view. The DOM backend node ID checks that the
same summary panel retains B. After restoring lock permissions, whole physical
and normal-bridge source must still equal S0 before ordinary Save. A failed checkpoint
frame and a successful retry must have identical command and opaque body hashes
(same key, expected/next revision and saved state). That replay must precede A's
successful commit with its original held token. A is prepared once, then exactly
one explicit B preparation and ordered A/B successful receipts are required. B
must remain unsubmitted after the ordinary Save acknowledges A until the user
explicitly commits its preserved raw input. Additional
checkpoint transitions are expected; a new checkpoint request cannot substitute
for replay of the failed request. This records exact native continuation rather
than treating a Save command as a physical-write counter.
A's intermediate whole physical and normal-bridge source is read back before B;
it remains exact A throughout a further350ms raw-input hold before B's explicit
commit. Editable terminal input additionally requires unchanged native write-request and response
frames across a350ms quiet interval and normal-bridge read barrier before ordinary Save. The relay records only write method,
operation/checkpoint identities and command/body digests before forwarding; it
never logs source bodies or changes a forwarded request.

The relay consumes the fault before restart. A 15 second hold watchdog records
failure and releases the **same genuine frame**, below the production 30 second
transport timeout. Watchdog expiry, malformed framing or unowned/leaked processes
fail acceptance. Request/response hashes, native operation/receipt identities,
relay and native artifact hashes and exact process-tree cleanup are retained.

These scenarios do **not** establish SQLite/device-write failure, arbitrary disk
failure, power-loss safety or a forcibly killed Native process's recovery.
The lost-New phase requires same-mounted replacement after genuine EOF from a
cleanly stopped original host. Its later ordinary restart is a persistence check,
never the action that authorizes or causes recovery. Holding an accepted write is
distinct from a failed-save retry. A newer draft blocked behind a native call is
not claimed crash-durable before its checkpoint can run.

The lost-New observer reads only DOM state and retains references in its own CDP
object group. It never changes the DOM, calls product methods, shifts focus or
dispatches synthetic input. Mutation callbacks and animation-frame samples keep
a bounded failure history even when an error later disappears; hidden controls
do not count as visible. The observer permits honest pending status, rejects
visible error/Retry/reopen controls and original pane/tab/source changes, and
disconnects/cancels observation before releasing its object group on all paths.
This is observed DOM-frame coverage, not an OS screen recording.

Pure protocol checks require no application or native executable:

```sh
node --test --test-concurrency=1 tests/bases-electron-recovery-integration/protocol.test.mjs \
  tests/bases-electron-recovery-integration/relay-process.test.mjs \
  tests/bases-electron-recovery-integration/configuration-review.test.mjs \
  tests/bases-electron-recovery-integration/terminal-summary.test.mjs \
  tests/bases-electron-recovery-integration/collection-scene.test.mjs \
  tests/bases-electron-recovery-integration/terminal-checkpoint-failure.test.mjs \
  tests/bases-electron-recovery-integration/lost-create-auto.test.mjs \
  tests/bases-electron-recovery-integration/lost-create-ui.test.mjs
```

Those checks verify framing, arming, committed/prepared success selection, request-digest
evidence without source bodies, scene DTO/path/source-oracle validation, and the
watchdog. Scene unit descriptors are illustrative test data; they execute no
Native binary and establish no collection-provisioning or GUI acceptance. The
subprocess check uses an explicitly simulated Node peer to verify pipe forwarding
and EOF cleanup; its invented unit receipt is not a Rust/native result. Authoring
or passing helper checks does not complete any runtime acceptance gate. The
prepared-hold subprocess case uses an explicitly simulated peer's negative checkpoint
frame and successful identical CAS replay; its purpose is exact forwarding and
request-hash correlation, never a claimed native checkpoint failure.

The replacement one-click automatic-recovery oracle is **authored only** until
the coordinator runs the frozen campaign with the reviewed generation registry
and matching relay/frontend/native products. Actual007 completed the earlier two
journeys but did not accept its third journey: its old test clicked New a second
time after the original operation had already replayed automatically, producing
a legitimate second operation/file. That result explains the obsolete fenced-
transport assumption; it is not retroactive acceptance of this new oracle.

The lock-open denial is a terminal filesystem permission error: Native preserves
the typed IO cause, maps it to `filesystem_failed`, and keeps commit uncertainty
on the exact checkpoint request. The frontend does not retry that code
automatically. Pure policy checks exercise this boundary and the distinct typed
transient `filesystem_io_retryable` continuation; they establish no packaged
host-rebind or OS/storage recovery acceptance.
