# Canvas Markdown file-card rendering and editing

This is original implementation guided by bounded static evidence from Obsidian 1.14.4. No recovered source or assets are included, and no reference application was executed.

## Evidence boundary

The retained renderer analysis is E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, with partial semantic graph coverage. The pinned `app.js` SHA-256 is `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Ranges below are JavaScript string offsets from bounded reads of the previously recovered artifact.

| Range | Static observation | Implementation/limit |
| --- | --- | --- |
| 3376363–3379400 | Embedded Markdown cards activate the shared Markdown editor on double-click, excluding interactive children. Blur returns to preview; destruction unloads the child. Starting editing selects the card. | File-card double-click and Edit action activate the existing shared Live editor. Nested inputs retain their events. Blur attempts a guarded flush before returning to preview. A failed save keeps the editor and draft visible. |
| 3381750–3384400 | File cards load the referenced file/subpath into the embed machinery. Markdown children are editable. Labels are outside the content frame; double-clicking the label opens the referenced file. | Full Markdown file cards render actual note content and keep the existing external label. The host resolves a shared NoteBuffer lease. Heading/block previews are explicitly read-only in this iteration. |
| 2625415–2626400 | Shared preview/editor switching transfers scroll/fold information, activates editing, and uses the pointer coordinates for selection. | The shared editor is retained across local preview switches and Canvas geometry refreshes, with pointer placement through CodeMirror. Exact reference scroll/fold transfer, editor recreation policy, transformed geometry and native focus behavior remain unverified. |
| 3389709–3390450 | Text cards also inherit the shared Markdown embed base and save their text through Canvas. | Existing text-card source editing still uses the previous textarea. It has Markdown preview and persistent task toggles, but full Live editor replacement is separate work. |

## Internal ownership and saves

`src/canvas/markdown-card.ts` owns the shared Reading renderer, shared Live editor, preview embed children, session subscription and activation state. `CanvasMarkdownSession` is an internal feature adapter, not a public plugin API. The workspace supplies full-note snapshots, synchronous `update(next, expected)` compare-and-set, notifications, pending state, `flush`, editor capabilities and resource teardown. The workspace retains the NoteBuffer and recovery draft after the card session closes.

Every file-card edit targets the referenced note, not Canvas JSON. A rejected compare-and-set keeps typed source and its old expected snapshot; later notifications cannot silently replace that draft. Failed persistence keeps the accepted shared-buffer draft. Card removal or replacement is blocked while unsaved note state exists. Canvas flush includes file-card flushes; destruction itself never initiates a write. Shared editor undo is independent of Canvas geometry undo.

Preview task toggles use the renderer's original source line and the same compare-and-set path. A rejected toggle restores the prior marker instead of implying a successful edit. Accepted toggles remain visible when persistence fails and can be retried. Retained controls are bound to the preview generation. Read-only and heading/block previews disable task checkboxes; fragment preview text is never submitted as a whole-note edit.

The host adapter must enforce vault, file and shared-buffer identity for accepted writes, synchronize existing note tabs and other cards, and avoid tying already accepted dirty writes to a disposed card's lifetime. Its separate tests and integration commit establish that boundary; isolated UI tests alone do not.

## Verification and remaining work

Focused tests exercise actual CodeMirror transactions, source callbacks, note undo, preview refresh, delayed loading, subscription cleanup, failed persistence, compare-and-set conflicts, fragment/read-only guards, task controls, file-only writes and retained editor identity during Canvas movement. JSDOM geometry is synthetic. Existing Canvas model, menu, rendering and own-save history regressions remain applicable.

Implemented floating control: Edit. Full reference selection-toolbar ordering/actions, text-card Live editing, heading/block in-place editing, precise scrolling/fold transfer, resizing, mobile gestures and complete visual parity remain unimplemented or unverified. The shared renderer/editor also retain their separately documented rendering limits.

Native checklist for integration:

- Open a file card such as Courses: confirm actual note body, external caption, selection outline and Edit control.
- Double-click text, type, scroll, select and undo inside the card; verify Canvas geometry stays unchanged.
- Open the same note in another tab/card, edit both directions, dock the Canvas tab and verify focus/history and saved Markdown.
- Toggle a preview task, retry a failed save, and verify read-only/heading/block task controls cannot pretend to save.
- Change/delete the file externally, then close/remove the card with clean and dirty state; verify conflicts never overwrite another file or discard a recovery draft.
- Close during delayed load/save and verify math, code, embeds and editor resources are released without late writes.

No native screenshot or reference runtime comparison was performed by this worker. Integrated native verification belongs to the root workflow.
