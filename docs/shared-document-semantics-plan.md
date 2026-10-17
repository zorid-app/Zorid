# Shared document semantics milestone

Accepted by the user on 2026-10-16 after reviewing the proposed split between
headless data semantics and live editor syntax. This is the next shared-core
milestone (roadmap wave4), not a change to the current first-milestone completion
criteria. User explicitly started Stage4 on 2026-10-17. The native and actual browser-WASM corpora pass in an isolated candidate.
Normal desktop and browser backlinks/save integration has executed successfully;
search/Base view migration and final main integration remain in progress.

## Timing and dependency gate

The wave3 gate passed; preparation now inventories current behavior, captures
representative fixtures, specifies shared results/diagnostics and reviews API
boundaries. Preserve existing editor-session ownership; migration of its parser,
Base consumers or source-editing paths requires a named owner and shared fixtures.

Start Rust implementation after the current integrated web/Electron/standalone
CLI gate passes: offline/concurrent text convergence, durable-save crash recovery,
physical moves/deletions/external edits, byte-preserving binary sync, authorization
and protocol compatibility, and basic encrypted client restore. This gate is
complete; see `shared-core-milestone-acceptance.md`. Passing new component tests
alone will not establish migrated consumer or cross-platform behavior.
Do not defer the semantics milestone until P2P, full admin/history or native mobile
are finished. Independent infrastructure and shell scaffolding may overlap it.
Native mobile metadata/Base features should consume the shared engine.

## Reuse-first gate

The completed [source reuse assessment](document-semantics-reuse-assessment.md)
is preparation evidence, not dependency adoption or runtime verification. Evaluate
pulldown-cmark/Comrak for Markdown extraction, MDBASE's existing Bases evaluator
for formulas/queries, and SQLite FTS5 for sound search candidate acceleration
before implementing custom equivalents. Document concrete fixture/capability gaps
before choosing a new parser or formula engine.

MDBASE typed Markdown collections and canonical CEL queries are distinct from
its optional Obsidian Bases adapter. The actual Rust implementation is
`callumalpass/mdbase-rs`; it contains a Bases evaluator and hosted record-input
API, but native dependencies and semantic differences prevent assuming a drop-in
browser replacement. Do not substitute CEL for Base expressions or adopt its
storage authority to obtain its evaluator.

Prepare dialect fixtures and package-boundary analysis now. Executable evaluation
and implementation still follow the timing gate above: compare accepted behavior
on native and browser WASM, check licenses/maintenance, source preservation,
resource bounds and measured performance. Intentional improvements to current TS
behavior need explicit fixture decisions. Keep derived indexes disposable and
client-side evaluation consistent with E2EE. Reuse does not transfer ownership of
CodeMirror live syntax or source-preserving editing paths.

## Accepted scope and order

1. **Metadata extraction.** Portable Rust parsing of frontmatter properties,
   tags, headings, links and task records. Return typed results and diagnostics
   tied to stable entry ID/content revision. Define dialect, property typing,
   malformed-input behavior and byte/UTF-16 position conversions using fixtures.
   Task extraction does not implement the deferred calendar/task product.
2. **Derived indexes and queries.** Incremental revision-aware local indexes;
   backlink/link resolution and search APIs available without a UI or network.
   Persist through native/browser host adapters, keep native-only dependencies
   out of the portable engine. Invalidate by entry/content/parser schema version;
   support full rebuild, moves/deletions/external writes and crash recovery.
   Indexes/results are disposable device-local data and are not synchronized.
3. **Base semantics.** Parse Base definitions and expressions; evaluate filters,
   formulas, sorting and grouping over coherent indexed snapshots. Specify null,
   dates/timezones, numeric/string comparisons, case handling, deterministic
   ordering, resource bounds and diagnostics. Built-in behavior must match across
   native and WASM. Resolve any current JavaScript callback extension seams before
   migration; this is not permission to build a speculative plugin runtime.
4. **Consumer integration.** Standalone CLI gets metadata/backlink/search/Base
   query commands using its embedded core. Web/desktop switch one consumer at a
   time through reviewed APIs; retire duplicated semantic implementations only
   after equivalence checks. Existing Base table/card/list/kanban presentation and
   CodeMirror live syntax parsing remain in TypeScript/the web editor.

Raw files remain authoritative. Invalid Markdown, YAML or Base configuration can
still be read, edited, saved and synced; semantic diagnostics do not invalidate
storage. Parser/index failure must never rewrite a file. Preserve unknown fields,
comments, formatting, BOM and line endings in any existing editing path. Moving
source-preserving property/Base edit transformations into Rust requires its own
later design and lossless-edit acceptance; the three accepted categories do not
silently authorize parse-and-reserialize rewrites.

## Verification and ownership

The initial reference inventory is current metadata/properties, Base document,
expression/query modules and their tests. Existing behavior is evidence, not an
instruction to preserve a discovered bug; intentional semantic corrections need
an explicit contract update and the same fixtures for all consumers.

Acceptance requires the same corpus on native Rust and browser WASM, equivalent
CLI/web/desktop query results, invalid/partial syntax handling, Unicode offsets,
index changes after concurrent/external writes, rebuild equivalence and no data
loss or UI stalls. Compare measured extraction/query latency and memory against
the current implementation before claiming a performance improvement. Test actual
consumer integration separately from pure parser/query tests.

