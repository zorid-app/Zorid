# Local collections, types and Base views — implementation tracker

Updated: 2026-10-27. Owner: this discussion's coordinator (`/root`).
State: **verifying — local only; bounded CLI pass, full UI acceptance open**.
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
| Current task | P004: bounded actual CLI successor passes; normal Electron test window is live with user interaction. Preserve that active session and hold UI automation. Full UI/browser/main acceptance remains open; no Tauri work. |
| Composition branch/worktree | `codex/local-databases` / `.worktrees/local-databases`, main base `c36c4b0e`; current HEAD `06696a2c` is test-only source `ab538c71` correcting the CLI status oracle. Product artifacts retain the recorded `d7aecf48`/equivalent-Rust `d7a033b7` identities. |
| Canonical main at resume | `c36c4b0e`, observed clean. Root does not integrate or mutate main. |
| Main integration ownership | Shared-core owner acknowledged from `term_d8b43288-7bf1-464c-af5f-b779721982e3` at 2026-10-27 16:56:08 UTC; retains sole integration. Root terminal: `term_4603116b-4cb4-4e5a-b3a5-968bea283161`. |
| Ordered handoff | Documentation `bc006f23` queued to that owner, not integrated at this cutoff. Product batches follow review and affected checks. |
| Product implementation | Source composed; final narrow UI/source review closed through `06696a2c`, no remaining must-fix or source edits pending at this cutoff. Actual standalone CLI successor PASS 30 commands/13 checks/all 7 scenarios; full desktop/browser/main acceptance remains open. |
| Source checks | Final query 24/24, native query-facade 3/3, CLI 3/3 + phase1/1 and error compatibility 2/2 PASS, in addition to earlier Store64/native32/host4/composedJS61/session5 receipts. Counts have distinct source/scope limits; do not aggregate overlapping runs. |
| Product verification | CLI first receipt FAIL at command 29 on counter-type oracle; corrected strict successor PASS 30/13/all 7. Electron onboarding source choices observed through CUA; user actively uses the disposable test window. Full desktop UI/browser/main acceptance open. |
| Reference evidence | Bounded Notion filter-creation UI observations; design section 1 records exact cases and limits. |
| Next action | Respect the user's live test window; hold UI input and do not close it. Record observations and resume bounded UI automation without interfering when the user is finished. Browser readiness/acceptance and ordered main-owner handoff remain separate gates. |
| Dependencies | Remaining normal Electron scenarios/cleanup after user testing, browser readiness/acceptance and sole main-owner integration. Scoped indexing previews remain a safe capability gap; CLI excludes concurrent clients, crash and external-edit acceptance. |
| Resource lane | Root serializes actual validation and any required Rust work in shared `tmp/local-database-target`, release offline `-j1`; no parallel heavy builds or worker Git mutations. Latest user steering: no further Tauri work, including new benchmark/prototype/cleanup work from this pass. |

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

