# Bases pass reference observations — 2026-10-21

Owner: `bases_docs_model`; evidence-only work in `codex/types-bases-model` at
`.worktrees/types-bases-model`. Follow the [implementation goal](../plans/bases-implementation-goal.md)
for current requirements. This record reports Obsidian reference behavior; it
makes no claim that Zorid implements or passes these scenarios.

## Target, isolation and methods

Target: installed Obsidian application 1.14.4, cached archive
`/Users/ctk/Library/Application Support/obsidian/obsidian-1.14.4.asar`.
Archive SHA-256: `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`;
`app.js`: `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
The actual packaged launcher is 1.7.4 / Electron 31.6.0 / Chrome 126.0.6478.234;
its owned profile log and window title confirm it loaded the cached 1.14.4 app.
The older launcher version does not mean the Bases code under observation is 1.7.4.

An independent instance was launched with `--user-data-dir` under
`/private/tmp/zorid-obsidian-reference-20261021/profile` and loopback debugger port
9237. Its only registered vault is agent-created `ReferenceVault` in that same
private directory. It contains synthetic Alpha/Beta/Gamma notes, a Base with four
views and a synthetic template. The user's existing Notes instance and real vaults
were not edited, relaunched or debugged. Read-only CUA selection identified the
existing Notes window; no UI action was sent to that window.

The first toolbar/settings captures used default macOS native menus. Subsequent
DOM-menu captures use Obsidian's supported `nativeMenus: false` setting in the
**disposable vault only**. A native menu blocked renderer input once; only the
identified owned process was terminated and relaunched to apply that setting.
Native menu appearance is therefore not established by the DOM-menu screenshots.

REA evidence:

- `ev_c9e4d76036d7f72c85f240fcfcb225dfe2ee994cf79dd991119eaf114c114013`:
  packaged Electron fuse inspection. Node Inspector CLI flags are disabled;
  Chromium remote debugging was separately observed working.
- `ev_734d65de9bcf31816cd1f9176a6b05242657a9d184ad920b6e925e0a97b6ae87`:
  owned endpoint discovery. REA's Electron file-page provider excludes the actual
  `app://obsidian.md/index.html` renderer, reporting zero file targets and one
  unsupported URL. This is a provider scope limitation, not missing application UI.
- `ev_3dbd7c91c01c3ee4ff5cb18db024eb08dea2724069f26d151ecec274d050f73e`:
  focused inert JavaScript analysis of exact summary registry, numeric extraction
  and standard-deviation slices. Three parsed files, 263 visited AST nodes, zero
  parse failures. Slice ranges/hashes are in the private `summary-provenance.json`.
  External functions and dynamic/control-flow relationships remain unresolved;
  the graph does not prove execution. An initial request named an absent slice
  and was rejected before analysis; the corrected request selected existing files.

Actual screenshots, DOM/input snapshots, geometry and trusted pointer/key actions
were captured through a direct CDP client connected **only** to the owned endpoint
and exact ReferenceVault target. These are actual runtime observations, separately
identified from REA's static/fuse/discovery evidence; they are not REA screenshot
receipts. Capture helpers and raw private artifacts remain outside project source.

Artifact directory: `/private/tmp/zorid-obsidian-reference-20261021`.
`capture-catalog.json` records every screenshot path, SHA-256, pixel dimensions
and available CSS viewport/device scale. Each screenshot has a same-name JSON
snapshot. Later captures use a 1024×800 CSS viewport at device scale 2; inspect the
catalog for the earlier captures' exact dimensions. No recovered proprietary
implementation or app assets were copied into the repository.

## Confirmed toolbar and layout observations

