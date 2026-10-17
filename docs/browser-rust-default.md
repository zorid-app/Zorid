# Normal browser Rust startup

Owner /root/default_lifecycle_review_sol; branch tingkai-c/browser-rust-default,
Orca worktree browser-rust-default, based main c441087. Root is sole main
integrator. Reviewed desktop recovery6dd1c47 is present as5872ef7. This is an
isolated implementation checkpoint, not normal-browser runtime acceptance.

The ordinary browser branch opens zorid-core-vault:default-v1 through the
application worker and Rust/WASM. Desktop bridge and Capacitor selection retain
priority. No query parameters, fixture build environment, relay credentials or
HTTP sync session are prerequisites. Worker startup enrolls an empty local
family scope derived from persistent local authority; existing enrolled scopes
are reused. Existing nonempty unenrolled/unsupported data is rejected, never
silently rebound or deleted.

Persistent client slots use strict IndexedDB commits and page-owned Web Locks;
the worker separately locks its authority/client. Session storage is only a
preferred slot pointer. An active copied pointer fails explicitly, without
stealing or allocating a new identity. Fresh tabs choose an unowned retained
slot or allocate a distinct one; reload reuses its client and draft checkpoints.
Page retirement closes the worker and retains restore eligibility. A clean
release first settles commands and drains the admitted consumer.

The normal adapter installs admitted durableWrites and a durable family-command
consumer, including explicit createText, binary, folders, move, trash and delete.
Commands persist exact plans before authorization and terminal outcomes before
ACK. Recovery retains partial trash prefixes and captured target revisions.
Workspace startup settles note intents before command recovery; namespace changes
then reload inventory and rebuild recovered buffers before installing the UI.

Legacy localStorage preview data remains untouched. Settings > Vault offers an
explicit private JSON download including original raw preview records, retained
drafts and prior session data. It is never silently imported into the new sync
scope or sent to a backend. Browser physical folder access remains out of scope;
this is the existing logical browser vault, now backed by the Rust core.

Asset source commit2e8abe0 emits matching versioned JS/WASM pairs for normal web
builds. Explicit desktop builds omit browser WASM. Fixture URLs remain available
for reproducible earlier evidence.

Verification so far: 50 focused Node checks passed with test-concurrency1
(adapter2, file commands14, slots12, legacy export2, admission9, runtime11).
Full source TypeScript check passed after correcting discriminated input Omit.
Asset worker separately passed12 focused checks. These are bounded simulated
transport/registry checks, not real IndexedDB/WASM/normal-editor acceptance.
Heavy WASM/webpack builds and actual normal-browser create/save/reload,
independent-tab/conflict/recovery and no-backend checks await the root resource
slot. Keep source, integration and runtime results separate.

Follow-up source gates: combined TypeScript check passed after desktop status seam
caa4e7e and import-status module744083c were included. Two focused workspace
checks pass for note-before-command recovery/final namespace and persistent import
warning subscription cleanup. Additional desktop/fixture/status/startup tests20/20
pass. One additional ordinary-selection check confirms missing browser WASM fails
explicitly instead of falling back to localStorage. Desktop diagnostics backend
activation remains root-owned and blocked on its separate native fatal-error gate;
these UI seams do not establish that gate passed.

Independent package_sol review found a wrapper release-retry bug: retrying an
uncertain worker release or failed slot persistence re-entered command recovery
on an already fenced/released consumer. The wrapper now records completed
release phases, coalesces calls and retries only the remaining phase. Two focused
regressions pass. Legacy raw export is also offered on browser startup failure,
independent of Rust assets/storage availability, while alternate-vault permission
remains unchanged. Six affected checks and full source TypeScript pass;
package_sol source-approved the narrow followup. No actual browser claim yet.

First actual normal browser launch (Chrome tab1268037558, fresh origin8791)
failed before WASM fetch. Production webpack87504 had exited0, but TS relative
import rewriting plus Terser emitted an invalid comma expression inside worker
dynamic import. vm.Script confirmed Unexpected string. The webpack loader now
leaves source .ts resolution to webpack and disables TS runtime rewriting; the
noEmit TypeScript configuration stays unchanged. A tiny production webpack
regression emits and parses both entry and worker, including static .ts and
variable WASM imports (1/1 pass); full tsc passes. Both package_sol and the
assetworker source-approved this fix. Actual UI acceptance remains pending its
rebuild; a successful bundler exit alone did not establish usable startup.
