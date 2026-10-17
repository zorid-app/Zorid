# Stage4 derived index and query contract proposal

Prepared 2026-10-17 by `/root/streaming_acceptance_sol` from main `f69dc90`.
Owner: this document only. Branch `tingkai-c/stage4-index-contract`, Orca worktree
`/Users/ctk/orca/workspaces/Zorid/stage4-index-contract`. Root owns the shared
semantic API and contract freeze. Metadata/parser and Base workers own their
respective result semantics; the new mobile session owns native shell/bindings.
Root froze the initial rules below on2026-10-17. A portable resolver/identity
slice is now assigned in `crates/zorid-index/**`; metadata-dependent generation
planning waits for the shared document public types. No builds, runtime or
performance claim; native/store/host/CLI remain unassigned to this worker.

Depends on [the accepted milestone](shared-document-semantics-plan.md) and
[source reuse assessment](document-semantics-reuse-assessment.md). Wave3 passed;
the plan's older timing paragraph saying that gate is incomplete is historical.
This proposal does not select a Markdown dialect, Base evaluator or FTS package.

## Existing seams and limitations

| Source | Observed behavior relevant to indexing |
| --- | --- |
| `crates/zorid-store/src/presentation.rs` | `ListingSnapshot` is an active-entry inventory plus local decimal cursor in one SQLite transaction. `LocalChange` has stable IDs, opaque revisions, tombstones, origin and `requires_full_reload`. `changes_after` enforces contiguous local cursors, at most1000 events/1MiB, and explicit reload on gaps/ahead/oversized records. Events contain no bodies. |
| `crates/zorid-native/src/native.rs` | Exposes `list_snapshot`, `changes_after`, coherent per-entry `read_presented`/`read_path`. Separate invocations are not a cross-file snapshot. Native roots/storage identity must remain verified. |
| `crates/zorid-store/src/family_store.rs`, `content.rs`, `entry_content.rs` | Current schema11 distinguishes metadata, Text and retained Binary sources. Semantic work must read committed authority; filesystem projection can lag. Binary must not be coerced into Markdown. |
| `src/core/browser-streaming-vault.ts` | Current format7 stores stable `metadata.id`, opaque `revision`, `control.sequence`, local/sync/binary journal entries. `snapshot()` captures inventory/sequence transactionally. `changesSince()` verifies contiguity but loads all journal rows, returns paths for content-only changes and omits paths for structural reload; it is not a bounded ID/revision semantic feed. |
| `src/core/browser-normalized-idb.ts`, `browser-sync-streaming.ts` | IndexedDB owns normalized source records and publication; no browser SQLite authority exists. Keep derived rows outside authored envelopes and sync store exports. |
| `src/platform/browser-core-runtime.ts`, `browser-core-worker.ts` | Worker/core boundary has metadata and committed entry reads; semantic calls belong beside these admitted methods, not in a renderer with database access. |
| `src/core/types.ts`, `vault.ts` | `VaultEntry.entryId/revision` are optional for legacy adapters. Admitted durable roots must supply both for shared semantics. Vault currently rebuilds/updates TS `MetadataCache` and path-keyed content on refresh/save. |
| `src/core/metadata.ts` | `MetadataCache` keys notes by path, maintains file/name lookup and resolves links/backlinks against its current mutable inventory. `indexBatch` parses before publishing, but has no persistent cursor or source-revision contract. Link extraction/resolution policy remains root/parser-owned. |
| `src/ui/workspace.ts` | `search()` scans `.md` files with locale-lowercase path/line substring matching and a UI cancellation generation. Right pane uses `metadata.backlinks`, headings and tags. Several rendering/completion paths intentionally read dirty editor buffers. |
| `crates/zorid-cli/src/search.rs` | Headless search is bounded case-sensitive literal UTF-8 line matching, includes unknown text extensions, excludes invalid UTF-8/NUL. Output explicitly says `committed_per_entry`; it does not claim one coherent cross-file revision. |
| `src/search/query.ts` | Rich query parser/evaluator exists; current production workspace search does not call it (observed references are its module and tests). Its regex/property/scope semantics must not silently be replaced by FTS syntax. |
| `src/bases/controller.ts`, `query.ts` | Controller builds rows from Vault/metadata. `BaseQuerySnapshot` already accepts caller-owned version/files without IO. Base worker owns evaluation; this proposal supplies one coherent row snapshot, not formula rules. |

Local journal sequence, remote relay cursor, source revision, parser version and
index generation are different values. Never compare revisions as timestamps,
reuse a remote cursor as the local watermark, or turn an index miss into deletion.

## Small first slice and portable boundary

