# Checkbox and list indentation reference

This is a focused static reading of the supplied Obsidian 1.14.4 desktop bundle. “Toggles” was clarified to mean task checkboxes; folding is outside the implementation priority here. No target process was executed. These observations guide original code; they are not a claim of runtime or complete editor parity.

## Provenance and coverage

- Retained REA E3: `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; app module node `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`.
- Source: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- Companion `app.css`, SHA-256 `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.
- Locations below are zero-based Unicode character offsets in the UTF-8 decoded files, not byte offsets. They are bounded manual static inspections, not additional REA-produced semantic facts. See [editor reference](editor-reference.md) for E3 limitations and [source audit](source-audit.md) for incomplete whole-artifact coverage.

## Checkbox source edits and presentation

| Entry point / location in app.js | Observed behavior | Confidence / limit |
| --- | --- | --- |
| `dR`, 1720937–1721040 | Recognizes indent/quote prefix, unordered `*`, `+`, `-` or numeric `.`/`)` marker, then optional single-character task status. This operation grammar requires a space after the list marker and after the closing task bracket. | High for these editor commands; not a complete Markdown tokenizer specification. |
| Live widget `X5`, 3018780–3020150 | Input `data-task` stores the status. Native checked state is status unequal to ASCII space. Space toggles to lowercase `x`; **every other character** toggles to space. On input, locates the editor line via `posAtDOM` and replaces only the character within its first bracket/status marker. | High static. Lowercase, uppercase and custom-status visual behavior follows this code; no runtime accessibility/IME verification. |
| `X5` event handlers, same range | Label `mousedown` prevents default. Dispatch supplies only a change, with no explicit replacement selection or user-event annotation at this site. Android additionally restores scroll during a 200 ms listener window; vibration is requested. | High static. Focus retention is the intended effect inferred from the event handler, not measured. |
| Live decoration builder, 3040500–3043500 | Creates task widget for a `formatting-task` token. Grouped formatting is revealed when its range intersects editor selections while focused (or search highlights). This is finer than hiding all task widgets on an active line. | Partial: token-group boundaries and search/selection intersection helpers were not fully traced. Exact boundary behavior needs runtime comparison. |
| Task line decorations, 3044400–3044900 | Task syntax lines receive `data-task` from their parsed status, separately from widget rendering. | High static. |
| Reading `onCheckboxClick` / `toggleCheckbox`, 2035500–2036800 | Uses source line bounds and replaces the first task-status character; same space→x / other→space rule. Updates cached section HTML and asynchronously reconciles checked state, LI `data-task`, and `is-checked`. | High static. Reading renderer has its own source edit path. |
| Rendered editor blocks, around 3035380 | Delegated click validates source-line metadata and nested-view ownership, calls the same toggle helper, and dispatches replacement of the rendered block source range. | High static for this branch; not all embedded renderers traced. |

A checked native input and completed text styling are different states. `app.css` at 64381–64475 defines done decoration as line-through and done color as muted. At 435824–436080 the live editor applies those values only to task statuses `x` and `X`. Reading unordered task LI selectors at 434340–434555 use the same x/X condition. Custom statuses such as `-` or `?` therefore have a checked input but do not receive done text styling from these selectors. Ordered reading-list styling was not separately established by that selector.

### Keyboard task toggle is a separate operation

`toggleCheckList` at 1723516–1724100 and command registration around 1959495 implement selection-wide commands. `editor:toggle-checklist-status` has default Mod-L and is disabled within table cells; `editor:cycle-list-checklist` passes the cycling flag. Do not replace these with pointer-click behavior.

The operation first chooses a common mode across selected lines. If all have nonblank statuses, normal toggle makes them unchecked; cycling removes task markers. If an unchecked status exists and no line lacks a task marker, all become checked lowercase x. If any line lacks a task marker, mode 1 adds unchecked tasks to lines without one and removes existing task markers from lines already having one. With cycling enabled, any non-list line selects mode 0, producing plain list prefixes. It preserves original bullet/numeric marker when present, otherwise uses `- `. The shared `processLines` helper skips blank lines in multi-line operations and has its own selection adjustment rules. Mixed-selection semantics are static observations, not validated target executions.

## Indentation defaults and key dispatch

| Location | Observation |
| --- | --- |
| `XP` defaults, 1409700–1410500 | `smartIndentList: true`, `useTab: true`, `tabSize: 4`, `showIndentGuide: true`; heading/indent folding also true. |
| Dynamic extensions, 2584500–2586100 | State tab size is configured `tabSize`. Indent-unit facet is a literal tab when `useTab` is true and **four spaces** when false, independent of configured tab size. |
| Settings, 3835597–3836500 | Smart indentation and use-tabs toggles; tab-size slider from 2 through 8, step 1, default 4. |
| Markdown keymap, 2605000–2605750 | Tab calls `indentList`; Shift-Tab calls `unindentList`. Enter and Shift-Enter custom behavior is conditional on smart indentation. |
| Editor wrappers / command map, 1724714–1724834 and around 2577326 | Indent/unindent map to custom `N1` and `V1`, not an assumed stock CodeMirror Markdown command. |
| Suggestion keymap, 2582300–2582800 | Open suggestions can intercept Enter/Tab. Full plugin/Vim keymap precedence was not traced. |

