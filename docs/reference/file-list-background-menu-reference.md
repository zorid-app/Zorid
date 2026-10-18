# File-list background context menu

This bounded audit reuses the recovered Obsidian 1.14.4 desktop artifacts and retained REA E3 evidence `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. The expanded graph remains partial. Findings below are direct static inspection; no recovered code or reference application was executed or copied into the reconstruction.

Pinned artifacts under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/`:

- `app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `app.css`, SHA-256 `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.
- `i18n.js`, SHA-256 `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713`.

Offsets are zero-based character positions in UTF-8-decoded text. See [menus-workspace-reference.md](menus-workspace-reference.md) for item/multiselection menus and shared plugin contributions. That document's statement that no general sidebar background entry point was found does not cover the more specific file-list handler identified here.

## Exact background dispatch

The Explorer constructor near `app.js` 1505800–1508100 creates the scrolling file-list container and separately delegates row context events to file/folder handlers. Its load method at 1509300–1510350 installs an additional contextmenu listener on the list container. It prevents the browser default and, **only when the event target is exactly that container**, clears selected tree items, clears the focused tree item, and invokes the ordinary file-context builder with the vault root. It does not target the currently active file or the last focused folder.

`app.css` 498540–498810 makes this container grow into available space, scroll vertically, hide horizontal overflow and carry padding. Thus the blank region below all rows and the container padding are intentional background targets. This is a file-list menu, not a global sidebar/ribbon/header menu. The bounded code does not establish a no-vault Explorer menu; reconstruction code suppresses it when no vault is available.

The root passes through the single-folder branch of the builder at `app.js` 1511800–1516570. Clearing selection before invoking it prevents a previous file multiselection from contributing destructive/move commands. Menu section order is title, open, action-primary, action, info, info.copy, view, system, unsectioned, danger.

| Order/condition | Label | Reference icon | Behavior |
| --- | --- | --- | --- |
| First, root/folder | New note | `lucide-edit` | Create a note in the captured folder; modifier changes the after-create/open path. |
| Second, root/folder | New folder | `lucide-folder-open` | Create a folder in the captured folder and run the Explorer after-create path. |
| Enabled Bases plugin contribution | New base | `lucide-layout-list` | Create a base in the captured folder, open it, request rename-all state. |
| Enabled Canvas plugin contribution | New canvas | `lucide-layout-dashboard` | Create a canvas in the captured folder, open it, request rename-all state. |

All these items use action-primary; there is no separator between them and no submenu in the base root menu. Plugin listener registration controls relative contribution order, so New base versus New canvas is not asserted as a universal order. The base builder always inserts New note and New folder before firing the file-menu hook. English labels occur in `i18n.js` near 56949, 56975, 112851 and 110512 respectively.

The root does **not** receive base Rename, Duplicate/Make a copy, Delete, file-only open actions, or shared copy-path/system actions. The root exclusions in the shared file-menu contributor are at 2888660–2891000. Bases and Canvas folder hooks are at 3240200–3240870 and 3422200–3423650. An enabled plugin can contribute additional items; arbitrary community plugin registration is outside this audit.

## Original implementation and host contract

`src/ui/file-list-background-menu.ts` exports:

- `buildFileListBackgroundMenu({ hasVault, isValid, actions })`: root-specific descriptors and one-shot action dispatch. Only supplied real creation callbacks appear, ordered New note, New folder, New canvas. No file/folder mutation callbacks are accepted. No vault produces no items. Errors propagate to the host.
- `installFileListBackgroundMenu(container, options)`: exact-background routing and popup ownership; returns a disposer. `isAvailable` must require a vault and the Files tab. `getTree` returns the current direct file-tree child. Both bare local wrappers correspond to the single reference scroll container; descendants are excluded by identity, including file/folder rows and their labels.

The installer clears tree selection/focus through the supplied callback before displaying a menu. This callback must not clear the current note's active indicator or retarget the action. The app currently has no separate Explorer multiselection model, so the host can clear focused tree DOM without pretending that the active-note class is selection. It passes the original pointer coordinates and owning document to the shared platform service. Replaced tree identity, detached surface, switched Files tab, newer context event, disposal and the host's captured vault/menu generation all invalidate delayed results. The host must revalidate its own asynchronous write/open steps as usual.

Suggested integration shape in `buildShell`, registered with the workspace's existing disposer list:

```ts
installFileListBackgroundMenu(this.sidebarContent, {
  isAvailable: () => !!this.vault && this.treeTab === 'files',
  getTree: () => this.sidebarContent.querySelector('.file-tree'),
  buildMenu: () => {
    const generation = this.vaultGeneration, serial = ++this.menuSerial;
    return buildFileListBackgroundMenu({
      hasVault: !!this.vault,
      isValid: () => this.initialized && generation === this.vaultGeneration && serial === this.menuSerial,
      actions: {
        newNote: () => this.newNote(''),
        newFolder: () => this.newFolder(''),
        newCanvas: () => this.newCanvas(''),
      },
    });
  },
  // Clear only independent tree selection/focus; preserve active-note state.
  onError: error => notice(error instanceof Error ? error.message : String(error)),
});
```

This is a host-wiring guide, not a claim that a `newCanvas` method already existed at audit time. Integration owns creation of a valid Canvas document and opening it. Bases is omitted until the app has a real corresponding viewer/action. The platform descriptor currently has no icon contract, so the audited glyphs above are a known presentation gap, not silently substituted icons. Modifier-sensitive creation, phone title/count rows, complete plugin composition and exact inline naming behavior remain separate gaps. The platform also lacks a popup ownership token; purely programmatic menu replacement without context/keyboard events remains a shared ownership limitation.

Tests exercise root label/order/availability, captured callbacks, one settlement, errors, exact background targets, selection-clear routing, preservation of active-note ownership, non-Files/no-vault states, stale tree/vault/tab/menu results, teardown and the actual browser fallback. These Node/jsdom tests do not establish native Electron menu geometry or full Explorer interaction parity. Root integration performs native verification separately.
