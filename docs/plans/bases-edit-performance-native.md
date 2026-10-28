# Database edit latency: native scaling investigation

Current status, 2026-10-28: reviewed R6 startup/opening batch passes full
representative navigation, idle, external-preservation and normal-exit acceptance.
Main integration/package verification/installed smoke are being completed under
standing authorization. Base post-entry latency remains separately open (last
unprofiled2692ms median); external adoption-to-current-Search21.5–34.2s is also
open. See current execution checkpoint; earlier investigation below is historical.

The initial read-only investigation and proposals below are historical evidence;
implementation state and ownership are superseded by the execution checkpoint.

The source audit was read-only at `b0b09005`. The documentation owner is
`notion_table_interactions`, on `codex/bases-edit-performance-notes` in
`.worktrees/bases-edit-performance-notes`. Root owns the session/controller/vault
diagnosis, frontend experiments, measurement receipts and integration. No Rust,
transport or application source is changed by this document.

## Observed measurements and their limits

Root reported these actual native observations during the investigation:

| Observation | Result | Scope |
| --- | --- | --- |
| Installed app, one collection member plus 1,000 ordinary nonmember notes | Median approximately 3,940 ms from Enter to ready | One rendered database row; this is not a 1,000-row collection |
| Small fixture | Approximately 593 ms from Enter to ready | Different fixture/pass; not an isolated measurement of transport cost |
| Instrumented full reload stage | Sometimes approximately 5.1 seconds | Includes the stage's awaited work; not proof of a filesystem scan alone |
| Instrumented warm `set_entry` stage | Approximately 200–665 ms | Includes any host queue wait and publication/recovery before the reply |
| Instrumented explicit controller refresh | Approximately 230–380 ms | Includes its awaited runtime/query readiness |
| Renderer frames during the earlier large-fixture pass | Approximately 17.8 ms | No observed renderer CPU freeze in that bounded pass |

These are reported observations from root's separate installed/source passes,
not a controlled before/after benchmark of this document's proposals. The stage
ranges should not be added together as though they came from one trace. Root
retains responsibility for the exact fixture, package identity, repeated samples
and timing artifacts. At this initial audit, no proposed native change had been
compiled or measured; later sections record the authorized implementation and
validation separately.

The extra 1,000 files are **not collection members**. Collection snapshot loops
are a real separate scaling concern, but cannot explain this fixture merely by
counting collection members.

## Confirmed source paths

Line numbers below were observed at `b0b09005`; recheck them before implementation.

### Direct publication performs global recovery

The synchronous path for a managed value change is:

1. `desktop/rust-vault-service.cjs:437` serializes `databaseCommand` into a
   `database_request` frame. `crates/zorid-desktop-host/src/lib.rs:612` dispatches
   directly to `databases::execute`; this dispatch does not itself unconditionally
   run a full filesystem rescan.
2. `crates/zorid-native/src/databases.rs:91` acquires the vault lock, commits the
   logical collection command, and invokes `database_recover_locked` at line 145.
   Its pending-entry loop starts at line 271 and publishes pending projections.
3. `database_publish_entry_locked` at line 353 composes the managed properties
   while retaining unrelated content. A changed file calls `apply_locked` at
   line 455.
4. `crates/zorid-native/src/native.rs:278` routes an enrolled family write to
   `family_apply_locked`. In `crates/zorid-native/src/family.rs:85`, that call
   commits through the store and enters `family_apply_projection` at line 102.
5. `family_apply_projection` calls **global** `recover_locked` before
   `family_project_status(id)`. `crates/zorid-native/src/native.rs:416` checks
   namespaces, directory attempts, folders and projection attempts, then lists
   every file and loads its projection baseline at line 484. The baseline contains
   state and `StoredContent`, rather than only a revision counter
   (`crates/zorid-store/src/projection.rs:39,156`).

Thus a single collection member's publication can do work proportional to the
whole vault before its database reply, even when the other files are ordinary
notes. The audit proves the traversal, not its share of the measured latency.

### Periodic scans are active; normal family mode does not install a watcher