| Capture basename (`.png` and `.json`) | Observation |
| --- | --- |
| `baseline` | Table over three synthetic note files. Toolbar order: view selector, result count, Sort, Group, Filter, Properties, Search, New. |
| `view-menu` | Searchable view list, view icon/name and right chevron, then Add view. Menu is 220 CSS px wide. |
| `table-view-settings` | Configure view: editable view name, Layout, Row height. Choices Short, Medium, Tall, Extra tall; saved values empty/default, `medium`, `tall`, `extra`. |
| `view-actions-dom`, `nondefault-view-actions` | Ellipsis actions are **Default view**, **Duplicate view**, **Delete view**. Default has a checkmark for the first view; Delete is warning styled. Labels are not “Set as default” or “Calculate.” |
| `results-menu` | Limit number of results; numeric input placeholder “e.g. 10”; Show all; Copy to clipboard; Export CSV... Menu width 220 CSS px. |
| `filter-menu` | All views / This view tabs, condition counts, nested conjunction choices and Add filter / Add filter group. This fixture's popup is 520 CSS px wide. |
| `properties-menu` | Search placeholder Find or create...; checked visible fields first, remaining fields, Add formula and Hide all. Width 220 CSS px. |
| `sort-menu`, `group-menu` | Sort by / Group by, property and direction controls; Add sort in Sort. A → Z is the observed initial label in this fixture. |
| `cards-view-settings`, `cards-layout` | Card size default 200; Image property; Image fit Cover/Contain; Image aspect ratio 1.00. |
| `list-view-settings`, `list-layout` | Markers Bullet/Number/None; Indent properties; Property separator default `, `. Empty final values do not leave a visible trailing separator in the observed list. |
| `kanban-view-settings`, `kanban-layout` | Column width default 280; Image property; Cover/Contain; Image aspect ratio default 0.50. Group headings have counts and New controls. |

Observed menu style in the owned dark fixture: 15px font, 19.5px line height,
1px border RGB(63,63,63), background RGB(40,40,40), outer menu padding 0.
Exact position/size, control values and captured DOM are in each JSON. These
metrics depend on the recorded viewport, theme and native-menu setting.

## Confirmed view-management logic

- From Table active, configuring nonactive Cards and choosing Default view moves
  Cards to the first slot in persisted `views`; Table remains the active display.
  See `cards-set-default` and `view-menu-after-default`.
- Renaming Cards to Gallery through its name field and blurring commits the
  rename and selects Gallery. There is no Apply button. Config writes are
  debounced: an immediate disk read can still show the previous name. The later
  persisted Base contains Gallery. See `view-rename-committed`.
- Escape from Configure view returns to the view list; it is not a universal
  close-menu command. Clicking known empty workspace space closes the popup.
- Duplicating nonactive Board opens settings for **Board 2**, retains active Board
  and clones the view's configuration. Deleting that just-created nonactive
  duplicate removes it immediately, returns to the view list, and retains Board;
  no confirmation was shown for this case. See `view-duplicate-action` and
  `view-delete-action`. Active-view deletion with other views present remains untested; the single-view
  failure below was checked in a separate fixture.
- Dragging Board's icon from last to first changes the visible order to
  Board/Gallery/Table/List. The later saved Base reflects the new order. See
  `view-reorder-drag`. This is actual pointer-drag evidence, not static registration.

## Confirmed grouping and summaries

Selecting Manual from automatic A → Z grouping initially saves an empty
`groupOrder`, hides all columns and reports zero results. The menu then lists
unchecked group values and offers Add group / Show all. Show all restores the
three observed groups, saves their explicit order and changes its label to Hide
all. See `group-order-choices`, `group-manual-controls`, `group-show-all`.
The Add group editor was opened and text entry attempted, but a new empty group
was not established in the saved Base; that attempt is not acceptance evidence.

The numeric cost header's actual right-click menu is Hide column; Summarize...;
Group by this property; Sort A → Z; Sort Z → A; Edit property...; Property type.
See `cost-header-menu`. Clicking Summarize... opens a separate searchable picker,
not a hover submenu. For cost values **10, 20, null**, previews were:

