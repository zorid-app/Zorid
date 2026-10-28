# Notion database interactions: reference and implementation evidence

User direction, 2026-10-27: closely match Notion's database interaction feel for
Zorid's supported features, including creation, layouts, property editing,
settings, keyboard navigation and focus after saves. This extends the
[first presentation pass](notion-database-ux-20261027.md). It does not establish
complete Notion feature, visual or behavioral parity.

Root owns `codex/notion-interaction-match`, based on `e4c8a6d0`, and the
acknowledged temporary integration lane. Named workers used isolated worktrees;
root composes and verifies the changes. This source/reference report covers the
candidate through `8329c2a9`. Native results, final tests, integration and install
receipts are recorded separately by root below when available.

## Reference observations

Root experimented in a disposable page in the signed-in Notion web app using
tab-scoped CUA. The following transitions were observed directly; screenshots
capture resulting states, rather than proving every transition by themselves.

| Surface | Observed interaction or presentation | Reference capture |
| --- | --- | --- |
| Database creation | `/database` followed by Enter inserts a database shell and source chooser. | Tab experiment; no standalone screenshot claimed. |
| Add property | Opens a focused property-name/type picker. | [Property picker](assets/notion-interactions-20261027/notion-add-property.png) |
| Table title | New page starts an inline title editor; a single click edits an existing title. Tab closes the title editor and selects the adjacent cell. Hover Open is a separate action. | [Title editing](assets/notion-interactions-20261027/notion-table-edit.png) |
| Text and choices | Inspected text-editor and Status-picker states, including keyboard interaction. | [Text editor](assets/notion-interactions-20261027/notion-text-enter.png), [Status picker](assets/notion-interactions-20261027/notion-status-keyboard.png) |
| View settings | Compact panel at the right of the database, with controls grouped by purpose. | [View settings](assets/notion-interactions-20261027/notion-view-settings.png) |
| List | Quiet compact rows, page icon and title at the left, inline properties at the right, and a New page row below. | [List](assets/notion-interactions-20261027/notion-list.png) |
| Board | Compact cards beneath named columns, restrained property presentation and creation actions. | [Board](assets/notion-interactions-20261027/notion-board.png) |

The original captures and experiment artifacts are under
`/private/tmp/zorid-notion-interactions-20261027`; the delivery owner retains
selected readable screenshots in `assets/notion-interactions-20261027` beside this report. List and
Board screenshots establish visible layout states. They do not independently
establish all keyboard, drag or persistence behavior. Other details below are
Zorid source behavior or deliberate implementation choices unless identified as
direct observations above.

## REA provenance and limits

The user explicitly requested REA. Root inspected the public, page-observed asset
`TableHeaderPropertyCreationMenu-d9dadff0adfcd8b0.js`, retained only in the temporary
`reference-assets` directory. Artifact identity:

- Size: **55,304 bytes**.
- Chunk SHA-256: `84af4f3fc7cad60ae4b70245666bd9e783c4816b150e4d538491e70ff6d511b9`.
- REA input-directory digest (`reference-assets`):
  `ac76d483c83de39ae1cc783c3d7ba680debc933ff32018f9cd359fa6984255b7`.
- `analyze_javascript_application`: **51 modules, zero parse failures**; the
  bounded semantic graph is partial.
- Parent evidence:
  `ev_f77ec172ac12e704c59071c11b3a3a9e4ae35e5f5ce10b10640ce7addb31ba99`.
- Retained report: `/private/tmp/zorid-notion-interactions-20261027/rea-property-menu-evidence.json`.

This is static evidence about one public asset, not observed execution or proof
of Notion's complete database behavior. The signed-in Notion browser supplied no
available CDP endpoint, and no native Notion application was available. An
app-wide Chrome observation was automatically rejected because it could expose
unrelated private context; root did not retry broad capture. Tab-scoped CUA
experiments succeeded before the browser connection disconnected. No REA runtime
capture of Notion or runtime equivalence is claimed.

Zorid's implementation is independently written against its existing renderer,
Rust-owned data contracts and save lifecycle. No recovered Notion JavaScript,
bundle or other proprietary implementation was copied into project source. The
temporary artifact is evidence, not a dependency or redistributed source.

## Implemented interaction patterns

