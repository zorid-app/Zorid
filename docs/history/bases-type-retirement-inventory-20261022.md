# Named-Type retirement inventory — 2026-10-22

Owner: `bases_docs_model`; branch `codex/bases-type-inventory`, worktree
`.worktrees/bases-type-inventory`; frozen source **`09cd214e`**. This completes the
source/document inventory requested by readiness R2 in the
[acceptance matrix](bases-acceptance-audit-20261022.md) and the
[current goal](../plans/bases-implementation-goal.md). It does **not** accept
runtime behavior, remove every Type-dependent implementation, or authorize a
Tasks/Calendar redesign. No source, user files or data were changed; no app,
build or tests were run.

## Current boundary

Generic Bases and ordinary property controls use files, normal frontmatter and
optional property-value definitions. `type: book` is ordinary user data. A Base's
layout `type: table`, a property's `type: multiselect`, TypeScript `type` syntax
and document/index data-type declarations are not named note Types.

Named-Type implementations remain in the **legacy Tasks surface and its
Task/Calendar projections/transports**. They are retained dependencies to
reconcile when that deferred work resumes, not prerequisites for generic Bases.
Existing `Types/*.yaml`, task notes, presets and related Base files must remain
readable and untouched during this pass. Removing the design requirement is not
an implicit data migration or deletion instruction.

## Generic paths: no named-Type admission requirement found

