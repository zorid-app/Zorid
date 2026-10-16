# Heading and list folding: reference and original extension

## Evidence boundary

This is a bounded static audit of the recovered Obsidian 1.14.4 renderer and styles, using the installed REA workflow and retained E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. The semantic graph is partial. No reference app/function was executed and no proprietary implementation or assets were copied. Existing source contracts are also recorded in [editor-reference.md](editor-reference.md) and [workspace-keymap-reference.md](workspace-keymap-reference.md).

Artifacts are under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`:

| Artifact | SHA-256 |
| --- | --- |
| app.js | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` |
| app.css | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` |

Anchors below are zero-based **Unicode character offsets in UTF-8-decoded source**, not byte offsets. This worktree had no heading/list folding extension installed in `createEditor` before this module; Markdown parsing alone does not install its controls or folded state.

## Reference contracts

| Behavior | Static observation | app.js locator |
| --- | --- | --- |
| Configuration | `foldHeading` and `foldIndent` default true. Either enables fold state and inline controls. Heading and indent services are individually installed. | 1410134;2607046–2607300 |
| Heading range | Recognizes ATX levels1–6 with heading-token validation; recognizes a following unindented `=` or `-` underline as level1/2. Starts at heading line end and ends before the next equal/lower heading, or EOF. The underline is included in a setext fold. No body means no range. | 2552239–2552909 |
| Indent range | Computes leading whitespace width using tab size; skips blank lines; includes subsequent nonblank lines with greater indentation; stops at the first nonblank line with indentation <= initial line. Last included nonblank end is the range end. This is broader than only list items. | 2551500–2551940 |
| Frontmatter | Separate beginning-of-document delimiter service; not ordinary heading/list handling. | 2552909–2553260 |
| Controls | Inline widget at the first non-whitespace character of each visible foldable line, not a fixed fold gutter. The folded state uses a collapsed class and triangle icon. Mousedown prevents focus loss; click resolves its current document position, unfolds a range starting on the line, otherwise folds the available line range. | 1945500–1946500 |
| Control updates | Rebuilds on document, viewport, fold-state and selected layout-option changes. During composition it maps existing decorations; rebuilds afterward. Iteration uses viewport line blocks. | 1946200–1947130 |
| Cursor movement | Folded ranges are registered as atomic ranges. User-edit filtering unfolds affected folded content. Exact semantics of every upstream filter helper are not established here. | 1947130–1947450 |
| Commands | Toggle fold, Fold all, Unfold all, Fold more and Fold less are registered. Toggle requires editor focus or acts on properties separately. Fold all/unfold all also route to Reading and metadata handlers. No default hotkeys are declared on these inspected registrations. | 1953900–1955350 |
| Toggle | Adapter executes unfold-at-selection, falling back to fold-at-selection. | 2577418 |
| Fold all | Requests a full parse with a five-second time budget, scans every document line and adds all available fold effects, including nested ranges. | 2553320–2553760 |
| Fold more/less | For each selection, considers intersecting foldable regions through the end of its final line. More chooses the last/deepest not-yet-folded candidate; Less chooses the first/outer folded candidate. | 2564189–2565050 |
| Saved state | Stores line-index ranges plus document line count. Restore checks line-count compatibility, clears existing folds, resolves each starting line, and uses current foldability plus saved ending line. | 2586260–2586827 |

Styles: app.css254403–255200 makes expanded controls transparent until line/control hover, with collapsed controls persistently visible. app.css256406–257300 places the editing control inline with an absolute triangle beside it, and styles the fold placeholder as faint text with transparent background, no border, and 8px inline-start spacing. List-specific placement adjusts the triangle relative to rendered bullets at409221–410485. These declarations do not establish pixel parity, touch hit geometry or screen-reader behavior.

Reading folding has independent section/list renderer methods (app.js2012414–2013220,2622805–2623400). The new module is an **editor extension**; it does not implement Reading-mode DOM collapse or metadata folding.

## Original API and integration

Import `markdownFolding()` from `src/editor/folding.ts` into the parent note editor extensions and import `src/editor/folding.css` once at the application entry point. Do not install it in nested table-cell editors. Options `{ headings?: boolean, lists?: boolean }` default true and select supported fold kinds. The extension installs CodeMirror fold state, original discovery and inline controls, atomic cursor ranges, and affected-fold cleanup.

Options govern fold discovery and controls. Reconfiguring an option to false retains existing folds of that kind, with their expand placeholders; a settings host that wants immediate reveal should call `unfoldAllMarkdown` before reconfiguration. The current host has no dynamic folding-setting wiring, and reference-equivalent migration when toggling those settings is not claimed.

Exported commands, suitable for the host command registry/palette:

- `foldMarkdown`, `unfoldMarkdown`, `toggleMarkdownFold` operate on selected header lines.
- `foldAllMarkdown`, `unfoldAllMarkdown` operate on discovered ranges.
- `foldMoreMarkdown`, `foldLessMarkdown` move through enclosing/intersecting regions.
- `foldableMarkdownRanges(state)` reports supported line/range/kind records.
- `getMarkdownFoldState(state)` returns `{ version:1, lines, folds:[{fromLine,toLine}] }` with **one-based** line numbers.
- `restoreMarkdownFoldState(view, unknown)` validates a bounded snapshot, requires the same line count, and restores only ranges that still have matching start/end lines. Invalid snapshots leave existing folds unchanged. Stored positions are not trusted as arbitrary hidden ranges.

No shortcut is installed by `markdownFolding()`. For hosts that explicitly want conventional CodeMirror folding shortcuts, `markdownFoldingKeyboard()` and `markdownFoldingKeymap` are separate exports: Ctrl+Shift+[ / ] (Cmd+Alt+[ / ] on macOS), and Ctrl+Alt+[ / ] for all. These are optional original integration choices and are **not claimed as Obsidian defaults**. Reading/Live Edit mode controls remain a host responsibility; no raw-source mode is added.

The host must add commands and save/restore folds alongside editor view state if it wants persistence. This work does not edit `editor.ts` or `workspace.ts`, and therefore does not claim installed product behavior before that integration.

## State, caret and rendered content

Fold/unfold uses CodeMirror state effects, never text replacement. Fold commands add no text-history entry. An endpoint that would become hidden moves to the beginning of the newly folded region; unaffected selections keep their positions and direction. This explicit caret visibility policy is an original reconstruction choice, rather than a verified claim about every reference multi-selection edge case. Unfold does not move selection. Any selection entering hidden content—including a secondary cursor—reveals its affected fold.

Unrelated edits map folded ranges. Edits touching a hidden region or its header unfold that region; stale controls resolve current positions and do nothing after their DOM is detached. Composition defers control rebuilding, and commands decline while the view composes. The current owner document creates each control, so DOM ownership is not implicitly tied to the first application window.

The fold replacement owns visibility over contained render decorations. Existing table/embed source remains untouched; hidden widgets may unmount and release resources, then remount on unfolding. The module does not promise retained iframe/media/editor DOM identity while hidden. It does preserve the parent document and history. Callout source is hidden with the section even when a specialized callout renderer is absent. Host integration should verify any later callout renderer against these same replacement ranges.

## Discovery scope and performance

The original index uses the host Markdown syntax tree, rejecting code/HTML/comment false heading/list starts. Heading ranges follow parsed headings with the described level boundary. List ranges begin at syntactic list-item headers and follow indentation width/blank-line rules. **The reference's broader generic indentation folding is not implemented for arbitrary non-list indented text.** Frontmatter folding remains with the existing properties feature.

The index is cached by immutable document, syntax-tree identity and tab size. Selection-only updates reuse it. A document/tree change performs one structural scan and one line scan over the parsed portion, with monotonic stacks for heading/list boundaries; this is linear discovery rather than a suffix scan for every visible line. Controls are created only for viewport lines. Fold membership lookups use sets. The implementation does not claim incremental reindexing of only the edited lines; very large documents still incur a linear index refresh when content or parse coverage changes.

Commands request at most a 25ms parser budget before using known ranges, instead of copying the reference's long synchronous full-parse wait. If parse coverage is incomplete, an open-ended heading/list range is withheld until its boundary is known. Earlier ranges closed by known boundaries remain available. Coverage must belong to the inspected tree: an advanced parser context does not turn an older state tree into a complete tree. This prevents an unparsed later heading from being silently swallowed into an assumed EOF fold. A fold-all request can therefore be partial until background parsing completes; it is not a promise to synchronously process arbitrary-size documents.

Controls use an original text chevron and accessible native buttons with labels/expanded state, rather than a copied icon. Touch devices show controls without hover as an accessibility choice. Exact pointer hit geometry, visual alignment against rendered bullets, OS keyboard conflicts, screen readers and native zoom need runtime checks. No UI automation was performed in this task.

## Validation

The focused suite runs serially to limit memory use. Fourteen Node/jsdom tests cover nested headings, setext and indentation/tab/blank boundaries, parser exclusions and properties, text-history preservation, multi-caret behavior, progressive folding, mapped/affected edits, secondary-selection reveal, snapshot corruption, accessible inline controls and stale clicks, opt-in keyboard routing, real `createEditor` table/embed hiding/restoration and resource cleanup, viewport-bounded controls on a thousand-heading fixture, and stale-tree recovery after the parser context advances. TypeScript compilation passes.

Independent review cleared the module after confirming the partial-tree repair. The reviewer ran all 14 repository tests plus five independent probes for task-marker overlap, composition guards, source mapping/history, atomic snapshot rejection, and parser recovery; all 19 passed serially, with direct TypeScript and diff checks also passing. Geometry is shimmed for CodeMirror in jsdom; these are state/event/lifecycle tests, not native visual measurements or full parity. Outstanding scope includes host wiring, Reading collapse, generic non-list indent folds, exact reference fold-state migration, every native/IME/accessibility edge, and persistence integration.