Latest user steering: **do not work with Tauri; finish local collections first**.
No further Tauri prototype, benchmark, migration or cleanup work is part of this
pass. Earlier resource/cleanup requests in P002 remain historical, not current
authorization to continue that work.

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
| `local_core` | `codex/local-database-core` / `local-database-core` | Local authority, trash/restore cohorts, pinned DB state and schema candidate history source fixes composed; current Store64/64 PASS. Material source-review findings closed. |
| `local_native` (+ CLI worker) | `codex/local-database-native` / `local-database-native` | Guarded publication/external reconciliation and host/CLI services composed; native32/32, host4/4, CLI 3/3 + phase1/1 PASS; actual CLI driver running. No actual-app acceptance. |
| `registry_retirement_audit` | `codex/local-database-queries` / `local-database-queries` | Trusted query/registry source reviewed/composed; query catalog `a128` queued, not composed during root Rust freeze. Query12 + preview 12 + native-query 3 await lane. Scoped previews remain disabled safely. |
| `view_source_model` | `codex/local-database-view-model` / `local-database-view-model` | Stable view identities, external-deleted selection recovery and repeated-label toolbar source composed; review closed through `ec4`/`b492`. Actual UI/embed behavior still requires runtime verification. |
| `local_ui` | `codex/local-database-ui` / `local-database-ui` | Collection/property/template/New UI and CSS source composed through current root `2d5aa427`; source review closed through `410025de` plus later narrow changes recorded P002. Historical 132-case failure and targeted successors remain separate receipts. |
| `database_transport` | `codex/local-database-transport` / `local-database-transport` | Leased transport/framing source composed and reviewed; actual admitted app lifecycle unverified. |
| `managed_editor_saves` | `codex/local-database-editor-saves` / `local-database-editor-saves` | Canonical composition/checkpoint protection source composed and reviewed; composed-source/session receipts pass, actual note editor lifecycle unverified. |
| `local_model_audit` | Read-only reviewer | Material core/native/query/save source findings closed at current bounded review cutoff; product acceptance remains separate. |
| `types_docs_review` | Root composition worktree, docs paths only | P002 tracker/checkpoint/findings update; file edits only during host/CLI freeze, no product edits, Git mutations or builds. |

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
- Valid external managed-value reconciliation and its repair correction now
  pass in the later 32-case native library run. Native002's earlier 24/25 failure
  remains historical. Raw edits may still reject when invalid or conflicting;
  actual integrated E18 note-editor/external-file acceptance remains to be run.
- E09 duplicate view labels have composed **stable view IDs**, repeated-label
  toolbar support and external-deleted selection recovery. Legacy ambiguous name
  references fail safely. Source review is closed; actual reopen/embed interaction
  is still unverified, so E09 product acceptance is not inferred.
- Scoped indexing previews are temporarily disabled until their captures carry
  trusted collection membership. Saved native queries remain supported. This is
  an explicit safe capability gap, not claimed preview delivery.

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
| A13 Independent clients | Standalone CLI and normal editor local operations follow same validation/storage guards; browser support/capability outcome recorded separately. | Bounded independent CLI PASS 30/13/all 7; concurrent editor and browser acceptance open. |
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
  released the lane to root after PASS 6/6. Root assigns the next heavy command;
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
  also bypass a cache whose key lacks authority. Retry completed **PASS 6/6**, zero failed:
  `cargo test --locked --offline --release -j1 -p zorid-bases --test view_sources
  -- --test-threads=1`. Logs in root `tmp/local-databases-20261027/`:
  `query-view-sources-001.log` (failure) and `query-view-sources-002.log` (PASS 6/6).
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

### P001 continuation — source composition and native failure cutoff

This continuation supersedes the early P001 source-status bullets above, not
their historical test outcomes. Main integration still belongs to the acknowledged
shared-core owner; root goal remains active. Product A01–A14 acceptance is still
unrun. Current composition is `223d3733` with native-owned dirty compile/repair
changes and copied `bb06db81`; no clean final artifact/source claim is made.

