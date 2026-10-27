# Local collections, types and Base views — implementation tracker

Updated: 2026-10-27. Owner: this discussion's coordinator (`/root`).
State: **verifying — bounded CLI/native/browser passes; P009 presentation gate and main handoff pending**.
Latest authorization: the user explicitly resumed with **"ok start"** on
2026-10-27 after the documentation handoff. Root's built-in goal is active;
this repository tracker remains the cross-session record. Collaboration/sync is
still deferred. This file does not grant main integration ownership or a build
slot; follow the acknowledged owner/resource lane below.

Product authority: [design decisions](../design/types-properties-sync-discussion.md).
Future sync requirements: [roadmap](../roadmap.md#future-collection-collaboration-and-sync).
Repository execution/ownership: [checkpoint](../deferred-product-roadmap.md).
Incoming corrections: [user findings](../user-findings.md).

Latest user scope freeze: **finish the basic local create/edit/filter/delete/
restore/restart flow**, including the already-coded truthful deleted-source Trash
card and working Change source. The final review expanded too far into secondary
edge cases. Finish only the current implemented UI/controller seam and focused
verification, then prepare the clean handoff/integration request. No further
exploratory/secondary edge-case work or new acceptance gates. Broader unexecuted
variants remain honest limits, not blockers to a bounded core-delivery claim.

## Resume checkpoint

| Item | Current state |
| --- | --- |
| Current task | Finish basic local flow and already-coded P009 Trash card/Change source: local_ui owns session/Workspace, view_source_model owns controller source-repair seam; collection_ui_review reviews both. Focused verification then clean handoff; no secondary-edge exploration. |
| Composition branch/worktree | `codex/local-databases` / `.worktrees/local-databases`, main base `c36c4b0e`; current and latest actual-verified HEAD `dd6c0b7f`. P009 successor source/head is pending. |
| Main integration ownership | Shared-core sole owner `term_d8b43288-7bf1-464c-af5f-b779721982e3`; main unchanged `c36c4b0e`. Root terminal `term_4603116b-4cb4-4e5a-b3a5-968bea283161` composes only in isolation. |
| Review/handoff | Main-owner successor review at dd6 reports Standards 0/Spec 0. Integration still awaits clean final branch/evidence and root's explicit integration request to the sole main owner; review is not completed integration. |
| Source checks | Root 52/52 targeted + full TS + native frontend005 PASS. Earlier native/core/query/WASM/transport receipts retain exact source/scope; never add overlapping runs together. |
| Actual CLI | P004 successor PASS 30 commands/13 checks/all 7 scenarios, with explicit exclusions. Native P2 contract separately PASS 12 commands/8 checks. |
| Actual normal native | P008 PASS bounded: recovered managed controls/hidden IDs/declared null Date; managed8→9 and ordinary rating 4→5 clean acknowledgement; normal quit/reopen values 9/5/null and exact bodies. Typed filter/New/edit-out and collection Trash/Restore also pass; expected deleted-source card presentation remains P009. |
| Actual browser | P007 fresh-origin untyped browsing/filter/sort/New/edit-out/reload PASS bounded; browser collection capability remains unavailable. No recovered-note or full platform parity inferred. |
| Test-app lifecycle | All foreground sessions through 51898 normal exit 0 observed. No live owned test app. Normal source-mode Electron with retained matched host was tested, not an installed production package; production app/real vault untouched. |
| Next action | Finish/review P009, validate affected scenarios on its exact source and normal test app, then prepare final source/receipt handoff and explicit integration request to sole main owner. |
| Remaining limits | P009 source/results pending; browser collection CRUD, concurrent local clients, actual crash/interruption, broader filter/layout/visual/keyboard matrices, installed package and mobile/other OS acceptance are not claimed. Scoped indexing previews remain a safe capability gap. |
| Resource/scope | Serial bounded validation; no overlapping heavy builds or worker Git mutations. Local collections first; no Tauri or new sync work. |

P008 evidence: `/private/tmp/zorid-local-collections-desktop-20261027/desktop-acceptance-002.json`
and `restored-final-data.json` in the same directory. Root source `dd6c0b7f` is
reviewed and bounded-runtime verified; P009 final source and evidence remain
pending. Preserve P006/P007 failed actual receipts and their before-fix red tests.
No product/main integration or installed-package acceptance is inferred.

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
| L0 Contracts and current-code audit | Stable identity/source/ownership/storage/publication contracts used by this local slice. | Current main/owner audited | Reviewed/composed / root + source reviewers | Isolated root only; main pending | Bounded flows verified; unsupported capabilities listed |
| L1 Local domain/storage | Stable schemas, typed values, membership, revision guards and durable retry without new sync enrollment. | L0 | Reviewed/composed / local_core | Isolated root only; main pending | Store64 selected checks + P004 CLI ownership/retry/rename/reopen PASS; broader concurrent/crash variants unrun |
| L2 Projection/editor saves | Readable schema/frontmatter, exact bodies, guarded composition and recovered-note UI. | L0–L1 | Reviewed/composed through dd6; P006 and false postrefresh successor approved / native + saves | Isolated root only; main pending | Native source checks + P005/P008 actual correction/restart/managed and ordinary saves PASS bounded; actual crash/external-edit matrix open |
| L3 Per-view sources/registry retirement | Trusted one-source queries, hidden metadata catalogs, no global Properties.yaml authority. | L0–L2 | Reviewed/composed / query + model + transport | Isolated root only; main pending | Query24/native facade3 source checks PASS; native typed filter and browser untyped catalogs PASS; scoped previews/browser collections unavailable |
| L4 Onboarding/browsing | Create/select collection and untyped view flows, collection browsing. | L3 | Reviewed/composed / local_ui | Isolated root only; main pending | Normal native Tasks onboarding and collection browser + actual browser untyped onboarding PASS; all source/layout combinations not claimed |
| L5 Editing/New | Property controls, templates, automatic New hints, clean acknowledgement and edit-out preservation. | L1–L4 | Reviewed/composed / UI + model + saves | Isolated root only; main pending | P008 native Status 9 New inherits 9 then0 hides with editor/file retained; ordinary4→5 and managed8→9 PASS. Browser rating 4 New/edit 2 PASS; other hint/layout/keyboard variants source-only or unrun |
| L6 Deletion/recovery/edges | Schema conversion, identity, hidden members, Trash/Restore and deleted-source state. | L1–L5 | Data paths reviewed/composed; P009 presentation source pending / UI + reviewers | Isolated root only; main pending | P004 CLI + P005/P008 native data paths PASS bounded, exact 3IDs/9-null-0/bodies restored. P009 expected-state card/retry proof pending; broader edge matrix open |
| L7 Review/integration/delivery | Final scoped review, artifacts, actual checks and ordered sole-owner integration. | P009 + final clean branch/evidence | dd6 owner review Standards 0/Spec 0; final successor pending | Main c36c4b0e unchanged; explicit integration request pending | CLI/native/browser bounded receipts retained; installed production package/other platforms not claimed |

L7 review/integration can run alongside independent bounded source work once a
batch is ready. Keep shared API changes coordinated and heavy compilation/native
verification serialized on the 8 GB machine. Follow the standing resource rules;
iOS requires its own explicit validation slot and is not this pass's scope.

## Acceptance matrix

Each row states its actual evidence layer: isolated source checks, independent
CLI, normal source-mode Electron or normal browser. All main integration remains
pending. Bounded passes do not establish unexecuted variants or other platforms.
Retain exact source/artifact identities in the pass receipts; reference-only
observations are not product test passes. Use focused safety tests and ordinary journeys;
repeat passed scenarios only after relevant changes or unresolved failures.

| Case | Scenario / oracle | Evidence layer and remaining limits |
| --- | --- | --- |
| A01 Sources/onboarding | Independent typed/untyped view configuration and reopen. | Source-model/query checks PASS; native Tasks onboarding + browser untyped onboarding observed PASS. One Base with Books/Projects/untyped after reopen and every layout/source combination not separately exercised. |
| A02 Untyped browsing | File-only presentation with hidden metadata filters/sort, no user-property editing grid. | Actual fresh-origin normal browser PASS: file-only table, rating/tags catalogs, filter/sort/reload; collection capability explicitly unavailable. Broad visual/accessibility/performance matrix unrun. |
| A03 Ownership | Independent collection field identities and creation-only membership. | P004 actual CLI ownership PASS, typed normal-app collection flows PASS; source denies import/move/detach. Concurrent local clients or every API mutation variant not claimed. |
| A04 Immediate New | No questions/blocking; feasible filter-derived values. | Native Status=9 New inherits 9 and browser rating=4 New inherits 4 PASS. OR/range/impossible/general-template precedence not established by actual app receipts; focused source evidence retained separately. |
| A05 Edit out of filter | Successful save hides row while retaining entry/open editor; preserve failures. | P008 native new9→0 hides while file/popover/body remain; browser new4→2 similarly PASS. P006/false postrefresh failure history preserved and dd6 successor clean saves PASS; broader fault injections unrun. |
| A06 Shared entry | Same entry reflected in views/note editor without lost body writes. | P008 normal managed setter+typed view/filter and exact body persistence PASS bounded. Concurrent split/linked placements/independent clients are not an actual-runtime acceptance claim. |
| A07 Untyped New | Ordinary note, automatic feasible hints, no collection assigned. | Browser New inherits 4 immediately, edit 2 hides without deleting note; filter/sort persistence PASS. Broader folder destinations/default/filter combinations unrun. |
| A08 Identity/rename/duplicate | Stable schema/member identities and safe duplicate/copy handling. | P004 actual CLI rename/duplicate PASS; P008 native Restore exact 3 original IDs PASS. External copies/missing IDs/folder-move variants retain source-level checks or remain unexecuted. |
| A09 Schema changes | Preserve incompatible values until explicit correction/clear, no silent reinterpretation. | P005/P008 normal native Status→Number preserved labels then7/null correction and later9 clean save PASS, bodies intact. Full datatype/option-delete/recovery matrix not run. |
| A10 Delete/restore | Delete collection includes hidden members; preserve unrelated data and restore identities. | P004 CLI collision restore PASS; P008 native collection 3 vs filtered 1, Trash removes all 3 (2 hidden), Base/ordinary/other collection retained, Restore exact 3IDs/9-null-0/bodies and filtered 1 PASS. P009 presentation and uncertain action-rerender retry proof pending. |
| A11 Publication crash | Restart resumes guarded projection without stale overwrite. | Selected Store/native safety source tests PASS. Normal quit/reopen actual data/control persistence PASS; forced actual app crash/interruption and external-writer matrix are not exercised by CLI/UI receipts. |
| A12 Registry removal | No vault-global Properties.yaml authority or automatic registry workflow. | Reviewed Rust/TS source retirement + query tests PASS; actual untyped browser has no property/grid/settings flow. No destructive migration/deletion of existing user registry files claimed. |
| A13 Independent clients | Independent CLI, normal editor, browser support recorded separately. | P004 actual standalone CLI 30/13/all 7 PASS and P005 native contract 12/8 PASS; normal source Electron P008 functional pass bounded. Concurrent local clients unrun; browser untyped only, collections unavailable. |
| A14 Product lifecycle | Matching normal app flows and explicit artifact/platform scope. | P008 normal source-mode Electron startup/clean saves/quit/reopen PASS; all foreground sessions through 51898 close exit 0. Not an installed production-package, full visual/keyboard/mobile/other OS parity claim. |
| A15 Deleted-source presentation/retry | Authoritative tombstone card with Restore/Change source, real failures retained and original action identity preserved. | OPEN P009: data Trash/Restore works, but duplicate generic error/repair-source presentation remains. Two-file source fix and exact uncertain Restore retry through rerender need review/check/actual proof. |

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

Native P2 contract acceptance: **12/12 independent CLI commands, 8/8 checks
PASS**, `/private/tmp/zorid-local-p2-native-20261027-ToE2hE/report.json`.
The matched CLI preserved the readable label and original option ID/problem
after conversion/restart; composition returned the canonical label and exact
file/member/schema revisions. Numeric correction and null clearing on separate
entries removed preservation and published across restart, retaining body and
unmanaged data exactly. All owned processes exited zero with observed closure.
This validates the native contract, not the Workspace setter or actual desktop
interaction. No Rust/source changes or builds were needed for this run.

P2 UI successor `fc72f099` → root `7a810bb5` is composed and independently
reviewed with no must-fix findings. Composed focused tests **10/10 PASS**
(`preserved-properties-composed-002.log`), full TypeScript and native frontend
build **PASS** (`frontend-native-002.log`). The first local test-launch attempt
used an unavailable `tsx` executable and ran no tests; the successor uses the
repository's normal `node --test` path.

Actual normal Electron P2 interaction **PASS, bounded**: UI-created Tasks
collection, two authored entries, Status → Number schema change, ordinary note
reopen with retained label/warning, numeric `7` correction and explicit null
clear both work and remove warnings. Bodies remain exact. Normal quit/reopen and
independent YAML parsing confirm persisted values/body. Receipt:
`/private/tmp/zorid-local-collections-desktop-20261027/p2-ui-observations.json`.
The owned test app was quit normally; all three foreground exec sessions exited
zero. This closes the reported P2 interaction, not full feature acceptance.

### P006 — 2026-10-27 — managed note controls after app restart

Actual restart observation: the corrected/cleared entries reopen with persisted
values and bodies, but show generic frontmatter controls including `_id`/`_type`
and inferred JSON null fields, rather than managed collection schema controls.
The state persists across observations and switching notes; a Base embed still
shows its two collection entries. `managed_editor_saves` owns read-only lifecycle
diagnosis first. Cause and fix are not yet established; never infer membership
from readable `_type`. Full desktop acceptance/main integration remain held.
See the P2 UI receipt for exact observations and input/automation caveats.

Resource followup: only this pass's owned
`tmp/local-database-target/release/{deps,build,.fingerprint,incremental,examples}`
were retired after idle process/open-file checks. **1.17 GiB freed**, with all
4,258 protected source/evidence/binary hashes unchanged; both retained executable
copies link only system `libiconv`/`libSystem`, not deleted caches. Receipt:
`tmp/local-databases-20261027/cleanup-cache-receipt-001.json`. No other owner's
cache or source was touched; no process interrupted. `database_transport` now
owns the serial offline one-job WASM build in a separate target, log
`wasm-build-002.log`; compilation is underway, not accepted. Native test app
diagnostic session 35077 also quit normally with exit zero; no app remains from
this pass.

### P007 — 2026-10-27 — native retest fails; source cause and bounded browser pass

Current source `73fa41c9` composes `e37c31b6`, the coherent durable-target fallback.
Its owner 24/24 and root-combined 34/34 checks PASS; full TypeScript and native
frontend003 PASS; independent source review closed. This fixes a valid separate
missing-target-identity bug. It did **not** close the original actual P006 gate.
P005's retained-datatype correction pass and P006 resource followup stay intact.

| Scope | Current observation / gate |
| --- | --- |
| Actual native P006 retest | **FAIL** at 73fa41c9: ordinary collection notes still use generic identity/null controls. A normal property edit reaches the earlier Workspace guard and fails "property note was replaced or removed" before target lookup. Do not reclassify the 34-source-pass set as native acceptance. |
| Confirmed source diagnosis | Independent `managed_editor_saves` and `local_ui` audits agree: `recoverDurableBuffers` restores checkpoint buffers without `bufferEntries` WeakMap entries; `replaceVault` clears `entryTokens` and adopts the recovered map; cached `bufferFor` only loads/returns. The captured file token remains undefined and `propertyCurrent` stays false. This evidence supersedes the earlier startup hypothesis, but runtime closure still requires the corrected actual route. |
| Fix successor | `managed_editor_saves` candidate `4daa7e2b` is independently reviewed CLOSED with no must-fix, composed as root `d02246e2`. Recovered-only eligibility WeakSet first-binds after coherent saved ID/path/revision; old tokens never rebind. Genuine startup cases were red 0/4. Worker 44/44 + final 13/13 sets pass with overlap; root 47/TS/frontend004 running (session 78982), actual corrected startup not yet tested. |
| Failed-session state / cleanup | At the failed 73fa41c9 retest, session 58193/PID 89085/host 89129 had verification draft 78 while saved 7 stayed unchanged. After user testing finished, Escape reset that owned failed input to 7 and cleared the error; normal quit exit 0 observed. No live test app. New corrected startup/property-edit/managed-setter proof awaits build and is not accepted yet. |
| WASM002 artifact | **PASS**, offline release one job, 3m26s. Receipt root `tmp/local-databases-20261027/wasm-build-002-receipt.json`: source HEAD 5970b95f before/after, 454 build inputs unchanged, fingerprint `8a12906380adf9216eae7bebf1d5bde87031a33e5084dddc3ff381428533e171`. Generated JS 204236 bytes/WASM 12418996 bytes hashes match build metadata. Current 73fa41c9 changes are TS-only relative to that Rust closure. Artifact build is not browser collection delivery. |
| Actual browser interaction | **PASS, bounded**, CUA normal app on fresh unique origin `http://local-collections-20261027-a8f2.localhost:5173/`, empty browser vault, no fixture mode/injected mutations/user file picker. Receipt root `tmp/local-databases-20261027/browser-ui-observations-001.json`, source 73fa41c9, WASM002 receipt linked. |
| Browser covered flow | Created ordinary note with rating 4/tags idea/body; created Base and chose untyped source. Table file-only: no property columns/add-property/group controls. Metadata catalog supplies rating/tags; rating=4 filters; New immediately inherits 4/matches; edit New to 2 hides row while popover/file remain. Reload preserves filter. Rating-ascending sort after removing filter shows 2 then 4, still file-only, and survives reload. Collection choice explicitly unavailable; Cancel leaves untyped view unchanged. |
| Browser limits | Collection capability remains intentionally unsupported. Fresh-origin untyped pass does not cover editing a recovered checkpoint note after restart or close native P006; no collection CRUD, full visual/accessibility/performance/mobile/sync parity claim. |
| Browser cleanup | Agent-created tab 1268047994 closed. Vite PID 92227 ownership verified by command/cwd, SIGTERM requested and exit 143 observed (exec 97354). User browser tabs untouched; isolated test storage retained. |
| Owned-cache cleanup | Prior pass-owned release cache cleanup freed 1.17 GiB with 4,258 protected source/evidence/binary hashes unchanged; root `tmp/local-databases-20261027/cleanup-cache-receipt-001.json`. Only named local-collection caches, not Tauri or other-owner caches; no process interrupted. This enabled the successor WASM build, without erasing the earlier low-space preflight result. |

Native P006/full feature/main integration remain **held**. Goal remains active;
the old app has quit normally and no live test session remains. No Git/source/
build/UI mutation is performed by this documentation update. Root 47/TS/frontend004
are running; after terminal results, corrected actual startup/property edit and
managed-setter proof become P008. The browser pass, fallback and first-bind source
review are separately bounded results, not substitutes for that actual gate.
No Tauri work; main owner unchanged.

### P008 — 2026-10-27 — recovered controls and clean saves; bounded native pass

Current root `dd6c0b7f` composes the postcommit-refresh successor. Main-owner
successor review relayed by the user: **Standards 0/Spec 0**, independently closed
for this source. Root **52/52** targeted tests + full TS + native frontend005
PASS (`recovered-refresh-composed-001.log`, `frontend-native-005.log`). These are
not additive with the worker's overlapping 52. Actual normal source-mode Electron
now closes P006 and the false-postcommit-refresh symptom within the scope below;
it is not an installed production package or universal feature acceptance.

| Normal native observation | Actual result |
| --- | --- |
| Recovered checkpoint startup | Managed collection schema/declared Date null controls restored, `_id`/`_type` hidden; values/body loaded correctly. P006's earlier generic-control failures remain historical failed receipts. |
| Clean property acknowledgement | Managed 8→9 and ordinary recovered rating 4→5 save/ack cleanly, no false ancillary-refresh error. Normal quit/reopen verifies 9/5/null and exact bodies, controls still managed. |
| Typed filtered New/edit-out | Status 9 filters two collection entries to one; New immediately inherits 9 and matches, no questions. Named Filtered entry/body authored; changing 9→0 saves/hides row while popover/editor/file/body stay. |
| Collection Trash/Restore | Collection browser lists 3 while Base shows 1. Delete confirms all 3; removes all three physical member files including 2 hidden members, preserving Base/ordinary/other collection. Restore returns exact 3 IDs/values 9-null-0/bodies and the filtered 1 result. |
| Readback/cleanup | `desktop-acceptance-002.json` and `restored-final-data.json` under `/private/tmp/zorid-local-collections-desktop-20261027/`; readback explicitly PASS. Foreground sessions 14374/51898 (and all earlier listed sessions) normal quit exit 0; no live owned test app. Production app/real vault untouched. |
| Remaining finding | P009 expected-deleted-source presentation: generic duplicate Durable editor error and Edit Base source repair hint appear alongside working Restore. Data restore passes; presentation is still open. |

Native frontend005 index SHA256 is
`d24a867b67348bb03b8b4d687eea890581bf35cd505062d13a509003eb4adc32`;
the receipt references the retained native products receipt separately. The actual
receipt limits exclude full native visual/keyboard/mobile/reference parity and
browser collection delivery. The prior CLI/untyped browser results remain their
own bounded passes; no blanket multi-platform acceptance or main merge follows.

### P009 — pending — expected deleted-source presentation and retry ownership

Ownership: `local_ui` owns `src/bases/session.ts` and `src/ui/workspace.ts`
Trash card/Restore retry presentation; `view_source_model` owns the isolated
`src/bases/controller.ts` + focused tests source-repair seam, aligned to dd6.
`collection_ui_review` reviews both. Latest actual-verified code HEAD remains
`dd6c0b7f`; current model/UI source seams are implemented in isolation, awaiting
focused seam verification/composition and final handoff receipts, not acceptance.

Essential core-flow finding: Change source was blocked by
`controller.guard(current.error)`, while error refresh retained stale/initial-empty
source and made fresh deleted-source classification unreliable. The implemented
controller seam must retain coherent latest valid parsed `readDefinition` source,
witness and epoch, with narrow source-repair admission. Existing CAS/version,
identity, stale-draft, preview and property-write protections remain effective.
The UI owner reports nine focused cases + TS PASS; the controller dependency and
combined result remain pending. Do not mark Change source delivered from card
rendering or UI-only checks alone.

User scope freeze applies here: finish this already-coded truthful Trash card/
working Change source and basic create/edit/filter/delete/restore/restart only.
No additional exploratory edge cases, broader matrix gates or secondary polish
work before the clean bounded-delivery handoff. Untested variants stay limits.

For a fresh authoritative collection tombstone, show a typed Trash/deleted-source
card with Restore and Change source. Do not manufacture query success or replace
real active-source/configuration/get/action failures with a happy empty state.
Remove the generic repair-source hint/duplicate raw error only for that known
expected state. Restore must retain the exact captured command/operation identity
through rerender and uncertain retry, rather than authoring a new Restore request.

This is the final already-coded core-flow repair, not a new storage-failure
claim or permission to expand secondary edge-case work. Root awaits its source/review/results before final handoff. Main remains
`c36c4b0e` with sole shared-core owner; latest source review has passed but an
**root's explicit integration request to that owner**, clean final branch and evidence are still needed.

Final handoff fields (fill from actual P009 receipts, not a plan):

- Final code HEAD / source closure: **pending P009**; last bounded actual HEAD dd6c0b7f.
- P009 worker commit / root composition / exact review: **pending**.
- Final frontend/native/WASM artifact identities and actual followup: **pending**;
  reuse earlier receipts only where their closure still matches.
- Main integration request / owner acknowledgement / resulting main commit:
  **pending; no product merge claimed**.
- Retained limits: browser collections unsupported; scoped indexing previews
  unavailable; concurrent-client/crash/broader layout/filter/visual/keyboard and
  installed production-package/mobile/other OS acceptance not claimed.

Documentation followup only: no source edits, Git mutations, tests/builds, UI or
Tauri actions by the documentation owner. Preserve P001–P007 failures and source
limits; P008 bounded success does not rewrite earlier failed gates.

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