Implement a portable semantic-index module/crate after root freeze. It depends on
shared identity/result types, not rusqlite, filesystem, IDB, Tokio, a wall clock or
network. Native host and browser worker feed owned committed witnesses and apply
pure plans; parsing is supplied by the metadata engine, not duplicated here.
Start single-worker, bounded batches; separate parallelism is not needed yet.

Proposed logical operations (names are illustrative, root freezes actual types):

```text
capture_manifest() -> {local_store_id, source_watermark, complete inventory}
read_committed(expected: {entry_id, entry_revision, path, kind})
  -> exact {witness, bytes/content_descriptor} | stale | missing | unreadable
plan_batch(index_head, manifest, parsed_records, budget) -> DerivedBatch
publish(expected_index_head, expected_source_watermark, batch)
  -> Published(snapshot_id) | SourceChanged | IndexChanged
index_status() -> {active_snapshot?, observed_source_head, covered_watermark,
                   parser_version, resolver_version, pending, diagnostics}
open_snapshot(requested_id?) -> IndexSnapshot
search(snapshot, LiteralSearchV1, page_budget) -> QueryPage
backlinks(snapshot, target_entry_id, page_budget) -> QueryPage
resolve_links(snapshot, source_entry_id, raw_target, kind) -> ordered candidates
rebuild(new_versions, budget) -> progress; discard_derived() -> rebuild_needed
```

Persist identities as `{local_store_id, generation}`. A generation describes a
complete immutable manifest at one local watermark and parser/resolver/schema
version tuple. Per-entry records carry ID, opaque entry revision, exact path,
content digest/mode, extraction version, metadata/diagnostics and source spans.
Content digest permits parse reuse after a pure move; it is not authority to
skip ID/revision/path checks. Presentation fields used by Base queries must also
come from that captured generation; mtime changes without content edits still
invalidate the affected record. No reusable secret, draft, operation receipt or
source content exists *only* in a derived cache.

For bounded literal search, generation rows may retain authorized committed text
as a disposable local projection. Page it from the adapter; do not load a vault
of bodies into WASM memory. This keeps exact evaluation/snippets on the indexed
revision even after authority changes. Never read today's source bytes and label
the match as yesterday's indexed snapshot. If the text projection is unavailable,
return explicit incomplete/rebuild-needed rather than an invented empty match.
Binary/nontext rows have inventory presence but no Markdown extraction.

## Coherent publication, stale work and rebuild

1. Capture authoritative complete inventory and local watermark H. Use journal
   deltas to identify changed IDs relative to the active generation; on gap,
   full-reload event, cache loss or parser/resolver/schema change, rebuild from
   the complete authoritative inventory. A complete DB inventory does not claim
   an unfinished external filesystem scan has discovered every physical file.
2. Read bounded changed documents by ID and the exact captured revision/path.
   Parsing happens outside source write transactions. Validate returned identity,
   mode and exact bytes; a concurrent move/write/delete means stale work, not a
   parser failure and never permission to use an unrelated current revision.
3. Stage an immutable generation, reusing unchanged rows. Publish its manifest,
   entry/link/text rows and covered watermark atomically only if the source head
   is still H and expected index head/version still matches. Source-head check
   and index-head publication must share the storage transaction. Readers see
   either the old complete generation or the new complete generation.
4. If either CAS fails, discard/rebase only inert derived staging and schedule
   bounded catch-up from current authority. Never advance watermark past an
   unprocessed row. Do not roll back source writes or hold their locks while
   parsing, querying, waiting for workers or doing IO/network.
5. On restart, retain the last complete generation; abandoned stages can be
   discarded. Missing derived rows or invalid derived payloads cause rebuild, not core repair.
   Physical authority-database corruption still follows the existing fail-closed
   core path; never drop or ignore it as though only a cache were damaged.
   Parser-version mismatch cannot serve as a current-version result. There is
   no compatibility migration obligation for disposable old index formats.

These optimistic guards deliberately avoid adding historical-source reads in the
first slice. Under sustained writes, retry with a finite budget and serve the
last coherent snapshot with explicit lag, or return `index_not_ready` if none.
Do not silently promote a mixed revision set to a coherent source snapshot.
A host may later provide immutable exact source snapshot references without
changing portable query semantics. This is not a new daemon or sync protocol.

Delete removes active rows by stable ID only after committed authoritative
namespace evidence. Folder moves update every affected inventory path and link
resolution namespace; source move/replacement and delete/recreate cannot inherit
an old row merely because paths match. Stale in-flight results cannot resurrect
tombstones. External imports and remote receives follow the same committed
journal as local writes; projections/scanner callbacks are wake hints only.

