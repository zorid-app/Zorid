# Normal editor Rust opt-in

This source slice selects the shared Rust vault for one explicitly configured
**disposable, already initialized and enrolled** vault in the normal Electron UI.
Other folders continue using the existing filesystem service. This does not
migrate real vaults, implement production window identity allocation, or enable
physical namespace reconciliation. Existing-text durable save also requires the
separately owned NoteBuffer/Workspace consumer and native enrolled-write intent
routing (`76dcb2a`). New-file, binary, rename and deletion UI mutations remain
follow-ups; the legacy mutation methods deliberately reject on this adapter.

## Trusted startup

Run the normal Electron entry point with these environment values set by the
main-process launcher, using a fresh matching build and protected fixture config:

- `ZORID_EDITOR_RUST=1`
- `ZORID_FIXTURE_VAULT`: absolute disposable vault root.
- `ZORID_DESKTOP_HOST_BIN`: absolute freshly built desktop host binary.
- `ZORID_FIXTURE_SYNC_CONFIG`: absolute protected native relay fixture config.
- `ZORID_FIXTURE_CLIENT_ID`: fixed canonical UUID for this fixture window; reuse
  it on restart so durable checkpoints remain attributable to the same consumer.

Do not combine this mode with `ZORID_DESKTOP_FAMILY_FIXTURE=1`, which selects the
separate core verification window. Pick the configured folder using the normal
Open vault UI. Only the primary window may select it; split panes share its
admission. The renderer cannot supply executable/config paths or client identity.

`desktop/editor-core.cjs` acquires the native lifetime lease and supplies a scoped
DurableWrites capability. Each RPC rechecks the actual WindowBroker sender and
captured generation, including immediately before queued native dispatch. Text,
plans, refs and checkpoint bodies use the existing bounded provider protocols.
The bridge returns sanitized failures and preserves unknown-commit status.

## Consumer lifecycle

`PlatformVault.adapter.durableWrites` is optional; its checkpoint scope contains
the persistent local authority and trusted client ID. Its platform ID is
`desktop-core:<local authority>:<client>` so a recreated folder cannot inherit
another store's recovery data.

The consumer must recover checkpoints before enabling edits, and await final
flush/checkpoint before `PlatformVault.release()`. Release drains accepted work
and relinquishes native ownership; it does not fabricate save/ACK success. Call
release before opening the folder picker. If the picker is cancelled or fails,
call existing `createPlatformAdapter()` to reacquire the currently selected vault
and replace the released capability before resuming edits. Exact release retries
are idempotent even when the IPC acknowledgment was lost.

A closed renderer leaves persisted recovery state intact; closing its child
releases the kernel lock. Normal Electron close/quit is intercepted for the selected Rust vault. A
main-created request token invokes the renderer's asynchronous onBeforeClose
handler; Workspace flushes and releases before acknowledging. Main verifies
the matching window generation and released admission before closing. A failed
flush keeps the window open. This does not rely on awaiting beforeunload.
Application quit also waits for child closure. The existing family journal drives read/cache
notifications; this mode does not run the legacy disk importer or filesystem
watcher. No background relay loop is installed by this slice.

## Integration and evidence

Owner: desktop integration, isolated `tingkai-c/desktop-editor-core` based on
`1e5ffdb`. Dependencies: host/bridge family commands `3ef94f8`, shared native runner
`e0dba5c`, matching schema8/native family implementation and enrolled-write intent
routing. Preserve the separate `dadf4a5` fixture branch when merging main.cjs.

Source syntax and whitespace checks passed. No TypeScript build, Electron launch,
actual save/restart, or sync verification has run for this slice. The combined
acceptance is: open configured vault in the normal editor, edit an existing text
file, observe a durable native receipt and clean checkpoint, restart with the
same client UUID, and verify bytes through the independent CLI and relay peer.
Cancelling vault selection must reacquire the original capability before editing.


Combined source candidate: `tingkai-c/desktop-editor-combined`, based on main
`a4ee10a`; includes host `3ef94f8`, dedicated fixture `dadf4a5`, normal bridge
`4c80179`, durable consumer `a9237b8` and picker recovery `cf209df`. Both startup
branches are retained. Async close handshake and Workspace callback complete the
source integration; native compilation and actual Electron save/close/restart
remain required before reporting this path usable.


