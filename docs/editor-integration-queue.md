# Reviewed editor integration queue

Updated 2026-10-16 following the user-authorized integration ownership handoff.
The shared-core coordinator is now the sole main integrator. The editor session
continues independent implementation and review; it must not mutate main, push
main, or start heavy checks without coordination. This supersedes the older
sole-editor-integrator statements in historical checkpoints.

## E1/E2 acceptance — 2026-10-16

Coordinator candidate `6b96d1f` includes current main `aada3b0`, both reviewed
editor batches, opaque revision invalidation `9e7ecce`, and formatting fix
`a8cfb75` (exact two-file source equivalent of editor `dfbfae7`).

Serialized session 64815 exited 0: focused format-menu 29/29 passed, full suite
1963/1963 passed (108.707s), TypeScript passed, production webpack passed with
three performance warnings (5.910s). The formatting fix has eight deterministic
fail-before cases, verified in the editor's red log; the fixed source passed both
focused and aggregate checks. The earlier aggregate failure was resolved rather
than waived as a timing flake. Independent source review approved the fix and
opaque revision seam.

Main integration is approved for this candidate and evidence while main remains
`aada3b0`. Actual packaged/native interaction and touch verification are still
pending; these checks do not establish those outcomes. Newer E3/E4/E5 and header
work are separate queued batches. The untracked node_modules dependency symlink
is local only and is not part of the integration.

## Main handoff

Main at handoff: `2592ebb3f6b168d5b0fffdefa3ba042c7a240975`.
Local origin/main: `c724601`; seven reviewed/editor-status commits await push.
Only dirty root paths are the core session's preserved `AGENTS.md`,
`docs/deferred-product-roadmap.md`, and `docs/user-findings.md`; none staged.
No editor-owned unfinished changes remain in the primary checkout.

Canvas/Table `87c3eb1` is integrated. All processes exited zero: 1,873 tests
(concurrency 2, 55.620s), TypeScript (1.67s), production webpack (5.730s, three
performance warnings). Independent source/integration/privacy reviews cleared.
`2592ebb` updates three editor status documents only. Root dist contains the tested
Canvas/Table build; the retained packaged app is older. No native/app parity is
inferred from these results. No editor heavy/native/server process remained at
handoff, and the resource slot was explicitly released.

## Batch E1: writable Base file embeds and editor formatting defaults

Isolated Orca workspace: `editor-base-embed-integration`.
Branch: `tingkai-c/editor-base-embed-integration`.
Reviewed product checkpoint: `4a29e122cc47ee3774bb956f78fd4edf400513f6`.
Current main baseline included: `2592ebb`.

Ordered scoped commits (use these resolved commits, or review the equivalent
aggregate; do not duplicate the Kanban/Canvas prerequisites already on main):

1. `0d5666a`: occurrence context, original `e3114bf`. The sole conflict was resolved
   by retaining both existing editor hotkeys and optional embed render context.
2. `db386c5`: Canvas dirty embedded-draft lifecycle, original `4ca382f`.
3. `f5e936c`: independent named-view tests, original `eefb947`.
4. `87a23bf`: named-view controller/session fix, original `bd8357c`.
5. `688f2b1`: writable file-embed host, original `f9c0b1b`.
6. `94230f4`: Bold/Italic defaults catalog, original `bac5bf4`.
7. `4a29e12`: editor consumer and explicit syntax-selection command, original
   `92c9b0a`. Keep this atomic with the preceding catalog change.

The candidate also contains a normal merge of current Canvas/Table main; that
merge carries no additional private/core changes. Only untracked node_modules
is a local dependency symlink and must not be staged.

Validation: the initial Base reconciliation passed 38 focused tests. Independent
combined review reran four actual-host probes against final `4a29e12`: encoded
named views in Reading/Live, duplicate draft isolation, active input with hotkey
rebinding, close rejection, docking, property-only persistence, formatting/undo
and cached restoration all passed. Defaults author ran 46 scoped checks and
TypeScript; reviewer independently passed ten selected cases. Current PDF and
workspace/tab ownership were checked during reconciliation. Full suite, final
aggregate TypeScript/build, native and mobile checks have NOT run on E1.

Run the full JavaScript suite with bounded concurrency, then TypeScript and
production build, after reconciling with current main and obtaining a resource
slot. Preserve parent/table hotkey injection, shared dirty note buffers, file
incarnation checks, failed-save drafts and Canvas geometry/undo. Neither storage
adapter replacement nor public plugin API design belongs to this batch.

Fenced Base configuration is still missing; a separate audit/plan is documented
in `e2ac390` (documentation-only, original host branch). File embeds use a 320px
fallback pending native sizing verification. Retired target drafts remain visible
and cancelable; renamed targets are not silently rebound.

## Batch E2: Canvas auto-fit and resize auto-pan

Worktree `.worktrees/canvas-resize-fit`, branch `parity/canvas-resize-fit`.
Apply BOTH `45b7ae8` then `6a13e9c809e56e5ef7a928ff30502cbd7824337b` over the
already integrated resize equivalent of `1247482`. The final commit alone omits
implementation. Five owned files; dependency symlink is excluded.

Independent review cleared the complete range after repairing a stale measured
preview when external replacement happens after the first fit trial. Final
34 checks comprise 22 actual-view cases, eight helper cases, three independent
probes and one temporary composition with `4ca382f`; TypeScript and diff checks
pass. Auto-pan does not generate synthetic resize events; fitting is bounded and
retains live editor ownership. Preserve E1's lifecycle hooks when reconciling.
Actual integrated E1+E2 and native/touch geometry remain separate gates. Reference
anchors and remaining snap-guide/settings/group-background gaps are documented
in `docs/canvas-resize-fit-reference.md` on the feature branch.

## Core candidate transferred separately

Orca workspace `core-batch-one-integration`, branch
`tingkai-c/core-batch-one-integration`, clean HEAD `f44b812`.
Contains the seven requested Batch 1 commits plus offline Cargo.lock reconciliation
(added native/CLI dependencies; existing lock entries/pins unchanged). No Rust
build/test was started by the editor. Independent review found a recovery-status
issue: late displaced-inode changes are preserved but omitted from ReconcileReport,
so CLI recover may incorrectly report complete. The core coordinator received
this finding for an owner fix/regression before acceptance. Existing filesystem
mode/metadata preservation and aggregate retained-history memory limits also need
explicit documentation; no production app migration is implied.
