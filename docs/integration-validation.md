# Integration verification checkpoint

2026-10-16, integration branch checkpoint `e479ddb`.

The isolated Git worktree `/Users/ctk/Projects/Zorid/.worktrees/integration`
combines the editor preference checkpoint with independently reviewed worker
branches. Recovered reference artifacts remain outside the repository. This is a
Zorid integration result, not a declaration of Obsidian feature or visual parity.

## Verified checks

- TypeScript: `node /Users/ctk/Projects/Zorid/node_modules/typescript/bin/tsc --noEmit --project ./tsconfig.json` passes.
- Tests: `node --test tests/*.test.*` passes **540 tests**, with no failures,
  skips or cancellations. Log: `/private/tmp/zorid-integration-tests.txt`.
- Production bundle: explicit worktree webpack configuration passes with three
  existing size/runtime-chunk performance warnings. Log:
  `/private/tmp/zorid-integration-build.txt`.
- Worktree was clean at the checkpoint. Scripts were invoked directly because
  the available `pnpm run` rejected the existing allowBuilds-only workspace file
  with “packages field missing or empty.” No dependency versions were changed
  to obtain the result.

## Integrated behavior and boundaries

| Area | Integrated result | Evidence boundary / remaining work |
| --- | --- | --- |
| Tables | Bottom/right insertion controls, native relative insertion actions, column model edits, parent/child readonly propagation, parent history and stale-action checks. | Root observed the native insertion menu. Full row/column menu subtree is still in a separate review branch at this checkpoint; resize, rectangular selection and pixel/hover/touch parity remain incomplete. |
| Lists/tasks | Live bullet circles, suppressed unordered task prefix, ordered numbers, indentation guides and shared pointer/IME stability. Nested syntax glyphs are hidden; the user-requested larger black light-theme bullets are integrated. | Exact reveal grouping, active guide geometry, native caret and touch behavior remain unverified. |
| Clipboard | HTML-to-Markdown conversion with MIME priority, own-copy bypass, image-file priority and live settings wiring (enabled by default). | OS clipboard formats, local HTML resource remapping, smart list paste and native fallbacks remain incomplete. |
| Transfer boundaries | Search/native control paste cannot mutate the note; pending imports cannot borrow an active path from a replacement vault. | Regressions reproduced before repair and independently rechecked afterward; native clipboard execution is separate. |
| Inline Markdown | Parser-owned nested inline rendering shared by Reading mode and live table cells. | HTML, math, footnotes, reference links and document postprocessors remain outside this module. |
| Native menus | Validated Electron descriptors/popup lifecycle and workspace/editor routing; browser fallback and vault-switch dismissal. Root verified a native table insertion popup. | Exhaustive native edit-role, focus, menu-shape and OS behavior verification remains incomplete. |
| Theme | Audited default colors, heading metrics and desktop layout override layer loaded. | No paired reference pixel certification; root owns native verification. |
| Plugin lifecycle | Audited Component/Event/Plugin load/unload and command identity semantics. | Real plugin loader/App graph and broad plugin compatibility remain incomplete. |
| Persistence | Synchronous recovery retained, duplicate checkpoints avoided, and pending write intent recorded before I/O. Retry/reopen reconciles only known base/attempted snapshots and republishes Vault caches after ambiguous writes. | Deterministic deferred-write/failure/recovery fixtures pass; native crash/power-loss, multiwindow locking and large-vault performance are not certified. |
| Bases/search | Standalone typed expression and query engines with focused fixtures. | They are not yet wired into full Bases views or global search UI/metadata production. |
| Splits | Nested right/down split commands, accessible resizers, stable IDs/tree/active-pane persistence, per-tab caret/scroll snapshots, active-pane focus and collapse. Real Workspace + CodeMirror retains surviving EditorView identity and undo history on split/resize. | Synthetic geometry only; native layout review remains. Switching tabs still recreates their editors; retained per-tab undo/folds, edge drag/drop, stacking and popouts remain incomplete. |
| Canvas | File routing, original document/view, guarded serialized writes, flush-before-navigation, pending-save failures and delayed external reload draft preservation. | Root observed cards/edges; full editing gestures, rendered card Markdown, curved edges and complete reference menus remain incomplete. |
| PDF | Official PDF.js 5.3.31 and byte-loaded resources, standalone tabs and Markdown embeds, page subpaths, Find, lifecycle cancellation/release. | Root verified real Electron text/graphics rendering, page navigation, search and a Live Edit page-2 embed; custom reference 5.3.34, full menus/sidebar/mobile parity remain incomplete. |
| Vault config | Typed standalone app/appearance JSON service, unknown-key retention and inert serialization validation. | Not wired into workspace settings or hidden-file watchers; platform CAS/cross-process locking remain outstanding. |
| Mobile | Storage error propagation and failed temporary-write cleanup. | Mock adapter tests do not prove native filesystem atomicity. See platforms.md for separately verified unsigned iOS simulator compilation and remaining Android prerequisites. |

The PDF byte-loading fix and root native evidence through `661adbc` are included.
See `desktop-validation.md` for the precise native checks. Later commits must be
checked against their actual merged state. Passing these tests does not establish native rendering, pointer hit
geometry, device behavior, full stack equivalence or complete parity.
