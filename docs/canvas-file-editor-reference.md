# Canvas Markdown file-card rendering and editing

This is original implementation guided by bounded static evidence from Obsidian 1.14.4. No recovered source or assets are included, and no reference application was executed.

## Evidence boundary

The retained renderer analysis is E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, with partial semantic graph coverage. The pinned `app.js` SHA-256 is `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Ranges below are JavaScript string offsets from bounded reads of the previously recovered artifact.

| Range | Static observation | Implementation/limit |
| --- | --- | --- |
| 3376363–3379400 | Embedded Markdown cards activate the shared Markdown editor on double-click, excluding interactive children. Blur returns to preview; destruction unloads the child. Starting editing selects the card. | File-card double-click and Edit action activate the existing shared Live editor. Nested inputs retain their events. Blur attempts a guarded flush before returning to preview. A failed save keeps the editor and draft visible. |
| 3381750–3384400 | File cards load the referenced file/subpath into the embed machinery. Markdown children are editable. Labels are outside the content frame; double-clicking the label opens the referenced file. | Full Markdown file cards render actual note content and keep the existing external label. The host resolves a shared NoteBuffer lease. Heading/block previews are explicitly read-only in this iteration. |
| 2625415–2626400 | Shared preview/editor switching transfers scroll/fold information, activates editing, and uses the pointer coordinates for selection. | The shared editor is retained across local preview switches and Canvas geometry refreshes, with pointer placement through CodeMirror. Exact reference scroll/fold transfer, editor recreation policy, transformed geometry and native focus behavior remain unverified. |
| 3389709–3390450 | Text cards also inherit the shared Markdown embed base and save their text through Canvas. | Text cards now use the same shared Reading/Live controller. An internal Canvas session writes only the text field through an identity-checked source transaction and retains the editor across typing, geometry and identical save acknowledgements. |

## Internal ownership and saves

`src/canvas/markdown-card.ts` owns the shared Reading renderer, shared Live editor, preview embed children, session subscription and activation state. `CanvasMarkdownSession` is an internal feature adapter, not a public plugin API. The workspace supplies full-note snapshots, synchronous `update(next, expected)` compare-and-set, notifications, pending state, `flush`, editor capabilities and resource teardown. The workspace retains the NoteBuffer and recovery draft after the card session closes.

Every file-card edit targets the referenced note, not Canvas JSON. A rejected compare-and-set keeps typed source and its old expected snapshot; later notifications cannot silently replace that draft. Failed persistence keeps the accepted shared-buffer draft. Card removal or replacement is blocked while unsaved note state exists. Canvas flush includes file-card flushes; destruction itself never initiates a write. Shared editor undo is independent of Canvas geometry undo.

Preview task toggles use the renderer's original source line and the same compare-and-set path. A rejected toggle restores the prior marker instead of implying a successful edit. Accepted toggles remain visible when persistence fails and can be retried. Retained controls are bound to the preview generation. Read-only and heading/block previews disable task checkboxes; fragment preview text is never submitted as a whole-note edit.

The host adapter must enforce vault, file and shared-buffer identity for accepted writes, synchronize existing note tabs and other cards, and avoid tying already accepted dirty writes to a disposed card's lifetime. Its separate tests and integration commit establish that boundary; isolated UI tests alone do not.

## Verification and remaining work

Focused tests exercise actual CodeMirror transactions, source callbacks, note undo, preview refresh, delayed loading, subscription cleanup, failed persistence, compare-and-set conflicts, fragment/read-only guards, task controls, file-only writes and retained editor identity during Canvas movement. JSDOM geometry is synthetic. Existing Canvas model, menu, rendering and own-save history regressions remain applicable.

Implemented floating control: Edit. Full reference selection-toolbar ordering/actions, heading/block in-place editing, precise scrolling/fold transfer, resizing, mobile gestures and complete visual parity remain unimplemented or unverified. The shared renderer/editor also retain their separately documented rendering limits.

Native checklist for integration:

- Open a file card such as Courses: confirm actual note body, external caption, selection outline and Edit control.
- Double-click text, type, scroll, select and undo inside the card; verify Canvas geometry stays unchanged.
- Open the same note in another tab/card, edit both directions, dock the Canvas tab and verify focus/history and saved Markdown.
- Toggle a preview task, retry a failed save, and verify read-only/heading/block task controls cannot pretend to save.
- Change/delete the file externally, then close/remove the card with clean and dirty state; verify conflicts never overwrite another file or discard a recovery draft.
- Close during delayed load/save and verify math, code, embeds and editor resources are released without late writes.

No native screenshot or reference runtime comparison was performed by this worker. Integrated native verification belongs to the root workflow.

## Text cards and file insertion follow-up

Text-card double-click and Add card activate the shared Live editor rather than a textarea. CodeMirror owns focused text history, selection, syntax and Markdown widgets. Accepted source changes enter the existing Canvas save queue without rerendering/reparenting the editor from inside its update callback. Not-yet-started text saves coalesce to the latest snapshot (one active plus one pending text write); geometry/scalar operations remain ordering barriers. A held-write regression verifies 100 further text edits produce one final pending write rather than 100 writes. Scalar group/connection labels and URL dialogs remain textarea inputs. Escape flushes and returns to preview; it does not cancel already accepted Live edits. Exact reference undo grouping and blur/scroll behavior still require native comparison.

Text sessions use the projected original record and expected text for synchronous compare-and-set. Concurrent raw-model changes reject edits while retaining the local CodeMirror draft. Incoming replacement cannot discard rejected drafts or failed saves; ordinary queued Canvas history operations can proceed because their complete source snapshots remain in the ordered save queue/history. Reading controls carry both preview-generation and original-record ownership guards, including detached embed controls.

The surface exposes separate Add note/Add media controls and the audited background menu labels Add note from vault/Add media from vault. Its internal vault picker passes a note/media kind to the host; the host performs extension filtering. It also accepts a trusted file-tree drop adapter. Insertion preserves paths, uses world coordinates/default file dimensions, selects new cards and puts multi-file drops in one transaction. An outstanding picker is invalidated by document replacement/source change, a newer picker or destruction. Non-Markdown file viewers are host-owned handles retained across geometry changes and released on file/subpath replacement or removal. The host's actual image/PDF/media capability is established separately; this surface does not claim that a filename button is an embed.

Native follow-up: create a text card from the toolbar, type rendered Markdown, undo/redo after saving, blur/reopen and drag it; insert a real note/image/PDF from the picker and file tree; verify selection, zoomed drop coordinates, PDF text selection/scrolling, focus and saved JSON. Tests with synthetic geometry do not establish these native interactions or visual parity.

Text-card host capabilities currently include source-relative open, paths and initial list options; complete wiki/transfer metadata and ongoing settings notifications remain follow-up work. Attachment interactive children retain pointer, keyboard, double-click and scroll ownership. Context menus preserve child-prevented events and otherwise use the existing Canvas node menu; PDF text-selection and native media menu routing need a targeted reference/native comparison. The retained node-menu evidence does not establish blanket suppression for every interactive child.
