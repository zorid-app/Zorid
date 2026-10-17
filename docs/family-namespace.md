# Family namespace publication

The native adapter attaches durable family Move/Delete jobs to persisted physical
bindings after logical apply/receive has committed. It never reconstructs source
ownership from equal bytes or from a receiver-side subtree walk. Local family
commands and received envelopes use this same physical path.

`family_namespace_attachments` stores exact original job snapshots, exact desired
entry states, and prepared physical targets. `family_namespace_covered` maps each
original job/member pair to its physical attempt and records immutable completion.
An original job retires only after every explicit member is satisfied; historical
completion is not invalidated by later logical changes. A separate projection job lets the existing
strict namespace journal retain its exact member/evidence contract. It carries
the real command/update origin; it creates no command receipt or sync envelope.

Preparation CAS-checks current Normal/Tombstone decisions, saved bindings and
baselines, and absence of active content/directory attempts. A never-materialized
entry may retire namespace responsibility only when it has no binding, baseline,
or active publication. Unknown filesystem occupants gain no authority from this.

A Move reserves a fresh physical revision with the old immutable content witness
and, for text, the exact old snapshot/actors. It joins only an actually selected
same-entry Move into the physical frontier. An explicit ancestor Move changes a
child's saved path while preserving the child's own frontier; the helper requires
an exact old-to-new ancestor path mapping. The physical branch does not change
the logical/current text head. The ordinary content pass subsequently publishes
any newer desired bytes.

A Delete captures the bound physical path even when earlier unprojected logical
moves changed the tombstone path. Original jobs remain distinct from this physical
path. Finish rechecks the desired-state CAS, baseline/binding CAS and all member
proofs, then atomically retires the exact original and obsolete publication jobs.
Captured bytes and directories remain in `.zorid`; this implements no garbage
collection. Hidden Pending/Recovery states never imply deletion.

Recovery invokes attachment before existing namespace replay. File namespace
success does not suppress the following content pass. Family command/receive
responses preserve their durable receipts when physical work fails, and semantic
tombstones report physical completion only after active bindings/baselines and
pending namespace work are gone.

This is fresh schema8 development source; its new tables require a newly created
disposable fixture. No migration of real vaults is included. The exact approved
namespace binding patch is applied in this branch.

The isolated `core-family-namespace` candidate passed 24 native namespace tests
(session73322) and 18 store namespace tests (session75261), with `-j1` and
`--test-threads=1` and its own target directory. The commands were
`cargo test --offline -p zorid-native -j1 namespace -- --test-threads=1` and
`cargo test --offline -p zorid-store --test namespace -j1 -- --test-threads=1`.
Focused fixtures cover Move-then-Delete against an old physical path across
restart, newer logical text during Move, and an explicit folder Move preserving
child frontiers. Existing fixtures exercise capture/stage/publish crashes and
occupant preservation. Initial failures were a missing test Delete flag and two
obsolete migration expectations; the latter now assert rejection without database
mutation and fresh-schema canonical layout. These checks do not establish
browser/CLI/Electron cross-client integration or all family recovery scenarios.

The mixed-disposition follow-up splits a connected group into explicit member
claims, applies semantic deletes first, and resumes remaining moves after restart.
Null-plan claims require no binding, baseline, or active publication; no filesystem
occupant is inferred to belong to an unbound entry. The new mixed folder fixture
checks that child deletion cannot retire the parent Move before remaining members
finish. This follow-up is source-only pending its coordinated runtime gate.

The file-publication handoff follow-up settles an exact interrupted file attempt
before namespace attachment. It cancels only an unpublished attempt with proven
old occupancy, restores a displaced baseline with NOREPLACE, or acknowledges an
already-published stage using its immutable historical target. Every branch checks
saved parent/inode/baseline authority; changed or recreated occupants stay retained
and pending. Ordinary hidden-entry publication guards remain intact. Two focused
fixtures cover interrupted phases followed by Move/Delete and recreated sources.
The directory-create handoff also uses exact saved parent/stage authority. For
a live Move it publishes the immutable original create target before relocation,
so the old-path create job cannot be stranded. For an unpublished semantic Delete
it cancels the attempt and retains its private stage; the namespace transaction
then retires the exact obsolete create job. A prepared/published interruption
fixture covers this path. These handoffs are independently source-reviewed and
runtime-unverified until the combined gate completes.
