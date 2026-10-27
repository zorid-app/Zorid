# Local collections, types and Base views — implementation tracker

Updated: 2026-10-27. Owner: this discussion's coordinator (`/root`).
State: **implementing — local only; no product acceptance yet**.
Latest authorization: the user explicitly resumed with **"ok start"** on
2026-10-27 after the documentation handoff. Root's built-in goal is active;
this repository tracker remains the cross-session record. Collaboration/sync is
still deferred. This file does not grant main integration ownership or a build
slot; follow the acknowledged owner/resource lane below.

Product authority: [design decisions](../design/types-properties-sync-discussion.md).
Future sync requirements: [roadmap](../roadmap.md#future-collection-collaboration-and-sync).
Repository execution/ownership: [checkpoint](../deferred-product-roadmap.md).
Incoming corrections: [user findings](../user-findings.md).

## Resume checkpoint

| Item | Current state |
| --- | --- |
| Current task | P001: implement local collection core/publication, per-view sources, UI and registry retirement in isolated coordinated branches. |
| Composition branch/worktree | `codex/local-databases` / `.worktrees/local-databases`, based on current main `c36c4b0e`; documentation `bc006f23` composed there. |
| Canonical main at resume | `c36c4b0e`, observed clean. Root does not integrate or mutate main. |
| Main integration ownership | Shared-core owner acknowledged from `term_d8b43288-7bf1-464c-af5f-b779721982e3` at 2026-10-27 16:56:08 UTC; retains sole integration. Root terminal: `term_4603116b-4cb4-4e5a-b3a5-968bea283161`. |
| Ordered handoff | Documentation `bc006f23` queued to that owner, not integrated at this cutoff. Product batches follow review and affected checks. |
| Product implementation | Active workers below; no accepted integrated feature or installed-runtime result. |
| Source checks | View-model and registry TS focused checks reported below. Rust query source-contract retry PASS6/6 after a corrected compile failure; no native/runtime pass inferred. |
| Product verification | Not run for this design. Earlier Bases acceptance does not cover it. |
| Reference evidence | Bounded Notion filter-creation UI observations; design section 1 records exact cases and limits. |
| Next action | Compose reviewed source batches, finish local core/native/transport/save contracts and resolve query/UI gaps before actual app verification. |
| Dependencies | Core snapshot DTOs and native guarded projection; trusted query membership; durable body-save composition; independent source review. |
| Resource lane | Query owner completed its sole Rust-slot run and released the lane to root. Root serializes subsequent Rust compilation using `tmp/local-database-target`, release offline `-j1`; no overlapping heavy-build grant. |

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

## Historical workspace ledger — before explicit resume

These were observed preparatory artifacts before the user resumed. The original
workers had been interrupted for discussion. Retain this history; use the active
ownership ledger below for current work. A historical draft is not review or
acceptance, and another session's changes remain protected.

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

## Active ownership and local contracts — P001

All worker branches use their named isolated worktrees under `.worktrees/` and
coordinate composition through root. State here is a bounded source snapshot,
not product completion. Ask the named owner before changing an owned seam.

| Owner | Branch / worktree suffix | Owned seam and current state |
| --- | --- | --- |
| `/root` | `codex/local-databases` / `local-databases` | Composition, API contract coordination, serial validation and ordered main-owner handoff. |
| `local_core` | `codex/local-database-core` / `local-database-core` | Local Rust domain, Store schema/entry operations and durable projection records; source/tests pending owner receipt. |
| `local_native` (+ CLI worker) | `codex/local-database-native` / `local-database-native` | Guarded publication/schema YAML, desktop-host database dispatcher/framing; native source uncommitted, no tests yet. CLI source commits `b8308b77`, `bf2561c9`. |
| `registry_retirement_audit` | `codex/local-database-queries` / `local-database-queries` | Rust/native/WASM and TS query registry retirement; per-view trusted source scoping; TS focused checks pass and Rust source contracts PASS6/6. Native full typed hook still pending core DTOs. |
| `view_source_model` | `codex/local-database-view-model` / `local-database-view-model` | Base document/controller/query/creation source model; source `fd5cdd91`, focused checks pass; independent source review pending. |
| `local_ui` | `codex/local-database-ui` / `local-database-ui` | Base session/toolbar, workspace/properties/note targets and collection UI/CSS; source dirty, no tests yet. Managed setters are joining NoteBuffer projection refresh; management lifecycle UI still open. |
| `database_transport` | `codex/local-database-transport` / `local-database-transport` | TS/CJS DTO client/validation, leased desktop capability and IPC/framing; syntax/full TS reported pass, focused boundary tests underway. |
| `managed_editor_saves` | `codex/local-database-editor-saves` / `local-database-editor-saves` | Canonical durable-write composition, submitted-generation reconciliation and NoteBuffer projection refresh; source in progress, no tests yet; raw managed edits safely reject as E18 gap. |
| `local_model_audit` | Read-only reviewer | Independent current-code/contract review; no product file ownership or build lane. |
| `types_docs_review` | Root composition worktree, docs paths only | Tracker/design authorization/checkpoint/findings update; no product edits or heavy builds. |

Root-coordinated local implementation contracts for this pass:

- Markdown `_id` uses the **existing core EntryId**. Do not replace file identity
  with a generated schema ID. Type/field/option identities retain the agreed
  12-character lowercase base36 format.
- Membership is strict: **no ordinary-note import, cross-collection move or detach
  to untyped**. External `_type` edits do not grant a membership operation.
- A field's emitted YAML key is its **exact display name**, not a second immutable
  storage-key system. Rename identity and publication remain coordinated.
- Each saved view carries `source: {kind: untyped}` or
  `source: {kind: collection, id: <collection-id>}` (JSON uses quoted strings).
  A legacy missing source is treated as untyped for compatibility.
- An explicit source uses view-owned filters/formulas/configuration and ignores
  legacy root-level filters/formulas rather than allowing another view's source
  or conditions to leak into it. View `formulas`/`summaryDefinitions` are local;
  `summaries` selects a view's configured summaries.
- Typed queries use ID-keyed values and **trusted core manifest membership**;
  `_type` text or caller-supplied detached metadata is not membership authority.
- Raw managed-property edits may be rejected safely as an **intermediate E18
  gap**. Safe rejection is not delivery of valid external-value reconciliation.
  Body-save composition/guarding is still work in progress.
- E09 permits duplicate view names in the accepted design. Existing named view/
  embed routes still require unique names in the current source: this is an
  explicit implementation gap requiring identity-aware routing, not a new product
  restriction or a completed case.

## Work breakdown

States: **planned → implementing → reviewing → verifying → accepted**.
Use **blocked** with a named prerequisite when a batch cannot advance. Keep the
Source, Integration and Runtime columns independent; accepted requires its
relevant scenario on integrated source, not just completed code or unit tests.
Implementation owners are assigned below. All source/runtime states require
actual receipts; none of these rows is accepted merely because work is active.

| Batch | Scope and required exit | Dependencies | Source / review | Integration | Runtime |
| --- | --- | --- | --- | --- | --- |
| L0 Contracts and current-code audit | Resolve identity/local storage, view-source format/legacy transition, publication owner, deletion/restore transactions and initial datatype scope; document exact API/file ownership. | Main/owner audit complete; remaining contracts with root | Implementing / root + read-only audit | None | N/A; no product acceptance |
| L1 Local domain/storage | Stable schema identities, collection membership, validated property operations, revision guards and durable retries without new sync enrollment. | L0 | Implementing / local_core | None | Not run |
| L2 Readable projection and editor saves | Managed type YAML plus `_id`/readable `_type` frontmatter; preserve bodies/unrelated data; guarded publication, restart repair and editor-save composition. | L0–L1 | Implementing / local_core + local_native + managed_editor_saves | None | Not run |
| L3 Per-view source/query + registry retirement | Each view one collection or strictly untyped source; remove registry discovery/creation/watchers/admission in Rust/native/WASM/TS while preserving ordinary legacy files; audit IPC/CLI consumers. | L0–L2; query/transport owners coordinated | Implementing / registry_retirement_audit + view_source_model + database_transport | None | Not run |
| L4 Base/view onboarding and browsing | Create Base/first view, create/select collection, add independently sourced view, Notion-style interactions; untyped title/preview/file browsing with no property grid. | L3; UI/workspace seam owner assigned | Implementing / local_ui | None | Not run |
| L5 Collection editing and New | Property/option controls, configured first datatypes/layouts, immediate filtered creation/defaults, editing/row hiding/open-note preservation, multiple-view consistency. | L1–L4; deterministic defaults contract | Implementing / local_ui + view_source_model | None | Not run |
| L6 Deletion, recovery and edge closure | E07–E20: duplicate/rename, schema changes, deletion and restore, inaccessible sources, file moves/external edits/identity repair. | L1–L5; recovery contracts | Planned / local_core + local_native; bounded work underway | None | Not run |
| L7 Review, integration and delivery | Close material review findings, integrate coherent batches, run changed local journeys on exact installed source; record desktop/CLI/web results independently and platform limits. | Relevant earlier batches | Reviewing in parallel / root + local_model_audit | None | Not run |

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
| Identity, durable authority, view/legacy migration and composition contracts | L0; root + scoped owners above | Partly specified; persistence/projection review open |
| Default synthesis precedence, templates, ranges and untyped destination | L0/L5; view_source_model + local_ui | Synthesis details open; automatic creation without questions or filter-based blocking is settled |
| Recovery details, datatype compatibility and external identity admission | L0/L6; local_core + local_native | Open |
| Initial datatype/preset/layout inventory and platform sequence | L0; root + local_ui | Open |
| Detach-to-untyped action | Root local membership contract | Excluded, together with import and cross-collection moves |
| Documentation transfer to current main/roadmap | Acknowledged shared-core main integration owner | `bc006f23` queued; main observed clean at `c36c4b0e`, not integrated at cutoff |

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

### P001 — 2026-10-27 — local implementation resumed; underway

- Authorization: user **"ok start"** resumes local implementation after P000.
  Sync/collaboration and unrelated product expansion remain deferred.
- Root composition/main: `codex/local-databases`, baseline `c36c4b0e`; docs
  `bc006f23` present locally and queued to the acknowledged main owner. No
  integrated product commit or runtime acceptance recorded at this cutoff.
- Ownership/resource receipt: main owner acknowledgment at 16:56:08 UTC from
  `term_d8b43288-7bf1-464c-af5f-b779721982e3`; sole Rust slot belongs to query owner,
  root `tmp/local-database-target`, release offline `-j1`. The owner has now
  released the lane to root after PASS6/6. Root assigns the next heavy command;
  other workers have no overlapping grant. Source/TS work proceeds in parallel.
- View-model source receipt: `view_source_model`, `fd5cdd91`, reports 77 focused
  and 32 adjacent checks PASS, zero skipped; these groups overlap and are not a
  summed count. Full TS PASS. Logs: `/private/tmp/zorid-view-source-test-002.log`
  and `/private/tmp/zorid-view-source-adjacent-001.log`. Independent review pending;
  this does not establish integrated or runtime behavior. Duplicate view-name
  routing remains E09 work despite the model accepting the design direction.
- Registry source receipt: query owner reports full TS PASS; retirement suite
  2/2 PASS and browser test restricted to `retired global registry` 1/1 PASS.
  Branch source is uncommitted at the receipt. Old registry campaigns are stale
  feature protocols, not silently rewritten into new acceptance claims.
- Rust query receipt: first cold compile failed because `preparation` copied
  QueryOptions without new `source_scope`. Constructor corrected; scoped contexts
  also bypass a cache whose key lacks authority. Retry completed **PASS6/6**, zero failed:
  `cargo test --locked --offline --release -j1 -p zorid-bases --test view_sources
  -- --test-threads=1`. Logs in root `tmp/local-databases-20261027/`:
  `query-view-sources-001.log` (failure) and `query-view-sources-002.log` (PASS6/6).
  Native trusted typed-query hook still depends on the local-core snapshot API.
- Transport source receipt: owner reports syntax/full TS PASS; boundary tests
  underway. Leased `databases` capability, max database request body 32 MiB,
  response JSON limit 16 MiB and native handshake alignment are source work,
  not native/runtime acceptance. No source commit at this receipt.
- Native source receipt: `local_native` owns guarded source/schema publication,
  native command dispatcher, desktop-host body/capability handshake; uncommitted,
  no native tests run. CLI child source commits `b8308b77`/`bf2561c9` are source
  only. Compose compares baseline/proposed nonmanaged content and rejects raw
  managed edits with `collection_source_conflict`. Bounded batch count,
  create-family handling, unpublished-property restore composition and external
  schema conflicts remain safety work pending integrated compilation/review.
- UI source receipt: `local_ui` owns Base session/toolbar, workspace/properties/
  note-property-targets and new collection UI/CSS. Source onboarding and core
  create/set/configuration routes are drafted; registry reads/creation/watchers
  removed in its scope. Untyped toolbar hides property/group flows. No UI tests
  or commit yet; management delete/restore/duplicate UI and runtime remain open.
- Save source receipt: `managed_editor_saves`, branch
  `codex/local-database-editor-saves`, owns canonical durable-write composition,
  desktop plan payload validation, submitted-generation reconciliation and
  NoteBuffer `refreshManagedProjection`. In progress; no tests run at receipt.
  Actual compose/apply source guards remain with native/Store owners; raw managed
  edit rejection and schema-baseline ambiguity are intermediate safe gaps.
- Core receipt: pending; no test/source status assumed beyond assigned ownership.
- Documentation tracking check: 62 relative links/anchors across the four assigned
  docs PASS; scoped `git diff --check` PASS. Roadmap authorization paragraph was
  updated under root's added ownership grant. These are documentation checks,
  not product verification.
- Acceptance matrix: all A01–A14 product scenarios remain **Not run**. Raw managed
  edits being safely rejected is an intermediate E18 gap, not accepted external
  reconciliation. No installation, native/mobile or integrated parity claim.
- Next action: finish scoped APIs and safety seams, independently review and
  compose coherent batches, then run the relevant integrated local journeys and
  hand exact commits/evidence to the sole main owner. Update this receipt with
  terminal command outcomes; never promote a running check to PASS. The Rust query
  retry above was updated only after the owner supplied its terminal PASS receipt.

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
