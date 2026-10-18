# Desktop retained-draft recovery

Owner: `recovery_ui_sol`. Isolated branch `tingkai-c/desktop-conflict-recovery`
at `/Users/ctk/orca/workspaces/Zorid/desktop-conflict-recovery`, based on `d788de4`.
Main integration remains exclusively with the shared-core coordinator.

The coordinator's actual desktop/CLI fixture retained a draft checkpoint at an
older revision while the independent CLI saved newer bytes. Killing the desktop
and host preserved both, but restored pane rendering attempted an implicit save
and blocked the entire workspace. Evidence is retained in
`/private/tmp/zorid-race-checkpoint-before-crash.json` and
`/private/tmp/zorid-race-checkpoint-after-crash.json` (coordinator-owned runtime
observations, not reproduced by this worker).

The renderer now loads restored views without an implicit flush, exposes a
note-local retained-draft banner and keeps conflicts navigable by checkpointing
instead of saving on navigation. Explicit Save and global vault/close flushing
still reject unresolved conflicts. Copy draft exports the currently visible
text to the clipboard. Save recovery copy first awaits the durable atomic
nonoverwriting create consumer, then reads the original by stable ID and adopts
its current version only if the editor generation has not changed before or
during checkpoint persistence. Concurrent typing stays on its original
conflicted baseline. Failed creates retain the draft/checkpoint. Recovery-copy
creation requires the adapter's safe `createText` capability.

The workspace startup error now shows plain guidance with collapsed selectable
technical details, copy details, and a renderer-reload retry. Opening another
vault is offered only when no workspace/buffers/panes were installed and the
failed admission's platform lease was successfully released. An installed failed
workspace cannot receive editing hotkeys behind the error screen.

Verification in this isolated worktree on 2026-10-17:

- `node --test --test-concurrency=1 tests/note-buffer-durable-recovery.test.ts tests/startup-error.test.ts`: six checks passed.
- `node --test --test-concurrency=1 --test-name-pattern='restored durable conflict|startup recovery' tests/workspace.test.ts`: three checks passed.
- `node --test --test-concurrency=1 tests/note-buffer.test.ts tests/note-buffer-write-guard.test.ts tests/workspace.test.ts tests/workspace-reading-lifecycle.test.ts tests/workspace-docking.test.ts`: 101 checks passed.
- `node node_modules/typescript/bin/tsc --noEmit` and `git diff --check`: passed.
- Independent source review by `default_lifecycle_review_sol`: approved; no overwrite, generation-guard or startup-admission blockers. Source review does not establish runtime parity.

Dependencies use the existing platform durable checkpoint/write/create
capabilities. No desktop bridge, host, Rust, or platform-selection files were
changed. No heavy build, native launch, actual clipboard proof or mobile pass was
run by this worker. Integration and rebuilt desktop verification of the retained
fixture are coordinator gates. Recovery after an externally removed note and
malformed checkpoints still fail closed. Unclassified live `planWrite` failures
can show the existing Save-failed state until reload establishes a revision
conflict; this change does not redesign provider error classification. Global
close remains strict until the retained conflict is resolved or separately saved.

## Incomplete startup import status follow-up

`recovery_ui_sol` separately owns the standalone `src/ui/import-status.ts` module,
its stylesheet and four narrow module checks. `desktop_default_sol` owns typed
`DesktopReconciliation`/platform retry and reporting; `default_lifecycle_review_sol`
owns workspace mounting, subscriptions and cleanup. This module commit alone
changes no workspace or desktop bridge behavior.

The nonmodal status remains visible for incomplete imports even when some notes
are usable. With no visible files it explicitly warns that notes may exist but
not yet be shown. Details list bounded sanitized issue paths/reasons and import
counts. Retry coalesces clicks, keeps existing notes usable and retains the warning
if checking fails. A complete result clears the warning; null status shows pending
checking. Fatal admission/schema errors remain on the startup error path.

`node --test --test-concurrency=1 tests/import-status.test.ts`: four checks pass.
Strict source typecheck against the desktop owner's actual exported bridge
contract passes via a TypeScript module-resolution override; this branch predates
that export, so whole-project typecheck belongs to combined integration.
`git diff --check` passes. No build or native UI verification was performed.
