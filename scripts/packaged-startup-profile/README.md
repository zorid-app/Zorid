# Real packaged Zorid startup benchmark

This harness launches the supplied **actual `.app` executable**. It does not load
a development launcher, build a replacement app, or set `isPackaged` manually.
It requires an exclusive app profiling slot. Preparing or testing this harness
does not establish any native startup result.

```sh
node scripts/packaged-startup-profile/run.mjs \
  --candidate-app /absolute/path/to/candidate/Zorid.app \
  --baseline-app /Users/ctk/Applications/Zorid.app \
  --candidate-source-manifest /absolute/path/to/matching/.release/inputs.json \
  --notes 1000 --repetitions 1 --seed 42
```

`--baseline-source-manifest` is also supported. Both manifests are optional; each
provided file is retained and its file/native hashes checked against the actual
ASAR and packaged host. Without one, source provenance is **unknown**. An ASAR
hash or the harness Git commit is never substituted for an app source commit.
The harness pins the executable, Electron framework, native host, ASAR and plist
and records the actual main process Electron version. Different Electron versions
are an explicit comparison confound, not silently treated as equal runtimes.

Two byte-identical APFS `.app` clones are made under a fresh owned
`/private/tmp/zorid-packaged-startup-*` campaign. They are reused across cases;
profiles, vaults and `ZORID_LOCAL_DATA_DIR` are unique to each baseline/candidate
repetition. No installed bundle, real vault or real profile is changed. The clone
is launched directly with its ordinary packaged entry, `--user-data-dir`, a
loopback renderer CDP port and main inspector. Dev/fixture/native overrides and
inherited Node/Electron debugging environment are removed. Main scope validation
requires actual `app.isPackaged`, the cloned ASAR, exact owned profile and data
directory before any probe. Vault selection is independently checked too.

The matrix randomizes baseline/candidate pair order with a recorded seed. Each
pair runs first import followed by a normal process reopen of the same profile.
If the first launch fails before its verified return to Note0000, fixture
restoration or normal cleanup, its dependent reopen is explicitly skipped rather
than asserting a wrong restored-document expectation.
Each launch measures the correct selected 8 KiB note, opening a different ordinary
note, opening an exact **432,000-byte** note and normal Base view readiness. A
fresh-import shell, Welcome page, blank editor, wrong file or truncated body can
never satisfy the selected-note check. Reopen preparation returns to Note0000
through its normal file-tree command before normal quit.
File selection scans the actual scrollable Files UI using normal wheel events
and clicks only a mounted target row. Missing rows may be offscreen/unmounted or
not imported yet; the harness does not guess which. Bounded row-availability
waits, wheel steps and ordinary scrollIntoView are recorded in `navigation` and
stay inside the original startup/note/Base clock, including the800ms attempt.

The renderer observer is registered with
`Page.addScriptToEvaluateOnNewDocument` as early as the owned target is available,
then installed in the current document if needed. Main and renderer observations
are buffered. Pre-attachment phases remain censored. Main request observation
retains normal Promise/result identity and records actual receipt metadata, not
bodies. `calledAt` is wrapper entry; `queuePredecessorSettledAt` is only the prior
queue tail settling, **not** actual dispatch after readiness/authorization waits.
Composite effect kind/priority stays unknown unless its exact committed
descriptor was actually observed.

All elapsed clocks use the runner's monotonic spawn/open origin. Remote
`performance.now()` events map through request/response handshake **intervals**;
independent `timeOrigin` values are never naively subtracted. Handshake bounds,
attachment overhead and late input dispatch remain in each receipt.

There is one earliest-ready probe and one fixed 800 ms attempt, without retries.
Normal trusted CDP keyboard input must produce a trusted `beforeinput` in the
exact selected CodeMirror, with exact document growth, caret and post-paint state.
Completion is observed through the actual CodeMirror transaction, including a
bounded later DOM-observer/animation-frame turn; `beforeinput` alone is not ACK.
Initial length/prefix, known first viewport text and two frames are checked. Full
body hashing happens after the deadline. Ordinary Save and trusted Undo restore
the original fixture, verified against physical files and read-only Core reads.
No CodeMirror transaction, bridge write or direct filesystem edit simulates input
or restoration.