Keep raw outbound links attached to their source witness. Resolve against the
query generation's complete inventory, so target create/move/delete and source
folder moves invalidate resolution without reparsing unrelated bodies. Frozen resolver rules preserve explicit-relative lookup priority, root-exact
lookup, `.md` fallback and NFC followed by Unicode lowercase. Percent decoding
is strict whole-value UTF-8 or retains the whole literal, matching current
`decodeURIComponent` behavior. Normalization is versioned as shared Rust behavior
on native/WASM (`unicode-normalization =0.1.25`), not host locale behavior.
Local directory membership and suffix matching require slash-segment boundaries:
`AB` is not inside `A`, and `OtherDir/Note.md` is not a suffix match for
`Dir/Note.md`. These are intentional corrections to accidental TS prefix/suffix
matches. Relative lookup checks source-directory targets first; a rooted miss
never falls back globally. Remaining candidates are ordered local-before-other,
then shortest original logical path length in UTF-16 code units (preserving the
existing JavaScript length metric), original UTF-8 path bytes, stable entry ID.
Equal normalized root paths use that same deterministic tie ordering. Insertion
order no longer determines winners; this correction is explicit in fixtures. Do not
implement rename source rewriting here; existing CAS-protected TS rewrites stay
with their owner until a separate lossless-edit migration.

## Host persistence and concurrency

Native: optional derived tables in the existing verified authority SQLite DB,
with a separate semantic schema/version and generation head. Authority commits
only append their existing source journal; index preparation is asynchronous.
The *separate* index publication transaction checks source head/index head and
writes derived rows/head. A failed index cannot abort a successful note save.
Dropping/rebuilding explicitly owned derived tables must not touch source, WAL
identity, checkpoints, receipts or envelopes. Independent CLI/desktop indexers
race through the same CAS; a loser reloads, never replaces the winner blindly.
Root/store owner must approve schema naming and corruption-isolation handling.

Browser: disposable semantic stores in the existing vault IDB, with an independent
derived schema marker. Source control and derived-head stores participate in the
same short publication transaction; no await outside IDB request callbacks.
Any required additive IDB version upgrade is coordinated by the browser-storage
owner with multi-tab open/versionchange/blocked handling and retained source data;
it does not silently change the authority format or fall back to browser SQLite.
Worker/WASM performs shared evaluation; TS does adapter IO and transports typed
results. Cross-tab notifications wake catch-up but do not certify freshness.
No cross-database two-phase publication protocol is needed in this first slice.

Use the native bounded journal immediately. Browser adapter needs a bounded
ID/revision change-page API or may initially recapture its complete metadata
manifest each pump; do not duplicate existing unbounded journal `getAll` for
semantic indexing. Decimal-string journal keys sort lexically in IDB, not
numerically: paginate by a proven sortable numeric encoding or canonical digit
length/range order, checking contiguity and byte budgets; never use plain string
range pagination as though `9 < 10`. This feed change needs named browser owner.

## Query contract and FTS5 gate

Every query returns snapshot ID, covered watermark, observed source head,
version tuple, complete/truncated/diagnostic status and stable ID/revision/path
on each hit. `complete` means complete evaluation of that immutable snapshot,
not remote sync, current editor draft, complete physical scan or global quiet.
Pagination tokens bind query hash, generation/version and deterministic ordering;
old generations are reference-pinned during a page sequence or token expiry is
explicit `snapshot_expired`. Rebuild cannot splice new rows into an old page.
Reads run outside source write locks and obey result/step/source-byte budgets.
Generation retention/GC is host-local with active query pins; persisted query
pins are unnecessary if tokens expire explicitly after process restart.

First operation: literal UTF-8 search matching the current CLI contract, exact
case, bounded query/line snippets, explicit byte ranges plus the metadata-owned
UTF-8/UTF-16 conversion. Frozen result ordering is logical UTF-8 path bytes then entry ID and hit
position, independent of host locale. Avoid using FTS rank as a cross-platform default. UI's current
locale-dependent case-insensitive behavior and rich regex/scope grammar need separate fixtures
before that consumer migrates; existing TS paths keep their behavior meanwhile.
Base gets `open_snapshot` rows/version/diagnostics; its worker owns values,
filter/formula/group/sort semantics. Invalid YAML/Markdown rows carry the current
revision and parser diagnostics; old valid metadata must not masquerade as new
output. Literal text may still be searched when semantic extraction is invalid.
Unsupported/oversize/read errors are explicit coverage exclusions, not an empty
property map falsely presented as successful complete extraction.

FTS5 is optional candidate acceleration in native SQLite only. Reuse assessment
already identifies token-vs-substring, Unicode/tokenizer and short-trigram gaps.
A candidate provider must prove a *superset* of exact portable matches for each
supported query; the portable evaluator rechecks every candidate and computes
spans/order/snippets. Otherwise scan the exact generation projection, including
all unsupported OR branches; negative predicates cannot be pruned unsoundly.
Start with fallback everywhere. Later detect FTS availability, pin tokenizer/
index version and benchmark equivalence on the corpus before enabling a narrow
sound candidate mode. Missing FTS, stale/corrupt FTS or Unicode/short/punctuation
queries fall back without false negatives. Browser uses the same exact evaluator
and IDB projections; do not introduce SQLite WASM/OPFS or native dependencies to
obtain search acceleration. No upstream code/dependency is copied by this doc.

