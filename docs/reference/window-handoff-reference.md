# Desktop window and tab handoff contract

The user requires Cmd+Shift+N to open a new Zorid window and tab tear-off to preserve the existing tab's state. Opening its file path again is insufficient: unsaved text, undo/redo branches, selection, scroll position, view-specific state and tab identity can differ from the file on disk.

This document records a bounded reference audit, current architecture constraints, and an original serializable handoff contract. The contract is implemented; desktop/window/workspace wiring and native verification are separate work.

## Reference evidence

The inspected source is `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, rechecked in this pass. It reuses partial REA evidence E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. Locations below are zero-based Unicode character offsets in UTF-8-decoded source. No reference execution, native window automation or recovered implementation copying occurred.

| Source anchor | Static finding | Limit |
| --- | --- | --- |
| 2901740 | A `workspace:new-window` command creates an empty popout leaf and activates it. | The inspected command registration does not itself declare Cmd+Shift+N. That shortcut is the user's explicit product requirement; no reference shortcut claim follows. |
| 2927828–2928430 | `moveLeafToPopout` obtains source geometry/zoom, removes the existing leaf from its parent, resets its dimension and inserts **that same leaf** into a new popout tab group. `openPopoutLeaf` creates a new leaf instead. | Static object movement does not measure lifecycle/focus/geometry or every child view's behavior. |
| Around 2922167 | The outside-drop branch removes the existing leaf and inserts it into a popout with screen coordinates, captured size and source zoom, then activates it. | Native drag eligibility, OS cancellation and display-coordinate behavior need runtime tests. |
| 2899426–2899840 | Open-in-new-window creates a new leaf from view state; move-to-new-window uses the same-leaf path. | These are different operations and must not be conflated. |
| 2926200–2926750 | Duplicate-leaf reads view state, ephemeral state and leaf navigation history, restores the destination state and then navigation history. | Leaf navigation history is not CodeMirror's document undo history. |
| 2616000–2617900 | Auxiliary-window support relays events and synchronizes classes/styles with the main document. | A separate independently bootstrapped renderer is not automatically equivalent to this shared-object popout architecture. |

## Zorid architecture constraints

At audit baseline `578f496`, `desktop/main.cjs` has a singleton BrowserWindow, a singleton vault service and sender validation against only that window. Change notifications target that singleton. `src/ui/workspace.ts` owns renderer-local tabs, pane/view instances and a map of NoteBuffers. Its normal rerender path flushes and destroys child views. A tear-off path must not simply call that disposal sequence before the target is ready.

`src/ui/editor.ts` currently exports view selection and scroll only. A target editor created from that snapshot loses undo history. CodeMirror's installed `historyField` supports `state.toJSON({history: historyField})` and `EditorState.fromJSON(..., ..., {history: historyField})`. The independent tests demonstrate preservation of text undo/redo branches and multiple selections. The installed history serializer omits custom history effects, so this cannot certify preservation of plugin/table effect history or every extension field. Target restoration must use compatible CodeMirror/extensions and must fail before acknowledgment when decoding fails.

NoteBuffer owns text, saved base, pending write intent, conflict state, save scheduling and recovery persistence. Only text/savedText are public at this baseline; an owner-controlled export/adopt API is needed to capture private pending/conflict state safely. A rejected write may have reached disk, so losing pending intent can turn a recoverable draft into a false conflict or overwrite. A failed flush must not silently discard the source tab. Capturing a snapshot requires quiescing that buffer's pending operations without requiring a successful save; an arbitrary public-field read while a write is pending is not an atomic snapshot.

## Implemented contract

[src/core/window-handoff.ts](../../src/core/window-handoff.ts) defines version-1 `WindowTabHandoff`:

| Field | Meaning |
| --- | --- |
| `transferId`, `sourceWindowId`, `vaultId`, `revision` | One transfer, authenticated source identity, exact vault binding and source leaf generation. IDs alone do not authenticate an IPC caller. |
| `tab` | Stable leaf ID, canonical vault-relative path or null, kind, mode and optional subpath. |
| `buffer` | Optional current `text`, `savedText`, `pendingWrite` and explicit `conflicted` flag. These retain recovery intent rather than granting permission to write. |
| `editor` | Optional `doc`, CM JSON `selection` and `history`, plus editor scroll offsets. Document must equal buffer text; the selection must fit that document. |
| `scroll` | Outer view/container scroll offsets, independent of the editor scroller. |
| `view` | Optional typed JSON state supplied only when the target has a real restore adapter, such as PDF page/scale or Canvas camera/selection. This field does not implement those adapters. |

`parseWindowTabHandoff` validates and independently clones JSON. It rejects unknown protocol versions, invalid relative paths, malformed selections, source/document mismatches, accessors, non-JSON objects/functions/cycles, nonfinite numbers and reserved object keys. It explicitly rejects payloads exceeding 250,000 nodes, 64 nesting levels or 32 Mi UTF-16 string units. It never truncates source/history to fit. These are implementation resource bounds, not reference limits. Opaque history/view JSON still needs semantic validation by the real target adapter before readiness.

`offerWindowHandoff` binds a target distinct from the source. `advanceWindowHandoff` is a pure reducer with these transitions:

| Phase | Accepted transition | Ownership/result |
| --- | --- | --- |
| `offered` | Correct target reports `target-ready` with matching token/revision | Target has restored an inert staged view. Source still owns the leaf/recovery. |
| `ready` | Correct source reports `source-commit` with matching token/revision | Broker commits target ownership. Source can remove its leaf only after observing that commit. |
| `offered` or `ready` | Either authenticated participant reports abort | Source retains its snapshot and ownership; target staging must be discarded. |
| `committed` or `aborted` | No further transition | Late acknowledgment, abort or commit is rejected. A lost commit reply requires querying broker state, not blindly reactivating both sides. |

`handoffOwner` describes **leaf handoff authority**, not exclusive ownership of the underlying file: other tabs may still reference that file. `reconcileHandoffBuffer` identifies disk equality with the saved base or explicitly recorded pending write; any independent content is a conflict. It performs no I/O, writes or conflict resolution.

A runtime host must retain the authoritative reducer state, authenticate sender IDs, match the actual target vault, enforce unique pending transfer/tab IDs, expire abandoned offers and keep target edits/autosaves disabled until commit. Source edits or document replacement must advance the source revision and abort/restart the offer. Losing the source process before commit cannot automatically promote a stale target snapshot without a separate recovery policy. These behaviors are required integration work, not implemented by calling a pure function.

## Required host/workspace integration

1. Replace singleton window bookkeeping with per-window records and authenticated IPC routing. Cmd+Shift+N creates a fresh empty window. A drag controller supplies only a tear-off intent with tab ID, source pane and screen geometry; the trusted workspace resolves that ID to current state.
2. Quiesce/capture the source leaf, its buffer and actual editor/view state. Register a broker-owned transfer token. Keep source resources and recovery until success; do not flush-and-close merely because BrowserWindow construction succeeded.
3. Target claims only its assigned token, binds the same vault, validates compatible state, restores an inert view and stages its recovery draft. It acknowledges readiness only after real restoration. No path-only fallback can claim state preservation.
4. Revalidate source revision and commit authority through the broker. Enable the target and retire the source tab after commit. Failures before commit retain the source; ambiguous late outcomes consult broker state. Source windows with other tabs sharing the file keep their own buffers.
5. Scope workspace/session and recovery storage by window/owner as well as vault. The baseline vault-only draft/session keys allow one renderer to overwrite or delete another renderer's recovery/session data. An explicit shared-document broker is another valid design; shared localStorage alone is not one.
6. Serialize optimistic compare-and-write at the main-process vault boundary. Baseline `Vault.modify` performs a renderer-side read check followed by a separate write. Two renderers can both pass that check and then overwrite each other. One host operation must compare expected content and write within the same per-vault/path queue, with change notifications broadcast to every attached window. This protects cooperating app writers; external-process races still need separate consideration.
7. Add genuine PDF, Canvas, image and graph capture/restore adapters before promising those view states survive tear-off. Preserve errors/unsaved content, restore focus and scroll after layout, and validate close/quit/reload failures. The tab ID must remain stable across the transfer.

## Validation and open boundaries

Eight tests in [window-handoff.test.ts](../../tests/window-handoff.test.ts) pass, including an actual CodeMirror serialize/restore/undo/redo sequence with multiple selections; cloned snapshot independence; exact token/revision/participant checks; ordered readiness/commit; precommit abort; terminal replay rejection; disk-base/pending reconciliation; malformed payload rejection; and empty/graph tabs. TypeScript passes.

This patch supplies a tested contract and architecture evidence. It does not create windows, bind shortcuts, implement drag-out, serialize a live NoteBuffer, add host compare-and-write, restore PDF/Canvas internals, or establish native same-leaf parity. Those required operations remain coordinated integration work and must be verified with dirty buffers, undo/redo, multiple windows editing the same file, target startup failure, source closure and interrupted acknowledgment.