The normal desktop service uses `familyMode:true`
(`desktop/editor-core.cjs:84`). Crucially, the watcher at
`desktop/core-vault-fixture-service.cjs:150` is guarded by **`!this.familyMode`**.
Only that watcher callback adds path hints in this file. Normal family mode
therefore does not currently generate watcher hints for every own write. An
earlier investigation message overstated that causal path; this source check
corrects it.

The default poll interval is 750 ms; the periodic rescan interval is 30 seconds.
`pollNow` at line 281 chooses `scanNow` for `needsScan`, an elapsed rescan interval,
or a family-mode hint if one is present. Resume sets `needsScan` at line 188.
The family-mode hint condition at line 283 exists, but is not proof that every
normal managed edit causes a filesystem rescan. Do not attribute the measured
edit latency to that unobserved event sequence.

When a scan does run, dispatch at `crates/zorid-desktop-host/src/lib.rs:942` enters
`reconcile_desktop_vault` at line 1054: external namespace reconciliation followed
by recovery. That is whole-vault maintenance, separate from the database request.

The existing `reconcile(paths)` RPC is not a demonstrated constant-cost replacement:
`crates/zorid-native/src/native.rs:390` first invokes global recovery and later
uses a store listing. Namespace, physical-ownership and family import semantics
must also be preserved.

### Both logical and physical changes request full listing reloads

`crates/zorid-store/src/databases.rs:1125` calls `record_family_reload` for a
collection mutation. `crates/zorid-store/src/presentation.rs:225,263` appends a
journal event with `requires_full_reload:true` and no scoped entries.

The physical family write also requests a full reload:
`crates/zorid-store/src/family_materialization.rs:1120` in the checked indexed
local Text/create path, and line 909 in general family materialization. Narrowing
only the logical `set_entry` event therefore leaves another full reload.

The service reacts to a full-reload event with `host.listSnapshot()` plus a source
hint and a generic change notification
(`desktop/core-vault-fixture-service.cjs:300`). Its ordinary `list()` method also
always obtains a full metadata listing at line 93. Store `list_snapshot`
(`crates/zorid-store/src/presentation.rs:358`) reads all states/presentations;
this listing is not itself a filesystem reconciliation scan.

`databaseChanged()` at `desktop/core-vault-fixture-service.cjs:210` only sends a
generic change notification. It does not directly perform native IO. After an
accepted mutation, `desktop/client-admission.cjs:112–123` sends both this
notification and `documentRuntimeSourceHint()`; consumers can independently
schedule more work.

### Index generation and host queue costs are separate

`desktop/rust-vault-service.cjs:373–403` admits bounded requests to one FIFO with
one request in flight. Already-issued maintenance can delay an interactive
database command or its follow-up query. Transport queue wait must be separated
from native execution when measuring a stage.

`sourceHint()` is a scheduling signal
(`desktop/document-runtime.cjs:183–186`), not a synchronous scan. Native runtime
Observe reads source identity and cache status; a stale generation can then
issue Begin/Pump/Publish (`crates/zorid-native/src/document_runtime.rs:225–305`).

Store Begin captures all visible metadata and presentations
(`crates/zorid-store/src/document_index.rs:587,1043`). Stage checks at lines
1336,1502,1809 reach `check_current_stage` at line 734, whose full manifest
comparison is at line 749. Reusing most document facts does not remove every
whole-manifest validation. These are correctness fences, not redundant work
that may simply be deleted.

The existing pinned metadata-row API supports bounded pages and an actual
baseline (`crates/zorid-native/src/document_index.rs:170`), but does not by itself
eliminate production and validation of the destination generation.

### Collection-sized response work remains a separate concern

Store `snapshot` at `crates/zorid-store/src/databases.rs:774` loads every member
of the selected collection. `get_entry` at line 1079 builds that collection
snapshot before retaining one entry. Mutation replies at line 1133 store a full
collection snapshot in the idempotency receipt. Native publication can request
another collection snapshot at `crates/zorid-native/src/databases.rs:380`, and
the final response refresh requests one at line 161.

Reads also run visible-entry reconciliation at line 318. A `get` can compare
many collection members with disk. This deserves separate large-collection
measurement; it is not the leading explanation for one member plus 1,000
nonmembers.