| Scope | Worker source → root composition | Bounded evidence and remaining work |
| --- | --- | --- |
| Core authority | `8aae3e33`→`6f0bb1c4`; `a3ae5eaa`→`223d3733` | Earlier Store17 + host-source-guard14 PASS, logs `core-databases-002.log`. Retained-value correction has 23 authored tests not yet run. Review followups: preserve trash cohort, valid full-reload event journal, pinned database-state fence and superseded schema-artifact candidate history. |
| Native publication/host | `0bbf4fa2`→`cc69ae38`; `f32923f8`→`5d6546ef`; `bb06db81` copied with native-owner fixes | First compile `native-databases-001.log` failed 3 type errors. After correction, `native-databases-002.log` FAIL24/25; failing `external_type_does_not_reassign_and_external_identity_mismatch_is_preserved` expects settled projection but gets one retained issue. Idempotent `_type` repair correction active. Valid external status/body/unknown-source cases pass in this bounded failed run; not full E18 acceptance. |
| Query/registry | `c8c8fec0`→`1d4d86a9`; `4123b4bd`→`b6c9211f` | Original6 view-source tests PASS in `query-view-sources-002.log`. Followup has10 authored source tests (4 not part of prior 6), one preview guard and two native facade tests unrun at this cutoff. Hidden-sort scope fixed in source. Scoped previews disabled for missing trusted capture authority; saved native queries remain available. |
| View/source model | `fd5cdd91`/`10fb3e33`/`76136398`/`26d69fb2`→`fbacd02f`/`adb5f525`/`5b8c6fa3`/`f5c173f0` | Scoped rename bytes, reverse legacy/explicit isolation and formula references corrected; prior three independent review findings fixed. Stable view IDs support repeated labels. Latest owner receipt86 focused/safety/reference PASS0skip and TS PASS; log `/private/tmp/zorid-view-identity-test-004.log`. External stable-ID deletion followup pending, no actual UI/runtime proof. |
| Managed editor saves | `b49`/`381`/`c3`→`a1a6d3f1`/`bc0ec3d4`/`4dfe6f3e` | P1 checkpoint-overflow correction fixed and independently source-approved. Owner reports 88 and57 focused passes in overlapping sets; do not sum. Native composition/body guard and retry behavior still need final integrated proof. |
| Transport | `61c`/`3ec`/`af5`→`52d8d6d4`/`7f08726f`/`f9921a99` | Independently approved source, owner reports 54,32,14 focused pass sets with overlap; do not sum. Actual admitted desktop lifecycle unverified. |
| Acceptance driver | `d388`/`da04`→`da6a1bab`/`cbc2f5d6` | Independently reviewed 30-command driver, not executed. Field-ID bracket quoting corrected; harness source is not product acceptance. |
| UI | `b952bf81`, `codex/local-database-ui`, clean worker tree; not composed at receipt | Five reviewer findings/template gap source-repaired: exact Duplicate retry, stale setter baseline, default-option clearing/configuration, feasible filter hints, dirty/uncertain schema guards and full literal template body/unmanaged frontmatter with fresh IDs. Full TS PASS. Focused 132-case cutoff is 131PASS/1 stale view-ID oracle failure, then corrected oracle targeted 1/1PASS; not a rerun of the whole set. Logs `/private/tmp/zorid-local-collections-ui-focused.log` and `/private/tmp/zorid-local-collections-ui-stable-id-oracle.log`. Independent `collection_ui_review` auditing exact commit. Root CSS entrypoint wiring pending; multirow writes individually durable, inline picker option-create not implemented (property editor supports it). No visual/native acceptance. |

Rust logs above live under root `tmp/local-databases-20261027/`.
Source branches/worktrees are in the active ownership ledger; short commit prefixes
retain the coordinator's bounded handoff receipt until full identifiers are added.
Root holds the exclusive native/Rust lane in shared `tmp/local-database-target`,
release offline `-j1`; **no parallel heavy builds**. Tracking edits during this
native freeze do not mutate Git/index or product source.

Next: finish the native failing case and pending safety corrections, adapt and run
only affected query/preview/native checks, complete/review UI, freeze exact
composed artifacts, execute the driver and actual local journeys, then send ordered
reviewed batches to the sole main owner. Later source fixes do not retroactively
turn native002 or earlier compile failures into passes.

### P002 — 2026-10-27 — composed source checks; actual acceptance pending

Current source cutoff: root `2d5aa427` plus compatibility-only dirty
`crates/zorid-native-sync/src/error.rs`, exact source `8d0a0b2b`. The compatibility
arm handles the new committed-error variant; it adds no sync feature. Query
catalog followup `a128` is queued but not composed during the Rust freeze. Source
reviewers report no remaining must-fix findings in the currently reviewed core,
native, query and save slices; UI review closed through `410025de` and model review
through `ec4`/`b492`. Later narrow UI/model changes are source-composed but still
need matching actual-app verification. Root goal is active; main remains
`c36c4b0e` under the sole owner `term_d8b43288-7bf1-464c-af5f-b779721982e3`.
No product batch has been integrated to main by root.

