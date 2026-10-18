# Reading code and display-math integration

This original integration reuses the pinned static reference evidence in
[the Markdown renderer report](markdown-renderer-reference.md) and
[the math report](live-math-reference.md). Retained REA evidence
`ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`
identifies the inspected Obsidian 1.14.4 renderer. Focused readings of `app.js`
Unicode offsets 757420–759520 and 2026860–2028180 confirm separate inline/block
math ownership and asynchronous conversion/recycling by source and display flag.
They do not establish execution or native parity. No recovered implementation or
assets are included.

`renderMarkdown` now indexes whole-document Markdown parser roots to recognize
fenced code and the shared `mathMarkdown` standalone display blocks. It consumes
HTML and indented code as literal blocks so interior syntax cannot create math.
Incomplete display blocks retain literal source. Paragraphs render as complete
parser-owned spans, preserving multiline inline-code precedence. Recursive list,
quote and callout bodies use parser-owned code content, the shared highlighting
and copy control, and original task line coordinates. The standalone list helper
retains its previous quote opt-in contract; the document renderer opts into all
quotes. Reading output uses its destination document, including popouts.

`destroyMarkdown(container)` disposes descendant code observers, outstanding
highlight requests, copy handlers/timers and pending math owners, including the
root where applicable. `renderMarkdown` invokes it before replacing children.
Pane, embed, callout and live-table owners must also call it before detaching or
replacing their containers. Detached construction remains valid; disposal uses
explicit ownership rather than `isConnected`. Host teardown wiring belongs to
integration, and is not established by this module alone.

Focused `tests/markdown-blocks.test.ts` verifies exact fence content/copy,
matching marker lengths, recursive quote/list/callout code gating, HTML and
indented-code gating, closed/incomplete math, stale results after rerender,
observer/copy disposal, owner documents and multiline inline-code precedence.
The existing list tests verify hierarchy, source task offsets and parser reuse.
These jsdom checks do not execute Prism/MathJax, native clipboard or browser
geometry; separate shared-engine tests cover the upstream engines.

Known gaps remain: the shared math grammar accepts single-line inline/display
expressions and exact standalone top-level `$$` fences. Container display
fences, variable-length dollar fences, unclosed math rendering and Reading-only
multiline inline math remain unsupported. The reference supports more forms.
Paragraph source newlines currently use ordinary HTML whitespace unless explicit
Markdown hard breaks are present; the reference's strict-line-break preference
is not implemented here. Quote/callout folding and titles are still the existing
Reading subset; full recursive heading/table/HTML support and plugin processors
are outside this integration. Native layout, mathematical fonts, copy behavior,
mobile behavior and complete Reading/Live equivalence require separate checks.
