# Editor and shared-core integration coordination

Acknowledged by the editor coordinator on 2026-10-16 after reading the execution
checkpoint in `docs/deferred-product-roadmap.md` and the user-relayed handoff.
The editor coordinator remains the primary-checkout/main integrator. Shared-core
work continues on `feat/core-sync-foundation`; its commits are queued rather
than merged concurrently into the primary checkout. Checkpoint `bdc1dd5` has
been read; its existing primary-checkout document edits are preserved, not
silently staged or overwritten.

## Current ownership

- Editor coordinator: canonical main integration, editor/workspace behavior,
  current root dependency graph, and native editor verification.
- Shared-core coordinator: Rust/core/storage/sync contracts and isolated core
  implementation. Client writers wait for the relevant reviewed contracts.
  The user's renewed handoff explicitly assigns new Rust crates, Cargo manifests,
  core prototypes and `src/core/browser-vault.ts` to that session. Existing editor
  and Workspace behavior remain editor-owned. Coordinate existing storage
  interfaces, desktop bridges, platform selection and shared JS build files
  before changing those seams.
- Configurable hotkeys: `parity/settings-hotkeys` owns settings, command bindings,
  and narrow desktop/preload command-menu wiring. Coordinate before touching
  those desktop bridge paths. This work does not redesign the public plugin API.
- Bases: reviewed workspace/session integration owns the existing VaultAdapter /
  NoteBuffer boundary, cache lifetime, pending drafts and failed-write recovery.
- Image resizing: the existing image control helper and a narrow Live-embed
  callback; table context-menu work remains in editor table helpers.

## Handoff and shared interfaces

Supply base SHA, reviewed commits in order, owned paths, dependency changes,
acceptance results and remaining gaps. The editor coordinator reconciles these
with current main in an isolated integration candidate before merging. Never
reset main or another session's branch to force an integration.

Agree the editor/core mutation seam before replacing whole-text callbacks or
NoteBuffer behavior. Preserve unsaved drafts, durable-write acknowledgements,
selection mapping, undo ownership, composition and file-incarnation checks.
CRDT fixture work can proceed independently; it does not establish actual editor
IME or native behavior. Root manifests/lockfiles, platform selection and desktop
bridge changes require explicit coordination before overlapping edits.

## Resource scheduling

Full suites, production builds, dependency installs, packaging and native test
passes are serialized on the 8 GB machine. Confirm the heavy slot before a new
job, publish its exact process/session handle, and report terminal status. An
old ledger entry alone does not prove that a job is still running. Do not kill
another session's process or close its app. No shared lock protocol is implied
until both coordinators adopt one.

At this acknowledgment, the Bases aggregate `e8a48b8` completed 1,712 tests,
TypeScript and production build with no remaining worker process. The next
planned heavy activity is the editor coordinator's native Bases verification.
This is a scheduling snapshot, not a permanent reservation or lock.

## Renewed handoff acknowledgment

The user relayed the arrangement again after editor main `f718f61`. The editor
coordinator read the tracker in `.worktrees/core-sync-foundation` (whose live
ledger reports coordinator work through `49f884a`) and confirmed sole main
integration ownership. No core merge was requested. Core fixture reports are not
treated as editor, native or mobile verification. The primary checkout's existing
uncommitted `AGENTS.md`, roadmap and user-findings changes remain preserved.

Preferred batch delivery is an ordered commit list with base SHA, dependencies,
affected paths, review results, exact validation commands/results and known gaps
in the core worktree tracker, relayed to the editor coordinator. Branch-wide
integration is not automatic. Editor changes in progress concern Canvas, Bases,
hotkeys and PDF views; none takes ownership of the newly assigned Rust/browser
vault paths. Writable Bases embeds reuse the existing VaultAdapter/NoteBuffer
interfaces rather than replacing storage.

At the renewed acknowledgment, the editor browser verification tab and loopback
server were closed and no editor-session heavy build or native app was running.
The Canvas/Table full gate is held pending cross-session scheduling confirmation;
light source review and scoped checks continue. This is not a claim about processes
owned by the separate core session, nor an automatically shared build lock.

## Orca coordination established

After the editor restarted in Orca, both coordinators were found in terminals
attached to the main workspace; the core implementation still uses its isolated
worktree. The core coordinator explicitly acknowledged editor-only main
integration and granted the next heavy slot after its own processes exited.
The Canvas/Table gate completed: 1,873 tests, TypeScript and production build
passed with all three process handles reporting terminal exit zero. The reviewed
candidate was fast-forwarded into main as `87c3eb1`. No core commits were merged.

The editor then explicitly released the slot through the Orca coordination
channel. Core may resume queued heavy checks. The next Base embed/hotkey full
gate or native editor pass requires another agreed slot; bounded source review
can continue. This is an acknowledged reservation/release protocol, not an
automatic filesystem lock. The three other-session root document edits remain
preserved and unstaged.
