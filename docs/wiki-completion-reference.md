# Wiki-link completion: bounded reference and implementation

Snapshot: 2026-10-16. This work statically inspected the shipped 1.14.4 popup, suggestion manager and insertion branches. It did not run, attach to, or operate Obsidian. The implementation is original TypeScript/CSS, not recovered source. A passing CodeMirror/JSDOM test does not establish native geometry or reference parity.

## Artifact identities and inspection locations

All offsets below are zero-based UTF-8 byte offsets in `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`.

| Artifact | SHA-256 | Evidence scope |
| --- | --- | --- |
| `app.js` | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` | Existing E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` parsed the renderer with partial semantic coverage. This pass adds bounded direct branch reading, not a fresh whole-bundle REA analysis. |
| `app.css` | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` | Popup, complex suggestion row, list and instructions declarations; shared tokens previously recorded in [theme-layout-reference.md](theme-layout-reference.md). |
| `i18n.js` | `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713` | Bounded `editor.linkSuggestion` labels for footer, placeholders and no-match row. |

| Question | Static observation | Location |
| --- | --- | --- |
| Trigger | Looks for the last `[[` before a collapsed caret on the same line, with no later `]`; begins replacement after `[[`. Image paths followed by `|` do not trigger this suggester. | J@1817890–1819050, J@1832001–1832324 |
| Result limit | Editor suggester limits displayed results to 100. Empty result arrays become a no-match item. | J@1817640–1819360, J@1832324–1832780 |
| Initial selection | The default selected result is cleared for exactly empty, `#`, or `^` query. Nonempty queries retain first selection. | J@1832780–1833000 |
| Candidate inventory | Supported files, Markdown aliases and unresolved link texts. Markdown extensions are removed from display paths. | J@1754205–1754900 |
| Empty file query | Files/aliases ranked by file modification time descending; ignored files omitted; unresolved link texts get score zero. | J@1829400–1830720 |
| Typed file query | File matching prefers basename, otherwise path with a score penalty; aliases match alias text; ignored files remain with a penalty. Results sort descending by score. | J@1830000–1831000, J@1834253 |
| Modes | `|` selects display/alias mode; `#` selects heading; `^` or `#^` selects block; leading `##`/`^^` searches headings/blocks globally. | J@1824470–1825680 |
| Local heading traversal | Earlier `#` components identify successively nested heading levels; final component is fuzzy matched. No matches in a resolved Markdown file create a typed-heading fallback. | J@1819660–1820620, J@1826700–1827280 |
| Keyboard | Arrow up/down wrap; Home/End, Page up/down, Ctrl-P/N navigate. Enter accepts selected item. Shift-Enter uses raw query. Tab accepts; `#` accepts file/heading then continues; `^` accepts file then continues. Composition guards are present. | J@1299400–1303700, J@1831000–1832001 |
| Mouse | Mouse movement selects; click/auxclick chooses. The popup prevents mousedown focus loss. | J@1299740–1300400, J@1302980–1303650, J@1817640–1817900 |
| Replacement | Preserves a complete same-line closing pair and an already written suffix alias; file-link generation uses host link policy. Non-image file paths containing `/` gain basename display text. | J@1822610–1824430 |
| Caret | Enter/click ends after `]]`. Tab leaves the caret before `]]`, or selects display text when an alias is present. `#`/`^` continues inside delimiters, before alias if present; PDF `#` adds `page=`. | J@1822610–1824430 |
| Block ID writes | Selecting a block without an ID may generate an ID and edit this or another file in a separate mutation. | J@1833000–1834180 |
| Popup placement | Generic suggestion popup repositions with a 5px gap, overlap prevention and direction-sensitive alignment. | J@1812000–1812450 |
| Render structure | File title is basename, secondary note is folder path; alias title is alias with destination note and flair; headings show `H` level, global heading/block rows show file context. | J@1821280–1822610 |

## Implemented API

`wikiCompletion(options): Extension` installs the source, popup renderer, selection policy, key bindings and mouse handling. It replaces the previous generic `autocompletion` instance; installing both would give conflicting completion state/keymaps. Import `wiki-completion.css` separately after the base styles. `wikiCompletionSource(options): CompletionSource` is also exported for hosts that only need the source.

`WikiCompletionOptions` accepts live callbacks:

- `paths()` supplies supported file paths in stable vault order. The host owns supported-file policy, including plugin-defined extensions.
- `sourcePath()` supplies the note receiving the link.
- `metadata(path)` supplies aliases, headings (`heading`, `level`), optional existing blocks (`id`, `text`), modification time and ignored status. Current application metadata has no block index; that callback capability is available without pretending it is populated.
- `resolvePath(target, source)` and `linkText(path, source)` let the host reuse actual path resolution and link-format preferences. Without these callbacks, fallback resolution uses exact path then basename, and link generation uses a unique basename or full path. That fallback is intentionally narrower than full reference link policy.
- `unresolvedPaths()` optionally supplies unresolved link suggestions.

Candidate text is rendered with DOM text nodes, including highlight spans; no candidate data is interpreted as markup. File and alias counts are indexed once per source invocation, avoiding a quadratic basename uniqueness scan. Metadata callbacks are read again on subsequent completion requests.

The source handles files, aliases, attachments supplied by the host, typed display labels, local/global headings, nested heading paths, and existing block IDs. It retains an existing closing pair and suffix alias, and places the caret/selection according to Enter, Tab and continuation commands. An unmatched file query displays “No match found” but can be accepted as a raw destination. Raw Shift-Enter also bypasses a selected matching candidate. Blank query initially has no selection; Enter is consumed while that popup is active without creating a newline. Tab with no selected candidate falls through to the editor's other bindings.

Completion keyboard bindings have `Prec.highest` to precede editor Enter/list indentation. Mouse selection is hover-driven; mousedown preserves editor focus, and click accepts rather than accepting on CodeMirror's default mousedown. Default CodeMirror mouse acceptance is intercepted only for `.cm-wiki-completion` rows. Escape and blur close completion. Result filtering is owned by this source (`filter: false`), avoiding a second CodeMirror ranking pass.

## Popup styling and remaining differences

The wiki popup is scoped to `.cm-wiki-completion`. Source declarations at C@296420, C@307391 and C@310613–313820 establish: 500px maximum width, 300px maximum height, 8px outer radius, 1px border, 6px list padding, 15px generic suggestion text, 6px/12px row padding, 1px row margin, 4px row radius, 0.8em secondary text, bold matching text and a neutral hover background for selection. The footer uses 12px text, 8px padding, wrapping and 12px gap (C@304969–305400). Desktop light/dark shadow components come from C@97680–99865 and C@102546. Mobile declarations cap the popup at 240px and hide instructions on phones; the clone uses its existing 700px mobile breakpoint as an approximation.

The inspected wiki-link suggester uses the generic suggestion row (`15px`), rather than the separate custom CodeMirror completion row override (`13px`, C@308000–310300). The implementation therefore uses the former dimensions despite being hosted by CodeMirror. It suppresses the clone's old purple-selected completion style only in this popup. Alias flair now uses the project's licensed Lucide Forward data as a 16px SVG with 2px stroke, rather than a font-dependent text arrow. Window-specific fonts, pixel rounding, shadow rendering, popup actual width and direction/edge positioning are not runtime verified. CodeMirror handles anchoring and viewport placement; exact reference 5px gap and overlap behavior are not reproduced by a custom positioning engine.

The following remain partial:

- **Typed fuzzy ranking:** an original contiguous/subsequence matcher preserves basename preference, stable descending scores and ignored-file penalty, but does not reproduce the shipped fuzzy score function, Unicode normalization or all tie cases. Empty-query mtime ordering is implemented when metadata provides times.
- **Link policy:** full shortest/relative/absolute preference semantics require the host callbacks. Markdown-link output preference is outside this wiki-only extension.
- **Headings/Bases:** basic heading hierarchy and normalized subpaths are present; rich heading rendering, all normalization edge cases and `.base` view suggestions remain open.
- **Blocks:** only supplied existing IDs are selectable. New block extraction, ID generation, current-block exclusion and cross-file ID writes are not implemented.
- **Popup interaction:** page navigation uses CodeMirror's page step rather than the reference viewport-aligned algorithm. Exact reference cancellable/background query scheduling is not implemented. Parsed code/HTML/comment exclusions are a host-parser safeguard, not a conclusion from the narrow trigger function alone.
- **Trigger exclusions:** plugin-level arbitration, escaped/embedded syntax edge cases and image sizing suggestions need broader audit and runtime corroboration.

## Validation

`npm run check` passes. `node --test tests/wiki-completion.test.ts` passes 20 tests covering file/alias ordering, attachments, duplicate paths, callback link policy, closing-pair replacement, existing aliases, headings/blocks, typed fallback, ignored-file handling, code-context exclusions, result cap, initial selection, arrow wrapping, Enter/Tab/Shift-Enter, continuation, Escape, hover/mousedown/click, undo, and activation on actual typed transactions. The popup tests mount real CodeMirror under JSDOM with geometry shims; they validate event and document contracts, not browser coordinates or pixels. Native integration inspection is owned by the root/integration pass.


### Review repairs

Completion now extracts an explicit alias from anywhere in the remaining destination suffix before this link's same-line closing pair. That explicit text, including an empty alias, overrides an automatically generated basename/metadata alias. The extraction does not cross another opening link or a newline. Real CodeMirror Tab coverage verifies selection of the preserved alias and undo back to the original partial destination.

Syntax exclusion no longer treats a partial background tree as complete. `ensureSyntaxTree` spends at most a requested 20ms parse budget reaching the current line; if no complete tree is available (including no parser), completion declines. This is an original host-parser safeguard. Long-document fenced/inline-code tests cover the previously unparsed location; delayed parsing may temporarily suppress otherwise valid suggestions until a later request can establish context. These changes preserve exported APIs and popup CSS.


## Follow-up: effective popup styles and rendered rows

The earlier paragraph described intended declarations, but they were not all effective against CodeMirror's generated base theme. A stylesheet-loaded CodeMirror/JSDOM probe exposed the conflict: `.cm-wiki-completion > ul[role="listbox"]` has specificity `(0,2,1)` while the generated `.ͼ1 .cm-tooltip.cm-tooltip-autocomplete > ul` has `(0,3,1)`. The same issue affected row declarations. Effective probe values were monospace, list padding 0, a 250px minimum list width, 10em list height cap, row padding 1px/3px, line height 1.2 and pointer cursor. Existing behavior tests did not load CSS. This explains a concrete layout mismatch; it is not a native screenshot comparison.

The scoped rules now include all three tooltip classes plus the role attribute, exceeding the generated theme specificity regardless of stylesheet insertion order. They explicitly reset CodeMirror's list min/max width, height, padding and font, preserve natural popup width up to 500px, and allow the list to shrink within the 300px outer cap. Row padding is 6px/12px, line height 1.3, with interface text and default cursor. Selected ignored rows retain their muted text. No header or input is added.

Additional rendering corrections are bound to these UTF-8 **byte** offsets in the same hash-identified artifacts above:

| Evidence | Observation and original correction |
| --- | --- |
| J@1811040–1811710, J@1832990–1833100 | Wiki suggestions use the generic body-mounted suggestion renderer. The clone retains CodeMirror for lifecycle/keyboard integration, with explicit styling isolation; it does not borrow the unrelated 13px CodeMirror row style. |
| C@68553–68598, C@74691–74755, C@108430–109000 | Default generic text is 15px interface font with 1.3 line height. |
| C@307392–307810, C@310613–313920 | Natural width has a 500px maximum, not a fixed width or 250px minimum. Generic list/row/auxiliary declarations define the metrics described above. |
| J@1821200–1822630 | File matches are projected into folder note and basename title separately. The clone now preserves path-only match spans and clips them at the folder/title boundary using UTF-16 offsets. Candidate text remains text nodes, including markup-like filenames. Independent review caught lowercase expansion (`İ` becomes two UTF-16 units when folded): match spans now map back to original source offsets before title/folder projection, while scores remain unchanged. |
| J@1821200–1822630, C@72268–72800, C@313000–313887 | Alias flair is Forward, in a distinct auxiliary container. The clone uses installed licensed Lucide data, 16px/2px stroke, 0.85 opacity and 12px/4px inline flair margins. No reference SVG is copied. |
| J@1821200–1822630, I@29073–29400 | Empty alias/heading labels are faint placeholders. The clone marks those rows separately while preserving insertion semantics. |
| J@1299477–1299760, J@1824257–1824730, C@304969–305420 | File mode has three existing hints; other modes have the Enter hint. Command/purpose separation is an explicit 4px inline margin, not a font-dependent space. |

`tests/wiki-completion-style.test.ts` mounts real CodeMirror with the actual base/reference/wiki stylesheets. It checks competing declarations from the generated CSSOM, computed non-variable metrics, selected ignored color precedence, DOM shape, licensed alias icon ownership, Unicode path highlighting and safe candidate text. jsdom does not implement the full specificity/custom-property/important cascade: the test explicitly compares matching flat-selector specificity and moves the wiki sheet after generated styles for computed metrics. Unsupported selector syntax fails rather than silently inventing a rank. These tests do not measure pixels, color rendering or viewport placement.

Placement remains a native verification gap. J@1818980–1819330 measures query start/end; J@1812140–1812450 requests a 5px gap, overlap prevention and direction-sensitive alignment; J@868035–869600 provides 10px viewport margins, safe-area handling, flipping and available-height limits. CodeMirror anchoring is retained here. Root verification must compare actual width, long paths, footer wrapping, scrolling, themes, narrow splits, bottom/right edges and RTL. Mobile platform detection and typography remain approximations. Passing DOM tests does not close the user's visual-parity finding.
