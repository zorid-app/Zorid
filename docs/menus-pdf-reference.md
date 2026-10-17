# PDF menu reference and independent action builders

This focused static audit reuses the user-supplied Obsidian 1.14.4 desktop payload and prior partial REA application evidence E3, `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. It does not execute the reference, certify native menu presentation or complete PDF/plugin parity. Recovered files remain outside project source. See [PDF reference](pdf-reference.md) for renderer, destination, selection and annotation evidence beyond menus.

## Evidence identity

The inspected files are under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/`:

| File | SHA-256 | Scope |
| --- | --- | --- |
| `app.js` | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` | Selected PDF wrapper menu constructions and helper methods. |
| `i18n.js` | `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713` | Default English labels; no translation/runtime locale validation. |

A-prefixed locations below are zero-based Unicode character offsets in UTF-8-decoded `app.js`; L-prefixed locations use decoded `i18n.js`. They identify ordinary bounded static readings, not byte offsets, a new REA graph, complete function coverage or runtime observations. The application digest was rechecked in this pass. English PDF labels are in the block near L126700–128100; lookup label is at L35896. The source's title truncation helper at A817272 keeps at most limit-minus-one code units, trims that prefix, then adds an ellipsis.

## Ordered menu contracts

A menu section boundary is represented below by a separator. The source assigns named sections; exact native separator rendering and native/plugin menu contributions remain unmeasured.

### PDF page, selected text and annotations

At A2664854–2667400, the page context handler first requires the desktop-app flag, an HTML `.page` ancestor and a numeric page number. Trusted Electron events await native context information; missing information or an already-prevented event aborts this path. The native `canCopy` flag controls Copy's enabled state. The non-native/synthetic branch starts with Copy permitted. Selected text has newline runs replaced with spaces, passes through PDF.js `normalizeUnicode`, then has null characters removed.

| Order / section | Label | Condition and effect |
| --- | --- | --- |
| 1, action | `Look up “<selection>”` | macOS, Electron handle and nonempty normalized selection; displayed text shortened to 25 code units. Invokes native definition lookup for the selection. |
| 2, selection | `Copy` | Nonempty normalized selection. Disabled when native Copy is unavailable. Uses the originating native web contents when available, otherwise writes the normalized text. |
| 3, selection | `Copy as quote` | A same-page range serializes to four text-item-index/character-offset integers. Copies `> <normalized text>`, two newlines, then the generated selection link. |
| 4, selection | `Copy link to selection` | Same serialized-range condition. Copies the generated link alone. |
| 5, annotation | `Copy annotation` | Hit annotation is not subtype `Widget`, has an ID, and extracted marked text is nonempty. Copies `> <marked text>`, two newlines, then its annotation link. |
| 6, annotation | `Copy link to annotation` | Non-Widget annotation with ID, including when no marked text is extracted. Copies its annotation link. |

The range predicate is independent of the plain-text Copy predicate; the source does not additionally require nonempty selected text before adding the two selection-link actions. Widget annotations are excluded here; **Link annotations are not excluded** by this context-menu subtype test. This differs from the custom annotation-popup pointer handler's exclusions.

Selection links use `#page=N&selection=startItem,startOffset,endItem,endOffset`. Annotation links use `#page=N&annotation=id`. A2664210–2664470 builds a page alias from the PDF basename and localized `page N`; A2674116 delegates final link formatting to the real file manager. Neither hard-coded wiki syntax nor a generic browser URL captures configurable link formatting.

The source clears ephemeral annotation/selection UI before presenting the constructed menu. It prevents the event for embeds or its non-native/synthetic branch. The same handler adds no generic page-link, print, download, rotate, delete, annotation-creation or open-file action to a blank page. This is a bounded statement about this constructor, not proof that those actions cannot occur elsewhere.

### Thumbnail, outline and links

At A2667722–2668150, a thumbnail context target must itself have the `thumbnail` class and a numeric `data-page-number`. It contributes one item, `Copy link to page N`, using `#page=N` with the page alias. The inspected thumbnail constructor has no desktop-only gate. Descendant target handling depends on the reference's `targetNode` abstraction and must be established in integration; replacing it with arbitrary closest-element matching is not an observed rule.

At A2645650–2646500, an outline item's context handler first resolves its Markdown link; a null result yields no item. With a title, whitespace runs become spaces and the title is shortened to 40 code units; the item is `Copy link to “<title>”`. Without a title it is `Copy link to section`. The action copies the resolved link. These labels are anchored at L127282/L127327. At A2640000–2642600 the resolver handles named/explicit destinations and document replacement, resolves a one-based page, and includes supported XYZ offset components. Outline external-URL activation is a separate click path: a URL-only item with no resolvable PDF destination does not acquire a fabricated section-link menu from this path.

The bounded PDF wrapper reading found no distinct external-link menu constructor. Annotation links, PDF internal destinations, outline section links, Electron's native link menu and app-wide external-link policy are separate concerns. No “Open link” or “Copy link address” action is added by the new builder based only on an anchor's presence. App-wide/native link menu composition remains unresolved.

### Sidebar options

A2649600–2651600 constructs these items in order:

1. `Thumbnails`, checked only when the sidebar is open with active view 1. Toggles that view to 0 when selected, otherwise opens view 1.
2. `Table of contents`, checked only when open with active view 2, disabled without an outline. Toggles that view to 0 when selected, otherwise opens view 2.
3. After the action-section boundary, `Reveal page in table of contents`, disabled without an outline. Opens view 2 when needed, then dispatches current-outline-item reveal.

### Display options

A2651700–2654300 orders zoom, spread and appearance sections:

