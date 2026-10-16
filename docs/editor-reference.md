# Editor reconstruction evidence: Obsidian 1.14.4

The shipped editor has a custom CodeMirror composition, HyperMD tokenization, syntax-aware decorations, rendered block widgets, and nested cell editors. Matching CodeMirror package names or hiding punctuation with regular expressions does not reproduce that composition. This report records a focused static reading to guide an original implementation; it does not certify Zorid editor parity.

## Artifact and investigation boundaries

This pass applies the installed `reverse-engineer-anything` skill and reuses renderer Evidence E3, `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. The REA CLI `inspect-evidence-bundle` summary verified the existing exported `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json`: two retained complete records, the analysis and its summary. No producer was rerun. Parent inspection also confirmed the retained summary remains available in its MCP connection.

The inspected renderer is `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, source node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`. E3 parsed this file but did not retain the complete expanded semantic graph because of a memory limit; see [the evidence ledger](reference-evidence.md). A parent REA trace for `cm-live-preview`, `ev_2fceef968b2c3c23a0b346875084283b49b5d405e20a78184b6ccc5818a5ecae`, returned no match in that partial graph. This is not an absence finding. The actual inspected editor class toggle is `is-live-preview`.

The detailed findings below are ordinary focused source readings connected to that digest and E3 identity, not newly proven REA call-graph relationships. Anchors are zero-based Unicode character offsets in Python's UTF-8-decoded source, not byte offsets. Minified names identify this build only. The reference was not executed; reference UI/runtime access remains outside this pass. No recovered implementation or assets are included in the repository.

## Composition and mode mapping

The public export map at 240417–244913 identifies the relevant minified bindings: EditorState, EditorView, StateField, ViewPlugin, StateEffect, Compartment, Decoration, WidgetType, StreamLanguage, syntaxTree, ensureSyntaxTree, history, and historyField. These mappings support identifying the mechanisms below rather than guessing from short variable names. Exact dependency versions and the extent of modifications to upstream packages remain unresolved.

| Layer | Anchor | Observed role |
| --- | --- | --- |
| Markdown view | `L8`, 3086310–3093000 | Owns an editing adapter and a separate reading adapter. Saved state includes `mode` and boolean `source`. |
| Reading adapter | `eU`, 2041254 | Has type `preview` and a `markdown-reading-view` container with its own renderer, search and rendering options. |
| Editing adapter | `P8`, 3080503 | Has type `source`, including when Live Preview is active. Owns save/fold notifications and adds the properties extension when raw source mode is off. |
| Common document editor | `o0`, around 2577490 | Constructs EditorView and the editor API wrapper; initializes its raw-source flag from the inverse of vault `livePreview`. |
| Markdown specialization | `a0`, 2602504 | Adds Markdown language, list commands, scroll handling, and a content sizer containing editor content. |
| Shared extensions | `e0` / `t0`, 2557000–2558513 | Includes history, multiple selections, line wrapping, text direction, indentation, highlighting, selection behavior, keymaps, and exception handling. |
| Dynamic compartment | `getDynamicExtensions`, 2584500–2586500 | Adds tab/indent preferences, direction, spellcheck/content attributes, bracket/Markdown pairing, Vim if enabled, workspace plugin extensions, and Live Preview extensions when applicable. |
| Live Preview factory | `C8`, 3055433 | Composes block-decoration state, inline/task decoration plugins, image state/controller, custom navigation and pointer handling, table transaction filters, and postprocessor invalidation. |

The Markdown language definition near 2557000 uses StreamLanguage around the shipped `CodeMirror.getMode` HyperMD mode. A second definition disables frontmatter, tables, fenced-code highlighting, tasks, headings, blockquotes, indented code, lists, horizontal rules and block IDs for table-cell use. Replacing this with an unconfigured default Markdown parser leaves token and behavior differences to resolve.

Editor-local extensions initialize state fields for the view and owner, register an update listener, suggestion-aware keys, clipboard hooks, and drag/drop/focus handlers. Shared baseline and dynamic configuration occupy separate compartments. The Live Preview boolean is also represented in a StateField (`U1`, 2554881), changed through a StateEffect. `toggleSource` at 2589437 changes that flag and reconfigures extensions; it does not switch to the separate reading renderer.

`setMode` at 3092055 changes editing versus reading, saves when leaving editing, transfers folds and scroll position, updates metadata collapse and mode attributes. State serialization at 3089537 stores both dimensions. Therefore `mode: source` does not by itself mean visible raw Markdown. The current product requirement for only **Reading** and **Live Preview** in Zorid's public controls can map Live Preview to the edit adapter with raw source disabled. This is a requested product constraint, not evidence that the reference lacks a raw-source option.

## Syntax reveal, selection, and input stability

The shared decoration plugin base (`f8`, 3038570–3039740) caches the syntax tree. It maps existing decorations through edits while parsing has not reached the viewport, composition is active, or pointer selection is in progress. It rebuilds for tree, viewport, selection, or explicit invalidation changes. Inline decoration traversal is limited to visible ranges.

The inline plugin (`v8`, 3039740–3043977) considers all editor selection ranges when the editor has focus. Search-match highlight overlap also reveals syntax. Range overlap is inclusive in the helper at 782158, so boundary cursors matter. This is not a main-cursor-only or whole-active-line-only scheme: some constructs use their grouped token span, while heading and quote handling checks the line. Unfocused editors omit their own selection ranges from this reveal calculation.

Observed token handling covers emphasis/strong, inline code, strikethrough, highlights, headings, quotes, escaped characters, links/aliases, list bullets and numbers, and task checkbox widgets. It explicitly skips fenced-code content and delegates images, embeds, and math to other handling. A selection-only update can move endpoints away from hidden replacement boundaries, with a bounded ten-iteration adjustment and a deferred dispatch guarded against a stale selection. This needs real selection/IME tests, not merely visual snapshots.

A second plugin (`g8`, 3043977) adds task status attributes to lines. Pointer tracking and focus/blur invalidation are composed near 3054001. Mobile selection handling additionally records a dragging state with a debounce. The block decoration field also defers rebuilding during composition or pointer dragging. A rebuild on every keystroke irrespective of composition or incomplete parsing is not the inspected design.

## Rendered blocks inside the editor

The block-decoration factory (`m8`, 3044479–3054001) reads the syntax tree and creates replacement/widget decorations for internal embeds, external images, math, supported code blocks, callouts, HTML, rules, and tables. It retains typed widget collections, reuses compatible widgets, updates document positions, and removes stale child components. It attempts parsing through the viewport plus 2,000 characters with a 20 ms budget. That budget is an architectural observation, not a measured end-to-end latency guarantee.

Its source reveal decision includes focused selection ranges and search-match highlights. Different widgets deliberately have different reveal rules. An ordinary block may display its widget alongside exposed Markdown when selected; image and table behavior is more specialized. Treating every rendered object as a single uniform “hide when cursor overlaps” decoration would miss these branches.

| Rendered object | Anchor | Editing and lifecycle observations |
| --- | --- | --- |
| Internal embed | `r8`, 3029573 | Resolves through metadata using the containing note's source path; creates an extension-specific embed child through `d2.load`, loads it, and registers it under the editor. Carries embed depth. Images receive image controls; other child types can receive an edit action. |
| External image / recognized web embed | `n8`, 3027990 | Uses a URL-based image or recognized web-embed widget. Maintains image controls and a separate image tooltip reference. Markdown image URLs recognized as internal are routed to the internal resolver instead. |
| Rendered fenced block | `o8`, 3031420 | Recognizes Mermaid, query, and registered code-block postprocessors. Supplies source path, section offsets, child registration and text/code replacement callbacks. Unsupported fences retain source code with fence decorations and a language widget. |
| Callout | `s8` through `a8`, 3033204–3034439 | Renders Markdown, postprocesses using the note path, resolves links and exposes an edit action. The block field reveals its source on overlap. |
| Math / HTML / rule | block field and nearby widget definitions | Separate specialized widgets; block versus inline placement and source reveal are determined from token/line context. Complete rendering, sanitation, and interaction behavior were not audited here. |
| Table | `oU`, 2055457; block field 3044479 | Rendered table remains the editing surface and delegates a selected cell to a nested CodeMirror editor. See below. |

Base widget code (`RW`, 1949277; `BW`, 1950934) tracks source positions, exposes an edit action, routes click-to-selection, requests CodeMirror measurement from ResizeObserver, disconnects that observer on destruction, and tracks child components through the editor. Interactive descendants are exempt from the generic click-to-source handler. `m8` explicitly removes children of widgets that no longer survive reconciliation. Parent postprocessor-change events invalidate rendered block content. These mechanisms establish concrete cleanup/refresh requirements for embeds and plugin widgets.

### Images are selected objects

The image controller (`UF`, 1710200) holds a selected image range and reconciles it through edits. Selection remains valid only under specific single-cursor boundary conditions. A separate StateField (`jF`, 1709770) tracks revealing/editing the image syntax and reserves layout height; the block factory can show the image in a tooltip while its URL or alias is edited.

`C8` supplies atomic ranges specifically for decorations flagged as image embeds. It binds image navigation, URL edit on Enter, alias edit on Tab, Escape, lightbox on Space, deletion, resize and reset-size keys. Up/down movement considers nearby rendered blocks. These are image-specific commands, not general suppression of all editor cursor movement. Full resizing and lightbox findings are in [attachment-reference.md](attachment-reference.md).

### Tables use nested cell editors and mapped transactions

The table block replacement is not generally removed because a cursor enters it. The factory excludes the replacement for search-highlight overlap, but passes editing selections to the table widget. `receiveSelection` at 2062540 maps outer document ranges to cell offsets and opens or focuses a cell editor. The table can also distinguish selected cells and whole-table selections.

`editTableCell` near 2601690 creates a `u0` editor inside a cell wrapper, hides the normal rendered cell content, and activates table handles. The outer editor's `activeCM` getter at 2601438 delegates commands and focus to that nested editor. Destroying the cell editor restores and rerenders the cell and unregisters the child.

The cell editor (`u0`, 2608373) always uses Live Preview and the reduced HyperMD mode. Its document/selection transactions are forwarded to the table, with annotations preventing feedback loops. Outer table updates reconcile cell positions, content, widths and selections, including undo/redo. Cell keymaps handle crossing cell boundaries, extending cell selection, and delegating undo/redo to the parent history. The parent change filter at 2086618 routes edits confined to an active cell through cell sanitization; a separate transaction filter at 2087779 handles editing around block tables.

This requires an explicit mapping between cell text and original Markdown, not independently saving cell HTML or replacing the whole document on every cell edit. Alignment, escaped pipes, multiline representation, rectangular copy/paste, malformed/incomplete tables, focus transitions, undo grouping and mobile navigation still need dedicated behavioral fixtures. Static method presence does not certify those edge cases.

### Properties are coordinated with the editor, not ordinary inline text

`P8.show` near 3081100 places the metadata editor above CodeMirror content inside its sizer, alongside the inline title and backlinks. Its dynamic extensions add `cR` only in Live Preview. Properties visibility additionally depends on `propertiesInDocument`; the top-level visibility check is at 3098327.

The properties extension (`cR`, 1718994) locates frontmatter, validates YAML as an object, and replaces valid frontmatter text with a block decoration unless configuration asks for source. Invalid YAML remains visible with invalid/error markers. A transaction filter guards the hidden region, clamps selections, and handles insertion around it; composition and programmatic paths have exceptions. A recognized frontmatter-creation effect can invoke the add-property command. Property UI writes are a separate frontmatter synchronization path, covered in [reference-evidence.md](reference-evidence.md).

Therefore displaying a properties form without coordinating hidden YAML positions, selection, keyboard traversal, invalid YAML and saves would be incomplete. The properties panel is not simply another rendered Markdown paragraph inside the contenteditable DOM.

## External updates, history, and plugin extensions

The editor's `set` method near 2579000 either initializes a new EditorState with its extension stacks or computes a bounded line/character difference and dispatches a `set` transaction. Saved history is retained per file with a document-length check and a bounded twenty-entry cache. This does not prove conflict resolution or history correctness under every concurrent file update; it does show that ordinary updates are not invariably a whole-document reset.

Workspace extension registration at 2944541 updates existing editor options. Plugin `registerEditorExtension` at 2949446 registers cleanup on unload. The dependency bridge near 2945600 exposes CodeMirror/Lezer modules and legacy aliases, with compatibility shims nearby. Supporting only a bare registration array would not establish plugin compatibility: shared package identity, compartment reconfiguration, owner fields, editor API shape, postprocessor callbacks and unload behavior need fixtures.

## Reconstruction implications and unverified behavior

The supported structural target is a Markdown document in CodeMirror with parser-derived inline decorations, persistent block widgets, focused interaction controllers and lifecycle-aware child renderers. Reading mode has a separate renderer. Live Preview edits remain Markdown transactions, including nested table-cell and embed editing.

Prioritize original implementations and tests for:

1. Parser-aware decoration spans, all selections, focus changes, search reveal, IME and pointer-drag stability.
2. Lifecycle-managed images, embeds and rendered code blocks with measured layout and cleanup.
3. Table cells with source-offset mapping, shared undo and navigation.
4. Properties synchronization with hidden frontmatter and invalid-YAML fallback.
5. Plugin extension identity, reconfiguration, postprocessor refresh and unload.

This pass does not establish pixel identity, actual OS keyboard behavior, touch/IME parity, screen-reader behavior, exact parser versions, every Markdown edge case, or measured performance. It does not mean these structures are all implemented in Zorid. Reference runtime comparisons remain necessary and must be authorized separately from running Zorid.

## Focused table encoding and keyboard follow-up

This follow-up remains static-only and uses the same renderer digest and E3 identity. It narrows earlier table unknowns using the cell encoding helpers (783126–784190), renderer table tokenizer (artifact-local module 7793, around 200500–201700), table dispatch/reconciliation (2058172–2067809), and nested editor keymaps (2608373–2615200). No reference functions were executed or copied into the implementation.

### Cell source encoding and decoding

The writer at 783126 converts LF or CRLF in the cell editor to the exact source string `<br>`. A lone carriage return is not covered by that observed matcher. It also ensures each pipe has an odd number of immediately preceding backslashes: no backslash gets one; an even positive count gets one additional backslash immediately before the pipe; an odd count is retained. Encoding has no special exemption for inline code. This is idempotent escaping for already escaped pipes, not blanket doubling of every backslash.

The reader at 783513 removes only the final escaping backslash from an odd backslash run before a pipe; even runs are unchanged. It converts exact `<br>` tags, case-insensitively, to LF, except when the tag lies within its recognized backtick-delimited span. The inspected matcher does not match `<br/>`, `<br />`, or tags with attributes. Backtick protection uses a run of backticks, at least one non-backtick character, and a matching backreference. It is a string-matching heuristic, not the full Markdown syntax tree: it permits newlines and does not check escaped backticks or maximal delimiter-run boundaries. Malformed or unusual code-span cases remain unverified.

Both helpers return text and a CodeMirror ChangeSet. Length-changing conversions must map cursor/selection offsets; returning only a transformed string is insufficient for the observed nested-editor design. Encoding and decoding are not an identity function for all arbitrary strings. For example, an already escaped pipe in editable text can be normalized when the cell is reopened. Preserve this distinction between encoded source and editable text in model APIs.

Independent examples of the observed transformations:

| Operation | Input description | Output description |
| --- | --- | --- |
| Encode | `alpha`, LF, `beta` | `alpha<br>beta` |
| Encode | Pipe with no preceding backslash | One backslash followed by pipe |
| Encode | Two backslashes followed by pipe | Three backslashes followed by pipe |
| Encode | One backslash followed by pipe | Unchanged |
| Decode | Three backslashes followed by pipe | Two backslashes followed by pipe |
| Decode | `alpha<BR>beta` outside code | `alpha`, LF, `beta` |
| Decode | Exact `<br>` inside a recognized backtick span | Tag remains literal |

The renderer's row tokenizer splits on bare pipes and consumes backslash plus the following character together. It has no code-span shielding during boundary detection: inline Markdown tokenization occurs after cell boundaries have been extracted. A bare pipe inside backticks is therefore not protected by backticks in this inspected tokenizer. The row scan requires a pipe after the initial character before each row boundary, so an ordinary body row without any pipe terminates this path. It also checks leading-pipe consistency against the first row. No header/separator cell-count equality check was observed in that tokenizer; the table renderer can extend alignments for extra cells, pad short rows and mark the structure malformed. HyperMD recognition and any preprocessing can impose additional constraints. Leading/trailing cell padding counts spaces and tabs. These facts support a slash-parity-aware row scanner; the separate HyperMD language's table recognition and malformed-table recovery are not comprehensively proven by this path.

### Keyboard movement and row creation

The nested cell editor distinguishes navigation commands from newline insertion. Its next/previous cell lookup at 2067809 traverses row-major order and returns no cell at the beginning/end. Before navigation, the current cell is trimmed through the table model.

| Key / condition | Observed handler action |
| --- | --- |
| Tab with another cell | Focuses the next cell and selects all of its editable text. |
| Tab at final cell | Inserts a blank row at the end and focuses column zero. |
| Shift+Tab with a preceding cell | Focuses that cell and selects all editable text. |
| Shift+Tab at first cell | Inserts a row at index zero and focuses its final column. This handler does not exit above the table. |
| Enter with a row below | Focuses the same column in the next row and selects all editable text. |
| Enter on last row | Inserts a row below and focuses the same column. |
| Shift+Enter | No cell-specific shift override was observed. The inherited baseline Enter binding at 1914526 supplies `insertNewlineAndIndent` for Shift+Enter, so newline insertion followed by `<br>` serialization is the supported static inference. Runtime ordering with suggestions, Vim and plugins is not verified. |

The row insertion helper at 2065716 clamps the requested position, creates cells for the current column count, and redispatches the serialized table. Insertion at index zero is consequential because the serialization treats the first row as the header; do not silently reinterpret that branch as “insert first body row” without additional evidence.

For unmodified arrows, cross-cell handling requires a single collapsed cell selection. Horizontal movement at the start/end moves to the preceding/following cell, or places the cursor before/after the table when no cell exists. RTL and per-cell text direction influence horizontal mapping. Up/down compares visual cursor coordinates: movement within a multiline cell remains normal; at a visual boundary it moves to the same column above/below or outside the table. Moving above uses the target cell's last visual line; moving below uses its start. When necessary, the surrounding-cursor helper inserts a line before/after a table at the document boundary.

Shift+arrow handling has a separate rectangular cell-selection path once its relevant cell boundary is reached. An existing cell selection collapses toward an edge on unmodified navigation. These branches do not establish every combination of mixed-direction text, soft wrapping, noncollapsed selections, multiple cursors, screen-reader navigation or touch input.

### Source mapping and parent undo

The cell dispatch at 2058859 encodes the cell's new document, updates the table model, adds the table's document offset to resulting changes, maps selection through the encoding ChangeSet, clamps it to the encoded cell text, and dispatches into the parent editor. It carries a synchronization annotation and preserves non-selection user-event annotations. No explicit `addToHistory` annotation appears in this dispatch branch. Selection-only cell transactions also reach the parent with mapped selections, except synchronization-annotated and programmatic `set` transactions. Parent-to-cell updates use the inverse decoding mapping and synchronization guards. This prevents cell text from becoming a separate authoritative document.

Table structural dispatch at 2058172 rebuilds the table and replaces its source range in the parent, selecting a requested cell when supplied. Ordinary cell updates can also adjust column padding/widths, so they need not correspond to a single character replacement in one source span. The nested keymap directs undo and redo to the parent CodeMirror history. This supports a shared-history design; exact history grouping and concurrent external edits still require runtime tests.

The previous broad table checklist remains relevant for malformed/incomplete structures, clipboard formats, row/column resizing and reordering, save conflicts, and OS/device interaction. The facts above narrow the reconstruction target without turning static inference into a claim of completed behavioral parity.

### Add-row and add-column edge controls

The table-control follow-up reused the exported E3 record through REA's `import_evidence_bundle` and `inspect_analysis_view`; the latter returned summary Evidence `ev_415d70cd7f988e2c9ed903f2b5d3be98983f690c32ec5c590ecd12621c6158cb`. E3's graph remains partial. These findings are focused ordinary source readings, not additional proven call-graph relationships or runtime observations. The `app.js` digest above was rechecked. The accompanying `app.css` SHA-256 is `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`; `i18n.js` SHA-256 is `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713`. Offsets continue to mean zero-based Unicode character offsets in Python-decoded text.

- `app.js` 2071292–2071880 creates a relative wrapper containing the table and two plus-icon controls. The bottom control at 2071345 prevents mousedown's default behavior, then calls row insertion at the current row count with column zero on click. The side control at 2071592 similarly prevents mousedown's default behavior, then inserts at the current column count with null alignment and row zero. Thus these controls append, independently of the currently edited cell.
- `app.js` 2065716 onward implements row insertion; the nearby column insertion at approximately 2066240 inserts a cell into every row and a corresponding alignment entry. Both call structural dispatch at 2058172, which serializes the table into the parent Markdown document and focuses the requested cell. Existing cell context-menu insertion paths around 2083081 and 2084948 instead use positions relative to that cell; column insertion there inherits its alignment.
- `i18n.js` 129440 and 129471 bind the default English labels to “Add row below” and “Add column to the right”. These are tooltip labels on the plus controls, not visible text buttons containing those phrases. This establishes the default strings, not the active runtime locale.
- `app.css` 121162 makes the table wrapper relative and fit its content. Rules at 126373–128950 position the row control below the table across its full width and the column control at the logical end across its full height. Desktop opacity defaults to zero and the hovered control becomes visible. Mobile rules show both while the table has its focus class and disable pointer events without that class. The column cursor reverses in RTL near 130458. Actual computed sizes, clipping, hover hit areas and mobile focus timing were not executed or measured.

Zorid's original implementation uses native focusable buttons with those labels, corresponding edge strips, and parent-document transactions. It adds explicit focus-visible presentation and isolates each structural click as an undo step; neither is claimed to match an unobserved reference keyboard or history-grouping detail. Column insertion preserves existing encoded cell contents, padding, line endings and surrounding text, materializing ragged cells as needed. A typed `tableActionsAt` hook exposes the four relative insert actions for a native or web menu and rejects stale menu actions after table content changes or teardown. Its menu rendering is owned separately. Source-only tests cover model edits and real CodeMirror/jsdom events, current ownership, selection and undo; browser pixels, OS-native menus, screen readers and touch behavior remain separate checks.

## Pointer-to-caret investigation

This focused follow-up addresses clicking rendered Live Preview text and inserting at an unexpected source position. It uses the same digest-bound desktop artifact and retained E3 evidence. No reference UI or pointer input was executed. The cause of any specific Zorid bug must be established in Zorid; the reference branches below provide an implementation and test contract, not a diagnosis by themselves.

### Desktop selection lifecycle

The Live Preview pointer plugin at 3054001 adds a **capture-phase** `mousedown` listener to CodeMirror's scroll DOM. For the left button it snapshots selection, document and vertical scroll position and sets the shared `O5.mousedown` flag. A right-side scrollbar-coordinate check bypasses this path when vertical overflow exists. It installs temporary capture listeners on the editor's owner document for left-button `mouseup` and `drag`.

On either completion path it removes those temporary listeners and clears the flag. If selection, document or vertical scroll changed from the snapshot, it schedules a dispatch 50 ms later carrying the editor's then-current selection and a synchronization annotation. This is an explicit selection-refresh trigger, not a new coordinate hit test. Focus and blur separately schedule an invalidation effect after 10 ms near 3053900.

While the flag is set, the inline decoration plugin base near 3039200 maps existing decorations through document changes instead of rebuilding them. The block decoration field near 3052500 also suppresses rebuilding during pointer selection, composition, or a reentrant build. It still maps document positions and reconciles affected tables where needed. Thus the geometry used for the click/drag remains stable while CodeMirror establishes the selection. The initially selected token is not immediately expanded merely because that initial pointer transaction changed selection.

After release/invalidation, normal syntax reveal recomputes from focused selection ranges and search highlights. The consequence is preservation of the intended logical text position during hit testing; it is **not** a promise that the caret's final screen x-coordinate never moves when Markdown delimiters become visible. A useful regression assertion types a character at the clicked rendered-text location and checks the resulting Markdown offset, in addition to inspecting geometry.

The destruction path explicitly removes the persistent scroll-DOM listener. Cleanup of every pending document listener/timer under destruction during an active drag was not established. An original implementation should clean up all its own active listeners and delayed callbacks.

### CodeMirror coordinate mapping

The shipped `EditorView.posAtCoords` at 480676 first reads measured layout, then delegates to its coordinate mapper at 382145. Input coordinates are viewport/client `x` and `y`, matching `MouseEvent.clientX/clientY`. The mapper uses content bounds, padding, block positions, rendered DOM rectangles, text ranges, grapheme boundaries and bidirectional spans. Block widgets can map to the beginning or end according to vertical position. Precise mapping outside rendered coverage can return null; a nonprecise mode has fallback estimation.

The baseline mousedown handler at 405299 flushes the DOM observer, obtains start/current positions using `posAndSideAtCoords`, and delegates selection units and dragging to the mouse-selection machinery. That machinery near 400000 dispatches `select.pointer`, supports modifier selection and auto-scroll, and consults atomic ranges. It maps its stored positions through document changes. This is stronger evidence for using the live CodeMirror view's own mapping than for computing a column from character width, using page coordinates, or mapping against an overlay with different font/wrapping.

The application's editor wrapper at 2562904 similarly delegates coordinate conversion to its CodeMirror instance, with nonprecise mapping, then converts the resulting document offset to line/ch positions. The caller must use the editor that actually owns the visible text; outer and nested cell editors have different documents and coordinate mappings.

### Hidden markers and source-range clicks

The inline decoration plugin near 3039740 adjusts selection endpoints that land within particular hidden replacements. It treats leading, trailing and heading replacement markers differently, handles all ranges, and bounds its repeated adjustment to ten passes. The adjustment is skipped while the pointer flag is active, and the resulting dispatch is deferred.

**Correction to the earlier syntax-reveal paragraph:** the observed deferred callback compares a captured selection with the selection of its captured state, rather than explicitly comparing against the view's latest state. Therefore the earlier phrase “guarded against a stale selection” is too strong. A robust latest-state stale-selection guarantee is not established by this code. Original deferred callbacks should check current ownership/state or be cancelled when superseded.

Generic rendered block clicks use the widget owner/source range at 1949277, rather than guessing a Markdown column from rendered HTML. The generic handler ignores descendants belonging to another `.cm-editor` or an `.interactive-child`. With a valid stored range, desktop selects that range; the mobile branch collapses it to its start. With no valid stored range it falls back to a DOM-to-position lookup. Explicit edit actions use the same owner mapping. Images have separate selected-object/reveal logic, so this generic rule must not override their controls.

A separate mousedown branch near 3054900 treats draggable rendered links specially. It changes contenteditable/event handling to preserve link/drag behavior. That branch is not evidence that ordinary text clicks should always be intercepted or default selection prevented.

### Rendered table to nested editor

The cell pointer handler near 2050500 keeps a rendered-cell selection while tracking pointer movement. On click, or a deferred release completion approximately 10 ms later, it can activate the nested cell editor. It obtains anchor/head coordinates from the browser selection's client rectangles when available, falls back to the pointer coordinates, and accounts for text direction when assigning endpoints.

Only after the nested editor exists does the callback call **that nested editor's** `posAtCoords` for anchor and head. `receiveCellFocus` at 2064905 applies the resulting selection. The swap path near 2601690 temporarily locks cell dimensions, hides the old renderer, attaches the cell editor, focuses it and tears down the prior cell editor. The dimension lock near 2054400 uses measured cell width/height and later clears its temporary style. These details reduce coordinate drift when replacing rendered HTML with editable Markdown.

The pointer handler also supports rectangular cell selection, Shift selection and distinct touch paths. iOS/Android caret-drag behavior is separate; the desktop mouse lifecycle must not be claimed as proven touch parity. Malformed-table rebuilding can change cell identities, and the handler explicitly reacquires cells by row/column after such a repair.

### Original implementation contract

A reference-informed fix should:

1. Set interaction state before the editor's initial pointer-selection/focus update, so selection-dependent decorations cannot reshape text before hit testing finishes.
2. Preserve and map existing decoration geometry throughout mouse selection; release it after completion and request a fresh reveal calculation. Clean up on cancellation and teardown.
3. Use client coordinates and the owning CodeMirror view's measured mapping. Re-measure after widget size changes; avoid independent character-width arithmetic or overlay coordinates.
4. Preserve logical source selections through reveal and document changes. Guard delayed work against a new selection, document, editor or destroyed view.
5. Keep block controls, links, images and nested editors on their specialized event routes; resolve nested cell positions only after their DOM and dimensions are ready.

Validate with actual Zorid pointer events in a rendered browser: plain text beside hidden emphasis/link delimiters; first click into an unfocused editor; soft-wrapped lines; drag and Shift-click selections; clicks at token boundaries; selection across rendered blocks; table-cell activation; different zoom/font sizes; scrolled editors; RTL; and rapid clicks before delayed refresh. Assert inserted text and selected source ranges, not only screenshots. jsdom transaction tests alone cannot certify layout hit testing, and Zorid tests cannot certify reference OS behavior without authorized reference comparison.
