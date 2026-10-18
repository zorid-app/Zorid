# Durable desktop file commands

Source owner: desktop integration, `tingkai-c/desktop-file-commands`, based on
main `a6cac0b`. This extends the existing normal-editor command consumer; it does
not introduce a second store, sync planner or native namespace implementation.

The admitted native host accepts `file_command {client_id,family}` with a raw
bounded body only under the matching live client lease. The common FamilyCommand
retains explicit Create/Text, Create/Binary, Create/Folder (null mode), Write,
Move and Delete semantics. Native family_apply owns receipts, CAS, outbox and
projection. A pending filesystem projection remains a durable database commit.
Generic unleased family commands remain excluded from the admitted capability.

The platform captures operation IDs and bytes before crossing IPC. The main
consumer coherently observes current state, constructs immutable command steps,
and persists the exact plan before executing it. Retried calls and startup
recovery use the stored request and baseline revision, never a fresh plan after
an uncertain commit. Completed step receipts and next-step position are saved;
completed checkpoints retain compact signature/receipt metadata so a retry after
cleanup cannot infer a different write from newer path state. Existing retained
create-text checkpoints remain recoverable with their original IDs and bytes.

Ordinary adapter operations now use this path:

- mkdir: explicit folder creation, no overwrite.
- writeBinary: explicit binary creation for an absent path, or revision-CAS Write
  for an existing file, preserving every byte and the existing file family.
- write/compareAndWrite: explicit text creation or CAS Write. Existing NoteBuffer
  saves still use the dedicated DurableWrites checkpoint protocol.
- rename: explicit revision-CAS Move, including folder descendants in native core.
- trash: create missing `.trash/<operationId>/<original parent>` folders, then
  Move the original entry into that recovery location. This is a sequence of
  durable steps, not an atomic multi-command transaction. Failed steps may leave
  empty recovery folders; recovery never guesses, rolls back or deletes them.
- remove: explicit Delete with recursive equal to the caller's force flag.

For native durable adapters, Vault.rename treats the namespace receipt as
committed independently of backlink edits. It captures backlink entry IDs before
the move, observes those same IDs afterward and submits identity/revision/content
CAS rewrites. On a later failure it publishes the committed move and completed
backlinks and reports the partial outcome. It never blindly reverses the move or
overwrites earlier backlink edits with compensation writes.

Bounds remain explicit: body16MiB, checkpoint32MiB, at most256 steps per command
and bounded checkpoint enumeration. Larger streaming and checkpoint-history GC
are not established here. Mixed folder namespace obligations and active content
publication transfer remain native owner follow-ups; this adapter must not claim
those filesystem projections complete when core reports pending.

## Verification

Eight focused consumer regressions pass: exact lost-ACK replay, checkpoint-before-
mutation, destination/parent rejection, folder/binary/move/delete, interrupted
trash prefix recovery, concurrent edit CAS, same-byte replacement identity guard,
and retained text-create recovery across two restarts. One focused Vault test
confirms committed rename and completed backlinks survive a later CAS failure.
CJS syntax and whitespace checks pass. Full TypeScript checking and development
webpack passed on source57ada91 (session72416, webpack1723ms). The native owner
reports candidate9c61837 compiled CLI and desktop host with4883a3b and the SQLite
lock/namespace corrections (session3348), with84 native and18 store namespace
tests passing. Actual normal-app New folder/rename/trash plus real-host binary
operations remain pending. No live editor window or user document was changed by this work.

Platform retry follow-up: two regressions failed before the fix and pass afterward.
A late duplicate success or terminal error cannot clear a newer pending request;
its uncertain-ACK retry retains both operation and entry IDs. Command:
`node --experimental-strip-types --test --test-concurrency=1 tests/platform-desktop-durable.test.ts tests/desktop-text-create.test.cjs`
passed 10/10. This uses the real platform adapter with a controlled bridge, not
Electron/runtime evidence.