## Safe alternatives to evaluate

### Scoped collection-member invalidation

For **only** `set_entry`, a proposed store helper could append an existing
`PresentedState` for the affected member with `requires_full_reload:false`, in
the same transaction as values, database revision and the idempotency receipt.
Membership, schema identity and namespace remain unchanged for this operation.

Required guarantees:

- Advance the journal cursor even if the physical file has not changed or later
  publication fails. Logical values and pending publication must remain visible
  to other admitted viewers and the document runtime.
- Preserve the existing file presentation/mtime until actual file publication.
  Do not manufacture an `EntryChange` solely to call `record_changes`, which
  updates presentation timestamps.
- Retain exact operation replay behavior, entry/schema CAS, source generations
  and projection-pending/error reporting.
- Keep schema edits, creation, deletion, restore, namespace/visibility changes
  and uncertain cases on their existing full-reload path initially.
- Confirm that every subscriber invalidates collection queries on a same-path
  notification even when physical entry metadata is unchanged. Current desktop
  polling emits path notifications without requiring a revision difference,
  but other consumers also need verification.

A second narrow change would be needed for physical family Text publication.
Only a proven existing `Mutation::Write` with stable path/kind/visibility and a
complete affected set containing one file should initially use a scoped event.
The checked indexed path at `family_materialization.rs:917` already verifies
retained Text, publication history and location witnesses. Preserve those checks.
Any create, folder, move, collision, visibility transition or wider affected set
should retain the full-reload fallback. Merely changing the journal flag for
general family materialization is unsafe. Desktop polling also treats folder
entries as requiring a full reload.

### Verify benign file hints before consuming them

A hint fast path is a future alternative if family hint handling is enabled or
observed, not an established fix for the present normal-family edit baseline.
Measure periodic/resume scans separately before changing their scheduling.

A filename-only watcher hint cannot prove an own-write event. An external edit,
rename, deletion or replacement may be coalesced with it. Do not discard hints
based only on a recent write, filename, mtime or file size.

A proposed bounded native fast path could verify, under the vault lock, a known
active file's namespace, binding, parent identity and fresh filesystem snapshot
against its immutable published projection baseline. Only an exact current
content/inode/parent match could consume the hint as a benign no-op. The existing
proof in `crates/zorid-native/src/external_observe_stream.rs:175–185` is a useful
internal seam; it is not a new public capability yet.

Unknown paths, directories, absence, mismatches, namespace uncertainty, incomplete
hint sets and ambiguous ownership must fall back to the current scan. Preserve
periodic scanning, missed-watcher recovery, lock/parent checks and the original
source when verification fails. Plain store `stat`/metadata reads do not establish
fresh filesystem equality.

### Target recovery only with an explicit pending-work proof

The direct write traversal is another candidate for a narrower fast path. A
possible design first proves there are no unrelated namespace/directory/attempt
dependencies and that the target is an eligible, closed, indexed Text write.
It could then use the existing `family_project_status(id)` checks and target
publication, leaving unrelated cleanup to maintenance. If the proof is missing
or any dependency is uncertain, use existing global recovery.

This is a proposal, not evidence that global recovery is unnecessary. Preserve
namespace fences, unsettled attempts, immutable family publication assertions,
no-clobber writes and truthful pending outcomes. Native ownership review is
required before selecting or implementing this seam.

## Validation required before any native exception is accepted

1. Instrument FIFO enqueue, dispatch and reply separately for database commands,
   rescans, index steps and listing requests. Compare repeated warm and cold
   passes using the same installed source/host/fixture identity.
2. Repeat the one-member fixtures with zero and 1,000 unrelated notes. Measure
   Enter-to-ready plus durable command, reload, definitions and query stages.
   Separately measure many actual collection members.
3. For scoped journal events, verify same-path property edits that change filters,
   sort/group positions and summaries; another window/CLI observer; failed or
   delayed publication; exact retry after unknown acknowledgement; and coherent
   runtime generations without fabricated file timestamps.
4. Prove create/schema/delete/restore/move/trash/collision and wider family
   changes still trigger the necessary complete invalidation.