| Summary | Observed preview |
| --- | --- |
| Average | 10 |
| Empty / Filled | 1 / 2 |
| Max / Median / Min | 20 / 15 / 10 |
| Range / Stddev / Sum | 10 / 5 / 30 |
| Unique | 3 |

`summary-picker` shows the alphabetically ordered choices and Add summary.
Selecting Sum adds a bottom summary row and persists `summaries: { cost: Sum }`
inside that view. Its observed result becomes 37 after a fourth note with cost 7
is created. See `summary-sum-selected` and `numeric-cell-menu`.
The numeric Average=10 observation confirms the full three-element list is its
denominator; it must not be substituted with the mean of only nonnull values.

Focused source reading corroborates built-in formula registrations: Average and
Sum round to two decimals; Stddev also rounds to two; Empty/Filled inspect null;
Unique includes the null in this fixture. Constructor inheritance exposes common
summaries alongside the value-type-specific choices. These are analyst readings
of the exact hashed artifact, bounded by the focused REA record above; mixed/error
and all-null summary behavior still needs its own explicit runtime scenarios.

## Confirmed New and approved Zorid exception

The template fixture contains frontmatter `status: Planned`, `cost: 7`, literal
`{{date}}`, then a heading, body text, `{{title}}` and a Markdown checkbox.
Configured folder is Items and template is Templates/Full.md.

Clicking toolbar New immediately creates `Items/Untitled.md`, adds its row and
opens a rich editor popover (452×217.195 CSS px in this fixture) with the title
focused. Saved Obsidian content is only the template's frontmatter, with the date
placeholder literal; the body is omitted. See `new-item-template-popover` and the
private template/new-note files. Zorid's approved exception is to copy **all** of
the template text, frontmatter and body, literally. This is a required difference,
not permission to expand placeholders or overwrite copied fields with inferred
filter defaults.

## Remaining reference scenarios

Native OS clipboard acceptance, bulk clear and undo; active-view deletion with
other views present;
empty-group creation; direct column resize/reset/auto-size; advanced filter edits;
summary scope with limits/groups/errors; full image behavior and modifier opening;
sidebar `this` context; and light-theme/focus/accessibility comparisons remain
unverified here. Right-clicking a native number input invoked a macOS native
input menu outside the DOM screenshot, so `numeric-cell-menu` does **not** prove
a table cell-menu implementation. Reference observations do not establish Zorid
runtime, mobile, visual or complete language parity.

## Parallel workers' focused static evidence

The following receipts were reported by the named implementation owners. Their
provenance files retain the exact private slices; these are static parsing/source
readings, separate from the actual UI scenarios above.

| Owner / retained REA parent | Scope and limitations |
| --- | --- |
| Toolbar / `ev_e6cc0ab065a85e808766e73a7f96285f7d4abbef53b8b68a61a28f0129372a21` | Three focused files, 11,629 AST nodes, zero parse failures; semantic nodes capped at 800/250 and external identifiers unresolved. Private `/private/tmp/zorid-bases-toolbar-rea/provenance.json` records original hashes, UTF-16 ranges and added declaration/terminator syntax. Menus range 2361499–2371462; results/views 2513346–2534234; properties 2479339–2489226. No runtime proof from this analysis. |
| Controller history / `ev_cea0c25825fb7b96231f013e6e4480c1f8ebbcc48151326453280ff9437ef796` | Three exact inert command-history slices, 1,773 bytes, 577 AST nodes, zero parse failures. Private `/private/tmp/zorid-obsidian-bases-command-history-20261021/provenance.json`; character ranges 2494323–2494793, 2496361–2497013, 2497014–2497665. Analyst reading: ephemeral/frontmatter snapshots; history only for JSON changes; new command clears redo; undo/redo compare whole-frontmatter JSON and assign saved snapshots. Actual history UI scenarios remain unverified here. |
| Controller New / `ev_89d3b9d19480b7cb18748668f3e2b24e63c2a85fd8a379b7f9dab9bbead5d73d` | Owner-reported focused New source analysis; the actual template fixture observation above is the runtime corroboration for the frontmatter-only template branch. Do not infer the rest of New's error/folder/default behavior from that one scenario. |
| Fenced embeds / `ev_821369cb9b1fbf9f65451ad9740e6cdd124706e32714ec4e5716cf91c8e5122b` | Owner-reported exact 385-byte processor slice, one parsed file, 125 AST nodes, zero parse failures; private `/private/tmp/zorid-bases-embeds-ref`. UTF-16 range 3231191–3231575. Source reading: containing source file passed to config controller; child render controller; save callback uses a 100ms debounced exact-block replacement. Nested/dirty editor runtime acceptance is separate. |

