# Link and tag context menus — Obsidian 1.14.4

This focused audit covers editor token menus, Reading-mode anchors, and ordinary links to attachment files. It does not cover image/lightbox/embed controls, footnote deletion, general editor formatting, table commands, or the full file-explorer menu. Findings are static source observations; the reference application was not executed.

## Evidence and identity

The `reverse-engineer-anything` skill was reused with retained E3 evidence, not a new broad analysis. E3 is `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; source module `jag_node_621f724371e7aca9238d1f3a97fd54476f29e95749ed28f0e9b6a7f00f7078a2`. Its renderer graph is partial because expanded graph retention exceeded the result memory budget. The exported record is `/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json`; see [reference evidence](reference-evidence.md) for the original coverage and limitations.

Behavior below comes from **ordinary focused reading** of `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/app.js`, SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`, 3,942,126 bytes. English labels were checked separately in its packaged `i18n.js`, SHA-256 `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713`. Neither a label nor a menu-registration string alone establishes behavior: action/condition claims follow their corresponding branches and callbacks.

All ranges below are half-open zero-based Python Unicode character offsets in the UTF-8-decoded source, not byte offsets. Application source-selection ranges use JavaScript UTF-16 offsets instead. Minified function names are build-local anchors. No recovered source is distributed in the repository.

| Source range in `app.js` | Inspected behavior |
| --- | --- |
| 653640–654060; 860507–860800 | Relative-link predicate, external URL normalization, URL parsing validation |
| 778339–778470 | Internal link path/subpath separation at first hash |
| 1223314–1224790 | Menu section sorting and submenu grouping |
| 2020970–2022830 | Reading anchor event delegation and renderer ownership boundary |
| 2033130–2034550 | Reading internal/external menus, Copy text and tag click |
| 2573213–2576460 | Syntax-token link/tag classification and edit-span extraction |
| 2587028–2588000 | Reference-link URL resolution and token click behavior |
| 2591850–2594930 | Editor context-menu eligibility, section order, link/tag branches |
| 2597400–2598200 | General editor insert-link entries, outside this builder's ownership |
| 2888663–2890920 | Shared workspace `file-menu` contributions |
| 2941175–2942990 | Shared internal and external link menu helpers |
| 2984380–2985620 | Enabled web-viewer plugin's URL-menu contribution |
| 3270312–3270795 | Bookmark/Edit bookmark contribution |
| 3454201–3454515 | File-explorer Reveal file in navigation contribution |
| 3638049–3638360 | Markdown presentation contribution |
| 2723584–2724180; 3061955–3062940; 3495049–3495520; 3512435–3512920; 3526765–3527220 | Leaf-dependent linked-view contributions |

## Token and renderer eligibility

The editor obtains the clickable target from the syntax tree at a document position, not from arbitrary text beneath the pointer. It aggregates wiki-link tokens, separates aliases and subpaths, and uses the aggregate's source span. Markdown link-label clicks can advance to the corresponding URL token. Reference links are distinct from direct external links. External references resolve through cached reference definitions; internal relative Markdown destinations are decoded and normalized in their own path. Tags aggregate adjacent hashtag tokens. This audit does not independently reconstruct every syntax-tree annotation. [2573213–2576460; 2587028–2588000]

The editor first rejects already handled events and events outside its content DOM. Mobile pointer/soft-keyboard checks affect whether a menu opens. A normal context event on the bare `.cm-line` element clears the clickable token rather than showing a link-specific menu. Thus pointer position alone is insufficient to claim an owned link target. [2591850–2594210]

Reading delegation obtains an internal anchor's `data-href`, falling back to `href`; external anchors use `href`. A candidate must belong to the requested renderer container. Traversal stops at another Markdown preview or Bases view, protecting nested render ownership. The registered Reading tag event in this inspected delegate is **click**, which opens global tag search; no tag-specific contextmenu handler is registered in this branch. This is a bounded finding, not proof that plugins or other surfaces cannot add one. [2020970–2022830; 2033130–2034550]

Ordinary internal anchors to attachments use the same shared file resolver/menu as note links. The shared helper does not select different core open/rename actions by extension. Image/video element context events are delegated separately; an image embed's remove/resize/swap controls must not be inferred for a plain attachment link. [2020970–2022830; 2941175–2942492]

## Exact core branches and callback meaning

