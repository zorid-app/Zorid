# Live list markers: bounded static evidence and original implementation

This follows the supplied Obsidian 1.14.4 desktop artifact and the user's screenshot showing unwanted literal dashes beside task checkboxes and ordinary list items. No reference UI, reference functions, or native application was executed. No recovered implementation or assets were copied into this repository.

## Provenance

REA renderer Evidence E3 is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. Its portable bundle was imported from `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json` into this worker's REA session. Summary view `ev_415d70cd7f988e2c9ed903f2b5d3be98983f690c32ec5c590ecd12621c6158cb` confirms partial graph coverage: the renderer exceeded the parent's semantic graph memory budget; retained module/static facts remain available. The incoming exact-string trace for `list-bullet`, `ev_3bc036d3c6caffe37733a3cf56ef9525432e2260484fc251f87e9cb18176cc54`, had no match in that partial graph. This does not establish absence.

The following are focused manual static source observations tied to E3's artifact identity, not REA-proven complete call relationships. Source is `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, verified SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`. Companion app.css identity is `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`. Offsets below count Unicode characters in UTF-8-decoded files. See also [checkbox and indentation evidence](list-fold-reference.md) and [pointer/editor evidence](editor-reference.md).

## Observations

| Question | Static location | Finding and boundary |
| --- | --- | --- |
| Ordinary unordered markers | app.js 3018600–3018780, 3042100–3043990 | The inactive unordered marker uses a `list-bullet` mark on the source marker character. It is not a Unicode bullet widget. The task-prefix branch retains a hidden replacement instead of that bullet mark when the line has a task status. |
| Ordered markers | app.js 3042100–3043990 | Ordered formatting receives a `list-number` mark. No corresponding task suppression branch was observed for ordered numbers; numbered tasks retain their numbers. |
| Bullet appearance | app.css 407950–408850; variable defaults near line 2483 | Source marker text is transparent while a pseudo-element draws a solid circle. Default size is 0.3em. This supports font-independent circle geometry rather than selecting a Unicode glyph. CSS measurements are static values, not a pixel comparison at a particular zoom. |
| Editing-marker reveal | app.js 3039700–3043990 | Focused selection or search-highlight overlap reveals grouped formatting. Inclusive boundary overlap is documented in editor-reference. Full HyperMD group boundaries remain incompletely traced; whole-active-line hiding is not the observed rule. |
| Nested indentation | app.js 1947550–1949050 | Whitespace prefixes are processed in tab or four-space units. Quote markers and one following space are skipped. Partial space groups are spacing, not full guide segments. Active-guide choice has separate main-selection/descendant logic. |
| Guide appearance | app.css 264300–264970; 406500–406950 | Guide segments have a minimum list-indent width and an absolutely positioned vertical line; editing offset is 0.85em. List marker editing padding defaults to 0.75em. |
| Pointer and IME stability | app.js 3039200–3039740 and pointer branch 3054001; prior editor-reference investigation | Existing inline decorations map through changes during composition or pointer selection. Capture-phase tracking occurs before hit testing. Release schedules a later refresh rather than restoring an old selection. |

## Implemented contract

`liveLists({ showIndentGuide?: boolean } = {})` and `liveTasks()` share parser-owned list/task candidates, prefix/status reveal boundaries, and one CodeMirror interaction controller. Install both only in Live Edit, and load `src/editor/live-lists.css`. The option defaults to showing guides. Configured editor tab size remains owned by the existing list-command configuration.

The original implementation marks ordinary unordered source characters and draws a solid 0.3em CSS circle. It suppresses the unordered list prefix up to the task marker, so even an empty nested task shows no dash beside its checkbox. Ordered source numbers remain visible. Source bytes are not rewritten. Task controls continue replacing only their status character, including custom non-space statuses, with x/X-only done styling and current-position lookup after external edits.

The installed Lezer tree owns actual list membership. Frontmatter, tables, fenced/indented code, comments, HTML blocks, escaped task brackets, and task-like prose do not become checkbox candidates. A list item whose first block is indented code does not become a task merely because its raw source contains brackets. Prefix replacements and task widgets occupy adjacent, nonoverlapping source ranges.

The shared capture-phase controller freezes and maps list and checkbox decoration geometry through mouse selection and composition, then refreshes the latest editor state. It cleans up listeners and pending timers on destruction and rejects nested-editor pointer ownership. It does not replay a captured selection. Focused caret/selection intersection with the prefix or status reveals both; body carets retain presentation.

## Validation and remaining gaps

DOM/transaction tests cover solid-marker classes, suppressed unordered task prefixes, ordered task numbers, nested empty tasks, quotes, tabs/four-space guide groups, guide preference, code/table/frontmatter exclusions, custom statuses, multi/reversed selections, focus, external prefix edits, undo, pointer mapping, composition completion, and destruction with a pending refresh. These tests verify Zorid source/DOM behavior, not native reference rendering or physical pointer hit testing.

Remaining comparison gaps are exact HyperMD grouping/search-highlight reveal, active ancestor-guide highlighting, soft-wrap guide geometry, CSS alignment at varied font/zoom settings, touch/Android scroll/vibration behavior, and native accessibility/IME differences. Folding controls and keyboard list commands are separate scopes. The reference guide implementation considers general whitespace-prefixed lines; this extension intentionally gates guides to actual list items/continuations to avoid treating code or table content as lists. No claim of complete desktop/mobile parity follows from this bounded static pass.