5. For hint verification, exercise own writes interleaved with external body and
   frontmatter edits, atomic replacements, same-size bytes, renamed/deleted files,
   replaced parents, symlinks, coalesced/missed hints and incomplete scans.
6. For targeted recovery, retain interrupted attempts and unrelated blocked
   namespace work; test ancestor dependencies, stale bindings, process death,
   projection failures and replay without changing target identity.
7. Obtain the scoped native implementation/build exception and serialized resource
   lane, then run focused Rust checks and actual native before/after passes.
   Frontend tests or source inspection alone do not establish native improvement.

Root's first frontend experiment is a targeted reload of an accepted saved path.
That experiment is independent of these unimplemented native alternatives and
requires its own correctness and native timing evidence.


## Frontend experiment outcome — root, 2026-10-28

Root tried replacing the post-`set_entry` full `vault.reload()` with existing
`vault.reload(publishedPaths)` using only verified, non-pending saved response
paths. A real Session→Table→Widget regression failed before the change and passed
after; rejected and pending-projection saves retained their drafts. Independent
source review found no correctness issue. This mechanism proof did **not** prove
a performance benefit.

A newly initialized 1,000-ordinary-note/one-member fixture measured baseline
median1561ms (Updating5/5). Targeted reload remained slow; an uninterrupted repeat
with focus required measured median3266ms, max9205ms (Updating5/5). Runtime
maintenance and periodic scans produce substantial variability. The result does
not justify shipping this frontend optimization. Root withdrew its production
change and test-only assertion; the ignored patch and full timing traces remain
under `tmp/bases-edit-performance-20261028`. Do not report this task’s entry pause
as fixed. A scoped user exception to the earlier frontend-only/Rust-build limit
was requested and remains pending. No Rust source or native host changes/builds.

Temporary stage and transport timing instrumentation was removed. A prior
minimization fixture later failed startup with a native invalid_response after
external delete/restore experiments; that setup failure is excluded from product
performance conclusions. Subsequent comparison used the fresh authority above.


## Authorized native implementation — 2026-10-28 (supersedes hold above)

The user explicitly approved the scoped Rust fix, focused tests and one serialized
release build. The coordinator acknowledged exact non-overlapping file ownership;
see the execution checkpoint. Recovery candidate `a7283907` is authored but has
not yet run Rust checks or native performance acceptance. Journal implementation
and separate startup enrollment-boolean work remain isolated. Root holds the
single jobs1 compile/release slot and pauses heavy checks during the startup
session’s next Electron profiling slot.

Latest unchanged-host baseline on the final frontend and pinned Electron44.9.1:
median4711ms, max10631ms, Updating5/5 in the controlled1,000-ordinary-note/one-member
fixture. A user Notes host was also open and was preserved; compare within the
same bounded environment before inferring a speedup. Native slash/heading gate
passed11functional checks. REA passive target inspection evidence
`ev_e8b3c324348f3ff01402c0298774fdaf17f1e4d6727752be1fcc88123e65ba2d`
confirms the selected local page and Electron44.9.1 inventory; it does not execute
or establish interaction behavior.

Separate startup profiling reports509/514/570ms warm host handshakes for100notes;
fresh1,000partial import5.1–5.9s. Exact-host sample identifies enrollment boolean
checks invoking full family status/graph metrics during import. The proposed Store `family_store.rs` shortcut was subsequently declined because
it would weaken corruption checks. The startup worker instead implemented the
scoped native caller enrollment proof, retaining full admission/end validation. Root’s recovery worker
retains its three files; journal owns Store `tests/family.rs`. These are findings
and authorized scopes, not implementation or performance acceptance claims.


## Combined R2 validation — 2026-10-28

The first release candidate failed representative startup and long-tail acceptance;
see the execution checkpoint and startup session tracker. The expanded explicit
goal removes unnecessary scan/index work while retaining real change detection.
The isolated combined code now includes reviewed guarded family watching and
maintenance wake coalescing, immutable validated index admission reuse, batched
binding/baseline inventory and fresh descriptor-relative canonical leaf-name
checks with conservative enumeration fallback. The timestamp cache was rejected.