| Context/condition | Entry and section | Action |
| --- | --- | --- |
| Editor direct internal or direct external token | **Edit link**, `selection` | Focus editor and select the token's start/end span. It does not open a dedicated edit dialog. |
| Editor external reference token | No Edit link entry from this branch | Resolve reference href, then use the shared external menu if present. |
| Editor tag token | **Edit tag**, `selection` | Focus editor and select from one character after the token start through its end, leaving `#` outside the selection. |
| Reading internal or external anchor | **Copy**, `clipboard` | Copy the anchor's displayed text; this differs from copying the destination URL. |
| Shared internal link, nonempty target, phone | Noninteractive title, `title` | Resolved short filename or unresolved link path without its fragment. |
| Shared internal link, resolved file, phone | **Open link**, `open` | Open original link text relative to source path, respecting the invoking event's modifier interpretation. |
| Shared internal link, resolved file | **Open in new tab**, `open` | Open original link with destination `tab`. |
| Shared internal link, resolved file and split capability | **Open to the right**, `open` | Open original link with destination `split`. |
| Shared internal link, resolved file | **Rename...**, `action` | Prompt to rename the resolved file. Then invoke `file-menu` with context `link-context-menu`. |
| Shared internal link, unresolved target | **Create this file**, `open` | Route through link opening, allowing file creation; no resolved-file extension hooks are triggered by this helper branch. |
| Shared external link, nonempty URL | **Copy URL**, `info` | Copy the supplied URL and show the copied notification. |
| Shared external link, nonempty URL | **Open link in default browser**, `open` | Open the URL with the external-browser destination, then invoke `url-menu` extension hooks. |
| Web-viewer plugin enabled and registered | **Open link in web viewer**, `open` | Delegate URL opening to the web viewer with event modifier interpretation. |

The shared internal helper resolves the path portion before the first hash, but passes the **complete original link text including subpath** to current/tab/split opens. [778339–778470; 2941175–2942990] English labels are present in `i18n.js` at 29475–29540 (Edit link/tag), 35541–35690 (Create/Open/New tab/split/Copy URL), 57005–57032 (Rename), and 104643–104765 (browser/web viewer).

## Section order and common file contributions

Menu construction order is not final presentation order. The menu sorter groups by declared section order, preserves insertion order within each section, adds section separators, and creates configured submenus for matching section prefixes. Previously unlisted sections append to the section list in first-use order. Therefore an `info.copy` or `system` contribution can appear after the initially declared sections rather than beside a similarly named parent. [1223314–1224790]

The editor declares this order:

`title → correction → spellcheck → open → selection-link → selection → selection.format → selection.paragraph → selection.paragraph.list → selection.paragraph.heading → selection.paragraph.block → selection.insert.basic → selection.insert.advanced → insert → clipboard → info → info.copy → action → view → unnamed → danger`.

Reading internal-link order is:

`title → open → action → clipboard → view → info → unnamed → danger`.

Reading external-link order is:

`title → open → selection → clipboard → info → action → view → unnamed → danger`.

Consequently a desktop resolved internal editor link's core entries are open-new-tab, optional split, Edit link, then Rename, with surrounding general editor/file contributions interleaved by section. Reading internal core entries are open-new-tab, optional split, Rename, then Copy. External Reading core entries are open-in-browser, optional web-viewer opening, Copy displayed text, then Copy URL. Editor external core entries are open-in-browser, optional web-viewer opening, Edit link for direct links, then Copy URL. [2591850–2594930; 2033130–2034550; 2941175–2942990]

A common workspace `file-menu` listener configures the **Copy path** submenu and registers the following entries, in this insertion order before section sorting. [2888663–2890920]

| Condition | Entry/section | Callback detail |
| --- | --- | --- |
| File | **as Obsidian URL**, `info.copy` | Application generates/copies its own protocol URL. |
| File | **Open in default app**, or **Share** on mobile app, `system` | Open the resolved file path through the host. |
| Mutable file/folder predicate | **Move file to...** / folder equivalent, `action` | Open move dialog. Only files are modeled by the independent adapter. |
| Non-root entry | **from vault folder**, `info.copy` | Copy the vault-relative path through the path-formatting helper. |
| Desktop app using local filesystem adapter | **from system root**, `info.copy`; then **Reveal in Finder** on macOS or **Show in system explorer**, `system` | Obtain absolute filesystem path for copy; reveal resolved vault file through host. |
| Popout capability and file | **Open in new window**, `open` | Open the resolved file directly in a popout. This callback does not carry the original link's heading/block subpath. |

Relevant `i18n.js` labels: 35757–35875 (Copy path children), 36040–36080 (new window), 56365–56410 (Move), 74294–74455 (default app/Share/system reveal). The independent application must supply an honest protocol label for its own application URL; it must not imply that a `zorid:` URL is an Obsidian URL.

## Plugin-conditioned additions and remaining menu coverage

The helper triggers dynamic hooks; a complete menu depends on enabled plugins and their registration order. Additional inspected built-ins are:

