# Mermaid reference contract

Focused static audit of Obsidian 1.14.4. This document specifies requirements for an original renderer; no reference code was executed, no dependency installed, and no recovered implementation/assets copied into the project. Native rendering, dimensions and interactions remain unverified.

## Evidence identity and bounds

The restored archive is `$HOME/Library/Application Support/obsidian/obsidian-1.14.4.asar`, SHA-256 `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`. REA extraction evidence `ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459` records 368 regular files, verified containment and no integrity contradictions. Nested archives were not recursively extracted. It restores the same source bytes used by earlier partial renderer analysis E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`; no broad reanalysis was repeated.

Current compatibility path: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`, linking to `/var/folders/yc/__symlbx5zxd7v1vhwh84z180000gn/T/rea-extracted-88b35405-bc00-4fc9-96d6-6e81b279c0e2`. `/private/tmp/zorid-reference-restored.json` records the pointer and principal hashes. These temporary paths can expire; identities, rather than paths, bind the evidence.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `app.js` | 3,942,126 | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` |
| `app.css` | 668,223 | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` |
| `lib/mermaid.min.js` | 2,964,042 | `6ef73c979e4636b0724eb3b4ee505e53e3a117e4cae31914ec5b2d64f27ff603` |

Offsets below are zero-based Unicode character offsets in decoded UTF-8: A=`app.js`, C=`app.css`, M=`lib/mermaid.min.js`. A byte-oriented tool will report different offsets. The bounded search covered all Mermaid occurrences in the renderer, selected library implementation ranges and relevant CSS selectors. It is not a complete Mermaid bundle, dependency security or app event-routing audit.

## Version, assets and configuration