### Combined build evidence — 2026-10-17

Candidate `67eb63b` in `desktop-editor-combined` passed:

- `node node_modules/typescript/bin/tsc --noEmit`: session46590, exit0.
- `node node_modules/webpack/bin/webpack.js --mode development`: session15318,
  exit0, compiled successfully in 2061ms. Normal editor `dist/` generated;
  no browser-WASM fixture selection needed for the desktop core bridge.

Four changed desktop entry/bridge modules also passed `node --check`, and
`git diff --check` passed. Dependencies used a temporary symlink to existing main node_modules; no install
ran. The symlink was removed after building. Heavy slot released after webpack.
No Electron window was launched and no native save/sync/restart was exercised by
these checks. Root coordinates the matching host build and actual smoke next.

### Actual runtime correction — family journal reload events

The first normal-editor smoke exposed `invalid_response` after a family write.
Native schema8 correctly emits `requires_full_reload:true, entries:[]` for
validated local-command and received-update origins. The JS journal validator
incorrectly restricted these events to bootstrap, killed the host, and caused
subsequent list/save calls to fail. The adapter already supported coherent full
snapshot reload; the correction accepts that declared journal shape while
retaining origin validation and empty-versus-incremental entry invariants.

Focused verification session37082 exited0: two family-journal regression tests
passed. A separate read-only real host using binary5c68619 against disposable
`/private/tmp/zorid-cli-family-20261017-0910` then accepted all12 journal events,
listed cursor12/two visible entries, and read cli-note.md (34bytes), with the
transport still alive. The child was closed normally. The existing Electron
window and its retained draft were not closed, replaced or retried; a fresh
actual-editor recovery/save smoke remains coordinator-owned.

### Explicit new-note creation

The New note runtime failure (`durable_consumer_required` from legacy write)
is addressed by optional `VaultAdapter.createText`, used only by `Vault.create`.
Existing modification still follows its prior path; the guarded Rust editor
uses DurableWrites for existing-note saves. Legacy native writes remain disabled.

A new main-owned creation consumer persists the exact operation ID, entry ID,
path and text in `create-text/v1/` scoped checkpoints before invoking the narrow
leased native `create_text` command. Rust requires a matching client lease,
valid UTF-8, an already-bound fixture configuration and explicit text create
mode. The common family apply owns transaction/receipt/outbox idempotency. A lost
reply preserves the command; startup recovery replays it with identical IDs and
bytes before enabling the editor. Durable receipt confirmation permits checkpoint
tombstoning. Definitive rejection is retained and never converted to overwrite.

Host source commit `9fe9571`; native owner combines/builds it with the current
namespace candidate. Focused create-consumer checks pass3/3; the explicit Vault
create-versus-modify dispatch regression passes1/1. The first Vault attempt was
blocked by missing yaml resolution after the prior dependency symlink cleanup;
restoring the existing-dependency symlink made the focused test pass. No install
ran. Renderer build and actual New note interaction are still pending, and the
user's live editor/draft have not been closed or changed by this work.


New-note combined verification: native owner built CLI+host candidate `292cd27`
(including host `9fe9571`) in session83593, exit0. Desktop candidate `503f479`
then passed full TypeScript plus development webpack sequentially in session23419,
exit0 (webpack1698ms). Focused creation regressions pass4/4 and Vault explicit
create dispatch passes1/1. Source review found the sanitized native rejection
codes `invalid_request` and `not_found`; `503f479` classifies these deterministic
errors as retained terminal rejections so they cannot poison restart recovery.
Corruption/unknown/storage errors remain pending. Reviewer confirmed the fix.

Matching host is `core-native-cli-combined/target-native-family-create/debug/`
`zorid-desktop-host`; use the fresh schema8 fixture required by its namespace
batch. The user's live old editor and current document were not closed or
replaced. Actual New note UI/sync evidence remains pending. Temporary dependency
symlink was removed after compilation; no package install ran.