| Path / exact source anchor | Current behavior and inventory conclusion |
| --- | --- |
| [workspace.ts:2213](../../src/ui/workspace.ts#L2213), [creation.ts:208](../../src/bases/creation.ts#L208) | Normal Create Base delegates to `prepareBaseFileCreation`, chooses an available `.base` path and serializes a blank `BaseDocument`. It does not create/discover a Type file or request a Type assignment. Folder/menu/command entry points share this path. |
| [controller.ts:264](../../src/bases/controller.ts#L264), [shared-query.ts](../../src/bases/shared-query.ts), [graph.rs:200](../../crates/zorid-bases/src/graph.rs#L200) | Generic Base query reads saved Base/current-file witnesses and the shared generation; filtering is over ordinary file/property expressions. Its inputs do not include `TypeRegistry` or task Type witnesses. The separately retained legacy evaluator is not a note-Type registry. |
| [properties.rs:1](../../crates/zorid-bases/src/properties.rs#L1), [property-definitions.ts:4](../../src/bases/property-definitions.ts#L4), [PROPERTIES.md](../../crates/zorid-bases/PROPERTIES.md) | Optional vault-root `Properties.yaml` defines controls by property name. It is independent of note `type`; select/multiselect/status/relation/reverse/rollup definitions remain required additions. Absence of this settings file does not require a named Type. |
| [document_index.rs:407](../../crates/zorid-native/src/document_index.rs#L407), [document_index.rs:560](../../crates/zorid-native/src/document_index.rs#L560), [bases.rs:129](../../crates/zorid-wasm/src/bases.rs#L129) | Generic native/WASM query and property-target entry points use `PropertyDefinitions` or ordinary generation queries, separately from the explicit Tasks entry points below. |
| [creation.ts:100](../../src/bases/creation.ts#L100), [creation.ts:140](../../src/bases/creation.ts#L140), [session.ts](../../src/bases/session.ts) | Generic New derives safe defaults from Base/view predicates and configured folder/template/group values. It has no Type-source witness prerequisite. A filter on `note.type` may supply a literal ordinary property; this is not registry membership. |
| [property-widgets.ts](../../src/bases/property-widgets.ts), [properties.ts](../../src/ui/properties.ts), [property-targets.ts](../../src/bases/property-targets.ts) | Note/Base rendering uses property-value definitions and captured targets. Generic controls do not import the retained `src/tasks/types-document.ts` editor/parser. Runtime cross-surface correctness remains a separate acceptance requirement. |

The scoped search for `TypeRegistry|TypesDocument|TypeSource|typeWitness|Types/`
returned no matches in `src/bases`, `src/ui/properties.ts`,
`src/core/properties.ts`, or the Rust query/program/properties/relations files.
This is bounded source evidence, not a claim that all Type code is gone or that
every indirect runtime call was exercised. `crates/zorid-bases/src/lib.rs:11–15`
still exports `calendar`, `tasks` and `types`; shared crate membership alone does
not make those modules generic-query admission gates.

## Retained consumers and why they are not deleted

| Consumer / exact source anchor | Retained named-Type dependency | Disposition |
| --- | --- | --- |
| [types.rs:13](../../crates/zorid-bases/src/types.rs#L13), [types.rs:71](../../crates/zorid-bases/src/types.rs#L71), [types.rs:95](../../crates/zorid-bases/src/types.rs#L95), [types.rs:215](../../crates/zorid-bases/src/types.rs#L215) | `TypeSource`, `NoteType`, `TypeRegistry`, definition/property/option IDs and `compile_types` remain. YAML compilation retains source witnesses and diagnostics. | Legacy Task/Calendar interpretation; no new generic Type editor or registry requirement. |
| [types.rs:322](../../crates/zorid-bases/src/types.rs#L322), [tasks.rs:108](../../crates/zorid-bases/src/tasks.rs#L108) | Task capture defaults resolve a registry entry with `capabilities.task`, write its ID into ordinary note `type`, and map semantic status/planned/deadline fields. `query_tasks` explicitly takes a registry. | Preserve existing task data/interpretation. Reconcile IDs, defaults, categories and capability mappings before future retirement. |
| [types-document.ts:121](../../src/tasks/types-document.ts#L121), [presets.ts:24](../../src/tasks/presets.ts#L24), [presets.ts:42](../../src/tasks/presets.ts#L42) | `TypesDocument` parses/preserves the old YAML shape. Task presets create `Types/Task.yaml` plus `Bases/Tasks.base`, ordinary note Type-ID filters and legacy `creation` settings. | Keep parser/preset files and existing source unchanged. Their generated settings are not a current generic Base schema mandate; no automatic preset migration is implied. |
| [controller.ts:142](../../src/tasks/controller.ts#L142), [controller.ts:191](../../src/tasks/controller.ts#L191), [view.ts:77](../../src/tasks/view.ts#L77), [view.ts:111](../../src/tasks/view.ts#L111) | Tasks queries selected Type-definition IDs, chooses a capture Type, edits with `expectedTypeId`/Type witness, and exposes Type selection/preset setup. | Existing deferred consumer remains operational source. This is a Tasks surface, not a newly approved standalone note-Type editor. |
| [workspace.ts:2562](../../src/ui/workspace.ts#L2562), [workspace.ts:2576](../../src/ui/workspace.ts#L2576), [workspace.ts:2601](../../src/ui/workspace.ts#L2601), [workspace.ts:2624](../../src/ui/workspace.ts#L2624) | Tasks host discovers at most 128 `Types/*.yaml` files, rechecks saved Type witnesses for create/edit, and installs a non-clobbering Type/Base preset pair. | Preserve lifetime/CAS and partial-install safeguards. Removing these checks alone would weaken existing task safety. This host is separate from `newBase`. |
| [document_index.rs:431](../../crates/zorid-native/src/document_index.rs#L431), [document_api.rs:8](../../crates/zorid-native/src/document_api.rs#L8), [documents.rs:1407](../../crates/zorid-desktop-host/src/documents.rs#L1407) | Native Task document query compiles exact supplied Type YAML, returns Type summaries/witnesses, and is routed by the explicit desktop `tasks` command. | Retained Task API boundary; do not silently reinterpret it as generic property settings. |
| [document_index.rs:1491](../../crates/zorid-wasm/src/document_index.rs#L1491), [browser-document-index.ts:739](../../src/core/browser-document-index.ts#L739), [document-semantics.ts:96](../../src/core/document-semantics.ts#L96) | WASM/IndexedDB Task read compiles captured Type sources; shared TS DTOs expose `typeId`, Type witnesses and Type diagnostics. | Retain transport validation and exact source proof until the owning Task design/migration changes it. |
| [desktop-document-semantics.ts:159](../../src/platform/desktop-document-semantics.ts#L159), [browser-core-runtime.ts:166](../../src/platform/browser-core-runtime.ts#L166), [browser-core-worker.ts:212](../../src/platform/browser-core-worker.ts#L212), [browser-client-admission.ts:88](../../src/platform/browser-client-admission.ts#L88) | Desktop and browser clients forward the separate Task query through admitted services/Worker dispatch. | Do not remove a transport because the generic Base path no longer needs Type definitions. |
| [calendar.rs:3](../../crates/zorid-bases/src/calendar.rs#L3), [calendar.rs:72](../../crates/zorid-bases/src/calendar.rs#L72), [calendar.rs:263](../../crates/zorid-native/src/calendar.rs#L263), [calendar.rs:516](../../crates/zorid-native/src/calendar.rs#L516) | Rust Calendar task selection/link resolution imports Task projection and `TypeRegistry`; native Calendar compiles Type YAML for its task joins and returns Type summaries. | Deferred Calendar dependency. Preserve captured-generation/link/task invariants; revisit alongside its future task model, not within this Bases pass. |
| [view.ts:9](../../src/calendar/view.ts#L9), [controller.ts:1](../../src/calendar/controller.ts#L1), [workblocks.ts](../../src/core/workblocks.ts) | Existing TS Calendar UI is separately driven by `WorkBlockService`; it is not itself a `TypesDocument` UI. Native Calendar task projections above still have Type dependencies. | Keep these two boundaries distinct. Neither implies all Calendar work is implemented, accepted or in current scope. |

Retained tests/fixtures also encode the old contract: `tests/task-types.test.ts`,
`workspace-tasks.test.ts`, `tasks-desktop-ui.test.ts`, `task-document-binding.test.ts`,
`tests/tasks-electron-integration`, `tests/browser-task-queries`,
`crates/zorid-bases/tests/{tasks,task_yaml,calendar}.rs`,
`crates/zorid-native/tests/{task_documents,calendar}.rs` and Task cases in
`crates/zorid-wasm/src/document_index.rs`. Preserve them as evidence of supported
legacy boundaries; an old passing result is not acceptance of this pass. The
generic CLI source search found no `TypeRegistry`, `TypesDocument`, `Types/` or
`typeWitness` requirement; its Base scenario explicitly uses ordinary `type: book`.

## Retired designs and historical routing

Current authority: [roadmap](../roadmap.md), [goal](../plans/bases-implementation-goal.md),
[checkpoint](../deferred-product-roadmap.md), [findings](../user-findings.md) and
[architecture overview](../architecture/README.md). Architecture
[interfaces](../architecture/interfaces.md), [managed data](../architecture/managed-data.md)
and [Rust core](../architecture/rust-core.md) explicitly distinguish legacy
Type-dependent source from the current ordinary-property direction.

| Old entry point | Preserved original / current status |
| --- | --- |
| [bases-tasks-calendar-plan.md](../bases-tasks-calendar-plan.md) | Routing stub; [original snapshot](bases-tasks-calendar-plan-20261017-superseded.md) is superseded. |
| [managed-data-tasks-calendar-plan.md](../managed-data-tasks-calendar-plan.md) | Routing stub; [original snapshot](managed-data-tasks-calendar-plan-20261017-superseded.md) is superseded. |
| [implementation-plan.md](../managed-data/implementation-plan.md) | Routing stub; [original snapshot](managed-data-implementation-plan-20261017-superseded.md) is superseded. |
| [root-next-assignments.md](../managed-data/root-next-assignments.md) | Routing stub; [original dispatch](managed-data-root-next-assignments-20261018-superseded.md) grants no current ownership. |
| [task-calendar-owners.md](../managed-data/task-calendar-owners.md) | Routing stub; [original owners](managed-data-task-calendar-owners-20261018-superseded.md) are historical. |
| [execution](../managed-data/execution.md), [first-party consumer contract](../managed-data/first-party-consumer-contract.md), [task/calendar/base contract](../managed-data/task-calendar-base-contract.md) | Retained source/evidence with explicit supersession banners. Type requirements and old WorkBlock assumptions require reconciliation before future work. |
| [stage-four Base contract](../stage4-base-contract.md), [task/calendar contract](../task-calendar-contract.md) | Current-scope supersession headers route to the goal/roadmap; older bodies are evidence, not an active Type mandate. |

One remaining documentation ambiguity is
[internal-contract-draft.md:3](../managed-data/internal-contract-draft.md#L3):
it remains a provisional Phase 0 draft but calls its linked plan “accepted” and
lists Types among file authorities at line 17 without its own current-scope
supersession banner. Its destinations now route to superseded/history material.
Treat that text as historical provisional context; a clearer banner is a small
documentation follow-up, not authorization to restore named Types. This inventory
owns only the new file and leaves that draft unchanged.

Property-reference “type registry” terminology denotes **property value types**;
for example [interaction parity](../reference/interaction-parity.md#L126).
Do not remove useful property controls or mistake language/model `types.rs`
files, Markdown checkbox tasks, or ordinary `type` fields for named note Types.

## Retirement disposition and remaining work

The inventory itself is complete for the searched source/document scope. Generic
Base admission is separated from the retained named-Type consumers above.
Future Task/Calendar retirement requires an owning batch to reconcile saved
Type/property/option IDs, status categories, defaults, capture/edit witnesses,
Task DTOs, presets, Calendar task joins and existing user files. No replacement
API or migration policy is selected here, and none is required to continue
generic Bases acceptance. Preserve unknown/legacy settings through ordinary
source edits; never delete Type files or silently rewrite task membership.

The coordinator may record readiness-inventory completion separately from
implementation/runtime acceptance. Remaining actual UI/native/WASM tests,
reference comparisons and main integration stay in the goal/checkpoint; this
source-only inventory does not check those gates.

## Additive equality reference receipts

These later focused Obsidian 1.14.4 static receipts complement the
[reference ledger](bases-pass-reference-20261021.md). They do not change the
named-Type boundary, and no recovered implementation is included in source.
All use `app.js` SHA-256
`958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`.

| REA parent / private provenance | Observation and limits |
| --- | --- |
| `ev_5030c76015d1f5232c054141454ae04af381dbb91615925c6a44113972de78cf`; `/private/tmp/zorid-bases-link-string-reference/provenance.json` | Six inert files, 863 AST nodes, zero parse failures; graph capped 500/150. Link stringification emits raw data once; file-as-link uses raw file path. These stages do not escape `#`, `|`, `%` or brackets. Wiki parse splits the last pipe; resolution strips the first hash. No actual unusual-filename roundtrip was exercised. |
| `ev_24db6c94754710229a22ff771506935e5f42ed1fcc65c217cab3221f245a93af`; `/private/tmp/zorid-bases-loose-dispatch-reference/provenance.json` | Four inert files, 625 AST nodes, zero parse failures; graph capped 400/150. Outer equality checks identity/same-constructor equality, then left/right loose methods. File compares a string-derived value's raw data to its path; a wiki String is not automatically parsed by the File method. Link's wiki-String branch and the reciprocal primitive fallback are separate. |
| `ev_beda69e49de4eff3eee830f0b1020149243ed098eed35fb671092561c5dee9d6`; `/private/tmp/zorid-bases-scalar-inheritance-reference/provenance.json` | Six inert files, 1,658 AST nodes, zero parse failures; graph capped 500/150. String/Number/Boolean and string-derived Link/URL share the raw scalar hierarchy; reciprocal comparisons can apply JavaScript abstract scalar equality. Null is outside it. Date is also outside it, with its own date-string override. No app/runtime execution or full semantic equivalence is claimed. |

Exact Python decoded Unicode-character slice ranges and preparation hashes are
in each provenance file. These are not byte offsets or complete-bundle analysis;
external dependencies and capped semantic graphs remain explicit unknowns.
