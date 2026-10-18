# Full-parity ledger

Target: an original, open-source recreation of **Obsidian 1.14.4**, with fresh-install UI/UX defaults, compatible vaults and plugins, Electron desktop and Capacitor iOS/Android targets. This is the complete objective, not a promise that the current scaffold meets it. Sync, Publish, Canvas, Bases, graph, plugins, mobile, and all other reference features remain in scope.

Snapshot: 2026-10-16. Source paths below are implementation evidence, not reference-behavior evidence. Every row is incomplete unless a version-bound comparison explicitly proves otherwise. No feature currently has a full-parity certification. A passing unit test proves only its assertions; similar names, a package dependency, or a screenshot alone do not prove compatibility.

The user reaffirmed exact Live Preview, keybinding, mouse, selection, table, Bases,
image and PDF behavior. [The interaction acceptance contract](interaction-parity.md)
defines the required paired observations; current editor primitives are provisional.
The user now requires only Reading and Live Edit in the exposed UI, with full
rendering in both. Legacy Source selections migrate to Live Edit; this requested
mode restriction does not certify the incomplete Live Edit renderer.

## Evidence and status rules

- **Partial:** original implementation exists for some requirements, with named limitations.
- **Missing:** no implementation was present at this snapshot.
- **Unverified:** an implementation or target is declared, but the required runtime comparison/build has not been demonstrated.
- **Verified parity:** reserved for matched reference and clone behavior, documented inputs/outputs and UI evidence across required platforms. No row has this status yet.

Reference artifact identity, REA Evidence IDs, and exact analysis limitations are in [reference-evidence.md](../reference-evidence.md). REA E3 successfully parsed the renderer but its expanded semantic graph exceeded the result budget. This is a specific coverage limitation; it does not prevent further original implementation or imply that every analysis route is blocked.

