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

## Coherent desktop checkpoint, 2026-10-16

Checkpoint `0ddb137` merges root `f5f57f7` with Lucide icons and chrome layout,
working file auto-reveal/collapse controls, compact PDF toolbar and embed menu
anchoring, source-aware live links, sparse inactive caret mapping, and the reviewed
menu foundations. The root live-inline, retained embed-source view and rectangular
table host changes are included. The complete suite passes **747 tests**, TypeScript
passes, and the production webpack build passes with its three bundle/performance
warnings. The initial full run exposed an obsolete integration assertion requiring
embed destruction during source editing; the updated test checks retained DOM,
visible editable source and single final disposal. Its seven-test file and the full
suite then pass. No runtime change was needed for that assertion.

This checkpoint has not yet received root's native visual verification. The new PDF
sidebar, Canvas style refinement, wiki completion, browser-menu hardening and focus
repairs remain separate branches. Workspace/attachment/link menu builders do not
imply complete host wiring. Native popouts, tab dragging, window-scoped recovery and
serialized cross-window writes remain pending. Earlier table/list/inline rows above
are historical checkpoint descriptions; current native and exact parity gaps remain
tracked in the feature-specific evidence documents and user findings queue.

## Multiwindow and viewer checkpoint revalidation

The frozen implementation at `71f2ee8` passes **874/874 tests** using
`node --test --test-concurrency=2 tests/*.test.*` (35.5 seconds), followed by a
successful, separate TypeScript check. These checks were rerun after the session
boundary with no source changes. The production webpack build passed before that
boundary with three bundle/performance warnings; it was not rerun during this
resource-limited revalidation.

This checkpoint includes the actual native new-window bridge and renderer host,
authenticated window/vault ownership, serialized compare-and-write, scoped recovery
and sessions, exact numbered/new-window shortcuts, and cancellation-safe shutdown.
It also includes the PDF sidebar, Canvas style and stale-record repairs, wiki
completion with live metadata, and browser context-menu selection safeguards.
The main IPC test fixture now loads the actual window broker while retaining its
foreign-sender, child-frame and unexpected-document rejection checks.

Native multiwindow and viewer interaction verification remains with root. The
empty-note focus helper still needs installation in `createEditor`; title and
navigation safeguards are integrated. Tab docking and handoff contracts exist,
but state-preserving docking and actual cross-window transfer remain separate
implementation work. No full parity or mobile runtime certification is implied.

## Fixed sidebar controls and file-list background menu host

The workspace now mounts one persistent pair of sidebar controls, keeps tab nodes
inside a separate scrolling strip, and disposes observers and menu ownership when
the shell is replaced. The reviewed wiki suggestion styling is included. Bare
file-list surfaces offer real New note, New folder and New canvas actions; Canvas
creation writes a valid empty document and opens the existing viewer. Pending
folder prompts cannot create in a replacement vault. Creation also carries its
activation revision through the pending source save, so a later pane activation
prevents both new-note and new-Canvas navigation from stealing focus.

The 42 workspace tests and a separate TypeScript check pass, including persistent
control identity across splits/rebuilds, actual menu dispatch and creation, stale
vault/prompt rejection, and both delayed-save activation regressions. Native edge
positions, overflowing tabs, macOS drag/double-click behavior and popup placement
remain root verification work. Full Explorer inline naming, menu icons and Bases
creation remain explicit gaps; the current New folder action still uses a dialog.

The frozen combined implementation at `39f6319` also includes root's reviewed
folding controls, saved fold restoration and active-table-cell focus repair.
Serialized final verification passes **917/917 tests** with concurrency two
(17.2 seconds), then TypeScript, then the production webpack build (3.9 seconds).
Webpack reports its three existing bundle/performance warnings. There are no
skipped tests. Independent host review reran all three original delayed-creation
probes and both permanent delayed-save regressions after the activation fix.
No Electron window was launched for this integration pass; native verification
and closing the test app afterward remain with root.

## Native chrome and folding checkpoint

Root rebuilt `ee44810` and tested the actual Electron application with the saved
`zorid-focus-verification-20261016` temporary vault. Startup restored its notes.
The right control stayed at the outer top edge when expanded. Collapsing the left
sidebar exposed duplicate legacy pane buttons: the older `:first-child` rule had
higher specificity. The sidebar stylesheet now overrides that rule explicitly;
after rebuild and restart, the native accessibility tree contains only the two
persistent sidebar controls in the collapsed state.

Right-clicking the empty file outline opened a native menu ordered New note,
New folder, New canvas. New note created a real file and selected its title;
after title submission, focus reached the note editor. A test note containing a
heading and table rendered successfully. Clicking its heading fold control while
a table cell was active removed the table and focused the parent editor; unfolding
restored the content. Typing `[[` displayed the three current files and the
heading/block/display-text footer with the corrected typography.

Blank-titlebar double-click and drag were exercised and the captured window size
changed, but exact movement, macOS preference variants, split/overflow geometry,
and pixel comparison against the reference remain unproven. This pass establishes
the listed interactions only. Electron exited with code zero; a fresh app
inventory confirmed no Electron process remained. Unrelated apps were left open.

## File-tree host integration checkpoint

The reviewed file-tree batch at `0728a5b` is integrated on top of the verified
plugin/renderer foundation. New folder creates a real unique folder and edits its
label inline; file-tree selection and internal drag moves use guarded snapshots,
case-aware destination checks and the serialized core queue. Rename updates
bookmarks, collapsed folders, selection and pane history paths. Ordinary text
controls retain their platform context menu unless their owning window exposes
the native menu bridge. Reading renderer cleanup and delayed-create activation
guards remain intact after the workspace merge.

