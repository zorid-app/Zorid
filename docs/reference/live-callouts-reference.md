# Live callouts: evidence and implementation

## Evidence boundary

This audit used retained Obsidian 1.14.4 shipped JavaScript and CSS as static evidence. No reference application was executed, and recovered implementation text was not copied into project source. Offsets below are zero-based Unicode character positions after UTF-8 decoding, not byte offsets.

- ASAR SHA-256: `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.
- `app.js` SHA-256: `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
- `app.css` SHA-256: `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.
- Retained E3 evidence: `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; inspected summary: `ev_415d70cd7f988e2c9ed903f2b5d3be98983f690c32ec5c590ecd12621c6158cb`.
- Restored extraction: `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`. The restored source hashes match the retained audit. The semantic graph was partial because the large JavaScript artifact exceeded its analysis budget; missing graph entries do not establish absent behavior.

## Static contracts

| Location | Observed contract |
| --- | --- |
| `app.js` 177300–178350 | A quote's first line recognizes `[!type]`, optional `+` or `-`, followed by whitespace or end of line. Type is trimmed, lowercased, and whitespace normalized to hyphens. A pipe separates metadata. One structural quote layer is stripped and the body recursively tokenized. |
| `app.js` 767384–769300 | Callout DOM carries type, fold and metadata attributes, with separate icon, title and content elements. An omitted title derives from the type with hyphens replaced by spaces and the initial letter capitalized. Explicit icon/color fields also exist; not all producers were traced. |
| `app.js` 2029500–2031000 | `-` starts collapsed and `+` starts expanded. The fold button toggles immediately on primary click. Title click defers the toggle and respects a subsequently prevented event. Folding changes rendered state without rewriting the source marker. |
| `app.js` 3033204–3036800 | Callouts use block widgets, recursively render Markdown, map task checkbox lines to source transactions, expose source editing, and request layout measurement through a cleaned-up resize observer. Type-change/remove context actions also exist. |
| `app.js` 3044479–3054001, particularly 3046500–3050200 | Top-level callout quotes become block replacements. Focused selection or search overlap reveals their source. Widget reuse depends on source text; pointer/composition handling preserves geometry while the gesture is active. |
| `app.js` 1949481–1950400 | Desktop Edit block selects the full source backward: anchor at the end and head at the start. Mobile selects a collapsed start position. |
| `app.js` 870659–871850 | Source activation excludes prevented, modified, multiple-click and noncollapsed rendered-text-selection events. A direct text hit delays activation longer than a background hit; a subsequent multiple-click cancels the pending activation. |
| `app.css` 351951–356100 | Built-in callout families define icons, palette colors, nested spacing, title/fold layout and collapsed rotation. |
| `app.css` 97795–97949 and 99977–100131 | Light and dark RGB palette values used by built-in callout families. |

The static factory gates the outer replacement on first-level quote syntax. Nested callouts inside a rendered outer callout use recursive Markdown rendering. The original implementation similarly keeps ordinary quote blocks, list-owned outer quotes, fenced examples, and frontmatter out of the top-level callout replacement path. Lists, ordinary quotes, and nested callouts inside a rendered callout are rendered recursively; fenced code remains literal. This is not a claim of identical native geometry for every list/quote nesting arrangement.

## Original implementation and integration

`src/editor/live-callouts.ts` exports:

- `liveCallouts({ open?, renderEmbed? })`, the editor extension. `renderEmbed` returns `{ dom, destroy }`; the extension releases each mounted resource once when its widget is removed.
- `renderedCalloutRanges(state)`, the current block replacement spans. It returns an empty array when the optional callout field is absent. Other live renderers should exclude covered spans before applying their own replacement/line decorations. The helper introduces no extension-order requirement.
- `parseCalloutHeader(text)`, the marker parser used by the renderer and focused tests.

The extension discovers callouts from the shared incremental Markdown tree when document/tree identity changes. Selection-only transactions reuse discovered spans and do not parse Markdown or remount an unchanged widget. Search matches are cached until the query, panel, document or tree changes. Full match ranges are scanned so matches crossing a callout boundary reveal the source too. A focused source selection reveals the full intersected block; inactive editors keep it rendered. Pointer and composition holds map existing geometry until their gesture finishes. Focus, listeners, delayed source/title actions, embedded resources and observers are cleaned up. Each resource disposer runs independently, so one failing child cannot skip its siblings. If rendering fails after mounting children, completed mounts are released and the complete callout source remains visible with its Edit source action.

Task clicks update the owning editor's current mapped source and history, reject stale source widgets, and respect read-only state. Source editing uses backward full-block selection. Fold state is local to an unchanged source widget and survives source reveal/remount and unrelated prefix edits; changing callout source resets it. The renderer uses safe inline Markdown handling and explicit icon nodes, never HTML from marker/type/title input. Nested block rendering has an original resource guard: at most 32 active recursive block levels and a cumulative parse budget of `min(1,000,000, max(32,768, 8 × original source length))` UTF-16 units. When either limit is reached, the remaining source is displayed literally without dropping content. This fallback is an explicit robustness policy, not a claimed reference limit.

Root integration must install the extension and import `live-callouts.css`, pass the shared embed renderer and link route, and apply `renderedCalloutRanges` exclusions to overlapping renderers. These files deliberately do not modify editor/workspace wiring.

## Validation and remaining boundaries

`node --test tests/live-callouts.test.ts`: 19 real CodeMirror/jsdom tests pass. Coverage includes marker normalization, built-in/unknown types, safe titles/links, nested list/quote/fence rendering, folding and event prevention, source mapping and history, multiple selections/search, pointer holds, task updates/read-only, prototype-like type names, stale controls, modified clicks, delayed activation yielding to newer caret/focus/pointer intent, exception-safe partial/normal embed cleanup, deeply nested parsing bounds, frontmatter exclusions, and no parse/remount during repeated outside-caret changes. `npm run check` and `git diff --check` pass. This focused run follows the host's low-memory constraint; no full suite or build was run.

Native pointer hit testing, rendered selection rectangles, resize/scroll behavior, theme pixel matching, accessibility navigation and mobile behavior still require integration/native verification. The desktop backward selection behavior is implemented; a distinct mobile collapsed-source selection policy is not. Quote/cite uses the open-source Lucide Quote icon as an original approximation of the reference's custom quote glyph. Plugin/custom icon and color overrides, callout type-change/remove context actions, and reading-mode renderer parity are not implemented by this isolated extension. Tables rendered inside callouts use the existing reading renderer, not nested editable table controllers.
