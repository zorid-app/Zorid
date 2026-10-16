# Integration verification checkpoint

2026-10-16, integration branch checkpoint `ecb5aea`.

The isolated Git worktree `/Users/ctk/Projects/Zorid/.worktrees/integration`
combines the editor preference checkpoint with independently reviewed worker
branches. Recovered reference artifacts remain outside the repository. This is a
Zorid integration result, not a declaration of Obsidian feature or visual parity.

## Verified checks

- TypeScript: `node /Users/ctk/Projects/Zorid/node_modules/typescript/bin/tsc --noEmit --project ./tsconfig.json` passes.
- Tests: `node --test tests/*.test.*` passes **427 tests**, with no failures,
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
| Tables | Bottom/right insertion controls, relative insertion menu actions, column model edits, parent history and stale-action checks; stylesheet loaded. | Native menu wiring and pixel/hover/touch verification are separate. Resize, reorder, rectangular selections and complete structural menus remain incomplete. |
| Lists/tasks | Live bullet circles, suppressed unordered task prefix, ordered numbers, indentation guides, shared pointer/IME decoration stability; extension and stylesheet loaded. | Exact reveal grouping, active guide geometry, native caret and touch behavior remain unverified. |
| Clipboard | HTML-to-Markdown conversion with MIME priority, own-copy bypass, image-file priority and dynamic conversion preference API. | OS clipboard formats, local HTML resource remapping, smart list paste and native fallbacks remain incomplete. |
| Transfer boundaries | Search/native control paste cannot mutate the note; pending imports cannot borrow an active path from a replacement vault. | Regressions reproduced before repair and independently rechecked afterward; native clipboard execution is separate. |
| Inline Markdown | Parser-owned nested inline rendering shared by Reading mode and live table cells. | HTML, math, footnotes, reference links and document postprocessors remain outside this module. |
| Native menus | Validated Electron descriptors and popup lifecycle; browser fallback; dismissal API. | Workspace/editor routing and real Electron edit roles require the root integration/native check. |
| Theme | Audited default colors, heading metrics and desktop layout override layer loaded. | No paired reference pixel certification; root owns native verification. |
| Plugin lifecycle | Audited Component/Event/Plugin load/unload and command identity semantics. | Real plugin loader/App graph and broad plugin compatibility remain incomplete. |
| Persistence | Synchronous recovery retained, redundant checkpoints avoided, base escaping cached, no-op updates preserve save deadline. | Distinct edits still serialize/write recovery; multiwindow and large-vault performance remain separate work. |
| Bases/search | Standalone typed expression and query engines with focused fixtures. | They are not yet wired into full Bases views or global search UI/metadata production. |
| Mobile | Storage error propagation and failed temporary-write cleanup. | Mock adapter tests do not prove native filesystem atomicity. See platforms.md for separately verified unsigned iOS simulator compilation and remaining Android prerequisites. |

Canvas and PDF view branches and vault configuration compatibility were not in
this checkpoint. Later commits must be checked against their actual merged
state. Passing these tests does not establish native rendering, pointer hit
geometry, device behavior, full stack equivalence or complete parity.
