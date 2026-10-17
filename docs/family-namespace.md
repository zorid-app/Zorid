# Family namespace publication

The native adapter attaches durable family Move/Delete jobs to persisted physical
bindings after logical apply/receive has committed. It never reconstructs source
ownership from equal bytes or from a receiver-side subtree walk. Local family
commands and received envelopes use this same physical path.

`family_namespace_attachments` stores exact original job snapshots, exact desired
entry states, and prepared physical targets. `family_namespace_covered` maps each
original job to its physical attempt. A separate projection job lets the existing
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
namespace binding patch is applied in this branch. No builds or runtime checks
have run for this follow-up yet. Focused fixtures cover Move-then-Delete against
an old physical path across restart, newer logical text during Move, and an
explicit folder Move preserving child frontiers. Existing namespace fixtures
cover the capture/stage/publish engine's crash and occupant preservation behavior.

Remaining conditions are explicit: a connected group with mixed final Move and
Delete dispositions, or a pre-existing active content publication, stays pending
with retained evidence. These need obligation splitting or explicit publication
responsibility transfer; they are not treated as completed namespace operations.
