# Embed source reveal and retained rendering

The user's required behavior is that clicking an embed's `</>` control exposes editable Markdown **and keeps the rendered content visible**. This follow-up corrects Zorid's previous implementation, which removed and destroyed the widget while its syntax was revealed. It does not change table editing or the editor's general inline syntax engine.

## Reference evidence

This is a focused static reading of the retained Obsidian 1.14.4 files under `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/`, reusing partial REA application evidence E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37`. No reference application execution or proprietary source copying occurred.

| Artifact | SHA-256 |
| --- | --- |
| `app.js` | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` |
| `app.css` | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` |

Both hashes were rechecked. Locations below are zero-based Unicode character offsets in UTF-8-decoded files, not byte ranges or new REA AST assertions. See [editor reference](editor-reference.md) for the surrounding partial audit.

| Question | Static observation | Location and boundary |
| --- | --- | --- |
| Ordinary edit control | Base widget adds a code-icon action that selects its tracked source bounds and focuses the editor. Mobile collapses the selection to the beginning; desktop uses both endpoints. | JS 1949277–1951650. A selection operation alone does not specify decoration behavior. |
| Ordinary block reveal | The block factory's embed decoration helper checks focused selection/search overlap. For a non-image whole-line embed, overlap uses a block point-widget at the line end, leaving source intact; otherwise it replaces the line with the widget. | JS 3045544–3046600. Source and rendered child coexist in the overlap branch. |
| Inline reveal | The same helper uses a point-widget after the embed syntax for overlapping non-image inline content; its other branch replaces the syntax. | JS 3045544–3046600. Placement is separate from the image branch. |
| Child type and ownership | Internal embeds resolve/load a type-specific child and register it under the editor. Different child types receive a base edit button, image controls, or a generic click handler. Reconciliation retains compatible typed widgets and removes stale children. | JS 3029573–3031850 and 3044479–3054001. This does not establish every child/plugin type or reachable interaction. |
| Image edit differs | Image controls select the image object and request URL-segment editing. The controller computes URL/alias source bounds, requests reserved layout height and focuses the source segment. | JS 3027400–3028000, 1715171–1716500. This is more specialized than selecting an entire embed. |
| Image remains represented | The reveal branch uses layout spacers and a separate image tooltip, with size updates, position calculations and cleanup. Tooltip CSS shares image wrapper/sizing rules. | JS 3038500–3039500 and 3051200–3053800; CSS around 371092–371700. Exact tooltip geometry and runtime visual fidelity are not measured. |
| Cleanup/measurement | Widgets observe resizing and request CodeMirror measurement; destruction disconnects observers. | JS 1949277–1951650. Real window/IME/layout timing remains untested. |

The reference therefore supports keeping ordinary rendered embeds alongside exposed source. Its image tooltip and selected-image keyboard model are a distinct mechanism. Zorid's shared image behavior below fulfills the user's keep-rendered requirement; it does not claim to reproduce that specialized tooltip, URL-only selection, reserved-height calculation or mobile selection behavior.

## Original implementation

[src/editor/live-embeds.ts](../../src/editor/live-embeds.ts) now emits a point-widget at the source range's end when an embed is explicitly revealed. Whole-line embeds use a block point-widget after the source line; inline embeds use an inline point-widget after their source syntax. Hidden embeds continue using replacement decorations.

The existing identity and equality checks are retained. CodeMirror can reuse the same DOM when a matching widget moves between a replacement and a point decoration. Revealing and rehiding unchanged source therefore preserve the renderer instance, nested view state, attachment lease and resize observer; they do not reload the note, image, PDF or Canvas merely because source becomes editable. Moving the source through unrelated edits retains mapped identity. Editing a target causes the existing renderer contract to replace that target's renderer and release the old one once. Deleting or invalidating syntax removes its widget; leaving the surviving source span restores replacement rendering.

The source action still selects its tracked syntax. DOM/source position round trips are checked inside the exposed text, and the point-widget is noneditable. No absolute positioning, duplicate editor, copied source text overlay or fixed-height placeholder is introduced. Embedded links, image lightbox handlers, native controls and nested editor regions retain their own pointer handling.

`LiveInlineComment` is included in the parser exclusion set alongside code, HTML comments, tables and link-owned regions. Complete `%%...%%` comment nodes from the new inline grammar must not acquire nested embed widgets.

## Verification and remaining work

The focused embed suite has 21 passing tests. Coverage includes mapped source selection; retained DOM and renderer lifetime for note, image, Markdown image, PDF and Canvas syntax; inline source-before-widget placement; DOM/source caret round trips; target edits and rehide; duplicate ownership; undo, deletion and teardown; resize cleanup and interactive descendants. TypeScript and whitespace checks pass.

A separate temporary integration probe at `/private/tmp/zorid-embed-source-inline-probe.test.ts` runs those cases with the actual sibling `liveInlineMarkdown` grammar and adds `%% ![[note]] ![image](../image.png) %%`. All 22 cases pass. That probe uses development worktree paths and is not part of project source; a durable combined-grammar regression should be retained when that grammar is integrated.

The tests use real CodeMirror fields/widgets with jsdom, whose geometry is stubbed. They establish source mapping and DOM/lifetime behavior, not pixel caret placement, native pointer hit testing, image tooltip parity, IME composition, PDF page retention or Canvas pan retention in an actual renderer. Native verification should click `</>`, type within the exposed syntax, move the caret out, and confirm the rendered child stays visible and unchanged source does not reset child state. Complete reference/runtime parity remains open.