1. `Fit width`, checked for `page-width`; dispatches that scale.
2. `Fit height`, checked for `page-height`; dispatches that scale.
3. Separator, then `Single page`, checked for spread 0.
4. `Two-page (odd)`, checked for spread 1.
5. `Two-page (even)`, checked for spread 2.
6. Separator, then `Adapt to theme`, checked from its persisted preference; toggles persistence and reapplies appearance.

Each source toolbar popup uses an open flag reset on hide; duplicate-open coordination and positioning belong to the menu/view integration, not the descriptor factory.

## Independent implementation and integration boundary

[src/ui/pdf-menus.ts](../src/ui/pdf-menus.ts) supplies original, UI-independent descriptor/action factories:

- `createPdfPageMenu`, `createPdfThumbnailMenu`, `createPdfOutlineMenu`.
- `createPdfSidebarMenu`, `createPdfDisplayMenu`.
- `normalizePdfMenuText`, which accepts the host's actual PDF.js Unicode normalizer. Without it, only newline/null cleanup is performed; this is an explicit normalization gap.

Each returns `PdfMenuSession` with serializable `items`, asynchronous `run(id)` and `dispose()`. Only descriptor data crosses the existing platform menu boundary. Unknown/disabled IDs cannot invoke a callback; a known enabled action is consumed once, and errors propagate to the caller. `isCurrent` lets the viewer reject actions after document/selection replacement. Disposal blocks retained callbacks and suppresses a delayed outline reveal after an asynchronous sidebar switch. Clipboard operations already started cannot be cancelled by this boundary.

All OS, clipboard, link-formatting and viewer capabilities are explicit optional callbacks. Unavailable capabilities omit their actions. This is an intentional capability restriction relative to the reference, avoiding an enabled action with no implementation. `Adapt to theme` additionally requires actual boolean preference state and a setter; its presence is not inferred from the PDF viewer's existence. Outline destinations must be resolved before building the outline menu. Selection endpoints and annotation hit/extracted text come from the real viewer; this builder does not guess them from DOM text. Annotation IDs are URI-encoded when forming a query, an independent robustness choice for reserved characters rather than a copied source implementation.

Integration must take a stable document/selection snapshot, provide a guard that checks viewer lifecycle and menu generation, await `showContextMenu(event, menu.items)`, call `menu.run(id)`, report any error, and dispose the session in `finally`. The caller retains responsibility for event gating, single active popup, focus/selection preservation, clearing ephemeral UI, resolving asynchronous annotation/outline information and dismissing pending menus on teardown. The builder does not mutate `pdf-view.ts`, CSS or platform menus.

[Tests](../tests/pdf-menus.test.ts) verify order, checked/disabled state, exact callback arguments and clipboard payloads, unsupported-capability omission, native-copy preference, mobile/Widget exclusions, destination formatting, one-shot and stale/disposed actions, error propagation and cancellation between asynchronous sidebar activation and reveal. These tests establish the builder contract only. PDF rendering, native clipboard/lookup, integration hit testing, Unicode equivalence, mobile copy augmentation, dynamic plugins and visual/native menu parity remain open.

## Outline menu integration supplement

The focused follow-up rechecked `app.js` and `i18n.js` against the hashes above and read A2639800–2642800, A2645200–2646650, A2674050–2674300 and L127100–127450. These are inert source readings tied to the historical E3/extraction identities, not a fresh REA semantic analysis or observed execution. The extraction identity is `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`; no reference code was executed or copied into the project.

The outline row's context handler is attached to its own row element and respects an already-prevented event. Embedded viewers prevent the context event before awaiting the link. No desktop-only condition appears in this outline handler. Its only constructed action is the section-link copy action described above. There are no outline-specific OS-only commands to emulate in this inspected constructor; page-selection Look up remains a separate unsupported host capability.

The destination resolver includes an offset only for a five-element `XYZ` destination with a non-null left component. It appends top only when non-null, then zoom only when top and zoom are non-null: a missing top does not emit a placeholder to reach zoom. The generated alias is the PDF basename, comma and space, then the whitespace-normalized outline title. An empty title therefore retains the basename plus comma and space; the menu label becomes `Copy link to section`. Final file-manager link generation uses an empty source path for all PDF surfaces (A2674106).

The original implementation connects `PdfSidebarOptions.onOutlineContextMenu` to the existing `createPdfOutlineMenu` and `showContextMenu` transport. It resolves actual named/explicit destinations and page references without navigating, preserves finite XYZ values (including zero/fractions), and checks document/sidebar/row identity before and after waits. Copy actions become inert after closure, collapse of an ancestor, sidebar mode changes, retargeting, a newer menu or viewer disposal. Toolbar and content menus share a generation guard so a late outline lookup cannot replace a newer display/sidebar menu. Shared media leases, page-selection state and platform bridges are unchanged.

Implementation validation deliberately rejects out-of-document pages and non-finite offset components. The source's named-destination path additionally tests for a reference object's numeric `num` field; the original resolver accepts the public engine's explicit integer page index as well. This is a bounded permissive difference for unusual named-destination outputs, not established malformed-input parity. URL-only outline entries produce no fabricated PDF section-link action. Absence of clipboard or the host's real link formatter omits the context handler capability.

Focused tests cover real viewer/sidebar wiring to the transport seam, named/explicit destinations, offset truncation at null, title normalization, untitled/mobile entries, exact pointer coordinates, unchanged page/selection, stale/destroyed/retargeted targets, unavailable capabilities and competing menu resolution. Existing official PDF.js engine/outline/thumbnail tests remain green. These results establish original integration behavior; native menu appearance, touch long-press, keyboard context invocation and reference visual parity still require runtime verification. Worktree: `parity/pdf-outline-menu`, based on `9a2fd49`; the parent integration owner records the final reviewed commit and main integration separately.
