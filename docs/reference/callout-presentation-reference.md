# Shared Reading and Live callout presentation

This original shared presentation addresses the observed native mismatch: Reading used a generic blockquote with a purple rule and plain title, while Live used the typed icon, palette and rounded callout panel. The shared renderer now emits a `div.callout.zorid-callout` with `data-callout`, metadata and fold state, an icon/title row, a content owner and optional fold button in both modes. It deliberately avoids the generic Reading blockquote border. Safe inline title rendering remains in each caller's Markdown pipeline.

## Retained static evidence

The source artifacts, hashes and REA evidence chain are recorded in [live-callouts-reference.md](live-callouts-reference.md). No recovered code was copied into source and no reference runtime was executed for this change. The same retained Obsidian 1.14.4 source establishes these contracts (zero-based decoded character offsets):

- `app.js` 177300–178350: marker/type normalization, metadata, optional `+`/`-`, recursive quote body.
- `app.js` 767384–769300: typed callout attributes, distinct icon/title/content, capitalized default title.
- `app.js` 2029500–2031000: `-` starts collapsed, `+` starts expanded; primary fold-button clicks toggle immediately, title clicks defer and respect prevented events. Folding changes local presentation, not Markdown source.
- `app.css` 351951–356100: built-in icon/color families, rounded panel, title/fold/content arrangement and nested spacing. Light/dark palette values come from 97795–97949 and 99977–100131.

`src/ui/callout-presentation.ts` consolidates the already-audited original Live implementation. It creates structure and local fold behavior, returning title/content owners to the caller, and registers explicit disposal for delayed clicks and listeners. It has no Markdown/lifecycle dependency, so `destroyMarkdown` can compose its disposal with code and math cleanup without a module cycle. Live retains its existing fold map across unchanged-source remounts, source-edit action, pointer ownership and measurements. Reading uses the marker's initial fold state on a new render.

`src/ui/callout.css` supplies the common palette, spacing, typography, icons and fold layout. The existing globally imported `live-callouts.css` imports that stylesheet and retains only Live wrapper/Edit-block positioning. No entry-point or workspace change is needed. Ordinary Reading blockquotes remain ordinary blockquotes.

Reading's existing recursive quote parsing is preserved. The title line is removed once and its original source-line increment is retained; the recursive body callback now receives the dedicated content owner. Nested callout/list tasks, display math and fenced code keep their existing source mapping and asynchronous renderer ownership. Callout titles now use safe inline Markdown rather than plain text, including existing link and math routing. Failure cleanup disposes the attached partial callout and pending title/body renderers.

## Verification boundary

The focused serial command runs `tests/reading-callouts.test.ts`, `tests/live-callouts.test.ts`, `tests/markdown-blocks.test.ts` and `tests/markdown-lists.test.ts`: 51 tests pass. New Reading coverage checks typed structure and icons, formatted/escaped titles, metadata and default title, fold controls/link ownership/prevented events, delayed-fold cancellation, stale controls, nested task line offsets, code/math ownership and cleanup after partial title failure. Existing Live tests continue to cover fold retention, source actions and deferred resource cleanup. The former lowercase Reading default-title expectation is updated to the source-backed capitalized form.

These are DOM/state/lifecycle results, not pixel, native pointer, mobile or assistive-technology parity. Root retains native comparison after integration. Existing documented limitations remain for custom/plugin icon/color providers and the quote family's original Lucide approximation.
