# Shared document semantics milestone

Accepted by the user on 2026-10-16 after reviewing the proposed split between
headless data semantics and live editor syntax. This is the next shared-core
milestone (roadmap wave4), not a change to the current first-milestone completion
criteria. User explicitly started Stage4 on 2026-10-17. Contract/corpus work is
active. The first native Rust metadata/Base corpus runs pass in an isolated
candidate; browser-WASM parity and consumer migration remain in progress.

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

Runtime source is composed in the isolated `stage4-integrated-engine` worktree,
branch `tingkai-c/stage4-integrated-engine`, currently `d89dbd56`. Stage4 runtime
source has not been promoted to main. Main documentation is the cross-session
record; native mobile has the exclusive heavy build slot until explicit release.

| Requirement | Observed evidence | Still required |
| --- | --- | --- |
| Markdown properties/tags/headings/links/tasks and exact offsets | Native canonical49-case corpus, value/budget/YAML cases pass; raw-source authority retained | Execute same current corpus through generated WASM, malformed transport/Unicode checks, retain actual reports |
| Revision-aware disposable index/search/backlinks | Native portable contracts7, generations14, metadata-restore2 passed at e8615ecb | Recheck subsequent controlled graph callbacks; actual CLI and browser durable persistence/query execution |
| Cache publication, concurrency, move/delete and rebuild safety | Store19/19 pass; later changed published-discard preservation case1/1 passes | Execute browser production-worker/IDB acceptance including restart, source races, retained queries and rebuild expiry |
| Base definitions/formulas/filter/sort/group | Native30 accepted expressions and10 queries passed; corrected generation graph corpus2/2 passes | Current full query/controlled-resource checks, actual WASM same fixtures, equivalent CLI/web/desktop results |
| Native facade | Current build compiles;4/5 cases pass | Corrected enrolled fixture8619664e passes1/1; remaining four cases passed previous run; original failure never authorized bypassing enrollment |
| Normal workspace consumer | Shared backlink hook9f259800; real Workspace/NoteBuffer with controlled adapter/service passes4/4 save/navigation/lifecycle regressions | Actual normal desktop/browser app queries through Rust transports and user-visible rendering |
| Host/default contract consistency | Shared/frontend and direct-browser clock/row defaults aligned; desktop omitted-clock correction04b7d111 composed | Host clock3/3 and real admitted CJS/Rust-child fixture pass; browser parity and normal app execution still required |
| No source rewriting or editing regression | Parser/index paths remain read-only; Store preservation tests pass | Integrated app verification with raw-file comparisons, durable edits and generation refresh |

The controlled workspace tests prove navigation/cleanup behavior, not browser,
native visual, or transport parity. Source-approved browser harnesses and WASM
wrappers are not executed evidence. Existing TypeScript Base presentation and
CodeMirror live syntax remain owned by the editor; this milestone migrates
consumers incrementally and must not silently replace editing transformations.
No performance improvement is claimed without measurements. Keep the full
objective active until the remaining acceptance above is actually verified.
Exact process handles, logs, source corrections and mobile coordination remain
in `deferred-product-roadmap.md`.
