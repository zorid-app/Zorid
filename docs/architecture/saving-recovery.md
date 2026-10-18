# Saving and local recovery

[Architecture](README.md) · [Storage](storage.md) · [Sync](sync.md)

## Current save path

TypeScript NoteBuffer owns loaded text, scheduled writes, conflict state and the
saved baseline. Durable note state retains request identity/checkpoints and settles
host receipts. Native Rust commits source state and separately publishes ordinary
files. A publication can be recoverable/pending even after database commit.

Native publication stages new content, displaces the old inode temporarily, then
acknowledges the published inode durably. Settled `.previous` files are retired
immediately and retried on startup. Only an exact completed journal attempt with
its recorded original inode is eligible. Changed displaced bytes are durably
captured and revalidated before unlinking; capture failures preserve the artifact.
Pending stages, namespace recovery locations and unexpected objects are not swept.
The private `.zorid` directory is app-owned; stat/revalidate/unlink is not an atomic
compare-and-unlink against a hostile writer. Once unlinked, future writes through
an external application's old open handle cannot be observed. This deliberately
ends indefinite old-inode monitoring while retaining atomic replacement.

Interrupted reconciliation retries automatically with a bounded retry budget.
Routine work is quiet for populated vaults; an empty pending view says notes are
opening. Persistently unavailable notes receive ordinary-language guidance.
Raw errors, paths, counters and protocol details never enter that status UI.
Automatic recovery settles proven journal state; it never overwrites a current
note with an arbitrary historical snapshot or ambiguous competing version.

## Accepted recovery behavior and current delivery

The user wants this subsystem to match the inspected Obsidian autosave/File Recovery behavior:

- Roughly two-second coalesced autosave, plus blur/close/graceful-quit flushes.
- No accumulating per-save `.previous` files.
- Separate periodic File Recovery snapshots: five-minute interval, seven-day
  retention, unchanged-content deduplication and automatic expiry.
- Best-effort immediate capture of intended text after a catchable save failure.
- Version selection/preview and explicit restoration through the ordinary save path.

On desktop/mobile, snapshots belong in per-vault app-local `recovery.sqlite`, not
the vault authority DB and not synced history. This does not require a matching
persistent browser recovery database: browser joins existing sync groups. Its
pending-edit, reload and retention behavior remains a separate design task.
A committed snapshot survives restart; this does not
make every keystroke durable or promise that an abrupt pre-autosave crash loses
nothing. Native suspension and browser lifecycle limits need explicit behavior.

`zorid-recovery` now owns content/hash/retention semantics. `zorid-sqlite` provides checked native
connection opening. Hosts opt into an explicit app-local location; ordinary native
save projection captures committed Markdown snapshots with cadence, or bypasses
cadence after a projection failure. Secondary history failures cannot change a
committed save receipt. Whole-vault maintenance is throttled at host boundaries.
Normal durable note saves also retain attempted text after a rejected/uncertain
core save, without applying it over current source. Errors before that handoff
(prepare/checkpoint/transport/editor failures) still rely on existing draft journals.
History preview/restore UI remains pending. A save-strategy change must reconcile current database/file
projection and external-writer guarantees before cutover; replacing projection
with direct writes is not a safe isolated filename change.

## Remaining verification and delivery

Reproduce the original user-vault warning separately; no screenshot alone proves
its cause. Verify save/reopen/restart with external changes in the actual app. Preserve existing recovery evidence until its obligations are settled.
Synced version history remains a separate future decision from local File Recovery.

## Source map

[NoteBuffer](../../src/ui/note-buffer.ts),
[durable lifecycle](../../src/ui/note-durable-state.ts),
[publication](../../crates/zorid-native/src/native.rs),
[namespace handoff](../../crates/zorid-native/src/publication_handoff.rs),
[import status UI](../../src/ui/import-status.ts).
