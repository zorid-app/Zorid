# Desktop validation — 2026-10-16

This is a bounded Zorid native smoke test, not an Obsidian parity comparison.
The user explicitly authorized native desktop control of Zorid. The browser's
local-file restriction remains in effect and was not bypassed.

## Runtime and access

The user launched `pnpm run desktop` from their terminal. Selecting Electron via
native desktop tools initially bound to a separate default Electron welcome
window. Closing that window allowed selection of the actual Zorid workspace.
The agent shell still exits with SIGABRT when launching the same entry point;
that shell result does not contradict the manually launched working instance.

Native accessibility inspection and interactions work. Two usable screenshots
were captured in the conversation: the workspace shell and the synthetic
fixture in Live Preview. Later captures returned blank frames despite populated
accessibility state; those frames are not visual validation evidence.

## Exercised scenarios

The isolated fixture is `/private/tmp/zorid-visual-20261016`, containing original
Welcome.md, Embedded note.md, and Pattern.svg. The user's existing note was not
edited by these checks. The native folder picker successfully opened the fixture.

- Opening Welcome.md loaded its properties and actual CodeMirror editor.
- Command-E switched from Live Preview to Reading; accessibility state showed
  headings, inline formatting, tasks, table cells, and the heading embed.
- Clicking the embedded task changed its checkbox state. A separate filesystem
  read confirmed `[x] Embedded task` in Embedded note.md, retaining its following
  section. This verifies native interaction through the embed into vault storage.
- Opening Pattern.svg produced an image view and a byte-count status, with no
  Markdown editing-mode button. Clicking the image opened an Image viewer dialog;
  Escape closed it and restored the workspace. These are accessibility/input
  observations; image pixels and zoom/drag behavior were not confirmed.
- Reloading through Command-R restored the selected fixture vault and note.

## Defects and limitations

The captured Live Preview screenshot showed property controls overflowing their
row and generic CodeMirror underlines on headings. The implementation now uses
shrinkable property columns, compact removal controls, wrapping list values,
and a heading highlight style without underline. Build and relevant tests pass;
a post-fix pixel check remains outstanding because later captures were blank.

The same screenshot confirms that raw YAML appeared below the properties panel,
and tables and embeds remained source text in Live Preview. Those are actual
rendering gaps, not merely missing evidence. The user's subsequent requirement
is two exposed modes, Reading and Live Edit, both rendering the whole document.
Removing the Source mode UI does not close the Live Edit rendering gap.

No paired Obsidian runtime, exact cursor/selection/IME comparison, native mobile
run, full keyboard suite, layout measurement, or performance benchmark was
performed in this smoke test.

## Live Edit follow-up: tables, pointer geometry and properties

The user resumed the goal and reported that clicks below enlarged lines landed
at incorrect positions. Inspection of the installed CM view implementation's
`measureVisibleLineHeights` showed per-line bounding-box measurements. Zorid's
heading margins were outside those measured boxes. Heading spacing now uses
padding; live table widgets likewise keep spacing inside their measured box.
Pointer selection keeps existing inline decorations while the mouse is held,
then refreshes the latest selection after release, following the static
reference lifecycle documented in `editor-reference.md`.

Native checks on the user-launched Zorid instance:

- Reload exposed a rendered Live Edit table with semantic headers and cells.
  Clicking Alpha opened a nested cell editor. Typing ` verified` and pressing
  Tab selected the next cell; Command-Z restored Alpha in the note. Later user
  edits to this fixture were left intact.
- A separate original `Cursor geometry.md` fixture contains alternating heading
  levels and unique plain-text targets. Clicking FourthTarget after several
  enlarged headings and typing a marker yielded FourthCLICKTarget. A second
  click yielded SecondCLICKTarget on the intended earlier line. Both markers
  were undone. This tests native click-to-insertion line targeting through AX
  element clicks, not exhaustive pixel/character accuracy.
- After the final build, the properties panel retained its values while the
  note editor's accessible content excluded the raw YAML. Repeating the last
  click check still inserted into FourthTarget. After undo, Command-Home and
  Backspace left the source intact; a separate file read verified the exact
  fixture YAML prefix and absence of test markers.

Screenshot capture still returned a blank frame, so post-fix visual parity is
unverified. Automated evidence: 192 tests pass, including actual CM nested
editing, parent history, virtual cells, whitespace, table identity, pointer
refresh, and property boundary protection. The production build passes with
three bundle/performance warnings. Capacitor sync succeeds; no native device
build or run is implied. Tables still lack rectangular selections, structural
menus, resizing/reordering, complete inline cell rendering and reference parser
equivalence. Embeds and other rich content remain incomplete in Live Edit.

## Integrated editor checkpoint — 2026-10-16

All 300 automated tests and TypeScript checks pass. Production webpack build
succeeds with three bundle/performance warnings (main bundle approximately
790 KiB). New coverage exercises actual CodeMirror paste event routing, current
selection after asynchronous imports, nested table paste, checkbox click/history,
list key precedence, hidden YAML, embed reuse/release, Reading nested/quoted
custom tasks, link ambiguity and delayed attachment destinations. A downstream
Markdown paste handler was found to wrap multiline labels after our handler
rejected them; the transfer boundary now consumes that case as plain replacement.

These are synthetic DOM/input tests, not OS clipboard or pixel comparisons.
This checkpoint has no additional native UI observations. Canvas document tests
do not establish Canvas UI parity. Reference source audits for search, PDF,
plugins, mobile, themes, workspace shortcuts, Bases queries and performance are
static and retain their individual coverage limitations.

### Native follow-up on the checkpoint

The rebuilt Electron app was reloaded and a new disposable `Editor integration
checkpoint.md` was opened in the fixture vault. Its Live Edit accessibility tree
included interactive checked/unchecked tasks, a rendered note with headings and
its own task, and a rendered SVG image. Clicking the first task checked it;
clicking again restored it. Clicking `FinalTarget` below both embeds and typing
`CLICK` inserted on that line (`FinalTCLICKarget`); undo restored it.

Clicking the nested `child` item, moving to line end and pressing Enter produced
another four-space-indented list marker. A subsequent Enter outdented the empty
item without adding a line. Two undos restored the source. Reading mode exposed
nested list structure and the custom `[?]` checkbox as checked. The note was
returned to Live Edit, and its disk bytes were verified identical to the original
fixture. AX selectText did not reliably move the CM caret, so the list scenario
used an actual element click followed by the native line-end shortcut instead.

Screenshot capture returned a partial frame with a large blank region. Visible
portions showed the task controls and embedded note, but this cannot establish
complete layout or visual parity. No reference runtime or native image-clipboard
comparison was performed.

### Native menus and list-marker checkpoint

Root integration `2c10c8a` passes all 430 tests and the production build (three
bundle/performance warnings). All 232 emitted PDF.js runtime assets were compared
byte-for-byte with the installed official package and match. This packaging check
does not establish PDF viewer integration or reference parity.

After saving all note buffers, Zorid was fully restarted to load the new main
process IPC. Native right-click on a rendered table cell displayed an actual
macOS menu with Undo/Redo, Cut/Copy/Paste, Paste and Match Style, Select all, and
four row/column insertion commands. Escape dismissed the menu. No insertion was
performed in the user's now-edited fixture during this observation.

The live editor accessibility tree exposes Add row below and Add column to the
right controls. A complete native screenshot confirms task checkboxes without
preceding dashes and indentation guides. Ordinary list markers show circular
bullets, but a small residual hyphen is also visible beneath them; that visual
regression is assigned for repair. Native menu action execution, reference visual
comparison, and split-view integration remain separate outstanding checks.