The command owner proposes a deliberate integrity improvement: undo only touched
properties, remove newly added keys correctly and preserve unrelated edits rather
than replay the reference's whole-frontmatter assignment. That proposal must be
recorded as a bounded deviation and verified with intervening-edit scenarios; it
is not proof of exact Obsidian undo parity.

Owned reference process cleanup: PID 53149 was selected by its exact disposable
profile argument and terminated after this pass. SIGTERM closed its debugger endpoint but left the owned main process alive;
SIGKILL was then applied only to that exact verified PID. The final process
check found no matching owned main process, and the debugger endpoint was closed.
`owned-process-close.json` retains that check outside source. The disposable
profile, fixtures and evidence remain available for a later owned pass.


## Single-view deletion and New focus follow-up

A second owned pass opened `Single.base` with exactly one table view named Solo.
The Delete view action was enabled and warning styled. Clicking it left the popup
and old table visible and left the saved Base unchanged. Captured
`Runtime.exceptionThrown` reports **TypeError: Cannot read properties of undefined
(reading 'name')** at `app://obsidian.md/app.js:1:2534197`. Repeating the action
produced the same error. `single-view-actions`, `single-view-deleted` and
`single-view-delete-exception` retain the screenshots, DOM and exact exceptions.
This is a reference failure, not an intentional disabled action or fallback.

Focused analyst source reading around decoded app.js characters 2533839–2534090
corroborates the order: remove the view, dereference the remaining selection's
name, then save. The no-remaining-view path fails before persistence. Reloading
the owned renderer restores Solo from the unchanged saved file. Zorid should
record any last-view guard/fallback as a deliberate integrity deviation rather
than reproduce the reference exception or silently call it parity.

After reload, clicking New created collision-safe `Items/Untitled 1.md` and
retained the parent Solo table. `new-title-focused` and
`new-title-focus-retained` record `document.activeElement` as `DIV.inline-title`
with text Untitled 1 immediately after creation and after one second unchanged.
The rich editor popover is 452 CSS px wide; with its properties collapsed it is
134px high, compared with 217.195px in the earlier expanded-properties capture.
Its height is content-dependent. The created file already exists while the
popover title owns focus. Neither capture establishes Zorid's implementation.

Additional summary-owner static receipt:
`ev_63e1921ebd5e2fdae8c05ab9c8e716c8ca3f8c1d8e7bac2f5e580e3fc513ab4f`;
private `/private/tmp/zorid-bases-summaries-reference/provenance.json` and exported
`/private/tmp/zorid-bases-summaries-rea-bundle.json`. Owner reports focused
registry/context/summary/numeric/date slices, zero parse failures and a partial
semantic graph capped at 1,000/300 nodes. This supplements the runtime summary
previews above; it does not expand their runtime coverage.

Follow-up pass cleanup: Browser.close was sent only to the exact owned Single /
ReferenceVault debugger target. The final process check found no matching owned
main process and the debugger endpoint was closed. The private
`followup-process-close.json` records the result. The final catalog contains 44
screenshot/JSON pairs, including the single-view failure and retained-New-focus
follow-up.