Actual old exact-name work bound failed at2,004,000 enumerated entries; final7/7
checks pass. Release gates: hints8/8, SQLite locks2/2, namespace57/57, import9/9,
creation8/8, compound large-stream restart1/1 (71.41s). Store's actual traced SQL
plan rejects a temporary payload sorter both before/after ANALYZE. Combined
frontend243/243, full TypeScript and native frontend build pass. Earlier controlled
Store index and binding red/green receipts are recorded in the execution checkpoint.
The earlier stage/compound debug attempts remain unfinished. The source-matched jobs1 host/CLI build from code6ce25e80 passed in1m41s;
frozen host01282d4b/CLIf8308756 and full source hashes are recorded in
`tmp/bases-edit-performance-20261028/r2-release-products.json`. Startup now owns
the exclusive expanded profiling lane; root holds UI/heavy work. Representative
timings, external change correctness, main integration and installed acceptance
are still pending.


## Approved exact no-op observation contract — 2026-10-28

Root approves the bounded dataflow proposal in external_observe_stream: a fully
verified unchanged filesystem observation is not a CRDT scrub. After existing
enrollment, namespace/live metadata/owner checks, full baseline and physical
binding decoding, exact baseline path/length/SHA and inode+parent match, retain
fresh verify_observed_content and return no change before loading unused Text
mode. This intentionally removes incidental retained-CRDT validation from that
no-authoring branch. It does not authorize consuming or modifying corrupt causal
state, and does not claim identical full-scrub timing on unchanged files.

Every capture/import/retention path still requires the existing full Text probe;
no EXISTS shortcut or cached flag. Required regressions: exact no-op has zero
Text-revision queries and no authored/history/public-byte changes; changed Text
imports once then echo is inert; retained orphan/binding/revision/snapshot and
authority corruption is rejected at existing probe/causal import/edit boundaries
without writes; baseline/binding/metadata/namespace failure guards still hold;
replacement, parent-change and blocked retention gates survive. Raw NativeVault
byte reads are not universally a CRDT scrub today, so do not invent that claim.
Startup_audit owns source/tests; root owns controlled native validation/build.
Source is still pending at this contract decision, not measured or installed.

## Follow-up trace attribution while installation awaits normal closure

Read-only audit at main `2d0da423` partitioned the earlier R5 request trace into
its five actual Enter-to-ready windows. This is **not a final R6 benchmark**.
Receipt: `tmp/bases-edit-performance-20261028/base-edit-trace-partition.json`.
Each window starts four list snapshots, two collection-definition reads and two
Base queries. Metadata-page starts are 22/58/56/58/48 within those windows; another
66 starts occur outside them. Do not attribute all 308 pages to the edit windows
or sum nested/overlapping RPC, service and runtime durations.

The 19 rejected `get_entry` probes are consistent with expected absence for the
ordinary host note `Performance embed.md`, which has no collection membership;
all five `set_entry` writes succeeded. This attribution is source plus fixture
inference: the trace intentionally stores no request arguments or error content.
`note-property-targets.ts` registers both `requestCollection` and `invalidate`
for the same vault events, while `invalidate` itself requests membership. A
concurrent second request marks the current request invalidated and queues a
successor. Future coalescing must retain definite host-absence-only handling,
selected actor/path/revision guards and a real database/source invalidation epoch.

Four lists do not mean four full Workspace reloads. Two follow explicit mutation
reload plus the normal durable-change notification/Workspace reload path. The
other two are the relation-target query's before/after inventory fences in
`src/bases/property-targets.ts`. Any replacement must preserve selected-note
identity/revision and the final same-pin/source status fence. BaseController's
notification refresh can overlap the explicit refresh in `src/bases/session.ts`;
joining it requires proof it covers the same invalidation epoch, configuration,
view, clock and postcommit target witness. Newer invalidation must still rerun.
Two definition reads follow the sequential `loadDefinitions` calls around that
refresh; reuse requires matching collection revision, source context and
configuration witness. Metadata-page wake coalescing must retain complete page,
source, snapshot and coverage validation. These are bounded follow-up seams,
not implemented fixes or permission to remove correctness fences.

Current accepted startup/opening package remains unchanged. This separate
Base-edit finding stays OPEN and does not delay its installation.
