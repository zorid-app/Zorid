# Future improvements

Updated 2026-10-18. This backlog preserves later capabilities and performance
ideas. Storage is the immediate S0 milestone and indexing/search optimization is
S1; those items are now explicitly scheduled, not indefinitely deferred. The
[product roadmap](roadmap.md) remains the source of truth for
milestones, dependencies and verification.

## Parallel indexing and bounded scan work

Proposed performance improvement; not implemented yet.

- Keep parsing, indexing and validation logic in the shared Rust core.
- Native and CLI clients can execute independent jobs on Rust threads. Browser
  clients execute the same Rust/WASM code inside Web Workers; JavaScript provides
  scheduling and browser storage access, not a second semantic engine.
- Parallelize independent hashing and Markdown extraction with a bounded queue
  and worker pool. Start evaluation with two workers on the 8 GB development
  machine; choose final concurrency from measurements and memory limits.
- Keep one coordinator for scan completeness, moves, deletions and publication.
  Batch database writes and check entry/content revisions before installing
  results. Discard or retry stale results; incomplete inventory cannot authorize
  deletion. Avoid holding a write transaction while workers parse or hash files.
- Remove redundant whole-file verification before adding concurrency. Measure
  actual latency, memory use, cancellation and foreground editor responsiveness.

Shared Markdown extraction, indexes and Base semantics are implemented and
accepted in the [semantics plan](shared-document-semantics-plan.md). Parallel
execution remains future work; live editor parsing stays separately owned.

## Managed-record replay and retired-intent retention

The current bounded internal implementation has4096 replay records/16MiB and
the approved private intent design retains up to4096 retired keys. This is a
finite operation-history ceiling, not an unlimited lifetime storage promise.
Design safe compaction/archival and recovery-aware retention before removing
those bounds: retain exact uncertain/committed replay, prevent retired identity
reuse and preserve offline dependency/history semantics. Never free capacity by
silently deleting unresolved requests, retirement evidence or user content.

## P2P live sync

Explicitly deferred from the current implementation pass by the user. Retained
as future work, rather than a completion gate for the current server-backed sync.

Use the same document identities, encryption, merge rules, tombstones and exact
retry semantics as server sync. Design discovery, authenticated pairing,
connectivity/relay fallback and mobile lifecycle handling before activation.
Server persistence and backups remain useful when peers are offline. P2P is a
delivery route; it does not by itself provide live editor updates or backups.

## Server-push catch-up

Proposed improvement to the current bounded sync sweeps. A subscription or wake
notification can trigger prompt catch-up through the existing durable sync path.
Choose the transport later; a Watch RPC or WebSocket is not implemented by the
current Hello/Append/Pull migration. Reconnect must recover missed updates, and
notifications must not substitute for durable acknowledgments.

## Seamless stale-editor draft merging

The user explicitly schedules this after all currently planned stages. Current
recovery retains a stale draft and supports a recovery action/copy.

Derive the edit delta from the draft's original causal baseline and merge through
Yrs while preserving active typing, undo, IME, selection and interruption recovery.
Keep the recoverable draft when a safe merge cannot be established. Updating a
CAS revision and overwriting newer text is not an acceptable merge.

## Further serialization improvements

The [versioned protobuf plaintext proposal](protobuf-adoption-plan.md) remains
future evaluation. Remote RPC protobuf does not automatically change encrypted
document payloads. Any later codec change must explicitly version the payload,
preserve exact retry bytes and encryption/AAD boundaries, and reject unsupported
required meaning rather than silently relabeling older data.

## Other scheduled milestones

Native mobile shells, new-device joining, hosted/self-hosted onboarding, full
version history, coordinated automatic backups and administration remain in the
delivery roadmap. They have not been dropped or declared complete by this list.
Backups must include accounts, permissions and recovery-critical configuration,
as well as encrypted vault data. Older Vite/Stage5 sequencing is historical;
follow the maintained [roadmap](roadmap.md), beginning with storage and then Rust
performance. Desktop feature completion precedes iOS implementation.

## Renderer startup and lazy loading

The Vite migration changes the build pipeline; it is not proof of faster runtime.
The production build reports that editor.ts is both dynamically imported by the
workspace and statically imported by Canvas Markdown cards, so that dynamic edge
does not create a separate editor chunk. A later measured optimization can isolate
this dependency and compare cold startup, first editor open and Canvas card loading.
Preserve native/WebKit assets and avoid claiming success solely from smaller output.
