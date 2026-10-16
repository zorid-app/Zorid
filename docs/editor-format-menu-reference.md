# Editor Format menu: static contract and original commands

This bounded pass implements editor formatting actions used by an active table-cell editor. It reads the supplied Obsidian 1.14.4 desktop artifact as inert text. No reference application, native UI, or recovered function was executed, and no recovered implementation was copied into source.

## Evidence and identity

Renderer parent E3 is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`, retained from `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json`. Its summary `ev_415d70cd7f988e2c9ed903f2b5d3be98983f690c32ec5c590ecd12621c6158cb` records incomplete application/semantic graph coverage due to the renderer result-memory limit. The exact incoming `toggleHighlight` string trace `ev_b51f2cfc8a6d773389527983ddb923c8f76eb0a21eb6b2266e3513f88301e047` returned no matches in that partial graph; this is not an absence finding.

The findings below are focused manual static readings, tied to artifact identity rather than claimed complete REA call-graph relationships. Files under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/` were SHA-256 verified:

- `app.js`: `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `i18n.js`: `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713`.

Offsets count Unicode characters in UTF-8-decoded source. This extends [editor evidence](editor-reference.md) and [context-menu evidence](context-menu-reference.md).

## Menu structure and labels

`UW` near app.js 1971219 builds the formatting submenu in three sections: Bold, Italic, Strikethrough, Highlight; Code, Math, Comment; Clear formatting. The basic and advanced toggles have selection-state checkmarks, except Highlight, whose children carry color checkmarks. `jW` immediately before it adds Default, then colors in the insertion order of the color map: Red, Orange, Yellow, Green, Blue, Purple.

The English strings at i18n.js 33317–34120 are **Add link**, **Add external link**, **Format**, and **Comment** (singular). The user's task shorthand “Insert link”, “Formatting”, and “Comments” is not used as an English label override.

The generic builder at app.js 2592005–2601145 orders selection links before Format, Paragraph, Insert, and clipboard sections. Add-link actions are disabled when the trimmed main selection contains a newline. Paragraph and Insert submenu parents are disabled inside table cells. Paragraph children are Bullet list, Numbered list, Task list; Heading 1 through Heading 6, Body; Quote. Insert children are Footnote, Table, Callout, Horizontal rule; Code block, Math block. Headings/body receive uniform-heading checks; the reduced table-cell language has body content rather than block headings.

Clickable-link/tag context can suppress this generic formatting branch or insert specialized actions. This helper does not decide whether the clicked token is a link or tag; the context-menu owner controls whether to include it.

## Command observations

| Operation | app.js location | Static behavior |
| --- | --- | --- |
| Add link | 2566076 | Every editor selection is replaced with its exact text enclosed in wiki-link brackets. Each selection becomes a caret at the end of its original text, before the closing brackets. Uses `input.autocomplete`. |
| Add external link | 2565780 | Produces a Markdown link with the exact selected text as the label and an empty target. Empty selections place the caret in the label; nonempty selections place it in the target. Uses `input.autocomplete`. |
| Delimiters | 784747–785167 | Bold uses double asterisks and recognizes double underscores; italic uses asterisks and recognizes underscores; strike uses double tildes; code uses backticks; inline math uses dollar signs; comments use double percent signs. |
| Generic toggles | 2568905–2570540 | Common add/remove mode derives from the first formatting range. Whitespace is trimmed; an empty selection can expand to its word while retaining a caret. Existing formatting at selection edges can expand the operation to its containing span. Multiline additions wrap content line by line, excluding list/task/quote/heading prefixes and skipping crossing code/table/math blocks. Cursor-at-closing-marker can advance beyond the marker without changing the document. Changes and resulting selections use one `input.type` dispatch. |
| Content/state helpers | 785167–788900 | State detection traverses formatting tokens; line-content bounds omit structural prefixes and trim whitespace. Removal deletes recognized formatting delimiters rather than substituting rendered text. Exact HyperMD parsing and malformed delimiter recovery are not established by names alone. |
| Comment | 2570967 | Uses a separate per-selection toggle. Comments can span lines and retain selected boundary whitespace. A collapsed caret can expand to its word. Dispatch has no explicit user-event annotation at this site. |
| Highlight selection | 2567391–2568905 | A collapsed caret inside a highlight uses that highlight; otherwise it can use the current word or empty caret. Nonempty selections split into eligible content-line ranges. |
| Highlight transformation | 787400–789700; 2567391 | Selecting the same color over fully highlighted ranges removes their highlight markers. Otherwise colors can be added, recolored, and split while retaining unselected colored portions. Adjacent/overlapping same-color portions are merged. Color-change boundaries trim whitespace from surviving old-color portions. Empty highlight creation positions the caret after its opening/color prefix. Uses `input.type` and focuses the editor. |
| Color encoding | 754717–755160 | Default has no color prefix. Named colors use colored-circle emoji immediately after opening double equals. Corresponding square emoji aliases are recognized; existing aliases are retained when possible during edits. |
| Clear formatting | 2566370 | Only nonempty selections are considered. Formatting-token ranges encountered within selections are removed. It does not replace the selected region with rendered/plain DOM text. Dispatch has no explicit event annotation. |

The highlighted offsets are bounded manually inspected neighborhoods, not assertions that every helper branch or caller was covered.

## Implementation and integration

`formatMenuForEditor(view, { inTableCell?: boolean })` returns a recursive local action tree. Actions contain `id`, `label`, `enabled`, optional `checked`, and `run(): boolean`; submenus contain `id`, `label`, `enabled`, and `submenu`; separators contain `type: 'separator'`. The helper supplies Add link, Add external link, and Format. With `inTableCell: true` it also supplies the real disabled Paragraph/Insert descriptors and their disabled children. Block actions are deliberately unavailable there, matching the inspected menu; their callbacks cannot mutate text.

Commands operate on the owning CodeMirror view's current state and selections, recheck read-only status and DOM lifetime, and dispatch ordinary Markdown changes. The caller retains menu ownership/version checks and serializes only menu descriptors across platform IPC. When called on a nested table-cell view, its existing dispatcher maps text, pipe escapes, selections, and changes into the parent document and history. No separate cell document persistence or DOM-text rewriting was introduced.

Lezer supplies supported Markdown structure and alternate marker spans. A bounded original scanner handles highlight/color, inline dollar math, and percent comments, excluding code and escaped openers. The implementation preserves standard-source delimiters and uses composed CodeMirror changes for removal/wrapping/color splitting. Comment/math content is opaque to nested formatting-state detection.

## Validation and comparison limits

Eighteen tests cover menu labels/order/disabled blocks, link caret placement, multiline link rejection, stale-readonly and destroyed-view actions, bold trimming and reversed selections, underscore removal, caret/word formatting, closing-marker skipping, multiline structural prefixes, code exclusion, multiselections and first-range mode, comments, code/math, highlight recolor/split/remove/aliases, empty highlighted carets, token-based clear, and actual nested-table source mapping with parent undo. TypeScript passes.

Remaining gaps are exact HyperMD tokenization for malformed/ambiguous delimiters, display-math block parsing, code-delimiter collision/empty-pair edge cases, every overlapping multi-selection expansion, all clear-formatting token classes in complex HTML/fences/references, native menu icons/color swatches/macOS writing tools, contextual link/tag suppression, and native accessibility/pixel behavior. The parent builder owns clipboard actions and table-specific sections. Rectangular selection gestures and menu lifetime remain caller-owned; supplied-range formatting is covered below. Static evidence plus local tests do not certify complete reference parity.


## Review follow-up: indexed inspection and protected closing delimiters

Review reproduced a menu-opening regression on 10,000 percent comments (120 KB): repeatedly scanning all earlier excluded spans and all opaque spans made inspection quadratic. The original implementation now builds sorted interval indexes with prefix maximum endpoints for lexical exclusion, opaque containment, per-format coverage, and protected-block overlap. Each membership query uses binary search; scans no longer walk every prior comment. A regression runs 1,000- and 10,000-comment documents and counts linear-membership predicate visits rather than imposing a machine-dependent timing threshold. Local informational checks measured approximately 2/3/5 ms at 1,000/5,000/10,000 comments after this change; these are Zorid measurements, not reference runtime claims.

The same review found a valid highlight containing inline code whose literal `==` was incorrectly chosen as the closing highlight delimiter. Closing-delimiter search now consults the lexical exclusion index as well as opening-delimiter search. For a highlight around `a`, inline code containing `x==y`, and `z`, removing the highlight preserves the code delimiters and literal inner equals; clearing formatting additionally removes the backticks but preserves `x==y`. The regression checks both operations. Percent comments retain their separate opaque-body termination rule.


## Neutral rectangular-selection adapter

`FormatMenuOptions` additionally accepts `ranges?: () => readonly { from: number; to: number }[]` and `annotations?: readonly Annotation<unknown>[]`. The provider resolves absolute encoded cell text spans when building the menu and again when running an action, so preceding edits cannot leave cached offsets. Empty provider results and invalid spans disable/reject actions. The caller can take only the `format` submenu and position it within its table menu.

A derived CodeMirror state supplies the ranges internally; there is no preliminary selection dispatch that could clear a rectangle or activate a cell. Formatting dispatches a single resulting transaction with caller annotations. In supplied-range mode inspection traverses parent TableCell inline syntax, first-cell state controls the common generic-toggle mode, and empty cells do not gain delimiters. The table module remains responsible for source-snapshot guards, rectangle ownership, gesture state, and preserving the rectangle through annotated transactions.

The adapter follows the existing static `getFormattingRanges`/selected-cell path near app.js 2566370–2567391 and the nonempty-table-range branches of generic/highlight toggles. Three additional tests cover encoded source positions/pipe preservation, first-cell state, empty cells, exact transaction count/annotations, action-time relocation, stale or invalid providers, selected-column highlight/clear, and undo. No table-module dependency or copied formatting implementation was introduced.

Rectangle scanner repair: custom highlight, inline math and comment recognition now uses the caller’s independent cell source ranges directly, so partial Lezer trees cannot accidentally pair cells. Standard Markdown parsing is advanced through the selected ranges with a bounded 50 ms budget; an unavailable tree declines the action rather than guessing. Delimiters cannot pair across columns, rows, separator rows, or a table boundary. Encoded `<br>` and escaped pipes remain byte-preserved. The 21-test suite covers unmatched cross-cell delimiters, first-cell state, selected-only mutation, and local wrapper removal.
 Late-table regressions start with an intentionally partial syntax tree and cover all custom delimiters, inline-code protection and standard bold removal.