| Receipt | Observed terminal outcome / limit |
| --- | --- |
| Store core | **64/64 PASS** across 30 database + 14 host-source-guard tests (`core-composed-databases-005.log`), 10 pinned-state tests (`core-composed-pin-004.log`), 9 migrations (`core-composed-migrations-006.log`) and 1 schema15 accounting test (`core-composed-accounting-007.log`). These exact selected checks pass; no full-suite/app acceptance claim. |
| Earlier core failure | `core-composed-databases-003.log` FAIL 28/30: independently tombstoned member test read an absent live record with `unwrap`, and schema-candidate-limit fixture used an invalid operation ID. Fixture corrections are source-composed (`d9c48f63`); retain original failure separately from later005's 30/30 pass. |
| Native library | **32/32 PASS**, `native-final-001.log`, including the repaired `_type` identity case, valid external value/body/unknown-frontmatter reconciliation and projection/restart cases. This later source run does not rewrite native002's 24/25 failure. |
| Host facade | `host-databases-final-001.log` failed compilation on an unhandled `DatabaseCommitted` error variant; no tests ran. Compatibility successor `host-databases-final-002.log` **4/4 PASS**, including committed-operation errors remaining uncertain. Dirty compatibility source still needs its coherent commit; no new sync capability claimed. |
| Composed JS/source | `composed-source-001.log` **61/61 PASS**, zero skipped; `composed-session-002.log` **5/5 PASS**, zero skipped. These cover canonical-save/checkpoint/transport/setter and source/onboarding/New ownership paths respectively; they are not an actual desktop campaign or an aggregate with earlier overlapping owner sets. |
| CLI | **3/3 PASS**, `cli-databases-final-001.log`, after the CLI compiler completed. Separate phase1 validation has no terminal receipt at this cutoff; no outcome inferred. |
| Query followup | Full query 12, preview 12 and native-query 3 await root's exclusive lane and catalog composition. Source review is not their execution result. |
| UI/model | Current root includes template initialization, creation ownership, ordinary scalar/color handling, externally deleted view recovery, repeated labels and stable-ID New/Duplicate configuration routing (`eb4390a0`→`2d5aa427`). Preserve original 132-case cutoff 131PASS/1 obsolete-oracle failure and later targeted successes separately; no all-green 132 successor campaign claimed. |
| Actual acceptance/artifacts | Matching release artifacts, standalone CLI journey/driver and actual desktop UI/native lifecycle **not yet run** at this cutoff. A01–A14 product acceptance remains open. |

All Rust/composed source logs above are under root
`tmp/local-databases-20261027/`. P001's commit maps and original failure receipts
remain immutable history; this section updates status without duplicating that
map. Root retains the exclusive host/CLI/Rust lane in shared
`tmp/local-database-target`, release offline `-j1`; no parallel heavy builds.
Free disk is about 1.1 GB. The Tauri owner was asked about regenerable-cache cleanup;
root has taken no cleanup action. These tracking file edits do not mutate the
Git/index or frozen product source.

Next: finish CLI, compose catalog and run queued bounded query/preview checks,
freeze matching artifacts and perform actual CLI/UI journeys. Record exact
artifact/source identity, source/platform limits and remaining gaps before the
ordered main-owner handoff. Keep safe scoped-preview unavailability explicit.

### P003 — 2026-10-27 — matched artifacts; actual CLI driver running

Latest source HEAD: `d7a033b7`. User explicitly says **do not work with Tauri;
finish local collections first**. No further Tauri work is authorized by this
pass. Main integration remains with the acknowledged shared-core owner, not root;
actual desktop UI, browser/WASM and final feature acceptance are still open.

