# Sidebar controls and top-bar hit regions

The user requested sidebar controls at stable outer positions in the top tab bar, including when the corresponding sidebar is collapsed, the workspace is split, or tabs overflow. This pass implements the renderer helper and CSS. Workspace mounting and native double-click behavior are separate integrations; no browser or native UI was controlled during this pass.

## Evidence and scope

REA E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` was reimported from the retained `rea-renderer-bundle.json`; its summary view is `ev_415d70cd7f988e2c9ed903f2b5d3be98983f690c32ec5c590ecd12621c6158cb`. It analyzes selected package/renderer source in the shipped Obsidian 1.14.4 ASAR, SHA-256 `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`. The semantic graph is partial because its result budget was exceeded; static/module facts remain available. This is static evidence, not an observation of execution.

Focused reads use the retained recovered `app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, and `app.css`, SHA-256 `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`. The following offsets are zero-based UTF-8 byte offsets, not line numbers:

| Artifact and range | Static observation |
| --- | --- |
| app.js 2889083–2890400 | Workspace owns one left and one right toggle, derives expand/collapse labels from sidebar state, and invokes the corresponding split toggle. |
| app.js 2942700–2946500 | Frame layout selects top-row tab groups through split direction, marks outside header space, and reparents the existing toggles between sidebar/root tab headers according to platform and collapsed state. |
| app.css 233525–235400 | Sidebar controls use header-height sizing and no-drag hit regions. The secondary macOS hidden-titlebar control has fixed top/right positioning. |
| app.css 141508–142450 | Outside top headers reserve native frame space. |
| app.css 213231–213950 | The inner tab-header container is flex/scrollable and a drag region; root overflow is bounded. |
| app.css 222783–223650 | New-tab/tab-list controls have explicit no-drag regions. |
| app.js 1558908–1559500 | macOS double-click handling excludes clickable controls and sidedock tabs, and consults the system double-click preference before minimizing or toggling maximize. |

The reference can reposition the left control when a sidebar changes state. A root-owned stable pair is an intentional original implementation of the user's stronger stable-position requirement; it does not reproduce the reference's reparenting animations. It uses the project's public Lucide facade rather than recovered SVG paths.

## Integration contract

`createSidebarControls(root, { onToggleLeft, onToggleRight })` returns `{ element, refresh, destroy }`. Mount once after the workspace shell exists. Destroy before rebuilding/removing that shell. Callbacks invoke the existing host actions/session persistence; the helper derives state from `left-hidden` and `right-hidden`. It observes root state and structural header changes; editor text/render mutations do not trigger layout refresh. `refresh()` is also available for synchronous host updates. Retained detached or destroyed controls do not call the host.

Import `sidebar-controls.css` after `chrome.css`. The old Mac hidden-sidebar padding rule is disabled while this helper is installed. Keep tab nodes inside `.tab-strip` within each `.tab-bar`, with new-tab/tab-menu buttons as direct bar children. This creates a scroll viewport separate from reserved edge-control space. At mobile widths the wrapper uses `display: contents` and the new overlay is hidden, retaining the existing mobile sidebar affordance. Remove redundant desktop toggle actions from the right sidebar/header and note toolbar; the existing `.pane-sidebar-toggle` and left titlebar are hidden by desktop CSS only.

The desktop left control starts at x=88 on macOS, or ribbon width plus 8 elsewhere. The right control stays 8 px from the outer edge. Both remain in the 40 px top strip regardless of sidebar state; their 28 px width plus 8 px gap is reserved in the relevant sidebar or outer top-row pane header. The helper traverses structural split groups, taking every child of a side-by-side split and only the first child of a stacked split. It marks only the first/last top-row headers for edge reservations. No pane/tab ownership is transferred to the controls.

`data-window-drag-region` identifies top-row pane bars and sidebar tab headers. Whitespace is a CSS drag region; tabs, buttons, links, form fields, and `data-window-no-drag` elements are excluded. The pointer-transparent overlay itself deliberately has no `no-drag` rectangle, which would otherwise override the whole top strip. The native owner must handle maximize/double-click capability and native frame differences; this helper sends no IPC and installs no competing double-click listener.

## Verification and remaining checks

Five tests cover host callbacks/state labels, independent document creation, mixed nested splits, tabbar replacement, split orientation changes, persistent button identity, lifecycle teardown, and CSS scroll/drag boundaries. TypeScript passes. The checks establish original DOM/state behavior and stylesheet structure, not actual Electron hit testing or pixel geometry.

Root still needs integrated native checks for sidebar open/closed positions, tab overflow, deeply nested split layouts, drag from every empty top-bar area, double-click expansion, traffic-light clearance, and fullscreen behavior. Windows native caption-button spacing and RTL layouts remain unverified. No proprietary code/assets were added to the project; this document records bounded behavior and source anchors only.
