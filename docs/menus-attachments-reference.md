# Image and attachment context menus

Focused static inspection of Obsidian 1.14.4, 2026-10-16. This reuses the recovered artifact outside the repository at `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, and retained REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. E3's semantic graph is partial. The offsets below are ordinary source observations in zero-based Unicode characters, not new graph edges or executed runtime evidence. No proprietary implementation or assets were copied into Zorid.

English labels were cross-checked in the supplied `i18n.js`, SHA-256 `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713`. Labels and branch order do not establish native menu presentation on every OS.

## Live Edit images

The image wrapper's `addControls` handler at 3023400–3026500 creates a context menu, associates its owner element, and declares `title`, then `image` sections. Its built-in image rows are:

| Section | Label | Condition and action |
| --- | --- | --- |
| image | Copy image | Added for image controls. Reads the resolved local image's binary bytes, or fetches an external image URL. Desktop PNG/JPEG use native image/clipboard APIs. Another branch writes a PNG-typed ClipboardItem; conversion fidelity is not established. Failure reports a notice. |
| image | Swap file... | Internal embed only. Opens a file chooser and replaces that embed's source range with a newly generated embed link, retaining its title argument. |
| image | Remove image | Deletes the embed's source range using `delete.selection`; this is distinct from deleting a vault file. |
| image | Reset size | Present but disabled when the image lacks a width attribute. Rewrites source dimension syntax and removes rendered width. |
| danger | Delete image | Internal embed with a resolved file only. Prompts for file deletion, then removes the source embed if deletion was accepted. |

The internal-image branch also invokes `workspace.handleLinkContextMenu` before adding Swap file. The menu sorter at 1223380–1224601 groups by declared sections, then first-seen additional section names. Thus all image-section rows remain together before the built-in link sections even though additions interleave in source. It inserts separators between different top-level groups. The shared link handler at 2941175–2942700 adds a phone-only title and open-link row, then Open in new tab, conditional Open to the right, Rename..., and emits `file-menu` for resolved files. An unresolved link instead gets Create this file. Plugin/core event contributions can add or reorder other sections; an exact complete menu requires those registrations and platform state.

The system actions visible in a separate shared file-menu contributor around 2888600–2890650 include Open in default app (Share on mobile apps) and platform-specific Reveal in Finder / Show in system explorer; reveal requires the desktop native adapter. This establishes labels and capabilities, not unconditional presence for every image surface. The embedded browser's separate image menu around 3005000–3006200 includes saving and copying an image/link; it is not the Markdown image menu and is not reused here.

## Standalone and Reading boundaries

The standalone image view at 2631600–2632700 delegates to `wC` at 850592, which creates an image, applies dimensions, and awaits load/error/timeout. Neither inspected function installs an image context menu. Its base view's pane-menu code at 2629900–2631000 adds Rename... and Delete and emits `file-menu`; a pane menu is distinct from right-clicking image pixels. The reading image embed at 2681617–2682200 uses the same display helper. Reading DOM event registration around 2021000–2022500 delegates `img,video` click/contextmenu to an optional callback; this focused pass does not close the caller's platform/menu policy. Native default menus, Reading image menus, phone/touch behavior, plugin contributions and runtime ordering remain unverified.

## Original implementation and ownership

[attachment-menus.ts](../src/ui/attachment-menus.ts) builds a bounded image/open/action/system/danger menu from explicit optional host callbacks. It uses the shared `showContextMenu` platform boundary. Local-only actions are excluded for external images. Reset size is disabled without width; Remove image and file deletion remain separate capabilities. No URL is fetched and no system app, reveal operation or clipboard write happens without the corresponding host callback. Missing capabilities omit their rows; no empty groups or separators are emitted.

The standalone [image-view.ts](../src/ui/image-view.ts) accepts an optional fourth argument with `copyImage(bytes, type, path)`, `openExternal(path)`, `reveal(path)`, `isMac`, and `onError`. These standalone image-pixel menu actions are an original capability-gated enhancement, not a claim that the scoped standalone reference functions install the same menu. Copy obtains bytes through the viewer's owned attachment lease, checks that the owner and menu generation remain current after reading, and only then calls the host. It never passes an object URL to a system callback. Closing the viewer or opening a newer menu invalidates delayed menu replies and byte-read completions.

Embed integration calls `showAttachmentMenu(event, target, actions)` or uses `attachmentMenuItems` for composition. `target.isAlive` must validate the embed's owner, resolved path and render generation. The helper rechecks it after the menu reply, rejects unknown/disabled action IDs, and reports failures only to a live owner. A host action that performs further asynchronous reads must revalidate before its own side effects; the helper cannot retract an already-invoked native operation. Edit actions should only be supplied when the receiving editor can safely mutate the captured source range. Plugin menus, file choosers and deletion prompts belong to the host rather than this module.

Validation covers ordered/conditional rows, disabled reset, external-image restrictions, missing capabilities, forged/dismissed native replies, closed owners, superseded menus, deferred byte reads, error callbacks and actual copied bytes. Existing attachment resource/lightbox tests remain passing. Synthetic DOM and stubbed host tests establish neither native clipboard encoding nor reference visual/runtime parity.