## Minimal acceptance corpus and migration ownership

One small corpus, identical plans/results on native and WASM with FTS disabled;
repeat supported candidate cases with FTS enabled only when implemented:

| Fixture/action | Required index/query outcome |
| --- | --- |
| A.md links B.md; folder/C.md links ../B.md; one unknown Text extension, one Binary | Stable IDs, exact literal hits for eligible text, correctly scoped backlinks; no Binary-as-text coercion. Parser worker supplies link spans. |
| BOM/CRLF, emoji, combining marks, CJK, exact one/two-character and punctuation literals | Exact bytes preserved; expected hit/span conversion and deterministic results; FTS fallback cannot drop short/Unicode hits. |
| Malformed frontmatter and invalid/unsupported source | Save/read/sync unaffected; current-revision diagnostics and explicit coverage status; no stale metadata substitution. |
| Write A while its old parse is in flight; then delete/recreate same path with new ID | Stale CAS rejected; no old-ID resurrection and no watermark advance over unfinished work. |
| Move source folder, move/delete/create target without editing referring bodies | New generation resolves raw links against its own inventory, removes deleted sources and handles affected descendants; source text unchanged. |
| Local edit, independent CLI edit, external import and received update | Same feed contract and revision fences; duplicate wake/delta is idempotent, out-of-order page/gap forces reload. |
| Crash before/after head publish; erase cache; change parser/resolver version | Old or new complete snapshot only; safe rebuild; rebuilt results equal incremental results, raw/checkpoint/sync state unchanged. |
| Two indexers/tabs publish same expected head; query spans rebuild/write | One winner, bounded retry, stable snapshot page or explicit expiry; no mixed-generation result. |
| Tiny work/result budget, unreadable/oversize text, optional FTS absent/corrupt | Explicit progress/lag/truncation/exclusions with resumable cursor; exact fallback or explicit failure, never false completed/no matches. |

Frozen initial pump budget: at most32 documents and1MiB source/output per call,
with cooperative elapsed/step limits and existing per-file authority limits.
A document exceeding a call budget requires explicit bounded per-file
continuation or a terminal per-file limit diagnostic; it must not remain at the
queue head returning no progress forever. An exhausted budget reports resumable
progress, never discards source or raises the core's file cap. Record latency/memory when
implementation exists; this source proposal makes no speed claim.

Migration sequence: (1) portable contracts/corpus + native/IDB adapter parity;
(2) CLI metadata/backlinks and opt-in literal indexed search with explicit snapshot
status, retaining current CLI search until semantics/output equivalence passes;
(3) root-assigned Vault/worker capability and one read-only UI consumer (backlinks);
(4) UI search and Base snapshots with their owners' independent equivalence gates.
Do not replace all TS metadata at once: dirty-buffer outline/completion/rendering
must retain editor-local overlays until an explicit committed-vs-draft API exists.

Named seams before edits: root shared Rust/result API; metadata worker parser
facts/spans/version; Base worker snapshot projection requirements; future native
store owner derived tables/journal/read fence; future browser-storage owner IDB
stores/bounded feed/transactions; CLI owner commands/JSON compatibility; editor
owner Vault/workspace, backlink navigation and draft overlays; mobile owner
bindings/shell. This worker now also owns `crates/zorid-index/**` for the initial portable
slice; other implementation seams remain future assignments. Root owns final
metadata type freeze and must name implementers before consumer/schema changes.


## Initial source slice status

`crates/zorid-index` now contains immutable source/index/version identities,
complete namespace validation and entry witnesses, pure publication-fence checks,
and a borrowed namespace resolver. Own manifest pins approved Unicode NFC0.1.25
and percent-encoding2.3.2 and depends on the canonical `zorid-document` projection.
Root composes that metadata crate and resolves the shared lock before execution.
Resolver corpus has15 cases; publication corpus has6 cases plus stale
write/move/delete/recreate and malformed-manifest/watermark tests. Source is
formatted; tests/builds have not run. This is not a persistence adapter, finished
index generation planner, literal-query engine or consumer migration.

The resolver's percent-only input seam is explicit pending root's reviewed
CommonMark entity/backslash normalization versus literal wiki target decision.
Metadata must preserve raw source ranges and provide the agreed logical target;
this crate will not invent a Markdown URL parser. Encoded external schemes and
encoded hash filename characters already have percent-order regression cases.
