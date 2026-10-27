# Local collections, types and Base views — implementation tracker

Updated: 2026-10-27. Owner: this discussion's coordinator (`/root`).
State: **planned; product implementation stopped for discussion**.
Current authorization: documentation and tracking only. A later explicit user
resume is required before product work continues. This file is not a built-in
active goal and does not grant a main integration lock or a heavy-build slot.

Product authority: [design decisions](../design/types-properties-sync-discussion.md).
Future sync requirements: [roadmap](../roadmap.md#future-collection-collaboration-and-sync).
Repository execution/ownership: [checkpoint](../deferred-product-roadmap.md).
Incoming corrections: [user findings](../user-findings.md).

## Resume checkpoint

| Item | Current state |
| --- | --- |
| Current task | Record agreed UI/edge cases and prepare this tracker. |
| Design branch/worktree | `codex/database-collaboration-design` / `.worktrees/database-collaboration-design`, historical base `8507a855`. |
| Canonical main at documentation start | `214a96ae`; another session had staged changes. Main was not edited by this pass. |
| Product implementation | Stopped. No reviewed implementation or integrated feature commit. |
| Product verification | Not run for this design. Earlier Bases acceptance does not cover it. |
| Reference evidence | Bounded Notion filter-creation UI observations; design section 1 records exact cases and limits. |
| Next authorized work | Documentation consistency review and scoped documentation handoff. |
| First work after explicit resume | Audit current main and paused drafts, name coordinator/seam owners, resolve the first local contract batch below. |
| Dependencies | Main integration ownership acknowledgement; current-code audit; identity/storage and safe publication contracts. |

Before each resumed pass or after context compaction:

1. Read this checkpoint and the design's local scope, defined edge cases and
   remaining contracts. Read the repository execution checkpoint and new findings.
2. Confirm actual main HEAD, worktree status, active owners and resource use.
   Preserve another session's dirty/staged work; acquire the acknowledged shared
   integration protocol before touching main.
3. Record the pass objective, source base, named file/seam owners, dependencies
   and bounded exit scenarios below. Implementation uses isolated branches.
4. Finish one coherent batch with scoped review and relevant checks. Record
   source checks separately from integrated product/runtime evidence.
5. Integrate confirmed changes through the main owner; record the exact resulting
   commit and revalidate changed behavior. A clean cherry-pick is not semantic proof.
6. Update this checkpoint before a handoff: next action, pending work, failed or
   unexecuted cases, commands/evidence paths and unresolved decisions. Append a pass
   receipt; keep large logs outside this file and link them.

## Scope boundaries

The design is the source of truth for behavior; task rows below reference its
E01–E20 IDs rather than redefine them. Required local scope includes independent
view sources, collection-owned schema/entries, browsing-only untyped views,
readable Markdown, local durability/recovery and retirement of the special
Properties.yaml registry across consumers. Local work must not require sync-group
enrollment. Ordinary files are not permission to silently migrate or delete data.

Collaboration/CRDTs, encrypted transport activation, note import, cross-collection
moves, calendar/provider expansion, a block editor and native mobile delivery are
outside this implementation pass. The user has deferred sync to the roadmap;
future sync tests are not local acceptance gates.

## Workspace ledger

These are observed preparatory artifacts, not assigned active workers or approved
implementation. All original workers were interrupted when the user requested
further discussion. Inspect again before reuse; nothing here authorizes cleanup,
resuming their code or committing another session's work.

| Branch / worktree suffix under `.worktrees/` | Historical owner | Observed state at this documentation pass |
| --- | --- | --- |
| `codex/database-collaboration-design` / `database-collaboration-design` | Discussion coordinator | Design/tracker docs; pre-existing user-findings draft retained and extended. |
| `codex/local-databases` / `local-databases` | Earlier root composition | At `9c0567e4`; no product edits observed. |
| `codex/local-database-core` / `local-database-core` | `local_core` | At `9c0567e4`; no product edits observed. Store API proposals were tentative. |
| `codex/local-database-native` / `local-database-native` | `local_native` | At `9c0567e4`; no product edits observed. |
| `codex/local-database-ui` / `local-database-ui` | `local_ui` | At `9c0567e4`; no product edits observed. |
| `codex/local-database-queries` / `local-database-queries` | `registry_retirement_audit` | Six uncommitted Rust/TS registry-retirement file edits; no acceptance or integration. |
| `codex/local-database-docs` / `local-database-docs` | `local_model_audit` | Uncommitted roadmap and untracked design draft; predates final view/untyped decisions and must be reconciled. |

Source audit notes to recheck: managed-record registration currently requires
sync enrollment even for Local policy; reusing that API must not manufacture
fake enrollment. Root `.zorid` is reserved, so managed type YAML needs a supported
internal publication path. Whole-note saves and generated frontmatter must share
one composition owner. These are earlier source observations, not frozen APIs.

## Work breakdown

States: **planned → implementing → reviewing → verifying → accepted**.
Use **blocked** with a named prerequisite when a batch cannot advance. Keep the
Source, Integration and Runtime columns independent; accepted requires its
relevant scenario on integrated source, not just completed code or unit tests.
All implementation owners below are **unassigned** until explicit resume.

| Batch | Scope and required exit | Dependencies | Source / review | Integration | Runtime |
| --- | --- | --- | --- | --- | --- |
| L0 Contracts and current-code audit | Resolve identity/local storage, view-source format/legacy transition, publication owner, deletion/restore transactions and initial datatype scope; document exact API/file ownership. | Explicit resume; current main/owner audit | Planned / unassigned | None | N/A; no product acceptance |
| L1 Local domain/storage | Stable schema identities, collection membership, validated property operations, revision guards and durable retries without new sync enrollment. | L0 | Planned / unassigned | None | Not run |
| L2 Readable projection and editor saves | Managed type YAML plus `_id`/readable `_type` frontmatter; preserve bodies/unrelated data; guarded publication, restart repair and editor-save composition. | L0–L1 | Planned / unassigned | None | Not run |
| L3 Per-view source/query + registry retirement | Each view one collection or strictly untyped source; remove registry discovery/creation/watchers/admission in Rust/native/WASM/TS while preserving ordinary legacy files; audit IPC/CLI consumers. | L0–L2; coordinate query/transport owners | Planned / unassigned | None | Not run |
| L4 Base/view onboarding and browsing | Create Base/first view, create/select collection, add independently sourced view, Notion-style interactions; untyped title/preview/file browsing with no property grid. | L3; UI/workspace seam owner | Planned / unassigned | None | Not run |
| L5 Collection editing and New | Property/option controls, configured first datatypes/layouts, immediate filtered creation/defaults, editing/row hiding/open-note preservation, multiple-view consistency. | L1–L4; deterministic defaults contract | Planned / unassigned | None | Not run |
| L6 Deletion, recovery and edge closure | E07–E20: duplicate/rename, schema changes, deletion and restore, inaccessible sources, file moves/external edits/identity repair. | L1–L5; recovery contracts | Planned / unassigned | None | Not run |
| L7 Review, integration and delivery | Close material review findings, integrate coherent batches, run changed local journeys on exact installed source; record desktop/CLI/web results independently and platform limits. | Relevant earlier batches | Planned / unassigned | None | Not run |

L7 review/integration can run alongside independent bounded source work once a
batch is ready. Keep shared API changes coordinated and heavy compilation/native
verification serialized on the 8 GB machine. Follow the standing resource rules;
iOS requires its own explicit validation slot and is not this pass's scope.

## Acceptance matrix

Every row starts **not run** for Zorid. Add exact source/artifact identities and
retained evidence to the pass receipt when exercised. UI reference observations
are not product test passes. Use focused safety tests and ordinary journeys;
repeat passed scenarios only after relevant changes or unresolved failures.

| Case | Integrated scenario / oracle | Status |
| --- | --- | --- |
| A01 Sources/onboarding | One Base has Books, Projects and untyped views; each selects only its own source and retains independent configuration after reopen. | Not run |
| A02 Untyped browsing | Title/previews/file info + folder/tag/content/frontmatter filters work; collection notes excluded; no user-property columns/configuration/cell editing or implicit membership. | Not run |
| A03 Ownership | Same-name fields in separate collections stay distinct; repeated preset creates independent collection; no import or cross-collection move UI/API path. | Not run |
| A04 Immediate New | Equality, multiple choices, OR, number range, unsupported and contradictory predicates create without questions or filter-synthesis blocking; actual persisted values recorded. | Not run |
| A05 Edit out of filter | Successful edit hides row, keeps collection entry and open editor; failed save retains draft/error. Reopen confirms actual saved state. | Not run |
| A06 Shared entry | Two views/splits/linked placements reflect the same durable entry changes without overwriting body edits. | Not run |
| A07 Untyped New | Ordinary note created in specified default/deduced folder without prompts; feasible filter defaults applied; no collection assigned. | Not run |
| A08 Identity/rename/duplicate | Renames retain IDs/values; in-collection Duplicate gets new entry ID; folder moves retain membership; missing/duplicate external IDs cannot merge unrelated files. | Not run |
| A09 Schema changes | Populated field/option deletion and incompatible datatype cases follow the settled contract, retain recovery evidence and survive restart. | Not run |
| A10 Delete/restore | Deleting view/Base preserves collections; deleting collection includes hidden members; referencing views show deleted source; restore/path collision/partial-failure cases preserve unrelated data. | Not run |
| A11 Publication crash | Interrupt between structured commit and readable publication; restart resumes bounded work, preserves body/unknown external data and refuses stale overwrite. | Not run |
| A12 Registry removal | No special Properties.yaml reads/writes/creation/watchers/admission; existing file is ordinary content and cannot grant schema authority or block queries, across affected hosts. | Not run |
| A13 Independent clients | Standalone CLI and normal editor local operations follow same validation/storage guards; browser support/capability outcome recorded separately. | Not run |
| A14 Product lifecycle | Matching installed desktop create/configure/edit/delete/restore/normal quit/reopen; exact supported layouts/keyboard behavior and remaining platform limits recorded. | Not run |

## Open decisions and findings queue

Read [design section 13](../design/types-properties-sync-discussion.md#13-remaining-contracts-before-the-relevant-implementation-batch)
for the remaining contracts. Assign each decision to its owning batch before
editing that seam. A newly discovered product decision returns to discussion;
ordinary implementation choices can be resolved within the approved scope after
resume. Corrections override earlier assumptions and update the design, affected
batch and acceptance cases together.

| Item | Owner / dependency | State |
| --- | --- | --- |
| Identity, durable authority, view/legacy migration and composition contracts | L0; unassigned | Open |
| Default synthesis precedence, templates, ranges and untyped destination | L0/L5; unassigned | Synthesis details open; automatic creation without questions or filter-based blocking is settled |
| Recovery details, datatype compatibility and external identity admission | L0/L6; unassigned | Open |
| Initial datatype/preset/layout inventory and platform sequence | L0; unassigned | Open |
| Any detach-to-untyped action | Product discussion | Unresolved; do not infer authorization |
| Documentation transfer to current main/roadmap | Acknowledged main integration owner | Pending; primary checkout has other-session staged changes |

## Pass receipts

Append one bounded entry per pass. Keep the resume checkpoint short and current;
retain failures and superseded receipts as history rather than turning a later
source fix into an earlier runtime pass.

### P000 — 2026-10-27 — design and tracking only

- Objective: capture later product decisions and edge cases, create a durable
  implementation tracker, and move sync requirements to future roadmap scope.
- Owner/worktree: discussion coordinator, `codex/database-collaboration-design`.
- Changed scope: docs only. Another session's primary-checkout changes untouched.
- Review: independent `types_docs_review` found no material scope/authorization
  issues. Two clarity findings and one optional wording cleanup are fixed.
- Validation: 84 local file link targets and 8 local anchors resolved; fenced
  blocks balanced; whitespace/diff checks passed. Reviewer independently checked
  31 design/tracker/roadmap links and anchors. No product checks run.
- Product integration commit: none. Documentation commit: record in handoff.
- Remaining work: documentation integration through the main owner; implementation
  stays stopped. Explicit resume and L0 are the next product prerequisites.

### Receipt template

```text
Pass/date:
Objective and exit cases:
Owner / branch / worktree / base commit:
Owned files and shared-seam acknowledgement:
Dependencies and resource lane:
Design decisions affected (E IDs) / scenarios (A IDs):
Source commits and independent reviewer/outcome:
Commands/check results (pass/fail/skip/unexecuted):
Runtime app/platform + exact source/artifact identities:
Evidence paths:
Main integration owner / resulting commit:
Remaining risks, failures and open decisions:
Next action and authorization boundary:
```