An 800 ms success requires actual trusted accepted input within conservative
clock bounds. Mutation/snapshot observations do not establish continuous coverage
of silent property or layout changes, so a ready-null deadline snapshot remains
**indeterminate**, including when it is currently ineligible. Later successful
input is diagnostic; this harness does not manufacture a valid target miss from
those incomplete observations.

Base timing is separately labeled: visible enabled controls, a current/non-busy
grid, exact expected row count, a known fixture row and two frames. It does not
claim CodeMirror input or protected Base-edit authority.

Actual successful Core commit receipts matching readback ID/revision and
checkpoint acknowledgments are retained when observable. Independent journal
disk heads are a separate read-only artifact; their existence is **not** a
journal fsync/ACK, power-loss durability or recovery proof. Missing authority
evidence is explicitly `not-observed`, never replaced by a fixture journal.

Every owned PID and ordinary quit/exit is recorded. TERM/KILL fallback or an
unverifiable process proof invalidates acceptance. Only paths under the two
unique clone bundles may be signaled. Clones are removed after all owned PIDs
are absent; `--keep-clones` retains them for diagnosis.
The terminal main snapshot is written on the actual app `quit` event exit code0,
after native close. Individual cancelled `will-quit` attempts remain diagnostic;
neither an early attempt nor PID absence is a normal-exit acknowledgment.
The renderer debugger comes from the current child's stderr browser WebSocket
nonce. That browser authenticates the page target ID before attachment; an old
profile's `DevToolsActivePort` or a recycled HTTP port cannot select another app.
Profiles, fixtures, logs, per-launch receipts and the campaign report remain.
A run exits zero only when
artifacts/cleanup are valid and all candidate note targets are met; inspect
individual outcomes and the separate baseline results, not exit status alone.

Other bounded options: `--out` (fresh owned prefix above), `--timeout-ms` (4–120s),
`--shutdown-timeout-ms` (10–120s), `--repetitions` (1–5), `--notes` (2–10000).
Filesystem caches are uncontrolled; these are process-cold, **not disk-cold** runs.

Pure protocol/oracle checks do not launch Electron, compile Rust or package:

```sh
node --test scripts/packaged-startup-profile/*.test.mjs
```

Observer snapshots request a fresh readiness check so property or layout changes without a DOM mutation cannot leave the probe asleep. Exact source, selected editor, editability and viewport checks run before and after the two-frame observation. Failed launches retain observer state plus the actual selected CodeMirror identity, prefix, size, editability, bounds and visible line/widget diagnostics; these diagnostics do not establish input acceptance.

Instantaneous eligibility and pending-frame state are retained as deadline diagnostics. They do not establish continuous readiness coverage, so unresolved readiness remains indeterminate and never manufactures a valid target miss.

Measured launches normally activate only their authenticated packaged child and single owned window before observer frame checks and each file-open action. Process, executable, ASAR, profile, local-data and window URL are checked on every call. Native activation time stays inside the original spawn/open clock; background throttling is unchanged. Foreground/window and failure document visibility/focus are recorded. Human input while the test window is foreground can invalidate exact-source checks and is never filtered or ignored.

Activation is requested once per boundary and confirmed through passive owned-window focus/visibility plus renderer visibility, within the original time budget. Passive checks during navigation, readiness and Base waits treat foreground/visibility loss as explicit measurement interference and stop; they never refocus continuously or retry input. Frame waits reject visibility loss instead of waiting for hidden RAF. Failures include small Base grid, row-count, busy, error and toolbar diagnostics.


`--prewarm-empty-profile` is opt-in. For each pair the runner first launches the
same app clone, Chromium profile and selected EMPTY fixture vault normally. It
observes real read-only bridge inventory: zero public entries, a complete empty
checkpoint page, zero unacknowledged writes, zero independent live drafts, and no
local draft keys. Preparation must then quit normally with actual native exits,
no owned processes, no cleanup evidence errors and no disk draft heads. Only after
all canonical owned-path, single-primary-client and no-symlink inventory checks
pass does it remove that empty vault's `.zorid` and dedicated app-data contents.
The Chromium profile, client registry and app clone are preserved. Source fixtures
are created afterwards, and the measured launch must report a different native
store ID with the same normal profile client before trusted input. Any retained
work, unknown proof, extra source, foreign path or live process aborts preparation
without starting a measurement. There is no session seeding or storage/bridge
getter override.