The [official core-plugin catalog](https://obsidian.md/help/plugins) provides the inventory below. It was consulted on this date and is a moving page, so plugin availability and fresh-install enabled defaults must still be reconciled with the exact 1.14.4 artifact/runtime. The [public API repository](https://github.com/obsidianmd/obsidian-api) documents plugin structure and API entry points, but its latest branch is also not a pinned 1.14.4 contract.

## Desktop UI and workspace

| Requirement | State | Existing evidence and remaining work |
| --- | --- | --- |
| Fresh-install onboarding and vault chooser | Partial / unverified | `desktop/main.cjs` and `src/platform/index.ts` supply a local-folder selection boundary. Welcome screens, create/open flows, help content, defaults, and exact layout require reference comparison. |
| Default light/dark/system theme | Missing parity evidence | Match typography, colors, spacing, icons, borders, native title bar, shadows, hover/focus/disabled states, animation, and scaling against controlled screenshots. |
| Main workspace | Partial / unverified | `src/ui/workspace.ts` and original CSS implement ribbon, sidebars, status bar, tabs, empty views, title editing and collapse/resize controls. DOM integration tests cover selected workflows. Initial Zorid screenshots and native smoke interactions are recorded in `docs/history/desktop-validation.md`; paired reference-runtime comparison remains missing. |
| Tabs and navigation | Missing parity evidence | Open/close/reopen/pin/preview tabs, forward/back history, duplicate notes, tab drag/drop, stacking, and active-focus restoration. |
| Split panes and pop-out windows | Partial | Shared buffers and basic panes are integrated. A reviewed nested split manager supports tree restoration, edge moves, collapse, resizing and stable DOM selection; host wiring and native validation are in progress. Tab docking, pop-outs and exact focus/layout parity remain. |
| Commands, menus and dialogs | Missing parity evidence | Full command inventory, conditional availability, keyboard shortcuts, native/context menus, modal keyboard behavior, notices, tooltips, and fuzzy suggestions. Plugin command registration primitives are not the command palette. |
| Settings | Partial | Basic editor/appearance preferences and displayed hotkeys exist. Every reference section/control/default, editable hotkeys, theme/snippet and plugin management remain incomplete. |
| Accessibility and input | Unverified | Keyboard-only navigation, screen-reader labels, reduced motion, zoom, IME/composition, selection, clipboard, drag/drop, touchpad gestures, and shortcut conflict behavior. |
| Platform UX | Unverified | macOS first, then Windows/Linux desktop differences; native menus, file dialogs, window lifecycle, title bars, spellchecking, clipboard and system integrations. |

## Editing, Markdown, metadata and vaults

| Requirement | State | Existing evidence and remaining work |
| --- | --- | --- |
| Source editor | Partial | `src/ui/editor.ts` uses CodeMirror with history, Markdown syntax, search keymap and link suggestions. Reference keymaps, selection/cursor rules, multi-cursor, fold/indent/list behavior, formatting commands and large-document behavior are unverified. |
| Live preview | Partial | Heading/limited inline rendering, editable tables, checkbox widgets, note/image embed widgets and valid-frontmatter hiding exist. Quote-aware list commands implement bounded Enter/Tab/Shift-Tab behavior. Heading/widget spacing stays inside measured boxes; pointer-held inline geometry is retained until release. Full syntax-aware rendering, grouped marker reveal, IME, math, callouts and complete selection behavior remain. |
| Reading view | Partial | `src/ui/markdown.ts` uses safe DOM rendering, with parser-derived nested/quoted lists, continuations, ordered starts and custom task states. Remaining block/inline rendering is incomplete: escaping, multiline rules, HTML, footnotes, references and exact layout need further work. |
| Clipboard and attachment imports | Partial | Shared transfer handlers import file bytes, route nested table pastes, handle Markdown payloads and URL-over-selection, and insert at current selection after asynchronous reads. Folder/link preferences, timestamp image naming and duplicate allocation have tests. HTML conversion is integrated with an editor preference and own-clipboard marker handling. Native clipboard fallbacks, modifier drops, mobile sharing and OS-level clipboard verification remain. |
| Rich content | Missing / partial | Reading-view note/heading/block transclusion includes relative resolution, bounded/lazy loading, cycle handling, updates and task writes. Images/lightbox use bounded binary loading and URL leases. Live tables now use nested CM cells, parent undo, Tab/Enter navigation and mapped source edits; Reading shares escaped-pipe parsing. Table row/column append controls and native insertion menus exist; full reference context menus are in progress. PDF tabs and embeds use official PDF.js with owned binary data; native rendering, page navigation, search and a Live Edit page-targeted embed were verified on an original two-page fixture. Full PDF UI and interaction parity remain unverified. Rectangular table selection, resizing/reordering, editable note embeds, full syntax highlighting, MathJax, Mermaid, audio/video and queries remain. |
| Internal links | Partial | Wiki/Markdown links, aliases, relative resolution, fragments and rename rewriting exist in `src/core`. Runtime navigation to headings/blocks, autocomplete ranking, unresolved-link creation, attachment links and all ambiguity rules need comparison. |
| Metadata cache | Partial | Real YAML properties, aliases, tags, headings and link offsets are indexed. Saves and known-file watcher notifications update incrementally with bounded I/O. Sections, complete block positions, API cache events and reference semantics remain incomplete. |
| Properties | Partial | Typed YAML operations and editable panel exist. Live Edit hides valid property mappings, protects hidden metadata from body editing, and retains invalid YAML for repair; external panel updates remain supported. Persistent global type registry, exact serialization/interaction and complete view behavior remain. |
| File and folder operations | Partial | Create/read/write/folder/rename/trash and external reload foundations exist in `src/core` and platform adapters. Native UX, metadata timestamps, binary APIs, cross-volume behavior, filename edge cases and exact reference semantics remain. |
| Link maintenance | Partial | Tests cover note/folder moves, incoming/outgoing links and a rollback path. Full link-style settings, concurrency, case-only moves, Unicode, duplicate names and reference comparison remain. |
| External edits and conflicts | Partial | Expected-content checks, watcher/polling, serialized buffers and recovery drafts exist; concurrency/failure tests and rename migration tests pass. Multi-window edits, external rename identity, exact conflict/recovery UI and mobile consistency remain. |
| Existing vault interoperability | Unverified | Ordinary UTF-8 Markdown is supported. `.obsidian` settings/workspace/plugin state, `.canvas`, `.base`, attachments, migration and opening the same vault in both applications need round-trip fixtures. A loss-preserving vault configuration service exists with guarded patches and unknown-value preservation; platform atomic compare-and-swap, hidden-file watchers and host preference integration remain. |
| Durable storage | Partial | Desktop/browser persistence tests and recoverable trash exist. Failed writes, interrupted rename, power loss, recovery snapshots, quotas, permission errors and large vault performance need platform coverage. |
| Import/export and OS opening | Missing | Markdown/PDF export, supported import flows, reveal/open-with, drag-in attachments, share/open-in, deep links and `obsidian://` equivalent dispatch need implementation and validation. |

## Core-plugin inventory

Names follow the catalog; state describes Zorid, not the reference's enabled defaults. “Partial core” means underlying primitives exist without proving plugin UI or behavior.

| Core plugin | Current state |
| --- | --- |
| Audio recorder | Missing |
| Backlinks | Partial core: `MetadataCache.backlinks`; full view, filtering and unlinked mentions missing |
| Bases | Partial document and expression foundations: YAML round trips preserve all four built-in view configurations and plugin-defined fields; a typed evaluator has formula caching and cycle/budget checks. Query execution integration, rendered views, interactions, edits and API integration remain missing; see `docs/reference/bases-reference.md`. |
| Bookmarks | Partial file bookmarks; groups/searches/heading bookmarks and full reference behavior remain |
| Canvas | Partial integrated view: permissive document loading, original interactive cards/edges, pan/zoom, selection, editing and save lifecycle guards exist. A native fixture renders cards and an edge. Complete reference layout, resize/edge creation, embedded content, touch and interaction parity remain; see `docs/reference/canvas-reference.md`. |
| Command palette | Partial integrated command modal and keyboard navigation; full inventory/ranking/customization remain |
| Daily notes | Partial date-named note creation; format/folder/template/settings parity remain |
| File explorer | Partial core file operations; reference explorer UI/UX unverified |
| File recovery | Missing snapshots/recovery UI; trash is a separate primitive |
| Footnotes view | Missing; confirm exact 1.14.4 availability |
| Graph view | Partial static link visualization; global/local graph, filtering, physics and exact interaction remain |
| Note composer | Missing |
| Outgoing links | Partial metadata only; view missing |
| Outline | Partial heading metadata/view; exact navigation and editor integration remain |
| Page preview | Missing |
| Properties view | Partial typed editor and YAML round trips; global registry and exact view parity missing |
| Publish | Missing; see service requirements below |
| Quick switcher | Partial file-name modal with keyboard navigation; ranking and full behavior remain |
| Random note | Missing |
| Search | Partial plain-text vault search and editor search keymap; a structured query engine has scoped operators and ranges but awaits metadata/UI integration and exact result/navigation comparison |
| Slash commands | Missing |
| Slides | Missing |
| Sync | Missing; see service requirements below |
| Tags view | Partial metadata and tag count view/search action; hierarchical/filter behavior remains |
| Templates | Missing |
| Unique note creator | Missing |
| Web viewer | Missing |
| Word count | Partial whitespace-based status count; exact counting/selection behavior remains |
| Workspaces | Missing saved-layout management |

For each plugin, parity includes enable/disable, defaults, settings, commands, menus, persistence, keyboard behavior, edge cases, mobile differences and interactions with other plugins. Discoveries from the pinned runtime can add rows; absence from this preliminary checklist does not remove a target feature from scope.

## Community plugin and theme compatibility

| Requirement | State | Evidence needed |
| --- | --- | --- |
| Plugin package loading | Missing | Load an unchanged `manifest.json`, `main.js` and optional `styles.css`; `require('obsidian')`, version gating, disable/unload/reload, error isolation, per-vault data and desktop-only restrictions. |
| Lifecycle and events | Partial | `src/plugins/{events,component,plugin}.ts` and lifecycle tests cover original event/cleanup primitives. Compare event arguments/order, async hooks and disposal with 1.14.4; these are not a complete host. |
| App/Vault/FileManager/MetadataCache | Partial core, missing compatibility | Public classes, prototypes, return types, binary/text operations, events and errors need versioned conformance fixtures. Internal core data structures do not yet match public API objects. |
| Workspace and view API | Missing | Leaves, tab/split trees, Markdown views/editors, custom views, layout-ready hooks, events, hover sources and pop-out contexts. |
| UI and utility API | Missing | Modals, suggesters, settings controls, notices, menus, icon APIs, DOM helpers, fuzzy matching, Markdown rendering, request APIs, platform flags and public utilities. |
| CodeMirror extension compatibility | Missing | Shared module identities, extension registration, editor transactions and decorations, context fields, syntax tree behavior and cleanup. Merely depending on CodeMirror 6 is insufficient. |
| Node/Electron access | Missing compatibility | Desktop plugins documented to require Node/Electron must be evaluated against an explicit compatible bridge/loading model. Current sandboxed preload offers bounded vault and native context-menu operations. |
| Plugin discovery/install/update | Missing | Search/details, manifest verification, installation state, updates, uninstall, restricted mode and UX. Real community-plugin tests are required. |
| Theme/CSS compatibility | Missing | CSS variables, DOM structure/classes, selectors, custom snippets, fonts and theme lifecycle must be compared; visual similarity alone is insufficient. |
| Extensions and integrations | Missing | Canvas/Bases APIs and integration surfaces present in 1.14.4 must be inventoried and tested, including interactions between third-party plugins. |

## Electron, Capacitor and services

| Requirement | State | Existing evidence and remaining work |
| --- | --- | --- |
| Verified matching stack | Partial | Electron host and webpack-format renderer evidence are established. Zorid pins Electron 44.8.0 for supported-runtime security and uses Webpack; the reference host observation remains Electron 31.6.0. CodeMirror/Capacitor markers are present; their versions, original authoring framework and exact build configuration remain unresolved. Other dependency ranges remain provisional. |
| Electron runnable app | Partial / unverified | `desktop/` entry points and package scripts exist; dependencies installed and TypeScript/Webpack production build passes; authorized agent launch now succeeds. Native checks cover bounded vault/embed/image-dialog behavior, list rendering, table insertion/undo and native menu display; see `docs/history/desktop-validation.md`. Full runtime, packaging, signing, updates, platform releases and native helpers remain. |
| Capacitor app | Partial / unverified | `capacitor.config.ts` and `src/platform/mobile.ts` exist. `ios/` and `android/` projects are generated and synced; plist, Swift syntax and Android XML validation pass. An unsigned iOS Simulator build succeeded with the pinned Capacitor Swift package. Simulator/device operation remains unverified. Android build is blocked by missing Java 21, SDK 36 and Gradle dependencies. |
| Mobile vaults | Partial | Documents/Zorid text/binary adapter and polling exist; binary round trips are covered by mocked plugin tests. Picker/provider access, multiple vaults, iCloud/document-provider behaviors, permissions, device attachment behavior and crash recovery remain. |
| Mobile UI/UX | Missing parity evidence | Phone/tablet layouts, ribbon/navigation, gestures, keyboard toolbar, safe areas, text selection, orientation, theme and accessibility need mobile reference artifacts and matched devices/simulators. |
| Mobile OS integration | Missing | Share sheet, open-in/deep links, lifecycle resume/background behavior, audio permissions, native menus and plugin capability gating need implementation and device tests. |
| Sync-equivalent service | Missing | Cross-device files, attachments, configuration, conflict resolution, version history, selective synchronization, offline recovery, encryption/key handling and service UX remain. Interoperability with Obsidian's hosted service is unverified; an equivalent independent backend alone would not prove that interoperability. |
| Publish-equivalent service | Missing | Selection, links/assets, rendering, navigation, search, site settings, access control and update/removal workflows remain. Hosting and existing Obsidian Publish interoperability are unverified. |
| Open-source deliverable | Partial | MIT license and original source exist. Reproducible installs/builds, documentation, release artifacts and attribution/license inventory remain. Proprietary artifacts and complete REA bundles stay outside project source. |

## Deferred product direction

The user requested a LiveSync-style default sync experience, a built-in FullCalendar
calendar and TaskNotes-style task/calendar capabilities. Discussion and design are
explicitly deferred until the editor foundation is solid; see
[the recorded requirements](../deferred-product-roadmap.md).

## Completion gates

1. Pin the exact reference payload, desktop host and mobile artifacts. Record hashes, OS/device, viewport, scale, theme, language and fresh-install configuration. Record default core-plugin toggles rather than guessing from current documentation.
2. Build a requirement inventory from every reference screen, command, setting, documented API and discovered behavior. Add version-specific details to each row and retain unresolved coverage explicitly.
3. Capture paired reference/clone scenarios with identical fixture vaults. Compare pixels and interaction outcomes, cursor/selection, focus, navigation, timings and persistent files. Use predefined tolerances only for demonstrated platform rendering differences; do not silently waive functional or visual mismatches.
4. Verify vault round trips and failure recovery using representative existing vaults and edge-case fixtures; preserve unknown fields and unsupported content while implementing missing behavior.
5. Run version-bound API conformance and unchanged real-plugin/theme suites on desktop and mobile. Measure API coverage and each plugin's exercised paths; successful loading is not full compatibility.
6. Produce actual Electron packages and Capacitor iOS/Android builds. Run matched platform scenarios and test storage/lifecycle behavior on devices or appropriate simulators.
7. Implement and test service equivalents, including failure/offline/conflict cases. Keep hosted-service compatibility claims separate and supported by evidence.
8. Audit the full matrix, source provenance, licensing, regression evidence and every named target. Mark the goal complete only when every requirement is proven or the user explicitly changes scope. Do not treat missing evidence as a pass.

The immediate next proof should be a buildable integrated workspace and paired desktop scenarios for open vault → create/edit/save note → navigate links → reopen workspace. This is an implementation sequence, not a reduction of the full-parity goal.
