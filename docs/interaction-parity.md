# Exact interaction parity acceptance contract

The user explicitly requires the same editing and viewing behavior as a fresh
Obsidian installation. This requirement covers the entire application, including
Live Preview, keybindings, mouse/cursor/selection behavior, tables, Bases, images,
and PDFs. A similar-looking component or basic Markdown support is not acceptance.
No current implementation is certified against this contract.

Reference payload: Obsidian 1.14.4. Installed macOS Electron host: 31.6.0.
The exact loaded runtime, operating-system settings, default core-plugin states,
mobile reference artifacts, input devices, and display scale still need recording.

## How a scenario becomes verified

1. Begin with an identical fixture vault and recorded fresh-install configuration.
2. Record platform, app/runtime versions, viewport, scale, theme, font, language,
   keyboard layout, and input method. Use a separate disposable reference vault.
3. Apply the same ordered physical actions in both applications. Record modifiers,
   keydown/up, pointer buttons, click count, pointer location, scrolling, dragging,
   composition, and timing where behavior depends on it.
4. Compare document bytes, logical cursor/selection (including direction and
   multiple ranges), visible syntax, editor mode, focus, scroll position, menus,
   accessibility state, screenshots, persisted configuration, and file changes.
5. Check undo/redo and repeat after reopening the note/application. Confirm no
   hidden implementation fallback changed what the user experienced.
6. Record the actual paired evidence and failures. A scenario with missing
   reference observations remains unverified; self-consistency tests alone cannot
   pass it. Any tolerance must be tied to measured platform rendering differences.

REA static evidence identifies investigation targets and candidate behavior.
Static syntax, names, and module inventories do not prove interaction outcomes.
Runtime observation must use the available authorized tools; a previously denied
UI access request must not be bypassed with another automation mechanism.

## Editor scenario inventory

| Surface | Required cases and state comparisons |
| --- | --- |
| Modes | User-requested exposed modes: Reading and Live Edit only. Both render the entire document; preserve rendered tables, embeds, images and properties while editing through their appropriate controls. Switch with button/menu/shortcut; retain cursor, selection, scroll and document; split reading/editing views; migrate old Source selections to Live Edit. |
| Live Preview transitions | Enter/exit every formatting span and block with keyboard and pointer; reveal/hide markers; selection across boundaries; empty/incomplete/malformed syntax; nested and adjacent marks; widgets next to text; first/last line. |
| Text and cursor movement | Character, word, visual line, logical line, paragraph and document movement; wrapped lines; Home/End; macOS modifier variants; Unicode, emoji, combining marks, RTL/bidirectional text and tabs. |
| Selection | Shift and modifier extension; forward/reverse selections; mouse single/double/triple clicks; drag across lines/widgets/panes; select-all scope; multiple cursors/ranges; keyboard selection after pointer actions. |
| Keyboard dispatch | Inventory every default global/editor/core-plugin hotkey, context-dependent dispatch and precedence; modal/text-field focus; disabled commands; key repeat; OS-reserved shortcuts; keyboard layout/input-method differences. |
| Mouse and touchpad | Click targets, caret placement, hover previews, modifier-click links, middle/right click, drag text, drag files, wheel/pinch/trackpad behavior, context menus and dismissal. |
| Input methods and clipboard | IME composition and cancellation, dead keys, autocorrection, spellcheck, smart punctuation, plain/rich paste, multiline paste, images/files, cut/copy selection and cross-app clipboard round trips. |
| Transactions/history | Typing/deletion grouping, selection restoration, undo/redo after formatting, drag/drop, paste, widgets, table edits, mode changes, external updates and multiple open views. |
| Lists | Bullets, numbering, nesting, indent/outdent, Enter/Backspace/Tab/Shift-Tab, continuation/termination, renumbering, tasks and alternate task states, multiline items, checkboxes in both modes. |
| Links and embeds | Wikilinks, Markdown links, aliases, headings, block references, escaping and paths; completion ranking and acceptance; unresolved notes; link edits versus navigation; embedded-note editing and recursive/error states. |
| Blocks | Headings/folding, blockquotes, callouts/folding, code blocks/language selection, comments, horizontal rules, footnotes, math, Mermaid, raw HTML, properties and attachment embeds. |
| Viewports | Scroll anchoring, virtualized ranges, large files, resize, zoom, sidebar changes, split changes, tab switches, workspace restore and mobile keyboard occlusion. |

## Split workspace views

Verify split right and split below, nested combinations, divider dragging and
keyboard resizing, minimum sizes in small windows, tab movement between groups,
closing the last tab and collapsing empty groups, active-pane focus and command
routing. Keep separate caret/selection, scroll, history and Reading/Live Edit
state per view while shared note content stays synchronized. Splitting, resizing
or moving another pane must preserve a surviving editor and any active selection
or composition. Save and restore pane IDs, tree orientation, relative sizes,
active pane and tab state, including migration from the earlier flat layout and
malformed saved-state recovery. Pop-out windows and mobile/tablet behavior need
their own comparisons; nested in-window splits do not establish those features.

## Table editor