| Receipt | Terminal result / bounded evidence |
| --- | --- |
| Query/preview source | `final-query-tests-001.log` **24/24 PASS**, comprising 12 view-source and 12 preview tests. This proves the selected Rust checks, not actual browser rendering or advertised preview readiness. |
| Native query facade | Three selected cases **3/3 PASS**: `final-native-registry-002.log`, `final-native-capture-002.log`, `final-native-deleted-002.log`, one each. Earlier registry001 selected zero tests and is not counted as a passed case. |
| CLI/error compatibility | Earlier CLI 3/3 plus `cli-databases-phase-final-001.log` **1/1 PASS** and `native-error-compat-final-001.log` **2/2 PASS**. Compatibility preserves uncertain committed outcomes without enabling a new sync feature. |
| Native artifact build | **PASS, exit 0**; `final-native-products-001.log` and `final-products-receipt-001.json`. Offline release `-j1`, standalone CLI + desktop host, both arm64 Mach-O. Retained binaries in `products-d7aecf48/`; the receipt contains full hashes, sizes, Cargo/toolchain and dependency/source closure identities. |
| Source match | Artifact receipt starts at `d7aecf4810b41c60edca9deb45993fb8d6cc8005`, tree `351919b5d77039ef50aeca47dd754aca5194b3e9`, and verifies unchanged 486-file Rust/Cargo/proto closure through equivalent Rust HEAD `d7a033b7`. Only `vite.config.mjs` changed during compilation; this is explicitly recorded, not a blanket whole-tree freeze claim. |
| Native frontend | `frontend-native-001.log`: TypeScript + Vite native build **PASS**. Bundler chunk/dynamic-import warnings remain; this build is not native UI or browser/WASM acceptance. |
| Actual CLI driver | **Running**, `/private/tmp/zorid-local-collections-cli-20261027` (owned fixture subdirectory `zorid-local-collections-cli-Q5RQp1` observed). No completed case/count or acceptance inferred from launch. |
| Actual desktop/browser/main | **Open**. No actual UI/browser acceptance or main product merge follows from matched artifacts and library/source checks. |

Logs/receipt/binaries above live under root `tmp/local-databases-20261027/`.
Retain P001/P002 original core/native/host/UI failures and their later bounded
successors exactly as recorded; P003 does not replace them with retroactive PASS.
Root coordinates validation serially. This documentation followup performs file
edits only: no Git mutations, tests, builds or Tauri actions.

Next: inspect actual CLI terminal results, complete normal desktop UI journeys
with matching artifacts and resolve confirmed findings. Record browser readiness
and gaps independently, then prepare the ordered reviewed handoff to the sole main
owner. Scope remains local collections; sync/collaboration stays deferred.

### P004 — 2026-10-27 — actual CLI successor pass; live Electron user test

Current root HEAD `06696a2c` cherry-picks test-only `ab538c71`. The change corrects
strict CLI status expectations to the Native Status decimal-string contract;
it changes no product implementation or binary. Native frontend TypeScript/Vite
PASS and the P003 matched artifact identities remain the relevant build receipts.
Main integration and browser acceptance remain open under their existing owners.

