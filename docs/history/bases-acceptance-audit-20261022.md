# Bases acceptance audit — 2026-10-22

Audit owner: `bases_docs_model`, branch `codex/bases-acceptance-audit`, worktree
`.worktrees/bases-acceptance-audit`, frozen source **`44d9ae46`**. This is a
requirement-by-requirement evidence map for the [implementation goal](../plans/bases-implementation-goal.md),
not feature acceptance. Later coordinator/worker changes and dirty files are
outside this snapshot. No app, build or tests were run for this audit.

IDs below follow each goal section's bullet order; `L1`–`L4` follow its layout
table. `C1`–`C3` identify the extra composed-checkpoint requirements. All rows
remain open for acceptance. Source/test names identify available implementation
and authored checks, **not an assertion those checks passed on this snapshot**.
Where execution is known, its exact limited scope is stated separately.

## Evidence boundary

- **Reference:** [reference ledger](bases-pass-reference-20261021.md), Obsidian
  1.14.4 ASAR SHA-256 `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`;
  `app.js` SHA-256 `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.
  `/private/tmp/zorid-obsidian-reference-20261021/capture-catalog.json` has
  **51 PNG/JSON entries, 48 distinct PNG hashes**. Repeated screenshots can still
  carry distinct focus/exception observations; they are not 51 independent
  completed capabilities. Captures establish reference behavior only.
- **Actual Electron:** retained campaign directories
  `/private/tmp/zorid-bases-heavy-first-20261022-001` through `-004` each have
  `result.json`; all four report **failed**, at earlier source heads. Campaigns
  002–004 have `provenanceVerified: true`. Recorded positive durable checks
  include ordinary Create Base and a view rename preserving comments/unknown
  fields. Those checks do not accept the later frozen source or subsequent
  unexecuted journey steps. Campaign 004 fails at `Applied Filter`; its source
  correction is recorded in the coordinator checkpoint, awaiting rerun.
- **Other runtime:** `/private/tmp/zorid-create-receipts-native-20261021-final.json`
  reports three passing create-receipt storage scenarios; the corresponding
  browser report is `/private/tmp/zorid-create-receipts-browser-20261021-final/report.json`.
  These cover bounded storage recovery, not mounted Bases UI. The current
  [browser harness](../../tests/bases-browser-integration/README.md) and
  [CLI harness](../../tests/bases-cli-integration/README.md) are authored
  scenarios; their presence is not a completed matched-artifact run.
- **Reported checks:** the [coordinator checkpoint](../deferred-product-roadmap.md)
  records a 581/581 composed frontend run, separate overlapping 31-case group
  and transport runs, and earlier native/Rust checks. This audit did not rerun or
  independently reconstruct those results. They are boundary-specific evidence,
  not actual-WASM, final-native, visual or heavy-user acceptance.

Source/test bundles used in the matrix:

| Key | Available source and authored checks |
| --- | --- |
| Q | [Rust query](../../crates/zorid-bases/src/query.rs), [program](../../crates/zorid-bases/src/program.rs), expression/preparation/summaries/property-target modules; `crates/zorid-bases/tests/{query_corpus,rich_query,summaries,property_relations,refresh_hints,preview}.rs`; [shared adapter](../../src/bases/shared-query.ts), `tests/bases-shared-*.test.ts`. |
| D | [Base document](../../src/bases/document.ts), `tests/bases-document.test.ts`; [controller](../../src/bases/controller.ts), `tests/bases-controller*.test.ts`, `bases-draft-preservation.test.ts`, `bases-view-references.test.ts`. |
| T | [Toolbar](../../src/bases/toolbar.ts), toolbar panels/config/groups/formula editor; `tests/bases-toolbar-*.test.ts`. |
| P | [Property definitions](../../src/bases/property-definitions.ts), [widgets](../../src/bases/property-widgets.ts), settings panel/targets; `tests/bases-property-*.test.ts`, `bases-session-relation-targets.test.ts`, `properties-relation-display.test.ts`; [Rust property contract](../../crates/zorid-bases/PROPERTIES.md). |
| N | [Creation](../../src/bases/creation.ts), controller create/recovery commands, [New popover](../../src/ui/base-new-item-popover.ts); `tests/bases-creation.test.ts`, `bases-controller-commands.test.ts`, `bases-session-completion.test.ts`, `base-new-item-popover.test.ts`. |
| L | [Table](../../src/bases/table-view.ts), cards/list/Kanban renderers and shared presentation; `tests/bases-table-*.test.ts`, `bases-cards-list*.test.ts`, `bases-layout-completion.test.ts`, `bases-kanban-*.test.ts`, `bases-group-edit-values.test.ts`. |
| X | [Session](../../src/bases/session.ts), [workspace](../../src/ui/workspace.ts), [embeds](../../src/ui/base-embed-sessions.ts), inline Base, clock and export modules; `tests/workspace-base*.test.ts`, `base-embed-sessions.test.ts`, `inline-bases.test.ts`, `bases-session*.test.ts`, `bases-export.test.ts`, `bases-clock*.test.ts`. |

`R:` below names reference capture basenames in the private catalog; each has
`.png` and `.json`. A captured menu proves its observed contents, not that every
listed action was exercised. `A:` identifies actual Zorid campaign evidence.

## Scope and readiness

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| B1 Exact initial Obsidian UI/logic, all four layouts | Reference ledger, focused REA, R: `baseline`, `*-layout`, `*-view-settings`; L/T/X source. | Matched fixtures, viewport/theme/scaling and corresponding executed Zorid screenshots across states; no overall parity established. |
| B2 Full template, rich definitions and relations retained | N/P/Q source and deliberate-difference ledger. | Execute each extension and safety policy; additions are not claims that Obsidian exposes those fields. |
| B3 Desktop target; actual Rust/WASM and supported web/CLI paths | Q/X and prepared browser/CLI harnesses. | Final matched native and actual browser/WASM/web/CLI runs. Mobile/other OS/Tasks/Calendar/sync remain outside this pass. |
| B4 Ordinary optional `type:`; no named note Type registry | Generic Base creation/property flows use D/N/P; `Properties.yaml` contract. | Complete old-consumer inventory. Existing Tasks Type/preset code remains deferred; its presence is not proof generic Bases require it or permission to delete task data. |
| R1 Reconcile main, branches and source | Coordinator checkpoint and this frozen audit. | Main remains separate; reconcile final worker closure and main before integration. |
| R2 Inventory/remove generic named-Type requirements | P definitions explicitly independent of `type`; ordinary Create Base A001–004. | Record full retirement/migration inventory; preserve existing files and deferred Task/Calendar consumers. |
| R3 Named ownership and isolated integration | Coordinator checkpoint lists scopes/branches; audit has its own branch. | Final reviewed/integrated commit map and sole-owner main integration. |
| R4 Feature/reference matrix and bounded REA | This matrix; reference ledger and focused receipts. | Close unobserved behavior with precise scenarios; static inventories do not establish runtime. |
| R5 Matching UI captures and interactions | 51 reference entries; early A screenshots at 1280×860 versus reference predominantly 1024×800. | Corresponding matched screenshots, selection/drag/keyboard/focus states and per-batch comparisons. |

## 1. Shared query/configuration

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| Q1 Vault-wide committed index/non-Markdown/exclusions | Q; controller shared query requests retain saved identities and coverage. | Actual applicable attachment/non-Markdown rows, excluded files and unavailable metadata; no silent missing-data interpretation. |
| Q2 Rust Base AND view filters, nested/advanced | Q; toolbar expression/filter tests; R: filter menu. | Actual nested editing and semantic cross-host corpus. A004 failed filter interaction; rerun its correction. |
| Q3 Complete expression/value matrix | Q expression/corpus/rich-value fixtures and documented diagnostics. | Capability-by-capability oracle coverage, date/timezone/regex/error/cycle/rich-value behavior in native and actual WASM; no complete language-parity assertion. |
| Q4 Rust search/sort/group/order/limits/count pipeline | Q; group edit transport tests; latest REA below. | **First-match grouping correction still implementing outside this snapshot.** Validate mixed scalar/list/date/link groups, pre-search chooser counts, global limit and final representatives on all transports/UI. |
| Q5 Built-in/custom summaries and scope | Q summaries; X summary preview/editor; R: `summary-picker`, `summary-sum-selected`. | Group/overall summaries after limits, errors/all-null/mixed values, paging-independent totals and incomplete coverage in actual hosts. |
| Q6 Typed identity/revision/diagnostics/coverage/clock/this/cancellation | Q shared adapters, freshness/clock/preview tests. | Final native+actual WASM contextual corpus, cancellation/pin-release and stale completion scenarios; partial previews remain read-only. |
| Q7 TS presentation and explicit fallback policy | Controller lines 264–313 choose Rust when a semantics service exists; only absence selects `executeBaseQuery`. Rust failure is not caught into that fallback. | Document supported legacy-host policy and test actual host selection; do not claim the separate TS evaluator is retired or semantically identical. |
| Q8 Targeted source preservation/errors/unknown views | D ordered document edits and tests; A002–004 saved rename preserves sentinel/comments. | Final UI invalid-source recovery and unknown renderer/config fields survive edits, close and restart. |

## 2. Base/view/result configuration

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| V1 Create/open/rename/move/delete Base files | X workspace command/file services; A001–004 Create Base durable check. | Final normal entry points, naming collisions, file actions, dirty/replaced-source refusal and reopening. |
| V2 Add/duplicate/rename/delete/reorder/default/named fragments | D/T; reference view-action/default/rename/duplicate/delete/reorder captures; A view rename. | Actual final-source full sequence, active-view deletion, last-view guard, named-embed reference rewrites/retry/restart. |
| V3 Complete shared toolbar | T/X; R: baseline and toolbar menus. | Execute every action with placement, availability, focus return and keyboard behavior; normal menu appearance comparison. |
| V4 Visual/advanced All views/This view filters | T/D/Q; R: filter menu only. | Executed nested/type-aware edits preserving advanced expressions, save failures, focus/Escape and reopening. |
| V5 Multi-sort/group/manual visibility/empty/collapse/reset | T/L/Q; R: group choices/manual controls/show-all; live-preview source tests. | Typed first-match correction plus actual drag preview/cancel/commit, empty-group creation, collapse/reset and failure reconciliation. |
| V6 Properties/order/display/formula CRUD/limits/settings | T/D/X; formula editor and toolbar tests; R: Properties and layout settings. | Actual visibility/order/display-name/formula CRUD, diagnostics, results limits and settings persistence; menu presence alone is insufficient. |
| V7 Saved versus transient session state | D/X named-view and embed tests; workspace session persistence. | Reopen/restart, independent embedded selection/scroll/drafts, active/default view semantics and no transient cross-embed leak. |

## 3. Rich properties and relations

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| P1 Shared file-backed value settings | P uses optional root `Properties.yaml`; targeted-preservation tests. | Edit from ordinary note and Base, refresh both, conflicts/invalid settings, save/restart. |
| P2 Scalar/date/list/tag/link widgets, missing/incompatible values | P/L/Q and raw edit-value tests. | Actual edit every control in all applicable layouts; preserve missing/unknown values and unrelated source, show diagnostics without corruption. |
| P3 Select/multiselect/status option lifecycle | P settings and widget tests; contract separates settings identity from readable labels and explicit rename migration. | Actual create/rename/reorder/color/remove/unknown option and status-category UI; migration disclosure and resulting notes. No reference widget capture exists for these additions. |
| P4 Relation pickers/filter/open/unresolved states | P/Q/X targets and ordinary-note relation display tests. | Actual single/multiple/filtered choice, clickable labels, missing/unresolved values and inline-note display refresh. |
| P5 Stable snapshot identity and readable link lifecycle | Q/P contract, identity/revision guards and controller link services. | App rename, external move/copy/delete/path reuse, rooted/escaped/alias links and stale edit refusal in real hosts. No hidden immutable foreign key is promised across arbitrary external edits. |
| P6 Reverse relations/lookup/rollups/invalidation | Q relations/rollup tests and PROPERTIES contract. | Actual UI derived updates, cardinality/null/error/cycle behavior and dependent view refresh; derived fields remain read-only. Derived-target-filter dependency limitation must remain explicit. |
| P7 External edits/dangling/unknown/no cascade | Q/D preservation and relation tests. | Actual external edit/delete/repair with open buffers; referencing notes and unrelated unknown properties survive. |

## 4. New and full templates

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| N1 Ordinary New from tabs/embeds/groups, folder/collision/focus | N/X/L; R: New popover and retained title focus. | Actual final tab/file/fenced/group/column New, collision handling, note open/popover focus and repeated New. |
| N2 Complete literal template copy | N session completion test; R confirms reference frontmatter-only baseline. | Actual Zorid byte/content readback of frontmatter/body/placeholders and unchanged template, including CRLF/comments/supported formatting. |
| N3 Safe explicit/inferred defaults | N creation tests; grouped raw-key transport tests. | Actual no-template simple predicates, complex predicates yielding no guessed values and typed date/link/list defaults. |
| N4 Explicit template/default/group precedence | N tests; empty-group New skips assignment, while move-to-null clears. | Conflicting template/filter/group values and note-outside-view explanation; no silent rewrite of copied template data. |
| N5 Invalid inputs and uncertain-create recovery | N/D tests; bounded native/browser create-receipt reports. | Mounted New error/draft/retry, unreadable/missing template/invalid folder, lost replies/path replacement/revision advancement; no duplicate notes. |
| N6 Configuration access/picker extension | T/N configuration source and reference settings evidence. | Actual configured folder/template selection and clear extension labeling where no reference native picker was observed. |

## 5. Layouts and shared commands

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| L1 Table rich cells/selections/menus/columns/row heights/keyboard/clipboard/summaries/file actions | L component/command/selection tests; R: table, numeric header menu, summary picker, seven controlled paste probes. | Actual cell/range/row/column/multiple selection, drag/reorder/resize/reset/auto-size, row height, keyboard/IME, clear/copy/paste/undo, groups and actions with reference comparison. `numeric-cell-menu` has no DOM menu and proves no table cell menu. |
| L2 Cards images/options/groups/open/hover/context/drag | L cards/list review tests; R: cards layout/settings. | Actual image lease/covers/fit/ratio/options, grouped collapse, text/link/modifier/middle click, hover/context/file drag. |
| L3 List markers/separator/indent/groups/edit/open/context | L cards/list tests; R: list layout/settings. | Actual all marker/separator/indent states, grouped sections and edit/open/context interactions. |
| L4 Kanban covers/options/groups/empty/moves/New/folders/order/recovery | L layout completion/group-edit tests; R: static layout/settings/manual controls. | Actual pointer/keyboard card and column moves with live preview/cancel/failure, typed list/null/date/link groups, empty New, folder moves and observed sorted insertion. No reference card-move capture exists here. |
| E1 Common widgets, virtualization/resources and semantic commands | P/L/X disposal/lease/draft tests and layout-preview tests. | Actual cross-layout edits, offscreen content and delayed image/drag completions; no retained leases/listeners or DOM-order writes. |
| E2 NoteBuffer edits and original identity/revision | D/X durable-edit/draft tests; workspace bridge and ordinary relation-display source. | Actual dirty body/caret/editor undo/comments retained, saved revision reuse and path replacement/stale target refusal. |
| E3 Base undo/redo for edit/paste/clear/move | D/L command/history tests; static reference history REA. | Actual command history plus unrelated/touched intervening edits, added keys, redo invalidation and editor-input undo ownership. |
| E4 Bulk atomic/partial boundary/recovery | D/L command tests report per-file outcomes, not multi-file atomicity. | Actual partial failure/retry/readback and coherent selection/history recovery. |
| E5 Reference/custom clipboard plus TSV/Markdown and input ownership | L raw-format parser/tests; seven actual shipped-handler reference event probes. | Actual native clipboard roundtrip, mixed/read-only/invalid/clipped inputs, offset rectangles, raw numbers versus strings, list append, IME/native text ownership. Synthetic ClipboardEvents do not satisfy OS clipboard integration. |

## 6. Embeds, export and lifecycle

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| X1 Standalone/file-view/fenced sessions and exact-block updates | D/X file/fenced/nested embed tests and focused static reference processor. | Actual Reading/Live nested fences, Unicode/CRLF spans, source preservation and independent simultaneous sessions. |
| X2 Correct standalone/containing `this`, rename/fragments/split/stale mount | Q/D/X context and named-reference tests; rename binding source now present. | Actual renamed fragments and dirty reference recovery, splits, stale mounts and retained edits; older ledger's disabled-rename gap is historical, not proof new source passed. |
| X3 Sidebar active-main context/pin/close/refresh | X sidebar source and context tests. | Actual reference/Zorid note switching, pinning/closing panes, stale results and edit identity. A visible sidebar in a screenshot is insufficient. |
| X4 Draft/navigation/close/detach/restart/resources | D/X lifecycle tests; authored heavy-user journey. | Actual unsaved/failed/uncertain work across close/remount and signal-free normal quit/restart; resource/pin cleanup and no lost writes. |
| X5 Current-result copy/export CSV/TSV/Markdown/paths | X export tests, Results menu reference; prepared CLI exports JSON. | Execute normal product result export with quoting/Unicode/limits/coverage; no viewport/1,000-row truncation. CLI has no Base cell-edit or CSV/TSV/Markdown export command; don't emulate unsupported commands as product acceptance. |
| X6 Refresh across file/settings/config/time changes | Q/X freshness/clock/relation tests. | Actual creates/moves/deletes/external edits, open-buffer agreement, settings/rollup refresh and time wakeups across views. |
| X7 Keyboard/accessibility/resize/themes/scaling | T/P/L accessible labels and focus/keyboard source tests; predominantly dark reference captures. | Actual full traversal/focus return, screen-reader review, light/dark and scaled matching screenshots. Mobile/touch remains deferred. |

## Final acceptance gates and extra checkpoint requirements

| ID / requirement | Available evidence | Remaining acceptance |
| --- | --- | --- |
| A1 Electron create/membership/columns/New/views/all types | Authored [heavy-user harness](../../tests/bases-electron-integration/README.md); partial A001–004 positives. | One complete final-source run with durable readback and failure/repeat cases. |
| A2 Electron selections/clipboard/undo/columns/summaries/layouts/moves/relations | L/P/Q tests and journey source. | Full mounted workflow, matching screenshots and actual interaction outcomes. |
| A3 Electron splits/sidebar/embeds/external conflicts/close/restart | D/X tests and journey source. | Complete actual lifecycle/conflict journey and normal restart. |
| A4 Native Rust and actual browser/WASM corpus | Q authored corpus, coordinator-reported earlier checks, prepared Worker harness. | Matched final source/artifact fingerprints and actual browser Worker/WASM/IndexedDB run; native-compiled WASM adapters alone are insufficient. |
| A5 Actual web/independent CLI supported paths | Prepared browser/CLI runners with explicit command boundaries. | Execute against matched artifacts, report exact supported surfaces separately from desktop rendering. |
| A6 Independent review and screenshot/behavior closure | Scoped reviews/checkpoint; reference and earlier A screenshots retained. | Resolve final data integrity/stale identity/material reference findings; compare corresponding actual images/actions, not compilation or component-test success alone. |
| A7 Update tracking and integrate confirmed work to main | Coordinator owns checkpoint/queue/main. | Final verification record and sole-owner integration; this audit does not change goal checkboxes. |
| C1 Custom summary live editor/rename/delete/all-view references/guards | X custom-summary editor and T/D source; summary retry/formula-editor tests. | Actual create/edit/rename/delete, name collision/empty guards, all-view selection updates and save/retry; reference custom editor/CRUD runtime remains uncaptured. |
| C2 Named-view embed rename rewrites binding/references | D view-reference controller and X binding callback; reference static rename receipt. | Actual file/fenced/nested embed rename with dirty/conflicted refs and retry/reopen/restart. Source addition supersedes the old disabled-only implementation, not its acceptance gap. |
| C3 Live group/column reorder preview | T groups and L layout completion preview/cancel/failed-drop tests. | Actual reference and Zorid drag insertion preview, cancellation/focus and final saved order; persistence alone is insufficient. |

## Latest grouping reference contract — implementation still pending

The target is now the observed **first-match** behavior. There is no approved
strict-partition deviation. These focused static receipts supplement the existing
runtime capture set; neither receipt proves a typed-group UI scenario executed.

| Receipt | Exact provenance and coverage |
| --- | --- |
| `ev_9783c03d2a914d4515990a738fb4bb7497672f9a802eea8c548195e6f596bee8` | `/private/tmp/zorid-bases-typed-group-reference/provenance.json`; same original `app.js` hash above. Nine prepared inert JS slices, 6,136 AST nodes, zero parse failures; semantic graph capped 1,000/200 and external dependencies unresolved. One earlier prepared excerpt had a trailing-separator parse failure, corrected before this receipt. Ranges are **Python decoded Unicode character offsets**, not byte offsets: hydration/comparison 2489460–2490898; frontmatter serialization 2374636–2375266; frontmatter inference 2199918–2201551; dates 2201789–2203742; links 2210465–2211875; Kanban group writes 3155362–3159214. |
| `ev_ba39607c8bbc75fffbbdff21d6ea4223b195250308906857109f0b3aedfa68a4` | `/private/tmp/zorid-bases-group-pipeline-reference/provenance.json`; four inert JS slices, 2,414 AST nodes, zero parse failures; graph capped 500/150. Python character ranges: view data 2490902–2493579; controller render/context/chooser 2542340–2545073; filtered scan 2545419–2546745; search 2547423–2547865. |

Observed source algorithm:

1. Persist group order as raw frontmatter-shaped YAML: date strings, wiki-link
   strings, recursive lists/scalars/null. Rehydrate each configured key through
   ordinary frontmatter inference with the grouped property name and the Base
   file as link-resolution origin. No namespace DTO is persisted as a YAML object.
2. Manual `HJ` picks the **first** configured key matching `jJ`. `WJ` seeds one
   group per configured key, assigns each row once and uses the first matching
   actual row as that group's display key. Later equivalent configured keys can
   remain empty. Table/List hide empty manual groups; Kanban retains them.
3. Automatic `qJ` also chooses a first existing loose-equality match. Numeric and
   string scalars, singleton lists and date-only/date-time values can match.
   Date equality can be non-transitive; don't assume it defines a canonical
   equivalence class. Its existing string-key cache is only a lookup shortcut;
   an all-groups loose-match fallback is still performed.
4. Display pipeline: ignored-file exclusion and Base AND view filters → manual
   admission → visible-property search → file-path pre-sort → configured view
   sort (or its default) → **global** limit → grouping. Automatic group direction
   sorts finished groups afterward; it is not prepended to row sorting and does
   not change the first representative. Manual groups follow configured order.
5. Manual chooser counts/representatives instead use filtered `results` Map
   insertion order before admission/search/sort/limit. This is a separate result
   scope and can differ from display. `HJ` caches the matching index per entry;
   that cache does not select the group's representative.
6. Kanban move/New serializes the chosen key with the destination note context;
   scalar values wrap in arrays for inferred list properties. Moving to null
   deletes the property; New in null skips assignment and retains defaults.

Required closure: mixed numeric/string/singleton-list keys, same-day date-only
and multiple datetimes, wiki aliases/resolution collisions, nested list keys,
duplicate configured keys, empty groups and raw-key roundtrips; compare chooser
and display before/after search/sort/global limit. Validate independent native
and actual WASM oracles and the real UI after the Rust owner's correction lands.

## Concrete uncovered scenarios to schedule

Prioritize the corrected full Electron rerun, typed grouping corpus/transport
closure, named-view/relation-link rename safety and the final browser/CLI runs.
Then close reference/runtime gaps for custom summary CRUD, table interaction
geometry, Cards/Kanban move/New, sidebar context/pinning, native clipboard/history,
real filter/search/export actions, light mode/scaling and accessibility. Rich
property/relation additions need Zorid acceptance scenarios, not fabricated
Obsidian reference captures. This is a functional completion queue; it does not
activate deferred mobile, Tasks/Calendar, sync or performance campaigns.

## 2026-10-22 R2/B4 inventory addendum

A read-only source recheck at `099d94ed` confirms the
[completed named-Type retirement inventory](bases-type-retirement-inventory-20261022.md).
Generic Base creation, querying and property controls have no named note-Type
admission requirement. They use ordinary files/properties and optional
property-value definitions; `type: book` remains ordinary user data under the
[current implementation goal](../plans/bases-implementation-goal.md).

The earlier R2/B4 rows remain the findings of this frozen audit. Their requested
old-consumer inventory is now recorded; this addendum does not rewrite those rows
or claim runtime acceptance. Existing Type parsers, registries, presets and
Task/Calendar consumers remain deferred dependencies. Preserve their user files
and data; no removal, migration or resumed Task/Calendar implementation follows
from completing this inventory. This recheck ran no builds, tests or apps.
