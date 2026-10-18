# Tab transfer: reachable behavior, preservation gaps and next boundary

## Scope and evidence

This audit is pinned to Zorid `ba27454`, isolated branch `audit/tab-transfer`. It inspects the current workspace, docking helper, split layout, editor/view handles, NoteBuffer, native window broker and handoff reducer. Later host integration must recheck these findings against its resulting checkpoint. The new tests characterize this baseline; they are not acceptance tests endorsing its known state loss.

Reference claims reuse REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, a partial semantic analysis, and focused reads of the retained Obsidian 1.14.4 artifact. `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js` was rehashed as `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. The offsets in this document are **zero-based Unicode character offsets after UTF-8 decoding**. The older [tab docking audit](../tab-docking-reference.md) uses byte offsets; these conventions must not be mixed. No recovered target code ran or entered project source, and no broad analysis was repeated.

## Reference contracts established in the inspected branches

| Locator in app.js | Static observation | Boundary |
| --- | --- | --- |
| 2916902–2917500, `onDragLeaf` | Drag starts from an existing leaf, requests loading of a deferred leaf, makes a title/icon ghost and selects move semantics. | No modifier-copy branch in this inspected path; not a claim about file/link dragging. |
| 2917500–2922100 | Five-pixel Euclidean threshold; overlay follows the resolved destination. Center insertion into a tab group removes and reinserts the same leaf, adjusts the index for same-group removal, and skips a no-op. Edge drops move the existing leaf into a split. | The helper implements the threshold and geometry; host ownership mutation is separate. |
| 2917500–2922100 | Non-center preview clones the target and presents its remaining space. Sidebar targets have distinct eligibility and insertion handling. | Current helper has only an accent overlay; neither cloned remainder nor sidebar routing exists. |
| 2923320–2924100 | Drop resolution uses the event's window; registered floating splits and main-window sidebars/ribbon toggles participate. | A separately bootstrapped renderer cannot obtain this shared workspace routing by reading a MIME payload. |
| 2924100–2925262 | Edge eligibility is strictly below `.33`, tie priority top/left/right/bottom. Ordinary headers suppress side-edge selection; stacked content suppresses left/right. Preview width/height is at least 40 pixels or one third of the target axis. | Static geometry, not native pointer/zoom measurements. |
| 2925262 onward, `splitLeaf` | Left/right use a vertical split, top/bottom horizontal. Matching parent splits halve the existing dimension; incompatible orientation wraps the target. | Preview one-third size is not final split proportion. |
| 2922100–2922600 | Cleanup can move an outside-dragged leaf into a popout. Exit eligibility follows a 10ms delay and is cleared by re-entry/drop. | Native Escape, OS drops, drag-end coordinates and cancellation remain runtime questions. |
| 2927828–2928430, `moveLeafToPopout` | Source geometry and zoom feed creation; the same leaf is removed from its old parent and inserted into a new popout group. | Same **leaf** identity does not prove that every descendant DOM or engine object survives window migration. |
| 2926200–2926750, `duplicateLeaf` | Duplication separately captures view state, ephemeral state and serialized leaf navigation history. | Navigation history is distinct from Markdown undo/redo. Move and duplicate must remain separate operations. |
| 2658187–2658780, PDF migration callback | PDF window migration explicitly closes/reloads the file and reapplies its prior subpath after loading. | Reference behavior allows intentional child-view recreation. This does not establish preservation of every PDF transient control. |

The previous audits establish popout minimum dimensions of 600×600 and style/zoom propagation. Zorid's current empty-window constructor instead uses 1280×860, minimum 640×480, and receives no tear-off geometry. These are different paths today, not a measured native positioning defect.

## What the current product actually reaches

`src/ui/tab-docking.ts` exports a working intent controller, but `src/ui/workspace.ts` does **not** import or call it at this checkpoint. The workspace still installs per-tab handlers using `application/x-zorid-tab`; the helper writes `application/x-zorid-tab-docking`. Wiring the helper must remove the old handlers rather than maintaining two competing mutation paths.

The legacy handler accepts drops only on tab elements. It inserts before the target tab, without midpoint/after-last insertion or pane-edge detection. It awaits source/destination `flushPane`, captures the limited view snapshots, moves the `Tab` record, fills an emptied source group with a blank tab, then calls `renderPane` on the affected panes. `renderPane` flushes again, destroys pane views and creates replacements. Thus even a simple same-pane reorder replaces its active editor.

| Capability | Baseline result | Evidence |
| --- | --- | --- |
| Reorder or move onto a tab | Reachable through legacy handlers. Source text, parent selection and folds survive the tested reorder. | Workspace lines 352–375; real CM probe. |
| Editor undo/redo | Lost when the active view is recreated. `EditorViewState` contains selection, scroll and folds, not history. | Editor lines 33–47,99–115; undo depth changes from 1 to 0 in probe. |
| Dirty draft | Successful drop forces a save first. Rejected save prevents the move and retains editor, history and recovery draft. | Workspace `flushPane`; NoteBuffer; failure probe. |
| Empty source group | A blank tab is inserted; the source split remains. | Legacy handler; cross-pane probe. |
| Leaf navigation history | Stored on `Pane`, not `Tab`; it stays with the old pane on a tab move. | Pane type and cross-pane probe. |
| Focused table cell | Child edits reach parent source; source and mapped parent selection survive. The focused child editor is destroyed and not reactivated by the tested drop. Parent table undo is lost with the parent editor. | Real child-CM probe. |
| Drag to split | Helper geometry and `SplitLayout` primitives exist; no workspace intent handler connects them. Existing Split commands duplicate the active tab, rather than move the dragged tab. | No helper import; Workspace `split`. |
| Drag out to new window | Helper can emit `TearOffIntent`; current workspace has no callback. Cmd+Shift+N creates an empty window only. | Helper and native `newWindow` handler. |
| Drop directly into an existing window | Helper requires a local drag session and does not accept foreign renderer payloads. | Foreign-payload probe. |
| Sidebar/stacked targets, drag ghost, remaining-pane preview | Reference branches exist; current reachable host does not implement these drag paths. | Focused reference anchors above; helper/host inspection. |

## State preservation contract for implementation

The following is an original implementation contract motivated by same-leaf moves and the explicit user request. It is not a claim that every field was observed at runtime in the reference.

**Same-window movement:** retain stable tab identity and its live content owner. Move its owned DOM into the destination without disposing/rebuilding the editor, table controllers, embed leases or view-specific runtime solely because the pane changed. This retains CodeMirror history and custom extension state without lossy serialization. Preserve focus, forward/reversed multi-selection, editor/container scroll, folds, active table cell/rectangle, navigation back/forward stack, mode, subpath and supported nontext state. Refresh ownership-dependent callbacks after the move. Current callbacks close over `pane`, `renderVersion` and path, so simply reparenting the editor DOM is insufficient: callbacks could invalidate themselves or update the wrong pane. An inactive source tab must not steal the active destination's state during capture.

No successful filesystem write should be a prerequisite for an in-memory local tab move. Keep the existing NoteBuffer/recovery ownership and pending save queue. A failed save, external conflict or ambiguous write is not permission to discard a dirty tab. Source-group removal should collapse the split tree when appropriate; moving the final tab within its own group must not manufacture a new split. Same-group center indices emitted by the helper are already adjusted after removal.

**Separate-renderer movement:** live JavaScript/DOM objects cannot be moved through IPC. Capture a versioned snapshot from each authoritative owner after stopping new edits and waiting for the buffer's current operation to settle. This must not require that operation to succeed or force a save. Preserve current text, saved baseline, pending-write intent, conflict state and revision; parent CM document/history/selection/folds/scroll; active child/table selection and focus intent; leaf navigation history; and view-specific state supported by actual restore adapters. Current `NoteBuffer` exposes no atomic quiesce/export/adopt lease, and its pending/conflict fields are private. Reading public text fields is not an atomic handoff.

`src/core/window-handoff.ts` already validates/clones a bounded JSON envelope and defines offered → ready → committed or aborted transitions. Its editor selection uses CM JSON `main`; the current `EditorViewState` uses `mainIndex`. Convert deliberately. The current handoff tab does not describe pins, navigation history or dedicated child-view state, and the opaque `view.state` field is only a carrier. Neither it nor a passing `EditorState.fromJSON` unit test creates a functioning target view. History serialization preserves standard text undo/redo but not arbitrary custom history effects. Use an explicit unsupported-state outcome until an adapter exists; never replace the requested move with opening the same file path.

PDF, Canvas, images/lightboxes and embeds need distinct adapters or preserved local runtimes. `PdfView` has navigation methods but no complete capture/restore API. `CanvasView` owns private undo/redo, selected nodes, editing and camera state; `flush()` may persist its draft, but recreation is not equivalent state preservation. `ImageView` exposes destruction only. Reference PDF migration shows that controlled recreation is valid, provided the supported semantic state is intentionally restored and resource ownership is correct.

## Cancellation, authority and failed handoff

The local drag helper does not mutate source state before invoking a host callback. Its cancellation/Escape/re-entry/destruction paths clear the drag and preview. A pending host callback blocks a second drag, but `cancel()` does not cancel a host operation already started. The coordinator must own that separate cancellation/settlement lifetime.

`desktop/window-broker.cjs` already authenticates the registered WebContents, its main frame and exact application URL. Each window owns a vault binding/generation; queued filesystem operations revalidate that grant, and compare-and-write is serialized per canonical vault. `newWindow` binds the new window to the caller's current vault. These are useful foundations, but there is no native transfer-token registry, target claim/readiness/commit/status IPC, timeout, or cross-window drop receiver at this checkpoint. A source/window/vault ID in serialized renderer data does not confer authority.

Required outcomes:

1. Before target readiness, source remains authoritative and target is inert: no autosave, edits, recovery deletion or externally actionable view callbacks.
2. Authenticate both participants and bind the offered token to source tab/revision, source and destination window identities, and their authorized vault generation. Reject arbitrary/mismatched vault roots rather than granting access from drag data.
3. Restore supported views and staged recovery completely, then acknowledge readiness. Revalidate source revision/lifetime before commit. Abort/restart if typing, navigation, closure, vault switching or source replacement invalidates the captured owner.
4. Remove source ownership only after broker commit is known. Keep source recovery until the target's committed recovery is durable. Other tabs sharing the source buffer must retain it.
5. On target creation/restore failure, cancellation or precommit timeout, discard the staged target and retain the source, including uncertain pending-write intent. On lost commit reply, query broker status; blindly rolling back can create two active writers.
6. Clean up listeners, timers, preview, staged view resources and temporary tokens exactly once. An external successful drop must not also trigger tear-off. Native drag-end/OS cancellation still requires separate testing.

## Smallest useful isolated next module

Start with **`src/ui/tab-view-runtime.ts` plus its focused tests**, leaving workspace wiring to one integration owner. Give each tab a stable content container and lifecycle owner independent of a pane. A proposed API is `createTabViewRuntime({id, element, dispose, captureFocus})` with explicit `attach(host, ownerContext)`, `detach()`, `focus()` and `destroy()` methods, plus owner/revision access for callbacks. Host-provided adapters retain editor/child resources; destruction is only close/replace, not reorder/move. A lease or transaction around attach must roll back on failed destination attachment and restore focus only after insertion. Validate current owner/revision before any deferred action. This module should manage ownership and lifetime, not duplicate the existing docking geometry or split-tree model.

Acceptance tests should use a real CM editor and table child: same runtime and EditorView after same-window attach, undo/redo and reversed multi-selection intact, child focus preserved, failed/cancelled attach leaves the original owner, stale revisions cannot move, and destroy releases every owned resource once. Then one host patch can render tab chrome separately, attach existing content runtimes, handle `DockIntent` with `SplitLayout`, and collapse empty source groups. This addresses local drag-to-split without waiting for IPC and without baking the current state loss into a new controller.

Next isolated boundaries are an owner-controlled NoteBuffer transfer lease and real editor/view snapshot adapters, followed by a broker-owned handoff coordinator that consumes the existing reducer. Do not start by mapping `TearOffIntent` to `newWindow()` plus `openNote(path)`: that implements an empty/new view, not transfer. Cross-window receiver routing, capability grants, geometry/zoom and native drag cancellation belong to the final integrated gate.

## Validation and limits

`node --test --test-concurrency=1 tests/tab-transfer-gap-audit.test.ts`: six tests pass. Five use actual Workspace and CodeMirror state, covering a real focused table child, pre-drop save failure and synthetic no-drop drag/Escape/end events; one rejects a foreign helper session. The tests intentionally assert the baseline's observable gaps, clearly labeled as audit characterization. Replace those assertions with required preservation behavior when the corresponding host paths change; do not retain a test requiring undo loss as a product contract. The no-drop test does not establish native Escape delivery, and the foreign-payload test does not certify legacy-host authentication.

No full suite, production build or native app was run. Geometry and drag events are synthetic. Native cross-window transport, OS drop results, real pointer thresholds, display/zoom placement, screen-reader behavior and child-engine migration remain unverified. This audit does not certify complete Obsidian drag parity or authorize changing the project's isolated Electron security model.