## Controlled clipboard-handler logic follow-up

The table owner requested a narrow runtime check of an ambiguous paste loop. A
third independent owned pass used `Paste.base` over only RowA/RowB in PasteCases.
Columns were left, right, amount, tags, file.name. Each case reset both synthetic
notes and reloaded the owned renderer. Keyboard navigation selected the active
cell while the grid container owned focus. An explicit `ClipboardEvent` with an
in-memory `DataTransfer` was dispatched to the actual shipped table. The real
handler ran and normal Obsidian file-manager writes were read from disk. This
is controlled runtime-event evidence, **not trusted OS clipboard/paste acceptance**;
the user's system clipboard was never read or changed.

`controlled-paste-probes.json` contains every payload, pre/post copy result,
preventDefault outcome, saved YAML and file inventory. `paste-<case>.png/.json`
provide scenario-specific evidence. All seven cases preserved the note body and
unrelated fields.

| Case | Observed saved result |
| --- | --- |
| `tsv-start0`: L0/R0 at column 0 | left=L0 and right=L0. |
| `tsv-start1`: L1/R1 at column 1 | right=R1 and amount=R1. |
| `raw-start0`: raw-L / numeric 23, both Obsidian custom formats, at column 0 | left=raw-L and right=raw-L. |
| `raw-start1`: same raw payload at column 1 | right=23 and amount=23, both YAML numbers. |
| `scalar-number`: plain text 123 at amount | YAML `amount: "123"`; raw copy DTO confirms a string. No numeric coercion occurs in this grid-paste branch. |
| `scalar-list`: plain new-item at tags=[old] | tags becomes [old, new-item]; scalar text appends to the existing array. |
| `overflow-row-column`: two TSV rows/four columns at last row, column 2 | Only existing RowB changes: amount=C and tags=C. RowA and the two-file inventory are unchanged; extra rows/columns are clipped and the readonly filename column is skipped. |

The repeated-value behavior confirms a shipped reference defect: the paste loop
reads the clipboard column using the absolute destination selection start,
constant across the destination columns, instead of the relative clipboard
column. This is not an intended transpose or repeated-fill interpretation.
Correct per-column mapping in Zorid should be recorded as an integrity deviation,
not hidden under an exact logic-parity claim. The scalar-string and array-append
behaviors are separately observed reference semantics, not part of that defect.

The actual copy handler populates four formats: text/plain (TSV without a
header), text/markdown (a table with headers/alignment), obsidian/table (JSON
header/rows/alignment), and obsidian/bases-cells (raw cell matrices with source
namespace and note values). In the raw cases the copied JSON preserves the
number/string distinction. System pasteboard integration remains a separate gate.

The paste-probe pass was closed through its exact owned Paste debugger target.
Final process/endpoint checks confirmed cleanup (`paste-process-close.json`).
After this follow-up the catalog contains **51** screenshot/JSON pairs. No
reference process is left running, and no real user vault or clipboard was changed.



## Deliberate differences from the reference

This ledger separates the direct user-approved template change from deliberate
integrity policies. Obsidian remains the appearance, interaction and logic
reference for the rest of the pass. A row below is not a completed implementation
or parity claim; source review, tests and actual composed UI evidence remain
separate. Rich select/multiselect/status fields, relations/reverse relations and
rollups are agreed additions described in the current implementation goal.