The library header identifies the source as Mermaid **11.13.0**, and the internal render path passes the same version string to diagram renderers (M2957320–2958390). The public release exists at [Mermaid 11.13.0](https://github.com/mermaid-js/mermaid/releases/tag/mermaid@11.13.0). The packaged file is **modified**, not a byte-identical npm distribution: its header describes rounding both measured and target HTML-label widths before comparison; the actual rounded comparison is present at M740889. This change affects the branch applying table display, `break-spaces` and fixed label width. An independently acquired upstream package needs a paired fractional-width fixture before assuming equivalent layout.

The archive's Mermaid-named asset inventory contains one self-contained `lib/mermaid.min.js`; the renderer loads that path lazily (A1993960–1994630). No dedicated Mermaid CSS or font asset appears in this inventory. App CSS supplies the font and dark-theme filter. This does not establish that every optional diagram, image, icon pack or external URL is offline-capable. The inspected app wrapper does not register extra Mermaid diagram/layout/icon packs.

The shared loader (A865531) memoizes a pending load, initializes once after successful script loading and clears its pending promise on failure so a later request can retry. Application initialization overrides are:

| Setting | Value from A1993960–1994630 |
| --- | --- |
| `startOnLoad` | false |
| `securityLevel` | strict |
| `themeVariables.fontFamily` | `var(--font-mermaid)` |
| `flowchart.useMaxWidth` | false |
| `sequence.useMaxWidth` | false |
| `gantt.useMaxWidth` | true |
| `gantt.axisFormatter` | date format `%Y-%m-%d`, selected for Mondays using `Date.getDay() === 1` |
| `journey.useMaxWidth` | true |
| `class.useMaxWidth` | true |
| `git.useMaxWidth` | false |
| `state.useMaxWidth` | true |
| `er.useMaxWidth` | false |
| `pie.useMaxWidth` | true |

Other settings retain library defaults unless source directives/frontmatter validly override them. Observed defaults at M106929–107300 include default theme, classic look, dagre layout, maximum source length 50,000 and maximum edges 500. The secure-setting list includes security level, automatic start, source-length/edge limits and error-rendering controls. Oversized source is replaced by the library's error-diagram input at M2956781; the wrapper does not itself reject source length. These defaults are evidence for this exact bundled version, not promises about newer releases.

## Trust, Reading and Live Edit

**Fresh-vault behavior includes a trust guard.** At A2696350–2697470 the app enables rendering only when its local `mermaid-vault-trust` value is exactly boolean true. Otherwise it creates a bordered guard with localized title/description, an Allow button and the source in a `pre > code` block. Allow saves true and emits `post-processor-change`; disabling the corresponding editor setting saves null and emits the same event (A3832880). Exact localized title/description wording was not recovered in these ranges. Do not invent it and call it exact. The wrapper uses the app's local-storage API; persistence across vault switch/restart needs native verification.

Reading mode scans `code.language-mermaid`. The application registration at A3921731 sends trusted blocks to the renderer and replaces untrusted blocks with the guard. An additional publish-oriented postprocessor at A2438811 directly invokes rendering; do not infer the desktop guard policy from that separate registration alone.

Live Edit's specialized code widget at A3031200–3033250 recognizes the exact `mermaid` language along with other registered block processors. It calls the same trust-aware helper, adds an explicit code/edit action and observes its size. Widget estimated height is 50px, a provisional CodeMirror layout estimate rather than the final diagram height.

The decoration builder at A3044911 and A3049300–3050240 replaces a complete fenced block with the widget only when the block does not intersect a focused editor selection or the relevant search-highlight range. Selection overlap is inclusive at both boundaries (A782158–782430); unfocused editor selections are omitted from that test. The replacement spans the fences, while the widget stores the body-only range. Reuse compares exact language and body source. The explicit edit action selects the body on desktop; mobile collapses to its start, focuses the editor and scrolls the selection into view (A1949854–1950934). Exact tap/double-click/drag interaction and blur timing remain native test requirements. The Mermaid widget does not call the generic widget body-click hook in its inspected constructor; do not assume clicking any diagram surface must reveal source.

## Render lifecycle, sizing and errors

The wrapper at A2023300–2025700 performs these operations:

1. Recover cached source, otherwise read text and remove **one** terminal newline. Preserve other whitespace.
2. Derive rendering width from the code block's parent, then the Markdown container, then window inner width if earlier widths are zero.
3. Create a hidden absolutely positioned `.mermaid` measurement host in the body, set its width, and use a fresh `m`-prefixed random identifier.
4. Await `mermaid.render(id, source, host)`. Consume **only its SVG string**; the returned `bindFunctions` is not called by this wrapper.
5. Remove the temporary host; replace the original `pre` with a `.mermaid` SVG container, cache its source, and perform the link/marker repairs described below.
6. On failure, remove the generated `d<id>` error node and measurement host, log the error, and replace the code's text with `Error parsing Mermaid diagram!`, two newlines and `error.str || error.message`. Text is inserted as text, not HTML. The error stays in the source block rather than replacing the whole note.

Blocks render when either the code node or its owning container is shown. Otherwise rendering waits for insertion. Calls for currently visible blocks are collected with `Promise.all`, but the packaged public Mermaid API maintains a serial internal render/parse queue (M2960900–2962600). Do not bypass that queue by invoking internal renderer APIs in parallel. The wrapper recycler matches exact cached source and moves an existing SVG into a new block during Markdown reprocessing (A2025211–2025700). This is DOM reuse, not evidence of an unlimited global SVG cache or a source-only cross-vault cache.

`--font-mermaid` resolves to the text font (C106922). Dark theme applies inversion, 180-degree hue rotation and saturation 1.25 to the diagram SVG, rather than the wrapper setting Mermaid's dark theme (C359050). Live diagram children scroll horizontally (C376900); do not universally scale every diagram down, because `useMaxWidth` intentionally differs by diagram type.

The generic widget ResizeObserver observes border-box changes and calls CodeMirror `requestMeasure`; destroy disconnects it (A1950104). No diagram-specific resize rerender is present in the inspected wrapper: the measured width is captured for that render, while SVG/CSS sizing and CodeMirror measurement handle subsequent changes. Exact font loading, collapsed-pane reveal, nested embeds and cross-window behavior still require observation. In particular the reference uses global document creation in parts of the wrapper; an original owner-document-aware implementation should preserve correct multiwindow ownership rather than reproduce an unverified cross-window bug.

Guard styling at C359220–360640 uses a column wrapper, clipped 1px border and medium radius. Header has a 12px gap, padding 8px vertically/16px horizontally; text rows have 2px gap. Source has a top border, zero-margin/border/radius pre and the ordinary code background. In Live Edit, source-action placement uses CSS anchor positioning when supported, with 36px header end padding as fallback. Exact computed typography, colors and dimensions depend on app variables/theme and must be compared natively.

## Links and security boundary

The packaged strict renderer sanitizes generated SVG through its included DOMPurify branch, preserving selected SVG/foreignObject integration points (M2957320–2958390). The bundle license identifies DOMPurify 3.3.1. Library flowchart/class/gantt callback registration rejects callbacks unless security is loose (examples M868794, M2178367, M2461153), and URL formatting sanitizes URLs outside loose mode (M636203). Strict mode is not evidence that all external images, URLs or SVG links are disabled. Do not execute the reference or malicious payloads to infer more than this static evidence.

After rendering, Obsidian converts a specific generated node-label shape carrying the `internal-link` class into an ordinary internal-link anchor, using the label's text for both href and visible text (A2023686 onward). It also repairs SVG anchor `href.baseVal` from the href attribute when empty. Exact host link opening, modifiers, path resolution and external-navigation policy belong to the Markdown host and require further tracing; the renderer must delegate those actions to existing vault/navigation services.

The wrapper namespaces marker IDs with the per-render ID, updates matching `marker-start`/`marker-end` URL references and rewrites matching ID selectors in the SVG style element. Multiple diagrams must not share marker definitions. This is a scoped marker repair, not evidence of rewriting every possible SVG identifier or URL reference.

The public Mermaid [usage documentation](https://mermaid.js.org/config/usage.html) describes the asynchronous render API and returned SVG/binding contract. For clone parity, use the audited wrapper behavior—do not unconditionally invoke returned binding functions merely because the generic example does. Likewise do not lower strict security or skip the trust guard to make callbacks work.

## Proposed original integration contract

Acquire pinned public `mermaid@11.13.0` under its license, independently of the recovered file. Record the known label-width patch as a parity gap until an original regression fixture establishes the need for an upstream fix or minimal independently authored compatibility change. Bundle/lazy-load official runtime assets locally; no CDN dependency should be needed for ordinary diagrams. Package acquisition and license review remain future implementation work.

A shared service can expose `mountMermaid(host, {source, sourcePath, trust, requestTrust, openLink, onMeasure, ownerDocument}) -> {ready, update(source), destroy()}`. Reading and Live Edit should use the same SVG, guard, error, source normalization and link adapter. Live Edit separately owns fenced-block range mapping/reveal and CodeMirror measurement. Trust belongs to the vault/app settings service, not global Mermaid configuration or a transient per-block boolean.

Recommended lifecycle safeguards are original implementation choices: coalesce lazy engine initialization; retry a failed load; serialize rendering through the public API; schedule only attached/visible blocks; discard stale results after edits/vault changes/destruction; clean every owned measurement/error node in `finally`; detach observers and host listeners; keep bounded reusable DOM or SVG state and release it on owner teardown. Mermaid render has no audited cancellation signal, so cancellation means discarding late work, not pretending the parser stopped. Avoid rebuilding diagrams on every cursor movement or resizing loops driven by their own measurement changes. Do not share mutable SVG nodes across simultaneous views.

## Required verification cases

These are acceptance cases for later implementation, not tests already performed:

1. Fresh vault: valid Mermaid shows source/guard in Reading and Live Edit, and does not load/render engine until allowed. Allow refreshes existing blocks; a second block inherits trust; revoke restores guards. Switch/restart verifies persistence isolation.
2. Configuration capture verifies every override above; a source directive cannot lower strict security or raise protected resource limits. Exercise per-block source directives without leaking configuration into the next block.
3. Render fixtures: flowchart, sequence, gantt with Monday ticks, journey, class, git, state, ER and pie; compare wide/narrow panes and both themes. Add diagrams from the same version's other supported families without claiming all are covered by these nine fixtures.
4. Fractional label widths reproduce the packaged rounding-patch condition; compare upstream and reference geometry before deciding on compatibility changes.
5. Body text with zero/one/two trailing newlines, empty body, CRLF, nested list fence, and closing fence at document end preserves source/ranges. Exact language casing and malformed/unclosed fences are separate parser cases.
6. Focused caret at either fence boundary, selection crossing a fence and multiple selections reveal source. Blurring re-renders according to selection policy. Search-highlight intersection reveals the block. Edit action selects body on desktop and collapses on mobile; undo/redo preserves text and selection.
7. Hidden pane/container insertion delays render until measurable; zero-width fallback uses container then window width. Resize and late font load update CodeMirror layout without incorrect caret geometry or infinite rerender loops.
8. Two identical diagrams and two different diagrams coexist without duplicate marker IDs or cross-diagram arrows. Reprocessing can reuse a matching rendered block without moving another visible pane's DOM.
9. Parse and draw failures display the exact error prefix/message as text, remove temporary/error DOM and leave neighboring notes usable. Failed module load retries. Large source/edge limits match the pinned engine behavior.
10. Internal-link node class, SVG href repair and external SVG anchor variants route through host navigation. Strict callback syntax does not execute arbitrary functions; injected labels do not create executable DOM. Test security in an isolated clone fixture, not by executing proprietary reference code in this audit.
11. Edit/remove a block, close a view or change vault while loading/rendering; late SVG must not attach, acquire stale trust, overwrite newer source or leak temporary nodes/listeners. Concurrent visible diagrams should remain bounded and the UI responsive on the 8 GB target machine.
12. Native Electron and Capacitor checks compare rendered geometry, source-action placement, text selection, mouse/modifier links, touch, clipboard, keyboard reveal, dark filter and scrolling. Unit/jsdom checks alone cannot establish these behaviors.

## Remaining uncertainty

No native reference/clone comparison was performed. Exact localized guard wording, full upstream fork diff, complete diagram-family/assets coverage, browser resource policy, source-provided external images/icon packs, host link modifier behavior, all search/reveal edge cases, reuse across windows, font timing and memory/performance under huge diagrams remain unresolved. The proposed API and lifecycle guards are implementation recommendations; the measured configuration, source ranges and identities above are static evidence.