This mode is **process-cold, isolated profile/code-warmed, not OS/disk-cold**. Warm
launches have separate receipts/order and no performance acceptance. The measured
spawn clock and fixed800ms timer begin anew before that process is spawned; warm
setup is explicit preparation, never deducted from a measured launch. First import
still selects Note0000 through the normal file tree INSIDE its spawn clock. Reopen
still requires the full original verified Note0000 return, fixture restoration,
Base success and normal cleanup; this option does not waive failed dependencies.

Main and current-child browser/renderer authentication now start independently.
The passive renderer observer is installed as soon as its authenticated target is
available, before waiting for native window activation or full native-request
instrumentation. Both channels are joined, and actual packaged main identity,
foreground, selected vault and native scope must all be verified before any trusted
input. Native requests before `nativeObserverAttachedMs` remain censored; early
observation does not invent earlier native work evidence. Missing800ms attachment
or incomplete readiness coverage stays indeterminate. No debugger pause, hidden
window, throttling change, fake packaged mode or launch-clock reset is used.

The earlier attachment can overlap ordinary about:blank-to-packaged navigation.
The future-document observer is registered once. Only recognized CDP execution
context replacement/loading errors retry the current passive observation and its
clock handshake, within the original startup budget; attempts and discarded
cross-document clock samples are retained. Source/protocol/interference failures
are terminal. Early readiness requires a visible document before and after both
frames. Before each trusted input, a separate current selected-source/viewport
two-frame proof accounts for already accepted probe markers and preserves the
historical first-ready event. It reads only document length and the bounded prefix;
it does not copy a whole large note. All guard and dispatch costs remain measured.


`--large-note-bytes N` selects an exact ASCII fixture size from1024 bytes through
**5 MiB (5,242,880 bytes)**. The default remains432000 bytes. Its filename, open
metric kind, expected document length and report fixture policy use the actual
byte count; larger fixtures are never labeled432KB. This is a harness bound,
not native capacity or performance acceptance.

`--restore-large` changes only the next process's prepared restore target. First
import still starts with Note0000. After all ordinary cases and Base succeed, the
runner selects the large note through the normal file tree, waits for its current
length/prefix and clean save status, then verifies its whole selected document
once, unchanged physical bytes and exact canonical Core content/entry/revision.
Normal quit and all existing fixture, Base, artifact and PID proofs remain required
before the dependent reopen is allowed. The next process observes that large note
from its ORIGINAL spawn clock with a byte-specific `startup-reopen-largeN` kind.
There is no session, entry-ID, preference or storage injection and no elapsed reset.
Default Note0000 restore preparation and default metric names remain compatible.

For example, append `--large-note-bytes 5242880 --restore-large` to a short100-note
campaign after the default432000-byte control is accepted. No large restore result
is established by the pure helper tests or by merely setting these options.


Empty-profile warming is unmeasured and read-only: it does not request activation
or require foreground/RAF readiness. Passive document/window state is recorded,
while actual app/PID/vault/native authentication, every zero-work proof, normal
app AND Native exits, no owned PIDs and all reset-path checks remain mandatory.
It never arms input probes; measured launches retain every foreground/input gate.

Minimal main lifecycle and real Native-child exit observation starts immediately
after main authentication, independently of renderer setup or foreground success.
Detailed request decoding attaches later to that same lifecycle state. A real
final `quit(0)` and observed child `exit(0,null)` remain required; disappearance of
a Native PID from `ps` does not invent an exit status. Native PIDs seen in the
owned pre-quit process snapshot also require matching actual exit receipts. Warm
setup failures preserve case/activation history plus independently attempted
renderer and passive owned-window diagnostics, even when one observation fails.
