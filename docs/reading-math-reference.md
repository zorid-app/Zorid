# Reading math integration

This original integration uses the shared upstream MathJax renderer and Markdown
grammar described in [live-math-reference.md](live-math-reference.md). No recovered
implementation or assets are included. This report covers Reading integration;
it does not establish native appearance or complete reference parity.

## Reference evidence

The REA-restored Obsidian 1.14.4 artifacts were inspected without execution.
Extraction evidence is
`ev_ec268d4710d98bd994642c3a390b963e050880975c210f85226470c9360cd459`;
the shared math report records the prior static-analysis evidence. Recomputed
SHA-256 values match that report: `app.js`
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`
and `app.css`
`866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba`.
Paths are under
`/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`.

Decoded Unicode character offsets 757420–759520 in `app.js` show the Reading
parser producing inline spans with `math math-inline`, display spans with
`math math-block`, and display-block divs. It guards single-dollar delimiters
against adjacent whitespace/digits and handles escaped dollar signs. Offsets
2026860–2028180 show asynchronous processing of pending math and recycling by
TeX source and display mode. These are static observations, not runtime probes.

## Implementation and ownership

`markdown-inline.ts` adds shared math syntax to its existing parser, with the
block math rule removed because headings, list labels, link labels and table
cells must remain inline containers. A math node creates a span in its owning
document. TeX is passed unchanged to `renderReadingMath`. Existing parser
ownership keeps code, escaped delimiters, wiki aliases, comments, link targets
and image alt text from triggering math conversion. Formatting and normal
Markdown link labels can contain math.

`reading-math.ts` tracks render handles by output element using a WeakMap.
`destroyMathRenders(container)` disposes the container itself and its math
descendants. Hosts must invoke it **before** removing or replacing a Reading
section, embedded note, callout or live table cell; a detached node may be a
legitimate construction target, so connection state cannot replace this hook.
The block renderer's `destroyMarkdown` aggregates cleanup; pane and widget
disposal are integration responsibilities. Disposal is idempotent, prevents
late output and callbacks, and cannot invalidate a newer render on the same
element. Already queued engine conversion may finish, as documented by the
shared renderer.

## Verification and remaining gaps

Seventeen serial focused tests passed across `markdown-inline.test.ts` and
`reading-math.test.ts`, covering parser precedence, formatting/link nesting,
heading/list/quote/table contexts, owning-document rendering, async replacement,
subtree/root cleanup and callback suppression. TypeScript and diff checks pass.
The deterministic lifecycle tests inject an engine; real MathJax conversion is
covered by the shared renderer's independent tests. These checks do not replace
root's integrated desktop/mobile verification.

Shared grammar limitations still apply: Reading-only multiline inline math,
runs of three or more dollars, container fences and unclosed display blocks are
not made equivalent by this change. The shipped Reading grammar supports more
forms. Block math and code precedence are owned by the Reading block integration.
Native font metrics, display overflow, section recycling and all host removal
paths require integrated verification before the full user finding can close.