| Receipt | Actual outcome and limits |
| --- | --- |
| Final source review | `collection_ui_review` closed the final narrow delta through `06696a2c`, including stable-ID menu binding, rendered untyped catalog, collection CSS entrypoint and development alias changes. No remaining must-fix findings or source edits pending at this cutoff; this is source review, not UI acceptance. |
| Original actual CLI | `/private/tmp/zorid-local-collections-cli-20261027/zorid-local-collections-cli-Q5RQp1/report.json`: **FAIL**, 29 executed commands/12 passed checks; first six scenarios pass, independent-process-reopen scenario stops at final status assertion `'0' !== 0`. This is retained as the original test-oracle failure, not a product mutation failure or a retroactive pass. |
| Corrected successor CLI | `/private/tmp/zorid-local-collections-cli-20261027-successor/zorid-local-collections-cli-w5e7nO/report.json`: **PASS**, 30 commands/13 checks/all 7 authored scenarios. Executable SHA256 `1556b4b0795b5e268b1ac7184b6adb95fefae2eedbc5ca3c8b959e830337d5d7` matches the retained CLI build receipt. |
| CLI covered scope | Independent collection ownership; readable note/schema projection; per-view sources and hidden-member handling; revision/operation retries; identity-preserving renames and same-collection duplicate; collection Trash/collision restore; state reopened by fresh CLI processes. |
| Status contract | Successor retains `pending_projection: "0"` and `pending_outbox: "24"`; both are valid decimal strings. The local outbox contains retained local writes; neither an empty outbox nor remote sync is asserted. Oracle correction stays strict to the contract rather than coercing counts or changing product behavior. |
| CLI exclusions | UI/onboarding/focus, New filter-default synthesis, concurrent local clients, projection interruption/crash, external-edit reconciliation, browser/WASM/mobile and sync/encryption guarantees remain outside this driver. Its pass does not close those acceptance gates. |
| Electron launch | `/private/tmp/zorid-local-collections-desktop-20261027/launch.json`: normal Electron uses disposable `profile`/`vault`, matched host SHA256 `a812e939e6625345688dcdd29d62c9f3f6bd949176e5c410f86aac0da7b864f1`, source revision `d7a033b7`, frontend index SHA256 `ece826995cfb4a24ac76faa2da46ce9f30719a0cc74bcab821368cf969773cf9`. Initial background launch did not persist; the empty launcher was closed before a proper escalated foreground launch. |
| Live session | Successful foreground Electron PID 30213, host PID 30256, unified exec session 79092. Onboarding source choices were observed via CUA. The user is actively interacting with this disposable test window; root holds automation and preserves the active session. No full UI journey, normal quit/reopen or cleanup acceptance is claimed. |

Do not close the user's active test window or infer that holding UI automation
pauses the overall goal. Root continues the local collection task within work
that does not interfere with the user's session. No further Tauri work is part of
this pass. Historical failure receipts and all P001–P003 source limits are retained.
This tracking followup changes documentation only, with no Git, build, test or UI
actions performed by the documentation owner.

Next: collect/resolve the user's actual observations, complete remaining normal
Electron scenarios after their session is finished, and separately establish
browser support/limits. Handoff reviewed commits and exact evidence to the sole
main integration owner; no main product merge or full feature acceptance yet.

Browser artifact followup: `database_transport` owns a serial offline one-job
WASM build using the cached Rust 1.95/bindgen toolchain and separate
`tmp/local-database-wasm-target`. Native compilation is finished. This followup
may write generated artifacts and receipts only; it must preserve native `dist`
and the user's live Electron window. Build outcome remains pending. The browser
adapter currently omits collection capability; ordinary-note/untyped behavior
and collection delivery must be reported separately.

### P005 — 2026-10-27 — datatype correction source finding

The main owner's independent review reports zero documented standards violations
and one P2 spec finding: Select/Status → Number retains the old option ID and
readable label, but the ordinary note property setter compares the label against
the old ID under the new datatype and rejects both correction and clearing,
including after reopen. This violates E11. `local_ui` owns the scoped setter fix
and focused regression in its isolated worktree; `local_core` assists with the
retained-projection contract, and `collection_ui_review` owns independent review.
Entry/schema revision and stale-note guards must remain. No runtime reproduction
or fix acceptance is claimed yet; main integration remains held.

The WASM preflight did **not start compilation**: only 186 MiB free, below the
1.5 GiB prerequisite. Receipt:
`tmp/local-databases-20261027/wasm-build-preflight-lowdisk.json`. Lane released;
no cleanup, source changes or app actions followed. No Tauri work.

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