| Supported behavior | Zorid implementation and boundary |
| --- | --- |
| Slash creation | `src/editor/database-slash.ts` and workspace wiring route the supported database commands through keyboard/pointer selection and guarded creation. Empty database authoring uses the source chooser rather than an inert shell. |
| Database toolbar and settings | `src/bases/toolbar.ts` and `session.ts` keep saved views and primary New prominent. Compact settings expose supported layout, properties, filter, sort and grouping actions. View creation retains explicit completion and inherited source guards. |
| Table editing and Open | `src/bases/table-view.ts` distinguishes inline title editing from Open. Enter/Tab/Shift+Tab return to the intended cell after an accepted save; direct typing starts supported editors, and checkbox Space uses its guarded write path. New page publishes a saved row before admitting inline title editing. |
| Save handoff | `table-view.ts`, `property-widgets.ts` and `session.ts` preserve the user's next-cell action across asynchronous acceptance. Failed or canceled edits do not replay queued navigation. Checkbox handoff retains the checkbox action. Saved identity, configuration, focus and lifecycle guards remain required. |
| Shared property pickers | `src/bases/property-widgets.ts` provides choice navigation, explicit clearing, focus continuity and refreshed option-ID selection. Date/Date-time handling preserves exact accepted literals when native inputs would normalize them. |
| Property authoring | `src/databases/collection-ui.ts` offers a focused name/type picker and existing-property editor. The local schema supports Text, Number, Select, Multi-select, Status, Date, Checkbox and Date-time. Unsupported Notion features are not exposed as inert commands. |
| Choice creation | `src/databases/collection-option-creation.ts` captures an immutable revision-bound command and operation ID, preserves existing property/option IDs and defaults, verifies the reply and retains uncertain retries. Grid selection requires a fresh same-value acknowledgement; managed page hooks retain their original property/value owner. These frontend paths do not establish successful native core execution. |
| List and Board | `src/bases/list-view.ts/.css` and `kanban-view.ts/.css` adapt compact rows/cards, restrained labels and creation actions. List preserves explicit marker/separator/nested configuration and measured virtualization; keyboard row navigation excludes active child editors. Board's Status default applies only when grouping is absent, preserving explicit grouping. |
| Page peek | `src/ui/base-new-item-popover.ts/.css` and `workspace.ts` open records in a guarded side peek. Managed property creation owns its child picker, portal, pending/flush/close lifecycle and cleanup. Ordinary notes continue to hide database Properties. Empty managed page values have a usable pointer target and a quiet Empty hint scoped to Properties rows. |
| Command hints | `src/bases/tooltips.ts/.css` supplies themed hover and keyboard-focus hints for supported commands, including shortcuts where available. Hints do not intercept pointers and are dismissed on lifecycle changes, scroll or Escape. |

These are adaptations of the observed interaction patterns, not claims that every
listed Zorid behavior was observed in Notion. Existing clipboard/range selection,
save-conflict handling, file witnesses and durable-storage guards remain Zorid
contracts; reference appearance does not override them.

## Independent review and bounded checks

Independent review initially reproduced two table handoff defects against frozen
`5a1a32fd`: Escape after a failed rename replayed stale Open, and a queued checkbox
click lost its toggle target. Both exact regressions pass against composed
`7ff7bfb5`; the focused New-row/table interaction suites pass **28/28**. A suspected
same-name-view continuation case passed its focused probe and was not reported as
a confirmed defect.

The helper, managed-property hooks and page lifecycle received a separate source
review; **44/44** focused tests passed. Review also caught a broad empty-value CSS
selector: the shared widget adds its classes in every layout, so the initial rule
would have changed List/Board/Card geometry. `8329c2a9` limits the rule to a direct
Properties-row value. These checks are bounded source/DOM evidence, not native
layout or full-suite acceptance.

Final native observations and delivery remain separate. In particular, root has
reported a core option-creation failure involving a null Multi-select value; the
frontend helper review does not close that finding or authorize a success claim.
Root owns the scoped correction and its verification. No exact full parity,
all-datatype native completion, installed-package or mobile acceptance is inferred
from this report.


## Final frontend checkpoint and native limits — 2026-10-28

Composed product candidate `253de0fa` passes **262/262** final focused tests
(`final-focused004.log`) and full TypeScript/native frontend build
(`frontend-build008.log`). The earlier frozen candidate passed322/322; these are
separate bounded selections, not a full-suite claim. Seventeen neighboring UI
fixture failures reproduce against original main `e4c8a6d0` unchanged.

REA `capture_process_scenario` drove the normal Electron app against an owned
scratch vault through loopback CDP mouse/keyboard input and visible DOM reads.
No internal model/IPC injection or unrelated application data was used. Actual
service checks confirmed inline creation/source/save witnesses, row rename,
property authoring, text/number/select/status edits, Tab and click handoff,
page-peek property creation and exact body preservation, compact List/Board and
human-readable Board option labels. Empty page properties measure28px. A confirmed
rejected option can be canceled and the peek closed; uncertain outcomes remain
tied to their exact labels in focused regression tests. Latest native idle60samples
across3s retains picker DOM/query and reports zero Updating samples. Ordinary-note
Properties remain hidden. Test app closed after the pass.

Native acceptance is incomplete. A pre-existing core update bug rewrites null
Multi-select values to[] and requests destructive confirmation on ordinary additive
schema edits. This blocks native multi-option creation and further schema authoring
in that fixture. The independently reviewed [proposed fix](../plans/notion-nullable-multiselect-core-fix.md)
is not applied; the user has been asked for an exception to the frontend-only
build limit. No Rust build or generic destructive-confirm bypass was performed.
Native clipboard shortcut testing also remains incomplete: CDP editing commands did
not exercise Electron clipboard actions; OS keystrokes were denied Accessibility
permission. The range-selection DOM and focused clipboard tests do not establish
native shortcut parity. All-type/native restart/installed acceptance remain open.
Main and the installed app remain at their previously verified version.

Current scratch-vault screenshots (content crop, not delivery/parity receipts):

| Surface | Capture |
| --- | --- |
| Table | [Zorid](assets/notion-interactions-20261027/zorid-table-delivery.png) |
| List | [Zorid](assets/notion-interactions-20261027/zorid-list-delivery.png) |
| Board | [Zorid](assets/notion-interactions-20261027/zorid-board-delivery.png) |
| Settings | [Zorid](assets/notion-interactions-20261027/zorid-settings-delivery.png) |
| Page peek | [Zorid](assets/notion-interactions-20261027/zorid-peek-delivery.png) |

Temporary native receipt IDs/frames and failure plans are retained under
`/private/tmp/zorid-notion-interactions-20261027/native-final-receipts.json`.
