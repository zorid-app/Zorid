# Shared document semantics milestone

Accepted by the user on 2026-10-16 after reviewing the proposed split between
headless data semantics and live editor syntax. This is the next shared-core
milestone (roadmap wave4), not a change to the current first-milestone completion
criteria. User explicitly started Stage4 on 2026-10-17. The native and actual browser-WASM corpora pass in an isolated candidate.
Normal desktop and browser backlinks/save integration has executed successfully;
normal search/Base migrations now pass actual browser and rebuilt desktop checks.
The final consumer batch has passed main integration checks and independent
acceptance audit; Stage4 is complete within the accepted scope.

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

## Final integrated evidence (2026-10-17)

Root composed and independently reviewed the final consumer candidate
`701e107f` in `tingkai-c/stage4-integrated-engine`. Initial engine integration was
`426d3a6c`; the remaining search/Base/controller/witness/group/transport batch is
now integrated on main at `2604057b`. Main typecheck exits0 and
92 focused consumer tests pass. Functional source matches the verified candidate;
main retains its newer tracking, instructions and upstream evidence. Independent final audit approves acceptance with the limits below. Main actual
CJS→Rust→CLI regression also passes1/1 (stage4-main-final-actual.log).

| Requirement | Observed evidence | Limits |
| --- | --- | --- |
| Markdown properties/tags/headings/links/tasks and offsets | Native canonical49 plus bounds/value/YAML checks; final actual Chrome worker49/49 +4 malformed requests; downloaded results independently verified against canonical source/ranges/order | Live editor parsing/rendering and source transformations remain TypeScript-owned |
| Revision-aware index/search/backlinks | Portable contracts7, generations15, restore2; actual CLI document3 +metadata4; final native facade7/7 including retained current context, imported external edits and authenticated receive | Derived indexes remain disposable and local |
| Publication/concurrency/moves/deletes/rebuild | Store19 plus discard1; production browser worker/IDB suite including retained edit/move/delete, CAS/rebuild expiry, concurrent publication, worker restart, reload and raw-byte preservation | No large-vault performance claim |
| Base definitions/formulas/filter/sort/group | Final native Base20/20; actual WASM54/54 (30 expression,10 query,7 generation,7 compile),10 malformed/options checks +2 current-entry witness checks | Scoped accepted dialect, not every upstream function; clock/timezone explicit |
| Native facade/desktop transport | Host13/13; actual strict CJS→Rust child→independent CLI retained-generation/current-context fixture1/1 on final codec; error mapping and malformed options do not poison retained pins | Mobile FFI/Swift wiring separately owned |
| Normal Base consumers | Browser Table/Board/List/Cards and desktop Table/Board show typed numeric/string groups, correct date/link labels and current-file context; source-preserving property edit passes save/reload in browser and exact63-byte physical desktop check | No fallback to TS evaluator when shared capability exists; legacy no-capability path retained |
| Normal workspace search/backlinks | Actual browser/desktop shared search finds2 files and navigates saved note; prior actual default desktop/browser backlink updates/navigation/reload pass | Search explicitly labels case-sensitive saved text; no full-text ranking claim |
| Raw source and editor ownership | Parser/index paths read-only; production browser rawBytesPreserved; native import/receive exact-byte/rebuild/no-echo checks; final property edit preserves all bytes except intended color | Does not move source-preserving property/Base transformations into Rust |

Final normal desktop smoke initially failed: explicit `maxSteps:undefined` from
normal Base adapter survived IPC structured cloning and strict CJS admission
correctly rejected it. Reviewed fix `701e107f` omits undefined scalar options at
the shared request builder; defaults and explicit values remain, strict decoder
unchanged. Regression exercises actual factory→structuredClone→CJS capture.
Focused6/6 and typecheck pass, then a fresh desktop renderer build passes actual
Base query/property save/shared search. Test app session59332 exits0 after Cmd-Q.
This failure was resolved before integration; component-only fixtures had missed
this normal caller shape.

Final actual WASM SHA256:
`e65d47a49679d02c6b1974f68d49fe6765cfe88454fbedb5afcf174e4fa903c2`.
Rust source froze at `99464a78`; subsequent changes are UI/codec/request helpers,
so no unchanged Rust rebuild was required. First final native runs caught two
nameless-view fixture compile errors; corrected fixtures, not parser behavior,
and reran successfully. Matching official Rust/Rustdoc1.95, offline locked builds,
job1 and testthreads1 were used.

Evidence under coordinator `tmp/`:

- `stage4-browser-document-final-report.json`, `stage4-browser-document-final-results.json`, `stage4-browser-document-final-verify.log`.
- `stage4-browser-base-final-report.json`, `stage4-browser-base-final-results.json`.
- `stage4-browser-index-actual-pass-summary.json` (selected report fields, not a full exported report).
- `stage4-base-final-native-run2.log`, `stage4-native-context-final-run2.log`, `stage4-host-context-final-run1.log`, `stage4-desktop-context-actual-run2.log`.
- `stage4-browser-normal-final-summary.json`, `stage4-desktop-normal-final-summary.json` (selected actual UI observations; desktop includes independent exact physical bytes).
- `stage4-main-final-typecheck.log`, `stage4-main-final-consumers.log` (92/92).

Earlier parser doctest invocation hit a rustdoc/toolchain mismatch; it is not a
passing full invocation. Earlier broader desktop failures under resource pressure
are not represented as a green whole-repository suite. No speed/memory improvement,
production security or mobile parity is claimed. No raw-file storage/sync format
or authority migration was introduced by this milestone.

## Ownership and subsequent work

Root remains sole main integrator. Completed isolated worker slices: Markdown
contracts/extraction, index generation/native persistence/browser host, Base reuse
and controller, shared search, snapshot current-context/maxSteps, durable edit and
rename witnesses, opaque group identities/presentation, strict codec portability
and independent review. Exact implementation ancestry is retained in the merged
candidate; roadmap records earlier assignments and intermediate failed checks.

Native mobile consumes this same engine and wire contract through its separately
reviewed FFI/Swift/adapter batch. Native-only FFI7523450d actually passes10/10;
combined mobile source f7d78f6d reports240 focused tests/full typecheck, independently
reviewed within scope. Neither proves final engine linkage or phone runtime.
That batch, mobile UI, enrollment, full history/backups/admin, P2P and deferred
stale-editor automatic merging remain separate milestones/future improvements.
