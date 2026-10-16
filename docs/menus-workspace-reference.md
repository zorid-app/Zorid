# Workspace menu contracts: Obsidian 1.14.4

## Scope and evidence

This bounded static audit covers Explorer file/folder menus, tab headers, pane more-options, sidebar tab headers, and tab-group dropdowns. It reuses REA evidence E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` and the earlier [context-menu](context-menu-reference.md) and [workspace](workspace-keymap-reference.md) audits. E3's expanded graph is partial. No reference app or recovered function was executed; source snippets, proprietary implementation, and assets are not incorporated into Zorid.

Recovered artifact directory: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`.

| Artifact | SHA-256 |
| --- | --- |
| app.js | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` |
| i18n.js | `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713` |

All offsets below are **zero-based Unicode character offsets in UTF-8-decoded text**, not byte offsets. English labels were checked in i18n.js at 34989–36170 (interface menus), 50344 (PDF export), 55963–57140 (Explorer), 60391 (folder search), 67182–67300 (bookmarks), and 74294–74450 (system opening). Literal three-dot ellipses match that language bundle.

The inventory distinguishes base callbacks, core workspace event contributions, and enabled-plugin contributions. “Exact” below means the ordered/conditional declarations inspected; arbitrary plugin registration order and runtime native rendering are not established by a partial graph.

## Composition and section order

Menu sorting collects items into sections, preserving insertion order inside a section, then renders sections in the declared order. Sections with the same prefix can become a submenu; different top-level groups get separators; empty groups and trailing separators disappear. Unknown sections are appended according to menu registration. [app.js 1222900–1224950]

| Entry point | Declared section order | Special composition |
| --- | --- | --- |
| Explorer item | title, open, action-primary, action, info, info.copy, view, system, unsectioned, danger | Core file event configures Copy path submenu. |
| Tab header | title, close, pane, open, action, find, info, info.copy, view, view.linked, system, unsectioned, danger | Copy path and Open linked view submenus. |
| Pane more-options | close, pane, open, action, find, info, info.copy, view, view.linked, system, unsectioned, danger | Same submenus; calls pane and more-options hooks, then leaf-menu. |
| Tab-group dropdown | action, close, unsectioned, tablist | Main-area stack/close actions, optional plugin group action, then tab entries. |

Locators: Explorer 1511800–1512220; tab 1579600–1580530; pane 1239320–1239926; group 1556000–1557200. Registration order should not be mistaken for visible order: Explorer Rename registers early but displays in the final danger group, while pane Reading view registers late but displays before split actions.

## Explorer single-file and single-folder inventory

For a single file, or a target outside the current multi-selection, the base Explorer and core workspace contributions yield this ordered structure. Optional plugin contributions interleave in their assigned sections.

| Section | File | Folder | Conditions/action semantics |
| --- | --- | --- | --- |
| open | Open in new tab; Open to the right; Open in new window | None from inspected base/core | Right requires split capability. New window requires popout capability. Open uses the clicked file. |
| action-primary | None from base | New note; New folder | Present for root folder too. Mod click influences creation/open focus behavior in the reference. |
| action | Duplicate (macOS), otherwise Make a copy; Move file to... | Duplicate/Make a copy; Move folder to... | Copy and move excluded for root; move also excludes external-file wrapper type. Duplication obtains an available destination path then runs after-create behavior. |
| info.copy | as Obsidian URL; from vault folder; from system root | from vault folder; from system root | URL only files. Vault path excluded for root. Full path requires desktop filesystem adapter and nonroot target. |
| system | Open in default app; Reveal in Finder (macOS), otherwise Show in system explorer | Reveal in Finder/Show in system explorer | Default app uses Share label on mobile app. Reveal requires desktop filesystem adapter and nonroot target. |
| danger | Rename...; Delete | Rename...; Delete | Both absent for root. Delete routes through file-manager deletion prompt, not an unconditional filesystem call. |

Base: app.js 1511800–1516570. Core file-menu hook: 2888660–2891000. Movability predicate: 1444864. File-menu event source is `file-explorer-context-menu` with no leaf. After contributing actions, Explorer associates the menu with the clicked tree item and sets that item as tree focus. This is not permission to silently retarget an async action to a later focused file.

A root folder's base menu is New note/New folder, with optional plugin creation actions. It has no base copy, move, path, rename or delete items. A folder is not eligible for the file-only open/default-app/URL commands.

### Multiple Explorer selection

When more than one tree item is selected **and the clicked item belongs to that selection**, the single-target path is replaced. Base contribution: New folder with selection (N item/items), then Delete; `files-menu` adds Move N items to... in action. Group creation uses a reduced set with descendant duplicates removed; the displayed new-folder count uses that reduced set, while the move count uses the original selection count. Deletion iterates the selected files and rechecks existence before prompting each. The core multi-selection path does not add single-file open/path/rename/duplicate commands. A phone title gives selected file count. [app.js 1512050–1513950, 2890950–2891300]

The original module in this change deliberately exposes only a single Explorer target builder because the present host has no compatible Explorer multi-selection controller. This inventory documents the missing behavior rather than substituting single-target actions for selected files.

## Tab-header inventory

Every tab view contributes Close. Outside sidebars, it additionally contributes:

1. Close others if any other unpinned sibling exists.
2. Close tabs after if any later unpinned sibling exists.
3. Close all if unpinned siblings exist and the only unpinned sibling is not exactly the clicked tab.

These bulk targets are captured when building the menu; pinned tabs are excluded. Direct Close can detach the clicked pinned tab. The clicked tab's group determines siblings, not the globally active group. [app.js 1234877–1236200]

Item views then contribute Pin/Unpin when the leaf can pin; Unlink tab for a linked group, otherwise Link with tab... when it can pin; Move to new window when popouts are available. Pin/link items belong to pane, window move to open. [app.js 1240929–1241800]

Only a **visible** clicked leaf receives its pane-menu contributions and `leaf-menu`; a visible mobile tab switcher also suppresses them. Sidebar context is passed as `sidebar-context-menu`, otherwise `tab-header`. Hidden tab headers therefore still have close/pin/link/window-move actions but do not automatically gain Markdown/file pane actions. Menu anchoring uses the clicked header. [app.js 1579600–1580530]

## Pane and Markdown contributions

Desktop pane more-options does not call the tab-menu hook. It therefore does not automatically contain tab Close, Pin, or bulk-close commands. Phone more-options adds Close and Pin/Unpin separately. [app.js 1239320–1240929]

The item-view pane hook adds Split right then Split down in open, when splitting is available and the leaf can pin. Split right is **disabled** for sidebar leaves; Split down is not disabled by that predicate. The actions duplicate the source leaf into vertical/horizontal layout respectively. [app.js 1239926–1240929]

The file-view pane hook adds Rename... in action, Delete file in danger, and invokes file-menu with the entry source and exact leaf. The core file-menu items from the table above then compose into their sections. In particular a visible file tab may have **both** Move to new window (tab action) and Open in new window (file action). They have different effects. [app.js 2630364–2631100, 2888660–2891000]

Markdown adds the following after inherited file/menu contributions:

| Section | Label | State |
| --- | --- | --- |
| pane | Reading view | Checked in preview mode, toggles mode. |
| pane | Source mode | Only in source editor mode; toggles raw source versus Live Preview. **Excluded from Zorid's requested two-mode product.** |
| action | Add file property | Disabled if properties cannot be shown. |
| action | Export to PDF... | Only when PDF export is supported. |
| find | Find... | Opens view search. |
| find | Replace... | Disabled in Reading. |

Locator: app.js 3095374–3097300. Reference registration adds property before source toggle and search before PDF, but section order produces pane before open/action, and action before find. In Zorid, unchecked Reading view returns to Live Edit; raw source mode is not exposed.

## Sidebar and group menus

Sidebar **tab headers** reuse the tab dispatch with sidebar location. They omit bulk close commands; visible leaves get their pane hook with `sidebar-context-menu`. Their exact remaining actions depend on the view class and capabilities, not a universal sidebar-only inventory. Plugin sidebar views that do not inherit item/file views can have only base Close plus their own hook. Main-area split/link availability must not be inferred from “sidebar” alone.

The group dropdown is a separate click/contextmenu entry. Main groups contribute Stack tabs or Unstack tabs, Close all (iterates unpinned tabs), then plugin group contributions and a list of each live tab view title, with current tab checked. Sidebar roots omit stack and group Close all, while retaining tab-list and applicable plugin contributions. This group Close all declaration remains present even if every tab is pinned; it then closes none. The individual-tab Close all condition is different. [app.js 1556000–1557200]

No separate general sidebar-background menu was found in the inspected entry points. Ribbon buttons, sidebar collapse controls, arbitrary sidebar view content, and mobile drawers are not proven to share this menu.

## Bounded enabled-plugin contributions

These declarations were inspected to identify where core-looking actions actually depend on plugins. Their visibility requires the relevant plugin to be enabled. Ordering within a shared section follows listener registration, which can vary with enabled-plugin lifecycle; it is not a universal fixed order established by the graph.

| Plugin/hook | Contribution and condition | app.js offset |
| --- | --- | --- |
| Search | Search in folder, action, nonroot folder in Explorer. | 2707448 |
| Bookmarks | Bookmark... or Edit bookmark, action, nonroot file/folder. Existing bookmark opens an editing dialog; it is not Remove bookmark. Also bookmark tab-group contribution when eligible tab states exist. | 3270312–3271100 |
| Bases | New base, action-primary, Explorer folder. | 3240200 |
| Canvas | New canvas, action-primary, Explorer folder. | 3422263 |
| File explorer | Reveal file in navigation, system, nonmobile file from a source other than Explorer context. | 3454201 |
| Local graph | Linked local graph, view.linked, Markdown file with leaf, not sidebar-context-menu. | 2723584 |
| Backlinks | Linked backlinks view with split capability/leaf/non-sidebar; Backlinks in document pane checkbox when the Markdown view supports it. | 3061955–3062900 |
| Outgoing links | Linked outgoing links, split-capable Markdown leaf, non-sidebar. | 3495049 |
| Outline | Linked outline, split-capable Markdown leaf, non-sidebar. | 3512435 |
| Properties | Linked file-properties view, split-capable Markdown leaf, non-sidebar. | 3526765 |
| Note composer | Merge file action for Markdown except link-context-menu. | 3483106 |
| Slides | Start presentation in view for Markdown. | 3638049 |
| Publish | Publication action conditioned on supported file, flag, entry source. Inner workflow not exhaustively audited. | 3624517 |
| Sync | Version-history view contribution conditioned on file/source. Inner workflow not exhaustively audited. | 3730203 |

Unknown/community plugin items and per-view contributions remain gaps. Sync/calendar expansion is explicitly deferred by project instructions. Unsupported commands are not represented as decorative disabled placeholders.

## Original descriptor builder API

`src/ui/workspace-menus.ts` provides:

- `buildExplorerMenu(ExplorerMenuContext)` for a single file/folder, with root/platform/bookmark state and optional action callbacks.
- `buildTabMenu(TabMenuContext)` for an exact target ID, snapshot of sibling IDs/pinned flags, visible/location state, optional file/Markdown context, pane callbacks and tab callbacks.
- `buildPaneMenu(PaneMenuContext)` for desktop more-options, without inheriting tab close/pin actions.
- `buildTabGroupMenu(TabGroupMenuContext)` for main/sidebar tab lists and supported group commands.

Each returns `{ items, run(id), dispose() }`. `items` contains only typed serializable `ContextMenuItem` descriptors, using the existing native/browser bridge. Closures stay in a private renderer map. `run` settles once, including null/unknown/disabled IDs; it checks required `isValid()` immediately before calling the captured action, awaits it, and propagates errors. `dispose` invalidates pending actions. The caller owns popup showing, generation checks, error reporting, focus, prompts, filesystem semantics and lifecycle.

Typical integration:

```ts
const menu = buildExplorerMenu({
  kind: entry.type,
  isRoot: entry.path === '',
  isValid: () => generationStillMatches() && currentEntryIsCapturedEntry(),
  actions: { rename: () => renameCapturedEntry(), delete: () => promptDeleteCapturedEntry() },
});
try {
  const id = await showContextMenu(event, menu.items, { document: ownerDocument });
  await menu.run(id);
} finally {
  menu.dispose();
}
```

Optional callbacks are capability declarations: absent actions are omitted without empty separators/submenus. Known supported actions can still be context-disabled (sidebar Split right, Reading Replace, hidden properties). Close callbacks receive copied/frozen captured IDs; the host must check that each target still belongs to the intended group and honor current pin policy if it changed during the popup. `isValid` must cover vault/popup/target generations. Once an asynchronous callback starts, it must perform its own later validation before further side effects.

The module preserves core section order and a selected feasible subset. Search and bookmark actions occupy action after core Move; both callback capabilities are original host features, not an emulation of arbitrary plugin listener ordering. It deliberately omits Obsidian URL copying (Zorid must not pretend to own Obsidian's URI scheme), linked tabs/views, mobile Share, plugin creation and sync/publish commands. Native warning styling/icons, accelerators and phone title descriptions are not represented by the current platform descriptor. Bookmark editing is omitted unless a real edit callback exists. Root Explorer creation remains available. Dynamic tab-list labels strip control characters and truncate to the native bridge's 200-character limit; this is a safety adaptation, not a claim of identical reference truncation.

No host wiring is changed by this isolated module. The current native bridge has a 100-entry descriptor budget; extremely large group menus require integration policy or bridge work rather than silently dropping tabs. Reference group menus were not observed to have this budget.

## Validation and outstanding work

Twelve focused Node tests cover file/folder/root inventory and section separators, platform labels, real bookmark-edit capability, captured close targets/pin exclusions, bulk-close conditions, hidden tabs, sidebar split restrictions, pane versus tab distinction, Reading/Replace/property state, stale/dismissed/disabled/duplicate dispatch, async failure behavior, group snapshots/checked state, and native label bounds. TypeScript compilation passes.

These tests verify original descriptor/action behavior, not native popup presentation or end-to-end filesystem effects. Integration still must wire concrete callbacks, ensure visible versus inactive tab semantics, implement supported dialogs and prompts, validate popup lifetime, and run actual Electron pointer/keyboard tests. Multi-selection Explorer, linked views, stacked tab behavior, popouts, mobile menu behavior, plugin lifecycle composition, and uninspected view-specific actions remain incomplete. There is no full-menu or full-workspace parity claim.