Verify table creation and Markdown round trips; enter/exit each cell; caret and
selection within/across cells; Tab/Shift-Tab/Enter and arrow-key boundaries;
multiline/escaped content; formatting, links, code and embeds within cells;
column alignment; row/column insertion, deletion, reordering and menus; resizing;
copy/cut/paste of cells and ranges; undo/redo; source/live/reading transitions;
empty/malformed tables; external edits and simultaneous views. Exact reference
behavior determines every boundary case. Basic HTML table rendering is insufficient.

## Bases

Inventory `.base` schema, expressions/functions, filters, sorting, grouping,
aggregation and each available view. Verify property typing, cell editors,
keyboard/mouse selection, multi-row operations, column controls, file operations,
embedded Bases, settings, undo/recovery, persisted files, plugin extensions,
large-vault behavior, and mobile interaction. File format support alone is
insufficient. A lossless `.base` document model exists; query execution and
rendered views/interactions remain missing. See `bases-reference.md` and
`bases-query-reference.md` for the current bounded static contracts.

## Images and attachments

Verify file import and paste, naming/location preferences, binary integrity,
embedding syntax, dimensions/aspect ratio, resize handles and limits, captions or
alt text where supported, click/zoom/open behavior, drag/drop, link/rename updates,
clipboard, context menus, supported formats, missing/corrupt files, selection near
the embed, undo/redo and mobile gestures. Placeholder links do not satisfy this.

## PDF viewer

Verify the actual viewer engine/version and integration; loading and rendering,
page navigation, zoom/fit/rotation, continuous page layout, text selection and
copying, search/highlights, outlines/thumbnails, internal/external links, page and
selection deep links, embeds, context menus, keyboard shortcuts, annotation
behavior supported by the reference, scrolling, password/error cases, large files,
multiple views and mobile gestures. A browser iframe or generic PDF viewer is not
assumed equivalent. A PDF.js viewer is now integrated into file tabs and Markdown embeds. Native local-file loading exposed a blob transport failure; its repair and native revalidation are in progress. Passing simulated viewer tests does not establish native functionality.

## Mobile and remaining application surfaces

Repeat applicable scenarios on the matching iOS and Android references, including
safe areas, keyboard toolbar, composition, touch selection handles, long-press,
gestures, split/tablet behavior, orientation, background/resume, share/open-in, and
storage providers. Desktop behavior is not evidence of mobile parity.

This contract supplements [the full parity ledger](parity.md). It does not remove
any feature, setting, menu, core plugin, third-party API, theme, service, platform,
or interaction from the goal. Every newly discovered reference behavior adds to
the acceptance inventory. Completion requires the entire user-requested scope.

## Markdown embeds and properties

Compare whole-note, heading, and block transclusion; nested embeds; relative link
resolution from the embedded source; cyclic/deep embeds; missing/renamed targets;
selection around and inside embeds; editing, task toggles, hover and navigation;
unsaved/external updates; undo/redo and cached preview invalidation. Test every
attachment type as an embedded object and a standalone viewer. The current
reading-view note/heading/block renderer is partial; editable embeds, attachment
viewers, and exact subpath edge cases are not verified.

Properties require the same defaults, collapse state, ordered rows, type registry,
name casing, suggestions, list/tag interactions, links, dates/time zones, empty
values, type mismatch handling, add/remove/rename, clipboard and shortcuts across
source/live/reading modes. Compare actual YAML writes, including comments, styles,
body bytes and plugin API behavior. Do not assume reference APIs preserve comments:
the statically inspected processFrontMatter path parses and reserializes values.
Original source-preserving edits are not evidence of identical serialization.

## Performance acceptance

Use identical recorded vault fixtures (1k/10k/100k notes, attachment-heavy vault,
large single documents, dense links, nested embeds, large tables/Bases/PDFs).
Measure cold/warm startup, time to first usable note, input latency and dropped
frames, save latency, index/search/backlink update, memory, filesystem operations,
and background CPU. Record hardware, OS, app/build versions and repetitions;
report median and tail latency, not a single best run. Repeat on supported mobile
hardware with keyboard, background/resume and low-memory scenarios.

Core-only measurements from `node scripts/benchmark-core.ts` are diagnostic data,
not Obsidian comparisons or end-to-end editor measurements. Known-file saves and
watcher batches must not reread unrelated note content. Structural rescans remain
bounded and atomic on failure. Verify that performance changes never drop external
edits merely because their sizes/timestamps match, lose recovery drafts, or leave
stale backlinks, properties, and embeds.

## Bases view coverage clarification

The user explicitly requires every existing Bases view and identical interactions,
not only the `.base` format or a subset of views. Inventory the view types actually
registered by the reference build, identify built-in versus plugin-provided views,
and preserve the extension mechanism needed by existing view plugins. Record
view-specific actions and persisted options in addition to shared filters, sorts,
groups, formulas and property types. Verify view switching, editing, selection,
keyboard/pointer/touch navigation, menus, resizing/reordering, scrolling and
virtualization, drag/drop, undo/recovery, external updates and large datasets.
No implemented substitute view counts as parity without paired evidence.
