# Editor and Reading rendering integration

The editor factory now installs the original callout, MathJax and Prism extensions
alongside tables, tasks, lists, properties, embeds and folding. Live Edit preserves
Markdown as the document; rendered decorations never serialize back into notes.
Reading uses the same local math engine and code renderer.

Whole callouts own their descendants until source is revealed. The editor orders
the callout field before consumers and supplies its rendered ranges to math,
tables, embeds, lists, tasks, inline decoration and code fences. Ownership changes
are observed even on transactions without document changes. Shared range
normalization is cached per immutable editor state; inline ownership lookups use
binary search. No renderer imports another renderer's state field.

The document-start frontmatter grammar protects metadata from Markdown parsing.
A literal unmatched math or code fence inside YAML cannot consume later body
content. The property panel still decides visibility: invalid/incomplete metadata
remains editable source. Math nodes also exclude the lexical wiki-embed scanner,
including while a formula's source is revealed.

The application imports the three renderer stylesheets and packages official
MathJax 4.1.3 TeX/font assets and Prism 1.30.0 components through webpack. Copy
controls use the existing Lucide icon provider. Recovered reference artifacts are
not shipped.

Lifecycle ownership is explicit. Workspace panes, note embeds, callout roots and
table cells dispose shared Markdown/math rendering before replacement or removal.
Disposed results cannot write into later content. The math queue skips abandoned
pending work while retaining work with live consumers. An already-running engine
conversion may finish. Code highlighting jobs are canceled when their owners
leave the view; their tokens are indexed for visible-range work.

Multiple note selections entering a table temporarily reveal its source, retaining
all ranges and their main index; returning to one selection restores the table
widget. This avoids transferring only one range into a child editor. Exact native
reference appearance for that transition remains unverified.

## Verification boundaries

Focused tests cover real createEditor wiring, mixed callout/code/math/table/task
ownership, source reveal, folding, undo, synthetic composition and selection,
late asynchronous completion, renderer disposal, local engine assets and counted
work across caret moves. Independent probes found and drove fixes for math
wiki-embed leakage, metadata ownership, pending conversions after disposal and
selection loss in table child editors.

This is integration evidence, not desktop/mobile visual or interaction parity.
Native pointer geometry, IME sessions, mathematical font layout, clipboard
permissions, touch selection and mobile keyboards require separate verification.
Math still has grammar gaps: variable-length dollar fences, general container
math fences and multiline inline forms are not implemented. The shared callout
renderer handles its unquoted display math and ordinary fences; list-owned
callouts and full plugin Markdown processors remain outside this change.

The integrated checkpoint `9536994` passed **1,087 / 1,087 tests** with test
concurrency 2, TypeScript `--noEmit`, and a production webpack build. The build
reported three bundle/performance warnings (large PDF.js/MathJax/Prism and main
assets, entrypoint size, and runtime-chunk guidance); there were no compilation
errors. These checks ran serially on the constrained development machine. No
Electron or mobile app was launched by this integration pass.

## Native follow-up

Root launched this reviewed worktree's production build in Electron and created
`Native math and callouts.md` in the existing temporary verification vault.
Native accessibility and screenshot inspection showed inline superscripts,
display fractions/radicals, JavaScript token colors, and a callout containing
inline math, display math and a highlighted code block in Live Edit. No remote
renderer was needed; the packaged engines loaded in the native file-based app.
Submitting the new note title moved focus to the editor before text was pasted.

Switching to Reading rendered the ordinary inline/display math and highlighted
code, but exposed a real gap: the callout's quoted multiline display math remained
literal `$$` text. This is assigned to the Reading block owner and independent
reviewer, and is not counted as verified parity. Exact reference font/spacing,
source-reveal behavior and native IME remain unverified. Further interaction
checks stopped after the app's state changed during use; existing note content
was preserved. The agent-launched Electron process exited zero after save/quit,
and a fresh app inventory confirmed it closed.