One semantics owner coordinates portable types and dialect rules. Independent
workers can prepare Markdown fixtures, Base semantics fixtures and index/query
contracts in parallel; later implementation work uses isolated worktrees and
nonoverlapping ownership. Editor session retains live parsing/rendering ownership.
Heavy builds and integration remain coordinator-serialized on the8GB machine.

## Current evidence and remaining acceptance (2026-10-17)

Reviewed candidate: `tingkai-c/stage4-integrated-engine`, `39a306e7`, isolated
worktree `/Users/ctk/orca/workspaces/Zorid/stage4-integrated-engine`. Runtime
source is integrated on main at `426d3a6c`. Main frontend typecheck and48 focused
tests pass; independent merge audit found no functional source delta beyond
whitespace. Independent final review found no new
source blocker; it also identified remaining normal search/Base consumers and
explicit imported/received-update index evidence. Keep the milestone active.

| Requirement | Observed evidence | Remaining work |
| --- | --- | --- |
| Markdown properties/tags/headings/links/tasks and offsets | Native canonical49 plus bounds/value/YAML checks; actual Chrome worker49/49 +4 malformed request checks; actual downloaded report independently verified | Preserve provenance through main integration |
| Revision-aware index/search/backlinks | Portable contracts7, generations15, restore2 pass; actual CLI document3 +metadata4 pass | Actual six-case native run21944 passes import/receive refresh, old-pin, raw-byte, rebuild and no-echo checks; test integrated ecd52a4f |
| Publication/concurrency/moves/deletes/rebuild | Store19/19 plus changed discard case1/1 pass; actual production browser worker/IDB suite passes including retained edit/move/delete, CAS/rebuild expiry, concurrent publication, worker restart and page reload | Verify integrated composition; no large-vault performance claim |
| Base definitions/formulas/filter/sort/group | Actual WASM51/51 +5 malformed requests; native current query3/3 and graph2/2 pass; actual desktop/CLI query evidence | Normal Base controller still uses TS; migration assigned |
| Native facade/desktop transport | Correctly enrolled facade fixture1/1 passes, previous4 unchanged; host clock3/3; actual CJS→Rust child→independent CLI retained-query fixture1/1 passes | Preserve admission and retained-source guarantees during integration |
| Normal workspace consumers | Desktop actual save/navigation/backlink refresh passes with independent exact42-byte file check; normal browser creates/renames/saves, displays Rust backlinks, navigates Source and restores source after reload | Normal sidebar search migration assigned |
| Raw-source/editor authority | Parser/index paths are read-only; browser production suite rawBytesPreserved=true; desktop exact saved bytes and browser reload persistence observed | Imported/received update regression passes; final migrated-consumer smoke remains |

Evidence files under coordinator `tmp/`: `stage4-browser-document-report.json`,
`stage4-browser-base-report-run2.json`,
`stage4-browser-index-actual-pass-summary.json`,
`stage4-desktop-ui-pass-summary.json`, and matching scoped logs. Browser index
summary retains selected visible report fields rather than a full exported report.
Actual WASM SHA256:
`6c67442d272195269eb2d92e723c3fc8fd92e237c33c9368e046a92134903256`.
Independent review confirmed no portable/WASM source delta from its build source
`d89dbd56` through `39a306e7`; subsequent corrections were host comparison and
fixtures. Desktop audited source likewise remained unchanged after its pass.

A prior parser doctest invocation hit a rustdoc/toolchain mismatch; do not call
that whole invocation successful. Scoped later checks use matching official1.95
RUSTC/RUSTDOC. Existing broader desktop failures under resource pressure are not
represented as a passing full suite. No speed/memory improvement is claimed.
Native mobile hotfix and simulator-only fixture sync are separate work; none of
this establishes mobile parity or production security. See the roadmap for live
ownership, handles and exact commands.

### Remaining assignments after engine integration

- `stage4_native_consumer`: isolated `tingkai-c/stage4-workspace-search`, normal
  sidebar literal search through the optional shared capability; retained-query
  cleanup and honest case-sensitive query UI, legacy fallback only without it.
- `stage4_base_reuse`: isolated `stage4-base-controller`, shared Base result
  projection/controller lifecycle while keeping source-preserving editing and
  presentation; no hidden fallback for unsupported callbacks.
- `stage4_contract_review`: isolated `stage4-base-context-options`, bounded
  currentEntryId/maxSteps transport and snapshot-derived current-record context,
  coordinated with the controller owner; no arbitrary supplied records.
- `stage4_native_index`: test-only29bdb786, independently reviewed and composed
  as80e2416e in the isolated root candidate. Explicit external reconciliation and
  authenticated receive must advance metadata/search/backlinks, preserve raw
  bytes/old pins, rebuild equivalently and avoid authored receive echoes. Actual
  six-case Rust run21944 passed, official1.95/jobs1/testthreads1, compile13.52s +
  tests2.08s. Exact log `tmp/stage4-native-import-receive-run1.log`; test integrated
  mainecd52a4f. No production source change was required.

Root remains sole main integrator. Mobile's separately owned host fixture-sync
slice is not a Stage4 completion condition or proof of production remote sync.
