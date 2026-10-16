# File-tree drag and drop

Original implementation informed by focused static inspection of the user-supplied Obsidian 1.14.4 desktop distribution, 2026-10-16. No recovered source is included in Zorid. No target application was executed by this worker.

Reference: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`; `app.css`, SHA-256 `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`. The restored artifact identity is retained in REA extraction evidence `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`. Earlier semantic analysis identity E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` has incomplete expanded graph coverage; see [reference-evidence.md](reference-evidence.md). This pass reads the recovered text directly; it does not claim new REA semantic coverage. Locations below are zero-based character offsets in decoded text.

## Inspected behavior

| Evidence | Static finding |
| --- | --- |
| JS 1501500–1502250 | Tree row drag starts only outside file rename. A selected row delegates to a multiple-item drag; otherwise it starts one file/folder drag. |
| JS 1524500–1526200 | Selected-set dragging uses every selected item when the dragged row belongs to it. The target handler supports internal files/folders/links or multiple files, always reporting a move. There is no modifier-key copy branch for internal tree moves. |
| JS 1510300–1510840 | Drop handlers attach to the root file container and each folder container. Descendant file rows naturally bubble to their enclosing folder. A flat-tree recreation must resolve a file row's parent explicitly. |
| JS 1524850–1526200 | Hovering a new target schedules expansion at 750 ms. Successful local moves target the folder; same-parent moves do nothing. Selected items are validated before descendant reduction. Invalid self/descendant targets reject the whole selection. |
| JS 1444221–1445300 | Batch moves run sequentially inside a link-update operation. Folder descendants are reduced, and each remaining item's target is independently allocated before rename. This is not evidence of transactional batch rollback. |
| JS 1427682–1427860 | Available-name allocation checks case-insensitive existence and starts numeric suffixes at space plus 1. File suffixes precede the final extension; folder names are not extension-split. |
| JS 1733000–1739550 | Desktop starts from native HTML dragstart; the >5 px axis movement check belongs to the mobile drag/context-menu branch. The ghost follows pointer +5 px. Sources and hover elements receive distinct classes. A generic manager supplies scroll-edge handling. |
| CSS 327258–327600, 328855–329700, 500043–500430 | Hovered folder container uses a 10% accent fill and small radius; highlighted title/collapse control use the highlight color. A single source row uses accent fill and accent foreground. |
| CSS lines 3570–3638 | Ghost uses fixed placement, 300 px maximum width, small UI type, 6×8 px padding, small radius, dark translucent background, and a smaller secondary action line. |

Two deliberate safety differences: descendant reduction uses exact directory boundaries, avoiding a literal-prefix or case-fold comparison discarding an independently selected sibling. Collision allocation additionally treats NFC-equivalent spellings as occupied. Case-sensitive distinct source paths remain separate. Cycle checks conservatively reject case/Unicode-equivalent descendants. These choices protect data but are not claims of identical reference internals.

## Implementation and host integration

Files: `src/ui/file-tree-drag.ts`, `src/ui/file-tree-drag.css`, and `tests/file-tree-drag.test.ts`. Import the CSS from the host's stylesheet entry point.

`createFileTreeDrag` takes a stable root element, current entry/row/selection getters, current vault token, stable entry-lifetime tokens, folder expansion callback, and move callback. Each row supplies `path`, `element`, optional folder `container`, and `collapsed`. Folder containers allow the tint to cover descendants as in the reference; a flat tree supports correct destination behavior with a row-only tint. Set each title element `draggable = true`. Remove prior per-row native drag mutation handlers. The controller only authorizes its own local drag session, never trusting external MIME paths as mutation authority.

The stable root must survive folder expansion. Rerender children and update `getRows()` results without destroying the controller during hover expansion. Cancel/destroy it on vault changes, sidebar mode changes, or teardown. Its listeners use event delegation and remove all timers, source/target classes and ghost nodes on cleanup. Starting another local drag is blocked while a move callback is pending. The native dragend following drop does not invalidate an already accepted move; explicit cancel/destroy and vault-token change do.

`getVaultToken()` must return a stable vault identity/generation, not a label. `getEntryToken(path)` must return a stable lifetime identity; change it after deletion/recreation or rename, retain it during ordinary content saves. A file's path or mtime/size pair is insufficient proof of its identity. A host can maintain a token map and update it through structural vault events. The controller snapshots these identities at dragstart and validates them while hovering, dropping and through `context.isSourceCurrent(path)`. The destination folder identity is also captured at drop; deletion/recreation during a pending flush invalidates the operation.

The host's `move(intent, context)` should:

1. Capture the intended vault, flush dirty buffers, then check `context.isCurrent()` and source predicates. Do not look up a replacement active vault after awaiting.
2. Use `executeFileTreeMove(intent, { ...context, getEntries, rename })` against that vault. It validates the entire plan before mutations, skips same-parent sources, reduces descendants, and reserves collision-free target names. Before each serial move it checks source lifetime and reallocates against the latest entry snapshot.
3. Route `rename` through the existing link/buffer-aware workspace operation. Revalidate the operation/source predicates at its queued mutation boundary. Reject an existing destination at that boundary; a preflight inventory alone cannot eliminate another process creating a destination later.
4. Surface `FileTreeMoveError` with its `completed` prefix and cause. A failure stops subsequent moves and does not silently roll back or claim that no items moved. Reconcile tabs, buffers, selection, history and bookmarks through the existing rename event path.

The helper never reads, rewrites, deletes or guesses file contents. Its single-file compatibility payload is `application/x-zorid-file`; the local multiple-file metadata is `application/x-zorid-file-tree`. Other receivers still need their own explicit import/open behavior and validation. The controller does not implement selection gestures; it consumes the current selection supplied by the host.

## Verification and remaining scope

`node --test --test-concurrency=1 tests/file-tree-drag.test.ts`: 20 focused model/DOM tests pass. `tsc --noEmit` passes in the isolated worktree. Tests cover root and folder targets, selected/unselected source grouping, folder descendant reduction, file/folder suffix collisions, case/NFC collisions, invalid paths and cycles, source identity invalidation before/after drop, delayed hover switching, cancellation, duplicate suppression, foreign payload rejection, queued replacement, partial failures and rejected callbacks. Independent review supplies separate exact-hierarchy case/NFC-distinct sibling tests.

These are simulated DOM events without native layout, filesystems or OS drag delivery. The host integration is not part of this module. Native verification must cover dirty buffers and unknown/binary files, physical pointer thresholds, multi-selection gestures, repeated hover expansion while rerendering, root/background and child-row destinations, collision files on case-sensitive and insensitive volumes, vault switching during flush/rename, cancellation and focus delivery, long trees and edge scrolling, and actual light/dark screenshots.

Remaining reference gaps: native/touch drag initiation and mobile context-menu behavior, external attachment import, dragging from links/bookmarks or other windows, manager-wide scroll-edge behavior, exact file/folder/multiple icons in the ghost, selected-folder descendant source tint, and native CSS geometry/typography. The ghost suppresses the native drag image in favor of a local DOM preview; platform image/cursor behavior is unverified. Full file-tree drag parity is not established by this isolated implementation.