- Bookmarks adds **Bookmark...** or **Edit bookmark** in `action` depending on lookup state, for non-root entries. [3270312–3270795]
- File explorer adds **Reveal file in navigation** in `system` for files on nonmobile surfaces, except its own file-explorer context. [3454201–3454515]
- Slides adds **Start presentation** in `view` for Markdown files. [3638049–3638360]
- Graph, backlinks, outgoing links, outline, and file-properties linked-view entries require a leaf argument. The audited editor and Reading shared-link calls do not pass that fourth argument, so those particular leaf-dependent branches do not contribute through these call sites. Backlinks' in-document toggle also requires a leaf. [2723584–2724180; 3061955–3062940; 3495049–3495520; 3512435–3512920; 3526765–3527220]

The independent adapter implements shared/core link actions and the common workspace file contributions, with capability gates. It does not yet implement bookmarks, explorer reveal, presentation, arbitrary plugin hook insertion, icon geometry, platform spellchecking/writing tools, or modal behavior. Its output must not be called the entire reference menu. General selection-link insertion and formatting entries are owned by the general editor menu implementation.

## Independent implementation and host contract

[Link menu builder](../src/editor/link-menu.ts) contains original types, target validation, source ownership capture, section ordering, and action descriptors. [Tests](../tests/link-menu.test.ts) use independent fixtures, without running the reference or copying its implementation.

`classifyLinkTarget(input, snapshot)` accepts a token already identified by the owning syntax tree or renderer. The kind is `internal`, `external`, `external-reference`, or `tag`. Reference links require an already-resolved href; this module does not reparse Markdown or look up reference definitions. Editor spans are exact token intervals in UTF-16 coordinates, excluding wiki delimiters; a tag span includes its hash. Capture validates bounds, records the exact source slice, and freezes the resulting target. Tags require the captured slice to equal the supplied tag. Alias labels and source spans remain distinct from destinations.

`buildLinkMenu(target, { surface, host, ...capabilities })` returns section-bearing `LinkMenuEntry` descriptors with `id`, `label`, `section`, `enabled`, optional noninteractive `isLabel`, and `run(invocation?): Promise<boolean>`. The general menu owner merges them with other sections, configures `info.copy` as a Copy path submenu, and converts descriptors to transport-safe items. Callbacks stay local. Optional invocation modifiers are copied to an immutable plain record: phone Open/Create actions pass it in `OpenInternalLinkRequest`, and web-viewer opening passes it as the third host callback argument. Fixed tab/split/browser destinations ignore those modifiers. Unavailable host callbacks omit their items rather than exposing dead commands.

Every run rechecks:

1. The owner's identity, source path and revision through `host.currentSnapshot()`; a destroyed owner returns null.
2. `host.ownsTarget(target)`, which must check live DOM/syntax ownership, connection, nested renderer/editor boundaries, and the active menu serial. Opening another menu or changing an embed's owner must invalidate this predicate.
3. Exact captured source text at the token span, if one exists. A text change without an incremented revision still invalidates such a span.
4. For file operations/opening, resolution still returns the same canonical vault-relative path and stable file identity. A missing target that becomes resolved invalidates the original Create action; replacement at the same path also invalidates it. Move additionally rechecks mutability.
5. Read-only state for mutation callbacks (create, rename, move). Selection and nonmutating opens remain available.

These guards are original application design, not a claim that the audited reference implemented equivalent delayed-action validation. Host callbacks remain responsible for their asynchronous work: they must retain/check the same vault/document ownership after any internal awaits before committing mutations. Failures propagate to the host's error handler; the builder does not retry or fall back to another operation.

External URL policy is also an explicit independent design choice. The reference's `QC` accepts any nonempty string parsed by `new URL`, while its external-menu callback itself is not a complete security policy. The adapter only permits parsed `http:`, `https:`, `mailto:`, and `tel:` destinations, rejects controls and unresolved/relative/executable/file/custom schemes, and supplies the canonical parsed URL to the host opener. Copy URL retains the supplied href spelling. Internal link classification rejects OS/network path forms and schemes; parent-relative and vault-root-relative link text remain for the host resolver, whose output must be canonical and vault-relative. Other protocols require a separately reviewed capability rather than implicit delegation. [653640–654060; 860507–860800; 2942492–2942990]

Validation in the isolated `parity/menu-links` worktree: `node --test tests/link-menu.test.ts` passed **17 tests**; repository `tsc --noEmit` passed. Fixtures cover ordered/conditional menus, surface differences, reference/tag selections, attachment links, external URL policy, UTF-16 source spans, absent capabilities, target replacement, source/view disposal, read-only transitions, mutability, callback failures and modifier propagation. Reading/editor integration, nested embeds, actual native menu display, accessibility, modifier routing and reference runtime comparisons remain outstanding.