Verification passes 113 focused core/helper/host/workspace tests, then **1,200/1,200
full-suite tests** with concurrency two (26.4 seconds), separate TypeScript and a
production webpack build (4.1 seconds, three existing bundle/performance warnings).
No tests were skipped. The core folder validation hook and final host delta were
independently cleared before integration. The heavy checks ran serially; no native
app was launched in this pass.

Native inline-name focus, drag hover/destinations, multi-selection, menu handling
and actual filesystem behavior remain root verification work. Internal move plans
execute sequentially and report partial completion; this does not establish an
atomic filesystem transaction or eliminate external-process races. External drops,
mobile touch dragging and exact visual parity remain outside this checkpoint.

Root's native follow-up on `ef6e864` verified that New folder creates a selected
inline name, Enter commits `Native folder check`, and Escape on a second creation
retains `Untitled folder`. The test used the existing temporary verification vault.
It also found a focus defect: ordinary folder activation replaces the focused row,
leaving focus on the document, so subsequent F2 does not enter rename. This is
assigned to the file-tree owner with a regression request; F2 is not counted as
natively verified. Drag destinations, hover expansion and multi-selection remain
pending. The agent-launched Electron process exited with code zero after save/quit.

## Reviewed renderer foundations from canonical main

This isolated batch starts at canonical `main` checkpoint `5e4ec97`. It integrates
reviewed folder-expansion focus, Canvas text-card Markdown rendering, shared
Reading/Live callout presentation, native local media views and Markdown embed
ownership. It also includes the standalone same-window tab runtime and Mermaid
renderer foundations; their presence does not imply workspace docking, cross-window
transfer, Mermaid engine packaging or production Mermaid host rendering is wired.

Implementation `46edd57` passes **1,280/1,280 tests** with concurrency two (30.4
seconds), followed by separate TypeScript and production webpack checks (5.2
seconds, three existing bundle/performance warnings). No tests were skipped.
Two integration assertions required reviewed updates: editor focus effects can
legitimately replace the whole EditorState while preserving the actual EditorView,
document, multicaret selection, history and fold state; and shared callouts now
place math/code inside their explicit content wrapper. Strengthened semantic and
exact source/count assertions pass. Neither correction changed runtime behavior.

Native checks remain necessary for folder focus, rich Canvas editing, callout
appearance/folding, audio/video decoding and controls, media menus and dimensions.
The media readiness promise indicates settlement, not successful playback. No
native app or external plugin was launched for this batch; root owns verified
promotion to main and subsequent runtime checks.

## Native renderer follow-up and packaged media correction

Root promoted the reviewed batch to `main` (`ed1b604`) and rebuilt it. Native
Electron checks in the existing temporary verification vault confirmed folder
click followed by F2 opens the inline rename field. Reading callouts show the
shared blue note icon/title/background and rendered math/code. Canvas text cards
render headings, inline math, bold text, highlighted JavaScript and list markers;
double-click entered the text editor and Cmd+Enter saved an appended checkpoint,
verified by reading the actual Canvas JSON. Canvas Undo/Redo then became disabled
and Cmd+Z did nothing. This own-save/history defect is assigned for repair, not
counted as a passing Canvas interaction.

A valid original two-second PCM WAV initially failed in the packaged app.
The content policy lacked `media-src`, so local media object URLs fell under
`default-src 'self'`. Reviewed commit `02f3421` adds only `media-src blob:` and a
test of the emitted packaged HTML. After rebuilding, native Reading controls
changed from Play to Pause and back to Play, with the timeline advancing to
0:02/0:02. Live Edit also retained the player; its source button revealed the
embed Markdown while leaving the rendered controls present. This establishes
the observed playback/control behavior, not subjective sound output, video
codecs, exact reference styling, mobile playback or every media menu.

The user then reported deletion of the apparent blank row above the audio hides
the player. Native reproduction found the actual saved source had one newline
between the heading and embed, despite the visual row before the player.
Backspace joined the embed onto the heading without deleting its Markdown;
the player lost normal control layout. Undo restored the source and controls.
This source-row/caret/inline-layout issue remains open and is assigned separately.
Screenshots were partially clipped by the capture surface, so this pass does not
establish full-window pixel parity. All three agent-launched Electron sessions
were closed and their process handles reported exit code zero after testing.

The Canvas history repair was integrated as `c656637` after independent review.
Its no-op reload check compares incoming source with both the rendered snapshot
and mutable document. Native follow-up appended `Undo round trip.` through the
card editor, saved with Cmd+Enter, and confirmed Undo stayed enabled. Cmd+Z
removed the appended text while preserving the earlier checkpoint; reading the
Canvas JSON confirmed the undo reached disk. Toolbar Redo restored the text,
again verified on disk. A final Undo restored the pre-test fixture, and the test
Electron process exited zero. This verifies the reported own-save history bug;
it does not establish complete Canvas interaction parity.

Native verification of `13b11a1` confirmed the corrected file-tree policy:
Markdown, WAV and Canvas displayed names omit their suffixes, while original
`.unknown` and `.constructor` fixtures retain theirs without crashing. Accessible
row names still contain full paths. The focused label/host/attachment checks
passed (32 tests), and the production build passed. This does not add a standalone
audio viewer: opening the WAV directly still reports the missing viewer.
The pass also found file-click/F2 loses focus after navigation; this is assigned
separately from the verified folder-click/F2 repair. The test app exited zero.