| Difference | Reference evidence | Zorid policy and reason | Acceptance still required |
| --- | --- | --- | --- |
| Full literal template copy | `new-item-template-popover` and saved synthetic Untitled.md: template frontmatter copied, body omitted, placeholders literal. | **Direct user-approved change:** copy complete template text, frontmatter and body, literally. Preserve placeholders and the template source; filter/group defaults must not silently rewrite copied content. | Exact byte/content readback with body/frontmatter/placeholders, conflicting defaults, missing template and uncertain-create recovery through normal New UI. |
| Retain at least one view | `single-view-delete-exception`: enabled last-view Delete throws before saving; the disk Base retains Solo. | Deliberate integrity guard: retain the final view and report/disable its deletion coherently. Preserve source and selection instead of reproducing the reference crash. | Normal menu and command attempts against the sole view leave source unchanged and produce an understandable state; other-view deletion and selected/default/named-embed cases still work. |
| Correct rectangular paste mapping | Seven controlled runtime-event probes confirm that reference paste repeats one absolute clipboard column across multiple destination columns. | Deliberate integrity fix: map each destination column to the corresponding relative clipboard column. Keep reference payload priority, raw value distinctions, read-only handling and bounded destinations where separately verified. | Real UI multi-column paste at offsets zero and one, both custom/raw and TSV formats, clipping/read-only cells, scalar/list behavior, invalid values, failure recovery and undo. The controlled reference events do not establish OS pasteboard integration. |
| Conditional touched-property undo | Controller history REA `ev_cea0c25825fb7b96231f013e6e4480c1f8ebbcc48151326453280ff9437ef796`: whole-frontmatter JSON comparisons and Object.assign snapshots. Runtime reference undo was not exercised here. | Deliberate integrity policy: compare/reverse only properties touched by the command, remove command-added keys on reversal and preserve unrelated later edits. Changed touched values/identities must reject safely rather than overwrite intervening work. | Intervening unrelated/touched edits, added/removed keys, redo invalidation, replaced/renamed files, partial bulk failures and editor undo ownership in the actual app. |
| Resolved-link identity in linksTo | Exact registration at app.js characters 2239625–2239946, REA `ev_c32894444b6eccf2eb01a3512eb76c4c728fdac62d94f989960c81c753467464`: reference resolves the raw link with a vault-root origin, then compares the resulting TFile object. Context-collision runtime behavior remains untested here. | Deliberate shared-core policy: use the link target resolved from one immutable prepared namespace and compare stable entry identities when available. Both models compare target identity; resolving origin/ambiguous short links can differ. This is snapshot identity, not a new persisted foreign-key scheme for ordinary frontmatter links. | Nested-folder duplicate-name/root-origin fixtures, already-resolved links, rename/path reuse, missing targets and retained-snapshot refresh in native Rust, actual WASM and app presentation. Document the contextual resolution difference explicitly. |

The scalar-number paste string result and scalar-array append behavior are
reference observations in their own right. The per-column bug correction does
not authorize silently replacing those separate semantics with guessed coercions.

## Current incomplete UX and evidence gaps

Coordinator-reported implementation gaps, recorded without feature acceptance:

| Gap | Required closure |
| --- | --- |
| Rename from a named-view embed is currently disabled | Complete the reference-rewrite path and its dirty-source/identity/navigation guards before enabling rename there. Standalone rename does not close this gap, and permanent disabling is not an approved reference deviation. Verify file and fenced/nested embeds plus reopen/restart. |
| Live group reorder preview is incomplete | Finish the pointer-drag preview/reconciliation behavior and compare actual reference/Zorid interactions. Saved final group order and Show/Hide all alone do not verify live preview, cancellation or focus preservation. |
| Custom summary rename/delete is under work | Finish normal custom-summary naming/formula-edit/rename/delete controls, source-preserving reference updates and diagnostics. Built-in summary previews or Rust reducer tests alone do not establish that UI. |
| Complete composed runtime acceptance is pending | Run the required actual Electron heavy-user journey with matching reference/Zorid screenshots, durable readback and failure/restart cases. Report native Rust, actual browser/WASM, web and CLI evidence separately. Reference captures, isolated checks and build success do not mark this goal accepted. |

The live checklist remains unchecked until the owning coordinator records exact
reviewed/integrated source, executed scenarios and their limits. This evidence
ledger introduces no new source ownership or authorization to resume deferred
Tasks, Calendar, provider, sync or mobile feature work.