`R1` at 2553450–2553813 visits selected lines once, excludes the final line when a nonempty selection ends exactly at that line's start, and maps anchor/head through changes. It does not automatically select descendants outside the selection.

`N1` at 2553826–2554104 rejects read-only state. It inserts one configured indent unit at each selected line's start; in a whitespace/quote prefix, insertion moves after the last `>` and one following space if present. It dispatches `input.indent`.

`V1` at 2554104–2554750 rejects read-only state. If whitespace occurs before the first `>`, it removes all of that whitespace. Otherwise it preserves the quote prefix, removes one indent-unit visual width from the remaining indentation (minimum zero), and reconstructs whitespace according to the configured unit. A bare `> ` is left unchanged. It dispatches `delete.dedent`. `Zu` and `Ju` at 620944–621250 compute a tab unit's width from state tab size; space units have their literal string length. Reconstruction uses tabs plus leftover spaces when configured for tabs.

## Enter, Shift-Enter, and empty items

`newlineAndIndentContinueMarkdownList`, 1724834–1726605:

- Requires collapsed selections and carets at or after the matched prefix. Failure for any selection falls back to the generic newline-and-indent command for the whole operation.
- Nonempty unordered items retain the bullet. Numbered items increment the number and retain `.` or `)`. Task continuation always inserts unchecked `[ ] `, including after x/X/custom statuses.
- Preserves indentation and quote prefix. A following existing list marker suppresses insertion of a duplicate marker; following indentation is removed separately.
- A continuation line without a marker searches backward for a list prefix of matching length; stops on a shorter prefix.
- Empty top-level item: removes the prefix through the caret, with **no new newline**.
- Empty indented item: removes one trailing tab, otherwise up to four trailing spaces, leaving the task/list marker. This four-space branch does not consult tab size.
- Empty quoted list item: removes the list marker while preserving the quote prefix. An empty quote-only line reduces a quote level; consecutive identical empty quote prefixes have special paired removal behavior.
- Successful transaction is marked `input.type`.

`newlineAndIndentOnly`, 1726605–1727200, inserts a newline with the indent/quote prefix and spaces equal to the list marker's length, without repeating the marker. It falls back to a plain replacing newline for noncollapsed selections or unsupported prefixes. Shift-Enter uses this command when smart indentation is enabled. Ordinary Enter also uses it when `My` (786697–786995) sees `HyperMD-table-2`, codeblock, or math syntax on the current line.

### Backspace: bounded finding

The baseline keymap around 1914582 uses `oz`→`rz` at 1905500–1906300. At a collapsed caret within an all-whitespace line prefix shorter than 200 characters, Backspace removes one trailing tab, or enough spaces to reach the previous indent-unit boundary. Otherwise it deletes backward with character-boundary handling, joining lines at line start. No task-marker-wide deletion was established in this inspected path. Bracket-pair deletion, tables, image widgets, Vim, suggestions and plugin keymaps can intercept; this is **not proof that every Backspace route has been audited**.

### Ordered-list postprocessing: partial

Smart indentation installs `uU` at 2089302–2091480. This transaction filter can append sequential `input.renumber` changes after editing list markers, consulting neighboring list prefixes. It skips table-cell editors, composition and certain programmatic/synchronization events. Its indentation helper at about 2089000 counts tabs and groups of four spaces. Full multi-level renumber behavior remains unverified and must not be inferred from stock Markdown commands.

## Implementation and verification priorities

1. Implement live checkbox widgets with single-character source changes, all non-space statuses checked, x/X-only done styling, and source/selection preservation. Gate candidates by actual list syntax so fenced/inline code and escaped brackets remain literal. Reveal editable marker syntax when its marker region is selected. Exact reference token-group boundary behavior remains a comparison gap.
2. Replace generic list indentation with the confirmed quote-aware selected-line operations and exact default unit rules. Test forward/reverse/multiple selections, endpoint-at-next-line-start, nested tasks, tabs, four spaces, configurable tab widths, and read-only mode.
3. Implement the confirmed Enter/Shift-Enter cases, especially empty nested tasks and unchecked continuation. Test each case with exact source strings and independent undo.
4. Keep task keyboard cycling, ordered renumbering, native touch/scroll behavior and full keymap precedence explicit separate gaps until implemented and tested. Do not infer whole-marker Backspace behavior.

Recommended checkbox regression fixtures include space/x/X/custom statuses, nested unordered and numeric tasks, quoted tasks, links/brackets later on the same line, literal task-like code, marker edits, external document insertions before a widget, reversed and multiple selections, undo/redo, read-only state, and disposal of stale widgets. DOM tests can validate source and transaction behavior; they do not prove target pixel, native touch, screen-reader, or IME parity.

Folding was located in `I1`, `L1` and `F1` near 2552000–2553450 (heading/frontmatter/fold-all), but was deprioritized after the checkbox clarification. Fold toggle runtime and all descendant ranges are uninspected here.
